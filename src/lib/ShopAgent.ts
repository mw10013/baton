import type * as ShopifyApi from "@shopify/shopify-api";

import type { OrdersSyncParams } from "@/lib/OrdersSyncWorkflow";

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-do";
import {
  Agent,
  callable,
  getCurrentAgent,
  type Connection,
  type ConnectionContext,
} from "agents";
import {
  Clock,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  type SchemaAST,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient, type SqlError } from "effect/unstable/sql";

import { CurrentShopifySession } from "@/lib/CurrentShopifySession";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import {
  causeToErrorMessage,
  makeEnvLayer,
  makeLoggerLayer,
} from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import {
  orderSyncQuery,
  OrderSyncResponse,
  orderSyncVariables,
  toOrderLineItem,
  toShopOrder,
} from "@/lib/OrderSync";
import { ORDERS_SYNC_WORKFLOW_NAME } from "@/lib/orderSyncConstants";
import { Repository, type RepositoryError } from "@/lib/Repository";
import {
  canStart,
  type StartContext,
  RunNotAllowedError,
  type RunNotBlockedError,
  RunNotFoundError,
  type RunTerminalError,
  type RunBlockedError,
  type RunOrderClosedError,
  type TaskNotReadyError,
  type TaskReopenBlockedError,
  RunRepository,
  type RunRepositoryError,
} from "@/lib/RunRepository";
import {
  type OrdersStreamCounts,
  runShopAgentOrdersStream,
} from "@/lib/ShopAgentOrdersStream";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";
import { ShopifyAppEvents } from "@/lib/ShopifyAppEvents";
import {
  type NoDraftError,
  type NoTasksError,
  type StepNotFoundError,
  type TaskNotFoundError,
  type TaskUnassignedError,
  type WorkflowLimitError,
  type WorkflowNotFoundError,
  type WorkflowOffError,
  type WorkflowTagTakenError,
  WorkflowRepository,
  WorkflowRepositoryError,
} from "@/lib/WorkflowRepository";

class ShopAgentNotifyError extends Schema.TaggedError<ShopAgentNotifyError>()(
  "ShopAgentNotifyError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The identity the Worker's connect gate resolved, as it survives on the
 * connection. See `Domain.ConnectionState` for why it lives there and not in
 * a message.
 *
 * Decoded strict: the only writer is this module, so an excess property means
 * the shape drifted and the connection should be treated as unidentified
 * rather than half-understood.
 */
const decodeConnectionState = Schema.decodeUnknownOption(
  Domain.ConnectionState,
  { onExcessProperty: "error" },
);

const connectionState = (
  connection: Connection,
): Option.Option<Domain.ConnectionState> =>
  decodeConnectionState(connection.state);

/**
 * The `x-baton-*` headers on the forwarded upgrade request, shaped for
 * `Domain.ConnectionState` but not yet validated — a missing or unknown role
 * yields a value the schema rejects, which is what closes the connection.
 *
 * Browsers cannot set headers on a WebSocket upgrade, so these can only have
 * come from the Worker gate; a non-browser client that sets them itself is
 * still stripped, because the gate rebuilds the request from scratch rather
 * than copying the inbound headers.
 */
const connectionStateFromHeaders = (headers: Headers): unknown => {
  const role = headers.get(Domain.CONNECTION_ROLE_HEADER);
  return role === "member"
    ? {
        role,
        memberId: headers.get(Domain.CONNECTION_MEMBER_ID_HEADER),
        memberEmail: headers.get(Domain.CONNECTION_MEMBER_EMAIL_HEADER),
        teamIds: (headers.get(Domain.CONNECTION_TEAM_IDS_HEADER) ?? "")
          .split(",")
          .filter((teamId) => teamId.length > 0),
        subscription: null,
      }
    : { role, subscription: null };
};

/** The tag every member connection carries, so a membership change can find and close it. */
const memberConnectionTag = (memberId: string) => `member:${memberId}`;

/**
 * Writes a subscription without disturbing the identity beside it — the reason
 * `Domain.ConnectionState` nests `subscription` rather than being it. An
 * unidentified connection is left alone: it is already being closed.
 */
const setSubscription = (
  connection: Connection,
  subscription: Domain.Subscription | null,
) => {
  Option.match(connectionState(connection), {
    onNone: () => null,
    onSome: (state) => connection.setState({ ...state, subscription }),
  });
};

/**
 * Refused because of *who* is calling, not what they sent. A typed failure
 * rather than a defect so the shape is visible in method signatures; it
 * reaches the browser as an ordinary RPC rejection at the `runEffect` seam,
 * which is all a client can act on anyway.
 */
class ShopAgentForbiddenError extends Schema.TaggedError<ShopAgentForbiddenError>()(
  "ShopAgentForbiddenError",
  { message: Schema.String },
) {}

/**
 * Who a method admits. Every `callableEffect` names one, so the check cannot
 * be forgotten when a method is added — that, and not the check itself, is
 * what keeps this safe over time.
 *
 * - `"merchant"` — a merchant connection, or a trusted caller with no
 *   connection at all (see below).
 * - `"member"` — a member connection only; it is also the source of the
 *   `memberId` / `teamIds` the method writes with, so there is nowhere else
 *   the identity could come from.
 * - `"any"` — any identified connection. Exactly one method wants this:
 *   `unsubscribe`, the other half of the subscribe cycle both populations run.
 * - `"rpc"` — not reachable from a socket at all. These methods are not
 *   `@callable()`, so the SDK already refuses to dispatch them over a
 *   connection; naming the role states the intent and catches a stray
 *   decorator.
 *
 * **Why a connectionless caller passes.** The absence of a connection means
 * the call arrived over Durable Object RPC, which only a Worker binding can
 * make — a browser has no path to it. Those callers (webhook handlers, the
 * orders-sync workflow, `/api/dev/seed`, every `ShopAgentClient` loader read)
 * are the Worker itself, already past its own authentication, and refusing
 * them here would only mean re-proving a fact the platform guarantees. The
 * check that matters is the other one: a socket whose role is wrong never
 * reaches the method body. `"member"` is the exception because it needs an
 * identity, not just trust.
 */
type CallerRole = "merchant" | "member" | "any" | "rpc";

const forbidden = (detail: string) =>
  Effect.fail(
    new ShopAgentForbiddenError({ message: `ShopAgent: forbidden: ${detail}` }),
  );

/**
 * The role check itself, run **before** the input is decoded so that a caller
 * who may not be here cannot learn anything from the shape of a schema error.
 *
 * Reads `getCurrentAgent().connection`, which the agents SDK establishes
 * around RPC dispatch (`runInInvocation`) and which is `undefined` for a plain
 * Durable Object RPC call. Returns the connection's state so a caller that
 * needs the identity does not decode it twice.
 */
const connectionRoleGuard = (
  role: CallerRole,
): Effect.Effect<
  Option.Option<Domain.ConnectionState>,
  ShopAgentForbiddenError
> =>
  Effect.suspend(() => {
    const { connection } = getCurrentAgent<ShopAgent>();
    if (!connection)
      return role === "member"
        ? forbidden("a member method needs a member connection")
        : Effect.succeed(Option.none());
    const state = connectionState(connection);
    if (Option.isNone(state)) return forbidden("unidentified connection");
    if (role === "rpc") return forbidden("not reachable over a socket");
    if (role !== "any" && state.value.role !== role)
      return forbidden(`role=${state.value.role} cannot call a ${role} method`);
    return Effect.succeed(state);
  });

/**
 * Scaffolding shared by every decoding ShopAgent RPC method: check the
 * caller's {@link CallerRole}, decode the wire input against `schema`, hand
 * the decoded value to the business `handler`, and wrap all three under
 * `Effect.withLogSpan(name)`.
 *
 * Data-last and curried:
 * `callableEffect(name, schema, options)(handler)(input)` — a method body is
 * just `this.runEffect(callableEffect(...)(businessHandler)(input))`.
 *
 * `options.parse` passes through to `Schema.decodeUnknownEffect`, which accepts
 * `ParseOptions` at decoder creation. Browser-reachable input decodes strict
 * (`{ onExcessProperty: "error" }`); trusted server-to-server input can decode
 * lax.
 *
 * A decode failure escapes as `SchemaError`, becoming a thrown fault at the
 * `runEffect` seam.
 */
const callableEffect =
  <A>(
    name: string,
    schema: Schema.ConstraintDecoder<A>,
    options: {
      readonly role: CallerRole;
      readonly parse?: SchemaAST.ParseOptions;
    },
  ) =>
  <B, E, R>(handler: (input: A) => Effect.Effect<B, E, R>) =>
  (input: unknown) =>
    connectionRoleGuard(options.role).pipe(
      Effect.flatMap(() =>
        Schema.decodeUnknownEffect(schema, options.parse)(input),
      ),
      Effect.flatMap(handler),
      Effect.withLogSpan(name),
    );

/**
 * {@link callableEffect} for the member mutations, which need the identity the
 * guard just proved rather than only its verdict: the handler receives the
 * connection's `memberId`, `memberEmail`, and `teamIds` alongside the decoded
 * wire input. Those three are exactly what a member must not be able to name
 * for themselves, which is why they arrive as a second argument from the
 * connection and never as fields on the input.
 */
const memberCallableEffect =
  <A>(
    name: string,
    schema: Schema.ConstraintDecoder<A>,
    parse?: SchemaAST.ParseOptions,
  ) =>
  <B, E, R>(
    handler: (
      input: A,
      member: Domain.MemberConnectionState,
    ) => Effect.Effect<B, E, R>,
  ) =>
  (input: unknown) =>
    connectionRoleGuard("member").pipe(
      Effect.flatMap((state) =>
        Option.isSome(state) && state.value.role === "member"
          ? Effect.succeed(state.value)
          : forbidden("member identity missing from the connection"),
      ),
      Effect.flatMap((member) =>
        Schema.decodeUnknownEffect(
          schema,
          parse,
        )(input).pipe(Effect.flatMap((decoded) => handler(decoded, member))),
      ),
      Effect.withLogSpan(name),
    );

/**
 * The Durable Object's private SQLite schema, versioned through
 * `SqliteMigrator` rather than a bare `create table if not exists` block, so
 * the next migration has somewhere to go.
 *
 * `ShopOrder`, not `Order` — `order` is a SQL reserved word, and an
 * unquoted identifier collides with `order by` in every hand-written query.
 *
 * Shopify's numeric ids are stored as `text`: they exceed the 52-bit integers
 * `SqlStorage.exec` can round-trip losslessly, and a truncated legacy id would
 * silently mismatch the webhook payload it is supposed to correlate with.
 *
 * `WebhookDelivery` is the `X-Shopify-Webhook-Id` dedupe log — Shopify retries
 * 8 times over 4 hours replaying the original payload, and warns the same
 * delivery may arrive more than once. `receivedAt` is indexed so its retention
 * sweep walks the oldest rows instead of the table. `SyncState` is one row
 * under `check (id = 1)`, seeded here so every read is a plain `select` and
 * every write is an `update` that cannot race an insert. It holds what the
 * last import left behind — its error, its completion — and nothing about a
 * run in flight: that is the Agents SDK's `cf_agents_workflows` row, read by
 * {@link ShopAgent.syncOrders}.
 *
 * `ShopUsage` is the same one-row shape and holds everything the Worker needs
 * to compare this shop against its plan without the object knowing what the
 * plan is: the billing cycle's counted orders, when the order and open-run
 * ceilings last refused something, when retention last swept, and Shopify's own
 * meter reading at the last revalidation. The cycle columns are seeded null —
 * the Worker pushes the real period (`setBillingCycle`), and until it has, the
 * object opens a cycle at its first stored order and rolls it forward on its
 * own, so a shop meters from its first run rather than from its first plan
 * revalidation. `shopGid` is here rather than derived because addressing a
 * usage event at Shopify needs it and the object has no other source.
 *
 * `UsageEvent` is the App Events outbox. The API answers `202` to everything,
 * including events it will later refuse, so an event that is merely *sent*
 * proves nothing; the row is deleted only once Shopify has accepted the request,
 * and a refusal leaves the row with its `attempts` and `lastError` for an
 * operator to read. `idempotencyKey` is the primary key because Shopify enforces
 * billing idempotency keys permanently — a replayed flush must not bill twice,
 * and re-queuing a key already stored is a no-op by construction.
 * `ShopOrder.countedAt` is its per-order counterpart: null means Baton has
 * never created a run for the order, which is what makes it bill exactly once
 * (`OrderRepository.countOrder`).
 *
 * The `(processedAt desc, id desc)` index is the keyset the orders page pages
 * on; `id desc` is in it so the tiebreak is index-ordered too, since a shop
 * can place several orders in the same millisecond. The retention sweep reads
 * the same index as a range scan (`Domain.ShopLimits.orderRetentionDays`).
 *
 * `Workflow` / `WorkflowTask` are the production-workflow *definitions* a
 * merchant configures: what starts runs. `WorkflowDraft` / `WorkflowDraftTask`
 * are the merchant's private copy under edit (see the vocabulary on
 * `Domain.Workflow`): Edit copies the workflow's tasks into the draft, every
 * editor write lands on the draft, Apply replaces the workflow's tasks with
 * the draft's and deletes it, Discard deletes it — each in
 * one transaction, so run creation sees the old definition or the new one and
 * never a half-edit. A workflow has at most one draft (`workflowId` is the
 * draft's primary key), and the draft's tasks cascade with it. Tasks live in
 * two tables rather than one with a flag so a task-id write can never be
 * ambiguous about its side and `unique (workflowId, position)` holds on each
 * side independently. No history is kept: a run survives every later edit
 * because it snapshots its tasks and names, not because old definitions are
 * retained. `activatedAt` is the on/off switch and the coverage date in one
 * column, stored and never derived: null is off; Turn on sets it to now or to
 * an earlier date the merchant chose; the merchant can move it on the
 * workflow page; Turn off clears it; Apply never touches it. One fact instead
 * of two that must agree, and Apply must not move it because an unpaid order
 * placed while the workflow was on is still that workflow's business when it
 * pays. A run starts on an order only when `ShopOrder.processedAt >=
 * activatedAt`.
 *
 * `WorkflowTask.teamId` is a D1 `Team.id` with no foreign key because none is
 * possible: `Team` lives in D1 and this table in the object's private SQLite,
 * and SQLite foreign keys do not cross databases. Integrity is
 * application-level — `addStep` / `addTask` / `updateTask` verify the team exists before
 * writing, and `deleteTeam` nulls every pointer right after the D1 row goes
 * (`unassignTeam`, served by the `teamId` indexes). Nullable on purpose:
 * `null` is **unassigned**, the state a team delete leaves behind, and every
 * read treats an id no D1 row carries the same way, so the cross-store window
 * between the two writes is harmless. No workflow history is kept — a delete
 * removes the definition, its tasks, and its draft; the runs it started stay,
 * because a run is self-sufficient with respect to its workflow and nothing
 * reads back through `workflowId`. `unique (workflowId, position)` is what forces every
 * layout edit to go through a scratch position inside one transaction — why
 * `WorkflowRepository.writeLayout` first parks every draft task at
 * `-position` before assigning final positions and steps.
 * `step` is the layout of {@link Domain.WorkflowTask}, kept by the pure
 * `WorkflowLayout` module rather than by SQL. `instructions` is merchant text
 * copied onto each run. Epoch-ms integers like `ShopOrder`, not D1 `Team`'s
 * ISO text: the two stores already differ, and one store should not mix.
 *
 * `Run` / `RunTask` are the *instances*: one workflow applied
 * to one item, with the definition's tasks copied
 * in. Every display field is a snapshot and there is no foreign key to
 * `ShopOrder`, `OrderLineItem`, or `Workflow` — a run must survive an order
 * delete, an item dropped by an edit, and a definition edit or rename,
 * because it is the record of work someone may already have started.
 * `lineItemId` is `unique`: **one row per item**, enforced by the
 * database and not only by the write paths, so reconcile, manual attach and
 * replace all have to be correct under it. The constraint is total, not
 * partial over a status: a closed run keeps the item's slot rather than
 * sitting beside a live one, and a manual attach replaces it
 * (`Domain.RunStatus`). `OrderLineItem.matchedWorkflowIds` is the other half:
 * the workflows whose tags matched at the last reconcile, from which
 * "ambiguous" (two or more, no run) is derived at read time. `status` is denormalized from the tasks for
 * the run list and the definitions badge; every task write recomputes it in
 * the same transaction. `(teamId, doneAt)` serves the member's run list, which
 * asks for open tasks by team. `RunTask.teamId` is nullable for the
 * same reason as `WorkflowTask.teamId`: a team delete nulls it on open tasks
 * (unassigned, on nobody's list until a person assigns a team) and leaves
 * done tasks alone, whose `teamName` snapshot is all history needs.
 * `startedByEmail` / `doneByEmail` snapshot the actor the same way, so
 * a member delete never leaves history resolving to nobody. A run task is
 * *current* by `currentWhere`'s rule, so several tasks of one run can be
 * current at once; `startedAt` / `startedBy` record Start. A run is `active` from
 * creation, and `Domain.runIsUnstarted` reads the tasks. `Run.note` is free
 * text about the whole item, one field per run with no author
 * (`Domain.SetRunNoteCommand`).
 * `blockedAt` / `blockReason` / `blockedBy` are the one hold a person sets
 * (`Domain.runIsBlocked`); `blockedBy` is the JSON `Domain.Actor`.
 * `closedAt` / `closedReason` are set together when a run closes
 * (`Domain.ClosedReason`), and `quantityChangedFrom` is the quantity badge
 * (`Domain.Run`).
 *
 * `startedByRole` / `doneByRole` / `reopenedByRole` are the actor
 * discriminator (`Domain.Actor`): the merchant acts on these rows from the
 * order page and has no `Member` row, so the id and email columns beside a
 * `'merchant'` role are null. `reopenedAt` / `reopenedBy*` hold the most
 * recent reopen only; a later Done clears the three together.
 */
const initializeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table if not exists ShopOrder (
      id text primary key,
      legacyId text not null,
      name text not null,
      processedAt integer not null,
      updatedAt integer not null,
      cancelledAt integer,
      closedAt integer,
      financialStatus text,
      fulfillmentStatus text not null,
      fullyPaid integer not null,
      note text,
      lineItemsTruncated integer not null default 0,
      syncedAt integer not null,
      syncSource text not null,
      countedAt integer
    );
    -- Serves the index page's keyset and the retention sweep's range scan
    -- alike; a descending index reads a range as readily as an ascending one,
    -- so the sweep needs no index of its own.
    create index if not exists ShopOrder_processedAt
      on ShopOrder (processedAt desc, id desc);
    create index if not exists ShopOrder_open_idx
      on ShopOrder (processedAt desc, id desc)
      where fulfillmentStatus <> 'FULFILLED' and cancelledAt is null;
    create table if not exists OrderLineItem (
      id text primary key,
      orderId text not null references ShopOrder(id) on delete cascade,
      productId text,
      variantId text,
      title text not null,
      variantTitle text,
      sku text,
      quantity integer not null,
      currentQuantity integer not null,
      productTags text not null,
      matchedWorkflowIds text not null default '[]',
      properties text not null,
      requiresShipping integer not null
    );
    create index if not exists OrderLineItem_orderId on OrderLineItem (orderId);
    create table if not exists WebhookDelivery (
      webhookId text primary key,
      topic text not null,
      orderId text not null,
      triggeredAt integer not null,
      receivedAt integer not null
    );
    create index if not exists WebhookDelivery_receivedAt_idx
      on WebhookDelivery (receivedAt);
    create table if not exists SyncState (
      id integer primary key check (id = 1),
      lastError text,
      lastCompletedAt integer
    );
    insert or ignore into SyncState (id) values (1);
    create table if not exists ShopUsage (
      id integer primary key check (id = 1),
      shopGid text,
      cycleStartAt integer,
      cycleEndAt integer,
      ordersThisCycle integer not null default 0,
      ordersLimitedAt integer,
      openRunsLimitedAt integer,
      lastSweepAt integer,
      membersHighWater integer not null default 0,
      lastReconciledOrders integer,
      lastReconciledMembers integer
    );
    insert or ignore into ShopUsage (id) values (1);
    create table if not exists UsageEvent (
      idempotencyKey text primary key,
      eventHandle text not null,
      orderId text,
      value integer not null,
      occurredAt integer not null,
      attempts integer not null default 0,
      lastError text
    );
    create table if not exists Workflow (
      id text primary key,
      name text not null check (name = trim(name) and length(name) > 0),
      tag text not null unique check (tag = trim(tag) and length(tag) > 0),
      activatedAt integer,
      createdAt integer not null,
      updatedAt integer not null
    );
    create table if not exists WorkflowTask (
      id text primary key,
      workflowId text not null references Workflow (id) on delete cascade,
      position integer not null,
      step integer not null,
      name text not null check (name = trim(name) and length(name) > 0),
      teamId text,
      instructions text,
      unique (workflowId, position)
    );
    create index if not exists WorkflowTask_teamId_idx on WorkflowTask (teamId);
    create table if not exists WorkflowDraft (
      workflowId text primary key references Workflow (id) on delete cascade,
      createdAt integer not null,
      updatedAt integer not null
    );
    create table if not exists WorkflowDraftTask (
      id text primary key,
      workflowId text not null references WorkflowDraft (workflowId) on delete cascade,
      position integer not null,
      step integer not null,
      name text not null check (name = trim(name) and length(name) > 0),
      teamId text,
      instructions text,
      unique (workflowId, position)
    );
    create index if not exists WorkflowDraftTask_teamId_idx on WorkflowDraftTask (teamId);
    create table if not exists Run (
      id text primary key,
      workflowId text not null,
      workflowName text not null,
      orderId text not null,
      orderName text not null,
      orderProcessedAt integer not null,
      lineItemId text not null unique,
      lineItemTitle text not null,
      variantTitle text,
      sku text,
      quantity integer not null,
      lineItemProperties text not null,
      source text not null check (source in ('tag', 'manual')),
      status text not null check (status in ('active', 'done', 'closed')),
      blockedAt integer,
      blockReason text,
      blockedBy text,
      quantityChangedFrom integer,
      note text,
      createdAt integer not null,
      updatedAt integer not null,
      closedAt integer,
      closedReason text check (closedReason in ('fulfilled', 'order_cancelled', 'item_removed', 'merchant_cancelled'))
    );
    create index if not exists Run_orderId_idx on Run (orderId);
    create index if not exists Run_status_idx on Run (status);
    create index if not exists Run_open_age_idx
      on Run (orderProcessedAt, lineItemId, id) where status = 'active';
    create index if not exists Run_closed_idx
      on Run (closedAt) where status = 'closed';
    create table if not exists RunTask (
      id text primary key,
      runId text not null references Run (id) on delete cascade,
      position integer not null,
      step integer not null,
      name text not null,
      teamId text,
      teamName text not null,
      instructions text,
      startedAt integer,
      startedBy text,
      startedByEmail text,
      doneAt integer,
      doneBy text,
      doneByEmail text,
      startedByRole text check (startedByRole in ('merchant', 'member')),
      doneByRole text check (doneByRole in ('merchant', 'member')),
      reopenedAt integer,
      reopenedByRole text check (reopenedByRole in ('merchant', 'member')),
      reopenedByEmail text,
      unique (runId, position)
    );
    create index if not exists RunTask_teamId_idx
      on RunTask (teamId, doneAt);
  `;
});

export const runShopAgentMigrations = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    "1_initialize schema": initializeSchema,
  }),
}).pipe(
  Effect.tapCause((cause) =>
    Effect.logError(
      `ShopAgent migrations failed: ${causeToErrorMessage(cause)}`,
    ),
  ),
  Effect.asVoid,
);

/**
 * Two SQL stores coexist. `Repository` runs over D1 (shared, sessions) via the
 * app-owned `D1Session`/`D1Primary` tags; `OrderRepository` runs over the DO's
 * private SQLite (`ctx.storage`, per-shop), whose `SqliteClient.layer` is the
 * only provider of the ambient `SqlClient` tag here. That is what
 * `runShopAgentMigrations` (which requests `SqlClient` directly) needs. Each
 * repository closes over its own client at layer-build time, so the ambient tag
 * only governs the migration.
 */
const makeRunEffect = (env: Env, storage: DurableObjectStorage) => {
  const envLayer = makeEnvLayer(env);
  // Both D1 paths resolve to the raw binding here: a Durable Object call has
  // no per-request replica session, and every read from inside the object is
  // correctness-sensitive (token refresh) — primary semantics throughout.
  const repositoryLayer = Layer.provideMerge(
    Repository.layerNoDeps,
    Layer.mergeAll(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, envLayer),
      envLayer,
    ),
  );
  const shopifyLayer = Layer.provideMerge(Shopify.layerNoDeps, repositoryLayer);
  const durableRepositoryLayer = Layer.mergeAll(
    WorkflowRepository.layer,
    RunRepository.layer,
  ).pipe(
    Layer.provideMerge(OrderRepository.layer),
    Layer.provideMerge(SqliteClient.layer({ storage })),
  );
  const layer = Layer.mergeAll(
    makeLoggerLayer(env),
    repositoryLayer,
    shopifyLayer,
    durableRepositoryLayer,
    // The usage-event client lives here rather than in the Worker because the
    // outbox it drains is this object's table. It holds a bearer token in a
    // `Ref`, which is the other reason it belongs to the runtime: one token per
    // object instance, minted on first use and reused for the hour.
    Layer.provide(ShopifyAppEvents.layerNoDeps, FetchHttpClient.layer),
    FetchHttpClient.layer,
  );
  const runtime = ManagedRuntime.make(layer);
  return async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    throw new Error(causeToErrorMessage(exit.cause));
  };
};

/**
 * `ShopifyAdmin` is the one stack {@link makeRunEffect} cannot hold.
 * `ShopifyAdmin.layerNoDeps` closes over a concrete session at build time, and
 * `ManagedRuntime` memoizes what it builds — so a runtime-level `ShopifyAdmin`
 * would pin whichever offline token was live when the Durable Object was
 * constructed and keep using it after `Shopify.refreshShopSessionIfExpired` had
 * rotated it, on an instance that lives for hours. Built per call instead, from
 * the session `ensureShopSession` just returned. `Shopify` and `Env`, the stack's
 * other requirements, are ambient and resolve from the runtime.
 */
const shopifyAdminLayer = (session: ShopifyApi.Session) =>
  Layer.provide(
    ShopifyAdmin.layerNoDeps,
    Layer.succeed(CurrentShopifySession, session),
  );

/**
 * One pass over the usage-event outbox, logged and never raised.
 *
 * Every caller is a request whose real work has already succeeded — a webhook
 * that stored an order, a bulk import that finished its stream, an uninstall
 * that is about to delete everything — and none of them may fail because a
 * billing event could not go out. The rows survive a failure, so the next
 * order's flush retries them, and `ShopUsage.pendingUsageEvents` is what makes
 * a queue that never drains visible on the admin page.
 */
const flushUsageEvents = Effect.fn("ShopAgent.flushUsageEvents")(function* (
  shop: string,
) {
  const repository = yield* OrderRepository;
  const flush = yield* repository.flushUsageEvents(shop).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `ShopAgent.flushUsageEvents: shop=${shop}: ${causeToErrorMessage(cause)}`,
      ).pipe(
        Effect.annotateLogs({ shop, cause: causeToErrorMessage(cause) }),
        // The real queue, not zero: the uninstall path reports this number
        // as what Shopify was never told, and a flush that failed outright
        // is the case where that number matters most.
        Effect.andThen(
          repository
            .getUsage()
            .pipe(Effect.map((usage) => usage.pendingUsageEvents)),
        ),
        Effect.map((remaining) => ({ sent: 0, remaining })),
        Effect.catchCause(() => Effect.succeed({ sent: 0, remaining: 0 })),
      ),
    ),
  );
  if (flush.sent > 0 || flush.remaining > 0)
    yield* Effect.logInfo(
      `ShopAgent.flushUsageEvents: shop=${shop} sent=${String(flush.sent)} pending=${String(flush.remaining)}`,
    ).pipe(
      Effect.annotateLogs({
        shop,
        sent: flush.sent,
        pending: flush.remaining,
      }),
    );
  return flush;
});

/**
 * Maps the repository's expected failures onto the tagged result union the
 * page decodes, leaving faults (`SqlError`, decode errors) to propagate and
 * become a thrown `Error` at the `runEffect` seam. Expected failures must be
 * *values* here because that seam collapses every failure into one message
 * string, which would leave the browser unable to tell "tag taken" (a field
 * error) from "limit reached" (a banner).
 */
const workflowResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
    | WorkflowTagTakenError
    | WorkflowNotFoundError
    | WorkflowLimitError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.WorkflowResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map((workflow): Domain.WorkflowResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowTagTakenError: ({ tag, workflowId, workflowName }) =>
        Effect.succeed<Domain.WorkflowResult>({
          _tag: "TagTaken",
          tag,
          workflowId,
          workflowName,
        }),
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "Limit", limit }),
    }),
  );

const applyResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
    | WorkflowNotFoundError
    | NoDraftError
    | NoTasksError
    | TaskUnassignedError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ApplyResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map((workflow): Domain.ApplyResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.ApplyResult>({ _tag: "NotFound" }),
      NoDraftError: () =>
        Effect.succeed<Domain.ApplyResult>({ _tag: "NoDraft" }),
      NoTasksError: () =>
        Effect.succeed<Domain.ApplyResult>({ _tag: "NoTasks" }),
      TaskUnassignedError: ({ taskNames }) =>
        Effect.succeed<Domain.ApplyResult>({
          _tag: "TaskUnassigned",
          taskNames,
        }),
    }),
  );

const discardResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
    | WorkflowNotFoundError
    | NoDraftError
    | SqlError.SqlError
    | WorkflowRepositoryError,
    R
  >,
): Effect.Effect<
  Domain.DiscardResult,
  SqlError.SqlError | WorkflowRepositoryError,
  R
> =>
  effect.pipe(
    Effect.map((workflow): Domain.DiscardResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.DiscardResult>({ _tag: "NotFound" }),
      NoDraftError: () =>
        Effect.succeed<Domain.DiscardResult>({ _tag: "NoDraft" }),
    }),
  );

const draftResult = <R>(
  effect: Effect.Effect<
    Domain.DraftResult,
    WorkflowNotFoundError | SqlError.SqlError | WorkflowRepositoryError,
    R
  >,
): Effect.Effect<
  Domain.DraftResult,
  SqlError.SqlError | WorkflowRepositoryError,
  R
> =>
  effect.pipe(
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.DraftResult>({ _tag: "NotFound" }),
    }),
  );

/** `Ok` carries how many runs the reconcile-all after the switch started — in either direction, since Turn off can resolve an ambiguity — for the toast. */
const activateResult = <R>(
  effect: Effect.Effect<
    { readonly workflow: Domain.Workflow; readonly started: number },
    | WorkflowNotFoundError
    | NoTasksError
    | TaskUnassignedError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ActivateResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map(({ workflow, started }): Domain.ActivateResult => ({
      _tag: "Ok",
      workflow,
      started,
    })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.ActivateResult>({ _tag: "NotFound" }),
      NoTasksError: () =>
        Effect.succeed<Domain.ActivateResult>({ _tag: "NoTasks" }),
      TaskUnassignedError: ({ taskNames }) =>
        Effect.succeed<Domain.ActivateResult>({
          _tag: "TaskUnassigned",
          taskNames,
        }),
    }),
  );

const changeActivatedAtResult = <R>(
  effect: Effect.Effect<
    { readonly workflow: Domain.Workflow; readonly started: number },
    | WorkflowNotFoundError
    | WorkflowOffError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ChangeActivatedAtResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map(({ workflow, started }): Domain.ChangeActivatedAtResult => ({
      _tag: "Ok",
      workflow,
      started,
    })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.ChangeActivatedAtResult>({ _tag: "NotFound" }),
      WorkflowOffError: () =>
        Effect.succeed<Domain.ChangeActivatedAtResult>({ _tag: "Off" }),
    }),
  );

const taskResult = <R>(
  effect: Effect.Effect<
    Domain.TaskResult,
    | TaskNotFoundError
    | StepNotFoundError
    | WorkflowNotFoundError
    | WorkflowLimitError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.TaskResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.catchTags({
      TaskNotFoundError: () =>
        Effect.succeed<Domain.TaskResult>({ _tag: "NotFound" }),
      StepNotFoundError: () =>
        Effect.succeed<Domain.TaskResult>({ _tag: "NotFound" }),
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.TaskResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) =>
        Effect.succeed<Domain.TaskResult>({ _tag: "Limit", limit }),
    }),
  );

/**
 * Same shape as {@link workflowResult}: expected run failures become values.
 * `WorkflowRepositoryError` and `SchemaError` ride along because the actions
 * that can start a run load the start context (active definitions from this
 * object, teams from D1) first.
 */
const runResult = <R>(
  effect: Effect.Effect<
    void,
    | RunNotFoundError
    | RunTerminalError
    | RunBlockedError
    | RunOrderClosedError
    | RunNotAllowedError
    | RunNotBlockedError
    | TaskNotReadyError
    | TaskReopenBlockedError
    | SqlError.SqlError
    | RunRepositoryError
    | WorkflowRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.RunResult,
  | SqlError.SqlError
  | RunRepositoryError
  | WorkflowRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.as<Domain.RunResult>({ _tag: "Ok" }),
    Effect.catchTags({
      RunNotFoundError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotFound" }),
      RunTerminalError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "Terminal" }),
      RunBlockedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "Blocked" }),
      RunOrderClosedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "Terminal" }),
      RunNotAllowedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotAllowed" }),
      RunNotBlockedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotBlocked" }),
      TaskNotReadyError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotReady" }),
      TaskReopenBlockedError: ({ taskName, teamName }) =>
        Effect.succeed<Domain.RunResult>({
          _tag: "ReopenBlocked",
          taskName,
          teamName,
        }),
    }),
  );

const SHOP_AGENT_BINDING = "SHOP_AGENT";

/**
 * Statuses the Agents SDK's tracking row carries while an import is under
 * way. `waiting` is in the set because a refreshed row reads that way while
 * the instance sleeps between polls (`OrdersSyncWorkflow`), and a sleeping
 * import is still an import.
 */
const IMPORT_IN_FLIGHT = ["queued", "running", "waiting"] as const;

/** The Workflows binding's own wording for an id it has no instance for. */
const isWorkflowInstanceNotFoundError = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("instance.not_found");

/**
 * How long a tracking row is trusted on its own before the object asks
 * Cloudflare what really became of the instance. The SDK never reaps a row: a
 * Workflow that dies without reporting leaves one reading `running` forever,
 * and with it a permanently disabled button. Ten minutes is comfortably past
 * the workflow's own give-up bound plus its stream.
 */
const IMPORT_STALE_MS = 10 * 60 * 1000;

/**
 * What `/webhooks/orders` resolved a delivery down to: the order it names, the
 * topic for the log line, the delivery id the dedupe log keys on, and the
 * `updated_at` the stale guard reads — `null` for `orders/edited`, whose
 * payload has none, which is what makes an edit always fetch.
 */
export const OrderWebhookInput = Schema.Struct({
  orderId: Schema.NonEmptyString,
  topic: Schema.String,
  webhookId: Schema.NonEmptyString,
  triggeredAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
});
export type OrderWebhookInput = typeof OrderWebhookInput.Type;

const OrdersSyncErrorInput = Schema.Struct({ message: Schema.String });

const OrdersStreamInput = Schema.Struct({ url: Schema.String });

/**
 * Per-shop Durable Object concurrency relies on the platform rather than an
 * application lock. Durable Objects run one synchronous JavaScript turn at a time;
 * `SqlStorage.exec()` is synchronous, and Cloudflare input gates protect the
 * Promise-based `storage.transaction()` used by Effect's SQLite adapter. Once a
 * transaction completes, subscription updates and WebSocket sends below
 * are synchronous in the resumed turn. `blockConcurrencyWhile()` is therefore only
 * needed for constructor migrations. Revisit this only if a state transition starts
 * awaiting non-storage I/O such as `fetch()`.
 *
 * The object is addressed by shop domain (`env.SHOP_AGENT.getByName(shop)`), so
 * `this.name` is the shop and no method takes one.
 */
/** See `publish`. */
type PublishScope = "all" | readonly string[];

/**
 * The team half of a publish's scope, for member connections only — see
 * `publish`. `"all"` is "every team", the honest answer whenever the writer
 * cannot name the teams a change touched.
 */
type PublishTeams = "all" | readonly string[];

/**
 * The teams whose run lists a write to this order could have changed, as a value
 * a caller can read on both sides of the write. A failed read answers `"all"`,
 * never `[]`: an over-broad publish costs each member one refetch, while an
 * under-broad one leaves a list that silently stops updating until the tab's
 * next subscribe, and the read failing is no reason to guess narrow. The write
 * that triggered it is never failed by it.
 */
const orderTeamIds = (
  target:
    | { readonly runTaskId: string }
    | { readonly runId: string }
    | { readonly orderId: string },
) =>
  RunRepository.pipe(
    Effect.flatMap(
      (repository): Effect.Effect<PublishTeams, SqlError.SqlError> =>
        repository.listOrderTeamIds(target),
    ),
    Effect.orElseSucceed((): PublishTeams => "all"),
  );

/** The union of two team scopes; `"all"` on either side is `"all"`. */
const unionTeams = (a: PublishTeams, b: PublishTeams): PublishTeams =>
  a === "all" || b === "all" ? "all" : [...new Set([...a, ...b])];

/** The merchant as a gating actor: no team ids, because the merchant has none and every "M" cell is theirs. */
const MERCHANT: Domain.Actor = { role: "merchant" };

/** A member as a gating actor, from the identity the connection carries. */
const memberActor = ({
  memberId,
  memberEmail,
  teamIds,
}: {
  readonly memberId: Domain.MemberId;
  readonly memberEmail: Domain.Email;
  readonly teamIds: readonly Domain.TeamId[];
}): Domain.Actor => ({
  role: "member",
  memberId,
  email: memberEmail,
  teamIds,
});

/**
 * **The action set is the one gate.** The page rendered the button because
 * the field was true ({@link Domain.runActions}); the callable checks the
 * same field with the same inputs, read fresh inside the write's own call,
 * so a stale tab or a second admin cannot write what the page would not
 * offer. `RunNotAllowedError` (`RunResult.NotAllowed`) when the field is
 * false, `RunNotFoundError` when the run or its order is gone. The
 * repository keeps its own guards underneath as the second line. Every
 * `merchant*` and `member*` run write calls this or
 * {@link requireTaskAction} before it writes.
 */
const requireRunAction = (
  runId: string,
  actor: Domain.Actor,
  field: keyof Domain.RunActions,
) =>
  Effect.gen(function* () {
    const gate = yield* (yield* RunRepository).getRunGate({ runId });
    if (Option.isNone(gate)) return yield* new RunNotFoundError({ id: runId });
    const { run, tasks, order } = gate.value;
    if (!Domain.runActions(actor, order, run, tasks)[field])
      return yield* new RunNotAllowedError({ runId, teamId: "" });
    return gate.value;
  });

/** {@link requireRunAction} for one task, reading {@link Domain.taskActions}. */
const requireTaskAction = (
  runTaskId: string,
  actor: Domain.Actor,
  allowed: (actions: Domain.TaskActions) => boolean,
) =>
  Effect.gen(function* () {
    const gate = yield* (yield* RunRepository).getRunGate({
      runTaskId,
    });
    const task = Option.isSome(gate)
      ? gate.value.tasks.find((candidate) => candidate.id === runTaskId)
      : undefined;
    if (Option.isNone(gate) || task === undefined)
      return yield* new RunNotFoundError({ id: runTaskId });
    const { run, order } = gate.value;
    if (!allowed(Domain.taskActions(actor, order, run, task)))
      return yield* new RunNotAllowedError({ runId: run.id, teamId: "" });
    return task;
  });

/**
 * Which tasks are current is decided on a snapshot taken before any
 * task of the round is done: marking step 1 done makes step 2 current at
 * once, so asking `markTaskDone` as the loop goes would run the
 * whole order to done in one round. The rule is `Domain.currentTasks`.
 */
/**
 * A seeded task write recorded as the merchant: no `teamIds`, which is the one
 * rule a merchant skips (`Domain.MarkTaskDoneCommand`). Module scope because
 * it captures nothing — oxlint's `unicorn(consistent-function-scoping)`.
 */
const merchantTaskCommand = (task: Domain.RunTask) => ({
  runTaskId: task.id,
  actor: { role: "merchant" } as const,
});

const seedReadyTasks = (
  details: readonly Domain.RunDetail[],
): Domain.RunTask[] =>
  details.flatMap(({ run, tasks }) => Domain.currentTasks(run, tasks));

export class ShopAgent extends Agent {
  declare private readonly runEffect: ReturnType<typeof makeRunEffect>;

  /**
   * Set for the width of the `await` inside {@link ShopAgent.syncOrders} that
   * creates the workflow instance, and read by the next click. The object
   * runs one JavaScript thread, so a plain field is complete mutual exclusion
   * over the one window no stored row can cover: the Agents SDK inserts its
   * tracking row only after that same await returns.
   */
  private importStarting = false;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        Domain.SocketKeepalivePing,
        Domain.SocketKeepalivePong,
      ),
    );
    this.runEffect = makeRunEffect(env, ctx.storage);
    void ctx.blockConcurrencyWhile(() =>
      this.runEffect(runShopAgentMigrations),
    );
  }

  /**
   * Copies the identity the Worker's connect gate resolved off the forwarded
   * request and onto the connection, where every callable reads it from
   * (`Domain.ConnectionState`).
   *
   * A decode failure closes the connection with
   * `Domain.CONNECTION_CLOSE_FORBIDDEN` instead of accepting an unidentified
   * socket: browsers cannot set these headers, so the only way to get here
   * with malformed ones is a gate that forwarded something wrong, and an
   * unidentified connection would otherwise sit open failing every callable's
   * role check one confusing error at a time.
   *
   * The subscription starts `null`: a fresh connection is subscribed to
   * nothing, which is already what the reconnect path in `useSubscribedQuery`
   * assumes.
   */
  override onConnect(connection: Connection, ctx: ConnectionContext) {
    const shop = this.name;
    return this.runEffect(
      Schema.decodeUnknownEffect(Domain.ConnectionState)(
        connectionStateFromHeaders(ctx.request.headers),
      ).pipe(
        Effect.flatMap((state) =>
          Effect.sync(() => {
            connection.setState(state);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `ShopAgent.onConnect: shop=${shop} connectionId=${connection.id}: no decodable identity, closing`,
          ).pipe(
            Effect.annotateLogs({
              shop,
              connectionId: connection.id,
              cause: causeToErrorMessage(cause),
            }),
            Effect.flatMap(() =>
              Effect.sync(() => {
                connection.close(
                  Domain.CONNECTION_CLOSE_FORBIDDEN,
                  "unidentified connection",
                );
              }),
            ),
          ),
        ),
        Effect.withLogSpan("ShopAgent.onConnect"),
      ),
    );
  }

  /**
   * Tags are persisted with the hibernatable socket and are what
   * `getConnections(tag)` filters on, so they carry only what a *fan-out* has
   * to select by: the role, and for a member the id a membership change has
   * to revoke (`revokeMemberConnections`). Everything else stays in
   * `connection.state`.
   *
   * Runs before `onConnect`, against the same forwarded request, so it reads
   * the headers rather than the state. An undecodable request tags nothing —
   * `onConnect` closes that connection a moment later.
   */
  override getConnectionTags(
    _connection: Connection,
    ctx: ConnectionContext,
  ): string[] {
    return Option.match(
      decodeConnectionState(connectionStateFromHeaders(ctx.request.headers)),
      {
        onNone: () => [],
        onSome: (state) =>
          state.role === "member"
            ? ["member", memberConnectionTag(state.memberId)]
            : ["merchant"],
      },
    );
  }

  private subscription(connection: Connection): Domain.Subscription | null {
    return Option.match(connectionState(connection), {
      onNone: () => null,
      onSome: (state) => state.subscription,
    });
  }

  private connections() {
    return Effect.try({
      try: () => [...this.getConnections()],
      catch: (cause) =>
        new ShopAgentNotifyError({ message: "getConnections failed", cause }),
    });
  }

  private publishTo(
    connection: Connection,
    touched: PublishScope,
    teams: PublishTeams,
  ) {
    return Effect.try({
      try: () => {
        const state = Option.getOrNull(connectionState(connection));
        const subscription = state?.subscription;
        if (!state || !subscription) return;
        const inScope =
          state.role === "member"
            ? teams === "all" ||
              state.teamIds.some((teamId) => teams.includes(teamId))
            : touched === "all" ||
              subscription.orderId === null ||
              touched.includes(subscription.orderId);
        if (inScope)
          connection.send(
            JSON.stringify({
              type: "invalidated",
            } satisfies Domain.InvalidatedMessage),
          );
      },
      catch: (cause) =>
        new ShopAgentNotifyError({ message: "invalidated send failed", cause }),
    }).pipe(
      Effect.ignore({
        log: "Debug",
        message: `ShopAgent.publishTo: shop=${this.name}`,
      }),
    );
  }

  /**
   * Closes every open connection belonging to these members with
   * `Domain.CONNECTION_CLOSE_REVOKED`, so each reconnects through the Worker's
   * gate and comes back with whatever membership now holds.
   *
   * Identity on a connection is a connect-time snapshot
   * (`Domain.ConnectionState`), which is what makes this necessary: a member
   * removed from a team keeps a socket whose `teamIds` still name it until
   * something closes it. Closing is the cheapest correct answer — the gate is
   * the one authority on membership, and a reconnect simply asks it again.
   * Cloudflare's ~300s idle close is the backstop if this ever fails.
   *
   * Best-effort by design: a close that throws is logged and skipped rather
   * than failing the merchant's edit, which has already been written to D1 and
   * is not undone by a stale socket surviving a few minutes.
   */
  private closeMemberConnections(memberIds: readonly string[]) {
    const shop = this.name;
    return Effect.forEach(
      memberIds,
      (memberId) =>
        Effect.try({
          try: () => {
            for (const connection of this.getConnections(
              memberConnectionTag(memberId),
            ))
              connection.close(
                Domain.CONNECTION_CLOSE_REVOKED,
                "membership changed",
              );
          },
          catch: (cause) =>
            new ShopAgentNotifyError({
              message: "revoke close failed",
              cause,
            }),
        }).pipe(
          Effect.ignore({
            log: "Debug",
            message: `ShopAgent.revokeMemberConnections: shop=${shop} memberId=${memberId}`,
          }),
        ),
      { discard: true },
    );
  }

  /**
   * Plain RPC, not `@callable()`: the caller is the Worker, right after the D1
   * write that changed a membership (`app.teams.$teamId`, `app.members`). A
   * browser has no business revoking anyone.
   */
  revokeMemberConnections(
    input: typeof Domain.RevokeMemberConnectionsInput.Encoded,
  ): Promise<void> {
    const close = (memberIds: readonly string[]) =>
      this.closeMemberConnections(memberIds);
    return this.runEffect(
      callableEffect(
        "ShopAgent.revokeMemberConnections",
        Domain.RevokeMemberConnectionsInput,
        { role: "rpc" },
      )(({ memberIds }) => close(memberIds))(input),
    );
  }

  /**
   * Closes every connection on this object — merchant and member alike — with
   * `Domain.CONNECTION_CLOSE_REVOKED`. Plain RPC, not `@callable()`: the
   * caller is `SubscriptionPlan`, at the moment a revalidation learns the
   * shop's subscription lapsed.
   *
   * The keepalive means a healthy socket never reconnects on its own, so the
   * connect-time plan check would otherwise hold for as long as the tab
   * lives. Closing is what makes the gate's `402` reach an open tab: each
   * reconnect asks the gate again, and the gate now refuses. Best-effort like
   * {@link closeMemberConnections}: a failed close is logged, never surfaced
   * to the revalidation that triggered it.
   */
  revokeAllConnections(): Promise<void> {
    const shop = this.name;
    const connections = () => this.getConnections();
    return this.runEffect(
      Effect.gen(function* () {
        yield* connectionRoleGuard("rpc");
        yield* Effect.try({
          try: () => {
            for (const connection of connections())
              connection.close(
                Domain.CONNECTION_CLOSE_REVOKED,
                "subscription lapsed",
              );
          },
          catch: (cause) =>
            new ShopAgentNotifyError({
              message: "revoke close failed",
              cause,
            }),
        }).pipe(
          Effect.ignore({
            log: "Debug",
            message: `ShopAgent.revokeAllConnections: shop=${shop}`,
          }),
        );
      }).pipe(Effect.withLogSpan("ShopAgent.revokeAllConnections")),
    );
  }

  /**
   * Invalidations are best-effort hints, never the new value: SQLite stays
   * authoritative and a subscribing tab refetches, so a dropped push costs a
   * stale render until the next subscribe rather than a lost write. That is
   * why a send failure is swallowed here instead of failing the mutation that
   * triggered it.
   *
   * `touched` scopes the push (see `Domain.Subscription`): the order GIDs a
   * write changed, or `"all"` when the writer cannot name them — the bulk
   * sync, which touches a window of orders, and the run mutations, whose
   * repository reports a `RunResult` without the order. An index subscription
   * (`orderId: null`) is published to either way; a detail subscription only
   * for its own order. Workflow configuration is loader data and does not
   * publish, with one exception: Apply and the on/off switch change what
   * starts runs, which the order page's `itemWorkflows` shows, so those two
   * publish `"all"`.
   *
   * `teams` is the same idea for the other population. A member's subscription
   * is their run list, which is scoped by team rather than by order, so an order
   * GID says nothing about whether their view changed. The five member
   * mutations name the teams their write could have affected — every team
   * owning a task on any run of that order, because which tasks are current depends on every run of the order
   * (`RunRepository.listOrderTeamIds`) — and everything else publishes
   * `"all"`, which reaches every member. Over-broad costs a refetch;
   * under-broad costs a list that silently stops updating, so `"all"` is the
   * right default for a writer that cannot name them.
   */
  private publish(touched: PublishScope, teams: PublishTeams = "all") {
    return this.connections().pipe(
      Effect.flatMap((connections) =>
        Effect.forEach(
          connections,
          (connection) => this.publishTo(connection, touched, teams),
          { discard: true },
        ),
      ),
      Effect.ignore({
        log: "Debug",
        message: `ShopAgent.publish: shop=${this.name}`,
      }),
    );
  }

  @callable()
  unsubscribe(input: Domain.SubscriberIdInput): Promise<void> {
    return this.runEffect(
      callableEffect("ShopAgent.unsubscribe", Domain.SubscriberIdInput, {
        role: "any",
        parse: { onExcessProperty: "error" },
      })(({ subscriberId }) =>
        Effect.sync(() => {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (
            connection &&
            this.subscription(connection)?.subscriberId === subscriberId
          )
            setSubscription(connection, null);
        }),
      )(input),
    );
  }

  /**
   * Fetches one order from the Admin API and merges it into SQLite. Shared by
   * the webhook path and the manual resync; `source` is the only difference,
   * and it is recorded, not acted on.
   *
   * A `null` order is not a failure: by the time a delivery is handled the
   * order may already be deleted, and Shopify answers with `null` rather than
   * an error. Logged and skipped so the webhook still returns 2xx instead of
   * being retried for four hours against an order that no longer exists.
   */
  private fetchAndUpsertOrder(orderId: string, source: Domain.OrderSyncSource) {
    const name = this.name;
    const reconciler = () => this.reconciler(source);
    return Effect.gen(function* () {
      const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(name);
      const session = yield* (yield* Shopify).ensureShopSession(shop);
      const { order } = yield* ShopifyAdmin.pipe(
        Effect.flatMap((admin) =>
          admin.graphqlDecode(OrderSyncResponse, orderSyncQuery, {
            variables: orderSyncVariables(orderId),
          }),
        ),
        Effect.provide(shopifyAdminLayer(session)),
      );
      if (order === null) {
        yield* Effect.logWarning(
          `ShopAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId}: order not found`,
        ).pipe(Effect.annotateLogs({ shop, orderId, source }));
        return false;
      }
      const lineItemsTruncated = order.lineItems.pageInfo.hasNextPage;
      if (lineItemsTruncated)
        yield* Effect.logError(
          `ShopAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} limit=${String(Domain.ShopLimits.maxLineItemsPerOrder)}: line items truncated`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            orderId,
            source,
            limit: Domain.ShopLimits.maxLineItemsPerOrder,
          }),
        );
      const reconcile = yield* reconciler();
      const shopOrder = toShopOrder({
        node: order,
        source,
        syncedAt: yield* Clock.currentTimeMillis,
        lineItemsTruncated,
      });
      const { written } = yield* (yield* OrderRepository).upsertOrder({
        order: shopOrder,
        lineItems: order.lineItems.nodes.map((node) =>
          toOrderLineItem(order.id, node),
        ),
        afterWrite: reconcile(shopOrder),
      });
      yield* Effect.logInfo(
        `ShopAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId} source=${source} written=${String(written)}`,
      ).pipe(Effect.annotateLogs({ shop, orderId, source, written }));
      return written;
    });
  }

  /**
   * Starts the open-order import, or reports the one already running.
   *
   * `@callable()`: the socket this arrives on already passed the Worker's gate
   * (session-token signature, `exp`/`nbf`/`aud`, the URL's shop matching the
   * token's signed `dest`, an active subscription). This method takes no
   * arguments, so there is no privileged input for the Worker to resolve, and
   * its only effect is starting a workflow the object itself refuses to
   * duplicate — a server-function hop would add a round trip and check nothing
   * new. `ShopAgentClient` is for calls that must carry a Worker-resolved input
   * such as a plan ceiling.
   *
   * **One import at a time**, tracked by the Agents SDK and nowhere else. The
   * SDK's `cf_agents_workflows` row is the only record that an import is
   * running, so there is no reservation to reconcile against it and no way for
   * the two to disagree. Three cases, and the code above is all three:
   *
   * - *Two clicks in one tick.* `runWorkflow` awaits `workflow.create` before
   *   it inserts the tracking row, so a second call during that await would
   *   read an empty {@link IMPORT_IN_FLIGHT} query. The object runs one
   *   JavaScript thread and `getWorkflows` is synchronous, so the plain
   *   `importStarting` field set before the await closes the gap exactly.
   * - *A wedged row.* The SDK never reaps its own rows. A row older than
   *   {@link IMPORT_STALE_MS} is refreshed from the Workflows API through
   *   `getWorkflowStatus`, which rewrites it; if it still reads as in flight
   *   afterwards, the instance really is alive. A row whose instance the
   *   platform no longer has (`instance.not_found`) is deleted outright,
   *   since nothing else ever would and it would disable the button for good.
   * - *A throw between `create` and the insert.* The instance runs untracked
   *   and this call surfaces the error. Harmless: the query is fixed and the
   *   upsert idempotent, so the orphan run does exactly what a re-click would,
   *   and the next click starts a fresh one.
   */
  @callable()
  syncOrders(): Promise<Domain.OrdersSyncResult> {
    const shop = this.name;
    const runningImports = () =>
      this.getWorkflows({
        status: [...IMPORT_IN_FLIGHT],
        workflowName: ORDERS_SYNC_WORKFLOW_NAME,
      }).workflows;
    const deleteWorkflow = (workflowId: string) =>
      this.deleteWorkflow(workflowId);
    const refreshWorkflow = (workflowId: string) =>
      Effect.tryPromise(() =>
        this.getWorkflowStatus(ORDERS_SYNC_WORKFLOW_NAME, workflowId),
      ).pipe(
        Effect.catch((error) =>
          /**
           * `instance.not_found` is Cloudflare saying the instance is gone —
           * a lost callback whose instance has since passed the platform's
           * retention — and the row it left is the only thing disabling the
           * button, so it goes. Any other failure is an unreachable control
           * plane, which is not proof of absence: the row is left as it
           * stands and the next click asks again.
           */
          isWorkflowInstanceNotFoundError(error.cause)
            ? Effect.logWarning(
                `ShopAgent.syncOrders: shop=${shop} workflowId=${workflowId}: instance not found, untracking`,
              ).pipe(
                Effect.annotateLogs({ shop, workflowId }),
                Effect.andThen(Effect.sync(() => deleteWorkflow(workflowId))),
              )
            : Effect.logWarning(
                `ShopAgent.syncOrders: shop=${shop} workflowId=${workflowId}: status refresh failed: ${error.message}`,
              ).pipe(Effect.annotateLogs({ shop, workflowId })),
        ),
      );
    const startWorkflow = () =>
      Effect.tryPromise(() =>
        this.runWorkflow(
          ORDERS_SYNC_WORKFLOW_NAME,
          { shop } satisfies OrdersSyncParams,
          { agentBinding: SHOP_AGENT_BINDING },
        ),
      );
    const beginStarting = () => {
      this.importStarting = true;
    };
    const endStarting = () => {
      this.importStarting = false;
    };
    const starting = () => this.importStarting;
    const publish = () => this.publish("all");
    return this.runEffect(
      Effect.gen(function* () {
        // The one `@callable()` that takes no input, so it has no
        // `callableEffect` to carry the role check; the check is the same.
        yield* connectionRoleGuard("merchant");
        const repository = yield* OrderRepository;
        const now = yield* Clock.currentTimeMillis;
        const inFlight = Effect.fn("ShopAgent.syncOrders.inFlight")(
          function* () {
            const running = runningImports();
            const stale = running.filter(
              (row) => now - row.createdAt.getTime() >= IMPORT_STALE_MS,
            );
            if (stale.length === 0) return running.length > 0;
            yield* Effect.forEach(
              stale,
              (row) => refreshWorkflow(row.workflowId),
              { discard: true },
            );
            return runningImports().length > 0;
          },
        );
        if (starting() || (yield* inFlight())) {
          yield* Effect.logInfo(
            `ShopAgent.syncOrders: shop=${shop} status=in-flight`,
          ).pipe(Effect.annotateLogs({ shop, status: "in-flight" }));
          return { status: "in_flight" } satisfies Domain.OrdersSyncResult;
        }
        /**
         * The order ceiling: an import that would be refused order by order
         * should be refused once, visibly, before it starts. A stream that
         * crosses the ceiling mid-file is stopped per order by `upsertOrder`
         * instead, and the webhook path carries the same test for single
         * orders. No storage guard beside it: the import's fixed open-work
         * query is what bounds how much this object can take on.
         */
        const usage = yield* repository.getUsage();
        if (Domain.cycleAtOrderCeiling(usage.ordersThisCycle)) {
          yield* Effect.logError(
            `ShopAgent.syncOrders: shop=${shop} status=order-ceiling ordersThisCycle=${String(usage.ordersThisCycle)}`,
          ).pipe(
            Effect.annotateLogs({
              shop,
              status: "order-ceiling",
              ordersThisCycle: usage.ordersThisCycle,
            }),
          );
          yield* repository.setSyncError({
            error: `Baton is built for shops under ${Domain.ShopLimits.maxOrdersPerCycle.toLocaleString("en-US")} orders a billing period; importing resumes when the period ends.`,
          });
          yield* repository.markOrdersLimited(now);
          yield* publish();
          return { status: "refused" } satisfies Domain.OrdersSyncResult;
        }
        yield* repository.clearSyncError();
        const workflowId = yield* Effect.acquireUseRelease(
          Effect.sync(beginStarting),
          startWorkflow,
          () => Effect.sync(endStarting),
        );
        yield* Effect.logInfo(
          `ShopAgent.syncOrders: shop=${shop} status=started workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, status: "started", workflowId }));
        yield* publish();
        return { status: "started" } satisfies Domain.OrdersSyncResult;
      }).pipe(Effect.withLogSpan("ShopAgent.syncOrders")),
    );
  }

  /**
   * RPC target for the workflow, not `@callable()`: nothing browser-side calls
   * it, and it takes a URL that must only ever come from a bulk operation this
   * shop started.
   */
  onOrdersStream(input: { readonly url: string }): Promise<OrdersStreamCounts> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const reconciler = () => this.reconciler("bulk");
    const databaseSize = () => this.ctx.storage.sql.databaseSize;
    return this.runEffect(
      callableEffect("ShopAgent.onOrdersStream", OrdersStreamInput, {
        role: "rpc",
      })(({ url }) =>
        Effect.gen(function* () {
          // After the stream, never per order: a bulk import can queue
          // thousands of events, and the API takes one request each at 500 a
          // second, so the drain is batched (`ShopLimits.sweepBatch`) and the
          // remainder rides the next webhook. `ensuring`, because a stream
          // that fails halfway has already counted and queued every order it
          // stored, and those events are owed whatever became of the rest.
          const counts = yield* runShopAgentOrdersStream({
            url,
            afterWrite: yield* reconciler(),
          }).pipe(Effect.ensuring(flushUsageEvents(shop)));
          if (counts.ordersRefused > 0)
            yield* Effect.logError(
              `ShopAgent.onOrdersStream: shop=${shop} status=order-ceiling ordersRefused=${String(counts.ordersRefused)} limit=${String(Domain.ShopLimits.maxOrdersPerCycle)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                status: "order-ceiling",
                ordersRefused: counts.ordersRefused,
                limit: Domain.ShopLimits.maxOrdersPerCycle,
              }),
            );
          /**
           * The retention pass rides the import: it is merchant-triggered,
           * already the heaviest thing this object does, and the one moment
           * where paying for a batch of deletes is invisible next to what the
           * request is doing anyway.
           */
          const swept = yield* (yield* OrderRepository).sweepExpiredOrders({
            now: yield* Clock.currentTimeMillis,
          });
          const size = databaseSize();
          yield* Effect.logInfo(
            `ShopAgent.onOrdersStream: shop=${shop} ordersSeen=${String(counts.ordersSeen)} ordersUpserted=${String(counts.ordersUpserted)} ordersInserted=${String(counts.ordersInserted)} ordersRefused=${String(counts.ordersRefused)} lineItemsUpserted=${String(counts.lineItemsUpserted)} ordersTruncated=${String(counts.ordersTruncated)} sweptOrders=${String(swept.orders)} sweptRuns=${String(swept.runs)} databaseSize=${String(size)}`,
          ).pipe(
            Effect.annotateLogs({
              shop,
              ...counts,
              sweptOrders: swept.orders,
              sweptRuns: swept.runs,
              databaseSize: size,
            }),
          );
          yield* publish();
          return counts;
        }),
      )(input),
    );
  }

  /**
   * The window held no orders. Deliberately does not touch stored rows: unlike
   * a catalog scan, an empty window means "nothing changed", never "the shop
   * has no orders".
   */
  onOrdersSyncEmpty(): Promise<void> {
    const shop = this.name;
    return this.runEffect(
      Effect.logInfo(`ShopAgent.onOrdersSyncEmpty: shop=${shop}`).pipe(
        Effect.annotateLogs({ shop }),
        Effect.withLogSpan("ShopAgent.onOrdersSyncEmpty"),
      ),
    );
  }

  /**
   * The workflow's durable error sink, reached before the failure propagates,
   * so the merchant-facing message survives even if the callback that follows
   * never arrives. {@link ShopAgent.onWorkflowError} writes the same column
   * from the platform's own account of the failure; whichever lands last
   * wins, and they say the same thing.
   */
  onOrdersSyncError(input: { readonly message: string }): Promise<void> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect("ShopAgent.onOrdersSyncError", OrdersSyncErrorInput, {
        role: "rpc",
      })(({ message }) =>
        Effect.gen(function* () {
          yield* Effect.logError(
            `ShopAgent.onOrdersSyncError: shop=${shop}: ${message}`,
          ).pipe(Effect.annotateLogs({ shop, message }));
          yield* (yield* OrderRepository).setSyncError({ error: message });
          yield* publish();
        }),
      )(input),
    );
  }

  /**
   * Completion is recorded here rather than at the end of the stream: a file
   * that streams halfway and then fails must not leave a timestamp claiming
   * an import completed. The workflow reports no result — there is nothing
   * about the run the object does not already know — so nothing is decoded.
   */
  override async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
  ): Promise<void> {
    if (workflowName !== ORDERS_SYNC_WORKFLOW_NAME) return;
    const shop = this.name;
    const deleteWorkflow = () => this.deleteWorkflow(workflowId);
    const publish = () => this.publish("all");
    await this.runEffect(
      Effect.gen(function* () {
        yield* (yield* OrderRepository).setLastCompletedAt({
          now: yield* Clock.currentTimeMillis,
        });
        yield* Effect.logInfo(
          `ShopAgent.onWorkflowComplete: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        yield* Effect.sync(deleteWorkflow);
        yield* publish();
      }).pipe(Effect.withLogSpan("ShopAgent.onWorkflowComplete")),
    );
  }

  /**
   * Deleting the tracking row is what re-enables the button: it is the only
   * record that an import is running ({@link ShopAgent.syncOrders}), so a row
   * left behind by a failed run would wedge it until the staleness refresh.
   */
  override async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    if (workflowName !== ORDERS_SYNC_WORKFLOW_NAME) return;
    const shop = this.name;
    const deleteWorkflow = () => this.deleteWorkflow(workflowId);
    const publish = () => this.publish("all");
    await this.runEffect(
      Effect.gen(function* () {
        yield* Effect.logError(
          `ShopAgent.onWorkflowError: shop=${shop} workflowId=${workflowId}: ${error}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, error }));
        yield* (yield* OrderRepository).setSyncError({ error });
        yield* Effect.sync(deleteWorkflow);
        yield* publish();
      }).pipe(Effect.withLogSpan("ShopAgent.onWorkflowError")),
    );
  }

  /**
   * The webhook path. Not `@callable()` — it is reached only from
   * `/webhooks/orders`, after HMAC validation.
   *
   * Two guards make an unordered, retried, at-least-once delivery channel
   * idempotent: the `X-Shopify-Webhook-Id` log rejects a redelivery outright,
   * and the payload's `updated_at` skips a fetch that could only produce an
   * older view than the one already stored. The upsert's own guard is the
   * third, and the only one that survives two paths writing at once.
   *
   * The topic is a log field and nothing else: `reconcileOrder` works from the
   * fetched order, not from what knocked, which is why every subscribed topic
   * arrives here and why an out-of-order delivery is still correct.
   */
  syncOrder(input: OrderWebhookInput): Promise<void> {
    const shop = this.name;
    /**
     * Scoped by team as well as by order: the union of the teams with an open
     * task on the order before and after the reconcile, because a reconcile
     * can take a team's last task away (a cancelled line, a dropped quantity)
     * as readily as give one, and the team losing it is only nameable before.
     * An order no team owns a task on either side publishes to *no* member —
     * the empty list is the intended answer, not a missing one — while the
     * merchant's pages still see their order's id.
     */
    const teamsOf = (orderId: string) => orderTeamIds({ orderId });
    const publish = (orderId: string, teams: PublishTeams) =>
      this.publish([orderId], teams);
    const fetchAndUpsert = (orderId: string) =>
      this.fetchAndUpsertOrder(orderId, "webhook");
    return this.runEffect(
      callableEffect("ShopAgent.syncOrder", OrderWebhookInput, { role: "rpc" })(
        ({ orderId, topic, webhookId, triggeredAt, updatedAt }) =>
          Effect.gen(function* () {
            const repository = yield* OrderRepository;
            const isNew = yield* repository.recordWebhookDelivery({
              webhookId,
              topic,
              orderId,
              triggeredAt,
              receivedAt: yield* Clock.currentTimeMillis,
            });
            if (!isNew) {
              yield* Effect.logInfo(
                `ShopAgent.syncOrder: shop=${shop} topic=${topic} status=duplicate`,
              ).pipe(
                Effect.annotateLogs({
                  shop,
                  topic,
                  webhookId,
                  status: "duplicate",
                }),
              );
              return;
            }
            const stored = yield* repository.getOrderUpdatedAt(orderId);
            if (
              updatedAt !== null &&
              Option.isSome(stored) &&
              updatedAt <= stored.value
            ) {
              yield* Effect.logInfo(
                `ShopAgent.syncOrder: shop=${shop} topic=${topic} status=stale`,
              ).pipe(
                Effect.annotateLogs({ shop, topic, orderId, status: "stale" }),
              );
              return;
            }
            /**
             * The enterprise ceiling, and the only hard stop on orders. It
             * gates *new* orders only — `getOrderUpdatedAt` answering none is
             * what makes it one — so every order already on the production
             * floor keeps receiving its updates. The webhook still returns
             * 2xx: a retry cannot change the answer, and making Shopify replay
             * a delivery for four hours to reach the same refusal helps nobody.
             *
             * The publish is a nudge, not the banner: the merchant's open
             * orders page refetches its list, and the critical banner itself
             * arrives with that page's next loader read, since usage is
             * deliberately loader-only (`Domain.OrdersIndexLoaderData`).
             */
            // One read serves both the ceiling and the sweep below: the row
            // is the same one, and this is the webhook path, where every
            // avoidable read is paid per delivery.
            const usage = yield* repository.getUsage();
            if (
              Option.isNone(stored) &&
              Domain.cycleAtOrderCeiling(usage.ordersThisCycle)
            ) {
              yield* repository.markOrdersLimited(
                yield* Clock.currentTimeMillis,
              );
              yield* Effect.logError(
                `ShopAgent.syncOrder: shop=${shop} topic=${topic} status=order-ceiling limit=${String(Domain.ShopLimits.maxOrdersPerCycle)}`,
              ).pipe(
                Effect.annotateLogs({
                  shop,
                  topic,
                  orderId,
                  status: "order-ceiling",
                  limit: Domain.ShopLimits.maxOrdersPerCycle,
                }),
              );
              yield* publish(orderId, []);
              return;
            }
            const before = yield* teamsOf(orderId);
            yield* fetchAndUpsert(orderId);
            /**
             * The second retention carrier, rate-limited by `lastSweepAt`
             * rather than run on every delivery: a busy shop must not pay for
             * a batch of deletes per webhook. The `ShopUsage` row it reads is
             * the one the ceiling already read above, so the rate limit costs
             * nothing extra per delivery.
             *
             * With the import, this is the whole of when orders age out.
             * There is no alarm, so a shop that receives no webhooks and runs
             * no import never sweeps — which is correct rather than a gap: it
             * is also a shop that is not growing, and its rows sit inert
             * until uninstall destroys the object
             * ({@link Domain.ShopLimits.orderRetentionDays}).
             */
            const now = yield* Clock.currentTimeMillis;
            if (
              usage.lastSweepAt === null ||
              now - usage.lastSweepAt >= Domain.ShopLimits.sweepIntervalMs
            ) {
              const swept = yield* repository.sweepExpiredOrders({ now });
              if (swept.orders > 0 || swept.runs > 0)
                yield* Effect.logInfo(
                  `ShopAgent.syncOrder: shop=${shop} sweptOrders=${String(swept.orders)} sweptRuns=${String(swept.runs)}`,
                ).pipe(
                  Effect.annotateLogs({
                    shop,
                    sweptOrders: swept.orders,
                    sweptRuns: swept.runs,
                  }),
                );
            }
            yield* publish(
              orderId,
              unionTeams(before, yield* teamsOf(orderId)),
            );
            // Outside the upsert's transaction, because it does network I/O
            // and Durable Object SQLite transactions must not await anything
            // but storage. The webhook path is the outbox's ordinary carrier:
            // an order that queued an event flushes it, and a shop still
            // syncing drains whatever earlier events failed.
            yield* flushUsageEvents(shop);
          }),
      )(input),
    );
  }

  /**
   * What the Worker compares against the shop's plan: the object counts, the
   * Worker owns the ceilings ({@link Domain.Entitlements}). `@callable()` so
   * the `/app` socket can read it, and on `ShopAgentClient` so loaders can.
   *
   * The stored row is authoritative and nothing is rolled forward in the
   * returned value: the cycle boundary is Shopify's, not a clock this object
   * can read, and the counting path
   * (`OrderRepository.upsertOrder`) is the one place that may move it. A shop
   * whose cycle has ended but has synced nothing since shows the finished
   * cycle's count until either an order or a plan revalidation arrives —
   * which is the truth, because Shopify has not billed the next period yet
   * either.
   */
  @callable()
  getUsage(): Promise<Domain.ShopUsage> {
    const databaseSize = () => this.ctx.storage.sql.databaseSize;
    return this.runEffect(
      Effect.gen(function* () {
        yield* connectionRoleGuard("merchant");
        return {
          ...(yield* (yield* OrderRepository).getUsage()),
          databaseSize: databaseSize(),
        } satisfies Domain.ShopUsage;
      }).pipe(Effect.withLogSpan("ShopAgent.getUsage")),
    );
  }

  /**
   * Records the shop's billing period. Plain RPC, not `@callable()`: the
   * caller is `SubscriptionPlan`, which is the only thing that reads an App
   * Pricing contract, and a browser naming its own billing period would be
   * naming its own bill.
   *
   * Does not flush, though a new cycle queues its first seat event: the
   * revalidation reconciles next, against meter readings taken before this
   * push, and a flush here would drain the pending units that explain the
   * gap. {@link reconcileUsage} flushes after its check.
   */
  setBillingCycle(
    input: typeof Domain.BillingCycleInput.Encoded,
  ): Promise<void> {
    return this.runEffect(
      callableEffect("ShopAgent.setBillingCycle", Domain.BillingCycleInput, {
        role: "rpc",
      })((cycle) =>
        Effect.gen(function* () {
          yield* (yield* OrderRepository).setBillingCycle(cycle);
        }),
      )(input),
    );
  }

  /**
   * Reports the D1 roster size after a member add, which raises the cycle's
   * seat mark and queues the rise (`OrderRepository.recordRoster`), then
   * flushes. Plain RPC for the same reason as {@link setBillingCycle}: the
   * caller is the Worker's add-member action, and the roster is D1's, so the
   * object cannot count it. Answers the units queued.
   */
  recordRoster(
    input: typeof Domain.RecordRosterInput.Encoded,
  ): Promise<number> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.recordRoster", Domain.RecordRosterInput, {
        role: "rpc",
      })((roster) =>
        Effect.gen(function* () {
          const queued = yield* (yield* OrderRepository).recordRoster(
            roster,
            yield* Clock.currentTimeMillis,
          );
          yield* flushUsageEvents(shop);
          return queued;
        }),
      )(input),
    );
  }

  /**
   * Stores Shopify's meter readings beside the local counts and logs each
   * meter whose two disagree by more than the outbox can explain. Plain RPC
   * for the same reason as {@link setBillingCycle}. Orders compare
   * `ordersThisCycle`, members compare `membersHighWater`, each by
   * {@link Domain.meterDiverges}.
   *
   * Nothing is corrected. The App Events API answers `202` to an event it will
   * later refuse, so a divergence is the *only* evidence that a shop's usage
   * is not being billed, and quietly moving the local number to match would
   * erase it.
   *
   * Flushes after the check, not before: the readings predate anything sent
   * now, so the check needs the pending units still queued. This is what
   * sends a new cycle's first seat event without waiting for the next order
   * or member add, and what first sends events queued before the shop had a
   * `shopGid`.
   */
  reconcileUsage(
    input: typeof Domain.ReconcileUsageInput.Encoded,
  ): Promise<void> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.reconcileUsage", Domain.ReconcileUsageInput, {
        role: "rpc",
      })((readings) =>
        Effect.gen(function* () {
          const usage = yield* (yield* OrderRepository).reconcileUsage(
            readings,
          );
          const meters = [
            {
              meter: Domain.USAGE_METER_ORDER,
              local: usage.ordersThisCycle,
              shopify: readings.orders,
              pending: usage.pendingOrderUnits,
            },
            {
              meter: Domain.USAGE_METER_MEMBER,
              local: usage.membersHighWater,
              shopify: readings.members,
              pending: usage.pendingMemberUnits,
            },
          ];
          for (const { meter, local, shopify, pending } of meters)
            if (
              shopify !== null &&
              Domain.meterDiverges({ local, shopify, pending })
            )
              yield* Effect.logWarning(
                `ShopAgent.reconcileUsage: shop=${shop} meter=${meter} local=${String(local)} shopify=${String(shopify)} pending=${String(pending)}: metered usage diverges`,
              ).pipe(
                Effect.annotateLogs({ shop, meter, local, shopify, pending }),
              );
          yield* flushUsageEvents(shop);
        }),
      )(input),
    );
  }

  /**
   * Drains the usage-event outbox and answers how many rows are left. Plain
   * RPC: the caller is the uninstall webhook, which has 24 hours before Shopify
   * closes the billing period and is about to destroy this object's storage.
   */
  flushUsageEvents(): Promise<number> {
    const shop = this.name;
    return this.runEffect(
      Effect.gen(function* () {
        yield* connectionRoleGuard("rpc");
        const flush = yield* flushUsageEvents(shop);
        return flush.remaining;
      }).pipe(Effect.withLogSpan("ShopAgent.flushUsageEvents")),
    );
  }

  /**
   * `@callable()` and it does take an argument, unlike {@link syncOrders} — but
   * the id is only ever spent against this shop's own offline session, so a
   * foreign one fails at Shopify rather than reaching another shop's data. No
   * dedupe and no staleness check: a merchant clicking Resync is asking for the
   * fetch, and the upsert guard still protects the row.
   */
  @callable()
  resyncOrder(input: Domain.ResyncOrderInput): Promise<void> {
    const publish = (touched: PublishScope) => this.publish(touched);
    const fetchAndUpsert = (orderId: string) =>
      this.fetchAndUpsertOrder(orderId, "manual");
    return this.runEffect(
      callableEffect("ShopAgent.resyncOrder", Domain.ResyncOrderInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ orderId }) =>
        Effect.gen(function* () {
          yield* fetchAndUpsert(orderId);
          yield* publish([orderId]);
        }),
      )(input),
    );
  }

  private readOrders({
    limit,
    cursor,
    q,
    status,
    need,
    team,
  }: Domain.ListOrdersInput) {
    const readTeams = () => this.teams();
    /**
     * Read, never refreshed: this is the loader half of a page and must not
     * reach the Workflows API. A row wedged by a dead instance is cleared by
     * the next click ({@link ShopAgent.syncOrders}), which is also the only
     * place the merchant can be waiting on the answer.
     */
    const importInFlight = () =>
      this.getWorkflows({
        status: [...IMPORT_IN_FLIGHT],
        workflowName: ORDERS_SYNC_WORKFLOW_NAME,
      }).workflows.length > 0;
    return Effect.gen(function* () {
      const repository = yield* OrderRepository;
      /* One roster read for both consumers: the repository derives
         `attention` and `waitingOn` from it, and the view carries it so the
         route can name the ids it gets back. */
      const teams = yield* readTeams();
      return {
        page: yield* repository.listOrders({
          limit,
          cursor,
          q,
          status,
          need,
          team,
          teams,
        }),
        syncState: {
          inFlight: importInFlight(),
          ...(yield* repository.getSyncState()),
        },
        teams,
      } satisfies Domain.OrdersView;
    });
  }

  /**
   * Plain RPC, not `@callable()`: the loader half of the orders index, read
   * through `ShopAgentClient` so the first page paints during SSR. The socket
   * half is {@link subscribeOrders}, the same read plus the subscription.
   */
  listOrders(input: Domain.ListOrdersInput): Promise<Domain.OrdersView> {
    return this.runEffect(
      callableEffect("ShopAgent.listOrders", Domain.ListOrdersInput, {
        role: "rpc",
      })((input) => this.readOrders(input))(input),
    );
  }

  /**
   * The orders view's `subscribe<Feature>` method — reads the page and
   * subscribes the calling connection in one round trip. Combining the read and
   * subscription prevents a write between separate calls from being missed.
   * `orderId: null` subscribes to every order-state push.
   */
  @callable()
  subscribeOrders(
    input: Domain.SubscribeOrdersInput,
  ): Promise<Domain.OrdersView> {
    const readOrders = (input: Domain.ListOrdersInput) =>
      this.readOrders(input);
    return this.runEffect(
      callableEffect("ShopAgent.subscribeOrders", Domain.SubscribeOrdersInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ subscriberId, ...input }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection)
            setSubscription(connection, { subscriberId, orderId: null });
          return yield* readOrders(input);
        }),
      )(input),
    );
  }

  /**
   * Plain RPC, not `@callable()`: workflow definitions are configuration, so
   * `/app/workflows` reads them through its loader via `ShopAgentClient` (the
   * loader-versus-socket rule documented there). Only the mutations stay on
   * the socket.
   */
  listWorkflows(): Promise<readonly Domain.WorkflowSummary[]> {
    const teams = () => this.teams();
    return this.runEffect(
      Effect.gen(function* () {
        return yield* (yield* WorkflowRepository).listWorkflows({
          teams: yield* teams(),
        });
      }).pipe(Effect.withLogSpan("ShopAgent.listWorkflows")),
    );
  }

  /**
   * `getWorkflowDetail`, not `getWorkflow`: the Agents SDK base class already
   * has a `getWorkflow(workflowId)` that tracks Cloudflare Workflow instances.
   *
   * Joins team names from D1 inside the object rather than in a server fn: the
   * runtime already holds `Repository`, and one round trip returns the tasks,
   * their resolved team names and member counts, and the roster the picker
   * needs. Both attention states are derived here and never stored: a task
   * whose `teamId` is null or names no team resolves to `teamName: null`
   * (unassigned — warned, never blocked in the editor, since the risk is
   * when a run starts); a task on a team with no members carries
   * `memberCount: 0`. Assigning a team or adding a member clears either with
   * no other write.
   *
   * Plain RPC, not `@callable()`, for the reason on {@link listWorkflows}.
   */
  getWorkflowDetail(
    input: typeof Domain.WorkflowIdInput.Encoded,
  ): Promise<Domain.WorkflowDetailView | null> {
    const teams = () => this.teams();
    return this.runEffect(
      callableEffect("ShopAgent.getWorkflowDetail", Domain.WorkflowIdInput, {
        role: "rpc",
        parse: { onExcessProperty: "error" },
      })(({ workflowId }) =>
        Effect.gen(function* () {
          const repository = yield* WorkflowRepository;
          const detail = yield* repository.getWorkflow({ workflowId });
          if (Option.isNone(detail)) return null;
          const roster = yield* teams();
          const teamOf = new Map(roster.map((team) => [team.id, team]));
          const withTeamNames = (
            tasks: readonly Domain.WorkflowTask[],
          ): Domain.TaskWithTeamName[] =>
            tasks.map((task) => {
              const team =
                task.teamId === null ? undefined : teamOf.get(task.teamId);
              return {
                ...task,
                teamName: team?.name ?? null,
                memberCount: team?.memberCount ?? null,
              };
            });
          return {
            workflow: detail.value.workflow,
            tasks: withTeamNames(detail.value.tasks),
            draft:
              detail.value.draft === null
                ? null
                : {
                    draft: detail.value.draft.draft,
                    tasks: withTeamNames(detail.value.draft.tasks),
                  },
            teams: roster,
          } satisfies Domain.WorkflowDetailView;
        }),
      )(input),
    );
  }

  @callable()
  createWorkflow(
    input: typeof Domain.CreateWorkflowInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    return this.runEffect(
      callableEffect("ShopAgent.createWorkflow", Domain.CreateWorkflowInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((input) =>
        workflowResult(
          WorkflowRepository.pipe(
            Effect.flatMap((repository) => repository.createWorkflow(input)),
          ),
        ),
      )(input),
    );
  }

  /** Duplicate: the copy is off, keeps the tasks, and takes the name and tag the dialog collected (`WorkflowRepository.duplicateWorkflow`). */
  @callable()
  duplicateWorkflow(
    input: typeof Domain.DuplicateWorkflowInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect(
        "ShopAgent.duplicateWorkflow",
        Domain.DuplicateWorkflowInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ workflowId, name, tag }) =>
        workflowResult(
          Effect.gen(function* () {
            const copy = yield* (yield* WorkflowRepository).duplicateWorkflow({
              workflowId,
              name,
              tag,
            });
            yield* Effect.logInfo(
              `ShopAgent.duplicateWorkflow: shop=${shop} workflowId=${workflowId} copyId=${copy.id}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId, copyId: copy.id }));
            return copy;
          }),
        ),
      )(input),
    );
  }

  @callable()
  updateWorkflow(
    input: typeof Domain.UpdateWorkflowInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    return this.runEffect(
      callableEffect("ShopAgent.updateWorkflow", Domain.UpdateWorkflowInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId, name }) =>
        workflowResult(
          WorkflowRepository.pipe(
            Effect.flatMap((repository) =>
              repository.updateWorkflow({ workflowId, name }),
            ),
          ),
        ),
      )(input),
    );
  }

  /**
   * Immediate, like `updateWorkflow`: lands on the workflow row, never the
   * draft. Unlike a rename it changes how the workflow matches, so an on
   * workflow reconciles every stored order once afterwards, as Apply does:
   * an order already in Baton whose product carries the new tag starts now,
   * not on Shopify's next edit. Runs in flight snapshot their tag and tasks
   * and are untouched. Publishes because the order pages read the reconcile.
   */
  @callable()
  updateWorkflowTag(
    input: typeof Domain.UpdateWorkflowTagInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAllIfActive("updateWorkflowTag", workflow);
    return this.runEffect(
      callableEffect(
        "ShopAgent.updateWorkflowTag",
        Domain.UpdateWorkflowTagInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ workflowId, tag }) =>
        workflowResult(
          Effect.gen(function* () {
            const workflow =
              yield* (yield* WorkflowRepository).updateWorkflowTag({
                workflowId,
                tag,
              });
            yield* Effect.logInfo(
              `ShopAgent.updateWorkflowTag: shop=${shop} workflowId=${workflowId} tag=${tag}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId, tag }));
            yield* reconcileAll(workflow);
            return workflow;
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  /** Edit: creates the draft (or returns the existing one). */
  @callable()
  createDraft(
    input: typeof Domain.CreateDraftInput.Encoded,
  ): Promise<Domain.DraftResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.createDraft", Domain.CreateDraftInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId }) =>
        draftResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const draft = yield* repository.createDraft({ workflowId });
            yield* Effect.logInfo(
              `ShopAgent.createDraft: shop=${shop} workflowId=${workflowId}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId }));
            return { _tag: "Ok", draft } satisfies Domain.DraftResult;
          }),
        ),
      )(input),
    );
  }

  /**
   * Apply changes. On an on workflow, reconciles every stored order once
   * afterwards: new tasks can make an item startable that was not, and those
   * orders should start now rather than at whatever moment Shopify next edits
   * them. Publishes because the next order starts against the new tasks,
   * which the order page's workflow pickers reflect.
   */
  @callable()
  applyDraft(
    input: typeof Domain.ApplyDraftInput.Encoded,
  ): Promise<Domain.ApplyResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const teams = () => this.teams();
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAllIfActive("applyDraft", workflow);
    return this.runEffect(
      callableEffect("ShopAgent.applyDraft", Domain.ApplyDraftInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId }) =>
        applyResult(
          Effect.gen(function* () {
            const workflow = yield* (yield* WorkflowRepository).applyDraft({
              workflowId,
              teams: yield* teams(),
            });
            yield* Effect.logInfo(
              `ShopAgent.applyDraft: shop=${shop} workflowId=${workflowId}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId }));
            yield* reconcileAll(workflow);
            return workflow;
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  @callable()
  discardDraft(
    input: typeof Domain.DiscardDraftInput.Encoded,
  ): Promise<Domain.DiscardResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.discardDraft", Domain.DiscardDraftInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId }) =>
        discardResult(
          Effect.gen(function* () {
            const workflow = yield* (yield* WorkflowRepository).discardDraft({
              workflowId,
            });
            yield* Effect.logInfo(
              `ShopAgent.discardDraft: shop=${shop} workflowId=${workflowId}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId }));
            return workflow;
          }),
        ),
      )(input),
    );
  }

  /**
   * The on/off switch. On writes `activatedAt` (now, or the earlier date the
   * dialog chose); off nulls it. Either way every stored order is reconciled
   * once, so anything that now qualifies starts here rather than at whatever
   * moment Shopify next edits it — and off qualifies things too, because
   * removing one of two matching workflows resolves an ambiguity and starts
   * the survivor (see {@link reconcileAllNow}). Publishes for the reason on
   * {@link applyDraft}.
   */
  @callable()
  setWorkflowActive(
    input: typeof Domain.SetWorkflowActiveInput.Encoded,
  ): Promise<Domain.ActivateResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const teams = () => this.teams();
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAllNow("setWorkflowActive", workflow.id);
    return this.runEffect(
      callableEffect(
        "ShopAgent.setWorkflowActive",
        Domain.SetWorkflowActiveInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ workflowId, active, activatedAt }) =>
        activateResult(
          Effect.gen(function* () {
            const workflow =
              yield* (yield* WorkflowRepository).setWorkflowActive({
                workflowId,
                active,
                ...(activatedAt === undefined ? {} : { activatedAt }),
                teams: yield* teams(),
              });
            yield* Effect.logInfo(
              `ShopAgent.setWorkflowActive: shop=${shop} workflowId=${workflowId} active=${String(active)} activatedAt=${String(workflow.activatedAt)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                workflowId,
                active,
                activatedAt: workflow.activatedAt,
              }),
            );
            return { workflow, started: yield* reconcileAll(workflow) };
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  /**
   * The editor's Turn on for a workflow that has never been applied: applies
   * the draft and turns the switch on in one transaction, then reconciles
   * every stored order once, exactly as {@link setWorkflowActive} does — the
   * merchant made one decision, so a failure must leave the workflow
   * untouched rather than applied and off.
   */
  @callable()
  applyAndActivate(
    input: typeof Domain.ApplyAndActivateInput.Encoded,
  ): Promise<Domain.ActivateResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const teams = () => this.teams();
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAllNow("applyAndActivate", workflow.id);
    return this.runEffect(
      callableEffect(
        "ShopAgent.applyAndActivate",
        Domain.ApplyAndActivateInput,
        {
          role: "merchant",
          parse: { onExcessProperty: "error" },
        },
      )(({ workflowId, activatedAt }) =>
        activateResult(
          Effect.gen(function* () {
            const workflow =
              yield* (yield* WorkflowRepository).applyAndActivate({
                workflowId,
                ...(activatedAt === undefined ? {} : { activatedAt }),
                teams: yield* teams(),
              });
            yield* Effect.logInfo(
              `ShopAgent.applyAndActivate: shop=${shop} workflowId=${workflowId} activatedAt=${String(workflow.activatedAt)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                workflowId,
                activatedAt: workflow.activatedAt,
              }),
            );
            return { workflow, started: yield* reconcileAll(workflow) };
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  /** The workflow page's Change control: moves the coverage date, then reconciles every stored order once. */
  @callable()
  setWorkflowActivatedAt(
    input: typeof Domain.SetWorkflowActivatedAtInput.Encoded,
  ): Promise<Domain.ChangeActivatedAtResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAllIfActive("setWorkflowActivatedAt", workflow);
    return this.runEffect(
      callableEffect(
        "ShopAgent.setWorkflowActivatedAt",
        Domain.SetWorkflowActivatedAtInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ workflowId, activatedAt }) =>
        changeActivatedAtResult(
          Effect.gen(function* () {
            const workflow =
              yield* (yield* WorkflowRepository).setWorkflowActivatedAt({
                workflowId,
                activatedAt,
              });
            yield* Effect.logInfo(
              `ShopAgent.setWorkflowActivatedAt: shop=${shop} workflowId=${workflowId} activatedAt=${String(activatedAt)}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId, activatedAt }));
            return { workflow, started: yield* reconcileAll(workflow) };
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  /**
   * The Turn on dialog's count: read-only, no publish. The workflow is
   * usually off here, so it is read by id rather than from the active set.
   * `NotFound` is a count of zero: the dialog has nothing to add.
   */
  @callable()
  countWaitingOrders(
    input: typeof Domain.CountWaitingOrdersInput.Encoded,
  ): Promise<Domain.WaitingOrders> {
    const startContext = () => this.startContext();
    return this.runEffect(
      callableEffect(
        "ShopAgent.countWaitingOrders",
        Domain.CountWaitingOrdersInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ workflowId }) =>
        Effect.gen(function* () {
          const found = yield* (yield* WorkflowRepository).getWorkflow({
            workflowId,
          });
          if (Option.isNone(found))
            return { count: 0, earliestProcessedAt: null };
          return yield* (yield* RunRepository).countWaitingOrders({
            ...(yield* startContext()),
            workflow: {
              workflow: found.value.workflow,
              tasks: found.value.tasks,
            },
          });
        }),
      )(input),
    );
  }

  /**
   * Delete a workflow and its runs stay on their orders (vocabulary on
   * `Domain.Workflow`). `removeWorkflow`, not `deleteWorkflow`: the Agents
   * SDK base class already has a `deleteWorkflow(workflowId)` that drops a
   * Cloudflare Workflow instance's tracking row (`onWorkflowComplete` calls
   * it), the same collision `getWorkflowDetail` sidesteps. Publishes because
   * the workflows list and any order page's attach picker — which lists
   * workflows — must repaint.
   *
   * Reconciles afterwards for the same reason Turn off does: the deleted
   * workflow leaves the active set, so an item it made ambiguous now has one
   * match and the survivor's run starts.
   */
  @callable()
  removeWorkflow(
    input: typeof Domain.DeleteWorkflowInput.Encoded,
  ): Promise<Domain.DeleteWorkflowResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const reconcileAll = (workflowId: string) =>
      this.reconcileAllNow("removeWorkflow", workflowId);
    return this.runEffect(
      callableEffect("ShopAgent.removeWorkflow", Domain.DeleteWorkflowInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId }) =>
        Effect.gen(function* () {
          yield* (yield* WorkflowRepository).deleteWorkflow({ workflowId });
          yield* Effect.logInfo(
            `ShopAgent.removeWorkflow: shop=${shop} workflowId=${workflowId}`,
          ).pipe(Effect.annotateLogs({ shop, workflowId }));
          yield* reconcileAll(workflowId);
          yield* publish();
          return { _tag: "Deleted" } satisfies Domain.DeleteWorkflowResult;
        }).pipe(
          Effect.catchTags({
            WorkflowNotFoundError: () =>
              Effect.succeed<Domain.DeleteWorkflowResult>({ _tag: "NotFound" }),
          }),
        ),
      )(input),
    );
  }

  /**
   * The live D1 roster with member counts, read fresh on every call: it is
   * what every task pointer is resolved against (an id not in it is
   * unassigned) and what the empty-team warnings are computed from.
   */
  private teams() {
    const name = this.name;
    return Effect.gen(function* () {
      const teams = yield* (yield* Repository).listTeams({
        shop: yield* Schema.decodeUnknownEffect(Domain.Shop)(name),
      });
      return teams.map(({ id, name, memberCount }): Domain.TeamRoster => ({
        id,
        name,
        memberCount,
      }));
    });
  }

  /**
   * Loads what starting runs needs — every active definition with its tasks, and
   * the active team roster from D1 — *before* any transaction opens, and
   * returns a per-order effect the caller hands to `upsertOrder.afterWrite`.
   * The D1 read is the one await run creation needs that is not storage, and it
   * cannot happen inside the Durable Object transaction; loading once per
   * webhook or per bulk stream also bounds the cost for a thousand-order file,
   * at the accepted price of a snapshot that a mid-stream team delete would
   * not refresh.
   */
  private startContext() {
    const teams = () => this.teams();
    return Effect.gen(function* () {
      return {
        workflows:
          yield* (yield* WorkflowRepository).listActiveWorkflowDetails(),
        teams: yield* teams(),
      } satisfies StartContext;
    });
  }

  /**
   * Reconcile every stored open order once against the *current* active set,
   * so anything that now qualifies starts at this moment rather than at
   * whatever moment Shopify next edits it. Reconcile is an idempotent state
   * check, so running it over every order is safe; orders placed before
   * `activatedAt` are still excluded by the date rule. Not the write's
   * transaction: the repository owns that one and Durable Object SQLite
   * refuses to nest, but the Durable Object serialises callables so nothing
   * interleaves. Returns how many runs it created.
   *
   * Unconditional, because the active set shrinking starts runs too: one item
   * matched by two active workflows is ambiguous and carries no run, so
   * turning one of them off — or deleting it — leaves a single match and the
   * survivor's run begins. That is why {@link setWorkflowActive} and
   * {@link removeWorkflow} call this directly rather than through
   * {@link reconcileAllIfActive}, and why `ActivateResult.Ok.started` is
   * meaningful on Turn off.
   */
  private reconcileAllNow(caller: string, workflowId: string) {
    const shop = this.name;
    const startContext = () => this.startContext();
    return Effect.gen(function* () {
      const { orders, created, ambiguous } =
        yield* (yield* RunRepository).reconcileAll(yield* startContext());
      yield* Effect.logInfo(
        `ShopAgent.reconcileAll: shop=${shop} caller=${caller} workflowId=${workflowId} orders=${String(orders)} created=${String(created)} ambiguous=${String(ambiguous)}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          caller,
          workflowId,
          orders,
          created,
          ambiguous,
        }),
      );
      return created;
    });
  }

  /**
   * {@link reconcileAllNow}, skipped when the workflow is off: for the
   * definition writes (Apply, Edit tag, the coverage date) that change *how* a workflow
   * matches. An off workflow matches nothing either way, so nothing about the
   * active set moved and the pass would be a full scan for no writes. Turn
   * off and delete do move it, and use {@link reconcileAllNow}.
   */
  private reconcileAllIfActive(caller: string, workflow: Domain.Workflow) {
    const run = () => this.reconcileAllNow(caller, workflow.id);
    return Effect.gen(function* () {
      if (!Domain.isActive(workflow)) return 0;
      return yield* run();
    });
  }

  private reconciler(source: Domain.OrderSyncSource) {
    const shop = this.name;
    const startContext = () => this.startContext();
    return Effect.gen(function* () {
      const context = yield* startContext();
      const runs = yield* RunRepository;
      return (order: Domain.ShopOrder) =>
        runs.reconcileOrder({ ...context, orderId: order.id }).pipe(
          Effect.tap(({ created, resized, closed, ambiguous }) =>
            Effect.logInfo(
              `ShopAgent.reconcileOrder: shop=${shop} orderId=${order.id} source=${source} created=${String(created)} resized=${String(resized)} closed=${String(closed)} ambiguous=${String(ambiguous)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                orderId: order.id,
                source,
                created,
                resized,
                closed,
                ambiguous,
              }),
            ),
          ),
          Effect.asVoid,
        );
    });
  }

  /**
   * The detail page's `subscribe<Feature>` read: the order, its items, and
   * every run on them, and the calling connection subscribed to pushes in the
   * same round trip (the convention documented on `subscribeOrders`). Without
   * the attach, a webhook landing on the open order would update SQLite and
   * push to nobody. Addressed by `legacyId` because that is what the route
   * carries (see `Domain.SubscribeOrderInput`). `null` when the order is not
   * stored, which the page renders as not-found rather than as a failure.
   */
  private readOrderDetail({ legacyId }: Domain.GetOrderDetailInput) {
    const teams = () => this.teams();
    return Effect.gen(function* () {
      const orders = yield* OrderRepository;
      const runs = yield* RunRepository;
      const detail = yield* orders.getOrderByLegacyId(legacyId);
      if (Option.isNone(detail)) return null;
      const { order, lineItems } = detail.value;
      const repository = yield* WorkflowRepository;
      const workflows = yield* repository.listActiveWorkflowDetails();
      const roster = yield* teams();
      return {
        order,
        lineItems,
        runs: yield* runs.listRunsForOrder({ orderId: order.id }),
        teams: roster,
        itemWorkflows: workflows
          .filter(({ tasks }) => tasks.length > 0)
          .map(({ workflow }) => workflow),
      } satisfies Domain.OrderDetailView;
    });
  }

  /**
   * Plain RPC, not `@callable()`: the loader half of the order detail page,
   * as {@link listOrders} is for the index.
   */
  getOrderDetail(
    input: Domain.GetOrderDetailInput,
  ): Promise<Domain.OrderDetailView | null> {
    return this.runEffect(
      callableEffect("ShopAgent.getOrderDetail", Domain.GetOrderDetailInput, {
        role: "rpc",
      })((input) => this.readOrderDetail(input))(input),
    );
  }

  @callable()
  subscribeOrder(
    input: typeof Domain.SubscribeOrderInput.Encoded,
  ): Promise<Domain.OrderDetailView | null> {
    const readOrderDetail = (input: Domain.GetOrderDetailInput) =>
      this.readOrderDetail(input);
    return this.runEffect(
      callableEffect("ShopAgent.subscribeOrder", Domain.SubscribeOrderInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ subscriberId, ...input }) =>
        Effect.gen(function* () {
          const view = yield* readOrderDetail(input);
          /**
           * Subscribed after the read because the scope is the GID and the
           * route only carries the legacy id. An unstored order subscribes
           * index-wide (`null`): a later sync that stores it must reach this
           * page, and there is no GID to narrow to.
           */
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection)
            setSubscription(connection, {
              subscriberId,
              orderId: view?.order.id ?? null,
            });
          return view;
        }),
      )(input),
    );
  }

  /**
   * **Every run-write callable is named `<role><Verb>`, where the role is the
   * `Domain.ConnectionRole` allowed to call it.** The merchant acts through
   * the embedded admin session; a member through a member connection with
   * its team ids. The two paths load different context, so they are separate
   * callables rather than one with a role switch. Reads the connection tag
   * already scopes (`subscribeRuns`, `subscribeRun`) keep bare names.
   */
  @callable()
  merchantListRunsForOrder(
    input: typeof Domain.ListRunsForOrderInput.Encoded,
  ): Promise<readonly Domain.RunDetail[]> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantListRunsForOrder",
        Domain.ListRunsForOrderInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ orderId }) =>
        RunRepository.pipe(
          Effect.flatMap((repository) =>
            repository.listRunsForOrder({ orderId }),
          ),
        ),
      )(input),
    );
  }

  /**
   * Manual attach, read as **set this item's workflow**. It applies only the
   * definition half of the start predicate (`canStart`): an admin choosing a
   * workflow for an item by hand is exactly the override for a missing
   * tag, a fulfilled line, or an order placed before the workflow was turned
   * on. What it is not is an override of the order itself being over, which
   * is `Domain.orderIsOpen`.
   *
   * An item holds at most one run, so attaching over one is a replace: the
   * incumbent is deleted in the same transaction and comes back as
   * `replaced` for the toast. The same workflow again is `AlreadyExists`.
   * Over a closed run it is a fresh start, the closed workflow included, and
   * `replaced` is null (`Domain.RunStatus`). An item with no
   * units to make is `NothingToMake`, the same rule as `changeWorkflow` on
   * `Domain.runActions`. Confirmation is the UI's job, not this one's — the
   * server cannot know whether the merchant has seen the trail of work
   * already done on the run it is about to delete, and a server-side refusal
   * would leave the page with nothing to offer but the same click again.
   */
  @callable()
  merchantAttachWorkflow(
    input: typeof Domain.AttachWorkflowInput.Encoded,
  ): Promise<Domain.AttachResult> {
    const publish = (touched: PublishScope) => this.publish(touched);
    const teams = () => this.teams();
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantAttachWorkflow",
        Domain.AttachWorkflowInput,
        {
          role: "merchant",
          parse: { onExcessProperty: "error" },
        },
      )(({ lineItemId, workflowId }) =>
        Effect.gen(function* () {
          const target = yield* (yield* OrderRepository).getLineItem(
            lineItemId,
          );
          if (Option.isNone(target))
            return { _tag: "LineItemNotFound" } satisfies Domain.AttachResult;
          const workflows = yield* WorkflowRepository;
          const found = yield* workflows.getWorkflow({ workflowId });
          const roster = yield* teams();
          // Only the workflow's own tasks can start a run; a draft is never
          // attachable.
          const detail: Domain.WorkflowDetail | null = Option.isSome(found)
            ? { workflow: found.value.workflow, tasks: found.value.tasks }
            : null;
          if (detail === null || !canStart(detail, roster))
            return {
              _tag: "WorkflowCannotStart",
            } satisfies Domain.AttachResult;
          if (!Domain.orderIsOpen(target.value.order))
            return { _tag: "OrderClosed" } satisfies Domain.AttachResult;
          // The same rule as `changeWorkflow` ({@link Domain.runActions}), for
          // an item with no run too: nothing to make, nothing to start.
          if (Domain.unitsToMake(target.value.lineItem) === 0)
            return { _tag: "NothingToMake" } satisfies Domain.AttachResult;
          // Over a run this is Change workflow, gated like every run write
          // ({@link requireRunAction}); the only way `changeWorkflow` is
          // false on an open order is a done run. Over a closed run it is the
          // picker at rest, which the order gate above covers.
          const repository = yield* RunRepository;
          const incumbent = (yield* repository.listRunsForOrder({
            orderId: target.value.order.id,
          })).find(({ run }) => run.lineItemId === lineItemId);
          if (
            incumbent !== undefined &&
            !Domain.runIsClosed(incumbent.run) &&
            !Domain.runActions(
              MERCHANT,
              target.value.order,
              incumbent.run,
              Domain.runTaskViews(incumbent.run, incumbent.tasks),
              target.value.lineItem,
            ).changeWorkflow
          )
            return {
              _tag: "ItemDone",
              workflowName: incumbent.run.workflowName,
            } satisfies Domain.AttachResult;
          const set = yield* repository.setRun({
            workflow: detail,
            teams: roster,
            order: target.value.order,
            lineItem: target.value.lineItem,
            source: "manual",
          });
          if (Option.isNone(set))
            return { _tag: "AlreadyExists" } satisfies Domain.AttachResult;
          yield* publish([target.value.order.id]);
          return {
            _tag: "Ok",
            run: set.value.run,
            replaced: set.value.replaced,
          } satisfies Domain.AttachResult;
        }).pipe(
          Effect.catchTags({
            RunLimitError: ({ limit }) =>
              Effect.succeed<Domain.AttachResult>({ _tag: "RunLimit", limit }),
            RunNotOpenError: ({ workflowName }) =>
              Effect.succeed<Domain.AttachResult>({
                _tag: "ItemDone",
                workflowName,
              }),
          }),
        ),
      )(input),
    );
  }

  /**
   * Closes the run, reason `merchant_cancelled`
   * (`RunRepository.cancelRun`, rule on `Domain.RunStatus`). Gated by
   * `Domain.runActions` `cancel`, which is false on a closed order: reconcile
   * has already closed every open run there. The run leaves every team's
   * lists, so the publish reaches every team on the order.
   */
  @callable()
  merchantCancelRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (teams: PublishTeams) => this.publish("all", teams);
    return this.runEffect(
      callableEffect("ShopAgent.merchantCancelRun", Domain.RunIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runId }) =>
        Effect.gen(function* () {
          const teams = yield* orderTeamIds({ runId });
          const result = yield* runResult(
            Effect.gen(function* () {
              yield* requireRunAction(runId, MERCHANT, "cancel");
              yield* (yield* RunRepository).cancelRun({ runId });
              yield* Effect.logInfo(
                `ShopAgent.merchantCancelRun: shop=${shop} runId=${runId}`,
              ).pipe(Effect.annotateLogs({ shop, runId }));
            }),
          );
          if (result._tag === "Ok") yield* publish(teams);
          return result;
        }),
      )(input),
    );
  }

  /**
   * The merchant's task and block writes on a run, from the order page's
   * Manage drawer and block banner. Each is gated by {@link requireRunAction}
   * or {@link requireTaskAction} before the repository sees it. Separate methods rather than a role branch inside the member ones
   * because the role gate is declared *per method* — `CALLABLE_ROLES` in
   * `test/integration/shop-agent-callables.test.ts` enumerates the decorated
   * surface and fails the build for any callable whose audience was not
   * decided — and a single method admitting both populations would have to
   * re-derive that decision at runtime from the connection.
   *
   * Each builds `actor: { role: "merchant" }` and passes **no** `teamIds`,
   * which is the entire permission difference (`Domain.MarkTaskDoneCommand`):
   * the task's team need not be one of the caller's, because the merchant has
   * none, and an unassigned task is exactly the case they are here to fix.
   * Step order, the run's status, and the downstream reopen guard still apply.
   *
   * They publish with {@link publishToTeams}, not `publish("all")`: the
   * merchant's own order page is subscribed by order and the workers by team,
   * and the team fan-out for the touched order already reaches both. There is
   * no merchant Start: "started" records that a worker picked the task up,
   * and a merchant marking it started on their behalf would put a name on
   * work nobody has begun. The merchant either marks it done outright or leaves
   * it for the team.
   *
   * No member id in the log line: there isn't one.
   */
  @callable()
  merchantMarkTaskDone(
    input: typeof Domain.MarkTaskDoneInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runTaskId: string) => this.publishToTeams({ runTaskId });
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantMarkTaskDone",
        Domain.MarkTaskDoneInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ runTaskId }) =>
        runResult(
          Effect.gen(function* () {
            yield* requireTaskAction(runTaskId, MERCHANT, ({ done }) => done);
            yield* (yield* RunRepository).markTaskDone({
              runTaskId,
              actor: { role: "merchant" },
            } satisfies Domain.MarkTaskDoneCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantMarkTaskDone: shop=${shop} task=${runTaskId}`,
            ).pipe(Effect.annotateLogs({ shop, task: runTaskId }));
          }),
        ).pipe(Effect.tap(() => publish(runTaskId))),
      )(input),
    );
  }

  @callable()
  merchantReopenTask(
    input: typeof Domain.ReopenTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runTaskId: string) => this.publishToTeams({ runTaskId });
    return this.runEffect(
      callableEffect("ShopAgent.merchantReopenTask", Domain.ReopenTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runTaskId }) =>
        runResult(
          Effect.gen(function* () {
            yield* requireTaskAction(
              runTaskId,
              MERCHANT,
              ({ reopen }) => reopen !== null,
            );
            yield* (yield* RunRepository).reopenTask({
              runTaskId,
              actor: { role: "merchant" },
            } satisfies Domain.ReopenTaskCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantReopenTask: shop=${shop} task=${runTaskId}`,
            ).pipe(Effect.annotateLogs({ shop, task: runTaskId }));
          }),
        ).pipe(Effect.tap(() => publish(runTaskId))),
      )(input),
    );
  }

  /** Put back from the order page; the rule is on `RunRepository.putBackTask`. */
  @callable()
  merchantPutBackTask(
    input: typeof Domain.PutBackTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runTaskId: string) => this.publishToTeams({ runTaskId });
    return this.runEffect(
      callableEffect("ShopAgent.merchantPutBackTask", Domain.PutBackTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runTaskId }) =>
        runResult(
          Effect.gen(function* () {
            yield* requireTaskAction(
              runTaskId,
              MERCHANT,
              ({ putBack }) => putBack,
            );
            yield* (yield* RunRepository).putBackTask({
              runTaskId,
              actor: { role: "merchant" },
            } satisfies Domain.PutBackTaskCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantPutBackTask: shop=${shop} task=${runTaskId}`,
            ).pipe(Effect.annotateLogs({ shop, task: runTaskId }));
          }),
        ).pipe(Effect.tap(() => publish(runTaskId))),
      )(input),
    );
  }

  /** The note itself never reaches the log line, as on the member's {@link memberSetRunNote}. */
  @callable()
  merchantSetRunNote(
    input: typeof Domain.SetRunNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      callableEffect("ShopAgent.merchantSetRunNote", Domain.SetRunNoteInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runId, note }) =>
        runResult(
          Effect.gen(function* () {
            yield* requireRunAction(runId, MERCHANT, "note");
            yield* (yield* RunRepository).setRunNote({
              runId,
              note,
            } satisfies Domain.SetRunNoteCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantSetRunNote: shop=${shop} runId=${runId}`,
            ).pipe(Effect.annotateLogs({ shop, runId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  merchantBlockRun(
    input: typeof Domain.BlockRunInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      callableEffect("ShopAgent.merchantBlockRun", Domain.BlockRunInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runId, reason }) =>
        runResult(
          Effect.gen(function* () {
            yield* requireRunAction(runId, MERCHANT, "block");
            yield* (yield* RunRepository).blockRun({
              runId,
              actor: { role: "merchant" },
              reason,
            } satisfies Domain.BlockRunCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantBlockRun: shop=${shop} runId=${runId}`,
            ).pipe(Effect.annotateLogs({ shop, runId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  merchantSetBlockReason(
    input: typeof Domain.SetBlockReasonInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantSetBlockReason",
        Domain.SetBlockReasonInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ runId, reason }) =>
        runResult(
          Effect.gen(function* () {
            yield* requireRunAction(runId, MERCHANT, "editReason");
            yield* (yield* RunRepository).setBlockReason({
              runId,
              reason,
            } satisfies Domain.SetBlockReasonCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantSetBlockReason: shop=${shop} runId=${runId}`,
            ).pipe(Effect.annotateLogs({ shop, runId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  merchantUnblockRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      callableEffect("ShopAgent.merchantUnblockRun", Domain.RunIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runId }) =>
        runResult(
          Effect.gen(function* () {
            yield* requireRunAction(runId, MERCHANT, "unblock");
            yield* (yield* RunRepository).unblockRun({
              runId,
            } satisfies Domain.UnblockRunCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantUnblockRun: shop=${shop} runId=${runId}`,
            ).pipe(Effect.annotateLogs({ shop, runId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  /**
   * Member-area methods. Two idioms, split by whether the call has a socket:
   *
   * `listRuns` stays plain RPC, not `@callable()`. It is the run list's
   * loader read and paints during SSR, where there is no connection to carry
   * an identity, so `teamIds` arrives from `requireMember` through
   * `ShopAgentClient` exactly as before. Decoded lax: the caller is the
   * Worker, not a browser.
   *
   * The `member*` writes below are `@callable()` on the member socket. Their
   * privileged inputs — `memberId`, `memberEmail`, `teamIds` — come from
   * `Domain.ConnectionState` on the connection the Worker's gate authorized,
   * never from the message, so the browser sends only what it clicked. That is
   * the same guarantee the server-function path gave (the Worker resolved
   * them), reached a different way: `memberCallableEffect` proves the role and
   * hands the identity to the handler, and the wire input is decoded strict.
   */
  /**
   * A publish scoped to the teams a member's write could have changed the
   * run list of — see `publish`. The read is one indexed query against the
   * object's own SQLite, and it runs after the write so a task that just
   * became current for another team is included.
   */
  private publishToTeams(
    target:
      | { readonly runTaskId: string }
      | { readonly runId: string }
      | { readonly orderId: string },
    touched: PublishScope = "all",
  ) {
    return orderTeamIds(target).pipe(
      Effect.flatMap((teams) => this.publish(touched, teams)),
    );
  }

  /**
   * No D1 read: `startedByEmail` is a snapshot on the row, so the list reads
   * the same after the member is deleted. Every half of `Domain.RunListView`
   * comes from one call so the loader and the socket paint one snapshot: the
   * strip and the list under it are never two reads that can disagree.
   *
   * The Recent count is read on every tab (`listRecent` with `limit: 0`
   * counts without reading rows) because the strip shows it whatever is
   * open; its rows are read only when `query.tab` is "done".
   *
   * `query.team` narrows Recent the same way it narrows the tiers, and a team
   * the member is not on narrows it to nothing — the same answer the
   * repository gives for the tiers, reached here because `listRecent` takes
   * the team list already narrowed.
   */
  private readRuns(
    teamIds: readonly Domain.TeamId[],
    memberEmail: Domain.Email,
    query: Domain.RunQuery,
  ) {
    const shop = this.name;
    return Effect.gen(function* () {
      const repository = yield* RunRepository;
      const started = yield* Clock.currentTimeMillis;
      const { counts, items } = yield* repository.listRuns({
        teamIds,
        memberEmail,
        query,
      });
      const recentTeamIds =
        query.team === null
          ? teamIds
          : teamIds.filter((teamId) => teamId === query.team);
      const recent = yield* repository.listRecent({
        teamIds: recentTeamIds,
        since: started - Domain.DONE_WINDOW_MS,
        limit: query.tab === "done" ? query.limit : 0,
      });
      /**
       * The fan-out this read was cut to bound, measured on real shops:
       * `rows` is what left the object, and it must stay at or under
       * `query.limit`.
       */
      const rows = query.tab === "done" ? recent.items.length : items.length;
      const team = query.team ?? "all";
      const ms = (yield* Clock.currentTimeMillis) - started;
      yield* Effect.logInfo(
        `ShopAgent.readRuns: shop=${shop} teams=${String(teamIds.length)} team=${team} tab=${query.tab} rows=${String(rows)} ms=${String(ms)}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          teams: teamIds.length,
          team,
          tab: query.tab,
          rows,
          ms,
        }),
      );
      return {
        counts: { ...counts, done: recent.total },
        items,
        recent: recent.items,
      } satisfies Domain.RunListView;
    });
  }

  listRuns(
    input: typeof Domain.ListRunsInput.Encoded,
  ): Promise<Domain.RunListView> {
    const readRuns = (
      teamIds: readonly Domain.TeamId[],
      memberEmail: Domain.Email,
      query: Domain.RunQuery,
    ) => this.readRuns(teamIds, memberEmail, query);
    return this.runEffect(
      callableEffect("ShopAgent.listRuns", Domain.ListRunsInput, {
        role: "rpc",
      })(({ teamIds, memberEmail, query }) =>
        readRuns(teamIds, memberEmail, query),
      )(input),
    );
  }

  /**
   * The socket twin of {@link listRuns}: the same read, plus the calling
   * connection's subscription, in one round trip so a write landing between
   * two separate calls cannot be missed. The subscribe pattern end to end is
   * on `Domain.Subscription`.
   *
   * `teamIds` comes from the connection, not the message, so a member's list
   * is scoped by the membership the Worker's gate resolved — the same value
   * the loader's `requireMember` produced, arriving by the other route.
   *
   * `orderId: null`: a member's subscription is team-scoped, not order-scoped,
   * and `publish` reads the role to decide which of the two scopes applies.
   */
  @callable()
  subscribeRuns(
    input: typeof Domain.SubscribeRunsInput.Encoded,
  ): Promise<Domain.RunListView> {
    const readRuns = (
      teamIds: readonly Domain.TeamId[],
      memberEmail: Domain.Email,
      query: Domain.RunQuery,
    ) => this.readRuns(teamIds, memberEmail, query);
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.subscribeRuns",
        Domain.SubscribeRunsInput,
        { onExcessProperty: "error" },
      )(({ subscriberId, query }, { teamIds, memberEmail }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection)
            setSubscription(connection, { subscriberId, orderId: null });
          return yield* readRuns(teamIds, memberEmail, query);
        }),
      )(input),
    );
  }

  @callable()
  memberStartTask(
    input: typeof Domain.StartTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runTaskId: string) => this.publishToTeams({ runTaskId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.memberStartTask", Domain.StartTaskInput, {
        onExcessProperty: "error",
      })(({ runTaskId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireTaskAction(runTaskId, actor, ({ start }) => start);
            yield* (yield* RunRepository).startTask({
              runTaskId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
            } satisfies Domain.StartTaskCommand);
            yield* Effect.logInfo(
              `ShopAgent.memberStartTask: shop=${shop} task=${runTaskId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runTaskId))),
      )(input),
    );
  }

  /** Put back; the rule is on `RunRepository.putBackTask`. */
  @callable()
  memberPutBackTask(
    input: typeof Domain.PutBackTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runTaskId: string) => this.publishToTeams({ runTaskId });
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberPutBackTask",
        Domain.PutBackTaskInput,
        {
          onExcessProperty: "error",
        },
      )(({ runTaskId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireTaskAction(
              runTaskId,
              actor,
              ({ putBack }) => putBack,
            );
            yield* (yield* RunRepository).putBackTask({
              runTaskId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
            } satisfies Domain.PutBackTaskCommand);
            yield* Effect.logInfo(
              `ShopAgent.memberPutBackTask: shop=${shop} task=${runTaskId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runTaskId))),
      )(input),
    );
  }

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  @callable()
  memberSetRunNote(
    input: typeof Domain.SetRunNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberSetRunNote",
        Domain.SetRunNoteInput,
        {
          onExcessProperty: "error",
        },
      )(({ runId, note }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireRunAction(runId, actor, "note");
            yield* (yield* RunRepository).setRunNote({
              runId,
              teamIds,
              note,
            } satisfies Domain.SetRunNoteCommand);
            yield* Effect.logInfo(
              `ShopAgent.memberSetRunNote: shop=${shop} runId=${runId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  memberBlockRun(
    input: typeof Domain.BlockRunInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.memberBlockRun", Domain.BlockRunInput, {
        onExcessProperty: "error",
      })(({ runId, reason }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireRunAction(runId, actor, "block");
            yield* (yield* RunRepository).blockRun({
              runId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
              reason,
            } satisfies Domain.BlockRunCommand);
            yield* Effect.logInfo(
              `ShopAgent.memberBlockRun: shop=${shop} runId=${runId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  memberSetBlockReason(
    input: typeof Domain.SetBlockReasonInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberSetBlockReason",
        Domain.SetBlockReasonInput,
        { onExcessProperty: "error" },
      )(({ runId, reason }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireRunAction(runId, actor, "editReason");
            yield* (yield* RunRepository).setBlockReason({
              runId,
              teamIds,
              reason,
            } satisfies Domain.SetBlockReasonCommand);
            yield* Effect.logInfo(
              `ShopAgent.memberSetBlockReason: shop=${shop} runId=${runId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  memberMarkTaskDone(
    input: typeof Domain.MarkTaskDoneInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runTaskId: string) => this.publishToTeams({ runTaskId });
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberMarkTaskDone",
        Domain.MarkTaskDoneInput,
        {
          onExcessProperty: "error",
        },
      )(({ runTaskId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireTaskAction(runTaskId, actor, ({ done }) => done);
            yield* (yield* RunRepository).markTaskDone({
              runTaskId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
            } satisfies Domain.MarkTaskDoneCommand);
            yield* Effect.logInfo(
              `ShopAgent.memberMarkTaskDone: shop=${shop} task=${runTaskId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runTaskId))),
      )(input),
    );
  }

  /**
   * Reopen, the member's Undo. Publishes to the order's teams like the others: the merchant's
   * order page shows every run of the order.
   */
  @callable()
  memberReopenTask(
    input: typeof Domain.ReopenTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runTaskId: string) => this.publishToTeams({ runTaskId });
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberReopenTask",
        Domain.ReopenTaskInput,
        { onExcessProperty: "error" },
      )(({ runTaskId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireTaskAction(
              runTaskId,
              actor,
              ({ reopen }) => reopen !== null,
            );
            yield* (yield* RunRepository).reopenTask({
              runTaskId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
            } satisfies Domain.ReopenTaskCommand);
            yield* Effect.logInfo(
              `ShopAgent.memberReopenTask: shop=${shop} task=${runTaskId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runTaskId))),
      )(input),
    );
  }

  private readRunView(input: {
    readonly runId: string;
    readonly teamIds: readonly string[];
  }) {
    return RunRepository.pipe(
      Effect.flatMap((repository) => repository.getRunView(input)),
      Effect.map(Option.getOrNull),
    );
  }

  /** The work page's loader read; plain RPC for the same reason as {@link listRuns}. */
  memberGetRun(
    input: typeof Domain.GetRunForMemberInput.Encoded,
  ): Promise<Domain.RunView | null> {
    const readRunView = (input: Domain.GetRunForMemberInput) =>
      this.readRunView(input);
    return this.runEffect(
      callableEffect("ShopAgent.memberGetRun", Domain.GetRunForMemberInput, {
        role: "rpc",
      })((input) => readRunView(input))(input),
    );
  }

  /**
   * The socket twin of {@link memberGetRun}, as `subscribeRuns` is of
   * `listRuns`. The subscription is the same team-scoped one the run list
   * registers (`orderId: null`): a member's pushes are decided by team, so
   * any write touching one of their teams' orders refetches this run too.
   * Over-broad by an order or two; the read is one run.
   */
  @callable()
  subscribeRun(
    input: typeof Domain.SubscribeRunInput.Encoded,
  ): Promise<Domain.RunView | null> {
    const readRunView = (input: Domain.GetRunForMemberInput) =>
      this.readRunView(input);
    return this.runEffect(
      memberCallableEffect("ShopAgent.subscribeRun", Domain.SubscribeRunInput, {
        onExcessProperty: "error",
      })(({ subscriberId, runId }, { teamIds }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection)
            setSubscription(connection, { subscriberId, orderId: null });
          return yield* readRunView({ runId, teamIds });
        }),
      )(input),
    );
  }

  @callable()
  memberUnblockRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.memberUnblockRun", Domain.RunIdInput, {
        onExcessProperty: "error",
      })(({ runId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            const actor = memberActor({ memberId, memberEmail, teamIds });
            yield* requireRunAction(runId, actor, "unblock");
            yield* (yield* RunRepository).unblockRun({
              runId,
              teamIds,
            } satisfies Domain.UnblockRunCommand);
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  /**
   * The team check lives here, not in the repository: `Team` is a D1 row the
   * Durable Object's SQLite cannot reference, so "team exists" is an
   * application invariant. Checked against the live roster on every write.
   * `deleteTeam` reads D1 first and nulls pointers second precisely so a
   * write that passes this check can still be caught by the nulling — see
   * that method.
   */
  private teamExists(teamId: string) {
    return this.teams().pipe(
      Effect.map((teams) => teams.find((team) => team.id === teamId) ?? null),
    );
  }

  @callable()
  addStep(
    input: typeof Domain.AddStepInput.Encoded,
  ): Promise<Domain.TaskResult> {
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect("ShopAgent.addStep", Domain.AddStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId, name, teamId, instructions }) =>
        taskResult(
          Effect.gen(function* () {
            const team = yield* teamExists(teamId);
            if (team === null) return { _tag: "TeamNotFound" };
            const task = yield* (yield* WorkflowRepository).addStep({
              workflowId,
              name,
              teamId: team.id,
              instructions: instructions ?? null,
            });
            return { _tag: "Ok", task };
          }),
        ),
      )(input),
    );
  }

  /** `StepNotFoundError` surfaces as `NotFound`: the step the editor showed was closed by a concurrent edit. */
  @callable()
  addTask(
    input: typeof Domain.AddTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    const shop = this.name;
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect("ShopAgent.addTask", Domain.AddTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId, step, name, teamId, instructions }) =>
        taskResult(
          Effect.gen(function* () {
            const team = yield* teamExists(teamId);
            if (team === null) return { _tag: "TeamNotFound" };
            const task = yield* (yield* WorkflowRepository).addTask({
              workflowId,
              step,
              name,
              teamId: team.id,
              instructions: instructions ?? null,
            });
            yield* Effect.logInfo(
              `ShopAgent.addTask: shop=${shop} workflowId=${workflowId} step=${String(step)}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId, step }));
            return { _tag: "Ok", task };
          }),
        ),
      )(input),
    );
  }

  @callable()
  updateTask(
    input: typeof Domain.UpdateTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect("ShopAgent.updateTask", Domain.UpdateTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ taskId, name, teamId, instructions }) =>
        taskResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const team = yield* teamExists(teamId);
            if (team === null) return { _tag: "TeamNotFound" };
            const task = yield* repository.updateTask({
              taskId,
              name,
              teamId: team.id,
              instructions,
            });
            return { _tag: "Ok", task };
          }),
        ),
      )(input),
    );
  }

  @callable()
  moveTask(
    input: typeof Domain.MoveTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    return this.runEffect(
      callableEffect("ShopAgent.moveTask", Domain.MoveTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ taskId, direction }) =>
        taskResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRepository).moveTask({ taskId, direction });
            return { _tag: "Ok", task: null };
          }),
        ),
      )(input),
    );
  }

  @callable()
  separateTask(
    input: typeof Domain.SeparateTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.separateTask", Domain.SeparateTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ taskId }) =>
        taskResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getTask({ taskId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            yield* repository.separateTask({ taskId });
            yield* Effect.logInfo(
              `ShopAgent.separateTask: shop=${shop} workflowId=${existing.value.workflow.id} step=${String(existing.value.task.step)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                workflowId: existing.value.workflow.id,
                step: existing.value.task.step,
              }),
            );
            return { _tag: "Ok", task: null };
          }),
        ),
      )(input),
    );
  }

  @callable()
  joinTask(
    input: typeof Domain.JoinTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.joinTask", Domain.JoinTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ taskId }) =>
        taskResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getTask({ taskId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            yield* repository.joinTask({ taskId });
            yield* Effect.logInfo(
              `ShopAgent.joinTask: shop=${shop} workflowId=${existing.value.workflow.id} step=${String(existing.value.task.step)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                workflowId: existing.value.workflow.id,
                step: existing.value.task.step,
              }),
            );
            return { _tag: "Ok", task: null };
          }),
        ),
      )(input),
    );
  }

  @callable()
  removeTask(
    input: typeof Domain.TaskIdInput.Encoded,
  ): Promise<Domain.TaskResult> {
    return this.runEffect(
      callableEffect("ShopAgent.removeTask", Domain.TaskIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ taskId }) =>
        taskResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRepository).removeTask({ taskId });
            return { _tag: "Ok", task: null };
          }),
        ),
      )(input),
    );
  }

  /**
   * Delete a team and its tasks become unassigned. Two stores, two writes,
   * D1 first: the two cannot share a transaction, and the order is what
   * closes the race with a concurrent `addStep` / `updateTask` pointing at
   * this team. Its `teamExists` check reads D1; if that read lands after the
   * D1 delete the write is refused, and if it lands before but the task
   * write lands before the nulling, the nulling catches it — the object is
   * single-threaded, so nothing interleaves with the nulling itself. The
   * reverse order would let a task written between the nulling and the D1
   * delete validate fine and dangle forever. What remains is the nulling
   * failing after the D1 row is gone; every read already treats an id no
   * team carries as unassigned, so that state is self-healing, and a retry
   * of this call (which reports `NotFound` for the row but still runs the
   * nulling) repairs it. Nothing is refused for being in use: the confirm
   * dialog states the counts and the merchant decides.
   */
  @callable()
  deleteTeam(
    input: typeof Domain.DeleteTeamInput.Encoded,
  ): Promise<Domain.DeleteTeamResult> {
    const name = this.name;
    const publish = () => this.publish("all");
    const closeMemberConnections = (memberIds: readonly string[]) =>
      this.closeMemberConnections(memberIds);
    return this.runEffect(
      callableEffect("ShopAgent.deleteTeam", Domain.DeleteTeamInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ teamId }) =>
        Effect.gen(function* () {
          const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(name);
          const id = yield* Schema.decodeUnknownEffect(Domain.TeamId)(teamId);
          const deleted = yield* (yield* Repository)
            .deleteTeam({ shop, id })
            .pipe(
              Effect.map((memberIds) => ({
                result: { _tag: "Deleted" } satisfies Domain.DeleteTeamResult,
                memberIds: memberIds as readonly string[],
              })),
              Effect.catchTag("TeamNotFoundError", () =>
                Effect.succeed({
                  result: {
                    _tag: "NotFound",
                  } satisfies Domain.DeleteTeamResult,
                  memberIds: [] as readonly string[],
                }),
              ),
            );
          yield* (yield* WorkflowRepository).unassignTeam({ teamId });
          // The team was on every one of these members' connections; the
          // Worker cannot do this itself because `Repository.deleteTeam` runs
          // here, and only here is the roster still readable.
          yield* closeMemberConnections(deleted.memberIds);
          yield* Effect.logInfo(
            `ShopAgent.deleteTeam: shop=${shop} teamId=${teamId} status=${deleted.result._tag}`,
          ).pipe(
            Effect.annotateLogs({ shop, teamId, status: deleted.result._tag }),
          );
          yield* publish();
          return deleted.result;
        }),
      )(input),
    );
  }

  /**
   * Points any open run task at a team, started or not: the remedy for an
   * unassigned task (see `deleteTeam`) and the merchant's way to move work
   * between teams. The team is checked against the live D1 roster here, as
   * `addStep` does, and its name is snapshotted onto the task from that same
   * read. Only `teamId` / `teamName` change, so a started task keeps
   * `startedBy*`; a done task is refused (`TaskDone`).
   */
  @callable()
  merchantAssignRunTaskTeam(
    input: typeof Domain.AssignRunTaskTeamInput.Encoded,
  ): Promise<Domain.AssignRunTaskTeamResult> {
    const shop = this.name;
    const publish = (teams: PublishTeams) => this.publish("all", teams);
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantAssignRunTaskTeam",
        Domain.AssignRunTaskTeamInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ runTaskId, teamId }) =>
        Effect.gen(function* () {
          yield* requireTaskAction(runTaskId, MERCHANT, ({ assign }) => assign);
          const team = yield* teamExists(teamId);
          if (team === null)
            return {
              _tag: "TeamNotFound",
            } satisfies Domain.AssignRunTaskTeamResult;
          /**
           * Both sides of the move: the team losing the task is only nameable
           * before the write, and the team gaining it only after, so the
           * lists that change are the union of the two reads.
           */
          const before = yield* orderTeamIds({ runTaskId });
          yield* (yield* RunRepository).assignRunTaskTeam({
            runTaskId,
            team: { id: team.id, name: team.name },
          });
          yield* Effect.logInfo(
            `ShopAgent.merchantAssignRunTaskTeam: shop=${shop} task=${runTaskId} teamId=${teamId}`,
          ).pipe(Effect.annotateLogs({ shop, task: runTaskId, teamId }));
          yield* publish(
            unionTeams(before, yield* orderTeamIds({ runTaskId })),
          );
          return { _tag: "Assigned" } satisfies Domain.AssignRunTaskTeamResult;
        }).pipe(
          Effect.catchTags({
            RunNotFoundError: () =>
              Effect.succeed<Domain.AssignRunTaskTeamResult>({
                _tag: "NotFound",
              }),
            TaskDoneError: () =>
              Effect.succeed<Domain.AssignRunTaskTeamResult>({
                _tag: "TaskDone",
              }),
            RunTerminalError: () =>
              Effect.succeed<Domain.AssignRunTaskTeamResult>({
                _tag: "RunNotOpen",
              }),
            RunNotAllowedError: () =>
              Effect.succeed<Domain.AssignRunTaskTeamResult>({
                _tag: "NotAllowed",
              }),
          }),
        ),
      )(input),
    );
  }

  /**
   * Development seed: replaces this shop's workflow definitions (and every
   * run) with `input.workflows` in one transaction. One callable rather than
   * `createWorkflow` + an `addStep` round trip per task, so the fixture
   * arrives as a single declarative payload and a failure partway cannot leave
   * a half-built definition behind.
   *
   * Gated on `ENVIRONMENT === "local"` here as well as at the route that calls
   * it (`src/routes/api.dev.seed.ts`): this is the one write path into
   * `Workflow` that skips the name, limit, and team checks, and the
   * guard belongs with the bypass, not only with its current caller. An
   * ordinary failure rather than `Effect.die` — `runEffect` collapses failures
   * and defects into the same thrown `Error` at the RPC seam, so a defect buys
   * nothing here.
   *
   * Leaves every stored order un-matched on purpose: `replaceWorkflows` drops
   * every run and every definition, so the orders that survive it are carrying
   * the previous fixture's `matchedWorkflowIds`. {@link seedOrders} is what
   * puts them right, at its end, once the fixture's own orders have been
   * replaced — reconciling here would start runs on rows that call is about to
   * delete, runs and all, so the work would be thrown away a moment later.
   * `api.dev.seed.ts` always calls both, in that order.
   *
   * Returns each workflow's minted id so the caller can point an item at
   * one; the fixture speaks names, `api.dev.seed.ts` does the mapping.
   */
  @callable()
  seedWorkflows(
    input: typeof Domain.SeedWorkflowsInput.Encoded,
  ): Promise<readonly { readonly name: string; readonly id: string }[]> {
    const environment = this.env.ENVIRONMENT;
    return this.runEffect(
      callableEffect("ShopAgent.seedWorkflows", Domain.SeedWorkflowsInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((seed) =>
        environment === "local"
          ? WorkflowRepository.pipe(
              Effect.flatMap((repository) => repository.replaceWorkflows(seed)),
            )
          : Effect.fail(
              new WorkflowRepositoryError({
                message: `ShopAgent.seedWorkflows: environment=${environment}: seeding is local-only`,
                cause: environment,
              }),
            ),
      )(input),
    );
  }

  /**
   * Development seed for orders, same gate and reasoning as `seedWorkflows`.
   * Goes through `upsertOrder` + `reconcileOrder` rather than raw inserts so
   * the fixture exercises run creation, and `done` marks tasks done through
   * `markTaskDone` with the task's own team so the check of which tasks
   * are current is exercised the way it is on the floor. `advance`, `started`, and
   * `blocked` go through the same actions for the same reason: a seeded
   * card reading "Step 2 of 3" with In progress and Blocked badges is
   * indistinguishable from one a
   * worker produced. Only rows under `SEED_ORDER_ID_PREFIX` are replaced;
   * synced orders are left alone.
   *
   * Four phases per order, in this order (`Domain.SeedOrdersInput` says what
   * each key means): upsert and reconcile; each item's `workflowId` through
   * `setRun`, the merchant's own Choose; progress, dispatched per run so one
   * order's items can be in different states; then the order's `after` state
   * through a second upsert, which is the only way to reach the closed and
   * resized runs that need the change to land *after* a run exists.
   */
  @callable()
  seedOrders(input: typeof Domain.SeedOrdersInput.Encoded): Promise<void> {
    const environment = this.env.ENVIRONMENT;
    const shop = this.name;
    const publish = () => this.publish("all");
    const reconciler = () => this.reconciler("manual");
    const reconcileAll = () => this.reconcileAllNow("seedOrders", "seed");
    const teams = () => this.teams();
    return this.runEffect(
      callableEffect("ShopAgent.seedOrders", Domain.SeedOrdersInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ memberId, memberEmail, orders }) =>
        Effect.gen(function* () {
          if (environment !== "local")
            yield* Effect.fail(
              new WorkflowRepositoryError({
                message: `ShopAgent.seedOrders: environment=${environment}: seeding is local-only`,
                cause: environment,
              }),
            );
          const orderRepository = yield* OrderRepository;
          const workflowRepository = yield* WorkflowRepository;
          const runs = yield* RunRepository;
          const reconcile = yield* reconciler();
          const roster = yield* teams();
          const now = yield* Clock.currentTimeMillis;
          const listOpenRuns = (orderId: string) =>
            runs
              .listRunsForOrder({ orderId })
              .pipe(
                Effect.map((details) =>
                  details.filter(({ run }) => Domain.runIsOpen(run)),
                ),
              );
          const memberActor = {
            role: "member",
            memberId,
            email: memberEmail,
          } satisfies Domain.MemberActor;
          const actor = (task: Domain.RunTask) => ({
            runTaskId: task.id,
            actor: memberActor,
            teamIds: task.teamId === null ? [] : [task.teamId],
          });
          const taskCommand = (task: Domain.RunTask, merchant: boolean) =>
            merchant ? merchantTaskCommand(task) : actor(task);
          // Reloaded before every phase rather than carried: each phase
          // marks tasks done, which changes what the next one may touch.
          const openRun = (runId: string) =>
            runs
              .getRun({ runId })
              .pipe(
                Effect.map((found) =>
                  Option.isSome(found) && Domain.runIsOpen(found.value.run)
                    ? found.value
                    : null,
                ),
              );
          const markRunDone = (runId: string, merchant: boolean) =>
            Effect.gen(function* () {
              const detail = yield* openRun(runId);
              if (detail === null) return;
              yield* Effect.forEach(
                detail.tasks,
                (task) => runs.markTaskDone(taskCommand(task, merchant)),
                { discard: true },
              );
              yield* Effect.logInfo(
                `ShopAgent.seedOrders: orderId=${detail.run.orderId} runId=${runId}: completed`,
              ).pipe(
                Effect.annotateLogs({ orderId: detail.run.orderId, runId }),
              );
            });
          /** One round: every task current at the start of the round gets done; what that makes current waits for the next. */
          const advanceRun = (runId: string, merchant: boolean) =>
            Effect.gen(function* () {
              const detail = yield* openRun(runId);
              if (detail === null) return;
              yield* Effect.forEach(
                seedReadyTasks([detail]),
                (task) => runs.markTaskDone(taskCommand(task, merchant)),
                { discard: true },
              );
            });
          const startRun = (runId: string) =>
            Effect.gen(function* () {
              const detail = yield* openRun(runId);
              if (detail === null) return;
              yield* Effect.forEach(
                detail.tasks.filter((task) => task.doneAt === null),
                (task) =>
                  runs
                    .startTask(actor(task))
                    .pipe(
                      Effect.catchTag("TaskNotReadyError", () => Effect.void),
                    ),
                { discard: true },
              );
            });
          const blockOneRun = (
            runId: string,
            reason: Domain.BlockReason,
            merchant: boolean,
          ) =>
            Effect.gen(function* () {
              const detail = yield* openRun(runId);
              if (detail === null) return;
              yield* runs
                .blockRun({
                  runId,
                  ...(merchant
                    ? { actor: { role: "merchant" as const } }
                    : {
                        actor: memberActor,
                        teamIds: detail.tasks.flatMap((task) =>
                          task.teamId === null ? [] : [task.teamId],
                        ),
                      }),
                  reason,
                })
                .pipe(Effect.catchTag("RunNotAllowedError", () => Effect.void));
            });
          const applyProgress = (
            runId: string,
            progress: Domain.SeedProgress,
          ) =>
            Effect.gen(function* () {
              const merchant = progress.byMerchant === true;
              if (progress.done === true) yield* markRunDone(runId, merchant);
              for (let round = 0; round < (progress.advance ?? 0); round += 1)
                yield* advanceRun(runId, merchant);
              if (progress.started === true) yield* startRun(runId);
              if (progress.blocked !== undefined)
                yield* blockOneRun(runId, progress.blocked, merchant);
              if (progress.cancelled === true)
                yield* runs.cancelRun({ runId }).pipe(
                  Effect.catchTags({
                    RunNotFoundError: () => Effect.void,
                    RunTerminalError: () => Effect.void,
                    RunOrderClosedError: () => Effect.void,
                  }),
                );
            });
          /**
           * The merchant's own Choose, on an item the seed wrote moments
           * ago: the same `setRun` the attach callable makes, so the run it
           * leaves carries `manual` and is indistinguishable from a chosen one.
           * A fixture naming a workflow that cannot start the item is a
           * fixture bug — failing here is louder than leaving the row reading
           * as whatever its tags happened to match.
           */
          const setChosenWorkflow = (
            orderId: string,
            position: number,
            workflowId: string,
          ) =>
            Effect.gen(function* () {
              const lineItemId = `${orderId}/line-${String(position)}`;
              const target = yield* orderRepository.getLineItem(lineItemId);
              const found = yield* workflowRepository.getWorkflow({
                workflowId,
              });
              const detail: Domain.WorkflowDetail | null = Option.isSome(found)
                ? { workflow: found.value.workflow, tasks: found.value.tasks }
                : null;
              yield* Option.isNone(target) ||
              detail === null ||
              !canStart(detail, roster)
                ? Effect.fail(
                    new WorkflowRepositoryError({
                      message: `ShopAgent.seedOrders: lineItemId=${lineItemId} workflowId=${workflowId}: no such line item, or a workflow that cannot start`,
                      cause: workflowId,
                    }),
                  )
                : runs.setRun({
                    workflow: detail,
                    teams: roster,
                    order: target.value.order,
                    lineItem: target.value.lineItem,
                    source: "manual",
                  });
            });
          // Orders, items, runs and the usage they counted, together;
          // the upserts below then count each fresh paid order the ordinary
          // way, so a reseed lands on the number one seed would have produced.
          yield* orderRepository.deleteSeedOrders();
          let runCount = 0;
          for (const [index, seed] of orders.entries()) {
            const id = `${Domain.SEED_ORDER_ID_PREFIX}${String(seed.n)}`;
            // At or after `now`, never before: the workflows this fixture
            // starts were turned on moments ago and the date rule skips an
            // order placed before its workflow. Spaced a millisecond apart
            // so the index's keyset order matches `orders` order, newest
            // last, while the tail of the fixture stays within a blink of
            // `now`: a wider gap dates the last rows into the future, and
            // anything that compares `processedAt` against `now` — a
            // reconcile after a workflow is activated, for one — would then
            // read a shop that cannot exist.
            const processedAt = now + index;
            const order: Domain.ShopOrder = {
              id,
              legacyId: `seed-${String(seed.n)}`,
              name: `#${String(seed.n)}`,
              processedAt,
              updatedAt: now,
              cancelledAt: null,
              closedAt: null,
              financialStatus: seed.unpaid === true ? "PENDING" : "PAID",
              fulfillmentStatus: seed.fulfillmentStatus ?? "UNFULFILLED",
              fullyPaid: seed.unpaid !== true,
              note: seed.note ?? null,
              lineItemsTruncated: false,
              syncedAt: now,
              syncSource: "manual",
            };
            /** `changed` is the `after` block's quantities, by 1-based position; without it this is the order as placed. */
            const lineItemsOf = (
              changed: Domain.SeedOrderChange["lineItems"] = [],
            ) =>
              seed.lineItems.map((item, position) => {
                const override = changed.find(
                  (entry) => entry.position === position + 1,
                );
                const currentQuantity =
                  override?.currentQuantity ??
                  item.currentQuantity ??
                  item.quantity;
                return {
                  id: `${id}/line-${String(position + 1)}`,
                  orderId: id,
                  productId: null,
                  variantId: null,
                  title: item.title,
                  variantTitle: null,
                  sku: null,
                  quantity: item.quantity,
                  currentQuantity,
                  productTags: item.tags,
                  matchedWorkflowIds: [],
                  properties: item.properties ?? [],
                  requiresShipping: true,
                } satisfies Domain.OrderLineItem;
              });
            yield* orderRepository.upsertOrder({
              order,
              lineItems: lineItemsOf(),
              afterWrite: reconcile(order),
            });
            for (const [position, item] of seed.lineItems.entries())
              if (item.workflowId !== undefined)
                yield* setChosenWorkflow(id, position + 1, item.workflowId);
            const open = yield* listOpenRuns(id);
            runCount += open.length;
            for (const { run } of open) {
              // `${id}/line-<position>` is this seed's own id scheme, so the
              // position is readable back off the run without a join.
              const position = Number(
                run.lineItemId.slice(`${id}/line-`.length),
              );
              yield* applyProgress(
                run.id,
                seed.lineItems[position - 1]?.progress ?? seed,
              );
            }
            if (seed.after !== undefined) {
              const changed: Domain.ShopOrder = {
                ...order,
                cancelledAt: seed.after.cancelled === true ? now : null,
                fulfillmentStatus:
                  seed.after.fulfillmentStatus ?? order.fulfillmentStatus,
                updatedAt: now,
              };
              yield* orderRepository.upsertOrder({
                order: changed,
                lineItems: lineItemsOf(seed.after.lineItems),
                afterWrite: reconcile(changed),
              });
            }
          }
          // The orders this seed did not write: synced rows a fixture leaves
          // alone, whose runs `seedWorkflows` deleted along with the
          // definitions those runs named. Nothing above touches them, and a
          // stored order still matched against a workflow that no longer
          // exists is a state the ordinary path never produces.
          yield* reconcileAll();
          yield* Effect.logInfo(
            `ShopAgent.seedOrders: shop=${shop} orders=${String(orders.length)} runs=${String(runCount)}`,
          ).pipe(
            Effect.annotateLogs({
              shop,
              orders: orders.length,
              runs: runCount,
            }),
          );
          yield* publish();
        }),
      )(input),
    );
  }

  /**
   * Plain RPC, not `@callable()`: the team detail page reads this through its
   * loader via `ShopAgentClient`, so nothing browser-side calls it. Task
   * ownership is configuration that only changes on the workflow pages, and a
   * loader read refreshes with `router.invalidate` and paints during SSR,
   * which a socket query without a push listener cannot do.
   */
  listTeamWorkflows(
    input: typeof Domain.TeamIdInput.Encoded,
  ): Promise<readonly Domain.TeamWorkflow[]> {
    return this.runEffect(
      callableEffect("ShopAgent.listTeamWorkflows", Domain.TeamIdInput, {
        role: "rpc",
      })(({ teamId }) =>
        WorkflowRepository.pipe(
          Effect.flatMap((repository) =>
            repository.listTeamWorkflows({ teamId }),
          ),
        ),
      )(input),
    );
  }

  /** Plain RPC for the same reason as {@link listTeamWorkflows}: the teams index's "Used by" column, read by its loader. */
  listAllTeamWorkflows(): Promise<readonly Domain.TeamWorkflowByTeam[]> {
    return this.runEffect(
      WorkflowRepository.pipe(
        Effect.flatMap((repository) => repository.listAllTeamWorkflows()),
        Effect.withLogSpan("ShopAgent.listAllTeamWorkflows"),
      ),
    );
  }

  /** Plain RPC for the same reason as {@link listTeamWorkflows}: the delete dialogs' counts, read by the team pages' loaders. */
  countTasksByTeam(): Promise<readonly Domain.TeamTaskCounts[]> {
    return this.runEffect(
      WorkflowRepository.pipe(
        Effect.flatMap((repository) => repository.countTasksByTeam()),
        Effect.withLogSpan("ShopAgent.countTasksByTeam"),
      ),
    );
  }
}

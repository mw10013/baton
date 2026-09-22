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
  type OrdersStreamCounts,
  runShopAgentOrdersStream,
} from "@/lib/ShopAgentOrdersStream";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";
import { ShopifyAppEvents } from "@/lib/ShopifyAppEvents";
import {
  type NoDraftError,
  type NoStepsError,
  type StageNotFoundError,
  type StepNotFoundError,
  type StepUnassignedError,
  type WorkflowLimitError,
  type WorkflowNotFoundError,
  type WorkflowOffError,
  type WorkflowTagTakenError,
  WorkflowRepository,
  WorkflowRepositoryError,
} from "@/lib/WorkflowRepository";
import {
  canStart,
  type StartContext,
  type RunItemBusyError,
  type RunNotAllowedError,
  type RunNotBlockedError,
  type RunNotFoundError,
  type RunTerminalError,
  type RunFlaggedError,
  type StepNotReadyError,
  type StepUndoBlockedError,
  WorkflowRunRepository,
  type WorkflowRunRepositoryError,
} from "@/lib/WorkflowRunRepository";

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
 * object opens a cycle at its first counted order and rolls it forward on its
 * own, so a shop meters from its first webhook rather than from its first plan
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
 * `ShopOrder.countedAt` is its per-order counterpart: null means never counted,
 * which is what makes a cancellation reverse exactly once.
 *
 * The `(processedAt desc, id desc)` index is the keyset the orders page pages
 * on; `id desc` is in it so the tiebreak is index-ordered too, since a shop
 * can place several orders in the same millisecond. The retention sweep reads
 * the same index as a range scan (`Domain.ShopLimits.orderRetentionDays`).
 *
 * `Workflow` / `WorkflowStep` are the production-workflow *definitions* a
 * merchant configures: what starts runs. `WorkflowDraft` / `WorkflowDraftStep`
 * are the merchant's private copy under edit (see the vocabulary on
 * `Domain.Workflow`): Edit copies the workflow's steps into the draft, every
 * editor write lands on the draft, Apply replaces the workflow's steps with
 * the draft's and deletes it, Discard deletes it — each in
 * one transaction, so run creation sees the old definition or the new one and
 * never a half-edit. A workflow has at most one draft (`workflowId` is the
 * draft's primary key), and the draft's steps cascade with it. Steps live in
 * two tables rather than one with a flag so a step-id write can never be
 * ambiguous about its side and `unique (workflowId, position)` holds on each
 * side independently. No history is kept: a run survives every later edit
 * because it snapshots its steps and names, not because old definitions are
 * retained. `activatedAt` is the on/off switch and the coverage date in one
 * column, stored and never derived: null is off; Turn on sets it to now or to
 * an earlier date the merchant chose; the merchant can move it on the
 * workflow page; Turn off clears it; Apply never touches it. One fact instead
 * of two that must agree, and Apply must not move it because an unpaid order
 * placed while the workflow was on is still that workflow's business when it
 * pays. A run starts on an order only when `ShopOrder.processedAt >=
 * activatedAt`.
 *
 * `WorkflowStep.teamId` is a D1 `Team.id` with no foreign key because none is
 * possible: `Team` lives in D1 and this table in the object's private SQLite,
 * and SQLite foreign keys do not cross databases. Integrity is
 * application-level — `addStep` / `updateStep` verify the team exists before
 * writing, and `deleteTeam` nulls every pointer right after the D1 row goes
 * (`unassignTeam`, served by the `teamId` indexes). Nullable on purpose:
 * `null` is **unassigned**, the state a team delete leaves behind, and every
 * read treats an id no D1 row carries the same way, so the cross-store window
 * between the two writes is harmless. No workflow history is kept — a delete
 * removes the definition, its steps, and its draft; the runs it started stay,
 * because a run is self-sufficient with respect to its workflow and nothing
 * reads back through `workflowId`. `unique (workflowId, position)` is what forces every
 * layout edit to go through a scratch position inside one transaction — why
 * `WorkflowRepository.writeLayout` first parks every draft step at
 * `-position` before assigning final positions and stages.
 * `stage` groups steps that are ready together: along `position` stages are
 * dense `1..m` and non-decreasing, an invariant kept by the pure
 * `WorkflowLayout` module rather than by SQL. `instructions` is merchant text
 * copied onto each run. Epoch-ms integers like `ShopOrder`, not D1 `Team`'s
 * ISO text: the two stores already differ, and one store should not mix.
 *
 * `WorkflowRun` / `WorkflowRunStep` are the *instances*: one workflow applied
 * to one line item, with the definition's steps copied
 * in. Every display field is a snapshot and there is no foreign key to
 * `ShopOrder`, `OrderLineItem`, or `Workflow` — a run must survive an order
 * delete, a line item dropped by an edit, and a definition edit or rename,
 * because it is the record of work someone may already have started.
 * `unique (lineItemId, workflowId)` spans every status so a cancelled run
 * keeps its key: it is now only the *un-cancel* key, the one that lets
 * recovery from a mistaken cancel restore the steps already done rather than
 * start a fresh run. The cardinality rule is the second index,
 * `WorkflowRun_live_item_uidx`, partial over `status <> 'cancelled'`: **one
 * live run per line item**, enforced by the database and not only by the
 * write paths, so reconcile, manual attach, replace and un-cancel all have to
 * be correct under it. `OrderLineItem.matchedWorkflowIds` is the other half:
 * the workflows whose tags matched at the last reconcile, from which
 * "ambiguous" (two or more, no live run) is derived at read time. `status` is denormalized from the steps for
 * the run list and the definitions badge; every step write recomputes it in
 * the same transaction. `(teamId, completedAt)` serves the member's run list, which
 * asks for open steps by team. `WorkflowRunStep.teamId` is nullable for the
 * same reason as `WorkflowStep.teamId`: a team delete nulls it on open steps
 * (unassigned, on nobody's list until a person assigns a team) and leaves
 * finished steps alone, whose `teamName` snapshot is all history needs.
 * `startedByEmail` / `completedByEmail` snapshot the actor the same way, so
 * a member delete never leaves history resolving to nobody. A run step is
 * *ready* when it is open and no step in an earlier `stage` of the same run
 * is still open, so several steps of one run can be ready at once;
 * `startedAt` / `startedBy` record Start and make the run `active` before
 * anything is completed; `note` is worker text about this particular item.
 * `flag = 'blocked'` is the one flag a person sets (with an optional reason
 * and the actor under `by` in `flagDetail`) rather than reconcile.
 *
 * `startedByRole` / `completedByRole` / `reopenedByRole` are the actor
 * discriminator (`Domain.Actor`): the merchant acts on these rows from the
 * order page and has no `Member` row, so the id and email columns beside a
 * `'merchant'` role are null. `reopenedAt` / `reopenedBy*` hold the most
 * recent Undo only; a later Done clears the three together.
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
      customAttributes text not null,
      lineItemsTruncated integer not null default 0,
      syncedAt integer not null,
      syncSource text not null,
      countedAt integer,
      firstCycleStartAt integer not null
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
      unfulfilledQuantity integer not null,
      nonFulfillableQuantity integer not null,
      productTags text not null,
      matchedWorkflowIds text not null default '[]',
      customAttributes text not null,
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
      lastReconciledQuantity integer
    );
    insert or ignore into ShopUsage (id) values (1);
    create table if not exists UsageEvent (
      idempotencyKey text primary key,
      orderId text not null,
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
    create table if not exists WorkflowStep (
      id text primary key,
      workflowId text not null references Workflow (id) on delete cascade,
      position integer not null,
      stage integer not null,
      name text not null check (name = trim(name) and length(name) > 0),
      teamId text,
      instructions text,
      unique (workflowId, position)
    );
    create index if not exists WorkflowStep_teamId_idx on WorkflowStep (teamId);
    create table if not exists WorkflowDraft (
      workflowId text primary key references Workflow (id) on delete cascade,
      createdAt integer not null,
      updatedAt integer not null
    );
    create table if not exists WorkflowDraftStep (
      id text primary key,
      workflowId text not null references WorkflowDraft (workflowId) on delete cascade,
      position integer not null,
      stage integer not null,
      name text not null check (name = trim(name) and length(name) > 0),
      teamId text,
      instructions text,
      unique (workflowId, position)
    );
    create index if not exists WorkflowDraftStep_teamId_idx on WorkflowDraftStep (teamId);
    create table if not exists WorkflowRun (
      id text primary key,
      workflowId text not null,
      workflowName text not null,
      orderId text not null,
      orderName text not null,
      orderProcessedAt integer not null,
      lineItemId text not null,
      lineItemTitle text not null,
      variantTitle text,
      sku text,
      quantity integer not null,
      customAttributes text not null,
      source text not null check (source in ('tag', 'manual')),
      status text not null check (status in ('pending', 'active', 'done', 'cancelled')),
      flag text check (flag in ('item_removed', 'quantity_changed', 'order_cancelled', 'order_deleted', 'blocked', 'order_fulfilled')),
      flagAt integer,
      flagDetail text,
      createdAt integer not null,
      updatedAt integer not null,
      cancelledAt integer,
      unique (lineItemId, workflowId)
    );
    create unique index if not exists WorkflowRun_live_item_uidx
      on WorkflowRun (lineItemId) where status <> 'cancelled';
    create index if not exists WorkflowRun_orderId_idx on WorkflowRun (orderId);
    create index if not exists WorkflowRun_status_idx on WorkflowRun (status);
    create index if not exists WorkflowRun_open_age_idx
      on WorkflowRun (orderProcessedAt, lineItemId, id) where status in ('pending', 'active');
    create table if not exists WorkflowRunStep (
      id text primary key,
      runId text not null references WorkflowRun (id) on delete cascade,
      position integer not null,
      stage integer not null,
      name text not null,
      teamId text,
      teamName text not null,
      instructions text,
      startedAt integer,
      startedBy text,
      startedByEmail text,
      completedAt integer,
      completedBy text,
      completedByEmail text,
      note text,
      startedByRole text check (startedByRole in ('merchant', 'member')),
      completedByRole text check (completedByRole in ('merchant', 'member')),
      reopenedAt integer,
      reopenedByRole text check (reopenedByRole in ('merchant', 'member')),
      reopenedByEmail text,
      noteByRole text check (noteByRole in ('merchant', 'member')),
      unique (runId, position)
    );
    create index if not exists WorkflowRunStep_teamId_idx
      on WorkflowRunStep (teamId, completedAt);
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
    OrderRepository.layer,
    WorkflowRepository.layer,
    WorkflowRunRepository.layer,
  ).pipe(Layer.provideMerge(SqliteClient.layer({ storage })));
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
    | WorkflowRunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.WorkflowResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | WorkflowRunRepositoryError
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
    | NoStepsError
    | StepUnassignedError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | WorkflowRunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ApplyResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | WorkflowRunRepositoryError
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
      NoStepsError: () =>
        Effect.succeed<Domain.ApplyResult>({ _tag: "NoSteps" }),
      StepUnassignedError: ({ stepNames }) =>
        Effect.succeed<Domain.ApplyResult>({
          _tag: "StepUnassigned",
          stepNames,
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
    | NoStepsError
    | StepUnassignedError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | WorkflowRunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ActivateResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | WorkflowRunRepositoryError
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
      NoStepsError: () =>
        Effect.succeed<Domain.ActivateResult>({ _tag: "NoSteps" }),
      StepUnassignedError: ({ stepNames }) =>
        Effect.succeed<Domain.ActivateResult>({
          _tag: "StepUnassigned",
          stepNames,
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
    | WorkflowRunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ChangeActivatedAtResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | WorkflowRunRepositoryError
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

const stepResult = <R>(
  effect: Effect.Effect<
    Domain.StepResult,
    | StepNotFoundError
    | StageNotFoundError
    | WorkflowNotFoundError
    | WorkflowLimitError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.StepResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.catchTags({
      StepNotFoundError: () =>
        Effect.succeed<Domain.StepResult>({ _tag: "NotFound" }),
      StageNotFoundError: () =>
        Effect.succeed<Domain.StepResult>({ _tag: "NotFound" }),
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.StepResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) =>
        Effect.succeed<Domain.StepResult>({ _tag: "Limit", limit }),
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
    | RunFlaggedError
    | RunItemBusyError
    | RunNotAllowedError
    | RunNotBlockedError
    | StepNotReadyError
    | StepUndoBlockedError
    | SqlError.SqlError
    | WorkflowRunRepositoryError
    | WorkflowRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.RunResult,
  | SqlError.SqlError
  | WorkflowRunRepositoryError
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
      RunFlaggedError: ({ flag }) =>
        Effect.succeed<Domain.RunResult>({ _tag: "Flagged", flag }),
      RunNotAllowedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotAllowed" }),
      RunNotBlockedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotBlocked" }),
      StepNotReadyError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotReady" }),
      StepUndoBlockedError: ({ stepName, teamName }) =>
        Effect.succeed<Domain.RunResult>({
          _tag: "UndoBlocked",
          stepName,
          teamName,
        }),
      RunItemBusyError: ({ workflowName }) =>
        Effect.succeed<Domain.RunResult>({ _tag: "ItemHasRun", workflowName }),
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
 * The webhook payload after `include_fields` trimming. Decoded laxly and
 * defensively: Shopify may widen the payload at any time, `admin_graphql_api_id`
 * is absent from the `orders/delete` body, and the numeric `id` is only used to
 * build a GID when the graphql one is missing.
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
    | { readonly runStepId: string }
    | { readonly runId: string }
    | { readonly orderId: string },
) =>
  WorkflowRunRepository.pipe(
    Effect.flatMap(
      (repository): Effect.Effect<PublishTeams, SqlError.SqlError> =>
        repository.listOrderTeamIds(target),
    ),
    Effect.orElseSucceed((): PublishTeams => "all"),
  );

/** The union of two team scopes; `"all"` on either side is `"all"`. */
const unionTeams = (a: PublishTeams, b: PublishTeams): PublishTeams =>
  a === "all" || b === "all" ? "all" : [...new Set([...a, ...b])];

/**
 * Readiness decided on a snapshot taken before any step of the
 * round is completed: completing stage 1 makes stage 2 ready at
 * once, so asking `completeStep` as the loop goes would run the
 * whole order to done in one round. The rule is `Domain.readySteps`.
 */
/**
 * A seeded step write recorded as the merchant: no `teamIds`, which is the one
 * rule a merchant skips (`Domain.CompleteStepCommand`). Module scope because
 * it captures nothing — oxlint's `unicorn(consistent-function-scoping)`.
 */
const merchantStepCommand = (step: Domain.WorkflowRunStep) => ({
  runStepId: step.id,
  actor: { role: "merchant" } as const,
});

const seedReadySteps = (
  details: readonly Domain.WorkflowRunDetail[],
): Domain.WorkflowRunStep[] =>
  details.flatMap(({ run, steps }) => Domain.readySteps(run, steps));

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
   * owning a step on any run of that order, because readiness crosses runs
   * (`WorkflowRunRepository.listOrderTeamIds`) — and everything else publishes
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
   * idempotent *on this path only* — `deleteOrder` records no delivery and
   * needs none, since deleting an order twice is deleting it once: the
   * `X-Shopify-Webhook-Id` log rejects a redelivery outright,
   * and the payload's `updated_at` skips a fetch that could only produce an
   * older view than the one already stored. The upsert's own guard is the
   * third, and the only one that survives two paths writing at once.
   */
  syncOrder(input: OrderWebhookInput): Promise<void> {
    const shop = this.name;
    /**
     * Scoped by team as well as by order: the union of the teams with an open
     * step on the order before and after the reconcile, because a reconcile
     * can take a team's last step away (a cancelled line, a dropped quantity)
     * as readily as give one, and the team losing it is only nameable before.
     * An order no team owns a step on either side publishes to *no* member —
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
   * Stores Shopify's meter reading beside the local count and logs the two when
   * they disagree by more than the outbox can explain. Plain RPC for the same
   * reason as {@link setBillingCycle}.
   *
   * Nothing is corrected. The App Events API answers `202` to an event it will
   * later refuse, so a divergence is the *only* evidence that a shop's orders
   * are not being billed, and quietly moving the local number to match would
   * erase it. Pending events are subtracted first because they are a divergence
   * that resolves itself on the next flush; dead ones
   * (`Domain.usageEventIsDead`) are not, because they never will, and a
   * tolerance that grew with every lost event would hide exactly the loss it
   * is here to show.
   */
  reconcileUsage(
    input: typeof Domain.ReconcileUsageInput.Encoded,
  ): Promise<void> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.reconcileUsage", Domain.ReconcileUsageInput, {
        role: "rpc",
      })(({ quantity }) =>
        Effect.gen(function* () {
          const usage = yield* (yield* OrderRepository).reconcileUsage({
            quantity,
          });
          const drift = Math.abs(usage.ordersThisCycle - quantity);
          if (drift <= usage.pendingUsageEvents) return;
          yield* Effect.logWarning(
            `ShopAgent.reconcileUsage: shop=${shop} local=${String(usage.ordersThisCycle)} shopify=${String(quantity)} pending=${String(usage.pendingUsageEvents)}: metered usage diverges`,
          ).pipe(
            Effect.annotateLogs({
              shop,
              local: usage.ordersThisCycle,
              shopify: quantity,
              pending: usage.pendingUsageEvents,
            }),
          );
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

  /** `orders/delete` carries `{ id }` only — there is nothing to fetch. */
  deleteOrder(input: Domain.ResyncOrderInput): Promise<void> {
    const shop = this.name;
    const publish = (touched: PublishScope) => this.publish(touched);
    return this.runEffect(
      callableEffect("ShopAgent.deleteOrder", Domain.ResyncOrderInput, {
        role: "rpc",
      })(({ orderId }) =>
        Effect.gen(function* () {
          yield* (yield* WorkflowRunRepository).markOrderDeleted({ orderId });
          yield* (yield* OrderRepository).deleteOrder({
            orderId,
            now: yield* Clock.currentTimeMillis,
          });
          yield* Effect.logInfo(
            `ShopAgent.deleteOrder: shop=${shop} orderId=${orderId}`,
          ).pipe(Effect.annotateLogs({ shop, orderId }));
          yield* publish([orderId]);
        }),
      )(input),
    );
  }

  private readOrders({
    limit,
    cursor,
    q,
    state,
    paid,
    attention,
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
          state,
          paid,
          attention,
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
   * runtime already holds `Repository`, and one round trip returns the steps,
   * their resolved team names and member counts, and the roster the picker
   * needs. Both attention states are derived here and never stored: a step
   * whose `teamId` is null or names no team resolves to `teamName: null`
   * (unassigned — flagged, never blocked in the editor, since the risk is
   * when a run starts); a step on a team with no members carries
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
            steps: readonly Domain.WorkflowStep[],
          ): Domain.StepWithTeamName[] =>
            steps.map((step) => {
              const team =
                step.teamId === null ? undefined : teamOf.get(step.teamId);
              return {
                ...step,
                teamName: team?.name ?? null,
                memberCount: team?.memberCount ?? null,
              };
            });
          return {
            workflow: detail.value.workflow,
            steps: withTeamNames(detail.value.steps),
            draft:
              detail.value.draft === null
                ? null
                : {
                    draft: detail.value.draft.draft,
                    steps: withTeamNames(detail.value.draft.steps),
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

  /** Duplicate: the copy is off, keeps the steps, and takes the name and tag the dialog collected (`WorkflowRepository.duplicateWorkflow`). */
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
   * not on Shopify's next edit. Runs in flight snapshot their tag and steps
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
   * afterwards: new steps can make an item startable that was not, and those
   * orders should start now rather than at whatever moment Shopify next edits
   * them. Publishes because the next order starts against the new steps,
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
          return yield* (yield* WorkflowRunRepository).countWaitingOrders({
            ...(yield* startContext()),
            workflow: {
              workflow: found.value.workflow,
              steps: found.value.steps,
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
   * what every step pointer is resolved against (an id not in it is
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
   * Loads what starting runs needs — every active definition with its steps, and
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
        yield* (yield* WorkflowRunRepository).reconcileAll(
          yield* startContext(),
        );
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
      const runs = yield* WorkflowRunRepository;
      return (order: Domain.ShopOrder) =>
        runs.reconcileOrder({ ...context, orderId: order.id }).pipe(
          Effect.tap(({ created, cancelled, flagged, ambiguous }) =>
            Effect.logInfo(
              `ShopAgent.reconcileOrder: shop=${shop} orderId=${order.id} source=${source} created=${String(created)} cancelled=${String(cancelled)} flagged=${String(flagged)} ambiguous=${String(ambiguous)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                orderId: order.id,
                source,
                created,
                cancelled,
                flagged,
                ambiguous,
              }),
            ),
          ),
          Effect.asVoid,
        );
    });
  }

  /**
   * The detail page's `subscribe<Feature>` read: the order, its line items, and
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
      const runs = yield* WorkflowRunRepository;
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
          .filter(({ steps }) => steps.length > 0)
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

  @callable()
  listRunsForOrder(
    input: typeof Domain.ListRunsForOrderInput.Encoded,
  ): Promise<readonly Domain.WorkflowRunDetail[]> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.listRunsForOrder",
        Domain.ListRunsForOrderInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ orderId }) =>
        WorkflowRunRepository.pipe(
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
   * workflow for a line item by hand is exactly the override for a missing
   * tag, a fulfilled line, or an order placed before the workflow was turned
   * on. What it is not is an override of the order itself being over, which
   * is `Domain.canAttachRun`.
   *
   * An item holds at most one live run, so attaching over one is a replace:
   * the incumbent is cancelled in the same transaction and comes back as
   * `replaced` for the toast. The same workflow again is `AlreadyExists`.
   * Confirmation is the UI's job, not this one's — the server cannot know
   * whether the merchant has seen the trail of work already done on the run
   * it is about to cancel, and a server-side refusal would leave the page
   * with nothing to offer but the same click again.
   */
  @callable()
  attachWorkflow(
    input: typeof Domain.AttachWorkflowInput.Encoded,
  ): Promise<Domain.AttachResult> {
    const publish = (touched: PublishScope) => this.publish(touched);
    const teams = () => this.teams();
    return this.runEffect(
      callableEffect("ShopAgent.attachWorkflow", Domain.AttachWorkflowInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ lineItemId, workflowId }) =>
        Effect.gen(function* () {
          const target = yield* (yield* OrderRepository).getLineItem(
            lineItemId,
          );
          if (Option.isNone(target))
            return { _tag: "LineItemNotFound" } satisfies Domain.AttachResult;
          const workflows = yield* WorkflowRepository;
          const found = yield* workflows.getWorkflow({ workflowId });
          const roster = yield* teams();
          // Only the workflow's own steps can start a run; a draft is never
          // attachable.
          const detail: Domain.WorkflowDetail | null = Option.isSome(found)
            ? { workflow: found.value.workflow, steps: found.value.steps }
            : null;
          if (detail === null || !canStart(detail, roster))
            return {
              _tag: "WorkflowCannotStart",
            } satisfies Domain.AttachResult;
          if (!Domain.canAttachRun(target.value.order))
            return { _tag: "OrderClosed" } satisfies Domain.AttachResult;
          const set = yield* (yield* WorkflowRunRepository).setRun({
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
            WorkflowRunLimitError: ({ limit }) =>
              Effect.succeed<Domain.AttachResult>({ _tag: "RunLimit", limit }),
            RunFinishedError: ({ workflowName }) =>
              Effect.succeed<Domain.AttachResult>({
                _tag: "ItemDone",
                workflowName,
              }),
          }),
        ),
      )(input),
    );
  }

  @callable()
  cancelRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      callableEffect("ShopAgent.cancelRun", Domain.RunIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runId }) =>
        runResult(
          WorkflowRunRepository.pipe(
            Effect.flatMap((repository) => repository.cancelRun({ runId })),
            Effect.tap(() =>
              Effect.logInfo(
                `ShopAgent.cancelRun: shop=${shop} runId=${runId}`,
              ).pipe(Effect.annotateLogs({ shop, runId })),
            ),
          ),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  uncancelRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      callableEffect("ShopAgent.uncancelRun", Domain.RunIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runId }) =>
        runResult(
          WorkflowRunRepository.pipe(
            Effect.flatMap((repository) => repository.uncancelRun({ runId })),
          ),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  /**
   * The merchant's five interventions on a run, from the order page's Manage
   * rows. Separate methods rather than a role branch inside the member ones
   * because the role gate is declared *per method* — `CALLABLE_ROLES` in
   * `test/integration/shop-agent-callables.test.ts` enumerates the decorated
   * surface and fails the build for any callable whose audience was not
   * decided — and a single method admitting both populations would have to
   * re-derive that decision at runtime from the connection.
   *
   * Each builds `actor: { role: "merchant" }` and passes **no** `teamIds`,
   * which is the entire permission difference (`Domain.CompleteStepCommand`):
   * the step's team need not be one of the caller's, because the merchant has
   * none, and an unassigned step is exactly the case they are here to fix.
   * Stage order, terminal runs, and the downstream undo guard still apply.
   *
   * They publish with {@link publishToTeams}, not `publish("all")`: the
   * merchant's own order page is subscribed by order and the workers by team,
   * and the team fan-out for the touched order already reaches both. There is
   * no merchant Start: "started" records that a worker picked the step up,
   * and a merchant marking it started on their behalf would put a name on
   * work nobody has begun. The merchant either completes it outright or leaves
   * it for the team.
   *
   * No member id in the log line: there isn't one.
   */
  @callable()
  merchantCompleteStep(
    input: typeof Domain.CompleteStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runStepId: string) => this.publishToTeams({ runStepId });
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantCompleteStep",
        Domain.CompleteStepInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ runStepId }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).completeStep({
              runStepId,
              actor: { role: "merchant" },
            } satisfies Domain.CompleteStepCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantCompleteStep: shop=${shop} step=${runStepId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId }));
          }),
        ).pipe(Effect.tap(() => publish(runStepId))),
      )(input),
    );
  }

  @callable()
  merchantUncompleteStep(
    input: typeof Domain.UncompleteStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runStepId: string) => this.publishToTeams({ runStepId });
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantUncompleteStep",
        Domain.UncompleteStepInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ runStepId }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).uncompleteStep({
              runStepId,
              actor: { role: "merchant" },
            } satisfies Domain.UncompleteStepCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantUncompleteStep: shop=${shop} step=${runStepId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId }));
          }),
        ).pipe(Effect.tap(() => publish(runStepId))),
      )(input),
    );
  }

  /** The note itself never reaches the log line, as on the member's {@link setStepNote}. */
  @callable()
  merchantSetStepNote(
    input: typeof Domain.SetStepNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runStepId: string) => this.publishToTeams({ runStepId });
    return this.runEffect(
      callableEffect("ShopAgent.merchantSetStepNote", Domain.SetStepNoteInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runStepId, note }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).setStepNote({
              runStepId,
              actor: { role: "merchant" },
              note,
            } satisfies Domain.SetStepNoteCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantSetStepNote: shop=${shop} step=${runStepId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId }));
          }),
        ).pipe(Effect.tap(() => publish(runStepId))),
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
            yield* (yield* WorkflowRunRepository).blockRun({
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
            yield* (yield* WorkflowRunRepository).setBlockReason({
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
  merchantDismissFlag(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      callableEffect("ShopAgent.merchantDismissFlag", Domain.RunIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ runId }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).dismissFlag({
              runId,
            } satisfies Domain.DismissFlagCommand);
            yield* Effect.logInfo(
              `ShopAgent.merchantDismissFlag: shop=${shop} runId=${runId}`,
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
   * The five mutations below are `@callable()` on the member socket. Their
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
   * object's own SQLite, and it runs after the write so a step that just
   * became ready for another team is included.
   */
  private publishToTeams(
    target:
      | { readonly runStepId: string }
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
   * The Done count is read on every tab (`listDone` with `limit: 0` counts
   * without reading rows) because the strip shows it whatever is open; its
   * rows are read only when `query.tab` is "done".
   *
   * `query.team` narrows Done the same way it narrows the tiers, and a team
   * the member is not on narrows it to nothing — the same answer the
   * repository gives for the tiers, reached here because `listDone` takes the
   * team list already narrowed.
   */
  private readRuns(
    teamIds: readonly Domain.TeamId[],
    memberEmail: Domain.Email,
    query: Domain.RunQuery,
  ) {
    const shop = this.name;
    return Effect.gen(function* () {
      const repository = yield* WorkflowRunRepository;
      const started = yield* Clock.currentTimeMillis;
      const { counts, items } = yield* repository.listRuns({
        teamIds,
        memberEmail,
        query,
      });
      const doneTeamIds =
        query.team === null
          ? teamIds
          : teamIds.filter((teamId) => teamId === query.team);
      const done = yield* repository.listDone({
        teamIds: doneTeamIds,
        since: started - Domain.DONE_WINDOW_MS,
        limit: query.tab === "done" ? query.limit : 0,
      });
      /**
       * The fan-out this read was cut to bound, measured on real shops:
       * `rows` is what left the object, and it must stay at or under
       * `query.limit`.
       */
      const rows = query.tab === "done" ? done.items.length : items.length;
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
        counts: { ...counts, done: done.total },
        items,
        done: done.items,
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
  startStep(
    input: typeof Domain.StartStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runStepId: string) => this.publishToTeams({ runStepId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.startStep", Domain.StartStepInput, {
        onExcessProperty: "error",
      })(({ runStepId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).startStep({
              runStepId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
            } satisfies Domain.StartStepCommand);
            yield* Effect.logInfo(
              `ShopAgent.startStep: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runStepId))),
      )(input),
    );
  }

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  @callable()
  setStepNote(
    input: typeof Domain.SetStepNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runStepId: string) => this.publishToTeams({ runStepId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.setStepNote", Domain.SetStepNoteInput, {
        onExcessProperty: "error",
      })(({ runStepId, note }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).setStepNote({
              runStepId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
              note,
            } satisfies Domain.SetStepNoteCommand);
            yield* Effect.logInfo(
              `ShopAgent.setStepNote: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runStepId))),
      )(input),
    );
  }

  @callable()
  blockRun(
    input: typeof Domain.BlockRunInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.blockRun", Domain.BlockRunInput, {
        onExcessProperty: "error",
      })(({ runId, reason }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).blockRun({
              runId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
              reason,
            } satisfies Domain.BlockRunCommand);
            yield* Effect.logInfo(
              `ShopAgent.blockRun: shop=${shop} runId=${runId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  setBlockReason(
    input: typeof Domain.SetBlockReasonInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.setBlockReason",
        Domain.SetBlockReasonInput,
        { onExcessProperty: "error" },
      )(({ runId, reason }, { memberId, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).setBlockReason({
              runId,
              teamIds,
              reason,
            } satisfies Domain.SetBlockReasonCommand);
            yield* Effect.logInfo(
              `ShopAgent.setBlockReason: shop=${shop} runId=${runId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runId))),
      )(input),
    );
  }

  @callable()
  completeStep(
    input: typeof Domain.CompleteStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runStepId: string) => this.publishToTeams({ runStepId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.completeStep", Domain.CompleteStepInput, {
        onExcessProperty: "error",
      })(({ runStepId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).completeStep({
              runStepId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
            } satisfies Domain.CompleteStepCommand);
            yield* Effect.logInfo(
              `ShopAgent.completeStep: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runStepId))),
      )(input),
    );
  }

  /**
   * Undo. Publishes to the order's teams like the others: the merchant's
   * order page shows every run of the order.
   */
  @callable()
  uncompleteStep(
    input: typeof Domain.UncompleteStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = (runStepId: string) => this.publishToTeams({ runStepId });
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.uncompleteStep",
        Domain.UncompleteStepInput,
        { onExcessProperty: "error" },
      )(({ runStepId }, { memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).uncompleteStep({
              runStepId,
              actor: { role: "member", memberId, email: memberEmail },
              teamIds,
            } satisfies Domain.UncompleteStepCommand);
            yield* Effect.logInfo(
              `ShopAgent.uncompleteStep: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(() => publish(runStepId))),
      )(input),
    );
  }

  private readRunView(input: {
    readonly runId: string;
    readonly teamIds: readonly string[];
  }) {
    return WorkflowRunRepository.pipe(
      Effect.flatMap((repository) => repository.getRunView(input)),
      Effect.map(Option.getOrNull),
    );
  }

  /** The work page's loader read; plain RPC for the same reason as {@link listRuns}. */
  getRunForMember(
    input: typeof Domain.GetRunForMemberInput.Encoded,
  ): Promise<Domain.RunView | null> {
    const readRunView = (input: Domain.GetRunForMemberInput) =>
      this.readRunView(input);
    return this.runEffect(
      callableEffect("ShopAgent.getRunForMember", Domain.GetRunForMemberInput, {
        role: "rpc",
      })((input) => readRunView(input))(input),
    );
  }

  /**
   * The socket twin of {@link getRunForMember}, as `subscribeRuns` is of
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
  dismissFlag(
    input: typeof Domain.DismissFlagInput.Encoded,
  ): Promise<Domain.RunResult> {
    const publish = (runId: string) => this.publishToTeams({ runId });
    return this.runEffect(
      memberCallableEffect("ShopAgent.dismissFlag", Domain.DismissFlagInput, {
        onExcessProperty: "error",
      })(({ runId }, { teamIds }) =>
        runResult(
          WorkflowRunRepository.pipe(
            Effect.flatMap((repository) =>
              repository.dismissFlag({
                runId,
                teamIds,
              } satisfies Domain.DismissFlagCommand),
            ),
          ),
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
  ): Promise<Domain.StepResult> {
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect("ShopAgent.addStep", Domain.AddStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId, name, teamId, instructions }) =>
        stepResult(
          Effect.gen(function* () {
            const team = yield* teamExists(teamId);
            if (team === null) return { _tag: "TeamNotFound" };
            const step = yield* (yield* WorkflowRepository).addStep({
              workflowId,
              name,
              teamId: team.id,
              instructions: instructions ?? null,
            });
            return { _tag: "Ok", step };
          }),
        ),
      )(input),
    );
  }

  /** `StageNotFoundError` surfaces as `NotFound`: the stage the editor showed was closed by a concurrent edit. */
  @callable()
  addParallelStep(
    input: typeof Domain.AddParallelStepInput.Encoded,
  ): Promise<Domain.StepResult> {
    const shop = this.name;
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect("ShopAgent.addParallelStep", Domain.AddParallelStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ workflowId, stage, name, teamId, instructions }) =>
        stepResult(
          Effect.gen(function* () {
            const team = yield* teamExists(teamId);
            if (team === null) return { _tag: "TeamNotFound" };
            const step = yield* (yield* WorkflowRepository).addParallelStep({
              workflowId,
              stage,
              name,
              teamId: team.id,
              instructions: instructions ?? null,
            });
            yield* Effect.logInfo(
              `ShopAgent.addParallelStep: shop=${shop} workflowId=${workflowId} stage=${String(stage)}`,
            ).pipe(Effect.annotateLogs({ shop, workflowId, stage }));
            return { _tag: "Ok", step };
          }),
        ),
      )(input),
    );
  }

  @callable()
  updateStep(
    input: typeof Domain.UpdateStepInput.Encoded,
  ): Promise<Domain.StepResult> {
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect("ShopAgent.updateStep", Domain.UpdateStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ stepId, name, teamId, instructions }) =>
        stepResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const team = yield* teamExists(teamId);
            if (team === null) return { _tag: "TeamNotFound" };
            const step = yield* repository.updateStep({
              stepId,
              name,
              teamId: team.id,
              instructions,
            });
            return { _tag: "Ok", step };
          }),
        ),
      )(input),
    );
  }

  @callable()
  moveStep(
    input: typeof Domain.MoveStepInput.Encoded,
  ): Promise<Domain.StepResult> {
    return this.runEffect(
      callableEffect("ShopAgent.moveStep", Domain.MoveStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ stepId, direction }) =>
        stepResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRepository).moveStep({ stepId, direction });
            return { _tag: "Ok", step: null };
          }),
        ),
      )(input),
    );
  }

  @callable()
  separateStep(
    input: typeof Domain.SeparateStepInput.Encoded,
  ): Promise<Domain.StepResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.separateStep", Domain.SeparateStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ stepId }) =>
        stepResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getStep({ stepId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            yield* repository.separateStep({ stepId });
            yield* Effect.logInfo(
              `ShopAgent.separateStep: shop=${shop} workflowId=${existing.value.workflow.id} stage=${String(existing.value.step.stage)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                workflowId: existing.value.workflow.id,
                stage: existing.value.step.stage,
              }),
            );
            return { _tag: "Ok", step: null };
          }),
        ),
      )(input),
    );
  }

  @callable()
  joinStep(
    input: typeof Domain.JoinStepInput.Encoded,
  ): Promise<Domain.StepResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.joinStep", Domain.JoinStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ stepId }) =>
        stepResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getStep({ stepId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            yield* repository.joinStep({ stepId });
            yield* Effect.logInfo(
              `ShopAgent.joinStep: shop=${shop} workflowId=${existing.value.workflow.id} stage=${String(existing.value.step.stage)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                workflowId: existing.value.workflow.id,
                stage: existing.value.step.stage,
              }),
            );
            return { _tag: "Ok", step: null };
          }),
        ),
      )(input),
    );
  }

  @callable()
  removeStep(
    input: typeof Domain.StepIdInput.Encoded,
  ): Promise<Domain.StepResult> {
    return this.runEffect(
      callableEffect("ShopAgent.removeStep", Domain.StepIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ stepId }) =>
        stepResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRepository).removeStep({ stepId });
            return { _tag: "Ok", step: null };
          }),
        ),
      )(input),
    );
  }

  /**
   * Delete a team and its steps become unassigned. Two stores, two writes,
   * D1 first: the two cannot share a transaction, and the order is what
   * closes the race with a concurrent `addStep` / `updateStep` pointing at
   * this team. Its `teamExists` check reads D1; if that read lands after the
   * D1 delete the write is refused, and if it lands before but the step
   * write lands before the nulling, the nulling catches it — the object is
   * single-threaded, so nothing interleaves with the nulling itself. The
   * reverse order would let a step written between the nulling and the D1
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
   * Points any open run step at a team, started or not: the remedy for an
   * unassigned step (see `deleteTeam`) and the merchant's way to move work
   * between teams. The team is checked against the live D1 roster here, as
   * `addStep` does, and its name is snapshotted onto the step from that same
   * read. Only `teamId` / `teamName` change, so a started step keeps
   * `startedBy*`; a finished step is refused (`StepFinished`).
   */
  @callable()
  assignRunStepTeam(
    input: typeof Domain.AssignRunStepTeamInput.Encoded,
  ): Promise<Domain.AssignRunStepTeamResult> {
    const shop = this.name;
    const publish = (teams: PublishTeams) => this.publish("all", teams);
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect(
        "ShopAgent.assignRunStepTeam",
        Domain.AssignRunStepTeamInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )(({ runStepId, teamId }) =>
        Effect.gen(function* () {
          const team = yield* teamExists(teamId);
          if (team === null)
            return {
              _tag: "TeamNotFound",
            } satisfies Domain.AssignRunStepTeamResult;
          /**
           * Both sides of the move: the team losing the step is only nameable
           * before the write, and the team gaining it only after, so the
           * lists that change are the union of the two reads.
           */
          const before = yield* orderTeamIds({ runStepId });
          yield* (yield* WorkflowRunRepository).assignRunStepTeam({
            runStepId,
            team: { id: team.id, name: team.name },
          });
          yield* Effect.logInfo(
            `ShopAgent.assignRunStepTeam: shop=${shop} step=${runStepId} teamId=${teamId}`,
          ).pipe(Effect.annotateLogs({ shop, step: runStepId, teamId }));
          yield* publish(
            unionTeams(before, yield* orderTeamIds({ runStepId })),
          );
          return { _tag: "Assigned" } satisfies Domain.AssignRunStepTeamResult;
        }).pipe(
          Effect.catchTags({
            RunNotFoundError: () =>
              Effect.succeed<Domain.AssignRunStepTeamResult>({
                _tag: "NotFound",
              }),
            StepFinishedError: () =>
              Effect.succeed<Domain.AssignRunStepTeamResult>({
                _tag: "StepFinished",
              }),
            RunTerminalError: () =>
              Effect.succeed<Domain.AssignRunStepTeamResult>({
                _tag: "RunNotOpen",
              }),
          }),
        ),
      )(input),
    );
  }

  /**
   * Development seed: replaces this shop's workflow definitions (and every
   * run) with `input.workflows` in one transaction. One callable rather than
   * `createWorkflow` + an `addStep` round trip per step, so the fixture
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
   * delete, and a run outlives the order it names. `api.dev.seed.ts` always
   * calls both, in that order.
   *
   * Returns each workflow's minted id so the caller can point a line item at
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
   * the fixture exercises run creation, and `done` finishes steps through
   * `completeStep` with the step's own team so the readiness gate is
   * exercised the way it is on the floor. `advance`, `started`, and
   * `blocked` go through the same actions for the same reason: a seeded
   * "step 2 of 3, in progress, blocked" card is indistinguishable from one a
   * worker produced. Only rows under `SEED_ORDER_ID_PREFIX` are replaced;
   * synced orders are left alone.
   *
   * Four phases per order, in this order (`Domain.SeedOrdersInput` says what
   * each key means): upsert and reconcile; each item's `workflowId` through
   * `setRun`, the merchant's own Choose; progress, dispatched per run so one
   * order's items can be in different states; then the order's `after` state
   * through a second upsert, which is the only way to reach the flags that
   * need the change to land *after* a run exists.
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
          const runs = yield* WorkflowRunRepository;
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
          const actor = (step: Domain.WorkflowRunStep) => ({
            runStepId: step.id,
            actor: memberActor,
            teamIds: step.teamId === null ? [] : [step.teamId],
          });
          const stepCommand = (
            step: Domain.WorkflowRunStep,
            merchant: boolean,
          ) => (merchant ? merchantStepCommand(step) : actor(step));
          // Reloaded before every phase rather than carried: each phase
          // completes steps, which changes what the next one may touch.
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
          const completeRun = (runId: string, merchant: boolean) =>
            Effect.gen(function* () {
              const detail = yield* openRun(runId);
              if (detail === null) return;
              yield* Effect.forEach(
                detail.steps,
                (step) => runs.completeStep(stepCommand(step, merchant)),
                { discard: true },
              );
              yield* Effect.logInfo(
                `ShopAgent.seedOrders: orderId=${detail.run.orderId} runId=${runId}: completed`,
              ).pipe(
                Effect.annotateLogs({ orderId: detail.run.orderId, runId }),
              );
            });
          /** One round: every step ready at the start of the round gets completed; what that makes ready waits for the next. */
          const advanceRun = (runId: string, merchant: boolean) =>
            Effect.gen(function* () {
              const detail = yield* openRun(runId);
              if (detail === null) return;
              yield* Effect.forEach(
                seedReadySteps([detail]),
                (step) => runs.completeStep(stepCommand(step, merchant)),
                { discard: true },
              );
            });
          const startRun = (runId: string) =>
            Effect.gen(function* () {
              const detail = yield* openRun(runId);
              if (detail === null) return;
              yield* Effect.forEach(
                detail.steps.filter((step) => step.completedAt === null),
                (step) =>
                  runs
                    .startStep(actor(step))
                    .pipe(
                      Effect.catchTag("StepNotReadyError", () => Effect.void),
                    ),
                { discard: true },
              );
            });
          const blockOneRun = (
            runId: string,
            reason: Domain.StepNote,
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
                        teamIds: detail.steps.flatMap((step) =>
                          step.teamId === null ? [] : [step.teamId],
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
              if (progress.done === true) yield* completeRun(runId, merchant);
              for (let round = 0; round < (progress.advance ?? 0); round += 1)
                yield* advanceRun(runId, merchant);
              if (progress.started === true) yield* startRun(runId);
              if (progress.blocked !== undefined)
                yield* blockOneRun(runId, progress.blocked, merchant);
            });
          /**
           * The merchant's own Choose, on a line item the seed wrote moments
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
                ? { workflow: found.value.workflow, steps: found.value.steps }
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
          // Orders, line items, runs and the usage they counted, together;
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
              customAttributes: [],
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
                  unfulfilledQuantity:
                    override?.unfulfilledQuantity ??
                    item.unfulfilledQuantity ??
                    currentQuantity,
                  nonFulfillableQuantity: 0,
                  productTags: item.tags,
                  matchedWorkflowIds: [],
                  customAttributes: item.customAttributes ?? [],
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
   * loader via `ShopAgentClient`, so nothing browser-side calls it. Step
   * ownership is configuration that only changes on the workflow pages, and a
   * loader read refreshes with `router.invalidate` and paints during SSR,
   * which a socket query without a push listener cannot do.
   */
  listStepsOwnedBy(
    input: typeof Domain.TeamIdInput.Encoded,
  ): Promise<readonly Domain.OwnedStep[]> {
    return this.runEffect(
      callableEffect("ShopAgent.listStepsOwnedBy", Domain.TeamIdInput, {
        role: "rpc",
      })(({ teamId }) =>
        WorkflowRepository.pipe(
          Effect.flatMap((repository) =>
            repository.listStepsOwnedBy({ teamId }),
          ),
        ),
      )(input),
    );
  }

  /** Plain RPC for the same reason as {@link listStepsOwnedBy}: the teams index's "Used by" column, read by its loader. */
  listOwnedSteps(): Promise<readonly Domain.OwnedStepByTeam[]> {
    return this.runEffect(
      WorkflowRepository.pipe(
        Effect.flatMap((repository) => repository.listOwnedSteps()),
        Effect.withLogSpan("ShopAgent.listOwnedSteps"),
      ),
    );
  }

  /** Plain RPC for the same reason as {@link listStepsOwnedBy}: the delete dialogs' counts, read by the team pages' loaders. */
  countStepsByTeam(): Promise<readonly Domain.TeamStepCounts[]> {
    return this.runEffect(
      WorkflowRepository.pipe(
        Effect.flatMap((repository) => repository.countStepsByTeam()),
        Effect.withLogSpan("ShopAgent.countStepsByTeam"),
      ),
    );
  }
}

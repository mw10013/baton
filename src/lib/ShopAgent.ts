import type * as ShopifyApi from "@shopify/shopify-api";

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-do";
import { Agent, callable, getCurrentAgent, type Connection } from "agents";
import {
  Cause,
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
import {
  OrderRepository,
  type OrderRepositoryError,
} from "@/lib/OrderRepository";
import {
  orderSyncQuery,
  OrderSyncResponse,
  orderSyncVariables,
  toOrderLineItem,
  toOrderRaw,
  toShopOrder,
} from "@/lib/OrderSync";
import {
  ORDER_SYNC_WINDOW_DAYS,
  ORDER_SYNC_OVERLAP_MS,
  ORDERS_SYNC_WORKFLOW_NAME,
} from "@/lib/orderSyncConstants";
import { Repository, type RepositoryError } from "@/lib/Repository";
import { runShopAgentOrdersStream } from "@/lib/ShopAgentOrdersStream";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";
import {
  type NoDraftError,
  type NoStepsError,
  type SingletonWorkflowError,
  type StageNotFoundError,
  type StepNotFoundError,
  type StepUnassignedError,
  type WorkflowLimitError,
  type WorkflowNameTakenError,
  type WorkflowNotFoundError,
  type WorkflowOffError,
  WorkflowRepository,
  WorkflowRepositoryError,
} from "@/lib/WorkflowRepository";
import {
  canStart,
  type StartContext,
  type RunNotAllowedError,
  type RunNotFoundError,
  type RunTerminalError,
  type StepNotReadyError,
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
 * Scaffolding shared by every decoding ShopAgent RPC method: decode the wire
 * input against `schema`, hand the decoded value to the business `handler`,
 * and wrap both under `Effect.withLogSpan(name)`.
 *
 * Data-last and curried:
 * `callableEffect(name, schema, options?)(handler)(input)` — a method body is
 * just `this.runEffect(callableEffect(...)(businessHandler)(input))`.
 *
 * `options` passes through to `Schema.decodeUnknownEffect`, which accepts
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
    options?: SchemaAST.ParseOptions,
  ) =>
  <B, E, R>(handler: (input: A) => Effect.Effect<B, E, R>) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(
      schema,
      options,
    )(input).pipe(Effect.flatMap(handler), Effect.withLogSpan(name));

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
 * delivery may arrive more than once. `SyncState` is one row under
 * `check (id = 1)`, seeded here so every read is a plain `select` and the
 * reservation write in `syncOrders` is an `update` that cannot race an insert.
 *
 * The `(processedAt desc, id desc)` index is the keyset the orders page pages
 * on; `id desc` is in it so the tiebreak is index-ordered too, since a shop
 * can place several orders in the same millisecond.
 *
 * `Workflow` / `WorkflowStep` are the production-workflow *definitions* a
 * merchant configures: what starts runs. `WorkflowDraft` / `WorkflowDraftStep`
 * are the merchant's private copy under edit (see the vocabulary on
 * `Domain.Workflow`): Edit copies the workflow's tags and steps into the
 * draft, every editor write lands on the draft, Apply replaces the workflow's
 * tags and steps with the draft's and deletes it, Discard deletes it — each in
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
 * Item and order workflows (`type`) share these four tables on purpose: they
 * differ in one column and one cardinality rule, and in nothing about steps,
 * stages, drafts, team pointers, or the on/off switch. An order workflow has
 * no product tags — `tags` is `'[]'` under the `check`, and
 * `Domain.OrderWorkflow` has no `tags` field at all — and there is exactly
 * one per shop: the singleton row `id = 'order'`, `name = 'Order workflow'`,
 * inserted below and never deleted, renamed, or duplicated. The table
 * `check` forbids any other row of `type = 'order'` and any other name on
 * this one; `Workflow_order_uidx` (a partial unique index on the constant
 * `type`) is the second backstop. Separate `OrderWorkflow*` tables were
 * considered and rejected: they would duplicate every step/draft query for
 * one missing column.
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
 * to one line item **or to one order**, with the definition's steps copied
 * in. An order run (`Workflow.type = 'order'`) has `lineItemId` and the
 * three line-item snapshot columns null together (the `check`), is created
 * with the item runs, and its steps become ready once every item run on the
 * order is finished with at least one done (`readyWhere`;
 * `WorkflowRun_order_items_idx` serves that gate on every queue read). Every
 * display field is a snapshot and there is no foreign key to `ShopOrder`,
 * `OrderLineItem`, or `Workflow` — a run must survive an order delete, a
 * line item dropped by an edit, and a definition edit or rename, because it
 * is the record of work someone may already have started. `unique (lineItemId,
 * workflowId)` spans every status so a cancelled run keeps its key: neither
 * the sync nor manual attach can create a second one, and recovery from a
 * mistaken cancel is un-cancel. SQLite treats nulls as distinct in that
 * constraint, so the partial `WorkflowRun_order_uidx` is what makes an order
 * run single-use per `(orderId, workflowId)`. `status` is denormalized from the steps for
 * the queue and the definitions badge; every step write recomputes it in the
 * same transaction. `(teamId, completedAt)` serves the member queue, which
 * asks for open steps by team. `WorkflowRunStep.teamId` is nullable for the
 * same reason as `WorkflowStep.teamId`: a team delete nulls it on open steps
 * (unassigned, in nobody's queue until a person assigns a team) and leaves
 * finished steps alone, whose `teamName` snapshot is all history needs.
 * `startedByEmail` / `completedByEmail` snapshot the actor the same way, so
 * a member delete never leaves history resolving to nobody. A run step is
 * *ready* when it is open and no step in an earlier `stage` of the same run
 * is still open, so several steps of one run can be ready at once;
 * `startedAt` / `startedBy` record Start and make the run `active` before
 * anything is completed; `note` is worker text about this particular item.
 * `flag = 'blocked'` is the one flag a person sets (with an optional reason
 * and `byEmail` in `flagDetail`) rather than reconcile.
 */
const initializeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
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
      tags text not null,
      note text,
      customAttributes text not null,
      lineItemsComplete integer not null,
      raw text not null,
      syncedAt integer not null,
      syncSource text not null
    );
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
    create table if not exists SyncState (
      id integer primary key check (id = 1),
      workflowId text,
      startedAt integer,
      lastFullSyncAt integer,
      lastFullSyncWindowStart integer,
      lastError text
    );
    insert or ignore into SyncState (id) values (1);
    create table if not exists Workflow (
      id text primary key,
      name text not null check (name = trim(name) and length(name) > 0),
      type text not null default 'item' check (type in ('item', 'order')),
      activatedAt integer,
      tags text not null default '[]'
        check (type = 'item' or tags = '[]'),
      createdAt integer not null,
      updatedAt integer not null,
      check (type <> 'order' or (id = 'order' and name = 'Order workflow'))
    );
    create unique index if not exists Workflow_name_uidx
      on Workflow (name collate nocase);
    create unique index if not exists Workflow_order_uidx
      on Workflow (type) where type = 'order';
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
      tags text not null default '[]',
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
      lineItemId text,
      lineItemTitle text,
      variantTitle text,
      sku text,
      quantity integer,
      customAttributes text,
      source text not null check (source in ('tag', 'manual')),
      status text not null check (status in ('pending', 'active', 'done', 'cancelled')),
      flag text check (flag in ('item_removed', 'quantity_changed', 'order_cancelled', 'order_deleted', 'blocked', 'item_added', 'order_fulfilled')),
      flagAt integer,
      flagDetail text,
      createdAt integer not null,
      updatedAt integer not null,
      cancelledAt integer,
      check ((lineItemId is null) = (lineItemTitle is null)
         and (lineItemId is null) = (quantity is null)
         and (lineItemId is null) = (customAttributes is null)),
      unique (lineItemId, workflowId)
    );
    create unique index if not exists WorkflowRun_order_uidx
      on WorkflowRun (orderId, workflowId) where lineItemId is null;
    create index if not exists WorkflowRun_orderId_idx on WorkflowRun (orderId);
    create index if not exists WorkflowRun_status_idx on WorkflowRun (status);
    create index if not exists WorkflowRun_order_items_idx
      on WorkflowRun (orderId, lineItemId, status);
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
      unique (runId, position)
    );
    create index if not exists WorkflowRunStep_teamId_idx
      on WorkflowRunStep (teamId, completedAt);
  `;
  // The order workflow singleton, off and empty, the way `SyncState` is
  // seeded: a fixed row the merchant fills in and switches, never creates or
  // deletes. Its own statement because the timestamps are bound parameters
  // and the block above is parameter-free DDL. `insert or ignore` on the
  // primary key keeps it idempotent.
  yield* sql`
    insert or ignore into Workflow (id, name, type, activatedAt, tags, createdAt, updatedAt)
    values (${Domain.ORDER_WORKFLOW_ID}, ${Domain.ORDER_WORKFLOW_NAME}, 'order', null, '[]', ${now}, ${now})
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

const shopInfoQuery = `#graphql
  query ShopInfo {
    shop {
      name
      myshopifyDomain
    }
  }`;

const ShopInfoResponse = Schema.Struct({ shop: Domain.ShopInfo });

/**
 * Maps the repository's expected failures onto the tagged result union the
 * page decodes, leaving faults (`SqlError`, decode errors) to propagate and
 * become a thrown `Error` at the `runEffect` seam. Expected failures must be
 * *values* here because that seam collapses every failure into one message
 * string, which would leave the browser unable to tell "name taken" (a field
 * error) from "limit reached" (a banner).
 */
const workflowResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
    | WorkflowNameTakenError
    | WorkflowNotFoundError
    | WorkflowLimitError
    | SingletonWorkflowError
    | SqlError.SqlError
    | WorkflowRepositoryError,
    R
  >,
): Effect.Effect<
  Domain.WorkflowResult,
  SqlError.SqlError | WorkflowRepositoryError,
  R
> =>
  effect.pipe(
    Effect.map((workflow): Domain.WorkflowResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowNameTakenError: () =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "NameTaken" }),
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "Limit", limit }),
      SingletonWorkflowError: () =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "Singleton" }),
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

/** `Ok` carries how many runs the reconcile-all after Turn on started, for the toast. */
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
 * that can start an order run load the start context (active definitions
 * from this object, teams from D1) first.
 */
const runResult = <R>(
  effect: Effect.Effect<
    void,
    | RunNotFoundError
    | RunTerminalError
    | RunNotAllowedError
    | StepNotReadyError
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
      RunNotAllowedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotAllowed" }),
      StepNotReadyError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotReady" }),
    }),
  );

const SHOP_AGENT_BINDING = "SHOP_AGENT";

/**
 * How long a reservation is trusted on its own. Past this the Durable Object
 * asks Cloudflare whether the instance is really still running, so a callback
 * lost to a crash cannot wedge the button forever. Comfortably longer than the
 * poll schedule's ~10.5-minute ceiling plus the stream.
 */
const SYNC_RESERVATION_TTL_MS = 60 * 60 * 1000;

const isWorkflowInstanceNotFoundError = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("instance.not_found");

/**
 * Cloudflare instance ids must start with `[a-zA-Z0-9_]`, so the shop's dots
 * are folded out. The `startedAt` suffix makes every run a fresh id: the
 * "only one sync per shop" rule is a business invariant living in `SyncState`,
 * not something to encode in Cloudflare's id space, where a fixed id would
 * force an already-exists/inspect/restart dance on every click.
 */
const ordersSyncWorkflowId = (shop: string, startedAt: number) =>
  `orders-sync_${shop.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}_${String(startedAt)}`;

/**
 * `Option.none()` means Cloudflare says the instance does not exist. Any other
 * failure is deliberately reported as "still there": treating an unreachable
 * control plane as proof of absence would release a reservation held by a run
 * that is very much alive.
 */
const ordersSyncWorkflowExists = (
  workflow: Workflow,
  id: string,
): Effect.Effect<boolean> =>
  Effect.tryPromise(() => workflow.get(id)).pipe(
    Effect.flatMap((instance) => Effect.tryPromise(() => instance.status())),
    Effect.as(true),
    Effect.catch((error) =>
      Effect.succeed(!isWorkflowInstanceNotFoundError(error.cause)),
    ),
  );

/**
 * Where the next window starts, and which timestamp to filter on.
 *
 * The first sync has nothing stored and asks for orders *placed* inside the
 * window. Every later sync asks for orders *touched* since the last one, minus
 * an overlap, and never reaches back past the window Shopify grants without
 * `read_all_orders`. `updated_at` is what makes an old order edited yesterday
 * show up — the reconciliation job Shopify tells apps to back webhooks with.
 */
const orderSyncWindow = (
  now: number,
  lastFullSyncAt: number | null,
): { readonly field: Domain.OrderSyncField; readonly windowStart: number } => {
  const earliest = now - ORDER_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return lastFullSyncAt === null
    ? { field: "created_at", windowStart: earliest }
    : {
        field: "updated_at",
        windowStart: Math.max(lastFullSyncAt - ORDER_SYNC_OVERLAP_MS, earliest),
      };
};

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

const OrdersSyncErrorInput = Schema.Struct({
  startedAt: Schema.Number,
  message: Schema.String,
});

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

const isOpen = (run: Domain.WorkflowRun) =>
  run.status === "pending" || run.status === "active";

/**
 * Readiness decided on a snapshot taken before any step of the
 * round is completed: completing stage 1 makes stage 2 ready at
 * once, and finishing the last item makes the order run ready, so
 * asking `completeStep` as the loop goes would run the whole order
 * to done in one round. Same rule as the repository's ready query:
 * open, nothing open in an earlier stage of the run, and for an
 * order run no open item run and at least one done.
 */
const seedReadySteps = (
  details: readonly Domain.WorkflowRunDetail[],
): Domain.WorkflowRunStep[] => {
  const itemRuns = details.filter(({ run }) => !Domain.isOrderRun(run));
  const orderRunReady =
    !itemRuns.some(({ run }) => isOpen(run)) &&
    itemRuns.some(({ run }) => run.status === "done");
  return details.flatMap(({ run, steps }) => {
    if (!isOpen(run)) return [];
    if (Domain.isOrderRun(run) && !orderRunReady) return [];
    return steps.filter(
      (step) =>
        step.completedAt === null &&
        !steps.some(
          (earlier) =>
            earlier.completedAt === null && earlier.stage < step.stage,
        ),
    );
  });
};

export class ShopAgent extends Agent {
  declare private readonly runEffect: ReturnType<typeof makeRunEffect>;

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

  private subscription(connection: Connection): Domain.Subscription | null {
    return Option.getOrNull(
      Schema.decodeUnknownOption(Domain.SubscriptionState)(connection.state, {
        onExcessProperty: "error",
      }),
    );
  }

  private connections() {
    return Effect.try({
      try: () => [...this.getConnections()],
      catch: (cause) =>
        new ShopAgentNotifyError({ message: "getConnections failed", cause }),
    });
  }

  private publishTo(connection: Connection, touched: PublishScope) {
    return Effect.try({
      try: () => {
        const state = this.subscription(connection);
        if (
          state &&
          (touched === "all" ||
            state.orderId === null ||
            touched.includes(state.orderId))
        )
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
   * starts runs, which the order page's `orderWorkflow` / `itemWorkflows`
   * show, so those two publish `"all"`.
   */
  private publish(touched: PublishScope) {
    return this.connections().pipe(
      Effect.flatMap((connections) =>
        Effect.forEach(
          connections,
          (connection) => this.publishTo(connection, touched),
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
        onExcessProperty: "error",
      })(({ subscriberId }) =>
        Effect.sync(() => {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (
            connection &&
            this.subscription(connection)?.subscriberId === subscriberId
          )
            connection.setState(null);
        }),
      )(input),
    );
  }

  /**
   * Reads the shop back out of the Shopify Admin API from inside the object,
   * using the offline session `ensureShopSession` resolves (and refreshes) from D1.
   *
   * Not `@callable()`: it spends a Shopify API call, so it stays on the
   * `ShopAgentClient` path where the Worker has already authenticated the
   * request.
   */
  getShopInfo(): Promise<Domain.ShopInfo> {
    const name = this.name;
    return this.runEffect(
      Effect.gen(function* () {
        const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(name);
        const session = yield* (yield* Shopify).ensureShopSession(shop);
        const { shop: info } = yield* ShopifyAdmin.pipe(
          Effect.flatMap((admin) =>
            admin.graphqlDecode(ShopInfoResponse, shopInfoQuery),
          ),
          Effect.provide(shopifyAdminLayer(session)),
        );
        return info;
      }).pipe(Effect.withLogSpan("ShopAgent.getShopInfo")),
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
      const lineItemsComplete = !order.lineItems.pageInfo.hasNextPage;
      if (!lineItemsComplete)
        yield* Effect.logError(
          `ShopAgent.fetchAndUpsertOrder: shop=${shop} orderId=${orderId}: line items truncated, merging instead of replacing`,
        ).pipe(Effect.annotateLogs({ shop, orderId, source }));
      const reconcile = yield* reconciler();
      const shopOrder = toShopOrder({
        node: order,
        source,
        syncedAt: yield* Clock.currentTimeMillis,
        lineItemsComplete,
      });
      const { written } = yield* (yield* OrderRepository).upsertOrder({
        order: shopOrder,
        raw: toOrderRaw(order),
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
   * Starts the 30-day window sync, or reports the one already running.
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
   * The reservation is written **before** `runWorkflow`, which creates the
   * Cloudflare instance and only then inserts its tracking row — two writes
   * that cannot be one transaction. Reserving first means a throw between them
   * leaves a claim to verify against `status()` rather than a running sync
   * behind a re-enabled button. Durable Object output gates hold the outgoing
   * `create` until the preceding SQLite write is durable, so the reservation
   * cannot be lost to the same fault that loses the tracking row.
   */
  @callable()
  syncOrders(): Promise<Domain.SyncState> {
    const shop = this.name;
    const workflow = this.env.ORDERS_SYNC_WORKFLOW;
    const runWorkflow = (
      params: {
        readonly shop: string;
        readonly startedAt: number;
        readonly windowStart: number;
        readonly field: Domain.OrderSyncField;
      },
      id: string,
    ) =>
      Effect.tryPromise(() =>
        this.runWorkflow(ORDERS_SYNC_WORKFLOW_NAME, params, {
          id,
          agentBinding: SHOP_AGENT_BINDING,
        }),
      );
    const publish = () => this.publish("all");
    return this.runEffect(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const now = yield* Clock.currentTimeMillis;
        const current = yield* repository.getSyncState();
        if (current.workflowId !== null && current.startedAt !== null) {
          const fresh = now - current.startedAt < SYNC_RESERVATION_TTL_MS;
          if (
            fresh ||
            (yield* ordersSyncWorkflowExists(workflow, current.workflowId))
          ) {
            yield* Effect.logInfo(
              `ShopAgent.syncOrders: shop=${shop} status=in-flight`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                status: "in-flight",
                workflowId: current.workflowId,
              }),
            );
            return current;
          }
          yield* repository.clearSync();
        }
        const { field, windowStart } = orderSyncWindow(
          now,
          current.lastFullSyncAt,
        );
        const id = ordersSyncWorkflowId(shop, now);
        const reserved = yield* repository.reserveSync({
          workflowId: id,
          startedAt: now,
          windowStart,
        });
        /**
         * `runWorkflow` can create the instance and still throw on its tracking
         * insert. If the instance exists the run is live and the reservation is
         * correct, so the throw is swallowed and only the tracking row is lost —
         * which nothing here reads. A genuinely absent instance releases the
         * claim and surfaces.
         */
        yield* runWorkflow(
          { shop, startedAt: now, windowStart, field },
          id,
        ).pipe(
          Effect.catch((error) =>
            Effect.flatMap(
              ordersSyncWorkflowExists(workflow, id),
              (
                exists,
              ): Effect.Effect<
                void,
                typeof error | SqlError.SqlError | OrderRepositoryError
              > =>
                exists
                  ? Effect.logWarning(
                      `ShopAgent.syncOrders: shop=${shop} status=untracked: ${causeToErrorMessage(Cause.fail(error))}`,
                    ).pipe(
                      Effect.annotateLogs({
                        shop,
                        status: "untracked",
                        workflowId: id,
                      }),
                    )
                  : Effect.andThen(repository.clearSync(), Effect.fail(error)),
            ),
          ),
        );
        yield* Effect.logInfo(
          `ShopAgent.syncOrders: shop=${shop} status=started field=${field}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            status: "started",
            field,
            windowStart,
            workflowId: id,
          }),
        );
        yield* publish();
        return reserved;
      }).pipe(Effect.withLogSpan("ShopAgent.syncOrders")),
    );
  }

  /**
   * RPC target for the workflow, not `@callable()`: nothing browser-side calls
   * it, and it takes a URL that must only ever come from a bulk operation this
   * shop started.
   */
  onOrdersStream(input: { readonly url: string }): Promise<{
    readonly ordersSeen: number;
    readonly ordersUpserted: number;
    readonly lineItemsUpserted: number;
  }> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const reconciler = () => this.reconciler("bulk");
    return this.runEffect(
      callableEffect(
        "ShopAgent.onOrdersStream",
        OrdersStreamInput,
      )(({ url }) =>
        Effect.gen(function* () {
          const counts = yield* runShopAgentOrdersStream({
            url,
            afterWrite: yield* reconciler(),
          });
          yield* Effect.logInfo(
            `ShopAgent.onOrdersStream: shop=${shop} ordersSeen=${String(counts.ordersSeen)} ordersUpserted=${String(counts.ordersUpserted)} lineItemsUpserted=${String(counts.lineItemsUpserted)}`,
          ).pipe(Effect.annotateLogs({ shop, ...counts }));
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
   * so the message survives even if the callback that follows never arrives.
   */
  onOrdersSyncError(input: {
    readonly startedAt: number;
    readonly message: string;
  }): Promise<void> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect(
        "ShopAgent.onOrdersSyncError",
        OrdersSyncErrorInput,
      )(({ startedAt, message }) =>
        Effect.gen(function* () {
          yield* Effect.logError(
            `ShopAgent.onOrdersSyncError: shop=${shop}: ${message}`,
          ).pipe(Effect.annotateLogs({ shop, startedAt, message }));
          yield* (yield* OrderRepository).failSync({
            startedAt,
            error: message,
          });
          yield* publish();
        }),
      )(input),
    );
  }

  /**
   * Completion is recorded here rather than at the end of the stream: a file
   * that streams halfway and then fails must not leave `lastFullSyncAt`
   * claiming the window was covered, or the next run's `updated_at` bound would
   * skip everything the failed run never read.
   */
  override async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown,
  ): Promise<void> {
    if (workflowName !== ORDERS_SYNC_WORKFLOW_NAME) return;
    const shop = this.name;
    const deleteWorkflow = () => this.deleteWorkflow(workflowId);
    const publish = () => this.publish("all");
    await this.runEffect(
      callableEffect(
        "ShopAgent.onWorkflowComplete",
        Domain.OrdersSyncResult,
      )(({ startedAt }) =>
        Effect.gen(function* () {
          const state = yield* (yield* OrderRepository).completeSync({
            startedAt,
          });
          yield* Effect.logInfo(
            `ShopAgent.onWorkflowComplete: shop=${shop} workflowId=${workflowId}`,
          ).pipe(Effect.annotateLogs({ shop, workflowId, startedAt }));
          yield* Effect.sync(deleteWorkflow);
          yield* publish();
          return state;
        }),
      )(result),
    );
  }

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
        const repository = yield* OrderRepository;
        const state = yield* repository.getSyncState();
        /**
         * `onOrdersSyncError` normally recorded the message already and
         * released the claim; this clears whatever the failed run still holds
         * so a lost error step cannot wedge the button.
         */
        if (state.startedAt !== null)
          yield* repository.failSync({ startedAt: state.startedAt, error });
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
   */
  syncOrder(input: OrderWebhookInput): Promise<void> {
    const shop = this.name;
    const publish = (touched: PublishScope) => this.publish(touched);
    const fetchAndUpsert = (orderId: string) =>
      this.fetchAndUpsertOrder(orderId, "webhook");
    return this.runEffect(
      callableEffect(
        "ShopAgent.syncOrder",
        OrderWebhookInput,
      )(({ orderId, topic, webhookId, triggeredAt, updatedAt }) =>
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
          yield* fetchAndUpsert(orderId);
          yield* publish([orderId]);
        }),
      )(input),
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
        onExcessProperty: "error",
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
      callableEffect(
        "ShopAgent.deleteOrder",
        Domain.ResyncOrderInput,
      )(({ orderId }) =>
        Effect.gen(function* () {
          yield* (yield* WorkflowRunRepository).markOrderDeleted({ orderId });
          yield* (yield* OrderRepository).deleteOrder(orderId);
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
    state,
    paid,
    attention,
  }: Domain.ListOrdersInput) {
    const teams = () => this.teams();
    return Effect.gen(function* () {
      const repository = yield* OrderRepository;
      return {
        page: yield* repository.listOrders({
          limit,
          cursor,
          state,
          paid,
          attention,
          teams: yield* teams(),
        }),
        syncState: yield* repository.getSyncState(),
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
      callableEffect(
        "ShopAgent.listOrders",
        Domain.ListOrdersInput,
      )((input) => this.readOrders(input))(input),
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
        onExcessProperty: "error",
      })(({ subscriberId, ...input }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection) connection.setState({ subscriberId, orderId: null });
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
  listWorkflows(): Promise<readonly Domain.ItemWorkflowSummary[]> {
    const teams = () => this.teams();
    return this.runEffect(
      Effect.gen(function* () {
        const rows = yield* (yield* WorkflowRepository).listWorkflows({
          teams: yield* teams(),
          type: "item",
        });
        return rows.filter(Domain.isItemWorkflow);
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
        onExcessProperty: "error",
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
        onExcessProperty: "error",
      })((input) =>
        workflowResult(
          WorkflowRepository.pipe(
            Effect.flatMap((repository) => repository.createWorkflow(input)),
          ),
        ),
      )(input),
    );
  }

  /** Duplicate: the copy is off, keeps the steps, and takes no product tags (`WorkflowRepository.duplicateWorkflow`). */
  @callable()
  duplicateWorkflow(
    input: typeof Domain.DuplicateWorkflowInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    const shop = this.name;
    return this.runEffect(
      callableEffect(
        "ShopAgent.duplicateWorkflow",
        Domain.DuplicateWorkflowInput,
        { onExcessProperty: "error" },
      )(({ workflowId }) =>
        workflowResult(
          Effect.gen(function* () {
            const copy = yield* (yield* WorkflowRepository).duplicateWorkflow({
              workflowId,
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
        onExcessProperty: "error",
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

  /** Tags select line items, so the write lands on the draft and reaches the workflow only through Apply. */
  @callable()
  updateWorkflowTags(
    input: typeof Domain.UpdateWorkflowTagsInput.Encoded,
  ): Promise<Domain.StepResult> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.updateWorkflowTags",
        Domain.UpdateWorkflowTagsInput,
        { onExcessProperty: "error" },
      )(({ workflowId, tags }) =>
        stepResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRepository).updateWorkflowTags({
              workflowId,
              tags,
            });
            return { _tag: "Ok", step: null };
          }),
        ),
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
        onExcessProperty: "error",
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
   * afterwards: a tag added on Apply can match paid, unfulfilled orders
   * already in Baton, and they should start now rather than at whatever
   * moment Shopify next edits them. Publishes because the next order starts
   * against the new steps and tags, which the order page's workflow pickers
   * reflect.
   */
  @callable()
  applyDraft(
    input: typeof Domain.ApplyDraftInput.Encoded,
  ): Promise<Domain.ApplyResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const teams = () => this.teams();
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAll("applyDraft", workflow);
    return this.runEffect(
      callableEffect("ShopAgent.applyDraft", Domain.ApplyDraftInput, {
        onExcessProperty: "error",
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
        onExcessProperty: "error",
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
   * dialog chose) and then reconciles every stored order once, so anything
   * that now qualifies starts here rather than at whatever moment Shopify
   * next edits it. Publishes for the reason on {@link applyDraft}.
   */
  @callable()
  setWorkflowActive(
    input: typeof Domain.SetWorkflowActiveInput.Encoded,
  ): Promise<Domain.ActivateResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const teams = () => this.teams();
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAll("setWorkflowActive", workflow);
    return this.runEffect(
      callableEffect(
        "ShopAgent.setWorkflowActive",
        Domain.SetWorkflowActiveInput,
        { onExcessProperty: "error" },
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

  /** The workflow page's Change control: moves the coverage date, then reconciles every stored order once. */
  @callable()
  setWorkflowActivatedAt(
    input: typeof Domain.SetWorkflowActivatedAtInput.Encoded,
  ): Promise<Domain.ChangeActivatedAtResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      this.reconcileAll("setWorkflowActivatedAt", workflow);
    return this.runEffect(
      callableEffect(
        "ShopAgent.setWorkflowActivatedAt",
        Domain.SetWorkflowActivatedAtInput,
        { onExcessProperty: "error" },
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
    return this.runEffect(
      callableEffect(
        "ShopAgent.countWaitingOrders",
        Domain.CountWaitingOrdersInput,
        { onExcessProperty: "error" },
      )(({ workflowId }) =>
        Effect.gen(function* () {
          const found = yield* (yield* WorkflowRepository).getWorkflow({
            workflowId,
          });
          if (Option.isNone(found))
            return { count: 0, earliestProcessedAt: null };
          return yield* (yield* WorkflowRunRepository).countWaitingOrders({
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
   * Delete an item workflow and its runs stay on their orders (vocabulary on
   * `Domain.Workflow`); the order workflow singleton answers `Singleton`.
   * `removeWorkflow`, not `deleteWorkflow`: the Agents
   * SDK base class already has a `deleteWorkflow(workflowId)` that drops a
   * Cloudflare Workflow instance's tracking row (`onWorkflowComplete` calls
   * it), the same collision `getWorkflowDetail` sidesteps. Publishes because
   * the workflows list and any order page's attach picker — which lists
   * workflows — must repaint.
   */
  @callable()
  removeWorkflow(
    input: typeof Domain.DeleteWorkflowInput.Encoded,
  ): Promise<Domain.DeleteWorkflowResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect("ShopAgent.removeWorkflow", Domain.DeleteWorkflowInput, {
        onExcessProperty: "error",
      })(({ workflowId }) =>
        Effect.gen(function* () {
          yield* (yield* WorkflowRepository).deleteWorkflow({ workflowId });
          yield* Effect.logInfo(
            `ShopAgent.removeWorkflow: shop=${shop} workflowId=${workflowId}`,
          ).pipe(Effect.annotateLogs({ shop, workflowId }));
          yield* publish();
          return { _tag: "Deleted" } satisfies Domain.DeleteWorkflowResult;
        }).pipe(
          Effect.catchTags({
            WorkflowNotFoundError: () =>
              Effect.succeed<Domain.DeleteWorkflowResult>({ _tag: "NotFound" }),
            SingletonWorkflowError: () =>
              Effect.succeed<Domain.DeleteWorkflowResult>({
                _tag: "Singleton",
              }),
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
   * After a definition write on an on workflow (turned on, its date moved,
   * or a draft applied), reconcile every stored open order once, so
   * anything that now qualifies starts at this moment rather than at
   * whatever moment Shopify next edits it. Reconcile is an idempotent state
   * check, so running it over every order is safe; orders placed before
   * `activatedAt` are still excluded by the date rule. A no-op when the
   * workflow is off. Not the write's transaction: the repository owns that
   * one and Durable Object SQLite refuses to nest, but the Durable Object
   * serialises callables so nothing interleaves. Returns how many runs it
   * created.
   */
  private reconcileAll(caller: string, workflow: Domain.Workflow) {
    const shop = this.name;
    const startContext = () => this.startContext();
    return Effect.gen(function* () {
      if (!Domain.isActive(workflow)) return 0;
      const { orders, created } =
        yield* (yield* WorkflowRunRepository).reconcileAll(
          yield* startContext(),
        );
      yield* Effect.logInfo(
        `ShopAgent.reconcileAll: shop=${shop} caller=${caller} workflowId=${workflow.id} orders=${String(orders)} created=${String(created)}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          caller,
          workflowId: workflow.id,
          orders,
          created,
        }),
      );
      return created;
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
          Effect.tap(({ created, cancelled, flagged, orderRuns }) =>
            Effect.logInfo(
              `ShopAgent.reconcileOrder: shop=${shop} orderId=${order.id} source=${source} created=${String(created)} cancelled=${String(cancelled)} flagged=${String(flagged)} orderRuns=${String(orderRuns)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                orderId: order.id,
                source,
                created,
                cancelled,
                flagged,
                orderRuns,
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
      const orderWorkflow = yield* repository.getOrderWorkflow();
      const orderWorkflowBlocker =
        ((): Domain.OrderDetailView["orderWorkflowBlocker"] => {
          if (!Domain.isActive(orderWorkflow.workflow)) return "off";
          if (orderWorkflow.steps.length === 0) return "no_steps";
          const assigned = orderWorkflow.steps.every(
            (step) =>
              step.teamId !== null &&
              roster.some((team) => team.id === step.teamId),
          );
          return assigned ? null : "unassigned";
        })();
      return {
        order,
        lineItems,
        runs: yield* runs.listRunsForOrder({ orderId: order.id }),
        teams: roster,
        orderWorkflow: orderWorkflow.workflow,
        orderWorkflowBlocker,
        itemWorkflows: workflows
          .filter(
            ({ workflow, steps }) =>
              workflow.type === "item" && steps.length > 0,
          )
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
      callableEffect(
        "ShopAgent.getOrderDetail",
        Domain.GetOrderDetailInput,
      )((input) => this.readOrderDetail(input))(input),
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
        onExcessProperty: "error",
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
            connection.setState({
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
        { onExcessProperty: "error" },
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
   * Manual attach applies only the definition half of the start predicate
   * (`canStart`): an admin choosing a workflow for a line item by hand is
   * exactly the override for a missing tag, a fulfilled line, or an order
   * placed before the workflow was turned on. The run key still refuses a
   * duplicate. An attached item opts the order in: the startable order
   * workflow is handed along so the order run is created with the item run
   * when the order has none yet.
   */
  @callable()
  attachWorkflow(
    input: typeof Domain.AttachWorkflowInput.Encoded,
  ): Promise<Domain.AttachResult> {
    const publish = (touched: PublishScope) => this.publish(touched);
    const teams = () => this.teams();
    return this.runEffect(
      callableEffect("ShopAgent.attachWorkflow", Domain.AttachWorkflowInput, {
        onExcessProperty: "error",
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
          // attachable. The order workflow is never attached to a line item:
          // an attached item run brings the order run with it (below).
          const detail: Domain.WorkflowDetail | null = Option.isSome(found)
            ? { workflow: found.value.workflow, steps: found.value.steps }
            : null;
          if (
            detail === null ||
            detail.workflow.type !== "item" ||
            !canStart(detail, roster)
          )
            return {
              _tag: "WorkflowCannotStart",
            } satisfies Domain.AttachResult;
          const orderWorkflow = yield* workflows.getOrderWorkflow();
          const run = yield* (yield* WorkflowRunRepository).createRun({
            workflow: detail,
            orderWorkflow: canStart(orderWorkflow, roster)
              ? orderWorkflow
              : null,
            teams: roster,
            order: target.value.order,
            lineItem: target.value.lineItem,
            source: "manual",
          });
          if (Option.isNone(run))
            return { _tag: "AlreadyExists" } satisfies Domain.AttachResult;
          yield* publish([target.value.order.id]);
          return { _tag: "Ok", run: run.value } satisfies Domain.AttachResult;
        }),
      )(input),
    );
  }

  @callable()
  cancelRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect("ShopAgent.cancelRun", Domain.RunIdInput, {
        onExcessProperty: "error",
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
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  @callable()
  uncancelRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect("ShopAgent.uncancelRun", Domain.RunIdInput, {
        onExcessProperty: "error",
      })(({ runId }) =>
        runResult(
          WorkflowRunRepository.pipe(
            Effect.flatMap((repository) => repository.uncancelRun({ runId })),
          ),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  /**
   * Member-area methods. Plain RPC, not `@callable()`: the member area has no
   * socket, and `teamIds` / `memberId` are privileged inputs the Worker
   * resolves from the session in `requireMember` — exactly what the
   * `ShopAgentClient` path exists to carry. Decoded lax: the caller is the
   * Worker, not a browser.
   */
  /** No D1 read: `startedByEmail` is a snapshot on the row, so the queue reads the same after the member is deleted. */
  listQueue(
    input: typeof Domain.ListQueueInput.Encoded,
  ): Promise<readonly Domain.QueueItem[]> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.listQueue",
        Domain.ListQueueInput,
      )(({ teamIds }) =>
        Effect.gen(function* () {
          const rows = yield* (yield* WorkflowRunRepository).listQueue({
            teamIds,
          });
          return rows.flatMap((row): Domain.QueueItem[] => {
            const [first, ...rest] = row.steps;
            return first === undefined
              ? []
              : [
                  {
                    run: row.run,
                    steps: [first, ...rest],
                    stageCount: row.stageCount,
                    note: row.note,
                    items: row.items,
                  },
                ];
          });
        }),
      )(input),
    );
  }

  startStep(
    input: typeof Domain.StartStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect(
        "ShopAgent.startStep",
        Domain.StartStepInput,
      )(({ runStepId, memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).startStep({
              runStepId,
              memberId: yield* Schema.decodeUnknownEffect(Domain.MemberId)(
                memberId,
              ).pipe(Effect.orDie),
              memberEmail,
              teamIds,
            });
            yield* Effect.logInfo(
              `ShopAgent.startStep: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  setStepNote(
    input: typeof Domain.SetStepNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect(
        "ShopAgent.setStepNote",
        Domain.SetStepNoteInput,
      )(({ runStepId, memberId, teamIds, note }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).setStepNote({
              runStepId,
              memberId: yield* Schema.decodeUnknownEffect(Domain.MemberId)(
                memberId,
              ).pipe(Effect.orDie),
              teamIds,
              note,
            });
            yield* Effect.logInfo(
              `ShopAgent.setStepNote: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  blockRun(
    input: typeof Domain.BlockRunInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect(
        "ShopAgent.blockRun",
        Domain.BlockRunInput,
      )(({ runId, memberId, memberEmail, teamIds, reason }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).blockRun({
              runId,
              memberId: yield* Schema.decodeUnknownEffect(Domain.MemberId)(
                memberId,
              ).pipe(Effect.orDie),
              memberEmail,
              teamIds,
              reason,
            });
            yield* Effect.logInfo(
              `ShopAgent.blockRun: shop=${shop} runId=${runId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  completeStep(
    input: typeof Domain.CompleteStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect(
        "ShopAgent.completeStep",
        Domain.CompleteStepInput,
      )(({ runStepId, memberId, memberEmail, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).completeStep({
              runStepId,
              memberId: yield* Schema.decodeUnknownEffect(Domain.MemberId)(
                memberId,
              ).pipe(Effect.orDie),
              memberEmail,
              teamIds,
            });
            yield* Effect.logInfo(
              `ShopAgent.completeStep: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(publish)),
      )(input),
    );
  }

  dismissFlag(
    input: typeof Domain.DismissFlagInput.Encoded,
  ): Promise<Domain.RunResult> {
    const publish = () => this.publish("all");
    return this.runEffect(
      callableEffect(
        "ShopAgent.dismissFlag",
        Domain.DismissFlagInput,
      )(({ runId, teamIds }) =>
        runResult(
          WorkflowRunRepository.pipe(
            Effect.flatMap((repository) =>
              repository.dismissFlag({ runId, teamIds }),
            ),
          ),
        ).pipe(Effect.tap(publish)),
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
        onExcessProperty: "error",
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
        onExcessProperty: "error",
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
        onExcessProperty: "error",
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
        onExcessProperty: "error",
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
        onExcessProperty: "error",
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
        onExcessProperty: "error",
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
        onExcessProperty: "error",
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
    return this.runEffect(
      callableEffect("ShopAgent.deleteTeam", Domain.DeleteTeamInput, {
        onExcessProperty: "error",
      })(({ teamId }) =>
        Effect.gen(function* () {
          const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(name);
          const id = yield* Schema.decodeUnknownEffect(Domain.TeamId)(teamId);
          const deleted = yield* (yield* Repository)
            .deleteTeam({ shop, id })
            .pipe(
              Effect.as<Domain.DeleteTeamResult>({ _tag: "Deleted" }),
              Effect.catchTag("TeamNotFoundError", () =>
                Effect.succeed<Domain.DeleteTeamResult>({ _tag: "NotFound" }),
              ),
            );
          yield* (yield* WorkflowRepository).unassignTeam({ teamId });
          yield* Effect.logInfo(
            `ShopAgent.deleteTeam: shop=${shop} teamId=${teamId} status=${deleted._tag}`,
          ).pipe(Effect.annotateLogs({ shop, teamId, status: deleted._tag }));
          yield* publish();
          return deleted;
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
    const publish = () => this.publish("all");
    const teamExists = (teamId: string) => this.teamExists(teamId);
    return this.runEffect(
      callableEffect(
        "ShopAgent.assignRunStepTeam",
        Domain.AssignRunStepTeamInput,
        { onExcessProperty: "error" },
      )(({ runStepId, teamId }) =>
        Effect.gen(function* () {
          const team = yield* teamExists(teamId);
          if (team === null)
            return {
              _tag: "TeamNotFound",
            } satisfies Domain.AssignRunStepTeamResult;
          yield* (yield* WorkflowRunRepository).assignRunStepTeam({
            runStepId,
            team: { id: team.id, name: team.name },
          });
          yield* Effect.logInfo(
            `ShopAgent.assignRunStepTeam: shop=${shop} step=${runStepId} teamId=${teamId}`,
          ).pipe(Effect.annotateLogs({ shop, step: runStepId, teamId }));
          yield* publish();
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
   */
  @callable()
  seedWorkflows(
    input: typeof Domain.SeedWorkflowsInput.Encoded,
  ): Promise<void> {
    const environment = this.env.ENVIRONMENT;
    return this.runEffect(
      callableEffect("ShopAgent.seedWorkflows", Domain.SeedWorkflowsInput, {
        onExcessProperty: "error",
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
   * `completeStep` with the step's own team so the order run's readiness
   * gate is exercised the way it is on the floor. `advance`, `started`, and
   * `blocked` go through the same actions for the same reason: a seeded
   * "step 2 of 3, in progress, blocked" card is indistinguishable from one a
   * worker produced. Only rows under `SEED_ORDER_ID_PREFIX` are replaced;
   * synced orders are left alone.
   */
  @callable()
  seedOrders(input: typeof Domain.SeedOrdersInput.Encoded): Promise<void> {
    const environment = this.env.ENVIRONMENT;
    const publish = () => this.publish("all");
    const reconciler = () => this.reconciler("manual");
    return this.runEffect(
      callableEffect("ShopAgent.seedOrders", Domain.SeedOrdersInput, {
        onExcessProperty: "error",
      })(({ memberId, memberEmail, orders }) =>
        Effect.gen(function* () {
          if (environment !== "local")
            yield* Effect.fail(
              new WorkflowRepositoryError({
                message: `ShopAgent.seedOrders: environment=${environment}: seeding is local-only`,
                cause: environment,
              }),
            );
          const sql = yield* SqlClient.SqlClient;
          const orderRepository = yield* OrderRepository;
          const runs = yield* WorkflowRunRepository;
          const reconcile = yield* reconciler();
          const now = yield* Clock.currentTimeMillis;
          const listOpenRuns = (orderId: string) =>
            runs
              .listRunsForOrder({ orderId })
              .pipe(
                Effect.map((details) =>
                  details.filter(
                    ({ run }) =>
                      run.status === "pending" || run.status === "active",
                  ),
                ),
              );
          const actor = (step: Domain.WorkflowRunStep) => ({
            runStepId: step.id,
            memberId,
            memberEmail,
            teamIds: step.teamId === null ? [] : [step.teamId],
          });
          const completeOpenRuns = (orderId: string) =>
            Effect.gen(function* () {
              for (const { run, steps } of yield* listOpenRuns(orderId)) {
                yield* Effect.forEach(
                  steps,
                  (step) => runs.completeStep(actor(step)),
                  { discard: true },
                );
                yield* Effect.logInfo(
                  `ShopAgent.seedOrders: orderId=${orderId} runId=${run.id}: completed`,
                ).pipe(Effect.annotateLogs({ orderId, runId: run.id }));
              }
            });
          /** One round: every step ready at the start of the round gets completed; what that makes ready waits for the next. */
          const advanceRound = (orderId: string) =>
            runs
              .listRunsForOrder({ orderId })
              .pipe(
                Effect.flatMap((details) =>
                  Effect.forEach(
                    seedReadySteps(details),
                    (step) => runs.completeStep(actor(step)),
                    { discard: true },
                  ),
                ),
              );
          const startReadySteps = (orderId: string) =>
            Effect.gen(function* () {
              for (const { steps } of yield* listOpenRuns(orderId))
                yield* Effect.forEach(
                  steps.filter((step) => step.completedAt === null),
                  (step) =>
                    runs
                      .startStep(actor(step))
                      .pipe(
                        Effect.catchTag("StepNotReadyError", () => Effect.void),
                      ),
                  { discard: true },
                );
            });
          const blockOpenRuns = (orderId: string, reason: Domain.StepNote) =>
            Effect.gen(function* () {
              for (const { run, steps } of yield* listOpenRuns(orderId))
                yield* runs
                  .blockRun({
                    runId: run.id,
                    memberId,
                    memberEmail,
                    teamIds: steps.flatMap((step) =>
                      step.teamId === null ? [] : [step.teamId],
                    ),
                    reason,
                  })
                  .pipe(
                    Effect.catchTag("RunNotAllowedError", () => Effect.void),
                  );
            });
          const seeded = yield* sql`
            select id from ShopOrder where id like ${`${Domain.SEED_ORDER_ID_PREFIX}%`}
          `.values;
          for (const [id] of seeded)
            yield* orderRepository.deleteOrder(String(id));
          for (const [index, seed] of orders.entries()) {
            const id = `${Domain.SEED_ORDER_ID_PREFIX}${String(seed.n)}`;
            // At or after `now`, never before: the workflows this fixture
            // starts were turned on moments ago and the date rule skips an
            // order placed before its workflow. Spaced a second apart so
            // the index's keyset order matches `orders` order, newest last.
            const processedAt = now + index * 1000;
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
              tags: ["seed"],
              note: seed.note ?? null,
              customAttributes: [],
              lineItemsComplete: true,
              syncedAt: now,
              syncSource: "manual",
            };
            yield* orderRepository.upsertOrder({
              order,
              raw: "{}",
              lineItems: seed.lineItems.map((item, position) => {
                const currentQuantity = item.currentQuantity ?? item.quantity;
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
                    item.unfulfilledQuantity ?? currentQuantity,
                  nonFulfillableQuantity: 0,
                  productTags: item.tags,
                  customAttributes: item.customAttributes ?? [],
                  requiresShipping: true,
                } satisfies Domain.OrderLineItem;
              }),
              afterWrite: reconcile(order),
            });
            // Item runs come first in `listRunsForOrder`, so by the time the
            // order run's steps are reached they are ready.
            if (seed.done === true) yield* completeOpenRuns(id);
            for (let round = 0; round < (seed.advance ?? 0); round += 1)
              yield* advanceRound(id);
            if (seed.started === true) yield* startReadySteps(id);
            if (seed.blocked !== undefined)
              yield* blockOpenRuns(id, seed.blocked);
          }
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
      callableEffect(
        "ShopAgent.listStepsOwnedBy",
        Domain.TeamIdInput,
      )(({ teamId }) =>
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

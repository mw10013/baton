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
  type StageNotFoundError,
  type StepNotFoundError,
  type WorkflowLimitError,
  type WorkflowNameTakenError,
  type WorkflowNotFoundError,
  WorkflowRepository,
  WorkflowRepositoryError,
} from "@/lib/WorkflowRepository";
import {
  isRoutable,
  type RoutingContext,
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
 * merchant configures (name, product tags, ordered steps). `WorkflowStep.teamId`
 * is a D1 `Team.id` with no foreign key because none is possible: `Team` lives
 * in D1 and this table in the object's private SQLite, and SQLite foreign keys
 * do not cross databases. Integrity is application-level — `addStep` /
 * `updateStep` verify the team is active before writing, and `archiveTeam`
 * refuses while any step still points at it (`countStepsOwnedBy`, served by
 * `WorkflowStep_teamId_idx`). `unique (workflowId, position)` is what forces
 * `moveStep` to go through a scratch position inside one transaction — and,
 * now that every layout edit rewrites the whole workflow, why
 * `WorkflowRepository.writeLayout` first parks every step at `-position`
 * before assigning final positions and stages. `stage` groups steps that are
 * ready together: along `position` stages are dense `1..m` and
 * non-decreasing, an invariant kept by the pure `WorkflowLayout` module
 * rather than by SQL. `instructions` is merchant text copied onto each run.
 * Epoch-ms integers like `ShopOrder`, not D1 `Team`'s ISO text: the two stores
 * already differ, and one store should not mix.
 *
 * `WorkflowRun` / `WorkflowRunStep` are the *instances*: one workflow applied
 * to one line item, with the definition's steps copied in. Every display
 * field is a snapshot and there is no foreign key to `ShopOrder`,
 * `OrderLineItem`, or `Workflow` — a run must survive an order delete, a
 * line item dropped by an edit, and a definition rename, because it is the
 * record of work someone may already have started. `unique (lineItemId,
 * workflowId)` spans every status so a cancelled run keeps its key: neither
 * the sync nor manual attach can create a second one, and recovery from a
 * mistaken cancel is un-cancel. `status` is denormalized from the steps for
 * the queue and the definitions badge; every step write recomputes it in the
 * same transaction. `(teamId, completedAt)` serves the member queue, which
 * asks for open steps by team. A run step is *ready* when it is open and no
 * step in an earlier `stage` of the same run is still open, so several steps
 * of one run can be ready at once; `startedAt` / `startedBy` record Start and
 * make the run `active` before anything is completed; `note` is worker text
 * about this particular item. `flag = 'blocked'` is the one flag a person
 * sets (with an optional reason in `flagDetail`) rather than reconcile.
 */
const initializeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table if not exists ShopOrder (
      id text primary key,
      legacyId text not null,
      name text not null,
      createdAt integer not null,
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
      tags text not null,
      createdAt integer not null,
      updatedAt integer not null,
      archivedAt integer
    );
    create unique index if not exists Workflow_name_uidx
      on Workflow (name collate nocase);
    create table if not exists WorkflowStep (
      id text primary key,
      workflowId text not null references Workflow (id) on delete cascade,
      position integer not null,
      stage integer not null,
      name text not null check (name = trim(name) and length(name) > 0),
      teamId text not null,
      instructions text,
      createdAt integer not null,
      unique (workflowId, position)
    );
    create index if not exists WorkflowStep_teamId_idx on WorkflowStep (teamId);
    create table if not exists WorkflowRun (
      id text primary key,
      workflowId text not null,
      workflowName text not null,
      orderId text not null,
      orderName text not null,
      lineItemId text not null,
      lineItemTitle text not null,
      variantTitle text,
      sku text,
      quantity integer not null,
      customAttributes text not null,
      source text not null check (source in ('tag', 'manual')),
      status text not null check (status in ('pending', 'active', 'done', 'cancelled')),
      flag text check (flag in ('item_removed', 'quantity_changed', 'order_cancelled', 'order_deleted', 'blocked')),
      flagAt integer,
      flagDetail text,
      createdAt integer not null,
      updatedAt integer not null,
      cancelledAt integer,
      unique (lineItemId, workflowId)
    );
    create index if not exists WorkflowRun_orderId_idx on WorkflowRun (orderId);
    create index if not exists WorkflowRun_status_idx on WorkflowRun (status);
    create table if not exists WorkflowRunStep (
      id text primary key,
      runId text not null references WorkflowRun (id) on delete cascade,
      position integer not null,
      stage integer not null,
      name text not null,
      teamId text not null,
      teamName text not null,
      instructions text,
      startedAt integer,
      startedBy text,
      completedAt integer,
      completedBy text,
      note text,
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

const inUseResult = (count: number): Domain.TeamArchiveResult => ({
  _tag: "InUse",
  count,
});

/** Same shape as {@link workflowResult}: expected run failures become values. */
const runResult = <R>(
  effect: Effect.Effect<
    void,
    | RunNotFoundError
    | RunTerminalError
    | RunNotAllowedError
    | StepNotReadyError
    | SqlError.SqlError
    | WorkflowRunRepositoryError
    | RepositoryError,
    R
  >,
): Effect.Effect<
  Domain.RunResult,
  SqlError.SqlError | WorkflowRunRepositoryError | RepositoryError,
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
 * transaction completes, connection attachment updates and WebSocket sends below
 * are synchronous in the resumed turn. `blockConcurrencyWhile()` is therefore only
 * needed for constructor migrations. Revisit this only if a state transition starts
 * awaiting non-storage I/O such as `fetch()`.
 *
 * The object is addressed by shop domain (`env.SHOP_AGENT.getByName(shop)`), so
 * `this.name` is the shop and no method takes one.
 */
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

  private connectionState(
    connection: Connection,
  ): Domain.ConnectionState | null {
    return Option.getOrNull(
      Schema.decodeUnknownOption(Domain.ConnectionAttachment)(
        connection.state,
        { onExcessProperty: "error" },
      ),
    );
  }

  private connections() {
    return Effect.try({
      try: () => [...this.getConnections()],
      catch: (cause) =>
        new ShopAgentNotifyError({ message: "getConnections failed", cause }),
    });
  }

  private notifyConnection(connection: Connection) {
    return Effect.try({
      try: () => {
        if (this.connectionState(connection))
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
        message: `ShopAgent.notifyConnection: shop=${this.name}`,
      }),
    );
  }

  /**
   * Invalidations are best-effort hints, never the new value: SQLite stays
   * authoritative and an attaching tab refetches, so a dropped push costs a
   * stale render until the next activation rather than a lost write. That is
   * why a send failure is swallowed here instead of failing the mutation that
   * triggered it.
   */
  private notifyChanged() {
    return this.connections().pipe(
      Effect.flatMap((connections) =>
        Effect.forEach(
          connections,
          (connection) => this.notifyConnection(connection),
          { discard: true },
        ),
      ),
      Effect.ignore({
        log: "Debug",
        message: `ShopAgent.notifyChanged: shop=${this.name}`,
      }),
    );
  }

  @callable()
  deactivate(input: Domain.SessionTokenInput): Promise<void> {
    return this.runEffect(
      callableEffect("ShopAgent.deactivate", Domain.SessionTokenInput, {
        onExcessProperty: "error",
      })(({ sessionToken }) =>
        Effect.sync(() => {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (
            connection &&
            this.connectionState(connection)?.sessionToken === sessionToken
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
    const notifyChanged = () => this.notifyChanged();
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
        yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
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
          yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
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
          yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
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
          yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
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
        yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
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
          yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
    const fetchAndUpsert = (orderId: string) =>
      this.fetchAndUpsertOrder(orderId, "manual");
    return this.runEffect(
      callableEffect("ShopAgent.resyncOrder", Domain.ResyncOrderInput, {
        onExcessProperty: "error",
      })(({ orderId }) =>
        Effect.gen(function* () {
          yield* fetchAndUpsert(orderId);
          yield* notifyChanged();
        }),
      )(input),
    );
  }

  /** `orders/delete` carries `{ id }` only — there is nothing to fetch. */
  deleteOrder(input: Domain.ResyncOrderInput): Promise<void> {
    const shop = this.name;
    const notifyChanged = () => this.notifyChanged();
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
          yield* notifyChanged();
        }),
      )(input),
    );
  }

  /**
   * The orders view's `activate<Feature>` method — reads the page and
   * subscribes the calling connection in one round trip. Combining the read and
   * subscription prevents a write between separate calls from being missed.
   */
  @callable()
  activateOrders(
    input: Domain.ActivateOrdersInput,
  ): Promise<Domain.OrdersView> {
    return this.runEffect(
      callableEffect("ShopAgent.activateOrders", Domain.ActivateOrdersInput, {
        onExcessProperty: "error",
      })(({ limit, cursor, sessionToken }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection) connection.setState({ sessionToken });
          const repository = yield* OrderRepository;
          return {
            page: yield* repository.listOrders({ limit, cursor }),
            syncState: yield* repository.getSyncState(),
          } satisfies Domain.OrdersView;
        }),
      )(input),
    );
  }

  @callable()
  listWorkflows(
    input: typeof Domain.ListWorkflowsInput.Encoded,
  ): Promise<readonly Domain.WorkflowSummary[]> {
    return this.runEffect(
      callableEffect("ShopAgent.listWorkflows", Domain.ListWorkflowsInput, {
        onExcessProperty: "error",
      })(({ includeArchived }) =>
        WorkflowRepository.pipe(
          Effect.flatMap((repository) =>
            repository.listWorkflows({ includeArchived }),
          ),
        ),
      )(input),
    );
  }

  /**
   * `getWorkflowDetail`, not `getWorkflow`: the Agents SDK base class already
   * has a `getWorkflow(workflowId)` that tracks Cloudflare Workflow instances.
   *
   * Joins team names from D1 inside the object rather than in a server fn: the
   * runtime already holds `Repository`, and one round trip returns the steps,
   * their resolved team names, and the active-team roster the picker needs.
   * A step whose team is archived or missing resolves to `teamName: null` —
   * flagged, never blocked, since the risk is at routing time, not in the
   * editor, and unarchiving the team restores validity with no edit.
   */
  @callable()
  getWorkflowDetail(
    input: typeof Domain.WorkflowIdInput.Encoded,
  ): Promise<Domain.WorkflowDetailView | null> {
    const name = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.getWorkflowDetail", Domain.WorkflowIdInput, {
        onExcessProperty: "error",
      })(({ workflowId }) =>
        Effect.gen(function* () {
          const detail = yield* (yield* WorkflowRepository).getWorkflow({
            workflowId,
          });
          if (Option.isNone(detail)) return null;
          const teams = yield* (yield* Repository).listTeams({
            shop: yield* Schema.decodeUnknownEffect(Domain.Shop)(name),
            includeArchived: true,
          });
          const nameOf = new Map(
            teams
              .filter((team) => team.archivedAt === null)
              .map((team) => [team.id, team.name]),
          );
          return {
            workflow: detail.value.workflow,
            steps: detail.value.steps.map((step) => ({
              ...step,
              teamName: nameOf.get(step.teamId) ?? null,
            })),
            activeTeams: [...nameOf].map(([id, name]) => ({ id, name })),
          } satisfies Domain.WorkflowDetailView;
        }),
      )(input),
    );
  }

  @callable()
  createWorkflow(
    input: typeof Domain.CreateWorkflowInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect("ShopAgent.createWorkflow", Domain.CreateWorkflowInput, {
        onExcessProperty: "error",
      })(({ name, tags }) =>
        workflowResult(
          WorkflowRepository.pipe(
            Effect.flatMap((repository) =>
              repository.createWorkflow({ name, tags }),
            ),
          ),
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  @callable()
  updateWorkflow(
    input: typeof Domain.UpdateWorkflowInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect("ShopAgent.updateWorkflow", Domain.UpdateWorkflowInput, {
        onExcessProperty: "error",
      })(({ workflowId, name, tags }) =>
        workflowResult(
          WorkflowRepository.pipe(
            Effect.flatMap((repository) =>
              repository.updateWorkflow({ workflowId, name, tags }),
            ),
          ),
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  @callable()
  setWorkflowArchived(
    input: typeof Domain.SetWorkflowArchivedInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect(
        "ShopAgent.setWorkflowArchived",
        Domain.SetWorkflowArchivedInput,
        { onExcessProperty: "error" },
      )(({ workflowId, archived }) =>
        workflowResult(
          WorkflowRepository.pipe(
            Effect.flatMap((repository) =>
              repository.setWorkflowArchived({ workflowId, archived }),
            ),
          ),
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  private activeTeams() {
    const name = this.name;
    return Effect.gen(function* () {
      const teams = yield* (yield* Repository).listTeams({
        shop: yield* Schema.decodeUnknownEffect(Domain.Shop)(name),
        includeArchived: false,
      });
      return teams.map(({ id, name }) => ({ id, name }));
    });
  }

  /**
   * Loads what routing needs — every active definition with its steps, and
   * the active team roster from D1 — *before* any transaction opens, and
   * returns a per-order effect the caller hands to `upsertOrder.afterWrite`.
   * The D1 read is the one await routing needs that is not storage, and it
   * cannot happen inside the Durable Object transaction; loading once per
   * webhook or per bulk stream also bounds the cost for a thousand-order file,
   * at the accepted price of a snapshot that a mid-stream team archive would
   * not refresh.
   */
  private reconciler(source: Domain.OrderSyncSource) {
    const shop = this.name;
    const activeTeams = () => this.activeTeams();
    return Effect.gen(function* () {
      const context: RoutingContext = {
        workflows:
          yield* (yield* WorkflowRepository).listActiveWorkflowDetails(),
        activeTeams: yield* activeTeams(),
      };
      const runs = yield* WorkflowRunRepository;
      return (order: Domain.ShopOrder) =>
        runs.reconcileOrder({ ...context, orderId: order.id }).pipe(
          Effect.tap(({ created, cancelled, flagged }) =>
            Effect.logInfo(
              `ShopAgent.reconcileOrder: shop=${shop} orderId=${order.id} source=${source} created=${String(created)} cancelled=${String(cancelled)} flagged=${String(flagged)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                orderId: order.id,
                source,
                created,
                cancelled,
                flagged,
              }),
            ),
          ),
          Effect.asVoid,
        );
    });
  }

  /**
   * The detail page's `activate<Feature>` read: the order, its line items, and
   * every run on them, and the calling connection subscribed to pushes in the
   * same round trip (the convention documented on `activateOrders`). Without
   * the attach, a webhook landing on the open order would update SQLite and
   * push to nobody. Addressed by `legacyId` because that is what the route
   * carries (see `Domain.ActivateOrderInput`). `null` when the order is not
   * stored, which the page renders as not-found rather than as a failure.
   */
  @callable()
  activateOrder(
    input: typeof Domain.ActivateOrderInput.Encoded,
  ): Promise<Domain.OrderDetailView | null> {
    return this.runEffect(
      callableEffect("ShopAgent.activateOrder", Domain.ActivateOrderInput, {
        onExcessProperty: "error",
      })(({ legacyId, sessionToken }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection) connection.setState({ sessionToken });
          const orders = yield* OrderRepository;
          const runs = yield* WorkflowRunRepository;
          const detail = yield* orders.getOrderByLegacyId(legacyId);
          if (Option.isNone(detail)) return null;
          const { order, lineItems } = detail.value;
          return {
            order,
            lineItems,
            runs: yield* runs.listRunsForOrder({ orderId: order.id }),
          } satisfies Domain.OrderDetailView;
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
   * Manual attach applies only the definition half of the routing predicate
   * (`isRoutable`): an admin choosing a workflow for a line item by hand is
   * exactly the override for a missing tag, a fulfilled line, or an order
   * older than the workflow. The run key still refuses a duplicate.
   */
  @callable()
  attachWorkflow(
    input: typeof Domain.AttachWorkflowInput.Encoded,
  ): Promise<Domain.AttachResult> {
    const notifyChanged = () => this.notifyChanged();
    const activeTeams = () => this.activeTeams();
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
          const workflow = yield* (yield* WorkflowRepository).getWorkflow({
            workflowId,
          });
          const teams = yield* activeTeams();
          if (Option.isNone(workflow) || !isRoutable(workflow.value, teams))
            return {
              _tag: "WorkflowNotRoutable",
            } satisfies Domain.AttachResult;
          const run = yield* (yield* WorkflowRunRepository).createRun({
            workflow: workflow.value,
            activeTeams: teams,
            order: target.value.order,
            lineItem: target.value.lineItem,
            source: "manual",
          });
          if (Option.isNone(run))
            return { _tag: "AlreadyExists" } satisfies Domain.AttachResult;
          yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
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
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  @callable()
  uncancelRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect("ShopAgent.uncancelRun", Domain.RunIdInput, {
        onExcessProperty: "error",
      })(({ runId }) =>
        runResult(
          WorkflowRunRepository.pipe(
            Effect.flatMap((repository) => repository.uncancelRun({ runId })),
          ),
        ).pipe(Effect.tap(notifyChanged)),
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
  /**
   * `startedByEmail` is joined here from D1's `Member` roster — one read per
   * call, mapped by id — because the run rows hold only member ids and the
   * repository never sees D1.
   */
  listQueue(
    input: typeof Domain.ListQueueInput.Encoded,
  ): Promise<readonly Domain.QueueItem[]> {
    const name = this.name;
    return this.runEffect(
      callableEffect(
        "ShopAgent.listQueue",
        Domain.ListQueueInput,
      )(({ teamIds }) =>
        Effect.gen(function* () {
          const rows = yield* (yield* WorkflowRunRepository).listQueue({
            teamIds,
          });
          if (rows.length === 0) return [];
          const members = yield* (yield* Repository).listMembers(
            yield* Schema.decodeUnknownEffect(Domain.Shop)(name),
          );
          const emailOf = new Map(
            members.map((member) => [member.id, member.email]),
          );
          return rows.flatMap((row): Domain.QueueItem[] => {
            const [first, ...rest] = row.steps.map(
              (step): Domain.QueueStep => ({
                ...step,
                startedByEmail:
                  step.startedBy === null
                    ? null
                    : (emailOf.get(step.startedBy) ?? null),
              }),
            );
            return first === undefined
              ? []
              : [
                  {
                    run: row.run,
                    steps: [first, ...rest],
                    stageCount: row.stageCount,
                    note: row.note,
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
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect(
        "ShopAgent.startStep",
        Domain.StartStepInput,
      )(({ runStepId, memberId, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).startStep({
              runStepId,
              memberId: yield* Schema.decodeUnknownEffect(Domain.MemberId)(
                memberId,
              ).pipe(Effect.orDie),
              teamIds,
            });
            yield* Effect.logInfo(
              `ShopAgent.startStep: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  setStepNote(
    input: typeof Domain.SetStepNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const notifyChanged = () => this.notifyChanged();
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
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  blockRun(
    input: typeof Domain.BlockRunInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect(
        "ShopAgent.blockRun",
        Domain.BlockRunInput,
      )(({ runId, memberId, teamIds, reason }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).blockRun({
              runId,
              memberId: yield* Schema.decodeUnknownEffect(Domain.MemberId)(
                memberId,
              ).pipe(Effect.orDie),
              teamIds,
              reason,
            });
            yield* Effect.logInfo(
              `ShopAgent.blockRun: shop=${shop} runId=${runId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
          }),
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  completeStep(
    input: typeof Domain.CompleteStepInput.Encoded,
  ): Promise<Domain.RunResult> {
    const shop = this.name;
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect(
        "ShopAgent.completeStep",
        Domain.CompleteStepInput,
      )(({ runStepId, memberId, teamIds }) =>
        runResult(
          Effect.gen(function* () {
            yield* (yield* WorkflowRunRepository).completeStep({
              runStepId,
              memberId: yield* Schema.decodeUnknownEffect(Domain.MemberId)(
                memberId,
              ).pipe(Effect.orDie),
              teamIds,
            });
            yield* Effect.logInfo(
              `ShopAgent.completeStep: shop=${shop} step=${runStepId} memberId=${memberId}`,
            ).pipe(Effect.annotateLogs({ shop, step: runStepId, memberId }));
          }),
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  dismissFlag(
    input: typeof Domain.DismissFlagInput.Encoded,
  ): Promise<Domain.RunResult> {
    const notifyChanged = () => this.notifyChanged();
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
        ).pipe(Effect.tap(notifyChanged)),
      )(input),
    );
  }

  /**
   * The team check lives here, not in the repository: `Team` is a D1 row the
   * Durable Object's SQLite cannot reference, so "active team" is an
   * application invariant. Checked against the live roster on every write,
   * and serialized against `archiveTeam` by the object's input gate.
   */
  private activeTeam(teamId: string) {
    const name = this.name;
    return Effect.gen(function* () {
      const teams = yield* (yield* Repository).listTeams({
        shop: yield* Schema.decodeUnknownEffect(Domain.Shop)(name),
        includeArchived: false,
      });
      return teams.find((team) => team.id === teamId) ?? null;
    });
  }

  private workflowWritable(workflowId: string) {
    return WorkflowRepository.pipe(
      Effect.flatMap((repository) => repository.getWorkflow({ workflowId })),
      Effect.map(
        Option.match({
          onNone: (): Domain.StepResult => ({ _tag: "NotFound" }),
          onSome: ({ workflow }): Domain.StepResult | null =>
            workflow.archivedAt === null ? null : { _tag: "Archived" },
        }),
      ),
    );
  }

  @callable()
  addStep(
    input: typeof Domain.AddStepInput.Encoded,
  ): Promise<Domain.StepResult> {
    const notifyChanged = () => this.notifyChanged();
    const activeTeam = (teamId: string) => this.activeTeam(teamId);
    const workflowWritable = (workflowId: string) =>
      this.workflowWritable(workflowId);
    return this.runEffect(
      callableEffect("ShopAgent.addStep", Domain.AddStepInput, {
        onExcessProperty: "error",
      })(({ workflowId, name, teamId, instructions }) =>
        stepResult(
          Effect.gen(function* () {
            const blocked = yield* workflowWritable(workflowId);
            if (blocked !== null) return blocked;
            const team = yield* activeTeam(teamId);
            if (team === null) return { _tag: "TeamNotActive" };
            const step = yield* (yield* WorkflowRepository).addStep({
              workflowId,
              name,
              teamId: team.id,
              instructions: instructions ?? null,
            });
            yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
    const activeTeam = (teamId: string) => this.activeTeam(teamId);
    const workflowWritable = (workflowId: string) =>
      this.workflowWritable(workflowId);
    return this.runEffect(
      callableEffect("ShopAgent.addParallelStep", Domain.AddParallelStepInput, {
        onExcessProperty: "error",
      })(({ workflowId, stage, name, teamId, instructions }) =>
        stepResult(
          Effect.gen(function* () {
            const blocked = yield* workflowWritable(workflowId);
            if (blocked !== null) return blocked;
            const team = yield* activeTeam(teamId);
            if (team === null) return { _tag: "TeamNotActive" };
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
            yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
    const activeTeam = (teamId: string) => this.activeTeam(teamId);
    const workflowWritable = (workflowId: string) =>
      this.workflowWritable(workflowId);
    return this.runEffect(
      callableEffect("ShopAgent.updateStep", Domain.UpdateStepInput, {
        onExcessProperty: "error",
      })(({ stepId, name, teamId, instructions }) =>
        stepResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getStep({ stepId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            const blocked = yield* workflowWritable(existing.value.workflowId);
            if (blocked !== null) return blocked;
            const team = yield* activeTeam(teamId);
            if (team === null) return { _tag: "TeamNotActive" };
            const step = yield* repository.updateStep({
              stepId,
              name,
              teamId: team.id,
              instructions,
            });
            yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
    const workflowWritable = (workflowId: string) =>
      this.workflowWritable(workflowId);
    return this.runEffect(
      callableEffect("ShopAgent.moveStep", Domain.MoveStepInput, {
        onExcessProperty: "error",
      })(({ stepId, direction }) =>
        stepResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getStep({ stepId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            const blocked = yield* workflowWritable(existing.value.workflowId);
            if (blocked !== null) return blocked;
            yield* repository.moveStep({ stepId, direction });
            yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
    const workflowWritable = (workflowId: string) =>
      this.workflowWritable(workflowId);
    return this.runEffect(
      callableEffect("ShopAgent.separateStep", Domain.SeparateStepInput, {
        onExcessProperty: "error",
      })(({ stepId }) =>
        stepResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getStep({ stepId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            const blocked = yield* workflowWritable(existing.value.workflowId);
            if (blocked !== null) return blocked;
            yield* repository.separateStep({ stepId });
            yield* Effect.logInfo(
              `ShopAgent.separateStep: shop=${shop} workflowId=${existing.value.workflowId} stage=${String(existing.value.stage)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                workflowId: existing.value.workflowId,
                stage: existing.value.stage,
              }),
            );
            yield* notifyChanged();
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
    const notifyChanged = () => this.notifyChanged();
    const workflowWritable = (workflowId: string) =>
      this.workflowWritable(workflowId);
    return this.runEffect(
      callableEffect("ShopAgent.removeStep", Domain.StepIdInput, {
        onExcessProperty: "error",
      })(({ stepId }) =>
        stepResult(
          Effect.gen(function* () {
            const repository = yield* WorkflowRepository;
            const existing = yield* repository.getStep({ stepId });
            if (Option.isNone(existing)) return { _tag: "NotFound" };
            const blocked = yield* workflowWritable(existing.value.workflowId);
            if (blocked !== null) return blocked;
            yield* repository.removeStep({ stepId });
            yield* notifyChanged();
            return { _tag: "Ok", step: null };
          }),
        ),
      )(input),
    );
  }

  /**
   * Lives in the object rather than a server fn so the guard is race-free:
   * count → D1 archive → re-check all run in one single-threaded object,
   * serialized against `addStep`/`updateStep` by the input gate. In the Worker
   * that sequence could interleave with a step being saved against the team
   * between the count and the write. The re-check is belt and braces for the
   * cross-store gap that remains (D1 is not in the object's transaction);
   * if a step landed anyway the archive is flipped back. Restore has nothing
   * to guard and stays a plain server fn.
   */
  @callable()
  archiveTeam(
    input: typeof Domain.TeamIdInput.Encoded,
  ): Promise<Domain.TeamArchiveResult> {
    const name = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.archiveTeam", Domain.TeamIdInput, {
        onExcessProperty: "error",
      })(({ teamId }) =>
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepository;
          const teams = yield* Repository;
          const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(name);
          const id = yield* Schema.decodeUnknownEffect(Domain.TeamId)(teamId);
          const inUse = yield* workflows.countStepsOwnedBy({ teamId });
          if (inUse > 0) return inUseResult(inUse);
          const archived = yield* teams
            .setTeamArchived({ shop, id, archived: true })
            .pipe(
              Effect.as<Domain.TeamArchiveResult>({ _tag: "Ok" }),
              Effect.catchTag("TeamNotFoundError", () =>
                Effect.succeed<Domain.TeamArchiveResult>({ _tag: "NotFound" }),
              ),
            );
          if (archived._tag !== "Ok") return archived;
          const recheck = yield* workflows.countStepsOwnedBy({ teamId });
          if (recheck === 0) return archived;
          yield* teams.setTeamArchived({ shop, id, archived: false });
          return inUseResult(recheck);
        }),
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
   * `Workflow` that skips the name, limit, and active-team checks, and the
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
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      callableEffect("ShopAgent.seedWorkflows", Domain.SeedWorkflowsInput, {
        onExcessProperty: "error",
      })((seed) =>
        Effect.gen(function* () {
          if (environment === "local") {
            yield* (yield* WorkflowRepository).replaceWorkflows(seed);
            yield* notifyChanged();
          } else
            yield* Effect.fail(
              new WorkflowRepositoryError({
                message: `ShopAgent.seedWorkflows: environment=${environment}: seeding is local-only`,
                cause: environment,
              }),
            );
        }),
      )(input),
    );
  }

  @callable()
  listStepsOwnedBy(
    input: typeof Domain.TeamIdInput.Encoded,
  ): Promise<readonly Domain.OwnedStep[]> {
    return this.runEffect(
      callableEffect("ShopAgent.listStepsOwnedBy", Domain.TeamIdInput, {
        onExcessProperty: "error",
      })(({ teamId }) =>
        WorkflowRepository.pipe(
          Effect.flatMap((repository) =>
            repository.listStepsOwnedBy({ teamId }),
          ),
        ),
      )(input),
    );
  }
}

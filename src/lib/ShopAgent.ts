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

import { CounterRepository } from "@/lib/CounterRepository";
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
import { Repository } from "@/lib/Repository";
import { runShopAgentOrdersStream } from "@/lib/ShopAgentOrdersStream";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";

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
 * the second migration has somewhere to go.
 *
 * `Counter` is the skeleton's demo domain — see {@link CounterRepository}. The
 * `check (id = 1)` primary key with a seeded row makes "exactly one row per
 * shop" a schema fact; the seed is `insert or ignore` so re-running the
 * migration on an existing object is a no-op.
 */
const initializeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table if not exists Counter (
      id integer primary key check (id = 1),
      count integer not null check (count >= 0),
      updatedAt integer
    )
  `;
  yield* sql`
    insert or ignore into Counter (id, count, updatedAt) values (1, 0, null)
  `;
});

/**
 * Orders, their line items, and the two pieces of bookkeeping that make the
 * two ingestion paths safe to interleave.
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
 */
const initializeOrdersSchema = Effect.gen(function* () {
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
    )
  `;
  yield* sql`
    create index if not exists ShopOrder_processedAt
      on ShopOrder (processedAt desc, id desc)
  `;
  yield* sql`
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
    )
  `;
  yield* sql`
    create index if not exists OrderLineItem_orderId on OrderLineItem (orderId)
  `;
  yield* sql`
    create table if not exists WebhookDelivery (
      webhookId text primary key,
      topic text not null,
      orderId text not null,
      triggeredAt integer not null,
      receivedAt integer not null
    )
  `;
  yield* sql`
    create table if not exists SyncState (
      id integer primary key check (id = 1),
      workflowId text,
      startedAt integer,
      lastFullSyncAt integer,
      lastFullSyncWindowStart integer,
      lastError text
    )
  `;
  yield* sql`insert or ignore into SyncState (id) values (1)`;
});

export const runShopAgentMigrations = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    "1_initialize schema": initializeSchema,
    "2_orders": initializeOrdersSchema,
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
 * app-owned `D1Session`/`D1Primary` tags; `CounterRepository` runs over the
 * DO's private SQLite (`ctx.storage`, per-shop), whose `SqliteClient.layer` is
 * the only provider of the ambient `SqlClient` tag here. That is what
 * `runShopAgentMigrations` (which requests `SqlClient` directly) needs. Each
 * repository closes over its own client at layer-build time, so the ambient
 * tag only governs the migration.
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
    CounterRepository.layer,
    OrderRepository.layer,
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

  /**
   * Subscribes the calling connection to invalidations and returns the current
   * value, in one round trip so a tab cannot miss a change between reading and
   * attaching.
   *
   * The `sessionToken` is minted per route mount and stored on the connection
   * so {@link deactivate} from an unmounted previous mount — the `/app` socket
   * is shared across route changes — cannot detach the mount that replaced it.
   */
  @callable()
  activate(input: Domain.SessionTokenInput): Promise<Domain.Counter> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.activate", Domain.SessionTokenInput, {
        onExcessProperty: "error",
      })(({ sessionToken }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection) connection.setState({ sessionToken });
          yield* Effect.logDebug(`ShopAgent.activate: shop=${shop}`).pipe(
            Effect.annotateLogs({ shop }),
          );
          return yield* (yield* CounterRepository).get();
        }),
      )(input),
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
   * The demo write: browser → WebSocket RPC → SQLite → broadcast. Every open
   * tab for this shop refetches, including the one that clicked.
   *
   * Browser-reachable and taking no arguments, which is the point: nothing a
   * tab can name reaches storage. A real mutation that must respect a plan
   * ceiling takes the ceiling as a required argument resolved from D1 by the
   * Worker, and is therefore reachable only through `ShopAgentClient` from a
   * server function — never `@callable()`.
   */
  @callable()
  bump(): Promise<Domain.Counter> {
    const shop = this.name;
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      Effect.gen(function* () {
        const counter = yield* (yield* CounterRepository).bump(
          yield* Clock.currentTimeMillis,
        );
        yield* Effect.logInfo(
          `ShopAgent.bump: shop=${shop} count=${String(counter.count)}`,
        ).pipe(Effect.annotateLogs({ shop, count: counter.count }));
        yield* notifyChanged();
        return counter;
      }).pipe(Effect.withLogSpan("ShopAgent.bump")),
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

  getCounter(): Promise<Domain.Counter> {
    return this.runEffect(
      CounterRepository.pipe(
        Effect.flatMap((repository) => repository.get()),
        Effect.withLogSpan("ShopAgent.getCounter"),
      ),
    );
  }

  /**
   * Everything the admin drill-down reads out of this object, in one RPC.
   * Counters and stored rows only — the plan-derived ceilings they are
   * displayed against live in D1 and are attached by the route.
   */
  getAdminSnapshot(): Promise<Domain.AdminShopAgentSnapshot> {
    return this.runEffect(
      Effect.gen(function* () {
        return {
          counter: yield* (yield* CounterRepository).get(),
        } satisfies Domain.AdminShopAgentSnapshot;
      }).pipe(Effect.withLogSpan("ShopAgent.getAdminSnapshot")),
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
      const { written } = yield* (yield* OrderRepository).upsertOrder({
        order: toShopOrder({
          node: order,
          source,
          syncedAt: yield* Clock.currentTimeMillis,
          lineItemsComplete,
        }),
        raw: toOrderRaw(order),
        lineItems: order.lineItems.nodes.map((node) =>
          toOrderLineItem(order.id, node),
        ),
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
   * new. Contrast {@link bump}'s JSDoc: `ShopAgentClient` is for calls that
   * must carry a Worker-resolved input such as a plan ceiling.
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
    return this.runEffect(
      callableEffect(
        "ShopAgent.onOrdersStream",
        OrdersStreamInput,
      )(({ url }) =>
        Effect.gen(function* () {
          const counts = yield* runShopAgentOrdersStream({ url });
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
          yield* (yield* OrderRepository).deleteOrder(orderId);
          yield* Effect.logInfo(
            `ShopAgent.deleteOrder: shop=${shop} orderId=${orderId}`,
          ).pipe(Effect.annotateLogs({ shop, orderId }));
          yield* notifyChanged();
        }),
      )(input),
    );
  }

  @callable()
  getOrders(input: Domain.GetOrdersInput): Promise<Domain.OrdersView> {
    return this.runEffect(
      callableEffect("ShopAgent.getOrders", Domain.GetOrdersInput, {
        onExcessProperty: "error",
      })((page) =>
        Effect.gen(function* () {
          const repository = yield* OrderRepository;
          return {
            page: yield* repository.listOrders(page),
            syncState: yield* repository.getSyncState(),
          } satisfies Domain.OrdersView;
        }),
      )(input),
    );
  }
}

import type { OrdersSyncParams } from "@/lib/OrdersSyncWorkflow";

import { SqliteClient } from "@effect/sql-sqlite-do";
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

import { BillingAgent } from "@/lib/agent/Billing";
import { ShopAgentHost } from "@/lib/agent/Host";
import { OrdersAgent } from "@/lib/agent/Orders";
import { ShopWorkAgent } from "@/lib/agent/ShopWork";
import { instrumentationIsOn } from "@/lib/CloudflareEnv";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import {
  causeToErrorMessage,
  makeEnvLayer,
  makeLoggerLayer,
} from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { ORDERS_SYNC_WORKFLOW_NAME } from "@/lib/orderSyncConstants";
import { Repository } from "@/lib/Repository";
import { RunRepository } from "@/lib/RunRepository";
import {
  type OrdersStreamCounts,
  runShopAgentOrdersStream,
} from "@/lib/ShopAgentOrdersStream";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAppEvents } from "@/lib/ShopifyAppEvents";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

/**
 * A failure on the publish and revoke paths: reading the connections, sending
 * an invalidation, or closing a revoked connection. Never surfaced: each site
 * logs it and carries on, for the reasons on `publish` and
 * `closeMemberConnections`.
 */
class ShopAgentPublishError extends Schema.TaggedError<ShopAgentPublishError>()(
  "ShopAgentPublishError",
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
      }
    : { role };
};

/** The tag every member connection carries, so a membership change can find and close it. */
const memberConnectionTag = (memberId: string) => `member:${memberId}`;

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
type CallerRole = "merchant" | "member" | "rpc";

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
    if (state.value.role !== role)
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
 * Two SQL stores coexist. `Repository` runs over D1 (shared, sessions) via the
 * app-owned `D1Session`/`D1Primary` tags; `OrderRepository` runs over the DO's
 * private SQLite (`ctx.storage`, per-shop), whose `SqliteClient.layer` is the
 * only provider of the ambient `SqlClient` tag here. That is what
 * `runShopAgentMigrations` (which requests `SqlClient` directly) needs. Each
 * repository closes over its own client at layer-build time, so the ambient tag
 * only governs the migration.
 */
const makeRunEffect = (
  env: Env,
  storage: DurableObjectStorage,
  host: ShopAgentHost["Service"],
) => {
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
  const baseLayer = Layer.mergeAll(
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
    Layer.succeed(ShopAgentHost, host),
  );
  const layer = Layer.mergeAll(OrdersAgent.layer, ShopWorkAgent.layer).pipe(
    Layer.provideMerge(BillingAgent.layer),
    Layer.provideMerge(baseLayer),
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

/** One pass over the usage-event outbox; the rule is on {@link BillingAgent}'s `flushUsageEvents`. */
const flushUsageEvents = BillingAgent.pipe(
  Effect.flatMap((billing) => billing.flushUsageEvents),
);

/** Shop work's per-order reconciler, loaded before the store's transaction opens. */
const reconciler = ShopWorkAgent.pipe(
  Effect.flatMap((shopWork) => shopWork.reconciler()),
);

/** Stores one order ({@link OrdersAgent}) and reconciles it ({@link reconciler}). */
const fetchAndUpsertOrder = (orderId: string) =>
  Effect.gen(function* () {
    const { gone, changed } = yield* (yield* OrdersAgent).fetchAndUpsertOrder(
      { orderId },
      reconciler,
    );
    return { gone, changed };
  });

const SHOP_AGENT_BINDING = "SHOP_AGENT";

/**
 * Statuses the Agents SDK's tracking row carries while an open-orders sync is
 * under way. `waiting` is in the set because a refreshed row reads that way while
 * the instance sleeps between polls (`OrdersSyncWorkflow`), and a sleeping
 * sync is still a sync.
 */
const SYNC_IN_FLIGHT = ["queued", "running", "waiting"] as const;

/**
 * How long a tracking row is trusted. The SDK never reaps a row: a Workflow
 * that dies without reporting leaves one reading `running` forever. Ten
 * minutes is comfortably past the workflow's own give-up bound plus its
 * stream, so a row older than this is dead.
 *
 * **A tracking row disables Sync open orders only while it is fresh**
 * ({@link syncRowIsFresh}). The orders index reads a stale row as no sync,
 * so the button comes back, and the next press deletes the row without
 * asking Cloudflare ({@link ShopAgent.syncOpenOrders}) and starts a new
 * sync. Were a stale row to keep the button disabled, the press that clears
 * it could never happen, and one dead instance would disable the button for
 * good. Rule 3 on `Domain.syncOrder`.
 */
const SYNC_STALE_MS = 10 * 60 * 1000;

/** A tracking row younger than {@link SYNC_STALE_MS} at `now`: trusted; an older one is dead. */
const syncRowIsFresh = (row: { readonly createdAt: Date }, now: number) =>
  now - row.createdAt.getTime() < SYNC_STALE_MS;

/**
 * What `/webhooks/orders` resolved a delivery down to: the order it names, the
 * topic for the log line, and the `updated_at` the stale guard reads — `null`
 * for `orders/edited`, whose payload has none, which is what makes an edit
 * always fetch.
 */
export const OrderWebhookInput = Schema.Struct({
  orderId: Schema.NonEmptyString,
  topic: Schema.String,
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
 * transaction completes, connection state writes and WebSocket sends below
 * are synchronous in the resumed turn. `blockConcurrencyWhile()` is therefore only
 * needed for constructor migrations. Revisit this only if a state transition starts
 * awaiting non-storage I/O such as `fetch()`.
 *
 * The object is addressed by shop domain (`env.SHOP_AGENT.getByName(shop)`), so
 * `this.name` is the shop and no method takes one.
 *
 * The action set is the one gate on every run write; the rule is on
 * `requireRunAction` in `src/lib/agent/ShopWork.ts`.
 */
export class ShopAgent extends Agent {
  declare private readonly runEffect: ReturnType<typeof makeRunEffect>;

  /**
   * Set for the width of the `await` inside {@link ShopAgent.syncOpenOrders} that
   * creates the workflow instance, and read by the next click. The object
   * runs one JavaScript thread, so a plain field is complete mutual exclusion
   * over the one window no stored row can cover: the Agents SDK inserts its
   * tracking row only after that same await returns.
   */
  private syncStarting = false;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        Domain.SocketKeepalivePing,
        Domain.SocketKeepalivePong,
      ),
    );
    this.runEffect = makeRunEffect(env, ctx.storage, {
      shop: () => this.name,
      publish: Effect.suspend(() => this.publish()),
      closeMemberConnections: (memberIds) =>
        this.closeMemberConnections(memberIds),
      databaseSize: Effect.sync(() => this.ctx.storage.sql.databaseSize),
      /**
       * Read, never refreshed: this is the loader half of a page and must not
       * reach the Workflows API. Fresh rows only ({@link SYNC_STALE_MS} is the
       * rule), so a row wedged by a dead instance leaves the button enabled and
       * the next press ({@link ShopAgent.syncOpenOrders}) deletes it.
       */
      syncInFlight: (now) =>
        Effect.sync(() =>
          this.getWorkflows({
            status: [...SYNC_IN_FLIGHT],
            workflowName: ORDERS_SYNC_WORKFLOW_NAME,
          }).workflows.some((row) => syncRowIsFresh(row, now)),
        ),
    });
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
   * `getConnections(tag)` filters on, so they carry only what a fan-out (the
   * set of connections one publish or revoke reaches) has
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

  private connections() {
    return Effect.try({
      try: () => [...this.getConnections()],
      catch: (cause) =>
        new ShopAgentPublishError({ message: "getConnections failed", cause }),
    });
  }

  /**
   * Sends one identified connection the invalidation and answers the role it
   * sent to, or `null`; an unidentified connection, or a send that throws,
   * answers `null`.
   */
  private publishTo(connection: Connection) {
    const shop = this.name;
    return Effect.try({
      try: () => {
        const state = Option.getOrNull(connectionState(connection));
        if (!state) return null;
        connection.send(
          JSON.stringify({
            type: "invalidated",
          } satisfies Domain.InvalidatedMessage),
        );
        return state.role;
      },
      catch: (cause) =>
        new ShopAgentPublishError({
          message: "invalidated send failed",
          cause,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug(`ShopAgent.publishTo: shop=${shop}`).pipe(
          Effect.annotateLogs({ shop, error: error.message }),
          Effect.as(null),
        ),
      ),
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
            new ShopAgentPublishError({
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
   * write that changed a membership (the team page, the member page). A
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
   * shop's app subscription lapsed.
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
                "app subscription lapsed",
              );
          },
          catch: (cause) =>
            new ShopAgentPublishError({
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
   * **A publish follows a write that succeeded, and goes to every
   * connection.** The webhook path and the one-order sync hold "succeeded"
   * through `OrdersAgent`'s `fetchAndUpsertOrder` `changed`: the order row
   * moved (`fresh`, or a newer `updatedAt`; never `syncedAt`, which no screen
   * shows) or the reconcile created, resized or closed a run. A redelivery,
   * or an edit that fetched the version already stored, writes the same row
   * and reconciles to the same runs, and no live screen would read anything
   * new. A publish names nothing: every identified connection receives the
   * invalidation, and every mounted live screen re-reads. The tab's throttle
   * (`INVALIDATION_THROTTLE_MS` on `useLiveQuery`) is what bounds the cost.
   *
   * **A publish clears the list memo before the first invalidation goes
   * out.** The memo holds each list read's last answer per key, in the
   * object's memory: the orders index page (`ShopWorkAgent`'s `listOrders`)
   * and the rows a team set owns on the workflows list (`readRuns`). Every
   * tab refetches after an invalidation, so the tabs that share a key share
   * one computation instead of one each; and because the clear happens before
   * any invalidation is sent, a refetch after one always computes fresh. It
   * runs with no connections too: a loader read is memoized the same way.
   * Every write that succeeded publishes, the retention sweep included, so
   * the memo and the screens move together. A lookup in flight when the clear
   * runs is dropped from the memo, never stored: its caller still gets the
   * value, correct for the moment it asked, and is about to be told to
   * refetch (Effect's `Cache.invalidateAll`). The memo is not state: it
   * starts empty on every activation, so after a wake each key costs one
   * computation at the unmemoized price. Keeping it across hibernation would
   * need a table and a read on every hit, which is the cost it exists to
   * avoid.
   *
   * The sites: every write that publishes. `when` is `changed` where the
   * write reports whether it changed anything (the two fetch paths, and the
   * retention sweep, which reports the rows it deleted); `written` after a
   * call whose result is `Ok`, through `publishIfOk` in `ShopWorkAgent`; a
   * refused call publishes nothing, since it wrote nothing a live screen
   * shows and the refused tab re-reads on its own result. Three `written`
   * rows publish on every call because the call is the write: the
   * open-orders sync's start or refusal and its endings change what the
   * orders index shows (its sync state, the ceiling banner), and Delete
   * team's `NotFound` still nulls dangling team pointers and reconciles.
   *
   * | trigger                                                                    | when    | pinned by |
   * | -------------------------------------------------------------------------- | ------- | --------- |
   * | order webhook (create, paid, cancelled, fulfilled, edited)                 | changed | a webhook on the same version whose reconcile creates a run publishes; a webhook that moves the order's updatedAt publishes even when no run moved |
   * | order webhook, the retention sweep deleted something                       | changed | a webhook whose sweep deletes an order publishes and the orders index stops showing it |
   * | Sync open orders pressed, started or refused (in flight publishes nothing) | written | Sync open orders publishes to every screen when it starts or is refused |
   * | the open-orders stream finishes                                            | written | the open-orders stream publishes to every screen when it finishes |
   * | the sync workflow completes, or fails (its error sink, then its callback)  | written | the open-orders sync publishes to every screen when its workflow completes; the open-orders sync publishes to every screen when its workflow fails |
   * | Sync this order pressed                                                    | changed | Sync this order publishes when it changed something, and nothing when it did not |
   * | Edit tag, Apply                                                            | written | Edit tag and Apply publish to every screen whether or not a run moved; a refused call publishes nothing |
   * | the switch, the editor's Turn on, Delete workflow, Delete team      | written | turning a workflow on or off, deleting it, or deleting a team publishes to every screen; a refused call publishes nothing |
   * | Assign a task's team                                                       | written | assigning a task's team publishes to every screen |
   * | Attach workflow                                                            | written | Attach workflow publishes to every screen |
   * | Cancel workflow                                                            | written | Cancel workflow publishes to every screen |
   * | a merchant run or task verb                                                | written | completes a member's task over a merchant socket and publishes; a refused call publishes nothing |
   * | a member run or task verb                                                  | written | every connection receives every publish; a refused call publishes nothing |
   * | seed (dev)                                                                 | written | the seed publishes once to every screen |
   *
   * Workflow configuration is loader data and does not publish, except Edit
   * tag, Apply and the switch, which change what the order page's Workflow
   * select shows (`matchedWorkflows`, `otherWorkflows`).
   *
   * An invalidation is best-effort and never the new value: SQLite stays
   * authoritative and a live screen re-reads, so a dropped invalidation
   * costs a stale render until the next publish or reconnect rather than a
   * lost write. That is why a send failure is swallowed here instead of
   * failing the mutation that triggered it.
   *
   * Logs one line per publish with how many merchant and member connections
   * received the invalidation, under `instrumentationIsOn`. The counts, with
   * `listOrders`'s and `readRuns`'s `ms=`, are how the fan-out is measured.
   */
  private publish() {
    const shop = this.name;
    const instrumented = instrumentationIsOn(this.env.ENVIRONMENT);
    /* Through the runtime, as a nested run: the memo is shop work's, and the
       host this method is published through carries no services. */
    const clearListMemo = Effect.promise(() =>
      this.runEffect(
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.clearListMemo),
        ),
      ),
    );
    return clearListMemo.pipe(
      Effect.andThen(this.connections()),
      Effect.flatMap((connections) =>
        Effect.all(connections.map((connection) => this.publishTo(connection))),
      ),
      Effect.flatMap((sent) => {
        if (!instrumented) return Effect.void;
        const merchants = sent.filter((role) => role === "merchant").length;
        const members = sent.filter((role) => role === "member").length;
        return Effect.logInfo(
          `ShopAgent.publish: shop=${shop} merchants=${String(merchants)} members=${String(members)}`,
        ).pipe(Effect.annotateLogs({ shop, merchants, members }));
      }),
      Effect.ignore({
        log: "Debug",
        message: `ShopAgent.publish: shop=${this.name}`,
      }),
    );
  }

  /**
   * Starts the open-orders sync, or reports the one already running.
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
   * Rule 3 on `Domain.syncOrder`: one open-orders sync at a time, and the
   * SDK's `cf_agents_workflows` row is its only record, so there is no
   * reservation to reconcile against it and no way for the two to disagree.
   * Rule 5 there: the order ceiling is read before the start. Two cases,
   * and the code below is both:
   *
   * - *Two clicks in one tick.* `runWorkflow` awaits `workflow.create` before
   *   it inserts the tracking row, so a second call during that await would
   *   read an empty {@link SYNC_IN_FLIGHT} query. The object runs one
   *   JavaScript thread and `getWorkflows` is synchronous, so the plain
   *   `syncStarting` field set before the await closes the gap exactly.
   * - *A throw between `create` and the insert.* The instance runs untracked
   *   and this call surfaces the error. Harmless: the query is fixed and the
   *   upsert idempotent, so the orphan run does exactly what a re-click would,
   *   and the next click starts a fresh one.
   *
   * A row older than {@link SYNC_STALE_MS} is dead and is deleted before the
   * start, without asking Cloudflare: the SDK never reaps its own rows, and
   * nothing else would delete it.
   */
  @callable()
  syncOpenOrders(): Promise<Domain.OrdersSyncResult> {
    const shop = this.name;
    const trackedSyncs = () =>
      this.getWorkflows({
        status: [...SYNC_IN_FLIGHT],
        workflowName: ORDERS_SYNC_WORKFLOW_NAME,
      }).workflows;
    const deleteWorkflow = (workflowId: string) =>
      this.deleteWorkflow(workflowId);
    const startWorkflow = () =>
      Effect.tryPromise(() =>
        this.runWorkflow(
          ORDERS_SYNC_WORKFLOW_NAME,
          { shop } satisfies OrdersSyncParams,
          { agentBinding: SHOP_AGENT_BINDING },
        ),
      );
    const beginStarting = () => {
      this.syncStarting = true;
    };
    const endStarting = () => {
      this.syncStarting = false;
    };
    const starting = () => this.syncStarting;
    const publish = () => this.publish();
    return this.runEffect(
      Effect.gen(function* () {
        // The one `@callable()` that takes no input, so it has no
        // `callableEffect` to carry the role check; the check is the same.
        yield* connectionRoleGuard("merchant");
        const repository = yield* OrderRepository;
        const now = yield* Clock.currentTimeMillis;
        const inFlight = Effect.fn("ShopAgent.syncOpenOrders.inFlight")(
          function* () {
            const running = trackedSyncs();
            const stale = running.filter((row) => !syncRowIsFresh(row, now));
            yield* Effect.forEach(
              stale,
              ({ workflowId }) =>
                Effect.logWarning(
                  `ShopAgent.syncOpenOrders: shop=${shop} workflowId=${workflowId}: tracking row stale, deleted`,
                ).pipe(
                  Effect.annotateLogs({ shop, workflowId }),
                  Effect.andThen(Effect.sync(() => deleteWorkflow(workflowId))),
                ),
              { discard: true },
            );
            return running.length > stale.length;
          },
        );
        if (starting() || (yield* inFlight())) {
          yield* Effect.logInfo(
            `ShopAgent.syncOpenOrders: shop=${shop} status=in-flight`,
          ).pipe(Effect.annotateLogs({ shop, status: "in-flight" }));
          return { _tag: "InFlight" } satisfies Domain.OrdersSyncResult;
        }
        /**
         * The order ceiling, read against the open orders stored now (rule 5
         * on `Domain.syncOrder`). No storage guard beside it: the ceiling is
         * what bounds how much this object can take on.
         */
        const openOrders = yield* repository.countOpenOrders();
        if (Domain.openOrdersAtCeiling(openOrders)) {
          const limit = Domain.ShopLimits.maxOpenOrders;
          yield* Effect.logError(
            `ShopAgent.syncOpenOrders: shop=${shop} status=order-ceiling openOrders=${String(openOrders)} limit=${String(limit)}`,
          ).pipe(
            Effect.annotateLogs({
              shop,
              status: "order-ceiling",
              openOrders,
              limit,
            }),
          );
          yield* repository.markOrdersLimited(now);
          yield* publish();
          return { _tag: "Refused" } satisfies Domain.OrdersSyncResult;
        }
        yield* repository.clearSyncError();
        // The start is what closes the gap the flag announced
        // (`OrderRepository.clearOrdersLimited`).
        yield* repository.clearOrdersLimited();
        const workflowId = yield* Effect.acquireUseRelease(
          Effect.sync(beginStarting),
          startWorkflow,
          () => Effect.sync(endStarting),
        );
        yield* Effect.logInfo(
          `ShopAgent.syncOpenOrders: shop=${shop} status=started workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, status: "started", workflowId }));
        yield* publish();
        return { _tag: "Started" } satisfies Domain.OrdersSyncResult;
      }).pipe(Effect.withLogSpan("ShopAgent.syncOpenOrders")),
    );
  }

  /**
   * RPC target for the workflow, not `@callable()`: nothing browser-side calls
   * it, and it takes a URL that must only ever come from a bulk operation this
   * shop started (rule 15 on `Domain.syncOrder`). The stream merges and the
   * retention pass rides it (rule 9); every order carries the stream's one
   * `syncedAt` (rule 11); the usage queue is sent once after it, whatever
   * became of it (rule 12).
   *
   * A step retry re-streams the whole file when the sweep or the flush
   * throws after the writes: correct under rule 7, a full second pass, and
   * rare.
   */
  onOrdersStream(input: { readonly url: string }): Promise<OrdersStreamCounts> {
    const shop = this.name;
    const publish = () => this.publish();
    const databaseSize = () => this.ctx.storage.sql.databaseSize;
    return this.runEffect(
      callableEffect("ShopAgent.onOrdersStream", OrdersStreamInput, {
        role: "rpc",
      })(({ url }) =>
        Effect.gen(function* () {
          // After the stream, never per order (pass rule 4 on
          // `Domain.reconcileItem`): an open-orders sync can queue
          // thousands of events, and the API takes one request each at 500 a
          // second, so the drain is batched (`ShopLimits.sweepBatch`) and the
          // remainder rides the next webhook. `ensuring`, because a stream
          // that fails halfway has already counted and queued every order it
          // stored, and those events are owed whatever became of the rest.
          const counts = yield* runShopAgentOrdersStream({
            url,
            afterWrite: yield* reconciler,
          }).pipe(Effect.ensuring(flushUsageEvents));
          if (counts.ordersRefused > 0)
            yield* Effect.logError(
              `ShopAgent.onOrdersStream: shop=${shop} status=order-ceiling ordersRefused=${String(counts.ordersRefused)} limit=${String(Domain.ShopLimits.maxOpenOrders)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                status: "order-ceiling",
                ordersRefused: counts.ordersRefused,
                limit: Domain.ShopLimits.maxOpenOrders,
              }),
            );
          /**
           * The retention pass rides the open-orders sync: it is merchant-triggered,
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
   * The last 30 days held no orders. Deliberately does not touch stored rows:
   * unlike a catalog scan, an empty result means "nothing changed", never
   * "the shop has no orders" (rule 9 on `Domain.syncOrder`).
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
   * so the merchant sentence survives even if the callback that follows never
   * arrives. Rule 14 on `Domain.syncOrder`: this write is the banner, and
   * {@link ShopAgent.onWorkflowError} writes only when this never ran.
   */
  onOrdersSyncError(input: { readonly message: string }): Promise<void> {
    const shop = this.name;
    const publish = () => this.publish();
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
   * A completed sync leaves nothing behind but its rows (rule 13 on
   * `Domain.syncOrder`): the tracking row goes, which is what re-enables the
   * button. The workflow reports no result — there is nothing about the run
   * the object does not already know — so nothing is decoded.
   */
  override async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
  ): Promise<void> {
    if (workflowName !== ORDERS_SYNC_WORKFLOW_NAME) return;
    const shop = this.name;
    const deleteWorkflow = () => this.deleteWorkflow(workflowId);
    const publish = () => this.publish();
    await this.runEffect(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          `ShopAgent.onWorkflowComplete: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        yield* Effect.sync(deleteWorkflow);
        yield* publish();
      }).pipe(Effect.withLogSpan("ShopAgent.onWorkflowComplete")),
    );
  }

  /**
   * Rule 14 on `Domain.syncOrder`: the sink wrote the sentence; this callback
   * deletes the tracking row and writes a message only when the sink never
   * ran. Deleting the tracking row is what re-enables the button: it is the
   * only record that a sync is running ({@link ShopAgent.syncOpenOrders}),
   * so a row left behind by a failed run would wedge it until the staleness
   * refresh.
   */
  override async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    if (workflowName !== ORDERS_SYNC_WORKFLOW_NAME) return;
    const shop = this.name;
    const deleteWorkflow = () => this.deleteWorkflow(workflowId);
    const publish = () => this.publish();
    await this.runEffect(
      Effect.gen(function* () {
        yield* Effect.logError(
          `ShopAgent.onWorkflowError: shop=${shop} workflowId=${workflowId}: ${error}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, error }));
        yield* (yield* OrderRepository).setSyncErrorIfEmpty({ error });
        yield* Effect.sync(deleteWorkflow);
        yield* publish();
      }).pipe(Effect.withLogSpan("ShopAgent.onWorkflowError")),
    );
  }

  /**
   * The webhook path. Not `@callable()` — it is reached only from
   * `/webhooks/orders`, after HMAC validation.
   *
   * Rules 1, 2, 5, 9 and 12 on `Domain.syncOrder`: the order is fetched
   * whole and the topic decides nothing; a payload no newer than the row
   * returns without a fetch; the ceiling is read before the fetch; the
   * retention pass rides it, rate-limited; the usage queue is sent after the
   * write. A redelivery is not deduplicated: it is skipped by the version
   * check, or, for an edit, fetches and rewrites the same version, which
   * changes nothing and publishes nothing (rule 16; the rule on `publish`).
   * The upsert's own version check is what survives two paths writing at
   * once.
   *
   * Each order goes through four steps, each owned by one module: store
   * ({@link OrdersAgent}), reconcile (shop work's reconciler, passed to the
   * store as its `afterWrite`), flush ({@link BillingAgent}) and publish
   * (this object's `publish`): the sync pipeline table on {@link ShopAgentHost}.
   */
  syncOrderWebhook(input: OrderWebhookInput): Promise<void> {
    const shop = this.name;
    const publish = () => this.publish();
    return this.runEffect(
      callableEffect("ShopAgent.syncOrderWebhook", OrderWebhookInput, {
        role: "rpc",
      })(({ orderId, topic, updatedAt }) =>
        Effect.gen(function* () {
          const repository = yield* OrderRepository;
          const stored = yield* repository.getOrderUpdatedAt(orderId);
          if (
            updatedAt !== null &&
            Option.isSome(stored) &&
            updatedAt <= stored.value
          ) {
            yield* Effect.logInfo(
              `ShopAgent.syncOrderWebhook: shop=${shop} topic=${topic} status=stale`,
            ).pipe(
              Effect.annotateLogs({ shop, topic, orderId, status: "stale" }),
            );
            return;
          }
          /**
           * The order ceiling, and the only hard stop on orders, read
           * against the open orders stored now (rule 5). It gates *new*
           * orders only — `getOrderUpdatedAt` answering none is what makes
           * it one, and the only case the count is read — so every order
           * Baton already carries keeps receiving its updates. The webhook
           * still returns
           * 2xx: a retry cannot change the answer, and making Shopify replay
           * a delivery for four hours to reach the same refusal helps nobody.
           *
           * No publish: the refusal stored no order, so no live screen
           * would read anything new. The critical banner arrives with the
           * orders index's next loader read, since usage is deliberately
           * loader-only (the orders index's loader data).
           */
          if (Option.isNone(stored)) {
            const openOrders = yield* repository.countOpenOrders();
            if (Domain.openOrdersAtCeiling(openOrders)) {
              const limit = Domain.ShopLimits.maxOpenOrders;
              yield* repository.markOrdersLimited(
                yield* Clock.currentTimeMillis,
              );
              yield* Effect.logError(
                `ShopAgent.syncOrderWebhook: shop=${shop} topic=${topic} status=order-ceiling openOrders=${String(openOrders)} limit=${String(limit)}`,
              ).pipe(
                Effect.annotateLogs({
                  shop,
                  topic,
                  orderId,
                  status: "order-ceiling",
                  openOrders,
                  limit,
                }),
              );
              return;
            }
          }
          yield* Effect.logInfo(
            `ShopAgent.syncOrderWebhook: shop=${shop} topic=${topic} orderId=${orderId} status=fetch`,
          ).pipe(
            Effect.annotateLogs({ shop, topic, orderId, status: "fetch" }),
          );
          const { changed } = yield* fetchAndUpsertOrder(orderId);
          /**
           * The second retention carrier, rate-limited by `lastSweepAt`
           * rather than run on every delivery: a busy shop must not pay for
           * a batch of deletes per webhook. One column is read, not the
           * usage row: that row counts the open orders, and a stored-order
           * webhook, most of a shop's traffic, reads no count.
           *
           * With the open-orders sync, this is the whole of when orders age out.
           * There is no alarm, so a shop that receives no webhooks and runs
           * no sync never sweeps — which is correct rather than a gap: it
           * is also a shop that is not growing, and its rows sit inert
           * until uninstall destroys the object
           * ({@link Domain.ShopLimits.orderRetentionDays}).
           */
          const now = yield* Clock.currentTimeMillis;
          const lastSweepAt = yield* repository.lastSweepAt();
          const swept =
            lastSweepAt === null ||
            now - lastSweepAt >= Domain.ShopLimits.sweepIntervalMs
              ? yield* repository.sweepExpiredOrders({ now })
              : { orders: 0, runs: 0 };
          const sweptAny = swept.orders > 0 || swept.runs > 0;
          if (sweptAny)
            yield* Effect.logInfo(
              `ShopAgent.syncOrderWebhook: shop=${shop} sweptOrders=${String(swept.orders)} sweptRuns=${String(swept.runs)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                sweptOrders: swept.orders,
                sweptRuns: swept.runs,
              }),
            );
          /**
           * A sweep that deleted rows is a write the screens show (a Done
           * order gone, a run gone with it), so it publishes even when the
           * webhook's own order did not change; without it the list memo
           * ({@link ShopAgent.publish}) would answer the swept rows until the
           * next publish.
           */
          yield* changed || sweptAny
            ? publish()
            : Effect.logInfo(
                `ShopAgent.syncOrderWebhook: shop=${shop} topic=${topic} orderId=${orderId} status=unchanged`,
              ).pipe(
                Effect.annotateLogs({
                  shop,
                  topic,
                  orderId,
                  status: "unchanged",
                }),
              );
          // Outside the upsert's transaction, because it does network I/O
          // and Durable Object SQLite transactions must not await anything
          // but storage. The webhook path is the outbox's ordinary carrier:
          // an order that queued an event flushes it, and a shop still
          // syncing drains whatever earlier events failed.
          yield* flushUsageEvents;
        }),
      )(input),
    );
  }

  /**
   * The shop's usage; the rule is on {@link BillingAgent}'s `getUsage`.
   * `@callable()` so the `/app` socket can read it, and on `ShopAgentClient`
   * so loaders can.
   */
  @callable()
  getUsage(): Promise<Domain.ShopUsage> {
    return this.runEffect(
      Effect.gen(function* () {
        yield* connectionRoleGuard("merchant");
        return yield* (yield* BillingAgent).getUsage;
      }).pipe(Effect.withLogSpan("ShopAgent.getUsage")),
    );
  }

  /**
   * Records the billing cycle; the rule is on {@link BillingAgent}'s
   * `setBillingCycle`. Plain RPC, not `@callable()`: the caller is
   * `SubscriptionPlan`, which is the only thing that reads an app
   * subscription, and a browser naming its own billing cycle would be naming
   * its own bill.
   */
  setBillingCycle(
    input: typeof Domain.BillingCycleInput.Encoded,
  ): Promise<void> {
    return this.runEffect(
      callableEffect("ShopAgent.setBillingCycle", Domain.BillingCycleInput, {
        role: "rpc",
      })((cycle) =>
        BillingAgent.pipe(
          Effect.flatMap((billing) => billing.setBillingCycle(cycle)),
        ),
      )(input),
    );
  }

  /**
   * Drains the usage-event outbox and answers how many rows are left
   * ({@link flushUsageEvents}). Plain RPC: the callers are the Worker's
   * uninstall webhook, which has 24 hours before Shopify closes the billing
   * cycle and is about to destroy this object's storage, and the Manage plan
   * button (`SubscriptionPlan.expectChange`), before a plan change ends the
   * app subscription.
   */
  flushUsageEvents(): Promise<number> {
    return this.runEffect(
      Effect.gen(function* () {
        yield* connectionRoleGuard("rpc");
        const flush = yield* flushUsageEvents;
        return flush.remaining;
      }).pipe(Effect.withLogSpan("ShopAgent.flushUsageEvents")),
    );
  }

  /**
   * `@callable()` and it does take an argument, unlike {@link syncOpenOrders} — but
   * the id is only ever spent against this shop's own offline session, so a
   * foreign one fails at Shopify rather than reaching another shop's data
   * (rule 15 on `Domain.syncOrder`). No staleness check: a
   * merchant clicking Sync from Shopify is asking for the fetch, and the
   * upsert guard still protects the row.
   *
   * Sends the usage queue afterwards ({@link flushUsageEvents}), whether or
   * not the fetch succeeded (rule 12): the reconcile may have started the
   * order's first run, which counts it. Answers `Domain.SyncOrderResult`, so
   * the order page can say when Shopify no longer has the order. Publishes
   * only when the write changed something (the rule on `publish`).
   */
  @callable()
  syncOrder(input: Domain.SyncOrderInput): Promise<Domain.SyncOrderResult> {
    const publish = () => this.publish();
    return this.runEffect(
      callableEffect("ShopAgent.syncOrder", Domain.SyncOrderInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })(({ orderId }) =>
        Effect.gen(function* () {
          const { gone, changed } = yield* fetchAndUpsertOrder(orderId);
          if (changed) yield* publish();
          return (
            gone ? { _tag: "Gone" } : { _tag: "Stored" }
          ) satisfies Domain.SyncOrderResult;
        }).pipe(Effect.ensuring(flushUsageEvents)),
      )(input),
    );
  }

  /**
   * The orders index's read; the rule is on {@link ShopWorkAgent}'s
   * `listOrders`. One method for both reads of a live screen (the rule on
   * `ShopAgentClient`): the loader reads it through `ShopAgentClient` with no
   * connection, which the `"merchant"` role admits, and `useLiveQuery` reads
   * it over the merchant socket.
   */
  @callable()
  listOrders(input: Domain.ListOrdersInput): Promise<Domain.OrdersIndexData> {
    return this.runEffect(
      callableEffect("ShopAgent.listOrders", Domain.ListOrdersInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.listOrders(decoded)),
        ),
      )(input),
    );
  }

  /**
   * The workflows index's loader read; the rule is on {@link ShopWorkAgent}'s
   * `listWorkflows`. Plain RPC, not `@callable()`: workflow definitions are
   * configuration, so `/app/workflows` reads them through its loader via
   * `ShopAgentClient` (the loader-versus-socket rule documented there). Only
   * the mutations stay on the socket.
   */
  listWorkflows(
    input: typeof Domain.ListWorkflowsInput.Encoded,
  ): Promise<Domain.WorkflowsIndexData> {
    return this.runEffect(
      callableEffect("ShopAgent.listWorkflows", Domain.ListWorkflowsInput, {
        role: "rpc",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.listWorkflows(decoded)),
        ),
      )(input),
    );
  }

  /**
   * The workflow page's loader read; the rule is on {@link ShopWorkAgent}'s
   * `getWorkflowDetail`. Plain RPC, not `@callable()`, for the reason on
   * {@link ShopAgent.listWorkflows}.
   */
  getWorkflowDetail(
    input: typeof Domain.WorkflowIdInput.Encoded,
  ): Promise<Domain.WorkflowPageData | null> {
    return this.runEffect(
      callableEffect("ShopAgent.getWorkflowDetail", Domain.WorkflowIdInput, {
        role: "rpc",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.getWorkflowDetail(decoded)),
        ),
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
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.createWorkflow(decoded)),
        ),
      )(input),
    );
  }

  /** Duplicates a workflow; the rule is on {@link ShopWorkAgent}'s `duplicateWorkflow`. */
  @callable()
  duplicateWorkflow(
    input: typeof Domain.DuplicateWorkflowInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.duplicateWorkflow",
        Domain.DuplicateWorkflowInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.duplicateWorkflow(decoded)),
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
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.updateWorkflow(decoded)),
        ),
      )(input),
    );
  }

  /** Changes a workflow's tag; the rule is on {@link ShopWorkAgent}'s `updateWorkflowTag`. */
  @callable()
  updateWorkflowTag(
    input: typeof Domain.UpdateWorkflowTagInput.Encoded,
  ): Promise<Domain.WorkflowResult> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.updateWorkflowTag",
        Domain.UpdateWorkflowTagInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.updateWorkflowTag(decoded)),
        ),
      )(input),
    );
  }

  /** Edit: creates the draft; the rule is on {@link ShopWorkAgent}'s `createDraft`. */
  @callable()
  createDraft(
    input: typeof Domain.CreateDraftInput.Encoded,
  ): Promise<Domain.DraftResult> {
    return this.runEffect(
      callableEffect("ShopAgent.createDraft", Domain.CreateDraftInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.createDraft(decoded)),
        ),
      )(input),
    );
  }

  /** Apply changes; the rule is on {@link ShopWorkAgent}'s `applyDraft`. */
  @callable()
  applyDraft(
    input: typeof Domain.ApplyDraftInput.Encoded,
  ): Promise<Domain.ApplyResult> {
    return this.runEffect(
      callableEffect("ShopAgent.applyDraft", Domain.ApplyDraftInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.applyDraft(decoded)),
        ),
      )(input),
    );
  }

  @callable()
  discardDraft(
    input: typeof Domain.DiscardDraftInput.Encoded,
  ): Promise<Domain.DiscardResult> {
    return this.runEffect(
      callableEffect("ShopAgent.discardDraft", Domain.DiscardDraftInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.discardDraft(decoded)),
        ),
      )(input),
    );
  }

  /** The switch; the rule is on {@link ShopWorkAgent}'s `setWorkflowState`. */
  @callable()
  setWorkflowState(
    input: typeof Domain.SetWorkflowStateInput.Encoded,
  ): Promise<Domain.SwitchResult> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.setWorkflowState",
        Domain.SetWorkflowStateInput,
        {
          role: "merchant",
          parse: { onExcessProperty: "error" },
        },
      )((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.setWorkflowState(decoded)),
        ),
      )(input),
    );
  }

  /** The editor's Turn on; the rule is on {@link ShopWorkAgent}'s `applyAndTurnOn`. */
  @callable()
  applyAndTurnOn(
    input: typeof Domain.ApplyAndTurnOnInput.Encoded,
  ): Promise<Domain.SwitchResult> {
    return this.runEffect(
      callableEffect("ShopAgent.applyAndTurnOn", Domain.ApplyAndTurnOnInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.applyAndTurnOn(decoded)),
        ),
      )(input),
    );
  }

  /** Deletes a workflow; the rule is on {@link ShopWorkAgent}'s `removeWorkflow`. */
  @callable()
  removeWorkflow(
    input: typeof Domain.DeleteWorkflowInput.Encoded,
  ): Promise<Domain.DeleteWorkflowResult> {
    return this.runEffect(
      callableEffect("ShopAgent.removeWorkflow", Domain.DeleteWorkflowInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.removeWorkflow(decoded)),
        ),
      )(input),
    );
  }

  /**
   * The order page's read; the rule is on {@link ShopWorkAgent}'s
   * `getOrderDetail`. One method for the loader and the socket, as
   * {@link ShopAgent.listOrders} is for the index.
   */
  @callable()
  getOrderDetail(
    input: Domain.GetOrderDetailInput,
  ): Promise<Domain.OrderPageData | null> {
    return this.runEffect(
      callableEffect("ShopAgent.getOrderDetail", Domain.GetOrderDetailInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.getOrderDetail(decoded)),
        ),
      )(input),
    );
  }

  /**
   * **Every run-write callable is named `<role><Verb>`, where the role is the
   * `Domain.ConnectionRole` allowed to call it.** The merchant acts through
   * the embedded admin session; a member through a member connection with
   * its team ids. The two paths load different context, so they are separate
   * callables rather than one with a role switch. Reads are not run writes
   * and keep bare names (`liveRuns`, `liveRun`).
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
      )((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.merchantListRunsForOrder(decoded),
          ),
        ),
      )(input),
    );
  }

  /** Sets an item's workflow; the rule is on {@link ShopWorkAgent}'s `merchantAttachWorkflow`. */
  @callable()
  merchantAttachWorkflow(
    input: typeof Domain.AttachWorkflowInput.Encoded,
  ): Promise<Domain.AttachResult> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantAttachWorkflow",
        Domain.AttachWorkflowInput,
        {
          role: "merchant",
          parse: { onExcessProperty: "error" },
        },
      )((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.merchantAttachWorkflow(decoded),
          ),
        ),
      )(input),
    );
  }

  /** The merchant cancels a run; the rule is on {@link ShopWorkAgent}'s `merchantCancelRun`. */
  @callable()
  merchantCancelRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      callableEffect("ShopAgent.merchantCancelRun", Domain.RunIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.merchantCancelRun(decoded)),
        ),
      )(input),
    );
  }

  /**
   * The merchant marks a task done; the rule is on {@link ShopWorkAgent}'s
   * `merchantMarkTaskDone`. The merchant's task and block writes are separate
   * methods rather than a role branch inside the member ones because the
   * role gate is declared *per method* — `CALLABLE_ROLES` in
   * `test/integration/shop-agent-callables.test.ts` enumerates the decorated
   * surface and fails the build for any callable whose audience was not
   * decided — and a single method admitting both populations would have to
   * re-derive that decision at runtime from the connection.
   */
  @callable()
  merchantMarkTaskDone(
    input: typeof Domain.MarkTaskDoneInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantMarkTaskDone",
        Domain.MarkTaskDoneInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.merchantMarkTaskDone(decoded)),
        ),
      )(input),
    );
  }

  @callable()
  merchantReopenTask(
    input: typeof Domain.ReopenTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      callableEffect("ShopAgent.merchantReopenTask", Domain.ReopenTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.merchantReopenTask(decoded)),
        ),
      )(input),
    );
  }

  /** The merchant puts a task back; the rule is on {@link ShopWorkAgent}'s `merchantPutBackTask`. */
  @callable()
  merchantPutBackTask(
    input: typeof Domain.PutBackTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      callableEffect("ShopAgent.merchantPutBackTask", Domain.PutBackTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.merchantPutBackTask(decoded)),
        ),
      )(input),
    );
  }

  /** The merchant sets a run's note; the rule is on {@link ShopWorkAgent}'s `merchantSetRunNote`. */
  @callable()
  merchantSetRunNote(
    input: typeof Domain.SetRunNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      callableEffect("ShopAgent.merchantSetRunNote", Domain.SetRunNoteInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.merchantSetRunNote(decoded)),
        ),
      )(input),
    );
  }

  @callable()
  merchantBlockRun(
    input: typeof Domain.BlockRunInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      callableEffect("ShopAgent.merchantBlockRun", Domain.BlockRunInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.merchantBlockRun(decoded)),
        ),
      )(input),
    );
  }

  @callable()
  merchantUnblockRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      callableEffect("ShopAgent.merchantUnblockRun", Domain.RunIdInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.merchantUnblockRun(decoded)),
        ),
      )(input),
    );
  }

  /**
   * Member-area methods. Two idioms, split by whether the call has a socket:
   *
   * `listRuns` stays plain RPC, not `@callable()`. It is the workflows list's
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
  /** The member's workflows list loader read; the rule is on {@link ShopWorkAgent}'s `listRuns`. */
  listRuns(
    input: typeof Domain.ListRunsInput.Encoded,
  ): Promise<Domain.WorkflowsListData> {
    return this.runEffect(
      callableEffect("ShopAgent.listRuns", Domain.ListRunsInput, {
        role: "rpc",
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.listRuns(decoded)),
        ),
      )(input),
    );
  }

  /** The member's workflows list over the socket; the rule is on {@link ShopWorkAgent}'s `liveRuns`. */
  @callable()
  liveRuns(
    input: typeof Domain.LiveRunsInput.Encoded,
  ): Promise<Domain.WorkflowsListData> {
    return this.runEffect(
      memberCallableEffect("ShopAgent.liveRuns", Domain.LiveRunsInput, {
        onExcessProperty: "error",
      })((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.liveRuns(decoded, member)),
        ),
      )(input),
    );
  }

  @callable()
  memberStartTask(
    input: typeof Domain.StartTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      memberCallableEffect("ShopAgent.memberStartTask", Domain.StartTaskInput, {
        onExcessProperty: "error",
      })((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.memberStartTask(decoded, member),
          ),
        ),
      )(input),
    );
  }

  /** A member puts a task back; the rule is on {@link ShopWorkAgent}'s `memberPutBackTask`. */
  @callable()
  memberPutBackTask(
    input: typeof Domain.PutBackTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberPutBackTask",
        Domain.PutBackTaskInput,
        {
          onExcessProperty: "error",
        },
      )((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.memberPutBackTask(decoded, member),
          ),
        ),
      )(input),
    );
  }

  /** A member sets a run's note; the rule is on {@link ShopWorkAgent}'s `memberSetRunNote`. */
  @callable()
  memberSetRunNote(
    input: typeof Domain.SetRunNoteInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberSetRunNote",
        Domain.SetRunNoteInput,
        {
          onExcessProperty: "error",
        },
      )((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.memberSetRunNote(decoded, member),
          ),
        ),
      )(input),
    );
  }

  @callable()
  memberBlockRun(
    input: typeof Domain.BlockRunInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      memberCallableEffect("ShopAgent.memberBlockRun", Domain.BlockRunInput, {
        onExcessProperty: "error",
      })((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.memberBlockRun(decoded, member),
          ),
        ),
      )(input),
    );
  }

  @callable()
  memberMarkTaskDone(
    input: typeof Domain.MarkTaskDoneInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberMarkTaskDone",
        Domain.MarkTaskDoneInput,
        {
          onExcessProperty: "error",
        },
      )((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.memberMarkTaskDone(decoded, member),
          ),
        ),
      )(input),
    );
  }

  /** A member reopens a task; the rule is on {@link ShopWorkAgent}'s `memberReopenTask`. */
  @callable()
  memberReopenTask(
    input: typeof Domain.ReopenTaskInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      memberCallableEffect(
        "ShopAgent.memberReopenTask",
        Domain.ReopenTaskInput,
        { onExcessProperty: "error" },
      )((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.memberReopenTask(decoded, member),
          ),
        ),
      )(input),
    );
  }

  /** The member's workflow page loader read; the rule is on {@link ShopWorkAgent}'s `memberGetRun`. */
  memberGetRun(
    input: typeof Domain.GetRunForMemberInput.Encoded,
  ): Promise<Domain.RunPageData | null> {
    return this.runEffect(
      callableEffect("ShopAgent.memberGetRun", Domain.GetRunForMemberInput, {
        role: "rpc",
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.memberGetRun(decoded)),
        ),
      )(input),
    );
  }

  /** The member's workflow page over the socket; the rule is on {@link ShopWorkAgent}'s `liveRun`. */
  @callable()
  liveRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunPageData | null> {
    return this.runEffect(
      memberCallableEffect("ShopAgent.liveRun", Domain.RunIdInput, {
        onExcessProperty: "error",
      })((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.liveRun(decoded, member)),
        ),
      )(input),
    );
  }

  @callable()
  memberUnblockRun(
    input: typeof Domain.RunIdInput.Encoded,
  ): Promise<Domain.RunResult> {
    return this.runEffect(
      memberCallableEffect("ShopAgent.memberUnblockRun", Domain.RunIdInput, {
        onExcessProperty: "error",
      })((decoded, member) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.memberUnblockRun(decoded, member),
          ),
        ),
      )(input),
    );
  }

  @callable()
  addStep(
    input: typeof Domain.AddStepInput.Encoded,
  ): Promise<Domain.TaskResult> {
    return this.runEffect(
      callableEffect("ShopAgent.addStep", Domain.AddStepInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.addStep(decoded)),
        ),
      )(input),
    );
  }

  /** Adds a task to a step; the rule is on {@link ShopWorkAgent}'s `addTask`. */
  @callable()
  addTask(
    input: typeof Domain.AddTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    return this.runEffect(
      callableEffect("ShopAgent.addTask", Domain.AddTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.addTask(decoded)),
        ),
      )(input),
    );
  }

  @callable()
  updateTask(
    input: typeof Domain.UpdateTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    return this.runEffect(
      callableEffect("ShopAgent.updateTask", Domain.UpdateTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.updateTask(decoded)),
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
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.moveTask(decoded)),
        ),
      )(input),
    );
  }

  @callable()
  separateTask(
    input: typeof Domain.SeparateTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    return this.runEffect(
      callableEffect("ShopAgent.separateTask", Domain.SeparateTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.separateTask(decoded)),
        ),
      )(input),
    );
  }

  @callable()
  joinTask(
    input: typeof Domain.JoinTaskInput.Encoded,
  ): Promise<Domain.TaskResult> {
    return this.runEffect(
      callableEffect("ShopAgent.joinTask", Domain.JoinTaskInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.joinTask(decoded)),
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
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.removeTask(decoded)),
        ),
      )(input),
    );
  }

  /** Deletes a team; the rule is on {@link ShopWorkAgent}'s `deleteTeam`. */
  @callable()
  deleteTeam(
    input: typeof Domain.DeleteTeamInput.Encoded,
  ): Promise<Domain.DeleteTeamResult> {
    return this.runEffect(
      callableEffect("ShopAgent.deleteTeam", Domain.DeleteTeamInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.deleteTeam(decoded)),
        ),
      )(input),
    );
  }

  /** Points a run task at a team; the rule is on {@link ShopWorkAgent}'s `merchantAssignRunTaskTeam`. */
  @callable()
  merchantAssignRunTaskTeam(
    input: typeof Domain.AssignRunTaskTeamInput.Encoded,
  ): Promise<Domain.AssignRunTaskTeamResult> {
    return this.runEffect(
      callableEffect(
        "ShopAgent.merchantAssignRunTaskTeam",
        Domain.AssignRunTaskTeamInput,
        { role: "merchant", parse: { onExcessProperty: "error" } },
      )((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) =>
            shopWork.merchantAssignRunTaskTeam(decoded),
          ),
        ),
      )(input),
    );
  }

  /**
   * Development seed for workflows; the rule is on {@link ShopWorkAgent}'s
   * `seedWorkflows`. One callable rather than `createWorkflow` + an `addStep`
   * round trip per task, so the fixture arrives as a single declarative
   * payload.
   */
  @callable()
  seedWorkflows(
    input: typeof Domain.SeedWorkflowsInput.Encoded,
  ): Promise<readonly { readonly name: string; readonly id: string }[]> {
    return this.runEffect(
      callableEffect("ShopAgent.seedWorkflows", Domain.SeedWorkflowsInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.seedWorkflows(decoded)),
        ),
      )(input),
    );
  }

  /** Development seed for orders; the rule is on {@link ShopWorkAgent}'s `seedOrders`. */
  @callable()
  seedOrders(input: typeof Domain.SeedOrdersInput.Encoded): Promise<void> {
    return this.runEffect(
      callableEffect("ShopAgent.seedOrders", Domain.SeedOrdersInput, {
        role: "merchant",
        parse: { onExcessProperty: "error" },
      })((decoded) =>
        ShopWorkAgent.pipe(
          Effect.flatMap((shopWork) => shopWork.seedOrders(decoded)),
        ),
      )(input),
    );
  }
}

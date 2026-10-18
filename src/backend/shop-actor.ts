import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { Forbidden } from "../contract/auth.ts";
import { ShopKey } from "../contract/shop.ts";
import {
  OfflineSessionMissing,
  ShopifyUnavailable as ShopifyUnreachable,
} from "../contract/shopify.ts";
import { ShopLimits } from "../domain/platform.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_REVOKED,
  CONNECTION_CLOSE_UNINSTALLED,
  CONNECTION_HEADER,
  COUNT_KEY,
  ConnectionCaller,
  ConnectionMiddleware,
  Count,
  CurrentCaller,
  MAX_CONNECTIONS_PER_MEMBER,
  NoticeFrame,
  ORDERS_KEY,
  type OrdersListInput,
  type OrdersListPage,
  RequireMember,
  RequireMerchant,
  ShopActorRpcs,
  type ShopSnapshot,
  SYNC_KEY,
} from "../contract/shop-actor.ts";
import * as ActorSocket from "./actor-socket.ts";
import type { ActorFixtureAdded, ActorFixtureRows } from "./fixture.ts";
import { makeOrderRepository, type OrderRepositoryError } from "./shop-actor/order-repository.ts";
import { makeOrders } from "./shop-actor/orders.ts";
import { makeMembership } from "./shop-actor/membership.ts";
import { syncTransaction } from "./shop-actor/transaction.ts";
import { makeWorkflowRepository } from "./shop-actor/workflow-repository.ts";
import { makeWorkflows } from "./shop-actor/workflows.ts";
import { MembershipRepository } from "./membership-repository.ts";
import { OrdersSyncWorkflow } from "./orders-sync-workflow.ts";
import ShopActor, { ABORT_UNINSTALLED, type ShopActorShape } from "./shop-actor/tag.ts";
import { ShopSessionRepository } from "./shop-session-repository.ts";
import type { EnsureShopSessionError } from "./shopify.ts";
import { runOrdersStream } from "./shop-actor/orders-stream.ts";
import { ShopifyAdmin } from "./shopify-admin.ts";

const encodeNotice = Schema.encodeSync(NoticeFrame);
const decodeConnectionHeader = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCaller));
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({ shopActor: ActorSocket.SocketIdentity }),
);

/** A `SELECT count(*) AS n` result, as the number. */
const decodeCount = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ n: Schema.Number })]).pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform({ decode: ([{ n }]) => n, encode: (n) => [{ n }] as const }),
    ),
  ),
);

/** `Workflow` rows by name and tag, for a fixture's clash check. */
const decodeWorkflowNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String, tag: Schema.String })),
);
const decodeOrderIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String })),
);

/** The close reasons, Baton's. A reason must stay under 123 bytes. */
const REVOKED_REASON = "membership changed";
const DISPLACED_REASON = "signed in elsewhere";
const EXPIRED_REASON = "session expired";
const UNIDENTIFIED_REASON = "unidentified connection";
const UNINSTALLED_REASON = "uninstalled";

/**
 * How long `destroy` waits for the sockets it closed to finish their close handshake before it
 * aborts. An abort drops a socket whose close frame has not gone out, and the browser then sees
 * 1006, which it retries, instead of the terminal code.
 */
const CLOSE_HANDSHAKE_WAIT = "1 second";

/**
 * One shop's work: its synced orders, its workflows and the runs applied to order items. Identity
 * (shops, members, teams) lives in D1; this store points into it by id, never the reverse, and no
 * foreign key crosses the two.
 *
 * While prototyping `0001_init` is the only migration and is edited in place; a schema change is
 * applied by resetting (`vp run db:reset`, `vp run cloud:reset`), which deletes every actor's
 * storage, never by a second migration.
 *
 * One statement per `sql` call: the unit tests run these migrations under
 * `@effect/sql-sqlite-node`, which prepares each call as one statement and silently drops every
 * statement after the first, where the Durable Object's `sql.exec` runs a whole script.
 */
export const migrations = SqliteMigrator.fromRecord({
  "0001_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Times are epoch-ms integers.
    //
    // ShopOrder, not Order, which is an SQL keyword. Shopify's numeric ids are text: they
    // exceed the 52-bit integers SqlStorage.exec round-trips losslessly, and a truncated id
    // would silently mismatch the webhook payload it correlates with.
    yield* sql`
      create table if not exists ShopOrder (
        id text primary key,
        legacyId text not null,
        name text not null,
        processedAt integer not null,
        updatedAt integer not null,
        cancelledAt integer,
        fulfillmentStatus text not null,
        fullyPaid integer not null,
        -- Unbounded because Shopify bounds an order note at 5,000 characters.
        note text,
        syncedAt integer not null,
        -- Null until the first run is created for the order: the billing meter's per-order mark.
        countedAt integer
      )
    `;
    // The keyset the orders page pages on, id desc included because a shop can place several
    // orders in one millisecond. The retention sweep reads the same index as a range scan.
    yield* sql`
      create index if not exists ShopOrder_processedAt
        on ShopOrder (processedAt desc, id desc)
    `;
    yield* sql`
      create index if not exists ShopOrder_open_idx
        on ShopOrder (processedAt desc, id desc)
        where fulfillmentStatus <> 'FULFILLED' and cancelledAt is null
    `;
    yield* sql`
      create table if not exists OrderLineItem (
        id text primary key,
        orderId text not null references ShopOrder(id) on delete cascade,
        title text not null,
        variantTitle text,
        sku text,
        quantity integer not null,
        currentQuantity integer not null,
        productTags text not null,
        properties text not null
      )
    `;
    yield* sql`
      create index if not exists OrderLineItem_orderId on OrderLineItem (orderId)
    `;
    // The last sync's error, if any, and the open-orders sync in flight: workflowId and
    // startedAt are set together when one starts and cleared together when it ends. Seeded so
    // every read is a select and every write an update.
    yield* sql`
      create table if not exists SyncState (
        id integer primary key check (id = 1),
        lastError text,
        workflowId text,
        startedAt integer
      )
    `;
    yield* sql`
      insert or ignore into SyncState (id) values (1)
    `;
    // The usage counters of the current billing cycle, independent of the plan.
    yield* sql`
      create table if not exists ShopUsage (
        id integer primary key check (id = 1),
        shopGid text,
        cycleStartAt integer,
        cycleEndAt integer,
        ordersThisCycle integer not null default 0,
        ordersLimitedAt integer,
        lastSweepAt integer,
        seatsThisCycle integer not null default 0
      )
    `;
    yield* sql`
      insert or ignore into ShopUsage (id) values (1)
    `;
    // The outbox of usage events still to report to Shopify.
    yield* sql`
      create table if not exists UsageEvent (
        idempotencyKey text primary key,
        eventHandle text not null,
        orderId text,
        value integer not null,
        occurredAt integer not null,
        attempts integer not null default 0,
        lastError text
      )
    `;
    // A workflow is the definition a merchant configures. Its tasks are one JSON document, read
    // and written whole by every reader and editor and short by limit, so a row per task would
    // buy nothing but renumbering on every reorder; a task's position is its index. The draft
    // is a second document of the same shape: null until the first edit, null again after it
    // is applied or discarded. A task's teamId is a D1 Team.id: it is checked before a write,
    // and deleting the team clears it.
    yield* sql`
      create table if not exists Workflow (
        id text primary key,
        name text not null unique check (name = trim(name) and length(name) > 0),
        tag text not null unique check (tag = trim(tag) and length(tag) > 0),
        state text not null check (state in ('active', 'inactive')),
        updatedAt integer not null,
        tasks text not null default '[]',
        draftTasks text
      )
    `;
    // A run is one workflow applied to one order item, its tasks copied in. A run is for the
    // whole item (five chairs on one line are one run of quantity 5), so lineItemId is unique
    // over every state, not only open runs. Order, item and workflow facts are snapshots: no
    // foreign key, and they survive the rows they came from.
    yield* sql`
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
        -- Derived from the tasks and stored, for the lists that filter on it.
        state text not null check (state in ('open', 'done', 'closed')),
        -- The earliest task start, null until a task starts; derived and stored like state.
        startedAt integer,
        -- The one hold a person sets. blockedBy is who, as JSON (role and email, no id);
        -- blockReason is optional, so only blockedAt and blockedBy move together.
        blockedAt integer,
        blockReason text,
        blockedBy text,
        note text,
        createdAt integer not null,
        updatedAt integer not null,
        closedAt integer,
        closedReason text check (closedReason in ('fulfilled', 'order_cancelled', 'item_removed', 'merchant_cancelled')),
        -- SQLite checks each statement, not the transaction, so a close sets state, closedAt
        -- and closedReason and clears the block in one update.
        check ((state = 'closed') = (closedAt is not null)),
        check ((closedAt is null) = (closedReason is null)),
        check (blockedAt is null or state = 'open'),
        check ((blockedAt is null) = (blockedBy is null)),
        check (state <> 'done' or startedAt is not null)
      )
    `;
    // The orders index asks per order for runs in a state. With no sqlite_stat1 the planner
    // picked a single-column index on state and read every open run per open order; the
    // composite serves both terms, and its prefix every orderId-only probe.
    yield* sql`
      create index if not exists Run_orderId_state_idx on Run (orderId, state)
    `;
    yield* sql`
      create index if not exists Run_open_age_idx
        on Run (orderProcessedAt, lineItemId, id) where state = 'open'
    `;
    yield* sql`
      create index if not exists Run_closed_idx
        on Run (closedAt) where state = 'closed'
    `;
    // Who started or finished a task is a snapshot: a role, and an email for a member. A
    // merchant acts from the order page and has no Member row, so no email. Each time and its
    // role are set together, and done implies started. "is 'member'" rather than "=", so a
    // null role compares false and an email without a role is refused.
    yield* sql`
      create table if not exists RunTask (
        id text primary key,
        runId text not null references Run (id) on delete cascade,
        position integer not null check (position >= 1),
        step integer not null check (step >= 1),
        name text not null,
        -- A D1 Team.id, cleared when the team is deleted.
        teamId text,
        teamName text not null,
        instructions text,
        startedAt integer,
        startedByEmail text,
        doneAt integer,
        doneByEmail text,
        startedByRole text check (startedByRole in ('merchant', 'member')),
        doneByRole text check (doneByRole in ('merchant', 'member')),
        unique (runId, position),
        check ((startedAt is null) = (startedByRole is null)),
        check ((doneAt is null) = (doneByRole is null)),
        check ((startedByRole is 'member') = (startedByEmail is not null)),
        check ((doneByRole is 'member') = (doneByEmail is not null)),
        check (doneAt is null or startedAt is not null)
      )
    `;
    // A member's open tasks by team.
    yield* sql`
      create index if not exists RunTask_teamId_idx on RunTask (teamId, doneAt)
    `;
  }),
});

/**
 * Writes a fixture's rows, each its own insert: a statement binds at most 100 parameters. The
 * order rows carry `countedAt`, the one column the order repository never writes.
 */
export const insertFixtureRows = (sql: SqlClient.SqlClient, rows: ActorFixtureRows) =>
  Effect.gen(function* () {
    for (const w of rows.workflows)
      yield* sql`INSERT INTO Workflow (id, name, tag, state, updatedAt, tasks, draftTasks)
        VALUES (${w.id}, ${w.name}, ${w.tag}, ${w.state}, ${w.updatedAt}, ${w.tasks}, ${w.draftTasks})`;
    for (const o of rows.orders)
      yield* sql`INSERT INTO ShopOrder (id, legacyId, name, processedAt, updatedAt, cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt, countedAt)
        VALUES (${o.id}, ${o.legacyId}, ${o.name}, ${o.processedAt}, ${o.updatedAt}, ${o.cancelledAt}, ${o.fulfillmentStatus}, ${o.fullyPaid}, ${o.note}, ${o.syncedAt}, ${o.countedAt})`;
    for (const i of rows.lineItems)
      yield* sql`INSERT INTO OrderLineItem (id, orderId, title, variantTitle, sku, quantity, currentQuantity, productTags, properties)
        VALUES (${i.id}, ${i.orderId}, ${i.title}, ${i.variantTitle}, ${i.sku}, ${i.quantity}, ${i.currentQuantity}, ${i.productTags}, ${i.properties})`;
  });

/** Each role middleware admits exactly its role; see `MemberRpcs`. */
const requireRole = (role: ConnectionCaller["role"]) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller;
    return yield* Match.value(caller.role).pipe(
      Match.when(role, () => Effect.void),
      Match.orElse(() => Effect.fail(new Forbidden())),
    );
  });

const RequireMemberLive = Layer.succeed(RequireMember)(
  RequireMember.of((effect) => Effect.andThen(requireRole("member"), effect)),
);
const RequireMerchantLive = Layer.succeed(RequireMerchant)(
  RequireMerchant.of((effect) => Effect.andThen(requireRole("merchant"), effect)),
);

/**
 * Reads the socket's identity, which `ActorSocket` provides around every dispatch. A message
 * with none is a broken invariant, so it dies.
 */
const ConnectionMiddlewareLive = Layer.succeed(ConnectionMiddleware)(
  ConnectionMiddleware.of((effect) =>
    Effect.gen(function* () {
      const identity = yield* Effect.serviceOption(ActorSocket.ConnectionIdentity);
      if (Option.isNone(identity))
        return yield* Effect.die(new Error("a socket message without its identity"));
      return yield* Effect.provideService(effect, CurrentCaller, identity.value.caller);
    }),
  ),
);

/**
 * The tags a socket is accepted with: only what a fan-out selects sockets by, as Baton's
 * `getConnectionTags`. Cloudflare allows 10 tags of up to 256 characters per socket, and
 * Alchemy's transport adds one of its own.
 */
const tagsOf = (caller: ConnectionCaller) =>
  Match.value(caller).pipe(
    Match.discriminatorsExhaustive("role")({
      member: ({ memberId, sessionId }) => ["member", `member:${memberId}`, `session:${sessionId}`],
      merchant: () => ["merchant"],
    }),
  );

const makeShopActor = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const admin = yield* ShopifyAdmin;
  const shopSessions = yield* ShopSessionRepository;
  const membershipRepository = yield* MembershipRepository;
  const ordersSync = yield* OrdersSyncWorkflow;
  return Effect.gen(function* () {
    // Every actor is reached by name (`getByName`), so a nameless id is a broken invariant.
    const shop = yield* Effect.fromOption(decodeShopKey(state.id.name)).pipe(Effect.orDie);
    const runtime = yield* Effect.context<RuntimeContext>();
    const sql = yield* Layer.build(SqliteClient.layer({ storage: state.raw.storage })).pipe(
      Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
    );
    yield* SqliteMigrator.run({ loader: migrations }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.orDie,
    );
    const activationId = yield* Effect.sync(() => crypto.randomUUID());
    /**
     * The bulk file's client, over the object's own `fetch`. Provided here: a Durable Object's
     * activation may not require `HttpClient`, though Alchemy's Worker runtime has one.
     */
    const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));

    /** Every multi-statement write's transaction; see {@link syncTransaction}. */
    const transaction = syncTransaction(sql);
    const orderRepository = makeOrderRepository(sql, transaction);
    const workflowRepository = makeWorkflowRepository(sql, transaction);
    /**
     * Legacy's `reconcileAllNow`, the seam the workflow and team writes call where legacy
     * reconciles every stored order: runs do not exist yet, so there is nothing to reconcile.
     */
    const reconcileAll = (): Effect.Effect<void> => Effect.void;

    /**
     * The count the shop page shows, in memory: an example of the socket's reads, writes and
     * notices, not shop data. It starts at 0 on every activation, so a hibernation resets it.
     */
    const count = yield* Ref.make(0);
    const readCount = Ref.get(count).pipe(Effect.map((value): Count => ({ value })));
    const increment = Ref.updateAndGet(count, (value) => value + 1).pipe(
      Effect.map((value): Count => ({ value })),
    );
    const resetCount = Ref.setAndGet(count, 0).pipe(Effect.map((value): Count => ({ value })));

    const notify = Effect.fn("ShopActor.notify")(function* (invalidated: ReadonlyArray<string>) {
      const frame = encodeNotice({ _tag: "ShopActorNotice", invalidated });
      for (const socket of yield* state.getWebSockets())
        // A socket mid-close throws on send, which `send` surfaces as a defect; the next
        // notice or the client's reconnect covers that browser.
        yield* socket.send(frame).pipe(Effect.catchDefect(() => Effect.void));
    });

    const orders = makeOrders({
      repository: orderRepository,
      transaction,
      admin,
      ordersSync,
      notify,
      shop,
    });

    const membership = makeMembership({
      membershipRepository,
      workflowRepository,
      reconcileAll,
      notify,
      revoke: (memberIds) =>
        Effect.forEach(memberIds, (memberId) => closeTagged(`member:${memberId}`)).pipe(
          Effect.map((closed) => closed.reduce((sum, n) => sum + n, 0)),
          Effect.provide(runtime),
        ),
      shop,
    });

    const workflows = makeWorkflows({
      repository: workflowRepository,
      membershipRepository,
      reconcileAll,
      notify,
      shop,
    });

    /**
     * Sync open orders, `MerchantSyncOpenOrders`: the shop's `ShopSession` read first, so a
     * row deleted while the socket stayed open is {@link OfflineSessionMissing} with nothing
     * recorded and no instance created, then `Orders.syncOpenOrders`.
     */
    const syncOpenOrdersFor = (operation: string) =>
      Effect.gen(function* () {
        if (Option.isNone(yield* shopSessions.find(shop)))
          return yield* new OfflineSessionMissing({ shop });
        return yield* orders.syncOpenOrders();
      }).pipe(Effect.catch(syncFailure(operation)));

    /**
     * A sync press's failure as its caller is told it (`OrdersSyncFailure`): a session
     * failure crosses as it is, except `ShopifyUnavailable`, whose cause is logged here and never
     * sent. A storage failure is a defect.
     */
    const syncFailure =
      (operation: string) =>
      (error: EnsureShopSessionError | SqlError.SqlError | OrderRepositoryError) =>
        Match.value(error).pipe(
          Match.tags({
            OfflineSessionMissing: (failure) => Effect.fail(failure),
            ReauthorizationRequired: (failure) => Effect.fail(failure),
            ShopifyUnavailable: ({ cause }) =>
              Effect.logWarning(`${operation}: shop=${shop}: Shopify unavailable`, cause).pipe(
                Effect.annotateLogs({ shop }),
                Effect.andThen(Effect.fail(new ShopifyUnreachable({ shop }))),
              ),
          }),
          Match.orElse((defect) => Effect.die(defect)),
        );

    /** Closes a socket; a close that throws is logged and never fails the caller. */
    const closeSocket = (socket: Cloudflare.Workers.WebSocket, code: number, reason: string) =>
      socket
        .close(code, reason)
        .pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning(`ShopActor: close ${code} failed`, defect),
          ),
        );

    /**
     * Baton's `displaceConnections`: after a member's socket is accepted, keeps the member at
     * {@link MAX_CONNECTIONS_PER_MEMBER} by closing the oldest of the others, by
     * `connectedAt`. Best effort: a failure is logged and the new socket is served either way.
     */
    const displace = Effect.fn("ShopActor.displace")(
      function* (memberId: string, newest: Cloudflare.Workers.WebSocket) {
        const others = (yield* state.getWebSockets(`member:${memberId}`)).flatMap((socket) => {
          if (socket.ws === newest.ws || socket.ws.readyState !== WebSocket.OPEN) return [];
          const identity = decodeIdentity(socket.deserializeAttachment<unknown>());
          return Option.isSome(identity)
            ? [{ socket, connectedAt: identity.value.shopActor.connectedAt }]
            : [];
        });
        const displaced = others
          .toSorted((a, b) => b.connectedAt - a.connectedAt)
          .slice(MAX_CONNECTIONS_PER_MEMBER - 1);
        for (const { socket } of displaced) {
          yield* closeSocket(socket, CONNECTION_CLOSE_DISPLACED, DISPLACED_REASON);
          yield* Effect.logInfo(`ShopActor.displace: shop=${shop} memberId=${memberId}`);
        }
      },
      Effect.catchCause((cause) => Effect.logWarning("ShopActor.displace failed", cause)),
    );

    const handlers = ShopActorRpcs.toLayer({
      MemberGetCount: () => readCount,
      MerchantGetCount: () => readCount,
      MemberIncrement: () => increment.pipe(Effect.tap(() => notify([COUNT_KEY]))),
      MerchantResetCount: () => resetCount.pipe(Effect.tap(() => notify([COUNT_KEY]))),
      MemberActivation: () => Effect.succeed({ id: activationId }),
      MemberWhoAmI: () => Effect.service(CurrentCaller),
      MerchantWhoAmI: () => Effect.service(CurrentCaller),
      MerchantListOrders: (input) => orderRepository.listOrders(input).pipe(Effect.orDie),
      MerchantSyncStatus: () =>
        Clock.currentTimeMillis.pipe(Effect.flatMap(orderRepository.getSyncStatus), Effect.orDie),
      MerchantSyncOpenOrders: () => syncOpenOrdersFor("ShopActor.MerchantSyncOpenOrders"),
      MerchantSyncOrder: (input) =>
        orders.syncOrder(input).pipe(Effect.catch(syncFailure("ShopActor.MerchantSyncOrder"))),
      MerchantAddMember: membership.addMember,
      MerchantDeleteMember: membership.deleteMember,
      MerchantAddMemberTeams: membership.addMemberTeams,
      MerchantSetTeamMember: membership.setTeamMember,
      MerchantCreateTeam: membership.createTeam,
      MerchantRenameTeam: membership.renameTeam,
      MerchantAddTeamMembers: membership.addTeamMembers,
      MerchantDeleteTeam: membership.deleteTeam,
      MerchantCreateWorkflow: workflows.createWorkflow,
      MerchantDuplicateWorkflow: workflows.duplicateWorkflow,
      MerchantUpdateWorkflow: workflows.updateWorkflow,
      MerchantUpdateWorkflowTag: workflows.updateWorkflowTag,
      MerchantApplyDraft: workflows.applyDraft,
      MerchantDiscardDraft: workflows.discardDraft,
      MerchantSetWorkflowState: workflows.setWorkflowState,
      MerchantApplyAndTurnOn: workflows.applyAndTurnOn,
      MerchantDeleteWorkflow: workflows.deleteWorkflow,
      MerchantAddStep: workflows.addStep,
      MerchantAddTask: workflows.addTask,
      MerchantUpdateTask: workflows.updateTask,
      MerchantMoveTask: workflows.moveTask,
      MerchantSeparateTask: workflows.separateTask,
      MerchantJoinTask: workflows.joinTask,
      MerchantRemoveTask: workflows.removeTask,
    });

    const socket = yield* ActorSocket.make({
      group: ShopActorRpcs,
      handlers: Layer.mergeAll(
        handlers,
        ConnectionMiddlewareLive,
        RequireMemberLive,
        RequireMerchantLive,
      ),
      onAccept: ({ caller }) => ({ tags: tagsOf(caller) }),
      beforeDispatch: ({ caller }, ws) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (caller.role !== "member" || caller.sessionExpiresAt > now) return true;
          yield* closeSocket(ws, CONNECTION_CLOSE_REVOKED, EXPIRED_REASON);
          return false;
        }),
    });

    /**
     * Accepts a socket and closes it at once with a code the browser reads; how the actor
     * refuses an upgrade whose identity it cannot read.
     */
    const refuse = (code: number, reason: string) =>
      Effect.sync(() => {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(code, reason);
        return HttpServerResponse.setBody(
          HttpServerResponse.empty({ status: 101 }),
          HttpBody.raw(new Response(null, { status: 101, webSocket: pair[0] })),
        );
      });

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.upgrade?.toLowerCase() !== "websocket")
        return HttpServerResponse.empty({ status: 426, headers: { upgrade: "websocket" } });
      const caller = decodeConnectionHeader(request.headers[CONNECTION_HEADER]);
      if (Option.isNone(caller)) {
        yield* Effect.logWarning(`ShopActor.fetch: shop=${shop} unidentified connection`);
        return yield* refuse(CONNECTION_CLOSE_FORBIDDEN, UNIDENTIFIED_REASON);
      }
      const connectedAt = yield* Clock.currentTimeMillis;
      const accepted = yield* socket.fetch({ caller: caller.value, connectedAt });
      if (Option.isSome(accepted.socket)) {
        const role = caller.value.role;
        yield* Effect.logInfo(`ShopActor.fetch: shop=${shop} role=${role}: socket accepted`).pipe(
          Effect.annotateLogs({ shop, role }),
        );
      }
      if (caller.value.role === "member" && Option.isSome(accepted.socket))
        yield* displace(caller.value.memberId, accepted.socket.value);
      return accepted.response;
    });

    /**
     * Closes every open socket tagged `tag` (`member:<id>` or `session:<id>`) with
     * {@link CONNECTION_CLOSE_REVOKED} and answers how many it closed: the one close routine of
     * the stub's {@link revoke} and the member and team writes ({@link membership}).
     */
    const closeTagged = Effect.fn("ShopActor.closeTagged")(function* (tag: string) {
      let closed = 0;
      for (const ws of yield* state.getWebSockets(tag)) {
        if (ws.ws.readyState !== WebSocket.OPEN) continue;
        yield* closeSocket(ws, CONNECTION_CLOSE_REVOKED, REVOKED_REASON);
        closed += 1;
      }
      return closed;
    });

    /**
     * Closes every socket of one member (`by: "member"`, Baton's `revokeMemberConnections`) or
     * of one Better Auth session (`by: "session"`) with {@link CONNECTION_CLOSE_REVOKED}.
     */
    const revoke = Effect.fn("ShopActor.revoke")(function* (input: {
      readonly by: "member" | "session";
      readonly id: string;
    }) {
      const closed = yield* closeTagged(`${input.by}:${input.id}`);
      yield* Effect.logInfo(`ShopActor.revoke: shop=${shop} by=${input.by} closed=${closed}`);
      return { closed };
    }, Effect.provide(runtime));

    /** The page's first data, for the Backend's server-rendering read. */
    const snapshot = Effect.fn("ShopActor.snapshot")(function* () {
      const result: ShopSnapshot = {
        count: yield* readCount,
        activation: { id: activationId },
      };
      return result;
    });

    /** The shop's work rows, read back. */
    const countWork = Effect.gen(function* () {
      return {
        workflows: yield* decodeCount(yield* sql`SELECT count(*) AS n FROM Workflow`),
        orders: yield* decodeCount(yield* sql`SELECT count(*) AS n FROM ShopOrder`),
        lineItems: yield* decodeCount(yield* sql`SELECT count(*) AS n FROM OrderLineItem`),
      };
    });

    /**
     * Replaces the shop's work with a fixture's rows, in one {@link transaction}: every order,
     * line item, workflow, run, run task and usage event goes, `SyncState` and `ShopUsage` go
     * back to the single rows the migration inserts, and `rows` are written. Not
     * `storage.deleteAll`, which would also drop the migrator's record of the schema. Answers
     * the counts read back inside the transaction.
     */
    const loadFixture = Effect.fn("ShopActor.loadFixture")(
      function* (rows: ActorFixtureRows) {
        const counts = yield* transaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM RunTask`;
            yield* sql`DELETE FROM Run`;
            yield* sql`DELETE FROM OrderLineItem`;
            yield* sql`DELETE FROM ShopOrder`;
            yield* sql`DELETE FROM Workflow`;
            yield* sql`DELETE FROM UsageEvent`;
            yield* sql`DELETE FROM SyncState`;
            yield* sql`INSERT INTO SyncState (id) VALUES (1)`;
            yield* sql`DELETE FROM ShopUsage`;
            yield* sql`INSERT INTO ShopUsage (id) VALUES (1)`;
            yield* insertFixtureRows(sql, rows);
            return yield* countWork;
          }),
        );
        yield* Effect.logInfo(
          `ShopActor.loadFixture: shop=${shop} workflows=${counts.workflows} orders=${counts.orders} lineItems=${counts.lineItems}`,
        );
        return counts;
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /**
     * Adds a fixture's rows beside the shop's work, in one {@link transaction}, deleting
     * nothing. It first reads for a workflow whose name or tag, or an order whose id, is
     * already there, and answers the first clash as `Conflict` with nothing written; otherwise
     * `Added`, with the counts read back inside the transaction. An answer rather than a
     * failure, because the stub's methods are schemaless.
     */
    const addFixture = Effect.fn("ShopActor.addFixture")(
      function* (rows: ActorFixtureRows) {
        const added = yield* transaction(
          Effect.gen(function* () {
            for (const w of rows.workflows) {
              const [clash] = yield* decodeWorkflowNames(
                yield* sql`SELECT name, tag FROM Workflow WHERE name = ${w.name} OR tag = ${w.tag} LIMIT 1`,
              );
              if (clash !== undefined)
                return {
                  _tag: "Conflict" as const,
                  reason:
                    clash.name === w.name
                      ? `workflow ${w.name} already exists`
                      : `workflow tag ${w.tag} already exists`,
                };
            }
            for (const o of rows.orders) {
              const [clash] = yield* decodeOrderIds(
                yield* sql`SELECT id FROM ShopOrder WHERE id = ${o.id}`,
              );
              if (clash !== undefined)
                return { _tag: "Conflict" as const, reason: `order ${o.name} already exists` };
            }
            yield* insertFixtureRows(sql, rows);
            return { _tag: "Added" as const, counts: yield* countWork };
          }),
        );
        const answer: ActorFixtureAdded = added;
        yield* Effect.logInfo(
          Match.value(answer).pipe(
            Match.tagsExhaustive({
              Added: ({ counts }) =>
                `ShopActor.addFixture: shop=${shop} workflows=${counts.workflows} orders=${counts.orders} lineItems=${counts.lineItems}`,
              Conflict: ({ reason }) => `ShopActor.addFixture: shop=${shop} conflict: ${reason}`,
            }),
          ),
        );
        return answer;
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /**
     * Deletes one stored order with its items and runs, the way the retention sweep does, and
     * notifies {@link ORDERS_KEY} when there was one. Dev and test machinery only: it lets a
     * test take a real order off the screen so that only a sync can bring it back.
     */
    const removeOrder = Effect.fn("ShopActor.removeOrder")(
      function* ({ orderId }: { readonly orderId: string }) {
        const deleted = yield* transaction(
          Effect.gen(function* () {
            yield* sql`delete from Run where orderId = ${orderId}`;
            return yield* sql`delete from ShopOrder where id = ${orderId} returning id`;
          }),
        );
        const removed = deleted.length > 0;
        yield* Effect.logInfo(
          `ShopActor.removeOrder: shop=${shop} orderId=${orderId} removed=${String(removed)}`,
        ).pipe(Effect.annotateLogs({ shop, orderId, removed }));
        if (removed) yield* notify([ORDERS_KEY]);
        return { removed };
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /**
     * Legacy's `ShopAgent.syncOrderWebhook`, the Backend's one call for an `orders/*` delivery
     * whose shop it found installed: `Orders.syncOrderWebhook`. Any failure dies, which the
     * Backend answers non-2xx, so Shopify retries.
     */
    const syncOrderWebhook = Effect.fn("ShopActor.syncOrderWebhook")(
      function* (input: {
        readonly orderId: string;
        readonly topic: string;
        readonly updatedAt: number | null;
      }) {
        return yield* orders.syncOrderWebhook(input);
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /** One stored order with its items, or null. */
    const getOrder = Effect.fn("ShopActor.getOrder")(
      function* ({ orderId }: { readonly orderId: string }) {
        return Option.getOrNull(yield* orderRepository.getOrder(orderId));
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /** One page of the orders list; the same read as `MerchantListOrders`. */
    const listOrders = Effect.fn("ShopActor.listOrders")(
      function* (input: OrdersListInput) {
        const page: OrdersListPage = yield* orderRepository.listOrders(input);
        return page;
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /**
     * Legacy's `onOrdersStream`: the Workflow's last step for a completed export, never a
     * browser's (rule 16 on `syncOrder`: the URL must only ever come from a bulk operation this
     * shop started). The stream merges ({@link runOrdersStream}), then the retention pass rides
     * it (rule 9), then the tracking record is cleared and both keys are notified, whatever the
     * stream changed: the sync's end is on the screen either way. Answers the counts, which
     * are logged and never shown (rule 18).
     *
     * The retention pass rides the open-orders sync: it is merchant-triggered,
     * already the heaviest thing this object does, and the one moment
     * where paying for a batch of deletes is invisible next to what the
     * request is doing anyway.
     *
     * A step retry re-streams the whole file when the sweep throws after the writes: correct
     * under rule 7, a full second pass, and rare. The billing seam: the usage flush after the
     * stream goes here.
     */
    const onOrdersStream = Effect.fn("ShopActor.onOrdersStream")(
      function* ({ workflowId, url }: { readonly workflowId: string; readonly url: string }) {
        const counts = yield* runOrdersStream({ repository: orderRepository, shop, url }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          // A stream that fails partway keeps the orders it wrote, and the failure carries no
          // counts, so the list is invalidated without knowing whether a row moved.
          Effect.onError(() => notify([ORDERS_KEY])),
        );
        if (counts.ordersRefused > 0)
          yield* Effect.logError(
            `ShopActor.onOrdersStream: shop=${shop} status=order-ceiling ordersRefused=${String(counts.ordersRefused)} limit=${String(ShopLimits.maxOpenOrders)}`,
          ).pipe(
            Effect.annotateLogs({
              shop,
              status: "order-ceiling",
              ordersRefused: counts.ordersRefused,
              limit: ShopLimits.maxOpenOrders,
            }),
          );
        const swept = yield* orderRepository.sweepExpiredOrders({
          now: yield* Clock.currentTimeMillis,
        });
        yield* orderRepository.clearSyncTracking({ workflowId });
        yield* Effect.logInfo(
          `ShopActor.onOrdersStream: shop=${shop} ordersSeen=${String(counts.ordersSeen)} ordersUpserted=${String(counts.ordersUpserted)} ordersInserted=${String(counts.ordersInserted)} ordersRefused=${String(counts.ordersRefused)} lineItemsUpserted=${String(counts.lineItemsUpserted)} ordersTruncated=${String(counts.ordersTruncated)} sweptOrders=${String(swept.orders)} sweptRuns=${String(swept.runs)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            workflowId,
            ...counts,
            sweptOrders: swept.orders,
            sweptRuns: swept.runs,
          }),
        );
        yield* notify([ORDERS_KEY, SYNC_KEY]);
        return counts;
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /**
     * Legacy's `onOrdersSyncEmpty`: the last 30 days held no open orders. Deliberately does not
     * touch stored rows: unlike a catalog scan, an empty result means "nothing changed", never
     * "the shop has no orders" (rule 9 on `syncOrder`). Clears the tracking record.
     */
    const onOrdersSyncEmpty = Effect.fn("ShopActor.onOrdersSyncEmpty")(
      function* ({ workflowId }: { readonly workflowId: string }) {
        yield* Effect.logInfo(
          `ShopActor.onOrdersSyncEmpty: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        if (yield* orderRepository.clearSyncTracking({ workflowId })) yield* notify([SYNC_KEY]);
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /**
     * A sync that will not finish: the Workflow's error sink. Legacy's `onOrdersSyncError` and
     * `onWorkflowError` in one, since no
     * platform callback follows here: the record is cleared, which re-enables the button, and
     * `message` becomes the banner unless one is already written (rule 15 on `syncOrder`).
     * Both only when the record is `workflowId`'s: a sync whose stale record a newer press
     * replaced has nothing left to report, and the newer sync owns the banner.
     */
    const onOrdersSyncError = Effect.fn("ShopActor.onOrdersSyncError")(
      function* ({
        workflowId,
        message,
      }: {
        readonly workflowId: string;
        readonly message: string;
      }) {
        const cleared = yield* transaction(
          Effect.gen(function* () {
            const cleared = yield* orderRepository.clearSyncTracking({ workflowId });
            if (cleared) yield* orderRepository.setSyncErrorIfEmpty({ error: message });
            return cleared;
          }),
        );
        yield* Effect.logError(
          `ShopActor.onOrdersSyncError: shop=${shop} workflowId=${workflowId} tracked=${String(cleared)}: ${message}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, tracked: cleared, message }));
        if (cleared) yield* notify([SYNC_KEY]);
      },
      Effect.orDie,
      Effect.provide(runtime),
    );

    /**
     * Tears the shop's actor down on uninstall: closes every socket with
     * {@link CONNECTION_CLOSE_UNINSTALLED} (best effort, as every close here), deletes the alarm
     * and then all storage, which is what ends the object's storage billing, syncs storage to
     * disk, waits up to {@link CLOSE_HANDSHAKE_WAIT} for the closes to complete, and aborts the
     * object with {@link ABORT_UNINSTALLED}.
     *
     * SQLite-backed storage coalesces writes: `deleteAll` resolving does not mean the delete
     * reached disk, and a reset discards writes that are still coalescing. So a method that
     * deletes storage syncs before it aborts; without the sync, production kept the shop's
     * orders across an uninstall. Local workerd writes synchronously and never shows this. The abort matters: the actor migrates once per activation, so
     * without it this activation would keep serving with its tables gone. The abort lands
     * mid-call, so the stub call rejects instead of answering; `ShopActors.destroy` reads that
     * rejection as success.
     *
     * @see refs/cloudflare-docs/src/content/partials/durable-objects/api-storage-other-methods.mdx ("deleteAll", "sync")
     */
    const destroy = Effect.fn("ShopActor.destroy")(function* () {
      const sockets = yield* state.getWebSockets();
      for (const ws of sockets)
        yield* closeSocket(ws, CONNECTION_CLOSE_UNINSTALLED, UNINSTALLED_REASON);
      yield* state.storage.deleteAlarm();
      yield* state.storage.deleteAll();
      yield* Effect.promise(() => state.raw.storage.sync());
      const closed = yield* Effect.sync(() =>
        sockets.every((ws) => ws.ws.readyState === WebSocket.CLOSED),
      ).pipe(
        Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (done) => done }),
        Effect.timeoutOption(CLOSE_HANDSHAKE_WAIT),
      );
      yield* Effect.logInfo(
        `ShopActor.destroy: shop=${shop} sockets=${String(sockets.length)} closed=${String(Option.isSome(closed))}: storage deleted`,
      ).pipe(Effect.annotateLogs({ shop, sockets: sockets.length, closed: Option.isSome(closed) }));
      yield* state.abort(ABORT_UNINSTALLED);
    }, Effect.provide(runtime));

    /**
     * Logs the close at Info with the caller's role and the close code and reason, then hands
     * the socket to the transport. A socket without an identity logs `role=none`.
     */
    const webSocketClose = (ws: Cloudflare.Workers.WebSocket, code: number, reason: string) =>
      Effect.gen(function* () {
        const role = Option.match(decodeIdentity(ws.deserializeAttachment<unknown>()), {
          onNone: () => "none",
          onSome: ({ shopActor }) => shopActor.caller.role,
        });
        yield* Effect.logInfo(
          `ShopActor.webSocketClose: shop=${shop} role=${role} code=${String(code)}: ${reason}`,
        ).pipe(Effect.annotateLogs({ shop, role, code, reason }));
        yield* socket.webSocketClose(ws);
      });

    const stub: ShopActorShape = {
      revoke,
      snapshot,
      loadFixture,
      addFixture,
      removeOrder,
      syncOrderWebhook,
      getOrder,
      listOrders,
      onOrdersStream,
      onOrdersSyncEmpty,
      onOrdersSyncError,
      destroy,
    };
    return {
      fetch,
      webSocketMessage: socket.webSocketMessage,
      webSocketClose,
      webSocketError: socket.webSocketError,
      ...stub,
    };
  });
});

/**
 * {@link ShopActor}'s implementation as a layer: provided in the Backend's init above the
 * services it yields, so every activation uses the Backend's own `ShopifyAdmin` (and the D1 and
 * secret behind it) rather than a second build. Its store is {@link migrations}.
 *
 * Who is on a socket is fixed when the socket is accepted: the Backend's gate resolves the
 * browser and names it in {@link CONNECTION_HEADER} on the upgrade it forwards, and the actor
 * writes that caller into the socket's attachment and tags. Every message is served as that
 * caller ({@link ConnectionMiddleware}); a header that does not decode is accepted and closed
 * with {@link CONNECTION_CLOSE_FORBIDDEN}.
 *
 * Revocation closes sockets with {@link CONNECTION_CLOSE_REVOKED}; a member's newest socket
 * past {@link MAX_CONNECTIONS_PER_MEMBER} displaces the oldest with
 * {@link CONNECTION_CLOSE_DISPLACED}. A member socket whose Better Auth session has expired is
 * closed on its next message, before it is dispatched: the backstop for a revoke that never
 * arrived. A merchant socket has no such backstop: its token is checked at connect only, as in
 * Baton.
 *
 * The outer phase takes handles only: it runs at plan time against a mock state inside the
 * Backend's init, which is what attaches every binding it yields to the Backend's script, and
 * once per activation at runtime, where the services are the Backend's own instances, captured
 * where this layer is provided. Yielding {@link OrdersSyncWorkflow} gives Alchemy's typed handle;
 * it runs the Workflow's outer phase each time, which binds the actor by identity only, so the
 * cycle closes. The inner phase runs once per activation too, including after a hibernation
 * wake, so the SQL client is rebuilt and the migrator re-checks its table each time. Migrations
 * run inside the `blockConcurrencyWhile` Alchemy wraps construction in, so no request sees a
 * half-migrated store. The client is built on the ambient scope, as Alchemy's
 * `Drizzle.DurableObject` does: it wraps the object's local storage, so nothing behind it needs
 * releasing. A single-statement write needs no transaction; a multi-statement one goes through
 * `transaction` ({@link syncTransaction}), and the orders repository is built over both.
 */
export const ShopActorLive = ShopActor.make(makeShopActor);

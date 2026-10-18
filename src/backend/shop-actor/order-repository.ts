/**
 * The shop actor's orders over its SQLite: the subset of `OrderRepository` the order sync needs.
 * Legacy's SQL, verbatim; runs, the counts strip, filters, search and billing are not here.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type { OrdersListInput, OrdersListPage } from "../../contract/shop-actor.ts";
import {
  type OrderDetail,
  OrderLineItem,
  type OrdersSyncStatus,
  ShopOrder,
  SyncState,
  syncOrder,
} from "../../domain/orders.ts";
import { retentionCutoff, ShopLimits } from "../../domain/platform.ts";
import { SYNC_STALE_MS } from "../orders-sync-constants.ts";
import type { Transaction } from "./transaction.ts";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
export class OrderRepositoryError extends Schema.TaggedError<OrderRepositoryError>()(
  "OrderRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface OrderUpsert<A = void, E = never> {
  readonly order: ShopOrder;
  readonly lineItems: readonly OrderLineItem[];
  /**
   * Runs inside the upsert's transaction, after the items are written and
   * only when the write actually happened. The seam for reconcile: runs must
   * be created and adjusted against exactly the item set this write produced,
   * and Durable Object SQLite refuses nested transactions, so the caller
   * composes plain statements here rather than opening its own. Must not await
   * anything but storage. Its value comes back as `upsertOrder`'s
   * `afterWrite`, so the caller can act on what the reconcile found once the
   * transaction has committed. Nothing passes one yet: reconcile arrives with
   * runs.
   */
  readonly afterWrite?: Effect.Effect<A, E>;
}

/**
 * Whether `openOrders` stored open orders leave no room for a new one: at
 * {@link ShopLimits.maxOpenOrders}, on any plan. Billing's rule, here until
 * the billing context lands.
 *
 * **An order refused here is lost to Baton until the count drops and the
 * merchant syncs.** The webhook path answers Shopify 2xx without storing it,
 * because a 5xx would only have Shopify retry for four hours against a
 * condition that only the merchant's own fulfilments clear; Shopify does not
 * redeliver afterwards, and nothing re-reads the gap. What recovers it is the
 * merchant: once orders are fulfilled or cancelled in Shopify, Sync open
 * orders re-fetches whatever is still open and inside its 30-day window.
 * `ShopUsage.ordersLimitedAt` is what raises the banner saying so, and that
 * start is what clears it (`clearOrdersLimited`).
 */
export const openOrdersAtCeiling = (openOrders: number) => openOrders >= ShopLimits.maxOpenOrders;

const encodeCursor = ({ processedAt, id }: ShopOrder) => `${String(processedAt)}:${id}`;

const decodeCursor = (cursor: string) => {
  const separator = cursor.indexOf(":");
  const processedAt = Number(cursor.slice(0, separator));
  return separator < 1 || !Number.isFinite(processedAt)
    ? Option.none()
    : Option.some({ processedAt, id: cursor.slice(separator + 1) });
};

const json = (value: unknown) => JSON.stringify(value);

/**
 * The open-order predicate, character for character what the partial
 * `ShopOrder_open_idx` is declared over: SQLite only uses a partial index when
 * the query's `where` provably implies the index's, and it proves that by
 * matching terms, not by reasoning about them.
 */
const OPEN = "fulfillmentStatus <> 'FULFILLED' and cancelledAt is null";

const bit = (value: boolean) => (value ? 1 : 0);

/**
 * The open-orders sync in flight, as `SyncState` records it: `workflowId` names the Workflow
 * instance and `startedAt` when the start was recorded. Both null when none is.
 */
export const SyncTracking = Schema.Struct({
  workflowId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
});
export type SyncTracking = typeof SyncTracking.Type;

/**
 * Whether a tracking record still means a sync is running at `now`: one younger than
 * {@link SYNC_STALE_MS}, which is the rule. An older one is dead.
 */
export const isTrackingFresh = ({ startedAt }: SyncTracking, now: number) =>
  startedAt !== null && now - startedAt < SYNC_STALE_MS;

/**
 * The repository over the actor's `sql`, built once per activation. Every method that runs more
 * than one statement runs it under `transaction`.
 */
export const makeOrderRepository = (sql: SqlClient.SqlClient, transaction: Transaction) => {
  const decode =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, message: string) =>
    (rows: unknown) =>
      Schema.decodeUnknownEffect(schema)(rows).pipe(
        Effect.mapError((cause) => new OrderRepositoryError({ message, cause })),
      );

  const orderColumns = sql.literal(
    `id, legacyId, name, processedAt, updatedAt, cancelledAt,
     fulfillmentStatus, fullyPaid, note, syncedAt`,
  );

  const decodeOrders = decode(Schema.Array(ShopOrder), "Invalid ShopOrder row");
  const decodeLineItems = decode(Schema.Array(OrderLineItem), "Invalid OrderLineItem row");
  const decodeSyncState = decode(Schema.Array(SyncState), "Invalid SyncState row");
  const decodeSyncTracking = decode(Schema.Array(SyncTracking), "Invalid SyncState row");

  /** One order's items, in id order. */
  const lineItemsOf = (orderId: string) =>
    Effect.gen(function* () {
      return yield* decodeLineItems(
        yield* sql`select * from OrderLineItem where orderId = ${orderId} order by id`,
      );
    });

  const syncState = Effect.fn("OrderRepository.syncState")(function* (rows: unknown) {
    const [state] = yield* decodeSyncState(rows);
    if (state === undefined)
      return yield* Effect.fail(
        new OrderRepositoryError({ message: "SyncState row is missing", cause: rows }),
      );
    return state;
  });

  const insertLineItems = (lineItems: readonly OrderLineItem[]) =>
    Effect.forEach(
      lineItems,
      (item) => sql`
        insert into OrderLineItem (
          id, orderId, title, variantTitle, sku,
          quantity, currentQuantity, productTags, properties
        ) values (
          ${item.id}, ${item.orderId},
          ${item.title}, ${item.variantTitle}, ${item.sku},
          ${item.quantity}, ${item.currentQuantity},
          ${json(item.productTags)}, ${json(item.properties)}
        )
        on conflict(id) do update set
          orderId = excluded.orderId,
          title = excluded.title,
          variantTitle = excluded.variantTitle,
          sku = excluded.sku,
          quantity = excluded.quantity,
          currentQuantity = excluded.currentQuantity,
          productTags = excluded.productTags,
          properties = excluded.properties
      `,
      { discard: true },
    );

  /** Flags that a new order was refused at {@link ShopLimits.maxOpenOrders}; `coalesce` keeps the first refusal's instant. */
  const markOrdersLimited = Effect.fn("OrderRepository.markOrdersLimited")(function* (now: number) {
    yield* sql`
      update ShopUsage
      set ordersLimitedAt = coalesce(ordersLimitedAt, ${now})
      where id = 1
    `;
  });

  /**
   * The open-order count, and its one definition: what {@link openOrdersAtCeiling} reads.
   * Spelled through `OPEN` so the partial index `ShopOrder_open_idx` serves it, one index entry
   * per open order.
   */
  const countOpenOrders = Effect.fn("OrderRepository.countOpenOrders")(function* () {
    const [row] = yield* sql<{
      readonly openOrders: number;
    }>`select count(*) as openOrders from ShopOrder where ${sql.literal(OPEN)}`;
    return row?.openOrders ?? 0;
  });

  /**
   * The one write every ingestion path funnels through, and the only reason
   * webhooks and a bulk stream can interleave freely. What one sync does to
   * one order is {@link syncOrder}'s actions table; this is where it is
   * executed, in one transaction, with the items and the reconcile (rule 6 on
   * `syncOrder`), keeping `countedAt` on every write (rule 7).
   *
   * The upsert keeps `where excluded.updatedAt >= ShopOrder.updatedAt`
   * beside the function's decision: the function decided, and the clause is
   * the belt. `returning id` reports it: SQLite emits a row only for an
   * insert or an update that actually ran, so an empty result means the
   * write lost, and the items are then left alone too. Writing them anyway
   * would replace a fresh set with a stale one under a row that correctly
   * refused to move.
   *
   * Line items are replaced wholesale on every accepted write, so a removed
   * line disappears. Every fetch path asks Shopify for the first
   * `ShopLimits.maxLineItemsPerOrder` (250), which is the maximum any
   * connection page may carry, and neither pages: an order with more is
   * stored with its first 250 and logged, never merged. 250 is
   * Baton's ceiling because it is Shopify's, and because the single-order
   * query stays inside the 1,000-point cost cap at that width — each line
   * node selects `variant { id }` and `product { id tags }`, about 3 points,
   * so 250 lines is roughly 750. A merge path would exist only to protect
   * lines the app never saw, and there are none.
   *
   * One transaction per order, not per stream: a bulk run opens the Durable
   * Object's input gate on every `await` inside the fetch, so a webhook can
   * and will interleave between orders. Per-order atomicity is what keeps
   * either writer from observing half an order.
   *
   * A new order refused at the order ceiling sets the refusal flag
   * (`ShopUsage.ordersLimitedAt`); a stored new order does not clear
   * it ({@link clearOrdersLimited} is the rule).
   */
  const upsertOrder = <A = void, E = never>({
    order,
    lineItems,
    afterWrite,
  }: OrderUpsert<A, E>): Effect.Effect<
    {
      readonly written: boolean;
      /** What `afterWrite` returned, when the write happened and it ran. */
      readonly afterWrite: Option.Option<A>;
      /**
       * The order had no row before this write. What `ShopUsage` counts
       * against the plan's billing cycle — a second sync of a stored order is not
       * a second order — and what the bulk stream reports as `ordersInserted`.
       */
      readonly fresh: boolean;
      /**
       * The order row moved: `fresh`, or an `updatedAt` newer than the
       * stored one. A write of the version already stored rewrites the row
       * (rule 7 on `syncOrder`) and is `written` but not `changed`;
       * `syncedAt` moves on every write and is left out because no screen
       * shows it. What the actor's notice gates on.
       */
      readonly changed: boolean;
      /**
       * The write was a new order refused at
       * `ShopLimits.maxOpenOrders` and nothing was stored. Checked
       * here, on the one path every ingestion shares, so a bulk stream that
       * crosses the ceiling mid-file stops storing new orders at the line
       * where it crossed; the webhook path also checks before its fetch,
       * to spare the Shopify call.
       */
      readonly refused: boolean;
    },
    SqlError.SqlError | E
  > =>
    transaction(
      Effect.gen(function* () {
        // One primary-key probe, before the upsert makes the answer
        // unknowable: `returning id` cannot distinguish an insert from
        // an update, and `fresh` is what the bulk stream reports and
        // what the ceiling gates on.
        const existing = yield* sql<{
          readonly updatedAt: number;
        }>`select updatedAt from ShopOrder where id = ${order.id} limit 1`;
        const stored = existing[0];
        // Counted inside the transaction, so a stream storing its
        // two-thousandth order reads the 1,999 before it; `syncOrder`
        // ignores `atCeiling` for a stored order (rule 8), so no count
        // is read for one.
        const atCeiling = stored === undefined && openOrdersAtCeiling(yield* countOpenOrders());
        const action = syncOrder({ stored: stored ?? null, incoming: order, atCeiling });
        if (action._tag === "refuse" && action.reason === "ceiling")
          yield* markOrdersLimited(order.syncedAt);
        if (action._tag !== "write")
          return {
            written: false,
            fresh: false,
            changed: false,
            refused: action._tag === "refuse" && action.reason === "ceiling",
            afterWrite: Option.none<A>(),
          };
        const fresh = action.fresh;
        const changed = fresh || (stored !== undefined && order.updatedAt > stored.updatedAt);
        const written = yield* sql`
          insert into ShopOrder (
            id, legacyId, name, processedAt, updatedAt,
            cancelledAt, fulfillmentStatus,
            fullyPaid, note, syncedAt
          ) values (
            ${order.id}, ${order.legacyId}, ${order.name},
            ${order.processedAt}, ${order.updatedAt},
            ${order.cancelledAt}, ${order.fulfillmentStatus},
            ${bit(order.fullyPaid)}, ${order.note}, ${order.syncedAt}
          )
          on conflict(id) do update set
            legacyId = excluded.legacyId,
            name = excluded.name,
            processedAt = excluded.processedAt,
            updatedAt = excluded.updatedAt,
            cancelledAt = excluded.cancelledAt,
            fulfillmentStatus = excluded.fulfillmentStatus,
            fullyPaid = excluded.fullyPaid,
            note = excluded.note,
            syncedAt = excluded.syncedAt
          where excluded.updatedAt >= ShopOrder.updatedAt
          returning id
        `;
        if (written.length === 0)
          return {
            written: false,
            fresh: false,
            changed: false,
            refused: false,
            afterWrite: Option.none<A>(),
          };
        yield* sql`delete from OrderLineItem where orderId = ${order.id}`;
        yield* insertLineItems(lineItems);
        const after = afterWrite === undefined ? Option.none<A>() : Option.some(yield* afterWrite);
        return { written: true, fresh, changed, refused: false, afterWrite: after };
      }),
    ).pipe(Effect.withSpan("OrderRepository.upsertOrder"));

  /** A single order with its items, or `none`. */
  const getOrder = Effect.fn("OrderRepository.getOrder")(function* (orderId: string) {
    const [order] = yield* decodeOrders(
      yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
    );
    if (order === undefined) return Option.none<OrderDetail>();
    return Option.some<OrderDetail>({ order, lineItems: yield* lineItemsOf(order.id) });
  });

  /**
   * The stored `updatedAt`, for the webhook path's skip-if-stale check. An
   * absent row is `none`, which reads as "fetch it".
   */
  const getOrderUpdatedAt = Effect.fn("OrderRepository.getOrderUpdatedAt")(function* (
    orderId: string,
  ) {
    const rows = yield* sql`
      select updatedAt from ShopOrder where id = ${orderId}
    `.values;
    const updatedAt = rows[0]?.[0];
    return typeof updatedAt === "number" ? Option.some(updatedAt) : Option.none();
  });

  /**
   * The webhook path's probe, before the Backend asks Shopify for the order: `Stale` when the
   * payload's version is not newer than the stored row (an edit has no version, `null`, and
   * always fetches); for an order not stored, `Refused` at the order ceiling, read against the
   * open orders stored now, which marks `ordersLimitedAt` (rule 5 on `syncOrder`); otherwise
   * `Fetch`. Every order already stored keeps receiving its updates.
   */
  const orderVersion = Effect.fn("OrderRepository.orderVersion")(function* ({
    orderId,
    updatedAt,
    now,
  }: {
    readonly orderId: string;
    readonly updatedAt: number | null;
    readonly now: number;
  }) {
    const stored = yield* getOrderUpdatedAt(orderId);
    if (updatedAt !== null && Option.isSome(stored) && updatedAt <= stored.value)
      return { _tag: "Stale" } as const;
    if (Option.isNone(stored)) {
      const openOrders = yield* countOpenOrders();
      if (openOrdersAtCeiling(openOrders)) {
        yield* markOrdersLimited(now);
        return { _tag: "Refused", openOrders } as const;
      }
    }
    return { _tag: "Fetch" } as const;
  });

  /**
   * One page of the stored orders with their items, newest first by `processedAt`, `id` breaking
   * a tie. Keyset, never `limit/offset`: the bulk stream and webhooks insert while a merchant
   * pages, and an offset would skip or repeat rows under those writes. One extra row is fetched
   * to learn whether a next page exists without a second count. A cursor that does not parse is
   * page one. The page and its items are read in one transaction, so a write landing between
   * the two reads never pairs a row with another version's items.
   */
  const listOrders = Effect.fn("OrderRepository.listOrders")(function* ({
    limit,
    cursor,
  }: OrdersListInput) {
    const after = Option.flatMap(Option.fromNullishOr(cursor), decodeCursor);
    const keyset = Option.match(after, {
      onNone: () => sql.literal("1 = 1"),
      onSome: ({ processedAt, id }) =>
        sql.or([
          sql`processedAt < ${processedAt}`,
          sql`(processedAt = ${processedAt} and id < ${id})`,
        ]),
    });
    return yield* transaction(
      Effect.gen(function* () {
        const page = yield* decodeOrders(
          yield* sql`
            select ${orderColumns} from ShopOrder
            where ${keyset}
            order by processedAt desc, id desc
            limit ${limit + 1}
          `,
        );
        const orders = page.slice(0, limit);
        const ids = orders.map(({ id }) => id);
        const items =
          ids.length === 0
            ? []
            : yield* decodeLineItems(
                yield* sql`select * from OrderLineItem where ${sql.in("orderId", ids)} order by id`,
              );
        const last = orders.at(-1);
        return {
          orders: orders.map((order) => ({
            order,
            lineItems: items.filter((item) => item.orderId === order.id),
          })),
          limit,
          nextCursor: page.length > limit && last !== undefined ? encodeCursor(last) : null,
        } satisfies OrdersListPage;
      }),
    );
  });

  /**
   * The one `SyncState` row, seeded by the schema so every read is a plain
   * `select` and every write an `update` that cannot race an insert.
   */
  const getSyncState = Effect.fn("OrderRepository.getSyncState")(function* () {
    return yield* syncState(yield* sql`select lastError from SyncState where id = 1`);
  });

  /**
   * Records the failure that ended the last sync. The banner on the
   * orders index carries it until the next sync clears it.
   */
  const setSyncError = Effect.fn("OrderRepository.setSyncError")(function* ({
    error,
  }: {
    readonly error: string;
  }) {
    return yield* syncState(
      yield* sql`
        update SyncState set lastError = ${error}
        where id = 1
        returning lastError
      `,
    );
  });

  /**
   * `setSyncError`, but only when no error is
   * recorded: the Workflow's sink writes the merchant sentence first, and
   * the error path that follows must not overwrite it (rule 15 on
   * `syncOrder`).
   */
  const setSyncErrorIfEmpty = Effect.fn("OrderRepository.setSyncErrorIfEmpty")(function* ({
    error,
  }: {
    readonly error: string;
  }) {
    yield* sql`update SyncState set lastError = ${error} where id = 1 and lastError is null`;
  });

  /** Clears the banner; the sync about to start owns the state from here. */
  const clearSyncError = Effect.fn("OrderRepository.clearSyncError")(function* () {
    yield* sql`update SyncState set lastError = null where id = 1`;
  });

  /**
   * The open-orders sync in flight, as {@link SyncTracking}: both null when none is recorded.
   * Whether a record still counts is {@link isTrackingFresh}'s rule, not the row's.
   */
  const getSyncTracking = Effect.fn("OrderRepository.getSyncTracking")(function* () {
    const rows = yield* sql`select workflowId, startedAt from SyncState where id = 1`;
    const [tracking] = yield* decodeSyncTracking(rows);
    if (tracking === undefined)
      return yield* Effect.fail(
        new OrderRepositoryError({ message: "SyncState row is missing", cause: rows }),
      );
    return tracking;
  });

  /** Records the sync just started; the two columns are only ever written together. */
  const trackSync = Effect.fn("OrderRepository.trackSync")(function* ({
    workflowId,
    startedAt,
  }: {
    readonly workflowId: string;
    readonly startedAt: number;
  }) {
    yield* sql`
      update SyncState set workflowId = ${workflowId}, startedAt = ${startedAt}
      where id = 1
    `;
  });

  /**
   * Clears the tracking record, and only when it is `workflowId`'s: a sync that ends after a
   * newer one started (its record went stale and the next press replaced it) must not
   * re-enable the button under the newer one. Answers whether it cleared anything.
   */
  const clearSyncTracking = Effect.fn("OrderRepository.clearSyncTracking")(function* ({
    workflowId,
  }: {
    readonly workflowId: string;
  }) {
    const cleared = yield* sql`
      update SyncState set workflowId = null, startedAt = null
      where id = 1 and workflowId = ${workflowId}
      returning id
    `;
    return cleared.length > 0;
  });

  /** The sync status the orders index shows: {@link OrdersSyncStatus} at `now`. */
  const getSyncStatus = Effect.fn("OrderRepository.getSyncStatus")(function* (now: number) {
    const { lastError } = yield* getSyncState();
    const tracking = yield* getSyncTracking();
    return { inFlight: isTrackingFresh(tracking, now), lastError } satisfies OrdersSyncStatus;
  });

  /**
   * The start of an open-orders sync, legacy's `syncOpenOrders` without the Workflow, in one
   * transaction, so two presses can never both start: rule 3 on `syncOrder`, one sync at a
   * time.
   *
   * - A fresh tracking record ({@link isTrackingFresh}) answers `InFlight` and writes nothing.
   * - A stale one is dead and is cleared, without asking Cloudflare, and the start goes on;
   *   `stale` reports it for the log.
   * - At the order ceiling, read against the open orders stored now (rule 5), it answers
   *   `Refused` and marks `ordersLimitedAt`.
   * - Otherwise it clears `lastError` and `ordersLimitedAt` (the start is what closes the gap
   *   the flag announced, {@link clearOrdersLimited}), records `workflowId` at `now`, and
   *   answers `Started`. The caller creates the Workflow instance after: the record exists
   *   before the instance does, so no press between the two can start a second one.
   */
  const beginSync = Effect.fn("OrderRepository.beginSync")(function* ({
    workflowId,
    now,
  }: {
    readonly workflowId: string;
    readonly now: number;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        const tracking = yield* getSyncTracking();
        if (isTrackingFresh(tracking, now))
          return { _tag: "InFlight", workflowId: tracking.workflowId } as const;
        const stale = tracking.workflowId === null ? null : tracking;
        if (tracking.workflowId !== null)
          yield* clearSyncTracking({ workflowId: tracking.workflowId });
        const openOrders = yield* countOpenOrders();
        if (openOrdersAtCeiling(openOrders)) {
          yield* markOrdersLimited(now);
          return { _tag: "Refused", openOrders, stale } as const;
        }
        yield* clearSyncError();
        yield* clearOrdersLimited();
        yield* trackSync({ workflowId, startedAt: now });
        return { _tag: "Started", stale } as const;
      }),
    );
  });

  /**
   * Clears the refusal flag (`ShopUsage.ordersLimitedAt`), and is
   * the only thing that does. The flag means there is a gap: orders Shopify
   * sent that Baton refused and nothing re-reads but Sync open orders. So
   * the sync's start clears it, and a stored
   * new order does not: a shop held at the ceiling by its own incoming rate
   * stores one order for every fulfilment and would clear the banner before
   * the merchant read it, with the gap still open. A stream that crosses
   * the ceiling sets the flag again, which is the truth: that sync left a
   * gap of its own.
   */
  const clearOrdersLimited = Effect.fn("OrderRepository.clearOrdersLimited")(function* () {
    yield* sql`update ShopUsage set ordersLimitedAt = null where id = 1`;
  });

  /** `lastSweepAt` alone, for the webhook's sweep rate limit: a stored-order webhook must not pay for the open-order count. */
  const lastSweepAt = Effect.fn("OrderRepository.lastSweepAt")(function* () {
    const [row] = yield* sql<{
      readonly lastSweepAt: number | null;
    }>`select lastSweepAt from ShopUsage where id = 1`;
    return row?.lastSweepAt ?? null;
  });

  /**
   * One retention pass: at most `ShopLimits.sweepBatch` orders older than
   * `ShopLimits.orderRetentionDays` — open or closed, with runs or without.
   * Deliberately batched and deliberately carried
   * by a request that was already doing
   * heavy work — there is no alarm and no cron — so a shop with years of
   * history drains over several passes instead of one request paying for
   * all of it. The only path that deletes a synced order (rule 9 on
   * `syncOrder`).
   */
  const sweepExpiredOrders = Effect.fn("OrderRepository.sweepExpiredOrders")(function* ({
    now,
  }: {
    readonly now: number;
  }) {
    const expiredBefore = retentionCutoff(now);
    return yield* transaction(
      Effect.gen(function* () {
        /**
         * One term, and it is the order's own date rather than
         * anything about its state or its runs
         * ({@link ShopLimits.orderRetentionDays} carries the
         * rule). `processedAt` is when the merchant sold it, which is
         * what a year of retention should mean; `updatedAt` would
         * restart the clock every time Shopify touched the row, so a
         * shop that edits old orders would keep them forever.
         * `order by processedAt` walks the oldest first through
         * `ShopOrder_processedAt`.
         */
        const expired = yield* sql`
          select id from ShopOrder
          where processedAt < ${expiredBefore}
          order by processedAt
          limit ${ShopLimits.sweepBatch}
        `.values;
        const ids = expired.map((row) => String(row[0]));
        let runs = 0;
        if (ids.length > 0) {
          // Chunked so the bound parameters stay well inside the
          // Durable Object's per-statement limit, whatever
          // `sweepBatch` is set to.
          for (let at = 0; at < ids.length; at += 90) {
            const chunk = ids.slice(at, at + 90);
            /**
             * The runs go with the order, live ones included, and
             * nothing is closed on the way out: a closed run exists
             * so a member reads why their work stopped, and a row
             * deleted by the next statement of the same transaction
             * is read by nobody.
             */
            const deletedRuns =
              yield* sql`delete from Run where ${sql.in("orderId", chunk)} returning id`;
            runs += deletedRuns.length;
            // `OrderLineItem` cascades; `RunTask` cascaded
            // with the runs above.
            yield* sql`delete from ShopOrder where ${sql.in("id", chunk)}`;
          }
        }
        yield* sql`update ShopUsage set lastSweepAt = ${now} where id = 1`;
        return { orders: ids.length, runs };
      }),
    );
  });

  return {
    upsertOrder,
    getOrder,
    getOrderUpdatedAt,
    orderVersion,
    countOpenOrders,
    markOrdersLimited,
    clearOrdersLimited,
    listOrders,
    getSyncState,
    setSyncError,
    setSyncErrorIfEmpty,
    clearSyncError,
    getSyncTracking,
    trackSync,
    clearSyncTracking,
    getSyncStatus,
    beginSync,
    lastSweepAt,
    sweepExpiredOrders,
  };
};

/** The actor's orders repository; see {@link makeOrderRepository}. */
export type OrderRepository = ReturnType<typeof makeOrderRepository>;

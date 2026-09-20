import type { SqlError } from "effect/unstable/sql";

import {
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  SchemaGetter,
} from "effect";
import { SqlClient } from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";
import * as ReadyWhere from "@/lib/readyWhere";
import { ShopifyAppEvents } from "@/lib/ShopifyAppEvents";

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

export interface OrderUpsert<E = never> {
  readonly order: Domain.ShopOrder;
  readonly lineItems: readonly Domain.OrderLineItem[];
  /**
   * Runs inside the upsert's transaction, after the line items are written and
   * only when the write actually happened. The seam for workflow-run
   * reconciliation: runs must be created and adjusted against exactly the
   * line-item set this write produced, and Durable Object SQLite refuses
   * nested transactions, so the caller composes plain statements here rather
   * than opening its own. Must not await anything but storage.
   */
  readonly afterWrite?: Effect.Effect<void, E>;
}

/**
 * The `ShopUsage` row as stored. {@link Domain.ShopUsage} is this plus
 * `databaseSize`, which only the Durable Object can read.
 */
export const ShopUsageRow = Schema.Struct({
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  ordersThisCycle: Schema.Number,
  ordersLimitedAt: Schema.NullOr(Schema.Number),
  openRunsLimitedAt: Schema.NullOr(Schema.Number),
  lastSweepAt: Schema.NullOr(Schema.Number),
  lastReconciledQuantity: Schema.NullOr(Schema.Number),
  pendingUsageEvents: Schema.Number,
  deadUsageEvents: Schema.Number,
});
export type ShopUsageRow = typeof ShopUsageRow.Type;

/**
 * The cycle columns as the counting path reads them, plus the shop GID a usage
 * event has to be addressed to. Deliberately not {@link ShopUsageRow}: this is
 * read inside the upsert's transaction on every write, so it stays one narrow
 * row rather than the counter report the merchant surfaces ask for.
 */
const ShopUsageCycle = Schema.Struct({
  shopGid: Schema.NullOr(Schema.String),
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  ordersThisCycle: Schema.Number,
});

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((n) => n === 1),
    encode: SchemaGetter.transform((b) => (b ? 1 : 0)),
  }),
);

/**
 * The stored order's counting state, probed before the upsert overwrites it:
 * the two transitions the meter reacts to (unpaid to paid, live to cancelled)
 * are only visible while the row still says what the order *was*.
 */
const StoredOrderCounting = Schema.Struct({
  countedAt: Schema.NullOr(Schema.Number),
  cancelledAt: Schema.NullOr(Schema.Number),
  fullyPaid: SqliteBoolean,
  firstCycleStartAt: Schema.Number,
});

/**
 * The idempotency keys for an order's two possible billing events, permanent at
 * Shopify and capped at 64 characters. Derived from the order id and the
 * direction, never from a clock: replaying a flush must bill once, and a
 * reversal must not collide with the count it reverses. A Shopify order GID is
 * around 30 characters, so both stay well inside the cap.
 */
const countKey = (orderId: string) => `${orderId}#count`;
const reverseKey = (orderId: string) => `${orderId}#reverse`;

/** One usage-event row waiting in the outbox. */
export const UsageEventRow = Schema.Struct({
  idempotencyKey: Schema.String,
  orderId: Schema.String,
  value: Schema.Number,
  occurredAt: Schema.Number,
  attempts: Schema.Number,
});
export type UsageEventRow = typeof UsageEventRow.Type;

/** What one {@link OrderRepository.flushUsageEvents} pass did. */
export interface UsageFlush {
  readonly sent: number;
  readonly remaining: number;
}

export interface WebhookDelivery {
  readonly webhookId: string;
  readonly topic: string;
  readonly orderId: string;
  readonly triggeredAt: number;
  readonly receivedAt: number;
}

const encodeCursor = ({ processedAt, id }: Domain.ShopOrder) =>
  `${String(processedAt)}:${id}`;

const decodeCursor = (cursor: string) => {
  const separator = cursor.indexOf(":");
  const processedAt = Number(cursor.slice(0, separator));
  return separator < 1 || !Number.isFinite(processedAt)
    ? Option.none()
    : Option.some({ processedAt, id: cursor.slice(separator + 1) });
};

/**
 * Escapes the three characters `like` treats as pattern syntax, so a merchant
 * typing `%` searches for a literal `%` and gets nothing rather than every
 * order. The escape character is `\`, declared on every `like` that uses this.
 */
const escapeLike = (value: string) =>
  value.replaceAll(/[\\%_]/gu, (match) => `\\${match}`);

const json = (value: unknown) => JSON.stringify(value);

/**
 * The open-order predicate, character for character what the partial
 * `ShopOrder_open_idx` in `ShopAgent.ts` is declared over: SQLite only uses a
 * partial index when the query's `where` provably implies the index's, and it
 * proves that by matching terms, not by reasoning about them. The run
 * fragments are correlated to the outer `ShopOrder` row and served by
 * `WorkflowRun_orderId_idx`. A `cancelled` run counts as no run at all,
 * matching `Domain.productionState`'s `none`.
 */
const OPEN = "fulfillmentStatus <> 'FULFILLED' and cancelledAt is null";
const ANY_RUN = `select 1 from WorkflowRun r
  where r.orderId = ShopOrder.id and r.status in ('pending', 'active', 'done')`;
const OPEN_RUN = `select 1 from WorkflowRun r
  where r.orderId = ShopOrder.id and r.status in ('pending', 'active')`;
const DONE_RUN = `select 1 from WorkflowRun r
  where r.orderId = ShopOrder.id and r.status = 'done'`;
/**
 * `Domain.ambiguousItems` in SQL: an item with units still to make, two or
 * more workflows matched at the last reconcile, and no live run. "Live" is any
 * status but `cancelled`, so cancelling the only run on a twice-matched item
 * makes it ambiguous again with no further reconcile — which is the point of
 * deriving the stage rather than storing it.
 *
 * `json_array_length` is SQLite's JSON1, compiled into Durable Object SQLite;
 * `order-repository.test.ts` is the proof.
 */
const LIVE_RUN_FOR_ITEM = `select 1 from WorkflowRun r
  where r.lineItemId = li.id and r.status <> 'cancelled'`;
const AMBIGUOUS_ITEM = `select 1 from OrderLineItem li
  where li.orderId = ShopOrder.id and li.unfulfilledQuantity > 0
    and json_array_length(li.matchedWorkflowIds) >= 2
    and not exists (${LIVE_RUN_FOR_ITEM})`;
/**
 * The `multiple_workflows` stage as one predicate: `Domain.productionState`
 * only reaches that branch when the order can start runs, so an unpaid order
 * with an ambiguous item is *not* choosing — it reads as whatever its runs say.
 * The other stages exclude this whole term, not the bare `AMBIGUOUS_ITEM`, or
 * an unpaid order with a manual run would fall out of every bucket.
 */
const CHOOSING = `fullyPaid = 1 and exists (${AMBIGUOUS_ITEM})`;

const bit = (value: boolean) => (value ? 1 : 0);

export class OrderRepository extends Context.Service<
  OrderRepository,
  {
    /**
     * The one write every ingestion path funnels through, and the only reason
     * webhooks and a bulk stream can interleave freely.
     *
     * The upsert applies `where excluded.updatedAt >= ShopOrder.updatedAt`, so
     * an older observation of an order — a retried webhook replaying its
     * original payload, or a bulk file whose snapshot predates a webhook that
     * landed mid-stream — leaves the stored row alone. Both values are
     * Shopify's `Order.updatedAt`, never a clock of Baton's: this is a
     * **version check**, not an ordering of when the two writers ran, which is
     * what makes it correct across a Worker, a Durable Object and a Workflow
     * that share no clock. Ties are accepted on purpose (`>=`, not `>`) —
     * equal timestamps are the same version of the order, so rewriting it is
     * free and a redelivery of a write that failed halfway through its line
     * items still completes. `returning id` is what
     * reports that: SQLite emits a row only for an insert or an update that
     * actually ran, so an empty result means the write lost the race, and the
     * line items are then left alone too. Writing them anyway would replace a
     * fresh set with a stale one under a row that correctly refused to move.
     *
     * Line items are replaced wholesale on every accepted write, so a removed
     * line disappears. Every fetch path asks Shopify for the first
     * `Domain.ShopLimits.maxLineItemsPerOrder` (250), which is the maximum any
     * connection page may carry, and neither pages: an order with more is
     * stored short and flagged `lineItemsTruncated`, never merged. 250 is
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
     */
    readonly upsertOrder: <E = never>(
      input: OrderUpsert<E>,
    ) => Effect.Effect<
      {
        readonly written: boolean;
        /**
         * The order had no row before this write. What `ShopUsage` counts
         * against the plan's billing cycle — a resync of a stored order is not
         * a second order — and what the bulk stream reports as `ordersInserted`.
         */
        readonly fresh: boolean;
        /**
         * The write was a new order refused at
         * `Domain.ShopLimits.maxOrdersPerCycle` and nothing was stored. Checked
         * here, on the one path every ingestion shares, so a bulk stream that
         * crosses the ceiling mid-file stops storing new orders at the line
         * where it crossed; the webhook path also checks before its fetch,
         * to spare the Shopify call.
         */
        readonly refused: boolean;
      },
      SqlError.SqlError | OrderRepositoryError | E
    >;
    /**
     * `orders/delete`. A deletion inside the cycle the order was counted in is
     * reversed exactly as a cancellation is — the merchant never carried the
     * work — and then the row goes. A deleted order cannot be re-fetched, so
     * the row is not kept for the reversal marker's sake.
     */
    readonly deleteOrder: (input: {
      readonly orderId: string;
      /** The caller's clock, as `syncedAt` is on an upsert: the cycle to reverse against is the one this write lands in. */
      readonly now: number;
    }) => Effect.Effect<void, SqlError.SqlError | OrderRepositoryError>;
    readonly getLineItem: (lineItemId: string) => Effect.Effect<
      Option.Option<{
        readonly order: Domain.ShopOrder;
        readonly lineItem: Domain.OrderLineItem;
      }>,
      SqlError.SqlError | OrderRepositoryError
    >;
    readonly getOrder: (
      orderId: string,
    ) => Effect.Effect<
      Option.Option<Domain.OrderDetail>,
      SqlError.SqlError | OrderRepositoryError
    >;
    readonly getOrderByLegacyId: (
      legacyId: string,
    ) => Effect.Effect<
      Option.Option<Domain.OrderDetail>,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * The stored `updatedAt`, for the webhook path's skip-if-stale check. An
     * absent row is `none`, which reads as "fetch it".
     */
    readonly getOrderUpdatedAt: (
      orderId: string,
    ) => Effect.Effect<Option.Option<number>, SqlError.SqlError>;
    /**
     * `state` filters by `Domain.OrdersFilterState` and `paid` by `fullyPaid`;
     * each SQL fragment restates a branch of `productionState` and must move
     * with it. The three open stages and the `openCounts` aggregate spell out
     * `fulfillmentStatus <> 'FULFILLED' and cancelledAt is null` verbatim so
     * SQLite can prove they are served by the partial `ShopOrder_open_idx`,
     * which is what keeps a count from reading the shop's whole history.
     *
     * `openCounts` is the shop's open strip and honours none of the filters —
     * not `state`, `paid`, `team`, `attention`, or `q` — so the numbers a
     * merchant filters against do not move under the filter they just applied.
     */
    readonly listOrders: (input: {
      readonly limit: number;
      readonly cursor: string | null;
      /** `null` is no search; otherwise a prefix match on `ShopOrder.name` (`Domain.ListOrdersInput.q`). */
      readonly q: Domain.OrderSearch | null;
      readonly state: Domain.OrdersFilterState | null;
      readonly paid: boolean | null;
      readonly attention: boolean;
      /** `null` is any team; an id is `Domain.ListOrdersInput.team` — waiting on that team. */
      readonly team: Domain.TeamId | null;
      /** The live D1 roster `attention` and `waitingOn` are derived against (`Domain.OrderRow`). */
      readonly teams: readonly Domain.TeamRoster[];
    }) => Effect.Effect<
      Domain.OrdersPage,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Idempotence for a delivery channel that retries 8 times over 4 hours and
     * warns the same webhook may arrive more than once. `false` means this
     * `X-Shopify-Webhook-Id` was already handled and the caller should stop.
     */
    readonly recordWebhookDelivery: (
      delivery: WebhookDelivery,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly getSyncState: () => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * The import finished. Not written by the stream: a file that streams
     * halfway and then fails must not leave a timestamp claiming an import
     * completed.
     */
    readonly setLastCompletedAt: (input: {
      readonly now: number;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Records why the last import did not happen or did not finish — a
     * refusal before the workflow started, or the failure that ended it. The
     * banner on the orders index carries it until the next import clears it.
     */
    readonly setSyncError: (input: {
      readonly error: string;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /** Clears the banner; the import about to start owns the state from here. */
    readonly clearSyncError: () => Effect.Effect<
      void,
      SqlError.SqlError | OrderRepositoryError
    >;
    /** The stored counters; `databaseSize` is the object's to add (`ShopAgent.getUsage`). */
    readonly getUsage: () => Effect.Effect<
      ShopUsageRow,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Records the shop's billing period, pushed in by the Worker after a plan
     * revalidation (`Domain.BillingCycleInput`).
     *
     * Idempotent for an unchanged cycle: re-pushing the same start writes the
     * columns and leaves the count alone, which is what makes it safe to call
     * on every revalidation.
     */
    readonly setBillingCycle: (
      input: Domain.BillingCycleInput,
    ) => Effect.Effect<void, SqlError.SqlError | OrderRepositoryError>;
    /** Stores Shopify's meter reading and returns the counters beside it, so the caller can log the divergence. */
    readonly reconcileUsage: (
      input: Domain.ReconcileUsageInput,
    ) => Effect.Effect<ShopUsageRow, SqlError.SqlError | OrderRepositoryError>;
    /** Flags that a new order was refused at `Domain.ShopLimits.maxOrdersPerCycle`; `coalesce` keeps the first refusal's instant. */
    readonly markOrdersLimited: (
      now: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * One pass over the usage-event outbox: at most `ShopLimits.sweepBatch`
     * live rows, oldest first, each sent and then deleted or marked. Rows dated
     * before the current cycle are skipped, not retried
     * (`Domain.usageEventIsDead`).
     *
     * Deliberately outside every upsert transaction — it does network I/O, and
     * Durable Object SQLite transactions must not await anything but storage.
     * `ShopifyAppEvents` is a requirement of the *effect* rather than of the
     * layer, so the repository stays constructible from a bare SQLite client
     * and only the callers that flush have to provide the client.
     */
    readonly flushUsageEvents: (
      shop: string,
    ) => Effect.Effect<
      UsageFlush,
      SqlError.SqlError | OrderRepositoryError,
      ShopifyAppEvents
    >;
    /**
     * Seed only: delete every order under `SEED_ORDER_ID_PREFIX`, its line
     * items, its runs, its share of `ordersThisCycle`, and any usage event it
     * queued that has not gone out yet. Each departs from
     * `deleteOrder` on purpose. Runs: an `orders/delete` webhook flags them
     * rather than dropping the trail of work, but a fixture row being replaced
     * has no trail worth keeping, and a run outliving its order carries its
     * own snapshot of the order name and item, so it would sit on a queue as a
     * card nothing can clear. Usage: the quota counts orders carried, not
     * orders still stored, so `deleteOrder` never gives the count back; a
     * reseed would then climb by a fixture's worth every time until the quota
     * banner appeared over a shop holding one seed's orders. Only the seed
     * knows the whole set is being replaced, so only it may subtract — and it
     * subtracts rather than zeroes so synced orders keep their share. It
     * subtracts by `countedAt`, the per-order marker the meter writes, so the
     * subtraction matches exactly what was added however the order later
     * changed. The queued events go with the rows because a fixture must not
     * bill a development store; events already accepted by Shopify are gone
     * from the table and are the seed's own to answer for.
     */
    readonly deleteSeedOrders: () => Effect.Effect<void, SqlError.SqlError>;
    /**
     * One retention pass: at most `ShopLimits.sweepBatch` orders older than
     * `ShopLimits.orderRetentionDays` — open or closed, with runs or without —
     * plus a batch of runs orphaned by an `orders/delete`. Deliberately
     * batched and deliberately carried by a request that was already doing
     * heavy work — there is no alarm and no cron — so a shop with years of
     * history drains over several passes instead of one request paying for
     * all of it.
     */
    readonly sweepExpiredOrders: (input: {
      readonly now: number;
    }) => Effect.Effect<
      { readonly orders: number; readonly runs: number },
      SqlError.SqlError
    >;
  }
>()("OrderRepository") {
  static readonly layer: Layer.Layer<
    OrderRepository,
    never,
    SqlClient.SqlClient
  > = Layer.effect(
    OrderRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const decode =
        <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
        (rows: unknown) =>
          Schema.decodeUnknownEffect(schema)(rows).pipe(
            Effect.mapError(
              (cause) => new OrderRepositoryError({ message, cause }),
            ),
          );

      const orderColumns = sql.literal(
        `id, legacyId, name, processedAt, updatedAt, cancelledAt,
         closedAt, financialStatus, fulfillmentStatus, fullyPaid, note,
         customAttributes, lineItemsTruncated, syncedAt, syncSource`,
      );

      /**
       * A single order with its line items, or `none`. Shared by the GID and
       * legacy-id lookups so both read the same shape.
       */
      const detailOf = Effect.fn("OrderRepository.detailOf")(function* (
        rows: readonly unknown[],
      ) {
        const [order] = yield* decodeOrders(rows);
        return order === undefined
          ? Option.none()
          : Option.some({
              order,
              lineItems: yield* decodeLineItems(
                yield* sql`select * from OrderLineItem where orderId = ${order.id} order by id`,
              ),
            } satisfies Domain.OrderDetail);
      });

      const decodeOrders = decode(
        Schema.Array(Domain.ShopOrder),
        "Invalid ShopOrder row",
      );
      const decodeLineItems = decode(
        Schema.Array(Domain.OrderLineItem),
        "Invalid OrderLineItem row",
      );
      const decodeSyncState = decode(
        Schema.Array(Domain.SyncState),
        "Invalid SyncState row",
      );

      const syncState = Effect.fn("OrderRepository.syncState")(function* (
        rows: unknown,
      ) {
        const [state] = yield* decodeSyncState(rows);
        if (state === undefined)
          return yield* Effect.fail(
            new OrderRepositoryError({
              message: "SyncState row is missing",
              cause: rows,
            }),
          );
        return state;
      });

      const readSyncState = () =>
        Effect.gen(function* () {
          return yield* syncState(
            yield* sql`select lastError, lastCompletedAt from SyncState where id = 1`,
          );
        });

      /**
       * `matchedWorkflowIds` is written on insert only and deliberately absent
       * from the `do update set` list: reconcile owns the column, runs after
       * this write in `afterWrite`, and a resync must not blank an item's
       * matches in the window between the two.
       */
      const insertLineItems = (lineItems: readonly Domain.OrderLineItem[]) =>
        Effect.forEach(
          lineItems,
          (item) => sql`
            insert into OrderLineItem (
              id, orderId, productId, variantId, title, variantTitle, sku,
              quantity, currentQuantity, unfulfilledQuantity,
              nonFulfillableQuantity, productTags, matchedWorkflowIds,
              customAttributes, requiresShipping
            ) values (
              ${item.id}, ${item.orderId}, ${item.productId}, ${item.variantId},
              ${item.title}, ${item.variantTitle}, ${item.sku},
              ${item.quantity}, ${item.currentQuantity},
              ${item.unfulfilledQuantity}, ${item.nonFulfillableQuantity},
              ${json(item.productTags)}, ${json(item.matchedWorkflowIds)},
              ${json(item.customAttributes)}, ${bit(item.requiresShipping)}
            )
            on conflict(id) do update set
              orderId = excluded.orderId,
              productId = excluded.productId,
              variantId = excluded.variantId,
              title = excluded.title,
              variantTitle = excluded.variantTitle,
              sku = excluded.sku,
              quantity = excluded.quantity,
              currentQuantity = excluded.currentQuantity,
              unfulfilledQuantity = excluded.unfulfilledQuantity,
              nonFulfillableQuantity = excluded.nonFulfillableQuantity,
              productTags = excluded.productTags,
              customAttributes = excluded.customAttributes,
              requiresShipping = excluded.requiresShipping
          `,
          { discard: true },
        );

      const decodeCycle = decode(
        Schema.Array(ShopUsageCycle),
        "Invalid ShopUsage row",
      );

      /**
       * Orders whose `countedAt` is at or after `since`: what a cycle
       * starting there is worth, used to recount when the Worker pushes a new
       * billing period.
       *
       * Correct only while a cycle is a month or less. `countedAt` is a
       * single timestamp per order, so an order counted in *any* earlier
       * period still inside `since` would be counted again — which cannot
       * happen for consecutive monthly cycles, where everything before the
       * new start belongs to a period that has closed. A yearly cycle would
       * break it, which is why `README.md` forbids one; nothing in code
       * enforces that, because the plan's interval lives in the Partner
       * Dashboard.
       */
      const countedSince = (since: number) =>
        sql`select count(*) from ShopOrder where countedAt >= ${since}`.values.pipe(
          Effect.map(([row]) => Number(row?.[0] ?? 0)),
        );

      /**
       * The cycle this write counts against, rolling the stored one forward
       * when the write lands past its end.
       *
       * The rollover rides the counting path rather than a clock: a quiet
       * shop's stored cycle may lag by periods, and the only moment that can
       * matter is the first order of a new one — which is exactly here. The
       * rolled-forward cycle is deliberately open-ended (`cycleEndAt` null):
       * only Shopify knows where the next period really ends, and
       * `setBillingCycle` lands the exact answer within minutes, because the
       * plan cache deadline is clamped to the boundary.
       *
       * A shop with no cycle at all opens a provisional one
       * ({@link Domain.provisionalCycleStart}) rather than skipping the count:
       * an order can arrive before the first plan revalidation, and an unmetered
       * order is a billing error, not a rounding one.
       */
      const currentCycle = Effect.fn("OrderRepository.currentCycle")(function* (
        now: number,
      ) {
        const [stored] = yield* decodeCycle(
          yield* sql`select shopGid, cycleStartAt, cycleEndAt, ordersThisCycle from ShopUsage where id = 1`,
        );
        if (stored === undefined)
          return yield* Effect.fail(
            new OrderRepositoryError({
              message: "ShopUsage row is missing",
              cause: null,
            }),
          );
        if (stored.cycleStartAt === null) {
          const cycleStartAt = Domain.provisionalCycleStart(now);
          yield* sql`
            update ShopUsage
            set cycleStartAt = ${cycleStartAt}, ordersThisCycle = 0, ordersLimitedAt = null
            where id = 1
          `;
          return { shopGid: stored.shopGid, cycleStartAt, ordersThisCycle: 0 };
        }
        if (stored.cycleEndAt !== null && now >= stored.cycleEndAt) {
          // Recounted from the rows, as `setBillingCycle` does, so both ways a
          // cycle can start state one rule: the count is the orders counted
          // at or after the start.
          const count = yield* countedSince(stored.cycleEndAt);
          yield* sql`
            update ShopUsage
            set cycleStartAt = cycleEndAt, cycleEndAt = null,
                ordersThisCycle = ${count}, ordersLimitedAt = null
            where id = 1
          `;
          return {
            shopGid: stored.shopGid,
            cycleStartAt: stored.cycleEndAt,
            ordersThisCycle: count,
          };
        }
        return {
          shopGid: stored.shopGid,
          cycleStartAt: stored.cycleStartAt,
          ordersThisCycle: stored.ordersThisCycle,
        };
      });

      /**
       * Gives a counted order back: the count, and a `-1` against the `+1` it
       * queued. Shared by the cancellation transition in {@link countOrder} and
       * by `deleteOrder`, which is a cancellation Shopify did not bother to
       * word as one. Only meaningful inside the cycle the order was counted in
       * — Shopify has closed any earlier period and would refuse the event,
       * and the local count has already reset — so the caller checks
       * `countedAt` against the cycle first.
       */
      const reverseOrder = (orderId: string, now: number) =>
        Effect.gen(function* () {
          yield* sql`update ShopOrder set countedAt = null where id = ${orderId}`;
          yield* sql`
            update ShopUsage
            set ordersThisCycle = max(0, ordersThisCycle - 1)
            where id = 1
          `;
          yield* queueUsageEvent({
            idempotencyKey: reverseKey(orderId),
            orderId,
            value: -1,
            occurredAt: now,
          });
        });

      /**
       * The billing meter, inside the upsert's transaction so a counted order,
       * its count, and the event that bills for it cannot come apart.
       *
       * Three transitions, and only three. **Counted on arrival**: a freshly
       * stored order that satisfies {@link Domain.orderCountsTowardCycle}
       * takes a `countedAt`, increments the cycle, and queues one `+1` event.
       * **Counted on payment**: a stored order that was never counted, is not
       * cancelled, and arrives paid for the first time does the same, in the
       * cycle of *this* write — the shop carried the work and is now paid for
       * it. The placement term is judged against the cycle the order was
       * first stored in (`firstCycleStartAt`), so a backfilled order paid
       * after install still never bills. **Reversed**: an order that was
       * counted inside the current cycle and arrives cancelled for the first
       * time gives the count back and queues one `-1`. A merchant who never
       * made the thing should not pay for it; a refund is not a cancellation
       * and is not reversed, because the work was done.
       *
       * Freshness and the paid/cancelled transitions are this function's
       * business rather than the predicate's because they are properties of
       * the write, not of the order — a webhook storm on one order is one
       * order. `countedAt` is what makes each transition fire exactly once,
       * and a reversed order stays reversed: Shopify never reopens a
       * cancelled order, and the `#count` key is permanent at Shopify, so
       * counting it again could only ever diverge the local number from the
       * bill.
       */
      const countOrder = (
        order: Domain.ShopOrder,
        cycleStartAt: number,
        stored: typeof StoredOrderCounting.Type | null,
      ) =>
        Effect.gen(function* () {
          const count = () =>
            Effect.gen(function* () {
              yield* sql`update ShopOrder set countedAt = ${order.syncedAt} where id = ${order.id}`;
              yield* sql`update ShopUsage set ordersThisCycle = ordersThisCycle + 1 where id = 1`;
              yield* queueUsageEvent({
                idempotencyKey: countKey(order.id),
                orderId: order.id,
                value: 1,
                occurredAt: order.syncedAt,
              });
            });
          if (stored === null) {
            if (Domain.orderCountsTowardCycle(order, cycleStartAt))
              yield* count();
            return;
          }
          if (
            stored.countedAt === null &&
            stored.cancelledAt === null &&
            !stored.fullyPaid &&
            Domain.orderCountsTowardCycle(order, stored.firstCycleStartAt)
          ) {
            yield* count();
            return;
          }
          if (
            stored.countedAt !== null &&
            stored.countedAt >= cycleStartAt &&
            stored.cancelledAt === null &&
            order.cancelledAt !== null
          )
            yield* reverseOrder(order.id, order.syncedAt);
        });

      /**
       * `or ignore`, so re-queuing a key Shopify has already been told about is
       * a no-op rather than a second charge. The row carries no shop: the shop
       * is the object, and `ShopUsage.shopGid` is read once at flush time.
       *
       * A seeded order queues nothing ({@link Domain.orderIsSeeded}). It is
       * refused here rather than at the call sites because this is the only
       * door into the outbox, and a fixture that reaches Shopify's meter costs
       * real money under a permanent idempotency key.
       */
      const queueUsageEvent = (input: {
        readonly idempotencyKey: string;
        readonly orderId: string;
        readonly value: number;
        readonly occurredAt: number;
      }) =>
        Domain.orderIsSeeded(input.orderId)
          ? Effect.void
          : sql`
              insert or ignore into UsageEvent (idempotencyKey, orderId, value, occurredAt)
              values (${input.idempotencyKey}, ${input.orderId}, ${input.value}, ${input.occurredAt})
            `;

      const markOrdersLimited = Effect.fn("OrderRepository.markOrdersLimited")(
        function* (now: number) {
          yield* sql`
            update ShopUsage
            set ordersLimitedAt = coalesce(ordersLimitedAt, ${now})
            where id = 1
          `;
        },
      );

      const decodeUsage = decode(
        Schema.Array(ShopUsageRow),
        "Invalid ShopUsage row",
      );

      const readUsage = Effect.fn("OrderRepository.getUsage")(function* () {
        const [usage] = yield* decodeUsage(
          yield* sql`
            select cycleStartAt, cycleEndAt, ordersThisCycle, ordersLimitedAt,
                   openRunsLimitedAt, lastSweepAt, lastReconciledQuantity,
                   (select count(*) from UsageEvent
                    where cycleStartAt is null or occurredAt >= cycleStartAt) as pendingUsageEvents,
                   (select count(*) from UsageEvent
                    where cycleStartAt is not null and occurredAt < cycleStartAt) as deadUsageEvents
            from ShopUsage where id = 1
          `,
        );
        if (usage === undefined)
          return yield* Effect.fail(
            new OrderRepositoryError({
              message: "ShopUsage row is missing",
              cause: null,
            }),
          );
        return usage;
      });

      return OrderRepository.of({
        upsertOrder: <E>({ order, lineItems, afterWrite }: OrderUpsert<E>) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                // One primary-key probe, before the upsert makes the answer
                // unknowable: `returning id` cannot distinguish an insert from
                // an update, and the meter counts orders, not writes. The
                // probe also carries the stored counting state, because a
                // cancellation is a *transition* — it is only reversible while
                // the row still says the order was counted and not yet
                // cancelled, and the upsert is about to overwrite both.
                const [existing] = yield* decode(
                  Schema.Array(StoredOrderCounting),
                  "Invalid ShopOrder counting row",
                )(
                  yield* sql`select countedAt, cancelledAt, fullyPaid, firstCycleStartAt from ShopOrder where id = ${order.id} limit 1`,
                );
                const fresh = existing === undefined;
                // The cycle is resolved before the insert, because the row
                // remembers the cycle it was first stored in, and because
                // the ceiling below is a fact about the cycle this write
                // lands in, after any roll-forward.
                const cycle = yield* currentCycle(order.syncedAt);
                if (
                  fresh &&
                  Domain.cycleAtOrderCeiling(cycle.ordersThisCycle)
                ) {
                  yield* markOrdersLimited(order.syncedAt);
                  return { written: false, fresh: false, refused: true };
                }
                const written = yield* sql`
                insert into ShopOrder (
                  id, legacyId, name, processedAt, updatedAt,
                  cancelledAt, closedAt, financialStatus, fulfillmentStatus,
                  fullyPaid, note, customAttributes,
                  lineItemsTruncated, syncedAt, syncSource, firstCycleStartAt
                ) values (
                  ${order.id}, ${order.legacyId}, ${order.name},
                  ${order.processedAt}, ${order.updatedAt},
                  ${order.cancelledAt}, ${order.closedAt},
                  ${order.financialStatus}, ${order.fulfillmentStatus},
                  ${bit(order.fullyPaid)}, ${order.note},
                  ${json(order.customAttributes)},
                  ${bit(order.lineItemsTruncated)}, ${order.syncedAt},
                  ${order.syncSource}, ${cycle.cycleStartAt}
                )
                on conflict(id) do update set
                  legacyId = excluded.legacyId,
                  name = excluded.name,
                  processedAt = excluded.processedAt,
                  updatedAt = excluded.updatedAt,
                  cancelledAt = excluded.cancelledAt,
                  closedAt = excluded.closedAt,
                  financialStatus = excluded.financialStatus,
                  fulfillmentStatus = excluded.fulfillmentStatus,
                  fullyPaid = excluded.fullyPaid,
                  note = excluded.note,
                  customAttributes = excluded.customAttributes,
                  lineItemsTruncated = excluded.lineItemsTruncated,
                  syncedAt = excluded.syncedAt,
                  syncSource = excluded.syncSource
                where excluded.updatedAt >= ShopOrder.updatedAt
                returning id
              `;
                if (written.length === 0)
                  return { written: false, fresh: false, refused: false };
                yield* sql`delete from OrderLineItem where orderId = ${order.id}`;
                yield* insertLineItems(lineItems);
                yield* countOrder(order, cycle.cycleStartAt, existing ?? null);
                if (afterWrite !== undefined) yield* afterWrite;
                return { written: true, fresh, refused: false };
              }),
            )
            .pipe(Effect.withSpan("OrderRepository.upsertOrder")),

        deleteOrder: Effect.fn("OrderRepository.deleteOrder")(function* ({
          orderId,
          now,
        }: {
          readonly orderId: string;
          readonly now: number;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const [stored] = yield* decode(
                Schema.Array(StoredOrderCounting),
                "Invalid ShopOrder counting row",
              )(
                yield* sql`select countedAt, cancelledAt, fullyPaid, firstCycleStartAt from ShopOrder where id = ${orderId} limit 1`,
              );
              if (
                stored?.countedAt !== null &&
                stored?.countedAt !== undefined
              ) {
                const { cycleStartAt } = yield* currentCycle(now);
                if (stored.countedAt >= cycleStartAt)
                  yield* reverseOrder(orderId, now);
              }
              yield* sql`delete from OrderLineItem where orderId = ${orderId}`;
              yield* sql`delete from ShopOrder where id = ${orderId}`;
            }),
          );
        }),

        getLineItem: Effect.fn("OrderRepository.getLineItem")(function* (
          lineItemId: string,
        ) {
          const [lineItem] = yield* decodeLineItems(
            yield* sql`select * from OrderLineItem where id = ${lineItemId}`,
          );
          if (lineItem === undefined) return Option.none();
          const [order] = yield* decodeOrders(
            yield* sql`select ${orderColumns} from ShopOrder where id = ${lineItem.orderId}`,
          );
          return order === undefined
            ? Option.none()
            : Option.some({ order, lineItem });
        }),

        getOrder: Effect.fn("OrderRepository.getOrder")(function* (
          orderId: string,
        ) {
          return yield* detailOf(
            yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
          );
        }),

        getOrderByLegacyId: Effect.fn("OrderRepository.getOrderByLegacyId")(
          function* (legacyId: string) {
            return yield* detailOf(
              yield* sql`select ${orderColumns} from ShopOrder where legacyId = ${legacyId}`,
            );
          },
        ),

        getOrderUpdatedAt: Effect.fn("OrderRepository.getOrderUpdatedAt")(
          function* (orderId: string) {
            const rows = yield* sql`
              select updatedAt from ShopOrder where id = ${orderId}
            `.values;
            const updatedAt = rows[0]?.[0];
            return typeof updatedAt === "number"
              ? Option.some(updatedAt)
              : Option.none();
          },
        ),

        listOrders: Effect.fn("OrderRepository.listOrders")(function* ({
          limit,
          cursor,
          q,
          state,
          paid,
          attention,
          team,
          teams,
        }: {
          readonly limit: number;
          readonly cursor: string | null;
          readonly q: Domain.OrderSearch | null;
          readonly state: Domain.OrdersFilterState | null;
          readonly paid: boolean | null;
          readonly attention: boolean;
          readonly team: Domain.TeamId | null;
          readonly teams: readonly Domain.TeamRoster[];
        }) {
          /**
           * `Domain.OrderRow.attention` in SQL, bound to the roster the
           * caller read from D1: an open step is unassigned when its team id
           * is null or not in the roster, and a ready step (`readyWhere`, the
           * one definition the worker queue also runs on) on a team with no
           * members is stuck in nobody's queue.
           */
          const liveIds = teams.map(({ id }) => id);
          const emptyIds = teams
            .filter(({ memberCount }) => memberCount === 0)
            .map(({ id }) => id);
          const unassigned =
            liveIds.length === 0
              ? sql.literal("1 = 1")
              : sql`(s.teamId is null or s.teamId not in ${sql.in(liveIds)})`;
          const emptyReady =
            emptyIds.length === 0
              ? sql.literal("1 = 0")
              : sql`(${sql.in("s.teamId", emptyIds)} and ${sql.literal(ReadyWhere.readyWhere("s"))})`;
          const attentionStep = sql`exists (
            select 1 from WorkflowRunStep s
            where s.runId = r.id and s.completedAt is null
              and ${sql.or([unassigned, emptyReady])}
          )`;
          const attentionRun = sql`exists (
            select 1 from WorkflowRun r
            where r.orderId = ShopOrder.id and r.status in ('pending', 'active')
              and ${attentionStep}
          )`;
          const attentionFilter = attention
            ? attentionRun
            : sql.literal("1 = 1");
          /**
           * The waiting-on column's membership test as a `where`, so a
           * filtered page is exactly the rows whose cell names the team —
           * nothing to explain about why a row matched. Aliased `wr` for the
           * same reason as `waitingRows` below: `readyWhere` binds `r`.
           */
          const teamFilter =
            team === null
              ? sql.literal("1 = 1")
              : sql`exists (
                  select 1 from WorkflowRun wr
                  join WorkflowRunStep s on s.runId = wr.id
                  where wr.orderId = ShopOrder.id
                    and wr.status in ('pending', 'active')
                    and (wr.flag is null or wr.flag <> 'blocked')
                    and s.teamId = ${team}
                    and ${sql.literal(ReadyWhere.readyWhere("s"))}
                )`;
          /**
           * `multiple_workflows` outranks the three aggregate stages, exactly
           * as `Domain.productionState` orders them, so the other three carry
           * `not (CHOOSING)` and the filters stay a partition of
           * the open orders — the chips have to add up to what the lists show.
           */
          const stateFilter = Match.value(state).pipe(
            Match.when("no_workflow", () =>
              sql.and([
                OPEN,
                "fullyPaid = 1",
                `not exists (${ANY_RUN})`,
                `not (${CHOOSING})`,
              ]),
            ),
            Match.when("multiple_workflows", () => sql.and([OPEN, CHOOSING])),
            Match.when("in_production", () =>
              sql.and([OPEN, `exists (${OPEN_RUN})`, `not (${CHOOSING})`]),
            ),
            Match.when("ready_to_ship", () =>
              sql.and([
                OPEN,
                `exists (${DONE_RUN})`,
                `not exists (${OPEN_RUN})`,
                `not (${CHOOSING})`,
              ]),
            ),
            Match.when("shipped", () =>
              sql.and([
                "cancelledAt is null",
                "fulfillmentStatus = 'FULFILLED'",
              ]),
            ),
            Match.when("cancelled", () =>
              sql.literal("cancelledAt is not null"),
            ),
            /**
             * `null` is the default view and it is open work, not everything:
             * the negation of the `shipped` and `cancelled` branches above,
             * spelled as `OPEN` so the partial index serves it. `"all"` is the
             * only filter that reads a shop's whole history
             * ({@link Domain.OrdersFilterState}).
             */
            Match.when(null, () => sql.literal(OPEN)),
            Match.when("all", () => sql.literal("1 = 1")),
            Match.exhaustive,
          );
          /**
           * Prefix, not substring. An order name is `#` plus digits and the
           * merchant types the digits they read off the admin, so `#10`
           * listing `#1001` … `#1099` is the useful answer; `%10%` would also
           * match `#2100`, which nobody asked for. Case-insensitive because
           * `name` is `text` with the default `binary` collation and a name is
           * not always digits.
           */
          const searchFilter =
            q === null
              ? sql.literal("1 = 1")
              : sql`name like ${`${escapeLike(Domain.normaliseOrderSearch(q))}%`} escape '\\' collate nocase`;
          const paidFilter = Match.value(paid).pipe(
            Match.when(true, () => sql.literal("fullyPaid = 1")),
            Match.when(false, () => sql.literal("fullyPaid = 0")),
            Match.when(null, () => sql.literal("1 = 1")),
            Match.exhaustive,
          );
          /**
           * Keyset, never `limit/offset`: the bulk stream and webhooks insert
           * while a merchant pages, and an offset would skip or repeat rows
           * under those writes. One extra row is fetched to learn whether a
           * next page exists without a second count.
           */
          const after = Option.flatMap(Option.fromNullOr(cursor), decodeCursor);
          const keyset = Option.match(after, {
            onNone: () => sql.literal("1 = 1"),
            onSome: ({ processedAt, id }) =>
              sql.or([
                sql`processedAt < ${processedAt}`,
                sql`(processedAt = ${processedAt} and id < ${id})`,
              ]),
          });
          const page = yield* decodeOrders(
            yield* sql`
              select ${orderColumns} from ShopOrder
              where ${sql.and([keyset, searchFilter, stateFilter, paidFilter, attentionFilter, teamFilter])}
              order by processedAt desc, id desc
              limit ${limit + 1}
            `,
          );
          const orders = page.slice(0, limit);
          const ids = orders.map(({ id }) => id);
          /**
           * Two aggregates keyed by the page's ids rather than a join: the
           * decoder for `ShopOrder` wants exactly its columns, and `WorkflowRun`
           * lives in the same Durable Object SQLite but belongs to
           * `WorkflowRunRepository`, so this read touches it for counts only.
           */
          const unitRows =
            ids.length === 0
              ? []
              : yield* sql`
                  select orderId, sum(currentQuantity) as units
                  from OrderLineItem
                  where ${sql.in("orderId", ids)}
                  group by orderId
                `.values;
          const runRows =
            ids.length === 0
              ? []
              : yield* sql`
                  select
                    orderId,
                    sum(status in ('pending', 'active')) as open,
                    sum(status = 'done') as done,
                    sum(flag is not null and flag <> 'blocked'
                        and status in ('pending', 'active')) as flagged,
                    sum(flag = 'blocked' and status in ('pending', 'active')) as blocked
                  from WorkflowRun
                  where ${sql.in("orderId", ids)}
                  group by orderId
                `.values;
          const attentionRows =
            ids.length === 0
              ? []
              : yield* sql`
                  select id from ShopOrder
                  where ${sql.in("id", ids)} and ${attentionRun}
                `.values;
          /**
           * `Domain.OrderRow.ambiguousItems`, restating `AMBIGUOUS_ITEM` per
           * item rather than as an `exists`: the badge says how many items are
           * waiting on a choice, not merely that one is.
           */
          const ambiguousRows =
            ids.length === 0
              ? []
              : yield* sql`
                  select li.orderId, count(*)
                  from OrderLineItem li
                  where ${sql.in("li.orderId", ids)}
                    and li.unfulfilledQuantity > 0
                    and json_array_length(li.matchedWorkflowIds) >= 2
                    and not exists (${sql.literal(LIVE_RUN_FOR_ITEM)})
                  group by li.orderId
                `.values;
          /**
           * `Domain.OrderRow.waitingOn`: a fourth per-page read rather than a
           * term on the page query, for the reason the comment above gives
           * for the other aggregates — the `ShopOrder` decoder wants exactly
           * its own columns, and this one returns several rows per order
           * anyway. Gated on `liveIds` because a step pointing at a deleted
           * team is `attention`, not somebody holding the order, and the
           * outer run is aliased `wr`: `readyWhere` binds `r` for the step's
           * own run inside its subqueries (see its JSDoc). A blocked run is
           * left out even though its step is ready: the team cannot move it,
           * so naming them here would send the merchant to the wrong desk —
           * `RunCounts.blocked` is that run's column. The queue still lists it
           * (last), because the worker who blocked it is the one who unblocks.
           */
          const waitingRows =
            ids.length === 0 || liveIds.length === 0
              ? []
              : yield* sql`
                  select distinct wr.orderId, s.teamId
                  from WorkflowRunStep s
                  join WorkflowRun wr on wr.id = s.runId
                  where ${sql.in("wr.orderId", ids)}
                    and wr.status in ('pending', 'active')
                    and (wr.flag is null or wr.flag <> 'blocked')
                    and ${sql.in("s.teamId", liveIds)}
                    and ${sql.literal(ReadyWhere.readyWhere("s"))}
                `.values;
          /**
           * Grouped through the roster rather than by re-branding the stored
           * string, and sorted here by team name rather than in the route:
           * the cell collapses past three teams, so an unstable order would
           * move which ones hide behind the `+N` between refreshes of a
           * subscribed page.
           */
          const roster = new Map<string, Domain.TeamRoster>(
            teams.map((team) => [team.id, team]),
          );
          const waiting = waitingRows.reduce<Map<string, Domain.TeamRoster[]>>(
            (byOrder, row) => {
              const team = roster.get(String(row[1]));
              if (team === undefined) return byOrder;
              const orderId = String(row[0]);
              return byOrder.set(orderId, [
                ...(byOrder.get(orderId) ?? []),
                team,
              ]);
            },
            new Map(),
          );
          const waitingOn = new Map(
            [...waiting].map(([orderId, teams]) => [
              orderId,
              teams
                .toSorted((a, b) => a.name.localeCompare(b.name))
                .map(({ id }) => id),
            ]),
          );
          const needsAttention = new Set(
            attentionRows.map((row) => String(row[0])),
          );
          const ambiguous = new Map(
            ambiguousRows.map((row) => [String(row[0]), Number(row[1] ?? 0)]),
          );
          const units = new Map(
            unitRows.map((row) => [String(row[0]), Number(row[1] ?? 0)]),
          );
          const runs = new Map(
            runRows.map((row) => [
              String(row[0]),
              {
                open: Number(row[1] ?? 0),
                done: Number(row[2] ?? 0),
                flagged: Number(row[3] ?? 0),
                blocked: Number(row[4] ?? 0),
              } satisfies Domain.RunCounts,
            ]),
          );
          /**
           * One pass over the open orders for all four stage counts, each term
           * the same predicate as the matching `stateFilter` branch — including
           * its `CHOOSING` exclusion, so the chips partition the open
           * orders the way the lists do. Unpaid open orders with no runs are
           * the `null` state and fall in no bucket. `attention` is
           * cross-cutting and excludes nothing.
           */
          const [countRow] = yield* sql`
            select
              sum(fullyPaid = 1 and not exists (${sql.literal(ANY_RUN)})
                  and not (${sql.literal(CHOOSING)})),
              sum(${sql.literal(CHOOSING)}),
              sum(exists (${sql.literal(OPEN_RUN)})
                  and not (${sql.literal(CHOOSING)})),
              sum(exists (${sql.literal(DONE_RUN)}) and not exists (${sql.literal(OPEN_RUN)})
                  and not (${sql.literal(CHOOSING)})),
              sum(${attentionRun})
            from ShopOrder
            where ${sql.literal(OPEN)}
          `.values;
          const last = orders.at(-1);
          return {
            orders: orders.map((order) => ({
              order,
              itemUnits: units.get(order.id) ?? 0,
              runs: runs.get(order.id) ?? {
                open: 0,
                done: 0,
                flagged: 0,
                blocked: 0,
              },
              attention: needsAttention.has(order.id),
              waitingOn: waitingOn.get(order.id) ?? [],
              ambiguousItems: ambiguous.get(order.id) ?? 0,
            })),
            limit,
            nextCursor:
              page.length > limit && last !== undefined
                ? encodeCursor(last)
                : null,
            openCounts: {
              no_workflow: Number(countRow?.[0] ?? 0),
              multiple_workflows: Number(countRow?.[1] ?? 0),
              in_production: Number(countRow?.[2] ?? 0),
              ready_to_ship: Number(countRow?.[3] ?? 0),
              attention: Number(countRow?.[4] ?? 0),
            },
          } satisfies Domain.OrdersPage;
        }),

        recordWebhookDelivery: Effect.fn(
          "OrderRepository.recordWebhookDelivery",
        )(function* (delivery: WebhookDelivery) {
          const inserted = yield* sql`
            insert or ignore into WebhookDelivery
              (webhookId, topic, orderId, triggeredAt, receivedAt)
            values (
              ${delivery.webhookId}, ${delivery.topic}, ${delivery.orderId},
              ${delivery.triggeredAt}, ${delivery.receivedAt}
            )
            returning webhookId
          `;
          /**
           * The dedupe log only has to outlive Shopify's retry schedule, which
           * tops out at four hours, so a week is already generous and anything
           * older is dead weight in a table nothing else reads. Swept here
           * rather than on a timer because this is the one statement every
           * delivery already pays for, and the table only grows on this path:
           * no alarm, no cron, nothing to schedule.
           *
           * `delete ... limit` needs a compile-time flag Durable Object SQLite
           * may not carry, hence the `in (select ... limit ?)` form; the bound
           * keeps a single delivery from paying for an unbounded delete.
           */
          const deleted = yield* sql`
            delete from WebhookDelivery
            where webhookId in (
              select webhookId from WebhookDelivery
              where receivedAt < ${delivery.receivedAt - Domain.ShopLimits.webhookDeliveryRetentionDays * 86_400_000}
              order by receivedAt
              limit ${Domain.ShopLimits.sweepBatch}
            )
            returning webhookId
          `;
          if (deleted.length > 0)
            yield* Effect.logDebug(
              `OrderRepository.recordWebhookDelivery: swept=${String(deleted.length)}`,
            ).pipe(Effect.annotateLogs({ swept: deleted.length }));
          return inserted.length > 0;
        }),

        getSyncState: Effect.fn("OrderRepository.getSyncState")(readSyncState),

        setLastCompletedAt: Effect.fn("OrderRepository.setLastCompletedAt")(
          function* ({ now }: { readonly now: number }) {
            return yield* syncState(
              yield* sql`
                update SyncState set lastCompletedAt = ${now}, lastError = null
                where id = 1
                returning lastError, lastCompletedAt
              `,
            );
          },
        ),

        setSyncError: Effect.fn("OrderRepository.setSyncError")(function* ({
          error,
        }: {
          readonly error: string;
        }) {
          return yield* syncState(
            yield* sql`
              update SyncState set lastError = ${error}
              where id = 1
              returning lastError, lastCompletedAt
            `,
          );
        }),

        clearSyncError: Effect.fn("OrderRepository.clearSyncError")(
          function* () {
            yield* sql`update SyncState set lastError = null where id = 1`;
          },
        ),

        getUsage: readUsage,

        setBillingCycle: Effect.fn("OrderRepository.setBillingCycle")(
          function* (input: Domain.BillingCycleInput) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const [stored] = yield* decodeCycle(
                  yield* sql`select shopGid, cycleStartAt, cycleEndAt, ordersThisCycle from ShopUsage where id = 1`,
                );
                const changed = stored?.cycleStartAt !== input.cycleStartAt;
                const unaddressed = stored?.shopGid === null;
                yield* sql`
                  update ShopUsage
                  set shopGid = ${input.shopGid},
                      cycleStartAt = ${input.cycleStartAt},
                      cycleEndAt = ${input.cycleEndAt}
                  where id = 1
                `;
                if (!changed) return;
                /**
                 * A new cycle is recounted from the rows rather than zeroed.
                 * The object may already have counted orders into a provisional
                 * cycle, or into the one it rolled forward on its own, and those
                 * orders were billed — zeroing would make the merchant-facing
                 * count disagree with the invoice for the rest of the period.
                 * Orders counted before the new start belong to a closed period
                 * and drop out, which is what a cycle change means.
                 */
                const count = yield* countedSince(input.cycleStartAt);
                yield* sql`
                  update ShopUsage
                  set ordersThisCycle = ${count}, ordersLimitedAt = null
                  where id = 1
                `;
                /**
                 * Events queued while the shop could not be addressed — before
                 * any cycle was pushed, or through a trial, when Shopify
                 * reports no billing cycle — belong to no billable period:
                 * their orders were just recounted out, and sending them into
                 * the first real cycle would bill work the period never
                 * carried. Only then: once a shop has been addressed, an event
                 * that misses its cycle is a real loss and is kept as one
                 * (`Domain.usageEventIsDead`).
                 */
                if (unaddressed)
                  yield* sql`delete from UsageEvent where occurredAt < ${input.cycleStartAt}`;
              }),
            );
          },
        ),

        reconcileUsage: Effect.fn("OrderRepository.reconcileUsage")(function* (
          input: Domain.ReconcileUsageInput,
        ) {
          yield* sql`
            update ShopUsage set lastReconciledQuantity = ${input.quantity} where id = 1
          `;
          return yield* readUsage();
        }),

        markOrdersLimited,

        flushUsageEvents: Effect.fn("OrderRepository.flushUsageEvents")(
          function* (shop: string) {
            const appEvents = yield* ShopifyAppEvents;
            const [usage] = yield* decodeCycle(
              yield* sql`select shopGid, cycleStartAt, cycleEndAt, ordersThisCycle from ShopUsage where id = 1`,
            );
            const shopGid = usage?.shopGid ?? null;
            const cycleStartAt = usage?.cycleStartAt ?? null;
            if (shopGid === null || cycleStartAt === null) {
              const [pending] = yield* sql`select count(*) from UsageEvent`
                .values;
              const remaining = Number(pending?.[0] ?? 0);
              // Nothing is dropped: the events keep their rows and go out on
              // the first flush after a plan revalidation has named the shop.
              if (remaining > 0)
                yield* Effect.logDebug(
                  `OrderRepository.flushUsageEvents: shop=${shop} status=no-shop-gid pending=${String(remaining)}`,
                ).pipe(
                  Effect.annotateLogs({
                    shop,
                    status: "no-shop-gid",
                    pending: remaining,
                  }),
                );
              return { sent: 0, remaining } satisfies UsageFlush;
            }
            // Live rows only: a row dated before the cycle is dead
            // (`Domain.usageEventIsDead`) and stays for the admin page.
            const [pending] = yield* sql`
              select count(*) from UsageEvent where occurredAt >= ${cycleStartAt}
            `.values;
            const remaining = Number(pending?.[0] ?? 0);
            const rows = yield* decode(
              Schema.Array(UsageEventRow),
              "Invalid UsageEvent rows",
            )(
              yield* sql`
                select idempotencyKey, orderId, value, occurredAt, attempts
                from UsageEvent
                where occurredAt >= ${cycleStartAt}
                order by occurredAt
                limit ${Domain.ShopLimits.sweepBatch}
              `,
            );
            const gid = yield* decode(
              Domain.ShopGid,
              "Invalid shopGid",
            )(shopGid);
            let sent = 0;
            for (const row of rows) {
              /**
               * Per row, never in bulk: one refused event must not hold back
               * the rest, and the API takes one event per request anyway. The
               * failure is recorded on the row rather than raised, because the
               * caller is a webhook or a bulk import whose real work succeeded —
               * a billing event that has not gone out yet is an operator signal
               * (`ShopUsage.pendingUsageEvents`), not a reason to fail a sync.
               */
              const failure = yield* appEvents
                .send({
                  shopGid: gid,
                  eventHandle: Domain.USAGE_METER_ORDER,
                  occurredAt: row.occurredAt,
                  idempotencyKey: row.idempotencyKey,
                  value: row.value,
                })
                .pipe(
                  Effect.as(null),
                  Effect.catch((error) =>
                    Effect.succeed(error.message.slice(0, 200)),
                  ),
                );
              if (failure === null) {
                yield* sql`delete from UsageEvent where idempotencyKey = ${row.idempotencyKey}`;
                sent += 1;
              } else {
                yield* sql`
                  update UsageEvent
                  set attempts = attempts + 1, lastError = ${failure}
                  where idempotencyKey = ${row.idempotencyKey}
                `;
                // Logged as well as stored. `lastError` is a column no surface
                // renders, and a meter that silently stops billing is the one
                // failure mode this whole outbox exists to make visible.
                yield* Effect.logWarning(
                  `OrderRepository.flushUsageEvents: shop=${shop} idempotencyKey=${row.idempotencyKey} attempts=${String(row.attempts + 1)}: ${failure}`,
                ).pipe(
                  Effect.annotateLogs({
                    shop,
                    idempotencyKey: row.idempotencyKey,
                    attempts: row.attempts + 1,
                    error: failure,
                  }),
                );
              }
            }
            return { sent, remaining: remaining - sent } satisfies UsageFlush;
          },
        ),

        deleteSeedOrders: Effect.fn("OrderRepository.deleteSeedOrders")(
          function* () {
            const seedPrefix = `${Domain.SEED_ORDER_ID_PREFIX}%`;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const [row] = yield* sql`
                  select count(*) as counted from ShopOrder
                  where id like ${seedPrefix} and countedAt is not null
                `.values;
                const counted = Number(row?.[0] ?? 0);
                yield* sql`
                  update ShopUsage
                  set ordersThisCycle = max(0, ordersThisCycle - ${counted})
                  where id = 1
                `;
                yield* sql`delete from UsageEvent where orderId like ${seedPrefix}`;
                yield* sql`delete from WorkflowRun where orderId like ${seedPrefix}`;
                yield* sql`delete from OrderLineItem where orderId like ${seedPrefix}`;
                yield* sql`delete from ShopOrder where id like ${seedPrefix}`;
              }),
            );
          },
        ),

        sweepExpiredOrders: Effect.fn("OrderRepository.sweepExpiredOrders")(
          function* ({ now }: { readonly now: number }) {
            const expiredBefore =
              now - Domain.ShopLimits.orderRetentionDays * 86_400_000;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                /**
                 * One term, and it is the order's own date rather than
                 * anything about its state or its runs
                 * ({@link Domain.ShopLimits.orderRetentionDays} carries the
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
                  limit ${Domain.ShopLimits.sweepBatch}
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
                     * The runs go with the order, live ones included. Nothing
                     * is flagged on the way out, unlike
                     * `WorkflowRunRepository.markOrderDeleted`: that flag
                     * exists so a member reads why their work stopped, and a
                     * row deleted by the next statement of the same
                     * transaction is read by nobody.
                     */
                    const deletedRuns =
                      yield* sql`delete from WorkflowRun where ${sql.in("orderId", chunk)} returning id`;
                    runs += deletedRuns.length;
                    // `OrderLineItem` cascades; `WorkflowRunStep` cascaded
                    // with the runs above.
                    yield* sql`delete from ShopOrder where ${sql.in("id", chunk)}`;
                  }
                }
                /**
                 * Runs whose order is already gone: `markOrderDeleted` flags
                 * them rather than deleting so a member sees why their work
                 * stopped, and they age out here on their own `updatedAt`,
                 * the order's being unavailable. The same window, counted
                 * from a different clock on purpose — the order they belong
                 * to no longer has one.
                 */
                const orphaned = yield* sql`
                  delete from WorkflowRun
                  where id in (
                    select id from WorkflowRun
                    where updatedAt < ${expiredBefore}
                      and orderId not in (select id from ShopOrder)
                    limit ${Domain.ShopLimits.sweepBatch}
                  )
                  returning id
                `;
                yield* sql`update ShopUsage set lastSweepAt = ${now} where id = 1`;
                return { orders: ids.length, runs: runs + orphaned.length };
              }),
            );
          },
        ),
      });
    }),
  );
}

import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Match, Option, Schema } from "effect";
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
   * only when the write actually happened. The seam for run
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
  membersHighWater: Schema.Number,
  lastReconciledOrders: Schema.NullOr(Schema.Number),
  lastReconciledMembers: Schema.NullOr(Schema.Number),
  pendingUsageEvents: Schema.Number,
  deadUsageEvents: Schema.Number,
  pendingOrderUnits: Schema.Number,
  pendingMemberUnits: Schema.Number,
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
  membersHighWater: Schema.Number,
});

/**
 * The order's one billing idempotency key, permanent at Shopify and capped at
 * 64 characters. Derived from the order id alone, never from a clock: an order
 * is billed once and a replayed flush must not bill it again. A Shopify order
 * GID is around 30 characters, so this stays well inside the cap.
 *
 * One of two key shapes in the outbox; the other is {@link seatKey}.
 */
const countKey = (orderId: string) => `${orderId}#count`;

/**
 * A seat event's idempotency key: unique per cycle and per high-water mark
 * ({@link Domain.seatEventValue}), so a replayed `recordRoster` with the same
 * size is a no-op at the row level even if the mark comparison were raced.
 * `seat#` plus two integers stays far inside the 64-character cap. Built by
 * `recordRoster` and `setBillingCycle`.
 */
const seatKey = (cycleStartAt: number, mark: number) =>
  `seat#${String(cycleStartAt)}#${String(mark)}`;

/** One usage-event row waiting in the outbox; `value` is {@link Domain.UsageEvent}'s. `orderId` is null on a seat event. */
export const UsageEventRow = Schema.Struct({
  idempotencyKey: Schema.String,
  eventHandle: Schema.String,
  orderId: Schema.NullOr(Schema.String),
  value: Domain.UsageEvent.fields.value,
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
 * `Run_orderId_idx`. A closed run still holds its item
 * (`Domain.RunStatus`): it is in `ANY_RUN` and `RUN_FOR_ITEM`, so an item
 * whose run closed is neither "No workflow" nor "Choose a workflow", and it
 * is in no status fragment but `to_make`'s, which asks for no open and no
 * done run.
 */
const OPEN = "fulfillmentStatus <> 'FULFILLED' and cancelledAt is null";
/**
 * {@link OPEN} on an aliased `ShopOrder`, for statements that also read
 * `Run`: qualified so the predicate cannot bind to a run column of
 * the same name (both tables carry a `closedAt`).
 */
const openAs = (alias: string) =>
  `${alias}.fulfillmentStatus <> 'FULFILLED' and ${alias}.cancelledAt is null`;
const ANY_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id`;
const OPEN_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.status = 'active'`;
const DONE_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.status = 'done'`;
/** The `blocked` {@link Domain.OrderNeed}: an open run a worker or the merchant blocked. */
const BLOCKED_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.status = 'active'
    and r.blockedAt is not null`;
/**
 * `Domain.ambiguousItems` in SQL: an item with units still to make, two or
 * more workflows matched at the last reconcile, and no run of any status.
 * Change workflow away and back reads correctly with no further reconcile —
 * which is the point of deriving the need rather than storing it.
 *
 * `json_array_length` is SQLite's JSON1, compiled into Durable Object SQLite;
 * `order-repository.test.ts` is the proof.
 */
const RUN_FOR_ITEM = `select 1 from Run r
  where r.lineItemId = li.id`;
const AMBIGUOUS_ITEM = `select 1 from OrderLineItem li
  where li.orderId = ShopOrder.id and li.currentQuantity > 0
    and json_array_length(li.matchedWorkflowIds) >= 2
    and not exists (${RUN_FOR_ITEM})`;
/**
 * The `choose_workflow` {@link Domain.OrderNeed} as one predicate: an order
 * is only choosing when it can start runs, so an unpaid order with an
 * ambiguous item is *not* choosing. `NO_WORKFLOW` excludes this whole term.
 */
const CHOOSING = `fullyPaid = 1 and exists (${AMBIGUOUS_ITEM})`;
/**
 * The `no_workflow` {@link Domain.OrderNeed}: paid, no run of any status, and no item
 * waiting on a choice. `OPEN` is the caller's, as for every need.
 */
const NO_WORKFLOW = `fullyPaid = 1 and not exists (${ANY_RUN}) and not (${CHOOSING})`;

/**
 * Each counted button's predicate over the `facts` rows of the count
 * statement in `listOrders`: `statusFilter` and `needFilter` restated over
 * per-order facts instead of correlated subqueries, and moving with them.
 * `OPEN` is the statement's own `where`.
 */
const COUNT_FACT = {
  to_make: "openRuns = 0 and doneRuns = 0",
  making: "openRuns > 0",
  made: "doneRuns > 0 and openRuns = 0",
  no_workflow:
    "paid and openRuns = 0 and doneRuns = 0 and closedRuns = 0 and not choosing",
  choose_workflow: "choosing",
  team: "team",
  blocked: "blockedRuns > 0",
} as const satisfies Record<keyof Domain.OrderCounts, string>;

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
     * The billing meter, and the whole of it: an order is worth one unit the
     * first time Baton creates a run for it, and nothing ever gives that back.
     *
     * Called by `RunRepository.insertRun` — the single door through
     * which a run is created — so the predicate is "Baton started work on this
     * order", not "the order looks billable". That is deliberately narrower
     * than paid: a paid order no workflow matches costs the merchant nothing,
     * and an order Baton only ever displayed was never work it carried.
     *
     * `countedAt is null` in the `update` is the entire idempotency story. A
     * second run on the same order changes no row, so no counter moves and no
     * event is queued; the same holds for a reconcile that re-creates runs
     * after a cancellation. The `#count` key is permanent at Shopify, so even
     * a queue that slipped through would bill once.
     *
     * Runs inside the caller's transaction — Durable Object SQLite refuses
     * nested ones — so the marker, the counter and the outbox row cannot come
     * apart. `now` is the caller's clock, and it dates the usage event, which
     * Shopify accepts only inside the merchant's open period.
     *
     * Resolves the cycle before it increments, exactly as `upsertOrder` does,
     * so a run started by hand on a quiet shop past its cycle end counts into
     * the new period rather than the outgoing one. On the reconcile path the
     * upsert has already rolled it and this is a re-read. A missing
     * `ShopUsage` row is a defect in the schema, not a billing condition, and
     * is a die rather than an error the run paths would have to carry.
     */
    readonly countOrder: (
      orderId: string,
      now: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
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
     * `status` filters by `Domain.OrdersStatus`, each SQL fragment restating
     * a branch of `productionState`; `need` filters by `Domain.OrderNeed`,
     * each fragment restating an element of `orderNeeds`. Both must move with
     * the function they restate. The open statuses, every need and the
     * `counts` aggregate spell out
     * `fulfillmentStatus <> 'FULFILLED' and cancelledAt is null` verbatim so
     * SQLite can prove they are served by the partial `ShopOrder_open_idx`,
     * which is what keeps a count from reading the shop's whole history.
     *
     * `counts` follows `Domain.OrderCounts`: a count is what pressing that
     * button would show, given every other filter. The two rows cross — the
     * status counts are narrowed by `need`, `team` and `q` but not `status`,
     * and the need counts by `status`, `team` and `q` but not `need`.
     */
    readonly listOrders: (input: {
      readonly limit: number;
      readonly cursor: string | null;
      /** `null` is no search; otherwise a prefix match on `ShopOrder.name` (`Domain.ListOrdersInput.q`). */
      readonly q: Domain.OrderSearch | null;
      /** `null` is open work (`Domain.ListOrdersInput.status`). */
      readonly status: Domain.OrdersStatus | null;
      /** `null` is any need (`Domain.ListOrdersInput.need`). */
      readonly need: Domain.OrderNeed | null;
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
     * A changed `cycleStartAt` is a new cycle: the order count is recounted
     * from rows and the seat mark is reset to the roster
     * (`input.memberCount`), which is queued as the cycle's first seat event,
     * dated `cycleStartAt`. The seat meter at Shopify starts every cycle at
     * zero and prices the whole roster by the plan's tiers
     * (`Domain.ActiveSubscription`), so the value is the roster, not the
     * overage.
     *
     * An unchanged start writes the columns and leaves the count alone, which
     * is what makes it safe to call on every revalidation. It still raises the
     * seat mark to the roster when the roster is past it, by
     * {@link Domain.seatEventValue}: that covers an add whose
     * `recordRoster` failed (it is best-effort), and a cycle the counting path
     * rolled forward on its own, which starts with no mark.
     */
    readonly setBillingCycle: (
      input: Domain.BillingCycleInput,
    ) => Effect.Effect<void, SqlError.SqlError | OrderRepositoryError>;
    /**
     * Raises the cycle's seat mark to `size` when past it and queues the rise
     * as one seat event ({@link Domain.seatEventValue} is the rule); answers
     * the units queued, `0` when not past the mark. A removal is never
     * reported, so nothing lowers the mark within a cycle.
     *
     * Resolves the cycle first, as `countOrder` does: a shop with no cycle
     * opens the provisional one so the key has a cycle to name, and a cycle
     * past its end rolls forward and starts with no mark.
     */
    readonly recordRoster: (
      input: Domain.RecordRosterInput,
      now: number,
    ) => Effect.Effect<number, SqlError.SqlError | OrderRepositoryError>;
    /** Stores Shopify's meter readings and returns the counters beside them, so the caller can log the divergence. */
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
     * queued that has not gone out yet. This is the one path that removes a
     * stored order outside retention, and the only one that may give a count
     * back. Runs go with the order because a fixture row being replaced has no
     * trail worth keeping, and a run outliving its order carries its own
     * snapshot of the order name and item, so it would sit on a queue as a card
     * nothing can clear. Seat events have a null `orderId`, so the `like` on
     * `orderId` never touches them. Usage: the meter counts orders Baton started work on
     * and never reverses ({@link Domain.ShopUsage}), so a reseed would climb by
     * a fixture's worth every time until the quota banner appeared over a shop
     * holding one seed's orders. Only the seed knows the whole set is being
     * replaced, so only it may subtract — and it subtracts rather than zeroes
     * so synced orders keep their share. It subtracts by `countedAt`, the
     * per-order marker the meter writes, so the subtraction matches exactly
     * what was added however the order later changed. The queued events go with
     * the rows because a fixture must not bill a development store; events
     * already accepted by Shopify are gone from the table and are the seed's
     * own to answer for. `ordersLimitedAt` is cleared when the count given
     * back leaves the cycle under {@link Domain.cycleAtOrderCeiling}: the
     * orders the ceiling refused were the seed's own, and the reseed replaces
     * them, so the banner has nothing left to say. This is the one clearing
     * outside a cycle roll.
     */
    readonly deleteSeedOrders: () => Effect.Effect<void, SqlError.SqlError>;
    /**
     * One retention pass: at most `ShopLimits.sweepBatch` orders older than
     * `ShopLimits.orderRetentionDays` — open or closed, with runs or without —
     * plus a batch of runs whose order is no longer stored. Deliberately
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
         lineItemsTruncated, syncedAt, syncSource`,
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
              quantity, currentQuantity, productTags, matchedWorkflowIds,
              properties, requiresShipping
            ) values (
              ${item.id}, ${item.orderId}, ${item.productId}, ${item.variantId},
              ${item.title}, ${item.variantTitle}, ${item.sku},
              ${item.quantity}, ${item.currentQuantity},
              ${json(item.productTags)}, ${json(item.matchedWorkflowIds)},
              ${json(item.properties)}, ${bit(item.requiresShipping)}
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
              productTags = excluded.productTags,
              properties = excluded.properties,
              requiresShipping = excluded.requiresShipping
          `,
          { discard: true },
        );

      const decodeCycle = decode(
        Schema.Array(ShopUsageCycle),
        "Invalid ShopUsage row",
      );

      const readCycle = () =>
        sql`select shopGid, cycleStartAt, cycleEndAt, ordersThisCycle, membersHighWater from ShopUsage where id = 1`.pipe(
          Effect.flatMap(decodeCycle),
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
        const [stored] = yield* readCycle();
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
            set cycleStartAt = ${cycleStartAt}, ordersThisCycle = 0, ordersLimitedAt = null,
                membersHighWater = 0
            where id = 1
          `;
          return {
            shopGid: stored.shopGid,
            cycleStartAt,
            ordersThisCycle: 0,
            membersHighWater: 0,
          };
        }
        if (stored.cycleEndAt !== null && now >= stored.cycleEndAt) {
          // Recounted from the rows, as `setBillingCycle` does, so both ways a
          // cycle can start state one rule: the count is the orders counted
          // at or after the start. The seat mark starts at zero: the object
          // cannot count the roster, so the next `recordRoster` or
          // `setBillingCycle` sends the whole of it into the new cycle.
          const count = yield* countedSince(stored.cycleEndAt);
          yield* sql`
            update ShopUsage
            set cycleStartAt = cycleEndAt, cycleEndAt = null,
                ordersThisCycle = ${count}, ordersLimitedAt = null,
                membersHighWater = 0
            where id = 1
          `;
          return {
            shopGid: stored.shopGid,
            cycleStartAt: stored.cycleEndAt,
            ordersThisCycle: count,
            membersHighWater: 0,
          };
        }
        return { ...stored, cycleStartAt: stored.cycleStartAt };
      });

      /** Rule and reasoning on {@link OrderRepository.countOrder}. */
      const countOrder = Effect.fn("OrderRepository.countOrder")(function* (
        orderId: string,
        now: number,
      ) {
        // The cycle is resolved before the marker is written: a roll-forward
        // recounts from `countedAt`, so a marker written first would be
        // counted by the recount and again by the increment below.
        yield* currentCycle(now).pipe(
          Effect.catchTag("OrderRepositoryError", (error) => Effect.die(error)),
        );
        const counted =
          yield* sql`update ShopOrder set countedAt = ${now} where id = ${orderId} and countedAt is null returning id`;
        if (counted.length === 0) return;
        yield* sql`update ShopUsage set ordersThisCycle = ordersThisCycle + 1 where id = 1`;
        yield* queueUsageEvent({
          idempotencyKey: countKey(orderId),
          eventHandle: Domain.USAGE_METER_ORDER,
          orderId,
          value: 1,
          occurredAt: now,
        });
      });

      /**
       * Raises the seat mark to `size` inside the caller's transaction and
       * queues the rise; {@link Domain.seatEventValue} is the rule.
       */
      const raiseSeatMark = Effect.fn("OrderRepository.raiseSeatMark")(
        function* (input: {
          readonly cycleStartAt: number;
          readonly highWater: number;
          readonly size: number;
          readonly occurredAt: number;
        }) {
          const value = Domain.seatEventValue(input.size, input.highWater);
          if (value === 0) return 0;
          yield* sql`update ShopUsage set membersHighWater = ${input.size} where id = 1`;
          yield* queueUsageEvent({
            idempotencyKey: seatKey(input.cycleStartAt, input.size),
            eventHandle: Domain.USAGE_METER_MEMBER,
            orderId: null,
            value,
            occurredAt: input.occurredAt,
          });
          return value;
        },
      );

      /**
       * `or ignore`, so re-queuing a key Shopify has already been told about is
       * a no-op rather than a second charge. The row carries no shop: the shop
       * is the object, and `ShopUsage.shopGid` is read once at flush time.
       *
       * A seeded order queues nothing ({@link Domain.orderIsSeeded}). It is
       * refused here rather than at the call sites because this is the only
       * door into the outbox, and a fixture that reaches Shopify's meter costs
       * real money under a permanent idempotency key. A seat event has no
       * order and is never a fixture's.
       */
      const queueUsageEvent = (input: {
        readonly idempotencyKey: string;
        readonly eventHandle: string;
        readonly orderId: string | null;
        readonly value: number;
        readonly occurredAt: number;
      }) =>
        input.orderId !== null && Domain.orderIsSeeded(input.orderId)
          ? Effect.void
          : sql`
              insert or ignore into UsageEvent (idempotencyKey, eventHandle, orderId, value, occurredAt)
              values (${input.idempotencyKey}, ${input.eventHandle}, ${input.orderId}, ${input.value}, ${input.occurredAt})
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
                   openRunsLimitedAt, lastSweepAt, membersHighWater,
                   lastReconciledOrders, lastReconciledMembers,
                   (select count(*) from UsageEvent
                    where cycleStartAt is null or occurredAt >= cycleStartAt) as pendingUsageEvents,
                   (select count(*) from UsageEvent
                    where cycleStartAt is not null and occurredAt < cycleStartAt) as deadUsageEvents,
                   (select coalesce(sum(value), 0) from UsageEvent
                    where eventHandle = ${Domain.USAGE_METER_ORDER}
                      and (cycleStartAt is null or occurredAt >= cycleStartAt)) as pendingOrderUnits,
                   (select coalesce(sum(value), 0) from UsageEvent
                    where eventHandle = ${Domain.USAGE_METER_MEMBER}
                      and (cycleStartAt is null or occurredAt >= cycleStartAt)) as pendingMemberUnits
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
                // an update, and `fresh` is what the bulk stream reports and
                // what the ceiling below gates on.
                const existing =
                  yield* sql`select 1 from ShopOrder where id = ${order.id} limit 1`;
                const fresh = existing.length === 0;
                // Resolved before the insert because the ceiling is a fact
                // about the cycle this write lands in, after any roll-forward.
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
                  fullyPaid, note,
                  lineItemsTruncated, syncedAt, syncSource
                ) values (
                  ${order.id}, ${order.legacyId}, ${order.name},
                  ${order.processedAt}, ${order.updatedAt},
                  ${order.cancelledAt}, ${order.closedAt},
                  ${order.financialStatus}, ${order.fulfillmentStatus},
                  ${bit(order.fullyPaid)}, ${order.note},
                  ${bit(order.lineItemsTruncated)}, ${order.syncedAt},
                  ${order.syncSource}
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
                if (afterWrite !== undefined) yield* afterWrite;
                return { written: true, fresh, refused: false };
              }),
            )
            .pipe(Effect.withSpan("OrderRepository.upsertOrder")),

        countOrder,

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
          status,
          need,
          team,
          teams,
        }: {
          readonly limit: number;
          readonly cursor: string | null;
          readonly q: Domain.OrderSearch | null;
          readonly status: Domain.OrdersStatus | null;
          readonly need: Domain.OrderNeed | null;
          readonly team: Domain.TeamId | null;
          readonly teams: readonly Domain.TeamRoster[];
        }) {
          /**
           * `Domain.OrderRow.attention` in SQL, bound to the roster the
           * caller read from D1: an open task is unassigned when its team id
           * is null or not in the roster, and a ready task (`readyWhere`, the
           * one definition the member's run list also runs on) on a team with no
           * members is stuck on nobody's list.
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
          const attentionTask = sql`exists (
            select 1 from RunTask s
            where s.runId = r.id and s.doneAt is null
              and ${sql.or([unassigned, emptyReady])}
          )`;
          const attentionRun = sql`exists (
            select 1 from Run r
            where r.orderId = ShopOrder.id and r.status = 'active'
              and ${attentionTask}
          )`;
          /**
           * The waiting-on column's membership test as a `where`, so a
           * filtered page is exactly the rows whose cell names the team —
           * nothing to explain about why a row matched. It restates
           * `Domain.OrderRow.waitingOn` term for term, the open-order gate
           * included, and must move with `waitingRows` below. Aliased `wr`
           * for the same reason as `waitingRows`: `readyWhere` binds `r`.
           */
          const teamFilter =
            team === null
              ? sql.literal("1 = 1")
              : sql`${sql.literal(OPEN)} and exists (
                  select 1 from Run wr
                  join RunTask s on s.runId = wr.id
                  where wr.orderId = ShopOrder.id
                    and wr.status = 'active'
                    and wr.blockedAt is null
                    and s.teamId = ${team}
                    and ${sql.literal(ReadyWhere.readyWhere("s"))}
                )`;
          /**
           * The open statuses partition the open orders by run state alone:
           * no open and no done run is `to_make`, any open run is `making`,
           * only finished runs is `made`, as `Domain.productionState` says.
           */
          const statusFilter = Match.value(status).pipe(
            Match.when("to_make", () =>
              sql.and([
                OPEN,
                `not exists (${OPEN_RUN})`,
                `not exists (${DONE_RUN})`,
              ]),
            ),
            Match.when("making", () => sql.and([OPEN, `exists (${OPEN_RUN})`])),
            Match.when("made", () =>
              sql.and([
                OPEN,
                `exists (${DONE_RUN})`,
                `not exists (${OPEN_RUN})`,
              ]),
            ),
            Match.when("fulfilled", () =>
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
             * the negation of the `fulfilled` and `cancelled` branches above,
             * spelled as `OPEN` so the partial index serves it. `"all"` is the
             * only filter that reads a shop's whole history
             * ({@link Domain.OrdersStatus}).
             */
            Match.when(null, () => sql.literal(OPEN)),
            Match.when("all", () => sql.literal("1 = 1")),
            Match.exhaustive,
          );
          /**
           * Every need carries `OPEN` (`Domain.OrderNeed`: a need is only
           * ever on an open order), which is what makes a need under status
           * `"all"` narrow to open orders.
           */
          const needFilter = Match.value(need).pipe(
            Match.when(null, () => sql.literal("1 = 1")),
            Match.when("no_workflow", () => sql.and([OPEN, NO_WORKFLOW])),
            Match.when("choose_workflow", () => sql.and([OPEN, CHOOSING])),
            Match.when("team", () => sql.and([OPEN, attentionRun])),
            Match.when("blocked", () =>
              sql.and([OPEN, `exists (${BLOCKED_RUN})`]),
            ),
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
              where ${sql.and([keyset, searchFilter, statusFilter, needFilter, teamFilter])}
              order by processedAt desc, id desc
              limit ${limit + 1}
            `,
          );
          const orders = page.slice(0, limit);
          const ids = orders.map(({ id }) => id);
          /**
           * Two aggregates keyed by the page's ids rather than a join: the
           * decoder for `ShopOrder` wants exactly its columns, and `Run`
           * lives in the same Durable Object SQLite but belongs to
           * `RunRepository`, so this read touches it for counts only.
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
                    sum(status = 'active') as open,
                    sum(status = 'done') as done,
                    sum(blockedAt is not null and status = 'active') as blocked,
                    sum(status = 'closed') as closed
                  from Run
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
                    and li.currentQuantity > 0
                    and json_array_length(li.matchedWorkflowIds) >= 2
                    and not exists (${sql.literal(RUN_FOR_ITEM)})
                  group by li.orderId
                `.values;
          /**
           * `Domain.OrderRow.waitingOn`, whose JSDoc carries the rules: a
           * fourth per-page read rather than a term on the page query, for
           * the reason the comment above gives for the other aggregates — the
           * `ShopOrder` decoder wants exactly its own columns, and this one
           * returns several rows per order anyway. Gated on `liveIds` because
           * a task pointing at a deleted team is `attention`, and the outer
           * run is aliased `wr`: `readyWhere` binds `r` for the task's own
           * run inside its subqueries (see its JSDoc). `teamFilter` above
           * restates this read as a `where` and must move with it.
           */
          const waitingRows =
            ids.length === 0 || liveIds.length === 0
              ? []
              : yield* sql`
                  select distinct wr.orderId, s.teamId
                  from RunTask s
                  join Run wr on wr.id = s.runId
                  join ShopOrder o on o.id = wr.orderId
                  where ${sql.in("wr.orderId", ids)}
                    and ${sql.literal(openAs("o"))}
                    and wr.status = 'active'
                    and wr.blockedAt is null
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
                blocked: Number(row[3] ?? 0),
                closed: Number(row[4] ?? 0),
              } satisfies Domain.RunCounts,
            ]),
          );
          /**
           * `Domain.OrderCounts` in one statement over the open orders the
           * search and team leave. `run_summary` is the per-page `runRows`
           * aggregate hoisted over every open order, one grouped read of
           * `Run` in place of a correlated `exists` per fragment;
           * `CHOOSING` and `attentionRun` stay correlated, walking line items
           * and tasks. `facts` is materialised so each correlated term runs
           * once per order however many sums read it. The sums restate
           * `statusFilter` and `needFilter` over those facts and must move
           * with them.
           *
           * `run_summary` is a `cross join`, which SQLite reads as "keep this
           * table order" (https://www.sqlite.org/optoverview.html#crossjoin):
           * with no `sqlite_stat1` the planner otherwise drives from
           * `Run_status_idx` and reads every run the retention window
           * keeps, closed orders included. Driven from `ShopOrder_open_idx`
           * through `Run_orderId_idx`, the read is the open orders'
           * runs only. The `ShopOrder` columns are qualified for the reason
           * on {@link openAs}.
           *
           * A status sum is crossed with the selected need and a need sum
           * with the selected status, never with its own row. Under
           * `fulfilled` and `cancelled` no open order has the status, so the
           * need sums are zero while the status sums still answer "what if I
           * pressed Making".
           */
          const statusFact = Match.value(status).pipe(
            Match.when("to_make", () => COUNT_FACT.to_make),
            Match.when("making", () => COUNT_FACT.making),
            Match.when("made", () => COUNT_FACT.made),
            Match.when(null, () => "1"),
            Match.when("all", () => "1"),
            Match.when("fulfilled", () => "0"),
            Match.when("cancelled", () => "0"),
            Match.exhaustive,
          );
          const needFact = need === null ? "1" : COUNT_FACT[need];
          const [countRow] = yield* sql`
              with run_summary as (
                select r.orderId,
                  sum(r.status = 'active') as openRuns,
                  sum(r.status = 'done') as doneRuns,
                  sum(r.status = 'active' and r.blockedAt is not null) as blockedRuns,
                  sum(r.status = 'closed') as closedRuns
                from ShopOrder o
                cross join Run r on r.orderId = o.id
                where ${sql.literal(openAs("o"))}
                group by r.orderId
              ),
              facts as materialized (
                select
                  fullyPaid = 1 as paid,
                  coalesce(rs.openRuns, 0) as openRuns,
                  coalesce(rs.doneRuns, 0) as doneRuns,
                  coalesce(rs.blockedRuns, 0) as blockedRuns,
                  coalesce(rs.closedRuns, 0) as closedRuns,
                  (${sql.literal(CHOOSING)}) as choosing,
                  ${attentionRun} as team
                from ShopOrder
                left join run_summary rs on rs.orderId = ShopOrder.id
                where ${sql.and([OPEN, searchFilter, teamFilter])}
              )
              select
                sum(${sql.literal(COUNT_FACT.to_make)} and ${sql.literal(needFact)}),
                sum(${sql.literal(COUNT_FACT.making)} and ${sql.literal(needFact)}),
                sum(${sql.literal(COUNT_FACT.made)} and ${sql.literal(needFact)}),
                sum(${sql.literal(COUNT_FACT.no_workflow)} and ${sql.literal(statusFact)}),
                sum(${sql.literal(COUNT_FACT.choose_workflow)} and ${sql.literal(statusFact)}),
                sum(${sql.literal(COUNT_FACT.team)} and ${sql.literal(statusFact)}),
                sum(${sql.literal(COUNT_FACT.blocked)} and ${sql.literal(statusFact)})
              from facts
            `.values;
          const counts = {
            to_make: Number(countRow?.[0] ?? 0),
            making: Number(countRow?.[1] ?? 0),
            made: Number(countRow?.[2] ?? 0),
            no_workflow: Number(countRow?.[3] ?? 0),
            choose_workflow: Number(countRow?.[4] ?? 0),
            team: Number(countRow?.[5] ?? 0),
            blocked: Number(countRow?.[6] ?? 0),
          } satisfies Domain.OrderCounts;
          const last = orders.at(-1);
          return {
            orders: orders.map((order) => ({
              order,
              itemUnits: units.get(order.id) ?? 0,
              runs: runs.get(order.id) ?? {
                open: 0,
                done: 0,
                blocked: 0,
                closed: 0,
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
            counts,
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
            const now = yield* Clock.currentTimeMillis;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const [stored] = yield* readCycle();
                const changed = stored?.cycleStartAt !== input.cycleStartAt;
                const unaddressed = stored?.shopGid === null;
                yield* sql`
                  update ShopUsage
                  set shopGid = ${input.shopGid},
                      cycleStartAt = ${input.cycleStartAt},
                      cycleEndAt = ${input.cycleEndAt}
                  where id = 1
                `;
                if (!changed) {
                  yield* raiseSeatMark({
                    cycleStartAt: input.cycleStartAt,
                    highWater: stored?.membersHighWater ?? 0,
                    size: input.memberCount,
                    occurredAt: now,
                  });
                  return;
                }
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
                /**
                 * The new cycle's seat mark is the roster, sent whole. Any
                 * seat event still queued and dated inside the new cycle came
                 * from the outgoing mark (a provisional cycle, or one the
                 * counting path rolled forward) and is superseded by this one;
                 * sending both would bill those seats twice.
                 */
                yield* sql`
                  delete from UsageEvent
                  where eventHandle = ${Domain.USAGE_METER_MEMBER}
                    and occurredAt >= ${input.cycleStartAt}
                `;
                yield* sql`update ShopUsage set membersHighWater = 0 where id = 1`;
                yield* raiseSeatMark({
                  cycleStartAt: input.cycleStartAt,
                  highWater: 0,
                  size: input.memberCount,
                  occurredAt: input.cycleStartAt,
                });
              }),
            );
          },
        ),

        recordRoster: Effect.fn("OrderRepository.recordRoster")(function* (
          input: Domain.RecordRosterInput,
          now: number,
        ) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const cycle = yield* currentCycle(now);
              return yield* raiseSeatMark({
                cycleStartAt: cycle.cycleStartAt,
                highWater: cycle.membersHighWater,
                size: input.size,
                occurredAt: now,
              });
            }),
          );
        }),

        reconcileUsage: Effect.fn("OrderRepository.reconcileUsage")(function* (
          input: Domain.ReconcileUsageInput,
        ) {
          yield* sql`
            update ShopUsage
            set lastReconciledOrders = ${input.orders},
                lastReconciledMembers = ${input.members}
            where id = 1
          `;
          return yield* readUsage();
        }),

        markOrdersLimited,

        flushUsageEvents: Effect.fn("OrderRepository.flushUsageEvents")(
          function* (shop: string) {
            const appEvents = yield* ShopifyAppEvents;
            const [usage] = yield* readCycle();
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
                select idempotencyKey, eventHandle, orderId, value, occurredAt, attempts
                from UsageEvent
                where occurredAt >= ${cycleStartAt}
                order by occurredAt, rowid
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
                  eventHandle: row.eventHandle,
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
                const [after] =
                  yield* sql`select ordersThisCycle from ShopUsage where id = 1`
                    .values;
                if (!Domain.cycleAtOrderCeiling(Number(after?.[0] ?? 0)))
                  yield* sql`update ShopUsage set ordersLimitedAt = null where id = 1`;
                yield* sql`delete from UsageEvent where orderId like ${seedPrefix}`;
                yield* sql`delete from Run where orderId like ${seedPrefix}`;
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
                /**
                 * Runs whose order is no longer stored. No live path leaves
                 * one — every delete above takes the runs with it, as does
                 * `deleteSeedOrders` — so this is a floor, not a workflow:
                 * one indexed statement per sweep that keeps a row nothing
                 * can render from sitting on a member's queue forever. It
                 * ages on the run's own `updatedAt`, counted from a different
                 * clock on purpose, because the order it belongs to no longer
                 * has one.
                 */
                const orphaned = yield* sql`
                  delete from Run
                  where id in (
                    select id from Run
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

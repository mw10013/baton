import type { SqlError } from "effect/unstable/sql";

import { Context, Effect, Layer, Match, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";
import * as ReadyWhere from "@/lib/readyWhere";

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
  monthKey: Schema.String,
  ordersThisMonth: Schema.Number,
  liveRunsLimitedAt: Schema.NullOr(Schema.Number),
  lastSweepAt: Schema.NullOr(Schema.Number),
});
export type ShopUsageRow = typeof ShopUsageRow.Type;

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
     * landed mid-stream — leaves the stored row alone. `returning id` is what
     * reports that: SQLite emits a row only for an insert or an update that
     * actually ran, so an empty result means the write lost the race, and the
     * line items are then left alone too. Writing them anyway would replace a
     * fresh set with a stale one under a row that correctly refused to move.
     *
     * When the caller saw the complete line-item set (`lineItemsComplete`), the
     * set is replaced wholesale, so a removed line disappears. When the fetch
     * was truncated it merges instead — deleting on a partial view would drop
     * lines that exist but were never seen.
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
         * against the plan's monthly quota — a resync of a stored order is not
         * a second order — and what the bulk stream reports as `ordersInserted`.
         */
        readonly fresh: boolean;
      },
      SqlError.SqlError | E
    >;
    readonly deleteOrder: (
      orderId: string,
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
     * `state` filters by `Domain.productionState` and `paid` by `fullyPaid`;
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
      readonly state: Domain.ProductionState | null;
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
     * Claims the singleton before the workflow instance exists, so a
     * `runWorkflow` that creates the instance and then throws leaves a claim to
     * verify rather than a running sync with an enabled button in front of it.
     */
    readonly reserveSync: (input: {
      readonly workflowId: string;
      readonly startedAt: number;
      readonly windowStart: number;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Releases the reservation and records the window, but only for the run
     * that holds it: `startedAt` identifies the run, so a completion callback
     * arriving after its run was superseded cannot clear the newer claim.
     */
    readonly completeSync: (input: {
      readonly startedAt: number;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    readonly failSync: (input: {
      readonly startedAt: number;
      readonly error: string;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    readonly clearSync: () => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Records a refusal that happened *before* any reservation existed — the
     * storage guard in `syncOrders`. Deliberately not {@link failSync}, which
     * releases a claim identified by its `startedAt` and would match nothing
     * here.
     */
    readonly setSyncError: (input: {
      readonly error: string;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /** The stored counters; `databaseSize` is the object's to add (`ShopAgent.getUsage`). */
    readonly getUsage: () => Effect.Effect<
      ShopUsageRow,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * One retention pass: at most `ShopLimits.sweepBatch` closed orders past
     * `ShopLimits.orderRetentionDays`, with their runs, plus a batch of runs
     * orphaned by an `orders/delete`. Deliberately batched and deliberately
     * carried by a request that was already doing heavy work — there is no
     * alarm and no cron — so a shop with years of history drains over several
     * passes instead of one request paying for all of it.
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
         closedAt, financialStatus, fulfillmentStatus, fullyPaid, tags, note,
         customAttributes, lineItemsComplete, lineItemsTruncated, syncedAt,
         syncSource`,
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
            yield* sql`
              select workflowId, startedAt, lastFullSyncAt,
                     lastFullSyncWindowStart, lastError
              from SyncState where id = 1
            `,
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

      /**
       * The monthly quota meter, inside the upsert's transaction so a counted
       * order and its count cannot come apart.
       *
       * Four conditions, each load-bearing. **Fresh**, because a webhook
       * storm on one order is one order. **Paid**, because an abandoned
       * unpaid order is not work the merchant asked Baton to carry, and
       * `Domain.canStartRuns` already refuses to start runs on it. **Not
       * cancelled**, for the same reason — and a later cancel does *not* give
       * the count back, since the work was already carried. **Placed this
       * month**, which is what exempts the 30-day backfill on install: a shop
       * signing up on the 28th must not burn its first month's quota on
       * orders it placed before it had the app.
       *
       * The rollover rides the counting path rather than a clock: a quiet
       * shop's stored `monthKey` may lag by months, and the only moment that
       * can matter is the first counted order of a new month — which is
       * exactly here. Readers roll forward in the value they return
       * (`ShopAgent.getUsage`) so a stale row never shows last month's count.
       */
      const countTowardQuota = (order: Domain.ShopOrder, fresh: boolean) => {
        if (
          !fresh ||
          !order.fullyPaid ||
          order.cancelledAt !== null ||
          order.processedAt < Domain.monthStartOf(order.syncedAt)
        )
          return Effect.void;
        const monthKey = Domain.monthKeyOf(order.syncedAt);
        return Effect.andThen(
          sql`
            update ShopUsage
            set monthKey = ${monthKey}, ordersThisMonth = 0
            where monthKey <> ${monthKey}
          `,
          sql`
            update ShopUsage
            set ordersThisMonth = ordersThisMonth + 1
            where id = 1
          `,
        );
      };

      const decodeUsage = decode(
        Schema.Array(ShopUsageRow),
        "Invalid ShopUsage row",
      );

      const readUsage = Effect.fn("OrderRepository.getUsage")(function* () {
        const [usage] = yield* decodeUsage(
          yield* sql`
            select monthKey, ordersThisMonth, liveRunsLimitedAt, lastSweepAt
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
                // an update, and the quota counts orders, not writes.
                const existing =
                  yield* sql`select 1 from ShopOrder where id = ${order.id} limit 1`;
                const fresh = existing.length === 0;
                const written = yield* sql`
                insert into ShopOrder (
                  id, legacyId, name, processedAt, updatedAt,
                  cancelledAt, closedAt, financialStatus, fulfillmentStatus,
                  fullyPaid, tags, note, customAttributes, lineItemsComplete,
                  lineItemsTruncated, syncedAt, syncSource
                ) values (
                  ${order.id}, ${order.legacyId}, ${order.name},
                  ${order.processedAt}, ${order.updatedAt},
                  ${order.cancelledAt}, ${order.closedAt},
                  ${order.financialStatus}, ${order.fulfillmentStatus},
                  ${bit(order.fullyPaid)}, ${json(order.tags)}, ${order.note},
                  ${json(order.customAttributes)},
                  ${bit(order.lineItemsComplete)},
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
                  tags = excluded.tags,
                  note = excluded.note,
                  customAttributes = excluded.customAttributes,
                  lineItemsComplete = excluded.lineItemsComplete,
                  lineItemsTruncated = excluded.lineItemsTruncated,
                  syncedAt = excluded.syncedAt,
                  syncSource = excluded.syncSource
                where excluded.updatedAt >= ShopOrder.updatedAt
                returning id
              `;
                if (written.length === 0)
                  return { written: false, fresh: false };
                if (order.lineItemsComplete)
                  yield* sql`delete from OrderLineItem where orderId = ${order.id}`;
                yield* insertLineItems(lineItems);
                yield* countTowardQuota(order, fresh);
                if (afterWrite !== undefined) yield* afterWrite;
                return { written: true, fresh };
              }),
            )
            .pipe(Effect.withSpan("OrderRepository.upsertOrder")),

        deleteOrder: Effect.fn("OrderRepository.deleteOrder")(function* (
          orderId: string,
        ) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
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
          readonly state: Domain.ProductionState | null;
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
            Match.when(null, () => sql.literal("1 = 1")),
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

        reserveSync: Effect.fn("OrderRepository.reserveSync")(function* ({
          workflowId,
          startedAt,
          windowStart,
        }: {
          readonly workflowId: string;
          readonly startedAt: number;
          readonly windowStart: number;
        }) {
          return yield* syncState(
            yield* sql`
              update SyncState set
                workflowId = ${workflowId},
                startedAt = ${startedAt},
                lastFullSyncWindowStart = ${windowStart},
                lastError = null
              where id = 1
              returning workflowId, startedAt, lastFullSyncAt,
                        lastFullSyncWindowStart, lastError
            `,
          );
        }),

        completeSync: Effect.fn("OrderRepository.completeSync")(function* ({
          startedAt,
        }: {
          readonly startedAt: number;
        }) {
          yield* sql`
            update SyncState set
              workflowId = null,
              startedAt = null,
              lastFullSyncAt = ${startedAt},
              lastError = null
            where id = 1 and startedAt = ${startedAt}
          `;
          return yield* readSyncState();
        }),

        failSync: Effect.fn("OrderRepository.failSync")(function* ({
          startedAt,
          error,
        }: {
          readonly startedAt: number;
          readonly error: string;
        }) {
          yield* sql`
            update SyncState set
              workflowId = null,
              startedAt = null,
              lastError = ${error}
            where id = 1 and startedAt = ${startedAt}
          `;
          return yield* readSyncState();
        }),

        clearSync: Effect.fn("OrderRepository.clearSync")(function* () {
          return yield* syncState(
            yield* sql`
              update SyncState set workflowId = null, startedAt = null
              where id = 1
              returning workflowId, startedAt, lastFullSyncAt,
                        lastFullSyncWindowStart, lastError
            `,
          );
        }),

        setSyncError: Effect.fn("OrderRepository.setSyncError")(function* ({
          error,
        }: {
          readonly error: string;
        }) {
          return yield* syncState(
            yield* sql`
              update SyncState set lastError = ${error}
              where id = 1
              returning workflowId, startedAt, lastFullSyncAt,
                        lastFullSyncWindowStart, lastError
            `,
          );
        }),

        getUsage: readUsage,

        sweepExpiredOrders: Effect.fn("OrderRepository.sweepExpiredOrders")(
          function* ({ now }: { readonly now: number }) {
            const expiredBefore =
              now - Domain.ShopLimits.orderRetentionDays * 86_400_000;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                /**
                 * `updatedAt` is Shopify's and every upsert refreshes it, so
                 * "closed and untouched for the window" is what ages out — an
                 * order a merchant edited last week stays whatever its
                 * `closedAt` says. The terms are spelled to match
                 * `ShopOrder_closed_idx` so SQLite can prove the index serves
                 * them; a live run is an absolute veto, since deleting the
                 * order would delete work someone is still doing.
                 */
                const expired = yield* sql`
                  select id from ShopOrder
                  where (fulfillmentStatus = 'FULFILLED' or cancelledAt is not null
                         or closedAt is not null)
                    and updatedAt < ${expiredBefore}
                    and not exists (
                      select 1 from WorkflowRun r
                      where r.orderId = ShopOrder.id
                        and r.status in ('pending', 'active')
                    )
                  order by updatedAt
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
                 * the order's being unavailable.
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

import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Match, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import * as CurrentWhere from "@/lib/currentWhere";
import * as Domain from "@/lib/Domain";
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

export interface OrderUpsert<A = void, E = never> {
  readonly order: Domain.ShopOrder;
  readonly lineItems: readonly Domain.OrderLineItem[];
  /**
   * Runs inside the upsert's transaction, after the items are written and
   * only when the write actually happened. The seam for reconcile (pass
   * rule 2 on {@link Domain.reconcileItem}): runs must be created and
   * adjusted against exactly the item set this write produced, and Durable
   * Object SQLite refuses nested transactions, so the caller composes plain
   * statements here rather than opening its own. Must not await anything but
   * storage. Its value
   * comes back as `upsertOrder`'s `afterWrite`, so the caller can act on
   * what the reconcile found once the transaction has committed.
   */
  readonly afterWrite?: Effect.Effect<A, E>;
}

/**
 * The `ShopUsage` row as stored. {@link Domain.ShopUsage} is this plus
 * `databaseSize`, which only the Durable Object can read.
 *
 * The row holds everything the Worker needs to compare this shop against its
 * plan without the object knowing what the plan is: the billing cycle's
 * counted orders, when the order ceiling last refused something, and when
 * retention last swept.
 */
export const ShopUsageRow = Schema.Struct({
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  ordersThisCycle: Schema.Number,
  ordersLimitedAt: Schema.NullOr(Schema.Number),
  lastSweepAt: Schema.NullOr(Schema.Number),
  seatsThisCycle: Schema.Number,
  pendingUsageEvents: Schema.Number,
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
  seatsThisCycle: Schema.Number,
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
 * ({@link Domain.seatEventValue}), so a replayed revalidation with the same
 * member count is a no-op at the row level even if the mark comparison were
 * raced. `seat#` plus two integers stays far inside the 64-character cap.
 * Built by `setBillingCycle`.
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

const encodeCursor = ({ processedAt, id }: Domain.ShopOrder) =>
  `${String(processedAt)}:${id}`;

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
 * `ShopOrder_open_idx` in `ShopAgent.ts` is declared over: SQLite only uses a
 * partial index when the query's `where` provably implies the index's, and it
 * proves that by matching terms, not by reasoning about them. The run
 * fragments are correlated to the outer `ShopOrder` row and served by
 * `Run_orderId_idx`. A closed run still holds its item
 * (`Domain.RunState`): it is in `RUN_FOR_ITEM`, so an item whose run closed
 * is not "Multiple workflows match" (a closed run is a decided item), and it is in
 * no position fragment
 * but `not_started`'s, which asks for no open and no done run.
 */
const OPEN = "fulfillmentStatus <> 'FULFILLED' and cancelledAt is null";
/**
 * {@link OPEN} on an aliased `ShopOrder`, for statements that also read
 * `Run`: qualified so the predicate cannot bind to a run column of
 * the same name (both tables carry `id` and `note`).
 */
const openAs = (alias: string) =>
  `${alias}.fulfillmentStatus <> 'FULFILLED' and ${alias}.cancelledAt is null`;
const OPEN_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.state = 'open'`;
const DONE_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.state = 'done'`;
/** The `blocked` {@link Domain.OrderIssue}: an open run a worker or the merchant blocked. */
const BLOCKED_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.state = 'open'
    and r.blockedAt is not null`;
const RUN_FOR_ITEM = `select 1 from Run r
  where r.lineItemId = li.id`;
/**
 * The SQL twin of `Domain.itemMatches`, counted: how many eligible workflows
 * carry a tag of the item `li`. On, with a task, every task's `teamId` set,
 * and a product tag, trimmed and lowercased, equal to the workflow's tag.
 * The item half's other clause, units to make above zero, is on the readers
 * ({@link MULTI_MATCH_ITEM}), where it is one comparison on the row. It
 * restates the rule and must move with it.
 *
 * Two stated gaps against the TypeScript side. A `teamId` no D1 team
 * carries is the window stated on `itemMatches`. And SQLite's `lower` and
 * `trim` fold ASCII and strip U+0020 only, where `toLowerCase` and `trim`
 * are Unicode-aware: a product tag with non-ASCII case ("GRAVÜR") or a
 * no-break space matches in TypeScript and not here. Workflow tags are
 * lowercased on input (`Domain.WorkflowTag`), so only the product tag's
 * spelling can differ.
 *
 * `json_each` is SQLite's JSON1, compiled into Durable Object SQLite;
 * `order-repository.test.ts` is the proof.
 */
const ITEM_MATCHES = `(select count(*) from Workflow w
  where w.state = 'on'
    and exists (select 1 from WorkflowTask t where t.workflowId = w.id)
    and not exists (
      select 1 from WorkflowTask t where t.workflowId = w.id and t.teamId is null
    )
    and exists (
      select 1 from json_each(li.productTags) tag
      where lower(trim(tag.value)) = w.tag
    ))`;
/**
 * `Domain.multiMatchItems` in SQL: an item with units still to make, two or
 * more matches ({@link ITEM_MATCHES}), and no run in any state. Derived from
 * the workflows as they are now, so a Turn off, a tag edit or Change workflow
 * away and back reads correctly with no reconcile in between.
 */
const MULTI_MATCH_ITEM = `select 1 from OrderLineItem li
  where li.orderId = ShopOrder.id and li.currentQuantity > 0
    and ${ITEM_MATCHES} >= 2
    and not exists (${RUN_FOR_ITEM})`;
/**
 * The `multi_match` {@link Domain.OrderIssue} as one predicate. `OPEN` is
 * the caller's, as for every issue.
 */
const MULTI_MATCH = `exists (${MULTI_MATCH_ITEM})`;

/**
 * Each counted filter value's predicate over the `facts` rows of the count
 * statement in `listOrders`: `showFilter` restated over per-order facts
 * instead of correlated subqueries, and moving with it. `OPEN` is the
 * statement's own `where`, so `open` is every row. `issues` is the three
 * `Domain.orderIssues` elements or'd.
 */
const COUNT_FACT = {
  open: "1",
  issues: "multiMatch or unassigned or blockedRuns > 0",
  not_started: "openRuns = 0 and doneRuns = 0",
  making: "openRuns > 0",
  made: "doneRuns > 0 and openRuns = 0",
} as const satisfies Record<keyof Domain.OrderCounts, string>;

const bit = (value: boolean) => (value ? 1 : 0);

export class OrderRepository extends Context.Service<
  OrderRepository,
  {
    /**
     * The one write every ingestion path funnels through, and the only reason
     * webhooks and a bulk stream can interleave freely. What one sync does to
     * one order is {@link Domain.syncOrder}'s actions table; this is where it
     * is executed, in one transaction, with the items and the reconcile
     * (rule 6 on `Domain.syncOrder`), keeping `countedAt` on every write
     * (rule 7).
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
     * `Domain.ShopLimits.maxLineItemsPerOrder` (250), which is the maximum any
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
     */
    readonly upsertOrder: <A = void, E = never>(
      input: OrderUpsert<A, E>,
    ) => Effect.Effect<
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
     * which a run is created — so the predicate is "Baton created a run on this
     * order", not "the order looks billable". That is deliberately narrower
     * than paid: a paid order no workflow matches costs the merchant nothing,
     * and an order Baton only ever displayed was never work it carried.
     *
     * `countedAt is null` in the `update` is the entire idempotency story. A
     * second run on the same order changes no row, so no counter moves and no
     * event is queued; the same holds for a reconcile that re-creates runs
     * after a cancellation. The `#count` key is permanent at Shopify, so even
     * a queue that slipped through would bill once. The mark lives on the
     * order row, so only deleting the order removes it, and `upsertOrder`
     * refuses to bring back an order retention deleted
     * ({@link Domain.ShopLimits.orderRetentionDays}).
     *
     * Runs inside the caller's transaction — Durable Object SQLite refuses
     * nested ones — so the marker, the counter and the outbox row cannot come
     * apart. `now` is the caller's clock, and it dates the usage event, which
     * Shopify accepts only inside the merchant's open billing cycle.
     *
     * Resolves the cycle before it increments, exactly as `upsertOrder` does,
     * so a run created by hand on a quiet shop past its cycle end counts into
     * the new cycle rather than the outgoing one. On the reconcile path the
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
     * `show` filters by `Domain.OrdersShow`, each SQL fragment restating a
     * branch of `orderPosition` or, for Issues, the union of `orderIssues`'
     * elements; each must move with the function it restates.
     * Open, the open positions, Issues and the `counts` aggregate spell out
     * `fulfillmentStatus <> 'FULFILLED' and cancelledAt is null` verbatim so
     * SQLite can prove they are served by the partial `ShopOrder_open_idx`,
     * which is what keeps a count from reading the shop's whole history.
     *
     * `q` set means `show` and `team` are not applied: search
     * ignores the filters (`Domain.ListOrdersInput.q`).
     *
     * `counts` follows `Domain.OrderCounts`: a count is what choosing that
     * value would show, given the team. One count per filter value, narrowed
     * by `team` and by nothing else.
     */
    readonly listOrders: (input: {
      readonly limit: number;
      readonly cursor: string | null;
      /** `null` is no search; otherwise `Domain.searchTerm`'s reading (`Domain.ListOrdersInput.q`). */
      readonly q: Domain.ListSearch | null;
      /** `null` is Open (`Domain.ListOrdersInput.show`). */
      readonly show: Domain.OrdersShow | null;
      /** `null` is any team; an id is `Domain.ListOrdersInput.team` — waiting on that team. */
      readonly team: Domain.TeamId | null;
      /** The shop's teams, read live from D1: what `unassigned` is derived against (`Domain.OrderRow`). */
      readonly teams: Domain.EligibleContext["teams"];
    }) => Effect.Effect<
      Domain.OrdersPage,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * The one `SyncState` row, seeded by the schema so every read is a plain
     * `select` and every write an `update` that cannot race an insert. It
     * holds the last sync's error and nothing about a sync in flight: that is the Agents SDK's
     * `cf_agents_workflows` row, read by `ShopAgent.syncOpenOrders`.
     */
    readonly getSyncState: () => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Records the failure that ended the last sync. The banner on the
     * orders index carries it until the next sync clears it.
     */
    readonly setSyncError: (input: {
      readonly error: string;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * `setSyncError`, but only when no error is
     * recorded: the Workflow's sink writes the merchant sentence first, and
     * the SDK's error callback that follows must not overwrite it (rule 14 on
     * `Domain.syncOrder`).
     */
    readonly setSyncErrorIfEmpty: (input: {
      readonly error: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /** Clears the banner; the sync about to start owns the state from here. */
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
     * Rule 5 on `Domain.syncOrder`: the ceiling is read at the cycle the sync
     * lands in, after any roll-forward, wherever it is read. Resolves the
     * cycle at `now` exactly as the write does, then reads the counters, so
     * a cycle whose end has passed is rolled forward before the count is
     * read.
     */
    readonly usageAtCycle: (
      now: number,
    ) => Effect.Effect<ShopUsageRow, SqlError.SqlError | OrderRepositoryError>;
    /**
     * Records the shop's billing cycle (`Domain.BillingCycleInput`). What it
     * does to the counts and the queue is the three "cycle pushed" rows on
     * `Domain.ShopUsage`; the mechanics are here.
     *
     * A changed `cycleStartAt` is a new cycle: the order count is recounted
     * from rows, and the seat mark is reset to the member count
     * (`input.memberCount`), queued as the
     * cycle's first seat event dated `cycleStartAt`. The value is the member count,
     * not the overage, because the seat meter starts every cycle at zero and
     * the plan's tiers price it (`Domain.AppSubscription`). On a shop no push
     * had addressed yet, every event dated before the start is dropped too.
     *
     * An unchanged start writes the columns and leaves the count alone, which
     * is what makes it safe to call on every revalidation. It still raises the
     * seat mark to a member count past it ({@link Domain.seatEventValue}): the
     * revalidation is the mark's one writer, so a member added since the last
     * one is billed here, and a cycle the counting path rolled forward on its
     * own, which starts with no mark, gets its mark here.
     *
     * `shopGid` is stored here rather than derived because addressing a usage
     * event at Shopify needs it and the object has no other source.
     */
    readonly setBillingCycle: (
      input: Domain.BillingCycleInput,
    ) => Effect.Effect<void, SqlError.SqlError | OrderRepositoryError>;
    /** Flags that a new order was refused at `Domain.ShopLimits.maxOrdersPerCycle`; `coalesce` keeps the first refusal's instant. */
    readonly markOrdersLimited: (
      now: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * One pass over the usage-event outbox: at most `ShopLimits.sweepBatch`
     * live rows, oldest first, each sent and then deleted or marked. Rows dated
     * before the current cycle can never be sent
     * (`Domain.usageEventIsExpired`): the pass deletes them first, up to the
     * same batch, and logs each.
     *
     * Deliberately outside every upsert transaction — it does network I/O, and
     * Durable Object SQLite transactions must not await anything but storage.
     * `ShopifyAppEvents` is a requirement of the *effect* rather than of the
     * layer, so the repository stays constructible from a bare SQLite client
     * and only the callers that flush have to provide the client.
     *
     * The App Events API answers `202` to everything, including events it will
     * later refuse, so an event that is merely sent proves nothing: a row is
     * deleted only once Shopify has accepted the request, and a refusal leaves
     * it with its `attempts` and `lastError` for an operator to read.
     * `idempotencyKey` is the row's key because Shopify enforces billing
     * idempotency keys permanently: a replayed flush must not bill twice, and
     * re-queuing a key already stored is a no-op by construction.
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
     * items and its runs. This is the one path that removes a stored order
     * outside retention. Runs go with the order because a fixture row being
     * replaced has no trail worth keeping, and a run outliving its order
     * carries its own snapshot of the order name and item, so it would sit on
     * a queue as a card nothing can clear. Usage is untouched: a seeded order
     * is never counted ({@link markSeedOrdersCounted}), so there is nothing to
     * give back.
     */
    readonly deleteSeedOrders: () => Effect.Effect<void, SqlError.SqlError>;
    /**
     * Seed only: marks `orderIds` counted at `0` where they are not counted
     * yet, so {@link countOrder} never counts them. Zero is before every
     * billing cycle, so the recount (`countedSince`) never counts them either:
     * no share of `ShopUsage.ordersThisCycle`, no usage event.
     *
     * A fixture that reaches Shopify's meter costs money under a permanent
     * idempotency key, and one that moved the local count would climb by a
     * fixture's worth on every reseed. The rule lives with the seed, as its
     * own method and not as an input on `upsertOrder` or a check in
     * `countOrder`, so the sync paths and the meter carry no seed knowledge
     * and no caller can exempt an order by passing a value. Runs inside the
     * seed's `upsertOrder` transaction, before the reconcile that creates the
     * order's first run.
     */
    readonly markSeedOrdersCounted: (
      orderIds: readonly string[],
    ) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * One retention pass: at most `ShopLimits.sweepBatch` orders older than
     * `ShopLimits.orderRetentionDays` — open or closed, with runs or without.
     * What goes with an
     * expired order is the data model on `initializeSchema`
     * (`ShopAgentSchema.ts`). Deliberately batched and deliberately carried
     * by a request that was already doing
     * heavy work — there is no alarm and no cron — so a shop with years of
     * history drains over several passes instead of one request paying for
     * all of it. The only path that deletes a synced order (rule 9 on
     * `Domain.syncOrder`).
     */
    readonly sweepExpiredOrders: (input: {
      readonly now: number;
    }) => Effect.Effect<
      { readonly orders: number; readonly runs: number },
      SqlError.SqlError | OrderRepositoryError
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
         fulfillmentStatus, fullyPaid, note, syncedAt`,
      );

      /**
       * A single order with its items, or `none`. Shared by the GID and
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
            yield* sql`select lastError from SyncState where id = 1`,
          );
        });

      const insertLineItems = (lineItems: readonly Domain.OrderLineItem[]) =>
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

      const decodeCycle = decode(
        Schema.Array(ShopUsageCycle),
        "Invalid ShopUsage row",
      );

      const readCycle = () =>
        sql`select shopGid, cycleStartAt, cycleEndAt, ordersThisCycle, seatsThisCycle from ShopUsage where id = 1`.pipe(
          Effect.flatMap(decodeCycle),
        );

      /**
       * Orders whose `countedAt` is at or after `since`: what a cycle
       * starting there is worth, the `recounted` of the triggers table on
       * `Domain.ShopUsage`.
       *
       * Correct only while a cycle is a month or less (the table's second
       * assumption). `countedAt` is a single timestamp per order, so an order
       * counted in *any* earlier cycle still inside `since` would be counted
       * again — which cannot happen for consecutive monthly cycles, where
       * everything before the new start belongs to a cycle that has closed. A
       * yearly cycle would break it; nothing in code enforces that, because
       * the plan's interval lives in the Partner Dashboard, which offers usage
       * meters on monthly plans only.
       */
      const countedSince = (since: number) =>
        sql`select count(*) from ShopOrder where countedAt >= ${since}`.values.pipe(
          Effect.map(([row]) => Number(row?.[0] ?? 0)),
        );

      /**
       * The cycle this write counts against, rolling the stored one forward
       * when the write lands past its end: the "first count past the cycle
       * end" row on `Domain.ShopUsage`.
       *
       * The rollover rides the counting path rather than a clock: a quiet
       * shop's stored cycle may lag by cycles, and the only moment that can
       * matter is the first order of a new one — which is exactly here. The
       * rolled-forward cycle is deliberately open-ended (`cycleEndAt` null):
       * only Shopify knows where the next cycle really ends, and the next
       * revalidation's `setBillingCycle` lands the exact answer, within a day
       * at the latest (`revalidateStalePlans`).
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
                seatsThisCycle = 0
            where id = 1
          `;
          return {
            shopGid: stored.shopGid,
            cycleStartAt,
            ordersThisCycle: 0,
            seatsThisCycle: 0,
          };
        }
        if (stored.cycleEndAt !== null && now >= stored.cycleEndAt) {
          // Recounted from the rows, as `setBillingCycle` does, so both ways a
          // cycle can start state one rule: the count is the orders counted
          // at or after the start. The seat mark starts at zero: the object
          // cannot count the members, so the next `setBillingCycle` sends the
          // whole of it into the new cycle.
          const count = yield* countedSince(stored.cycleEndAt);
          yield* sql`
            update ShopUsage
            set cycleStartAt = cycleEndAt, cycleEndAt = null,
                ordersThisCycle = ${count}, ordersLimitedAt = null,
                seatsThisCycle = 0
            where id = 1
          `;
          return {
            shopGid: stored.shopGid,
            cycleStartAt: stored.cycleEndAt,
            ordersThisCycle: count,
            seatsThisCycle: 0,
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
          yield* sql`update ShopUsage set seatsThisCycle = ${input.size} where id = 1`;
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
       * A seeded order never gets here: the seed marks it counted before its
       * first run ({@link OrderRepository.markSeedOrdersCounted}).
       */
      const queueUsageEvent = (input: {
        readonly idempotencyKey: string;
        readonly eventHandle: string;
        readonly orderId: string | null;
        readonly value: number;
        readonly occurredAt: number;
      }) =>
        sql`
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
                   lastSweepAt, seatsThisCycle,
                   (select count(*) from UsageEvent
                    where cycleStartAt is null or occurredAt >= cycleStartAt) as pendingUsageEvents
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
        upsertOrder: <A, E>({
          order,
          lineItems,
          afterWrite,
        }: OrderUpsert<A, E>) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                // One primary-key probe, before the upsert makes the answer
                // unknowable: `returning id` cannot distinguish an insert from
                // an update, and `fresh` is what the bulk stream reports and
                // what the ceiling gates on.
                const existing = yield* sql<{
                  readonly updatedAt: number;
                }>`select updatedAt from ShopOrder where id = ${order.id} limit 1`;
                const stored = existing[0];
                // Resolved on every path, before the insert, because the
                // ceiling is a fact about the cycle this write lands in, after
                // any roll-forward; `syncOrder` ignores `atCeiling` for a
                // stored order (rule 8).
                const cycle = yield* currentCycle(order.syncedAt);
                const action = Domain.syncOrder({
                  stored: stored ?? null,
                  incoming: order,
                  atCeiling: Domain.cycleAtOrderCeiling(cycle.ordersThisCycle),
                });
                if (action._tag === "refuse" && action.reason === "ceiling")
                  yield* markOrdersLimited(order.syncedAt);
                if (action._tag !== "write")
                  return {
                    written: false,
                    fresh: false,
                    refused:
                      action._tag === "refuse" && action.reason === "ceiling",
                    afterWrite: Option.none<A>(),
                  };
                const fresh = action.fresh;
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
                    refused: false,
                    afterWrite: Option.none<A>(),
                  };
                yield* sql`delete from OrderLineItem where orderId = ${order.id}`;
                yield* insertLineItems(lineItems);
                const after =
                  afterWrite === undefined
                    ? Option.none<A>()
                    : Option.some(yield* afterWrite);
                return {
                  written: true,
                  fresh,
                  refused: false,
                  afterWrite: after,
                };
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
          show,
          team,
          teams,
        }: {
          readonly limit: number;
          readonly cursor: string | null;
          readonly q: Domain.ListSearch | null;
          readonly show: Domain.OrdersShow | null;
          readonly team: Domain.TeamId | null;
          readonly teams: Domain.EligibleContext["teams"];
        }) {
          /**
           * Bound to the teams the caller read from D1. `unassignedRun` is
           * `Domain.OrderRow.unassigned` in SQL.
           */
          const liveIds = teams.map(({ id }) => id);
          const unassigned =
            liveIds.length === 0
              ? sql.literal("1 = 1")
              : sql`(s.teamId is null or s.teamId not in ${sql.in(liveIds)})`;
          const runWithTask = (task: typeof unassigned) => sql`exists (
            select 1 from Run r
            where r.orderId = ShopOrder.id and r.state = 'open'
              and exists (
                select 1 from RunTask s
                where s.runId = r.id and s.doneAt is null and ${task}
              )
          )`;
          const unassignedRun = runWithTask(unassigned);
          /**
           * `Domain.ListOrdersInput.team`, whose JSDoc carries the rules, as
           * a `where`. The outer run is aliased `wr` because `currentWhere`
           * binds `r` for the task's own run inside its subqueries (see its
           * JSDoc).
           */
          const teamFilter =
            team === null
              ? sql.literal("1 = 1")
              : sql`${sql.literal(OPEN)} and exists (
                  select 1 from Run wr
                  join RunTask s on s.runId = wr.id
                  where wr.orderId = ShopOrder.id
                    and wr.state = 'open'
                    and wr.blockedAt is null
                    and s.teamId = ${team}
                    and ${sql.literal(CurrentWhere.currentWhere("s"))}
                )`;
          /**
           * The open positions partition the open orders by run state alone:
           * no open and no done run is `not_started`, any open run is
           * `making`, only done runs is `made`, as `Domain.orderPosition`
           * says. Issues is `OPEN` and the three `Domain.orderIssues`
           * elements or'd, each the fragment above that restates it.
           */
          const showFilter = Match.value(show).pipe(
            Match.when("not_started", () =>
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
            Match.when("issues", () =>
              sql.and([
                OPEN,
                sql.or([
                  `(${MULTI_MATCH})`,
                  unassignedRun,
                  `exists (${BLOCKED_RUN})`,
                ]),
              ]),
            ),
            /**
             * `null` is Open, the default, and it is open work, not
             * everything: the negation of the `fulfilled` and `cancelled`
             * branches above, spelled as `OPEN` so the partial index serves
             * it. `"all"`, `"fulfilled"` and `"cancelled"` are the only values
             * that read a shop's history ({@link Domain.OrdersShow}).
             */
            Match.when(null, () => sql.literal(OPEN)),
            Match.when("all", () => sql.literal("1 = 1")),
            Match.exhaustive,
          );
          /**
           * `Domain.searchTerm`'s reading. An order number matches the name
           * whole: `#10` listing `#1001` … `#1099` read as a guess, and the
           * merchant has the number off the admin. A word is a prefix of the
           * item title, the variant title or the SKU, at the start or after a
           * space (`Domain.prefixPatterns`), on any of the order's items.
           */
          const searchFilter = Option.match(Option.fromNullOr(q), {
            onNone: () => sql.literal("1 = 1"),
            onSome: (text) => {
              const term = Domain.searchTerm(text);
              if (term.kind === "orderName") return sql`name = ${term.name}`;
              const [start, word] = Domain.prefixPatterns(term.text);
              return sql`exists (
                select 1 from OrderLineItem li
                where li.orderId = ShopOrder.id and (
                  li.title like ${start} escape '\\'
                  or li.title like ${word} escape '\\'
                  or li.variantTitle like ${start} escape '\\'
                  or li.variantTitle like ${word} escape '\\'
                  or li.sku like ${start} escape '\\'
                  or li.sku like ${word} escape '\\'
                )
              )`;
            },
          });
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
          /**
           * A search reads every stored order: `show` and `team` apply only
           * when `q` is null (`Domain.ListOrdersInput.q`).
           */
          const narrowing =
            q === null ? [showFilter, teamFilter] : [searchFilter];
          const page = yield* decodeOrders(
            yield* sql`
              select ${orderColumns} from ShopOrder
              where ${sql.and([keyset, ...narrowing])}
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
                    sum(state = 'open') as open,
                    sum(state = 'done') as done,
                    sum(blockedAt is not null and state = 'open') as blocked
                  from Run
                  where ${sql.in("orderId", ids)}
                  group by orderId
                `.values;
          const unassignedRows =
            ids.length === 0
              ? []
              : yield* sql`
                  select id from ShopOrder
                  where ${sql.in("id", ids)} and ${unassignedRun}
                `.values;
          /**
           * `Domain.OrderRow.multiMatchItems`, restating `MULTI_MATCH_ITEM` per
           * item rather than as an `exists`: the badge says how many items are
           * waiting on a choice, not merely that one is.
           */
          const multiMatchRows =
            ids.length === 0
              ? []
              : yield* sql`
                  select li.orderId, count(*)
                  from OrderLineItem li
                  where ${sql.in("li.orderId", ids)}
                    and li.currentQuantity > 0
                    and ${sql.literal(ITEM_MATCHES)} >= 2
                    and not exists (${sql.literal(RUN_FOR_ITEM)})
                  group by li.orderId
                `.values;
          const unassignedIds = new Set(
            unassignedRows.map((row) => String(row[0])),
          );
          const multiMatch = new Map(
            multiMatchRows.map((row) => [String(row[0]), Number(row[1] ?? 0)]),
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
              } satisfies Domain.RunCounts,
            ]),
          );
          /**
           * `Domain.OrderCounts` in one statement over the open orders the
           * team leaves: one count per Show value, never the Show filter
           * itself, and never the search, which ignores the filters. `run_summary` is the per-page
           * `runRows` aggregate hoisted over every open order, one grouped
           * read of `Run` in place of a correlated `exists` per fragment;
           * `MULTI_MATCH` and `unassignedRun` stay correlated, walking items and
           * tasks. `facts` is materialised so each correlated term runs once
           * per order however many sums read it. The sums restate
           * `showFilter` over those facts ({@link COUNT_FACT}) and must move
           * with it.
           *
           * `run_summary` is a `cross join`, which SQLite reads as "keep this
           * table order" (https://www.sqlite.org/optoverview.html#crossjoin):
           * with no `sqlite_stat1` the planner otherwise drives from
           * `Run_state_idx` and reads every run the retention window
           * keeps, closed orders included. Driven from `ShopOrder_open_idx`
           * through `Run_orderId_idx`, the read is the open orders'
           * runs only. The `ShopOrder` columns are qualified for the reason
           * on {@link openAs}.
           */
          const [countRow] = yield* sql`
              with run_summary as (
                select r.orderId,
                  sum(r.state = 'open') as openRuns,
                  sum(r.state = 'done') as doneRuns,
                  sum(r.state = 'open' and r.blockedAt is not null) as blockedRuns
                from ShopOrder o
                cross join Run r on r.orderId = o.id
                where ${sql.literal(openAs("o"))}
                group by r.orderId
              ),
              facts as materialized (
                select
                  coalesce(rs.openRuns, 0) as openRuns,
                  coalesce(rs.doneRuns, 0) as doneRuns,
                  coalesce(rs.blockedRuns, 0) as blockedRuns,
                  (${sql.literal(MULTI_MATCH)}) as multiMatch,
                  ${unassignedRun} as unassigned
                from ShopOrder
                left join run_summary rs on rs.orderId = ShopOrder.id
                where ${sql.and([OPEN, teamFilter])}
              )
              select
                count(*),
                sum(${sql.literal(COUNT_FACT.issues)}),
                sum(${sql.literal(COUNT_FACT.not_started)}),
                sum(${sql.literal(COUNT_FACT.making)}),
                sum(${sql.literal(COUNT_FACT.made)})
              from facts
            `.values;
          const counts = {
            open: Number(countRow?.[0] ?? 0),
            issues: Number(countRow?.[1] ?? 0),
            not_started: Number(countRow?.[2] ?? 0),
            making: Number(countRow?.[3] ?? 0),
            made: Number(countRow?.[4] ?? 0),
          } satisfies Domain.OrderCounts;
          /**
           * `Domain.OrdersPage.matches`: read only under a search, over every
           * stored order, because the search ignores the filters and the
           * screen's line says how many it found, not how many one page holds.
           */
          const matches =
            q === null
              ? null
              : Number(
                  (yield* sql`select count(*) from ShopOrder where ${searchFilter}`
                    .values)[0]?.[0] ?? 0,
                );
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
              unassigned: unassignedIds.has(order.id),
              multiMatchItems: multiMatch.get(order.id) ?? 0,
            })),
            limit,
            nextCursor:
              page.length > limit && last !== undefined
                ? encodeCursor(last)
                : null,
            counts,
            matches,
          } satisfies Domain.OrdersPage;
        }),

        getSyncState: Effect.fn("OrderRepository.getSyncState")(readSyncState),

        setSyncError: Effect.fn("OrderRepository.setSyncError")(function* ({
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
        }),

        setSyncErrorIfEmpty: Effect.fn("OrderRepository.setSyncErrorIfEmpty")(
          function* ({ error }: { readonly error: string }) {
            yield* sql`update SyncState set lastError = ${error} where id = 1 and lastError is null`;
          },
        ),

        clearSyncError: Effect.fn("OrderRepository.clearSyncError")(
          function* () {
            yield* sql`update SyncState set lastError = null where id = 1`;
          },
        ),

        getUsage: readUsage,

        usageAtCycle: Effect.fn("OrderRepository.usageAtCycle")(function* (
          now: number,
        ) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* currentCycle(now);
              return yield* readUsage();
            }),
          );
        }),

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
                    highWater: stored?.seatsThisCycle ?? 0,
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
                 * count disagree with the invoice for the rest of the cycle.
                 * Orders counted before the new start belong to a closed cycle
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
                 * reports no billing cycle — belong to no billing cycle: their
                 * orders were just recounted out, and sending them into the
                 * first real cycle would bill work the cycle never carried. Only then: once a shop has been addressed, an event
                 * that misses its cycle is a real loss, deleted and logged by
                 * the next flush (`Domain.usageEventIsExpired`).
                 */
                if (unaddressed)
                  yield* sql`delete from UsageEvent where occurredAt < ${input.cycleStartAt}`;
                /** The new cycle's seat mark is the member count, sent whole. */
                yield* sql`update ShopUsage set seatsThisCycle = 0 where id = 1`;
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
            // A row dated before the cycle has expired
            // (`Domain.usageEventIsExpired`): it can never be sent, so it is
            // deleted here, and the log line is its record.
            const expired = yield* sql<{
              readonly idempotencyKey: string;
              readonly eventHandle: string;
            }>`
              delete from UsageEvent
              where idempotencyKey in (
                select idempotencyKey from UsageEvent
                where occurredAt < ${cycleStartAt}
                order by occurredAt
                limit ${Domain.ShopLimits.sweepBatch}
              )
              returning idempotencyKey, eventHandle
            `;
            yield* Effect.forEach(
              expired,
              ({ idempotencyKey, eventHandle }) =>
                Effect.logWarning(
                  `OrderRepository.flushUsageEvents: shop=${shop} idempotencyKey=${idempotencyKey} eventHandle=${eventHandle}: expired before it was sent, deleted`,
                ).pipe(
                  Effect.annotateLogs({ shop, idempotencyKey, eventHandle }),
                ),
              { discard: true },
            );
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
               * caller is a webhook or an open-orders sync whose real work succeeded —
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
                yield* sql`delete from Run where orderId like ${seedPrefix}`;
                yield* sql`delete from OrderLineItem where orderId like ${seedPrefix}`;
                yield* sql`delete from ShopOrder where id like ${seedPrefix}`;
              }),
            );
          },
        ),

        markSeedOrdersCounted: Effect.fn(
          "OrderRepository.markSeedOrdersCounted",
        )(function* (orderIds: readonly string[]) {
          if (orderIds.length === 0) return;
          yield* sql`update ShopOrder set countedAt = 0 where ${sql.in("id", orderIds)} and countedAt is null`;
        }),

        sweepExpiredOrders: Effect.fn("OrderRepository.sweepExpiredOrders")(
          function* ({ now }: { readonly now: number }) {
            const expiredBefore = Domain.retentionCutoff(now);
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
                yield* sql`update ShopUsage set lastSweepAt = ${now} where id = 1`;
                return { orders: ids.length, runs };
              }),
            );
          },
        ),
      });
    }),
  );
}

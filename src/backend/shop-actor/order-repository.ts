/**
 * The shop actor's orders over its SQLite: legacy's `OrderRepository` but billing (the cycle,
 * the usage outbox and `countOrder`'s body). Legacy's SQL, verbatim.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import {
  type OrderDetail,
  OrderLineItem,
  type OrdersSyncStatus,
  ShopOrder,
  SyncState,
  syncOrder,
} from "../../domain/orders.ts";
import { retentionCutoff, ShopLimits } from "../../domain/platform.ts";
import {
  type EligibleContext,
  type ListOrdersInput,
  type OrderCounts,
  type OrdersPage,
  prefixPatterns,
  type RunCounts,
  searchTerm,
} from "../../domain/shop-work.ts";
import { SYNC_STALE_MS } from "../orders-sync-constants.ts";
import { currentWhere } from "./current-where.ts";
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
   * and a transaction is never nested (`Transaction`), so the caller
   * composes plain statements here rather than opening its own. Must not await
   * anything but storage. Its value comes back as `upsertOrder`'s
   * `afterWrite`, so the caller can act on what the reconcile found once the
   * transaction has committed.
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
 * `ShopOrder_open_idx` (the actor's `migrations`) is declared over: SQLite only uses a
 * partial index when the query's `where` provably implies the index's, and it
 * proves that by matching terms, not by reasoning about them. The run
 * fragments are correlated to the outer `ShopOrder` row and served by
 * `Run_orderId_state_idx (orderId, state)`, both terms. A closed run still holds its item
 * (`RunState`): it is in `RUN_FOR_ITEM`, so an item whose run closed
 * is not "Multiple workflows match" (a closed run is a decided item), and it is in
 * no position fragment
 * but `unpaid`'s and `no_workflow`'s, which ask for no open and no done run.
 */
const OPEN = "fulfillmentStatus <> 'FULFILLED' and cancelledAt is null";
/**
 * {@link OPEN} on an aliased `ShopOrder`: for statements that also read `Run`, qualified so the
 * predicate cannot bind to a run column of the same name (both tables carry `id` and `note`),
 * and for the actor's open-order triggers, on `new` and `old`.
 */
export const openAs = (alias: string) =>
  `${alias}.fulfillmentStatus <> 'FULFILLED' and ${alias}.cancelledAt is null`;
const OPEN_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.state = 'open'`;
const DONE_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.state = 'done'`;
/**
 * An open run with a started task (`runIsStarted`), read off the
 * denormalized `Run.startedAt`. Served by `Run_orderId_state_idx` on both
 * terms, with `startedAt` as a residual.
 */
const STARTED_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.state = 'open'
    and r.startedAt is not null`;
/** The `blocked` `OrderIssue`: an open run a worker or the merchant blocked. */
const BLOCKED_RUN = `select 1 from Run r
  where r.orderId = ShopOrder.id and r.state = 'open'
    and r.blockedAt is not null`;
const RUN_FOR_ITEM = `select 1 from Run r
  where r.lineItemId = li.id`;
/**
 * The SQL twin of `itemMatches`, counted: how many eligible workflows
 * carry a tag of the item `li`. On, with a task, every task's `teamId` set,
 * and a product tag equal to the workflow's tag, exactly. The item half's
 * other clause, units to make above zero, is on the readers
 * ({@link MULTI_MATCH_ITEM}), where it is one comparison on the row. It
 * restates the rule and must move with it. A `teamId` no D1 team carries is
 * the window stated on `itemMatches`.
 *
 * It starts from the item's tags and probes the unique `Workflow.tag`, the
 * rule on `itemMatches`, so a workflow whose tag the item does not
 * carry is never read. Counted per workflow (`distinct w.id`), as
 * `matchedWorkflows` counts: a tag listed twice on an item is one
 * match. Exported for the test that reads its query plan.
 *
 * `json_each` is SQLite's JSON1, compiled into Durable Object SQLite and `node:sqlite` alike.
 */
export const ITEM_MATCHES = `(select count(distinct w.id)
  from json_each(li.productTags) tag
  join Workflow w on w.tag = tag.value
  where w.state = 'active'
    and json_array_length(w.tasks) > 0
    and not exists (
      select 1 from json_each(w.tasks) t
      where json_extract(t.value, '$.teamId') is null))`;
/**
 * `multiMatchItems` in SQL: an item with units still to make, two or
 * more matches ({@link ITEM_MATCHES}), and no run in any state. It restates
 * `itemMatches` from the item's side, which is the rule there: a
 * workflow is found by its tag, never by scanning. Derived from
 * the workflows as they are now, so a Turn off, a tag edit or Change workflow
 * away and back reads correctly with no reconcile in between.
 */
const MULTI_MATCH_ITEM = `select 1 from OrderLineItem li
  where li.orderId = ShopOrder.id and li.currentQuantity > 0
    and ${ITEM_MATCHES} >= 2
    and not exists (${RUN_FOR_ITEM})`;
/**
 * The `multi_match` `OrderIssue` as one predicate. `OPEN` is
 * the caller's, as for every issue.
 */
const MULTI_MATCH = `exists (${MULTI_MATCH_ITEM})`;

/**
 * Each counted filter value's predicate over the `facts` rows of the count
 * statement in `listOrders`: `showFilter` restated over per-order facts
 * instead of correlated subqueries, and moving with it. `OPEN` is the
 * statement's own `where`. `issues` is the three `orderIssues`
 * elements or'd.
 */
const COUNT_FACT = {
  no_workflow: "openRuns = 0 and doneRuns = 0 and fullyPaid",
  not_started: "openRuns > 0 and doneRuns = 0 and startedRuns = 0",
  making: "openRuns > 0 and (doneRuns > 0 or startedRuns > 0)",
  made: "doneRuns > 0 and openRuns = 0",
  issues: "multiMatch or unassigned or blockedRuns > 0",
} as const satisfies Record<keyof OrderCounts, string>;

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
   * The open-order count, what {@link openOrdersAtCeiling} reads: `ShopUsage.openOrders`, one
   * row, which the `ShopOrder_open_*` triggers in the actor's `migrations` keep.
   */
  const countOpenOrders = Effect.fn("OrderRepository.countOpenOrders")(function* () {
    const [row] = yield* sql<{
      readonly openOrders: number;
    }>`select openOrders from ShopUsage where id = 1`;
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
   * The update leaves `legacyId` and `name` alone: Shopify never changes either on an order,
   * and setting an indexed column rewrites its index entry, a billed row, even to the same
   * value.
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

  /**
   * A single order with its items, or `none`. Shared by the GID and
   * legacy-id lookups so both read the same shape.
   */
  const detailOf = Effect.fn("OrderRepository.detailOf")(function* (rows: readonly unknown[]) {
    const [order] = yield* decodeOrders(rows);
    if (order === undefined) return Option.none<OrderDetail>();
    return Option.some<OrderDetail>({ order, lineItems: yield* lineItemsOf(order.id) });
  });

  /** A single order with its items, or `none`. */
  const getOrder = Effect.fn("OrderRepository.getOrder")(function* (orderId: string) {
    return yield* detailOf(yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`);
  });

  /** {@link getOrder} by Shopify's numeric id, the order page's URL key. */
  const getOrderByLegacyId = Effect.fn("OrderRepository.getOrderByLegacyId")(function* (
    legacyId: string,
  ) {
    return yield* detailOf(
      yield* sql`select ${orderColumns} from ShopOrder where legacyId = ${legacyId}`,
    );
  });

  /** One line item with its order, or `none`: what manual attach reads. */
  const getLineItem = Effect.fn("OrderRepository.getLineItem")(function* (lineItemId: string) {
    const [lineItem] = yield* decodeLineItems(
      yield* sql`select * from OrderLineItem where id = ${lineItemId}`,
    );
    if (lineItem === undefined)
      return Option.none<{ readonly order: ShopOrder; readonly lineItem: OrderLineItem }>();
    const [order] = yield* decodeOrders(
      yield* sql`select ${orderColumns} from ShopOrder where id = ${lineItem.orderId}`,
    );
    return order === undefined
      ? Option.none<{ readonly order: ShopOrder; readonly lineItem: OrderLineItem }>()
      : Option.some({ order, lineItem });
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
   * `OrderRow.unassigned` in SQL, bound to the teams the caller read from D1: an order with an
   * open run holding an open task whose team is none of them.
   */
  const unassignedRunOf = (teams: EligibleContext["teams"]) => {
    const liveIds = teams.map(({ id }) => id);
    const unassigned =
      liveIds.length === 0
        ? sql.literal("1 = 1")
        : sql`(s.teamId is null or s.teamId not in ${sql.in(liveIds)})`;
    return sql`exists (
      select 1 from Run r
      where r.orderId = ShopOrder.id and r.state = 'open'
        and exists (
          select 1 from RunTask s
          where s.runId = r.id and s.doneAt is null and ${unassigned}
        )
    )`;
  };

  /**
   * `ListOrdersInput.team`, whose JSDoc carries the rules, as
   * a `where`. The outer run is aliased `wr` because {@link currentWhere}
   * binds `p` for the task's own run inside its subqueries (see its
   * JSDoc).
   *
   * `+s.teamId` is SQLite's unary plus, which keeps that term from
   * choosing an index (https://www.sqlite.org/optoverview.html,
   * "Disabling index use"). Without it `RunTask_teamId_idx (teamId,
   * doneAt)` matches two of the subquery's terms (`currentWhere`
   * starts with `doneAt is null`) against the unique `(runId,
   * position)`'s one, and the planner drives from the team's open
   * tasks once per open order: open orders × the team's open tasks.
   * With it `runId` is the only indexable term on `RunTask`, so the
   * plan is `Run` by `(orderId, state)`, then `RunTask` by `runId`.
   */
  const teamFilterOf = (team: ListOrdersInput["team"]) =>
    team === null
      ? sql.literal("1 = 1")
      : sql`${sql.literal(OPEN)} and exists (
          select 1 from Run wr
          join RunTask s on s.runId = wr.id
          where wr.orderId = ShopOrder.id
            and wr.state = 'open'
            and wr.blockedAt is null
            and +s.teamId = ${team}
            and ${sql.literal(currentWhere("s"))}
        )`;

  /**
   * The orders index's read: one page of orders with their per-order run facts and, under a
   * search, the match count. The Show counts are {@link countOrders}', which depend on less of
   * the input.
   *
   * `show` filters by `OrdersShow`, each SQL fragment restating a
   * branch of `orderPosition` or, for Issues, the union of `orderIssues`'
   * elements; each must move with the function it restates.
   * Open, the open positions and Issues spell out
   * `fulfillmentStatus <> 'FULFILLED' and cancelledAt is null` verbatim so
   * SQLite can prove they are served by the partial `ShopOrder_open_idx`.
   *
   * `q` set means `show` and `team` are not applied: search
   * ignores the filters (`ListOrdersInput.q`).
   *
   * The default read (Making, no team, no search) is linear in open orders because every
   * per-order fact is a probe by the order's id: `Run` through `(orderId, state)`, the item's
   * matches through `Workflow.tag`, the tasks through `runId`. A plan that drives
   * from a table instead of probing it turns the read quadratic in open
   * orders.
   *
   * No transaction: its statements are reads, and a write landing between two of them shows on
   * the next read, which the write's notice asks for.
   */
  const listOrders = Effect.fn("OrderRepository.listOrders")(function* ({
    limit,
    cursor,
    q,
    show,
    team,
    teams,
  }: ListOrdersInput & {
    /** The shop's teams, read live from D1: what `unassigned` is derived against (`OrderRow`). */
    readonly teams: EligibleContext["teams"];
  }) {
    const unassignedRun = unassignedRunOf(teams);
    const teamFilter = teamFilterOf(team);
    /**
     * The open positions partition the open orders by run state and
     * payment, as `orderPosition` says: no open and no done run
     * is `unpaid` or `no_workflow` by `fullyPaid`; an open run with no
     * done run and no started open run is `not_started`; an open run
     * beside a done run or a started open run is `making`; only done
     * runs is `made`. Issues is `OPEN` and the three
     * `orderIssues` elements or'd, each the fragment above that
     * restates it.
     */
    const noRun = (fullyPaid: 0 | 1) =>
      sql.and([
        OPEN,
        `fullyPaid = ${String(fullyPaid)}`,
        `not exists (${OPEN_RUN})`,
        `not exists (${DONE_RUN})`,
      ]);
    const making = () =>
      sql.and([OPEN, `exists (${OPEN_RUN})`, `(exists (${DONE_RUN}) or exists (${STARTED_RUN}))`]);
    const showFilter = Match.value(show).pipe(
      Match.when("unpaid", () => noRun(0)),
      Match.when("no_workflow", () => noRun(1)),
      Match.when("not_started", () =>
        sql.and([
          OPEN,
          `exists (${OPEN_RUN})`,
          `not exists (${DONE_RUN})`,
          `not exists (${STARTED_RUN})`,
        ]),
      ),
      Match.when("making", making),
      Match.when("made", () => sql.and([OPEN, `exists (${DONE_RUN})`, `not exists (${OPEN_RUN})`])),
      Match.when("fulfilled", () =>
        sql.and(["cancelledAt is null", "fulfillmentStatus = 'FULFILLED'"]),
      ),
      Match.when("cancelled", () => sql.literal("cancelledAt is not null")),
      Match.when("issues", () =>
        sql.and([OPEN, sql.or([`(${MULTI_MATCH})`, unassignedRun, `exists (${BLOCKED_RUN})`])]),
      ),
      /**
       * `null` is Making, the default (`OrdersShow`).
       * `"open"` is open work, not everything: the negation of the
       * `fulfilled` and `cancelled` branches above, spelled as `OPEN`
       * so the partial index serves it. `"all"`, `"fulfilled"` and
       * `"cancelled"` are the only values that read a shop's history.
       */
      Match.when(null, making),
      Match.when("open", () => sql.literal(OPEN)),
      Match.when("all", () => sql.literal("1 = 1")),
      Match.exhaustive,
    );
    /**
     * {@link searchTerm}'s reading. An order number matches the name
     * whole: `#10` listing `#1001` … `#1099` read as a guess, and the
     * merchant has the number off the admin. A word is a prefix of the
     * item title, the variant title or the SKU, at the start or after a
     * space ({@link prefixPatterns}), on any of the order's items.
     */
    const searchFilter = Option.match(Option.fromNullOr(q), {
      onNone: () => sql.literal("1 = 1"),
      onSome: (text) => {
        const term = searchTerm(text);
        if (term.kind === "orderName") return sql`name = ${term.name}`;
        const [start, word] = prefixPatterns(term.text);
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
     * when `q` is null (`ListOrdersInput.q`).
     */
    const narrowing = q === null ? [showFilter, teamFilter] : [searchFilter];
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
     * lives in the same SQLite but belongs to
     * the run repository, so this read touches it for counts only.
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
              sum(blockedAt is not null and state = 'open') as blocked,
              sum(startedAt is not null and state = 'open') as started
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
     * `OrderRow.multiMatchItems`, restating `MULTI_MATCH_ITEM` per
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
    const unassignedIds = new Set(unassignedRows.map((row) => String(row[0])));
    const multiMatch = new Map(multiMatchRows.map((row) => [String(row[0]), Number(row[1] ?? 0)]));
    const units = new Map(unitRows.map((row) => [String(row[0]), Number(row[1] ?? 0)]));
    const runs = new Map(
      runRows.map((row) => [
        String(row[0]),
        {
          open: Number(row[1] ?? 0),
          done: Number(row[2] ?? 0),
          blocked: Number(row[3] ?? 0),
          started: Number(row[4] ?? 0),
        } satisfies RunCounts,
      ]),
    );
    /**
     * `OrdersPage.matches`: read only under a search, over every
     * stored order, because the search ignores the filters and the
     * screen's line says how many it found, not how many one page holds.
     */
    const matches =
      q === null
        ? null
        : Number(
            (yield* sql`select count(*) from ShopOrder where ${searchFilter}`.values)[0]?.[0] ?? 0,
          );
    const last = orders.at(-1);
    return {
      orders: orders.map((order) => ({
        order,
        itemUnits: units.get(order.id) ?? 0,
        runs: runs.get(order.id) ?? { open: 0, done: 0, blocked: 0, started: 0 },
        unassigned: unassignedIds.has(order.id),
        multiMatchItems: multiMatch.get(order.id) ?? 0,
      })),
      limit,
      nextCursor: page.length > limit && last !== undefined ? encodeCursor(last) : null,
      matches,
    } satisfies Omit<OrdersPage, "counts" | "openOrders">;
  });

  /**
   * `OrdersPage`'s `counts` and `openOrders`: a function of the team and the live team ids
   * alone, never of the page, the Show value or the search, so a caller may keep one answer for
   * every page, Show value and search under that team.
   *
   * `counts` follows `OrderCounts`: a count is what choosing that value would show, given the
   * team. One count per filter value, narrowed by `team` and by nothing else. It spells out
   * `fulfillmentStatus <> 'FULFILLED' and cancelledAt is null` verbatim so the partial
   * `ShopOrder_open_idx` serves it, which is what keeps a count from reading the shop's whole
   * history.
   */
  const countOrders = Effect.fn("OrderRepository.countOrders")(function* ({
    team,
    teams,
  }: {
    readonly team: ListOrdersInput["team"];
    /** The shop's teams, read live from D1: what `unassigned` is derived against (`OrderRow`). */
    readonly teams: EligibleContext["teams"];
  }) {
    const unassignedRun = unassignedRunOf(teams);
    const teamFilter = teamFilterOf(team);
    /**
     * `OrderCounts` in one statement over the open orders the
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
     * with no `sqlite_stat1` the planner may otherwise drive from `Run`
     * and read every run the retention window keeps, closed orders
     * included. Driven from `ShopOrder_open_idx` through the prefix of
     * `Run_orderId_state_idx`, the read is the open orders' runs only.
     * The correlated fragments in `facts` probe the same index with
     * both terms. The `ShopOrder` columns are qualified for the reason
     * on {@link openAs}.
     */
    const [countRow] = yield* sql`
      with run_summary as (
        select r.orderId,
          sum(r.state = 'open') as openRuns,
          sum(r.state = 'done') as doneRuns,
          sum(r.state = 'open' and r.blockedAt is not null) as blockedRuns,
          sum(r.state = 'open' and r.startedAt is not null) as startedRuns
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
          coalesce(rs.startedRuns, 0) as startedRuns,
          ShopOrder.fullyPaid as fullyPaid,
          (${sql.literal(MULTI_MATCH)}) as multiMatch,
          ${unassignedRun} as unassigned
        from ShopOrder
        left join run_summary rs on rs.orderId = ShopOrder.id
        where ${sql.and([OPEN, teamFilter])}
      )
      select
        count(*),
        sum(${sql.literal(COUNT_FACT.no_workflow)}),
        sum(${sql.literal(COUNT_FACT.not_started)}),
        sum(${sql.literal(COUNT_FACT.making)}),
        sum(${sql.literal(COUNT_FACT.made)}),
        sum(${sql.literal(COUNT_FACT.issues)})
      from facts
    `.values;
    const openOrders = Number(countRow?.[0] ?? 0);
    const counts = {
      no_workflow: Number(countRow?.[1] ?? 0),
      not_started: Number(countRow?.[2] ?? 0),
      making: Number(countRow?.[3] ?? 0),
      made: Number(countRow?.[4] ?? 0),
      issues: Number(countRow?.[5] ?? 0),
    } satisfies OrderCounts;
    return { counts, openOrders } satisfies Pick<OrdersPage, "counts" | "openOrders">;
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
    getOrderByLegacyId,
    getLineItem,
    countOpenOrders,
    markOrdersLimited,
    clearOrdersLimited,
    listOrders,
    countOrders,
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

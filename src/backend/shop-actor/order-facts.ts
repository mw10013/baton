/**
 * The orders index's Show counts as facts per open order, held in memory for the activation.
 * One full read fills them; a notice that names its orders marks those ids, and the next read
 * re-reads only the marked ids, with the same statement.
 *
 * @module
 */
import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Semaphore from "effect/Semaphore";
import type { ShopOrder } from "../../domain/orders.ts";
import type { ShopKey } from "../../domain/platform.ts";
import {
  type OrderCounts,
  type OrderIssue,
  type OrderPosition,
  type OrdersPage,
  orderIssues,
  orderPosition,
  type TeamId,
  type TeamIdName,
} from "../../domain/shop-work.ts";
import type { OrderFactRow, OrderRepository } from "./order-repository.ts";

/** An open order's position: only open orders have facts. */
type OpenPosition = Exclude<OrderPosition, "fulfilled" | "cancelled">;

/**
 * One open order, reduced to what {@link countsOf} reads. Everything that depends on neither the
 * team asked for nor the live teams is decided here, once, through `orderPosition` and
 * `orderIssues`, so no count restates either rule.
 */
export interface OrderFact {
  readonly position: OpenPosition;
  /** `orderIssues` with `unassigned` false: the issues that do not depend on the live teams. */
  readonly issues: ReadonlyArray<Exclude<OrderIssue, "unassigned">>;
  readonly taskTeams: ReadonlyArray<TeamId | null>;
  readonly currentTeams: ReadonlyArray<TeamId>;
}

const isOpenPosition = (position: OrderPosition): position is OpenPosition =>
  position !== "fulfilled" && position !== "cancelled";

/** Reduces a row to its {@link OrderFact}. A row of a closed order is a repository defect. */
export const orderFactOf = (row: OrderFactRow): OrderFact => {
  const position = orderPosition(row);
  if (!isOpenPosition(position))
    throw new Error(`OrderFacts.orderFactOf: orderId=${row.order.id}: a ${position} order`);
  return {
    position,
    issues: orderIssues({ ...row, unassigned: false }).filter(
      (issue): issue is Exclude<OrderIssue, "unassigned"> => issue !== "unassigned",
    ),
    taskTeams: row.taskTeams,
    currentTeams: row.currentTeams,
  };
};

/**
 * `OrdersPage`'s `counts` and `openOrders` for `team` over the open orders' facts, against the
 * live team ids: the orders `team` leaves (`ListOrdersInput.team`), one count per position
 * (`OrderCounts`), and Issues for an order with any `orderIssues` element, `unassigned` being a
 * task team that is null or not live (`OrderRow.unassigned`). Linear in open orders, which
 * `ShopLimits.maxOpenOrders` bounds, so it runs on every read and needs no memo per team.
 */
export const countsOf = (
  facts: Iterable<OrderFact>,
  team: TeamId | null,
  liveTeamIds: ReadonlySet<TeamId>,
): Pick<OrdersPage, "counts" | "openOrders"> => {
  const counts: { -readonly [K in keyof OrderCounts]: number } = {
    no_workflow: 0,
    not_started: 0,
    making: 0,
    made: 0,
    issues: 0,
  };
  let openOrders = 0;
  for (const fact of facts) {
    if (team !== null && !fact.currentTeams.includes(team)) continue;
    openOrders += 1;
    // Unpaid has no strip cell (`OrderCounts`).
    if (fact.position !== "unpaid") counts[fact.position] += 1;
    const unassigned = fact.taskTeams.some((id) => id === null || !liveTeamIds.has(id));
    if (fact.issues.length > 0 || unassigned) counts.issues += 1;
  }
  return { counts, openOrders };
};

/**
 * The facts and the marks against them. `seq` orders every mark, and a mark is retired only by
 * a read that started after it was made, so a write that commits during a read stays marked and
 * the next read takes it.
 *
 * - `facts` null: not read yet in this activation.
 * - `fullAt`: the `seq` the last full read started at.
 * - `shopMarkedAt`: the `seq` of the last whole-shop mark; above `fullAt`, a full read is owed.
 * - `marked`: order id to the `seq` of its latest mark.
 */
interface FactsState {
  facts: Map<ShopOrder["id"], OrderFact> | null;
  seq: number;
  fullAt: number;
  shopMarkedAt: number;
  readonly marked: Map<ShopOrder["id"], number>;
}

/** What a settle reads; also the debug line's `read=`. */
type SettlePlan =
  | { readonly _tag: "Hit" }
  | { readonly _tag: "Patch"; readonly orderIds: NonEmptyReadonlyArray<ShopOrder["id"]> }
  | { readonly _tag: "Full"; readonly reason: "cold" | "shop" | "many" };

/**
 * The marked orders past which one full read costs fewer rows than the patch: the full read's
 * rows over one order's patch, from the rows-read probe (`vp run probe:rows-read`), where 2,400
 * open orders read 87,115 rows in full and one order's patch 45.
 */
const PATCH_LIMIT = 1935;

/** The plan for the state as it is now. */
const planSettle = (state: FactsState): SettlePlan => {
  if (state.facts === null) return { _tag: "Full", reason: "cold" };
  if (state.shopMarkedAt > state.fullAt) return { _tag: "Full", reason: "shop" };
  if (state.marked.size > PATCH_LIMIT) return { _tag: "Full", reason: "many" };
  const [first, ...rest] = state.marked.keys();
  return first === undefined ? { _tag: "Hit" } : { _tag: "Patch", orderIds: [first, ...rest] };
};

/**
 * The orders index's Show counts for the activation, shared by every tab and every team. Built
 * once by the runs service (`makeRuns`), the only caller of its marks: every notice goes through
 * its `notify` or `notifyRuns`, so every write that can move a fact marks it.
 *
 * Never inside a `transaction(…)`: `counts` may read.
 */
export const makeOrderFacts = Effect.fnUntraced(function* ({
  readOrderFacts,
  shop,
}: {
  readonly readOrderFacts: OrderRepository["readOrderFacts"];
  readonly shop: ShopKey;
}) {
  const state: FactsState = { facts: null, seq: 0, fullAt: 0, shopMarkedAt: 0, marked: new Map() };
  /** One settle at a time: concurrent readers of a cold actor share one full read. */
  const settling = yield* Semaphore.make(1);

  /** After a write confined to these orders committed. Reads nothing. */
  const markOrders = (orderIds: ReadonlyArray<ShopOrder["id"]>) =>
    Effect.sync(() => {
      state.seq += 1;
      for (const id of orderIds) state.marked.set(id, state.seq);
    });

  /**
   * After a write that may move any order's facts committed. Reads nothing. Clearing the order
   * marks is safe: the full read now owed covers every order.
   */
  const markShop = Effect.sync(() => {
    state.seq += 1;
    state.shopMarkedAt = state.seq;
    state.marked.clear();
  });

  /**
   * Brings the facts up to every mark made before it started. A write commits before it marks,
   * so every mark at or below `start` is a write the read sees. An interruption or a failure
   * before the install retires nothing, so the marks survive for the next reader.
   */
  const settle = Effect.gen(function* () {
    const start = state.seq;
    const plan = planSettle(state);
    if (plan._tag === "Hit") return plan;
    const rows = yield* readOrderFacts(
      plan._tag === "Full" ? { _tag: "Open" } : { _tag: "Orders", orderIds: plan.orderIds },
    );
    // From here to the retire, no yield: the install and the retire are one step.
    if (plan._tag === "Full") {
      state.facts = new Map(rows.map((row) => [row.order.id, orderFactOf(row)]));
      state.fullAt = start;
    } else {
      const facts = state.facts ?? new Map<ShopOrder["id"], OrderFact>();
      // A marked id with no row is no longer an open order.
      for (const id of plan.orderIds) facts.delete(id);
      for (const row of rows) facts.set(row.order.id, orderFactOf(row));
      state.facts = facts;
    }
    for (const [id, at] of state.marked) if (at <= start) state.marked.delete(id);
    return plan;
  }).pipe(Semaphore.withPermit(settling));

  /**
   * The Show counts for `team`, against `teams`, the live D1 teams the caller read for the same
   * request. Settles first, then derives ({@link countsOf}).
   */
  const counts = Effect.fn("OrderFacts.counts")(function* ({
    team,
    teams,
  }: {
    readonly team: TeamId | null;
    readonly teams: ReadonlyArray<TeamIdName>;
  }) {
    const plan = yield* settle;
    const read = Match.valueTags(plan, {
      Hit: () => "read=hit",
      Patch: ({ orderIds }) => `read=patch orders=${String(orderIds.length)}`,
      Full: ({ reason }) => `read=full reason=${reason}`,
    });
    yield* Effect.logDebug(`OrderFacts.counts: shop=${shop} ${read}`).pipe(
      Effect.annotateLogs({ shop, read: plan._tag }),
    );
    return countsOf(state.facts?.values() ?? [], team, new Set(teams.map(({ id }) => id)));
  });

  return { counts, markOrders, markShop };
});

/** The runs service's order facts; see {@link makeOrderFacts}. */
export type OrderFacts = Effect.Success<ReturnType<typeof makeOrderFacts>>;

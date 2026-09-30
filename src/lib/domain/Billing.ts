/**
 * Vocabulary, billing. What the shop pays for.
 *
 * Billing. Shopify's words, used as Shopify uses them: a plan is what the
 * app defines in the Partner Dashboard, and an app subscription is one
 * shop's purchase of it. "(none)" means no screen says the word:
 *
 * | word             | meaning                                                                      | symbol                                          | screen                         |
 * | ---------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
 * | plan             | the App Pricing tier a shop buys                                             | `Plan`, `PlanHandle`                            | (none): the Manage plan button |
 * | app subscription | one shop's purchase of a plan, as the Partner API reports it; one or none    | `AppSubscription`                               | (none)                         |
 * | billing cycle    | one month of an app subscription; both meters start at zero                  | `ShopUsage` fields `cycleStartAt`, `cycleEndAt` | billing cycle                  |
 * | trial            | the days before an app subscription's first billing cycle; nothing is billed | `AppSubscription` field `cycleStartAt` null     | (none)                         |
 * | meter            | a counter Shopify keeps per app subscription                                 | `USAGE_METER_ORDER`, `USAGE_METER_MEMBER`       | (none)                         |
 * | counted order    | an order Baton created a run for; one unit, once                             | `ShopOrder` field `countedAt`                   | "Orders this billing cycle"    |
 * | seat             | one unit of the members meter; a cycle's seats are its highest member count  | `ShopUsage` field `membersHighWater`            | (none): members                |
 * | included         | a plan's $0.00 first tier on a meter: a paid allowance, not a "free tier"    | `Entitlements`                                  | included                       |
 * | usage event      | one report of units to Shopify, queued until Shopify accepts it              | `UsageEvent`                                    | (none)                         |
 * | expired event    | a usage event dated before the current billing cycle; never sent             | `usageEventIsExpired`                              | (none)                         |
 *
 * "Billing cycle" is the word on screens and in code, and
 * `scripts/rules-lint.ts` refuses its retired synonym in screen copy.
 * "Provisional cycle", "high-water mark" and "boundary" are JSDoc terms on
 * their own symbols ({@link provisionalCycleStart}, {@link seatEventValue},
 * {@link AppSubscription}), not vocabulary words. "Subscription" alone is the
 * live query a socket registers (`Subscription` in Platform); the billing word is
 * always "app subscription".
 */
import { Match, Option, Schema } from "effect";

import { ShopGid, ShopLimits, type ShopSessionRedacted } from "./Platform.ts";

/**
 * The plan handles Shopify may report for a shop's app subscription.
 *
 * Two handles, two tiers, and no private `-test` variants: a development store
 * in the same Partner organization is granted every public plan at $0, which
 * is the whole thing a store-restricted private plan would have bought.
 *
 * The allowlist is total and identical in every environment: a handle outside
 * it means the catalog changed under us, which must resolve to no access rather
 * than a guess.
 *
 * The literals are the plan handles configured in the Partner Dashboard for
 * every environment's app, so renaming a plan there is a rename here.
 */
export const PlanHandle = Schema.Literals(["baton-basic", "baton-pro"]);
export type PlanHandle = typeof PlanHandle.Type;

export const Plan = Schema.Literals(["basic", "pro"]);
export type Plan = typeof Plan.Type;

/**
 * Normalization, not entitlement. The mapping exists so nothing downstream has
 * to learn Shopify's plan handles ({@link PlanHandle}); what each tier
 * *grants* is {@link entitlementsOfPlan}.
 */
export const planOfHandle = (handle: PlanHandle): Plan =>
  handle === "baton-pro" ? "pro" : "basic";

/** What a plan includes: the $0.00 first tier of each meter. */
export interface Entitlements {
  /** Counted orders ({@link ShopUsage.ordersThisCycle}) included per billing cycle. Past this the usage meter bills; nothing blocks until {@link ShopLimits.maxOrdersPerCycle}. */
  readonly ordersPerCycle: number;
  /**
   * Seats included; seats past this many are billed by the
   * {@link USAGE_METER_MEMBER} meter, never refused. Nothing in the app
   * compares the member count to this number except the home page's Members tile:
   * the meter's $0.00 band absorbs the included seats, so the object sends the
   * member count and Shopify prices it. The only refusal is
   * {@link ShopLimits.maxMembers}, which is plan-independent.
   */
  readonly membersIncluded: number;
}

/**
 * What each tier grants. The Worker owns this table and the Durable Object
 * never sees it, but the split is *compare here, count there*, not "pass the
 * number in": `ordersPerCycle` is compared in the Worker against the
 * {@link ShopUsage} row the object keeps and reports, and `membersIncluded` is
 * compared nowhere but the home page's Members tile; the member count reaches
 * the object as a number to send ({@link RecordMemberCountInput}), not to compare.
 * Neither entitlement reaches `ShopAgent`, so the object stores no plan state
 * to fall out of sync, and an upgrade or downgrade lands on the very next page
 * load with nothing to invalidate. The one plan-adjacent fact the
 * object does hold is the billing cycle (see {@link ShopUsage}), which is a
 * date range, not an entitlement.
 *
 * `satisfies Record<Plan, Entitlements>` makes the lookup total by
 * construction — a new `Plan` literal fails to compile here.
 *
 * Provisional. Working proposals, not tuned figures: nothing was measured to
 * arrive at them and nothing should be derived from them. Change freely, and
 * move the Partner Dashboard plan copy (and the table in `README.md`) with
 * them. `ordersPerCycle` must equal tier 1 of the {@link USAGE_METER_ORDER}
 * meter on that plan — the **included allowance**, the band priced at $0.00 —
 * or the merchant is billed for an order the app calls included; the same
 * holds for `membersIncluded` and tier 1 of {@link USAGE_METER_MEMBER}. It is not a
 * "free tier": the allowance is what the app subscription already paid for.
 * Nothing verifies the two agree; it is operator discipline, because the meter
 * lives in the Partner Dashboard and the app cannot read its tiers.
 *
 * Raising a limit is always safe; lowering one is not, with no grandfathering:
 * a cut applies to existing shops immediately. A cut to `membersIncluded`
 * only moves the $0.00 band; nobody loses access.
 */
const ENTITLEMENTS = {
  basic: { ordersPerCycle: 20, membersIncluded: 3 },
  pro: { ordersPerCycle: 30, membersIncluded: 10 },
} as const satisfies Record<Plan, Entitlements>;

export const entitlementsOfPlan = (plan: Plan): Entitlements =>
  ENTITLEMENTS[plan];

/**
 * The widest tier, for callers that need a ceiling rather than a particular
 * shop's grant — e.g. a local-only e2e fixture with no merchant and no plan to
 * resolve.
 */
export const MAX_ENTITLEMENTS: Entitlements = ENTITLEMENTS.pro;

/**
 * The App Pricing usage meter handle for a counted order, identical on every
 * plan. Case-sensitive; must match the Partner Dashboard exactly, because the
 * App Events API answers `202` to a handle that matches no meter and the event
 * is then silently non-billable. Each meter is one handle across tiers so the
 * meter's own graduated tiers — not the event — decide what a unit costs.
 */
export const USAGE_METER_ORDER = "production-orders";

/** The App Pricing usage meter handle for seats; same rules as {@link USAGE_METER_ORDER}. The value sent is {@link seatEventValue}. */
export const USAGE_METER_MEMBER = "members";

/**
 * What the shop's app subscription grants right now. Nothing is scheduled: a
 * plan change on Shopify's pricing page applies at once, up or down, and lands
 * on the revalidation the billing redirect forces. App Pricing defers only a
 * downgrade to a free plan, and Baton has none
 * (https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-subscription-charges#proration-logic).
 */
export const PlanStatus = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Subscribed"),
    handle: PlanHandle,
    plan: Plan,
    /** The next app subscription boundary as epoch milliseconds: cycle end, or trial end during a trial. */
    boundaryAt: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ _tag: Schema.Literal("Unsubscribed") }),
]);
export type PlanStatus = typeof PlanStatus.Type;

/**
 * A resolved app subscription (Shopify's `AppSubscription`): the one
 * allowlisted plan handle it carries, the billing cycle it is in, and what
 * Shopify has metered this cycle.
 *
 * `boundaryAt` collapses two Shopify fields that never coexist —
 * `currentBillingCycle.endTime` is null during a trial, where `trialEndsAt`
 * takes over. Both denote the same thing to a cache: the next instant at
 * which the app subscription may legitimately change without any
 * notification, since App Pricing sends no webhooks.
 *
 * A plan change is a new app subscription: a new billing cycle starting at
 * the switch moment, with every meter at zero. Usage sent during a trial is
 * not reported and does not carry into the paid cycle. Accepted usage shows
 * on the meter within about 30 s. Measured on the dev store on 2026-09-22.
 * This is why the seat meter is sent the whole member count at each new cycle
 * (the "cycle pushed, new start" row on {@link ShopUsage}) rather than an
 * overage: the plan's tiers price it, so a switch needs no app-side
 * arithmetic.
 */
export const AppSubscription = Schema.Struct({
  handle: PlanHandle,
  boundaryAt: Schema.NullOr(Schema.Number),
  /** `currentBillingCycle.startTime`; null during a trial, which has no cycle. */
  cycleStartAt: Schema.NullOr(Schema.Number),
  /** Shopify's own quantity per meter this cycle, null when the app subscription lacks that meter's item; the figures local counting is reconciled against. */
  usage: Schema.Struct({
    orders: Schema.NullOr(Schema.Number),
    members: Schema.NullOr(Schema.Number),
  }),
});
export type AppSubscription = typeof AppSubscription.Type;

/**
 * What one shop has consumed, as the Durable Object counts it. The Worker
 * compares this against {@link Entitlements}; the object itself enforces
 * nothing from it beyond {@link ShopLimits}.
 *
 * The count is keyed by billing cycle, not by calendar month, because the
 * same count is what the merchant is billed for: the home page and the
 * Shopify invoice have to agree about which orders fall in a billing cycle,
 * and only Shopify knows where one starts.
 *
 * What each trigger does to the order count ({@link
 * ShopUsage.ordersThisCycle}), the seat mark ({@link
 * ShopUsage.membersHighWater}) and the usage-event queue ({@link UsageEvent}).
 * `—` is unchanged; `recounted` is the orders whose `countedAt` is at or after
 * the new cycle's start; "then sent" is a flush after the write commits:
 * every path that creates a run sends the queue, and a cycle push is sent by
 * the reconcile push that follows it (the rule and its tests are on
 * `ShopAgent`'s `flushUsageEvents`). A row's mechanics are on the method that
 * carries it (`OrderRepository.countOrder`, `recordMemberCount`, `setBillingCycle`,
 * `flushUsageEvents`, `sweepExpiredOrders`). `pnpm spec check` parses the
 * table, refuses a count or mark cell outside these words, and refuses a pinned
 * title no test carries; a behaviour change starts at the row.
 *
 * | trigger                                         | order count | seat mark               | queue                                                                           | pinned by                                                                                                                                 |
 * | ----------------------------------------------- | ----------- | ----------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
 * | first run on an order                           | +1          | —                       | +1 order event, then sent                                                       | an order is counted once, when its first run is created                                                                                   |
 * | another run on a counted order                  | —           | —                       | —                                                                               | a re-sync never queues a second count                                                                                                     |
 * | run on a seeded order                           | —           | —                       | —                                                                               | a seeded order is never counted                                                                                                           |
 * | member added, member count above the mark       | —           | → member count          | +1 seat event (the rise), then sent                                             | an add past the high-water mark queues one seat event and raises the mark                                                                 |
 * | member added, member count at or below the mark | —           | —                       | —                                                                               | an add at or under the high-water mark queues nothing                                                                                     |
 * | member removed                                  | —           | —                       | —                                                                               | a member removal queues nothing and leaves the mark                                                                                       |
 * | first count, no cycle stored yet                | +1          | → 0                     | +1 order event                                                                  | opens a provisional cycle before a billing cycle is known                                                                                 |
 * | first count past the cycle end                  | recounted   | → 0                     | —                                                                               | rolls the cycle forward on the first order past its end                                                                                   |
 * | cycle pushed, same start                        | —           | → member count if above | +1 seat event (the rise), then sent                                             | an unchanged cycle raises the mark to a member count past it, so an add whose recordMemberCount failed is billed at the next revalidation |
 * | cycle pushed, new start                         | recounted   | → member count          | seat events in the cycle dropped; +1 seat event (whole member count), then sent | a new cycle resets the mark to the member count and queues it as the cycle's first seat event                                             |
 * | cycle pushed, shop never addressed              | recounted   | → member count          | every event before the start dropped, then sent                                 | the first billing cycle discards events queued before the shop could be addressed                                                         |
 * | revalidation during a trial                     | —           | —                       | —                                                                               | pushes no billing cycle during a trial, which has none                                                                                    |
 * | Manage plan pressed                             | —           | —                       | sent                                                                            | Manage plan sends the usage queue before the plan can change                                                                              |
 * | Shopify accepts an event                        | —           | —                       | row deleted                                                                     | flush deletes accepted events and keeps refused ones with the error                                                                       |
 * | Shopify refuses an event                        | —           | —                       | `attempts` +1, `lastError` set                                                  | flush deletes accepted events and keeps refused ones with the error                                                                       |
 * | an event's billing cycle ends unsent            | —           | —                       | row expired; kept, never sent                                                   | a queued event expires once the cycle that dated it has ended: skipped by the flush and reported apart                                    |
 * | retention sweep, expired event over 60 days old | —           | —                       | row deleted                                                                     | the retention sweep deletes expired usage events older than 60 days and keeps younger ones                                                |
 *
 * The rows rely on three assumptions:
 *
 * 1. A billing cycle starts where the previous one ended. The seat mark's
 *    same-start check depends on it. A plan change starts a new app
 *    subscription with its meters at zero, where sending the member count again is
 *    correct billing.
 * 2. Billing cycles are a month or less. The recount is wrong for a longer
 *    cycle (`OrderRepository.countedSince`), and the Partner Dashboard offers
 *    usage meters on monthly plans only.
 * 3. A trial's counted orders count toward {@link ShopLimits.maxOrdersPerCycle}.
 *    Decided, not an oversight: the ceiling is provisional, and the first
 *    billing cycle recounts them out and clears the refusal.
 */
export const ShopUsage = Schema.Struct({
  /**
   * The billing cycle the count belongs to. Both null until the object's
   * first count opens a provisional cycle ({@link provisionalCycleStart}) or
   * the Worker pushes a real one ({@link BillingCycleInput}); `cycleEndAt`
   * is null again after the object rolls a cycle forward on its own, until
   * the next push names the end.
   */
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  /**
   * Counted orders this cycle: orders Baton created a run for, not orders
   * stored (`OrderRepository.countOrder` is the rule). Never decremented. It
   * is also what {@link cycleAtOrderCeiling} reads, so the ceiling bounds
   * work started, which is the billable quantity, rather than rows.
   */
  ordersThisCycle: Schema.Number,
  /** Set when a new order was refused because of {@link ShopLimits.maxOrdersPerCycle}; null once the cycle rolls. */
  ordersLimitedAt: Schema.NullOr(Schema.Number),
  /** Set when reconcile declined to auto-create a run because of `ShopLimits.maxOpenRuns`; null once under the ceiling again. */
  openRunsLimitedAt: Schema.NullOr(Schema.Number),
  /** `ctx.storage.sql.databaseSize` at read time. */
  databaseSize: Schema.Number,
  lastSweepAt: Schema.NullOr(Schema.Number),
  /** Usage events queued for the current cycle and not yet accepted by Shopify. Non-zero for long is an operator signal, not a merchant-facing number. */
  pendingUsageEvents: Schema.Number,
  /** Expired usage events ({@link usageEventIsExpired}) from the last {@link ShopLimits.expiredUsageEventRetentionDays} days; older ones are deleted. Each is a unit carried and never billed. */
  expiredUsageEvents: Schema.Number,
  /** The {@link USAGE_METER_ORDER} share of {@link pendingUsageEvents}, as units; the tolerance of the orders drift check. */
  pendingOrderUnits: Schema.Number,
  /** The {@link USAGE_METER_MEMBER} share of {@link pendingUsageEvents}, as units; the tolerance of the members drift check. */
  pendingMemberUnits: Schema.Number,
  /**
   * The cycle's seats: its high-water mark, as {@link seatEventValue}
   * defines it. Everything sent to {@link USAGE_METER_MEMBER} this cycle sums
   * to this number once the queue drains.
   */
  membersHighWater: Schema.Number,
  /**
   * Shopify's own {@link USAGE_METER_ORDER} reading at the last revalidation;
   * null until one has reported it. Diagnostic only — nothing is corrected
   * from it.
   *
   * Null can also mean the app subscription cannot report at all. Shopify
   * reports the quantity on the meter's *subscription item*, and an app
   * subscription carries the item set it was created with: a shop that
   * subscribed before the meter was configured on its plan has no meter item
   * and never will, however many events are accepted. Only a new app
   * subscription — any plan switch — brings the item, which then reports from
   * zero. Measured on 2026-09-19: the pre-meter app subscription listed one
   * `FlatRatePrice` item after seven accepted events; the replacement listed
   * the meter at `quantity: 0` before any.
   */
  lastReconciledOrders: Schema.NullOr(Schema.Number),
  /** Shopify's own {@link USAGE_METER_MEMBER} reading at the last revalidation; null under the same conditions as {@link lastReconciledOrders}. */
  lastReconciledMembers: Schema.NullOr(Schema.Number),
});
export type ShopUsage = typeof ShopUsage.Type;

/**
 * The billing cycle `SubscriptionPlan` pushes into the object after a plan
 * revalidation outside a trial. Plain RPC input: a browser has no business
 * naming a shop's billing cycle, and the object has no way to learn it on its
 * own. What the push does is the "cycle pushed" rows on {@link ShopUsage}.
 *
 * `shopGid` rides along because the object needs it to address a usage event
 * at Shopify and has no other source for it — it lives on the D1 `ShopSession`
 * row, which is the Worker's.
 */
export const BillingCycleInput = Schema.Struct({
  shopGid: ShopGid,
  cycleStartAt: Schema.Number,
  cycleEndAt: Schema.NullOr(Schema.Number),
  /** The D1 member count, read by the Worker just before the push; the seat mark a new cycle starts from. */
  memberCount: Schema.Number,
});
export type BillingCycleInput = typeof BillingCycleInput.Type;

/**
 * The provisional cycle: the stand-in a shop counts against until the first
 * `setBillingCycle` names a real billing cycle, starting at the first instant
 * of `now`'s UTC month.
 *
 * A shop opens its cycle at its first count, which can land before its first
 * plan revalidation — a webhook arrives on the install's heels, and the
 * revalidation is a separate request that may be minutes behind — or during
 * a trial, which has no billing cycle. Opening a provisional cycle is what
 * lets a run created then count; the first billing cycle replaces it (the
 * "cycle pushed, shop never addressed" row on {@link ShopUsage}).
 *
 * UTC, not the shop's timezone: the object has no locale, and a boundary that
 * moved with the merchant's would make a stored cycle ambiguous.
 */
export const provisionalCycleStart = (now: number) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/**
 * Shopify's meter readings for the current cycle, which `SubscriptionPlan`
 * pushes after every revalidation for the divergence checks on
 * {@link ShopUsage.lastReconciledOrders} and
 * {@link ShopUsage.lastReconciledMembers}; null where the app subscription
 * lacks the meter. Plain RPC input for the same reason as
 * {@link BillingCycleInput}. The push also sends the queue.
 */
export const ReconcileUsageInput = Schema.Struct({
  orders: Schema.NullOr(Schema.Number),
  members: Schema.NullOr(Schema.Number),
});
export type ReconcileUsageInput = typeof ReconcileUsageInput.Type;

/**
 * One App Events billing event: one counted order, or seats past the cycle's
 * high-water mark.
 *
 * `idempotencyKey` is permanent at Shopify and capped at 64 characters, which
 * is why it is derived from the order id or the cycle and mark rather than
 * from a clock: replaying a flush must not bill twice.
 */
export const UsageEvent = Schema.Struct({
  shopGid: ShopGid,
  eventHandle: Schema.NonEmptyString,
  /** When the order was counted, not when the event is sent: Shopify rejects a timestamp outside the merchant's current cycle. */
  occurredAt: Schema.Number,
  idempotencyKey: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  /**
   * A positive integer: `1` for an order, and for seats the member count at a
   * new cycle or the rise over the high-water mark ({@link seatEventValue}).
   * Positive because both meters only count up — an order is billed the first
   * time Baton creates a run for it (`OrderRepository.countOrder`), a seat
   * mark is never lowered by a removal — and nothing is ever reversed, so zero
   * or a negative could only be a bug.
   */
  value: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
export type UsageEvent = typeof UsageEvent.Type;

/**
 * A queued usage event expires once the billing cycle that dated it has
 * ended: Shopify refuses an event whose timestamp falls in a closed cycle, so
 * retrying it can only fail. Expired rows are skipped by the flush and reported
 * apart from the live queue ({@link ShopUsage.expiredUsageEvents}) — a count of
 * orders the merchant carried and was never billed for is an operator
 * signal, not something to retry into or hide inside the reconcile
 * tolerance. They are kept for {@link ShopLimits.expiredUsageEventRetentionDays}
 * days after they were dated, then the retention sweep deletes them.
 */
export const usageEventIsExpired = (occurredAt: number, cycleStartAt: number) =>
  occurredAt < cycleStartAt;

/**
 * The cycle is at its ceiling when {@link ShopUsage.ordersThisCycle} — orders
 * Baton created a run on, not orders stored — has reached
 * {@link ShopLimits.maxOrdersPerCycle}, past which no *new* order is stored for
 * the rest of the cycle.
 *
 * The one hard stop on orders, and it is positioning rather than protection:
 * storage is nowhere near its limit at this volume, but a shop above it is
 * outside what Baton is built for, and saying so with a number the merchant can
 * read beats letting an import fail late inside a stream. Updates to orders
 * already stored keep flowing — the production floor must not lose the work it
 * is already carrying.
 *
 * **An order refused here is lost to Baton for the rest of the cycle.** The
 * webhook path answers Shopify 2xx without storing it, because a 5xx would
 * only have Shopify retry for four hours against a condition that four hours
 * cannot clear; Shopify does not redeliver afterwards, and nothing re-reads
 * the gap. What recovers it is the merchant: once the cycle rolls over,
 * Import open orders re-fetches whatever is still open
 * (`ShopAgent.syncOrders`). `ShopUsage.ordersLimitedAt` is what raises the
 * banner saying so.
 */
export const cycleAtOrderCeiling = (ordersThisCycle: number) =>
  ordersThisCycle >= ShopLimits.maxOrdersPerCycle;

/**
 * A shop's members are at their ceiling when there are
 * {@link ShopLimits.maxMembers} members, on any plan. `Repository.addMember`
 * refuses a new email there, and the merchant is told to contact support. It
 * is the one refusal on the members: {@link Entitlements.membersIncluded} bills,
 * it does not block.
 */
export const membersAtCeiling = (count: number) =>
  count >= ShopLimits.maxMembers;

/**
 * The seat units to queue when the member count reaches `memberCount`: the rise over
 * the cycle's high-water mark, or `0` when not past it.
 *
 * The billable seat quantity for a cycle is its high-water mark: the member
 * count at cycle start, plus one for each add that raises the mark. A removal
 * never lowers it, so remove-then-add inside a cycle bills once, and nothing
 * sent is ever reversed. The arithmetic, not the constant `1`, is the rule: a
 * count that grew by more than one between reports still sends exactly the
 * rise.
 */
export const seatEventValue = (memberCount: number, highWater: number) =>
  Math.max(memberCount - highWater, 0);

/**
 * A usage meter diverges when Shopify's reading and the local figure differ by
 * more than the units still queued for that meter. Pending units are a gap
 * the next flush closes; expired ones ({@link usageEventIsExpired}) never close, so
 * they are not tolerated, and a tolerance that grew with every lost event
 * would hide the loss it exists to show. Each meter tolerates only its own
 * pending units ({@link ShopUsage.pendingOrderUnits},
 * {@link ShopUsage.pendingMemberUnits}).
 */
export const meterDiverges = (input: {
  readonly local: number;
  readonly shopify: number;
  readonly pending: number;
}) => Math.abs(input.local - input.shopify) > input.pending;

/**
 * The member count the members page's add reports (`ShopAgent.recordMemberCount`).
 * Plain RPC input: the members are D1's, and the object cannot count it. What
 * it does is the "member added" rows on {@link ShopUsage}.
 */
export const RecordMemberCountInput = Schema.Struct({ size: Schema.Number });
export type RecordMemberCountInput = typeof RecordMemberCountInput.Type;

/**
 * Why the shop's cached plan entry reads the way it does.
 *
 * Deliberately finer-grained than `SubscriptionPlan`'s internal `cachedStatus`,
 * which collapses every reason for distrusting the entry into a single
 * `Option.none()` and revalidates. That is the right shape for the enforcement
 * path, which only needs to know *whether* to call Shopify; it is the wrong
 * shape for an admin diagnosing why a shop is being treated the way it is,
 * where "never fetched", "expired an hour ago", and "handle this build no
 * longer recognizes" have three different remedies.
 *
 * `Unrecognized` is the case the `ShopSession.planHandle` column exists in its
 * `Schema.String` form to survive, so the admin page shows the stored string
 * rather than hiding it behind a decode failure.
 */
export type AdminShopPlanCache =
  | { readonly _tag: "NeverFetched" }
  | { readonly _tag: "Unsubscribed" }
  | {
      readonly _tag: "Subscribed";
      readonly handle: PlanHandle;
      readonly plan: Plan;
    }
  | { readonly _tag: "Stale"; readonly handle: string | null }
  | { readonly _tag: "Unrecognized"; readonly handle: string };

export const adminShopPlanCache = (
  {
    planHandle,
    planHandleExpiresAt,
  }: Pick<ShopSessionRedacted, "planHandle" | "planHandleExpiresAt">,
  now: number,
): AdminShopPlanCache => {
  if (planHandleExpiresAt === null)
    return planHandle === null
      ? { _tag: "NeverFetched" }
      : { _tag: "Stale", handle: planHandle };
  if (now >= planHandleExpiresAt) return { _tag: "Stale", handle: planHandle };
  if (planHandle === null) return { _tag: "Unsubscribed" };
  return Option.match(Schema.decodeUnknownOption(PlanHandle)(planHandle), {
    onNone: (): AdminShopPlanCache => ({
      _tag: "Unrecognized",
      handle: planHandle,
    }),
    onSome: (handle) => ({
      _tag: "Subscribed",
      handle,
      plan: planOfHandle(handle),
    }),
  });
};

/**
 * What the cached entry grants, or `null` when it grants nothing. Every
 * non-`Subscribed` state — including `Stale`, which may well hold a handle —
 * yields `null` rather than the handle's tier: a deadline that has passed is
 * exactly the case where the stored handle is not evidence of anything, and an
 * admin page must not render a ceiling the enforcement path would refuse to
 * honor.
 */
export const adminShopEntitlements = Match.typeTags<
  AdminShopPlanCache,
  Entitlements | null
>()({
  Subscribed: ({ plan }) => entitlementsOfPlan(plan),
  Unsubscribed: () => null,
  Stale: () => null,
  NeverFetched: () => null,
  Unrecognized: () => null,
});

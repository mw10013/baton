# Member overage instead of a member cap: research

Date: 2026-09-22. Revision 3, probe run; results in section 9.

Question: should Baton stop capping members per plan and instead let a shop go
past the included seats for a charge, the way orders already work? What would
that do to downgrades, and can a merchant understand it?

## 1. Where things stand

Baton has two paid monthly plans, no free plan, one usage meter, and a per-plan
seat cap enforced at add time and at sign-in time.

| Plan  | Monthly | Trial   | Orders included | Order overage | Seats |
| ----- | ------- | ------- | --------------- | ------------- | ----- |
| Basic | $29     | 14 days | 20              | $0.15         | 3     |
| Pro   | $79     | none    | 30              | $0.10         | 10    |

Numbers are provisional (`ENTITLEMENTS` in `src/lib/Domain.ts`, `README.md`
"Plans").

How the two limits behave today:

- **Orders** are metered. `ordersPerCycle` is the $0 band of a graduated meter
  (`production-orders`, `orders-synced` at the time of the probe). An order is counted once when its first run is created and
  never reversed. Nothing blocks until the hard ceiling
  `ShopLimits.maxOrdersPerCycle` (10,000), which is enterprise fencing, not a
  tier.
- **Members** are capped. `addMember` refuses past `maxMembers`
  (`MemberLimitError`, "Your plan allows N members. Upgrade to add more."). On
  a downgrade nothing is written: `memberHasSeat` ranks members by `createdAt`
  then `email`, and only the first `maxMembers` can sign in. The members page
  badges the rest "No seat" and says "Only the N oldest can sign in until you
  remove members or upgrade."

The downgrade rule is already not an arbitrary cut-off in the sense of deleting
anyone. It locks out the newest members and leaves the roster intact. The
merchant still has to choose who goes, and a member who was working on Friday
cannot sign in on Monday because of a billing decision they did not see.

Members are `Member` rows in D1 (`migrations/0001_init.sql`), not in the
`ShopAgent` SQLite. The 10 GB Durable Object limit is not what bounds them; a
hard member ceiling would be about D1 row counts, roster page size, and abuse,
which still justifies one. There is no such ceiling today: `ShopLimits` has
`maxTeams`, `maxOpenRuns`, `maxOrdersPerCycle`, `maxLineItemsPerOrder`, and no
`maxMembers`.

## 2. What Route to Ship does

`refs/route-to-ship/pricing.md`. It is not usage metering for seats.

- Seats past the plan's included count are a **recurring add-on**: $15, $12,
  $10, $6 per extra user per month, cheaper on higher tiers "so upgrading is
  always the better deal once you need 3+ extras".
- Orders past the included count are a **per-order overage** ($0.15, $0.10,
  $0.05), the model Baton already copied.
- Their FAQ: "What happens if I exceed my user limit? On paid plans, add an
  extra-user seat as an add-on." So the merchant adds seats deliberately; a
  seat is not created as a side effect of inviting someone.
- "Downgrades apply at the end of your current billing period." Baton measured
  App Pricing paid-to-paid changes applying at once
  (`docs/plan-change-timing-research.md`), so Route to Ship is either on the
  legacy Billing API or describing policy rather than mechanism.
- Free plan: 1 user, no add-on. Baton has no free plan, so every Baton shop is
  on a plan where overage could apply.

Their model is "a seat is a thing you buy". Ours would be "a seat is a thing
you use". The difference matters for the questions below.

## 3. What App Pricing can and cannot do

From `refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing/`.

Can:

- Up to five usage meters per plan, six tiers each, fixed, graduated, or volume
  pricing (`setup-usage-charges.md`, "Limitations"). A second meter for seats
  fits.
- A meter's tier 1 can be priced at $0, which is how `ordersPerCycle` is an
  included allowance today. A seat meter would do the same: units 1 to 3 at $0
  on Basic, units 1 to 10 at $0 on Pro, then a per-unit price.
- Negative `value` reverses usage within the current cycle
  (`build-billing-event.md`, "Reverse or correct usage"). Decrementing on
  member removal is technically possible.
- `activeSubscription.items[].usage.quantity` reports Shopify's own count for
  the cycle, so the app can reconcile.

Cannot:

- **Usage caps are not supported.** There is no way to tell Shopify "stop
  billing at N". A ceiling has to be enforced in the app, as
  `maxOrdersPerCycle` is now.
- **No recurring add-ons.** App Pricing plans have one flat monthly price and
  meters. Route to Ship's "$15/mo per extra user" line item does not exist in
  App Pricing; the only way to charge for a seat is a usage event. A "monthly
  seat" is therefore a usage event of value 1 per seat per cycle, or a
  fractional event per day, not a subscription line.
- **The docs say nothing about what happens to meter usage on a mid-cycle
  plan change.** Not in `setup-usage-charges.md`, not in
  `combined-subscription-and-usage.md`, not in `setup-subscription-charges.md`
  ("Proration logic" is one sentence about paid-to-free). The
  `activeSubscription` docs say `usage` is "for the current billing cycle".
  Whether a paid-to-paid switch starts a new cycle, carries the old meter
  quantity into the new plan's tiers, or bills the old plan's usage at the
  switch and starts the new plan's meter at zero, is undocumented. Measured
  in section 9: a plan change starts a new contract and a new cycle, and the
  old meter quantity is gone.
- Events are permanently idempotent and must carry a timestamp inside the
  current cycle, so a seat event cannot be back-dated into a closed cycle.

The orders meter has the same undocumented plan-change behavior today, and
Baton has been living with it because an order is counted once and the
included allowance is generous. Seats are different: they are a standing
quantity, not a stream of events, so "how many were used this cycle" needs a
definition.

## 4. What "metering seats" would have to mean

A seat is a standing quantity, not an event, and a usage meter starts every
cycle at zero. So a seat rule has two parts: what is sent at the start of a
cycle for the roster that is already there, and what is sent mid-cycle when
the roster grows. Three candidates:

**A. High-water mark per cycle.** The billable quantity for a cycle is the
largest roster size the shop reached during it. Two kinds of event carry it:

- At cycle start, one event whose value is the roster size at that moment.
  Baton learns of a cycle roll on the revalidation after the boundary (the
  clamp in `planHandleExpiresAt` exists for this), so the event is sent then,
  timestamped inside the new cycle, and the meter's $0 band absorbs the
  included seats.
- Mid-cycle, when an add pushes the roster past the cycle's high-water mark,
  one event of value 1. An add that refills a slot freed earlier in the cycle
  sends nothing. Removal sends nothing.

This is the "once you increment you pay" rule you proposed, made complete: a
standing roster of five on Basic is billed two seats every month, not only
the month the adds happened.

**B. Roster size at cycle boundary only.** The cycle-start event and nothing
else. Adds inside the cycle are billed next cycle if the member is still
there. Add-and-remove inside a cycle costs nothing.

**C. Seat-days.** Fractional events pro-rating a seat by the days it was
held. Faithful, illegible to merchants, and the most code. Rejected.

Where A and B differ:

| Concern                         | A: high-water                                                                             | B: boundary only                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Merchant can predict the bill   | Yes: "you added a 4th member, that is $X this month"                                      | Partly: the bill depends on the roster at a date they do not see |
| Add-then-remove inside a cycle  | Charged once                                                                              | Not charged                                                      |
| Gaming                          | None worth doing                                                                          | Remove before the boundary, re-add after, pay nothing            |
| Reversal on removal             | None, by rule                                                                             | None needed                                                      |
| Matches the orders meter's rule | Yes: count once, never reverse                                                            | No                                                               |
| Code                            | A cycle-roll event plus one event on the add path, gated by a per-cycle high-water column | The cycle-roll event alone                                       |

Both need the cycle-roll event, and its timing is the same in both: Baton
learns of the roll late, by up to the plan cache age, and the event's
timestamp must fall inside the new cycle. The orders meter already reconciles
against `usage.quantity` on revalidation, and the seat meter would ride the
same read. What the app has to store is one number in `ShopUsage`, the
high-water mark for the current cycle, reset on the roll.

A is the recommendation. It is the rule the orders meter follows, the merchant
sees the charge at the moment they caused it, and there is nothing to gain by
removing and re-adding. In code, the mid-cycle rule is: on add, if the new
roster size is greater than the cycle's stored high-water mark, set the mark
to the new size and send one event; otherwise send nothing. The meter's $0
band, not the app, decides whether that unit costs anything, so the app never
compares against `maxMembers` on the add path at all. Today `addMember`
compares against `maxMembers` to refuse; the comparison goes away.

The cost of A is that a member added and removed the same day still costs a
seat for the month. You called that acceptable because adding a member is
deliberate. It also matches how every seat-based SaaS bills.

## 5. The downgrade conundrum

Pro, 10 members, downgrade to Basic (3 included). What happens to the seven?

Under A, nothing happens at the moment of downgrade. The seven keep their
seats. The seat meter is now Basic's meter, and the question is whether
Shopify sees 0 or 10 units on it.

- If a plan change **resets the meter** (new cycle, quantity 0): it is a
  cycle roll, and rule A's cycle-start event sends the roster size (10) on the
  first revalidation after the change, which the redirect forces. Basic's $0
  band absorbs three and seven are billed. No new code beyond the cycle-roll
  path, provided Baton treats a changed `cycleStartAt` as a roll.
- If a plan change **carries usage over** onto the new plan's tiers: the ten
  units are already there, and Basic's tiers price seven of them. Nothing to
  send.
- If a plan change **closes the old cycle** and bills it: same as reset, plus
  the old plan's usage is invoiced early.

Section 9 measured the first branch: the meter resets. So the cycle-start
event on the first revalidation after a handle change is the mechanism, and
"treat a changed `cycleStartAt` as a roll" is the rule.

Whichever branch, the merchant story is the same and it is a good one: "After
you downgrade, members past the included count are billed per seat. Remove
members to stop the charge. Nobody is locked out." That replaces "Only the 3
oldest can sign in", which is the sentence most likely to generate a support
ticket today.

The upgrade direction is simpler: Basic with 5 members (2 billed) upgrades to
Pro (10 included). The two overage units should stop being billed. If the
meter carries over, Pro's $0 band absorbs them. If it resets, there is nothing
to do. Either way no event is sent.

## 6. Business case

For overage:

- **No lockout on downgrade.** The main reason you raised it. A merchant who
  downgrades to save $50 and finds seven staff locked out on Monday morning
  uninstalls. One who sees "$X per extra member" on the bill removes members
  at their own pace or goes back to Pro.
- **Revenue from the gap between 3 and 10.** A shop with 4 or 5 people is
  told today to pay $79 for Pro. With overage they stay on Basic and pay $29
  plus one or two seats. That is less revenue per such shop but more shops
  that stay subscribed, and the seat price can be set so that Pro wins at
  around the fifth or sixth member, as Route to Ship prices theirs.
- **Symmetry.** Orders already work this way. "N included, then $X each" on
  both lines is one rule for the merchant to learn instead of two.
- **Less code, not more, on the entitlement side.** `MemberLimitError`, the
  add-time refusal, the "No seat" badge, the seatless banner, and the
  sign-in-time seat check all go. What replaces them is a cycle-roll event, one
  event on the add path, one column, and a hard ceiling that almost nobody
  meets.

Against:

- **Bill surprise.** A merchant who thinks Basic is $29 gets $29 plus seats.
  Mitigated by the plan copy on Shopify's hosted plan page ("3 members
  included, then $X each") and a "Members" count on the home page next to the
  orders line. Prices live only on the plan page: they are Partner Dashboard
  data the app cannot read, and any in-app repetition of them is a second
  copy to drift. Route to Ship carries the same risk and prices it openly.
- **Plan-change behavior is undocumented** (section 3). Real risk of
  mis-billing until measured.
- **Pro loses its clearest reason to exist.** If seats and orders are both
  overage, Pro is only a cheaper rate. That is what Route to Ship's ladder is
  and it works for them, but the plan copy has to sell the rate, not the cap.
- **Two meters to keep in step with `ENTITLEMENTS`**, both by operator
  discipline, since the app cannot read meter tiers.

Net: the case for overage is stronger than the case for the cap, on the
condition that the plan-change behavior is measured first and the app-side
ceiling stays.

## 7. Recommendation

1. **Measure before designing.** On `sandbox-shop-01`, with the orders meter
   that already exists: put usage on the meter under Pro, switch to Basic,
   read `activeSubscription` (`currentBillingCycle`, `usage.quantity`, `usage.cost`), switch back,
   read again. Record which of the three branches in section 5 Shopify takes.
   One afternoon, and it de-risks the orders meter as well.
2. **Adopt rule A** (high-water mark per cycle, count once, never reverse) if
   the measurement shows carry-over or reset. Either is workable; carry-over
   needs no true-up code, reset needs one event on the first revalidation
   after a handle change.
3. **Replace the seat cap with a seat meter.** Second usage meter, graduated,
   tier 1 at $0 up to `maxMembers`, tier 2 at a per-seat price. Delete
   `memberHasSeat`, `seatRank`, `MemberLimitError`, the badge and the banner.
   `maxMembers` stays in `ENTITLEMENTS` as the $0 band, renamed to
   `membersIncluded` to match `ordersPerCycle`.
4. **Add a hard ceiling** `ShopLimits.maxMembers`, the same kind of number as
   `maxOrdersPerCycle`: enterprise fencing, refused at add time with a
   message that says to contact support, not to upgrade.
5. **No prices in the app.** The add-member form does not say an add is
   billable, and no page quotes a seat price. The plan page on Shopify carries
   the pricing and is the one place it is maintained. The home page gets a
   "Members" count beside "Orders this billing period", counts only.
6. **Keep the seat price high enough that Pro is the better deal at the
   roster size Pro is meant for.** With Basic at $29 and Pro at $79, $10 per
   seat makes Pro win at the ninth member; $15 makes it win at the seventh.
   Route to Ship uses $15 on their $39 tier.

## 8. Decisions

No open questions remain. Reviewed 2026-09-22; every recommendation accepted,
with one pushback (no pricing copy in the app) and every number provisional.

| Decision                | Outcome                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Measure first           | Yes. The probe below runs before any seat work and before further iteration on this doc; it answers most of what remains.                                                                                                                                     |
| Seat-counting rule      | A: roster size at cycle start plus one unit per add that raises the cycle's high-water mark. Never reversed.                                                                                                                                                  |
| Reverse on removal      | No.                                                                                                                                                                                                                                                           |
| Add-on or usage         | Per-cycle usage. App Pricing has no add-on line item.                                                                                                                                                                                                         |
| Seat price              | $15 on Basic, $10 on Pro. Provisional; later research builds a cost model and a CLI to run numbers.                                                                                                                                                           |
| Hard ceiling            | `ShopLimits.maxMembers` at 12, every plan, message directs to support. Provisional.                                                                                                                                                                           |
| Prototype limits        | Sized around the dev seed (29 orders, most counted): orders included 20 and 30, `maxOrdersPerCycle` 35, `maxMembers` 12. A seed puts Basic over and Pro just under; a few real orders reach the ceiling. Real numbers go back in on both sides before launch. |
| Pro's included count    | Keep both: 3 and 10 included, cheaper seat rate on Pro.                                                                                                                                                                                                       |
| Downgrade message       | Members page drops seats and lockout. Home page shows member counts, no prices. Plan page on Shopify carries the pricing. No warning at downgrade time.                                                                                                       |
| Trial                   | Seat events during a trial are sent like any other. Whether trial usage bills at trial end is measured in the same probe.                                                                                                                                     |
| Pricing copy in the app | None. Plan details are Partner Dashboard data; keeping in-app copies aligned is not worth the risk of getting them wrong.                                                                                                                                     |

### The probe

Next step, separate from this doc. On `sandbox-shop-01` with the existing
`orders-synced` meter, driven by `playwright-cli` or the Chrome MCP for the
hosted plan page and the operator console, and the Partner API
`activeSubscription` read for the numbers:

1. Under Pro, put a few units on the meter (create runs for orders, or send
   events directly). Read `currentBillingCycle`, `usage.quantity`,
   `usage.cost`.
2. Switch to Basic on the hosted plan page. Read again at once and after the
   plan cache revalidates. Record whether `currentBillingCycle.startTime`
   moved and whether `usage.quantity` reset, carried over, or was priced
   under Basic's tiers.
3. Send one more event under Basic. Read again.
4. Switch back to Pro. Read again.
5. If the shop can be put into a Basic trial, send an event during the trial
   and read `usage` after the trial ends.

The answers pick the branch in section 5 and settle the trial question. The
orders meter benefits from the same answers today.

## 9. Probe results

Run 2026-09-22 21:52 to 21:56 UTC on `sandbox-shop-01` against the live
Partner API (`activeSubscription` with `usage { quantity cost }`) and the live
App Events API on the existing `orders-synced` meter, driven from a script in
the scratchpad and the hosted plan page in Chrome. The store began on Basic,
inside its 14-day trial (`trialEndsAt` 2026-10-02T19:50Z, `currentBillingCycle`
null), and ends on Basic, inside the trial.

| Step | Action                             | `trialEndsAt`     | `currentBillingCycle`                        | `orders-synced` usage |
| ---- | ---------------------------------- | ----------------- | -------------------------------------------- | --------------------- |
| 0    | Baseline, Basic in trial           | 2026-10-02 19:50Z | null                                         | null                  |
| 1    | Send 3 units, wait 20 s            | unchanged         | null                                         | null                  |
| 2    | Switch to Pro on the hosted page   | null              | 2026-09-22 21:53:57Z to 2026-10-22 21:53:57Z | quantity 0, cost 0    |
| 3    | Send 5 units, wait 30 s            | null              | unchanged                                    | quantity 5, cost 0    |
| 4    | Switch to Basic on the hosted page | 2026-10-02 21:55Z | null                                         | null                  |

Every plan item on the dev store reports `amountPerUnit` 0.0 on both tiers,
which is the "$0 effective price" contract the docs describe; the quantities
are real and the costs are not.

What it settles:

1. **A plan change is a new contract, and the meter starts at zero.** The
   five units sent under Pro were not visible after the switch to Basic, and
   the three units sent under the Basic trial were not visible after the
   switch to Pro. Nothing carries over. For seats, rule A's cycle-start event
   is exactly what is needed: on the first revalidation after the handle
   changes, send the roster size, and the new plan's $0 band absorbs its
   included seats. The reset branch in section 5 is the real one.
2. **A paid-to-paid change starts a new 30-day cycle at the switch moment**,
   not at the old cycle's boundary. Step 2 opened a cycle at 21:53:57Z, the
   time of the approval. `ShopAgent.setBillingCycle` already handles a pushed
   period; a changed `cycleStartAt` must count as a roll for the seat event.
3. **Usage during a trial is not reported and does not carry into the paid
   cycle.** `usage` is null while `currentBillingCycle` is null, and stayed
   null 20 s after a send. When the trial ended (by the switch to Pro), the
   cycle opened at quantity 0. Whether Shopify recorded the trial event as
   billable and discarded it, or rejected it, could not be confirmed: the Dev
   Dashboard is the only place that shows it and it was not reachable from
   the probe session. Either way, seat events sent during a trial do not
   bill. The first paid cycle needs its own cycle-start event, which the roll
   rule above sends.
4. **Switching away from a trialing plan ends the trial; switching back
   resumes the remaining days.** Step 2 cleared `trialEndsAt`; step 4 set it
   to 2026-10-02 21:55Z, ten days out, which is the unused remainder of the
   original 14, not a fresh 14. The hosted page's Basic card still said "14
   trial days" before the switch. Baton tracks none of this and does not need
   to: `boundaryAt` follows whichever of the two fields is set.
5. **Usage lands within 30 s** of a `202`. Reconciliation against
   `usage.quantity` can run on the next revalidation without a delay.

Not measured, and why it does not block:

- **Paid-to-paid with no trial in play.** Basic's trial got in the way: every
  switch to Basic on this store lands in the trial remainder until 2026-10-02.
  The Pro contract's behavior (new cycle at the switch, meter at zero) is the
  paid case, and there is no documented reason a switch into a post-trial
  Basic would differ. Re-run steps 2 to 4 after 2026-10-02 if a second data
  point is wanted; the script is one command per step.
- **Event billability during the trial.** Dev Dashboard only.

What changes in the design: nothing in the decisions of section 8. The
reset branch is confirmed, so the plan for the seat meter is the cycle-start
event on every roll, including the roll a plan change causes, plus the
mid-cycle high-water event. No true-up logic beyond that.

**The takeaway goes into one short JSDoc, as part of any implementation
plan.** This doc will be deleted. On `Domain.ActiveSubscription`, a few
lines: a plan change is a new contract, a new cycle from the switch moment,
and a meter at zero; trial usage is not reported and does not carry. Dated,
measured on the dev store. Other sites `{@link}` it.

One consequence for the **orders meter today**, already handled: an order
counted under Pro is not re-billed under Basic after a downgrade, and the
local count must start over with the new cycle. `OrderRepository.setBillingCycle`
treats a changed `cycleStartAt` as a new cycle and recounts `ordersThisCycle`
from the rows since that start, so the redirect revalidation after a plan
change resets the local count to match Shopify's zero. The seat meter's
cycle-start event hangs off the same `changed` branch.

# Open orders: what Baton counts, what it pays for, and where the ceiling belongs

Research, 2026-10-04. The question: Baton meters orders per billing cycle and fences the shop with a
per-cycle ceiling, but the load on the shop's object comes from the orders that are open at one
moment, whatever cycle they arrived in. Which orders cost what, at which point in an order's life,
and is the ceiling on the right quantity? Recommendations, then questions, at the end.

Everything below is read from the code and the two spec tables that govern it: the triggers table on
`ShopUsage` (`src/lib/domain/Billing.ts`) for the meter, and the sync tables on `syncOrder`
(`src/lib/domain/Orders.ts`) for what gets stored. The row counts are the ones measured in
`docs/index-counts-performance-research.md` and pinned by its tests.

Re-read against the code on 2026-10-04, after the broadcast-invalidation and AgentClient changes
landed (`203540c`, `b28184a`). The reasoning holds. What the second reading changed is marked
"Correction:" in place and collected under "Second reading" below; it raised one question, answered as decision 8.

## Short answer

Baton has two populations of orders and they are not the same set:

| population    | definition                                                               | who defines it                       | what it drives                                                    |
| ------------- | ------------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------- |
| counted order | an order Baton created a first run for; one unit, once, never reversed   | Baton (`OrderRepository.countOrder`) | the usage meter, the home page tile, the per-cycle ceiling        |
| open order    | a stored order that Shopify has not cancelled and not marked `FULFILLED` | Shopify (`Domain.orderIsOpen`)       | every orders index refetch; the member read through its open runs |

The meter and the ceiling both watch counted orders per billing cycle. The object's load is set by
open orders at a moment, and that set is wider than the counted set in both directions: it holds
orders that were never counted (unpaid, unmatched, no workflow on), and it holds counted orders
from earlier cycles that are not yet fulfilled. Nothing in Baton bounds it today.

## An order's life, and what each stage costs

The stages, in the order Shopify sends them. "Merchant rows" is the orders index refetch, "member
rows" the workflows list refetch, both per push, after the index and memo work of 2026-10-04.

| stage                                     | what Baton does                                                                                         | open?        | counted?                   | merchant rows | member rows                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------ | -------------------------- | ------------- | ---------------------------------- |
| created in Shopify (`orders/create`)      | fetches the order whole, stores it and its items; reconcile runs but creates nothing on an unpaid order | yes, at once | no                         | about 44      | 0                                  |
| paid (`orders/paid`)                      | reconcile creates a run per matching item; the first run counts the order and queues a usage event      | yes          | yes, now                   | about 44      | about 10 per open run on the teams |
| no workflow matches, or workflow off      | stored, open, position Not started; no run, no count                                                    | yes          | no, ever                   | about 44      | 0                                  |
| merchant attaches by hand                 | a run is created; counts the order if it was not                                                        | yes          | yes, now                   | about 44      | about 10 per open run              |
| members work it; last task Done           | the run reads `done`; position Made                                                                     | yes          | already                    | about 44      | 0: a done run has no current task  |
| edited down to zero, refunded             | reconcile closes the run, reason `item_removed`                                                         | yes          | already                    | about 44      | 0                                  |
| fulfilled in Shopify (`orders/fulfilled`) | reconcile closes every open run, reason `fulfilled`; the order leaves the partial index                 | no           | already                    | 0             | 0                                  |
| cancelled in Shopify (`orders/cancelled`) | same, reason `order_cancelled`                                                                          | no           | if it was                  | 0             | 0                                  |
| 365 days after `processedAt`              | the retention sweep deletes the order and its runs                                                      | gone         | the mark goes with the row | 0             | 0                                  |

Three things in this table answer the questions directly.

**An order costs from the moment it is stored, not from the moment it is paid.** The `orders/create`
webhook stores every order on the store, paid or not, matched or not. There is no tag gate at sync:
`syncOrder`'s only gates on a new order are retention and the ceiling. So a store whose made-to-order
products are a tenth of its catalogue carries every order it takes, and nine in ten of its open
orders are rows Baton reads on every refetch and never bills.

**The merchant pressing Done does not close anything.** `Domain.orderIsOpen` reads two Shopify
fields, `cancelledAt` and `fulfillmentStatus`, and nothing about runs. An order whose every run is
done reads Made and stays in the Open set, in the Open count, in the Made count, and in every
orders index refetch, until Shopify says `FULFILLED` or cancelled. Only the member read lets it go,
because a done run has no current task and the member read starts from open tasks.

**Closed orders cost nothing per push.** The orders index reads through `ShopOrder_open_idx`, a
partial index over unfulfilled, uncancelled orders, so a fulfilled order is not a row any refetch
touches. That is why Fulfilled, Cancelled and All carry no count on the strip. The year of closed
history costs storage and nothing else.

## What the object pays, and on which axis

After the 2026-10-04 change the reads are linear and the memo shares a computation across every
tab with the same key, so the bill per push is:

```
rows per push ≈ 44 × open orders                     (one computation per merchant query in use)
              + 10 × open runs on the teams × team sets in use
```

Correction: the merchant memo is keyed by the whole query (`OrdersMemoKey` in
`src/lib/agent/ShopWork.ts`: filter, team, page cursor, search and the shop's teams), not by the
filter alone, so two merchants on different pages are two computations. The 44 and 10 are the
measured ratios (44.2 rows per open order at 210 open, 10.0 per open run at 420 open, recorded in
`docs/index-counts-performance-plan.md`); the tests pin the bounds, 60 and 12 ("the orders index
default read reads at most 60 rows per open order", "the workflows list read reads at most 12 rows
per open run" in `test/integration/list-reads-rows.test.ts`).

Members no longer multiply it: twenty-five members on six teams are at most six member
computations. Two merchants on the default filter and the first page are one. What multiplies it is
pushes, and a push follows every write that changed something (the sites table on
`ShopAgent.publish`): one per order webhook whose order moved, one per task verb, one per attach,
cancel, tag edit or switch.

So the monthly cost is pushes × open orders, and both grow with the shop. A shop taking twice the
orders sends twice the webhooks and, at the same turnaround, holds twice the open orders: four
times the rows. The research's 2,000-open-order, 2,000-push shape is $17 a month and 0.1 s of object
time per push with the memo. Doubling the shop is about $70. The per-cycle ceiling does not stop
either axis.

Open orders at a moment is incoming rate × turnaround. The same 100 counted orders a cycle is 7
open orders on a two-day turnaround and 200 on a sixty-day one; the per-cycle ceiling cannot tell
them apart. And the orders it does not count, unpaid and unmatched, it does not fence at all.

## What the ceiling fences today

`ShopLimits.maxOrdersPerCycle` (100 when this was written, 2,500 since the interim change the same
day, provisional) is read against `ShopUsage.ordersThisCycle`, which is counted orders this billing
cycle. `cycleAtOrderCeiling`'s own JSDoc says it is positioning,
not protection: "storage is nowhere near its limit at this volume, but a shop above it is outside
what Baton is built for". It was never meant to bound the object's work; it bounds work started in a
cycle, which is the billable quantity.

Three consequences worth stating:

- A shop at the ceiling has 100 counted orders this cycle and any number of open orders. The
  ceiling does not read the open set.
- A shop under the ceiling can hold any number of uncounted open orders: an unpaid or unmatched order
  is stored past it, because the ceiling counts work started, not rows (rule 8 on `syncOrder`).
- Trial orders count toward it on purpose, and the first billing cycle recounts them out. An
  open-order ceiling would make that rule moot: it has no cycle.

Shopify offers nothing here. App Pricing usage meters have no caps
(`refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges.md`,
"Limitations": "Usage caps aren't currently supported"), so whatever fence exists is the app's.

## Options

**A. Add an open-order ceiling and keep the per-cycle one.** A second `ShopLimits` entry,
`maxOpenOrders`, read where new orders are gated today (before a webhook's fetch, before a sync
starts, per new order in the write). The count is one statement over the partial index, about one
row per open order, or a counter the sync maintains. Correction: reconcile never changes whether an
order is open; the open set moves on a sync write (a new open order, a stored order Shopify has
fulfilled or cancelled) and on a retention delete, nowhere else. A new order at the ceiling is
refused as at the cycle ceiling: 2xx to Shopify, nothing stored, a banner, and Sync open orders
recovers the gap once orders are fulfilled, as long as they are inside its 30-day window. Two
ceilings, two banners, two rows on `ShopUsage`.

**B. Replace the per-cycle ceiling with the open-order ceiling.** Same mechanics as A, one
ceiling. The per-cycle ceiling's job was positioning; an open-order ceiling positions the same way
("Baton carries up to N open orders") and fences the quantity that costs. The meter stays as it is:
counted orders per cycle, billed to Shopify, no ceiling of its own. `ordersLimitedAt` and the quota
banner move to the new fact; the trial rule and the "ceiling read at the cycle the sync lands in"
rule (rule 5 on `syncOrder`) go, since the ceiling has no cycle. A shop that starts 500 orders a
cycle and fulfils in three days never meets it, which is right; a shop that lets 3,000 orders sit
unfulfilled meets it whatever it pays, which is also right, because that is what loads the object.

**C. Narrow the open set at sync: store only orders with an item a workflow could match.** The
webhook already fetches the order whole, and `itemMatches` in ShopWork is a pure read over the item's
tags and the workflows that are on. A gate there keeps the general store's nine in ten unrelated
orders out of the object entirely. Against it: the orders index stops being the store's orders and
becomes Baton's; manual attach to an unmatched order (the merchant overriding the tag gate on
purpose) needs the order stored, so the gate would have to admit a one-order Sync from Shopify by
id; and a workflow turned on later would find nothing to reconcile until the next Sync open orders.
It is a product change, not a performance one, and it is the only option that changes the slope
rather than fencing it.

**D. Narrow the open set by position: let a Made order leave the open set after N days.** Rejected.
Open is Shopify's word and Baton reads it from Shopify's fields; a Baton-side "effectively closed"
would be a third state the vocabulary has no word for, the merchant's Made count would stop agreeing
with the list, and a late fulfilment webhook would reopen it. The right fix for a shop that leaves
made orders unfulfilled is to fulfil them, and the ceiling banner can say so.

**E. No ceiling on open orders; rely on the linear reads and the memo.** The measured shape is
cheap, and a ceiling refuses orders, which is the worst thing Baton does to a merchant. Against it:
nothing bounds the object's one thread. At 10,000 open orders the merchant computation is 440
thousand rows and about 100 ms per push, and the member computations grow with open runs; a bulk
sync at that size publishes thousands of times in a minute. An operator would learn about it from
the duration bill. At minimum the open-order count belongs on the admin shop page as a signal, which
every option below A also needs.

## Recommendation

1. **Keep the meter exactly as it is.** Counted orders per billing cycle is the billable quantity
   and the plan copy already says it ("Billed once work starts on an order"). The open set is not
   what the merchant should pay for: an unmatched order is nothing Baton did for them.
2. **Do B: replace the per-cycle ceiling with an open-order ceiling.** One ceiling, on the quantity
   that loads the object, independent of the billing cycle. The per-cycle ceiling's positioning job
   is done as well by "up to N open orders", and its protection job was never real. Keep it
   provisional and enterprise fencing, as today.
3. **Set it from the measured shape.** 2,000 open orders is the shape the cost worry was settled on
   (decision 11 of the index counts research); 2,500 leaves headroom and keeps the merchant
   computation under 30 ms per push. Below the number, nothing changes for the merchant.
4. **Show the open-order count.** On the admin shop page beside `databaseSize`, as the operator's
   signal; and on the home page's Orders tile only if the ceiling is what the tile should describe
   (question 5).
5. **Do not do C now, but decide whether it is on the roadmap.** It is the only option that makes
   a general store cheap, and it is a product decision about what the orders index is. If the
   target merchant is a made-to-order shop where most orders match, the open set is already the
   right set and C buys little.
6. **Do not do D.**

## Questions

Each question carries the recommendation above so it can be answered in place. Unanswered stays
open.

1. **Replace or add?** Replace the per-cycle ceiling with an open-order ceiling (B), or keep both (A)?
   Recommendation: replace. Two ceilings on two quantities with two banners is more to explain than
   the second one buys, and the per-cycle one fences nothing the open one does not.

2. **The number.** 2,500 open orders? Recommendation: 2,500, provisional, moved with measurements.
   The number is about the object's thread, so it is per shop and plan-independent, like
   `maxMembers`.

3. **What the banner says and what recovers the gap.** Today a refused order is lost until the cycle
   rolls and Sync open orders is pressed, inside its 30-day window. With an open-order ceiling the
   way out is fulfilling or cancelling orders in Shopify, then Sync open orders. Should the banner
   say that ("New orders stopped syncing at 2,500 open orders. Fulfil or cancel orders in Shopify,
   then Sync open orders"), or should Baton re-sync on its own once the count drops under the
   ceiling? Recommendation: the banner, and the merchant presses the button. An automatic re-sync is
   a scheduled bulk operation with no trigger but a count, and the 30-day window is the same either
   way.

4. **Should Baton store orders nothing could match (C)?** Recommendation: not now; record it as the
   lever for a general store, and revisit when a target merchant's catalogue says most orders are
   not made-to-order. If the answer is yes now, it is its own research: what the orders index then
   shows, how manual attach reaches an unstored order, and what Turn on does for orders it skipped.

5. **Where the count shows.** The admin shop page for certain. The home page tile today is "Orders
   this billing cycle" against the plan's included orders, a billing fact. Should a second tile show
   open orders against the ceiling? Recommendation: no second tile. The quota banner names the
   ceiling when it is reached, and a tile that is at 3% all year is noise; the operator sees it on
   the admin page.

6. **Turnaround.** The open set is incoming rate × turnaround, and the ceiling number assumes
   turnaround in days, not months. Is there a target merchant whose made-to-order turnaround is
   weeks (furniture, bespoke tailoring), where 300 orders a month is 1,000 open? That is inside
   2,500, but it is the shape that reaches the ceiling first, and it is the one where a banner
   telling them to fulfil faster is wrong. Recommendation: assume days to a few weeks, and let the
   first merchant who hits the ceiling with a long turnaround raise it.

7. **The trial rule.** With no per-cycle ceiling the "trial orders count toward the ceiling" decision
   disappears; the meter keeps its own trial rule (usage sent during a trial is not reported).
   Confirm that nothing else depended on the cycle ceiling: the admin page's ceiling read, the
   quota banner, `ordersLimitedAt`, rule 5 on `syncOrder` and its test, and the e2e fixture that
   lifts the ceiling (`withMaxOrdersPerCycle`). Recommendation: confirm, and the plan lists every
   site.

## Second reading

What the re-read against the code on 2026-10-04 found. Each item is either a correction to the
text above (marked there too) or a fact the plan needs that the first reading did not state.

1. **Every site that reads the cycle ceiling.** `ShopLimits.maxOrdersPerCycle` and
   `cycleAtOrderCeiling` are read in: the Platform vocabulary's ceiling row; `Entitlements`,
   `ShopUsage` (the `ordersThisCycle` and `ordersLimitedAt` JSDoc and assumption 3 under the
   triggers table) and `cycleAtOrderCeiling` in `Billing.ts`; the `syncOrder` JSDoc in `Orders.ts`
   (the gating paragraph, the `ceiling` column's definition, rule 5 and rule 8 with their pinned
   titles, the `atCeiling` parameter, `OrdersSyncResult`); `OrderRepository` (`ShopUsageRow`'s
   JSDoc, `upsertOrder`'s `refused` field and the `currentCycle` read inside it,
   `markOrdersLimited`, `usageAtCycle`); `ShopAgentOrdersStream` (`ordersRefused`);
   `ShopAgent.syncOpenOrders` and `syncOrderWebhook` (the read, the log lines, the JSDoc);
   `QuotaBanners`; the admin shop page's "Orders limited" field; `README.md` line 24; the test
   helper `withMaxOrdersPerCycle` and its seven callers (the ceiling suite's three tests, one in
   `order-repository.test.ts`, one in `shop-agent-sync-order.test.ts`, two in
   `orders-sync-workflow.test.ts`, and `rows-read.ts`, which lifts it to a million for the
   row-count fixture); and the `Domain.cycleAtOrderCeiling` unit test. The reconcile triggers
   table in `ShopWork.ts` says "order ceiling" in two `skipped when` cells and needs no change.
2. **Sync from Shopify never meets the ceiling.** The order page exists only for a stored order,
   and a stored order is never gated (rule 8). The `Stored`/`Gone` result needs no `Refused`.
3. **Where the webhook's one usage read goes.** `syncOrderWebhook` reads `ShopUsage` once through
   `usageAtCycle`, for the ceiling and for the sweep's `lastSweepAt`. With an open-order ceiling
   the sweep still needs the row, and a new order needs a count; a stored order needs no count.
   `usageAtCycle` (a roll-forward then a read) has no other caller and goes; the counting path
   rolls the cycle on its own (`countOrder`).
4. **The count's cost.** `count(*)` under the partial index's predicate is a covering scan of
   `ShopOrder_open_idx`: one row per open order, at most the ceiling's worth, read only for a new
   order. At 2,500 open orders that is 2,500 rows per new-order webhook and per new order in a
   stream, about $0.0025 per thousand new orders. A stored counter would save that and could drift;
   the statement cannot. The plan uses the statement.
5. **What clears `ordersLimitedAt` is undecided.** Today the cycle clears it, in three writes:
   the provisional cycle's open, the roll-forward in `currentCycle`, and the recount in
   `setBillingCycle`. The decisions retire the cycle from the ceiling but name nothing in its
   place. Decision 8.
6. **The banner's date goes.** `QuotaBanners` says "Syncing resumes on <cycle end>". An
   open-order ceiling has no date to name; the copy table's banner row (`CopySlot` in
   `src/lib/Screen.ts`) wants the fact, its effect on this page, and what clears it.
7. **The orders strip already counts open orders.** `counts.open` in `listOrders` is the same
   predicate over the same index; the ceiling's count is a one-line statement beside it, and the
   two agree by construction because both spell `OPEN` verbatim.
8. **The seed stores open orders.** `seedOrders` writes through `upsertOrder`, so seeded orders
   count toward an open-order ceiling. The dev and e2e seeds are a handful of orders; the
   row-count fixture (2,100 open orders) runs under the lifted ceiling as today.
9. **The home tile's copy contradicts the meter.** The Orders tile's detail says "Each order
   synced from Shopify counts once." The meter's word is counted order: one Baton created a run
   for (`OrderRepository.countOrder`); a synced order no workflow matches is never counted, and
   this doc's whole point is that the two populations differ. The plan fixes the sentence with
   the banner (phase 3): "Each order counts once, when work starts on it."

## Decisions

Answered 2026-10-04 in Plannotator. All seven recommendations accepted as written:

1. Replace the per-cycle ceiling with an open-order ceiling, not add a second one.
2. 2,500 open orders, provisional, per shop and plan-independent.
3. The banner names the way out (fulfil or cancel in Shopify, then Sync open orders); no automatic
   re-sync.
4. No tag gate at sync now; recorded as the lever for a general store.
5. The open-order count goes on the admin shop page; no second home page tile.
6. Turnaround assumed days to a few weeks; the first long-turnaround merchant raises the number.
7. The trial rule goes with the cycle ceiling; the plan lists every site that read it.

Answered 2026-10-04 in Plannotator, after the second reading:

8. The refusal flag (`ordersLimitedAt`) is cleared when the next new order is stored. The three
   cycle clears go. The banner says syncing stopped and stays until it has resumed.

   Revised 2026-10-04, after the implementation review: the flag is cleared when Sync open orders
   starts, and by nothing else (`OrderRepository.clearOrdersLimited`). A shop held at the ceiling
   by its own incoming rate stores one order for every fulfilment, so a flag cleared by a stored
   order would clear the banner within minutes of raising it, before the merchant read it, with
   the refused orders still lost; and the way out the banner names is the sync, which decision 3
   refuses at the ceiling, so the banner has to outlive the first stored order for the merchant to
   take it. The flag means "there is a gap only Sync open orders closes" and the start is what
   closes it. A stream that crosses the ceiling sets it again.

Interim, before the plan runs: `maxOrdersPerCycle` was 100, a prototyping number that the pro
plan's own copy outgrows, and is raised to 2,500 the same day so no shop meets it before the
open-order ceiling replaces it. Still provisional.

## Open

Nothing. The plan is `docs/open-orders-plan.md`, not yet executed.

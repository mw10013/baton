# Orders index filters research

Why the filter bar on `/app/orders` is hard to read, what the "Needs attention · 1 but no rows" case actually is, and how to rebuild the bar from the questions a merchant brings to the page.

Written 2026-09-23.

## What exists today

The route is `src/routes/app.orders.index.tsx`. Five URL params drive one query:

| Param       | Control                                                     | Values                                                                                                 |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `q`         | Order number text field                                     | order number                                                                                           |
| `state`     | "Stage" press-button row                                    | absent = Open, `no_workflow`, `multiple_workflows`, `in_production`, `ready_to_ship`, `shipped`, `all` |
| `paid`      | "Payment" press-button row                                  | absent = All, `true`, `false`                                                                          |
| `attention` | Red "Needs attention · N" toggle button, in the Payment row | absent or `true`                                                                                       |
| `team`      | "Waiting on" select                                         | absent = Any team, a team id                                                                           |

Plus "Clear filters", a tertiary button in the Payment row that resets all five, and a chip for `q` that appears in the same row.

`state` is `Domain.OrdersFilterState`: `Domain.ProductionState` plus `"all"`. `productionState` derives one value per order with a precedence: cancelled, then shipped, then `multiple_workflows` (an item matching two workflows with no live run), then `no_workflow` (paid, no runs), then `in_production` (open runs), else `ready_to_ship`.

`openCounts` (`Domain.OpenStageCounts`) is computed over the open partial index and honours none of the five filters. The repository says so in a comment. The numbers on the buttons are the shop's whole open bench, whatever else is selected.

## Reading the screenshot

Stage = Open, Payment = All, Needs attention pressed, Waiting on = Engraving. Result: "No orders match these filters."

This is not a code bug. It is three decisions colliding:

1. The count on "Needs attention" is the shop-wide count. It does not know Engraving is selected.
2. `attention` means an open task is unassigned, on a deleted team, or on a team with no members. `waitingOn` deliberately leaves out unassigned and deleted-team tasks. So the one attention order is very likely waiting on nobody, and crossing it with any team gives zero.
3. The team select stays at "Engraving" from an earlier drill-in (the team page links here with `?team=`), and nothing in the bar says "you are also filtered by team" except the select's own value, two rows down.

The merchant reads the red button as a promise: press this and see 1 order. The page breaks the promise and blames "these filters". Every other count on the bar can break the same promise once `paid` or `team` is set: "In production · 51" with Team = Engraving might show 6.

"Clear filters" then resets `team` to Any team as well as unpressing the toggle. That is why the second screenshot shows Any team. It also clears `q`. The merchant sees one thing change (the red button) and does not notice the select moved.

## The problems, named

1. **Counts do not describe what the button will show.** A count on a control is read as "press me, get this many". `openCounts` ignores the other filters, so it is only true when nothing else is selected.
2. **Two kinds of thing in one "Stage" row.** Open and All are scopes. In production, Ready to ship and Shipped are lifecycle positions. No workflow and Choose a workflow are problems the merchant has to fix. A problem is not a place an order sits on the way to shipping, and `productionState` has to invent a precedence to force each order into one bucket. That precedence has a visible cost: an order with two active runs and one ambiguous item is counted under Choose a workflow, not In production, so "In production · 51" undercounts what is actually being made.
3. **Needs attention is a toggle in a radio row.** The press-buttons either side of it are single-select groups. It is the only two-state control on the bar, it is the only red one, it is styled as a plain button rather than a press-button (because `s-press-button` has no critical tone), and it sits under the "Payment" label though it has nothing to do with payment. It also appears only when the count is above zero, so the row changes shape between visits.
4. **Needs attention is one flag for one remedy, while the table shows five alarms.** Row badges: No workflow, Choose a workflow, Needs attention (unassigned or unstaffed), Blocked, Order changed. Two of the five are filterable as "stages", one as the toggle, two (Blocked, Order changed) not at all. There is no place to ask "show me what is blocked".
5. **Clear filters is in the wrong place and does too much.** It lives in the Payment row, resets things in other rows, and resets the search. The bar has no chip strip saying which filters are active, so the merchant cannot predict what Clear will do.
6. **Labels.** "Stage" was the word for workflow stages until the rename to steps and tasks. "Waiting on" is the table column's meaning (teams with a ready task) but as a filter label it reads as "orders that are waiting", which is every open order. "Payment: All" next to "Stage: All" makes two different Alls.
7. **The sentence under the bar restates the count.** `stageText` prints "51 orders with work in progress." under "In production · 51". The button already said it.

## What the page is for

Who arrives and with what question:

| Person   | Question                                         | Today's answer                                                                                                            |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Merchant | What needs me before work can start or continue? | Scan No workflow, Choose a workflow, Needs attention, and the Blocked and Order changed badges in the table. Four places. |
| Merchant | Where is everything?                             | The counts on the stage row, when no other filter is set.                                                                 |
| Merchant | Where is order #2039?                            | Search. Works.                                                                                                            |
| Merchant | What is Engraving holding?                       | Drill in from the team page. Works, but leaves `?team=` set.                                                              |
| Packer   | What can I ship?                                 | Ready to ship. Works.                                                                                                     |

The first question is the one the current bar serves worst, and it is the one that matters most: it is the merchant's to-do list, and nothing else in Baton or the Shopify admin surfaces it.

## Two axes, not one

Every order has exactly one lifecycle position and zero or more problems:

- **Position** (one per order, exclusive): not started, in production, ready to ship, shipped, cancelled. This is a real progression. "Open" is the union of the first three.
- **Problems** (independent flags, any number per order, each with its own remedy):
  - No workflow: paid, no runs, nothing matched. Remedy: attach one on the order page.
  - Choose a workflow: an item matches two or more. Remedy: choose on the order page.
  - Needs a team: a task is unassigned, on a deleted team, or on an unstaffed team. Remedy: assign, or staff the team.
  - Blocked: a person stopped a run. Remedy: the order page.
  - Order changed: Shopify edited under a live run. Remedy: accept.

The current bar puts the first two problems on the position axis and the third on a toggle, and drops the last two. Separating the axes removes the precedence in `productionState`: `multiple_workflows` and `no_workflow` stop being positions, an order with open runs is simply in production, and the flags ride beside it as they already do on the row badges.

## Approaches

### A. Patch in place

Keep the layout. Make `openCounts` honour `paid`, `team` and `attention` so a count is what the button will show. Move Needs attention to its own labelled row. Move Clear filters to the end of the bar, show it only when something is set, and make it not touch the search.

Fixes the promise-breaking count and the toggle-in-a-radio-row. Leaves No workflow and Choose a workflow as "stages", leaves Blocked and Order changed unfilterable, leaves three rows of controls.

Cost: small. Counts filtered by team is a per-team aggregate on every refresh of a subscribed page, which `OpenStageCounts` was bounded to avoid, but it is over the open partial index and it is one query with the same joins the page already runs.

### B. Views plus filters, admin style

The Shopify admin puts saved views in a tab strip (All, Unfulfilled, Unpaid, Open, Archived) and everything else in a filter popover. A view is a named question; filters narrow inside it.

Views: Needs you · Open · Ready to ship · Shipped · All. "Needs you" is the union of all five problems. Filters (popover or a second row): Team, Payment, and a Problem select that only makes sense inside Needs you or Open.

Reads well and matches what merchants already know from the admin. Polaris web components have no tab control, so the strip stays press-buttons, which the admin does not use for views. "Needs you" as a union hides which problem it is until the row badges say so, which is fine for a to-do list because the badge is the remedy's name.

Cost: medium. The "Needs you" view is a new SQL union over the five flag conditions; four of the five already exist as SQL.

### C. Two rows, one per axis

Row 1, **Status**: Open · In production · Ready to ship · Shipped · All. Single select. Lifecycle only. `productionState` loses `no_workflow` and `multiple_workflows`.

Row 2, **Needs**: Anything · No workflow · Choose a workflow · A team · Unblocking · Review of a change. Single select with "Anything" as the default, meaning no problem filter. Each button carries a count that honours the status row and the team select. The whole row is neutral press-buttons; the red moves to the row badges where it already is.

Below: Team select and the order-number search. No Payment row. No Clear filters: every control shows its own state, and a single-select row with a default is its own clear.

Answers every question in the table above with one press. "What needs me?" is Status = Open and Needs = any of five, which as five counted buttons is the to-do list itself: 2 · 2 · 1 · 0 · 3. The merchant reads the row and knows the morning's work without pressing anything.

Cost: medium. The two flag conditions that do not exist in SQL yet (blocked, order changed) are `runs.blocked > 0` and `runs.flagged > 0`, which the page already computes per row. Counts become one grouped query with six sums, filtered by status and team. `productionState` simplifies; the row badge for Choose a workflow stops being a "state" badge and becomes a flag badge like Blocked.

### D. Move the to-do list off this page

Put a "Needs you" card on the app home with five counted links into the orders page, each landing with the matching filter preset. The orders page keeps only Status, Team and search.

The orders bar gets very simple, and the merchant's first screen answers the first question. But the orders page still needs the flag filter for the links to land on, so this is C's row 2 rendered on home and hidden here, not a removal of it. It also depends on the home page being where merchants land, which in an embedded app it usually is.

Cost: C plus a home card.

## Recommendation

C, then D as a follow-up once C's flag counts exist.

The reasoning: every problem in the list above comes from putting exclusive positions and independent problems on one axis and then bolting a toggle on to hold the one that would not fit. Splitting the axes removes the toggle, removes the precedence, removes the need for Clear filters, and makes each count true. B gets most of the way but hides which problem behind a union, and the admin's tab idiom is not available in Polaris web components anyway. A fixes the visible symptoms and leaves the cause.

Cut Payment as a filter row. The Payment column stays. Nobody has asked "show me only unpaid orders" of a production board, and an unpaid order with no runs has `productionState` null and shows an empty Workflows cell, which already says why nothing is happening. If a merchant needs unpaid orders as a list, the Shopify admin's Unpaid view is one click away.

Cut Clear filters. With single-select rows that have a default, the search chip's own X, and a select whose first option is Any team, there is nothing left for it to do that is not already visible.

Cut `stageText`. The count is on the button. The empty text (`emptyText`) stays: it is the only copy when a filter finds nothing.

## Decisions

Answered 2026-09-23 via Plannotator.

1. **No workflow and Choose a workflow are problems, not stages.** `productionState` loses both branches and its precedence.
2. **Five problem buttons, each counted**, with the caveat below: counting is a read charge, so show a count only where the analysis says it is cheap, and drop counts before dropping buttons.
3. **Counts honour the other filters**, same caveat. Weigh every aggregate against its row reads; a button without a count is acceptable.
4. **Payment filter row is cut.** The column stays.
5. **Shipped stays** as its own status, uncounted.
6. **Team filter stays a select**, labelled "Team".
7. **The problem row goes on the app home as a follow-up**, after the orders page has it.
8. **Search stays above the rows.**

## What the counts cost

Durable Object SQLite bills per row read and per row written. Included on the Workers Paid plan is 25 billion rows read a month, then $0.001 per million. Every row SQLite touches counts: a table row, and an index entry it walks to find or skip that row. An index does not make reads free; it makes the query touch fewer rows than a scan would. So a correlated `exists (select 1 from WorkflowRun where orderId = ...)` is one index probe plus one row per run visited, per outer order, per term. Six `exists` terms over the same 60 open orders are six probes per order, not one. The one thing that is free is the arithmetic: adding `sum(a) + sum(b)` over columns already in hand costs nothing more than `sum(a)`. What multiplies the bill is rows touched per refresh times refreshes.

### What the count query reads today

`openCounts` is one pass over `ShopOrder` through the partial index `ShopOrder_open_idx` (open orders only), and for each open order a correlated `exists` against `WorkflowRun` on `WorkflowRun_orderId_idx` and, for the ambiguity term, against `OrderLineItem` on `OrderLineItem_orderId` plus `WorkflowRun` by line item. A rough per-refresh read count:

| Term                                    | Rows read per open order                                                 |
| --------------------------------------- | ------------------------------------------------------------------------ |
| the order row itself                    | 1                                                                        |
| each `exists` over runs (four of them)  | up to the order's run count, usually 1 to 3, short-circuits on first hit |
| ambiguity (`CHOOSING`, used four times) | line items plus each item's runs                                         |
| `attention`                             | open runs plus their tasks plus a `WorkflowRunTask` lookup by team       |

For the shop in the screenshot (66 open orders, a few runs each) that is on the order of a few hundred to a thousand rows per refresh. The page read beside it (25 rows plus four per-page reads for units, runs, attention, waiting-on) is the same order. A shop with 2,000 open orders scans tens of thousands of rows per refresh. That is a lot per refresh, and it is why the two levers below that cut it, coalescing refreshes and reading each run once, matter more than which buttons carry a count. At $0.001 per million, 20,000 rows is two thousandths of a cent, so the risk is not one refresh but a shop with a large bench and a subscribed tab open all day during a busy import: 2,000 refreshes at 20,000 rows is 40 million rows, four cents, per tab per day. Cheap in money, but it is the shape that grows without bound, and 25 billion included rows a month is about 600 such tab-days.

Refreshes are the multiplier. The page is subscribed and refetches on every order-state push: every webhook, every task done, every bulk-import row. Two merchants with the tab open during a 500-order import is 1,000 refreshes, each running the count pass.

### What C adds

- **Status row counts** (In production, Ready to ship): already computed. Open is the sum, and Shipped and All stay uncounted. No new reads.
- **Problem row counts**: No workflow and Choose a workflow are already computed. Needs a team is `attention`, already computed. Blocked and Order changed are two more `exists` over `WorkflowRun` with a flag predicate, on the same index, short-circuiting. Marginal reads: up to one run scan per open order each. Small.
- **Honouring the team filter**: adds a correlated `exists` over `WorkflowRunTask` by team, on `WorkflowRunTask_teamId_idx`, per open order. Same shape as `attention`. Small, but it is the one that turns the count from a shop-wide number into a per-filter one, so it cannot be cached across filter combinations.
- **Honouring the status filter on the problem row**: a `where` term on the same pass. No new reads.

So C roughly doubles the per-refresh count reads at worst, on a pass that is already one of five reads the page does. Each new `exists` term is a real per-order probe, which is why the estimate is "double" and not "free". It does not change the order of magnitude. The order of magnitude is set by open orders times refresh rate.

### Ways to keep it bounded

In order of how much they save:

1. **Rate-limit the refetch, not the query.** Coalesce pushes so a subscribed tab refetches at most once every few seconds during a burst. This cuts the 1,000-refresh import to a few dozen and is the single biggest lever, and it helps the page read as much as the counts. A debounce in `useSubscribedQuery` or on the publish side.
2. **One pass for all counts.** Keep every sum in the one `select ... from ShopOrder where OPEN` statement, as now. Never one query per button. This saves the outer scan of open orders, not the per-term probes; item 3 is what saves those.
3. **Hoist the run summary out of the correlated subqueries.** A single `group by orderId` over open runs (which the page already does for its 25 rows) joined to the open orders would read each run once instead of once per `exists`. With six flag terms this is the difference between six probes per order and one. Worth doing when the two new flag terms go in.
4. **Drop the counts that need a per-filter scan first.** If the team-filtered counts turn out to matter, the fallback is: counts honour status but not team, and the team select shows no counts (as now). That keeps the promise for the common case (no team set) and the buttons still work when a team is set.
5. **Cap by shop size.** Above some open-order count (say 2,000) stop computing counts and render bare labels. The `ShopLimits` tier already exists for this kind of gate.

Recommendation: build C with all counts in one pass and hoisted run summaries (2 and 3), add the refetch coalescing (1) at the same time since it pays for everything else, and hold 4 and 5 in reserve. Verify with a `rows_read` measurement on a seeded shop before and after, not an estimate.

Decision 2026-09-23: accepted. Measure `rows_read` first, on the current page, so the estimate above is replaced by a number before the rebuild starts.

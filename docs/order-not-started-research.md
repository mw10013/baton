# What "Not started" means on the orders index

Written 2026-10-07, while reviewing the showcase shop (`docs/showcase-shop-plan.md`, question 3 of
its second review); checked against the code the same day. Decided 2026-10-07 (see Decisions); no
question remains open. The plan is `docs/order-not-started-plan.md`. The question: should the orders
index's Not started position mean "no item has a workflow" (today) or "nobody has touched it"? The
help's Reading the orders list page (`/help/orders/orders-list`) waits on the answer, because it
has to say exactly what each strip value holds.

## What prompted it

`pnpm seed --showcase` seeds 38 open orders. The research behind it (`docs/showcase-shop-research.md`,
"Orders") planned 8 of them as "not started": paid orders whose items match a workflow, with no task
started yet, meant to show Ready rows for each team. On the orders index they read **Making**. The
strip showed Not started 4, Making 39 (with the three real orders). The four Not started orders are
the two gift-card orders, the unpaid one and the multi-match gift set: orders the bench will not
make or cannot yet.

The seed is not wrong. The rule is doing what it says.

## The rule today

`Domain.orderPosition` (`src/lib/domain/ShopWork.ts`), from the order row and its run counts:

| position    | condition (after cancelled and fulfilled are ruled out) |
| ----------- | ------------------------------------------------------- |
| Not started | no open run and no done run                             |
| Making      | at least one open run                                   |
| Made        | done runs and no open run                               |

A run is created `open` the moment reconcile matches an item on an open, paid order to an eligible
workflow (`reconcileItem`). So any paid order with a matching item is Making on arrival, before any
member has seen it.

The rule is stated three times and the three must move together:

- `Domain.orderPosition` (the definition), and its JSDoc on `OrderPosition`.
- `OrderRepository.listOrders`: the Show filter's SQL per position (`showFilter`: `not_started` is
  `OPEN` and no `OPEN_RUN` and no `DONE_RUN`, correlated subqueries on `Run`) and the strip's counts
  (`COUNT_FACT`: `not_started` is `openRuns = 0 and doneRuns = 0`, `making` is `openRuns > 0`,
  `made` is `doneRuns > 0 and openRuns = 0`). Both are served by `Run_orderId_state_idx (orderId,
state)`; neither statement reads `RunTask`.
- `Domain.RunCounts` (`open`, `done`, `blocked` per order): the only per-order run facts the index
  reads. There is no "touched" fact.

The order page computes the same position for its facts line from its own runs (`orderPosition`
takes `Pick<OrderRow, "order" | "runs">` for that reason), so a fourth site follows the three.

The vocabulary row (top of `src/lib/domain/ShopWork.ts`, "Order positions"): `not started | open, no
open run and no done run | Not started`. The label is `ORDER_POSITION_LABEL.not_started`.

## Why it is this way

The JSDoc on `OrderPosition` records it. The first rung used to be "To make"; it became "Not started"
because the rung holds every open order with no open and no done run: an unpaid order, an order whose
items matched no workflow, an order whose only run the merchant cancelled, and an order whose only
item Shopify removed. In the last three the bench will make nothing, so "to make" promised something
the app could not keep; "not started" is true of all four.

Commit 7e1e88f (2026-09-28; its plan, `docs/view-row-press-button-plan.md`, is in that commit and since removed) removed "No workflow" from Issues
and made Not started the place an untagged item shows up: "a made-to-order product nobody tagged
sits in Not started, where the merchant sees it, and its order page offers the picker." So Not
started today doubles as the safety net for items Baton is not making. That is the trade-off any
change has to weigh.

## The same words, two meanings, on adjacent screens

The order page already uses "Not started" in the other sense. `Domain.RUN_UNSTARTED_LABEL` is
"Not started", shown as an item's badge when its run is open and `Domain.runIsUnstarted(tasks)`
(no task started or done). The JSDoc on `RUN_STATE_BADGE` in `src/routes/app.orders.$orderId.tsx`
gives the reason: "the merchant is asking whether the bench has picked it up yet, and the stored
state cannot say, since a run is `open` from creation."

So a merchant who opens a Making order from the index can find every item on it badged Not started.
The index says the bench has it; the order page says nobody has started. Both are true under their
own definitions, and the screens never say which.

The badge ignores blocks and notes: `runStateBadge` shows Not started whenever the run is open and
`runIsUnstarted`, so a run the merchant blocked before anyone started reads Not started with
Blocked beside it (the e2e fixture's order 1033 is written to show exactly that). The other
predicate, `Domain.runHasRecord` (a task started or done, a block, or a note), is what Change
workflow's confirm and `changeWarning.ts` read. Any "touched" rule for the order position has to
pick one of the two; the order page has already picked `runIsUnstarted`.

`docs/reconcile-research.md` (the scenario table under the B option) also uses "a run at Not started"
in the run sense.

## What the merchant asks of the strip

From `docs/list-filter-search-research.md`, "What each control is for": the merchant arrives wanting
(1) what needs me (Issues), (2) how much is on the bench, and where (counts by position: not
started, making, made), (3) one order, (4) one team, (5) history.

Question 2 is the one at stake. "Not started" in plain English is "nobody has begun it". The
merchant's question behind it is "what is waiting for the bench to pick up". Today's rung answers a
different question: "what is Baton not making".

## Options

**A. Keep the rule; the help says it.** Not started stays "no item has a workflow, or the order is
unpaid, or its runs were cancelled". The help page states it in one sentence. The order page's
item badge keeps its own Not started. Cost: none in code. Risk: the word means two things on two
screens one click apart, and the strip's Not started count is near zero on a working shop, so the
"how much is waiting" question has no answer on the index.

**B. Not started means nobody has touched it.** Not started: open, and no task on any of its runs
started or done (orders with no runs at all stay here too). Making: some task started or done on an
open run. Made: unchanged. This matches `runIsUnstarted` (blocks and notes do not count), so the
two screens agree, and the strip answers "how much is waiting". Untagged orders still land in Not
started, mixed with untouched routed orders; the safety net becomes harder to see. A blocked
untouched order reads Not started with Blocked in Issues, as its order page already does.

**C. B, plus a separate place for what Baton is not making.** As B, and the orders Baton will not
make (no run on any item, not unpaid) get their own filter or an issue again. 7e1e88f argued against
an issue ("a permanent false alarm" on every order for a ready-made product). A filter, not an
issue, would avoid the alarm. More screen.

**D. Rename instead of redefine.** Keep the rule and give the rung a word that says it: something
like "No workflow" (the word 7e1e88f retired) or "Not in Baton". Then Making covers untouched routed
orders honestly only if "Making" can mean "queued". It cannot, quite: nobody is making it.

**E. The ladder is the bench; orders with no run leave it.** Three honest facts about an open
order differ in who can act next:

| fact                  | who can act next                           | today       | B           | E                     |
| --------------------- | ------------------------------------------ | ----------- | ----------- | --------------------- |
| no run on any item    | nobody, or the merchant (pay, tag, attach) | Not started | Not started | Unpaid or No workflow |
| runs, no task started | a member can Start                         | Making      | Not started | Not started           |
| a task started        | the bench is on it                         | Making      | Making      | Making                |

Today merges the second and third rows and overstates; B merges the first and second, so Not
started still promises a Start that is not there, for fewer orders. E makes every word exactly
true. Concretely:

_The positions._ `OrderPosition` grows from five to seven values. One per order, derived, never
stored, as now. The order of the checks: cancelled, fulfilled, then the run counts, then payment.

| position    | rule                                                  | Status badge | who acts                               |
| ----------- | ----------------------------------------------------- | ------------ | -------------------------------------- |
| unpaid      | open, no run on any item, Shopify says not fully paid | Unpaid       | the customer, in Shopify               |
| no workflow | open, no run on any item, fully paid                  | No workflow  | the merchant: tag, attach, or leave it |
| not started | open, a run, no task on any run started or done       | Not started  | a member can Start                     |
| making      | open, a task on an open run started or done           | Making       | the bench                              |
| made        | open, done runs and no open run                       | Made         | the merchant fulfils                   |
| fulfilled   | Shopify says `FULFILLED`                              | Fulfilled    |                                        |
| cancelled   | Shopify says `cancelledAt`                            | Cancelled    |                                        |

Unpaid and No workflow split today's Not started by one Shopify fact, so neither word is ever
false: an unpaid order whose item would match is not "No workflow", and the merchant does not go
looking for a tag. No workflow covers the rest of the no-run cases (untagged, a cancelled run, an
item Shopify removed): the item has no workflow on it now, whatever the history. These two are
positions with a badge, in the Status column of every row, like Fulfilled and Cancelled.

_The strip._ Unchanged: Open, Not started, Making, Made, Issues. Not started and Making change
meaning, nothing is added. Unpaid and No workflow join the Show select after Issues, with no
count, as Fulfilled and Cancelled do. Open's count still includes them; the three bench cells no
longer sum to Open, which the merchant never read off the strip anyway. The alternative is seven
cells (Open, Unpaid, No workflow, Not started, Making, Made, Issues), which answers "how many
untagged orders" at a glance at the cost of a wider strip.

_What the merchant sees._ The showcase shop today: Not started 4, Making 39. Under E: Not started
holds the untouched routed orders (the eight the seed meant as "not started"), Making the ones a
member has started, and the Open list shows the two gift-card orders badged No workflow and the
unpaid one badged Unpaid, with nothing in Issues. The untagged made-to-order product the safety
net exists for is now badged No workflow in the Open list, which is more visible than today's
Not started, not less.

_The order page._ Its facts line reads the same `orderPosition`. The item badge Not started
(`RUN_UNSTARTED_LABEL`) is unchanged and now means the same thing as the order's Not started.

_The member side._ Nothing changes. A member's Workflows list reads runs and tasks (states
Started by you, Started by others, Ready, Blocked, Done); an order with no run never reaches a
member, under any option. The merchant's Not started under E is the same set of orders the
member's Ready shows, in the merchant's word.

_"To make" instead of "Not started"._ To make was retired because the rung held unpaid and
untagged orders the bench would never make. Under E the rung holds only orders a member can
Start, so that objection is gone and the choice is which word reads better. Not started agrees
with the item badge on the order page, which would have to rename with it, and the three-rung
ladder reads as a timeline (Not started, Making, Made). To make reads as a to-do and sits beside
the member's Ready. Either works; the vocabulary rule is one word, one meaning, so whichever
word the rung takes, the item badge takes too.

_No workflow as a position does not reopen 7e1e88f._ That commit retired No workflow as an
_issue_, because an issue is an alarm and a ready-made order would alarm forever. A position is a
count and a neutral badge, not an alarm, and it is true. Cost of E: two vocabulary rows, the
`OrderPosition` and SQL changes B needs plus two more branches, the Show select, the help, the
seeds and their e2e assertions.

## What B would touch

- Vocabulary row for `not started` and `making` (the "Order positions" table), in the same change.
- `OrderPosition` JSDoc and `orderPosition`.
- `RunCounts` or `OrderRow`: a per-order "touched" fact. Two ways:
  - read it from `RunTask` (`startedAt`, `doneAt`) in the list query: a join or an `exists` per
    order. `docs/index-counts-performance-research.md` measured the count statement; a `RunTask`
    subquery is new cost on every live refresh and needs measuring. The only `RunTask` index today
    is `RunTask_teamId_idx (teamId, doneAt)`; a per-run `exists` would want one on `(runId,
startedAt)` or a scan of the run's tasks.
  - denormalize it onto `Run`, as `state` already is (`RunRepository`'s `recomputeState`): a
    `startedAt` column on `Run` holding the earliest task start, set by Start and by a Done without
    Start, recomputed by Put back and Reopen (both clear a task's `startedAt`, so the run's column
    clears only when every task's does). Then `COUNT_FACT` stays on `Run` rows and the `(orderId,
state)` index. A data-model row in the table on `initializeSchema` (`src/lib/ShopAgentSchema.ts`),
    with its pinned test, and the `holds by` column says schema+app.
- `OrderRepository.listOrders`: `showFilter` and `COUNT_FACT` for `not_started` and `making`.
- The order page's facts line: it rebuilds `RunCounts` from its runs and would also need the fact.
- Tests: `orderPosition`'s table in `test/integration/domain.test.ts` ("no open and no done run is
  not started"), the listOrders filter and count tests, and the vocabulary row check in
  `test/integration/spec.test.ts`.
- Seeds: the dev fixture's comments (`e2e/fixture.ts`, orders 1009, 1010, 1033) and the showcase's
  position counts change; the strip assertions in `e2e/orders.spec.ts` move.
- The help's Reading the orders list (`helpPages.ts`, slug `orders-list`; its description already
  names Not started, Making and Made).

## Decisions

Taken 2026-10-07 in review. Option E is the design; the help's Reading the orders list writes to it.

1. **Option E.** The ladder is the bench. `OrderPosition` grows to seven values: unpaid, no
   workflow, not started, making, made, fulfilled, cancelled, with the rules in the table under
   option E. Not started means a member can Start; Making means a task started or done.
2. **The first bench rung is Not started**, not To make. The order page's item badge keeps its word
   and now means the same thing as the order's position.
3. **A cancelled run and a removed item are No workflow.** No run on any item, paid, is No workflow
   whatever the history; no third word.
4. **A block or a note does not count as touching.** The position follows `runIsUnstarted`, as the
   order page's badge does; `runHasRecord` stays Change workflow's question.
5. **Put back returns an order to Not started** when nothing else on it was started or done.
6. **The touched fact is a denormalized column on `Run`**, recomputed with `state` on Start, Done,
   Put back and Reopen, with a data-model row and its pinned test. `COUNT_FACT` and `showFilter`
   stay on the `(orderId, state)` index.
7. **Taken up before the help page is written.** One pass over the help.
8. **No workflow is not an issue.** Confirmed in review: an issue is an alarm, a ready-made order
   would alarm forever, and the merchant could not clear it. 7e1e88f stands.
9. **The strip drops Open and adds No workflow.** Five cells. Open is Shopify's two facts, not a
   position; its count is "orders I still owe customers", which Shopify's own Orders page already
   shows, and its only job on the strip was the way back to the default. It stays in the Show
   select. Unpaid is a badge and a Show value with no count: the customer acts on it in Shopify,
   not the merchant in Baton.
10. **The default is Making, and the strip is in the order an order moves.** No workflow · Not
    started · Making · Made · Issues, Making pressed with `?show=` left out. The member's default
    is Started by you, what you are doing now; the merchant's analog is what the bench is doing
    now. One rule orders the cells, the order an order moves, so the help can say it in one
    sentence; Issues is last because it cuts across the four, and the alarm reads best at the
    end, where the member strip puts Blocked. "Default first" (the member strip's rule) was
    considered and rejected: it breaks the timeline for a cosmetic gain, and its "you first"
    reason does not apply to a merchant.

An order with one item done and another untouched is Making: the bench has begun the order.

## Sources

- `src/lib/domain/ShopWork.ts`: `OrderPosition`, `orderPosition`, `RunCounts`, `OrderRow`,
  `OrderCounts`, `ORDER_POSITION_LABEL`, `RUN_UNSTARTED_LABEL`, `runIsUnstarted`, the "Order
  positions" vocabulary table.
- `src/lib/OrderRepository.ts`: `OPEN`, `COUNT_FACT`, the `showFilter` branches in `listOrders`.
- `src/lib/domain/ShopWork.ts`: `runHasRecord`, the other touched predicate; `src/lib/changeWarning.ts`
  and `src/lib/RunRepository.ts` read `runIsUnstarted` too.
- `src/routes/app.orders.$orderId.tsx`: `RUN_STATE_BADGE`, `NOT_STARTED_BADGE`, `runStateBadge`.
- `src/lib/ShopAgentSchema.ts`: the `Run` DDL (`state` is denormalized from the tasks), the `RunTask`
  DDL and `RunTask_teamId_idx`.
- `e2e/fixture.ts` (orders 1009, 1010, 1033), `e2e/orders.spec.ts` (strip counts),
  `test/integration/domain.test.ts` (`orderPosition`'s table).
- `src/lib/helpPages.ts`: the `orders-list` page entry.
- Commit 7e1e88f (`git show 7e1e88f -- docs/view-row-press-button-plan.md`): No workflow leaves Issues.
- `docs/list-filter-search-research.md`: what the strip is for.
- `docs/showcase-shop-research.md`, `docs/showcase-shop-plan.md`: where it surfaced.

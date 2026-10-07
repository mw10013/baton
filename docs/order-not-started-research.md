# What "Not started" means on the orders index

Written 2026-10-07, while reviewing the showcase shop (`docs/showcase-shop-plan.md`, question 3 of
its second review). Parked for later; nothing here is decided. The question: should the orders
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
- `OrderRepository.listOrders`: the Show filter's SQL per position (`showFilter`, the `Match.when`
  branches near `"not_started"`) and the strip's counts (`COUNT_FACT`: `not_started` is
  `openRuns = 0 and doneRuns = 0`, `making` is `openRuns > 0`, `made` is `doneRuns > 0 and openRuns = 0`).
- `Domain.RunCounts` (`open`, `done`, `blocked` per order): the only per-order run facts the index
  reads. There is no "touched" fact.

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
open run. Made: unchanged. This matches `runIsUnstarted`, so the two screens agree, and the strip
answers "how much is waiting". Untagged orders still land in Not started, mixed with untouched
routed orders; the safety net becomes harder to see.

**C. B, plus a separate place for what Baton is not making.** As B, and the orders Baton will not
make (no run on any item, not unpaid) get their own filter or an issue again. 7e1e88f argued against
an issue ("a permanent false alarm" on every order for a ready-made product). A filter, not an
issue, would avoid the alarm. More screen.

**D. Rename instead of redefine.** Keep the rule and give the rung a word that says it: something
like "No workflow" (the word 7e1e88f retired) or "Not in Baton". Then Making covers untouched routed
orders honestly only if "Making" can mean "queued". It cannot, quite: nobody is making it.

## What B would touch

- Vocabulary row for `not started` and `making` (the "Order positions" table), in the same change.
- `OrderPosition` JSDoc and `orderPosition`.
- `RunCounts` or `OrderRow`: a per-order "touched" fact. Two ways:
  - read it from `RunTask` (`startedAt`, `doneAt`) in the list query: a join or an `exists` per
    order. `docs/index-counts-performance-research.md` measured the count statement; a `RunTask`
    subquery is new cost on every live refresh and needs measuring.
  - denormalize it onto `Run`, as `state` already is (`RunRepository`'s `recomputeState`): a
    `touchedAt` or `startedAt` column on `Run`, written by start, done, put back and undo. Then
    `COUNT_FACT` stays on `Run` rows and the `(orderId, state)` index. A data-model row in the table
    on `initializeSchema` (`src/lib/ShopAgentSchema.ts`), with its pinned test.
- `OrderRepository.listOrders`: `showFilter` and `COUNT_FACT` for `not_started` and `making`.
- Tests: `orderPosition`'s, the listOrders filter and count tests, and the vocabulary check.
- Seeds: the dev fixture's and the showcase's position counts change; the e2e assertions on strip
  counts move.
- The help's Reading the orders list.

## Open questions

These stay open until the topic is taken up.

1. Does Put back (a member un-starting a task) make an order Not started again, if nothing else on
   it was started or done? Under B as written, yes. Recommend yes: the order page's badge already
   reads that way.
2. Does a block count as touching? A merchant can block a run nobody started. Recommend yes: a block
   is a record someone made, and a blocked order is in Issues either way.
3. Does a run note count? Recommend no: a note is not work.
4. An order with one item done and another untouched: Making under B. Recommend yes: the bench has
   begun the order.
5. Where does an order with no run on any item go under B: Not started (as now), or its own place
   (option C)? This is the safety-net question and the main one.

## Sources

- `src/lib/domain/ShopWork.ts`: `OrderPosition`, `orderPosition`, `RunCounts`, `OrderRow`,
  `OrderCounts`, `ORDER_POSITION_LABEL`, `RUN_UNSTARTED_LABEL`, `runIsUnstarted`, the "Order
  positions" vocabulary table.
- `src/lib/OrderRepository.ts`: `OPEN`, `COUNT_FACT`, the `showFilter` branches in `listOrders`.
- `src/routes/app.orders.$orderId.tsx`: `RUN_STATE_BADGE`, `NOT_STARTED_BADGE`, `runStateBadge`.
- `src/lib/ShopAgentSchema.ts`: the `Run` DDL (`state` is denormalized from the tasks).
- Commit 7e1e88f (`git show 7e1e88f -- docs/view-row-press-button-plan.md`): No workflow leaves Issues.
- `docs/list-filter-search-research.md`: what the strip is for.
- `docs/showcase-shop-research.md`, `docs/showcase-shop-plan.md`: where it surfaced.

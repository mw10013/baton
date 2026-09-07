# The order workflow's trigger: what the code does, what the UI says — research

Research date: 2026-09-06. Research only, not a spec. Written to be reviewed by someone who has not read the code, so every claim carries a file and line and can be checked independently.

**One-line summary:** the order workflow's own detail page tells the merchant it "Starts for every paid order." That is incomplete. The real rule has five more conditions, three of which can silently make the order workflow never run on an order at all, and one of which is a behavioural dead-end that is recoverable only by a button nobody is told to press.

**Review status (2026-09-06):** reviewed and corrected. Corrections are marked _Reviewed:_ inline. Decisions in §5 are settled and §4 is the implementation scope.

## 1. What the code actually does

The single place an order run is created is `startOrderRunIfReady` in `src/lib/WorkflowRunRepository.ts:716-782`. It returns 0 or 1 and never opens its own transaction. Every condition, in evaluation order:

| #   | Condition                                                                                                                                       | Line               | Refuses when                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| 1   | An order workflow exists among the active definitions passed in                                                                                 | `:723-727`         | the shop has none                                                      |
| 2   | `canStart(orderWorkflow, teams)` — active, has steps, every step's team still exists                                                            | `:728`             | it is off, empty, or has an unassigned step                            |
| 3   | The order row exists and `Domain.canStartRuns(order)` — `fullyPaid && cancelledAt === null` (`Domain.ts:1137`)                                  | `:729-733`         | unpaid or cancelled                                                    |
| 4   | `anyDone` — **at least one item run on the order has status `done`**                                                                            | `:735-739`, `:757` | no item run has finished                                               |
| 5   | `anyOpen` — **no item run on the order is `pending` or `active`**                                                                               | `:745-750`, `:758` | any item is still being made                                           |
| 6   | `started` — no order run for this workflow on this order in **any** status                                                                      | `:751-756`, `:759` | one exists, including a cancelled one                                  |
| 7   | Age rule: `order.processedAt >= orderWorkflow.createdAt`, **unless** some item run on the order has `source = 'manual'` (`optedIn`, `:740-744`) | `:761-766`         | the order predates the workflow and nobody attached a workflow by hand |

Only then does it insert the run (`:767-775`), with `source: 'tag'`.

The function is called from exactly three places, all inside the caller's transaction:

| Call site                       | Line    | Meaning                                                   |
| ------------------------------- | ------- | --------------------------------------------------------- |
| `reconcileOrder`                | `:982`  | an order webhook or sync re-evaluated the order           |
| `cancelRun` (item runs only)    | `:1086` | cancelling the last open item run can start the order run |
| `completeStep` (item runs only) | `:1264` | finishing the last open item run starts the order run     |

**Nothing else calls it.** No workflow-definition write does — not create, not Apply, not Turn on.

## 2. What the UI says

| Surface                               | File                                                                     | What it says                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The order workflow's own detail page  | `src/components/WorkflowDetail.tsx:188` → `src/lib/workflowShared.ts:42` | **"Starts for every paid order."** and nothing else                                                                                              |
| The order workflow index page         | `src/routes/app.order-workflow.index.tsx:228`                            | the same constant, plus **"Its steps become ready once every item on the order that has a workflow is done. One order workflow per shop."**      |
| An order's detail page, waiting state | `src/routes/app.orders.$orderId.tsx:757`                                 | "_Name_ starts when all items are made."                                                                                                         |
| An order's detail page, too-old state | `src/routes/app.orders.$orderId.tsx:756`                                 | "_Name_ will not start here: this order was placed before that workflow was created. Attaching a workflow to an item by hand opts the order in." |
| `Domain.WorkflowScope` JSDoc          | `src/lib/Domain.ts:466-470`                                              | "runs once per order, after every item run on it is finished"                                                                                    |

The order-page section that carries the last two lines is itself conditional (`src/routes/app.orders.$orderId.tsx:747`):

```
orderRuns.length > 0 || (orderWorkflow !== null && itemRunCount > 0)
```

so it renders **only** once the order has at least one item run.

## 3. The issues

### A — The detail page states an incomplete trigger. (Medium)

_Reviewed:_ originally "false, High". A paid order whose items have workflows does get the order workflow, so the line is incomplete rather than wrong. Its severity is B's.

`ORDER_WORKFLOW_TRIGGER` is the bare string `"Starts for every paid order."` (`workflowShared.ts:42`) and `WorkflowDetail.tsx:188` renders it unmodified as the trigger line on the order workflow's own page. Conditions 4, 5, 6 and 7 are all absent from it. A merchant who configures an order workflow, reads its page, and places a paid order will see nothing happen and have no way to find out why. This is the page most likely to be read at exactly the moment the question arises.

### B — Two surfaces state different rules from one constant. (High)

The index page (`app.order-workflow.index.tsx:228`) repairs the constant by concatenating a corrective sentence. The detail page does not. The same identifier therefore means two different things depending on which page imported it, and the truthful version is the one the merchant is less likely to be on.

### C — The wait has no representation anywhere. (Low — largely withdrawn)

_Reviewed:_ the trigger runs inside the same transaction as the last `completeStep` (`:1264`), so there is no observable gap between "last item done" and "order run exists". While items are open, `Domain.productionState` resolves the order to `in_production`, which _is_ the wait's representation. The only unrepresented states are the dead-ends D, E and G. This also settles open question 4.

Between "order paid" and "last item done" there is no order run, so there is no card, no badge and no row on any surface. The only hint is a paragraph on the order's detail page, and only when at least one item run already exists (condition at `:747`). There is no state a merchant can look at that says _this order is waiting for its items_.

### D — An order with no item workflows never gets an order workflow, and is never told. (Medium)

Condition 4 requires at least one item run in status `done`. An order whose products match no workflow's tags has no item runs at all, so `anyDone` is 0 forever. The order detail page's condition at `:747` is also false in that case (`itemRunCount === 0` and `orderRuns.length === 0`), so the Order workflow section is **hidden entirely**. The merchant gets no run, no explanation, and no section. The behaviour is defensible for a made-to-order app; the silence is not.

### E — An order whose item runs were all cancelled dead-ends the same way. (Medium)

A cancelled run is neither `done` (condition 4) nor open (condition 5). If every item run on an order is cancelled, `anyDone` stays 0 and the order run never starts. `cancelRun` does call the trigger (`:1086`), which returns 0 silently. Whether that is correct is a design call — see the open questions — but today it is undisclosed either way.

### F — The age rule is disclosed on one surface only. (Medium-low)

Condition 7 is explained on the order detail page (`:756`) and nowhere else. Neither the order workflow's own page nor the index mentions that a newly created order workflow will not apply to any order already in the shop, which is precisely the situation of every merchant on their first day with the feature.

### G — No definition write re-evaluates existing orders, so an order can be stranded until someone presses Resync. (High — this one is behaviour, not copy)

_Reviewed:_ originally "permanently stranded, no surface says so". Not permanent: the order detail page's Resync button (`app.orders.$orderId.tsx:396`) calls `ShopAgent.resyncOrder`, which goes through `reconcileOrder` and therefore the trigger. The real defect is that nothing tells the merchant Resync is the way out, and the fix in 4.4 makes it unnecessary.

The trigger only ever runs from `reconcileOrder`, `completeStep` and `cancelRun`. Consider an order placed _after_ the order workflow was created (so condition 7 is satisfied) whose item runs all finish while the order workflow is **off**, or while one of its steps is unassigned. Condition 2 fails at completion time and returns 0. The merchant then turns the workflow on or assigns the team. Nothing re-evaluates that order: no step will complete on it again, no run will be cancelled on it again, and `reconcileOrder` only fires on an order webhook or a sync. The order never gets its order workflow, permanently, and no surface says so.

The same shape applies to condition 3: an order that finishes its items while unpaid and is paid afterwards is rescued only if a webhook happens to reconcile it.

### H — The internal JSDoc understates the rule. (Low)

`Domain.WorkflowScope` (`Domain.ts:530-534`) says "runs once per order, after every item run on it is finished". It omits condition 4 (at least one `done`) and condition 7 (the age rule) entirely. It is the definition future readers will trust.

## 4. What should be done

Grouped by whether it is copy, product surface, or behaviour. Copy strings below are proposals for a spec to settle, not final text.

### 4.1 One truthful statement of the trigger, used everywhere (fixes A, B, D, F)

Replace the bare `ORDER_WORKFLOW_TRIGGER` constant with one that states the whole rule, and use it identically on the detail page and the index. Something with this content:

> **Runs once per order, after every item with a workflow is made.** An order where no item matches a workflow never starts it. Orders placed before this workflow was created are skipped, unless you attach a workflow to one of their items by hand.

Three sentences, because there are three things the merchant cannot infer: the wait, the exclusion, and the age rule. The index page's extra "One order workflow per shop" is a cardinality fact rather than a trigger fact and should stay separate from the trigger line.

The current index-page phrasing "once every item on the order **that has a workflow** is done" is the most accurate sentence in the app today and is worth keeping as the core of the replacement.

### 4.2 Make the order page state the outcome in every case (fixes D, E, F, and makes G visible)

Change the section's render condition at `app.orders.$orderId.tsx:747` so the Order workflow section appears whenever the shop has an order workflow and the order is one runs could start on, and give it one line per state:

| Order state                                  | Line                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Order run exists                             | the run card, as today                                                                                                               |
| Items still open                             | "_Name_ starts when every item with a workflow is made."                                                                             |
| No item has a workflow                       | "_Name_ won't start on this order: no item on it has a workflow. Attach one to an item to opt this order in."                        |
| Every item run cancelled                     | "_Name_ won't start: every item run on this order was cancelled."                                                                    |
| Order predates the workflow                  | the existing too-old line                                                                                                            |
| Order workflow off or has an unassigned step | "_Name_ is off" / "_Name_ has a step with no team." with a link to the workflow (_Reviewed:_ added; this is the G case made visible) |

Each of these is derivable from data the page already loads (`orderRuns`, `itemRunCount`, `tooOld`), except the all-cancelled case, which needs the item runs' statuses — also already on the page.

### 4.3 Consider a waiting state on the orders index (fixes C, optional)

`Domain.productionState` (`Domain.ts:1335-1345`) resolves an order to `cancelled` / `shipped` / `no_workflow` / `in_production` / `ready_to_ship`. An order whose items are all done and whose order workflow has not started resolves to `ready_to_ship`, which is arguably right and arguably hides the wait. _Reviewed:_ **leave it.** Once the order page names the dead-end reason, `ready_to_ship` for an all-done order is acceptable.

### 4.4 Fix the stranding (fixes G)

Three options, in ascending cost:

- **(a) Do nothing, and document it.** Cheapest, and defensible only if the window is genuinely rare. It is not obviously rare: turning the order workflow on for the first time, or fixing an unassigned step, are both first-week actions.
- **(b) A manual escape hatch.** The order detail page already has "Attach workflow" for items. An equivalent action for the order workflow — "Start order workflow" — makes every stranded order recoverable by hand and adds no background work. It also gives the merchant a way to act on the messages proposed in 4.2.
- **(c) Re-evaluate on definition writes.** When the order workflow is turned on, or a draft applied that makes it startable, sweep the shop's open orders and call the trigger for each. Correct and automatic, but it is a scan inside a Durable Object write, and it needs a bound (only orders that are paid, uncancelled, unfulfilled and newer than the workflow).

_Reviewed:_ **(c) now, skip (b).** (b) duplicates Resync, which already exists, and invites routine bypassing of the wait. (c) is not a scan: one SQL query on `setWorkflowActive` and `applyDraft` for the order workflow, selecting orders that are paid, uncancelled, unfulfilled, have a `done` item run, no open item run, no order run for this workflow, and either `processedAt >= createdAt` or a manual item run. That is a few dozen rows in any real shop. It runs right after the write in the same callable, not inside the write's transaction (the repository owns that one and Durable Object SQLite refuses to nest); the Durable Object serialises callables, so nothing interleaves.

### 4.5 Correct the internal JSDoc (fixes H)

`Domain.WorkflowScope` should state all seven conditions or point at `startOrderRunIfReady` as the authority. Per this repo's conventions the reasoning belongs inline in the JSDoc, and it must not reference this file — `docs/` goes stale.

## 5. Open questions for the reviewer

_Reviewed:_ all settled, decisions after each question.

1. **Should condition 4 (`anyDone`) exist at all?** Its stated purpose is that "a stock-only order never triggers". But it also strands the all-cancelled case (E). An alternative rule — _at least one item run exists, in any status, and none is open_ — keeps stock-only orders out while letting an all-cancelled order finish. Is that better?
   **Decision: keep `anyDone`.** Relaxing it means cancelling the last item run auto-starts the order run, and the un-cancel recovery path would then race a live order run.
2. **Is the all-cancelled order supposed to get an order workflow?** If a merchant cancels every item run because the customer changed their mind, presumably nothing should be packed. If they cancelled them because the items were made outside Baton, presumably it should. The current behaviour picks the first reading silently.
   **Decision: no, by default.** The customer-changed-mind case is already handled by cancelling the Shopify order, which condition 3 blocks. The made-outside-Baton case is rare; the 4.2 line states the outcome and Resync remains the manual route.
3. **Is 4.4(b) "Start order workflow" the right escape hatch,** or does a manual start invite merchants to bypass the wait routinely?
   **Decision: no manual start.** Resync is the escape hatch, and 4.4(c) removes most of the need for one.
4. **Should the wait be a visible run state** rather than an absence? That is the larger version of C: create the order run at payment in a `waiting` status instead of not creating it. It is a bigger change and interacts with the decision recorded in `workflow-naming-research.md` §4 to keep the after-items rule — worth knowing whether the reviewer thinks that decision was right.
   **Decision: no waiting run state.** The after-items decision was right. The gap is atomic in practice (see C), and a `waiting` status would leak into run counts, `productionState`, cancel semantics and every list.
5. **Does the age rule need the manual-attach exception explained to merchants,** or is it enough that it silently does the right thing for the one workflow they hand-attached?
   **Decision: yes, one clause on the workflow page,** as in the 4.1 copy. The exception is the only action a merchant can take on an old order, so it belongs where they read the rule.

## 6. How to verify each claim

```bash
sed -n 716,782p src/lib/WorkflowRunRepository.ts   # the whole trigger
grep -rn "startOrderRunIfReady" src/               # the three call sites
sed -n 40,44p  src/lib/workflowShared.ts           # ORDER_WORKFLOW_TRIGGER
sed -n 185,190p src/components/WorkflowDetail.tsx  # rendered bare on the detail page
sed -n 226,230p src/routes/app.order-workflow.index.tsx  # the corrective sentence
sed -n 745,762p src/routes/app.orders.\$orderId.tsx      # the conditional section
sed -n 464,472p src/lib/Domain.ts                  # the WorkflowScope JSDoc
sed -n 1135,1140p src/lib/Domain.ts                # canStartRuns
```

# Reconcile spec review: implementation plan

This plan carries out the fourteen decisions and sixteen recommendations in
`docs/reconcile-spec-review-research.md` (under "Decisions" and "Recommendations, gathered").
Read that doc first: section 1 is the post-condition the spec gains, sections 2 to 8 say what
each table is missing, and the decisions say which way each question went. This plan says what
to change, in what order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that is the concept or enforces it. Other
    sites `{@link}` it. A JSDoc never cites a file under `docs/`; it carries its reasoning
    inline.
  - The action matrices and the triggers, effects and pass rules tables on `reconcileItem`
    are the spec: the test reads them out of the source, and a behaviour change starts at the
    cell. A `pinned by` title must exist in some test as an `it(...)` title. `(none yet)` is
    tolerated by the check and not by this plan: every row this plan adds gets its test in
    phase 5.
  - Status, flag and role predicates are `Domain` functions, never inline comparisons.
  - No migrations while prototyping. No schema change is planned here; if one turns out to be
    needed, edit `initializeSchema` in place and run `pnpm dev:reset` yourself.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`), `pnpm
  test`, `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go: what the plan said, what you
  found, the two options you saw, and the one you took.
- Each phase is one change. Phases 1 and 2 change no behaviour; phase 3 does. Do not merge
  them, so a behaviour change is never hidden inside a wording change.

## The decisions, in the order the phases take them

| decision or rec. | what                                                                                                                          | phase |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1                | the post-condition of a pass, on `reconcileItem` above the tables                                                             | 1     |
| rec. 3, 7, 16    | column words defined; every ceiling qualified; titles say "open paid order"                                                   | 1     |
| 5, 6, rec. 5     | the release trigger row rewritten; the writes that lower the count listed; three `none` rows                                  | 1     |
| 7                | one definition of multi-match, in the noun                                                                                    | 1     |
| 9, 10, 12, 13    | sentences: reattach by hand; rule 7's case; what bounds a reconcile all; refund and archive are not stops                     | 1     |
| rec. 12, 13, 14  | rule 8 links sync rule 12; rule 3 says a stream and a reconcile all may interleave; rule 2 says what a partial failure leaves | 1     |
| 2                | the actions matrix is total; `pnpm spec check` refuses a gap or an overlap; four rows added                                   | 2     |
| 3                | the badge: a resize on an unstarted run clears it                                                                             | 3     |
| 8                | on a truncated order, a run whose item is not stored is left alone                                                            | 3     |
| 4                | the retention sweep asks whether the open-run ceiling released                                                                | 3     |
| 7                | `multiMatchItems` takes the order; `reconcileOrder` calls it instead of restating it                                          | 3     |
| 11               | one test title per rule: rules 4 and 5 and the declined row split                                                             | 4     |
| 1, rec. 6        | the post-condition's property test; a test for every new row                                                                  | 5     |

## Phase 1: the spec text

Goal: the JSDocs say everything the research found missing. No code path changes; every
existing test passes unchanged. `pnpm spec check` passes, with `(none yet)` on the rows that
phase 5 pins.

### 1.1 The post-condition, on `reconcileItem`

In `src/lib/domain/ShopWork.ts`, in the JSDoc on `reconcileItem`, after the first paragraph
("**Reconcile** makes an order's runs agree...") and before "Two gates, split on purpose",
add a paragraph headed **What a pass guarantees**, with the five clauses of the research's
section 1 as a list: stop, fit, record, create, orphan. Write the orphan clause with the
truncation exception from decision 8: "A stored run whose item is not stored is read as an
item at zero units, unless the order's items were truncated at sync
(`ShopOrder.lineItemsTruncated`), when it is left alone: the item may still exist past the
kept 250." End with: "A pass writes only what these clauses require (pass rule 9) and
reaches them in one transaction (pass rule 2). The actions table below is this condition by
cases, and `pnpm spec check` holds the table total; the test titled with this paragraph's
heading checks the condition on generated inputs."

The pinned title for this paragraph, used in phase 5: **a pass guarantees stop, fit, record,
create and orphan, and a second pass writes nothing**.

### 1.2 The actions table preamble

Extend the preamble ("What it does to one item. Each row is a fixture set...") with one
sentence per column word that is not yet defined:

- `paid` reads `fullyPaid` and nothing else ({@link orderCanCreateRuns} is the creation gate;
  authorized or partially paid is `no`).
- `units`: `0` is no units to make; `some` is above zero; `same` is above zero and equal to
  the run's quantity; `changed` is above zero and not equal to the run's quantity. `changed`
  compares to the run, never to Shopify's ordered `quantity`.
- `run on item`: `open` is unstarted or started (already there); add that `done or closed`
  covers both and that `none` is no run in any state.
- `matches`: `1, at the ceiling` is one match while the shop holds `ShopLimits.maxOpenRuns`
  open runs; the ceiling is read only for `create`.

Add to the resize rows' free text what decision 3 settles, in the cell: "resize: no badge,
and any badge clears" for the unstarted row. The badge rule itself goes on
`Run.quantityChangedFrom` (1.9); the cell links it.

### 1.3 Qualify every ceiling

In the triggers table, the effects table and pass rules 4 to 7 on `reconcileItem`, and in
the `ReconcileAction` JSDoc: "order ceiling" where `maxOrdersPerCycle` is meant (the webhook
and Sync open orders rows' `skipped when`), "open-run ceiling" where `maxOpenRuns` is meant
(everything else). No bare "the ceiling" remains in these tables. The `ceiling flag` column
header of the effects table becomes `open-run ceiling flag`; update `parseReconcileEffects`'s
expected header in `scripts/lib/spec.ts` to match.

### 1.4 The release trigger row

Replace the row "the open-run ceiling releasing | reconcile all | still at the ceiling | ..."
with:

| trigger                                | shape         | skipped when                                                       | pinned by                                                                        |
| -------------------------------------- | ------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| a write that lowers the open-run count | reconcile all | no run was declined, or the count is still at the open-run ceiling | the write that releases the open-run ceiling creates the runs that were declined |

The pinned title is the existing one with "open-run" inserted; retitle the test in
`test/integration/shop-agent-orders-ceiling.test.ts` (or wherever `grep` finds "the write
that releases the ceiling") to match.

### 1.5 The three `none` rows

Add to the triggers table, after the Attach row:

| trigger                           | shape | skipped when                                                                                       | pinned by                                                                    |
| --------------------------------- | ----- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| a product retagged in Shopify     | none  | always: an item's tags are a snapshot taken at sync; the next sync of its order sees them          | a product retagged in Shopify changes nothing until its order syncs again    |
| the retention sweep               | none  | always: it deletes the order and its runs, open ones included, and records no close                | the retention sweep deletes an order with its open runs and records no close |
| Delete workflow, for its own runs | none  | always: a run copies its definition and carries on; only an item it left multi-match is reconciled | deleting a workflow leaves its runs to carry on                              |

Write `(none yet)` in the `pinned by` cells until phase 5 writes the tests, then fill them
with the titles above.

Before writing the Delete workflow row, confirm what `removeWorkflow` in
`src/lib/WorkflowRepository.ts` does to `Run` rows. The research did not find a delete. If
it does delete or close runs, stop and record it under deviations: the row then says what the
code does and the user decides whether that is the rule.

### 1.6 The pass rules

Edit the pass rules table on `reconcileItem`:

- **Rule 1** gains the truncation exception, in the same words as 1.1.
- **Rule 2** gains: "a reconcile all that fails partway keeps the orders it walked; the next
  trigger finishes the rest (rule 9)".
- **Rule 3** gains: "a stream and a reconcile all may interleave, each with its own snapshot;
  every order ends under the newer one because each pass is idempotent (rule 9)".
- **Rule 4** gains: "items in their stored order" after "each create spends one".
- **Rule 7** gains: "a reconcile all is bounded by retention and the order ceiling, not by a
  limit of its own" and, for its second half, "the case is a run whose item was dropped
  without a reconcile; no live path does that, and the rule is what makes never twice
  provable".
- **Rule 8** keeps its first half; the second half becomes "the stream's flush is rule 12 on
  {@link syncOrder}".
- **New rule 11**: "the open-run count is lowered by a run's last Done, Cancel workflow, a
  close by reconcile and the retention sweep, and each asks whether the open-run ceiling
  released; Reopen and a manual attach over a closed run raise it, Reopen without a ceiling
  check, by one". `where`: `RunRepository.releaseOpenRunLimit`, `OrderRepository.sweepExpiredOrders`.
  `pinned by`: the title phase 5 writes for the sweep, **the retention sweep releases the
  open-run ceiling when its deletes make room**. Until then `(none yet)`.

Split the shared pinned titles now, with the new titles phase 4 gives the tests; until phase
4 lands, `pnpm spec check` will fail on them, so do 1.6's title cells and phase 4 in the
same run of the checks, or write `(none yet)` and fill in phase 4. Titles:

- Rule 4: **the open-run ceiling is counted once per pass; each create spends one and a close
  refunds nothing**.
- Rule 5: **at the open-run ceiling a pass declines, the webhook answers 2xx and the order is
  stored without its run**.
- The `nothing: declined` effects row: **a declined run raises the open-run ceiling flag and
  the run's last Done clears it**.

### 1.7 The gates prose

In the `reconcileItem` JSDoc paragraph on the two gates, add: "A refund is not a stop: a
refund that returns money and leaves the items leaves `currentQuantity` alone, and the work
goes on; the merchant's stop is a cancel. An archive (`closedAt` in Shopify) is not a stop
either; it is not mirrored, and an open order archived by hand keeps its runs." And replace
"the price is a late run, not a wrong one" with "the price is a run whose task reads Needs a
team until the merchant assigns it".

### 1.8 Multi-match, one definition

In the shop-work nouns table, the `multi-match` row's meaning becomes: "an item two or more
eligible workflows match, with units to make and no run in any state, on an order that can
create runs; an unpaid order is not choosing, since reconcile would create nothing either
way". In the order issues table, the `multi_match` row's meaning becomes "a multi-match item
on the order" and links the noun. The JSDoc on `OrderRow.multiMatchItems` and on the function
`multiMatchItems` link the noun instead of restating it; the function's own change is 3.4.
Run `pnpm spec check`: `checkVocabulary` must still find every word.

### 1.9 Sentences elsewhere

- `Run.quantityChangedFrom` JSDoc in `src/lib/domain/ShopWork.ts`: state the whole badge
  rule once. "Set by the first resize after a task started or was done, to the quantity before
  it; a later resize keeps it, and clears it when the units return to it; a Done clears it; a
  close clears it; a resize on an unstarted run never sets it and clears any it has, because
  nobody is working to the old number." The `resize` rows of the actions table and
  `RunState`'s "reconcile resizes" row link here.
- `ClosedReason` JSDoc: after the fulfilled paragraph, "A closed run holds its item, so an
  item refunded to zero and edited back up keeps its `item_removed` run and shows its units
  beside the reason; the merchant reattaches by hand with Change workflow. No issue is
  raised for it."
- Effects table, under the table: "Manual attach also creates a run and counts the order; it
  is outside reconcile (the Attach row of the triggers table) and its counting is stated on
  {@link orderIsOpen}."
- The three pinned titles that say "every stored open order" for a reconcile all (Turn on,
  and any other `grep` finds) say "every stored open paid order"; retitle the tests.

### 1.10 Done when

`pnpm spec check` passes. `grep -n "the ceiling" src/lib/domain/ShopWork.ts` finds no bare
use inside the four reconcile tables. `pnpm spec print` shows the `(none yet)` count equal to
the rows this phase added (five: three `none` rows, rule 11, and the post-condition if you
list it as a row; otherwise four).

## Phase 2: the actions matrix is total

Goal: `pnpm spec check` refuses an actions table on `reconcileItem` whose rows do not cover
every fixture exactly once, and the same for `runActions` and `taskActions`. The four missing
rows are added. No behaviour changes: every added row states what `reconcileItem` returns
today.

### 2.1 The universe

In `scripts/lib/spec.ts`, beside `expandReconcileAction`, add `reconcileActionUniverse()`:
the cartesian product of each column's atom fixtures, where an atom is the expansion of each
word that is not `any`, deduplicated by `JSON.stringify`. Two parser changes make the universe
honest:

- `some` under `units` expands to `[RUN_QUANTITY, RUN_QUANTITY + 1]`, not `[RUN_QUANTITY]`:
  with no run, "above zero" has no quantity to equal, and today a `some` row covers only one
  of the two values `any` reaches.
- `any` under `matches` stays `0, 1, 2` without the ceiling; the universe includes the
  `1, at the ceiling` atom on its own.

Add `reconcileActionGaps(rows)`: universe fixtures no row expands to; and
`reconcileActionOverlaps(rows)`: fixtures two rows expand to (the form of `overlaps` and
`syncActionOverlaps`). In `scripts/spec.ts`, the `parseReconcileActions` branch's `onSuccess`
reports both, one line per gap naming the fixture and one per overlap naming the two lines.

Do the same for `runActions` and `taskActions` through `expand` and `WORDS`: a
`universe(name)` from each column's non-`any` words, and `gaps(name, rows)` beside `overlaps`.
If a gap turns up there, add a row that states what the code does today and record it under
deviations; do not change `runActions` or `taskActions` behaviour in this plan.

### 2.2 The rows

Add to the actions table on `reconcileItem`, in the positions the research's section 2 table
puts them:

| order  | paid | units | run on item | matches           | action                                                          |
| ------ | ---- | ----- | ----------- | ----------------- | --------------------------------------------------------------- |
| closed | any  | any   | none        | any               | nothing: the order is over, nothing to create                   |
| open   | any  | 0     | none        | any               | nothing: no units to make                                       |
| open   | no   | some  | none        | 2+                | nothing: not choosing until it pays                             |
| open   | no   | some  | none        | 1, at the ceiling | nothing: created when it pays; the open-run ceiling is not read |

Then run `pnpm spec check`. If the gap check names a fixture these four do not cover, the
research missed a row: add it with the action `reconcileItem` returns today and record it
under deviations.

### 2.3 The spec tests

In `test/integration/spec.test.ts`, beside "two rows that share a fixture are an overlap":
"a fixture no row covers is a gap" and "the real actions table on reconcileItem is total",
and the same pair for `runActions` and `taskActions` through `gaps(name, rows)`.

### 2.4 Done when

`pnpm spec check` passes with the gap and overlap checks on; `test/integration/run-actions.test.ts`
("Domain.reconcileItem actions") passes with the four new rows and the widened `some`;
`pnpm spec print` prints the fixture count per row including the new ones.

## Phase 3: the behaviour changes

Goal: the four decisions that change what the code does. One sub-phase each; run the checks
between them.

### 3.1 The badge clears on an unstarted run (decision 3)

In `RunRepository.reconcileOrder` in `src/lib/RunRepository.ts`, the `resize` branch of
`execute`: when `badge` is false, `from` is `null`. Today it is `run.run.quantityChangedFrom`
(kept). The badge-true branch is unchanged: `original = quantityChangedFrom ?? quantity`,
`from = original === units ? null : original`. Point the comment at `Run.quantityChangedFrom`
(1.9), which is now the rule.

Test, in `test/integration/run-repository.test.ts` beside "a resize rewrites the quantity and
counts nothing": **a resize on an unstarted run clears the quantity badge** (start a task,
resize so the badge sets, put the task back, resize again, assert `quantityChangedFrom` is
null) and **a resize back to the original clears the badge; a Done clears it** (resize up with
a started task, resize back, null; resize up again, mark done, null). Add both titles to the
`RunState` table's "reconcile resizes" row or the `Run.quantityChangedFrom` JSDoc, wherever
the rule now lives; the actions table's resize rows stay pinned by the matrix test.

### 3.2 A truncated order's orphans are left alone (decision 8)

In `reconcileOrder`, the `entries` list's second half (runs whose `lineItemId` is not in
`stored`) is built only when `!order.lineItemsTruncated`. `order` is already decoded with
`lineItemsTruncated` (`orderColumns` selects it). Add a one-line comment linking pass rule 1.

Test, beside "a pass reads the stored order, and a run whose item is gone closes as item
removed": **on a truncated order a run whose item is not stored is left alone** (store an
order with `lineItemsTruncated = 1`, a run on an item id not among its stored items, reconcile,
assert the run is still open). Pin it on rule 1 beside the existing title.

### 3.3 The retention sweep asks for a release (decision 4)

`OrderRepository.sweepExpiredOrders` already returns how many runs it deleted (`runs`). It
cannot call `RunRepository.releaseOpenRunLimit` itself (it is in the other repository and the
sweep's transaction is the order's). So the caller asks:

- Put `releaseOpenRunLimit` on the `RunRepository` interface (today it is a closure inside the
  layer; the interface already exposes `{ ceilingReleased }` on `cancelRun` and
  `markTaskDone`). Its JSDoc's list of callers gains the sweep and links rule 11.
- At both call sites in `src/lib/ShopAgent.ts` (the webhook path near line 971 and the stream
  near line 1213), after a sweep whose `runs > 0`: `releaseOpenRunLimit()`, and on `true`,
  `ShopWorkAgent.afterCeilingReleased("sweep")`. On the stream path, the one release pass after
  the stream already runs when any order released; fold the sweep's answer into that same
  decision (one reconcile all after the stream, not two), which is what the pipeline table's
  "once after the stream" cell says.

Test, in `test/integration/shop-agent-orders-ceiling.test.ts`: **the retention sweep releases
the open-run ceiling when its deletes make room** (fill to the ceiling with runs on an order
older than retention, decline a run on a fresh order so the flag is set, trigger the sweep
through the webhook path, assert the flag is null and the declined run exists). Pin rule 11.

### 3.4 One definition of multi-match (decision 7)

`Domain.multiMatchItems` has no caller today; `reconcileOrder` computes the same count inline
with the gate, and `OrderRepository.listOrders` has the SQL twin `MULTI_MATCH_ITEM`. Change
the function to take the order and apply the gate:

```ts
export const multiMatchItems = (
  order: Pick<ShopOrder, "fullyPaid" | "cancelledAt">,
  lineItems: readonly OrderLineItem[],
  runs: readonly Run[],
  details: readonly WorkflowDetail[],
  teams: readonly { readonly id: TeamId }[],
): number =>
  orderCanCreateRuns(order)
    ? lineItems.filter(...).length
    : 0;
```

Then `reconcileOrder`'s `multiMatch` block calls it (it needs the ids too, for the log line;
either return the items rather than a count and let `OrderRow` take `.length`, or keep the
count and compute ids beside it; prefer returning the items, renamed to the same word, and
have `OrderRow.multiMatchItems` stay a number computed from it). `orderIssues`' own
`orderCanCreateRuns(order) &&` guard becomes redundant once the count carries the gate; keep
the predicate there anyway (the row reads a number the SQL computed, and the SQL twin
`MULTI_MATCH` already has `fullyPaid = 1`), and say in `orderIssues` that the gate is applied
twice on purpose, once per twin.

Test, in `test/integration/domain.test.ts` or `run-actions.test.ts`: **multi-match counts only
on an order that can create runs** (same items and workflows, paid and unpaid, 1 and 0).

### 3.5 Done when

All four tests pass; `pnpm spec check` passes with the rule 1 and rule 11 titles filled in;
`pnpm test` passes. Check the orders index and the order page on the dev store
(`pnpm dev:start --seed`, then the Issues view) still show Multiple workflows match on the
seeded multi-match order and not on an unpaid one.

## Phase 4: one test title per rule (decision 11)

Goal: no pinned title appears on more than one rule or row.

In `test/integration/run-repository.test.ts`, split "reconcile yields to the ceiling and
records it; the run's last Done clears the flag" into three tests, one per title from 1.6:

- Rule 4's test: one order with three items, two single matches and one open run whose item
  is at zero; the shop one under the ceiling; assert one create, one close, one declined, and
  that the close did not make room for the third in the same pass (the second pass is rule 7's
  test, not this one).
- Rule 5's test: through the webhook path in `test/integration/shopify-webhook.test.ts` or
  `shop-agent-orders-ceiling.test.ts`: at the ceiling, a webhook returns 200 and the order is
  stored with no run.
- The declined row's test: at the ceiling, reconcile; assert `openRunsLimitedAt` is set; mark
  a run's last task done; assert null.

Fill the three `pinned by` cells. Run `pnpm spec check`: every title must now be carried by
exactly the test that pins it; `grep` each old title to be sure no table still names it.

## Phase 5: the tests the new rows owe

Goal: no `(none yet)` on reconcile's tables.

| row                                     | test title                                                                               | file                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| the post-condition (1.1)                | a pass guarantees stop, fit, record, create and orphan, and a second pass writes nothing | `test/integration/run-actions.test.ts`           |
| a product retagged in Shopify (1.5)     | a product retagged in Shopify changes nothing until its order syncs again                | `test/integration/shop-agent-sync-order.test.ts` |
| the retention sweep (1.5)               | the retention sweep deletes an order with its open runs and records no close             | `test/integration/order-repository.test.ts`      |
| Delete workflow, for its own runs (1.5) | deleting a workflow leaves its runs to carry on                                          | `test/integration/shop-agent-workflows.test.ts`  |
| rule 11 (1.6)                           | the retention sweep releases the open-run ceiling when its deletes make room             | written in 3.3                                   |

The post-condition test is a property test without a library: enumerate the universe from
2.1 (it is small: 2 × 2 × 3 × 5 × 4 fixtures plus the open order), and for each fixture
apply `reconcileItem`, build the state the action leaves (a closed run, a resized run, a
created run, or the same), assert the five clauses on it, then call `reconcileItem` again on
that state and assert `nothing` with `declined: false`. Write the five clauses as five small
predicates in the test, named `stop`, `fit`, `record`, `create`, `orphan`, so a failure names
the clause. The orphan clause takes a `truncated` flag and a missing item.

The retag test: store an order whose item carries tag `a`, with an on workflow tagged `b`;
assert no run; sync the order again with the item now carrying `b`; assert a run. Nothing in
between (no reconcile all) may create it.

The Delete workflow test: an on workflow with a run on an item; delete the workflow; assert the
run is still open with its tasks and `workflowName`. If 1.5's check found that delete removes
runs, this test is not written and the deviation says what was decided instead.

Done when `pnpm spec print` reports zero `(none yet)` on `reconcileItem` and `pnpm test`
passes.

## After the last phase

- `pnpm typecheck && pnpm lint && pnpm test && pnpm fmt`; keep every formatted file.
- `pnpm vocab:audit`: no new word from this plan should appear (the plan introduces none).
- Update `docs/reconcile-spec-review-research.md`'s status line to "implemented <date> by
  `docs/reconcile-spec-review-plan.md`".
- Do not commit unless told to.

## Deviations and issues

Record here, as you go, anything that did not go as written: what the plan said, what you
found, the two options you saw, and the one you took. One entry per item, dated.

All entries 2026-10-01. All five phases were done in one run, without commits, so the
`(none yet)` interim step was skipped: every row was written with its final title and its test
in the same change.

1. **Pass rules take several titles.** Rule 1 needs its existing title and the truncation
   title (3.2), and the post-condition title (1.1) had no table row, so `pnpm spec check`
   could not see it. Options: a free-floating title, or let a pass rule's `pinned by` hold
   several titles. Took the second: `parseReconcilePassRules` splits on `; ` as the sync tables
   do, and the post-condition title is pinned on rule 9 beside the idempotence title. Rule 4's
   title is therefore "the open-run ceiling is counted once per pass, each create spends one
   and a close refunds nothing" (a comma, not `; `).
2. **`any` under `matches` includes the open-run ceiling.** 2.1 said `any` stays `0, 1, 2`
   and the universe holds `1, at the ceiling` on its own. Then every `any` row leaves the
   ceiling fixture uncovered (a cancelled order with an open run at the ceiling has no row).
   Options: add ceiling rows for every `any` row, or let `any` mean every value, as the
   preamble says. Took the second; no row overlaps because both ceiling rows are `open | some |
   none`. The parser test's fixture count for the cancelled row is now `2 * 3 * 2 * 4`.
3. **`runActions` was not total.** Units at zero had no row on a done or closed run, on a
   closed order, or on a blocked open run. Added `any` to the `units` words (`1; 0`), wrote
   `any` on the four rows where units do not matter, and added `open | open | yes | none` (no
   Change workflow). The matrix and callables tests pass on the new fixtures; no behaviour
   changed.
4. **`taskActions`' raw cross product holds states the object cannot.** A `done` run with a
   task not done, and a downstream blocker on a task Reopen is never asked about (what `-`
   means). Options: change `-` to expand to both blockers, or keep the universe to reachable
   states. Took the second (`reachable` in `scripts/lib/spec.ts`, stated on the `taskActions`
   JSDoc). One real gap remained: a closed run on a closed order; added `closed | closed | no |
   any | -`, all blank.
5. **The sweep asks through shop work.** 3.3 had `ShopAgent.ts` call
   `RunRepository.releaseOpenRunLimit` itself. The class otherwise reaches runs only through
   `ShopWorkAgent`, so the call is `ShopWorkAgent.sweepReleasedCeiling(runs)`; the interface
   still exposes `releaseOpenRunLimit`, where its rule now lives. On the stream path the sweep
   now runs before the one release pass (it ran after), so its answer folds into that pass.
6. **Rule 8's `where`** drops `ShopAgent.onOrdersStream`, since its second half now links sync
   rule 12 instead of restating it.
7. **The badge tests.** "a resize back to the original clears the badge, and a Done clears
   it" is the existing "a quantity changed back to the original clears the badge" retitled and
   extended with the Done clause, not a second test. Review (2026-10-01): both badge titles
   are pinned on the resize row of the effects table, whose `pinned by` now takes several
   titles as the pass rules do, so `pnpm spec check` holds them; the
   `Run.quantityChangedFrom` JSDoc points at that row.
8. **Where the webhook tests live.** Rule 5's test and the sweep-release test are in
   `test/integration/shop-agent-sync-order.test.ts`, which has the Admin API stand-in;
   `shop-agent-orders-ceiling.test.ts` has none. That file now clears `adminRequests` after
   each test, since the existing one-order sync test counts requests.
9. **Delete workflow (1.5) checked.** `WorkflowRepository.deleteWorkflow` deletes the
   `Workflow` row only; its tasks and draft cascade, and `Run` has no foreign key to it. The
   row says what the code does.
10. **3.5's dev-store check** was run as the two e2e tests that cover it ("an item matching
    two workflows waits for the merchant to choose, then changes" and "each view's count is
    what pressing it shows, given the team"), against the running dev server; both pass. The
    screens read the SQL twin, which this plan did not change.
11. **Review (2026-10-01).** Four fixes after review: the stream path asks the sweep for a
    release even when the stream already released, since a later streamed order may have
    raised the flag again; the title "is idempotent, and a closed item creates nothing on
    reconcile" was shared by rule 9 and the effects row `nothing (every other reason)`, so the
    test is split into "a second pass over the same stored order writes nothing" (rule 9) and
    "a closed item creates nothing on reconcile" (the row); the post-condition paragraph names
    the test pinned on rule 9 instead of "this paragraph's heading"; three prose sites that
    said "every stored open order" say "open paid". The two uncaught exceptions the full test
    run prints come from `shop-agent-usage-flush.test.ts`, which corrupts a stored order and
    invalidates a session on purpose; they predate this plan.

# Reconcile spec: implementation plan

This plan carries out the decisions in `docs/reconcile-research.md` (decisions 1 to 20 under
"Decisions"). Read that doc first: "The short version", "Where reconcile sits on the map",
"What one pass does" and the two spec tables under "What the spec could look like" say what
reconcile is; the decisions say what changes. This plan says what to change, in what order,
and how to know each phase is done.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that is the concept or enforces it. Other
    sites `{@link}` it. A JSDoc never cites a file under `docs/`.
  - A vocabulary word moves in the same change as its symbols. A retired word goes on the
    retired list in that change. Identifiers, JSDoc, tests and logs say the vocabulary word;
    screens say the screen word; "run" never reaches a screen.
  - Status, flag and role predicates are `Domain` functions; `scripts/rules-lint.ts` refuses
    inline comparisons and reserved stems in exported identifiers under `src/lib/`.
  - While prototyping there are no migrations: edit `initializeSchema` in
    `src/lib/ShopAgentSchema.ts` in place and run `pnpm dev:reset` yourself.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`,
  `pnpm fmt`. Keep every file `pnpm fmt` touches. After phases 1 and 2, `pnpm dev:reset`.
- Record anything that does not go as written under [Deviations and issues](#deviations-and-issues)
  as you go, with the two options you saw and the one you took.
- Each phase is one change. Do not merge phases. Where a phase deletes, delete: nothing is
  kept "in case", commented out, or renamed to `legacy`.

## The decisions, in the order the phases take them

| decision               | what                                                                                         | phase |
| ---------------------- | -------------------------------------------------------------------------------------------- | ----- |
| 18, 20                 | the coverage date is cut; `Workflow.state` is `on` / `off`; no count reaches a screen        | 1     |
| 17                     | matches are derived, never stored; `matchedWorkflowIds` goes                                 | 2     |
| 10, 11                 | a per-item planner `reconcileItem` in `ShopWork.ts` carries the triggers and outcomes tables | 3     |
| 6                      | `ReconcileCounts.ambiguous` counts only when the creation gate is open                       | 3     |
| 9                      | `pnpm spec check` parses both tables; the outcomes test reads its table                      | 3     |
| 13                     | the order issue `choose_workflow` becomes `ambiguous`                                        | 4     |
| 19, 3                  | the vocabulary rows                                                                          | 4     |
| 14                     | pinned test titles say "creates"                                                             | 4     |
| 4                      | Delete team reconciles all                                                                   | 5     |
| 5                      | the open-run ceiling releasing runs a reconcile all                                          | 5     |
| 1, 2, 7, 8, 12, 15, 16 | already true, or superseded, or a form the phases follow; nothing to do                      | —     |

## Phase 1: cut the coverage date

Goal: a workflow is on or off and nothing else. Turn on applies it to every stored open order.
No screen, callable, column or test carries a date, a count of earlier orders, or a count of
what Turn on did.

### 1.1 The column

In `initializeSchema` (`src/lib/ShopAgentSchema.ts`), `Workflow.activatedAt integer` becomes
`state text not null check (state in ('on', 'off'))`. The DDL comment says the switch is the
word, stored, never derived. The data-model row on `initializeSchema` that reads "`activatedAt`
is stored, never derived, and is both the switch and the coverage date" becomes "`state` is
stored, never derived: `on` or `off`", `holds by` schema, `pinned by` the retitled test in 1.8.

### 1.2 The domain (`src/lib/domain/ShopWork.ts`)

- `WorkflowFields.activatedAt: Schema.NullOr(Schema.Number)` becomes `state: WorkflowState`,
  where `WorkflowState = Schema.Literals(["on", "off"])` is a new export beside `RunState`,
  with a one-line JSDoc: the vocabulary's workflow-state words, stored as written.
- `workflowIsOn` reads `workflow.state === "on"`. It stays the one read of the switch.
- The workflow-states table's `stored` cells become `` `on` `` and `` `off` ``. `pnpm spec
check` holds them to the check constraint of 1.1.
- The `Workflow` JSDoc: delete the paragraph that begins "`activatedAt` is the on/off switch
  and the coverage date in one column" through "at the moment of Turn on". In its place, one
  paragraph: a workflow that is on creates a run on every stored open order whose item it
  matches, on every path (webhook, import, resync, and every workflow change), with no date;
  the merchant who wants a workflow to apply from a day turns it on that day. Delete "a
  workflow **applies to orders placed since** it was turned on" from the merchant-copy list
  and the line "the word for an order's date is **placed**". Keep "Turn on / Turn off set and
  clear" but say they set `state`.
- `SetWorkflowOnInput` and `ApplyAndTurnOnInput` lose `activatedAt`. `SetWorkflowActivatedAtInput`,
  `ChangeActivatedAtResult`, `WaitingOrders`, `CountWaitingOrdersInput` are deleted.
- `SwitchResult.Ok` becomes `{ _tag: "Ok", workflow: Workflow }`; its JSDoc loses the
  sentence about the survivor's count and the toast reading for both directions. The survivor
  rule itself stays where it is stated (`reconcileAllNow` in the service).
- `ShopOrder.processedAt`'s JSDoc says it is "the only date Baton compares (against
  `Workflow.activatedAt`)"; it is in `Orders.ts`. Rewrite: the date the orders index sorts by
  and the retention sweep reads; Baton compares it with nothing else.
- Grep `src/lib/domain/` for `activatedAt`, `coverage`, `placed since`, `Include them`,
  `waiting orders`, `earlier orders` and rewrite every hit.

### 1.3 The repositories

- `WorkflowRepository.ts`: every `activatedAt` write becomes a `state` write. `setWorkflowOn`
  writes `'on'` or `'off'` and drops its `activatedAt` parameter. `applyAndTurnOn` likewise.
  `setWorkflowActivatedAt` is deleted. `listOnWorkflowDetails` and the seed's insert read and
  write `state`. The JSDoc lines "writes `activatedAt = activatedAt ?? now`" and "does not touch
  `activatedAt`: the workflow stays responsible" are rewritten in the word `state`.
- `RunRepository.ts`: delete `placedSince` and `countWaitingOrders` (and `summarise`).
  `matchesLineItem` becomes `matchesTag` alone; keep the name `matchesLineItem` for phase 3 to
  move, and make its JSDoc the tag test only. Delete the `EligibleContext`-plus-`workflow`
  input type that only `countWaitingOrders` used.
- `OrderRepository.ts` is untouched in this phase.

### 1.4 The service and the object

- `src/lib/agent/ShopWork.ts`: `setWorkflowOn` and `applyAndTurnOn` drop `activatedAt` from
  their input, their log line and their result; they return `{ workflow }` and no `created`.
  `setWorkflowActivatedAt` and `countWaitingOrders` are deleted. `reconcileAllNow` returns
  `void`: it logs `orders`, `created` and `ambiguous` from the pass and returns nothing; its
  JSDoc loses "Returns how many runs it created" and the sentence about `SwitchResult.Ok.created`.
  `reconcileAllIfOn` returns `void`. The `seedOrders` and `seedWorkflows` paths that wrote
  `activatedAt = now` write `state = 'on'`.
- `RunRepository.reconcileAll` returns `void`; `ReconcileAllCounts` is deleted; the pass logs
  its sums inside `reconcileAllNow` as today.
- `src/lib/ShopAgent.ts`: delete the `setWorkflowActivatedAt` and `countWaitingOrders`
  callables. `setWorkflowOn` and `applyAndTurnOn` decode the narrowed inputs.
- `src/lib/ShopAgentClient.ts`: delete the two stubs; narrow the two results.

### 1.5 The screens

- `src/components/WorkflowSwitch.tsx`: the Turn on dialog is one paragraph and two buttons.
  Delete `waiting` (the query), `includeWaiting`, `waitingLine`, the "Checking earlier orders…"
  line, the second paragraph, the Include them checkbox, the Change dialog
  (`CHANGE_ACTIVATED_AT_MODAL`, `toDateInput`, `seededActivatedAt`, `loadedActivatedAt` and
  the `activatedAt` prop), and `decodeChangeActivatedAtResult` and `decodeWaitingOrders`. The
  component's JSDoc loses the three paragraphs about the count, the box and Change; it keeps
  "both directions confirm" and its reason.
- `src/lib/workflowShared.ts`: `turnOnBody` becomes "Every open order with an item tagged
  “X” starts this workflow on that item." Delete `changeActivatedAtResultMessage`,
  `waitingOrdersLine` and `createdToast`; the toasts after Turn on and Turn off are
  `"Turned on."` and `TURNED_OFF + "."`, and the toasts after Apply changes and the tag edit
  say their verb alone, as they do now. The workflow page's "Starts when an order contains a
  product tagged “X”. Orders placed before this workflow was turned on are skipped." loses
  its second sentence.
- `src/routes/app.workflows.$workflowId.tsx`: delete the "Applies to orders placed since"
  line and the `activatedAt` prop; the switch renders the same with `workflowIsOn`.
- `src/routes/app.workflows.$workflowId_.edit.tsx`: same for its switch.
- `pnpm spec check`'s copy table: if a copy-table example quotes any deleted string, replace
  the example with a string a screen still shows.

### 1.6 The lint

`scripts/lib/rules-lint.ts`: add `"activated"` to `RESERVED_STEMS`, with a line in its JSDoc
table ("activated → nothing; the switch is `state`, `on` / `off`"). Add a case to
`test/integration/rules-lint.test.ts`.

### 1.7 The seed and the dev route

`src/routes/api.dev.seed.ts` and `Domain.SeedWorkflowsInput`: the "defaults to on" comment
and any `activatedAt` field become `state`. `Domain.SeedOrdersInput`'s JSDoc line "the
repository stores it as `activatedAt = now`, so seeded orders qualify" goes: every seeded
order qualifies.

### 1.8 Tests

- `test/integration/run-repository.test.ts`: delete `describe("RunRepository.countWaitingOrders")`
  and the test "skips orders placed before the workflow was turned on; manual attach still
  works". Add "a workflow that is on creates runs on every stored open order, however old it
  is", which stores an order with `processedAt` a year ago (under retention), turns the
  workflow on, and asserts the run. Every `activatedAt` in a fixture becomes `state`.
- `test/integration/shop-agent-workflows.test.ts`: "turning one of two matching workflows off
  starts the survivor and says how many" becomes "turning one of two matching workflows off
  creates the survivor's run" and asserts the run, not a count. "applyAndTurnOn promotes the
  draft and turns the switch on in one call; an empty workflow is refused" keeps its title
  and loses any `created` assertion. Delete any test of `setWorkflowActivatedAt` or
  `countWaitingOrders`.
- `test/integration/workflow-repository.test.ts`, `run-actions.test.ts`, `data-model.test.ts`
  and `domain.test.ts`: `activatedAt` fixtures become `state`.
- `e2e/workflows.spec.ts`: delete the steps that read "1 earlier order is unfulfilled and
  would match", check Include them, and read the toast's count; assert the run on the order
  page directly after Turn on.

Done when: `grep -rn "activatedAt\|coverage\|Include them\|waiting orders\|earlier order\|createdToast\|WaitingOrders" src test e2e scripts` returns nothing; `pnpm vocab:audit` no
longer lists `activated`, `placed` or `waiting` for an order; `pnpm typecheck`, `pnpm lint`,
`pnpm test` pass; `pnpm dev:reset` then `npm run test:e2e --` passes.

## Phase 2: derive matches, drop the stored column

Goal: `OrderLineItem.matchedWorkflowIds` does not exist. A match is a predicate with a
TypeScript form and a SQL form, as issues are.

### 2.1 The predicate

In `src/lib/domain/ShopWork.ts`, beside `ambiguousItems`:

- `itemMatches(item, detail: WorkflowDetail, teams)`: the tag test (`unitsToMake(item) > 0`
  and a product tag, trimmed and lowercased, equals `detail.workflow.tag`) and
  `workflowIsEligible(detail, teams)`. Move `workflowIsEligible`, `EligibleContext` and
  `matchesTag` here from `RunRepository.ts` (phase 3 moves the rest). The JSDoc on
  `itemMatches` is the rule: what a match is, and that the SQL twin in `listOrders` restates
  it and must move with it. The D1 limit is stated here: the SQL twin reads "every task's
  `teamId` set", which is what the object holds after `deleteTeam` nulls the pointers; the
  window before that null is the one stated on `deleteTeam`.
- `matchedWorkflows(item, details, teams): readonly WorkflowDetail[]` filters the on
  workflows by `itemMatches`.
- `ambiguousItems(lineItems, runs, details, teams)` counts items with two or more matched,
  units above zero and no run in any state; its JSDoc keeps the "any run counts" paragraph.
- `lineItemState(item, runs, details, teams)`: `matched` comes from `matchedWorkflows`, not
  the column; `attachable.ambiguous` from `matched.length >= 2 && unitsToMake(item) > 0`.
  `OrderPageData.itemWorkflows` becomes the on `WorkflowDetail`s with tasks (the page needs
  tasks for eligibility) plus `teams`, which the page already carries.

### 2.2 The column and its writers

- `initializeSchema`: delete the `matchedWorkflowIds` column and its comment. The data-model
  row "an order is Shopify's record, mirrored; each sync overwrites it whole except `countedAt`
  and its items' `matchedWorkflowIds`" loses its last clause.
- `Orders.ts`: delete the field from `OrderLineItem` and its JSDoc paragraph; the paragraph
  is replaced by one sentence: which workflows match an item is shop work's reading
  (`itemMatches` in ShopWork) and is never stored.
- `OrderSync.ts` `toOrderLineItem`, `OrderRepository.upsertOrder`'s insert, the seed's
  fixtures in `agent/ShopWork.ts`: drop the field. Delete the `upsertOrder` JSDoc paragraph
  "`matchedWorkflowIds` is written on insert only".
- `RunRepository.reconcileOrder`: delete the `update OrderLineItem set matchedWorkflowIds`
  loop and the paragraph explaining it; `matches` is computed with `matchedWorkflows`. Delete
  the JSDoc paragraph on `openOrders` that begins "`OrderLineItem.matchedWorkflowIds` is
  written on the way through".

### 2.3 The SQL twin

`OrderRepository.ts`: `AMBIGUOUS_ITEM` and the `ambiguousRows` query in `listOrders` replace
`json_array_length(li.matchedWorkflowIds) >= 2` with a count of on workflows that match:

```sql
(select count(*) from Workflow w
  where w.state = 'on'
    and exists (select 1 from WorkflowTask t where t.workflowId = w.id)
    and not exists (select 1 from WorkflowTask t where t.workflowId = w.id and t.teamId is null)
    and exists (select 1 from json_each(li.productTags) tag
                where lower(trim(tag.value)) = w.tag)) >= 2
```

Check the definition-task table's name and columns in `initializeSchema` before writing it.
The JSDoc on `AMBIGUOUS_ITEM` says it is the SQL twin of `itemMatches` and must move with it.
`order-repository.test.ts` gets a test "the index's ambiguity predicate agrees with
`ambiguousItems`": two workflows on, one off, one with an unassigned task, one item tagged
for all four, and the count is the same from SQL and from TypeScript.

### 2.4 Tests

Every fixture that spells `matchedWorkflowIds` (`data-model.test.ts`, `domain.test.ts`,
`member-runs-socket.test.ts`, `order-repository.test.ts`, `run-actions.test.ts`,
`run-repository.test.ts`, `shop-agent-usage-flush.test.ts`, `shop-agent-workflows.test.ts`)
drops it. Tests that asserted the column's value ("creates nothing when two workflows match,
and records both", "a live run wins: a second workflow turned on later is recorded but creates
nothing", the `shop-agent-workflows` detail assertion at its line 1504) assert
`lineItemState(...).matched` or `ambiguousItems` instead, and drop "and records both" /
"is recorded but" from their titles. `order-repository.test.ts`'s comment "`matchedWorkflowIds`
directly because reconcile is the only writer" goes with the helper it explains.

Done when: `grep -rn "matchedWorkflowIds" src test e2e scripts` returns nothing; `pnpm
typecheck`, `pnpm lint`, `pnpm test` pass; `pnpm dev:reset`; the orders index's Issues view
shows Needs a workflow for an item two on workflows match, and stops showing it the moment
one of them is turned off, with no reconcile in between (check in the browser).

## Phase 3: the planner and its two tables

Goal: the reconcile rule lives on one `Domain` symbol, `reconcileItem` in
`src/lib/domain/ShopWork.ts`, with the triggers table and the outcomes table in its JSDoc;
`RunRepository.reconcileOrder` reads, calls it per item, executes; a test reads the outcomes
table out of the source.

### 3.1 The planner

```ts
export const ReconcileOutcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("create"), workflowId: WorkflowId }),
  Schema.Struct({ _tag: Schema.Literal("close"), reason: ClosedReason }),
  Schema.Struct({ _tag: Schema.Literal("resize"), units: Schema.Number, badge: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("nothing") }),
]);

export const reconcileItem = (input: {
  readonly order: OrderState & { readonly fullyPaid: boolean };
  readonly item: Pick<OrderLineItem, "currentQuantity">;
  readonly run: RunDetail | null;
  readonly matched: readonly WorkflowId[];
  readonly atCeiling: boolean;
}): ReconcileOutcome
```

Pure. The order of tests is the flowchart in the research: cancelled → close
`order_cancelled` on an open run; fulfilled → close `fulfilled` on an open run; a run in any
state → resize or close or nothing by units (open run only); no run → create when paid, one
match, not at the ceiling; otherwise nothing. The badge flag is `!runIsUnstarted(tasks)` and
the `quantityChangedFrom` arithmetic stays in the repository (it needs the stored original).
`workflowIsEligible`, `itemMatches`, `matchedWorkflows` (phase 2) sit beside it.

### 3.2 The two tables, on `reconcileItem`

The JSDoc carries, in this order: one paragraph saying what reconcile is (from "The short
version" in the research: idempotent, reads the stored order, never the caller's copy, and the
topic is ignored); the two-gate paragraph; the snapshot assumption (the eligible context is
read once per webhook, import or reconcile all, before the transaction); then the two tables
exactly as drafted in the research under "What the spec could look like", with these edits:

- triggers: drop the row "the coverage date's Change"; the Turn on row's `skipped when` is
  "never" and its `pinned by` is the phase-1 title "a workflow that is on creates runs on
  every stored open order, however old it is"; the Delete team row's `skipped when` is
  "never" (phase 5); the ceiling row's is "still at the ceiling" (phase 5).
- outcomes: the `matches` column counts eligible workflows whose tag matches; no date.

### 3.3 The parsers and the check

`scripts/lib/spec.ts`:

- `parseReconcileTriggers(source)`: `firstTable(source, "reconcileItem", ["trigger", "shape",
"skipped when", "pinned by"])`; `shape` in `["reconcile", "reconcile all", "none"]`; `pinned
by` a title or `(none yet)`. Model it on `parseTriggerTable`.
- `parseReconcileOutcomes(source)`: the table after the triggers table in the same JSDoc
  (extend `firstTable` with an `after` index, or add `nthTable`); columns `order`, `paid`,
  `units`, `run on item`, `matches`, `outcome`; word lists: `order` in `cancelled | fulfilled
| closed | open`, `paid` in `yes | no | any`, `units` in `0 | changed | same | some | any`,
  `run on item` in `open | open, unstarted | open, started | done or closed | none`, `matches`
  in `0 | 1 | 2+ | 1, at the ceiling | any`; `outcome` is `create`, `close <reason>`,
  `resize`, `nothing`, with free text after a colon.
- `scripts/spec.ts`: run both parsers on `contexts.ShopWork`, and `checkPinned` on the
  triggers rows against the test sources, as the billing table is checked. `pnpm spec print`
  prints both.
- `test/integration/spec.test.ts`: a case per parser, as the triggers-table parser has.

### 3.4 The test that reads the table

`test/integration/run-actions.test.ts` gains `describe("Domain.reconcileItem outcomes")`: read
the rows with `parseReconcileOutcomes(source)`, build each row's input from its cells, call
`reconcileItem`, assert the `_tag` (and reason) the outcome cell names, titled with the row
rendered back. The `run-repository.test.ts` tests stay as the SQL half; retitle the ones whose
title is a `pinned by` cell so the titles match exactly.

### 3.5 The repository

`RunRepository.reconcileOrder`: read the order, items, runs with tasks (as today); compute
`matched` per item with `matchedWorkflows`; compute `atCeiling` once (capacity as today);
call `reconcileItem` per item; execute: `create` → `insertRun`, `close` → `closeOpenRuns`,
`resize` → the quantity update with the `quantityChangedFrom` arithmetic. The five inner JSDoc
comments in the body go; the function's JSDoc says "reads, calls {@link Domain.reconcileItem},
executes; the rule is there". `ReconcileCounts.ambiguous` counts an item as ambiguous only when
`orderCanCreateRuns(order)` (decision 6), and the log line on `reconciler` keeps its four
numbers. `openOrders` keeps `fullyPaid = 1`.

Done when: `pnpm spec print` renders both tables with their fixture counts; `pnpm lint` fails
if a cell is edited to a word outside its list (try it, then revert); every triggers row's
`pinned by` is a test title or `(none yet)`; `pnpm test` passes.

## Phase 4: the words

### 4.1 The vocabulary rows (decision 19)

In the shop-work nouns table in `src/lib/domain/ShopWork.ts`:

| word          | meaning                                                                                                    | symbol                                          | screen                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| reconcile     | make an order's runs agree with the order and the eligible workflows; idempotent                           | `reconcileItem`, `RunRepository.reconcileOrder` | (none)                                   |
| reconcile all | reconcile every stored open, paid order once, after a workflow changes                                     | `ShopWorkAgent.reconcileAllNow`                 | (none)                                   |
| eligible      | a workflow that is on, has a task, and has every task on a team; only an eligible workflow creates runs    | `workflowIsEligible`, `EligibleContext`         | (none): Needs a team names the fault     |
| match         | an item and an eligible workflow: a product tag equals the workflow's tag and units to make are above zero | `itemMatches`                                   | the order page's picker lists them first |
| ambiguous     | an item two or more eligible workflows match, with no run                                                  | `ambiguousItems`, `OrderIssue` `ambiguous`      | Needs a workflow                         |
| units to make | what is left to make on an item: Shopify's current quantity                                                | `unitsToMake`                                   | the quantity on the card                 |

In the Orders nouns table: `current quantity | Shopify's count of units still on the item after
edits and refunds | OrderLineItem.currentQuantity | the quantity on the card`. Move `unitsToMake`
from `Orders.ts` to `ShopWork.ts` (the map's crossing list names it; update that sentence to
name `OrderLineItem.currentQuantity` instead). Importers read the barrel and do not change.

`checkVocabulary` requires every backticked symbol to exist: add the rows after 3.1 lands.

### 4.2 The issue literal (decision 13)

`OrderIssue`'s `choose_workflow` becomes `ambiguous`: `OrderIssue`, `ORDER_ISSUE_LABEL`
(screen word unchanged, Needs a workflow), `orderIssues`, the order-issues table's row (word
"ambiguous", meaning "an item two or more eligible workflows match, with no run, on an order
that can create runs"), `CHOOSING` in `OrderRepository.ts` (rename to `AMBIGUOUS`), the
`OrdersIndexView` literal if it carries the issue, the URL key if any, `domain.test.ts`'s
"choose_workflow: an ambiguous item on an order that can create runs", and `pnpm spec check`'s
order-issues check. Grep `choose` across `src test e2e scripts`.

### 4.3 Test titles (decision 14)

Retitle "a manual run start counts the order if nothing has yet" to "a manual attach counts
the order if nothing has yet". Check every `pinned by` cell in the new triggers table and the
billing table still matches a title.

Done when: `pnpm vocab:audit` no longer lists `reconcile`, `eligible`, `ambiguous`; `pnpm spec
check` passes; `grep -rn "choose_workflow\|chooseWorkflow" src test e2e scripts` returns
nothing.

## Phase 5: the two missing passes

### 5.1 Delete team reconciles all (decision 4)

`ShopWorkAgent.deleteTeam`: after `unassignTeam`, `yield* reconcileAllNow("deleteTeam",
teamId)`. Its JSDoc says why: a workflow whose task lost its team stops being eligible, and an
item it had made ambiguous now has one match, whose run is created here rather than at the
order's next webhook. Test in `shop-agent-workflows.test.ts`: "deleting a team creates the
survivor's run on an item two workflows had matched", and the triggers row's `pinned by`
becomes that title.

### 5.2 The open-run ceiling releasing (decision 5)

`RunRepository.releaseOpenRunLimit` returns `true` when it cleared `openRunsLimitedAt`.
The two writes that lower the open-run count outside reconcile, `markTaskDone` (through
`recomputeState`) and `cancelRun` (through `closeOpenRuns`), return `{ ..., ceilingReleased }`;
`ShopWorkAgent`'s callables for them run `reconcileAllNow("ceilingReleased", runId)` when it
is true, outside the repository's transaction. For reconcile's own closes, `ReconcileCounts`
gains `ceilingReleased`; `OrderUpsert.afterWrite` becomes `Effect.Effect<A, E>` and
`upsertOrder` returns its value; `OrdersAgent.fetchAndUpsertOrder` returns it; `ShopAgent.syncOrder`,
`resyncOrder` and the stream's per-order step run `reconcileAllNow` when it is true. The
JSDoc on `reconcileOrder`'s ceiling paragraph changes "the next `reconcileAll` starts it once
there is room, because that pass walks every open order" to "the write that brings the shop
back under the ceiling runs a reconcile all, so the declined orders are created then". Test in
`run-repository.test.ts` under the ceiling group: "the write that releases the ceiling creates
the runs that were declined", and the triggers row's `pinned by` becomes that title. Retitle
"reconcile yields to the ceiling and records it; finishing the run clears the flag" to "...;
the run's last Done clears the flag" ("finishing" is a retired word).

If the `afterWrite` generic turns out to reach more signatures than the three named, stop,
record it under Deviations, and take the smaller version: the member's Done and the
merchant's Cancel workflow run the pass, and a reconcile close that releases the ceiling
defers to the next of those. Say so in the JSDoc and the triggers row.

Done when: both new tests pass; `pnpm spec check` finds both titles.

## Phase 6: the whole

1. `pnpm fmt`; keep every file it touches.
2. `pnpm typecheck && pnpm lint && pnpm test`.
3. `pnpm dev:reset` then `npm run test:e2e --`.
4. `pnpm vocab:audit`: record the words it lists that this plan introduced, under Deviations,
   each with row / JSDoc term / allowlist / retire.
5. `git diff --stat`; check no file outside `src/`, `scripts/`, `test/`, `e2e/`, `docs/` and
   `AGENTS.md` changed. Do not commit.
6. `AGENTS.md`: the bullet that names the action matrices (`runActions`, `taskActions`) gains
   `reconcileItem` and its two tables, in one clause, in the same sentence shape.

## Deviations and issues

Record here, as you go. One entry per deviation: the phase and step, what the plan said,
what you found, the two options, the one taken, and why.

| phase.step | plan said                                                                                                | found                                                                                                                                                                                                      | options                                                                              | taken                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2        | `WorkflowState` beside `RunState`                                                                        | `WorkflowFields` uses it, and sits well before `RunState`; a `Schema` const is read at module load                                                                                                         | beside `RunState` (fails at load); before `WorkflowFields`                           | before `WorkflowFields`, after `WorkflowTag`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1.3        | `matchesLineItem` becomes `matchesTag` alone, keeping the name                                           | `matchesTag` was a second export with the same body                                                                                                                                                        | keep both; fold into one                                                             | one function, `matchesLineItem(detail, lineItem)`; phase 2 moved it to the domain as `matchesTag`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1.4        | `reconcileAll` returns `void`, and `reconcileAllNow` logs `orders`, `created`, `ambiguous` from the pass | the two contradict: with `void` the caller has no sums to log                                                                                                                                              | return the sums (a `ReconcileAllCounts` by another name); log them in the repository | `reconcileAll` returns `ReconcileAllSums` (orders, created, ambiguous, and `ceilingReleased` for 5.2) and `reconcileAllNow` logs them with `shop=` in the message, as the logging rule asks; nothing reaches a screen, which is what decision 20 is about. The review replaced the first version, which logged in the repository without `shop`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1.4        | delete the two stubs in `ShopAgentClient.ts`                                                             | the client had none; the callables were socket-only                                                                                                                                                        | —                                                                                    | nothing to delete there; removed the two rows from the role table in `shop-agent-callables.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1.5        | Turn off toast `TURNED_OFF + "."`                                                                        | the old zero-count toast was "Turned off. Items already on it keep going."                                                                                                                                 | keep the reassurance; plan's form                                                    | plan's form, "Turned off."; the dialog body still says items keep going                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1.8        | the listed test changes                                                                                  | four more tests leaned on the date: the usage-flush attach test (Turn on now creates the run itself), the stream test (the old order now gets a run), the reseed test, and the ambiguity test's date nudge | delete them; rework them                                                             | reworked: the attach test's order carries no workflow's tag; the stream test is retitled "creates runs on every streamed open order that matches, however old; a re-stream creates none"; the reseed test asserts the run; the nudge is a second Turn on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2.3        | the agreement test: one item tagged for all four workflows                                               | one item with two eligible matches is ambiguous whether or not the SQL excludes the off and unassigned workflows, so it would not catch the exclusion                                                      | one item; two items                                                                  | two items: the one the plan names, and one tagged for one eligible and the two ineligible workflows, which is ambiguous only if the SQL counts the ineligible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2.4        | tests drop the column                                                                                    | `seedStates` in `order-repository.test.ts` wrote the column directly                                                                                                                                       | —                                                                                    | it now inserts two on workflows, `w1` and `w2`, and tags the items; "a reseed re-matches the orders it did not replace" is "a reseed reconciles the orders it did not replace"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3.1        | `ReconcileOutcome` `nothing` with no fields                                                              | the repository must know when the ceiling declined a run, to raise the banner and log                                                                                                                      | call the planner twice; a field on `nothing`                                         | `nothing` carries `declined: boolean`; the test asserts it is true only on the "1, at the ceiling" row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3.1        | the planner's `run` is `RunDetail \| null`                                                               | a full `RunDetail` makes the table test build every column of a run                                                                                                                                        | `RunDetail`; the fields the rule reads                                               | `{ run: Pick<Run, "state" \| "quantity">, tasks: Pick<RunTask, "startedAt" \| "doneAt">[] } \| null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3.2        | the outcomes table as drafted                                                                            | "resize, no badge" does not fit the outcome grammar (free text after a colon); "match recorded" is false after phase 2                                                                                     | change the grammar; change the cells                                                 | cells: "resize: no badge", "resize: badge from the original", "nothing: created when it pays", and the ceiling row says "declined at the ceiling, banner raised"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3.3        | `pnpm spec print` prints both tables with fixture counts                                                 | the fixture expansion lived nowhere the script could read                                                                                                                                                  | expand in the test only; expand in `scripts/lib/spec.ts`                             | `expandReconcileOutcome` in `scripts/lib/spec.ts`, read by the test and by `print`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3.5        | execute per item                                                                                         | a run whose item is no longer stored has no item to visit                                                                                                                                                  | drop it; plan it as an item at zero units                                            | planned at zero units, so it closes as `item_removed`, as the old `adjust` did                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4.1        | move `unitsToMake` to `ShopWork.ts`                                                                      | the Orders vocabulary's `` `lineItem` `` then occurred nowhere else in `Orders.ts`, and `spec check` refused it                                                                                            | qualify it; unbacktick it                                                            | unbackticked, since the sentence is about the naming, not a symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4.2        | rename the literal                                                                                       | the re-padded issue table broke three `spec.test.ts` cases that match rows by exact padding                                                                                                                | —                                                                                    | updated the three row strings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5.2        | thread `afterWrite`'s value through `upsertOrder`, `fetchAndUpsertOrder` and the sync callables          | it also reaches `runShopAgentOrdersStream`'s `afterWrite` type and its counts, and the seed's two upserts                                                                                                  | the full threading; the smaller version the plan names                               | the full threading, after review: the first version took the smaller one and left the banner up after a close by reconcile, while Start, Reopen and Put back cleared it through `recomputeState` with no pass behind it. Now `OrderUpsert.afterWrite` is `Effect<A, E>` and `upsertOrder` returns its value as `afterWrite: Option<A>`; `fetchAndUpsertOrder` returns `{ written, ceilingReleased }`; the stream folds `ceilingReleased` into its counts and `onOrdersStream` runs one pass after the stream; the webhook and resync run it per order. The release is called only after a write that lowers the count: the run's last Done, Cancel workflow, and `reconcileOrder` after its closes; `recomputeState` no longer releases. The seed ignores the value and runs its own pass |
| 5.2        | the test in `run-repository.test.ts`                                                                     | the repository cannot run the service's pass                                                                                                                                                               | a shop-agent test at 5000 open runs; the repository half                             | both halves, with the ceiling lowered in the test: the repository tests ("the write that releases the ceiling creates the runs that were declined", "Cancel workflow releases the ceiling", "a close by reconcile releases the ceiling and says so") and two in `shop-agent-workflows.test.ts` ("a Done that releases the ceiling creates the declined runs", "a reconcile all whose own closes release the ceiling runs once more")                                                                                                                                                                                                                                                                                                                                                      |
| 6.4        | record the words `vocab:audit` lists that this plan introduced                                           | `outcome` (`ReconcileOutcome`), `matche` (`matchesTag`), `matched` (`matchedWorkflows`)                                                                                                                    | row, JSDoc term, allowlist, retire                                                   | proposed: `outcome` a JSDoc term on `ReconcileOutcome`; `matches`/`matched` are the `match` row's inflections, an allowlist entry; not changed here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Issues found that this plan does not cover go here too, with a one-line proposal each, and
are not fixed in this change.

- A reconcile all whose own closes bring the shop under the ceiling does not revisit the orders it
  already walked. Taken in review: `reconcileAllNow` runs the pass once more when it reports
  `ceilingReleased`; the second pass starts with the flag clear, so it cannot release again.
- Review follow-ups taken: the outcomes row for a done or closed run on an open order covers every
  `units` value; `ITEM_MATCHES` states the ASCII-only `lower` and `trim` against the TypeScript side
  and where the units clause lives; the usage-flush seed no longer dates an order in the future; the
  order-repository title "a manual run start past the cycle end" says "attach".
- Phase 2's browser check (the Issues view shows Needs a workflow, and stops the moment one workflow
  is turned off) was covered by e2e (`e2e/orders.spec.ts`, the two-workflow test) and the SQL/TypeScript
  agreement test, not by hand; Turn off runs a reconcile all, which creates the survivor's run, so
  "with no reconcile in between" cannot be observed from the screen.

# Action matrices review: implementation plan

This plan carries out the ten decisions and thirteen recommendations in
`docs/action-matrices-review-research.md` (under "Decisions" and "Recommendations, gathered").
Read that doc first: section 1 is the contract the matrices gain, section 2 is the "v" letter,
sections 3 to 7 say what each table is missing, and the decisions say which way each question
went. This plan says what to change, in what order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that is the concept or enforces it. Other
    sites `{@link}` it. A JSDoc never cites a file under `docs/`; it carries its reasoning
    inline.
  - The action matrices on `runActions` and `taskActions` in `src/lib/domain/ShopWork.ts` are
    the spec: `test/integration/run-actions.test.ts` reads them out of the source, one test per
    row, and `pnpm spec check` holds each table total and disjoint. A behaviour change starts
    at the cell.
  - Each rule stated in prose has a test whose title is the rule.
  - Status, flag and role predicates are `Domain` functions, never inline comparisons.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`),
  `pnpm test`, `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go: what the plan said, what you
  found, the two options you saw, and the one you took.
- Phases 1, 2 and 4 change no behaviour. Phase 3 does, in one place. Do not merge phase 3
  into another, so the behaviour change is never hidden inside a wording change.

## The decisions, in the order the phases take them

| decision or rec.      | what                                                                                                              | phase |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| 1, rec. 1, 2          | the contract is an upper bound; the three screens that offer less; the three other refusals; `reopen`'s values    | 1     |
| rec. 4, 5             | the outsider named; the row fixture described                                                                     | 1     |
| rec. 7, 8             | the task set never reads the item; the `downstream` words defined                                                 | 1     |
| 4, rec. 9, 10         | the verb rows leave `RunState`'s table and the block table; both link the matrices                                | 1     |
| 3, rec. 11            | Undo is the team's; the verbs table reworded                                                                      | 1     |
| 5, 7, 9, rec. 12, 13  | sentences: Block stays current-team; the unassigned task; Change workflow is attach-gated; a Done without a Start | 1     |
| 8                     | Reopen is allowed at the open-run ceiling, stated twice                                                           | 1     |
| 10                    | an archived order is open, stated on `orderIsOpen`                                                                | 1     |
| section 7             | the five smaller findings, one clause each                                                                        | 1     |
| 2, rec. 3             | the "v" letter: parser, table, test                                                                               | 2     |
| 6                     | the Change workflow warning covers a blocked run; the controls table gains the row                                | 3     |
| rec. 6, and 1's tests | the tests the new sentences owe                                                                                   | 4     |

## Phase 1: the spec text

Goal: the JSDocs say everything the research found missing, in the places the decisions name.
No code path changes; every existing test passes unchanged. Each new sentence that is a rule is
written with the title its phase 4 test will carry, so a reader can grep from the sentence to
the test.

### 1.1 The contract, on `runActions`

In `src/lib/domain/ShopWork.ts`, replace the first paragraph of the JSDoc on `runActions`
("What an actor may do to one run, as the page and the server both read it...") with a
paragraph that says, in this order:

- The set is an upper bound. No screen offers a verb whose field is false; every `ShopAgent`
  callable for a run or task write computes the same object from the same inputs, read fresh
  inside the write, and refuses with `NotAllowed` when the field is false, so a stale tab or a
  second admin cannot write what no page would offer.
- A screen may offer fewer verbs than the set allows, and says why in its own JSDoc. Name the
  three: the member's workflows list offers Start and not Done on a ready task
  (`shop.$shop.workflows.index.tsx`, the row menu); the same list's Blocked view offers Unblock
  alone; the member's workflow page draws no Undo when `reopen` carries a blocker.
- A filled cell means the set allows the write; the repository may still refuse for a reason
  the set does not read. Name the three: a downstream start on Reopen (`ReopenBlocked`, the
  `blocker` cell); the attach results on Change workflow (`OrderClosed`, `NothingToMake`,
  `ItemDone`, see 1.7); a race between the render and the click (`NotBlocked`, `NotReady`,
  `Terminal`), whose toasts the order page carries.
- Keep the existing sentences about the repository's own guards and the test reading the table.

Add after the "M"/"m" paragraph a sentence on the row's fixture (rec. 5): a row is checked
against one task, on "m"'s team, current when the run is open, with the item at `units`;
`scripts/lib/spec.ts` (`expand`) builds it.

Add the outsider (rec. 4), one sentence, in both preambles: a member whose teams hold no task
of the run gets nothing, the note included, and cannot open the run page (`getRunPage` answers
`None`). Title for phase 4: **a member whose teams hold no task of the run gets nothing, the
note included**. The existing test "a task on none of the member's teams offers the member
nothing" in `run-actions.test.ts` is the task half; phase 4 retitles and extends it.

### 1.2 `reopen`'s three values, on `taskActions`

In the `taskActions` preamble, beside the sentence on `blocker` (rec. 2): `reopen` is `null`
when not offered, `{ blockedBy: null }` when it is the button, `{ blockedBy }` when it is the
sentence; a `blocker` cell is the third value for "M" and "m" alike, and which of them draws it
is the screen's (the member page draws nothing, the merchant page the sentence).

### 1.3 The `downstream` words and the item, on `taskActions`

Add to the `taskActions` preamble (rec. 7, 8), after the sentence on `-`:

- `none` is no later task started or done; `started` is a later task started or done, since
  Done records a start (`markTaskDone` backfills `startedAt`); `-` is a state Reopen is never
  asked in. On a done run every task but the last has a started downstream, so the only
  reopenable task on a done run is its last one, which is the point of offering Reopen there.
- The task set reads the run and the order, never the item. An item at zero units under an
  open run is reconcile's to close (`item_removed`, the actions table on `reconcileItem`), and
  a Done that lands before that pass stands: the run goes `done` and reconcile leaves a done
  run alone. Title for phase 4: **a Done on an open run whose item is at zero units stands,
  and reconcile then leaves the done run alone**.

### 1.4 The unassigned task, Block's team, and a Done without a Start, on `taskActions`

In the bullets under the `taskActions` table:

- After the `start` bullet (rec. 13): a Done without a Start records the actor as the starter
  too, so a merchant's Done names the merchant twice and no worker once. Title for phase 4:
  **a Done without a Start records the actor as the starter too**. Check first whether
  `test/integration/run-repository.test.ts` already pins the backfill; if a test asserts it
  under another title, retitle that test rather than adding one, and note it under deviations.
- A new bullet (decision 7, rec. 6): a task on no team, or on a team that no longer exists
  (`runTaskIsUnassigned`), is a task of nobody's: every "m" cell is blank for it and every "M"
  cell holds, so the merchant can finish or move work no member can reach. Title for phase 4:
  **a task on no team is nobody's: every member cell is blank and every merchant cell holds**.
- In the `runActions` bullets, in the `block` bullet (decision 5, and section 7's first
  finding): Block, Edit reason and Unblock are the current team's as a whole, so a teammate may
  lift a hold they did not set, and a member whose team is later in the workflow writes a note
  instead; the team doing the work is the team that stops it, and widening Block would widen
  who the merchant has to ask.

### 1.5 Reopen at the open-run ceiling (decision 8)

Two places, same sentence:

- In the `reopen` bullet under `taskActions`: Reopen is allowed at the open-run ceiling and
  may take the shop one over it; the ceiling bounds what reconcile creates
  (`ShopLimits.maxOpenRuns`), and a correction refused because the shop is busy would leave
  the merchant nothing to do but cancel something. Title for phase 4: **Reopen is allowed at
  the open-run ceiling and takes the shop one over it**.
- On `RunState`'s table, the row `counts against the shop ceiling`: change the gate cell to
  "{@link runIsOpen}; Reopen does not read the ceiling and may go one over it
  ({@link taskActions})". Rename "shop ceiling" to "open-run ceiling" in that row; the
  reconcile review already qualified every other ceiling.

### 1.6 The verb rows leave the two rule tables (decision 4, rec. 9, 10)

On `RunState`'s "What each state allows" table: delete the eight rows Start, Done, note,
Block/Unblock/edit reason, Put back, assign a task's team, Cancel, Reopen a done task. Keep the
five rows reconcile resizes, reconcile closes, holds its item, replaced by a manual attach,
counts against the open-run ceiling. Replace the sentence above it ("What each state allows.
The gate column is the rule; the enforcing write refuses with `RunTerminalError` when it
fails. Which buttons a page shows is...") with: "What each state means to reconcile and the
data model. Who may do each verb in each state, and which page offers it, is {@link runActions}
and {@link taskActions}; `RunTerminalError` is the repository's refusal under them." Keep the
sentence that `pnpm spec check` does not read this table.

On `runIsBlocked`'s "What a block changes" table: replace the first two rows with one:

| rule                                                                    | enforcer                                |
| ----------------------------------------------------------------------- | --------------------------------------- |
| which verbs a block refuses and which it leaves: the `blocked yes` rows | {@link taskActions}, {@link runActions} |

Keep the three rows that are not actions. Move the two reasoning sentences (Reopen "takes work
back rather than doing more"; Put back "clearing who has it under a hold loses the one name
the merchant needs", from `putBackTask`'s JSDoc) into the `reopen` and `putBack` bullets under
`taskActions`, and make `putBackTask`'s JSDoc link the bullet rather than restate it. Say in
the block table's new row that Assign is left under a block on purpose: moving a held task to
the team that can unstick it is a fix.

### 1.7 Change workflow is attach-gated (decision 9, rec. 12)

In the `changeWorkflow` bullet under `runActions`: the field is read by `merchantAttachWorkflow`
alone, over an open run, and never through the run gate (`requireRunAction` passes no item);
its refusals are the attach results, `OrderClosed` and `NothingToMake` before the field is
read and `ItemDone` when it is false; a member's result is always false because member callers
hold no item. Give the `item` parameter a one-line JSDoc saying the same. In the `units` column
sentence of the preamble, say the column exists for `changeWorkflow` alone; Cancel on an item at
zero units is offered and reconcile would close that run as `item_removed` anyway.

### 1.8 Undo (decision 3, rec. 11)

In the verbs paragraph of the vocabulary (`Verbs, shop work`, the sentence "Undo and Reopen are
two words for one verb on purpose: the member takes back their own Done, the merchant reopens
someone's record"), write: "Undo and Reopen are two words for one verb on purpose: on the bench
it takes back a Done, usually one's own, and the whole team may press it, as it may Put back; the
merchant reopens someone's record." In the `reopen` bullet under `taskActions`, add that "m" is
the task's team, not who pressed Done, for the reason on `putBack`: the inverse of a verb is as
open as the verb, and a Done pressed by a teammate who has gone home is the case Undo is for.
Title for phase 4: **Undo is offered to the task's whole team, not only to who pressed Done**.

### 1.9 An archived order (decision 10)

On `orderIsOpen` in `src/lib/domain/Orders.ts`, after the first paragraph: Shopify's archive
(`closedAt` on the order) is not read. An archived, unfulfilled order is open here, its runs
workable and its items attachable: archiving is filing, and the work on an unfulfilled order is
still work. `ShopOrder` carries no `closedAt` so that nobody reads it by reflex. No test: there
is no field to test against; the sentence is the rule.

### 1.10 The smaller findings (section 7)

- On `runActions`, where the preamble says `pnpm spec check` refuses a table that leaves a
  state without a row, add "or two rows that share one" (`gaps` and `overlaps` in
  `scripts/lib/spec.ts`). Same clause on `taskActions`.
- On `taskActions`, in the `assign` bullet: Assign answers `Assigned`, not `Ok`, because it
  carries `TeamNotFound`, which no other run write has; the test allows for it.
- On the member's workflows list (`shop.$shop.workflows.index.tsx`, the JSDoc above
  `menuItems`): the list sets `current: true` on every task of a row because the query returns
  current tasks only (`RunRepository.listRuns`), and `reopenBlockedBy: null` because the row
  holds no done task; a list that one day carried a waiting task would need `RunListTask` to
  carry `current`. One sentence; no code.

### 1.11 Done when

- `pnpm lint`, `pnpm spec check`, `pnpm typecheck` and `pnpm test` pass with no test changed.
- `grep -n "takes back their own Done" src/` finds nothing.
- `RunState`'s table has five rows; the block table has four.
- Every title named "Title for phase 4" above appears verbatim in this plan's phase 4 list.

## Phase 2: the "v" letter (decision 2, rec. 3)

Goal: `runActions`' note cell says `M m v`, the parser accepts it, the test checks it, and the
side test "a member whose team holds no current task gets only the note, and only if the run is
theirs to see" is gone.

### 2.1 The parser, `scripts/lib/spec.ts`

- `Cell` becomes: blank, `blocker`, or a space-separated list of letters from `M`, `m`, `v` in
  that order with no repeats (`M`, `m`, `v`, `M m`, `M v`, `m v`, `M m v`). Replace the
  `Schema.Literals` with a `Schema.String` refined by a predicate, and keep `Cell`'s type a
  string. Update the error text in `decodeRow` to say "letters M m v in order, blank, or
  blocker".
- `v` is a `runActions` letter only: `decodeRow` refuses it under a `taskActions` column the
  way it refuses `blocker` under a non-`reopen` column ("cell "v" under start; it is only a
  runActions letter").
- `Fixture` for `runActions` gains `tasks`, the full list `runActions` is called with, beside
  the existing `task`: for "M" and "m" it is `[task]`; `expand` does not build the "v" list
  (an actor is not a state), the test does (2.3). Document the three fixtures on `expand`'s
  table: a new row `cell letter | v | tasks: the row's task not current on "v"'s team, plus a
current task on another team when the run is open`.
- `universe`, `gaps` and `overlaps` do not change: letters are not state words.

### 2.2 The table

In the `runActions` table, every `note` cell becomes `M m v`. No other cell changes. In the
preamble's "M"/"m" paragraph, define "v": a member whose teams hold a task of the run
({@link runIsVisibleTo}) but no current one; blank is never. Delete the clause "for the note it
is a member who can see the run", which the letter now says.

### 2.3 The tests

In `test/integration/run-actions.test.ts`:

- `offered(cell, who)` takes `who: "M" | "m" | "v"`; `expectedOf` likewise.
- The `runActions` matrix loop gains a third call per fixture: `Domain.runActions(MEMBER,
order, state, visibleTasks, item)` against `expectedOf(row, "v")`, where `visibleTasks` is
  `[{ teamId: T, current: false }, { teamId: OTHER, current: run open }]` and `OTHER` is a
  second `TeamId`. On a done or closed run the second task is not current either, which is
  correct: "v" and "m" coincide there and the cells agree.
- Delete the side test "a member whose team holds no current task gets only the note, and only
  if the run is theirs to see". Its outsider half moves to phase 4's outsider test.
- The callables half stays "M" and "m". Say why in its JSDoc: the pure half proves the formula
  equals the table for "v", and the callables half proves each callable reads the formula with
  the live inputs, which the "m" fixtures already exercise; a "v" fixture would need a second
  team on the live run for no new proof.
- In `test/integration/spec.test.ts`, retitle "a cell outside M, m, M m, blank and blocker
  fails" to "a cell that is not letters M m v in order, blank or blocker fails" and add the
  cases `m M`, `M M`, `v` under a `taskActions` column.

### 2.4 Done when

- `pnpm spec check` passes; `pnpm spec print` shows the `note` column as `M m v` on every
  row.
- `pnpm test` passes; `run-actions.test.ts` has no test whose title contains "only the note".

## Phase 3: the Change workflow confirm (decision 6)

Goal: the controls table in `src/lib/Screen.ts` has a row for a verb that destroys a record,
and the Change workflow modal's warning covers a blocked run.

Today: the modal (`CHANGE_WORKFLOW_MODAL` on `app.orders.$orderId.tsx`) always opens, since
the select lives in it; `changingWarning` shows the consequence only when a task has a Start or
Done record, and `changeWarning` in `src/lib/changeWarning.ts` names the steps and the note.
A blocked run with nothing started shows no warning, although the change deletes the block and
its reason.

### 3.1 The controls row

Add to the controls table on `Control`:

| job                                                                                | control                                                                                                         | never                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| a verb that replaces a run with a record on it (started, done, blocked, or a note) | the verb's modal carries the consequence as its `confirm` slot: what is lost; nothing when the run is untouched | a second modal; a warning on an untouched run |

`pnpm spec check` parses the row (three non-empty cells). Link it from the JSDoc above
`changingWarning` and from the `changeWarning` JSDoc.

### 3.2 The warning on a blocked run

In `changingWarning` on the order page, `touched` becomes: any task started or done, or the run
blocked (`Domain.runIsBlocked`), or the run has a note. The predicate is one `Domain` function,
`runHasRecord(run, tasks)` beside `runIsUnstarted` in `ShopWork.ts`, with a JSDoc that names the
four records and links the controls row; the page calls it and never compares columns itself.

In `changeWarning`, when the run is blocked, the sentence gains the block: "That work, the
block and the note will not carry over" (choose the list by which records exist; `lost` is
already built this way for the note). When nothing is started or done and the run is only
blocked or only has a note, the progress clause is dropped: "<from> is blocked. Change to <to>
anyway? The block will not carry over." Write the three shapes as examples in the JSDoc.

### 3.3 The tests

In `test/integration/change-warning.test.ts`, add:

- **the change warning names the block when the run is blocked**
- **a run with nothing started, no block and no note gets no warning**
- **a blocked run with nothing started gets the block warning without a progress clause**

In `test/integration/domain.test.ts`, one test titled with `runHasRecord`'s rule: **a run has a
record when a task is started or done, the run is blocked, or it has a note**.

### 3.4 Done when

- `pnpm spec check` parses the new controls row.
- The three warning tests and the predicate test pass; no other test changed.
- `grep -n "startedAt !== null || task.doneAt !== null" src/routes/` finds nothing.

## Phase 4: the tests the new sentences owe

Goal: every rule phase 1 wrote as a sentence has a test whose title is the sentence. Titles,
and where each goes:

| title                                                                                                  | file                                                                                                   | shape                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a member whose teams hold no task of the run gets nothing, the note included                           | `run-actions.test.ts`                                                                                  | retitle and extend "a task on none of the member's teams offers the member nothing": assert `runActions` for `OUTSIDER` is all false and `taskActions` all blank, on an open run, and `getRunPage` answers `None`                                              |
| a task on no team is nobody's: every member cell is blank and every merchant cell holds                | `run-actions.test.ts`                                                                                  | pure: `taskActions` with `teamId: null` for `MEMBER` is all false; for `MERCHANT` equals the `open \| open \| no \| ready` row's "M" cells. Callable: `markTaskDone` by the member on a task reset to `teamId null` answers `NotAllowed`, by the merchant `Ok` |
| a Done on an open run whose item is at zero units stands, and reconcile then leaves the done run alone | `run-repository.test.ts` or `shop-agent-sync-order.test.ts`, whichever already seeds an item and a run | set `currentQuantity` to 0, `markTaskDone` the last task, then `reconcileOrder`; the run is `done`, not `closed`                                                                                                                                               |
| a Done without a Start records the actor as the starter too                                            | `run-repository.test.ts`                                                                               | see 1.4: retitle if it exists                                                                                                                                                                                                                                  |
| Reopen is allowed at the open-run ceiling and takes the shop one over it                               | `shop-agent-orders-ceiling.test.ts`                                                                    | fill the shop to `maxOpenRuns`, make one run `done`, `reopenTask` its last task, assert `Ok` and open count `maxOpenRuns + 1`                                                                                                                                  |
| Undo is offered to the task's whole team, not only to who pressed Done                                 | `run-actions.test.ts` callables, or `run-repository.test.ts`                                           | two members on team `t`; one marks Done; the other's `reopenTask` answers `Ok`                                                                                                                                                                                 |

Each test's `it` title is the sentence verbatim. If a sentence has to change to fit a test,
change the JSDoc in the same edit so the two never differ.

### 4.1 Done when

- Every title in the table above is found by `grep -rn "<title>" test/`.
- `pnpm test` passes.
- `pnpm fmt` has been run and every file it touched is kept.

## Deviations and issues

Record here, as you go, anything that did not go as written: what the plan said, what you
found, the two options you saw, and the one you took. One entry per item, dated.

All entries 2026-10-02.

- **1.6, the Assign sentence.** The plan put it in the block table's new row. A row cell that long
  breaks the table's width for one clause, so it is a sentence under the table instead, beside
  the pointer to the `reopen` and `putBack` bullets.
- **1.7, "over an open run".** `merchantAttachWorkflow` reads `changeWorkflow` over any run that is
  not closed, done included (a done run answers `ItemDone`). The bullet says "a run that is not
  closed". The inline comment in `agent/ShopWork.ts` that said Change workflow is gated through
  `requireRunAction` contradicted the new bullet and was reworded.
- **1.4, the backfill test.** `run-repository.test.ts` already pinned it, for the merchant, in
  "merchant completes an unassigned task: no team clause, and the merchant fills both actors".
  Retitled to "a Done without a Start records the actor as the starter too"; its body is
  unchanged.
- **1.10 and the Undo wording.** `shop.$shop.workflows.$runId.tsx` said the bench "takes back the
  member's own Done", the same claim the vocabulary sentence made. Reworded to match decision 3.
- **2.1, `Cell`.** A string refined by a predicate makes `Schema.is(Cell)` a guard on `string`,
  whose negation narrows the value to `never` in the parser's message. `isCell` wraps it as a
  plain boolean. The predicate is "the cell equals `M m v` cut to the letters it names", which
  refuses unknown letters, repeats and order in one test.
- **3.2, the note.** `run.note !== null && run.note.length > 0` was needed in two places, so it is
  a `Domain` predicate, `runHasNote`, beside `runHasRecord`. `changeWarning` takes the run
  (`blockedAt`, `note`) instead of `hasNote`, and the modal's state carries the run. A fourth
  shape the plan did not list, a note alone on an untouched run, reads "<from> has a note. Change
  to <to> anyway? The note will not carry over."
- **3.3, "no warning".** The empty warning is the page's gate (`runHasRecord`), not
  `changeWarning`'s output, so that test asserts `runHasRecord` is false.
- **Phase 4, the ceiling test.** `shop-agent-orders-ceiling.test.ts` is the order ceiling
  (`maxOrdersPerCycle`), not the open-run ceiling. The test is in `run-repository.test.ts`, in
  "RunRepository open-run ceiling", using its `withMaxOpenRuns`.
- **Phase 4, the outsider test.** It needs `memberGetRun`, which only the callables half has, so
  it moved there; it also checks the outsider's `setRunNote` answers `NotAllowed`. The old pure
  test "a task on none of the member's teams offers the member nothing" is gone, its assertion
  kept inside the new one.
- **Phase 4, the unassigned test.** The pure half carries the title. The callable half is a
  second test, "callables: a task on no team refuses the member's Done and takes the merchant's",
  because the pure tests have no live object.
- **Phase 4, the Undo test.** In `run-actions.test.ts`'s callables half, with a second member
  socket on the team: the reset records m1 as who pressed Done, and m2's `reopenTask` answers
  `Ok`.
- **Titles in the JSDoc.** Each rule sentence is in its JSDoc, but line-wrapped, so a one-line
  grep from the title finds the test and not the sentence.

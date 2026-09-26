# The vocabulary pass: what is left after the action tables

The one place for what is left after `docs/action-table-spec-research.md`
and `docs/action-table-spec-plan.md`. Those two are done and can be
deleted; nothing here depends on them. `docs/domain-language-research.md`
and its plan are done too; their "UI pass" is this document.

## What landed (2026-09-26)

- The action matrices are the JSDoc on `runActions` and `taskActions` in
  `src/lib/Domain.ts`, one column per input. They are the spec.
- `scripts/lib/action-table.ts` parses them; `pnpm action-table check`
  runs under `pnpm lint` and refuses a malformed table, overlapping rows,
  and a glossary word that occurs nowhere else in the file.
- `test/integration/run-actions.test.ts` reads the tables from the source,
  asserts both functions on every row, and drives every `ShopAgent`
  callable into every row's state.
- The glossary's verbs table no longer says who may do each verb; the
  matrices do.

## Where the vocabulary stands (survey, 2026-09-26)

The glossary settled the words for code and JSDoc in `Domain.ts` and the
repositories. It did not reach three places, and each has drifted on its
own:

1. **Screen copy.** Buttons, badges, tabs, toasts and error sentences were
   written screen by screen. The glossary carries a screen column for the
   state words only; verbs and nouns have none, so nothing says what a run
   is called on a member screen.
2. **Identifiers below `Domain.ts`'s structs.** Repository writes,
   callables, input structs and error classes still use the pre-glossary
   roots (`complete`, `uncomplete`, `unstart`, `undo`, `finished`), which
   the domain-language plan left in place on purpose ("Done is not a verb
   that takes an object") with a note to revisit.
3. **Prose that names a screen.** JSDoc that quotes a tab or badge was
   right when written and nobody checks it: the `RunStatus` JSDoc still
   lists the member's tabs as "Mine, Up next, In progress and Blocked";
   the tabs read Mine, Up next, Teammates, Blocked, Recent
   (`src/lib/runTabs.ts`). The glossary lint cannot catch this because it
   checks backticked identifiers, not quoted labels.

The inventory. File references are to `src/`.

### One concept, several words

| concept         | glossary                   | also found                                                                          | where                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run             | run                        | "work"                                                                              | member error copy in `lib/useMemberRunActions.ts` (5 sentences), `lib/changeWarning.ts`, `routes/shop.$shop.workflows.$runId.tsx:188`, the Teammates empty state                                                                                                                                           |
| run             | run                        | "workflow run"                                                                      | merchant order page error copy, 8 sentences in `routes/app.orders.$orderId.tsx`                                                                                                                                                                                                                            |
| run             | run                        | "workflows"                                                                         | the member run list's page title and section label, and the work-page URL `/shop/$shop/workflows/$runId`                                                                                                                                                                                                   |
| item            | item                       | "line item"                                                                         | `app.orders.$orderId.tsx:59`, `:1359`, `lib/workflowShared.ts:99`                                                                                                                                                                                                                                          |
| done (task)     | Done                       | "Mark done"                                                                         | merchant Manage drawer, `app.orders.$orderId.tsx:804`, toast "marked done"                                                                                                                                                                                                                                 |
| done, closed    | done, closed               | "finished"                                                                          | copy in `runTabs.ts` (Recent empty state), `useMemberRunActions.ts:39`, `app.orders.$orderId.tsx:63,67,82,100`, `components/QuotaBanners.tsx:38`, `components/WorkflowSwitch.tsx:219`; identifiers `RunFinishedError`, `TaskFinishedError`, `TaskFinished`, `LineItemState` kinds `finished` and `running` |
| started (task)  | Started                    | "In progress"                                                                       | the one task badge, `components/RunSteps.tsx:45`, drawn on the member work page and the merchant Manage drawer; the run-list row line "In progress · you" (`routes/shop.$shop.index.tsx:323-326`)                                                                                                          |
| reopen          | reopen                     | Undo (member), Reopen (merchant)                                                    | decided and kept (domain-language Decisions); but the member page then says "Reopened by you" under a button labelled Undo                                                                                                                                                                                 |
| reopen          | reopen                     | `undo*`, `uncomplete*`                                                              | `undoBlockedBy`, `UndoBlocker`, `RunResult` tag `UndoBlocked`, `TaskUndoBlockedError`, `uncompleteTask`, `merchantUncompleteTask`, `memberUncompleteTask`, `UncompleteTaskInput`, `UncompleteTaskCommand`                                                                                                  |
| put back        | put back                   | `unstart*`                                                                          | `unstartTask`, `merchantUnstartTask`, `memberUnstartTask`, `UnstartTaskInput`, `UnstartTaskCommand`                                                                                                                                                                                                        |
| done (verb)     | done                       | `complete*`                                                                         | `completeTask`, `merchantCompleteTask`, `memberCompleteTask`, `CompleteTaskInput`, `CompleteTaskCommand`, `completeRun`                                                                                                                                                                                    |
| tab             | Teammates, Blocked, Recent | `inProgress`, `attention`, `done`                                                   | `Domain.RunTier`, `Domain.RunTab`, `runTabs.ts`, `RunRepository.ts:1683`, `OrderRepository.ts` `attentionTask`, `attentionRun`                                                                                                                                                                             |
| workflow on/off | (none)                     | badge "Active"/"Inactive", buttons "Turn on"/"Turn off", copy "is off", "turned on" | `lib/workflowShared.ts:77-78,107`, `components/WorkflowSwitch.tsx`                                                                                                                                                                                                                                         |

### One word, several concepts

| word        | glossary meaning                        | second meaning                                  | where                                                                                                                                                                                                             |
| ----------- | --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ready       | task state: step current, nobody has it | the code flag: step current, started or not     | `readyTasks`, `readyWhere`, `RunTaskView.ready`, `holdsReadyTask`, the "ready task" prose in `RunRepository.ts`, `OrderRepository.ts`, `app.orders.$orderId.tsx`, `shop.$shop.index.tsx`, `app.teams.$teamId.tsx` |
| In progress | run state open (screen)                 | task state started (screen)                     | `RunSteps.tsx:45`; on the merchant page the run badge and the task badge read the same word one card apart                                                                                                        |
| start       | task verb, ready → started              | attach a workflow to an item                    | merchant "Start" button `app.orders.$orderId.tsx:1171`, toast "Started <workflow>."                                                                                                                               |
| waiting     | task state: step not current            | teams with a ready task                         | orders index column "Waiting on", `app.teams.$teamId.tsx:433` "Orders waiting on this team"                                                                                                                       |
| open        | run or order state                      | orders-index Status filter "Open" (order sense) | `app.orders.index.tsx:68`; consistent with the glossary, listed so nobody renames it                                                                                                                              |

### Not wrong, listed so it is not reopened

- "To make · Making · Made · Fulfilled · Cancelled" on the orders index:
  the production ladder, settled earlier, Shopify's words where Shopify
  owns the fact.
- "Not started" merchant run badge: the glossary allows it.
- "Closed · <reason>" lines: match `ClosedReason`'s table.

### Corrections to the earlier draft of this document

- The task badge "In progress" is rendered in one place,
  `components/RunSteps.tsx`, not in `runTabs.ts` and three route files.
  `runTabs.ts` only cites it as the reason the `inProgress` tab reads
  Teammates; that reason half-disappears once the badge says Started.
- `readyWhere.ts`'s JSDoc says it is "the same rule" as `readyTasks`. It is
  not quite: `readyTasks` returns nothing on a run that is not open, while
  `readyWhere` checks only the task's own step and relies on every caller
  adding `status = 'active'`. Say so in its JSDoc, or add the run test to
  the SQL.
- `expand` in `action-table.ts` already documents the narrow/broad `ready`
  split (its table of fixture shapes); the rename below touches its flag
  name and one sentence, nothing else.

## Follow-ups, in order

### 1. Extend the glossary to screens, and make the lint read it

The glossary gets a screen column for nouns and verbs as it has for
states. Verbs need two columns, member and merchant, because Undo/Reopen
is a kept decision. Every label a screen renders for a glossary word
comes from one constant in `Domain.ts` keyed by the glossary word
(`TASK_STATE_LABEL`, `RUN_STATE_LABEL`, `VERB_LABEL`), the screens read
the constant, and `checkGlossary` asserts each screen cell equals the
constant. Then a label change starts at the glossary row, as an action
change starts at a cell, and the e2e locators read the same constants.

Free-text copy (toasts, error sentences, empty states) cannot be checked
this way. For it, `scripts/rules-lint.ts` gets a short denylist over
string literals in `src/routes` and `src/components`: "workflow run",
"line item", "finished", "Mark done", "in progress" outside the two
allowed constants. Small, and it stops the drift coming back.

### 2. Rename the broad `ready`

One word for "its step is current", whether or not someone has it.
`current` is the recommendation: it is already the glossary's own
definition ("its step is current"), it has no other domain use, and
`currentQuantity` is Shopify's word on a different noun. Then:

- `readyTasks` → `currentTasks`, `readyWhere` → `currentWhere`,
  `RunTaskView.ready` → `current`, `holdsReadyTask` → `holdsCurrentTask`.
- The "ready task" prose in the files listed above moves to "current
  task" where it means the broad sense (the run list, Block's team gate,
  "Waiting on") and stays "ready" where it means the narrow one (Start).
- The glossary's task-states "derived from" column names the new flag;
  the "m" paragraph on `runActions` says "a current task".
- `expand` sets `current` where it set `ready`; the table words do not
  change.

### 3. Rename the identifiers to the glossary roots

| today                                                                                                                   | after                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `completeTask`, `merchantCompleteTask`, `memberCompleteTask`, `CompleteTaskInput`, `CompleteTaskCommand`, `completeRun` | `markTaskDone`, `merchantMarkTaskDone`, `memberMarkTaskDone`, `MarkTaskDoneInput`, `MarkTaskDoneCommand`, `markRunDone` |
| `uncompleteTask`, `merchantUncompleteTask`, `memberUncompleteTask`, `UncompleteTaskInput`, `UncompleteTaskCommand`      | `reopenTask`, `merchantReopenTask`, `memberReopenTask`, `ReopenTaskInput`, `ReopenTaskCommand`                          |
| `unstartTask`, `merchantUnstartTask`, `memberUnstartTask`, `UnstartTaskInput`, `UnstartTaskCommand`                     | `putBackTask`, `merchantPutBackTask`, `memberPutBackTask`, `PutBackTaskInput`, `PutBackTaskCommand`                     |
| `undoBlockedBy`, `UndoBlocker`, `UndoBlocked`, `TaskUndoBlockedError`                                                   | `reopenBlockedBy`, `ReopenBlocker`, `ReopenBlocked`, `TaskReopenBlockedError`                                           |
| `RunFinishedError`, `TaskFinishedError`, `TaskFinished`                                                                 | `RunNotOpenError`, `TaskDoneError`, `TaskDone`                                                                          |
| `LineItemState` kinds `running`, `finished`                                                                             | `open`, `done`                                                                                                          |
| `RunTier`/`RunTab` `inProgress`, `attention`; `attentionTask`, `attentionRun`                                           | `teammates`, `blocked`; `blockedTask`, `blockedRun`                                                                     |

Log messages and `callableEffect` names follow the callable (domain
language plan ground rule). Storage columns (`startedAt`, `doneAt`,
`blockedAt`, `reopened*`) already match and do not move.

### 4. Sweep the screen copy

With the constants in place, the copy sweep is mechanical:

- Task badge Started (from In progress). Row line "Started · you".
- Member copy says "run", not "work"; merchant copy says "run", not
  "workflow run"; both say "item", not "line item".
- "finished" → "done" (a task) or "done or closed" (a run) as the sentence
  means.
- Merchant "Mark done" → "Done", one label per verb (Question 3).
- Merchant "Start" on an item's picker → the attach word (Question 4).
- Member run list title and URL (Question 5).
- Workflow badge (Question 6).
- The e2e specs that assert these labels (`e2e/orders.spec.ts`,
  `e2e/member-runs.member.spec.ts`, `e2e/fixture.ts` comments) move with
  them, reading the constants where they can.

### 5. Sweep the JSDoc that quotes a screen

`RunStatus`'s tab sentence, `runTabs.ts`'s Teammates reasoning,
`readyWhere.ts`'s "same rule" claim, and any JSDoc that quotes "In
progress" for a task. Grep for quoted labels in `src/lib/**/*.ts` JSDoc
after the constants exist.

### 6. The other rule tables: leave as prose, say so

`RunStatus`'s gate table and `runIsBlocked`'s table are one row per
action naming the predicate, not a truth value per state. The parser
cannot assert them and should not: the matrices pin each cell they
describe, and "which predicate" and "what result" are two facts, not a
duplicate. Add one sentence to each saying the lint does not read it and
why.

### 7. Tighten the glossary check only if it lets a stale row through

`checkGlossary` asserts presence of each backticked identifier elsewhere
in the file; it does not check that a literal is in the right
`Schema.Literals` or that a symbol is an export. Enough for the failure
seen so far. Upgrade it when a stale glossary row gets past it. The
screen-column check in follow-up 1 is a different check and is not this.

## Decisions (2026-09-26)

Settled in review. No open questions remain.

1. The broad flag is `current`.
2. Rename the identifier roots now: `markTaskDone`, `reopenTask`,
   `putBackTask`, and the `undo*` / `finished` / tab-key renames in
   follow-up 3.
3. Merchant "Mark done" becomes "Done".
4. Add the verb "attach workflow" (item: creates the run) beside "change
   workflow"; the merchant's picker button stops saying "Start".
5. **"run" is a code and JSDoc noun only; no screen says it.** Merchants
   and members would not know what a run is, and each already has a word
   for the thing:
   - The merchant sees the item and its workflow, as Change workflow
     already does. "Cancel run" → "Cancel workflow", "Keep run" → "Keep
     workflow", "Cancel this run?" → "Cancel <workflow> on <item>?",
     toasts "Run blocked" / "Run unblocked" → "Blocked" / "Unblocked",
     quota copy "Baton is already running N workflows" → "N items are in
     production", the eight "That workflow run …" sentences → "That item
     …" or "This workflow …" as each means.
   - The member sees work and tasks. The five "This work …" sentences
     stay. The list is titled "Work", the page `/shop/$shop/work/$runId`.
     The Recent empty state says "Nothing done or closed in the last day."
   - The glossary's run row gets screen "(none): merchant sees the item's
     workflow, member sees work". The copy denylist refuses "run" and
     "runs" in screen strings.
6. Workflow badge reads "On" / "Off"; a "Workflow states" heading goes in
   the glossary.
7. `waiting` stays the task-state word in code and JSDoc; "Waiting on"
   stays the orders-index column.
8. Order of work: follow-ups 1 → 2 → 3 → 4 → 5, one change each, green
   between; 6 and 7 as they come up.
9. **"item" is the screen and prose word for an order line item.** The
   Shopify admin's order page says "items" ("3 items", "Fulfill items"),
   so it is the word a merchant arrives with; "line item" is the API and
   Flow word and reads as bookkeeping at the bench; "order item" is a
   coined term nobody uses; "product" is the catalog entry, a different
   thing. `OrderLineItem` stays the struct. Baton never shows an item
   outside its order, so the order supplies the disambiguation; copy that
   has no order beside it qualifies the word ("items on open orders", "N
   items in production") rather than saying "items" bare. The copy
   denylist refuses "line item".

## Not follow-ups

Recorded so they are not reopened:

- `checkChangeWorkflow` in the callable walk accepts any of `ItemDone`,
  `OrderClosed`, `NothingToMake` on a blank cell rather than the one the
  fixture should produce. The cell is proved refused; which tag comes back
  is `merchantAttachWorkflow`'s own rule with its own tests.
- The outsider tests ("a member whose team holds no ready task...", "a task
  on none of the member's teams...") and the no-item test stay as hand
  tests. Membership is a second axis the table does not draw (research
  Rule 3).
- Undo (member) and Reopen (merchant) stay two screen words for one verb
  (domain-language Decisions). Follow-up 3 renames the code to `reopen`;
  the member label does not move.

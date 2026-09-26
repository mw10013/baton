# Vocabulary pass: implementation plan

For an implementing LLM. The decisions are in
`docs/action-table-follow-ups-research.md` (Decisions section, nine items)
and its survey tables name every site. Read that file first; every word
below comes from it. This plan is how to land it.

## Ground rules

From `AGENTS.md`, restated because each one bites here:

- Do not commit. Do not branch. Work on `main`.
- No migrations. We are prototyping. No storage column moves in this
  pass anyway; if one turns out to be needed, edit the `create table`
  block in `src/lib/ShopAgent.ts` in place and record it under Deviations.
- `pnpm typecheck && pnpm lint && pnpm test` green at the end of every
  stage. `npm run test:e2e --` at the end of Stage 4 and Stage 6.
  `pnpm fmt` repo-wide at the end and keep every file it touches.
- Rules stay on the symbol that owns them. Predicates, never inline
  comparisons (`scripts/rules-lint.ts` refuses them). A JSDoc never
  references `docs/`.
- Plain prose in JSDoc, comments and copy. No flourishes.
- Log messages: `ShopAgent.<callable>: shop=<shop> ...`. When a callable is
  renamed, its log message and `callableEffect` name follow.
- The glossary in `src/lib/Domain.ts` is the vocabulary. When this plan and
  the glossary disagree, the glossary as written in Stage 1 wins; record
  the disagreement under Deviations.
- Chrome DevTools MCP (`.mcp.json`, `chrome-devtools`) is available and
  useful here: after Stage 4, open the member run list, the member work
  page and the merchant order page and read the labels as a person would.
  `pnpm playwright-cli` is the other option. Start the app with
  `pnpm app:dev`, get the port with `pnpm port`, seed with `pnpm seed`,
  and wait for `body[data-hydrated="true"]` before clicking.
- `src/routeTree.gen.ts` and `worker-configuration.d.ts` are generated.
  Do not hand-edit them.

## Stage 0: baseline

Run `pnpm typecheck && pnpm lint && pnpm test`. Record anything already
failing under Issues so it is not blamed on this work. Read the Glossary
block at the top of `src/lib/Domain.ts` and `src/lib/runTabs.ts` once,
whole.

## Stage 1: glossary, label constants, and the checks

This stage adds the mechanism every later stage leans on. Nothing on a
screen changes yet except where a screen now reads a constant whose value
is what it already showed.

### 1a. The glossary block

Replace the Glossary block in `src/lib/Domain.ts` with the following. It
is written in the final words, so it is right when the pass is done; the
screens catch up in Stage 4. Every backticked word must exist elsewhere in
`Domain.ts` (`pnpm action-table check` refuses one that does not), so
where a row names a symbol this plan introduces later in Stage 1, add the
symbol in the same edit.

```
/**
 * Glossary. These are the words for code, JSDoc, research and screen; a
 * symbol named here is an export of this file, or a field of one. A row
 * says what a word means, where it lives, and what a screen calls it; the
 * rule stays on the symbol. The screen columns are checked: each cell is
 * the value of the label constant beside the table ({@link TASK_STATE_LABEL},
 * {@link RUN_STATE_LABEL}, {@link VERB_LABEL}), and `pnpm action-table
 * check` refuses a cell that differs, so a label change starts here.
 *
 * Nouns. "(none)" means no screen says the word; the cell says what a
 * screen shows instead:
 *
 * | word     | meaning                                                  | symbol                          | screen                                                        |
 * | -------- | -------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
 * | merchant | the shop's owner, acting from the Shopify admin          | `Actor` role `merchant`         | "you" to the merchant, "the merchant" to a member              |
 * | member   | a person at the bench, on one or more teams              | `Actor` role `member`, `Member` | member (merchant screens); "you" or a name (member screens)   |
 * | team     | the group a task is assigned to                          | `Team`                          | team, or its name                                             |
 * | order    | a Shopify order                                          | `ShopOrder`                     | its name (#1001)                                              |
 * | item     | one line item of an order                                | `OrderLineItem`                 | item; never "line item"                                       |
 * | workflow | the definition: steps of tasks                           | `Workflow`, `WorkflowTask`      | workflow, or its name                                         |
 * | step     | a position in a workflow; its tasks are done in parallel | `WorkflowTask`, `RunTask` field | Step k of n                                                   |
 * | run      | one item going through one workflow                      | `Run`                           | (none): the merchant sees the item's workflow, the member work |
 * | task     | one unit of work on a run, on one team                   | `RunTask`                       | task, or its name                                             |
 * | block    | a person's hold on a run                                 | `runIsBlocked`                  | Blocked                                                       |
 * | note     | free text on a run                                       | `RunNote`                       | Note                                                          |
 *
 * An item is always shown under its order, on the merchant's order page
 * and in the member's `<order> · <item>` row, so the order carries the
 * disambiguation and the word stays short. Copy with no order beside it
 * qualifies the word ("items on open orders", "N items in production")
 * rather than saying "items" bare. "run" is an implementation noun a
 * merchant or member would have to learn; the merchant already has the
 * item and its workflow (Change workflow replaces the run without naming
 * it), and the member has their work and its tasks. `scripts/rules-lint.ts`
 * refuses "run", "line item" and the other retired words in screen strings.
 *
 * Run states:
 *
 * | word    | meaning                                           | stored          | screen                                                  |
 * | ------- | ------------------------------------------------- | --------------- | ------------------------------------------------------- |
 * | open    | work can be recorded                              | `active`        | In progress (merchant: Not started until a task starts) |
 * | blocked | open, and a person holds it                       | `blockedAt` set | Blocked                                                 |
 * | done    | a person finished the last task                   | `done`          | Done                                                    |
 * | closed  | something else ended it; `closedReason` says what | `closed`        | Closed · <reason>                                       |
 *
 * Task states. `current` is the flag: the task's step is the lowest with
 * an open task ({@link currentTasks}), whether or not someone has it:
 *
 * | word    | meaning                            | derived from              | screen  |
 * | ------- | ---------------------------------- | ------------------------- | ------- |
 * | waiting | its step is not current            | not current               | (none)  |
 * | ready   | its step is current, nobody has it | current, `startedAt` null | Ready   |
 * | started | a person has it                    | current, `startedAt` set  | Started |
 * | done    | finished                           | `doneAt` set              | Done    |
 *
 * "In progress" is the run's screen word and only the run's: a started
 * task reads Started so the merchant never reads one word for two facts
 * on one card. "waiting" is a code word; the orders index's "Waiting on"
 * column means teams holding a ready task, a fact about orders, and the
 * two never render together.
 *
 * Workflow states:
 *
 * | word | meaning                            | stored          | screen |
 * | ---- | ---------------------------------- | --------------- | ------ |
 * | on   | new items get runs from it         | `active` true   | On     |
 * | off  | it starts nothing; open runs finish | `active` false  | Off    |
 *
 * Verbs. Who may do each, and in which state, is the matrix on
 * {@link taskActions} or {@link runActions}, not here. The two screen
 * columns are the member's and the merchant's label; "(none)" means that
 * screen never offers the verb. Undo and Reopen are two words for one
 * verb on purpose: the member takes back their own Done, the merchant
 * reopens someone's record.
 *
 * | word            | on a | effect                              | member      | merchant        |
 * | --------------- | ---- | ----------------------------------- | ----------- | --------------- |
 * | start           | task | ready → started                     | Start       | (none)          |
 * | done            | task | ready or started → done             | Done        | Done            |
 * | put back        | task | started → ready                     | Put back    | Put back        |
 * | reopen          | task | done → ready                        | Undo        | Reopen          |
 * | assign          | task | moves it to a team                  | (none)      | Assign team     |
 * | note            | run  | writes the note                     | Edit note   | Edit note       |
 * | block           | run  | open → blocked                      | Block       | Block           |
 * | edit reason     | run  | changes the block's reason          | Edit reason | Edit reason     |
 * | unblock         | run  | blocked → open                      | Unblock     | Unblock         |
 * | cancel          | run  | open → closed, `merchant_cancelled` | (none)      | Cancel workflow |
 * | attach workflow | item | creates the run                     | (none)      | Attach          |
 * | change workflow | item | replaces the run                    | (none)      | Change workflow |
 */
```

The Workflow states "stored" column names `Workflow.active`, which is the
real field (`active: Schema.Boolean` on `Workflow`).

### 1b. The label constants

Add to `Domain.ts`, next to the glossary or next to the concepts they
label. Each is `as const`; the screens read them and nothing else spells a
label.

```ts
/** The glossary's task-state words. Derived, never stored: {@link taskStateOf}. */
export const TaskState = Schema.Literals([
  "waiting",
  "ready",
  "started",
  "done",
]);
export type TaskState = typeof TaskState.Type;

/** One task's state from its row and the `current` flag ({@link RunTaskView}). The one derivation; `RunSteps.tsx` read this instead of its own. */
export const taskStateOf = (
  task: Pick<RunTaskView, "current" | "startedAt" | "doneAt">,
): TaskState =>
  task.doneAt !== null
    ? "done"
    : !task.current
      ? "waiting"
      : task.startedAt !== null
        ? "started"
        : "ready";

/** The glossary's task-states screen column. `null` is "(none)". */
export const TASK_STATE_LABEL = {
  waiting: null,
  ready: "Ready",
  started: "Started",
  done: "Done",
} as const satisfies Record<TaskState, string | null>;

/** The glossary's run-states screen column, plus the merchant's word for an open run nobody has touched ({@link runIsUnstarted}). */
export const RUN_STATE_LABEL = {
  open: "In progress",
  blocked: "Blocked",
  done: "Done",
  closed: "Closed",
} as const;
export const RUN_UNSTARTED_LABEL = "Not started";

/** The glossary's workflow-states screen column. */
export const WORKFLOW_STATE_LABEL = { on: "On", off: "Off" } as const;

/** The glossary's verbs, as the action structs name them, plus the two item verbs. */
export const Verb = Schema.Literals([
  "start",
  "done",
  "putBack",
  "reopen",
  "assign",
  "note",
  "block",
  "editReason",
  "unblock",
  "cancel",
  "attachWorkflow",
  "changeWorkflow",
]);
export type Verb = typeof Verb.Type;

/** The glossary's two screen columns for verbs. `null` is "(none)". */
export const VERB_LABEL = {
  start: { member: "Start", merchant: null },
  done: { member: "Done", merchant: "Done" },
  putBack: { member: "Put back", merchant: "Put back" },
  reopen: { member: "Undo", merchant: "Reopen" },
  assign: { member: null, merchant: "Assign team" },
  note: { member: "Edit note", merchant: "Edit note" },
  block: { member: "Block", merchant: "Block" },
  editReason: { member: "Edit reason", merchant: "Edit reason" },
  unblock: { member: "Unblock", merchant: "Unblock" },
  cancel: { member: null, merchant: "Cancel workflow" },
  attachWorkflow: { member: null, merchant: "Attach" },
  changeWorkflow: { member: null, merchant: "Change workflow" },
} as const satisfies Record<
  Verb,
  { member: string | null; merchant: string | null }
>;
```

`taskStateOf` needs `RunTaskView.current`, which is Stage 2's rename. To
keep Stage 1 green on its own, write `taskStateOf` against `ready` in
Stage 1 and rename it with everything else in Stage 2; or do Stages 1 and
2 as one change. Either is fine; say which under Deviations.

Tab labels stay in `src/lib/runTabs.ts`. Tabs are not glossary words; the
strip is a presentation of the tiers, and its JSDoc already says why each
label differs from its key.

### 1c. The screen-column check

Extend `checkGlossary` in `scripts/lib/action-table.ts`, or add a sibling
`checkScreenColumns`, and call it from the `check` command in
`scripts/action-table.ts`. The script may import `@/lib/Domain` (it
imports only `effect`), so compare parsed cells to the constants at run
time rather than re-parsing TypeScript:

- Task states table: the `screen` cell of each row equals
  `TASK_STATE_LABEL[word]`, "(none)" for `null`.
- Run states table: the `screen` cell, up to the first " (" if any, equals
  `RUN_STATE_LABEL[word]`; the closed row's cell is `Closed · <reason>`,
  compare its prefix before " ·".
- Workflow states table: `WORKFLOW_STATE_LABEL[word]`.
- Verbs table: the `member` and `merchant` cells equal
  `VERB_LABEL[key].member` / `.merchant`, where the key is the glossary
  word in camel case (`put back` → `putBack`, `edit reason` →
  `editReason`, `attach workflow` → `attachWorkflow`).
- Every `TaskState`, `Verb` literal and `RUN_STATE_LABEL` key has a row,
  and every row has a constant.

Report each mismatch as `Glossary: <table> <word>: screen says "<cell>",
constant says "<value>"`. Add a test in `test/` beside the existing
action-table tests: one case that the real source passes, one that a
doctored cell fails, titled with the rule ("the glossary's screen column
is the label constant").

### 1d. The copy worklist

The copy denylist itself is added in Stage 4, after the copy has moved,
so `pnpm lint` stays green at every stage without a gate. Here, only
gather the worklist: grep the screen files (`src/routes/**`,
`src/components/**`, `src/lib/useMemberRunActions.ts`,
`src/lib/changeWarning.ts`, `src/lib/workflowShared.ts`,
`src/lib/runTabs.ts`) for the retired words in the table under Stage 4d,
case-insensitive, inside string literals, and record the hits under Issues
as the Stage 4 worklist.

Run `pnpm typecheck && pnpm lint && pnpm test`.

## Stage 2: the broad `ready` becomes `current`

Decision 1. One rename, typecheck-driven.

| today                                                | after                             |
| ---------------------------------------------------- | --------------------------------- |
| `Domain.readyTasks`                                  | `currentTasks`                    |
| `src/lib/readyWhere.ts`, `readyWhere`                | `currentWhere.ts`, `currentWhere` |
| `Domain.RunTaskView.ready`                           | `current`                         |
| `Domain.holdsReadyTask`                              | `holdsCurrentTask`                |
| `runActions` / `taskActions` parameter field `ready` | `current`                         |
| `scripts/lib/action-table.ts` fixture field `ready`  | `current`                         |

The table words in `runActions` and `taskActions` (`ready`, `started`) do
not change: they are the glossary's narrow words and `expand` maps them to
`current` plus `startedAt`. Update `expand`'s fixture-shape table and its
sentence about the narrow/broad split.

Prose. Grep `ready task` and `ready or started` in `src/lib/*.ts`,
`src/routes/*.tsx`, `src/components/*.tsx`. Where the sentence means the
broad sense (the run list's rows, Block's team gate, "Waiting on", the
parallel-step notes on the order page), write "current task". Where it
means the narrow one (Start is on a ready task; a reopened task reads
Ready), leave it. "ready or started task" becomes "current task". The "m"
paragraph on `runActions` says "a current task on the run".

`currentWhere.ts` JSDoc: state that the SQL checks the task's step only
and relies on the caller's `status = 'active'` filter, while
`currentTasks` returns nothing on a run that is not open; name the callers
that add the filter (`RunRepository.listRuns`, the task guards,
`OrderRepository`'s waiting-on and team filter). Alternatively add the run
test to the SQL and keep "same rule"; say which under Deviations.

The glossary's task-states table already names `current` (Stage 1a). The
RunStatus JSDoc's gate table rows "task ready", "task ready or started"
are the narrow words and stay.

Run `pnpm typecheck && pnpm lint && pnpm test`.

## Stage 3: identifier roots

Decision 2. Typecheck-driven; no storage change. Log messages and
`callableEffect` names follow each callable.

| today                                                                                                                                                     | after                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `RunRepository.completeTask`, `ShopAgent.merchantCompleteTask`, `memberCompleteTask`, `CompleteTaskInput`, `CompleteTaskCommand`, `ShopAgent.completeRun` | `markTaskDone`, `merchantMarkTaskDone`, `memberMarkTaskDone`, `MarkTaskDoneInput`, `MarkTaskDoneCommand`, `markRunDone` |
| `uncompleteTask`, `merchantUncompleteTask`, `memberUncompleteTask`, `UncompleteTaskInput`, `UncompleteTaskCommand`                                        | `reopenTask`, `merchantReopenTask`, `memberReopenTask`, `ReopenTaskInput`, `ReopenTaskCommand`                          |
| `unstartTask`, `merchantUnstartTask`, `memberUnstartTask`, `UnstartTaskInput`, `UnstartTaskCommand`                                                       | `putBackTask`, `merchantPutBackTask`, `memberPutBackTask`, `PutBackTaskInput`, `PutBackTaskCommand`                     |
| `Domain.undoBlockedBy`, `UndoBlocker`, `RunTaskView.undoBlockedBy`, `RunResult` tag `UndoBlocked`, `RunRepository.TaskUndoBlockedError`                   | `reopenBlockedBy`, `ReopenBlocker`, `reopenBlockedBy`, `ReopenBlocked`, `TaskReopenBlockedError`                        |
| `RunRepository.RunFinishedError`, `TaskFinishedError`, result tag `TaskFinished`                                                                          | `RunNotOpenError`, `TaskDoneError`, `TaskDone`                                                                          |
| `LineItemState` kinds `running`, `finished`                                                                                                               | `open`, `done`                                                                                                          |
| `RunTier` / `RunTab` literals `inProgress`, `attention`                                                                                                   | `teammates`, `blocked`                                                                                                  |
| `OrderRepository.attentionTask`, `attentionRun`                                                                                                           | `blockedTask`, `blockedRun`                                                                                             |
| `useMemberRunActions` returned keys `complete`, `uncomplete`, `unstart`                                                                                   | `markDone`, `reopen`, `putBack`                                                                                         |
| `shop.$shop.index.tsx` locals `doneUndo`, `undoable`                                                                                                      | `reopen`, `reopenable` (or as reads best; the label stays Undo)                                                         |

Check before renaming each: the `RunTab` literal is a URL search param
(`src/routes/shop.$shop.tsx` `tab`); a bookmark with `?tab=inProgress`
will 404 or fall to the default after the rename. Prototype, so accept it
and record it. `runTabs.ts`'s `TABS` and `TAB_LABEL` keys follow; the
Teammates and Blocked JSDoc paragraphs now explain a label that matches
its key and can shrink to one sentence each. The `done` tab key and its
Recent label stay.

Update `test/integration/run-actions.test.ts` and any other test that
names a callable or error. The action-table `expand` sets
`reopenBlockedBy` where it set `undoBlockedBy`.

Grep afterwards for `complete`, `uncomplete`, `unstart`, `undo`,
`finished` as identifiers across `src/` and `test/` (not copy, not
comments) and list what remains under Deviations with a reason; a name
that stays must say why in its JSDoc.

Run `pnpm typecheck && pnpm lint && pnpm test`.

## Stage 4: the screens

Decisions 3, 4, 5, 6, 9 and the Started badge. Each screen reads the
constants from Stage 1b; no route or component spells a glossary label.
Work through the denylist hits from Stage 1 and the survey tables in the
research doc. The sites, by screen:

### The one task card (`src/components/RunSteps.tsx`)

- Replace the local `taskState` derivation with `Domain.taskStateOf` and
  read the badge label from `TASK_STATE_LABEL`. The started badge now
  reads Started.
- Tones stay as they are.

### Member run list (`src/routes/shop.$shop.index.tsx`)

- Row menu labels (`Start`, `Done`, `Put back`, `Unblock`, `Undo`) from
  `VERB_LABEL[verb].member`; the `named(verb, each)` helper takes the
  constant.
- Row line: `In progress · <who>` becomes `${TASK_STATE_LABEL.started} ·
<who>`; the bare `In progress` (nobody named) is the run's word,
  `RUN_STATE_LABEL.open`.
- Page title "Workflows — Baton" becomes "Work — Baton"; the section
  `accessibilityLabel` "Workflows" becomes "Work".
- The JSDoc sentence "A row you started says where it is in the run, not
  'In progress · you'" follows the new words.

### Member work page (`src/routes/shop.$shop.workflows.$runId.tsx`)

- Rename the file to `src/routes/shop.$shop.work.$runId.tsx` so the URL
  is `/shop/$shop/work/$runId`. `src/routeTree.gen.ts` is generated by
  the TanStack Router plugin; find how it regenerates in this repo (the
  Vite plugin during `pnpm dev` or `pnpm typecheck`, or a generator
  script) and run that, never hand-edit. Grep `workflows/` in `src/`,
  `e2e/` and `test/` for every link and `to=` and update them.
- Button labels from `VERB_LABEL[verb].member`.
- The "not on one of your teams" sentence: "This work is not on one of
  your teams" stays ("work" is the member's word).
- Banner heading "Closed" is `RUN_STATE_LABEL.closed`.

### Member copy modules

- `src/lib/useMemberRunActions.ts`: the five "work" sentences stay; "This
  work is already finished or closed" becomes "This work is already done
  or closed".
- `src/lib/changeWarning.ts`: "That work will not carry over" and "Work on
  it stops" stay.
- `src/lib/runTabs.ts`: Recent empty state "Nothing finished or closed in
  the last day." becomes "Nothing done or closed in the last day."
  "Nobody else has work." stays.
- `src/components/MemberRun.tsx`: "Edit note", "Edit reason", the Blocked
  banner heading from the constants. `src/components/RunTextModals.tsx`:
  the Block submit label from `VERB_LABEL.block.member` (it is the same
  string for the merchant).

### Merchant order page (`src/routes/app.orders.$orderId.tsx`)

- `RUN_STATUS_BADGE` labels from `RUN_STATE_LABEL`; `NOT_STARTED_BADGE`
  from `RUN_UNSTARTED_LABEL`; the Blocked badge likewise.
- Manage drawer buttons from `VERB_LABEL[verb].merchant`: "Mark done"
  becomes Done (Decision 3); toast "<task> marked done" becomes "<task>
  done". Put back, Reopen, Assign team unchanged in text, now read from
  the constant.
- Run-level buttons: "Cancel run" becomes `VERB_LABEL.cancel.merchant`,
  Cancel workflow. The modal heading "Cancel this run?" becomes "Cancel
  <workflow> on <item>?" with the names in; "Keep run" becomes "Keep
  workflow"; toast "Run cancelled." becomes "<workflow> cancelled on
  <item>." or "Cancelled." if the names are not to hand.
- The item picker's "Start" becomes `VERB_LABEL.attachWorkflow.merchant`,
  Attach (Decision 4); toast "Started <workflow>." becomes "Attached
  <workflow>." The JSDoc near line 480 that says "Started, never resumed"
  is about that toast; rewrite it for Attach.
- Toasts "Run blocked" / "Run unblocked" become "Blocked" / "Unblocked".
- The eight "That workflow run …" error sentences (lines 82, 88, 95, 100,
  103, 1535, 1557, 1568 at survey time) become "That item …" or "This
  workflow …" as each means; read each `RunResult` tag it maps and write
  the sentence for that case.
- "That workflow is already running on this item." stays (the subject is
  the workflow). "Baton is already running N workflows. Finish or cancel
  some" becomes "N items are in production. Cancel one, or wait for one
  to finish" with "finish" replaced by the glossary word: "wait for one to
  be done" reads badly, so use "until one is done or closed" or rewrite;
  record the sentence you chose.
- "This item is finished on X. Reopen its last task…" becomes "This item
  is done on X. …".
- "That line item no longer exists." becomes "That item no longer
  exists."; "tracks up to N line items per order" becomes "items per
  order".
- The Reopen help text "Can't reopen: … put it back or reopen it first"
  stays; it uses glossary verbs.

### Merchant orders index, teams, workflows, banners

- `src/routes/app.orders.index.tsx`: the production badges and "Waiting
  on" column stay (Decision 7, and the ladder is settled).
- `src/components/QuotaBanners.tsx:38`: "N are already in progress.
  Finish or cancel runs to resume." becomes "N items are in production.
  Cancel one, or wait until one is done or closed."
- `src/components/WorkflowSwitch.tsx:219`: "Turned off. Open runs
  finish." becomes "Turned off. Items already on it are finished by their
  teams." with "finished" replaced: "Items already on it continue to
  done." Pick the sentence that reads best without run or finish and
  record it.
- `src/lib/workflowShared.ts`: badge "Active"/"Inactive" becomes
  `WORKFLOW_STATE_LABEL.on` / `.off` (Decision 6); "Runs already in
  progress keep going." becomes "Items already on it keep going."; the
  "unclaimed" sentence at line 197 and `app.teams.$teamId.tsx:361` become
  "its tasks wait for a member" or similar; "with a line item tagged"
  becomes "with an item tagged".
- `src/routes/app.workflows.index.tsx`: filter "All / Active / Inactive"
  becomes "All / On / Off"; "Item workflows" (accessibilityLabel and
  "Showing x of y item workflows.") becomes "Workflows".
- `src/routes/shop.$shop_.lapsed.tsx:28` "its workflows are unavailable"
  stays.
- `src/routes/index.tsx:33` "from order to completion" is marketing copy
  on the public page; leave it and record it as out of scope.

### Glossary sentences the screens must honour

- No screen string says "run". The denylist enforces it; where a sentence
  cannot avoid the noun, it is the item ("this item") or the workflow.
- An item stands under its order; standalone copy says "items on open
  orders" or "items in production".

### e2e

`e2e/orders.spec.ts`, `e2e/member-runs.member.spec.ts` and `e2e/fixture.ts`
assert labels: "Ready", "Reopen", "Put back", "Undo", "Not started",
`In progress · ${MAKER}`, "Mark done" and the `/workflows/` URL. Update
them to the new words. `e2e/fixture.ts` imports only from `./seed.ts`
today; try a type-only or value import of `@/lib/Domain` from the specs,
and if the Playwright config does not resolve `@/`, update the literals
and say so. Update the comments in `fixture.ts` that describe
badges (lines 410, 753, 760 at survey time).

### 4d. The copy denylist

With the copy moved, add a second pattern set to `scripts/rules-lint.ts`,
applied to string literals in the screen files named in Stage 1d. Skip
lines that are comments (trimmed line starts with `*`, `/*` or `//`) and
match only inside quotes or backticks. Case-insensitive:

| pattern                               | why                                                                 |
| ------------------------------------- | ------------------------------------------------------------------- |
| `\brun\b`, `\bruns\b`, `workflow run` | Decision 5: no screen says run                                      |
| `line item`                           | Decision 9                                                          |
| `mark done`, `marked done`            | Decision 3                                                          |
| `\bfinish(ed)?\b`                     | the glossary word is done (task) or done or closed (run)            |
| `in progress`                         | allowed only as `RUN_STATE_LABEL.open`; a screen reads the constant |
| `\bunclaimed\b`                       | the glossary has no such state; say "waits for a member"            |

Emit `rules-lint: retired word in screen copy; use the glossary word:` and
the hits. Run `pnpm lint` and fix every hit it finds that the sweep above
missed; a hit that is a false positive (an identifier inside a template
string, say) is fixed by narrowing the pattern, not by an allowlist, and
is recorded under Deviations. No gate, no environment variable: the
denylist runs under `pnpm lint` from the moment it exists.

Run `pnpm typecheck && pnpm lint && pnpm test && npm run test:e2e --`.
Then open the three screens in Chrome DevTools MCP or Playwright and read
every label, badge, toast and empty state as a member and as the merchant;
list anything that reads wrongly under Issues.

## Stage 5: JSDoc alignment

The code is right; now the prose that quotes a screen or a retired
identifier must match. Grep, in `src/lib/**/*.ts`, `src/routes/**/*.tsx`,
`src/components/**/*.tsx`, `scripts/**`, `test/**`, `e2e/**`, inside
comments only:

- `"In progress"` and `In progress` where a task is meant → Started.
- `Mine, Up next, In progress and Blocked` (the `RunStatus` JSDoc) → Mine,
  Up next, Teammates, Blocked, Recent; say Recent holds done and closed.
- `runTabs.ts` Teammates paragraph: half its reason was the badge; rewrite
  to "the tab is about who holds the work, so it says so".
- `readyWhere` / `readyTasks` / `undoBlockedBy` / `UndoBlocker` /
  `completeTask` / `uncompleteTask` / `unstartTask` / `attentionTask` /
  `WorkflowRun` and every other retired identifier in prose → the new
  name.
- "workflow run", "line item", "finished", "unclaimed", "reassign" in
  JSDoc and comments → the glossary word, except where the sentence is
  about the retired word itself (a Deviations-style note).
- "ready task" in the broad sense → "current task" (Stage 2 did the
  files it touched; sweep the rest).
- `RunStatus`'s gate table and `runIsBlocked`'s table: add one sentence to
  each saying `pnpm action-table check` does not read it, because it
  names the predicate per action rather than a truth value per state, and
  the action matrices pin each result it describes.
- `expand` in `action-table.ts`: its fixture table and prose use `current`
  and `reopenBlockedBy`.
- `AGENTS.md` action-table bullet: still true; add that the glossary's
  screen columns are checked against the label constants and that
  `rules-lint` refuses retired words in screen copy.

Each JSDoc that carries a rule keeps its reasoning inline and cites no
`docs/` path.

Run `pnpm typecheck && pnpm lint && pnpm test`.

## Stage 6: finish

- `pnpm fmt` repo-wide. Keep every file it touches.
- `pnpm typecheck && pnpm lint && pnpm test && npm run test:e2e --`.
- `pnpm action-table print` and read the output once.
- Delete `docs/action-table-spec-research.md`,
  `docs/action-table-spec-plan.md`, `docs/domain-language-research.md`,
  `docs/domain-language-plan.md`. Leave
  `docs/action-table-follow-ups-research.md` and this plan for the user to
  delete after review.
- Do not commit.

## Deviations and issues

The implementing LLM records here, as it goes, anything that departed from
this plan or needed a judgement call, with the reason. One bullet each,
under the stage it belongs to. The user reads this section first at
review. Things this plan expects to land here:

- Stage 0: anything already red.
- Stage 1: whether Stages 1 and 2 were done as one change; the copy
  worklist as found.
- Stage 2: whether `currentWhere` gained the run-status test or its JSDoc
  gained the caveat.
- Stage 3: identifiers with a retired root that stayed, and why; the
  `?tab=` bookmark break.
- Stage 4: denylist patterns narrowed for a false positive; the exact
  sentences chosen where this plan offers wording it
  is not sure of (quota banner, workflow-off note, cancel toast, the eight
  error sentences); how `routeTree.gen.ts` was regenerated; whether e2e
  read the constants; anything that read wrongly on screen.
- Stage 5: comments that keep a retired word because they are about it.

### Deviations

Stage 0

- Baseline green: typecheck, lint (warnings only), 471 tests.

Stage 1

- Stages 1 and 2 were done as one change: the glossary names `current`, so
  the rename went first and the glossary and constants landed on top of it.
- The glossary names `WORKFLOW_STATE_LABEL` in its opening paragraph beside
  the other three constants; the plan's text listed only three.
- `taskStateOf` reads `startedAt` before `current`, not after. On an open
  run the order does not matter (a started task is always current). On a
  closed run no task is current, and the old `RunSteps` badge showed a task
  someone had when the run closed as started; the plan's order would have
  dropped its badge. The JSDoc says so and a test pins it.
- `checkScreenColumns` takes the label values as a parameter
  (`ActionTable.ScreenLabels`) instead of importing `Domain`, so
  `scripts/lib/action-table.ts` stays types-only. `scripts/action-table.ts`
  and the test pass `Domain`'s constants. A table is found by the first
  line of the paragraph before it ("Task states.", "Run states:", ...).
- Copy worklist as found (before Stage 4): the "workflow run" sentences and
  "Mark done", "Cancel run", "Keep run", "Cancel this run?", the run
  toasts, "Start" on the picker, "line item(s)" (3), "Finish or cancel"
  (2), "finished" (3), "In progress" (3: `RunSteps`, the run list row line
  twice), `QuotaBanners`, `WorkflowSwitch` (2), `workflowShared` (4),
  `changeWarning`, `runTabs` Recent empty state, `app.teams.$teamId`
  "unclaimed", the editor's "This is what runs now." toast.

Stage 2

- `currentWhere` kept the step-only SQL; its JSDoc states that it does not
  test the run's status and names each caller's run test. Adding the test
  to the SQL would cost a `Run` lookup per task row on the run list's query,
  and every caller already joins or holds the run.
- Renamed with it: `RunRepository`'s `isReady` → `isCurrent`,
  `requireReadyTeam` → `requireCurrentTeam`, the `ReadyWhere` import alias
  → `CurrentWhere`, and locals named `ready` that held current tasks.
- `TaskNotReadyError` and the `NotReady` result tag keep their names; their
  JSDoc now says "not current". They are not in the rename table.
- Test titles and comments that used "ready" in the broad sense now say
  "current".

Stage 3

- `?tab=inProgress` and `?tab=attention` bookmarks no longer name a tab and
  fall back to the default (Mine).
- `OrderRow.attention` ("Needs a team") keeps its name: it is a different
  concept from the retired `attention` tab key.
- Identifiers with a retired-looking root that stay: `runIsUnstarted`
  ("no task has started", the Not started badge; not the Put back verb),
  the test fixture `unstartedRun`, and the bulk-operation names
  (`lastCompletedAt`, `completedBulkUrl`, `onWorkflowComplete`, ...), which
  are about Shopify's export, not tasks.
- The Recent row's menu id changed from `run-undo-<id>` to
  `run-reopen-<id>`.

Stage 4

- `routeTree.gen.ts` was regenerated by the running dev server's TanStack
  Router Vite plugin when the file was renamed; not hand-edited.
- The e2e specs import `@/lib/Domain` (it resolves; `members.spec.ts`
  already did) and read the constants for the labels this pass changed:
  merchant Done, Cancel workflow, Attach, the Started row line, On / Off.
  Labels that did not change (Ready, Reopen, Put back, Undo, ...) are still
  literals.
- Sentences chosen:
  - Attach at the limit: "N items are in production, the most Baton tracks
    at once. Cancel a workflow, or wait until an item is done or closed."
  - Quota banner: "Baton stopped attaching workflows because N items are in
    production. Cancel a workflow, or wait until an item is done or
    closed."
  - Workflow turned off toast: "Turned off. Items already on it keep
    going." (matches the Turn off dialog's sentence).
  - Cancel: heading "Cancel <workflow> on <item>?", body "Work on it stops.
    Steps already done stay on record. You can attach another workflow to
    the item afterwards." (`cancelHeading`, `CANCEL_WARNING`), buttons
    "Keep workflow" / "Cancel workflow", toast "<workflow> cancelled on
    <item>."
  - The eight "That workflow run …" sentences: `NotFound` and the three
    modal fallbacks → "That workflow is no longer on this item.";
    `NotAllowed` → "That item changed just now, so nothing was done.";
    `NotBlocked` → "That item is no longer blocked."; `Terminal` and the
    assign `RunNotOpen` → "That item's workflow is done or closed.";
    `Blocked` → "That item is blocked. Unblock it first."
  - Other run copy the plan did not list: the editor's apply toast "This is
    what runs now." → "New items get this version."; the start-date dialog
    "Runs start on orders placed …" → "It starts on orders placed …";
    `APPLY_BODY` "Runs already open keep …" → "Items already on it keep
    …"; `DELETE_WORKFLOW_WARNING` "Runs already on orders are kept." →
    "Items already on it keep their tasks."; `turnOnBody` "… with a line
    item tagged "x" will start a run of this workflow." → "… with an item
    tagged "x" will start this workflow on that item."; "No line items." →
    "No items."
  - "unclaimed" → "wait for a member until someone joins" (team page and
    the workflow attention line).
- Denylist (`scripts/rules-lint.ts`): `run` is matched only as a word not
  joined to an identifier or path (`run-actions-`, `shop-runs`, `$runId`),
  which removed the id and query-key false positives. It reads string
  literals, JSX text on one line, and plain-word lines inside JSX; comments,
  including block comments across lines, are skipped. `admin.*`, `api.*`,
  `index.tsx` and `privacy.tsx` routes are left out: the
  operator console, API routes and the public legal and marketing pages are
  not glossary screens (`privacy.tsx` says "line items" and "production
  runs" as legal description).

Stage 5

- "line item" stays where the prose is about Shopify's object as ingested:
  the bulk import stream (`ShopAgentOrdersStream`, `OrderSync`), the
  compliance webhook, `Domain`'s `LineItemProperty` (the Help Center's term)
  and truncation JSDoc, log and error messages, and the glossary's item row
  and the order page comment that discuss the term itself.
- "finish" stays as a plain verb about Shopify or the import ("Shopify has
  finished with the order", "the import finished") and in the glossary's
  Workflow states row as the plan wrote it.
- The `RunStatus` lifecycle quote ("What a merchant reads") said "A run is
  one item's trip through a workflow"; it now opens "An item goes through
  its workflow".

### Issues

- Stage 4 first e2e run: two failures. `workflows.spec.ts` still asserted
  the old Turn on and Turn off sentences (fixed). `member-runs` "a member
  starts and completes…" failed once and passed alone and in the re-run;
  treated as a flake. Final run: 65 passed.
- Screens read after Stage 4 (member Teammates tab, member work page,
  merchant order page with Manage open): the teammate row reads "Cut ·
  Started · <who>", the task badge reads Started on both pages, the
  merchant card reads "In progress" for the item with "Started" on its
  task, and the run row reads Block · Cancel workflow. Nothing read wrongly.
- Not checked on screen: the error sentences and toasts (they need a race
  or a refusal to show); they are covered by the Deviations list above.

### Review (2026-09-26, second LLM)

Checked the implementation against this plan. Typecheck, lint and 475
tests were green; the full e2e run was 64 of 65 with one magic-link
sign-in failure in `member-area.member.spec.ts` that has no label
assertion in it; the spec passed on its own straight after (5 of 5), so
it is a sign-in flake, not this work. No retired identifier and
no `docs/` path remained in any comment. Found and fixed:

- Two merchant strings still said run: the made-order banner "Every run
  is done." (now "Every item is done.") and the Turn on / Updated toast
  "Started N run(s) on waiting orders." (now "Attached to N item(s) on
  waiting orders."). Both got past the denylist, so the denylist was
  wrong, not the sweep: `run` was refused a following `.`, so a sentence
  ending in "run." passed; a template's `${...}` was blanked before its
  inner literals were read; JSX text on a line that also holds a `{...}`
  expression was not read. All three are closed. The copy reader moved to
  `scripts/lib/rules-lint.ts` (pure, like `scripts/lib/action-table.ts`)
  with `test/integration/rules-lint.test.ts` pinning the doctored lines.
  Known gap, recorded in its JSDoc: a JSX text line holding one bare word
  is not read, because a lone identifier on its own line looks the same.
- Three merchant labels were still literals: the Manage drawer's Assign
  team select and modal heading, and the Change modal's confirm button.
  They read `VERB_LABEL` now. Left as literals on purpose: the Block
  toast "Blocked" (a toast, not the state badge), the order page's
  "Closed" fact row (Shopify's `closedAt`), the orders index's Blocked
  need label (Decision 7 keeps that screen), and the Blocked tab label
  (a tab, not the state).
- "wait for a member until someone joins" said one thing twice; now
  "wait until a member joins" (team page and the workflow attention line).
- The glossary's task-states table said started derives from "current,
  `startedAt` set", but `taskStateOf` reads `startedAt` first (the Stage 1
  deviation). The row now says "`startedAt` set (current on an open run)"
  and the paragraph above it says why. The two meaning cells that said
  "finish" (run done, workflow off) and the task done row now use the
  glossary's own words.
- Comment prose still carried retired words the identifier grep could not
  see: "finished" for a task or run, "line item" for our item, "undo" and
  "completes" as the verb, "readiness" and "ready" in the broad sense,
  "running" for an open run, a task "in progress", and tab lists that
  left out Teammates or called Recent a tier. About 70 comments across
  `src/`, `test/` and `e2e/` were rewritten to the glossary words. Left
  alone: "finish" and "complete" about the import, bulk operations and
  billing; "line item" for Shopify's object, the import stream, the
  `lineItems` field and the `OrderLineItem` table; "Undo" naming the
  member's button; "attention" for the orders and workflows attention
  state, which is not the retired tab.

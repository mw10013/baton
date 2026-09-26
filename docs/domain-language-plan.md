# Domain language: implementation plan

For an implementing LLM. The decisions are in
`docs/domain-language-research.md` (Decisions section); this plan is how to
land them. Read that file's Proposed glossary before starting: every word
below comes from it.

## Ground rules

From `AGENTS.md`, restated because each one bites here:

- Do not commit. Do not branch. Work on `main`.
- No migrations. We are prototyping: edit the `create table` blocks in
  `src/lib/ShopAgent.ts` in place. The user resets every Durable Object and
  local database (see Reset point).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` after each stage. `pnpm fmt`
  repo-wide at the end and keep every file it touches.
- Rules stay on the symbol that owns them. Predicates, never inline
  comparisons (`scripts/rules-lint.ts` refuses them). A JSDoc never
  references `docs/`.
- Plain prose in JSDoc and comments. No flourishes.
- Log messages: `ShopAgent.<callable>: shop=<shop> ...`. When a callable is
  renamed, its log message and `callableEffect` name follow.
- Chrome DevTools MCP (`.mcp.json`, `chrome-devtools`) is available if
  seeing a page helps. `pnpm playwright-cli` is the other option. Wait for
  `body[data-hydrated="true"]` before clicking.

## Target vocabulary

The glossary block to write into `Domain.ts` (Stage 1) is the source of
truth. The renames it implies:

| today                                                               | after                                           | kind                      |
| ------------------------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| `WorkflowRun` (struct, type, SQLite table)                          | `Run`                                           | type, table               |
| `WorkflowRunTask` (struct, type, SQLite table)                      | `RunTask`                                       | type, table               |
| `WorkflowRunId`, `WorkflowRunTaskId`                                | `RunId`, `RunTaskId`                            | type                      |
| `WorkflowRunDetail`                                                 | `RunDetail`                                     | type                      |
| `WorkflowRunRepository`, its `.ts` and test                         | `RunRepository`                                 | service, file             |
| `WorkflowRun_*_idx` index names                                     | `Run_*_idx`                                     | index                     |
| `completedAt`, `completedBy`, `completedByEmail`, `completedByRole` | `doneAt`, `doneBy`, `doneByEmail`, `doneByRole` | column, field             |
| `taskCompletedBy`                                                   | `taskDoneBy`                                    | function                  |
| `RunStatus` literal `pending`                                       | removed; `active`, `done`, `closed` remain      | literal, check constraint |
| `runIsUnstarted(run)`                                               | `runIsUnstarted(tasks)`                         | function signature        |
| `TaskActions.reassign`                                              | `TaskActions.assign`                            | field                     |
| merchant page "Reassign" button                                     | "Assign team"                                   | label                     |

Not renamed, on purpose:

- `Workflow`, `WorkflowTask`, `WorkflowId`, `WorkflowRepository`: the
  definition side keeps its names.
- `completeTask` / `uncompleteTask` (repository), `merchantCompleteTask` /
  `merchantUncompleteTask` (callables), `CompleteTaskInput` /
  `UncompleteTaskInput`, `UncompleteTaskCommand`. "Done" is not a verb that
  takes an object. These name the write; their JSDoc says they set and clear
  `doneAt`. If you find this reads badly after the rename, record it under
  Deviations rather than inventing a third root.
- `AssignRunTaskTeamInput`, `AssignRunTaskTeamResult`,
  `merchantAssignRunTaskTeam`: already the right word.
- `blocked*` columns, `closedReason` values, `ProductionState`, `OrderNeed`,
  `ConnectionRole`.
- Screen labels other than the "Reassign" button. The task badge "In
  progress" → "Started" is decided but belongs to the UI pass; the glossary
  records it as the target.

## Stages

Do them in order. Each ends green on typecheck, lint and test.

### Stage 0: baseline

Run `pnpm typecheck && pnpm lint && pnpm test`. Record anything already
failing under Issues so it is not blamed on this work.

### Stage 1: glossary block

In `src/lib/Domain.ts`, directly below the module JSDoc (the block that
opens the file and ends before `import { Match, ... }`), add a second block
comment headed `Glossary`. Write it in the final words, that is, after the
renames, so it is right when the file is done. Content: the three tables
from the research's Proposed glossary (Nouns, Run states, Task states) and
the Verbs table, as JSDoc tables. Keep the research's columns: word,
meaning, symbol (or stored / derived from), screen. One sentence above the
tables: these are the words for code, JSDoc, research and screen; a symbol
named here is an export of this file.

Do not restate rules in the glossary. A row says what a word means and
where it lives; the rule stays on the symbol.

### Stage 2: rename the run types, tables and repository

Order matters because the names nest. Replace with word boundaries, longest
first, across `src/`, `test/`, `e2e/`, `scripts/`:

1. `WorkflowRunRepository` → `RunRepository` (87 occurrences)
2. `WorkflowRunTaskId` → `RunTaskId`
3. `WorkflowRunTask` → `RunTask` (68)
4. `WorkflowRunDetail` → `RunDetail` (11)
5. `WorkflowRunId` → `RunId`
6. `WorkflowRun` → `Run` (100; check each, since `Run` is a common word in
   prose and toast copy: only identifiers, SQL table names and index names
   change)

Then:

- `git mv src/lib/WorkflowRunRepository.ts src/lib/RunRepository.ts` and
  `git mv test/integration/workflow-run-repository.test.ts test/integration/run-repository.test.ts`.
  Fix imports.
- `src/lib/ShopAgent.ts`: the `create table` blocks for `WorkflowRun` and
  `WorkflowRunTask` become `Run` and `RunTask`; the index names
  `WorkflowRun_orderId_idx`, `WorkflowRun_status_idx`,
  `WorkflowRun_open_age_idx` and any `WorkflowRunTask_*` index become
  `Run_*` / `RunTask_*`. Every `sql\`` template in the repositories that
names the tables follows. `grep -rn "WorkflowRun" src test e2e scripts`
  must return nothing when this stage is done.
- Effect.fn names and `callableEffect` names that carried the old repository
  name (`"WorkflowRunRepository.getRun"` and so on) become
  `"RunRepository.getRun"`.
- Files touched (from the inventory): `src/lib/Domain.ts`, `ShopAgent.ts`,
  `WorkflowRepository.ts`, `WorkflowRunRepository.ts`, `OrderRepository.ts`,
  `readyWhere.ts`, `changeWarning.ts`; `src/components/RunTextModals.tsx`,
  `MemberRun.tsx`, `RunSteps.tsx`; `src/routes/app.orders.$orderId.tsx`,
  `shop.$shop.index.tsx`; `e2e/orders.spec.ts`,
  `e2e/member-runs.member.spec.ts`; the seven `test/integration/*.test.ts`
  files that import the types.

`pnpm typecheck` finds every missed identifier. SQL strings it does not:
grep for the old table names in every `sql\`` template before running the
tests.

### Stage 3: `completed*` → `done*`

Columns, struct fields, and the accessor. 136 occurrences of the four
column names across `src`, `test`, `e2e`.

- `RunTask` struct in `Domain.ts`: `completedAt` → `doneAt`, `completedBy`
  → `doneBy`, `completedByEmail` → `doneByEmail`, `completedByRole` →
  `doneByRole`. The `create table RunTask` block in `ShopAgent.ts` follows.
- `taskCompletedBy` → `taskDoneBy` (`Domain.ts`, `RunSteps.tsx`,
  `shop.$shop.index.tsx`).
- Every `sql\`` template that names the columns (`recomputeStatus`'s
`sum(completedAt is not null)`, the `readyWhere`clauses, the list
queries in`OrderRepository`, `WorkflowRepository`and`RunRepository`,
`OrdersBulkRepository`). Grep `completed`in`src/lib/*.ts` afterwards;
  what remains should be prose only, and Stage 6 handles prose.
- `taskActions` reads `task.completedAt`; `RunTaskView` picks it; tests
  build tasks with it. All follow the rename.

### Stage 4: drop `pending`

`RunStatus` becomes `Schema.Literals(["active", "done", "closed"])`. The
sites, all found by grep for `pending` in `src` and `test`:

- `ShopAgent.ts`: the check constraint
  `status in ('pending', 'active', 'done', 'closed')` and the partial index
  `where status in ('pending', 'active')`.
- `RunRepository.ts`: the insert that writes `'pending'` writes `'active'`;
  `recomputeStatus` loses its `else 'pending'` arm (the case becomes
  `when count(*) = sum(doneAt is not null) then 'done' else 'active'`);
  the `status in ('pending', 'active')` clauses (about fifteen across
  `OrderRepository.ts`, `WorkflowRepository.ts`, `RunRepository.ts`) become
  `status = 'active'`.
- `runIsOpen` becomes `run.status === "active"`.
- `runIsUnstarted` changes shape: it takes the run's tasks and is true when
  no task has `startedAt` or `doneAt` set. Its JSDoc keeps the reason
  (reconcile resizes such a run without the quantity badge). The one code
  reader is reconcile's `adjust` in `RunRepository.ts`, which today holds
  run rows only; load tasks for the open runs (`withTasks` already exists
  in that file) and call the predicate on them. The merchant page's
  `RUN_STATUS_BADGE` in `app.orders.$orderId.tsx` is keyed by status and
  loses its `pending` row; the "Not started" label stays, chosen by
  `Domain.runIsUnstarted(tasks)` on an `active` run, which the page has in
  hand (`lineItemState` carries `tasks`). Keep the badge's JSDoc reason
  (merchant words, not `status`).
- Tests: `test/integration/domain.test.ts`, `run-actions.test.ts`,
  `run-repository.test.ts`, `shop-agent-workflows.test.ts`,
  `order-repository.test.ts` build `pending` runs. Each becomes `active`
  with no task started, or asserts on `runIsUnstarted(tasks)` where it
  asserted on the status. The test titled "open is pending or active; ..."
  in `domain.test.ts` is retitled to the new rule ("open is active; done is
  the last task's Done; closed is ended by something else").
- E2E: `e2e/orders.spec.ts` asserts the "Not started" badge on a fresh run.
  It must still pass, which is the check that the badge survived.

### Stage 5: `reassign` → `assign`

- `TaskActions.reassign` → `TaskActions.assign` in `Domain.ts` (struct,
  `taskActions`, the JSDoc table's column header) and its reader in
  `ShopAgent.ts` (`({ reassign }) => reassign`).
- `app.orders.$orderId.tsx`: `REASSIGN_MODAL`, the `reassign` mutation and
  `assignable` filter follow (`ASSIGN_MODAL`, `assign`); the one button
  labelled "Reassign" becomes "Assign team" so all five buttons match.
- `e2e/orders.spec.ts` finds the button by name "Reassign" in four places;
  change to "Assign team". Since the combobox in the modal is also named
  "Assign team", scope the button locator to `getByRole("button", ...)`,
  which it already is.

### Stage 6: align the JSDoc

A planning step first, then edits. Do not rewrite prose that is right.

Plan: grep `src/lib` and `src/routes` and `src/components` for the old
words in comments: `completed` (the state), `pending`, `unstarted` as a
status, `reassign`, `WorkflowRun`, `Not started` as a task word, and `In
progress` where it means a task. List each hit with a one-line intended
edit before touching any. Record the list under Deviations if any hit needs
a judgement call.

Then edit, concisely:

- `RunStatus` JSDoc: the paragraph "`pending`, `active` and `done` are
  derived from the run's tasks" becomes `active` and `done`; the work-list
  sentence's example SQL becomes `status = 'active'`; the gate table's
  "reconcile resizes" row says "badge only if a task has started"
  (`runIsUnstarted`). Remove "pending" from the merchant's own paragraph if
  it appears.
- `Run` (was `WorkflowRun`) `quantityChangedFrom` JSDoc: rewrite the
  `pending` / `active` sentences in terms of `runIsUnstarted`.
- `RunTask` (was `WorkflowRunTask`) JSDoc: `completedBy` → `doneBy`,
  `taskCompletedBy` → `taskDoneBy`; "a reopened task reads Ready" stays.
- `taskActions` JSDoc: the state column says "task done" where it said
  "task completed"; the header says `assign`. Task state words are exactly
  waiting, ready, started, done.
- `runActions` JSDoc: unchanged unless it says `reassign`.
- `recomputeStatus` JSDoc in `RunRepository.ts`: two statuses derived, not
  three.
- `runIsUnstarted` JSDoc: new signature, same reason.
- `RUN_STATUS_BADGE` JSDoc: the "pending reads as waiting for approval"
  sentence now explains why an unstarted `active` run reads "Not started".
- Anywhere "completed" names the task state in prose (`readyWhere.ts`,
  `changeWarning.ts`, the routes), it becomes "done". Where "completed" is
  English for the act ("the task is completed by ...") leave it.

Rule: a JSDoc that states a rule keeps its reasoning; only the words change.
Do not add restatements. Do not add references to `docs/`.

### Stage 7: `AGENTS.md`

One bullet under the first list: the glossary at the top of
`src/lib/Domain.ts` is the vocabulary; use its words in code, JSDoc, tests
and research, and update it in the same change as any rename.

### Stage 8: verify

1. `pnpm typecheck && pnpm lint && pnpm test`.
2. `pnpm fmt`. Keep every file it touches.
3. `grep -rn "WorkflowRun\|completedAt\|completedBy\|'pending'\|\"pending\"\|reassign" src test e2e scripts`
   should return only: `merchantUncompleteTask` / `uncompleteTask` /
   `UncompleteTask*` / `completeTask` (kept on purpose), `isPending` from
   TanStack Query, and `pending` used for a Promise or a `WorkflowDraft`.
   Anything else is a miss.
4. Reset point, then E2E (below).

## Reset point

The schema changed (table names, column names, the status check
constraint), and there is no migration. Before any browser or E2E testing,
stop and tell the user, in one message:

> Schema changes are in. Please reset local state and restart the dev
> server: `pnpm d1:reset`, then `pnpm app:dev` in a fresh terminal, then
> `pnpm seed`. Tell me when it is up and I will run the E2E suite.

Do not run `pnpm d1:reset` yourself, and do not start or restart the dev
server yourself: the user owns both. Wait for their reply. Then run
`npm run test:e2e --` and, if a page needs looking at, use Chrome DevTools
MCP or `pnpm playwright-cli` against `http://localhost:$(pnpm port)`.

## Deviations and issues

The implementing LLM records here, as it goes, anything that departed from
this plan or needed a judgement call, with the reason. One bullet each. The
user reads this section first at review.

- Stage 0 baseline: typecheck, lint and 451 tests green. Lint prints three
  pre-existing warnings (`order-repository.test.ts`, `run-repository.test.ts`);
  none are from this work.
- Stage 2 renamed four symbols the table did not list, because they carry the
  `WorkflowRun` prefix and the stage requires the grep to come back empty:
  `WorkflowRunLimitError` → `RunLimitError`, `WorkflowRunRepositoryError` →
  `RunRepositoryError`, index `WorkflowRun_closed_idx` → `Run_closed_idx`,
  index `WorkflowRunTask_teamId_idx` → `RunTask_teamId_idx`. The prose
  "workflow-run reconciliation" in `OrderRepository.ts` became "run
  reconciliation".
- Stage 3 kept Shopify's `BulkOperation.completedAt` (`Domain.BulkOperation`,
  the GraphQL in `OrdersBulkRepository.ts`, `orders-sync-workflow.test.ts`).
  It is Shopify's field, not a task column. The Stage 8 grep still shows
  these five lines.
- Stage 4: reconcile's `adjust` now takes a `RunDetail`; the open-run check
  moved into the filter that picks which runs get their tasks loaded
  (`withTasks(runs.filter(Domain.runIsOpen))`). On the merchant page,
  `RUN_STATUS_BADGE` keeps one row per status; a new `NOT_STARTED_BADGE` and
  `runStatusBadge(run, tasks)` pick "Not started" for an open unstarted run.
  `runBadges` now takes the tasks.
- Stage 4 added the test "unstarted is no task started or done" in
  `domain.test.ts`, because `runIsUnstarted` states a rule and had no test of
  its own.
- Stage 4: the `ShopAgent.ts` schema comment said `startedAt` / `startedBy`
  "make the run `active` before anything is completed". That is no longer
  true, so it now says a run is `active` from creation and
  `Domain.runIsUnstarted` reads the tasks.
- Stage 5 went beyond the button label, since the modal the button opens
  said "Reassign": modal id `reassign-task` → `assign-task`, modal heading
  "Reassign <task>" → "Assign team: <task>", and the refusal copy "That task
  can no longer be reassigned." → "...assigned." The `reassigning` state
  became `assigning`. E2E locators follow.
- Stage 1 glossary: the Nouns row for `step` names "`WorkflowTask`,
  `RunTask` field" instead of the bare `step`, and the opening sentence says
  "an export of this file, or a field of one", because `step` is a field
  and not an export. The Verbs table has a one-line legend for "M" and "m".
- Stage 6 left "completed" where it names the act and not the state:
  `ShopAgent.seedOrders` comments, the test titles "pushes a completed task
  ..." (`member-runs-socket.test.ts`) and "a completed task lands on another
  member's run list ..." (`member-runs.member.spec.ts`), and the bulk import
  prose. "In progress" as a task label (`RunSteps.tsx`,
  `shop.$shop.index.tsx`, the `teams.ts` copy) is left for the UI pass.
- `completeTask` / `uncompleteTask` read fine after the rename. Their JSDoc
  now says they set and clear the Done slot (`doneAt`, `doneBy*`).
- Review found `ready` still carries its old broad sense in code: `readyWhere`,
  `readyTasks` and `RunTaskView.ready` are true for a started task, and the
  `RunStatus` and `taskActions` gate tables say "task ready, started". The
  glossary's narrower `ready` (step current, nobody has it) is the decided
  target; the screens already draw it that way. Renaming the broad concept
  (for example `currentTasks` / `currentWhere` / `current`) is deferred to the
  UI pass with "In progress" → "Started".

## Out of scope

- The task badge "In progress" → "Started" (UI pass).
- The glossary `check` script (lands with the action-table spec work in
  `docs/action-table-spec-research.md`; until then `pnpm typecheck` is the
  check).
- Any change to `Workflow` / `WorkflowTask` naming.
- Deleting `docs/domain-language-research.md` and this file: the user does
  that after review.

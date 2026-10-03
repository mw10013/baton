# Workflow storage and tag-indexed reads: implementation plan

This plan carries out the decisions in `docs/workflow-draft-storage-research.md` (2026-10-03,
five Plannotator passes). Read that doc first: "What exists today" is the four-table model this
plan removes, option D is the model it installs, "How each read becomes indexed" is the query
work, and Decisions lists every call made. Nothing here is open; where this plan had to choose
something the research did not, the choice is under "Decided at planning time".

Five phases. Phase 1 is small and independent and goes first because it simplifies the SQL every
later phase writes. Phase 2 is the storage change and is the bulk of the work. Phase 3 is the
tag-indexed reads and depends on phase 2's shapes. Phase 4 is the two screen changes and the
limits. Phase 5 is the record: vocabulary, data-model table, JSDoc. Each phase starts at the spec
row, then changes the code, then the pinned tests, and ends with a "done when". Run the checks
between phases; do not start phase 3 with phase 2 red.

## Before you start

- Read `AGENTS.md`, `docs/vocabulary-runbook.md`, and the JSDoc on `Workflow`, `WorkflowTask`,
  `WorkflowDraft`, `itemMatches`, `reconcileItem` (`src/lib/domain/ShopWork.ts`),
  `initializeSchema` (`src/lib/ShopAgentSchema.ts`), `ensureDraft`, `requireEditableTask`,
  `writeLayout`, `promoteDraft` (`src/lib/WorkflowRepository.ts`), `ITEM_MATCHES` and
  `MULTI_MATCH_ITEM` (`src/lib/OrderRepository.ts`), `eligibleContext` and `reconciler`
  (`src/lib/agent/ShopWork.ts`), and the module JSDoc on `WorkflowLayout.ts`. The rules that
  matter most here:
  - A structural change starts at the data-model row, then the DDL and the write paths, then the
    pinned test. `pnpm spec check` refuses a `pinned by` title no test carries and holds every
    vocabulary `stored` cell to a column or literal of `initializeSchema`. Expect it to fail after
    every spec edit until the code and the tests follow.
  - A rule is stated once and linked from everywhere else. This plan deletes the two-table
    mechanism; every JSDoc that explains it (the DDL comment on `WorkflowTask`, the "two tables"
    paragraph on `WorkflowTask`, `ensureDraft`, `requireEditableTask`, `writeLayout`) goes with
    it. A JSDoc that still explains a mechanism that no longer exists is a bug.
  - A JSDoc never cites a file under `docs/`. Carry the reasoning inline.
  - Identifiers, JSDoc and tests speak the vocabulary: the verbs on the order page are **Attach**
    and **Change workflow**, the control is the Workflow select, the second value is the
    **draft**. Never "picker", "version", "live", "saved".
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- The project is prototyping: there are no migrations for the object. The DDL change is made in
  line in `initializeSchema`, and you run `pnpm dev:reset` yourself afterwards. Phases 1 and 2
  change the DDL.
- After each phase run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`), `pnpm test`,
  `pnpm fmt`, and the e2e suites the phase names. Keep every file `pnpm fmt` touches.
- A test whose title is a `pinned by` cell this plan rewrites is rewritten with the row. A test
  that pinned a rule this plan deletes (the two draft rows about tables) is deleted. A test that
  fails for any other reason is a deviation: record it, do not delete it.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go.

## The decisions, by phase

| decision                                                                 | phase |
| ------------------------------------------------------------------------ | ----- |
| exact tag matching: trim at input, no lowercasing, `=` with no functions | 1     |
| `tasks` and `draftTasks` as JSON columns on `Workflow`; four tables go   | 2     |
| `position` is the array index, not stored                                | 2     |
| one `updatedAt`, no `WorkflowDraft` row, no `draftUpdatedAt`             | 2     |
| team pointer repair is a read-modify-write in code through the `Schema`  | 2     |
| task `Schema` runs on read and on write                                  | 2     |
| `RunTask` stays rows                                                     | 2     |
| run creation and reconcile find workflows by the order's tags            | 3     |
| `ITEM_MATCHES` inverted to start from the item's tags                    | 3     |
| Attach and Change workflow: matched workflows with tasks, the rest names | 3     |
| stored match count rejected; counts stay, no cache yet                   | 3     |
| workflows index pages and searches by name; badges per page              | 4     |
| `maxWorkflows` 1,000; `maxTasks` 20; `TaskInstructions` 500 with help    | 4     |
| vocabulary, data-model rows, JSDoc, record                               | 5     |

## Decided at planning time

Three things the research left to the plan.

1. **The create dialog's tag prefill.** Today the dialog prefills the tag from the name, folded to
   lowercase (e2e `workflows.spec.ts` expects `cake` from a name). With exact matching that fold
   is no longer a rule, but a lowercase, trimmed suggestion is still a good default for a string
   the merchant will type onto products. Keep the prefill as it is, in the route, as a suggestion;
   the `Schema` stops folding. The e2e expectation stands.
2. **The D1 read stays outside the transaction.** `reconciler` composes into each order upsert's
   transaction, and Durable Object SQLite refuses to nest, so the per-order workflow lookup runs
   as SQL inside `reconcileOrder` and the teams are still read from D1 once per webhook or
   stream, before any transaction, exactly as `eligibleContext` does now. `EligibleContext`
   becomes `teams` alone; the workflows are the repository's business.
3. **`WorkflowTask` keeps a `position` field in the decoded shape.** The stored document has no
   position; the decoder fills `position` from the array index on read so `stepsOf`, the editor,
   the member's rows and `RunTask`'s copy see the same field they do today. The `Schema` that
   encodes a list for storage drops it. Nothing above the repository changes its reading of a
   task.

## Phase 1: exact tag matching

### 1.1 The spec text

- `initializeSchema`, the `workflow` identity row: "a workflow is identified by its tag and by its
  name; no two workflows share either; the name is compared exactly, the tag trimmed and
  case-insensitively, as Shopify's admin treats tags" becomes "a workflow is identified by its
  tag and by its name; no two workflows share either; both are compared exactly, as Shopify
  stores a tag". `pinned by` drops the second title and keeps the first.
- `Domain.WorkflowTag` JSDoc: replace the "Trimmed and lowercased, unlike the names" paragraph
  with the reasoning: Shopify stores a product tag as typed and Flow compares it exactly; only the
  admin's search folds case, and a search box is not a match rule; Baton mints the tag and the
  merchant copies it, so a case typo on the product is the same failure as any other typo and
  shows as the order under Not started with the workflow in the select. Trim stays: a value Baton
  stores is clean when stored.
- `ITEM_MATCHES` JSDoc in `OrderRepository.ts`: delete the "two stated gaps" paragraph about
  `lower`, `trim` and Unicode; it no longer applies.
- The `match` row of the shop work vocabulary ("a product tag equals the workflow's tag") already
  says equals. No change.

### 1.2 The code

- `Domain.WorkflowTag`: decode is `s.trim()`; no `toLowerCase`.
- `Domain.matchesTag`: `item.productTags.some((tag) => workflow.tag === tag)`.
- `ITEM_MATCHES`: `where tag.value = w.tag`; no `lower`, no `trim`. (Phase 3 inverts this
  fragment; do the function removal now so phase 3 starts from clean SQL.)
- `WorkflowRepository.requireTagFree` JSDoc: drop "Tags are stored folded"; the comparison is
  exact.
- Any other `toLowerCase` on a tag under `src/`: `grep -rn "toLowerCase" src/lib src/routes`
  and judge each; the create dialog's prefill stays (planning decision 1).

### 1.3 The tests

- `data-model.test.ts`: delete "a workflow's tag matches an item's tag regardless of case and
  surrounding space". Add, under the identity row's title, a case that `Engraving` and
  `engraving` are two tags: a workflow tagged `engraving` does not match an item whose product
  carries only `Engraving`, and both tags may exist on two workflows.
- `domain.test.ts`: a `matchesTag` case for the same.
- `order-repository.test.ts`: the `ITEM_MATCHES` case for mixed case now expects no match.

### 1.4 Done when

`pnpm lint`, `pnpm spec check`, `pnpm test` pass; `grep -rn "lower(trim" src` finds nothing;
`npm run test:e2e -- workflows.spec.ts orders.spec.ts` pass.

## Phase 2: the task document

### 2.1 The spec text

On `initializeSchema`:

- The `step` row: "a workflow has zero or more steps, numbered from 1 with no gap; a step has one
  or more tasks, done in parallel; a task is in exactly one step; the draft obeys the same rule at
  every write" stays as the rule; `holds by` stays `app`; `pinned by` is rewritten to the new
  layout tests (2.3). Add to the row's sentence: "position is the task's place in its list, never
  stored".
- The two `draft` rows become one: "a workflow has at most one draft, the same shape as its tasks;
  Apply replaces the workflow's tasks with the draft's, whole, in one statement, and removes the
  draft; a run starting between two edits sees one definition; Apply refuses a draft with no tasks
  or an unassigned task, and the workflow keeps its tasks". `holds by` `app`. `pinned by`: the
  Apply titles that survive (2.3).
- The `workflow` delete row: "no history: a delete removes the workflow, its tasks and its draft,
  and nothing else" stays; `holds by` becomes `app` (there is no cascade left; the row is the
  workflow).
- The team pointer row: "a definition task's team points to a D1 row; dangling reads as null,
  which means unassigned; a team delete nulls it on every definition task, draft task and run
  task" stays; `pinned by` title stays; the test changes (2.3).
- The `run` snapshot row ("a run's tasks and steps are a snapshot of the definition's at
  creation") stays unchanged.
- The preamble's vocabulary paragraph gains a line: a JSON column holds a document decoded by its
  `Schema` on every read and write; a rule a document's shape makes impossible to violate (an
  array has no gaps) is stated and marked `app`, with its test through the write path.

The DDL comment block above `Workflow` replaces the "Tasks live in two tables rather than one with
a flag" paragraph with: why a document (read whole, written whole, at most `maxTasks` long, the
editor already transforms the whole list through `WorkflowLayout`), why two columns and not a
draft row (a second value of the same type that is one-or-none is a nullable field), and that
`position` is the index.

### 2.2 The code

**`src/lib/ShopAgentSchema.ts`.** `Workflow` gains `tasks text not null default '[]'` and
`draftTasks text` (nullable). Delete `WorkflowTask`, `WorkflowDraft`, `WorkflowDraftTask` and
their two indexes. The `Run`/`RunTask` DDL is unchanged except the comment that said "Nullable for
the same reason as WorkflowTask.teamId" now carries the reason itself (no FK across stores).

**`src/lib/domain/ShopWork.ts`.**

- `WorkflowTask` keeps its fields; `position` stays in the decoded shape (planning decision 3).
  Its JSDoc loses the "two tables" paragraph and gains: stored as one element of the workflow's
  `tasks` or `draftTasks` document, `position` being the element's index.
- New `WorkflowTasks`: the `Schema` for a stored list. Decodes a JSON string to
  `readonly WorkflowTask[]` filling `position` from the index; encodes by dropping `position`.
  Checks on decode: ids unique, `step` dense from 1 and non-decreasing along the array, length at
  most `WorkflowLimits.maxTasks`, each `name` a `TaskName`, each `instructions` a
  `TaskInstructions` or null. This is where `WorkflowLayout.layoutIsValid` is called, so the step
  rule has one enforcer.
- `WorkflowDraft`, `WorkflowDraftTask`, `WorkflowDraftTasks`, `WorkflowWithDraft`,
  `WorkflowDraftDetail` are deleted. `Workflow` is unchanged (the document columns are not part of
  the row shape screens read; they ride as `tasks` and `draftTasks` on the shapes below).
- `WorkflowDetail` stays `{ workflow, tasks }`; it is what run creation reads.
- `WorkflowPageData` becomes `{ workflow, tasks: TaskWithTeamName[], draftTasks: TaskWithTeamName[] | null, teams }`.
  `WorkflowSummaryRow` keeps `stepCount`.
- `DraftResult` carries `draftTasks` instead of a `WorkflowDraft`; `SeedWorkflowsInput` is
  unchanged (its `draft.tasks` already is a list).
- `TaskName`, `TaskInstructions`, `WorkflowLimits` unchanged in this phase.

**`src/lib/WorkflowRepository.ts`.** Rewrite around one helper and one-statement verbs:

- `readTasks(workflowId)` and `readDraftTasks(workflowId)`: select the column, decode with
  `WorkflowTasks`.
- `editDraft(workflowId, edit: (tasks) => tasks)`: in the caller's transaction,
  `update Workflow set draftTasks = coalesce(draftTasks, tasks) where id = ?`, read `draftTasks`,
  apply `edit`, encode, `update Workflow set draftTasks = ?, updatedAt = ?`. Every editor write
  (`addStep`, `addTask`, `updateTask`, `moveTask`, `separateTask`, `joinTask`, `removeTask`) is
  `editDraft` with a `WorkflowLayout` function or a map over the list. `addStep` and `addTask`
  mint the id and refuse past `maxTasks` before the write (the `Schema` would refuse too; the
  typed `WorkflowLimitError` lands the message under the field).
- Task-id writes find the task by id inside the draft list (after `coalesce`), so
  `requireEditableTask`, `findDraftTask`, `findWorkflowTask`, `ensureDraft`, `insertDraftTaskRow`,
  `layoutOf`, `writeLayout`, `relayout`, `insertTask` are deleted. `TaskNotFoundError` is raised
  when the id is not in the list.
- `getTask(taskId)` scans the shop's workflows for the id: `select id, tasks, draftTasks from
Workflow`, decode, find in `draftTasks ?? tasks`. Bounded by the workflow count; a map in code,
  not SQL. (If the editor can send `workflowId` with the task id, do that instead and note it as a
  deviation; the research did not decide it.)
- `createDraft`: `update Workflow set draftTasks = coalesce(draftTasks, tasks)`, return the
  decoded draft list.
- `applyDraft`: in one transaction, require the workflow, require `draftTasks is not null` (else
  `NoDraftError`), decode it, `requireEligibleTasks`, then
  `update Workflow set tasks = draftTasks, draftTasks = null, updatedAt = ? where id = ?`.
  `applyAndTurnOn` does the same when a draft exists, then the eligibility check on `tasks`, then
  `state = 'on'`, in one transaction. `promoteDraft` becomes that one statement.
- `discardDraft`: require a draft, `update Workflow set draftTasks = null, updatedAt = ?`.
- `getWorkflow`: one select; returns `{ workflow, tasks, draftTasks }`.
- `listWorkflows`: `select w.*, (select coalesce(max(json_extract(value, '$.step')), 0) from
json_each(w.tasks)) as stepCount from Workflow w order by name`, then badges from the decoded
  `tasks` per row as today. Phase 4 pages this.
- `listOnWorkflowDetails`: `select * from Workflow where state = 'on' order by name`, decode
  `tasks`. Phase 3 replaces it with the by-tags read; keep it in this phase so the agent compiles.
- `listTeamWorkflows`, `listAllTeamWorkflows`, `teamIdsInUse`: `json_each` over `tasks` and
  `draftTasks` with `json_extract(value, '$.teamId')`. Write them as SQL (they are reads, bounded
  by `W × T`).
- `unassignTeam`: in one transaction, `select id, tasks, draftTasks from Workflow where
exists (json_each ... teamId = ?) or exists (... draftTasks ...)`, decode, null the pointer in
  both lists, encode, update each row; then `update RunTask set teamId = null where teamId = ?`.
  The decision: through the `Schema`, not `json_set`.
- `duplicateWorkflow`: copy `tasks` with new ids (decode, map ids, encode) into the new row;
  `draftTasks` null.
- `replaceWorkflows` (seed): one insert per workflow with encoded `tasks` and optional
  `draftTasks`. The fixture validation stays.
- `deleteWorkflow`: `delete from Workflow where id = ?`.

**`src/lib/RunRepository.ts`.** The copy into `RunTask` reads `WorkflowDetail.tasks` as today;
`position` is the decoded field. No SQL change. The `Run.workflowId` snapshot comment is unchanged.

**`src/lib/agent/ShopWork.ts`, `src/lib/ShopAgentClient.ts`.** `readWorkflowPage` builds
`WorkflowPageData` from `{ workflow, tasks, draftTasks }` with team names joined on both lists;
`createDraft` returns `draftTasks`. Callables keep their names (`createDraft`, `applyDraft`,
`discardDraft`, `applyAndTurnOn`, the task writes).

**Routes.** `app.workflows.$workflowId_.edit.tsx` and `app.workflows.$workflowId.tsx` read
`detail.draftTasks ?? detail.tasks` where they read `draft?.tasks ?? tasks`; `hasDraft` is
`draftTasks !== null`; the "Last updated on" value is `workflow.updatedAt` (one date). The
header-state rules in the editor's JSDoc are unchanged. `WorkflowSteps.tsx` and
`workflowShared.ts` take the same task shape as before.

**`src/routes/api.dev.seed.ts`, `e2e/seed.ts`, `e2e/fixture.ts`.** No shape change; verify they
compile.

### 2.3 The tests

`test/integration/workflow-repository.test.ts` and `shop-agent-workflows.test.ts` are the bulk.
Rewrite, keeping each surviving title where its rule survives:

- Keep, as written: "apply replaces the workflow's tasks with the draft's, carries task ids over,
  and deletes the draft" (ids carry because the document is copied; the assertion stands), "an
  edit after turn-on still starts the workflow's tasks", "apply while on replaces them and earlier
  runs keep their copies", "apply refuses an empty draft and an unassigned task, on and off alike;
  an empty team does not refuse; the workflow keeps its tasks", "deleteWorkflow cascades its draft
  and tasks" (retitle: "deleteWorkflow removes the workflow with its tasks and its draft"),
  "turning a workflow off leaves its open runs open and deletes nothing", "a team delete nulls
  the team on every task; history keeps the name", "creates one run per matching item with copied
  tasks and team names".
- Rewrite the layout titles: "step is dense from 1 and non-decreasing along position, a step of
  one task being the linear case" and "add/move/remove keep positions dense and unique; edges are
  no-ops" now go through `editDraft` and assert on the decoded list; add "a stored list that
  violates the step rule is refused on decode" by writing a bad JSON string straight to the
  column and reading through the repository.
- Delete: "a workflow has at most one draft; the draft holds tasks only" (its mechanism is gone;
  the one-or-none is the nullable column) and any test that writes `WorkflowDraftTask` directly.
  Add "a draft is the draftTasks column: null until the first edit, a copy of the tasks at the
  first edit, null again after Apply and after Discard" as the new `pinned by` for the draft row.
- Add "the first editor write on a task the workflow holds creates the draft and edits the same
  task id" (the old `requireEditableTask` behaviour, now a property of the copy).
- `data-model.test.ts`: the identity row's test is unchanged; the `step` and `draft` row titles
  are the ones above.
- `domain.test.ts`: `WorkflowTasks` decode cases: fills `position` from the index; refuses a gap,
  a decrease, a duplicate id, a list past `maxTasks`.

### 2.4 Done when

`pnpm typecheck`, `pnpm lint`, `pnpm spec check`, `pnpm test` pass; `grep -rn "WorkflowDraftTask\|WorkflowDraft\b\|from WorkflowTask\|into WorkflowTask" src` finds only the
vocabulary row for `draft` (which names `draftTasks` after phase 5) and nothing else;
`pnpm dev:reset` runs; `npm run test:e2e -- workflows.spec.ts member-runs.member.spec.ts` pass;
the editor in the browser edits, applies and discards a draft on a seeded workflow.

## Phase 3: find workflows by tag

### 3.1 The spec text

- `Domain.itemMatches` JSDoc: add the rule "a workflow is found by its tag, never by scanning:
  every read that asks which workflows match an item starts from the item's product tags and
  probes `Workflow.tag`, which is unique", and the reason (the orders index counts and run
  creation ran per open item against every on workflow; at a thousand workflows that is millions
  of evaluations per order change). This is the one place the rule is stated; the SQL twin and the
  repository link it.
- `MULTI_MATCH_ITEM` JSDoc: say it restates `itemMatches` from the item side and links the rule.
- `EligibleContext` JSDoc (`ShopWork.ts`) and `eligibleContext` (`agent/ShopWork.ts`): the
  context is the D1 teams, read once per webhook or stream outside any transaction; the workflows
  are read per order, by tag, inside `reconcileOrder`'s transaction. Delete the "snapshot that a
  mid-stream team delete would not refresh" sentence about workflows; it still applies to teams,
  say so.
- `OrderPageData` JSDoc: `matchedWorkflows` (with tasks, what `lineItemState` reads matches from)
  and `otherWorkflows` (names only, the rest of the Workflow select's options).
- The sync pipeline table on `ShopAgentHost`: the reconcile column's "loads every on workflow
  once" wording, if present, becomes "reads the teams once, the workflows per order by tag".

### 3.2 The code

- `WorkflowRepository.listOnWorkflowsByTags({ tags })`: `select * from Workflow where state = 'on'
and tag in (select value from json_each(?))`, decode `tasks`, return `WorkflowDetail[]`. Delete
  `listOnWorkflowDetails`.
- `RunRepository.reconcileOrder({ teams, orderId })`: after reading the order's items, collect
  their product tags (a `Set`), call `listOnWorkflowsByTags` (the run repository takes the
  workflow repository as a dependency, or the agent passes a `workflowsByTags` function in the
  context; prefer the function, so the repositories stay independent), then proceed as today with
  `matchedWorkflows`. `reconcileAll` passes `teams` and the function.
- `agent/ShopWork.ts`: `eligibleContext` returns `{ teams, workflowsByTags }`; `reconciler` and
  `reconcileAllNow` are otherwise unchanged. `readOrderDetail`: `matchedWorkflows` =
  `listOnWorkflowsByTags` over the order's items' tags; `otherWorkflows` =
  `WorkflowRepository.listOnWorkflowNames()` (`select id, name from Workflow where state = 'on'
and json_array_length(tasks) > 0 order by name`) minus the matched ids.
- `OrderRepository.ITEM_MATCHES`: the inverted fragment from the research, exactly:

  ```sql
  (select count(distinct w.id)
   from json_each(li.productTags) tag
   join Workflow w on w.tag = tag.value
   where w.state = 'on'
     and json_array_length(w.tasks) > 0
     and not exists (
       select 1 from json_each(w.tasks) t
       where json_extract(t.value, '$.teamId') is null))
  ```

  `MULTI_MATCH_ITEM`, `MULTI_MATCH`, `multiMatchRows` and the counts statement are unchanged
  around it.

- `Domain.lineItemState(item, runs, matched, other, teams)`: `matched` are `WorkflowDetail[]`
  (eligibility still computed in code against `teams`); `options` are the matched workflows then
  `other`. The order page route passes both lists; the select renders names from both.
- `Domain.multiMatchItems` and the reconcile counts: unchanged in rule; they now receive the
  per-order matched list.

### 3.3 The tests

- `run-repository.test.ts`: "creates one run per matching item with copied tasks and team names"
  and the reconcile titles pass unchanged through the new signature. Add "reconcile reads only
  the workflows whose tag an item of the order carries": seed three on workflows, an order whose
  items carry one of the tags, and assert through a counting `workflowsByTags` stub that exactly
  one workflow was returned and a run was created for it.
- `order-repository.test.ts`: the multi-match cases pass unchanged; add "an item matches by its
  own tags: a workflow whose tag no item carries is never evaluated" (observable as: a thousand
  on workflows with other tags do not change the counts; assert the counts, and assert the
  statement's `explain query plan` names the `Workflow` autoindex on `tag` rather than a scan, if
  the test harness exposes `explain`; otherwise record as a deviation and pin by behaviour only).
- `shop-agent-orders-stream.test.ts`, `shop-agent-sync-order.test.ts`: compile against the new
  context; behaviour unchanged.
- `domain.test.ts`: `lineItemState` options are matched then other, with no duplicate.

### 3.4 Done when

`pnpm test` passes; `grep -rn "listOnWorkflowDetails" src test` finds nothing; on a seeded shop
the order page shows the matched workflows first in the Workflow select and every other on
workflow after the divider; `npm run test:e2e -- orders.spec.ts` passes.

## Phase 4: the two screens and the limits

### 4.1 The spec text

- `WorkflowLimits` (`Platform.ts`): `maxWorkflows: 1000`, `maxTasks: 20`; the JSDoc says the
  first is a guard against a runaway seed and not a product promise, and that every per-order
  read is independent of it since phase 3.
- `TaskInstructions`: cap 500; its JSDoc says what the field is for (a standing reminder for a
  step, the same for every item; the procedure lives in the shop's own documents) and that the
  field counts down to the cap like `RunNote`. Export `TASK_INSTRUCTIONS_MAX_LENGTH` beside
  `RUN_NOTE_MAX_LENGTH`.
- `Screen.ts` copy table: a row for the Instructions field's help text on the workflow editor,
  in the table's voice: "A short reminder for this step. Keep the full procedure in your bench
  book." (Check the tone list; adjust the words, not the job.)
- The Screens table (`Domain.ts`): the workflows index row is unchanged; its JSDoc in the route
  says it pages by name and searches by name, keyed `?q=` like the orders index.

### 4.2 The code

- `WorkflowRepository.listWorkflows({ teams, q, cursor, limit })`: `where name like ? || '%'`
  when `q` is set, ordered by name, keyset on `(name, id)`, `limit + 1` for the cursor, badges and
  `stepCount` for the page's rows only. Return `{ workflows, nextCursor, matches }` in the shape
  `listOrders` uses so the route can reuse the orders index's cursor and search handling
  (`searchParams.ts`).
- `app.workflows.index.tsx`: `validateSearch` gains `q` and `after`; the `s-search-field` already
  on the page drives `q`; a Next page control as on the orders index; the `state` filter stays.
- `app.workflows.$workflowId_.edit.tsx`: the Instructions `s-text-area` gets `maxLength` 500 and
  the count-down pattern used by the note field; help text from the copy row. No placeholder (the
  lint refuses one).
- Seeds: nothing exceeds the new caps; check `scripts/lib/seed.ts` fixtures for an instructions
  string over 500 characters and shorten it if found.

### 4.3 The tests

- `workflow-repository.test.ts`: "the workflows index pages by name and a search narrows it"
  (fifty-plus workflows, two pages, a prefix search).
- `domain.test.ts`: `TaskInstructions` refuses 501 characters and accepts 500.
- `e2e/workflows.spec.ts`: the index's search field finds a seeded workflow by prefix; the editor
  refuses a 501-character instruction and shows the count.

### 4.4 Done when

`pnpm test` passes; `npm run test:e2e -- workflows.spec.ts` passes; a seeded shop with sixty
workflows shows two pages on the workflows index.

## Phase 5: the vocabulary, the data model and the record

- Vocabulary (`ShopWork.ts` nouns table): the `draft` row's symbol becomes `Workflow` field
  `draftTasks` ("the workflow's edited copy of its tasks, from Edit until Apply or Discard; one or
  none" stays); the `step` row's symbol stays `WorkflowTask`, `RunTask` field; the `workflow` row's
  symbol becomes `Workflow`, `WorkflowTask` (unchanged). Run `pnpm vocab:audit` and read the
  output for words the change introduced (`document`, `probe`) that should not become identifiers
  outside the repository.
- `initializeSchema` preamble: the `about` column's note "a draft's about `draft`" stays; the
  table's rows are the phase 2 text; re-read every row's `pinned by` against `pnpm spec check`.
- Delete every JSDoc that explained the two tables or the shared-id convention; `grep -rn "two
tables\|shared id\|same id\|-position\|park" src/lib` and judge each hit.
- `docs/vocabulary-runbook.md` is unchanged unless a word was retired; none is in this plan.
- `README.md` or any plan copy that lists the tables: update if present.
- Run `pnpm spec print` and read the data-model rows once, end to end, for a sentence that no
  longer describes the code.

### Done when

`pnpm typecheck`, `pnpm lint`, `pnpm spec check`, `pnpm test`, `pnpm fmt` clean; the full
`npm run test:e2e --` passes; this doc's Deviations section is filled in.

## Deviations and issues

Record here, as you go, anything that did not go as the plan says. One entry per item, in this
form:

- **What the plan said.** The sentence or step, quoted or named.
- **What was found.** The fact that contradicted it, with the file and symbol.
- **The options.** The two or three ways to proceed that were considered.
- **What was done.** The one taken, and why in a sentence.
- **Follow-up.** Whether the research doc, a spec row or this plan needs a change afterwards, or
  nothing.

Known risks to watch for, which become entries if they bite:

1. **`getTask` without a workflow id.** Phase 2 scans the shop's workflows for a task id. If the
   editor can send `workflowId` alongside, do that; record which.
2. **Effect `Schema` for a JSON-string column.** `Schema.fromJsonString` with a transform that
   adds and drops `position`: confirm the decode error surfaces as `WorkflowRepositoryError`, as
   the other decoders do, and that `layoutIsValid` is called from the `Schema`, not beside it.
3. **`explain query plan` in tests.** Phase 3.3 wants proof the tag index serves the probe. If
   `@effect/sql-sqlite-do` in the test harness does not return `explain` rows, pin by behaviour
   and record it.
4. **The reconcile transaction.** `reconcileOrder` now runs a workflow read inside the upsert's
   transaction; that is one more statement per order on the webhook path and the bulk stream.
   If the stream's throughput test moves, record the numbers.
5. **Spec check and `json_extract`.** `pnpm spec check` holds `stored` cells to columns or
   literals of the DDL. No vocabulary row stores a task field, so none should break; if one does,
   the row names a column inside a document and the check needs a sentence, not a bypass.
6. **The e2e tag prefill.** Planning decision 1 keeps the lowercase prefill in the route. If the
   prefill was implemented through `Domain.WorkflowTag`'s decode, move it to the route.

### Recorded during implementation

Implemented 2026-10-03. `pnpm typecheck`, `pnpm lint` (with `pnpm spec check`), `pnpm test` (690)
and the full `npm run test:e2e --` (76) pass; `pnpm fmt` clean.

1. **`WorkflowTask` keeps its fields** (planning decision 3).
   - Found: the decoder cannot fill `workflowId` from the array; the `Schema` sees only the JSON
     text, and storing the id in every element duplicates the row's own id.
   - Options: store `workflowId` per element; fill it in the repository after decode; drop it.
   - Done: dropped. Nothing outside the repository read it; a task is inside its workflow's row.
   - Follow-up: none.
2. **`ITEM_MATCHES` inverted in phase 3.**
   - Found: phase 2 deletes `WorkflowTask`, which the old fragment read, so phase 2 could not
     compile the orders index without it.
   - Done: the phase 3 fragment went in with phase 2, exactly as written.
   - Follow-up: none.
3. **Risk 1, `getTask` without a workflow id.** The editor sends a task id alone. Kept the scan,
   but in SQL: `json_each(coalesce(draftTasks, tasks))` finds the workflow, and every task-id
   write uses it (`workflowIdOfTask`). Follow-up: none.
4. **Risk 2, the `Schema`.** `WorkflowTasks` is `fromJsonString(toEncoded(...))` decoded to
   `WorkflowTask[]`; `toEncoded` was needed so the encode side can drop `position` without
   re-branding. `layoutIsValid` is a filter on the `Schema`. ShopWork.ts imports it as
   `../WorkflowLayout.ts`, not `@/lib/...`, because `pnpm spec check` loads the domain files under
   plain Node without the alias. Decode errors surface as `WorkflowRepositoryError`.
5. **Risk 3, `explain query plan`.** The harness returns the rows. `ITEM_MATCHES` is exported so
   the test explains the fragment itself; the plan shows `SEARCH w USING INDEX` and no scan.
6. **Planning decision 2, `EligibleContext`.**
   - Done: `EligibleContext` is `teams` alone. `RunRepository` declares `ReconcileContext`
     (`teams` plus a `WorkflowsByTags` function); the agent maps `WorkflowRepositoryError` to
     `RunRepositoryError` in it. Pass rule 3 on `reconcileItem` was rewritten to say the teams are
     read once and the workflows per order by tag; its pinned title is unchanged (it tests the
     teams half). Tests share `test/integration/reconcile-context.ts`.
7. **The Workflow select's other options.** `OrderPageData.otherWorkflows` and
   `LineItemState.options` use a new `WorkflowNameRow` (`id`, `name`), since nothing else rides
   for a name-only option. `lineItemState` takes `(item, runs, matched, other, teams)`.
8. **The workflows index (phase 4.2).**
   - Keyset on the name alone, `?after=<name>`: names are unique, so `(name, id)` adds nothing.
   - Search is `Domain.prefixPatterns` (start of the name or of a word), the app's existing
     search reading, rather than `name like ? || '%'`.
   - A search ignores the state filter, as on the orders index, and the state buttons give way
     to "N workflows match <q>" and Clear search (`Control` "a search is on").
   - The read returns `WorkflowsIndexData` (the screen-data suffix) through a new
     `ListWorkflowsInput`; page size 50.
9. **The copy row (phase 4.1).** The copy table is one row per slot and `pnpm spec check` holds
   it to the `CopySlot` literals, so a row per field cannot be added; the `help` row already
   covers the job. The words changed: "Keep the full procedure in your bench book" is an
   instruction and a figure of speech. The help line is "Members see this at this step on every
   item. Up to 500 characters."
10. **The count-down (phase 4.2).** `maxLength` and the note's count-down cannot both hold: with
    `maxLength` Polaris draws its own `n/500` counter in the field from the first character.
    Kept `maxLength` (the field cannot exceed the cap, and the task panel has no field error to
    land a refusal in) and dropped Baton's count-down. The departure from `noteCountFrom` is
    stated on `INSTRUCTIONS_HELP` in the editor. The e2e test checks the field stops at 500.
11. **`createDraft` does not move `updatedAt`.** It changes nothing visible; every editor write
    does move it.
12. **`unassignTeam`** may now fail with `WorkflowRepositoryError` (it decodes and encodes the
    documents); its type says so.
13. **Spec tables.** The draft rows' and delete row's `pinned by` titles changed with the rows;
    `spec.test.ts` doctors the delete title and was updated. Three JSDoc tables whose rows changed
    were re-aligned (whitespace only).
14. **Risk 4, throughput.** No stream throughput test exists to compare against; nothing was
    measured.
15. **`pnpm dev:reset`.** The first seed after the reset failed with "A call to
    blockConcurrencyWhile() in a Durable Object waited for too long" right after the install; a
    second `pnpm seed` succeeded and the e2e suites ran on it. Not investigated; recorded in
    case it recurs.

### Recorded at review, 2026-10-03

A second pass read the implementation against this plan. Three bugs, one design slip and a few
unrecorded departures; all fixed in the same working tree.

16. **The Workflow select's order** (phase 3.2 said "matched then other"). `lineItemState` lists
    the item's own matches, then the order's other tag-found workflows, then `otherWorkflows`,
    each once; its JSDoc and `domain.test.ts` state it. A refinement, kept.
17. **Encode did not hold array order.** `layoutIsValid` sorted by `position` before checking,
    and encode drops `position` and stores the array as given, so a list out of position order
    was written and failed every later decode. No caller sent one. The rule is now array order:
    `position` is `1..n` in list order, checked without a sort. Pinned by the layout test's new
    out-of-order case.
18. **`getTask` turned every failure into "not found"** through `Effect.option`, which swallows a
    `SqlError` too. Now `catchTag("TaskNotFoundError")` alone.
19. **`ITEM_MATCHES` counted tag–workflow pairs**, so a tag listed twice on one item counted one
    workflow twice; the fragment this plan and the research doc gave had the same edge. Now
    `count(distinct w.id)`, both docs corrected, and the multi-match test has a duplicate-tag item.
20. **`ShopWork.ts` imported `../WorkflowLayout.ts`** (item 4). The map says shop work imports
    orders and platform only, and the lint checked imports into `lib/domain/` but never out of it.
    `layoutIsValid`, the step rule, now lives in `ShopWork.ts` beside `WorkflowTasks`, which is
    where the rule's one statement belongs; `WorkflowLayout.ts` keeps the arithmetic and imports
    nothing from the domain at runtime. `contextImportHits` now refuses a context file importing
    any module under `src/` outside `lib/domain/`, with a test.
21. **The step title was not moved** (phase 2.3). "step is dense from 1 and non-decreasing along
    position, a step of one task being the linear case" now goes through `editDraft` in
    `workflow-repository.test.ts`; the pure layout test keeps its own title ("layoutIsValid
    rejects ..."), and the step row's `pinned by` names both.
22. **Test gaps.** The index paging test now exercises the state filter under a search; a new
    test reads the query plan of `listOnWorkflowsByTags` (statement exported as
    `ON_WORKFLOWS_BY_TAGS`) and asserts the tag index is searched, not scanned.
23. **Stale JSDoc.** The duplicate form said `Domain.WorkflowTag` lowercases; `ListWorkflowsInput`
    said `q` goes through `searchTerm`; the index component said "filterable list"; the `search`
    vocabulary row did not name a workflow's name. `workflowShared.ts` said Apply is the only
    writer of `Workflow.tasks` (a team delete and Duplicate also write it); predates this plan.
24. **Phase 4.4's sixty-workflow browser check** was not done; the seed has about fifteen
    workflows. The 56-workflow repository test covers the paging.
25. **"picker" retired.** It was never a vocabulary word; the controls table calls the control a
    select. It appeared about fifty times in JSDoc, comments and e2e as an informal synonym (team
    picker, shop picker, add-members picker). Every one now names the control (the Workflow
    select, the Assign team select, the Add members dialog, Your stores); `workflowPicker` became
    `workflowSelect`; the stem is on `RETIRED` and `RESERVED_STEMS` with a test each. "App
    Bridge's Picker API" stays, as a product name.
26. **Item 15 did not recur** on a clean `pnpm dev:reset` today.
27. **The "uncaught exception" lines in `pnpm test`.** Nine lines of workerd stderr, no failed
    test. Three came from `shop-agent-usage-flush.test.ts`, where a call meant to fail went
    through the Durable Object RPC stub: workerd prints a rejection that crosses its RPC boundary
    as "Uncaught (in promise)" even when the caller handles it (a probe showed the same call on
    the object itself prints nothing, and a call to a method the stub lacks prints the same way).
    Those two calls now go through `runInDurableObject`. One more, in `shopify-webhook.test.ts`,
    is the Worker's webhook route calling the object through the stub as production does, with
    the Admin API unstubbed; it cannot be a direct call and is documented on the test. The other
    five are miniflare's Workflows
    engine reporting an errored instance across its own RPC boundary, documented on the test in
    `orders-sync-workflow.test.ts`; this miniflare build has no stdio hook to filter them, so they
    stay until upstream changes.

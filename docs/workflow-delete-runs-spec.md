# Workflow delete keeps runs; run reassignment — spec

Spec date: 2026-09-06. Status: **ready to implement.** Supersedes principle 2 and the "Workflows" section of `delete-model-spec.md`. Rationale is in `workflow-delete-runs-research.md`; this doc says what to build. Written for an implementer with only this repo and `CLAUDE.md`. Code state: `af1bc41`.

## Decisions (mw, 2026-09-06)

1. **Deleting a workflow deletes the definition only.** Steps, draft, and draft steps go (FK cascade). Every run, open and finished, item and order scope, stays untouched and keeps working.
2. **The delete dialog says nothing about runs.** Plain confirm.
3. **Run counts leave the workflow list and detail.** No "Active runs" column, no `openRuns` / `finishedRuns` anywhere.
4. **Any open run step can be reassigned to a team**, started or not. A finished step never is (`StepFinished` stays).
5. **The order page's empty-team warning links to the team page.**
6. Runs stay immutable in shape: no add, remove, reorder, rename, or instruction edits on run steps. Unchanged, restated so nobody adds it.

Merchant model, one sentence each (goes into the `Domain.Workflow` JSDoc):

- Delete a workflow and its runs stay on their orders; open ones finish.
- Turn off stops new runs; open ones finish.
- Any open step on a run can be assigned to another team; a finished step is history.
- Deleting configuration never deletes work.

## Why runs survive (for the JSDocs)

`WorkflowRun` has no foreign key to `Workflow` and snapshots `workflowName`; `WorkflowRunStep` snapshots `name`, `stage`, `position`, `instructions`, `teamName`, `startedByEmail`, `completedByEmail`. No read joins a run to `Workflow`; the queue, order page, orders index, sync, attach, and every step write address run rows by id. An orphan run (its `workflowId` names no row) renders, queues, starts, completes, blocks, and cancels as before. `WorkflowRun.workflowId` remains `not null` because it is still the conflict key of `unique (lineItemId, workflowId)` and `WorkflowRun_order_uidx`, and `startOrderRun` looks the order run up by it.

## Changes

### 1. `WorkflowRepository.deleteWorkflow` (`src/lib/WorkflowRepository.ts:787`)

Remove the two run statements. Keep the transaction and `requireWorkflow`:

```ts
deleteWorkflow: Effect.fn("WorkflowRepository.deleteWorkflow")(function* ({ workflowId }) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* requireWorkflow(workflowId);
      yield* sql`delete from Workflow where id = ${workflowId}`;
    }),
  );
}),
```

JSDoc on the interface entry: the definition, its steps, its draft, and its draft steps go; runs stay because they snapshot everything they show and nothing reads back through `workflowId`.

### 2. Run counts go

- `Domain.ts`: delete `WorkflowDeleteCounts` (`:588`); drop `...WorkflowDeleteCounts.fields` from `WorkflowSummary` (`:604`); drop `runCounts` from `WorkflowDetailView` (`:659`).
- `WorkflowRepository.ts`: delete `countRuns` from the interface (`:140`) and implementation (`:765`); remove the `openRuns` / `finishedRuns` correlated subqueries and the matching schema fields from `listWorkflows` (`:726`–`:739`).
- `ShopAgent.getWorkflowDetail` (`:1444`, `:1472`): drop the `countRuns` read and the `runCounts` field.
- `app.workflows.index.tsx`: delete `plural` and `deleteWorkflowWarning` (`:64`–`:82`); remove the "Active runs" header (`:296`) and cell (`:229`); the confirm row's body (`:251`) becomes the fixed sentence below; the empty-state / help copy at `:446` ("it and its runs go with it") is rewritten.
- `app.workflows.$workflowId.tsx`: the confirm banner body (`:985`) becomes the fixed sentence; delete the hint at `:1058`–`:1061` ("Turn off to stop new runs and let open ones finish. Delete removes its runs too.") and replace with "Turn off stops new runs; open ones finish." shown only while active, as today; the JSDoc at `:341` loses "and its runs go with it".

Confirm dialog body, both surfaces: **"This can't be undone."** Heading stays `Delete <name>?`.

### 3. Reassign any open step

Back end already conforms: `WorkflowRunRepository.assignRunStepTeam` (`:1333`) refuses only `completedAt !== null`; `ShopAgent.assignRunStepTeam` (`:2363`) adds `TeamNotFound`. No code change. Rewrite both JSDocs and the `StepFinished` comments (`WorkflowRunRepository.ts:43`, `Domain.ts:933`) to say: any open step, started or not, can be reassigned; only `teamId` / `teamName` change, so `startedBy*` stays and history keeps the starter; a finished step is refused because the write would overwrite `teamName`, the record of who completed it.

UI, `app.orders.$orderId.tsx`, `stepTrail` (`:140`):

- Today the picker renders only for `unassigned` steps (`:206`). Render it for **every open step of an open run** (`run.status` pending or active, `step.completedAt === null`).
- Unassigned step: unchanged. Critical "Unassigned" badge, line "`<step>`: assign a team." with the picker.
- Assigned open step: the `(TeamName)` text stays in the trail; below the trail, one compact row per open step: "`<step>` · `<TeamName>`" with the same picker and an **Assign** button. Keep the picker's current value empty (placeholder "Assign team") so the button stays disabled until a different team is chosen; if the merchant picks the current team, the write is a harmless no-op and still returns `Assigned`.
- Started step: no special casing. The trail already shows `stepMark` for started; leave it.
- Finished step: no picker, as today.
- `assignChoice` / `assignMutation` (`:274`, `:339`) already key by `runStepId`; no change.

To keep the order page from growing a row per step on every run, put the assigned-step rows behind a small disclosure ("Reassign") per run, closed by default. Unassigned steps stay outside the disclosure, always visible, because they are the attention state.

### 4. Empty-team warning links to the team

`stepTrail` (`:216`–`:220`): `emptyTeams` currently collects names. Collect `{ id, name }` from the roster instead and render each as `<s-link href={`/app/teams/${id}`}>{name}</s-link>` inside the sentence: "No members on **X**. Nobody can work this until someone joins, or you assign another team." The second clause is new and points at the picker from change 3.

### 5. JSDoc and copy rewrites

- `Domain.Workflow` vocabulary (`Domain.ts:503`–`:509`): replace the "delete a workflow and its runs go with it" paragraph with the merchant model above.
- Schema JSDoc in `ShopAgent.ts:156`–`:159` ("a delete removes the definition, its draft, and every run it ever started"): a delete removes the definition and its draft; runs stay because they are self-sufficient.
- `ShopAgent.removeWorkflow` JSDoc (`:1657`): still publishes, because the workflows list and any order page's attach picker (which lists workflows) repaint. Drop "every order page showing one of the deleted runs must repaint".
- `delete-model-spec.md`: add a one-line note at the top of the Workflows section pointing here. Do not rewrite it.

### 6. Tests

`test/integration`:

- `workflow-run-repository.test.ts:2194` "deleteWorkflow removes its runs and run steps…" → **"deleteWorkflow leaves its runs and run steps, open and finished; the queue, order view, start, complete, block, and cancel still work on them"**. After delete: `listQueue` for the step's team still returns the open step; `listRunsForOrder` returns both runs with `workflowName` intact; `startStep` / `completeStep` succeed; a finished run reads unchanged.
- `workflow-run-repository.test.ts:2115` "listWorkflows reports openRuns…" and the `countRuns` assertions at `:2218`, `:2237`: delete.
- `shop-agent-workflows.test.ts:244`, `:548`, `:550`: drop the `runCounts` / `openRuns` assertions.
- `shop-agent-workflows.test.ts:827`: extend: after `startStep` by a member of team B, `assignRunStepTeam` to team C returns `Assigned`; the step appears in C's queue still marked started with the original `startedByEmail`; a C member completes it; `completedByEmail` is the C member.
- New: attach a workflow to a line item, delete the workflow, attach a **new** workflow to the same item → both runs exist on the order (different `workflowId`), the orphan untouched.
- New: delete the active order workflow with an open order run → the run stays; a new order workflow can be created and turned on; `startOrderRun` for a later order uses the new one.

e2e: `e2e/*.spec.ts` has no assertions on run counts or delete copy today (grep `Open runs`, `runs go with`, `finished run` returns nothing), so only a smoke check that the workflows table renders without the column.

### 7. Order of work

1. Change 1 and the repository test inversion. `pnpm test`.
2. Change 2 top to bottom (Domain → repository → agent → routes), typecheck as you go.
3. Change 5 JSDocs.
4. Change 3 UI, then change 4.
5. Remaining tests, `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep every file it touches).

No schema change, no migration, no seed change.

## Out of scope

- A "runs of deleted workflows" listing. Runs are found through orders, as today.
- Bulk reassignment across runs. Per-step only.
- Un-start on a run step.
- Any change to Turn off, Apply, Cancel, or the sync.

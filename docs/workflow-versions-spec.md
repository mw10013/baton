# Workflow versions: draft, apply, on/off — spec

Spec date: 2026-09-05. Follows the Shopify Flow model observed live on 2026-09-05 (see the "Flow Versioning Model" research artifact and `refs/flow-manual/manage/version-history.md`). Builds on `workflow-stages-spec.md` (stages, step actions) and `workflow-runs-spec.md` (runs).

Written to be handed to an implementer with no other context than this repo. Where this spec and the code disagree, the code's existing conventions win and the spec should be amended. Back-end code follows Effect v4 idioms as already used in `src/lib/WorkflowRepository.ts` and `src/lib/ShopAgent.ts`: `Context.Service` repositories, `Effect.fn` named operations, `Schema.TaggedError` failures, `sql.withTransaction` for multi-statement writes, results crossing the socket as tagged unions.

## Problem

`Workflow` and `WorkflowStep` are edited in place, and routing (`WorkflowRepository.listActiveWorkflowDetails` → `WorkflowRunRepository.reconcileOrder`) reads the same rows the editor writes. A merchant adding three steps is live after the first one: an order arriving between edits gets a run with one step, correct by construction and wrong in fact.

Shopify Flow avoids this without locking. The thing routing reads (the **saved version**) is a different row from the thing the editor writes (the **draft version**). The first edit to a saved version forks a draft; **Apply** promotes the draft in one statement; **Discard** deletes it. Saved versions are immutable forever, so a run's lineage is a foreign key rather than a copy. Separately, a workflow has an explicit **on/off switch** that is not a version event.

## Goals / non-goals

- **Goals.** (1) Every step or tag edit lands on a draft, never on what routes. (2) Apply is atomic: an order sees the old saved version or the new one, never a half-edit. (3) A workflow has an explicit Active / Off switch, separate from Archived. (4) A run records which version it was copied from. (5) The list and detail pages make "draft pending" and "off" visible.
- **Non-goals.** A version-history table in the UI, diffing two versions, reverting to an old version, test mode with simulated orders, cancelling open runs when a workflow is turned off, import/export/duplicate. Retired versions are _kept_ so all of these stay cheap later.
- **No migration.** The app is a prototype. Schema changes edit `initializeSchema` in `src/lib/ShopAgent.ts` in place. Local Durable Object state is wiped (`rm -rf .wrangler` or the existing reset flow) and reseeded with `pnpm seed`.

## Vocabulary

| Concept                                       | Merchant copy                 | Code                                 |
| --------------------------------------------- | ----------------------------- | ------------------------------------ |
| The version routing reads                     | "Live"                        | `Workflow.savedVersionId`            |
| The version the editor writes                 | "Draft"                       | `Workflow.draftVersionId`            |
| A version that was live and has been replaced | not shown                     | `WorkflowVersion.retiredAt` not null |
| Promote draft to live                         | "Apply changes"               | `applyDraft`                         |
| Delete the draft                              | "Discard changes"             | `discardDraft`                       |
| Whether the workflow routes at all            | "Active" / "Off"              | `Workflow.active`                    |
| Hidden from the list, name still reserved     | "Archived"                    | `Workflow.archivedAt` (unchanged)    |
| The version a run's steps were copied from    | "from version applied <date>" | `WorkflowRun.versionId`              |

## Rules (normative)

### Ownership

```text
Workflow         identity: id, name, scope, active, archivedAt, savedVersionId, draftVersionId
WorkflowVersion  content:  tags, steps (via WorkflowStep.versionId), appliedAt, retiredAt
WorkflowStep     belongs to a version, never directly to a workflow
```

`name` and `scope` stay on the workflow. A rename is immediate and cosmetic (runs snapshot `workflowName` already). `tags` move to the version: tags select line items, so a tag change is a routing change and must go through Apply.

### Version invariants

```text
a workflow has at most one draft   (draftVersionId is null or points at a version with appliedAt null)
a workflow has at most one live    (savedVersionId is null or points at a version with appliedAt not null and retiredAt null)
every other version of the workflow is retired (appliedAt not null and retiredAt not null)
a version with appliedAt not null is never written again (steps, tags)
```

A freshly created workflow has `savedVersionId = null` and a draft with no steps. It is not routable until first Apply.

### Fork on first edit

Every write that targets a step or a version's tags first resolves the draft:

```text
ensureDraft(workflowId):
  if draftVersionId not null       → that version
  else if savedVersionId is null   → programming error (a workflow always has one of the two)
  else                             → in one transaction:
                                       insert WorkflowVersion (id = new uuid, tags = saved.tags, appliedAt null, retiredAt null)
                                       copy every WorkflowStep of saved into it with NEW step ids, same position/stage/name/teamId/instructions
                                       set Workflow.draftVersionId, updatedAt
```

Step-id based writes (`updateStep`, `moveStep`, `separateStep`, `removeStep`) may arrive carrying a _saved_ step id, because the editor showed the live steps when no draft existed. Resolution: look up the step, find its version; if that version is the workflow's saved version, `ensureDraft`, then continue with the draft step at the same `position`. `unique (versionId, position)` makes that mapping exact. If the step's version is retired, fail `StepNotFoundError`.

### Apply

```text
applyDraft(workflowId), one transaction:
  draft must exist                                      else NoDraft
  draft.steps.length > 0                                else NoSteps
  every draft step's teamId in activeTeams              else TeamNotActive
  scope = 'order' ⇒ draft.tags is empty                  (repository invariant, WorkflowRepositoryError)
  now = clock
  update WorkflowVersion set retiredAt = now where id = savedVersionId      (if any)
  update WorkflowVersion set appliedAt = now where id = draftVersionId
  update Workflow set savedVersionId = draftVersionId, draftVersionId = null, updatedAt = now
```

Apply does not touch `active`. Applying on an active workflow means the next order routes against the new version; the UI confirms that case with a dialog. Applying on an off workflow is silent.

### Discard

```text
discardDraft(workflowId), one transaction:
  draft must exist                    else NoDraft
  savedVersionId must not be null     else NoSavedVersion  (a never-applied workflow has nothing to fall back to; the UI hides Discard)
  delete from WorkflowVersion where id = draftVersionId   (steps cascade)
  update Workflow set draftVersionId = null, updatedAt = now
```

### On / off

```text
setWorkflowActive(workflowId, true):
  archivedAt is null                                    else Archived
  savedVersionId not null                               else NoSavedVersion
  saved version has ≥ 1 step                            else NoSteps
  every saved step's teamId in activeTeams              else TeamNotActive
  scope = 'order' ⇒ no other non-archived active order workflow   else OrderWorkflowExists
  set active = 1

setWorkflowActive(workflowId, false):
  set active = 0. Open runs are untouched (Baton runs are days of physical work; Flow cancels because its runs are seconds).
```

`active` is stored, never derived. Turning a workflow on or off does not create, retire, or apply a version.

### Archive

Unchanged semantics plus one guard: archiving requires `active = 0` (mirrors Flow, where only inactive workflows can be deleted). The UI disables Archive while active with the hint "Turn off first". Restore leaves `active = 0`; the merchant turns it on deliberately.

The one-order-workflow slot rule now reads: at most one **non-archived** order workflow (unchanged), and separately at most one **active** order workflow (enforced by `setWorkflowActive`). Both are needed because an off order workflow still occupies the name and the slot.

### Routability

Replaces `isRoutable` in `src/lib/WorkflowRunRepository.ts`:

```text
routable(detail) = workflow.archivedAt is null
               and workflow.active
               and detail.version is the saved version (never a draft)
               and detail.steps.length > 0
               and every step.teamId in activeTeams
```

`listActiveWorkflowDetails` returns only workflows with `archivedAt is null and active = 1 and savedVersionId is not null`, each with its saved version and that version's steps. Drafts are invisible to routing by construction.

The age rule `order.processedAt >= workflow.createdAt` in `matchesLineItem` and `startOrderRunIfReady` stays on `workflow.createdAt`. It exists to stop a bulk backfill from routing history; a re-apply must not stop routing orders that arrived while the draft was being written.

### Runs

`insertRun` copies steps from `detail.steps` as today and additionally writes `versionId = detail.version.id`. Nothing else about runs changes. `WorkflowRun.versionId` has no foreign key (a run outlives everything), same as `workflowId`.

### Team archive guard

`countStepsOwnedBy` / `listStepsOwnedBy` count steps of **live and draft** versions only (`retiredAt is null`). A team referenced only by retired versions is history and must not block `archiveTeam`.

## Schema

Replace the `Workflow` / `WorkflowStep` block in `initializeSchema` and add `versionId` to `WorkflowRun`. Keep the surrounding JSDoc's reasoning and extend it with the version invariants above.

```sql
create table if not exists Workflow (
  id text primary key,
  name text not null check (name = trim(name) and length(name) > 0),
  scope text not null default 'item' check (scope in ('item', 'order')),
  active integer not null default 0 check (active in (0, 1)),
  savedVersionId text,
  draftVersionId text,
  createdAt integer not null,
  updatedAt integer not null,
  archivedAt integer,
  check (savedVersionId is not null or draftVersionId is not null),
  check (active = 0 or savedVersionId is not null)
);
create unique index if not exists Workflow_name_uidx on Workflow (name collate nocase);

create table if not exists WorkflowVersion (
  id text primary key,
  workflowId text not null references Workflow (id) on delete cascade,
  tags text not null,
  createdAt integer not null,
  appliedAt integer,
  retiredAt integer,
  check (retiredAt is null or appliedAt is not null)
);
create index if not exists WorkflowVersion_workflowId_idx on WorkflowVersion (workflowId);

create table if not exists WorkflowStep (
  id text primary key,
  versionId text not null references WorkflowVersion (id) on delete cascade,
  position integer not null,
  stage integer not null,
  name text not null check (name = trim(name) and length(name) > 0),
  teamId text not null,
  instructions text,
  createdAt integer not null,
  unique (versionId, position)
);
create index if not exists WorkflowStep_teamId_idx on WorkflowStep (teamId);

-- WorkflowRun: add after workflowName
versionId text not null,
```

`Workflow.savedVersionId` / `draftVersionId` are not foreign keys: SQLite would need the version row to exist before the workflow row and vice versa. The repository keeps the pointers consistent inside transactions; the two `check`s catch the impossible states.

## Domain (`src/lib/Domain.ts`)

Add, keeping the existing brand/style conventions:

```ts
export const WorkflowVersionId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowVersionId"),
);

export const WorkflowVersion = Schema.Struct({
  id: WorkflowVersionId,
  workflowId: WorkflowId,
  tags: Schema.fromJsonString(ProductTags),
  createdAt: Schema.Number,
  appliedAt: Schema.NullOr(Schema.Number),
  retiredAt: Schema.NullOr(Schema.Number),
});
```

Change:

- `Workflow`: remove `tags`; add `active: SqliteBoolean`, `savedVersionId: Schema.NullOr(WorkflowVersionId)`, `draftVersionId: Schema.NullOr(WorkflowVersionId)`.
- `WorkflowStep`: `workflowId` → `versionId: WorkflowVersionId`.
- `WorkflowDetail` (the routing shape): `{ workflow, version: WorkflowVersion, steps }`. `matchesLineItem` reads `version.tags`.
- `WorkflowRun`: add `versionId: WorkflowVersionId`.
- `WorkflowSummary` (list row): remove `tags`; add `active`, `hasDraft: SqliteBoolean`, `tags` **of the saved version** (empty when none), `stepCount` of the saved version, `activeRunCount` unchanged.
- `WorkflowDetailView` (detail page): replace `steps` with
  ```ts
  live:  Schema.NullOr(Schema.Struct({ version: WorkflowVersion, steps: Schema.Array(StepWithTeamName) })),
  draft: Schema.NullOr(Schema.Struct({ version: WorkflowVersion, steps: Schema.Array(StepWithTeamName) })),
  ```
  where `StepWithTeamName` is the existing `{ ...WorkflowStep.fields, teamName: NullOr(TeamName) }`. `activeTeams` stays.
- `CreateWorkflowInput`: unchanged shape (name, scope, tags). Tags land on the initial draft.
- `UpdateWorkflowInput`: `{ workflowId, name }` only. New `UpdateWorkflowTagsInput = { workflowId, tags }` (goes through `ensureDraft`).
- New inputs: `ApplyDraftInput`, `DiscardDraftInput` (both `{ workflowId }`), `SetWorkflowActiveInput = { workflowId, active: Boolean }`.
- `SeedWorkflowsInput` workflow entries gain `active: optionalKey(Boolean)` (default: `true` when the entry has steps and is not archived) and `draft: optionalKey(Array(step))` (optional second step list seeded as a pending draft, for fixtures that show the draft UI).
- Results:
  ```ts
  export const ApplyResult = Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
    Schema.Struct({ _tag: Schema.Literal("NotFound") }),
    Schema.Struct({ _tag: Schema.Literal("NoDraft") }),
    Schema.Struct({ _tag: Schema.Literal("NoSteps") }),
    Schema.Struct({ _tag: Schema.Literal("TeamNotActive"), stepNames: Schema.Array(StepName) }),
  ]);
  export const DiscardResult = Union(Ok{workflow} | NotFound | NoDraft | NoSavedVersion);
  export const ActivateResult = Union(Ok{workflow} | NotFound | Archived | NoSavedVersion | NoSteps | TeamNotActive{stepNames} | OrderWorkflowExists);
  ```
  `WorkflowResult` gains `{ _tag: "Active" }` for "archive refused while active". `StepResult` keeps `Archived`; there is no "Live" refusal because writes fork instead.

## Repository (`src/lib/WorkflowRepository.ts`)

New errors: `NoDraftError`, `NoSavedVersionError`, `NoStepsError`, `WorkflowActiveError` (archive refused), `TeamNotActiveError { stepNames }`. All `Schema.TaggedError` in the existing style.

Private helpers inside the layer:

- `findVersion(versionId)`, `stepsOf(versionId)` (ordered by position), `layoutOf(versionId)`, `writeLayout(versionId, layout)`, `countSteps(versionId)`. Every existing helper keyed by `workflowId` re-keys by `versionId`.
- `ensureDraft(workflowId): Effect<{ workflow, draft: WorkflowVersion }>` per the rule above. It opens no transaction of its own; callers that already wrap in `sql.withTransaction` compose it, callers that do not wrap it. (Durable Object SQLite refuses nested transactions, same constraint `writeLayout` already documents.)
- `resolveDraftStep(stepId): Effect<{ workflow, draft, step }>`: the saved-step-id mapping by position described under "Fork on first edit".

Service surface:

| Operation                                              | Change                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `listWorkflows`                                        | joins saved version for `tags`, `stepCount`; `hasDraft = draftVersionId is not null`; `active`             |
| `getWorkflow`                                          | returns `{ workflow, live, draft }` (`Option`); each side `{ version, steps }`                             |
| `listActiveWorkflowDetails`                            | `archivedAt is null and active = 1 and savedVersionId is not null`, saved version + its steps, two queries |
| `createWorkflow`                                       | inserts workflow + one draft version (tags) in a transaction; `active = 0`, `savedVersionId = null`        |
| `updateWorkflow`                                       | name only                                                                                                  |
| `updateWorkflowTags` (new)                             | `ensureDraft`, write `tags` on the draft; order scope refuses non-empty                                    |
| `setWorkflowArchived`                                  | archive refuses while `active = 1` → `WorkflowActiveError`; restore unchanged                              |
| `setWorkflowActive` (new)                              | per "On / off"; takes `activeTeams` from the caller like `createRun` does                                  |
| `applyDraft` (new)                                     | per "Apply"; takes `activeTeams`                                                                           |
| `discardDraft` (new)                                   | per "Discard"                                                                                              |
| `addStep`, `addParallelStep`                           | `ensureDraft` first, then insert into the draft version                                                    |
| `updateStep`, `moveStep`, `separateStep`, `removeStep` | `resolveDraftStep` first, then operate on the draft step                                                   |
| `countStepsOwnedBy`, `listStepsOwnedBy`                | join `WorkflowVersion` with `retiredAt is null`; `OwnedStep` gains `versionState: 'live' \| 'draft'`       |
| `replaceWorkflows` (seed)                              | one applied version per fixture (`appliedAt = now`), optional draft, `active` per rule; deletes runs first |

`WorkflowRunRepository.insertRun` writes `versionId`; `isRoutable` gains the `active` check and reads `detail.version`; `RoutingContext.workflows` is the new `WorkflowDetail` shape.

## ShopAgent callables (`src/lib/ShopAgent.ts`)

- `workflowWritable` keeps refusing archived workflows (`Archived`). It no longer needs to look at anything else: writes fork.
- New callables, each a `callableEffect` over the matching input schema and each ending with `publish("all")` because the list and detail pages both change: `applyDraft`, `discardDraft`, `setWorkflowActive`, `updateWorkflowTags`. `applyDraft` and `setWorkflowActive` load `activeTeams()` and pass them in.
- Map errors to results with small `Match.typeTags` helpers next to `workflowResult` / `stepResult`.
- Log lines follow the existing format: `ShopAgent.applyDraft: shop=${shop} workflowId=${id} versionId=${versionId}`, with `Effect.annotateLogs({ shop, workflowId, versionId })`.
- `getWorkflowDetail` returns the new `WorkflowDetailView`, joining `teamName` for both sides.

## UI

### `/app/workflows` (`app.workflows.index.tsx`)

Columns: Name, Status, Product tags, Steps, Active runs, Updated, action. Status cell renders badges from one place: `Active` (success), `Off` (default), `Archived` (info), plus `Draft pending` (attention) when `hasDraft`, and `No steps` (warning) when there is no saved version or it has none. Flow hides the pending draft from its list; Baton shows it, because a production floor needs to know the live definition is not the one being edited. The row action stays Archive / Restore; Archive is disabled with a tooltip "Turn off first" when active.

Create form unchanged. A new workflow lands on its detail page with an empty draft and an "Off" badge.

### `/app/workflows/$workflowId` (`app.workflows.$workflowId.tsx`)

Header accessories: `Active` / `Off`, `Archived`, `Order workflow`, `Draft pending`. Primary header action is the switch: **Turn on** (disabled with the reason from `ActivateResult` when it would fail) or **Turn off**.

Sections, top to bottom:

1. **Details.** Name field with Save (immediate). Archive / Restore.
2. **Live.** Read-only stage table of the saved version plus its product tags. Empty state "Not applied yet. Apply the draft below to make this workflow routable." When a draft exists, a short line: "Draft changes below are not live until you apply them."
3. **Draft.** The existing editable stage table and the tags field, operating on `draft.steps` when a draft exists, otherwise on `live.steps` (the first edit forks; after the mutation resolves, `router.invalidate()` re-reads and the section now shows the draft). Footer row with **Apply changes** (primary) and **Discard changes**. Apply on an active workflow opens a confirm: "This workflow is on. New orders will follow the applied steps immediately." Discard confirms too. Both disabled when there is no draft; Discard hidden when there is no saved version.
   - Banners move here: "No steps" and "steps point at an archived team" describe the draft; the same conditions on the live version show under Live as "Turn on is unavailable until…".

The "Needs attention" banner logic in the current file (`orphanedSteps`, `steps.length === 0`) splits per side.

### Order page run cards

Where a run's steps are shown, add a subdued line "From version applied <formatDateTime(version.appliedAt)>". When `run.versionId !== workflow.savedVersionId`, append "· definition has changed since". Requires `listRunsForOrder` to join `WorkflowVersion.appliedAt`; add `versionAppliedAt: NullOr(Number)` to `WorkflowRunDetail` rather than to `WorkflowRun`.

## Seed (`scripts` / `/api/dev/seed`)

Update fixtures so at least one workflow is seeded with a pending draft and one is seeded off, so both UI states are visible after `pnpm seed`.

## Tests

`test/integration` (Vitest, existing harness). Required cases:

1. Create → no saved version, one draft, `active = 0`, not routable.
2. Add two steps, apply → saved version with two steps, draft null; routing an order with a matching tag creates a run with two steps and `run.versionId = savedVersionId`.
3. Turn on, edit a step → new draft version, saved version unchanged; an order routed now copies the **saved** steps.
4. Apply while on → old version `retiredAt` set, new `appliedAt` set, pointers swapped in one transaction; the earlier run still has the old `versionId` and its copied steps.
5. Edit with a saved step id (no draft) → fork; the mutation lands on the draft step at the same position.
6. Discard → draft deleted, steps cascade, saved version untouched; discard with no saved version → `NoSavedVersion`.
7. Turn on refused: no saved version, zero steps, step on an archived team, second active order workflow.
8. Archive while active → `WorkflowActiveError`; turn off, archive, restore → still off.
9. `archiveTeam` blocked by a step in a live or draft version, not by one in a retired version.
10. Seed: fixtures with `active`, `draft`, and archived entries produce the expected pointers.

Existing `WorkflowLayout` tests are unaffected (pure module).

## Order of work

1. Domain schemas and results.
2. Schema block in `initializeSchema`; wipe local state.
3. `WorkflowRepository`: re-key by version, `ensureDraft`, `resolveDraftStep`, new operations, seed.
4. `WorkflowRunRepository`: `versionId` on insert, `isRoutable`, `WorkflowDetail` shape, `versionAppliedAt` on run detail.
5. `ShopAgent` callables and `ShopAgentClient` surface.
6. Routes: list, detail, run cards.
7. Seed fixtures, integration tests, `pnpm typecheck`, `pnpm lint`, `pnpm fmt`.

## Decisions taken in this spec (confirm or amend)

- **Tags live on the version**, name on the workflow. A tag change is a routing change and goes through Apply.
- **Archive requires Off first**, like Flow's delete. Restore leaves the workflow off.
- **Turn off leaves open runs alone.** Only new routing stops.
- **Age rule stays on `workflow.createdAt`**, not `version.appliedAt`.
- **Retired versions are never deleted**, so runs keep lineage and a history view can come later without a schema change.
- **No version-history UI in this pass.** `WorkflowVersion.createdAt / appliedAt / retiredAt` already record enough to build one.

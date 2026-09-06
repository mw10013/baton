# Workflow and draft: edit, apply, discard, on/off — spec

Spec date: 2026-09-05. Builds on `workflow-stages-spec.md` (stages, step actions) and `workflow-runs-spec.md` (runs). Archive, delete, and attention state are unchanged by this spec; `delete-model-spec.md` follows it.

Status: **ready to implement** (2026-09-06). Written to be handed to an implementer with no other context than this repo and `CLAUDE.md`. The uncommitted working set in `src/` implements an earlier version-based design (a `WorkflowVersion` table with saved/draft pointers and `retiredAt`); reshape it to this spec before committing, do not commit it first. Back-end code follows Effect v4 idioms as already used in `src/lib/WorkflowRepository.ts` and `src/lib/ShopAgent.ts`: `Context.Service` repositories, `Effect.fn` named operations, `Schema.TaggedError` failures, `sql.withTransaction` for multi-statement writes, results crossing the socket as tagged unions.

## Problem

Steps and tags are edited in place, and run creation reads the same rows the editor writes. A merchant adding three steps is live after the first one: an order arriving between edits gets a run with one step, correct by construction and wrong in fact.

## Model

Two nouns. The merchant never meets a third.

- **Workflow.** Name, scope, product tags, steps, Active / Off. This is what starts runs. Runs copy it wholesale, so a run never needs to look back at it.
- **Draft.** A private copy of the workflow's tags and steps, created when the merchant clicks Edit and living until Apply or Discard. Every edit writes to the draft immediately. There is no unsaved state anywhere, so leaving the page loses nothing.

**Apply** validates the draft, replaces the workflow's tags and steps with it, and deletes the draft. **Discard** deletes the draft. Both are one Durable Object transaction, so run creation sees the old workflow or the new one, never a half-edit.

Shopify Flow has the same two nouns at the surface (a workflow, and a Draft you edit and Apply) and a version history underneath. Baton has no history feature, so it keeps nothing underneath.

## Vocabulary

| Concept                                  | Merchant copy                                           | Code                                   |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| What starts runs                         | the workflow's name                                     | `Workflow`, `WorkflowStep`             |
| What the editor writes                   | "Draft"                                                 | `WorkflowDraft`, `WorkflowDraftStep`   |
| Start editing                            | "Edit"                                                  | `createDraft`                          |
| Put the draft into the workflow          | "Apply changes"                                         | `applyDraft`                           |
| Delete the draft                         | "Discard changes"                                       | `discardDraft`                         |
| Whether the workflow starts runs at all  | "Active" / "Off"                                        | `Workflow.active`, `setWorkflowActive` |
| A workflow whose draft is unapplied      | badge "Draft pending"                                   | `WorkflowSummary.hasDraft`             |
| How a workflow is chosen for a line item | "Starts when an order contains a product tagged with …" | `matchesLineItem` (unchanged name)     |

Words not used anywhere: version, live, saved, applied (as a noun or state), published, retired.

**"Starts", not "routes" (decided 2026-09-06, mw).** Shopify never uses "route" for tag-driven selection: zero occurrences in the Flow builder, and in Shopify docs "order routing" means choosing the fulfilling location. "Routing" is Route to Ship's marketing word. Research 2026-09-06 (Flow manual, Flow template gallery, Shopify admin docs) found Shopify's own verbs for each relationship, and the merchant copy uses them verbatim:

| Relationship        | Shopify's word      | Verbatim source                                                                                                             |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workflow to trigger | **starts when**     | Flow trigger card: "This workflow starts when a new order is created"                                                       |
| Order to product    | **contains**        | Flow condition: "Any item in the order contains the following tag"                                                          |
| Product to tag      | **tagged with**     | Collection condition `TAGGED_WITH` "The product is tagged with the specified value"; App Home filter chip "Tagged with VIP" |
| Several tags        | **at least one of** | Flow default list operator: "At least one of order line items.product.tags is equal to tagname"                             |
| Failing a rule      | **match**           | Collections: "Products must match any or all of the rules"                                                                  |

Avoid "includes" as an operator (Flow reserves it for substring matching) and "applies to" (help-center prose only, never in the builder). Internally, **match** is the tag test and **start** is creating the run.

Every merchant-facing use, today and after:

| Surface                                 | Today                                                   | After                                                                                    |
| --------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Workflow detail, item scope (new line)  |                                                         | "Starts when an order contains a product tagged with `mug` or `tumbler`."                |
| Workflow detail, order scope (new line) |                                                         | "Starts for every paid order."                                                           |
| Workflow tags field help                | "Comma-separated. Matching ignores case."               | "Starts for any item whose product has at least one of these tags. Case doesn't matter." |
| Workflow detail empty state             | "Add steps, then apply to make this workflow routable." | "Add steps, then apply. Turn on when it's ready."                                        |
| Orders index stage strip                | "Not routed", hint "paid, no workflow matched"          | "No workflow", hint "paid, nothing matched"                                              |
| Order page badge                        | "Not routed"                                            | "No workflow", detail line "No workflow's product tags match the items in this order."   |
| Order page run card (new)               |                                                         | "<Workflow> started for 2 items"                                                         |

The order-scope wait (item workflows finish before the order workflow's first step is ready) stays internal; the order page shows it only as a step that is not yet ready.

Internal sweep, done in this pass: `isRoutable` → `canStart`; `ProductionState` value `not_routed` → `no_workflow` (and the matching count key and stage-strip state); JSDoc and log messages in `Domain.ts`, `ShopAgent.ts`, `WorkflowRepository.ts`, `WorkflowRunRepository.ts`, `OrderRepository.ts`, and the three routes above replace "routing / routed / routable" with "starting runs / started / can start". `reconcileOrder` and `matchesLineItem` keep their names: they name the idempotent re-sync and the tag test, not the concept. Words like "route" in TanStack Router code are unrelated and untouched.

### The vocabulary lives in a JSDoc, not here

This document will go stale and be deleted. The language above is a product decision and must ship with the source. Add the block below **verbatim** as the JSDoc on `export const Workflow` in `src/lib/Domain.ts`, replacing the current one. Keep a short second paragraph on `active` and `archivedAt` as they are today, rewritten for the two-table model. Route files and repositories that render or log these words point at it with `{@link Workflow}` rather than restating it.

```ts
/**
 * Vocabulary. A workflow definition has two nouns and the merchant never
 * meets a third:
 *
 * - **Workflow**: name, scope, product tags, steps, Active / Off. This is
 *   what starts runs. Runs copy it wholesale and never look back at it.
 * - **Draft**: a private copy of the workflow's tags and steps, created by
 *   Edit and living until Apply or Discard. Every edit writes to the draft
 *   immediately; there is no unsaved state anywhere.
 *
 * Verbs: **Edit** creates the draft. **Apply changes** replaces the
 * workflow's tags and steps with the draft's and deletes the draft.
 * **Discard changes** deletes the draft. **Turn on** / **Turn off** flip
 * `active`; the switch and the draft are unrelated.
 *
 * How a workflow is chosen for work, in merchant copy:
 *
 * - a workflow **starts when** an order **contains** a product **tagged with**
 *   one of its tags;
 * - an order workflow **starts for every paid order**;
 * - an order or line item that no workflow's tags **match** shows
 *   **"No workflow"**;
 * - the order page says a workflow **started for** N items.
 *
 * In identifiers: `match` is the tag test, `start` / `canStart` is creating
 * a run. Not used, in code or copy: version, live, saved, published,
 * retired, applied (as a state), route, routing, routable.
 */
```

## Rules (normative)

### Ownership

```text
Workflow           id, name, scope, active, tags, createdAt, updatedAt
WorkflowStep       workflowId, position, stage, name, teamId, instructions
WorkflowDraft      workflowId (primary key), tags, createdAt, updatedAt
WorkflowDraftStep  workflowId, position, stage, name, teamId, instructions
```

`name` and `scope` are on the workflow only. A rename is immediate and cosmetic (runs snapshot `workflowName`). `tags` are on both, because tags select line items and a tag change must go through Apply.

Steps and draft steps have the same shape. They are two tables rather than one table with a flag so that a step-id write cannot be ambiguous about which side it targets, and so that `unique (workflowId, position)` holds on each side independently.

### Invariants

```text
a workflow has zero or one draft                        (WorkflowDraft primary key is workflowId)
step writes target the draft, never the workflow        (no callable writes WorkflowStep except applyDraft)
active = 1 ⇒ the workflow has ≥ 1 step                  (setWorkflowActive requires a step; applyDraft never produces an empty workflow)
scope = 'order' ⇒ tags is empty                         (workflow and draft)
```

A freshly created workflow has no steps, empty tags, `active = 0`, and a draft with no steps. It shows "No steps" until the merchant applies a draft with at least one.

### Edit

```text
createDraft(workflowId), one transaction:
  if a WorkflowDraft row exists → return it (idempotent; the merchant is resuming)
  else insert WorkflowDraft (tags = workflow.tags)
       insert into WorkflowDraftStep: every WorkflowStep of the workflow, new ids, same position/stage/name/teamId/instructions
```

Every step and tag write (`addStep`, `updateStep`, `moveStep`, `separateStep`, `removeStep`, `setTags`) requires the draft to exist and fails `NoDraft` otherwise. The editor only ever shows draft steps, so it only ever sends draft step ids. There is no fork-on-write resolution (`resolveDraftStep` goes).

### Apply

```text
applyDraft(workflowId), one transaction:
  draft must exist                                          else NoDraft
  scope = 'order' ⇒ draft.tags is empty                     (repository invariant, WorkflowRepositoryError)
  draft.steps.length > 0                                    else NoSteps
  every draft step's teamId is an active team               else TeamNotActive { stepNames }   (unchanged check)
  delete from WorkflowStep where workflowId = ?
  insert into WorkflowStep select … from WorkflowDraftStep where workflowId = ?    (ids carried over)
  update Workflow set tags = draft.tags, updatedAt = now
  delete from WorkflowDraft where workflowId = ?            (draft steps cascade)
  publish
```

The checks are the same whether the workflow is on or off. An empty draft cannot be applied: a workflow with no steps is not a workflow, and the way to abandon an initial empty draft is Discard.

Apply does not touch `active`. Applying on an active workflow means the next order starts against the new steps; the UI confirms that case. Applying on an off workflow is silent.

Step ids carry over from draft to workflow so that nothing referencing a step id during the transaction goes stale. Run steps do not reference workflow step ids (they snapshot), so this is a convenience, not a requirement.

### Discard

```text
discardDraft(workflowId), one transaction:
  draft must exist                    else NoDraft
  delete from WorkflowDraft where workflowId = ?      (draft steps cascade)
  publish
```

Always allowed. Discarding the initial draft of a never-applied workflow leaves an off workflow with no steps, which shows "No steps. Edit to add some." There is no `NoSavedVersion` refusal.

### On / off

```text
setWorkflowActive(workflowId, true):
  archivedAt is null                                          else Archived
  workflow has ≥ 1 step                                       else NoSteps
  every step's teamId is an active team                       else TeamNotActive { stepNames }
  scope = 'order' ⇒ no other active order workflow            else OrderWorkflowExists
  set active = 1

setWorkflowActive(workflowId, false):
  set active = 0. Open runs are untouched (Baton runs are days of physical work; Flow cancels because its runs are seconds).
```

`active` is stored, never derived. The switch and the draft are unrelated: Turn on / Turn off read and write the workflow only, never create, apply, or discard a draft, and never look at whether one exists.

### Starting runs

Replaces `isRoutable` in `src/lib/WorkflowRunRepository.ts` (renamed `canStart`, see Vocabulary):

```text
canStart(detail) = workflow.archivedAt is null
               and workflow.active
               and detail.steps.length > 0
               and every step.teamId in activeTeams
```

`listActiveWorkflowDetails` returns workflows with `archivedAt is null and active = 1`, each with its `WorkflowStep` rows. Drafts are invisible to run creation by construction: nothing in the run repository reads `WorkflowDraft*`.

The age rule `order.processedAt >= workflow.createdAt` stays on `workflow.createdAt`. A re-apply must not stop starting runs for orders that arrived while the draft was being written.

### Runs

`insertRun` copies `detail.steps` as today. `WorkflowRun.versionId` and `WorkflowRunDetail.versionAppliedAt` are removed. The order page run card line "From version applied …" is removed. A run is complete in itself.

### Team references

`countStepsOwnedBy` / `listStepsOwnedBy` count `WorkflowStep` and `WorkflowDraftStep` rows; `OwnedStep` gains `side: 'workflow' | 'draft'`. The `archiveTeam` guard is otherwise unchanged.

## Schema

DO SQLite, `initializeSchema` in `src/lib/ShopAgent.ts`, edited in place; wipe local state and `pnpm seed`. No migration (prototype).

```sql
create table if not exists Workflow (
  id text primary key,
  name text not null collate nocase,
  scope text not null check (scope in ('item', 'order')),
  active integer not null default 0,
  archivedAt integer,
  tags text not null default '[]',
  createdAt integer not null,
  updatedAt integer not null,
  unique (name)
);

create table if not exists WorkflowStep (
  id text primary key,
  workflowId text not null references Workflow (id) on delete cascade,
  position integer not null,
  stage integer not null,
  name text not null,
  teamId text not null,
  instructions text not null default '',
  unique (workflowId, position)
);

create table if not exists WorkflowDraft (
  workflowId text primary key references Workflow (id) on delete cascade,
  tags text not null default '[]',
  createdAt integer not null,
  updatedAt integer not null
);

create table if not exists WorkflowDraftStep (
  id text primary key,
  workflowId text not null references WorkflowDraft (workflowId) on delete cascade,
  position integer not null,
  stage integer not null,
  name text not null,
  teamId text not null,
  instructions text not null default '',
  unique (workflowId, position)
);
```

Removed: `WorkflowVersion`, `Workflow.savedVersionId`, `Workflow.draftVersionId`, both `check`s on `Workflow`, `WorkflowStep.versionId`, `WorkflowRun.versionId`. `Workflow.archivedAt`, archive / restore, and the "archive requires Off" guard are unchanged.

Schema JSDoc: the reason a run survives every edit is that runs snapshot steps and names, not that old definitions are kept.

## Domain (`src/lib/Domain.ts`)

- Remove `WorkflowVersionId`, `WorkflowVersion`, `WorkflowVersionSteps`, `WorkflowVersions`, `WorkflowVersionView`, `WorkflowStep.versionId`, `WorkflowRun.versionId`, `WorkflowRunDetail.versionAppliedAt`.
- `Workflow` gains `tags` back. `WorkflowStep` gains `workflowId` back.
- New `WorkflowDraft { workflowId, tags, createdAt, updatedAt }`, `WorkflowDraftStep` (same fields as `WorkflowStep`).
- `WorkflowSummary` keeps `hasDraft`; `tags` and `stepCount` describe the workflow.
- `WorkflowDetail` becomes `{ workflow, steps: StepWithTeamName[], draft: NullOr({ draft: WorkflowDraft, steps: StepWithTeamName[] }) }`.
- Results: `ApplyResult = Applied | NoDraft | NoSteps | TeamNotActive`; `DiscardResult = Discarded | NoDraft`; `ActivateResult = Activated | Archived | NoSteps | TeamNotActive | OrderWorkflowExists`; `StepResult` gains `NoDraft` and loses any "Live" refusal. `DraftResult = Created | NotFound` for `createDraft`.

## Repository (`src/lib/WorkflowRepository.ts`)

| Operation                                                                    | Behaviour                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `createWorkflow`                                                             | insert `Workflow` (no steps) and an empty `WorkflowDraft`                  |
| `getWorkflow`                                                                | `{ workflow, steps, draft }` as `Option`                                   |
| `listWorkflows`                                                              | workflow columns, `stepCount` from `WorkflowStep`, `hasDraft` via `exists` |
| `listActiveWorkflowDetails`                                                  | `active = 1` with `WorkflowStep` rows                                      |
| `createDraft`                                                                | as Edit above                                                              |
| `addStep`, `updateStep`, `moveStep`, `separateStep`, `removeStep`, `setTags` | target `WorkflowDraft*`; `NoDraft` if none                                 |
| `applyDraft`, `discardDraft`                                                 | as above                                                                   |
| `setWorkflowActive`                                                          | as above                                                                   |
| `countStepsOwnedBy`, `listStepsOwnedBy`                                      | union of both step tables with `side`                                      |

Removed: `ensureDraft`, `resolveDraftStep`, every version query.

### Implementation idioms (Effect v4, as already used in this repo)

- Repositories are `Context.Service` classes with a `Layer`; operations are `Effect.fn("WorkflowRepository.applyDraft")(function* (input) { … })` so spans carry the name.
- Multi-statement writes run inside `sql.withTransaction`. `applyDraft`, `discardDraft`, `createDraft` are each one transaction. No read-then-write outside a transaction.
- Failures are `Schema.TaggedError` classes (`NoDraftError`, `WorkflowNotFoundError`, …) in the repository. The ShopAgent callable catches the ones the UI must show and maps them onto the tagged-union result (`ApplyResult`, `DiscardResult`, …) with `Effect.catchTag` / `Effect.catchTags`; everything else is a defect. The route renders the result with `Match.value(result).pipe(Match.tag(…))`, never a string compare.
- Inputs crossing the socket are `Schema.Struct` in `Domain.ts` and decoded at the boundary; internal functions take already-decoded values.
- Immutability: rows are `readonly` structs; steps are copied with `Array.map`, never mutated in place.
- Logging: single-string message in `<operation>: shop=<shop> key=<value>` form with the same fields in `Effect.annotateLogs`, e.g. `applyDraft: shop=${shop} workflowId=${id} steps=${n}`.
- After a successful write the callable calls `publish("all")` (or the narrower scope the existing code uses for workflows) so subscribed pages refetch.

## ShopAgent callables (`src/lib/ShopAgent.ts`)

`createDraft`, `applyDraft`, `discardDraft`, `setWorkflowActive` plus the existing step callables. Each publishes `workflows` after a successful write. `getWorkflowDetail` resolves `teamName` for both the workflow's steps and the draft's steps against the live D1 roster.

## UI

### `/app/workflows` (`app.workflows.index.tsx`)

Columns: Name, Status, Product tags, Steps, Active runs, Updated, action. Status badges from one place: `Active` (success), `Off` (default), `Archived` (info), plus `Draft pending` (attention) when `hasDraft`, and `No steps` (warning) when `stepCount = 0`. Flow hides the pending draft from its list; Baton shows it, because a production floor needs to know that what starts runs today is not what is being edited.

Create form unchanged. A new workflow lands on its detail page with the draft open and an `Off` badge.

### `/app/workflows/$workflowId` (`app.workflows.$workflowId.tsx`)

Header: workflow name, badges `Active` / `Off`, `Archived`, `Order workflow`, `Draft pending`. Primary header action is the switch: **Turn on** (disabled with the reason from `ActivateResult` when it would fail) or **Turn off**. Secondary: **Edit** when no draft exists (calls `createDraft`, then the Draft section appears).

Sections, top to bottom:

1. **Details.** Name field with Save (immediate). Archive / Restore as today.
2. **The workflow.** No section label beyond the name in the header. Trigger line: "Starts when an order contains a product tagged with `a` or `b`." (item scope) or "Starts for every paid order." (order scope). Read-only stage table of `steps`. Empty state: "No steps. Edit to add some." When a draft exists, one line under the table: "Draft changes below are not in effect until you apply them."
3. **Draft.** Only when a draft exists. Editable stage table and tags field over `draft.steps`. Footer: **Apply changes** (primary) and **Discard changes**. Apply on an active workflow confirms: "This workflow is on. New orders will follow the applied steps immediately." Discard confirms. Apply disabled with reason when `ApplyResult` would refuse.
   - Attention banners: "No steps" and "steps point at an archived team" describe whichever side they are found on; on the workflow side they read "Turn on is unavailable until …".

### Order page run cards

Remove the "From version applied …" line and the "definition has changed since" suffix. Nothing replaces them.

## Seed (`api.dev.seed.ts`, `e2e/fixture.ts`, `e2e/seed.ts`)

Fixtures declare `steps`, optional `draft: { tags?, steps }`, and `active`. At least one workflow seeded with a pending draft and one seeded off.

## Tests

`test/integration` (Vitest). Required cases:

1. Create → workflow with no steps, empty draft, `active = 0`, `canStart` false.
2. Add two draft steps, apply → workflow has two steps, draft gone; an order with a matching tag starts a run with two steps.
3. Turn on, edit → `NoDraft` until `createDraft`; after `createDraft` the draft has copies with new ids; an order started now copies the **workflow's** steps, not the draft's.
4. Apply while on → workflow steps replaced in one transaction; the earlier run keeps its copied steps.
5. Discard → draft and draft steps gone, workflow untouched; discard on a never-applied workflow leaves zero steps and no draft.
6. Apply empty draft → `NoSteps`, on and off alike.
7. Turn on refused: archived, zero steps, step on an archived team, second active order workflow.
8. `countStepsOwnedBy` counts both sides with `side`.
9. Seed fixtures with `steps`, `draft`, `active` produce the expected rows.

## Order of work

1. Domain schemas and results; the vocabulary JSDoc above `Workflow`; rewrite the `Workflow` / `WorkflowStep` / `ProductionState` JSDocs for the two-table model.
2. Schema block in `initializeSchema`; wipe local state.
3. `WorkflowRepository`: two-table model, `createDraft`, step writes on the draft, `applyDraft`, `discardDraft`, seed.
4. `WorkflowRunRepository`: drop `versionId`, `canStart`, `WorkflowDetail` shape.
5. `ShopAgent` callables and `ShopAgentClient`.
6. Routes: list, detail (Edit button, Draft section), run cards.
7. Seed fixtures, integration tests, `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep every file it touches).
8. Grep the repo for `version`, `live`, `saved`, `routable`, `routed`, `not_routed`, `Not routed` and confirm the only hits are TanStack Router / unrelated code.

## Decisions taken in this spec (confirm or amend)

- **Edit is the fork.** The draft is created by an explicit Edit action, not by the first write. Step writes without a draft fail. Simpler than resolving which side a step id belongs to.
- **Two step tables**, not one table with a draft flag.
- **Step ids carry over on Apply**; fork copies get new ids.
- **Discard is always allowed**, including on a never-applied workflow.
- **Apply runs the same checks on and off**; an empty draft is never applied.
- **The on/off switch and the draft are unrelated.**
- **Runs keep no reference to what they were copied from.** No `versionId`, no "definition has changed since".
- **Merchant copy uses Flow's verbs (starts when, contains, tagged with, at least one of, match), never "routes".**
- **Turn off leaves open runs alone.**
- **Age rule stays on `workflow.createdAt`.**

## Decisions on the former open questions (2026-09-06, mw)

1. **Draft on the same detail page** as the workflow, so the floor sees what starts runs and what is being edited together.
2. **Edit is a click.** No draft is created by opening the page.
3. **Rename sweep now**, as inventoried under Vocabulary.
4. **"Starts for every paid order"** is the order-scope wording. The item-workflows-first wait is not spelled out there.

# Workflow stages and step actions — spec

Spec date: 2026-09-03. Implements the decisions in `workflow-step-model-research.md` → Decisions (2026-09-03). Builds on `workflow-runs-spec.md` (runs, shipped in `901cc8d`) and `workflow-definition-research.md` (definitions).

Written to be handed to an implementer with no other context than this repo. Where this spec and the code disagree, the code's existing conventions win and the spec should be amended.

## Goals / non-goals

- **Goals.** (1) Steps can share a **stage**; all steps in a stage are ready together and the next stage waits for all of them. (2) Steps carry **instructions** written by the merchant. (3) A worker can **Start** a ready step, **Done** it, leave a **note** on it, and mark the run **blocked** with a reason. (4) Editor, queue, and order page render stages.
- **Non-goals.** Lanes, edges, optional or skippable steps, approval type or manager role, per-unit progress, rework/reopen, printing, per-order steps, notifications, any Shopify write. All deliberately deferred; see the research doc.
- **No migration.** The app is a prototype. Every schema change below edits `initializeSchema` in `src/lib/ShopAgent.ts` in place. Local Durable Object state is wiped (`rm -rf .wrangler` or the existing reset flow) and reseeded with `pnpm seed`.

## Vocabulary

| Concept                                   | Merchant / member copy                                       | Code                 |
| ----------------------------------------- | ------------------------------------------------------------ | -------------------- |
| Group of steps that are ready together    | "steps with the same number" (the word "stage" is not shown) | `stage`              |
| A step nothing earlier is blocking        | shown in the queue                                           | ready                |
| A step someone has pressed Start on       | "In progress"                                                | `startedAt` not null |
| Merchant text describing how to do a step | "Instructions"                                               | `instructions`       |
| Worker text about this particular item    | "Note"                                                       | `note`               |
| Human-set attention marker on a run       | "Blocked"                                                    | `flag = 'blocked'`   |

## Rules (normative)

### Stage invariants on a definition

For the steps of one workflow, ordered by `position`:

```text
positions are 1..n, dense, unique                                  (unchanged)
stages    are 1..m, dense, and non-decreasing along position       (new)
```

So the sequence of stages along position looks like `1 1 2 3 3 3 4`, never `1 3` or `2 1`. Every step belongs to exactly one stage. A stage with one step is the linear case.

### Ready rule on a run

```text
ready(step) = step.completedAt is null
          and not exists (other step p in the same run with p.completedAt is null and p.stage < step.stage)
```

Replaces "lowest open position". Several steps of one run can be ready at once. A step can be started or completed only when ready.

### Run status

```text
done     : every step has completedAt
active   : not done, and (any step has completedAt or any step has startedAt)
pending  : otherwise
cancelled: unchanged (person or reconcile)
```

Start now moves a run to `active`. This matters for reconcile: an active run is flagged rather than silently cancelled when the order changes, and "someone has started work" is exactly the condition that should protect it.

### Editor operations, as pure functions

Every layout change is computed in TypeScript over the workflow's ≤ 20 steps, then persisted as a whole. This keeps the invariants in one tested module instead of scattered across SQL statements.

```text
addStep(steps, step)                    new step, position n+1, stage m+1
addParallelStep(steps, stage, step)     new step placed after the last step of `stage`, same stage; later positions shift by 1
moveStep(steps, id, up|down)            swap position with the neighbour; the moved step takes the neighbour's stage
separateStep(steps, id)                 the step leaves its stage into a new stage of its own immediately after it;
                                        no-op if it is already alone in its stage
removeStep(steps, id)                   delete, then normalize
normalize(steps)                        sort by (stage, position); renumber positions 1..n; renumber stages dense 1..m
```

`moveStep` semantics, spelled out: moving step A "up" swaps positions with the step B directly above it. If B is in a lower stage, A adopts B's stage, so A joins the stage above; A's old stage shrinks by one and, if it becomes empty, `normalize` closes the gap. Moving within a stage just reorders display. There is no way to _create_ a stage boundary with move; that is `separateStep`. Together with `addParallelStep`, these four operations reach every valid layout (proof sketch: any layout can be built stage by stage with `addStep` then `addParallelStep`; any edit is a sequence of separate, move, and remove).

## Schema — `src/lib/ShopAgent.ts` `initializeSchema` (edit in place)

```sql
create table if not exists WorkflowStep (
  id text primary key,
  workflowId text not null references Workflow (id) on delete cascade,
  position integer not null,
  stage integer not null,
  name text not null check (name = trim(name) and length(name) > 0),
  teamId text not null,
  instructions text,
  createdAt integer not null,
  unique (workflowId, position)
);
create index if not exists WorkflowStep_teamId_idx on WorkflowStep (teamId);

-- WorkflowRun: only the flag check changes
flag text check (flag in ('item_removed', 'quantity_changed', 'order_cancelled', 'order_deleted', 'blocked')),

create table if not exists WorkflowRunStep (
  id text primary key,
  runId text not null references WorkflowRun (id) on delete cascade,
  position integer not null,
  stage integer not null,
  name text not null,
  teamId text not null,
  teamName text not null,
  instructions text,
  startedAt integer,
  startedBy text,
  completedAt integer,
  completedBy text,
  note text,
  unique (runId, position)
);
create index if not exists WorkflowRunStep_teamId_idx on WorkflowRunStep (teamId, completedAt);
```

Update the schema JSDoc above `initializeSchema` (the long comment describing `WorkflowStep` / `WorkflowRun`) to describe `stage`, the ready rule, and why the layout is rewritten whole rather than patched (the `unique (workflowId, position)` note about `moveStep` and a scratch position becomes the general "park at negatives" note below). Do not delete the existing comment text; extend it.

## Domain — `src/lib/Domain.ts`

```ts
// new branded strings, same construction as StepName (trim on decode, NonEmpty, brand)
StepInstructions   // isMaxLength(2000)
StepNote           // isMaxLength(1000)

WorkflowStep        + stage: Schema.Number, instructions: Schema.NullOr(StepInstructions)
WorkflowRunStep     + stage: Schema.Number, instructions: Schema.NullOr(StepInstructions),
                      startedAt: Schema.NullOr(Schema.Number), startedBy: Schema.NullOr(MemberId),
                      note: Schema.NullOr(StepNote)

RunFlag             + "blocked"
RunFlagDetail       + reason: Schema.optionalKey(StepNote), by: Schema.optionalKey(MemberId)

AddStepInput        + instructions: Schema.optionalKey(StepInstructions)
UpdateStepInput     + instructions: Schema.NullOr(StepInstructions)        // null clears; the UI maps a blank field to null before sending
AddParallelStepInput  { workflowId: BoundedId, stage: Schema.Number, name: StepName, teamId: BoundedId, instructions?: StepInstructions }
SeparateStepInput   = StepIdInput  (reuse)

SeedWorkflowsInput.steps[]  + stage: Schema.optionalKey(Schema.Number), instructions: Schema.optionalKey(StepInstructions)
                              // absent stage = previous step's stage + 1 (linear); the seed validates the invariant before writing

// member-area inputs (teamIds, memberId from requireMember as today)
StartStepInput      = CompleteStepInput shape  { runStepId, memberId, teamIds }
SetStepNoteInput    { runStepId, memberId, teamIds, note: Schema.NullOr(StepNote) }   // null clears
BlockRunInput       { runId, memberId, teamIds, reason: Schema.NullOr(StepNote) }

// queue row: one per run, with every ready step the member may act on
QueueStep           { ...WorkflowRunStep.fields, startedByEmail: Schema.NullOr(Email),
                      siblings: Schema.Array(Schema.Struct({ name: StepName, teamName: TeamName })) }   // other steps in the same stage not in this item
QueueItem           { run: WorkflowRun, steps: Schema.NonEmptyArray(QueueStep), stageCount: Schema.Number, note: Schema.NullOr(Schema.String) }

RunResult           rename tag "NotCurrent" → "NotReady"
```

Update the JSDoc on `QueueItem` ("the lowest open position") to the ready rule. Update `RunResult`'s JSDoc likewise.

## Pure layout module — `src/lib/WorkflowLayout.ts` (new)

No Effect, no SQL. Operates on `readonly { id: string; position: number; stage: number }[]` (a `Layout` type; the repository projects steps to it and back). Every function returns a new normalized array; none mutate.

```ts
export type Placed = {
  readonly id: string;
  readonly position: number;
  readonly stage: number;
};
export type Layout = readonly Placed[];

export const normalize: (layout: Layout) => Layout;
export const append: (layout: Layout, id: string) => Layout; // new last stage
export const appendParallel: (
  layout: Layout,
  stage: number,
  id: string,
) => Layout; // into existing stage; stage must exist
export const move: (
  layout: Layout,
  id: string,
  direction: Domain.StepDirection,
) => Layout; // no-op at edges
export const separate: (layout: Layout, id: string) => Layout; // no-op when alone in stage
export const remove: (layout: Layout, id: string) => Layout;
export const isValid: (layout: Layout) => boolean; // the two invariants
export const stagesOf: (layout: Layout) => readonly (readonly Placed[])[]; // grouped, for rendering
```

Implementation notes: use `Array.map`/`filter`/`toSorted`, no loops with mutation; `normalize` is `toSorted by (stage, position)` then two `map`s. `appendParallel` on a non-existent stage returns the layout unchanged (the callable reports `NotFound`). `move` when the neighbour is in another stage sets the moved step's stage to the neighbour's before normalizing.

Unit tests live in `test/integration/workflow-layout.test.ts` (same runner as the rest; it just doesn't need a database): property-style over hand-written layouts, including every example in the research doc's editor mockup and the round-trip `separate` then `move` shown in the research appendix. Assert `isValid` after every operation and that ids are preserved.

## `src/lib/WorkflowRepository.ts`

Add a private helper and one method, change three:

```ts
/**
 * Persists a whole layout. `unique (workflowId, position)` forbids in-place
 * renumbering (a +1 shift collides row by row), so every step first parks at
 * `-position`, then takes its final position and stage. One transaction.
 */
const writeLayout = (workflowId: string, layout: WorkflowLayout.Layout) =>
  sql.withTransaction(Effect.gen(function* () {
    yield* sql`update WorkflowStep set position = -position where workflowId = ${workflowId}`;
    yield* Effect.forEach(layout, (p) =>
      sql`update WorkflowStep set position = ${p.position}, stage = ${p.stage} where id = ${p.id}`,
      { discard: true });
  }));

const layoutOf = (workflowId: string) => /* select id, position, stage ... order by position */;
```

Method changes:

| Method                                                                       | Change                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addStep({ workflowId, name, teamId, instructions })`                        | insert with `stage = coalesce(max(stage), 0) + 1`, `position = coalesce(max(position), 0) + 1`, `instructions`. Same checks as today.                                                                                                        |
| `addParallelStep({ workflowId, stage, name, teamId, instructions })` **new** | checks as `addStep`; fail `StageNotFoundError` if no step has that stage; insert the row at a temporary position `n+1` and stage `stage`; then `writeLayout(appendParallel(layoutOf, stage, id))`. Returns the step re-read after the write. |
| `updateStep({ stepId, name, teamId, instructions })`                         | also writes `instructions` (null clears).                                                                                                                                                                                                    |
| `moveStep`                                                                   | becomes `writeLayout(move(layoutOf(step.workflowId), stepId, direction))`. Delete the three-statement swap and its JSDoc; move the reasoning to `writeLayout`'s JSDoc.                                                                       |
| `separateStep({ stepId })` **new**                                           | `writeLayout(separate(layoutOf, stepId))`.                                                                                                                                                                                                   |
| `removeStep`                                                                 | delete row, then `writeLayout(remove(layoutOf, stepId))` inside the same transaction (compose the statements; `withTransaction` does not nest).                                                                                              |
| `replaceWorkflows` (seed)                                                    | writes `stage` and `instructions`; a step with no `stage` gets previous stage + 1; validate with `WorkflowLayout.isValid` first and fail with `WorkflowRepositoryError` if not.                                                              |

New error: `StageNotFoundError { workflowId, stage }`.

All statements stay lowercase with positional interpolation as today. `Effect.fn("WorkflowRepository.<op>")` on every method.

## `src/lib/WorkflowRunRepository.ts`

### Creation

`insertRun` copies `stage` and `instructions` from the definition step into `WorkflowRunStep`; `startedAt`, `startedBy`, `note` start null.

### Ready predicate as a reusable fragment

```ts
/** A step is ready when nothing in an earlier stage is still open. */
const readyWhere = (alias: string) =>
  sql.literal(`
  ${alias}.completedAt is null and not exists (
    select 1 from WorkflowRunStep p
    where p.runId = ${alias}.runId and p.completedAt is null and p.stage < ${alias}.stage
  )`);
```

(Or build it as an `sql` fragment with the alias interpolated as a literal; either way, one definition used by `listQueue`, `startStep`, `completeStep`, `setStepNote`, `blockRun`, `dismissFlag`.)

### `recomputeStatus`

```sql
update WorkflowRun set
  status = (
    select case
      when count(*) = sum(completedAt is not null) then 'done'
      when sum(completedAt is not null) > 0 or sum(startedAt is not null) > 0 then 'active'
      else 'pending'
    end
    from WorkflowRunStep s where s.runId = WorkflowRun.id
  ),
  updatedAt = ?
where id = ?
```

`uncancelRun` already calls this and therefore picks up the Start rule for free.

### `listQueue({ teamIds })` → `readonly QueueRow[]`

Repository returns one row per run with `steps` = ready steps whose `teamId ∈ teamIds`, ordered as today (flagged first, then `createdAt`). Query shape: select every ready step of every run that has at least one ready step for the teams (so siblings owned by other teams are in hand), then the runs with `max(stage) as stageCount`, then group in TypeScript into `{ run, steps, stageCount, note }` where `steps` are the caller's and each step's `siblings` are the rest of its stage. The repository does not know member emails; it returns `startedBy` ids and `ShopAgent.listQueue` joins emails (below).

### New and changed actions

Common guard, factored as one helper `requireActionable({ runStepId, teamIds })`:

```text
step exists                          else RunNotFoundError
run.status not in (done, cancelled)  else RunTerminalError
step.teamId ∈ teamIds                else RunNotAllowedError
```

| Method                                                | Extra rule                                                                                                                                | Writes                                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startStep({ runStepId, memberId, teamIds })`         | step must be ready else `StepNotReadyError`; if already started, succeed without changing `startedAt`/`startedBy` (no takeover, no error) | `startedAt = now, startedBy = memberId` when null; `recomputeStatus`                                                                                     |
| `completeStep(...)`                                   | step must be ready else `StepNotReadyError` (rename of `StepNotCurrentError`; keep the class, rename tag and message)                     | as today; additionally set `startedAt = coalesce(startedAt, now)`, `startedBy = coalesce(startedBy, memberId)` so a Done without Start still records who |
| `setStepNote({ runStepId, memberId, teamIds, note })` | no readiness requirement (a note on a done step is allowed; the run must be non-terminal)                                                 | `note = ?`, `WorkflowRun.updatedAt = now`                                                                                                                |
| `blockRun({ runId, memberId, teamIds, reason })`      | run non-terminal; at least one ready step's team ∈ teamIds else `RunNotAllowedError`                                                      | `flag = 'blocked', flagAt = now, flagDetail = { reason, by }`, `updatedAt`. Overwrites any prior flag.                                                   |
| `dismissFlag`                                         | change "current step's team" to "any ready step's team ∈ teamIds"                                                                         | unchanged                                                                                                                                                |

Everything in one `sql.withTransaction` per action, as `completeStep` is today. Reconcile flags still overwrite `blocked` (later flag wins, per `workflow-runs-spec.md`); accepted, and the queue copy for a reconcile flag already explains itself.

## `src/lib/ShopAgent.ts`

### Embedded callables (`@callable()`, socket)

```text
addStep({ workflowId, name, teamId, instructions? })          → StepResult      (existing; input gains instructions)
addParallelStep({ workflowId, stage, name, teamId, instructions? }) → StepResult   (new; StageNotFoundError → { _tag: "NotFound" })
updateStep({ stepId, name, teamId, instructions? })           → StepResult      (existing)
moveStep, removeStep                                          → StepResult      (existing, unchanged surface)
separateStep({ stepId })                                      → StepResult      (new)
getWorkflowDetail                                             → WorkflowDetailView   (steps now carry stage, instructions)
```

Same construction as `addStep` today: `callableEffect("ShopAgent.<op>", Domain.<Input>, { onExcessProperty: "error" })`, wrapped in `stepResult`, `workflowWritable` and `activeTeam` checks, `notifyChanged()` after a write. `stepResult`'s error union gains `StageNotFoundError`.

### Member-area RPC (plain methods, not `@callable()`)

```text
listQueue({ teamIds })                              → readonly QueueItem[]
   loads rows from the repository, then joins startedByEmail from
   (yield* Repository).listMembers(shop) — one D1 read per call, mapped by Member.id
startStep({ runStepId, memberId, teamIds })         → RunResult
completeStep(...)                                   → RunResult   (existing)
setStepNote({ runStepId, memberId, teamIds, note }) → RunResult
blockRun({ runId, memberId, teamIds, reason })      → RunResult
dismissFlag(...)                                    → RunResult   (existing)
```

`runResult` maps `StepNotReadyError → { _tag: "NotReady" }`. Every write ends with `notifyChanged()`.

### Logging

Existing format. New lines:

```text
ShopAgent.startStep:   shop=<shop> runId=<id> step=<position> memberId=<id>
ShopAgent.setStepNote: shop=<shop> runId=<id> step=<position> memberId=<id>
ShopAgent.blockRun:    shop=<shop> runId=<id> memberId=<id>
ShopAgent.separateStep / addParallelStep: shop=<shop> workflowId=<id> stage=<n>
```

Annotate the same fields. Never put `note`, `reason`, or `instructions` in the message.

## `src/lib/ShopAgentClient.ts`

Add `startStep`, `setStepNote`, `blockRun` beside `completeStep` and `dismissFlag`, same signature style `(shop, input) => Effect<Result, ...>`.

## Browser

### `src/routes/app.workflows.$workflowId.tsx` (editor)

Render steps grouped by stage using `WorkflowLayout.stagesOf` over the detail's steps (the module is pure, so it imports fine client-side). Layout per the research mockup:

```text
 1  Prepare artwork      Design       [↑] [↓] [Separate] [Remove]
 1  Pick materials       Stockroom    [↑] [↓] [Separate] [Remove]
    + Add a step that happens at the same time
 2  Produce              Production   [↑] [↓]            [Remove]
    + Add a step that happens at the same time
 3  Inspect              QC           [↑] [↓]            [Remove]
    + Add a step that happens at the same time
 ------------------------------------------------------------
 Add step   [name] [team ▾] [instructions]   [Add]
```

- Keep the existing `<s-table>`; the first column shows the **stage** number, not position. Rows in a multi-step stage get a subtle left accent or a "together" badge so the shared number reads as intentional.
- **Separate** appears only on rows whose stage has more than one step. Calls `separateStep`.
- **"Add a step that happens at the same time"** is an inline row under each stage's last step: name + team select, submits `addParallelStep` with that stage. One open inline form at a time (local state `openParallelStage: number | null`).
- The existing add-step form at the bottom stays; it creates a new stage.
- Instructions: a `<s-text-area>` (or `<s-text-field multiline>`, whichever the Polaris web components in this repo expose; check `app.orders.$orderId.tsx` for precedent) in the edit row and in both add forms. Blank submits clear to null.
- Mutations follow the existing `useMutation` + `invalidate` pattern; `StepResult` tags map to the same banners; `NotFound` from `addParallelStep` says "That step group no longer exists. Refresh."
- The "Needs attention" banner logic is unchanged.

Sentence under the table heading, always visible: "Steps with the same number happen at the same time. The next number waits until all of them are done."

### `src/routes/shop.$shop.queue.tsx` (member queue)

One card per `QueueItem` (per run). Inside the card, one block per ready step in `item.steps`:

```text
#1042 · Necklace workflow                      [In progress]  (badge when run.status = active)
Personalised necklace × 1
Personalization: Engraving: "M + J"
Order note: gift wrap please

  Step 1 of 3 · Prepare artwork           together with: Pick materials (Stockroom)
  Instructions: Export the artwork at 300 dpi ...
  In progress since 10:42 by alex@shop.com          ← when startedAt set
  [Start] [Done] [Note ▾]                            ← Start hidden once started
  Note: "Customer confirmed spelling by phone"      ← editable inline; empty saves null

[Block]  [Dismiss]  (Dismiss only when flagged)
```

- "Step k of n" is `step.stage` of `item.stageCount`. "together with" lists `step.siblings`: the other steps in the same stage that are not in `item.steps` because another team owns them. The repository computes `stageCount` as `max(stage)` per run and `siblings` from the same step rows it already loads; both are what make parallel work legible to a worker.
- New server fns `startStepFn`, `setStepNoteFn`, `blockRunFn`, mirroring `completeStepFn` (`memberServerFnMiddleware`, `requireMember`, `Schema.toStandardSchemaV1` validators, `router.invalidate()` on success).
- Block asks for an optional reason via a small inline form (a text field that appears on click); submitting with an empty reason is allowed.
- Flag copy gains: `blocked` → "Blocked: <reason>" or "Blocked." when no reason. Flagged runs already sort first.
- `NotReady` result → banner "Someone finished an earlier step just now, or this step is waiting on another team. Refresh."

### `src/routes/app.orders.$orderId.tsx` (embedded order page)

Where the run's steps render: mark every ready step as current (there can be several), show the stage number, show `startedAt`/`completedAt` state, show the note in subdued text when present. Progress copy becomes "Stage k of m". Blocked flag renders with the reason. Update the JSDoc at the "current step is the lowest-position open one" comment to the ready rule.

### `src/routes/app.workflows.index.tsx`

No change beyond what `stepCount` already shows. Optional: "3 steps in 2 groups". Skip unless trivial.

## Seed — `scripts/seed.ts`, `src/routes/api.dev.seed.ts`

Keep the existing `Workflow {i}` fixtures. Add one named workflow that exercises stages so the queue can be tried by hand:

```ts
{
  name: "Necklace",
  tags: ["necklace"],
  steps: [
    { name: "Prepare artwork", team: teamName(1), stage: 1, instructions: "Export artwork at 300 dpi, check spelling against the order." },
    { name: "Pick materials",  team: teamName(2), stage: 1 },
    { name: "Produce",         team: teamName(3), stage: 2 },
    { name: "Inspect",         team: teamName(1), stage: 3 },
  ],
}
```

`api.dev.seed.ts` passes `stage` and `instructions` through to `SeedWorkflowsInput`. Steps without `stage` remain linear.

## Tests

### `test/integration/workflow-layout.test.ts` (new, pure)

- `normalize` renumbers `1 1 3 3 5` stages to `1 1 2 2 3` and positions to `1..n`.
- `append` adds a new last stage; `appendParallel` places the step after the last member of that stage and shifts later positions.
- `move` within a stage reorders only; `move` across a boundary adopts the neighbour's stage and closes an emptied stage; edges are no-ops.
- `separate` on a solo step is a no-op; on a member of a 3-step stage yields `[others] → [it]` in a new stage; then `move` up of a following step joins it (the research appendix round trip).
- `remove` from a stage of one closes the gap in both stages and positions.
- `isValid` rejects non-dense stages, decreasing stages, duplicate positions.

### `test/integration/workflow-repository.test.ts`

- Replace "add/move/remove keep positions dense" with the same plus stages: build `1 1 2 3`, move step 3 up (joins stage 1 → `1 1 1 2`), separate one (`1 1 2 3`), remove a solo step (`1 1 2`), `addParallelStep` into stage 2 (`1 1 2 2`), `addParallelStep` into stage 9 → `StageNotFoundError`.
- `updateStep` writes and clears `instructions`.
- `replaceWorkflows` with explicit stages round-trips; with an invalid layout fails.

### `test/integration/workflow-run-repository.test.ts`

Add a fixture workflow with stages `1 1 2 3` (teams A, B, C, A). Then:

- Run creation copies `stage` and `instructions`.
- `listQueue` for team A shows one item with one ready step (stage 1); for `[A, B]` one item with two steps; for C nothing until both stage-1 steps are done; `stageCount = 3`; `siblings` of A's stage-1 step names B's.
- `completeStep` on the stage-2 step while a stage-1 step is open → `StepNotReadyError`; after both stage-1 steps → succeeds; last step → run `done`.
- `startStep`: sets `startedAt/startedBy`, run becomes `active` with zero completed steps; second `startStep` by another member leaves the original `startedBy`; on a not-ready step → `StepNotReadyError`; wrong team → `RunNotAllowedError`.
- `completeStep` without prior start backfills `startedAt/startedBy`.
- `setStepNote` writes, overwrites, clears with null; allowed on a done step of an active run; refused on a cancelled run.
- `blockRun` sets flag with reason and `by`; refused when no ready step belongs to the caller's teams; `dismissFlag` clears it; a later reconcile flag overwrites `blocked` (assert, since it is a documented consequence).
- Reconcile: a run with a started but uncompleted step is `active` and therefore flagged, not cancelled, when its line item goes to zero.

### `test/integration/shop-agent-workflows.test.ts`

- `addParallelStep` on a missing stage → `{ _tag: "NotFound" }`; on an archived workflow → `Archived`; with an inactive team → `TeamNotActive`.
- `separateStep` on unknown step → `NotFound`.

### `test/integration/member-area.test.ts`

- `startStep`, `setStepNote`, `blockRun` server fns reject a step/run outside the member's teams with `NotAllowed`; `listQueue` returns `startedByEmail` for a started step.

### Browser smoke (optional, headed Playwright per `AGENTS.md`)

Seed → open Necklace workflow → confirm two rows share number 1 → member of team 1 sees "Prepare artwork" with "together with: Pick materials" → Start → Done → member of team 3 sees nothing until team 2 finishes → then sees "Produce".

## Implementation order

1. `Domain` additions and renames (`NotReady`), `WorkflowLayout.ts` with its tests → `pnpm typecheck && pnpm test`.
2. Schema edit in `initializeSchema`; reset local state.
3. `WorkflowRepository`: `writeLayout`, `addParallelStep`, `separateStep`, rewritten `moveStep`/`removeStep`, `instructions`, seed path → tests.
4. `WorkflowRunRepository`: copy `stage`/`instructions`, `readyWhere`, `recomputeStatus`, `listQueue` grouping with `stageCount` and `siblings`, `startStep`, `setStepNote`, `blockRun`, `dismissFlag` change → tests.
5. `ShopAgent` callables and RPC, `ShopAgentClient`, logging → tests.
6. Editor route, queue route, order detail route.
7. Seed fixture; `pnpm seed`; hand check in the browser.
8. `pnpm typecheck && pnpm lint && pnpm test && pnpm fmt` (keep every file `fmt` touches).

## Effect v4 conventions to hold to

- Namespace imports only: `import { Effect, Schema, Option, Layer, Clock } from "effect"`, `import * as Domain from "@/lib/Domain"`, `import * as WorkflowLayout from "@/lib/WorkflowLayout"`.
- Services stay `Context.Service` classes with a static `layer` built by `Layer.effect`; methods wrapped in `Effect.fn("Service.method")`; typed failures are `Schema.TaggedError` classes and appear in the method's error channel, never thrown.
- Expected outcomes cross the RPC seam as result unions (`StepResult`, `RunResult`), mapped from tagged errors in `stepResult` / `runResult` exactly as the existing callables do.
- `Clock.currentTimeMillis` for time, never `Date.now()`.
- Pure layout logic in `WorkflowLayout.ts` has no Effect in it at all; the repository is the only place it meets SQL.
- Immutability: `readonly` arrays and fields everywhere; `toSorted` over `sort`.
- Logging via `Effect.logInfo(...)` + `Effect.annotateLogs({...})`, single-string messages, per `AGENTS.md`.

## Deferred hooks (unchanged from the research doc)

Lanes (`laneId`, `lanePosition`), skip action, reopen step, per-unit `completedQuantity`, order-level workflow (`lineItemId` nullable). None of these require changing anything in this spec.

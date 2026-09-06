# Step reordering versus parallelism in the workflow editor — research, spec, and plan

Research date: 2026-09-06. Revisits one decision from `workflow-stages-spec.md` (2026-09-03): what "move a step earlier / later" does when the neighbouring step is in a different stage. Everything else in that spec stands.

This document will go stale and be deleted. Every rule that matters lives in the code as a JSDoc (see **JSDoc text to embed** below), and the tests are the executable spec. Read this for the reasoning; read `src/lib/WorkflowLayout.ts` for the truth.

## The problem

Today `WorkflowLayout.move` swaps a step with its neighbour and the step **adopts the neighbour's stage**. Within a stage that is a reorder. Across a stage boundary it is a merge: the step joins the neighbouring stage and becomes parallel with it. One button, two outcomes, and the second one changes what happens on the production floor. From `Cut | Engrave | Polish`, pressing "Move earlier" on Polish yields `Cut | Engrave, Polish`: the engraver and the polisher now both receive the item at once. The merchant asked for an order change and got a concurrency change.

The current editor papers over this by relabelling the button at the boundary ("Join the previous stage"). That is honest but it is still the wrong shape: the one action a merchant reaches for most, "put this before that", is missing whenever the neighbour is alone in its stage, which in a freshly built workflow is always.

## First principles

An item workflow answers two independent questions per step:

1. **What comes before it?** Ordering. Decided when the workflow is laid out; rarely revisited.
2. **What happens alongside it?** Parallelism. Decided later, when a merchant notices two teams could work at once.

They are different decisions made at different moments with different consequences. A stage is a run-time fact: every step in it gets a run step at once, and the next stage waits for all of them. Merging must therefore be deliberate and named. Reordering must never merge.

Three consequences:

- **Ordering gestures only reorder.** A moved step slides past the whole neighbouring stage and lands alone in a stage of its own. Its former stage-mates stay together.
- **Parallelism is an explicit, reversible toggle** on a step: "Run alongside the previous step" merges it into the stage before; "Run on its own" splits it back out. The label names the consequence.
- **A parallel stage is a set, not a list.** Order within a stage means nothing to the run, so the editor never offers to reorder inside one.

Why this fits Baton rather than a generic list editor: workflows are short (≤ 20 steps, typically 3–6), the editor already draws stages as blocks, and every arrangement is reachable with slide-past and merge in a handful of clicks. Drag-and-drop and "move to position N" buy nothing here.

## Decisions (2026-09-06)

| #   | Decision                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `move` never changes which steps share a stage, except that the moved step always ends **alone**.                                                                     |
| 2   | A new `join` operation merges a step into the **previous** stage. There is no "join next"; moving later then joining covers it.                                       |
| 3   | `separate` stays: the step leaves a shared stage into a stage of its own **after** its mates. It is the inverse of `join`.                                            |
| 4   | Item editor only (`app.workflows.$workflowId_.edit.tsx`). The order workflow is out of scope: it is due a full revamp later and is not touched here beyond compiling. |
| 5   | The RPC name `moveStep` and its input (`stepId`, `direction`) are unchanged; only the semantics change. `joinStep` is new. No schema change.                          |
| 6   | The layout invariants and every operation stay in `WorkflowLayout.ts` as pure functions over `Placed[]`, persisted whole by the repository, as today.                 |
| 7   | Half-stage arithmetic is an implementation detail of `WorkflowLayout`, never visible to the client. The client sends intents, not positions.                          |

## Spec (normative)

### Vocabulary

`Placed = { id, position, stage }`. A **layout** is a `Placed[]` satisfying: positions dense `1..n`; stages dense `1..m` and non-decreasing along position. `normalize` restores both from any array whose `(stage, position)` order is meaningful. Fractional stages are allowed as inputs to `normalize` and never survive it.

Notation below: `a1 b1 c2 d3` means steps `a`,`b` in stage 1, `c` in stage 2, `d` in stage 3, positions in written order. `|` separates stages in prose.

### `move(layout, id, "up" | "down")`

The step leaves its stage and takes a **new stage of its own** on the far side of the neighbouring stage boundary.

- Solo step, `up`: new stage immediately **before the previous stage**. From `a1 b2 c3`, move `c` up → `a1 c2 b3`.
- Solo step, `down`: new stage immediately **after the next stage**. From `a1 b2 c3`, move `a` down → `b1 a2 c3`.
- Shared step, `up`: new stage immediately **before its current stage**; mates stay. From `a1 b2 c2 d3`, move `c` up → `a1 c2 b3 d4`.
- Shared step, `down`: new stage immediately **after its current stage**; mates stay. From `a1 b2 c2 d3`, move `b` down → `a1 c2 b3 d4`.
- No-ops: solo step in stage 1 moved up; solo step in the last stage moved down; unknown id. A shared step in stage 1 moved up is **not** a no-op (it becomes a new stage 1 ahead of its mates).

Invariant the tests pin: after `move`, the moved step is alone in its stage, and the partition of every other step into stages is unchanged.

### `join(layout, id)`

The step merges into the **previous stage**, placed after that stage's last member.

- From `a1 b2 c3`, join `c` → `a1 b2 c2`.
- From `a1 b2 c2 d3`, join `d` → `a1 b2 c2 d2`.
- From `a1 b1 c2`, join `c` → `a1 b1 c1`.
- Shared step joining: from `a1 b2 c2`, join `c` → `a1 c1 b2`. Its mates stay behind.
- No-ops: a step in stage 1; unknown id.

Invariant: after `join`, the step's stage is exactly `previous stage of its former stage`, and every other step's stage membership is unchanged (up to renumbering).

### `separate(layout, id)` — unchanged

The step leaves a shared stage into a new stage immediately **after** it. No-op when solo. From `a1 b1 c1 d2`, separate `b` → `a1 c1 b2 d3`.

`join` then `separate` on the same step returns to the original shape; the tests assert the round trip.

### Editor controls

Per selected step, in the step panel:

| Situation                 | Controls shown                                                        |
| ------------------------- | --------------------------------------------------------------------- |
| Solo, not first, not last | **Move earlier**, **Move later**, **Run alongside the previous step** |
| Solo, first               | **Move later**                                                        |
| Solo, last                | **Move earlier**, **Run alongside the previous step**                 |
| Shared, any               | **Move earlier**, **Move later**, **Run on its own**                  |

- "Move earlier" / "Move later" call `moveStep`. Never relabelled; they always mean the same thing.
- "Run alongside the previous step" calls `joinStep`. Hidden for a step in stage 1.
- "Run on its own" calls `separateStep`. Shown only for a shared step.
- The panel's explanatory copy stays: "Steps inside one dashed block run at the same time. The next stage waits for all of them."
- The order-workflow editor (`components/WorkflowDetail.tsx`) is **not** changed. It shares `moveStep`, so its Up / Down buttons inherit the new semantics; that is accepted, since the order workflow is due its own revamp. Its call sites are touched only where a rename below requires it.

Accepted redundancy: for a shared step, "Move later" and "Run on its own" produce the same layout. Both stay because they answer different questions the merchant asks ("where does this go?" versus "does this run with the others?"). Do not collapse them.

### What does not change

Adding a step (`addStep` → new last stage), adding a parallel step (`addParallelStep` → into an existing stage), removing a step, the ready rule on runs, the draft lifecycle, the `Placed` shape, `normalize`, `isValid`, `stagesOf`, and the SQL persistence in `writeLayout`.

## Implementation plan

Files, in order. Each step leaves typecheck, lint, and tests green.

### 1. `src/lib/WorkflowLayout.ts`

Replace `move`; add `join`; keep everything else. Pure functions, no Effect, no mutation.

```ts
export const move = (
  layout: Layout,
  id: string,
  direction: Domain.StepDirection,
): Layout => {
  const sorted = normalize(layout);
  const step = sorted.find((p) => p.id === id);
  if (step === undefined) return sorted;
  const shared = sorted.some((p) => p.id !== id && p.stage === step.stage);
  const last = maxOf(sorted, "stage");
  if (!shared && (direction === "up" ? step.stage === 1 : step.stage === last))
    return sorted;
  // The boundary the step crosses: its own stage's edge when it has mates,
  // the neighbouring stage's far edge when it is alone.
  const stage =
    direction === "up"
      ? (shared ? step.stage : step.stage - 1) - 0.5
      : (shared ? step.stage : step.stage + 1) + 0.5;
  return normalize(
    sorted.map((p) =>
      p.id === id
        ? { ...p, stage, position: direction === "up" ? 0 : sorted.length + 1 }
        : p,
    ),
  );
};

export const join = (layout: Layout, id: string): Layout => {
  const sorted = normalize(layout);
  const step = sorted.find((p) => p.id === id);
  if (step === undefined || step.stage === 1) return sorted;
  return normalize(
    sorted.map((p) =>
      p.id === id
        ? { ...p, stage: step.stage - 1, position: sorted.length + 1 }
        : p,
    ),
  );
};
```

Why the `position` writes: `normalize` sorts by `(stage, position)`. A fractional stage already places the step between two stages, so any position works there; `0` and `n + 1` are chosen only so the moved step is unambiguous relative to steps that share the fractional value (there are none, but the intent reads at a glance). In `join` the step must sort **after** the previous stage's members, whose positions are all `≤ n`, so `n + 1` is required, not decorative.

### 2. `src/lib/Domain.ts`

Add after `SeparateStepInput`:

```ts
/** `joinStep`: the step merges into the previous stage, after that stage's last member. */
export const JoinStepInput = StepIdInput;
export type JoinStepInput = typeof JoinStepInput.Type;
```

Update the `StepDirection` / `MoveStepInput` JSDoc to the text under **JSDoc text to embed**.

### 3. `src/lib/WorkflowRepository.ts`

- Interface: update the `moveStep` doc comment; add `joinStep` with the same error union as `separateStep`.
- Implementation: `joinStep` is one line, mirroring `separateStep`:

```ts
joinStep: Effect.fn("WorkflowRepository.joinStep")(function* ({
  stepId,
}: {
  readonly stepId: string;
}) {
  yield* relayout(stepId, (layout) => WorkflowLayout.join(layout, stepId));
}),
```

`relayout` already finds the editable step (creating the draft on first change), rewrites the whole layout inside one transaction, and touches the draft. Nothing else changes.

### 4. `src/lib/ShopAgent.ts`

Add `joinStep` next to `separateStep`, same shape: `@callable()`, `callableEffect("ShopAgent.joinStep", Domain.JoinStepInput, { onExcessProperty: "error" })`, `getStep` first so a missing step maps to `NotFound` and the log line carries `workflowId` and `stage`, then `repository.joinStep`, then `Effect.logInfo` with `shop=… workflowId=… stage=…` and matching `Effect.annotateLogs`. Returns `{ _tag: "Ok", step: null }` through `stepResult`.

### 5. Editors

`src/routes/app.workflows.$workflowId_.edit.tsx`:

- Add `joinStepMutation` (copy `separateStepMutation`, call `stub.joinStep`), include it in `busy`.
- Remove `moveLabel`; the buttons are always "Move earlier" / "Move later".
- Disabled rules from the table above, computed from `selected.stage`, `sharesStage(selected)`, and the last stage number, **not** from array index. Index-based "first / last" is wrong for a shared step: a step at index 0 that shares stage 1 can still move up.
- Replace the "Give it a stage of its own" button with the toggle: `sharesStage(selected)` → "Run on its own" (`separateStep`), else if `selected.stage > 1` → "Run alongside the previous step" (`joinStep`).

`src/components/WorkflowDetail.tsx` (order workflow): no behaviour change. Only the mechanical fallout of the vocabulary decision below, if any.

### 6. Tests

`test/integration/workflow-layout.test.ts` — rewrite the `move` case and add `join`; keep the helpers. Each case pins a shape and runs `check` (validity + same ids). Cases to cover, using the examples from the spec: solo up, solo down, shared up, shared down, shared in stage 1 up, edges as no-ops, unknown id, and the invariant "moved step is alone and every other step's stage partition is unchanged" checked generically over a few layouts. For `join`: solo joins previous, shared joins previous leaving mates, join into a shared stage lands last, stage 1 no-op, unknown id, and the `join → separate` round trip.

`test/integration/workflow-repository.test.ts` — two cases walk the old semantics ("Linear steps are each their own stage, so a move joins the neighbour's stage" at ~L221–234, and "move joins, separate splits" at ~L285–298). Rewrite their expected shapes to the new rules and add a `joinStep` call to each so the repository path is exercised end to end. The draft-forking case at ~L992 uses `moveStep` then `separateStep` on `finish`. Under the new rules `finish` (solo, last) moved up becomes its own stage **before** `Cut`, and `separate` is then a no-op, so the draft reads `Finish1 Cut22 Pack3 Label3` in position order. Update the expected array to `["Finish1", "Cut22", "Pack3", "Label3"]`; the point of that case (edits land on the draft, the workflow is untouched) is unaffected.

`test/integration/shop-agent-workflows.test.ts` — extend the `addParallelStep and separateStep` case with `joinStep`: missing step → `NotFound`, then join the separated step back and assert both are in stage 1 again.

`e2e/workflows.spec.ts` — required. Extend the existing draft walk-through after the second step exists: press "Run alongside the previous step" on it and assert the "Stage 1 · at the same time" label appears and "Stage 2" is gone; press "Run on its own" and assert the reverse; press "Move earlier" on the second step and assert the two step cards swap order while both stage labels stay solo. Drive the step-panel buttons from inside the frame (they are not hoisted). Keep the spec's own timeout, as the file's header explains.

### 7. Housekeeping

`pnpm typecheck`, `pnpm lint`, `pnpm test`, then `pnpm fmt` and keep every file it touches. Update `docs/workflow-stages-spec.md` → "Editor operations, as pure functions" to point at this document's decisions or, better, delete the stale paragraph there since the JSDoc now carries it.

## JSDoc text to embed

These are the sentences that must survive after this document is gone. Put them where indicated; adapt wording to the surrounding style but keep every claim.

**`WorkflowLayout.ts`, module header** — replace the paragraph starting "Sorting by stage first is what makes…" with:

> Two families of operation, kept deliberately separate. **Ordering** (`move`) changes where a step sits and always leaves it alone in a stage of its own; it never changes which other steps share a stage. **Parallelism** (`join`, `separate`) changes only which stage a step belongs to. A stage is a run-time fact — every step in it is ready together and the next stage waits for all of them — so making two steps parallel must be a deliberate, named action and never a side effect of reordering. Within a stage order carries no meaning, so nothing here reorders inside one.

**`WorkflowLayout.move`**:

> The step slides past the neighbouring stage boundary into a **new stage of its own**: before the previous stage when alone and moving up, after the next stage when alone and moving down, and just outside its own stage when it has mates (which stay together). Implemented as a fractional stage that `normalize` resolves; the `position` write only matters for sort order among steps at the same stage value. No-op at either edge for a solo step and for an unknown id; a shared step in stage 1 can still move up, into a new stage 1 ahead of its mates.

**`WorkflowLayout.join`**:

> The step merges into the previous stage, after that stage's last member: `position` is set past every existing one so `normalize` sorts it last within the stage. Its former stage-mates, if any, stay behind. No-op in stage 1 and for an unknown id. Inverse of `separate`.

**`WorkflowLayout.separate`** — keep the existing text; add: "Inverse of `join`."

**`Domain.MoveStepInput`**:

> `moveStep`: the step takes a stage of its own past the neighbouring boundary (`WorkflowLayout.move`). Reordering never makes a step parallel with another; that is `joinStep`.

**`Domain.JoinStepInput`**: the one-liner in step 2.

**`WorkflowRepository` interface, `moveStep`**:

> The moved step always ends alone in its stage; other steps keep their stage-mates. A move past either edge is a no-op, not an error.

**`WorkflowRepository` interface, `joinStep`**:

> The step joins the previous stage, last among its members; no-op in stage 1. Lands on the draft, creating it on first change, like every step-id write.

**Editor step panel (item and order)** — a short comment above the controls:

> Three verbs, two decisions. Move earlier / Move later change order and never concurrency: the moved step always ends alone. Run alongside / Run on its own change concurrency and never order. Enabled state is decided from the step's stage, not its index: a step that shares stage 1 can still move earlier.

## Effect v4 conventions to hold to

- `WorkflowLayout` stays Effect-free: pure functions, `readonly` inputs, new arrays out, `toSorted` not `sort`.
- Repository methods are `Effect.fn("WorkflowRepository.<name>")(function* (…) { … })`, composing the existing `relayout` helper. No new transactions: `relayout` already owns one and Durable Object SQLite refuses to nest.
- Durable Object methods use `callableEffect` with the `Domain` schema and `onExcessProperty: "error"`, map repository errors through the existing `stepResult`, and log with a single string message plus `Effect.annotateLogs` carrying the same fields (`shop`, `workflowId`, `stage`).
- Errors are the existing tagged classes; `join` and `move` raise nothing new.
- Imports as namespaces: `import * as WorkflowLayout from "@/lib/WorkflowLayout"`, `import { Effect, Schema } from "effect"`.
- No type casts. Let `Effect.fn` and `Schema` infer.

## Vocabulary decision: `join` / `separate`

The code keeps one antonym pair across every layer: `WorkflowLayout.join` / `WorkflowLayout.separate`, `WorkflowRepository.joinStep` / `separateStep`, `ShopAgent.joinStep` / `separateStep`, `Domain.JoinStepInput` / `SeparateStepInput`. The merchant copy ("Run alongside the previous step" / "Run on its own") is a UI concern and does not leak into identifiers, exactly as "Move earlier" does not rename `moveStep`. Renaming `separateStep` to match the button would break the pair and force a matching rename of `join` for nothing. So: **no rename**, and `WorkflowDetail.tsx` is untouched.

## Open questions

None blocking. Two choices made here that a reviewer might reasonably reverse:

1. **No "join next".** A step can only merge backwards. Forwards is "Move later" then "Run alongside the previous step", two clicks. Adding a second toggle would make the panel busier for a case that is rare in practice.
2. **Shared-step move leaves the stage rather than being disabled.** The alternative is to show only "Run on its own" for a shared step and require splitting first. Leaving is one click instead of two and still never touches the mates, so it was preferred.

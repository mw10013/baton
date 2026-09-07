import type * as Domain from "@/lib/Domain";

/**
 * Pure layout arithmetic for a workflow's steps: no Effect, no SQL. The
 * repository projects `WorkflowStep` rows down to `Placed`, applies one of
 * these functions, and writes the result back whole. Keeping the two
 * invariants — positions dense `1..n`, stages dense `1..m` and non-decreasing
 * along position — in one small module means every edit is checked by the
 * same code and the SQL side never has to reason about gaps.
 *
 * Every function returns a new normalized array and mutates nothing. A
 * workflow holds at most `WorkflowLimits.maxSteps` steps, so nothing here
 * needs to be clever about cost.
 *
 * Two families of operation, kept deliberately separate. **Ordering**
 * (`move`) changes where a step sits and always leaves it alone in a stage of
 * its own; it never changes which other steps share a stage. **Parallelism**
 * (`join`, `separate`) changes only which stage a step belongs to. A stage is
 * a run-time fact — every step in it is ready together and the next stage
 * waits for all of them — so making two steps parallel must be a deliberate,
 * named action and never a side effect of reordering. Within a stage order
 * carries no meaning, so nothing here reorders inside one.
 */
export interface Placed {
  readonly id: string;
  readonly position: number;
  readonly stage: number;
}
export type Layout = readonly Placed[];

const byStageThenPosition = (a: Placed, b: Placed) =>
  a.stage - b.stage || a.position - b.position;

/**
 * Sort by `(stage, position)`, renumber positions `1..n`, then renumber stages
 * densely from 1. Sorting by stage first is what lets the other operations
 * express themselves as a single stage write — a fractional stage lands the
 * step between two existing ones — and come out as a contiguous block without
 * further bookkeeping. Fractional stages are legal inputs here and never
 * survive.
 */
export const normalize = (layout: Layout): Layout => {
  const sorted = layout.toSorted(byStageThenPosition);
  const stages = [...new Set(sorted.map((p) => p.stage))];
  return sorted.map((p, index) => ({
    id: p.id,
    position: index + 1,
    stage: stages.indexOf(p.stage) + 1,
  }));
};

const maxOf = (layout: Layout, key: "position" | "stage") =>
  layout.reduce((max, p) => Math.max(max, p[key]), 0);

/** New step in a new last stage. */
export const append = (layout: Layout, id: string): Layout =>
  normalize([
    ...layout,
    {
      id,
      position: maxOf(layout, "position") + 1,
      stage: maxOf(layout, "stage") + 1,
    },
  ]);

/**
 * New step into an existing stage, placed after that stage's last step.
 * Unchanged when the stage does not exist; the repository reports that case
 * as `StageNotFoundError` before calling this.
 */
export const appendParallel = (
  layout: Layout,
  stage: number,
  id: string,
): Layout => {
  const members = layout.filter((p) => p.stage === stage);
  if (members.length === 0) return layout;
  const last = maxOf(members, "position");
  return normalize([
    ...layout.map((p) =>
      p.position > last ? { ...p, position: p.position + 1 } : p,
    ),
    { id, position: last + 1, stage },
  ]);
};

/**
 * The step slides past the neighbouring stage boundary into a **new stage of
 * its own**: before the previous stage when alone and moving up, after the
 * next stage when alone and moving down, and just outside its own stage when
 * it has mates (which stay together). Implemented as a fractional stage that
 * `normalize` resolves; the `position` write only matters for sort order
 * among steps at the same stage value. No-op at either edge for a solo step
 * and for an unknown id; a shared step in stage 1 can still move up, into a
 * new stage 1 ahead of its mates.
 */
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

/**
 * The step merges into the previous stage, after that stage's last member:
 * `position` is set past every existing one so `normalize` sorts it last
 * within the stage. Its former stage-mates, if any, stay behind. No-op in
 * stage 1 and for an unknown id. Inverse of `separate`.
 */
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

/**
 * The step leaves its stage into a new stage of its own immediately after
 * it. Implemented by pushing the step and everything in a later stage up by
 * one stage number; `normalize` then keeps the step's position ordering.
 * No-op when the step is already alone in its stage. Inverse of `join`.
 */
export const separate = (layout: Layout, id: string): Layout => {
  const sorted = normalize(layout);
  const step = sorted.find((p) => p.id === id);
  if (step === undefined) return sorted;
  if (sorted.filter((p) => p.stage === step.stage).length === 1) return sorted;
  return normalize(
    sorted.map((p) =>
      p.id === id || p.stage > step.stage ? { ...p, stage: p.stage + 1 } : p,
    ),
  );
};

export const remove = (layout: Layout, id: string): Layout =>
  normalize(layout.filter((p) => p.id !== id));

/** The two invariants, plus unique ids. */
export const isValid = (layout: Layout): boolean => {
  const sorted = layout.toSorted((a, b) => a.position - b.position);
  const ids = new Set(sorted.map((p) => p.id));
  if (ids.size !== sorted.length) return false;
  return sorted.every((p, index) => {
    const previous = sorted[index - 1];
    if (p.position !== index + 1) return false;
    if (!Number.isInteger(p.stage)) return false;
    if (previous === undefined) return p.stage === 1;
    return p.stage === previous.stage || p.stage === previous.stage + 1;
  });
};

/** Steps grouped by stage in stage order, each group in position order — the shape the editor and queue render. */
export const stagesOf = <P extends Placed>(
  layout: readonly P[],
): readonly (readonly P[])[] => {
  const sorted = layout.toSorted(byStageThenPosition);
  const stages = [...new Set(sorted.map((p) => p.stage))];
  return stages.map((stage) => sorted.filter((p) => p.stage === stage));
};

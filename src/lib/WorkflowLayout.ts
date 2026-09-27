import type * as Domain from "@/lib/Domain";

/**
 * Pure layout arithmetic for a workflow's tasks: no Effect, no SQL. The
 * repository projects `WorkflowTask` rows down to `Placed`, applies one of
 * these functions, and writes the result back whole. This module owns the
 * step invariant stated on {@link Domain.WorkflowTask}, plus positions dense
 * `1..n`, so every edit is checked by the same code and the SQL side never has
 * to reason about gaps.
 *
 * Every function returns a new normalized array and mutates nothing. A
 * workflow holds at most `WorkflowLimits.maxTasks` tasks, so nothing here
 * needs to be clever about cost.
 *
 * Two families of operation, kept deliberately separate. **Ordering**
 * (`move`) changes where a task sits and always leaves it alone in a step of
 * its own; it never changes which other tasks share a step. **Parallelism**
 * (`join`, `separate`) changes only which step a task belongs to. A step is
 * a run-time fact, the wait between tasks, so making two tasks parallel must
 * be a deliberate, named action and never a side effect of reordering. Within
 * a step order carries no meaning, so nothing here reorders inside one.
 */
export interface Placed {
  readonly id: string;
  readonly position: number;
  readonly step: number;
}
export type Layout = readonly Placed[];

const byStepThenPosition = (a: Placed, b: Placed) =>
  a.step - b.step || a.position - b.position;

/**
 * Sort by `(step, position)`, renumber positions `1..n`, then renumber steps
 * densely from 1. Sorting by step first is what lets the other operations
 * express themselves as a single step write — a fractional step lands the
 * task between two existing ones — and come out as a contiguous block without
 * further bookkeeping. Fractional steps are legal inputs here and never
 * survive.
 */
export const normalize = (layout: Layout): Layout => {
  const sorted = layout.toSorted(byStepThenPosition);
  const steps = [...new Set(sorted.map((p) => p.step))];
  return sorted.map((p, index) => ({
    id: p.id,
    position: index + 1,
    step: steps.indexOf(p.step) + 1,
  }));
};

const maxOf = (layout: Layout, key: "position" | "step") =>
  layout.reduce((max, p) => Math.max(max, p[key]), 0);

/** New task in a new last step. */
export const append = (layout: Layout, id: string): Layout =>
  normalize([
    ...layout,
    {
      id,
      position: maxOf(layout, "position") + 1,
      step: maxOf(layout, "step") + 1,
    },
  ]);

/**
 * New task into an existing step, placed after that step's last task.
 * Unchanged when the step does not exist; the repository reports that case
 * as `StepNotFoundError` before calling this.
 */
export const appendTask = (
  layout: Layout,
  step: number,
  id: string,
): Layout => {
  const members = layout.filter((p) => p.step === step);
  if (members.length === 0) return layout;
  const last = maxOf(members, "position");
  return normalize([
    ...layout.map((p) =>
      p.position > last ? { ...p, position: p.position + 1 } : p,
    ),
    { id, position: last + 1, step },
  ]);
};

/**
 * The task slides past the neighbouring step boundary into a **new step of
 * its own**: before the previous step when alone and moving up, after the
 * next step when alone and moving down, and just outside its own step when
 * it has mates (which stay together). Implemented as a fractional step that
 * `normalize` resolves; the `position` write only matters for sort order
 * among tasks at the same step value. No-op at either edge for a solo task
 * and for an unknown id; a shared task in step 1 can still move up, into a
 * new step 1 ahead of its mates.
 */
export const move = (
  layout: Layout,
  id: string,
  direction: Domain.TaskDirection,
): Layout => {
  const sorted = normalize(layout);
  const task = sorted.find((p) => p.id === id);
  if (task === undefined) return sorted;
  const shared = sorted.some((p) => p.id !== id && p.step === task.step);
  const last = maxOf(sorted, "step");
  if (!shared && (direction === "up" ? task.step === 1 : task.step === last))
    return sorted;
  // The boundary the task crosses: its own step's edge when it has mates,
  // the neighbouring step's far edge when it is alone.
  const step =
    direction === "up"
      ? (shared ? task.step : task.step - 1) - 0.5
      : (shared ? task.step : task.step + 1) + 0.5;
  return normalize(
    sorted.map((p) =>
      p.id === id
        ? { ...p, step, position: direction === "up" ? 0 : sorted.length + 1 }
        : p,
    ),
  );
};

/**
 * The task merges into the previous step, after that step's last member:
 * `position` is set past every existing one so `normalize` sorts it last
 * within the step. Its former step-mates, if any, stay behind. No-op in
 * step 1 and for an unknown id. Inverse of `separate`.
 */
export const join = (layout: Layout, id: string): Layout => {
  const sorted = normalize(layout);
  const task = sorted.find((p) => p.id === id);
  if (task === undefined || task.step === 1) return sorted;
  return normalize(
    sorted.map((p) =>
      p.id === id
        ? { ...p, step: task.step - 1, position: sorted.length + 1 }
        : p,
    ),
  );
};

/**
 * The task leaves its step into a new step of its own immediately after
 * it. Implemented by pushing the task and everything in a later step up by
 * one step number; `normalize` then keeps the task's position ordering.
 * No-op when the task is already alone in its step. Inverse of `join`.
 */
export const separate = (layout: Layout, id: string): Layout => {
  const sorted = normalize(layout);
  const task = sorted.find((p) => p.id === id);
  if (task === undefined) return sorted;
  if (sorted.filter((p) => p.step === task.step).length === 1) return sorted;
  return normalize(
    sorted.map((p) =>
      p.id === id || p.step > task.step ? { ...p, step: p.step + 1 } : p,
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
    if (!Number.isInteger(p.step)) return false;
    if (previous === undefined) return p.step === 1;
    return p.step === previous.step || p.step === previous.step + 1;
  });
};

/** Tasks grouped by step in step order, each group in position order — the shape the editor and the workflows list render. */
export const stepsOf = <P extends Placed>(
  layout: readonly P[],
): readonly (readonly P[])[] => {
  const sorted = layout.toSorted(byStepThenPosition);
  const steps = [...new Set(sorted.map((p) => p.step))];
  return steps.map((step) => sorted.filter((p) => p.step === step));
};

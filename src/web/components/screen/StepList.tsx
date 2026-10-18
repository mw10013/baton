import type { ReactNode } from "react";
import { FramedList } from "./FramedList.tsx";
import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout.ts";

/** One step of a {@link StepList}: its caption and its entries, one keyed element each. */
export interface StepListStep {
  readonly key: string | number;
  readonly caption: string;
  readonly entries: ReactNode;
}

/**
 * A run's steps in order: an ordered list, one item per step, each a subdued caption over a
 * {@link FramedList} of the step's tasks. The steps are an ordered list because that is what they
 * are, and a screen reader says so. Steps are spaced by {@link BETWEEN_THINGS}; a caption sits
 * {@link BETWEEN_LINES} over its box.
 *
 * | part      | job                                                            | component  | fixes                                                                   | used on | never                       |
 * | --------- | -------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- | ------- | --------------------------- |
 * | step list | a run's steps in order: a caption over each step's framed list | `StepList` | an ordered list; `base` between steps, `small-300` from caption to box | details | a step without its caption  |
 */
export function StepList({ steps }: { readonly steps: readonly StepListStep[] }) {
  return (
    <s-stack accessibilityRole="ordered-list" gap={BETWEEN_THINGS}>
      {steps.map(({ key, caption, entries }) => (
        <s-stack key={key} accessibilityRole="list-item" gap={BETWEEN_LINES}>
          <s-text color="subdued">{caption}</s-text>
          <FramedList>{entries}</FramedList>
        </s-stack>
      ))}
    </s-stack>
  );
}

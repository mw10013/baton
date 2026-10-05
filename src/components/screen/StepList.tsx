import type * as React from "react";

import { FramedList } from "./FramedList";
import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout";

/** One step of a {@link StepList}: its caption and its entries, one keyed element each. */
export interface StepListStep {
  readonly key: string | number;
  readonly caption: string;
  readonly entries: React.ReactNode;
}

/**
 * A run's steps in order (the step-list row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): an ordered list, one item per step,
 * each a subdued caption over a {@link FramedList} of the step's tasks. The
 * steps are an ordered list because that is what they are, and a screen
 * reader says so. Steps are spaced by {@link BETWEEN_THINGS}; a caption sits
 * {@link BETWEEN_LINES} over its box.
 */
export function StepList({
  steps,
}: {
  readonly steps: readonly StepListStep[];
}) {
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

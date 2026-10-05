import type * as React from "react";

import { BETWEEN_LINES } from "./layout";

/**
 * A select and the button that submits it, side by side (the select-row row
 * of the parts table on `ScreenPart` in `src/lib/Screen.ts`): the order
 * page's Workflow select and Start, and its Assign team select and Assign.
 * `label` is an optional visible word before the select, for a select whose
 * own label is the verb and kept for screen readers.
 *
 * A grid, not an inline stack: a Polaris form control fills the inline size
 * it is given and has no width prop, so a select in an inline stack takes the
 * whole row and pushes the submit onto the next line at every width. The
 * select is at most 20rem, so a short option list does not stretch across a
 * wide card, and shrinks to the screen on a phone.
 */
export function SelectRow({
  label,
  select,
  submit,
}: {
  readonly label?: React.ReactNode;
  readonly select: React.ReactNode;
  readonly submit: React.ReactNode;
}) {
  return (
    <s-grid
      gridTemplateColumns={
        label === undefined
          ? "minmax(0, 20rem) auto"
          : "max-content minmax(0, 20rem) auto"
      }
      gap={BETWEEN_LINES}
      alignItems="center"
      justifyContent="start"
    >
      {label}
      {select}
      {submit}
    </s-grid>
  );
}

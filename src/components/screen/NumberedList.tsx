import type * as React from "react";

/**
 * What to do, in order (the numbered list row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): one action per item, a control's
 * label in bold as the screen prints it ("Press **Start**."). The bold is a
 * plain `<strong>`: `s-text type="strong"` is semantic only and draws text
 * at the paragraph's weight, so a label in it reads as running text. An ordered
 * list because the order is the content; Polaris's numbers and its spacing
 * between items, so every page's steps look alike. Not `StepList`:
 * that draws a workflow's steps, and "step" is the workflow's word.
 */
export function NumberedList({
  items,
}: {
  readonly items: readonly React.ReactNode[];
}) {
  return (
    <s-ordered-list>
      {items.map((item, index) => (
        <s-list-item key={index}>{item}</s-list-item>
      ))}
    </s-ordered-list>
  );
}

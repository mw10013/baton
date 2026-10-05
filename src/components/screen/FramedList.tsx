import * as React from "react";

import { BETWEEN_LINES } from "./layout";

/**
 * Entries that make one stop, in one bordered box with a rule between them
 * (the framed-list row of the parts table on `ScreenPart` in
 * `src/lib/Screen.ts`): the tasks of one step on the member's workflow page
 * and the order page's Manage drawer. One box per step, so a parallel step
 * reads as one stop before its caption is read; the rules separate its tasks
 * the way rules separate a list's rows. Each child is one entry, padded by
 * {@link BETWEEN_LINES}.
 */
export function FramedList({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <s-box borderWidth="base" borderRadius="base">
      {React.Children.toArray(children).map((child, index) => (
        <s-box
          key={(React.isValidElement(child) ? child.key : null) ?? index}
          padding={BETWEEN_LINES}
          borderWidth={index === 0 ? "none" : "base none none none"}
        >
          {child}
        </s-box>
      ))}
    </s-box>
  );
}

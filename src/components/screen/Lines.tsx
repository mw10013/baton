import type * as React from "react";

import { BETWEEN_LINES } from "./layout";

/**
 * The lines of one thing, stacked (the lines row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): a label over its value, a note over
 * its button, an item's variant over its SKU and properties. Spaced by
 * {@link BETWEEN_LINES}, the distance that says "these belong together";
 * things that do not belong together sit further apart, in a page body or a
 * section. `id` is an anchor for a link or a test, not a style hook.
 */
export function Lines({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: React.ReactNode;
}) {
  return id === undefined ? (
    <s-stack gap={BETWEEN_LINES}>{children}</s-stack>
  ) : (
    <s-stack id={id} gap={BETWEEN_LINES}>
      {children}
    </s-stack>
  );
}

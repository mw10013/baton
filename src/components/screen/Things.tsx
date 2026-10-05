import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * Things stacked in one place that are not one thing's lines (the things row
 * of the parts table on `ScreenPart` in `src/lib/Screen.ts`): a section's
 * banners and its content, the banners at the head of a page's main column.
 * Spaced by {@link BETWEEN_THINGS}; the lines of one thing are {@link Lines}.
 */
export function Things({ children }: { readonly children: React.ReactNode }) {
  return <s-stack gap={BETWEEN_THINGS}>{children}</s-stack>;
}

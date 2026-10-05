import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * Tiles side by side where there is room, one column where there is not
 * (the tiles row of the parts table on `ScreenPart` in `src/lib/Screen.ts`):
 * the home page's meters. `auto-fit` down to 300px, so two tiles share a row
 * where the embedded pane is wide enough for both, with no breakpoint to keep
 * in sync: a tile has a minimum width, not a screen.
 */
export function Tiles({ children }: { readonly children: React.ReactNode }) {
  return (
    <s-grid
      gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))"
      gap={BETWEEN_THINGS}
    >
      {children}
    </s-grid>
  );
}

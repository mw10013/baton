import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * Tiles side by side where there is room, one column where there is not: the home page's
 * meters. `auto-fit` down to 300px, so two tiles share a row where the embedded pane is wide
 * enough for both, with no breakpoint to keep in sync: a tile has a minimum width, not a screen.
 *
 * | part  | job                                                          | component | fixes                                                    | used on           | never        |
 * | ----- | ------------------------------------------------------------ | --------- | -------------------------------------------------------- | ----------------- | ------------ |
 * | tiles | tiles side by side where there is room, one column where there is not | `Tiles`   | `repeat(auto-fit, minmax(300px, 1fr))`; `base` between tiles | homepage, details | a breakpoint |
 */
export function Tiles({ children }: { readonly children: ReactNode }) {
  return (
    <s-grid gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap={BETWEEN_THINGS}>
      {children}
    </s-grid>
  );
}

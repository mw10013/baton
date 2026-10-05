import type * as React from "react";

import { BETWEEN_LINES } from "./layout";

/**
 * Things side by side on one line, wrapping when the line is full (the
 * inline row of the parts table on `ScreenPart` in `src/lib/Screen.ts`): a
 * task's name and its badge, a row of buttons, a run of badges. Centred on
 * the line, so a badge and a button sit level with the text beside them,
 * and spaced by {@link BETWEEN_LINES}.
 */
export function Inline({ children }: { readonly children: React.ReactNode }) {
  return (
    <s-stack direction="inline" gap={BETWEEN_LINES} alignItems="center">
      {children}
    </s-stack>
  );
}

import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * One subdued line between the title bar and the first card (the page-note
 * row of the parts table on `ScreenPart` in `src/lib/Screen.ts`): Last
 * updated on the workflow page. `s-page` leaves only its default distance
 * between a paragraph and the first `s-section`, which reads as the line
 * sitting on the card; Shopify Flow's workflow page leaves a full distance
 * there. The line is padded below by {@link BETWEEN_THINGS}, the distance
 * between two cards.
 */
export function PageNote({ children }: { readonly children: React.ReactNode }) {
  return (
    <s-box paddingBlockEnd={BETWEEN_THINGS}>
      <s-paragraph color="subdued">{children}</s-paragraph>
    </s-box>
  );
}

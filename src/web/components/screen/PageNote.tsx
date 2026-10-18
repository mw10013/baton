import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * One subdued line between the title bar and the first card: Last updated on the workflow page.
 * `s-page` leaves only its default distance between a paragraph and the first `s-section`, which
 * reads as the line sitting on the card; Shopify Flow's workflow page leaves a full distance
 * there. The line is padded below by {@link BETWEEN_THINGS}, the distance between two cards.
 *
 * | part      | job                                                                                       | component  | fixes                                                          | used on | never                                             |
 * | --------- | ----------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- | ------- | ------------------------------------------------- |
 * | page note | one subdued line between the title bar and the first card: Last updated on the workflow page | `PageNote` | `base` below it; the line's own column, lined up with the cards | details | a second line; a sentence that belongs in a card |
 */
export function PageNote({ children }: { readonly children: ReactNode }) {
  return (
    <s-box paddingBlockEnd={BETWEEN_THINGS}>
      <s-paragraph color="subdued">{children}</s-paragraph>
    </s-box>
  );
}

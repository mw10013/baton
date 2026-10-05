import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * The list's frame on every index (the index-section row of the parts table
 * on `ScreenPart` in `src/lib/Screen.ts`): one card with no padding, so the
 * list runs to the card's edge, as in Shopify's resource-list and
 * index-table compositions
 * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/resource-list.md`,
 * `index-table.md`). `head` holds what sits above the list, in this order:
 * banners, the strip or the search line, the filter row; padded and spaced
 * by {@link BETWEEN_THINGS}. `children` is the list: an `s-table`, the
 * resource rows, or an empty line.
 *
 * Not a bordered box inside a padded section: that is a card in a card, and
 * at 375px the double frame cost 32px of every line. A second list on one
 * screen (the open matches and the Done or closed matches of a search) is a
 * second `IndexSection`, not a second box in one card.
 */
export function IndexSection({
  label,
  head,
  children,
}: {
  /** The section's accessibility label: the list's noun ("Orders", "Workflows"). */
  readonly label: string;
  readonly head?: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  return (
    <s-section padding="none" accessibilityLabel={label}>
      {head !== undefined && head !== null && head !== false && (
        <s-box padding={BETWEEN_THINGS}>
          <s-stack gap={BETWEEN_THINGS}>{head}</s-stack>
        </s-box>
      )}
      {children}
    </s-section>
  );
}

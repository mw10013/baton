import type * as React from "react";

import { BETWEEN_LINES, sideBySide } from "./layout";

/**
 * The filter row (the filter-row row of the parts table on `ScreenPart` in
 * `src/lib/Screen.ts`): the main filter, the search, then a secondary
 * filter, each optional but the search. Side by side when the row's
 * container is wider than the breakpoint ({@link sideBySide}), stacked
 * below: the main filter 10rem, the secondary 12rem, the search the rest.
 * The selects' labels are hidden on screen and kept for screen readers (the
 * controls table's row for a filter beside a search, `Control` in
 * `src/lib/Screen.ts`); the route renders them so.
 *
 * Always above the list, in the index section's head, never in an
 * `s-table`'s `filters` slot: the slot pads itself by half the card's
 * padding, so a filter row in it sat at a different distance from the strip
 * than one above an empty list, and every screen had to correct for it.
 */
export function FilterRow({
  main,
  search,
  secondary,
}: {
  readonly main?: React.ReactNode;
  readonly search: React.ReactNode;
  readonly secondary?: React.ReactNode;
}) {
  const hasMain = main !== undefined && main !== null;
  const hasSecondary = secondary !== undefined && secondary !== null;
  if (!hasMain && !hasSecondary) return search;
  const wide = [
    ...(hasMain ? ["10rem"] : []),
    "1fr",
    ...(hasSecondary ? ["12rem"] : []),
  ].join(" ");
  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns={sideBySide(wide, "1fr")}
        gap={BETWEEN_LINES}
        alignItems="end"
      >
        {main}
        {search}
        {secondary}
      </s-grid>
    </s-query-container>
  );
}

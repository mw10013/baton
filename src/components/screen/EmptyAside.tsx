/**
 * An aside with nothing in it (the empty-aside row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): the workflow editor with no task
 * selected. `s-page` gives the aside a column of its own only while it is
 * filled, so dropping it reflows the canvas from 606px to 934px and back on
 * every card click (measured 2026-09-17). An empty `s-box` holds the column
 * open; an empty `s-section` would draw a card with nothing in it.
 */
export function EmptyAside() {
  return <s-box slot="aside" />;
}

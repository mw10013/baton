/**
 * An aside with nothing in it: the workflow editor with no task selected. `s-page` gives the
 * aside a column of its own only while it is filled, so dropping it reflows the canvas from 606px
 * to 934px and back on every card click (measured in legacy). An empty `s-box` holds the column
 * open; an empty `s-section` would draw a card with nothing in it.
 *
 * | part        | job                                                                 | component    | fixes                                              | used on | never                     |
 * | ----------- | ------------------------------------------------------------------- | ------------ | -------------------------------------------------- | ------- | ------------------------- |
 * | empty aside | an aside with nothing in it, holding the page's aside column open    | `EmptyAside` | the aside column's width while nothing is selected | editor  | a card with nothing in it |
 */
export function EmptyAside() {
  return <s-box slot="aside" />;
}

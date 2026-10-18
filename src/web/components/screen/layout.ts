/**
 * The only spacing values the parts under `src/web/components/screen/` use. A screen has two
 * distances, whatever the screen: between the lines of one thing, and between things. A value
 * nobody can pick is a value two screens cannot pick differently.
 *
 * Only parts import this: routes and the other components lay out nothing, and use no
 * `s-stack`, `s-grid`, `s-box` or spacing prop. A part that seems to need a third distance
 * needs its case argued first.
 */

/** Between the lines of one thing: a label over its value, a row of buttons. */
export const BETWEEN_LINES = "small-300";

/** Between things: a section's banners, its text, its form and its buttons. */
export const BETWEEN_THINGS = "base";

/**
 * Where "side by side" becomes "stacked", in pixels of the containing
 * section, not the viewport: a section inside `s-page inlineSize="small"` is
 * under 600px at every viewport, so a viewport breakpoint would never stack
 * there and would stack too late on a phone. 480 holds the widest filter
 * row (a 10rem main filter, the search and a 12rem secondary filter) with
 * room for the search to show its placeholder.
 */
export const SIDE_BY_SIDE_FROM = 480;

/**
 * A `gridTemplateColumns` value that is `wide` when the container is wider
 * than {@link SIDE_BY_SIDE_FROM} and `narrow` below it. The grid must sit in
 * an `s-query-container`. A track list carries no comma: a comma separates
 * a responsive value's conditions.
 */
export const sideBySide = (wide: string, narrow: string) =>
  `@container (inline-size > ${String(SIDE_BY_SIDE_FROM)}px) ${wide}, ${narrow}`;

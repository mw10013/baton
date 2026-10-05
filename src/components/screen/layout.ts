/**
 * The only spacing values and the only breakpoint the parts use (the parts
 * table on `ScreenPart` in `src/lib/Screen.ts`). On screen there are three
 * distances, whatever the screen: between the lines of one thing, between
 * things, and none. Eight gap values and eight padding values for those
 * three, and three breakpoints for one "side by side or stacked" decision,
 * were how two screens built the same shape a little differently; a value
 * nobody can pick is a value nobody can pick differently.
 *
 * Only parts import this: routes and the other components lay out nothing
 * (the lint rule on `layoutHits` in `scripts/lib/rules-lint.ts`). A part that seems to
 * need a fourth distance needs its row argued first.
 */

/** Between the lines of one thing: a row's lines, a label over its value, a field's parts. */
export const BETWEEN_LINES = "small-300";

/** Between things, and around a section's content: two rows of controls, a banner and a list. */
export const BETWEEN_THINGS = "base";

/** No space: a list frame's edge, so rows and tables run to the card's edge. */
export const NO_SPACE = "none";

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

import type * as React from "react";

/**
 * Shopify text or free text on a list: cut to two lines with an ellipsis
 * (the Shopify-text and free-text rows of the parts table on `ScreenPart` in
 * `src/lib/Screen.ts`). Polaris's own clamp, `lineClamp` on `s-paragraph`
 * and `s-heading`, rather than a hand-written `-webkit-box`: `s-text` has no
 * clamp, so a clamped sequence of `s-text` parts sits in an `s-paragraph`.
 *
 * Two lines, never one and never a prop: one line at 375px is about 40
 * characters, rarely a whole reason; two hold most reasons whole and the
 * start of any. A clamped value has a home where it prints whole (the
 * member's workflow page, the order page), and a row's accessible label
 * carries the item whole. Fixed words that must survive go ahead of the
 * clamp or after it on its own line, never inside it: a clamp cuts from the
 * end.
 *
 * `heading` gives the clamp a row's weight: line one of a resource row,
 * which Shopify's resource-list composition heads with `s-heading`.
 */
export function Clamp({
  children,
  heading = false,
  color,
}: {
  readonly children: React.ReactNode;
  readonly heading?: boolean;
  readonly color?: "subdued";
}) {
  if (heading) return <s-heading lineClamp={2}>{children}</s-heading>;
  return color === undefined ? (
    <s-paragraph lineClamp={2}>{children}</s-paragraph>
  ) : (
    <s-paragraph lineClamp={2} color={color}>
      {children}
    </s-paragraph>
  );
}

import type * as React from "react";

/**
 * A token or an identity (a SKU, a tag, an order number, an email, a shop
 * domain): printed whole, wrapping anywhere (the token row of the parts
 * table on `ScreenPart` in `src/lib/Screen.ts`). An unspaced string has no
 * word break, so the only choices are to break it anywhere or let it widen
 * its box past the screen; `.token` in `styles.css` breaks it. Inline, so a
 * token sits inside a sentence (`Started by <email>`).
 */
export function Token({
  children,
  color,
  href,
}: {
  readonly children: React.ReactNode;
  readonly color?: "subdued";
  /**
   * The token is a link (an email on the members index, the link to its
   * member page). The link sits inside the span, not inside an `s-text`, so
   * it keeps the link's colour and still breaks anywhere: `overflow-wrap`
   * is inherited into its shadow root.
   */
  readonly href?: string;
}) {
  if (href !== undefined)
    return (
      <span className="token">
        <s-link href={href}>{children}</s-link>
      </span>
    );
  return (
    <span className="token">
      {color === undefined ? (
        <s-text>{children}</s-text>
      ) : (
        <s-text color={color}>{children}</s-text>
      )}
    </span>
  );
}

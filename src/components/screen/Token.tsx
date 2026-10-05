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
}: {
  readonly children: React.ReactNode;
  readonly color?: "subdued";
}) {
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

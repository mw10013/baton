import type { ReactNode } from "react";

/**
 * A token or an identity (a SKU, a tag, an order number, an email, a shop domain): printed
 * whole, wrapping anywhere. An unspaced string has no word break, so the only choices are to
 * break it anywhere or let it widen its box past the screen; `.token` in `styles.css` breaks it.
 * Inline, so a token sits inside a sentence (`Delete <email>?`).
 *
 * | part  | job                                                    | component | fixes                                                                  | used on        | never                       |
 * | ----- | ------------------------------------------------------ | --------- | ---------------------------------------------------------------------- | -------------- | --------------------------- |
 * | token | a SKU, a tag, an order number, an email, a shop domain | `Token`   | on a list: whole, wraps anywhere, a link when it names a page; on its home: the same | index, details | a box wider than the screen |
 */
export function Token({
  children,
  color,
  link,
}: {
  readonly children: ReactNode;
  readonly color?: "subdued";
  /**
   * The token is a link (an email on the members index, the link to its member page): the
   * `href` and `onClick` a router navigation needs. The link sits inside the span, not inside an
   * `s-text`, so it keeps the link's colour and still breaks anywhere: `overflow-wrap` is
   * inherited into its shadow root.
   */
  readonly link?: { readonly href: string; readonly onClick: (event: Event) => void };
}) {
  if (link !== undefined)
    return (
      <span className="token">
        <s-link {...link}>{children}</s-link>
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

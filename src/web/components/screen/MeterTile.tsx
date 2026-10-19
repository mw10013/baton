import type { ReactNode } from "react";
import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout.ts";

/**
 * One capacity meter as a link: the dimension, the number, a bar and a sentence about it, the
 * whole tile a link to the screen that manages it. The bar is a native `progress` styled by
 * `.capacity-meter` in `styles.css`: Polaris has no meter, and a `progress` element carries the
 * value and maximum to a screen reader with its accessible name. The home page's one use: one
 * dimension of the plan, what the tier grants as the denominator, what the shop has as the
 * numerator, and a line saying what passing the denominator means. The link carries the `href`
 * and `onClick` a router navigation needs, since outside the admin nothing intercepts it.
 *
 * `limit` is the entitlement and never the count, so the bar measures the same thing at every
 * usage. HTML clamps `value` to `max`, so a shop past its allowance renders a full bar and never
 * overflows; a bar rescaled to `Math.max(limit, count)` would shrink back to a fraction at the
 * point the shop passed the limit. Each tile says what passing its limit means, so `detail` is
 * the tile's own. The headline carries both numbers because the bar shows only a ratio.
 *
 * | part       | job                                                          | component   | fixes                                                         | used on  | never                         |
 * | ---------- | ------------------------------------------------------------ | ----------- | ------------------------------------------------------------- | -------- | ----------------------------- |
 * | meter tile | one capacity meter as a link: dimension, number, bar, sentence | `MeterTile` | `base` padding, the border, `small-300` between lines         | homepage | a bar rescaled past its limit |
 */
export function MeterTile({
  heading,
  href,
  onClick,
  headline,
  count,
  limit,
  detail,
}: {
  readonly heading: string;
  readonly href: string;
  readonly onClick: (event: Event) => void;
  readonly headline: string;
  readonly count: number;
  readonly limit: number;
  /** What passing the limit means, or the next reset; nothing when there is nothing to say. */
  readonly detail?: ReactNode;
}) {
  return (
    <s-clickable
      href={href}
      onClick={onClick}
      padding={BETWEEN_THINGS}
      border="base"
      borderRadius="base"
    >
      <s-grid gap={BETWEEN_LINES}>
        <s-heading>{heading}</s-heading>
        <s-heading>{headline}</s-heading>
        <progress className="capacity-meter" aria-label={heading} max={limit} value={count} />
        {detail !== undefined && <s-paragraph color="subdued">{detail}</s-paragraph>}
      </s-grid>
    </s-clickable>
  );
}

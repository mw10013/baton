import type * as React from "react";

import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout";

/**
 * One capacity meter as a link (the meter-tile row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): the dimension, the number, a bar and
 * a sentence about it, the whole tile a link to the screen that manages it.
 * The bar is a native `progress` styled by `.capacity-meter` in
 * `styles.css`: Polaris has no meter, and a `progress` element carries the
 * value and maximum to a screen reader with its accessible name. The home
 * page's one use: one dimension of the plan, what the tier grants as the
 * denominator, what the shop has as the numerator, and a line saying what
 * passing the denominator means.
 *
 * `limit` is the entitlement and never the count, so the bar measures the
 * same thing at every usage. HTML clamps `value` to `max`, so a shop past
 * its allowance renders a full bar and never overflows. The meter this is
 * ported from (`refs/bang/src/routes/app.index.tsx`) takes
 * `Math.max(limit, count)` instead, which rescales the bar back to a fraction
 * at the point the shop passed the limit. Each tile says what passing its
 * limit means, so `detail` is the tile's own. The headline carries both
 * numbers because the bar shows only a ratio.
 */
export function MeterTile({
  heading,
  href,
  headline,
  count,
  limit,
  detail,
}: {
  readonly heading: string;
  readonly href: string;
  readonly headline: string;
  readonly count: number;
  readonly limit: number;
  readonly detail: React.ReactNode;
}) {
  return (
    <s-clickable
      href={href}
      padding={BETWEEN_THINGS}
      border="base"
      borderRadius="base"
    >
      <s-grid gap={BETWEEN_LINES}>
        <s-heading>{heading}</s-heading>
        <s-heading>{headline}</s-heading>
        <progress
          className="capacity-meter"
          aria-label={heading}
          max={limit}
          value={count}
        />
        <s-paragraph color="subdued">{detail}</s-paragraph>
      </s-grid>
    </s-clickable>
  );
}

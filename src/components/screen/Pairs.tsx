import * as React from "react";

import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout";
import { Token } from "./Token";

/** One label / value pair of {@link Pairs}. */
export interface Pair {
  readonly key: string;
  readonly label: string;
  readonly value: React.ReactNode;
}

/**
 * Label / value pairs in two aligned columns (the pairs row of the parts
 * table on `ScreenPart` in `src/lib/Screen.ts`): an item's properties, a
 * details page's facts in its aside (the order page, the team page). The
 * label is subdued and a token (a property key may be one unspaced word, as
 * `_engraving_font` is), the value is plain text that wraps. The label column
 * is `minmax(0, max-content)`: as wide as the widest label and never wider
 * than the screen, so a long key wraps rather than pushing the value column
 * off a phone.
 */
export function Pairs({ pairs }: { readonly pairs: readonly Pair[] }) {
  return (
    <s-grid
      gridTemplateColumns="minmax(0, max-content) 1fr"
      gap={`${BETWEEN_LINES} ${BETWEEN_THINGS}`}
    >
      {pairs.map(({ key, label, value }) => (
        <React.Fragment key={key}>
          <Token color="subdued">{label}</Token>
          {typeof value === "string" ? <s-text>{value}</s-text> : value}
        </React.Fragment>
      ))}
    </s-grid>
  );
}

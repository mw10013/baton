import { Fragment, type ReactNode } from "react";
import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout.ts";
import { Token } from "./Token.tsx";

/** One label / value pair of {@link Pairs}. */
export interface Pair {
  readonly key: string;
  readonly label: string;
  readonly value: ReactNode;
}

/**
 * Label / value pairs in two aligned columns: a details page's facts in its aside (the member
 * page, the team page). The label is subdued and a token (a key may be one unspaced word), the
 * value is plain text that wraps. The label column is `minmax(0, max-content)`: as wide as the
 * widest label and never wider than the screen, so a long key wraps rather than pushing the
 * value column off a phone.
 *
 * | part  | job                                       | component | fixes                                                | used on | never                                |
 * | ----- | ----------------------------------------- | --------- | ---------------------------------------------------- | ------- | ------------------------------------ |
 * | pairs | label / value pairs in two aligned columns | `Pairs`   | the label column `minmax(0, max-content)`; the label a token | details | a label column wider than the screen |
 */
export function Pairs({ pairs }: { readonly pairs: ReadonlyArray<Pair> }) {
  return (
    <s-grid
      gridTemplateColumns="minmax(0, max-content) 1fr"
      gap={`${BETWEEN_LINES} ${BETWEEN_THINGS}`}
    >
      {pairs.map(({ key, label, value }) => (
        <Fragment key={key}>
          <Token color="subdued">{label}</Token>
          {typeof value === "string" ? <s-text>{value}</s-text> : value}
        </Fragment>
      ))}
    </s-grid>
  );
}

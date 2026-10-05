import type * as React from "react";

import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout";

/**
 * A list with nothing in it (the empty-line row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`, and the controls table's rows for an
 * empty list and a search with nothing matching on `Control`): one sentence
 * in the list's place, centred in the list's frame, and under it at most one
 * action, the way out (Clear search, Go to Ready). Centred because a lone
 * line in a card's corner read as leftover text rather than the answer.
 * `heading` is for the never-filled list, whose sentence explains a first
 * step and needs a name above it ("No open orders").
 */
export function EmptyLine({
  heading,
  children,
  action,
}: {
  readonly heading?: string;
  readonly children?: React.ReactNode;
  readonly action?: React.ReactNode;
}) {
  return (
    <s-box padding={BETWEEN_THINGS}>
      <s-grid justifyItems="center">
        <s-grid justifyItems="center" maxInlineSize="450px" gap={BETWEEN_LINES}>
          {heading !== undefined && <s-heading>{heading}</s-heading>}
          {children !== undefined && (
            <s-paragraph color="subdued">{children}</s-paragraph>
          )}
          {action}
        </s-grid>
      </s-grid>
    </s-box>
  );
}

import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * A box inside a card that holds one thing apart from the card around it
 * (the panel row of the parts table on `ScreenPart` in `src/lib/Screen.ts`),
 * padded by {@link BETWEEN_THINGS}. Three kinds, each saying something
 * different about what it holds:
 *
 * - `card`: a thing among things, bordered: a workflow's trigger and its
 *   task cards, so the step flow reads as a column of stops.
 * - `drawer`: what a disclosure opened, filled subdued and unbordered: the
 *   order page's Manage, so it reads as a drawer the button owns and not as
 *   more card.
 * - `draft`: a thing not made yet, bordered dashed: the workflow editor's
 *   add form, the place a new task or step will go.
 */
export function Panel({
  kind,
  children,
}: {
  readonly kind: "card" | "drawer" | "draft";
  readonly children: React.ReactNode;
}) {
  if (kind === "drawer")
    return (
      <s-box background="subdued" borderRadius="base" padding={BETWEEN_THINGS}>
        {children}
      </s-box>
    );
  return (
    <s-box
      padding={BETWEEN_THINGS}
      border={kind === "draft" ? "base subdued dashed" : "base subdued solid"}
      borderRadius="base"
    >
      {children}
    </s-box>
  );
}

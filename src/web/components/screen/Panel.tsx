import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * A box inside a card that holds one thing apart from the card around it, padded by
 * {@link BETWEEN_THINGS}. Three kinds, each saying something different about what it holds:
 *
 * - `card`: a thing among things, bordered: a workflow's trigger and its task cards, so the step
 *   flow reads as a column of stops.
 * - `drawer`: what a disclosure opened, filled subdued and unbordered, so it reads as a drawer the
 *   button owns and not as more card.
 * - `draft`: a thing not made yet, bordered dashed: the workflow editor's add form, the place a
 *   new task or step will go.
 *
 * | part  | job                                                                                    | component | fixes                                                     | used on         | never              |
 * | ----- | -------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------- | --------------- | ------------------ |
 * | panel | a box inside a card: a task card, the order page's Manage drawer, the editor's add form | `Panel`   | `base` padding; a solid border, a subdued fill or a dashed border by kind | details, editor | a box inside a panel |
 */
export function Panel({
  kind,
  children,
}: {
  readonly kind: "card" | "drawer" | "draft";
  readonly children: ReactNode;
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

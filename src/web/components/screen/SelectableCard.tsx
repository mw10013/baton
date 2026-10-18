import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * A card that can be chosen: a task card in the workflow editor, where choosing it opens the
 * task's panel in the aside. The chosen card is filled subdued with a strong border, and says so
 * to a screen reader through `aria-pressed`. The same padding and radius as the card `Panel`, so a
 * card does not move when the editor makes it choosable.
 *
 * | part            | job                                                   | component        | fixes                                                         | used on | never                                       |
 * | --------------- | ----------------------------------------------------- | ---------------- | ------------------------------------------------------------- | ------- | ------------------------------------------- |
 * | selectable card | a card that can be chosen: a task card in the workflow editor | `SelectableCard` | the card's padding; the chosen card filled with a strong border | editor  | a card that moves when it becomes choosable |
 */
export function SelectableCard({
  selected,
  accessibilityLabel,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly accessibilityLabel: string;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <s-clickable
      padding={BETWEEN_THINGS}
      border={selected ? "base strong solid" : "base subdued solid"}
      borderRadius="base"
      background={selected ? "subdued" : "base"}
      accessibilityLabel={accessibilityLabel}
      aria-pressed={selected}
      onClick={() => {
        onSelect();
      }}
    >
      {children}
    </s-clickable>
  );
}

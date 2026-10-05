import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * A {@link Panel} card that can be chosen (the selectable-card row of the
 * parts table on `ScreenPart` in `src/lib/Screen.ts`): a task card in the
 * workflow editor, where choosing it opens the task's panel in the aside. The
 * chosen card is filled subdued with a strong border, and says so to a screen
 * reader through `aria-pressed`. The same padding and radius as the card
 * {@link Panel}, so a card does not move when the editor makes it choosable.
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
  readonly children: React.ReactNode;
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

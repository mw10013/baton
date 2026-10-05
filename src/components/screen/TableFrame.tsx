import type * as React from "react";

/**
 * A table inside a details card, framed (the table-frame row of the parts
 * table on `ScreenPart` in `src/lib/Screen.ts`): the team page's members. The
 * card keeps its own padding (a `padding="none"` section loses the inset on
 * its heading too), so the table needs a frame of its own, as Polaris's
 * details template draws it, or it floats in the card. `overflow="hidden"`
 * clips the header row's fill to the frame's rounded corners; it no longer
 * hides an email, which is a {@link Token} that wraps.
 */
export function TableFrame({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <s-box border="base" borderRadius="base" overflow="hidden">
      {children}
    </s-box>
  );
}

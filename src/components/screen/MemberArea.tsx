import type * as React from "react";

/**
 * The member area's root (the member-area row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): every member screen renders inside
 * it. `.member-area` in `styles.css` sets `overflow-wrap: anywhere`, so an
 * unspaced token anywhere on a member screen (an email in a heading or a
 * task line, a SKU, a shop domain in the bar) breaks inside itself rather
 * than widen a phone screen; the token row of the parts table, applied once
 * at the root where the member area has no table or badge that a mid-word
 * break would spoil.
 */
export function MemberArea({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return <div className="member-area">{children}</div>;
}

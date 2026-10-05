import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * A form's fields, stacked (the fields row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): a modal's or a card's text fields,
 * selects and checkboxes. Spaced by {@link BETWEEN_THINGS}: each field is a
 * thing with its own label, help and error, and `small-300` ran one field's
 * error into the next field's label.
 */
export function Fields({ children }: { readonly children: React.ReactNode }) {
  return <s-stack gap={BETWEEN_THINGS}>{children}</s-stack>;
}

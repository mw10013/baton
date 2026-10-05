import type * as React from "react";

/**
 * Content set at the end of its cell (the end row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): a table's action column and its
 * header, so the column's buttons line up on the card's edge, where a row's
 * actions sit in Shopify's index tables.
 */
export function End({ children }: { readonly children: React.ReactNode }) {
  return <s-stack alignItems="end">{children}</s-stack>;
}

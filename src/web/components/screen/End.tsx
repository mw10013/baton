import type { ReactNode } from "react";

/**
 * Content set at the end of its cell: a table's action column and its header, so the column's
 * buttons line up on the card's edge, where a row's actions sit in Shopify's index tables.
 *
 * | part | job                                                  | component | fixes        | used on | never                                   |
 * | ---- | ---------------------------------------------------- | --------- | ------------ | ------- | --------------------------------------- |
 * | end  | content set at the end of its cell: a table's action column | `End`     | the end edge | details | a column of buttons at ragged positions |
 */
export function End({ children }: { readonly children: ReactNode }) {
  return <s-stack alignItems="end">{children}</s-stack>;
}

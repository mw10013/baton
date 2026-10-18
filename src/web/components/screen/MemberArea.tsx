import type { ReactNode } from "react";

/**
 * The member area's root: every member screen renders inside it. `.member-area` in `styles.css`
 * sets `overflow-wrap: anywhere`, so an unspaced token anywhere on a member screen (an email in a
 * task line, a SKU, a shop domain in the bar) breaks inside itself rather than widen a phone
 * screen: the token rule, applied once at the root, where the member area has no table or badge
 * that a mid-word break would spoil.
 *
 * | part        | job                                                  | component    | fixes                                                         | used on        | never                                         |
 * | ----------- | ---------------------------------------------------- | ------------ | ------------------------------------------------------------- | -------------- | --------------------------------------------- |
 * | member area | the member area's root: every member screen inside it | `MemberArea` | `overflow-wrap: anywhere` for every token on a member screen | index, details | a table or badge a mid-word break would spoil |
 */
export function MemberArea({ children }: { readonly children: ReactNode }) {
  return <div className="member-area">{children}</div>;
}

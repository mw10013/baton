import type { ReactNode } from "react";

/**
 * A table inside a details card, framed: the member page's teams, the team page's members. The
 * card keeps its own padding (a `padding="none"` section loses the inset on its heading too), so
 * the table needs a frame of its own, as Polaris's details template draws it, or it floats in
 * the card. `overflow="hidden"` clips the header row's fill to the frame's rounded corners; it no
 * longer hides an email, which is a `Token` that wraps.
 *
 * | part        | job                                   | component    | fixes                              | used on | never                              |
 * | ----------- | ------------------------------------- | ------------ | ---------------------------------- | ------- | ---------------------------------- |
 * | table frame | a table inside a details card, framed | `TableFrame` | the border and its rounded corners | details | a table floating in a padded card |
 */
export function TableFrame({ children }: { readonly children: ReactNode }) {
  return (
    <s-box border="base" borderRadius="base" overflow="hidden">
      {children}
    </s-box>
  );
}

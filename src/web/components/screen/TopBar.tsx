import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ShopKey } from "../../../contract/shop.ts";
import { Inline } from "./Inline.tsx";
import { BETWEEN_LINES } from "./layout.ts";

/**
 * Where the bar's link home goes: Your stores, or, inside a shop, that shop's workflows list.
 */
export type TopBarHome =
  | { readonly to: "/shop" }
  | { readonly to: "/shop/$key/workflows"; readonly key: ShopKey };

/**
 * The bar above `s-page` on a signed-in area that has one: the link home at the start (the
 * site's name, or inside a shop the shop's domain), `end` (who is signed in, Sign out) at the
 * end, wrapping under it on a narrow phone. `s-page` has no slot for chrome above its heading, so
 * the bar is a plain bordered box (`.top-bar` in `styles.css`). The home link is a router
 * {@link Link}, so it navigates without a document load; inside a shop the member shop layout's
 * search middleware puts the member's state, team and search on it, and no depth, so it opens the
 * workflows list at the first page as the member left it. Hidden in print (`.print-hide`): a
 * printed workflow page is a job ticket, and the ticket needs no sign-out button.
 *
 * | part    | job                                                                               | component | fixes                                                                   | used on        | never                                         |
 * | ------- | --------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------- | -------------- | --------------------------------------------- |
 * | top bar | the bar above the page: the link home at the start, the session at the end | `TopBar`  | the bar's border and padding; start and end, wrapping on a narrow phone | index, details | anything that belongs to the screen below it |
 */
export function TopBar({
  title,
  home,
  end,
}: {
  readonly title: string;
  readonly home: TopBarHome;
  readonly end: ReactNode;
}) {
  // Strong, not a heading: the bar is chrome, and the page below has the heading.
  const label = <s-text type="strong">{title}</s-text>;
  return (
    <div className="top-bar print-hide">
      <s-stack
        direction="inline"
        gap={BETWEEN_LINES}
        alignItems="center"
        justifyContent="space-between"
      >
        {home.to === "/shop" ? (
          <Link to="/shop" className="top-bar-home">
            {label}
          </Link>
        ) : (
          <Link to="/shop/$key/workflows" params={{ key: home.key }} className="top-bar-home">
            {label}
          </Link>
        )}
        <Inline>{end}</Inline>
      </s-stack>
    </div>
  );
}

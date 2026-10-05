import type * as React from "react";

import { Link } from "@tanstack/react-router";

import { BatonMark } from "./BatonMark";
import { BETWEEN_LINES } from "./layout";

/**
 * The member area's top bar (the top-bar row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`): above `s-page` on every member
 * screen, the mark and the shop as one link home at the start, `end` (who is
 * signed in, Sign out) at the end, wrapping under it on a narrow phone.
 * Polaris `s-page` has no slot for chrome above the heading, so this is a
 * plain bordered `div` (`.member-bar` in `styles.css`). Hidden in print
 * (`.print-hide`): a printed workflow page is a job ticket, and the ticket
 * needs no sign-out button.
 *
 * The link goes to the workflows list and lands on the list the member left,
 * because the layout's middleware puts their context on every link built
 * under `/shop/$shop` (`MemberSearch` in `src/routes/shop.$shop.tsx`).
 * `.member-bar-home` in `styles.css` rings the mark on hover and focus, so
 * the mark reads as the control. The shop domain is inside the same link
 * rather than beside it, because the mark alone is 24 px and Polaris's
 * minimum touch target is 44; it stays plain and is the link's accessible
 * name, so a screen reader hears which shop.
 */
export function TopBar({
  shop,
  end,
}: {
  readonly shop: string;
  readonly end: React.ReactNode;
}) {
  return (
    <div className="member-bar print-hide">
      <s-stack
        direction="inline"
        gap={BETWEEN_LINES}
        alignItems="center"
        justifyContent="space-between"
      >
        <Link
          to="/shop/$shop/workflows"
          params={{ shop }}
          className="member-bar-home"
        >
          <s-stack direction="inline" gap={BETWEEN_LINES} alignItems="center">
            <BatonMark />
            {/* The semantic `<strong>` only: the bar is chrome, and weight
                would pull the eye from the page under it. */}
            <s-text type="strong">{shop}</s-text>
          </s-stack>
        </Link>
        <s-stack direction="inline" gap={BETWEEN_LINES} alignItems="center">
          {end}
        </s-stack>
      </s-stack>
    </div>
  );
}

import type * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { BatonMark } from "@/components/BatonMark";
import { signOutFn } from "@/lib/memberSignOut";

/**
 * The member area's one piece of chrome, above `s-page` on every
 * `/shop/$shop/*` screen: the Baton mark ({@link BatonMark}), the
 * shop, and Sign out. It answers "where am I and who am I signed in as" on a
 * phone page that scrolls its heading away at once. Polaris `s-page` has no
 * slot for chrome above the heading, so this is a plain bordered `div`
 * (`.member-bar` in `styles.css`) holding an inline `s-stack`. Hidden in
 * print (`.print-hide`): a printed work page is a job ticket, and the ticket
 * needs no sign-out button.
 *
 * **The mark is home.** The link around it goes to `/shop/$shop`, the run
 * list, and it lands on the list the member left — same tab, same team, same
 * depth — because the layout's middleware puts their context on every link
 * built under `/shop/$shop` (`MemberSearch` in `src/routes/shop.$shop.tsx`).
 * This bar is the only chrome the member area has, so the mark is the only
 * standing way home and is styled to read as one: `.member-bar-home` in
 * `styles.css` rings the mark on hover and focus. The shop domain — the only
 * name Baton stores for the shop — is inside the same link rather than beside
 * it, because the mark alone is 24 px and Polaris's minimum touch target is
 * 44; it stays plain, so the mark is what reads as the control, and it is the
 * link's accessible name, so a screen reader hears which shop rather than a
 * label the mark already means.
 *
 * `email` is the "who am I" half, and it lives here rather than under a page
 * heading so it is answered on every screen at the cost of one line on none
 * of them. A shared bench tablet is the case that needs it: the person who
 * picks it up has to know whose session they are about to press Done in.
 *
 * `filter` is a slot beside the shop for a control that belongs to the screen
 * below rather than to the bar. The run list passes its team filter there and
 * every other member screen passes nothing, so the bar does change shape by
 * route — that is the price of keeping the run list's one filter off a line of
 * its own on the screen with least room for one. Nothing the bar owns moves
 * either way, which is what the "where am I, who am I" job actually needs.
 */
export function MemberBar({
  shop,
  email,
  filter,
}: {
  readonly shop: string;
  readonly email?: string;
  readonly filter?: React.ReactNode;
}) {
  const signOut = useServerFn(signOutFn);
  const signOutMutation = useMutation({ mutationFn: () => signOut({}) });
  return (
    <div className="member-bar print-hide">
      <s-stack
        direction="inline"
        gap="small-300"
        alignItems="center"
        justifyContent="space-between"
      >
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <Link to="/shop/$shop" params={{ shop }} className="member-bar-home">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <BatonMark />
              <s-text type="strong">{shop}</s-text>
            </s-stack>
          </Link>
          {filter}
        </s-stack>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          {email !== undefined && <s-text color="subdued">{email}</s-text>}
          <s-button
            variant="tertiary"
            {...(signOutMutation.isPending ? { loading: true } : {})}
            onClick={() => {
              signOutMutation.mutate();
            }}
          >
            Sign out
          </s-button>
        </s-stack>
      </s-stack>
    </div>
  );
}

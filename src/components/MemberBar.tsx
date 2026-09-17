import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { signOutFn } from "@/lib/memberSignOut";

/**
 * The member area's one piece of chrome, above `s-page` on every
 * `/shop/$shop/*` screen: the Baton mark (the same drawing as
 * `public/favicon.svg`, inlined so it is one request fewer and prints), the
 * shop, and Sign out. It answers "where am I and who am I signed in as" on a
 * phone page that scrolls its heading away at once. Polaris `s-page` has no
 * slot for chrome above the heading, so this is a plain bordered `div`
 * (`.member-bar` in `styles.css`) holding an inline `s-stack`. Hidden in
 * print (`.print-hide`): a printed work page is a job ticket, and the ticket
 * needs no sign-out button.
 *
 * The shop is the `myshopify.com` domain, the only name Baton stores for it.
 * It links to the queue, which is the area's landing page, so the mark plus
 * shop doubles as "back to the start" wherever the member is.
 *
 * `email` is the "who am I" half, and it lives here rather than under a page
 * heading so it is answered on every screen at the cost of one line on none
 * of them. A shared bench tablet is the case that needs it: the person who
 * picks it up has to know whose session they are about to press Done in.
 */
export function MemberBar({
  shop,
  email,
}: {
  readonly shop: string;
  readonly email?: string;
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
        <Link
          to="/shop/$shop"
          params={{ shop }}
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <svg
              viewBox="0 0 32 32"
              width="24"
              height="24"
              aria-hidden="true"
              style={{ display: "block", flexShrink: 0 }}
            >
              <rect width="32" height="32" rx="7" fill="#1a1a1a" />
              <rect
                x="8"
                y="14"
                width="16"
                height="4"
                rx="2"
                fill="#fff"
                transform="rotate(-35 16 16)"
              />
            </svg>
            <s-text type="strong">{shop}</s-text>
          </s-stack>
        </Link>
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

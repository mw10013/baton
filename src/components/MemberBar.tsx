import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Token } from "@/components/screen/Token";
import { TopBar } from "@/components/screen/TopBar";
import { signOutFn } from "@/lib/memberSignOut";

/**
 * The member area's one piece of chrome, above `s-page` on every
 * `/shop/$shop/*` screen: the Baton mark, the shop, and Sign out, laid out
 * by {@link TopBar}. It answers "where am I and who am I signed in as" on a
 * phone page that scrolls its heading away at once.
 *
 * **The mark is home** ({@link TopBar} says how): the bar is the only
 * chrome the member area has, so the mark is the only standing way home. It
 * opens the list at the first page, as every link does. It is not the way
 * back from a workflow page: that is the page's own Workflows link, which
 * returns to the list as the member left it.
 *
 * `email` is the "who am I" half, and it lives here rather than under a page
 * heading so it is answered on every screen at the cost of one line on none
 * of them. A shared bench tablet is the case that needs it: the person who
 * picks it up has to know whose session they are about to press Done in.
 *
 * The bar holds nothing that belongs to the screen below it, so it is the
 * same shape on every member screen; the workflows list's filters are in its
 * own section.
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
    <TopBar
      shop={shop}
      end={
        <>
          {email !== undefined && <Token color="subdued">{email}</Token>}
          <s-button
            variant="tertiary"
            {...(signOutMutation.isPending ? { loading: true } : {})}
            onClick={() => {
              signOutMutation.mutate();
            }}
          >
            Sign out
          </s-button>
        </>
      }
    />
  );
}

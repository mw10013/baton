import { useMatch, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../contract/shop.ts";
import { TopBar } from "./screen/TopBar.tsx";
import SignOutButton from "./SignOutButton.tsx";

/**
 * The member area's one piece of chrome, above `s-page` on every `/shop` screen: the way home,
 * who is signed in, and Sign out. Inside a shop the way home names the shop and opens its
 * workflows list, the member's home there and the only standing way to it; it is not the way back
 * from a workflow page, which is that page's own Workflows link. On Your stores it is the site's
 * name and opens Your stores. The email lives here rather than under a heading, so every member
 * screen answers "whose session is this" at the cost of one line on none of them: a shared bench
 * tablet is the case that needs it. On the gate's refusal ("No access") it is Your stores' bar:
 * that page does not disclose whether the shop exists, and its workflows list would be refused.
 */
export default function MemberBar({ email }: { readonly email: string }) {
  const refused =
    useMatch({ from: "/shop/$key", shouldThrow: false, select: (match) => match.status }) ===
    "notFound";
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(ShopKey)(useParams({ strict: false }).key),
  );
  const key = refused ? undefined : decoded;
  return (
    <TopBar
      title={key ?? "Baton"}
      home={key === undefined ? { to: "/shop" } : { to: "/shop/$key/workflows", key }}
      end={
        <>
          <s-text color="subdued">{email}</s-text>
          <SignOutButton variant="tertiary" leave />
        </>
      }
    />
  );
}

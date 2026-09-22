import { createFileRoute, Link } from "@tanstack/react-router";
import { Schema } from "effect";

/**
 * Why `requireMember` sent the viewer here. Absent is the original and default
 * condition, the shop's subscription; `seat` is the one that arrived with
 * derived seats, where the shop is paying but the plan has fewer seats than it
 * has members.
 *
 * One page for both because the answer is identical: neither is anything a
 * member can act on, and both end with "ask the shop owner". A second route
 * would be a second thing to keep static, and static is what lets this page
 * exist outside the `/shop/$shop` layout and its socket.
 */
const LapsedSearch = Schema.Struct({
  reason: Schema.optional(Schema.Literals(["seat"])),
});

const COPY = {
  subscription: {
    heading: "Subscription inactive",
    body: "This shop’s Baton subscription is not active, so its workflows are unavailable. Ask the shop owner to renew the subscription from the Baton app in their Shopify admin.",
  },
  seat: {
    heading: "No seat on this plan",
    body: "This shop’s Baton plan does not include a seat for you. Ask the shop owner to free a seat or upgrade.",
  },
} as const;

/**
 * Where `requireMember` sends a member it refuses. Deliberately static: no
 * loader, no `requireMember`, no socket. A loader would re-run the very check
 * that redirected here, and the `$shop_` segment escapes the `/shop/$shop`
 * layout so this page never opens the member socket — the connect gate answers
 * both refusals with `402` and the client would otherwise sit in a reconnect
 * loop it cannot resolve.
 *
 * Rendering for any shop string discloses nothing: the page says the same
 * thing regardless of whether the shop exists or the viewer belongs to it,
 * and the session guard on `/shop` still applies. The `reason` parameter is
 * likewise safe to trust from the URL — it selects copy and nothing else, so a
 * viewer who types it learns only a sentence they could have read here anyway.
 */
export const Route = createFileRoute("/shop/$shop_/lapsed")({
  validateSearch: Schema.toStandardSchemaV1(LapsedSearch),
  head: () => ({ meta: [{ title: "Subscription inactive — Baton" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { shop } = Route.useParams();
  const { reason } = Route.useSearch();
  const { heading, body } = COPY[reason ?? "subscription"];
  return (
    <s-page heading={shop} inlineSize="small">
      <s-section heading={heading} accessibilityLabel={heading}>
        <s-stack gap="base">
          <s-paragraph>{body}</s-paragraph>
          <Link to="/shop">Back to your shops</Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

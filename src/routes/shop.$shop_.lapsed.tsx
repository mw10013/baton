import { createFileRoute, Link } from "@tanstack/react-router";

/**
 * Where `requireMember` sends a member whose shop has no active Baton
 * subscription. Deliberately static: no loader, no `requireMember`, no
 * socket. A loader would re-run the very check that redirected here, and the
 * `$shop_` segment escapes the `/shop/$shop` layout so this page never opens
 * the member socket — the connect gate answers a lapsed shop with `402` and
 * the client would otherwise sit in a reconnect loop it cannot resolve.
 *
 * Rendering for any shop string discloses nothing: the page says the same
 * thing regardless of whether the shop exists or the viewer belongs to it,
 * and the session guard on `/shop` still applies.
 */
export const Route = createFileRoute("/shop/$shop_/lapsed")({
  head: () => ({ meta: [{ title: "Subscription inactive — Baton" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { shop } = Route.useParams();
  return (
    <s-page heading={shop} inlineSize="small">
      <s-section
        heading="Subscription inactive"
        accessibilityLabel="Subscription inactive"
      >
        <s-stack gap="base">
          <s-paragraph>
            This shop&rsquo;s Baton subscription is not active, so its work
            queue is unavailable. Ask the shop owner to renew the subscription
            from the Baton app in their Shopify admin.
          </s-paragraph>
          <Link to="/shop">Back to your shops</Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

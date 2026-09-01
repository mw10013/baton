import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: ({ location }) => {
    if (location.searchStr.includes("shop=")) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ href: `/app${location.searchStr}` });
    }
  },
  head: () => ({ meta: [{ title: "Baton" }] }),
  component: RouteComponent,
});

/**
 * The public landing page: what a merchant sees at the app's root origin when
 * they arrive without a `shop` parameter, and the page the App Store listing
 * and the privacy policy link back to. A request that *does* carry `shop=` is
 * Shopify handing off an embedded launch, so it is redirected into `/app`
 * before this renders.
 */
function RouteComponent() {
  return (
    <s-page heading="Baton" inlineSize="small">
      <s-section accessibilityLabel="Baton overview">
        <s-paragraph>
          Baton is a Shopify admin app skeleton built on TanStack Start,
          Cloudflare Workers, Durable Objects, and Effect.
        </s-paragraph>
      </s-section>
      <s-section accessibilityLabel="Member login">
        <s-link href="/login">Log in</s-link>
      </s-section>
      <s-section accessibilityLabel="Legal">
        <s-link href="/privacy">Privacy policy</s-link>
      </s-section>
    </s-page>
  );
}

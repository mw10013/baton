import { Link } from "@tanstack/react-router";
import { Things } from "./screen/Things.tsx";

/**
 * Subscription inactive: what a member of a shop whose app subscription lapsed reads, headed by
 * the shop, with the way back to the shops they still have. Legacy's copy.
 */
export function LapsedPage({ shop }: { readonly shop: string }) {
  const heading = "Subscription inactive";
  return (
    <s-page heading={shop} inlineSize="small">
      <s-section heading={heading} accessibilityLabel={heading}>
        <Things>
          <s-paragraph>
            This store’s Baton subscription is not active, so its workflows are unavailable. Ask the
            merchant to renew the subscription from the Baton app in their Shopify admin.
          </s-paragraph>
          <Link to="/shop">Your stores</Link>
        </Things>
      </s-section>
    </s-page>
  );
}

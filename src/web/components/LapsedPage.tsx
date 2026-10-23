import { Link } from "@tanstack/react-router";
import { Things } from "./screen/Things.tsx";

/**
 * Subscription inactive: what a member of a shop whose app subscription lapsed reads, headed by
 * the shop, with the way back to the shops they still have when `yourStores`. A member of this
 * shop alone gets no link: Your stores would send them straight back here.
 */
export function LapsedPage({
  shop,
  yourStores,
}: {
  readonly shop: string;
  readonly yourStores: boolean;
}) {
  const heading = "Subscription inactive";
  return (
    <s-page heading={shop} inlineSize="small">
      <s-section heading={heading} accessibilityLabel={heading}>
        <Things>
          <s-paragraph>
            This store’s Baton subscription is not active, so its workflows are unavailable. Ask the
            merchant to renew the subscription from the Baton app in their Shopify admin.
          </s-paragraph>
          {yourStores && <Link to="/shop">Your stores</Link>}
        </Things>
      </s-section>
    </s-page>
  );
}

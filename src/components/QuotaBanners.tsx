import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * The limit that has actually stopped something, shared by the `/app` home
 * and the orders index because those are the two places the consequence shows
 * up: the home is where the plan is managed, the index is where an order that
 * never arrived would be missed.
 *
 * `critical`, and shown only after the fact: once a new order was refused at
 * the order ceiling. It names what clears it: closing orders in Shopify, then
 * Sync open orders, which stores the refused orders still open and inside its
 * 30-day window. It stays until that press, even while new orders are stored
 * again (`OrderRepository.clearOrdersLimited`): the gap is open until then.
 *
 * Going past the plan's included orders is not one of them: syncing continues
 * and the extra orders are billed at the plan's rate, so it is the plan
 * working, not a fault. The home page's orders meter shows used against
 * included.
 */
export function QuotaBanners({ usage }: { readonly usage: Domain.ShopUsage }) {
  if (usage.ordersLimitedAt === null) return null;
  return (
    <s-banner tone="critical">
      {`New orders stopped syncing at ${formatNumber(Domain.ShopLimits.maxOpenOrders)} open orders. Fulfill or cancel orders in Shopify, then Sync open orders.`}
    </s-banner>
  );
}

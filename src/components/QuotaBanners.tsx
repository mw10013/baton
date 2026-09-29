import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * The limits that have actually stopped something, shared by the `/app` home
 * and the orders index because those are the two places the consequence shows
 * up: the home is where the plan is managed, the index is where an order that
 * never arrived would be missed.
 *
 * Both are `critical` and appear only after the fact: the open-run banner once
 * reconcile declined to start a run, the order-ceiling banner once a new order
 * was refused. Each names what clears it.
 *
 * Going past the plan's included orders is not one of them: syncing continues
 * and the extra orders are billed at the plan's rate, so it is the plan
 * working, not a fault. The home page's orders meter shows used against
 * included.
 */
export function QuotaBanners({ usage }: { readonly usage: Domain.ShopUsage }) {
  if (usage.openRunsLimitedAt === null && usage.ordersLimitedAt === null)
    return null;
  return (
    <>
      {usage.ordersLimitedAt !== null && (
        <s-banner tone="critical">
          {`New orders stopped syncing at ${formatNumber(Domain.ShopLimits.maxOrdersPerCycle)} this billing cycle.`}
          {usage.cycleEndAt !== null && (
            <>
              {" Syncing resumes on "}
              <LocalDateTime value={usage.cycleEndAt} />.
            </>
          )}
        </s-banner>
      )}
      {usage.openRunsLimitedAt !== null && (
        <s-banner tone="critical">
          {`Baton stopped attaching workflows because ${formatNumber(Domain.ShopLimits.maxOpenRuns)} items are in production. Cancel a workflow, or wait until an item is done or closed.`}
        </s-banner>
      )}
    </>
  );
}

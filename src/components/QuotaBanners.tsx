import type { ReactNode } from "react";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * The three things a merchant has to be told about their limits, shared by the
 * `/app` home and the orders index because those are the two places the
 * consequence shows up: the home is where the plan is managed, the index is
 * where an order that never arrived would be missed.
 *
 * All three are derived, never stored as UI state: `usage` is the Durable
 * Object's count and `ordersPerCycle` the Worker's ceiling, so the comparison is
 * made here and nowhere else.
 *
 * The quota banner is a *warning*, not a blocker — syncing continues past the
 * included orders and they are billed at the plan's rate, which the copy says,
 * because silently dropping a merchant's orders would be worse than the
 * overage. The other two are `critical` because something has actually stopped:
 * the open-run banner appears only after reconcile declined to start a run, and
 * the order-ceiling banner only after a new order was refused. Each names what
 * clears it.
 */
export function QuotaBanners({
  usage,
  ordersPerCycle,
  action,
}: {
  readonly usage: Domain.ShopUsage;
  readonly ordersPerCycle: number;
  /** Rendered inside the quota banner — the page's own Manage plan control, if it has one. */
  readonly action?: ReactNode;
}) {
  const over = usage.ordersThisCycle > ordersPerCycle;
  if (
    !over &&
    usage.openRunsLimitedAt === null &&
    usage.ordersLimitedAt === null
  )
    return null;
  return (
    <>
      {over && (
        <s-banner tone="warning">
          {`You've used ${formatNumber(usage.ordersThisCycle)} of ${formatNumber(ordersPerCycle)} included orders this billing period. Extra orders are billed at your plan's rate.`}
          {action}
        </s-banner>
      )}
      {usage.ordersLimitedAt !== null && (
        <s-banner tone="critical">
          {`Baton is built for shops under ${formatNumber(Domain.ShopLimits.maxOrdersPerCycle)} orders a billing period, so new orders have stopped syncing.`}
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
          {`Baton stopped starting new runs because ${formatNumber(Domain.ShopLimits.maxOpenRuns)} are already in progress. Finish or cancel runs to resume.`}
        </s-banner>
      )}
    </>
  );
}

import type { ReactNode } from "react";

import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * The two things a merchant has to be told about their limits, shared by the
 * `/app` home and the orders index because those are the two places the
 * consequence shows up: the home is where the plan is managed, the index is
 * where an order that never arrived would be missed.
 *
 * Both are derived, never stored as UI state: `usage` is the Durable Object's
 * count and `ordersPerMonth` the Worker's ceiling, so the comparison is made
 * here and nowhere else.
 *
 * The quota banner is a *warning*, not a blocker — syncing continues past the
 * limit and the copy says so, because silently dropping a merchant's orders to
 * enforce a soft limit would be worse than the overage. The live-run banner is
 * `critical` because something has actually stopped: it only appears after
 * reconcile declined to start a run, and it names the action that clears it.
 */
export function QuotaBanners({
  usage,
  ordersPerMonth,
  action,
}: {
  readonly usage: Domain.ShopUsage;
  readonly ordersPerMonth: number;
  /** Rendered inside the quota banner — the page's own Manage plan control, if it has one. */
  readonly action?: ReactNode;
}) {
  const over = usage.ordersThisMonth > ordersPerMonth;
  if (!over && usage.liveRunsLimitedAt === null) return null;
  return (
    <>
      {over && (
        <s-banner tone="warning">
          {`You've synced ${formatNumber(usage.ordersThisMonth)} of ${formatNumber(ordersPerMonth)} orders this month. Syncing continues. Upgrade for more.`}
          {action}
        </s-banner>
      )}
      {usage.liveRunsLimitedAt !== null && (
        <s-banner tone="critical">
          {`Baton stopped starting new runs because ${formatNumber(Domain.ShopLimits.maxLiveRuns)} are already in progress. Finish or cancel runs to resume.`}
        </s-banner>
      )}
    </>
  );
}

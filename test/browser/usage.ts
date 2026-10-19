import type { ShopUsage } from "../../src/domain/billing.ts";

/** A shop's usage with nothing counted and nothing refused: what a page's loader reads by default. */
export const NO_USAGE: ShopUsage = {
  cycleStartAt: null,
  cycleEndAt: null,
  ordersThisCycle: 0,
  ordersLimitedAt: null,
  databaseSize: 0,
  openOrders: 0,
  lastSweepAt: null,
  pendingUsageEvents: 0,
  seatsThisCycle: 0,
};

import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * What the Sync open orders button leaves on `SyncState.lastError` when the
 * shop is at the order ceiling (`Domain.cycleAtOrderCeiling`), which the
 * orders index shows as its banner. Here rather than in `ShopAgent.ts`, which
 * writes it, because this is screen copy and the copy lint reads only the
 * files that hold copy; the object imports it rather than a component module
 * such as `QuotaBanners.tsx`, which would tie the object to JSX.
 */
export const ORDER_CEILING_SYNC_REFUSED = `Baton is built for shops under ${formatNumber(Domain.ShopLimits.maxOrdersPerCycle)} orders a billing cycle; syncing resumes when the billing cycle ends.`;

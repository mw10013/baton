/**
 * Shopify grants the last 60 days of orders without `read_all_orders`, which is
 * a Partner Dashboard access request. 30 leaves headroom for a clock skew or a
 * long-running bulk operation without ever touching that boundary.
 */
export const ORDER_SYNC_WINDOW_DAYS = 30;

/**
 * Rewind applied to `updated_at:>=` on every sync after the first. A bulk
 * operation observes the shop at some instant between submit and completion,
 * and webhooks that arrive mid-run are unordered — overlapping the next window
 * past the previous run's start is what makes a missed edge impossible. Costs a
 * handful of redundant upserts, which the `updatedAt` guard makes free.
 */
export const ORDER_SYNC_OVERLAP_MS = 15 * 60 * 1000;

/** 5s x3, 15s x3, then 30s — ~10.5 minutes of polling before the run gives up. */
export const BULK_POLL_ATTEMPTS = 24;

/**
 * Line items requested per order on the single-order (webhook/resync) path.
 * The bulk path has no such cap — connections are flattened into their own
 * NDJSON lines.
 *
 * 100 keeps the requested query cost near 400 points, well under the 1,000-point
 * single-query ceiling. An order past the cap is not a silent truncation: the
 * fetch selects `pageInfo.hasNextPage`, and {@link OrderRepository.upsertOrder}
 * is told to merge rather than replace the line-item set so the unseen tail is
 * not deleted.
 */
export const ORDER_SYNC_LINE_ITEMS = 100;

/**
 * The `wrangler.jsonc` binding name, shared by the kickoff in `ShopAgent` and
 * the `onWorkflow*` callback guards — the Agents SDK routes every workflow
 * callback through the same two hooks, so each must check which workflow it is
 * hearing from.
 */
export const ORDERS_SYNC_WORKFLOW_NAME = "ORDERS_SYNC_WORKFLOW";

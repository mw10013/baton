/**
 * How far back the import reaches. Shopify grants the last 60 days of orders
 * without `read_all_orders`, which is a Partner Dashboard access request; 30
 * leaves headroom for a clock skew or a long-running bulk operation without
 * ever touching that boundary. The number is in the button's help text, so it
 * is a promise to the merchant as well as a query term.
 */
export const ORDER_IMPORT_WINDOW_DAYS = 30;

/**
 * When to stop the spinner, not when to expect success. An open-work export
 * of a shop under the order ceiling completes in well under a minute, so this
 * is ten times the expected duration; Shopify itself only fails a bulk query
 * after 10 days, and the operation it leaves running is cancelled rather than
 * abandoned ({@link OrdersSyncWorkflow}).
 */
export const BULK_GIVE_UP_MS = 5 * 60_000;

/**
 * The gap between polls of the bulk operation. Small enough that a typical
 * import is noticed within seconds of finishing, and `BULK_GIVE_UP_MS / this`
 * steps is nothing against a Workflow instance's 10,000-step limit.
 */
export const BULK_POLL_INTERVAL_MS = 5000;

/**
 * The `wrangler.jsonc` binding name, shared by the kickoff in `ShopAgent` and
 * the `onWorkflow*` callback guards — the Agents SDK routes every workflow
 * callback through the same two hooks, so each must check which workflow it is
 * hearing from.
 */
export const ORDERS_SYNC_WORKFLOW_NAME = "ORDERS_SYNC_WORKFLOW";

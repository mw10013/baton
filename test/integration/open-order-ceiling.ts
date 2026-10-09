import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import * as Domain from "@/lib/Domain";

/**
 * Runs `body` with `ShopLimits.maxOpenOrders` lowered to `limit`, then
 * restores it, whatever `body` did.
 *
 * The real ceiling is more orders than a test should sync, so the ceiling
 * tests lower the constant for the duration — the same seam the open-run
 * ceiling tests use, and for the same reason: threading a limit through
 * `syncOrderWebhook` for nobody but a test would put a test seam in the
 * production signature. vitest-plugin runs each file in its own
 * isolate, so no other file sees the change.
 */
export const withMaxOpenOrders = <A>(limit: number, body: () => Promise<A>) => {
  const limits = Domain.ShopLimits as { maxOpenOrders: number };
  const original = limits.maxOpenOrders;
  limits.maxOpenOrders = limit;
  return body().finally(() => {
    limits.maxOpenOrders = original;
  });
};

/**
 * Stores `n` open orders (unfulfilled, not cancelled, no items) in `shop`'s
 * object, straight to SQL: the ceiling counts rows, and reaching it by
 * syncing would need Shopify. Ids are `gid://shopify/Order/open-<i>`, so
 * they never collide with a test's own orders.
 */
export const storeOpenOrders = (shop: string, n: number) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
    const { sql } = (instance as unknown as { ctx: DurableObjectState }).ctx
      .storage;
    const now = Date.now();
    for (let i = 1; i <= n; i++)
      sql.exec(
        `insert into ShopOrder (id, legacyId, name, processedAt, updatedAt, cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
         values (?, ?, ?, ?, ?, null, 'UNFULFILLED', 1, null, ?)`,
        `gid://shopify/Order/open-${String(i)}`,
        `open-${String(i)}`,
        `#open-${String(i)}`,
        now,
        now,
        now,
      );
  });

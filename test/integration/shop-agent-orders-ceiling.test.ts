import type { ShopAgent } from "@/lib/ShopAgent";

import { strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";

/**
 * The enterprise ceiling on the webhook path: at
 * `Domain.ShopLimits.maxOrdersPerCycle`, a *new* order is refused for the rest
 * of the billing period and the refusal is flagged for the merchant.
 *
 * The real ceiling is 10,000 orders, which no test can reach by syncing, so
 * these lower the constant for the duration — the same seam the open-run
 * ceiling tests use, and for the same reason: threading a limit through
 * `syncOrder` for nobody but this file would put a test seam in the production
 * signature.
 */
const withMaxOrdersPerCycle = <A>(limit: number, body: () => Promise<A>) => {
  const limits = Domain.ShopLimits as { maxOrdersPerCycle: number };
  const original = limits.maxOrdersPerCycle;
  limits.maxOrdersPerCycle = limit;
  return body().finally(() => {
    limits.maxOrdersPerCycle = original;
  });
};

const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
  "gid://shopify/Shop/1",
);

const agentFor = (shop: string) =>
  getAgentByName<Cloudflare.Env, ShopAgent>(env.SHOP_AGENT, shop);

/** The counter is written straight to SQL: reaching it by syncing would need Shopify. */
const setCount = (shop: string, ordersThisCycle: number) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
    (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
      "update ShopUsage set ordersThisCycle = ? where id = 1",
      ordersThisCycle,
    );
  });

const orderCount = (shop: string) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) =>
    Number(
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        .exec("select count(*) as n from ShopOrder")
        .one().n,
    ),
  );

const webhook = (orderId: string, webhookId: string) => ({
  orderId,
  topic: "orders/updated",
  webhookId,
  triggeredAt: 1000,
  updatedAt: 1000,
});

describe("ShopAgent order ceiling", () => {
  it("refuses a new order at the ceiling and flags the refusal", async () => {
    const shop = "ceiling.myshopify.com";
    await withMaxOrdersPerCycle(2, async () => {
      const agent = await agentFor(shop);
      await agent.setBillingCycle({
        shopGid,
        cycleStartAt: 0,
        cycleEndAt: 10_000,
      });
      await setCount(shop, 2);
      // No Shopify call is made: the refusal lands before the fetch, which is
      // what makes the webhook cheap to refuse and this case hermetic.
      await agent.syncOrder(webhook("gid://shopify/Order/1", "wh-1"));
      strictEqual(await orderCount(shop), 0);
      const usage = await agent.getUsage();
      strictEqual(usage.ordersThisCycle, 2);
      strictEqual(usage.ordersLimitedAt !== null, true);
    });
  });

  it("clears the refusal flag when a new billing cycle starts", async () => {
    const shop = "ceiling-rollover.myshopify.com";
    await withMaxOrdersPerCycle(2, async () => {
      const agent = await agentFor(shop);
      await agent.setBillingCycle({
        shopGid,
        cycleStartAt: 0,
        cycleEndAt: 10_000,
      });
      await setCount(shop, 2);
      await agent.syncOrder(webhook("gid://shopify/Order/2", "wh-2"));
      const limited = await agent.getUsage();
      strictEqual(limited.ordersLimitedAt !== null, true);
      await agent.setBillingCycle({
        shopGid,
        cycleStartAt: 10_000,
        cycleEndAt: 20_000,
      });
      const usage = await agent.getUsage();
      strictEqual(usage.ordersLimitedAt, null);
      strictEqual(usage.ordersThisCycle, 0);
    });
  });
});

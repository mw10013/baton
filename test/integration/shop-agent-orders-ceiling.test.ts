import type { ShopAgent } from "@/lib/ShopAgent";

import { strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";

import {
  openTwoScreens,
  receivedInvalidations,
  receivesNoMore,
} from "./agent-socket.ts";
import { withMaxOrdersPerCycle } from "./order-ceiling.ts";

/**
 * The enterprise ceiling on the webhook path: at
 * `Domain.ShopLimits.maxOrdersPerCycle`, a *new* order is refused for the rest
 * of the billing cycle and the refusal is flagged for the merchant. The
 * ceiling is lowered for each test by `withMaxOrdersPerCycle`.
 */

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

/**
 * A cycle that ends after the test does: the ceiling is read at the cycle the
 * sync lands in, after any roll-forward (rule 5 on `Domain.syncOrder`), so a
 * cycle already over would be rolled forward and recounted before the read.
 */
const CYCLE_END = Date.now() + 86_400_000;

const webhook = (orderId: string) => ({
  orderId,
  topic: "orders/paid",
  updatedAt: 1000,
});

describe("ShopAgent order ceiling", () => {
  /**
   * The refused order is on no team, so the publish names it and no team:
   * the orders index refetches for the banner's flag and no member list
   * moves.
   */
  it("a new order refused at the ceiling publishes to the merchant and no member", async () => {
    const shop = "ceiling-publishes.myshopify.com";
    await withMaxOrdersPerCycle(2, async () => {
      const agent = await agentFor(shop);
      await agent.setBillingCycle({
        shopGid,
        cycleStartAt: 0,
        cycleEndAt: CYCLE_END,
        memberCount: 0,
      });
      await setCount(shop, 2);
      const screens = await openTwoScreens(shop);
      await agent.syncOrderWebhook(webhook("gid://shopify/Order/1"));
      strictEqual(await orderCount(shop), 0);
      await receivedInvalidations(screens.merchant, 1);
      await receivesNoMore(screens.member);
      screens.close();
    });
  });

  it("refuses a new order at the ceiling and flags the refusal", async () => {
    const shop = "ceiling.myshopify.com";
    await withMaxOrdersPerCycle(2, async () => {
      const agent = await agentFor(shop);
      await agent.setBillingCycle({
        shopGid,
        cycleStartAt: 0,
        cycleEndAt: CYCLE_END,
        memberCount: 0,
      });
      await setCount(shop, 2);
      // No Shopify call is made: the refusal lands before the fetch, which is
      // what makes the webhook cheap to refuse and this case hermetic.
      await agent.syncOrderWebhook(webhook("gid://shopify/Order/1"));
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
        cycleEndAt: CYCLE_END,
        memberCount: 0,
      });
      await setCount(shop, 2);
      await agent.syncOrderWebhook(webhook("gid://shopify/Order/2"));
      const limited = await agent.getUsage();
      strictEqual(limited.ordersLimitedAt !== null, true);
      await agent.setBillingCycle({
        shopGid,
        cycleStartAt: CYCLE_END,
        cycleEndAt: CYCLE_END + 86_400_000,
        memberCount: 0,
      });
      const usage = await agent.getUsage();
      strictEqual(usage.ordersLimitedAt, null);
      strictEqual(usage.ordersThisCycle, 0);
    });
  });
});

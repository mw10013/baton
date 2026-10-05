import type { ShopAgent } from "@/lib/ShopAgent";

import { strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, it } from "vitest";

import {
  openTwoScreens,
  receivedInvalidations,
  receivesNoMore,
} from "./agent-socket.ts";
import { storeOpenOrders, withMaxOpenOrders } from "./open-order-ceiling.ts";

/**
 * The order ceiling on the webhook path: at `Domain.ShopLimits.maxOpenOrders`
 * open orders stored, a *new* order is refused until one closes, and the
 * refusal is flagged for the merchant. The ceiling is lowered for each test
 * by `withMaxOpenOrders`.
 */

const agentFor = (shop: string) =>
  getAgentByName<Cloudflare.Env, ShopAgent>(env.SHOP_AGENT, shop);

const orderCount = (shop: string) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) =>
    Number(
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        .exec("select count(*) as n from ShopOrder")
        .one().n,
    ),
  );

const webhook = (orderId: string) => ({
  orderId,
  topic: "orders/paid",
  updatedAt: 1000,
});

describe("ShopAgent order ceiling", () => {
  /**
   * The refusal stored no order, so no live screen would read anything new;
   * the banner's flag reaches the orders index with its next loader read.
   * The socket's invalidation would arrive before the RPC returns, so the
   * quiet window after it is the assertion; the seed after it is the positive
   * control, proving both sockets were listening.
   */
  it("a new order refused at the ceiling publishes nothing", async () => {
    const shop = "ceiling-publishes.myshopify.com";
    await withMaxOpenOrders(2, async () => {
      const agent = await agentFor(shop);
      await storeOpenOrders(shop, 2);
      const screens = await openTwoScreens(shop);
      await agent.syncOrderWebhook(webhook("gid://shopify/Order/1"));
      strictEqual(await orderCount(shop), 2);
      await receivesNoMore(screens.merchant);
      await receivesNoMore(screens.member);
      await agent.seedOrders({
        memberId: "member-seed",
        memberEmail: "seed@example.com",
        orders: [{ n: 1, lineItems: [] }],
      });
      await receivedInvalidations(screens.merchant, 1);
      await receivedInvalidations(screens.member, 1);
      screens.close();
    });
  });

  it("refuses a new order at the ceiling and flags the refusal", async () => {
    const shop = "ceiling.myshopify.com";
    await withMaxOpenOrders(2, async () => {
      const agent = await agentFor(shop);
      await storeOpenOrders(shop, 2);
      // No Shopify call is made: the refusal lands before the fetch, which is
      // what makes the webhook cheap to refuse and this case hermetic.
      await agent.syncOrderWebhook(webhook("gid://shopify/Order/1"));
      strictEqual(await orderCount(shop), 2);
      const usage = await agent.getUsage();
      strictEqual(usage.openOrders, 2);
      strictEqual(usage.ordersLimitedAt !== null, true);
    });
  });

  /**
   * Only Sync open orders clears the flag
   * (`OrderRepository.clearOrdersLimited`); the start that clears it is
   * exercised in `shop-agent-sync-order.test.ts`, which has the Admin API
   * stand-in a sync needs.
   */
  it("keeps the refusal flag when a new order is stored after one closes", async () => {
    const shop = "ceiling-kept.myshopify.com";
    await withMaxOpenOrders(2, async () => {
      const agent = await agentFor(shop);
      await storeOpenOrders(shop, 2);
      await agent.syncOrderWebhook(webhook("gid://shopify/Order/2"));
      const limited = await agent.getUsage();
      strictEqual(limited.ordersLimitedAt !== null, true);
      await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
        (
          instance as unknown as { ctx: DurableObjectState }
        ).ctx.storage.sql.exec(
          "update ShopOrder set fulfillmentStatus = 'FULFILLED' where id = 'gid://shopify/Order/open-1'",
        );
      });
      await agent.seedOrders({
        memberId: "member-seed",
        memberEmail: "seed@example.com",
        orders: [{ n: 1, lineItems: [] }],
      });
      const usage = await agent.getUsage();
      strictEqual(usage.ordersLimitedAt !== null, true);
      strictEqual(usage.openOrders, 2);
    });
  });
});

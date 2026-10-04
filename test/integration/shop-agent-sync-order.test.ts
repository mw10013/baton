import type { ShopAgent } from "@/lib/ShopAgent";

import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { getAgentByName } from "agents";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

import { isInvalidated, openMerchantSocket } from "./agent-socket.ts";
import { withMaxOrdersPerCycle } from "./order-ceiling.ts";

/**
 * Sync from Shopify through the object: the offline session is a row in D1
 * and the Admin API is answered here rather than by Shopify.
 *
 * The object shares this isolate, and `@shopify/shopify-api` sends through
 * the fetch its adapter registered when it was imported, not through
 * `globalThis.fetch`, so the stand-in replaces that registration. It answers
 * the one-order query for every `/admin/api/` request and delegates
 * everything else to the real `fetch`; vitest-pool-workers runs each file in
 * its own isolate, so no other file sees it. `shopifyHasOrder` false makes
 * it answer `null`, as Shopify does for a deleted order.
 */
const ORDER_ID = "gid://shopify/Order/1";
const adminRequests: string[] = [];
let shopifyHasOrder = true;
/** The product tags Shopify answers for the order's one item. */
let productTags = ["engraved"];
/** The order's `updatedAt` Shopify answers; null is the time of the request. */
let orderUpdatedAt: string | null = null;
const realFetch = globalThis.fetch;
setAbstractFetchFunc(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/api/")) return realFetch(input, init);
  adminRequests.push(url.hostname);
  if (!shopifyHasOrder) return Response.json({ data: { order: null } });
  const now = new Date().toISOString();
  const updatedAt = orderUpdatedAt ?? now;
  return Response.json({
    data: {
      order: {
        id: ORDER_ID,
        legacyResourceId: "1",
        name: "#1001",
        processedAt: now,
        updatedAt,
        cancelledAt: null,
        displayFulfillmentStatus: "UNFULFILLED",
        fullyPaid: true,
        note: null,
        lineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: "gid://shopify/LineItem/1",
              title: "Necklace",
              variantTitle: null,
              sku: null,
              quantity: 1,
              currentQuantity: 1,
              customAttributes: [],
              product: { tags: productTags },
            },
          ],
        },
      },
    },
  });
});

const shopOf = Schema.decodeUnknownSync(Domain.Shop);

const layer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

/** A shop with an offline session that never expires, and one team. */
const seedShop = (shop: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* Repository;
      yield* repo.upsertShopSession({
        shop: shopOf(shop),
        shopGid: Schema.decodeUnknownSync(Domain.ShopGid)(
          "gid://shopify/Shop/1",
        ),
        shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
          `agent-${shop}`,
        ),
        scope: "read_orders",
        accessTokenExpiresAt: null,
        accessToken: "test-token",
        refreshToken: null,
        refreshTokenExpiresAt: null,
      });
      return yield* repo.createTeam({
        shop: shopOf(shop),
        name: Schema.decodeUnknownSync(Domain.TeamName)("Engraving"),
      });
    }).pipe(Effect.provide(layer)),
  );

afterEach(async () => {
  adminRequests.length = 0;
  shopifyHasOrder = true;
  productTags = ["engraved"];
  orderUpdatedAt = null;
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from ShopSession");
});

/** A workflow that is on, tagged `engraved`, with one step for `teamId`. */
const turnOnEngraving = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
  teamId: Domain.TeamId,
) => {
  const created = await agent.createWorkflow({
    name: "Engraving",
    tag: "engraved",
  });
  if (created._tag !== "Ok") throw new Error(created._tag);
  const workflowId = created.workflow.id;
  await agent.addStep({ workflowId, name: "Engrave", teamId });
  const applied = await agent.applyDraft({ workflowId });
  if (applied._tag !== "Ok") throw new Error(applied._tag);
  const on = await agent.setWorkflowOn({ workflowId, on: true });
  if (on._tag !== "Ok") throw new Error(on._tag);
  return workflowId;
};

/** The stored order row, read straight from the object's SQLite. */
const storedOrder = (shop: string) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) =>
    (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
      .exec(
        "select cancelledAt, updatedAt, syncedAt from ShopOrder where id = ?",
        ORDER_ID,
      )
      .toArray(),
  );

/** What the order page shows of each run: which run, its state, its quantity and how many tasks. */
const runsAsShown = (runs: readonly Domain.RunDetail[]) =>
  runs.map(({ run, tasks }) => [run.id, run.state, run.quantity, tasks.length]);

/** A merchant socket subscribed to the orders index, which every order publish reaches. */
const subscribeOrdersIndex = async (shop: string) => {
  const merchant = await openMerchantSocket(shop);
  await merchant.socket.call("subscribeOrders", {
    subscriberId: "orders-index",
    limit: 50,
    cursor: null,
    q: null,
    show: null,
    team: null,
  });
  return merchant;
};

/** How many `invalidated` frames the socket has received after waiting out a quiet window. */
const invalidatedCount = async (
  socket: Awaited<ReturnType<typeof openMerchantSocket>>["socket"],
) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 200);
  });
  return socket.received.filter(isInvalidated).length;
};

const runCount = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
) => {
  const runs = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
  return runs.length;
};

describe("ShopAgent one-order sync", () => {
  it("a product retagged in Shopify changes nothing until its order syncs again", async () => {
    const shop = "sync-order-retag.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await turnOnEngraving(agent, team.id);
    productTags = ["plain"];
    await agent.syncOrder({ orderId: ORDER_ID });
    strictEqual(await runCount(agent), 0);
    // Retagged in Shopify: the stored item keeps the tags it was synced
    // with, so nothing Baton does in between sees the new tag.
    productTags = ["engraved"];
    strictEqual(await runCount(agent), 0);
    await agent.syncOrder({ orderId: ORDER_ID });
    strictEqual(await runCount(agent), 1);
  });

  it("an item's product tags are rewritten by the next sync and a run created from the old tags is not revisited", async () => {
    const shop = "sync-order-retag-run.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await turnOnEngraving(agent, team.id);
    await agent.syncOrder({ orderId: ORDER_ID });
    const [created] = await agent.merchantListRunsForOrder({
      orderId: ORDER_ID,
    });
    strictEqual(created?.run.state, "open");
    productTags = ["plain"];
    await agent.syncOrder({ orderId: ORDER_ID });
    const tags = await runInDurableObject(
      env.SHOP_AGENT.getByName(shop),
      (instance) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
          .exec(
            "select productTags from OrderLineItem where orderId = ?",
            ORDER_ID,
          )
          .one().productTags,
    );
    deepStrictEqual(JSON.parse(typeof tags === "string" ? tags : "null"), [
      "plain",
    ]);
    // The item no longer carries the workflow's tag; its run stays, open.
    const runs = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
    deepStrictEqual(
      runs.map(({ run }) => [run.id, run.state]),
      [[created?.run.id, "open"]],
    );
  });

  it("the one-order sync stores the order and creates its run", async () => {
    const shop = "sync-order.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engraving",
      tag: "engraved",
    });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;
    await agent.addStep({ workflowId, name: "Engrave", teamId: team.id });
    const applied = await agent.applyDraft({ workflowId });
    if (applied._tag !== "Ok") throw new Error(applied._tag);
    const on = await agent.setWorkflowOn({ workflowId, on: true });
    if (on._tag !== "Ok") throw new Error(on._tag);

    await agent.syncOrder({ orderId: ORDER_ID });
    strictEqual(adminRequests.length, 1);
    const first = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
    strictEqual(first.length, 1);
    strictEqual(first[0]?.run.workflowId, workflowId);

    // A second click fetches again and creates nothing: the item holds its run.
    await agent.syncOrder({ orderId: ORDER_ID });
    strictEqual(adminRequests.length, 2);
    const second = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
    strictEqual(second.length, 1);
    strictEqual(second[0]?.run.id, first[0]?.run.id);
  });
  it("the one-order sync answers Gone for an order Shopify no longer has and leaves the stored row", async () => {
    const shop = "sync-order-gone.myshopify.com";
    await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const stored = await agent.syncOrder({ orderId: ORDER_ID });
    strictEqual(stored._tag, "Stored");
    const before = await storedOrder(shop);
    strictEqual(before.length, 1);

    shopifyHasOrder = false;
    const gone = await agent.syncOrder({ orderId: ORDER_ID });
    strictEqual(gone._tag, "Gone");
    deepStrictEqual(await storedOrder(shop), before);
  });

  it("a webhook's topic decides nothing: a cancelled topic on an open order stores it open", async () => {
    const shop = "sync-order-topic.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const workflowId = await turnOnEngraving(agent, team.id);

    await agent.syncOrderWebhook({
      orderId: ORDER_ID,
      topic: "orders/cancelled",
      updatedAt: null,
    });
    const [row] = await storedOrder(shop);
    strictEqual(row?.cancelledAt, null);
    const runs = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
    strictEqual(runs.length, 1);
    strictEqual(runs[0]?.run.workflowId, workflowId);
    strictEqual(runs[0]?.run.state, "open");
  });
  it("a redelivered webhook rewrites the same version and changes nothing a screen shows", async () => {
    const shop = "sync-order-redelivered.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await turnOnEngraving(agent, team.id);
    orderUpdatedAt = "2026-09-02T12:00:00.000Z";
    // An edit carries no version, so each delivery fetches; Shopify answers
    // the same version both times.
    const deliver = () =>
      agent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/edited",
        updatedAt: null,
      });
    const merchant = await subscribeOrdersIndex(shop);
    await deliver();
    const firstRuns = await agent.merchantListRunsForOrder({
      orderId: ORDER_ID,
    });
    const [first] = await storedOrder(shop);
    await merchant.socket.waitForMessage(isInvalidated);
    await deliver();
    strictEqual(adminRequests.length, 2);
    // The first delivery stored the order and created its run; the second
    // moved neither, so it published nothing.
    strictEqual(await invalidatedCount(merchant.socket), 1);
    merchant.close();
    const [second] = await storedOrder(shop);
    strictEqual(second?.updatedAt, first?.updatedAt);
    strictEqual(second?.cancelledAt, first?.cancelledAt);
    const secondRuns = await agent.merchantListRunsForOrder({
      orderId: ORDER_ID,
    });
    deepStrictEqual(runsAsShown(secondRuns), runsAsShown(firstRuns));
    strictEqual(firstRuns.length, 1);
  });

  it("a webhook that moves the order's updatedAt publishes even when no run moved", async () => {
    const shop = "sync-order-newer.myshopify.com";
    await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const deliver = () =>
      agent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/edited",
        updatedAt: null,
      });
    orderUpdatedAt = "2026-09-02T12:00:00.000Z";
    await deliver();
    const merchant = await subscribeOrdersIndex(shop);
    // A note edit: a newer version, and no workflow, so no run moves.
    orderUpdatedAt = "2026-09-02T12:05:00.000Z";
    await deliver();
    await merchant.socket.waitForMessage(isInvalidated);
    strictEqual(await runCount(agent), 0);
    merchant.close();
  });

  it("a webhook on the same version whose reconcile creates a run publishes", async () => {
    const shop = "sync-order-same-version-run.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await turnOnEngraving(agent, team.id);
    const deliver = () =>
      agent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/edited",
        updatedAt: null,
      });
    orderUpdatedAt = "2026-09-02T12:00:00.000Z";
    productTags = ["plain"];
    await deliver();
    strictEqual(await runCount(agent), 0);
    const merchant = await subscribeOrdersIndex(shop);
    // The same version, but the item now carries the workflow's tag: the
    // row does not move and the reconcile creates the run. Gating on
    // `written` alone would publish here too; gating on the row alone
    // would not.
    productTags = ["engraved"];
    await deliver();
    strictEqual(await runCount(agent), 1);
    await merchant.socket.waitForMessage(isInvalidated);
    merchant.close();
  });

  it("the order ceiling is read at the cycle the sync lands in: a sync after the cycle end is not refused at the old count", async () => {
    /** A shop whose stored cycle ended at 10s past the epoch, counted at the ceiling. */
    const atOldCeiling = async (shop: string) => {
      await seedShop(shop);
      const agent = await getAgentByName(env.SHOP_AGENT, shop);
      await agent.setBillingCycle({
        shopGid: Schema.decodeUnknownSync(Domain.ShopGid)(
          "gid://shopify/Shop/1",
        ),
        cycleStartAt: 0,
        cycleEndAt: 10_000,
        memberCount: 0,
      });
      await runInDurableObject(env.SHOP_AGENT.getByName(shop), (object) => {
        (object as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
          "update ShopUsage set ordersThisCycle = 2 where id = 1",
        );
      });
      return agent;
    };
    await withMaxOrdersPerCycle(2, async () => {
      const webhookShop = "sync-order-cycle-webhook.myshopify.com";
      const webhookAgent = await atOldCeiling(webhookShop);
      await webhookAgent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/create",
        updatedAt: null,
      });
      const stored = await storedOrder(webhookShop);
      strictEqual(stored.length, 1);
      const usage = await webhookAgent.getUsage();
      strictEqual(usage.ordersLimitedAt, null);
      strictEqual(usage.cycleStartAt, 10_000);
      strictEqual(usage.ordersThisCycle, 0);

      const syncShop = "sync-order-cycle-sync.myshopify.com";
      const syncAgent = await atOldCeiling(syncShop);
      await using introspector = await introspectWorkflow(
        env.ORDERS_SYNC_WORKFLOW,
      );
      await introspector.modifyAll(async (m) => {
        await m.disableSleeps();
        await m.mockStepResult({ name: "ensure-session" }, []);
        await m.mockStepResult(
          { name: "run-bulk-orders-query" },
          {
            id: "gid://shopify/BulkOperation/1",
            status: "COMPLETED",
            errorCode: null,
            createdAt: "2026-09-01T00:00:00.000Z",
            completedAt: "2026-09-01T00:01:00.000Z",
            objectCount: 0,
            fileSize: null,
            url: null,
            partialDataUrl: null,
          },
        );
        await m.mockStepResult({ name: "on-orders-sync-empty" }, { ok: true });
      });
      const started = await syncAgent.syncOpenOrders();
      strictEqual(started._tag, "Started");
      const [instance] = await introspector.get();
      await instance?.waitForStatus("complete");
      const after = await syncAgent.getUsage();
      strictEqual(after.ordersThisCycle, 0);
    });
  });
});

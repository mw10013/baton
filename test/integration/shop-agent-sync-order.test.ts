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
const realFetch = globalThis.fetch;
setAbstractFetchFunc(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/api/")) return realFetch(input, init);
  adminRequests.push(url.hostname);
  if (!shopifyHasOrder) return Response.json({ data: { order: null } });
  const now = new Date().toISOString();
  return Response.json({
    data: {
      order: {
        id: ORDER_ID,
        legacyResourceId: "1",
        name: "#1001",
        processedAt: now,
        updatedAt: now,
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

/** `Domain.ShopLimits.maxOpenRuns` lowered for one test; the object shares this isolate. */
const withMaxOpenRuns = async <A>(limit: number, body: () => Promise<A>) => {
  const limits = Domain.ShopLimits as { maxOpenRuns: number };
  const original = limits.maxOpenRuns;
  limits.maxOpenRuns = limit;
  try {
    return await body();
  } finally {
    limits.maxOpenRuns = original;
  }
};

/** Runs a statement on the object's SQLite. */
const exec = (shop: string, query: string, ...bindings: unknown[]) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (object) => {
    (object as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
      query,
      ...bindings,
    );
  });

const runCount = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
) => {
  const runs = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
  return runs.length;
};

const openRunsLimitedAt = (shop: string) =>
  runInDurableObject(
    env.SHOP_AGENT.getByName(shop),
    (object) =>
      (object as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        .exec("select openRunsLimitedAt from ShopUsage where id = 1")
        .one().openRunsLimitedAt,
  );

describe("ShopAgent one-order sync", () => {
  it("at the open-run ceiling a pass declines, the webhook answers 2xx and the order is stored without its run", async () => {
    const shop = "sync-order-open-run-ceiling.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await turnOnEngraving(agent, team.id);
    await withMaxOpenRuns(0, async () => {
      // Resolving is the 2xx: the route answers with what this returns, and
      // a failure here would be a 5xx Shopify retries for hours.
      await agent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/paid",
        webhookId: "wh-open-run-ceiling",
        updatedAt: null,
      });
      const stored = await storedOrder(shop);
      strictEqual(stored.length, 1);
      strictEqual(await runCount(agent), 0);
      strictEqual(typeof (await openRunsLimitedAt(shop)), "number");
    });
  });

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

  it("the retention sweep releases the open-run ceiling when its deletes make room", async () => {
    const shop = "sync-order-sweep-release.myshopify.com";
    const team = await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await turnOnEngraving(agent, team.id);
    // An order past retention holding the shop's one open run, written
    // straight to SQL: a year-old order is never stored by a sync.
    const expired =
      Date.now() - (Domain.ShopLimits.orderRetentionDays + 1) * 86_400_000;
    await exec(
      shop,
      `insert into ShopOrder (id, legacyId, name, processedAt, updatedAt,
         fulfillmentStatus, fullyPaid, syncedAt)
       values ('gid://shopify/Order/9', '9', '#9', ?, ?, 'UNFULFILLED', 1, ?)`,
      expired,
      expired,
      expired,
    );
    await exec(
      shop,
      `insert into Run (id, workflowId, workflowName, orderId, orderName,
         orderProcessedAt, lineItemId, lineItemTitle, quantity,
         lineItemProperties, state, createdAt, updatedAt)
       values ('run-9', 'wf', 'Engraving', 'gid://shopify/Order/9', '#9', ?,
         'gid://shopify/LineItem/9', 'Ring', 1, '[]', 'open', ?, ?)`,
      expired,
      expired,
      expired,
    );
    await withMaxOpenRuns(1, async () => {
      // Swept recently: this webhook declines the order's run at the
      // open-run ceiling and does not sweep.
      await exec(
        shop,
        "update ShopUsage set lastSweepAt = ? where id = 1",
        Date.now(),
      );
      await agent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/paid",
        webhookId: "wh-sweep-1",
        updatedAt: null,
      });
      strictEqual(await runCount(agent), 0);
      strictEqual(typeof (await openRunsLimitedAt(shop)), "number");
      // Due again: the sweep deletes the old order with its open run, which
      // makes room, and the reconcile all creates the declined run.
      await exec(shop, "update ShopUsage set lastSweepAt = null where id = 1");
      await agent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/updated",
        webhookId: "wh-sweep-2",
        updatedAt: null,
      });
      strictEqual(await openRunsLimitedAt(shop), null);
      const runs = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
      strictEqual(runs.length, 1);
      strictEqual(runs[0]?.run.state, "open");
    });
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
      webhookId: "wh-cancelled",
      updatedAt: null,
    });
    const [row] = await storedOrder(shop);
    strictEqual(row?.cancelledAt, null);
    const runs = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
    strictEqual(runs.length, 1);
    strictEqual(runs[0]?.run.workflowId, workflowId);
    strictEqual(runs[0]?.run.state, "open");
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
        webhookId: "wh-cycle",
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

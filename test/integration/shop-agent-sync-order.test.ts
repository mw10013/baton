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

import {
  openTwoScreens,
  receivedInvalidations,
  receivesNoMore,
} from "./agent-socket.ts";
import { storeOpenOrders, withMaxOpenOrders } from "./open-order-ceiling.ts";

/**
 * Sync from Shopify through the object: the offline session is a row in D1
 * and the Admin API is answered here rather than by Shopify.
 *
 * The object shares this isolate, and `@shopify/shopify-api` sends through
 * the fetch its adapter registered when it was imported, not through
 * `globalThis.fetch`, so the stand-in replaces that registration. It answers
 * the one-order query for every `/admin/api/` request and delegates
 * everything else to the real `fetch`; vitest-pool-workers runs each file in
 * its own isolate, so no other file sees it. It answers the order the
 * request names, `ORDER_ID` when it names none. `shopifyHasOrder` false makes
 * it answer `null`, as Shopify does for a deleted order.
 */
const ORDER_ID = "gid://shopify/Order/1";
const adminRequests: string[] = [];
let shopifyHasOrder = true;
/** The product tags Shopify answers for the order's one item. */
let productTags = ["engraved"];
/** The order's `updatedAt` Shopify answers; null is the time of the request. */
let orderUpdatedAt: string | null = null;
/** The order's `cancelledAt` Shopify answers. */
let orderCancelledAt: string | null = null;
/** The order's `displayFulfillmentStatus` Shopify answers. */
let orderFulfillmentStatus = "UNFULFILLED";
const realFetch = globalThis.fetch;
setAbstractFetchFunc(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/api/")) return realFetch(input, init);
  adminRequests.push(url.hostname);
  if (!shopifyHasOrder) return Response.json({ data: { order: null } });
  const body: { readonly variables?: { readonly id?: string } } =
    await request.json();
  const id = body.variables?.id ?? ORDER_ID;
  const now = new Date().toISOString();
  const updatedAt = orderUpdatedAt ?? now;
  return Response.json({
    data: {
      order: {
        id,
        legacyResourceId: "1",
        name: "#1001",
        processedAt: now,
        updatedAt,
        cancelledAt: orderCancelledAt,
        displayFulfillmentStatus: orderFulfillmentStatus,
        fullyPaid: true,
        note: null,
        lineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              // One item id per order: the item table's key is shop-wide.
              id: `gid://shopify/LineItem/${id === ORDER_ID ? "1" : "2"}`,
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
  orderCancelledAt = null;
  orderFulfillmentStatus = "UNFULFILLED";
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from ShopSession");
});

/** An active workflow, tagged `engraved`, with one step for `teamId`. */
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
  const on = await agent.setWorkflowState({ workflowId, state: "active" });
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
    const on = await agent.setWorkflowState({ workflowId, state: "active" });
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
    const screens = await openTwoScreens(shop);
    await deliver();
    const firstRuns = await agent.merchantListRunsForOrder({
      orderId: ORDER_ID,
    });
    const [first] = await storedOrder(shop);
    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    await deliver();
    strictEqual(adminRequests.length, 2);
    // The first delivery stored the order and created its run; the second
    // moved neither, so it published nothing.
    await receivesNoMore(screens.merchant, 1);
    await receivesNoMore(screens.member, 1);
    screens.close();
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
    const screens = await openTwoScreens(shop);
    // A note edit: a newer version, and no workflow, so no run moves.
    orderUpdatedAt = "2026-09-02T12:05:00.000Z";
    await deliver();
    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    strictEqual(await runCount(agent), 0);
    screens.close();
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
    const screens = await openTwoScreens(shop);
    // The same version, but the item now carries the workflow's tag: the
    // row does not move and the reconcile creates the run. Gating on
    // `written` alone would publish here too; gating on the row alone
    // would not.
    productTags = ["engraved"];
    await deliver();
    strictEqual(await runCount(agent), 1);
    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    screens.close();
  });

  it("a webhook whose sweep deletes an order publishes and the orders index stops showing it", async () => {
    const shop = "sync-order-sweep-publishes.myshopify.com";
    await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const deliver = () =>
      agent.syncOrderWebhook({
        orderId: ORDER_ID,
        topic: "orders/edited",
        updatedAt: null,
      });
    orderUpdatedAt = "2026-09-02T12:00:00.000Z";
    // Stores the order and marks the first sweep, which found nothing.
    await deliver();
    // An order past retention, stored behind the sweep's back, and the sweep
    // mark cleared so the next delivery sweeps again.
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
      const { sql } = (instance as unknown as { ctx: DurableObjectState }).ctx
        .storage;
      sql.exec(
        `insert into ShopOrder (id, legacyId, name, processedAt, updatedAt,
          cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
         values ('gid://shopify/Order/9', '9', '#9', 1000, 1000, null,
          'UNFULFILLED', 1, null, 1000)`,
      );
      sql.exec("update ShopUsage set lastSweepAt = null where id = 1");
    });
    const list = async () => {
      const { page } = await agent.listOrders({
        limit: 25,
        cursor: null,
        q: null,
        show: "open",
        team: null,
      });
      return page.orders.map(({ order }) => order.id).toSorted();
    };
    deepStrictEqual(await list(), [ORDER_ID, "gid://shopify/Order/9"]);
    const screens = await openTwoScreens(shop);
    // The same version: the webhook's own order does not change, and the
    // sweep deletes the expired one.
    await deliver();
    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    screens.close();
    deepStrictEqual(await list(), [ORDER_ID]);
  });

  it("Sync this order publishes when it changed something, and nothing when it did not", async () => {
    const shop = "sync-order-button-publishes.myshopify.com";
    await seedShop(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    orderUpdatedAt = "2026-09-02T12:00:00.000Z";
    const screens = await openTwoScreens(shop);
    await agent.syncOrder({ orderId: ORDER_ID });
    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    // The same version again: no row moves and no run, so no publish.
    await agent.syncOrder({ orderId: ORDER_ID });
    await receivesNoMore(screens.merchant, 1);
    await receivesNoMore(screens.member, 1);
    screens.close();
  });

  it("the order ceiling is read against the open orders stored: a fulfilled order makes room for a new one", async () => {
    await withMaxOpenOrders(2, async () => {
      const webhookShop = "sync-order-ceiling-webhook.myshopify.com";
      await seedShop(webhookShop);
      const webhookAgent = await getAgentByName(env.SHOP_AGENT, webhookShop);
      await storeOpenOrders(webhookShop, 2);
      const create = {
        orderId: ORDER_ID,
        topic: "orders/create",
        updatedAt: null,
      };
      await webhookAgent.syncOrderWebhook(create);
      const refusedRows = await storedOrder(webhookShop);
      strictEqual(refusedRows.length, 0);
      strictEqual(adminRequests.length, 0);
      orderFulfillmentStatus = "FULFILLED";
      await webhookAgent.syncOrderWebhook({
        orderId: "gid://shopify/Order/open-1",
        topic: "orders/fulfilled",
        updatedAt: null,
      });
      orderFulfillmentStatus = "UNFULFILLED";
      await webhookAgent.syncOrderWebhook(create);
      const storedRows = await storedOrder(webhookShop);
      strictEqual(storedRows.length, 1);
      const usage = await webhookAgent.getUsage();
      strictEqual(usage.openOrders, 2);
      // Stored again, but the refused delivery is still a gap: the flag
      // stays until Sync open orders starts.
      strictEqual(usage.ordersLimitedAt !== null, true);

      const syncShop = "sync-order-ceiling-sync.myshopify.com";
      await seedShop(syncShop);
      const syncAgent = await getAgentByName(env.SHOP_AGENT, syncShop);
      await storeOpenOrders(syncShop, 2);
      const refused = await syncAgent.syncOpenOrders();
      strictEqual(refused._tag, "Refused");
      const refusedUsage = await syncAgent.getUsage();
      strictEqual(refusedUsage.ordersLimitedAt !== null, true);
      await runInDurableObject(env.SHOP_AGENT.getByName(syncShop), (object) => {
        (object as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
          "update ShopOrder set fulfillmentStatus = 'FULFILLED' where id = 'gid://shopify/Order/open-1'",
        );
      });
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
      // The start clears the flag (`OrderRepository.clearOrdersLimited`).
      const startedUsage = await syncAgent.getUsage();
      strictEqual(startedUsage.ordersLimitedAt, null);
      const [instance] = await introspector.get();
      await instance?.waitForStatus("complete");
    });
  });
});

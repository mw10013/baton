import { strictEqual } from "@effect/vitest/utils";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { getAgentByName } from "agents";
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

/**
 * Sync from Shopify through the object: the offline session is a row in D1
 * and the Admin API is answered here rather than by Shopify.
 *
 * The object shares this isolate, and `@shopify/shopify-api` sends through
 * the fetch its adapter registered when it was imported, not through
 * `globalThis.fetch`, so the stand-in replaces that registration. It answers
 * the one-order query for every `/admin/api/` request and delegates
 * everything else to the real `fetch`; vitest-pool-workers runs each file in
 * its own isolate, so no other file sees it.
 */
const ORDER_ID = "gid://shopify/Order/1";
const adminRequests: string[] = [];
const realFetch = globalThis.fetch;
setAbstractFetchFunc(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/api/")) return realFetch(input, init);
  adminRequests.push(url.hostname);
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
              product: { tags: ["engraved"] },
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
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from ShopSession");
});

describe("ShopAgent one-order sync", () => {
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
});

import type { ShopAgent } from "@/lib/ShopAgent";

import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { afterEach, beforeEach, describe, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";

/**
 * Every path that creates a run sends the queue after its write commits: the
 * rule on `flushUsageEvents` in `ShopAgent.ts`, which names these tests. Run
 * through the object so the flush is the object's own, with its own
 * `ShopifyAppEvents` client.
 *
 * App Events requests are answered here rather than by Shopify. The object
 * shares this isolate, and Effect's fetch client reads `globalThis.fetch` the
 * first time it sends and keeps that function, so the stand-in is installed
 * at module load, before any request, and delegates everything that is not
 * `api.shopify.com` to the real `fetch`. The patch reaches no other test
 * file: vitest-pool-workers runs each file in its own isolate.
 */
const appEvents: { idempotencyKey: string; value: number }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "api.shopify.com") return realFetch(input, init);
  if (url.pathname === "/auth/access_token")
    return Response.json({ access_token: "test-token" });
  const body = (await request.json()) as {
    readonly idempotency_key: string;
    readonly attributes: { readonly value: number };
  };
  appEvents.push({
    idempotencyKey: body.idempotency_key,
    value: body.attributes.value,
  });
  return new Response(null, { status: 202 });
};

const DAY = 86_400_000;
const ORDER_ID = "gid://shopify/Order/1";
const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
  "gid://shopify/Shop/1",
);
const shopOf = Schema.decodeUnknownSync(Domain.Shop);

const layer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

const seedTeam = (shop: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* Repository;
      yield* repo.upsertShopSession({
        shop: shopOf(shop),
        shopGid,
        shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
          `agent-${shop}`,
        ),
        scope: null,
        accessTokenExpiresAt: null,
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      });
      return yield* repo.createTeam({
        shop: shopOf(shop),
        name: Schema.decodeUnknownSync(Domain.TeamName)("Bench"),
      });
    }).pipe(Effect.provide(layer)),
  );

/** One paid order with one item tagged `tag`, written through the repository as the other object tests do. */
const seedOrder = (shop: string, processedAt: number, tag: string) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          yield* (yield* OrderRepository).upsertOrder({
            order: {
              id: ORDER_ID,
              legacyId: "1",
              name: "#1001",
              processedAt,
              updatedAt: processedAt,
              cancelledAt: null,
              fulfillmentStatus: "UNFULFILLED",
              fullyPaid: true,
              note: null,
              lineItemsTruncated: false,
              syncedAt: processedAt,
            },
            lineItems: [
              {
                id: "gid://shopify/LineItem/1",
                orderId: ORDER_ID,
                title: "Necklace",
                variantTitle: null,
                sku: null,
                quantity: 1,
                currentQuantity: 1,
                productTags: [tag],
                matchedWorkflowIds: [],
                properties: [],
              },
            ],
          });
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              OrderRepository.layer,
              SqliteClient.layer({ storage: state.storage }),
            ),
          ),
        ),
      ),
  );

/** An applied, off workflow matching `tag`, with one task on `teamId`. */
const offWorkflow = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
  tag: string,
  teamId: string,
) => {
  const created = await agent.createWorkflow({ name: "Engrave", tag });
  if (created._tag !== "Ok") throw new Error(created._tag);
  const workflowId = created.workflow.id;
  await agent.addStep({ workflowId, name: "Engrave", teamId });
  const applied = await agent.applyDraft({ workflowId });
  if (applied._tag !== "Ok") throw new Error(applied._tag);
  return workflowId;
};

/** A billing cycle around now, so the flush has a shop to address and every event is live. */
const openCycle = (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
) =>
  agent.setBillingCycle({
    shopGid,
    cycleStartAt: Date.now() - 2 * DAY,
    cycleEndAt: Date.now() + 28 * DAY,
    memberCount: 0,
  });

const countKey = `${ORDER_ID}#count`;

beforeEach(() => {
  appEvents.length = 0;
});

afterEach(async () => {
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from ShopSession");
});

describe("ShopAgent usage flush", () => {
  it("attaching a workflow sends the usage event it queued", async () => {
    const shop = "flush-attach.myshopify.com";
    const team = await seedTeam(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await openCycle(agent);
    await seedOrder(shop, Date.now() - DAY, "engrave");
    const workflowId = await offWorkflow(agent, "engrave", team.id);
    // On after the order was placed, so nothing starts it but the attach.
    await agent.setWorkflowOn({ workflowId, on: true });
    strictEqual(appEvents.length, 0);

    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(attached._tag, "Ok");
    deepStrictEqual(appEvents, [{ idempotencyKey: countKey, value: 1 }]);
    const usage = await agent.getUsage();
    strictEqual(usage.pendingUsageEvents, 0);
  });

  it("turning a workflow on sends the usage events for the orders it counted", async () => {
    const shop = "flush-turn-on.myshopify.com";
    const team = await seedTeam(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await openCycle(agent);
    const workflowId = await offWorkflow(agent, "engrave", team.id);
    // Placed after the Turn on below, so the reconcile it runs starts it.
    await seedOrder(shop, Date.now() + 60 * 60 * 1000, "engrave");

    const on = await agent.setWorkflowOn({ workflowId, on: true });
    if (on._tag !== "Ok") throw new Error(on._tag);
    strictEqual(on.created, 1);
    deepStrictEqual(appEvents, [{ idempotencyKey: countKey, value: 1 }]);
    const usage = await agent.getUsage();
    strictEqual(usage.pendingUsageEvents, 0);
  });

  it("resyncing an order sends the usage queue, even when the resync fails", async () => {
    const shop = "flush-resync.myshopify.com";
    await seedTeam(shop);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await openCycle(agent);
    // An event already queued, as a count whose flush failed leaves one.
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "insert into UsageEvent (idempotencyKey, eventHandle, orderId, value, occurredAt) values (?, ?, ?, 1, ?)",
        countKey,
        Domain.USAGE_METER_ORDER,
        ORDER_ID,
        Date.now(),
      );
    });

    // The shop has no offline session, so the fetch fails; the queue is
    // still sent.
    const resynced = await agent.resyncOrder({ orderId: ORDER_ID }).then(
      () => "ok",
      () => "failed",
    );
    strictEqual(resynced, "failed");
    deepStrictEqual(appEvents, [{ idempotencyKey: countKey, value: 1 }]);
    const usage = await agent.getUsage();
    strictEqual(usage.pendingUsageEvents, 0);
  });
});

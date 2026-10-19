import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../src/domain/platform.ts";
import { ORDERS_KEY } from "../../src/contract/shop-actor.ts";
import type { OrderNode } from "../../src/backend/order-sync.ts";
import { SEED_SHOP } from "../seed-shops.ts";
import { signWebhook } from "../shopify-webhook.ts";
import { dev, integ, openAs, storeByWebhook } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * Shopify's webhooks against the real Backend, D1 and actor: the `/webhooks/` branch checks the
 * HMAC over the bytes sent, `app/scopes_update` rewrites the seeded session's scope, and
 * `orders/*` fetches the order from the fake Shopify and stores it in the shop's actor.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("webhooks"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/**
 * POSTs `payload` to `path` on the Backend for `shop`, signed unless `signed` is false; the
 * status.
 */
const deliver = (
  backendUrl: string,
  path: string,
  topic: string,
  payload: unknown,
  signed = true,
  shop: ShopKey = SEED_SHOP,
) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const headers = yield* signWebhook(topic, shop, body);
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${backendUrl}${path}`).pipe(
        HttpClientRequest.setHeaders(
          signed ? headers : { ...headers, "x-shopify-hmac-sha256": "unsigned" },
        ),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    );
    return response.status;
  }).pipe(Effect.provide(FetchHttpClient.layer));

test(
  "a signed compliance webhook answers 200 and an unsigned one 401",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const payload = { shop_id: 1, shop_domain: SEED_SHOP };
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/compliance", "shop/redact", payload),
      200,
    );
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/compliance", "shop/redact", payload, false),
      401,
    );
  }),
);

test(
  "app/scopes_update updates the stored scope from the payload",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const status = yield* deliver(backendUrl, "/webhooks/app/scopes_update", "app/scopes_update", {
      current: ["read_orders", "read_products", "write_products"],
    });
    assert.strictEqual(status, 200);
    const session = yield* dev(backendUrl, (c) => c.GetShopSession({ shop: SEED_SHOP }));
    assert.strictEqual(session?.scope, "read_orders,read_products,write_products");
  }),
);

/** A shop `seed/test.sql` gives no `ShopSession`: uninstalled, or never installed. */
const UNINSTALLED_SHOP = Schema.decodeUnknownSync(ShopKey)("uninstalled-shop.myshopify.com");

const DAY = 24 * 60 * 60 * 1000;
const orderGid = (n: number) => `gid://shopify/Order/${String(n)}`;

/** An `orders/*` delivery for order `n` at `updatedAt`, trimmed as `include_fields` trims it. */
const orderPayload = (n: number, updatedAt: number) => ({
  id: n,
  admin_graphql_api_id: orderGid(n),
  updated_at: new Date(updatedAt).toISOString(),
});

/** Order `n` as Shopify's `OrderSync` answers it, at `updatedAt`, placed a day ago. */
const orderSyncBody = (n: number, updatedAt: number, name = `#${String(1000 + n)}`) => ({
  data: {
    order: {
      id: orderGid(n),
      legacyResourceId: String(n),
      name,
      processedAt: new Date(Date.now() - DAY).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      cancelledAt: null,
      displayFulfillmentStatus: "UNFULFILLED",
      fullyPaid: true,
      note: null,
      lineItems: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            id: `gid://shopify/LineItem/${String(n)}`,
            title: "Walnut cutting board",
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

/** Order `n` as Shopify answers it, at `updatedAt`, for {@link storeByWebhook}. */
const orderNode = (n: number, updatedAt: number): OrderNode => ({
  id: orderGid(n),
  legacyResourceId: String(n),
  name: `#${String(1000 + n)}`,
  processedAt: Date.now() - DAY,
  updatedAt,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
});

/** The fake's next GraphQL answers, with its call log cleared. */
const scriptGraphql = (backendUrl: string, bodies: ReadonlyArray<unknown>) =>
  integ(backendUrl, (c) =>
    c.ScriptShopify({ replies: bodies.map((body) => ({ route: "graphql", status: 200, body })) }),
  );

const shopifyRoutes = (backendUrl: string) =>
  integ(backendUrl, (c) => c.ShopifyCalls({})).pipe(
    Effect.map((calls) => calls.map(({ route }) => route)),
  );

/**
 * The actors with local storage on this file's stage: one SQLite file each, beside
 * `metadata.sqlite`, under the directory Alchemy names after the script and the class.
 */
const actorStores = (backendName: string) => {
  const directory = join(".alchemy", "local", `${backendName}-ShopActor`);
  try {
    return readdirSync(directory).filter(
      (file) => file.endsWith(".sqlite") && file !== "metadata.sqlite",
    );
  } catch {
    return [];
  }
};

/**
 * Runs first among the order cases, so the seeded shop's actor does not exist yet either: its
 * delivery is the control that proves a created actor shows up as a new file.
 */
test(
  "a signed orders/create for a shop with no ShopSession creates no actor storage",
  Effect.gen(function* () {
    const { backendUrl, backendName } = yield* stack;
    yield* scriptGraphql(backendUrl, [orderSyncBody(1, Date.now())]);
    const before = actorStores(backendName);
    const status = yield* deliver(
      backendUrl,
      "/webhooks/orders",
      "orders/create",
      orderPayload(1, Date.now()),
      true,
      UNINSTALLED_SHOP,
    );
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(actorStores(backendName), before);
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), []);

    yield* scriptGraphql(backendUrl, [orderSyncBody(1, Date.now())]);
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/orders", "orders/create", orderPayload(1, Date.now())),
      200,
    );
    assert.lengthOf(actorStores(backendName), before.length + 1);
  }),
);

test(
  "a signed orders/create stores the order Shopify answers for it, in one GraphQL call",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const updatedAt = Date.parse("2026-09-02T12:00:00Z");
    yield* scriptGraphql(backendUrl, [orderSyncBody(2, updatedAt)]);
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/orders", "orders/create", orderPayload(2, updatedAt)),
      200,
    );
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), ["graphql"]);
    const detail = yield* integ(backendUrl, (c) =>
      c.GetOrder({ shop: SEED_SHOP, orderId: orderGid(2) }),
    );
    assert.strictEqual(detail?.order.name, "#1002");
    assert.strictEqual(detail?.order.updatedAt, updatedAt);
    assert.deepStrictEqual(
      detail?.lineItems.map(({ productTags }) => productTags),
      [["engraved"]],
    );
  }),
);

/**
 * Deliveries are unordered and retries replay the original payload, so a payload no newer than
 * the stored row must not spend an Admin API call, and must not overwrite what is stored.
 */
test(
  "skips a delivery whose updated_at is not newer than the row",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const stored = Date.parse("2026-09-02T12:00:00Z");
    yield* storeByWebhook(backendUrl, SEED_SHOP, orderNode(3, stored), []);
    const before = yield* integ(backendUrl, (c) =>
      c.GetOrder({ shop: SEED_SHOP, orderId: orderGid(3) }),
    );
    yield* scriptGraphql(backendUrl, []);
    for (const updatedAt of [Date.parse("2026-09-02T11:00:00Z"), stored])
      assert.strictEqual(
        yield* deliver(backendUrl, "/webhooks/orders", "orders/paid", orderPayload(3, updatedAt)),
        200,
      );
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), []);
    const after = yield* integ(backendUrl, (c) =>
      c.GetOrder({ shop: SEED_SHOP, orderId: orderGid(3) }),
    );
    assert.strictEqual(after?.order.syncedAt, before?.order.syncedAt);
    assert.strictEqual(after?.order.updatedAt, stored);
  }),
);

/**
 * The edit payload reports what the edit changed, not the order's new state, so it carries
 * `order_edit.order_id` and no `updated_at`, which is exactly why it must always fetch.
 */
test(
  "an orders/edited delivery resolves the order from order_edit.order_id and always fetches",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const stored = Date.parse("2026-09-02T12:00:00Z");
    yield* storeByWebhook(backendUrl, SEED_SHOP, orderNode(4, stored), []);
    yield* scriptGraphql(backendUrl, [orderSyncBody(4, stored + 60_000, "#1004 edited")]);
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/orders", "orders/edited", {
        order_edit: { order_id: 4 },
      }),
      200,
    );
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), ["graphql"]);
    const detail = yield* integ(backendUrl, (c) =>
      c.GetOrder({ shop: SEED_SHOP, orderId: orderGid(4) }),
    );
    assert.strictEqual(detail?.order.name, "#1004 edited");
    assert.strictEqual(detail?.order.updatedAt, stored + 60_000);
    assert.lengthOf(detail?.lineItems ?? [], 1);
  }),
);

test(
  "an order Shopify no longer has answers 200 and stores nothing",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* scriptGraphql(backendUrl, [{ data: { order: null } }]);
    assert.strictEqual(
      yield* deliver(
        backendUrl,
        "/webhooks/orders",
        "orders/cancelled",
        orderPayload(5, Date.now()),
      ),
      200,
    );
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), ["graphql"]);
    assert.isNull(
      yield* integ(backendUrl, (c) => c.GetOrder({ shop: SEED_SHOP, orderId: orderGid(5) })),
    );
  }),
);

/**
 * An edit carries no version, so each delivery fetches and Shopify answers the same version
 * both times: the second write rewrites the row and moves nothing a screen reads, so it
 * publishes nothing. Legacy also compared the order's runs; runs are not ported.
 */
test(
  "a redelivered webhook rewrites the same version and changes nothing a screen shows",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const updatedAt = Date.parse("2026-09-02T12:00:00Z");
    const body = orderSyncBody(6, updatedAt);
    yield* scriptGraphql(backendUrl, [body, body]);
    const redeliver = deliver(backendUrl, "/webhooks/orders", "orders/edited", {
      order_edit: { order_id: 6 },
    });
    const read = integ(backendUrl, (c) => c.GetOrder({ shop: SEED_SHOP, orderId: orderGid(6) }));
    const [first, second] = yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* merchant.client.MerchantWhoAmI();
      assert.strictEqual(yield* redeliver, 200);
      const notice = yield* PubSub.take(merchant.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [ORDERS_KEY] });
      const first = yield* read;
      assert.strictEqual(yield* redeliver, 200);
      yield* Effect.sleep("500 millis");
      assert.strictEqual(yield* PubSub.remaining(merchant.received), 0, "no notice");
      return [first, yield* read] as const;
    }).pipe(Effect.scoped);
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), ["graphql", "graphql"]);
    assert.isNotNull(first);
    assert.isAbove(second?.order.syncedAt ?? 0, first?.order.syncedAt ?? Infinity);
    assert.deepStrictEqual(
      { ...second, order: { ...second?.order, syncedAt: 0 } },
      { ...first, order: { ...first?.order, syncedAt: 0 } },
    );
  }),
);

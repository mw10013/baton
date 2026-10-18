import { assert, describe, it } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ShopLimits } from "../../../src/domain/platform.ts";
import { orderSyncQuery, orderSyncVariables } from "../../../src/backend/order-sync.ts";
import { ABORT_UNINSTALLED } from "../../../src/backend/shop-actor/tag.ts";
import {
  ShopSessionRepository,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";
import { ReauthorizationRequired, Shopify } from "../../../src/backend/shopify.ts";
import type { ShopifyAdminError } from "../../../src/backend/shopify-admin.ts";
import { orderRef, OrdersWebhookPayload, Webhooks } from "../../../src/backend/webhooks.ts";
import { SEED_SHOP } from "../../seed-shops.ts";
import { signWebhook } from "../../shopify-webhook.ts";
import recorded from "./fixtures/order-sync-response.json";
import {
  ActorSqliteTest,
  type AdminCall,
  type OrderActorCalls,
  QuietLogs,
  testOrderActors,
  testOrderRepository,
  testShopify,
  testShopifyAdmin,
} from "./layers.ts";
import appToml from "../../../shopify.app.toml?raw";
import stagingToml from "../../../shopify.app.staging.toml?raw";

const session: ShopSessionRow = {
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_products",
  accessTokenExpiresAt: 1_900_000_000_000,
  accessToken: "shpat_secret_access",
  refreshToken: "shprt_secret_refresh",
  refreshTokenExpiresAt: 1_900_000_000_000,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};

/**
 * {@link Webhooks} over {@link testShopify} holding `rows`, which stays readable, and
 * {@link testOrderActors}, whose `syncOrderWebhook` runs the actor's `Orders` over a fresh
 * in-memory actor schema (readable through `testOrderRepository`) and {@link testShopifyAdmin}
 * answering `replies`, and whose destroy answers `stub`, all recording into `calls`.
 */
const layer = (
  rows: ReadonlyArray<ShopSessionRow> = [session],
  {
    calls = newCalls(),
    replies = [],
    stub = Effect.void,
  }: {
    calls?: Calls;
    replies?: Array<Effect.Effect<unknown, ShopifyAdminError>>;
    stub?: Effect.Effect<void>;
  } = {},
) =>
  Webhooks.layer.pipe(
    Layer.provideMerge(testOrderActors(calls, stub)),
    Layer.provideMerge(testShopifyAdmin(replies, calls.admin)),
    Layer.provideMerge(ActorSqliteTest),
    Layer.provideMerge(testShopify(rows)),
    Layer.provideMerge(QuietLogs),
  );

/** Every call a delivery can make on the actor or the Admin API. */
interface Calls extends OrderActorCalls {
  readonly admin: Array<AdminCall>;
}

const newCalls = (): Calls => ({ webhooks: [], notices: [], destroyed: [], admin: [] });

/** The order the shop's actor stored for `orderId`, or null. */
const storedOrder = (orderId: string) =>
  Effect.gen(function* () {
    return Option.getOrNull(yield* (yield* testOrderRepository).getOrder(orderId));
  });

/**
 * A delivery of `payload` for `topic` (the header's form), signed by {@link signWebhook}.
 * `headers` overrides or, with `null`, drops one of the signed headers.
 */
const webhookRequest = ({
  topic,
  payload = {},
  method = "POST",
  headers = {},
}: {
  topic: string;
  payload?: unknown;
  method?: string;
  headers?: Record<string, string | null>;
}) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const signed = new Headers(yield* signWebhook(topic, SEED_SHOP, body));
    for (const [name, value] of Object.entries(headers))
      if (value === null) signed.delete(name);
      else signed.set(name, value);
    return new Request("https://example.com/webhooks/compliance", {
      method,
      headers: signed,
      body: method === "POST" ? body : undefined,
    });
  });

/** The Backend's `/webhooks/` branch answering `request`. */
const serve = (request: Request) =>
  Effect.gen(function* () {
    const webhooks = yield* Webhooks;
    return yield* webhooks.serve(HttpServerRequest.fromWeb(request));
  });

const storedScope = Effect.gen(function* () {
  const shopSessions = yield* ShopSessionRepository;
  return Option.map(yield* shopSessions.find(SEED_SHOP), (row) => row.scope);
});

describe("Shopify.validateWebhook", () => {
  it.effect("returns shop, topic, and parsed payload for a valid webhook", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        payload: { id: 1, domain: SEED_SHOP },
      });
      const result = yield* shopify.validateWebhook(request);
      assert.strictEqual(result.shop, SEED_SHOP);
      assert.strictEqual(result.topic, "APP_UNINSTALLED");
      assert.deepStrictEqual(result.payload, { id: 1, domain: SEED_SHOP });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails with a 401 ResponseError for an invalid HMAC", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-hmac-sha256": "not-a-valid-hmac" },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WebhookRejected");
      assert.strictEqual(error.status, 401);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails with a 405 ResponseError for a non-POST request", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({ topic: "app/uninstalled", method: "GET" });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 405);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails with a 400 ResponseError when required webhook headers are missing", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-topic": null },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 400);
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each([
    "x-shopify-hmac-sha256",
    "x-shopify-shop-domain",
    "x-shopify-api-version",
    "x-shopify-webhook-id",
  ])("a delivery without %s is 400", (header) =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { [header]: null },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 400);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a signed shop domain that is not a ShopKey is 400", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-shop-domain": "example.com" },
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assert.strictEqual(error.status, 400);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("succeeds for a shop with no stored offline session", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/scopes_update",
        payload: { current: ["read_products"] },
      });
      const result = yield* shopify.validateWebhook(request);
      assert.strictEqual(result.topic, "APP_SCOPES_UPDATE");
      assert.isTrue(Option.isNone(yield* storedScope));
    }).pipe(Effect.provide(layer([]))),
  );
});

describe("handleWebhook", () => {
  it.effect("fails with the rejection ResponseError without running the handler", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        headers: { "x-shopify-hmac-sha256": "not-a-valid-hmac" },
      });
      const error = yield* webhooks
        .handle(request, () => Effect.die("handler must not run for a rejected webhook"))
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WebhookRejected");
      assert.strictEqual(error.status, 401);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("runs the handler with the validated result and returns its Response", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks;
      const request = yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } });
      const response = yield* webhooks.handle(request, (r) =>
        Effect.succeed(
          HttpServerResponse.empty({
            status: 202,
            headers: { "x-shop": r.shop, "x-topic": r.topic },
          }),
        ),
      );
      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.headers["x-shop"], SEED_SHOP);
      assert.strictEqual(response.headers["x-topic"], "APP_UNINSTALLED");
    }).pipe(Effect.provide(layer())),
  );

  it.effect("re-raises a handler failure so Shopify retries", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks;
      const request = yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } });
      const error = yield* webhooks
        .handle(request, () => Effect.fail(new Error("boom")))
        .pipe(Effect.flip);
      assert.instanceOf(error, Error);
      assert.strictEqual(error.message, "boom");
    }).pipe(Effect.provide(layer())),
  );
});

describe("Webhooks.serve", () => {
  it.effect.each([
    { topic: "customers/data_request", payload: { customer: { id: 1 }, data_request: { id: 1 } } },
    { topic: "customers/redact", payload: { customer: { id: 1 } } },
    { topic: "shop/redact", payload: { shop_id: 1, shop_domain: SEED_SHOP } },
  ])("$topic validates and answers 200", ({ topic, payload }) =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic, payload }));
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* storedScope, Option.some("read_products"));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("app/scopes_update updates the stored scope from the payload", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({
          topic: "app/scopes_update",
          payload: { current: ["read_products", "write_products"] },
        }),
      );
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* storedScope, Option.some("read_products,write_products"));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("app/scopes_update is a no-op when no session row exists", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({
          topic: "app/scopes_update",
          payload: { current: ["read_products"] },
        }),
      );
      assert.strictEqual(response.status, 200);
      assert.isTrue(Option.isNone(yield* storedScope));
    }).pipe(Effect.provide(layer([]))),
  );

  it.effect("an app/scopes_update payload without current answers 400 and writes nothing", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({ topic: "app/scopes_update", payload: { previous: [] } }),
      );
      assert.strictEqual(response.status, 400);
      assert.deepStrictEqual(yield* storedScope, Option.some("read_products"));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a validated topic Baton does not subscribe to answers 404", () =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic: "products/update" }));
      assert.strictEqual(response.status, 404);
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each<{ name: string; status: number; headers: Record<string, string | null> }>([
    { name: "a bad HMAC", status: 401, headers: { "x-shopify-hmac-sha256": "bad" } },
    { name: "a missing topic", status: 400, headers: { "x-shopify-topic": null } },
  ])("$name answers $status", ({ status, headers }) =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic: "shop/redact", headers }));
      assert.strictEqual(response.status, status);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a GET answers 405", () =>
    Effect.gen(function* () {
      const response = yield* serve(yield* webhookRequest({ topic: "shop/redact", method: "GET" }));
      assert.strictEqual(response.status, 405);
    }).pipe(Effect.provide(layer())),
  );
});

const decodeOrdersPayload = Schema.decodeUnknownSync(OrdersWebhookPayload);

const ORDER_GID = "gid://shopify/Order/6123456789012";

describe("orderRef", () => {
  it("takes the GID and updated_at of an order payload", () => {
    assert.deepStrictEqual(
      orderRef(
        decodeOrdersPayload({
          id: 6123456789012,
          admin_graphql_api_id: ORDER_GID,
          updated_at: "2026-10-15T09:30:45-04:00",
        }),
      ),
      { orderId: ORDER_GID, updatedAt: Date.parse("2026-10-15T13:30:45Z") },
    );
  });

  it("builds the GID from id when admin_graphql_api_id is missing", () => {
    assert.deepStrictEqual(
      orderRef(decodeOrdersPayload({ id: 1001, updated_at: "2026-09-02T12:00:00Z" })),
      { orderId: "gid://shopify/Order/1001", updatedAt: Date.parse("2026-09-02T12:00:00Z") },
    );
  });

  it.each<{ name: string; payload: Record<string, unknown> }>([
    { name: "a missing updated_at", payload: {} },
    { name: "a null updated_at", payload: { updated_at: null } },
    { name: "an updated_at that is not a timestamp", payload: { updated_at: "yesterday" } },
  ])("reads $name as null, which fetches", ({ payload }) => {
    assert.deepStrictEqual(
      orderRef(decodeOrdersPayload({ id: 1001, admin_graphql_api_id: ORDER_GID, ...payload })),
      { orderId: ORDER_GID, updatedAt: null },
    );
  });

  it("resolves an edit from order_edit.order_id with no version, so it always fetches", () => {
    assert.deepStrictEqual(orderRef(decodeOrdersPayload({ order_edit: { order_id: 1001 } })), {
      orderId: "gid://shopify/Order/1001",
      updatedAt: null,
    });
  });

  it("decodes a payload of neither shape as nothing", () => {
    assert.isTrue(
      Option.isNone(Schema.decodeUnknownOption(OrdersWebhookPayload)({ order: { id: 1 } })),
    );
  });
});

describe("orders webhooks", () => {
  const delivery = (topic: string, payload: unknown) =>
    Effect.gen(function* () {
      return yield* serve(yield* webhookRequest({ topic, payload }));
    });
  const paid = {
    id: 6123456789012,
    admin_graphql_api_id: ORDER_GID,
    updated_at: "2026-10-15T09:30:45Z",
  };

  it.effect.each(["orders/create", "orders/paid", "orders/cancelled", "orders/fulfilled"])(
    "%s fetches the order it names and stores it with its line items",
    (topic) => {
      const calls = newCalls();
      return Effect.gen(function* () {
        const response = yield* delivery(topic, paid);
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(
          calls.webhooks.map(({ key, orderId, updatedAt }) => ({ key, orderId, updatedAt })),
          [{ key: SEED_SHOP, orderId: ORDER_GID, updatedAt: Date.parse("2026-10-15T09:30:45Z") }],
        );
        assert.deepStrictEqual(calls.admin, [
          { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
        ]);
        const stored = yield* storedOrder(ORDER_GID);
        assert.strictEqual(stored?.order.id, ORDER_GID);
        assert.deepStrictEqual(
          stored?.lineItems.map(({ id }) => id),
          ["gid://shopify/LineItem/15234567890123", "gid://shopify/LineItem/15234567890124"],
        );
      }).pipe(
        Effect.provide(layer([session], { calls, replies: [Effect.succeed(recorded.data)] })),
      );
    },
  );

  /**
   * The topic decides nothing in the actor: the order stored is the one Shopify answered.
   * Legacy also asserted the order's run stayed open; runs are not ported.
   */
  it.effect(
    "a webhook's topic decides nothing: a cancelled topic on an open order stores it open",
    () => {
      const calls = newCalls();
      return Effect.gen(function* () {
        const response = yield* delivery("orders/cancelled", paid);
        assert.strictEqual(response.status, 200);
        const stored = yield* storedOrder(ORDER_GID);
        assert.strictEqual(stored?.order.cancelledAt, null);
        assert.strictEqual(stored?.order.fulfillmentStatus, "UNFULFILLED");
      }).pipe(
        Effect.provide(layer([session], { calls, replies: [Effect.succeed(recorded.data)] })),
      );
    },
  );

  it.effect("an orders/edited delivery fetches the order of order_edit.order_id", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const response = yield* delivery("orders/edited", {
        order_edit: { order_id: 6123456789012 },
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(calls.webhooks, [
        { key: SEED_SHOP, orderId: ORDER_GID, topic: "ORDERS_EDITED", updatedAt: null },
      ]);
      assert.lengthOf(calls.admin, 1);
      assert.isNotNull(yield* storedOrder(ORDER_GID));
    }).pipe(Effect.provide(layer([session], { calls, replies: [Effect.succeed(recorded.data)] })));
  });

  it.effect("a shop with no session answers 200 and makes no actor call", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const response = yield* delivery("orders/create", paid);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(calls, newCalls());
    }).pipe(Effect.provide(layer([], { calls })));
  });

  it.effect("a stale version answers 200 with no Admin call and nothing stored", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      assert.strictEqual((yield* delivery("orders/create", paid)).status, 200);
      const before = yield* storedOrder(ORDER_GID);
      calls.admin.length = 0;
      calls.notices.length = 0;
      const response = yield* delivery("orders/paid", paid);
      assert.strictEqual(response.status, 200);
      assert.lengthOf(calls.webhooks, 2);
      assert.deepStrictEqual(calls.admin, []);
      assert.deepStrictEqual(calls.notices, []);
      assert.deepStrictEqual(yield* storedOrder(ORDER_GID), before);
    }).pipe(Effect.provide(layer([session], { calls, replies: [Effect.succeed(recorded.data)] })));
  });

  it.effect("a refused version answers 200 with no Admin call and nothing stored", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let i = 1; i <= ShopLimits.maxOpenOrders; i++)
            yield* sql`
              insert into ShopOrder (id, legacyId, name, processedAt, updatedAt, cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
              values (${`gid://shopify/Order/open-${String(i)}`}, ${`open-${String(i)}`}, ${`#open-${String(i)}`}, 0, 0, null, 'UNFULFILLED', 1, null, 0)
            `;
        }),
      );
      const response = yield* delivery("orders/paid", paid);
      assert.strictEqual(response.status, 200);
      assert.lengthOf(calls.webhooks, 1);
      assert.deepStrictEqual(calls.admin, []);
      assert.isNull(yield* storedOrder(ORDER_GID));
    }).pipe(Effect.provide(layer([session], { calls })));
  });

  it.effect("an order Shopify no longer has answers 200 and stores nothing", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const response = yield* delivery("orders/cancelled", paid);
      assert.strictEqual(response.status, 200);
      assert.lengthOf(calls.admin, 1);
      assert.isNull(yield* storedOrder(ORDER_GID));
    }).pipe(
      Effect.provide(layer([session], { calls, replies: [Effect.succeed({ order: null })] })),
    );
  });

  it.effect("an EnsureShopSessionError answers non-2xx so Shopify retries", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const response = yield* delivery("orders/create", paid);
      assert.strictEqual(response.status, 500);
      assert.isNull(yield* storedOrder(ORDER_GID));
    }).pipe(
      Effect.provide(
        layer([session], {
          calls,
          replies: [
            Effect.fail(
              new ReauthorizationRequired({
                shop: SEED_SHOP,
                reason: "no-refresh-token",
                refreshTokenExpiresAt: null,
              }),
            ),
          ],
        }),
      ),
    );
  });

  it.effect("a payload of neither shape answers 400 and makes no actor call", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const response = yield* delivery("orders/create", { order: { id: 1 } });
      assert.strictEqual(response.status, 400);
      assert.deepStrictEqual(calls, newCalls());
    }).pipe(Effect.provide(layer([session], { calls })));
  });
});

/** Each `[[webhooks.subscriptions]]` block of `toml` whose `uri` is `uri`. */
const tomlBlocks = (toml: string, uri: string) =>
  toml.split("[[webhooks.subscriptions]]").filter((section) => section.includes(`uri = "${uri}"`));

const ORDER_INCLUDE_FIELDS = 'include_fields = ["id", "admin_graphql_api_id", "updated_at"]';

for (const [name, toml] of [
  ["shopify.app.toml", appToml],
  ["shopify.app.staging.toml", stagingToml],
] as const)
  describe(name, () => {
    /**
     * Baton reads orders and never writes them, so `read_orders` is the whole of its order
     * access. Read from the toml so widening it is a conscious edit here too: a scope Baton
     * cannot justify is a scope a merchant is asked to grant for nothing.
     */
    it("requests read_orders and read_products only", () => {
      const scopes = /scopes = "(?<scopes>[^"]*)"/u.exec(toml)?.groups?.scopes;
      assert.deepStrictEqual(scopes?.split(","), ["read_orders", "read_products"]);
    });

    /**
     * `orders/updated` is not subscribed: it fires on every save of the order, and every change
     * Baton acts on has its own topic. Read from the toml so re-adding one is a conscious edit
     * here too.
     */
    it("subscribes to create, paid, edited, cancelled, and fulfilled only", () => {
      const topics = tomlBlocks(toml, "/webhooks/orders").flatMap((block) =>
        [...block.matchAll(/"(?<topic>orders\/[a-z_]+)"/gu)].map((match) => match.groups?.topic),
      );
      assert.deepStrictEqual(
        topics.toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
        ["orders/cancelled", "orders/create", "orders/edited", "orders/fulfilled", "orders/paid"],
      );
    });

    /**
     * Shopify drops a delivery whose trimmed payload is identical to the last one, so the
     * trimmed topics must carry `updated_at`. `orders/edited` carries no `include_fields`: its
     * payload is the edit, which differs every time.
     */
    it("trims every orders topic but orders/edited to id, admin_graphql_api_id and updated_at", () => {
      const blocks = tomlBlocks(toml, "/webhooks/orders");
      const edited = blocks.filter((block) => block.includes('"orders/edited"'));
      const trimmed = blocks.filter((block) => !block.includes('"orders/edited"'));
      assert.lengthOf(edited, 1);
      assert.notInclude(edited[0] ?? "", "include_fields =");
      assert.isNotEmpty(trimmed);
      for (const block of trimmed) assert.include(block, ORDER_INCLUDE_FIELDS);
    });
  });

/**
 * The stub's rejection, as the integ suite observed it, carrying `message` as its cause's. Typed
 * as the stub types its methods, with no error, though it fails at runtime.
 */
const stubRejection = (message: string) =>
  Effect.fail(
    new Cloudflare.RpcCallError({
      method: "destroy",
      cause: Object.assign(new Error(message), { durableObjectReset: true }),
    }),
  ) as unknown as Effect.Effect<void>;

describe("app/uninstalled", () => {
  it.effect("deletes the session, then destroys the actor", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } }),
      );
      assert.strictEqual(response.status, 200);
      assert.isTrue(Option.isNone(yield* storedScope));
      assert.deepStrictEqual(calls.destroyed, [{ key: SEED_SHOP, hadSession: false }]);
    }).pipe(Effect.provide(layer([session], { calls })));
  });

  it.effect("a shop with no session still has its actor destroyed", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } }),
      );
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(calls.destroyed, [{ key: SEED_SHOP, hadSession: false }]);
    }).pipe(Effect.provide(layer([], { calls })));
  });

  it.effect("the abort's rejection of the stub call counts as destroyed", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } }),
      );
      assert.strictEqual(response.status, 200);
    }).pipe(Effect.provide(layer([session], { stub: stubRejection(ABORT_UNINSTALLED) }))),
  );

  it.effect.each<{ name: string; stub: Effect.Effect<void> }>([
    { name: "another stub rejection", stub: stubRejection("deleteAll timed out") },
    { name: "a defect with the abort's message", stub: Effect.die(new Error(ABORT_UNINSTALLED)) },
  ])("$name answers 500, the session already deleted", ({ stub }) =>
    Effect.gen(function* () {
      const response = yield* serve(
        yield* webhookRequest({ topic: "app/uninstalled", payload: { id: 1 } }),
      );
      assert.strictEqual(response.status, 500);
      assert.isTrue(Option.isNone(yield* storedScope));
    }).pipe(Effect.provide(layer([session], { stub }))),
  );
});

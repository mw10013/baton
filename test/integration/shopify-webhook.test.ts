import { SqliteClient } from "@effect/sql-sqlite-do";
import { describe, it } from "@effect/vitest";
import {
  assertInstanceOf,
  assertNone,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
} from "@effect/vitest/utils";
import * as ShopifyApi from "@shopify/shopify-api";
import { runInDurableObject } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { env as workerEnv } from "cloudflare:workers";
import { Effect, Layer, Option, Schedule, Schema } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { handleWebhook, ResponseError, Shopify } from "@/lib/Shopify";

// oxlint-disable-next-line import/no-unassigned-import -- `?raw` is a Vite asset import
import appToml from "../../shopify.app.toml?raw";
import { shopifyTestLayer } from "./shopify-test-layer";

const SECRET = "test_api_secret";
const SHOP = "test.myshopify.com";
const shop = Schema.decodeUnknownSync(Domain.Shop)(SHOP);
const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
  "gid://shopify/Shop/1",
);

const hmacBase64 = (secret: string, body: string) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    return btoa(String.fromCodePoint(...new Uint8Array(signature)));
  });

const webhookRequest = ({
  topic,
  payload = {},
  hmac,
  method = "POST",
  includeTopic = true,
  path = "/webhooks",
  webhookId = "wh-1",
}: {
  topic: string;
  payload?: unknown;
  hmac?: string;
  method?: string;
  includeTopic?: boolean;
  path?: string;
  webhookId?: string;
}) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const headers = new Headers({
      "content-type": "application/json",
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-API-Version": "2026-01",
      "X-Shopify-Webhook-Id": webhookId,
      "X-Shopify-Hmac-Sha256": hmac ?? (yield* hmacBase64(SECRET, body)),
    });
    if (includeTopic) headers.set("X-Shopify-Topic", topic);
    return new Request(`https://example.com${path}`, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
    });
  });

const fetchWebhook = (request: Request) =>
  Effect.promise(() => workerExports.default.fetch(request));

const makeSession = (
  overrides: Partial<ConstructorParameters<typeof ShopifyApi.Session>[0]> = {},
) =>
  new ShopifyApi.Session({
    id: "offline_test.myshopify.com",
    shop: SHOP,
    state: "",
    isOnline: false,
    accessToken: "shpat_current",
    scope: "read_products",
    ...overrides,
  });

describe("Shopify.validateWebhook", () => {
  it.effect("returns shop, topic, and parsed payload for a valid webhook", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        payload: { id: 1, domain: SHOP },
      });
      const result = yield* shopify.validateWebhook(request);
      strictEqual(result.shop, shop);
      strictEqual(result.topic, "APP_UNINSTALLED");
      deepStrictEqual(result.payload, { id: 1, domain: SHOP });
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("fails with a 401 ResponseError for an invalid HMAC", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        hmac: "not-a-valid-hmac",
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assertInstanceOf(error, ResponseError);
      strictEqual(error.response.status, 401);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("fails with a 405 ResponseError for a non-POST request", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        method: "GET",
      });
      const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
      assertInstanceOf(error, ResponseError);
      strictEqual(error.response.status, 405);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "fails with a 400 ResponseError when required webhook headers are missing",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const request = yield* webhookRequest({
          topic: "app/uninstalled",
          includeTopic: false,
        });
        const error = yield* shopify.validateWebhook(request).pipe(Effect.flip);
        assertInstanceOf(error, ResponseError);
        strictEqual(error.response.status, 400);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("succeeds for a shop with no stored offline session", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      yield* shopify.deleteShopSession(shop);
      const request = yield* webhookRequest({
        topic: "app/scopes_update",
        payload: { current: ["read_products"] },
      });
      const result = yield* shopify.validateWebhook(request);
      strictEqual(result.topic, "APP_SCOPES_UPDATE");
      assertNone(yield* shopify.loadShopSession(shop));
    }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

describe("webhook handler effects", () => {
  // The webhook also calls destroyShopAgent(result.shop), but Cloudflare's
  // runtime binding API does not expose a clean existence check for a named
  // Durable Object. Calling an agent method would reactivate/recreate it.
  it.effect("app/uninstalled deletes all sessions for the shop", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      yield* shopify.storeShopSession(makeSession(), shopGid);
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/app/uninstalled",
          topic: "app/uninstalled",
          payload: { id: 1 },
        }),
      );
      strictEqual(response.status, 200);
      assertNone(yield* shopify.loadShopSession(shop));
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "app/uninstalled is idempotent when sessions are already gone",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        yield* shopify.deleteShopSession(shop);
        const response = yield* fetchWebhook(
          yield* webhookRequest({
            path: "/webhooks/app/uninstalled",
            topic: "app/uninstalled",
          }),
        );
        strictEqual(response.status, 200);
        assertNone(yield* shopify.loadShopSession(shop));
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("app/scopes_update updates the stored scope from the payload", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      yield* shopify.storeShopSession(
        makeSession({ scope: "read_products" }),
        shopGid,
      );
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/app/scopes_update",
          topic: "app/scopes_update",
          payload: { current: ["read_products", "write_products"] },
        }),
      );
      strictEqual(response.status, 200);
      const record = Option.getOrThrow(yield* shopify.loadShopSession(shop));
      strictEqual(record.session.scope, "read_products,write_products");
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("app/scopes_update is a no-op when no session row exists", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      yield* shopify.deleteShopSession(shop);
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/app/scopes_update",
          topic: "app/scopes_update",
          payload: { current: ["read_products"] },
        }),
      );
      strictEqual(response.status, 200);
      assertNone(yield* shopify.loadShopSession(shop));
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("shop/redact validates", () =>
    Effect.gen(function* () {
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/compliance",
          topic: "shop/redact",
          payload: { shop_id: 1, shop_domain: SHOP },
        }),
      );
      strictEqual(response.status, 200);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("customers/data_request validates", () =>
    Effect.gen(function* () {
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/compliance",
          topic: "customers/data_request",
          payload: {
            customer: { id: 1, email: "customer@example.com" },
            data_request: { id: 1 },
          },
        }),
      );
      strictEqual(response.status, 200);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("customers/redact validates", () =>
    Effect.gen(function* () {
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/compliance",
          topic: "customers/redact",
          payload: { customer: { id: 1 } },
        }),
      );
      strictEqual(response.status, 200);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

describe("handleWebhook", () => {
  it.effect(
    "fails with the rejection ResponseError without running the handler",
    () =>
      Effect.gen(function* () {
        const request = yield* webhookRequest({
          topic: "app/uninstalled",
          hmac: "not-a-valid-hmac",
        });
        const error = yield* handleWebhook(() =>
          Effect.die("handler must not run for a rejected webhook"),
        ).pipe(Effect.provideService(CurrentRequest, request), Effect.flip);
        assertInstanceOf(error, ResponseError);
        strictEqual(error.response.status, 401);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "runs the handler with the validated result and returns its Response",
    () =>
      Effect.gen(function* () {
        const request = yield* webhookRequest({
          topic: "app/uninstalled",
          payload: { id: 1 },
        });
        const result = yield* handleWebhook((r) =>
          Effect.succeed(
            new Response(undefined, {
              status: 202,
              headers: { "x-shop": r.shop, "x-topic": r.topic },
            }),
          ),
        ).pipe(Effect.provideService(CurrentRequest, request));
        assertInstanceOf(result, Response);
        strictEqual(result.status, 202);
        strictEqual(result.headers.get("x-shop"), SHOP);
        strictEqual(result.headers.get("x-topic"), "APP_UNINSTALLED");
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("re-raises a handler failure so Shopify retries", () =>
    Effect.gen(function* () {
      const request = yield* webhookRequest({
        topic: "app/uninstalled",
        payload: { id: 1 },
      });
      const error = yield* handleWebhook(() =>
        Effect.fail(new Error("boom")),
      ).pipe(Effect.provideService(CurrentRequest, request), Effect.flip);
      assertInstanceOf(error, Error);
      strictEqual(error.message, "boom");
    }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

const ORDER_ID = "gid://shopify/Order/1001";

/**
 * Reaches into the very Durable Object the webhook route addresses, so a
 * delivery through the real worker fetch can be asserted against real stored
 * rows. The route's Shopify fetch is never exercised: each case here is one the
 * object answers before it would call the Admin API.
 */
const inShopAgent = <A, E>(
  program: Effect.Effect<A, E, OrderRepository>,
): Promise<A> =>
  runInDurableObject(workerEnv.SHOP_AGENT.getByName(SHOP), (_instance, state) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.provideMerge(
            OrderRepository.layer,
            SqliteClient.layer({ storage: state.storage }),
          ),
        ),
      ),
    ),
  );

const storedOrder = (updatedAt: number): Domain.ShopOrder => ({
  id: ORDER_ID,
  legacyId: "1001",
  name: "#1001",
  processedAt: updatedAt,
  updatedAt,
  cancelledAt: null,
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  syncedAt: updatedAt,
});

const seedOrder = (updatedAt: number) =>
  Effect.promise(() =>
    inShopAgent(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.upsertOrder({
          order: storedOrder(updatedAt),
          lineItems: [],
        });
      }),
    ),
  );

/**
 * Runs `self` with every console line written meanwhile pushed onto `lines`,
 * the object's log lines among them: it shares this isolate.
 */
const capturingConsole =
  (lines: string[]) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const methods = ["log", "info", "warn", "error", "debug"] as const;
        const originals = methods.map((method) => console[method]);
        for (const method of methods)
          console[method] = (...args: unknown[]) => {
            lines.push(
              args
                .map((arg) =>
                  typeof arg === "string" ? arg : JSON.stringify(arg),
                )
                .join(" "),
            );
          };
        return { methods, originals };
      }),
      () => self,
      ({ methods, originals }) =>
        Effect.sync(() => {
          for (const [index, method] of methods.entries())
            console[method] = originals[index] ?? console[method];
        }),
    );

const readOrder = () =>
  Effect.promise(() =>
    inShopAgent(
      OrderRepository.pipe(
        Effect.flatMap((repository) => repository.getOrder(ORDER_ID)),
      ),
    ),
  );

describe("uninstall", () => {
  it.live(
    "uninstall deletes the shop row, its members and teams, and destroys the object",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        yield* shopify.storeShopSession(makeSession(), shopGid);
        yield* Effect.promise(() =>
          workerEnv.D1.batch([
            workerEnv.D1.prepare(
              "insert into Member (id, shop, email, createdAt) values ('m-1', ?1, 'a@x.com', 0)",
            ).bind(SHOP),
            workerEnv.D1.prepare(
              "insert into Team (id, shop, name, createdAt) values ('t-1', ?1, 'Cut', 0)",
            ).bind(SHOP),
          ]),
        );
        yield* seedOrder(1);
        strictEqual(Option.isSome(yield* readOrder()), true);
        const response = yield* fetchWebhook(
          yield* webhookRequest({
            path: "/webhooks/app/uninstalled",
            topic: "app/uninstalled",
            webhookId: "wh-uninstall",
            payload: { id: 1 },
          }),
        );
        strictEqual(response.status, 200);
        assertNone(yield* shopify.loadShopSession(shop));
        const left = yield* Effect.promise(() =>
          workerEnv.D1.prepare(
            "select (select count(*) from Member where shop = ?1) + (select count(*) from Team where shop = ?1) as n",
          )
            .bind(SHOP)
            .first<{ n: number }>(),
        );
        strictEqual(left?.n, 0);
        // Addressing the object again starts a new one with empty storage:
        // the order written above went with the destroy. The first address
        // can still reach the aborted instance, which answers "destroyed".
        const after = yield* readOrder().pipe(
          Effect.catchDefect(() => Effect.fail("destroyed" as const)),
          Effect.retry({ times: 10, schedule: Schedule.spaced("20 millis") }),
        );
        assertNone(after);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

const orderWebhookRequest = ({
  topic,
  updatedAt,
  webhookId,
}: {
  topic: string;
  updatedAt?: string;
  webhookId?: string;
}) =>
  webhookRequest({
    path: "/webhooks/orders",
    topic,
    webhookId,
    payload: {
      id: 1001,
      admin_graphql_api_id: ORDER_ID,
      ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    },
  });

const tomlBlocks = (uri: string) =>
  appToml
    .split("[[webhooks.subscriptions]]")
    .filter((section) => section.includes(`uri = "${uri}"`));

describe("orders webhooks", () => {
  /**
   * Baton reads orders and never writes them, so `read_orders` is the whole of
   * its order access. Read from the toml so widening it is a conscious edit
   * here too — a scope Baton cannot justify is a scope a merchant is asked to
   * grant for nothing.
   */
  it("requests read_orders and read_products only", () => {
    const scopes = /scopes = "(?<scopes>[^"]*)"/u.exec(appToml)?.groups?.scopes;
    deepStrictEqual(scopes?.split(","), ["read_orders", "read_products"]);
  });

  /**
   * `orders/updated` is not subscribed: it fires on every save of the order,
   * and every change Baton acts on has its own topic. Read from the toml so
   * re-adding one is a conscious edit here too.
   */
  it("subscribes to create, paid, edited, cancelled, and fulfilled only", () => {
    const topics = tomlBlocks("/webhooks/orders").flatMap((block) =>
      [...block.matchAll(/"(?<topic>orders\/[a-z_]+)"/gu)].map(
        (match) => match.groups?.topic,
      ),
    );
    deepStrictEqual(
      topics.toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
      [
        "orders/cancelled",
        "orders/create",
        "orders/edited",
        "orders/fulfilled",
        "orders/paid",
      ],
    );
  });

  /**
   * Deliveries are unordered and retries replay the original payload, so a
   * payload no newer than the stored row must not spend an Admin API call — and
   * must not overwrite what is stored.
   */
  it.effect("skips a delivery whose updated_at is not newer than the row", () =>
    Effect.gen(function* () {
      yield* seedOrder(Date.parse("2026-09-02T12:00:00Z"));
      const response = yield* fetchWebhook(
        yield* orderWebhookRequest({
          topic: "orders/paid",
          updatedAt: "2026-09-02T11:00:00Z",
          webhookId: "wh-stale",
        }),
      );
      strictEqual(response.status, 200);
      const { order } = Option.getOrThrow(yield* readOrder());
      strictEqual(order.syncedAt, Date.parse("2026-09-02T12:00:00Z"));
      strictEqual(order.updatedAt, Date.parse("2026-09-02T12:00:00Z"));
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  /**
   * The edit payload reports what the edit changed, not the order's new state,
   * so it carries `order_edit.order_id` and no `updated_at` — which is exactly
   * why it must always fetch. The Admin API is not stubbed in this suite, so
   * the fetch fails and the delivery answers non-200; what proves the route
   * resolved the GID and the object went to fetch is the object's own
   * `status=fetch` line naming that order, captured from the console this
   * isolate shares with it. A payload that failed to decode answers the same
   * 500 and logs no such line.
   *
   * This test prints one "uncaught exception; source = Uncaught (in promise)"
   * line (`OfflineSessionNotFoundError`). It is not a failure: the route
   * handles the object's rejection and answers 500, as asserted, but workerd
   * prints a rejection that crosses its RPC boundary (the route's stub call)
   * even when the caller handles it. The call has to be the stub, since the
   * route under test is what makes it.
   */
  it.effect(
    "an orders/edited delivery resolves the order from order_edit.order_id and always fetches",
    () =>
      Effect.gen(function* () {
        yield* seedOrder(Date.parse("2026-09-02T12:00:00Z"));
        const lines: string[] = [];
        const response = yield* fetchWebhook(
          yield* webhookRequest({
            path: "/webhooks/orders",
            topic: "orders/edited",
            webhookId: "wh-edited",
            payload: { order_edit: { order_id: 1001 } },
          }),
        ).pipe(capturingConsole(lines));
        notDeepStrictEqual(response.status, 200);
        strictEqual(
          lines.some(
            (line) =>
              line.includes("ShopAgent.syncOrderWebhook") &&
              line.includes(`orderId=${ORDER_ID}`) &&
              line.includes("status=fetch"),
          ),
          true,
          lines.join("\n"),
        );
      }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

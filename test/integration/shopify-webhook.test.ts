import { describe, it } from "@effect/vitest";
import {
  assertInstanceOf,
  assertNone,
  deepStrictEqual,
  strictEqual,
} from "@effect/vitest/utils";
import * as ShopifyApi from "@shopify/shopify-api";
import { exports as workerExports } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";
import { handleWebhook, ResponseError, Shopify } from "@/lib/Shopify";

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
}: {
  topic: string;
  payload?: unknown;
  hmac?: string;
  method?: string;
  includeTopic?: boolean;
  path?: string;
}) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const headers = new Headers({
      "content-type": "application/json",
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-API-Version": "2026-01",
      "X-Shopify-Webhook-Id": "wh-1",
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
      yield* shopify.deleteSessionByShop(shop);
      const request = yield* webhookRequest({
        topic: "app/scopes_update",
        payload: { current: ["read_products"] },
      });
      const result = yield* shopify.validateWebhook(request);
      strictEqual(result.topic, "APP_SCOPES_UPDATE");
      assertNone(yield* shopify.loadSessionByShop(shop));
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
      yield* shopify.storeSession(makeSession(), shopGid);
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/app/uninstalled",
          topic: "app/uninstalled",
          payload: { id: 1 },
        }),
      );
      strictEqual(response.status, 200);
      assertNone(yield* shopify.loadSessionByShop(shop));
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "app/uninstalled is idempotent when sessions are already gone",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        yield* shopify.deleteSessionByShop(shop);
        const response = yield* fetchWebhook(
          yield* webhookRequest({
            path: "/webhooks/app/uninstalled",
            topic: "app/uninstalled",
          }),
        );
        strictEqual(response.status, 200);
        assertNone(yield* shopify.loadSessionByShop(shop));
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("app/scopes_update updates the stored scope from the payload", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      yield* shopify.storeSession(
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
      const record = Option.getOrThrow(yield* shopify.loadSessionByShop(shop));
      strictEqual(record.session.scope, "read_products,write_products");
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect("app/scopes_update is a no-op when no session row exists", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      yield* shopify.deleteSessionByShop(shop);
      const response = yield* fetchWebhook(
        yield* webhookRequest({
          path: "/webhooks/app/scopes_update",
          topic: "app/scopes_update",
          payload: { current: ["read_products"] },
        }),
      );
      strictEqual(response.status, 200);
      assertNone(yield* shopify.loadSessionByShop(shop));
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

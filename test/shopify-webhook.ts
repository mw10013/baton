import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../src/domain/platform.ts";
import { SHOPIFY_API_SECRET_FAKE } from "../src/backend/shopify.ts";

const encodeBase64 = Schema.encodeSync(Schema.Uint8ArrayFromBase64);
const encoder = new TextEncoder();

/**
 * The headers Shopify sends with a webhook delivery of `body`: the five the Shopify library
 * requires (HMAC, topic, shop domain, API version, webhook id) and `content-type`. The HMAC is
 * Shopify's, base64 HMAC-SHA256 of the exact body under the fake app's secret
 * ({@link SHOPIFY_API_SECRET_FAKE}), which every stage without Shopify CLI binds; a test that
 * proves a refusal drops or overwrites a header. `topic` is the header's form, `app/uninstalled`.
 */
export const signWebhook = Effect.fn("signWebhook")(function* (
  topic: string,
  shop: ShopKey,
  body: string,
) {
  const signature = yield* Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SHOPIFY_API_SECRET_FAKE),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return crypto.subtle.sign("HMAC", key, encoder.encode(body));
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-shopify-hmac-sha256": encodeBase64(new Uint8Array(signature)),
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": shop,
    "x-shopify-api-version": "2026-10",
    "x-shopify-webhook-id": crypto.randomUUID(),
  };
  return headers;
});

/**
 * POSTs `payload` to `url` as Shopify delivers `topic` for `shop`, signed by {@link signWebhook}
 * unless `signed` is false; the response's status.
 */
export const deliverWebhook = Effect.fn("deliverWebhook")(function* (
  url: string,
  topic: string,
  shop: ShopKey,
  payload: unknown,
  signed = true,
) {
  const body = JSON.stringify(payload);
  const headers = yield* signWebhook(topic, shop, body);
  const response = yield* HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(
        signed ? headers : { ...headers, "x-shopify-hmac-sha256": "unsigned" },
      ),
      HttpClientRequest.bodyText(body, "application/json"),
    ),
  );
  return response.status;
}, Effect.provide(FetchHttpClient.layer));

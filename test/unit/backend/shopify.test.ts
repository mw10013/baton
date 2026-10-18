import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { SEED_SHOP } from "../../seed-shops.ts";
import { ShopSessionRepository } from "../../../src/backend/shop-session-repository.ts";
import { Shopify } from "../../../src/backend/shopify.ts";
import { mintSessionToken } from "../../shopify-session-token.ts";
import { TEST_SHOPIFY_APP } from "./layers.ts";

/** The app under test: a fake key and secret; no `ShopSession` row, since nothing exchanges. */
const appWith = (options: { apiKey: string; apiSecret: string }) =>
  Shopify.layerWith({
    apiKey: options.apiKey,
    apiSecret: Redacted.make(options.apiSecret),
    appUrl: "http://localhost",
  }).pipe(Layer.provide(ShopSessionRepository.layerTest([])));

const layer = appWith(TEST_SHOPIFY_APP);

/** A token signed by an app with another key or secret. */
const signedBy = (options: { apiKey: string; apiSecret: string }, expiresIn?: number) =>
  mintSessionToken({ shop: SEED_SHOP, expiresIn, ...options });

describe("Shopify session tokens", () => {
  it.effect("a signed token decodes to its shop", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const token = yield* mintSessionToken({ shop: SEED_SHOP });
      const decoded = yield* shopify.decodeSessionToken(token);
      assert.strictEqual(new URL(decoded.dest).hostname, SEED_SHOP);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    { name: "a wrong aud", token: signedBy({ ...TEST_SHOPIFY_APP, apiKey: "other-key" }) },
    {
      name: "a wrong secret",
      token: signedBy({ ...TEST_SHOPIFY_APP, apiSecret: "other-secret" }),
    },
    {
      name: "an expired token",
      token: signedBy(TEST_SHOPIFY_APP, -10),
    },
    { name: "a malformed token", token: Effect.succeed("not.a-token") },
  ])("$name fails InvalidSessionToken", ({ token }) =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const error = yield* shopify.decodeSessionToken(yield* token).pipe(Effect.flip);
      assert.strictEqual(error._tag, "InvalidSessionToken");
    }).pipe(Effect.provide(layer)),
  );
});

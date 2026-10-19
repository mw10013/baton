import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../src/domain/platform.ts";
import { SHOPIFY_API_KEY, SHOPIFY_API_SECRET_FAKE } from "../src/backend/shopify.ts";

/** A JSON object as one base64url JWT segment. */
const jsonSegment = <S extends Schema.Constraint>(schema: S) =>
  Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(schema)));

const encodeHeader = Schema.encodeSync(
  jsonSegment(Schema.Struct({ alg: Schema.Literal("HS256"), typ: Schema.String })),
);

/** The claims Shopify puts in a session token. Times are UNIX seconds. */
const encodePayload = Schema.encodeSync(
  jsonSegment(
    Schema.Struct({
      iss: Schema.String,
      dest: Schema.String,
      aud: Schema.String,
      sub: Schema.String,
      exp: Schema.Number,
      nbf: Schema.Number,
      iat: Schema.Number,
      jti: Schema.String,
      sid: Schema.String,
    }),
  ),
);
const encodeSignature = Schema.encodeSync(Schema.Uint8ArrayFromBase64Url);

const encoder = new TextEncoder();

/**
 * A merchant's Shopify session token for `shop`, signed as Shopify signs one: HS256 under the
 * app's secret, with the app's key as `aud`. The app is the fake one every stage without Shopify
 * CLI binds ({@link SHOPIFY_API_KEY}, {@link SHOPIFY_API_SECRET_FAKE}); a test that proves a
 * refusal passes another key or secret. `expiresIn` defaults to a day; a negative one makes a
 * token that has already expired.
 */
export const mintSessionToken = Effect.fn("mintSessionToken")(function* (input: {
  readonly shop: ShopKey;
  readonly expiresIn?: number | undefined;
  readonly apiKey?: string | undefined;
  readonly apiSecret?: string | undefined;
}) {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${encodeHeader({ alg: "HS256", typ: "JWT" })}.${encodePayload({
    iss: `https://${input.shop}/admin`,
    dest: `https://${input.shop}`,
    aud: input.apiKey ?? SHOPIFY_API_KEY,
    sub: "1",
    exp: now + (input.expiresIn ?? 24 * 60 * 60),
    nbf: now,
    iat: now,
    jti: crypto.randomUUID(),
    sid: crypto.randomUUID(),
  })}`;
  const signature = yield* Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(input.apiSecret ?? SHOPIFY_API_SECRET_FAKE),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return crypto.subtle.sign("HMAC", key, encoder.encode(signed));
  });
  return `${signed}.${encodeSignature(new Uint8Array(signature))}`;
});

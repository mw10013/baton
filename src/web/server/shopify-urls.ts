/**
 * The embedded App Home's redirects and page destinations, as pure functions over the request's
 * search, so the route guards and the auth routes share them and unit tests can reach them.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ShopKey } from "../../domain/platform.ts";

/**
 * Base64 with its padding optional: Shopify's `host` param usually arrives without it, and
 * `Schema.StringFromBase64` requires it.
 */
const UnpaddedBase64 = Schema.String.pipe(
  Schema.decodeTo(
    Schema.StringFromBase64,
    SchemaTransformation.transform({
      decode: (text) => text.padEnd(Math.ceil(text.length / 4) * 4, "="),
      encode: (text) => text,
    }),
  ),
);

/**
 * Shopify's `host` search param: base64 of the Shopify admin the app is embedded in,
 * `admin.shopify.com/store/<store>`, or the legacy `<shop>.myshopify.com/admin`.
 */
const AdminHost = UnpaddedBase64.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isPattern(
        /^(?:admin\.shopify\.com\/store\/[a-zA-Z0-9][a-zA-Z0-9_-]*|[a-z0-9][a-z0-9-]*\.myshopify\.com\/admin)$/u,
      ),
    ),
  ),
);
const decodeAdminHost = Schema.decodeUnknownOption(AdminHost);

/**
 * The app inside the Shopify admin, `https://<admin>/apps/<apiKey>`, where `host` names the Shopify admin (the
 * library's `auth.getEmbeddedAppUrl` builds the same). None when `host` is not an admin host.
 */
export const embeddedAppUrl = (host: string, apiKey: string): Option.Option<string> =>
  Option.map(decodeAdminHost(host), (admin) => `https://${admin}/apps/${apiKey}`);

/**
 * The session-token bounce for a document:
 * `/auth/session-token` with the request's search minus `id_token`, plus `shopify-reload`, the
 * page to reload with a fresh token. App Bridge on the bounce page reads `shopify-reload` and
 * loads it with a new `id_token`. `appUrl` is the app's public URL from the binding, because
 * behind the dev proxies the request's own URL is not the one the Shopify admin loaded.
 */
export const sessionTokenBounce = (appUrl: string, path: string, search: string): string => {
  const params = new URLSearchParams(search);
  params.delete("id_token");
  params.set("shopify-reload", `${appUrl}${path}?${params.toString()}`);
  return `/auth/session-token?${params.toString()}`;
};

/** Shopify Admin's App Pricing page: Baton's billing leg, the one off-origin destination. */
const PricingPlansPath = Schema.String.check(
  Schema.isPattern(
    /^\/store\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/charges\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/pricing_plans$/u,
  ),
);
const isPricingPlansPath = Schema.is(PricingPlansPath);

/**
 * Where `/auth/exit-iframe` may send the top window: a URL on the app's own origin, or Shopify
 * Admin's App Pricing page with no search or hash. Credentials are refused, so the rendered URL
 * cannot disguise another authority. Relative candidates resolve against `appUrl`.
 */
const ExitIframeDestination = (appUrl: string) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.URL,
      SchemaTransformation.transformEffect({
        decode: (candidate, options) =>
          URL.canParse(candidate, appUrl)
            ? Effect.succeed(new URL(candidate, appUrl))
            : Effect.fail(new SchemaIssue.InvalidValue({ expected: "a URL" }, candidate, options)),
        encode: (url) => Effect.succeed(url.href),
      }),
    ),
    Schema.check(
      Schema.makeFilter(
        (url: URL) =>
          url.username === "" &&
          url.password === "" &&
          (url.origin === new URL(appUrl).origin ||
            (url.origin === "https://admin.shopify.com" &&
              isPricingPlansPath(url.pathname) &&
              url.search === "" &&
              url.hash === "")),
        { expected: "the app's origin or Shopify Admin's pricing plans page" },
      ),
    ),
  );

/** See {@link ExitIframeDestination}. */
export const exitIframeDestination = (appUrl: string, candidate: string): Option.Option<URL> =>
  Schema.decodeUnknownOption(ExitIframeDestination(appUrl))(candidate);

const decodeShop = Schema.decodeUnknownOption(ShopKey);

/**
 * The CSP that lets the Shopify admin frame a page: `frame-ancestors`, the shop's own
 * Shopify admin and the Shopify admin hosts. None unless `shop` is a {@link ShopKey}, so a page
 * without one cannot be framed by the Shopify admin.
 */
export const frameAncestors = (shop: unknown): Option.Option<string> =>
  Option.map(
    decodeShop(shop),
    (key) =>
      `frame-ancestors https://${key} https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;`,
  );

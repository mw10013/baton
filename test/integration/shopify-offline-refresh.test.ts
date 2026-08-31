import { describe, it } from "@effect/vitest";
import {
  assertInstanceOf,
  assertTrue,
  strictEqual,
} from "@effect/vitest/utils";
import * as ShopifyApi from "@shopify/shopify-api";
import {
  abstractFetch,
  setAbstractFetchFunc,
} from "@shopify/shopify-api/runtime";
import { Effect, Option, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";
import { RefreshTokenExpiredError, Shopify, ShopifyError } from "@/lib/Shopify";

import { shopifyTestLayer } from "./shopify-test-layer";

const REFRESH_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

const OAUTH_PATH = "/admin/oauth/access_token";

const accessTokenBody = (over?: Record<string, unknown>) => ({
  access_token: "shpat_new",
  expires_in: 3600,
  refresh_token: "shprt_new",
  refresh_token_expires_in: 7_776_000,
  scope: "read_products",
  ...over,
});

const jsonResponse = (status: number, body: unknown) =>
  Response.json(body, { status });

const stubRefreshGrant = (
  reply: (attempt: number, refreshToken: string) => Response,
) => {
  const original = abstractFetch;
  const refreshTokens: string[] = [];
  let attempt = 0;
  setAbstractFetchFunc(((url: string, options?: RequestInit) => {
    if (!url.endsWith(OAUTH_PATH))
      throw new Error(`unexpected fetch to ${url}`);
    const body = typeof options?.body === "string" ? options.body : "{}";
    const parsed = JSON.parse(body) as { readonly refresh_token: string };
    refreshTokens.push(parsed.refresh_token);
    return Promise.resolve(reply(attempt++, parsed.refresh_token));
  }) as typeof abstractFetch);
  return {
    refreshTokens,
    restore: Effect.sync(() => {
      setAbstractFetchFunc(original);
    }),
  };
};

const shop = Schema.decodeUnknownSync(Domain.Shop)("test.myshopify.com");
const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
  "gid://shopify/Shop/1",
);

const makeSession = (
  overrides: Partial<ConstructorParameters<typeof ShopifyApi.Session>[0]>,
) =>
  new ShopifyApi.Session({
    id: "offline_test.myshopify.com",
    shop: "test.myshopify.com",
    state: "",
    isOnline: false,
    accessToken: "shpat_current",
    scope: "read_products",
    ...overrides,
  });

describe("Shopify.storeShopSession", () => {
  it.effect("rejects invalid expiry dates", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const error = yield* Effect.flip(
        shopify.storeShopSession(
          makeSession({ expires: new Date(NaN) }),
          shopGid,
        ),
      );
      assertInstanceOf(error, ShopifyError);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

describe("Shopify.refreshShopSessionIfExpired", () => {
  it.effect(
    "(a) returns the session unchanged when the access token is still valid",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const session = makeSession({
          expires: new Date(Date.now() + 60 * 60 * 1000),
          refreshToken: "shprt_current",
          refreshTokenExpires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        });
        const result = yield* shopify.refreshShopSessionIfExpired(session);
        strictEqual(result, session);
        strictEqual(result.accessToken, "shpat_current");
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "(c) fails with RefreshTokenExpiredError when the refresh token is already expired",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const session = makeSession({
          expires: new Date(0),
          refreshToken: "shprt_current",
          refreshTokenExpires: new Date(0),
        });
        const error = yield* Effect.flip(
          shopify.refreshShopSessionIfExpired(session),
        );
        assertInstanceOf(error, RefreshTokenExpiredError);
        strictEqual(error.shop, shop);
        strictEqual(error.refreshTokenExpiresAt, 0);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "(c) crosses into RefreshTokenExpiredError once the clock passes the refresh-token expiry",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const refreshTokenExpiresAt = 10 * 60 * 1000;
        const session = makeSession({
          expires: new Date(0),
          refreshToken: "shprt_current",
          refreshTokenExpires: new Date(refreshTokenExpiresAt),
        });
        yield* TestClock.adjust(
          refreshTokenExpiresAt - REFRESH_TOKEN_EXPIRY_BUFFER_MS,
        );
        const error = yield* Effect.flip(
          shopify.refreshShopSessionIfExpired(session),
        );
        assertInstanceOf(error, RefreshTokenExpiredError);
        strictEqual(error.refreshTokenExpiresAt, refreshTokenExpiresAt);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "recovers a refresh race loser by reloading the winner session",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const winner = makeSession({
          accessToken: "shpat_winner",
          expires: new Date(Date.now() + 60 * 60 * 1000),
          refreshToken: "shprt_winner",
          refreshTokenExpires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        });
        yield* shopify.storeShopSession(winner, shopGid);
        const result = yield* shopify.recoverRefreshRace(shop, "shprt_loser");
        strictEqual(result.accessToken, "shpat_winner");
        strictEqual(result.refreshToken, "shprt_winner");
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.live(
    "fails with RefreshTokenExpiredError when no winner appears after recovery retries",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        yield* shopify.storeShopSession(
          makeSession({
            expires: new Date(0),
            refreshToken: "shprt_loser",
            refreshTokenExpires: new Date(
              Date.now() + 90 * 24 * 60 * 60 * 1000,
            ),
          }),
          shopGid,
        );
        const error = yield* Effect.flip(
          shopify.recoverRefreshRace(shop, "shprt_loser"),
        );
        assertInstanceOf(error, RefreshTokenExpiredError);
        strictEqual(error.shop, shop);
        strictEqual(error.refreshTokenExpiresAt, null);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.effect(
    "fails with ShopifyError when no offline session exists after a rejected refresh token",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const sessionlessShop = Schema.decodeUnknownSync(Domain.Shop)(
          "sessionless.myshopify.com",
        );
        const error = yield* Effect.flip(
          shopify.recoverRefreshRace(sessionlessShop, "shprt_loser"),
        );
        assertInstanceOf(error, ShopifyError);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

describe("Repository.updateShopSessionTokens", () => {
  it.effect("rotates token columns and preserves immutable shop identity", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const repository = yield* Repository;
      yield* shopify.storeShopSession(
        makeSession({
          accessToken: "shpat_old",
          refreshToken: "shprt_old",
          expires: new Date(1000),
          refreshTokenExpires: new Date(2000),
          scope: "read_products",
        }),
        shopGid,
      );
      yield* repository.updateShopSessionTokens({
        shop,
        accessToken: "shpat_new",
        accessTokenExpiresAt: 3000,
        refreshToken: "shprt_new",
        refreshTokenExpiresAt: 4000,
      });
      const record = Option.getOrThrow(yield* shopify.loadShopSession(shop));
      strictEqual(record.session.accessToken, "shpat_new");
      strictEqual(record.session.refreshToken, "shprt_new");
      strictEqual(record.session.expires?.getTime(), 3000);
      strictEqual(record.session.refreshTokenExpires?.getTime(), 4000);
      strictEqual(record.shopGid, shopGid);
      strictEqual(record.session.shop, "test.myshopify.com");
      strictEqual(record.session.scope, "read_products");
    }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

describe("Shopify.refreshShopSession", () => {
  it.live("rotates and persists tokens on a successful grant", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const stub = stubRefreshGrant(() => jsonResponse(200, accessTokenBody()));
      yield* shopify.storeShopSession(
        makeSession({
          accessToken: "shpat_old",
          refreshToken: "shprt_old",
          expires: new Date(1000),
          refreshTokenExpires: new Date(2000),
        }),
        shopGid,
      );
      const session = yield* shopify
        .refreshShopSession(shop, "shprt_old")
        .pipe(Effect.ensuring(stub.restore));
      strictEqual(session.accessToken, "shpat_new");
      strictEqual(stub.refreshTokens[0], "shprt_old");
      const record = Option.getOrThrow(yield* shopify.loadShopSession(shop));
      strictEqual(record.session.accessToken, "shpat_new");
      strictEqual(record.session.refreshToken, "shprt_new");
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.live(
    "routes a 401 invalid_request rejection to RefreshTokenRejectedError",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const stub = stubRefreshGrant(() =>
          jsonResponse(401, {
            error: "invalid_request",
            error_description: "This request requires an active refresh_token",
          }),
        );
        const error = yield* Effect.flip(
          shopify.refreshShopSession(shop, "shprt_dead"),
        ).pipe(Effect.ensuring(stub.restore));
        assertTrue(Predicate.isTagged(error, "RefreshTokenRejectedError"));
        strictEqual(stub.refreshTokens.length, 1);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.live(
    "routes a 400 invalid_subject_token rejection to RefreshTokenRejectedError",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const stub = stubRefreshGrant(() =>
          jsonResponse(400, { error: "invalid_subject_token" }),
        );
        const error = yield* Effect.flip(
          shopify.refreshShopSession(shop, "shprt_dead"),
        ).pipe(Effect.ensuring(stub.restore));
        assertTrue(Predicate.isTagged(error, "RefreshTokenRejectedError"));
      }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.live("retries a 429 with the same refresh token, then succeeds", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const stub = stubRefreshGrant((attempt) =>
        attempt === 0
          ? jsonResponse(429, { errors: "throttled" })
          : jsonResponse(200, accessTokenBody()),
      );
      const session = yield* shopify
        .refreshShopSession(shop, "shprt_current")
        .pipe(Effect.ensuring(stub.restore));
      strictEqual(session.accessToken, "shpat_new");
      strictEqual(stub.refreshTokens.length, 2);
      strictEqual(stub.refreshTokens[0], "shprt_current");
      strictEqual(stub.refreshTokens[1], "shprt_current");
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.live("retries a 5xx with the same refresh token, then succeeds", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const stub = stubRefreshGrant((attempt) =>
        attempt === 0
          ? jsonResponse(503, { errors: "unavailable" })
          : jsonResponse(200, accessTokenBody()),
      );
      const session = yield* shopify
        .refreshShopSession(shop, "shprt_current")
        .pipe(Effect.ensuring(stub.restore));
      strictEqual(session.accessToken, "shpat_new");
      strictEqual(stub.refreshTokens.length, 2);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.live("never treats an exhausted 429 as a rejection", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const stub = stubRefreshGrant(() =>
        jsonResponse(429, { errors: "throttled" }),
      );
      const error = yield* Effect.flip(
        shopify.refreshShopSession(shop, "shprt_current"),
      ).pipe(Effect.ensuring(stub.restore));
      assertInstanceOf(error, ShopifyError);
    }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

describe("Shopify.refreshShopSessionIfExpired rejection recovery", () => {
  const expiredLoser = () =>
    makeSession({
      accessToken: "shpat_expired",
      expires: new Date(Date.now() - 60 * 1000),
      refreshToken: "shprt_loser",
      refreshTokenExpires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });

  it.live("adopts the winner session when a refresh race was lost", () =>
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      yield* shopify.storeShopSession(
        makeSession({
          accessToken: "shpat_winner",
          expires: new Date(Date.now() + 60 * 60 * 1000),
          refreshToken: "shprt_winner",
          refreshTokenExpires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        }),
        shopGid,
      );
      const stub = stubRefreshGrant(() =>
        jsonResponse(401, {
          error: "invalid_request",
          error_description: "This request requires an active refresh_token",
        }),
      );
      const result = yield* shopify
        .refreshShopSessionIfExpired(expiredLoser())
        .pipe(Effect.ensuring(stub.restore));
      strictEqual(result.accessToken, "shpat_winner");
      strictEqual(result.refreshToken, "shprt_winner");
    }).pipe(Effect.provide(shopifyTestLayer())),
  );

  it.live(
    "fails RefreshTokenExpiredError with a null expiry when no winner exists",
    () =>
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        yield* shopify.storeShopSession(expiredLoser(), shopGid);
        const stub = stubRefreshGrant(() =>
          jsonResponse(401, {
            error: "invalid_request",
            error_description: "This request requires an active refresh_token",
          }),
        );
        const error = yield* Effect.flip(
          shopify.refreshShopSessionIfExpired(expiredLoser()),
        ).pipe(Effect.ensuring(stub.restore));
        assertInstanceOf(error, RefreshTokenExpiredError);
        strictEqual(error.refreshTokenExpiresAt, null);
      }).pipe(Effect.provide(shopifyTestLayer())),
  );
});

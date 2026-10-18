import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { SEED_SHOP } from "../../seed-shops.ts";
import {
  ShopSessionRepository,
  ShopSessionUpsert,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";
import { Shopify } from "../../../src/backend/shopify.ts";
import { mintSessionToken } from "../../shopify-session-token.ts";
import { QuietLogs, testShopify } from "./layers.ts";
import { accessTokenBody, jsonResponse, withShopifyStub } from "./shopify-stub.ts";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** A stored session whose access token expired a second before `now`; its refresh token has 30 days. */
const rowAt = (now: number, over: Partial<ShopSessionRow> = {}): ShopSessionRow => ({
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_orders",
  accessTokenExpiresAt: now - 1000,
  accessToken: "shpat_old",
  refreshToken: "shprt_old",
  refreshTokenExpiresAt: now + 30 * DAY,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
  ...over,
});

/** The row a concurrent exchange would have stored. */
const winnerAt = (now: number) =>
  rowAt(now, {
    accessToken: "shpat_winner",
    accessTokenExpiresAt: now + 60 * MINUTE,
    refreshToken: "shprt_winner",
  });

const toUpsert = Schema.decodeUnknownSync(ShopSessionUpsert);

/** Stores `row` as an exchange would, from inside a stub's reply. */
const storeAsExchange = (sessions: typeof ShopSessionRepository.Service, row: ShopSessionRow) =>
  Effect.runPromise(sessions.upsert(toUpsert(row)));

const ensure = Effect.flatMap(Shopify, (shopify) => shopify.ensureShopSession(SEED_SHOP));
const stored = Effect.flatMap(ShopSessionRepository, (sessions) => sessions.find(SEED_SHOP)).pipe(
  Effect.map(Option.getOrThrow),
);

const failureOf = (effect: Effect.Effect<unknown, unknown, Shopify | ShopSessionRepository>) =>
  Effect.flip(effect);

/** The `reason` of a {@link ReauthorizationRequired}, or the tag of any other error. */
const verdict = (error: unknown) =>
  typeof error === "object" && error !== null && "reason" in error
    ? String(error.reason)
    : typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "unknown";

const assertDefect = (effect: Effect.Effect<unknown, unknown, Shopify | ShopSessionRepository>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause), "expected a defect");
  });

/**
 * A test on the real clock with its own rows. The library stamps a refreshed session's expiries
 * with `Date.now()`, and a stub's reply is a real promise, so a test that reaches the stub
 * cannot run on the test clock.
 */
const live = (
  name: string,
  rowsFor: (now: number) => ReadonlyArray<ShopSessionRow>,
  body: Effect.Effect<void, unknown, Shopify | ShopSessionRepository>,
  timeout = 5000,
) =>
  it.live(
    name,
    () => body.pipe(Effect.provide(testShopify(rowsFor(Date.now()))), Effect.provide(QuietLogs)),
    { timeout },
  );

describe("Shopify.ensureShopSession without a grant", () => {
  it.effect("a fresh token is returned unchanged, with no fetch", () =>
    withShopifyStub(
      () => jsonResponse(500, {}),
      (calls) =>
        Effect.gen(function* () {
          const session = yield* ensure;
          assert.strictEqual(session.accessToken, "shpat_old");
          assert.strictEqual(calls.length, 0);
        }),
    ).pipe(Effect.provide(testShopify([rowAt(0, { accessTokenExpiresAt: 10 * MINUTE })]))),
  );

  it.effect("a refresh token already expired is ReauthorizationRequired, with no fetch", () =>
    withShopifyStub(
      () => jsonResponse(500, {}),
      (calls) =>
        Effect.gen(function* () {
          assert.strictEqual(verdict(yield* failureOf(ensure)), "refresh-token-expired");
          assert.strictEqual(calls.length, 0);
        }),
    ).pipe(Effect.provide(testShopify([rowAt(0, { refreshTokenExpiresAt: 0 })]))),
  );

  it.effect.each([
    { name: "no refresh token", over: { refreshToken: null } },
    { name: "no refresh expiry", over: { refreshTokenExpiresAt: null } },
  ])("a row with $name is no-refresh-token", ({ over }) =>
    Effect.gen(function* () {
      assert.strictEqual(verdict(yield* failureOf(ensure)), "no-refresh-token");
    }).pipe(Effect.provide(testShopify([rowAt(0, over)]))),
  );

  it.effect("crossing the refresh token's expiry minus 60 s makes it expired", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(60_000);
      const error = yield* failureOf(ensure);
      assert.strictEqual(verdict(error), "refresh-token-expired");
      assert.deepInclude(error as object, { refreshTokenExpiresAt: 120_000 });
    }).pipe(Effect.provide(testShopify([rowAt(0, { refreshTokenExpiresAt: 120_000 })]))),
  );

  it.effect("one millisecond before that boundary the refresh token is still tried", () =>
    withShopifyStub(
      () => jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(59_999);
          yield* ensure;
          assert.strictEqual(calls.length, 1);
        }),
    ).pipe(Effect.provide(testShopify([rowAt(0, { refreshTokenExpiresAt: 120_000 })]))),
  );

  it.effect("an unknown shop is OfflineSessionMissing", () =>
    Effect.gen(function* () {
      assert.strictEqual(verdict(yield* failureOf(ensure)), "OfflineSessionMissing");
    }).pipe(Effect.provide(testShopify([]))),
  );
});

describe("Shopify.ensureShopSession refreshing", () => {
  live(
    "a successful grant rotates and stores the new pair, keeping shopGid and scope",
    (now) => [rowAt(now)],
    withShopifyStub(
      () => jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          const session = yield* ensure;
          assert.strictEqual(session.accessToken, "shpat_new");
          assert.strictEqual(session.scope, "read_orders");
          assert.deepStrictEqual(
            calls.map((call) => call.refreshToken),
            ["shprt_old"],
          );
          const row = yield* stored;
          assert.strictEqual(row.accessToken, "shpat_new");
          assert.strictEqual(row.refreshToken, "shprt_new");
          assert.strictEqual(row.shopGid, "gid://shopify/Shop/1");
          assert.strictEqual(row.scope, "read_orders");
          assert.strictEqual(row.refreshLeaseUntil, null);
          assert.isAbove(row.accessTokenExpiresAt ?? 0, Date.now());
        }),
    ),
  );

  live(
    "a row with no access token and a valid refresh token refreshes",
    (now) => [rowAt(now, { accessToken: null, accessTokenExpiresAt: null })],
    withShopifyStub(
      () => jsonResponse(200, accessTokenBody()),
      () =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ensure).accessToken, "shpat_new");
        }),
    ),
  );

  live(
    "a 401 with a winner in the row adopts the winner",
    (now) => [rowAt(now)],
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      yield* withShopifyStub(
        () =>
          storeAsExchange(sessions, winnerAt(Date.now())).then(() =>
            jsonResponse(401, { error: "invalid_request" }),
          ),
        (calls) =>
          Effect.gen(function* () {
            assert.strictEqual((yield* ensure).accessToken, "shpat_winner");
            assert.strictEqual(calls.length, 1);
            assert.strictEqual((yield* stored).refreshLeaseUntil, null);
          }),
      );
    }),
  );

  live(
    "a 401 with no winner is refresh-token-rejected after the budget, with one grant",
    (now) => [rowAt(now)],
    withShopifyStub(
      () => jsonResponse(401, { error: "invalid_request" }),
      (calls) =>
        Effect.gen(function* () {
          const started = Date.now();
          assert.strictEqual(verdict(yield* failureOf(ensure)), "refresh-token-rejected");
          assert.isAbove(Date.now() - started, 1000);
          assert.strictEqual(calls.length, 1);
          const row = yield* stored;
          assert.strictEqual(row.refreshToken, "shprt_old");
          assert.strictEqual(row.refreshLeaseUntil, null);
        }),
    ),
    8000,
  );

  live(
    "a 401 with the row gone is OfflineSessionMissing",
    (now) => [rowAt(now)],
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      yield* withShopifyStub(
        () =>
          Effect.runPromise(sessions.remove(SEED_SHOP)).then(() =>
            jsonResponse(401, { error: "invalid_request" }),
          ),
        () =>
          Effect.gen(function* () {
            assert.strictEqual(verdict(yield* failureOf(ensure)), "OfflineSessionMissing");
          }),
      );
    }),
  );

  live(
    "a 429 then a 200 retries with the same refresh token",
    (now) => [rowAt(now)],
    withShopifyStub(
      (_call, attempt) =>
        attempt === 0
          ? jsonResponse(429, { error: "throttled" })
          : jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ensure).accessToken, "shpat_new");
          assert.deepStrictEqual(
            calls.map((call) => call.refreshToken),
            ["shprt_old", "shprt_old"],
          );
        }),
    ),
  );

  live(
    "a 503 then a 200 retries",
    (now) => [rowAt(now)],
    withShopifyStub(
      (_call, attempt) =>
        attempt === 0 ? jsonResponse(503, { error: "down" }) : jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ensure).accessToken, "shpat_new");
          assert.strictEqual(calls.length, 2);
        }),
    ),
  );

  live(
    "a non-JSON 502 body is transient",
    (now) => [rowAt(now)],
    withShopifyStub(
      (_call, attempt) =>
        attempt === 0
          ? new Response("<html>Bad gateway</html>", { status: 502 })
          : jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ensure).accessToken, "shpat_new");
          assert.strictEqual(calls.length, 2);
        }),
    ),
  );

  live(
    "an exhausted 429 is ShopifyUnavailable, never a rejection, and the lease is released",
    (now) => [rowAt(now)],
    withShopifyStub(
      () => jsonResponse(429, { error: "throttled" }),
      (calls) =>
        Effect.gen(function* () {
          assert.strictEqual(verdict(yield* failureOf(ensure)), "ShopifyUnavailable");
          assert.strictEqual(calls.length, 4);
          const row = yield* stored;
          assert.strictEqual(row.refreshToken, "shprt_old");
          assert.strictEqual(row.refreshLeaseUntil, null);
        }),
    ),
    12_000,
  );

  for (const status of [400, 403]) {
    live(
      `a ${status} on the grant is a defect, with no retry and the lease released`,
      (now) => [rowAt(now)],
      withShopifyStub(
        () => jsonResponse(status, { error: "invalid_subject_token" }),
        (calls) =>
          Effect.gen(function* () {
            yield* assertDefect(ensure);
            assert.strictEqual(calls.length, 1);
            const row = yield* stored;
            assert.strictEqual(row.refreshToken, "shprt_old");
            assert.strictEqual(row.refreshLeaseUntil, null);
          }),
      ),
    );
  }

  live(
    "a response without refresh_token_expires_in is a defect and leaves the row unchanged",
    (now) => [rowAt(now)],
    withShopifyStub(
      () => jsonResponse(200, accessTokenBody({ refresh_token_expires_in: undefined })),
      () =>
        Effect.gen(function* () {
          yield* assertDefect(ensure);
          const row = yield* stored;
          assert.strictEqual(row.accessToken, "shpat_old");
          assert.strictEqual(row.refreshToken, "shprt_old");
          assert.strictEqual(row.refreshLeaseUntil, null);
        }),
    ),
  );

  live(
    "a lost rotateTokens adopts the stored row",
    (now) => [rowAt(now)],
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      yield* withShopifyStub(
        () =>
          storeAsExchange(sessions, winnerAt(Date.now())).then(() =>
            jsonResponse(200, accessTokenBody()),
          ),
        () =>
          Effect.gen(function* () {
            const session = yield* ensure;
            assert.strictEqual(session.accessToken, "shpat_winner");
            const row = yield* stored;
            assert.strictEqual(row.refreshToken, "shprt_winner");
          }),
      );
    }),
  );
});

describe("Shopify.ensureShopSession and the lease", () => {
  live(
    "a second caller waits for the holder and adopts its result: one grant in total",
    (now) => [rowAt(now)],
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* withShopifyStub(
        () =>
          Effect.runPromise(Deferred.await(gate)).then(() => jsonResponse(200, accessTokenBody())),
        (calls) =>
          Effect.gen(function* () {
            const waitForGrant = Effect.gen(function* () {
              while (calls.length === 0) yield* Effect.sleep("10 millis");
            });
            const [first, second] = yield* Effect.all(
              [
                ensure,
                Effect.gen(function* () {
                  yield* waitForGrant;
                  return yield* ensure;
                }),
                Effect.gen(function* () {
                  yield* waitForGrant;
                  yield* Effect.sleep("150 millis");
                  yield* Deferred.succeed(gate, undefined);
                }),
              ],
              { concurrency: "unbounded" },
            );
            assert.strictEqual(first.accessToken, "shpat_new");
            assert.strictEqual(second.accessToken, "shpat_new");
            assert.strictEqual(calls.length, 1);
          }),
      );
    }),
  );

  live(
    "a lapsed lease is taken over",
    (now) => [rowAt(now, { refreshLeaseUntil: now - 1 })],
    withShopifyStub(
      () => jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ensure).accessToken, "shpat_new");
          assert.strictEqual(calls.length, 1);
          assert.strictEqual((yield* stored).refreshLeaseUntil, null);
        }),
    ),
  );

  live(
    "a waiter whose lease lapses with nothing fresh takes over",
    (now) => [rowAt(now, { refreshLeaseUntil: now + 200 })],
    withShopifyStub(
      () => jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ensure).accessToken, "shpat_new");
          assert.strictEqual(calls.length, 1);
        }),
    ),
  );
});

describe("Shopify.authenticateAdmin and the lease", () => {
  const authenticate = Effect.gen(function* () {
    const shopify = yield* Shopify;
    const token = yield* mintSessionToken({ shop: SEED_SHOP });
    return yield* shopify.authenticateAdmin(token);
  });

  live(
    "a live lease with a refresh landing during the wait reuses the refreshed row, with no exchange",
    (now) => [rowAt(now, { refreshLeaseUntil: now + 3000 })],
    withShopifyStub(
      () => jsonResponse(500, {}),
      (calls) =>
        Effect.gen(function* () {
          const sessions = yield* ShopSessionRepository;
          const now = Date.now();
          const [answer] = yield* Effect.all(
            [
              authenticate,
              Effect.gen(function* () {
                yield* Effect.sleep("100 millis");
                yield* sessions.rotateTokens(SEED_SHOP, "shprt_old", {
                  accessToken: "shpat_refreshed",
                  accessTokenExpiresAt: now + 60 * MINUTE,
                  refreshToken: "shprt_refreshed",
                  refreshTokenExpiresAt: now + 30 * DAY,
                });
              }),
            ],
            { concurrency: "unbounded" },
          );
          assert.strictEqual(answer.shopGid, "gid://shopify/Shop/1");
          assert.strictEqual(calls.length, 0);
          assert.strictEqual((yield* stored).accessToken, "shpat_refreshed");
        }),
    ),
  );

  live(
    "a lease that lapses with nothing fresh exchanges, and the exchange does not take the lease",
    (now) => [rowAt(now, { refreshLeaseUntil: now + 200 })],
    withShopifyStub(
      () => jsonResponse(200, accessTokenBody()),
      (calls) =>
        Effect.gen(function* () {
          yield* authenticate;
          assert.strictEqual(calls.length, 1);
          assert.match(calls[0]?.grantType ?? "", /token-exchange/u);
          const row = yield* stored;
          assert.strictEqual(row.accessToken, "shpat_new");
          assert.isTrue(row.refreshLeaseUntil === null || row.refreshLeaseUntil <= Date.now());
        }),
    ),
  );
});

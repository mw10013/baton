import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SEED_SHOP } from "../../seed-shops.ts";
import {
  ShopSessionRepository,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";
import { makeD1Test } from "./layers.ts";

const row: ShopSessionRow = {
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopActorId: SEED_SHOP,
  scope: "read_orders",
  accessTokenExpiresAt: 1_000,
  accessToken: "shpat_a",
  refreshToken: "shprt_a",
  refreshTokenExpiresAt: 2_000,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};

const tokens = {
  accessToken: "shpat_b",
  accessTokenExpiresAt: 3_000,
  refreshToken: "shprt_b",
  refreshTokenExpiresAt: 4_000,
};

const stored = Effect.gen(function* () {
  const sessions = yield* ShopSessionRepository;
  return (yield* sessions.find(SEED_SHOP)).pipe(Option.getOrThrow);
});

describe("ShopSessionRepository refresh writes", () => {
  it.effect("rotateTokens wins only with the matching token, and clears the lease", () =>
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      assert.isTrue(yield* sessions.acquireRefreshLease(SEED_SHOP, 0, 10));
      assert.isTrue(yield* sessions.rotateTokens(SEED_SHOP, "shprt_a", tokens));
      const after = yield* stored;
      assert.strictEqual(after.accessToken, "shpat_b");
      assert.strictEqual(after.refreshToken, "shprt_b");
      assert.strictEqual(after.refreshTokenExpiresAt, 4_000);
      assert.strictEqual(after.refreshLeaseUntil, null);
      assert.strictEqual(after.scope, "read_orders");
    }).pipe(Effect.provide(ShopSessionRepository.layerTest([row]))),
  );

  it.effect("a lost rotateTokens changes nothing", () =>
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      assert.isFalse(yield* sessions.rotateTokens(SEED_SHOP, "shprt_other", tokens));
      assert.deepStrictEqual(yield* stored, row);
    }).pipe(Effect.provide(ShopSessionRepository.layerTest([row]))),
  );

  it.effect("the lease is exclusive until it lapses, then re-takeable", () =>
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      assert.isTrue(yield* sessions.acquireRefreshLease(SEED_SHOP, 100, 200));
      assert.isFalse(yield* sessions.acquireRefreshLease(SEED_SHOP, 150, 250));
      assert.isTrue(yield* sessions.acquireRefreshLease(SEED_SHOP, 200, 300));
      assert.strictEqual((yield* stored).refreshLeaseUntil, 300);
    }).pipe(Effect.provide(ShopSessionRepository.layerTest([row]))),
  );

  it.effect("releaseRefreshLease with a stale until is a no-op", () =>
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      yield* sessions.acquireRefreshLease(SEED_SHOP, 0, 200);
      yield* sessions.releaseRefreshLease(SEED_SHOP, 100);
      assert.strictEqual((yield* stored).refreshLeaseUntil, 200);
      yield* sessions.releaseRefreshLease(SEED_SHOP, 200);
      assert.strictEqual((yield* stored).refreshLeaseUntil, null);
    }).pipe(Effect.provide(ShopSessionRepository.layerTest([row]))),
  );

  it.effect("clearAccessToken is conditional", () =>
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      yield* sessions.clearAccessToken(SEED_SHOP, "shpat_stale");
      assert.strictEqual((yield* stored).accessToken, "shpat_a");
      yield* sessions.clearAccessToken(SEED_SHOP, "shpat_a");
      assert.strictEqual((yield* stored).accessToken, null);
    }).pipe(Effect.provide(ShopSessionRepository.layerTest([row]))),
  );

  it.effect("upsert leaves an existing lease alone and inserts a new row unleased", () =>
    Effect.gen(function* () {
      const sessions = yield* ShopSessionRepository;
      yield* sessions.acquireRefreshLease(SEED_SHOP, 0, 200);
      const {
        refreshLeaseUntil: _,
        planHandle: _p,
        planHandleExpiresAt: _e,
        planBoundaryAt: _b,
        ...upsert
      } = row;
      yield* sessions.upsert({ ...upsert, accessToken: "shpat_c" });
      const after = yield* stored;
      assert.strictEqual(after.refreshLeaseUntil, 200);
      assert.strictEqual(after.accessToken, "shpat_c");
    }).pipe(Effect.provide(ShopSessionRepository.layerTest([row]))),
  );
});

/**
 * The plan cache columns over the real SQL on an in-memory D1: legacy `repository.test.ts`'s two
 * plan titles, unchanged. "updateShopSessionPlan" is legacy's name for `updatePlan`.
 */
describe("ShopSessionRepository plan cache", () => {
  const inD1 = <A, E>(body: Effect.Effect<A, E, ShopSessionRepository>) =>
    Effect.gen(function* () {
      const { raw } = yield* makeD1Test;
      return yield* body.pipe(Effect.provide(ShopSessionRepository.layerWith(raw)));
    });

  const {
    refreshLeaseUntil: _,
    planHandle: _p,
    planHandleExpiresAt: _e,
    planBoundaryAt: _b,
    ...upsert
  } = row;

  it.effect("shortens the plan deadline but never extends it or writes a never-fetched row", () =>
    inD1(
      Effect.gen(function* () {
        const sessions = yield* ShopSessionRepository;
        yield* sessions.upsert(upsert);
        const deadline = () => Effect.map(stored, (session) => session.planHandleExpiresAt);
        // Never fetched: stays never fetched, or an absent handle would
        // start reading as a verified absence of any app subscription.
        yield* sessions.shortenPlanExpiry({ shop: SEED_SHOP, notAfter: 500 });
        assert.strictEqual(yield* deadline(), null);
        yield* sessions.updatePlan({
          shop: SEED_SHOP,
          planHandle: "baton-pro",
          planHandleExpiresAt: 3000,
          planBoundaryAt: null,
        });
        yield* sessions.shortenPlanExpiry({ shop: SEED_SHOP, notAfter: 4000 });
        assert.strictEqual(yield* deadline(), 3000);
        yield* sessions.shortenPlanExpiry({ shop: SEED_SHOP, notAfter: 2000 });
        assert.strictEqual(yield* deadline(), 2000);
      }),
    ),
  );

  it.effect("updateShopSessionPlan rewrites only the plan cache fields", () =>
    inD1(
      Effect.gen(function* () {
        const sessions = yield* ShopSessionRepository;
        yield* sessions.upsert(upsert);
        yield* sessions.updatePlan({
          shop: SEED_SHOP,
          planHandle: "baton-pro",
          planHandleExpiresAt: 3000,
          planBoundaryAt: null,
        });
        const session = yield* stored;
        assert.strictEqual(session.planHandle, "baton-pro");
        assert.strictEqual(session.planHandleExpiresAt, 3000);
        assert.strictEqual(session.accessToken, "shpat_a");
        assert.strictEqual(session.refreshToken, "shprt_a");
        assert.strictEqual(session.scope, "read_orders");
      }),
    ),
  );
});

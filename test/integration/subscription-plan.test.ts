import { assert, describe, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient, ShopAgentClientError } from "@/lib/ShopAgentClient";
import { ShopifyPartner, ShopifyPartnerError } from "@/lib/ShopifyPartner";
import {
  SubscriptionPlan,
  SubscriptionPlanError,
} from "@/lib/SubscriptionPlan";

const repositoryLayer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

const shop = Schema.decodeUnknownSync(Domain.Shop)("plan.myshopify.com");
const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
  "gid://shopify/Shop/1",
);

const shopSession = (
  planHandle: string | null,
  planHandleExpiresAt: number | null,
): Omit<Domain.ShopSession, "planHandle" | "planHandleExpiresAt"> & {
  readonly planHandle?: string | null;
  readonly planHandleExpiresAt?: number | null;
} => ({
  shop,
  shopGid,
  shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)("plan-agent"),
  scope: "read_products",
  accessTokenExpiresAt: 1000,
  accessToken: "shpat_x",
  refreshToken: "shprt_x",
  refreshTokenExpiresAt: 2000,
  planHandle,
  planHandleExpiresAt,
});

const seedShopSession = (planHandle: string | null, expiresAt: number | null) =>
  Effect.gen(function* () {
    const repository = yield* Repository;
    yield* repository.upsertShopSession(shopSession(planHandle, expiresAt));
    yield* repository.updateShopSessionPlan({
      shop,
      planHandle,
      planHandleExpiresAt: expiresAt,
    });
  });

/**
 * The revoke-on-lapse hook is observed through a recording stub rather than a
 * socket: what this file owns is *when* `SubscriptionPlan` decides to revoke,
 * and `shop-agent-connections.test.ts` owns what `revokeAllConnections` does
 * to a live connection.
 */
const run = <A, E>(
  activeSubscription: ShopifyPartner["Service"]["activeSubscription"],
  effect: Effect.Effect<A, E, Repository | SubscriptionPlan>,
  options: {
    readonly revoked?: Ref.Ref<readonly string[]>;
    readonly revokeFails?: boolean;
  } = {},
) =>
  effect.pipe(
    Effect.provide(SubscriptionPlan.layerNoDeps),
    Effect.provide([
      repositoryLayer,
      Layer.succeed(
        ShopifyPartner,
        ShopifyPartner.of({
          activeSubscription,
          planSelectionUrl: () => "https://example.com/plans",
        }),
      ),
      Layer.succeed(
        ShopAgentClient,
        new Proxy({} as ShopAgentClient["Service"], {
          get: (_target, name) => {
            if (name !== "revokeAllConnections")
              return () =>
                Effect.die(`ShopAgentClient.${String(name)} not stubbed`);
            if (options.revokeFails)
              return () =>
                Effect.fail(
                  new ShopAgentClientError({
                    message: "object unreachable",
                    retryable: false,
                    overloaded: false,
                    cause: new Error("unreachable"),
                  }),
                );
            const { revoked } = options;
            return (revokedShop: string) =>
              revoked === undefined
                ? Effect.void
                : Ref.update(revoked, (shops) => [...shops, revokedShop]);
          },
        }),
      ),
    ]),
  );

const activeProAtFutureBoundary = () =>
  Effect.succeed(
    Option.some<Domain.ActiveSubscription>({
      handle: "baton-pro",
      boundaryAt: 601_000,
    }),
  );

const activeProAtPastBoundary = () =>
  Effect.succeed(
    Option.some<Domain.ActiveSubscription>({
      handle: "baton-pro",
      boundaryAt: 600_000,
    }),
  );

const failedActiveSubscription = () =>
  Effect.fail(
    new ShopifyPartnerError({
      message: "unavailable",
      cause: new Error("unavailable"),
    }),
  );

afterEach(() => env.D1.exec("delete from ShopSession"));

describe("SubscriptionPlan", () => {
  it.effect(
    "serves fresh positive and negative entries without revalidation",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const calls = yield* Ref.make(0);
        const activeSubscription = () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(Option.none<Domain.ActiveSubscription>()),
          );

        yield* run(
          activeSubscription,
          Effect.gen(function* () {
            const plan = yield* SubscriptionPlan;
            yield* seedShopSession("baton-pro", 2000);
            assert.deepStrictEqual(yield* plan.resolve(shop), {
              _tag: "Subscribed",
              handle: "baton-pro",
              plan: "pro",
            });
            yield* seedShopSession(null, 2000);
            assert.deepStrictEqual(yield* plan.resolve(shop), {
              _tag: "Unsubscribed",
            });
          }),
        );
        assert.strictEqual(yield* Ref.get(calls), 0);
      }),
  );

  it.effect(
    "returns unsubscribed for a missing session without revalidation",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const activeSubscription = () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(Option.none<Domain.ActiveSubscription>()),
          );
        assert.deepStrictEqual(
          yield* run(
            activeSubscription,
            Effect.gen(function* () {
              const plan = yield* SubscriptionPlan;
              return yield* plan.resolve(shop);
            }),
          ),
          { _tag: "Unsubscribed" },
        );
        assert.strictEqual(yield* Ref.get(calls), 0);
      }),
  );

  it.effect(
    "revalidates expired, never-fetched, and unknown cached entries",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const calls = yield* Ref.make(0);
        const activeSubscription = () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(
              Option.some<Domain.ActiveSubscription>({
                handle: "baton-basic",
                boundaryAt: null,
              }),
            ),
          );
        yield* run(
          activeSubscription,
          Effect.gen(function* () {
            const plan = yield* SubscriptionPlan;
            for (const [handle, expiresAt] of [
              ["baton-pro", 1000],
              [null, null],
              ["retired-plan", 2000],
            ] as const) {
              yield* seedShopSession(handle, expiresAt);
              assert.deepStrictEqual(yield* plan.resolve(shop), {
                _tag: "Subscribed",
                handle: "baton-basic",
                plan: "basic",
              });
            }
            const stored = Option.getOrThrow(
              yield* (yield* Repository).findShopSession(shop),
            );
            assert.strictEqual(stored.planHandle, "baton-basic");
            assert.strictEqual(stored.planHandleExpiresAt, 86_401_000);
          }),
        );
        assert.strictEqual(yield* Ref.get(calls), 3);
      }),
  );

  it.effect("refresh ignores a fresh entry and caches a verified absence", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const calls = yield* Ref.make(0);
      const activeSubscription = () =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.as(Option.none<Domain.ActiveSubscription>()),
        );
      yield* run(
        activeSubscription,
        Effect.gen(function* () {
          const plan = yield* SubscriptionPlan;
          yield* seedShopSession("baton-pro", 2000);
          assert.deepStrictEqual(yield* plan.refresh(shop), {
            _tag: "Unsubscribed",
          });
          const stored = Option.getOrThrow(
            yield* (yield* Repository).findShopSession(shop),
          );
          assert.strictEqual(stored.planHandle, null);
          assert.strictEqual(stored.planHandleExpiresAt, 86_401_000);
        }),
      );
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("revokes the shop's connections when a cached plan lapses", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const revoked = yield* Ref.make<readonly string[]>([]);
      yield* run(
        () => Effect.succeed(Option.none<Domain.ActiveSubscription>()),
        Effect.gen(function* () {
          const plan = yield* SubscriptionPlan;
          yield* seedShopSession("baton-pro", 500);
          assert.deepStrictEqual(yield* plan.resolve(shop), {
            _tag: "Unsubscribed",
          });
        }),
        { revoked },
      );
      assert.deepStrictEqual(yield* Ref.get(revoked), [shop]);
    }),
  );

  it.effect("does not revoke when the shop was already unsubscribed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const revoked = yield* Ref.make<readonly string[]>([]);
      yield* run(
        () => Effect.succeed(Option.none<Domain.ActiveSubscription>()),
        Effect.gen(function* () {
          const plan = yield* SubscriptionPlan;
          // Expired verified absence: revalidates, lands on null again.
          yield* seedShopSession(null, 500);
          yield* plan.resolve(shop);
          // Never cached: nothing to flip from.
          yield* seedShopSession(null, null);
          yield* plan.resolve(shop);
        }),
        { revoked },
      );
      assert.deepStrictEqual(yield* Ref.get(revoked), []);
    }),
  );

  it.effect("does not revoke when the plan is still active", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const revoked = yield* Ref.make<readonly string[]>([]);
      yield* run(
        activeProAtFutureBoundary,
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { revoked },
      );
      assert.deepStrictEqual(yield* Ref.get(revoked), []);
    }),
  );

  it.effect("still answers Unsubscribed when the revoke fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      yield* run(
        () => Effect.succeed(Option.none<Domain.ActiveSubscription>()),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          assert.deepStrictEqual(
            yield* (yield* SubscriptionPlan).resolve(shop),
            { _tag: "Unsubscribed" },
          );
        }),
        { revokeFails: true },
      );
    }),
  );

  it.effect("clamps expiry to a future boundary plus skew", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      yield* run(
        activeProAtFutureBoundary,
        Effect.gen(function* () {
          yield* seedShopSession(null, null);
          yield* (yield* SubscriptionPlan).resolve(shop);
          const stored = Option.getOrThrow(
            yield* (yield* Repository).findShopSession(shop),
          );
          assert.strictEqual(stored.planHandleExpiresAt, 901_000);
        }),
      );
    }),
  );

  it.effect("ignores a past boundary when computing expiry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      yield* run(
        activeProAtPastBoundary,
        Effect.gen(function* () {
          yield* seedShopSession(null, null);
          yield* (yield* SubscriptionPlan).resolve(shop);
          const stored = Option.getOrThrow(
            yield* (yield* Repository).findShopSession(shop),
          );
          assert.strictEqual(stored.planHandleExpiresAt, 87_400_000);
        }),
      );
    }),
  );

  it.effect(
    "keeps Partner failures distinct from unsubscribed and preserves cache",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        yield* run(
          failedActiveSubscription,
          Effect.gen(function* () {
            yield* seedShopSession("baton-pro", 1000);
            const error = yield* Effect.flip(
              (yield* SubscriptionPlan).resolve(shop),
            );
            assert.instanceOf(error, SubscriptionPlanError);
            const stored = Option.getOrThrow(
              yield* (yield* Repository).findShopSession(shop),
            );
            assert.strictEqual(stored.planHandle, "baton-pro");
            assert.strictEqual(stored.planHandleExpiresAt, 1000);
          }),
        );
      }),
  );
});

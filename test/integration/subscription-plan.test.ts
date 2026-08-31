import { D1Client } from "@effect/sql-d1";
import { assert, describe, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach } from "vitest";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";
import { ShopifyPartner, ShopifyPartnerError } from "@/lib/ShopifyPartner";
import {
  SubscriptionPlan,
  SubscriptionPlanError,
} from "@/lib/SubscriptionPlan";

const repositoryLayer = Repository.layerNoDeps.pipe(
  Layer.provide(D1Client.layer({ db: env.D1 })),
);

const shop = Schema.decodeUnknownSync(Domain.Shop)("plan.myshopify.com");
const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
  "gid://shopify/Shop/1",
);

const session = (
  planHandle: string | null,
  planHandleExpiresAt: number | null,
): Omit<Domain.Session, "planHandle" | "planHandleExpiresAt"> & {
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

const seedSession = (planHandle: string | null, expiresAt: number | null) =>
  Effect.gen(function* () {
    const repository = yield* Repository;
    yield* repository.upsertSession(session(planHandle, expiresAt));
    yield* repository.updateSessionPlan({
      shop,
      planHandle,
      planHandleExpiresAt: expiresAt,
    });
  });

const run = <A, E>(
  activeSubscription: ShopifyPartner["Service"]["activeSubscription"],
  effect: Effect.Effect<A, E, Repository | SubscriptionPlan>,
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

afterEach(() => env.D1.exec("delete from Session"));

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
            yield* seedSession("baton-pro-test", 2000);
            assert.deepStrictEqual(yield* plan.resolve(shop), {
              _tag: "Subscribed",
              handle: "baton-pro-test",
              plan: "pro",
            });
            yield* seedSession(null, 2000);
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
              yield* seedSession(handle, expiresAt);
              assert.deepStrictEqual(yield* plan.resolve(shop), {
                _tag: "Subscribed",
                handle: "baton-basic",
                plan: "basic",
              });
            }
            const stored = Option.getOrThrow(
              yield* (yield* Repository).findSessionByShop(shop),
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
          yield* seedSession("baton-pro", 2000);
          assert.deepStrictEqual(yield* plan.refresh(shop), {
            _tag: "Unsubscribed",
          });
          const stored = Option.getOrThrow(
            yield* (yield* Repository).findSessionByShop(shop),
          );
          assert.strictEqual(stored.planHandle, null);
          assert.strictEqual(stored.planHandleExpiresAt, 86_401_000);
        }),
      );
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("clamps expiry to a future boundary plus skew", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      yield* run(
        activeProAtFutureBoundary,
        Effect.gen(function* () {
          yield* seedSession(null, null);
          yield* (yield* SubscriptionPlan).resolve(shop);
          const stored = Option.getOrThrow(
            yield* (yield* Repository).findSessionByShop(shop),
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
          yield* seedSession(null, null);
          yield* (yield* SubscriptionPlan).resolve(shop);
          const stored = Option.getOrThrow(
            yield* (yield* Repository).findSessionByShop(shop),
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
            yield* seedSession("baton-pro", 1000);
            const error = yield* Effect.flip(
              (yield* SubscriptionPlan).resolve(shop),
            );
            assert.instanceOf(error, SubscriptionPlanError);
            const stored = Option.getOrThrow(
              yield* (yield* Repository).findSessionByShop(shop),
            );
            assert.strictEqual(stored.planHandle, "baton-pro");
            assert.strictEqual(stored.planHandleExpiresAt, 1000);
          }),
        );
      }),
  );
});

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

const shopSession = (): Omit<
  Domain.ShopSession,
  "planHandle" | "planHandleExpiresAt" | "planBoundaryAt" | "planCycleStartAt"
> => ({
  shop,
  shopGid,
  shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)("plan-agent"),
  scope: "read_products",
  accessTokenExpiresAt: 1000,
  accessToken: "shpat_x",
  refreshToken: "shprt_x",
  refreshTokenExpiresAt: 2000,
});

const seedShopSession = (
  planHandle: string | null,
  expiresAt: number | null,
  cached: {
    readonly planBoundaryAt?: number | null;
    readonly planCycleStartAt?: number | null;
  } = {},
) =>
  Effect.gen(function* () {
    const repository = yield* Repository;
    yield* repository.upsertShopSession(shopSession());
    yield* repository.updateShopSessionPlan({
      shop,
      planHandle,
      planHandleExpiresAt: expiresAt,
      planBoundaryAt: cached.planBoundaryAt ?? null,
      planCycleStartAt: cached.planCycleStartAt ?? null,
    });
  });

/** A contract with no boundary and no meter, which is what most cases are about. */
const contract = (
  overrides: Partial<Domain.ActiveSubscription> & {
    readonly handle: Domain.PlanHandle;
  },
): Domain.ActiveSubscription => ({
  boundaryAt: null,
  cycleStartAt: null,
  usageQuantity: null,
  ...overrides,
});

/** The `Subscribed` status such a contract resolves to. */
const subscribedTo = (
  handle: Domain.PlanHandle,
  overrides: Partial<Extract<Domain.PlanStatus, { _tag: "Subscribed" }>> = {},
) => ({
  _tag: "Subscribed" as const,
  handle,
  plan: Domain.planOfHandle(handle),
  boundaryAt: null,
  ...overrides,
});

/** What the object was told, so a case can assert the pushes without a Durable Object. */
interface Pushes {
  readonly revoked: Ref.Ref<readonly string[]>;
  readonly cycles: Ref.Ref<readonly Domain.BillingCycleInput[]>;
  readonly reconciled: Ref.Ref<readonly number[]>;
}

const makePushes = Effect.gen(function* () {
  return {
    revoked: yield* Ref.make<readonly string[]>([]),
    cycles: yield* Ref.make<readonly Domain.BillingCycleInput[]>([]),
    reconciled: yield* Ref.make<readonly number[]>([]),
  } satisfies Pushes;
});

/**
 * The object-facing hooks are observed through a recording stub rather than a
 * socket or a real Durable Object: what this file owns is *when*
 * `SubscriptionPlan` decides to revoke, push a cycle, or reconcile, and
 * `shop-agent-connections.test.ts` owns what `revokeAllConnections` does to a
 * live connection.
 */
const run = <A, E>(
  activeSubscription: ShopifyPartner["Service"]["activeSubscription"],
  effect: Effect.Effect<A, E, Repository | SubscriptionPlan>,
  options: {
    readonly pushes?: Pushes;
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
            const { pushes } = options;
            if (name === "revokeAllConnections") {
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
              return (revokedShop: string) =>
                pushes === undefined
                  ? Effect.void
                  : Ref.update(pushes.revoked, (shops) => [
                      ...shops,
                      revokedShop,
                    ]);
            }
            if (name === "setBillingCycle")
              return (_shop: string, input: Domain.BillingCycleInput) =>
                pushes === undefined
                  ? Effect.void
                  : Ref.update(pushes.cycles, (cycles) => [...cycles, input]);
            if (name === "reconcileUsage")
              return (_shop: string, input: Domain.ReconcileUsageInput) =>
                pushes === undefined
                  ? Effect.void
                  : Ref.update(pushes.reconciled, (seen) => [
                      ...seen,
                      input.quantity,
                    ]);
            return () =>
              Effect.die(`ShopAgentClient.${String(name)} not stubbed`);
          },
        }),
      ),
    ]),
  );

const activeProAtFutureBoundary = () =>
  Effect.succeed(
    Option.some(contract({ handle: "baton-pro", boundaryAt: 601_000 })),
  );

const activeProAtPastBoundary = () =>
  Effect.succeed(
    Option.some(contract({ handle: "baton-pro", boundaryAt: 600_000 })),
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
            assert.deepStrictEqual(
              yield* plan.resolve(shop),
              subscribedTo("baton-pro"),
            );
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
            Effect.as(Option.some(contract({ handle: "baton-basic" }))),
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
              assert.deepStrictEqual(
                yield* plan.resolve(shop),
                subscribedTo("baton-basic"),
              );
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

  it.effect("caches the boundary and the cycle it names", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () =>
          Effect.succeed(
            Option.some(
              contract({
                handle: "baton-pro",
                boundaryAt: 601_000,
                cycleStartAt: 500,
              }),
            ),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          assert.deepStrictEqual(
            yield* (yield* SubscriptionPlan).resolve(shop),
            subscribedTo("baton-pro", { boundaryAt: 601_000 }),
          );
          const stored = Option.getOrThrow(
            yield* (yield* Repository).findShopSession(shop),
          );
          assert.strictEqual(stored.planBoundaryAt, 601_000);
          assert.strictEqual(stored.planCycleStartAt, 500);
        }),
        { pushes },
      );
    }),
  );

  it.effect("serves the cached boundary without revalidating", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const calls = yield* Ref.make(0);
      yield* run(
        () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(Option.none<Domain.ActiveSubscription>()),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 2000, {
            planBoundaryAt: 601_000,
          });
          assert.deepStrictEqual(
            yield* (yield* SubscriptionPlan).resolve(shop),
            subscribedTo("baton-pro", { boundaryAt: 601_000 }),
          );
        }),
      );
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );

  it.effect(
    "revokes the shop's connections when the cached plan changes tier",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const pushes = yield* makePushes;
        yield* run(
          () =>
            Effect.succeed(Option.some(contract({ handle: "baton-basic" }))),
          Effect.gen(function* () {
            yield* seedShopSession("baton-pro", 500);
            assert.deepStrictEqual(
              yield* (yield* SubscriptionPlan).resolve(shop),
              subscribedTo("baton-basic"),
            );
          }),
          { pushes },
        );
        assert.deepStrictEqual(yield* Ref.get(pushes.revoked), [shop]);
      }),
  );

  it.effect("revokes the shop's connections when a cached plan lapses", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () => Effect.succeed(Option.none<Domain.ActiveSubscription>()),
        Effect.gen(function* () {
          const plan = yield* SubscriptionPlan;
          yield* seedShopSession("baton-pro", 500);
          assert.deepStrictEqual(yield* plan.resolve(shop), {
            _tag: "Unsubscribed",
          });
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.revoked), [shop]);
    }),
  );

  it.effect("does not revoke on first fetch", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () => Effect.succeed(Option.some(contract({ handle: "baton-pro" }))),
        Effect.gen(function* () {
          yield* seedShopSession(null, null);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.revoked), []);
    }),
  );

  it.effect("does not revoke when the shop was already unsubscribed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () => Effect.succeed(Option.none<Domain.ActiveSubscription>()),
        Effect.gen(function* () {
          const plan = yield* SubscriptionPlan;
          // Expired verified absence: revalidates, lands on null again.
          yield* seedShopSession(null, 500);
          yield* plan.resolve(shop);
          // Never cached: nothing to compare.
          yield* seedShopSession(null, null);
          yield* plan.resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.revoked), []);
    }),
  );

  it.effect("does not revoke when the plan is still active", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        activeProAtFutureBoundary,
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.revoked), []);
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

  it.effect("pushes the billing cycle to the object on revalidation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () =>
          Effect.succeed(
            Option.some(
              contract({
                handle: "baton-pro",
                boundaryAt: 601_000,
                cycleStartAt: 500,
              }),
            ),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.cycles), [
        { shopGid, cycleStartAt: 500, cycleEndAt: 601_000 },
      ]);
    }),
  );

  it.effect("pushes no billing cycle during a trial, which has none", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () =>
          Effect.succeed(
            Option.some(contract({ handle: "baton-pro", boundaryAt: 601_000 })),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.cycles), []);
    }),
  );

  it.effect("reconciles the usage figure on revalidation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () =>
          Effect.succeed(
            Option.some(
              contract({
                handle: "baton-pro",
                cycleStartAt: 500,
                usageQuantity: 42,
              }),
            ),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.reconciled), [42]);
    }),
  );

  it.effect("reconciles nothing when the contract carries no meter", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () =>
          Effect.succeed(
            Option.some(contract({ handle: "baton-pro", cycleStartAt: 500 })),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.reconciled), []);
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
    "expectChange shortens the deadline but never extends it or writes a never-fetched row",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        yield* run(
          () => Effect.succeed(Option.none<Domain.ActiveSubscription>()),
          Effect.gen(function* () {
            const repository = yield* Repository;
            const plan = yield* SubscriptionPlan;
            const deadline = () =>
              Effect.map(
                repository.findShopSession(shop),
                (session) => Option.getOrThrow(session).planHandleExpiresAt,
              );
            // Far future: pulled forward to now + the manage window.
            yield* seedShopSession("baton-pro", 86_401_000);
            yield* plan.expectChange(shop);
            assert.strictEqual(yield* deadline(), 901_000);
            // Already sooner: left alone.
            yield* seedShopSession("baton-pro", 2000);
            yield* plan.expectChange(shop);
            assert.strictEqual(yield* deadline(), 2000);
            // Never fetched: stays never fetched.
            yield* seedShopSession(null, null);
            yield* plan.expectChange(shop);
            assert.strictEqual(yield* deadline(), null);
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

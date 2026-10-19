import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { MembershipRepository } from "../../../src/backend/membership-repository.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import { ShopSessionRepository } from "../../../src/backend/shop-session-repository.ts";
import { ShopifyPartner, ShopifyPartnerError } from "../../../src/backend/shopify-partner.ts";
import {
  revalidateStalePlans,
  SubscriptionPlan,
  SubscriptionPlanError,
} from "../../../src/backend/subscription-plan.ts";
import { ShopKey } from "../../../src/contract/shop.ts";
import {
  type AppSubscription,
  type BillingCycleInput,
  type PlanHandle,
  type PlanStatus,
  planOfHandle,
} from "../../../src/domain/billing.ts";
import { Email, ShopGid } from "../../../src/domain/platform.ts";
import { makeD1Test, QuietLogs } from "./layers.ts";

/**
 * `SubscriptionPlan` over the real `ShopSessionRepository` and `MembershipRepository` on a fresh
 * in-memory D1, a stub `ShopifyPartner` and a recording `ShopActors`, under `TestClock`: legacy
 * `subscription-plan.test.ts`'s cases, titles unchanged. What this file owns is *when* the plan
 * revokes or pushes a cycle; the actor's tests own what a revoke or a push does.
 */
const shop = Schema.decodeUnknownSync(ShopKey)("plan.myshopify.com");
const shopGid = Schema.decodeUnknownSync(ShopGid)("gid://shopify/Shop/1");
const shopKey = Schema.decodeUnknownSync(ShopKey);

const shopSession = (key: ShopKey = shop, gid: string = shopGid) => ({
  shop: key,
  shopGid: gid,
  shopActorId: key,
  scope: "read_products",
  accessTokenExpiresAt: 1000,
  accessToken: "shpat_x",
  refreshToken: "shprt_x",
  refreshTokenExpiresAt: 2000,
});

const seedShopSession = (
  planHandle: string | null,
  expiresAt: number | null,
  cached: { readonly planBoundaryAt?: number | null } = {},
) =>
  Effect.gen(function* () {
    const sessions = yield* ShopSessionRepository;
    yield* sessions.upsert(shopSession());
    yield* sessions.updatePlan({
      shop,
      planHandle,
      planHandleExpiresAt: expiresAt,
      planBoundaryAt: cached.planBoundaryAt ?? null,
    });
  });

const stored = (key: ShopKey = shop) =>
  Effect.flatMap(ShopSessionRepository, (sessions) =>
    Effect.map(sessions.find(key), Option.getOrThrow),
  );

/** An app subscription with no boundary, which is what most cases are about. */
const appSubscription = (
  overrides: Partial<AppSubscription> & { readonly handle: PlanHandle },
): AppSubscription => ({
  boundaryAt: null,
  cycleStartAt: null,
  ...overrides,
});

/** The `Subscribed` status such an app subscription resolves to. */
const subscribedTo = (
  handle: PlanHandle,
  overrides: Partial<Extract<PlanStatus, { _tag: "Subscribed" }>> = {},
) => ({
  _tag: "Subscribed" as const,
  handle,
  plan: planOfHandle(handle),
  boundaryAt: null,
  ...overrides,
});

/** What the actors were told, so a case can assert the pushes without an actor. */
interface Pushes {
  readonly revoked: Ref.Ref<ReadonlyArray<string>>;
  readonly cycles: Ref.Ref<ReadonlyArray<BillingCycleInput>>;
  readonly flushed: Ref.Ref<ReadonlyArray<string>>;
}

const makePushes = Effect.gen(function* () {
  return {
    revoked: yield* Ref.make<ReadonlyArray<string>>([]),
    cycles: yield* Ref.make<ReadonlyArray<BillingCycleInput>>([]),
    flushed: yield* Ref.make<ReadonlyArray<string>>([]),
  } satisfies Pushes;
});

/** {@link ShopActors.layerTest} recording revokes, cycles and flushes into `pushes`. */
const recordingActors = (pushes: Pushes | undefined, revokeFails: boolean) =>
  Layer.effect(
    ShopActors,
    Effect.gen(function* () {
      const base = yield* ShopActors.pipe(Effect.provide(ShopActors.layerTest([])));
      return ShopActors.of({
        ...base,
        revoke: (key) =>
          revokeFails
            ? Effect.die(new Error("actor unreachable"))
            : pushes === undefined
              ? Effect.succeed({ closed: 0 })
              : Ref.update(pushes.revoked, (shops) => [...shops, key]).pipe(
                  Effect.as({ closed: 0 }),
                ),
        setBillingCycle: (_key, input) =>
          pushes === undefined
            ? Effect.void
            : Ref.update(pushes.cycles, (cycles) => [...cycles, input]),
        flushUsageEvents: (key) =>
          pushes === undefined
            ? Effect.succeed(0)
            : Ref.update(pushes.flushed, (shops) => [...shops, key]).pipe(Effect.as(0)),
      });
    }),
  );

const run = <A, E>(
  activeSubscription: ShopifyPartner["Service"]["activeSubscription"],
  effect: Effect.Effect<A, E, ShopSessionRepository | MembershipRepository | SubscriptionPlan>,
  options: { readonly pushes?: Pushes; readonly revokeFails?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { raw } = yield* makeD1Test;
    return yield* effect.pipe(
      Effect.provide(SubscriptionPlan.layer),
      Effect.provide(
        Layer.mergeAll(
          ShopSessionRepository.layerWith(raw),
          MembershipRepository.layerWith(raw),
          Layer.succeed(
            ShopifyPartner,
            ShopifyPartner.of({
              activeSubscription,
              planSelectionUrl: () => "https://example.com/plans",
            }),
          ),
          recordingActors(options.pushes, options.revokeFails ?? false),
        ),
      ),
      Effect.provide(QuietLogs),
    );
  });

const activeProAtFutureBoundary = () =>
  Effect.succeed(Option.some(appSubscription({ handle: "baton-pro", boundaryAt: 601_000 })));

const activeProAtPastBoundary = () =>
  Effect.succeed(Option.some(appSubscription({ handle: "baton-pro", boundaryAt: 600_000 })));

const failedAppSubscription = () =>
  Effect.fail(new ShopifyPartnerError({ message: "unavailable", cause: new Error("unavailable") }));

const none = () => Effect.succeed(Option.none<AppSubscription>());

describe("SubscriptionPlan", () => {
  it.effect("serves fresh positive and negative entries without revalidation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const calls = yield* Ref.make(0);
      const activeSubscription = () =>
        Ref.update(calls, (count) => count + 1).pipe(Effect.as(Option.none<AppSubscription>()));
      yield* run(
        activeSubscription,
        Effect.gen(function* () {
          const plan = yield* SubscriptionPlan;
          yield* seedShopSession("baton-pro", 2000);
          assert.deepStrictEqual(yield* plan.resolve(shop), subscribedTo("baton-pro"));
          yield* seedShopSession(null, 2000);
          assert.deepStrictEqual(yield* plan.resolve(shop), { _tag: "Unsubscribed" });
        }),
      );
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );

  it.effect("returns unsubscribed for a missing session without revalidation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const activeSubscription = () =>
        Ref.update(calls, (count) => count + 1).pipe(Effect.as(Option.none<AppSubscription>()));
      assert.deepStrictEqual(
        yield* run(
          activeSubscription,
          Effect.flatMap(SubscriptionPlan, (plan) => plan.resolve(shop)),
        ),
        { _tag: "Unsubscribed" },
      );
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );

  it.effect("revalidates expired, never-fetched, and unknown cached entries", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const calls = yield* Ref.make(0);
      const activeSubscription = () =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.as(Option.some(appSubscription({ handle: "baton-basic" }))),
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
            assert.deepStrictEqual(yield* plan.resolve(shop), subscribedTo("baton-basic"));
          }
          const row = yield* stored();
          assert.strictEqual(row.planHandle, "baton-basic");
          assert.strictEqual(row.planHandleExpiresAt, 86_401_000);
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
        Ref.update(calls, (count) => count + 1).pipe(Effect.as(Option.none<AppSubscription>()));
      yield* run(
        activeSubscription,
        Effect.gen(function* () {
          const plan = yield* SubscriptionPlan;
          yield* seedShopSession("baton-pro", 2000);
          assert.deepStrictEqual(yield* plan.refresh(shop), { _tag: "Unsubscribed" });
          const row = yield* stored();
          assert.strictEqual(row.planHandle, null);
          assert.strictEqual(row.planHandleExpiresAt, 86_401_000);
        }),
      );
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("caches the boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () =>
          Effect.succeed(
            Option.some(
              appSubscription({ handle: "baton-pro", boundaryAt: 601_000, cycleStartAt: 500 }),
            ),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          assert.deepStrictEqual(
            yield* (yield* SubscriptionPlan).resolve(shop),
            subscribedTo("baton-pro", { boundaryAt: 601_000 }),
          );
          assert.strictEqual((yield* stored()).planBoundaryAt, 601_000);
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
          Ref.update(calls, (count) => count + 1).pipe(Effect.as(Option.none<AppSubscription>())),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 2000, { planBoundaryAt: 601_000 });
          assert.deepStrictEqual(
            yield* (yield* SubscriptionPlan).resolve(shop),
            subscribedTo("baton-pro", { boundaryAt: 601_000 }),
          );
        }),
      );
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );

  it.effect("revokes the shop's connections when the cached plan changes tier", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () => Effect.succeed(Option.some(appSubscription({ handle: "baton-basic" }))),
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
        none,
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          assert.deepStrictEqual(yield* (yield* SubscriptionPlan).resolve(shop), {
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
        () => Effect.succeed(Option.some(appSubscription({ handle: "baton-pro" }))),
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
        none,
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
        none,
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          assert.deepStrictEqual(yield* (yield* SubscriptionPlan).resolve(shop), {
            _tag: "Unsubscribed",
          });
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
              appSubscription({ handle: "baton-pro", boundaryAt: 601_000, cycleStartAt: 500 }),
            ),
          ),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.cycles), [
        { shopGid, cycleStartAt: 500, cycleEndAt: 601_000, memberCount: 0 },
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
            Option.some(appSubscription({ handle: "baton-pro", boundaryAt: 601_000 })),
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

  it.effect("revalidate pushes the member count with the cycle", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        () =>
          Effect.succeed(Option.some(appSubscription({ handle: "baton-pro", cycleStartAt: 500 }))),
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 500);
          const members = yield* MembershipRepository;
          for (const email of ["a@example.com", "b@example.com"])
            yield* members
              .addMember({ shop, email: Schema.decodeUnknownSync(Email)(email) })
              .pipe(Effect.orDie);
          yield* (yield* SubscriptionPlan).resolve(shop);
        }),
        { pushes },
      );
      assert.deepStrictEqual(
        (yield* Ref.get(pushes.cycles)).map((cycle) => cycle.memberCount),
        [2],
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
          assert.strictEqual((yield* stored()).planHandleExpiresAt, 901_000);
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
          assert.strictEqual((yield* stored()).planHandleExpiresAt, 87_400_000);
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
          none,
          Effect.gen(function* () {
            const plan = yield* SubscriptionPlan;
            const deadline = () => Effect.map(stored(), (row) => row.planHandleExpiresAt);
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

  it.effect("Manage plan sends the usage queue before the plan can change", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const pushes = yield* makePushes;
      yield* run(
        none,
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 86_401_000);
          yield* (yield* SubscriptionPlan).expectChange(shop);
          assert.strictEqual((yield* stored()).planHandleExpiresAt, 901_000);
        }),
        { pushes },
      );
      assert.deepStrictEqual(yield* Ref.get(pushes.flushed), [shop]);
    }),
  );

  it.effect("the daily check re-reads every shop whose cached plan is stale, and only those", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const asked = yield* Ref.make<ReadonlyArray<string>>([]);
      const summary = yield* run(
        (gid) =>
          Ref.update(asked, (gids) => [...gids, gid]).pipe(
            Effect.as(Option.some(appSubscription({ handle: "baton-pro" }))),
          ),
        Effect.gen(function* () {
          const sessions = yield* ShopSessionRepository;
          for (const [name, expiresAt] of [
            ["stale", 10_000],
            ["never", null],
            ["fresh", 10_001],
          ] as const) {
            const each = shopKey(`${name}.myshopify.com`);
            yield* sessions.upsert(shopSession(each, `gid://shopify/Shop/${name}`));
            yield* sessions.updatePlan({
              shop: each,
              planHandle: expiresAt === null ? null : "baton-pro",
              planHandleExpiresAt: expiresAt,
              planBoundaryAt: null,
            });
          }
          return yield* revalidateStalePlans();
        }),
        { pushes: yield* makePushes },
      );
      assert.deepStrictEqual(summary, { shops: 2, failed: 0 });
      assert.deepStrictEqual([...(yield* Ref.get(asked))].toSorted(), [
        "gid://shopify/Shop/never",
        "gid://shopify/Shop/stale",
      ]);
    }),
  );

  it.effect("keeps Partner failures distinct from unsubscribed and preserves cache", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      yield* run(
        failedAppSubscription,
        Effect.gen(function* () {
          yield* seedShopSession("baton-pro", 1000);
          const error = yield* Effect.flip((yield* SubscriptionPlan).resolve(shop));
          assert.instanceOf(error, SubscriptionPlanError);
          const row = yield* stored();
          assert.strictEqual(row.planHandle, "baton-pro");
          assert.strictEqual(row.planHandleExpiresAt, 1000);
        }),
      );
    }),
  );
});

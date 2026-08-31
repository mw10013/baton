import { redirect } from "@tanstack/react-router";
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
} from "effect";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";
import {
  planSelectionExitIframeHref,
  ShopifyPartner,
} from "@/lib/ShopifyPartner";

/**
 * "Could not determine the plan" — always distinct from a determined answer of
 * no plan, which is the `Unsubscribed` success value.
 *
 * One error type collapses three unrelated causes (D1 failure, row decode
 * failure, Partner API failure or timeout) because callers respond to all of
 * them identically and must never respond to any of them the way they respond
 * to `Unsubscribed`: on `/app` this is an error page, on the Flow action path a
 * transient `429`, never a terminal rejection.
 */
export class SubscriptionPlanError extends Schema.TaggedError<SubscriptionPlanError>()(
  "SubscriptionPlanError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * How long a cached plan handle stays fresh when no contract boundary falls
 * sooner.
 *
 * This is a ceiling on ignorance, not a refresh interval. Scheduled changes are
 * caught by the boundary clamp in {@link planHandleExpiresAt} and by the
 * billing redirect forcing a revalidation, so this value only governs the
 * transitions Shopify never announces: a freeze on payment failure, an
 * immediate cancellation, an expiration. App Pricing sends no webhooks — it
 * explicitly directs apps to poll the Partner API for exactly those cases — so
 * this window is their entire detection latency.
 *
 * A day looks long until the two transitions it covers are separated:
 *
 * - **Immediate cancellation (voluntary).** A long window leaks free service,
 *   bounded by the per-shop storage-write ceiling — cents per shop per day.
 *   Nothing is destroyed by waiting; the merchant asked to stop.
 * - **Freeze (involuntary — a declined card).** A long window costs nothing and
 *   buys a grace period, because it is the *only* grace period that exists.
 *   What waits on the far side is a terminal rejection of Flow actions, and a
 *   rejected action is never retried: those writes are lost permanently and the
 *   shop's memory stays diverged after payment resumes.
 *
 * So shortening this buys back cents and pays for them by destroying the data
 * of merchants whose card just bounced. The asymmetry is the argument. What
 * shortening does cost is real but small — one synchronous Partner round trip
 * per expiry, landing on whichever navigation or Flow action finds the entry
 * stale.
 */
const PLAN_HANDLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Grace added past a contract boundary before trusting a revalidation.
 *
 * Expiring exactly at the boundary races Shopify's own transition and can read
 * back the outgoing contract, which would then be cached for a full max age.
 * Landing slightly late costs nothing and reads the settled state.
 */
const PLAN_HANDLE_BOUNDARY_SKEW_MS = 5 * 60 * 1000;

/**
 * The freshness deadline for a revalidation performed at `now`.
 *
 * The boundary clamp is applied unconditionally rather than only when Shopify
 * reports a pending change, and that is what makes it robust: a merchant who
 * schedules a change minutes before their cycle ends — long after our last
 * revalidation — is still caught, because that earlier revalidation already
 * pinned the deadline to the boundary. The boundary does not move within a
 * cycle, so every revalidation re-pins to the same instant.
 *
 * A boundary already in the past is ignored. Honoring it would write a deadline
 * behind `now`, making the entry permanently stale and turning every subsequent
 * request into a Partner API call.
 */
const planHandleExpiresAt = (now: number, boundaryAt: number | null): number =>
  boundaryAt !== null && boundaryAt + PLAN_HANDLE_BOUNDARY_SKEW_MS > now
    ? Math.min(
        now + PLAN_HANDLE_MAX_AGE_MS,
        boundaryAt + PLAN_HANDLE_BOUNDARY_SKEW_MS,
      )
    : now + PLAN_HANDLE_MAX_AGE_MS;

const Unsubscribed = {
  _tag: "Unsubscribed",
} as const satisfies Domain.PlanStatus;

const subscribed = (handle: Domain.PlanHandle) =>
  ({
    _tag: "Subscribed",
    handle,
    plan: Domain.planOfHandle(handle),
  }) as const satisfies Domain.PlanStatus;

const decodePlanHandle = Schema.decodeUnknownOption(Domain.PlanHandle);

/**
 * Reads the cached entry, or `Option.none()` when it cannot be trusted.
 *
 * Three inputs collapse into a miss: never fetched, past its deadline, or
 * carrying a handle outside the current allowlist. The last is the reason the
 * column stores a plain string — a handle this build no longer recognizes means
 * the catalog moved, and moving the entry back to Shopify is the only honest
 * response. A null handle inside the deadline is not a miss: it is a verified
 * absence of any contract.
 */
const cachedStatus = (
  shopSession: Domain.ShopSession,
  now: number,
): Option.Option<Domain.PlanStatus> => {
  if (
    shopSession.planHandleExpiresAt === null ||
    now >= shopSession.planHandleExpiresAt
  )
    return Option.none();
  return shopSession.planHandle === null
    ? Option.some(Unsubscribed)
    : Option.map(decodePlanHandle(shopSession.planHandle), subscribed);
};

export class SubscriptionPlan extends Context.Service<
  SubscriptionPlan,
  {
    /**
     * The shop's plan, from cache when fresh and from Shopify when not.
     *
     * A shop with no `ShopSession` row resolves to `Unsubscribed` without touching
     * Shopify: uninstall deletes the row, so its absence means the app is not
     * installed, which grants no more access than an absent contract does.
     */
    readonly resolve: (
      shop: Domain.Shop,
    ) => Effect.Effect<Domain.PlanStatus, SubscriptionPlanError>;
    /**
     * Revalidates unconditionally, ignoring any fresh entry.
     *
     * For the billing redirect, whose `plan_handle` parameter announces that
     * the contract just changed. The parameter triggers the refresh and is
     * never itself stored — Shopify directs apps to confirm subscription status
     * against the Partner API when handling that redirect, and this is also
     * what lets a single max age serve the no-plan case: a merchant who just
     * subscribed arrives here rather than waiting out a cache entry.
     */
    readonly refresh: (
      shop: Domain.Shop,
    ) => Effect.Effect<Domain.PlanStatus, SubscriptionPlanError>;
  }
>()("SubscriptionPlan") {
  /**
   * Billing is off until the app has real plans in Partners.
   *
   * `BILLING_ENABLED=false` short-circuits both methods to
   * {@link Domain.DEFAULT_PLAN_HANDLE} without a Partner API call or a cache
   * write, so every gate downstream — the `/app` boundary, the WebSocket
   * connect check, `resolveEntitlements` — keeps running in its real shape and
   * simply always passes. Nothing is stubbed out at the call sites, so turning
   * billing on is one var, not a diff.
   *
   * The bypass is deliberately unconditional on environment: a var that grants
   * access must be read the same way in production as locally, or the one place
   * it matters is the place it was never exercised. Set it to `true` in
   * `wrangler.jsonc` once the plans exist.
   */
  static readonly layerNoDeps: Layer.Layer<
    SubscriptionPlan,
    Config.ConfigError,
    Repository | ShopifyPartner
  > = Layer.effect(
    SubscriptionPlan,
    Effect.gen(function* () {
      const repository = yield* Repository;
      const shopifyPartner = yield* ShopifyPartner;
      const billingEnabled = yield* Config.boolean("BILLING_ENABLED").pipe(
        Config.withDefault(false),
      );
      if (!billingEnabled) {
        const granted = Effect.succeed(subscribed(Domain.DEFAULT_PLAN_HANDLE));
        yield* Effect.logInfo(
          "SubscriptionPlan: billing disabled, granting default plan",
        ).pipe(Effect.annotateLogs({ handle: Domain.DEFAULT_PLAN_HANDLE }));
        return SubscriptionPlan.of({
          resolve: () => granted,
          refresh: () => granted,
        });
      }

      const planError = (message: string) => (cause: unknown) =>
        new SubscriptionPlanError({ message, cause });

      const revalidate = Effect.fn("SubscriptionPlan.revalidate")(function* (
        shopSession: Domain.ShopSession,
      ) {
        const active = yield* shopifyPartner
          .activeSubscription(shopSession.shopGid)
          .pipe(
            Effect.mapError(
              planError(`Plan revalidation failed for ${shopSession.shop}`),
            ),
          );
        const now = yield* Clock.currentTimeMillis;
        const handle = Option.match(active, {
          onNone: () => null,
          onSome: ({ handle }) => handle,
        });
        yield* repository
          .updateShopSessionPlan({
            shop: shopSession.shop,
            planHandle: handle,
            planHandleExpiresAt: planHandleExpiresAt(
              now,
              Option.match(active, {
                onNone: () => null,
                onSome: ({ boundaryAt }) => boundaryAt,
              }),
            ),
          })
          .pipe(
            Effect.mapError(
              planError(`Plan cache write failed for ${shopSession.shop}`),
            ),
          );
        yield* Effect.logDebug(
          `SubscriptionPlan.revalidate: shop=${shopSession.shop} handle=${handle ?? "none"}`,
        ).pipe(Effect.annotateLogs({ shop: shopSession.shop, handle }));
        return Option.match(active, {
          onNone: () => Unsubscribed,
          onSome: ({ handle }) => subscribed(handle),
        });
      });

      const findShopSession = (shop: Domain.Shop) =>
        repository
          .findShopSession(shop)
          .pipe(
            Effect.mapError(planError(`ShopSession lookup failed for ${shop}`)),
          );

      const resolve = Effect.fn("SubscriptionPlan.resolve")(function* (
        shop: Domain.Shop,
      ) {
        const shopSession = yield* findShopSession(shop);
        if (Option.isNone(shopSession)) return Unsubscribed;
        const cached = cachedStatus(
          shopSession.value,
          yield* Clock.currentTimeMillis,
        );
        return Option.isSome(cached)
          ? cached.value
          : yield* revalidate(shopSession.value);
      });

      const refresh = Effect.fn("SubscriptionPlan.refresh")(function* (
        shop: Domain.Shop,
      ) {
        const shopSession = yield* findShopSession(shop);
        return Option.isNone(shopSession)
          ? Unsubscribed
          : yield* revalidate(shopSession.value);
      });

      return SubscriptionPlan.of({ resolve, refresh });
    }),
  );
}

/**
 * The shop's entitlements for *this* request, or a redirect to plan selection.
 *
 * For the `/app` loaders whose server functions run on their own request. The
 * `/app` route boundary already gated the document load, but on client-side
 * navigation a loader's server function is a separate request, and the cached
 * plan entry can expire between the two — so the `Unsubscribed` arm is a live
 * path, not defensive padding.
 *
 * Resolving here rather than reading the plan out of route context is
 * deliberate: `beforeLoad` returns it into context, but a child loader is
 * isomorphic and runs *in the browser* on every in-app navigation, so passing
 * it down would mean the browser naming its own tier on the majority of page
 * views. Display-only today, and exactly the shape that gets copied to an
 * enforcement path later.
 *
 * The cost is one extra cached D1 read per page view — `authenticateAppRoute`
 * resolves in `beforeLoad` and this resolves again. If a third UI path ever
 * needs it, memoize per request; do not thread the value through the client.
 */
export const resolveEntitlements = Effect.fn("resolveEntitlements")(function* (
  shop: Domain.Shop,
) {
  return yield* Match.value(
    yield* (yield* SubscriptionPlan).resolve(shop),
  ).pipe(
    Match.tagsExhaustive({
      Subscribed: ({ plan }) => Effect.succeed(Domain.entitlementsOfPlan(plan)),
      Unsubscribed: () =>
        Effect.gen(function* () {
          const shopifyPartner = yield* ShopifyPartner;
          return yield* Effect.fail(
            redirect({
              href: planSelectionExitIframeHref(
                shopifyPartner.planSelectionUrl(shop),
                shop,
              ),
            }),
          );
        }),
    }),
  );
});

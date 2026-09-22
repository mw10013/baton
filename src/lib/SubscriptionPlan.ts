import { redirect } from "@tanstack/react-router";
import { Clock, Context, Effect, Layer, Match, Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
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
 * to `Unsubscribed`: an embedded navigation gets an error page rather than the
 * billing redirect `/app` sends an unsubscribed shop to, and a socket connect
 * is refused as a transient failure rather than with the merchant gate's
 * `402`, which closes the tab's socket for good (`worker.ts`). "We could not
 * ask" must never be answered as "you have not paid".
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
 * This is a ceiling on ignorance, not a refresh interval. Plan changes are
 * caught by the billing redirect forcing a revalidation, and cycle rolls by
 * the boundary clamp in {@link planHandleExpiresAt}, so this value only governs the
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
 *   What waits on the far side is a `402` on every socket and a billing
 *   redirect on every navigation: the shop's makers are locked out of the
 *   production floor mid-shift, with work in progress they cannot record,
 *   over a card their merchant has not been told about yet.
 *
 * So shortening this buys back cents and pays for them by stopping the floor
 * of merchants whose card just bounced. The asymmetry is the argument. What
 * shortening does cost is real but small — one synchronous Partner round trip
 * per expiry, landing on whichever navigation or socket connect finds the
 * entry stale.
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
 * How long the cache stays fresh after the merchant opens the plan selection
 * page.
 *
 * The billing redirect back into `/app` carries `plan_handle` and forces a
 * revalidation, so in the happy path this window is never used. It exists for
 * the redirect that is lost — the merchant closes the tab, the navigation dies,
 * the admin swallows it — where the only other signal is
 * {@link PLAN_HANDLE_MAX_AGE_MS}, and a merchant who has just paid for an
 * upgrade should not spend a day on the old tier. It bounds that to minutes and
 * costs one Partner call per Manage plan click, which is a click a merchant
 * makes a handful of times in the life of a shop.
 */
const PLAN_HANDLE_MANAGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * The freshness deadline for a revalidation performed at `now`.
 *
 * The deadline is clamped to the contract boundary because the contract
 * changes there with no plan change and no redirect: the billing cycle rolls,
 * or a trial ends and the first cycle begins. The revalidation after it reads
 * the new cycle and pushes it to `ShopAgent.setBillingCycle`, which restarts
 * order counting. The boundary does not move within a cycle, so every
 * revalidation re-pins to the same instant.
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

const decodePlanHandle = Schema.decodeUnknownOption(Domain.PlanHandle);

/**
 * The one place a `Subscribed` status is built, so the cached path and the
 * revalidated path cannot drift about what a contract is.
 */
const subscribed = (input: {
  readonly handle: Domain.PlanHandle;
  readonly boundaryAt: number | null;
}) =>
  ({
    _tag: "Subscribed",
    handle: input.handle,
    plan: Domain.planOfHandle(input.handle),
    boundaryAt: input.boundaryAt,
  }) as const satisfies Domain.PlanStatus;

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
    : Option.map(decodePlanHandle(shopSession.planHandle), (handle) =>
        subscribed({ handle, boundaryAt: shopSession.planBoundaryAt }),
      );
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
    /**
     * Announces that the merchant is about to change their plan, by pulling the
     * cache deadline forward to {@link PLAN_HANDLE_MANAGE_WINDOW_MS}.
     *
     * Called as the Manage plan button is clicked, not after: the merchant
     * leaves the iframe for `admin.shopify.com` and may never come back through
     * the redirect that would otherwise force the revalidation. Never extends a
     * deadline and never writes a never-fetched row, so calling it on a shop
     * that then changes nothing costs one Partner call at worst.
     */
    readonly expectChange: (
      shop: Domain.Shop,
    ) => Effect.Effect<void, SubscriptionPlanError>;
  }
>()("SubscriptionPlan") {
  /**
   * Needs the repository for the cached plan row, the Partner client for
   * revalidation, and the `ShopAgent` client for revoking sockets on lapse.
   */
  static readonly layerNoDeps: Layer.Layer<
    SubscriptionPlan,
    never,
    Repository | ShopifyPartner | ShopAgentClient
  > = Layer.effect(
    SubscriptionPlan,
    Effect.gen(function* () {
      const repository = yield* Repository;
      const shopifyPartner = yield* ShopifyPartner;
      const shopAgentClient = yield* ShopAgentClient;

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
        const contract = Option.getOrNull(active);
        const handle = contract?.handle ?? null;
        yield* repository
          .updateShopSessionPlan({
            shop: shopSession.shop,
            planHandle: handle,
            planHandleExpiresAt: planHandleExpiresAt(
              now,
              contract?.boundaryAt ?? null,
            ),
            planBoundaryAt: contract?.boundaryAt ?? null,
            planCycleStartAt: contract?.cycleStartAt ?? null,
          })
          .pipe(
            Effect.mapError(
              planError(`Plan cache write failed for ${shopSession.shop}`),
            ),
          );
        yield* Effect.logDebug(
          `SubscriptionPlan.revalidate: shop=${shopSession.shop} handle=${handle ?? "none"}`,
        ).pipe(Effect.annotateLogs({ shop: shopSession.shop, handle }));
        // Revoke on any change of handle, not only on a lapse. Every socket
        // gate checks the plan at connect only, and the keepalive keeps a
        // socket open indefinitely, so a change the cache has just learned
        // about would otherwise never reach an open tab. Closing the shop's
        // connections makes each reconnect ask the gate again, which now
        // answers with the new plan: a lapse becomes `402`, and a downgrade
        // that leaves a member outside `Domain.memberHasSeat` becomes `402`
        // for that member while every seated member reconnects and passes.
        //
        // A never-cached row is excluded explicitly: without that, the very
        // first resolve of every shop would look like a change and revoke the
        // connections of a merchant whose plan did not move. Failure is
        // logged, not raised — the plan answer is correct regardless.
        const firstFetch =
          shopSession.planHandle === null &&
          shopSession.planHandleExpiresAt === null;
        if (!firstFetch && handle !== shopSession.planHandle)
          yield* shopAgentClient.revokeAllConnections(shopSession.shop).pipe(
            Effect.ignore({
              log: "Warn",
              message: `SubscriptionPlan.revalidate: shop=${shopSession.shop}: revoke on plan change failed`,
            }),
          );
        if (contract === null) return Unsubscribed;
        // The object counts orders against the cycle and meters them, so it
        // needs the period; it still learns nothing about the plan itself.
        // Both pushes are best-effort for the same reason the revoke is: the
        // plan answer this function exists to give is correct regardless, and
        // the next revalidation retries.
        if (contract.cycleStartAt !== null)
          yield* shopAgentClient
            .setBillingCycle(shopSession.shop, {
              shopGid: shopSession.shopGid,
              cycleStartAt: contract.cycleStartAt,
              cycleEndAt: contract.boundaryAt,
            })
            .pipe(
              Effect.ignore({
                log: "Warn",
                message: `SubscriptionPlan.revalidate: shop=${shopSession.shop}: billing cycle push failed`,
              }),
            );
        if (contract.usageQuantity !== null)
          yield* shopAgentClient
            .reconcileUsage(shopSession.shop, {
              quantity: contract.usageQuantity,
            })
            .pipe(
              Effect.ignore({
                log: "Warn",
                message: `SubscriptionPlan.revalidate: shop=${shopSession.shop}: usage reconciliation failed`,
              }),
            );
        return subscribed({
          handle: contract.handle,
          boundaryAt: contract.boundaryAt,
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

      const expectChange = Effect.fn("SubscriptionPlan.expectChange")(
        function* (shop: Domain.Shop) {
          yield* repository
            .shortenShopSessionPlanExpiry({
              shop,
              notAfter:
                (yield* Clock.currentTimeMillis) + PLAN_HANDLE_MANAGE_WINDOW_MS,
            })
            .pipe(
              Effect.mapError(
                planError(`Plan cache deadline write failed for ${shop}`),
              ),
            );
        },
      );

      return SubscriptionPlan.of({ resolve, refresh, expectChange });
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
 * resolves in `beforeLoad` and this resolves again. A loader that needs more
 * than the entitlements off the status resolves once and calls
 * {@link entitlementsOfStatus} rather than paying a third read.
 */
export const resolveEntitlements = Effect.fn("resolveEntitlements")(function* (
  shop: Domain.Shop,
) {
  return yield* entitlementsOfStatus(
    shop,
    yield* (yield* SubscriptionPlan).resolve(shop),
  );
});

/**
 * The `Unsubscribed` arm of {@link resolveEntitlements}, split out so a loader
 * that already holds the resolved status for another reason (the home page
 * reads the boundary off it) can take the entitlements from the same
 * read instead of resolving twice. The redirect lives here once.
 */
export const entitlementsOfStatus = Effect.fn("entitlementsOfStatus")(
  function* (shop: Domain.Shop, status: Domain.PlanStatus) {
    return yield* Match.value(status).pipe(
      Match.tagsExhaustive({
        Subscribed: ({ plan }) =>
          Effect.succeed(Domain.entitlementsOfPlan(plan)),
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
  },
);

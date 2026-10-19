import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PlanUnsubscribed } from "../contract/billing.ts";
import type { ShopKey } from "../contract/shop.ts";
import {
  type Entitlements,
  entitlementsOfPlan,
  type PlanHandle,
  PlanHandle as PlanHandleSchema,
  planOfHandle,
  type PlanStatus,
} from "../domain/billing.ts";
import { ShopGid } from "../domain/platform.ts";
import { MembershipRepository } from "./membership-repository.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopSessionRepository, type ShopSessionRow } from "./shop-session-repository.ts";
import { planSelectionExitIframeHref, ShopifyPartner } from "./shopify-partner.ts";

/**
 * "Could not determine the plan" — always distinct from a determined answer of
 * no plan, which is the `Unsubscribed` success value.
 *
 * One error type collapses three unrelated causes (D1 failure, row decode
 * failure, Partner API failure or timeout) because callers respond to all of
 * them identically and must never respond to any of them the way they respond
 * to `Unsubscribed`: an embedded navigation gets an error page rather than the
 * billing redirect `/app` sends an unsubscribed shop to, and a socket connect
 * is refused as a transient failure (`503`) rather than with the gate's
 * `402`, which closes the tab's socket for good. "We could not
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
 * How long a cached plan handle stays fresh when no app subscription boundary
 * falls sooner.
 *
 * This is a ceiling on ignorance, not a refresh interval. Plan changes are
 * caught by the billing redirect forcing a revalidation, and cycle rolls by
 * the boundary clamp in {@link planHandleExpiresAt}, so this value only governs the
 * transitions Shopify never announces: a freeze on payment failure, an
 * immediate cancellation, an expiration. App Pricing sends no webhooks — it
 * explicitly directs apps to poll the Partner API for exactly those cases — so
 * this window is their entire detection latency.
 *
 * An expired entry is re-read by whichever navigation or socket connect finds
 * it stale, and for a shop nobody opens, by the daily check
 * ({@link revalidateStalePlans}). So a quiet shop re-reads within a day of
 * its entry expiring, and an entry expires at its cycle's end at the latest:
 * the daily check, not a page load, is what bounds a quiet shop.
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
 *   shop's work mid-shift, with work in progress they cannot record,
 *   over a card their merchant has not been told about yet.
 *
 * So shortening this buys back cents and pays for them by stopping the floor
 * of merchants whose card just bounced. The asymmetry is the argument. What
 * shortening does cost is real but small — one synchronous Partner round trip
 * per expiry, landing on whichever navigation or socket connect finds the
 * entry stale.
 */
export const PLAN_HANDLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Grace added past an app subscription boundary before trusting a revalidation.
 *
 * Expiring exactly at the boundary races Shopify's own transition and can read
 * back the outgoing app subscription, which would then be cached for a full max
 * age. Landing slightly late costs nothing and reads the settled state.
 */
export const PLAN_HANDLE_BOUNDARY_SKEW_MS = 5 * 60 * 1000;

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
export const PLAN_HANDLE_MANAGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * The freshness deadline for a revalidation performed at `now`.
 *
 * The deadline is clamped to the app subscription boundary because the app
 * subscription changes there with no plan change and no redirect: the billing
 * cycle rolls, or a trial ends and the first cycle begins. The revalidation
 * after it reads the new cycle and pushes it, with the member count, to
 * `ShopActors.setBillingCycle`, which restarts order counting and the seat mark.
 * The boundary does not move within a cycle, so every revalidation re-pins to
 * the same instant.
 *
 * A boundary already in the past is ignored. Honoring it would write a deadline
 * behind `now`, making the entry permanently stale and turning every subsequent
 * request into a Partner API call.
 */
export const planHandleExpiresAt = (now: number, boundaryAt: number | null): number =>
  boundaryAt !== null && boundaryAt + PLAN_HANDLE_BOUNDARY_SKEW_MS > now
    ? Math.min(now + PLAN_HANDLE_MAX_AGE_MS, boundaryAt + PLAN_HANDLE_BOUNDARY_SKEW_MS)
    : now + PLAN_HANDLE_MAX_AGE_MS;

const Unsubscribed = {
  _tag: "Unsubscribed",
} as const satisfies PlanStatus;

const decodePlanHandle = Schema.decodeUnknownOption(PlanHandleSchema);
const decodeShopGid = Schema.decodeUnknownEffect(ShopGid);

/**
 * The one place a `Subscribed` status is built, so the cached path and the
 * revalidated path cannot drift about what an app subscription is.
 */
const subscribed = (input: { readonly handle: PlanHandle; readonly boundaryAt: number | null }) =>
  ({
    _tag: "Subscribed",
    handle: input.handle,
    plan: planOfHandle(input.handle),
    boundaryAt: input.boundaryAt,
  }) as const satisfies PlanStatus;

/**
 * Reads the cached entry, or `Option.none()` when it cannot be trusted.
 *
 * Three inputs collapse into a miss: never fetched, past its deadline, or
 * carrying a handle outside the current allowlist. The last is the reason the
 * column stores a plain string — a handle this build no longer recognizes means
 * the catalog moved, and moving the entry back to Shopify is the only honest
 * response. A null handle inside the deadline is not a miss: it is a verified
 * absence of any app subscription.
 */
export const cachedStatus = (
  shopSession: Pick<ShopSessionRow, "planHandle" | "planHandleExpiresAt" | "planBoundaryAt">,
  now: number,
): Option.Option<PlanStatus> => {
  if (shopSession.planHandleExpiresAt === null || now >= shopSession.planHandleExpiresAt)
    return Option.none();
  return shopSession.planHandle === null
    ? Option.some(Unsubscribed)
    : Option.map(decodePlanHandle(shopSession.planHandle), (handle) =>
        subscribed({ handle, boundaryAt: shopSession.planBoundaryAt }),
      );
};

/** A cause as one line per error, for a log line that must not carry a stack. */
const causeMessage = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) =>
      error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message,
    )
    .join("\n");

const make = Effect.gen(function* () {
  const shopSessions = yield* ShopSessionRepository;
  const shopifyPartner = yield* ShopifyPartner;
  const actors = yield* ShopActors;
  const members = yield* MembershipRepository;

  const planError = (message: string) => (cause: unknown) =>
    new SubscriptionPlanError({ message, cause });

  /**
   * A D1 read or write. The repositories die on a D1 or decode failure; here that is the
   * plan's "could not ask", so the defect becomes {@link SubscriptionPlanError}.
   */
  const d1 = <A>(effect: Effect.Effect<A>, message: string) =>
    effect.pipe(Effect.catchDefect((cause) => Effect.fail(planError(message)(cause))));

  const revalidate = Effect.fn("SubscriptionPlan.revalidate")(function* (
    shopSession: ShopSessionRow,
  ) {
    const active = yield* shopifyPartner
      .activeSubscription(shopSession.shopGid)
      .pipe(Effect.mapError(planError(`Plan revalidation failed for ${shopSession.shop}`)));
    const now = yield* Clock.currentTimeMillis;
    const appSubscription = Option.getOrNull(active);
    const handle = appSubscription?.handle ?? null;
    yield* d1(
      shopSessions.updatePlan({
        shop: shopSession.shop,
        planHandle: handle,
        planHandleExpiresAt: planHandleExpiresAt(now, appSubscription?.boundaryAt ?? null),
        planBoundaryAt: appSubscription?.boundaryAt ?? null,
      }),
      `Plan cache write failed for ${shopSession.shop}`,
    );
    yield* Effect.logDebug(
      `SubscriptionPlan.revalidate: shop=${shopSession.shop} handle=${handle ?? "none"}`,
    ).pipe(Effect.annotateLogs({ shop: shopSession.shop, handle }));
    // Revoke on any change of handle, not only on a lapse. Every socket
    // gate checks the plan at connect only, and the keepalive keeps a
    // socket open indefinitely, so a change the cache has just learned
    // about would otherwise never reach an open tab. Closing the shop's
    // connections makes each reconnect ask the gate again, which now
    // answers with the new plan: a lapse becomes `402`.
    //
    // A never-cached row is excluded explicitly: without that, the very
    // first resolve of every shop would look like a change and revoke the
    // connections of a merchant whose plan did not move. Failure is
    // logged, not raised — the plan answer is correct regardless.
    const firstFetch = shopSession.planHandle === null && shopSession.planHandleExpiresAt === null;
    if (!firstFetch && handle !== shopSession.planHandle)
      yield* actors
        .revoke(shopSession.shop, { by: "all" })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `SubscriptionPlan.revalidate: shop=${shopSession.shop}: revoke on plan change failed`,
              cause,
            ).pipe(Effect.annotateLogs({ shop: shopSession.shop })),
          ),
        );
    if (appSubscription === null) return Unsubscribed;
    // The actor counts orders against the cycle and meters them and the
    // seats, so it needs the billing cycle and the member count (the members are
    // D1's); it still learns nothing about the plan itself. The pushes
    // are best-effort for the same reason the revoke is: the plan answer
    // this function exists to give is correct regardless, and the next
    // revalidation retries.
    const cycleStartAt = appSubscription.cycleStartAt;
    if (cycleStartAt !== null)
      yield* Effect.gen(function* () {
        yield* actors.setBillingCycle(shopSession.shop, {
          shopGid: yield* decodeShopGid(shopSession.shopGid),
          cycleStartAt,
          cycleEndAt: appSubscription.boundaryAt,
          memberCount: yield* members.countMembers(shopSession.shop),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `SubscriptionPlan.revalidate: shop=${shopSession.shop}: billing cycle push failed`,
            cause,
          ).pipe(Effect.annotateLogs({ shop: shopSession.shop })),
        ),
      );
    return subscribed({
      handle: appSubscription.handle,
      boundaryAt: appSubscription.boundaryAt,
    });
  });

  const findShopSession = (shop: ShopKey) =>
    d1(shopSessions.find(shop), `ShopSession lookup failed for ${shop}`);

  const resolve = Effect.fn("SubscriptionPlan.resolve")(function* (shop: ShopKey) {
    const shopSession = yield* findShopSession(shop);
    if (Option.isNone(shopSession)) return Unsubscribed;
    const cached = cachedStatus(shopSession.value, yield* Clock.currentTimeMillis);
    return Option.isSome(cached) ? cached.value : yield* revalidate(shopSession.value);
  });

  const refresh = Effect.fn("SubscriptionPlan.refresh")(function* (shop: ShopKey) {
    const shopSession = yield* findShopSession(shop);
    return Option.isNone(shopSession) ? Unsubscribed : yield* revalidate(shopSession.value);
  });

  const expectChange = Effect.fn("SubscriptionPlan.expectChange")(function* (shop: ShopKey) {
    yield* d1(
      shopSessions.shortenPlanExpiry({
        shop,
        notAfter: (yield* Clock.currentTimeMillis) + PLAN_HANDLE_MANAGE_WINDOW_MS,
      }),
      `Plan cache deadline write failed for ${shop}`,
    );
    // After the deadline, which is what the click must not lose if the
    // button stops waiting. Best-effort, as the pushes in `revalidate`
    // are: the rows survive a failure and the next flush sends them.
    yield* actors
      .flushUsageEvents(shop)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `SubscriptionPlan.expectChange: shop=${shop}: usage flush failed`,
            cause,
          ).pipe(Effect.annotateLogs({ shop })),
        ),
      );
    yield* Effect.logInfo(
      `SubscriptionPlan.expectChange: shop=${shop}: plan deadline shortened`,
    ).pipe(Effect.annotateLogs({ shop }));
  });

  return { resolve, refresh, expectChange };
});

export class SubscriptionPlan extends Context.Service<
  SubscriptionPlan,
  {
    /**
     * The shop's plan, from cache when fresh and from Shopify when not.
     *
     * A shop with no `ShopSession` row resolves to `Unsubscribed` without
     * touching Shopify: uninstall deletes the row, so its absence means the app
     * is not installed, which grants no more access than an absent app
     * subscription does.
     */
    readonly resolve: (shop: ShopKey) => Effect.Effect<PlanStatus, SubscriptionPlanError>;
    /**
     * Revalidates unconditionally, ignoring any fresh entry.
     *
     * For the billing redirect, whose `plan_handle` parameter announces that
     * the plan just changed. The parameter triggers the refresh and is
     * never itself stored — Shopify directs apps to confirm subscription status
     * against the Partner API when handling that redirect, and this is also
     * what lets a single max age serve the no-plan case: a merchant who just
     * subscribed arrives here rather than waiting out a cache entry.
     */
    readonly refresh: (shop: ShopKey) => Effect.Effect<PlanStatus, SubscriptionPlanError>;
    /**
     * Announces that the merchant is about to change their plan, by pulling the
     * cache deadline forward to {@link PLAN_HANDLE_MANAGE_WINDOW_MS}.
     *
     * Called as the Manage plan button is clicked, not after: the merchant
     * leaves the iframe for `admin.shopify.com` and may never come back through
     * the redirect that would otherwise force the revalidation. Never extends a
     * deadline and never writes a never-fetched row, so calling it on a shop
     * that then changes nothing costs one Partner call at worst.
     *
     * Then sends the shop's usage queue. A plan change ends the app
     * subscription, and an event still queued when it ends is dated inside a
     * billing cycle that has closed, so it can never be sent
     * (`usageEventIsExpired` in Billing). The button waits at most 1.5 s before it
     * opens the pricing page. The exposure is small either way: every path that
     * counts an order sends the queue as it goes, so what this flush finds is only
     * what an earlier send failed to deliver.
     */
    readonly expectChange: (shop: ShopKey) => Effect.Effect<void, SubscriptionPlanError>;
  }
>()("app/SubscriptionPlan") {
  /**
   * Needs the `ShopSession` repository for the cached plan row, the Partner client for
   * revalidation, `ShopActors` for the revoke and the billing cycle push, and the D1 member
   * count.
   */
  static readonly layer = Layer.effect(SubscriptionPlan, make);

  /** Every shop on `status`, never failing, for tests that do not exercise the plan. */
  static readonly layerTest = (status: PlanStatus) =>
    Layer.succeed(SubscriptionPlan, {
      resolve: () => Effect.succeed(status),
      refresh: () => Effect.succeed(status),
      expectChange: () => Effect.void,
    });
}

/**
 * **Every installed shop re-reads its plan at least once a day, whether or not
 * anyone opens the app.** Run by the Backend's daily cron: {@link SubscriptionPlan}'s
 * `refresh` for every shop whose cached plan is stale (`ShopSessionRepository.listShopsWithStalePlan`),
 * four at a time.
 *
 * A revalidation is also what tells the shop's actor where its billing cycle
 * is, and nothing else does: without it a shop whose orders arrive by webhook
 * alone rolls its cycle forward once on its own and never again, so its
 * order count grows across months and its members meter is never sent a new
 * cycle's member count. The refresh pushes the cycle
 * (`ShopActors.setBillingCycle`), which sends the usage queue.
 *
 * Only stale shops: a fresh entry was read within
 * {@link PLAN_HANDLE_MAX_AGE_MS} and is clamped to its boundary, so it
 * already knows the current cycle. One shop's failure is logged and does not
 * stop the others; the next day's run retries it.
 */
export const revalidateStalePlans = Effect.fn("revalidateStalePlans")(function* () {
  const now = yield* Clock.currentTimeMillis;
  const shops = yield* (yield* ShopSessionRepository).listShopsWithStalePlan(now);
  const plan = yield* SubscriptionPlan;
  const results = yield* Effect.forEach(
    shops,
    (shop) =>
      plan.refresh(shop).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(`revalidateStalePlans: shop=${shop}: ${causeMessage(cause)}`).pipe(
            Effect.annotateLogs({ shop, cause: causeMessage(cause) }),
            Effect.as(false),
          ),
        ),
      ),
    { concurrency: 4 },
  );
  const failed = results.filter((ok) => !ok).length;
  yield* Effect.logInfo(
    `scheduled.revalidatePlans: shops=${String(shops.length)} failed=${String(failed)}`,
  ).pipe(Effect.annotateLogs({ shops: shops.length, failed }));
  return { shops: shops.length, failed };
});

/**
 * The shop's entitlements for *this* request, or {@link PlanUnsubscribed} with the plan
 * selection href.
 *
 * For the `/app` loaders whose Backend calls run on their own request. The
 * `/app` route boundary already gated the document load, but on client-side
 * navigation a loader's server function is a separate request, and the cached
 * plan entry can expire between the two — so the `Unsubscribed` arm is a live
 * path, not defensive padding.
 *
 * Resolving here rather than reading the plan out of route context is
 * deliberate: a child loader is isomorphic and runs *in the browser* on every
 * in-app navigation, so passing the plan down would mean the browser naming its
 * own tier on the majority of page views.
 *
 * A loader that needs more than the entitlements off the status resolves once and calls
 * {@link entitlementsOfStatus} rather than paying a second read.
 */
export const resolveEntitlements = Effect.fn("resolveEntitlements")(function* (shop: ShopKey) {
  return yield* entitlementsOfStatus(shop, yield* (yield* SubscriptionPlan).resolve(shop));
});

/**
 * The `Unsubscribed` arm of {@link resolveEntitlements}, split out so a caller
 * that already holds the resolved status can take the entitlements from the same
 * read instead of resolving twice. The href lives here once.
 */
export const entitlementsOfStatus = Effect.fn("entitlementsOfStatus")(function* (
  shop: ShopKey,
  status: PlanStatus,
) {
  return yield* Match.value(status).pipe(
    Match.tagsExhaustive({
      Subscribed: ({ plan }): Effect.Effect<Entitlements, PlanUnsubscribed, ShopifyPartner> =>
        Effect.succeed(entitlementsOfPlan(plan)),
      Unsubscribed: () =>
        Effect.gen(function* () {
          const shopifyPartner = yield* ShopifyPartner;
          return yield* new PlanUnsubscribed({
            href: planSelectionExitIframeHref(shopifyPartner.planSelectionUrl(shop), shop),
          });
        }),
    }),
  );
});

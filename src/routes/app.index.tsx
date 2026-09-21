import type { ReactNode } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { ManagePlanButton } from "@/components/ManagePlanButton";
import { QuotaBanners } from "@/components/QuotaBanners";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { entitlementsOfStatus, SubscriptionPlan } from "@/lib/SubscriptionPlan";

/**
 * The merchant-facing plan page: what the tier grants, beside what the shop has
 * actually used, beside the date access ends if the merchant has cancelled.
 *
 * Four sources, one request, and the split is the whole design. The
 * *entitlement* and the *cancellation* come from the plan resolved from the
 * handle cached on the shop's D1 session row. The *order count* comes from the
 * shop's Durable Object, which meters usage and knows nothing about plans. The
 * *member count* comes from D1, where members live. Nothing compares them but
 * this page and the banners it renders.
 *
 * The plan is resolved server-side rather than read from `/app` route context,
 * even though `beforeLoad` already has it: this loader is isomorphic and runs
 * in the browser on every in-app navigation, so taking it from context would
 * mean the browser supplying its own tier on most page views. The status is
 * resolved once here and both the entitlements and the scheduled change come
 * off it through `entitlementsOfStatus`, rather than paying
 * `resolveEntitlements` a second read of the same row.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(
          session.shop,
        );
        const status = yield* (yield* SubscriptionPlan).resolve(shop);
        const entitlements = yield* entitlementsOfStatus(shop, status);
        const scheduled = Match.value(status).pipe(
          Match.tagsExhaustive({
            Subscribed: ({ boundaryAt, cancelAtEndOfCycle }) => ({
              planBoundaryAt: boundaryAt,
              cancelAtEndOfCycle,
            }),
            // `entitlementsOfStatus` already redirected this arm away.
            Unsubscribed: () => ({
              planBoundaryAt: null,
              cancelAtEndOfCycle: false,
            }),
          }),
        );
        return {
          ...scheduled,
          entitlements,
          usage: yield* (yield* ShopAgentClient).getUsage(session.shop),
          memberCount: yield* (yield* Repository).countMembers(shop),
        } satisfies Domain.AppIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/app/")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

/** Seats used past this share of the plan's grant earn the "almost full" badge. Orders have no equivalent: passing the included allowance is billed, not blocked, so there is nothing to warn about on the way up. */
const MEMBER_WARNING_RATIO = 0.8;

/**
 * One dimension of the plan: what the tier grants as the denominator, what the
 * shop has as the numerator, and a line saying what passing the denominator
 * means.
 *
 * `limit` is the entitlement and never the count, so the bar measures the same
 * thing at every usage. HTML clamps `value` to `max`, so a shop past its
 * allowance renders a full bar and never overflows. The meter this is ported
 * from (`refs/bang/src/routes/app.index.tsx`, `CapacityTile`'s ancestor) takes
 * `Math.max(limit, count)` instead, which rescales the bar back to a fraction
 * at the point the shop passed the limit. Passing the limit costs something
 * different on each dimension — orders are billed, members lose seats — so
 * `detail` is the tile's own.
 *
 * The headline carries both numbers because the bar shows only a ratio.
 */
function CapacityTile({
  heading,
  href,
  badge,
  headline,
  count,
  limit,
  detail,
}: {
  readonly heading: string;
  readonly href: string;
  readonly badge?: ReactNode;
  readonly headline: string;
  readonly count: number;
  readonly limit: number;
  readonly detail: ReactNode;
}) {
  return (
    <s-clickable href={href} padding="base" border="base" borderRadius="base">
      <s-grid gap="small-200">
        <s-stack direction="inline" alignItems="center" gap="small">
          <s-heading>{heading}</s-heading>
          {badge}
        </s-stack>
        <s-heading>{headline}</s-heading>
        <progress
          className="capacity-meter"
          aria-label={heading}
          max={limit}
          value={count}
        />
        <s-paragraph color="subdued">{detail}</s-paragraph>
      </s-grid>
    </s-clickable>
  );
}

/**
 * Home is the shop's standing against its plan, as two meters and, if the
 * merchant has cancelled, the date it ends.
 *
 * Nothing here names a plan. A tier's name is Shopify's to change in the
 * Partner Dashboard without a deploy, and the meters state what the merchant
 * actually has — the numbers the app enforces — which is the same information
 * without a string to keep in sync. Manage plan is one click from every one of
 * them.
 *
 * The banners above the section are the states that need a *remedy* named —
 * syncing stopped, members without seats. The steady-state numbers are not
 * banners: the meters carry them, which is why `QuotaBanners` runs here with
 * its overage banner suppressed. It says the same thing the orders tile
 * already says, and a banner that is present on the ordinary day is a banner
 * nobody reads on the bad one.
 */
function RouteComponent() {
  const {
    entitlements,
    usage,
    memberCount,
    planBoundaryAt,
    cancelAtEndOfCycle,
  } = Route.useLoaderData();
  const { managePlanUrl } = Route.useRouteContext();

  const seatless = memberCount - entitlements.maxMembers;
  const ordersOverBy = usage.ordersThisCycle - entitlements.ordersPerCycle;

  /* Orders earn a badge only where the meter alone would mislead: a full bar
     means "billed from here on", not "stopped", and the two are one badge
     apart. `ordersLimitedAt` is the only state where orders really did stop. */
  let ordersBadge: ReactNode = null;
  if (usage.ordersLimitedAt !== null)
    ordersBadge = <s-badge tone="critical">Syncing paused</s-badge>;
  else if (ordersOverBy > 0)
    ordersBadge = <s-badge tone="warning">Billing overage</s-badge>;

  /* Seats are a wall, so the ladder runs all the way up: over it (only a
     downgrade puts a shop here), against it, and approaching it. */
  let memberBadge: ReactNode = null;
  if (seatless > 0) memberBadge = <s-badge tone="critical">Over limit</s-badge>;
  else if (memberCount === entitlements.maxMembers)
    memberBadge = <s-badge tone="warning">No seats left</s-badge>;
  else if (memberCount / entitlements.maxMembers >= MEMBER_WARNING_RATIO)
    memberBadge = <s-badge tone="warning">Almost full</s-badge>;

  /* A cycle the object has not been told about yet has no end to name. */
  const ordersReset = usage.cycleEndAt !== null && (
    <>
      {" Resets "}
      <LocalDateTime value={usage.cycleEndAt} />.
    </>
  );

  return (
    <s-page heading="Baton" inlineSize="large">
      <QuotaBanners
        usage={usage}
        ordersPerCycle={entitlements.ordersPerCycle}
        action={<ManagePlanButton url={managePlanUrl} />}
        suppressOverage
      />
      {seatless > 0 && (
        <s-banner tone="critical">
          {`Your plan includes ${formatNumber(entitlements.maxMembers)} members. Only the ${formatNumber(entitlements.maxMembers)} oldest can sign in until you remove members or upgrade.`}
        </s-banner>
      )}
      <s-section
        heading="Usage and capacity"
        accessibilityLabel="Orders and member capacity"
      >
        <s-stack gap="base">
          {/* The one scheduled fact worth a merchant's attention, and the only
              one Shopify reports that is unambiguously real: a cancellation
              runs to the boundary and then access stops. A *pending plan* is
              not rendered at all — Shopify applies most switches at once (see
              `Domain.PlanStatus`), in which case the meters below already show
              the new numbers and there is nothing to announce. */}
          {cancelAtEndOfCycle && (
            <s-paragraph>
              {"Your subscription ends on "}
              {planBoundaryAt === null ? (
                "the next billing date"
              ) : (
                <LocalDateTime value={planBoundaryAt} />
              )}
              .
            </s-paragraph>
          )}
          {/* `auto-fit` down to 300px: two tiles side by side where the
              embedded pane is wide enough for both, one column where it is
              not, with no breakpoint to keep in sync. */}
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))"
            gap="base"
          >
            {/* Used against included, in that order: the number a merchant is
                looking for is what they have spent, not what they were sold. */}
            <CapacityTile
              heading="Orders this billing period"
              href="/app/orders"
              badge={ordersBadge}
              headline={`${formatNumber(usage.ordersThisCycle)} of ${formatNumber(entitlements.ordersPerCycle)} included`}
              count={usage.ordersThisCycle}
              limit={entitlements.ordersPerCycle}
              detail={
                <>
                  {ordersOverBy > 0
                    ? `${formatNumber(ordersOverBy)} over. Extra orders are billed at your plan's rate.`
                    : "Each order synced from Shopify counts once."}
                  {ordersReset}
                </>
              }
            />
            <CapacityTile
              heading="Members"
              href="/app/members"
              badge={memberBadge}
              headline={`${formatNumber(memberCount)} of ${formatNumber(entitlements.maxMembers)} seats used`}
              count={memberCount}
              limit={entitlements.maxMembers}
              detail={
                seatless > 0
                  ? `${formatNumber(seatless)} without a seat. Only the ${formatNumber(entitlements.maxMembers)} oldest can sign in.`
                  : "Members sign in with their email on the member area."
              }
            />
          </s-grid>
          <s-stack alignItems="start">
            <ManagePlanButton url={managePlanUrl} />
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

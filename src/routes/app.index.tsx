import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { ManagePlanButton } from "@/components/ManagePlanButton";
import { QuotaBanners } from "@/components/QuotaBanners";
import { Inline } from "@/components/screen/Inline";
import { MeterTile } from "@/components/screen/MeterTile";
import { Things } from "@/components/screen/Things";
import { Tiles } from "@/components/screen/Tiles";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { entitlementsOfStatus, SubscriptionPlan } from "@/lib/SubscriptionPlan";

/**
 * The entitlements and the boundary come from the resolved {@link Domain.PlanStatus} rather
 * than from route context for the reason `resolveEntitlements` documents: this
 * loader is isomorphic, and taking the tier from context would mean the browser
 * naming it on every in-app navigation.
 */
interface AppIndexLoaderData {
  readonly entitlements: Domain.Entitlements;
  readonly usage: Domain.ShopUsage;
  /** `Member` rows in D1, against `Entitlements.membersIncluded`. */
  readonly memberCount: number;
  /** The next app subscription boundary. */
  readonly planBoundaryAt: number | null;
}

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
 * resolved once here and both the entitlements and the boundary come off it
 * through `entitlementsOfStatus`, rather than paying
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
        const planBoundaryAt = Match.value(status).pipe(
          Match.tagsExhaustive({
            Subscribed: ({ boundaryAt }) => boundaryAt,
            // `entitlementsOfStatus` already redirected this arm away.
            Unsubscribed: () => null,
          }),
        );
        return {
          planBoundaryAt,
          entitlements,
          usage: yield* (yield* ShopAgentClient).getUsage(session.shop),
          memberCount: yield* (yield* Repository).countMembers(shop),
        } satisfies AppIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/app/")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

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
 * The banners above the section are the states that need a *remedy* named
 * ({@link QuotaBanners}). The steady-state numbers are not banners: the meters
 * carry them, and a banner that is present on the ordinary day is a banner
 * nobody reads on the bad one.
 *
 * The Members tile shows today's member count, not the seats billed this cycle
 * (`Domain.ShopUsage.seatsThisCycle`). The two differ only after a member
 * is removed during the cycle: the member count drops and the seats do not. The
 * members are what the merchant manages from the tile, so it stays the number.
 */
function RouteComponent() {
  const { entitlements, usage, memberCount } = Route.useLoaderData();
  const { managePlanUrl } = Route.useRouteContext();

  const membersOverBy = memberCount - entitlements.membersIncluded;
  const ordersOverBy = usage.ordersThisCycle - entitlements.ordersPerCycle;

  /* A cycle the object has not been told about yet has no end to name. */
  const ordersReset = usage.cycleEndAt !== null && (
    <>
      {" Resets "}
      <LocalDateTime value={usage.cycleEndAt} />.
    </>
  );

  return (
    <s-page heading="Baton" inlineSize="large">
      <QuotaBanners usage={usage} />
      <s-section heading="Usage and capacity">
        <Things>
          <Tiles>
            {/* Used against included, in that order: the number a merchant is
                looking for is what they have spent, not what they were sold. */}
            <MeterTile
              heading="Orders this billing cycle"
              href="/app/orders"
              headline={`${formatNumber(usage.ordersThisCycle)} of ${formatNumber(entitlements.ordersPerCycle)} included`}
              count={usage.ordersThisCycle}
              limit={entitlements.ordersPerCycle}
              detail={
                <>
                  {ordersOverBy > 0
                    ? `${formatNumber(ordersOverBy)} over. Extra orders are billed at your plan's rate.`
                    : "Each order counts once, when work starts on it."}
                  {ordersReset}
                </>
              }
            />
            <MeterTile
              heading="Members"
              href="/app/members"
              headline={`${formatNumber(memberCount)} ${memberCount === 1 ? "member" : "members"}, ${formatNumber(entitlements.membersIncluded)} included`}
              count={memberCount}
              limit={entitlements.membersIncluded}
              detail={
                membersOverBy > 0
                  ? `${formatNumber(membersOverBy)} past your plan's included seats ${membersOverBy === 1 ? "is" : "are"} billed at your plan's rate.`
                  : "Members sign in with their email."
              }
            />
          </Tiles>
          <Inline>
            <ManagePlanButton url={managePlanUrl} />
          </Inline>
        </Things>
      </s-section>
    </s-page>
  );
}

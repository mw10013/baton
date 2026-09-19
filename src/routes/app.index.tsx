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
 * actually used, beside what is scheduled to change.
 *
 * Four sources, one request, and the split is the whole design. The
 * *entitlement* and the *scheduled change* come from the plan resolved from the
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
            Subscribed: ({ pendingPlan, boundaryAt, cancelAtEndOfCycle }) => ({
              pendingPlan,
              planBoundaryAt: boundaryAt,
              cancelAtEndOfCycle,
            }),
            // `entitlementsOfStatus` already redirected this arm away.
            Unsubscribed: () => ({
              pendingPlan: null,
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

/** The sentence a scheduled change gets, or none. A cancellation outranks a plan switch: it is what actually ends. */
function ScheduledChange({
  pendingPlan,
  planBoundaryAt,
  cancelAtEndOfCycle,
}: Pick<
  Domain.AppIndexLoaderData,
  "pendingPlan" | "planBoundaryAt" | "cancelAtEndOfCycle"
>) {
  if (cancelAtEndOfCycle)
    return (
      <s-paragraph>
        {"Subscription ends on "}
        {planBoundaryAt === null ? (
          "the next billing date"
        ) : (
          <LocalDateTime value={planBoundaryAt} />
        )}
        .
      </s-paragraph>
    );
  if (pendingPlan === null) return null;
  return (
    <s-paragraph>
      {`Changes to ${pendingPlan} on `}
      {planBoundaryAt === null ? (
        "the next billing date"
      ) : (
        <LocalDateTime value={planBoundaryAt} />
      )}
      .
    </s-paragraph>
  );
}

function RouteComponent() {
  const {
    entitlements,
    usage,
    memberCount,
    pendingPlan,
    planBoundaryAt,
    cancelAtEndOfCycle,
  } = Route.useLoaderData();
  const { plan, managePlanUrl } = Route.useRouteContext();

  const seatless = memberCount - entitlements.maxMembers;
  /**
   * The seats the *pending* plan would grant, carried with the plan's name so
   * the warning can say both. It is the only number that makes the warning
   * actionable: the merchant can still remove members before the boundary, and
   * after it nothing can be done but upgrade again.
   */
  const pendingSqueeze =
    pendingPlan !== null &&
    Domain.entitlementsOfPlan(pendingPlan).maxMembers < memberCount
      ? {
          plan: pendingPlan,
          seats: Domain.entitlementsOfPlan(pendingPlan).maxMembers,
        }
      : null;

  return (
    <s-page heading="Baton" inlineSize="base">
      <QuotaBanners
        usage={usage}
        ordersPerCycle={entitlements.ordersPerCycle}
        action={<ManagePlanButton url={managePlanUrl} />}
      />
      {seatless > 0 && (
        <s-banner tone="critical">
          {`Your plan includes ${formatNumber(entitlements.maxMembers)} members. Only the ${formatNumber(entitlements.maxMembers)} oldest can sign in until you remove members or upgrade.`}
        </s-banner>
      )}
      {pendingSqueeze !== null && (
        <s-banner tone="warning">
          {`${pendingSqueeze.plan} includes ${formatNumber(pendingSqueeze.seats)} members; you have ${formatNumber(memberCount)}. Remove members before `}
          {planBoundaryAt === null ? (
            "the change"
          ) : (
            <LocalDateTime value={planBoundaryAt} />
          )}
          {` or the ${formatNumber(pendingSqueeze.seats)} oldest keep their seats.`}
        </s-banner>
      )}
      <s-section heading="Plan" accessibilityLabel="Plan">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Resolved from the plan handle cached on the shop&apos;s session.
          </s-paragraph>
          <s-heading>{plan}</s-heading>
          <ScheduledChange
            pendingPlan={pendingPlan}
            planBoundaryAt={planBoundaryAt}
            cancelAtEndOfCycle={cancelAtEndOfCycle}
          />
          {/* Used against granted, in that order: the number a merchant is
              looking for is what they have spent, not what they were sold. */}
          <s-paragraph>
            {`Orders this billing period: ${formatNumber(usage.ordersThisCycle)} of ${formatNumber(entitlements.ordersPerCycle)}`}
            {usage.cycleEndAt !== null && (
              <>
                {" — resets "}
                <LocalDateTime value={usage.cycleEndAt} />
              </>
            )}
          </s-paragraph>
          <s-paragraph>
            {`Members: ${formatNumber(memberCount)} of ${formatNumber(entitlements.maxMembers)}`}
            {seatless > 0 && ` (${formatNumber(seatless)} without a seat)`}
          </s-paragraph>
          <s-stack alignItems="start">
            <ManagePlanButton url={managePlanUrl} />
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { QuotaBanners } from "@/components/QuotaBanners";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { resolveEntitlements } from "@/lib/SubscriptionPlan";

/**
 * The merchant-facing plan page: what the tier grants, beside what the shop has
 * actually used.
 *
 * Three sources, one request, and the split is the whole design. The
 * *entitlement* comes from the plan resolved from the handle cached on the
 * shop's D1 session row. The *order count* comes from the shop's
 * Durable Object, which meters usage and knows nothing about plans. The
 * *member count* comes from D1, where members live. Nothing compares them but
 * this page and the banner it renders.
 *
 * The plan is resolved server-side rather than read from `/app` route context,
 * even though `beforeLoad` already has it: this loader is isomorphic and runs
 * in the browser on every in-app navigation, so taking it from context would
 * mean the browser supplying its own tier on most page views.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(
          session.shop,
        );
        return {
          entitlements: yield* resolveEntitlements(shop),
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

function RouteComponent() {
  const { entitlements, usage, memberCount } = Route.useLoaderData();
  const { plan, managePlanUrl } = Route.useRouteContext();

  const managePlan = (
    <s-button
      variant="secondary"
      onClick={() => {
        window.open(managePlanUrl, "_top");
      }}
    >
      Manage plan
    </s-button>
  );

  return (
    <s-page heading="Baton" inlineSize="base">
      <QuotaBanners
        usage={usage}
        ordersPerMonth={entitlements.ordersPerMonth}
        action={managePlan}
      />
      <s-section heading="Plan" accessibilityLabel="Plan">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Resolved from the plan handle cached on the shop&apos;s session.
          </s-paragraph>
          <s-heading>{plan}</s-heading>
          {/* Used against granted, in that order: the number a merchant is
              looking for is what they have spent, not what they were sold. */}
          <s-paragraph>{`Orders this month: ${formatNumber(usage.ordersThisMonth)} of ${formatNumber(entitlements.ordersPerMonth)}`}</s-paragraph>
          <s-paragraph>{`Members: ${formatNumber(memberCount)} of ${formatNumber(entitlements.maxMembers)}`}</s-paragraph>
          <s-stack alignItems="start">{managePlan}</s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

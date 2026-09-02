import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { resolveEntitlements } from "@/lib/SubscriptionPlan";

/**
 * The skeleton's one merchant-facing page. It exists to show every seam of the
 * stack carrying real data: the Durable Object calls the Shopify Admin API with
 * the shop's offline session out of D1, and D1's cached plan handle resolves to
 * an entitlement (granted unconditionally while `BILLING_ENABLED` is off).
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
        const client = yield* ShopAgentClient;
        return yield* Effect.all(
          {
            entitlements: resolveEntitlements(shop),
            shopInfo: client.getShopInfo(shop),
          },
          { concurrency: "unbounded" },
        );
      }),
    ),
  );

export const Route = createFileRoute("/app/")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { entitlements, shopInfo } = Route.useLoaderData();
  const { plan, managePlanUrl } = Route.useRouteContext();

  return (
    <s-page heading="Baton" inlineSize="large">
      <s-section heading="Shop" accessibilityLabel="Shop">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Read from the Shopify Admin API by the Durable Object, using the
            offline session stored in D1.
          </s-paragraph>
          <s-heading>{shopInfo.name}</s-heading>
          <s-paragraph>{shopInfo.myshopifyDomain}</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Plan" accessibilityLabel="Plan">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Resolved from the plan handle cached on the shop&apos;s D1 session.
            Billing is disabled, so every shop is granted the widest tier.
          </s-paragraph>
          <s-heading>{plan}</s-heading>
          <s-paragraph>{`Daily action limit: ${formatNumber(entitlements.dailyActionLimit)}`}</s-paragraph>
          <s-stack alignItems="start">
            <s-button
              variant="secondary"
              onClick={() => {
                window.open(managePlanUrl, "_top");
              }}
            >
              Manage plan
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

import type { ReactNode } from "react";
import { useState } from "react";

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Clock, Effect, Match, Option, Schema } from "effect";

import { PlanCache } from "@/components/PlanCache";
import { adminServerFnMiddleware } from "@/lib/AdminServerFnMiddleware";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { formatDateTime, formatNumber } from "@/lib/format";
import { Repository } from "@/lib/Repository";
import { SubscriptionPlan } from "@/lib/SubscriptionPlan";

const shopInput = Schema.Struct({ shop: Domain.Shop });

/**
 * The whole page in one request: the shop's D1 `ShopSession` row and its Durable
 * Object id.
 *
 * The D1 read is not incidental — every ceiling shown here derives from the
 * plan, which only D1 knows, and the object deliberately stores no limits. Same
 * join `/app` performs on every merchant page view, one shop over.
 *
 * A missing row is the honest answer for an uninstalled shop, since uninstall
 * deletes it. This page derives the Durable Object id without calling the
 * object, so viewing arbitrary paths cannot materialize an empty object.
 *
 * The plan is decoded from the row, never resolved: `SubscriptionPlan.resolve`
 * calls the Partner API and rewrites D1 on a miss, which would make viewing
 * this page mutate the shop it reports on. {@link refreshPlan} is how an admin
 * asks for that, deliberately.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(shopInput))
  .middleware([adminServerFnMiddleware])
  .handler(({ data: { shop }, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const shopSession = yield* (yield* Repository).findShopSessionRedacted(
          shop,
        );
        if (Option.isNone(shopSession))
          return { _tag: "NotFound" } satisfies Domain.AdminShopLoaderData;
        const plan = Domain.adminShopPlanCache(
          shopSession.value,
          yield* Clock.currentTimeMillis,
        );
        return {
          _tag: "Found",
          shopSession: shopSession.value,
          plan,
          entitlements: Domain.adminShopEntitlements(plan),
          derivedShopAgentId: (yield* CloudflareEnv).SHOP_AGENT.idFromName(
            shop,
          ).toString(),
        } satisfies Domain.AdminShopLoaderData;
      }),
    ),
  );

/**
 * Forces one Partner API round trip and rewrites the shop's cached plan entry.
 *
 * A POST server function rather than anything the loader touches: this is the
 * only write on the page, and it changes what the enforcement path will decide
 * for a live shop. It exists because a cache that disagrees with reality is
 * otherwise uncorrectable before its deadline — the exact situation an admin is
 * in when a merchant reports an upgrade or a payment that did not take effect.
 *
 * Both outcomes are success. No contract writes a null handle under a fresh
 * deadline: the verified-absence state, not a failure.
 */
const refreshPlan = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(shopInput))
  .middleware([adminServerFnMiddleware])
  .handler(({ data: { shop }, context: { runEffect } }) =>
    runEffect(
      SubscriptionPlan.pipe(Effect.flatMap((plan) => plan.refresh(shop))),
    ),
  );

/**
 * `staleReloadMode: "blocking"` makes a *revisit* wait for fresh data instead
 * of painting the previous visit's.
 *
 * The router's `defaultStaleTime` is `0`, so a cached match is stale the moment
 * it is left, and the default `"background"` mode is stale-while-revalidate: it
 * renders the existing `loaderData` immediately and refreshes behind it. For a
 * list that is fine. Here every number on the page — the object's stored state
 * and the cached plan — is a point-in-time reading whose entire purpose is to be
 * current, and an operator who looks at one shop, looks at another, and comes
 * back is the normal way this page is used. Under `"background"` that return
 * paints the earlier reading with nothing marking it as old, which is worst
 * precisely when someone is checking whether something just changed.
 * `"blocking"` makes the revisit behave like a first load.
 *
 * It is *not* what makes the Refresh plan button correct — that is
 * `invalidate({ sync: true })`, whose promise resolves only once the loaders
 * have finished, so the button holds its loading state until the new plan is in
 * hand. The two are independent.
 *
 * https://tanstack.com/router/latest/docs/framework/react/guide/data-loading
 */
export const Route = createFileRoute("/admin/shop/$shop")({
  params: {
    parse: ({ shop }) => ({
      shop: Schema.decodeUnknownSync(Domain.Shop)(shop),
    }),
    stringify: ({ shop }) => ({ shop }),
  },
  loader: {
    handler: ({ params }) => getLoaderData({ data: { shop: params.shop } }),
    staleReloadMode: "blocking",
  },
  component: RouteComponent,
});

function Field({
  label,
  value,
  children,
}: {
  readonly label: string;
  readonly value?: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <div className="admin-field">
      <s-stack gap="small-200">
        <s-text tone="neutral">{label}</s-text>
        {children ?? (
          <s-text>
            {value === null || value === undefined || value === ""
              ? "—"
              : value}
          </s-text>
        )}
      </s-stack>
    </div>
  );
}

/**
 * A point-in-time operator view. Nothing here is live: the socket surface is
 * `@callable()` and merchant-scoped, and an admin looking at a shop is not a
 * reason to open a connection on it.
 */
function RouteComponent() {
  const router = useRouter();
  const { shop } = Route.useParams();
  const data = Route.useLoaderData();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();

  const runRefresh = () => {
    setRefreshError(undefined);
    setRefreshing(true);
    void refreshPlan({ data: { shop } })
      .then(() => router.invalidate({ sync: true }))
      .catch((error: unknown) => {
        setRefreshError(
          error instanceof Error
            ? error.message
            : "Could not refresh the plan from Shopify.",
        );
      })
      .finally(() => {
        setRefreshing(false);
      });
  };

  return (
    <s-page heading={shop} inlineSize="large">
      <s-link
        slot="breadcrumb-actions"
        onClick={() => void router.navigate({ to: "/admin/shops" })}
      >
        Shops
      </s-link>
      {shopContent({
        data,
        refreshing,
        refreshError,
        onRefresh: runRefresh,
      })}
    </s-page>
  );
}

const shopContent = ({
  data,
  ...rest
}: {
  readonly data: Domain.AdminShopLoaderData;
  readonly refreshing: boolean;
  readonly refreshError: string | undefined;
  readonly onRefresh: () => void;
}) =>
  Match.value(data).pipe(
    Match.tagsExhaustive({
      NotFound: () => (
        <s-banner tone="warning" heading="No session">
          No stored session for this shop. Uninstall deletes the row, so the app
          is not installed here.
        </s-banner>
      ),
      Found: (found) => <FoundShop data={found} {...rest} />,
    }),
  );

function FoundShop({
  data: { shopSession, plan, entitlements, derivedShopAgentId },
  refreshing,
  refreshError,
  onRefresh,
}: {
  readonly data: Extract<Domain.AdminShopLoaderData, { _tag: "Found" }>;
  readonly refreshing: boolean;
  readonly refreshError: string | undefined;
  readonly onRefresh: () => void;
}) {
  return (
    <>
      {refreshError ? (
        <s-banner tone="critical">{refreshError}</s-banner>
      ) : null}

      <s-section heading="Plan" accessibilityLabel="Cached plan entry">
        <s-stack gap="base">
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
            gap="base"
          >
            <Field label="Cached plan">
              <PlanCache plan={plan} />
            </Field>
            <Field
              label="Fresh until"
              value={formatDateTime(shopSession.planHandleExpiresAt)}
            />
            <Field
              label="Daily action limit"
              value={
                entitlements && formatNumber(entitlements.dailyActionLimit)
              }
            />
          </s-grid>
          <s-stack alignItems="start" gap="small-200">
            <s-button
              variant="secondary"
              loading={refreshing}
              onClick={onRefresh}
            >
              Refresh plan
            </s-button>
            <s-paragraph color="subdued">
              Asks Shopify for the current contract and rewrites the cache. Use
              it when a merchant reports a subscription change that has not
              taken effect.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section
        heading="Shopify session"
        accessibilityLabel="Stored Shopify session"
      >
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
          gap="base"
        >
          <Field label="Shop GID" value={shopSession.shopGid} />
          <Field label="Scope" value={shopSession.scope} />
          <Field label="Shop Agent ID" value={shopSession.shopAgentId} />
          <Field label="Shop Agent ID from name">
            {shopSession.shopAgentId === derivedShopAgentId ? (
              <s-badge tone="success">Matches</s-badge>
            ) : (
              <s-stack gap="small-200">
                <s-badge tone="critical">Mismatch</s-badge>
                <s-text>{derivedShopAgentId}</s-text>
              </s-stack>
            )}
          </Field>
          <Field
            label="Access token expires"
            value={formatDateTime(shopSession.accessTokenExpiresAt)}
          />
          <Field
            label="Refresh token expires"
            value={formatDateTime(shopSession.refreshTokenExpiresAt)}
          />
          <Field label="Access token">
            <s-badge tone={shopSession.hasAccessToken ? "success" : "critical"}>
              {shopSession.hasAccessToken ? "Present" : "Missing"}
            </s-badge>
          </Field>
          <Field label="Refresh token">
            <s-badge
              tone={shopSession.hasRefreshToken ? "success" : "critical"}
            >
              {shopSession.hasRefreshToken ? "Present" : "Missing"}
            </s-badge>
          </Field>
        </s-grid>
      </s-section>
    </>
  );
}

import "@/lib/shopifyAppBridgeElements";
import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useHydrated,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Redacted, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { ShopAgentSocketProvider } from "@/lib/ShopAgentSocketHost";
import { Shopify } from "@/lib/Shopify";
import { APP_BRIDGE_URL } from "@/lib/shopifyConstants";
import {
  planSelectionExitIframeHref,
  ShopifyPartner,
} from "@/lib/ShopifyPartner";
import { SubscriptionPlan } from "@/lib/SubscriptionPlan";

/**
 * Route-boundary Shopify auth and subscription gate for the `/app` subtree.
 *
 * Runs the per-request memoized `shopify.authenticateAdmin` and preserves auth
 * control flow via `runEffect` failures, then resolves the shop's plan. The
 * Worker preflights top-level `/app` documents so native recovery Responses can
 * bypass TanStack RPC serialization; this server function remains necessary
 * for client navigation, and its SSR invocation reuses the preflight result.
 * Two unrelated conditions redirect out of this function:
 *
 * - **Not authenticated.** On client server-function requests,
 *   `Shopify.authenticateAdmin` can fail with
 *   `ResponseError` wrapping plain `Response.redirect(...)` values, but
 *   TanStack router redirect control flow only recognizes redirects created by
 *   `redirect(...)` (a redirect `Response` carrying router metadata). So
 *   redirect Responses are mapped to `redirect({ href })`; non-redirect
 *   Responses are failed through unchanged.
 * - **Not subscribed.** Redirects to the plan selection page via
 *   `/auth/exit-iframe` rather than directly: the target lives on
 *   `admin.shopify.com`, which cannot render inside the embedded app iframe,
 *   so the navigation has to break out of the frame first.
 *
 * A failure to *resolve* the plan is neither of those and is deliberately not
 * caught here — an unreachable Partner API surfaces as an error rather than as
 * a merchant who appears unsubscribed.
 *
 * Success returns route context with `apiKey`, the authenticated `shop`,
 * `managePlanUrl`, and the resolved `plan`/`planHandle`. (The D1 read-replica
 * bookmark is seeded globally by the root route loader, not here; see
 * `src/routes/__root.tsx`.)
 */
const authenticateAppRoute = createServerFn({ method: "GET" })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ billingRedirect: Schema.Boolean }),
    ),
  )
  .handler(({ data: { billingRedirect }, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const shopify = yield* Shopify;
        const { session } = yield* shopify.authenticateAdmin.pipe(
          Effect.catchTag("ResponseError", ({ response }) =>
            Effect.gen(function* () {
              const location = response.headers.get("location");
              yield* Effect.logWarning(
                "authenticateAppRoute: event=response",
              ).pipe(
                Effect.annotateLogs({
                  event: "response",
                  source: "app-beforeLoad-serverfn",
                  status: response.status,
                  locationPath: location
                    ? new URL(location, shopify.config.appUrl).pathname
                    : null,
                }),
              );
              return yield* Effect.fail(
                location ? redirect({ href: location }) : response,
              );
            }),
          ),
        );
        const shopifyPartner = yield* ShopifyPartner;
        const subscriptionPlan = yield* SubscriptionPlan;
        const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(
          session.shop,
        );
        const status = yield* billingRedirect
          ? subscriptionPlan.refresh(shop)
          : subscriptionPlan.resolve(shop);
        const pricing = shopifyPartner.planSelectionUrl(shop);

        return yield* Match.value(status).pipe(
          Match.tagsExhaustive({
            Unsubscribed: () =>
              Effect.fail(
                redirect({ href: planSelectionExitIframeHref(pricing, shop) }),
              ),
            Subscribed: ({ handle, plan }) =>
              Effect.succeed({
                apiKey: Redacted.value(shopify.config.apiKey),
                managePlanUrl: pricing,
                shop,
                plan,
                planHandle: handle,
              } as const),
          }),
        );
      }),
    ),
  );

export const Route = createFileRoute("/app")({
  /**
   * Enforces auth and subscription at the `/app` layout boundary before child
   * routes load.
   *
   * Throws TanStack `redirect(...)` when Shopify auth indicates an embed or
   * session-token redirect. Native document recovery Responses are returned by
   * the Worker preflight before route loading. Otherwise returns auth context
   * for the `/app` subtree.
   *
   * `plan_handle` marks the return leg of Shopify's plan selection, so its
   * presence forces a revalidation instead of trusting the cache. It is read
   * from the router's location rather than the request: this runs as a server
   * function whose own URL carries none of the document's search parameters.
   * The handle itself is never trusted as a value — it only says that the
   * contract just changed, and the Partner API supplies what it changed to.
   */
  beforeLoad: ({ location }) =>
    authenticateAppRoute({
      data: { billingRedirect: location.searchStr.includes("plan_handle") },
    }),
  /**
   * Emits the App Bridge CDN tag via `head.scripts` so it renders inside
   * `<HeadContent />` in the document `<head>` — App Store requirement 2.2.3
   * wants `app-bridge.js` before any other script tag, and head placement
   * makes that structural instead of relying on body ordering. `apiKey`
   * comes from `beforeLoad` via `match.context`; `<HeadContent />` dedupes
   * user tags, so client navigations don't stack duplicates.
   */
  head: ({ match }) => ({
    scripts: [{ src: APP_BRIDGE_URL, "data-api-key": match.context.apiKey }],
  }),
  component: RouteComponent,
});

/**
 * Opens the single per-shop `ShopAgent` WebSocket for the whole `/app`
 * subtree and shares it via `ShopAgentProvider`. Child routes consume it with
 * `useShopAgent()` and attach their own `message` listeners to this one
 * socket — no route ever opens a second connection.
 *
 * Auth: browser `WebSocket` cannot carry custom headers on the upgrade,
 * so the Shopify session token (JWT) is passed as a `?token=…` query
 * parameter. `shopify.idToken()` mints a fresh 60s-lifetime token on
 * every call; `useAgent`'s async `query` cache is auto-invalidated on
 * disconnect, so reconnects re-fetch a fresh token. `queryDeps: [shop]`
 * ties the cache to the active shop.
 *
 * The token is verified server-side at the worker `routeAgentRequest`
 * gate (`authorizeShopAgentRequest`), which checks the token's `dest`
 * matches the URL instance segment and that the shop holds a plan. The
 * token is only checked at connect; an open socket is never re-authed, so a
 * long-lived connection needs no token rotation.
 *
 * That connect-time-only check bounds how stale the plan can get here: a
 * merchant who lapses mid-session keeps a working socket until it drops,
 * which `cacheTtl` below stretches to as long as the tab lives. Accepted
 * rather than re-checking per RPC — the alternative is giving `ShopAgent`
 * billing state, and the exposure is one open tab.
 */
function RouteComponent() {
  const { shop } = Route.useRouteContext();

  return (
    <AppProvider>
      <AppRouteContent shop={shop} />
    </AppProvider>
  );
}

/**
 * Maps Shopify navigation events into TanStack navigation. App Bridge itself
 * is loaded by the route's `head` option (see `Route` above), not here.
 * Pre-hydration input is blocked by the `inert` `<body>` in
 * `src/routes/__root.tsx`; nothing here gates on hydration.
 *
 * Polaris is loaded globally by the root route.
 */
function AppProvider({ children }: { readonly children: React.ReactNode }) {
  const navigate = useNavigate();

  React.useEffect(() => {
    const handleNavigate = (event: Event) => {
      const href = (event.target as HTMLElement)?.getAttribute("href");
      if (href) void navigate({ to: href });
    };

    document.addEventListener("shopify:navigate", handleNavigate);
    return () => {
      document.removeEventListener("shopify:navigate", handleNavigate);
    };
  }, [navigate]);

  return children;
}

/**
 * Renders the `/app` shell (nav + `Outlet`) inside the shared
 * `ShopAgentSocketProvider`, which owns the per-shop socket and the context
 * consumers read it through (`src/lib/ShopAgentSocketHost.tsx` carries the
 * quarantine, `identified`, and lifecycle rationale).
 *
 * What is specific to `/app` and stays here is the credential: `query` mints a
 * fresh App Bridge ID token per connect, because a browser cannot set a header
 * on a WebSocket upgrade. `shopify.idToken()` is browser-only and throws
 * during SSR, which is why `enabled` is `useHydrated()` — the same flag the
 * provider passes on to `useAgent`.
 *
 * The token is verified server-side at the worker `routeAgentRequest` gate
 * (`authorizeShopAgentRequest`), which checks the token's `dest` matches the
 * URL instance segment and that the shop holds a plan. The token is only
 * checked at connect; an open socket is never re-authed, so a long-lived
 * connection needs no token rotation.
 *
 * The connect-time-only check would leave a merchant who lapses mid-session
 * with a working socket for as long as the tab lives, since the keepalive
 * never lets it drop. `SubscriptionPlan` closes the shop's sockets with
 * `Domain.CONNECTION_CLOSE_REVOKED` when a revalidation learns of the lapse;
 * the reconnect is refused at the gate, and `onSocketClose` invalidates the
 * router so `beforeLoad` re-resolves the plan and redirects to plan
 * selection. Re-checking per RPC was rejected: it would give `ShopAgent`
 * billing state.
 *
 * `s-app-nav` is gated on `hydrated`: App Bridge hoists it OUT of the
 * iframe into the admin chrome, escaping the root document's `inert` body, so a
 * pre-hydration click on a hoisted `s-link` lands before the
 * `shopify:navigate` → `navigate` bridge is wired and falls through to a full
 * iframe re-embed (bounce / dropped click). Not rendering the nav until
 * `hydrated` means there is nothing to hoist until the bridge exists.
 */
function AppRouteContent({ shop }: { readonly shop: string }) {
  const shopify = useAppBridge();
  const hydrated = useHydrated();
  const query = React.useCallback(
    async () => ({ token: await shopify.idToken() }),
    [shopify],
  );
  const router = useRouter();
  const onSocketClose = React.useCallback(
    (event: CloseEvent) => {
      if (event.code === Domain.CONNECTION_CLOSE_REVOKED)
        void router.invalidate();
    },
    [router],
  );
  return (
    <ShopAgentSocketProvider
      shop={shop}
      query={query}
      enabled={hydrated}
      onSocketClose={onSocketClose}
    >
      {/* Gated on hydration to avoid pre-hydration hoisted-nav clicks; see JSDoc. */}
      {hydrated && (
        <s-app-nav>
          {/* Shopify uses rel="home" to set the hidden default landing page; spread because s-link's JSX type omits rel. */}
          <s-link href="/app" {...{ rel: "home" }}>
            Home
          </s-link>
          <s-link href="/app/orders">Orders</s-link>
          <s-link href="/app/workflows">Workflows</s-link>
          <s-link href="/app/teams">Teams</s-link>
          <s-link href="/app/members">Members</s-link>
        </s-app-nav>
      )}
      <Outlet />
    </ShopAgentSocketProvider>
  );
}

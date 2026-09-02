import type { ShopAgent } from "@/lib/ShopAgent";

import "@/lib/shopifyAppBridgeElements";
import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useHydrated,
  useNavigate,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import { Effect, Match, Redacted, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import {
  markSocketFrame,
  reconnectIfSocketStale,
  ShopAgentProvider,
  SOCKET_KEEPALIVE_MS,
  SOCKET_WATCHDOG_MS,
} from "@/lib/ShopAgentContext";
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
 * Maps Shopify navigation events into TanStack navigation and keeps app
 * content inert until hydration completes. App Bridge itself is loaded by the
 * route's `head` option (see `Route` above), not here.
 *
 * The same `useHydrated()` flip that clears `inert` is also exposed as
 * `data-app-interactive="true"` on the wrapper, giving e2e a DOM signal that
 * the `inert` barrier has lifted (`useHydrated()` itself has no marker).
 * Named "interactive", not "hydrated", on purpose: the root route's
 * `data-hydrated` flips in the same commit, but only this attribute is bound
 * to `inert` by construction — same variable, same element — so it stays
 * correct if `inert` ever gains another condition. Playwright's actionability
 * is inert-blind, so in-iframe specs wait for this marker before interacting.
 * Written as `hydrated ? "true" : undefined` so the attribute is absent
 * pre-hydration — a bare boolean would render the truthy string
 * `data-app-interactive="false"`.
 *
 * Polaris is loaded globally by the root route.
 */
function AppProvider({ children }: { readonly children: React.ReactNode }) {
  const hydrated = useHydrated();
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

  return (
    <div inert={!hydrated} data-app-interactive={hydrated ? "true" : undefined}>
      {children}
    </div>
  );
}

/**
 * Renders the `/app` shell (nav + `Outlet`) and shares the per-shop
 * `ShopAgent` socket via `ShopAgentProvider`, with the socket itself
 * quarantined in `ShopAgentSocketHost` behind a dedicated Suspense boundary.
 *
 * Quarantine rationale: `useAgent` suspends whenever its token `query`
 * re-runs — on the hydration flip and, critically, on every socket drop
 * (its `onClose` deletes the query cache with a sync, non-transition
 * setState, so the next render hits `use(pendingPromise)`). A suspending
 * render hides everything up to the nearest Suspense boundary; when the
 * hook lived in this component, that boundary was the router's match-level
 * one and a reconnect blanked the whole `/app` subtree to white. Hosting the
 * hook in a render-`null` leaf inside its own `fallback={null}` boundary
 * makes every such suspend hide only an invisible speck — the page never
 * changes during reconnects.
 *
 * The context value reads the socket through a getter, not a captured
 * reference: this component renders (and memoizes the value) *before* its
 * child `ShopAgentSocketHost` runs `useAgent` and publishes into `agentRef`,
 * so an eager read here would freeze the first-pass `null` into the memoized
 * value. The getter defers the read to consumer render time — normally the
 * host (an earlier sibling of `Outlet`) has rendered by then and the ref is
 * populated. It still returns `null` whenever the host has never completed a
 * render: on a fresh document load of a consumer route, the host's first
 * render can suspend on the token query before the ref write (a
 * post-hydration mount sees `useHydrated() === true` from its first render),
 * while lazy Suspense hydration lets the route content render in that same
 * pass. `null` is therefore part of the context contract, not a can't-happen
 * state — consumers gate on it; see `ShopAgentContext.tsx`.
 *
 * `identified` reactivity: consumers re-render only when this state flips
 * (the memoized context value is keyed on it; see `ShopAgentContext.tsx`).
 * It flips false synchronously via the host's `onClose` (honest per-consumer
 * "connecting" gates during a reconnect) and true via the host's
 * post-identify effect. During the gap, consumers holding a stale `agent`
 * keep working: `useAgent` routes stale references through its live-socket
 * ref and queues never-transmitted calls until the next socket opens.
 *
 * `s-app-nav` is gated on `hydrated`: App Bridge hoists it OUT of the
 * iframe into the admin chrome, escaping the route shell's `inert` wrapper, so a
 * pre-hydration click on a hoisted `s-link` lands before the
 * `shopify:navigate` → `navigate` bridge is wired and falls through to a full
 * iframe re-embed (bounce / dropped click). Not rendering the nav until
 * `hydrated` means there is nothing to hoist until the bridge exists.
 */
function AppRouteContent({ shop }: { readonly shop: string }) {
  const hydrated = useHydrated();
  const agentRef = React.useRef<ShopAgentSocket | null>(null);
  const [identified, setIdentified] = React.useState(false);
  const shopAgent = React.useMemo(
    () => ({
      get agent(): ShopAgentSocket | null {
        return agentRef.current;
      },
      identified,
    }),
    [identified],
  );
  return (
    <ShopAgentProvider value={shopAgent}>
      <React.Suspense fallback={null}>
        <ShopAgentSocketHost
          shop={shop}
          agentRef={agentRef}
          onIdentifiedChange={setIdentified}
        />
      </React.Suspense>
      {/* Gated on hydration to avoid pre-hydration hoisted-nav clicks; see JSDoc. */}
      {hydrated && (
        <s-app-nav>
          {/* Shopify uses rel="home" to set the hidden default landing page; spread because s-link's JSX type omits rel. */}
          <s-link href="/app" {...{ rel: "home" }}>
            Home
          </s-link>
          <s-link href="/app/orders">Orders</s-link>
          <s-link href="/app/members">Members</s-link>
          <s-link href="/app/teams">Teams</s-link>
          <s-link href="/app/workflows">Workflows</s-link>
        </s-app-nav>
      )}
      <Outlet />
    </ShopAgentProvider>
  );
}

/**
 * Render-nothing host for the `useAgent` socket. Exists so the hook's
 * suspending renders are absorbed by the `fallback={null}` boundary in
 * `AppRouteContent` instead of blanking the page — see the quarantine
 * rationale there.
 *
 * Publishes the socket by writing `agentRef` during render (not an effect):
 * later siblings (`Outlet` consumers) read it via the context getter in this
 * same render pass, before any effect could run. The write is idempotent per
 * render, and a suspending render never reaches it — `use()` throws first —
 * so the ref always holds the last successfully rendered socket, which stale
 * consumers can safely keep calling (see `socketRef` routing in
 * `agents/react`). Before the first commit there is no such socket and
 * consumers observe `null` (see `ShopAgentContext.tsx`).
 *
 * `identified` is pushed up, not read down: the parent can't observe the
 * hook's internal identity state, and reading `agent.identified` off the ref
 * wouldn't re-render consumers (it mutates in place; see
 * `ShopAgentContext.tsx`). `onClose` flips it false immediately — it fires
 * from the socket event even while a reconnect render sits suspended —
 * and the effect below syncs it true after the `cf_agent_identity`
 * handshake commits.
 *
 * Hydration gating: `useAgent` evaluates `query` during render — including
 * SSR — but `shopify.idToken()` is a browser-only App Bridge API that throws
 * in a server environment. `useHydrated()` is `false` on the server and the
 * first client render, so the token query stays disabled until hydration;
 * the component still SSRs normally. Once hydrated, `queryDeps` triggers the
 * token fetch and the socket connects client-side. (`ssr: 'data-only'` is not
 * viable for the `/app` route — skipping component SSR drops the App Bridge
 * script, breaking `useAppBridge`.)
 *
 * `enabled: hydrated` gates the socket itself: without it the first
 * pre-hydration client render would connect with no `?token=` param (query
 * still `undefined`), get rejected by the worker's `authorizeShopAgentRequest`
 * gate, then reconnect once hydrated. Gating on `hydrated` skips that wasted
 * tokenless attempt so the first connection already carries the token.
 *
 * `cacheTtl` overrides `useAgent`'s 5-min default, whose proactive timer
 * re-runs `query` → new token → new partysocket URL memo key → socket
 * replacement every 5 min. 7d removes that rotation. It must stay under the
 * ~24.8d 32-bit `setTimeout` ceiling (a larger value overflows to a negative
 * delay and loops re-render → re-query → re-schedule), and can't be 0 — the
 * same TTL is the dedup-cache lifetime guarding the inline
 * (new-identity-per-render) `query` from calling `idToken()` every render.
 * Reconnect freshness is unaffected: every close reaches `onClose`, which
 * invalidates the query cache and re-fetches a token independent of
 * `cacheTtl`.
 *
 * `defaultCallTimeout` lowers the SDK's 30s RPC timeout to 20s — the
 * *backstop* zombie detector behind the watchdog and pre-flight (see
 * `withSocketRecovery`, `ShopAgentContext.tsx`); it only fires on a zombie
 * younger than the edge deadline or a genuinely slow RPC. Not lower:
 * keep it above the slowest `@callable()` an RPC can reach. Any method that
 * awaits `ensureShopSession` plus a Shopify Admin GraphQL round trip must clear
 * Admin API p99 with margin, because a false positive invites a re-click that
 * runs a non-idempotent mutation twice.
 *
 * The three socket-lifecycle effects below are this host's side of the
 * evidence/watchdog/keepalive design in `ShopAgentContext.tsx`, placed here
 * so every `/app` route heals, not just the ones that push:
 *
 * - Frame evidence: `open`/`message` listeners call `markSocketFrame` —
 *   received frames only (see `reconnectIfSocketStale` for why sends don't
 *   count).
 * - Watchdog: 30s interval + `visibilitychange`→visible run
 *   `reconnectIfSocketStale`, making zombie recovery passive. Nothing else
 *   heals a zombie: a page that renders live pushes has no reason to refetch
 *   on tab return, and browser dead-TCP detection is unspecified,
 *   platform-variant behavior. Suspended timers resume within seconds of machine wake, so the
 *   first tick heals a wake-after-sleep zombie even when the tab was visible
 *   throughout (no `visibilitychange`). A heal runs the ordinary reconnect
 *   machinery — synthetic close → `identified` false → "Connecting" badge →
 *   fresh token → open → re-identify — and the close's query invalidation
 *   refetches the state whose pushes the zombie swallowed.
 * - Keepalive: sends the edge-answered ping (see `SOCKET_KEEPALIVE_MS` for
 *   cadence and trade-offs). Independent churn reduction, shares no state
 *   with the watchdog: pings send blind, never touch `lastFrameAt`, and a
 *   zombie yields no pong — the watchdog reconnects as if the keepalive did
 *   not exist.
 *
 * Standing constraint across all three: no periodic traffic that wakes the
 * DO or bills — the ping is answered at the edge, the watchdog is a local
 * clock check. The effects share `[agent]` deps but are deliberately not
 * merged: one effect per concern, so each layer can be removed or reasoned
 * about without touching the others.
 */
function ShopAgentSocketHost({
  shop,
  agentRef,
  onIdentifiedChange,
}: {
  readonly shop: string;
  readonly agentRef: React.RefObject<ShopAgentSocket | null>;
  readonly onIdentifiedChange: (identified: boolean) => void;
}) {
  const shopify = useAppBridge();
  const hydrated = useHydrated();
  const agent = useAgent<ShopAgent, unknown>({
    agent: "shop-agent",
    name: shop,
    query: hydrated
      ? async () => ({ token: await shopify.idToken() })
      : undefined,
    queryDeps: [shop, hydrated],
    enabled: hydrated,
    cacheTtl: 7 * 24 * 60 * 60 * 1000,
    defaultCallTimeout: 20_000,
    onClose: () => {
      onIdentifiedChange(false);
    },
  });
  agentRef.current = agent;
  React.useEffect(() => {
    onIdentifiedChange(agent.identified);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- agent.identified mutates without replacing agent, so it is a required, not redundant, dependency
  }, [agent, agent.identified, onIdentifiedChange]);
  React.useEffect(() => {
    const touch = () => {
      markSocketFrame();
    };
    touch();
    agent.addEventListener("open", touch);
    agent.addEventListener("message", touch);
    return () => {
      agent.removeEventListener("open", touch);
      agent.removeEventListener("message", touch);
    };
  }, [agent]);
  React.useEffect(() => {
    const check = () => {
      reconnectIfSocketStale(agent);
    };
    const intervalId = setInterval(check, SOCKET_WATCHDOG_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [agent]);
  React.useEffect(() => {
    const intervalId = setInterval(() => {
      if (agent.readyState === WebSocket.OPEN)
        agent.send(Domain.SocketKeepalivePing);
    }, SOCKET_KEEPALIVE_MS);
    return () => {
      clearInterval(intervalId);
    };
  }, [agent]);
  return null;
}

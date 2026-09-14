import type { ShopAgent } from "@/lib/ShopAgent";
import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { useAgent } from "agents/react";

import * as Domain from "@/lib/Domain";
import {
  markSocketFrame,
  reconnectIfSocketStale,
  ShopAgentProvider,
  SOCKET_KEEPALIVE_MS,
  SOCKET_WATCHDOG_MS,
} from "@/lib/ShopAgentContext";

/**
 * What `useAgent` puts in the socket URL's query string, or `undefined` for a
 * socket that carries no query at all.
 *
 * Merchants send `{ token }` — a freshly minted App Bridge ID token, because a
 * browser cannot set a header on a WebSocket upgrade. Members send nothing:
 * their better-auth cookie rides the upgrade automatically because the socket
 * is same-origin. Both are read by the one gate in `src/worker.ts`.
 */
export type SocketQuery =
  | (() => Promise<Record<string, string | null>>)
  | undefined;

/**
 * Shares the per-shop `ShopAgent` socket with a subtree via
 * `ShopAgentProvider`, with the socket itself quarantined in
 * {@link ShopAgentSocketHost} behind a dedicated Suspense boundary.
 *
 * Both populations mount this: `/app` for merchants, passing the App Bridge
 * `idToken` query the Worker's gate verifies, and `/shop/$shop` for members,
 * passing no query at all — their credential is the better-auth cookie the
 * browser sends on a same-origin upgrade, which the same gate reads. Nothing
 * else differs, which is why the two share one host rather than two that drift.
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
 * `onSocketClose` is the escape hatch for a close code the subtree cares
 * about: both `/app` and `/shop/$shop` use it for
 * `Domain.CONNECTION_CLOSE_REVOKED` to invalidate the router, so the loaders
 * re-run against whatever the gate now says. The reconnect that must follow
 * that same close is not their business — {@link ShopAgentSocketHost} owns it.
 */
export function ShopAgentSocketProvider({
  shop,
  query,
  enabled,
  onSocketClose,
  children,
}: {
  readonly shop: string;
  readonly query: SocketQuery;
  readonly enabled: boolean;
  readonly onSocketClose?: (event: CloseEvent) => void;
  readonly children: React.ReactNode;
}) {
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
          query={query}
          enabled={enabled}
          agentRef={agentRef}
          onIdentifiedChange={setIdentified}
          onSocketClose={onSocketClose}
        />
      </React.Suspense>
      {children}
    </ShopAgentProvider>
  );
}

/**
 * Render-nothing host for the `useAgent` socket. Exists so the hook's
 * suspending renders are absorbed by the `fallback={null}` boundary in
 * {@link ShopAgentSocketProvider} instead of blanking the page — see the
 * quarantine rationale there.
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
 * Revocation re-arms the socket by hand. `agents` classifies every close in
 * the 4000-4999 range as terminal and clears its reconnect flag
 * (`isTerminalCloseEvent` in `refs/agents/packages/agents/src/client.ts`; the
 * option it exposes can only veto a reconnect, never restore one), so
 * partysocket's usual auto-reconnect does not run for
 * `Domain.CONNECTION_CLOSE_REVOKED` — the socket would stay closed for the
 * life of the document, the page's writes would stay disabled, and the pushes
 * its lists depend on would never resume. `reconnect()` sets the flag back and
 * opens a new connection, which is the entire point of that close code: the
 * gate re-runs and answers with the current membership, or refuses (`404` /
 * `402`) and partysocket backs off. Deferred a task so the SDK's own close
 * bookkeeping — rejecting pending calls, recording `connectionError` — lands
 * before a new socket exists. `4403` is deliberately excluded: it means the
 * forwarded request was malformed, which a reconnect cannot fix.
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
 * SSR — but the merchant's `shopify.idToken()` is a browser-only App Bridge
 * API that throws in a server environment. Callers pass `enabled` from
 * `useHydrated()`, which is `false` on the server and the first client render,
 * so the token query stays disabled until hydration; the component still SSRs
 * normally. Once hydrated, `queryDeps` triggers the token fetch and the socket
 * connects client-side. (`ssr: 'data-only'` is not viable for the `/app` route
 * — skipping component SSR drops the App Bridge script, breaking
 * `useAppBridge`.)
 *
 * `enabled` gates the socket itself: without it the first pre-hydration client
 * render would connect with no `?token=` param (query still `undefined`), get
 * rejected by the worker's `authorizeShopAgentRequest` gate, then reconnect
 * once hydrated. Gating on hydration skips that wasted tokenless attempt so
 * the first connection already carries the token. A member socket has no
 * token to wait for, but gates the same way so both connect from one code
 * path.
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
  query,
  enabled,
  agentRef,
  onIdentifiedChange,
  onSocketClose,
}: {
  readonly shop: string;
  readonly query: SocketQuery;
  readonly enabled: boolean;
  readonly agentRef: React.RefObject<ShopAgentSocket | null>;
  readonly onIdentifiedChange: (identified: boolean) => void;
  readonly onSocketClose?: (event: CloseEvent) => void;
}) {
  const agent = useAgent<ShopAgent, unknown>({
    agent: "shop-agent",
    name: shop,
    query: enabled ? query : undefined,
    queryDeps: [shop, enabled],
    enabled,
    cacheTtl: 7 * 24 * 60 * 60 * 1000,
    defaultCallTimeout: 20_000,
    onClose: (event: CloseEvent) => {
      onIdentifiedChange(false);
      onSocketClose?.(event);
      if (event.code === Domain.CONNECTION_CLOSE_REVOKED)
        setTimeout(() => agentRef.current?.reconnect(), 0);
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

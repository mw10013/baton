import type { ShopAgent } from "@/lib/ShopAgent";
import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { AgentClient } from "agents/client";

import * as Domain from "@/lib/Domain";
import {
  markSocketFrame,
  reconnectIfSocketStale,
  ShopAgentProvider,
  SOCKET_KEEPALIVE_MS,
  SOCKET_WATCHDOG_MS,
} from "@/lib/ShopAgentContext";

/**
 * What the socket URL's query string carries, or `undefined` for a socket
 * that carries no query at all.
 *
 * Merchants send `{ token }` — a freshly minted App Bridge ID token, because a
 * browser cannot set a header on a WebSocket upgrade. Members send nothing:
 * their better-auth cookie rides the upgrade automatically because the socket
 * is same-origin. Both are read by the one gate in `src/worker.ts`.
 * Partysocket calls the function on every connect attempt, so a reconnect
 * carries a token minted for it and nothing caches one.
 */
export type SocketQuery =
  | (() => Promise<Record<string, string | null>>)
  | undefined;

/**
 * Opens the per-shop `ShopAgent` socket and shares it with a subtree via
 * `ShopAgentProvider`.
 *
 * Both populations mount this: `/app` for merchants, passing the App Bridge
 * `idToken` query the Worker's gate verifies, and `/shop/$shop` for members,
 * passing no query at all — their credential is the better-auth cookie the
 * browser sends on a same-origin upgrade, which the same gate reads. Nothing
 * else differs, which is why the two share one host rather than two that drift.
 *
 * The socket is an `AgentClient`, created once per mount in an effect and held
 * in state, so the context value changes when it exists. `identified` is this
 * component's state: true on the `cf_agent_identity` frame (`onIdentity`),
 * false on every close. The client also sets `identified` on itself; nothing
 * reads it, because a field mutated in place re-renders no one. In development
 * Strict Mode runs the effect twice, so one socket opens and closes before the
 * kept one. Callers' `query` and `onSocketClose` are read through effect
 * events (`useEffectEvent`), so a caller passing a new function identity each
 * render never recreates the socket and partysocket still calls the latest
 * `query` on every connect. A member's `undefined` query becomes an empty
 * one, which adds nothing to the URL.
 *
 * `enabled` is hydration (`useHydrated()`): no connect happens on the server
 * or before the App Bridge token can be minted, so the first connect already
 * carries the token. A member socket has no token to wait for, but gates the
 * same way so both connect from one code path.
 *
 * Revocation needs nothing here. `AgentClient` stops reconnecting on 1008 and
 * every 4000-4999 close (`isTerminalCloseEvent` in
 * `refs/agents/packages/agents/src/client.ts`), so
 * `Domain.CONNECTION_CLOSE_FORBIDDEN` stays closed;
 * `Domain.CONNECTION_CLOSE_REVOKED` is a 3xxx code, not terminal to it, so
 * partysocket reconnects through the gate on its own backoff.
 * `Domain.CONNECTION_CLOSE_DISPLACED` is a 4xxx code too, so the displaced
 * socket stays closed rather than reconnecting and displacing the newer
 * screen back; the host holds it as `displaced` (true from that close until
 * the socket opens again), which `SocketBanner` reads to say Signed in
 * elsewhere and offer Reconnect. `onSocketClose` still receives the close.
 *
 * `onSocketClose` is the escape hatch for a close code the subtree cares
 * about: both `/app` and `/shop/$shop` use it for
 * `Domain.CONNECTION_CLOSE_REVOKED` to invalidate the router, so the loaders
 * re-run against whatever the gate now says. The reconnect that must follow
 * that same close is not their business — the socket owns it.
 *
 * `defaultCallTimeout` lowers the SDK's 30s RPC timeout to 20s — the
 * *backstop* stale-socket detector behind the watchdog and pre-flight (see
 * `withSocketRecovery`, `ShopAgentContext.tsx`); it only fires on a stale socket
 * younger than the edge deadline or a genuinely slow RPC. Not lower:
 * keep it above the slowest `@callable()` an RPC can reach. Any method that
 * awaits `ensureShopSession` plus a Shopify Admin GraphQL round trip must clear
 * Admin API p99 with margin, because a false positive invites a re-click that
 * runs a non-idempotent mutation twice.
 *
 * The three socket-lifecycle effects below are this host's side of the
 * evidence/watchdog/keepalive design in `ShopAgentContext.tsx`, placed here
 * so every `/app` route heals, not just the live ones:
 *
 * - Frame evidence: `open`/`message` listeners call `markSocketFrame` —
 *   received frames only (see `reconnectIfSocketStale` for why sends don't
 *   count).
 * - Watchdog: 30s interval + `visibilitychange`→visible run
 *   `reconnectIfSocketStale`, making stale-socket recovery passive. Nothing else
 *   heals a stale socket: a live screen has no reason to refetch
 *   on tab return, and browser dead-TCP detection is unspecified,
 *   platform-variant behavior. Suspended timers resume within seconds of machine wake, so the
 *   first tick heals a stale socket after a wake from sleep even when the tab was visible
 *   throughout (no `visibilitychange`). A heal runs the ordinary reconnect
 *   machinery — close → `identified` false → "Connecting" badge →
 *   fresh token → open → re-identify — and the reconnect's identify
 *   refetches the state whose invalidations the stale socket swallowed (the
 *   identify row of the events table on `useLiveQuery`).
 * - Keepalive: sends the edge-answered ping (see `SOCKET_KEEPALIVE_MS` for
 *   cadence and trade-offs). Independent churn reduction, shares no state
 *   with the watchdog: pings send blind, never touch `lastFrameAt`, and a
 *   stale socket yields no pong — the watchdog reconnects as if the keepalive did
 *   not exist.
 *
 * Standing constraint across all three: no periodic traffic that wakes the
 * DO or bills — the ping is answered at the edge, the watchdog is a local
 * clock check. The effects share `[agent]` deps but are deliberately not
 * merged: one effect per concern, so each layer can be removed or reasoned
 * about without touching the others.
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
  const readQuery = React.useEffectEvent(
    () => query?.() ?? Promise.resolve({}),
  );
  const onClose = React.useEffectEvent((event: CloseEvent) => {
    onSocketClose?.(event);
  });
  const [agent, setAgent] = React.useState<ShopAgentSocket | null>(null);
  const [identified, setIdentified] = React.useState(false);
  const [displaced, setDisplaced] = React.useState(false);
  React.useEffect(() => {
    if (!enabled) return;
    const client = new AgentClient<ShopAgent>({
      agent: "shop-agent",
      name: shop,
      host: window.location.host,
      query: () => readQuery(),
      defaultCallTimeout: 20_000,
      onIdentity: () => {
        setIdentified(true);
      },
    });
    const onSocketClosed = (event: CloseEvent) => {
      setIdentified(false);
      setDisplaced(event.code === Domain.CONNECTION_CLOSE_DISPLACED);
      onClose(event);
    };
    const onSocketOpened = () => {
      setDisplaced(false);
    };
    client.addEventListener("close", onSocketClosed);
    client.addEventListener("open", onSocketOpened);
    // oxlint-disable-next-line react-hooks/set-state-in-effect -- the socket is the external system this effect creates; state is how the context learns it exists
    setAgent(client);
    // oxlint-disable-next-line typescript/consistent-return -- an effect returns a cleanup only when it opened something
    return () => {
      client.removeEventListener("close", onSocketClosed);
      client.removeEventListener("open", onSocketOpened);
      client.close();
      setAgent(null);
      setIdentified(false);
      setDisplaced(false);
    };
  }, [shop, enabled]);
  React.useEffect(() => {
    const touch = () => {
      markSocketFrame();
    };
    touch();
    agent?.addEventListener("open", touch);
    agent?.addEventListener("message", touch);
    return () => {
      agent?.removeEventListener("open", touch);
      agent?.removeEventListener("message", touch);
    };
  }, [agent]);
  React.useEffect(() => {
    const check = () => {
      if (agent) reconnectIfSocketStale(agent);
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
      if (agent?.readyState === WebSocket.OPEN)
        agent.send(Domain.SocketKeepalivePing);
    }, SOCKET_KEEPALIVE_MS);
    return () => {
      clearInterval(intervalId);
    };
  }, [agent]);
  const shopAgent = React.useMemo(
    () => ({ agent, identified, displaced }),
    [agent, identified, displaced],
  );
  return <ShopAgentProvider value={shopAgent}>{children}</ShopAgentProvider>;
}

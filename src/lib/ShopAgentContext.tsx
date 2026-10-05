import type { AgentClient } from "agents/client";

import type { ShopAgent } from "@/lib/ShopAgent";

import * as React from "react";

export type ShopAgentSocket = AgentClient<ShopAgent>;

/**
 * Shared per-shop WebSocket context value — one socket per tab, mounted by
 * `/app` for merchants and by `/shop/$shop` for members.
 *
 * `identified` is React state owned by `ShopAgentSocketProvider`: true after
 * the `cf_agent_identity` frame and false on close, so gates and the banner
 * re-render when it flips. The client writes an `identified` flag onto itself
 * too, which nothing reads.
 *
 * `agent` is `null` on the server and until the provider's effect creates the
 * socket after hydration. `identified === true` implies a non-null `agent`, so
 * consumers gate every `agent` use on `identified` or on `null`. During a
 * reconnect `agent` is the same socket while `identified` is `false`.
 */
interface ShopAgentContextValue {
  readonly agent: ShopAgentSocket | null;
  readonly identified: boolean;
}

const ShopAgentContext = React.createContext<ShopAgentContextValue | null>(
  null,
);

export const ShopAgentProvider = ShopAgentContext;

export const useShopAgent = () => {
  const ctx = React.use(ShopAgentContext);
  if (!ctx)
    throw new Error("useShopAgent must be used within ShopAgentProvider");
  return ctx;
};

/**
 * Timestamp of the last *received* frame on the tab's one ShopAgent socket.
 * A module `let`, deliberately not context state: it changes on every message
 * (state would re-render all `/app` consumers per message) and its only
 * reader is `reconnectIfSocketStale`, a plain function called from timers and
 * callbacks that cannot use hooks. Browser-only writes and reads, so no SSR
 * hazard. If a tab ever holds multiple sockets, convert to per-socket (e.g.
 * WeakMap-keyed).
 */
let lastFrameAt = Date.now();

/**
 * Called by the socket host's `open`/`message` listeners. Incoming
 * invalidations must count — they reset the edge's idle timer too. Outgoing sends
 * deliberately do not (see `reconnectIfSocketStale`).
 */
export const markSocketFrame = () => {
  lastFrameAt = Date.now();
};

/**
 * Staleness threshold: Cloudflare's edge closes a WebSocket idle in both
 * directions — documented behavior, undocumented duration
 * (`refs/cloudflare-docs/src/content/docs/network/websockets.mdx` §Idle
 * timeout), measured at ~300s in production for this deployment; plus 10s
 * reconnect/open jitter. A tolerance floor, not a contract — wrong in either
 * direction is safe: a shorter real timeout delivers frames more often so the
 * threshold never trips; a longer one degrades the watchdog into a
 * client-driven ~310s reconnect cycle, the same churn the edge imposed before
 * the keepalive (and the 240s pong normally keeps evidence far fresher).
 */
export const STALE_SOCKET_MS = 310_000;

/**
 * Keep-alive cadence — churn reduction, not liveness detection. The host
 * sends `Domain.SocketKeepalivePing` when OPEN; the edge answers via the
 * Durable Object's `setWebSocketAutoResponse` pair without waking the
 * hibernated object or billing, and the traffic resets the edge's ~300s
 * idle-close — so an idle healthy tab keeps one socket instead of cycling
 * reconnect + token mint + DO wake + refetch every 5 minutes. 240s leaves
 * ~60s headroom for hidden-tab timer throttling; a late tick just lets the
 * edge close fire and the normal ~1s reconnect run, so every failure mode
 * degrades to the pre-keepalive behavior, never below it. The ping never
 * touches `lastFrameAt` (received frames only) — a stale socket yields no pong, so
 * evidence goes stale and the watchdog fires unmasked. Accepted trade-off:
 * tokens are checked only at connect, so a kept-alive socket holds its
 * connect-time auth for hours (the old 5-min cycle incidentally re-authed).
 */
export const SOCKET_KEEPALIVE_MS = 240_000;

/**
 * Watchdog cadence — a local clock check only: no bytes on the wire, no DO
 * wake. Granularity is noise against the 310s threshold (worst-case awake
 * detection = threshold + one tick); browsers suspend timers through machine
 * sleep and resume within seconds of wake, so the first resumed tick heals a
 * stale socket after a wake from sleep almost immediately regardless of this value.
 */
export const SOCKET_WATCHDOG_MS = 30_000;

/**
 * The one definition of a stale socket: `readyState` claims OPEN but no
 * received frame for >310s → `reconnect()`. "Stale" here is the socket's; a
 * stale query is TanStack Query's, and each travels with its noun. The
 * watchdog, not a heartbeat: the
 * edge's idle-close guarantees a healthy socket — even fully idle — receives
 * a frame at least every ~300s (keepalive pong, an invalidation, or the edge
 * close's fresh `open`), so this audits that inbound cadence and sends
 * nothing. Only received frames count as evidence — a locally successful
 * `send()` cannot prove the edge got the bytes, and counting sends would mask
 * a young stale socket. Cost of that strictness: a slow in-flight RPC in an
 * otherwise idle window can trip a reconnect of a healthy socket (in-flight
 * call rejects "Connection closed") — rare, tolerated by every call site
 * (at-least-once mutations, idempotent save, read query). `Date.now()` advances
 * through sleep, so wake-after-sleep is detected exactly; the OPEN gate makes
 * overlapping callers no-ops once a reconnect is in flight. Callers: the
 * watchdog interval + visibility listener in `ShopAgentSocketProvider`
 * (`src/lib/ShopAgentSocketHost.tsx`) and the pre-flight in
 * `withSocketRecovery`.
 */
export const reconnectIfSocketStale = (agent: ShopAgentSocket) => {
  if (
    agent.readyState === WebSocket.OPEN &&
    Date.now() - lastFrameAt > STALE_SOCKET_MS
  )
    agent.reconnect();
};

/**
 * Chokepoint for every `agent.stub.*` call — two recovery layers; the passive
 * counterpart is the watchdog in `ShopAgentSocketProvider` running the same
 * `reconnectIfSocketStale`.
 *
 * Pre-flight: `reconnectIfSocketStale` first. After a reconnect the thunk
 * runs against a non-OPEN socket: `send()` on a socket that is not open
 * buffers the frame and partysocket flushes the buffer before it dispatches
 * `open` (`send` in `refs/partykit/packages/partysocket/src/ws.ts`);
 * `AgentClient` keeps a buffered call pending through the close and marks it
 * transmitted on `open` — the click that would have burned the full RPC
 * timeout on a dead pipe delivers ~1–3s later instead, no error surfaced,
 * never transmitted twice.
 *
 * Backstop: an RPC timeout on a socket claiming OPEN is the stale socket's
 * signature (`send()` succeeds locally on a dead path), and `AgentClient`'s timeout only
 * rejects the promise — without `reconnect()` here every later call would
 * burn its own timeout on the same pipe. Catches stale sockets younger than the
 * edge deadline. A false positive (a slow RPC that actually landed) costs one
 * churn and a possible duplicate delivery; every call site tolerates that.
 * The regex matches the message `AgentClient` manufactures for call timeouts
 * (`_callImpl` in `refs/agents/packages/agents/src/client.ts`);
 * other rejections pass through untouched. Stale-reference hazard is
 * negligible: a socket replacement rejects in-flight calls with "Connection
 * closed", so a timeout rejection implies the call was pending on the live
 * socket.
 */
export const withSocketRecovery =
  (agent: ShopAgentSocket) =>
  <A,>(call: () => Promise<A>): Promise<A> => {
    reconnectIfSocketStale(agent);
    return call().catch((error: unknown) => {
      if (
        error instanceof Error &&
        /^RPC call to .+ timed out after \d+ms$/u.test(error.message)
      )
        agent.reconnect();
      throw error;
    });
  };

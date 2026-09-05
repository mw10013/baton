import type { QueryKey } from "@tanstack/react-query";

import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";

/**
 * Invalidations are throttled leading + trailing over this window. Without
 * it, every `invalidated` frame fires an immediate refetch, and because
 * `invalidateQueries` defaults `cancelRefetch: true` while a Durable Object
 * RPC cannot be aborted, a burst of N invalidations (a bulk stream plus webhooks) runs
 * N full activations with N−1 results discarded. The leading edge keeps the
 * first update painting instantly; the trailing edge guarantees the final
 * state is fetched — which is why this is a throttle rather than
 * `cancelRefetch: false`: an invalidation landing mid-fetch under `staleTime: Infinity`
 * would otherwise mark the query invalid with no trigger left to refetch it.
 */
const INVALIDATION_THROTTLE_MS = 2000;

const decodeAgentMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Domain.AgentMessage),
);

const connecting = () =>
  Promise.reject(new Error("Still connecting. Try again in a moment."));

/**
 * The client half of the subscribe pattern (`Domain.Subscription` describes
 * the whole cycle): one query on the publish → invalidate → refetch model, for
 * a page whose data other actors change underneath it. Every subscribed page
 * goes through this hook so the three pieces that make a socket query
 * subscribed cannot drift apart:
 *
 * - **The read subscribes.** `subscribe` is a `subscribe<Feature>` RPC that
 *   reads and registers a `Domain.Subscription` on this connection in one
 *   round trip, keyed by a per-mount `subscriberId` (the `/app` socket
 *   outlives the route, so a stale `unsubscribe` from a replaced mount must
 *   not clear the newer mount's subscription). `staleTime: Infinity` makes
 *   the invalidations below the only refetch triggers; `gcTime` matches
 *   Router's 30-minute route cache so a retained loader match never outlives
 *   its Query data.
 * - **Identify re-subscribes.** A reconnect is a fresh server connection with
 *   no subscription, so invalidations stop until `subscribe` runs again. Every
 *   identify (first connect and each reconnect) invalidates with
 *   `cancelRefetch: false`, joining the subscribe a mount or re-enable
 *   already started instead of running a second unabortable RPC.
 * - **Published invalidations refetch, throttled.** See
 *   `INVALIDATION_THROTTLE_MS`. A trailing invalidate pending at cleanup is
 *   dropped: cleanup is unmount or an `agent` replacement, and the reconnect's
 *   identify flip re-invalidates.
 *
 * `initialData` is the loader's SSR read of the same contract (through
 * `ShopAgentClient`), so the page paints before the socket identifies; the
 * identify invalidation then performs the first subscribing read. Without it
 * the page shows its own connecting state until `identified`.
 *
 * `unsubscribe` is deferred by one task and cancelled if the effect sets up
 * again, so React Strict Mode's setup → cleanup → setup probe cannot drop
 * the subscription the first read just created. Best-effort and outside
 * `withSocketRecovery`: the subscription is connection-scoped, so any failure
 * means the connection is already gone, and reconnecting the shared socket
 * from a route the user just left would be pure churn.
 *
 * `agent` is `null` until the socket host first commits (see
 * `ShopAgentContext.tsx`); `identified` is `false` whenever it is, so the
 * query is disabled and the effects no-op until the identify flip re-renders
 * with the published socket.
 */
export const useSubscribedQuery = <A>({
  queryKey,
  subscribe,
  initialData,
}: {
  readonly queryKey: QueryKey;
  readonly subscribe: (
    stub: ShopAgentSocket["stub"],
    subscriberId: string,
  ) => Promise<A>;
  readonly initialData: A;
}) => {
  const queryClient = useQueryClient();
  const { agent, identified } = useShopAgent();
  const agentRef = React.useRef(agent);
  agentRef.current = agent;
  const subscriberIdRef = React.useRef<string | null>(null);
  subscriberIdRef.current ??= crypto.randomUUID();
  const subscriberId = subscriberIdRef.current;
  const unsubscribeTimerRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket and subscriberId is mount-scoped connection metadata; the caller's key is the cache identity
  const query = useQuery({
    queryKey,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    queryFn: () =>
      agent
        ? withSocketRecovery(agent)(() => subscribe(agent.stub, subscriberId))
        : connecting(),
    enabled: identified,
    initialData,
  });

  const invalidate = React.useCallback(
    (options?: { readonly cancelRefetch: boolean }) =>
      queryClient.invalidateQueries({ queryKey }, options),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- queryKey is an array literal per render; its hashed identity is what matters
    [queryClient, hashKey(queryKey)],
  );

  React.useEffect(() => {
    if (identified) void invalidate({ cancelRefetch: false });
  }, [identified, invalidate]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    const onWindowElapsed = () => {
      timer = null;
      if (pending) {
        pending = false;
        void invalidate();
        timer = setTimeout(onWindowElapsed, INVALIDATION_THROTTLE_MS);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      if (Option.isNone(decodeAgentMessage(event.data))) return;
      if (timer) {
        pending = true;
        return;
      }
      void invalidate();
      timer = setTimeout(onWindowElapsed, INVALIDATION_THROTTLE_MS);
    };
    agent?.addEventListener("message", onMessage);
    return () => {
      agent?.removeEventListener("message", onMessage);
      if (timer) clearTimeout(timer);
    };
  }, [agent, invalidate]);

  React.useEffect(() => {
    if (unsubscribeTimerRef.current) {
      clearTimeout(unsubscribeTimerRef.current);
      unsubscribeTimerRef.current = null;
    }
    return () => {
      unsubscribeTimerRef.current = setTimeout(() => {
        unsubscribeTimerRef.current = null;
        const closing = agentRef.current;
        if (closing?.identified)
          void closing.stub.unsubscribe({ subscriberId }).catch(() => null);
      }, 0);
    };
  }, [subscriberId]);

  /**
   * `initialData` guarantees data from the first render, but the generic
   * overload of `useQuery` cannot see that (`NonUndefinedGuard<A>` stays a
   * deferred conditional on a type parameter), so `query.data` is typed with
   * `undefined`. The check, not `??`: `null` is a real value for a detail
   * page whose order was deleted, and must not fall back to the loader's.
   */
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- `??` would swallow a real `null`; see above
  const data = query.data === undefined ? initialData : query.data;
  return { data, query, invalidate, agent, identified } as const;
};

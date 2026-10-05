import type { QueryKey } from "@tanstack/react-query";

import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import {
  hashKey,
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
 *
 * The leading edge is also what makes one publish one computation: every tab's
 * first refetch arrives a round trip after the publish that cleared the
 * object's list memo, so the tabs on one key join a single lookup instead of
 * each reading the rows (the rule on `ShopAgent.publish`). What the hook does
 * inside and at the end of the window is the events table on
 * {@link useLiveQuery}.
 */
export const INVALIDATION_THROTTLE_MS = 2000;

const decodeAgentMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Domain.AgentMessage),
);

/**
 * Whether the tab is hidden, for the deferral on {@link useLiveQuery}:
 * the Page Visibility API's `document.visibilityState`, which names the
 * browser tab. `false` without a document (SSR), where no invalidation
 * arrives anyway.
 */
export const tabIsHidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

const connecting = () =>
  Promise.reject(new Error("Still connecting. Try again in a moment."));

/**
 * The tab's half of the cycle on `Domain.InvalidatedMessage`: one query for a
 * live screen, whose data other actors change underneath it. Every live
 * screen goes through this hook so the read and the re-read on an
 * invalidation cannot drift apart. `read` is the same object method the
 * route's loader reads through `ShopAgentClient`, called over the socket.
 *
 * The events the hook handles. `visible` is the tab's visibility when the
 * event arrives (`either` when it does not matter); the window is
 * `INVALIDATION_THROTTLE_MS`, opened by a refetch.
 *
 * | event                              | visible | the hook                                       | pinned by                                                         |
 * | ---------------------------------- | ------- | ---------------------------------------------- | ----------------------------------------------------------------- |
 * | identify                           | either  | runs the read; never deferred                  | identify invalidates once and joins a fetch in flight             |
 * | invalidation, no window open       | yes     | refetches now and opens the window             | a visible tab refetches on an invalidation                        |
 * | invalidation, window open          | yes     | marks pending; the window's end refetches once | a burst inside the window costs two refetches                     |
 * | invalidation                       | no      | marks the query stale and defers               | a hidden tab defers its refetch to the next visibilitychange      |
 * | window ends with a refetch pending | no      | defers                                         | a throttled invalidation whose window elapses while hidden defers |
 * | tab becomes visible, deferred      | yes     | refetches through the throttle                 | a hidden tab defers its refetch to the next visibilitychange      |
 *
 * The throttle is the object's rate limit: every connection receives every
 * publish, so 30 refetches a minute per tab is the ceiling the shop pays at
 * any load.
 *
 * Identify is every connect, first and each reconnect, and an invalidation
 * sent while the socket was down is lost, so identify re-reads. It
 * invalidates with `cancelRefetch: false`, joining the read a mount or
 * re-enable already started instead of running a second RPC that cannot be
 * aborted. It is never deferred: a reconnect is rare, and the data may be
 * stale by however long the socket was down.
 *
 * Deferral marks the query stale without a fetch (`refetchType: "none"`)
 * and sets a flag the next `visibilitychange` to visible clears. A
 * merchant's orders index in a background tab would otherwise run the
 * counts statement on every webhook the shop receives, for a screen nobody
 * is looking at. {@link tabIsHidden} is the one definition of hidden. The
 * hook is the only refetcher: `staleTime: Infinity` leaves invalidations as
 * the only trigger, and `refetchOnWindowFocus` and `refetchOnReconnect` are
 * off, because a deferred invalidation leaves the query invalidated, which
 * TanStack Query's focus manager counts as stale and would refetch on the
 * same `visibilitychange`, outside the throttle. A trailing refetch pending
 * at cleanup is dropped: cleanup is unmount or an `agent` replacement, and
 * the reconnect's identify invalidates again. `gcTime` matches Router's
 * 30-minute route cache so a retained loader match never outlives its Query
 * data.
 *
 * `initialData` is the loader's SSR read of the same method (through
 * `ShopAgentClient`), so the screen paints before the socket identifies; the
 * identify invalidation then performs the first socket read. Without it
 * the screen shows its own connecting state until `identified`.
 *
 * It may be `undefined`, because a key can outrun the loader: the member's workflows list
 * puts its `Domain.RunQuery` in the key, and a chip press or a Show more
 * asks for rows the SSR read never fetched. Claiming the loader's rows for
 * that key would paint the wrong list as if it were fresh, so that caller
 * passes `initialData` only while its query still matches the one the loader
 * read. It stays a *required* argument, and `Initial` is inferred from what is
 * passed: a caller that always has loader data keeps `data: A`, one that may
 * not gets `A | undefined` and has to say what it renders meanwhile.
 * `placeholderData: keepPreviousData` keeps the previous key's rows on screen
 * until the new key's read returns, so a chip press re-renders the list
 * rather than the screen's connecting state.
 *
 * `agent` is `null` until the provider's effect creates the socket after
 * hydration; `identified` is `false` whenever it is, so the query is disabled
 * and the effects no-op until the identify flip.
 */
export const useLiveQuery = <A, Initial extends A | undefined>({
  queryKey,
  read,
  initialData,
}: {
  readonly queryKey: QueryKey;
  readonly read: (stub: ShopAgentSocket["stub"]) => Promise<A>;
  readonly initialData: Initial;
}) => {
  const queryClient = useQueryClient();
  const { agent, identified } = useShopAgent();

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket; the caller's key is the cache identity
  const query = useQuery({
    queryKey,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () =>
      agent ? withSocketRecovery(agent)(() => read(agent.stub)) : connecting(),
    enabled: identified,
    initialData,
    placeholderData: keepPreviousData,
  });

  const invalidate = React.useCallback(
    (options?: { readonly cancelRefetch: boolean }) =>
      queryClient.invalidateQueries({ queryKey }, options),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- queryKey is an array literal per render; its hashed identity is what matters
    [queryClient, hashKey(queryKey)],
  );

  const markStale = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey, refetchType: "none" }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- queryKey is an array literal per render; its hashed identity is what matters
    [queryClient, hashKey(queryKey)],
  );

  React.useEffect(() => {
    if (identified) void invalidate({ cancelRefetch: false });
  }, [identified, invalidate]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    let deferred = false;
    const defer = () => {
      deferred = true;
      void markStale();
    };
    const onWindowElapsed = () => {
      timer = null;
      if (!pending) return;
      pending = false;
      if (tabIsHidden()) {
        defer();
        return;
      }
      void invalidate();
      timer = setTimeout(onWindowElapsed, INVALIDATION_THROTTLE_MS);
    };
    const refetch = () => {
      if (timer) {
        pending = true;
        return;
      }
      void invalidate();
      timer = setTimeout(onWindowElapsed, INVALIDATION_THROTTLE_MS);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      if (Option.isNone(decodeAgentMessage(event.data))) return;
      if (tabIsHidden()) {
        defer();
        return;
      }
      refetch();
    };
    const onVisibilityChange = () => {
      if (tabIsHidden() || !deferred) return;
      deferred = false;
      refetch();
    };
    agent?.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      agent?.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
    };
  }, [agent, invalidate, markStale]);

  /**
   * With `initialData` there is data from the first render, but the generic
   * overload of `useQuery` cannot see that (`NonUndefinedGuard<A>` stays a
   * deferred conditional on a type parameter), so `query.data` is typed with
   * `undefined` either way. The check, not `??`: `null` is a real value for a
   * detail page whose order was deleted, and must not fall back to the
   * loader's. Without `initialData` the fallback is `undefined` too, which is
   * the caller's cue that this key has never been read.
   */
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- `??` would swallow a real `null`; see above
  const data = query.data === undefined ? initialData : query.data;
  return { data, query, invalidate, agent, identified } as const;
};

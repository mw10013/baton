import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createServerFn } from "@tanstack/react-start";

import { DefaultErrorComponent } from "@/components/DefaultErrorComponent";
import { D1Bookmark } from "@/lib/D1Bookmark";
import { setD1Bookmark } from "@/lib/d1BookmarkStore";

import { routeTree } from "./routeTree.gen";

const getD1Bookmark = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) => runEffect(D1Bookmark.current),
);

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Prevent SSR double-fetch: data fetched via ensureQueryData in loaders
        // stays fresh through hydration. invalidateQueries bypasses this.
        staleTime: 30_000,
      },
    },
  });

  /**
   * `dehydrate`/`hydrate` are the global SSR→client transport that seeds the
   * client-only D1 read-replica bookmark holder (`d1BookmarkStore`) once per
   * document load. JS can't read the document's own response headers, so the
   * bookmark must ride the dehydrated payload, not a header.
   *
   * - `dehydrate` runs **once** on the server at the end of SSR (`router-core`
   *   `ssr-server.js` → `router.options.dehydrate()`), so it captures the freshest
   *   bookmark — after every route's `beforeLoad` auth read. It delegates to the
   *   `getD1Bookmark` server fn rather than reading the request context inline:
   *   the handler reaches `context.runEffect` through Start's public, typed
   *   channel and its body is stripped from the client bundle (no internal start
   *   context, no cast, no `node:async_hooks` pulled client-side). During SSR that
   *   server fn is an in-process call sharing this document request's
   *   `runEffect`/`d1Session`, so `D1Bookmark.current` is a real `getBookmark()`
   *   marker, never the `"first-unconstrained"` constraint.
   * - `hydrate` runs **once** on the client before matches hydrate, seeding the
   *   holder so the first client server fn carries a floor ≥ what SSR read.
   *   `setD1Bookmark` is monotonic + null-guarded.
   *
   * Chosen over a route `loader`: these hooks fire exactly once per document and
   * are immune to `router.invalidate()` (a loader re-runs on every invalidate).
   * They compose with `setupRouterSsrQueryIntegration` below, which *wraps* (not
   * replaces) `dehydrate`/`hydrate` — so it must run after `createRouter`.
   */
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
    dehydrate: async () => ({ d1Bookmark: await getD1Bookmark() }),
    hydrate: ({ d1Bookmark }) => {
      setD1Bookmark(d1Bookmark);
    },
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
};

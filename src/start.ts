import type { CustomFetch } from "@tanstack/react-start";

import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import { getD1Bookmark, setD1Bookmark } from "@/lib/d1BookmarkStore";

const d1BookmarkFetch: CustomFetch = async (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-d1-bookmark", getD1Bookmark());
  const response = await fetch(url, { ...init, headers });
  setD1Bookmark(response.headers.get("x-d1-bookmark"));
  return response;
};

/**
 * Start-level configuration, auto-discovered by the TanStack Start Vite plugin
 * (`src/start.ts` is the plugin's default `start` entry; optional, so the app
 * had none before). The module is **isomorphic** — bundled into both client and
 * server — and each option below applies on exactly one side:
 *
 * - `serverFns.fetch` (client only): a custom fetch for every client-side
 *   server-function call. It threads the D1 read-replica bookmark — sends the
 *   held `x-d1-bookmark` outbound and stores the one the worker returns — so
 *   in-session reads are sequentially consistent against a replica. During SSR
 *   this is ignored (server functions are called directly), which is why the
 *   first per-load bookmark is seeded from the router `dehydrate`/`hydrate` hooks
 *   instead, not here.
 *   `fetch` is the global (App Bridge-patched) fetch, so `Authorization` is
 *   still attached.
 * - `requestMiddleware` (server only): re-adds CSRF. TanStack auto-installs CSRF
 *   for server functions *only when there is no `src/start.ts`*; defining this
 *   file opts out of that, so `createCsrfMiddleware` is added back explicitly to
 *   preserve the prior security posture.
 */
export const startInstance = createStart(() => ({
  serverFns: { fetch: d1BookmarkFetch },
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
  ],
}));

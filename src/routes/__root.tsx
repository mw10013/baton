import type { QueryClient } from "@tanstack/react-query";

import * as React from "react";

import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useHydrated,
} from "@tanstack/react-router";

import { POLARIS_URL } from "@/lib/shopifyConstants";

import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Baton | Made-to-order production workflows",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "icon",
        href: "/favicon.svg",
        type: "image/svg+xml",
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => <div>Not Found</div>,
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}

/**
 * The hydration boundary for the whole document. Until React's first commit
 * the SSR'd markup is painted but React-dead: an `onClick` is a no-op, a
 * `<form onSubmit>` falls through to the browser's native GET submission
 * (verified: `/login?email=...`), and text typed into a controlled input is
 * discarded when React takes over. `inert` on `<body>` blocks pointer,
 * keyboard, focus, and form activation for that window, for embedded and
 * non-embedded routes alike, so no route needs its own wrapper and no control
 * needs a `disabled={!hydrated}` guard — per-control guards were tried and
 * dropped: they are easy to miss on the next button, and a control that
 * flashes disabled on every load is worse UX than a page that ignores input
 * for a moment. Accepted cost: `inert` also hides the subtree from the
 * accessibility tree and find-in-page until the commit — well under a second
 * locally, 4–6s measured over a Cloudflare quick tunnel.
 *
 * `data-hydrated="true"` is the DOM signal e2e waits on (`awaitHydration` in
 * `e2e/hydration.ts`). Playwright's actionability checks are inert-blind, so
 * a click inside an inert subtree is dispatched and silently swallowed; the
 * marker is the only honest readiness signal. It lives on the same element as
 * `inert` so the two cannot drift, and is written `hydrated ? "true" :
 * undefined` so it is absent pre-hydration (a bare boolean renders the truthy
 * string `"false"`). It cannot cause a hydration mismatch: it is `undefined`
 * on both the server and the first client render.
 *
 * `useHydrated()` is read elsewhere only where this boundary cannot reach:
 * the App-Bridge-hoisted nav and the browser-only token query in
 * `src/routes/app.tsx`, and the SSR-mismatch `ClientOnly` in
 * `src/lib/SocketBanner.tsx`.
 */
function RootDocument({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body inert={!hydrated} data-hydrated={hydrated ? "true" : undefined}>
        {children}
        {/* App Bridge renders in <head> via the /app route's head option and
            must stay the document's first script tag; Polaris loads after it
            here at body-end. */}
        <script src={POLARIS_URL} />
        <Scripts />
      </body>
    </html>
  );
}

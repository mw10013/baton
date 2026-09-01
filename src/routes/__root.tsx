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
        title: "Baton",
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
 * `data-hydrated` is the document-wide "React has attached its listeners"
 * signal e2e waits on before its first interaction. Until then the SSR'd
 * markup is painted but React-dead: a click on an `onClick` button is a no-op,
 * and a submit inside a `<form onSubmit>` falls through to the browser's
 * native GET submission (verified: `/login?email=...`), because the
 * `preventDefault` does not exist yet. Playwright cannot tell — its
 * actionability checks are satisfied by the SSR'd DOM — so a spec that
 * interacts straight after `goto` fails much later, at an assertion for a
 * result the click never requested. `useHydrated()` exposes no DOM marker of
 * its own. The product-side guard for the same window is
 * `disabled={!hydrated}` on each non-embedded `onClick`/submit control.
 *
 * Distinct from `data-app-interactive` in `src/routes/app.tsx`, which marks
 * the same commit but additionally gates that route's `inert` wrapper;
 * embedded specs must keep waiting on that one, because being hydrated is not
 * the same as being interactive inside the iframe.
 */
function RootDocument({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-hydrated={hydrated ? "true" : undefined}
    >
      <head>
        <HeadContent />
      </head>
      <body>
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

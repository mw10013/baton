import type { QueryClient } from "@tanstack/react-query";

import * as React from "react";

import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
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

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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

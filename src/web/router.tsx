import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { createRouter } from "@tanstack/react-router";
import * as Duration from "effect/Duration";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { StrictMode } from "react";
import { LIVE_RETENTION } from "./client/query.ts";
import { routeTree } from "./routeTree.gen";

/**
 * Builds the router and its atom registry. It runs once per request on the server and once in
 * the browser, so each gets its own registry. Only the actor socket's atoms live in it, and
 * they are seeded in the browser from loader data, never read on the server, so nothing is
 * dehydrated. The registry's 400 ms default idle TTL is for everything but live reads, which
 * set their own.
 *
 * A cached match is kept exactly as long as its live read ({@link LIVE_RETENTION}). Every `enter`
 * still reloads it (`staleTime` 0), and a preload's match is never fresh either: that is cheap,
 * because a live loader asks the registry first (`liveLoad`). The server registry is not disposed explicitly: workerd tears down the request
 * context, and its timers, when the response finishes.
 *
 * The tree runs under `StrictMode`, so in development React renders twice, runs state
 * initializers twice and mounts effects twice; code that cannot bear that is a bug it finds.
 */
export function getRouter() {
  const registry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { registry },
    defaultGcTime: Duration.toMillis(LIVE_RETENTION),
    defaultPreloadStaleTime: 0,
    Wrap: ({ children }) => (
      <StrictMode>
        <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
      </StrictMode>
    ),
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

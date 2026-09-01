import { createFileRoute } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { Auth } from "@/lib/Auth";

/**
 * Every auth operation goes through server fns over the `Auth` service; the
 * catch-all exposes only the endpoints that must be reachable as plain HTTP
 * GETs (links a browser follows directly). Everything else 404s so
 * better-auth's full route surface is not silently public.
 */
const authAllowlistMiddleware = createMiddleware().server(
  ({ next, request }) =>
    new Set(["GET /api/auth/magic-link/verify"]).has(
      `${request.method} ${new URL(request.url).pathname}`,
    )
      ? next()
      : new Response("Not Found", { status: 404 }),
);

export const Route = createFileRoute("/api/auth/$")({
  server: {
    middleware: [authAllowlistMiddleware],
    handlers: {
      GET: ({ request, context: { runEffect } }) =>
        runEffect(Auth.pipe(Effect.flatMap((auth) => auth.handler(request)))),
      POST: ({ request, context: { runEffect } }) =>
        runEffect(Auth.pipe(Effect.flatMap((auth) => auth.handler(request)))),
    },
  },
});

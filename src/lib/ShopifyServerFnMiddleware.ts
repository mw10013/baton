import type { ShopAgentClient } from "@/lib/ShopAgentClient";
import type { ShopifyPartner } from "@/lib/ShopifyPartner";
import type { SubscriptionPlan } from "@/lib/SubscriptionPlan";

import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect, Layer } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { CurrentShopifySession } from "@/lib/CurrentShopifySession";
import { tryPromisePassthrough } from "@/lib/LayerEx";
import { Shopify } from "@/lib/Shopify";

/**
 * Server-function auth middleware for Shopify embedded requests.
 *
 * No client phase:
 * - App Bridge patches global browser `fetch` and auto-attaches
 *   `Authorization: Bearer <session_token>` for embedded app requests.
 * - App Bridge also handles the retry contract for
 *   `401 + X-Shopify-Retry-Invalid-Session-Request: 1`.
 *
 * Server phase:
 * - verifies request/session with the memoized `shopify.authenticateAdmin`
 * - injects `{ session }` into middleware context for handlers
 * - provides the authenticated `CurrentShopifySession` to server-function handlers
 *
 * Redirect nuance:
 * - `Shopify.authenticateAdmin` fails with `ResponseError` wrapping plain
 *   `Response.redirect(...)` values.
 * - TanStack router redirect control flow only recognizes redirects created by
 *   `redirect(...)` (redirect `Response` with router metadata).
 * - So redirect Responses are mapped to `redirect({ href })`; non-redirect
 *   Responses are failed through unchanged.
 *
 * Non-redirect `Response` values are re-failed unchanged so status/headers
 * (for example Shopify's 401 retry contract) reach TanStack Start transport.
 * Logs retain only paths: Shopify document redirects can contain `id_token`,
 * and GET server-function URLs can contain serialized input.
 */
export const shopifyServerFnMiddleware = createMiddleware({
  type: "function",
}).server(({ next, context }) =>
  context.runEffect(
    Effect.gen(function* () {
      const shopify = yield* Shopify;
      const request = yield* CurrentRequest;
      const { session } = yield* shopify.authenticateAdmin.pipe(
        Effect.catchTag("ResponseError", ({ response }) =>
          Effect.gen(function* () {
            const location = response.headers.get("location");
            yield* Effect.logWarning(
              "shopifyServerFnMiddleware: event=response",
            ).pipe(
              Effect.annotateLogs({
                event: "response",
                source: "serverfn-middleware",
                pathname: new URL(request.url).pathname,
                status: response.status,
                locationPath: location
                  ? new URL(location, shopify.config.appUrl).pathname
                  : null,
              }),
            );
            return yield* Effect.fail(
              location ? redirect({ href: location }) : response,
            );
          }),
        ),
      );
      const serverFnLayer = Layer.succeed(CurrentShopifySession, session);
      const runEffect = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | CurrentShopifySession
          | ShopAgentClient
          | SubscriptionPlan
          | ShopifyPartner
          | Env
        >,
      ) => context.runEffect(effect.pipe(Effect.provide(serverFnLayer)));

      return yield* tryPromisePassthrough(() =>
        next({ context: { session, runEffect } }),
      );
    }),
  ),
);

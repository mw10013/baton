import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { destroyShopAgent, handleWebhook, Shopify } from "@/lib/Shopify";

/**
 * Handles the app/uninstalled webhook from Shopify.
 *
 * When a merchant uninstalls the app, their OAuth tokens are immediately
 * invalidated. Retaining stale sessions risks conflicting OAuth flows on
 * re-install, so uninstall is the one teardown point for Shopify sessions and
 * per-shop Durable Object storage.
 *
 * Deletes all sessions for the shop unconditionally — a single DB call whether
 * this is the first delivery or a retry after sessions are already gone.
 * The template pattern (load session → guard delete) costs two DB calls on
 * first uninstall; the unconditional delete costs one in all cases.
 *
 * Having no read also makes this handler correct under D1 read replication
 * on its own terms, rather than by depending on the session constraint chosen
 * in `makeRunEffect`. A guarded delete would be a read-modify-write, and off a
 * lagging replica the guard could observe no session and skip the delete —
 * orphaning the row that every subscription gate treats as proof of install.
 * Keep this delete unconditional even if the two-call cost stops mattering.
 *
 * Also destroys the shop's ShopAgent Durable Object so its SQLite storage stops
 * being billed (a DO that ever wrote storage must call deleteAll() to cease
 * existing; destroy() does that). The destroy error is deliberately NOT
 * swallowed: a genuine failure (DO unreachable, or deleteAll() hitting its time
 * limit — "safe to retry until it succeeds") propagates so the webhook returns
 * non-2xx and Shopify retries the idempotent teardown, rather than silently
 * leaking storage. The Agents SDK's successful destroy path aborts the DO with
 * Error("destroyed"); destroyShopAgent normalizes that expected abort.
 */
export const Route = createFileRoute("/webhooks/app/uninstalled")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          handleWebhook((result) =>
            Effect.gen(function* () {
              const shopify = yield* Shopify;
              yield* shopify.deleteSessionByShop(result.shop);
              yield* destroyShopAgent(result.shop);
              return new Response();
            }),
          ),
        ),
    },
  },
});

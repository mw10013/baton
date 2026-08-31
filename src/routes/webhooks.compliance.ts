import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { handleWebhook } from "@/lib/Shopify";

/**
 * Mandatory GDPR/CPRA compliance webhooks, required for Shopify App Store
 * review. One endpoint for all three topics (the `compliance_topics` config
 * key routes them to a single URI).
 *
 * All compliance topics are verified no-ops. App/session/ShopAgent teardown is
 * handled by app/uninstalled immediately when OAuth tokens are revoked; doing it
 * from delayed shop/redact would risk resurrecting an already-destroyed
 * ShopAgent DO just to delete it again. This app stores no customer-scoped data,
 * so customers/redact and customers/data_request also have nothing to delete or
 * report.
 *
 * app/uninstalled is therefore the sole teardown point, and its delivery budget
 * is finite: Shopify retries 8 times over roughly 4 hours
 * (https://shopify.dev/docs/apps/build/webhooks/troubleshoot). A shop that
 * exhausts it strands its Durable Object — the `ShopSession` row survives, so the
 * shop still reads as installed and the admin orphan sweep, which anti-joins on
 * the *absence* of that row, cannot see it. Accepted deliberately. Burning all
 * 8 attempts takes a sustained multi-hour failure, so the loss is outage-bound
 * and correlated rather than a steady drip, and a stranded object bills only
 * storage — cents per shop per month, with nothing calling it to add requests,
 * rows, or duration. It is also not silent: `handleWebhook` logs every failure
 * at Error with shop and topic, and `destroyShopAgent` logs `status=failed`, so
 * a burned budget is visible and can be cleaned up by hand.
 *
 * Acting on shop/redact as a backstop was considered and rejected. Doing it
 * unconditionally is the resurrection bug above. Guarding on a surviving
 * `ShopSession` row avoids that but buys the cost leak with a correctness risk:
 * Shopify does not document whether shop/redact still fires when a merchant
 * reinstalls inside the 48-hour delay, the payload carries no timestamp
 * (`{ shop_id, shop_domain }`), and reinstall is a normal merchant flow, so a
 * reinstalled shop can read as a missed uninstall. Its session would recover on
 * the next OAuth; its ShopAgent memory would not. Keep both no-ops unless the
 * suppression behavior is confirmed.
 *
 * On invalid HMAC, validateWebhook returns 401, satisfying the compliance
 * requirement that invalid signatures yield 401 Unauthorized.
 */
export const Route = createFileRoute("/webhooks/compliance")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(handleWebhook(() => Effect.succeed(new Response()))),
    },
  },
});

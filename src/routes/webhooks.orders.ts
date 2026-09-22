import { createFileRoute } from "@tanstack/react-router";
import { Clock, Effect, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { handleWebhook } from "@/lib/Shopify";

/**
 * Everything the four order-shaped topics — `orders/create`, `orders/paid`,
 * `orders/cancelled`, `orders/fulfilled` (`shopify.app.toml`) — have in common
 * after `include_fields` trimming, decoded laxly: Shopify may widen the payload
 * at any time.
 *
 * `id` is a REST numeric id that exceeds `Number.MAX_SAFE_INTEGER` for newer
 * shops, so it is only ever used to reconstruct a GID when
 * `admin_graphql_api_id` is missing, which `include_fields` makes unlikely.
 */
const OrderWebhookPayload = Schema.Struct({
  id: Schema.Number,
  admin_graphql_api_id: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `orders/edited` alone: Shopify's order-editing guide says the payload
 * "reports what the edit changed, not the order's new state", so it carries an
 * `order_edit` object rather than an order. `order_id` is the REST numeric id
 * the GID is built from — small enough to be exact in practice, and compared
 * against nothing. There is no `updated_at`, so an edit always fetches; edits
 * are rare, so that costs nothing worth guarding.
 */
const OrderEditWebhookPayload = Schema.Struct({
  order_edit: Schema.Struct({ order_id: Schema.Number }),
});

const WebhookPayload = Schema.Union([
  OrderEditWebhookPayload,
  OrderWebhookPayload,
]);

/**
 * The GID and the stale-guard value for either payload shape. An edit has no
 * `updated_at`, and `null` is what the Durable Object's stale guard already
 * reads as "no guard, fetch it".
 */
const orderRef = (payload: typeof WebhookPayload.Type) =>
  "order_edit" in payload
    ? {
        orderId: `gid://shopify/Order/${String(payload.order_edit.order_id)}`,
        updatedAt: null,
      }
    : {
        orderId:
          payload.admin_graphql_api_id ??
          `gid://shopify/Order/${String(payload.id)}`,
        updatedAt: updatedAtMillis(payload.updated_at),
      };

const updatedAtMillis = (updatedAt: string | null | undefined) => {
  const millis = Date.parse(updatedAt ?? "");
  return Number.isNaN(millis) ? null : millis;
};

/**
 * The real-time half of order intake; the other half is the manual import
 * (`ShopAgent.syncOrders`). All five subscribed topics point here.
 *
 * The payload is a signal, not the data. It is REST-shaped, carries no product
 * tags or enriched line-item metadata, and is trimmed to ids by
 * `include_fields` anyway — so the Durable Object fetches the order it names.
 * Shopify's own OMS guidance is exactly this: query the full order after each
 * webhook, and reconcile periodically for the ones that never arrived. The
 * topic is a log field and nothing else; `reconcileOrder` works from the
 * fetched state, which is what makes retries and out-of-order delivery safe.
 *
 * The Durable Object call is awaited inside Shopify's five-second budget; one
 * `OrderSync` query is comfortably under it.
 *
 * Failures deliberately propagate to a non-2xx, so Shopify retries for four
 * hours — the same stance as the uninstall route. Subscriptions declared in
 * `shopify.app.toml` are never auto-deleted for consecutive failures (only
 * API-created ones are), so a bad deploy cannot silently unsubscribe a shop.
 */
export const Route = createFileRoute("/webhooks/orders")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          handleWebhook(({ shop, topic, payload, webhookId, triggeredAt }) =>
            Effect.gen(function* () {
              const { orderId, updatedAt } = orderRef(
                yield* Schema.decodeUnknownEffect(WebhookPayload)(payload),
              );
              const stub = (yield* CloudflareEnv).SHOP_AGENT.getByName(shop);
              const receivedAt = yield* Clock.currentTimeMillis;
              yield* Effect.tryPromise(() =>
                stub.syncOrder({
                  orderId,
                  topic,
                  webhookId,
                  triggeredAt: triggeredAt ?? receivedAt,
                  updatedAt,
                }),
              );
              return new Response();
            }),
          ),
        ),
    },
  },
});

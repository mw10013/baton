import { createFileRoute } from "@tanstack/react-router";
import { Clock, Effect, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { handleWebhook } from "@/lib/Shopify";

/**
 * Everything the seven order topics have in common after `include_fields`
 * trimming, decoded laxly: Shopify may widen the payload at any time, and
 * `orders/delete` sends `{ id }` alone.
 *
 * `id` is a REST numeric id that exceeds `Number.MAX_SAFE_INTEGER` for newer
 * shops, so it is only ever used to reconstruct a GID when
 * `admin_graphql_api_id` is missing — which is exactly the `orders/delete`
 * case, where the id is small enough to be exact in practice and is compared
 * against nothing.
 */
const OrderWebhookPayload = Schema.Struct({
  id: Schema.Number,
  admin_graphql_api_id: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `Shopify.validateWebhook` reports the library's normalized topic form, so the
 * delete branch matches `ORDERS_DELETE` rather than the `orders/delete` written
 * in `shopify.app.toml`.
 */
const ORDERS_DELETE_TOPIC = "ORDERS_DELETE";

const orderGid = ({
  id,
  admin_graphql_api_id: gid,
}: typeof OrderWebhookPayload.Type) =>
  gid ?? `gid://shopify/Order/${String(id)}`;

const updatedAtMillis = (updatedAt: string | null | undefined) => {
  const millis = Date.parse(updatedAt ?? "");
  return Number.isNaN(millis) ? null : millis;
};

/**
 * The real-time half of order sync; the other half is the manual window sync
 * (`ShopAgent.syncOrders`). All seven order topics point here.
 *
 * The payload is a signal, not the data. It is REST-shaped, carries no product
 * tags or enriched line-item metadata, and is trimmed to ids by
 * `include_fields` anyway — so the Durable Object fetches the order it names.
 * Shopify's own OMS guidance is exactly this: query the full order after each
 * webhook, and reconcile periodically for the ones that never arrived.
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
              const order =
                yield* Schema.decodeUnknownEffect(OrderWebhookPayload)(payload);
              const orderId = orderGid(order);
              const stub = (yield* CloudflareEnv).SHOP_AGENT.getByName(shop);
              const receivedAt = yield* Clock.currentTimeMillis;
              yield* Effect.tryPromise(() =>
                topic === ORDERS_DELETE_TOPIC
                  ? stub.deleteOrder({ orderId })
                  : stub.syncOrder({
                      orderId,
                      topic,
                      webhookId,
                      triggeredAt: triggeredAt ?? receivedAt,
                      updatedAt: updatedAtMillis(order.updated_at),
                    }),
              );
              return new Response();
            }),
          ),
        ),
    },
  },
});

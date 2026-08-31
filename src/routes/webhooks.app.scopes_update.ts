import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";

import { handleWebhook, Shopify } from "@/lib/Shopify";

const ScopesUpdatePayload = Schema.Struct({
  current: Schema.Array(Schema.String),
});

export const Route = createFileRoute("/webhooks/app/scopes_update")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          handleWebhook((result) =>
            Effect.gen(function* () {
              const shopify = yield* Shopify;
              const payload = yield* Schema.decodeUnknownEffect(
                ScopesUpdatePayload,
              )(result.payload);
              yield* shopify.updateShopSessionScope({
                shop: result.shop,
                scope: payload.current.toString(),
              });
              return new Response();
            }),
          ),
        ),
    },
  },
});

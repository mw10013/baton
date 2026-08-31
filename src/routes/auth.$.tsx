import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { Shopify } from "@/lib/Shopify";

export const Route = createFileRoute("/auth/$")({
  server: {
    handlers: {
      GET: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const shopify = yield* Shopify;
            yield* shopify.authenticateAdmin;
            return new Response();
          }),
        ),
    },
  },
});

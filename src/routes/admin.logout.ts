import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { AdminAuth } from "@/lib/AdminAuth";

export const Route = createFileRoute("/admin/logout")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const auth = yield* AdminAuth;
            yield* auth.logout();
            return new Response(null, {
              status: 303,
              headers: { location: "/admin/login" },
            });
          }),
        ),
    },
  },
});

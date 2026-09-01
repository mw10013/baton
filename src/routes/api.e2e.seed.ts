import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { D1Primary } from "@/lib/D1Primary";
import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";

const E2eSeedInput = Schema.Struct({
  shop: Domain.Shop,
  members: Schema.Array(Domain.Email),
});

/**
 * Playwright fixture endpoint that replaces a shop's membership with exactly
 * `members` and drops the better-auth identity of every listed email, so each
 * run signs in as a first-time user. Enabled only for `ENVIRONMENT === "local"`;
 * deployed environments receive 404. Local state is disposable, so the endpoint
 * intentionally has no caller authorization.
 *
 * Writes through `D1Primary` for the same reason `Repository.addMember` does:
 * the sign-in gate reads membership off the primary, and a seed that landed on
 * a replica-lagged path could let the very next `/login` deny a member it just
 * granted.
 *
 * `Verification` is wiped wholesale rather than filtered by email: better-auth
 * keys magic-link rows by an opaque token identifier, not by the address, so
 * there is nothing to filter on — and a stale unconsumed link for the seeded
 * email is exactly what would make a retry sign in through the previous run's
 * URL. Deleting `User` cascades that email's `Session` and `Account` rows
 * (`migrations/0001_init.sql:57,70`).
 *
 * Deliberately does NOT seed `ShopSession`: `Member.shop` FKs to it, so seeding
 * a shop the app is not installed on fails loudly here instead of surfacing
 * later as a `/shop/$shop` 500 from a fabricated offline token.
 */
export const Route = createFileRoute("/api/e2e/seed")({
  server: {
    handlers: {
      POST: ({ context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const env = yield* CloudflareEnv;
            if (env.ENVIRONMENT !== "local")
              return new Response("Not Found", { status: 404 });
            const request = yield* CurrentRequest;
            return yield* Effect.gen(function* () {
              const { shop, members } = yield* Schema.decodeUnknownEffect(
                E2eSeedInput,
              )(yield* Effect.tryPromise(() => request.json()));
              const sql = yield* D1Primary;
              const repository = yield* Repository;
              yield* sql`delete from Member where shop = ${shop}`;
              yield* sql`delete from Verification`;
              for (const email of members) {
                yield* sql`delete from User where email = ${email}`;
                yield* repository.addMember({ shop, email });
              }
              return Response.json({ ok: true, shop, members });
            }).pipe(
              Effect.catchTag("SchemaError", (error) =>
                Effect.succeed(new Response(String(error), { status: 400 })),
              ),
            );
          }),
        ),
    },
  },
});

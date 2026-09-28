import { Data, Effect } from "effect";

import { fixture } from "../../e2e/fixture.ts";

export class SeedError extends Data.TaggedError("SeedError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Posts the development fixture (`e2e/fixture.ts`, which documents the naming
 * and what each row exercises) to `/api/dev/seed` (`src/routes/api.dev.seed.ts`,
 * local-only). The fixture module is shared with Playwright so the shop a
 * developer looks at and the shop a whole-shop spec asserts against are the
 * same data.
 *
 * Requires the dev server running and the app installed on `shop`: `Member`
 * and `Team` both FK to `ShopSession`, which only the embedded app's token
 * exchange creates, so the endpoint answers 409 without it. Returns a one-line
 * summary.
 */
export const seed = ({
  port,
  shop,
}: {
  readonly port: string;
  readonly shop: string;
}) =>
  Effect.tryPromise({
    try: () =>
      fetch(`http://localhost:${port}/api/dev/seed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shop, ...fixture }),
      }),
    catch: (cause) =>
      new SeedError({ message: `seed request to port ${port} failed`, cause }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(
            `seeded ${shop}: members ${String(fixture.members.length)}, teams ${String(fixture.teams.length)}, workflows ${String(fixture.workflows.length)}, orders ${String(fixture.orders.length)}`,
          )
        : Effect.promise(() => response.text()).pipe(
            Effect.flatMap(
              (text) =>
                new SeedError({
                  message: `seed failed: ${String(response.status)} ${text}`,
                }),
            ),
          ),
    ),
  );

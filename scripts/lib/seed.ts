import { Data, Effect } from "effect";

import { fixture as devFixture } from "../../e2e/fixture.ts";
import { fixture as showcaseFixture } from "../../e2e/showcaseFixture.ts";

export class SeedError extends Data.TaggedError("SeedError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The fixture `pnpm seed` posts: the development fixture, or with `--showcase` the help's showcase shop. */
export type SeedFixtureName = "dev" | "showcase";

/**
 * Posts a fixture to `/api/dev/seed` (`src/routes/api.dev.seed.ts`,
 * local-only). By default it is the development fixture (`e2e/fixture.ts`,
 * which documents the naming and what each row exercises), shared with
 * Playwright so the shop a developer looks at and the shop a whole-shop spec
 * asserts against are the same data. `fixture: "showcase"` posts the showcase
 * fixture (`e2e/showcaseFixture.ts`) instead, for the help's pictures.
 *
 * Requires the dev server running and the app installed on `shop`: `Member`
 * and `Team` both FK to `ShopSession`, which only the embedded app's token
 * exchange creates, so the endpoint answers 409 without it. Returns a one-line
 * summary.
 */
export const seed = ({
  port,
  shop,
  fixture: fixtureName = "dev",
}: {
  readonly port: string;
  readonly shop: string;
  readonly fixture?: SeedFixtureName;
}) => {
  const fixture = fixtureName === "showcase" ? showcaseFixture : devFixture;
  return Effect.tryPromise({
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
            `seeded ${shop} with the ${fixtureName} fixture: members ${String(fixture.members.length)}, teams ${String(fixture.teams.length)}, workflows ${String(fixture.workflows.length)}, orders ${String(fixture.orders.length)}`,
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
};

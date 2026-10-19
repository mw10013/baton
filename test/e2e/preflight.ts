import { NodeServices } from "@effect/platform-node";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import process from "node:process";

import { answering, findTunnelUrl, tunnelReady } from "../../scripts/lib/server.ts";
import { e2ePortOf } from "../../scripts/lib/worktree.ts";

class PreflightError extends Schema.TaggedError<PreflightError>()("PreflightError", {
  message: Schema.String,
}) {}

/**
 * The run's `globalSetup`, before any project: the e2e server answers on localhost, and the quick
 * tunnel the admin embeds the app through serves, so a run that cannot work fails here in one
 * sentence instead of in `install` with every other test skipped.
 *
 * The tunnel check asks public DNS before anything touches the system resolver, which would
 * otherwise cache "not found" for a hostname a moment too new; {@link tunnelReady} holds that rule.
 *
 * It is a `globalSetup` and not a setup project because every project needs the server, and a
 * setup project they depend on would sit behind `shopify-admin`, whose cookie refresh can raise a
 * Keychain prompt that `chromium` has no reason to wait for.
 */
export default async function preflight(): Promise<void> {
  const port = e2ePortOf(Number(process.env.WEBSITE_PORT));
  const program = Effect.gen(function* () {
    if (!(yield* answering(port)))
      return yield* new PreflightError({
        message: `the e2e server does not answer on http://localhost:${String(port)}`,
      });
    const url = yield* findTunnelUrl(port).pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.mapError(
        () =>
          new PreflightError({
            message: `the e2e server on port ${String(port)} has no tunnel (no APP_URL): it is not running under shopify app dev`,
          }),
      ),
    );
    const took = yield* tunnelReady(url);
    return `${url} ready in ${(Duration.toMillis(took) / 1000).toFixed(1)}s`;
  });
  const result = await Effect.runPromise(
    program.pipe(Effect.result, Effect.provide(NodeServices.layer)),
  );
  if (Result.isFailure(result)) throw new Error(`e2e preflight: ${result.failure.message}`);
  console.log(`e2e preflight: ${result.success}`);
}

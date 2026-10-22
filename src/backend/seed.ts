import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import { AuthDb } from "./resources.ts";
import { environmentOf, type Environment } from "./stage.ts";

/**
 * The one seed file of an environment: its admin user, and for `test`, the integration tests'
 * fake shops too. A real shop's rows cannot be seeded: they need the shop's `ShopSession`, which
 * only its first embedded load writes, so `dev` and `e2e` load theirs as a fixture. Exhaustive,
 * so a new {@link Environment} does not compile until its seed is chosen.
 */
export const seedFileFor = Match.type<Environment>().pipe(
  Match.when("dev", () => "./seed/dev.sql"),
  Match.when("test", () => "./seed/test.sql"),
  Match.when("e2e", () => "./seed/e2e.sql"),
  Match.when("staging", () => "./seed/staging.sql"),
  Match.when("production", () => "./seed/production.sql"),
  Match.exhaustive,
);

/**
 * Runs an environment's seed file against {@link AuthDb}, filling Baton's tables and Better
 * Auth's alike. It is an Action, not `importFiles` on {@link AuthDb}, because `importFiles` runs
 * inside the D1 resource, before `BetterAuthMigrate` creates Better Auth's tables on a fresh
 * database. An Action runs after whatever its input depends on; {@link seed} puts the Backend's
 * URL there, and the Backend already waits for the migration. Register it only through
 * {@link seed}.
 *
 * The runner executes the SQL it is given, so the file's text and the database id are part of
 * the input: an edited file runs again, and a recreated database is seeded again. The rows must
 * be idempotent (`INSERT OR IGNORE`) and shaped as Better Auth stores them: ISO text dates,
 * 0/1 booleans.
 *
 * It lives apart from `AuthDb` because `QueryDatabaseLocal` pulls the `workerd` binary resolver
 * into whatever imports it; the Backend bundle imports `AuthDb` and must not carry that.
 */
export const Seed = Alchemy.Action(
  "Seed",
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
    return Effect.fn("Seed")(function* (input: {
      readonly databaseId: string;
      readonly backendUrl: string;
      readonly sql: string;
    }) {
      yield* d1.exec(input.sql);
    });
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
);

/**
 * Registers {@link Seed} with the stage's seed file ({@link seedFileFor}), after the Backend.
 * A stage outside every environment dies naming it: the stack's error channel is `ConfigError`.
 */
export const seed = Effect.fn("seed")(function* (backend: {
  readonly url: Alchemy.Output<string | undefined>;
}) {
  const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* fs.readFileString(seedFileFor(environment)).pipe(Effect.orDie);
  const database = yield* AuthDb;
  yield* Seed({ databaseId: database.databaseId, backendUrl: backend.url.as<string>(), sql });
});

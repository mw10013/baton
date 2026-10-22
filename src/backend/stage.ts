/**
 * An environment is a role (`dev`, `test`, `e2e`, `staging`, `production`); a stage is one copy of the stack in
 * an environment. Never shortened to `env`, which already means `.env`, `process.env` and a
 * Worker's bindings.
 *
 * Imports only `effect`, so any bundle may carry it.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** The environments with one stage per developer and checkout; deployed stages are shared. */
export const PerDeveloper = Schema.Literals(["dev", "test", "e2e"]);
export type PerDeveloper = typeof PerDeveloper.Type;

/**
 * The environments deployed to Cloudflare, each a single stage named after the environment.
 */
export const Deployed = Schema.Literals(["staging", "production"]);
export type Deployed = typeof Deployed.Type;

/** Only disposable deployed data may be destroyed by the reset command. Production is excluded. */
export const ResettableDeployed = Schema.Literals(["staging"]);
export type ResettableDeployed = typeof ResettableDeployed.Type;

export const Environment = Schema.Literals([...PerDeveloper.literals, ...Deployed.literals]);
export type Environment = typeof Environment.Type;

/** Lowercase letters and digits, so a user never contains the `-` between a stage's parts. */
const User = Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/u));

/**
 * A linked worktree's branch, folder and stage part, `wt-01` for index 1, as a codec: decode the
 * name to its index (1 to 99, so `wt-00` is not a worktree), encode an index to the name.
 */
export const Checkout = Schema.String.check(Schema.isPattern(/^wt-\d{2}$/u)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
    SchemaTransformation.transform({
      decode: (name) => Number(name.slice("wt-".length)),
      encode: (index) => `wt-${String(index).padStart(2, "0")}`,
    }),
  ),
);

const PerDeveloperStageParts = Schema.Union([
  Schema.TemplateLiteralParser([PerDeveloper, "-", User]),
  Schema.TemplateLiteralParser([PerDeveloper, "-", User, "-", Checkout]),
]);

/**
 * A per-developer stage, `<environment>-<user>[-<checkout>]`: `dev-mw` in the main checkout,
 * `dev-mw-wt-01` in worktree `wt-01`. Dashes, because Alchemy turns every other separator into
 * `-` in physical names, so the stage reads the same in the CLI, state, logs and Cloudflare.
 */
export const PerDeveloperStage = PerDeveloperStageParts.pipe(
  Schema.decodeTo(
    Schema.Struct({
      environment: PerDeveloper,
      user: Schema.String,
      checkout: Schema.Option(Schema.Int),
    }),
    SchemaTransformation.transform({
      decode: (parts) => ({
        environment: parts[0],
        user: parts[2],
        checkout: parts.length === 5 ? Option.some(parts[4]) : Option.none(),
      }),
      encode: ({ environment, user, checkout }) =>
        Option.match(checkout, {
          onNone: () => [environment, "-", user] as const,
          onSome: (index) => [environment, "-", user, "-", index] as const,
        }),
    }),
  ),
);
export type PerDeveloperStage = typeof PerDeveloperStage.Type;

/**
 * The last part of a {@link TestFileStage}: lowercase letters and digits, starting with a letter,
 * and never `wt`, which would read as the start of a {@link Checkout}.
 */
const TestFileSuffix = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*$/u),
  Schema.makeFilter((suffix) => suffix !== "wt" || "`wt` names a worktree, not a test file."),
);

const TestFileStageParts = Schema.Union([
  Schema.TemplateLiteralParser([Schema.Literal("test"), "-", User, "-", TestFileSuffix]),
  Schema.TemplateLiteralParser([
    Schema.Literal("test"),
    "-",
    User,
    "-",
    Checkout,
    "-",
    TestFileSuffix,
  ]),
]);

/**
 * One integ file's own `test` stage, `test-<user>[-<checkout>]-<suffix>`: `test-mw-shopactor`, or
 * `test-mw-wt-01-shopactor` in worktree `wt-01`. Each file deploys and destroys its own, so files
 * run side by side without sharing state, ports or data.
 */
export const TestFileStage = TestFileStageParts.pipe(
  Schema.decodeTo(
    Schema.Struct({
      user: Schema.String,
      checkout: Schema.Option(Schema.Int),
      suffix: Schema.String,
    }),
    SchemaTransformation.transform({
      decode: (parts) =>
        parts.length === 7
          ? { user: parts[2], checkout: Option.some(parts[4]), suffix: parts[6] }
          : { user: parts[2], checkout: Option.none(), suffix: parts[4] },
      encode: ({ user, checkout, suffix }) =>
        Option.match(checkout, {
          onNone: () => ["test", "-", user, "-", suffix] as const,
          onSome: (index) => ["test", "-", user, "-", index, "-", suffix] as const,
        }),
    }),
  ),
);
export type TestFileStage = typeof TestFileStage.Type;

export class UnknownStage extends Schema.TaggedError<UnknownStage>()("UnknownStage", {
  stage: Schema.String,
}) {
  override get message() {
    return `stage "${this.stage}" belongs to no known environment`;
  }
}

const decodePerDeveloper = Schema.decodeUnknownOption(PerDeveloperStage);
const decodeTestFileStage = Schema.decodeUnknownOption(TestFileStage);

const isDeployed = Schema.is(Deployed);

/**
 * The environment a stage belongs to: a {@link Deployed} stage is its own, a per-developer
 * stage's is its first part, and a {@link TestFileStage} is `test`. Any other stage fails rather
 * than falling back: an environment not listed in {@link Environment} is one nobody has thought
 * through (its seed, its state store, its policy).
 */
export const environmentOf = (stage: string): Effect.Effect<Environment, UnknownStage> =>
  isDeployed(stage)
    ? Effect.succeed(stage)
    : Option.isSome(decodeTestFileStage(stage))
      ? Effect.succeed("test")
      : Option.match(decodePerDeveloper(stage), {
          onNone: () => Effect.fail(new UnknownStage({ stage })),
          onSome: ({ environment }) => Effect.succeed(environment),
        });

/**
 * A Worker's name on a {@link Deployed} stage, `baton-<worker>-<stage>`: fixed, so its
 * `workers.dev` URL and its log service name survive a destroy and redeploy. A per-developer
 * stage gets `undefined`, which keeps Alchemy's generated name: the integ files deploy the same
 * stack on the same stage side by side, and a fixed name would collide.
 *
 * Changing a deployed Worker's name replaces it, Durable Object storage included.
 */
export const workerNameOf = (stage: string, worker: "website" | "backend"): string | undefined =>
  isDeployed(stage) ? `baton-${worker}-${stage}` : undefined;

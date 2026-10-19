/**
 * The stage config stack: saves a deployed stage's externally issued values, read from
 * `.env.<stage>`, as {@link StageConfig}'s record in the state store. It declares no resources, so
 * a deploy creates nothing in Cloudflare and only writes the record. Every stage whose environment
 * is not {@link Deployed} is refused before anything is written.
 *
 * Run from a laptop, never from Workers Builds: `vp run stage-config --stage staging`.
 *
 * @module
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { StageConfig, type StageConfigValues, stageState } from "../src/backend/stack.ts";
import { Deployed } from "../src/backend/stage.ts";
import { shopifyPartnerConfig } from "../src/backend/shopify-partner.ts";

export class NotDeployedStage extends Schema.TaggedError<NotDeployedStage>()("NotDeployedStage", {
  stage: Schema.String,
}) {
  override get message() {
    return `stage config is for ${Deployed.literals.join(", ")} only, not stage "${this.stage}"`;
  }
}

export default StageConfig.make(
  {
    providers: Cloudflare.providers(),
    state: stageState,
    secrets: Alchemy.Secrets.DotEnv(({ stage }) => ({ path: `.env.${stage}` })),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    yield* Schema.decodeUnknownEffect(Deployed)(stage).pipe(
      Effect.mapError(() => new NotDeployedStage({ stage })),
      Effect.orDie,
    );
    return {
      SHOPIFY_API_KEY: yield* Config.NonEmptyString("SHOPIFY_API_KEY"),
      SHOPIFY_API_SECRET: yield* Config.schema(
        Schema.Redacted(Schema.NonEmptyString),
        "SHOPIFY_API_SECRET",
      ),
      ...(yield* shopifyPartnerConfig),
      // `make` infers the record's type on its own and never checks it against the handle's shape,
      // so only this `satisfies` turns a field added to the handle but not read here into a type error.
    } satisfies StageConfigValues;
  }),
);

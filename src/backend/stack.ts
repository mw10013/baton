/**
 * What both stacks, the real one and the integ harness's, share: the state store and the
 * Backend's wiring. Stack-time only; the Backend bundle never imports it.
 *
 * @module
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { DeliveryMode } from "./magic-link-delivery.ts";
import { seed } from "./seed.ts";
import { SHOPIFY_API_KEY, SHOPIFY_API_SECRET_FAKE } from "./shopify.ts";
import {
  SHOPIFY_PARTNER_CONFIG_FAKE,
  type ShopifyPartnerConfig,
  shopifyPartnerConfig,
} from "./shopify-partner.ts";
import { environmentOf } from "./stage.ts";
import type Backend from "./worker.ts";

/**
 * The fields of {@link StageConfig}'s record, named after the bindings they become.
 *
 * The rule for where a value lives: a value another service issues for a stage (a Shopify app's
 * key, secret, handle and Partner ids, a Partner API token) comes through configuration, `.env`
 * in dev and e2e and this record on a deployed stage; a value Baton defines (plan and meter
 * handles, entitlements, API versions) lives in code.
 */
export interface StageConfigValues {
  readonly SHOPIFY_API_KEY: string;
  readonly SHOPIFY_API_SECRET: Redacted.Redacted<string>;
  readonly SHOPIFY_APP_HANDLE: string;
  readonly SHOPIFY_PARTNER_ORG_ID: string;
  readonly SHOPIFY_PARTNER_APP_ID: string;
  readonly SHOPIFY_PARTNER_API_TOKEN: Redacted.Redacted<string>;
}

/**
 * The values another service issues for a deployed stage, held as the output of their own stack
 * so that a deploy in Workers Builds, which has no way to receive them as environment variables,
 * reads them from the state store instead. A secret is `Redacted`, which is what binds it as a
 * Worker secret. Deployed by hand from a laptop, before any deploy of code that reads a new
 * field; every deploy writes the whole record. The stack name is a logical id in state: renaming
 * it orphans every stage's record.
 */
export class StageConfig extends Alchemy.Stack<StageConfig, StageConfigValues>()(
  "baton-stage-config",
) {}

/**
 * The stack's state store, chosen by the stage's environment. State lives where the resources
 * live: `dev`, `test` and `e2e` run entirely in workerd and its simulators, so their state is
 * local under `.alchemy/` and goes with the checkout's local data; `staging` runs in Cloudflare,
 * so its state does too. A per-developer environment that gains a resource running live under
 * `alchemy dev` (`Alchemy.remote()`, or a service with no local simulator) moves to
 * `Cloudflare.state()` when that resource lands, or its records outlive or lose the resource.
 *
 * `Test.make`'s own `state` option is built outside the stage, so integ files pass none and the
 * harness uses this layer from the stack.
 */
export const stageState = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
    return Match.value(environment).pipe(
      Match.whenOr("dev", "test", "e2e", () => Alchemy.localState()),
      Match.when("staging", () => Cloudflare.state()),
      Match.exhaustive,
    );
  }),
);

/** A real Shopify app's credentials, as {@link ShopifyApp} chooses them. */
export interface ShopifyAppConfig {
  readonly apiKey: string | Alchemy.Output<string>;
  readonly apiSecret: Redacted.Redacted<string> | Alchemy.Output<Redacted.Redacted<string>>;
  /** The app's public URL when it is not the Website's own: Shopify CLI's tunnel. */
  readonly appUrl: Option.Option<string>;
}

/**
 * Shopify CLI's app, `Some` only when all three variables are present. The CLI injects them into
 * the web command it runs, so they exist only under `shopify app dev`, which runs `alchemy dev`
 * as that command. The process environment wins over `.env`, so `.env` cannot shadow them.
 */
const shopifyCliApp = Config.all({
  appUrl: Config.option(Config.String("APP_URL")),
  apiKey: Config.option(Config.String("SHOPIFY_API_KEY")),
  apiSecret: Config.option(Config.Redacted("SHOPIFY_API_SECRET")),
}).pipe(
  Config.map(Option.all),
  Config.map(Option.map((app): ShopifyAppConfig => ({ ...app, appUrl: Option.some(app.appUrl) }))),
);

/**
 * The real Shopify app this stage serves, chosen by the stage's environment; `None` means the
 * fakes in {@link wireBackend} stand in. `staging` reads its app from {@link StageConfig}'s record
 * and never from `Config`, so a stray variable in the Workers Builds environment cannot override
 * it, and a missing record fails the plan rather than falling back to the fakes; its app URL is
 * the Website's own. `dev` and `e2e` serve Shopify CLI's app under `shopify app dev` and the
 * fakes otherwise (a bare `alchemy destroy` of the e2e stage); `test` always uses the fakes.
 */
export const ShopifyApp: Effect.Effect<
  Option.Option<ShopifyAppConfig>,
  Config.ConfigError,
  Alchemy.Stage
> = Effect.gen(function* () {
  const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
  return yield* Match.value(environment).pipe(
    Match.when("staging", () =>
      Effect.map(StageConfig, (record) =>
        Option.some<ShopifyAppConfig>({
          apiKey: record.SHOPIFY_API_KEY,
          apiSecret: record.SHOPIFY_API_SECRET,
          appUrl: Option.none(),
        }),
      ),
    ),
    Match.whenOr("dev", "e2e", () => shopifyCliApp),
    Match.when("test", () => Effect.succeedNone),
    Match.exhaustive,
  );
});

/** {@link ShopifyPartnerConfig} as the stack binds it: plain, or the stage config record's outputs. */
type ShopifyPartnerBinding = {
  readonly [K in keyof ShopifyPartnerConfig]:
    | (K extends "SHOPIFY_PARTNER_API_TOKEN" ? Redacted.Redacted<string> : string)
    | Alchemy.Output<K extends "SHOPIFY_PARTNER_API_TOKEN" ? Redacted.Redacted<string> : string>;
};

/**
 * The Partner values ({@link ShopifyPartnerConfig}) this stage binds, chosen by its environment as
 * {@link ShopifyApp} chooses the app: `staging` from {@link StageConfig}'s record; `dev` and `e2e`
 * from the checkout's `.env` (Alchemy loads it), and the fakes when they are absent (a bare
 * `alchemy destroy`), where a Partner call then fails and the gate answers an error, never a
 * subscription; `test` always the fakes ({@link SHOPIFY_PARTNER_CONFIG_FAKE}), which the test
 * Backend's Partner and App Events fakes never send anywhere.
 */
const shopifyPartnerBinding: Effect.Effect<
  ShopifyPartnerBinding,
  Config.ConfigError,
  Alchemy.Stage
> = Effect.gen(function* () {
  const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
  const fake: ShopifyPartnerBinding = {
    ...SHOPIFY_PARTNER_CONFIG_FAKE,
    SHOPIFY_PARTNER_API_TOKEN: Redacted.make(SHOPIFY_PARTNER_CONFIG_FAKE.SHOPIFY_PARTNER_API_TOKEN),
  };
  return yield* Match.value(environment).pipe(
    Match.when("staging", () =>
      Effect.map(StageConfig, (record): ShopifyPartnerBinding => ({
        SHOPIFY_APP_HANDLE: record.SHOPIFY_APP_HANDLE,
        SHOPIFY_PARTNER_ORG_ID: record.SHOPIFY_PARTNER_ORG_ID,
        SHOPIFY_PARTNER_APP_ID: record.SHOPIFY_PARTNER_APP_ID,
        SHOPIFY_PARTNER_API_TOKEN: record.SHOPIFY_PARTNER_API_TOKEN,
      })),
    ),
    Match.whenOr("dev", "e2e", () =>
      Config.option(shopifyPartnerConfig).pipe(
        Effect.map(
          Option.match({
            onNone: () => fake,
            onSome: (values): ShopifyPartnerBinding => values,
          }),
        ),
      ),
    ),
    Match.when("test", () => Effect.succeed(fake)),
    Match.exhaustive,
  );
});

/**
 * Seeds the stage and binds the Backend's configuration. The two stacks differ only in the
 * options; every other binding is here, so a new one is added once. The binding names are
 * logical ids in state: renaming one recreates it on every stage.
 *
 * The Shopify API key and secret are the real app's where {@link ShopifyApp} has one and the fake
 * app's elsewhere ({@link SHOPIFY_API_KEY}, {@link SHOPIFY_API_SECRET_FAKE}), so a test signs
 * merchant tokens the Backend accepts. `appUrl` is the Website's URL, used unless the real app
 * has its own.
 */
export const wireBackend = Effect.fn("wireBackend")(function* (
  backend: Pick<Effect.Success<typeof Backend>, "bind" | "url">,
  options: {
    readonly authOrigin: Alchemy.Output<string | undefined>;
    readonly appUrl: Alchemy.Output<string | undefined>;
    readonly delivery: DeliveryMode;
  },
) {
  yield* seed(backend);
  yield* backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: options.authOrigin } });
  yield* backend.bind("MagicLinkDelivery", { env: { MAGIC_LINK_DELIVERY: options.delivery } });
  const app = yield* ShopifyApp;
  yield* backend.bind("Shopify", {
    env: Option.match(app, {
      onNone: () => ({
        SHOPIFY_API_KEY: SHOPIFY_API_KEY,
        SHOPIFY_API_SECRET: Redacted.make(SHOPIFY_API_SECRET_FAKE),
        SHOPIFY_APP_URL: options.appUrl,
      }),
      onSome: ({ apiKey, apiSecret, appUrl }) => ({
        SHOPIFY_API_KEY: apiKey,
        SHOPIFY_API_SECRET: apiSecret,
        SHOPIFY_APP_URL: Option.getOrElse(appUrl, () => options.appUrl),
      }),
    }),
  });
  yield* backend.bind("ShopifyPartner", { env: yield* shopifyPartnerBinding });
  const environment = yield* environmentOf(yield* Alchemy.Stage).pipe(Effect.orDie);
  // The dev procedures replace and age a shop's data, so only the per-developer environments,
  // whose data is disposable, mount them; staging never does.
  yield* Match.value(environment).pipe(
    Match.whenOr("dev", "test", "e2e", () => backend.bind("Dev", { env: { DEV_ENDPOINT: "on" } })),
    Match.when("staging", () => Effect.void),
    Match.exhaustive,
  );
  // Staging alone logs every orders counts read at info, to measure how often one is cold.
  yield* Match.value(environment).pipe(
    Match.when("staging", () => backend.bind("OrderFactsLog", { env: { ORDER_FACTS_LOG: "on" } })),
    Match.whenOr("dev", "test", "e2e", () => Effect.void),
    Match.exhaustive,
  );
});

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { DeliveryMode } from "./src/backend/magic-link-delivery.ts";
import { SHOPIFY_API_KEY } from "./src/backend/shopify.ts";
import Backend from "./src/backend/worker.ts";
import { ShopifyApp, stageState, wireBackend } from "./src/backend/stack.ts";
import { environmentOf, workerNameOf } from "./src/backend/stage.ts";

/**
 * The TanStack Start app. `alchemy dev` serves it on `WEBSITE_PORT` from the checkout's `.env`
 * (Alchemy loads `.env` itself); deploys never read it. `strictPort` makes a collision fail
 * instead of silently moving ports.
 *
 * `SHOPIFY_API_KEY` goes into the App Home's page, so it is public; the secret stays on the
 * Backend. It is the real app's where {@link ShopifyApp} has one and the fake key elsewhere;
 * `SHOPIFY_APP_URL` is the real app's own URL when it has one and the Website's otherwise.
 *
 * `DEV_KIT` is `on` where the stage's environment is one whose data is disposable (`dev`, `test`,
 * `e2e`, the environments whose Backend mounts the dev procedures), and `off` on staging: the kit
 * page (`/dev/kit`) is not found unless it is on.
 */
export class Website extends Cloudflare.Website.Vite<Website>()(
  "Website",
  Effect.gen(function* () {
    const dev = (yield* Alchemy.ALCHEMY_DEV)
      ? { port: yield* Config.Port("WEBSITE_PORT"), strictPort: true }
      : undefined;
    const app = yield* ShopifyApp;
    const environment = yield* environmentOf(yield* Alchemy.Stage);
    return {
      name: workerNameOf(yield* Alchemy.Stage, "website"),
      compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
      dev,
      env: {
        BACKEND: Backend,
        SHOPIFY_API_KEY: Option.match(app, {
          onNone: () => SHOPIFY_API_KEY,
          onSome: ({ apiKey }) => apiKey,
        }),
        SHOPIFY_APP_URL: Option.match(
          Option.flatMap(app, ({ appUrl }) => appUrl),
          {
            onNone: () => Cloudflare.Worker.URL,
            onSome: (appUrl) => appUrl,
          },
        ),
        DEV_KIT: Match.value(environment).pipe(
          Match.whenOr("dev", "test", "e2e", () => "on"),
          Match.when("staging", () => "off"),
          Match.exhaustive,
        ),
      },
    };
  }).pipe(Effect.orDie),
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

/**
 * The state store follows the stage's environment ({@link stageState}).
 *
 * Magic links are delivered inline under `alchemy dev`, where the sign-in page shows them to the
 * developer and to the e2e specs; every deployed stage mails them.
 */
export default Alchemy.Stack(
  "baton",
  { providers: Cloudflare.providers(), state: stageState },
  Effect.gen(function* () {
    const website = yield* Website;
    const backend = yield* Backend;
    const delivery: DeliveryMode = (yield* Alchemy.ALCHEMY_DEV) ? "inline" : "mailed";
    yield* wireBackend(backend, {
      // Better Auth in the Backend builds magic links on the Website's origin. The Website
      // already binds the Backend, so its URL is attached as a binding, which may form a
      // cycle, rather than as a Backend prop. Under alchemy dev it is the local dev URL.
      authOrigin: website.url,
      appUrl: website.url,
      delivery,
    });
    return { websiteUrl: website.url.as<string>(), backendUrl: backend.url.as<string>() };
  }),
);

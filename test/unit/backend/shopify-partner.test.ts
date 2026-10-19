import { describe, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  planSelectionExitIframeHref,
  ShopifyPartner,
  ShopifyPartnerConfig,
  shopifyPartnerConfig,
} from "../../../src/backend/shopify-partner.ts";
import { ShopKey } from "../../../src/domain/platform.ts";
import { QuietLogs } from "./layers.ts";

/**
 * The Partner API client against a recorded transport: the decode of `activeSubscription`'s
 * answer and `matchPlanHandle`'s rule (legacy has no tests for either; these titles are new).
 */
const config = Schema.decodeUnknownSync(ShopifyPartnerConfig)({
  SHOPIFY_APP_HANDLE: "baton-local",
  SHOPIFY_PARTNER_ORG_ID: "2798461",
  SHOPIFY_PARTNER_APP_ID: "417214922753",
  SHOPIFY_PARTNER_API_TOKEN: Redacted.make("prtapi_test"),
});

interface Recorded {
  readonly url: string;
  readonly body: string;
}

const run = <A, E>(
  effect: Effect.Effect<A, E, ShopifyPartner>,
  answer: unknown,
  recorded: Array<Recorded> = [],
) =>
  effect.pipe(
    Effect.provide(
      Layer.provide(
        ShopifyPartner.layerWith(config),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request, url) =>
            Effect.sync(() => {
              recorded.push({
                url: url.toString(),
                body:
                  request.body._tag === "Uint8Array"
                    ? new TextDecoder().decode(request.body.body)
                    : "",
              });
              return HttpClientResponse.fromWeb(request, Response.json(answer));
            }),
          ),
        ),
      ),
    ),
    Effect.provide(QuietLogs),
  );

const activeSubscription = (items: ReadonlyArray<string | null>, rest: object = {}) => ({
  data: {
    activeSubscription: {
      items: items.map((handle) => ({ handle })),
      currentBillingCycle: null,
      trialEndsAt: null,
      ...rest,
    },
  },
});

const ask = Effect.flatMap(ShopifyPartner, (partner) =>
  partner.activeSubscription("gid://shopify/Shop/1"),
);

describe("ShopifyPartner.activeSubscription", () => {
  it.effect("a trial answers the plan and the trial's end, with no billing cycle, at 2026-10", () =>
    Effect.gen(function* () {
      const recorded: Array<Recorded> = [];
      // The answer both mw10013 stores gave on 2026-10-18, a Basic trial.
      const answer = yield* run(
        ask,
        activeSubscription(["baton-basic", "production-orders", "members"], {
          trialEndsAt: "2026-10-20T00:21:02Z",
        }),
        recorded,
      );
      deepStrictEqual(
        answer,
        Option.some({
          handle: "baton-basic" as const,
          boundaryAt: Date.parse("2026-10-20T00:21:02Z"),
          cycleStartAt: null,
        }),
      );
      strictEqual(
        recorded[0]?.url,
        "https://partners.shopify.com/2798461/api/2026-10/graphql.json",
      );
      strictEqual(recorded[0]?.body.includes('"appId":"gid://shopify/App/417214922753"'), true);
    }),
  );

  it.effect("a billing cycle answers its start and its end as the boundary", () =>
    Effect.gen(function* () {
      const answer = yield* run(
        ask,
        activeSubscription(["baton-pro", "members"], {
          currentBillingCycle: {
            startTime: "2026-10-01T00:00:00Z",
            endTime: "2026-11-01T00:00:00Z",
          },
        }),
      );
      deepStrictEqual(
        answer,
        Option.some({
          handle: "baton-pro" as const,
          boundaryAt: Date.parse("2026-11-01T00:00:00Z"),
          cycleStartAt: Date.parse("2026-10-01T00:00:00Z"),
        }),
      );
    }),
  );

  it.effect("an app subscription carrying no known plan handle is no plan", () =>
    Effect.gen(function* () {
      const answer = yield* run(ask, activeSubscription(["baton-enterprise", "members"]));
      strictEqual(Option.isNone(answer), true);
    }),
  );

  it.effect("an app subscription carrying two known plan handles is no plan", () =>
    Effect.gen(function* () {
      const answer = yield* run(ask, activeSubscription(["baton-basic", "baton-pro"]));
      strictEqual(Option.isNone(answer), true);
    }),
  );

  it.effect("no app subscription is no plan", () =>
    Effect.gen(function* () {
      const answer = yield* run(ask, { data: { activeSubscription: null } });
      strictEqual(Option.isNone(answer), true);
    }),
  );

  it.effect("a GraphQL error is a ShopifyPartnerError, never no plan", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(ask, {
          errors: [{ message: "Invalid GID app name 'partners'. Use 'shopify' instead" }],
          data: { activeSubscription: null },
        }),
      );
      strictEqual(error._tag, "ShopifyPartnerError");
      strictEqual(error.message.includes("Invalid GID"), true);
    }),
  );
});

describe("ShopifyPartner.planSelectionUrl", () => {
  it.effect(
    "the pricing page is the store's charges page under the app's handle, out of the frame",
    () =>
      Effect.gen(function* () {
        const shop = Schema.decodeUnknownSync(ShopKey)("mw10013-dev-shop-00.myshopify.com");
        const url = yield* run(
          Effect.map(ShopifyPartner, (partner) => partner.planSelectionUrl(shop)),
          {},
        );
        strictEqual(
          url,
          "https://admin.shopify.com/store/mw10013-dev-shop-00/charges/baton-local/pricing_plans",
        );
        strictEqual(
          planSelectionExitIframeHref(url, shop),
          `/auth/exit-iframe?exitIframe=${encodeURIComponent(url)}&shop=${shop}`,
        );
      }),
  );
});

describe("ShopifyPartnerConfig", () => {
  it.effect("the stage's four values decode from configuration, the token redacted", () =>
    Effect.gen(function* () {
      const values = yield* shopifyPartnerConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SHOPIFY_APP_HANDLE: "baton-local",
              SHOPIFY_PARTNER_ORG_ID: "2798461",
              SHOPIFY_PARTNER_APP_ID: "417214922753",
              SHOPIFY_PARTNER_API_TOKEN: "prtapi_test",
            }),
          ),
        ),
      );
      strictEqual(values.SHOPIFY_APP_HANDLE, "baton-local");
      strictEqual(Redacted.isRedacted(values.SHOPIFY_PARTNER_API_TOKEN), true);
      strictEqual(Redacted.value(values.SHOPIFY_PARTNER_API_TOKEN), "prtapi_test");
      const refused = yield* Effect.flip(
        shopifyPartnerConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                SHOPIFY_APP_HANDLE: "Baton Local",
                SHOPIFY_PARTNER_ORG_ID: "2798461",
                SHOPIFY_PARTNER_APP_ID: "417214922753",
                SHOPIFY_PARTNER_API_TOKEN: "prtapi_test",
              }),
            ),
          ),
        ),
      );
      strictEqual(refused._tag, "ConfigError");
    }),
  );
});

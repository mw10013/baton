import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  flow,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as Domain from "@/lib/Domain";

export class ShopifyPartnerError extends Schema.TaggedError<ShopifyPartnerError>()(
  "ShopifyPartnerError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Partner API version for the `activeSubscription` query.
 *
 * `activeSubscription` and its supporting types are only available in the
 * `2026-07` release candidate and `unstable` — querying `2026-04` (or any
 * earlier stable version) returns
 * `Field 'activeSubscription' doesn't exist on type 'QueryRoot'`.
 *
 * Revisit when `2026-07` graduates to stable, and again if Shopify backports
 * the query to an earlier stable version.
 */
const PARTNER_API_VERSION = "2026-07";

const activeSubscriptionQuery = `query ActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    items { handle }
    currentBillingCycle { endTime }
    trialEndsAt
  }
}`;

const partnerError = (message: string) => (cause: unknown) =>
  new ShopifyPartnerError({ message, cause });

const ActiveSubscriptionResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      activeSubscription: Schema.NullOr(
        Schema.Struct({
          items: Schema.Array(
            Schema.Struct({
              handle: Schema.NullOr(Schema.String),
            }),
          ),
          currentBillingCycle: Schema.NullOr(
            Schema.Struct({ endTime: Schema.NullOr(Schema.String) }),
          ),
          trialEndsAt: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String })),
  ),
});

const decodePlanHandle = Schema.decodeUnknownOption(Domain.PlanHandle);

const parseBoundary = (value: string | null): number | null => {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export class ShopifyPartner extends Context.Service<
  ShopifyPartner,
  {
    /**
     * Resolves a shop's App Pricing contract to the plan it grants.
     *
     * `Option.none()` is a verified negative — no contract, or one this app
     * cannot interpret — and never an "unknown". Every failure to reach an
     * answer stays in the error channel, because callers gate access on this
     * value and must not confuse "could not check" with "not subscribed".
     *
     * The plan is identified by matching `items` against the handle allowlist,
     * never by position: usage and event-meter items share that array with the
     * plan item. Zero matches (a catalog change) and more than one (a contract
     * shape we do not model) both resolve to `Option.none()` rather than a
     * guess, and log a warning — allowlist drift is operationally interesting
     * even though the response to it is simply no access.
     *
     * Contract presence is the whole signal. `activeSubscription` exposes no
     * status field, and App Pricing sends no webhooks, so nothing distinguishes
     * a frozen contract from a paying one and nothing here tries to.
     */
    readonly activeSubscription: (
      shopGid: Domain.ShopGid,
    ) => Effect.Effect<
      Option.Option<Domain.ActiveSubscription>,
      ShopifyPartnerError
    >;
    readonly planSelectionUrl: (shop: string) => string;
  }
>()("ShopifyPartner") {
  static readonly layer = Layer.effect(
    ShopifyPartner,
    Effect.gen(function* () {
      const { orgId, appId, appHandle, apiToken } = yield* Config.all({
        orgId: Config.nonEmptyString("SHOPIFY_PARTNER_ORG_ID"),
        appId: Config.nonEmptyString("SHOPIFY_PARTNER_APP_ID"),
        appHandle: Config.nonEmptyString("SHOPIFY_APP_HANDLE"),
        apiToken: Config.nonEmptyString("SHOPIFY_PARTNER_API_TOKEN").pipe(
          Config.map(Redacted.make),
        ),
      });
      const endpoint = `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`;
      const appGid = `gid://shopify/App/${appId}`;

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader(
              "X-Shopify-Access-Token",
              Redacted.value(apiToken),
            ),
          ),
        ),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({
          schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
          times: 2,
        }),
      );

      const activeSubscription = Effect.fn("ShopifyPartner.activeSubscription")(
        function* (shopGid: Domain.ShopGid) {
          yield* Effect.annotateCurrentSpan({ shopGid });
          const { data, errors } = yield* HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              query: activeSubscriptionQuery,
              variables: { appId: appGid, shopId: shopGid },
            }),
            client.execute,
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(ActiveSubscriptionResponse),
            ),
            Effect.mapError(partnerError("Partner API request failed")),
          );
          if (errors && errors.length > 0) {
            return yield* new ShopifyPartnerError({
              message: errors.map((e) => e.message).join("; "),
              cause: errors,
            });
          }
          const subscription = data?.activeSubscription;
          if (!subscription) return Option.none();
          const handles = subscription.items.flatMap((item) =>
            Option.toArray(decodePlanHandle(item.handle)),
          );
          const [handle] = handles;
          if (handle === undefined || handles.length > 1) {
            yield* Effect.logWarning(
              `ShopifyPartner.activeSubscription: shopGid=${shopGid} matches=${String(handles.length)}: contract carries no single known plan handle`,
            ).pipe(
              Effect.annotateLogs({
                shopGid,
                handles: subscription.items.map((item) => item.handle),
              }),
            );
            return Option.none();
          }
          return Option.some({
            handle,
            boundaryAt: parseBoundary(
              subscription.currentBillingCycle?.endTime ??
                subscription.trialEndsAt,
            ),
          } satisfies Domain.ActiveSubscription);
        },
      );

      const planSelectionUrl = (shop: string) =>
        `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/u, "")}/charges/${appHandle}/pricing_plans`;

      return ShopifyPartner.of({ activeSubscription, planSelectionUrl });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

/**
 * Where an unsubscribed merchant is sent, as an `/app`-relative href.
 *
 * Shopify's plan selection page lives on `admin.shopify.com`, which cannot
 * render inside the embedded app iframe, so the navigation has to break out of
 * the frame first — hence `/auth/exit-iframe` rather than the pricing URL
 * directly. Shared by every gate that can reach this conclusion: the `/app`
 * route boundary and the loaders whose server functions resolve the plan on
 * their own request, where a cache entry can expire between the boundary check
 * and the loader.
 */
export const planSelectionExitIframeHref = (
  planSelectionUrl: string,
  shop: Domain.Shop,
) =>
  `/auth/exit-iframe?exitIframe=${encodeURIComponent(planSelectionUrl)}&shop=${shop}`;

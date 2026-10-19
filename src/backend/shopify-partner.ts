import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { ShopKey } from "../contract/shop.ts";
import { type AppSubscription, PlanHandle } from "../domain/billing.ts";

/**
 * A Shopify app's URL handle: the `<handle>` of its pricing page,
 * `admin.shopify.com/store/<store>/charges/<handle>/pricing_plans`, and of the `User-Agent` its
 * App Events requests carry. Shopify's handles are lowercase letters, digits and dashes.
 */
export const AppHandle = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9-]+$/u)).pipe(
  Schema.brand("AppHandle"),
);
export type AppHandle = typeof AppHandle.Type;

/** A Partner Dashboard id (an organization's or an app's): the digits in its URL. */
export const PartnerId = Schema.NonEmptyString.check(Schema.isPattern(/^[0-9]+$/u));

/**
 * The values a Shopify app's Partner organization issues for one stage, beyond the app's key and
 * secret: its handle, the organization and app ids, and a Partner API token with **Manage
 * apps**. Declared once, here: the stack reads them (from `.env` in dev and e2e, from the stage
 * config record on staging), binds them to the Backend under these names, and the Backend's
 * services read them back through this schema.
 */
export const ShopifyPartnerConfig = Schema.Struct({
  SHOPIFY_APP_HANDLE: AppHandle,
  SHOPIFY_PARTNER_ORG_ID: PartnerId,
  SHOPIFY_PARTNER_APP_ID: PartnerId,
  SHOPIFY_PARTNER_API_TOKEN: Schema.Redacted(Schema.NonEmptyString),
});
export type ShopifyPartnerConfig = typeof ShopifyPartnerConfig.Type;

/**
 * {@link ShopifyPartnerConfig} read through `Config` one key at a time, then decoded by the
 * schema: a `Config.schema` of the whole struct finds nothing among a Worker's bindings, which
 * answer one name at a time (measured 2026-10-18 under `alchemy dev`, where the Backend's init
 * died on it). The stack reads `.env` and the stage config with it; the Backend reads its
 * binding with {@link shopifyPartnerBinding}.
 */
export const shopifyPartnerConfig: Config.Config<ShopifyPartnerConfig> = Config.all({
  SHOPIFY_APP_HANDLE: Config.String("SHOPIFY_APP_HANDLE"),
  SHOPIFY_PARTNER_ORG_ID: Config.String("SHOPIFY_PARTNER_ORG_ID"),
  SHOPIFY_PARTNER_APP_ID: Config.String("SHOPIFY_PARTNER_APP_ID"),
  SHOPIFY_PARTNER_API_TOKEN: Config.Redacted("SHOPIFY_PARTNER_API_TOKEN"),
}).pipe(
  Config.mapEffect((values) =>
    Schema.decodeUnknownEffect(ShopifyPartnerConfig)(values).pipe(
      Effect.mapError((issue) => new Config.ConfigError(issue)),
    ),
  ),
);

/**
 * The test stage's stand-ins: the fakes answer for the Partner API and App Events there, so no
 * value reaches Shopify; they only have to decode.
 */
export const SHOPIFY_PARTNER_CONFIG_FAKE = {
  SHOPIFY_APP_HANDLE: "baton-test",
  SHOPIFY_PARTNER_ORG_ID: "1",
  SHOPIFY_PARTNER_APP_ID: "1",
  SHOPIFY_PARTNER_API_TOKEN: "fake-partner-api-token",
} as const;

/** {@link SHOPIFY_PARTNER_CONFIG_FAKE}, decoded: the token is a `Redacted` value, not a string. */
export const shopifyPartnerConfigFake = (): ShopifyPartnerConfig =>
  Schema.decodeUnknownSync(ShopifyPartnerConfig)({
    ...SHOPIFY_PARTNER_CONFIG_FAKE,
    SHOPIFY_PARTNER_API_TOKEN: Redacted.make(SHOPIFY_PARTNER_CONFIG_FAKE.SHOPIFY_PARTNER_API_TOKEN),
  });

/** A binding's raw value, a string or, for a digits-only one, a number; see {@link shopifyPartnerBinding}. */
const decodeBindingId = Schema.decodeUnknownEffect(
  Schema.Union([
    PartnerId,
    Schema.Int.pipe(
      Schema.decodeTo(
        PartnerId,
        SchemaTransformation.transform({ decode: (n) => String(n), encode: (id) => Number(id) }),
      ),
    ),
  ]),
);

/**
 * The `ShopifyPartner` binding as the running Backend reads it, or `None` when it is not bound
 * (planning). The ids are read off the provider's node rather than through `Config.String`:
 * Alchemy hands a digits-only bound value back to the Worker as a number (measured 2026-10-18
 * under `alchemy dev`: the node for `SHOPIFY_PARTNER_ORG_ID` was `{ _tag: "Value", value:
 * 2798461 }`), which every `Config` scalar refuses.
 */
export const shopifyPartnerBinding = Effect.gen(function* () {
  const provider = yield* ConfigProvider.ConfigProvider;
  const id = Effect.fn("ShopifyPartner.bindingId")(function* (name: string) {
    const node = yield* provider.load([name]).pipe(Effect.orDie);
    if (node === undefined || node._tag !== "Value") return Option.none<string>();
    return Option.some(yield* decodeBindingId(node.value).pipe(Effect.orDie));
  });
  const rest = yield* Config.option(
    Config.all({
      SHOPIFY_APP_HANDLE: Config.String("SHOPIFY_APP_HANDLE"),
      SHOPIFY_PARTNER_API_TOKEN: Config.Redacted("SHOPIFY_PARTNER_API_TOKEN"),
    }),
  ).pipe(Effect.orDie);
  const orgId = yield* id("SHOPIFY_PARTNER_ORG_ID");
  const appId = yield* id("SHOPIFY_PARTNER_APP_ID");
  if (Option.isNone(rest) || Option.isNone(orgId) || Option.isNone(appId))
    return Option.none<ShopifyPartnerConfig>();
  return Option.some(
    yield* Schema.decodeUnknownEffect(ShopifyPartnerConfig)({
      ...rest.value,
      SHOPIFY_PARTNER_ORG_ID: orgId.value,
      SHOPIFY_PARTNER_APP_ID: appId.value,
    }).pipe(Effect.orDie),
  );
});

export class ShopifyPartnerError extends Schema.TaggedError<ShopifyPartnerError>()(
  "ShopifyPartnerError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Partner API version for the `activeSubscription` query, pinned in code.
 *
 * Legacy pinned `2026-07`, the release candidate, because `activeSubscription` existed in no
 * stable version. It is on the stable `2026-10` (measured 2026-10-18: both stores answered at
 * `2026-10` and at `2026-07`). Revisit when `2026-10` leaves the support window.
 */
export const PARTNER_API_VERSION = "2026-10";

const activeSubscriptionQuery = `query ActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    items {
      handle
    }
    currentBillingCycle {
      startTime
      endTime
    }
    trialEndsAt
  }
}`;

const partnerError = (message: string) => (cause: unknown) =>
  new ShopifyPartnerError({ message, cause });

/**
 * Every field past `items.handle` is `optional` or `NullOr`, so a response that
 * omits one still decodes into a usable answer. The plan gate runs off this
 * decode, and losing a shop's access because Shopify stopped returning a
 * display-only field would be the worst possible trade.
 */
const SubscriptionItem = Schema.Struct({
  handle: Schema.NullOr(Schema.String),
});

const AppSubscriptionResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      activeSubscription: Schema.NullOr(
        Schema.Struct({
          items: Schema.Array(SubscriptionItem),
          currentBillingCycle: Schema.NullOr(
            Schema.Struct({
              startTime: Schema.optional(Schema.NullOr(Schema.String)),
              endTime: Schema.NullOr(Schema.String),
            }),
          ),
          trialEndsAt: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

const decodePlanHandle = Schema.decodeUnknownOption(PlanHandle);
const decodeInstant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

/** An ISO instant as epoch ms, or null when absent or unreadable. */
const parseBoundary = (value: string | null | undefined): number | null =>
  Option.getOrNull(Option.map(decodeInstant(value), DateTime.toEpochMillis));

/**
 * The one allowlisted plan handle in a list of subscription items, or
 * `Option.none()`.
 *
 * Matching, never position: the usage meter is its own item in the same array,
 * and so is anything else Shopify decides to itemize (measured 2026-10-18: a
 * Basic subscription answers `baton-basic`, `production-orders` and `members` as
 * three items). Zero matches (a catalog
 * change) and more than one (an app subscription shape this app does not model)
 * are both `Option.none()` rather than a guess, and both log — allowlist drift
 * is operationally interesting even where the response to it is simply no
 * answer.
 */
const matchPlanHandle = Effect.fn("ShopifyPartner.matchPlanHandle")(function* (
  shopGid: string,
  items: ReadonlyArray<{ readonly handle: string | null }>,
) {
  const handles = items.flatMap((item) => Option.toArray(decodePlanHandle(item.handle)));
  const [handle] = handles;
  if (handle === undefined || handles.length > 1) {
    yield* Effect.logWarning(
      `ShopifyPartner.activeSubscription: shopGid=${shopGid} matches=${String(handles.length)}: app subscription carries no single known plan handle`,
    ).pipe(
      Effect.annotateLogs({
        shopGid,
        handles: items.map((item) => item.handle),
      }),
    );
    return Option.none<PlanHandle>();
  }
  return Option.some(handle);
});

const make = Effect.fn("ShopifyPartner.make")(function* ({
  SHOPIFY_APP_HANDLE: appHandle,
  SHOPIFY_PARTNER_ORG_ID: orgId,
  SHOPIFY_PARTNER_APP_ID: appId,
  SHOPIFY_PARTNER_API_TOKEN: apiToken,
}: ShopifyPartnerConfig) {
  const endpoint = `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`;
  /** `activeSubscription` takes the Admin form; the Partner API's own `app(id:)` takes `gid://partners/App/…`. */
  const appGid = `gid://shopify/App/${appId}`;

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("X-Shopify-Access-Token", Redacted.value(apiToken)),
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
      times: 2,
    }),
  );

  const activeSubscription = Effect.fn("ShopifyPartner.activeSubscription")(function* (
    shopGid: string,
  ) {
    yield* Effect.annotateCurrentSpan({ shopGid });
    const { data, errors } = yield* HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        query: activeSubscriptionQuery,
        variables: { appId: appGid, shopId: shopGid },
      }),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AppSubscriptionResponse)),
      Effect.mapError(partnerError("Partner API request failed")),
    );
    if (errors !== undefined && errors.length > 0)
      return yield* new ShopifyPartnerError({
        message: errors.map((e) => e.message).join("; "),
        cause: errors,
      });
    const subscription = data?.activeSubscription;
    if (subscription === undefined || subscription === null) return Option.none<AppSubscription>();
    const handle = yield* matchPlanHandle(shopGid, subscription.items);
    if (Option.isNone(handle)) return Option.none<AppSubscription>();
    return Option.some<AppSubscription>({
      handle: handle.value,
      boundaryAt: parseBoundary(
        subscription.currentBillingCycle?.endTime ?? subscription.trialEndsAt,
      ),
      cycleStartAt: parseBoundary(subscription.currentBillingCycle?.startTime ?? null),
    });
  });

  const planSelectionUrl = (shop: ShopKey) =>
    `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/u, "")}/charges/${appHandle}/pricing_plans`;

  return { activeSubscription, planSelectionUrl };
});

/**
 * The Backend's Partner API client, legacy's `ShopifyPartner`: one query, and the plan selection
 * page's URL. Over {@link ShopifyPartnerConfig}, the stage's `ShopifyPartner` binding.
 */
export class ShopifyPartner extends Context.Service<
  ShopifyPartner,
  {
    /**
     * Resolves a shop's app subscription to the plan it grants. The method
     * keeps the name of Shopify's `activeSubscription` query, whose "active"
     * means the app subscription in force now, as opposed to the shop's past
     * ones.
     *
     * `Option.none()` is a verified negative — no app subscription, or one this
     * app cannot interpret — and never an "unknown". Every failure to reach an
     * answer stays in the error channel, because callers gate access on this
     * value and must not confuse "could not check" with "not subscribed".
     *
     * The plan is identified by {@link matchPlanHandle}, never by position.
     * Everything else on the returned value — the boundary and the cycle —
     * is bookkeeping and never gates access: an
     * app subscription with a plan handle grants that plan's entitlements even
     * if every other field is missing.
     *
     * App subscription presence is the whole signal. `activeSubscription`
     * exposes no status field, and App Pricing sends no webhooks, so nothing
     * distinguishes a frozen app subscription from a paying one and nothing
     * here tries to.
     */
    readonly activeSubscription: (
      shopGid: string,
    ) => Effect.Effect<Option.Option<AppSubscription>, ShopifyPartnerError>;
    readonly planSelectionUrl: (shop: ShopKey) => string;
  }
>()("app/ShopifyPartner") {
  /** Over literal values and a caller's `HttpClient`, for tests. */
  static readonly layerWith = (config: ShopifyPartnerConfig) =>
    Layer.effect(ShopifyPartner, make(config));

  /**
   * Over the `ShopifyPartner` binding, with `fetch`. As `Shopify.layer`: absent while the stack is
   * planned, when nothing calls the Partner API; a running Worker without it is broken.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* shopifyPartnerBinding;
      if (Option.isSome(config)) return ShopifyPartner.layerWith(config.value);
      if (globalThis.__ALCHEMY_RUNTIME__)
        return yield* Effect.die(new Error("the ShopifyPartner binding is not bound"));
      return ShopifyPartner.layerWith(shopifyPartnerConfigFake());
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
 * route boundary and the loaders whose Backend calls resolve the plan on
 * their own request, where a cache entry can expire between the boundary check
 * and the loader.
 */
export const planSelectionExitIframeHref = (planSelectionUrl: string, shop: ShopKey) =>
  `/auth/exit-iframe?exitIframe=${encodeURIComponent(planSelectionUrl)}&shop=${shop}`;

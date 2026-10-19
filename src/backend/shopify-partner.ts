import * as Schema from "effect/Schema";

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
 * The test stage's stand-ins: the fakes answer for the Partner API and App Events there, so no
 * value reaches Shopify; they only have to decode.
 */
export const SHOPIFY_PARTNER_CONFIG_FAKE = {
  SHOPIFY_APP_HANDLE: "baton-test",
  SHOPIFY_PARTNER_ORG_ID: "1",
  SHOPIFY_PARTNER_APP_ID: "1",
  SHOPIFY_PARTNER_API_TOKEN: "fake-partner-api-token",
} as const;

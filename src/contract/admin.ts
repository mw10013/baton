/**
 * The admin console's answers across the Backend binding: the Shops list and the shop page,
 * each for an admin only. Every read is loader data; nothing here is live.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { AdminShopPlanCache, ShopUsage } from "../domain/billing.ts";
import { ShopKey, ShopSessionRedacted, ShopSessionRedactedPage } from "../domain/platform.ts";
import { EntitlementsData } from "./billing.ts";

/** The Shops list holds this many shops a page, either way. */
export const SHOP_SESSIONS_PAGE_SIZE = 25;

/**
 * `BackendApi.shopSessionsPage`'s input: a keyset cursor on `shop` one way or the other, never
 * both (the page's loader keeps `after` alone), and the search by shop.
 */
export const ShopSessionsPageRequest = Schema.Struct({
  after: Schema.optional(ShopKey),
  before: Schema.optional(ShopKey),
  filter: Schema.optional(Schema.NonEmptyString),
});
export type ShopSessionsPageRequest = typeof ShopSessionsPageRequest.Type;

/**
 * One page of the Shops list and `now`, the Backend's clock at the read, against which each
 * row's cached plan is judged, so every row on the page is judged at the same instant.
 */
export const ShopSessionsPageData = Schema.Struct({
  page: ShopSessionRedactedPage,
  now: Schema.Number,
});
export type ShopSessionsPageData = typeof ShopSessionsPageData.Type;

/** `BackendApi.adminShop`'s and `BackendApi.refreshPlan`'s input. */
export const AdminShopRequest = Schema.Struct({ shop: ShopKey });
export type AdminShopRequest = typeof AdminShopRequest.Type;

/**
 * The shop page: its redacted `ShopSession` row, the cached plan read off it and what that
 * grants (`null` when it grants nothing), the actor's usage and the D1 member count; or
 * `NotFound` when the shop has no row.
 */
export const AdminShopData = Schema.Union([
  Schema.TaggedStruct("NotFound", {}),
  Schema.TaggedStruct("Found", {
    shopSession: ShopSessionRedacted,
    plan: AdminShopPlanCache,
    entitlements: Schema.NullOr(EntitlementsData),
    /** Read from the shop's actor: the counters the plan is compared against. */
    usage: ShopUsage,
    /** `Member` rows in D1, so the page reads used-of-granted as the App Home does. */
    memberCount: Schema.Number,
  }),
]);
export type AdminShopData = typeof AdminShopData.Type;

/** Refresh plan could not read the shop's app subscription from Shopify; `message` says why. */
export class PlanRefreshFailed extends Schema.TaggedError<PlanRefreshFailed>()(
  "PlanRefreshFailed",
  { message: Schema.String },
) {}

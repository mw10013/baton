import * as Schema from "effect/Schema";
import { ShopKey } from "../domain/platform.ts";

/**
 * `shopAccess`'s input, shared by both sides of the binding; see `ShoutInput`. `sessionToken`
 * is a merchant's Shopify session token; its absence makes the caller a member.
 */
export const ShopAccessInput = Schema.Struct({
  key: ShopKey,
  sessionToken: Schema.optional(Schema.String),
});
export type ShopAccessInput = typeof ShopAccessInput.Type;

/**
 * The caller is signed in, or holds a valid Shopify token, but may not open this shop: an
 * admin, someone with no `Member` row for it, or a token for another shop.
 */
export class NotAShopMember extends Schema.TaggedError<NotAShopMember>()("NotAShopMember", {}) {}

/**
 * A Shopify session token that is malformed, badly signed, for another app, out of date, or one
 * Shopify refused to exchange. It crosses the binding as `authenticateAdmin`'s typed failure.
 */
export class InvalidSessionToken extends Schema.TaggedError<InvalidSessionToken>()(
  "InvalidSessionToken",
  {},
) {}

/**
 * `authenticateAdmin`'s input: the session token App Bridge issued to the embedded page, and
 * `billingRedirect`, true when the page is Shopify's billing redirect back from the plan
 * selection page (its search carries `plan_handle`), which re-reads the plan at once.
 */
export const AuthenticateAdminInput = Schema.Struct({
  sessionToken: Schema.NonEmptyString,
  billingRedirect: Schema.Boolean,
});
export type AuthenticateAdminInput = typeof AuthenticateAdminInput.Type;

/** What the Website learns about an authenticated admin: its shop and the shop's Admin API id. */
export const AdminSession = Schema.Struct({ shop: ShopKey, shopGid: Schema.String });
export type AdminSession = typeof AdminSession.Type;

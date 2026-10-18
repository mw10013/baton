import * as Schema from "effect/Schema";

/**
 * A shop, named by its myshopify domain: Baton's `Shop`, the key of a `ShopSession` row and the
 * name of the shop's actor. Baton's `Shop` is any non-empty string, because it only ever holds
 * what Shopify sent. Here the key also arrives in a URL path, which the route param and the
 * Backend path decode through this before it reaches a query or `getByName`, so it is held to
 * the shape of a myshopify domain.
 */
export const ShopKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/u),
).pipe(Schema.brand("ShopKey"));
export type ShopKey = typeof ShopKey.Type;

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

/** `authenticateAdmin`'s input: the session token App Bridge issued to the embedded page. */
export const AuthenticateAdminInput = Schema.Struct({ sessionToken: Schema.NonEmptyString });
export type AuthenticateAdminInput = typeof AuthenticateAdminInput.Type;

/** What the Website learns about an authenticated admin: its shop and the shop's Admin API id. */
export const AdminSession = Schema.Struct({ shop: ShopKey, shopGid: Schema.String });
export type AdminSession = typeof AdminSession.Type;

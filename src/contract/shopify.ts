/**
 * Why a call that needs the shop's offline session could not act, as a browser and the Backend's
 * callers are told it: the classes cross a socket and the service binding with their fields.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { ShopKey } from "../domain/platform.ts";

/**
 * There is no offline session for the shop: the app was uninstalled or never installed here.
 * A caller does not retry. A webhook has nothing to do for the shop.
 */
export class OfflineSessionMissing extends Schema.TaggedError<OfflineSessionMissing>()(
  "OfflineSessionMissing",
  { shop: ShopKey },
) {}

/**
 * The shop has a session, but only a merchant opening the app (a token exchange) can restore
 * access: it has no refresh token, the refresh token has expired, or Shopify rejected it and no
 * concurrent refresh or exchange replaced it. `refreshTokenExpiresAt` is null unless the reason
 * is `refresh-token-expired`. A caller does not retry: a webhook answers non-2xx so Shopify
 * redelivers after the merchant returns, a Workflow step dies, and a merchant-triggered action
 * tells the merchant to reopen the app.
 */
export class ReauthorizationRequired extends Schema.TaggedError<ReauthorizationRequired>()(
  "ReauthorizationRequired",
  {
    shop: ShopKey,
    reason: Schema.Literals([
      "no-refresh-token",
      "refresh-token-expired",
      "refresh-token-rejected",
    ]),
    refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
  },
) {}

/**
 * Shopify could not be reached, as a browser is told it: the Backend's own `ShopifyUnavailable`
 * without its cause, which is logged where it happened and never sent. The same tag, so a caller
 * reads one name for one failure.
 */
export class ShopifyUnavailable extends Schema.TaggedError<ShopifyUnavailable>()(
  "ShopifyUnavailable",
  { shop: ShopKey },
) {}

/** Every way a merchant's sync press can fail once its socket is open. */
export const OrdersSyncFailure = Schema.Union([
  OfflineSessionMissing,
  ReauthorizationRequired,
  ShopifyUnavailable,
]);
export type OrdersSyncFailure = typeof OrdersSyncFailure.Type;

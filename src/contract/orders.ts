/**
 * The merchant's orders screen's first page, as both sides of the binding read it: it carries
 * the session token App Bridge issued, which names the shop, as `AuthenticateAdminInput` does.
 * The screen's two sync buttons are socket procedures (`MerchantSyncOpenOrders`,
 * `MerchantSyncOrder`).
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { ListOrdersInput } from "../domain/shop-work.ts";

const sessionToken = Schema.NonEmptyString;

/** `BackendApi.listOrders`' input: one page of the orders index, as `ListOrdersInput` reads it. */
export const ListOrdersRequest = Schema.Struct({ sessionToken, ...ListOrdersInput.fields });
export type ListOrdersRequest = typeof ListOrdersRequest.Type;

/**
 * How far back the open-orders sync reaches. Shopify grants the last 60 days of orders
 * without `read_all_orders`, which is a Partner Dashboard access request; 30
 * leaves headroom for a clock skew or a long-running bulk operation without
 * ever touching that boundary. The number is in the button's help text, so it
 * is a promise to the merchant as well as a query term.
 */
export const ORDER_SYNC_WINDOW_DAYS = 30;

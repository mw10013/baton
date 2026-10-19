import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { OrderDetailRequest } from "../../contract/orders.ts";
import { ListOrdersInput } from "../../domain/shop-work.ts";
import { backend, requestInfo } from "./backend.ts";
import { embeddedSessionToken } from "./shopify.ts";

/** The document's `id_token`, for a call made in-process during SSR; see `embeddedSessionToken`. */
const idToken = { idToken: Schema.optional(Schema.NonEmptyString) };

/**
 * The orders index's first page, for its loader. The token is only verified, never exchanged
 * (`BackendApi.listOrders`).
 */
export const listOrders = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ ...idToken, ...ListOrdersInput.fields })))
  .handler(({ data: { limit, cursor, q, show, team }, context: { sessionToken, rescueToken } }) =>
    backend()
      .listOrders(requestInfo(), { sessionToken, limit, cursor, q, show, team })
      .catch(rescueToken),
  );

/**
 * The order page's data, for its loader, as {@link listOrders}; `null` is no such order
 * (`BackendApi.orderDetail`).
 */
export const orderDetail = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ ...idToken, legacyId: OrderDetailRequest.fields.legacyId }),
    ),
  )
  .handler(({ data: { legacyId }, context: { sessionToken, rescueToken } }) =>
    backend().orderDetail(requestInfo(), { sessionToken, legacyId }).catch(rescueToken),
  );

/** The orders index's usage (its `QuotaBanners`), for its loader, as {@link listOrders} (`BackendApi.usage`). */
export const orderUsage = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(Schema.toStandardSchemaV1(Schema.Struct(idToken)))
  .handler(({ context: { sessionToken, rescueToken } }) =>
    backend().usage(requestInfo(), { sessionToken }).catch(rescueToken),
  );

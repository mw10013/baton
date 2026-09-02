import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { ORDER_SYNC_LINE_ITEMS } from "@/lib/orderSyncConstants";

/**
 * The order-level selection both ingestion paths share, decoded once here so
 * the webhook fetch and the bulk NDJSON cannot drift into storing different
 * things for the same order.
 *
 * Timestamps decode to epoch milliseconds ({@link Domain.EpochMillis}); the
 * enum-shaped fields stay `String` because Shopify may add a value to
 * `OrderDisplayFinancialStatus` at any time and a new status must render as
 * itself rather than fail a decode deep inside a stream fold.
 */
export const OrderNode = Schema.Struct({
  id: Schema.String,
  legacyResourceId: Schema.String,
  name: Schema.String,
  createdAt: Domain.EpochMillis,
  processedAt: Domain.EpochMillis,
  updatedAt: Domain.EpochMillis,
  cancelledAt: Schema.NullOr(Domain.EpochMillis),
  closedAt: Schema.NullOr(Domain.EpochMillis),
  displayFinancialStatus: Schema.NullOr(Schema.String),
  displayFulfillmentStatus: Schema.String,
  fullyPaid: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  note: Schema.NullOr(Schema.String),
  customAttributes: Schema.Array(Domain.OrderAttribute),
});
export type OrderNode = typeof OrderNode.Type;

/**
 * `variant` and `product` are objects rather than connections, so the bulk
 * export inlines them on the line-item line instead of emitting a third line
 * type — which is why one schema serves both paths here too.
 */
export const LineItemNode = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  currentQuantity: Schema.Number,
  unfulfilledQuantity: Schema.Number,
  nonFulfillableQuantity: Schema.Number,
  requiresShipping: Schema.Boolean,
  customAttributes: Schema.Array(Domain.OrderAttribute),
  variant: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  product: Schema.NullOr(
    Schema.Struct({ id: Schema.String, tags: Schema.Array(Schema.String) }),
  ),
});
export type LineItemNode = typeof LineItemNode.Type;

/**
 * Re-encodes the decoded node back to its wire shape for the `raw` column.
 * Total for anything this schema just produced, which is the only input it
 * ever gets — and re-encoding rather than keeping the original response is
 * what makes `raw` identical from both paths, since the bulk line carries a
 * `__typename` the query response does not and the query response nests
 * `lineItems` the bulk line does not.
 */
const encodeOrderNode = Schema.encodeSync(OrderNode);

export const toShopOrder = ({
  node,
  source,
  syncedAt,
  lineItemsComplete,
}: {
  readonly node: OrderNode;
  readonly source: Domain.OrderSyncSource;
  readonly syncedAt: number;
  readonly lineItemsComplete: boolean;
}): Domain.ShopOrder => ({
  id: node.id,
  legacyId: node.legacyResourceId,
  name: node.name,
  createdAt: node.createdAt,
  processedAt: node.processedAt,
  updatedAt: node.updatedAt,
  cancelledAt: node.cancelledAt,
  closedAt: node.closedAt,
  financialStatus: node.displayFinancialStatus,
  fulfillmentStatus: node.displayFulfillmentStatus,
  fullyPaid: node.fullyPaid,
  tags: node.tags,
  note: node.note,
  customAttributes: node.customAttributes,
  lineItemsComplete,
  syncedAt,
  syncSource: source,
});

export const toOrderRaw = (node: OrderNode) =>
  JSON.stringify(encodeOrderNode(node));

export const toOrderLineItem = (
  orderId: string,
  node: LineItemNode,
): Domain.OrderLineItem => ({
  id: node.id,
  orderId,
  productId: node.product?.id ?? null,
  variantId: node.variant?.id ?? null,
  title: node.title,
  variantTitle: node.variantTitle,
  sku: node.sku,
  quantity: node.quantity,
  currentQuantity: node.currentQuantity,
  unfulfilledQuantity: node.unfulfilledQuantity,
  nonFulfillableQuantity: node.nonFulfillableQuantity,
  productTags: node.product?.tags ?? [],
  customAttributes: node.customAttributes,
  requiresShipping: node.requiresShipping,
});

/**
 * The single-order fetch behind every webhook delivery and every manual
 * resync. Shopify's order webhooks are REST-shaped and carry no product tags
 * or enriched line-item metadata — Shopify's own OMS guidance is to query the
 * full order after each webhook — and this app subscribes with
 * `include_fields` trimmed to ids anyway, so the payload is a signal and this
 * is the read.
 *
 * `pageInfo.hasNextPage` is selected rather than assumed away: past
 * {@link ORDER_SYNC_LINE_ITEMS} the fetch has only a partial view, and
 * `OrderRepository.upsertOrder` must merge instead of replacing so the unseen
 * tail is not deleted.
 */
export const orderSyncQuery = `#graphql
  query OrderSync($id: ID!, $lineItems: Int!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      createdAt
      processedAt
      updatedAt
      cancelledAt
      closedAt
      displayFinancialStatus
      displayFulfillmentStatus
      fullyPaid
      tags
      note
      customAttributes { key value }
      lineItems(first: $lineItems) {
        pageInfo { hasNextPage }
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          currentQuantity
          unfulfilledQuantity
          nonFulfillableQuantity
          requiresShipping
          customAttributes { key value }
          variant { id }
          product { id tags }
        }
      }
    }
  }`;

export const OrderSyncResponse = Schema.Struct({
  order: Schema.NullOr(
    Schema.Struct({
      ...OrderNode.fields,
      lineItems: Schema.Struct({
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
        nodes: Schema.Array(LineItemNode),
      }),
    }),
  ),
});

export const orderSyncVariables = (orderId: string) => ({
  id: orderId,
  lineItems: ORDER_SYNC_LINE_ITEMS,
});

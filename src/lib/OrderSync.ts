import { Schema } from "effect";

import * as Domain from "@/lib/Domain";

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
  processedAt: Domain.EpochMillis,
  updatedAt: Domain.EpochMillis,
  cancelledAt: Schema.NullOr(Domain.EpochMillis),
  closedAt: Schema.NullOr(Domain.EpochMillis),
  displayFinancialStatus: Schema.NullOr(Schema.String),
  displayFulfillmentStatus: Schema.String,
  fullyPaid: Schema.Boolean,
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
  requiresShipping: Schema.Boolean,
  customAttributes: Schema.Array(Domain.OrderAttribute),
  variant: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  product: Schema.NullOr(
    Schema.Struct({ id: Schema.String, tags: Schema.Array(Schema.String) }),
  ),
});
export type LineItemNode = typeof LineItemNode.Type;

export const toShopOrder = ({
  node,
  source,
  syncedAt,
  lineItemsTruncated,
}: {
  readonly node: OrderNode;
  readonly source: Domain.OrderSyncSource;
  readonly syncedAt: number;
  /**
   * Whether this fetch stored less than the order has: another page on the
   * single-order path, more lines than
   * {@link Domain.ShopLimits.maxLineItemsPerOrder} on the bulk one. Both mean
   * the same thing to the merchant and neither changes how the write
   * behaves — see {@link OrderRepository.upsertOrder}.
   */
  readonly lineItemsTruncated: boolean;
}): Domain.ShopOrder => ({
  id: node.id,
  legacyId: node.legacyResourceId,
  name: node.name,
  processedAt: node.processedAt,
  updatedAt: node.updatedAt,
  cancelledAt: node.cancelledAt,
  closedAt: node.closedAt,
  financialStatus: node.displayFinancialStatus,
  fulfillmentStatus: node.displayFulfillmentStatus,
  fullyPaid: node.fullyPaid,
  note: node.note,
  customAttributes: node.customAttributes,
  lineItemsTruncated,
  syncedAt,
  syncSource: source,
});

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
  productTags: node.product?.tags ?? [],
  /** Reconcile owns this column; the sync writes the empty set and `afterWrite` fills it. */
  matchedWorkflowIds: [],
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
 * One page of {@link Domain.ShopLimits.maxLineItemsPerOrder} line items and no
 * pagination loop, which is the same set the bulk path stores;
 * `pageInfo.hasNextPage` is selected rather than assumed away so an order past
 * the cap is stored flagged rather than silently short. The rule and the
 * reason for the number are on {@link OrderRepository.upsertOrder}.
 */
export const orderSyncQuery = `#graphql
  query OrderSync($id: ID!, $lineItems: Int!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      processedAt
      updatedAt
      cancelledAt
      closedAt
      displayFinancialStatus
      displayFulfillmentStatus
      fullyPaid
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
  lineItems: Domain.ShopLimits.maxLineItemsPerOrder,
});

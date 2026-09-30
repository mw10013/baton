/**
 * Vocabulary, orders. What Shopify says about an order, in Shopify's
 * words.
 *
 * Nouns, orders. "(none)" means no screen says the word; the
 * cell says what a screen shows instead:
 *
 * | word   | meaning                                                                          | symbol                          | screen                  |
 * | ------ | -------------------------------------------------------------------------------- | ------------------------------- | ----------------------- |
 * | order  | a Shopify order                                                                  | `ShopOrder`                     | its name (#1001)        |
 * | item   | one line item of an order                                                        | `OrderLineItem`                 | item; never "line item" |
 * | import | the bulk fetch of the shop's open orders from Shopify                            | `OrdersSyncResult`, `SyncState` | Import open orders      |
 * | sync   | writing one Shopify order into the object, from a webhook, an import or a resync | `OrderSyncSource`               | Resync from Shopify     |
 *
 * An item is always shown under its order on the merchant's order page,
 * and beside it in the member's row (`<item> · <workflow> · <order>`), so
 * the order carries the disambiguation and the word stays short. Copy with
 * no order beside it qualifies the word ("items on open orders", "N items
 * in production") rather than saying "items" bare.
 */
import { Schema } from "effect";

import { SqliteBoolean } from "./Platform.ts";

/**
 * One line item property: Shopify's `Attribute` as it appears in
 * `LineItem.customAttributes`. The Help Center calls these line item
 * properties, REST and Liquid call them `properties`, and the merchant's line
 * item card is headed Properties. Order-level attributes are not stored (see
 * {@link ShopOrder}).
 */
export const LineItemProperty = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
});
export type LineItemProperty = typeof LineItemProperty.Type;

/**
 * One order in the shop's Durable Object SQLite. Encoded side is the row
 * (epoch-ms integers, `0`/`1` booleans, JSON text); decoded side is what the
 * page renders.
 *
 * Deliberately carries no customer identity: no `customer`, `shippingAddress`,
 * email, or phone. Baton is a tool for the shop's work, so the buyer never needs
 * naming, and staying off those fields keeps the app clear of Level 2 protected
 * customer data. `note` stays because it can carry instructions a maker
 * works from. Order-level `customAttributes` (the cart attributes the admin
 * shows under Additional details) are not stored: no run or screen reads an
 * order-level field, and the merchant reads them in the admin one click away.
 *
 * Payment is stored as `fullyPaid` only, the one fact a rule reads
 * ({@link orderCanCreateRuns}). Shopify's display financial status and the order's
 * archive time (`closedAt`) are not mirrored: no rule and no maker reads them,
 * and the admin is one click away.
 */
export const ShopOrder = Schema.Struct({
  id: Schema.String,
  legacyId: Schema.String,
  name: Schema.String,
  /**
   * Shopify's `processedAt`: the date shown under the order number in the
   * admin, the one importers back-date, and the only date Baton compares
   * (against `Workflow.activatedAt`). Shopify's `createdAt` (the row
   * timestamp) is deliberately not persisted so nobody has to ask which one
   * matters.
   */
  processedAt: Schema.Number,
  updatedAt: Schema.Number,
  cancelledAt: Schema.NullOr(Schema.Number),
  fulfillmentStatus: Schema.String,
  fullyPaid: SqliteBoolean,
  note: Schema.NullOr(Schema.String),
  /**
   * Whether line items were **dropped** on the way in, past
   * `ShopLimits.maxLineItemsPerOrder` in Platform. Both paths ask Shopify for that
   * many and neither pages, so this is the whole of "the stored set is short
   * of the order" — see {@link OrderRepository.upsertOrder}, which states the
   * rule. The order page warns on it; nothing else reads it.
   */
  lineItemsTruncated: SqliteBoolean,
  syncedAt: Schema.Number,
});
export type ShopOrder = typeof ShopOrder.Type;

/**
 * `productTags` is a **snapshot** taken at sync time, not a live read: a
 * resync overwrites it. A run copies the definition it started from, so a
 * merchant retagging a product cannot silently rewrite history.
 *
 * `currentQuantity` is the number of units still to be made
 * ({@link unitsToMake}): Shopify lowers it on a merchant edit and on a refund,
 * and on nothing else. Fulfillment does not move it, which is why a line
 * fulfilled early still reads as work until the whole order is `FULFILLED`
 * ({@link orderIsFulfilled}). `quantity` stays as "ordered" for display.
 *
 * `matchedWorkflowIds` holds `WorkflowId`s in ShopWork as plain strings, the
 * way `ShopSession` holds `planHandle`: it is shop work's writing on the
 * orders row, and orders reads nothing from shop work. It is the eligible workflows whose tag matched
 * this item at the last reconcile, whether or not a run was created. Two or
 * more with no run is an **ambiguity** the merchant resolves from the
 * order page; the picker there offers these first, then every other
 * workflow that is on. Written by reconcile
 * only — the order sync writes `[]`, because matching happens after the write,
 * inside `afterWrite`.
 *
 * `properties` is the item's own list, every key stored and shown as
 * Shopify sends it, underscore-prefixed app keys included; Baton is a
 * back-office tool and hides nothing the merchant can already see in the
 * admin.
 *
 * The product and variant ids are not stored because nothing links to the
 * product; `requiresShipping` is not stored because no rule distinguishes a
 * digital item.
 */
export const OrderLineItem = Schema.Struct({
  id: Schema.String,
  orderId: Schema.String,
  title: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  currentQuantity: Schema.Number,
  productTags: Schema.fromJsonString(Schema.Array(Schema.String)),
  matchedWorkflowIds: Schema.fromJsonString(Schema.Array(Schema.String)),
  properties: Schema.fromJsonString(Schema.Array(LineItemProperty)),
});
export type OrderLineItem = typeof OrderLineItem.Type;

/**
 * The creation gate, and only that: whether reconcile may *start* new runs on
 * the order. Deliberately not the stop gate — an edit that pushes a paid order
 * back to `fullyPaid = false` must leave work in progress alone, so only
 * {@link orderIsCancelled} and {@link orderIsFulfilled} close existing runs. `AUTHORIZED` is not
 * treated as paid; manual-capture shops would need a clause here.
 */
export const orderCanCreateRuns = (order: ShopOrder) =>
  order.fullyPaid && order.cancelledAt === null;

/** A stop gate, with {@link orderIsFulfilled}: reconcile closes every open run on the order, reason `order_cancelled` (`ClosedReason` in ShopWork). */
export const orderIsCancelled = (order: Pick<ShopOrder, "cancelledAt">) =>
  order.cancelledAt !== null;

/**
 * Shopify reports the order `FULFILLED`: nothing is left to make or pack.
 * The other stop gate: reconcile closes every open run, reason `fulfilled`
 * (`ClosedReason` in ShopWork). The only fulfillment value Baton acts on; every
 * other `displayFulfillmentStatus` (partially fulfilled, on hold, in
 * progress, scheduled, ...) is displayed as Shopify sends it and read as open.
 */
export const orderIsFulfilled = (order: Pick<ShopOrder, "fulfillmentStatus">) =>
  order.fulfillmentStatus === "FULFILLED";

/**
 * The two order fields {@link orderIsOpen} reads, and so every action set
 * (`runActions`, `taskActions` in ShopWork). Carried on the member's run
 * reads (`RunPageData`, `RunListItem`, `RecentItem` in ShopWork) because a
 * member page never holds the order itself, and without them it would offer
 * work on an order Shopify has closed.
 */
export const OrderState = Schema.Struct({
  cancelledAt: Schema.NullOr(Schema.Number),
  fulfillmentStatus: Schema.String,
});
export type OrderState = typeof OrderState.Type;

/**
 * Whether the order is **open**: not cancelled and not fully fulfilled in
 * Shopify. **Closed** means Shopify has finished with the order; it has
 * nothing to do with whether a workflow is attached. Every other order is
 * open, whatever its runs say.
 *
 * **A closed order is read only.** Every write that does work on its runs is
 * refused (`runActions`, `taskActions` in ShopWork); only the note stays,
 * because a note is a record, not work. There is nothing to cancel either:
 * reconcile has already closed every open run on it (`RunStatus` in ShopWork).
 *
 * Manual attach (`ShopAgent.merchantAttachWorkflow`) is the merchant
 * overriding the tag, activation-date and payment gates on purpose; it is not
 * an override of the order being over. A closed order has no work left, so
 * attach is refused, and reconcile would only close the run on its next
 * pass. Unpaid is deliberately allowed: the merchant may attach a workflow on a
 * deposit, which is the same judgement {@link orderCanCreateRuns} withholds from
 * reconcile. Attaching creates a run, so it bills the order like
 * any first run (`OrderRepository.countOrder`) — the one way an order Shopify
 * has not been paid for is metered, and the merchant chose it.
 */
export const orderIsOpen = (order: OrderState) =>
  !orderIsCancelled(order) && !orderIsFulfilled(order);

/**
 * Units a maker should see and a run should snapshot. `currentQuantity`, not
 * `quantity`: an edit or a refund lowers it, and neither leaves work a maker
 * should still do. Fulfillment is deliberately not in it — Shopify leaves
 * `currentQuantity` alone when a unit is fulfilled, so a line fulfilled ahead of the
 * rest of the order stays open work until the order reaches `FULFILLED`, which
 * is the one fulfillment state Baton acts on ({@link orderIsFulfilled}). Partial
 * fulfillment is deliberately ignored: a line fulfilled ahead of the order
 * stays work until the order is `FULFILLED`.
 */
export const unitsToMake = (lineItem: Pick<OrderLineItem, "currentQuantity">) =>
  lineItem.currentQuantity;

export const OrderDetail = Schema.Struct({
  order: ShopOrder,
  lineItems: Schema.Array(OrderLineItem),
});
export type OrderDetail = typeof OrderDetail.Type;

/**
 * Ids of seeded orders carry this prefix so a reseed replaces only fixture rows
 * and never a synced order. A seeded order is never counted: the seed marks it
 * counted before its first run (`OrderRepository.markSeedOrdersCounted`).
 */
export const SEED_ORDER_ID_PREFIX = "gid://shopify/Order/seed-";

export const ResyncOrderInput = Schema.Struct({
  orderId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type ResyncOrderInput = typeof ResyncOrderInput.Type;

/**
 * A Shopify bulk operation as the sync workflow observes it.
 *
 * `objectCount` and `fileSize` are `UnsignedInt64`, which Shopify serializes as
 * a string in some responses and a number in others; both are accepted rather
 * than guessing, and the value is only ever logged or compared against zero.
 *
 * Crosses a `step.do` boundary, so every field must survive JSON.
 */
/**
 * Shopify's enum, stored as read. The one rule on it: only `COMPLETED` has
 * a result to download ({@link bulkOperationCompleted}); every other value
 * is a failure or still running, and `OrdersSyncWorkflow` fails the step.
 */
export const BulkOperationStatus = Schema.Literals([
  "CANCELED",
  "CANCELING",
  "COMPLETED",
  "CREATED",
  "EXPIRED",
  "FAILED",
  "RUNNING",
]);
export type BulkOperationStatus = typeof BulkOperationStatus.Type;

/** See {@link BulkOperationStatus}. */
export const bulkOperationCompleted = (operation: {
  readonly status: BulkOperationStatus;
}) => operation.status === "COMPLETED";

export const BulkOperation = Schema.Struct({
  id: Schema.String,
  status: BulkOperationStatus,
  errorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  objectCount: Schema.Union([Schema.Number, Schema.String]),
  fileSize: Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
  url: Schema.NullOr(Schema.String),
  partialDataUrl: Schema.NullOr(Schema.String),
});
export type BulkOperation = typeof BulkOperation.Type;

/**
 * Which ingestion path is writing an order, for the sync logs. Diagnostic,
 * not control flow: every path runs the same `updatedAt`-guarded upsert. Not
 * stored on the row; a log line answers "how did this get here" as well.
 */
export const OrderSyncSource = Schema.Literals(["webhook", "bulk", "manual"]);
export type OrderSyncSource = typeof OrderSyncSource.Type;

/**
 * The single `SyncState` row: what the last import left behind, and nothing
 * else. Whether one is running now is not stored — the Agents SDK's own
 * `cf_agents_workflows` row is the only run tracker ({@link
 * OrdersSyncStatus.inFlight}) — because two records of the same fact drift
 * the moment a workflow dies without reporting.
 *
 * `lastError` is the banner on the orders index and survives until the next
 * import starts; `lastCompletedAt` is not on screen (a standing "Last
 * imported" time read as a chore to keep fresh) and is written by
 * `onWorkflowComplete`, not by the stream, so a file that streams halfway and
 * then fails never claims a completed import.
 */
export const SyncState = Schema.Struct({
  lastError: Schema.NullOr(Schema.String),
  lastCompletedAt: Schema.NullOr(Schema.Number),
});
export type SyncState = typeof SyncState.Type;

/** {@link SyncState} as `OrdersIndexData` in ShopWork carries it, plus whether an import is tracked as running right now; only a fresh tracking row counts (`IMPORT_STALE_MS` in `ShopAgent.ts` is the rule). */
export const OrdersSyncStatus = Schema.Struct({
  inFlight: Schema.Boolean,
  ...SyncState.fields,
});
export type OrdersSyncStatus = typeof OrdersSyncStatus.Type;

/**
 * What the Import open orders button is told it did. `in_flight` is an import
 * already tracked as running, `refused` is a refusal recorded on
 * {@link SyncState.lastError} for the banner to carry; neither is an error,
 * and in all three cases the page re-reads `OrdersIndexData` in ShopWork.
 */
export const OrdersSyncResult = Schema.Struct({
  status: Schema.Literals(["started", "in_flight", "refused"]),
});
export type OrdersSyncResult = typeof OrdersSyncResult.Type;

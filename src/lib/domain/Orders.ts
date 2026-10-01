/**
 * Vocabulary, orders. What Shopify says about an order, in Shopify's
 * words.
 *
 * Nouns, orders. "(none)" means no screen says the word; the
 * cell says what a screen shows instead:
 *
 * | word             | meaning                                                                                                                                                                                                           | symbol                                                                                  | screen                                                                  |
 * | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
 * | order            | a Shopify order                                                                                                                                                                                                   | `ShopOrder`                                                                             | its name (#1001)                                                        |
 * | item             | one line item of an order                                                                                                                                                                                         | `OrderLineItem`                                                                         | item; never "line item"                                                 |
 * | sync             | making Baton's copy of an order agree with Shopify: a webhook (one order, as it happens), the open-orders sync (the button: open, unfulfilled, created in the last 30 days), or the merchant asking for one order | `syncOrder`, `ShopAgent.syncOpenOrders`, `OrdersSyncResult`, `OrdersSyncStatus`, `SyncState`, `SyncOrderInput` | Sync open orders (the orders index); Sync from Shopify (the order page) |
 * | current quantity | Shopify's count of units still on the item after edits and refunds                                                                                                                                                | `OrderLineItem.currentQuantity`                                                         | the quantity on the card                                                |
 *
 * An item is always shown under its order on the merchant's order page,
 * and beside it in the member's row (`<item> · <workflow> · <order>`), so
 * the order carries the disambiguation and the word stays short. Copy with
 * no order beside it qualifies the word ("items on open orders", "N items
 * in production") rather than saying "items" bare. The identifiers and
 * columns say lineItem (`OrderLineItem`, `lineItemId` in ShopWork) because that is
 * Shopify's `LineItem`, and "item" is the screen's short form beside its
 * order; neither is renamed to match the other.
 */
import { Schema } from "effect";

import { retentionCutoff, SqliteBoolean } from "./Platform.ts";

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
   * admin and the one importers back-date. It is the date the orders index
   * sorts by and the retention sweep reads; Baton compares it with nothing
   * else. Shopify's `createdAt` (the row timestamp) is deliberately not
   * persisted so nobody has to ask which one matters.
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
   * of the order" — rule 10 on {@link syncOrder}. The order page warns on it; nothing else reads it.
   */
  lineItemsTruncated: SqliteBoolean,
  syncedAt: Schema.Number,
});
export type ShopOrder = typeof ShopOrder.Type;

/**
 * `productTags` is a **snapshot** taken at sync time, not a live read: the
 * next sync overwrites it. A run copies the definition it started from, so a
 * merchant retagging a product cannot silently rewrite history.
 *
 * `currentQuantity` is the number of units still to be made
 * (`unitsToMake` in ShopWork): Shopify lowers it on a merchant edit and on a refund,
 * and on nothing else. Fulfillment does not move it, which is why a line
 * fulfilled early still reads as work until the whole order is `FULFILLED`
 * ({@link orderIsFulfilled}). `quantity` stays as "ordered" for display.
 *
 * Which workflows match an item is shop work's reading (`itemMatches` in
 * ShopWork) and is never stored.
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
export const orderCanCreateRuns = (
  order: Pick<ShopOrder, "fullyPaid" | "cancelledAt">,
) => order.fullyPaid && order.cancelledAt === null;

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
 * reconcile has already closed every open run on it (`RunState` in ShopWork).
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

export const SyncOrderInput = Schema.Struct({
  orderId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SyncOrderInput = typeof SyncOrderInput.Type;

/**
 * What Sync from Shopify is told it did: a `Result` (the Shape families
 * table on the map in `Domain.ts`). `Gone` is Shopify answering `null` for
 * the order: the stored row stays (a transient `null` must not be
 * destructive; reconcile has already closed the runs of a cancelled order
 * and retention deletes the row in time), and the order page says so.
 */
export const SyncOrderResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Stored") }),
  Schema.Struct({ _tag: Schema.Literal("Gone") }),
]);
export type SyncOrderResult = typeof SyncOrderResult.Type;

/**
 * What one sync is told to do with one order: a pure decision, executed by
 * `OrderRepository.upsertOrder` (`ReconcileAction` in ShopWork is the same
 * kind of thing for reconcile: nothing has been written when it is returned).
 */
export const SyncAction = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("write"), fresh: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("skip") }),
  Schema.Struct({
    _tag: Schema.Literal("refuse"),
    reason: Schema.Literals(["ceiling", "retention"]),
  }),
]);
export type SyncAction = typeof SyncAction.Type;

/**
 * **Sync** makes Baton's copy of one order agree with Shopify. Every source
 * (a webhook, the open-orders sync, Sync from Shopify) fetches the order
 * whole and hands it to the same write, `OrderRepository.upsertOrder`, which
 * asks this function what to do. Reconcile begins once the order is stored:
 * a write runs reconcile in the same transaction ({@link SyncAction}'s
 * `write`), and a skip or a refusal writes nothing for it to read.
 *
 * The version check compares Shopify's own `Order.updatedAt` on both sides,
 * never a clock of Baton's: it is a version, not an ordering of when two
 * writers ran, which is what makes it correct across a Worker, a Durable
 * Object and a Workflow that share no clock. An older observation (a
 * retried webhook replaying its payload, a bulk file whose snapshot predates
 * a webhook that landed mid-stream) is skipped. The same version rewrites,
 * on purpose (`>=`, not `>`): equal timestamps are the same order, so
 * rewriting it is free, and a redelivery of a write that failed halfway
 * still completes.
 *
 * Only a new order is gated. An order already stored always takes its
 * update, whatever its age or the ceiling: its `countedAt` is intact, and
 * refusing it would leave a stale copy of work Baton already carries. A new
 * order past retention is refused because, stored again, it would have no
 * `countedAt`, so its first run would bill it a second time, and the next
 * sweep would delete it with the run; only a webhook carries one (a merchant
 * editing a year-old order), since the open-orders sync reaches back 30
 * days. A new order at the order ceiling is refused because the ceiling is a
 * fact about new orders in the cycle the sync lands in.
 *
 * Nothing is cleared. A sync merges what Shopify sent into what is stored and
 * never deletes an order: an order missing from a sync is not evidence it is
 * gone, only that this sync did not ask for it. Retention deletes orders, by
 * the order's own date.
 *
 * What one sync does to one order. Each row is a fixture set, each cell one
 * input; `any` covers every value of its column. `stored` is `none` or
 * `stored`; `version` compares the incoming `updatedAt` to the stored one;
 * `age` compares `processedAt` to `retentionCutoff(syncedAt)`; `ceiling` is
 * `cycleAtOrderCeiling` at the cycle `syncedAt` lands in, after any
 * roll-forward. `action` is `write`, `skip` or `refuse`, with free text after
 * a colon. The test reads this table out of the source.
 *
 * | stored | version       | age     | ceiling | action                                                             |
 * | ------ | ------------- | ------- | ------- | ------------------------------------------------------------------ |
 * | none   | any           | expired | any     | refuse: retention; nothing written, nothing flagged                |
 * | none   | any           | kept    | at      | refuse: ceiling; `ordersLimitedAt` set                             |
 * | none   | any           | kept    | under   | write: fresh; items inserted; reconcile                            |
 * | stored | older         | any     | any     | skip: the row and its items stay                                   |
 * | stored | same or newer | any     | any     | write: row rewritten except `countedAt`; items replaced; reconcile |
 *
 * When a sync happens. One row per source; `who` is the gate the start
 * passes; `asks Shopify for` is the fetch; `skipped when` is what returns
 * before any write.
 *
 * | source                   | who                               | asks Shopify for                                                                     | skipped when                                                                                                                                        | pinned by                                                                                                                                                         |
 * | ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | order webhook, any topic | Shopify, by HMAC                  | the one order the payload names, whole                                               | a delivery id already seen; a payload version not newer than the row; a new order at the order ceiling, before the fetch; the order gone at Shopify | skips a delivery whose updated_at is not newer than the row; treats a redelivered webhook id as a no-op; refuses a new order at the ceiling and flags the refusal |
 * | Sync open orders         | the merchant, on the orders index | a bulk operation over open, unfulfilled orders created in the last 30 days, streamed | one already tracked as running; the shop at the order ceiling, before the start                                                                     | the sync query is fixed: open, unfulfilled, created in the last 30 days; refuses a second sync while one is tracked as running                                    |
 * | Sync from Shopify        | the merchant, on the order page   | the one order, whole; no dedupe, no version check                                    | the order gone at Shopify                                                                                                                           | the one-order sync stores the order and creates its run; the one-order sync answers Gone for an order Shopify no longer has and leaves the stored row             |
 *
 * The seed is not a source: it writes fixture rows through the same write,
 * but nothing is asked of Shopify and the rows carry `SEED_ORDER_ID_PREFIX`.
 * It stays a row of the pipeline table on `ShopAgentHost` only. The stream's
 * callbacks (`onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`) are
 * reached by the Workflow alone, never from a browser: the file URL is
 * accepted only from a bulk operation this shop started (rule 15).
 *
 * What each ending of the open-orders sync leaves. `tracking row` is
 * `inserted`, `deleted`, `none` or `—`; `lastError` is `set`, `cleared` or
 * `—`.
 *
 * | ending                              | tracking row | lastError | pinned by                                                                                     |
 * | ----------------------------------- | ------------ | --------- | --------------------------------------------------------------------------------------------- |
 * | started                             | inserted     | cleared   | clears the error the next sync is about to supersede                                          |
 * | the start failed                    | none         | cleared   | a start that fails leaves no tracking row and no banner                                       |
 * | file streamed, complete             | deleted      | —         | completes: ensure-session -> bulk COMPLETED -> on-orders-stream                               |
 * | a partial file streamed, complete   | deleted      | —         | a partial file is streamed and the sync completes                                             |
 * | no orders in the 30 days            | deleted      | —         | completes: 30 days with no orders reaches on-orders-sync-empty                                |
 * | gave up at 5 minutes                | deleted      | set       | gives up after five minutes, cancels the Shopify operation, and fails with a merchant message |
 * | the operation `FAILED` or `EXPIRED` | deleted      | set       | an EXPIRED or FAILED operation fails without cancelling                                       |
 * | a step exhausted its retries        | deleted      | set       | errors through the on-orders-sync-error sink when a step exhausts its retries                 |
 * | the stream failed partway           | deleted      | set       | a stream that fails partway keeps the orders it wrote                                         |
 * | refused at the order ceiling        | none         | —         | a sync refused at the order ceiling flags the refusal, writes no error and tracks nothing     |
 * | a second press while one runs       | —            | —         | refuses a second sync while one is tracked as running                                         |
 *
 * Row notes. _The start failed_: the error reaches the merchant as the RPC's
 * toast and nothing else; `lastError` was already cleared, so the banner is
 * empty, which is honest (nothing ran). _A partial file_: Shopify's
 * `partialDataUrl` is streamed and the sync counts as complete, because its
 * rows are as valid as any under the version check; the merchant is not told
 * the file was partial, since the rows that arrived are correct, the ones
 * that did not arrive by webhook or on the next press, and a banner would
 * ask for an act the merchant cannot take. _The stream failed partway_: the
 * orders already written stay (rule 9). _Refused at the ceiling_: the quota
 * banner carries it, so `lastError` is not written.
 *
 * The invariants, in the order a sync meets them. `where` names the
 * enforcer; the rule is stated here and that symbol links it.
 *
 * | rule                                                                                                                                                                                                                                                                                                                      | where                                                                         | pinned by                                                                                                                                                                      |
 * | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
 * | 1. a webhook is a signal, never the data: the order is fetched whole, and the topic decides nothing                                                                                                                                                                                                                       | `webhooks.orders`, `ShopAgent.syncOrderWebhook`                               | a webhook's topic decides nothing: a cancelled topic on an open order stores it open                                                                                           |
 * | 2. a webhook delivery is handled once: a seen delivery id returns; a payload version not newer than the row returns without a fetch; an edit, which has no version, always fetches                                                                                                                                        | `OrderRepository.recordWebhookDelivery`, `ShopAgent.syncOrderWebhook`         | treats a redelivered webhook id as a no-op; skips a delivery whose updated_at is not newer than the row                                                                        |
 * | 3. one open-orders sync at a time, and the Agents SDK's tracking row is the only record of it; a fresh row disables the button, a stale row is asked about on the next press and cleared if its instance is gone                                                                                                          | `ShopAgent.syncOpenOrders`, `SYNC_STALE_MS`, `syncStarting`                   | a tracking row disables Sync open orders only while it is fresh; a tracked sync whose instance is gone is cleared on the next click                                            |
 * | 4. the open-orders query is the same on every press: open, unfulfilled, created in the last 30 days; no marker, no delta                                                                                                                                                                                                  | `bulkOrdersQueryText`                                                         | the sync query is fixed: open, unfulfilled, created in the last 30 days                                                                                                        |
 * | 5. the order ceiling is read at the cycle the sync lands in, after any roll-forward, wherever it is read: before a start, before a webhook's fetch, and per new order in the write; a sync refused before it starts is refused once, visibly, and a stream that crosses the ceiling refuses each new order and streams on | `ShopAgent.syncOpenOrders`, `syncOrderWebhook`, `OrderRepository.upsertOrder` | the order ceiling is read at the cycle the sync lands in: a sync after the cycle end is not refused at the old count                                                           |
 * | 6. every sync writes one order in one transaction: the row, its items replaced whole, and reconcile; a failure leaves none of the three                                                                                                                                                                                   | `OrderRepository.upsertOrder`                                                 | a pass that fails leaves neither the order nor its runs                                                                                                                        |
 * | 7. a staler copy never overwrites a fresher row; the same version rewrites; `countedAt` survives every write                                                                                                                                                                                                              | `Domain.syncOrder`, `OrderRepository.upsertOrder`                             | leaves the row and its items alone for an older updatedAt; accepts an equal updatedAt and rewrites the row                                                                     |
 * | 8. only a new order is gated, by retention and by the order ceiling; a stored order always takes its update                                                                                                                                                                                                               | `Domain.syncOrder`                                                            | the ceiling counts orders work started on, not orders stored: a new order is refused at it and a stored one still updates; an order older than retention is never stored again |
 * | 9. a sync merges and never clears: no sync deletes an order; retention does, by the order's own date, riding the open-orders sync and, rate-limited, the webhook                                                                                                                                                          | `ShopAgent.onOrdersStream`, `syncOrderWebhook`, `sweepExpiredOrders`          | leaves a fresher webhook row untouched; deletes any order older than 365 days, open or closed, with its runs, plus orphaned runs                                               |
 * | 10. an order keeps at most 250 items on either path; the rest are dropped and the order flagged, never refused; on the stream a child whose parent is not the open order fails the sync                                                                                                                                   | `runShopAgentOrdersStream`, `addLine`, `OrdersAgent.fetchAndUpsertOrder`      | caps an order's line items and flags it rather than failing the sync; fails when a line item names a parent that is not the open order                                         |
 * | 11. every streamed order carries the stream's one `syncedAt`, read before the file is fetched; retention and the billing cycle are resolved against it                                                                                                                                                                    | `runShopAgentOrdersStream`                                                    | every streamed order carries one syncedAt, read before the file is fetched                                                                                                     |
 * | 12. the usage queue is sent once after a stream, whatever became of it; after a one-order sync from the order page, whatever became of it; and after a webhook's write, so a failed webhook flushes on Shopify's retry                                                                                                    | `ShopAgent.onOrdersStream`, `syncOrder`, `syncOrderWebhook`                   | syncing one order sends the usage queue, even when the sync fails                                                                                                              |
 * | 13. a completed sync leaves nothing behind but its rows: the completion callback deletes the tracking row and writes nothing else                                                                                                                                                                                         | `ShopAgent.onWorkflowComplete`                                                | a completed sync deletes the tracking row and writes nothing else                                                                                                              |
 * | 14. a failed sync's banner is the merchant sentence, written by the sink; the callback that follows deletes the tracking row and never overwrites a message the sink wrote                                                                                                                                                | `ShopAgent.onOrdersSyncError`, `onWorkflowError`                              | a failed sync's banner is the merchant sentence, and the callback never overwrites it                                                                                          |
 * | 15. the stream's callbacks are reached by the Workflow alone; the file URL is accepted only from a bulk operation this shop started; the two buttons are the merchant's socket and the webhook is HMAC                                                                                                                    | `ShopAgent.onOrdersStream`, `connectionRoleGuard`, `handleWebhook`            | the stream's callbacks are not callable from a socket, and the two sync buttons refuse a member                                                                                |
 * | 16. a repeat sync of the same version changes nothing a screen shows: the row is rewritten, the items replaced with the same set, and reconcile writes nothing (pass rule 9 on `reconcileItem`)                                                                                                                           | `Domain.syncOrder`, `reconcileItem`                                           | creates runs on every streamed open order that matches, however old, and a re-stream creates none                                                                              |
 * | 17. no count a sync makes reaches a screen; the orders index shows whether one runs and the last error, nothing else                                                                                                                                                                                                      | `OrdersSyncStatus`, `OrdersStreamCounts`                                      | no sync count reaches a screen: the orders index carries whether one runs and the last error                                                                                   |
 */
export const syncOrder = ({
  stored,
  incoming,
  atCeiling,
}: {
  /** The stored row's version, or null when the order is not stored. */
  readonly stored: { readonly updatedAt: number } | null;
  readonly incoming: Pick<ShopOrder, "updatedAt" | "processedAt" | "syncedAt">;
  /** `cycleAtOrderCeiling` at the cycle `incoming.syncedAt` lands in, after any roll-forward. Ignored when `stored` is set. */
  readonly atCeiling: boolean;
}): SyncAction => {
  if (stored === null) {
    if (incoming.processedAt < retentionCutoff(incoming.syncedAt))
      return { _tag: "refuse", reason: "retention" };
    if (atCeiling) return { _tag: "refuse", reason: "ceiling" };
    return { _tag: "write", fresh: true };
  }
  if (incoming.updatedAt < stored.updatedAt) return { _tag: "skip" };
  return { _tag: "write", fresh: false };
};

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
 * The single `SyncState` row: the last sync's error, and nothing else.
 * Whether one is running now is not stored — the Agents SDK's own
 * `cf_agents_workflows` row is the only run tracker ({@link
 * OrdersSyncStatus.inFlight}) — and a completed sync leaves nothing behind
 * but its rows (rule 13 on {@link syncOrder}). Two records of the same fact
 * drift the moment a workflow dies without reporting.
 *
 * `lastError` is the banner on the orders index and survives until the next
 * sync starts.
 */
export const SyncState = Schema.Struct({
  lastError: Schema.NullOr(Schema.String),
});
export type SyncState = typeof SyncState.Type;

/** {@link SyncState} as `OrdersIndexData` in ShopWork carries it, plus whether a sync is tracked as running right now; only a fresh tracking row counts (`SYNC_STALE_MS` in `ShopAgent.ts` is the rule). Nothing else: no count a sync makes reaches a screen (rule 17 on {@link syncOrder}). */
export const OrdersSyncStatus = Schema.Struct({
  inFlight: Schema.Boolean,
  ...SyncState.fields,
});
export type OrdersSyncStatus = typeof OrdersSyncStatus.Type;

/**
 * What the Sync open orders button is told it did: a `Result` (the Shape
 * families table on the map in `Domain.ts`), a tagged union like every
 * other. `InFlight` is a sync already tracked as running, `Refused` is
 * the order ceiling, which the quota banner already carries
 * (`ordersLimitedAt`); neither is an error, and in all three cases the page re-reads
 * `OrdersIndexData` in ShopWork.
 */
export const OrdersSyncResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Started") }),
  Schema.Struct({ _tag: Schema.Literal("InFlight") }),
  Schema.Struct({ _tag: Schema.Literal("Refused") }),
]);
export type OrdersSyncResult = typeof OrdersSyncResult.Type;

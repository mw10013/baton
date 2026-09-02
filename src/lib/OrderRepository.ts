import type { SqlError } from "effect/unstable/sql";

import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
export class OrderRepositoryError extends Schema.TaggedError<OrderRepositoryError>()(
  "OrderRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface OrderUpsert {
  readonly order: Domain.ShopOrder;
  /** Order-level JSON only; see {@link Domain.ShopOrder}. */
  readonly raw: string;
  readonly lineItems: readonly Domain.OrderLineItem[];
}

export interface WebhookDelivery {
  readonly webhookId: string;
  readonly topic: string;
  readonly orderId: string;
  readonly triggeredAt: number;
  readonly receivedAt: number;
}

const encodeCursor = ({ processedAt, id }: Domain.ShopOrder) =>
  `${String(processedAt)}:${id}`;

const decodeCursor = (cursor: string) => {
  const separator = cursor.indexOf(":");
  const processedAt = Number(cursor.slice(0, separator));
  return separator < 1 || !Number.isFinite(processedAt)
    ? Option.none()
    : Option.some({ processedAt, id: cursor.slice(separator + 1) });
};

const json = (value: unknown) => JSON.stringify(value);

const bit = (value: boolean) => (value ? 1 : 0);

export class OrderRepository extends Context.Service<
  OrderRepository,
  {
    /**
     * The one write every ingestion path funnels through, and the only reason
     * webhooks and a bulk stream can interleave freely.
     *
     * The upsert applies `where excluded.updatedAt >= ShopOrder.updatedAt`, so
     * an older observation of an order — a retried webhook replaying its
     * original payload, or a bulk file whose snapshot predates a webhook that
     * landed mid-stream — leaves the stored row alone. `returning id` is what
     * reports that: SQLite emits a row only for an insert or an update that
     * actually ran, so an empty result means the write lost the race, and the
     * line items are then left alone too. Writing them anyway would replace a
     * fresh set with a stale one under a row that correctly refused to move.
     *
     * When the caller saw the complete line-item set (`lineItemsComplete`), the
     * set is replaced wholesale, so a removed line disappears. When the fetch
     * was truncated it merges instead — deleting on a partial view would drop
     * lines that exist but were never seen.
     *
     * One transaction per order, not per stream: a bulk run opens the Durable
     * Object's input gate on every `await` inside the fetch, so a webhook can
     * and will interleave between orders. Per-order atomicity is what keeps
     * either writer from observing half an order.
     */
    readonly upsertOrder: (
      input: OrderUpsert,
    ) => Effect.Effect<{ readonly written: boolean }, SqlError.SqlError>;
    readonly deleteOrder: (
      orderId: string,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly getOrder: (
      orderId: string,
    ) => Effect.Effect<
      Option.Option<Domain.OrderDetail>,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * The stored `updatedAt`, for the webhook path's skip-if-stale check. An
     * absent row is `none`, which reads as "fetch it".
     */
    readonly getOrderUpdatedAt: (
      orderId: string,
    ) => Effect.Effect<Option.Option<number>, SqlError.SqlError>;
    readonly listOrders: (input: {
      readonly limit: number;
      readonly cursor: string | null;
    }) => Effect.Effect<
      Domain.OrdersPage,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Idempotence for a delivery channel that retries 8 times over 4 hours and
     * warns the same webhook may arrive more than once. `false` means this
     * `X-Shopify-Webhook-Id` was already handled and the caller should stop.
     */
    readonly recordWebhookDelivery: (
      delivery: WebhookDelivery,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly getSyncState: () => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Claims the singleton before the workflow instance exists, so a
     * `runWorkflow` that creates the instance and then throws leaves a claim to
     * verify rather than a running sync with an enabled button in front of it.
     */
    readonly reserveSync: (input: {
      readonly workflowId: string;
      readonly startedAt: number;
      readonly windowStart: number;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    /**
     * Releases the reservation and records the window, but only for the run
     * that holds it: `startedAt` identifies the run, so a completion callback
     * arriving after its run was superseded cannot clear the newer claim.
     */
    readonly completeSync: (input: {
      readonly startedAt: number;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    readonly failSync: (input: {
      readonly startedAt: number;
      readonly error: string;
    }) => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
    readonly clearSync: () => Effect.Effect<
      Domain.SyncState,
      SqlError.SqlError | OrderRepositoryError
    >;
  }
>()("OrderRepository") {
  static readonly layer: Layer.Layer<
    OrderRepository,
    never,
    SqlClient.SqlClient
  > = Layer.effect(
    OrderRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const decode =
        <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
        (rows: unknown) =>
          Schema.decodeUnknownEffect(schema)(rows).pipe(
            Effect.mapError(
              (cause) => new OrderRepositoryError({ message, cause }),
            ),
          );

      /**
       * `raw` is deliberately absent: it exists for `json_extract` during
       * prototyping, and pulling it through every list read would carry a
       * kilobyte per order over the socket for nothing.
       */
      const orderColumns = sql.literal(
        `id, legacyId, name, createdAt, processedAt, updatedAt, cancelledAt,
         closedAt, financialStatus, fulfillmentStatus, fullyPaid, tags, note,
         customAttributes, lineItemsComplete, syncedAt, syncSource`,
      );

      const decodeOrders = decode(
        Schema.Array(Domain.ShopOrder),
        "Invalid ShopOrder row",
      );
      const decodeLineItems = decode(
        Schema.Array(Domain.OrderLineItem),
        "Invalid OrderLineItem row",
      );
      const decodeSyncState = decode(
        Schema.Array(Domain.SyncState),
        "Invalid SyncState row",
      );

      const syncState = Effect.fn("OrderRepository.syncState")(function* (
        rows: unknown,
      ) {
        const [state] = yield* decodeSyncState(rows);
        if (state === undefined)
          return yield* Effect.fail(
            new OrderRepositoryError({
              message: "SyncState row is missing",
              cause: rows,
            }),
          );
        return state;
      });

      const readSyncState = () =>
        Effect.gen(function* () {
          return yield* syncState(
            yield* sql`
              select workflowId, startedAt, lastFullSyncAt,
                     lastFullSyncWindowStart, lastError
              from SyncState where id = 1
            `,
          );
        });

      const insertLineItems = (lineItems: readonly Domain.OrderLineItem[]) =>
        Effect.forEach(
          lineItems,
          (item) => sql`
            insert into OrderLineItem (
              id, orderId, productId, variantId, title, variantTitle, sku,
              quantity, currentQuantity, unfulfilledQuantity,
              nonFulfillableQuantity, productTags, customAttributes,
              requiresShipping
            ) values (
              ${item.id}, ${item.orderId}, ${item.productId}, ${item.variantId},
              ${item.title}, ${item.variantTitle}, ${item.sku},
              ${item.quantity}, ${item.currentQuantity},
              ${item.unfulfilledQuantity}, ${item.nonFulfillableQuantity},
              ${json(item.productTags)}, ${json(item.customAttributes)},
              ${bit(item.requiresShipping)}
            )
            on conflict(id) do update set
              orderId = excluded.orderId,
              productId = excluded.productId,
              variantId = excluded.variantId,
              title = excluded.title,
              variantTitle = excluded.variantTitle,
              sku = excluded.sku,
              quantity = excluded.quantity,
              currentQuantity = excluded.currentQuantity,
              unfulfilledQuantity = excluded.unfulfilledQuantity,
              nonFulfillableQuantity = excluded.nonFulfillableQuantity,
              productTags = excluded.productTags,
              customAttributes = excluded.customAttributes,
              requiresShipping = excluded.requiresShipping
          `,
          { discard: true },
        );

      return OrderRepository.of({
        upsertOrder: Effect.fn("OrderRepository.upsertOrder")(function* ({
          order,
          raw,
          lineItems,
        }: OrderUpsert) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const written = yield* sql`
                insert into ShopOrder (
                  id, legacyId, name, createdAt, processedAt, updatedAt,
                  cancelledAt, closedAt, financialStatus, fulfillmentStatus,
                  fullyPaid, tags, note, customAttributes, lineItemsComplete,
                  raw, syncedAt, syncSource
                ) values (
                  ${order.id}, ${order.legacyId}, ${order.name},
                  ${order.createdAt}, ${order.processedAt}, ${order.updatedAt},
                  ${order.cancelledAt}, ${order.closedAt},
                  ${order.financialStatus}, ${order.fulfillmentStatus},
                  ${bit(order.fullyPaid)}, ${json(order.tags)}, ${order.note},
                  ${json(order.customAttributes)},
                  ${bit(order.lineItemsComplete)}, ${raw}, ${order.syncedAt},
                  ${order.syncSource}
                )
                on conflict(id) do update set
                  legacyId = excluded.legacyId,
                  name = excluded.name,
                  createdAt = excluded.createdAt,
                  processedAt = excluded.processedAt,
                  updatedAt = excluded.updatedAt,
                  cancelledAt = excluded.cancelledAt,
                  closedAt = excluded.closedAt,
                  financialStatus = excluded.financialStatus,
                  fulfillmentStatus = excluded.fulfillmentStatus,
                  fullyPaid = excluded.fullyPaid,
                  tags = excluded.tags,
                  note = excluded.note,
                  customAttributes = excluded.customAttributes,
                  lineItemsComplete = excluded.lineItemsComplete,
                  raw = excluded.raw,
                  syncedAt = excluded.syncedAt,
                  syncSource = excluded.syncSource
                where excluded.updatedAt >= ShopOrder.updatedAt
                returning id
              `;
              if (written.length === 0) return { written: false };
              if (order.lineItemsComplete)
                yield* sql`delete from OrderLineItem where orderId = ${order.id}`;
              yield* insertLineItems(lineItems);
              return { written: true };
            }),
          );
        }),

        deleteOrder: Effect.fn("OrderRepository.deleteOrder")(function* (
          orderId: string,
        ) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`delete from OrderLineItem where orderId = ${orderId}`;
              yield* sql`delete from ShopOrder where id = ${orderId}`;
            }),
          );
        }),

        getOrder: Effect.fn("OrderRepository.getOrder")(function* (
          orderId: string,
        ) {
          const [order] = yield* decodeOrders(
            yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
          );
          return order === undefined
            ? Option.none()
            : Option.some({
                order,
                lineItems: yield* decodeLineItems(
                  yield* sql`select * from OrderLineItem where orderId = ${orderId} order by id`,
                ),
              } satisfies Domain.OrderDetail);
        }),

        getOrderUpdatedAt: Effect.fn("OrderRepository.getOrderUpdatedAt")(
          function* (orderId: string) {
            const rows = yield* sql`
              select updatedAt from ShopOrder where id = ${orderId}
            `.values;
            const updatedAt = rows[0]?.[0];
            return typeof updatedAt === "number"
              ? Option.some(updatedAt)
              : Option.none();
          },
        ),

        listOrders: Effect.fn("OrderRepository.listOrders")(function* ({
          limit,
          cursor,
        }: {
          readonly limit: number;
          readonly cursor: string | null;
        }) {
          /**
           * Keyset, never `limit/offset`: the bulk stream and webhooks insert
           * while a merchant pages, and an offset would skip or repeat rows
           * under those writes. One extra row is fetched to learn whether a
           * next page exists without a second count.
           */
          const after = Option.flatMap(Option.fromNullOr(cursor), decodeCursor);
          const keyset = Option.match(after, {
            onNone: () => sql.literal("1 = 1"),
            onSome: ({ processedAt, id }) =>
              sql.or([
                sql`processedAt < ${processedAt}`,
                sql`(processedAt = ${processedAt} and id < ${id})`,
              ]),
          });
          const page = yield* decodeOrders(
            yield* sql`
              select ${orderColumns} from ShopOrder
              where ${keyset}
              order by processedAt desc, id desc
              limit ${limit + 1}
            `,
          );
          const orders = page.slice(0, limit);
          const lineItems = yield* decodeLineItems(
            yield* sql`
              select * from OrderLineItem
              where orderId in (
                select id from ShopOrder
                where ${keyset}
                order by processedAt desc, id desc
                limit ${limit}
              )
              order by id
            `,
          );
          const [countRow] = yield* sql`select count(*) from ShopOrder`.values;
          const last = orders.at(-1);
          return {
            orders: orders.map((order) => ({
              order,
              lineItems: lineItems.filter((item) => item.orderId === order.id),
            })),
            limit,
            nextCursor:
              page.length > limit && last !== undefined
                ? encodeCursor(last)
                : null,
            orderCount: Number(countRow?.[0] ?? 0),
          } satisfies Domain.OrdersPage;
        }),

        recordWebhookDelivery: Effect.fn(
          "OrderRepository.recordWebhookDelivery",
        )(function* (delivery: WebhookDelivery) {
          const inserted = yield* sql`
            insert or ignore into WebhookDelivery
              (webhookId, topic, orderId, triggeredAt, receivedAt)
            values (
              ${delivery.webhookId}, ${delivery.topic}, ${delivery.orderId},
              ${delivery.triggeredAt}, ${delivery.receivedAt}
            )
            returning webhookId
          `;
          return inserted.length > 0;
        }),

        getSyncState: Effect.fn("OrderRepository.getSyncState")(readSyncState),

        reserveSync: Effect.fn("OrderRepository.reserveSync")(function* ({
          workflowId,
          startedAt,
          windowStart,
        }: {
          readonly workflowId: string;
          readonly startedAt: number;
          readonly windowStart: number;
        }) {
          return yield* syncState(
            yield* sql`
              update SyncState set
                workflowId = ${workflowId},
                startedAt = ${startedAt},
                lastFullSyncWindowStart = ${windowStart},
                lastError = null
              where id = 1
              returning workflowId, startedAt, lastFullSyncAt,
                        lastFullSyncWindowStart, lastError
            `,
          );
        }),

        completeSync: Effect.fn("OrderRepository.completeSync")(function* ({
          startedAt,
        }: {
          readonly startedAt: number;
        }) {
          yield* sql`
            update SyncState set
              workflowId = null,
              startedAt = null,
              lastFullSyncAt = ${startedAt},
              lastError = null
            where id = 1 and startedAt = ${startedAt}
          `;
          return yield* readSyncState();
        }),

        failSync: Effect.fn("OrderRepository.failSync")(function* ({
          startedAt,
          error,
        }: {
          readonly startedAt: number;
          readonly error: string;
        }) {
          yield* sql`
            update SyncState set
              workflowId = null,
              startedAt = null,
              lastError = ${error}
            where id = 1 and startedAt = ${startedAt}
          `;
          return yield* readSyncState();
        }),

        clearSync: Effect.fn("OrderRepository.clearSync")(function* () {
          return yield* syncState(
            yield* sql`
              update SyncState set workflowId = null, startedAt = null
              where id = 1
              returning workflowId, startedAt, lastFullSyncAt,
                        lastFullSyncWindowStart, lastError
            `,
          );
        }),
      });
    }),
  );
}

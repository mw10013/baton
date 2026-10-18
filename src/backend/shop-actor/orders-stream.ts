import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Ndjson } from "effect/encoding";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Match from "effect/Match";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ShopOrder } from "../../domain/orders.ts";
import { ShopLimits } from "../../domain/platform.ts";
import { LineItemNode, OrderNode, toOrderLineItems, toShopOrder } from "../order-sync.ts";
import type { OrderRepository } from "./order-repository.ts";

export class OrdersStreamError extends Schema.TaggedError<OrdersStreamError>()(
  "OrdersStreamError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * One line of the bulk result. Shopify flattens connections, so an order's
 * line items follow it as their own lines carrying `__parentId`, and the whole
 * file is ordered parent-then-children. `__typename` is the discriminant, which
 * is why the bulk document selects it at both levels.
 */
const BulkOrderLine = Schema.Struct({
  __typename: Schema.Literal("Order"),
  ...OrderNode.fields,
});

const BulkLineItemLine = Schema.Struct({
  __typename: Schema.Literal("LineItem"),
  ...LineItemNode.fields,
  __parentId: Schema.String,
});

const BulkLine = Schema.Union([BulkOrderLine, BulkLineItemLine]).pipe(
  Schema.toTaggedUnion("__typename"),
);

type BulkOrderLine = typeof BulkOrderLine.Type;
type BulkLineItemLine = typeof BulkLineItemLine.Type;
type BulkLine = typeof BulkLine.Type;

interface OrderBuffer {
  readonly order: BulkOrderLine;
  readonly lineItems: readonly BulkLineItemLine[];
  /** Line items past {@link ShopLimits.maxLineItemsPerOrder} were not stored; logged. */
  readonly truncated: boolean;
}

/** Logged by the caller and never shown: no count a sync makes reaches a screen (rule 18 on `syncOrder`). */
export interface OrdersStreamCounts {
  readonly ordersSeen: number;
  readonly ordersUpserted: number;
  readonly lineItemsUpserted: number;
  /** Orders whose line items were capped; each is also logged by the caller's fold. */
  readonly ordersTruncated: number;
  /** Orders this write created rather than updated, for the usage counter's log line. */
  readonly ordersInserted: number;
  /** New orders refused at `ShopLimits.maxOpenOrders`; the caller logs the total once. */
  readonly ordersRefused: number;
}

/**
 * Holds at most one order and its line items. A line item whose `__parentId`
 * is not the open order fails the stream rather than being dropped: Shopify
 * documents children as always following their parent, so a mismatch means the
 * file is not what this reader assumes and silently discarding line item
 * properties would be worse than a failed sync the merchant can retry.
 * Rule 10 on `syncOrder` is the cap and the parent check.
 */
const addLine = (
  active: OrderBuffer | null,
  line: BulkLine,
): Effect.Effect<readonly [OrderBuffer | null, readonly OrderBuffer[]], OrdersStreamError> =>
  Match.value(line).pipe(
    Match.discriminatorsExhaustive("__typename")({
      Order: (order) =>
        Effect.succeed([
          { order, lineItems: [], truncated: false },
          active === null ? [] : [active],
        ] as const),
      LineItem: (item) =>
        active !== null && item.__parentId === active.order.id
          ? Effect.succeed([
              /**
               * Past the cap the line is not stored and the order is logged
               * rather than the stream failed: one pathological order must not cost the
               * merchant the whole sync, and the buffer is what bounds this
               * reader's memory — without it a single order with a hundred
               * thousand items is held whole before its transaction opens.
               */
              active.lineItems.length >= ShopLimits.maxLineItemsPerOrder
                ? { ...active, truncated: true }
                : { ...active, lineItems: [...active.lineItems, item] },
              [],
            ] as const)
          : Effect.fail(
              new OrdersStreamError({
                message: "Bulk line item parent did not match the active order",
                cause: item,
              }),
            ),
    }),
  );

/**
 * Streams a completed bulk operation's NDJSON straight into the shop's SQLite.
 *
 * Constant memory by construction: the response body is consumed as a stream,
 * decoded line by line, and folded one order at a time — never `.text()`,
 * never `toArray`. A 30-day file for a busy shop is then no different from a
 * one-order file, and the Durable Object's memory ceiling stops being a
 * function of the merchant's volume.
 *
 * Rows are **merged**, not rebuilt: unlike a scan-and-replace, webhooks keep
 * writing while this runs, and `upsertOrder`'s `updatedAt` guard is what lets a
 * fresher webhook row survive a staler line in the file. Nothing is cleared
 * first for the same reason.
 *
 * Rules 10, 11 and 12 on `syncOrder`: at most 250 items an order, at
 * most 8 KB of properties an item, and one `syncedAt` for the whole stream,
 * read before the file is fetched.
 *
 * The Durable Object's input gate opens on every `await` inside this fetch, so
 * webhook deliveries genuinely interleave between orders — that is expected,
 * and per-order transactions plus the guard are what make it safe.
 */
export const runOrdersStream = <E = never>({
  repository,
  shop,
  url,
  afterWrite,
}: {
  readonly repository: OrderRepository;
  /** For the logs only. */
  readonly shop: string;
  readonly url: string;
  /** Composed into each order's upsert transaction; see `OrderUpsert.afterWrite`. */
  readonly afterWrite?: (order: ShopOrder) => Effect.Effect<unknown, E>;
}) =>
  Effect.gen(function* () {
    const syncedAt = yield* Clock.currentTimeMillis;

    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        schedule: Schedule.min([
          Schedule.exponential("250 millis"),
          Schedule.spaced("10 seconds"),
        ]).pipe(Schedule.jittered),
        times: 3,
      }),
    );

    return yield* HttpClientResponse.stream(client.get(url)).pipe(
      Stream.catchTag("HttpClientError", (cause) =>
        Stream.fail(new OrdersStreamError({ message: "Failed to fetch bulk result", cause })),
      ),
      Stream.pipeThroughChannel(
        Ndjson.decodeSchema(BulkLine)<OrdersStreamError>({ ignoreEmptyLines: true }),
      ),
      Stream.catchTag(["NdjsonError", "SchemaError"], (cause) =>
        Stream.fail(new OrdersStreamError({ message: "Bulk line could not be decoded", cause })),
      ),
      Stream.mapAccumEffect((): OrderBuffer | null => null, addLine, {
        onHalt: (active) => (active === null ? [] : [active]),
      }),
      Stream.runFoldEffect(
        (): OrdersStreamCounts => ({
          ordersSeen: 0,
          ordersUpserted: 0,
          lineItemsUpserted: 0,
          ordersTruncated: 0,
          ordersInserted: 0,
          ordersRefused: 0,
        }),
        (counts, { order, lineItems, truncated }) =>
          Effect.gen(function* () {
            const shopOrder = toShopOrder({ node: order, syncedAt });
            if (truncated)
              yield* Effect.logWarning(
                `ShopActor.onOrdersStream: shop=${shop} orderId=${order.id} lineItems truncated at ${String(ShopLimits.maxLineItemsPerOrder)}`,
              ).pipe(
                Effect.annotateLogs({
                  shop,
                  orderId: order.id,
                  limit: ShopLimits.maxLineItemsPerOrder,
                }),
              );
            const { written, fresh, refused } = yield* repository.upsertOrder({
              order: shopOrder,
              lineItems: yield* toOrderLineItems({ shop, orderId: order.id, nodes: lineItems }),
              afterWrite: afterWrite?.(shopOrder),
            });
            return {
              ordersSeen: counts.ordersSeen + 1,
              ordersUpserted: counts.ordersUpserted + (written ? 1 : 0),
              lineItemsUpserted: counts.lineItemsUpserted + (written ? lineItems.length : 0),
              ordersTruncated: counts.ordersTruncated + (truncated ? 1 : 0),
              ordersInserted: counts.ordersInserted + (fresh ? 1 : 0),
              ordersRefused: counts.ordersRefused + (refused ? 1 : 0),
            };
          }),
      ),
    );
  }).pipe(Effect.withLogSpan("ShopActor.onOrdersStream"));

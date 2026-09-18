import { Clock, Effect, Schedule, Schema, Stream } from "effect";
import { Ndjson } from "effect/unstable/encoding";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import {
  LineItemNode,
  OrderNode,
  toOrderLineItem,
  toShopOrder,
} from "@/lib/OrderSync";

export class ShopAgentOrdersStreamError extends Schema.TaggedError<ShopAgentOrdersStreamError>()(
  "ShopAgentOrdersStreamError",
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
  /** Line items past {@link Domain.ShopLimits.maxLineItemsPerOrder} were dropped. */
  readonly truncated: boolean;
}

export interface OrdersStreamCounts {
  readonly ordersSeen: number;
  readonly ordersUpserted: number;
  readonly lineItemsUpserted: number;
  /** Orders whose line items were capped; each is also logged by the caller's fold. */
  readonly ordersTruncated: number;
  /** Orders this write created rather than updated, for the usage counter's log line. */
  readonly ordersInserted: number;
}

/**
 * Holds at most one order and its line items. A line item whose `__parentId`
 * is not the open order fails the stream rather than being dropped: Shopify
 * documents children as always following their parent, so a mismatch means the
 * file is not what this reader assumes and silently discarding personalization
 * data would be worse than a failed sync the merchant can retry.
 */
const addLine = (
  active: OrderBuffer | null,
  line: BulkLine,
): Effect.Effect<
  readonly [OrderBuffer | null, readonly OrderBuffer[]],
  ShopAgentOrdersStreamError
> => {
  // oxlint-disable-next-line no-underscore-dangle
  switch (line.__typename) {
    case "Order": {
      return Effect.succeed([
        { order: line, lineItems: [], truncated: false },
        active === null ? [] : [active],
      ] as const);
    }
    case "LineItem": {
      // oxlint-disable-next-line no-underscore-dangle
      return active !== null && line.__parentId === active.order.id
        ? Effect.succeed([
            /**
             * Past the cap the line is dropped and the order flagged rather
             * than the stream failed: one pathological order must not cost the
             * merchant the whole import, and the buffer is what bounds this
             * reader's memory — without it a single order with a hundred
             * thousand items is held whole before its transaction opens.
             */
            active.lineItems.length >= Domain.ShopLimits.maxLineItemsPerOrder
              ? { ...active, truncated: true }
              : { ...active, lineItems: [...active.lineItems, line] },
            [],
          ] as const)
        : Effect.fail(
            new ShopAgentOrdersStreamError({
              message: "Bulk line item parent did not match the active order",
              cause: line,
            }),
          );
    }
  }

  return Effect.fail(
    new ShopAgentOrdersStreamError({
      message: "Unsupported bulk line",
      cause: line,
    }),
  );
};

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
 * The Durable Object's input gate opens on every `await` inside this fetch, so
 * webhook deliveries genuinely interleave between orders — that is expected,
 * and per-order transactions plus the guard are what make it safe.
 */
export const runShopAgentOrdersStream = <E = never>({
  url,
  afterWrite,
}: {
  readonly url: string;
  /** Composed into each order's upsert transaction; see `OrderUpsert.afterWrite`. */
  readonly afterWrite?: (order: Domain.ShopOrder) => Effect.Effect<void, E>;
}) =>
  Effect.gen(function* () {
    const repository = yield* OrderRepository;
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
        Stream.fail(
          new ShopAgentOrdersStreamError({
            message: "Failed to fetch bulk result",
            cause,
          }),
        ),
      ),
      Stream.pipeThroughChannel(
        Ndjson.decodeSchema(BulkLine)<ShopAgentOrdersStreamError>({
          ignoreEmptyLines: true,
        }),
      ),
      Stream.catchTag(["NdjsonError", "SchemaError"], (cause) =>
        Stream.fail(
          new ShopAgentOrdersStreamError({
            message: "Bulk line could not be decoded",
            cause,
          }),
        ),
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
        }),
        (counts, { order, lineItems, truncated }) =>
          Effect.gen(function* () {
            const shopOrder = toShopOrder({
              node: order,
              source: "bulk",
              syncedAt,
              // Flattened bulk connections are not paginated, so the set is
              // complete in Shopify's sense whatever this reader did with it.
              lineItemsComplete: true,
              lineItemsTruncated: truncated,
            });
            if (truncated)
              yield* Effect.logWarning(
                `ShopAgent.onOrdersStream: orderId=${order.id} lineItems truncated at ${String(Domain.ShopLimits.maxLineItemsPerOrder)}`,
              ).pipe(
                Effect.annotateLogs({
                  orderId: order.id,
                  limit: Domain.ShopLimits.maxLineItemsPerOrder,
                }),
              );
            const { written, fresh } = yield* repository.upsertOrder({
              order: shopOrder,
              lineItems: lineItems.map((item) =>
                toOrderLineItem(order.id, item),
              ),
              afterWrite: afterWrite?.(shopOrder),
            });
            return {
              ordersSeen: counts.ordersSeen + 1,
              ordersUpserted: counts.ordersUpserted + (written ? 1 : 0),
              lineItemsUpserted:
                counts.lineItemsUpserted + (written ? lineItems.length : 0),
              ordersTruncated: counts.ordersTruncated + (truncated ? 1 : 0),
              ordersInserted: counts.ordersInserted + (fresh ? 1 : 0),
            };
          }),
      ),
    );
  }).pipe(Effect.withLogSpan("ShopAgent.onOrdersStream"));

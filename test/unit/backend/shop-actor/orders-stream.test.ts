import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { runOrdersStream } from "../../../../src/backend/shop-actor/orders-stream.ts";
import type { OrderRepository } from "../../../../src/backend/shop-actor/order-repository.ts";
import { ShopLimits } from "../../../../src/domain/platform.ts";
import { ActorSqliteTest, QuietLogs, testOrderRepository } from "../layers.ts";

/**
 * The bulk stream's fold over the actor's real repository on an in-memory SQLite: legacy
 * `shop-agent-orders-stream.test.ts`'s `runShopAgentOrdersStream` cases, titles unchanged, under
 * the function's new name. What these tests are actually about is the fold meeting the guarded
 * upsert, which a fake repository would define away.
 */

const BULK_URL = "https://storage.googleapis.test/bulk-orders.jsonl";
/** Names the shop in the stream's logs. */
const STREAM_SHOP = "stream.myshopify.com";

const httpClientLayer = (body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))),
    ),
  );

/** `program` with the repository, on a fresh database, the HTTP client answering `body`. */
const runInRepository = <A, E>(
  body: string,
  program: (repository: OrderRepository) => Effect.Effect<A, E, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    return yield* program(yield* testOrderRepository);
  }).pipe(Effect.provide(Layer.mergeAll(ActorSqliteTest, httpClientLayer(body), QuietLogs)));

const stream = (repository: OrderRepository) =>
  runOrdersStream({ repository, shop: STREAM_SHOP, url: BULK_URL });

const orderGid = (n: number) => `gid://shopify/Order/${String(n)}`;
const lineItemGid = (n: number) => `gid://shopify/LineItem/${String(n)}`;

const orderLine = (n: number, updatedAt: string) => ({
  __typename: "Order",
  id: orderGid(n),
  legacyResourceId: String(n),
  name: `#100${String(n)}`,
  processedAt: `2026-08-0${String(n)}T00:00:00Z`,
  updatedAt,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
});

const lineItemLine = (n: number, parent: number) => ({
  __typename: "LineItem",
  id: lineItemGid(n),
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: `SKU-${String(n)}`,
  quantity: 1,
  currentQuantity: 1,
  customAttributes: [{ key: "text", value: "Hello" }],
  product: { tags: ["engraved"] },
  __parentId: orderGid(parent),
});

/** A blank line is included on purpose: `ignoreEmptyLines` must absorb it. */
const ndjson = (...lines: readonly (Record<string, unknown> | "")[]) =>
  lines.map((line) => (line === "" ? "" : JSON.stringify(line))).join("\n");

const fixture = ndjson(
  orderLine(1, "2026-08-01T10:00:00Z"),
  lineItemLine(1, 1),
  lineItemLine(2, 1),
  "",
  orderLine(2, "2026-08-02T10:00:00Z"),
  lineItemLine(3, 2),
);

describe("runOrdersStream", () => {
  it.effect("folds the flattened NDJSON into orders with their line items", () =>
    runInRepository(fixture, (repository) =>
      Effect.gen(function* () {
        const counts = yield* stream(repository);
        const first = yield* repository.getOrder(orderGid(1));
        const second = yield* repository.getOrder(orderGid(2));
        assert.strictEqual(counts.ordersSeen, 2);
        assert.strictEqual(counts.ordersUpserted, 2);
        assert.strictEqual(counts.lineItemsUpserted, 3);
        const one = Option.getOrThrow(first);
        assert.strictEqual(one.order.name, "#1001");
        assert.strictEqual(one.order.fullyPaid, true);
        assert.strictEqual(one.lineItems.length, 2);
        assert.strictEqual(one.lineItems[0]?.productTags[0], "engraved");
        assert.strictEqual(one.lineItems[0]?.properties[0]?.value, "Hello");
        assert.strictEqual(Option.getOrThrow(second).lineItems.length, 1);
      }),
    ),
  );

  it.effect("stores the first 250 line items of an order and does not fail the sync", () => {
    const over = ShopLimits.maxLineItemsPerOrder + 1;
    return runInRepository(
      ndjson(
        orderLine(1, "2026-08-01T10:00:00Z"),
        ...Array.from({ length: over }, (_, index) => lineItemLine(index + 1, 1)),
      ),
      (repository) =>
        Effect.gen(function* () {
          const counts = yield* stream(repository);
          const detail = yield* repository.getOrder(orderGid(1));
          assert.strictEqual(counts.ordersSeen, 1);
          assert.strictEqual(counts.ordersTruncated, 1);
          assert.strictEqual(counts.ordersInserted, 1);
          assert.strictEqual(counts.lineItemsUpserted, ShopLimits.maxLineItemsPerOrder);
          assert.strictEqual(
            Option.getOrThrow(detail).lineItems.length,
            ShopLimits.maxLineItemsPerOrder,
          );
        }),
    );
  });

  /**
   * Rule 11 on `syncOrder`, the write path: an item whose properties
   * overflow `maxPropertiesBytesPerItem` stores the prefix that fits, and the
   * order syncs.
   */
  it.effect("an item's properties past 8 KB are not stored and the order syncs", () => {
    const kept = { key: "text", value: "Hello" };
    return runInRepository(
      ndjson(orderLine(1, "2026-08-01T10:00:00Z"), {
        ...lineItemLine(1, 1),
        customAttributes: [
          kept,
          { key: "proof", value: "x".repeat(ShopLimits.maxPropertiesBytesPerItem) },
          { key: "after", value: "small" },
        ],
      }),
      (repository) =>
        Effect.gen(function* () {
          const counts = yield* stream(repository);
          const stored = Option.getOrThrow(yield* repository.getOrder(orderGid(1)));
          assert.strictEqual(counts.ordersUpserted, 1);
          assert.strictEqual(stored.lineItems.length, 1);
          assert.deepStrictEqual(stored.lineItems[0]?.properties, [kept]);
        }),
    );
  });

  it.effect("fails when a line item names a parent that is not the open order", () =>
    runInRepository(
      ndjson(orderLine(1, "2026-08-01T10:00:00Z"), lineItemLine(1, 99)),
      (repository) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(stream(repository));
          assert.strictEqual(error._tag, "OrdersStreamError");
          assert.strictEqual(
            error._tag === "OrdersStreamError" ? error.message : undefined,
            "Bulk line item parent did not match the active order",
          );
        }),
    ),
  );

  it.effect("maps an undecodable line to a stream error", () =>
    runInRepository(ndjson({ __typename: "Order", id: orderGid(1) }), (repository) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(stream(repository));
        assert.strictEqual(
          error._tag === "OrdersStreamError" ? error.message : undefined,
          "Bulk line could not be decoded",
        );
      }),
    ),
  );

  /**
   * The whole reason the stream merges instead of rebuilding: a webhook can
   * land a fresher view of an order while the file is still being read, and the
   * file's older line must not undo it.
   */
  it.effect("a stream that fails partway keeps the orders it wrote", () =>
    runInRepository(fixture, (repository) =>
      Effect.gen(function* () {
        let writes = 0;
        const failed = yield* runOrdersStream({
          repository,
          shop: STREAM_SHOP,
          url: BULK_URL,
          afterWrite: () => {
            writes += 1;
            return writes === 2 ? Effect.fail("reconcile failed" as const) : Effect.void;
          },
        }).pipe(Effect.flip);
        assert.strictEqual(failed, "reconcile failed");
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getOrder(orderGid(1))).lineItems.length,
          2,
        );
        // The failing order's own transaction rolled back (rule 6); the one
        // before it stays (rule 9).
        assert.isTrue(Option.isNone(yield* repository.getOrder(orderGid(2))));
      }),
    ),
  );

  it.effect("every streamed order carries one syncedAt, read before the file is fetched", () => {
    let now = Date.UTC(2026, 9, 1);
    const tick = () => {
      now += 1000;
      return now;
    };
    const stepped: Clock.Clock = {
      currentTimeMillisUnsafe: tick,
      currentTimeMillis: Effect.sync(tick),
      currentTimeNanosUnsafe: () => BigInt(tick()) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(tick()) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(tick()) * 1_000_000n,
      monotonicTimeNanos: Effect.sync(() => BigInt(tick()) * 1_000_000n),
      sleep: () => Effect.void,
    };
    let clockAtGet = 0;
    const observed = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          clockAtGet = now;
          return HttpClientResponse.fromWeb(request, new Response(fixture, { status: 200 }));
        }),
      ),
    );
    return runInRepository(fixture, (repository) =>
      Effect.gen(function* () {
        yield* stream(repository).pipe(
          Effect.provide(observed),
          Effect.provideService(Clock.Clock, stepped),
        );
        const synced = [
          Option.getOrThrow(yield* repository.getOrder(orderGid(1))).order.syncedAt,
          Option.getOrThrow(yield* repository.getOrder(orderGid(2))).order.syncedAt,
        ];
        assert.strictEqual(synced[0], synced[1]);
        // Read before the GET: the stepped clock ticked at least once in between.
        assert.isTrue((synced[0] ?? Infinity) < clockAtGet);
      }),
    );
  });

  it.effect("leaves a fresher webhook row untouched", () =>
    runInRepository(fixture, (repository) =>
      Effect.gen(function* () {
        yield* repository.upsertOrder({
          order: {
            id: orderGid(1),
            legacyId: "1",
            name: "#1001",
            processedAt: Date.UTC(2026, 7, 1),
            updatedAt: Date.parse("2026-08-05T00:00:00Z"),
            cancelledAt: null,
            fulfillmentStatus: "FULFILLED",
            fullyPaid: true,
            note: null,
            syncedAt: 0,
          },
          lineItems: [],
        });
        const counts = yield* stream(repository);
        const { order, lineItems } = Option.getOrThrow(yield* repository.getOrder(orderGid(1)));
        assert.strictEqual(counts.ordersSeen, 2);
        assert.strictEqual(counts.ordersUpserted, 1);
        assert.strictEqual(order.syncedAt, 0);
        assert.strictEqual(order.fulfillmentStatus, "FULFILLED");
        assert.strictEqual(lineItems.length, 0);
      }),
    ),
  );
});

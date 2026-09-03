import type * as Domain from "@/lib/Domain";

import { SqliteClient } from "@effect/sql-sqlite-do";
import { assertNone, assertSome, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { describe, it } from "vitest";

import { OrderRepository } from "@/lib/OrderRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgent";

const runInRepository = <A, E>(
  program: Effect.Effect<A, E, OrderRepository>,
): Promise<A> =>
  runInDurableObject(
    env.TEST_SQL_DO.get(env.TEST_SQL_DO.idFromName(crypto.randomUUID())),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          return yield* program;
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              OrderRepository.layer,
              SqliteClient.layer({ storage: state.storage }),
            ),
          ),
        ),
      ),
  );

const orderId = (n: number) => `gid://shopify/Order/${String(n)}`;
const lineItemId = (n: number) => `gid://shopify/LineItem/${String(n)}`;

const anOrder = (
  overrides: Partial<Domain.ShopOrder> = {},
): Domain.ShopOrder => ({
  id: orderId(1),
  legacyId: "1",
  name: "#1001",
  createdAt: 1000,
  processedAt: 1000,
  updatedAt: 1000,
  cancelledAt: null,
  closedAt: null,
  financialStatus: "PENDING",
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: false,
  tags: ["rush"],
  note: null,
  customAttributes: [{ key: "gift", value: "yes" }],
  lineItemsComplete: true,
  syncedAt: 1000,
  syncSource: "bulk",
  ...overrides,
});

const aLineItem = (
  n: number,
  overrides: Partial<Domain.OrderLineItem> = {},
): Domain.OrderLineItem => ({
  id: lineItemId(n),
  orderId: orderId(1),
  productId: `gid://shopify/Product/${String(n)}`,
  variantId: null,
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: `SKU-${String(n)}`,
  quantity: 1,
  currentQuantity: 1,
  unfulfilledQuantity: 1,
  nonFulfillableQuantity: 0,
  productTags: ["engraved"],
  customAttributes: [{ key: "text", value: "Hello" }],
  requiresShipping: true,
  ...overrides,
});

const upsert = (
  repository: typeof OrderRepository.Service,
  order: Domain.ShopOrder,
  lineItems: readonly Domain.OrderLineItem[],
) => repository.upsertOrder({ order, raw: "{}", lineItems });

describe("OrderRepository.upsertOrder", () => {
  it("stores an order with its line items", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.name, "#1001");
    strictEqual(order.fullyPaid, false);
    strictEqual(lineItems.length, 2);
    strictEqual(lineItems[0]?.productTags[0], "engraved");
    strictEqual(order.tags[0], "rush");
    strictEqual(order.customAttributes[0]?.value, "yes");
  });

  /**
   * The guard that lets a retried webhook, a mid-stream bulk line, and a manual
   * resync all write the same row in any order.
   */
  it("leaves the row and its line items alone for an older updatedAt", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder({ updatedAt: 2000 }), [aLineItem(1)]);
        const stale = yield* upsert(
          repository,
          anOrder({ updatedAt: 1000, name: "#STALE" }),
          [aLineItem(9)],
        );
        strictEqual(stale.written, false);
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.name, "#1001");
    strictEqual(lineItems.length, 1);
    strictEqual(lineItems[0]?.id, lineItemId(1));
  });

  it("replaces the line-item set when the write reports it is complete", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        yield* upsert(repository, anOrder({ updatedAt: 3000 }), [aLineItem(2)]);
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { lineItems } = Option.getOrThrow(detail);
    strictEqual(lineItems.length, 1);
    strictEqual(lineItems[0]?.id, lineItemId(2));
  });

  it("merges instead of replacing when the fetch was truncated", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        yield* upsert(
          repository,
          anOrder({ updatedAt: 3000, lineItemsComplete: false }),
          [aLineItem(3)],
        );
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.lineItemsComplete, false);
    strictEqual(lineItems.length, 3);
  });

  it("deletes the order and its line items together", async () => {
    const [detail, updatedAt] = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1)]);
        yield* repository.deleteOrder(orderId(1));
        return [
          yield* repository.getOrder(orderId(1)),
          yield* repository.getOrderUpdatedAt(orderId(1)),
        ] as const;
      }),
    );
    assertNone(detail);
    assertNone(updatedAt);
  });
});

describe("OrderRepository.listOrders", () => {
  it("pages newest first through a keyset cursor", async () => {
    const { first, second } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* Effect.forEach([1, 2, 3], (n) =>
          upsert(
            repository,
            anOrder({
              id: orderId(n),
              legacyId: String(n),
              name: `#100${String(n)}`,
              processedAt: n * 1000,
            }),
            [aLineItem(n, { orderId: orderId(n) })],
          ),
        );
        const first = yield* repository.listOrders({ limit: 2, cursor: null });
        return {
          first,
          second: yield* repository.listOrders({
            limit: 2,
            cursor: first.nextCursor,
          }),
        };
      }),
    );
    strictEqual(first.orderCount, 3);
    strictEqual(first.orders.length, 2);
    strictEqual(first.orders[0]?.order.name, "#1003");
    strictEqual(first.orders[1]?.order.name, "#1002");
    strictEqual(first.orders[0]?.itemUnits, 1);
    strictEqual(first.orders[0]?.runs.open, 0);
    strictEqual(second.orders.length, 1);
    strictEqual(second.orders[0]?.order.name, "#1001");
    strictEqual(second.nextCursor, null);
  });
});

describe("OrderRepository.recordWebhookDelivery", () => {
  it("reports the first delivery as new and a redelivery as seen", async () => {
    const [first, second] = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const delivery = {
          webhookId: "wh-1",
          topic: "orders/updated",
          orderId: orderId(1),
          triggeredAt: 10,
          receivedAt: 11,
        };
        return [
          yield* repository.recordWebhookDelivery(delivery),
          yield* repository.recordWebhookDelivery(delivery),
        ] as const;
      }),
    );
    strictEqual(first, true);
    strictEqual(second, false);
  });
});

describe("OrderRepository sync state", () => {
  it("starts idle, reserves, and completes", async () => {
    const { idle, reserved, completed } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const idle = yield* repository.getSyncState();
        const reserved = yield* repository.reserveSync({
          workflowId: "wf-1",
          startedAt: 5000,
          windowStart: 1000,
        });
        return {
          idle,
          reserved,
          completed: yield* repository.completeSync({ startedAt: 5000 }),
        };
      }),
    );
    strictEqual(idle.workflowId, null);
    strictEqual(idle.lastFullSyncAt, null);
    strictEqual(reserved.workflowId, "wf-1");
    strictEqual(reserved.lastFullSyncWindowStart, 1000);
    strictEqual(completed.workflowId, null);
    strictEqual(completed.lastFullSyncAt, 5000);
  });

  /**
   * A completion callback from a superseded run must not release the claim the
   * run that replaced it is holding.
   */
  it("ignores a completion for a run that is no longer the reserved one", async () => {
    const state = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.reserveSync({
          workflowId: "wf-1",
          startedAt: 5000,
          windowStart: 1000,
        });
        yield* repository.reserveSync({
          workflowId: "wf-2",
          startedAt: 9000,
          windowStart: 4000,
        });
        return yield* repository.completeSync({ startedAt: 5000 });
      }),
    );
    strictEqual(state.workflowId, "wf-2");
    strictEqual(state.startedAt, 9000);
    strictEqual(state.lastFullSyncAt, null);
  });

  it("records the error and releases the claim on failure", async () => {
    const state = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.reserveSync({
          workflowId: "wf-1",
          startedAt: 5000,
          windowStart: 1000,
        });
        return yield* repository.failSync({
          startedAt: 5000,
          error: "bulk submit failed",
        });
      }),
    );
    strictEqual(state.workflowId, null);
    strictEqual(state.lastError, "bulk submit failed");
  });

  it("reports the stored updatedAt for the webhook staleness check", async () => {
    const updatedAt = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder({ updatedAt: 7000 }), []);
        return yield* repository.getOrderUpdatedAt(orderId(1));
      }),
    );
    assertSome(updatedAt, 7000);
  });
});

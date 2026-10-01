import { SqliteClient } from "@effect/sql-sqlite-do";
import { strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { RunRepository } from "@/lib/RunRepository";
import { runShopAgentOrdersStream } from "@/lib/ShopAgentOrdersStream";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

const BULK_URL = "https://storage.googleapis.test/bulk-orders.jsonl";

const httpClientLayer = (body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: 200 }),
        ),
      ),
    ),
  );

/**
 * The real repository over a real Durable Object SQLite, not a stub: what these
 * tests are actually about is the fold meeting the guarded upsert, which a fake
 * repository would define away.
 */
const runInDo = <A, E>(
  body: string,
  program: Effect.Effect<A, E, OrderRepository | HttpClient.HttpClient>,
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
            Layer.merge(
              Layer.provideMerge(
                OrderRepository.layer,
                SqliteClient.layer({ storage: state.storage }),
              ),
              httpClientLayer(body),
            ),
          ),
        ),
      ),
  );

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

describe("runShopAgentOrdersStream", () => {
  it("folds the flattened NDJSON into orders with their line items", async () => {
    const { counts, first, second } = await runInDo(
      fixture,
      Effect.gen(function* () {
        const counts = yield* runShopAgentOrdersStream({ url: BULK_URL });
        const repository = yield* OrderRepository;
        return {
          counts,
          first: yield* repository.getOrder(orderGid(1)),
          second: yield* repository.getOrder(orderGid(2)),
        };
      }),
    );
    strictEqual(counts.ordersSeen, 2);
    strictEqual(counts.ordersUpserted, 2);
    strictEqual(counts.lineItemsUpserted, 3);
    const one = Option.getOrThrow(first);
    strictEqual(one.order.name, "#1001");
    strictEqual(one.order.fullyPaid, true);
    strictEqual(one.order.lineItemsTruncated, false);
    strictEqual(one.lineItems.length, 2);
    strictEqual(one.lineItems[0]?.productTags[0], "engraved");
    strictEqual(one.lineItems[0]?.properties[0]?.value, "Hello");
    strictEqual(Option.getOrThrow(second).lineItems.length, 1);
  });

  it("caps an order's line items and flags it rather than failing the sync", async () => {
    const over = Domain.ShopLimits.maxLineItemsPerOrder + 1;
    const { counts, detail } = await runInDo(
      ndjson(
        orderLine(1, "2026-08-01T10:00:00Z"),
        ...Array.from({ length: over }, (_, index) =>
          lineItemLine(index + 1, 1),
        ),
      ),
      Effect.gen(function* () {
        const counts = yield* runShopAgentOrdersStream({ url: BULK_URL });
        return {
          counts,
          detail: yield* (yield* OrderRepository).getOrder(orderGid(1)),
        };
      }),
    );
    strictEqual(counts.ordersSeen, 1);
    strictEqual(counts.ordersTruncated, 1);
    strictEqual(counts.ordersInserted, 1);
    strictEqual(
      counts.lineItemsUpserted,
      Domain.ShopLimits.maxLineItemsPerOrder,
    );
    const stored = Option.getOrThrow(detail);
    strictEqual(
      stored.lineItems.length,
      Domain.ShopLimits.maxLineItemsPerOrder,
    );
    strictEqual(stored.order.lineItemsTruncated, true);
  });

  it("fails when a line item names a parent that is not the open order", async () => {
    const message = await runInDo(
      ndjson(orderLine(1, "2026-08-01T10:00:00Z"), lineItemLine(1, 99)),
      runShopAgentOrdersStream({ url: BULK_URL }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      ),
    );
    strictEqual(
      message,
      "Bulk line item parent did not match the active order",
    );
  });

  it("maps an undecodable line to a stream error", async () => {
    const message = await runInDo(
      ndjson({ __typename: "Order", id: orderGid(1) }),
      runShopAgentOrdersStream({ url: BULK_URL }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      ),
    );
    strictEqual(message, "Bulk line could not be decoded");
  });

  /**
   * The whole reason the stream merges instead of rebuilding: a webhook can
   * land a fresher view of an order while the file is still being read, and the
   * file's older line must not undo it.
   */
  it("a stream that fails partway keeps the orders it wrote", async () => {
    const { failed, first, second } = await runInDo(
      fixture,
      Effect.gen(function* () {
        let writes = 0;
        const failed = yield* runShopAgentOrdersStream({
          url: BULK_URL,
          afterWrite: () => {
            writes += 1;
            return writes === 2
              ? Effect.fail("reconcile failed" as const)
              : Effect.succeed({ ceilingReleased: false });
          },
        }).pipe(Effect.flip);
        const repository = yield* OrderRepository;
        return {
          failed,
          first: yield* repository.getOrder(orderGid(1)),
          second: yield* repository.getOrder(orderGid(2)),
        };
      }),
    );
    strictEqual(failed, "reconcile failed");
    strictEqual(Option.getOrThrow(first).lineItems.length, 2);
    // The failing order's own transaction rolled back (rule 6); the one
    // before it stays (rule 9).
    strictEqual(Option.isNone(second), true);
  });

  it("every streamed order carries one syncedAt, read before the file is fetched", async () => {
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
          return HttpClientResponse.fromWeb(
            request,
            new Response(fixture, { status: 200 }),
          );
        }),
      ),
    );
    const synced = await runInDo(
      fixture,
      Effect.gen(function* () {
        yield* runShopAgentOrdersStream({ url: BULK_URL }).pipe(
          Effect.provide(observed),
          Effect.provideService(Clock.Clock, stepped),
        );
        const repository = yield* OrderRepository;
        return [
          Option.getOrThrow(yield* repository.getOrder(orderGid(1))).order
            .syncedAt,
          Option.getOrThrow(yield* repository.getOrder(orderGid(2))).order
            .syncedAt,
        ];
      }),
    );
    strictEqual(synced[0], synced[1]);
    // Read before the GET: the stepped clock ticked at least once in between.
    strictEqual((synced[0] ?? Infinity) < clockAtGet, true);
  });

  it("leaves a fresher webhook row untouched", async () => {
    const { counts, detail } = await runInDo(
      fixture,
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.upsertOrder({
          order: {
            id: orderGid(1),
            legacyId: "1",
            name: "#1001",
            processedAt: 0,
            updatedAt: Date.parse("2026-08-05T00:00:00Z"),
            cancelledAt: null,
            fulfillmentStatus: "FULFILLED",
            fullyPaid: true,
            note: null,
            lineItemsTruncated: false,
            syncedAt: 0,
          },
          lineItems: [],
        });
        return {
          counts: yield* runShopAgentOrdersStream({ url: BULK_URL }),
          detail: yield* repository.getOrder(orderGid(1)),
        };
      }),
    );
    strictEqual(counts.ordersSeen, 2);
    strictEqual(counts.ordersUpserted, 1);
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.syncedAt, 0);
    strictEqual(order.fulfillmentStatus, "FULFILLED");
    strictEqual(lineItems.length, 0);
  });
});

/**
 * The bulk path routes with the same rules as a webhook: the reconcile hook
 * runs inside each order's upsert transaction, and the source changes
 * nothing: an on workflow applies to every open order the file carries,
 * however old.
 */
describe("runShopAgentOrdersStream with afterWrite", () => {
  const runWithRuns = <A, E>(
    body: string,
    program: Effect.Effect<
      A,
      E,
      | OrderRepository
      | WorkflowRepository
      | RunRepository
      | HttpClient.HttpClient
    >,
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
              Layer.merge(
                Layer.mergeAll(
                  WorkflowRepository.layer,
                  RunRepository.layer,
                ).pipe(
                  Layer.provideMerge(OrderRepository.layer),
                  Layer.provideMerge(
                    SqliteClient.layer({ storage: state.storage }),
                  ),
                ),
                httpClientLayer(body),
              ),
            ),
          ),
        ),
    );

  it("creates runs on every streamed open order that matches, however old, and a re-stream creates none", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const body = ndjson(
      orderLine(1, "2026-08-01T10:00:00Z"),
      lineItemLine(1, 1),
      { ...orderLine(2, future), processedAt: future },
      lineItemLine(2, 2),
    );
    const { first, second, secondPass } = await runWithRuns(
      body,
      Effect.gen(function* () {
        const workflows = yield* WorkflowRepository;
        const runs = yield* RunRepository;
        const team = {
          id: Schema.decodeUnknownSync(Domain.TeamId)("t1"),
          name: Schema.decodeUnknownSync(Domain.TeamName)("Engravers"),
        };
        const workflow = yield* workflows.createWorkflow({
          name: Schema.decodeUnknownSync(Domain.WorkflowName)("Engrave"),
          tag: Schema.decodeUnknownSync(Domain.WorkflowTag)("engraved"),
        });
        yield* workflows.addStep({
          workflowId: workflow.id,
          name: Schema.decodeUnknownSync(Domain.TaskName)("Engrave"),
          teamId: team.id,
        });
        yield* workflows.applyDraft({
          workflowId: workflow.id,
          teams: [team],
        });
        yield* workflows.setWorkflowOn({
          workflowId: workflow.id,
          on: true,
          teams: [team],
        });
        const context = {
          workflows: yield* workflows.listOnWorkflowDetails(),
          teams: [team],
        };
        const afterWrite = (order: Domain.ShopOrder) =>
          runs.reconcileOrder({ ...context, orderId: order.id });
        yield* runShopAgentOrdersStream({ url: BULK_URL, afterWrite });
        const first = yield* runs.listRunsForOrder({ orderId: orderGid(1) });
        const second = yield* runs.listRunsForOrder({ orderId: orderGid(2) });
        yield* runShopAgentOrdersStream({ url: BULK_URL, afterWrite });
        const secondPass = yield* runs.listRunsForOrder({
          orderId: orderGid(2),
        });
        return { first, second, secondPass };
      }),
    );
    strictEqual(first.length, 1);
    strictEqual(second.length, 1);
    strictEqual(second[0]?.tasks[0]?.teamName, "Engravers");
    strictEqual(secondPass.length, 1);
  });
});

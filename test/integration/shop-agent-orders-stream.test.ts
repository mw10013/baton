import { SqliteClient } from "@effect/sql-sqlite-do";
import { strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgent";
import { runShopAgentOrdersStream } from "@/lib/ShopAgentOrdersStream";
import { WorkflowRepository } from "@/lib/WorkflowRepository";
import { WorkflowRunRepository } from "@/lib/WorkflowRunRepository";

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
  createdAt: "2026-08-01T00:00:00Z",
  processedAt: `2026-08-0${String(n)}T00:00:00Z`,
  updatedAt,
  cancelledAt: null,
  closedAt: null,
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  tags: ["rush"],
  note: null,
  customAttributes: [],
});

const lineItemLine = (n: number, parent: number) => ({
  __typename: "LineItem",
  id: lineItemGid(n),
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: `SKU-${String(n)}`,
  quantity: 1,
  currentQuantity: 1,
  unfulfilledQuantity: 1,
  nonFulfillableQuantity: 0,
  requiresShipping: true,
  customAttributes: [{ key: "text", value: "Hello" }],
  variant: { id: `gid://shopify/ProductVariant/${String(n)}` },
  product: { id: `gid://shopify/Product/${String(n)}`, tags: ["engraved"] },
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
    strictEqual(one.order.syncSource, "bulk");
    strictEqual(one.order.lineItemsComplete, true);
    strictEqual(one.lineItems.length, 2);
    strictEqual(one.lineItems[0]?.productTags[0], "engraved");
    strictEqual(one.lineItems[0]?.customAttributes[0]?.value, "Hello");
    strictEqual(Option.getOrThrow(second).lineItems.length, 1);
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
            createdAt: 0,
            processedAt: 0,
            updatedAt: Date.parse("2026-08-05T00:00:00Z"),
            cancelledAt: null,
            closedAt: null,
            financialStatus: "REFUNDED",
            fulfillmentStatus: "FULFILLED",
            fullyPaid: true,
            tags: [],
            note: null,
            customAttributes: [],
            lineItemsComplete: true,
            syncedAt: 0,
            syncSource: "webhook",
          },
          raw: "{}",
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
    strictEqual(order.syncSource, "webhook");
    strictEqual(order.financialStatus, "REFUNDED");
    strictEqual(lineItems.length, 0);
  });
});

/**
 * The bulk path routes with the same rules as a webhook: the reconcile hook
 * runs inside each order's upsert transaction, and the age rule — not the
 * source — is what keeps a thirty-day history file from starting work on
 * orders placed before the workflow existed.
 */
describe("runShopAgentOrdersStream with afterWrite", () => {
  const runWithRuns = <A, E>(
    body: string,
    program: Effect.Effect<
      A,
      E,
      | OrderRepository
      | WorkflowRepository
      | WorkflowRunRepository
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
                Layer.provideMerge(
                  Layer.mergeAll(
                    OrderRepository.layer,
                    WorkflowRepository.layer,
                    WorkflowRunRepository.layer,
                  ),
                  SqliteClient.layer({ storage: state.storage }),
                ),
                httpClientLayer(body),
              ),
            ),
          ),
        ),
    );

  it("creates runs only for orders processed after the workflow was created; a re-stream creates none", async () => {
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
        const runs = yield* WorkflowRunRepository;
        const team = {
          id: Schema.decodeUnknownSync(Domain.TeamId)("t1"),
          name: Schema.decodeUnknownSync(Domain.TeamName)("Engravers"),
        };
        const workflow = yield* workflows.createWorkflow({
          name: Schema.decodeUnknownSync(Domain.WorkflowName)("Engrave"),
          tags: Schema.decodeUnknownSync(Domain.ProductTags)(["engraved"]),
        });
        yield* workflows.addStep({
          workflowId: workflow.id,
          name: Schema.decodeUnknownSync(Domain.StepName)("Engrave"),
          teamId: team.id,
        });
        const context = {
          workflows: yield* workflows.listActiveWorkflowDetails(),
          activeTeams: [team],
        };
        const afterWrite = (order: Domain.ShopOrder) =>
          runs
            .reconcileOrder({ ...context, orderId: order.id })
            .pipe(Effect.asVoid);
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
    strictEqual(first.length, 0);
    strictEqual(second.length, 1);
    strictEqual(second[0]?.run.source, "tag");
    strictEqual(second[0]?.steps[0]?.teamName, "Engravers");
    strictEqual(secondPass.length, 1);
  });
});

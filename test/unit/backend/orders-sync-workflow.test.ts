import { assert, describe, it } from "@effect/vitest";
import { type ShopSession } from "../../../src/domain/platform.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  bulkOrdersQueryText,
  OrdersBulkOperation,
} from "../../../src/backend/orders-bulk-operation.ts";
import {
  BULK_GIVE_UP_MS,
  BULK_POLL_INTERVAL_MS,
  GAVE_UP_MESSAGE,
} from "../../../src/backend/orders-sync-constants.ts";
import { ORDER_SYNC_WINDOW_DAYS } from "../../../src/contract/orders.ts";
import {
  type OrdersSyncParams,
  ordersSyncBody,
} from "../../../src/backend/orders-sync-workflow.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import { ReauthorizationRequired } from "../../../src/backend/shopify.ts";
import type { ShopifyAdminError } from "../../../src/backend/shopify-admin.ts";
import type { BulkOperation } from "../../../src/domain/orders.ts";
import { SEED_SHOP, SEED_SHOP_GID } from "../../seed-shops.ts";
import { type AdminCall, QuietLogs, testShopify, testShopifyAdmin } from "./layers.ts";

/**
 * `OrdersSyncWorkflow`'s body with its steps stubbed: a `task` runs its effect once, with no
 * retry, and a `sleep` returns at once, each recording its name. What is asserted is the
 * orchestration (which steps run, in what order, where a failure lands); the stream is
 * `runOrdersStream`'s tests, and the real Workflow runs in integ. The poll loop is bounded by
 * its attempt count, never the clock, so no `TestClock` is needed to reach the give-up.
 */

const WORKFLOW_ID = "wf-1";

const session: ShopSession = {
  shop: SEED_SHOP,
  shopGid: SEED_SHOP_GID,
  shopActorId: SEED_SHOP,
  scope: "read_orders",
  accessTokenExpiresAt: 1_900_000_000_000,
  accessToken: "shpat_secret_access",
  refreshToken: "shprt_secret_refresh",
  refreshTokenExpiresAt: 1_900_000_000_000,
  refreshLeaseUntil: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};

const completedOperation: BulkOperation = {
  id: "gid://shopify/BulkOperation/1",
  status: "COMPLETED",
  errorCode: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: "2026-09-01T00:01:00.000Z",
  objectCount: 12,
  fileSize: 2048,
  url: "https://storage.googleapis.test/bulk-orders.jsonl",
  partialDataUrl: null,
};

const runningOperation: BulkOperation = {
  ...completedOperation,
  status: "RUNNING",
  completedAt: null,
  url: null,
};

/** Exactly the polls the workflow's bound allows. */
const POLL_COUNT = BULK_GIVE_UP_MS / BULK_POLL_INTERVAL_MS;

const submitted = (operation: BulkOperation) =>
  Effect.succeed({ bulkOperationRunQuery: { bulkOperation: operation, userErrors: [] } });
const polled = (operation: BulkOperation | null) => Effect.succeed({ bulkOperation: operation });
const cancelled = Effect.succeed({
  bulkOperationCancel: {
    bulkOperation: { id: completedOperation.id, status: "CANCELING" },
    userErrors: [],
  },
});

/** What one run did: its steps and sleeps in order, and the actor calls it made. */
interface Run {
  readonly steps: Array<string>;
  readonly actor: Array<{ readonly method: string; readonly input: unknown }>;
  readonly admin: Array<AdminCall>;
}

/** The actor's sync methods, recorded; every other method is `ShopActors.layerTest`'s. */
const recordingActors = (run: Run) =>
  Layer.effect(
    ShopActors,
    Effect.gen(function* () {
      const base = yield* ShopActors;
      const record = (method: string, input: unknown) =>
        Effect.sync(() => {
          run.actor.push({ method, input });
        });
      return {
        ...base,
        onOrdersStream: (_key, input) =>
          record("onOrdersStream", input).pipe(
            Effect.as({
              ordersSeen: 0,
              ordersUpserted: 0,
              lineItemsUpserted: 0,
              ordersTruncated: 0,
              ordersInserted: 0,
              ordersRefused: 0,
            }),
          ),
        onOrdersSyncEmpty: (_key, input) => record("onOrdersSyncEmpty", input),
        onOrdersSyncError: (_key, input) => record("onOrdersSyncError", input),
      };
    }),
  ).pipe(Layer.provide(ShopActors.layerTest([])));

/** Cloudflare's step API, stubbed: each step runs once, each sleep returns at once. */
const stubbedSteps = (run: Run) =>
  Layer.mergeAll(
    Layer.succeed(Cloudflare.Workflows.WorkflowStep, {
      do: <T, E>(options: Cloudflare.Workflows.WorkflowTaskOptions<T, unknown, unknown, E>) =>
        Effect.suspend(() => {
          run.steps.push(options.name);
          // `task` has already provided the body's services, as the bridge's own cast assumes.
          return Effect.scoped(options.effect as Effect.Effect<T, E, Scope.Scope>);
        }),
      sleep: (name) =>
        Effect.sync(() => {
          run.steps.push(name);
        }),
      sleepUntil: (name) =>
        Effect.sync(() => {
          run.steps.push(name);
        }),
      waitForEvent: () => Effect.die(new Error("the sync waits for no event")),
    }),
    Layer.succeed(Cloudflare.Workflows.WorkflowEvent, {
      payload: { shop: SEED_SHOP },
      timestamp: new Date(0),
      instanceId: WORKFLOW_ID,
      workflowName: "OrdersSyncWorkflow",
    }),
  );

/** One run of the body for {@link SEED_SHOP} against Admin `replies`; its exit and record. */
const runSync = (
  replies: Array<Effect.Effect<unknown, ShopifyAdminError>>,
  rows: ReadonlyArray<ShopSession> = [session],
) =>
  Effect.gen(function* () {
    const run: Run = { steps: [], actor: [], admin: [] };
    const exit = yield* Effect.gen(function* () {
      const body = yield* ordersSyncBody;
      const params: OrdersSyncParams = { shop: SEED_SHOP };
      return yield* body(params).pipe(Effect.provide(stubbedSteps(run)));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          OrdersBulkOperation.layer.pipe(Layer.provide(testShopifyAdmin(replies, run.admin))),
          recordingActors(run),
          testShopify(rows),
          QuietLogs,
        ),
      ),
      Effect.exit,
    );
    return { exit, ...run };
  });

const pollSteps = (count: number) =>
  Array.from({ length: count }, (_, attempt) => [
    `wait-for-bulk-orders-${String(attempt)}`,
    `poll-bulk-orders-${String(attempt)}`,
  ]).flat();

describe("OrdersSyncWorkflow shape", () => {
  it.effect("completes: ensure-session -> bulk COMPLETED -> on-orders-stream", () =>
    Effect.gen(function* () {
      const { exit, steps, actor } = yield* runSync([
        submitted(runningOperation),
        polled(completedOperation),
      ]);
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(steps, [
        "ensure-session",
        "run-bulk-orders-query",
        ...pollSteps(1),
        "on-orders-stream",
      ]);
      assert.deepStrictEqual(actor, [
        {
          method: "onOrdersStream",
          input: { workflowId: WORKFLOW_ID, url: completedOperation.url },
        },
      ]);
    }),
  );

  it.effect("completes: 30 days with no orders reaches on-orders-sync-empty", () =>
    Effect.gen(function* () {
      const { exit, steps, actor } = yield* runSync([
        submitted({ ...completedOperation, objectCount: 0, url: null }),
      ]);
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(steps, [
        "ensure-session",
        "run-bulk-orders-query",
        "on-orders-sync-empty",
      ]);
      assert.deepStrictEqual(actor, [
        { method: "onOrdersSyncEmpty", input: { workflowId: WORKFLOW_ID } },
      ]);
    }),
  );

  it.effect("a partial file is streamed and the sync completes", () =>
    Effect.gen(function* () {
      const partial = "https://storage.googleapis.test/partial.jsonl";
      const { exit, actor } = yield* runSync([
        submitted({ ...completedOperation, url: null, partialDataUrl: partial }),
      ]);
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(actor, [
        { method: "onOrdersStream", input: { workflowId: WORKFLOW_ID, url: partial } },
      ]);
    }),
  );

  /**
   * The bound is the attempt count, so the number of polls follows from the
   * two constants; every one of them is answered as still running, which is the
   * only way to reach the cancel.
   */
  it.effect(
    "gives up after five minutes, cancels the Shopify operation, and fails with a merchant message",
    () =>
      Effect.gen(function* () {
        const { exit, steps, actor, admin } = yield* runSync([
          submitted(runningOperation),
          ...Array.from({ length: POLL_COUNT }, () => polled(runningOperation)),
          cancelled,
        ]);
        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(steps, [
          "ensure-session",
          "run-bulk-orders-query",
          ...pollSteps(POLL_COUNT),
          "cancel-bulk-orders",
          "on-orders-sync-error",
        ]);
        assert.strictEqual(admin.length, POLL_COUNT + 2);
        assert.deepStrictEqual(actor, [
          {
            method: "onOrdersSyncError",
            input: { workflowId: WORKFLOW_ID, message: GAVE_UP_MESSAGE },
          },
        ]);
      }),
  );

  it.effect("a cancel that fails still leaves the give-up sentence", () =>
    Effect.gen(function* () {
      const { actor } = yield* runSync([
        submitted(runningOperation),
        ...Array.from({ length: POLL_COUNT }, () => polled(runningOperation)),
        Effect.die(new Error("cancel exploded")),
      ]);
      assert.deepStrictEqual(actor, [
        {
          method: "onOrdersSyncError",
          input: { workflowId: WORKFLOW_ID, message: GAVE_UP_MESSAGE },
        },
      ]);
    }),
  );

  /**
   * A terminal failure is not a give-up: there is nothing left to cancel, and
   * cancelling an operation Shopify has already finished with would be a
   * mutation the merchant never asked for.
   */
  it.effect("an EXPIRED or FAILED operation fails without cancelling", () =>
    Effect.gen(function* () {
      const { exit, steps, actor } = yield* runSync([
        submitted({ ...completedOperation, status: "EXPIRED", url: null }),
      ]);
      assert.isTrue(Exit.isFailure(exit));
      assert.notInclude(steps, "cancel-bulk-orders");
      assert.deepStrictEqual(actor, [
        {
          method: "onOrdersSyncError",
          input: { workflowId: WORKFLOW_ID, message: "Bulk operation did not complete: EXPIRED" },
        },
      ]);
    }),
  );

  it.effect("errors through the on-orders-sync-error sink when a step exhausts its retries", () =>
    Effect.gen(function* () {
      const { exit, steps, actor } = yield* runSync([
        Effect.fail(
          new ReauthorizationRequired({
            shop: SEED_SHOP,
            reason: "refresh-token-expired",
            refreshTokenExpiresAt: 0,
          }),
        ),
      ]);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(steps, [
        "ensure-session",
        "run-bulk-orders-query",
        "on-orders-sync-error",
      ]);
      assert.deepStrictEqual(actor, [
        {
          method: "onOrdersSyncError",
          input: { workflowId: WORKFLOW_ID, message: "Step failed: run-bulk-orders-query" },
        },
      ]);
    }),
  );

  it.effect("a shop with no session dies at ensure-session and calls Shopify for nothing", () =>
    Effect.gen(function* () {
      const { exit, steps, admin, actor } = yield* runSync([], []);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(steps, ["ensure-session", "on-orders-sync-error"]);
      assert.lengthOf(admin, 0);
      assert.deepStrictEqual(actor, [
        {
          method: "onOrdersSyncError",
          input: { workflowId: WORKFLOW_ID, message: "Step failed: ensure-session" },
        },
      ]);
    }),
  );
});

/**
 * The query string is built at runtime, so a GraphQL validator checks the document but
 * not the filter. This is the filter.
 */
describe("bulkOrdersQueryText", () => {
  it("the sync query is fixed: open, unfulfilled, created in the last 30 days", () => {
    const now = Date.UTC(2026, 8, 30);
    const text = bulkOrdersQueryText(now);
    assert.include(
      text,
      `created_at:>='${new Date(now - ORDER_SYNC_WINDOW_DAYS * 86_400_000).toISOString()}'`,
    );
    assert.include(text, "status:open -fulfillment_status:fulfilled");
    assert.notInclude(text, "updated_at");
  });
});

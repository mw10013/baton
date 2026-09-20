import type * as Domain from "@/lib/Domain";

import * as ShopifyApi from "@shopify/shopify-api";
import { getAgentByName } from "agents";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { bulkOrdersQueryText } from "@/lib/OrdersBulkRepository";
import {
  BULK_GIVE_UP_MS,
  BULK_POLL_INTERVAL_MS,
  ORDER_IMPORT_WINDOW_DAYS,
  ORDERS_SYNC_WORKFLOW_NAME,
} from "@/lib/orderSyncConstants";

const sessionProps = (shop: string) =>
  new ShopifyApi.Session({
    id: `offline_${shop}`,
    shop,
    state: "",
    isOnline: false,
    accessToken: "shpat_test",
    scope: "write_orders,read_products",
  }).toPropertyArray(true);

const completedOperation: Domain.BulkOperation = {
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

const runningOperation: Domain.BulkOperation = {
  ...completedOperation,
  status: "RUNNING",
  completedAt: null,
  url: null,
};

/** Exactly the polls the workflow's wall-clock bound allows. */
const POLL_COUNT = BULK_GIVE_UP_MS / BULK_POLL_INTERVAL_MS;

/** The orders view, for the sync state the workflow leaves behind. */
const listOrdersInput = {
  limit: 1,
  cursor: null,
  q: null,
  state: null,
  paid: null,
  attention: false,
  team: null,
} as const;

const startSync = async (shop: string) => {
  const agent = await getAgentByName(env.SHOP_AGENT, shop);
  await agent.syncOrders();
};

/**
 * Shape only: every step that would reach Shopify or the Durable Object's
 * stream is mocked, so what is asserted is the orchestration — which steps run,
 * in what order, and where a failure lands. The stream itself is covered by
 * `shop-agent-orders-stream.test.ts`.
 */
describe("OrdersSyncWorkflow shape", () => {
  it("completes: ensure-session -> bulk COMPLETED -> on-orders-stream", async () => {
    const shop = "orders-happy.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        completedOperation,
      );
      await m.mockStepResult({ name: "on-orders-stream" }, { ok: true });
    });

    await startSync(shop);

    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(
      instance.waitForStepResult({ name: "on-orders-stream" }),
    ).resolves.not.toThrow();
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  });

  it("completes: a window with no orders reaches on-orders-sync-empty", async () => {
    const shop = "orders-empty.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        { ...completedOperation, objectCount: 0, url: null },
      );
      await m.mockStepResult({ name: "on-orders-sync-empty" }, { ok: true });
    });

    await startSync(shop);

    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(
      instance.waitForStepResult({ name: "on-orders-sync-empty" }),
    ).resolves.not.toThrow();
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  });

  /**
   * This test prints two "uncaught exception; source = Uncaught (in promise)"
   * lines (`Error: bulk submit failed`, then `OrdersSyncWorkflowError: Step
   * failed: run-bulk-orders-query`). They are not a failure: miniflare's
   * Workflows engine catches the run's rejection and marks the instance
   * errored, which the assertions below prove, but workerd still logs the
   * rejection as it crosses the RPC boundary between the engine and the user
   * worker. Present on wrangler 4.135 too, so an upstream miniflare matter;
   * the test stays because it is the only proof the error sink records the
   * failure.
   */
  it("errors through the on-orders-sync-error sink when a step exhausts its retries", async () => {
    const shop = "orders-error.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepError(
        { name: "run-bulk-orders-query" },
        new Error("bulk submit failed"),
      );
    });

    await startSync(shop);

    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(
      instance.waitForStepResult({ name: "on-orders-sync-error" }),
    ).resolves.not.toThrow();
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
  });

  /**
   * The give-up bound is wall-clock, so the number of polls follows from the
   * two constants; every one of them is mocked as still running, which is the
   * only way to reach the cancel.
   */
  it("gives up after five minutes, cancels the Shopify operation, and fails with a merchant message", async () => {
    const shop = "orders-slow.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        runningOperation,
      );
      for (let attempt = 0; attempt < POLL_COUNT; attempt += 1)
        await m.mockStepResult(
          { name: `poll-bulk-orders-${String(attempt)}` },
          runningOperation,
        );
      await m.mockStepResult({ name: "cancel-bulk-orders" }, { ok: true });
    });

    await startSync(shop);

    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(
      instance.waitForStepResult({ name: "cancel-bulk-orders" }),
    ).resolves.not.toThrow();
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const { syncState } = await agent.listOrders(listOrdersInput);
    expect(syncState.lastError).toContain("did not finish the export in time");
  });

  /**
   * A terminal failure is not a give-up: there is nothing left to cancel, and
   * cancelling an operation Shopify has already finished with would be a
   * mutation the merchant never asked for.
   */
  it("an EXPIRED or FAILED operation fails without cancelling", async () => {
    const shop = "orders-expired.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        { ...completedOperation, status: "EXPIRED", url: null },
      );
    });

    await startSync(shop);

    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(
      instance.waitForStepResult({ name: "on-orders-sync-error" }),
    ).resolves.not.toThrow();
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
    /* The failure names the status Shopify reported, not the give-up message:
       the cancel is on the other branch, and a step that never ran cannot be
       waited for — `waitForStepResult` would hang rather than reject. */
    const { message } = await instance.getError();
    expect(message).toContain("EXPIRED");
    expect(message).not.toContain("did not finish the export in time");
  });

  /**
   * One import per shop, and the Agents SDK's own tracking row is what says
   * so: a second click while a run is tracked must be refused by the object
   * rather than by an already-exists error from the platform.
   */
  it("refuses a second import while one is tracked as running", async () => {
    const shop = "orders-singleton.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        runningOperation,
      );
    });

    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const first = await agent.syncOrders();
    const second = await agent.syncOrders();

    expect(first.status).toBe("started");
    expect(second.status).toBe("in_flight");
    const instances = await introspector.get();
    expect(instances.length).toBe(1);
  });

  /**
   * The SDK never reaps a tracking row, and a callback can be lost. Once the
   * platform has forgotten the instance too, the row is the only thing
   * disabling the button, so the click that finds it must clear it.
   *
   * The local Workflows binding rejects `get()` on a missing id and also
   * prints an "uncaught exception ... instance.not_found" line plus a
   * "code had hung" notice from workerd; both are the shim's, the test itself
   * completes.
   */
  it("a tracked import whose instance is gone is cleared on the next click", async () => {
    const shop = "orders-orphan-row.myshopify.com";
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    // Touch the object first so the SDK has created its tables.
    await agent.listOrders(listOrdersInput);
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        `insert into cf_agents_workflows (id, workflow_id, workflow_name, status, created_at, updated_at)
         values ('row', 'wf_never_existed', ?, 'running', unixepoch() - 3600, unixepoch() - 3600)`,
        ORDERS_SYNC_WORKFLOW_NAME,
      );
    });
    const before = await agent.listOrders(listOrdersInput);
    expect(before.syncState.inFlight).toBe(true);

    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        runningOperation,
      );
    });
    const result = await agent.syncOrders();

    expect(result.status).toBe("started");
    const instances = await introspector.get();
    expect(instances.length).toBe(1);
  });
});

/**
 * The query string is built at runtime, so codegen validates the document but
 * not the filter. This is the filter.
 */
describe("bulkOrdersQueryText", () => {
  it("the import query is fixed: open, unfulfilled, created in the last 30 days", () => {
    const now = Date.UTC(2026, 8, 30);
    const text = bulkOrdersQueryText(now);
    expect(text).toContain(
      `created_at:>='${new Date(now - ORDER_IMPORT_WINDOW_DAYS * 86_400_000).toISOString()}'`,
    );
    expect(text).toContain("status:open -fulfillment_status:fulfilled");
    expect(text).not.toContain("updated_at");
  });
});

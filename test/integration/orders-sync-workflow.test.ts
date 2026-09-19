import * as ShopifyApi from "@shopify/shopify-api";
import { getAgentByName } from "agents";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { bulkOrdersQueryText } from "@/lib/OrdersBulkRepository";

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
   * The reservation is the singleton, not the Cloudflare instance id: a second
   * click while a run is in flight must be refused by `SyncState` rather than by
   * an already-exists error from the platform.
   */
  it("refuses a second sync while one is reserved", async () => {
    const shop = "orders-singleton.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        { ...completedOperation, status: "RUNNING", url: null },
      );
    });

    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const first = await agent.syncOrders();
    const second = await agent.syncOrders();

    expect(first.workflowId).not.toBeNull();
    expect(second.workflowId).toBe(first.workflowId);
    expect(second.startedAt).toBe(first.startedAt);
    const instances = await introspector.get();
    expect(instances.length).toBe(1);
  });
});

/**
 * The storage guard, with the ceiling lowered to zero for the duration — the
 * real one is two gigabytes and no test is going to write that. Same seam, and
 * same reasoning, as `withMaxOpenRuns` in `workflow-run-repository.test.ts`.
 */
describe("syncOrders storage guard", () => {
  it("refuses the bulk import and leaves the reason on the sync state", async () => {
    const shop = "orders-storage.myshopify.com";
    const limits = Domain.ShopLimits as { storageSoftLimitBytes: number };
    const original = limits.storageSoftLimitBytes;
    limits.storageSoftLimitBytes = 0;
    try {
      await using introspector = await introspectWorkflow(
        env.ORDERS_SYNC_WORKFLOW,
      );
      const agent = await getAgentByName(env.SHOP_AGENT, shop);
      const state = await agent.syncOrders();
      expect(state.workflowId).toBeNull();
      expect(state.lastError).toContain("Storage limit reached");
      const instances = await introspector.get();
      expect(instances.length).toBe(0);
    } finally {
      limits.storageSoftLimitBytes = original;
    }
  });
});

/**
 * The query string is built at runtime from the window, so codegen validates
 * the document but not the filter. These are the filter.
 */
describe("bulkOrdersQueryText", () => {
  const windowStart = Date.UTC(2026, 8, 1);

  it("narrows the first sync to the open working set", () => {
    const text = bulkOrdersQueryText({ field: "created_at", windowStart });
    expect(text).toContain(
      `created_at:>='${new Date(windowStart).toISOString()}'`,
    );
    expect(text).toContain("status:open -fulfillment_status:fulfilled");
  });

  it("leaves later syncs unfiltered so a fulfilled order still updates", () => {
    const text = bulkOrdersQueryText({ field: "updated_at", windowStart });
    expect(text).toContain(
      `updated_at:>='${new Date(windowStart).toISOString()}'`,
    );
    expect(text).not.toContain("status:open");
    expect(text).not.toContain("fulfillment_status");
  });
});

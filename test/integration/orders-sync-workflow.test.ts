import type * as Domain from "@/lib/Domain";

import * as ShopifyApi from "@shopify/shopify-api";
import { getAgentByName } from "agents";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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

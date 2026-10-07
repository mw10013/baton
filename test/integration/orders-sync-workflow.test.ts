import type * as Domain from "@/lib/Domain";

import * as ShopifyApi from "@shopify/shopify-api";
import { getAgentByName } from "agents";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { bulkOrdersQueryText } from "@/lib/OrdersBulkRepository";
import {
  BULK_GIVE_UP_MS,
  BULK_POLL_INTERVAL_MS,
  ORDER_SYNC_WINDOW_DAYS,
  ORDERS_SYNC_WORKFLOW_NAME,
} from "@/lib/orderSyncConstants";

import { openTwoScreens, receivedInvalidations } from "./agent-socket.ts";
import { storeOpenOrders, withMaxOpenOrders } from "./open-order-ceiling.ts";

const sessionProps = (shop: string) =>
  new ShopifyApi.Session({
    id: `offline_${shop}`,
    shop,
    state: "",
    isOnline: false,
    accessToken: "shpat_test",
    scope: "read_orders,read_products",
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

/** The orders index's read, for the sync state the workflow leaves behind. */
const listOrdersInput = {
  limit: 1,
  cursor: null,
  q: null,
  show: "open",
  team: null,
} as const;

/** The sync state the orders index reads. */
const syncStateOf = async (shop: string) => {
  const agent = await getAgentByName(env.SHOP_AGENT, shop);
  const { syncState } = await agent.listOrders(listOrdersInput);
  return syncState;
};

/** The banner the orders index shows, or null. */
const lastErrorOf = (shop: string) =>
  syncStateOf(shop).then((state) => state.lastError);

/** `GAVE_UP_MESSAGE` in `OrdersSyncWorkflow.ts`, the banner a give-up leaves, verbatim. */
const GAVE_UP_MESSAGE = "Shopify did not finish the export in time. Try again.";

const startSync = async (shop: string) => {
  const agent = await getAgentByName(env.SHOP_AGENT, shop);
  await agent.syncOpenOrders();
};

const sqlOf = (instance: unknown) =>
  (instance as { ctx: DurableObjectState }).ctx.storage.sql;

/** The one `SyncState` row, every column, straight from the object's SQLite. */
const syncStateRow = (shop: string) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) =>
    sqlOf(instance).exec("select * from SyncState where id = 1").toArray(),
  );

/** The Agents SDK's tracking rows for the open-orders sync. */
const trackedSyncs = (shop: string) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) =>
    Number(
      sqlOf(instance)
        .exec(
          "select count(*) as n from cf_agents_workflows where workflow_name = ?",
          ORDERS_SYNC_WORKFLOW_NAME,
        )
        .one().n,
    ),
  );

/** Mocks a sync that polls until the give-up bound, then cancels. */
const mockGiveUp = async (
  shop: string,
  introspector: Awaited<ReturnType<typeof introspectWorkflow>>,
) => {
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
    await m.mockStepResult({ name: "run-bulk-orders-query" }, runningOperation);
    for (let attempt = 0; attempt < POLL_COUNT; attempt += 1)
      await m.mockStepResult(
        { name: `poll-bulk-orders-${String(attempt)}` },
        runningOperation,
      );
    await m.mockStepResult({ name: "cancel-bulk-orders" }, { ok: true });
  });
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

  it("completes: 30 days with no orders reaches on-orders-sync-empty", async () => {
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
    await mockGiveUp(shop, introspector);

    await startSync(shop);

    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(
      instance.waitForStepResult({ name: "cancel-bulk-orders" }),
    ).resolves.not.toThrow();
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const { syncState } = await agent.listOrders(listOrdersInput);
    expect(syncState.lastError).toBe(GAVE_UP_MESSAGE);
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
   * One open-orders sync per shop, and the Agents SDK's own tracking row is what says
   * so: a second click while a run is tracked must be refused by the object
   * rather than by an already-exists error from the platform.
   */
  it("refuses a second sync while one is tracked as running", async () => {
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
    const first = await agent.syncOpenOrders();
    const second = await agent.syncOpenOrders();

    expect(first._tag).toBe("Started");
    expect(second._tag).toBe("InFlight");
    const instances = await introspector.get();
    expect(instances.length).toBe(1);
  });

  it("a completed sync deletes the tracking row and writes nothing else", async () => {
    const shop = "orders-complete-state.myshopify.com";
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
    const agent = await getAgentByName(env.SHOP_AGENT, shop);

    await agent.syncOpenOrders();
    // The whole SyncState row as the start left it: completion must leave
    // every column as it is, whatever columns the row has.
    const started = await syncStateRow(shop);
    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    await vi.waitFor(async () => {
      expect(await trackedSyncs(shop)).toBe(0);
    });
    expect(await syncStateRow(shop)).toEqual(started);
    expect(await syncStateOf(shop)).toEqual({
      inFlight: false,
      lastError: null,
    });
  });

  it("a partial file is streamed and the sync completes", async () => {
    const shop = "orders-partial.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(shop));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        {
          ...completedOperation,
          url: null,
          partialDataUrl: "https://storage.googleapis.test/partial.jsonl",
        },
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

  it("a failed sync's banner is the merchant sentence, and the callback never overwrites it", async () => {
    const shop = "orders-banner.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await mockGiveUp(shop, introspector);

    await startSync(shop);

    const [instance] = await introspector.get();
    if (!instance) throw new Error("no workflow instance captured");
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
    await vi.waitFor(async () => {
      expect(await trackedSyncs(shop)).toBe(0);
    });
    expect(await lastErrorOf(shop)).toBe(GAVE_UP_MESSAGE);

    // A late callback, as the SDK sends after the sink: it must not replace
    // the sentence with the platform's own account of the failure.
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (object) =>
      object.onWorkflowError(
        ORDERS_SYNC_WORKFLOW_NAME,
        "wf_late",
        "Error: OrdersSyncWorkflowError: something else",
      ),
    );
    expect(await lastErrorOf(shop)).toBe(GAVE_UP_MESSAGE);
  });

  it("a start that fails leaves no tracking row and no banner", async () => {
    const shop = "orders-start-fails.myshopify.com";
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await agent.listOrders(listOrdersInput);
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), async (object) => {
      sqlOf(object).exec(
        "update SyncState set lastError = 'the last sync failed' where id = 1",
      );
      object.runWorkflow = () =>
        Promise.reject(new Error("workflow.create failed"));
      await expect(object.syncOpenOrders()).rejects.toThrow();
    });

    expect(await trackedSyncs(shop)).toBe(0);
    expect(await lastErrorOf(shop)).toBe(null);
  });

  it("a sync refused at the order ceiling flags the refusal, writes no error and tracks nothing", async () => {
    const shop = "orders-ceiling-refused.myshopify.com";
    await withMaxOpenOrders(2, async () => {
      const agent = await getAgentByName(env.SHOP_AGENT, shop);
      await storeOpenOrders(shop, 2);

      const result = await agent.syncOpenOrders();

      expect(result._tag).toBe("Refused");
      const usage = await agent.getUsage();
      expect(usage.ordersLimitedAt).not.toBeNull();
      const syncState = await syncStateOf(shop);
      expect(syncState.lastError).toBeNull();
      expect(await trackedSyncs(shop)).toBe(0);
    });
  });

  it("a tracking row disables Sync open orders only while it is fresh", async () => {
    const shop = "orders-fresh-row.myshopify.com";
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await agent.listOrders(listOrdersInput);
    const track = (id: string, ageSeconds: number) =>
      runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
        (
          instance as unknown as { ctx: DurableObjectState }
        ).ctx.storage.sql.exec(
          `insert into cf_agents_workflows (id, workflow_id, workflow_name, status, created_at, updated_at)
           values (?, ?, ?, 'running', unixepoch() - ?, unixepoch() - ?)`,
          id,
          `wf_${id}`,
          ORDERS_SYNC_WORKFLOW_NAME,
          ageSeconds,
          ageSeconds,
        );
      });
    await track("stale", 3600);
    const staleOnly = await agent.listOrders(listOrdersInput);
    expect(staleOnly.syncState.inFlight).toBe(false);
    await track("fresh", 60);
    const withFresh = await agent.listOrders(listOrdersInput);
    expect(withFresh.syncState.inFlight).toBe(true);
  });

  /**
   * The SDK never reaps a tracking row, and a callback can be lost. A row
   * older than ten minutes is dead: the button is enabled, and the press that
   * finds it deletes it without asking Cloudflare and starts a new sync.
   */
  it("a tracking row older than ten minutes is deleted on the next press", async () => {
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
    expect(before.syncState.inFlight).toBe(false);

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
    const result = await agent.syncOpenOrders();

    expect(result._tag).toBe("Started");
    const instances = await introspector.get();
    expect(instances.length).toBe(1);
    const rows = await runInDurableObject(
      env.SHOP_AGENT.getByName(shop),
      (instance) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
          .exec("select id from cf_agents_workflows")
          .toArray()
          .map((row) => row.id),
    );
    expect(rows).not.toContain("row");
  });
});

/**
 * The query string is built at runtime, so codegen validates the document but
 * not the filter. This is the filter.
 */
describe("bulkOrdersQueryText", () => {
  it("the sync query is fixed: open, unfulfilled, created in the last 30 days", () => {
    const now = Date.UTC(2026, 8, 30);
    const text = bulkOrdersQueryText(now);
    expect(text).toContain(
      `created_at:>='${new Date(now - ORDER_SYNC_WINDOW_DAYS * 86_400_000).toISOString()}'`,
    );
    expect(text).toContain("status:open -fulfillment_status:fulfilled");
    expect(text).not.toContain("updated_at");
  });
});

/**
 * The open-orders sync's rows of the sites table on `ShopAgent.publish`:
 * every one publishes to every connection, with no changed-or-nothing
 * gate, because the sync's state (the button, the banner) is on the orders
 * index whatever the stream did. Counted, because each case publishes more
 * than once on the same sockets.
 */
describe("OrdersSyncWorkflow publishes", () => {
  it("Sync open orders publishes to every screen when it starts or is refused", async () => {
    const started = "orders-publish-started.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    // Sleeps stay on, so the instance is still waiting on its first poll
    // when the start's invalidation is counted.
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(started));
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        runningOperation,
      );
    });
    const startedScreens = await openTwoScreens(started);
    const startedAgent = await getAgentByName(env.SHOP_AGENT, started);
    const start = await startedAgent.syncOpenOrders();
    expect(start._tag).toBe("Started");
    await receivedInvalidations(startedScreens.merchant, 1);
    await receivedInvalidations(startedScreens.member, 1);
    startedScreens.close();

    const refused = "orders-publish-refused.myshopify.com";
    await withMaxOpenOrders(2, async () => {
      const agent = await getAgentByName(env.SHOP_AGENT, refused);
      await storeOpenOrders(refused, 2);
      const refusedScreens = await openTwoScreens(refused);
      const refusal = await agent.syncOpenOrders();
      expect(refusal._tag).toBe("Refused");
      await receivedInvalidations(refusedScreens.merchant, 1);
      await receivedInvalidations(refusedScreens.member, 1);
      refusedScreens.close();
    });
  });

  it("the open-orders sync publishes to every screen when its workflow completes", async () => {
    const completes = "orders-publish-complete.myshopify.com";
    await using introspector = await introspectWorkflow(
      env.ORDERS_SYNC_WORKFLOW,
    );
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      await m.mockStepResult(
        { name: "ensure-session" },
        sessionProps(completes),
      );
      await m.mockStepResult(
        { name: "run-bulk-orders-query" },
        completedOperation,
      );
      await m.mockStepResult({ name: "on-orders-stream" }, { ok: true });
    });
    const completeScreens = await openTwoScreens(completes);
    await startSync(completes);
    const [completed] = await introspector.get();
    if (!completed) throw new Error("no workflow instance captured");
    await expect(completed.waitForStatus("complete")).resolves.not.toThrow();
    // The start, then the completion; the stream step is mocked, so it
    // publishes nothing of its own.
    await receivedInvalidations(completeScreens.merchant, 2);
    await receivedInvalidations(completeScreens.member, 2);
    completeScreens.close();
  });

  /**
   * Prints the same two uncaught-exception lines as the error-sink test
   * above, for the same reason.
   */
  it("the open-orders sync publishes to every screen when its workflow fails", async () => {
    const fails = "orders-publish-error.myshopify.com";
    await using failing = await introspectWorkflow(env.ORDERS_SYNC_WORKFLOW);
    await failing.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      await m.mockStepResult({ name: "ensure-session" }, sessionProps(fails));
      await m.mockStepError(
        { name: "run-bulk-orders-query" },
        new Error("bulk submit failed"),
      );
    });
    const failScreens = await openTwoScreens(fails);
    await startSync(fails);
    const [errored] = await failing.get();
    if (!errored) throw new Error("no workflow instance captured");
    await expect(errored.waitForStatus("errored")).resolves.not.toThrow();
    // The start, the error sink, then `onWorkflowError`.
    await receivedInvalidations(failScreens.merchant, 3);
    await receivedInvalidations(failScreens.member, 3);
    failScreens.close();
  });
});

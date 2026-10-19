import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Email } from "../../src/contract/auth.ts";
import { ShopKey } from "../../src/domain/platform.ts";
import type { BulkOperation, OrdersSyncStatus } from "../../src/domain/orders.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { dev, integ, openAs } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import type { ShopifyFakeReply } from "./rpcs.ts";
import Stack from "./stack.ts";

/**
 * Sync open orders end to end on the test stack: `MerchantSyncOpenOrders` on a forged merchant
 * socket, the shop actor's tracking record and the `OrdersSyncWorkflow` instance it creates,
 * running locally in the Backend's script against the fake Shopify, and the actor streaming the
 * bulk file the test Backend serves. The stale-record rule is a unit test over the repository. A
 * real Workflow sleeps its real poll interval, so a case with a poll takes five seconds or more.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("orderssync"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Long enough for a sync with one poll, and the Workflow engine's first local start. */
const SYNC_TIMEOUT = 60_000;

/** A shop `seed/test.sql` gives no `ShopSession`. */
const UNINSTALLED_SHOP = Schema.decodeUnknownSync(ShopKey)("uninstalled-shop.myshopify.com");

const orderGid = (n: number) => `gid://shopify/Order/${String(n)}`;

/** A bulk operation as Shopify answers it, in `status`. */
const anOperation = (overrides: Partial<BulkOperation> = {}): BulkOperation => ({
  id: "gid://shopify/BulkOperation/1",
  status: "RUNNING",
  errorCode: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  completedAt: null,
  objectCount: 0,
  fileSize: null,
  url: null,
  partialDataUrl: null,
  ...overrides,
});

const submitted = (operation: BulkOperation): ShopifyFakeReply => ({
  route: "graphql",
  status: 200,
  body: { data: { bulkOperationRunQuery: { bulkOperation: operation, userErrors: [] } } },
});

const polled = (operation: BulkOperation | null): ShopifyFakeReply => ({
  route: "graphql",
  status: 200,
  body: { data: { bulkOperation: operation } },
});

const bulkFile = (body: string): ShopifyFakeReply => ({ route: "bulk", status: 200, body });

/** Order `n`'s bulk lines: the order, then its one line item, as `BulkOrdersQuery` flattens them. */
const orderLines = (n: number) => [
  JSON.stringify({
    __typename: "Order",
    id: orderGid(n),
    legacyResourceId: String(n),
    name: `#${String(2000 + n)}`,
    processedAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    cancelledAt: null,
    displayFulfillmentStatus: "UNFULFILLED",
    fullyPaid: true,
    note: null,
  }),
  JSON.stringify({
    __typename: "LineItem",
    id: `gid://shopify/LineItem/${String(n)}`,
    title: "Walnut cutting board",
    variantTitle: null,
    sku: null,
    quantity: 1,
    currentQuantity: 1,
    customAttributes: [{ key: "text", value: "Hello" }],
    product: { tags: ["engraved"] },
    __parentId: orderGid(n),
  }),
];

const script = (backendUrl: string, replies: ReadonlyArray<ShopifyFakeReply>) =>
  integ(backendUrl, (c) => c.ScriptShopify({ replies }));

const shopifyRoutes = (backendUrl: string) =>
  integ(backendUrl, (c) => c.ShopifyCalls({})).pipe(
    Effect.map((calls) => calls.map(({ route }) => route)),
  );

/** Sync open orders: `MerchantSyncOpenOrders` on a merchant socket, its answer's tag. */
const syncOpenOrders = (backendUrl: string, shop: ShopKey) =>
  Effect.gen(function* () {
    const { client } = yield* openAs(backendUrl, shop, { role: "merchant" });
    return (yield* client.MerchantSyncOpenOrders())._tag;
  }).pipe(Effect.scoped);

/** `MerchantSyncStatus` on a merchant socket, as the orders index reads it. */
const syncStatus = (backendUrl: string, shop: ShopKey) =>
  Effect.gen(function* () {
    const { client } = yield* openAs(backendUrl, shop, { role: "merchant" });
    return yield* client.MerchantSyncStatus();
  }).pipe(Effect.scoped);

/** The sync status once no sync is in flight, polled every 250 ms. */
const settled = (backendUrl: string, shop: ShopKey) =>
  syncStatus(backendUrl, shop).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("250 millis"),
      until: (status: OrdersSyncStatus) => !status.inFlight,
    }),
  );

const orderIds = (backendUrl: string, shop: ShopKey) =>
  integ(backendUrl, (c) =>
    c.ListOrders({ shop, limit: 50, cursor: null, q: null, show: "all", team: null }),
  ).pipe(Effect.map(({ page }) => page.orders.map(({ order }) => order.id).toSorted()));

/** Empties `shop`'s orders: a load of an empty fixture. */
const reset = (backendUrl: string, shop: ShopKey) =>
  dev(backendUrl, (c) =>
    c.LoadFixture({ shop, fixture: { members: [], teams: [], workflows: [], orders: [] } }),
  );

/** Logs how long a sync took, for the record of what a real poll interval costs. */
const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.timed(effect).pipe(
    Effect.tap(([duration]) => Effect.sync(() => console.info(`${label}: ${String(duration)}`))),
    Effect.map(([, value]) => value),
  );

/**
 * The gate refuses a socket to a shop with no `ShopSession`, so this is the row deleted while a
 * socket stays open: the forged-caller route opens one anyway.
 */
test(
  "a shop whose ShopSession is gone is refused OfflineSessionMissing, with nothing recorded and no instance",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* script(backendUrl, []);
    const refused = yield* Effect.flip(syncOpenOrders(backendUrl, UNINSTALLED_SHOP));
    assert.strictEqual(refused._tag, "OfflineSessionMissing");
    assert.isFalse((yield* syncStatus(backendUrl, UNINSTALLED_SHOP)).inFlight);
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), []);
  }),
);

test(
  "a member socket is refused MerchantSyncOpenOrders",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* script(backendUrl, []);
    yield* Effect.gen(function* () {
      const member = yield* openAs(backendUrl, SEED_SHOP, {
        role: "member",
        memberId: "mem-sync",
        memberEmail: Schema.decodeUnknownSync(Email)("sync@m.com"),
        teamIds: [],
        userId: "user-sync",
        sessionId: "session-sync",
        sessionExpiresAt: Date.now() + 600_000,
      });
      const error = yield* member.client.MerchantSyncOpenOrders().pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
    }).pipe(Effect.scoped);
    assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), []);
  }),
);

test(
  "completes: ensure-session -> bulk COMPLETED -> on-orders-stream",
  timed(
    "completes through on-orders-stream",
    Effect.gen(function* () {
      const { backendUrl } = yield* stack;
      yield* reset(backendUrl, SEED_SHOP);
      yield* script(backendUrl, [
        submitted(anOperation({ status: "CREATED" })),
        polled(anOperation({ status: "RUNNING" })),
        polled(
          anOperation({
            status: "COMPLETED",
            objectCount: 4,
            url: `${backendUrl}/api/integ/bulk/1`,
          }),
        ),
        bulkFile([...orderLines(1), "", ...orderLines(2)].join("\n")),
      ]);
      assert.strictEqual(yield* syncOpenOrders(backendUrl, SEED_SHOP), "Started");
      assert.isTrue((yield* syncStatus(backendUrl, SEED_SHOP)).inFlight);
      const stored = yield* orderIds(backendUrl, SEED_SHOP).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (ids) => ids.length === 2,
        }),
      );
      assert.deepStrictEqual(stored, [orderGid(1), orderGid(2)]);
      assert.deepStrictEqual(yield* settled(backendUrl, SEED_SHOP), {
        inFlight: false,
        lastError: null,
      });
      // The Workflow's Admin calls reached the fake, and the actor fetched the file once.
      assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), [
        "graphql",
        "graphql",
        "graphql",
        "bulk",
      ]);
    }),
  ),
  SYNC_TIMEOUT,
);

test(
  "completes: 30 days with no orders reaches on-orders-sync-empty",
  timed(
    "completes through on-orders-sync-empty",
    Effect.gen(function* () {
      const { backendUrl } = yield* stack;
      const before = yield* orderIds(backendUrl, SEED_SHOP);
      yield* script(backendUrl, [submitted(anOperation({ status: "COMPLETED" }))]);
      assert.strictEqual(yield* syncOpenOrders(backendUrl, SEED_SHOP), "Started");
      assert.deepStrictEqual(yield* settled(backendUrl, SEED_SHOP), {
        inFlight: false,
        lastError: null,
      });
      // Nothing stored is touched: an empty export means nothing changed.
      assert.deepStrictEqual(yield* orderIds(backendUrl, SEED_SHOP), before);
      assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), ["graphql"]);
    }),
  ),
  SYNC_TIMEOUT,
);

test(
  "refuses a second sync while one is tracked as running",
  timed(
    "refuses a second sync",
    Effect.gen(function* () {
      const { backendUrl } = yield* stack;
      yield* script(backendUrl, [
        submitted(anOperation({ status: "RUNNING" })),
        polled(anOperation({ status: "COMPLETED" })),
      ]);
      assert.strictEqual(yield* syncOpenOrders(backendUrl, OTHER_SHOP), "Started");
      assert.strictEqual(yield* syncOpenOrders(backendUrl, OTHER_SHOP), "InFlight");
      assert.isFalse((yield* settled(backendUrl, OTHER_SHOP)).inFlight);
      // One instance only: the second press made no Shopify call.
      assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), ["graphql", "graphql"]);
    }),
  ),
  SYNC_TIMEOUT,
);

test(
  "a failed sync's banner is the merchant sentence, and the callback never overwrites it",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* script(backendUrl, [submitted(anOperation({ status: "FAILED" }))]);
    assert.strictEqual(yield* syncOpenOrders(backendUrl, OTHER_SHOP), "Started");
    const sentence = "Bulk operation did not complete: FAILED";
    assert.deepStrictEqual(yield* settled(backendUrl, OTHER_SHOP), {
      inFlight: false,
      lastError: sentence,
    });
    // A late report, as a callback after the sink would send it: it must not replace the
    // sentence with another account of the failure.
    yield* integ(backendUrl, (c) =>
      c.SyncFailed({
        shop: OTHER_SHOP,
        workflowId: "wf_late",
        message: "Error: OrdersSyncWorkflowError: something else",
      }),
    );
    assert.strictEqual((yield* syncStatus(backendUrl, OTHER_SHOP)).lastError, sentence);
  }),
  SYNC_TIMEOUT,
);

test(
  "a step that dies still reaches the error sink, which re-enables the button",
  timed(
    "a dying poll",
    Effect.gen(function* () {
      const { backendUrl } = yield* stack;
      yield* script(backendUrl, [
        submitted(anOperation({ status: "RUNNING" })),
        // The operation disappeared: the poll step dies, and is not retried.
        polled(null),
      ]);
      assert.strictEqual(yield* syncOpenOrders(backendUrl, OTHER_SHOP), "Started");
      assert.deepStrictEqual(yield* settled(backendUrl, OTHER_SHOP), {
        inFlight: false,
        lastError: "Step failed: poll-bulk-orders",
      });
      assert.deepStrictEqual(yield* shopifyRoutes(backendUrl), ["graphql", "graphql"]);
    }),
  ),
  SYNC_TIMEOUT,
);

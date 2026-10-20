import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ORDERS_KEY, SYNC_KEY } from "../../../../src/contract/shop-actor.ts";
import { orderSyncQuery, orderSyncVariables } from "../../../../src/backend/order-sync.ts";
import { makeOrders } from "../../../../src/backend/shop-actor/orders.ts";
import { ReauthorizationRequired } from "../../../../src/backend/shopify.ts";
import { ShopifyAdmin, type ShopifyAdminError } from "../../../../src/backend/shopify-admin.ts";
import { ShopLimits } from "../../../../src/domain/platform.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";
import recorded from "../fixtures/order-sync-response.json";
import {
  ActorSqliteTest,
  type AdminCall,
  noReconciler,
  noRunTeams,
  QuietLogs,
  testOrdersSyncWorkflows,
  testShopifyAdmin,
} from "../layers.ts";
import { syncTransaction } from "../../../../src/backend/shop-actor/transaction.ts";
import {
  makeOrderRepository,
  type OrderRepository,
} from "../../../../src/backend/shop-actor/order-repository.ts";
import type { OrdersSyncParams } from "../../../../src/backend/orders-sync-workflow.ts";

/**
 * The actor's one-order fetch over a fresh in-memory SQLite migrated by the actor's own schema
 * and a scripted `ShopifyAdmin`: the webhook's probe, ceiling and fetch, and Sync from Shopify.
 */

/** The order the recorded `OrderSync` answer is for, and its version. */
const ORDER_GID = "gid://shopify/Order/6123456789012";
const ORDER_UPDATED_AT = Date.parse("2026-10-15T09:30:45Z");

/**
 * `body` with an `Orders` for {@link SEED_SHOP} over a fresh database and `replies`, the
 * Admin calls and the notices recorded.
 */
const withOrders = <A, E>(
  replies: Array<Effect.Effect<unknown, ShopifyAdminError>>,
  body: (
    orders: ReturnType<typeof makeOrders<never>>,
    recorded: {
      readonly admin: Array<AdminCall>;
      readonly created: Array<{ readonly id: string; readonly params: OrdersSyncParams }>;
      readonly notices: Array<ReadonlyArray<string>>;
      readonly repository: OrderRepository;
      readonly sql: SqlClient.SqlClient;
      /** How many times `flushUsage`, the billing seam, ran. */
      readonly flushes: { count: number };
    },
  ) => Effect.Effect<A, E>,
  create: Effect.Effect<void> = Effect.void,
) => {
  const admin: Array<AdminCall> = [];
  const created: Array<{ readonly id: string; readonly params: OrdersSyncParams }> = [];
  const notices: Array<ReadonlyArray<string>> = [];
  const flushes = { count: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = syncTransaction(sql);
    const repository = makeOrderRepository(sql, transaction);
    const orders = makeOrders({
      repository,
      transaction,
      admin: yield* ShopifyAdmin,
      ordersSync: testOrdersSyncWorkflows(created, create),
      notify: (invalidated) =>
        Effect.sync(() => {
          notices.push(invalidated);
        }),
      notifyRuns: () =>
        Effect.sync(() => {
          notices.push([ORDERS_KEY]);
        }),
      teamsOfOrder: noRunTeams,
      reconciler: noReconciler,
      flushUsage: Effect.sync(() => {
        flushes.count += 1;
      }),
      shop: SEED_SHOP,
    });
    return yield* body(orders, { admin, created, notices, repository, sql, flushes });
  }).pipe(
    Effect.provide(testShopifyAdmin(replies, admin)),
    Effect.provide(ActorSqliteTest),
    Effect.provide(QuietLogs),
  );
};

/** Fills the order ceiling with open orders straight to SQL; ids never collide with a test's. */
const fillCeiling = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      for (let i = 1; i <= ShopLimits.maxOpenOrders; i++)
        yield* sql`
          insert into ShopOrder (id, legacyId, name, processedAt, updatedAt, cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
          values (${`gid://shopify/Order/open-${String(i)}`}, ${`open-${String(i)}`}, ${`#open-${String(i)}`}, 0, 0, null, 'UNFULFILLED', 1, null, 0)
        `;
    }),
  );

const ordersLimitedAt = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly ordersLimitedAt: number | null;
  }>`select ordersLimitedAt from ShopUsage where id = 1`.pipe(
    Effect.map(([row]) => row?.ordersLimitedAt ?? null),
  );

const reauthorization = new ReauthorizationRequired({
  shop: SEED_SHOP,
  reason: "refresh-token-rejected",
  refreshTokenExpiresAt: null,
});

describe("Orders.syncOrderWebhook", () => {
  it.effect("fetches the order it names and stores it with its line items, and notifies", () =>
    withOrders([Effect.succeed(recorded.data)], (orders, { admin, notices, repository }) =>
      Effect.gen(function* () {
        const status = yield* orders.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_PAID",
          updatedAt: ORDER_UPDATED_AT,
        });
        assert.strictEqual(status, "stored");
        assert.deepStrictEqual(admin, [
          { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
        ]);
        const stored = Option.getOrNull(yield* repository.getOrder(ORDER_GID));
        assert.strictEqual(stored?.order.name, "#1042");
        assert.deepStrictEqual(
          stored?.lineItems.map(({ id }) => id),
          ["gid://shopify/LineItem/15234567890123", "gid://shopify/LineItem/15234567890124"],
        );
        assert.deepStrictEqual(notices, [[ORDERS_KEY]]);
      }),
    ),
  );

  it.effect("a stale version skips the fetch and notifies nothing", () =>
    withOrders([Effect.succeed(recorded.data)], (orders, { admin, notices }) =>
      Effect.gen(function* () {
        yield* orders.syncOrder({ orderId: ORDER_GID });
        admin.length = 0;
        notices.length = 0;
        for (const updatedAt of [ORDER_UPDATED_AT - 1, ORDER_UPDATED_AT])
          assert.strictEqual(
            yield* orders.syncOrderWebhook({ orderId: ORDER_GID, topic: "ORDERS_PAID", updatedAt }),
            "stale",
          );
        assert.deepStrictEqual(admin, []);
        assert.deepStrictEqual(notices, []);
      }),
    ),
  );

  it.effect("a new order at the ceiling marks ordersLimitedAt and skips the fetch", () =>
    withOrders([], (orders, { admin, notices, sql, repository }) =>
      Effect.gen(function* () {
        yield* fillCeiling(sql);
        const status = yield* orders.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_CREATE",
          updatedAt: ORDER_UPDATED_AT,
        });
        assert.strictEqual(status, "refused");
        assert.deepStrictEqual(admin, []);
        assert.isNotNull(yield* ordersLimitedAt(sql));
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
        assert.deepStrictEqual(notices, []);
      }),
    ),
  );

  it.effect("an order Shopify answers null for is gone and stores nothing", () =>
    withOrders([Effect.succeed({ order: null })], (orders, { admin, notices, repository }) =>
      Effect.gen(function* () {
        const status = yield* orders.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_CANCELLED",
          updatedAt: null,
        });
        assert.strictEqual(status, "gone");
        assert.lengthOf(admin, 1);
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
        assert.deepStrictEqual(notices, []);
      }),
    ),
  );

  it.effect("an EnsureShopSessionError fails the delivery and stores nothing", () =>
    withOrders([Effect.fail(reauthorization)], (orders, { repository }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          orders.syncOrderWebhook({ orderId: ORDER_GID, topic: "ORDERS_CREATE", updatedAt: null }),
        );
        assert.strictEqual(error._tag, "ReauthorizationRequired");
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );
});

describe("Orders.syncOrder", () => {
  it.effect("the one-order sync fetches the order and stores it, with no version probe", () =>
    withOrders(
      [Effect.succeed(recorded.data), Effect.succeed(recorded.data)],
      (orders, { admin, repository }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* orders.syncOrder({ orderId: ORDER_GID }), {
            _tag: "Stored",
          });
          // The same version again still asks Shopify: there is no probe.
          assert.deepStrictEqual(yield* orders.syncOrder({ orderId: ORDER_GID }), {
            _tag: "Stored",
          });
          assert.deepStrictEqual(admin, [
            { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
            { shop: SEED_SHOP, query: orderSyncQuery, variables: orderSyncVariables(ORDER_GID) },
          ]);
          assert.lengthOf(
            Option.getOrNull(yield* repository.getOrder(ORDER_GID))?.lineItems ?? [],
            2,
          );
        }),
    ),
  );

  it.effect("an order Shopify no longer has answers Gone and stores nothing", () =>
    withOrders([Effect.succeed({ order: null })], (orders, { admin, repository }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* orders.syncOrder({ orderId: ORDER_GID }), { _tag: "Gone" });
        assert.lengthOf(admin, 1);
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );

  /** Legacy's answer knew only gone or not: the ceiling is the banner's to show. */
  it.effect("a new order refused at the ceiling answers Stored", () =>
    withOrders([Effect.succeed(recorded.data)], (orders, { sql, repository }) =>
      Effect.gen(function* () {
        yield* fillCeiling(sql);
        assert.deepStrictEqual(yield* orders.syncOrder({ orderId: ORDER_GID }), {
          _tag: "Stored",
        });
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );

  it.effect("an EnsureShopSessionError fails the sync and stores nothing", () =>
    withOrders([Effect.fail(reauthorization)], (orders, { repository }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(orders.syncOrder({ orderId: ORDER_GID }));
        assert.strictEqual(error._tag, "ReauthorizationRequired");
        assert.isTrue(Option.isNone(yield* repository.getOrder(ORDER_GID)));
      }),
    ),
  );
});

/**
 * The billing seam's call sites, legacy's: the webhook sends the usage queue after its fetch
 * path only, and Sync from Shopify sends it whatever became of the fetch (rule 13 on
 * `syncOrder`). The actor's `flushUsage` is `makeBilling`'s flush; here it is counted.
 */
describe("Orders usage flush", () => {
  it.effect("the webhook flushes after its fetch path, never on a stale or refused delivery", () =>
    withOrders([Effect.succeed(recorded.data)], (orders, { flushes, sql }) =>
      Effect.gen(function* () {
        yield* orders.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_PAID",
          updatedAt: ORDER_UPDATED_AT,
        });
        assert.strictEqual(flushes.count, 1);
        yield* orders.syncOrderWebhook({
          orderId: ORDER_GID,
          topic: "ORDERS_PAID",
          updatedAt: ORDER_UPDATED_AT,
        });
        assert.strictEqual(flushes.count, 1, "stale");
        yield* fillCeiling(sql);
        yield* orders.syncOrderWebhook({
          orderId: "gid://shopify/Order/1",
          topic: "ORDERS_CREATE",
          updatedAt: ORDER_UPDATED_AT,
        });
        assert.strictEqual(flushes.count, 1, "refused");
      }),
    ),
  );

  it.effect("Sync from Shopify flushes even when the fetch fails", () =>
    withOrders(
      [Effect.succeed(recorded.data), Effect.fail(reauthorization)],
      (orders, { flushes }) =>
        Effect.gen(function* () {
          yield* orders.syncOrder({ orderId: ORDER_GID });
          assert.strictEqual(flushes.count, 1);
          yield* Effect.flip(orders.syncOrder({ orderId: ORDER_GID }));
          assert.strictEqual(flushes.count, 2);
        }),
    ),
  );
});

describe("Orders.syncOpenOrders", () => {
  it.effect("records the sync on the actor before it creates the instance of the same id", () =>
    withOrders([], (orders, { created, notices, repository }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* orders.syncOpenOrders(), { _tag: "Started" });
        const tracking = yield* repository.getSyncTracking();
        assert.isNotNull(tracking.workflowId);
        assert.deepStrictEqual(created, [
          { id: tracking.workflowId ?? "", params: { shop: SEED_SHOP } },
        ]);
        assert.deepStrictEqual(notices, [[SYNC_KEY]]);
      }),
    ),
  );

  it.effect("a InFlight answer creates no instance", () =>
    withOrders([], (orders, { created, notices }) =>
      Effect.gen(function* () {
        yield* orders.syncOpenOrders();
        assert.deepStrictEqual(yield* orders.syncOpenOrders(), { _tag: "InFlight" });
        assert.lengthOf(created, 1);
        assert.deepStrictEqual(notices, [[SYNC_KEY]]);
      }),
    ),
  );

  it.effect("a Refused answer creates no instance", () =>
    withOrders([], (orders, { created, sql }) =>
      Effect.gen(function* () {
        yield* fillCeiling(sql);
        assert.deepStrictEqual(yield* orders.syncOpenOrders(), { _tag: "Refused" });
        assert.lengthOf(created, 0);
        assert.isNotNull(yield* ordersLimitedAt(sql));
      }),
    ),
  );

  it.effect("a create that fails ends the recorded sync with its message, and fails on", () =>
    withOrders(
      [],
      (orders, { created, notices, repository }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(orders.syncOpenOrders());
          assert.strictEqual(error._tag, "ShopifyUnavailable");
          assert.lengthOf(created, 1);
          assert.deepStrictEqual(yield* repository.getSyncStatus(0), {
            inFlight: false,
            lastError: "workflow.create failed",
          });
          assert.deepStrictEqual(notices, [[SYNC_KEY], [SYNC_KEY]]);
        }),
      Effect.die(new Error("workflow.create failed")),
    ),
  );
});

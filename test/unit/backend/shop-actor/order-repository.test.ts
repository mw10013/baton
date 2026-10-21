import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { fixture } from "../../../../fixture.ts";
import { fixtureRows } from "../../../../src/backend/fixture.ts";
import { insertFixtureRows } from "../../../../src/backend/shop-actor.ts";
import {
  GATHER_ALL,
  GATHER_MARKED,
  makeOrderFactStore,
  makeOrderFacts,
} from "../../../../src/backend/shop-actor/order-facts.ts";
import {
  ITEM_MATCHES,
  openOrdersAtCeiling,
  type OrderRepository,
} from "../../../../src/backend/shop-actor/order-repository.ts";
import { type OrderLineItem, orderIsOpen, type ShopOrder } from "../../../../src/domain/orders.ts";
import { ShopGid, ShopKey, ShopLimits } from "../../../../src/domain/platform.ts";
import { USAGE_METER_MEMBER, USAGE_METER_ORDER } from "../../../../src/domain/billing.ts";
import {
  ShopifyAppEvents,
  ShopifyAppEventsError,
} from "../../../../src/backend/shopify-app-events.ts";
import { syncTransaction } from "../../../../src/backend/shop-actor/transaction.ts";
import {
  makeUsageRepository,
  type UsageRepository,
} from "../../../../src/backend/shop-actor/usage-repository.ts";
import {
  ListSearch,
  multiMatchItems,
  type OrderCounts,
  OrderPosition,
  OrdersCursor,
  type OrdersPage,
  type OrdersShow,
  orderIssues,
  orderPosition,
  type RunState,
  TeamId,
  TeamWithMemberCount,
  WorkflowDetail,
  type WorkflowState,
} from "../../../../src/domain/shop-work.ts";
import { ActorSqliteTest, testOrderRepository } from "../layers.ts";

/**
 * The actor's orders repository over a fresh in-memory SQLite migrated by the actor's own
 * schema: legacy `order-repository.test.ts`'s cases, titles and describe names unchanged.
 */

/** `body` with the repository and its client, on a fresh database. */
const runInRepository = <A, E>(
  body: (
    repository: OrderRepository,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* testOrderRepository, yield* SqlClient.SqlClient);
  }).pipe(Effect.provide(ActorSqliteTest));

const orderId = (n: number) => `gid://shopify/Order/${String(n)}`;
const SHOP = Schema.decodeUnknownSync(ShopKey)("orders.myshopify.com");
const lineItemId = (n: number) => `gid://shopify/LineItem/${String(n)}`;

const anOrder = (overrides: Partial<ShopOrder> = {}): ShopOrder => ({
  id: orderId(1),
  legacyId: "1",
  name: "#1001",
  processedAt: 1000,
  updatedAt: 1000,
  cancelledAt: null,
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: false,
  note: null,
  syncedAt: 1000,
  ...overrides,
});

const aLineItem = (n: number, overrides: Partial<OrderLineItem> = {}): OrderLineItem => ({
  id: lineItemId(n),
  orderId: orderId(1),
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: `SKU-${String(n)}`,
  quantity: 1,
  currentQuantity: 1,
  productTags: ["engraved"],
  properties: [{ key: "text", value: "Hello" }],
  ...overrides,
});

const upsert = (
  repository: OrderRepository,
  order: ShopOrder,
  lineItems: readonly OrderLineItem[],
) => repository.upsertOrder({ order, lineItems });

/** A table's ids in id order, read straight from SQL. */
const ids = (sql: SqlClient.SqlClient, table: string) =>
  sql`select id from ${sql(table)} order by id`.values.pipe(
    Effect.map((rows) => rows.map((row) => String(row[0]))),
  );

/**
 * The `ShopUsage` columns the orders write, and the open-order count, read straight from SQL:
 * the ceiling's cases read the order repository alone, not the meter's `getUsage`.
 */
const usage = (repository: OrderRepository, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{
      readonly ordersLimitedAt: number | null;
      readonly lastSweepAt: number | null;
    }>`select ordersLimitedAt, lastSweepAt from ShopUsage where id = 1`;
    return { ...row, openOrders: yield* repository.countOpenOrders() };
  });

/** Sets `countedAt` where it is null, as the billing meter's first run would (`countOrder`). */
const countOrder = (sql: SqlClient.SqlClient, id: string, at: number) =>
  sql`update ShopOrder set countedAt = ${at} where id = ${id} and countedAt is null`;

/**
 * Stores `n` open orders (unfulfilled, not cancelled, no items) straight to SQL: the ceiling
 * counts rows. Ids are `gid://shopify/Order/open-<i>`, so they never collide with a test's own.
 */
const storeOpenOrders = (sql: SqlClient.SqlClient, n: number, at: number) =>
  sql.withTransaction(
    Effect.gen(function* () {
      for (let i = 1; i <= n; i++)
        yield* sql`
          insert into ShopOrder (id, legacyId, name, processedAt, updatedAt, cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
          values (${`gid://shopify/Order/open-${String(i)}`}, ${`open-${String(i)}`}, ${`#open-${String(i)}`}, ${at}, ${at}, null, 'UNFULFILLED', 1, null, ${at})
        `;
    }),
  );

describe("OrderRepository.upsertOrder", () => {
  it.effect("stores an order with its items", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        const { order, lineItems } = Option.getOrThrow(yield* repository.getOrder(orderId(1)));
        assert.strictEqual(order.name, "#1001");
        assert.strictEqual(order.fullyPaid, false);
        assert.strictEqual(lineItems.length, 2);
        assert.strictEqual(lineItems[0]?.productTags[0], "engraved");
      }),
    ),
  );

  /**
   * The guard that lets a retried webhook, a mid-stream bulk line, and a one-order
   * sync all write the same row in any order.
   */
  it.effect("leaves the row and its items alone for an older updatedAt", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder({ updatedAt: 2000 }), [aLineItem(1)]);
        const stale = yield* upsert(repository, anOrder({ updatedAt: 1000, name: "#STALE" }), [
          aLineItem(9),
        ]);
        assert.strictEqual(stale.written, false);
        const { order, lineItems } = Option.getOrThrow(yield* repository.getOrder(orderId(1)));
        assert.strictEqual(order.name, "#1001");
        assert.strictEqual(lineItems.length, 1);
        assert.strictEqual(lineItems[0]?.id, lineItemId(1));
      }),
    ),
  );

  it.effect("replaces the line-item set on every accepted write", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        yield* upsert(repository, anOrder({ updatedAt: 3000 }), [aLineItem(2)]);
        const { lineItems } = Option.getOrThrow(yield* repository.getOrder(orderId(1)));
        assert.strictEqual(lineItems.length, 1);
        assert.strictEqual(lineItems[0]?.id, lineItemId(2));
      }),
    ),
  );

  /**
   * The guard is `>=`, not `>`: both timestamps are Shopify's own version of
   * the order, so an equal one is the same version and rewriting it is free.
   * Refusing a tie would instead drop a redelivery of a write that failed
   * halfway through its items.
   */
  it.effect("accepts an equal updatedAt and rewrites the row", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder({ updatedAt: 2000 }), [aLineItem(1)]);
        const again = yield* upsert(repository, anOrder({ updatedAt: 2000, note: "Tie" }), [
          aLineItem(2),
        ]);
        assert.strictEqual(again.written, true);
        const { order, lineItems } = Option.getOrThrow(yield* repository.getOrder(orderId(1)));
        assert.strictEqual(order.note, "Tie");
        assert.strictEqual(lineItems.length, 1);
        assert.strictEqual(lineItems[0]?.id, lineItemId(2));
      }),
    ),
  );

  it.effect(
    "upsertOrder reports changed for a fresh row and a newer updatedAt, and not for the same version",
    () =>
      runInRepository((repository) =>
        Effect.gen(function* () {
          const fresh = yield* upsert(repository, anOrder({ updatedAt: 2000 }), [aLineItem(1)]);
          const same = yield* upsert(repository, anOrder({ updatedAt: 2000, syncedAt: 9000 }), [
            aLineItem(1),
          ]);
          const newer = yield* upsert(repository, anOrder({ updatedAt: 3000 }), [aLineItem(1)]);
          const stale = yield* upsert(repository, anOrder({ updatedAt: 1000 }), [aLineItem(1)]);
          assert.deepStrictEqual(
            [fresh, same, newer, stale].map((r) => [r.written, r.changed]),
            [
              [true, true],
              [true, false],
              [true, true],
              [false, false],
            ],
          );
        }),
      ),
  );
});

describe("OrderRepository.upsertOrder columns", () => {
  it.effect(
    "a sync rewrites every column but countedAt and the insert-only legacyId and name",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          const changed = anOrder({
            legacyId: "2",
            name: "#2002",
            processedAt: 1500,
            updatedAt: 2000,
            cancelledAt: 1800,
            fulfillmentStatus: "PARTIALLY_FULFILLED",
            fullyPaid: true,
            note: "Rush",
            syncedAt: 3000,
          });
          yield* upsert(repository, anOrder(), [aLineItem(1)]);
          yield* countOrder(sql, orderId(1), 1200);
          yield* upsert(repository, changed, [aLineItem(1)]);
          const [stored] = yield* sql`select * from ShopOrder where id = ${orderId(1)}`;
          assert.deepStrictEqual(stored, {
            id: changed.id,
            legacyId: anOrder().legacyId,
            name: anOrder().name,
            processedAt: changed.processedAt,
            updatedAt: changed.updatedAt,
            cancelledAt: changed.cancelledAt,
            fulfillmentStatus: changed.fulfillmentStatus,
            fullyPaid: 1,
            note: changed.note,
            syncedAt: changed.syncedAt,
            countedAt: 1200,
          });
        }),
      ),
  );
});

/**
 * The rows `LoadFixture` and `AddToFixture` write are the repository's rows: the dev fixture,
 * written by the actor's own inserts, decodes through the same `ShopOrder` and `OrderLineItem`
 * schemas a sync stores, and the fixture's `countedAt` of 0 survives a sync.
 */
describe("fixture rows", () => {
  it.effect("the dev fixture's rows decode through the repository and keep countedAt 0", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        let next = 0;
        const { actor } = fixtureRows(fixture, CYCLE_START, () => `id-${String(++next)}`);
        yield* insertFixtureRows(sql, actor);
        const page = yield* repository.listOrders({
          limit: actor.orders.length,
          cursor: null,
          q: null,
          show: "all",
          team: null,
          teams: [],
        });
        const listed = page.orders.map(({ order }) => order);
        assert.strictEqual(listed.length, actor.orders.length);
        assert.strictEqual(page.nextCursor, null);
        const details = yield* Effect.forEach(listed, ({ id }) => repository.getOrder(id));
        assert.strictEqual(
          details.flatMap((detail) => Option.getOrThrow(detail).lineItems).length,
          actor.lineItems.length,
        );
        // Stored as placed: a fixture order's cancel is work the actor applies later.
        assert.isTrue(listed.every(({ cancelledAt }) => cancelledAt === null));
        assert.isTrue(actor.work.some(({ after }) => after?.cancelled === true));
        assert.isTrue(listed.some(({ fullyPaid }) => !fullyPaid));

        const newest = Option.getOrThrow(details[0] ?? Option.none());
        const synced = yield* upsert(
          repository,
          { ...newest.order, updatedAt: newest.order.updatedAt + 1 },
          newest.lineItems,
        );
        assert.deepStrictEqual([synced.written, synced.fresh, synced.changed], [true, false, true]);
        const counted = yield* sql`select distinct countedAt from ShopOrder`.values;
        assert.deepStrictEqual(counted, [[0]]);
      }),
    ),
  );
});

/** Mid-month, so `processedAt: CYCLE_START - 1` is unambiguously the cycle before. */
const CYCLE_START = Date.UTC(2026, 5, 15);
const CYCLE_END = Date.UTC(2026, 6, 15);

const paid = (n: number, overrides: Partial<ShopOrder> = {}) =>
  anOrder({
    id: orderId(n),
    legacyId: String(n),
    name: `#${String(1000 + n)}`,
    fullyPaid: true,
    processedAt: CYCLE_START,
    updatedAt: CYCLE_START,
    syncedAt: CYCLE_START,
    ...overrides,
  });

describe("openOrdersAtCeiling", () => {
  it("the shop is at its order ceiling when the open orders have reached maxOpenOrders", () => {
    const { maxOpenOrders } = ShopLimits;
    assert.strictEqual(openOrdersAtCeiling(maxOpenOrders - 1), false);
    assert.strictEqual(openOrdersAtCeiling(maxOpenOrders), true);
    assert.strictEqual(openOrdersAtCeiling(maxOpenOrders + 1), true);
  });
});

describe("OrderRepository usage", () => {
  /**
   * Legacy lowered `ShopLimits.maxOpenOrders` to 2 for this case; here the ceiling keeps its value
   * and all but two of it are stored as open orders first, so the case's own two orders reach it.
   * Legacy's `ordersThisCycle` assert is left out: this case never counts, and the meter's own
   * cases below pin that storing an order is not counting it.
   */
  it.effect(
    "the ceiling counts open orders, not counted ones: a new order is refused at it, a stored one still updates, and a closed order makes no claim on it",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          yield* storeOpenOrders(sql, ShopLimits.maxOpenOrders - 2, CYCLE_START);
          // Stored, uncounted: the ceiling reads open rows, so no run is
          // needed to approach it, unlike the meter.
          yield* upsert(repository, paid(1), []);
          yield* upsert(repository, paid(2), []);
          const refused = yield* upsert(repository, paid(3), []);
          const limited = yield* usage(repository, sql);
          const update = yield* upsert(
            repository,
            paid(1, { updatedAt: CYCLE_START + 1, note: "still flows" }),
            [],
          );
          yield* upsert(
            repository,
            paid(2, { updatedAt: CYCLE_START + 1, fulfillmentStatus: "FULFILLED" }),
            [],
          );
          const retried = yield* upsert(repository, paid(3), []);
          const after = yield* usage(repository, sql);
          const none = Option.none();
          assert.deepStrictEqual(refused, {
            written: false,
            fresh: false,
            changed: false,
            refused: true,
            afterWrite: none,
          });
          assert.strictEqual(limited.openOrders, ShopLimits.maxOpenOrders);
          assert.strictEqual(limited.ordersLimitedAt !== null, true);
          assert.deepStrictEqual(update, {
            written: true,
            fresh: false,
            changed: true,
            refused: false,
            afterWrite: none,
          });
          assert.deepStrictEqual(retried, {
            written: true,
            fresh: true,
            changed: true,
            refused: false,
            afterWrite: none,
          });
          assert.strictEqual(after.openOrders, ShopLimits.maxOpenOrders);
          // The flag outlives the stored third: only Sync open orders clears it
          // (`clearOrdersLimited`).
          assert.strictEqual(after.ordersLimitedAt !== null, true);
        }),
      ),
  );

  const shopGid = Schema.decodeUnknownSync(ShopGid)("gid://shopify/Shop/1");

  /** `body` with the order repository, the meter over the same database, and the client. */
  const runInMeter = <A, E>(
    body: (
      repository: OrderRepository,
      meter: UsageRepository,
      sql: SqlClient.SqlClient,
    ) => Effect.Effect<A, E, SqlClient.SqlClient>,
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* body(
        yield* testOrderRepository,
        makeUsageRepository(sql, syncTransaction(sql)),
        sql,
      );
    }).pipe(Effect.provide(ActorSqliteTest));

  const openCycle = (meter: UsageRepository) =>
    meter.setBillingCycle({
      shopGid,
      cycleStartAt: CYCLE_START,
      cycleEndAt: CYCLE_END,
      memberCount: 0,
    });

  /**
   * What `makeRunRepository`'s `insertRun` does after it creates the order's
   * first run. Called directly here so the meter is tested as the rule it is,
   * rather than through a reconcile that would have to be staged first;
   * `run-repository.test.ts` owns the other half — that a run is what
   * fires it, and that a second run does not.
   */
  const count = (meter: UsageRepository, n: number, now = CYCLE_START) =>
    meter.countOrder(orderId(n), now);

  const usageEvents = (sql: SqlClient.SqlClient) =>
    sql`select idempotencyKey, value from UsageEvent order by rowid`.values.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          idempotencyKey: String(row[0]),
          value: Number(row[1]),
        })),
      ),
    );

  /** The seat rows alone, with their dates: what the seat mark cases assert. */
  const seatEvents = (sql: SqlClient.SqlClient) =>
    sql`
      select idempotencyKey, value, occurredAt from UsageEvent
      where eventHandle = ${USAGE_METER_MEMBER}
      order by rowid
    `.values.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          idempotencyKey: String(row[0]),
          value: Number(row[1]),
          occurredAt: Number(row[2]),
        })),
      ),
    );

  const seatKey = (cycleStartAt: number, mark: number) =>
    `seat#${String(cycleStartAt)}#${String(mark)}`;

  /**
   * Two `ShopifyAppEvents` stubs, because the whole point of the outbox is the
   * difference between them: an accepted event leaves no row, a refused one keeps
   * its row and its error for the next pass.
   */
  const acceptingAppEvents = Layer.succeed(
    ShopifyAppEvents,
    ShopifyAppEvents.of({ send: () => Effect.void }),
  );

  const refusingAppEvents = Layer.succeed(
    ShopifyAppEvents,
    ShopifyAppEvents.of({
      send: () =>
        Effect.fail(
          new ShopifyAppEventsError({
            message: "refused",
            cause: new Error("refused"),
          }),
        ),
    }),
  );

  it.effect("counts an order against the pushed billing cycle", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* openCycle(meter);
        // Five orders stored; two of them reached run creation. Storing an
        // order is not what the merchant is billed for.
        for (const n of [1, 2, 3, 4, 5]) yield* upsert(repository, paid(n), []);
        yield* count(meter, 1);
        yield* count(meter, 2);
        const usage = yield* meter.getUsage();
        assert.strictEqual(usage.ordersThisCycle, 2);
        assert.strictEqual(usage.cycleStartAt, CYCLE_START);
        assert.strictEqual(usage.cycleEndAt, CYCLE_END);
      }),
    ),
  );

  it.effect("opens a provisional cycle before a billing cycle is known", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        const usage = yield* meter.getUsage();
        assert.strictEqual(usage.ordersThisCycle, 1);
        assert.strictEqual(usage.cycleStartAt, Date.UTC(2026, 5, 1));
        assert.strictEqual(usage.cycleEndAt, null);
      }),
    ),
  );

  it.effect("rolls the cycle forward on the first order past its end", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* openCycle(meter);
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        const before = yield* meter.getUsage();
        // The count resolves the cycle before it writes the marker, so the
        // order lands in the period it opened.
        yield* upsert(
          repository,
          paid(2, {
            processedAt: CYCLE_END,
            updatedAt: CYCLE_END,
            syncedAt: CYCLE_END,
          }),
          [],
        );
        yield* count(meter, 2, CYCLE_END);
        const after = yield* meter.getUsage();
        assert.strictEqual(before.ordersThisCycle, 1);
        assert.strictEqual(after.ordersThisCycle, 1);
        assert.strictEqual(after.cycleStartAt, CYCLE_END);
        assert.strictEqual(after.cycleEndAt, null);
      }),
    ),
  );

  it.effect("a manual attach past the cycle end counts into the new cycle", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* openCycle(meter);
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        yield* upsert(repository, paid(2), []);
        // No upsert lands past the end: the count itself rolls the cycle.
        yield* count(meter, 2, CYCLE_END + 1);
        const usage = yield* meter.getUsage();
        assert.strictEqual(usage.ordersThisCycle, 1);
        assert.strictEqual(usage.cycleStartAt, CYCLE_END);
        assert.strictEqual(usage.cycleEndAt, null);
      }),
    ),
  );

  it.effect("recounts the cycle from the orders when a new billing cycle is pushed", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* openCycle(meter);
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(2), []);
        yield* count(meter, 1);
        yield* count(meter, 2);
        // The next cycle: the two above fall outside it and drop out.
        yield* meter.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
          memberCount: 0,
        });
        assert.strictEqual((yield* meter.getUsage()).ordersThisCycle, 0);
      }),
    ),
  );

  it.effect("counting an order queues one usage event", () =>
    runInMeter((repository, meter, sql) =>
      Effect.gen(function* () {
        yield* openCycle(meter);
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        assert.deepStrictEqual(yield* usageEvents(sql), [
          { idempotencyKey: `${orderId(1)}#count`, value: 1 },
        ]);
      }),
    ),
  );

  it.effect("a second sync never queues a second count", () =>
    runInMeter((repository, meter, sql) =>
      Effect.gen(function* () {
        yield* openCycle(meter);
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        yield* upsert(repository, paid(1, { updatedAt: CYCLE_START + 1 }), []);
        yield* count(meter, 1, CYCLE_START + 1);
        assert.strictEqual((yield* meter.getUsage()).ordersThisCycle, 1);
        assert.strictEqual((yield* usageEvents(sql)).length, 1);
      }),
    ),
  );

  it.effect(
    "the first billing cycle discards events queued before the shop could be addressed",
    () =>
      runInMeter((repository, meter, sql) =>
        Effect.gen(function* () {
          // A trial: orders arrive, a provisional cycle counts them, no cycle
          // can be pushed because Shopify reports none, and nothing can be
          // sent because nothing has named the shop.
          yield* upsert(repository, paid(1), []);
          yield* upsert(repository, paid(2), []);
          yield* count(meter, 1);
          yield* count(meter, 2);
          // The trial ends and the first real billing cycle starts after both.
          yield* meter.setBillingCycle({
            shopGid,
            cycleStartAt: CYCLE_START + 10,
            cycleEndAt: CYCLE_END,
            memberCount: 0,
          });
          const usage = yield* meter.getUsage();
          assert.strictEqual(usage.ordersThisCycle, 0);
          assert.strictEqual(usage.pendingUsageEvents, 0);
          assert.deepStrictEqual(yield* usageEvents(sql), []);
        }),
      ),
  );

  it.effect("a usage event is one row per idempotency key, kept until Shopify accepts it", () =>
    runInMeter((repository, meter, sql) =>
      Effect.gen(function* () {
        const key = `${orderId(1)}#count`;
        const keys = () =>
          sql`select idempotencyKey, attempts from UsageEvent`.values.pipe(
            Effect.map((rows) => rows.map(([k, n]) => [String(k), Number(n)])),
          );
        yield* openCycle(meter);
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        const duplicate = yield* sql`
          insert into UsageEvent (idempotencyKey, eventHandle, orderId, value, occurredAt)
          values (${key}, ${USAGE_METER_ORDER}, ${orderId(1)}, 1, ${CYCLE_START})
        `.pipe(
          Effect.as("inserted"),
          Effect.catch(() => Effect.succeed("refused")),
        );
        yield* meter.flushUsageEvents("shop.myshopify.com").pipe(Effect.provide(refusingAppEvents));
        const afterRefusal = yield* keys();
        yield* meter
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(acceptingAppEvents));
        assert.strictEqual(duplicate, "refused");
        assert.deepStrictEqual(afterRefusal, [[key, 1]]);
        assert.deepStrictEqual(yield* keys(), []);
      }),
    ),
  );

  it.effect("flush deletes accepted events and keeps refused ones with the error", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* openCycle(meter);
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        const first = yield* meter
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(refusingAppEvents));
        const second = yield* meter
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(acceptingAppEvents));
        assert.deepStrictEqual(first, { sent: 0, remaining: 1 });
        assert.deepStrictEqual(second, { sent: 1, remaining: 0 });
      }),
    ),
  );

  it.effect("leaves events queued until a billing cycle names the shop", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        const flush = yield* meter
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(acceptingAppEvents));
        assert.deepStrictEqual(flush, { sent: 0, remaining: 1 });
      }),
    ),
  );

  const openCycleWithMemberCount = (meter: UsageRepository, memberCount: number) =>
    meter.setBillingCycle({
      shopGid,
      cycleStartAt: CYCLE_START,
      cycleEndAt: CYCLE_END,
      memberCount,
    });

  /**
   * A removal is never reported to the actor, so what these pin is the
   * consequence: removing and re-adding inside a cycle bills the seat once,
   * and a revalidation that reads the smaller member count lowers nothing.
   */
  it.effect(
    "a new cycle resets the mark to the member count and queues it as the cycle's first seat event",
    () =>
      runInMeter((_, meter, sql) =>
        Effect.gen(function* () {
          yield* openCycleWithMemberCount(meter, 3);
          yield* openCycleWithMemberCount(meter, 5);
          yield* meter.setBillingCycle({
            shopGid,
            cycleStartAt: CYCLE_END,
            cycleEndAt: null,
            memberCount: 4,
          });
          assert.strictEqual((yield* meter.getUsage()).seatsThisCycle, 4);
          assert.deepStrictEqual((yield* seatEvents(sql)).at(-1), {
            idempotencyKey: seatKey(CYCLE_END, 4),
            value: 4,
            occurredAt: CYCLE_END,
          });
        }),
      ),
  );

  it.effect("an unchanged cycle leaves the mark and queues nothing", () =>
    runInMeter((_, meter, sql) =>
      Effect.gen(function* () {
        yield* openCycleWithMemberCount(meter, 3);
        yield* openCycleWithMemberCount(meter, 3);
        assert.strictEqual((yield* meter.getUsage()).seatsThisCycle, 3);
        assert.strictEqual((yield* seatEvents(sql)).length, 1);
      }),
    ),
  );

  it.effect("a revalidation raises the mark to a member count past it and sends the rise", () =>
    runInMeter((_, meter, sql) =>
      Effect.gen(function* () {
        yield* openCycleWithMemberCount(meter, 3);
        yield* openCycleWithMemberCount(meter, 5);
        assert.strictEqual((yield* meter.getUsage()).seatsThisCycle, 5);
        assert.deepStrictEqual(
          (yield* seatEvents(sql)).map(({ idempotencyKey, value }) => ({ idempotencyKey, value })),
          [
            { idempotencyKey: seatKey(CYCLE_START, 3), value: 3 },
            { idempotencyKey: seatKey(CYCLE_START, 5), value: 2 },
          ],
        );
      }),
    ),
  );

  /**
   * The counting path rolls a cycle past its end without the Backend, and the
   * revalidation that follows pushes that same start: an unchanged cycle to
   * `setBillingCycle`. The rolled cycle must still get its whole member count sent.
   */
  it.effect(
    "a cycle the counting path rolled forward starts with no seat mark, and the next revalidation sends the whole count",
    () =>
      runInMeter((repository, meter, sql) =>
        Effect.gen(function* () {
          yield* openCycleWithMemberCount(meter, 3);
          // An order past the cycle end rolls the cycle forward on its own.
          yield* upsert(repository, paid(1), []);
          yield* count(meter, 1, CYCLE_END + 1);
          const mark = (yield* meter.getUsage()).seatsThisCycle;
          yield* meter.setBillingCycle({
            shopGid,
            cycleStartAt: CYCLE_END,
            cycleEndAt: null,
            memberCount: 3,
          });
          assert.strictEqual(mark, 0);
          assert.deepStrictEqual(
            (yield* seatEvents(sql)).map(({ idempotencyKey, value }) => ({
              idempotencyKey,
              value,
            })),
            [
              { idempotencyKey: seatKey(CYCLE_START, 3), value: 3 },
              { idempotencyKey: seatKey(CYCLE_END, 3), value: 3 },
            ],
          );
        }),
      ),
  );

  it.effect("the flush sends each event under its own meter handle", () =>
    runInMeter((repository, meter) =>
      Effect.gen(function* () {
        yield* openCycleWithMemberCount(meter, 2);
        yield* upsert(repository, paid(1), []);
        yield* count(meter, 1);
        const sent: { eventHandle: string; value: number }[] = [];
        yield* meter.flushUsageEvents("shop.myshopify.com").pipe(
          Effect.provide(
            Layer.succeed(
              ShopifyAppEvents,
              ShopifyAppEvents.of({
                send: ({ eventHandle, value }) =>
                  Effect.sync(() => {
                    sent.push({ eventHandle, value });
                  }),
              }),
            ),
          ),
        );
        assert.deepStrictEqual(sent, [
          { eventHandle: USAGE_METER_MEMBER, value: 2 },
          { eventHandle: USAGE_METER_ORDER, value: 1 },
        ]);
      }),
    ),
  );

  it.effect("reports whether the upsert created the row", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        const created = yield* upsert(repository, anOrder(), []);
        const updated = yield* upsert(repository, anOrder({ updatedAt: 2000 }), []);
        assert.strictEqual(created.fresh, true);
        assert.strictEqual(updated.fresh, false);
      }),
    ),
  );
});

const NOW = 400 * 86_400_000;
/** Past the window by a day; `processedAt` is what the sweep reads. */
const EXPIRED = NOW - (ShopLimits.orderRetentionDays + 1) * 86_400_000;
/** Inside it by a day, whatever else is true of the order. */
const KEPT = NOW - (ShopLimits.orderRetentionDays - 1) * 86_400_000;

/** A run written straight to SQL: these tests care about the sweep, not how the run got there. */
const runWith = (id: string, state: string, updatedAt: number) => (sql: SqlClient.SqlClient) =>
  sql`
    insert into Run (
      id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
      lineItemId, lineItemTitle, variantTitle, sku, quantity,
      lineItemProperties, state, currentStep, stepCount, createdAt, updatedAt
    ) values (
      ${`run-${id}-${state}`}, 'wf', 'Workflow', ${id}, '#1',
      0, ${`li-${id}`}, 'Item', null, null, 1, '[]',
      ${state}, ${state === "open" ? 1 : null}, 1, ${updatedAt}, ${updatedAt}
    )
  `;

describe("OrderRepository.sweepExpiredOrders", () => {
  it.effect("deletes any order older than 365 days, open or closed, with its runs", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        // Expired and open, with someone still working on it: goes anyway,
        // and the run goes with it. A year is long past "someone is on it".
        yield* upsert(
          repository,
          anOrder({ id: orderId(1), name: "#1001", processedAt: EXPIRED }),
          [],
        );
        yield* runWith(orderId(1), "open", EXPIRED)(sql);
        // Expired, closed, with an unstarted run: goes.
        yield* upsert(
          repository,
          anOrder({
            id: orderId(2),
            name: "#1002",
            processedAt: EXPIRED,
            fulfillmentStatus: "FULFILLED",
          }),
          [],
        );
        yield* runWith(orderId(2), "open", EXPIRED)(sql);
        // Closed, but inside the window: stays. Closing an order is not what
        // ages it out.
        yield* upsert(
          repository,
          anOrder({ id: orderId(3), name: "#1003", processedAt: KEPT, cancelledAt: KEPT }),
          [],
        );
        // Placed inside the window and edited long ago is impossible; placed
        // inside it and edited yesterday is the ordinary case: stays.
        yield* upsert(
          repository,
          anOrder({ id: orderId(4), name: "#1004", processedAt: KEPT, updatedAt: NOW }),
          [],
        );
        const swept = yield* repository.sweepExpiredOrders({ now: NOW });
        assert.deepStrictEqual(swept, { orders: 2, runs: 2 });
        assert.deepStrictEqual(yield* ids(sql, "ShopOrder"), [orderId(3), orderId(4)]);
        assert.deepStrictEqual(yield* ids(sql, "Run"), []);
        assert.strictEqual((yield* usage(repository, sql)).lastSweepAt, NOW);
        assert.strictEqual(yield* repository.lastSweepAt(), NOW);
      }),
    ),
  );
});

describe("OrderRepository.sweepExpiredOrders, the retention sweep", () => {
  it.effect("the retention sweep deletes an order with its open runs and records no close", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder({ id: orderId(1), processedAt: EXPIRED }), []);
        yield* runWith(orderId(1), "open", EXPIRED)(sql);
        yield* sql`
          insert into RunTask (id, runId, position, step, name, teamName)
          values ('task-1', ${`run-${orderId(1)}-open`}, 1, 1, 'Cut', 'Team')
        `;
        const swept = yield* repository.sweepExpiredOrders({ now: NOW });
        const count = (table: string) =>
          sql`select count(*) from ${sql(table)}`.values.pipe(
            Effect.map((rows) => Number(rows[0]?.[0] ?? 0)),
          );
        assert.strictEqual(swept.runs, 1);
        assert.strictEqual(yield* count("Run"), 0);
        // Deleted, not closed: no row is left to carry a reason, and no
        // closed run reaches a member's Done or closed view.
        assert.strictEqual(yield* count("RunTask"), 0);
      }),
    ),
  );
});

/**
 * Stores `n` orders placed past retention, oldest first (`expired-1` is the oldest), each with an
 * open run, straight to SQL: the sweep reads rows, and `upsertOrder` refuses an expired new one.
 */
const storeExpiredOrders = (sql: SqlClient.SqlClient, n: number) =>
  sql.withTransaction(
    Effect.gen(function* () {
      for (let i = 1; i <= n; i++) {
        const id = `gid://shopify/Order/expired-${String(i)}`;
        yield* sql`
          insert into ShopOrder (id, legacyId, name, processedAt, updatedAt, cancelledAt, fulfillmentStatus, fullyPaid, note, syncedAt)
          values (${id}, ${`expired-${String(i)}`}, ${`#expired-${String(i)}`}, ${EXPIRED - n + i}, ${EXPIRED}, null, 'UNFULFILLED', 1, null, ${EXPIRED})
        `;
        yield* runWith(id, "open", EXPIRED)(sql);
      }
    }),
  );

describe("OrderRepository.sweepExpiredOrders, batch and chunking", () => {
  /**
   * 250 expired orders: the first pass takes the oldest 200, which the repository deletes in three
   * chunks (90, 90, 20), the second the last 50, the third nothing. A chunk left out or cut short
   * leaves its orders or runs behind. The 90 itself is not observable here: Node's SQLite admits
   * far more bound parameters per statement than the Durable Object does.
   */
  it.effect(
    "a sweep deletes at most sweepBatch orders, oldest first, each chunk with its runs",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          yield* storeExpiredOrders(sql, 250);
          yield* upsert(repository, anOrder({ id: orderId(1), processedAt: KEPT }), []);
          const expired = (from: number, to: number) =>
            Array.from(
              { length: to - from + 1 },
              (_, i) => `gid://shopify/Order/expired-${String(from + i)}`,
            );

          const first = yield* repository.sweepExpiredOrders({ now: NOW });
          assert.deepStrictEqual(first, {
            orders: ShopLimits.sweepBatch,
            runs: ShopLimits.sweepBatch,
          });
          assert.deepStrictEqual(
            (yield* ids(sql, "ShopOrder")).toSorted(),
            [orderId(1), ...expired(201, 250)].toSorted(),
          );
          assert.deepStrictEqual(
            (yield* ids(sql, "Run")).toSorted(),
            expired(201, 250)
              .map((id) => `run-${id}-open`)
              .toSorted(),
          );

          assert.deepStrictEqual(yield* repository.sweepExpiredOrders({ now: NOW }), {
            orders: 50,
            runs: 50,
          });
          assert.deepStrictEqual(yield* ids(sql, "ShopOrder"), [orderId(1)]);
          assert.deepStrictEqual(yield* ids(sql, "Run"), []);

          assert.deepStrictEqual(yield* repository.sweepExpiredOrders({ now: NOW }), {
            orders: 0,
            runs: 0,
          });
          assert.strictEqual(yield* repository.lastSweepAt(), NOW);
        }),
      ),
  );
});

describe("OrderRepository.countOpenOrders", () => {
  it.effect("follows every write to ShopOrder: redelivery, cancel, reopen, sweep, delete", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const expect = (expected: number, step: string) =>
          Effect.gen(function* () {
            const [counted] = yield* sql`
              select count(*) from ShopOrder
              where fulfillmentStatus <> 'FULFILLED' and cancelledAt is null
            `.values;
            assert.strictEqual(Number(counted?.[0]), expected, `${step}: the rows`);
            assert.strictEqual(yield* repository.countOpenOrders(), expected, step);
          });
        const first = anOrder({ processedAt: KEPT, updatedAt: KEPT });
        yield* upsert(repository, first, []);
        yield* expect(1, "an open order stored");
        yield* upsert(
          repository,
          anOrder({
            id: orderId(2),
            legacyId: "2",
            processedAt: KEPT,
            fulfillmentStatus: "FULFILLED",
          }),
          [],
        );
        yield* expect(1, "a fulfilled order stored");
        yield* upsert(repository, first, []);
        yield* expect(1, "the open order redelivered");
        yield* upsert(repository, { ...first, updatedAt: KEPT + 1, cancelledAt: KEPT + 1 }, []);
        yield* expect(0, "the open order cancelled");
        yield* upsert(repository, { ...first, updatedAt: KEPT + 2 }, []);
        yield* expect(1, "the cancelled order reopened");
        const old = anOrder({ id: orderId(3), legacyId: "3", processedAt: EXPIRED });
        yield* upsert(repository, old, []);
        yield* upsert(
          repository,
          { ...old, updatedAt: old.updatedAt + 1, fulfillmentStatus: "PARTIALLY_FULFILLED" },
          [],
        );
        yield* expect(2, "an expired open order stored, then partly fulfilled");
        yield* repository.sweepExpiredOrders({ now: NOW });
        yield* expect(1, "the sweep deleted the expired open order");
        yield* sql`delete from ShopOrder`;
        yield* expect(0, "every order deleted");
      }),
    ),
  );
});

describe("OrderRepository retention", () => {
  it.effect("an order older than retention is never stored again", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        // Stored while inside the window, then aged past it before a sweep
        // reached it: still stored, so it keeps taking updates.
        yield* upsert(
          repository,
          anOrder({ id: orderId(3), processedAt: EXPIRED, syncedAt: EXPIRED }),
          [],
        );
        // A webhook for a year-old order Baton no longer holds.
        const expired = yield* upsert(
          repository,
          anOrder({ id: orderId(1), processedAt: EXPIRED, syncedAt: NOW }),
          [],
        );
        const kept = yield* upsert(
          repository,
          anOrder({ id: orderId(2), processedAt: KEPT, syncedAt: NOW }),
          [],
        );
        const aged = yield* upsert(
          repository,
          anOrder({ id: orderId(3), processedAt: EXPIRED, updatedAt: NOW, syncedAt: NOW }),
          [],
        );
        assert.deepStrictEqual(expired, {
          written: false,
          fresh: false,
          changed: false,
          refused: false,
          afterWrite: Option.none(),
        });
        assert.strictEqual(kept.written, true);
        assert.strictEqual(aged.written, true);
        assert.deepStrictEqual(yield* ids(sql, "ShopOrder"), [orderId(2), orderId(3)]);
      }),
    ),
  );
});

describe("OrderRepository sync state", () => {
  it.effect("records the last error and nothing else", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        const idle = yield* repository.getSyncState();
        const failed = yield* repository.setSyncError({ error: "bulk submit failed" });
        assert.deepStrictEqual(idle, { lastError: null });
        assert.deepStrictEqual(failed, { lastError: "bulk submit failed" });
      }),
    ),
  );

  it.effect("clears the error the next sync is about to supersede", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.setSyncError({ error: "gone" });
        yield* repository.clearSyncError();
        assert.strictEqual((yield* repository.getSyncState()).lastError, null);
      }),
    ),
  );

  it.effect("reports the stored updatedAt for the webhook staleness check", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder({ updatedAt: 7000 }), []);
        assert.deepStrictEqual(yield* repository.getOrderUpdatedAt(orderId(1)), Option.some(7000));
        assert.deepStrictEqual(yield* repository.getOrderUpdatedAt(orderId(2)), Option.none());
      }),
    ),
  );

  it.effect("the error path that follows the sink never overwrites the sink's sentence", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.setSyncErrorIfEmpty({ error: "the merchant sentence" });
        yield* repository.setSyncErrorIfEmpty({ error: "workflow errored" });
        assert.deepStrictEqual(yield* repository.getSyncState(), {
          lastError: "the merchant sentence",
        });
      }),
    ),
  );
});

const names = (page: OrdersPage) => page.orders.map(({ order }) => order.name);
const aTeamId = (value: string) => Schema.decodeUnknownSync(TeamId)(value);
const rowOf = (page: OrdersPage, name: string) =>
  page.orders.find((row) => row.order.name === name);
const flagged = (page: OrdersPage, field: "unassigned") =>
  page.orders.filter((row) => row[field]).map((row) => row.order.name);

/**
 * The orders index's `OrdersPage` as the actor composes it: `listOrders`' page with the counts
 * of a fresh activation's order facts over the same storage, with the given filter, team and
 * search, against `teams`.
 */
const listWith = (
  repository: OrderRepository,
  show: OrdersShow | null,
  {
    team = null,
    q = null,
    teams = [],
    limit = 20,
    cursor = null,
  }: {
    readonly team?: TeamId | null;
    readonly q?: string | null;
    readonly teams?: readonly TeamWithMemberCount[];
    readonly limit?: number;
    readonly cursor?: string | null;
  } = {},
) =>
  Effect.all([
    repository.listOrders({
      limit,
      cursor: cursor === null ? null : Schema.decodeUnknownSync(OrdersCursor)(cursor),
      q: q === null ? null : Schema.decodeUnknownSync(ListSearch)(q),
      show,
      team,
      teams,
    }),
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const facts = yield* makeOrderFacts({
        store: makeOrderFactStore(sql, syncTransaction(sql)),
        shop: SHOP,
      });
      return yield* facts.counts({ team, teams });
    }),
  ]).pipe(Effect.map(([page, counts]): OrdersPage => ({ ...page, ...counts })));

describe("OrderRepository.listOrders", () => {
  it.effect("pages newest first through a keyset cursor", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
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
        const first = yield* listWith(repository, "open", { limit: 2 });
        const second = yield* listWith(repository, "open", {
          limit: 2,
          cursor: first.nextCursor,
        });
        assert.strictEqual(first.orders.length, 2);
        assert.strictEqual(first.orders[0]?.order.name, "#1003");
        assert.strictEqual(first.orders[1]?.order.name, "#1002");
        assert.strictEqual(first.orders[0]?.itemUnits, 1);
        assert.strictEqual(first.orders[0]?.runs.open, 0);
        assert.strictEqual(second.orders.length, 1);
        assert.strictEqual(second.orders[0]?.order.name, "#1001");
        assert.strictEqual(second.nextCursor, null);
      }),
    ),
  );
});

/** One workflow's stored `tasks` document: a single task on `teamId`. */
const taskList = (workflowId: string, teamId: string | null) =>
  JSON.stringify([{ id: `${workflowId}-task`, step: 1, name: "Task", teamId, instructions: null }]);

/** One state case of {@link seedStates}. */
interface StateCase {
  readonly n: number;
  readonly order?: Partial<ShopOrder>;
  readonly states: readonly RunState[];
  /** The product tags of the order's own item; two on workflows' tags and no run on it is a multi-match. */
  readonly matched?: readonly string[];
  /** The order's open runs carry `startedAt`: a task on them is started. */
  readonly started?: boolean;
}

/**
 * Every SQL fragment against `orderPosition` and `orderIssues`:
 * the fixture covers each branch, and each filter value must return exactly the
 * names the TypeScript functions give it. Runs are written directly because
 * the filters only read state. A done run always carries `startedAt` (the schema refuses one
 * without), and an open run carries it when the case says `started`.
 * `#1005`, `#1010` and `#1012` are open and paid with no open and no done
 * run: `no_workflow`; `#1009` is the same unpaid: `unpaid`. `#1005` matched
 * no workflow, which is No workflow with no issue. `#1010`'s only run is
 * closed, which reads no workflow too but decides the item, so it is no
 * issue. `#1014`'s open run is untouched: `not_started`. `#1003`'s open run
 * is untouched beside a done run and `#1004`'s is started: both `making`.
 *
 * `#1012` and `#1013` are the multi-match cases: their items carry the tags
 * of two on workflows, `w1` and `w2`, which the fixture writes directly.
 * `#1013` has an open run *and* an item still waiting on a choice: `making`
 * with the issue `multi_match`. Between them they are also the proof
 * that `json_each` exists in the SQLite under test — every `MULTI_MATCH_ITEM`
 * fragment would throw without it.
 */
const seedStates = (repository: OrderRepository, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const cases: readonly StateCase[] = [
      { n: 1, states: ["done"] },
      { n: 2, states: ["done", "closed"] },
      { n: 3, states: ["done", "open"] },
      { n: 4, states: ["done", "open"], started: true },
      { n: 5, states: [] },
      { n: 6, order: { cancelledAt: 5 }, states: ["done"] },
      { n: 7, order: { fulfillmentStatus: "FULFILLED" }, states: ["done"] },
      { n: 8, states: ["done", "done"] },
      { n: 9, order: { fullyPaid: false }, states: [] },
      { n: 10, states: ["closed"] },
      { n: 11, order: { fulfillmentStatus: "FULFILLED" }, states: [] },
      { n: 12, states: [], matched: ["w1", "w2"] },
      { n: 13, states: ["open"], matched: ["w1", "w2"], started: true },
      // Unpaid: a multi-match is an issue all the same; its open run is untouched.
      { n: 14, order: { fullyPaid: false }, states: ["open"], matched: ["w1", "w2"] },
    ];
    for (const id of ["w1", "w2"])
      yield* sql`
        insert into Workflow (id, name, tag, state, updatedAt, tasks)
        values (${id}, ${id}, ${id}, 'active', 0, ${taskList(id, "team-cut")})
      `;
    for (const { n, order, states, matched, started = false } of cases) {
      yield* upsert(
        repository,
        anOrder({
          id: orderId(n),
          legacyId: String(n),
          name: `#10${String(n).padStart(2, "0")}`,
          processedAt: n * 1000,
          fullyPaid: true,
          ...order,
        }),
        [
          aLineItem(n, {
            orderId: orderId(n),
            ...(matched === undefined ? {} : { productTags: matched }),
          }),
        ],
      );
      for (const [index, state] of states.entries())
        yield* sql`
          insert into Run (
            id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
            lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
            state, currentStep, stepCount, startedAt, closedAt, closedReason, createdAt, updatedAt
          ) values (
            ${`run-${String(n)}-${String(index)}`}, 'wf', 'Workflow',
            ${orderId(n)}, ${`#10${String(n).padStart(2, "0")}`}, 0,
            ${`${lineItemId(n)}-${String(index)}`}, 'Item', null, null, 1,
            '[]', ${state}, ${state === "open" ? 1 : null}, 1,
            ${state === "done" || (state === "open" && started) ? 1 : null},
            ${state === "closed" ? 1 : null},
            ${state === "closed" ? "merchant_cancelled" : null}, 0, 0
          )
        `;
    }
  });

/**
 * {@link seedStates} plus the issues it lacks, and a team to filter on: `#1003`'s
 * open run is blocked, `#1004`'s open run has a task on a team that
 * was deleted (unassigned), and `#1015`, added here, is not started, with
 * its current task on a team with no members, which is no order issue.
 * Ready tasks on Cut hang off `#1013` and `#1014`, both choosing.
 */
const seedIssues = (repository: OrderRepository, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* seedStates(repository, sql);
    const task = (id: string, runId: string, teamId: string) => sql`
      insert into RunTask
        (id, runId, position, step, name, teamId, teamName, doneAt)
      values (${id}, ${runId}, 1, 1, 'Task', ${teamId}, 'Team', null)
    `;
    yield* sql`update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-3-1'`;
    yield* task("s4", "run-4-1", "team-gone");
    yield* task("s13", "run-13-0", "team-cut");
    yield* task("s14", "run-14-0", "team-cut");
    yield* upsert(
      repository,
      anOrder({
        id: orderId(15),
        legacyId: "15",
        name: "#1015",
        processedAt: 15_000,
        fullyPaid: true,
      }),
      [aLineItem(15, { orderId: orderId(15) })],
    );
    yield* sql`
      insert into Run (
        id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
        lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
        state, currentStep, stepCount, closedAt, closedReason, createdAt, updatedAt
      ) values (
        'run-15-0', 'wf', 'Workflow', ${orderId(15)}, '#1015', 0,
        ${`${lineItemId(15)}-0`}, 'Item', null, null, 1, '[]', 'open', 1, 1, null,
        null, 0, 0
      )
    `;
    yield* task("s15", "run-15-0", "team-empty");
    const teams = Schema.decodeUnknownSync(Schema.Array(TeamWithMemberCount))([
      { id: "team-cut", name: "Cut", memberCount: 1 },
      { id: "team-empty", name: "Polish", memberCount: 0 },
    ]);
    const list = (filter: OrdersShow | null, team: TeamId | null = null, q: string | null = null) =>
      listWith(repository, filter, { team, q, teams });
    return { list };
  });

describe("OrderRepository.listOrders multi-match", () => {
  /**
   * `MULTI_MATCH_ITEM` is the SQL twin of `itemMatches`. Of four
   * workflows tagged for the first item, two are on with every task on a
   * team, one is off and one has an unassigned task, so the item is
   * a multi-match; the second item carries one eligible workflow's tag and the
   * two ineligible ones', so it is not. SQL and TypeScript count the same.
   */
  it.effect("the index's multi-match predicate agrees with multiMatchItems", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const cases: readonly (readonly [string, WorkflowState, string | null])[] = [
          ["w1", "active", "team-cut"],
          ["w2", "active", "team-cut"],
          ["w3", "inactive", "team-cut"],
          ["w4", "active", null],
        ];
        for (const [id, state, teamId] of cases)
          yield* sql`
            insert into Workflow (id, name, tag, state, updatedAt, tasks)
            values (${id}, ${id}, ${id}, ${state}, 0, ${taskList(id, teamId)})
          `;
        const details = cases.map(([id, state, teamId]) =>
          Schema.decodeUnknownSync(WorkflowDetail)({
            workflow: { id, name: id, tag: id, state, updatedAt: 0 },
            tasks: [
              { id: `${id}-task`, position: 1, step: 1, name: "Task", teamId, instructions: null },
            ],
          }),
        );
        const teams = Schema.decodeUnknownSync(Schema.Array(TeamWithMemberCount))([
          { id: "team-cut", name: "Cut", memberCount: 1 },
        ]);
        const lineItems = [
          aLineItem(1, { productTags: ["w1", "w2", "w3", "w4"] }),
          aLineItem(2, { productTags: ["w1", "w3", "w4"] }),
          // Tags match exactly: a case variant or a padded tag is another tag.
          aLineItem(3, { productTags: ["W1", " w2 "] }),
          // A tag listed twice is one workflow, not two: counted per workflow.
          aLineItem(4, { productTags: ["w1", "w1"] }),
        ];
        yield* upsert(repository, anOrder({ fullyPaid: true }), lineItems);
        const page = yield* listWith(repository, "open", { teams });
        const tsCount = multiMatchItems(lineItems, [], details, teams).length;
        assert.strictEqual(tsCount, 1);
        assert.strictEqual(page.orders[0]?.multiMatchItems, tsCount);
      }),
    ),
  );
});

describe("OrderRepository.listOrders by tag", () => {
  it.effect(
    "an item matches by its own tags: a workflow whose tag no item carries is never evaluated",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          const insert = (id: string) => sql`
            insert into Workflow (id, name, tag, state, updatedAt, tasks)
            values (${id}, ${id}, ${id}, 'active', 0, ${taskList(id, "team-cut")})
          `;
          yield* insert("w1");
          yield* insert("w2");
          // A thousand on workflows whose tags no item carries.
          for (let index = 0; index < 1000; index++) yield* insert(`x${String(index)}`);
          yield* upsert(repository, anOrder({ fullyPaid: true }), [
            aLineItem(1, { productTags: ["w1", "w2"] }),
          ]);
          const page = yield* listWith(repository, "open");
          // No `analyze`: with statistics the planner reverses this join and scans every
          // workflow per item.
          const rows = yield* sql.unsafe<{ readonly detail: string }>(
            `explain query plan select ${ITEM_MATCHES} from OrderLineItem li`,
          );
          const plan = rows.map((row) => row.detail);
          assert.strictEqual(page.orders[0]?.multiMatchItems, 1);
          // The probe searches the unique index on Workflow.tag; it never scans the workflows.
          assert.isTrue(
            plan.some((detail) => detail.startsWith("SEARCH w USING INDEX")),
            plan.join("\n"),
          );
          assert.isFalse(
            plan.some((detail) => /^SCAN w\b/u.test(detail)),
            plan.join("\n"),
          );
        }),
      ),
  );
});

/** The plan lines that read `alias`, by search or by scan. */
const reads = (plan: readonly string[], alias: string) =>
  plan.filter((detail) => new RegExp(`^(?:SEARCH|SCAN) ${alias}\\b`, "u").test(detail));

/** The plans of the statements `effect` runs, each captured compiled and explained with its own parameters. */
const plansOf = <A, E, R>(sql: SqlClient.SqlClient, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const captured: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    yield* effect.pipe(
      Effect.provideService(Statement.CurrentTransformer, (self) =>
        Effect.sync(() => {
          captured.push(self.compile());
          return self;
        }),
      ),
    );
    // The order facts' trigger DDL is captured too, and explaining it would prepare it again.
    const reads = captured.filter(([query]) => /^\s*select\b/iu.test(query));
    return yield* Effect.forEach(reads, ([query, params]) =>
      sql
        .unsafe<{ readonly detail: string }>(`explain query plan ${query}`, params)
        .pipe(Effect.map((rows) => ({ query, plan: rows.map((row) => row.detail) }))),
    );
  });

/**
 * The plans of the statements the orders index runs, read from the statement text it executed.
 * Every plan here is the no-statistics plan: nothing runs `analyze`, and neither does the actor.
 */
describe("OrderRepository.listOrders query plans", () => {
  const factsPlan = (gather: string) =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        yield* seedIssues(repository, sql);
        const rows = yield* sql.unsafe<{ readonly detail: string }>(`explain query plan ${gather}`);
        return rows.map((row) => row.detail);
      }),
    );

  /** What both scopes' plans share: every probe by the order's id, never a table scan. */
  const assertProbes = (plan: readonly string[]) => {
    const runs = reads(plan, "r").filter((detail) => !detail.includes("(lineItemId=?)"));
    assert.isTrue(runs.length > 0, plan.join("\n"));
    assert.isTrue(
      runs.every((detail) => detail.startsWith("SEARCH r USING INDEX Run_orderId_state_idx")),
      plan.join("\n"),
    );
    const tasks = reads(plan, "s");
    assert.isTrue(tasks.length > 0, plan.join("\n"));
    assert.isTrue(
      tasks.every((detail) =>
        detail.startsWith("SEARCH s USING INDEX sqlite_autoindex_RunTask_2 (runId=?)"),
      ),
      plan.join("\n"),
    );
    assert.isFalse(
      plan.some((detail) => detail.includes("RunTask_teamId_idx")),
      plan.join("\n"),
    );
    const workflows = reads(plan, "w");
    assert.isTrue(workflows.length > 0, plan.join("\n"));
    assert.isTrue(
      workflows.every((detail) => detail.startsWith("SEARCH w") && detail.includes("(tag=?)")),
      plan.join("\n"),
    );
  };

  // No `analyze`: the plan is the one the actor runs.
  it.effect("a full read of the facts walks the open orders and probes everything by order", () =>
    Effect.gen(function* () {
      const plan = yield* factsPlan(GATHER_ALL);
      assertProbes(plan);
      const orders = reads(plan, "o");
      assert.isTrue(orders.length > 0, plan.join("\n"));
      assert.isTrue(
        orders.every((detail) => detail.includes("ShopOrder_open_idx")),
        plan.join("\n"),
      );
    }),
  );

  // No `analyze`: the plan is the one the actor runs.
  it.effect("a patch of the facts drives from the primary key, never the open orders", () =>
    Effect.gen(function* () {
      const plan = yield* factsPlan(GATHER_MARKED);
      assertProbes(plan);
      const orders = reads(plan, "o");
      assert.isTrue(orders.length > 0, plan.join("\n"));
      assert.isTrue(
        orders.every((detail) =>
          detail.startsWith("SEARCH o USING INDEX sqlite_autoindex_ShopOrder_1 (id=?)"),
        ),
        plan.join("\n"),
      );
    }),
  );

  // No `analyze`: the plan is the one the actor runs.
  it.effect("the team filter reads a run's tasks by run, never the team's tasks by team", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* seedIssues(repository, sql);
        const page = (yield* plansOf(sql, list(null, aTeamId("team-cut")))).find(({ query }) =>
          query.includes(" wr"),
        );
        if (page === undefined) return yield* Effect.die("no page statement");
        const { plan } = page;
        const wr = reads(plan, "wr");
        assert.isTrue(wr.length > 0, plan.join("\n"));
        assert.isTrue(
          wr.every((detail) => detail.startsWith("SEARCH wr USING INDEX Run_orderId_state_idx")),
          plan.join("\n"),
        );
        assert.isTrue(
          reads(plan, "s").some((detail) =>
            detail.startsWith("SEARCH s USING INDEX sqlite_autoindex_RunTask_2 (runId=?)"),
          ),
          plan.join("\n"),
        );
        assert.isFalse(
          plan.some((detail) => detail.includes("RunTask_teamId_idx")),
          plan.join("\n"),
        );
      }),
    ),
  );
});

describe("OrderRepository.listOrders filters", () => {
  it.effect(
    "each position filter returns exactly the orders orderPosition gives that position, and an order whose only run is closed is no workflow",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          yield* seedStates(repository, sql);
          const list = (show: OrdersShow | null) => listWith(repository, show);
          const pages = {
            default: yield* list(null),
            open: yield* list("open"),
            all: yield* list("all"),
            unpaid: yield* list("unpaid"),
            no_workflow: yield* list("no_workflow"),
            not_started: yield* list("not_started"),
            making: yield* list("making"),
            made: yield* list("made"),
            fulfilled: yield* list("fulfilled"),
            cancelled: yield* list("cancelled"),
          };
          assert.strictEqual(pages.all.orders.length, 14);
          assert.deepStrictEqual(names(pages.unpaid), ["#1009"]);
          assert.deepStrictEqual(names(pages.no_workflow), ["#1012", "#1010", "#1005"]);
          assert.deepStrictEqual(names(pages.not_started), ["#1014"]);
          // `#1013`: one item being made beside one waiting on a choice. It is making, with the
          // choice as an issue. `#1003`: a done run beside an untouched open one is making.
          assert.deepStrictEqual(names(pages.making), ["#1013", "#1004", "#1003"]);
          // Show left out is Making.
          assert.deepStrictEqual(names(pages.default), names(pages.making));
          assert.deepStrictEqual(names(pages.made), ["#1008", "#1002", "#1001"]);
          assert.deepStrictEqual(names(pages.fulfilled), ["#1011", "#1007"]);
          assert.deepStrictEqual(names(pages.cancelled), ["#1006"]);
          // The SQL and the TypeScript agree row by row.
          for (const row of pages.all.orders) {
            const state = orderPosition(row);
            for (const position of OrderPosition.literals)
              assert.strictEqual(
                names(pages[position]).includes(row.order.name),
                state === position,
                `${row.order.name} as ${state} under ${position}`,
              );
            assert.strictEqual(
              names(pages.open).includes(row.order.name),
              orderIsOpen(row.order),
              `${row.order.name} under Open`,
            );
          }
        }),
      ),
  );

  it.effect(
    "the Issues filter returns exactly the orders orderIssues gives at least one issue",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          const { list } = yield* seedIssues(repository, sql);
          // A stale block on a fulfilled order's run is not an issue.
          yield* sql`update Run set state = 'open', currentStep = 1, blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-7-0'`;
          const all = yield* list("all");
          const issues = yield* list("issues");
          // Choosing `#1014` (unpaid), `#1013` and `#1012`, unassigned `#1004`, blocked `#1003`.
          // `#1005` matched no workflow, `#1010`'s only run was closed, and `#1015` waits on a
          // team with no members, a workflow fault and no order issue.
          assert.deepStrictEqual(names(issues), ["#1014", "#1013", "#1012", "#1004", "#1003"]);
          for (const row of all.orders)
            assert.strictEqual(
              names(issues).includes(row.order.name),
              orderIssues(row).length > 0,
              `${row.order.name} under Issues`,
            );
        }),
      ),
  );

  /**
   * `OrderCounts`, checked as the rule itself: for every filter, team
   * and search, each count equals the length of the list its value would show
   * under that team with no search, so a count never moves with the Show
   * filter or the search.
   */
  it.effect("a count ignores the search and the main filter and honours the team", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* seedIssues(repository, sql);
        const filters = [
          null,
          "open",
          "unpaid",
          "no_workflow",
          "issues",
          "not_started",
          "making",
          "made",
          "fulfilled",
          "cancelled",
          "all",
        ] as const;
        const counted = {
          no_workflow: "no_workflow",
          not_started: "not_started",
          making: "making",
          made: "made",
          issues: "issues",
        } as const satisfies Record<keyof OrderCounts, OrdersShow>;
        for (const filter of filters)
          for (const team of [null, aTeamId("team-cut")])
            for (const q of [null, "1007", "1013", "item 1"]) {
              const { counts } = yield* list(filter, team, q);
              for (const key of Object.keys(counted) as (keyof typeof counted)[])
                assert.strictEqual(
                  counts[key],
                  (yield* list(counted[key], team)).orders.length,
                  `${String(filter)}/${String(team)}/${String(q)}: ${key}`,
                );
            }
        // Every open order, unpaid `#1009` included, which no cell counts.
        assert.strictEqual((yield* list(null)).openOrders, 12);
        assert.deepStrictEqual((yield* list(null)).counts, {
          no_workflow: 3,
          not_started: 2,
          making: 3,
          made: 3,
          issues: 5,
        });
        // Cut holds `#1013`, making, and `#1014`, not started, both choosing.
        assert.deepStrictEqual((yield* list(null, aTeamId("team-cut"))).counts, {
          no_workflow: 0,
          not_started: 1,
          making: 1,
          made: 0,
          issues: 2,
        });
      }),
    ),
  );

  /**
   * `OrderRow.unassigned` as the counts derive it from the facts: an open task on no team (a
   * SQL null the facts carry through `json_group_array`) and one on a team D1 no longer has are
   * each an issue; a done task on no team is not.
   */
  it.effect("Issues counts an open task on no team or on a team gone, and no done task", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        yield* seedStates(repository, sql);
        const teams = Schema.decodeUnknownSync(Schema.Array(TeamWithMemberCount))([
          { id: "team-cut", name: "Cut", memberCount: 1 },
        ]);
        const task = (id: string, runId: string, teamId: string | null, doneAt: number | null) => {
          const role = doneAt === null ? null : "merchant";
          return sql`
            insert into RunTask (
              id, runId, position, step, name, teamId, teamName,
              startedAt, startedByRole, doneAt, doneByRole
            ) values (
              ${id}, ${runId}, ${id === "s3-done" ? 1 : 2}, 1, 'Task', ${teamId}, 'Team',
              ${doneAt}, ${role}, ${doneAt}, ${role}
            )
          `;
        };
        const issues = Effect.gen(function* () {
          const page = yield* listWith(repository, "issues", { teams });
          assert.strictEqual(page.counts.issues, page.orders.length);
          return names(page);
        });
        // The multi-match orders alone.
        const multi = ["#1014", "#1013", "#1012"];
        yield* task("s3-done", "run-3-1", null, 1);
        assert.deepStrictEqual(yield* issues, multi);
        yield* task("s3", "run-3-1", null, null);
        assert.deepStrictEqual(yield* issues, [...multi, "#1003"]);
        yield* task("s4", "run-4-1", "team-gone", null);
        assert.deepStrictEqual(yield* issues, [...multi, "#1004", "#1003"]);
      }),
    ),
  );

  it.effect("search ignores the filters", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* seedIssues(repository, sql);
        // Fulfilled, so under no Made filter, and waiting on nobody.
        assert.deepStrictEqual(names(yield* list("made", aTeamId("team-nobody"), "1007")), [
          "#1007",
        ]);
        // Waiting on Cut, making, not made.
        assert.deepStrictEqual(names(yield* list("made", aTeamId("team-nobody"), "1013")), [
          "#1013",
        ]);
      }),
    ),
  );

  it.effect("a search by item title finds the order whatever the filters", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* seedIssues(repository, sql);
        const found = yield* list("made", aTeamId("team-nobody"), "item 7");
        assert.deepStrictEqual(names(found), ["#1007"]);
        assert.strictEqual(found.matches, 1);
      }),
    ),
  );

  it.effect("a search by SKU", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* seedIssues(repository, sql);
        assert.deepStrictEqual(names(yield* list(null, null, "sku-13")), ["#1013"]);
      }),
    ),
  );

  it.effect("Issues holds every open order with an issue, whatever its position", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* seedIssues(repository, sql);
        const open = yield* list("open");
        const issues = yield* list("issues");
        // Not started `#1014`, making `#1013`, `#1004` and `#1003`, and no workflow `#1012`.
        assert.deepStrictEqual(
          names(issues),
          names(open).filter((name) =>
            ["#1014", "#1013", "#1012", "#1004", "#1003"].includes(name),
          ),
        );
        assert.deepStrictEqual(
          new Set(issues.orders.map((row) => orderPosition(row))),
          new Set(["making", "not_started", "no_workflow"]),
        );
      }),
    ),
  );

  it.effect("a filter under a team narrows to the open orders waiting on it", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* seedIssues(repository, sql);
        // A leftover open run with a current task on Cut, on a fulfilled order.
        yield* sql`update Run set state = 'open', currentStep = 1 where id = 'run-7-0'`;
        yield* sql`
          insert into RunTask
            (id, runId, position, step, name, teamId, teamName, doneAt)
          values ('s7', 'run-7-0', 1, 1, 'Task', 'team-cut', 'Team', null)
        `;
        const cut = aTeamId("team-cut");
        assert.deepStrictEqual(names(yield* list("all", cut)), ["#1014", "#1013"]);
        assert.deepStrictEqual(names(yield* list("fulfilled", cut)), []);
        assert.deepStrictEqual(names(yield* list("issues", cut)), ["#1014", "#1013"]);
      }),
    ),
  );

  /**
   * `RunCounts.blocked` counts open runs only, and a closed run is not
   * counted at all (`#1002`'s closed run leaves its counts at one done run).
   * A done run carries no block (the actor's data model), so no done run is blocked here.
   */
  it.effect("counts a block on open runs only, and counts closed runs not at all", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        yield* seedStates(repository, sql);
        yield* sql`update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-3-1'`;
        const all = yield* listWith(repository, "open");
        const runsOf = (name: string) => rowOf(all, name)?.runs;
        assert.deepStrictEqual(runsOf("#1003"), { open: 1, done: 1, blocked: 1, started: 0 });
        assert.deepStrictEqual(runsOf("#1004"), { open: 1, done: 1, blocked: 0, started: 1 });
        assert.deepStrictEqual(runsOf("#1001"), { open: 0, done: 1, blocked: 0, started: 0 });
        assert.deepStrictEqual(runsOf("#1002"), { open: 0, done: 1, blocked: 0, started: 0 });
      }),
    ),
  );
});

/**
 * `ListOrdersInput.q`, read by `searchTerm`: an order number
 * matches `ShopOrder.name` whole, the `#` the merchant's to type or omit; a
 * word is a prefix of an item's title, variant title or SKU, with `like`'s
 * own metacharacters escaped rather than honoured.
 */
describe("OrderRepository.listOrders q", () => {
  const search = (q: string) =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        for (const [n, name, title, variantTitle, sku] of [
          [1, "#1001", "Signet ring", "Rose gold", "RING-9"],
          [2, "#1002", "Brass hinge", null, "HINGE_2"],
          [3, "#2100", "Stamp", "Large", null],
        ] as const)
          yield* upsert(
            repository,
            anOrder({ id: orderId(n), legacyId: String(n), name, processedAt: n * 1000 }),
            [aLineItem(n, { orderId: orderId(n), title, variantTitle, sku })],
          );
        return names(yield* listWith(repository, null, { q }));
      }),
    );

  it.effect("matches the full number with or without the #", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* search("1001"), ["#1001"]);
      assert.deepStrictEqual(yield* search("#1001"), ["#1001"]);
      assert.deepStrictEqual(yield* search("  1001  "), ["#1001"]);
    }),
  );

  it.effect("an order number matches whole, so #10 takes nothing", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* search("#10"), []);
    }),
  );

  it.effect("a word is a prefix of a word in the item title, case-insensitive", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* search("sig"), ["#1001"]);
      assert.deepStrictEqual(yield* search("RING"), ["#1001"]);
      assert.deepStrictEqual(yield* search("net"), []);
    }),
  );

  it.effect("a search by variant title", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* search("gold"), ["#1001"]);
      assert.deepStrictEqual(yield* search("large"), ["#2100"]);
    }),
  );

  it.effect("escapes like's own wildcards rather than honouring them", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* search("%"), []);
      assert.deepStrictEqual(yield* search("hinge_"), ["#1002"]);
      assert.deepStrictEqual(yield* search("hingex"), []);
    }),
  );
});

/** A run task written straight to SQL, done by the merchant at `doneAt` when it is set. */
const insertTask = (
  sql: SqlClient.SqlClient,
  {
    id,
    runId,
    position,
    step,
    teamId,
    doneAt = null,
  }: {
    readonly id: string;
    readonly runId: string;
    readonly position: number;
    readonly step: number;
    readonly teamId: string | null;
    readonly doneAt?: number | null;
  },
) => sql`
  insert into RunTask
    (id, runId, position, step, name, teamId, teamName, doneAt,
     doneByRole, startedAt, startedByRole)
  values (${id}, ${runId}, ${position}, ${step}, 'Task', ${teamId}, 'Team', ${doneAt},
    ${doneAt === null ? null : "merchant"}, ${doneAt},
    ${doneAt === null ? null : "merchant"})
`;

describe("OrderRepository.listOrders team issues", () => {
  const teams = Schema.decodeUnknownSync(Schema.Array(TeamWithMemberCount))([
    { id: "team-cut", name: "Cut", memberCount: 1 },
    { id: "team-empty", name: "Polish", memberCount: 0 },
  ]);

  /**
   * `#1003`'s open run has an open task on a deleted team on its current
   * step; `#1014`'s has a current task on Cut and a later one on the deleted
   * team. `#1`'s done run keeps a stale pointer on a done task and never counts, and `#8` is
   * healthy (`OrderRow.unassigned`).
   */
  it.effect(
    "an open task on a deleted team, on any step, makes the order unassigned, and the Issues filter holds it",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          yield* seedStates(repository, sql);
          const task = (
            id: string,
            runId: string,
            step: number,
            teamId: string,
            doneAt: number | null,
          ) => insertTask(sql, { id, runId, position: step, step, teamId, doneAt });
          yield* task("s1", "run-1-0", 1, "team-gone", 1);
          yield* task("s8", "run-8-0", 1, "team-cut", 1);
          yield* task("s3", "run-3-1", 1, "team-gone", null);
          yield* task("s14a", "run-14-0", 1, "team-cut", null);
          yield* task("s14b", "run-14-0", 2, "team-gone", null);
          const all = yield* listWith(repository, "open", { teams });
          const issues = yield* listWith(repository, "issues", { teams });
          assert.deepStrictEqual(flagged(all, "unassigned"), ["#1014", "#1003"]);
          for (const name of ["#1014", "#1003"]) assert.isTrue(names(issues).includes(name), name);
          assert.isFalse(names(issues).includes("#1008"));
          assert.isFalse(names(issues).includes("#1001"));
          assert.strictEqual(all.counts.issues, names(issues).length);
        }),
      ),
  );
});

/**
 * `ListOrdersInput.team`: the orders with a current task on the team
 * on an open run, through the same `Run.currentStep` the member's workflows list
 * runs on. The fixture reuses {@link seedStates}' runs and hangs tasks off them; on
 * #1003 and #1004, `run-N-0` is done and `run-N-1` is open.
 */
describe("OrderRepository.listOrders team", () => {
  const teams = Schema.decodeUnknownSync(Schema.Array(TeamWithMemberCount))([
    { id: "team-cut", name: "Cut", memberCount: 1 },
    { id: "team-polish", name: "Anodize", memberCount: 1 },
    { id: "team-pack", name: "Pack", memberCount: 1 },
  ]);

  const waitingFixture = (repository: OrderRepository, sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* seedStates(repository, sql);
      /** `position` is unique per run and only orders a list, so it comes off a counter; `step` decides which tasks are current and every case names it. */
      let position = 0;
      const task = (id: string, runId: string, step: number, team: string) => {
        position += 1;
        return insertTask(sql, { id, runId, position, step, teamId: team });
      };
      // #1003: two open item runs both current on Cut, so the order is listed once; the done
      // run's task is on Cut too, and a run that is over holds nobody up.
      yield* sql`
        insert into Run (
          id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
          lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
          state, currentStep, stepCount, createdAt, updatedAt
        ) values (
          'run-3-2', 'wf', 'Workflow', ${orderId(3)}, '#1003', 0,
          ${`${lineItemId(3)}-2`}, 'Item', null, null, 1, '[]', 'open',
          1, 1, 0, 0
        )
      `;
      yield* task("s3a", "run-3-1", 1, "team-cut");
      yield* task("s3b", "run-3-0", 1, "team-cut");
      yield* task("s3e", "run-3-2", 1, "team-cut");
      // #1004: current on Cut, with a later step on Anodize that is not current.
      yield* task("s4a", "run-4-1", 1, "team-cut");
      yield* task("s4b", "run-4-1", 2, "team-polish");
      const list = (team: TeamId | null = null, filter: OrdersShow | null = "open") =>
        listWith(repository, filter, { team, teams });
      return { task, list };
    });

  /**
   * `#1007` is fulfilled and `#1006` cancelled. Reconcile closes every open
   * run on a closed order, but the rule does not lean on that: each is given
   * a leftover open run with an unassigned current task and a current task on
   * Cut, and neither order has an issue or waits on anyone under the
   * filter, whichever position is chosen.
   */
  it.effect("a fulfilled or cancelled order has no issues and waits on no team", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { task, list } = yield* waitingFixture(repository, sql);
        yield* sql`update Run set state = 'open', currentStep = 1, blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-7-0'`;
        yield* sql`update Run set state = 'open', currentStep = 1 where id = 'run-6-0'`;
        yield* task("s7", "run-7-0", 1, "team-cut");
        yield* task("s6", "run-6-0", 1, "team-cut");
        yield* task("s6b", "run-6-0", 1, "team-gone");
        const all = yield* list(null, "all");
        const cut = yield* list(aTeamId("team-cut"), "all");
        const issues = yield* list(null, "issues");
        for (const name of ["#1007", "#1006"]) {
          const row = rowOf(all, name);
          assert.strictEqual(row === undefined ? null : orderIssues(row).length, 0);
          assert.isFalse(names(issues).includes(name));
        }
        assert.deepStrictEqual(names(cut), ["#1004", "#1003"]);
      }),
    ),
  );

  /**
   * A blocked run's current task still satisfies `currentWhere` (the workflows list keeps
   * showing it), but the team cannot move it, so the filter leaves the order
   * out; `RunCounts.blocked` is where that run is counted.
   */
  it.effect("leaves out a blocked run, which is counted as blocked instead", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* waitingFixture(repository, sql);
        yield* sql`update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-4-1'`;
        const filtered = yield* list(aTeamId("team-cut"));
        assert.strictEqual(rowOf(filtered, "#1004"), undefined);
        assert.strictEqual(rowOf(filtered, "#1003")?.order.name, "#1003");
      }),
    ),
  );

  /**
   * #1003 has two open runs current on Cut and is listed once; #1001's runs
   * are all done; Anodize's task on #1004 is a later step. The counts are
   * narrowed to the filter, as `OrderCounts` says.
   */
  it.effect("keeps exactly the rows waiting on that team, and narrows the counts to it", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        const { list } = yield* waitingFixture(repository, sql);
        const all = yield* list();
        const cut = yield* list(aTeamId("team-cut"));
        // Anodize owns #1004's second step, which is not current yet.
        const polish = yield* list(aTeamId("team-polish"));
        const unknown = yield* list(aTeamId("team-nobody"));
        assert.deepStrictEqual(names(cut), ["#1004", "#1003"]);
        assert.deepStrictEqual(names(polish), []);
        assert.deepStrictEqual(names(unknown), []);
        const none = { no_workflow: 0, not_started: 0, making: 0, made: 0, issues: 0 };
        assert.deepStrictEqual(cut.counts, { ...none, making: 2 });
        assert.deepStrictEqual(unknown.counts, none);
        assert.strictEqual(all.counts.making, 3);
      }),
    ),
  );
});

/**
 * The order page's and manual attach's lookups: by Shopify's numeric id, and an item with its
 * order.
 */
describe("OrderRepository.getOrderByLegacyId and getLineItem", () => {
  it.effect("find an order by its legacy id and an item with its order, and none for neither", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder({ legacyId: "77" }), [aLineItem(1), aLineItem(2)]);
        const detail = Option.getOrThrow(yield* repository.getOrderByLegacyId("77"));
        assert.strictEqual(detail.order.id, orderId(1));
        assert.deepStrictEqual(
          detail.lineItems.map(({ id }) => id),
          [lineItemId(1), lineItemId(2)],
        );
        assert.isTrue(Option.isNone(yield* repository.getOrderByLegacyId("78")));
        const found = Option.getOrThrow(yield* repository.getLineItem(lineItemId(2)));
        assert.strictEqual(found.order.id, orderId(1));
        assert.strictEqual(found.lineItem.id, lineItemId(2));
        assert.isTrue(Option.isNone(yield* repository.getLineItem(lineItemId(9))));
      }),
    ),
  );
});

/**
 * The start of an open-orders sync and the tracking record it leaves (`SyncState.workflowId`
 * and `startedAt`), which stands in for the Agents SDK's tracking row: legacy's
 * `orders-sync-workflow.test.ts` rules, over the repository.
 */
describe("OrderRepository.beginSync", () => {
  const NOW = Date.UTC(2026, 9, 17);
  const MINUTE = 60_000;

  it.effect("a fresh tracking record refuses the start and writes nothing", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        const first = yield* repository.beginSync({ workflowId: "wf-1", now: NOW });
        yield* repository.setSyncError({ error: "kept" });
        const second = yield* repository.beginSync({ workflowId: "wf-2", now: NOW + 9 * MINUTE });
        assert.strictEqual(first._tag, "Started");
        assert.deepStrictEqual(second, { _tag: "InFlight", workflowId: "wf-1" });
        assert.deepStrictEqual(yield* repository.getSyncTracking(), {
          workflowId: "wf-1",
          startedAt: NOW,
        });
        assert.strictEqual((yield* repository.getSyncState()).lastError, "kept");
      }),
    ),
  );

  it.effect("a tracking record older than ten minutes is cleared and the sync starts", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.trackSync({ workflowId: "wf_never_existed", startedAt: NOW });
        const started = yield* repository.beginSync({ workflowId: "wf-2", now: NOW + 10 * MINUTE });
        assert.deepStrictEqual(started, {
          _tag: "Started",
          stale: { workflowId: "wf_never_existed", startedAt: NOW },
        });
        assert.deepStrictEqual(yield* repository.getSyncTracking(), {
          workflowId: "wf-2",
          startedAt: NOW + 10 * MINUTE,
        });
      }),
    ),
  );

  /** Legacy's integration case, pinned here with an explicit `now`: no Workflow is behind it. */
  it.effect("a tracking row older than ten minutes is deleted on the next press", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        const hourAgo = NOW - 60 * MINUTE;
        yield* repository.trackSync({ workflowId: "wf_never_existed", startedAt: hourAgo });
        assert.isFalse((yield* repository.getSyncStatus(NOW)).inFlight);
        const started = yield* repository.beginSync({ workflowId: "wf-next", now: NOW });
        assert.strictEqual(started._tag, "Started");
        assert.deepStrictEqual(yield* repository.getSyncTracking(), {
          workflowId: "wf-next",
          startedAt: NOW,
        });
        assert.deepStrictEqual(yield* repository.getSyncStatus(NOW), {
          inFlight: true,
          lastError: null,
        });
      }),
    ),
  );

  it.effect("a start clears the last error and the refusal flag", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        yield* repository.setSyncError({ error: "the last sync failed" });
        yield* repository.markOrdersLimited(NOW - MINUTE);
        yield* repository.beginSync({ workflowId: "wf-1", now: NOW });
        assert.strictEqual((yield* repository.getSyncState()).lastError, null);
        assert.strictEqual((yield* usage(repository, sql)).ordersLimitedAt, null);
      }),
    ),
  );

  it.effect(
    "a sync refused at the order ceiling flags the refusal, writes no error and tracks nothing",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          yield* storeOpenOrders(sql, ShopLimits.maxOpenOrders, CYCLE_START);
          yield* repository.trackSync({ workflowId: "wf-dead", startedAt: NOW - 11 * MINUTE });
          const refused = yield* repository.beginSync({ workflowId: "wf-1", now: NOW });
          assert.deepStrictEqual(refused, {
            _tag: "Refused",
            openOrders: ShopLimits.maxOpenOrders,
            stale: { workflowId: "wf-dead", startedAt: NOW - 11 * MINUTE },
          });
          assert.strictEqual((yield* usage(repository, sql)).ordersLimitedAt, NOW);
          assert.strictEqual((yield* repository.getSyncState()).lastError, null);
          assert.deepStrictEqual(yield* repository.getSyncTracking(), {
            workflowId: null,
            startedAt: null,
          });
        }),
      ),
  );

  it.effect("a tracking row disables Sync open orders only while it is fresh", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        const idle = yield* repository.getSyncStatus(NOW);
        yield* repository.trackSync({ workflowId: "wf-1", startedAt: NOW });
        const fresh = yield* repository.getSyncStatus(NOW + 9 * MINUTE);
        const stale = yield* repository.getSyncStatus(NOW + 10 * MINUTE);
        assert.deepStrictEqual(idle, { inFlight: false, lastError: null });
        assert.deepStrictEqual(fresh, { inFlight: true, lastError: null });
        assert.deepStrictEqual(stale, { inFlight: false, lastError: null });
      }),
    ),
  );

  it.effect("a sync's end clears the tracking record only when the record is its own", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        yield* repository.trackSync({ workflowId: "wf-2", startedAt: NOW });
        const other = yield* repository.clearSyncTracking({ workflowId: "wf-1" });
        const kept = yield* repository.getSyncTracking();
        const own = yield* repository.clearSyncTracking({ workflowId: "wf-2" });
        assert.isFalse(other);
        assert.deepStrictEqual(kept, { workflowId: "wf-2", startedAt: NOW });
        assert.isTrue(own);
        assert.deepStrictEqual(yield* repository.getSyncTracking(), {
          workflowId: null,
          startedAt: null,
        });
      }),
    ),
  );

  /**
   * Legacy compared the whole `SyncState` row before and after, because the tracking row was the
   * Agents SDK's own table. Here the tracking record is `SyncState.workflowId` and `startedAt`,
   * so the completion clears exactly those two columns and every other column, of `SyncState`
   * and `ShopUsage`, is as the start left it. Both completions, `ShopActor.onOrdersStream` and
   * `onOrdersSyncEmpty`, end in this `clearSyncTracking`; the orders a stream writes are its rows.
   */
  it.effect("a completed sync deletes the tracking row and writes nothing else", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        yield* upsert(repository, anOrder(), [aLineItem(1)]);
        yield* repository.beginSync({ workflowId: "wf-1", now: NOW });
        const syncState = sql`select * from SyncState`;
        const shopUsage = sql`select * from ShopUsage`;
        const started = { syncState: yield* syncState, shopUsage: yield* shopUsage };
        assert.isTrue(yield* repository.clearSyncTracking({ workflowId: "wf-1" }));
        assert.deepStrictEqual(
          { syncState: yield* syncState, shopUsage: yield* shopUsage },
          {
            syncState: started.syncState.map((row) => ({
              ...row,
              workflowId: null,
              startedAt: null,
            })),
            shopUsage: started.shopUsage,
          },
        );
        assert.deepStrictEqual(yield* ids(sql, "ShopOrder"), [orderId(1)]);
        assert.deepStrictEqual(yield* repository.getSyncStatus(NOW + MINUTE), {
          inFlight: false,
          lastError: null,
        });
      }),
    ),
  );
});

/**
 * The webhook path's probe before the Backend's fetch. Legacy lowered `ShopLimits.maxOpenOrders`
 * to 2 and delivered a webhook to the object; here the ceiling keeps its value, is filled with open
 * rows, and the probe is the repository's: that `Refused` makes no Admin call is the Backend's
 * half, pinned by `webhooks.test.ts`' "a refused version answers 200 with no Admin call and
 * nothing stored".
 */
describe("OrderRepository.orderVersion", () => {
  const NOW = Date.UTC(2026, 9, 17);

  it.effect("refuses a new order at the ceiling and flags the refusal", () =>
    runInRepository((repository, sql) =>
      Effect.gen(function* () {
        yield* storeOpenOrders(sql, ShopLimits.maxOpenOrders, CYCLE_START);
        const version = yield* repository.orderVersion({
          orderId: orderId(1),
          updatedAt: CYCLE_START,
          now: NOW,
        });
        assert.deepStrictEqual(version, {
          _tag: "Refused",
          openOrders: ShopLimits.maxOpenOrders,
        });
        const after = yield* usage(repository, sql);
        assert.strictEqual(after.openOrders, ShopLimits.maxOpenOrders);
        assert.strictEqual(after.ordersLimitedAt, NOW);
        assert.lengthOf(yield* ids(sql, "ShopOrder"), ShopLimits.maxOpenOrders);
      }),
    ),
  );

  /**
   * Legacy's case ran on webhooks to the object and on Sync open orders through its Workflow; here
   * each read is the repository's: the webhook's probe (`orderVersion`), the write
   * (`upsertOrder`) and the start (`beginSync`). The orders a fulfilment frees are read at each,
   * with no counter to fall out of step.
   */
  it.effect(
    "the order ceiling is read against the open orders stored: a fulfilled order makes room for a new one",
    () =>
      runInRepository((repository, sql) =>
        Effect.gen(function* () {
          yield* storeOpenOrders(sql, ShopLimits.maxOpenOrders, CYCLE_START);
          const probe = () =>
            repository.orderVersion({ orderId: orderId(1), updatedAt: null, now: NOW });
          assert.strictEqual((yield* probe())._tag, "Refused");
          assert.isTrue((yield* upsert(repository, paid(1), [])).refused);
          assert.strictEqual(
            (yield* repository.beginSync({ workflowId: "wf-refused", now: NOW }))._tag,
            "Refused",
          );

          const fulfilled = "gid://shopify/Order/open-1";
          const update = yield* upsert(
            repository,
            paid(0, {
              id: fulfilled,
              legacyId: "open-1",
              updatedAt: CYCLE_START + 1,
              fulfillmentStatus: "FULFILLED",
            }),
            [],
          );
          assert.isTrue(update.written);
          assert.strictEqual((yield* probe())._tag, "Fetch");
          const stored = yield* upsert(repository, paid(1), []);
          assert.isTrue(stored.fresh);
          const limited = yield* usage(repository, sql);
          assert.strictEqual(limited.openOrders, ShopLimits.maxOpenOrders);
          // Stored again, but the refused delivery is still a gap: the flag stays until Sync
          // open orders starts.
          assert.strictEqual(limited.ordersLimitedAt, NOW);

          yield* sql`update ShopOrder set fulfillmentStatus = 'FULFILLED' where id = ${orderId(1)}`;
          const started = yield* repository.beginSync({ workflowId: "wf-1", now: NOW + 1 });
          assert.strictEqual(started._tag, "Started");
          assert.strictEqual((yield* usage(repository, sql)).ordersLimitedAt, null);
        }),
      ),
  );
});

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { fixture } from "../../../../fixture.ts";
import { fixtureRows } from "../../../../src/backend/fixture.ts";
import { insertFixtureRows } from "../../../../src/backend/shop-actor.ts";
import type { OrderRepository } from "../../../../src/backend/shop-actor/order-repository.ts";
import type { OrderLineItem, ShopOrder } from "../../../../src/domain/orders.ts";
import { ShopLimits } from "../../../../src/domain/platform.ts";
import { ActorSqliteTest, testOrderRepository } from "../layers.ts";

/**
 * The actor's orders repository over a fresh in-memory SQLite migrated by the actor's own
 * schema: legacy `order-repository.test.ts`'s cases, titles and describe names unchanged.
 */

/** `body` with the repository and its client, on a fresh database. */
const runInRepository = <A, E>(
  body: (repository: OrderRepository, sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* testOrderRepository, yield* SqlClient.SqlClient);
  }).pipe(Effect.provide(ActorSqliteTest));

const orderId = (n: number) => `gid://shopify/Order/${String(n)}`;
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
 * The `ShopUsage` columns the orders write, and the open-order count, read straight from SQL
 * rather than through a repository method: billing's `getUsage` is not ported.
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
        const again = yield* upsert(repository, anOrder({ updatedAt: 2000, name: "#TIE" }), [
          aLineItem(2),
        ]);
        assert.strictEqual(again.written, true);
        const { order, lineItems } = Option.getOrThrow(yield* repository.getOrder(orderId(1)));
        assert.strictEqual(order.name, "#TIE");
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
  it.effect("a sync rewrites every column but countedAt", () =>
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
          legacyId: changed.legacyId,
          name: changed.name,
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
        const page = yield* repository.listOrders({ limit: actor.orders.length, cursor: null });
        const listed = page.orders.map(({ order }) => order);
        assert.strictEqual(listed.length, actor.orders.length);
        assert.strictEqual(page.nextCursor, null);
        assert.strictEqual(
          page.orders.flatMap(({ lineItems }) => lineItems).length,
          actor.lineItems.length,
        );
        assert.isTrue(listed.some(({ cancelledAt }) => cancelledAt !== null));
        assert.isTrue(listed.some(({ fullyPaid }) => !fullyPaid));

        const [newest] = page.orders;
        assert.isDefined(newest);
        if (newest === undefined) return;
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

const CYCLE_START = 400 * 86_400_000;

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

describe("OrderRepository usage", () => {
  /**
   * Legacy lowered `ShopLimits.maxOpenOrders` to 2 for this case; here the ceiling keeps its value
   * and all but two of it are stored as open orders first, so the case's own two orders reach it.
   * Billing's `ordersThisCycle` asserts are not ported.
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
      lineItemProperties, state, createdAt, updatedAt
    ) values (
      ${`run-${id}-${state}`}, 'wf', 'Workflow', ${id}, '#1',
      0, ${`li-${id}`}, 'Item', null, null, 1, '[]',
      ${state}, ${updatedAt}, ${updatedAt}
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

describe("OrderRepository.listOrders", () => {
  it.effect("pages newest first through a keyset cursor", () =>
    runInRepository((repository) =>
      Effect.gen(function* () {
        // Two orders in one millisecond: the id breaks the tie, newest id first.
        yield* upsert(repository, anOrder({ id: orderId(1), processedAt: 1000 }), [aLineItem(1)]);
        yield* upsert(repository, anOrder({ id: orderId(2), processedAt: 2000 }), []);
        yield* upsert(repository, anOrder({ id: orderId(3), processedAt: 2000 }), []);
        const first = yield* repository.listOrders({ limit: 2, cursor: null });
        assert.deepStrictEqual(
          first.orders.map(({ order }) => order.id),
          [orderId(3), orderId(2)],
        );
        assert.strictEqual(first.nextCursor, `2000:${orderId(2)}`);
        const second = yield* repository.listOrders({ limit: 2, cursor: first.nextCursor });
        assert.deepStrictEqual(
          second.orders.map(({ order, lineItems }) => [order.id, lineItems.map(({ id }) => id)]),
          [[orderId(1), [lineItemId(1)]]],
        );
        assert.strictEqual(second.nextCursor, null);
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

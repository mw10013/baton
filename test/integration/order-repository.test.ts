import { SqliteClient } from "@effect/sql-sqlite-do";
import {
  assertNone,
  assertSome,
  deepStrictEqual,
  strictEqual,
} from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgent";
import {
  ShopifyAppEvents,
  ShopifyAppEventsError,
} from "@/lib/ShopifyAppEvents";

const runInRepository = <A, E>(
  program: Effect.Effect<A, E, OrderRepository | SqlClient.SqlClient>,
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
            Layer.provideMerge(
              OrderRepository.layer,
              SqliteClient.layer({ storage: state.storage }),
            ),
          ),
        ),
      ),
  );

const orderId = (n: number) => `gid://shopify/Order/${String(n)}`;
const names = (page: Domain.OrdersPage) =>
  page.orders.map(({ order }) => order.name);
const lineItemId = (n: number) => `gid://shopify/LineItem/${String(n)}`;
const aTeamId = (value: string) =>
  Schema.decodeUnknownSync(Domain.TeamId)(value);
const rowOf = (page: Domain.OrdersPage, name: string) =>
  page.orders.find((row) => row.order.name === name);
const waitingOf = (page: Domain.OrdersPage, name: string) =>
  rowOf(page, name)?.waitingOn;

const anOrder = (
  overrides: Partial<Domain.ShopOrder> = {},
): Domain.ShopOrder => ({
  id: orderId(1),
  legacyId: "1",
  name: "#1001",
  processedAt: 1000,
  updatedAt: 1000,
  cancelledAt: null,
  closedAt: null,
  financialStatus: "PENDING",
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: false,
  note: null,
  customAttributes: [{ key: "gift", value: "yes" }],
  lineItemsTruncated: false,
  syncedAt: 1000,
  syncSource: "bulk",
  ...overrides,
});

const aLineItem = (
  n: number,
  overrides: Partial<Domain.OrderLineItem> = {},
): Domain.OrderLineItem => ({
  id: lineItemId(n),
  orderId: orderId(1),
  productId: `gid://shopify/Product/${String(n)}`,
  variantId: null,
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: `SKU-${String(n)}`,
  quantity: 1,
  currentQuantity: 1,
  unfulfilledQuantity: 1,
  nonFulfillableQuantity: 0,
  productTags: ["engraved"],
  matchedWorkflowIds: [],
  customAttributes: [{ key: "text", value: "Hello" }],
  requiresShipping: true,
  ...overrides,
});

const upsert = (
  repository: typeof OrderRepository.Service,
  order: Domain.ShopOrder,
  lineItems: readonly Domain.OrderLineItem[],
) => repository.upsertOrder({ order, lineItems });

/**
 * The outbox as rows, read straight from SQL rather than through a repository
 * method: what these cases assert is that the *right* events were queued, and a
 * reader written for the assertion could agree with a broken writer.
 */
const usageEvents = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`select idempotencyKey, value from UsageEvent order by rowid`
        .values;
    return rows.map((row) => ({
      idempotencyKey: String(row[0]),
      value: Number(row[1]),
    }));
  });

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

/** Drains the outbox so a later assertion is about what happened *after* it. */
const flushed = () =>
  Effect.gen(function* () {
    return yield* (yield* OrderRepository).flushUsageEvents(
      "shop.myshopify.com",
    );
  }).pipe(Effect.provide(acceptingAppEvents));

describe("OrderRepository.upsertOrder", () => {
  it("stores an order with its line items", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.name, "#1001");
    strictEqual(order.fullyPaid, false);
    strictEqual(lineItems.length, 2);
    strictEqual(lineItems[0]?.productTags[0], "engraved");
    strictEqual(order.customAttributes[0]?.value, "yes");
  });

  /**
   * The guard that lets a retried webhook, a mid-stream bulk line, and a manual
   * resync all write the same row in any order.
   */
  it("leaves the row and its line items alone for an older updatedAt", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder({ updatedAt: 2000 }), [aLineItem(1)]);
        const stale = yield* upsert(
          repository,
          anOrder({ updatedAt: 1000, name: "#STALE" }),
          [aLineItem(9)],
        );
        strictEqual(stale.written, false);
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.name, "#1001");
    strictEqual(lineItems.length, 1);
    strictEqual(lineItems[0]?.id, lineItemId(1));
  });

  it("replaces the line-item set on every accepted write", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        yield* upsert(repository, anOrder({ updatedAt: 3000 }), [aLineItem(2)]);
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { lineItems } = Option.getOrThrow(detail);
    strictEqual(lineItems.length, 1);
    strictEqual(lineItems[0]?.id, lineItemId(2));
  });

  /**
   * The guard is `>=`, not `>`: both timestamps are Shopify's own version of
   * the order, so an equal one is the same version and rewriting it is free.
   * Refusing a tie would instead drop a redelivery of a write that failed
   * halfway through its line items.
   */
  it("accepts an equal updatedAt and rewrites the row", async () => {
    const { written, detail } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder({ updatedAt: 2000 }), [aLineItem(1)]);
        const again = yield* upsert(
          repository,
          anOrder({ updatedAt: 2000, name: "#TIE" }),
          [aLineItem(2)],
        );
        return {
          written: again.written,
          detail: yield* repository.getOrder(orderId(1)),
        };
      }),
    );
    strictEqual(written, true);
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.name, "#TIE");
    strictEqual(lineItems.length, 1);
    strictEqual(lineItems[0]?.id, lineItemId(2));
  });

  it("deletes the order and its line items together", async () => {
    const [detail, updatedAt] = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1)]);
        yield* repository.deleteOrder({ orderId: orderId(1), now: 0 });
        return [
          yield* repository.getOrder(orderId(1)),
          yield* repository.getOrderUpdatedAt(orderId(1)),
        ] as const;
      }),
    );
    assertNone(detail);
    assertNone(updatedAt);
  });
});

describe("OrderRepository.listOrders", () => {
  it("pages newest first through a keyset cursor", async () => {
    const { first, second } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
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
        const first = yield* repository.listOrders({
          limit: 2,
          cursor: null,
          q: null,
          state: null,
          paid: null,
          attention: false,
          team: null,
          teams: [],
        });
        return {
          first,
          second: yield* repository.listOrders({
            limit: 2,
            cursor: first.nextCursor,
            q: null,
            state: null,
            paid: null,
            attention: false,
            team: null,
            teams: [],
          }),
        };
      }),
    );
    strictEqual(first.orders.length, 2);
    strictEqual(first.orders[0]?.order.name, "#1003");
    strictEqual(first.orders[1]?.order.name, "#1002");
    strictEqual(first.orders[0]?.itemUnits, 1);
    strictEqual(first.orders[0]?.runs.open, 0);
    strictEqual(second.orders.length, 1);
    strictEqual(second.orders[0]?.order.name, "#1001");
    strictEqual(second.nextCursor, null);
  });
});

/**
 * Every SQL fragment against `Domain.productionState`: the fixture covers
 * each branch, and each filter must return exactly the names the TypeScript
 * function assigns that state. Runs are written directly because
 * `WorkflowRunRepository` is not in this test's layer and the filters only
 * read status. `#1009` is unpaid with no runs: the `null` state, in no
 * stage and no count.
 *
 * `#1012` and `#1013` are the ambiguity cases, written with
 * `matchedWorkflowIds` directly because reconcile is the only writer of that
 * column and this test has no `WorkflowRunRepository`. `#1013` is the
 * precedence case: an open run *and* an item still waiting on a choice,
 * which `Domain.productionState` reads as `multiple_workflows` rather than
 * `in_production`. Between them
 * they are also the proof that `json_array_length` exists in Durable Object
 * SQLite — every `AMBIGUOUS_ITEM` fragment would throw without it.
 */
const seedStates = Effect.gen(function* () {
  const repository = yield* OrderRepository;
  const sql = yield* SqlClient.SqlClient;
  const cases: readonly {
    readonly n: number;
    readonly order?: Partial<Domain.ShopOrder>;
    readonly statuses: readonly Domain.RunStatus[];
    /** Written onto the order's own line item; two or more with no live run on it is ambiguous. */
    readonly matched?: readonly string[];
  }[] = [
    { n: 1, statuses: ["done"] }, // ready
    { n: 2, statuses: ["done", "cancelled"] }, // ready
    { n: 3, statuses: ["done", "active"] }, // in production
    { n: 4, statuses: ["done", "pending"] }, // in production
    { n: 5, statuses: [] }, // no workflow
    { n: 6, order: { cancelledAt: 5 }, statuses: ["done"] }, // cancelled
    { n: 7, order: { fulfillmentStatus: "FULFILLED" }, statuses: ["done"] }, // shipped
    { n: 8, statuses: ["done", "done"] }, // ready
    { n: 9, order: { fullyPaid: false }, statuses: [] }, // null: unpaid, nothing to say
    { n: 10, statuses: ["cancelled"] }, // no workflow: a cancelled run is no run
    { n: 11, order: { fulfillmentStatus: "FULFILLED" }, statuses: [] }, // shipped, never started
    { n: 12, statuses: [], matched: ["w1", "w2"] }, // choose a workflow
    { n: 13, statuses: ["active"], matched: ["w1", "w2"] }, // choose a workflow, and one item in production
    // Unpaid: the ambiguity is not a choice yet, so the manual run's stage wins.
    {
      n: 14,
      order: { fullyPaid: false },
      statuses: ["active"],
      matched: ["w1", "w2"],
    }, // in production
  ];
  for (const { n, order, statuses, matched } of cases) {
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
          ...(matched === undefined
            ? {}
            : {
                matchedWorkflowIds: matched.map((id) =>
                  Schema.decodeUnknownSync(Domain.WorkflowId)(id),
                ),
              }),
        }),
      ],
    );
    for (const [index, status] of statuses.entries())
      yield* sql`
        insert into WorkflowRun (
          id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
          lineItemId, lineItemTitle, variantTitle, sku, quantity, customAttributes,
          source, status, flag, flagAt, flagDetail, createdAt, updatedAt,
          cancelledAt
        ) values (
          ${`run-${String(n)}-${String(index)}`}, 'wf', 'Workflow',
          ${orderId(n)}, ${`#10${String(n).padStart(2, "0")}`}, 0,
          ${`${lineItemId(n)}-${String(index)}`}, 'Item', null, null, 1,
          '[]', 'tag', ${status}, null, null, null, 0, 0, null
        )
      `;
  }
  return repository;
});

describe("OrderRepository.listOrders filters", () => {
  it("each state returns exactly the orders productionState gives that state", async () => {
    const pages = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const list = (state: Domain.OrdersFilterState | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            state,
            paid: null,
            attention: false,
            team: null,
            teams: [],
          });
        return {
          open: yield* list(null),
          all: yield* list("all"),
          no_workflow: yield* list("no_workflow"),
          multiple_workflows: yield* list("multiple_workflows"),
          in_production: yield* list("in_production"),
          ready_to_ship: yield* list("ready_to_ship"),
          shipped: yield* list("shipped"),
          cancelled: yield* list("cancelled"),
        };
      }),
    );
    strictEqual(pages.all.orders.length, 14);
    deepStrictEqual(names(pages.no_workflow), ["#1010", "#1005"]);
    deepStrictEqual(names(pages.multiple_workflows), ["#1013", "#1012"]);
    deepStrictEqual(names(pages.in_production), ["#1014", "#1004", "#1003"]);
    deepStrictEqual(names(pages.ready_to_ship), ["#1008", "#1002", "#1001"]);
    deepStrictEqual(names(pages.shipped), ["#1011", "#1007"]);
    deepStrictEqual(names(pages.cancelled), ["#1006"]);
    // The SQL and the TypeScript agree row by row.
    for (const row of pages.all.orders) {
      const state = Domain.productionState(row);
      const inList =
        state === null ? false : names(pages[state]).includes(row.order.name);
      strictEqual(
        inList,
        state !== null,
        `${row.order.name} as ${String(state)}`,
      );
    }
  });

  /**
   * Retention keeps a year of orders, so the list a merchant opens is the
   * bench, not the year; `"all"` is the only way to the closed ones
   * (`Domain.OrdersFilterState`).
   */
  it("lists open orders by default and everything under all", async () => {
    const { open, all } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const list = (state: Domain.OrdersFilterState | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            state,
            paid: null,
            attention: false,
            team: null,
            teams: [],
          });
        return { open: yield* list(null), all: yield* list("all") };
      }),
    );
    const closed = ["#1011", "#1007", "#1006"];
    strictEqual(all.orders.length, 14);
    strictEqual(open.orders.length, 14 - closed.length);
    for (const name of closed) strictEqual(names(open).includes(name), false);
    // Every open stage is still in the default view, and nothing else is.
    for (const row of open.orders)
      strictEqual(
        Domain.productionState(row) !== "shipped" &&
          Domain.productionState(row) !== "cancelled",
        true,
        row.order.name,
      );
  });

  it("counts the open stages once, independent of the page's filters", async () => {
    const { ready, unpaid } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        return {
          ready: yield* repository.listOrders({
            limit: 2,
            cursor: null,
            q: null,
            state: "ready_to_ship",
            paid: null,
            attention: false,
            team: null,
            teams: [],
          }),
          unpaid: yield* repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            state: null,
            paid: false,
            attention: false,
            team: null,
            teams: [],
          }),
        };
      }),
    );
    // `#1012` is excluded from `no_workflow` and `#1013` from
    // `in_production`: the ambiguity outranks both, so the chips partition
    // the open orders exactly as the lists do. `#1014` is unpaid, so its
    // ambiguity is not a choice yet and its active run counts it in production.
    const expected = {
      no_workflow: 2,
      multiple_workflows: 2,
      in_production: 3,
      ready_to_ship: 3,
      attention: 0,
    };
    deepStrictEqual(ready.openCounts, expected);
    deepStrictEqual(unpaid.openCounts, expected);
  });

  it("paid crosses with state and pages under it", async () => {
    const { paid, unpaid, second } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const paid = yield* repository.listOrders({
          limit: 2,
          cursor: null,
          q: null,
          state: "ready_to_ship",
          paid: true,
          attention: false,
          team: null,
          teams: [],
        });
        return {
          paid,
          second: yield* repository.listOrders({
            limit: 2,
            cursor: paid.nextCursor,
            q: null,
            state: "ready_to_ship",
            paid: true,
            attention: false,
            team: null,
            teams: [],
          }),
          unpaid: yield* repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            state: null,
            paid: false,
            attention: false,
            team: null,
            teams: [],
          }),
        };
      }),
    );
    deepStrictEqual(names(paid), ["#1008", "#1002"]);
    deepStrictEqual(names(second), ["#1001"]);
    strictEqual(second.nextCursor, null);
    deepStrictEqual(names(unpaid), ["#1014", "#1009"]);
  });
  /**
   * `RunCounts.blocked` and `RunCounts.flagged` are the two alarms the index
   * badge splits, and the split lives in SQL: one counter per `WorkflowRun`
   * flag value, both restricted to open runs so a done run's stale flag
   * counts in neither.
   */
  it("splits the worker's block from a reconcile flag, and ignores a done run's flag", async () => {
    const { all } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const sql = yield* SqlClient.SqlClient;
        const flag = (runId: string, value: Domain.RunFlag) =>
          sql`update WorkflowRun set flag = ${value}, flagAt = 1 where id = ${runId}`;
        yield* flag("run-3-1", "blocked");
        yield* flag("run-4-1", "item_removed");
        yield* flag("run-1-0", "order_fulfilled");
        return {
          all: yield* repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            state: null,
            paid: null,
            attention: false,
            team: null,
            teams: [],
          }),
        };
      }),
    );
    const runsOf = (name: string) =>
      all.orders.find((row) => row.order.name === name)?.runs;
    deepStrictEqual(runsOf("#1003"), {
      open: 1,
      done: 1,
      flagged: 0,
      blocked: 1,
    });
    deepStrictEqual(runsOf("#1004"), {
      open: 1,
      done: 1,
      flagged: 1,
      blocked: 0,
    });
    deepStrictEqual(runsOf("#1001"), {
      open: 0,
      done: 1,
      flagged: 0,
      blocked: 0,
    });
  });
});

/**
 * `Domain.ListOrdersInput.q`: a prefix match on `ShopOrder.name` after
 * `normaliseOrderSearch`, so the `#` is the merchant's to type or omit, and
 * `like`'s own metacharacters are escaped rather than honoured.
 */
describe("OrderRepository.listOrders q", () => {
  const seedNames = Effect.gen(function* () {
    const repository = yield* OrderRepository;
    for (const [n, name] of [
      [1, "#1001"],
      [2, "#1002"],
      [3, "#2100"],
    ] as const)
      yield* upsert(
        repository,
        anOrder({
          id: orderId(n),
          legacyId: String(n),
          name,
          processedAt: n * 1000,
        }),
        [aLineItem(n, { orderId: orderId(n) })],
      );
    return repository;
  });

  const search = (q: string) =>
    Effect.gen(function* () {
      const repository = yield* seedNames;
      return yield* repository.listOrders({
        limit: 20,
        cursor: null,
        q: Schema.decodeUnknownSync(Domain.OrderSearch)(q),
        state: null,
        paid: null,
        attention: false,
        team: null,
        teams: [],
      });
    });

  it("matches the full number with or without the #", async () => {
    deepStrictEqual(names(await runInRepository(search("1001"))), ["#1001"]);
    deepStrictEqual(names(await runInRepository(search("#1001"))), ["#1001"]);
    deepStrictEqual(names(await runInRepository(search("  1001  "))), [
      "#1001",
    ]);
  });

  it("is a prefix, so #10 takes #1001 and #1002 but not #2100", async () => {
    deepStrictEqual(names(await runInRepository(search("#10"))), [
      "#1002",
      "#1001",
    ]);
  });

  it("escapes like's own wildcards rather than honouring them", async () => {
    deepStrictEqual(names(await runInRepository(search("%"))), []);
    deepStrictEqual(names(await runInRepository(search("100_"))), []);
  });

  it("leaves the open-stage counts alone, as the other filters do", async () => {
    const { all, searched } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedNames;
        const list = (q: Domain.OrderSearch | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q,
            state: null,
            paid: null,
            attention: false,
            team: null,
            teams: [],
          });
        return {
          all: yield* list(null),
          searched: yield* list(
            Schema.decodeUnknownSync(Domain.OrderSearch)("1001"),
          ),
        };
      }),
    );
    deepStrictEqual(searched.openCounts, all.openCounts);
  });
});

describe("OrderRepository.listOrders attention", () => {
  /**
   * `Domain.OrderRow.attention` against a roster the test hands in: #3's
   * active run has an open step on a deleted team, #4's pending run has a
   * ready step on an empty team, #1's finished run keeps a stale pointer on
   * a completed step and never counts, and #8 is healthy.
   */
  it("keeps only orders with an unassigned or unstaffed open step, and counts them", async () => {
    const teams = Schema.decodeUnknownSync(Schema.Array(Domain.TeamRoster))([
      { id: "team-cut", name: "Cut", memberCount: 1 },
      { id: "team-empty", name: "Polish", memberCount: 0 },
    ]);
    const { all, only } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const sql = yield* SqlClient.SqlClient;
        const step = (
          id: string,
          runId: string,
          stage: number,
          teamId: string | null,
          completedAt: number | null,
        ) => sql`
          insert into WorkflowRunStep
            (id, runId, position, stage, name, teamId, teamName, completedAt)
          values (${id}, ${runId}, ${stage}, ${stage}, 'Step', ${teamId}, 'Team', ${completedAt})
        `;
        yield* step("s3", "run-3-1", 1, "team-gone", null);
        yield* step("s4a", "run-4-1", 1, "team-cut", 1);
        yield* step("s4b", "run-4-1", 2, "team-empty", null);
        yield* step("s1", "run-1-0", 1, "team-gone", 1);
        yield* step("s8", "run-8-0", 1, "team-cut", 1);
        const list = (attention: boolean) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            state: null,
            paid: null,
            attention,
            team: null,
            teams,
          });
        return { all: yield* list(false), only: yield* list(true) };
      }),
    );
    deepStrictEqual(
      all.orders.filter((row) => row.attention).map((row) => row.order.name),
      ["#1004", "#1003"],
    );
    deepStrictEqual(names(only), ["#1004", "#1003"]);
    strictEqual(all.openCounts.attention, 2);
    strictEqual(only.openCounts.attention, 2);
  });
});

/**
 * `Domain.OrderRow.waitingOn`: the teams with a ready step on an open run,
 * through the same `readyWhere` the worker queue runs on, so the cell and the
 * filter are one fact rendered two ways. The fixture reuses `seedStates`'
 * runs and hangs steps off them; on #1003 and #1004, `run-N-0` is done and
 * `run-N-1` is open.
 */
describe("OrderRepository.listOrders waitingOn", () => {
  /** Ids ascend cut → pack → polish while names ascend Anodize → Cut → Pack, so the two orders disagree. */
  const teams = Schema.decodeUnknownSync(Schema.Array(Domain.TeamRoster))([
    { id: "team-cut", name: "Cut", memberCount: 1 },
    { id: "team-polish", name: "Anodize", memberCount: 1 },
    { id: "team-pack", name: "Pack", memberCount: 1 },
  ]);

  const waitingFixture = Effect.gen(function* () {
    const repository = yield* seedStates;
    const sql = yield* SqlClient.SqlClient;
    /* `position` is unique per run and only orders a queue, so it comes off a
       counter; `stage` is what readiness is about and every case names it. */
    let position = 0;
    const step = (
      id: string,
      runId: string,
      stage: number,
      team: string,
      completedAt: number | null = null,
    ) => {
      position += 1;
      return sql`
        insert into WorkflowRunStep
          (id, runId, position, stage, name, teamId, teamName, completedAt)
        values (${id}, ${runId}, ${position}, ${stage}, 'Step', ${team}, 'Team', ${completedAt})
      `;
    };
    /* #1003: two open item runs both ready on Cut, so the id is distinct
       across runs; the done run's step is on Cut too, and a run that is over
       holds nobody up. */
    yield* sql`
      insert into WorkflowRun (
        id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
        lineItemId, lineItemTitle, variantTitle, sku, quantity, customAttributes,
        source, status, flag, flagAt, flagDetail, createdAt, updatedAt,
        cancelledAt
      ) values (
        'run-3-2', 'wf', 'Workflow', ${orderId(3)}, '#1003', 0,
        ${`${lineItemId(3)}-2`}, 'Item', null, null, 1, '[]', 'tag', 'active',
        null, null, null, 0, 0, null
      )
    `;
    yield* step("s3a", "run-3-1", 1, "team-cut");
    yield* step("s3b", "run-3-0", 1, "team-cut");
    yield* step("s3e", "run-3-2", 1, "team-cut");
    /* #1004: ready on Cut, with a later stage on Anodize that is not ready.
       Anodize sorts first by name, so it would show if it counted. */
    yield* step("s4a", "run-4-1", 1, "team-cut");
    yield* step("s4b", "run-4-1", 2, "team-polish");
    const list = (team: Domain.TeamId | null = null) =>
      repository.listOrders({
        limit: 20,
        cursor: null,
        q: null,
        state: null,
        paid: null,
        attention: false,
        team,
        teams,
      });
    return { sql, step, list };
  });

  it("names each team once, only for ready steps on open runs", async () => {
    const page = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* waitingFixture;
        return yield* list();
      }),
    );
    deepStrictEqual(waitingOf(page, "#1003"), [aTeamId("team-cut")]);
    deepStrictEqual(waitingOf(page, "#1004"), [aTeamId("team-cut")]);
    // Every run done: nobody is holding it.
    deepStrictEqual(waitingOf(page, "#1001"), []);
  });

  /**
   * A blocked run's ready step still satisfies `readyWhere` (the queue keeps
   * showing it), but the team cannot move it, so the cell and the filter both
   * leave the team out; `RunCounts.blocked` is where that run is counted.
   */
  it("leaves out a blocked run, which is counted as blocked instead", async () => {
    const { page, filtered } = await runInRepository(
      Effect.gen(function* () {
        const { sql, list } = yield* waitingFixture;
        yield* sql`update WorkflowRun set flag = 'blocked', flagAt = 1 where id = 'run-4-1'`;
        return {
          page: yield* list(),
          filtered: yield* list(aTeamId("team-cut")),
        };
      }),
    );
    deepStrictEqual(waitingOf(page, "#1004"), []);
    deepStrictEqual(waitingOf(page, "#1003"), [aTeamId("team-cut")]);
    strictEqual(rowOf(filtered, "#1004"), undefined);
    strictEqual(rowOf(filtered, "#1003")?.order.name, "#1003");
  });

  it("leaves out a team that has left the roster, which is attention instead", async () => {
    const page = await runInRepository(
      Effect.gen(function* () {
        const { sql, list } = yield* waitingFixture;
        yield* sql`update WorkflowRunStep set teamId = 'team-gone' where id in ('s3a', 's3e')`;
        return yield* list();
      }),
    );
    deepStrictEqual(waitingOf(page, "#1003"), []);
    strictEqual(rowOf(page, "#1003")?.attention, true);
  });

  /**
   * The filter is the column's membership test as a `where`, so the filtered
   * page is exactly the rows whose cell names the team — and the stage strip
   * stays independent of it, the way it is independent of `paid`.
   */
  it("keeps exactly the rows waiting on that team, and leaves the counts alone", async () => {
    const { all, cut, polish, unknown } = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* waitingFixture;
        return {
          all: yield* list(),
          cut: yield* list(aTeamId("team-cut")),
          /* Anodize owns #1004's second stage, which is not ready yet. */
          polish: yield* list(aTeamId("team-polish")),
          unknown: yield* list(aTeamId("team-nobody")),
        };
      }),
    );
    deepStrictEqual(
      all.orders
        .filter((row) => row.waitingOn.includes(aTeamId("team-cut")))
        .map((row) => row.order.name),
      names(cut),
    );
    deepStrictEqual(names(cut), ["#1004", "#1003"]);
    deepStrictEqual(names(polish), []);
    deepStrictEqual(names(unknown), []);
    deepStrictEqual(cut.openCounts, all.openCounts);
    deepStrictEqual(unknown.openCounts, all.openCounts);
  });

  it("sorts by team name, not by id", async () => {
    const page = await runInRepository(
      Effect.gen(function* () {
        const { step, list } = yield* waitingFixture;
        yield* step("s3c", "run-3-1", 1, "team-pack");
        yield* step("s3d", "run-3-1", 1, "team-polish");
        return yield* list();
      }),
    );
    deepStrictEqual(waitingOf(page, "#1003"), [
      aTeamId("team-polish"),
      aTeamId("team-cut"),
      aTeamId("team-pack"),
    ]);
  });
});

describe("OrderRepository.recordWebhookDelivery", () => {
  it("reports the first delivery as new and a redelivery as seen", async () => {
    const [first, second] = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const delivery = {
          webhookId: "wh-1",
          topic: "orders/updated",
          orderId: orderId(1),
          triggeredAt: 10,
          receivedAt: 11,
        };
        return [
          yield* repository.recordWebhookDelivery(delivery),
          yield* repository.recordWebhookDelivery(delivery),
        ] as const;
      }),
    );
    strictEqual(first, true);
    strictEqual(second, false);
  });

  it("sweeps deliveries past the retention window and keeps the new one", async () => {
    const remaining = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = 30 * 86_400_000;
        yield* repository.recordWebhookDelivery({
          webhookId: "wh-old",
          topic: "orders/updated",
          orderId: orderId(1),
          triggeredAt: 0,
          receivedAt:
            now -
            (Domain.ShopLimits.webhookDeliveryRetentionDays + 1) * 86_400_000,
        });
        yield* repository.recordWebhookDelivery({
          webhookId: "wh-new",
          topic: "orders/updated",
          orderId: orderId(1),
          triggeredAt: now,
          receivedAt: now,
        });
        const rows = yield* sql`select webhookId from WebhookDelivery`.values;
        return rows.map((row) => String(row[0]));
      }),
    );
    deepStrictEqual(remaining, ["wh-new"]);
  });
});

describe("OrderRepository usage", () => {
  /** Mid-month, so `processedAt: CYCLE_START - 1` is unambiguously the period before. */
  const CYCLE_START = Date.UTC(2026, 5, 15);
  const CYCLE_END = Date.UTC(2026, 6, 15);
  const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
    "gid://shopify/Shop/1",
  );

  const paid = (n: number, overrides: Partial<Domain.ShopOrder> = {}) =>
    anOrder({
      id: orderId(n),
      name: `#100${String(n)}`,
      fullyPaid: true,
      financialStatus: "PAID",
      processedAt: CYCLE_START,
      updatedAt: CYCLE_START,
      syncedAt: CYCLE_START,
      ...overrides,
    });

  const openCycle = (repository: typeof OrderRepository.Service) =>
    repository.setBillingCycle({
      shopGid,
      cycleStartAt: CYCLE_START,
      cycleEndAt: CYCLE_END,
    });

  it("counts an order against the pushed billing cycle", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(2), []);
        // Placed before the period began: the backfill an install pulls in.
        yield* upsert(
          repository,
          paid(3, { processedAt: CYCLE_START - 1 }),
          [],
        );
        // Unpaid, and cancelled on arrival: neither is work the meter bills.
        yield* upsert(repository, paid(4, { fullyPaid: false }), []);
        yield* upsert(repository, paid(5, { cancelledAt: CYCLE_START }), []);
        return yield* repository.getUsage();
      }),
    );
    strictEqual(usage.ordersThisCycle, 2);
    strictEqual(usage.cycleStartAt, CYCLE_START);
    strictEqual(usage.cycleEndAt, CYCLE_END);
  });

  it("opens a provisional cycle before a billing period is known", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, paid(1), []);
        return yield* repository.getUsage();
      }),
    );
    strictEqual(usage.ordersThisCycle, 1);
    strictEqual(usage.cycleStartAt, Date.UTC(2026, 5, 1));
    strictEqual(usage.cycleEndAt, null);
  });

  it("rolls the cycle forward on the first order past its end", async () => {
    const { before, after } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        const before = yield* repository.getUsage();
        yield* upsert(
          repository,
          paid(2, {
            processedAt: CYCLE_END,
            updatedAt: CYCLE_END,
            syncedAt: CYCLE_END,
          }),
          [],
        );
        return { before, after: yield* repository.getUsage() };
      }),
    );
    strictEqual(before.ordersThisCycle, 1);
    strictEqual(after.ordersThisCycle, 1);
    strictEqual(after.cycleStartAt, CYCLE_END);
    strictEqual(after.cycleEndAt, null);
  });

  it("recounts the cycle from the orders when a new period is pushed", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(2), []);
        // The next period: the two above fall outside it and drop out.
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
        });
        return yield* repository.getUsage();
      }),
    );
    strictEqual(usage.ordersThisCycle, 0);
  });

  it("counting an order queues one usage event", async () => {
    const events = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        return yield* usageEvents();
      }),
    );
    deepStrictEqual(events, [
      { idempotencyKey: `${orderId(1)}#count`, value: 1 },
    ]);
  });

  it("a seeded order counts locally but queues no billing event", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(
          repository,
          paid(1, { id: `${Domain.SEED_ORDER_ID_PREFIX}1` }),
          [],
        );
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 1);
    deepStrictEqual(events, []);
  });

  it("a re-sync never queues a second count", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(1, { updatedAt: CYCLE_START + 1 }), []);
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 1);
    strictEqual(events.length, 1);
  });

  it("cancelling a counted order inside the cycle queues a reversal and gives the count back", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(
          repository,
          paid(1, {
            updatedAt: CYCLE_START + 1,
            syncedAt: CYCLE_START + 1,
            cancelledAt: CYCLE_START + 1,
          }),
          [],
        );
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 0);
    deepStrictEqual(events, [
      { idempotencyKey: `${orderId(1)}#count`, value: 1 },
      { idempotencyKey: `${orderId(1)}#reverse`, value: -1 },
    ]);
  });

  it("cancelling in a later cycle queues nothing", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* flushed();
        // The next period opens; the cancellation lands inside it, where
        // Shopify has closed the period the order was billed in.
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
        });
        yield* upsert(
          repository,
          paid(1, {
            updatedAt: CYCLE_END + 1,
            syncedAt: CYCLE_END + 1,
            cancelledAt: CYCLE_END + 1,
          }),
          [],
        );
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 0);
    deepStrictEqual(events, []);
  });

  it("an order that arrives unpaid and is paid later counts in the payment's cycle", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        // Placed and stored in this period, unpaid: a deposit, a trade
        // account, COD. The work is carried before the money arrives.
        yield* upsert(repository, paid(1, { fullyPaid: false }), []);
        const unpaid = yield* repository.getUsage();
        // The next period opens; the payment lands inside it.
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
        });
        yield* upsert(
          repository,
          paid(1, { updatedAt: CYCLE_END + 1, syncedAt: CYCLE_END + 1 }),
          [],
        );
        // A further update of the paid order is not a second payment.
        yield* upsert(
          repository,
          paid(1, { updatedAt: CYCLE_END + 2, syncedAt: CYCLE_END + 2 }),
          [],
        );
        return {
          unpaid: unpaid.ordersThisCycle,
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }).pipe(
        Effect.map(({ unpaid, usage, events }) => {
          strictEqual(unpaid, 0);
          return { usage, events };
        }),
      ),
    );
    strictEqual(usage.ordersThisCycle, 1);
    strictEqual(usage.cycleStartAt, CYCLE_END);
    deepStrictEqual(events, [
      { idempotencyKey: `${orderId(1)}#count`, value: 1 },
    ]);
  });

  it("a backfilled order paid after install does not count", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        // Placed before the period the install stored it in; paid now.
        yield* upsert(
          repository,
          paid(1, { processedAt: CYCLE_START - 1, fullyPaid: false }),
          [],
        );
        yield* upsert(
          repository,
          paid(1, {
            processedAt: CYCLE_START - 1,
            updatedAt: CYCLE_START + 1,
            syncedAt: CYCLE_START + 1,
          }),
          [],
        );
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 0);
    deepStrictEqual(events, []);
  });

  it("a reversed order paid again does not bill twice", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(
          repository,
          paid(1, {
            updatedAt: CYCLE_START + 1,
            syncedAt: CYCLE_START + 1,
            cancelledAt: CYCLE_START + 1,
            fullyPaid: false,
          }),
          [],
        );
        yield* upsert(
          repository,
          paid(1, {
            updatedAt: CYCLE_START + 2,
            syncedAt: CYCLE_START + 2,
            cancelledAt: CYCLE_START + 1,
          }),
          [],
        );
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 0);
    deepStrictEqual(events, [
      { idempotencyKey: `${orderId(1)}#count`, value: 1 },
      { idempotencyKey: `${orderId(1)}#reverse`, value: -1 },
    ]);
  });

  it("deleting a counted order inside the cycle reverses it, and in a later cycle does not", async () => {
    const { inside, later } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(2), []);
        yield* repository.deleteOrder({
          orderId: orderId(1),
          now: CYCLE_START + 1,
        });
        const inside = {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
        yield* flushed();
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
        });
        yield* repository.deleteOrder({
          orderId: orderId(2),
          now: CYCLE_END + 1,
        });
        return {
          inside,
          later: {
            usage: yield* repository.getUsage(),
            events: yield* usageEvents(),
          },
        };
      }),
    );
    strictEqual(inside.usage.ordersThisCycle, 1);
    deepStrictEqual(inside.events, [
      { idempotencyKey: `${orderId(1)}#count`, value: 1 },
      { idempotencyKey: `${orderId(2)}#count`, value: 1 },
      { idempotencyKey: `${orderId(1)}#reverse`, value: -1 },
    ]);
    strictEqual(later.usage.ordersThisCycle, 0);
    deepStrictEqual(later.events, []);
  });

  it("a queued event is dead once the cycle that dated it has ended: skipped by the flush and reported apart", async () => {
    const { flush, usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        // Refused through the end of the period, then the period rolls.
        yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(refusingAppEvents));
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
        });
        yield* upsert(
          repository,
          paid(2, {
            processedAt: CYCLE_END,
            updatedAt: CYCLE_END,
            syncedAt: CYCLE_END,
          }),
          [],
        );
        const flush = yield* flushed();
        return {
          flush,
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    deepStrictEqual(flush, { sent: 1, remaining: 0 });
    strictEqual(usage.pendingUsageEvents, 0);
    strictEqual(usage.deadUsageEvents, 1);
    deepStrictEqual(events, [
      { idempotencyKey: `${orderId(1)}#count`, value: 1 },
    ]);
  });

  it("the first billing cycle discards events queued before the shop could be addressed", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        // A trial: orders arrive, a provisional cycle counts them, no cycle
        // can be pushed because Shopify reports none, and nothing can be
        // sent because nothing has named the shop.
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(2), []);
        // The trial ends and the first real period starts after both.
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_START + 10,
          cycleEndAt: CYCLE_END,
        });
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 0);
    strictEqual(usage.pendingUsageEvents, 0);
    strictEqual(usage.deadUsageEvents, 0);
    deepStrictEqual(events, []);
  });

  it("refuses a new order at the ceiling and still updates a stored one", async () => {
    const limits = Domain.ShopLimits as { maxOrdersPerCycle: number };
    const original = limits.maxOrdersPerCycle;
    limits.maxOrdersPerCycle = 1;
    try {
      const { first, second, third, usage } = await runInRepository(
        Effect.gen(function* () {
          const repository = yield* OrderRepository;
          yield* openCycle(repository);
          const first = yield* upsert(repository, paid(1), []);
          const second = yield* upsert(repository, paid(2), []);
          const third = yield* upsert(
            repository,
            paid(1, { updatedAt: CYCLE_START + 1, note: "still flows" }),
            [],
          );
          return { first, second, third, usage: yield* repository.getUsage() };
        }),
      );
      deepStrictEqual(first, { written: true, fresh: true, refused: false });
      deepStrictEqual(second, { written: false, fresh: false, refused: true });
      deepStrictEqual(third, { written: true, fresh: false, refused: false });
      strictEqual(usage.ordersThisCycle, 1);
      strictEqual(usage.ordersLimitedAt !== null, true);
    } finally {
      limits.maxOrdersPerCycle = original;
    }
  });

  it("flush deletes accepted events and keeps refused ones with the error", async () => {
    const { first, second } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        const first = yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(refusingAppEvents));
        const second = yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(acceptingAppEvents));
        return { first, second };
      }),
    );
    deepStrictEqual(first, { sent: 0, remaining: 1 });
    deepStrictEqual(second, { sent: 1, remaining: 0 });
  });

  it("leaves events queued until a billing cycle names the shop", async () => {
    const flush = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, paid(1), []);
        return yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(acceptingAppEvents));
      }),
    );
    deepStrictEqual(flush, { sent: 0, remaining: 1 });
  });

  it("reports whether the upsert created the row", async () => {
    const { created, updated } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const created = yield* upsert(repository, anOrder(), []);
        const updated = yield* upsert(
          repository,
          anOrder({ updatedAt: 2000 }),
          [],
        );
        return { created, updated };
      }),
    );
    strictEqual(created.fresh, true);
    strictEqual(updated.fresh, false);
  });
});

const NOW = 400 * 86_400_000;
/** Past the window by a day; `processedAt` is what the sweep reads. */
const EXPIRED = NOW - (Domain.ShopLimits.orderRetentionDays + 1) * 86_400_000;
/** Inside it by a day, whatever else is true of the order. */
const KEPT = NOW - (Domain.ShopLimits.orderRetentionDays - 1) * 86_400_000;

/** A run written straight to SQL: these tests care about the sweep, not how the run got there. */
const runWith =
  (orderId: string, status: string, updatedAt: number) =>
  (sql: SqlClient.SqlClient) =>
    sql`
      insert into WorkflowRun (
        id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
        lineItemId, lineItemTitle, variantTitle, sku, quantity,
        customAttributes, source, status, flag, flagAt, flagDetail,
        createdAt, updatedAt, cancelledAt
      ) values (
        ${`run-${orderId}-${status}`}, 'wf', 'Workflow', ${orderId}, '#1',
        0, ${`li-${orderId}`}, 'Item', null, null, 1, '[]', 'tag',
        ${status}, null, null, null, ${updatedAt}, ${updatedAt}, null
      )
    `;

describe("OrderRepository.sweepExpiredOrders", () => {
  it("deletes any order older than 365 days, open or closed, with its runs, plus orphaned runs", async () => {
    const { swept, orders, runs, usage } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const sql = yield* SqlClient.SqlClient;
        // Expired and open, with someone still working on it: goes anyway,
        // and the run goes with it. A year is long past "someone is on it".
        yield* upsert(
          repository,
          anOrder({ id: orderId(1), name: "#1001", processedAt: EXPIRED }),
          [],
        );
        yield* runWith(orderId(1), "active", EXPIRED)(sql);
        // Expired, closed, with a pending run: goes.
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
        yield* runWith(orderId(2), "pending", EXPIRED)(sql);
        // Closed, but inside the window: stays. Closing an order is not what
        // ages it out.
        yield* upsert(
          repository,
          anOrder({
            id: orderId(3),
            name: "#1003",
            processedAt: KEPT,
            cancelledAt: KEPT,
          }),
          [],
        );
        // Placed inside the window and edited long ago is impossible; placed
        // inside it and edited yesterday is the ordinary case: stays.
        yield* upsert(
          repository,
          anOrder({
            id: orderId(4),
            name: "#1004",
            processedAt: KEPT,
            updatedAt: NOW,
          }),
          [],
        );
        // A run whose order was deleted by `orders/delete`, long ago.
        yield* runWith("gid://shopify/Order/999", "done", EXPIRED)(sql);
        const swept = yield* repository.sweepExpiredOrders({ now: NOW });
        const orders = (yield* sql`select id from ShopOrder order by id`
          .values).map((row) => String(row[0]));
        const runs = (yield* sql`select id from WorkflowRun order by id`
          .values).map((row) => String(row[0]));
        return { swept, orders, runs, usage: yield* repository.getUsage() };
      }),
    );
    deepStrictEqual(swept, { orders: 2, runs: 3 });
    deepStrictEqual(orders, [orderId(3), orderId(4)]);
    deepStrictEqual(runs, []);
    strictEqual(usage.lastSweepAt, NOW);
  });
});

describe("OrderRepository sync state", () => {
  it("records the last completed import and the last error", async () => {
    const { idle, failed, completed } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const idle = yield* repository.getSyncState();
        const failed = yield* repository.setSyncError({
          error: "bulk submit failed",
        });
        return {
          idle,
          failed,
          completed: yield* repository.setLastCompletedAt({ now: 5000 }),
        };
      }),
    );
    strictEqual(idle.lastError, null);
    strictEqual(idle.lastCompletedAt, null);
    strictEqual(failed.lastError, "bulk submit failed");
    strictEqual(failed.lastCompletedAt, null);
    strictEqual(completed.lastCompletedAt, 5000);
    // A completed import answers the banner the failed one raised.
    strictEqual(completed.lastError, null);
  });

  it("clears the error the next import is about to supersede", async () => {
    const state = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.setSyncError({ error: "gone" });
        yield* repository.clearSyncError();
        return yield* repository.getSyncState();
      }),
    );
    strictEqual(state.lastError, null);
  });

  it("reports the stored updatedAt for the webhook staleness check", async () => {
    const updatedAt = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder({ updatedAt: 7000 }), []);
        return yield* repository.getOrderUpdatedAt(orderId(1));
      }),
    );
    assertSome(updatedAt, 7000);
  });
});

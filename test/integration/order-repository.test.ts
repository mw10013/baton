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
  tags: ["rush"],
  note: null,
  customAttributes: [{ key: "gift", value: "yes" }],
  lineItemsComplete: true,
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
) => repository.upsertOrder({ order, raw: "{}", lineItems });

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
    strictEqual(order.tags[0], "rush");
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

  it("replaces the line-item set when the write reports it is complete", async () => {
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

  it("merges instead of replacing when the fetch was truncated", async () => {
    const detail = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1), aLineItem(2)]);
        yield* upsert(
          repository,
          anOrder({ updatedAt: 3000, lineItemsComplete: false }),
          [aLineItem(3)],
        );
        return yield* repository.getOrder(orderId(1));
      }),
    );
    const { order, lineItems } = Option.getOrThrow(detail);
    strictEqual(order.lineItemsComplete, false);
    strictEqual(lineItems.length, 3);
  });

  it("deletes the order and its line items together", async () => {
    const [detail, updatedAt] = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1)]);
        yield* repository.deleteOrder(orderId(1));
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
        const list = (state: Domain.ProductionState | null) =>
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
          all: yield* list(null),
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
});

describe("OrderRepository sync state", () => {
  it("starts idle, reserves, and completes", async () => {
    const { idle, reserved, completed } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const idle = yield* repository.getSyncState();
        const reserved = yield* repository.reserveSync({
          workflowId: "wf-1",
          startedAt: 5000,
          windowStart: 1000,
        });
        return {
          idle,
          reserved,
          completed: yield* repository.completeSync({ startedAt: 5000 }),
        };
      }),
    );
    strictEqual(idle.workflowId, null);
    strictEqual(idle.lastFullSyncAt, null);
    strictEqual(reserved.workflowId, "wf-1");
    strictEqual(reserved.lastFullSyncWindowStart, 1000);
    strictEqual(completed.workflowId, null);
    strictEqual(completed.lastFullSyncAt, 5000);
  });

  /**
   * A completion callback from a superseded run must not release the claim the
   * run that replaced it is holding.
   */
  it("ignores a completion for a run that is no longer the reserved one", async () => {
    const state = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.reserveSync({
          workflowId: "wf-1",
          startedAt: 5000,
          windowStart: 1000,
        });
        yield* repository.reserveSync({
          workflowId: "wf-2",
          startedAt: 9000,
          windowStart: 4000,
        });
        return yield* repository.completeSync({ startedAt: 5000 });
      }),
    );
    strictEqual(state.workflowId, "wf-2");
    strictEqual(state.startedAt, 9000);
    strictEqual(state.lastFullSyncAt, null);
  });

  it("records the error and releases the claim on failure", async () => {
    const state = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.reserveSync({
          workflowId: "wf-1",
          startedAt: 5000,
          windowStart: 1000,
        });
        return yield* repository.failSync({
          startedAt: 5000,
          error: "bulk submit failed",
        });
      }),
    );
    strictEqual(state.workflowId, null);
    strictEqual(state.lastError, "bulk submit failed");
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

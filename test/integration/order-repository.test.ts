import { SqliteClient } from "@effect/sql-sqlite-do";
import { assertSome, deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import {
  ShopifyAppEvents,
  ShopifyAppEventsError,
} from "@/lib/ShopifyAppEvents";

import { withMaxOrdersPerCycle } from "./order-ceiling.ts";

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
const flagged = (page: Domain.OrdersPage, field: "unassigned") =>
  page.orders.filter((row) => row[field]).map((row) => row.order.name);
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
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: false,
  note: null,
  syncedAt: 1000,
  ...overrides,
});

const aLineItem = (
  n: number,
  overrides: Partial<Domain.OrderLineItem> = {},
): Domain.OrderLineItem => ({
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

/** The seat rows alone, with their dates: what the seat mark cases assert. */
const seatEvents = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select idempotencyKey, value, occurredAt from UsageEvent
      where eventHandle = ${Domain.USAGE_METER_MEMBER}
      order by rowid
    `.values;
    return rows.map((row) => ({
      idempotencyKey: String(row[0]),
      value: Number(row[1]),
      occurredAt: Number(row[2]),
    }));
  });

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

describe("OrderRepository.upsertOrder", () => {
  it("stores an order with its items", async () => {
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
  });

  /**
   * The guard that lets a retried webhook, a mid-stream bulk line, and a one-order
   * sync all write the same row in any order.
   */
  it("leaves the row and its items alone for an older updatedAt", async () => {
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
   * halfway through its items.
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
});

describe("OrderRepository.upsertOrder columns", () => {
  it("a sync rewrites every column but countedAt", async () => {
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
    const row = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, anOrder(), [aLineItem(1)]);
        yield* repository.countOrder(orderId(1), 1200);
        yield* upsert(repository, changed, [aLineItem(1)]);
        const sql = yield* SqlClient.SqlClient;
        const [stored] =
          yield* sql`select * from ShopOrder where id = ${orderId(1)}`;
        return stored;
      }),
    );
    deepStrictEqual(row, {
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
          position: null,
          issues: false,
          team: null,
          teams: [],
        });
        return {
          first,
          second: yield* repository.listOrders({
            limit: 2,
            cursor: first.nextCursor,
            q: null,
            position: null,
            issues: false,
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
 * Every SQL fragment against `Domain.orderPosition` and `Domain.orderIssues`:
 * the fixture covers each branch, and each filter value must return exactly the
 * names the TypeScript functions give it. Runs are written directly because
 * `RunRepository` is not in this test's layer and the filters only read
 * state. `#1005`, `#1009`, `#1010` and `#1012` are open with no open and no
 * done run: `not_started`. `#1005` matched no workflow, which is Not started
 * with no issue. `#1010`'s only run is closed, which still reads not started
 * but decides the item, so it is no issue.
 *
 * `#1012` and `#1013` are the multi-match cases: their items carry the tags
 * of two on workflows, `w1` and `w2`, which the fixture writes directly.
 * `#1013` has an open run *and* an item still waiting on a choice: `making`
 * with the issue `multi_match`. Between them they are also the proof
 * that `json_each` exists in Durable Object SQLite — every `MULTI_MATCH_ITEM`
 * fragment would throw without it.
 */
const seedStates = Effect.gen(function* () {
  const repository = yield* OrderRepository;
  const sql = yield* SqlClient.SqlClient;
  const cases: readonly {
    readonly n: number;
    readonly order?: Partial<Domain.ShopOrder>;
    readonly states: readonly Domain.RunState[];
    /** The product tags of the order's own item; two on workflows' tags and no run on it is a multi-match. */
    readonly matched?: readonly string[];
  }[] = [
    { n: 1, states: ["done"] }, // made
    { n: 2, states: ["done", "closed"] }, // made
    { n: 3, states: ["done", "open"] }, // making
    { n: 4, states: ["done", "open"] }, // making
    { n: 5, states: [] }, // not started, no workflow
    { n: 6, order: { cancelledAt: 5 }, states: ["done"] }, // cancelled
    { n: 7, order: { fulfillmentStatus: "FULFILLED" }, states: ["done"] }, // fulfilled
    { n: 8, states: ["done", "done"] }, // made
    { n: 9, order: { fullyPaid: false }, states: [] }, // not started, unpaid: no issue
    { n: 10, states: ["closed"] }, // not started, and decided: no issue
    { n: 11, order: { fulfillmentStatus: "FULFILLED" }, states: [] }, // fulfilled, never started
    { n: 12, states: [], matched: ["w1", "w2"] }, // not started, choose a workflow
    { n: 13, states: ["open"], matched: ["w1", "w2"] }, // making, and choose a workflow
    // Unpaid: a multi-match is an issue all the same.
    {
      n: 14,
      order: { fullyPaid: false },
      states: ["open"],
      matched: ["w1", "w2"],
    }, // making
  ];
  for (const id of ["w1", "w2"]) {
    yield* sql`
      insert into Workflow (id, name, tag, state, updatedAt)
      values (${id}, ${id}, ${id}, 'on', 0)
    `;
    yield* sql`
      insert into WorkflowTask (id, workflowId, position, step, name, teamId)
      values (${`${id}-task`}, ${id}, 1, 1, 'Task', 'team-cut')
    `;
  }
  for (const { n, order, states, matched } of cases) {
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
          state, closedAt, closedReason, createdAt, updatedAt
        ) values (
          ${`run-${String(n)}-${String(index)}`}, 'wf', 'Workflow',
          ${orderId(n)}, ${`#10${String(n).padStart(2, "0")}`}, 0,
          ${`${lineItemId(n)}-${String(index)}`}, 'Item', null, null, 1,
          '[]', ${state}, ${state === "closed" ? 1 : null},
          ${state === "closed" ? "merchant_cancelled" : null}, 0, 0
        )
      `;
  }
  return repository;
});

/**
 * `seedStates` plus the issues it lacks, and a team to filter on: `#1003`'s
 * open run is blocked, `#1004`'s open run has a task on a team that has
 * was deleted (unassigned), and `#1015`, added here, is being made with
 * its current task on a team with no members, which is no order issue.
 * Ready tasks on Cut hang off `#1013` and `#1014`, both choosing.
 */
/** A position filter, or `"issues"` for the Issues filter alone. */
type Filter = Domain.OrdersPositionFilter | "issues" | null;

const seedIssues = Effect.gen(function* () {
  const repository = yield* seedStates;
  const sql = yield* SqlClient.SqlClient;
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
      state, closedAt, closedReason, createdAt, updatedAt
    ) values (
      'run-15-0', 'wf', 'Workflow', ${orderId(15)}, '#1015', 0,
      ${`${lineItemId(15)}-0`}, 'Item', null, null, 1, '[]', 'open', null,
      null, 0, 0
    )
  `;
  yield* task("s15", "run-15-0", "team-empty");
  const teams = Schema.decodeUnknownSync(
    Schema.Array(Domain.TeamWithMemberCount),
  )([
    { id: "team-cut", name: "Cut", memberCount: 1 },
    { id: "team-empty", name: "Polish", memberCount: 0 },
  ]);
  /** `"issues"` is the Issues filter with no position; `issues` adds it to a position. */
  const list = (
    filter: Filter,
    team: Domain.TeamId | null = null,
    q: string | null = null,
    issues = false,
  ) =>
    repository.listOrders({
      limit: 20,
      cursor: null,
      q: q === null ? null : Schema.decodeUnknownSync(Domain.ListSearch)(q),
      position: filter === "issues" ? null : filter,
      issues: issues || filter === "issues",
      team,
      teams,
    });
  return { list };
});

describe("OrderRepository.listOrders multi-match", () => {
  /**
   * `MULTI_MATCH_ITEM` is the SQL twin of `Domain.itemMatches`. Of four
   * workflows tagged for the first item, two are on with every task on a
   * team, one is off and one has an unassigned task, so the item is
   * a multi-match; the second item carries one eligible workflow's tag and the
   * two ineligible ones', so it is not. SQL and TypeScript count the same.
   */
  it("the index's multi-match predicate agrees with multiMatchItems", async () => {
    const { sqlCount, tsCount } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const sql = yield* SqlClient.SqlClient;
        const cases: readonly (readonly [
          string,
          Domain.WorkflowState,
          string | null,
        ])[] = [
          ["w1", "on", "team-cut"],
          ["w2", "on", "team-cut"],
          ["w3", "off", "team-cut"],
          ["w4", "on", null],
        ];
        for (const [id, state, teamId] of cases) {
          yield* sql`
            insert into Workflow (id, name, tag, state, updatedAt)
            values (${id}, ${id}, ${id}, ${state}, 0)
          `;
          yield* sql`
            insert into WorkflowTask (id, workflowId, position, step, name, teamId)
            values (${`${id}-task`}, ${id}, 1, 1, 'Task', ${teamId})
          `;
        }
        const details = cases.map(([id, state, teamId]) =>
          Schema.decodeUnknownSync(Domain.WorkflowDetail)({
            workflow: { id, name: id, tag: id, state, updatedAt: 0 },
            tasks: [
              {
                id: `${id}-task`,
                workflowId: id,
                position: 1,
                step: 1,
                name: "Task",
                teamId,
                instructions: null,
              },
            ],
          }),
        );
        const teams = Schema.decodeUnknownSync(
          Schema.Array(Domain.TeamWithMemberCount),
        )([{ id: "team-cut", name: "Cut", memberCount: 1 }]);
        const lineItems = [
          aLineItem(1, { productTags: ["w1", "w2", "w3", "w4"] }),
          aLineItem(2, { productTags: ["w1", "w3", "w4"] }),
        ];
        yield* upsert(repository, anOrder({ fullyPaid: true }), lineItems);
        const page = yield* repository.listOrders({
          limit: 20,
          cursor: null,
          q: null,
          position: null,
          issues: false,
          team: null,
          teams,
        });
        return {
          sqlCount: page.orders[0]?.multiMatchItems,
          tsCount: Domain.multiMatchItems(lineItems, [], details, teams).length,
        };
      }),
    );
    strictEqual(tsCount, 1);
    strictEqual(sqlCount, tsCount);
  });
});

describe("OrderRepository.listOrders filters", () => {
  it("each position filter returns exactly the orders orderPosition gives that position, and an order whose only run is closed is not started", async () => {
    const pages = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const list = (position: Domain.OrdersPositionFilter | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            position,
            issues: false,
            team: null,
            teams: [],
          });
        return {
          open: yield* list(null),
          all: yield* list("all"),
          not_started: yield* list("not_started"),
          making: yield* list("making"),
          made: yield* list("made"),
          fulfilled: yield* list("fulfilled"),
          cancelled: yield* list("cancelled"),
        };
      }),
    );
    strictEqual(pages.all.orders.length, 14);
    deepStrictEqual(names(pages.not_started), [
      "#1012",
      "#1010",
      "#1009",
      "#1005",
    ]);
    // `#1013`: one item being made beside one waiting on a choice. It is
    // making, with the choice as an issue.
    deepStrictEqual(names(pages.making), ["#1014", "#1013", "#1004", "#1003"]);
    deepStrictEqual(names(pages.made), ["#1008", "#1002", "#1001"]);
    deepStrictEqual(names(pages.fulfilled), ["#1011", "#1007"]);
    deepStrictEqual(names(pages.cancelled), ["#1006"]);
    // The SQL and the TypeScript agree row by row.
    for (const row of pages.all.orders) {
      const state = Domain.orderPosition(row);
      for (const position of Domain.OrderPosition.literals)
        strictEqual(
          names(pages[position]).includes(row.order.name),
          state === position,
          `${row.order.name} as ${state} under ${position}`,
        );
      strictEqual(
        names(pages.open).includes(row.order.name),
        Domain.orderIsOpen(row.order),
        `${row.order.name} under Open`,
      );
    }
  });

  it("the Issues filter returns exactly the orders orderIssues gives at least one issue", async () => {
    const { all, issues } = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedIssues;
        const sql = yield* SqlClient.SqlClient;
        // A stale block on a fulfilled order's run is not an issue.
        yield* sql`update Run set state = 'open', blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-7-0'`;
        return { all: yield* list("all"), issues: yield* list("issues") };
      }),
    );
    // Choosing `#1014` (unpaid), `#1013` and `#1012`, unassigned `#1004`,
    // blocked `#1003`. `#1005` matched no workflow, `#1010`'s only run was
    // closed, and `#1015` waits on a team with no members, a workflow fault
    // and no order issue.
    deepStrictEqual(names(issues), [
      "#1014",
      "#1013",
      "#1012",
      "#1004",
      "#1003",
    ]);
    for (const row of all.orders)
      strictEqual(
        names(issues).includes(row.order.name),
        Domain.orderIssues(row).length > 0,
        `${row.order.name} under Issues`,
      );
  });

  /**
   * `Domain.OrderCounts`, checked as the rule itself: for every filter, team
   * and search, each count equals the length of the list its value would show
   * under that team with no search, so a count never moves with the main
   * filter, the issues filter or the search.
   */
  it("a count ignores the search and the main filter and honours the team", async () => {
    const checks = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedIssues;
        const filters = [
          null,
          "issues",
          "not_started",
          "making",
          "made",
          "fulfilled",
          "all",
        ] as const;
        const counted = {
          open: null,
          issues: "issues",
          not_started: "not_started",
          making: "making",
          made: "made",
        } as const satisfies Record<keyof Domain.OrderCounts, Filter>;
        const out: {
          readonly label: string;
          readonly count: number;
          readonly shown: number;
        }[] = [];
        const reads = filters.flatMap((filter) =>
          [null, aTeamId("team-cut")].flatMap((team) =>
            [null, "1007", "1013", "item 1"].flatMap((q) =>
              [false, true].map((issues) => ({ filter, team, q, issues })),
            ),
          ),
        );
        for (const { filter, team, q, issues } of reads) {
          const { counts } = yield* list(filter, team, q, issues);
          for (const [key, shows] of Object.entries(counted))
            out.push({
              label: `${String(filter)}/${String(team)}/${String(q)}/${String(issues)}: ${key}`,
              count: counts[key as keyof typeof counted],
              shown: (yield* list(shows, team)).orders.length,
            });
        }
        return {
          out,
          open: (yield* list(null)).counts,
          cut: (yield* list(null, aTeamId("team-cut"))).counts,
        };
      }),
    );
    for (const { label, count, shown } of checks.out)
      strictEqual(count, shown, label);
    deepStrictEqual(checks.open, {
      open: 12,
      issues: 5,
      not_started: 4,
      making: 5,
      made: 3,
    });
    // Cut holds `#1013` and `#1014`, both making and both choosing.
    deepStrictEqual(checks.cut, {
      open: 2,
      issues: 2,
      not_started: 0,
      making: 2,
      made: 0,
    });
  });

  it("search ignores the filters", async () => {
    const found = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedIssues;
        return {
          // Fulfilled, so under no Made filter, and waiting on nobody.
          fulfilled: yield* list("made", aTeamId("team-nobody"), "1007", true),
          // Waiting on Cut, making, not made.
          cut: yield* list("made", aTeamId("team-nobody"), "1013", true),
        };
      }),
    );
    deepStrictEqual(names(found.fulfilled), ["#1007"]);
    deepStrictEqual(names(found.cut), ["#1013"]);
  });

  it("a search by item title finds the order whatever the filters", async () => {
    const found = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedIssues;
        return yield* list("made", aTeamId("team-nobody"), "item 7", true);
      }),
    );
    deepStrictEqual(names(found), ["#1007"]);
    strictEqual(found.matches, 1);
  });

  it("a search by SKU", async () => {
    const found = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedIssues;
        return yield* list(null, null, "sku-13");
      }),
    );
    deepStrictEqual(names(found), ["#1013"]);
  });

  it("Making and Issues combine", async () => {
    const pages = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedIssues;
        return {
          making: yield* list("making"),
          issues: yield* list("issues"),
          both: yield* list("making", null, null, true),
        };
      }),
    );
    deepStrictEqual(
      names(pages.both),
      names(pages.making).filter((name) => names(pages.issues).includes(name)),
    );
    deepStrictEqual(names(pages.both), ["#1014", "#1013", "#1004", "#1003"]);
  });

  it("a filter under a team narrows to the open orders waiting on it", async () => {
    const pages = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedIssues;
        const sql = yield* SqlClient.SqlClient;
        // A leftover open run with a current task on Cut, on a fulfilled order.
        yield* sql`update Run set state = 'open' where id = 'run-7-0'`;
        yield* sql`
          insert into RunTask
            (id, runId, position, step, name, teamId, teamName, doneAt)
          values ('s7', 'run-7-0', 1, 1, 'Task', 'team-cut', 'Team', null)
        `;
        const cut = aTeamId("team-cut");
        return {
          all: yield* list("all", cut),
          fulfilled: yield* list("fulfilled", cut),
          issues: yield* list("issues", cut),
        };
      }),
    );
    deepStrictEqual(names(pages.all), ["#1014", "#1013"]);
    deepStrictEqual(names(pages.fulfilled), []);
    deepStrictEqual(names(pages.issues), ["#1014", "#1013"]);
  });

  /**
   * `RunCounts.blocked` counts open runs only, and a closed run is not
   * counted at all (`#1002`'s closed run leaves its counts at one done run).
   * A done run carries no block (the data model on `initializeSchema`,
   * `ShopAgentSchema.ts`), so no done run is blocked here.
   */
  it("counts a block on open runs only, and counts closed runs not at all", async () => {
    const { all } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const sql = yield* SqlClient.SqlClient;
        const block = (runId: string) =>
          sql`update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = ${runId}`;
        yield* block("run-3-1");
        return {
          all: yield* repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            position: null,
            issues: false,
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
      blocked: 1,
    });
    deepStrictEqual(runsOf("#1001"), {
      open: 0,
      done: 1,
      blocked: 0,
    });
    deepStrictEqual(runsOf("#1002"), {
      open: 0,
      done: 1,
      blocked: 0,
    });
  });
});

/**
 * `Domain.ListOrdersInput.q`, read by `Domain.searchTerm`: an order number
 * matches `ShopOrder.name` whole, the `#` the merchant's to type or omit; a
 * word is a prefix of an item's title, variant title or SKU, with `like`'s
 * own metacharacters escaped rather than honoured.
 */
describe("OrderRepository.listOrders q", () => {
  const seedNames = Effect.gen(function* () {
    const repository = yield* OrderRepository;
    for (const [n, name, title, variantTitle, sku] of [
      [1, "#1001", "Signet ring", "Rose gold", "RING-9"],
      [2, "#1002", "Brass hinge", null, "HINGE_2"],
      [3, "#2100", "Stamp", "Large", null],
    ] as const)
      yield* upsert(
        repository,
        anOrder({
          id: orderId(n),
          legacyId: String(n),
          name,
          processedAt: n * 1000,
        }),
        [aLineItem(n, { orderId: orderId(n), title, variantTitle, sku })],
      );
    return repository;
  });

  const search = (q: string) =>
    Effect.gen(function* () {
      const repository = yield* seedNames;
      return yield* repository.listOrders({
        limit: 20,
        cursor: null,
        q: Schema.decodeUnknownSync(Domain.ListSearch)(q),
        position: null,
        issues: false,
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

  it("an order number matches whole, so #10 takes nothing", async () => {
    deepStrictEqual(names(await runInRepository(search("#10"))), []);
  });

  it("a word is a prefix of a word in the item title, case-insensitive", async () => {
    deepStrictEqual(names(await runInRepository(search("sig"))), ["#1001"]);
    deepStrictEqual(names(await runInRepository(search("RING"))), ["#1001"]);
    deepStrictEqual(names(await runInRepository(search("net"))), []);
  });

  it("a search by variant title", async () => {
    deepStrictEqual(names(await runInRepository(search("gold"))), ["#1001"]);
    deepStrictEqual(names(await runInRepository(search("large"))), ["#2100"]);
  });

  it("escapes like's own wildcards rather than honouring them", async () => {
    deepStrictEqual(names(await runInRepository(search("%"))), []);
    deepStrictEqual(names(await runInRepository(search("hinge_"))), ["#1002"]);
    deepStrictEqual(names(await runInRepository(search("hingex"))), []);
  });
});

describe("OrderRepository.listOrders team issues", () => {
  const teams = Schema.decodeUnknownSync(
    Schema.Array(Domain.TeamWithMemberCount),
  )([
    { id: "team-cut", name: "Cut", memberCount: 1 },
    { id: "team-empty", name: "Polish", memberCount: 0 },
  ]);
  /**
   * `seedStates` with tasks hung off its runs, listed against `teams`, for
   * `Domain.OrderRow.unassigned`. `#1`'s done
   * run keeps a stale pointer on a done task and never counts, and `#8` is
   * healthy.
   */
  const fixture = (
    extra: (
      task: (
        id: string,
        runId: string,
        step: number,
        teamId: string | null,
        doneAt: number | null,
      ) => Effect.Effect<unknown, unknown>,
    ) => Effect.Effect<unknown, unknown>,
  ) =>
    runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const sql = yield* SqlClient.SqlClient;
        const task = (
          id: string,
          runId: string,
          step: number,
          teamId: string | null,
          doneAt: number | null,
        ) => sql`
          insert into RunTask
            (id, runId, position, step, name, teamId, teamName, doneAt,
             doneByRole, startedAt, startedByRole)
          values (${id}, ${runId}, ${step}, ${step}, 'Task', ${teamId}, 'Team', ${doneAt},
            ${doneAt === null ? null : "merchant"}, ${doneAt},
            ${doneAt === null ? null : "merchant"})
        `;
        yield* task("s1", "run-1-0", 1, "team-gone", 1);
        yield* task("s8", "run-8-0", 1, "team-cut", 1);
        yield* extra(task);
        const list = (issues: boolean) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            position: null,
            issues,
            team: null,
            teams,
          });
        return { all: yield* list(false), issues: yield* list(true) };
      }),
    );

  /**
   * `#1003`'s open run has an open task on a deleted team on its current
   * step; `#1014`'s has a current task on Cut and a later one on the deleted
   * team.
   */
  it("an open task on a deleted team, on any step, makes the order unassigned, and the Issues filter holds it", async () => {
    const { all, issues } = await fixture((task) =>
      Effect.gen(function* () {
        yield* task("s3", "run-3-1", 1, "team-gone", null);
        yield* task("s14a", "run-14-0", 1, "team-cut", null);
        yield* task("s14b", "run-14-0", 2, "team-gone", null);
      }),
    );
    deepStrictEqual(flagged(all, "unassigned"), ["#1014", "#1003"]);
    for (const name of ["#1014", "#1003"])
      strictEqual(names(issues).includes(name), true, name);
    strictEqual(names(issues).includes("#1008"), false);
    strictEqual(names(issues).includes("#1001"), false);
    strictEqual(all.counts.issues, names(issues).length);
  });

  /**
   * `#1004`'s open run has finished step 1 on Cut, so its step-2 task on
   * the empty team is current; `#1014`'s step 1 on Cut is still current, so
   * its step-2 task on the empty team is not.
   */
});

/**
 * `Domain.OrderRow.waitingOn`: the teams with a current task on an open run,
 * through the same `currentWhere` the member's workflows list runs on, so the cell and the
 * filter are one fact rendered two ways. The fixture reuses `seedStates`'
 * runs and hangs tasks off them; on #1003 and #1004, `run-N-0` is done and
 * `run-N-1` is open.
 */
describe("OrderRepository.listOrders waitingOn", () => {
  /** Ids ascend cut → pack → polish while names ascend Anodize → Cut → Pack, so the two orders disagree. */
  const teams = Schema.decodeUnknownSync(
    Schema.Array(Domain.TeamWithMemberCount),
  )([
    { id: "team-cut", name: "Cut", memberCount: 1 },
    { id: "team-polish", name: "Anodize", memberCount: 1 },
    { id: "team-pack", name: "Pack", memberCount: 1 },
  ]);

  const waitingFixture = Effect.gen(function* () {
    const repository = yield* seedStates;
    const sql = yield* SqlClient.SqlClient;
    /* `position` is unique per run and only orders a list, so it comes off a
       counter; `step` decides which tasks are current and every case names it. */
    let position = 0;
    const task = (
      id: string,
      runId: string,
      step: number,
      team: string,
      doneAt: number | null = null,
    ) => {
      position += 1;
      return sql`
        insert into RunTask
          (id, runId, position, step, name, teamId, teamName, doneAt,
           doneByRole, startedAt, startedByRole)
        values (${id}, ${runId}, ${position}, ${step}, 'Task', ${team}, 'Team', ${doneAt},
          ${doneAt === null ? null : "merchant"}, ${doneAt},
          ${doneAt === null ? null : "merchant"})
      `;
    };
    /* #1003: two open item runs both current on Cut, so the id is distinct
       across runs; the done run's task is on Cut too, and a run that is over
       holds nobody up. */
    yield* sql`
      insert into Run (
        id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
        lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
        state, createdAt, updatedAt
      ) values (
        'run-3-2', 'wf', 'Workflow', ${orderId(3)}, '#1003', 0,
        ${`${lineItemId(3)}-2`}, 'Item', null, null, 1, '[]', 'open',
        0, 0
      )
    `;
    yield* task("s3a", "run-3-1", 1, "team-cut");
    yield* task("s3b", "run-3-0", 1, "team-cut");
    yield* task("s3e", "run-3-2", 1, "team-cut");
    /* #1004: current on Cut, with a later step on Anodize that is not current.
       Anodize sorts first by name, so it would show if it counted. */
    yield* task("s4a", "run-4-1", 1, "team-cut");
    yield* task("s4b", "run-4-1", 2, "team-polish");
    const list = (team: Domain.TeamId | null = null, filter: Filter = null) =>
      repository.listOrders({
        limit: 20,
        cursor: null,
        q: null,
        position: filter === "issues" ? null : filter,
        issues: filter === "issues",
        team,
        teams,
      });
    return { sql, task, list };
  });

  /**
   * `#1007` is fulfilled and `#1006` cancelled. Reconcile closes every open
   * run on a closed order, but the rule does not lean on that: each is given
   * a leftover open run with an unassigned current task and a current task on
   * Cut, and neither order has an issue or waits on anyone, in the cell or
   * under the filter, whichever position is chosen.
   */
  it("a fulfilled or cancelled order has no issues and waits on no team", async () => {
    const { all, cut, issues } = await runInRepository(
      Effect.gen(function* () {
        const { sql, task, list } = yield* waitingFixture;
        yield* sql`update Run set state = 'open', blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-7-0'`;
        yield* sql`update Run set state = 'open' where id = 'run-6-0'`;
        yield* task("s7", "run-7-0", 1, "team-cut");
        yield* task("s6", "run-6-0", 1, "team-cut");
        yield* task("s6b", "run-6-0", 1, "team-gone");
        return {
          all: yield* list(null, "all"),
          cut: yield* list(aTeamId("team-cut"), "all"),
          issues: yield* list(null, "issues"),
        };
      }),
    );
    for (const name of ["#1007", "#1006"]) {
      deepStrictEqual(waitingOf(all, name), []);
      const row = rowOf(all, name);
      strictEqual(row === undefined ? null : Domain.orderIssues(row).length, 0);
      strictEqual(names(issues).includes(name), false);
    }
    deepStrictEqual(names(cut), ["#1004", "#1003"]);
  });

  it("names each team once, only for current tasks on open runs", async () => {
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
   * A blocked run's current task still satisfies `currentWhere` (the workflows list keeps
   * showing it), but the team cannot move it, so the cell and the filter both
   * leave the team out; `RunCounts.blocked` is where that run is counted.
   */
  it("leaves out a blocked run, which is counted as blocked instead", async () => {
    const { page, filtered } = await runInRepository(
      Effect.gen(function* () {
        const { sql, list } = yield* waitingFixture;
        yield* sql`update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-4-1'`;
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

  it("leaves out a team that was deleted, which is unassigned instead", async () => {
    const page = await runInRepository(
      Effect.gen(function* () {
        const { sql, list } = yield* waitingFixture;
        yield* sql`update RunTask set teamId = 'team-gone' where id in ('s3a', 's3e')`;
        return yield* list();
      }),
    );
    deepStrictEqual(waitingOf(page, "#1003"), []);
    strictEqual(rowOf(page, "#1003")?.unassigned, true);
  });

  /**
   * The filter is the column's membership test as a `where`, so the filtered
   * page is exactly the rows whose cell names the team — and the counts are
   * narrowed to it, as `Domain.OrderCounts` says.
   */
  it("keeps exactly the rows waiting on that team, and narrows the counts to it", async () => {
    const { all, cut, polish, unknown } = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* waitingFixture;
        return {
          all: yield* list(),
          cut: yield* list(aTeamId("team-cut")),
          /* Anodize owns #1004's second step, which is not current yet. */
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
    const none = {
      open: 0,
      issues: 0,
      not_started: 0,
      making: 0,
      made: 0,
    };
    deepStrictEqual(cut.counts, { ...none, open: 2, making: 2 });
    deepStrictEqual(unknown.counts, none);
    strictEqual(all.counts.making, 4);
  });

  it("sorts by team name, not by id", async () => {
    const page = await runInRepository(
      Effect.gen(function* () {
        const { task, list } = yield* waitingFixture;
        yield* task("s3c", "run-3-1", 1, "team-pack");
        yield* task("s3d", "run-3-1", 1, "team-polish");
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

describe("OrderRepository usage", () => {
  /** Mid-month, so `processedAt: CYCLE_START - 1` is unambiguously the cycle before. */
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
      memberCount: 0,
    });

  /**
   * What `RunRepository.insertRun` does after it creates the order's
   * first run. Called directly here so the meter is tested as the rule it is,
   * rather than through a reconcile that would have to be staged first;
   * `run-repository.test.ts` owns the other half — that a run is what
   * fires it, and that a second run does not.
   */
  const count = (
    repository: typeof OrderRepository.Service,
    n: number,
    now = CYCLE_START,
  ) => repository.countOrder(orderId(n), now);

  it("counts an order against the pushed billing cycle", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        // Five orders stored; two of them reached run creation. Storing an
        // order is not what the merchant is billed for.
        for (const n of [1, 2, 3, 4, 5]) yield* upsert(repository, paid(n), []);
        yield* count(repository, 1);
        yield* count(repository, 2);
        return yield* repository.getUsage();
      }),
    );
    strictEqual(usage.ordersThisCycle, 2);
    strictEqual(usage.cycleStartAt, CYCLE_START);
    strictEqual(usage.cycleEndAt, CYCLE_END);
  });

  it("opens a provisional cycle before a billing cycle is known", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
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
        yield* count(repository, 1);
        const before = yield* repository.getUsage();
        // The upsert resolves the cycle; the count that follows lands in the
        // period it opened.
        yield* upsert(
          repository,
          paid(2, {
            processedAt: CYCLE_END,
            updatedAt: CYCLE_END,
            syncedAt: CYCLE_END,
          }),
          [],
        );
        yield* count(repository, 2, CYCLE_END);
        return { before, after: yield* repository.getUsage() };
      }),
    );
    strictEqual(before.ordersThisCycle, 1);
    strictEqual(after.ordersThisCycle, 1);
    strictEqual(after.cycleStartAt, CYCLE_END);
    strictEqual(after.cycleEndAt, null);
  });

  it("a manual attach past the cycle end counts into the new cycle", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
        yield* upsert(repository, paid(2), []);
        // No upsert lands past the end: the count itself rolls the cycle.
        yield* count(repository, 2, CYCLE_END + 1);
        return yield* repository.getUsage();
      }),
    );
    strictEqual(usage.ordersThisCycle, 1);
    strictEqual(usage.cycleStartAt, CYCLE_END);
    strictEqual(usage.cycleEndAt, null);
  });

  it("recounts the cycle from the orders when a new billing cycle is pushed", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(2), []);
        yield* count(repository, 1);
        yield* count(repository, 2);
        // The next cycle: the two above fall outside it and drop out.
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
          memberCount: 0,
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
        yield* count(repository, 1);
        return yield* usageEvents();
      }),
    );
    deepStrictEqual(events, [
      { idempotencyKey: `${orderId(1)}#count`, value: 1 },
    ]);
  });

  it("a second sync never queues a second count", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
        yield* upsert(repository, paid(1, { updatedAt: CYCLE_START + 1 }), []);
        yield* count(repository, 1, CYCLE_START + 1);
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 1);
    strictEqual(events.length, 1);
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
        yield* count(repository, 1);
        yield* count(repository, 2);
        // The trial ends and the first real billing cycle starts after both.
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_START + 10,
          cycleEndAt: CYCLE_END,
          memberCount: 0,
        });
        return {
          usage: yield* repository.getUsage(),
          events: yield* usageEvents(),
        };
      }),
    );
    strictEqual(usage.ordersThisCycle, 0);
    strictEqual(usage.pendingUsageEvents, 0);
    deepStrictEqual(events, []);
  });

  it("the ceiling counts orders work started on, not orders stored: a new order is refused at it and a stored one still updates", async () => {
    await withMaxOrdersPerCycle(1, async () => {
      const { first, uncounted, second, third, usage } = await runInRepository(
        Effect.gen(function* () {
          const repository = yield* OrderRepository;
          yield* openCycle(repository);
          const first = yield* upsert(repository, paid(1), []);
          // Stored, uncounted: the ceiling is the metered count, so storage
          // alone does not approach it ({@link OrderRepository.countOrder}).
          const uncounted = yield* upsert(repository, paid(2), []);
          yield* count(repository, 1);
          const second = yield* upsert(repository, paid(3), []);
          const third = yield* upsert(
            repository,
            paid(1, { updatedAt: CYCLE_START + 1, note: "still flows" }),
            [],
          );
          return {
            first,
            uncounted,
            second,
            third,
            usage: yield* repository.getUsage(),
          };
        }),
      );
      const none = Option.none();
      deepStrictEqual(first, {
        written: true,
        fresh: true,
        refused: false,
        afterWrite: none,
      });
      deepStrictEqual(uncounted, {
        written: true,
        fresh: true,
        refused: false,
        afterWrite: none,
      });
      deepStrictEqual(second, {
        written: false,
        fresh: false,
        refused: true,
        afterWrite: none,
      });
      deepStrictEqual(third, {
        written: true,
        fresh: false,
        refused: false,
        afterWrite: none,
      });
      strictEqual(usage.ordersThisCycle, 1);
      strictEqual(usage.ordersLimitedAt !== null, true);
    });
  });

  it("a usage event is one row per idempotency key, kept until Shopify accepts it", async () => {
    const key = `${orderId(1)}#count`;
    const { duplicate, afterRefusal, afterAcceptance } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const sql = yield* SqlClient.SqlClient;
        const keys = () =>
          sql`select idempotencyKey, attempts from UsageEvent`.values.pipe(
            Effect.map((rows) => rows.map(([k, n]) => [String(k), Number(n)])),
          );
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
        const duplicate = yield* sql`
          insert into UsageEvent (idempotencyKey, eventHandle, orderId, value, occurredAt)
          values (${key}, ${Domain.USAGE_METER_ORDER}, ${orderId(1)}, 1, ${CYCLE_START})
        `.pipe(
          Effect.as("inserted"),
          Effect.catch(() => Effect.succeed("refused")),
        );
        yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(refusingAppEvents));
        const afterRefusal = yield* keys();
        yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(acceptingAppEvents));
        return { duplicate, afterRefusal, afterAcceptance: yield* keys() };
      }),
    );
    strictEqual(duplicate, "refused");
    deepStrictEqual(afterRefusal, [[key, 1]]);
    deepStrictEqual(afterAcceptance, []);
  });

  it("flush deletes accepted events and keeps refused ones with the error", async () => {
    const { first, second } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
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
        yield* count(repository, 1);
        return yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(acceptingAppEvents));
      }),
    );
    deepStrictEqual(flush, { sent: 0, remaining: 1 });
  });

  const openCycleWithMemberCount = (
    repository: typeof OrderRepository.Service,
    memberCount: number,
  ) =>
    repository.setBillingCycle({
      shopGid,
      cycleStartAt: CYCLE_START,
      cycleEndAt: CYCLE_END,
      memberCount,
    });

  /**
   * A removal is never reported to the object, so what this pins is the
   * consequence: removing and re-adding inside a cycle bills the seat once,
   * and a revalidation that reads the smaller member count lowers nothing.
   */

  it("a new cycle resets the mark to the member count and queues it as the cycle's first seat event", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithMemberCount(repository, 3);
        yield* openCycleWithMemberCount(repository, 5);
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
          memberCount: 4,
        });
        return {
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    strictEqual(usage.seatsThisCycle, 4);
    deepStrictEqual(events.at(-1), {
      idempotencyKey: seatKey(CYCLE_END, 4),
      value: 4,
      occurredAt: CYCLE_END,
    });
  });

  it("an unchanged cycle leaves the mark and queues nothing", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithMemberCount(repository, 3);
        yield* openCycleWithMemberCount(repository, 3);
        return {
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    strictEqual(usage.seatsThisCycle, 3);
    strictEqual(events.length, 1);
  });

  it("a revalidation raises the mark to a member count past it and sends the rise", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithMemberCount(repository, 3);
        yield* openCycleWithMemberCount(repository, 5);
        return {
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    strictEqual(usage.seatsThisCycle, 5);
    deepStrictEqual(
      events.map(({ idempotencyKey, value }) => ({ idempotencyKey, value })),
      [
        { idempotencyKey: seatKey(CYCLE_START, 3), value: 3 },
        { idempotencyKey: seatKey(CYCLE_START, 5), value: 2 },
      ],
    );
  });

  /**
   * The counting path rolls a cycle past its end without the Worker, and the
   * revalidation that follows pushes that same start: an unchanged cycle to
   * `setBillingCycle`. The rolled cycle must still get its whole member count sent.
   */
  it("a cycle the counting path rolled forward starts with no seat mark, and the next revalidation sends the whole count", async () => {
    const { mark, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithMemberCount(repository, 3);
        // An order past the cycle end rolls the cycle forward on its own.
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1, CYCLE_END + 1);
        const mark = (yield* repository.getUsage()).seatsThisCycle;
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
          memberCount: 3,
        });
        return { mark, events: yield* seatEvents() };
      }),
    );
    strictEqual(mark, 0);
    deepStrictEqual(
      events.map(({ idempotencyKey, value }) => ({ idempotencyKey, value })),
      [
        { idempotencyKey: seatKey(CYCLE_START, 3), value: 3 },
        { idempotencyKey: seatKey(CYCLE_END, 3), value: 3 },
      ],
    );
  });

  it("the flush sends each event under its own meter handle", async () => {
    const sent = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithMemberCount(repository, 2);
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
        const sent: { eventHandle: string; value: number }[] = [];
        yield* repository.flushUsageEvents("shop.myshopify.com").pipe(
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
        return sent;
      }),
    );
    deepStrictEqual(sent, [
      { eventHandle: Domain.USAGE_METER_MEMBER, value: 2 },
      { eventHandle: Domain.USAGE_METER_ORDER, value: 1 },
    ]);
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
  (orderId: string, state: string, updatedAt: number) =>
  (sql: SqlClient.SqlClient) =>
    sql`
      insert into Run (
        id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
        lineItemId, lineItemTitle, variantTitle, sku, quantity,
        lineItemProperties, state, createdAt, updatedAt
      ) values (
        ${`run-${orderId}-${state}`}, 'wf', 'Workflow', ${orderId}, '#1',
        0, ${`li-${orderId}`}, 'Item', null, null, 1, '[]',
        ${state}, ${updatedAt}, ${updatedAt}
      )
    `;

describe("OrderRepository.sweepExpiredOrders", () => {
  it("deletes any order older than 365 days, open or closed, with its runs", async () => {
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
        const swept = yield* repository.sweepExpiredOrders({ now: NOW });
        const orders = (yield* sql`select id from ShopOrder order by id`
          .values).map((row) => String(row[0]));
        const runs = (yield* sql`select id from Run order by id`.values).map(
          (row) => String(row[0]),
        );
        return { swept, orders, runs, usage: yield* repository.getUsage() };
      }),
    );
    deepStrictEqual(swept, { orders: 2, runs: 2 });
    deepStrictEqual(orders, [orderId(3), orderId(4)]);
    deepStrictEqual(runs, []);
    strictEqual(usage.lastSweepAt, NOW);
  });
});

describe("OrderRepository.sweepExpiredOrders, the retention sweep", () => {
  it("the retention sweep deletes an order with its open runs and records no close", async () => {
    const { swept, runs, tasks } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* upsert(
          repository,
          anOrder({ id: orderId(1), processedAt: EXPIRED }),
          [],
        );
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
        return {
          swept,
          runs: yield* count("Run"),
          tasks: yield* count("RunTask"),
        };
      }),
    );
    strictEqual(swept.runs, 1);
    strictEqual(runs, 0);
    // Deleted, not closed: no row is left to carry a reason, and no
    // closed run reaches a member's Done or closed view.
    strictEqual(tasks, 0);
  });
});

describe("OrderRepository retention", () => {
  it("an order older than retention is never stored again", async () => {
    const { expired, kept, aged, orders } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const sql = yield* SqlClient.SqlClient;
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
          anOrder({
            id: orderId(3),
            processedAt: EXPIRED,
            updatedAt: NOW,
            syncedAt: NOW,
          }),
          [],
        );
        const orders = (yield* sql`select id from ShopOrder order by id`
          .values).map((row) => String(row[0]));
        return { expired, kept, aged, orders };
      }),
    );
    deepStrictEqual(expired, {
      written: false,
      fresh: false,
      refused: false,
      afterWrite: Option.none(),
    });
    strictEqual(kept.written, true);
    strictEqual(aged.written, true);
    deepStrictEqual(orders, [orderId(2), orderId(3)]);
  });
});

describe("OrderRepository sync state", () => {
  it("records the last error and nothing else", async () => {
    const { idle, failed } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const idle = yield* repository.getSyncState();
        const failed = yield* repository.setSyncError({
          error: "bulk submit failed",
        });
        return { idle, failed };
      }),
    );
    deepStrictEqual(idle, { lastError: null });
    deepStrictEqual(failed, { lastError: "bulk submit failed" });
  });

  it("clears the error the next sync is about to supersede", async () => {
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

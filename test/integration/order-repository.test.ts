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
  productTags: ["engraved"],
  matchedWorkflowIds: [],
  properties: [{ key: "text", value: "Hello" }],
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

/** Drains the outbox so a later assertion is about what happened *after* it. */
const flushed = () =>
  Effect.gen(function* () {
    return yield* (yield* OrderRepository).flushUsageEvents(
      "shop.myshopify.com",
    );
  }).pipe(Effect.provide(acceptingAppEvents));

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
   * The guard that lets a retried webhook, a mid-stream bulk line, and a manual
   * resync all write the same row in any order.
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
          status: null,
          need: null,
          team: null,
          teams: [],
        });
        return {
          first,
          second: yield* repository.listOrders({
            limit: 2,
            cursor: first.nextCursor,
            q: null,
            status: null,
            need: null,
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
 * Every SQL fragment against `Domain.productionState` and `Domain.orderNeeds`:
 * the fixture covers each branch, and each filter must return exactly the
 * names the TypeScript functions give that status or need. Runs are written
 * directly because `RunRepository` is not in this test's layer and
 * the filters only read status. `#1005`, `#1009`, `#1010` and `#1012` are
 * open with no open and no done run: `to_make`. `#1010`'s only run is
 * closed, which still reads `to_make` but decides the item, so it is not
 * `no_workflow`.
 *
 * `#1012` and `#1013` are the ambiguity cases, written with
 * `matchedWorkflowIds` directly because reconcile is the only writer of that
 * column and this test has no `RunRepository`. `#1013` has an open
 * run *and* an item still waiting on a choice: `making` with need
 * `choose_workflow`. Between them they are also the proof that
 * `json_array_length` exists in Durable Object SQLite — every
 * `AMBIGUOUS_ITEM` fragment would throw without it.
 */
const seedStates = Effect.gen(function* () {
  const repository = yield* OrderRepository;
  const sql = yield* SqlClient.SqlClient;
  const cases: readonly {
    readonly n: number;
    readonly order?: Partial<Domain.ShopOrder>;
    readonly statuses: readonly Domain.RunStatus[];
    /** Written onto the order's own item; two or more with no run on it is ambiguous. */
    readonly matched?: readonly string[];
  }[] = [
    { n: 1, statuses: ["done"] }, // made
    { n: 2, statuses: ["done", "closed"] }, // made
    { n: 3, statuses: ["done", "active"] }, // making
    { n: 4, statuses: ["done", "active"] }, // making
    { n: 5, statuses: [] }, // to make, needs a workflow
    { n: 6, order: { cancelledAt: 5 }, statuses: ["done"] }, // cancelled
    { n: 7, order: { fulfillmentStatus: "FULFILLED" }, statuses: ["done"] }, // fulfilled
    { n: 8, statuses: ["done", "done"] }, // made
    { n: 9, order: { fullyPaid: false }, statuses: [] }, // to make, unpaid: no need
    { n: 10, statuses: ["closed"] }, // to make, and decided: no need
    { n: 11, order: { fulfillmentStatus: "FULFILLED" }, statuses: [] }, // fulfilled, never started
    { n: 12, statuses: [], matched: ["w1", "w2"] }, // to make, choose a workflow
    { n: 13, statuses: ["active"], matched: ["w1", "w2"] }, // making, and choose a workflow
    // Unpaid: the ambiguity is not a choice yet, so no need.
    {
      n: 14,
      order: { fullyPaid: false },
      statuses: ["active"],
      matched: ["w1", "w2"],
    }, // making
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
        insert into Run (
          id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
          lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
          source, status, closedAt, closedReason, createdAt, updatedAt
        ) values (
          ${`run-${String(n)}-${String(index)}`}, 'wf', 'Workflow',
          ${orderId(n)}, ${`#10${String(n).padStart(2, "0")}`}, 0,
          ${`${lineItemId(n)}-${String(index)}`}, 'Item', null, null, 1,
          '[]', 'tag', ${status}, ${status === "closed" ? 1 : null},
          ${status === "closed" ? "merchant_cancelled" : null}, 0, 0
        )
      `;
  }
  return repository;
});

/**
 * `seedStates` plus the needs it lacks, and a team to filter on: `#1003`'s
 * open run is blocked and `#1004`'s open run has a task on a team that has
 * left the roster. Ready
 * tasks on Cut hang off `#1013` and `#1014`, so the team filter crosses
 * both rows.
 */
const seedNeeds = Effect.gen(function* () {
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
  const teams = Schema.decodeUnknownSync(Schema.Array(Domain.TeamRoster))([
    { id: "team-cut", name: "Cut", memberCount: 1 },
  ]);
  const list = (
    status: Domain.OrdersStatus | null,
    need: Domain.OrderNeed | null = null,
    team: Domain.TeamId | null = null,
  ) =>
    repository.listOrders({
      limit: 20,
      cursor: null,
      q: null,
      status,
      need,
      team,
      teams,
    });
  return { list };
});

describe("OrderRepository.listOrders filters", () => {
  it("each status returns exactly the orders productionState gives that status, and an order whose only run is closed reads to make", async () => {
    const pages = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const list = (status: Domain.OrdersStatus | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            status,
            need: null,
            team: null,
            teams: [],
          });
        return {
          open: yield* list(null),
          all: yield* list("all"),
          to_make: yield* list("to_make"),
          making: yield* list("making"),
          made: yield* list("made"),
          fulfilled: yield* list("fulfilled"),
          cancelled: yield* list("cancelled"),
        };
      }),
    );
    strictEqual(pages.all.orders.length, 14);
    deepStrictEqual(names(pages.to_make), ["#1012", "#1010", "#1009", "#1005"]);
    // `#1013`: one item being made beside one waiting on a choice. It is
    // making, with the choice as a need.
    deepStrictEqual(names(pages.making), ["#1014", "#1013", "#1004", "#1003"]);
    deepStrictEqual(names(pages.made), ["#1008", "#1002", "#1001"]);
    deepStrictEqual(names(pages.fulfilled), ["#1011", "#1007"]);
    deepStrictEqual(names(pages.cancelled), ["#1006"]);
    // The SQL and the TypeScript agree row by row.
    for (const row of pages.all.orders) {
      const status = Domain.productionState(row);
      for (const position of Domain.ProductionState.literals)
        strictEqual(
          names(pages[position]).includes(row.order.name),
          status === position,
          `${row.order.name} as ${status} under ${position}`,
        );
    }
  });

  it("each need returns exactly the orders orderNeeds includes it in", async () => {
    const pages = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedNeeds;
        return {
          all: yield* list("all"),
          no_workflow: yield* list("all", "no_workflow"),
          choose_workflow: yield* list("all", "choose_workflow"),
          team: yield* list("all", "team"),
          blocked: yield* list("all", "blocked"),
        };
      }),
    );
    // `#1010`'s only run was closed: decided, so not `no_workflow`.
    deepStrictEqual(names(pages.no_workflow), ["#1005"]);
    // `#1013` again: making and choosing at once.
    deepStrictEqual(names(pages.choose_workflow), ["#1013", "#1012"]);
    deepStrictEqual(names(pages.team), ["#1004"]);
    deepStrictEqual(names(pages.blocked), ["#1003"]);
    for (const row of pages.all.orders)
      for (const need of Domain.OrderNeed.literals)
        strictEqual(
          names(pages[need]).includes(row.order.name),
          Domain.orderNeeds(row).includes(need),
          `${row.order.name} under ${need}`,
        );
  });

  /**
   * `Domain.OrderCounts`, checked as the rule itself: for every combination
   * of status, need and team, each count equals the length of the list its
   * button would show. `fulfilled` is a status with no open orders, so
   * every need count under it is zero while the status counts are unchanged.
   */
  it("a count is what pressing that button would show, given every other filter", async () => {
    const checks = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedNeeds;
        const statuses = [
          null,
          "to_make",
          "making",
          "made",
          "fulfilled",
          "all",
        ] as const;
        const needs = [null, ...Domain.OrderNeed.literals] as const;
        const teams = [null, aTeamId("team-cut")] as const;
        const out: {
          readonly label: string;
          readonly count: number;
          readonly shown: number;
        }[] = [];
        for (const status of statuses)
          for (const need of needs)
            for (const team of teams) {
              const { counts } = yield* list(status, need, team);
              const label = `${String(status)}/${String(need)}/${String(team)}`;
              for (const position of ["to_make", "making", "made"] as const)
                out.push({
                  label: `${label}: ${position}`,
                  count: counts[position],
                  shown: (yield* list(position, need, team)).orders.length,
                });
              for (const other of Domain.OrderNeed.literals)
                out.push({
                  label: `${label}: ${other}`,
                  count: counts[other],
                  shown: (yield* list(status, other, team)).orders.length,
                });
            }
        return { out, fulfilled: (yield* list("fulfilled")).counts };
      }),
    );
    for (const { label, count, shown } of checks.out)
      strictEqual(count, shown, label);
    deepStrictEqual(checks.fulfilled, {
      to_make: 4,
      making: 4,
      made: 3,
      no_workflow: 0,
      choose_workflow: 0,
      team: 0,
      blocked: 0,
    });
  });

  it("counts cross the two rows: needs under a status, statuses under a need, all under a team", async () => {
    const { open, production, blocked, cut } = await runInRepository(
      Effect.gen(function* () {
        const { list } = yield* seedNeeds;
        return {
          open: (yield* list(null)).counts,
          production: (yield* list("making")).counts,
          blocked: (yield* list(null, "blocked")).counts,
          cut: (yield* list(null, null, aTeamId("team-cut"))).counts,
        };
      }),
    );
    deepStrictEqual(open, {
      to_make: 4,
      making: 4,
      made: 3,
      no_workflow: 1,
      choose_workflow: 2,
      team: 1,
      blocked: 1,
    });
    // Status counts ignore their own row; need counts are narrowed by it.
    deepStrictEqual(production, {
      to_make: 4,
      making: 4,
      made: 3,
      no_workflow: 0,
      choose_workflow: 1,
      team: 1,
      blocked: 1,
    });
    deepStrictEqual(blocked, { ...open, to_make: 0, making: 1, made: 0 });
    // Cut holds `#1013` and `#1014`, both making.
    deepStrictEqual(cut, {
      to_make: 0,
      making: 2,
      made: 0,
      no_workflow: 0,
      choose_workflow: 1,
      team: 0,
      blocked: 0,
    });
  });

  /**
   * Retention keeps a year of orders, so the list a merchant opens is the
   * bench, not the year; `"all"` is the only way to the closed ones
   * (`Domain.OrdersStatus`).
   */
  it("lists open orders by default and everything under all", async () => {
    const { open, all } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const list = (status: Domain.OrdersStatus | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            status,
            need: null,
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
    // Every open position is still in the default view, and nothing else is.
    for (const row of open.orders)
      strictEqual(
        Domain.productionState(row) !== "fulfilled" &&
          Domain.productionState(row) !== "cancelled",
        true,
        row.order.name,
      );
  });

  it("a need under All narrows to open orders", async () => {
    const page = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedStates;
        const sql = yield* SqlClient.SqlClient;
        // A stale block on a fulfilled order's run is not a to-do.
        yield* sql`update Run set status = 'active', blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-7-0'`;
        return yield* repository.listOrders({
          limit: 20,
          cursor: null,
          q: null,
          status: "all",
          need: "blocked",
          team: null,
          teams: [],
        });
      }),
    );
    deepStrictEqual(names(page), []);
  });

  /**
   * `RunCounts.blocked` counts open runs only, and `RunCounts.closed` counts
   * closed runs whatever the order. A done run carries no block (the data
   * model on `initializeSchema`, `ShopAgentSchema.ts`), so no done run is
   * blocked here.
   */
  it("counts a block on open runs only, and counts closed runs", async () => {
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
            status: null,
            need: null,
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
      closed: 0,
    });
    deepStrictEqual(runsOf("#1001"), {
      open: 0,
      done: 1,
      blocked: 0,
      closed: 0,
    });
    deepStrictEqual(runsOf("#1002"), {
      open: 0,
      done: 1,
      blocked: 0,
      closed: 1,
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
        status: null,
        need: null,
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

  it("narrows the counts to the search", async () => {
    const { all, searched } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* seedNames;
        const sql = yield* SqlClient.SqlClient;
        // Paid with no runs: each order needs a workflow, so each is counted.
        yield* sql`update ShopOrder set fullyPaid = 1`;
        const list = (q: Domain.OrderSearch | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q,
            status: null,
            need: null,
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
    strictEqual(all.counts.no_workflow, 3);
    strictEqual(searched.counts.no_workflow, 1);
  });
});

describe("OrderRepository.listOrders need team", () => {
  /**
   * `Domain.OrderRow.attention` against a roster the test hands in: #3's
   * active run has an open task on a deleted team, #4's unstarted run has a
   * current task on an empty team, #1's done run keeps a stale pointer on
   * a done task and never counts, and #8 is healthy.
   */
  it("keeps only orders with an unassigned or unstaffed open task, and counts them", async () => {
    const teams = Schema.decodeUnknownSync(Schema.Array(Domain.TeamRoster))([
      { id: "team-cut", name: "Cut", memberCount: 1 },
      { id: "team-empty", name: "Polish", memberCount: 0 },
    ]);
    const { all, only } = await runInRepository(
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
            (id, runId, position, step, name, teamId, teamName, doneAt)
          values (${id}, ${runId}, ${step}, ${step}, 'Task', ${teamId}, 'Team', ${doneAt})
        `;
        yield* task("s3", "run-3-1", 1, "team-gone", null);
        yield* task("s4a", "run-4-1", 1, "team-cut", 1);
        yield* task("s4b", "run-4-1", 2, "team-empty", null);
        yield* task("s1", "run-1-0", 1, "team-gone", 1);
        yield* task("s8", "run-8-0", 1, "team-cut", 1);
        const list = (need: Domain.OrderNeed | null) =>
          repository.listOrders({
            limit: 20,
            cursor: null,
            q: null,
            status: null,
            need,
            team: null,
            teams,
          });
        return { all: yield* list(null), only: yield* list("team") };
      }),
    );
    deepStrictEqual(
      all.orders.filter((row) => row.attention).map((row) => row.order.name),
      ["#1004", "#1003"],
    );
    deepStrictEqual(names(only), ["#1004", "#1003"]);
    strictEqual(all.counts.team, 2);
    strictEqual(only.counts.team, 2);
  });
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
  const teams = Schema.decodeUnknownSync(Schema.Array(Domain.TeamRoster))([
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
          (id, runId, position, step, name, teamId, teamName, doneAt)
        values (${id}, ${runId}, ${position}, ${step}, 'Task', ${team}, 'Team', ${doneAt})
      `;
    };
    /* #1003: two open item runs both current on Cut, so the id is distinct
       across runs; the done run's task is on Cut too, and a run that is over
       holds nobody up. */
    yield* sql`
      insert into Run (
        id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
        lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
        source, status, createdAt, updatedAt
      ) values (
        'run-3-2', 'wf', 'Workflow', ${orderId(3)}, '#1003', 0,
        ${`${lineItemId(3)}-2`}, 'Item', null, null, 1, '[]', 'tag', 'active',
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
    const list = (
      team: Domain.TeamId | null = null,
      status: Domain.OrdersStatus | null = null,
    ) =>
      repository.listOrders({
        limit: 20,
        cursor: null,
        q: null,
        status,
        need: null,
        team,
        teams,
      });
    return { sql, task, list };
  });

  /**
   * `#1007` is fulfilled and `#1006` cancelled. Reconcile closes every open
   * run on a closed order, but the rule does not lean on that: each is given
   * a leftover active run with an unassigned current task and a current task on
   * Cut, and neither order has a need or waits on anyone, in the cell or
   * under the filter, whichever status is showing.
   */
  it("a fulfilled or cancelled order has no needs and waits on no team", async () => {
    const { all, cut, needs } = await runInRepository(
      Effect.gen(function* () {
        const { sql, task, list } = yield* waitingFixture;
        yield* sql`update Run set status = 'active', blockedAt = 1, blockedBy = '{"role":"merchant"}' where id = 'run-7-0'`;
        yield* sql`update Run set status = 'active' where id = 'run-6-0'`;
        yield* task("s7", "run-7-0", 1, "team-cut");
        yield* task("s6", "run-6-0", 1, "team-cut");
        yield* task("s6b", "run-6-0", 1, "team-gone");
        const repository = yield* OrderRepository;
        return {
          all: yield* list(null, "all"),
          cut: yield* list(aTeamId("team-cut"), "all"),
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach, not Array#forEach; the third argument is options
          needs: yield* Effect.forEach(Domain.OrderNeed.literals, (need) =>
            repository.listOrders({
              limit: 20,
              cursor: null,
              q: null,
              status: "all",
              need,
              team: null,
              teams: [],
            }),
          ),
        };
      }),
    );
    for (const name of ["#1007", "#1006"]) {
      deepStrictEqual(waitingOf(all, name), []);
      const row = rowOf(all, name);
      strictEqual(row === undefined ? null : Domain.orderNeeds(row).length, 0);
      for (const page of needs) strictEqual(names(page).includes(name), false);
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

  it("leaves out a team that has left the roster, which is attention instead", async () => {
    const page = await runInRepository(
      Effect.gen(function* () {
        const { sql, list } = yield* waitingFixture;
        yield* sql`update RunTask set teamId = 'team-gone' where id in ('s3a', 's3e')`;
        return yield* list();
      }),
    );
    deepStrictEqual(waitingOf(page, "#1003"), []);
    strictEqual(rowOf(page, "#1003")?.attention, true);
  });

  /**
   * The filter is the column's membership test as a `where`, so the filtered
   * page is exactly the rows whose cell names the team — and the counts are
   * narrowed to it, as `Domain.OrderCounts` says of every other filter.
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
      to_make: 0,
      making: 0,
      made: 0,
      no_workflow: 0,
      choose_workflow: 0,
      team: 0,
      blocked: 0,
    };
    deepStrictEqual(cut.counts, { ...none, making: 2 });
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

describe("OrderRepository.recordWebhookDelivery", () => {
  it("reports the first delivery as new and a redelivery as seen", async () => {
    const [first, second] = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        const delivery = {
          webhookId: "wh-1",
          topic: "orders/paid",
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
          topic: "orders/paid",
          orderId: orderId(1),
          triggeredAt: 0,
          receivedAt:
            now -
            (Domain.ShopLimits.webhookDeliveryRetentionDays + 1) * 86_400_000,
        });
        yield* repository.recordWebhookDelivery({
          webhookId: "wh-new",
          topic: "orders/paid",
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

  it("opens a provisional cycle before a billing period is known", async () => {
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

  it("a manual run start past the cycle end counts into the new cycle", async () => {
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

  it("recounts the cycle from the orders when a new period is pushed", async () => {
    const usage = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* upsert(repository, paid(2), []);
        yield* count(repository, 1);
        yield* count(repository, 2);
        // The next period: the two above fall outside it and drop out.
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
        yield* repository.countOrder(
          `${Domain.SEED_ORDER_ID_PREFIX}1`,
          CYCLE_START,
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

  it("a queued event is dead once the cycle that dated it has ended: skipped by the flush and reported apart", async () => {
    const { flush, usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycle(repository);
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
        // Refused through the end of the period, then the period rolls.
        yield* repository
          .flushUsageEvents("shop.myshopify.com")
          .pipe(Effect.provide(refusingAppEvents));
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
          memberCount: 0,
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
        yield* count(repository, 2, CYCLE_END);
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
        yield* count(repository, 1);
        yield* count(repository, 2);
        // The trial ends and the first real period starts after both.
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
    strictEqual(usage.deadUsageEvents, 0);
    deepStrictEqual(events, []);
  });

  it("the ceiling counts orders work started on, not orders stored: a new order is refused at it and a stored one still updates", async () => {
    const limits = Domain.ShopLimits as { maxOrdersPerCycle: number };
    const original = limits.maxOrdersPerCycle;
    limits.maxOrdersPerCycle = 1;
    try {
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
      deepStrictEqual(first, { written: true, fresh: true, refused: false });
      deepStrictEqual(uncounted, {
        written: true,
        fresh: true,
        refused: false,
      });
      deepStrictEqual(second, { written: false, fresh: false, refused: true });
      deepStrictEqual(third, { written: true, fresh: false, refused: false });
      strictEqual(usage.ordersThisCycle, 1);
      strictEqual(usage.ordersLimitedAt !== null, true);
    } finally {
      limits.maxOrdersPerCycle = original;
    }
  });

  it("deleteSeedOrders clears the limited flag when giving the count back leaves the cycle under the ceiling", async () => {
    const limits = Domain.ShopLimits as { maxOrdersPerCycle: number };
    const original = limits.maxOrdersPerCycle;
    limits.maxOrdersPerCycle = 1;
    try {
      const { limited, usage } = await runInRepository(
        Effect.gen(function* () {
          const repository = yield* OrderRepository;
          yield* openCycle(repository);
          const seedId = `${Domain.SEED_ORDER_ID_PREFIX}1`;
          yield* upsert(repository, paid(1, { id: seedId }), []);
          yield* repository.countOrder(seedId, CYCLE_START);
          yield* upsert(repository, paid(2), []);
          const limited = yield* repository.getUsage();
          yield* repository.deleteSeedOrders();
          return { limited, usage: yield* repository.getUsage() };
        }),
      );
      strictEqual(limited.ordersLimitedAt !== null, true);
      strictEqual(usage.ordersThisCycle, 0);
      strictEqual(usage.ordersLimitedAt, null);
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

  const openCycleWithRoster = (
    repository: typeof OrderRepository.Service,
    memberCount: number,
  ) =>
    repository.setBillingCycle({
      shopGid,
      cycleStartAt: CYCLE_START,
      cycleEndAt: CYCLE_END,
      memberCount,
    });

  it("an add past the high-water mark queues one seat event and raises the mark", async () => {
    const { queued, usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        const queued = yield* repository.recordRoster(
          { size: 4 },
          CYCLE_START + 1,
        );
        return {
          queued,
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    strictEqual(queued, 1);
    strictEqual(usage.membersHighWater, 4);
    deepStrictEqual(events, [
      {
        idempotencyKey: seatKey(CYCLE_START, 3),
        value: 3,
        occurredAt: CYCLE_START,
      },
      {
        idempotencyKey: seatKey(CYCLE_START, 4),
        value: 1,
        occurredAt: CYCLE_START + 1,
      },
    ]);
  });

  it("an add at or under the high-water mark queues nothing", async () => {
    const { queued, usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        const queued = [
          yield* repository.recordRoster({ size: 3 }, CYCLE_START + 1),
          yield* repository.recordRoster({ size: 2 }, CYCLE_START + 2),
        ];
        return {
          queued,
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    deepStrictEqual(queued, [0, 0]);
    strictEqual(usage.membersHighWater, 3);
    strictEqual(events.length, 1);
  });

  /**
   * A removal is never reported to the object, so what this pins is the
   * consequence: removing and re-adding inside a cycle bills the seat once,
   * and a revalidation that reads the smaller roster lowers nothing.
   */
  it("a member removal queues nothing and leaves the mark", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        yield* repository.recordRoster({ size: 4 }, CYCLE_START + 1);
        // Removed: the roster is 3 again, and a revalidation reads it.
        yield* openCycleWithRoster(repository, 3);
        // Re-added.
        yield* repository.recordRoster({ size: 4 }, CYCLE_START + 2);
        return {
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    strictEqual(usage.membersHighWater, 4);
    deepStrictEqual(
      events.map((event) => event.value),
      [3, 1],
    );
  });

  it("a new cycle resets the mark to the roster and queues it as the cycle's first seat event", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        yield* repository.recordRoster({ size: 5 }, CYCLE_START + 1);
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
    strictEqual(usage.membersHighWater, 4);
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
        yield* openCycleWithRoster(repository, 3);
        yield* openCycleWithRoster(repository, 3);
        return {
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    strictEqual(usage.membersHighWater, 3);
    strictEqual(events.length, 1);
  });

  it("an unchanged cycle raises the mark to a roster past it, so an add whose recordRoster failed is billed at the next revalidation", async () => {
    const { usage, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        yield* openCycleWithRoster(repository, 5);
        return {
          usage: yield* repository.getUsage(),
          events: yield* seatEvents(),
        };
      }),
    );
    strictEqual(usage.membersHighWater, 5);
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
   * `setBillingCycle`. The rolled cycle must still get its whole roster sent.
   */
  it("a cycle the counting path rolled forward starts with no seat mark, and the next roster report sends the whole roster", async () => {
    const { queued, events } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        const queued = yield* repository.recordRoster(
          { size: 3 },
          CYCLE_END + 1,
        );
        yield* repository.setBillingCycle({
          shopGid,
          cycleStartAt: CYCLE_END,
          cycleEndAt: null,
          memberCount: 3,
        });
        return { queued, events: yield* seatEvents() };
      }),
    );
    strictEqual(queued, 3);
    deepStrictEqual(
      events.map(({ idempotencyKey, value }) => ({ idempotencyKey, value })),
      [
        { idempotencyKey: seatKey(CYCLE_START, 3), value: 3 },
        { idempotencyKey: seatKey(CYCLE_END, 3), value: 3 },
      ],
    );
  });

  it("a new cycle supersedes seat events queued under a provisional cycle", async () => {
    const events = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* repository.recordRoster({ size: 3 }, CYCLE_START + 5);
        yield* openCycleWithRoster(repository, 3);
        return yield* seatEvents();
      }),
    );
    deepStrictEqual(events, [
      {
        idempotencyKey: seatKey(CYCLE_START, 3),
        value: 3,
        occurredAt: CYCLE_START,
      },
    ]);
  });

  it("the flush sends each event under its own meter handle", async () => {
    const sent = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 2);
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

  it("seat events survive deleteSeedOrders", async () => {
    const events = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        yield* repository.deleteSeedOrders();
        return yield* seatEvents();
      }),
    );
    strictEqual(events.length, 1);
  });

  it("the members drift check tolerates pending seat events", async () => {
    const { pending, drained } = await runInRepository(
      Effect.gen(function* () {
        const repository = yield* OrderRepository;
        yield* openCycleWithRoster(repository, 3);
        yield* upsert(repository, paid(1), []);
        yield* count(repository, 1);
        // Shopify has seen nothing yet: both meters read zero.
        const pending = yield* repository.reconcileUsage({
          orders: 0,
          members: 0,
        });
        yield* flushed();
        const drained = yield* repository.reconcileUsage({
          orders: 0,
          members: 0,
        });
        return { pending, drained };
      }),
    );
    strictEqual(pending.pendingMemberUnits, 3);
    strictEqual(pending.pendingOrderUnits, 1);
    strictEqual(
      Domain.meterDiverges({
        local: pending.membersHighWater,
        shopify: 0,
        pending: pending.pendingMemberUnits,
      }),
      false,
    );
    // Drained and still unreported: now it is a divergence.
    strictEqual(
      Domain.meterDiverges({
        local: drained.membersHighWater,
        shopify: 0,
        pending: drained.pendingMemberUnits,
      }),
      true,
    );
    strictEqual(drained.lastReconciledMembers, 0);
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
      insert into Run (
        id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
        lineItemId, lineItemTitle, variantTitle, sku, quantity,
        lineItemProperties, source, status, createdAt, updatedAt
      ) values (
        ${`run-${orderId}-${status}`}, 'wf', 'Workflow', ${orderId}, '#1',
        0, ${`li-${orderId}`}, 'Item', null, null, 1, '[]', 'tag',
        ${status}, ${updatedAt}, ${updatedAt}
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
        yield* runWith(orderId(2), "active", EXPIRED)(sql);
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
        // A run whose order is no longer stored, last touched long ago.
        yield* runWith("gid://shopify/Order/999", "done", EXPIRED)(sql);
        const swept = yield* repository.sweepExpiredOrders({ now: NOW });
        const orders = (yield* sql`select id from ShopOrder order by id`
          .values).map((row) => String(row[0]));
        const runs = (yield* sql`select id from Run order by id`.values).map(
          (row) => String(row[0]),
        );
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

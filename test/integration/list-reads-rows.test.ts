import { strictEqual } from "@effect/vitest/utils";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { RunRepository } from "@/lib/RunRepository";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

import { reconcileContext } from "./reconcile-context.ts";
import {
  type Executed,
  rowsReadSince,
  runInRepositoryCountingRows,
} from "./rows-read.ts";

/**
 * Rows read by the list reads on a loaded shop, the number Cloudflare bills.
 * Rows read are deterministic for a fixture, so the bounds are exact rules,
 * not timings. The fixture is the shape the bounds were measured on: 20
 * workflows of 3 tasks across 6 teams, 300 orders of 2 items, 30% fulfilled,
 * and every fourth order's runs started, one task done, or two tasks done.
 */

const teamId = Schema.decodeUnknownSync(Domain.TeamId);
const teamName = Schema.decodeUnknownSync(Domain.TeamName);
const email = Schema.decodeUnknownSync(Domain.Email);

const TEAMS = Array.from({ length: 6 }, (_, index) => ({
  id: teamId(`team-${String(index)}`),
  name: teamName(`Team ${String(index)}`),
}));
/** The member on two of the six teams, a third of them. */
const MEMBER_TEAMS = [TEAMS[0], TEAMS[1]].flatMap((team) =>
  team === undefined ? [] : [team.id],
);
const ORDERS = 300;
const NOW = Date.now();

const seed = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  const orders = yield* OrderRepository;
  const runs = yield* RunRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* workflows.replaceWorkflows(
    Schema.decodeUnknownSync(Domain.SeedWorkflowsInput)({
      workflows: Array.from({ length: 20 }, (_, w) => ({
        name: `Workflow ${String(w)}`,
        tag: `w${String(w)}`,
        state: "active",
        tasks: [0, 1, 2].map((t) => ({
          name: `Task ${String(t)}`,
          teamId: `team-${String((w + t) % TEAMS.length)}`,
        })),
      })),
    }),
  );
  const context = yield* reconcileContext(TEAMS);
  const actor = {
    role: "member",
    memberId: Schema.decodeUnknownSync(Domain.MemberId)("member-1"),
    email: email("member-1@example.com"),
  } satisfies Domain.MemberActor;
  for (let n = 0; n < ORDERS; n++) {
    const orderId = `gid://shopify/Order/${String(n)}`;
    yield* orders.upsertOrder({
      order: {
        id: orderId,
        legacyId: String(n),
        name: `#${String(1000 + n)}`,
        processedAt: NOW - (ORDERS - n) * 60_000,
        updatedAt: NOW,
        cancelledAt: null,
        fulfillmentStatus: n % 10 < 3 ? "FULFILLED" : "UNFULFILLED",
        fullyPaid: true,
        note: null,
        syncedAt: NOW,
      },
      lineItems: [0, 1].map((i) => ({
        id: `gid://shopify/LineItem/${String(n * 2 + i)}`,
        orderId,
        title: `Item ${String(n * 2 + i)}`,
        variantTitle: null,
        sku: null,
        quantity: 1,
        currentQuantity: 1,
        productTags: [`w${String((n * 2 + i) % 20)}`],
        properties: [],
      })),
      afterWrite: runs.reconcileOrder({ ...context, orderId }),
    });
    // 0: Ready, 1: started, 2: one task done, 3: two tasks done.
    const spread = n % 4;
    const details =
      spread === 0 ? [] : yield* runs.listRunsForOrder({ orderId });
    for (const [first, second] of details.map(({ tasks }) => tasks)) {
      if (first !== undefined && spread === 1)
        yield* runs.startTask({ runTaskId: first.id, actor });
      if (first !== undefined && spread >= 2)
        yield* runs.markTaskDone({ runTaskId: first.id, actor });
      if (second !== undefined && spread === 3)
        yield* runs.markTaskDone({ runTaskId: second.id, actor });
    }
  }
  const count = (query: string) =>
    sql.unsafe(query).values.pipe(Effect.map((rows) => Number(rows[0]?.[0])));
  return {
    openOrders: yield* count(
      "select count(*) from ShopOrder where fulfillmentStatus <> 'FULFILLED' and cancelledAt is null",
    ),
    openRuns: yield* count("select count(*) from Run where state = 'open'"),
  };
});

/** Rows read by `read`, from the statements it alone executed. */
const rowsReadBy = <A, E, R>(
  captured: readonly Executed[],
  read: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const from = captured.length;
    yield* read;
    return rowsReadSince(captured, from);
  });

describe("list reads, rows read", () => {
  it("the orders index default read reads at most 60 rows per open order", async () => {
    const { rows, openOrders } = await runInRepositoryCountingRows((captured) =>
      Effect.gen(function* () {
        const { openOrders } = yield* seed;
        const orders = yield* OrderRepository;
        const rows = yield* rowsReadBy(
          captured,
          orders.listOrders({
            // The orders index's page size.
            limit: 25,
            cursor: null,
            q: null,
            show: "open",
            team: null,
            teams: TEAMS,
          }),
        );
        return { rows, openOrders };
      }),
    );
    const perOrder = rows / openOrders;
    strictEqual(openOrders > 100, true);
    strictEqual(
      perOrder <= 60,
      true,
      `${String(rows)} rows for ${String(openOrders)} open orders: ${perOrder.toFixed(1)} per open order`,
    );
  });

  it("the workflows list read reads at most 12 rows per open run", async () => {
    const { rows, openRuns, items } = await runInRepositoryCountingRows(
      (captured) =>
        Effect.gen(function* () {
          const { openRuns } = yield* seed;
          const runs = yield* RunRepository;
          const from = captured.length;
          const items = yield* runs.runListItems(MEMBER_TEAMS);
          return { rows: rowsReadSince(captured, from), openRuns, items };
        }),
    );
    const perRun = rows / openRuns;
    strictEqual(items.length > 0, true);
    strictEqual(
      perRun <= 12,
      true,
      `${String(rows)} rows for ${String(openRuns)} open runs: ${perRun.toFixed(1)} per open run`,
    );
  });

  it("the Done count reads a day, not the table", async () => {
    const { rows, inWindow, tasks } = await runInRepositoryCountingRows(
      (captured) =>
        Effect.gen(function* () {
          yield* seed;
          const runs = yield* RunRepository;
          const sql = yield* SqlClient.SqlClient;
          const since = NOW - 24 * 60 * 60 * 1000;
          const rows = yield* rowsReadBy(
            captured,
            runs.listRecent({
              teamIds: MEMBER_TEAMS,
              since,
              limit: 0,
              q: null,
            }),
          );
          const teams = JSON.stringify(MEMBER_TEAMS);
          const [doneTasks] = yield* sql`
            select count(*) from RunTask
            where doneAt >= ${since}
              and teamId in (select value from json_each(${teams}))
          `.values;
          const [closedRuns] = yield* sql`
            select count(*) from Run where state = 'closed' and closedAt >= ${since}
          `.values;
          const [allTasks] = yield* sql`select count(*) from RunTask`.values;
          return {
            rows,
            inWindow: Number(doneTasks?.[0]) + Number(closedRuns?.[0]),
            tasks: Number(allTasks?.[0]),
          };
        }),
    );
    // Each counted row is read once from its index and its run is probed
    // once; the constant is the two statements' own overhead.
    const bound = 2 * inWindow + 10;
    strictEqual(
      rows <= bound,
      true,
      `${String(rows)} rows for ${String(inWindow)} rows in the window (bound ${String(bound)}, ${String(tasks)} run tasks stored)`,
    );
  });
});

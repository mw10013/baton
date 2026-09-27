import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { RunRepository } from "@/lib/RunRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

/**
 * The `schema` and `schema+app` rows of the data-model table on
 * `initializeSchema` (`src/lib/ShopAgentSchema.ts`). Each title is the row's
 * rule verbatim, which is what `pnpm action-table check` looks for. Each test
 * writes the forbidden row with raw SQL, bypassing the repositories, so it
 * proves the database refuses it and not merely that the write paths tried so
 * far avoid it.
 */

type Services =
  | OrderRepository
  | WorkflowRepository
  | RunRepository
  | SqlClient.SqlClient;

const runInRepository = <A, E>(
  program: Effect.Effect<A, E, Services>,
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
            Layer.mergeAll(WorkflowRepository.layer, RunRepository.layer).pipe(
              Layer.provideMerge(OrderRepository.layer),
              Layer.provideMerge(
                SqliteClient.layer({ storage: state.storage }),
              ),
            ),
          ),
        ),
      ),
  );

const TEAM = {
  id: Schema.decodeUnknownSync(Domain.TeamId)("team-a"),
  name: Schema.decodeUnknownSync(Domain.TeamName)("Team A"),
};
const ORDER_ID = "gid://shopify/Order/1";
const LINE_ITEM_ID = "gid://shopify/LineItem/1";
/** Ahead of the wall clock so the order is placed after the workflow is turned on. */
const PROCESSED_AT = Date.now() + 60 * 60 * 1000;

const order: Domain.ShopOrder = {
  id: ORDER_ID,
  legacyId: "1",
  name: "#1001",
  processedAt: PROCESSED_AT,
  updatedAt: PROCESSED_AT,
  cancelledAt: null,
  closedAt: null,
  financialStatus: "PAID",
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  lineItemsTruncated: false,
  syncedAt: PROCESSED_AT,
  syncSource: "webhook",
};

const lineItem: Domain.OrderLineItem = {
  id: LINE_ITEM_ID,
  orderId: ORDER_ID,
  productId: null,
  variantId: null,
  title: "Mug",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  productTags: ["mug"],
  matchedWorkflowIds: [],
  properties: [],
  requiresShipping: true,
};

/** One workflow tagged `mug` with one task on `TEAM`, applied and on, and one order whose item it starts a run on. */
const seedRun = Effect.gen(function* () {
  const workflows = yield* WorkflowRepository;
  const runs = yield* RunRepository;
  const orders = yield* OrderRepository;
  const workflow = yield* workflows.createWorkflow({
    name: Schema.decodeUnknownSync(Domain.WorkflowName)("Mugs"),
    tag: Schema.decodeUnknownSync(Domain.WorkflowTag)("mug"),
  });
  yield* workflows.addStep({
    workflowId: workflow.id,
    name: Schema.decodeUnknownSync(Domain.TaskName)("Glaze"),
    teamId: TEAM.id,
  });
  yield* workflows.applyDraft({ workflowId: workflow.id, teams: [TEAM] });
  yield* workflows.setWorkflowActive({
    workflowId: workflow.id,
    active: true,
    teams: [TEAM],
  });
  const context = {
    workflows: yield* workflows.listActiveWorkflowDetails(),
    teams: [TEAM],
  };
  yield* orders.upsertOrder({
    order,
    lineItems: [lineItem],
    afterWrite: runs
      .reconcileOrder({ ...context, orderId: ORDER_ID })
      .pipe(Effect.asVoid),
  });
  const [run] = yield* runs.listRunsForOrder({ orderId: ORDER_ID });
  if (run === undefined) throw new Error("no run");
  return { workflowId: workflow.id, runId: run.run.id };
});

/** A bare run row on `LINE_ITEM_ID`, no workflow or order behind it. */
const insertRun = (id: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`
        insert into Run (
          id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
          lineItemId, lineItemTitle, variantTitle, sku, quantity,
          lineItemProperties, source, status, createdAt, updatedAt
        ) values (
          ${id}, 'wf', 'Mugs', ${ORDER_ID}, '#1001', 0,
          ${LINE_ITEM_ID}, 'Mug', null, null, 1, '[]', 'manual', 'active', 0, 0
        )
      `,
    ),
  );

const count = (table: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`select count(*) as n from ${sql(table)}`.values,
    ),
    Effect.map(([row]) => Number(row?.[0])),
  );

describe("data model", () => {
  it("an item has exactly one order and goes with it", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orphan = yield* Effect.flip(sql`
          insert into OrderLineItem (
            id, orderId, title, quantity, currentQuantity, productTags,
            properties, requiresShipping
          ) values ('orphan', 'gid://shopify/Order/none', 'Mug', 1, 1, '[]', '[]', 1)
        `);
        strictEqual(orphan._tag, "SqlError");
        yield* (yield* OrderRepository).upsertOrder({
          order,
          lineItems: [lineItem],
          afterWrite: Effect.void,
        });
        strictEqual(yield* count("OrderLineItem"), 1);
        yield* sql`delete from ShopOrder where id = ${ORDER_ID}`;
        strictEqual(yield* count("OrderLineItem"), 0);
      }),
    ));

  it("a workflow is identified by its tag; no two workflows share one; the name is a label two may share", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const insert = (id: string, name: string, tag: string) => sql`
          insert into Workflow (id, name, tag, createdAt, updatedAt)
          values (${id}, ${name}, ${tag}, 0, 0)
        `;
        yield* insert("w1", "Mugs", "mug");
        const sameTag = yield* Effect.flip(insert("w2", "Cups", "mug"));
        strictEqual(sameTag._tag, "SqlError");
        yield* insert("w3", "Mugs", "cup");
        strictEqual(yield* count("Workflow"), 2);
      }),
    ));

  it("a workflow has at most one draft; the draft holds tasks only", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          insert into Workflow (id, name, tag, createdAt, updatedAt)
          values ('w1', 'Mugs', 'mug', 0, 0)
        `;
        const draft = sql`
          insert into WorkflowDraft (workflowId, createdAt, updatedAt)
          values ('w1', 0, 0)
        `;
        yield* draft;
        const second = yield* Effect.flip(draft);
        strictEqual(second._tag, "SqlError");
        // "Tasks only": the draft has no name, tag or switch of its own to
        // drift from the workflow's. The one place a column list belongs in a
        // test, because the rule is about what the draft does not hold.
        const columns = yield* sql<{
          readonly name: string;
        }>`select name from pragma_table_info('WorkflowDraft')`;
        deepStrictEqual(columns.map((column) => column.name).toSorted(), [
          "createdAt",
          "updatedAt",
          "workflowId",
        ]);
      }),
    ));

  it("a run snapshots its workflow, order and item and references none of them", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { workflowId, runId } = yield* seedRun;
        // Underneath the repositories: no key ties the run to any of the
        // three, so the database lets it outlive each. Retention deletes an
        // expired order's runs by a statement of its own, not by a key.
        yield* sql`delete from Workflow where id = ${workflowId}`;
        yield* sql`delete from ShopOrder where id = ${ORDER_ID}`;
        strictEqual(yield* count("OrderLineItem"), 0);
        const [run] = yield* sql<{
          readonly workflowName: string;
          readonly orderName: string;
          readonly lineItemTitle: string;
        }>`select workflowName, orderName, lineItemTitle from Run where id = ${runId}`;
        deepStrictEqual(run, {
          workflowName: "Mugs",
          orderName: "#1001",
          lineItemTitle: "Mug",
        });
        const [task] = yield* sql<{
          readonly name: string;
          readonly teamName: string;
        }>`select name, teamName from RunTask where runId = ${runId}`;
        deepStrictEqual(task, { name: "Glaze", teamName: "Team A" });
      }),
    ));

  it("a run's tasks go with it; only deleting the run deletes tasks", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const task = (
          id: string,
          runId: string,
          position: number,
          step: number,
        ) => sql`
          insert into RunTask (id, runId, position, step, name, teamName)
          values (${id}, ${runId}, ${position}, ${step}, 'Glaze', 'Team A')
        `;
        const orphan = yield* Effect.flip(task("orphan", "no-run", 1, 1));
        strictEqual(orphan._tag, "SqlError");
        yield* insertRun("r1");
        yield* task("t1", "r1", 1, 1);
        // The constraints that have no row of their own, so they are not
        // silent: positions and steps start at 1, and a reopen names its
        // actor's role.
        strictEqual(
          (yield* Effect.flip(task("t0", "r1", 0, 1)))._tag,
          "SqlError",
        );
        strictEqual(
          (yield* Effect.flip(task("t0", "r1", 2, 0)))._tag,
          "SqlError",
        );
        const reopen = yield* Effect.flip(
          sql`update RunTask set reopenedAt = 1 where id = 't1'`,
        );
        strictEqual(reopen._tag, "SqlError");
        strictEqual(yield* count("RunTask"), 1);
        yield* sql`delete from Run where id = 'r1'`;
        strictEqual(yield* count("RunTask"), 0);
      }),
    ));

  it("`closedAt` and `closedReason` are set together, once, and only on a closed run", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { runId } = yield* seedRun;
        const refused = [
          sql`update Run set closedAt = 1 where id = ${runId}`,
          sql`update Run set closedReason = 'merchant_cancelled' where id = ${runId}`,
          sql`update Run set status = 'closed' where id = ${runId}`,
        ];
        for (const write of refused)
          strictEqual((yield* Effect.flip(write))._tag, "SqlError");
        yield* (yield* RunRepository).cancelRun({ runId });
        const [run] = yield* sql<{
          readonly status: string;
          readonly closedAt: number | null;
          readonly closedReason: string | null;
        }>`select status, closedAt, closedReason from Run where id = ${runId}`;
        strictEqual(run?.status, "closed");
        strictEqual(typeof run?.closedAt, "number");
        strictEqual(run?.closedReason, "merchant_cancelled");
      }),
    ));

  it("only an open run can be blocked; a run that is done or closed carries no block", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* RunRepository;
        const { runId } = yield* seedRun;
        yield* runs.blockRun({
          runId,
          actor: { role: "merchant" },
          reason: null,
        });
        yield* runs.cancelRun({ runId });
        const [run] = yield* sql<{
          readonly blockedAt: number | null;
          readonly blockedBy: string | null;
        }>`select blockedAt, blockedBy from Run where id = ${runId}`;
        deepStrictEqual(run, { blockedAt: null, blockedBy: null });
        const blockClosed = yield* Effect.flip(sql`
          update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}'
          where id = ${runId}
        `);
        strictEqual(blockClosed._tag, "SqlError");
        yield* sql`delete from Run where id = ${runId}`;
        yield* insertRun("done");
        yield* sql`update Run set status = 'done' where id = 'done'`;
        const blockDone = yield* Effect.flip(sql`
          update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}'
          where id = 'done'
        `);
        strictEqual(blockDone._tag, "SqlError");
      }),
    ));

  it("`SyncState` and `ShopUsage` have exactly one row each", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        strictEqual(yield* count("SyncState"), 1);
        strictEqual(yield* count("ShopUsage"), 1);
        const syncState = yield* Effect.flip(
          sql`insert into SyncState (id) values (2)`,
        );
        strictEqual(syncState._tag, "SqlError");
        const shopUsage = yield* Effect.flip(
          sql`insert into ShopUsage (id) values (2)`,
        );
        strictEqual(shopUsage._tag, "SqlError");
      }),
    ));
});

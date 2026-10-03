import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { RunRepository } from "@/lib/RunRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

import { reconcileContext } from "./reconcile-context.ts";

/**
 * The `schema` and `schema+app` rows of the data-model table on
 * `initializeSchema` (`src/lib/ShopAgentSchema.ts`). Each title is the row's
 * rule verbatim, which is what `pnpm spec check` looks for. Each test
 * writes the forbidden row with raw SQL, bypassing the repositories, so it
 * proves the database refuses it and not merely that the write paths tried so
 * far avoid it. The last test holds the time rule on `EpochMillis` for every
 * table the migrations create.
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
/** The fixture's placed date; no rule compares it with a workflow. */
const PROCESSED_AT = Date.now() + 60 * 60 * 1000;

const order: Domain.ShopOrder = {
  id: ORDER_ID,
  legacyId: "1",
  name: "#1001",
  processedAt: PROCESSED_AT,
  updatedAt: PROCESSED_AT,
  cancelledAt: null,
  fulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  syncedAt: PROCESSED_AT,
};

const lineItem: Domain.OrderLineItem = {
  id: LINE_ITEM_ID,
  orderId: ORDER_ID,
  title: "Mug",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  productTags: ["mug"],
  properties: [],
};

/** One workflow tagged `mug` with one task on `TEAM`, applied and on, and one order whose item it creates a run on. */
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
  yield* workflows.setWorkflowOn({
    workflowId: workflow.id,
    on: true,
    teams: [TEAM],
  });
  const context = yield* reconcileContext([TEAM]);
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
          lineItemProperties, state, createdAt, updatedAt
        ) values (
          ${id}, 'wf', 'Mugs', ${ORDER_ID}, '#1001', 0,
          ${LINE_ITEM_ID}, 'Mug', null, null, 1, '[]', 'open', 0, 0
        )
      `,
    ),
  );

/** Rewrites the order with `items` under a newer `updatedAt` and reconciles it, as a sync does. */
const resync = (items: readonly Domain.OrderLineItem[], bump: number) =>
  Effect.gen(function* () {
    const runs = yield* RunRepository;
    const context = yield* reconcileContext([TEAM]);
    yield* (yield* OrderRepository).upsertOrder({
      order: { ...order, updatedAt: PROCESSED_AT + bump },
      lineItems: items,
      afterWrite: runs
        .reconcileOrder({ ...context, orderId: ORDER_ID })
        .pipe(Effect.asVoid),
    });
  });

/** The item's run row, read straight from the store. */
const runRow = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql<{
      readonly id: string;
      readonly state: string;
      readonly quantity: number;
      readonly closedReason: string | null;
    }>`
      select id, state, quantity, closedReason from Run
      where lineItemId = ${LINE_ITEM_ID}
    `,
  ),
  Effect.map(([row]) => row),
);

/** The actor columns of one run task, read straight from the store. */
const actorRow = (taskId: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{
        readonly startedAt: number | null;
        readonly startedByRole: string | null;
        readonly startedByEmail: string | null;
        readonly doneAt: number | null;
        readonly doneByRole: string | null;
        readonly doneByEmail: string | null;
      }>`
        select startedAt, startedByRole, startedByEmail, doneAt, doneByRole,
          doneByEmail
        from RunTask where id = ${taskId}
      `,
    ),
    Effect.map(([row]) => row),
  );

/** The one task of the seeded run. */
const taskOf = (runId: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          readonly id: string;
        }>`select id from RunTask where runId = ${runId}`,
    ),
    Effect.map(([row]) => row?.id ?? ""),
  );

const MEMBER = {
  role: "member",
  memberId: Schema.decodeUnknownSync(Domain.MemberId)("member-1"),
  email: Schema.decodeUnknownSync(Domain.Email)("maker@example.com"),
} satisfies Domain.MemberActor;
const MERCHANT = { role: "merchant" } satisfies Domain.Actor;

const count = (table: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`select count(*) as n from ${sql(table)}`.values,
    ),
    Effect.map(([row]) => Number(row?.[0])),
  );

/** Every workflow's tasks, counted across the `tasks` documents. */
const workflowTaskCount = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) =>
      sql`select coalesce(sum(json_array_length(tasks)), 0) as n from Workflow`
        .values,
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
            properties
          ) values ('orphan', 'gid://shopify/Order/none', 'Mug', 1, 1, '[]', '[]')
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

  it("a workflow is identified by its tag and by its name; no two workflows share either; the name is compared exactly", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const insert = (id: string, name: string, tag: string) => sql`
          insert into Workflow (id, name, tag, state, updatedAt)
          values (${id}, ${name}, ${tag}, 'off', 0)
        `;
        yield* insert("w1", "Mugs", "mug");
        const sameTag = yield* Effect.flip(insert("w2", "Cups", "mug"));
        strictEqual(sameTag._tag, "SqlError");
        const sameName = yield* Effect.flip(insert("w3", "Mugs", "cup"));
        strictEqual(sameName._tag, "SqlError");
        yield* insert("w4", "mugs", "cup");
        // The tag is compared exactly too: `Mug` is another tag than `mug`.
        yield* insert("w5", "Cups", "Mug");
        strictEqual(yield* count("Workflow"), 3);
        strictEqual(
          Schema.decodeUnknownSync(Domain.WorkflowTag)(" Mug "),
          "Mug",
        );
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
        // silent: positions and steps start at 1.
        strictEqual(
          (yield* Effect.flip(task("t0", "r1", 0, 1)))._tag,
          "SqlError",
        );
        strictEqual(
          (yield* Effect.flip(task("t0", "r1", 2, 0)))._tag,
          "SqlError",
        );
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
          sql`update Run set state = 'closed' where id = ${runId}`,
        ];
        for (const write of refused)
          strictEqual((yield* Effect.flip(write))._tag, "SqlError");
        yield* (yield* RunRepository).cancelRun({ runId });
        const [run] = yield* sql<{
          readonly state: string;
          readonly closedAt: number | null;
          readonly closedReason: string | null;
        }>`select state, closedAt, closedReason from Run where id = ${runId}`;
        strictEqual(run?.state, "closed");
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
        yield* sql`update Run set state = 'done' where id = 'done'`;
        const blockDone = yield* Effect.flip(sql`
          update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}'
          where id = 'done'
        `);
        strictEqual(blockDone._tag, "SqlError");
      }),
    ));

  it("turning a workflow off leaves its open runs open and deletes nothing", () =>
    runInRepository(
      Effect.gen(function* () {
        const workflows = yield* WorkflowRepository;
        const runs = yield* RunRepository;
        const { workflowId, runId } = yield* seedRun;
        yield* runs.startTask({
          runTaskId: yield* taskOf(runId),
          actor: MEMBER,
        });
        const before = {
          runs: yield* count("Run"),
          runTasks: yield* count("RunTask"),
          workflowTasks: yield* workflowTaskCount,
        };
        yield* workflows.setWorkflowOn({
          workflowId,
          on: false,
          teams: [TEAM],
        });
        yield* runs.reconcileAll(yield* reconcileContext([TEAM]));
        deepStrictEqual(
          {
            runs: yield* count("Run"),
            runTasks: yield* count("RunTask"),
            workflowTasks: yield* workflowTaskCount,
          },
          before,
        );
        strictEqual((yield* runRow)?.state, "open");
        strictEqual(
          (yield* actorRow(yield* taskOf(runId)))?.startedByRole,
          "member",
        );
      }),
    ));

  it("an open run's quantity follows its item, and a done or closed run's quantity is frozen", () =>
    runInRepository(
      Effect.gen(function* () {
        const runs = yield* RunRepository;
        const workflows = yield* WorkflowRepository;
        const { workflowId, runId } = yield* seedRun;
        yield* resync([{ ...lineItem, currentQuantity: 3 }], 1);
        strictEqual((yield* runRow)?.quantity, 3);
        yield* runs.cancelRun({ runId });
        yield* resync([{ ...lineItem, currentQuantity: 4 }], 2);
        deepStrictEqual(
          [(yield* runRow)?.state, (yield* runRow)?.quantity],
          ["closed", 3],
        );
        // A person replaces the closed run; the new one is done, then frozen.
        const { workflow, tasks } = Option.getOrThrow(
          yield* workflows.getWorkflow({ workflowId }),
        );
        const set = Option.getOrThrow(
          yield* runs.setRun({
            workflow: { workflow, tasks },
            teams: [TEAM],
            order,
            lineItem: { ...lineItem, currentQuantity: 4 },
          }),
        );
        yield* runs.markTaskDone({
          runTaskId: yield* taskOf(set.run.id),
          actor: MERCHANT,
        });
        yield* resync([{ ...lineItem, currentQuantity: 5 }], 3);
        deepStrictEqual(
          [(yield* runRow)?.state, (yield* runRow)?.quantity],
          ["done", 4],
        );
      }),
    ));

  it("a run is deleted only by its order's retention or by a person replacing it, and a replaced run leaves no history", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* RunRepository;
        const workflows = yield* WorkflowRepository;
        const { workflowId, runId } = yield* seedRun;
        const runIds = () =>
          sql<{ readonly id: string }>`select id from Run`.pipe(
            Effect.map((rows) => rows.map((row) => row.id)),
          );
        yield* runs.cancelRun({ runId });
        deepStrictEqual(yield* runIds(), [runId]);
        const { workflow, tasks } = Option.getOrThrow(
          yield* workflows.getWorkflow({ workflowId }),
        );
        const set = Option.getOrThrow(
          yield* runs.setRun({
            workflow: { workflow, tasks },
            teams: [TEAM],
            order,
            lineItem,
          }),
        );
        // Replaced: the old run and its tasks are gone, and nothing records it.
        deepStrictEqual(yield* runIds(), [set.run.id]);
        const [oldTasks] =
          yield* sql`select count(*) as n from RunTask where runId = ${runId}`
            .values;
        strictEqual(Number(oldTasks?.[0]), 0);
        // Nothing else deletes it: a workflow delete, its item at zero units,
        // a team delete's nulling.
        yield* workflows.deleteWorkflow({ workflowId });
        yield* resync([{ ...lineItem, currentQuantity: 0 }], 1);
        strictEqual((yield* runRow)?.closedReason, "item_removed");
        yield* workflows.unassignTeam({ teamId: TEAM.id });
        deepStrictEqual(yield* runIds(), [set.run.id]);
        // The order's retention does.
        const day = 24 * 60 * 60 * 1000;
        yield* (yield* OrderRepository).sweepExpiredOrders({
          now: PROCESSED_AT + (Domain.ShopLimits.orderRetentionDays + 1) * day,
        });
        deepStrictEqual(yield* runIds(), []);
        strictEqual(yield* count("RunTask"), 0);
      }),
    ));

  it("a run's state is recomputed by every task write in the same transaction, and closed is written, never derived", () =>
    runInRepository(
      Effect.gen(function* () {
        const runs = yield* RunRepository;
        const { runId } = yield* seedRun;
        const runTaskId = yield* taskOf(runId);
        const state = () => runRow.pipe(Effect.map((row) => row?.state));
        yield* runs.startTask({ runTaskId, actor: MEMBER });
        strictEqual(yield* state(), "open");
        yield* runs.markTaskDone({ runTaskId, actor: MEMBER });
        strictEqual(yield* state(), "done");
        yield* runs.reopenTask({ runTaskId, actor: MERCHANT });
        strictEqual(yield* state(), "open");
        yield* runs.markTaskDone({ runTaskId, actor: MERCHANT });
        yield* runs.reopenTask({ runTaskId, actor: MERCHANT });
        yield* runs.cancelRun({ runId });
        strictEqual(yield* state(), "closed");
        // Closed is not read off the tasks: a pass over the order leaves it.
        yield* resync([lineItem], 1);
        strictEqual(yield* state(), "closed");
      }),
    ));

  it("a run task's started and done times move with their roles, a member's email beside the role, and done implies started", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* RunRepository;
        const { runId } = yield* seedRun;
        const runTaskId = yield* taskOf(runId);
        // Underneath the repositories: each write breaks one pair.
        const refused = [
          sql`update RunTask set startedAt = 1 where id = ${runTaskId}`,
          sql`update RunTask set startedByRole = 'merchant' where id = ${runTaskId}`,
          sql`update RunTask set startedAt = 1, startedByRole = 'member' where id = ${runTaskId}`,
          sql`update RunTask set startedAt = 1, startedByRole = 'merchant', startedByEmail = 'a@x.com' where id = ${runTaskId}`,
          sql`update RunTask set startedByEmail = 'a@x.com' where id = ${runTaskId}`,
          sql`update RunTask set doneAt = 1, doneByRole = 'merchant' where id = ${runTaskId}`,
          sql`update RunTask set startedAt = 1, startedByRole = 'merchant', doneAt = 1 where id = ${runTaskId}`,
          sql`update RunTask set startedAt = 1, startedByRole = 'merchant', doneAt = 1, doneByRole = 'member' where id = ${runTaskId}`,
        ];
        for (const write of refused)
          strictEqual((yield* Effect.flip(write))._tag, "SqlError");
        // Through the write paths: Start, Put back, a Done with no Start.
        yield* runs.startTask({ runTaskId, actor: MEMBER });
        deepStrictEqual(
          yield* actorRow(runTaskId).pipe(
            Effect.map((row) => [row?.startedByRole, row?.startedByEmail]),
          ),
          ["member", MEMBER.email],
        );
        yield* runs.putBackTask({ runTaskId, actor: MERCHANT });
        deepStrictEqual(
          yield* actorRow(runTaskId).pipe(
            Effect.map((row) => [
              row?.startedAt,
              row?.startedByRole,
              row?.startedByEmail,
            ]),
          ),
          [null, null, null],
        );
        yield* runs.markTaskDone({ runTaskId, actor: MERCHANT });
        const done = yield* actorRow(runTaskId);
        strictEqual(typeof done?.doneAt, "number");
        strictEqual(done?.startedAt, done?.doneAt);
        deepStrictEqual(
          [
            done?.startedByRole,
            done?.startedByEmail,
            done?.doneByRole,
            done?.doneByEmail,
          ],
          ["merchant", null, "merchant", null],
        );
        // Reopen clears both pairs together.
        yield* runs.reopenTask({ runTaskId, actor: MEMBER });
        const reopened = yield* actorRow(runTaskId);
        deepStrictEqual(
          [
            reopened?.startedAt,
            reopened?.startedByRole,
            reopened?.doneAt,
            reopened?.doneByRole,
          ],
          [null, null, null, null],
        );
      }),
    ));

  it("a merchant act is recorded on the task with the role and no email, and no member row stands for the merchant", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* RunRepository;
        const { runId } = yield* seedRun;
        const runTaskId = yield* taskOf(runId);
        yield* runs.markTaskDone({ runTaskId, actor: MERCHANT });
        deepStrictEqual(
          yield* actorRow(runTaskId).pipe(
            Effect.map((row) => [row?.doneByRole, row?.doneByEmail]),
          ),
          ["merchant", null],
        );
        // An actor is a role and, for a member, an email: no column on a run
        // task names a member or a user, so nothing could point at a merchant.
        const columns = yield* sql<{
          readonly name: string;
        }>`select name from pragma_table_info('RunTask')`;
        deepStrictEqual(
          columns
            .map((column) => column.name)
            .filter((name) => /member|user|ById$/iu.test(name)),
          [],
        );
        const withEmail = yield* Effect.flip(sql`
          update RunTask set doneByEmail = 'owner@example.com' where id = ${runTaskId}
        `);
        strictEqual(withEmail._tag, "SqlError");
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

  it("Baton stores every time as epoch-ms integers in a column whose name ends in At", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // effect_sql_migrations is SqliteMigrator's own table; cf_* and _cf_*
        // are the agents SDK's and the runtime's.
        const tables = (yield* sql<{ readonly name: string }>`
          select name from sqlite_master where type = 'table'
        `)
          .map((row) => row.name)
          .filter(
            (name) =>
              !name.startsWith("sqlite_") &&
              !name.startsWith("_cf_") &&
              !name.startsWith("cf_") &&
              name !== "effect_sql_migrations",
          );
        const columns = (yield* Effect.all(
          tables.map((table) =>
            sql
              .unsafe<{
                readonly name: string;
                readonly type: string;
              }>(`select name, type from pragma_table_info('${table}')`)
              .pipe(
                Effect.map((rows) =>
                  rows.map((column) => ({ table, ...column })),
                ),
              ),
          ),
        ))
          .flat()
          .filter((column) => column.name.endsWith("At"));
        strictEqual(columns.length > 0, true);
        deepStrictEqual(
          columns.filter((column) => column.type.toLowerCase() !== "integer"),
          [],
        );
      }),
    ));
});

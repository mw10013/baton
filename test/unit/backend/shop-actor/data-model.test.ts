import { describe, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  makeOrderRepository,
  type OrderRepository as OrderRepositoryShape,
} from "../../../../src/backend/shop-actor/order-repository.ts";
import {
  makeRunRepository,
  type ReconcileContext,
  RunRepositoryError,
  type RunRepository as RunRepositoryShape,
} from "../../../../src/backend/shop-actor/run-repository.ts";
import { syncTransaction } from "../../../../src/backend/shop-actor/transaction.ts";
import {
  makeWorkflowRepository,
  type WorkflowRepository as WorkflowRepositoryShape,
} from "../../../../src/backend/shop-actor/workflow-repository.ts";
import * as Orders from "../../../../src/domain/orders.ts";
import * as Platform from "../../../../src/domain/platform.ts";
import * as ShopWork from "../../../../src/domain/shop-work.ts";
import { ActorSqliteTest } from "../layers.ts";
import { type AtCurrentRevision, atCurrentRevision } from "./current-revision.ts";

/**
 * The run rows of the actor's data model, over a fresh in-memory SQLite migrated by the actor's
 * own schema. Each test writes the forbidden row with raw SQL where it can, bypassing the
 * repositories, so it proves the database refuses it and not merely that the write paths tried
 * so far avoid it. Each repository is a test-local service, so a case yields it by its tag.
 */
class OrderRepository extends Context.Service<OrderRepository, OrderRepositoryShape>()(
  "test/OrderRepository",
) {}

class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  AtCurrentRevision<WorkflowRepositoryShape>
>()("test/WorkflowRepository") {}

class RunRepository extends Context.Service<RunRepository, RunRepositoryShape>()(
  "test/RunRepository",
) {}

/** Every `countOrder` call the run repository made, in order. */
class CountedOrders extends Context.Service<
  CountedOrders,
  Ref.Ref<ReadonlyArray<{ readonly orderId: string; readonly now: number }>>
>()("test/CountedOrders") {}

const RepositoriesTest = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = syncTransaction(sql);
    const counted = yield* Ref.make<
      ReadonlyArray<{ readonly orderId: string; readonly now: number }>
    >([]);
    return Context.make(OrderRepository, makeOrderRepository(sql, transaction)).pipe(
      Context.add(
        WorkflowRepository,
        (() => {
          const repository = makeWorkflowRepository(sql, transaction);
          return atCurrentRevision(repository, repository);
        })(),
      ),
      Context.add(
        RunRepository,
        makeRunRepository(sql, transaction, (orderId, now) =>
          Ref.update(counted, (calls) => [...calls, { orderId, now }]),
        ),
      ),
      Context.add(CountedOrders, counted),
    );
  }),
).pipe(Layer.provideMerge(ActorSqliteTest));

type Services =
  | OrderRepository
  | WorkflowRepository
  | RunRepository
  | CountedOrders
  | SqlClient.SqlClient;

const runInRepository = <A, E>(program: Effect.Effect<A, E, Services>) =>
  program.pipe(Effect.provide(RepositoriesTest));

/**
 * What a pass reads besides the stored order, wired the way `Runs.eligibleContext` wires it:
 * `teams`, and the workflows found by the order's tags through the workflow repository's
 * `listActiveWorkflowsByTags`.
 */
const reconcileContext = (teams: ShopWork.EligibleContext["teams"]) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowRepository;
    return {
      teams,
      workflowsByTags: (tags) =>
        workflows
          .listActiveWorkflowsByTags({ tags })
          .pipe(
            Effect.catchTag("WorkflowRepositoryError", (cause) =>
              Effect.fail(new RunRepositoryError({ message: cause.message, cause })),
            ),
          ),
    } satisfies ReconcileContext;
  });

const TEAM = {
  id: Schema.decodeUnknownSync(ShopWork.TeamId)("team-a"),
  name: Schema.decodeUnknownSync(ShopWork.TeamName)("Team A"),
};
const ORDER_ID = "gid://shopify/Order/1";
const LINE_ITEM_ID = "gid://shopify/LineItem/1";
/** The fixture's placed date; no rule compares it with a workflow. */
const PROCESSED_AT = Date.now() + 60 * 60 * 1000;

const order: Orders.ShopOrder = {
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

const lineItem: Orders.OrderLineItem = {
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
    name: Schema.decodeUnknownSync(ShopWork.WorkflowName)("Mugs"),
    tag: Schema.decodeUnknownSync(ShopWork.WorkflowTag)("mug"),
  });
  yield* workflows.addStep({
    workflowId: workflow.id,
    name: Schema.decodeUnknownSync(ShopWork.TaskName)("Glaze"),
    teamId: TEAM.id,
  });
  yield* workflows.applyDraft({ workflowId: workflow.id, teams: [TEAM] });
  yield* workflows.setWorkflowState({
    workflowId: workflow.id,
    state: "active",
    teams: [TEAM],
  });
  const context = yield* reconcileContext([TEAM]);
  yield* orders.upsertOrder({
    order,
    lineItems: [lineItem],
    afterWrite: runs.reconcileOrder({ ...context, orderId: ORDER_ID }).pipe(Effect.asVoid),
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
          lineItemProperties, state, currentStep, stepCount, createdAt, updatedAt
        ) values (
          ${id}, 'wf', 'Mugs', ${ORDER_ID}, '#1001', 0,
          ${LINE_ITEM_ID}, 'Mug', null, null, 1, '[]', 'open', 1, 1, 0, 0
        )
      `,
    ),
  );

/** Rewrites the order with `items` under a newer `updatedAt` and reconciles it, as a sync does. */
const resync = (items: readonly Orders.OrderLineItem[], bump: number) =>
  Effect.gen(function* () {
    const runs = yield* RunRepository;
    const context = yield* reconcileContext([TEAM]);
    yield* (yield* OrderRepository).upsertOrder({
      order: { ...order, updatedAt: PROCESSED_AT + bump },
      lineItems: items,
      afterWrite: runs.reconcileOrder({ ...context, orderId: ORDER_ID }).pipe(Effect.asVoid),
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
  memberId: Schema.decodeUnknownSync(ShopWork.MemberId)("member-1"),
  email: Schema.decodeUnknownSync(Platform.Email)("maker@example.com"),
} satisfies ShopWork.MemberActor;
const MERCHANT = { role: "merchant" } satisfies ShopWork.Actor;

const count = (table: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql`select count(*) as n from ${sql(table)}`.values),
    Effect.map(([row]) => Number(row?.[0])),
  );

/** Every workflow's tasks, counted across the `tasks` documents. */
const workflowTaskCount = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`select coalesce(sum(json_array_length(tasks)), 0) as n from Workflow`.values,
  ),
  Effect.map(([row]) => Number(row?.[0])),
);

describe("data model", () => {
  it.live("a run snapshots its workflow, order and item and references none of them", () =>
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
        deepStrictEqual(
          { ...run },
          {
            workflowName: "Mugs",
            orderName: "#1001",
            lineItemTitle: "Mug",
          },
        );
        const [task] = yield* sql<{
          readonly name: string;
          readonly teamName: string;
        }>`select name, teamName from RunTask where runId = ${runId}`;
        deepStrictEqual({ ...task }, { name: "Glaze", teamName: "Team A" });
      }),
    ),
  );

  it.live("a run's tasks go with it; only deleting the run deletes tasks", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const task = (id: string, runId: string, position: number, step: number) => sql`
          insert into RunTask (id, runId, position, step, name, teamName)
          values (${id}, ${runId}, ${position}, ${step}, 'Glaze', 'Team A')
        `;
        const orphan = yield* Effect.flip(task("orphan", "no-run", 1, 1));
        strictEqual(orphan._tag, "SqlError");
        yield* insertRun("r1");
        yield* task("t1", "r1", 1, 1);
        // The constraints that have no row of their own, so they are not
        // silent: positions and steps start at 1.
        strictEqual((yield* Effect.flip(task("t0", "r1", 0, 1)))._tag, "SqlError");
        strictEqual((yield* Effect.flip(task("t0", "r1", 2, 0)))._tag, "SqlError");
        strictEqual(yield* count("RunTask"), 1);
        yield* sql`delete from Run where id = 'r1'`;
        strictEqual(yield* count("RunTask"), 0);
      }),
    ),
  );

  it.live("`closedAt` and `closedReason` are set together, once, and only on a closed run", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { runId } = yield* seedRun;
        const refused = [
          sql`update Run set closedAt = 1 where id = ${runId}`,
          sql`update Run set closedReason = 'merchant_cancelled' where id = ${runId}`,
          sql`update Run set state = 'closed' where id = ${runId}`,
        ];
        for (const write of refused) strictEqual((yield* Effect.flip(write))._tag, "SqlError");
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
    ),
  );

  it.live("`currentStep` is the lowest open step on an open run and null on any other", () =>
    runInRepository(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* RunRepository;
        const { runId } = yield* seedRun;
        const currentStep = sql<{
          readonly currentStep: number | null;
        }>`select currentStep from Run where id = ${runId}`.pipe(
          Effect.map(([run]) => run?.currentStep),
        );
        strictEqual(yield* currentStep, 1);
        const cleared = yield* Effect.flip(
          sql`update Run set currentStep = null where id = ${runId}`,
        );
        strictEqual(cleared._tag, "SqlError");
        const [detail] = yield* runs.listRunsForOrder({ orderId: ORDER_ID });
        const runTaskId = detail?.tasks[0]?.id ?? "";
        yield* runs.markTaskDone({ runTaskId, actor: MERCHANT });
        strictEqual(yield* currentStep, null);
        yield* runs.reopenTask({ runTaskId, actor: MERCHANT });
        strictEqual(yield* currentStep, 1);
        yield* runs.cancelRun({ runId });
        strictEqual(yield* currentStep, null);
      }),
    ),
  );

  it.live("only an open run can be blocked; a run that is done or closed carries no block", () =>
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
        deepStrictEqual({ ...run }, { blockedAt: null, blockedBy: null });
        const blockClosed = yield* Effect.flip(sql`
          update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}'
          where id = ${runId}
        `);
        strictEqual(blockClosed._tag, "SqlError");
        yield* sql`delete from Run where id = ${runId}`;
        yield* insertRun("done");
        yield* sql`update Run set state = 'done', currentStep = null, startedAt = 1 where id = 'done'`;
        const blockDone = yield* Effect.flip(sql`
          update Run set blockedAt = 1, blockedBy = '{"role":"merchant"}'
          where id = 'done'
        `);
        strictEqual(blockDone._tag, "SqlError");
      }),
    ),
  );

  it.live("turning a workflow off leaves its open runs open and deletes nothing", () =>
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
        yield* workflows.setWorkflowState({
          workflowId,
          state: "inactive",
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
        strictEqual((yield* actorRow(yield* taskOf(runId)))?.startedByRole, "member");
      }),
    ),
  );

  it.live(
    "an open run's quantity follows its item, and a done or closed run's quantity is frozen",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const runs = yield* RunRepository;
          const workflows = yield* WorkflowRepository;
          const { workflowId, runId } = yield* seedRun;
          yield* resync([{ ...lineItem, currentQuantity: 3 }], 1);
          strictEqual((yield* runRow)?.quantity, 3);
          yield* runs.cancelRun({ runId });
          yield* resync([{ ...lineItem, currentQuantity: 4 }], 2);
          deepStrictEqual([(yield* runRow)?.state, (yield* runRow)?.quantity], ["closed", 3]);
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
          deepStrictEqual([(yield* runRow)?.state, (yield* runRow)?.quantity], ["done", 4]);
        }),
      ),
  );

  it.live(
    "a run is deleted only by its order's retention or by a person replacing it, and a replaced run leaves no history",
    () =>
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
          const [oldTasks] = yield* sql`select count(*) as n from RunTask where runId = ${runId}`
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
            now: PROCESSED_AT + (Platform.ShopLimits.orderRetentionDays + 1) * day,
          });
          deepStrictEqual(yield* runIds(), []);
          strictEqual(yield* count("RunTask"), 0);
        }),
      ),
  );

  it.live(
    "a run's state is recomputed by every task write in the same transaction, and closed is written, never derived",
    () =>
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
      ),
  );

  it.live(
    "a run's startedAt is the earliest task start, recomputed with its state by every task write, null when no task is started",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const runs = yield* RunRepository;
          const { runId } = yield* seedRun;
          const runTaskId = yield* taskOf(runId);
          const startedAt = () =>
            sql<{
              readonly startedAt: number | null;
            }>`select startedAt from Run where id = ${runId}`.pipe(
              Effect.map(([row]) => row?.startedAt),
            );
          const taskStartedAt = () => actorRow(runTaskId).pipe(Effect.map((row) => row?.startedAt));
          strictEqual(yield* startedAt(), null);
          yield* runs.startTask({ runTaskId, actor: MEMBER });
          const started = yield* taskStartedAt();
          strictEqual(typeof started, "number");
          strictEqual(yield* startedAt(), started);
          yield* runs.putBackTask({ runTaskId, actor: MERCHANT });
          strictEqual(yield* startedAt(), null);
          yield* runs.markTaskDone({ runTaskId, actor: MERCHANT });
          const backfilled = yield* taskStartedAt();
          strictEqual(typeof backfilled, "number");
          strictEqual(yield* startedAt(), backfilled);
          yield* runs.reopenTask({ runTaskId, actor: MERCHANT });
          strictEqual(yield* startedAt(), null);
          // A done run without a start is refused by the schema.
          yield* sql`delete from Run where id = ${runId}`;
          yield* insertRun("done");
          const doneUnstarted = yield* Effect.flip(
            sql`update Run set state = 'done', currentStep = null where id = 'done'`,
          );
          strictEqual(doneUnstarted._tag, "SqlError");
        }),
      ),
  );

  it.live(
    "a run task's started and done times move with their roles, a member's email beside the role, and done implies started",
    () =>
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
          for (const write of refused) strictEqual((yield* Effect.flip(write))._tag, "SqlError");
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
              Effect.map((row) => [row?.startedAt, row?.startedByRole, row?.startedByEmail]),
            ),
            [null, null, null],
          );
          yield* runs.markTaskDone({ runTaskId, actor: MERCHANT });
          const done = yield* actorRow(runTaskId);
          strictEqual(typeof done?.doneAt, "number");
          strictEqual(done?.startedAt, done?.doneAt);
          deepStrictEqual(
            [done?.startedByRole, done?.startedByEmail, done?.doneByRole, done?.doneByEmail],
            ["merchant", null, "merchant", null],
          );
          // Reopen clears both pairs together.
          yield* runs.reopenTask({ runTaskId, actor: MEMBER });
          const reopened = yield* actorRow(runTaskId);
          deepStrictEqual(
            [reopened?.startedAt, reopened?.startedByRole, reopened?.doneAt, reopened?.doneByRole],
            [null, null, null, null],
          );
        }),
      ),
  );

  it.live(
    "a merchant act is recorded on the task with the role and no email, and no member row stands for the merchant",
    () =>
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
            columns.map((column) => column.name).filter((name) => /member|user|ById$/iu.test(name)),
            [],
          );
          const withEmail = yield* Effect.flip(sql`
          update RunTask set doneByEmail = 'owner@example.com' where id = ${runTaskId}
        `);
          strictEqual(withEmail._tag, "SqlError");
        }),
      ),
  );
});

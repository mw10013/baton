/**
 * The shop actor's runs and their tasks over its SQLite: legacy's `RunRepository`, its eighteen
 * methods and nine errors. Legacy's SQL and rules, verbatim; `transaction` stands for legacy's
 * `sql.withTransaction`, and the billing meter is the `countOrder` argument.
 *
 * @module
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import * as Struct from "effect/Struct";
import {
  OrderLineItem,
  OrderState,
  orderIsCancelled,
  orderIsFulfilled,
  orderIsOpen,
  ShopOrder,
} from "../../domain/orders.ts";
import {
  type Actor,
  type ActorDisplay,
  type BlockRunCommand,
  type ClosedReason,
  type EligibleContext,
  type ListSearch,
  laterStepStarted,
  type MarkTaskDoneCommand,
  matchedWorkflows,
  multiMatchItems,
  type PutBackTaskCommand,
  prefixPatterns,
  type ReconcileAction,
  type ReconcileAllCounts,
  type ReconcileCounts,
  type RecentItem,
  type ReopenTaskCommand,
  Run,
  type RunDetail,
  type RunListItem,
  RunListRun,
  type RunPageData,
  RunState,
  RunTask,
  type RunTaskRow,
  reconcileItem,
  runIsBlocked,
  runIsClosed,
  runIsOpen,
  runIsVisibleTo,
  runTaskRows,
  type SetRunNoteCommand,
  type StartTaskCommand,
  searchTerm,
  TeamId,
  type TeamName,
  taskIsOnTeams,
  type UnblockRunCommand,
  unitsToMake,
  type WorkflowDetail,
} from "../../domain/shop-work.ts";
import { currentWhere as currentWhereSql } from "./current-where.ts";
import type { Transaction } from "./transaction.ts";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
export class RunRepositoryError extends Schema.TaggedError<RunRepositoryError>()(
  "RunRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()("RunNotFoundError", {
  id: Schema.String,
}) {}

/**
 * The run's state refuses the write. Start, Done, Put back, Block, Unblock,
 * Cancel and team assignment need {@link runIsOpen}; Reopen refuses a
 * closed run. The table on {@link RunState} is the rule.
 */
export class RunTerminalError extends Schema.TaggedError<RunTerminalError>()("RunTerminalError", {
  runId: Schema.String,
  state: RunState,
}) {}

/**
 * Start, Done or Put back refused because the run is blocked: a block means
 * stop until a person unblocks it. Gate: {@link runIsBlocked}, which
 * states the rule. Reopen and the run note are not gated by it.
 */
export class RunBlockedError extends Schema.TaggedError<RunBlockedError>()("RunBlockedError", {
  runId: Schema.String,
}) {}

/**
 * Cancel workflow refused because Shopify has closed the order
 * ({@link orderIsOpen}). Reconcile closes every open run on a closed
 * order in the same transaction as the order write, so this is a race with
 * that write, not a state a page should offer.
 */
export class RunOrderClosedError extends Schema.TaggedError<RunOrderClosedError>()(
  "RunOrderClosedError",
  { runId: Schema.String },
) {}

/**
 * The task's team is not among the caller's teams, or a reopen when a task
 * in a later step has started (`teamId` is then the task's own team, or empty
 * when unassigned). Both are `NotAllowed` on `RunResult`.
 */
export class RunNotAllowedError extends Schema.TaggedError<RunNotAllowedError>()(
  "RunNotAllowedError",
  { runId: Schema.String, teamId: Schema.String },
) {}

/** Unblock found no block: a second Unblock racing the first. */
export class RunNotBlockedError extends Schema.TaggedError<RunNotBlockedError>()(
  "RunNotBlockedError",
  { runId: Schema.String },
) {}

/** The task is not current (`currentTasks`) or is already done — or, for reopen, not yet done; for put back, not yet started or already done. */
export class TaskNotReadyError extends Schema.TaggedError<TaskNotReadyError>()(
  "TaskNotReadyError",
  { runTaskId: Schema.String },
) {}

/**
 * `assignRunTaskTeam` on a done task. Any *open* task can be assigned,
 * started or not; a done task is refused because the write would overwrite
 * `teamName`, the record of which team did it.
 */
export class TaskDoneError extends Schema.TaggedError<TaskDoneError>()("TaskDoneError", {
  runTaskId: Schema.String,
}) {}

/**
 * The active workflows whose tag is one of `tags`, with their tasks: how a pass
 * finds the workflows that can match an order, from the order's own tags
 * (the rule on `itemMatches`). Passed in rather than read here
 * so the two repositories stay independent: the runs application service hands over
 * the workflow repository's `listActiveWorkflowsByTags`. It runs inside the order's
 * transaction, so it must be plain statements.
 */
export type WorkflowsByTags = (
  tags: readonly string[],
) => Effect.Effect<readonly WorkflowDetail[], SqlError.SqlError | RunRepositoryError>;

/** What a pass reads besides the stored order: the pass's teams ({@link EligibleContext}) and how to find workflows by tag. */
export interface ReconcileContext extends EligibleContext {
  readonly workflowsByTags: WorkflowsByTags;
}

/**
 * The billing meter: counts the order a run was just created on. Called by `insertRun` after
 * the insert, inside the caller's transaction, once per inserted run; once per order is the
 * meter's own rule, not this repository's.
 */
export type CountOrder = (orderId: string, now: number) => Effect.Effect<void, SqlError.SqlError>;

const json = (value: unknown) => JSON.stringify(value);

/**
 * An {@link Actor} flattened into the two columns a task's recorded actor
 * holds. The merchant has no `Member` row, so the email is null beside a
 * `'merchant'` role — the role column is what readers discriminate on.
 */
const actorColumns = (actor: Actor) =>
  actor.role === "merchant"
    ? { role: "merchant" as const, email: null }
    : { role: "member" as const, email: actor.email };

/** The {@link ActorDisplay} a row stores for an {@link Actor}: role and email, never the gate's id or teams. */
const actorDisplay = (actor: Actor): ActorDisplay =>
  actor.role === "merchant" ? actor : { role: "member", email: actor.email };

const NO_COUNTS: ReconcileCounts = {
  created: 0,
  resized: 0,
  closed: 0,
  multiMatch: 0,
};

/**
 * The repository over the actor's `sql`, built once per activation. Every method that writes
 * more than one statement runs it under `transaction`, but `reconcileOrder`, which runs inside
 * its caller's.
 */
export const makeRunRepository = (
  sql: SqlClient.SqlClient,
  transaction: Transaction,
  countOrder: CountOrder,
) => {
  const decode =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, message: string) =>
    (rows: unknown) =>
      Schema.decodeUnknownEffect(schema)(rows).pipe(
        Effect.mapError((cause) => new RunRepositoryError({ message, cause })),
      );

  const decodeRuns = decode(Schema.Array(Run), "Invalid Run row");
  const decodeTasks = decode(Schema.Array(RunTask), "Invalid RunTask row");
  const decodeOrders = decode(Schema.Array(ShopOrder), "Invalid ShopOrder row");
  const decodeLineItems = decode(Schema.Array(OrderLineItem), "Invalid OrderLineItem row");
  const decodeRunListRuns = decode(
    Schema.Array(
      Schema.Struct({
        ...RunListRun.fields,
        stepCount: Schema.Number,
        orderCancelledAt: Schema.NullOr(Schema.Number),
        orderFulfillmentStatus: Schema.String,
      }),
    ),
    "Invalid RunListRun row",
  );
  const decodeTeamIds = decode(
    Schema.Array(Schema.Struct({ teamId: TeamId })),
    "Invalid RunTask teamId row",
  );
  const decodeOrderStates = decode(
    Schema.Array(Schema.Struct({ id: Schema.String, ...OrderState.fields })),
    "Invalid order state row",
  );
  const decodeOrderNotes = decode(
    Schema.Array(Schema.Struct({ ...OrderState.fields, note: Schema.NullOr(Schema.String) })),
    "Invalid order row",
  );

  const orderColumns = sql.literal(
    `id, legacyId, name, processedAt, updatedAt, cancelledAt,
     fulfillmentStatus, fullyPaid, note, syncedAt`,
  );

  const findRun = (runId: string) =>
    sql`select * from Run where id = ${runId}`.pipe(
      Effect.flatMap(decodeRuns),
      Effect.map(([run]) => Option.fromUndefinedOr(run)),
    );

  const requireRun = (runId: string) =>
    findRun(runId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new RunNotFoundError({ id: runId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const requireTask = (runTaskId: string) =>
    sql`select * from RunTask where id = ${runTaskId}`.pipe(
      Effect.flatMap(decodeTasks),
      Effect.flatMap(([task]) =>
        task === undefined
          ? Effect.fail(new RunNotFoundError({ id: runTaskId }))
          : Effect.succeed(task),
      ),
    );

  /** The predicate itself is {@link currentWhereSql}; its JSDoc says why it does not live in this module. */
  const currentWhere = (alias: string) => sql.literal(currentWhereSql(alias));

  const currentTasks = (runId: string) =>
    sql`
      select s.* from RunTask s
      where s.runId = ${runId} and ${currentWhere("s")}
      order by s.position
    `.pipe(Effect.flatMap(decodeTasks));

  const isCurrent = (runTaskId: string) =>
    sql`
      select 1 from RunTask s
      where s.id = ${runTaskId} and ${currentWhere("s")}
    `.pipe(Effect.map((rows) => rows.length > 0));

  /**
   * The guard every task action shares: task exists, the run passes
   * `gate` ({@link runIsOpen} for Start and Done; any state for
   * reopen), task's team among the caller's.
   *
   * `teamIds` undefined means the merchant, and then the team clause is
   * skipped whole — including the refusal for an unassigned task
   * (`teamId` null). That task is on nobody's list and no worker can
   * reach it, which is exactly the situation the merchant is there to
   * fix; refusing them too would leave the run stuck with no way out.
   */
  const requireActionable = ({
    runTaskId,
    teamIds,
    gate = runIsOpen,
  }: {
    readonly runTaskId: string;
    readonly teamIds: readonly string[] | undefined;
    readonly gate?: (run: Run) => boolean;
  }) =>
    Effect.gen(function* () {
      const task = yield* requireTask(runTaskId);
      const run = yield* requireRun(task.runId);
      if (!gate(run)) yield* new RunTerminalError({ runId: run.id, state: run.state });
      if (teamIds !== undefined && !taskIsOnTeams(task, teamIds))
        yield* new RunNotAllowedError({ runId: run.id, teamId: task.teamId ?? "" });
      return { task, run };
    });

  /**
   * `RunNotAllowedError` unless some current task of the run
   * belongs to `teamIds`. Undefined `teamIds` is the merchant and always passes, for
   * the reason on {@link requireActionable}.
   */
  const requireCurrentTeam = (runId: string, teamIds: readonly string[] | undefined) =>
    teamIds === undefined
      ? Effect.void
      : currentTasks(runId).pipe(
          Effect.flatMap((current) =>
            runIsVisibleTo(current, teamIds)
              ? Effect.void
              : Effect.fail(new RunNotAllowedError({ runId, teamId: current[0]?.teamId ?? "" })),
          ),
        );

  const tasksForRuns = (runIds: readonly string[]) =>
    runIds.length === 0
      ? Effect.succeed([])
      : sql`
          select * from RunTask
          where runId in (select value from json_each(${json(runIds)}))
          order by runId, position
        `.pipe(Effect.flatMap(decodeTasks));

  /**
   * The open-or-closed state of each order, by id. A run is deleted with
   * its order (the order repository's retention), so a run whose order is
   * missing here is not one a reader is offered: the callers drop it.
   */
  const orderStates = Effect.fn("RunRepository.orderStates")(function* (
    orderIds: readonly string[],
  ) {
    if (orderIds.length === 0) return new Map<string, OrderState>();
    const rows = yield* decodeOrderStates(
      yield* sql`
        select id, cancelledAt, fulfillmentStatus from ShopOrder
        where id in (select value from json_each(${json([...new Set(orderIds)])}))
      `,
    );
    return new Map(rows.map(({ id, ...state }): [string, OrderState] => [id, state]));
  });

  /**
   * `RunNotAllowedError` unless the caller can see the run
   * ({@link runIsVisibleTo}). Undefined `teamIds` is the merchant
   * and always passes.
   */
  const requireRunTeam = (runId: string, teamIds: readonly string[] | undefined) =>
    teamIds === undefined
      ? Effect.void
      : tasksForRuns([runId]).pipe(
          Effect.flatMap((tasks) =>
            runIsVisibleTo(tasks, teamIds)
              ? Effect.void
              : Effect.fail(new RunNotAllowedError({ runId, teamId: tasks[0]?.teamId ?? "" })),
          ),
        );

  /**
   * Every workflows list row the teams own, unsorted and uncapped: one
   * {@link RunListItem} per run with at least one current task of
   * `teamIds`, carrying that run's last step. Actor emails are on the row
   * already, so no team join and no D1 read.
   *
   * The first statement starts from the member's teams: each team's
   * open tasks through `RunTask_teamId_idx (teamId, doneAt)`, kept when
   * their run is open and the task is in the run's `currentStep`, which is
   * `currentWhere`'s rule kept on the row ({@link recomputeState}): these are
   * the rows' own tasks, and no other task of the run is read. Testing
   * `currentWhere` here instead re-read a run's tasks for every task it
   * tested. The `cross join`s are the planner pin, as on
   * the order repository's `listOrders`: SQLite keeps a `cross join`'s table
   * order (https://www.sqlite.org/optoverview.html#crossjoin), so the
   * read cannot turn around and drive from `Run`. The second reads those
   * runs, their `stepCount` and their order's state, by id.
   *
   * It ignores the member and the query: grouping, narrowing to a team,
   * search, sorting and the cut are `workflowsListFrom`'s, over
   * this result. So the result depends on `teamIds` alone, which is what
   * lets the actor memoize it per team set and share it between members
   * on the same teams. `json_each` keeps the team list a single bound parameter.
   */
  const runListItems = Effect.fn("RunRepository.runListItems")(function* (
    teamIds: readonly TeamId[],
  ) {
    if (teamIds.length === 0) return [];
    const own = yield* decodeTasks(
      yield* sql`
        select m.* from json_each(${json([...new Set(teamIds)])}) tt
        cross join RunTask m on m.teamId = tt.value and m.doneAt is null
        cross join Run r on r.id = m.runId and r.state = 'open' and r.currentStep = m.step
        order by m.runId, m.position
      `,
    );
    if (own.length === 0) return [];
    const runIds = [...new Set(own.map((task) => task.runId))];
    const runs = yield* decodeRunListRuns(
      yield* sql`
        select r.*,
          o.cancelledAt as orderCancelledAt,
          o.fulfillmentStatus as orderFulfillmentStatus
        from Run r
        join ShopOrder o on o.id = r.orderId
        where r.id in (select value from json_each(${json(runIds)}))
        order by r.orderProcessedAt, r.lineItemId, r.id
      `,
    );
    return runs.flatMap(
      ({ orderCancelledAt, orderFulfillmentStatus, stepCount, ...run }): RunListItem[] => {
        const [first, ...rest] = own
          .filter((task) => task.runId === run.id)
          // Whatever the row does not render is dropped rather than nulled or carried: the
          // shape is `RunListTask` and its JSDoc is why.
          .map((task) =>
            Struct.omit(task, ["doneAt", "doneByEmail", "doneByRole", "instructions"]),
          );
        return first === undefined || !runIsOpen(run)
          ? []
          : [
              {
                run,
                tasks: [first, ...rest],
                stepCount,
                order: { cancelledAt: orderCancelledAt, fulfillmentStatus: orderFulfillmentStatus },
              },
            ];
      },
    );
  });

  /**
   * The teams the order's runs have a task on, in any state: whose workflows list and Done half
   * a write to the order or to its runs can move, because those rows read only their own run's
   * tasks and order ({@link runListItems}, {@link listRecent}).
   */
  const teamsOfOrder = Effect.fn("RunRepository.teamsOfOrder")(function* (orderId: string) {
    const rows = yield* decodeTeamIds(
      yield* sql`
        select distinct s.teamId from Run r
        join RunTask s on s.runId = r.id
        where r.orderId = ${orderId} and s.teamId is not null
      `,
    );
    return rows.map(({ teamId }) => teamId);
  });

  const withTasks = (runs: readonly Run[]) =>
    Effect.gen(function* () {
      const tasks = yield* tasksForRuns(runs.map((run) => run.id));
      return runs.map((run): RunDetail => ({
        run,
        tasks: tasks.filter((task) => task.runId === run.id),
      }));
    });

  /**
   * `state` is a function of the tasks; recomputing it in SQL from the
   * same rows the task write just touched is what keeps the two in one
   * transaction with nothing to drift. Two states are derived: `done`
   * when every task is done, `open` otherwise. `startedAt`
   * ({@link Run}) is recomputed in the same statement, the
   * earliest task start, so the run-level checks see both at once, and so is
   * `currentStep`, the lowest step with an open task (null once every task is
   * done), which {@link runListItems} and the orders index's team filter and Show counts read
   * in place of `currentWhere`. Every
   * write that moves a task's `doneAt` calls this; `insertRun` and the close
   * set it themselves.
   *
   * Only ever called on an open run: every caller gates on
   * {@link runIsOpen}, or on not {@link runIsClosed} for
   * reopen, so a closed run's state, which is written rather than derived,
   * is never recomputed away.
   */
  const recomputeState = (runId: string, now: number) =>
    sql`
      update Run set
        state = (
          select case
            when count(*) = sum(doneAt is not null) then 'done'
            else 'open'
          end
          from RunTask s where s.runId = Run.id
        ),
        startedAt = (select min(startedAt) from RunTask s where s.runId = Run.id),
        currentStep = (
          select min(step) from RunTask s where s.runId = Run.id and s.doneAt is null
        ),
        updatedAt = ${now}
      where id = ${runId}
    `.pipe(Effect.asVoid);

  /**
   * Closes every open run the fragment selects, with `reason`
   * ({@link ClosedReason}), and returns how many. The one close
   * write, for reconcile and Cancel workflow alike. The tasks and the note
   * stay as the record; the block goes, because it is about work that
   * has stopped ({@link RunState}).
   */
  const closeOpenRuns = (where: Statement.Fragment, reason: ClosedReason, now: number) =>
    sql`
      update Run
      set state = 'closed', closedAt = ${now}, closedReason = ${reason}, currentStep = null,
          blockedAt = null, blockReason = null, blockedBy = null,
          updatedAt = ${now}
      where ${where} and state = 'open'
      returning id
    `.pipe(Effect.map((rows) => rows.length));

  /**
   * `workflowIsEligible` has already required every task's team to be in `teams`,
   * so the `teamName` lookup cannot miss.
   *
   * `on conflict do nothing` on the unique `lineItemId`: the item already
   * has a run, which means "do not insert", and a thrown `SqlError` in
   * the middle of a reconcile pass would fail the whole order. No row
   * returned is `Option.none()`, which every caller already reads as
   * "nothing created".
   */
  const insertRun = Effect.fn("RunRepository.insertRun")(function* ({
    workflow: { workflow, tasks },
    teams,
    order,
    lineItem,
  }: {
    readonly workflow: WorkflowDetail;
    readonly teams: EligibleContext["teams"];
    readonly order: ShopOrder;
    readonly lineItem: OrderLineItem;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const runId = crypto.randomUUID();
    const [run] = yield* decodeRuns(
      yield* sql`
        insert into Run (
          id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
          lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
          state, currentStep, stepCount, createdAt, updatedAt
        ) values (
          ${runId}, ${workflow.id}, ${workflow.name}, ${order.id},
          ${order.name}, ${order.processedAt},
          ${lineItem.id}, ${lineItem.title},
          ${lineItem.variantTitle}, ${lineItem.sku},
          ${unitsToMake(lineItem)},
          ${json(lineItem.properties)},
          'open', ${Math.min(...tasks.map(({ step }) => step))},
          ${Math.max(...tasks.map(({ step }) => step))}, ${now}, ${now}
        )
        on conflict do nothing
        returning *
      `,
    );
    if (run === undefined) return Option.none<Run>();
    // The meter, and the only place it fires. Inside the caller's transaction, which for the
    // reconcile path is the upsert's: `countOrder`'s body carries the rule.
    yield* countOrder(order.id, now);
    yield* Effect.forEach(
      tasks,
      (task) => sql`
        insert into RunTask
          (id, runId, position, step, name, teamId, teamName, instructions,
           startedAt, startedByEmail, doneAt, doneByEmail)
        values (
          ${crypto.randomUUID()}, ${runId}, ${task.position}, ${task.step},
          ${task.name}, ${task.teamId},
          ${teams.find((team) => team.id === task.teamId)?.name ?? ""},
          ${task.instructions}, null, null, null, null
        )
      `,
      { discard: true },
    );
    return Option.some(run);
  });

  const openOrders = sql`
    select id from ShopOrder
    where cancelledAt is null and fulfillmentStatus <> 'FULFILLED' and fullyPaid = 1
  `;

  /**
   * Reads the order, its items and its runs, calls
   * {@link reconcileItem} per item, and executes the actions;
   * the rule is there. The rules of a pass are the pass rules table on
   * {@link reconcileItem}; this is where rule 1 is enforced.
   *
   * Plain statements, no transaction of its own: called from inside
   * the order repository's `upsertOrder` transaction via `afterWrite`, or inside
   * {@link reconcileAll}'s per-order one, never nesting one (`Transaction`). Reads the order
   * and its stored items back rather than trusting the caller's copy, so a reconcile is
   * against what is actually stored.
   *
   * `ReconcileCounts.multiMatch` is {@link multiMatchItems}, the
   * same rule as the `multi_match` issue.
   */
  const reconcileOrder = Effect.fn("RunRepository.reconcileOrder")(function* ({
    orderId,
    workflowsByTags,
    teams,
  }: ReconcileContext & { readonly orderId: string }) {
    const now = yield* Clock.currentTimeMillis;
    const [order] = yield* decodeOrders(
      yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
    );
    if (order === undefined) return NO_COUNTS;
    if (orderIsCancelled(order) || orderIsFulfilled(order)) {
      const status = orderIsCancelled(order) ? "cancelled" : "fulfilled";
      yield* Effect.logInfo(
        `RunRepository.reconcileOrder: orderId=${orderId} status=${status}`,
      ).pipe(Effect.annotateLogs({ orderId, status }));
    }
    const lineItems = yield* decodeLineItems(
      yield* sql`select * from OrderLineItem where orderId = ${orderId}`,
    );
    const runs = yield* decodeRuns(yield* sql`select * from Run where orderId = ${orderId}`);
    const workflows = yield* workflowsByTags([
      ...new Set(lineItems.flatMap(({ productTags }) => productTags)),
    ]);
    const stored = new Set(lineItems.map((lineItem) => lineItem.id));
    const entries = [
      ...lineItems.map((lineItem) => ({
        lineItem: Option.some(lineItem),
        item: lineItem,
        run: runs.find((run) => run.lineItemId === lineItem.id) ?? null,
        matched: matchedWorkflows(lineItem, workflows, teams),
      })),
      // Pass rule 1 on `reconcileItem`: a run whose item is not stored is read as an item at
      // zero units.
      ...runs
        .filter((run) => !stored.has(run.lineItemId))
        .map((run) => ({
          lineItem: Option.none<OrderLineItem>(),
          item: { currentQuantity: 0 },
          run,
          matched: [],
        })),
    ];
    const planned = entries.map((entry) => ({
      entry,
      action: reconcileItem({
        order,
        item: entry.item,
        run: entry.run === null ? null : { run: entry.run },
        matched: entry.matched.map(({ workflow }) => workflow.id),
      }),
    }));
    const execute = ({ entry: { lineItem, run, matched }, action }: (typeof planned)[number]) =>
      Match.valueTags(action, {
        create: ({ workflowId }) => {
          const workflow = matched.find((detail) => detail.workflow.id === workflowId);
          return workflow === undefined || Option.isNone(lineItem)
            ? Effect.succeed(0)
            : insertRun({ workflow, teams, order, lineItem: lineItem.value }).pipe(
                Effect.map((inserted) => (Option.isSome(inserted) ? 1 : 0)),
              );
        },
        close: ({ reason }) =>
          run === null ? Effect.succeed(0) : closeOpenRuns(sql`id = ${run.id}`, reason, now),
        resize: ({ units }) =>
          run === null
            ? Effect.succeed(0)
            : sql`
                update Run
                set quantity = ${units}, updatedAt = ${now}
                where id = ${run.id}
              `.pipe(Effect.as(1)),
        nothing: () => Effect.succeed(0),
      }).pipe(Effect.map((count) => ({ tag: action._tag, count })));
    const done = yield* Effect.forEach(planned, execute, { concurrency: 1 });
    const sum = (tag: ReconcileAction["_tag"]) =>
      done.reduce((total, result) => total + (result.tag === tag ? result.count : 0), 0);
    const multiMatch = multiMatchItems(lineItems, runs, workflows, teams).map((lineItem) => ({
      lineItemId: lineItem.id,
      matched: matchedWorkflows(lineItem, workflows, teams).length,
    }));
    yield* Effect.forEach(
      multiMatch,
      ({ lineItemId, matched }) =>
        Effect.logInfo(
          `RunRepository.reconcileOrder: orderId=${orderId} lineItemId=${lineItemId} matched=${String(matched)}: multi-match, no run created`,
        ).pipe(Effect.annotateLogs({ orderId, lineItemId, matched })),
      { discard: true },
    );
    return {
      created: sum("create"),
      resized: sum("resize"),
      closed: sum("close"),
      multiMatch: multiMatch.length,
    } satisfies ReconcileCounts;
  });

  /**
   * {@link reconcileOrder} over every open, paid order, one transaction each
   * (pass rule 2 on {@link reconcileItem}): what runs after a
   * definition changes on an active workflow (Turn on, Apply). Returns its
   * counts ({@link ReconcileAllCounts}). Fulfilled orders are excluded on purpose —
   * reconcile treats fulfilled as terminal and there is nothing left to
   * make or pack — and unpaid ones because they reconcile when they pay.
   *
   * **Unbounded**: every open paid order the actor holds, with no limit
   * and no batching, one transaction each. What bounds it in practice is
   * the shop's open working set and retention
   * (`ShopLimits.orderRetentionDays`), not this code — a shop
   * with an unusual number of open orders pays for all of them on the
   * request that changed the definition.
   */
  const reconcileAll = Effect.fn("RunRepository.reconcileAll")(function* (
    context: ReconcileContext,
  ) {
    const ids = yield* openOrders.pipe(Effect.map((rows) => rows.map((row) => String(row.id))));
    const counts = yield* Effect.forEach(
      ids,
      (orderId) => transaction(reconcileOrder({ ...context, orderId })),
      { concurrency: 1 },
    );
    return {
      orders: ids.length,
      created: counts.reduce((total, c) => total + c.created, 0),
      multiMatch: counts.reduce((total, c) => total + c.multiMatch, 0),
    } satisfies ReconcileAllCounts;
  });

  /**
   * Manual attach, read as **set this item's workflow**. An item holds at
   * most one run (the actor's data model), so this is a replace, done in one transaction:
   *
   * - an open run for *this* workflow is `None` — nothing to do, and the
   *   caller reads it as "already there";
   * - an open run for a different workflow is deleted first, tasks and
   *   all, and comes back as `replaced`;
   * - a `done` run is deleted the same way, whatever its workflow, and
   *   comes back as `replaced`;
   * - a `closed` run is deleted the same way, tasks and all, whatever its
   *   workflow, and `replaced` is null: nothing was open.
   *
   * A workflow the item ran before, the done or closed one included,
   * starts fresh from its definition. Nothing of the earlier run is
   * resumed: closed is final ({@link RunState}). The merchant
   * confirmed the loss in the Change workflow modal, or chose a new
   * workflow for an item whose run had already ended.
   */
  const setRun = Effect.fn("RunRepository.setRun")((input: Parameters<typeof insertRun>[0]) =>
    transaction(
      Effect.gen(function* () {
        const existing = yield* decodeRuns(
          yield* sql`
            select * from Run
            where lineItemId = ${input.lineItem.id}
          `,
        );
        const [incumbent] = existing;
        const closed = incumbent !== undefined && runIsClosed(incumbent);
        if (
          incumbent !== undefined &&
          runIsOpen(incumbent) &&
          incumbent.workflowId === input.workflow.workflow.id
        )
          return Option.none<{ readonly run: Run; readonly replaced: Run | null }>();
        // Delete first: the unique `lineItemId` must be free before the insert.
        if (incumbent !== undefined) yield* sql`delete from Run where id = ${incumbent.id}`;
        const replaced = closed ? null : (incumbent ?? null);
        // The item's one run was deleted above, so the insert's `on conflict do nothing`
        // cannot fire here.
        const inserted = yield* insertRun(input);
        return Option.isNone(inserted)
          ? Option.none<{ readonly run: Run; readonly replaced: Run | null }>()
          : Option.some({ run: inserted.value, replaced });
      }),
    ),
  );

  const listRunsForOrder = Effect.fn("RunRepository.listRunsForOrder")(function* ({
    orderId,
  }: {
    readonly orderId: string;
  }) {
    return yield* withTasks(
      yield* decodeRuns(
        yield* sql`
          select * from Run
          where orderId = ${orderId}
          order by lineItemId, createdAt
        `,
      ),
    );
  });

  /** The run with its tasks, by its own id or by one of its tasks' ids. */
  const getRun = Effect.fn("RunRepository.getRun")(function* (
    input: { readonly runId: string } | { readonly runTaskId: string },
  ) {
    const runId =
      "runId" in input
        ? input.runId
        : (yield* sql`select runId from RunTask where id = ${input.runTaskId}`)[0]?.["runId"];
    if (typeof runId !== "string") return Option.none<RunDetail>();
    const run = yield* findRun(runId);
    if (Option.isNone(run)) return Option.none<RunDetail>();
    const [detail] = yield* withTasks([run.value]);
    return Option.fromUndefinedOr(detail);
  });

  /**
   * What an action set reads (`runActions`, `taskActions`): the run, its tasks decorated as
   * {@link RunTaskRow}s, and its order's open or closed state.
   * `None` when the run, or its order, is gone. A closed run is returned:
   * its note is still writable, and the action sets refuse everything else
   * on it.
   */
  const getRunGate = Effect.fn("RunRepository.getRunGate")(function* (
    input: { readonly runId: string } | { readonly runTaskId: string },
  ) {
    const found = yield* getRun(input);
    if (Option.isNone(found)) return Option.none();
    const { run, tasks } = found.value;
    const order = (yield* orderStates([run.orderId])).get(run.orderId);
    return order === undefined
      ? Option.none()
      : Option.some({ run, tasks: runTaskRows(run, tasks), order });
  });

  /**
   * The merchant's Cancel workflow: closes the run, reason `merchant_cancelled`
   * ({@link ClosedReason}), in one transaction. The tasks stay as the
   * record of who did what, the note stays, and the block is cleared
   * with the rest of the run's open state. The row keeps
   * its item, one run per item, so reconcile creates nothing on it ({@link RunState}).
   * Gate: {@link runIsOpen} and the order open
   * ({@link orderIsOpen}); a `done` run is not cancelled, it is
   * reopened.
   *
   * There is no way back, so the merchant confirms in a modal; the
   * confirmation is the guard for a mistaken cancel, and this write needs
   * no second one. A new workflow on the item afterwards starts fresh.
   */
  const cancelRun = Effect.fn("RunRepository.cancelRun")(function* ({
    runId,
  }: {
    readonly runId: string;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        const run = yield* requireRun(runId);
        if (!runIsOpen(run)) yield* new RunTerminalError({ runId, state: run.state });
        const order = (yield* orderStates([run.orderId])).get(run.orderId);
        if (order === undefined || !orderIsOpen(order)) yield* new RunOrderClosedError({ runId });
        const now = yield* Clock.currentTimeMillis;
        yield* closeOpenRuns(sql`id = ${runId}`, "merchant_cancelled", now);
      }),
    );
  });

  /**
   * The Done or closed state ({@link RecentItem}): tasks owned by `teamIds`
   * done at or after `since`, each with its run and
   * {@link laterStepStarted}, and runs with a task on `teamIds` that
   * closed at or after `since`, newest first by `doneAt` or
   * `closedAt`. The team's, not the caller's: a colleague notices a mistake
   * as readily as its author, and a closed run is news to everyone who
   * could see it.
   *
   * `total` is the count inside the window, because the strip says it
   * even while another state is showing; `limit: 0` returns the count alone,
   * reading no rows. `q` narrows the rows and `total` alike, so under a
   * search `total` is how many of the window match before the cut
   * (`WorkflowsListData` `matches`); the Done or closed count
   * the strip shows (`RunListCounts`) is read with `q: null`.
   *
   * `oldest` is the earliest `doneAt` or `closedAt` that `total` counts, `null` when it counts
   * nothing: the answer stands, absent a write, until the window slides past it. `counted` is
   * that answer for the same `teamIds` and `q`, read earlier and still standing: it is returned
   * as it is, and only the rows are read.
   */
  const listRecent = Effect.fn("RunRepository.listRecent")(function* ({
    teamIds,
    since,
    limit,
    q,
    counted,
  }: {
    readonly teamIds: readonly string[];
    readonly since: number;
    readonly limit: number;
    readonly q: ListSearch | null;
    readonly counted?: { readonly total: number; readonly oldest: number | null };
  }) {
    if (teamIds.length === 0) return { items: [], total: 0, oldest: null };
    const teams = json(teamIds);
    /**
     * {@link searchTerm} over the run's snapshot of its item, aliased
     * `r`: the order name whole, or a word prefix of the item title,
     * the variant title or the SKU ({@link prefixPatterns}). Narrows
     * the rows and `total` alike; `1 = 1` without a search.
     */
    const matching = Option.match(Option.fromNullOr(q), {
      onNone: () => sql.literal("1 = 1"),
      onSome: (text) => {
        const term = searchTerm(text);
        if (term.kind === "orderName") return sql`r.orderName = ${term.name}`;
        const [start, word] = prefixPatterns(term.text);
        return sql`(
          r.lineItemTitle like ${start} escape '\\'
          or r.lineItemTitle like ${word} escape '\\'
          or r.variantTitle like ${start} escape '\\'
          or r.variantTitle like ${word} escape '\\'
          or r.sku like ${start} escape '\\'
          or r.sku like ${word} escape '\\'
        )`;
      },
    });
    /**
     * Two windows, each bounded by `since` and served by its own index:
     * done tasks by `RunTask_teamId_idx (teamId,
     * doneAt)`, closed runs by `Run_closed_idx (closedAt)`,
     * partial over `closed`. So each counts a day, not the table.
     */
    const closedWhere = sql`
      r.state = 'closed' and r.closedAt >= ${since}
        and exists (
          select 1 from RunTask t
          where t.runId = r.id
            and t.teamId in (select value from json_each(${teams}))
        )
    `;
    const count = Effect.gen(function* () {
      const tasks = yield* sql`
        select count(*), min(s.doneAt) from RunTask s
        where s.doneAt >= ${since}
          and s.teamId in (select value from json_each(${teams}))
          and exists (
            select 1 from Run r where r.id = s.runId and ${matching}
          )
      `.values;
      const closed =
        yield* sql`select count(*), min(r.closedAt) from Run r where ${closedWhere} and ${matching}`
          .values;
      const earliest = [tasks[0]?.[1], closed[0]?.[1]].flatMap((at) =>
        at === null || at === undefined ? [] : [Number(at)],
      );
      return {
        total: Number(tasks[0]?.[0] ?? 0) + Number(closed[0]?.[0] ?? 0),
        oldest: earliest.length === 0 ? null : Math.min(...earliest),
      };
    });
    const { total, oldest } = counted ?? (yield* count);
    // Collapsed: the strip still counts the day, so the counts are read and the rows are not.
    if (limit === 0) return { items: [], total, oldest };
    const done = yield* decodeTasks(
      yield* sql`
        select s.* from RunTask s
        where s.doneAt >= ${since}
          and s.teamId in (select value from json_each(${teams}))
          and exists (
            select 1 from Run r where r.id = s.runId and ${matching}
          )
        order by s.doneAt desc, s.position desc
        limit ${limit}
      `,
    );
    const closed = yield* decodeRuns(
      yield* sql`
        select r.* from Run r where ${closedWhere} and ${matching}
        order by r.closedAt desc, r.id desc
        limit ${limit}
      `,
    );
    const runIds = [...new Set(done.map((task) => task.runId))];
    const runs = [
      ...closed,
      ...(yield* decodeRuns(
        runIds.length === 0
          ? []
          : yield* sql`
              select * from Run
              where id in (select value from json_each(${json(runIds)}))
            `,
      )),
    ];
    const tasks = yield* tasksForRuns(runIds);
    const orders = yield* orderStates(runs.map((run) => run.orderId));
    const taskItems = done.flatMap((task): (RecentItem & { readonly at: number })[] => {
      const run = runs.find((candidate) => candidate.id === task.runId);
      const order = run === undefined ? undefined : orders.get(run.orderId);
      return run === undefined || order === undefined
        ? []
        : [
            {
              kind: "task",
              run,
              task,
              laterStepStarted: laterStepStarted(task, tasks),
              order,
              at: task.doneAt ?? 0,
            },
          ];
    });
    const closedItems = closed.flatMap((run): (RecentItem & { readonly at: number })[] => {
      const order = orders.get(run.orderId);
      return order === undefined ? [] : [{ kind: "closed", run, order, at: run.closedAt ?? 0 }];
    });
    const items = [...taskItems, ...closedItems]
      .toSorted((a, b) => b.at - a.at)
      .slice(0, limit)
      .map(({ at: _at, ...item }): RecentItem => item);
    return { items, total, oldest };
  });

  /**
   * Reopen returns a task to Ready: it clears the Done columns (`doneAt`,
   * `doneBy*`) and every Start column, member or merchant, records
   * nothing, and recomputes the run's state. The task is Ready for a
   * worker to Start. Keeping a member's Start would leave the task
   * "Started · A · since <original time>": a claim A no longer makes and a
   * time that is no longer true, and it would take Undo then Put back to
   * reach Ready from a single Done. Allowed for the task's team while no
   * later step has a task started or done ({@link laterStepStarted};
   * `RunNotAllowedError` otherwise). Gate: not
   * {@link runIsClosed}, rather than `runIsOpen` — reopening a `done`
   * run's last task is the point, while a closed run is final; see
   * {@link RunState}.
   */
  const reopenTask = Effect.fn("RunRepository.reopenTask")(function* ({
    runTaskId,
    teamIds,
  }: ReopenTaskCommand) {
    yield* transaction(
      Effect.gen(function* () {
        // Reopening a `done` run's last task is the point; a closed run is final.
        const { task, run } = yield* requireActionable({
          runTaskId,
          teamIds,
          gate: (candidate) => !runIsClosed(candidate),
        });
        if (task.doneAt === null) yield* new TaskNotReadyError({ runTaskId });
        if (laterStepStarted(task, yield* tasksForRuns([run.id])))
          yield* new RunNotAllowedError({ runId: run.id, teamId: task.teamId ?? "" });
        const now = yield* Clock.currentTimeMillis;
        // Reopen returns the task to Ready and records nothing; the old Start is a claim the
        // starter no longer makes and a time that is no longer true.
        yield* sql`
          update RunTask
          set doneAt = null, doneByEmail = null, doneByRole = null,
              startedAt = null, startedByEmail = null, startedByRole = null
          where id = ${runTaskId}
        `;
        yield* recomputeState(run.id, now);
      }),
    );
  });

  /**
   * Put back clears the Start record of a started task, and the run's
   * state is recomputed (a run whose only started task is put back is
   * `runIsUnstarted` again). Refused on a done task or an
   * unstarted task
   * (`TaskNotReadyError`), a run that is not {@link runIsOpen}
   * (`RunTerminalError`), a blocked run (`RunBlockedError`), or, for a
   * member, a task not on one of their teams (`RunNotAllowedError`).
   *
   * Offered to the whole team, not only the starter, and refused under a
   * block; why is the `putBack` bullet on `taskActions`. No
   * column records who put it back; the task is plain Ready and the next
   * Start writes a fresh record.
   */
  const putBackTask = Effect.fn("RunRepository.putBackTask")(function* ({
    runTaskId,
    teamIds,
  }: PutBackTaskCommand) {
    yield* transaction(
      Effect.gen(function* () {
        const { task, run } = yield* requireActionable({ runTaskId, teamIds });
        if (runIsBlocked(run)) yield* new RunBlockedError({ runId: run.id });
        if (task.startedAt === null || task.doneAt !== null)
          yield* new TaskNotReadyError({ runTaskId });
        // A started task is current by construction (Start required it, and nothing behind it
        // can reopen while it is started); the check keeps the four task writes reading alike.
        if (!(yield* isCurrent(runTaskId))) yield* new TaskNotReadyError({ runTaskId });
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          update RunTask
          set startedAt = null, startedByEmail = null,
              startedByRole = null
          where id = ${runTaskId}
        `;
        yield* recomputeState(run.id, now);
      }),
    );
  });

  /**
   * The workflow page's read: the run with every task decorated with whether it is current
   * and {@link laterStepStarted}, the order's live note and items. `None`
   * when the run does not exist or the caller cannot see it
   * ({@link runIsVisibleTo}) — one answer for both, so a member
   * cannot probe run ids. A closed run is returned: a link to it lands on
   * its reason rather than on a not-found.
   */
  const getRunPage = Effect.fn("RunRepository.getRunPage")(function* ({
    runId,
    teamIds,
  }: {
    readonly runId: string;
    readonly teamIds: readonly string[];
  }) {
    const found = yield* findRun(runId);
    if (Option.isNone(found)) return Option.none<RunPageData>();
    const run = found.value;
    const tasks = yield* tasksForRuns([run.id]);
    if (!runIsVisibleTo(tasks, teamIds)) return Option.none<RunPageData>();
    // `currentWhere` reads tasks alone, and a closed run keeps its open tasks as the record:
    // nothing on it is current (`currentTasks`).
    const current = runIsOpen(run) ? yield* currentTasks(run.id) : [];
    const [orderRow] = yield* decodeOrderNotes(
      yield* sql`
        select cancelledAt, fulfillmentStatus, note from ShopOrder
        where id = ${run.orderId}
      `,
    );
    if (orderRow === undefined) return Option.none<RunPageData>();
    const { note, ...order } = orderRow;
    return Option.some({
      run,
      tasks: tasks.map((task): RunTaskRow => ({
        ...task,
        current: current.some((candidate) => candidate.id === task.id),
        laterStepStarted: laterStepStarted(task, tasks),
      })),
      orderNote: note,
      order,
    } satisfies RunPageData);
  });

  /**
   * Marks a ready task started. Idempotent: a second Start leaves the
   * original `startedAt` / `startedByEmail` / `startedByRole` — no takeover, no
   * error — so two people pressing it does not rewrite who began. The
   * email is snapshotted so history reads after the member is deleted.
   * Gates: {@link runIsOpen}, and not {@link runIsBlocked}.
   */
  const startTask = Effect.fn("RunRepository.startTask")(function* ({
    runTaskId,
    actor,
    teamIds,
  }: StartTaskCommand) {
    yield* transaction(
      Effect.gen(function* () {
        const { run } = yield* requireActionable({ runTaskId, teamIds });
        if (runIsBlocked(run)) yield* new RunBlockedError({ runId: run.id });
        if (!(yield* isCurrent(runTaskId))) yield* new TaskNotReadyError({ runTaskId });
        const now = yield* Clock.currentTimeMillis;
        const by = actorColumns(actor);
        yield* sql`
          update RunTask
          set startedAt = coalesce(startedAt, ${now}),
              startedByEmail = coalesce(startedByEmail, ${by.email}),
              startedByRole = coalesce(startedByRole, ${by.role})
          where id = ${runTaskId}
        `;
        yield* recomputeState(run.id, now);
      }),
    );
  });

  /**
   * Sets the Done columns (`doneAt`, `doneBy*`). Also backfills the started
   * columns with the same actor when Done arrives without a Start, so every
   * done task records who. Nothing is created here. Gates:
   * {@link runIsOpen}, and not {@link runIsBlocked}.
   */
  const markTaskDone = Effect.fn("RunRepository.markTaskDone")(function* ({
    runTaskId,
    actor,
    teamIds,
  }: MarkTaskDoneCommand) {
    return yield* transaction(
      Effect.gen(function* () {
        const { run } = yield* requireActionable({ runTaskId, teamIds });
        if (runIsBlocked(run)) yield* new RunBlockedError({ runId: run.id });
        if (!(yield* isCurrent(runTaskId))) yield* new TaskNotReadyError({ runTaskId });
        const now = yield* Clock.currentTimeMillis;
        const by = actorColumns(actor);
        yield* sql`
          update RunTask
          set doneAt = ${now}, doneByEmail = ${by.email},
              doneByRole = ${by.role},
              startedAt = coalesce(startedAt, ${now}),
              startedByEmail = coalesce(startedByEmail, ${by.email}),
              startedByRole = coalesce(startedByRole, ${by.role})
          where id = ${runTaskId}
        `;
        yield* recomputeState(run.id, now);
      }),
    );
  });

  /**
   * Writes the run's note; `null` clears it. No requirement that the run have a current task — a
   * note on a done run is allowed: a note is a record, not work, and the
   * thing noticed after the last Done is exactly what wants writing down,
   * and a closed run keeps its record too; see {@link RunState}. A member
   * needs to see the run ({@link runIsVisibleTo}), not to hold a
   * current task as Block does: a done run has none and would
   * refuse every member. Last write wins; see {@link SetRunNoteCommand}.
   */
  const setRunNote = Effect.fn("RunRepository.setRunNote")(function* ({
    runId,
    teamIds,
    note,
  }: SetRunNoteCommand) {
    yield* transaction(
      Effect.gen(function* () {
        yield* requireRun(runId);
        yield* requireRunTeam(runId, teamIds);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          update Run set note = ${note}, updatedAt = ${now}
          where id = ${runId}
        `;
      }),
    );
  });

  /**
   * Blocks the run ({@link runIsBlocked}): `blockedAt`, the optional
   * reason, and the actor as `blockedBy`. Allowed when a current
   * task belongs to `teamIds`. Gate: {@link runIsOpen}; see {@link RunState}.
   */
  const blockRun = Effect.fn("RunRepository.blockRun")(function* ({
    runId,
    actor,
    teamIds,
    reason,
  }: BlockRunCommand) {
    yield* transaction(
      Effect.gen(function* () {
        const run = yield* requireRun(runId);
        if (!runIsOpen(run)) yield* new RunTerminalError({ runId, state: run.state });
        yield* requireCurrentTeam(runId, teamIds);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          update Run
          set blockedAt = ${now}, blockReason = ${reason},
              blockedBy = ${json(actorDisplay(actor))}, updatedAt = ${now}
          where id = ${runId}
        `;
      }),
    );
  });

  /**
   * Lifts the block: nulls `blockedAt`, `blockReason` and `blockedBy`.
   * Allowed when any current task of the run belongs to one of
   * `teamIds`, or unconditionally for the merchant (`teamIds` undefined). Fails
   * `RunNotBlockedError` when there is no block to lift (a second Unblock
   * racing the first), and `RunTerminalError` unless {@link runIsOpen}.
   */
  const unblockRun = Effect.fn("RunRepository.unblockRun")(function* ({
    runId,
    teamIds,
  }: UnblockRunCommand) {
    yield* transaction(
      Effect.gen(function* () {
        const run = yield* requireRun(runId);
        if (!runIsOpen(run)) yield* new RunTerminalError({ runId, state: run.state });
        if (!runIsBlocked(run)) yield* new RunNotBlockedError({ runId });
        yield* requireCurrentTeam(runId, teamIds);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          update Run
          set blockedAt = null, blockReason = null, blockedBy = null,
              updatedAt = ${now}
          where id = ${run.id}
        `;
      }),
    );
  });

  /**
   * Points any *open* run task at `team`, snapshotting the name from the
   * live teams the caller resolved (`RunTask`'s team is both a
   * pointer and a snapshot: the actor's data model), and puts the task on that team's list. The
   * team's existence is the caller's check (`Team` is a D1 row
   * this store cannot see). Allowed on any open task, assigned or not and
   * started or not — it is both the remedy that makes a team delete safe
   * and the merchant's way to move work between teams. Only `teamId` /
   * `teamName` are written, so a started task keeps `startedByRole` /
   * `startedByEmail` and history still names whoever began it. A done
   * task is refused (`TaskDoneError`), and so is a task of a run that
   * is not {@link runIsOpen} (`RunTerminalError`): a `done` run's
   * tasks are all done, so this is the same refusal reached another way.
   */
  const assignRunTaskTeam = Effect.fn("RunRepository.assignRunTaskTeam")(function* ({
    runTaskId,
    team,
  }: {
    readonly runTaskId: string;
    readonly team: { readonly id: TeamId; readonly name: TeamName };
  }) {
    yield* transaction(
      Effect.gen(function* () {
        const task = yield* requireTask(runTaskId);
        // The task first: on a done run every task is done, and "keeps its team" is the truer
        // refusal than "run not open".
        if (task.doneAt !== null) yield* new TaskDoneError({ runTaskId });
        const run = yield* requireRun(task.runId);
        if (!runIsOpen(run)) yield* new RunTerminalError({ runId: run.id, state: run.state });
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          update RunTask
          set teamId = ${team.id}, teamName = ${team.name}
          where id = ${runTaskId}
        `;
        yield* sql`update Run set updatedAt = ${now} where id = ${task.runId}`;
      }),
    );
  });

  return {
    reconcileOrder,
    reconcileAll,
    setRun,
    listRunsForOrder,
    getRunGate,
    getRun,
    cancelRun,
    runListItems,
    listRecent,
    teamsOfOrder,
    reopenTask,
    putBackTask,
    getRunPage,
    startTask,
    markTaskDone,
    setRunNote,
    blockRun,
    unblockRun,
    assignRunTaskTeam,
  };
};

/** The actor's run repository; see {@link makeRunRepository}. */
export type RunRepository = ReturnType<typeof makeRunRepository>;

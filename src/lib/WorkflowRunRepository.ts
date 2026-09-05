import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
export class WorkflowRunRepositoryError extends Schema.TaggedError<WorkflowRunRepositoryError>()(
  "WorkflowRunRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()(
  "RunNotFoundError",
  { id: Schema.String },
) {}

/** The run is `done` or `cancelled` — or, for un-cancel, is not cancelled. */
export class RunTerminalError extends Schema.TaggedError<RunTerminalError>()(
  "RunTerminalError",
  { runId: Schema.String, status: Domain.RunStatus },
) {}

/** The step's team is not among the caller's teams. */
export class RunNotAllowedError extends Schema.TaggedError<RunNotAllowedError>()(
  "RunNotAllowedError",
  { runId: Schema.String, teamId: Schema.String },
) {}

/** A step in an earlier stage is still open, or this step is already completed. */
export class StepNotReadyError extends Schema.TaggedError<StepNotReadyError>()(
  "StepNotReadyError",
  { runStepId: Schema.String },
) {}

/**
 * What `listQueue` returns before the Durable Object joins member emails:
 * every ready step of the run the caller may act on, with the run's last
 * stage and each step's same-stage siblings owned by other teams.
 */
export interface QueueRow {
  readonly run: Domain.WorkflowRun;
  readonly steps: readonly (Domain.WorkflowRunStep & {
    readonly siblings: readonly {
      readonly name: Domain.StepName;
      readonly teamName: Domain.TeamName;
    }[];
  })[];
  readonly stageCount: number;
  readonly note: string | null;
  readonly items: readonly Domain.QueueOrderItem[];
}

export interface ReconcileCounts {
  readonly created: number;
  readonly cancelled: number;
  readonly flagged: number;
  /** Order runs started by this pass (0 or 1). */
  readonly orderRuns: number;
}

export interface RoutingContext {
  readonly workflows: readonly Domain.WorkflowDetail[];
  readonly activeTeams: readonly {
    readonly id: Domain.TeamId;
    readonly name: Domain.TeamName;
  }[];
}

/**
 * The definition-side half of the routing predicate: archived, empty, or
 * pointing a step at a team that is no longer active all mean "routes
 * nothing". Shared by tag routing and manual attach — the latter skips the
 * line-item half (tags, quantity, fulfilment, age) but never this half.
 */
export const isRoutable = (
  { workflow, steps }: Domain.WorkflowDetail,
  activeTeams: RoutingContext["activeTeams"],
) =>
  workflow.archivedAt === null &&
  steps.length > 0 &&
  steps.every((step) => activeTeams.some((team) => team.id === step.teamId));

/**
 * The line-item half. `processedAt >= createdAt` is the age rule: a bulk
 * stream of thirty days of history must not start work on orders placed
 * before the workflow existed, whichever path delivers them.
 */
export const matchesLineItem = (
  { workflow }: Domain.WorkflowDetail,
  order: Domain.ShopOrder,
  lineItem: Domain.OrderLineItem,
) =>
  Domain.unitsToMake(lineItem) > 0 &&
  order.processedAt >= workflow.createdAt &&
  lineItem.productTags.some((tag) => {
    const folded = tag.trim().toLowerCase();
    return workflow.tags.some((candidate) => candidate === folded);
  });

const json = (value: unknown) => JSON.stringify(value);

const isTerminal = (run: Domain.WorkflowRun) =>
  run.status === "done" || run.status === "cancelled";

const NO_COUNTS: ReconcileCounts = {
  created: 0,
  cancelled: 0,
  flagged: 0,
  orderRuns: 0,
};

export class WorkflowRunRepository extends Context.Service<
  WorkflowRunRepository,
  {
    /**
     * Plain statements, no transaction of its own: called from inside
     * `OrderRepository.upsertOrder`'s transaction via `afterWrite`, and Durable
     * Object SQLite refuses to nest. Reads the order and its stored line items
     * back rather than trusting the caller's view, so a merge under
     * `lineItemsComplete = false` still reconciles against what is actually
     * stored.
     */
    readonly reconcileOrder: (
      input: RoutingContext & { readonly orderId: string },
    ) => Effect.Effect<
      ReconcileCounts,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Manual attach of an item workflow. `None` when `(lineItemId,
     * workflowId)` already has a run in any status. A new item run flags any
     * open order run of the order `item_added`.
     */
    readonly createRun: (input: {
      readonly workflow: Domain.WorkflowDetail;
      readonly activeTeams: RoutingContext["activeTeams"];
      readonly order: Domain.ShopOrder;
      readonly lineItem: Domain.OrderLineItem;
      readonly source: Domain.RunSource;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowRun>,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    readonly markOrderDeleted: (input: {
      readonly orderId: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    readonly listRunsForOrder: (input: {
      readonly orderId: string;
    }) => Effect.Effect<
      readonly Domain.WorkflowRunDetail[],
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    readonly getRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowRunDetail>,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * `routing` lets cancelling the last open item run start the order run;
     * absent (tests that only exercise steps), the trigger is skipped.
     */
    readonly cancelRun: (input: {
      readonly runId: string;
      readonly routing?: RoutingContext;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunTerminalError
    >;
    /** Only from `cancelled`; status is recomputed from the steps. Un-cancelling an item run flags any open order run `item_added`. */
    readonly uncancelRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunTerminalError
    >;
    /** One row per run with at least one ready step owned by `teamIds`; flagged runs first, then oldest. */
    readonly listQueue: (input: {
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      readonly QueueRow[],
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Marks a ready step in progress. Idempotent: a second Start leaves the
     * original `startedAt` / `startedBy` — no takeover, no error — so two
     * people pressing it does not rewrite who began.
     */
    readonly startStep: (input: {
      readonly runStepId: string;
      readonly memberId: Domain.MemberId;
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | StepNotReadyError
      | RunTerminalError
    >;
    /**
     * Also backfills `startedAt` / `startedBy` when Done arrives without a
     * Start, so every finished step records who. With `routing`, a completion
     * that finishes the last item run on an order starts the order run.
     */
    readonly completeStep: (input: {
      readonly runStepId: string;
      readonly memberId: Domain.MemberId;
      readonly teamIds: readonly string[];
      readonly routing?: RoutingContext;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | StepNotReadyError
      | RunTerminalError
    >;
    /** No readiness requirement — a note on a done step is allowed — but the run must be non-terminal. `null` clears. */
    readonly setStepNote: (input: {
      readonly runStepId: string;
      readonly memberId: Domain.MemberId;
      readonly teamIds: readonly string[];
      readonly note: Domain.StepNote | null;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
    >;
    /** Sets `flag = 'blocked'` with an optional reason, overwriting any prior flag. Allowed when a ready step belongs to `teamIds`. */
    readonly blockRun: (input: {
      readonly runId: string;
      readonly memberId: Domain.MemberId;
      readonly teamIds: readonly string[];
      readonly reason: Domain.StepNote | null;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
    >;
    /** Allowed when any ready step of the run belongs to one of `teamIds`. */
    readonly dismissFlag: (input: {
      readonly runId: string;
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
    >;
  }
>()("WorkflowRunRepository") {
  static readonly layer: Layer.Layer<
    WorkflowRunRepository,
    never,
    SqlClient.SqlClient
  > = Layer.effect(
    WorkflowRunRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const decode =
        <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
        (rows: unknown) =>
          Schema.decodeUnknownEffect(schema)(rows).pipe(
            Effect.mapError(
              (cause) => new WorkflowRunRepositoryError({ message, cause }),
            ),
          );

      const decodeRuns = decode(
        Schema.Array(Domain.WorkflowRun),
        "Invalid WorkflowRun row",
      );
      const decodeSteps = decode(
        Schema.Array(Domain.WorkflowRunStep),
        "Invalid WorkflowRunStep row",
      );
      const decodeOrders = decode(
        Schema.Array(Domain.ShopOrder),
        "Invalid ShopOrder row",
      );
      const decodeLineItems = decode(
        Schema.Array(Domain.OrderLineItem),
        "Invalid OrderLineItem row",
      );
      const decodeQueueRuns = decode(
        Schema.Array(
          Schema.Struct({
            ...Domain.WorkflowRun.fields,
            note: Schema.NullOr(Schema.String),
            stageCount: Schema.Number,
          }),
        ),
        "Invalid queue row",
      );

      const orderColumns = sql.literal(
        `id, legacyId, name, createdAt, processedAt, updatedAt, cancelledAt,
         closedAt, financialStatus, fulfillmentStatus, fullyPaid, tags, note,
         customAttributes, lineItemsComplete, syncedAt, syncSource`,
      );

      const findRun = (runId: string) =>
        sql`select * from WorkflowRun where id = ${runId}`.pipe(
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

      const requireStep = (runStepId: string) =>
        sql`select * from WorkflowRunStep where id = ${runStepId}`.pipe(
          Effect.flatMap(decodeSteps),
          Effect.flatMap(([step]) =>
            step === undefined
              ? Effect.fail(new RunNotFoundError({ id: runStepId }))
              : Effect.succeed(step),
          ),
        );

      const stepsOf = (runId: string) =>
        sql`select * from WorkflowRunStep where runId = ${runId} order by position`.pipe(
          Effect.flatMap(decodeSteps),
        );

      /**
       * A step is ready when it is open and nothing in an earlier stage of
       * the same run is still open. One definition, interpolated as a literal
       * with the outer alias, so the queue and every action agree.
       */
      const readyWhere = (alias: string) =>
        sql.literal(`(
          ${alias}.completedAt is null and not exists (
            select 1 from WorkflowRunStep p
            where p.runId = ${alias}.runId and p.completedAt is null and p.stage < ${alias}.stage
          )
        )`);

      const readySteps = (runId: string) =>
        sql`
          select s.* from WorkflowRunStep s
          where s.runId = ${runId} and ${readyWhere("s")}
          order by s.position
        `.pipe(Effect.flatMap(decodeSteps));

      const isReady = (runStepId: string) =>
        sql`
          select 1 from WorkflowRunStep s
          where s.id = ${runStepId} and ${readyWhere("s")}
        `.pipe(Effect.map((rows) => rows.length > 0));

      /** The guard every step action shares: step exists, run not terminal, step's team among the caller's. */
      const requireActionable = ({
        runStepId,
        teamIds,
      }: {
        readonly runStepId: string;
        readonly teamIds: readonly string[];
      }) =>
        Effect.gen(function* () {
          const step = yield* requireStep(runStepId);
          const run = yield* requireRun(step.runId);
          if (isTerminal(run))
            yield* new RunTerminalError({ runId: run.id, status: run.status });
          if (!teamIds.includes(step.teamId))
            yield* new RunNotAllowedError({
              runId: run.id,
              teamId: step.teamId,
            });
          return { step, run };
        });

      /** `RunNotAllowedError` unless some ready step of the run belongs to `teamIds`. */
      const requireReadyTeam = (runId: string, teamIds: readonly string[]) =>
        readySteps(runId).pipe(
          Effect.flatMap((ready) =>
            ready.some((step) => teamIds.includes(step.teamId))
              ? Effect.void
              : Effect.fail(
                  new RunNotAllowedError({
                    runId,
                    teamId: ready[0]?.teamId ?? "",
                  }),
                ),
          ),
        );

      const stepsForRuns = (runIds: readonly string[]) =>
        runIds.length === 0
          ? Effect.succeed([])
          : sql`
              select * from WorkflowRunStep
              where runId in (select value from json_each(${json(runIds)}))
              order by runId, position
            `.pipe(Effect.flatMap(decodeSteps));

      const withSteps = (runs: readonly Domain.WorkflowRun[]) =>
        stepsForRuns(runs.map((run) => run.id)).pipe(
          Effect.map((steps) =>
            runs.map((run): Domain.WorkflowRunDetail => ({
              run,
              steps: steps.filter((step) => step.runId === run.id),
            })),
          ),
        );

      const RUN_STATUS_RANK: Record<Domain.RunStatus, number> = {
        pending: 0,
        active: 1,
        done: 2,
        cancelled: 3,
      };

      /** The less-finished of two item statuses; null means "no run", which never wins over a run. */
      const worstStatus = (
        a: Domain.RunStatus | null,
        b: Domain.RunStatus | null,
      ) => {
        if (a === null) return b;
        if (b === null) return a;
        return RUN_STATUS_RANK[a] <= RUN_STATUS_RANK[b] ? a : b;
      };

      /**
       * The live line items of the orders behind the order runs on a queue
       * page, each with the worst status across its non-cancelled runs
       * (`pending` < `active` < `done`) or null when no item workflow touched
       * it. Read live rather than snapshotted so a late item shows on the
       * card as soon as reconcile stores it. `quantity` is `unfulfilledQuantity`
       * (`Domain.unitsToMake`) and fully refunded or shipped lines are dropped,
       * so a packer never packs a unit nobody will receive.
       */
      const orderItems = (orderIds: readonly string[]) =>
        orderIds.length === 0
          ? Effect.succeed([])
          : sql`
              select li.orderId, li.id as lineItemId, li.title, li.variantTitle,
                li.unfulfilledQuantity as quantity, li.customAttributes, r.status as runStatus
              from OrderLineItem li
              left join WorkflowRun r on r.lineItemId = li.id and r.status <> 'cancelled'
              where li.orderId in (select value from json_each(${json(orderIds)}))
                and li.unfulfilledQuantity > 0
              order by li.orderId, li.title
            `.pipe(
              Effect.flatMap(
                decode(
                  Schema.Array(
                    Schema.Struct({
                      ...Domain.QueueOrderItem.fields,
                      orderId: Schema.String,
                      customAttributes: Schema.fromJsonString(
                        Schema.Array(Domain.OrderAttribute),
                      ),
                    }),
                  ),
                  "Invalid queue order item row",
                ),
              ),
              Effect.map((rows) =>
                rows.reduce<
                  readonly (Domain.QueueOrderItem & {
                    readonly orderId: string;
                  })[]
                >((acc, row) => {
                  const previous = acc.find(
                    (item) => item.lineItemId === row.lineItemId,
                  );
                  if (previous === undefined) return [...acc, row];
                  const worst = worstStatus(row.runStatus, previous.runStatus);
                  return acc.map((item) =>
                    item === previous ? { ...item, runStatus: worst } : item,
                  );
                }, []),
              ),
            );

      /**
       * `status` is a function of the steps; recomputing it in SQL from the
       * same rows the step write just touched is what keeps the two in one
       * transaction with nothing to drift. A started step counts as `active`
       * on its own: "someone has started work" is exactly what should protect
       * a run from being silently cancelled by reconcile.
       */
      const recomputeStatus = (runId: string, now: number) =>
        sql`
          update WorkflowRun set
            status = (
              select case
                when count(*) = sum(completedAt is not null) then 'done'
                when sum(completedAt is not null) > 0 or sum(startedAt is not null) > 0 then 'active'
                else 'pending'
              end
              from WorkflowRunStep s where s.runId = WorkflowRun.id
            ),
            updatedAt = ${now}
          where id = ${runId}
        `;

      const cancelPending = (orderId: string, now: number) =>
        sql`
          update WorkflowRun
          set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
          where orderId = ${orderId} and status = 'pending'
          returning id
        `.pipe(Effect.map((rows) => rows.length));

      const flagWhere = (
        status: Statement.Fragment,
        where: Statement.Fragment,
        flag: Domain.RunFlag,
        detail: Domain.RunFlagDetail,
        now: number,
      ) =>
        sql`
          update WorkflowRun
          set flag = ${flag}, flagAt = ${now}, flagDetail = ${json(detail)}, updatedAt = ${now}
          where ${status} and ${where}
          returning id
        `.pipe(Effect.map((rows) => rows.length));

      const flagActive = (
        where: Statement.Fragment,
        flag: Domain.RunFlag,
        detail: Domain.RunFlagDetail,
        now: number,
      ) => flagWhere(sql`status = 'active'`, where, flag, detail, now);

      /**
       * Order runs only: flags `pending` as well as `active`. An item run that
       * is still pending is adjusted silently because no one has started it;
       * an order run's premise ("every item is made") is what changed, and
       * nothing silent can restore it, so the worker must see it either way.
       */
      const flagOpenOrderRuns = (
        orderId: string,
        flag: Domain.RunFlag,
        detail: Domain.RunFlagDetail,
        now: number,
      ) =>
        flagWhere(
          sql`status in ('pending', 'active')`,
          sql`orderId = ${orderId} and lineItemId is null`,
          flag,
          detail,
          now,
        );

      /**
       * `lineItem: null` writes an order run: the four line-item columns null
       * together, and the conflict target is the partial index
       * `WorkflowRun_order_uidx`, whose predicate the clause must repeat
       * verbatim for SQLite to pick it.
       */
      const insertRun = Effect.fn("WorkflowRunRepository.insertRun")(
        function* ({
          workflow: { workflow, steps },
          activeTeams,
          order,
          lineItem,
          source,
        }: {
          readonly workflow: Domain.WorkflowDetail;
          readonly activeTeams: RoutingContext["activeTeams"];
          readonly order: Domain.ShopOrder;
          readonly lineItem: Domain.OrderLineItem | null;
          readonly source: Domain.RunSource;
        }) {
          const now = yield* Clock.currentTimeMillis;
          const runId = crypto.randomUUID();
          const [run] = yield* decodeRuns(
            yield* sql`
              insert into WorkflowRun (
                id, workflowId, workflowName, orderId, orderName, lineItemId,
                lineItemTitle, variantTitle, sku, quantity, customAttributes,
                source, status, flag, flagAt, flagDetail, createdAt, updatedAt,
                cancelledAt
              ) values (
                ${runId}, ${workflow.id}, ${workflow.name}, ${order.id},
                ${order.name}, ${lineItem?.id ?? null}, ${lineItem?.title ?? null},
                ${lineItem?.variantTitle ?? null}, ${lineItem?.sku ?? null},
                ${lineItem === null ? null : Domain.unitsToMake(lineItem)},
                ${lineItem === null ? null : json(lineItem.customAttributes)},
                ${source}, 'pending', null, null, null, ${now}, ${now}, null
              )
              ${
                lineItem === null
                  ? sql`on conflict (orderId, workflowId) where lineItemId is null do nothing`
                  : sql`on conflict (lineItemId, workflowId) do nothing`
              }
              returning *
            `,
          );
          if (run === undefined) return Option.none();
          yield* Effect.forEach(
            steps,
            (step) => sql`
              insert into WorkflowRunStep
                (id, runId, position, stage, name, teamId, teamName, instructions,
                 startedAt, startedBy, completedAt, completedBy, note)
              values (
                ${crypto.randomUUID()}, ${runId}, ${step.position}, ${step.stage},
                ${step.name}, ${step.teamId},
                ${activeTeams.find((team) => team.id === step.teamId)?.name ?? ""},
                ${step.instructions}, null, null, null, null, null
              )
            `,
            { discard: true },
          );
          return Option.some(run);
        },
      );

      /**
       * The order-run trigger, evaluated inside the caller's transaction at
       * the end of every action that can finish an order's last open item run.
       * Never opens a transaction of its own. Returns how many order runs
       * started (0 or 1).
       *
       * Ready = `canStartRuns` (paid, not cancelled), the order workflow
       * routable and older than the order (the same age rule as item
       * routing), at least one item run `done`, no item run open, and no
       * order run for this workflow in any status — a cancelled order run
       * keeps its key, so recovery is un-cancel, never a second start. A
       * stock-only order (no item runs) never triggers.
       *
       * The age rule has one exception: an item run with `source = 'manual'`
       * opts the order in. Manual attach already overrides the age rule for
       * the item — an admin choosing to work an old order by hand — and the
       * item's completion would otherwise dead-end there, with the placeholder
       * promising packing that never comes. Tag-routed runs cannot exist on an
       * order older than their workflow, so this only ever fires on orders a
       * person deliberately pulled into production.
       */
      const startOrderRunIfReady = Effect.fn(
        "WorkflowRunRepository.startOrderRunIfReady",
      )(function* ({
        orderId,
        workflows,
        activeTeams,
      }: RoutingContext & { readonly orderId: string }) {
        const orderWorkflow = workflows.find(
          ({ workflow }) => workflow.scope === "order",
        );
        if (orderWorkflow === undefined) return 0;
        if (!isRoutable(orderWorkflow, activeTeams)) return 0;
        const [order] = yield* decodeOrders(
          yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
        );
        if (order === undefined || !Domain.canStartRuns(order)) return 0;
        const [ready] = yield* sql`
          select
            exists (
              select 1 from WorkflowRun
              where orderId = ${orderId} and lineItemId is not null and status = 'done'
            ) as anyDone,
            exists (
              select 1 from WorkflowRun
              where orderId = ${orderId} and lineItemId is not null and source = 'manual'
            ) as optedIn,
            exists (
              select 1 from WorkflowRun
              where orderId = ${orderId} and lineItemId is not null
                and status in ('pending', 'active')
            ) as anyOpen,
            exists (
              select 1 from WorkflowRun
              where orderId = ${orderId} and lineItemId is null
                and workflowId = ${orderWorkflow.workflow.id}
            ) as started
        `;
        if (
          ready === undefined ||
          Number(ready.anyDone) === 0 ||
          Number(ready.anyOpen) !== 0 ||
          Number(ready.started) !== 0
        )
          return 0;
        if (
          order.processedAt < orderWorkflow.workflow.createdAt &&
          Number(ready.optedIn) === 0
        )
          return 0;
        const run = yield* insertRun({
          workflow: orderWorkflow,
          activeTeams,
          order,
          lineItem: null,
          source: "tag",
        });
        if (Option.isNone(run)) return 0;
        yield* Effect.logInfo(
          `WorkflowRunRepository.startOrderRun: orderId=${orderId} workflowId=${orderWorkflow.workflow.id} runId=${run.value.id}`,
        ).pipe(
          Effect.annotateLogs({
            orderId,
            workflowId: orderWorkflow.workflow.id,
            runId: run.value.id,
          }),
        );
        return 1;
      });

      return WorkflowRunRepository.of({
        /**
         * Two gates, deliberately split. `Domain.isCancelled` and
         * `Domain.isFulfilled` are the stop gates and return early;
         * `Domain.canStartRuns` (paid) gates only run *creation* and the
         * order-run trigger. Adjusting open runs against their line items and
         * flagging order runs happen whether or not the order is currently
         * paid, so an edit that pushes a paid order back to unpaid keeps its
         * runs, still tracks removals and quantity changes, and simply creates
         * nothing new until the balance lands — a payment wobble must never
         * cancel work in progress.
         */
        reconcileOrder: Effect.fn("WorkflowRunRepository.reconcileOrder")(
          function* ({
            orderId,
            workflows,
            activeTeams,
          }: RoutingContext & { readonly orderId: string }) {
            const now = yield* Clock.currentTimeMillis;
            const [order] = yield* decodeOrders(
              yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
            );
            if (order === undefined) return NO_COUNTS;
            const earlyExit = (status: "cancelled" | "fulfilled") =>
              Effect.logInfo(
                `WorkflowRunRepository.reconcileOrder: orderId=${orderId} status=${status}`,
              ).pipe(Effect.annotateLogs({ orderId, status }));
            if (Domain.isCancelled(order)) {
              yield* earlyExit("cancelled");
              return {
                ...NO_COUNTS,
                cancelled: yield* cancelPending(orderId, now),
                flagged: yield* flagActive(
                  sql`orderId = ${orderId}`,
                  "order_cancelled",
                  {},
                  now,
                ),
              };
            }
            /**
             * Nothing left to make or pack. Pending item runs go silently
             * (no one started them); active item runs and every open order
             * run are flagged because their premise cannot be restored.
             * `PARTIALLY_FULFILLED` never lands here: the shipped line's
             * `unfulfilledQuantity` is 0 and `adjust` handles it per line.
             */
            if (Domain.isFulfilled(order)) {
              yield* earlyExit("fulfilled");
              const cancelled = yield* cancelPending(orderId, now);
              const flaggedItems = yield* flagActive(
                sql`orderId = ${orderId} and lineItemId is not null`,
                "order_fulfilled",
                {},
                now,
              );
              const flaggedOrderRuns = yield* flagOpenOrderRuns(
                orderId,
                "order_fulfilled",
                {},
                now,
              );
              return {
                ...NO_COUNTS,
                cancelled,
                flagged: flaggedItems + flaggedOrderRuns,
              };
            }
            const canStart = Domain.canStartRuns(order);
            const lineItems = yield* decodeLineItems(
              yield* sql`select * from OrderLineItem where orderId = ${orderId}`,
            );
            const runs = yield* decodeRuns(
              yield* sql`
                select * from WorkflowRun
                where orderId = ${orderId} and status in ('pending', 'active')
              `,
            );
            const routable = workflows.filter((workflow) =>
              isRoutable(workflow, activeTeams),
            );
            const inserted = canStart
              ? yield* Effect.forEach(
                  lineItems.flatMap((lineItem) =>
                    routable
                      .filter(
                        (workflow) =>
                          workflow.workflow.scope === "item" &&
                          matchesLineItem(workflow, order, lineItem),
                      )
                      .map((workflow) => ({ workflow, lineItem })),
                  ),
                  ({ workflow, lineItem }) =>
                    insertRun({
                      workflow,
                      activeTeams,
                      order,
                      lineItem,
                      source: "tag",
                    }).pipe(
                      Effect.map(
                        Option.map((run) => ({ run, item: lineItem.title })),
                      ),
                    ),
                ).pipe(Effect.map((results) => results.filter(Option.isSome)))
              : [];
            const created = inserted.length;
            const itemRuns = runs.filter((run) => run.lineItemId !== null);
            const orderRuns = runs.filter((run) => run.lineItemId === null);
            /**
             * Tracks `Domain.unitsToMake`, so a refund that zeroes or lowers
             * `unfulfilledQuantity` reads exactly like a removal or an edit.
             * `removed` names the item so the order run's flag can carry it.
             */
            const adjust = (run: Domain.WorkflowRun) => {
              const lineItem = lineItems.find(
                (item) => item.id === run.lineItemId,
              );
              if (lineItem === undefined || Domain.unitsToMake(lineItem) === 0)
                return run.status === "pending"
                  ? sql`
                      update WorkflowRun
                      set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                      where id = ${run.id}
                    `.pipe(
                      Effect.as({
                        cancelled: 1,
                        flagged: 0,
                        removed: null,
                      }),
                    )
                  : flagActive(
                      sql`id = ${run.id}`,
                      "item_removed",
                      {},
                      now,
                    ).pipe(
                      Effect.map((flagged) => ({
                        cancelled: 0,
                        flagged,
                        removed: flagged > 0 ? run.lineItemTitle : null,
                      })),
                    );
              const units = Domain.unitsToMake(lineItem);
              if (units === run.quantity)
                return Effect.succeed({
                  cancelled: 0,
                  flagged: 0,
                  removed: null,
                });
              return sql`
                update WorkflowRun
                set quantity = ${units}, updatedAt = ${now}
                where id = ${run.id}
              `.pipe(
                Effect.andThen(
                  run.status === "pending"
                    ? Effect.succeed(0)
                    : flagActive(
                        sql`id = ${run.id}`,
                        "quantity_changed",
                        { from: run.quantity ?? 0, to: units },
                        now,
                      ),
                ),
                Effect.map((flagged) => ({
                  cancelled: 0,
                  flagged,
                  removed: null,
                })),
              );
            };
            const adjusted = yield* Effect.all(itemRuns.map(adjust));
            // Order runs already open: a new item, or an item removed in this
            // pass, breaks "all items made". Removal wins when both happen,
            // because it is the one the worker cannot see from the items list.
            const addedItem = inserted[0]?.value.item ?? null;
            const removedItem =
              adjusted.find((delta) => delta.removed !== null)?.removed ?? null;
            const orderRunFlag = (():
              | readonly [Domain.RunFlag, string]
              | null => {
              if (orderRuns.length === 0) return null;
              if (removedItem !== null) return ["item_removed", removedItem];
              if (addedItem !== null) return ["item_added", addedItem];
              return null;
            })();
            const orderRunFlags =
              orderRunFlag === null
                ? 0
                : yield* flagOpenOrderRuns(
                    orderId,
                    orderRunFlag[0],
                    { item: orderRunFlag[1] },
                    now,
                  );
            const startedOrderRuns = canStart
              ? yield* startOrderRunIfReady({
                  orderId,
                  workflows,
                  activeTeams,
                })
              : 0;
            return adjusted.reduce<ReconcileCounts>(
              (counts, delta) => ({
                ...counts,
                cancelled: counts.cancelled + delta.cancelled,
                flagged: counts.flagged + delta.flagged,
              }),
              {
                created,
                cancelled: 0,
                flagged: orderRunFlags,
                orderRuns: startedOrderRuns,
              },
            );
          },
        ),

        createRun: Effect.fn("WorkflowRunRepository.createRun")(function* (
          input: Parameters<typeof insertRun>[0] & {
            readonly lineItem: Domain.OrderLineItem;
          },
        ) {
          return yield* sql.withTransaction(
            insertRun(input).pipe(
              Effect.tap((run) =>
                Option.isNone(run)
                  ? Effect.void
                  : Clock.currentTimeMillis.pipe(
                      Effect.flatMap((now) =>
                        flagOpenOrderRuns(
                          input.order.id,
                          "item_added",
                          { item: input.lineItem.title },
                          now,
                        ),
                      ),
                    ),
              ),
            ),
          );
        }),

        markOrderDeleted: Effect.fn("WorkflowRunRepository.markOrderDeleted")(
          function* ({ orderId }: { readonly orderId: string }) {
            const now = yield* Clock.currentTimeMillis;
            yield* cancelPending(orderId, now);
            yield* flagActive(
              sql`orderId = ${orderId}`,
              "order_deleted",
              {},
              now,
            );
          },
        ),

        listRunsForOrder: Effect.fn("WorkflowRunRepository.listRunsForOrder")(
          function* ({ orderId }: { readonly orderId: string }) {
            return yield* withSteps(
              yield* decodeRuns(
                yield* sql`
                  select * from WorkflowRun
                  where orderId = ${orderId}
                  order by lineItemId is null, lineItemId, createdAt
                `,
              ),
            );
          },
        ),

        getRun: Effect.fn("WorkflowRunRepository.getRun")(function* ({
          runId,
        }: {
          readonly runId: string;
        }) {
          const run = yield* findRun(runId);
          if (Option.isNone(run)) return Option.none();
          return Option.some({
            run: run.value,
            steps: yield* stepsOf(runId),
          } satisfies Domain.WorkflowRunDetail);
        }),

        cancelRun: Effect.fn("WorkflowRunRepository.cancelRun")(function* ({
          runId,
          routing,
        }: {
          readonly runId: string;
          readonly routing?: RoutingContext;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (run.status === "done" || run.status === "cancelled")
                yield* new RunTerminalError({ runId, status: run.status });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update WorkflowRun
                set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                where id = ${runId}
              `;
              if (routing !== undefined && !Domain.isOrderRun(run))
                yield* startOrderRunIfReady({
                  ...routing,
                  orderId: run.orderId,
                });
            }),
          );
        }),

        uncancelRun: Effect.fn("WorkflowRunRepository.uncancelRun")(function* ({
          runId,
        }: {
          readonly runId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (run.status !== "cancelled")
                yield* new RunTerminalError({ runId, status: run.status });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`update WorkflowRun set cancelledAt = null where id = ${runId}`;
              yield* recomputeStatus(runId, now);
              if (!Domain.isOrderRun(run))
                yield* flagOpenOrderRuns(
                  run.orderId,
                  "item_added",
                  { item: run.lineItemTitle ?? "" },
                  now,
                );
            }),
          );
        }),

        /**
         * Two statements: every ready step of every run that has at least one
         * ready step for the caller's teams (so siblings owned by other teams
         * are in hand), then those runs with their last stage and the order's
         * live note. Grouping happens here in TypeScript; `json_each` keeps the
         * team list a single bound parameter.
         */
        listQueue: Effect.fn("WorkflowRunRepository.listQueue")(function* ({
          teamIds,
        }: {
          readonly teamIds: readonly string[];
        }) {
          if (teamIds.length === 0) return [];
          const ready = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowRunStep s
              join WorkflowRun r on r.id = s.runId
              where r.status in ('pending', 'active')
                and ${readyWhere("s")}
                and exists (
                  select 1 from WorkflowRunStep m
                  where m.runId = s.runId
                    and m.teamId in (select value from json_each(${json(teamIds)}))
                    and ${readyWhere("m")}
                )
              order by s.runId, s.position
            `,
          );
          if (ready.length === 0) return [];
          const runIds = [...new Set(ready.map((step) => step.runId))];
          const runs = yield* decodeQueueRuns(
            yield* sql`
              select r.*, o.note,
                (select max(stage) from WorkflowRunStep c where c.runId = r.id) as stageCount
              from WorkflowRun r
              left join ShopOrder o on o.id = r.orderId
              where r.id in (select value from json_each(${json(runIds)}))
              order by r.flag is null, r.createdAt, r.orderName, r.lineItemId
            `,
          );
          const orderIds = [
            ...new Set(
              runs
                .filter((run) => run.lineItemId === null)
                .map((run) => run.orderId),
            ),
          ];
          const items = yield* orderItems(orderIds);
          return runs.flatMap(({ note, stageCount, ...run }): QueueRow[] => {
            const ofRun = ready.filter((step) => step.runId === run.id);
            const mine = ofRun.filter((step) => teamIds.includes(step.teamId));
            if (mine.length === 0) return [];
            return [
              {
                run,
                stageCount,
                note,
                items:
                  run.lineItemId === null
                    ? items.filter((item) => item.orderId === run.orderId)
                    : [],
                steps: mine.map((step) => ({
                  ...step,
                  siblings: ofRun
                    .filter(
                      (other) =>
                        other.stage === step.stage &&
                        !mine.some((m) => m.id === other.id),
                    )
                    .map((other) => ({
                      name: other.name,
                      teamName: other.teamName,
                    })),
                })),
              },
            ];
          });
        }),

        startStep: Effect.fn("WorkflowRunRepository.startStep")(function* ({
          runStepId,
          memberId,
          teamIds,
        }: {
          readonly runStepId: string;
          readonly memberId: Domain.MemberId;
          readonly teamIds: readonly string[];
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { run } = yield* requireActionable({ runStepId, teamIds });
              if (!(yield* isReady(runStepId)))
                yield* new StepNotReadyError({ runStepId });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update WorkflowRunStep
                set startedAt = coalesce(startedAt, ${now}),
                    startedBy = coalesce(startedBy, ${memberId})
                where id = ${runStepId}
              `;
              yield* recomputeStatus(run.id, now);
            }),
          );
        }),

        completeStep: Effect.fn("WorkflowRunRepository.completeStep")(
          function* ({
            runStepId,
            memberId,
            teamIds,
            routing,
          }: {
            readonly runStepId: string;
            readonly memberId: Domain.MemberId;
            readonly teamIds: readonly string[];
            readonly routing?: RoutingContext;
          }) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const { run } = yield* requireActionable({
                  runStepId,
                  teamIds,
                });
                if (!(yield* isReady(runStepId)))
                  yield* new StepNotReadyError({ runStepId });
                const now = yield* Clock.currentTimeMillis;
                yield* sql`
                  update WorkflowRunStep
                  set completedAt = ${now}, completedBy = ${memberId},
                      startedAt = coalesce(startedAt, ${now}),
                      startedBy = coalesce(startedBy, ${memberId})
                  where id = ${runStepId}
                `;
                yield* recomputeStatus(run.id, now);
                if (routing !== undefined && !Domain.isOrderRun(run))
                  yield* startOrderRunIfReady({
                    ...routing,
                    orderId: run.orderId,
                  });
              }),
            );
          },
        ),

        setStepNote: Effect.fn("WorkflowRunRepository.setStepNote")(function* ({
          runStepId,
          teamIds,
          note,
        }: {
          readonly runStepId: string;
          readonly memberId: Domain.MemberId;
          readonly teamIds: readonly string[];
          readonly note: Domain.StepNote | null;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { run } = yield* requireActionable({ runStepId, teamIds });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`update WorkflowRunStep set note = ${note} where id = ${runStepId}`;
              yield* sql`update WorkflowRun set updatedAt = ${now} where id = ${run.id}`;
            }),
          );
        }),

        blockRun: Effect.fn("WorkflowRunRepository.blockRun")(function* ({
          runId,
          memberId,
          teamIds,
          reason,
        }: {
          readonly runId: string;
          readonly memberId: Domain.MemberId;
          readonly teamIds: readonly string[];
          readonly reason: Domain.StepNote | null;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (isTerminal(run))
                yield* new RunTerminalError({ runId, status: run.status });
              yield* requireReadyTeam(runId, teamIds);
              const now = yield* Clock.currentTimeMillis;
              const detail: Domain.RunFlagDetail =
                reason === null ? { by: memberId } : { reason, by: memberId };
              yield* sql`
                update WorkflowRun
                set flag = 'blocked', flagAt = ${now}, flagDetail = ${json(detail)}, updatedAt = ${now}
                where id = ${runId}
              `;
            }),
          );
        }),

        dismissFlag: Effect.fn("WorkflowRunRepository.dismissFlag")(function* ({
          runId,
          teamIds,
        }: {
          readonly runId: string;
          readonly teamIds: readonly string[];
        }) {
          const run = yield* requireRun(runId);
          yield* requireReadyTeam(runId, teamIds);
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
              update WorkflowRun
              set flag = null, flagAt = null, flagDetail = null, updatedAt = ${now}
              where id = ${run.id}
            `;
        }),
      });
    }),
  );
}

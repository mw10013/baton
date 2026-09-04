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
}

export interface ReconcileCounts {
  readonly created: number;
  readonly cancelled: number;
  readonly flagged: number;
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
  lineItem.currentQuantity > 0 &&
  lineItem.unfulfilledQuantity > 0 &&
  order.processedAt >= workflow.createdAt &&
  lineItem.productTags.some((tag) => {
    const folded = tag.trim().toLowerCase();
    return workflow.tags.some((candidate) => candidate === folded);
  });

export const isEligibleOrder = (order: Domain.ShopOrder) =>
  order.fullyPaid && order.cancelledAt === null;

const json = (value: unknown) => JSON.stringify(value);

const isTerminal = (run: Domain.WorkflowRun) =>
  run.status === "done" || run.status === "cancelled";

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
    /** `None` when `(lineItemId, workflowId)` already has a run in any status. */
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
    readonly cancelRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunTerminalError
    >;
    /** Only from `cancelled`; status is recomputed from the steps. */
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
    /** Also backfills `startedAt` / `startedBy` when Done arrives without a Start, so every finished step records who. */
    readonly completeStep: (input: {
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

      const flagActive = (
        where: Statement.Fragment,
        flag: Domain.RunFlag,
        detail: Domain.RunFlagDetail,
        now: number,
      ) =>
        sql`
          update WorkflowRun
          set flag = ${flag}, flagAt = ${now}, flagDetail = ${json(detail)}, updatedAt = ${now}
          where status = 'active' and ${where}
          returning id
        `.pipe(Effect.map((rows) => rows.length));

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
          readonly lineItem: Domain.OrderLineItem;
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
                ${order.name}, ${lineItem.id}, ${lineItem.title},
                ${lineItem.variantTitle}, ${lineItem.sku},
                ${lineItem.currentQuantity}, ${json(lineItem.customAttributes)},
                ${source}, 'pending', null, null, null, ${now}, ${now}, null
              )
              on conflict (lineItemId, workflowId) do nothing
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

      return WorkflowRunRepository.of({
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
            if (order === undefined)
              return { created: 0, cancelled: 0, flagged: 0 };
            if (!isEligibleOrder(order))
              return {
                created: 0,
                cancelled: yield* cancelPending(orderId, now),
                flagged:
                  order.cancelledAt === null
                    ? 0
                    : yield* flagActive(
                        sql`orderId = ${orderId}`,
                        "order_cancelled",
                        {},
                        now,
                      ),
              };
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
            const created = yield* Effect.forEach(
              lineItems.flatMap((lineItem) =>
                routable
                  .filter((workflow) =>
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
                }),
            ).pipe(
              Effect.map((results) => results.filter(Option.isSome).length),
            );
            const adjust = (run: Domain.WorkflowRun) => {
              const lineItem = lineItems.find(
                (item) => item.id === run.lineItemId,
              );
              if (lineItem === undefined || lineItem.currentQuantity === 0)
                return run.status === "pending"
                  ? sql`
                      update WorkflowRun
                      set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                      where id = ${run.id}
                    `.pipe(Effect.as({ cancelled: 1, flagged: 0 }))
                  : flagActive(
                      sql`id = ${run.id}`,
                      "item_removed",
                      {},
                      now,
                    ).pipe(
                      Effect.map((flagged) => ({ cancelled: 0, flagged })),
                    );
              if (lineItem.currentQuantity === run.quantity)
                return Effect.succeed({ cancelled: 0, flagged: 0 });
              return sql`
                update WorkflowRun
                set quantity = ${lineItem.currentQuantity}, updatedAt = ${now}
                where id = ${run.id}
              `.pipe(
                Effect.andThen(
                  run.status === "pending"
                    ? Effect.succeed(0)
                    : flagActive(
                        sql`id = ${run.id}`,
                        "quantity_changed",
                        { from: run.quantity, to: lineItem.currentQuantity },
                        now,
                      ),
                ),
                Effect.map((flagged) => ({ cancelled: 0, flagged })),
              );
            };
            const adjusted = yield* Effect.all(runs.map(adjust));
            return adjusted.reduce<ReconcileCounts>(
              (counts, delta) => ({
                created: counts.created,
                cancelled: counts.cancelled + delta.cancelled,
                flagged: counts.flagged + delta.flagged,
              }),
              { created, cancelled: 0, flagged: 0 },
            );
          },
        ),

        createRun: Effect.fn("WorkflowRunRepository.createRun")(function* (
          input: Parameters<typeof insertRun>[0],
        ) {
          return yield* sql.withTransaction(insertRun(input));
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
                  order by lineItemId, createdAt
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
        }: {
          readonly runId: string;
        }) {
          const run = yield* requireRun(runId);
          if (run.status === "done" || run.status === "cancelled")
            yield* new RunTerminalError({ runId, status: run.status });
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
            update WorkflowRun
            set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
            where id = ${runId}
          `;
        }),

        uncancelRun: Effect.fn("WorkflowRunRepository.uncancelRun")(function* ({
          runId,
        }: {
          readonly runId: string;
        }) {
          const run = yield* requireRun(runId);
          if (run.status !== "cancelled")
            yield* new RunTerminalError({ runId, status: run.status });
          const now = yield* Clock.currentTimeMillis;
          yield* sql`update WorkflowRun set cancelledAt = null where id = ${runId}`;
          yield* recomputeStatus(runId, now);
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
          return runs.flatMap(({ note, stageCount, ...run }): QueueRow[] => {
            const ofRun = ready.filter((step) => step.runId === run.id);
            const mine = ofRun.filter((step) => teamIds.includes(step.teamId));
            if (mine.length === 0) return [];
            return [
              {
                run,
                stageCount,
                note,
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
          }: {
            readonly runStepId: string;
            readonly memberId: Domain.MemberId;
            readonly teamIds: readonly string[];
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

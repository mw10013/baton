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

/** A lower-position step is still open, or this step is already completed. */
export class StepNotCurrentError extends Schema.TaggedError<StepNotCurrentError>()(
  "StepNotCurrentError",
  { runStepId: Schema.String },
) {}

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
    readonly listQueue: (input: {
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      readonly Domain.QueueItem[],
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
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
      | StepNotCurrentError
      | RunTerminalError
    >;
    /** Allowed when the run's current step belongs to one of `teamIds`. */
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
       * transaction with nothing to drift.
       */
      const recomputeStatus = (runId: string, now: number) =>
        sql`
          update WorkflowRun set
            status = (
              select case
                when count(*) = sum(completedAt is not null) then 'done'
                when sum(completedAt is not null) > 0 then 'active'
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
                (id, runId, position, name, teamId, teamName, completedAt, completedBy)
              values (
                ${crypto.randomUUID()}, ${runId}, ${step.position}, ${step.name},
                ${step.teamId},
                ${activeTeams.find((team) => team.id === step.teamId)?.name ?? ""},
                null, null
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
         * The current step is the lowest open position; the `not exists`
         * clause selects exactly one step per run without a `group by`, and
         * `json_each` keeps the team list a single bound parameter.
         */
        listQueue: Effect.fn("WorkflowRunRepository.listQueue")(function* ({
          teamIds,
        }: {
          readonly teamIds: readonly string[];
        }) {
          if (teamIds.length === 0) return [];
          const steps = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowRunStep s
              join WorkflowRun r on r.id = s.runId
              where r.status in ('pending', 'active')
                and s.completedAt is null
                and s.teamId in (select value from json_each(${json(teamIds)}))
                and not exists (
                  select 1 from WorkflowRunStep p
                  where p.runId = s.runId and p.completedAt is null and p.position < s.position
                )
            `,
          );
          if (steps.length === 0) return [];
          const runs = yield* decodeQueueRuns(
            yield* sql`
              select r.*, o.note from WorkflowRun r
              left join ShopOrder o on o.id = r.orderId
              where r.id in (select value from json_each(${json(steps.map((step) => step.runId))}))
              order by r.flag is null, r.createdAt, r.orderName, r.lineItemId
            `,
          );
          return runs.flatMap(({ note, ...run }) => {
            const step = steps.find((candidate) => candidate.runId === run.id);
            return step === undefined ? [] : [{ run, step, note }];
          });
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
                const step = yield* requireStep(runStepId);
                const run = yield* requireRun(step.runId);
                if (!teamIds.includes(step.teamId))
                  yield* new RunNotAllowedError({
                    runId: run.id,
                    teamId: step.teamId,
                  });
                if (run.status === "done" || run.status === "cancelled")
                  yield* new RunTerminalError({
                    runId: run.id,
                    status: run.status,
                  });
                const open = yield* stepsOf(run.id).pipe(
                  Effect.map((steps) =>
                    steps.filter((candidate) => candidate.completedAt === null),
                  ),
                );
                if (step.completedAt !== null || open[0]?.id !== step.id)
                  yield* new StepNotCurrentError({ runStepId });
                const now = yield* Clock.currentTimeMillis;
                yield* sql`
                  update WorkflowRunStep
                  set completedAt = ${now}, completedBy = ${memberId}
                  where id = ${runStepId}
                `;
                yield* recomputeStatus(run.id, now);
              }),
            );
          },
        ),

        dismissFlag: Effect.fn("WorkflowRunRepository.dismissFlag")(function* ({
          runId,
          teamIds,
        }: {
          readonly runId: string;
          readonly teamIds: readonly string[];
        }) {
          const run = yield* requireRun(runId);
          const current = (yield* stepsOf(runId)).find(
            (step) => step.completedAt === null,
          );
          if (current === undefined || !teamIds.includes(current.teamId))
            yield* new RunNotAllowedError({
              runId,
              teamId: current?.teamId ?? "",
            });
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

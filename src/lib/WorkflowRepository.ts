import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import {
  SqlClient,
  type SqlConnection,
  type Statement,
} from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
export class WorkflowRepositoryError extends Schema.TaggedError<WorkflowRepositoryError>()(
  "WorkflowRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Another workflow — possibly an archived one — already holds the name,
 * case-insensitively. Archived rows keep their names on purpose: two rows named
 * X, one archived, would make history and pickers ambiguous, and unarchiving
 * is one click. Detected by `insert or ignore ... returning` yielding no row,
 * not by matching constraint text.
 */
export class WorkflowNameTakenError extends Schema.TaggedError<WorkflowNameTakenError>()(
  "WorkflowNameTakenError",
  { name: Domain.WorkflowName },
) {}

export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { workflowId: Schema.String },
) {}

export class StepNotFoundError extends Schema.TaggedError<StepNotFoundError>()(
  "StepNotFoundError",
  { stepId: Schema.String },
) {}

export class WorkflowLimitError extends Schema.TaggedError<WorkflowLimitError>()(
  "WorkflowLimitError",
  { limit: Schema.Number },
) {}

const json = (value: unknown) => JSON.stringify(value);

const count = (query: Statement.Statement<SqlConnection.Row>) =>
  query.values.pipe(Effect.map((rows) => Number(rows[0]?.[0] ?? 0)));

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  {
    readonly listWorkflows: (input: {
      readonly includeArchived: boolean;
    }) => Effect.Effect<
      readonly Domain.WorkflowSummary[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    readonly getWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowDetail>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Every non-archived definition with its steps, in two statements rather
     * than one per workflow: this is what an order upsert loads before routing
     * its line items, and a bulk stream loads it once for thousands of orders.
     */
    readonly listActiveWorkflowDetails: () => Effect.Effect<
      readonly Domain.WorkflowDetail[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Development seed only (`ShopAgent.seedWorkflows`): replaces every
     * definition and every run with `workflows`, in one transaction, steps
     * included. Destructive on purpose — a reseed exists to discard whatever
     * the last one left behind, and skipping existing names would preserve it.
     *
     * `WorkflowRun` needs its own delete: it deliberately has no foreign key
     * to `Workflow` (a run snapshots its definition so it survives a rename or
     * an archive), so nothing cascades from the `Workflow` delete to it.
     *
     * Bypasses the name, limit, and active-team checks the ordinary write path
     * enforces: positions come from array order and `teamId` from `Team` rows
     * the caller created moments earlier, so there is nothing left to race.
     * The Durable Object gates the callable on `ENVIRONMENT === "local"`.
     */
    readonly replaceWorkflows: (
      input: Domain.SeedWorkflowsInput,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly createWorkflow: (input: {
      readonly name: Domain.WorkflowName;
      readonly tags: Domain.ProductTags;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNameTakenError
      | WorkflowLimitError
    >;
    readonly updateWorkflow: (input: {
      readonly workflowId: string;
      readonly name: Domain.WorkflowName;
      readonly tags: Domain.ProductTags;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNameTakenError
      | WorkflowNotFoundError
    >;
    /**
     * Unconditional and idempotent. Nothing points at a definition — a future
     * running instance copies its steps — so archiving only stops new line
     * items from routing here. Guard live pointers (step → team), never copies.
     */
    readonly setWorkflowArchived: (input: {
      readonly workflowId: string;
      readonly archived: boolean;
    }) => Effect.Effect<
      Domain.Workflow,
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
    >;
    readonly addStep: (input: {
      readonly workflowId: string;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
    }) => Effect.Effect<
      Domain.WorkflowStep,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowLimitError
    >;
    readonly getStep: (input: {
      readonly stepId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowStep>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    readonly updateStep: (input: {
      readonly stepId: string;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
    }) => Effect.Effect<
      Domain.WorkflowStep,
      SqlError.SqlError | WorkflowRepositoryError | StepNotFoundError
    >;
    /** A move past either edge is a no-op, not an error. */
    readonly moveStep: (input: {
      readonly stepId: string;
      readonly direction: Domain.StepDirection;
    }) => Effect.Effect<
      void,
      SqlError.SqlError | WorkflowRepositoryError | StepNotFoundError
    >;
    readonly removeStep: (input: {
      readonly stepId: string;
    }) => Effect.Effect<
      void,
      SqlError.SqlError | WorkflowRepositoryError | StepNotFoundError
    >;
    /**
     * Counts steps of archived workflows too: an archived workflow can be
     * restored, and its steps would then point at a team that no longer
     * exists as a place work can go.
     */
    readonly countStepsOwnedBy: (input: {
      readonly teamId: string;
    }) => Effect.Effect<number, SqlError.SqlError>;
    readonly listStepsOwnedBy: (input: {
      readonly teamId: string;
    }) => Effect.Effect<
      readonly Domain.OwnedStep[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
  }
>()("WorkflowRepository") {
  static readonly layer: Layer.Layer<
    WorkflowRepository,
    never,
    SqlClient.SqlClient
  > = Layer.effect(
    WorkflowRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const decode =
        <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
        (rows: unknown) =>
          Schema.decodeUnknownEffect(schema)(rows).pipe(
            Effect.mapError(
              (cause) => new WorkflowRepositoryError({ message, cause }),
            ),
          );

      const decodeWorkflows = decode(
        Schema.Array(Domain.Workflow),
        "Invalid Workflow row",
      );
      const decodeSteps = decode(
        Schema.Array(Domain.WorkflowStep),
        "Invalid WorkflowStep row",
      );

      const workflowColumns = sql.literal(
        "id, name, tags, createdAt, updatedAt, archivedAt",
      );

      const findWorkflow = (workflowId: string) =>
        sql`select ${workflowColumns} from Workflow where id = ${workflowId}`.pipe(
          Effect.flatMap(decodeWorkflows),
          Effect.map(([workflow]) => Option.fromUndefinedOr(workflow)),
        );

      const findStep = (stepId: string) =>
        sql`select * from WorkflowStep where id = ${stepId}`.pipe(
          Effect.flatMap(decodeSteps),
          Effect.map(([step]) => Option.fromUndefinedOr(step)),
        );

      const requireStep = (stepId: string) =>
        findStep(stepId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new StepNotFoundError({ stepId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const countSteps = (workflowId: string) =>
        count(
          sql`select count(*) from WorkflowStep where workflowId = ${workflowId}`,
        );

      return WorkflowRepository.of({
        listWorkflows: Effect.fn("WorkflowRepository.listWorkflows")(
          function* ({
            includeArchived,
          }: {
            readonly includeArchived: boolean;
          }) {
            return yield* decode(
              Schema.Array(Domain.WorkflowSummary),
              "Invalid WorkflowSummary row",
            )(
              yield* sql`
                select w.id, w.name, w.tags, w.createdAt, w.updatedAt, w.archivedAt,
                  (select count(*) from WorkflowStep s where s.workflowId = w.id) as stepCount,
                  (select count(*) from WorkflowRun r
                    where r.workflowId = w.id and r.status in ('pending', 'active')) as activeRunCount
                from Workflow w
                ${includeArchived ? sql`` : sql`where w.archivedAt is null`}
                order by w.archivedAt is not null, w.name collate nocase
              `,
            );
          },
        ),

        getWorkflow: Effect.fn("WorkflowRepository.getWorkflow")(function* ({
          workflowId,
        }: {
          readonly workflowId: string;
        }) {
          const workflow = yield* findWorkflow(workflowId);
          if (Option.isNone(workflow)) return Option.none();
          return Option.some({
            workflow: workflow.value,
            steps: yield* decodeSteps(
              yield* sql`
                select * from WorkflowStep
                where workflowId = ${workflowId}
                order by position
              `,
            ),
          } satisfies Domain.WorkflowDetail);
        }),

        listActiveWorkflowDetails: Effect.fn(
          "WorkflowRepository.listActiveWorkflowDetails",
        )(function* () {
          const workflows = yield* decodeWorkflows(
            yield* sql`
              select ${workflowColumns} from Workflow
              where archivedAt is null
              order by name collate nocase
            `,
          );
          const steps = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowStep s
              join Workflow w on w.id = s.workflowId
              where w.archivedAt is null
              order by s.workflowId, s.position
            `,
          );
          return workflows.map((workflow): Domain.WorkflowDetail => ({
            workflow,
            steps: steps.filter((step) => step.workflowId === workflow.id),
          }));
        }),

        /**
         * `insert or ignore ... returning` is the whole name check, as
         * `Repository.createTeam` does: a fresh uuid leaves the name index as
         * the only reachable unique constraint, so an empty result means
         * exactly "taken". The active-count check precedes it and is safe
         * without a transaction because the Durable Object runs one turn at a
         * time and neither statement awaits anything else.
         */
        replaceWorkflows: Effect.fn("WorkflowRepository.replaceWorkflows")(
          function* ({ workflows }: Domain.SeedWorkflowsInput) {
            const now = yield* Clock.currentTimeMillis;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`delete from WorkflowRun`;
                yield* sql`delete from Workflow`;
                for (const workflow of workflows) {
                  const workflowId = crypto.randomUUID();
                  yield* sql`
                    insert into Workflow
                      (id, name, tags, createdAt, updatedAt, archivedAt)
                    values
                      (${workflowId}, ${workflow.name}, ${json(workflow.tags)}, ${now}, ${now}, null)
                  `;
                  for (const [index, step] of workflow.steps.entries())
                    yield* sql`
                      insert into WorkflowStep
                        (id, workflowId, position, name, teamId, createdAt)
                      values
                        (${crypto.randomUUID()}, ${workflowId}, ${index + 1}, ${step.name}, ${step.teamId}, ${now})
                    `;
                }
              }),
            );
          },
        ),

        createWorkflow: Effect.fn("WorkflowRepository.createWorkflow")(
          function* ({
            name,
            tags,
          }: {
            readonly name: Domain.WorkflowName;
            readonly tags: Domain.ProductTags;
          }) {
            const active = yield* count(
              sql`select count(*) from Workflow where archivedAt is null`,
            );
            if (active >= Domain.WorkflowLimits.maxWorkflows)
              return yield* new WorkflowLimitError({
                limit: Domain.WorkflowLimits.maxWorkflows,
              });
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                insert or ignore into Workflow
                  (id, name, tags, createdAt, updatedAt, archivedAt)
                values
                  (${crypto.randomUUID()}, ${name}, ${json(tags)}, ${now}, ${now}, null)
                returning ${workflowColumns}
              `,
            );
            return workflow ?? (yield* new WorkflowNameTakenError({ name }));
          },
        ),

        /**
         * `update or ignore` turns a name collision into zero returned rows,
         * which makes "no rows" ambiguous with "no such workflow"; the
         * follow-up existence check disambiguates and only runs on failure.
         */
        updateWorkflow: Effect.fn("WorkflowRepository.updateWorkflow")(
          function* ({
            workflowId,
            name,
            tags,
          }: {
            readonly workflowId: string;
            readonly name: Domain.WorkflowName;
            readonly tags: Domain.ProductTags;
          }) {
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                update or ignore Workflow
                set name = ${name}, tags = ${json(tags)}, updatedAt = ${now}
                where id = ${workflowId}
                returning ${workflowColumns}
              `,
            );
            if (workflow !== undefined) return workflow;
            return Option.isSome(yield* findWorkflow(workflowId))
              ? yield* new WorkflowNameTakenError({ name })
              : yield* new WorkflowNotFoundError({ workflowId });
          },
        ),

        setWorkflowArchived: Effect.fn(
          "WorkflowRepository.setWorkflowArchived",
        )(function* ({
          workflowId,
          archived,
        }: {
          readonly workflowId: string;
          readonly archived: boolean;
        }) {
          const now = yield* Clock.currentTimeMillis;
          const [workflow] = yield* decodeWorkflows(
            yield* sql`
              update Workflow
              set archivedAt = ${archived ? sql`coalesce(archivedAt, ${now})` : sql`null`},
                  updatedAt = ${now}
              where id = ${workflowId}
              returning ${workflowColumns}
            `,
          );
          return workflow ?? (yield* new WorkflowNotFoundError({ workflowId }));
        }),

        addStep: Effect.fn("WorkflowRepository.addStep")(function* ({
          workflowId,
          name,
          teamId,
        }: {
          readonly workflowId: string;
          readonly name: Domain.StepName;
          readonly teamId: Domain.TeamId;
        }) {
          if (Option.isNone(yield* findWorkflow(workflowId)))
            return yield* new WorkflowNotFoundError({ workflowId });
          if ((yield* countSteps(workflowId)) >= Domain.WorkflowLimits.maxSteps)
            return yield* new WorkflowLimitError({
              limit: Domain.WorkflowLimits.maxSteps,
            });
          const now = yield* Clock.currentTimeMillis;
          const [step] = yield* decodeSteps(
            yield* sql`
              insert into WorkflowStep
                (id, workflowId, position, name, teamId, createdAt)
              values (
                ${crypto.randomUUID()}, ${workflowId},
                (select coalesce(max(position), 0) + 1 from WorkflowStep where workflowId = ${workflowId}),
                ${name}, ${teamId}, ${now}
              )
              returning *
            `,
          );
          return (
            step ??
            (yield* new WorkflowRepositoryError({
              message: "WorkflowStep insert returned no row",
              cause: workflowId,
            }))
          );
        }),

        getStep: Effect.fn("WorkflowRepository.getStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          return yield* findStep(stepId);
        }),

        updateStep: Effect.fn("WorkflowRepository.updateStep")(function* ({
          stepId,
          name,
          teamId,
        }: {
          readonly stepId: string;
          readonly name: Domain.StepName;
          readonly teamId: Domain.TeamId;
        }) {
          const [step] = yield* decodeSteps(
            yield* sql`
              update WorkflowStep set name = ${name}, teamId = ${teamId}
              where id = ${stepId}
              returning *
            `,
          );
          return step ?? (yield* new StepNotFoundError({ stepId }));
        }),

        /**
         * A swap under `unique (workflowId, position)` cannot be two updates:
         * the first would collide with the neighbour. The target parks at
         * `-1`, the neighbour takes its slot, then the target takes the
         * neighbour's — inside one storage transaction so a fault between
         * statements cannot leave a step parked at `-1`. `@effect/sql-sqlite-do`
         * backs `withTransaction` with `storage.transaction` when given
         * `ctx.storage`, which `makeRunEffect` does; no nesting, keep it short.
         */
        moveStep: Effect.fn("WorkflowRepository.moveStep")(function* ({
          stepId,
          direction,
        }: {
          readonly stepId: string;
          readonly direction: Domain.StepDirection;
        }) {
          const step = yield* requireStep(stepId);
          const target = step.position + (direction === "up" ? -1 : 1);
          const [neighbour] = yield* decodeSteps(
            yield* sql`
              select * from WorkflowStep
              where workflowId = ${step.workflowId} and position = ${target}
            `,
          );
          if (neighbour === undefined) return;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`update WorkflowStep set position = -1 where id = ${step.id}`;
              yield* sql`update WorkflowStep set position = ${step.position} where id = ${neighbour.id}`;
              yield* sql`update WorkflowStep set position = ${target} where id = ${step.id}`;
            }),
          );
        }),

        /** Deletes, then closes the gap so positions stay dense from 1. */
        removeStep: Effect.fn("WorkflowRepository.removeStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          const step = yield* requireStep(stepId);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`delete from WorkflowStep where id = ${step.id}`;
              yield* sql`
                update WorkflowStep set position = position - 1
                where workflowId = ${step.workflowId} and position > ${step.position}
              `;
            }),
          );
        }),

        countStepsOwnedBy: Effect.fn("WorkflowRepository.countStepsOwnedBy")(
          function* ({ teamId }: { readonly teamId: string }) {
            return yield* count(
              sql`select count(*) from WorkflowStep where teamId = ${teamId}`,
            );
          },
        ),

        listStepsOwnedBy: Effect.fn("WorkflowRepository.listStepsOwnedBy")(
          function* ({ teamId }: { readonly teamId: string }) {
            return yield* decode(
              Schema.Array(Domain.OwnedStep),
              "Invalid OwnedStep row",
            )(
              yield* sql`
                select w.id as workflowId, w.name as workflowName,
                  (w.archivedAt is not null) as workflowArchived,
                  s.name as stepName
                from WorkflowStep s join Workflow w on w.id = s.workflowId
                where s.teamId = ${teamId}
                order by w.archivedAt is not null, w.name collate nocase, s.position
              `,
            );
          },
        ),
      });
    }),
  );
}

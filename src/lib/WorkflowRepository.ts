import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import {
  SqlClient,
  type SqlConnection,
  type Statement,
} from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

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

/** `addParallelStep` named a stage no step of the workflow is in. */
export class StageNotFoundError extends Schema.TaggedError<StageNotFoundError>()(
  "StageNotFoundError",
  { workflowId: Schema.String, stage: Schema.Number },
) {}

export class WorkflowLimitError extends Schema.TaggedError<WorkflowLimitError>()(
  "WorkflowLimitError",
  { limit: Schema.Number },
) {}

/**
 * Another non-archived workflow already has `scope = 'order'`. A repository
 * check rather than a SQL constraint so the UI gets a named error; archiving
 * the holder frees the slot, and un-archiving into an occupied slot is refused
 * with the same error.
 */
export class OrderWorkflowExistsError extends Schema.TaggedError<OrderWorkflowExistsError>()(
  "OrderWorkflowExistsError",
  { workflowId: Schema.String },
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
    ) => Effect.Effect<void, SqlError.SqlError | WorkflowRepositoryError>;
    /**
     * `scope` defaults to `item`. An order workflow must have no tags (a
     * `WorkflowRepositoryError`: the UI never sends any, so it is a programming
     * error) and is refused while another active one exists.
     */
    readonly createWorkflow: (input: {
      readonly name: Domain.WorkflowName;
      readonly scope?: Domain.WorkflowScope;
      readonly tags: Domain.ProductTags;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNameTakenError
      | WorkflowLimitError
      | OrderWorkflowExistsError
    >;
    /** `scope` is not editable; non-empty tags on an order workflow are refused. */
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
     * Idempotent. Nothing points at a definition — a future running instance
     * copies its steps — so archiving only stops new line items from routing
     * here. Guard live pointers (step → team), never copies. Restoring an
     * order workflow is refused while another active one holds the slot.
     */
    readonly setWorkflowArchived: (input: {
      readonly workflowId: string;
      readonly archived: boolean;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | OrderWorkflowExistsError
    >;
    /** New step in a new last stage. */
    readonly addStep: (input: {
      readonly workflowId: string;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
      readonly instructions?: Domain.StepInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowStep,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowLimitError
    >;
    /** New step into an existing `stage`, after that stage's last step. */
    readonly addParallelStep: (input: {
      readonly workflowId: string;
      readonly stage: number;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
      readonly instructions?: Domain.StepInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowStep,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowLimitError
      | StageNotFoundError
    >;
    readonly getStep: (input: {
      readonly stepId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowStep>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /** `instructions: null` clears. */
    readonly updateStep: (input: {
      readonly stepId: string;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
      readonly instructions: Domain.StepInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowStep,
      SqlError.SqlError | WorkflowRepositoryError | StepNotFoundError
    >;
    /** A move past either edge is a no-op, not an error. Across a stage boundary the step joins the neighbour's stage. */
    readonly moveStep: (input: {
      readonly stepId: string;
      readonly direction: Domain.StepDirection;
    }) => Effect.Effect<
      void,
      SqlError.SqlError | WorkflowRepositoryError | StepNotFoundError
    >;
    /** The step leaves its stage into a new one of its own right after it; no-op when already alone. */
    readonly separateStep: (input: {
      readonly stepId: string;
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
        "id, name, scope, tags, createdAt, updatedAt, archivedAt",
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

      /** The active order workflow other than `exceptId`, if any. */
      const activeOrderWorkflowId = (exceptId: string | null) =>
        sql`
          select id from Workflow
          where scope = 'order' and archivedAt is null
            and id is not ${exceptId}
          limit 1
        `.pipe(
          Effect.map((rows) =>
            Option.fromUndefinedOr(rows[0]?.id).pipe(Option.map(String)),
          ),
        );

      const requireOrderWorkflowSlot = (exceptId: string | null) =>
        activeOrderWorkflowId(exceptId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (workflowId) =>
                Effect.fail(new OrderWorkflowExistsError({ workflowId })),
            }),
          ),
        );

      const requireNoTagsForOrderScope = (
        scope: Domain.WorkflowScope,
        tags: Domain.ProductTags,
      ) =>
        scope === "order" && tags.length > 0
          ? Effect.fail(
              new WorkflowRepositoryError({
                message: "An order workflow cannot have product tags",
                cause: tags,
              }),
            )
          : Effect.void;

      const countSteps = (workflowId: string) =>
        count(
          sql`select count(*) from WorkflowStep where workflowId = ${workflowId}`,
        );

      const layoutOf = (workflowId: string) =>
        sql`
          select id, position, stage from WorkflowStep
          where workflowId = ${workflowId}
          order by position
        `.pipe(
          Effect.flatMap(
            decode(
              Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  position: Schema.Number,
                  stage: Schema.Number,
                }),
              ),
              "Invalid WorkflowStep layout row",
            ),
          ),
        );

      /**
       * Persists a whole layout. `unique (workflowId, position)` forbids
       * in-place renumbering (a +1 shift collides row by row), so every step
       * first parks at `-position`, then takes its final position and stage.
       * Plain statements, no transaction of its own: callers wrap it, and
       * `removeStep` composes a delete in front of it, because
       * `@effect/sql-sqlite-do` backs `withTransaction` with
       * `storage.transaction` and Durable Object SQLite refuses to nest.
       */
      const writeLayout = (workflowId: string, layout: WorkflowLayout.Layout) =>
        Effect.gen(function* () {
          yield* sql`update WorkflowStep set position = -position where workflowId = ${workflowId}`;
          yield* Effect.forEach(
            layout,
            (p) =>
              sql`update WorkflowStep set position = ${p.position}, stage = ${p.stage} where id = ${p.id}`,
            { discard: true },
          );
        });

      const relayout = (
        workflowId: string,
        edit: (layout: WorkflowLayout.Layout) => WorkflowLayout.Layout,
      ) =>
        sql.withTransaction(
          layoutOf(workflowId).pipe(
            Effect.flatMap((layout) => writeLayout(workflowId, edit(layout))),
          ),
        );

      /** Shared by `addStep` and `addParallelStep`: existence, the step ceiling, and the insert itself. */
      const insertStep = ({
        workflowId,
        position,
        stage,
        name,
        teamId,
        instructions,
      }: {
        readonly workflowId: string;
        readonly position: Statement.Fragment;
        readonly stage: Statement.Fragment;
        readonly name: Domain.StepName;
        readonly teamId: Domain.TeamId;
        readonly instructions: Domain.StepInstructions | null;
      }) =>
        Effect.gen(function* () {
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
                (id, workflowId, position, stage, name, teamId, instructions, createdAt)
              values (
                ${crypto.randomUUID()}, ${workflowId}, ${position}, ${stage},
                ${name}, ${teamId}, ${instructions}, ${now}
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
        });

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
                select w.id, w.name, w.scope, w.tags, w.createdAt, w.updatedAt, w.archivedAt,
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
            // A step with no `stage` follows the previous one (linear); the
            // layout is checked before anything is written so a bad fixture
            // fails whole rather than half-seeding.
            const staged = workflows.map((workflow) => ({
              ...workflow,
              steps: workflow.steps.reduce<
                readonly (Domain.SeedWorkflowsInput["workflows"][number]["steps"][number] & {
                  readonly position: number;
                  readonly stage: number;
                })[]
              >((acc, step, index) => {
                const previous = acc[index - 1]?.stage ?? 0;
                return [
                  ...acc,
                  {
                    ...step,
                    position: index + 1,
                    stage: step.stage ?? previous + 1,
                  },
                ];
              }, []),
            }));
            const invalid = staged.find(
              (workflow) =>
                !WorkflowLayout.isValid(
                  workflow.steps.map((step, index) => ({
                    id: String(index),
                    position: step.position,
                    stage: step.stage,
                  })),
                ),
            );
            if (invalid !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${invalid.name}: stages must be dense from 1 and non-decreasing`,
                cause: invalid.steps.map((step) => step.stage),
              });
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`delete from WorkflowRun`;
                yield* sql`delete from Workflow`;
                for (const workflow of staged) {
                  const workflowId = crypto.randomUUID();
                  yield* sql`
                    insert into Workflow
                      (id, name, scope, tags, createdAt, updatedAt, archivedAt)
                    values
                      (${workflowId}, ${workflow.name}, ${workflow.scope ?? "item"}, ${json(workflow.tags)}, ${now}, ${now}, null)
                  `;
                  for (const step of workflow.steps)
                    yield* sql`
                      insert into WorkflowStep
                        (id, workflowId, position, stage, name, teamId, instructions, createdAt)
                      values
                        (${crypto.randomUUID()}, ${workflowId}, ${step.position}, ${step.stage}, ${step.name}, ${step.teamId}, ${step.instructions ?? null}, ${now})
                    `;
                }
              }),
            );
          },
        ),

        createWorkflow: Effect.fn("WorkflowRepository.createWorkflow")(
          function* ({
            name,
            scope = "item",
            tags,
          }: {
            readonly name: Domain.WorkflowName;
            readonly scope?: Domain.WorkflowScope;
            readonly tags: Domain.ProductTags;
          }) {
            yield* requireNoTagsForOrderScope(scope, tags);
            if (scope === "order") yield* requireOrderWorkflowSlot(null);
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
                  (id, name, scope, tags, createdAt, updatedAt, archivedAt)
                values
                  (${crypto.randomUUID()}, ${name}, ${scope}, ${json(tags)}, ${now}, ${now}, null)
                returning ${workflowColumns}
              `,
            );
            return workflow ?? (yield* new WorkflowNameTakenError({ name }));
          },
        ),

        /**
         * `update or ignore` turns a name collision into zero returned rows.
         * Existence is checked first (the scope rule needs the row anyway), so
         * no rows afterwards means exactly "name taken".
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
            const existing = yield* findWorkflow(workflowId);
            if (Option.isNone(existing))
              return yield* new WorkflowNotFoundError({ workflowId });
            yield* requireNoTagsForOrderScope(existing.value.scope, tags);
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                update or ignore Workflow
                set name = ${name}, tags = ${json(tags)}, updatedAt = ${now}
                where id = ${workflowId}
                returning ${workflowColumns}
              `,
            );
            return workflow ?? (yield* new WorkflowNameTakenError({ name }));
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
          if (!archived) {
            const existing = yield* findWorkflow(workflowId);
            if (Option.isNone(existing))
              return yield* new WorkflowNotFoundError({ workflowId });
            if (existing.value.scope === "order")
              yield* requireOrderWorkflowSlot(workflowId);
          }
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
          instructions,
        }: {
          readonly workflowId: string;
          readonly name: Domain.StepName;
          readonly teamId: Domain.TeamId;
          readonly instructions?: Domain.StepInstructions | null;
        }) {
          return yield* insertStep({
            workflowId,
            position: sql`(select coalesce(max(position), 0) + 1 from WorkflowStep where workflowId = ${workflowId})`,
            stage: sql`(select coalesce(max(stage), 0) + 1 from WorkflowStep where workflowId = ${workflowId})`,
            name,
            teamId,
            instructions: instructions ?? null,
          });
        }),

        /**
         * Inserted at a temporary last position in the target stage, then the
         * whole layout is rewritten so the new step lands right after that
         * stage's last member. Both in one transaction, and the step is re-read
         * afterwards so the caller sees its final position.
         */
        addParallelStep: Effect.fn("WorkflowRepository.addParallelStep")(
          function* ({
            workflowId,
            stage,
            name,
            teamId,
            instructions,
          }: {
            readonly workflowId: string;
            readonly stage: number;
            readonly name: Domain.StepName;
            readonly teamId: Domain.TeamId;
            readonly instructions?: Domain.StepInstructions | null;
          }) {
            if (Option.isNone(yield* findWorkflow(workflowId)))
              return yield* new WorkflowNotFoundError({ workflowId });
            const before = yield* layoutOf(workflowId);
            if (!before.some((p) => p.stage === stage))
              return yield* new StageNotFoundError({ workflowId, stage });
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const inserted = yield* insertStep({
                  workflowId,
                  position: sql`${before.length + 1}`,
                  stage: sql`${stage}`,
                  name,
                  teamId,
                  instructions: instructions ?? null,
                });
                yield* writeLayout(
                  workflowId,
                  WorkflowLayout.appendParallel(before, stage, inserted.id),
                );
                const placed = yield* findStep(inserted.id);
                return Option.isSome(placed)
                  ? placed.value
                  : yield* new WorkflowRepositoryError({
                      message: "WorkflowStep vanished during relayout",
                      cause: inserted.id,
                    });
              }),
            );
          },
        ),

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
          instructions,
        }: {
          readonly stepId: string;
          readonly name: Domain.StepName;
          readonly teamId: Domain.TeamId;
          readonly instructions: Domain.StepInstructions | null;
        }) {
          const [step] = yield* decodeSteps(
            yield* sql`
              update WorkflowStep
              set name = ${name}, teamId = ${teamId}, instructions = ${instructions}
              where id = ${stepId}
              returning *
            `,
          );
          return step ?? (yield* new StepNotFoundError({ stepId }));
        }),

        moveStep: Effect.fn("WorkflowRepository.moveStep")(function* ({
          stepId,
          direction,
        }: {
          readonly stepId: string;
          readonly direction: Domain.StepDirection;
        }) {
          const step = yield* requireStep(stepId);
          yield* relayout(step.workflowId, (layout) =>
            WorkflowLayout.move(layout, stepId, direction),
          );
        }),

        separateStep: Effect.fn("WorkflowRepository.separateStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          const step = yield* requireStep(stepId);
          yield* relayout(step.workflowId, (layout) =>
            WorkflowLayout.separate(layout, stepId),
          );
        }),

        /** Deletes, then rewrites the layout so positions and stages stay dense from 1 — one transaction. */
        removeStep: Effect.fn("WorkflowRepository.removeStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          const step = yield* requireStep(stepId);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const layout = yield* layoutOf(step.workflowId);
              yield* sql`delete from WorkflowStep where id = ${step.id}`;
              yield* writeLayout(
                step.workflowId,
                WorkflowLayout.remove(layout, stepId),
              );
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

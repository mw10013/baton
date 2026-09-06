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

/** A draft step id the editor sent that no `WorkflowDraftStep` row carries — including a workflow step's id, which is never writable. */
export class StepNotFoundError extends Schema.TaggedError<StepNotFoundError>()(
  "StepNotFoundError",
  { stepId: Schema.String },
) {}

/** `addParallelStep` named a stage no step of the draft is in. */
export class StageNotFoundError extends Schema.TaggedError<StageNotFoundError>()(
  "StageNotFoundError",
  { workflowId: Schema.String, stage: Schema.Number },
) {}

export class WorkflowLimitError extends Schema.TaggedError<WorkflowLimitError>()(
  "WorkflowLimitError",
  { limit: Schema.Number },
) {}

/**
 * Another order workflow holds the slot. Two slots exist: at most one
 * non-archived order workflow (create, restore — an off one still occupies
 * the name and the slot) and at most one *active* order workflow
 * (`setWorkflowActive`). A repository check rather than a SQL constraint so
 * the UI gets a named error.
 */
export class OrderWorkflowExistsError extends Schema.TaggedError<OrderWorkflowExistsError>()(
  "OrderWorkflowExistsError",
  { workflowId: Schema.String },
) {}

/** A step or tag write, Apply, or Discard without a draft: Edit has not been clicked. */
export class NoDraftError extends Schema.TaggedError<NoDraftError>()(
  "NoDraftError",
  { workflowId: Schema.String },
) {}

export class NoStepsError extends Schema.TaggedError<NoStepsError>()(
  "NoStepsError",
  { workflowId: Schema.String },
) {}

/** Turn-on refused: an archived workflow is restored first. */
export class WorkflowArchivedError extends Schema.TaggedError<WorkflowArchivedError>()(
  "WorkflowArchivedError",
  { workflowId: Schema.String },
) {}

/** Archive refused while `active = 1`: the merchant turns the workflow off first, as Flow only deletes inactive workflows. */
export class WorkflowActiveError extends Schema.TaggedError<WorkflowActiveError>()(
  "WorkflowActiveError",
  { workflowId: Schema.String },
) {}

/** Apply or turn-on refused because these steps point at teams that are not active. */
export class TeamNotActiveError extends Schema.TaggedError<TeamNotActiveError>()(
  "TeamNotActiveError",
  { workflowId: Schema.String, stepNames: Schema.Array(Domain.StepName) },
) {}

const json = (value: unknown) => JSON.stringify(value);

/** Seed fixtures carry positions and stages but no ids; the index stands in. */
const validLayout = (
  steps: readonly { readonly position: number; readonly stage: number }[],
) =>
  WorkflowLayout.isValid(
    steps.map((step, index) => ({
      id: String(index),
      position: step.position,
      stage: step.stage,
    })),
  );

const count = (query: Statement.Statement<SqlConnection.Row>) =>
  query.values.pipe(Effect.map((rows) => Number(rows[0]?.[0] ?? 0)));

type ActiveTeams = readonly { readonly id: Domain.TeamId }[];

/** The names of `steps` whose team is not in `activeTeams`, in position order. */
const orphanedStepNames = (
  steps: readonly Domain.WorkflowStep[],
  activeTeams: ActiveTeams,
) =>
  steps
    .filter((step) => !activeTeams.some((team) => team.id === step.teamId))
    .map((step) => step.name);

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  {
    readonly listWorkflows: (input: {
      readonly includeArchived: boolean;
    }) => Effect.Effect<
      readonly Domain.WorkflowSummary[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /** The workflow with its steps, and the draft with its steps when one exists. */
    readonly getWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowWithDraft>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Every switched-on, non-archived workflow with its steps, in two
     * statements rather than one per workflow: this is what an order upsert
     * loads before starting runs for its line items, and a bulk stream loads
     * it once for thousands of orders. Drafts are invisible here by
     * construction — nothing in run creation reads `WorkflowDraft*`.
     */
    readonly listActiveWorkflowDetails: () => Effect.Effect<
      readonly Domain.WorkflowDetail[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Development seed only (`ShopAgent.seedWorkflows`): replaces every
     * definition, every draft, and every run with `workflows`, in one
     * transaction. Destructive on purpose — a reseed exists to discard
     * whatever the last one left behind, and skipping existing names would
     * preserve it.
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
     * Inserts the workflow (off, no steps, no tags) and one empty draft
     * carrying `tags`, in a transaction: the tags the merchant typed on the
     * create form select line items, so like every tag they reach the
     * workflow only through Apply. `scope` defaults to `item`. An order
     * workflow must have no tags (a `WorkflowRepositoryError`: the UI never
     * sends any, so it is a programming error) and is refused while another
     * non-archived one exists.
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
    /** Rename only; immediate, since runs snapshot the name. `scope` is not editable. */
    readonly updateWorkflow: (input: {
      readonly workflowId: string;
      readonly name: Domain.WorkflowName;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNameTakenError
      | WorkflowNotFoundError
    >;
    /** Writes `tags` on the draft; `NoDraftError` without one. Non-empty tags on an order workflow are refused. */
    readonly updateWorkflowTags: (input: {
      readonly workflowId: string;
      readonly tags: Domain.ProductTags;
    }) => Effect.Effect<
      Domain.WorkflowDraft,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
    >;
    /**
     * Idempotent. Archiving requires the workflow to be off. Nothing points
     * at a definition — a run copies its steps — so archiving only hides the
     * workflow and reserves its name. Restoring an order workflow is refused
     * while another non-archived one holds the slot; restore leaves the
     * workflow off, and the merchant turns it on deliberately.
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
      | WorkflowActiveError
    >;
    /**
     * The on/off switch. On requires: not archived, at least one step, every
     * step's team in `activeTeams`, and (order scope) no other active order
     * workflow. Off touches nothing else: open runs are days of physical work
     * and keep going; only new runs stop. Neither direction creates, applies,
     * or discards a draft, or looks at whether one exists.
     */
    readonly setWorkflowActive: (input: {
      readonly workflowId: string;
      readonly active: boolean;
      readonly activeTeams: ActiveTeams;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowArchivedError
      | NoStepsError
      | TeamNotActiveError
      | OrderWorkflowExistsError
    >;
    /**
     * Edit. Returns the existing draft when there is one (the merchant is
     * resuming); otherwise inserts a draft with the workflow's tags and a
     * copy of every workflow step under a new id, in one transaction.
     */
    readonly createDraft: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Domain.WorkflowDraft,
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
    >;
    /**
     * Replaces the workflow's tags and steps with the draft's and deletes the
     * draft, in one transaction: an order sees the old definition or the new
     * one, never a half-edit. Refused with no draft, an empty draft, or a
     * step on an inactive team, on and off alike. Does not touch `active`.
     * Draft step ids carry over to the workflow.
     */
    readonly applyDraft: (input: {
      readonly workflowId: string;
      readonly activeTeams: ActiveTeams;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
      | NoStepsError
      | TeamNotActiveError
    >;
    /** Deletes the draft (steps cascade). Always allowed; a never-applied workflow is left with zero steps. */
    readonly discardDraft: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
    >;
    /** New step in a new last stage of the draft; `NoDraftError` without one. */
    readonly addStep: (input: {
      readonly workflowId: string;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
      readonly instructions?: Domain.StepInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowDraftStep,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
      | WorkflowLimitError
    >;
    /** New step into an existing `stage` of the draft, after that stage's last step. */
    readonly addParallelStep: (input: {
      readonly workflowId: string;
      readonly stage: number;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
      readonly instructions?: Domain.StepInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowDraftStep,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
      | WorkflowLimitError
      | StageNotFoundError
    >;
    /** A draft step and its workflow, so a caller can refuse writes on an archived workflow. Workflow steps are not found here: they are never written. */
    readonly getStep: (input: { readonly stepId: string }) => Effect.Effect<
      Option.Option<{
        readonly step: Domain.WorkflowDraftStep;
        readonly workflow: Domain.Workflow;
      }>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /** The step-id writes below take draft step ids only. `instructions: null` clears. */
    readonly updateStep: (input: {
      readonly stepId: string;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
      readonly instructions: Domain.StepInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowDraftStep,
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
     * Counts workflow steps and draft steps, of archived workflows too: an
     * archived workflow can be restored, and its steps would then point at a
     * team that no longer exists as a place work can go.
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
      const decodeDrafts = decode(
        Schema.Array(Domain.WorkflowDraft),
        "Invalid WorkflowDraft row",
      );
      const decodeSteps = decode(
        Schema.Array(Domain.WorkflowStep),
        "Invalid WorkflowStep row",
      );

      const findWorkflow = (workflowId: string) =>
        sql`select * from Workflow where id = ${workflowId}`.pipe(
          Effect.flatMap(decodeWorkflows),
          Effect.map(([workflow]) => Option.fromUndefinedOr(workflow)),
        );

      const requireWorkflow = (workflowId: string) =>
        findWorkflow(workflowId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new WorkflowNotFoundError({ workflowId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const findDraft = (workflowId: string) =>
        sql`select * from WorkflowDraft where workflowId = ${workflowId}`.pipe(
          Effect.flatMap(decodeDrafts),
          Effect.map(([draft]) => Option.fromUndefinedOr(draft)),
        );

      const requireDraft = (workflowId: string) =>
        findDraft(workflowId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NoDraftError({ workflowId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const findDraftStep = (stepId: string) =>
        sql`select * from WorkflowDraftStep where id = ${stepId}`.pipe(
          Effect.flatMap(decodeSteps),
          Effect.map(([step]) => Option.fromUndefinedOr(step)),
        );

      const requireDraftStep = (stepId: string) =>
        findDraftStep(stepId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new StepNotFoundError({ stepId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const workflowSteps = (workflowId: string) =>
        sql`
          select * from WorkflowStep
          where workflowId = ${workflowId}
          order by position
        `.pipe(Effect.flatMap(decodeSteps));

      const draftSteps = (workflowId: string) =>
        sql`
          select * from WorkflowDraftStep
          where workflowId = ${workflowId}
          order by position
        `.pipe(Effect.flatMap(decodeSteps));

      const countDraftSteps = (workflowId: string) =>
        count(
          sql`select count(*) from WorkflowDraftStep where workflowId = ${workflowId}`,
        );

      /** The non-archived order workflow other than `exceptId`, if any; `activeOnly` narrows to the switched-on one. */
      const otherOrderWorkflowId = (
        exceptId: string | null,
        activeOnly: boolean,
      ) =>
        sql`
          select id from Workflow
          where scope = 'order' and archivedAt is null
            and id is not ${exceptId}
            ${activeOnly ? sql`and active = 1` : sql``}
          limit 1
        `.pipe(
          Effect.map((rows) =>
            Option.fromUndefinedOr(rows[0]?.id).pipe(Option.map(String)),
          ),
        );

      const requireOrderWorkflowSlot = (
        exceptId: string | null,
        activeOnly: boolean,
      ) =>
        otherOrderWorkflowId(exceptId, activeOnly).pipe(
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

      const insertDraft = ({
        workflowId,
        tags,
        now,
      }: {
        readonly workflowId: string;
        readonly tags: Domain.ProductTags;
        readonly now: number;
      }) =>
        Effect.gen(function* () {
          const [draft] = yield* decodeDrafts(
            yield* sql`
              insert into WorkflowDraft (workflowId, tags, createdAt, updatedAt)
              values (${workflowId}, ${json(tags)}, ${now}, ${now})
              returning *
            `,
          );
          return (
            draft ??
            (yield* new WorkflowRepositoryError({
              message: "WorkflowDraft insert returned no row",
              cause: workflowId,
            }))
          );
        });

      const insertDraftStepRow = ({
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
          const [step] = yield* decodeSteps(
            yield* sql`
              insert into WorkflowDraftStep
                (id, workflowId, position, stage, name, teamId, instructions)
              values (
                ${crypto.randomUUID()}, ${workflowId}, ${position}, ${stage},
                ${name}, ${teamId}, ${instructions}
              )
              returning *
            `,
          );
          return (
            step ??
            (yield* new WorkflowRepositoryError({
              message: "WorkflowDraftStep insert returned no row",
              cause: workflowId,
            }))
          );
        });

      const touchWorkflow = (workflowId: string, now: number) =>
        sql`update Workflow set updatedAt = ${now} where id = ${workflowId}`;

      const touchDraft = (workflowId: string, now: number) =>
        sql`update WorkflowDraft set updatedAt = ${now} where workflowId = ${workflowId}`;

      const layoutOf = (workflowId: string) =>
        sql`
          select id, position, stage from WorkflowDraftStep
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
              "Invalid WorkflowDraftStep layout row",
            ),
          ),
        );

      /**
       * Persists a whole draft layout. `unique (workflowId, position)`
       * forbids in-place renumbering (a +1 shift collides row by row), so
       * every step first parks at `-position`, then takes its final position
       * and stage. Plain statements, no transaction of its own: callers wrap
       * it, and `removeStep` composes a delete in front of it, because
       * `@effect/sql-sqlite-do` backs `withTransaction` with
       * `storage.transaction` and Durable Object SQLite refuses to nest.
       */
      const writeLayout = (workflowId: string, layout: WorkflowLayout.Layout) =>
        Effect.gen(function* () {
          yield* sql`update WorkflowDraftStep set position = -position where workflowId = ${workflowId}`;
          yield* Effect.forEach(
            layout,
            (p) =>
              sql`update WorkflowDraftStep set position = ${p.position}, stage = ${p.stage} where id = ${p.id}`,
            { discard: true },
          );
        });

      /** Finds the draft step, then rewrites its draft's layout with `edit` applied, in one transaction. */
      const relayout = (
        stepId: string,
        edit: (layout: WorkflowLayout.Layout) => WorkflowLayout.Layout,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const step = yield* requireDraftStep(stepId);
            const layout = yield* layoutOf(step.workflowId);
            yield* writeLayout(step.workflowId, edit(layout));
            yield* touchDraft(step.workflowId, yield* Clock.currentTimeMillis);
          }),
        );

      /** Shared by `addStep` and `addParallelStep`: the draft must exist, the step ceiling, and the insert itself. */
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
          yield* requireWorkflow(workflowId);
          yield* requireDraft(workflowId);
          if (
            (yield* countDraftSteps(workflowId)) >=
            Domain.WorkflowLimits.maxSteps
          )
            return yield* new WorkflowLimitError({
              limit: Domain.WorkflowLimits.maxSteps,
            });
          const step = yield* insertDraftStepRow({
            workflowId,
            position,
            stage,
            name,
            teamId,
            instructions,
          });
          yield* touchDraft(workflowId, yield* Clock.currentTimeMillis);
          return step;
        });

      /** Apply and turn-on share the content checks: at least one step, every team active. */
      const requireStartableSteps = (
        workflowId: string,
        steps: readonly Domain.WorkflowStep[],
        activeTeams: ActiveTeams,
      ) =>
        Effect.gen(function* () {
          if (steps.length === 0)
            return yield* new NoStepsError({ workflowId });
          const stepNames = orphanedStepNames(steps, activeTeams);
          if (stepNames.length > 0)
            return yield* new TeamNotActiveError({ workflowId, stepNames });
          return steps;
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
                select w.*,
                  exists (select 1 from WorkflowDraft d where d.workflowId = w.id) as hasDraft,
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
          const draft = yield* findDraft(workflowId);
          return Option.some({
            workflow: workflow.value,
            steps: yield* workflowSteps(workflowId),
            draft: Option.isNone(draft)
              ? null
              : { draft: draft.value, steps: yield* draftSteps(workflowId) },
          } satisfies Domain.WorkflowWithDraft);
        }),

        listActiveWorkflowDetails: Effect.fn(
          "WorkflowRepository.listActiveWorkflowDetails",
        )(function* () {
          const workflows = yield* decodeWorkflows(
            yield* sql`
              select * from Workflow
              where archivedAt is null and active = 1
              order by name collate nocase
            `,
          );
          const steps = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowStep s
              join Workflow w on w.id = s.workflowId
              where w.archivedAt is null and w.active = 1
              order by s.workflowId, s.position
            `,
          );
          return workflows.map((workflow): Domain.WorkflowDetail => ({
            workflow,
            steps: steps.filter((step) => step.workflowId === workflow.id),
          }));
        }),

        /**
         * A fixture's `steps` become the workflow's steps, switched on unless
         * `active: false` or archived. A fixture with no steps and no `draft`
         * gets an empty draft — the state the ordinary path leaves a fresh
         * workflow in. `draft` seeds a pending draft beside the workflow.
         */
        replaceWorkflows: Effect.fn("WorkflowRepository.replaceWorkflows")(
          function* ({ workflows }: Domain.SeedWorkflowsInput) {
            const now = yield* Clock.currentTimeMillis;
            type SeedStep =
              Domain.SeedWorkflowsInput["workflows"][number]["steps"][number];
            // A step with no `stage` follows the previous one (linear); the
            // layout is checked before anything is written so a bad fixture
            // fails whole rather than half-seeding.
            const stage = (steps: readonly SeedStep[]) =>
              steps.reduce<
                readonly (SeedStep & {
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
              }, []);
            // A fixture with no steps and no draft gets an empty draft, the
            // state the ordinary path leaves a fresh workflow in.
            const draftOf = (
              workflow: Domain.SeedWorkflowsInput["workflows"][number],
            ) => {
              if (workflow.draft !== undefined)
                return {
                  tags: workflow.draft.tags ?? workflow.tags,
                  steps: stage(workflow.draft.steps),
                };
              return workflow.steps.length === 0
                ? { tags: workflow.tags, steps: [] }
                : null;
            };
            const staged = workflows.map((workflow) => ({
              ...workflow,
              steps: stage(workflow.steps),
              draft: draftOf(workflow),
              active:
                workflow.active ??
                (workflow.steps.length > 0 && workflow.archived !== true),
            }));
            const invalid = staged.find(
              (workflow) =>
                !validLayout(workflow.steps) ||
                (workflow.draft !== null && !validLayout(workflow.draft.steps)),
            );
            if (invalid !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${invalid.name}: stages must be dense from 1 and non-decreasing`,
                cause: invalid.steps.map((step) => step.stage),
              });
            // The invariants the ordinary write path enforces that a fixture
            // could otherwise silently break.
            const taggedOrder = staged.find(
              (workflow) =>
                workflow.scope === "order" &&
                (workflow.tags.length > 0 ||
                  (workflow.draft?.tags.length ?? 0) > 0),
            );
            if (taggedOrder !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${taggedOrder.name}: an order workflow has no tags`,
                cause: taggedOrder.tags,
              });
            const openOrder = staged.filter(
              (workflow) =>
                workflow.scope === "order" && workflow.archived !== true,
            );
            if (openOrder.length > 1)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: ${String(openOrder.length)} non-archived order workflows; at most one`,
                cause: openOrder.map((workflow) => workflow.name),
              });
            const badActive = staged.find(
              (workflow) =>
                workflow.active &&
                (workflow.archived === true || workflow.steps.length === 0),
            );
            if (badActive !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${badActive.name}: an active workflow needs steps and must not be archived`,
                cause: badActive.name,
              });
            const writeSteps = (
              table: Statement.Fragment,
              workflowId: string,
              steps: ReturnType<typeof stage>,
            ) =>
              Effect.forEach(
                steps,
                (step) =>
                  sql`
                    insert into ${table}
                      (id, workflowId, position, stage, name, teamId, instructions)
                    values
                      (${crypto.randomUUID()}, ${workflowId}, ${step.position}, ${step.stage}, ${step.name}, ${step.teamId}, ${step.instructions ?? null})
                  `,
                { discard: true },
              );
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`delete from WorkflowRun`;
                yield* sql`delete from Workflow`;
                for (const workflow of staged) {
                  const workflowId = crypto.randomUUID();
                  yield* sql`
                    insert into Workflow
                      (id, name, scope, active, archivedAt, tags, createdAt, updatedAt)
                    values
                      (${workflowId}, ${workflow.name}, ${workflow.scope ?? "item"}, ${workflow.active ? 1 : 0}, ${workflow.archived === true ? now : null}, ${json(workflow.tags)}, ${now}, ${now})
                  `;
                  yield* writeSteps(
                    sql.literal("WorkflowStep"),
                    workflowId,
                    workflow.steps,
                  );
                  if (workflow.draft !== null) {
                    yield* insertDraft({
                      workflowId,
                      tags: workflow.draft.tags,
                      now,
                    });
                    yield* writeSteps(
                      sql.literal("WorkflowDraftStep"),
                      workflowId,
                      workflow.draft.steps,
                    );
                  }
                }
              }),
            );
          },
        ),

        /**
         * `insert or ignore ... returning` is the whole name check, as
         * `Repository.createTeam` does: a fresh uuid leaves the name index as
         * the only reachable unique constraint, so an empty result means
         * exactly "taken". The draft insert is skipped when the name was
         * taken.
         */
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
            if (scope === "order") yield* requireOrderWorkflowSlot(null, false);
            const open = yield* count(
              sql`select count(*) from Workflow where archivedAt is null`,
            );
            if (open >= Domain.WorkflowLimits.maxWorkflows)
              return yield* new WorkflowLimitError({
                limit: Domain.WorkflowLimits.maxWorkflows,
              });
            const now = yield* Clock.currentTimeMillis;
            const workflowId = crypto.randomUUID();
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    insert or ignore into Workflow
                      (id, name, scope, active, archivedAt, tags, createdAt, updatedAt)
                    values
                      (${workflowId}, ${name}, ${scope}, 0, null, '[]', ${now}, ${now})
                    returning *
                  `,
                );
                if (workflow === undefined)
                  return yield* new WorkflowNameTakenError({ name });
                yield* insertDraft({ workflowId, tags, now });
                return workflow;
              }),
            );
          },
        ),

        /**
         * `update or ignore` turns a name collision into zero returned rows.
         * Existence is checked first, so no rows afterwards means exactly
         * "name taken".
         */
        updateWorkflow: Effect.fn("WorkflowRepository.updateWorkflow")(
          function* ({
            workflowId,
            name,
          }: {
            readonly workflowId: string;
            readonly name: Domain.WorkflowName;
          }) {
            yield* requireWorkflow(workflowId);
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                update or ignore Workflow
                set name = ${name}, updatedAt = ${now}
                where id = ${workflowId}
                returning *
              `,
            );
            return workflow ?? (yield* new WorkflowNameTakenError({ name }));
          },
        ),

        updateWorkflowTags: Effect.fn("WorkflowRepository.updateWorkflowTags")(
          function* ({
            workflowId,
            tags,
          }: {
            readonly workflowId: string;
            readonly tags: Domain.ProductTags;
          }) {
            const existing = yield* requireWorkflow(workflowId);
            yield* requireNoTagsForOrderScope(existing.scope, tags);
            yield* requireDraft(workflowId);
            const now = yield* Clock.currentTimeMillis;
            const [draft] = yield* decodeDrafts(
              yield* sql`
                update WorkflowDraft set tags = ${json(tags)}, updatedAt = ${now}
                where workflowId = ${workflowId}
                returning *
              `,
            );
            return draft ?? (yield* new NoDraftError({ workflowId }));
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
          const existing = yield* requireWorkflow(workflowId);
          if (archived && existing.active)
            return yield* new WorkflowActiveError({ workflowId });
          if (!archived && existing.scope === "order")
            yield* requireOrderWorkflowSlot(workflowId, false);
          const now = yield* Clock.currentTimeMillis;
          const [workflow] = yield* decodeWorkflows(
            yield* sql`
              update Workflow
              set archivedAt = ${archived ? sql`coalesce(archivedAt, ${now})` : sql`null`},
                  updatedAt = ${now}
              where id = ${workflowId}
              returning *
            `,
          );
          return workflow ?? (yield* new WorkflowNotFoundError({ workflowId }));
        }),

        setWorkflowActive: Effect.fn("WorkflowRepository.setWorkflowActive")(
          function* ({
            workflowId,
            active,
            activeTeams,
          }: {
            readonly workflowId: string;
            readonly active: boolean;
            readonly activeTeams: ActiveTeams;
          }) {
            const existing = yield* requireWorkflow(workflowId);
            if (active) {
              if (existing.archivedAt !== null)
                return yield* new WorkflowArchivedError({ workflowId });
              yield* requireStartableSteps(
                workflowId,
                yield* workflowSteps(workflowId),
                activeTeams,
              );
              if (existing.scope === "order")
                yield* requireOrderWorkflowSlot(workflowId, true);
            }
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                update Workflow
                set active = ${active ? 1 : 0}, updatedAt = ${now}
                where id = ${workflowId}
                returning *
              `,
            );
            return (
              workflow ?? (yield* new WorkflowNotFoundError({ workflowId }))
            );
          },
        ),

        createDraft: Effect.fn("WorkflowRepository.createDraft")(function* ({
          workflowId,
        }: {
          readonly workflowId: string;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const workflow = yield* requireWorkflow(workflowId);
              const existing = yield* findDraft(workflowId);
              if (Option.isSome(existing)) return existing.value;
              const now = yield* Clock.currentTimeMillis;
              const draft = yield* insertDraft({
                workflowId,
                tags: workflow.tags,
                now,
              });
              const steps = yield* workflowSteps(workflowId);
              yield* Effect.forEach(
                steps,
                (step) =>
                  insertDraftStepRow({
                    workflowId,
                    position: sql`${step.position}`,
                    stage: sql`${step.stage}`,
                    name: step.name,
                    teamId: step.teamId,
                    instructions: step.instructions,
                  }),
                { discard: true },
              );
              return draft;
            }),
          );
        }),

        applyDraft: Effect.fn("WorkflowRepository.applyDraft")(function* ({
          workflowId,
          activeTeams,
        }: {
          readonly workflowId: string;
          readonly activeTeams: ActiveTeams;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* requireWorkflow(workflowId);
              const draft = yield* requireDraft(workflowId);
              yield* requireNoTagsForOrderScope(existing.scope, draft.tags);
              const steps = yield* draftSteps(workflowId);
              yield* requireStartableSteps(workflowId, steps, activeTeams);
              const now = yield* Clock.currentTimeMillis;
              yield* sql`delete from WorkflowStep where workflowId = ${workflowId}`;
              yield* sql`
                insert into WorkflowStep
                  (id, workflowId, position, stage, name, teamId, instructions)
                select id, workflowId, position, stage, name, teamId, instructions
                from WorkflowDraftStep
                where workflowId = ${workflowId}
              `;
              const [workflow] = yield* decodeWorkflows(
                yield* sql`
                  update Workflow
                  set tags = ${json(draft.tags)}, updatedAt = ${now}
                  where id = ${workflowId}
                  returning *
                `,
              );
              yield* sql`delete from WorkflowDraft where workflowId = ${workflowId}`;
              return (
                workflow ?? (yield* new WorkflowNotFoundError({ workflowId }))
              );
            }),
          );
        }),

        discardDraft: Effect.fn("WorkflowRepository.discardDraft")(function* ({
          workflowId,
        }: {
          readonly workflowId: string;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const workflow = yield* requireWorkflow(workflowId);
              yield* requireDraft(workflowId);
              yield* sql`delete from WorkflowDraft where workflowId = ${workflowId}`;
              yield* touchWorkflow(workflowId, yield* Clock.currentTimeMillis);
              return workflow;
            }),
          );
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
          return yield* sql.withTransaction(
            insertStep({
              workflowId,
              position: sql`(select coalesce(max(position), 0) + 1 from WorkflowDraftStep where workflowId = ${workflowId})`,
              stage: sql`(select coalesce(max(stage), 0) + 1 from WorkflowDraftStep where workflowId = ${workflowId})`,
              name,
              teamId,
              instructions: instructions ?? null,
            }),
          );
        }),

        /**
         * Inserted at a temporary last position in the target stage, then the
         * whole layout is rewritten so the new step lands right after that
         * stage's last member. Insert and relayout share one transaction, and
         * the step is re-read afterwards so the caller sees its final
         * position.
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
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireWorkflow(workflowId);
                yield* requireDraft(workflowId);
                const before = yield* layoutOf(workflowId);
                if (!before.some((p) => p.stage === stage))
                  return yield* new StageNotFoundError({ workflowId, stage });
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
                const placed = yield* findDraftStep(inserted.id);
                return Option.isSome(placed)
                  ? placed.value
                  : yield* new WorkflowRepositoryError({
                      message: "WorkflowDraftStep vanished during relayout",
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
          const step = yield* findDraftStep(stepId);
          if (Option.isNone(step)) return Option.none();
          const workflow = yield* findWorkflow(step.value.workflowId);
          if (Option.isNone(workflow))
            return yield* new WorkflowRepositoryError({
              message: "WorkflowDraftStep.workflowId resolves to no Workflow",
              cause: stepId,
            });
          return Option.some({ step: step.value, workflow: workflow.value });
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
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const [step] = yield* decodeSteps(
                yield* sql`
                  update WorkflowDraftStep
                  set name = ${name}, teamId = ${teamId}, instructions = ${instructions}
                  where id = ${stepId}
                  returning *
                `,
              );
              if (step === undefined)
                return yield* new StepNotFoundError({ stepId });
              yield* touchDraft(
                step.workflowId,
                yield* Clock.currentTimeMillis,
              );
              return step;
            }),
          );
        }),

        moveStep: Effect.fn("WorkflowRepository.moveStep")(function* ({
          stepId,
          direction,
        }: {
          readonly stepId: string;
          readonly direction: Domain.StepDirection;
        }) {
          yield* relayout(stepId, (layout) =>
            WorkflowLayout.move(layout, stepId, direction),
          );
        }),

        separateStep: Effect.fn("WorkflowRepository.separateStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          yield* relayout(stepId, (layout) =>
            WorkflowLayout.separate(layout, stepId),
          );
        }),

        /** Deletes, then rewrites the layout so positions and stages stay dense from 1, in one transaction. */
        removeStep: Effect.fn("WorkflowRepository.removeStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const step = yield* requireDraftStep(stepId);
              const layout = yield* layoutOf(step.workflowId);
              yield* sql`delete from WorkflowDraftStep where id = ${stepId}`;
              yield* writeLayout(
                step.workflowId,
                WorkflowLayout.remove(layout, stepId),
              );
              yield* touchDraft(
                step.workflowId,
                yield* Clock.currentTimeMillis,
              );
            }),
          );
        }),

        countStepsOwnedBy: Effect.fn("WorkflowRepository.countStepsOwnedBy")(
          function* ({ teamId }: { readonly teamId: string }) {
            return yield* count(
              sql`
                select
                  (select count(*) from WorkflowStep where teamId = ${teamId})
                  + (select count(*) from WorkflowDraftStep where teamId = ${teamId})
              `,
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
                select workflowId, workflowName, workflowArchived, side, stepName from (
                  select w.id as workflowId, w.name as workflowName,
                    (w.archivedAt is not null) as workflowArchived,
                    'workflow' as side, 0 as sideOrder, s.name as stepName, s.position
                  from WorkflowStep s
                  join Workflow w on w.id = s.workflowId
                  where s.teamId = ${teamId}
                  union all
                  select w.id, w.name, (w.archivedAt is not null),
                    'draft', 1, s.name, s.position
                  from WorkflowDraftStep s
                  join Workflow w on w.id = s.workflowId
                  where s.teamId = ${teamId}
                )
                order by workflowArchived, workflowName collate nocase, sideOrder, position
              `,
            );
          },
        ),
      });
    }),
  );
}

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

/** Also raised for a step of a retired version: history is never edited. */
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

export class NoDraftError extends Schema.TaggedError<NoDraftError>()(
  "NoDraftError",
  { workflowId: Schema.String },
) {}

export class NoSavedVersionError extends Schema.TaggedError<NoSavedVersionError>()(
  "NoSavedVersionError",
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
    /** Both sides of a workflow: the saved version and the draft, either absent. */
    readonly getWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowVersions>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Every routable-by-definition workflow — not archived, switched on, with
     * a saved version — with that version and its steps, in three statements
     * rather than one per workflow: this is what an order upsert loads before
     * routing its line items, and a bulk stream loads it once for thousands
     * of orders. Drafts are invisible here by construction.
     */
    readonly listActiveWorkflowDetails: () => Effect.Effect<
      readonly Domain.WorkflowDetail[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Development seed only (`ShopAgent.seedWorkflows`): replaces every
     * definition, every version, and every run with `workflows`, in one
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
     * Inserts the workflow (off, no saved version) and one empty draft
     * carrying `tags`, in a transaction. `scope` defaults to `item`. An order
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
    /** Writes `tags` on the draft, forking one first if needed. Non-empty tags on an order workflow are refused. */
    readonly updateWorkflowTags: (input: {
      readonly workflowId: string;
      readonly tags: Domain.ProductTags;
    }) => Effect.Effect<
      Domain.WorkflowVersion,
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
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
     * The on/off switch. On requires: not archived, a saved version with at
     * least one step, every step's team in `activeTeams`, and (order scope)
     * no other active order workflow. Off touches nothing else: open runs are
     * days of physical work and keep going; only new routing stops. Neither
     * direction creates, retires, or applies a version.
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
      | NoSavedVersionError
      | NoStepsError
      | TeamNotActiveError
      | OrderWorkflowExistsError
    >;
    /**
     * Promotes the draft to live in one transaction: retire the current saved
     * version (if any), stamp the draft `appliedAt`, swap the pointers. An
     * order sees the old version or the new one, never a half-edit. Refused
     * with no draft, an empty draft, or a step on an inactive team. Does not
     * touch `active`.
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
    /** Deletes the draft (steps cascade). Refused when there is no saved version to fall back to. */
    readonly discardDraft: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
      | NoSavedVersionError
    >;
    /** New step in a new last stage of the draft, forking one first if needed. */
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
    /** New step into an existing `stage` of the draft, after that stage's last step. */
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
    /** The step and the workflow its version belongs to, so a caller can refuse writes on an archived workflow. */
    readonly getStep: (input: { readonly stepId: string }) => Effect.Effect<
      Option.Option<{
        readonly step: Domain.WorkflowStep;
        readonly workflow: Domain.Workflow;
      }>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The step-id writes below accept a *saved* step's id — the editor showed
     * the live steps when no draft existed — and land on the draft step at
     * the same position, forking the draft first. A step of a retired version
     * is `StepNotFoundError`. `instructions: null` clears.
     */
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
     * Counts steps of live and draft versions, of archived workflows too: an
     * archived workflow can be restored, and its steps would then point at a
     * team that no longer exists as a place work can go. Retired versions
     * are history and never count.
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
      const decodeVersions = decode(
        Schema.Array(Domain.WorkflowVersion),
        "Invalid WorkflowVersion row",
      );
      const decodeSteps = decode(
        Schema.Array(Domain.WorkflowStep),
        "Invalid WorkflowStep row",
      );

      const workflowColumns = sql.literal(
        "id, name, scope, active, savedVersionId, draftVersionId, createdAt, updatedAt, archivedAt",
      );

      const findWorkflow = (workflowId: string) =>
        sql`select ${workflowColumns} from Workflow where id = ${workflowId}`.pipe(
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

      const findVersion = (versionId: string) =>
        sql`select * from WorkflowVersion where id = ${versionId}`.pipe(
          Effect.flatMap(decodeVersions),
          Effect.map(([version]) => Option.fromUndefinedOr(version)),
        );

      /** A pointer that resolves to no row is a broken invariant, not "absent". */
      const requireVersion = (versionId: string) =>
        findVersion(versionId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new WorkflowRepositoryError({
                    message: "WorkflowVersion pointer resolves to no row",
                    cause: versionId,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

      /** A step's version always has its workflow (cascade), so a miss is a broken invariant, not "absent". */
      const workflowOfVersion = (version: Domain.WorkflowVersion) =>
        findWorkflow(version.workflowId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new WorkflowRepositoryError({
                    message: "WorkflowVersion.workflowId resolves to no row",
                    cause: version.id,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

      const findStep = (stepId: string) =>
        sql`select * from WorkflowStep where id = ${stepId}`.pipe(
          Effect.flatMap(decodeSteps),
          Effect.map(([step]) => Option.fromUndefinedOr(step)),
        );

      const stepsOf = (versionId: string) =>
        sql`
          select * from WorkflowStep
          where versionId = ${versionId}
          order by position
        `.pipe(Effect.flatMap(decodeSteps));

      const countSteps = (versionId: string) =>
        count(
          sql`select count(*) from WorkflowStep where versionId = ${versionId}`,
        );

      const versionSteps = (versionId: string | null) =>
        versionId === null
          ? Effect.succeed(null)
          : Effect.gen(function* () {
              return {
                version: yield* requireVersion(versionId),
                steps: yield* stepsOf(versionId),
              } satisfies Domain.WorkflowVersionSteps;
            });

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

      const insertVersion = ({
        workflowId,
        tags,
        now,
        appliedAt,
      }: {
        readonly workflowId: string;
        readonly tags: Domain.ProductTags;
        readonly now: number;
        readonly appliedAt: number | null;
      }) =>
        Effect.gen(function* () {
          const [version] = yield* decodeVersions(
            yield* sql`
              insert into WorkflowVersion
                (id, workflowId, tags, createdAt, appliedAt, retiredAt)
              values
                (${crypto.randomUUID()}, ${workflowId}, ${json(tags)}, ${now}, ${appliedAt}, null)
              returning *
            `,
          );
          return (
            version ??
            (yield* new WorkflowRepositoryError({
              message: "WorkflowVersion insert returned no row",
              cause: workflowId,
            }))
          );
        });

      const insertStepRow = ({
        versionId,
        position,
        stage,
        name,
        teamId,
        instructions,
        now,
      }: {
        readonly versionId: string;
        readonly position: Statement.Fragment;
        readonly stage: Statement.Fragment;
        readonly name: Domain.StepName;
        readonly teamId: Domain.TeamId;
        readonly instructions: Domain.StepInstructions | null;
        readonly now: number;
      }) =>
        Effect.gen(function* () {
          const [step] = yield* decodeSteps(
            yield* sql`
              insert into WorkflowStep
                (id, versionId, position, stage, name, teamId, instructions, createdAt)
              values (
                ${crypto.randomUUID()}, ${versionId}, ${position}, ${stage},
                ${name}, ${teamId}, ${instructions}, ${now}
              )
              returning *
            `,
          );
          return (
            step ??
            (yield* new WorkflowRepositoryError({
              message: "WorkflowStep insert returned no row",
              cause: versionId,
            }))
          );
        });

      /**
       * The fork. Resolves the draft, creating one from the saved version
       * when none exists: a new version row with the saved tags, and every
       * saved step copied under a NEW id at the same position, stage, name,
       * team, and instructions. Opens no transaction of its own — callers
       * that already wrap in `sql.withTransaction` compose it, the rest wrap
       * it — because `@effect/sql-sqlite-do` backs `withTransaction` with
       * `storage.transaction` and Durable Object SQLite refuses to nest.
       * A workflow with neither pointer is a broken invariant.
       */
      const ensureDraft = (workflowId: string) =>
        Effect.gen(function* () {
          const workflow = yield* requireWorkflow(workflowId);
          if (workflow.draftVersionId !== null)
            return {
              workflow,
              draft: yield* requireVersion(workflow.draftVersionId),
            };
          if (workflow.savedVersionId === null)
            return yield* new WorkflowRepositoryError({
              message: "Workflow has neither a draft nor a saved version",
              cause: workflowId,
            });
          const saved = yield* requireVersion(workflow.savedVersionId);
          const now = yield* Clock.currentTimeMillis;
          const draft = yield* insertVersion({
            workflowId,
            tags: saved.tags,
            now,
            appliedAt: null,
          });
          const savedSteps = yield* stepsOf(saved.id);
          yield* Effect.forEach(
            savedSteps,
            (step) =>
              insertStepRow({
                versionId: draft.id,
                position: sql`${step.position}`,
                stage: sql`${step.stage}`,
                name: step.name,
                teamId: step.teamId,
                instructions: step.instructions,
                now,
              }),
            { discard: true },
          );
          const [updated] = yield* decodeWorkflows(
            yield* sql`
              update Workflow
              set draftVersionId = ${draft.id}, updatedAt = ${now}
              where id = ${workflowId}
              returning ${workflowColumns}
            `,
          );
          return {
            workflow:
              updated ?? (yield* new WorkflowNotFoundError({ workflowId })),
            draft,
          };
        });

      /**
       * The saved-step-id mapping: a step of the draft is itself; a step of
       * the saved version forks the draft and maps to the draft step at the
       * same position (`unique (versionId, position)` makes that exact); a
       * step of a retired version is not found. No transaction of its own,
       * for the reason on `ensureDraft`.
       */
      const resolveDraftStep = (stepId: string) =>
        Effect.gen(function* () {
          const found = yield* findStep(stepId);
          if (Option.isNone(found))
            return yield* new StepNotFoundError({ stepId });
          const version = yield* requireVersion(found.value.versionId);
          const workflow = yield* workflowOfVersion(version);
          if (version.id === workflow.draftVersionId)
            return { workflow, draft: version, step: found.value };
          if (version.id !== workflow.savedVersionId)
            return yield* new StepNotFoundError({ stepId });
          const forked = yield* ensureDraft(workflow.id).pipe(
            Effect.catchTag(
              "WorkflowNotFoundError",
              (error) =>
                new WorkflowRepositoryError({
                  message: "Workflow vanished while forking its draft",
                  cause: error,
                }),
            ),
          );
          const [mapped] = yield* decodeSteps(
            yield* sql`
              select * from WorkflowStep
              where versionId = ${forked.draft.id} and position = ${found.value.position}
            `,
          );
          return {
            workflow: forked.workflow,
            draft: forked.draft,
            step: mapped ?? (yield* new StepNotFoundError({ stepId })),
          };
        });

      const layoutOf = (versionId: string) =>
        sql`
          select id, position, stage from WorkflowStep
          where versionId = ${versionId}
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
       * Persists a whole layout. `unique (versionId, position)` forbids
       * in-place renumbering (a +1 shift collides row by row), so every step
       * first parks at `-position`, then takes its final position and stage.
       * Plain statements, no transaction of its own: callers wrap it, and
       * `removeStep` composes a delete in front of it, because
       * `@effect/sql-sqlite-do` backs `withTransaction` with
       * `storage.transaction` and Durable Object SQLite refuses to nest.
       */
      const writeLayout = (versionId: string, layout: WorkflowLayout.Layout) =>
        Effect.gen(function* () {
          yield* sql`update WorkflowStep set position = -position where versionId = ${versionId}`;
          yield* Effect.forEach(
            layout,
            (p) =>
              sql`update WorkflowStep set position = ${p.position}, stage = ${p.stage} where id = ${p.id}`,
            { discard: true },
          );
        });

      /** Resolves the draft step, then rewrites the draft's layout with `edit` applied — all in one transaction, so the fork and the edit land together. */
      const relayout = (
        stepId: string,
        edit: (
          layout: WorkflowLayout.Layout,
          draftStepId: string,
        ) => WorkflowLayout.Layout,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { draft, step } = yield* resolveDraftStep(stepId);
            const layout = yield* layoutOf(draft.id);
            yield* writeLayout(draft.id, edit(layout, step.id));
          }),
        );

      /** Shared by `addStep` and `addParallelStep`: the step ceiling and the insert itself, into the draft. */
      const insertStep = ({
        versionId,
        position,
        stage,
        name,
        teamId,
        instructions,
      }: {
        readonly versionId: string;
        readonly position: Statement.Fragment;
        readonly stage: Statement.Fragment;
        readonly name: Domain.StepName;
        readonly teamId: Domain.TeamId;
        readonly instructions: Domain.StepInstructions | null;
      }) =>
        Effect.gen(function* () {
          if ((yield* countSteps(versionId)) >= Domain.WorkflowLimits.maxSteps)
            return yield* new WorkflowLimitError({
              limit: Domain.WorkflowLimits.maxSteps,
            });
          const now = yield* Clock.currentTimeMillis;
          return yield* insertStepRow({
            versionId,
            position,
            stage,
            name,
            teamId,
            instructions,
            now,
          });
        });

      /** Apply and turn-on share the content checks: at least one step, every team active. */
      const requireRoutableSteps = (
        workflowId: string,
        versionId: string,
        activeTeams: ActiveTeams,
      ) =>
        Effect.gen(function* () {
          const steps = yield* stepsOf(versionId);
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
                select w.id, w.name, w.scope, w.active, w.savedVersionId, w.draftVersionId,
                  w.createdAt, w.updatedAt, w.archivedAt,
                  (w.draftVersionId is not null) as hasDraft,
                  coalesce(v.tags, '[]') as tags,
                  (select count(*) from WorkflowStep s where s.versionId = w.savedVersionId) as stepCount,
                  (select count(*) from WorkflowRun r
                    where r.workflowId = w.id and r.status in ('pending', 'active')) as activeRunCount
                from Workflow w
                left join WorkflowVersion v on v.id = w.savedVersionId
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
            live: yield* versionSteps(workflow.value.savedVersionId),
            draft: yield* versionSteps(workflow.value.draftVersionId),
          } satisfies Domain.WorkflowVersions);
        }),

        listActiveWorkflowDetails: Effect.fn(
          "WorkflowRepository.listActiveWorkflowDetails",
        )(function* () {
          const workflows = yield* decodeWorkflows(
            yield* sql`
              select ${workflowColumns} from Workflow
              where archivedAt is null and active = 1 and savedVersionId is not null
              order by name collate nocase
            `,
          );
          const versions = yield* decodeVersions(
            yield* sql`
              select v.* from WorkflowVersion v
              join Workflow w on w.savedVersionId = v.id
              where w.archivedAt is null and w.active = 1
            `,
          );
          const steps = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowStep s
              join Workflow w on w.savedVersionId = s.versionId
              where w.archivedAt is null and w.active = 1
              order by s.versionId, s.position
            `,
          );
          const details: Domain.WorkflowDetail[] = [];
          for (const workflow of workflows) {
            const version = versions.find(
              (candidate) => candidate.id === workflow.savedVersionId,
            );
            if (version === undefined)
              return yield* new WorkflowRepositoryError({
                message: "savedVersionId resolves to no WorkflowVersion",
                cause: workflow.id,
              });
            details.push({
              workflow,
              version,
              steps: steps.filter((step) => step.versionId === version.id),
            });
          }
          return details;
        }),

        /**
         * A fixture with steps becomes one applied version (`appliedAt =
         * now`), switched on unless `active: false` or archived. A fixture
         * with no steps and no `draft` becomes a never-applied empty draft —
         * the state the ordinary path leaves a fresh workflow in — rather
         * than an applied empty version, which Apply can never produce.
         * `draft` seeds a pending draft beside the applied version.
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
            const staged = workflows.map((workflow) => ({
              ...workflow,
              steps: stage(workflow.steps),
              draft:
                workflow.draft === undefined ? null : stage(workflow.draft),
              active:
                workflow.active ??
                (workflow.steps.length > 0 && workflow.archived !== true),
            }));
            const invalid = staged.find(
              (workflow) =>
                !validLayout(workflow.steps) ||
                (workflow.draft !== null && !validLayout(workflow.draft)),
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
                workflow.scope === "order" && workflow.tags.length > 0,
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
              versionId: string,
              steps: ReturnType<typeof stage>,
            ) =>
              Effect.forEach(
                steps,
                (step) =>
                  sql`
                    insert into WorkflowStep
                      (id, versionId, position, stage, name, teamId, instructions, createdAt)
                    values
                      (${crypto.randomUUID()}, ${versionId}, ${step.position}, ${step.stage}, ${step.name}, ${step.teamId}, ${step.instructions ?? null}, ${now})
                  `,
                { discard: true },
              );
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`delete from WorkflowRun`;
                yield* sql`delete from Workflow`;
                for (const workflow of staged) {
                  const workflowId = crypto.randomUUID();
                  const applied = workflow.steps.length > 0;
                  const savedId = applied ? crypto.randomUUID() : null;
                  const draftId =
                    !applied || workflow.draft !== null
                      ? crypto.randomUUID()
                      : null;
                  yield* sql`
                    insert into Workflow
                      (id, name, scope, active, savedVersionId, draftVersionId, createdAt, updatedAt, archivedAt)
                    values
                      (${workflowId}, ${workflow.name}, ${workflow.scope ?? "item"}, ${workflow.active ? 1 : 0}, ${savedId}, ${draftId}, ${now}, ${now}, ${workflow.archived === true ? now : null})
                  `;
                  if (savedId !== null) {
                    yield* sql`
                      insert into WorkflowVersion
                        (id, workflowId, tags, createdAt, appliedAt, retiredAt)
                      values
                        (${savedId}, ${workflowId}, ${json(workflow.tags)}, ${now}, ${now}, null)
                    `;
                    yield* writeSteps(savedId, workflow.steps);
                  }
                  if (draftId !== null) {
                    yield* sql`
                      insert into WorkflowVersion
                        (id, workflowId, tags, createdAt, appliedAt, retiredAt)
                      values
                        (${draftId}, ${workflowId}, ${json(workflow.tags)}, ${now}, null, null)
                    `;
                    yield* writeSteps(draftId, workflow.draft ?? []);
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
         * exactly "taken". The workflow row goes first with `draftVersionId`
         * already set (no foreign key, so the version can follow), and the
         * version insert is skipped when the name was taken.
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
            const draftId = crypto.randomUUID();
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    insert or ignore into Workflow
                      (id, name, scope, active, savedVersionId, draftVersionId, createdAt, updatedAt, archivedAt)
                    values
                      (${workflowId}, ${name}, ${scope}, 0, null, ${draftId}, ${now}, ${now}, null)
                    returning ${workflowColumns}
                  `,
                );
                if (workflow === undefined)
                  return yield* new WorkflowNameTakenError({ name });
                yield* sql`
                  insert into WorkflowVersion
                    (id, workflowId, tags, createdAt, appliedAt, retiredAt)
                  values
                    (${draftId}, ${workflowId}, ${json(tags)}, ${now}, null, null)
                `;
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
                returning ${workflowColumns}
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
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const { draft } = yield* ensureDraft(workflowId);
                const now = yield* Clock.currentTimeMillis;
                const [version] = yield* decodeVersions(
                  yield* sql`
                    update WorkflowVersion set tags = ${json(tags)}
                    where id = ${draft.id}
                    returning *
                  `,
                );
                yield* sql`update Workflow set updatedAt = ${now} where id = ${workflowId}`;
                return (
                  version ??
                  (yield* new WorkflowRepositoryError({
                    message: "Draft vanished during tag update",
                    cause: draft.id,
                  }))
                );
              }),
            );
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
              returning ${workflowColumns}
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
              if (existing.savedVersionId === null)
                return yield* new NoSavedVersionError({ workflowId });
              yield* requireRoutableSteps(
                workflowId,
                existing.savedVersionId,
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
                returning ${workflowColumns}
              `,
            );
            return (
              workflow ?? (yield* new WorkflowNotFoundError({ workflowId }))
            );
          },
        ),

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
              if (existing.draftVersionId === null)
                return yield* new NoDraftError({ workflowId });
              const draft = yield* requireVersion(existing.draftVersionId);
              yield* requireRoutableSteps(workflowId, draft.id, activeTeams);
              yield* requireNoTagsForOrderScope(existing.scope, draft.tags);
              const now = yield* Clock.currentTimeMillis;
              if (existing.savedVersionId !== null)
                yield* sql`
                  update WorkflowVersion set retiredAt = ${now}
                  where id = ${existing.savedVersionId}
                `;
              yield* sql`
                update WorkflowVersion set appliedAt = ${now}
                where id = ${draft.id}
              `;
              const [workflow] = yield* decodeWorkflows(
                yield* sql`
                  update Workflow
                  set savedVersionId = ${draft.id}, draftVersionId = null, updatedAt = ${now}
                  where id = ${workflowId}
                  returning ${workflowColumns}
                `,
              );
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
              const existing = yield* requireWorkflow(workflowId);
              if (existing.draftVersionId === null)
                return yield* new NoDraftError({ workflowId });
              if (existing.savedVersionId === null)
                return yield* new NoSavedVersionError({ workflowId });
              const now = yield* Clock.currentTimeMillis;
              // The pointer is cleared before the row goes so the
              // "neither pointer" check never sees a dangling draft.
              const [workflow] = yield* decodeWorkflows(
                yield* sql`
                  update Workflow
                  set draftVersionId = null, updatedAt = ${now}
                  where id = ${workflowId}
                  returning ${workflowColumns}
                `,
              );
              yield* sql`delete from WorkflowVersion where id = ${existing.draftVersionId}`;
              return (
                workflow ?? (yield* new WorkflowNotFoundError({ workflowId }))
              );
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
            Effect.gen(function* () {
              const { draft } = yield* ensureDraft(workflowId);
              return yield* insertStep({
                versionId: draft.id,
                position: sql`(select coalesce(max(position), 0) + 1 from WorkflowStep where versionId = ${draft.id})`,
                stage: sql`(select coalesce(max(stage), 0) + 1 from WorkflowStep where versionId = ${draft.id})`,
                name,
                teamId,
                instructions: instructions ?? null,
              });
            }),
          );
        }),

        /**
         * Inserted at a temporary last position in the target stage, then the
         * whole layout is rewritten so the new step lands right after that
         * stage's last member. Fork, insert, and relayout share one
         * transaction, and the step is re-read afterwards so the caller sees
         * its final position.
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
                const { draft } = yield* ensureDraft(workflowId);
                const before = yield* layoutOf(draft.id);
                if (!before.some((p) => p.stage === stage))
                  return yield* new StageNotFoundError({ workflowId, stage });
                const inserted = yield* insertStep({
                  versionId: draft.id,
                  position: sql`${before.length + 1}`,
                  stage: sql`${stage}`,
                  name,
                  teamId,
                  instructions: instructions ?? null,
                });
                yield* writeLayout(
                  draft.id,
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
          const step = yield* findStep(stepId);
          if (Option.isNone(step)) return Option.none();
          const version = yield* requireVersion(step.value.versionId);
          return Option.some({
            step: step.value,
            workflow: yield* workflowOfVersion(version),
          });
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
              const { step: target } = yield* resolveDraftStep(stepId);
              const [step] = yield* decodeSteps(
                yield* sql`
                  update WorkflowStep
                  set name = ${name}, teamId = ${teamId}, instructions = ${instructions}
                  where id = ${target.id}
                  returning *
                `,
              );
              return step ?? (yield* new StepNotFoundError({ stepId }));
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
          yield* relayout(stepId, (layout, draftStepId) =>
            WorkflowLayout.move(layout, draftStepId, direction),
          );
        }),

        separateStep: Effect.fn("WorkflowRepository.separateStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          yield* relayout(stepId, (layout, draftStepId) =>
            WorkflowLayout.separate(layout, draftStepId),
          );
        }),

        /** Deletes, then rewrites the layout so positions and stages stay dense from 1 — one transaction with the fork. */
        removeStep: Effect.fn("WorkflowRepository.removeStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { draft, step } = yield* resolveDraftStep(stepId);
              const layout = yield* layoutOf(draft.id);
              yield* sql`delete from WorkflowStep where id = ${step.id}`;
              yield* writeLayout(
                draft.id,
                WorkflowLayout.remove(layout, step.id),
              );
            }),
          );
        }),

        countStepsOwnedBy: Effect.fn("WorkflowRepository.countStepsOwnedBy")(
          function* ({ teamId }: { readonly teamId: string }) {
            return yield* count(
              sql`
                select count(*) from WorkflowStep s
                join WorkflowVersion v on v.id = s.versionId
                where s.teamId = ${teamId} and v.retiredAt is null
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
                select w.id as workflowId, w.name as workflowName,
                  (w.archivedAt is not null) as workflowArchived,
                  case when v.appliedAt is null then 'draft' else 'live' end as versionState,
                  s.name as stepName
                from WorkflowStep s
                join WorkflowVersion v on v.id = s.versionId
                join Workflow w on w.id = v.workflowId
                where s.teamId = ${teamId} and v.retiredAt is null
                order by w.archivedAt is not null, w.name collate nocase, v.appliedAt is null, s.position
              `,
            );
          },
        ),
      });
    }),
  );
}

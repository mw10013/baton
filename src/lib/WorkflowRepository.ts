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
 * Another workflow already holds the name, case-insensitively. Uniqueness is
 * among existing rows only — a delete frees the name at once. Detected by a
 * `select` inside the write's transaction, never by matching constraint text:
 * the workflow has two unique keys and a constraint failure cannot say which
 * one the merchant has to change.
 */
export class WorkflowNameTakenError extends Schema.TaggedError<WorkflowNameTakenError>()(
  "WorkflowNameTakenError",
  { name: Domain.WorkflowName },
) {}

export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { workflowId: Schema.String },
) {}

/**
 * A tag another workflow already carries, on or off. The tag is the
 * workflow's key — the one string a product can carry that names it — and the
 * `unique` on `Workflow.tag` is the rule. This error exists so the refusal can
 * name the holder and the merchant is told which field to change, at the
 * moment they typed it: Create, Duplicate, and Edit tag.
 */
export class WorkflowTagTakenError extends Schema.TaggedError<WorkflowTagTakenError>()(
  "WorkflowTagTakenError",
  { tag: Domain.WorkflowTag, workflowName: Domain.WorkflowName },
) {}

/** A step id the editor sent that neither the draft nor the workflow carries — a step some other tab already removed, or a stale id. */
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

/** `setWorkflowActivatedAt` on a workflow that is off: there is no coverage date to move. */
export class WorkflowOffError extends Schema.TaggedError<WorkflowOffError>()(
  "WorkflowOffError",
  { workflowId: Schema.String },
) {}

/**
 * Apply or Discard without a draft: there is nothing to promote or throw
 * away. Step and tag writes never raise this — they create the draft they
 * need (see `ensureDraft`).
 */
export class NoDraftError extends Schema.TaggedError<NoDraftError>()(
  "NoDraftError",
  { workflowId: Schema.String },
) {}

export class NoStepsError extends Schema.TaggedError<NoStepsError>()(
  "NoStepsError",
  { workflowId: Schema.String },
) {}

/**
 * Apply or turn-on refused because these steps are unassigned: `teamId` null
 * (a team delete nulled it) or an id the live roster does not carry (the
 * cross-store window, read as null). An empty team is deliberately not here —
 * that is a warning, never a refusal.
 */
export class StepUnassignedError extends Schema.TaggedError<StepUnassignedError>()(
  "StepUnassignedError",
  { workflowId: Schema.String, stepNames: Schema.Array(Domain.StepName) },
) {}

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

/** The live D1 roster as the object passes it in; `memberCount` only matters to the list's attention badge. */
type Teams = readonly {
  readonly id: Domain.TeamId;
  readonly memberCount?: number;
}[];

/** Unassigned: `teamId` null, or an id no team in `teams` carries. */
const isUnassigned = (step: Domain.WorkflowStep, teams: Teams) =>
  step.teamId === null || !teams.some((team) => team.id === step.teamId);

/** The names of the unassigned `steps`, in position order. */
const unassignedStepNames = (
  steps: readonly Domain.WorkflowStep[],
  teams: Teams,
) => steps.filter((step) => isUnassigned(step, teams)).map((step) => step.name);

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  {
    /**
     * `teams` is the live roster: `needsAttention` is derived per row from
     * the workflow's steps against it (unassigned, or on a team with no
     * members) and never stored.
     */
    readonly listWorkflows: (input: {
      readonly teams: Teams;
    }) => Effect.Effect<
      readonly Domain.WorkflowSummary[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Deletes the definition only: the workflow row, and its steps, draft,
     * and draft steps by cascade. Every run stays, open
     * and finished, and keeps working — a run snapshots `workflowName`
     * and each step's `name`, `stage`, `instructions`, and `teamName`, and
     * no read joins a run back to `Workflow`, so an orphan run renders,
     * queues, starts, completes, blocks, and cancels unchanged.
     * `WorkflowRun.workflowId` stays `not null` because it is the conflict
     * key of `unique (lineItemId, workflowId)`.
     * No turn-off-first rule.
     */
    readonly deleteWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      void,
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
    >;
    /** The workflow with its steps, and the draft with its steps when one exists. */
    readonly getWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowWithDraft>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Every switched-on workflow with its steps, in two statements rather
     * than one per workflow: this is what an order upsert
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
     * transaction. Destructive on purpose — a
     * reseed exists to discard whatever the last one left behind, and
     * skipping existing names would preserve it.
     *
     * `WorkflowRun` needs its own delete: it deliberately has no foreign key
     * to `Workflow` (a run snapshots its definition so it survives a rename),
     * so nothing cascades from the `Workflow` delete to it.
     *
     * Bypasses the name, limit, and team checks the ordinary write path
     * enforces: positions come from array order and `teamId` from `Team` rows
     * the caller created moments earlier, so there is nothing left to race.
     * The Durable Object gates the callable on `ENVIRONMENT === "local"`.
     */
    readonly replaceWorkflows: (
      input: Domain.SeedWorkflowsInput,
    ) => Effect.Effect<void, SqlError.SqlError | WorkflowRepositoryError>;
    /**
     * Inserts the workflow: off, no steps, carrying its tag, and **no draft**.
     * The draft is the editor's record of unsaved changes and is created by
     * the first change (`ensureDraft`), so a fresh workflow has none and the
     * editor opens on "No changes yet" rather than on a Draft badge and a
     * Discard button for nothing. Both keys are checked before the insert so
     * the dialog can say which one to change.
     */
    readonly createWorkflow: (
      input: Domain.CreateWorkflowInput,
    ) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNameTakenError
      | WorkflowTagTakenError
      | WorkflowLimitError
    >;
    /**
     * A copy of the workflow's steps, with their stages under new ids, under
     * the name and tag the merchant chose in the Duplicate dialog; off, with
     * no draft. Both keys are checked before the insert so the dialog can say
     * which one to change.
     */
    readonly duplicateWorkflow: (input: {
      readonly workflowId: string;
      readonly name: Domain.WorkflowName;
      readonly tag: Domain.WorkflowTag;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowNameTakenError
      | WorkflowTagTakenError
      | WorkflowLimitError
    >;
    /** Rename only; immediate, since runs snapshot the name. */
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
    /**
     * Writes the tag on the workflow row immediately, like a rename, and
     * creates no draft: runs snapshot the tag at start, so nothing in flight
     * moves. Refuses a tag another workflow holds, on or off.
     */
    readonly updateWorkflowTag: (input: {
      readonly workflowId: string;
      readonly tag: Domain.WorkflowTag;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowTagTakenError
    >;
    /**
     * The on/off switch. On requires: at least one step, every step assigned
     * to a team in `teams`; it writes `activatedAt = activatedAt ?? now`, the
     * coverage date every later reconcile compares orders against (the
     * caller passes an earlier date when the merchant chose to include
     * waiting orders). A team with no members does not refuse. Tags are not
     * its business: every workflow's tag is unique from birth, so the switch
     * can never collide with one. Off writes
     * `activatedAt = null` and touches nothing else: open runs are days of
     * physical work and keep going; only new runs stop. Neither direction
     * creates, applies, or discards a draft, or looks at whether one exists.
     */
    readonly setWorkflowActive: (input: {
      readonly workflowId: string;
      readonly active: boolean;
      readonly activatedAt?: number;
      readonly teams: Teams;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoStepsError
      | StepUnassignedError
    >;
    /**
     * Moves the coverage date of an on workflow: the merchant's escape hatch
     * for a cut-off chosen too late, or a workflow turned off by mistake and
     * back on. Refused while off (`WorkflowOffError`): there is no date to
     * move. The caller reconciles every stored order afterwards.
     */
    readonly setWorkflowActivatedAt: (input: {
      readonly workflowId: string;
      readonly activatedAt: number;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowOffError
    >;
    /**
     * The draft, made explicitly. Returns the existing one when there is one;
     * otherwise inserts a draft with a copy of every workflow step under a
     * new id, in one transaction. The editor does not
     * call this — its writes create the draft themselves — so this is for a
     * caller that wants a draft without changing anything.
     */
    readonly createDraft: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Domain.WorkflowDraft,
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
    >;
    /**
     * Replaces the workflow's steps with the draft's and deletes the draft, in
     * one transaction: an order sees the old definition or the new one, never
     * a half-edit. Refused with no draft, an empty draft, or an unassigned
     * step, on and off alike. The tag is not drafted, so Apply never reads or
     * writes it. Does not touch `activatedAt`: the workflow stays responsible
     * for the orders it was responsible for, and the caller reconciles them
     * against the new definition. Draft step ids carry over to the workflow.
     */
    readonly applyDraft: (input: {
      readonly workflowId: string;
      readonly teams: Teams;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
      | NoStepsError
      | StepUnassignedError
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
    /** New step in a new last stage of the draft, creating the draft if this is the first change. */
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
      | WorkflowLimitError
      | StageNotFoundError
    >;
    /**
     * A step the editor can act on, with its workflow: the draft's row when
     * there is a draft, otherwise the workflow's own — the same id either way
     * (`ensureDraft`). A read, so it creates nothing.
     */
    readonly getStep: (input: { readonly stepId: string }) => Effect.Effect<
      Option.Option<{
        readonly step: Domain.WorkflowDraftStep;
        readonly workflow: Domain.Workflow;
      }>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The step-id writes below all land on the draft, creating it from the
     * workflow when this is the first change (`requireEditableStep`).
     * `instructions: null` clears.
     */
    readonly updateStep: (input: {
      readonly stepId: string;
      readonly name: Domain.StepName;
      readonly teamId: Domain.TeamId;
      readonly instructions: Domain.StepInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowDraftStep,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | StepNotFoundError
    >;
    /**
     * The moved step always ends alone in its stage; other steps keep their
     * stage-mates. A move past either edge is a no-op, not an error.
     */
    readonly moveStep: (input: {
      readonly stepId: string;
      readonly direction: Domain.StepDirection;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | StepNotFoundError
    >;
    /** The step leaves its stage into a new one of its own right after it; no-op when already alone. */
    readonly separateStep: (input: {
      readonly stepId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | StepNotFoundError
    >;
    /**
     * The step joins the previous stage, last among its members; no-op in
     * stage 1. Lands on the draft, creating it on first change, like every
     * step-id write.
     */
    readonly joinStep: (input: {
      readonly stepId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | StepNotFoundError
    >;
    readonly removeStep: (input: {
      readonly stepId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | StepNotFoundError
    >;
    /**
     * Every pointer a team delete would null, per team: workflow steps, draft
     * steps, and open run steps. Feeds the delete dialogs, never a refusal.
     * Teams that own nothing are absent.
     */
    readonly countStepsByTeam: () => Effect.Effect<
      readonly Domain.TeamStepCounts[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    readonly listStepsOwnedBy: (input: {
      readonly teamId: string;
    }) => Effect.Effect<
      readonly Domain.OwnedStep[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /** {@link listStepsOwnedBy} for every team at once; the teams index's "Used by" column. */
    readonly listOwnedSteps: () => Effect.Effect<
      readonly Domain.OwnedStepByTeam[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The object-side half of a team delete: every workflow step, draft step,
     * and *open* run step that points at `teamId` becomes unassigned, in one
     * transaction. Finished run steps keep the pointer and their `teamName`
     * snapshot. Idempotent, so a retry after a failed first attempt (D1 row
     * already gone) still cleans up. Touches `WorkflowRunStep` from here
     * rather than from the run repository because the three updates must
     * share one transaction and Durable Object SQLite refuses to nest.
     */
    readonly unassignTeam: (input: {
      readonly teamId: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
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

      const findWorkflowStep = (stepId: string) =>
        sql`select * from WorkflowStep where id = ${stepId}`.pipe(
          Effect.flatMap(decodeSteps),
          Effect.map(([step]) => Option.fromUndefinedOr(step)),
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

      const insertDraft = ({
        workflowId,
        now,
      }: {
        readonly workflowId: string;
        readonly now: number;
      }) =>
        Effect.gen(function* () {
          const [draft] = yield* decodeDrafts(
            yield* sql`
              insert into WorkflowDraft (workflowId, createdAt, updatedAt)
              values (${workflowId}, ${now}, ${now})
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
        id,
        workflowId,
        position,
        stage,
        name,
        teamId,
        instructions,
      }: {
        /** The workflow step's id when the draft is copying it, so a step keeps one identity; a new one otherwise. */
        readonly id?: string;
        readonly workflowId: string;
        readonly position: Statement.Fragment;
        readonly stage: Statement.Fragment;
        readonly name: Domain.StepName;
        readonly teamId: Domain.TeamId | null;
        readonly instructions: Domain.StepInstructions | null;
      }) =>
        Effect.gen(function* () {
          const [step] = yield* decodeSteps(
            yield* sql`
              insert into WorkflowDraftStep
                (id, workflowId, position, stage, name, teamId, instructions)
              values (
                ${id ?? crypto.randomUUID()}, ${workflowId}, ${position}, ${stage},
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

      /**
       * The draft every editor write lands on, created on demand. Opening the
       * editor is not an edit: nothing is written until the merchant changes
       * something, and by then the draft has to exist for the change to go
       * anywhere. So step writes come through here instead of refusing with
       * `NoDraftError`, and a draft that did not exist starts as a copy of
       * the workflow's steps, each **under the step's own id**. The tag is
       * not drafted. That identity is what lets the editor edit a step it
       * is looking at before any draft exists: the id it sends names the
       * workflow step now and the draft's copy of it a moment later, and
       * Apply carries the same ids back (see `requireEditableStep`).
       * Apply and Discard still require a draft.
       *
       * No transaction of its own: every caller already opened one, and
       * Durable Object SQLite refuses to nest.
       */
      const ensureDraft = (workflowId: string) =>
        Effect.gen(function* () {
          yield* requireWorkflow(workflowId);
          const existing = yield* findDraft(workflowId);
          if (Option.isSome(existing)) return existing.value;
          const draft = yield* insertDraft({
            workflowId,
            now: yield* Clock.currentTimeMillis,
          });
          yield* Effect.forEach(
            yield* workflowSteps(workflowId),
            (step) =>
              insertDraftStepRow({
                id: step.id,
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
        });

      /**
       * The draft row a step-id write targets. Until a draft exists the
       * editor is looking at the workflow's own steps, so the id it sends is
       * a workflow step's: that write is the first change, and `ensureDraft`
       * copies the steps under their own ids, so the same id names the
       * draft's copy immediately afterwards. An id neither table carries is
       * `StepNotFoundError` as before — including a step this draft has
       * already removed.
       */
      const requireEditableStep = (stepId: string) =>
        Effect.gen(function* () {
          const drafted = yield* findDraftStep(stepId);
          if (Option.isSome(drafted)) return drafted.value;
          const live = yield* findWorkflowStep(stepId);
          if (Option.isNone(live))
            return yield* new StepNotFoundError({ stepId });
          yield* ensureDraft(live.value.workflowId);
          return yield* requireDraftStep(stepId);
        });

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
            const step = yield* requireEditableStep(stepId);
            const layout = yield* layoutOf(step.workflowId);
            yield* writeLayout(step.workflowId, edit(layout));
            yield* touchDraft(step.workflowId, yield* Clock.currentTimeMillis);
          }),
        );

      /** Shared by `addStep` and `addParallelStep`: the draft (created if this is the first change), the step ceiling, and the insert itself. */
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
          yield* ensureDraft(workflowId);
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

      /** Apply and turn-on share the content checks: at least one step, every step assigned. */
      const requireStartableSteps = (
        workflowId: string,
        steps: readonly Domain.WorkflowStep[],
        teams: Teams,
      ) =>
        Effect.gen(function* () {
          if (steps.length === 0)
            return yield* new NoStepsError({ workflowId });
          const stepNames = unassignedStepNames(steps, teams);
          if (stepNames.length > 0)
            return yield* new StepUnassignedError({ workflowId, stepNames });
          return steps;
        });

      const decodeHolders = decode(
        Schema.Array(Schema.Struct({ name: Domain.WorkflowName })),
        "Invalid Workflow name row",
      );

      /**
       * Which workflow, if any, already holds `name`, excluding `workflowId`
       * so a rename may keep the workflow's own name. `Workflow_name_uidx` is
       * the guarantee; this select exists so the refusal can say the name is
       * the field that collided rather than the tag. Runs inside the caller's
       * transaction on the Durable Object's synchronous SQLite, so nothing can
       * interleave between it and the write that follows.
       */
      const requireNameFree = (
        name: Domain.WorkflowName,
        workflowId: string | null,
      ) =>
        Effect.gen(function* () {
          const [holder] = yield* decodeHolders(
            yield* sql`
              select name from Workflow
              where name = ${name} collate nocase
                and (${workflowId} is null or id <> ${workflowId})
            `,
          );
          if (holder !== undefined) yield* new WorkflowNameTakenError({ name });
        });

      /**
       * The same question for the tag, whose `unique` on `Workflow.tag` is the
       * guarantee. Tags are stored folded (`Domain.WorkflowTag` trims and
       * lowercases), so plain equality is the whole comparison — the same
       * equality `WorkflowRunRepository.matchesTag` uses. The holder's name
       * rides back so the merchant can decide whether to change this tag or go
       * retag the other workflow.
       */
      const requireTagFree = (
        tag: Domain.WorkflowTag,
        workflowId: string | null,
      ) =>
        Effect.gen(function* () {
          const [holder] = yield* decodeHolders(
            yield* sql`
              select name from Workflow
              where tag = ${tag}
                and (${workflowId} is null or id <> ${workflowId})
            `,
          );
          if (holder !== undefined)
            yield* new WorkflowTagTakenError({
              tag,
              workflowName: holder.name,
            });
        });

      return WorkflowRepository.of({
        listWorkflows: Effect.fn("WorkflowRepository.listWorkflows")(
          function* ({ teams }: { readonly teams: Teams }) {
            const rows = yield* decode(
              Schema.Array(Domain.WorkflowSummaryRow),
              "Invalid WorkflowSummary row",
            )(
              yield* sql`
                select w.*,
                  exists (select 1 from WorkflowDraft d where d.workflowId = w.id) as hasDraft,
                  (select count(*) from WorkflowStep s where s.workflowId = w.id) as stepCount
                from Workflow w
                order by w.name collate nocase
              `,
            );
            // Derived, never stored: the badge is computed from the workflow's
            // steps against the roster on every list read, so assigning a
            // team or adding a member clears it with no other write.
            const steps = yield* decodeSteps(
              yield* sql`select * from WorkflowStep order by workflowId, position`,
            );
            const emptyTeam = (step: Domain.WorkflowStep) =>
              teams.some(
                (team) => team.id === step.teamId && team.memberCount === 0,
              );
            return rows.map((row): Domain.WorkflowSummary => ({
              ...row,
              needsAttention: steps.some(
                (step) =>
                  step.workflowId === row.id &&
                  (isUnassigned(step, teams) || emptyTeam(step)),
              ),
            }));
          },
        ),

        deleteWorkflow: Effect.fn("WorkflowRepository.deleteWorkflow")(
          function* ({ workflowId }: { readonly workflowId: string }) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireWorkflow(workflowId);
                yield* sql`delete from Workflow where id = ${workflowId}`;
              }),
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
              where activatedAt is not null
              order by name collate nocase
            `,
          );
          const steps = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowStep s
              join Workflow w on w.id = s.workflowId
              where w.activatedAt is not null
              order by s.workflowId, s.position
            `,
          );
          return workflows.map((workflow): Domain.WorkflowDetail => ({
            workflow,
            steps: steps.filter((step) => step.workflowId === workflow.id),
          }));
        }),

        /**
         * A fixture's `steps` become the workflow's steps, switched on
         * (`activatedAt = now`, so orders seeded afterwards qualify) unless
         * `active: false` or a step is unassigned. A fixture with no steps and
         * no `draft` has no draft either, the state `createWorkflow` leaves a
         * fresh workflow in. `draft` seeds a pending draft beside the
         * workflow.
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
            const draftOf = (
              workflow: Domain.SeedWorkflowsInput["workflows"][number],
            ) =>
              workflow.draft === undefined
                ? null
                : { steps: stage(workflow.draft.steps) };
            const staged = workflows.map((workflow) => ({
              ...workflow,
              steps: stage(workflow.steps),
              draft: draftOf(workflow),
              active:
                workflow.active ??
                (workflow.steps.length > 0 &&
                  workflow.steps.every((step) => step.teamId !== null)),
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
            // The invariant the ordinary write path enforces that a fixture
            // could otherwise silently break.
            const badActive = staged.find(
              (workflow) => workflow.active && workflow.steps.length === 0,
            );
            if (badActive !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${badActive.name}: an active workflow needs steps`,
                cause: badActive.name,
              });
            // `Workflow.tag` is unique, so a fixture repeating a tag would
            // fail as a bare constraint error naming no workflow. Seeds are
            // trusted, so this refuses loudly instead.
            const duplicateTag = staged.find(
              (workflow, index) =>
                staged.findIndex((other) => other.tag === workflow.tag) < index,
            );
            if (duplicateTag !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${duplicateTag.name} tag=${duplicateTag.tag}: two workflows cannot share a tag`,
                cause: duplicateTag.tag,
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
                      (id, name, tag, activatedAt, createdAt, updatedAt)
                    values
                      (${workflowId}, ${workflow.name}, ${workflow.tag}, ${workflow.active ? now : null}, ${now}, ${now})
                  `;
                  yield* writeSteps(
                    sql.literal("WorkflowStep"),
                    workflowId,
                    workflow.steps,
                  );
                  if (workflow.draft !== null) {
                    yield* insertDraft({ workflowId, now });
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
         * The name and the tag are each asked about before the insert, inside
         * one transaction: the workflow has two unique keys and the merchant
         * typed both, so the refusal has to name the field that collided.
         */
        createWorkflow: Effect.fn("WorkflowRepository.createWorkflow")(
          function* ({ name, tag }: Domain.CreateWorkflowInput) {
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const open = yield* count(sql`select count(*) from Workflow`);
                if (open >= Domain.WorkflowLimits.maxWorkflows)
                  return yield* new WorkflowLimitError({
                    limit: Domain.WorkflowLimits.maxWorkflows,
                  });
                yield* requireNameFree(name, null);
                yield* requireTagFree(tag, null);
                const now = yield* Clock.currentTimeMillis;
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    insert into Workflow
                      (id, name, tag, activatedAt, createdAt, updatedAt)
                    values
                      (${crypto.randomUUID()}, ${name}, ${tag}, null, ${now}, ${now})
                    returning *
                  `,
                );
                return (
                  workflow ??
                  (yield* new WorkflowRepositoryError({
                    message: "Workflow insert returned no row",
                    cause: name,
                  }))
                );
              }),
            );
          },
        ),

        duplicateWorkflow: Effect.fn("WorkflowRepository.duplicateWorkflow")(
          function* ({
            workflowId,
            name,
            tag,
          }: {
            readonly workflowId: string;
            readonly name: Domain.WorkflowName;
            readonly tag: Domain.WorkflowTag;
          }) {
            const copyId = crypto.randomUUID();
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireWorkflow(workflowId);
                const open = yield* count(sql`select count(*) from Workflow`);
                if (open >= Domain.WorkflowLimits.maxWorkflows)
                  return yield* new WorkflowLimitError({
                    limit: Domain.WorkflowLimits.maxWorkflows,
                  });
                yield* requireNameFree(name, null);
                yield* requireTagFree(tag, null);
                const steps = yield* workflowSteps(workflowId);
                const now = yield* Clock.currentTimeMillis;
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    insert into Workflow
                      (id, name, tag, activatedAt, createdAt, updatedAt)
                    values
                      (${copyId}, ${name}, ${tag}, null, ${now}, ${now})
                    returning *
                  `,
                );
                if (workflow === undefined)
                  return yield* new WorkflowRepositoryError({
                    message: "Workflow copy insert returned no row",
                    cause: name,
                  });
                yield* Effect.forEach(
                  steps,
                  (step) =>
                    sql`
                      insert into WorkflowStep
                        (id, workflowId, position, stage, name, teamId, instructions)
                      values (
                        ${crypto.randomUUID()}, ${copyId}, ${step.position},
                        ${step.stage}, ${step.name}, ${step.teamId},
                        ${step.instructions}
                      )
                    `,
                  { discard: true },
                );
                return workflow;
              }),
            );
          },
        ),

        /** The rename excludes the workflow's own row, so re-saving the current name is not a collision. */
        updateWorkflow: Effect.fn("WorkflowRepository.updateWorkflow")(
          function* ({
            workflowId,
            name,
          }: {
            readonly workflowId: string;
            readonly name: Domain.WorkflowName;
          }) {
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireWorkflow(workflowId);
                yield* requireNameFree(name, workflowId);
                const now = yield* Clock.currentTimeMillis;
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    update Workflow
                    set name = ${name}, updatedAt = ${now}
                    where id = ${workflowId}
                    returning *
                  `,
                );
                return (
                  workflow ??
                  (yield* new WorkflowRepositoryError({
                    message: "Workflow rename returned no row",
                    cause: workflowId,
                  }))
                );
              }),
            );
          },
        ),

        updateWorkflowTag: Effect.fn("WorkflowRepository.updateWorkflowTag")(
          function* ({
            workflowId,
            tag,
          }: {
            readonly workflowId: string;
            readonly tag: Domain.WorkflowTag;
          }) {
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireWorkflow(workflowId);
                yield* requireTagFree(tag, workflowId);
                const now = yield* Clock.currentTimeMillis;
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    update Workflow
                    set tag = ${tag}, updatedAt = ${now}
                    where id = ${workflowId}
                    returning *
                  `,
                );
                return (
                  workflow ??
                  (yield* new WorkflowRepositoryError({
                    message: "Workflow tag update returned no row",
                    cause: workflowId,
                  }))
                );
              }),
            );
          },
        ),

        setWorkflowActive: Effect.fn("WorkflowRepository.setWorkflowActive")(
          function* ({
            workflowId,
            active,
            activatedAt,
            teams,
          }: {
            readonly workflowId: string;
            readonly active: boolean;
            readonly activatedAt?: number;
            readonly teams: Teams;
          }) {
            yield* requireWorkflow(workflowId);
            if (active)
              yield* requireStartableSteps(
                workflowId,
                yield* workflowSteps(workflowId),
                teams,
              );
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                update Workflow
                set activatedAt = ${active ? (activatedAt ?? now) : null}, updatedAt = ${now}
                where id = ${workflowId}
                returning *
              `,
            );
            return (
              workflow ?? (yield* new WorkflowNotFoundError({ workflowId }))
            );
          },
        ),

        /**
         * `where activatedAt is not null` makes the update itself the on
         * check; an empty result is then told apart by one more read, so an
         * off workflow and a missing one get different names.
         */
        setWorkflowActivatedAt: Effect.fn(
          "WorkflowRepository.setWorkflowActivatedAt",
        )(function* ({
          workflowId,
          activatedAt,
        }: {
          readonly workflowId: string;
          readonly activatedAt: number;
        }) {
          const now = yield* Clock.currentTimeMillis;
          const [workflow] = yield* decodeWorkflows(
            yield* sql`
              update Workflow
              set activatedAt = ${activatedAt}, updatedAt = ${now}
              where id = ${workflowId} and activatedAt is not null
              returning *
            `,
          );
          if (workflow !== undefined) return workflow;
          yield* requireWorkflow(workflowId);
          return yield* new WorkflowOffError({ workflowId });
        }),

        createDraft: Effect.fn("WorkflowRepository.createDraft")(function* ({
          workflowId,
        }: {
          readonly workflowId: string;
        }) {
          return yield* sql.withTransaction(ensureDraft(workflowId));
        }),

        applyDraft: Effect.fn("WorkflowRepository.applyDraft")(function* ({
          workflowId,
          teams,
        }: {
          readonly workflowId: string;
          readonly teams: Teams;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireWorkflow(workflowId);
              yield* requireDraft(workflowId);
              const steps = yield* draftSteps(workflowId);
              yield* requireStartableSteps(workflowId, steps, teams);
              const now = yield* Clock.currentTimeMillis;
              yield* sql`delete from WorkflowStep where workflowId = ${workflowId}`;
              yield* sql`
                insert into WorkflowStep
                  (id, workflowId, position, stage, name, teamId, instructions)
                select id, workflowId, position, stage, name, teamId, instructions
                from WorkflowDraftStep
                where workflowId = ${workflowId}
              `;
              // Steps only; the tag is not drafted. `updatedAt` still moves so
              // the detail page's "Last updated on" reflects the Apply.
              const [workflow] = yield* decodeWorkflows(
                yield* sql`
                  update Workflow
                  set updatedAt = ${now}
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
                yield* ensureDraft(workflowId);
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
          const drafted = yield* findDraftStep(stepId);
          const step = Option.isSome(drafted)
            ? drafted
            : yield* findWorkflowStep(stepId);
          if (Option.isNone(step)) return Option.none();
          const workflow = yield* findWorkflow(step.value.workflowId);
          if (Option.isNone(workflow))
            return yield* new WorkflowRepositoryError({
              message: "Step.workflowId resolves to no Workflow",
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
              yield* requireEditableStep(stepId);
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

        joinStep: Effect.fn("WorkflowRepository.joinStep")(function* ({
          stepId,
        }: {
          readonly stepId: string;
        }) {
          yield* relayout(stepId, (layout) =>
            WorkflowLayout.join(layout, stepId),
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
              const step = yield* requireEditableStep(stepId);
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

        countStepsByTeam: Effect.fn("WorkflowRepository.countStepsByTeam")(
          function* () {
            return yield* decode(
              Schema.Array(Domain.TeamStepCounts),
              "Invalid TeamStepCounts row",
            )(
              yield* sql`
                select teamId,
                  sum(workflowSteps) as workflowSteps,
                  sum(draftSteps) as draftSteps,
                  sum(openRunSteps) as openRunSteps
                from (
                  select teamId, 1 as workflowSteps, 0 as draftSteps, 0 as openRunSteps
                  from WorkflowStep where teamId is not null
                  union all
                  select teamId, 0, 1, 0
                  from WorkflowDraftStep where teamId is not null
                  union all
                  select s.teamId, 0, 0, 1
                  from WorkflowRunStep s
                  join WorkflowRun r on r.id = s.runId
                  where s.teamId is not null and s.completedAt is null
                    and r.status in ('pending', 'active')
                )
                group by teamId
                order by teamId
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
                select workflowId, workflowName, side, stepName from (
                  select w.id as workflowId, w.name as workflowName,
                    'workflow' as side, 0 as sideOrder, s.name as stepName, s.position
                  from WorkflowStep s
                  join Workflow w on w.id = s.workflowId
                  where s.teamId = ${teamId}
                  union all
                  select w.id, w.name, 'draft', 1, s.name, s.position
                  from WorkflowDraftStep s
                  join Workflow w on w.id = s.workflowId
                  where s.teamId = ${teamId}
                )
                order by workflowName collate nocase, sideOrder, position
              `,
            );
          },
        ),

        listOwnedSteps: Effect.fn("WorkflowRepository.listOwnedSteps")(
          function* () {
            return yield* decode(
              Schema.Array(Domain.OwnedStepByTeam),
              "Invalid OwnedStepByTeam row",
            )(
              yield* sql`
                select teamId, workflowId, workflowName, side, stepName from (
                  select s.teamId, w.id as workflowId, w.name as workflowName,
                    'workflow' as side, 0 as sideOrder, s.name as stepName, s.position
                  from WorkflowStep s
                  join Workflow w on w.id = s.workflowId
                  where s.teamId is not null
                  union all
                  select s.teamId, w.id, w.name, 'draft', 1, s.name, s.position
                  from WorkflowDraftStep s
                  join Workflow w on w.id = s.workflowId
                  where s.teamId is not null
                )
                order by workflowName collate nocase, sideOrder, position
              `,
            );
          },
        ),

        unassignTeam: Effect.fn("WorkflowRepository.unassignTeam")(function* ({
          teamId,
        }: {
          readonly teamId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`update WorkflowStep set teamId = null where teamId = ${teamId}`;
              yield* sql`update WorkflowDraftStep set teamId = null where teamId = ${teamId}`;
              yield* sql`
                update WorkflowRunStep set teamId = null
                where teamId = ${teamId} and completedAt is null
              `;
            }),
          );
        }),
      });
    }),
  );
}

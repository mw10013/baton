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
 * among existing rows only — a delete frees the name at once. Detected by
 * `insert or ignore ... returning` yielding no row, not by matching
 * constraint text.
 */
export class WorkflowNameTakenError extends Schema.TaggedError<WorkflowNameTakenError>()(
  "WorkflowNameTakenError",
  { name: Domain.WorkflowName },
) {}

export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { workflowId: Schema.String },
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

/**
 * Delete, rename, or duplicate aimed at the order workflow singleton
 * (`Domain.ORDER_WORKFLOW_ID`). The schema `check` would refuse the rename
 * and the delete would strand the shop without its one order workflow; the
 * UI never offers the controls, so this names the refusal for a stale
 * client. Zero reads: the id is the whole test.
 */
export class SingletonWorkflowError extends Schema.TaggedError<SingletonWorkflowError>()(
  "SingletonWorkflowError",
  { workflowId: Schema.String },
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

const json = (value: unknown) => JSON.stringify(value);

/** `Workflow_name_uidx` is `collate nocase`, so names collide case-insensitively. */
const MAX_NAME_LENGTH = 64;

/**
 * The name a duplicate takes: `<name> copy`, then `<name> copy 2`, and so on
 * until one is free, with the base trimmed so the result fits
 * `Domain.WorkflowName`. Duplicate is one click and must not fail on a name
 * the merchant never chose, so it picks a free one instead of colliding.
 *
 * `taken.length + 1` candidates against `taken.length` taken names always
 * leave one free, so the fallback is unreachable.
 */
export const copyName = (name: string, taken: readonly string[]): string => {
  const used = new Set(taken.map((existing) => existing.toLowerCase()));
  const withSuffix = (suffix: string) =>
    `${name.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const candidates = [
    withSuffix(" copy"),
    ...Array.from({ length: taken.length }, (_, index) =>
      withSuffix(` copy ${String(index + 2)}`),
    ),
  ];
  return (
    candidates.find((candidate) => !used.has(candidate.toLowerCase())) ??
    withSuffix(` copy ${String(taken.length + 2)}`)
  );
};

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
     * members) and never stored. `type` narrows in SQL; the workflows page
     * lists item workflows only, the order workflow having its own page.
     */
    readonly listWorkflows: (input: {
      readonly teams: Teams;
      readonly type?: Domain.WorkflowType;
    }) => Effect.Effect<
      readonly Domain.WorkflowSummary[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Deletes the definition only: the workflow row, and its steps, draft,
     * and draft steps by cascade. The order workflow singleton refuses
     * (`SingletonWorkflowError`); turn it off instead. Every run stays, open
     * and finished, and keeps working — a run snapshots `workflowName`
     * and each step's `name`, `stage`, `instructions`, and `teamName`, and
     * no read joins a run back to `Workflow`, so an orphan run renders,
     * queues, starts, completes, blocks, and cancels unchanged.
     * `WorkflowRun.workflowId` stays `not null` because it is the conflict
     * key of `unique (lineItemId, workflowId)` and `WorkflowRun_order_uidx`.
     * No turn-off-first rule.
     */
    readonly deleteWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | SingletonWorkflowError
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
     * The shop's one order workflow with its steps, in any state — on or
     * off, with or without steps. `listActiveWorkflowDetails` cannot see an
     * off one, and the order page must say when the order workflow is off.
     * Always present: the schema inserts the singleton, so a missing row is
     * a `WorkflowRepositoryError`, not an `Option`.
     */
    readonly getOrderWorkflow: () => Effect.Effect<
      Domain.WorkflowDetail,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Development seed only (`ShopAgent.seedWorkflows`): replaces every item
     * definition, every draft, and every run with `workflows`, in one
     * transaction, and rewrites the order workflow singleton in place from
     * the fixture's `type: "order"` entry (steps, draft, switch) or resets it
     * to off and empty when the fixture has none. Destructive on purpose — a
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
     * Inserts the workflow: off, no steps, carrying `tags`, and **no draft**.
     * The draft is the editor's record of unsaved changes and is created by
     * the first change (`ensureDraft`), so a fresh workflow has none and the
     * editor opens on "No changes yet" rather than on a Draft badge and a
     * Discard button for nothing. Item workflows only: the order workflow is
     * the schema's singleton.
     */
    readonly createWorkflow: (
      input: Domain.CreateWorkflowInput,
    ) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNameTakenError
      | WorkflowLimitError
    >;
    /**
     * A copy of the workflow: {@link copyName}, its steps with their stages
     * under new ids, off, with **no product tags** and no draft.
     *
     * Tags are deliberately not copied. Matching is per workflow with no
     * arbitration (`WorkflowRunRepository.matchesLineItem`), so a copy
     * carrying the original's tags would start a second, near-identical run
     * on the same line item the moment it was turned on. Leaving them empty
     * puts the one decision the merchant has to make in front of them
     * instead: the copy's trigger line says it never starts until it has a
     * tag. The order workflow singleton refuses.
     */
    readonly duplicateWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowNameTakenError
      | WorkflowLimitError
      | SingletonWorkflowError
    >;
    /** Rename only; immediate, since runs snapshot the name. `type` is not editable. The order workflow singleton refuses. */
    readonly updateWorkflow: (input: {
      readonly workflowId: string;
      readonly name: Domain.WorkflowName;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNameTakenError
      | WorkflowNotFoundError
      | SingletonWorkflowError
    >;
    /** Writes `tags` on the draft, creating it if this is the first change. Non-empty tags on an order workflow are refused. */
    readonly updateWorkflowTags: (input: {
      readonly workflowId: string;
      readonly tags: Domain.WorkflowTags;
    }) => Effect.Effect<
      Domain.WorkflowDraft,
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
    >;
    /**
     * The on/off switch. On requires: at least one step, every step assigned
     * to a team in `teams`; it writes `activatedAt = activatedAt ?? now`, the
     * coverage date every later reconcile compares orders against (the
     * caller passes an earlier date when the merchant chose to include
     * waiting orders). A team with no members does not refuse. Off writes
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
     * otherwise inserts a draft with the workflow's tags and a copy of every
     * workflow step under a new id, in one transaction. The editor does not
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
     * Replaces the workflow's tags and steps with the draft's and deletes the
     * draft, in one transaction: an order sees the old definition or the new
     * one, never a half-edit. Refused with no draft, an empty draft, or an
     * unassigned step, on and off alike. Does not touch `activatedAt`: the
     * workflow stays responsible for the orders it was responsible for, and
     * the caller reconciles them against the new definition. Draft step
     * ids carry over to the workflow.
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

      /** The singleton has a fixed name, no delete, and no copy; the id alone decides, so nothing is read. */
      const requireNotSingleton = (workflowId: string) =>
        workflowId === Domain.ORDER_WORKFLOW_ID
          ? Effect.fail(new SingletonWorkflowError({ workflowId }))
          : Effect.void;

      /**
       * Only `updateWorkflowTags` needs this: it is the one write that takes
       * tags for a workflow whose kind the input cannot know. Create is
       * item-only, and Apply copies a draft this guard already vetted; the
       * SQL check on `Workflow.tags` backstops both.
       */
      const requireNoTagsForOrderWorkflow = (
        type: Domain.WorkflowType,
        tags: Domain.WorkflowTags,
      ) =>
        type === "order" && tags.length > 0
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
        readonly tags: Domain.WorkflowTags;
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
       * anywhere. So step and tag writes come through here instead of
       * refusing with `NoDraftError`, and a draft that did not exist starts
       * as a copy of the workflow — its tags, and every step **under the
       * step's own id**. That identity is what lets the editor edit a step it
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
          const workflow = yield* requireWorkflow(workflowId);
          const existing = yield* findDraft(workflowId);
          if (Option.isSome(existing)) return existing.value;
          const draft = yield* insertDraft({
            workflowId,
            tags: workflow.type === "order" ? [] : workflow.tags,
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

      return WorkflowRepository.of({
        listWorkflows: Effect.fn("WorkflowRepository.listWorkflows")(
          function* ({
            teams,
            type,
          }: {
            readonly teams: Teams;
            readonly type?: Domain.WorkflowType;
          }) {
            const rows = yield* decode(
              Schema.Array(Domain.WorkflowSummaryRow),
              "Invalid WorkflowSummary row",
            )(
              yield* sql`
                select w.*,
                  exists (select 1 from WorkflowDraft d where d.workflowId = w.id) as hasDraft,
                  (select count(*) from WorkflowStep s where s.workflowId = w.id) as stepCount
                from Workflow w
                where ${type === undefined ? sql`1 = 1` : sql`w.type = ${type}`}
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
            yield* requireNotSingleton(workflowId);
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

        getOrderWorkflow: Effect.fn("WorkflowRepository.getOrderWorkflow")(
          function* () {
            const workflow = yield* requireWorkflow(
              Domain.ORDER_WORKFLOW_ID,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkflowRepositoryError({
                    message: "The order workflow singleton is missing",
                    cause,
                  }),
              ),
            );
            return {
              workflow,
              steps: yield* workflowSteps(workflow.id),
            } satisfies Domain.WorkflowDetail;
          },
        ),

        /**
         * A fixture's `steps` become the workflow's steps, switched on
         * (`activatedAt = now`, so orders seeded afterwards qualify) unless
         * `active: false` or a step is unassigned. A fixture with no steps and
         * no `draft` has no draft either, the state `createWorkflow` leaves a
         * fresh workflow in. `draft` seeds a pending draft beside the
         * workflow. The `type: "order"` entry updates the singleton in place
         * rather than inserting: its steps, draft, and switch are rewritten,
         * and its `name` is ignored (a warning when it differs).
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
                : {
                    tags: workflow.draft.tags ?? workflow.tags,
                    steps: stage(workflow.draft.steps),
                  };
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
            // The invariants the ordinary write path enforces that a fixture
            // could otherwise silently break.
            const taggedOrder = staged.find(
              (workflow) =>
                workflow.type === "order" &&
                (workflow.tags.length > 0 ||
                  (workflow.draft?.tags.length ?? 0) > 0),
            );
            if (taggedOrder !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${taggedOrder.name}: an order workflow has no tags`,
                cause: taggedOrder.tags,
              });
            const orderWorkflows = staged.filter(
              (workflow) => workflow.type === "order",
            );
            if (orderWorkflows.length > 1)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: ${String(orderWorkflows.length)} order workflows; at most one`,
                cause: orderWorkflows.map((workflow) => workflow.name),
              });
            const badActive = staged.find(
              (workflow) => workflow.active && workflow.steps.length === 0,
            );
            if (badActive !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${badActive.name}: an active workflow needs steps`,
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
            const orderEntry = orderWorkflows[0];
            if (
              orderEntry !== undefined &&
              orderEntry.name !== Domain.ORDER_WORKFLOW_NAME
            )
              yield* Effect.logWarning(
                `WorkflowRepository.replaceWorkflows: workflow=${orderEntry.name}: the order workflow's name is fixed; fixture name ignored`,
              ).pipe(Effect.annotateLogs({ workflow: orderEntry.name }));
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`delete from WorkflowRun`;
                yield* sql`delete from Workflow where type = 'item'`;
                // The singleton is rewritten in place: its steps and draft
                // go (draft steps cascade), then the fixture's are written,
                // or nothing when the fixture has no order entry.
                yield* sql`delete from WorkflowStep where workflowId = ${Domain.ORDER_WORKFLOW_ID}`;
                yield* sql`delete from WorkflowDraft where workflowId = ${Domain.ORDER_WORKFLOW_ID}`;
                yield* sql`
                  update Workflow
                  set activatedAt = ${orderEntry?.active ? now : null}, updatedAt = ${now}
                  where id = ${Domain.ORDER_WORKFLOW_ID}
                `;
                for (const workflow of staged) {
                  const workflowId =
                    workflow.type === "order"
                      ? Domain.ORDER_WORKFLOW_ID
                      : crypto.randomUUID();
                  if (workflow.type !== "order")
                    yield* sql`
                      insert into Workflow
                        (id, name, type, activatedAt, tags, createdAt, updatedAt)
                      values
                        (${workflowId}, ${workflow.name}, 'item', ${workflow.active ? now : null}, ${json(workflow.tags)}, ${now}, ${now})
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
         * exactly "taken".
         */
        createWorkflow: Effect.fn("WorkflowRepository.createWorkflow")(
          function* ({ name, tags }: Domain.CreateWorkflowInput) {
            const open = yield* count(sql`select count(*) from Workflow`);
            if (open >= Domain.WorkflowLimits.maxWorkflows)
              return yield* new WorkflowLimitError({
                limit: Domain.WorkflowLimits.maxWorkflows,
              });
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                insert or ignore into Workflow
                  (id, name, type, activatedAt, tags, createdAt, updatedAt)
                values
                  (${crypto.randomUUID()}, ${name}, 'item', null, ${json(tags)}, ${now}, ${now})
                returning *
              `,
            );
            return workflow ?? (yield* new WorkflowNameTakenError({ name }));
          },
        ),

        duplicateWorkflow: Effect.fn("WorkflowRepository.duplicateWorkflow")(
          function* ({ workflowId }: { readonly workflowId: string }) {
            yield* requireNotSingleton(workflowId);
            const source = yield* requireWorkflow(workflowId);
            const open = yield* count(sql`select count(*) from Workflow`);
            if (open >= Domain.WorkflowLimits.maxWorkflows)
              return yield* new WorkflowLimitError({
                limit: Domain.WorkflowLimits.maxWorkflows,
              });
            const taken = yield* sql`select name from Workflow`.pipe(
              Effect.map((rows) => rows.map((row) => String(row.name))),
            );
            /** Trimmed to fit and non-empty by construction; the decode is what carries the brand. */
            const name = yield* Schema.decodeUnknownEffect(Domain.WorkflowName)(
              copyName(source.name, taken),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkflowRepositoryError({
                    message: "Duplicate produced an invalid workflow name",
                    cause,
                  }),
              ),
            );
            const steps = yield* workflowSteps(workflowId);
            const now = yield* Clock.currentTimeMillis;
            const copyId = crypto.randomUUID();
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    insert or ignore into Workflow
                      (id, name, type, activatedAt, tags, createdAt, updatedAt)
                    values
                      (${copyId}, ${name}, ${source.type}, null, '[]', ${now}, ${now})
                    returning *
                  `,
                );
                if (workflow === undefined)
                  return yield* new WorkflowNameTakenError({ name });
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
            yield* requireNotSingleton(workflowId);
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
            readonly tags: Domain.WorkflowTags;
          }) {
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const existing = yield* requireWorkflow(workflowId);
                yield* requireNoTagsForOrderWorkflow(existing.type, tags);
                yield* ensureDraft(workflowId);
                const now = yield* Clock.currentTimeMillis;
                const [draft] = yield* decodeDrafts(
                  yield* sql`
                    update WorkflowDraft set tags = ${json(tags)}, updatedAt = ${now}
                    where workflowId = ${workflowId}
                    returning *
                  `,
                );
                return (
                  draft ??
                  (yield* new WorkflowRepositoryError({
                    message: "WorkflowDraft update returned no row",
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
            if (active) {
              yield* requireStartableSteps(
                workflowId,
                yield* workflowSteps(workflowId),
                teams,
              );
            }
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
              const draft = yield* requireDraft(workflowId);
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

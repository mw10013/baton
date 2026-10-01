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

export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { workflowId: Schema.String },
) {}

/**
 * A tag another workflow already carries, on or off. The tag is the
 * workflow's key — the one string a product can carry that names it — and the
 * `unique` on `Workflow.tag` is the rule. This error exists so the refusal can
 * name the holder and the merchant is told which field to change, at the
 * moment they typed it: Create, Duplicate, and Edit tag. The holder's name is
 * enough to identify it, because names are unique too
 * ({@link WorkflowNameTakenError}).
 */
export class WorkflowTagTakenError extends Schema.TaggedError<WorkflowTagTakenError>()(
  "WorkflowTagTakenError",
  {
    tag: Domain.WorkflowTag,
    workflowName: Domain.WorkflowName,
  },
) {}

/**
 * A name another workflow already has, on or off, compared exactly. The name
 * is the label merchants and members pick a workflow by — members never see
 * the tag — so no two workflows share one, and the `unique` on
 * `Workflow.name` is the rule. This error exists so the refusal lands under
 * the name field at Create, Duplicate, and Rename rather than as a raw
 * constraint failure.
 */
export class WorkflowNameTakenError extends Schema.TaggedError<WorkflowNameTakenError>()(
  "WorkflowNameTakenError",
  { name: Domain.WorkflowName },
) {}

/** A task id the editor sent that neither the draft nor the workflow carries — a task some other tab already removed, or a stale id. */
export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFoundError",
  { taskId: Schema.String },
) {}

/** `addTask` named a step no task of the draft is in. */
export class StepNotFoundError extends Schema.TaggedError<StepNotFoundError>()(
  "StepNotFoundError",
  { workflowId: Schema.String, step: Schema.Number },
) {}

export class WorkflowLimitError extends Schema.TaggedError<WorkflowLimitError>()(
  "WorkflowLimitError",
  { limit: Schema.Number },
) {}

/**
 * Apply or Discard without a draft: there is nothing to promote or throw
 * away. Task and tag writes never raise this — they create the draft they
 * need (see `ensureDraft`).
 */
export class NoDraftError extends Schema.TaggedError<NoDraftError>()(
  "NoDraftError",
  { workflowId: Schema.String },
) {}

export class NoTasksError extends Schema.TaggedError<NoTasksError>()(
  "NoTasksError",
  { workflowId: Schema.String },
) {}

/**
 * Apply or turn-on refused because these tasks are unassigned: `teamId` null
 * (a team delete nulled it) or an id the shop's live teams does not carry (the
 * cross-store window, read as null). An empty team is deliberately not here —
 * that is a warning, never a refusal.
 */
export class TaskUnassignedError extends Schema.TaggedError<TaskUnassignedError>()(
  "TaskUnassignedError",
  { workflowId: Schema.String, taskNames: Schema.Array(Domain.TaskName) },
) {}

/** Seed fixtures carry positions and steps but no ids; the index stands in. */
const validLayout = (
  tasks: readonly { readonly position: number; readonly step: number }[],
) =>
  WorkflowLayout.layoutIsValid(
    tasks.map((task, index) => ({
      id: String(index),
      position: task.position,
      step: task.step,
    })),
  );

const count = (query: Statement.Statement<SqlConnection.Row>) =>
  query.values.pipe(Effect.map((rows) => Number(rows[0]?.[0] ?? 0)));

/** The shop's teams, read live from D1 as the object passes it in; `memberCount` only matters to `emptyTeam`. */
type Teams = readonly {
  readonly id: Domain.TeamId;
  readonly memberCount?: number;
}[];

/** Unassigned: `teamId` null, or an id no team in `teams` carries. */
const taskIsUnassigned = (task: Domain.WorkflowTask, teams: Teams) =>
  task.teamId === null || !teams.some((team) => team.id === task.teamId);

/** The names of the unassigned `tasks`, in position order. */
const unassignedTaskNames = (
  tasks: readonly Domain.WorkflowTask[],
  teams: Teams,
) =>
  tasks
    .filter((task) => taskIsUnassigned(task, teams))
    .map((task) => task.name);

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  {
    /**
     * `teams` is the shop's live teams: `unassigned` and `emptyTeam` are derived
     * per row from the workflow's tasks against it and never stored.
     * {@link Domain.WorkflowSummary} carries them.
     */
    readonly listWorkflows: (input: {
      readonly teams: Teams;
    }) => Effect.Effect<
      readonly Domain.WorkflowSummary[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Deletes the definition only: what goes and what survives is the data
     * model on `initializeSchema` (`ShopAgentSchema.ts`). No read joins a run
     * back to `Workflow`, so an orphan run renders, lists, starts, marks
     * done, blocks, and cancels unchanged. No turn-off-first rule.
     */
    readonly deleteWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      void,
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
    >;
    /** The workflow with its tasks, and the draft with its tasks when one exists. */
    readonly getWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowWithDraft>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Every switched-on workflow with its tasks, in two statements rather
     * than one per workflow: this is what an order upsert
     * loads before creating runs for its items, and a bulk stream loads
     * it once for thousands of orders. Drafts are invisible here by
     * construction — nothing in run creation reads `WorkflowDraft*`.
     */
    readonly listOnWorkflowDetails: () => Effect.Effect<
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
     * `Run` needs its own delete: a run references no workflow (the data
     * model on `initializeSchema`, `ShopAgentSchema.ts`), so nothing cascades
     * from the `Workflow` delete to it.
     *
     * Bypasses the limit and team checks the ordinary write path
     * enforces: positions come from array order and `teamId` from `Team` rows
     * the caller created moments earlier, so there is nothing left to race.
     * The Durable Object gates the callable on `ENVIRONMENT === "local"`.
     */
    readonly replaceWorkflows: (
      input: Domain.SeedWorkflowsInput,
    ) => Effect.Effect<
      readonly { readonly name: Domain.WorkflowName; readonly id: string }[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * Inserts the workflow: off, no tasks, carrying its tag, and **no draft**.
     * The draft is the editor's record of unsaved changes and is created by
     * the first change (`ensureDraft`), so a fresh workflow has none and the
     * editor opens without a Discard button for nothing. The name, then the
     * tag, is checked before the insert so the dialog can put the refusal
     * under the field that caused it.
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
     * A copy of the workflow's tasks, with their steps under new ids, under
     * the name and tag the merchant chose in the Duplicate dialog; off, with
     * no draft. The name, then the tag, is checked before the insert, as in
     * `createWorkflow`.
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
    /** Rename only; immediate, since runs snapshot the name. Refuses a name another workflow has. */
    readonly updateWorkflow: (input: {
      readonly workflowId: string;
      readonly name: Domain.WorkflowName;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowNameTakenError
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
     * The on/off switch. On requires: at least one task, every task assigned
     * to a team in `teams`; it writes `state = 'on'`. A team with no members
     * does not refuse. Tags are not
     * its business: every workflow's tag is unique from birth, so the switch
     * can never collide with one. Off writes
     * `state = 'off'` and touches nothing else: open runs are days of
     * physical work and keep going; only new runs stop. Neither direction
     * creates, applies, or discards a draft, or looks at whether one exists.
     */
    readonly setWorkflowOn: (input: {
      readonly workflowId: string;
      readonly on: boolean;
      readonly teams: Teams;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoTasksError
      | TaskUnassignedError
    >;
    /**
     * The draft, made explicitly. Returns the existing one when there is one;
     * otherwise inserts a draft with a copy of every workflow task under a
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
     * Replaces the workflow's tasks with the draft's and deletes the draft, in
     * one transaction: an order sees the old definition or the new one, never
     * a half-edit. Refused with no draft, an empty draft, or an unassigned
     * task, on and off alike. The tag is not drafted, so Apply never reads or
     * writes it. Does not touch `state`: the workflow stays on or off, and
     * the caller reconciles the orders
     * against the new definition. Draft task ids carry over to the workflow.
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
      | NoTasksError
      | TaskUnassignedError
    >;
    /**
     * Apply and Turn on in one transaction, for the editor's Turn on on a
     * workflow that has never been applied: promoting tasks that have never
     * run and then switching the workflow on are one decision, and doing them
     * as two calls leaves a window where the first succeeded and the second
     * did not. An absent draft is not a refusal here — there is simply nothing
     * to promote, and the eligibility check on the workflow's own tasks then
     * decides. Otherwise the same rules as {@link applyDraft} and
     * {@link setWorkflowOn}.
     */
    readonly applyAndTurnOn: (input: {
      readonly workflowId: string;
      readonly teams: Teams;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoTasksError
      | TaskUnassignedError
    >;
    /** Deletes the draft (tasks cascade). Always allowed; a never-applied workflow is left with zero tasks. */
    readonly discardDraft: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Domain.Workflow,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | NoDraftError
    >;
    /** New task in a new last step of the draft, creating the draft if this is the first change. */
    readonly addStep: (input: {
      readonly workflowId: string;
      readonly name: Domain.TaskName;
      readonly teamId: Domain.TeamId;
      readonly instructions?: Domain.TaskInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowDraftTask,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowLimitError
    >;
    /** New task into an existing `step` of the draft, after that step's last task. */
    readonly addTask: (input: {
      readonly workflowId: string;
      readonly step: number;
      readonly name: Domain.TaskName;
      readonly teamId: Domain.TeamId;
      readonly instructions?: Domain.TaskInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowDraftTask,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowLimitError
      | StepNotFoundError
    >;
    /**
     * A task the editor can act on, with its workflow: the draft's row when
     * there is a draft, otherwise the workflow's own — the same id either way
     * (`ensureDraft`). A read, so it creates nothing.
     */
    readonly getTask: (input: { readonly taskId: string }) => Effect.Effect<
      Option.Option<{
        readonly task: Domain.WorkflowDraftTask;
        readonly workflow: Domain.Workflow;
      }>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The task-id writes below all land on the draft, creating it from the
     * workflow when this is the first change (`requireEditableTask`).
     * `instructions: null` clears.
     */
    readonly updateTask: (input: {
      readonly taskId: string;
      readonly name: Domain.TaskName;
      readonly teamId: Domain.TeamId;
      readonly instructions: Domain.TaskInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowDraftTask,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | TaskNotFoundError
    >;
    /**
     * The moved task always ends alone in its step; other tasks keep their
     * step-mates. A move past either edge is a no-op, not an error.
     */
    readonly moveTask: (input: {
      readonly taskId: string;
      readonly direction: Domain.TaskDirection;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | TaskNotFoundError
    >;
    /** The task leaves its step into a new one of its own right after it; no-op when already alone. */
    readonly separateTask: (input: {
      readonly taskId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | TaskNotFoundError
    >;
    /**
     * The task joins the previous step, last among its members; no-op in
     * step 1. Lands on the draft, creating it on first change, like every
     * task-id write.
     */
    readonly joinTask: (input: {
      readonly taskId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | TaskNotFoundError
    >;
    readonly removeTask: (input: {
      readonly taskId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | TaskNotFoundError
    >;
    /**
     * What a team delete would change, per team: workflow tasks, draft tasks,
     * and undone tasks of open runs. The delete also nulls the pointer on done
     * and closed tasks, but those read their `teamName` snapshot, so nothing
     * a person sees changes and they are not counted. Feeds the delete
     * dialogs, never a refusal. Teams that own nothing are absent.
     */
    readonly countTasksByTeam: () => Effect.Effect<
      readonly Domain.TeamTaskCounts[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    readonly listTeamWorkflows: (input: {
      readonly teamId: string;
    }) => Effect.Effect<
      readonly Domain.TeamWorkflow[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /** {@link listTeamWorkflows} for every team at once; the teams index's "Used by" column. */
    readonly listAllTeamWorkflows: () => Effect.Effect<
      readonly Domain.TeamWorkflowByTeam[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The object-side half of a team delete: every workflow task, draft task
     * and run task that points at `teamId` becomes unassigned, in one
     * transaction, done or not and whatever the run's state. A run task
     * keeps its `teamName` snapshot, which is all history reads; the pointer
     * on a done or closed task had no reader once the team was gone, because
     * every team-scoped list takes its team ids from D1 (the data model on
     * `initializeSchema`, `ShopAgentSchema.ts`). Idempotent, so a
     * retry after a failed first attempt (D1 row already gone) still cleans
     * up. Touches `RunTask` from here
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
      const decodeTasks = decode(
        Schema.Array(Domain.WorkflowTask),
        "Invalid WorkflowTask row",
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

      const findDraftTask = (taskId: string) =>
        sql`select * from WorkflowDraftTask where id = ${taskId}`.pipe(
          Effect.flatMap(decodeTasks),
          Effect.map(([task]) => Option.fromUndefinedOr(task)),
        );

      const requireDraftTask = (taskId: string) =>
        findDraftTask(taskId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new TaskNotFoundError({ taskId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const findWorkflowTask = (taskId: string) =>
        sql`select * from WorkflowTask where id = ${taskId}`.pipe(
          Effect.flatMap(decodeTasks),
          Effect.map(([task]) => Option.fromUndefinedOr(task)),
        );

      const workflowTasks = (workflowId: string) =>
        sql`
          select * from WorkflowTask
          where workflowId = ${workflowId}
          order by position
        `.pipe(Effect.flatMap(decodeTasks));

      const draftTasks = (workflowId: string) =>
        sql`
          select * from WorkflowDraftTask
          where workflowId = ${workflowId}
          order by position
        `.pipe(Effect.flatMap(decodeTasks));

      const countDraftTasks = (workflowId: string) =>
        count(
          sql`select count(*) from WorkflowDraftTask where workflowId = ${workflowId}`,
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
              insert into WorkflowDraft (workflowId, updatedAt)
              values (${workflowId}, ${now})
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

      const insertDraftTaskRow = ({
        id,
        workflowId,
        position,
        step,
        name,
        teamId,
        instructions,
      }: {
        /** The workflow task's id when the draft is copying it, so a task keeps one identity; a new one otherwise. */
        readonly id?: string;
        readonly workflowId: string;
        readonly position: Statement.Fragment;
        readonly step: Statement.Fragment;
        readonly name: Domain.TaskName;
        readonly teamId: Domain.TeamId | null;
        readonly instructions: Domain.TaskInstructions | null;
      }) =>
        Effect.gen(function* () {
          const [task] = yield* decodeTasks(
            yield* sql`
              insert into WorkflowDraftTask
                (id, workflowId, position, step, name, teamId, instructions)
              values (
                ${id ?? crypto.randomUUID()}, ${workflowId}, ${position}, ${step},
                ${name}, ${teamId}, ${instructions}
              )
              returning *
            `,
          );
          return (
            task ??
            (yield* new WorkflowRepositoryError({
              message: "WorkflowDraftTask insert returned no row",
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
       * anywhere. So task writes come through here instead of refusing with
       * `NoDraftError`, and a draft that did not exist starts as a copy of
       * the workflow's tasks, each **under the task's own id**. The tag is
       * not drafted. That identity is what lets the editor edit a task it
       * is looking at before any draft exists: the id it sends names the
       * workflow task now and the draft's copy of it a moment later, and
       * Apply carries the same ids back (see `requireEditableTask`).
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
            yield* workflowTasks(workflowId),
            (task) =>
              insertDraftTaskRow({
                id: task.id,
                workflowId,
                position: sql`${task.position}`,
                step: sql`${task.step}`,
                name: task.name,
                teamId: task.teamId,
                instructions: task.instructions,
              }),
            { discard: true },
          );
          return draft;
        });

      /**
       * The draft row a task-id write targets. Until a draft exists the
       * editor is looking at the workflow's own tasks, so the id it sends is
       * a workflow task's: that write is the first change, and `ensureDraft`
       * copies the tasks under their own ids, so the same id names the
       * draft's copy immediately afterwards. An id neither table carries is
       * `TaskNotFoundError` as before — including a task this draft has
       * already removed.
       */
      const requireEditableTask = (taskId: string) =>
        Effect.gen(function* () {
          const drafted = yield* findDraftTask(taskId);
          if (Option.isSome(drafted)) return drafted.value;
          const live = yield* findWorkflowTask(taskId);
          if (Option.isNone(live))
            return yield* new TaskNotFoundError({ taskId });
          yield* ensureDraft(live.value.workflowId);
          return yield* requireDraftTask(taskId);
        });

      const touchDraft = (workflowId: string, now: number) =>
        sql`update WorkflowDraft set updatedAt = ${now} where workflowId = ${workflowId}`;

      const layoutOf = (workflowId: string) =>
        sql`
          select id, position, step from WorkflowDraftTask
          where workflowId = ${workflowId}
          order by position
        `.pipe(
          Effect.flatMap(
            decode(
              Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  position: Schema.Number,
                  step: Schema.Number,
                }),
              ),
              "Invalid WorkflowDraftTask layout row",
            ),
          ),
        );

      /**
       * Persists a whole draft layout. `unique (workflowId, position)`
       * forbids in-place renumbering (a +1 shift collides row by row), so
       * every task first parks at `-position`, then takes its final position
       * and step. Plain statements, no transaction of its own: callers wrap
       * it, and `removeTask` composes a delete in front of it, because
       * `@effect/sql-sqlite-do` backs `withTransaction` with
       * `storage.transaction` and Durable Object SQLite refuses to nest.
       */
      const writeLayout = (workflowId: string, layout: WorkflowLayout.Layout) =>
        Effect.gen(function* () {
          yield* sql`update WorkflowDraftTask set position = -position where workflowId = ${workflowId}`;
          yield* Effect.forEach(
            layout,
            (p) =>
              sql`update WorkflowDraftTask set position = ${p.position}, step = ${p.step} where id = ${p.id}`,
            { discard: true },
          );
        });

      /** Finds the draft task, then rewrites its draft's layout with `edit` applied, in one transaction. */
      const relayout = (
        taskId: string,
        edit: (layout: WorkflowLayout.Layout) => WorkflowLayout.Layout,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const task = yield* requireEditableTask(taskId);
            const layout = yield* layoutOf(task.workflowId);
            yield* writeLayout(task.workflowId, edit(layout));
            yield* touchDraft(task.workflowId, yield* Clock.currentTimeMillis);
          }),
        );

      /** Shared by `addStep` and `addTask`: the draft (created if this is the first change), the task ceiling, and the insert itself. */
      const insertTask = ({
        workflowId,
        position,
        step,
        name,
        teamId,
        instructions,
      }: {
        readonly workflowId: string;
        readonly position: Statement.Fragment;
        readonly step: Statement.Fragment;
        readonly name: Domain.TaskName;
        readonly teamId: Domain.TeamId;
        readonly instructions: Domain.TaskInstructions | null;
      }) =>
        Effect.gen(function* () {
          yield* ensureDraft(workflowId);
          if (
            (yield* countDraftTasks(workflowId)) >=
            Domain.WorkflowLimits.maxTasks
          )
            return yield* new WorkflowLimitError({
              limit: Domain.WorkflowLimits.maxTasks,
            });
          const task = yield* insertDraftTaskRow({
            workflowId,
            position,
            step,
            name,
            teamId,
            instructions,
          });
          yield* touchDraft(workflowId, yield* Clock.currentTimeMillis);
          return task;
        });

      /** Apply and turn-on share the content checks: at least one task, every task assigned. */
      const requireEligibleTasks = (
        workflowId: string,
        tasks: readonly Domain.WorkflowTask[],
        teams: Teams,
      ) =>
        Effect.gen(function* () {
          if (tasks.length === 0)
            return yield* new NoTasksError({ workflowId });
          const taskNames = unassignedTaskNames(tasks, teams);
          if (taskNames.length > 0)
            return yield* new TaskUnassignedError({ workflowId, taskNames });
          return tasks;
        });

      /**
       * The Apply write itself, with neither the transaction nor the question
       * of whether a draft exists: the draft's tasks replace the workflow's,
       * the draft goes, and `updatedAt` moves so "Last updated on" reflects
       * the Apply. Shared by `applyDraft` and `applyAndTurnOn`, which ask
       * that question differently — Apply refuses without a draft, while the
       * editor's Turn on on a never-applied workflow simply has nothing to
       * promote. The tag is not drafted, so nothing here reads or writes it.
       */
      const promoteDraft = (workflowId: string, teams: Teams) =>
        Effect.gen(function* () {
          const tasks = yield* draftTasks(workflowId);
          yield* requireEligibleTasks(workflowId, tasks, teams);
          const now = yield* Clock.currentTimeMillis;
          yield* sql`delete from WorkflowTask where workflowId = ${workflowId}`;
          yield* sql`
            insert into WorkflowTask
              (id, workflowId, position, step, name, teamId, instructions)
            select id, workflowId, position, step, name, teamId, instructions
            from WorkflowDraftTask
            where workflowId = ${workflowId}
          `;
          const [workflow] = yield* decodeWorkflows(
            yield* sql`
              update Workflow
              set updatedAt = ${now}
              where id = ${workflowId}
              returning *
            `,
          );
          yield* sql`delete from WorkflowDraft where workflowId = ${workflowId}`;
          return workflow ?? (yield* new WorkflowNotFoundError({ workflowId }));
        });

      const decodeHolders = decode(
        Schema.Array(Schema.Struct({ name: Domain.WorkflowName })),
        "Invalid Workflow holder row",
      );

      /**
       * Refuses `name` if another workflow has it, excluding `workflowId` so
       * a rename may keep the workflow's own name. The `unique` on
       * `Workflow.name` is the guarantee; this select exists so the refusal
       * is typed and lands under the name field. Names are compared exactly,
       * as typed (`Domain.WorkflowName` trims and nothing else). Same
       * transaction reasoning as {@link requireTagFree}.
       */
      const requireNameFree = (
        name: Domain.WorkflowName,
        workflowId: string | null,
      ) =>
        Effect.gen(function* () {
          const [holder] = yield* decodeHolders(
            yield* sql`
              select name from Workflow
              where name = ${name}
                and (${workflowId} is null or id <> ${workflowId})
            `,
          );
          if (holder !== undefined) yield* new WorkflowNameTakenError({ name });
        });

      /**
       * Which workflow, if any, already holds `tag`, excluding `workflowId` so
       * a retag may keep the workflow's own tag. The `unique` on
       * `Workflow.tag` is the guarantee; this select exists so the refusal can
       * name the holder, which a constraint failure cannot. Tags are stored
       * folded (`Domain.WorkflowTag` trims and lowercases), so plain equality
       * is the whole comparison — the same equality
       * `RunRepository.matchesTag` uses. Runs inside the caller's
       * transaction on the Durable Object's synchronous SQLite, so nothing can
       * interleave between it and the write that follows. The holder's name
       * rides back so the merchant can decide whether to change this tag or
       * go retag the other workflow; the name identifies it, since no two
       * workflows share one.
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
                  (select coalesce(max(t.step), 0) from WorkflowTask t where t.workflowId = w.id) as stepCount
                from Workflow w
                order by w.name
              `,
            );
            // Derived, never stored: the badges are computed from the workflow's
            // tasks against the teams on every list read, so assigning a
            // team or adding a member clears it with no other write.
            const tasks = yield* decodeTasks(
              yield* sql`select * from WorkflowTask order by workflowId, position`,
            );
            const emptyTeam = (task: Domain.WorkflowTask) =>
              teams.some(
                (team) => team.id === task.teamId && team.memberCount === 0,
              );
            return rows.map((row): Domain.WorkflowSummary => ({
              ...row,
              unassigned: tasks.some(
                (task) =>
                  task.workflowId === row.id && taskIsUnassigned(task, teams),
              ),
              emptyTeam: tasks.some(
                (task) => task.workflowId === row.id && emptyTeam(task),
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
            tasks: yield* workflowTasks(workflowId),
            draft: Option.isNone(draft)
              ? null
              : { draft: draft.value, tasks: yield* draftTasks(workflowId) },
          } satisfies Domain.WorkflowWithDraft);
        }),

        listOnWorkflowDetails: Effect.fn(
          "WorkflowRepository.listOnWorkflowDetails",
        )(function* () {
          const workflows = yield* decodeWorkflows(
            yield* sql`
              select * from Workflow
              where state = 'on'
              order by name
            `,
          );
          const tasks = yield* decodeTasks(
            yield* sql`
              select s.* from WorkflowTask s
              join Workflow w on w.id = s.workflowId
              where w.state = 'on'
              order by s.workflowId, s.position
            `,
          );
          return workflows.map((workflow): Domain.WorkflowDetail => ({
            workflow,
            tasks: tasks.filter((task) => task.workflowId === workflow.id),
          }));
        }),

        /**
         * A fixture's `tasks` become the workflow's tasks, switched on
         * (`state = 'on'`) unless
         * `on: false` or a task is unassigned. A fixture with no tasks and
         * no `draft` has no draft either, the state `createWorkflow` leaves a
         * fresh workflow in. `draft` seeds a pending draft beside the
         * workflow.
         *
         * Returns each workflow's minted id beside its name: this is the only
         * write path that creates workflows without the caller naming them one
         * at a time, and the seed's items have to be able to point at one.
         */
        replaceWorkflows: Effect.fn("WorkflowRepository.replaceWorkflows")(
          function* ({ workflows }: Domain.SeedWorkflowsInput) {
            const now = yield* Clock.currentTimeMillis;
            type SeedTask =
              Domain.SeedWorkflowsInput["workflows"][number]["tasks"][number];
            // A task with no `step` follows the previous one (linear); the
            // layout is checked before anything is written so a bad fixture
            // fails whole rather than half-seeding.
            const step = (tasks: readonly SeedTask[]) =>
              tasks.reduce<
                readonly (SeedTask & {
                  readonly position: number;
                  readonly step: number;
                })[]
              >((acc, task, index) => {
                const previous = acc[index - 1]?.step ?? 0;
                return [
                  ...acc,
                  {
                    ...task,
                    position: index + 1,
                    step: task.step ?? previous + 1,
                  },
                ];
              }, []);
            const draftOf = (
              workflow: Domain.SeedWorkflowsInput["workflows"][number],
            ) =>
              workflow.draft === undefined
                ? null
                : { tasks: step(workflow.draft.tasks) };
            const staged = workflows.map((workflow) => ({
              ...workflow,
              tasks: step(workflow.tasks),
              draft: draftOf(workflow),
              on:
                workflow.on ??
                (workflow.tasks.length > 0 &&
                  workflow.tasks.every((task) => task.teamId !== null)),
            }));
            const invalid = staged.find(
              (workflow) =>
                !validLayout(workflow.tasks) ||
                (workflow.draft !== null && !validLayout(workflow.draft.tasks)),
            );
            if (invalid !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${invalid.name}: steps must be dense from 1 and non-decreasing`,
                cause: invalid.tasks.map((task) => task.step),
              });
            // The invariants the ordinary write path enforces that a fixture
            // could otherwise silently break.
            const onWithoutTasks = staged.find(
              (workflow) => workflow.on && workflow.tasks.length === 0,
            );
            if (onWithoutTasks !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${onWithoutTasks.name}: a workflow that is on needs tasks`,
                cause: onWithoutTasks.name,
              });
            // Mirrors `SwitchResult.TaskUnassigned`: on with a task nobody
            // owns is a workflow the list shows as On that creates nothing.
            const onWithUnassigned = staged.find(
              (workflow) =>
                workflow.on &&
                workflow.tasks.some((task) => task.teamId === null),
            );
            if (onWithUnassigned !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${onWithUnassigned.name}: a workflow that is on needs every task assigned`,
                cause: onWithUnassigned.name,
              });
            if (staged.length > Domain.WorkflowLimits.maxWorkflows)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflows=${String(staged.length)}: at most ${String(Domain.WorkflowLimits.maxWorkflows)} workflows`,
                cause: staged.length,
              });
            const overTasks = staged.find(
              (workflow) =>
                workflow.tasks.length > Domain.WorkflowLimits.maxTasks ||
                (workflow.draft?.tasks.length ?? 0) >
                  Domain.WorkflowLimits.maxTasks,
            );
            if (overTasks !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${overTasks.name}: at most ${String(Domain.WorkflowLimits.maxTasks)} tasks`,
                cause: overTasks.name,
              });
            // `Workflow.tag` is unique, so a fixture repeating a tag would
            // fail as a bare constraint error naming no workflow. Seeds are
            // trusted, so this refuses loudly instead.
            const duplicateName = staged.find(
              (workflow, index) =>
                staged.findIndex((other) => other.name === workflow.name) <
                index,
            );
            if (duplicateName !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${duplicateName.name}: two workflows cannot share a name`,
                cause: duplicateName.name,
              });
            const duplicateTag = staged.find(
              (workflow, index) =>
                staged.findIndex((other) => other.tag === workflow.tag) < index,
            );
            if (duplicateTag !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${duplicateTag.name} tag=${duplicateTag.tag}: two workflows cannot share a tag`,
                cause: duplicateTag.tag,
              });
            const writeTasks = (
              table: Statement.Fragment,
              workflowId: string,
              tasks: ReturnType<typeof step>,
            ) =>
              Effect.forEach(
                tasks,
                (task) =>
                  sql`
                    insert into ${table}
                      (id, workflowId, position, step, name, teamId, instructions)
                    values
                      (${crypto.randomUUID()}, ${workflowId}, ${task.position}, ${task.step}, ${task.name}, ${task.teamId}, ${task.instructions ?? null})
                  `,
                { discard: true },
              );
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`delete from Run`;
                yield* sql`delete from Workflow`;
                const seeded: { name: Domain.WorkflowName; id: string }[] = [];
                for (const workflow of staged) {
                  const workflowId = crypto.randomUUID();
                  seeded.push({ name: workflow.name, id: workflowId });
                  yield* sql`
                    insert into Workflow
                      (id, name, tag, state, updatedAt)
                    values
                      (${workflowId}, ${workflow.name}, ${workflow.tag}, ${workflow.on ? "on" : "off"}, ${now})
                  `;
                  yield* writeTasks(
                    sql.literal("WorkflowTask"),
                    workflowId,
                    workflow.tasks,
                  );
                  if (workflow.draft !== null) {
                    yield* insertDraft({ workflowId, now });
                    yield* writeTasks(
                      sql.literal("WorkflowDraftTask"),
                      workflowId,
                      workflow.draft.tasks,
                    );
                  }
                }
                return seeded;
              }),
            );
          },
        ),

        /**
         * The name and the tag are asked about before the insert, inside one
         * transaction: both are unique, and each refusal has to land under
         * its own field, which a `unique` constraint failure cannot say. The
         * name goes first because the dialog prefills the tag from it, so a
         * new name usually frees both.
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
                      (id, name, tag, state, updatedAt)
                    values
                      (${crypto.randomUUID()}, ${name}, ${tag}, 'off', ${now})
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
                const tasks = yield* workflowTasks(workflowId);
                const now = yield* Clock.currentTimeMillis;
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    insert into Workflow
                      (id, name, tag, state, updatedAt)
                    values
                      (${copyId}, ${name}, ${tag}, 'off', ${now})
                    returning *
                  `,
                );
                if (workflow === undefined)
                  return yield* new WorkflowRepositoryError({
                    message: "Workflow copy insert returned no row",
                    cause: name,
                  });
                yield* Effect.forEach(
                  tasks,
                  (task) =>
                    sql`
                      insert into WorkflowTask
                        (id, workflowId, position, step, name, teamId, instructions)
                      values (
                        ${crypto.randomUUID()}, ${copyId}, ${task.position},
                        ${task.step}, ${task.name}, ${task.teamId},
                        ${task.instructions}
                      )
                    `,
                  { discard: true },
                );
                return workflow;
              }),
            );
          },
        ),

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

        setWorkflowOn: Effect.fn("WorkflowRepository.setWorkflowOn")(
          function* ({
            workflowId,
            on,
            teams,
          }: {
            readonly workflowId: string;
            readonly on: boolean;
            readonly teams: Teams;
          }) {
            yield* requireWorkflow(workflowId);
            if (on)
              yield* requireEligibleTasks(
                workflowId,
                yield* workflowTasks(workflowId),
                teams,
              );
            const now = yield* Clock.currentTimeMillis;
            const [workflow] = yield* decodeWorkflows(
              yield* sql`
                update Workflow
                set state = ${on ? "on" : "off"}, updatedAt = ${now}
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
              return yield* promoteDraft(workflowId, teams);
            }),
          );
        }),

        applyAndTurnOn: Effect.fn("WorkflowRepository.applyAndTurnOn")(
          function* ({
            workflowId,
            teams,
          }: {
            readonly workflowId: string;
            readonly teams: Teams;
          }) {
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireWorkflow(workflowId);
                const draft = yield* findDraft(workflowId);
                if (Option.isSome(draft))
                  yield* promoteDraft(workflowId, teams);
                yield* requireEligibleTasks(
                  workflowId,
                  yield* workflowTasks(workflowId),
                  teams,
                );
                const now = yield* Clock.currentTimeMillis;
                const [workflow] = yield* decodeWorkflows(
                  yield* sql`
                    update Workflow
                    set state = 'on', updatedAt = ${now}
                    where id = ${workflowId}
                    returning *
                  `,
                );
                return (
                  workflow ?? (yield* new WorkflowNotFoundError({ workflowId }))
                );
              }),
            );
          },
        ),

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
          readonly name: Domain.TaskName;
          readonly teamId: Domain.TeamId;
          readonly instructions?: Domain.TaskInstructions | null;
        }) {
          return yield* sql.withTransaction(
            insertTask({
              workflowId,
              position: sql`(select coalesce(max(position), 0) + 1 from WorkflowDraftTask where workflowId = ${workflowId})`,
              step: sql`(select coalesce(max(step), 0) + 1 from WorkflowDraftTask where workflowId = ${workflowId})`,
              name,
              teamId,
              instructions: instructions ?? null,
            }),
          );
        }),

        /**
         * Inserted at a temporary last position in the target step, then the
         * whole layout is rewritten so the new task lands right after that
         * step's last member. Insert and relayout share one transaction, and
         * the task is re-read afterwards so the caller sees its final
         * position.
         */
        addTask: Effect.fn("WorkflowRepository.addTask")(function* ({
          workflowId,
          step,
          name,
          teamId,
          instructions,
        }: {
          readonly workflowId: string;
          readonly step: number;
          readonly name: Domain.TaskName;
          readonly teamId: Domain.TeamId;
          readonly instructions?: Domain.TaskInstructions | null;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* ensureDraft(workflowId);
              const before = yield* layoutOf(workflowId);
              if (!before.some((p) => p.step === step))
                return yield* new StepNotFoundError({ workflowId, step });
              const inserted = yield* insertTask({
                workflowId,
                position: sql`${before.length + 1}`,
                step: sql`${step}`,
                name,
                teamId,
                instructions: instructions ?? null,
              });
              yield* writeLayout(
                workflowId,
                WorkflowLayout.appendTask(before, step, inserted.id),
              );
              const placed = yield* findDraftTask(inserted.id);
              return Option.isSome(placed)
                ? placed.value
                : yield* new WorkflowRepositoryError({
                    message: "WorkflowDraftTask vanished during relayout",
                    cause: inserted.id,
                  });
            }),
          );
        }),

        getTask: Effect.fn("WorkflowRepository.getTask")(function* ({
          taskId,
        }: {
          readonly taskId: string;
        }) {
          const drafted = yield* findDraftTask(taskId);
          const task = Option.isSome(drafted)
            ? drafted
            : yield* findWorkflowTask(taskId);
          if (Option.isNone(task)) return Option.none();
          const workflow = yield* findWorkflow(task.value.workflowId);
          if (Option.isNone(workflow))
            return yield* new WorkflowRepositoryError({
              message: "Task.workflowId resolves to no Workflow",
              cause: taskId,
            });
          return Option.some({ task: task.value, workflow: workflow.value });
        }),

        updateTask: Effect.fn("WorkflowRepository.updateTask")(function* ({
          taskId,
          name,
          teamId,
          instructions,
        }: {
          readonly taskId: string;
          readonly name: Domain.TaskName;
          readonly teamId: Domain.TeamId;
          readonly instructions: Domain.TaskInstructions | null;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireEditableTask(taskId);
              const [task] = yield* decodeTasks(
                yield* sql`
                  update WorkflowDraftTask
                  set name = ${name}, teamId = ${teamId}, instructions = ${instructions}
                  where id = ${taskId}
                  returning *
                `,
              );
              if (task === undefined)
                return yield* new TaskNotFoundError({ taskId });
              yield* touchDraft(
                task.workflowId,
                yield* Clock.currentTimeMillis,
              );
              return task;
            }),
          );
        }),

        moveTask: Effect.fn("WorkflowRepository.moveTask")(function* ({
          taskId,
          direction,
        }: {
          readonly taskId: string;
          readonly direction: Domain.TaskDirection;
        }) {
          yield* relayout(taskId, (layout) =>
            WorkflowLayout.move(layout, taskId, direction),
          );
        }),

        separateTask: Effect.fn("WorkflowRepository.separateTask")(function* ({
          taskId,
        }: {
          readonly taskId: string;
        }) {
          yield* relayout(taskId, (layout) =>
            WorkflowLayout.separate(layout, taskId),
          );
        }),

        joinTask: Effect.fn("WorkflowRepository.joinTask")(function* ({
          taskId,
        }: {
          readonly taskId: string;
        }) {
          yield* relayout(taskId, (layout) =>
            WorkflowLayout.join(layout, taskId),
          );
        }),

        /** Deletes, then rewrites the layout so positions and steps stay dense from 1, in one transaction. */
        removeTask: Effect.fn("WorkflowRepository.removeTask")(function* ({
          taskId,
        }: {
          readonly taskId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const task = yield* requireEditableTask(taskId);
              const layout = yield* layoutOf(task.workflowId);
              yield* sql`delete from WorkflowDraftTask where id = ${taskId}`;
              yield* writeLayout(
                task.workflowId,
                WorkflowLayout.remove(layout, taskId),
              );
              yield* touchDraft(
                task.workflowId,
                yield* Clock.currentTimeMillis,
              );
            }),
          );
        }),

        countTasksByTeam: Effect.fn("WorkflowRepository.countTasksByTeam")(
          function* () {
            return yield* decode(
              Schema.Array(Domain.TeamTaskCounts),
              "Invalid TeamTaskCounts row",
            )(
              yield* sql`
                select teamId,
                  sum(workflowTasks) as workflowTasks,
                  sum(draftTasks) as draftTasks,
                  sum(openRunTasks) as openRunTasks
                from (
                  select teamId, 1 as workflowTasks, 0 as draftTasks, 0 as openRunTasks
                  from WorkflowTask where teamId is not null
                  union all
                  select teamId, 0, 1, 0
                  from WorkflowDraftTask where teamId is not null
                  union all
                  select s.teamId, 0, 0, 1
                  from RunTask s
                  join Run r on r.id = s.runId
                  where s.teamId is not null and s.doneAt is null
                    and r.state = 'open'
                )
                group by teamId
                order by teamId
              `,
            );
          },
        ),

        listTeamWorkflows: Effect.fn("WorkflowRepository.listTeamWorkflows")(
          function* ({ teamId }: { readonly teamId: string }) {
            return yield* decode(
              Schema.Array(Domain.TeamWorkflow),
              "Invalid TeamWorkflow row",
            )(
              yield* sql`
                select w.id as workflowId, w.name as workflowName
                from Workflow w
                where w.id in (
                  select workflowId from WorkflowTask where teamId = ${teamId}
                  union
                  select workflowId from WorkflowDraftTask where teamId = ${teamId}
                )
                order by w.name
              `,
            );
          },
        ),

        listAllTeamWorkflows: Effect.fn(
          "WorkflowRepository.listAllTeamWorkflows",
        )(function* () {
          return yield* decode(
            Schema.Array(Domain.TeamWorkflowByTeam),
            "Invalid TeamWorkflowByTeam row",
          )(
            yield* sql`
                select u.teamId, w.id as workflowId, w.name as workflowName
                from (
                  select teamId, workflowId from WorkflowTask where teamId is not null
                  union
                  select teamId, workflowId from WorkflowDraftTask where teamId is not null
                ) u
                join Workflow w on w.id = u.workflowId
                order by w.name, u.teamId
              `,
          );
        }),

        unassignTeam: Effect.fn("WorkflowRepository.unassignTeam")(function* ({
          teamId,
        }: {
          readonly teamId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`update WorkflowTask set teamId = null where teamId = ${teamId}`;
              yield* sql`update WorkflowDraftTask set teamId = null where teamId = ${teamId}`;
              yield* sql`update RunTask set teamId = null where teamId = ${teamId}`;
            }),
          );
        }),
      });
    }),
  );
}

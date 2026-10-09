import type { SqlError } from "effect/sql";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlConnection, type Statement } from "effect/sql";

import * as Domain from "@/lib/Domain";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
/**
 * The run path's workflow read: the active workflows whose tag is one of the
 * order's product tags, the rule on `Domain.itemMatches` (by tag, never by
 * scanning). One parameter, the tags as a JSON array. Exported for the test
 * that reads its query plan: the probe searches the unique index on
 * `Workflow.tag`.
 */
export const ACTIVE_WORKFLOWS_BY_TAGS = `select * from Workflow
  where state = 'active'
    and tag in (select value from json_each(?))
  order by name`;

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
 * A tag another workflow already carries, active or inactive. The tag is the
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
 * A name another workflow already has, active or inactive, compared exactly. The name
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

/** A task id the editor sent that no workflow's draft (or, with no draft, its tasks) carries — a task some other tab already removed, or a stale id. */
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
 * away. Task and tag writes never raise this: a task write creates the draft
 * it needs (`editDraft`), and the tag is not drafted.
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

/** What `getWorkflow` returns: the workflow, its tasks, and the draft's tasks, `null` when there is no draft. */
export interface WorkflowWithDraftTasks extends Domain.WorkflowDetail {
  readonly draftTasks: readonly Domain.WorkflowTask[] | null;
}

/** The `Workflow` row's own fields, without its task documents. */
const workflowOf = ({
  id,
  name,
  tag,
  state,
  updatedAt,
}: Domain.Workflow): Domain.Workflow => ({
  id,
  name,
  tag,
  state,
  updatedAt,
});

/** `tasks` laid out as `layout` says: each task takes its placed step, in its placed order. */
const laidOut = (
  tasks: readonly Domain.WorkflowTask[],
  layout: WorkflowLayout.Layout,
): readonly Domain.WorkflowTask[] =>
  layout
    .toSorted((a, b) => a.position - b.position)
    .flatMap((p) => {
      const task = tasks.find((t) => t.id === p.id);
      return task === undefined
        ? []
        : [{ ...task, position: p.position, step: p.step }];
    });

type SeedTask = Domain.SeedWorkflowsInput["workflows"][number]["tasks"][number];
/**
 * A seed fixture's tasks as a task list: a task with no `step` follows the
 * previous one (linear), and each gets a new id. `replaceWorkflows` checks the
 * layout before anything is written, so a bad fixture fails whole rather than
 * half-seeding.
 */
const seededTasks = (tasks: readonly SeedTask[]) =>
  tasks.reduce<readonly Domain.WorkflowTask[]>((acc, task, index) => {
    const previous = acc[index - 1]?.step ?? 0;
    return [
      ...acc,
      {
        id: Domain.WorkflowTaskId.make(crypto.randomUUID()),
        position: index + 1,
        step: task.step ?? previous + 1,
        name: task.name,
        teamId: task.teamId,
        instructions: task.instructions ?? null,
      },
    ];
  }, []);
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
     * One page of the workflows index, by {@link Domain.ListWorkflowsInput}'s
     * rules. `teams` is the shop's live teams: `unassigned` and `emptyTeam`
     * are derived per row from the workflow's tasks against it and never
     * stored, for the page's rows only. {@link Domain.WorkflowSummary}
     * carries them.
     */
    readonly listWorkflows: (
      input: Domain.ListWorkflowsInput & { readonly teams: Teams },
    ) => Effect.Effect<
      Domain.WorkflowsIndexData,
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
    /** The workflow with its tasks, and the draft's tasks, `null` when there is no draft. */
    readonly getWorkflow: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      Option.Option<WorkflowWithDraftTasks>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The active workflows whose tag is one of `tags`, with their tasks,
     * in name order: a probe of the unique `Workflow.tag`, never a scan, by
     * the rule on `Domain.itemMatches`. Reconcile reads it per order with the
     * order's product tags, inside the order's transaction; the order page
     * reads it the same way. Drafts are invisible here by construction:
     * nothing in run creation reads `draftTasks`.
     */
    readonly listActiveWorkflowsByTags: (input: {
      readonly tags: readonly string[];
    }) => Effect.Effect<
      readonly Domain.WorkflowDetail[],
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The object's half of `Domain.SetupFacts`, in one statement: some
     * workflow is active, and some run exists in any state. Each `exists`
     * stops at its first row: `Workflow` holds at most
     * `Domain.WorkflowLimits.maxWorkflows` rows, and `Run` is read through its
     * primary key.
     */
    readonly workflowSetupFacts: () => Effect.Effect<
      Domain.WorkflowSetupFacts,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /** Every active workflow with tasks, by name: the Workflow select's options past the order's matches. */
    readonly listActiveWorkflowNames: () => Effect.Effect<
      readonly Domain.WorkflowNameRow[],
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
     * Inserts the workflow: inactive, no tasks, carrying its tag, and **no draft**.
     * The draft is the editor's record of unsaved changes and is created by
     * the first change (`editDraft`), so a fresh workflow has none and the
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
     * the name and tag the merchant chose in the Duplicate dialog; inactive, with
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
     * moves. Refuses a tag another workflow holds, active or inactive.
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
     * The switch. Active requires: at least one task, every task assigned
     * to a team in `teams`; it writes `state = 'active'`. A team with no members
     * does not refuse. Tags are not
     * its business: every workflow's tag is unique from birth, so the switch
     * can never collide with one. Inactive writes
     * `state = 'inactive'` and touches nothing else: open runs are days of
     * physical work and keep going; only new runs stop. Neither direction
     * creates, applies, or discards a draft, or looks at whether one exists.
     */
    readonly setWorkflowState: (input: {
      readonly workflowId: string;
      readonly state: Domain.WorkflowState;
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
     * The draft, made explicitly: the existing draft's tasks when there is
     * one, otherwise `draftTasks` becomes a copy of `tasks`, ids included,
     * in one statement. The editor does not call this — its writes create the
     * draft themselves — so this is for a caller that wants a draft without
     * changing anything.
     */
    readonly createDraft: (input: {
      readonly workflowId: string;
    }) => Effect.Effect<
      readonly Domain.WorkflowTask[],
      SqlError.SqlError | WorkflowRepositoryError | WorkflowNotFoundError
    >;
    /**
     * Replaces the workflow's tasks with the draft's and clears the draft, in
     * one statement: an order sees the old definition or the new one, never
     * a half-edit. Refused with no draft, an empty draft, or an unassigned
     * task, active and inactive alike. The tag is not drafted, so Apply never reads or
     * writes it. Does not touch `state`: the workflow stays active or inactive, and
     * the caller reconciles the orders
     * against the new definition. Task ids carry over, since the document is
     * copied whole.
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
     * run and then turning the workflow on are one decision, and doing them
     * as two calls leaves a window where the first succeeded and the second
     * did not. An absent draft is not a refusal here — there is simply nothing
     * to promote, and the eligibility check on the workflow's own tasks then
     * decides. Otherwise the same rules as {@link applyDraft} and
     * {@link setWorkflowState}.
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
    /** Clears the draft. Always allowed; a never-applied workflow is left with zero tasks. */
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
      Domain.WorkflowTask,
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
      Domain.WorkflowTask,
      | SqlError.SqlError
      | WorkflowRepositoryError
      | WorkflowNotFoundError
      | WorkflowLimitError
      | StepNotFoundError
    >;
    /**
     * A task the editor can act on, with its workflow: the draft's when
     * there is a draft, otherwise the workflow's own — the same id either way
     * (`editDraft`). A read, so it creates nothing.
     */
    readonly getTask: (input: { readonly taskId: string }) => Effect.Effect<
      Option.Option<{
        readonly task: Domain.WorkflowTask;
        readonly workflow: Domain.Workflow;
      }>,
      SqlError.SqlError | WorkflowRepositoryError
    >;
    /**
     * The task-id writes below all land on the draft, creating it from the
     * workflow when this is the first change (`editDraft`).
     * `instructions: null` clears.
     */
    readonly updateTask: (input: {
      readonly taskId: string;
      readonly name: Domain.TaskName;
      readonly teamId: Domain.TeamId;
      readonly instructions: Domain.TaskInstructions | null;
    }) => Effect.Effect<
      Domain.WorkflowTask,
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
     * The object-side half of a team delete: every workflow task, draft task
     * and run task that points at `teamId` becomes unassigned, in one
     * transaction, done or not and whatever the run's state. A run task
     * keeps its `teamName` snapshot, which is all history reads; the pointer
     * on a done or closed task had no reader once the team was gone, because
     * every team-scoped list takes its team ids from D1 (the data model on
     * `initializeSchema`, `ShopAgentSchema.ts`). Idempotent, so a
     * retry after a failed first attempt (D1 row already gone) still cleans
     * up. The task documents are rewritten through `Domain.WorkflowTasks`,
     * read, edited and written whole, so the stored list stays one the
     * `Schema` accepts. Touches `RunTask` from here
     * rather than from the run repository because the writes must
     * share one transaction and Durable Object SQLite refuses to nest.
     */
    readonly unassignTeam: (input: {
      readonly teamId: string;
    }) => Effect.Effect<void, SqlError.SqlError | WorkflowRepositoryError>;
    /**
     * Every team id a workflow task, draft task or run task points to, each
     * once. A team delete reads it to find pointers to teams already gone
     * from D1, the repair half of the team-delete row on `D1_TABLES`.
     */
    readonly teamIdsInUse: () => Effect.Effect<
      readonly string[],
      SqlError.SqlError
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

      /** A `Workflow` row with its two task documents decoded. */
      const decodeWorkflowRows = decode(
        Schema.Array(
          Schema.Struct({
            ...Domain.Workflow.fields,
            tasks: Domain.WorkflowTasks,
            draftTasks: Schema.NullOr(Domain.WorkflowTasks),
          }),
        ),
        "Invalid Workflow row",
      );

      const encodeTasks = (tasks: readonly Domain.WorkflowTask[]) =>
        Schema.encodeEffect(Domain.WorkflowTasks)(tasks).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowRepositoryError({
                message: "Invalid task list",
                cause,
              }),
          ),
        );

      const findWorkflowRow = (workflowId: string) =>
        sql`select * from Workflow where id = ${workflowId}`.pipe(
          Effect.flatMap(decodeWorkflowRows),
          Effect.map(([row]) => Option.fromUndefinedOr(row)),
        );

      const requireWorkflowRow = (workflowId: string) =>
        findWorkflowRow(workflowId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new WorkflowNotFoundError({ workflowId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      /**
       * The workflow whose draft carries `taskId`, or whose tasks do when it
       * has no draft: the list the editor is looking at. A scan of the shop's
       * workflows, bounded by `WorkflowLimits`; the editor sends a task id
       * alone.
       */
      const workflowIdOfTask = (taskId: string) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly id: string }>`
            select w.id from Workflow w, json_each(coalesce(w.draftTasks, w.tasks)) t
            where json_extract(t.value, '$.id') = ${taskId}
          `;
          return row === undefined
            ? yield* new TaskNotFoundError({ taskId })
            : row.id;
        });

      /**
       * Every editor write, in the caller's transaction (Durable Object SQLite
       * refuses to nest). Opening the editor is not an edit: nothing is
       * written until the merchant changes something, and by then the draft
       * has to exist for the change to go anywhere. So the first write copies
       * `tasks` into `draftTasks`, ids included, and that copy is what lets
       * the editor change a task it is looking at before any draft exists:
       * the id it sends names the workflow's task now and the draft's a
       * moment later. Then `edit` runs on the draft's list and the result is
       * written whole through `Domain.WorkflowTasks`, which refuses a list
       * that breaks the step rule or the task cap. `updatedAt` moves on every
       * edit. Returns the list as written.
       */
      const editDraft = <E>(
        workflowId: string,
        edit: (
          tasks: readonly Domain.WorkflowTask[],
        ) => Effect.Effect<readonly Domain.WorkflowTask[], E>,
      ) =>
        Effect.gen(function* () {
          yield* requireWorkflowRow(workflowId);
          yield* sql`
            update Workflow set draftTasks = coalesce(draftTasks, tasks)
            where id = ${workflowId}
          `;
          const row = yield* requireWorkflowRow(workflowId);
          const tasks = yield* edit(row.draftTasks ?? row.tasks);
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
            update Workflow
            set draftTasks = ${yield* encodeTasks(tasks)}, updatedAt = ${now}
            where id = ${workflowId}
          `;
          return tasks;
        });

      /** {@link editDraft} on the draft holding `taskId`, rewriting its layout with `edit`. */
      const relayout = (
        taskId: string,
        edit: (layout: WorkflowLayout.Layout) => WorkflowLayout.Layout,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const workflowId = yield* workflowIdOfTask(taskId);
            yield* editDraft(workflowId, (tasks) =>
              Effect.succeed(laidOut(tasks, edit(tasks))),
            );
          }),
        );

      /** The task `addStep` or `addTask` just placed, read back from the list as written so the caller sees its final step and position. */
      const addedTask = (
        tasks: readonly Domain.WorkflowTask[],
        id: Domain.WorkflowTaskId,
      ) => {
        const task = tasks.find((task) => task.id === id);
        return task === undefined
          ? Effect.fail(
              new WorkflowRepositoryError({
                message: "The added task is missing from the draft",
                cause: id,
              }),
            )
          : Effect.succeed(task);
      };

      /** Refuses past `WorkflowLimits.maxTasks` with the typed error, so the message lands under the field; the `Schema` would refuse too. */
      const requireRoom = (tasks: readonly Domain.WorkflowTask[]) =>
        tasks.length >= Domain.WorkflowLimits.maxTasks
          ? Effect.fail(
              new WorkflowLimitError({ limit: Domain.WorkflowLimits.maxTasks }),
            )
          : Effect.void;

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
       * of whether a draft exists: one statement copies the draft's document
       * over the workflow's and clears the draft, and `updatedAt` moves so
       * "Last updated on" reflects the Apply. Shared by `applyDraft` and
       * `applyAndTurnOn`, which ask that question differently — Apply refuses
       * without a draft, while the editor's Turn on on a never-applied
       * workflow simply has nothing to promote. The tag is not drafted, so
       * nothing here reads or writes it.
       */
      const promoteDraft = (
        workflowId: string,
        draftTasks: readonly Domain.WorkflowTask[],
        teams: Teams,
      ) =>
        Effect.gen(function* () {
          yield* requireEligibleTasks(workflowId, draftTasks, teams);
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
            update Workflow
            set tasks = draftTasks, draftTasks = null, updatedAt = ${now}
            where id = ${workflowId}
          `;
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
       * name the holder, which a constraint failure cannot. Tags are compared
       * exactly (`Domain.WorkflowTag` trims and nothing else), the same
       * equality `Domain.matchesTag` uses. Runs inside the caller's
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

      /** Inserts an inactive workflow carrying `tasks`, after the ceiling, name and tag checks; in the caller's transaction. */
      const insertWorkflow = ({
        name,
        tag,
        tasks,
      }: {
        readonly name: Domain.WorkflowName;
        readonly tag: Domain.WorkflowTag;
        readonly tasks: readonly Domain.WorkflowTask[];
      }) =>
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
                (id, name, tag, state, updatedAt, tasks)
              values
                (${crypto.randomUUID()}, ${name}, ${tag}, 'inactive', ${now}, ${yield* encodeTasks(tasks)})
              returning id, name, tag, state, updatedAt
            `,
          );
          return (
            workflow ??
            (yield* new WorkflowRepositoryError({
              message: "Workflow insert returned no row",
              cause: name,
            }))
          );
        });

      /** One `set` on the workflow row, `updatedAt` moving with it, returning the row. */
      const updateWorkflowRow = (workflowId: string, set: Statement.Fragment) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [workflow] = yield* decodeWorkflows(
            yield* sql`
              update Workflow
              set ${set}, updatedAt = ${now}
              where id = ${workflowId}
              returning id, name, tag, state, updatedAt
            `,
          );
          return workflow ?? (yield* new WorkflowNotFoundError({ workflowId }));
        });

      return WorkflowRepository.of({
        listWorkflows: Effect.fn("WorkflowRepository.listWorkflows")(
          function* ({
            teams,
            limit,
            cursor,
            q,
            state,
          }: Domain.ListWorkflowsInput & { readonly teams: Teams }) {
            const search =
              q === null
                ? null
                : (() => {
                    const [start, word] = Domain.prefixPatterns(q);
                    return sql`(w.name like ${start} escape '\\' or w.name like ${word} escape '\\')`;
                  })();
            const filter =
              search ?? (state === null ? sql`1 = 1` : sql`w.state = ${state}`);
            const after =
              cursor === null ? sql`1 = 1` : sql`w.name > ${cursor}`;
            const rows = yield* decode(
              Schema.Array(
                Schema.Struct({
                  ...Domain.WorkflowSummaryRow.fields,
                  tasks: Domain.WorkflowTasks,
                }),
              ),
              "Invalid WorkflowSummary row",
            )(
              yield* sql`
                select w.id, w.name, w.tag, w.state, w.updatedAt, w.tasks,
                  (select coalesce(max(json_extract(t.value, '$.step')), 0)
                   from json_each(w.tasks) t) as stepCount
                from Workflow w
                where ${filter} and ${after}
                order by w.name
                limit ${limit + 1}
              `,
            );
            const page = rows.slice(0, limit);
            // Derived, never stored: the badges are computed from the workflow's
            // tasks against the teams on every list read, so assigning a
            // team or adding a member clears it with no other write.
            const emptyTeam = (task: Domain.WorkflowTask) =>
              teams.some(
                (team) => team.id === task.teamId && team.memberCount === 0,
              );
            return {
              workflows: page.map(
                ({ tasks, ...row }): Domain.WorkflowSummary => ({
                  ...row,
                  unassigned: tasks.some((task) =>
                    taskIsUnassigned(task, teams),
                  ),
                  emptyTeam: tasks.some(emptyTeam),
                }),
              ),
              nextCursor:
                rows.length > limit ? (page.at(-1)?.name ?? null) : null,
              matches:
                search === null
                  ? null
                  : yield* count(
                      sql`select count(*) from Workflow w where ${search}`,
                    ),
            } satisfies Domain.WorkflowsIndexData;
          },
        ),

        deleteWorkflow: Effect.fn("WorkflowRepository.deleteWorkflow")(
          function* ({ workflowId }: { readonly workflowId: string }) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireWorkflowRow(workflowId);
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
          const row = yield* findWorkflowRow(workflowId);
          if (Option.isNone(row)) return Option.none();
          return Option.some({
            workflow: workflowOf(row.value),
            tasks: row.value.tasks,
            draftTasks: row.value.draftTasks,
          } satisfies WorkflowWithDraftTasks);
        }),

        listActiveWorkflowsByTags: Effect.fn(
          "WorkflowRepository.listActiveWorkflowsByTags",
        )(function* ({ tags }: { readonly tags: readonly string[] }) {
          const rows = yield* decodeWorkflowRows(
            yield* sql.unsafe(ACTIVE_WORKFLOWS_BY_TAGS, [JSON.stringify(tags)]),
          );
          return rows.map((row): Domain.WorkflowDetail => ({
            workflow: workflowOf(row),
            tasks: row.tasks,
          }));
        }),

        workflowSetupFacts: Effect.fn("WorkflowRepository.workflowSetupFacts")(
          function* () {
            const [row] = yield* decode(
              Schema.Array(
                Schema.Struct({
                  activeWorkflow: Domain.SqliteBoolean,
                  run: Domain.SqliteBoolean,
                }),
              ),
              "Invalid setup facts row",
            )(
              yield* sql`
                select
                  exists (select 1 from Workflow where state = 'active') as activeWorkflow,
                  exists (select 1 from Run) as run
              `,
            );
            return row ?? { activeWorkflow: false, run: false };
          },
        ),

        listActiveWorkflowNames: Effect.fn(
          "WorkflowRepository.listActiveWorkflowNames",
        )(function* () {
          return yield* decode(
            Schema.Array(Domain.WorkflowNameRow),
            "Invalid Workflow name row",
          )(
            yield* sql`
                select id, name from Workflow
                where state = 'active' and json_array_length(tasks) > 0
                order by name
              `,
          );
        }),

        /**
         * A fixture's `tasks` become the workflow's tasks, active
         * (`state = 'active'`) unless
         * `state: "inactive"` or a task is unassigned. A fixture with no tasks and
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
            const draftOf = (
              workflow: Domain.SeedWorkflowsInput["workflows"][number],
            ) =>
              workflow.draft === undefined
                ? null
                : seededTasks(workflow.draft.tasks);
            const staged = workflows.map((workflow) => ({
              ...workflow,
              tasks: seededTasks(workflow.tasks),
              draftTasks: draftOf(workflow),
              state:
                workflow.state ??
                (workflow.tasks.length > 0 &&
                workflow.tasks.every((task) => task.teamId !== null)
                  ? ("active" as const)
                  : ("inactive" as const)),
            }));
            const invalid = staged.find(
              (workflow) =>
                !Domain.layoutIsValid(workflow.tasks) ||
                (workflow.draftTasks !== null &&
                  !Domain.layoutIsValid(workflow.draftTasks)),
            );
            if (invalid !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${invalid.name}: steps must be dense from 1 and non-decreasing`,
                cause: invalid.tasks.map((task) => task.step),
              });
            // The invariants the ordinary write path enforces that a fixture
            // could otherwise silently break.
            const activeWithoutTasks = staged.find(
              (workflow) =>
                Domain.workflowIsActive(workflow) &&
                workflow.tasks.length === 0,
            );
            if (activeWithoutTasks !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${activeWithoutTasks.name}: an active workflow needs tasks`,
                cause: activeWithoutTasks.name,
              });
            // Mirrors `SwitchResult.TaskUnassigned`: active with a task nobody
            // owns is a workflow the list shows as Active that creates nothing.
            const activeWithUnassigned = staged.find(
              (workflow) =>
                Domain.workflowIsActive(workflow) &&
                workflow.tasks.some((task) => task.teamId === null),
            );
            if (activeWithUnassigned !== undefined)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflow=${activeWithUnassigned.name}: an active workflow needs every task assigned`,
                cause: activeWithUnassigned.name,
              });
            if (staged.length > Domain.WorkflowLimits.maxWorkflows)
              return yield* new WorkflowRepositoryError({
                message: `replaceWorkflows: workflows=${String(staged.length)}: at most ${String(Domain.WorkflowLimits.maxWorkflows)} workflows`,
                cause: staged.length,
              });
            const overTasks = staged.find(
              (workflow) =>
                workflow.tasks.length > Domain.WorkflowLimits.maxTasks ||
                (workflow.draftTasks?.length ?? 0) >
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
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`delete from Run`;
                yield* sql`delete from Workflow`;
                const seeded: { name: Domain.WorkflowName; id: string }[] = [];
                for (const workflow of staged) {
                  const workflowId = crypto.randomUUID();
                  seeded.push({ name: workflow.name, id: workflowId });
                  const tasks = yield* encodeTasks(workflow.tasks);
                  const draftTasks =
                    workflow.draftTasks === null
                      ? null
                      : yield* encodeTasks(workflow.draftTasks);
                  yield* sql`
                    insert into Workflow
                      (id, name, tag, state, updatedAt, tasks, draftTasks)
                    values
                      (${workflowId}, ${workflow.name}, ${workflow.tag}, ${workflow.state}, ${now}, ${tasks}, ${draftTasks})
                  `;
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
              insertWorkflow({ name, tag, tasks: [] }),
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
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const source = yield* requireWorkflowRow(workflowId);
                return yield* insertWorkflow({
                  name,
                  tag,
                  tasks: source.tasks.map((task) => ({
                    ...task,
                    id: Domain.WorkflowTaskId.make(crypto.randomUUID()),
                  })),
                });
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
                yield* requireWorkflowRow(workflowId);
                yield* requireNameFree(name, workflowId);
                return yield* updateWorkflowRow(
                  workflowId,
                  sql`name = ${name}`,
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
                yield* requireWorkflowRow(workflowId);
                yield* requireTagFree(tag, workflowId);
                return yield* updateWorkflowRow(workflowId, sql`tag = ${tag}`);
              }),
            );
          },
        ),

        setWorkflowState: Effect.fn("WorkflowRepository.setWorkflowState")(
          function* ({
            workflowId,
            state,
            teams,
          }: {
            readonly workflowId: string;
            readonly state: Domain.WorkflowState;
            readonly teams: Teams;
          }) {
            const row = yield* requireWorkflowRow(workflowId);
            if (Domain.workflowIsActive({ state }))
              yield* requireEligibleTasks(workflowId, row.tasks, teams);
            return yield* updateWorkflowRow(workflowId, sql`state = ${state}`);
          },
        ),

        createDraft: Effect.fn("WorkflowRepository.createDraft")(function* ({
          workflowId,
        }: {
          readonly workflowId: string;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireWorkflowRow(workflowId);
              yield* sql`
                update Workflow set draftTasks = coalesce(draftTasks, tasks)
                where id = ${workflowId}
              `;
              const row = yield* requireWorkflowRow(workflowId);
              return row.draftTasks ?? row.tasks;
            }),
          );
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
              const row = yield* requireWorkflowRow(workflowId);
              if (row.draftTasks === null)
                return yield* new NoDraftError({ workflowId });
              yield* promoteDraft(workflowId, row.draftTasks, teams);
              return workflowOf(yield* requireWorkflowRow(workflowId));
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
                const row = yield* requireWorkflowRow(workflowId);
                if (row.draftTasks !== null)
                  yield* promoteDraft(workflowId, row.draftTasks, teams);
                yield* requireEligibleTasks(
                  workflowId,
                  row.draftTasks ?? row.tasks,
                  teams,
                );
                return yield* updateWorkflowRow(
                  workflowId,
                  sql`state = 'active'`,
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
              const row = yield* requireWorkflowRow(workflowId);
              if (row.draftTasks === null)
                return yield* new NoDraftError({ workflowId });
              return yield* updateWorkflowRow(
                workflowId,
                sql`draftTasks = null`,
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
          readonly name: Domain.TaskName;
          readonly teamId: Domain.TeamId;
          readonly instructions?: Domain.TaskInstructions | null;
        }) {
          const id = Domain.WorkflowTaskId.make(crypto.randomUUID());
          const tasks = yield* sql.withTransaction(
            editDraft(workflowId, (tasks) =>
              requireRoom(tasks).pipe(
                Effect.as(
                  laidOut(
                    [
                      ...tasks,
                      {
                        id,
                        position: 0,
                        step: 0,
                        name,
                        teamId,
                        instructions: instructions ?? null,
                      },
                    ],
                    WorkflowLayout.append(tasks, id),
                  ),
                ),
              ),
            ),
          );
          return yield* addedTask(tasks, id);
        }),

        /** The new task lands right after the target step's last member (`WorkflowLayout.appendTask`). */
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
          const id = Domain.WorkflowTaskId.make(crypto.randomUUID());
          const tasks = yield* sql.withTransaction(
            editDraft(workflowId, (tasks) =>
              Effect.gen(function* () {
                if (!tasks.some((task) => task.step === step))
                  return yield* new StepNotFoundError({ workflowId, step });
                yield* requireRoom(tasks);
                return laidOut(
                  [
                    ...tasks,
                    {
                      id,
                      position: 0,
                      step,
                      name,
                      teamId,
                      instructions: instructions ?? null,
                    },
                  ],
                  WorkflowLayout.appendTask(tasks, step, id),
                );
              }),
            ),
          );
          return yield* addedTask(tasks, id);
        }),

        getTask: Effect.fn("WorkflowRepository.getTask")(function* ({
          taskId,
        }: {
          readonly taskId: string;
        }) {
          const workflowId = yield* workflowIdOfTask(taskId).pipe(
            Effect.map(Option.some),
            Effect.catchTag("TaskNotFoundError", () => Effect.succeedNone),
          );
          if (Option.isNone(workflowId)) return Option.none();
          const row = yield* requireWorkflowRow(workflowId.value).pipe(
            Effect.catchTag("WorkflowNotFoundError", (cause) =>
              Effect.fail(
                new WorkflowRepositoryError({
                  message: "Task resolves to no Workflow",
                  cause,
                }),
              ),
            ),
          );
          const task = (row.draftTasks ?? row.tasks).find(
            (task) => task.id === taskId,
          );
          return task === undefined
            ? Option.none()
            : Option.some({ task, workflow: workflowOf(row) });
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
          const tasks = yield* sql.withTransaction(
            Effect.gen(function* () {
              const workflowId = yield* workflowIdOfTask(taskId);
              return yield* editDraft(workflowId, (tasks) =>
                Effect.succeed(
                  tasks.map((task) =>
                    task.id === taskId
                      ? { ...task, name, teamId, instructions }
                      : task,
                  ),
                ),
              );
            }),
          );
          const task = tasks.find((task) => task.id === taskId);
          return task ?? (yield* new TaskNotFoundError({ taskId }));
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

        /** Removes the task and renumbers the rest, so steps stay dense from 1. */
        removeTask: Effect.fn("WorkflowRepository.removeTask")(function* ({
          taskId,
        }: {
          readonly taskId: string;
        }) {
          yield* relayout(taskId, (layout) =>
            WorkflowLayout.remove(layout, taskId),
          );
        }),

        unassignTeam: Effect.fn("WorkflowRepository.unassignTeam")(function* ({
          teamId,
        }: {
          readonly teamId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* decodeWorkflowRows(
                yield* sql`
                  select * from Workflow w
                  where exists (
                      select 1 from json_each(w.tasks) t
                      where json_extract(t.value, '$.teamId') = ${teamId})
                    or exists (
                      select 1 from json_each(w.draftTasks) t
                      where json_extract(t.value, '$.teamId') = ${teamId})
                `,
              );
              const unassigned = (tasks: readonly Domain.WorkflowTask[]) =>
                encodeTasks(
                  tasks.map((task) =>
                    task.teamId === teamId ? { ...task, teamId: null } : task,
                  ),
                );
              yield* Effect.forEach(
                rows,
                (row) =>
                  Effect.gen(function* () {
                    const tasks = yield* unassigned(row.tasks);
                    const draftTasks =
                      row.draftTasks === null
                        ? null
                        : yield* unassigned(row.draftTasks);
                    yield* sql`
                      update Workflow set tasks = ${tasks}, draftTasks = ${draftTasks}
                      where id = ${row.id}
                    `;
                  }),
                { discard: true },
              );
              yield* sql`update RunTask set teamId = null where teamId = ${teamId}`;
            }),
          );
        }),

        teamIdsInUse: Effect.fn("WorkflowRepository.teamIdsInUse")(
          function* () {
            const rows = yield* sql<{ readonly teamId: string }>`
              select teamId from (
                select json_extract(t.value, '$.teamId') as teamId
                from Workflow w, json_each(w.tasks) t
                union
                select json_extract(t.value, '$.teamId') as teamId
                from Workflow w, json_each(w.draftTasks) t
                union
                select teamId from RunTask
              )
              where teamId is not null
            `;
            return rows.map((row) => row.teamId);
          },
        ),
      });
    }),
  );
}

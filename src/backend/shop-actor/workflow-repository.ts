/**
 * The shop actor's workflow definitions over its SQLite.
 *
 * @module
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { SqliteBoolean, WorkflowLimits } from "../../domain/platform.ts";
import {
  type CreateWorkflowInput,
  type ListWorkflowsInput,
  prefixPatterns,
  type TaskDirection,
  type TaskInstructions,
  TaskName,
  type TeamId,
  Workflow,
  type WorkflowDetail,
  WorkflowName,
  WorkflowNameRow,
  type WorkflowsIndexData,
  type WorkflowSetupFacts,
  type WorkflowState,
  type WorkflowSummary,
  WorkflowSummaryRow,
  WorkflowTag,
  type WorkflowTask,
  WorkflowTaskId,
  WorkflowTasks,
  workflowIsActive,
} from "../../domain/shop-work.ts";
import * as WorkflowLayout from "../../domain/workflow-layout.ts";
import type { Transaction } from "./transaction.ts";

/**
 * The run path's workflow read: the active workflows whose tag is one of the
 * order's product tags, the rule on `itemMatches` (by tag, never by
 * scanning). One parameter, the tags as a JSON array. Exported for the test
 * that reads its query plan: the probe searches the unique index on
 * `Workflow.tag`.
 */
export const ACTIVE_WORKFLOWS_BY_TAGS = `select * from Workflow
  where state = 'active'
    and tag in (select value from json_each(?))
  order by name`;

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
    tag: WorkflowTag,
    workflowName: WorkflowName,
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
  { name: WorkflowName },
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
export class NoDraftError extends Schema.TaggedError<NoDraftError>()("NoDraftError", {
  workflowId: Schema.String,
}) {}

export class NoTasksError extends Schema.TaggedError<NoTasksError>()("NoTasksError", {
  workflowId: Schema.String,
}) {}

/**
 * Apply or turn-on refused because these tasks are unassigned: `teamId` null
 * (a team delete nulled it) or an id the shop's live teams does not carry (the
 * cross-store window, read as null). An empty team is deliberately not here —
 * that is a warning, never a refusal.
 */
export class TaskUnassignedError extends Schema.TaggedError<TaskUnassignedError>()(
  "TaskUnassignedError",
  { workflowId: Schema.String, taskNames: Schema.Array(TaskName) },
) {}

/** What `getWorkflow` returns: the workflow, its tasks, and the draft's tasks, `null` when there is no draft. */
export interface WorkflowWithDraftTasks extends WorkflowDetail {
  readonly draftTasks: readonly WorkflowTask[] | null;
}

/**
 * The shop's teams, read live from D1 (`MembershipRepository.listTeams`) before the repository
 * call; `memberCount` only matters to `emptyTeam`.
 */
export type Teams = readonly {
  readonly id: TeamId;
  readonly memberCount?: number;
}[];

/** The `Workflow` row's own fields, without its task documents. */
const workflowOf = ({ id, name, tag, state, updatedAt }: Workflow): Workflow => ({
  id,
  name,
  tag,
  state,
  updatedAt,
});

/** `tasks` laid out as `layout` says: each task takes its placed step, in its placed order. */
const laidOut = (
  tasks: readonly WorkflowTask[],
  layout: WorkflowLayout.Layout,
): readonly WorkflowTask[] =>
  layout
    .toSorted((a, b) => a.position - b.position)
    .flatMap((p) => {
      const task = tasks.find((t) => t.id === p.id);
      return task === undefined ? [] : [{ ...task, position: p.position, step: p.step }];
    });

/** Unassigned: `teamId` null, or an id no team in `teams` carries. */
const taskIsUnassigned = (task: WorkflowTask, teams: Teams) =>
  task.teamId === null || !teams.some((team) => team.id === task.teamId);

/** The names of the unassigned `tasks`, in position order. */
const unassignedTaskNames = (tasks: readonly WorkflowTask[], teams: Teams) =>
  tasks.filter((task) => taskIsUnassigned(task, teams)).map((task) => task.name);

const newTaskId = () => WorkflowTaskId.make(crypto.randomUUID());

/**
 * The repository over the actor's `sql`, built once per activation. Every method that runs more
 * than one statement runs it under `transaction`, and no method calls another that opens one.
 */
export const makeWorkflowRepository = (sql: SqlClient.SqlClient, transaction: Transaction) => {
  const decode =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, message: string) =>
    (rows: unknown) =>
      Schema.decodeUnknownEffect(schema)(rows).pipe(
        Effect.mapError((cause) => new WorkflowRepositoryError({ message, cause })),
      );

  const decodeWorkflows = decode(Schema.Array(Workflow), "Invalid Workflow row");

  /** A `Workflow` row with its two task documents decoded. */
  const decodeWorkflowRows = decode(
    Schema.Array(
      Schema.Struct({
        ...Workflow.fields,
        tasks: WorkflowTasks,
        draftTasks: Schema.NullOr(WorkflowTasks),
      }),
    ),
    "Invalid Workflow row",
  );

  const count = <A extends object>(query: Statement.Statement<A>) =>
    query.values.pipe(Effect.map((rows) => Number(rows[0]?.[0] ?? 0)));

  const encodeTasks = (tasks: readonly WorkflowTask[]) =>
    Schema.encodeEffect(WorkflowTasks)(tasks).pipe(
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
          onNone: () => Effect.fail(new WorkflowNotFoundError({ workflowId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const decodeIds = decode(Schema.Array(Schema.Struct({ id: Schema.String })), "Invalid id row");

  /**
   * The workflow whose draft carries `taskId`, or whose tasks do when it
   * has no draft: the list the editor is looking at. A scan of the shop's
   * workflows, bounded by `WorkflowLimits`; the editor sends a task id
   * alone.
   */
  const workflowIdOfTask = (taskId: string) =>
    Effect.gen(function* () {
      const [row] = yield* decodeIds(
        yield* sql`
          select w.id from Workflow w, json_each(coalesce(w.draftTasks, w.tasks)) t
          where json_extract(t.value, '$.id') = ${taskId}
        `,
      );
      return row === undefined ? yield* new TaskNotFoundError({ taskId }) : row.id;
    });

  /**
   * Every editor write, in the caller's transaction (it never opens one). Opening the editor is
   * not an edit: nothing is
   * written until the merchant changes something, and by then the draft
   * has to exist for the change to go anywhere. So the first write copies
   * `tasks` into `draftTasks`, ids included, and that copy is what lets
   * the editor change a task it is looking at before any draft exists:
   * the id it sends names the workflow's task now and the draft's a
   * moment later. Then `edit` runs on the draft's list and the result is
   * written whole through `WorkflowTasks`, which refuses a list
   * that breaks the step rule or the task cap. `updatedAt` moves on every
   * edit. Returns the list as written.
   */
  const editDraft = <E>(
    workflowId: string,
    edit: (tasks: readonly WorkflowTask[]) => Effect.Effect<readonly WorkflowTask[], E>,
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
    transaction(
      Effect.gen(function* () {
        const workflowId = yield* workflowIdOfTask(taskId);
        yield* editDraft(workflowId, (tasks) => Effect.succeed(laidOut(tasks, edit(tasks))));
      }),
    );

  /** The task `addStep` or `addTask` just placed, read back from the list as written so the caller sees its final step and position. */
  const addedTask = (tasks: readonly WorkflowTask[], id: WorkflowTaskId) => {
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
  const requireRoom = (tasks: readonly WorkflowTask[]) =>
    tasks.length >= WorkflowLimits.maxTasks
      ? Effect.fail(new WorkflowLimitError({ limit: WorkflowLimits.maxTasks }))
      : Effect.void;

  /** Apply and turn-on share the content checks: at least one task, every task assigned. */
  const requireEligibleTasks = (workflowId: string, tasks: readonly WorkflowTask[], teams: Teams) =>
    Effect.gen(function* () {
      if (tasks.length === 0) return yield* new NoTasksError({ workflowId });
      const taskNames = unassignedTaskNames(tasks, teams);
      if (taskNames.length > 0) return yield* new TaskUnassignedError({ workflowId, taskNames });
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
  const promoteDraft = (workflowId: string, draftTasks: readonly WorkflowTask[], teams: Teams) =>
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
    Schema.Array(Schema.Struct({ name: WorkflowName })),
    "Invalid Workflow holder row",
  );

  /**
   * Refuses `name` if another workflow has it, excluding `workflowId` so
   * a rename may keep the workflow's own name. The `unique` on
   * `Workflow.name` is the guarantee; this select exists so the refusal
   * is typed and lands under the name field. Names are compared exactly,
   * as typed (`WorkflowName` trims and nothing else). Same
   * transaction reasoning as {@link requireTagFree}.
   */
  const requireNameFree = (name: WorkflowName, workflowId: string | null) =>
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
   * exactly (`WorkflowTag` trims and nothing else), the same
   * equality `matchesTag` uses. Runs inside the caller's
   * transaction on the Durable Object's synchronous SQLite, so nothing can
   * interleave between it and the write that follows. The holder's name
   * rides back so the merchant can decide whether to change this tag or
   * go retag the other workflow; the name identifies it, since no two
   * workflows share one.
   */
  const requireTagFree = (tag: WorkflowTag, workflowId: string | null) =>
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
    readonly name: WorkflowName;
    readonly tag: WorkflowTag;
    readonly tasks: readonly WorkflowTask[];
  }) =>
    Effect.gen(function* () {
      const open = yield* count(sql`select count(*) from Workflow`);
      if (open >= WorkflowLimits.maxWorkflows)
        return yield* new WorkflowLimitError({
          limit: WorkflowLimits.maxWorkflows,
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

  const decodeSummaryRows = decode(
    Schema.Array(
      Schema.Struct({
        ...WorkflowSummaryRow.fields,
        tasks: WorkflowTasks,
      }),
    ),
    "Invalid WorkflowSummary row",
  );

  /**
   * One page of the workflows index, by `ListWorkflowsInput`'s
   * rules. `teams` is the shop's live teams: `unassigned` and `emptyTeam`
   * are derived per row from the workflow's tasks against it and never
   * stored, for the page's rows only. `WorkflowSummary`
   * carries them.
   */
  const listWorkflows = Effect.fn("WorkflowRepository.listWorkflows")(function* ({
    teams,
    limit,
    cursor,
    q,
    state,
  }: ListWorkflowsInput & { readonly teams: Teams }) {
    const search =
      q === null
        ? null
        : (() => {
            const [start, word] = prefixPatterns(q);
            return sql`(w.name like ${start} escape '\\' or w.name like ${word} escape '\\')`;
          })();
    const filter = search ?? (state === null ? sql`1 = 1` : sql`w.state = ${state}`);
    const after = cursor === null ? sql`1 = 1` : sql`w.name > ${cursor}`;
    const rows = yield* decodeSummaryRows(
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
    const emptyTeam = (task: WorkflowTask) =>
      teams.some((team) => team.id === task.teamId && team.memberCount === 0);
    const data: WorkflowsIndexData = {
      workflows: page.map(({ tasks, ...row }): WorkflowSummary => ({
        ...row,
        unassigned: tasks.some((task) => taskIsUnassigned(task, teams)),
        emptyTeam: tasks.some(emptyTeam),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.name ?? null) : null,
      matches:
        search === null ? null : yield* count(sql`select count(*) from Workflow w where ${search}`),
    };
    return data;
  });

  /**
   * Deletes the definition only: what goes and what survives is the data
   * model on the actor's `migrations`. No read joins a run
   * back to `Workflow`, so an orphan run renders, lists, starts, marks
   * done, blocks, and cancels unchanged. No turn-off-first rule.
   */
  const deleteWorkflow = Effect.fn("WorkflowRepository.deleteWorkflow")(function* ({
    workflowId,
  }: {
    readonly workflowId: string;
  }) {
    yield* transaction(
      Effect.gen(function* () {
        yield* requireWorkflowRow(workflowId);
        yield* sql`delete from Workflow where id = ${workflowId}`;
      }),
    );
  });

  /** The workflow with its tasks, and the draft's tasks, `null` when there is no draft. */
  const getWorkflow = Effect.fn("WorkflowRepository.getWorkflow")(function* ({
    workflowId,
  }: {
    readonly workflowId: string;
  }) {
    const row = yield* findWorkflowRow(workflowId);
    if (Option.isNone(row)) return Option.none<WorkflowWithDraftTasks>();
    const found: WorkflowWithDraftTasks = {
      workflow: workflowOf(row.value),
      tasks: row.value.tasks,
      draftTasks: row.value.draftTasks,
    };
    return Option.some(found);
  });

  /**
   * The active workflows whose tag is one of `tags`, with their tasks,
   * in name order: a probe of the unique `Workflow.tag`, never a scan, by
   * the rule on `itemMatches`. Reconcile reads it per order with the
   * order's product tags, inside the order's transaction; the order page
   * reads it the same way. Drafts are invisible here by construction:
   * nothing in run creation reads `draftTasks`.
   */
  const listActiveWorkflowsByTags = Effect.fn("WorkflowRepository.listActiveWorkflowsByTags")(
    function* ({ tags }: { readonly tags: readonly string[] }) {
      const rows = yield* decodeWorkflowRows(
        yield* sql.unsafe(ACTIVE_WORKFLOWS_BY_TAGS, [JSON.stringify(tags)]),
      );
      return rows.map((row): WorkflowDetail => ({
        workflow: workflowOf(row),
        tasks: row.tasks,
      }));
    },
  );

  const decodeSetupFacts = decode(
    Schema.Array(
      Schema.Struct({
        activeWorkflow: SqliteBoolean,
        run: SqliteBoolean,
      }),
    ),
    "Invalid setup facts row",
  );

  /**
   * The object's half of `SetupFacts`, in one statement: some
   * workflow is active, and some run exists in any state. Each `exists`
   * stops at its first row: `Workflow` holds at most
   * `WorkflowLimits.maxWorkflows` rows, and `Run` is read through its
   * primary key.
   */
  const workflowSetupFacts = Effect.fn("WorkflowRepository.workflowSetupFacts")(function* () {
    const [row] = yield* decodeSetupFacts(
      yield* sql`
        select
          exists (select 1 from Workflow where state = 'active') as activeWorkflow,
          exists (select 1 from Run) as run
      `,
    );
    const facts: WorkflowSetupFacts = row ?? { activeWorkflow: false, run: false };
    return facts;
  });

  const decodeNameRows = decode(Schema.Array(WorkflowNameRow), "Invalid Workflow name row");

  /** Every active workflow with tasks, by name: the Workflow select's options past the order's matches. */
  const listActiveWorkflowNames = Effect.fn("WorkflowRepository.listActiveWorkflowNames")(
    function* () {
      return yield* decodeNameRows(
        yield* sql`
          select id, name from Workflow
          where state = 'active' and json_array_length(tasks) > 0
          order by name
        `,
      );
    },
  );

  /**
   * Inserts the workflow: inactive, no tasks, carrying its tag, and **no draft**.
   * The draft is the editor's record of unsaved changes and is created by
   * the first change (`editDraft`), so a fresh workflow has none and the
   * editor opens without a Discard button for nothing. The name, then the
   * tag, is checked before the insert so the dialog can put the refusal
   * under the field that caused it.
   *
   * The name and the tag are asked about before the insert, inside one
   * transaction: both are unique, and each refusal has to land under
   * its own field, which a `unique` constraint failure cannot say. The
   * name goes first because the dialog prefills the tag from it, so a
   * new name usually frees both.
   */
  const createWorkflow = Effect.fn("WorkflowRepository.createWorkflow")(function* ({
    name,
    tag,
  }: CreateWorkflowInput) {
    return yield* transaction(insertWorkflow({ name, tag, tasks: [] }));
  });

  /**
   * A copy of the workflow's tasks, with their steps under new ids, under
   * the name and tag the merchant chose in the Duplicate dialog; inactive, with
   * no draft. The name, then the tag, is checked before the insert, as in
   * `createWorkflow`.
   */
  const duplicateWorkflow = Effect.fn("WorkflowRepository.duplicateWorkflow")(function* ({
    workflowId,
    name,
    tag,
  }: {
    readonly workflowId: string;
    readonly name: WorkflowName;
    readonly tag: WorkflowTag;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        const source = yield* requireWorkflowRow(workflowId);
        return yield* insertWorkflow({
          name,
          tag,
          tasks: source.tasks.map((task) => ({
            ...task,
            id: newTaskId(),
          })),
        });
      }),
    );
  });

  /** Rename only; immediate, since runs snapshot the name. Refuses a name another workflow has. */
  const updateWorkflow = Effect.fn("WorkflowRepository.updateWorkflow")(function* ({
    workflowId,
    name,
  }: {
    readonly workflowId: string;
    readonly name: WorkflowName;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* requireWorkflowRow(workflowId);
        yield* requireNameFree(name, workflowId);
        return yield* updateWorkflowRow(workflowId, sql`name = ${name}`);
      }),
    );
  });

  /**
   * Writes the tag on the workflow row immediately, like a rename, and
   * creates no draft: runs snapshot the tag at start, so nothing in flight
   * moves. Refuses a tag another workflow holds, active or inactive.
   */
  const updateWorkflowTag = Effect.fn("WorkflowRepository.updateWorkflowTag")(function* ({
    workflowId,
    tag,
  }: {
    readonly workflowId: string;
    readonly tag: WorkflowTag;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* requireWorkflowRow(workflowId);
        yield* requireTagFree(tag, workflowId);
        return yield* updateWorkflowRow(workflowId, sql`tag = ${tag}`);
      }),
    );
  });

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
  const setWorkflowState = Effect.fn("WorkflowRepository.setWorkflowState")(function* ({
    workflowId,
    state,
    teams,
  }: {
    readonly workflowId: string;
    readonly state: WorkflowState;
    readonly teams: Teams;
  }) {
    const row = yield* requireWorkflowRow(workflowId);
    if (workflowIsActive({ state })) yield* requireEligibleTasks(workflowId, row.tasks, teams);
    return yield* updateWorkflowRow(workflowId, sql`state = ${state}`);
  });

  /**
   * The draft, made explicitly: the existing draft's tasks when there is
   * one, otherwise `draftTasks` becomes a copy of `tasks`, ids included,
   * in one statement. The editor does not call this — its writes create the
   * draft themselves — so this is for a caller that wants a draft without
   * changing anything.
   */
  const createDraft = Effect.fn("WorkflowRepository.createDraft")(function* ({
    workflowId,
  }: {
    readonly workflowId: string;
  }) {
    return yield* transaction(
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
  });

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
  const applyDraft = Effect.fn("WorkflowRepository.applyDraft")(function* ({
    workflowId,
    teams,
  }: {
    readonly workflowId: string;
    readonly teams: Teams;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* requireWorkflowRow(workflowId);
        if (row.draftTasks === null) return yield* new NoDraftError({ workflowId });
        yield* promoteDraft(workflowId, row.draftTasks, teams);
        return workflowOf(yield* requireWorkflowRow(workflowId));
      }),
    );
  });

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
  const applyAndTurnOn = Effect.fn("WorkflowRepository.applyAndTurnOn")(function* ({
    workflowId,
    teams,
  }: {
    readonly workflowId: string;
    readonly teams: Teams;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* requireWorkflowRow(workflowId);
        if (row.draftTasks !== null) yield* promoteDraft(workflowId, row.draftTasks, teams);
        yield* requireEligibleTasks(workflowId, row.draftTasks ?? row.tasks, teams);
        return yield* updateWorkflowRow(workflowId, sql`state = 'active'`);
      }),
    );
  });

  /** Clears the draft. Always allowed; a never-applied workflow is left with zero tasks. */
  const discardDraft = Effect.fn("WorkflowRepository.discardDraft")(function* ({
    workflowId,
  }: {
    readonly workflowId: string;
  }) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* requireWorkflowRow(workflowId);
        if (row.draftTasks === null) return yield* new NoDraftError({ workflowId });
        return yield* updateWorkflowRow(workflowId, sql`draftTasks = null`);
      }),
    );
  });

  /** New task in a new last step of the draft, creating the draft if this is the first change. */
  const addStep = Effect.fn("WorkflowRepository.addStep")(function* ({
    workflowId,
    name,
    teamId,
    instructions,
  }: {
    readonly workflowId: string;
    readonly name: TaskName;
    readonly teamId: TeamId;
    readonly instructions?: TaskInstructions | null;
  }) {
    const id = newTaskId();
    const tasks = yield* transaction(
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
  });

  /**
   * New task into an existing `step` of the draft, after that step's last task: the new task
   * lands right after the target step's last member (`WorkflowLayout.appendTask`).
   */
  const addTask = Effect.fn("WorkflowRepository.addTask")(function* ({
    workflowId,
    step,
    name,
    teamId,
    instructions,
  }: {
    readonly workflowId: string;
    readonly step: number;
    readonly name: TaskName;
    readonly teamId: TeamId;
    readonly instructions?: TaskInstructions | null;
  }) {
    const id = newTaskId();
    const tasks = yield* transaction(
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
  });

  /**
   * A task the editor can act on, with its workflow: the draft's when
   * there is a draft, otherwise the workflow's own — the same id either way
   * (`editDraft`). A read, so it creates nothing.
   */
  const getTask = Effect.fn("WorkflowRepository.getTask")(function* ({
    taskId,
  }: {
    readonly taskId: string;
  }) {
    const workflowId = yield* workflowIdOfTask(taskId).pipe(
      Effect.map(Option.some),
      Effect.catchTag("TaskNotFoundError", () => Effect.succeedNone),
    );
    if (Option.isNone(workflowId))
      return Option.none<{ readonly task: WorkflowTask; readonly workflow: Workflow }>();
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
    const task = (row.draftTasks ?? row.tasks).find((task) => task.id === taskId);
    return task === undefined ? Option.none() : Option.some({ task, workflow: workflowOf(row) });
  });

  /**
   * The task-id writes below all land on the draft, creating it from the
   * workflow when this is the first change (`editDraft`).
   * `instructions: null` clears.
   */
  const updateTask = Effect.fn("WorkflowRepository.updateTask")(function* ({
    taskId,
    name,
    teamId,
    instructions,
  }: {
    readonly taskId: string;
    readonly name: TaskName;
    readonly teamId: TeamId;
    readonly instructions: TaskInstructions | null;
  }) {
    const tasks = yield* transaction(
      Effect.gen(function* () {
        const workflowId = yield* workflowIdOfTask(taskId);
        return yield* editDraft(workflowId, (tasks) =>
          Effect.succeed(
            tasks.map((task) =>
              task.id === taskId ? { ...task, name, teamId, instructions } : task,
            ),
          ),
        );
      }),
    );
    const task = tasks.find((task) => task.id === taskId);
    return task ?? (yield* new TaskNotFoundError({ taskId }));
  });

  /**
   * The moved task always ends alone in its step; other tasks keep their
   * step-mates. A move past either edge is a no-op, not an error.
   */
  const moveTask = Effect.fn("WorkflowRepository.moveTask")(function* ({
    taskId,
    direction,
  }: {
    readonly taskId: string;
    readonly direction: TaskDirection;
  }) {
    yield* relayout(taskId, (layout) => WorkflowLayout.move(layout, taskId, direction));
  });

  /** The task leaves its step into a new one of its own right after it; no-op when already alone. */
  const separateTask = Effect.fn("WorkflowRepository.separateTask")(function* ({
    taskId,
  }: {
    readonly taskId: string;
  }) {
    yield* relayout(taskId, (layout) => WorkflowLayout.separate(layout, taskId));
  });

  /**
   * The task joins the previous step, last among its members; no-op in
   * step 1. Lands on the draft, creating it on first change, like every
   * task-id write.
   */
  const joinTask = Effect.fn("WorkflowRepository.joinTask")(function* ({
    taskId,
  }: {
    readonly taskId: string;
  }) {
    yield* relayout(taskId, (layout) => WorkflowLayout.join(layout, taskId));
  });

  /** Removes the task and renumbers the rest, so steps stay dense from 1. */
  const removeTask = Effect.fn("WorkflowRepository.removeTask")(function* ({
    taskId,
  }: {
    readonly taskId: string;
  }) {
    yield* relayout(taskId, (layout) => WorkflowLayout.remove(layout, taskId));
  });

  /**
   * The object-side half of a team delete: every workflow task, draft task
   * and run task that points at `teamId` becomes unassigned, in one
   * transaction, done or not and whatever the run's state. A run task
   * keeps its `teamName` snapshot, which is all history reads; the pointer
   * on a done or closed task had no reader once the team was gone, because
   * every team-scoped list takes its team ids from D1 (the data model on
   * the actor's `migrations`). Idempotent, so a
   * retry after a failed first attempt (D1 row already gone) still cleans
   * up. The task documents are rewritten through `WorkflowTasks`,
   * read, edited and written whole, so the stored list stays one the
   * `Schema` accepts. Touches `RunTask` from here
   * rather than from the run repository because the writes must
   * share one transaction, and transactions are never nested.
   */
  const unassignTeam = Effect.fn("WorkflowRepository.unassignTeam")(function* ({
    teamId,
  }: {
    readonly teamId: string;
  }) {
    yield* transaction(
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
        const unassigned = (tasks: readonly WorkflowTask[]) =>
          encodeTasks(
            tasks.map((task) => (task.teamId === teamId ? { ...task, teamId: null } : task)),
          );
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const tasks = yield* unassigned(row.tasks);
              const draftTasks = row.draftTasks === null ? null : yield* unassigned(row.draftTasks);
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
  });

  const decodeTeamIds = decode(
    Schema.Array(Schema.Struct({ teamId: Schema.String })),
    "Invalid team id row",
  );

  /**
   * Every team id a workflow task, draft task or run task points to, each
   * once. A team delete reads it to find pointers to teams already gone
   * from D1, the repair half of the team-delete row on `D1_TABLES`.
   */
  const teamIdsInUse = Effect.fn("WorkflowRepository.teamIdsInUse")(function* () {
    const rows = yield* decodeTeamIds(
      yield* sql`
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
      `,
    );
    return rows.map((row) => row.teamId);
  });

  return {
    listWorkflows,
    deleteWorkflow,
    getWorkflow,
    listActiveWorkflowsByTags,
    workflowSetupFacts,
    listActiveWorkflowNames,
    createWorkflow,
    duplicateWorkflow,
    updateWorkflow,
    updateWorkflowTag,
    setWorkflowState,
    createDraft,
    applyDraft,
    applyAndTurnOn,
    discardDraft,
    addStep,
    addTask,
    getTask,
    updateTask,
    moveTask,
    separateTask,
    joinTask,
    removeTask,
    unassignTeam,
    teamIdsInUse,
  };
};

/** The actor's workflow repository; see {@link makeWorkflowRepository}. */
export type WorkflowRepository = ReturnType<typeof makeWorkflowRepository>;

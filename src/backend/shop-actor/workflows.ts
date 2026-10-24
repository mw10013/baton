import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ORDERS_KEY } from "../../contract/shop-actor.ts";
import type { ShopKey } from "../../domain/platform.ts";
import {
  type AddStepInput,
  type AddTaskInput,
  type ApplyAndTurnOnInput,
  type ApplyDraftInput,
  type ApplyResult,
  type CreateWorkflowInput,
  type DeleteWorkflowInput,
  type DeleteWorkflowResult,
  type DiscardDraftInput,
  type DiscardResult,
  type DuplicateWorkflowInput,
  type JoinTaskInput,
  type ListWorkflowsInput,
  type MoveTaskInput,
  type RemoveTaskInput,
  type SeparateTaskInput,
  type SetWorkflowStateInput,
  type SwitchResult,
  type TaskResult,
  type TaskWithTeamName,
  type TeamWithMemberCount,
  type UpdateTaskInput,
  type UpdateWorkflowInput,
  type UpdateWorkflowTagInput,
  type Workflow,
  type WorkflowIdInput,
  type WorkflowPageData,
  type WorkflowResult,
  type WorkflowTask,
  workflowIsActive,
} from "../../domain/shop-work.ts";
import type * as SqlError from "effect/sql/SqlError";
import type { MembershipRepository } from "../membership-repository.ts";
import type {
  NoDraftError,
  NoTasksError,
  StepNotFoundError,
  TaskNotFoundError,
  TasksChangedError,
  TaskUnassignedError,
  WorkflowLimitError,
  WorkflowNameTakenError,
  WorkflowNotFoundError,
  WorkflowRepository,
  WorkflowRepositoryError,
  WorkflowTagTakenError,
} from "./workflow-repository.ts";

/** A repository fault: storage or a row that does not decode, never an answer. */
type Fault = SqlError.SqlError | WorkflowRepositoryError;

/**
 * Maps the repository's expected failures onto the tagged result union the
 * page decodes. Expected failures are *values* here: the screens switch on the
 * union's `_tag` and tell "name taken" or "tag taken" (field errors) from "limit reached" (a
 * banner). A fault (`SqlError`, a decode) is a defect, which the browser reads as `thrownCopy`.
 */
const workflowResult = <R>(
  effect: Effect.Effect<
    Workflow,
    | WorkflowNameTakenError
    | WorkflowTagTakenError
    | WorkflowNotFoundError
    | WorkflowLimitError
    | Fault,
    R
  >,
): Effect.Effect<WorkflowResult, never, R> =>
  effect.pipe(
    Effect.map((workflow): WorkflowResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowNameTakenError: ({ name }) =>
        Effect.succeed<WorkflowResult>({ _tag: "NameTaken", name }),
      WorkflowTagTakenError: ({ tag, workflowName }) =>
        Effect.succeed<WorkflowResult>({
          _tag: "TagTaken",
          tag,
          workflowName,
        }),
      WorkflowNotFoundError: () => Effect.succeed<WorkflowResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) => Effect.succeed<WorkflowResult>({ _tag: "Limit", limit }),
    }),
    Effect.orDie,
  );

const applyResult = <R>(
  effect: Effect.Effect<
    Workflow,
    | WorkflowNotFoundError
    | TasksChangedError
    | NoDraftError
    | NoTasksError
    | TaskUnassignedError
    | Fault,
    R
  >,
): Effect.Effect<ApplyResult, never, R> =>
  effect.pipe(
    Effect.map((workflow): ApplyResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      TasksChangedError: () => Effect.succeed<ApplyResult>({ _tag: "Changed" }),
      WorkflowNotFoundError: () => Effect.succeed<ApplyResult>({ _tag: "NotFound" }),
      NoDraftError: () => Effect.succeed<ApplyResult>({ _tag: "NoDraft" }),
      NoTasksError: () => Effect.succeed<ApplyResult>({ _tag: "NoTasks" }),
      TaskUnassignedError: ({ taskNames }) =>
        Effect.succeed<ApplyResult>({
          _tag: "TaskUnassigned",
          taskNames,
        }),
    }),
    Effect.orDie,
  );

const discardResult = <R>(
  effect: Effect.Effect<
    Workflow,
    WorkflowNotFoundError | TasksChangedError | NoDraftError | Fault,
    R
  >,
): Effect.Effect<DiscardResult, never, R> =>
  effect.pipe(
    Effect.map((workflow): DiscardResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      TasksChangedError: () => Effect.succeed<DiscardResult>({ _tag: "Changed" }),
      WorkflowNotFoundError: () => Effect.succeed<DiscardResult>({ _tag: "NotFound" }),
      NoDraftError: () => Effect.succeed<DiscardResult>({ _tag: "NoDraft" }),
    }),
    Effect.orDie,
  );

const switchResult = <R>(
  effect: Effect.Effect<
    Workflow,
    WorkflowNotFoundError | TasksChangedError | NoTasksError | TaskUnassignedError | Fault,
    R
  >,
): Effect.Effect<SwitchResult, never, R> =>
  effect.pipe(
    Effect.map((workflow): SwitchResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      TasksChangedError: () => Effect.succeed<SwitchResult>({ _tag: "Changed" }),
      WorkflowNotFoundError: () => Effect.succeed<SwitchResult>({ _tag: "NotFound" }),
      NoTasksError: () => Effect.succeed<SwitchResult>({ _tag: "NoTasks" }),
      TaskUnassignedError: ({ taskNames }) =>
        Effect.succeed<SwitchResult>({
          _tag: "TaskUnassigned",
          taskNames,
        }),
    }),
    Effect.orDie,
  );

const taskResult = <R>(
  effect: Effect.Effect<
    TaskResult,
    | TaskNotFoundError
    | StepNotFoundError
    | WorkflowNotFoundError
    | TasksChangedError
    | WorkflowLimitError
    | Fault,
    R
  >,
): Effect.Effect<TaskResult, never, R> =>
  effect.pipe(
    Effect.catchTags({
      TasksChangedError: () => Effect.succeed<TaskResult>({ _tag: "Changed" }),
      TaskNotFoundError: () => Effect.succeed<TaskResult>({ _tag: "NotFound" }),
      StepNotFoundError: () => Effect.succeed<TaskResult>({ _tag: "NotFound" }),
      WorkflowNotFoundError: () => Effect.succeed<TaskResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) => Effect.succeed<TaskResult>({ _tag: "Limit", limit }),
    }),
    Effect.orDie,
  );

/**
 * A write notifies only after it succeeded: a refused call wrote nothing a screen shows, so a
 * notice would cost every live screen a refetch for no change. The refused tab is not left stale
 * by this: it invalidates its own loader on every answer.
 */
const notifyIfOk =
  <R>(notify: (invalidated: ReadonlyArray<string>) => Effect.Effect<void, never, R>) =>
  (result: { readonly _tag: string }) =>
    result._tag === "Ok" ? notify([ORDERS_KEY]) : Effect.void;

/**
 * The merchant's workflow definitions as the shop's actor runs them: one method per `Merchant…`
 * workflow procedure, each answering its result union, plus the three stub reads. Built once per
 * activation over the actor's {@link WorkflowRepository}, the Backend's `MembershipRepository`
 * (the shop's live teams), the reconcile seam, the actor's `notify` and its shop.
 *
 * The live teams are read from D1 before the repository call, never inside its transaction: a
 * storage transaction holds the input gate and runs on a sync scheduler, and a binding call has
 * no place inside it, and D1 cannot join a Durable Object transaction anyway. A D1 read opens
 * the input gate, so a second press or a team delete can run between the team check and the
 * write; `Membership.deleteTeam`'s order (D1 first, then null every pointer) closes that window.
 *
 * `reconcileAll` is the runs service's, which the actor passes, called directly or through
 * {@link reconcileAllIfActive}; it reads the teams and opens one transaction per order after the
 * definition write. A write that changes which workflows an order page's Workflow select lists
 * notifies `ORDERS_KEY` on `Ok` (Edit tag, Apply, the switch, Turn on; delete on `Deleted`);
 * nothing reads workflows live, so there is no workflows key.
 */
export const makeWorkflows = <R>({
  repository,
  membershipRepository,
  reconcileAll,
  notify,
  shop,
}: {
  readonly repository: WorkflowRepository;
  readonly membershipRepository: (typeof MembershipRepository)["Service"];
  readonly reconcileAll: (caller: string, id: string) => Effect.Effect<void, never, R>;
  readonly notify: (invalidated: ReadonlyArray<string>) => Effect.Effect<void, never, R>;
  readonly shop: ShopKey;
}) => {
  const log = (message: string, annotations: Record<string, unknown>) =>
    Effect.logInfo(message).pipe(Effect.annotateLogs({ shop, ...annotations }));

  /**
   * The shop's teams, read live from D1 with member counts, read fresh on every call: it is
   * what every task pointer is resolved against (an id not in it is
   * unassigned) and what the empty-team warnings are computed from.
   */
  const teams = () =>
    membershipRepository.listTeams(shop).pipe(
      Effect.map((teams) =>
        teams.map(({ id, name, memberCount }): TeamWithMemberCount => ({
          id,
          name,
          memberCount,
        })),
      ),
    );

  /**
   * The team check lives here, not in the repository: `Team` is a D1 row the
   * Durable Object's SQLite cannot reference, so "team exists" is an
   * application invariant. Checked against the shop's live teams on every write.
   * `Membership.deleteTeam` reads D1 first and nulls pointers second precisely so a
   * write that passes this check can still be caught by the nulling — see
   * that method.
   */
  const teamExists = (teamId: string) =>
    teams().pipe(Effect.map((teams) => teams.find((team) => team.id === teamId) ?? null));

  /**
   * {@link reconcileAll}, skipped when the workflow is inactive: for the
   * definition writes (Apply, Edit tag) that change *how* a workflow
   * matches. An inactive workflow matches nothing either way, so nothing about the
   * active workflows changed and the pass would be a full scan for no writes. Turn
   * off and delete do move it, and call `reconcileAll` directly.
   */
  const reconcileAllIfActive = (caller: string, workflow: Workflow) =>
    workflowIsActive(workflow) ? reconcileAll(caller, workflow.id) : Effect.void;

  /**
   * The object's half of `SetupFacts`, for the home page's
   * loader. Not memoized: the guide is read on a loader, never on a notice.
   */
  const workflowSetupFacts = Effect.fn("Workflows.workflowSetupFacts")(function* () {
    return yield* repository.workflowSetupFacts();
  }, Effect.orDie);

  const listWorkflows = Effect.fn("Workflows.listWorkflows")(function* (input: ListWorkflowsInput) {
    return yield* repository.listWorkflows({ ...input, teams: yield* teams() });
  }, Effect.orDie);

  /**
   * Joins team names from D1 inside the object rather than in a server function: the
   * actor already holds `MembershipRepository`, and one round trip returns the tasks,
   * their resolved team names and member counts, and the teams the Assign team select
   * needs. Unassigned and empty team are derived here and never stored: a task
   * whose `teamId` is null or names no team resolves to `teamName: null`
   * (unassigned — warned, never blocked in the editor, since the risk is
   * when a run is created); a task on a team with no members carries
   * `memberCount: 0`. Assigning a team or adding a member clears either with
   * no other write.
   */
  const getWorkflowDetail = Effect.fn("Workflows.getWorkflowDetail")(function* ({
    workflowId,
  }: WorkflowIdInput) {
    const detail = yield* repository.getWorkflow({ workflowId });
    if (Option.isNone(detail)) return null;
    const shopTeams = yield* teams();
    const teamOf = new Map(shopTeams.map((team) => [team.id, team]));
    const withTeamNames = (tasks: readonly WorkflowTask[]): TaskWithTeamName[] =>
      tasks.map((task) => {
        const team = task.teamId === null ? undefined : teamOf.get(task.teamId);
        return {
          ...task,
          teamName: team?.name ?? null,
          memberCount: team?.memberCount ?? null,
        };
      });
    const data: WorkflowPageData = {
      workflow: detail.value.workflow,
      tasksRevision: detail.value.tasksRevision,
      tasks: withTeamNames(detail.value.tasks),
      draftTasks: detail.value.draftTasks === null ? null : withTeamNames(detail.value.draftTasks),
      teams: shopTeams,
    };
    return data;
  }, Effect.orDie);

  const createWorkflow = (input: CreateWorkflowInput) =>
    workflowResult(repository.createWorkflow(input));

  /** Duplicate: the new workflow is inactive, keeps the tasks, and takes the name and tag the dialog collected (`duplicateWorkflow` on the repository). */
  const duplicateWorkflow = ({ workflowId, name, tag }: DuplicateWorkflowInput) =>
    workflowResult(
      Effect.gen(function* () {
        const copy = yield* repository.duplicateWorkflow({ workflowId, name, tag });
        yield* log(
          `Workflows.duplicateWorkflow: shop=${shop} workflowId=${workflowId} copyId=${copy.id}`,
          { workflowId, copyId: copy.id },
        );
        return copy;
      }),
    );

  const updateWorkflow = ({ workflowId, name }: UpdateWorkflowInput) =>
    workflowResult(repository.updateWorkflow({ workflowId, name }));

  /**
   * Immediate, like `updateWorkflow`: lands on the workflow row, never the
   * draft. Unlike a rename it changes how the workflow matches, so an on
   * workflow reconciles every stored order once afterwards, as Apply does:
   * an order already in Baton whose product carries the new tag starts now,
   * not on Shopify's next edit. Runs in flight are untouched: a run snapshots
   * its workflow (the data model on the actor's `migrations`). Notifies because
   * the order pages read the reconcile, and notifies whether or not the pass ran or moved a run:
   * Edit tag changes which orders match, which the
   * order page's Workflow select shows as matched; that is not a run write,
   * so there is no count to gate on.
   */
  const updateWorkflowTag = ({ workflowId, tag }: UpdateWorkflowTagInput) =>
    workflowResult(
      Effect.gen(function* () {
        const workflow = yield* repository.updateWorkflowTag({ workflowId, tag });
        yield* log(
          `Workflows.updateWorkflowTag: shop=${shop} workflowId=${workflowId} tag=${tag}`,
          {
            workflowId,
            tag,
          },
        );
        yield* reconcileAllIfActive("updateWorkflowTag", workflow);
        return workflow;
      }),
    ).pipe(Effect.tap(notifyIfOk(notify)));

  /**
   * Apply changes. On an active workflow, reconciles every stored order once
   * afterwards: new tasks can make a workflow eligible for an item it was not, and those
   * orders should start now rather than at whatever moment Shopify next edits
   * them. Notifies because the next order starts against the new tasks,
   * which the order page's Workflow selects reflect, and notifies whether
   * or not the pass ran or moved a run: Apply changes
   * what the Workflow select lists, which is not a run write, so there is no
   * count to gate on.
   */
  const applyDraft = ({ workflowId, tasksRevision }: ApplyDraftInput) =>
    applyResult(
      Effect.gen(function* () {
        const workflow = yield* repository.applyDraft({
          workflowId,
          tasksRevision,
          teams: yield* teams(),
        });
        yield* log(`Workflows.applyDraft: shop=${shop} workflowId=${workflowId}`, { workflowId });
        yield* reconcileAllIfActive("applyDraft", workflow);
        return workflow;
      }),
    ).pipe(Effect.tap(notifyIfOk(notify)));

  const discardDraft = ({ workflowId, tasksRevision }: DiscardDraftInput) =>
    discardResult(
      Effect.gen(function* () {
        const workflow = yield* repository.discardDraft({ workflowId, tasksRevision });
        yield* log(`Workflows.discardDraft: shop=${shop} workflowId=${workflowId}`, { workflowId });
        return workflow;
      }),
    );

  /**
   * The switch: writes `state`. Either way every stored order is reconciled
   * once, so a run for anything that now qualifies is created here rather than at whatever
   * moment Shopify next edits it — and turning off qualifies things too, because
   * removing one of two matching workflows resolves a multi-match and starts
   * the survivor. Notifies for the reason on
   * {@link applyDraft}.
   */
  const setWorkflowState = ({ workflowId, state }: SetWorkflowStateInput) =>
    switchResult(
      Effect.gen(function* () {
        const workflow = yield* repository.setWorkflowState({
          workflowId,
          state,
          teams: yield* teams(),
        });
        yield* log(
          `Workflows.setWorkflowState: shop=${shop} workflowId=${workflowId} state=${state}`,
          { workflowId, state },
        );
        yield* reconcileAll("setWorkflowState", workflow.id);
        return workflow;
      }),
    ).pipe(Effect.tap(notifyIfOk(notify)));

  /**
   * The editor's Turn on for a workflow that has never been applied: applies
   * the draft and turns the switch on in one transaction, then reconciles
   * every stored order once, exactly as {@link setWorkflowState} does — the
   * merchant made one decision, so a failure must leave the workflow
   * untouched rather than applied and inactive.
   */
  const applyAndTurnOn = ({ workflowId, tasksRevision }: ApplyAndTurnOnInput) =>
    switchResult(
      Effect.gen(function* () {
        const workflow = yield* repository.applyAndTurnOn({
          workflowId,
          tasksRevision,
          teams: yield* teams(),
        });
        yield* log(`Workflows.applyAndTurnOn: shop=${shop} workflowId=${workflowId}`, {
          workflowId,
        });
        yield* reconcileAll("applyAndTurnOn", workflow.id);
        return workflow;
      }),
    ).pipe(Effect.tap(notifyIfOk(notify)));

  /**
   * Delete a workflow and its runs stay on their orders (the rule is
   * the data model on the actor's `migrations`). Notifies because any order page's Workflow
   * select, which lists workflows, must repaint.
   *
   * Reconciles afterwards for the same reason Turn off does: the deleted
   * workflow turns off, so an item it made a multi-match now has one
   * match and the survivor's run is created.
   */
  const deleteWorkflow = ({ workflowId }: DeleteWorkflowInput) =>
    Effect.gen(function* () {
      yield* repository.deleteWorkflow({ workflowId });
      yield* log(`Workflows.deleteWorkflow: shop=${shop} workflowId=${workflowId}`, {
        workflowId,
      });
      yield* reconcileAll("deleteWorkflow", workflowId);
      yield* notify([ORDERS_KEY]);
      const result: DeleteWorkflowResult = { _tag: "Deleted" };
      return result;
    }).pipe(
      Effect.catchTags({
        WorkflowNotFoundError: () => Effect.succeed<DeleteWorkflowResult>({ _tag: "NotFound" }),
      }),
      Effect.orDie,
    );

  const addStep = ({ workflowId, tasksRevision, name, teamId, instructions }: AddStepInput) =>
    taskResult(
      Effect.gen(function* () {
        const team = yield* teamExists(teamId);
        if (team === null) return { _tag: "TeamNotFound" } as const;
        const task = yield* repository.addStep({
          workflowId,
          tasksRevision,
          name,
          teamId: team.id,
          instructions: instructions ?? null,
        });
        return { _tag: "Ok", task } as const;
      }),
    );

  /** `StepNotFoundError` surfaces as `NotFound`: the step the editor showed was closed by a concurrent edit. */
  const addTask = ({ workflowId, tasksRevision, step, name, teamId, instructions }: AddTaskInput) =>
    taskResult(
      Effect.gen(function* () {
        const team = yield* teamExists(teamId);
        if (team === null) return { _tag: "TeamNotFound" } as const;
        const task = yield* repository.addTask({
          workflowId,
          tasksRevision,
          step,
          name,
          teamId: team.id,
          instructions: instructions ?? null,
        });
        yield* log(
          `Workflows.addTask: shop=${shop} workflowId=${workflowId} step=${String(step)}`,
          { workflowId, step },
        );
        return { _tag: "Ok", task } as const;
      }),
    );

  const updateTask = ({ taskId, tasksRevision, name, teamId, instructions }: UpdateTaskInput) =>
    taskResult(
      Effect.gen(function* () {
        const team = yield* teamExists(teamId);
        if (team === null) return { _tag: "TeamNotFound" } as const;
        const task = yield* repository.updateTask({
          taskId,
          tasksRevision,
          name,
          teamId: team.id,
          instructions,
        });
        return { _tag: "Ok", task } as const;
      }),
    );

  const moveTask = ({ taskId, tasksRevision, direction }: MoveTaskInput) =>
    taskResult(
      Effect.gen(function* () {
        yield* repository.moveTask({ taskId, tasksRevision, direction });
        return { _tag: "Ok", task: null } as const;
      }),
    );

  const separateTask = ({ taskId, tasksRevision }: SeparateTaskInput) =>
    taskResult(
      Effect.gen(function* () {
        const existing = yield* repository.getTask({ taskId });
        if (Option.isNone(existing)) return { _tag: "NotFound" } as const;
        yield* repository.separateTask({ taskId, tasksRevision });
        const workflowId = existing.value.workflow.id;
        const step = existing.value.task.step;
        yield* log(
          `Workflows.separateTask: shop=${shop} workflowId=${workflowId} step=${String(step)}`,
          { workflowId, step },
        );
        return { _tag: "Ok", task: null } as const;
      }),
    );

  const joinTask = ({ taskId, tasksRevision }: JoinTaskInput) =>
    taskResult(
      Effect.gen(function* () {
        const existing = yield* repository.getTask({ taskId });
        if (Option.isNone(existing)) return { _tag: "NotFound" } as const;
        yield* repository.joinTask({ taskId, tasksRevision });
        const workflowId = existing.value.workflow.id;
        const step = existing.value.task.step;
        yield* log(
          `Workflows.joinTask: shop=${shop} workflowId=${workflowId} step=${String(step)}`,
          { workflowId, step },
        );
        return { _tag: "Ok", task: null } as const;
      }),
    );

  const removeTask = ({ taskId, tasksRevision }: RemoveTaskInput) =>
    taskResult(
      Effect.gen(function* () {
        yield* repository.removeTask({ taskId, tasksRevision });
        return { _tag: "Ok", task: null } as const;
      }),
    );

  return {
    workflowSetupFacts,
    listWorkflows,
    getWorkflowDetail,
    createWorkflow,
    duplicateWorkflow,
    updateWorkflow,
    updateWorkflowTag,
    applyDraft,
    discardDraft,
    setWorkflowState,
    applyAndTurnOn,
    deleteWorkflow,
    addStep,
    addTask,
    updateTask,
    moveTask,
    separateTask,
    joinTask,
    removeTask,
  };
};

/** The actor's workflows application service; see {@link makeWorkflows}. */
export type Workflows<R = never> = ReturnType<typeof makeWorkflows<R>>;

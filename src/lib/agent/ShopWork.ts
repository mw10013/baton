import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository, type RepositoryError } from "@/lib/Repository";
import {
  workflowIsEligible,
  type EligibleContext,
  RunNotAllowedError,
  type RunNotBlockedError,
  RunNotFoundError,
  type RunTerminalError,
  type RunBlockedError,
  type RunOrderClosedError,
  type TaskNotReadyError,
  type TaskReopenBlockedError,
  RunRepository,
  type RunRepositoryError,
} from "@/lib/RunRepository";
import {
  type NoDraftError,
  type NoTasksError,
  type StepNotFoundError,
  type TaskNotFoundError,
  type TaskUnassignedError,
  type WorkflowLimitError,
  type WorkflowNotFoundError,
  type WorkflowOffError,
  type WorkflowNameTakenError,
  type WorkflowTagTakenError,
  WorkflowRepository,
  WorkflowRepositoryError,
} from "@/lib/WorkflowRepository";

import { BillingAgent } from "./Billing.ts";
import {
  type PublishScope,
  type PublishTeams,
  ShopAgentHost,
  unionTeams,
} from "./Host.ts";

/**
 * Maps the repository's expected failures onto the tagged result union the
 * page decodes, leaving faults (`SqlError`, decode errors) to propagate and
 * become a thrown `Error` at the class's `runEffect` seam. Expected failures must be
 * *values* here because that seam collapses every failure into one message
 * string, which would leave the browser unable to tell "name taken" or "tag
 * taken" (field errors) from "limit reached" (a banner).
 */
const workflowResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
    | WorkflowNameTakenError
    | WorkflowTagTakenError
    | WorkflowNotFoundError
    | WorkflowLimitError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.WorkflowResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map((workflow): Domain.WorkflowResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowNameTakenError: ({ name }) =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "NameTaken", name }),
      WorkflowTagTakenError: ({ tag, workflowName }) =>
        Effect.succeed<Domain.WorkflowResult>({
          _tag: "TagTaken",
          tag,
          workflowName,
        }),
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) =>
        Effect.succeed<Domain.WorkflowResult>({ _tag: "Limit", limit }),
    }),
  );

const applyResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
    | WorkflowNotFoundError
    | NoDraftError
    | NoTasksError
    | TaskUnassignedError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ApplyResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map((workflow): Domain.ApplyResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.ApplyResult>({ _tag: "NotFound" }),
      NoDraftError: () =>
        Effect.succeed<Domain.ApplyResult>({ _tag: "NoDraft" }),
      NoTasksError: () =>
        Effect.succeed<Domain.ApplyResult>({ _tag: "NoTasks" }),
      TaskUnassignedError: ({ taskNames }) =>
        Effect.succeed<Domain.ApplyResult>({
          _tag: "TaskUnassigned",
          taskNames,
        }),
    }),
  );

const discardResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
    | WorkflowNotFoundError
    | NoDraftError
    | SqlError.SqlError
    | WorkflowRepositoryError,
    R
  >,
): Effect.Effect<
  Domain.DiscardResult,
  SqlError.SqlError | WorkflowRepositoryError,
  R
> =>
  effect.pipe(
    Effect.map((workflow): Domain.DiscardResult => ({ _tag: "Ok", workflow })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.DiscardResult>({ _tag: "NotFound" }),
      NoDraftError: () =>
        Effect.succeed<Domain.DiscardResult>({ _tag: "NoDraft" }),
    }),
  );

const draftResult = <R>(
  effect: Effect.Effect<
    Domain.DraftResult,
    WorkflowNotFoundError | SqlError.SqlError | WorkflowRepositoryError,
    R
  >,
): Effect.Effect<
  Domain.DraftResult,
  SqlError.SqlError | WorkflowRepositoryError,
  R
> =>
  effect.pipe(
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.DraftResult>({ _tag: "NotFound" }),
    }),
  );

/** `Ok` carries how many runs the reconcile-all after the switch created — in either direction, since Turn off can resolve an ambiguity — for the toast. */
const switchResult = <R>(
  effect: Effect.Effect<
    { readonly workflow: Domain.Workflow; readonly created: number },
    | WorkflowNotFoundError
    | NoTasksError
    | TaskUnassignedError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.SwitchResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map(({ workflow, created }): Domain.SwitchResult => ({
      _tag: "Ok",
      workflow,
      created,
    })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.SwitchResult>({ _tag: "NotFound" }),
      NoTasksError: () =>
        Effect.succeed<Domain.SwitchResult>({ _tag: "NoTasks" }),
      TaskUnassignedError: ({ taskNames }) =>
        Effect.succeed<Domain.SwitchResult>({
          _tag: "TaskUnassigned",
          taskNames,
        }),
    }),
  );

const changeActivatedAtResult = <R>(
  effect: Effect.Effect<
    { readonly workflow: Domain.Workflow; readonly created: number },
    | WorkflowNotFoundError
    | WorkflowOffError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RunRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.ChangeActivatedAtResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RunRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.map(({ workflow, created }): Domain.ChangeActivatedAtResult => ({
      _tag: "Ok",
      workflow,
      created,
    })),
    Effect.catchTags({
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.ChangeActivatedAtResult>({ _tag: "NotFound" }),
      WorkflowOffError: () =>
        Effect.succeed<Domain.ChangeActivatedAtResult>({ _tag: "Off" }),
    }),
  );

const taskResult = <R>(
  effect: Effect.Effect<
    Domain.TaskResult,
    | TaskNotFoundError
    | StepNotFoundError
    | WorkflowNotFoundError
    | WorkflowLimitError
    | SqlError.SqlError
    | WorkflowRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.TaskResult,
  | SqlError.SqlError
  | WorkflowRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.catchTags({
      TaskNotFoundError: () =>
        Effect.succeed<Domain.TaskResult>({ _tag: "NotFound" }),
      StepNotFoundError: () =>
        Effect.succeed<Domain.TaskResult>({ _tag: "NotFound" }),
      WorkflowNotFoundError: () =>
        Effect.succeed<Domain.TaskResult>({ _tag: "NotFound" }),
      WorkflowLimitError: ({ limit }) =>
        Effect.succeed<Domain.TaskResult>({ _tag: "Limit", limit }),
    }),
  );

/**
 * Same shape as {@link workflowResult}: expected run failures become values.
 * `WorkflowRepositoryError` and `SchemaError` ride along because the actions
 * that can create a run load the start context (the workflows that are on, from this
 * object, teams from D1) first.
 */
const runResult = <R>(
  effect: Effect.Effect<
    void,
    | RunNotFoundError
    | RunTerminalError
    | RunBlockedError
    | RunOrderClosedError
    | RunNotAllowedError
    | RunNotBlockedError
    | TaskNotReadyError
    | TaskReopenBlockedError
    | SqlError.SqlError
    | RunRepositoryError
    | WorkflowRepositoryError
    | RepositoryError
    | Schema.SchemaError,
    R
  >,
): Effect.Effect<
  Domain.RunResult,
  | SqlError.SqlError
  | RunRepositoryError
  | WorkflowRepositoryError
  | RepositoryError
  | Schema.SchemaError,
  R
> =>
  effect.pipe(
    Effect.as<Domain.RunResult>({ _tag: "Ok" }),
    Effect.catchTags({
      RunNotFoundError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotFound" }),
      RunTerminalError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "Terminal" }),
      RunBlockedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "Blocked" }),
      RunOrderClosedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "Terminal" }),
      RunNotAllowedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotAllowed" }),
      RunNotBlockedError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotBlocked" }),
      TaskNotReadyError: () =>
        Effect.succeed<Domain.RunResult>({ _tag: "NotReady" }),
      TaskReopenBlockedError: ({ taskName, teamName }) =>
        Effect.succeed<Domain.RunResult>({
          _tag: "ReopenBlocked",
          taskName,
          teamName,
        }),
    }),
  );

/**
 * The teams whose workflows lists a write to this order could have changed, as a value
 * a caller can read on both sides of the write. A failed read answers `"all"`,
 * never `[]`: an over-broad publish costs each member one refetch, while an
 * under-broad one leaves a list that silently stops updating until the tab's
 * next subscribe, and the read failing is no reason to guess narrow. The write
 * that triggered it is never failed by it.
 */
const orderTeamIds = (
  target:
    | { readonly runTaskId: string }
    | { readonly runId: string }
    | { readonly orderId: string },
) =>
  RunRepository.pipe(
    Effect.flatMap(
      (repository): Effect.Effect<PublishTeams, SqlError.SqlError> =>
        repository.listOrderTeamIds(target),
    ),
    Effect.orElseSucceed((): PublishTeams => "all"),
  );

/** The merchant as a gating actor: no team ids, because the merchant has none and every "M" cell is theirs. */
const MERCHANT: Domain.Actor = { role: "merchant" };

/** A member as a gating actor, from the identity the connection carries. */
const memberActor = ({
  memberId,
  memberEmail,
  teamIds,
}: {
  readonly memberId: Domain.MemberId;
  readonly memberEmail: Domain.Email;
  readonly teamIds: readonly Domain.TeamId[];
}): Domain.Actor => ({
  role: "member",
  memberId,
  email: memberEmail,
  teamIds,
});

/**
 * **The action set is the one gate.** The page rendered the button because
 * the field was true ({@link Domain.runActions}); the callable checks the
 * same field with the same inputs, read fresh inside the write's own call,
 * so a stale tab or a second admin cannot write what the page would not
 * offer. `RunNotAllowedError` (`RunResult.NotAllowed`) when the field is
 * false, `RunNotFoundError` when the run or its order is gone. The
 * repository keeps its own guards underneath as the second line. Every
 * `merchant*` and `member*` run write calls this or
 * {@link requireTaskAction} before it writes.
 */
const requireRunAction = (
  runId: string,
  actor: Domain.Actor,
  field: keyof Domain.RunActions,
) =>
  Effect.gen(function* () {
    const gate = yield* (yield* RunRepository).getRunGate({ runId });
    if (Option.isNone(gate)) return yield* new RunNotFoundError({ id: runId });
    const { run, tasks, order } = gate.value;
    if (!Domain.runActions(actor, order, run, tasks)[field])
      return yield* new RunNotAllowedError({ runId, teamId: "" });
    return gate.value;
  });

/** {@link requireRunAction} for one task, reading {@link Domain.taskActions}. */
const requireTaskAction = (
  runTaskId: string,
  actor: Domain.Actor,
  allowed: (actions: Domain.TaskActions) => boolean,
) =>
  Effect.gen(function* () {
    const gate = yield* (yield* RunRepository).getRunGate({
      runTaskId,
    });
    const task = Option.isSome(gate)
      ? gate.value.tasks.find((candidate) => candidate.id === runTaskId)
      : undefined;
    if (Option.isNone(gate) || task === undefined)
      return yield* new RunNotFoundError({ id: runTaskId });
    const { run, order } = gate.value;
    if (!allowed(Domain.taskActions(actor, order, run, task)))
      return yield* new RunNotAllowedError({ runId: run.id, teamId: "" });
    return task;
  });

/**
 * Which tasks are current is decided on a snapshot taken before any
 * task of the round is done: marking step 1 done makes step 2 current at
 * once, so asking `markTaskDone` as the loop goes would run the
 * whole order to done in one round. The rule is `Domain.currentTasks`.
 */
/**
 * A seeded task write recorded as the merchant: no `teamIds`, which is the one
 * rule a merchant skips (`Domain.MarkTaskDoneCommand`). Module scope because
 * it captures nothing — oxlint's `unicorn(consistent-function-scoping)`.
 */
const merchantTaskCommand = (task: Domain.RunTask) => ({
  runTaskId: task.id,
  actor: { role: "merchant" } as const,
});

const seedReadyTasks = (
  details: readonly Domain.RunDetail[],
): Domain.RunTask[] =>
  details.flatMap(({ run, tasks }) => Domain.currentTasks(run, tasks));

const readRunPage = (input: {
  readonly runId: string;
  readonly teamIds: readonly string[];
}) =>
  RunRepository.pipe(
    Effect.flatMap((repository) => repository.getRunPage(input)),
    Effect.map(Option.getOrNull),
  );

const merchantListRunsForOrder = ({
  orderId,
}: typeof Domain.ListRunsForOrderInput.Type) =>
  RunRepository.pipe(
    Effect.flatMap((repository) => repository.listRunsForOrder({ orderId })),
  );

const listTeamWorkflows = ({ teamId }: typeof Domain.TeamIdInput.Type) =>
  WorkflowRepository.pipe(
    Effect.flatMap((repository) => repository.listTeamWorkflows({ teamId })),
  );

/** The teams index's "Used by" column, read by its loader. */
const listAllTeamWorkflows = () =>
  WorkflowRepository.pipe(
    Effect.flatMap((repository) => repository.listAllTeamWorkflows()),
  );

/** The delete dialogs' counts, read by the team pages' loaders. */
const countTasksByTeam = () =>
  WorkflowRepository.pipe(
    Effect.flatMap((repository) => repository.countTasksByTeam()),
  );

const make = Effect.gen(function* () {
  const host = yield* ShopAgentHost;
  const env = yield* CloudflareEnv;
  /** The one crossing into billing; the rule is on {@link BillingAgent}'s `flushUsageEvents`. */
  const { flushUsageEvents } = yield* BillingAgent;

  const readOrders = ({
    limit,
    cursor,
    q,
    view,
    team,
  }: Domain.ListOrdersInput) => {
    const readTeams = () => teams();
    return Effect.gen(function* () {
      const repository = yield* OrderRepository;
      /* One read of the teams for both consumers: the repository derives
         `unassigned`, `emptyTeam` and `waitingOn` from it, and
         `OrdersIndexData` carries it so the route can name the ids it gets
         back. */
      const teams = yield* readTeams();
      return {
        page: yield* repository.listOrders({
          limit,
          cursor,
          q,
          view,
          team,
          teams,
        }),
        syncState: {
          inFlight: yield* host.importInFlight(yield* Clock.currentTimeMillis),
          ...(yield* repository.getSyncState()),
        },
        teams,
      } satisfies Domain.OrdersIndexData;
    });
  };

  /** The loader half of the orders index; the socket half is {@link subscribeOrders}, the same read plus the subscription. */
  const listOrders = (input: typeof Domain.ListOrdersInput.Type) =>
    readOrders(input);

  /**
   * The orders index's `subscribe<Feature>` method — reads the page and
   * subscribes the calling connection in one round trip. Combining the read and
   * subscription prevents a write between separate calls from being missed.
   * `orderId: null` subscribes to every order-state push.
   */
  const subscribeOrders = ({
    subscriberId,
    ...input
  }: typeof Domain.SubscribeOrdersInput.Type) => {
    return Effect.gen(function* () {
      yield* host.setSubscription({ subscriberId, orderId: null });
      return yield* readOrders(input);
    });
  };

  const listWorkflows = () =>
    Effect.gen(function* () {
      return yield* (yield* WorkflowRepository).listWorkflows({
        teams: yield* teams(),
      });
    });

  /**
   * `getWorkflowDetail`, not `getWorkflow`: the Agents SDK base class already
   * has a `getWorkflow(workflowId)` that tracks Cloudflare Workflow instances.
   *
   * Joins team names from D1 inside the object rather than in a server fn: the
   * runtime already holds `Repository`, and one round trip returns the tasks,
   * their resolved team names and member counts, and the teams the picker
   * needs. Unassigned and empty team are derived here and never stored: a task
   * whose `teamId` is null or names no team resolves to `teamName: null`
   * (unassigned — warned, never blocked in the editor, since the risk is
   * when a run is created); a task on a team with no members carries
   * `memberCount: 0`. Assigning a team or adding a member clears either with
   * no other write.
   */
  const getWorkflowDetail = ({
    workflowId,
  }: typeof Domain.WorkflowIdInput.Type) => {
    return Effect.gen(function* () {
      const repository = yield* WorkflowRepository;
      const detail = yield* repository.getWorkflow({ workflowId });
      if (Option.isNone(detail)) return null;
      const shopTeams = yield* teams();
      const teamOf = new Map(shopTeams.map((team) => [team.id, team]));
      const withTeamNames = (
        tasks: readonly Domain.WorkflowTask[],
      ): Domain.TaskWithTeamName[] =>
        tasks.map((task) => {
          const team =
            task.teamId === null ? undefined : teamOf.get(task.teamId);
          return {
            ...task,
            teamName: team?.name ?? null,
            memberCount: team?.memberCount ?? null,
          };
        });
      return {
        workflow: detail.value.workflow,
        tasks: withTeamNames(detail.value.tasks),
        draft:
          detail.value.draft === null
            ? null
            : {
                draft: detail.value.draft.draft,
                tasks: withTeamNames(detail.value.draft.tasks),
              },
        teams: shopTeams,
      } satisfies Domain.WorkflowPageData;
    });
  };

  const createWorkflow = (input: typeof Domain.CreateWorkflowInput.Type) =>
    workflowResult(
      WorkflowRepository.pipe(
        Effect.flatMap((repository) => repository.createWorkflow(input)),
      ),
    );

  /** Duplicate: the copy is off, keeps the tasks, and takes the name and tag the dialog collected (`WorkflowRepository.duplicateWorkflow`). */
  const duplicateWorkflow = ({
    workflowId,
    name,
    tag,
  }: typeof Domain.DuplicateWorkflowInput.Type) => {
    const shop = host.shop();
    return workflowResult(
      Effect.gen(function* () {
        const copy = yield* (yield* WorkflowRepository).duplicateWorkflow({
          workflowId,
          name,
          tag,
        });
        yield* Effect.logInfo(
          `ShopAgent.duplicateWorkflow: shop=${shop} workflowId=${workflowId} copyId=${copy.id}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, copyId: copy.id }));
        return copy;
      }),
    );
  };

  const updateWorkflow = ({
    workflowId,
    name,
  }: typeof Domain.UpdateWorkflowInput.Type) =>
    workflowResult(
      WorkflowRepository.pipe(
        Effect.flatMap((repository) =>
          repository.updateWorkflow({ workflowId, name }),
        ),
      ),
    );

  /**
   * Immediate, like `updateWorkflow`: lands on the workflow row, never the
   * draft. Unlike a rename it changes how the workflow matches, so an on
   * workflow reconciles every stored order once afterwards, as Apply does:
   * an order already in Baton whose product carries the new tag starts now,
   * not on Shopify's next edit. Runs in flight are untouched: a run snapshots
   * its workflow (the data model on `initializeSchema`,
   * `ShopAgentSchema.ts`). Publishes because the order pages read the
   * reconcile.
   */
  const updateWorkflowTag = ({
    workflowId,
    tag,
  }: typeof Domain.UpdateWorkflowTagInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllIfOn("updateWorkflowTag", workflow);
    return workflowResult(
      Effect.gen(function* () {
        const workflow = yield* (yield* WorkflowRepository).updateWorkflowTag({
          workflowId,
          tag,
        });
        yield* Effect.logInfo(
          `ShopAgent.updateWorkflowTag: shop=${shop} workflowId=${workflowId} tag=${tag}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, tag }));
        yield* reconcileAll(workflow);
        return workflow;
      }),
    ).pipe(Effect.tap(publish));
  };

  /** Edit: creates the draft (or returns the existing one). */
  const createDraft = ({ workflowId }: typeof Domain.CreateDraftInput.Type) => {
    const shop = host.shop();
    return draftResult(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const draft = yield* repository.createDraft({ workflowId });
        yield* Effect.logInfo(
          `ShopAgent.createDraft: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        return { _tag: "Ok", draft } satisfies Domain.DraftResult;
      }),
    );
  };

  /**
   * Apply changes. On an on workflow, reconciles every stored order once
   * afterwards: new tasks can make a workflow eligible for an item it was not, and those
   * orders should start now rather than at whatever moment Shopify next edits
   * them. Publishes because the next order starts against the new tasks,
   * which the order page's workflow pickers reflect.
   */
  const applyDraft = ({ workflowId }: typeof Domain.ApplyDraftInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllIfOn("applyDraft", workflow);
    return applyResult(
      Effect.gen(function* () {
        const workflow = yield* (yield* WorkflowRepository).applyDraft({
          workflowId,
          teams: yield* teams(),
        });
        yield* Effect.logInfo(
          `ShopAgent.applyDraft: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        yield* reconcileAll(workflow);
        return workflow;
      }),
    ).pipe(Effect.tap(publish));
  };

  const discardDraft = ({
    workflowId,
  }: typeof Domain.DiscardDraftInput.Type) => {
    const shop = host.shop();
    return discardResult(
      Effect.gen(function* () {
        const workflow = yield* (yield* WorkflowRepository).discardDraft({
          workflowId,
        });
        yield* Effect.logInfo(
          `ShopAgent.discardDraft: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        return workflow;
      }),
    );
  };

  /**
   * The on/off switch. On writes `activatedAt` (now, or the earlier date the
   * dialog chose); off nulls it. Either way every stored order is reconciled
   * once, so a run for anything that now qualifies is created here rather than at whatever
   * moment Shopify next edits it — and off qualifies things too, because
   * removing one of two matching workflows resolves an ambiguity and starts
   * the survivor (see {@link reconcileAllNow}). Publishes for the reason on
   * {@link applyDraft}.
   */
  const setWorkflowOn = ({
    workflowId,
    on,
    activatedAt,
  }: typeof Domain.SetWorkflowOnInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllNow("setWorkflowOn", workflow.id);
    return switchResult(
      Effect.gen(function* () {
        const workflow = yield* (yield* WorkflowRepository).setWorkflowOn({
          workflowId,
          on,
          ...(activatedAt === undefined ? {} : { activatedAt }),
          teams: yield* teams(),
        });
        yield* Effect.logInfo(
          `ShopAgent.setWorkflowOn: shop=${shop} workflowId=${workflowId} on=${String(on)} activatedAt=${String(workflow.activatedAt)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            workflowId,
            on,
            activatedAt: workflow.activatedAt,
          }),
        );
        return { workflow, created: yield* reconcileAll(workflow) };
      }),
    ).pipe(Effect.tap(publish));
  };

  /**
   * The editor's Turn on for a workflow that has never been applied: applies
   * the draft and turns the switch on in one transaction, then reconciles
   * every stored order once, exactly as {@link setWorkflowOn} does — the
   * merchant made one decision, so a failure must leave the workflow
   * untouched rather than applied and off.
   */
  const applyAndTurnOn = ({
    workflowId,
    activatedAt,
  }: typeof Domain.ApplyAndTurnOnInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllNow("applyAndTurnOn", workflow.id);
    return switchResult(
      Effect.gen(function* () {
        const workflow = yield* (yield* WorkflowRepository).applyAndTurnOn({
          workflowId,
          ...(activatedAt === undefined ? {} : { activatedAt }),
          teams: yield* teams(),
        });
        yield* Effect.logInfo(
          `ShopAgent.applyAndTurnOn: shop=${shop} workflowId=${workflowId} activatedAt=${String(workflow.activatedAt)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            workflowId,
            activatedAt: workflow.activatedAt,
          }),
        );
        return { workflow, created: yield* reconcileAll(workflow) };
      }),
    ).pipe(Effect.tap(publish));
  };

  /** The workflow page's Change control: moves the coverage date, then reconciles every stored order once. */
  const setWorkflowActivatedAt = ({
    workflowId,
    activatedAt,
  }: typeof Domain.SetWorkflowActivatedAtInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish("all");
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllIfOn("setWorkflowActivatedAt", workflow);
    return changeActivatedAtResult(
      Effect.gen(function* () {
        const workflow =
          yield* (yield* WorkflowRepository).setWorkflowActivatedAt({
            workflowId,
            activatedAt,
          });
        yield* Effect.logInfo(
          `ShopAgent.setWorkflowActivatedAt: shop=${shop} workflowId=${workflowId} activatedAt=${String(activatedAt)}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, activatedAt }));
        return { workflow, created: yield* reconcileAll(workflow) };
      }),
    ).pipe(Effect.tap(publish));
  };

  /**
   * The Turn on dialog's count: read-only, no publish. The workflow is
   * usually off here, so it is read by id rather than from the workflows that are on.
   * `NotFound` is a count of zero: the dialog has nothing to add.
   */
  const countWaitingOrders = ({
    workflowId,
  }: typeof Domain.CountWaitingOrdersInput.Type) => {
    return Effect.gen(function* () {
      const found = yield* (yield* WorkflowRepository).getWorkflow({
        workflowId,
      });
      if (Option.isNone(found)) return { count: 0, earliestProcessedAt: null };
      return yield* (yield* RunRepository).countWaitingOrders({
        ...(yield* eligibleContext()),
        workflow: {
          workflow: found.value.workflow,
          tasks: found.value.tasks,
        },
      });
    });
  };

  /**
   * Delete a workflow and its runs stay on their orders (vocabulary on
   * `Domain.Workflow`; the rule is the data model on `initializeSchema`,
   * `ShopAgentSchema.ts`). `removeWorkflow`, not `deleteWorkflow`: the Agents
   * SDK base class already has a `deleteWorkflow(workflowId)` that drops a
   * Cloudflare Workflow instance's tracking row (`onWorkflowComplete` calls
   * it), the same collision `getWorkflowDetail` sidesteps. Publishes because
   * the workflows index and any order page's attach picker — which lists
   * workflows — must repaint.
   *
   * Reconciles afterwards for the same reason Turn off does: the deleted
   * workflow turns off, so an item it made ambiguous now has one
   * match and the survivor's run is created.
   */
  const removeWorkflow = ({
    workflowId,
  }: typeof Domain.DeleteWorkflowInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish("all");
    const reconcileAll = (workflowId: string) =>
      reconcileAllNow("removeWorkflow", workflowId);
    return Effect.gen(function* () {
      yield* (yield* WorkflowRepository).deleteWorkflow({ workflowId });
      yield* Effect.logInfo(
        `ShopAgent.removeWorkflow: shop=${shop} workflowId=${workflowId}`,
      ).pipe(Effect.annotateLogs({ shop, workflowId }));
      yield* reconcileAll(workflowId);
      yield* publish();
      return { _tag: "Deleted" } satisfies Domain.DeleteWorkflowResult;
    }).pipe(
      Effect.catchTags({
        WorkflowNotFoundError: () =>
          Effect.succeed<Domain.DeleteWorkflowResult>({ _tag: "NotFound" }),
      }),
    );
  };

  /**
   * The shop's teams, read live from D1 with member counts, read fresh on every call: it is
   * what every task pointer is resolved against (an id not in it is
   * unassigned) and what the empty-team warnings are computed from.
   */
  const teams = () => {
    const name = host.shop();
    return Effect.gen(function* () {
      const teams = yield* (yield* Repository).listTeams({
        shop: yield* Schema.decodeUnknownEffect(Domain.Shop)(name),
      });
      return teams.map(
        ({ id, name, memberCount }): Domain.TeamWithMemberCount => ({
          id,
          name,
          memberCount,
        }),
      );
    });
  };

  /**
   * Loads what creating runs needs — every workflow that is on, with its tasks, and
   * the shop's teams from D1 — *before* any transaction opens, and
   * returns a per-order effect the caller hands to `upsertOrder.afterWrite`.
   * The D1 read is the one await run creation needs that is not storage, and it
   * cannot happen inside the Durable Object transaction; loading once per
   * webhook or per bulk stream also bounds the cost for a thousand-order file,
   * at the accepted price of a snapshot that a mid-stream team delete would
   * not refresh.
   */
  const eligibleContext = () => {
    return Effect.gen(function* () {
      return {
        workflows: yield* (yield* WorkflowRepository).listOnWorkflowDetails(),
        teams: yield* teams(),
      } satisfies EligibleContext;
    });
  };

  /**
   * Reconcile every stored open order once against the workflows that are on *now*,
   * so anything that now qualifies starts at this moment rather than at
   * whatever moment Shopify next edits it. Reconcile is an idempotent state
   * check, so running it over every order is safe; orders placed before
   * `activatedAt` are still excluded by the date rule. Not the write's
   * transaction: the repository owns that one and Durable Object SQLite
   * refuses to nest, but the Durable Object serialises callables so nothing
   * interleaves. Returns how many runs it created.
   *
   * Unconditional, because a workflow turning off creates runs too: one item
   * matched by two workflows that are on is ambiguous and carries no run, so
   * turning one of them off — or deleting it — leaves a single match and the
   * survivor's run begins. That is why {@link setWorkflowOn} and
   * {@link removeWorkflow} call this directly rather than through
   * {@link reconcileAllIfOn}, and why `SwitchResult.Ok.created` is
   * meaningful on Turn off.
   *
   * Sends the usage queue after the pass ({@link flushUsageEvents}), whether
   * or not it finished: every order a run was created on was counted, and its
   * event is owed now.
   */
  const reconcileAllNow = (caller: string, workflowId: string) => {
    const shop = host.shop();
    return Effect.gen(function* () {
      const { orders, created, ambiguous } = yield* (yield* RunRepository)
        .reconcileAll(yield* eligibleContext())
        .pipe(Effect.ensuring(flushUsageEvents));
      yield* Effect.logInfo(
        `ShopAgent.reconcileAll: shop=${shop} caller=${caller} workflowId=${workflowId} orders=${String(orders)} created=${String(created)} ambiguous=${String(ambiguous)}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          caller,
          workflowId,
          orders,
          created,
          ambiguous,
        }),
      );
      return created;
    });
  };

  /**
   * {@link reconcileAllNow}, skipped when the workflow is off: for the
   * definition writes (Apply, Edit tag, the coverage date) that change *how* a workflow
   * matches. An off workflow matches nothing either way, so nothing about the
   * workflows that are on changed and the pass would be a full scan for no writes. Turn
   * off and delete do move it, and use {@link reconcileAllNow}.
   */
  const reconcileAllIfOn = (caller: string, workflow: Domain.Workflow) => {
    const run = () => reconcileAllNow(caller, workflow.id);
    return Effect.gen(function* () {
      if (!Domain.workflowIsOn(workflow)) return 0;
      return yield* run();
    });
  };

  const reconciler = (source: Domain.OrderSyncSource) => {
    const shop = host.shop();
    return Effect.gen(function* () {
      const context = yield* eligibleContext();
      const runs = yield* RunRepository;
      return (order: Domain.ShopOrder) =>
        runs.reconcileOrder({ ...context, orderId: order.id }).pipe(
          Effect.tap(({ created, resized, closed, ambiguous }) =>
            Effect.logInfo(
              `ShopAgent.reconcileOrder: shop=${shop} orderId=${order.id} source=${source} created=${String(created)} resized=${String(resized)} closed=${String(closed)} ambiguous=${String(ambiguous)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                orderId: order.id,
                source,
                created,
                resized,
                closed,
                ambiguous,
              }),
            ),
          ),
          Effect.asVoid,
        );
    });
  };

  /**
   * The detail page's `subscribe<Feature>` read: the order, its items, and
   * every run on them, and the calling connection subscribed to pushes in the
   * same round trip (the convention documented on `subscribeOrders`). Without
   * the attach, a webhook landing on the open order would update SQLite and
   * push to nobody. Addressed by `legacyId` because that is what the route
   * carries (see `Domain.SubscribeOrderInput`). `null` when the order is not
   * stored, which the page renders as not-found rather than as a failure.
   */
  const readOrderDetail = ({ legacyId }: Domain.GetOrderDetailInput) => {
    return Effect.gen(function* () {
      const orders = yield* OrderRepository;
      const runs = yield* RunRepository;
      const detail = yield* orders.getOrderByLegacyId(legacyId);
      if (Option.isNone(detail)) return null;
      const { order, lineItems } = detail.value;
      const repository = yield* WorkflowRepository;
      const workflows = yield* repository.listOnWorkflowDetails();
      const shopTeams = yield* teams();
      return {
        order,
        lineItems,
        runs: yield* runs.listRunsForOrder({ orderId: order.id }),
        teams: shopTeams,
        itemWorkflows: workflows
          .filter(({ tasks }) => tasks.length > 0)
          .map(({ workflow }) => workflow),
      } satisfies Domain.OrderPageData;
    });
  };

  /** The loader half of the order detail page, as {@link listOrders} is for the index. */
  const getOrderDetail = (input: typeof Domain.GetOrderDetailInput.Type) =>
    readOrderDetail(input);

  const subscribeOrder = ({
    subscriberId,
    ...input
  }: typeof Domain.SubscribeOrderInput.Type) => {
    return Effect.gen(function* () {
      const page = yield* readOrderDetail(input);
      /**
       * Subscribed after the read because the scope is the GID and the
       * route only carries the legacy id. An unstored order subscribes
       * index-wide (`null`): a later sync that stores it must reach this
       * page, and there is no GID to narrow to.
       */
      yield* host.setSubscription({
        subscriberId,
        orderId: page?.order.id ?? null,
      });
      return page;
    });
  };

  /**
   * Manual attach, read as **set this item's workflow**. It applies only the
   * definition half of the start predicate (`workflowIsEligible`): an admin choosing a
   * workflow for an item by hand is exactly the override for a missing
   * tag, a fulfilled line, or an order placed before the workflow was turned
   * on. What it is not is an override of the order itself being over, which
   * is `Domain.orderIsOpen`.
   *
   * An item holds at most one run, so attaching over one is a replace: the
   * incumbent is deleted in the same transaction and comes back as
   * `replaced` for the toast. The same workflow again is `AlreadyExists`.
   * Over a closed run it is a fresh start, the closed workflow included, and
   * `replaced` is null (`Domain.RunStatus`). An item with no
   * units to make is `NothingToMake`, the same rule as `changeWorkflow` on
   * `Domain.runActions`. Confirmation is the UI's job, not this one's — the
   * server cannot know whether the merchant has seen the trail of work
   * already done on the run it is about to delete, and a server-side refusal
   * would leave the page with nothing to offer but the same click again.
   *
   * Sends the usage queue afterwards ({@link flushUsageEvents}): the run it
   * creates may be the order's first, which counts it.
   */
  const merchantAttachWorkflow = ({
    lineItemId,
    workflowId,
  }: typeof Domain.AttachWorkflowInput.Type) => {
    const publish = (touched: PublishScope) => host.publish(touched);
    return Effect.gen(function* () {
      const target = yield* (yield* OrderRepository).getLineItem(lineItemId);
      if (Option.isNone(target))
        return { _tag: "LineItemNotFound" } satisfies Domain.AttachResult;
      const workflows = yield* WorkflowRepository;
      const found = yield* workflows.getWorkflow({ workflowId });
      const shopTeams = yield* teams();
      // Only the workflow's own tasks can create a run; a draft is never
      // attachable.
      const detail: Domain.WorkflowDetail | null = Option.isSome(found)
        ? { workflow: found.value.workflow, tasks: found.value.tasks }
        : null;
      if (detail === null || !workflowIsEligible(detail, shopTeams))
        return {
          _tag: "WorkflowNotEligible",
        } satisfies Domain.AttachResult;
      if (!Domain.orderIsOpen(target.value.order))
        return { _tag: "OrderClosed" } satisfies Domain.AttachResult;
      // The same rule as `changeWorkflow` ({@link Domain.runActions}), for
      // an item with no run too: nothing to make, nothing to start.
      if (Domain.unitsToMake(target.value.lineItem) === 0)
        return { _tag: "NothingToMake" } satisfies Domain.AttachResult;
      // Over a run this is Change workflow, gated like every run write
      // ({@link requireRunAction}); the only way `changeWorkflow` is
      // false on an open order is a done run. Over a closed run it is the
      // picker at rest, which the order gate above covers.
      const repository = yield* RunRepository;
      const incumbent = (yield* repository.listRunsForOrder({
        orderId: target.value.order.id,
      })).find(({ run }) => run.lineItemId === lineItemId);
      if (
        incumbent !== undefined &&
        !Domain.runIsClosed(incumbent.run) &&
        !Domain.runActions(
          MERCHANT,
          target.value.order,
          incumbent.run,
          Domain.runTaskRows(incumbent.run, incumbent.tasks),
          target.value.lineItem,
        ).changeWorkflow
      )
        return {
          _tag: "ItemDone",
          workflowName: incumbent.run.workflowName,
        } satisfies Domain.AttachResult;
      const set = yield* repository.setRun({
        workflow: detail,
        teams: shopTeams,
        order: target.value.order,
        lineItem: target.value.lineItem,
      });
      if (Option.isNone(set))
        return { _tag: "AlreadyExists" } satisfies Domain.AttachResult;
      yield* publish([target.value.order.id]);
      return {
        _tag: "Ok",
        run: set.value.run,
        replaced: set.value.replaced,
      } satisfies Domain.AttachResult;
    }).pipe(
      Effect.catchTags({
        RunLimitError: ({ limit }) =>
          Effect.succeed<Domain.AttachResult>({ _tag: "RunLimit", limit }),
        RunNotOpenError: ({ workflowName }) =>
          Effect.succeed<Domain.AttachResult>({
            _tag: "ItemDone",
            workflowName,
          }),
      }),
      Effect.ensuring(flushUsageEvents),
    );
  };

  /**
   * Closes the run, reason `merchant_cancelled`
   * (`RunRepository.cancelRun`, rule on `Domain.RunStatus`). Gated by
   * `Domain.runActions` `cancel`, which is false on a closed order: reconcile
   * has already closed every open run there. The run leaves every team's
   * lists, so the publish reaches every team on the order.
   */
  const merchantCancelRun = ({ runId }: typeof Domain.RunIdInput.Type) => {
    const shop = host.shop();
    const publish = (teams: PublishTeams) => host.publish("all", teams);
    return Effect.gen(function* () {
      const teams = yield* orderTeamIds({ runId });
      const result = yield* runResult(
        Effect.gen(function* () {
          yield* requireRunAction(runId, MERCHANT, "cancel");
          yield* (yield* RunRepository).cancelRun({ runId });
          yield* Effect.logInfo(
            `ShopAgent.merchantCancelRun: shop=${shop} runId=${runId}`,
          ).pipe(Effect.annotateLogs({ shop, runId }));
        }),
      );
      if (result._tag === "Ok") yield* publish(teams);
      return result;
    });
  };

  /**
   * The merchant's task and block writes on a run, from the order page's
   * Manage drawer and block banner. Each is gated by {@link requireRunAction}
   * or {@link requireTaskAction} before the repository sees it. Separate
   * methods rather than a role branch inside the member ones; the reason is
   * on the class's `merchantMarkTaskDone`.
   *
   * Each builds `actor: { role: "merchant" }` and passes **no** `teamIds`,
   * which is the entire permission difference (`Domain.MarkTaskDoneCommand`):
   * the task's team need not be one of the caller's, because the merchant has
   * none, and an unassigned task is exactly the case they are here to fix.
   * Step order, the run's status, and the downstream reopen guard still apply.
   *
   * They publish with {@link publishToTeams}, not `publish("all")`: the
   * merchant's own order page is subscribed by order and the workers by team,
   * and the team fan-out for the touched order already reaches both. There is
   * no merchant Start: "started" records that a worker picked the task up,
   * and a merchant marking it started on their behalf would put a name on
   * work nobody has begun. The merchant either marks it done outright or leaves
   * it for the team.
   *
   * No member id in the log line: there isn't one.
   */
  const merchantMarkTaskDone = ({
    runTaskId,
  }: typeof Domain.MarkTaskDoneInput.Type) => {
    const shop = host.shop();
    const publish = (runTaskId: string) => publishToTeams({ runTaskId });
    return runResult(
      Effect.gen(function* () {
        yield* requireTaskAction(runTaskId, MERCHANT, ({ done }) => done);
        yield* (yield* RunRepository).markTaskDone({
          runTaskId,
          actor: { role: "merchant" },
        } satisfies Domain.MarkTaskDoneCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantMarkTaskDone: shop=${shop} task=${runTaskId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId }));
      }),
    ).pipe(Effect.tap(() => publish(runTaskId)));
  };

  const merchantReopenTask = ({
    runTaskId,
  }: typeof Domain.ReopenTaskInput.Type) => {
    const shop = host.shop();
    const publish = (runTaskId: string) => publishToTeams({ runTaskId });
    return runResult(
      Effect.gen(function* () {
        yield* requireTaskAction(
          runTaskId,
          MERCHANT,
          ({ reopen }) => reopen !== null,
        );
        yield* (yield* RunRepository).reopenTask({
          runTaskId,
          actor: { role: "merchant" },
        } satisfies Domain.ReopenTaskCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantReopenTask: shop=${shop} task=${runTaskId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId }));
      }),
    ).pipe(Effect.tap(() => publish(runTaskId)));
  };

  /** Put back from the order page; the rule is on `RunRepository.putBackTask`. */
  const merchantPutBackTask = ({
    runTaskId,
  }: typeof Domain.PutBackTaskInput.Type) => {
    const shop = host.shop();
    const publish = (runTaskId: string) => publishToTeams({ runTaskId });
    return runResult(
      Effect.gen(function* () {
        yield* requireTaskAction(runTaskId, MERCHANT, ({ putBack }) => putBack);
        yield* (yield* RunRepository).putBackTask({
          runTaskId,
          actor: { role: "merchant" },
        } satisfies Domain.PutBackTaskCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantPutBackTask: shop=${shop} task=${runTaskId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId }));
      }),
    ).pipe(Effect.tap(() => publish(runTaskId)));
  };

  /** The note itself never reaches the log line, as on the member's {@link memberSetRunNote}. */
  const merchantSetRunNote = ({
    runId,
    note,
  }: typeof Domain.SetRunNoteInput.Type) => {
    const shop = host.shop();
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        yield* requireRunAction(runId, MERCHANT, "note");
        yield* (yield* RunRepository).setRunNote({
          runId,
          note,
        } satisfies Domain.SetRunNoteCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantSetRunNote: shop=${shop} runId=${runId}`,
        ).pipe(Effect.annotateLogs({ shop, runId }));
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  const merchantBlockRun = ({
    runId,
    reason,
  }: typeof Domain.BlockRunInput.Type) => {
    const shop = host.shop();
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        yield* requireRunAction(runId, MERCHANT, "block");
        yield* (yield* RunRepository).blockRun({
          runId,
          actor: { role: "merchant" },
          reason,
        } satisfies Domain.BlockRunCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantBlockRun: shop=${shop} runId=${runId}`,
        ).pipe(Effect.annotateLogs({ shop, runId }));
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  const merchantSetBlockReason = ({
    runId,
    reason,
  }: typeof Domain.SetBlockReasonInput.Type) => {
    const shop = host.shop();
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        yield* requireRunAction(runId, MERCHANT, "editReason");
        yield* (yield* RunRepository).setBlockReason({
          runId,
          reason,
        } satisfies Domain.SetBlockReasonCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantSetBlockReason: shop=${shop} runId=${runId}`,
        ).pipe(Effect.annotateLogs({ shop, runId }));
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  const merchantUnblockRun = ({ runId }: typeof Domain.RunIdInput.Type) => {
    const shop = host.shop();
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        yield* requireRunAction(runId, MERCHANT, "unblock");
        yield* (yield* RunRepository).unblockRun({
          runId,
        } satisfies Domain.UnblockRunCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantUnblockRun: shop=${shop} runId=${runId}`,
        ).pipe(Effect.annotateLogs({ shop, runId }));
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  /**
   * A publish scoped to the teams a member's write could have changed the
   * workflows list of — see `publish`. The read is one indexed query against the
   * object's own SQLite, and it runs after the write so a task that just
   * became current for another team is included.
   */
  const publishToTeams = (
    target:
      | { readonly runTaskId: string }
      | { readonly runId: string }
      | { readonly orderId: string },
    touched: PublishScope = "all",
  ) => {
    return orderTeamIds(target).pipe(
      Effect.flatMap((teams) => host.publish(touched, teams)),
    );
  };

  /**
   * No D1 read: `startedByEmail` is a snapshot on the row, so the list reads
   * the same after the member is deleted. Every half of `Domain.WorkflowsListData`
   * comes from one call so the loader and the socket paint one snapshot: the
   * view row and the list under it are never two reads that can disagree.
   *
   * The Done or closed count is read on every view (`listRecent` with `limit: 0`
   * counts without reading rows) because the view row shows it whatever is
   * pressed; its rows are read only when `query.view` is "done".
   *
   * `query.team` narrows Done or closed the same way it narrows the other views, and a team
   * the member is not on narrows it to nothing — the same answer the
   * repository gives for the other views, reached here because `listRecent` takes
   * the team list already narrowed.
   */
  const readRuns = (
    teamIds: readonly Domain.TeamId[],
    memberEmail: Domain.Email,
    query: Domain.RunQuery,
  ) => {
    const shop = host.shop();
    return Effect.gen(function* () {
      const repository = yield* RunRepository;
      const started = yield* Clock.currentTimeMillis;
      const { counts, items } = yield* repository.listRuns({
        teamIds,
        memberEmail,
        query,
      });
      const recentTeamIds =
        query.team === null
          ? teamIds
          : teamIds.filter((teamId) => teamId === query.team);
      const recent = yield* repository.listRecent({
        teamIds: recentTeamIds,
        since: started - Domain.DONE_WINDOW_MS,
        limit: query.view === "done" ? query.limit : 0,
      });
      /**
       * The fan-out this read was cut to bound, measured on real shops:
       * `rows` is what left the object, and it must stay at or under
       * `query.limit`.
       */
      const rows = query.view === "done" ? recent.items.length : items.length;
      const team = query.team ?? "all";
      const ms = (yield* Clock.currentTimeMillis) - started;
      yield* Effect.logInfo(
        `ShopAgent.readRuns: shop=${shop} teams=${String(teamIds.length)} team=${team} view=${query.view} rows=${String(rows)} ms=${String(ms)}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          teams: teamIds.length,
          team,
          view: query.view,
          rows,
          ms,
        }),
      );
      return {
        counts: { ...counts, done: recent.total },
        items,
        recent: recent.items,
      } satisfies Domain.WorkflowsListData;
    });
  };

  const listRuns = ({
    teamIds,
    memberEmail,
    query,
  }: typeof Domain.ListRunsInput.Type) => {
    return readRuns(teamIds, memberEmail, query);
  };

  /**
   * The socket twin of {@link listRuns}: the same read, plus the calling
   * connection's subscription, in one round trip so a write landing between
   * two separate calls cannot be missed. The subscribe pattern end to end is
   * on `Domain.Subscription`.
   *
   * `teamIds` comes from the connection, not the message, so a member's list
   * is scoped by the membership the Worker's gate resolved — the same value
   * the loader's `requireMember` produced, arriving by the other route.
   *
   * `orderId: null`: a member's subscription is team-scoped, not order-scoped,
   * and `publish` reads the role to decide which of the two scopes applies.
   */
  const subscribeRuns = (
    { subscriberId, query }: typeof Domain.SubscribeRunsInput.Type,
    { teamIds, memberEmail }: Domain.MemberConnectionState,
  ) => {
    return Effect.gen(function* () {
      yield* host.setSubscription({ subscriberId, orderId: null });
      return yield* readRuns(teamIds, memberEmail, query);
    });
  };

  const memberStartTask = (
    { runTaskId }: typeof Domain.StartTaskInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = (runTaskId: string) => publishToTeams({ runTaskId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireTaskAction(runTaskId, actor, ({ start }) => start);
        yield* (yield* RunRepository).startTask({
          runTaskId,
          actor: { role: "member", memberId, email: memberEmail },
          teamIds,
        } satisfies Domain.StartTaskCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberStartTask: shop=${shop} task=${runTaskId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
      }),
    ).pipe(Effect.tap(() => publish(runTaskId)));
  };

  /** Put back; the rule is on `RunRepository.putBackTask`. */
  const memberPutBackTask = (
    { runTaskId }: typeof Domain.PutBackTaskInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = (runTaskId: string) => publishToTeams({ runTaskId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireTaskAction(runTaskId, actor, ({ putBack }) => putBack);
        yield* (yield* RunRepository).putBackTask({
          runTaskId,
          actor: { role: "member", memberId, email: memberEmail },
          teamIds,
        } satisfies Domain.PutBackTaskCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberPutBackTask: shop=${shop} task=${runTaskId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
      }),
    ).pipe(Effect.tap(() => publish(runTaskId)));
  };

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  const memberSetRunNote = (
    { runId, note }: typeof Domain.SetRunNoteInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireRunAction(runId, actor, "note");
        yield* (yield* RunRepository).setRunNote({
          runId,
          teamIds,
          note,
        } satisfies Domain.SetRunNoteCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberSetRunNote: shop=${shop} runId=${runId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  const memberBlockRun = (
    { runId, reason }: typeof Domain.BlockRunInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireRunAction(runId, actor, "block");
        yield* (yield* RunRepository).blockRun({
          runId,
          actor: { role: "member", memberId, email: memberEmail },
          teamIds,
          reason,
        } satisfies Domain.BlockRunCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberBlockRun: shop=${shop} runId=${runId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  const memberSetBlockReason = (
    { runId, reason }: typeof Domain.SetBlockReasonInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireRunAction(runId, actor, "editReason");
        yield* (yield* RunRepository).setBlockReason({
          runId,
          teamIds,
          reason,
        } satisfies Domain.SetBlockReasonCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberSetBlockReason: shop=${shop} runId=${runId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, runId, memberId }));
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  const memberMarkTaskDone = (
    { runTaskId }: typeof Domain.MarkTaskDoneInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = (runTaskId: string) => publishToTeams({ runTaskId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireTaskAction(runTaskId, actor, ({ done }) => done);
        yield* (yield* RunRepository).markTaskDone({
          runTaskId,
          actor: { role: "member", memberId, email: memberEmail },
          teamIds,
        } satisfies Domain.MarkTaskDoneCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberMarkTaskDone: shop=${shop} task=${runTaskId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
      }),
    ).pipe(Effect.tap(() => publish(runTaskId)));
  };

  /**
   * Reopen, the member's Undo. Publishes to the order's teams like the others: the merchant's
   * order page shows every run of the order.
   */
  const memberReopenTask = (
    { runTaskId }: typeof Domain.ReopenTaskInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = (runTaskId: string) => publishToTeams({ runTaskId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireTaskAction(
          runTaskId,
          actor,
          ({ reopen }) => reopen !== null,
        );
        yield* (yield* RunRepository).reopenTask({
          runTaskId,
          actor: { role: "member", memberId, email: memberEmail },
          teamIds,
        } satisfies Domain.ReopenTaskCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberReopenTask: shop=${shop} task=${runTaskId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
      }),
    ).pipe(Effect.tap(() => publish(runTaskId)));
  };

  /** The workflow page's loader read; plain RPC for the same reason as {@link listRuns}. */
  const memberGetRun = (input: typeof Domain.GetRunForMemberInput.Type) => {
    return readRunPage(input);
  };

  /**
   * The socket twin of {@link memberGetRun}, as `subscribeRuns` is of
   * `listRuns`. The subscription is the same team-scoped one the workflows list
   * registers (`orderId: null`): a member's pushes are decided by team, so
   * any write touching one of their teams' orders refetches this run too.
   * Over-broad by an order or two; the read is one run.
   */
  const subscribeRun = (
    { subscriberId, runId }: typeof Domain.SubscribeRunInput.Type,
    { teamIds }: Domain.MemberConnectionState,
  ) => {
    return Effect.gen(function* () {
      yield* host.setSubscription({ subscriberId, orderId: null });
      return yield* readRunPage({ runId, teamIds });
    });
  };

  const memberUnblockRun = (
    { runId }: typeof Domain.RunIdInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const publish = (runId: string) => publishToTeams({ runId });
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireRunAction(runId, actor, "unblock");
        yield* (yield* RunRepository).unblockRun({
          runId,
          teamIds,
        } satisfies Domain.UnblockRunCommand);
      }),
    ).pipe(Effect.tap(() => publish(runId)));
  };

  /**
   * The team check lives here, not in the repository: `Team` is a D1 row the
   * Durable Object's SQLite cannot reference, so "team exists" is an
   * application invariant. Checked against the shop's live teams on every write.
   * `deleteTeam` reads D1 first and nulls pointers second precisely so a
   * write that passes this check can still be caught by the nulling — see
   * that method.
   */
  const teamExists = (teamId: string) => {
    return teams().pipe(
      Effect.map((teams) => teams.find((team) => team.id === teamId) ?? null),
    );
  };

  const addStep = ({
    workflowId,
    name,
    teamId,
    instructions,
  }: typeof Domain.AddStepInput.Type) => {
    return taskResult(
      Effect.gen(function* () {
        const team = yield* teamExists(teamId);
        if (team === null) return { _tag: "TeamNotFound" };
        const task = yield* (yield* WorkflowRepository).addStep({
          workflowId,
          name,
          teamId: team.id,
          instructions: instructions ?? null,
        });
        return { _tag: "Ok", task };
      }),
    );
  };

  /** `StepNotFoundError` surfaces as `NotFound`: the step the editor showed was closed by a concurrent edit. */
  const addTask = ({
    workflowId,
    step,
    name,
    teamId,
    instructions,
  }: typeof Domain.AddTaskInput.Type) => {
    const shop = host.shop();
    return taskResult(
      Effect.gen(function* () {
        const team = yield* teamExists(teamId);
        if (team === null) return { _tag: "TeamNotFound" };
        const task = yield* (yield* WorkflowRepository).addTask({
          workflowId,
          step,
          name,
          teamId: team.id,
          instructions: instructions ?? null,
        });
        yield* Effect.logInfo(
          `ShopAgent.addTask: shop=${shop} workflowId=${workflowId} step=${String(step)}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, step }));
        return { _tag: "Ok", task };
      }),
    );
  };

  const updateTask = ({
    taskId,
    name,
    teamId,
    instructions,
  }: typeof Domain.UpdateTaskInput.Type) => {
    return taskResult(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const team = yield* teamExists(teamId);
        if (team === null) return { _tag: "TeamNotFound" };
        const task = yield* repository.updateTask({
          taskId,
          name,
          teamId: team.id,
          instructions,
        });
        return { _tag: "Ok", task };
      }),
    );
  };

  const moveTask = ({ taskId, direction }: typeof Domain.MoveTaskInput.Type) =>
    taskResult(
      Effect.gen(function* () {
        yield* (yield* WorkflowRepository).moveTask({ taskId, direction });
        return { _tag: "Ok", task: null };
      }),
    );

  const separateTask = ({ taskId }: typeof Domain.SeparateTaskInput.Type) => {
    const shop = host.shop();
    return taskResult(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const existing = yield* repository.getTask({ taskId });
        if (Option.isNone(existing)) return { _tag: "NotFound" };
        yield* repository.separateTask({ taskId });
        yield* Effect.logInfo(
          `ShopAgent.separateTask: shop=${shop} workflowId=${existing.value.workflow.id} step=${String(existing.value.task.step)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            workflowId: existing.value.workflow.id,
            step: existing.value.task.step,
          }),
        );
        return { _tag: "Ok", task: null };
      }),
    );
  };

  const joinTask = ({ taskId }: typeof Domain.JoinTaskInput.Type) => {
    const shop = host.shop();
    return taskResult(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const existing = yield* repository.getTask({ taskId });
        if (Option.isNone(existing)) return { _tag: "NotFound" };
        yield* repository.joinTask({ taskId });
        yield* Effect.logInfo(
          `ShopAgent.joinTask: shop=${shop} workflowId=${existing.value.workflow.id} step=${String(existing.value.task.step)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            workflowId: existing.value.workflow.id,
            step: existing.value.task.step,
          }),
        );
        return { _tag: "Ok", task: null };
      }),
    );
  };

  const removeTask = ({ taskId }: typeof Domain.TaskIdInput.Type) =>
    taskResult(
      Effect.gen(function* () {
        yield* (yield* WorkflowRepository).removeTask({ taskId });
        return { _tag: "Ok", task: null };
      }),
    );

  /**
   * Delete a team and its tasks become unassigned: the team-delete row on
   * `D1_TABLES` (`src/lib/D1Schema.ts`). Two stores, two writes, D1 first: the two cannot
   * share a transaction, and the order is what
   * closes the race with a concurrent `addStep` / `updateTask` pointing at
   * this team. Its `teamExists` check reads D1; if that read lands after the
   * D1 delete the write is refused, and if it lands before but the task
   * write lands before the nulling, the nulling catches it — the object is
   * single-threaded, so nothing interleaves with the nulling itself. The
   * reverse order would let a task written between the nulling and the D1
   * delete validate fine and dangle forever. What remains is the nulling
   * failing after the D1 row is gone; every read already treats an id no
   * team carries as unassigned, so that state is self-healing, and a retry
   * of this call (which reports `NotFound` for the row but still runs the
   * nulling) repairs it. Nothing is refused for being in use: the confirm
   * dialog states the counts and the merchant decides.
   */
  const deleteTeam = ({ teamId }: typeof Domain.DeleteTeamInput.Type) => {
    const name = host.shop();
    const publish = () => host.publish("all");
    const closeMemberConnections = (memberIds: readonly string[]) =>
      host.closeMemberConnections(memberIds);
    return Effect.gen(function* () {
      const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(name);
      const id = yield* Schema.decodeUnknownEffect(Domain.TeamId)(teamId);
      const deleted = yield* (yield* Repository).deleteTeam({ shop, id }).pipe(
        Effect.map((memberIds) => ({
          result: { _tag: "Deleted" } satisfies Domain.DeleteTeamResult,
          memberIds: memberIds as readonly string[],
        })),
        Effect.catchTag("TeamNotFoundError", () =>
          Effect.succeed({
            result: {
              _tag: "NotFound",
            } satisfies Domain.DeleteTeamResult,
            memberIds: [] as readonly string[],
          }),
        ),
      );
      yield* (yield* WorkflowRepository).unassignTeam({ teamId });
      // The team was on every one of these members' connections; the
      // Worker cannot do this itself because `Repository.deleteTeam` runs
      // here, and only here are the team's members still readable.
      yield* closeMemberConnections(deleted.memberIds);
      yield* Effect.logInfo(
        `ShopAgent.deleteTeam: shop=${shop} teamId=${teamId} status=${deleted.result._tag}`,
      ).pipe(
        Effect.annotateLogs({ shop, teamId, status: deleted.result._tag }),
      );
      yield* publish();
      return deleted.result;
    });
  };

  /**
   * Points any open run task at a team, started or not: the remedy for an
   * unassigned task (see `deleteTeam`) and the merchant's way to move work
   * between teams. The team is checked against the shop's teams, read live from D1 here, as
   * `addStep` does, and its name is snapshotted onto the task from that same
   * read. Only `teamId` / `teamName` change, so a started task keeps
   * `startedBy*`; a done task is refused (`TaskDone`).
   */
  const merchantAssignRunTaskTeam = ({
    runTaskId,
    teamId,
  }: typeof Domain.AssignRunTaskTeamInput.Type) => {
    const shop = host.shop();
    const publish = (teams: PublishTeams) => host.publish("all", teams);
    return Effect.gen(function* () {
      yield* requireTaskAction(runTaskId, MERCHANT, ({ assign }) => assign);
      const team = yield* teamExists(teamId);
      if (team === null)
        return {
          _tag: "TeamNotFound",
        } satisfies Domain.AssignRunTaskTeamResult;
      /**
       * Both sides of the move: the team losing the task is only nameable
       * before the write, and the team gaining it only after, so the
       * lists that change are the union of the two reads.
       */
      const before = yield* orderTeamIds({ runTaskId });
      yield* (yield* RunRepository).assignRunTaskTeam({
        runTaskId,
        team: { id: team.id, name: team.name },
      });
      yield* Effect.logInfo(
        `ShopAgent.merchantAssignRunTaskTeam: shop=${shop} task=${runTaskId} teamId=${teamId}`,
      ).pipe(Effect.annotateLogs({ shop, task: runTaskId, teamId }));
      yield* publish(unionTeams(before, yield* orderTeamIds({ runTaskId })));
      return { _tag: "Assigned" } satisfies Domain.AssignRunTaskTeamResult;
    }).pipe(
      Effect.catchTags({
        RunNotFoundError: () =>
          Effect.succeed<Domain.AssignRunTaskTeamResult>({
            _tag: "NotFound",
          }),
        TaskDoneError: () =>
          Effect.succeed<Domain.AssignRunTaskTeamResult>({
            _tag: "TaskDone",
          }),
        RunTerminalError: () =>
          Effect.succeed<Domain.AssignRunTaskTeamResult>({
            _tag: "RunNotOpen",
          }),
        RunNotAllowedError: () =>
          Effect.succeed<Domain.AssignRunTaskTeamResult>({
            _tag: "NotAllowed",
          }),
      }),
    );
  };

  /**
   * Development seed: replaces this shop's workflow definitions (and every
   * run) with `input.workflows` in one transaction, so the fixture arrives as
   * a single declarative payload and a failure partway cannot leave a
   * half-built definition behind.
   *
   * Gated on `ENVIRONMENT === "local"` here as well as at the route that calls
   * it (`src/routes/api.dev.seed.ts`): this is the one write path into
   * `Workflow` that skips the name, limit, and team checks, and the
   * guard belongs with the bypass, not only with its current caller. An
   * ordinary failure rather than `Effect.die` — the class's `runEffect` collapses failures
   * and defects into the same thrown `Error` at the RPC seam, so a defect buys
   * nothing here.
   *
   * Leaves every stored order un-matched on purpose: `replaceWorkflows` drops
   * every run and every definition, so the orders that survive it are carrying
   * the previous fixture's `matchedWorkflowIds`. {@link seedOrders} is what
   * puts them right, at its end, once the fixture's own orders have been
   * replaced — reconciling here would create runs on rows that call is about to
   * delete, runs and all, so the work would be thrown away a moment later.
   * `api.dev.seed.ts` always calls both, in that order.
   *
   * Returns each workflow's minted id so the caller can point an item at
   * one; the fixture speaks names, `api.dev.seed.ts` does the mapping.
   */
  const seedWorkflows = (seed: typeof Domain.SeedWorkflowsInput.Type) => {
    const environment = env.ENVIRONMENT;
    return environment === "local"
      ? WorkflowRepository.pipe(
          Effect.flatMap((repository) => repository.replaceWorkflows(seed)),
        )
      : Effect.fail(
          new WorkflowRepositoryError({
            message: `ShopAgent.seedWorkflows: environment=${environment}: seeding is local-only`,
            cause: environment,
          }),
        );
  };

  /**
   * Development seed for orders, same gate and reasoning as `seedWorkflows`.
   * Goes through `upsertOrder` + `reconcileOrder` rather than raw inserts so
   * the fixture exercises run creation, and `done` marks tasks done through
   * `markTaskDone` with the task's own team so the check of which tasks
   * are current is exercised the way it is on the floor. `advance`, `started`, and
   * `blocked` go through the same actions for the same reason: a seeded
   * card reading "Step 2 of 3" with In progress and Blocked badges is
   * indistinguishable from one a
   * worker produced. Only rows under `SEED_ORDER_ID_PREFIX` are replaced;
   * synced orders are left alone.
   *
   * Four phases per order, in this order (`Domain.SeedOrdersInput` says what
   * each key means): upsert and reconcile; each item's `workflowId` through
   * `setRun`, the merchant's own Choose; progress, dispatched per run so one
   * order's items can be in different states; then the order's `after` state
   * through a second upsert, which is the only way to reach the closed and
   * resized runs that need the change to land *after* a run exists.
   */
  const seedOrders = ({
    memberId,
    memberEmail,
    orders,
  }: typeof Domain.SeedOrdersInput.Type) => {
    const environment = env.ENVIRONMENT;
    const shop = host.shop();
    const publish = () => host.publish("all");
    const reconcileAll = () => reconcileAllNow("seedOrders", "seed");
    return Effect.gen(function* () {
      if (environment !== "local")
        yield* Effect.fail(
          new WorkflowRepositoryError({
            message: `ShopAgent.seedOrders: environment=${environment}: seeding is local-only`,
            cause: environment,
          }),
        );
      const orderRepository = yield* OrderRepository;
      const workflowRepository = yield* WorkflowRepository;
      const runs = yield* RunRepository;
      const reconcile = yield* reconciler("manual");
      const shopTeams = yield* teams();
      const now = yield* Clock.currentTimeMillis;
      const listOpenRuns = (orderId: string) =>
        runs
          .listRunsForOrder({ orderId })
          .pipe(
            Effect.map((details) =>
              details.filter(({ run }) => Domain.runIsOpen(run)),
            ),
          );
      const memberActor = {
        role: "member",
        memberId,
        email: memberEmail,
      } satisfies Domain.MemberActor;
      const actor = (task: Domain.RunTask) => ({
        runTaskId: task.id,
        actor: memberActor,
        teamIds: task.teamId === null ? [] : [task.teamId],
      });
      const taskCommand = (task: Domain.RunTask, merchant: boolean) =>
        merchant ? merchantTaskCommand(task) : actor(task);
      // Reloaded before every phase rather than carried: each phase
      // marks tasks done, which changes what the next one may touch.
      const openRun = (runId: string) =>
        runs
          .getRun({ runId })
          .pipe(
            Effect.map((found) =>
              Option.isSome(found) && Domain.runIsOpen(found.value.run)
                ? found.value
                : null,
            ),
          );
      const markRunDone = (runId: string, merchant: boolean) =>
        Effect.gen(function* () {
          const detail = yield* openRun(runId);
          if (detail === null) return;
          yield* Effect.forEach(
            detail.tasks,
            (task) => runs.markTaskDone(taskCommand(task, merchant)),
            { discard: true },
          );
          yield* Effect.logInfo(
            `ShopAgent.seedOrders: orderId=${detail.run.orderId} runId=${runId}: completed`,
          ).pipe(Effect.annotateLogs({ orderId: detail.run.orderId, runId }));
        });
      /** One round: every task current at the start of the round gets done; what that makes current waits for the next. */
      const advanceRun = (runId: string, merchant: boolean) =>
        Effect.gen(function* () {
          const detail = yield* openRun(runId);
          if (detail === null) return;
          yield* Effect.forEach(
            seedReadyTasks([detail]),
            (task) => runs.markTaskDone(taskCommand(task, merchant)),
            { discard: true },
          );
        });
      const startRun = (runId: string) =>
        Effect.gen(function* () {
          const detail = yield* openRun(runId);
          if (detail === null) return;
          yield* Effect.forEach(
            detail.tasks.filter((task) => task.doneAt === null),
            (task) =>
              runs
                .startTask(actor(task))
                .pipe(Effect.catchTag("TaskNotReadyError", () => Effect.void)),
            { discard: true },
          );
        });
      const blockOneRun = (
        runId: string,
        reason: Domain.BlockReason,
        merchant: boolean,
      ) =>
        Effect.gen(function* () {
          const detail = yield* openRun(runId);
          if (detail === null) return;
          yield* runs
            .blockRun({
              runId,
              ...(merchant
                ? { actor: { role: "merchant" as const } }
                : {
                    actor: memberActor,
                    teamIds: detail.tasks.flatMap((task) =>
                      task.teamId === null ? [] : [task.teamId],
                    ),
                  }),
              reason,
            })
            .pipe(Effect.catchTag("RunNotAllowedError", () => Effect.void));
        });
      const applyProgress = (runId: string, progress: Domain.SeedProgress) =>
        Effect.gen(function* () {
          const merchant = progress.byMerchant === true;
          if (progress.done === true) yield* markRunDone(runId, merchant);
          for (let round = 0; round < (progress.advance ?? 0); round += 1)
            yield* advanceRun(runId, merchant);
          if (progress.started === true) yield* startRun(runId);
          if (progress.blocked !== undefined)
            yield* blockOneRun(runId, progress.blocked, merchant);
          if (progress.cancelled === true)
            yield* runs.cancelRun({ runId }).pipe(
              Effect.catchTags({
                RunNotFoundError: () => Effect.void,
                RunTerminalError: () => Effect.void,
                RunOrderClosedError: () => Effect.void,
              }),
            );
        });
      /**
       * The merchant's own Choose, on an item the seed wrote moments
       * ago: the same `setRun` the attach callable makes, so the run it
       * leaves carries `manual` and is indistinguishable from a chosen one.
       * A fixture naming a workflow that cannot start the item is a
       * fixture bug — failing here is louder than leaving the row reading
       * as whatever its tags happened to match.
       */
      const setChosenWorkflow = (
        orderId: string,
        position: number,
        workflowId: string,
      ) =>
        Effect.gen(function* () {
          const lineItemId = `${orderId}/line-${String(position)}`;
          const target = yield* orderRepository.getLineItem(lineItemId);
          const found = yield* workflowRepository.getWorkflow({
            workflowId,
          });
          const detail: Domain.WorkflowDetail | null = Option.isSome(found)
            ? { workflow: found.value.workflow, tasks: found.value.tasks }
            : null;
          yield* Option.isNone(target) ||
          detail === null ||
          !workflowIsEligible(detail, shopTeams)
            ? Effect.fail(
                new WorkflowRepositoryError({
                  message: `ShopAgent.seedOrders: lineItemId=${lineItemId} workflowId=${workflowId}: no such line item, or a workflow that cannot start`,
                  cause: workflowId,
                }),
              )
            : runs.setRun({
                workflow: detail,
                teams: shopTeams,
                order: target.value.order,
                lineItem: target.value.lineItem,
              });
        });
      // Orders, items and runs, together. The upserts below mark each
      // order counted before its first run (`markSeedOrdersCounted`), so
      // a reseed leaves the usage count where it was.
      yield* orderRepository.deleteSeedOrders();
      let runCount = 0;
      for (const [index, seed] of orders.entries()) {
        const id = `${Domain.SEED_ORDER_ID_PREFIX}${String(seed.n)}`;
        // At or after `now`, never before: the workflows this fixture
        // starts were turned on moments ago and the date rule skips an
        // order placed before its workflow. Spaced a millisecond apart
        // so the index's keyset order matches `orders` order, newest
        // last, while the tail of the fixture stays within a blink of
        // `now`: a wider gap dates the last rows into the future, and
        // anything that compares `processedAt` against `now` — a
        // reconcile after a workflow is activated, for one — would then
        // read a shop that cannot exist.
        const processedAt = now + index;
        const order: Domain.ShopOrder = {
          id,
          legacyId: `seed-${String(seed.n)}`,
          name: `#${String(seed.n)}`,
          processedAt,
          updatedAt: now,
          cancelledAt: null,
          fulfillmentStatus: seed.fulfillmentStatus ?? "UNFULFILLED",
          fullyPaid: seed.unpaid !== true,
          note: seed.note ?? null,
          lineItemsTruncated: false,
          syncedAt: now,
        };
        /** `changed` is the `after` block's quantities, by 1-based position; without it this is the order as placed. */
        const lineItemsOf = (
          changed: Domain.SeedOrderChange["lineItems"] = [],
        ) =>
          seed.lineItems.map((item, position) => {
            const override = changed.find(
              (entry) => entry.position === position + 1,
            );
            const currentQuantity =
              override?.currentQuantity ??
              item.currentQuantity ??
              item.quantity;
            return {
              id: `${id}/line-${String(position + 1)}`,
              orderId: id,
              title: item.title,
              variantTitle: null,
              sku: null,
              quantity: item.quantity,
              currentQuantity,
              productTags: item.tags,
              matchedWorkflowIds: [],
              properties: item.properties ?? [],
            } satisfies Domain.OrderLineItem;
          });
        yield* orderRepository.upsertOrder({
          order,
          lineItems: lineItemsOf(),
          afterWrite: orderRepository
            .markSeedOrdersCounted([id])
            .pipe(Effect.andThen(reconcile(order))),
        });
        for (const [position, item] of seed.lineItems.entries())
          if (item.workflowId !== undefined)
            yield* setChosenWorkflow(id, position + 1, item.workflowId);
        const open = yield* listOpenRuns(id);
        runCount += open.length;
        for (const { run } of open) {
          // `${id}/line-<position>` is this seed's own id scheme, so the
          // position is readable back off the run without a join.
          const position = Number(run.lineItemId.slice(`${id}/line-`.length));
          yield* applyProgress(
            run.id,
            seed.lineItems[position - 1]?.progress ?? seed,
          );
        }
        if (seed.after !== undefined) {
          const changed: Domain.ShopOrder = {
            ...order,
            cancelledAt: seed.after.cancelled === true ? now : null,
            fulfillmentStatus:
              seed.after.fulfillmentStatus ?? order.fulfillmentStatus,
            updatedAt: now,
          };
          yield* orderRepository.upsertOrder({
            order: changed,
            lineItems: lineItemsOf(seed.after.lineItems),
            afterWrite: reconcile(changed),
          });
        }
      }
      // The orders this seed did not write: synced rows a fixture leaves
      // alone, whose runs `seedWorkflows` deleted along with the
      // definitions those runs named. Nothing above touches them, and a
      // stored order still matched against a workflow that no longer
      // exists is a state the ordinary path never produces.
      yield* reconcileAll();
      yield* Effect.logInfo(
        `ShopAgent.seedOrders: shop=${shop} orders=${String(orders.length)} runs=${String(runCount)}`,
      ).pipe(
        Effect.annotateLogs({
          shop,
          orders: orders.length,
          runs: runCount,
        }),
      );
      yield* publish();
    });
  };

  return {
    listOrders,
    subscribeOrders,
    getWorkflowDetail,
    createWorkflow,
    duplicateWorkflow,
    updateWorkflow,
    updateWorkflowTag,
    createDraft,
    applyDraft,
    discardDraft,
    setWorkflowOn,
    applyAndTurnOn,
    setWorkflowActivatedAt,
    countWaitingOrders,
    removeWorkflow,
    getOrderDetail,
    subscribeOrder,
    merchantListRunsForOrder,
    merchantAttachWorkflow,
    merchantCancelRun,
    merchantMarkTaskDone,
    merchantReopenTask,
    merchantPutBackTask,
    merchantSetRunNote,
    merchantBlockRun,
    merchantSetBlockReason,
    merchantUnblockRun,
    listRuns,
    subscribeRuns,
    memberStartTask,
    memberPutBackTask,
    memberSetRunNote,
    memberBlockRun,
    memberSetBlockReason,
    memberMarkTaskDone,
    memberReopenTask,
    memberGetRun,
    subscribeRun,
    memberUnblockRun,
    addStep,
    addTask,
    updateTask,
    moveTask,
    separateTask,
    joinTask,
    removeTask,
    deleteTeam,
    merchantAssignRunTaskTeam,
    seedWorkflows,
    seedOrders,
    listTeamWorkflows,
    listWorkflows,
    listAllTeamWorkflows,
    countTasksByTeam,
    /**
     * For the class's sync wiring, which passes it to `OrdersAgent`'s
     * `fetchAndUpsertOrder` as its `reconciler`; the function it yields is the
     * store's `afterWrite`.
     */
    reconciler,
    /** The teams with an open task on the target, for the class's webhook publish. */
    orderTeamIds,
  };
});

/**
 * The object's shop work: workflows, drafts, runs, tasks, teams, the
 * orders index, reconcile and the seed. Each method takes the decoded input
 * (and, for a `member*` write, the connection's
 * {@link Domain.MemberConnectionState}); the class's callable is the role
 * guard and the decode. The object map is on {@link ShopAgentHost}.
 */
export class ShopWorkAgent extends Context.Service<
  ShopWorkAgent,
  Effect.Success<typeof make>
>()("ShopWorkAgent") {
  static readonly layer = Layer.effect(ShopWorkAgent, make);
}

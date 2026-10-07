import type { SqlError } from "effect/unstable/sql";

import {
  Cache,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";

import { CloudflareEnv, instrumentationIsOn } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository, type RepositoryError } from "@/lib/Repository";
import {
  RunNotAllowedError,
  type RunNotBlockedError,
  RunNotFoundError,
  type RunTerminalError,
  type RunBlockedError,
  type RunOrderClosedError,
  type TaskNotReadyError,
  type ReconcileContext,
  RunRepository,
  RunRepositoryError,
} from "@/lib/RunRepository";
import {
  type NoDraftError,
  type NoTasksError,
  type StepNotFoundError,
  type TaskNotFoundError,
  type TaskUnassignedError,
  type WorkflowLimitError,
  type WorkflowNotFoundError,
  type WorkflowNameTakenError,
  type WorkflowTagTakenError,
  WorkflowRepository,
  WorkflowRepositoryError,
} from "@/lib/WorkflowRepository";

import { BillingAgent } from "./Billing.ts";
import { ShopAgentHost } from "./Host.ts";

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

const switchResult = <R>(
  effect: Effect.Effect<
    Domain.Workflow,
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
    Effect.map((workflow): Domain.SwitchResult => ({ _tag: "Ok", workflow })),
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
 * Every repository refusal under the action set is a race between the
 * render and the click, so each answers `NotAllowed` ({@link Domain.RunResult}).
 * `WorkflowRepositoryError` and `SchemaError` ride along because the actions
 * that can create a run load the start context (the active workflows, from this
 * object, teams from D1) first.
 */
const NOT_ALLOWED = Effect.succeed<Domain.RunResult>({ _tag: "NotAllowed" });

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
      RunTerminalError: () => NOT_ALLOWED,
      RunBlockedError: () => NOT_ALLOWED,
      RunOrderClosedError: () => NOT_ALLOWED,
      RunNotAllowedError: () => NOT_ALLOWED,
      RunNotBlockedError: () => NOT_ALLOWED,
      TaskNotReadyError: () => NOT_ALLOWED,
    }),
  );

/**
 * A verb publishes only after a write that succeeded (`when` is `written`
 * in the sites table on `ShopAgent.publish`): a refused call wrote nothing
 * a screen shows, so an invalidation would cost every live screen a
 * refetch for no change. The refused tab is not left stale by this: it
 * refetches itself on every result (`useMemberRunActions`'s `settle`, the
 * order page's `invalidate`).
 */
const publishIfOk =
  <R>(publish: () => Effect.Effect<void, never, R>) =>
  (result: { readonly _tag: string }) =>
    result._tag === "Ok" ? publish() : Effect.void;

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

/**
 * An orders index read's memo key: the input, and the D1 teams the read
 * derives `unassigned` against. Effect compares arrays and plain objects
 * structurally, so a team added, renamed or deleted is a different key and
 * the old entry is never asked for again.
 */
class OrdersMemoKey extends Data.Class<{
  readonly limit: number;
  readonly cursor: string | null;
  readonly q: Domain.ListSearch | null;
  readonly show: Domain.OrdersShow | null;
  readonly team: Domain.TeamId | null;
  readonly teams: Domain.EligibleContext["teams"];
}> {}

/** A workflows list read's memo key: the member's teams, sorted, so two members on the same teams share one entry. */
class RunsMemoKey extends Data.Class<{
  readonly teamIds: readonly Domain.TeamId[];
}> {}

/**
 * A failed lookup expires at once, so the next read retries; a success is
 * kept until the next publish clears it. `Cache` otherwise stores the
 * failure's `Exit` and replays it to every later `get`.
 */
const keepSuccesses = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Duration.zero : Duration.infinity;

/**
 * The bound on keys per memo. The keys in use are the filter combinations
 * merchants have open and the team sets members have open, both far fewer;
 * the bound caps memory if a client walks many cursors.
 */
const MEMO_CAPACITY = 32;

const make = Effect.gen(function* () {
  const host = yield* ShopAgentHost;
  const env = yield* CloudflareEnv;
  /** The one crossing into billing; the rule is on {@link BillingAgent}'s `flushUsageEvents`. */
  const { flushUsageEvents } = yield* BillingAgent;
  const orderRepository = yield* OrderRepository;
  const runRepository = yield* RunRepository;

  /** The orders index's memo; the rule is on the class's `publish`. */
  const ordersMemo = yield* Cache.makeWith(
    ({ limit, cursor, q, show, team, teams }: OrdersMemoKey) =>
      orderRepository.listOrders({ limit, cursor, q, show, team, teams }),
    { capacity: MEMO_CAPACITY, timeToLive: keepSuccesses },
  );
  /** The workflows list's memo; the rule is on the class's `publish`. */
  const runsMemo = yield* Cache.makeWith(
    ({ teamIds }: RunsMemoKey) => runRepository.runListItems(teamIds),
    { capacity: MEMO_CAPACITY, timeToLive: keepSuccesses },
  );
  /** Empties both memos; the class's `publish` runs it before any invalidation goes out. */
  const clearListMemo = Effect.all([
    Cache.invalidateAll(ordersMemo),
    Cache.invalidateAll(runsMemo),
  ]).pipe(Effect.asVoid);

  /**
   * The orders index read, for the loader and the socket alike. The page is memoized ({@link ShopWorkAgent}'s
   * `clearListMemo`, the rule on the class's `publish`), keyed by the input
   * and the D1 teams, which are read live on every call as before: they are
   * the one input outside the object, so a team change is a new key rather
   * than a stale entry. `syncState` is read live, outside the memo: the
   * in-flight half is the SDK's workflow row, which no publish tracks.
   */
  const listOrders = ({
    limit,
    cursor,
    q,
    show,
    team,
  }: Domain.ListOrdersInput) => {
    const shop = host.shop();
    const readTeams = () => teams();
    return Effect.gen(function* () {
      const repository = yield* OrderRepository;
      /* One read of the teams for both consumers: the repository derives
         `unassigned` from it, and
         `OrdersIndexData` carries it so the route can name the ids it gets
         back. */
      const teams = yield* readTeams();
      const started = yield* Clock.currentTimeMillis;
      const page = yield* Cache.get(
        ordersMemo,
        new OrdersMemoKey({ limit, cursor, q, show, team, teams }),
      );
      if (instrumentationIsOn(env.ENVIRONMENT)) {
        const ms = (yield* Clock.currentTimeMillis) - started;
        const rows = page.orders.length;
        const showLog = show ?? "null";
        const teamLog = team === null ? "null" : "set";
        const qLog = q === null ? "null" : "set";
        const cursorLog = cursor === null ? "null" : "set";
        yield* Effect.logInfo(
          `ShopAgent.listOrders: shop=${shop} show=${showLog} team=${teamLog} q=${qLog} cursor=${cursorLog} rows=${String(rows)} ms=${String(ms)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            show: showLog,
            team: teamLog,
            q: qLog,
            cursor: cursorLog,
            rows,
            ms,
          }),
        );
      }
      return {
        page,
        syncState: {
          inFlight: yield* host.syncInFlight(yield* Clock.currentTimeMillis),
          ...(yield* repository.getSyncState()),
        },
        teams,
      } satisfies Domain.OrdersIndexData;
    });
  };

  const listWorkflows = (input: Domain.ListWorkflowsInput) =>
    Effect.gen(function* () {
      return yield* (yield* WorkflowRepository).listWorkflows({
        ...input,
        teams: yield* teams(),
      });
    });

  /**
   * `getWorkflowDetail`, not `getWorkflow`: the Agents SDK base class already
   * has a `getWorkflow(workflowId)` that tracks Cloudflare Workflow instances.
   *
   * Joins team names from D1 inside the object rather than in a server fn: the
   * runtime already holds `Repository`, and one round trip returns the tasks,
   * their resolved team names and member counts, and the teams the Assign team select
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
        draftTasks:
          detail.value.draftTasks === null
            ? null
            : withTeamNames(detail.value.draftTasks),
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

  /** Duplicate: the new workflow is inactive, keeps the tasks, and takes the name and tag the dialog collected (`WorkflowRepository.duplicateWorkflow`). */
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
   * reconcile, and publishes whether or not the pass ran or moved a run
   * (the rule on `publish`): Edit tag changes which orders match, which the
   * order page's Workflow select shows as matched; that is not a run write,
   * so there is no count to gate on.
   */
  const updateWorkflowTag = ({
    workflowId,
    tag,
  }: typeof Domain.UpdateWorkflowTagInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllIfActive("updateWorkflowTag", workflow);
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /** Edit: creates the draft (or returns the existing one). */
  const createDraft = ({ workflowId }: typeof Domain.CreateDraftInput.Type) => {
    const shop = host.shop();
    return draftResult(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const draftTasks = yield* repository.createDraft({ workflowId });
        yield* Effect.logInfo(
          `ShopAgent.createDraft: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        return { _tag: "Ok", draftTasks } satisfies Domain.DraftResult;
      }),
    );
  };

  /**
   * Apply changes. On an active workflow, reconciles every stored order once
   * afterwards: new tasks can make a workflow eligible for an item it was not, and those
   * orders should start now rather than at whatever moment Shopify next edits
   * them. Publishes because the next order starts against the new tasks,
   * which the order page's Workflow selects reflect, and publishes whether
   * or not the pass ran or moved a run (the rule on `publish`): Apply changes
   * what the Workflow select lists, which is not a run write, so there is no
   * count to gate on.
   */
  const applyDraft = ({ workflowId }: typeof Domain.ApplyDraftInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllIfActive("applyDraft", workflow);
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
    ).pipe(Effect.tap(publishIfOk(publish)));
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
   * The switch: writes `state`. Either way every stored order is reconciled
   * once, so a run for anything that now qualifies is created here rather than at whatever
   * moment Shopify next edits it — and turning off qualifies things too, because
   * removing one of two matching workflows resolves a multi-match and starts
   * the survivor (see {@link reconcileAllNow}). Publishes for the reason on
   * {@link applyDraft}.
   */
  const setWorkflowState = ({
    workflowId,
    state,
  }: typeof Domain.SetWorkflowStateInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllNow("setWorkflowState", workflow.id);
    return switchResult(
      Effect.gen(function* () {
        const workflow = yield* (yield* WorkflowRepository).setWorkflowState({
          workflowId,
          state,
          teams: yield* teams(),
        });
        yield* Effect.logInfo(
          `ShopAgent.setWorkflowState: shop=${shop} workflowId=${workflowId} state=${state}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId, state }));
        yield* reconcileAll(workflow);
        return workflow;
      }),
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /**
   * The editor's Turn on for a workflow that has never been applied: applies
   * the draft and turns the switch on in one transaction, then reconciles
   * every stored order once, exactly as {@link setWorkflowState} does — the
   * merchant made one decision, so a failure must leave the workflow
   * untouched rather than applied and inactive.
   */
  const applyAndTurnOn = ({
    workflowId,
  }: typeof Domain.ApplyAndTurnOnInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
    const reconcileAll = (workflow: Domain.Workflow) =>
      reconcileAllNow("applyAndTurnOn", workflow.id);
    return switchResult(
      Effect.gen(function* () {
        const workflow = yield* (yield* WorkflowRepository).applyAndTurnOn({
          workflowId,
          teams: yield* teams(),
        });
        yield* Effect.logInfo(
          `ShopAgent.applyAndTurnOn: shop=${shop} workflowId=${workflowId}`,
        ).pipe(Effect.annotateLogs({ shop, workflowId }));
        yield* reconcileAll(workflow);
        return workflow;
      }),
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /**
   * Delete a workflow and its runs stay on their orders (vocabulary on
   * `Domain.Workflow`; the rule is the data model on `initializeSchema`,
   * `ShopAgentSchema.ts`). `removeWorkflow`, not `deleteWorkflow`: the Agents
   * SDK base class already has a `deleteWorkflow(workflowId)` that drops a
   * Cloudflare Workflow instance's tracking row (`onWorkflowComplete` calls
   * it), the same collision `getWorkflowDetail` sidesteps. Publishes because
   * the workflows index and any order page's Workflow select — which lists
   * workflows — must repaint.
   *
   * Reconciles afterwards for the same reason Turn off does: the deleted
   * workflow turns off, so an item it made a multi-match now has one
   * match and the survivor's run is created.
   */
  const removeWorkflow = ({
    workflowId,
  }: typeof Domain.DeleteWorkflowInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
   * Loads what creating runs needs before any transaction opens: the shop's
   * teams from D1, the one read run creation needs that is not storage and
   * that cannot happen inside the Durable Object transaction. Loading once
   * per webhook or per bulk stream also bounds the cost for a
   * thousand-order file, at the accepted price of a teams snapshot that a
   * mid-stream team delete would not refresh: pass rule 3 on
   * {@link Domain.reconcileItem}. The workflows are not loaded here: each
   * pass reads them by its order's tags inside its own transaction
   * (`workflowsByTags`, the rule on {@link Domain.itemMatches}), so a pass
   * reads only the workflows its order can match.
   */
  const eligibleContext = () => {
    return Effect.gen(function* () {
      const workflows = yield* WorkflowRepository;
      return {
        teams: yield* teams(),
        workflowsByTags: (tags) =>
          workflows
            .listActiveWorkflowsByTags({ tags })
            .pipe(
              Effect.catchTag("WorkflowRepositoryError", (cause) =>
                Effect.fail(
                  new RunRepositoryError({ message: cause.message, cause }),
                ),
              ),
            ),
      } satisfies ReconcileContext;
    });
  };

  /**
   * Reconcile every stored open paid order once against the active workflows *now*,
   * so anything that now qualifies starts at this moment rather than at
   * whatever moment Shopify next edits it. Reconcile is an idempotent state
   * check, so running it over every order is safe. Not the write's
   * transaction: the repository owns that one and Durable Object SQLite
   * refuses to nest, but the Durable Object serialises callables so nothing
   * interleaves. Returns nothing: the pass logs its counts, and no count
   * reaches a screen (pass rule 6 on {@link Domain.reconcileItem}).
   *
   * Unconditional, because a workflow turning off creates runs too: one item
   * matched by two active workflows is a multi-match and carries no run, so
   * turning one of them off — or deleting it — leaves a single match and the
   * survivor's run begins. That is why {@link setWorkflowState} and
   * {@link removeWorkflow} call this directly rather than through
   * {@link reconcileAllIfActive}.
   *
   * Sends the usage queue after the pass ({@link flushUsageEvents}), whether
   * or not it finished: pass rule 4 on {@link Domain.reconcileItem}.
   */
  const reconcileAllNow = (caller: string, id: string) => {
    const shop = host.shop();
    return Effect.gen(function* () {
      const counts = yield* (yield* RunRepository).reconcileAll(
        yield* eligibleContext(),
      );
      yield* Effect.logInfo(
        `ShopAgent.reconcileAll: shop=${shop} caller=${caller} id=${id} orders=${String(counts.orders)} created=${String(counts.created)} multiMatch=${String(counts.multiMatch)}`,
      ).pipe(Effect.annotateLogs({ shop, caller, id, ...counts }));
    }).pipe(Effect.ensuring(flushUsageEvents));
  };

  /**
   * {@link reconcileAllNow}, skipped when the workflow is inactive: for the
   * definition writes (Apply, Edit tag) that change *how* a workflow
   * matches. An inactive workflow matches nothing either way, so nothing about the
   * active workflows changed and the pass would be a full scan for no writes. Turn
   * off and delete do move it, and use {@link reconcileAllNow}.
   */
  const reconcileAllIfActive = (caller: string, workflow: Domain.Workflow) => {
    const run = () => reconcileAllNow(caller, workflow.id);
    return Effect.gen(function* () {
      if (!Domain.workflowIsActive(workflow)) return;
      yield* run();
    });
  };

  const reconciler = () => {
    const shop = host.shop();
    return Effect.gen(function* () {
      const context = yield* eligibleContext();
      const runs = yield* RunRepository;
      return (order: Domain.ShopOrder) =>
        runs.reconcileOrder({ ...context, orderId: order.id }).pipe(
          Effect.tap(({ created, resized, closed, multiMatch }) =>
            Effect.logInfo(
              `ShopAgent.reconcileOrder: shop=${shop} orderId=${order.id} created=${String(created)} resized=${String(resized)} closed=${String(closed)} multiMatch=${String(multiMatch)}`,
            ).pipe(
              Effect.annotateLogs({
                shop,
                orderId: order.id,
                created,
                resized,
                closed,
                multiMatch,
              }),
            ),
          ),
        );
    });
  };

  /**
   * The order page's read, for the loader and the socket alike: the order,
   * its items, and every run on them. Addressed by `legacyId` because that
   * is what the route carries (see `Domain.GetOrderDetailInput`). `null`
   * when the order is not stored, which the page renders as not-found
   * rather than as a failure.
   */
  const getOrderDetail = ({ legacyId }: Domain.GetOrderDetailInput) => {
    return Effect.gen(function* () {
      const orders = yield* OrderRepository;
      const runs = yield* RunRepository;
      const detail = yield* orders.getOrderByLegacyId(legacyId);
      if (Option.isNone(detail)) return null;
      const { order, lineItems } = detail.value;
      const repository = yield* WorkflowRepository;
      const matched = (yield* repository.listActiveWorkflowsByTags({
        tags: [...new Set(lineItems.flatMap(({ productTags }) => productTags))],
      })).filter(({ tasks }) => tasks.length > 0);
      const shopTeams = yield* teams();
      return {
        order,
        lineItems,
        runs: yield* runs.listRunsForOrder({ orderId: order.id }),
        teams: shopTeams,
        matchedWorkflows: matched,
        otherWorkflows: (yield* repository.listActiveWorkflowNames()).filter(
          (workflow) =>
            !matched.some((detail) => detail.workflow.id === workflow.id),
        ),
      } satisfies Domain.OrderPageData;
    });
  };

  /**
   * Manual attach, read as **set this item's workflow**. It applies only the
   * definition half of the start predicate (`workflowIsEligible`): an admin choosing a
   * workflow for an item by hand is exactly the override for a missing
   * tag or a fulfilled line. What it is not is an override of the order itself being over, which
   * is `Domain.orderIsOpen`.
   *
   * An item holds at most one run, so attaching over one is a replace: the
   * incumbent is deleted in the same transaction and comes back as
   * `replaced` for the toast. The same workflow again on an open run is
   * `AlreadyExists`.
   * Over a closed run it is a fresh start, the closed workflow included, and
   * `replaced` is null (`Domain.RunState`); over a done run it is a replace
   * like an open one. An item with no
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
    const publish = () => host.publish;
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
      if (detail === null || !Domain.workflowIsEligible(detail, shopTeams))
        return {
          _tag: "WorkflowNotEligible",
        } satisfies Domain.AttachResult;
      if (!Domain.orderIsOpen(target.value.order))
        return { _tag: "OrderClosed" } satisfies Domain.AttachResult;
      // The same rule as `changeWorkflow` ({@link Domain.runActions}), for
      // an item with no run too: nothing to make, nothing to start.
      if (Domain.unitsToMake(target.value.lineItem) === 0)
        return { _tag: "NothingToMake" } satisfies Domain.AttachResult;
      // Over a run this is Change workflow: `changeWorkflow` on
      // {@link Domain.runActions} reads the order and the units, and both
      // refusals above are its, so a run in any state is replaced here.
      const set = yield* (yield* RunRepository).setRun({
        workflow: detail,
        teams: shopTeams,
        order: target.value.order,
        lineItem: target.value.lineItem,
      });
      if (Option.isNone(set))
        return { _tag: "AlreadyExists" } satisfies Domain.AttachResult;
      yield* publish();
      return {
        _tag: "Ok",
        run: set.value.run,
        replaced: set.value.replaced,
      } satisfies Domain.AttachResult;
    }).pipe(Effect.ensuring(flushUsageEvents));
  };

  /**
   * Closes the run, reason `merchant_cancelled`
   * (`RunRepository.cancelRun`, rule on `Domain.RunState`). Gated by
   * `Domain.runActions` `cancel`, which is false on a closed order: reconcile
   * has already closed every open run there.
   */
  const merchantCancelRun = ({ runId }: typeof Domain.RunIdInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
    return runResult(
      Effect.gen(function* () {
        yield* requireRunAction(runId, MERCHANT, "cancel");
        yield* (yield* RunRepository).cancelRun({ runId });
        yield* Effect.logInfo(
          `ShopAgent.merchantCancelRun: shop=${shop} runId=${runId}`,
        ).pipe(Effect.annotateLogs({ shop, runId }));
      }),
    ).pipe(Effect.tap(publishIfOk(publish)));
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
   * Step order, the run's state, and the later-step reopen guard still apply.
   *
   * There is no merchant Start: "started" records that a worker picked the task up,
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
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  const merchantReopenTask = ({
    runTaskId,
  }: typeof Domain.ReopenTaskInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
    return runResult(
      Effect.gen(function* () {
        yield* requireTaskAction(runTaskId, MERCHANT, ({ reopen }) => reopen);
        yield* (yield* RunRepository).reopenTask({
          runTaskId,
          actor: { role: "merchant" },
        } satisfies Domain.ReopenTaskCommand);
        yield* Effect.logInfo(
          `ShopAgent.merchantReopenTask: shop=${shop} task=${runTaskId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId }));
      }),
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /** Put back from the order page; the rule is on `RunRepository.putBackTask`. */
  const merchantPutBackTask = ({
    runTaskId,
  }: typeof Domain.PutBackTaskInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /** The note itself never reaches the log line, as on the member's {@link memberSetRunNote}. */
  const merchantSetRunNote = ({
    runId,
    note,
  }: typeof Domain.SetRunNoteInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  const merchantBlockRun = ({
    runId,
    reason,
  }: typeof Domain.BlockRunInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  const merchantUnblockRun = ({ runId }: typeof Domain.RunIdInput.Type) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /**
   * No D1 read: `startedByEmail` is a snapshot on the row, so the list reads
   * the same after the member is deleted. Every half of `Domain.WorkflowsListData`
   * comes from one call so the loader and the socket paint one snapshot: the
   * strip and the list under it are never two reads that can disagree.
   *
   * The Done or closed count is read on every state (`listRecent` with `limit: 0`
   * counts without reading rows) because the strip shows it whatever is
   * chosen; its rows are read only when `query.state` is "done", or under a
   * search, when both halves come back: the open matches and the Done or
   * closed matches, each cut to `query.limit` ({@link Domain.WorkflowsListData}).
   *
   * `query.team` narrows Done or closed the same way it narrows the other states, and a team
   * the member is not on narrows it to nothing — the same answer
   * {@link Domain.workflowsListFrom} gives for the other states, reached here because `listRecent` takes
   * the team list already narrowed. A search ignores the team, so its rows
   * are read over every team on the connection while the count stays narrowed.
   *
   * The current half is memoized ({@link ShopWorkAgent}'s `clearListMemo`,
   * the rule on the class's `publish`): the rows the member's teams own
   * (`RunRepository.runListItems`), keyed by the team ids sorted, so members
   * on the same teams share one computation, and each member's grouping
   * ({@link Domain.workflowsListFrom}) runs on every read because it is per
   * member and reads no rows. `listRecent` is outside the memo: its window
   * slides with the clock, so the same key would not mean the same answer a
   * minute later.
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
      const teamRows = yield* Cache.get(
        runsMemo,
        new RunsMemoKey({ teamIds: teamIds.toSorted() }),
      );
      const {
        counts,
        items,
        matches: openMatches,
      } = Domain.workflowsListFrom(teamRows, memberEmail, query);
      const recentTeamIds =
        query.team === null
          ? teamIds
          : teamIds.filter((teamId) => teamId === query.team);
      const since = started - Domain.DONE_WINDOW_MS;
      const recent = yield* repository.listRecent({
        teamIds: recentTeamIds,
        since,
        limit:
          query.q === null && Domain.workflowsListStateIsDone(query.state)
            ? query.limit
            : 0,
        q: null,
      });
      /**
       * The search's Done or closed half, read over every team with the
       * term: its rows, and its `total` is how many of the window match
       * before the cut, which with the open half's `matches` is
       * `Domain.WorkflowsListData.matches`.
       */
      const recentMatches =
        query.q === null
          ? null
          : yield* repository.listRecent({
              teamIds,
              since,
              limit: query.limit,
              q: query.q,
            });
      const recentItems =
        recentMatches === null ? recent.items : recentMatches.items;
      const matches =
        openMatches === null || recentMatches === null
          ? null
          : openMatches + recentMatches.total;
      /**
       * The fan-out this read was cut to bound, measured on real shops:
       * `rows` is what left the object, and it must stay at or under
       * `query.limit`, or twice it under a search, which returns both halves.
       */
      const rows = items.length + recentItems.length;
      const team = query.team ?? "all";
      const q = query.q === null ? "null" : "set";
      const ms = (yield* Clock.currentTimeMillis) - started;
      if (instrumentationIsOn(env.ENVIRONMENT))
        yield* Effect.logInfo(
          `ShopAgent.readRuns: shop=${shop} teams=${String(teamIds.length)} team=${team} state=${query.state} q=${q} rows=${String(rows)} ms=${String(ms)}`,
        ).pipe(
          Effect.annotateLogs({
            shop,
            teams: teamIds.length,
            team,
            state: query.state,
            q,
            rows,
            ms,
          }),
        );
      return {
        counts: { ...counts, done: recent.total },
        items,
        recent: recentItems,
        matches,
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
   * The workflows list over the socket: the same read as {@link listRuns}.
   * `teamIds` comes from the connection, not the message, so a member's list
   * is narrowed by the membership the Worker's gate resolved — the same value
   * the loader's `requireMember` produced, arriving by the other route.
   */
  const liveRuns = (
    { query }: typeof Domain.LiveRunsInput.Type,
    { teamIds, memberEmail }: Domain.MemberConnectionState,
  ) => readRuns(teamIds, memberEmail, query);

  const memberStartTask = (
    { runTaskId }: typeof Domain.StartTaskInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /** Put back; the rule is on `RunRepository.putBackTask`. */
  const memberPutBackTask = (
    { runTaskId }: typeof Domain.PutBackTaskInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  const memberSetRunNote = (
    { runId, note }: typeof Domain.SetRunNoteInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  const memberBlockRun = (
    { runId, reason }: typeof Domain.BlockRunInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  const memberMarkTaskDone = (
    { runTaskId }: typeof Domain.MarkTaskDoneInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = () => host.publish;
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
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /**
   * Reopen, the member's Undo. Publishes like the others.
   */
  const memberReopenTask = (
    { runTaskId }: typeof Domain.ReopenTaskInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const shop = host.shop();
    const publish = () => host.publish;
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireTaskAction(runTaskId, actor, ({ reopen }) => reopen);
        yield* (yield* RunRepository).reopenTask({
          runTaskId,
          actor: { role: "member", memberId, email: memberEmail },
          teamIds,
        } satisfies Domain.ReopenTaskCommand);
        yield* Effect.logInfo(
          `ShopAgent.memberReopenTask: shop=${shop} task=${runTaskId} memberId=${memberId}`,
        ).pipe(Effect.annotateLogs({ shop, task: runTaskId, memberId }));
      }),
    ).pipe(Effect.tap(publishIfOk(publish)));
  };

  /** The workflow page's loader read; plain RPC for the same reason as {@link listRuns}. */
  const memberGetRun = (input: typeof Domain.GetRunForMemberInput.Type) => {
    return readRunPage(input);
  };

  /**
   * The workflow page over the socket, as {@link liveRuns} is to
   * {@link listRuns}: the same read as {@link memberGetRun}, with `teamIds`
   * from the connection.
   */
  const liveRun = (
    { runId }: typeof Domain.RunIdInput.Type,
    { teamIds }: Domain.MemberConnectionState,
  ) => readRunPage({ runId, teamIds });

  const memberUnblockRun = (
    { runId }: typeof Domain.RunIdInput.Type,
    { memberId, memberEmail, teamIds }: Domain.MemberConnectionState,
  ) => {
    const publish = () => host.publish;
    return runResult(
      Effect.gen(function* () {
        const actor = memberActor({ memberId, memberEmail, teamIds });
        yield* requireRunAction(runId, actor, "unblock");
        yield* (yield* RunRepository).unblockRun({
          runId,
          teamIds,
        } satisfies Domain.UnblockRunCommand);
      }),
    ).pipe(Effect.tap(publishIfOk(publish)));
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
   * nulling) repairs it. So does the next delete of any team in the shop:
   * it also nulls every pointer to a team gone from D1. The object's ids in
   * use are read before the shop's teams, so a team created between the
   * two reads, and a task pointed at it, is not among the candidates and
   * is never nulled. Nothing is refused for being in use: the confirm
   * dialog states the counts and the merchant decides.
   *
   * Reconciles every stored order afterwards ({@link reconcileAllNow}): a
   * workflow whose task lost its team stops being eligible, and an item it
   * had made a multi-match now has one match, whose run is created here rather
   * than at the order's next webhook.
   */
  const deleteTeam = ({ teamId }: typeof Domain.DeleteTeamInput.Type) => {
    const name = host.shop();
    const publish = () => host.publish;
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
      const workflows = yield* WorkflowRepository;
      const inUse = yield* workflows.teamIdsInUse();
      const live = new Set<string>((yield* teams()).map((team) => team.id));
      const gone = new Set([
        teamId,
        ...inUse.filter((candidate) => !live.has(candidate)),
      ]);
      yield* Effect.forEach(
        gone,
        (goneId) => workflows.unassignTeam({ teamId: goneId }),
        { discard: true },
      );
      yield* reconcileAllNow("deleteTeam", teamId);
      // The team was on every one of these members' connections; the
      // Worker cannot do this itself because `Repository.deleteTeam` runs
      // here, and only here are the team's members still readable.
      yield* closeMemberConnections(deleted.memberIds);
      yield* Effect.logInfo(
        `ShopAgent.deleteTeam: shop=${shop} teamId=${teamId} status=${deleted.result._tag}`,
      ).pipe(
        Effect.annotateLogs({ shop, teamId, status: deleted.result._tag }),
      );
      /* Both results publish, unlike a refused verb (`publishIfOk`): a
         `NotFound` still nulled the run tasks that pointed at a team gone
         from D1 and reconciled, and the lists show both. */
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
    const publish = () => host.publish;
    return Effect.gen(function* () {
      yield* requireTaskAction(runTaskId, MERCHANT, ({ assign }) => assign);
      const team = yield* teamExists(teamId);
      if (team === null)
        return {
          _tag: "TeamNotFound",
        } satisfies Domain.AssignRunTaskTeamResult;
      yield* (yield* RunRepository).assignRunTaskTeam({
        runTaskId,
        team: { id: team.id, name: team.name },
      });
      yield* Effect.logInfo(
        `ShopAgent.merchantAssignRunTaskTeam: shop=${shop} task=${runTaskId} teamId=${teamId}`,
      ).pipe(Effect.annotateLogs({ shop, task: runTaskId, teamId }));
      yield* publish();
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
   * Does not reconcile on purpose: `replaceWorkflows` drops every run and
   * every definition, and {@link seedOrders} reconciles the surviving orders
   * at its end, once the fixture's own orders have been replaced —
   * reconciling here would create runs on rows that call is about to
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
    const publish = () => host.publish;
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
      const reconcile = yield* reconciler();
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
      /**
       * The member a run's progress is recorded as: `by` when the fixture
       * names one, else the seed member. Only the email reaches storage
       * (`RunTask` keeps it, not an id), and the actor's `teamIds` below are
       * the task's own team whoever `by` is, so `by` need not belong to that
       * team: the fixture may have anyone start or do anything.
       */
      const memberActorOf = (by: Domain.Email | undefined) =>
        ({
          role: "member",
          memberId,
          email: by ?? memberEmail,
        }) satisfies Domain.MemberActor;
      const actor = (task: Domain.RunTask, by: Domain.Email | undefined) => ({
        runTaskId: task.id,
        actor: memberActorOf(by),
        teamIds: task.teamId === null ? [] : [task.teamId],
      });
      const taskCommand = (
        task: Domain.RunTask,
        merchant: boolean,
        by: Domain.Email | undefined,
      ) => (merchant ? merchantTaskCommand(task) : actor(task, by));
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
      const markRunDone = (
        runId: string,
        merchant: boolean,
        by: Domain.Email | undefined,
      ) =>
        Effect.gen(function* () {
          const detail = yield* openRun(runId);
          if (detail === null) return;
          yield* Effect.forEach(
            detail.tasks,
            (task) => runs.markTaskDone(taskCommand(task, merchant, by)),
            { discard: true },
          );
          yield* Effect.logInfo(
            `ShopAgent.seedOrders: orderId=${detail.run.orderId} runId=${runId}: completed`,
          ).pipe(Effect.annotateLogs({ orderId: detail.run.orderId, runId }));
        });
      /** One round: every task current at the start of the round gets done; what that makes current waits for the next. */
      const advanceRun = (
        runId: string,
        merchant: boolean,
        by: Domain.Email | undefined,
      ) =>
        Effect.gen(function* () {
          const detail = yield* openRun(runId);
          if (detail === null) return;
          yield* Effect.forEach(
            seedReadyTasks([detail]),
            (task) => runs.markTaskDone(taskCommand(task, merchant, by)),
            { discard: true },
          );
        });
      const startRun = (runId: string, by: Domain.Email | undefined) =>
        Effect.gen(function* () {
          const detail = yield* openRun(runId);
          if (detail === null) return;
          yield* Effect.forEach(
            detail.tasks.filter((task) => task.doneAt === null),
            (task) =>
              runs
                .startTask(actor(task, by))
                .pipe(Effect.catchTag("TaskNotReadyError", () => Effect.void)),
            { discard: true },
          );
        });
      const blockOneRun = (
        runId: string,
        reason: Domain.BlockReason,
        merchant: boolean,
        by: Domain.Email | undefined,
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
                    actor: memberActorOf(by),
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
          const { by } = progress;
          if (progress.done === true) yield* markRunDone(runId, merchant, by);
          for (let round = 0; round < (progress.advance ?? 0); round += 1)
            yield* advanceRun(runId, merchant, by);
          if (progress.started === true) yield* startRun(runId, by);
          if (progress.blocked !== undefined)
            yield* blockOneRun(runId, progress.blocked, merchant, by);
          if (progress.note !== undefined)
            yield* runs.setRunNote({ runId, note: progress.note });
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
          !Domain.workflowIsEligible(detail, shopTeams)
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
        // Spaced a millisecond apart so the index's keyset order matches
        // `orders` order, newest last, while the tail of the fixture stays
        // within a blink of `now`: a wider gap dates the last rows into the
        // future, a shop that cannot exist.
        const processedAt =
          now - (seed.placedDaysAgo ?? 0) * 86_400_000 + index;
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
              variantTitle: item.variantTitle ?? null,
              sku: item.sku ?? null,
              quantity: item.quantity,
              currentQuantity,
              productTags: item.tags,
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
            seed.lineItems[position - 1]?.progress ?? {
              ...seed,
              // The order's own `note` is the order note, not a run's.
              note: undefined,
            },
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
    getWorkflowDetail,
    createWorkflow,
    duplicateWorkflow,
    updateWorkflow,
    updateWorkflowTag,
    createDraft,
    applyDraft,
    discardDraft,
    setWorkflowState,
    applyAndTurnOn,
    removeWorkflow,
    getOrderDetail,
    merchantListRunsForOrder,
    merchantAttachWorkflow,
    merchantCancelRun,
    merchantMarkTaskDone,
    merchantReopenTask,
    merchantPutBackTask,
    merchantSetRunNote,
    merchantBlockRun,
    merchantUnblockRun,
    listRuns,
    liveRuns,
    memberStartTask,
    memberPutBackTask,
    memberSetRunNote,
    memberBlockRun,
    memberMarkTaskDone,
    memberReopenTask,
    memberGetRun,
    liveRun,
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
    listWorkflows,
    /**
     * For the class's sync wiring, which passes it to `OrdersAgent`'s
     * `fetchAndUpsertOrder` as its `reconciler`; the function it yields is the
     * store's `afterWrite`.
     */
    reconciler,
    clearListMemo,
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

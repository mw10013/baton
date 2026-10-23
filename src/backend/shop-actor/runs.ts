/**
 * The runs application service: the actor's runs and their tasks, the orders index's and the
 * order page's reads included. Built once per activation.
 *
 * @module
 */
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";
import { ORDERS_KEY } from "../../contract/shop-actor.ts";
import { Email, type ShopKey } from "../../domain/platform.ts";
import type { FixtureProgress } from "../../contract/fixture.ts";
import type { ShopOrder } from "../../domain/orders.ts";
import { orderIsOpen } from "../../domain/orders.ts";
import {
  type AssignRunTaskTeamInput,
  type AssignRunTaskTeamResult,
  type AttachResult,
  type AttachWorkflowInput,
  BlockReason,
  type BlockRunInput,
  currentTasks,
  DONE_WINDOW_MS,
  type GetOrderDetailInput,
  type ListOrdersInput,
  type ListSearch,
  type MarkTaskDoneInput,
  type MemberActor,
  MemberId,
  type OrderPageData,
  type OrdersIndexData,
  type OrdersShow,
  type PutBackTaskInput,
  type ReconcileCounts,
  type ReopenTaskInput,
  type RunActions,
  type RunIdInput,
  type RunQuery,
  type RunResult,
  RunNote,
  runIsOpen,
  type RunTask,
  type SetRunNoteInput,
  type StartTaskInput,
  type TaskActions,
  TeamId,
  type TeamIdName,
  runActions,
  taskActions,
  unitsToMake,
  type WorkflowDetail,
  type WorkflowsListData,
  workflowIsEligible,
  workflowsListFrom,
  workflowsListStateIsDone,
} from "../../domain/shop-work.ts";
import type { ActorFixtureRows } from "../fixture.ts";
import type { MembershipRepository } from "../membership-repository.ts";
import { makeOrderFacts, type OrderFactStore } from "./order-facts.ts";
import type { OrderRepository } from "./order-repository.ts";
import {
  type ReconcileContext,
  RunNotAllowedError,
  RunNotFoundError,
  type RunRepository,
  RunRepositoryError,
} from "./run-repository.ts";
import type { Transaction } from "./transaction.ts";
import type { WorkflowRepository } from "./workflow-repository.ts";

/** The fixture's member list as the run writes need it; a fixture's ids are always these shapes. */
const decodeFixtureMembers = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ memberId: MemberId, email: Email, teamIds: Schema.Array(TeamId) })),
);
const decodeBlockReason = Schema.decodeUnknownEffect(BlockReason);
const decodeRunNote = Schema.decodeUnknownEffect(RunNote);

/** The merchant as a gating actor: no team ids, because the merchant has none and every "M" cell is theirs. */
const MERCHANT = { role: "merchant" } as const;

/**
 * A member as the gate and the run writes need them: the identity the socket's caller carries
 * (`memberId`, `email`, `teamIds`), never the payload's.
 */
export type RunMember = Required<MemberActor>;

/**
 * An orders index read's memo key: the input, and the D1 teams the read
 * derives `unassigned` against. Effect compares arrays and plain objects
 * structurally, so a team added, renamed or deleted is a different key and
 * the old entry is never asked for again.
 */
class OrdersMemoKey extends Data.Class<{
  readonly limit: number;
  readonly cursor: string | null;
  readonly q: ListSearch | null;
  readonly show: OrdersShow | null;
  readonly team: TeamId | null;
  readonly teams: ReadonlyArray<TeamIdName>;
}> {}

/** A workflows list read's memo key: the member's teams, sorted, so two members on the same teams share one entry. */
class RunsMemoKey extends Data.Class<{
  readonly teamIds: ReadonlyArray<TeamId>;
}> {}

/**
 * The Done or closed half's memo key, without a search: the teams it reads, sorted, and how
 * many rows (`limit` 0 is the count alone).
 */
class RecentMemoKey extends Data.Class<{
  readonly teamIds: ReadonlyArray<TeamId>;
  readonly limit: number;
}> {}

/** The Done or closed half as the run repository's `listRecent` reads it. */
type RecentHalf = Effect.Success<ReturnType<RunRepository["listRecent"]>>;

type MemoKey = OrdersMemoKey | RunsMemoKey | RecentMemoKey;

/**
 * A failed lookup expires at once, so the next read retries; a success is
 * kept until a notice clears it ({@link makeRuns}). `Cache` otherwise stores the
 * failure's `Exit` and replays it to every later `get`.
 */
const keepSuccesses = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Duration.zero : Duration.infinity;

/**
 * What a write confined to some runs and their orders names in its notice ({@link makeRuns}'
 * `notifyRuns`): the teams whose workflows list and Done half it may have moved. A write that
 * cannot name them notifies in full.
 */
export interface RunsTouched {
  readonly teamIds: ReadonlyArray<TeamId>;
}

/**
 * The {@link RunsTouched} of a run write, from the gate it passed: the teams its tasks are on
 * plus any the write moves a task to.
 */
const touchedBy = (
  { tasks }: { readonly tasks: ReadonlyArray<RunTask> },
  ...movedTo: ReadonlyArray<TeamId>
): RunsTouched => ({
  teamIds: [...tasks.flatMap(({ teamId }) => (teamId === null ? [] : [teamId])), ...movedTo],
});

/**
 * The bound on keys per memo. The keys in use are the filter combinations
 * merchants have open and the team sets members have open, both far fewer;
 * the bound caps memory if a client walks many cursors.
 */
const MEMO_CAPACITY = 32;

const NOT_ALLOWED: RunResult = { _tag: "NotAllowed" };

/**
 * Maps the repository's expected failures onto `RunResult`. Every repository refusal under the
 * action set is a race between the render and the press, so each answers `NotAllowed`;
 * `RunNotFoundError` is `NotFound`. Faults (`SqlError`, decode errors) are defects.
 */
const runResult = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<void, E, R>,
): Effect.Effect<RunResult, never, R> =>
  effect.pipe(
    Effect.as<RunResult>({ _tag: "Ok" }),
    Effect.catchTags({
      RunNotFoundError: () => Effect.succeed<RunResult>({ _tag: "NotFound" }),
      RunTerminalError: () => Effect.succeed(NOT_ALLOWED),
      RunBlockedError: () => Effect.succeed(NOT_ALLOWED),
      RunOrderClosedError: () => Effect.succeed(NOT_ALLOWED),
      RunNotAllowedError: () => Effect.succeed(NOT_ALLOWED),
      RunNotBlockedError: () => Effect.succeed(NOT_ALLOWED),
      TaskNotReadyError: () => Effect.succeed(NOT_ALLOWED),
    }),
    Effect.orDie,
  );

/**
 * The runs application service over the actor's repositories, its D1 membership, its
 * `notify` and its shop. `flushUsage` is the billing seam (the usage outbox's send), called after
 * reconcile all, even when it fails, and after Attach.
 *
 * Never inside a `transaction(…)`: no D1 read (`MembershipRepository`) and no `flushUsage`. The
 * teams are read first ({@link eligibleContext}), and each repository write opens its own
 * transaction after.
 *
 * Its memos live per activation and are shared by every tab of the shop: the orders index's
 * page and the workflows list's rows and its Done or closed half. {@link notify} clears them
 * whenever it names `ORDERS_KEY`: every sender of a notice goes through it, so no write can leave
 * a memo answering stale rows. A write confined to runs it can name (a run verb, or a webhook's
 * upsert and reconcile) notifies through {@link notifyRuns} instead, which leaves the team-keyed
 * memos of teams those runs have no task on: those rows are per run, and nothing they read
 * changed. The Done or closed half also expires when its window slides past the oldest moment
 * it counts. A memo read stays outside any transaction, because the lookup runs on a forked
 * fiber. The Show counts ({@link makeOrderFacts}) hear of no notice: their stored marks are
 * written by the writes themselves.
 */
export const makeRuns = Effect.fnUntraced(function* <R>({
  runRepository,
  orderRepository,
  orderFactStore,
  workflowRepository,
  membershipRepository,
  transaction,
  notify: rawNotify,
  flushUsage,
  shop,
}: {
  readonly runRepository: RunRepository;
  readonly orderRepository: OrderRepository;
  readonly orderFactStore: OrderFactStore;
  readonly workflowRepository: WorkflowRepository;
  readonly membershipRepository: (typeof MembershipRepository)["Service"];
  readonly transaction: Transaction;
  readonly notify: (invalidated: ReadonlyArray<string>) => Effect.Effect<void, never, R>;
  readonly flushUsage: Effect.Effect<void>;
  readonly shop: ShopKey;
}) {
  /**
   * The memo keys whose lookup ran, by identity: a cache hands its lookup the very key the
   * missing `Cache.get` was given, so a caller asks this about its own key after the get and
   * learns whether it paid the read, with no second lookup that a concurrent notice could race.
   * A caller that joined another's lookup in flight reads as a hit, which it is.
   */
  const missed = new WeakSet<MemoKey>();
  /** The orders index's page memo; the rule is on {@link makeRuns}. */
  const ordersMemo = yield* Cache.makeWith(
    (key: OrdersMemoKey) => {
      missed.add(key);
      const { limit, cursor, q, show, team, teams } = key;
      return orderRepository.listOrders({ limit, cursor, q, show, team, teams });
    },
    { capacity: MEMO_CAPACITY, timeToLive: keepSuccesses },
  );
  /** The orders index's Show counts; the rule is on {@link makeRuns}. */
  const orderFacts = yield* makeOrderFacts({ store: orderFactStore, shop });
  /** The workflows list's memo; the rule is on {@link makeRuns}. */
  const runsMemo = yield* Cache.makeWith(
    (key: RunsMemoKey) => {
      missed.add(key);
      return runRepository.runListItems(key.teamIds);
    },
    { capacity: MEMO_CAPACITY, timeToLive: keepSuccesses },
  );
  /**
   * The Done or closed half's memo, searches aside (`listRuns`). Kept until a notice clears it
   * or the window slides past the oldest moment it counts, after which a fresh read would count
   * one fewer.
   */
  const recentMemo = yield* Cache.makeWith(
    (
      key: RecentMemoKey,
    ): Effect.Effect<
      { readonly recent: RecentHalf; readonly validFor: Duration.Duration },
      Effect.Error<ReturnType<RunRepository["listRecent"]>>
    > =>
      Effect.gen(function* () {
        missed.add(key);
        const since = (yield* Clock.currentTimeMillis) - DONE_WINDOW_MS;
        // The rows' count is the collapsed entry's, which a member saw first.
        const counted =
          key.limit === 0
            ? undefined
            : (yield* Cache.get(recentMemo, new RecentMemoKey({ teamIds: key.teamIds, limit: 0 })))
                .recent;
        const recent = yield* runRepository.listRecent({
          teamIds: key.teamIds,
          limit: key.limit,
          since,
          q: null,
          counted,
        });
        const validFor =
          recent.oldest === null
            ? Duration.infinity
            : Duration.millis(
                Math.max(0, recent.oldest + DONE_WINDOW_MS - (yield* Clock.currentTimeMillis)),
              );
        return { recent, validFor };
      }),
    {
      capacity: MEMO_CAPACITY,
      timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : exit.value.validFor),
    },
  );
  /** Whether `key`'s `Cache.get` ran the lookup ({@link missed}), for a debug line. */
  const memoState = (key: MemoKey) => (missed.has(key) ? "miss" : "hit");

  /**
   * The actor's `notify`, which empties every memo first when `invalidated` names `ORDERS_KEY`:
   * an order or one of its runs changed. Every sender of a notice uses this one or
   * {@link notifyRuns}.
   */
  const notify = (invalidated: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (invalidated.includes(ORDERS_KEY)) {
        yield* Cache.invalidateAll(ordersMemo);
        yield* Cache.invalidateAll(runsMemo);
        yield* Cache.invalidateAll(recentMemo);
      }
      yield* rawNotify(invalidated);
    });

  /**
   * The `ORDERS_KEY` notice after a write confined to some runs and their orders
   * ({@link RunsTouched}): the orders index's page memo goes, and of the team-keyed memos only
   * those sharing a team with the runs. A team set's rows are
   * per run and read only that run's own tasks and order, so a run with no task on the set
   * cannot move them. A write that deletes rows, or reaches runs it cannot name, uses
   * {@link notify}.
   *
   * A verb calls it as the last step of its write, so only after a write that succeeded: a
   * refused call wrote nothing a screen shows, so a notice would cost every live screen a
   * refetch for no change.
   */
  const notifyRuns = ({ teamIds }: RunsTouched) =>
    Effect.gen(function* () {
      yield* Cache.invalidateAll(ordersMemo);
      const touched = (key: RunsMemoKey | RecentMemoKey) =>
        key.teamIds.some((teamId) => teamIds.includes(teamId));
      for (const key of Array.from(yield* Cache.keys(runsMemo)))
        if (touched(key)) yield* Cache.invalidate(runsMemo, key);
      for (const key of Array.from(yield* Cache.keys(recentMemo)))
        if (touched(key)) yield* Cache.invalidate(recentMemo, key);
      yield* rawNotify([ORDERS_KEY]);
    });

  /**
   * The shop's teams, read live from D1: what every task pointer is resolved against (an id not
   * in it is unassigned) and where `teamName` is snapshotted from.
   */
  const teams = () => membershipRepository.listTeamNames(shop);

  /**
   * Loads what creating runs needs before any transaction opens: the shop's
   * teams from D1, the one read run creation needs that is not storage and
   * that cannot happen inside the actor's transaction. Loading once
   * per webhook or per bulk stream also bounds the cost for a
   * thousand-order file, at the accepted price of a teams snapshot that a
   * mid-stream team delete would not refresh: pass rule 3 on
   * `reconcileItem`. The workflows are not loaded here: each
   * pass reads them by its order's tags inside its own transaction
   * (`workflowsByTags`, the rule on `itemMatches`), so a pass
   * reads only the workflows its order can match.
   */
  const eligibleContext = () =>
    teams().pipe(
      Effect.map((shopTeams): ReconcileContext => ({
        teams: shopTeams,
        workflowsByTags: (tags) =>
          workflowRepository
            .listActiveWorkflowsByTags({ tags })
            .pipe(
              Effect.catchTag("WorkflowRepositoryError", (cause) =>
                Effect.fail(new RunRepositoryError({ message: cause.message, cause })),
              ),
            ),
      })),
    );

  /**
   * The per-order reconcile, loaded once per webhook, Sync from Shopify or stream: the eligible
   * context is read here, before the upsert's transaction opens, and the function it yields is
   * the upsert's `afterWrite`, which runs inside it.
   */
  const reconciler = Effect.fn("Runs.reconciler")(function* () {
    const context = yield* eligibleContext();
    return (
      order: ShopOrder,
    ): Effect.Effect<ReconcileCounts, SqlError.SqlError | RunRepositoryError> =>
      runRepository.reconcileOrder({ ...context, orderId: order.id }).pipe(
        Effect.tap(({ created, resized, closed, multiMatch }) =>
          Effect.logInfo(
            `Runs.reconcileOrder: shop=${shop} orderId=${order.id} created=${String(created)} resized=${String(resized)} closed=${String(closed)} multiMatch=${String(multiMatch)}`,
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

  /**
   * Reconcile every stored open paid order once against the active workflows *now*,
   * so anything that now qualifies starts at this moment rather than at
   * whatever moment Shopify next edits it. Reconcile is an idempotent state
   * check, so running it over every order is safe. Not the write's
   * transaction: the repository opens one per order. Returns nothing: the pass logs its
   * counts, and no count reaches a screen (pass rule 6 on `reconcileItem`).
   *
   * Unconditional, because a workflow turning off creates runs too: one item
   * matched by two active workflows is a multi-match and carries no run, so
   * turning one of them off — or deleting it — leaves a single match and the
   * survivor's run begins.
   *
   * Sends the usage queue after the pass (`flushUsage`), whether
   * or not it finished: pass rule 4 on `reconcileItem`. A failure is a defect: the seam's
   * callers have no failure to answer.
   */
  const reconcileAll = (caller: string, id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const counts = yield* runRepository.reconcileAll(yield* eligibleContext());
      yield* Effect.logInfo(
        `Runs.reconcileAll: shop=${shop} caller=${caller} id=${id} orders=${String(counts.orders)} created=${String(counts.created)} multiMatch=${String(counts.multiMatch)}`,
      ).pipe(Effect.annotateLogs({ shop, caller, id, ...counts }));
    }).pipe(Effect.ensuring(flushUsage), Effect.orDie, Effect.withSpan("Runs.reconcileAll"));

  /**
   * The orders index read, for the loader and the socket alike. The page is memoized by the
   * input with the D1 teams, which are read live on every call: they are the one input outside
   * the actor, so a team change is a new key rather than a stale entry. The Show counts come
   * from the order facts against the same teams, so a team change moves them with no read.
   * `syncState` is read live, outside the memos.
   */
  const listOrders = Effect.fn("Runs.listOrders")(function* (input: ListOrdersInput) {
    // One read of the teams for every consumer: the page and the counts derive `unassigned`
    // from it, and `OrdersIndexData` carries it so the route can name the ids it gets back.
    const shopTeams = yield* teams();
    const pageKey = new OrdersMemoKey({ ...input, teams: shopTeams });
    const page = yield* Cache.get(ordersMemo, pageKey);
    const counts = yield* orderFacts.counts({ team: input.team, teams: shopTeams });
    const memo = memoState(pageKey);
    yield* Effect.logDebug(`Runs.listOrders: shop=${shop} memo=${memo}`).pipe(
      Effect.annotateLogs({ shop, memo }),
    );
    return {
      page: { ...page, ...counts },
      syncState: yield* orderRepository.getSyncStatus(yield* Clock.currentTimeMillis),
      teams: shopTeams,
    } satisfies OrdersIndexData;
  }, Effect.orDie);

  /**
   * The order page's read, for the loader and the socket alike: the order,
   * its items, and every run on them. Addressed by `legacyId` because that
   * is what the route carries (`GetOrderDetailInput`). `null`
   * when the order is not stored, which the page renders as not-found
   * rather than as a failure.
   */
  const getOrderDetail = Effect.fn("Runs.getOrderDetail")(function* ({
    legacyId,
  }: GetOrderDetailInput) {
    const detail = yield* orderRepository.getOrderByLegacyId(legacyId);
    if (Option.isNone(detail)) return null;
    const { order, lineItems } = detail.value;
    const matched = (yield* workflowRepository.listActiveWorkflowsByTags({
      tags: [...new Set(lineItems.flatMap(({ productTags }) => productTags))],
    })).filter(({ tasks }) => tasks.length > 0);
    const shopTeams = yield* teams();
    return {
      order,
      lineItems,
      runs: yield* runRepository.listRunsForOrder({ orderId: order.id }),
      teams: shopTeams,
      matchedWorkflows: matched,
      otherWorkflows: (yield* workflowRepository.listActiveWorkflowNames()).filter(
        (workflow) => !matched.some((candidate) => candidate.workflow.id === workflow.id),
      ),
    } satisfies OrderPageData;
  }, Effect.orDie);

  /**
   * **The action set is the one gate.** The page rendered the button because
   * the field was true (`runActions`); the procedure checks the
   * same field with the same inputs, read fresh inside the write's own call,
   * so a stale tab or a second admin cannot write what the page would not
   * offer. `RunNotAllowedError` (`RunResult.NotAllowed`) when the field is
   * false, `RunNotFoundError` when the run or its order is gone. The
   * repository keeps its own guards underneath as the second line. Every
   * merchant and member run write calls this or
   * {@link requireTaskAction} before it writes.
   */
  const requireRunAction = (
    runId: string,
    actor: typeof MERCHANT | RunMember,
    field: keyof RunActions,
  ) =>
    Effect.gen(function* () {
      const gate = yield* runRepository.getRunGate({ runId });
      if (Option.isNone(gate)) return yield* new RunNotFoundError({ id: runId });
      const { run, tasks, order } = gate.value;
      if (!runActions(actor, order, run, tasks)[field])
        return yield* new RunNotAllowedError({ runId, teamId: "" });
      return gate.value;
    });

  /** {@link requireRunAction} for one task, reading `taskActions`. */
  const requireTaskAction = (
    runTaskId: string,
    actor: typeof MERCHANT | RunMember,
    allowed: (actions: TaskActions) => boolean,
  ) =>
    Effect.gen(function* () {
      const gate = yield* runRepository.getRunGate({ runTaskId });
      const task = Option.isSome(gate)
        ? gate.value.tasks.find((candidate) => candidate.id === runTaskId)
        : undefined;
      if (Option.isNone(gate) || task === undefined)
        return yield* new RunNotFoundError({ id: runTaskId });
      const { run, order } = gate.value;
      if (!allowed(taskActions(actor, order, run, task)))
        return yield* new RunNotAllowedError({ runId: run.id, teamId: "" });
      return { ...gate.value, task };
    });

  const log = (message: string, annotations: Record<string, unknown>) =>
    Effect.logInfo(message).pipe(Effect.annotateLogs({ shop, ...annotations }));

  /**
   * Manual attach, read as **set this item's workflow**. It applies only the
   * definition half of the start predicate (`workflowIsEligible`): an admin choosing a
   * workflow for an item by hand is exactly the override for a missing
   * tag or a fulfilled line. What it is not is an override of the order itself being over, which
   * is `orderIsOpen`.
   *
   * An item holds at most one run, so attaching over one is a replace: the
   * incumbent is deleted in the same transaction and comes back as
   * `replaced` for the toast. The same workflow again on an open run is
   * `AlreadyExists`.
   * Over a closed run it is a fresh start, the closed workflow included, and
   * `replaced` is null (`RunState`); over a done run it is a replace
   * like an open one. An item with no
   * units to make is `NothingToMake`, the same rule as `changeWorkflow` on
   * `runActions`. Confirmation is the UI's job, not this one's — the
   * server cannot know whether the merchant has seen the trail of work
   * already done on the run it is about to delete, and a server-side refusal
   * would leave the page with nothing to offer but the same click again.
   *
   * Sends the usage queue afterwards (`flushUsage`): the run it
   * creates may be the order's first, which counts it.
   */
  const merchantAttachWorkflow = Effect.fn("Runs.merchantAttachWorkflow")(
    function* ({ lineItemId, workflowId }: AttachWorkflowInput) {
      const target = yield* orderRepository.getLineItem(lineItemId);
      if (Option.isNone(target)) return { _tag: "LineItemNotFound" } satisfies AttachResult;
      const found = yield* workflowRepository.getWorkflow({ workflowId });
      const shopTeams = yield* teams();
      // Only the workflow's own tasks can create a run; a draft is never attachable.
      const detail: WorkflowDetail | null = Option.isSome(found)
        ? { workflow: found.value.workflow, tasks: found.value.tasks }
        : null;
      if (detail === null || !workflowIsEligible(detail, shopTeams))
        return { _tag: "WorkflowNotEligible" } satisfies AttachResult;
      if (!orderIsOpen(target.value.order)) return { _tag: "OrderClosed" } satisfies AttachResult;
      // The same rule as `changeWorkflow` (`runActions`), for an item with no run too: nothing
      // to make, nothing to start.
      if (unitsToMake(target.value.lineItem) === 0)
        return { _tag: "NothingToMake" } satisfies AttachResult;
      // Over a run this is Change workflow: `changeWorkflow` on `runActions` reads the order
      // and the units, and both refusals above are its, so a run in any state is replaced here.
      const set = yield* runRepository.setRun({
        workflow: detail,
        teams: shopTeams,
        order: target.value.order,
        lineItem: target.value.lineItem,
      });
      if (Option.isNone(set)) return { _tag: "AlreadyExists" } satisfies AttachResult;
      yield* notify([ORDERS_KEY]);
      return {
        _tag: "Ok",
        run: set.value.run,
        replaced: set.value.replaced,
      } satisfies AttachResult;
    },
    Effect.ensuring(flushUsage),
    Effect.orDie,
  );

  /**
   * Closes the run, reason `merchant_cancelled` (the run repository's `cancelRun`, rule on
   * `RunState`). Gated by `runActions` `cancel`, which is false on a closed order: reconcile
   * has already closed every open run there.
   */
  const merchantCancelRun = ({ runId }: RunIdInput) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireRunAction(runId, MERCHANT, "cancel");
        yield* runRepository.cancelRun({ runId });
        yield* log(`Runs.merchantCancelRun: shop=${shop} runId=${runId}`, { runId });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.merchantCancelRun"));

  /**
   * The merchant's task and block writes on a run, from the order page's
   * Manage drawer and block banner. Each is gated by {@link requireRunAction}
   * or {@link requireTaskAction} before the repository sees it.
   *
   * Each passes `actor: { role: "merchant" }` and **no** `teamIds`,
   * which is the entire permission difference (`MarkTaskDoneCommand`):
   * the task's team need not be one of the caller's, because the merchant has
   * none, and an unassigned task is exactly the case they are here to fix.
   * Step order, the run's state, and the later-step reopen guard still apply.
   *
   * There is no merchant Start: "started" records that a worker picked the task up,
   * and a merchant marking it started on their behalf would put a name on
   * work nobody has begun. The merchant either marks it done outright or leaves
   * it for the team.
   */
  const merchantMarkTaskDone = ({ runTaskId }: MarkTaskDoneInput) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireTaskAction(runTaskId, MERCHANT, ({ done }) => done);
        yield* runRepository.markTaskDone({ runTaskId, actor: MERCHANT });
        yield* log(`Runs.merchantMarkTaskDone: shop=${shop} task=${runTaskId}`, {
          task: runTaskId,
        });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.merchantMarkTaskDone"));

  const merchantReopenTask = ({ runTaskId }: ReopenTaskInput) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireTaskAction(runTaskId, MERCHANT, ({ reopen }) => reopen);
        yield* runRepository.reopenTask({ runTaskId, actor: MERCHANT });
        yield* log(`Runs.merchantReopenTask: shop=${shop} task=${runTaskId}`, {
          task: runTaskId,
        });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.merchantReopenTask"));

  /** Put back from the order page; the rule is on the run repository's `putBackTask`. */
  const merchantPutBackTask = ({ runTaskId }: PutBackTaskInput) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireTaskAction(runTaskId, MERCHANT, ({ putBack }) => putBack);
        yield* runRepository.putBackTask({ runTaskId, actor: MERCHANT });
        yield* log(`Runs.merchantPutBackTask: shop=${shop} task=${runTaskId}`, {
          task: runTaskId,
        });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.merchantPutBackTask"));

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  const merchantSetRunNote = ({ runId, note }: SetRunNoteInput) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireRunAction(runId, MERCHANT, "note");
        yield* runRepository.setRunNote({ runId, note });
        yield* log(`Runs.merchantSetRunNote: shop=${shop} runId=${runId}`, { runId });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.merchantSetRunNote"));

  /** The reason itself never reaches the log line, as the note does not. */
  const merchantBlockRun = ({ runId, reason }: BlockRunInput) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireRunAction(runId, MERCHANT, "block");
        yield* runRepository.blockRun({ runId, actor: MERCHANT, reason });
        yield* log(`Runs.merchantBlockRun: shop=${shop} runId=${runId}`, { runId });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.merchantBlockRun"));

  const merchantUnblockRun = ({ runId }: RunIdInput) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireRunAction(runId, MERCHANT, "unblock");
        yield* runRepository.unblockRun({ runId });
        yield* log(`Runs.merchantUnblockRun: shop=${shop} runId=${runId}`, { runId });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.merchantUnblockRun"));

  /**
   * Points an open task at a team. The team check lives here, not in the repository: `Team` is a
   * D1 row the actor's SQLite cannot reference, so "team exists" is an application invariant,
   * read before the write's transaction opens. `Membership.deleteTeam` reads D1 first and nulls
   * pointers second precisely so a write that passes this check can still be caught by the
   * nulling.
   */
  const merchantAssignRunTaskTeam = Effect.fn("Runs.merchantAssignRunTaskTeam")(
    function* ({ runTaskId, teamId }: AssignRunTaskTeamInput) {
      const gate = yield* requireTaskAction(runTaskId, MERCHANT, ({ assign }) => assign);
      const team = (yield* teams()).find((candidate) => candidate.id === teamId);
      if (team === undefined) return { _tag: "TeamNotFound" } satisfies AssignRunTaskTeamResult;
      yield* runRepository.assignRunTaskTeam({
        runTaskId,
        team: { id: team.id, name: team.name },
      });
      yield* log(
        `Runs.merchantAssignRunTaskTeam: shop=${shop} task=${runTaskId} teamId=${teamId}`,
        {
          task: runTaskId,
          teamId,
        },
      );
      yield* notifyRuns(touchedBy(gate, team.id));
      return { _tag: "Assigned" } satisfies AssignRunTaskTeamResult;
    },
    Effect.catchTags({
      RunNotFoundError: () => Effect.succeed<AssignRunTaskTeamResult>({ _tag: "NotFound" }),
      TaskDoneError: () => Effect.succeed<AssignRunTaskTeamResult>({ _tag: "TaskDone" }),
      RunTerminalError: () => Effect.succeed<AssignRunTaskTeamResult>({ _tag: "RunNotOpen" }),
      RunNotAllowedError: () => Effect.succeed<AssignRunTaskTeamResult>({ _tag: "NotAllowed" }),
    }),
    Effect.orDie,
  );

  /**
   * The workflows list's read, for the loader and the socket alike. No D1 read:
   * `startedByEmail` is a snapshot on the row, so the list reads the same after the member is
   * deleted. Every half of `WorkflowsListData` comes from one call so the loader and the socket
   * paint one snapshot: the strip and the list under it are never two reads that can disagree.
   *
   * The Done or closed count is read on every state (`listRecent` with `limit: 0`
   * counts without reading rows) because the strip shows it whatever is
   * chosen; its rows are read only when `query.state` is "done", or under a
   * search, when both halves come back: the open matches and the Done or
   * closed matches, each cut to `query.limit` (`WorkflowsListData`).
   *
   * `query.team` narrows Done or closed the same way it narrows the other states, and a team
   * the member is not on narrows it to nothing — the same answer
   * `workflowsListFrom` gives for the other states, reached here because `listRecent` takes
   * the team list already narrowed. A search ignores the team, so its rows
   * are read over every team of the member while the count stays narrowed.
   *
   * Both halves are memoized (the rule on {@link makeRuns}), keyed by the team ids sorted, so
   * members on the same teams share one computation: the rows the member's teams own (the run
   * repository's `runListItems`), and the Done or closed half without a search. Each member's
   * grouping (`workflowsListFrom`) runs on every read because it is per member and reads no
   * rows. A search's Done or closed half is read live.
   */
  const listRuns = Effect.fn("Runs.listRuns")(function* ({
    teamIds,
    memberEmail,
    query,
  }: {
    readonly teamIds: ReadonlyArray<TeamId>;
    readonly memberEmail: Email;
    readonly query: RunQuery;
  }) {
    const started = yield* Clock.currentTimeMillis;
    const key = new RunsMemoKey({ teamIds: teamIds.toSorted() });
    const teamRows = yield* Cache.get(runsMemo, key);
    const { counts, items, matches: openMatches } = workflowsListFrom(teamRows, memberEmail, query);
    const recentKey = new RecentMemoKey({
      teamIds: (query.team === null
        ? teamIds
        : teamIds.filter((teamId) => teamId === query.team)
      ).toSorted(),
      limit: query.q === null && workflowsListStateIsDone(query.state) ? query.limit : 0,
    });
    const { recent } = yield* Cache.get(recentMemo, recentKey);
    const memo = memoState(key);
    const recentMemoState = memoState(recentKey);
    yield* Effect.logDebug(
      `Runs.listRuns: shop=${shop} memo=${memo} recent=${recentMemoState}`,
    ).pipe(Effect.annotateLogs({ shop, memo, recent: recentMemoState }));
    const since = started - DONE_WINDOW_MS;
    /**
     * The search's Done or closed half, read over every team with the
     * term: its rows, and its `total` is how many of the window match
     * before the cut, which with the open half's `matches` is
     * `WorkflowsListData.matches`.
     */
    const recentMatches =
      query.q === null
        ? null
        : yield* runRepository.listRecent({ teamIds, since, limit: query.limit, q: query.q });
    const recentItems = recentMatches === null ? recent.items : recentMatches.items;
    const matches =
      openMatches === null || recentMatches === null ? null : openMatches + recentMatches.total;
    return {
      counts: { ...counts, done: recent.total },
      items,
      recent: recentItems,
      matches,
    } satisfies WorkflowsListData;
  }, Effect.orDie);

  /**
   * The member's workflow page's read, for the loader and the socket alike: `null` when the run
   * does not exist or the member's teams hold no task of it (the run repository's
   * `getRunPage`).
   */
  const getRunPage = Effect.fn("Runs.getRunPage")(function* (input: {
    readonly runId: string;
    readonly teamIds: ReadonlyArray<TeamId>;
  }) {
    return Option.getOrNull(yield* runRepository.getRunPage(input));
  }, Effect.orDie);

  const memberStartTask = ({ runTaskId }: StartTaskInput, member: RunMember) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireTaskAction(runTaskId, member, ({ start }) => start);
        yield* runRepository.startTask({ runTaskId, actor: member, teamIds: member.teamIds });
        yield* log(
          `Runs.memberStartTask: shop=${shop} task=${runTaskId} memberId=${member.memberId}`,
          { task: runTaskId, memberId: member.memberId },
        );
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.memberStartTask"));

  const memberMarkTaskDone = ({ runTaskId }: MarkTaskDoneInput, member: RunMember) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireTaskAction(runTaskId, member, ({ done }) => done);
        yield* runRepository.markTaskDone({ runTaskId, actor: member, teamIds: member.teamIds });
        yield* log(
          `Runs.memberMarkTaskDone: shop=${shop} task=${runTaskId} memberId=${member.memberId}`,
          { task: runTaskId, memberId: member.memberId },
        );
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.memberMarkTaskDone"));

  /** Reopen, the member's Undo. Notifies like the others. */
  const memberReopenTask = ({ runTaskId }: ReopenTaskInput, member: RunMember) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireTaskAction(runTaskId, member, ({ reopen }) => reopen);
        yield* runRepository.reopenTask({ runTaskId, actor: member, teamIds: member.teamIds });
        yield* log(
          `Runs.memberReopenTask: shop=${shop} task=${runTaskId} memberId=${member.memberId}`,
          { task: runTaskId, memberId: member.memberId },
        );
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.memberReopenTask"));

  /** Put back; the rule is on the run repository's `putBackTask`. */
  const memberPutBackTask = ({ runTaskId }: PutBackTaskInput, member: RunMember) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireTaskAction(runTaskId, member, ({ putBack }) => putBack);
        yield* runRepository.putBackTask({ runTaskId, actor: member, teamIds: member.teamIds });
        yield* log(
          `Runs.memberPutBackTask: shop=${shop} task=${runTaskId} memberId=${member.memberId}`,
          { task: runTaskId, memberId: member.memberId },
        );
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.memberPutBackTask"));

  /** The note itself never reaches the log line: worker text is unbounded and not ours to index. */
  const memberSetRunNote = ({ runId, note }: SetRunNoteInput, member: RunMember) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireRunAction(runId, member, "note");
        yield* runRepository.setRunNote({ runId, teamIds: member.teamIds, note });
        yield* log(
          `Runs.memberSetRunNote: shop=${shop} runId=${runId} memberId=${member.memberId}`,
          {
            runId,
            memberId: member.memberId,
          },
        );
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.memberSetRunNote"));

  const memberBlockRun = ({ runId, reason }: BlockRunInput, member: RunMember) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireRunAction(runId, member, "block");
        yield* runRepository.blockRun({ runId, actor: member, teamIds: member.teamIds, reason });
        yield* log(`Runs.memberBlockRun: shop=${shop} runId=${runId} memberId=${member.memberId}`, {
          runId,
          memberId: member.memberId,
        });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.memberBlockRun"));

  const memberUnblockRun = ({ runId }: RunIdInput, member: RunMember) =>
    runResult(
      Effect.gen(function* () {
        const gate = yield* requireRunAction(runId, member, "unblock");
        yield* runRepository.unblockRun({ runId, teamIds: member.teamIds });
        yield* notifyRuns(touchedBy(gate));
      }),
    ).pipe(Effect.withSpan("Runs.memberUnblockRun"));

  /**
   * The fixture's work on its runs, after its order upserts: per order, in the
   * fixture's order, reconcile in its own transaction; each item's chosen workflow through
   * `setRun`, the merchant's own Choose; each open run's progress through the run repository's
   * writes, each in its own transaction; then the order's `after` through an upsert whose
   * `afterWrite` is the reconcile, which is how a cancel closes a started run and a quantity
   * change resizes it. Then reconcile all, for the orders the fixture did not write, and one
   * notice.
   *
   * Called after the rows are in and after D1 holds the fixture's teams, outside every
   * transaction: the teams are read here first. A chosen workflow that cannot start its item is
   * a fixture bug and dies, louder than a row that reads as whatever its tags matched.
   *
   * Who a step is recorded as is `by`: one of the fixture's members (`members`, never D1), or,
   * for a Done on a team `by` is not on, that team's first member. With neither `by` nor
   * `byMerchant` a Done, a block and the note are the merchant's; a Start, which only a member
   * makes, is the task's team's first member, or nobody.
   */
  const applyFixture = Effect.fn("Runs.applyFixture")(function* (
    { members: memberRows, work }: Pick<ActorFixtureRows, "members" | "work">,
    caller: string,
  ) {
    const members = yield* decodeFixtureMembers(memberRows);
    const context = yield* eligibleContext();
    const reconcile = yield* reconciler();
    const memberOn = (teamId: TeamId | null) =>
      members.find(({ teamIds }) => teamId !== null && teamIds.includes(teamId));
    const actorOf = (by: string | undefined, doneOnTeam: TeamId | null): RunMember | null => {
      const named = members.find(({ email }) => email === by);
      const picked =
        named !== undefined && (doneOnTeam === null || named.teamIds.includes(doneOnTeam))
          ? named
          : (memberOn(doneOnTeam) ?? named);
      return picked === undefined || by === undefined
        ? null
        : {
            role: "member",
            memberId: picked.memberId,
            email: picked.email,
            teamIds: picked.teamIds,
          };
    };
    const teamsOf = (task: RunTask) => (task.teamId === null ? [] : [task.teamId]);
    /** Reloaded before every phase: each marks tasks done, which changes what the next may touch. */
    const openRun = (runId: string) =>
      runRepository
        .getRun({ runId })
        .pipe(
          Effect.map((found) =>
            Option.isSome(found) && runIsOpen(found.value.run) ? found.value : null,
          ),
        );
    const done = (task: RunTask, progress: FixtureProgress) => {
      const member = progress.byMerchant === true ? null : actorOf(progress.by, task.teamId);
      return runRepository.markTaskDone(
        member === null
          ? { runTaskId: task.id, actor: MERCHANT }
          : { runTaskId: task.id, actor: member, teamIds: teamsOf(task) },
      );
    };
    const applyProgress = (runId: string, progress: FixtureProgress) =>
      Effect.gen(function* () {
        if (progress.done === true) {
          const detail = yield* openRun(runId);
          if (detail !== null)
            yield* Effect.forEach(detail.tasks, (task) => done(task, progress), {
              discard: true,
            });
        }
        // One round: every task current at the start of the round is done; what that makes
        // current waits for the next round.
        for (let round = 0; round < (progress.advance ?? 0); round += 1) {
          const detail = yield* openRun(runId);
          if (detail !== null)
            yield* Effect.forEach(
              currentTasks(detail.run, detail.tasks),
              (task) => done(task, progress),
              { discard: true },
            );
        }
        if (progress.started === true) {
          const detail = yield* openRun(runId);
          if (detail !== null)
            yield* Effect.forEach(
              detail.tasks.filter((task) => task.doneAt === null),
              (task) => {
                const member =
                  progress.by === undefined
                    ? Option.match(Option.fromUndefinedOr(memberOn(task.teamId)), {
                        onNone: () => null,
                        onSome: (row): RunMember => ({ role: "member", ...row }),
                      })
                    : actorOf(progress.by, null);
                return member === null
                  ? Effect.void
                  : runRepository
                      .startTask({ runTaskId: task.id, actor: member, teamIds: teamsOf(task) })
                      .pipe(Effect.catchTag("TaskNotReadyError", () => Effect.void));
              },
              { discard: true },
            );
        }
        if (progress.blocked !== undefined) {
          const detail = yield* openRun(runId);
          const member = progress.byMerchant === true ? null : actorOf(progress.by, null);
          const reason = yield* decodeBlockReason(progress.blocked);
          if (detail !== null)
            yield* runRepository
              .blockRun(
                member === null
                  ? { runId, actor: MERCHANT, reason }
                  : {
                      runId,
                      actor: member,
                      teamIds: detail.tasks.flatMap(teamsOf),
                      reason,
                    },
              )
              .pipe(Effect.catchTag("RunNotAllowedError", () => Effect.void));
        }
        if (progress.note !== undefined)
          yield* runRepository.setRunNote({ runId, note: yield* decodeRunNote(progress.note) });
        if (progress.cancelled === true)
          yield* runRepository.cancelRun({ runId }).pipe(
            Effect.catchTags({
              RunNotFoundError: () => Effect.void,
              RunTerminalError: () => Effect.void,
              RunOrderClosedError: () => Effect.void,
            }),
          );
      });
    let runCount = 0;
    for (const order of work) {
      yield* transaction(runRepository.reconcileOrder({ ...context, orderId: order.orderId }));
      for (const item of order.items) {
        if (item.workflowId === null) continue;
        const target = yield* orderRepository.getLineItem(item.lineItemId);
        const found = yield* workflowRepository.getWorkflow({ workflowId: item.workflowId });
        const detail: WorkflowDetail | null = Option.isSome(found)
          ? { workflow: found.value.workflow, tasks: found.value.tasks }
          : null;
        if (Option.isNone(target) || detail === null || !workflowIsEligible(detail, context.teams))
          return yield* Effect.die(
            new Error(
              `Runs.applyFixture: lineItemId=${item.lineItemId} workflowId=${item.workflowId}: no such line item, or a workflow that cannot start`,
            ),
          );
        yield* runRepository.setRun({
          workflow: detail,
          teams: context.teams,
          order: target.value.order,
          lineItem: target.value.lineItem,
        });
      }
      const open = (yield* runRepository.listRunsForOrder({ orderId: order.orderId })).filter(
        ({ run }) => runIsOpen(run),
      );
      runCount += open.length;
      for (const { run } of open) {
        const item = order.items.find(({ lineItemId }) => lineItemId === run.lineItemId);
        if (item !== undefined) yield* applyProgress(run.id, item.progress);
      }
      if (order.after !== null) {
        const stored = yield* orderRepository.getOrder(order.orderId);
        if (Option.isNone(stored)) continue;
        const { order: placed, lineItems } = stored.value;
        const after = order.after;
        const now = yield* Clock.currentTimeMillis;
        const changed: ShopOrder = {
          ...placed,
          cancelledAt: after.cancelled === true ? now : placed.cancelledAt,
          fulfillmentStatus: after.fulfillmentStatus ?? placed.fulfillmentStatus,
        };
        yield* orderRepository.upsertOrder({
          order: changed,
          lineItems: lineItems.map((lineItem, index) => {
            const override = after.lineItems?.find(({ position }) => position === index + 1);
            return override?.currentQuantity === undefined
              ? lineItem
              : { ...lineItem, currentQuantity: override.currentQuantity };
          }),
          afterWrite: reconcile(changed),
        });
      }
    }
    yield* reconcileAll(caller, shop);
    yield* log(
      `Runs.applyFixture: shop=${shop} orders=${String(work.length)} runs=${String(runCount)}`,
      {
        orders: work.length,
        runs: runCount,
      },
    );
    yield* notify([ORDERS_KEY]);
  }, Effect.orDie);

  return {
    notify,
    notifyRuns,
    applyFixture,
    eligibleContext,
    reconciler,
    reconcileAll,
    listOrders,
    getOrderDetail,
    listRuns,
    getRunPage,
    merchantAttachWorkflow,
    merchantCancelRun,
    merchantMarkTaskDone,
    merchantReopenTask,
    merchantPutBackTask,
    merchantSetRunNote,
    merchantBlockRun,
    merchantUnblockRun,
    merchantAssignRunTaskTeam,
    memberStartTask,
    memberMarkTaskDone,
    memberReopenTask,
    memberPutBackTask,
    memberSetRunNote,
    memberBlockRun,
    memberUnblockRun,
  };
});

/** The actor's runs application service; see {@link makeRuns}. */
export type Runs = Effect.Success<ReturnType<typeof makeRuns<never>>>;

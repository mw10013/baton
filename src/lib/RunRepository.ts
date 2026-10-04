import type { SqlError } from "effect/unstable/sql";

import {
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  Struct,
} from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";

import * as CurrentWhere from "@/lib/currentWhere";
import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
export class RunRepositoryError extends Schema.TaggedError<RunRepositoryError>()(
  "RunRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()(
  "RunNotFoundError",
  { id: Schema.String },
) {}

/**
 * The run's state refuses the write. Start, Done, Put back, Block, Unblock,
 * Cancel and team assignment need `Domain.runIsOpen`; Reopen refuses a
 * closed run. The table on {@link Domain.RunState} is the rule.
 */
export class RunTerminalError extends Schema.TaggedError<RunTerminalError>()(
  "RunTerminalError",
  { runId: Schema.String, state: Domain.RunState },
) {}

/**
 * Start, Done or Put back refused because the run is blocked: a block means
 * stop until a person unblocks it. Gate: {@link Domain.runIsBlocked}, which
 * states the rule. Reopen and the run note are not gated by it.
 */
export class RunBlockedError extends Schema.TaggedError<RunBlockedError>()(
  "RunBlockedError",
  { runId: Schema.String },
) {}

/**
 * Cancel workflow refused because Shopify has closed the order
 * ({@link Domain.orderIsOpen}). Reconcile closes every open run on a closed
 * order in the same transaction as the order write, so this is a race with
 * that write, not a state a page should offer.
 */
export class RunOrderClosedError extends Schema.TaggedError<RunOrderClosedError>()(
  "RunOrderClosedError",
  { runId: Schema.String },
) {}

/**
 * The task's team is not among the caller's teams, or a reopen when a task
 * in a later step has started (`teamId` is then the task's own team, or empty
 * when unassigned). Both are `NotAllowed` on `Domain.RunResult`.
 */
export class RunNotAllowedError extends Schema.TaggedError<RunNotAllowedError>()(
  "RunNotAllowedError",
  { runId: Schema.String, teamId: Schema.String },
) {}

/** Unblock found no block: a second Unblock racing the first. */
export class RunNotBlockedError extends Schema.TaggedError<RunNotBlockedError>()(
  "RunNotBlockedError",
  { runId: Schema.String },
) {}

/** The task is not current ({@link Domain.currentTasks}) or is already done — or, for reopen, not yet done; for put back, not yet started or already done. */
export class TaskNotReadyError extends Schema.TaggedError<TaskNotReadyError>()(
  "TaskNotReadyError",
  { runTaskId: Schema.String },
) {}

/**
 * `assignRunTaskTeam` on a done task. Any *open* task can be assigned,
 * started or not; a done task is refused because the write would overwrite
 * `teamName`, the record of which team did it.
 */
export class TaskDoneError extends Schema.TaggedError<TaskDoneError>()(
  "TaskDoneError",
  { runTaskId: Schema.String },
) {}

/** What one pass over one order did, for the caller's log line. No count reaches a screen: pass rule 6 on {@link Domain.reconcileItem}. */
export interface ReconcileCounts {
  /** Runs created by this pass. */
  readonly created: number;
  /** Open runs whose quantity this pass rewrote to the line's units. */
  readonly resized: number;
  /** Open runs this pass closed: the order cancelled or fulfilled, or the line at zero units ({@link Domain.ClosedReason}). */
  readonly closed: number;
  /**
   * Items this pass left **multi-match**: two or more eligible workflows
   * matched and no run exists, so nothing was started and the merchant
   * has to choose. Not a fault — a count worth logging, and the number the
   * orders index turns into a step.
   */
  readonly multiMatch: number;
}

/**
 * Whether the pass wrote a run: created, resized or closed one. `multiMatch`
 * is a state the pass left, not a write, and is left out. The run half of the
 * signal `ShopAgent`'s `publish` gates on.
 */
export const reconcileCountsChanged = ({
  created,
  resized,
  closed,
}: ReconcileCounts) => created > 0 || resized > 0 || closed > 0;

/** What `reconcileAll` hands back: the pass's counts, added over its orders, for the caller's one log line. No count reaches a screen: pass rule 6 on {@link Domain.reconcileItem}. */
export interface ReconcileAllCounts {
  readonly orders: number;
  readonly created: number;
  readonly multiMatch: number;
}

/**
 * The on workflows whose tag is one of `tags`, with their tasks: how a pass
 * finds the workflows that can match an order, from the order's own tags
 * (the rule on {@link Domain.itemMatches}). Passed in rather than read here
 * so the two repositories stay independent: the agent hands over
 * `WorkflowRepository.listOnWorkflowsByTags`. It runs inside the order's
 * transaction, so it must be plain statements.
 */
export type WorkflowsByTags = (
  tags: readonly string[],
) => Effect.Effect<
  readonly Domain.WorkflowDetail[],
  SqlError.SqlError | RunRepositoryError
>;

/** What a pass reads besides the stored order: the pass's teams ({@link Domain.EligibleContext}) and how to find workflows by tag. */
export interface ReconcileContext extends Domain.EligibleContext {
  readonly workflowsByTags: WorkflowsByTags;
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * An {@link Domain.Actor} flattened into the two columns a task's recorded actor
 * holds. The merchant has no `Member` row, so the email is null beside a
 * `'merchant'` role — the role column is what readers discriminate on.
 */
const actorColumns = (actor: Domain.Actor) =>
  actor.role === "merchant"
    ? { role: "merchant" as const, email: null }
    : { role: "member" as const, email: actor.email };

/** The {@link Domain.ActorDisplay} a row stores for an {@link Domain.Actor}: role and email, never the gate's id or teams. */
const actorDisplay = (actor: Domain.Actor): Domain.ActorDisplay =>
  actor.role === "merchant" ? actor : { role: "member", email: actor.email };

const NO_COUNTS: ReconcileCounts = {
  created: 0,
  resized: 0,
  closed: 0,
  multiMatch: 0,
};

export class RunRepository extends Context.Service<
  RunRepository,
  {
    /**
     * Plain statements, no transaction of its own: called from inside
     * `OrderRepository.upsertOrder`'s transaction via `afterWrite`, and Durable
     * Object SQLite refuses to nest. Reads the order and its stored items
     * back rather than trusting the caller's copy, so a reconcile is against
     * what is actually stored.
     */
    readonly reconcileOrder: (
      input: ReconcileContext & { readonly orderId: string },
    ) => Effect.Effect<ReconcileCounts, SqlError.SqlError | RunRepositoryError>;
    /**
     * `reconcileOrder` over every open, paid order, one transaction each
     * (pass rule 2 on {@link Domain.reconcileItem}): what runs after a
     * definition changes on an on workflow (Turn on, Apply). Returns its
     * counts ({@link ReconcileAllCounts}). Fulfilled orders are excluded on purpose —
     * reconcile treats fulfilled as terminal and there is nothing left to
     * make or pack — and unpaid ones because they reconcile when they pay.
     *
     * **Unbounded**: every open paid order the object holds, with no limit
     * and no batching, one transaction each. What bounds it in practice is
     * the shop's open working set and retention
     * ({@link Domain.ShopLimits.orderRetentionDays}), not this code — a shop
     * with an unusual number of open orders pays for all of them on the
     * request that changed the definition.
     */
    readonly reconcileAll: (
      input: ReconcileContext,
    ) => Effect.Effect<
      ReconcileAllCounts,
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * Manual attach, read as **set this item's workflow**. An item holds at
     * most one run (the data model on `initializeSchema`,
     * `ShopAgentSchema.ts`), so this is a replace, done in one transaction:
     *
     * - an open run for *this* workflow is `None` — nothing to do, and the
     *   caller reads it as "already there";
     * - an open run for a different workflow is deleted first, tasks and
     *   all, and comes back as `replaced`;
     * - a `done` run is deleted the same way, whatever its workflow, and
     *   comes back as `replaced`;
     * - a `closed` run is deleted the same way, tasks and all, whatever its
     *   workflow, and `replaced` is null: nothing was open.
     *
     * A workflow the item ran before, the done or closed one included,
     * starts fresh from its definition. Nothing of the earlier run is
     * resumed: closed is final ({@link Domain.RunState}). The merchant
     * confirmed the loss in the Change workflow modal, or chose a new
     * workflow for an item whose run had already ended.
     */
    readonly setRun: (input: {
      readonly workflow: Domain.WorkflowDetail;
      readonly teams: Domain.EligibleContext["teams"];
      readonly order: Domain.ShopOrder;
      readonly lineItem: Domain.OrderLineItem;
    }) => Effect.Effect<
      Option.Option<{
        readonly run: Domain.Run;
        /** The open or done run deleted to make room, or null when the item was free or its run was closed. */
        readonly replaced: Domain.Run | null;
      }>,
      SqlError.SqlError | RunRepositoryError
    >;
    readonly listRunsForOrder: (input: {
      readonly orderId: string;
    }) => Effect.Effect<
      readonly Domain.RunDetail[],
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * What an action set reads ({@link Domain.runActions},
     * {@link Domain.taskActions}): the run, its tasks decorated as
     * {@link Domain.RunTaskRow}s, and its order's open or closed state.
     * `None` when the run, or its order, is gone. A closed run is returned:
     * its note is still writable, and the action sets refuse everything else
     * on it.
     */
    readonly getRunGate: (
      input: { readonly runId: string } | { readonly runTaskId: string },
    ) => Effect.Effect<
      Option.Option<{
        readonly run: Domain.Run;
        readonly tasks: readonly Domain.RunTaskRow[];
        readonly order: Domain.OrderState;
      }>,
      SqlError.SqlError | RunRepositoryError
    >;
    /** The run with its tasks, by its own id or by one of its tasks' ids. */
    readonly getRun: (
      input: { readonly runId: string } | { readonly runTaskId: string },
    ) => Effect.Effect<
      Option.Option<Domain.RunDetail>,
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * The merchant's Cancel workflow: closes the run, reason `merchant_cancelled`
     * ({@link Domain.ClosedReason}), in one transaction. The tasks stay as the
     * record of who did what, the note stays, and the block is cleared
     * with the rest of the run's open state. The row keeps
     * its item, one run per item, so reconcile creates nothing on it ({@link Domain.RunState}).
     * Gate: {@link Domain.runIsOpen} and the order open
     * ({@link Domain.orderIsOpen}); a `done` run is not cancelled, it is
     * reopened.
     *
     * There is no way back, so the merchant confirms in a modal; the
     * confirmation is the guard for a mistaken cancel, and this write needs
     * no second one. A new workflow on the item afterwards starts fresh.
     */
    readonly cancelRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunTerminalError
      | RunOrderClosedError
    >;
    /**
     * The member's workflows list, sorted by state and cut here rather than on the page: every run
     * with at least one current task owned by `teamIds`, grouped by
     * {@link Domain.listStateOf} against `memberEmail`. **Every** state is counted;
     * **one** is returned — the one `query.state` names — sorted oldest first
     * and cut to `query.limit`. `state: "done"` returns no items at all and the
     * caller reads `listRecent` for that state's rows. Under a search
     * (`query.q`) the items are every open match on `teamIds` whatever its
     * state or team ({@link Domain.RunQuery}), `matches` is how many there
     * were before the cut (`null` without a search), and the counts ignore it. Only open runs have
     * current tasks, so a closed or done run is never listed
     * ({@link Domain.RunState}).
     *
     * The four state counts are after `query.team` narrows, because they
     * describe the lists the member can switch to.
     *
     * Both statements still read every row of `teamIds`: the rows are not the
     * cost, the bytes leaving the Durable Object are, so the bound is on what
     * is returned rather than on what is read.
     */
    readonly listRuns: (input: {
      readonly teamIds: readonly Domain.TeamId[];
      readonly memberEmail: Domain.Email;
      readonly query: Domain.RunQuery;
    }) => Effect.Effect<
      {
        readonly counts: Omit<Domain.RunListCounts, "done">;
        readonly items: readonly Domain.RunListItem[];
        readonly matches: number | null;
      },
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * The Done or closed state ({@link Domain.RecentItem}): tasks owned by `teamIds`
     * done at or after `since`, each with its run and
     * {@link Domain.laterStepStarted}, and runs with a task on `teamIds` that
     * closed at or after `since`, newest first by `doneAt` or
     * `closedAt`. The team's, not the caller's: a colleague notices a mistake
     * as readily as its author, and a closed run is news to everyone who
     * could see it.
     *
     * `total` is the count inside the window, because the strip says it
     * even while another state is showing; `limit: 0` returns the count alone,
     * reading no rows. `q` narrows the rows and `total` alike, so under a
     * search `total` is how many of the window match before the cut
     * ({@link Domain.WorkflowsListData} `matches`); the Done or closed count
     * the strip shows ({@link Domain.RunListCounts}) is read with `q: null`.
     */
    readonly listRecent: (input: {
      readonly teamIds: readonly string[];
      readonly since: number;
      readonly limit: number;
      readonly q: Domain.ListSearch | null;
    }) => Effect.Effect<
      { readonly items: readonly Domain.RecentItem[]; readonly total: number },
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * Reopen returns a task to Ready: it clears the Done columns (`doneAt`,
     * `doneBy*`) and every Start column, member or merchant, records
     * nothing, and recomputes the run's state. The task is Ready for a
     * worker to Start. Keeping a member's Start would leave the task
     * "Started · A · since <original time>": a claim A no longer makes and a
     * time that is no longer true, and it would take Undo then Put back to
     * reach Ready from a single Done. Allowed for the task's team while no
     * later step has a task started or done ({@link Domain.laterStepStarted};
     * `RunNotAllowedError` otherwise). Gate: not
     * {@link Domain.runIsClosed}, rather than `runIsOpen` — reopening a `done`
     * run's last task is the point, while a closed run is final; see
     * {@link Domain.RunState}.
     */
    readonly reopenTask: (
      input: Domain.ReopenTaskCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
      | TaskNotReadyError
    >;
    /**
     * Put back clears the Start record of a started task, and the run's
     * state is recomputed (a run whose only started task is put back is
     * {@link Domain.runIsUnstarted} again). Refused on a done task or an
     * unstarted task
     * (`TaskNotReadyError`), a run that is not {@link Domain.runIsOpen}
     * (`RunTerminalError`), a blocked run (`RunBlockedError`), or, for a
     * member, a task not on one of their teams (`RunNotAllowedError`).
     *
     * Offered to the whole team, not only the starter, and refused under a
     * block; why is the `putBack` bullet on {@link Domain.taskActions}. No
     * column records who put it back; the task is plain Ready and the next
     * Start writes a fresh record.
     */
    readonly putBackTask: (
      input: Domain.PutBackTaskCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | TaskNotReadyError
      | RunTerminalError
      | RunBlockedError
    >;
    /**
     * The workflow page's read: the run with every task decorated with whether it is current
     * and {@link Domain.laterStepStarted}, the order's live note and items. `None`
     * when the run does not exist or the caller cannot see it
     * ({@link Domain.runIsVisibleTo}) — one answer for both, so a member
     * cannot probe run ids. A closed run is returned: a link to it lands on
     * its reason rather than on a not-found.
     */
    readonly getRunPage: (input: {
      readonly runId: string;
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      Option.Option<Domain.RunPageData>,
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * Marks a ready task started. Idempotent: a second Start leaves the
     * original `startedAt` / `startedByEmail` / `startedByRole` — no takeover, no
     * error — so two people pressing it does not rewrite who began. The
     * email is snapshotted so history reads after the member is deleted.
     * Gates: {@link Domain.runIsOpen}, and not {@link Domain.runIsBlocked}.
     */
    readonly startTask: (
      input: Domain.StartTaskCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | TaskNotReadyError
      | RunTerminalError
      | RunBlockedError
    >;
    /**
     * Sets the Done columns (`doneAt`, `doneBy*`). Also backfills the started
     * columns with the same actor when Done arrives without a Start, so every
     * done task records who. Nothing is created here. Gates:
     * {@link Domain.runIsOpen}, and not {@link Domain.runIsBlocked}.
     */
    readonly markTaskDone: (
      input: Domain.MarkTaskDoneCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | TaskNotReadyError
      | RunTerminalError
      | RunBlockedError
    >;
    /**
     * Writes the run's note; `null` clears it. No requirement that the run have a current task — a
     * note on a done run is allowed: a note is a record, not work, and the
     * thing noticed after the last Done is exactly what wants writing down,
     * and a closed run keeps its record too; see {@link Domain.RunState}. A member
     * needs to see the run ({@link Domain.runIsVisibleTo}), not to hold a
     * current task as Block does: a done run has none and would
     * refuse every member. Last write wins; see
     * {@link Domain.SetRunNoteCommand}.
     */
    readonly setRunNote: (
      input: Domain.SetRunNoteCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
    >;
    /**
     * Blocks the run ({@link Domain.runIsBlocked}): `blockedAt`, the optional
     * reason, and the actor as `blockedBy`. Allowed when a current
     * task belongs to `teamIds`. Gate: {@link Domain.runIsOpen}; see {@link Domain.RunState}.
     */
    readonly blockRun: (
      input: Domain.BlockRunCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
    >;
    /**
     * Every team that owns a task on any run of the order a given run (or run
     * task) belongs to.
     *
     * The scope is the *order*, not the run, because the merchant's order
     * page shows every run of the order: an action on one run restates the
     * page for every team working that order. A per-run answer would leave
     * those lists stale until they reloaded. `null` team ids are excluded —
     * an unassigned task is on nobody's list.
     *
     * Used only to scope a `ShopAgent.publish` fan-out, so an over-broad
     * answer costs a redundant refetch and an under-broad one costs a stale
     * list; the order boundary is the smallest scope where neither happens.
     *
     * Answers the order with its teams, so the publish can name the order as
     * `touched` from the same read. `orderId` is `null` when a run-shaped
     * target resolves to no order: the run is gone.
     */
    readonly listOrderTeamIds: (
      input:
        | { readonly runTaskId: string }
        | { readonly runId: string }
        | { readonly orderId: string },
    ) => Effect.Effect<
      { readonly orderId: string | null; readonly teamIds: readonly string[] },
      SqlError.SqlError
    >;
    /**
     * Lifts the block: nulls `blockedAt`, `blockReason` and `blockedBy`.
     * Allowed when any current task of the run belongs to one of
     * `teamIds`, or unconditionally for the merchant (`teamIds` undefined). Fails
     * `RunNotBlockedError` when there is no block to lift (a second Unblock
     * racing the first), and `RunTerminalError` unless {@link Domain.runIsOpen}.
     */
    readonly unblockRun: (
      input: Domain.UnblockRunCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunNotBlockedError
      | RunTerminalError
    >;
    /**
     * Points any *open* run task at `team`, snapshotting the name from the
     * live teams the caller resolved ({@link Domain.RunTask}'s team is both a
     * pointer and a snapshot: the data model on `initializeSchema`,
     * `ShopAgentSchema.ts`), and puts the task on that team's list. The
     * team's existence is the caller's check (`Team` is a D1 row
     * this store cannot see). Allowed on any open task, assigned or not and
     * started or not — it is both the remedy that makes a team delete safe
     * and the merchant's way to move work between teams. Only `teamId` /
     * `teamName` are written, so a started task keeps `startedByRole` /
     * `startedByEmail` and history still names whoever began it. A done
     * task is refused (`TaskDoneError`), and so is a task of a run that
     * is not {@link Domain.runIsOpen} (`RunTerminalError`): a `done` run's
     * tasks are all done, so this is the same refusal reached another way.
     */
    readonly assignRunTaskTeam: (input: {
      readonly runTaskId: string;
      readonly team: {
        readonly id: Domain.TeamId;
        readonly name: Domain.TeamName;
      };
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunTerminalError
      | TaskDoneError
    >;
  }
>()("RunRepository") {
  /**
   * Depends on {@link OrderRepository} because {@link insertRun} is where the
   * billing meter fires (`OrderRepository.countOrder`). The direction is one
   * way on purpose: `OrderRepository` knows nothing about runs — it takes
   * `afterWrite` as a parameter rather than calling reconcile itself — so
   * nothing here closes a cycle.
   */
  static readonly layer: Layer.Layer<
    RunRepository,
    never,
    SqlClient.SqlClient | OrderRepository
  > = Layer.effect(
    RunRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orderRepository = yield* OrderRepository;

      const decode =
        <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
        (rows: unknown) =>
          Schema.decodeUnknownEffect(schema)(rows).pipe(
            Effect.mapError(
              (cause) => new RunRepositoryError({ message, cause }),
            ),
          );

      const decodeRuns = decode(Schema.Array(Domain.Run), "Invalid Run row");
      const decodeTasks = decode(
        Schema.Array(Domain.RunTask),
        "Invalid RunTask row",
      );
      const decodeOrders = decode(
        Schema.Array(Domain.ShopOrder),
        "Invalid ShopOrder row",
      );
      const decodeLineItems = decode(
        Schema.Array(Domain.OrderLineItem),
        "Invalid OrderLineItem row",
      );
      const decodeRunListRuns = decode(
        Schema.Array(
          Schema.Struct({
            ...Domain.RunListRun.fields,
            stepCount: Schema.Number,
            orderCancelledAt: Schema.NullOr(Schema.Number),
            orderFulfillmentStatus: Schema.String,
          }),
        ),
        "Invalid RunListRun row",
      );

      const orderColumns = sql.literal(
        `id, legacyId, name, processedAt, updatedAt, cancelledAt,
         fulfillmentStatus, fullyPaid, note, syncedAt`,
      );

      const findRun = (runId: string) =>
        sql`select * from Run where id = ${runId}`.pipe(
          Effect.flatMap(decodeRuns),
          Effect.map(([run]) => Option.fromUndefinedOr(run)),
        );

      const requireRun = (runId: string) =>
        findRun(runId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new RunNotFoundError({ id: runId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const requireTask = (runTaskId: string) =>
        sql`select * from RunTask where id = ${runTaskId}`.pipe(
          Effect.flatMap(decodeTasks),
          Effect.flatMap(([task]) =>
            task === undefined
              ? Effect.fail(new RunNotFoundError({ id: runTaskId }))
              : Effect.succeed(task),
          ),
        );

      /** The predicate itself is in `currentWhere.ts`; the JSDoc there says why it does not live in this layer. */
      const currentWhere = (alias: string) =>
        sql.literal(CurrentWhere.currentWhere(alias));

      const currentTasks = (runId: string) =>
        sql`
          select s.* from RunTask s
          where s.runId = ${runId} and ${currentWhere("s")}
          order by s.position
        `.pipe(Effect.flatMap(decodeTasks));

      const isCurrent = (runTaskId: string) =>
        sql`
          select 1 from RunTask s
          where s.id = ${runTaskId} and ${currentWhere("s")}
        `.pipe(Effect.map((rows) => rows.length > 0));

      /**
       * The guard every task action shares: task exists, the run passes
       * `gate` ({@link Domain.runIsOpen} for Start and Done; any state for
       * reopen), task's team among the caller's.
       *
       * `teamIds` undefined means the merchant, and then the team clause is
       * skipped whole — including the refusal for an unassigned task
       * (`teamId` null). That task is on nobody's list and no worker can
       * reach it, which is exactly the situation the merchant is there to
       * fix; refusing them too would leave the run stuck with no way out.
       */
      const requireActionable = ({
        runTaskId,
        teamIds,
        gate = Domain.runIsOpen,
      }: {
        readonly runTaskId: string;
        readonly teamIds: readonly string[] | undefined;
        readonly gate?: (run: Domain.Run) => boolean;
      }) =>
        Effect.gen(function* () {
          const task = yield* requireTask(runTaskId);
          const run = yield* requireRun(task.runId);
          if (!gate(run))
            yield* new RunTerminalError({ runId: run.id, state: run.state });
          if (teamIds !== undefined && !Domain.taskIsOnTeams(task, teamIds))
            yield* new RunNotAllowedError({
              runId: run.id,
              teamId: task.teamId ?? "",
            });
          return { task, run };
        });

      /**
       * `RunNotAllowedError` unless some current task of the run
       * belongs to `teamIds`. Undefined `teamIds` is the merchant and always passes, for
       * the reason on {@link requireActionable}.
       */
      const requireCurrentTeam = (
        runId: string,
        teamIds: readonly string[] | undefined,
      ) =>
        teamIds === undefined
          ? Effect.void
          : currentTasks(runId).pipe(
              Effect.flatMap((current) =>
                Domain.runIsVisibleTo(current, teamIds)
                  ? Effect.void
                  : Effect.fail(
                      new RunNotAllowedError({
                        runId,
                        teamId: current[0]?.teamId ?? "",
                      }),
                    ),
              ),
            );

      const tasksForRuns = (runIds: readonly string[]) =>
        runIds.length === 0
          ? Effect.succeed([])
          : sql`
              select * from RunTask
              where runId in (select value from json_each(${json(runIds)}))
              order by runId, position
            `.pipe(Effect.flatMap(decodeTasks));

      /**
       * The open-or-closed state of each order, by id. A run is deleted with
       * its order (`OrderRepository` retention), so a run whose order is
       * missing here is not one a reader is offered: the callers drop it.
       */
      const orderStates = Effect.fn("RunRepository.orderStates")(function* (
        orderIds: readonly string[],
      ) {
        if (orderIds.length === 0) return new Map<string, Domain.OrderState>();
        const rows = yield* decode(
          Schema.Array(
            Schema.Struct({ id: Schema.String, ...Domain.OrderState.fields }),
          ),
          "Invalid order state row",
        )(
          yield* sql`
              select id, cancelledAt, fulfillmentStatus from ShopOrder
              where id in (select value from json_each(${json([...new Set(orderIds)])}))
            `,
        );
        return new Map(
          rows.map(({ id, ...state }): [string, Domain.OrderState] => [
            id,
            state,
          ]),
        );
      });

      /**
       * `RunNotAllowedError` unless the caller can see the run
       * ({@link Domain.runIsVisibleTo}). Undefined `teamIds` is the merchant
       * and always passes.
       */
      const requireRunTeam = (
        runId: string,
        teamIds: readonly string[] | undefined,
      ) =>
        teamIds === undefined
          ? Effect.void
          : tasksForRuns([runId]).pipe(
              Effect.flatMap((tasks) =>
                Domain.runIsVisibleTo(tasks, teamIds)
                  ? Effect.void
                  : Effect.fail(
                      new RunNotAllowedError({
                        runId,
                        teamId: tasks[0]?.teamId ?? "",
                      }),
                    ),
              ),
            );

      /**
       * Every workflows list row the teams own, unsorted and uncapped: one
       * {@link Domain.RunListItem} per run with at least one current task of
       * `teamIds`, carrying that run's last step. Actor emails are on the row
       * already, so no team join and no D1 read.
       *
       * The first statement still reads *every* current task of a qualifying
       * run, including tasks owned by other teams: that is how it decides the
       * run qualifies at all, and it is why the row's own tasks are filtered
       * in TypeScript below rather than in SQL. Nothing about the other
       * teams' tasks is shipped.
       *
       * Separate from `listRuns` because sorting by state, narrowing, and capping are
       * decisions about the rows rather than about the query: keeping them
       * apart means the two statements below are read once, in one place.
       */
      const runListItems = Effect.fn("RunRepository.runListItems")(function* (
        teamIds: readonly Domain.TeamId[],
      ) {
        if (teamIds.length === 0) return [];
        const current = yield* decodeTasks(
          yield* sql`
              select s.* from RunTask s
              join Run r on r.id = s.runId
              where r.state = 'open'
                and ${currentWhere("s")}
                and exists (
                  select 1 from RunTask m
                  where m.runId = s.runId
                    and m.teamId in (select value from json_each(${json(teamIds)}))
                    and ${currentWhere("m")}
                )
              order by s.runId, s.position
            `,
        );
        if (current.length === 0) return [];
        const runIds = [...new Set(current.map((task) => task.runId))];
        const runs = yield* decodeRunListRuns(
          yield* sql`
              select r.*,
                (select max(step) from RunTask c where c.runId = r.id) as stepCount,
                o.cancelledAt as orderCancelledAt,
                o.fulfillmentStatus as orderFulfillmentStatus
              from Run r
              join ShopOrder o on o.id = r.orderId
              where r.id in (select value from json_each(${json(runIds)}))
              order by r.orderProcessedAt, r.lineItemId, r.id
            `,
        );
        return runs.flatMap(
          ({
            stepCount,
            orderCancelledAt,
            orderFulfillmentStatus,
            ...run
          }): Domain.RunListItem[] => {
            const [first, ...rest] = current
              .filter(
                (task) =>
                  task.runId === run.id && Domain.taskIsOnTeams(task, teamIds),
              )
              // Whatever the row does not render is dropped rather than
              // nulled or carried: the shape is {@link Domain.RunListTask} and
              // its JSDoc is why.
              .map((task) =>
                Struct.omit(task, [
                  "doneAt",
                  "doneByEmail",
                  "doneByRole",
                  "instructions",
                ]),
              );
            return first === undefined
              ? []
              : [
                  {
                    run,
                    tasks: [first, ...rest],
                    stepCount,
                    order: {
                      cancelledAt: orderCancelledAt,
                      fulfillmentStatus: orderFulfillmentStatus,
                    },
                  },
                ];
          },
        );
      });

      const withTasks = (runs: readonly Domain.Run[]) =>
        Effect.gen(function* () {
          const tasks = yield* tasksForRuns(runs.map((run) => run.id));
          return runs.map((run): Domain.RunDetail => ({
            run,
            tasks: tasks.filter((task) => task.runId === run.id),
          }));
        });

      /**
       * `state` is a function of the tasks; recomputing it in SQL from the
       * same rows the task write just touched is what keeps the two in one
       * transaction with nothing to drift. Two states are derived: `done`
       * when every task is done, `open` otherwise.
       *
       * Only ever called on an open run: every caller gates on
       * {@link Domain.runIsOpen}, or on not {@link Domain.runIsClosed} for
       * reopen, so a closed run's state, which is written rather than derived,
       * is never recomputed away.
       */
      const recomputeState = (runId: string, now: number) =>
        sql`
          update Run set
            state = (
              select case
                when count(*) = sum(doneAt is not null) then 'done'
                else 'open'
              end
              from RunTask s where s.runId = Run.id
            ),
            updatedAt = ${now}
          where id = ${runId}
        `.pipe(Effect.asVoid);

      /**
       * Closes every open run the fragment selects, with `reason`
       * ({@link Domain.ClosedReason}), and returns how many. The one close
       * write, for reconcile and Cancel workflow alike. The tasks and the note
       * stay as the record; the block goes, because it is about work that
       * has stopped ({@link Domain.RunState}).
       */
      const closeOpenRuns = (
        where: Statement.Fragment,
        reason: Domain.ClosedReason,
        now: number,
      ) =>
        sql`
          update Run
          set state = 'closed', closedAt = ${now}, closedReason = ${reason},
              blockedAt = null, blockReason = null, blockedBy = null,
              updatedAt = ${now}
          where ${where} and state = 'open'
          returning id
        `.pipe(Effect.map((rows) => rows.length));

      /**
       * `workflowIsEligible` has already required every task's team to be in `teams`,
       * so the `teamName` lookup cannot miss.
       *
       * `on conflict do nothing` on the unique `lineItemId`: the item already
       * has a run, which means "do not insert", and a thrown `SqlError` in
       * the middle of a reconcile pass would fail the whole order. No row
       * returned is `Option.none()`, which every caller already reads as
       * "nothing created".
       */
      const insertRun = Effect.fn("RunRepository.insertRun")(function* ({
        workflow: { workflow, tasks },
        teams,
        order,
        lineItem,
      }: {
        readonly workflow: Domain.WorkflowDetail;
        readonly teams: Domain.EligibleContext["teams"];
        readonly order: Domain.ShopOrder;
        readonly lineItem: Domain.OrderLineItem;
      }) {
        const now = yield* Clock.currentTimeMillis;
        const runId = crypto.randomUUID();
        const [run] = yield* decodeRuns(
          yield* sql`
              insert into Run (
                id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
                lineItemId, lineItemTitle, variantTitle, sku, quantity, lineItemProperties,
                state, createdAt, updatedAt
              ) values (
                ${runId}, ${workflow.id}, ${workflow.name}, ${order.id},
                ${order.name}, ${order.processedAt},
                ${lineItem.id}, ${lineItem.title},
                ${lineItem.variantTitle}, ${lineItem.sku},
                ${Domain.unitsToMake(lineItem)},
                ${json(lineItem.properties)},
                'open', ${now}, ${now}
              )
              on conflict do nothing
              returning *
            `,
        );
        if (run === undefined) return Option.none();
        // The meter, and the only place it fires. Inside the caller's
        // transaction, which for the reconcile path is the upsert's:
        // `OrderRepository.countOrder` carries the rule.
        yield* orderRepository.countOrder(order.id, now);
        yield* Effect.forEach(
          tasks,
          (task) => sql`
              insert into RunTask
                (id, runId, position, step, name, teamId, teamName, instructions,
                 startedAt, startedByEmail, doneAt, doneByEmail)
              values (
                ${crypto.randomUUID()}, ${runId}, ${task.position}, ${task.step},
                ${task.name}, ${task.teamId},
                ${teams.find((team) => team.id === task.teamId)?.name ?? ""},
                ${task.instructions}, null, null, null, null
              )
            `,
          { discard: true },
        );
        return Option.some(run);
      });

      const openOrders = sql`
        select id from ShopOrder
        where cancelledAt is null and fulfillmentStatus <> 'FULFILLED' and fullyPaid = 1
      `;

      /**
       * Reads the order, its items and its runs, calls
       * {@link Domain.reconcileItem} per item, and executes the actions;
       * the rule is there. The rules of a pass are the pass rules table on
       * {@link Domain.reconcileItem}; this is where rule 1 is enforced.
       *
       * `ReconcileCounts.multiMatch` is {@link Domain.multiMatchItems}, the
       * same rule as the `multi_match` issue.
       */
      const reconcileOrder = Effect.fn("RunRepository.reconcileOrder")(
        function* ({
          orderId,
          workflowsByTags,
          teams,
        }: ReconcileContext & { readonly orderId: string }) {
          const now = yield* Clock.currentTimeMillis;
          const [order] = yield* decodeOrders(
            yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
          );
          if (order === undefined) return NO_COUNTS;
          if (
            Domain.orderIsCancelled(order) ||
            Domain.orderIsFulfilled(order)
          ) {
            const status = Domain.orderIsCancelled(order)
              ? "cancelled"
              : "fulfilled";
            yield* Effect.logInfo(
              `RunRepository.reconcileOrder: orderId=${orderId} status=${status}`,
            ).pipe(Effect.annotateLogs({ orderId, status }));
          }
          const lineItems = yield* decodeLineItems(
            yield* sql`select * from OrderLineItem where orderId = ${orderId}`,
          );
          const runs = yield* decodeRuns(
            yield* sql`select * from Run where orderId = ${orderId}`,
          );
          const workflows = yield* workflowsByTags([
            ...new Set(lineItems.flatMap(({ productTags }) => productTags)),
          ]);
          const stored = new Set(lineItems.map((lineItem) => lineItem.id));
          const entries = [
            ...lineItems.map((lineItem) => ({
              lineItem: Option.some(lineItem),
              item: lineItem,
              run: runs.find((run) => run.lineItemId === lineItem.id) ?? null,
              matched: Domain.matchedWorkflows(lineItem, workflows, teams),
            })),
            // Pass rule 1 on `Domain.reconcileItem`: a run whose item is not
            // stored is read as an item at zero units.
            ...runs
              .filter((run) => !stored.has(run.lineItemId))
              .map((run) => ({
                lineItem: Option.none<Domain.OrderLineItem>(),
                item: { currentQuantity: 0 },
                run,
                matched: [],
              })),
          ];
          const planned = entries.map((entry) => ({
            entry,
            action: Domain.reconcileItem({
              order,
              item: entry.item,
              run: entry.run === null ? null : { run: entry.run },
              matched: entry.matched.map(({ workflow }) => workflow.id),
            }),
          }));
          const execute = ({
            entry: { lineItem, run, matched },
            action,
          }: (typeof planned)[number]) =>
            Match.value(action).pipe(
              Match.tagsExhaustive({
                create: ({ workflowId }) => {
                  const workflow = matched.find(
                    (detail) => detail.workflow.id === workflowId,
                  );
                  return workflow === undefined || Option.isNone(lineItem)
                    ? Effect.succeed(0)
                    : insertRun({
                        workflow,
                        teams,
                        order,
                        lineItem: lineItem.value,
                      }).pipe(
                        Effect.map((inserted) =>
                          Option.isSome(inserted) ? 1 : 0,
                        ),
                      );
                },
                close: ({ reason }) =>
                  run === null
                    ? Effect.succeed(0)
                    : closeOpenRuns(sql`id = ${run.id}`, reason, now),
                resize: ({ units }) =>
                  run === null
                    ? Effect.succeed(0)
                    : sql`
                        update Run
                        set quantity = ${units}, updatedAt = ${now}
                        where id = ${run.id}
                      `.pipe(Effect.as(1)),
                nothing: () => Effect.succeed(0),
              }),
              Effect.map((count) => ({ tag: action._tag, count })),
            );
          const done = yield* Effect.forEach(planned, execute, {
            concurrency: 1,
          });
          const sum = (tag: Domain.ReconcileAction["_tag"]) =>
            done.reduce(
              (total, result) =>
                total + (result.tag === tag ? result.count : 0),
              0,
            );
          const multiMatch = Domain.multiMatchItems(
            lineItems,
            runs,
            workflows,
            teams,
          ).map((lineItem) => ({
            lineItemId: lineItem.id,
            matched: Domain.matchedWorkflows(lineItem, workflows, teams).length,
          }));
          yield* Effect.forEach(
            multiMatch,
            ({ lineItemId, matched }) =>
              Effect.logInfo(
                `RunRepository.reconcileOrder: orderId=${orderId} lineItemId=${lineItemId} matched=${String(matched)}: multi-match, no run created`,
              ).pipe(Effect.annotateLogs({ orderId, lineItemId, matched })),
            { discard: true },
          );
          return {
            created: sum("create"),
            resized: sum("resize"),
            closed: sum("close"),
            multiMatch: multiMatch.length,
          } satisfies ReconcileCounts;
        },
      );

      const getRun = Effect.fn("RunRepository.getRun")(function* (
        input: { readonly runId: string } | { readonly runTaskId: string },
      ) {
        const runId =
          "runId" in input
            ? input.runId
            : (yield* sql`select runId from RunTask where id = ${input.runTaskId}`)[0]
                ?.runId;
        if (typeof runId !== "string") return Option.none();
        const run = yield* findRun(runId);
        if (Option.isNone(run)) return Option.none();
        const [detail] = yield* withTasks([run.value]);
        return Option.fromUndefinedOr(detail);
      });

      return RunRepository.of({
        reconcileOrder,

        reconcileAll: Effect.fn("RunRepository.reconcileAll")(function* (
          context: ReconcileContext,
        ) {
          const ids = yield* openOrders.pipe(
            Effect.map((rows) => rows.map((row) => String(row.id))),
          );
          const counts = yield* Effect.forEach(
            ids,
            (orderId) =>
              sql.withTransaction(reconcileOrder({ ...context, orderId })),
            { concurrency: 1 },
          );
          return {
            orders: ids.length,
            created: counts.reduce((sum, c) => sum + c.created, 0),
            multiMatch: counts.reduce((sum, c) => sum + c.multiMatch, 0),
          } satisfies ReconcileAllCounts;
        }),

        setRun: Effect.fn("RunRepository.setRun")(
          (input: Parameters<typeof insertRun>[0]) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const existing = yield* decodeRuns(
                  yield* sql`
                    select * from Run
                    where lineItemId = ${input.lineItem.id}
                  `,
                );
                const [incumbent] = existing;
                const closed =
                  incumbent !== undefined && Domain.runIsClosed(incumbent);
                if (
                  incumbent !== undefined &&
                  Domain.runIsOpen(incumbent) &&
                  incumbent.workflowId === input.workflow.workflow.id
                )
                  return Option.none();
                // Delete first: the unique `lineItemId` must be free before
                // the insert.
                if (incumbent !== undefined)
                  yield* sql`delete from Run where id = ${incumbent.id}`;
                const replaced = closed ? null : (incumbent ?? null);
                // The item's one run was deleted above, so the insert's
                // `on conflict do nothing` cannot fire here.
                const inserted = yield* insertRun(input);
                return Option.isNone(inserted)
                  ? Option.none()
                  : Option.some({ run: inserted.value, replaced });
              }),
            ),
        ),

        listRunsForOrder: Effect.fn("RunRepository.listRunsForOrder")(
          function* ({ orderId }: { readonly orderId: string }) {
            return yield* withTasks(
              yield* decodeRuns(
                yield* sql`
                  select * from Run
                  where orderId = ${orderId}
                  order by lineItemId, createdAt
                `,
              ),
            );
          },
        ),

        getRun,

        getRunGate: Effect.fn("RunRepository.getRunGate")(function* (
          input: { readonly runId: string } | { readonly runTaskId: string },
        ) {
          const found = yield* getRun(input);
          if (Option.isNone(found)) return Option.none();
          const { run, tasks } = found.value;
          const order = (yield* orderStates([run.orderId])).get(run.orderId);
          return order === undefined
            ? Option.none()
            : Option.some({
                run,
                tasks: Domain.runTaskRows(run, tasks),
                order,
              });
        }),

        cancelRun: Effect.fn("RunRepository.cancelRun")(function* ({
          runId,
        }: {
          readonly runId: string;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (!Domain.runIsOpen(run))
                yield* new RunTerminalError({ runId, state: run.state });
              const order = (yield* orderStates([run.orderId])).get(
                run.orderId,
              );
              if (order === undefined || !Domain.orderIsOpen(order))
                yield* new RunOrderClosedError({ runId });
              const now = yield* Clock.currentTimeMillis;
              yield* closeOpenRuns(
                sql`id = ${runId}`,
                "merchant_cancelled",
                now,
              );
            }),
          );
        }),

        /**
         * Two statements, then the grouping in TypeScript: every current task of
         * every run that has at least one current task for the caller's teams
         * (the other teams' tasks are what decide the run qualifies; they are
         * not shipped), then those runs with their last step. `json_each`
         * keeps the team list a single bound parameter.
         *
         * The statements ignore `query.team` and read all of `teamIds`: the
         * counts the team select shows are over every team, and narrowing the
         * SQL would make each selection a different read whose totals
         * disagreed with the one beside it.
         */
        listRuns: Effect.fn("RunRepository.listRuns")(function* ({
          teamIds,
          memberEmail,
          query,
        }: {
          readonly teamIds: readonly Domain.TeamId[];
          readonly memberEmail: Domain.Email;
          readonly query: Domain.RunQuery;
        }) {
          const items = yield* runListItems(teamIds);
          // A team the member is not on narrows to nothing rather than
          // failing: `items` only ever holds their own teams' tasks, so the
          // filter empties itself and every state counts zero.
          const narrowed =
            query.team === null
              ? items
              : items.flatMap((item): Domain.RunListItem[] => {
                  const [first, ...rest] = item.tasks.filter(
                    (task) => task.teamId === query.team,
                  );
                  return first === undefined
                    ? []
                    : [{ ...item, tasks: [first, ...rest] }];
                });
          // `Map.groupBy` would say this in one line, but the repo's `lib` is
          // below es2024; a reduce into a record is the same pass.
          const byState = narrowed.reduce<
            Record<Domain.RunListState, Domain.RunListItem[]>
          >(
            (grouped, item) => {
              grouped[Domain.listStateOf(item, memberEmail)].push(item);
              return grouped;
            },
            {
              blocked: [],
              started_by_you: [],
              started_by_others: [],
              ready: [],
            },
          );
          const inState = (wanted: Domain.RunListState) => byState[wanted];
          // A search ignores the state and the team: every open match on the
          // member's teams. Without one, "done" (Done or closed) is not a
          // RunListState: its rows come from `listRecent`, which reads done
          // tasks and closed runs rather than the current ones grouped here.
          const chosen = (): readonly Domain.RunListItem[] => {
            if (query.q !== null) {
              const term = Domain.searchTerm(query.q);
              return items.filter(({ run }) =>
                Domain.searchMatches(term, {
                  orderName: run.orderName,
                  title: run.lineItemTitle,
                  variantTitle: run.variantTitle,
                  sku: run.sku,
                }),
              );
            }
            return Domain.workflowsListStateIsDone(query.state)
              ? []
              : inState(query.state);
          };
          const wanted = chosen();
          const selected = wanted.toSorted(Domain.byAge).slice(0, query.limit);
          return {
            counts: {
              started_by_you: inState("started_by_you").length,
              started_by_others: inState("started_by_others").length,
              ready: inState("ready").length,
              blocked: inState("blocked").length,
            },
            items: selected,
            matches: query.q === null ? null : wanted.length,
          };
        }),

        listRecent: Effect.fn("RunRepository.listRecent")(function* ({
          teamIds,
          since,
          limit,
          q,
        }: {
          readonly teamIds: readonly string[];
          readonly since: number;
          readonly limit: number;
          readonly q: Domain.ListSearch | null;
        }) {
          if (teamIds.length === 0) return { items: [], total: 0 };
          const teams = json(teamIds);
          /**
           * `Domain.searchTerm` over the run's snapshot of its item, aliased
           * `r`: the order name whole, or a word prefix of the item title,
           * the variant title or the SKU (`Domain.prefixPatterns`). Narrows
           * the rows and `total` alike; `1 = 1` without a search.
           */
          const matching = Option.match(Option.fromNullOr(q), {
            onNone: () => sql.literal("1 = 1"),
            onSome: (text) => {
              const term = Domain.searchTerm(text);
              if (term.kind === "orderName")
                return sql`r.orderName = ${term.name}`;
              const [start, word] = Domain.prefixPatterns(term.text);
              return sql`(
                r.lineItemTitle like ${start} escape '\\'
                or r.lineItemTitle like ${word} escape '\\'
                or r.variantTitle like ${start} escape '\\'
                or r.variantTitle like ${word} escape '\\'
                or r.sku like ${start} escape '\\'
                or r.sku like ${word} escape '\\'
              )`;
            },
          });
          /**
           * Two windows, each bounded by `since` and served by its own index:
           * done tasks by `RunTask_teamId_idx (teamId,
           * doneAt)`, closed runs by `Run_closed_idx (closedAt)`,
           * partial over `closed`. So each counts a day, not the table.
           */
          const closedWhere = sql`
            r.state = 'closed' and r.closedAt >= ${since}
              and exists (
                select 1 from RunTask t
                where t.runId = r.id
                  and t.teamId in (select value from json_each(${teams}))
              )
          `;
          const countedTasks = yield* sql`
            select count(*) from RunTask s
            where s.doneAt >= ${since}
              and s.teamId in (select value from json_each(${teams}))
              and exists (
                select 1 from Run r where r.id = s.runId and ${matching}
              )
          `.values;
          const countedClosed =
            yield* sql`select count(*) from Run r where ${closedWhere} and ${matching}`
              .values;
          const total =
            Number(countedTasks[0]?.[0] ?? 0) +
            Number(countedClosed[0]?.[0] ?? 0);
          // Collapsed: the strip still counts the day, so the counts are read
          // and the rows are not.
          if (limit === 0) return { items: [], total };
          const done = yield* decodeTasks(
            yield* sql`
              select s.* from RunTask s
              where s.doneAt >= ${since}
                and s.teamId in (select value from json_each(${teams}))
                and exists (
                  select 1 from Run r where r.id = s.runId and ${matching}
                )
              order by s.doneAt desc, s.position desc
              limit ${limit}
            `,
          );
          const closed = yield* decodeRuns(
            yield* sql`
              select r.* from Run r where ${closedWhere} and ${matching}
              order by r.closedAt desc, r.id desc
              limit ${limit}
            `,
          );
          const runIds = [...new Set(done.map((task) => task.runId))];
          const runs = [
            ...closed,
            ...(yield* decodeRuns(
              runIds.length === 0
                ? []
                : yield* sql`
                    select * from Run
                    where id in (select value from json_each(${json(runIds)}))
                  `,
            )),
          ];
          const tasks = yield* tasksForRuns(runIds);
          const orders = yield* orderStates(runs.map((run) => run.orderId));
          const taskItems = done.flatMap(
            (task): (Domain.RecentItem & { readonly at: number })[] => {
              const run = runs.find((candidate) => candidate.id === task.runId);
              const order =
                run === undefined ? undefined : orders.get(run.orderId);
              return run === undefined || order === undefined
                ? []
                : [
                    {
                      kind: "task",
                      run,
                      task,
                      laterStepStarted: Domain.laterStepStarted(task, tasks),
                      order,
                      at: task.doneAt ?? 0,
                    },
                  ];
            },
          );
          const closedItems = closed.flatMap(
            (run): (Domain.RecentItem & { readonly at: number })[] => {
              const order = orders.get(run.orderId);
              return order === undefined
                ? []
                : [{ kind: "closed", run, order, at: run.closedAt ?? 0 }];
            },
          );
          const items = [...taskItems, ...closedItems]
            .toSorted((a, b) => b.at - a.at)
            .slice(0, limit)
            .map(({ at: _at, ...item }): Domain.RecentItem => item);
          return { items, total };
        }),

        reopenTask: Effect.fn("RunRepository.reopenTask")(function* ({
          runTaskId,
          teamIds,
        }: Domain.ReopenTaskCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              // Reopening a `done` run's last task is the point; a closed run
              // is final.
              const { task, run } = yield* requireActionable({
                runTaskId,
                teamIds,
                gate: (candidate) => !Domain.runIsClosed(candidate),
              });
              if (task.doneAt === null)
                yield* new TaskNotReadyError({ runTaskId });
              if (Domain.laterStepStarted(task, yield* tasksForRuns([run.id])))
                yield* new RunNotAllowedError({
                  runId: run.id,
                  teamId: task.teamId ?? "",
                });
              const now = yield* Clock.currentTimeMillis;
              // Reopen returns the task to Ready and records nothing; the
              // old Start is a claim the starter no longer makes and a time
              // that is no longer true.
              yield* sql`
                  update RunTask
                  set doneAt = null, doneByEmail = null, doneByRole = null,
                      startedAt = null, startedByEmail = null, startedByRole = null
                  where id = ${runTaskId}
                `;
              yield* recomputeState(run.id, now);
            }),
          );
        }),

        putBackTask: Effect.fn("RunRepository.putBackTask")(function* ({
          runTaskId,
          teamIds,
        }: Domain.PutBackTaskCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { task, run } = yield* requireActionable({
                runTaskId,
                teamIds,
              });
              if (Domain.runIsBlocked(run))
                yield* new RunBlockedError({ runId: run.id });
              if (task.startedAt === null || task.doneAt !== null)
                yield* new TaskNotReadyError({ runTaskId });
              // A started task is current by construction (Start required it,
              // and nothing behind it can reopen while it is started); the
              // check keeps the four task writes reading alike.
              if (!(yield* isCurrent(runTaskId)))
                yield* new TaskNotReadyError({ runTaskId });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update RunTask
                set startedAt = null, startedByEmail = null,
                    startedByRole = null
                where id = ${runTaskId}
              `;
              yield* recomputeState(run.id, now);
            }),
          );
        }),

        getRunPage: Effect.fn("RunRepository.getRunPage")(function* ({
          runId,
          teamIds,
        }: {
          readonly runId: string;
          readonly teamIds: readonly string[];
        }) {
          const found = yield* findRun(runId);
          if (Option.isNone(found)) return Option.none();
          const run = found.value;
          const tasks = yield* tasksForRuns([run.id]);
          if (!Domain.runIsVisibleTo(tasks, teamIds)) return Option.none();
          // `currentWhere` reads tasks alone, and a closed run keeps its open
          // tasks as the record: nothing on it is current ({@link Domain.currentTasks}).
          const current = Domain.runIsOpen(run)
            ? yield* currentTasks(run.id)
            : [];
          const [orderRow] = yield* decode(
            Schema.Array(
              Schema.Struct({
                ...Domain.OrderState.fields,
                note: Schema.NullOr(Schema.String),
              }),
            ),
            "Invalid order row",
          )(
            yield* sql`
              select cancelledAt, fulfillmentStatus, note from ShopOrder
              where id = ${run.orderId}
            `,
          );
          if (orderRow === undefined) return Option.none();
          const { note, ...order } = orderRow;
          return Option.some({
            run,
            tasks: tasks.map((task): Domain.RunTaskRow => ({
              ...task,
              current: current.some((candidate) => candidate.id === task.id),
              laterStepStarted: Domain.laterStepStarted(task, tasks),
            })),
            orderNote: note,
            order,
          } satisfies Domain.RunPageData);
        }),

        startTask: Effect.fn("RunRepository.startTask")(function* ({
          runTaskId,
          actor,
          teamIds,
        }: Domain.StartTaskCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { run } = yield* requireActionable({ runTaskId, teamIds });
              if (Domain.runIsBlocked(run))
                yield* new RunBlockedError({ runId: run.id });
              if (!(yield* isCurrent(runTaskId)))
                yield* new TaskNotReadyError({ runTaskId });
              const now = yield* Clock.currentTimeMillis;
              const by = actorColumns(actor);
              yield* sql`
                update RunTask
                set startedAt = coalesce(startedAt, ${now}),
                    startedByEmail = coalesce(startedByEmail, ${by.email}),
                    startedByRole = coalesce(startedByRole, ${by.role})
                where id = ${runTaskId}
              `;
              yield* recomputeState(run.id, now);
            }),
          );
        }),

        markTaskDone: Effect.fn("RunRepository.markTaskDone")(function* ({
          runTaskId,
          actor,
          teamIds,
        }: Domain.MarkTaskDoneCommand) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const { run } = yield* requireActionable({
                runTaskId,
                teamIds,
              });
              if (Domain.runIsBlocked(run))
                yield* new RunBlockedError({ runId: run.id });
              if (!(yield* isCurrent(runTaskId)))
                yield* new TaskNotReadyError({ runTaskId });
              const now = yield* Clock.currentTimeMillis;
              const by = actorColumns(actor);
              yield* sql`
                  update RunTask
                  set doneAt = ${now}, doneByEmail = ${by.email},
                      doneByRole = ${by.role},
                      startedAt = coalesce(startedAt, ${now}),
                      startedByEmail = coalesce(startedByEmail, ${by.email}),
                      startedByRole = coalesce(startedByRole, ${by.role})
                  where id = ${runTaskId}
                `;
              yield* recomputeState(run.id, now);
            }),
          );
        }),

        setRunNote: Effect.fn("RunRepository.setRunNote")(function* ({
          runId,
          teamIds,
          note,
        }: Domain.SetRunNoteCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireRun(runId);
              yield* requireRunTeam(runId, teamIds);
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update Run set note = ${note}, updatedAt = ${now}
                where id = ${runId}
              `;
            }),
          );
        }),

        blockRun: Effect.fn("RunRepository.blockRun")(function* ({
          runId,
          actor,
          teamIds,
          reason,
        }: Domain.BlockRunCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (!Domain.runIsOpen(run))
                yield* new RunTerminalError({ runId, state: run.state });
              yield* requireCurrentTeam(runId, teamIds);
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update Run
                set blockedAt = ${now}, blockReason = ${reason},
                    blockedBy = ${json(actorDisplay(actor))}, updatedAt = ${now}
                where id = ${runId}
              `;
            }),
          );
        }),

        listOrderTeamIds: Effect.fn("RunRepository.listOrderTeamIds")(
          function* (
            input:
              | { readonly runTaskId: string }
              | { readonly runId: string }
              | { readonly orderId: string },
          ) {
            // The caller that already holds the order — the webhook path —
            // names it and skips the run lookup entirely; the two run-shaped
            // callers resolve to the same order first.
            const orderOf = () => {
              if ("orderId" in input) return sql`select ${input.orderId}`;
              if ("runTaskId" in input)
                return sql`
                  select r0.orderId from Run r0
                  join RunTask s0 on s0.runId = r0.id
                  where s0.id = ${input.runTaskId}
                `;
              return sql`select r0.orderId from Run r0 where r0.id = ${input.runId}`;
            };
            // One statement answers both: the order is the join key the
            // team list needs, so it comes back on every row, and an order
            // with no assigned task still answers one row with a null team.
            const rows = yield* sql<{
              readonly orderId: string | null;
              readonly teamId: string | null;
            }>`
              with o(orderId) as (${orderOf()})
              select distinct o.orderId as orderId, rs.teamId as teamId
              from o
              left join Run r on r.orderId = o.orderId
              left join RunTask rs on rs.runId = r.id and rs.teamId is not null
            `;
            return {
              orderId: rows[0]?.orderId ?? null,
              teamIds: rows.flatMap((row) =>
                typeof row.teamId === "string" ? [row.teamId] : [],
              ),
            };
          },
        ),

        unblockRun: Effect.fn("RunRepository.unblockRun")(function* ({
          runId,
          teamIds,
        }: Domain.UnblockRunCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (!Domain.runIsOpen(run))
                yield* new RunTerminalError({ runId, state: run.state });
              if (!Domain.runIsBlocked(run))
                yield* new RunNotBlockedError({ runId });
              yield* requireCurrentTeam(runId, teamIds);
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update Run
                set blockedAt = null, blockReason = null, blockedBy = null,
                    updatedAt = ${now}
                where id = ${run.id}
              `;
            }),
          );
        }),

        assignRunTaskTeam: Effect.fn("RunRepository.assignRunTaskTeam")(
          function* ({
            runTaskId,
            team,
          }: {
            readonly runTaskId: string;
            readonly team: {
              readonly id: Domain.TeamId;
              readonly name: Domain.TeamName;
            };
          }) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const task = yield* requireTask(runTaskId);
                // The task first: on a done run every task is done, and
                // "keeps its team" is the truer refusal than "run not open".
                if (task.doneAt !== null)
                  yield* new TaskDoneError({ runTaskId });
                const run = yield* requireRun(task.runId);
                if (!Domain.runIsOpen(run))
                  yield* new RunTerminalError({
                    runId: run.id,
                    state: run.state,
                  });
                const now = yield* Clock.currentTimeMillis;
                yield* sql`
                  update RunTask
                  set teamId = ${team.id}, teamName = ${team.name}
                  where id = ${runTaskId}
                `;
                yield* sql`update Run set updatedAt = ${now} where id = ${task.runId}`;
              }),
            );
          },
        ),
      });
    }),
  );
}

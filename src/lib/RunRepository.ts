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
 * Attach refused: the item's run is `done`. Done work is a record,
 * and replacing it would delete a done record for a rework the run cards
 * do not model; the merchant reopens the last task and then changes it, or
 * leaves it. Names the incumbent so the page can.
 */
export class RunNotOpenError extends Schema.TaggedError<RunNotOpenError>()(
  "RunNotOpenError",
  { runId: Schema.String, workflowName: Domain.WorkflowName },
) {}

/**
 * The shop already holds `Domain.ShopLimits.maxOpenRuns` open runs
 * ({@link Domain.runIsOpen}). A safety valve rather than a product limit: at the ceiling a shop
 * is far outside anything the app is designed for, and the alternative — a
 * Durable Object whose run table grows without bound — is worse than a refusal
 * the merchant can act on by marking work done or cancelling it.
 */
export class RunLimitError extends Schema.TaggedError<RunLimitError>()(
  "RunLimitError",
  { limit: Schema.Number },
) {}

/** The task's team is not among the caller's teams. */
export class RunNotAllowedError extends Schema.TaggedError<RunNotAllowedError>()(
  "RunNotAllowedError",
  { runId: Schema.String, teamId: Schema.String },
) {}

/**
 * A write that only a standing block admits found none. Its own tag rather
 * than {@link RunNotAllowedError}: the caller had every right to the run, and
 * the page must say the hold was lifted rather than accuse the reader of
 * reaching into another team.
 */
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
 * `reopenTask` refused because someone downstream has already started
 * ({@link Domain.reopenBlockedBy}). Names the task and team so the page can say
 * who to ask.
 */
export class TaskReopenBlockedError extends Schema.TaggedError<TaskReopenBlockedError>()(
  "TaskReopenBlockedError",
  {
    runTaskId: Schema.String,
    taskName: Domain.TaskName,
    teamName: Domain.TeamName,
  },
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

/** What one pass over one order did, for the caller's log line and the release decision. No count reaches a screen: pass rule 10 on {@link Domain.reconcileItem}. */
export interface ReconcileCounts {
  /** Runs created by this pass. */
  readonly created: number;
  /** Open runs whose quantity this pass rewrote to the line's units ({@link Domain.Run} `quantityChangedFrom`). */
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
  /**
   * This pass's closes brought the shop back under the open-run ceiling
   * while runs stood declined (`releaseOpenRunLimit`): the caller runs a
   * reconcile all, outside this pass's transaction, so the declined runs
   * are created now ({@link Domain.reconcileItem}'s triggers table).
   */
  readonly ceilingReleased: boolean;
}

/** What `reconcileAll` hands back: the pass's counts, added over its orders, for the caller's one log line and the release decision (whether any order's closes released the open-run ceiling). No count reaches a screen: pass rule 10 on {@link Domain.reconcileItem}. */
export interface ReconcileAllCounts {
  readonly orders: number;
  readonly created: number;
  readonly multiMatch: number;
  readonly ceilingReleased: boolean;
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
  ceilingReleased: false,
};

export class RunRepository extends Context.Service<
  RunRepository,
  {
    /**
     * Plain statements, no transaction of its own: called from inside
     * `OrderRepository.upsertOrder`'s transaction via `afterWrite`, and Durable
     * Object SQLite refuses to nest. Reads the order and its stored items
     * back rather than trusting the caller's copy, so a reconcile is against
     * what is actually stored — including an order whose items the write
     * stored short (`Domain.ShopOrder.lineItemsTruncated`).
     */
    readonly reconcileOrder: (
      input: Domain.EligibleContext & { readonly orderId: string },
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
      input: Domain.EligibleContext,
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
     * - a `closed` run is deleted the same way, tasks and all, whatever its
     *   workflow, and `replaced` is null: nothing was open;
     * - a `done` run is refused ({@link RunNotOpenError}).
     *
     * A workflow the item ran before, the closed one included, starts fresh
     * from its definition. Nothing of the earlier run is resumed: closed is
     * final ({@link Domain.RunState}). The merchant confirmed the loss in
     * the Change workflow modal, or chose a new workflow for an item whose
     * run had already ended.
     */
    readonly setRun: (input: {
      readonly workflow: Domain.WorkflowDetail;
      readonly teams: Domain.EligibleContext["teams"];
      readonly order: Domain.ShopOrder;
      readonly lineItem: Domain.OrderLineItem;
    }) => Effect.Effect<
      Option.Option<{
        readonly run: Domain.Run;
        /** The open run deleted to make room, or null when the item was free or its run was closed. */
        readonly replaced: Domain.Run | null;
      }>,
      SqlError.SqlError | RunRepositoryError | RunLimitError | RunNotOpenError
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
     * record of who did what, the note stays, and the block and the quantity
     * badge are cleared with the rest of the run's open state. The row keeps
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
      { readonly ceilingReleased: boolean },
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunTerminalError
      | RunOrderClosedError
    >;
    /**
     * The member's workflows list, sorted by view and cut here rather than on the page: every run
     * with at least one current task owned by `teamIds`, grouped by
     * {@link Domain.viewOf} against `memberEmail`. **Every** view is counted;
     * **one** is returned — the one `query.view` names — sorted oldest first
     * and cut to `query.limit`. `view: "done"` returns no items at all and the
     * caller reads `listRecent` for that view's rows. Only open runs have
     * current tasks, so a closed or done run is never listed
     * ({@link Domain.RunState}).
     *
     * `teamCounts` and `total` are over all of `teamIds` whatever `query.team`
     * narrows to, so the team select does not move under the finger, while the
     * four view counts are after the narrowing, because they describe the
     * lists the member can switch to.
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
      },
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * The Done or closed view ({@link Domain.RecentItem}): tasks owned by `teamIds`
     * done at or after `since`, each with its run and the reopen verdict
     * ({@link Domain.reopenBlockedBy}), and runs with a task on `teamIds` that
     * closed at or after `since`, newest first by `doneAt` or
     * `closedAt`. The team's, not the caller's: a colleague notices a mistake
     * as readily as its author, and a closed run is news to everyone who
     * could see it.
     *
     * `total` is always the count inside the window, because the view row says it
     * even while another view is showing; `limit: 0` returns the count alone,
     * reading no rows.
     */
    readonly listRecent: (input: {
      readonly teamIds: readonly string[];
      readonly since: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly items: readonly Domain.RecentItem[]; readonly total: number },
      SqlError.SqlError | RunRepositoryError
    >;
    /**
     * Reopen returns a task to Ready: it clears the Done columns (`doneAt`,
     * `doneBy*`) and every Start column, member or merchant, and writes the
     * `reopened*` columns (`reopenedAt` / `reopenedByRole` / `reopenedByEmail`)
     * with who sent it back, then recomputes the run's state. The task is Ready for a worker
     * to Start. Keeping a member's Start would leave the task "Started · A ·
     * since <original time>": a claim A no longer makes and a time that is
     * no longer true, and it would take Undo then Put back to reach Ready
     * from a single Done. The `reopened*` columns already say who and when, so
     * nothing is lost. Allowed
     * for the task's team while nothing downstream has started
     * (`TaskReopenBlockedError` otherwise, naming the blocker). Gate: not
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
      | TaskReopenBlockedError
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
     * Offered to the whole team, not only the starter: Start is a record, not
     * a lock, and the inverse of a verb is as open as the verb. No column
     * records who put it back; the task is plain Ready and the next Start
     * writes a fresh record.
     *
     * Reopen is allowed under a block because it takes work back; Put back is
     * refused, because a held task is the one someone needs to write on, and
     * clearing who has it under a hold loses the one name the merchant needs.
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
     * and the reopen verdict, the order's live note and items. `None`
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
     * done task records who. Clears the `reopened*` columns: they say
     * "sent back and not yet redone", and a Done is precisely the end of
     * that. Clears the run's quantity badge (`quantityChangedFrom`, rule on
     * {@link Domain.Run}): a step done after the change is proof someone
     * worked with the new number. Nothing is created here. Gates:
     * {@link Domain.runIsOpen}, and not {@link Domain.runIsBlocked}.
     */
    readonly markTaskDone: (
      input: Domain.MarkTaskDoneCommand,
    ) => Effect.Effect<
      { readonly ceilingReleased: boolean },
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
     */
    readonly listOrderTeamIds: (
      input:
        | { readonly runTaskId: string }
        | { readonly runId: string }
        | { readonly orderId: string },
    ) => Effect.Effect<readonly string[], SqlError.SqlError>;
    /**
     * Rewrites `blockReason` on a run that is already blocked; `null` clears
     * the text and leaves the hold standing. `blockedBy` and `blockedAt` are
     * untouched — they record who set the hold and when, not who last
     * corrected its wording, and an edit is only text. Last write wins with
     * no history, by the rule on {@link Domain.SetRunNoteCommand}.
     *
     * Fails `RunNotBlockedError` unless {@link Domain.runIsBlocked}: an
     * unblocked run with a reason would be a hold set by nobody.
     */
    readonly setBlockReason: (
      input: Domain.SetBlockReasonCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunNotBlockedError
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
         fulfillmentStatus, fullyPaid, note, lineItemsTruncated, syncedAt`,
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
       * Separate from `listRuns` because sorting by view, narrowing, and capping are
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
                  "reopenedAt",
                  "reopenedByRole",
                  "reopenedByEmail",
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
       * `Run_state_idx` serves this; the scan it costs is bounded by
       * the ceiling itself, which is the whole reason the ceiling exists. A
       * second maintained counter would be cheaper per insert and would have
       * to stay correct across cancel, reconcile and every task write — one
       * derived count beats three places that must agree.
       */
      const openRunCount = Effect.fn("RunRepository.openRunCount")(
        function* () {
          const rows = yield* sql`select count(*) from Run where state = 'open'`
            .values;
          return Number(rows[0]?.[0] ?? 0);
        },
      );

      /**
       * Clears the banner once the shop is back under the ceiling, and says
       * whether it did: `true` means reconcile declined runs while the shop
       * was at the ceiling and there is now room, so the caller runs a
       * reconcile all to create them. Called after each write that can lower
       * the open-run count, and only those: a run's last Done
       * ({@link markTaskDone}), Cancel workflow ({@link cancelRun}) and a
       * close by reconcile ({@link reconcileOrder}). The column is read
       * first so the common case — never limited — is one row read and no
       * count, which matters because this runs on transitions as ordinary as
       * marking a task done.
       */
      const releaseOpenRunLimit = Effect.fn(
        "RunRepository.releaseOpenRunLimit",
      )(function* () {
        const rows =
          yield* sql`select openRunsLimitedAt from ShopUsage where id = 1`
            .values;
        if (rows[0]?.[0] === null || rows[0]?.[0] === undefined) return false;
        if ((yield* openRunCount()) >= Domain.ShopLimits.maxOpenRuns)
          return false;
        yield* sql`update ShopUsage set openRunsLimitedAt = null where id = 1`;
        return true;
      });

      /**
       * Closes every open run the fragment selects, with `reason`
       * ({@link Domain.ClosedReason}), and returns how many. The one close
       * write, for reconcile and Cancel workflow alike. The tasks and the note
       * stay as the record; the block and the quantity badge go, because they
       * are about work that has stopped ({@link Domain.RunState}).
       *
       * It does not release the ceiling itself: the caller does, once, after
       * all of its closes ({@link releaseOpenRunLimit}), so a pass that
       * closes several runs reads the count once.
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
              quantityChangedFrom = null, updatedAt = ${now}
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
       * {@link Domain.reconcileItem}; this is where rules 1, 4, 5 and 6 are
       * enforced.
       *
       * At the ceiling the planner declines rather than failing; why is with
       * the ceiling rules on {@link Domain.reconcileItem}. The decline sets
       * `ShopUsage.openRunsLimitedAt`, which raises a persistent banner naming
       * the cause, and a close by this pass releases it
       * ({@link releaseOpenRunLimit}).
       *
       * `ReconcileCounts.multiMatch` counts a multi-match item only when the
       * order can create runs ({@link Domain.orderCanCreateRuns}), the same
       * rule as the `multi_match` issue.
       */
      const reconcileOrder = Effect.fn("RunRepository.reconcileOrder")(
        function* ({
          orderId,
          workflows,
          teams,
        }: Domain.EligibleContext & { readonly orderId: string }) {
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
          const open = yield* withTasks(runs.filter(Domain.runIsOpen));
          const details = runs.map(
            (run): Domain.RunDetail =>
              open.find((detail) => detail.run.id === run.id) ?? {
                run,
                tasks: [],
              },
          );
          const stored = new Set(lineItems.map((lineItem) => lineItem.id));
          const entries = [
            ...lineItems.map((lineItem) => ({
              lineItem: Option.some(lineItem),
              item: lineItem,
              run:
                details.find(({ run }) => run.lineItemId === lineItem.id) ??
                null,
              matched: Domain.matchedWorkflows(lineItem, workflows, teams),
            })),
            ...details
              .filter(({ run }) => !stored.has(run.lineItemId))
              .map((detail) => ({
                lineItem: Option.none<Domain.OrderLineItem>(),
                item: { currentQuantity: 0 },
                run: detail,
                matched: [],
              })),
          ];
          const mayCreate =
            Domain.orderCanCreateRuns(order) &&
            entries.some(
              ({ run, matched }) => run === null && matched.length === 1,
            );
          const room = mayCreate
            ? Domain.ShopLimits.maxOpenRuns - (yield* openRunCount())
            : 0;
          const planned = entries.reduce<{
            readonly room: number;
            readonly plans: readonly {
              readonly entry: (typeof entries)[number];
              readonly action: Domain.ReconcileAction;
            }[];
          }>(
            (acc, entry) => {
              const action = Domain.reconcileItem({
                order,
                item: entry.item,
                run: entry.run,
                matched: entry.matched.map(({ workflow }) => workflow.id),
                atCeiling: acc.room <= 0,
              });
              return {
                room: acc.room - (action._tag === "create" ? 1 : 0),
                plans: [...acc.plans, { entry, action }],
              };
            },
            { room, plans: [] },
          ).plans;
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
                    : closeOpenRuns(sql`id = ${run.run.id}`, reason, now),
                resize: ({ units, badge }) => {
                  if (run === null) return Effect.succeed(0);
                  const original = badge
                    ? (run.run.quantityChangedFrom ?? run.run.quantity)
                    : run.run.quantityChangedFrom;
                  const from = original === units ? null : original;
                  return sql`
                    update Run
                    set quantity = ${units}, quantityChangedFrom = ${from},
                        updatedAt = ${now}
                    where id = ${run.run.id}
                  `.pipe(Effect.as(1));
                },
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
          // Release before the declined flag below: a pass that both closes
          // and declines says it released (so its caller runs the reconcile
          // all) and raises the banner again for what it declined.
          const ceilingReleased =
            sum("close") > 0 ? yield* releaseOpenRunLimit() : false;
          const declined = planned.filter(
            ({ action }) => action._tag === "nothing" && action.declined,
          ).length;
          if (declined > 0) {
            yield* sql`
              update ShopUsage
              set openRunsLimitedAt = coalesce(openRunsLimitedAt, ${now})
              where id = 1
            `;
            yield* Effect.logError(
              `RunRepository.reconcileOrder: orderId=${orderId} declined=${String(declined)} limit=${String(Domain.ShopLimits.maxOpenRuns)}: open-run ceiling reached, runs not created`,
            ).pipe(
              Effect.annotateLogs({
                orderId,
                declined,
                limit: Domain.ShopLimits.maxOpenRuns,
              }),
            );
          }
          const multiMatch = Domain.orderCanCreateRuns(order)
            ? entries.flatMap(({ lineItem, run, matched }) =>
                Option.isSome(lineItem) &&
                run === null &&
                Domain.unitsToMake(lineItem.value) > 0 &&
                matched.length >= 2
                  ? [{ lineItemId: lineItem.value.id, matched: matched.length }]
                  : [],
              )
            : [];
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
            ceilingReleased,
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
          context: Domain.EligibleContext,
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
            ceilingReleased: counts.some((c) => c.ceilingReleased),
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
                  !closed &&
                  incumbent?.workflowId === input.workflow.workflow.id
                )
                  return Option.none();
                if (
                  incumbent !== undefined &&
                  !closed &&
                  !Domain.runIsOpen(incumbent)
                )
                  return yield* new RunNotOpenError({
                    runId: incumbent.id,
                    workflowName: incumbent.workflowName,
                  });
                // Delete first: the unique `lineItemId` must be free before
                // the insert.
                if (incumbent !== undefined)
                  yield* sql`delete from Run where id = ${incumbent.id}`;
                const replaced = closed ? null : (incumbent ?? null);
                // The item's one run was deleted above, so the insert's
                // `on conflict do nothing` cannot fire here.
                //
                // Unlike reconcile this *fails*: a merchant clicked, nobody
                // is retrying on their behalf, and a silent no-op would read
                // as the attach having worked. Counted after the replace above
                // deleted any incumbent, so swapping one item's workflow at
                // the ceiling still works.
                if ((yield* openRunCount()) >= Domain.ShopLimits.maxOpenRuns)
                  return yield* new RunLimitError({
                    limit: Domain.ShopLimits.maxOpenRuns,
                  });
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
              return { ceilingReleased: yield* releaseOpenRunLimit() };
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
          const teamCounts = teamIds.map((teamId) => ({
            teamId,
            count: items.filter((item) =>
              item.tasks.some((task) => task.teamId === teamId),
            ).length,
          }));
          // A team the member is not on narrows to nothing rather than
          // failing: `items` only ever holds their own teams' tasks, so the
          // filter empties itself and the counts beside it still stand.
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
          const byView = narrowed.reduce<
            Record<Domain.RunView, Domain.RunListItem[]>
          >(
            (grouped, item) => {
              grouped[Domain.viewOf(item, memberEmail)].push(item);
              return grouped;
            },
            { blocked: [], mine: [], teammates: [], upNext: [] },
          );
          const inView = (wanted: Domain.RunView) => byView[wanted];
          // "done" (Done or closed) is not a RunView: its rows come from `listRecent`,
          // which reads done tasks and closed runs rather than the current
          // ones grouped here.
          const selected =
            query.view === "done"
              ? []
              : inView(query.view).toSorted(Domain.byAge).slice(0, query.limit);
          return {
            counts: {
              mine: inView("mine").length,
              upNext: inView("upNext").length,
              teammates: inView("teammates").length,
              blocked: inView("blocked").length,
              total: items.length,
              teamCounts,
            },
            items: selected,
          };
        }),

        listRecent: Effect.fn("RunRepository.listRecent")(function* ({
          teamIds,
          since,
          limit,
        }: {
          readonly teamIds: readonly string[];
          readonly since: number;
          readonly limit: number;
        }) {
          if (teamIds.length === 0) return { items: [], total: 0 };
          const teams = json(teamIds);
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
          `.values;
          const countedClosed =
            yield* sql`select count(*) from Run r where ${closedWhere}`.values;
          const total =
            Number(countedTasks[0]?.[0] ?? 0) +
            Number(countedClosed[0]?.[0] ?? 0);
          // Collapsed: the view row still counts the day, so the counts are read
          // and the rows are not.
          if (limit === 0) return { items: [], total };
          const done = yield* decodeTasks(
            yield* sql`
              select s.* from RunTask s
              where s.doneAt >= ${since}
                and s.teamId in (select value from json_each(${teams}))
              order by s.doneAt desc, s.position desc
              limit ${limit}
            `,
          );
          const closed = yield* decodeRuns(
            yield* sql`
              select r.* from Run r where ${closedWhere}
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
                      reopenBlockedBy: Domain.reopenBlockedBy(
                        task,
                        tasks.filter((other) => other.runId === run.id),
                      ),
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
          actor,
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
              const blocker = Domain.reopenBlockedBy(
                task,
                yield* tasksForRuns([run.id]),
              );
              if (blocker !== null)
                yield* new TaskReopenBlockedError({ runTaskId, ...blocker });
              const now = yield* Clock.currentTimeMillis;
              const by = actorColumns(actor);
              // Reopen returns the task to Ready. Who reopened it is the
              // `reopened*` columns; the old Start is a claim the starter no
              // longer makes and a time that is no longer true.
              yield* sql`
                  update RunTask
                  set doneAt = null, doneByEmail = null, doneByRole = null,
                      startedAt = null, startedByEmail = null, startedByRole = null,
                      reopenedAt = ${now}, reopenedByRole = ${by.role},
                      reopenedByEmail = ${by.email}
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
              reopenBlockedBy:
                task.doneAt === null
                  ? null
                  : Domain.reopenBlockedBy(task, tasks),
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
                      startedByRole = coalesce(startedByRole, ${by.role}),
                      reopenedAt = null, reopenedByRole = null,
                      reopenedByEmail = null
                  where id = ${runTaskId}
                `;
              yield* sql`update Run set quantityChangedFrom = null where id = ${run.id}`;
              yield* recomputeState(run.id, now);
              // The one member write that can lower the open-run count: the
              // run's last Done takes it out of `open`.
              return { ceilingReleased: yield* releaseOpenRunLimit() };
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
            const order = orderOf();
            const rows = yield* sql`
              select distinct rs.teamId as teamId
              from RunTask rs
              join Run r on r.id = rs.runId
              where rs.teamId is not null and r.orderId in (${order})
            `;
            return rows.flatMap((row) =>
              typeof row.teamId === "string" ? [row.teamId] : [],
            );
          },
        ),

        setBlockReason: Effect.fn("RunRepository.setBlockReason")(function* ({
          runId,
          teamIds,
          reason,
        }: Domain.SetBlockReasonCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (!Domain.runIsBlocked(run))
                yield* new RunNotBlockedError({ runId });
              yield* requireCurrentTeam(runId, teamIds);
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                  update Run
                  set blockReason = ${reason}, updatedAt = ${now}
                  where id = ${run.id}
                `;
            }),
          );
        }),

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

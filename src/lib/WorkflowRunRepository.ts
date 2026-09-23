import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Option, Schema, Struct } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import * as ReadyWhere from "@/lib/readyWhere";

/**
 * Failure to map stored rows into domain types — a `Schema` decode error, the
 * repository's own invariant, kept distinct from `SqlError.SqlError`.
 */
export class WorkflowRunRepositoryError extends Schema.TaggedError<WorkflowRunRepositoryError>()(
  "WorkflowRunRepositoryError",
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
 * The run's status refuses the action. For Start, Done, Block and Cancel that
 * is `!Domain.runIsOpen`; for the run note and Undo, `!Domain.runIsLive`; for
 * un-cancel, the inverse, `Domain.runIsLive`. The table on
 * {@link Domain.RunStatus} is the rule.
 */
export class RunTerminalError extends Schema.TaggedError<RunTerminalError>()(
  "RunTerminalError",
  { runId: Schema.String, status: Domain.RunStatus },
) {}

/**
 * Start or Done refused because the run carries a flag: a flag means stop,
 * whoever set it, until a person lifts it. Gate: `Domain.runIsFlagged`; see
 * {@link Domain.RunFlag}. Undo and the run note are not gated by it — Undo
 * takes work back rather than doing more, and a held run is the one to write on.
 */
export class RunFlaggedError extends Schema.TaggedError<RunFlaggedError>()(
  "RunFlaggedError",
  { runId: Schema.String, flag: Domain.RunFlag },
) {}

/**
 * Attach refused: the line item's live run is `done`. Finished work is a
 * record, and replacing it would rewrite that record to `cancelled` for a
 * rework the run cards do not model; the merchant reopens the last task and
 * then changes it, or leaves it. Names the incumbent so the page can.
 */
export class RunFinishedError extends Schema.TaggedError<RunFinishedError>()(
  "RunFinishedError",
  { runId: Schema.String, workflowName: Domain.WorkflowName },
) {}

/**
 * Un-cancel refused: another live run already occupies the line item. One live
 * run per item is a database invariant (`WorkflowRun_live_item_uidx`), so
 * without this check the update would surface as a raw `SqlError` rather than
 * as something the page can phrase. Names the occupant so it can.
 */
export class RunItemBusyError extends Schema.TaggedError<RunItemBusyError>()(
  "RunItemBusyError",
  { runId: Schema.String, workflowName: Domain.WorkflowName },
) {}

/**
 * The shop already holds `Domain.ShopLimits.maxOpenRuns` runs in `pending` or
 * `active`. A safety valve rather than a product limit: at the ceiling a shop
 * is far outside anything the app is designed for, and the alternative — a
 * Durable Object whose run table grows without bound — is worse than a refusal
 * the merchant can act on by finishing or cancelling work.
 */
export class WorkflowRunLimitError extends Schema.TaggedError<WorkflowRunLimitError>()(
  "WorkflowRunLimitError",
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

/** The task is not ready ({@link Domain.readyTasks}) or is already completed — or, for undo, not yet completed; for put back, not yet started or already completed. */
export class TaskNotReadyError extends Schema.TaggedError<TaskNotReadyError>()(
  "TaskNotReadyError",
  { runTaskId: Schema.String },
) {}

/**
 * `uncompleteTask` refused because someone downstream has already started
 * ({@link Domain.undoBlockedBy}). Names the task and team so the page can say
 * who to ask.
 */
export class TaskUndoBlockedError extends Schema.TaggedError<TaskUndoBlockedError>()(
  "TaskUndoBlockedError",
  {
    runTaskId: Schema.String,
    taskName: Domain.TaskName,
    teamName: Domain.TeamName,
  },
) {}

/**
 * `assignRunTaskTeam` on a completed task. Any *open* task reassigns,
 * started or not; a finished task is refused because the write would
 * overwrite `teamName`, the record of which team completed it.
 */
export class TaskFinishedError extends Schema.TaggedError<TaskFinishedError>()(
  "TaskFinishedError",
  { runTaskId: Schema.String },
) {}

export interface ReconcileCounts {
  /** Runs created by this pass. */
  readonly created: number;
  readonly cancelled: number;
  readonly flagged: number;
  /**
   * Line items this pass left **ambiguous**: two or more startable workflows
   * matched and no live run exists, so nothing was started and the merchant
   * has to choose. Not a fault — a count worth logging, and the number the
   * orders index turns into a step.
   */
  readonly ambiguous: number;
}

export interface ReconcileAllCounts {
  /** Open, paid orders the pass visited. */
  readonly orders: number;
  /** Runs created. */
  readonly created: number;
  /** Line items left ambiguous; see {@link ReconcileCounts.ambiguous}. */
  readonly ambiguous: number;
}

export interface StartContext {
  readonly workflows: readonly Domain.WorkflowDetail[];
  /** The live D1 roster: what a task's `teamId` must resolve against, and where `teamName` is snapshotted from. */
  readonly teams: readonly {
    readonly id: Domain.TeamId;
    readonly name: Domain.TeamName;
  }[];
}

/**
 * The definition-side half of whether a workflow starts a run (vocabulary on
 * `Domain.Workflow`): switched off, empty, or with an unassigned task
 * (`teamId` null, or an id the roster does not carry) all mean "starts
 * nothing". A team with no members does *not* block: the run is created and
 * its task waits on nobody's list until someone joins. Shared by the tag
 * match on upsert and by manual attach — the latter skips the line-item half
 * (tags, quantity, fulfilment, age) but never this half, and answers
 * separately to {@link Domain.canAttachRun} for the state of the order as a
 * whole. Drafts never reach here: `WorkflowDetail` carries workflow tasks
 * only.
 */
export const canStart = (
  { workflow, tasks }: Domain.WorkflowDetail,
  teams: StartContext["teams"],
) =>
  Domain.isActive(workflow) &&
  tasks.length > 0 &&
  tasks.every(
    (task) =>
      task.teamId !== null && teams.some((team) => team.id === task.teamId),
  );

/**
 * The line-item half: the tag test and the date rule. An order qualifies
 * only when it was placed (`processedAt`) on or after the workflow's
 * `activatedAt`: a bulk stream of thirty days of history, or an edit
 * webhook on an order shipped a month ago, must not start work on orders
 * placed before the workflow was turned on, whichever path delivers them.
 * It is Turn on, not the last Apply: a re-apply must not disown an unpaid
 * order placed while the workflow was on. An off workflow never reaches
 * this (`canStart` first), so `activatedAt` null reads as "never".
 */
export const matchesLineItem = (
  detail: Domain.WorkflowDetail,
  order: Domain.ShopOrder,
  lineItem: Domain.OrderLineItem,
) => placedSince(detail.workflow, order) && matchesTag(detail, lineItem);

/** The date rule alone: placed on or after Turn on. Off never qualifies. */
export const placedSince = (
  workflow: Domain.Workflow,
  order: Pick<Domain.ShopOrder, "processedAt">,
) => workflow.activatedAt !== null && order.processedAt >= workflow.activatedAt;

/** The tag test alone, with units still to make; what the Turn on dialog's count uses, since it asks "would match if the date allowed". */
export const matchesTag = (
  { workflow }: Domain.WorkflowDetail,
  lineItem: Pick<Domain.OrderLineItem, "productTags" | "currentQuantity">,
) =>
  lineItem.currentQuantity > 0 &&
  lineItem.productTags.some((tag) => workflow.tag === tag.trim().toLowerCase());

const json = (value: unknown) => JSON.stringify(value);

/** One row per waiting order: the count, and the placed date "Include them" would move `activatedAt` to. */
const summarise = (
  rows: readonly { readonly processedAt: number }[],
): Domain.WaitingOrders => ({
  count: rows.length,
  earliestProcessedAt: rows.reduce<number | null>(
    (earliest, row) =>
      earliest === null || row.processedAt < earliest
        ? row.processedAt
        : earliest,
    null,
  ),
});

/**
 * An {@link Domain.Actor} flattened into the three columns a task's actor slot
 * holds. The merchant has no `Member` row, so the id and email are null beside
 * a `'merchant'` role — the role column is what readers discriminate on.
 */
const actorColumns = (actor: Domain.Actor) =>
  actor.role === "merchant"
    ? { role: "merchant" as const, id: null, email: null }
    : { role: "member" as const, id: actor.memberId, email: actor.email };

const NO_COUNTS: ReconcileCounts = {
  created: 0,
  cancelled: 0,
  flagged: 0,
  ambiguous: 0,
};

export class WorkflowRunRepository extends Context.Service<
  WorkflowRunRepository,
  {
    /**
     * Plain statements, no transaction of its own: called from inside
     * `OrderRepository.upsertOrder`'s transaction via `afterWrite`, and Durable
     * Object SQLite refuses to nest. Reads the order and its stored line items
     * back rather than trusting the caller's view, so a reconcile is against
     * what is actually stored — including an order whose line items the write
     * stored short (`Domain.ShopOrder.lineItemsTruncated`).
     */
    readonly reconcileOrder: (
      input: StartContext & { readonly orderId: string },
    ) => Effect.Effect<
      ReconcileCounts,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * `reconcileOrder` over every open, paid order, one transaction each:
     * what runs after a definition changes on an on workflow (Turn on, its
     * date moved, Apply). Fulfilled orders are excluded on purpose —
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
      input: StartContext,
    ) => Effect.Effect<
      ReconcileAllCounts,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * What the Turn on dialog asks: how many stored, open (unfulfilled, not
     * cancelled) orders **Include them would actually start** — not merely
     * match — and the placed date of the earliest. Paid or not, since an
     * unpaid one qualifies the day it pays.
     *
     * Three exclusions, all of them the one-live-run-per-item rule read
     * forward: an item whose tags do not match; an item already carrying a
     * live run, whoever started it, because a workflow turned on later never
     * displaces one; and an item that another *active* workflow's tag also
     * matches, because that item would come out ambiguous and reconcile would
     * start nothing on it. The last is why the whole {@link StartContext} is
     * taken rather than the one workflow: ambiguity is a property of the set.
     *
     * Row cost: the open orders' line items, once per dialog open.
     */
    readonly countWaitingOrders: (
      input: StartContext & {
        readonly workflow: Domain.WorkflowDetail;
      },
    ) => Effect.Effect<
      Domain.WaitingOrders,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Manual attach, read as **set this item's workflow**. An item holds at
     * most one live run, so this is a replace, done in one transaction:
     *
     * - a live run for *this* workflow is `None` — nothing to do, and the
     *   caller reads it as "already there";
     * - a live run for a different workflow is cancelled first, so the
     *   partial index is free before the insert, and comes back as
     *   `replaced` — unless it is `done`, which is refused
     *   ({@link RunFinishedError}): gate {@link Domain.runIsOpen} on the
     *   incumbent;
     * - a *cancelled* run for `(lineItemId, workflowId)` is un-cancelled
     *   rather than replaced by a fresh one. That is the existing recovery
     *   semantics of the run key, and it is what the merchant means: the
     *   tasks already done on that earlier run come back with it.
     *
     * Attach is the merchant's opt-in, so the date rule does not apply to it.
     */
    readonly setRun: (input: {
      readonly workflow: Domain.WorkflowDetail;
      readonly teams: StartContext["teams"];
      readonly order: Domain.ShopOrder;
      readonly lineItem: Domain.OrderLineItem;
      readonly source: Domain.RunSource;
    }) => Effect.Effect<
      Option.Option<{
        readonly run: Domain.WorkflowRun;
        /** The run cancelled to make room, or null when the item was free. */
        readonly replaced: Domain.WorkflowRun | null;
      }>,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | WorkflowRunLimitError
      | RunFinishedError
    >;
    readonly listRunsForOrder: (input: {
      readonly orderId: string;
    }) => Effect.Effect<
      readonly Domain.WorkflowRunDetail[],
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    readonly getRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowRunDetail>,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /** Gate: {@link Domain.runIsOpen}; see {@link Domain.RunStatus}. A `done` run is not cancelled, it is undone. */
    readonly cancelRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunTerminalError
    >;
    /**
     * Gate: the inverse of {@link Domain.runIsLive}, only from `cancelled`;
     * status is recomputed from the tasks. Refused with
     * {@link RunItemBusyError} when another live run has taken the line item
     * in the meantime — one live run per item, so the occupant has to go first.
     */
    readonly uncancelRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunTerminalError
      | RunItemBusyError
    >;
    /**
     * The member's run list, tiered and cut here rather than on the page: every run
     * with at least one ready task owned by `teamIds`, grouped by
     * {@link Domain.tierOf} against `memberEmail`. **Every** tier is counted;
     * **one** is returned — the one `query.tab` names — sorted oldest first
     * and cut to `query.limit`. `tab: "done"` returns no items at all and the
     * caller reads `listDone` for that tab's rows.
     *
     * `teamCounts` and `total` are over all of `teamIds` whatever `query.team`
     * narrows to, so the team select does not move under the finger, while the
     * four tier counts are after the narrowing, because they describe the
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
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Tasks owned by `teamIds` completed at or after `since`, newest first,
     * each with its run and the undo verdict ({@link undoBlockedBy}). The
     * team's, not the caller's: a colleague notices a mistake as readily as
     * its author. Cancelled runs are excluded — nothing there is undoable.
     *
     * `total` is always the count inside the window, because the heading says
     * it even while the tier is collapsed; `limit: 0` is that collapsed state
     * and returns the count alone, reading no rows.
     */
    readonly listDone: (input: {
      readonly teamIds: readonly string[];
      readonly since: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly items: readonly Domain.DoneItem[]; readonly total: number },
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Undo returns a task to Ready: it clears the completed slot and every
     * Start column, member or merchant, and writes the `reopened*` slot
     * (`reopenedAt` / `reopenedByRole` / `reopenedByEmail`) with who sent it
     * back, then recomputes the run's status. The task is Ready for a worker
     * to Start. Keeping a member's Start would leave the task "In progress by
     * A since <original time>": a claim A no longer makes and a time that is
     * no longer true, and it would take Undo then Put back to reach Ready
     * from a single Done. The `reopened*` slot already says who and when, so
     * nothing is lost. Allowed
     * for the task's team while nothing downstream has started
     * (`TaskUndoBlockedError` otherwise, naming the blocker). Gate:
     * {@link Domain.runIsLive}, not `runIsOpen` — undoing a `done` run's last
     * task is the point; see {@link Domain.RunStatus}.
     */
    readonly uncompleteTask: (
      input: Domain.UncompleteTaskCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
      | TaskNotReadyError
      | TaskUndoBlockedError
    >;
    /**
     * Put back clears the Start record of an in-progress task, and the run's
     * status is recomputed (a run whose only started task is put back is
     * `pending` again). Refused on a finished task or an unstarted task
     * (`TaskNotReadyError`), a run that is not {@link Domain.runIsOpen}
     * (`RunTerminalError`), a flagged run (`RunFlaggedError`), or, for a
     * member, a task not on one of their teams (`RunNotAllowedError`).
     *
     * Offered to the whole team, not only the starter: Start is a record, not
     * a lock, and the inverse of a verb is as open as the verb. No slot
     * records who put it back; the task is plain Ready and the next Start
     * writes a fresh record.
     *
     * Undo is allowed under a flag because it takes work back; Put back is
     * refused, because a held task is the one someone needs to write on, and
     * clearing who has it under a hold loses the one name the merchant needs.
     */
    readonly unstartTask: (
      input: Domain.UnstartTaskCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | TaskNotReadyError
      | RunTerminalError
      | RunFlaggedError
    >;
    /**
     * The work page's read: the run with every task decorated by readiness
     * and the undo verdict, the order's live note and line items. `None`
     * when the run does not exist or the caller cannot see it
     * ({@link Domain.runIsVisibleTo}) — one answer for both, so a member
     * cannot probe run ids.
     */
    readonly getRunView: (input: {
      readonly runId: string;
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      Option.Option<Domain.RunView>,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Marks a ready task in progress. Idempotent: a second Start leaves the
     * original `startedAt` / `startedBy` / `startedByEmail` — no takeover, no
     * error — so two people pressing it does not rewrite who began. The
     * email is snapshotted so history reads after the member is deleted.
     * Gates: {@link Domain.runIsOpen}, and not {@link Domain.runIsFlagged}.
     */
    readonly startTask: (
      input: Domain.StartTaskCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | TaskNotReadyError
      | RunTerminalError
      | RunFlaggedError
    >;
    /**
     * Also backfills the started slot with the same actor when Done arrives
     * without a Start, so every finished task records who. Clears the
     * `reopened` slot: that slot says "sent back and not yet redone", and a
     * Done is precisely the end of that. Nothing is created here. Gates:
     * {@link Domain.runIsOpen}, and not {@link Domain.runIsFlagged}.
     */
    readonly completeTask: (
      input: Domain.CompleteTaskCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | TaskNotReadyError
      | RunTerminalError
      | RunFlaggedError
    >;
    /**
     * Writes the run's note; `null` clears it. No readiness requirement — a
     * note on a done run is allowed: a note is a record, not work, and the
     * thing noticed after the last Done is exactly what wants writing down.
     * Gate: {@link Domain.runIsLive}; see {@link Domain.RunStatus}. A member
     * needs to see the run ({@link Domain.runIsVisibleTo}), not to hold a
     * ready task as Block does: a done run has no ready task and would
     * refuse every member. Last write wins; see
     * {@link Domain.SetRunNoteCommand}.
     */
    readonly setRunNote: (
      input: Domain.SetRunNoteCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
    >;
    /** Sets `flag = 'blocked'` with an optional reason and the actor, overwriting any prior flag. Allowed when a ready task belongs to `teamIds`. Gate: {@link Domain.runIsOpen}; see {@link Domain.RunStatus}. */
    readonly blockRun: (
      input: Domain.BlockRunCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
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
     * Rewrites `flagDetail.reason` on a run that is already `blocked`;
     * `null` clears the text and leaves the hold standing. `by` and `flagAt`
     * are untouched — they record who set the hold and when, not who last
     * corrected its wording, and an edit is only text. Last write wins with
     * no history, by the rule on {@link Domain.SetRunNoteCommand}.
     *
     * Fails `RunNotBlockedError` unless the flag is `blocked`. A reconcile
     * flag's body is generated from the run, so there is nothing to write,
     * and an unflagged run would be a hold set by nobody.
     */
    readonly setBlockReason: (
      input: Domain.SetBlockReasonCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunNotBlockedError
    >;
    /** Allowed when any ready task of the run belongs to one of `teamIds`, or unconditionally for the merchant (`teamIds` undefined). */
    readonly dismissFlag: (
      input: Domain.DismissFlagCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
    >;
    /**
     * Points any *open* run task at `team`, snapshotting the name from the
     * live roster the caller resolved, and puts the task on that team's
     * list. The team's existence is the caller's check (`Team` is a D1 row
     * this store cannot see). Allowed on any open task, assigned or not and
     * started or not — it is both the remedy that makes a team delete safe
     * and the merchant's way to move work between teams. Only `teamId` /
     * `teamName` are written, so a started task keeps `startedBy` /
     * `startedByEmail` and history still names whoever began it. A finished
     * task is refused (`TaskFinishedError`), and so is a task of a run that
     * is not {@link Domain.runIsOpen} (`RunTerminalError`): a cancelled run's
     * tasks are on nobody's list and moving them would say otherwise.
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
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunTerminalError
      | TaskFinishedError
    >;
  }
>()("WorkflowRunRepository") {
  /**
   * Depends on {@link OrderRepository} because {@link insertRun} is where the
   * billing meter fires (`OrderRepository.countOrder`). The direction is one
   * way on purpose: `OrderRepository` knows nothing about runs — it takes
   * `afterWrite` as a parameter rather than calling reconcile itself — so
   * nothing here closes a cycle.
   */
  static readonly layer: Layer.Layer<
    WorkflowRunRepository,
    never,
    SqlClient.SqlClient | OrderRepository
  > = Layer.effect(
    WorkflowRunRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orderRepository = yield* OrderRepository;

      const decode =
        <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
        (rows: unknown) =>
          Schema.decodeUnknownEffect(schema)(rows).pipe(
            Effect.mapError(
              (cause) => new WorkflowRunRepositoryError({ message, cause }),
            ),
          );

      const decodeRuns = decode(
        Schema.Array(Domain.WorkflowRun),
        "Invalid WorkflowRun row",
      );
      const decodeTasks = decode(
        Schema.Array(Domain.WorkflowRunTask),
        "Invalid WorkflowRunTask row",
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
          }),
        ),
        "Invalid run list row",
      );

      const orderColumns = sql.literal(
        `id, legacyId, name, processedAt, updatedAt, cancelledAt,
         closedAt, financialStatus, fulfillmentStatus, fullyPaid, note,
         customAttributes, lineItemsTruncated, syncedAt, syncSource`,
      );

      const findRun = (runId: string) =>
        sql`select * from WorkflowRun where id = ${runId}`.pipe(
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
        sql`select * from WorkflowRunTask where id = ${runTaskId}`.pipe(
          Effect.flatMap(decodeTasks),
          Effect.flatMap(([task]) =>
            task === undefined
              ? Effect.fail(new RunNotFoundError({ id: runTaskId }))
              : Effect.succeed(task),
          ),
        );

      /** The predicate itself is in `readyWhere.ts`; the JSDoc there says why it does not live in this layer. */
      const readyWhere = (alias: string) =>
        sql.literal(ReadyWhere.readyWhere(alias));

      const readyTasks = (runId: string) =>
        sql`
          select s.* from WorkflowRunTask s
          where s.runId = ${runId} and ${readyWhere("s")}
          order by s.position
        `.pipe(Effect.flatMap(decodeTasks));

      const isReady = (runTaskId: string) =>
        sql`
          select 1 from WorkflowRunTask s
          where s.id = ${runTaskId} and ${readyWhere("s")}
        `.pipe(Effect.map((rows) => rows.length > 0));

      /**
       * The guard every task action shares: task exists, the run passes
       * `gate` ({@link Domain.runIsOpen} for Start and Done;
       * {@link Domain.runIsLive} for Undo), task's team among the caller's.
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
        readonly gate?: (run: Domain.WorkflowRun) => boolean;
      }) =>
        Effect.gen(function* () {
          const task = yield* requireTask(runTaskId);
          const run = yield* requireRun(task.runId);
          if (!gate(run))
            yield* new RunTerminalError({ runId: run.id, status: run.status });
          if (teamIds !== undefined && !Domain.taskIsOnTeams(task, teamIds))
            yield* new RunNotAllowedError({
              runId: run.id,
              teamId: task.teamId ?? "",
            });
          return { task, run };
        });

      /**
       * `RunNotAllowedError` unless some ready task of the run belongs to
       * `teamIds`. Undefined `teamIds` is the merchant and always passes, for
       * the reason on {@link requireActionable}.
       */
      const requireReadyTeam = (
        runId: string,
        teamIds: readonly string[] | undefined,
      ) =>
        teamIds === undefined
          ? Effect.void
          : readyTasks(runId).pipe(
              Effect.flatMap((ready) =>
                Domain.runIsVisibleTo(ready, teamIds)
                  ? Effect.void
                  : Effect.fail(
                      new RunNotAllowedError({
                        runId,
                        teamId: ready[0]?.teamId ?? "",
                      }),
                    ),
              ),
            );

      const tasksForRuns = (runIds: readonly string[]) =>
        runIds.length === 0
          ? Effect.succeed([])
          : sql`
              select * from WorkflowRunTask
              where runId in (select value from json_each(${json(runIds)}))
              order by runId, position
            `.pipe(Effect.flatMap(decodeTasks));

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
       * Every run list row the teams own, unsorted and uncapped: one
       * {@link Domain.RunListItem} per run with at least one ready task of
       * `teamIds`, carrying that run's last step. Actor emails are on the row
       * already, so no roster join and no D1 read.
       *
       * The first statement still reads *every* ready task of a qualifying
       * run, including tasks owned by other teams: that is how it decides the
       * run qualifies at all, and it is why the row's own tasks are filtered
       * in TypeScript below rather than in SQL. Nothing about the other
       * teams' tasks is shipped.
       *
       * Separate from `listRuns` because tiering, narrowing, and capping are
       * decisions about the rows rather than about the query: keeping them
       * apart means the two statements below are read once, in one place.
       */
      const runListItems = Effect.fn("WorkflowRunRepository.runListItems")(
        function* (teamIds: readonly Domain.TeamId[]) {
          if (teamIds.length === 0) return [];
          const ready = yield* decodeTasks(
            yield* sql`
              select s.* from WorkflowRunTask s
              join WorkflowRun r on r.id = s.runId
              where r.status in ('pending', 'active')
                and ${readyWhere("s")}
                and exists (
                  select 1 from WorkflowRunTask m
                  where m.runId = s.runId
                    and m.teamId in (select value from json_each(${json(teamIds)}))
                    and ${readyWhere("m")}
                )
              order by s.runId, s.position
            `,
          );
          if (ready.length === 0) return [];
          const runIds = [...new Set(ready.map((task) => task.runId))];
          const runs = yield* decodeRunListRuns(
            yield* sql`
              select r.*,
                (select max(step) from WorkflowRunTask c where c.runId = r.id) as stepCount
              from WorkflowRun r
              where r.id in (select value from json_each(${json(runIds)}))
              order by r.orderProcessedAt, r.lineItemId, r.id
            `,
          );
          return runs.flatMap(({ stepCount, ...run }): Domain.RunListItem[] => {
            const [first, ...rest] = ready
              .filter(
                (task) =>
                  task.runId === run.id && Domain.taskIsOnTeams(task, teamIds),
              )
              // Whatever the row does not render is dropped rather than
              // nulled or carried: the shape is {@link Domain.RunListTask} and
              // its JSDoc is why.
              .map((task) =>
                Struct.omit(task, [
                  "completedAt",
                  "completedBy",
                  "completedByEmail",
                  "completedByRole",
                  "instructions",
                  "reopenedAt",
                  "reopenedByRole",
                  "reopenedByEmail",
                ]),
              );
            return first === undefined
              ? []
              : [{ run, tasks: [first, ...rest], stepCount }];
          });
        },
      );

      const withTasks = (runs: readonly Domain.WorkflowRun[]) =>
        Effect.gen(function* () {
          const tasks = yield* tasksForRuns(runs.map((run) => run.id));
          return runs.map((run): Domain.WorkflowRunDetail => ({
            run,
            tasks: tasks.filter((task) => task.runId === run.id),
          }));
        });

      /**
       * `status` is a function of the tasks; recomputing it in SQL from the
       * same rows the task write just touched is what keeps the two in one
       * transaction with nothing to drift. A started task counts as `active`
       * on its own: "someone has started work" is exactly what should protect
       * a run from being silently cancelled by reconcile.
       */
      const recomputeStatus = (runId: string, now: number) =>
        Effect.andThen(
          sql`
          update WorkflowRun set
            status = (
              select case
                when count(*) = sum(completedAt is not null) then 'done'
                when sum(completedAt is not null) > 0 or sum(startedAt is not null) > 0 then 'active'
                else 'pending'
              end
              from WorkflowRunTask s where s.runId = WorkflowRun.id
            ),
            updatedAt = ${now}
          where id = ${runId}
        `,
          // The one transition that can free an open-run slot is a run going
          // `done`, and it goes `done` here or nowhere.
          releaseOpenRunLimit(),
        );

      /**
       * `WorkflowRun_status_idx` serves this; the scan it costs is bounded by
       * the ceiling itself, which is the whole reason the ceiling exists. A
       * second maintained counter would be cheaper per insert and would have
       * to stay correct across cancel, un-cancel, reconcile and every task
       * write — one derived count beats four places that must agree.
       */
      const openRunCount = Effect.fn("WorkflowRunRepository.openRunCount")(
        function* () {
          const rows =
            yield* sql`select count(*) from WorkflowRun where status in ('pending', 'active')`
              .values;
          return Number(rows[0]?.[0] ?? 0);
        },
      );

      /**
       * Clears the banner once the shop is back under the ceiling. The flag is
       * read first so the common case — never limited — is one row read and no
       * count, which matters because this runs on transitions as ordinary as
       * completing a task.
       */
      const releaseOpenRunLimit = Effect.fn(
        "WorkflowRunRepository.releaseOpenRunLimit",
      )(function* () {
        const rows =
          yield* sql`select openRunsLimitedAt from ShopUsage where id = 1`
            .values;
        if (rows[0]?.[0] === null || rows[0]?.[0] === undefined) return;
        if ((yield* openRunCount()) < Domain.ShopLimits.maxOpenRuns)
          yield* sql`update ShopUsage set openRunsLimitedAt = null where id = 1`;
      });

      const cancelPending = (orderId: string, now: number) =>
        sql`
          update WorkflowRun
          set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
          where orderId = ${orderId} and status = 'pending'
          returning id
        `.pipe(
          Effect.tap(() => releaseOpenRunLimit()),
          Effect.map((rows) => rows.length),
        );

      const flagWhere = (
        status: Statement.Fragment,
        where: Statement.Fragment,
        flag: Domain.RunFlag,
        detail: Domain.RunFlagDetail,
        now: number,
      ) =>
        sql`
          update WorkflowRun
          set flag = ${flag}, flagAt = ${now}, flagDetail = ${json(detail)}, updatedAt = ${now}
          where ${status} and ${where}
          returning id
        `.pipe(Effect.map((rows) => rows.length));

      const flagActive = (
        where: Statement.Fragment,
        flag: Domain.RunFlag,
        detail: Domain.RunFlagDetail,
        now: number,
      ) => flagWhere(sql`status = 'active'`, where, flag, detail, now);

      /**
       * The one write that marks a run whose line item changed size, and the
       * one flag a `done` run can take (the rule is on `Domain.RunFlag`): a
       * finished run keeps its quantity, so the flag is all that happens to
       * it, while an active run is resized first by the caller. A `pending`
       * run never reaches here — nobody has started it, so it is resized
       * silently.
       */
      const flagQuantityChanged = (
        runId: string,
        detail: Domain.RunFlagDetail,
        now: number,
      ) =>
        flagWhere(
          sql`status in ('active', 'done')`,
          sql`id = ${runId}`,
          "quantity_changed",
          detail,
          now,
        );

      /**
       * `canStart` has already required every task's team to be in `teams`,
       * so the `teamName` lookup cannot miss.
       *
       * The conflict target is unqualified because `WorkflowRun` now carries
       * two unique indexes and either may fire: `(lineItemId, workflowId)`,
       * the un-cancel key, means this workflow already ran on this item in
       * some status; `WorkflowRun_live_item_uidx` means a *different*
       * workflow holds the item live. Both mean "do not insert", and naming
       * one target would turn the other into a thrown `SqlError` in the
       * middle of a reconcile pass. No row returned is `Option.none()`, which
       * every caller already reads as "nothing created".
       */
      const insertRun = Effect.fn("WorkflowRunRepository.insertRun")(
        function* ({
          workflow: { workflow, tasks },
          teams,
          order,
          lineItem,
          source,
        }: {
          readonly workflow: Domain.WorkflowDetail;
          readonly teams: StartContext["teams"];
          readonly order: Domain.ShopOrder;
          readonly lineItem: Domain.OrderLineItem;
          readonly source: Domain.RunSource;
        }) {
          const now = yield* Clock.currentTimeMillis;
          const runId = crypto.randomUUID();
          const [run] = yield* decodeRuns(
            yield* sql`
              insert into WorkflowRun (
                id, workflowId, workflowName, orderId, orderName, orderProcessedAt,
                lineItemId, lineItemTitle, variantTitle, sku, quantity, customAttributes,
                source, status, flag, flagAt, flagDetail, createdAt, updatedAt,
                cancelledAt
              ) values (
                ${runId}, ${workflow.id}, ${workflow.name}, ${order.id},
                ${order.name}, ${order.processedAt},
                ${lineItem.id}, ${lineItem.title},
                ${lineItem.variantTitle}, ${lineItem.sku},
                ${Domain.unitsToMake(lineItem)},
                ${json(lineItem.customAttributes)},
                ${source}, 'pending', null, null, null, ${now}, ${now}, null
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
              insert into WorkflowRunTask
                (id, runId, position, step, name, teamId, teamName, instructions,
                 startedAt, startedBy, startedByEmail, completedAt, completedBy,
                 completedByEmail)
              values (
                ${crypto.randomUUID()}, ${runId}, ${task.position}, ${task.step},
                ${task.name}, ${task.teamId},
                ${teams.find((team) => team.id === task.teamId)?.name ?? ""},
                ${task.instructions}, null, null, null, null, null, null
              )
            `,
            { discard: true },
          );
          return Option.some(run);
        },
      );

      const openOrders = sql`
        select id from ShopOrder
        where cancelledAt is null and fulfillmentStatus <> 'FULFILLED' and fullyPaid = 1
      `;

      /**
       * `OrderLineItem.matchedWorkflowIds` is written on the way through, so
       * it is current only for the orders this function walks all of: an
       * order that is cancelled or fulfilled returns before the column is
       * touched, and `reconcileAll` skips unpaid orders entirely. The badges
       * derived from it (`Domain.ambiguousItems`, the index's "Choose a
       * workflow") are therefore current for **open, paid** orders and may be
       * stale for any other — which is the right trade: a closed order's
       * matches are of no interest, and an unpaid one is reconciled the
       * moment it pays.
       *
       * Two gates, deliberately split. `Domain.isCancelled` and
       * `Domain.isFulfilled` are the stop gates and return early;
       * `Domain.canStartRuns` (paid) gates only run *creation*. Adjusting
       * open runs against their line items happens whether or not the order
       * is currently paid, so an edit that pushes a paid order back to
       * unpaid keeps its runs, still tracks removals and quantity changes,
       * and simply creates nothing new until the balance lands — a payment
       * wobble must never cancel work in progress.
       */
      const reconcileOrder = Effect.fn("WorkflowRunRepository.reconcileOrder")(
        function* ({
          orderId,
          workflows,
          teams,
        }: StartContext & { readonly orderId: string }) {
          const now = yield* Clock.currentTimeMillis;
          const [order] = yield* decodeOrders(
            yield* sql`select ${orderColumns} from ShopOrder where id = ${orderId}`,
          );
          if (order === undefined) return NO_COUNTS;
          const earlyExit = (status: "cancelled" | "fulfilled") =>
            Effect.logInfo(
              `WorkflowRunRepository.reconcileOrder: orderId=${orderId} status=${status}`,
            ).pipe(Effect.annotateLogs({ orderId, status }));
          if (Domain.isCancelled(order)) {
            yield* earlyExit("cancelled");
            return {
              ...NO_COUNTS,
              cancelled: yield* cancelPending(orderId, now),
              flagged: yield* flagActive(
                sql`orderId = ${orderId}`,
                "order_cancelled",
                {},
                now,
              ),
            };
          }
          /**
           * Nothing left to make. Pending runs go silently (no one started
           * them); active runs are flagged because their premise cannot be
           * restored. Partial fulfillment changes nothing anywhere: shipping
           * a line leaves its `currentQuantity` alone, so neither this branch
           * nor `adjust` below sees a difference ({@link Domain.unitsToMake}).
           */
          if (Domain.isFulfilled(order)) {
            yield* earlyExit("fulfilled");
            const cancelled = yield* cancelPending(orderId, now);
            const flagged = yield* flagActive(
              sql`orderId = ${orderId}`,
              "order_fulfilled",
              {},
              now,
            );
            return { ...NO_COUNTS, cancelled, flagged };
          }
          const orderCanStart = Domain.canStartRuns(order);
          const lineItems = yield* decodeLineItems(
            yield* sql`select * from OrderLineItem where orderId = ${orderId}`,
          );
          // The non-cancelled runs: the open ones are adjusted below against
          // their line items. A cancelled run keeps its key and is left alone.
          const runs = yield* decodeRuns(
            yield* sql`
                select * from WorkflowRun
                where orderId = ${orderId} and status <> 'cancelled'
              `,
          );
          const startable = workflows.filter((workflow) =>
            canStart(workflow, teams),
          );
          /**
           * One run per line item, not the cross product. Each item records
           * every startable workflow that matched it, and only a *single*
           * match with no live run starts anything:
           *
           * - two or more matches is an ambiguity, and picking for the
           *   merchant would route work to the wrong team silently, so
           *   nothing starts and the order page asks;
           * - a live run (`pending`, `active` or `done`) already owns the
           *   item, so a workflow turned on later never displaces it — which
           *   is the whole of the "existing runs win" rule, no extra code.
           *
           * `matchedWorkflowIds` is written on every pass, including when the
           * order cannot start runs yet, so an unpaid order already carries
           * its matches the moment payment lands, and so the column can never
           * go stale behind a definition change.
           */
          const matches = lineItems.map((lineItem) => ({
            lineItem,
            matched: startable.filter((workflow) =>
              matchesLineItem(workflow, order, lineItem),
            ),
            hasLive: runs.some((run) => run.lineItemId === lineItem.id),
          }));
          yield* Effect.forEach(
            matches,
            ({ lineItem, matched }) => sql`
              update OrderLineItem
              set matchedWorkflowIds = ${json(matched.map(({ workflow }) => workflow.id))}
              where id = ${lineItem.id}
            `,
            { discard: true },
          );
          const ambiguous = matches.filter(
            ({ matched, hasLive }) => !hasLive && matched.length >= 2,
          );
          yield* Effect.forEach(
            ambiguous,
            ({ lineItem, matched }) =>
              Effect.logInfo(
                `WorkflowRunRepository.reconcileOrder: orderId=${orderId} lineItemId=${lineItem.id} matched=${String(matched.length)}: ambiguous, no run started`,
              ).pipe(
                Effect.annotateLogs({
                  orderId,
                  lineItemId: lineItem.id,
                  matched: matched.length,
                }),
              ),
            { discard: true },
          );
          const toStart = orderCanStart
            ? matches.flatMap(({ lineItem, matched, hasLive }) =>
                hasLive || matched.length !== 1 || matched[0] === undefined
                  ? []
                  : [{ lineItem, workflow: matched[0] }],
              )
            : [];
          /**
           * Auto-start yields to the ceiling rather than failing: this runs
           * inside the order's upsert transaction, so failing would fail the
           * webhook, Shopify would retry it for four hours, and no retry can
           * fix a condition that only finishing work clears — the order write
           * would be lost for nothing. The order is stored, shows on the index
           * with no workflow, `ShopUsage.openRunsLimitedAt` raises a persistent
           * banner naming the cause, and the next `reconcileAll` starts it once
           * there is room, because that pass walks every open order.
           */
          const capacity = Math.max(
            0,
            toStart.length === 0
              ? 0
              : Domain.ShopLimits.maxOpenRuns - (yield* openRunCount()),
          );
          const declined = toStart.length - Math.min(capacity, toStart.length);
          if (declined > 0) {
            yield* sql`
              update ShopUsage
              set openRunsLimitedAt = coalesce(openRunsLimitedAt, ${now})
              where id = 1
            `;
            yield* Effect.logError(
              `WorkflowRunRepository.reconcileOrder: orderId=${orderId} declined=${String(declined)} limit=${String(Domain.ShopLimits.maxOpenRuns)}: open-run ceiling reached, runs not started`,
            ).pipe(
              Effect.annotateLogs({
                orderId,
                declined,
                limit: Domain.ShopLimits.maxOpenRuns,
              }),
            );
          }
          const inserted = yield* Effect.forEach(
            toStart.slice(0, capacity),
            ({ lineItem, workflow }) =>
              insertRun({
                workflow,
                teams,
                order,
                lineItem,
                source: "tag",
              }).pipe(
                Effect.map(
                  Option.map((run) => ({ run, item: lineItem.title })),
                ),
              ),
          ).pipe(Effect.map((results) => results.filter(Option.isSome)));
          const created = inserted.length;
          /**
           * Tracks `Domain.unitsToMake`, so a refund that lowers
           * `currentQuantity` reads exactly like a merchant edit.
           *
           * Runs over every live run, `done` included, because a quantity
           * change on a finished line is exactly the case nobody is watching
           * for: the merchant edits the order in Shopify and the maker has
           * already put the work down. A `done` run takes the flag and
           * nothing else — see `Domain.RunFlag` for the whole rule, including
           * why a `done` run whose units reach zero is left alone.
           */
          const adjust = (run: Domain.WorkflowRun) => {
            const lineItem = lineItems.find(
              (item) => item.id === run.lineItemId,
            );
            const units =
              lineItem === undefined ? 0 : Domain.unitsToMake(lineItem);
            if (Domain.runIsDone(run))
              return units === 0 ||
                units === run.quantity ||
                Domain.alreadyFlaggedQuantity(run, units)
                ? Effect.succeed({ cancelled: 0, flagged: 0 })
                : flagQuantityChanged(
                    run.id,
                    { from: run.quantity, to: units },
                    now,
                  ).pipe(Effect.map((flagged) => ({ cancelled: 0, flagged })));
            if (units === 0)
              return Domain.runIsUnstarted(run)
                ? sql`
                      update WorkflowRun
                      set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                      where id = ${run.id}
                    `.pipe(Effect.as({ cancelled: 1, flagged: 0 }))
                : flagActive(sql`id = ${run.id}`, "item_removed", {}, now).pipe(
                    Effect.map((flagged) => ({ cancelled: 0, flagged })),
                  );
            if (units === run.quantity)
              return Effect.succeed({ cancelled: 0, flagged: 0 });
            return sql`
                update WorkflowRun
                set quantity = ${units}, updatedAt = ${now}
                where id = ${run.id}
              `.pipe(
              Effect.andThen(
                Domain.runIsUnstarted(run)
                  ? Effect.succeed(0)
                  : flagQuantityChanged(
                      run.id,
                      { from: run.quantity, to: units },
                      now,
                    ),
              ),
              Effect.map((flagged) => ({ cancelled: 0, flagged })),
            );
          };
          // `runs` is every non-cancelled run on the order, which is exactly
          // the set `adjust` is written for.
          const adjusted = yield* Effect.all(runs.map(adjust));
          return adjusted.reduce<ReconcileCounts>(
            (counts, delta) => ({
              ...counts,
              cancelled: counts.cancelled + delta.cancelled,
              flagged: counts.flagged + delta.flagged,
            }),
            {
              created,
              cancelled: 0,
              flagged: 0,
              ambiguous: ambiguous.length,
            },
          );
        },
      );

      return WorkflowRunRepository.of({
        reconcileOrder,

        reconcileAll: Effect.fn("WorkflowRunRepository.reconcileAll")(
          function* (context: StartContext) {
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
              created: counts.reduce((sum, { created }) => sum + created, 0),
              ambiguous: counts.reduce(
                (sum, { ambiguous }) => sum + ambiguous,
                0,
              ),
            } satisfies ReconcileAllCounts;
          },
        ),

        countWaitingOrders: Effect.fn(
          "WorkflowRunRepository.countWaitingOrders",
        )(function* ({
          workflow,
          workflows,
          teams,
        }: StartContext & { readonly workflow: Domain.WorkflowDetail }) {
          // The open orders' line items with no live run on them. The tag
          // test stays in TypeScript so this count and reconcile share one
          // predicate, even though `Workflow.tag` is a plain column.
          const rows = yield* decode(
            Schema.Array(
              Schema.Struct({
                orderId: Schema.String,
                processedAt: Schema.Number,
                currentQuantity: Schema.Number,
                productTags: Schema.fromJsonString(Schema.Array(Schema.String)),
              }),
            ),
            "Invalid waiting line item row",
          )(
            yield* sql`
              select li.orderId, o.processedAt, li.currentQuantity, li.productTags
              from OrderLineItem li
              join ShopOrder o on o.id = li.orderId
              where o.cancelledAt is null and o.fulfillmentStatus <> 'FULFILLED'
                and li.currentQuantity > 0
                and not exists (
                  select 1 from WorkflowRun r
                  where r.lineItemId = li.id and r.status <> 'cancelled'
                )
            `,
          );
          // Rivals: the other startable workflows. An item any of them also
          // matches is ambiguous the moment this one goes on, and ambiguity
          // starts nothing, so it is not a waiting order.
          const rivals = workflows.filter(
            (candidate) =>
              candidate.workflow.id !== workflow.workflow.id &&
              canStart(candidate, teams),
          );
          const matching = rows.filter(
            (row) =>
              matchesTag(workflow, row) &&
              !rivals.some((rival) => matchesTag(rival, row)),
          );
          const byOrder = [
            ...new Map(matching.map((row) => [row.orderId, row])).values(),
          ];
          return summarise(byOrder);
        }),

        setRun: Effect.fn("WorkflowRunRepository.setRun")(
          (input: Parameters<typeof insertRun>[0]) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const existing = yield* decodeRuns(
                  yield* sql`
                    select * from WorkflowRun
                    where lineItemId = ${input.lineItem.id}
                  `,
                );
                const live = existing.find(Domain.runIsLive);
                if (live?.workflowId === input.workflow.workflow.id)
                  return Option.none();
                if (live !== undefined && !Domain.runIsOpen(live))
                  return yield* new RunFinishedError({
                    runId: live.id,
                    workflowName: live.workflowName,
                  });
                const now = yield* Clock.currentTimeMillis;
                // Cancel first: the partial index must be free before the
                // insert or the un-cancel below touches the item.
                if (live !== undefined)
                  yield* sql`
                    update WorkflowRun
                    set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                    where id = ${live.id}
                  `;
                const replaced = live ?? null;
                const cancelled = existing.find(
                  (run) =>
                    !Domain.runIsLive(run) &&
                    run.workflowId === input.workflow.workflow.id,
                );
                if (cancelled !== undefined) {
                  yield* sql`update WorkflowRun set cancelledAt = null where id = ${cancelled.id}`;
                  yield* recomputeStatus(cancelled.id, now);
                  // Read back for the recomputed status. The row was just
                  // updated inside this transaction, so the miss is
                  // unreachable; `None` keeps the caller's one vocabulary.
                  const [run] = yield* decodeRuns(
                    yield* sql`select * from WorkflowRun where id = ${cancelled.id}`,
                  );
                  return run === undefined
                    ? Option.none()
                    : Option.some({ run, replaced });
                }
                // Every run this item already has for this workflow was
                // handled above, live or cancelled, so the insert's
                // `on conflict do nothing` cannot fire here.
                //
                // Unlike auto-start this *fails*: a merchant clicked, nobody
                // is retrying on their behalf, and a silent no-op would read
                // as the attach having worked. Counted after the replace above
                // cancelled any incumbent, so swapping one item's workflow at
                // the ceiling still works.
                if ((yield* openRunCount()) >= Domain.ShopLimits.maxOpenRuns)
                  return yield* new WorkflowRunLimitError({
                    limit: Domain.ShopLimits.maxOpenRuns,
                  });
                const inserted = yield* insertRun(input);
                return Option.isNone(inserted)
                  ? Option.none()
                  : Option.some({ run: inserted.value, replaced });
              }),
            ),
        ),

        listRunsForOrder: Effect.fn("WorkflowRunRepository.listRunsForOrder")(
          function* ({ orderId }: { readonly orderId: string }) {
            return yield* withTasks(
              yield* decodeRuns(
                yield* sql`
                  select * from WorkflowRun
                  where orderId = ${orderId}
                  order by lineItemId, createdAt
                `,
              ),
            );
          },
        ),

        getRun: Effect.fn("WorkflowRunRepository.getRun")(function* ({
          runId,
        }: {
          readonly runId: string;
        }) {
          const run = yield* findRun(runId);
          if (Option.isNone(run)) return Option.none();
          const [detail] = yield* withTasks([run.value]);
          return Option.fromUndefinedOr(detail);
        }),

        cancelRun: Effect.fn("WorkflowRunRepository.cancelRun")(function* ({
          runId,
        }: {
          readonly runId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (!Domain.runIsOpen(run))
                yield* new RunTerminalError({ runId, status: run.status });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update WorkflowRun
                set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                where id = ${runId}
              `;
              yield* releaseOpenRunLimit();
            }),
          );
        }),

        uncancelRun: Effect.fn("WorkflowRunRepository.uncancelRun")(function* ({
          runId,
        }: {
          readonly runId: string;
        }) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              // The inverse of `Domain.runIsLive`: only a cancelled run has
              // a cancel to undo.
              if (Domain.runIsLive(run))
                yield* new RunTerminalError({ runId, status: run.status });
              // The item may have been routed elsewhere since the cancel.
              // Checked here rather than left to `WorkflowRun_live_item_uidx`,
              // which would throw a raw `SqlError` the page cannot phrase.
              const [occupant] = yield* decodeRuns(
                yield* sql`
                  select * from WorkflowRun
                  where lineItemId = ${run.lineItemId} and status <> 'cancelled'
                  limit 1
                `,
              );
              if (occupant !== undefined)
                yield* new RunItemBusyError({
                  runId,
                  workflowName: occupant.workflowName,
                });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`update WorkflowRun set cancelledAt = null where id = ${runId}`;
              yield* recomputeStatus(runId, now);
            }),
          );
        }),

        /**
         * Two statements, then the grouping in TypeScript: every ready task of
         * every run that has at least one ready task for the caller's teams
         * (the other teams' tasks are what decide the run qualifies; they are
         * not shipped), then those runs with their last step. `json_each`
         * keeps the team list a single bound parameter.
         *
         * The statements ignore `query.team` and read all of `teamIds`: the
         * counts the team select shows are over every team, and narrowing the
         * SQL would make each selection a different read whose totals
         * disagreed with the one beside it.
         */
        listRuns: Effect.fn("WorkflowRunRepository.listRuns")(function* ({
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
          const byTier = narrowed.reduce<
            Record<Domain.RunTier, Domain.RunListItem[]>
          >(
            (grouped, item) => {
              grouped[Domain.tierOf(item, memberEmail)].push(item);
              return grouped;
            },
            { attention: [], mine: [], inProgress: [], upNext: [] },
          );
          const tier = (wanted: Domain.RunTier) => byTier[wanted];
          // "done" is not a tier: its rows come from `listDone`, which reads
          // finished tasks rather than the ready ones grouped here.
          const selected =
            query.tab === "done"
              ? []
              : tier(query.tab).toSorted(Domain.byAge).slice(0, query.limit);
          return {
            counts: {
              mine: tier("mine").length,
              upNext: tier("upNext").length,
              inProgress: tier("inProgress").length,
              attention: tier("attention").length,
              total: items.length,
              teamCounts,
            },
            items: selected,
          };
        }),

        listDone: Effect.fn("WorkflowRunRepository.listDone")(function* ({
          teamIds,
          since,
          limit,
        }: {
          readonly teamIds: readonly string[];
          readonly since: number;
          readonly limit: number;
        }) {
          if (teamIds.length === 0) return { items: [], total: 0 };
          /**
           * Served by `WorkflowRunTask_teamId_idx (teamId, completedAt)` and
           * bounded by the caller's window, so it counts a day of one team's
           * finished tasks rather than scanning the table.
           */
          const counted = yield* sql`
            select count(*) from WorkflowRunTask s
            join WorkflowRun r on r.id = s.runId
            where s.completedAt >= ${since}
              and s.teamId in (select value from json_each(${json(teamIds)}))
              and r.status <> 'cancelled'
          `.values;
          const total = Number(counted[0]?.[0] ?? 0);
          // The collapsed tier: the heading still counts the day, so the count
          // is read and the rows are not.
          if (limit === 0) return { items: [], total };
          const done = yield* decodeTasks(
            yield* sql`
              select s.* from WorkflowRunTask s
              join WorkflowRun r on r.id = s.runId
              where s.completedAt >= ${since}
                and s.teamId in (select value from json_each(${json(teamIds)}))
                and r.status <> 'cancelled'
              order by s.completedAt desc, s.position desc
              limit ${limit}
            `,
          );
          if (done.length === 0) return { items: [], total };
          const runIds = [...new Set(done.map((task) => task.runId))];
          const runs = yield* decodeRuns(
            yield* sql`
              select * from WorkflowRun
              where id in (select value from json_each(${json(runIds)}))
            `,
          );
          const tasks = yield* tasksForRuns(runIds);
          const items = done.flatMap((task): Domain.DoneItem[] => {
            const run = runs.find((candidate) => candidate.id === task.runId);
            return run === undefined
              ? []
              : [
                  {
                    run,
                    task,
                    undoBlockedBy: Domain.undoBlockedBy(
                      task,
                      tasks.filter((other) => other.runId === run.id),
                    ),
                  },
                ];
          });
          return { items, total };
        }),

        uncompleteTask: Effect.fn("WorkflowRunRepository.uncompleteTask")(
          function* ({
            runTaskId,
            actor,
            teamIds,
          }: Domain.UncompleteTaskCommand) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const { task, run } = yield* requireActionable({
                  runTaskId,
                  teamIds,
                  gate: Domain.runIsLive,
                });
                if (task.completedAt === null)
                  yield* new TaskNotReadyError({ runTaskId });
                const blocker = Domain.undoBlockedBy(
                  task,
                  yield* tasksForRuns([run.id]),
                );
                if (blocker !== null)
                  yield* new TaskUndoBlockedError({ runTaskId, ...blocker });
                const now = yield* Clock.currentTimeMillis;
                const by = actorColumns(actor);
                // Undo returns the task to Ready. Who reopened it is the
                // `reopened*` slot; the old Start is a claim the starter no
                // longer makes and a time that is no longer true.
                yield* sql`
                  update WorkflowRunTask
                  set completedAt = null, completedBy = null,
                      completedByEmail = null, completedByRole = null,
                      startedAt = null, startedBy = null,
                      startedByEmail = null, startedByRole = null,
                      reopenedAt = ${now}, reopenedByRole = ${by.role},
                      reopenedByEmail = ${by.email}
                  where id = ${runTaskId}
                `;
                yield* recomputeStatus(run.id, now);
              }),
            );
          },
        ),

        unstartTask: Effect.fn("WorkflowRunRepository.unstartTask")(function* ({
          runTaskId,
          teamIds,
        }: Domain.UnstartTaskCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { task, run } = yield* requireActionable({
                runTaskId,
                teamIds,
              });
              if (run.flag !== null)
                yield* new RunFlaggedError({ runId: run.id, flag: run.flag });
              if (task.startedAt === null || task.completedAt !== null)
                yield* new TaskNotReadyError({ runTaskId });
              // A started task is ready by construction (Start required it,
              // and nothing behind it can reopen while it is started); the
              // check keeps the four task writes reading alike.
              if (!(yield* isReady(runTaskId)))
                yield* new TaskNotReadyError({ runTaskId });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update WorkflowRunTask
                set startedAt = null, startedBy = null,
                    startedByEmail = null, startedByRole = null
                where id = ${runTaskId}
              `;
              yield* recomputeStatus(run.id, now);
            }),
          );
        }),

        getRunView: Effect.fn("WorkflowRunRepository.getRunView")(function* ({
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
          const ready = yield* readyTasks(run.id);
          const [noteRow] = yield* sql`
            select note from ShopOrder where id = ${run.orderId}
          `;
          return Option.some({
            run,
            tasks: tasks.map((task): Domain.RunTaskView => ({
              ...task,
              ready: ready.some((candidate) => candidate.id === task.id),
              undoBlockedBy:
                task.completedAt === null
                  ? null
                  : Domain.undoBlockedBy(task, tasks),
            })),
            orderNote: typeof noteRow?.note === "string" ? noteRow.note : null,
          } satisfies Domain.RunView);
        }),

        startTask: Effect.fn("WorkflowRunRepository.startTask")(function* ({
          runTaskId,
          actor,
          teamIds,
        }: Domain.StartTaskCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { run } = yield* requireActionable({ runTaskId, teamIds });
              if (run.flag !== null)
                yield* new RunFlaggedError({ runId: run.id, flag: run.flag });
              if (!(yield* isReady(runTaskId)))
                yield* new TaskNotReadyError({ runTaskId });
              const now = yield* Clock.currentTimeMillis;
              const by = actorColumns(actor);
              yield* sql`
                update WorkflowRunTask
                set startedAt = coalesce(startedAt, ${now}),
                    startedBy = coalesce(startedBy, ${by.id}),
                    startedByEmail = coalesce(startedByEmail, ${by.email}),
                    startedByRole = coalesce(startedByRole, ${by.role})
                where id = ${runTaskId}
              `;
              yield* recomputeStatus(run.id, now);
            }),
          );
        }),

        completeTask: Effect.fn("WorkflowRunRepository.completeTask")(
          function* ({
            runTaskId,
            actor,
            teamIds,
          }: Domain.CompleteTaskCommand) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const { run } = yield* requireActionable({
                  runTaskId,
                  teamIds,
                });
                if (run.flag !== null)
                  yield* new RunFlaggedError({ runId: run.id, flag: run.flag });
                if (!(yield* isReady(runTaskId)))
                  yield* new TaskNotReadyError({ runTaskId });
                const now = yield* Clock.currentTimeMillis;
                const by = actorColumns(actor);
                yield* sql`
                  update WorkflowRunTask
                  set completedAt = ${now}, completedBy = ${by.id},
                      completedByEmail = ${by.email},
                      completedByRole = ${by.role},
                      startedAt = coalesce(startedAt, ${now}),
                      startedBy = coalesce(startedBy, ${by.id}),
                      startedByEmail = coalesce(startedByEmail, ${by.email}),
                      startedByRole = coalesce(startedByRole, ${by.role}),
                      reopenedAt = null, reopenedByRole = null,
                      reopenedByEmail = null
                  where id = ${runTaskId}
                `;
                yield* recomputeStatus(run.id, now);
              }),
            );
          },
        ),

        setRunNote: Effect.fn("WorkflowRunRepository.setRunNote")(function* ({
          runId,
          teamIds,
          note,
        }: Domain.SetRunNoteCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (!Domain.runIsLive(run))
                yield* new RunTerminalError({ runId, status: run.status });
              yield* requireRunTeam(runId, teamIds);
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update WorkflowRun set note = ${note}, updatedAt = ${now}
                where id = ${runId}
              `;
            }),
          );
        }),

        blockRun: Effect.fn("WorkflowRunRepository.blockRun")(function* ({
          runId,
          actor,
          teamIds,
          reason,
        }: Domain.BlockRunCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* requireRun(runId);
              if (!Domain.runIsOpen(run))
                yield* new RunTerminalError({ runId, status: run.status });
              yield* requireReadyTeam(runId, teamIds);
              const now = yield* Clock.currentTimeMillis;
              const detail: Domain.RunFlagDetail =
                reason === null ? { by: actor } : { reason, by: actor };
              yield* sql`
                update WorkflowRun
                set flag = 'blocked', flagAt = ${now}, flagDetail = ${json(detail)}, updatedAt = ${now}
                where id = ${runId}
              `;
            }),
          );
        }),

        listOrderTeamIds: Effect.fn("WorkflowRunRepository.listOrderTeamIds")(
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
                  select r0.orderId from WorkflowRun r0
                  join WorkflowRunTask s0 on s0.runId = r0.id
                  where s0.id = ${input.runTaskId}
                `;
              return sql`select r0.orderId from WorkflowRun r0 where r0.id = ${input.runId}`;
            };
            const order = orderOf();
            const rows = yield* sql`
              select distinct rs.teamId as teamId
              from WorkflowRunTask rs
              join WorkflowRun r on r.id = rs.runId
              where rs.teamId is not null and r.orderId in (${order})
            `;
            return rows.flatMap((row) =>
              typeof row.teamId === "string" ? [row.teamId] : [],
            );
          },
        ),

        setBlockReason: Effect.fn("WorkflowRunRepository.setBlockReason")(
          function* ({ runId, teamIds, reason }: Domain.SetBlockReasonCommand) {
            // Transactional where `dismissFlag` is not: this one reads
            // `flagDetail` and writes it back, so an Unblock landing in
            // between would leave the cleared flag carrying a reason again.
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const run = yield* requireRun(runId);
                if (!Domain.runIsBlocked(run))
                  yield* new RunNotBlockedError({ runId });
                yield* requireReadyTeam(runId, teamIds);
                const now = yield* Clock.currentTimeMillis;
                // Spread and delete rather than rebuild: `by` is the fact this
                // write must not disturb, and `item` / `from` / `to` are not
                // this flag's but cost nothing to carry.
                const { reason: _dropped, ...rest } = run.flagDetail ?? {};
                const detail: Domain.RunFlagDetail =
                  reason === null ? rest : { ...rest, reason };
                yield* sql`
                  update WorkflowRun
                  set flagDetail = ${json(detail)}, updatedAt = ${now}
                  where id = ${run.id}
                `;
              }),
            );
          },
        ),

        dismissFlag: Effect.fn("WorkflowRunRepository.dismissFlag")(function* ({
          runId,
          teamIds,
        }: Domain.DismissFlagCommand) {
          const run = yield* requireRun(runId);
          yield* requireReadyTeam(runId, teamIds);
          const now = yield* Clock.currentTimeMillis;
          // A `done` run's quantity flag is cleared by accepting the units it
          // reported (`Domain.dismissAcceptsQuantity`); clearing alone would
          // have the next reconcile raise it again.
          yield* Domain.dismissAcceptsQuantity(run)
            ? sql`
              update WorkflowRun
              set flag = null, flagAt = null, flagDetail = null,
                  quantity = ${run.flagDetail.to}, updatedAt = ${now}
              where id = ${run.id}
            `
            : sql`
              update WorkflowRun
              set flag = null, flagAt = null, flagDetail = null, updatedAt = ${now}
              where id = ${run.id}
            `;
        }),

        assignRunTaskTeam: Effect.fn("WorkflowRunRepository.assignRunTaskTeam")(
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
                // The task first: on a done run every task is finished, and
                // "keeps its team" is the truer refusal than "run not open".
                if (task.completedAt !== null)
                  yield* new TaskFinishedError({ runTaskId });
                const run = yield* requireRun(task.runId);
                if (!Domain.runIsOpen(run))
                  yield* new RunTerminalError({
                    runId: run.id,
                    status: run.status,
                  });
                const now = yield* Clock.currentTimeMillis;
                yield* sql`
                  update WorkflowRunTask
                  set teamId = ${team.id}, teamName = ${team.name}
                  where id = ${runTaskId}
                `;
                yield* sql`update WorkflowRun set updatedAt = ${now} where id = ${task.runId}`;
              }),
            );
          },
        ),
      });
    }),
  );
}

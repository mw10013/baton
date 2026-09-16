import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";

import * as Domain from "@/lib/Domain";
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

/** The run is `done` or `cancelled` — or, for un-cancel, is not cancelled. */
export class RunTerminalError extends Schema.TaggedError<RunTerminalError>()(
  "RunTerminalError",
  { runId: Schema.String, status: Domain.RunStatus },
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

/** The step's team is not among the caller's teams. */
export class RunNotAllowedError extends Schema.TaggedError<RunNotAllowedError>()(
  "RunNotAllowedError",
  { runId: Schema.String, teamId: Schema.String },
) {}

/** A step in an earlier stage is still open, or this step is already completed — or, for undo, not yet completed. */
export class StepNotReadyError extends Schema.TaggedError<StepNotReadyError>()(
  "StepNotReadyError",
  { runStepId: Schema.String },
) {}

/**
 * `uncompleteStep` refused because someone downstream has already started:
 * a later stage of the same run. Names the step and team so the page can say
 * who to ask.
 */
export class StepUndoBlockedError extends Schema.TaggedError<StepUndoBlockedError>()(
  "StepUndoBlockedError",
  {
    runStepId: Schema.String,
    stepName: Domain.StepName,
    teamName: Domain.TeamName,
  },
) {}

/**
 * `assignRunStepTeam` on a completed step. Any *open* step reassigns,
 * started or not; a finished step is refused because the write would
 * overwrite `teamName`, the record of which team completed it.
 */
export class StepFinishedError extends Schema.TaggedError<StepFinishedError>()(
  "StepFinishedError",
  { runStepId: Schema.String },
) {}

/**
 * What `listQueue` returns: every ready step of the run the caller may act
 * on, with the run's last stage and each step's same-stage siblings owned by
 * other teams. Actor emails are on the row already.
 */
export interface QueueRow {
  readonly run: Domain.WorkflowRun;
  readonly steps: readonly (Domain.WorkflowRunStep & {
    readonly siblings: readonly {
      readonly name: Domain.StepName;
      readonly teamName: Domain.TeamName;
    }[];
  })[];
  readonly stageCount: number;
  readonly note: string | null;
}

export interface ReconcileCounts {
  /** Runs created by this pass. */
  readonly created: number;
  readonly cancelled: number;
  readonly flagged: number;
  /**
   * Line items this pass left **ambiguous**: two or more startable workflows
   * matched and no live run exists, so nothing was started and the merchant
   * has to choose. Not a fault — a count worth logging, and the number the
   * orders index turns into a stage.
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
  /** The live D1 roster: what a step's `teamId` must resolve against, and where `teamName` is snapshotted from. */
  readonly teams: readonly {
    readonly id: Domain.TeamId;
    readonly name: Domain.TeamName;
  }[];
}

/**
 * The definition-side half of whether a workflow starts a run (vocabulary on
 * `Domain.Workflow`): switched off, empty, or with an unassigned step
 * (`teamId` null, or an id the roster does not carry) all mean "starts
 * nothing". A team with no members does *not* block: the run is created and
 * its step waits in nobody's queue until someone joins. Shared by the tag
 * match on upsert and by manual attach — the latter skips the line-item half
 * (tags, quantity, fulfilment, age) but never this half. Drafts never reach
 * here: `WorkflowDetail` carries workflow steps only.
 */
export const canStart = (
  { workflow, steps }: Domain.WorkflowDetail,
  teams: StartContext["teams"],
) =>
  Domain.isActive(workflow) &&
  steps.length > 0 &&
  steps.every(
    (step) =>
      step.teamId !== null && teams.some((team) => team.id === step.teamId),
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
) => placedSince(detail.workflow, order) && matchesTags(detail, lineItem);

/** The date rule alone: placed on or after Turn on. Off never qualifies. */
export const placedSince = (
  workflow: Domain.Workflow,
  order: Pick<Domain.ShopOrder, "processedAt">,
) => workflow.activatedAt !== null && order.processedAt >= workflow.activatedAt;

/** The tag test alone, with units still to make; what the Turn on dialog's count uses, since it asks "would match if the date allowed". */
export const matchesTags = (
  { workflow }: Domain.WorkflowDetail,
  lineItem: Pick<Domain.OrderLineItem, "productTags" | "unfulfilledQuantity">,
) =>
  lineItem.unfulfilledQuantity > 0 &&
  lineItem.productTags.some((tag) => {
    const folded = tag.trim().toLowerCase();
    return workflow.tags.some((candidate) => candidate === folded);
  });

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

const isTerminal = (run: Domain.WorkflowRun) =>
  run.status === "done" || run.status === "cancelled";

/**
 * An {@link Domain.Actor} flattened into the three columns a step's actor slot
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
     * back rather than trusting the caller's view, so a merge under
     * `lineItemsComplete = false` still reconciles against what is actually
     * stored.
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
     * Bounded by the merchant's live floor, not the whole stored window.
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
     * displaces one; and an item that another *active* workflow's tags also
     * match, because that item would come out ambiguous and reconcile would
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
     *   `replaced`;
     * - a *cancelled* run for `(lineItemId, workflowId)` is un-cancelled
     *   rather than replaced by a fresh one. That is the existing recovery
     *   semantics of the run key, and it is what the merchant means: the
     *   steps already done on that earlier run come back with it.
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
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    readonly markOrderDeleted: (input: {
      readonly orderId: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
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
     * Only from `cancelled`; status is recomputed from the steps. Refused with
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
    /** One row per run with at least one ready step owned by `teamIds`; flagged runs first, then oldest. */
    readonly listQueue: (input: {
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      readonly QueueRow[],
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Steps owned by `teamIds` completed at or after `since`, newest first,
     * each with its run and the undo verdict ({@link undoBlockedBy}). The
     * team's, not the caller's: a colleague notices a mistake as readily as
     * its author. Cancelled runs are excluded — nothing there is undoable.
     */
    readonly listDone: (input: {
      readonly teamIds: readonly string[];
      readonly since: number;
      readonly limit: number;
    }) => Effect.Effect<
      readonly Domain.DoneItem[],
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Undo: clears the completed slot (all four columns) and recomputes the
     * run's status; a member's `startedAt` / `startedBy` stay, so the step
     * returns to "in progress" under its original starter, while a
     * merchant's started slot (only ever Done's backfill) is cleared so the
     * step is Ready for a worker to Start. `reopenedAt` /
     * `reopenedByRole` / `reopenedByEmail` record who sent it back. Allowed
     * for the step's team while nothing downstream has started
     * (`StepUndoBlockedError` otherwise, naming the blocker). A `done` run
     * is *not* terminal here — undoing its last step is the point — only a
     * cancelled one is.
     */
    readonly uncompleteStep: (
      input: Domain.UncompleteStepCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
      | StepNotReadyError
      | StepUndoBlockedError
    >;
    /**
     * The work page's read: the run with every step decorated by readiness
     * and the undo verdict, the order's live note and line items. `None`
     * when the run does not exist or no step of it belongs to `teamIds` —
     * one answer for both, so a member cannot probe run ids.
     */
    readonly getRunView: (input: {
      readonly runId: string;
      readonly teamIds: readonly string[];
    }) => Effect.Effect<
      Option.Option<Domain.RunView>,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Marks a ready step in progress. Idempotent: a second Start leaves the
     * original `startedAt` / `startedBy` / `startedByEmail` — no takeover, no
     * error — so two people pressing it does not rewrite who began. The
     * email is snapshotted so history reads after the member is deleted.
     */
    readonly startStep: (
      input: Domain.StartStepCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | StepNotReadyError
      | RunTerminalError
    >;
    /**
     * Also backfills the started slot with the same actor when Done arrives
     * without a Start, so every finished step records who. Clears the
     * `reopened` slot: that slot says "sent back and not yet redone", and a
     * Done is precisely the end of that. Nothing is created here.
     */
    readonly completeStep: (
      input: Domain.CompleteStepCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | StepNotReadyError
      | RunTerminalError
    >;
    /** No readiness requirement — a note on a done step is allowed — but the run must be non-terminal. `null` clears the note and its `noteByRole`. */
    readonly setStepNote: (
      input: Domain.SetStepNoteCommand,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunNotAllowedError
      | RunTerminalError
    >;
    /** Sets `flag = 'blocked'` with an optional reason and the actor, overwriting any prior flag. Allowed when a ready step belongs to `teamIds`. */
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
     * Every team that owns a step on any run of the order a given run (or run
     * step) belongs to.
     *
     * The scope is the *order*, not the run, because the merchant's order
     * page shows every run of the order: an action on one run restates the
     * page for every team working that order. A per-run answer would leave
     * those queues stale until they reloaded. `null` team ids are excluded —
     * an unassigned step is in nobody's queue.
     *
     * Used only to scope a `ShopAgent.publish` fan-out, so an over-broad
     * answer costs a redundant refetch and an under-broad one costs a stale
     * queue; the order boundary is the smallest scope where neither happens.
     */
    readonly listOrderTeamIds: (
      input: { readonly runStepId: string } | { readonly runId: string },
    ) => Effect.Effect<readonly string[], SqlError.SqlError>;
    /** Allowed when any ready step of the run belongs to one of `teamIds`, or unconditionally for the merchant (`teamIds` undefined). */
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
     * Points any *open* run step at `team`, snapshotting the name from the
     * live roster the caller resolved, and puts the step in that team's
     * queue. The team's existence is the caller's check (`Team` is a D1 row
     * this store cannot see). Allowed on any open step, assigned or not and
     * started or not — it is both the remedy that makes a team delete safe
     * and the merchant's way to move work between teams. Only `teamId` /
     * `teamName` are written, so a started step keeps `startedBy` /
     * `startedByEmail` and history still names whoever began it. A finished
     * step is refused (`StepFinishedError`).
     */
    readonly assignRunStepTeam: (input: {
      readonly runStepId: string;
      readonly team: {
        readonly id: Domain.TeamId;
        readonly name: Domain.TeamName;
      };
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | StepFinishedError
    >;
  }
>()("WorkflowRunRepository") {
  static readonly layer: Layer.Layer<
    WorkflowRunRepository,
    never,
    SqlClient.SqlClient
  > = Layer.effect(
    WorkflowRunRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

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
      const decodeSteps = decode(
        Schema.Array(Domain.WorkflowRunStep),
        "Invalid WorkflowRunStep row",
      );
      const decodeOrders = decode(
        Schema.Array(Domain.ShopOrder),
        "Invalid ShopOrder row",
      );
      const decodeLineItems = decode(
        Schema.Array(Domain.OrderLineItem),
        "Invalid OrderLineItem row",
      );
      const decodeQueueRuns = decode(
        Schema.Array(
          Schema.Struct({
            ...Domain.WorkflowRun.fields,
            note: Schema.NullOr(Schema.String),
            stageCount: Schema.Number,
          }),
        ),
        "Invalid queue row",
      );

      const orderColumns = sql.literal(
        `id, legacyId, name, processedAt, updatedAt, cancelledAt,
         closedAt, financialStatus, fulfillmentStatus, fullyPaid, tags, note,
         customAttributes, lineItemsComplete, syncedAt, syncSource`,
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

      const requireStep = (runStepId: string) =>
        sql`select * from WorkflowRunStep where id = ${runStepId}`.pipe(
          Effect.flatMap(decodeSteps),
          Effect.flatMap(([step]) =>
            step === undefined
              ? Effect.fail(new RunNotFoundError({ id: runStepId }))
              : Effect.succeed(step),
          ),
        );

      /** The predicate itself is in `readyWhere.ts`; the JSDoc there says why it does not live in this layer. */
      const readyWhere = (alias: string) =>
        sql.literal(ReadyWhere.readyWhere(alias));

      const readySteps = (runId: string) =>
        sql`
          select s.* from WorkflowRunStep s
          where s.runId = ${runId} and ${readyWhere("s")}
          order by s.position
        `.pipe(Effect.flatMap(decodeSteps));

      const isReady = (runStepId: string) =>
        sql`
          select 1 from WorkflowRunStep s
          where s.id = ${runStepId} and ${readyWhere("s")}
        `.pipe(Effect.map((rows) => rows.length > 0));

      /**
       * The guard every step action shares: step exists, run not terminal,
       * step's team among the caller's.
       *
       * `teamIds` undefined means the merchant, and then the team clause is
       * skipped whole — including the refusal for an unassigned step
       * (`teamId` null). That step is in nobody's queue and no worker can
       * reach it, which is exactly the situation the merchant is there to
       * fix; refusing them too would leave the run stuck with no way out.
       */
      const requireActionable = ({
        runStepId,
        teamIds,
      }: {
        readonly runStepId: string;
        readonly teamIds: readonly string[] | undefined;
      }) =>
        Effect.gen(function* () {
          const step = yield* requireStep(runStepId);
          const run = yield* requireRun(step.runId);
          if (isTerminal(run))
            yield* new RunTerminalError({ runId: run.id, status: run.status });
          // An unassigned step (`teamId` null) is in nobody's queue and
          // no *member* may act on it until a team is assigned.
          if (
            teamIds !== undefined &&
            (step.teamId === null || !teamIds.includes(step.teamId))
          )
            yield* new RunNotAllowedError({
              runId: run.id,
              teamId: step.teamId ?? "",
            });
          return { step, run };
        });

      /**
       * `RunNotAllowedError` unless some ready step of the run belongs to
       * `teamIds`. Undefined `teamIds` is the merchant and always passes, for
       * the reason on {@link requireActionable}.
       */
      const requireReadyTeam = (
        runId: string,
        teamIds: readonly string[] | undefined,
      ) =>
        teamIds === undefined
          ? Effect.void
          : readySteps(runId).pipe(
              Effect.flatMap((ready) =>
                ready.some(
                  (step) =>
                    step.teamId !== null && teamIds.includes(step.teamId),
                )
                  ? Effect.void
                  : Effect.fail(
                      new RunNotAllowedError({
                        runId,
                        teamId: ready[0]?.teamId ?? "",
                      }),
                    ),
              ),
            );

      const stepsForRuns = (runIds: readonly string[]) =>
        runIds.length === 0
          ? Effect.succeed([])
          : sql`
              select * from WorkflowRunStep
              where runId in (select value from json_each(${json(runIds)}))
              order by runId, position
            `.pipe(Effect.flatMap(decodeSteps));

      const withSteps = (runs: readonly Domain.WorkflowRun[]) =>
        Effect.gen(function* () {
          const steps = yield* stepsForRuns(runs.map((run) => run.id));
          return runs.map((run): Domain.WorkflowRunDetail => ({
            run,
            steps: steps.filter((step) => step.runId === run.id),
          }));
        });

      const RUN_STATUS_RANK: Record<Domain.RunStatus, number> = {
        pending: 0,
        active: 1,
        done: 2,
        cancelled: 3,
      };

      /** The less-finished of two item statuses; null means "no run", which never wins over a run. */
      const worstStatus = (
        a: Domain.RunStatus | null,
        b: Domain.RunStatus | null,
      ) => {
        if (a === null) return b;
        if (b === null) return a;
        return RUN_STATUS_RANK[a] <= RUN_STATUS_RANK[b] ? a : b;
      };

      /**
       * The live line items of the orders behind the runs on a work page,
       * each with the worst status across its non-cancelled runs
       * (`pending` < `active` < `done`) or null when no workflow touched
       * it. Read live rather than snapshotted so a late item shows on the
       * card as soon as reconcile stores it. `quantity` is `unfulfilledQuantity`
       * (`Domain.unitsToMake`) and fully refunded or shipped lines are dropped,
       * so a packer never packs a unit nobody will receive.
       */
      const orderItems = (orderIds: readonly string[]) =>
        orderIds.length === 0
          ? Effect.succeed([])
          : sql`
              select li.orderId, li.id as lineItemId, li.title, li.variantTitle,
                li.unfulfilledQuantity as quantity, li.customAttributes, r.status as runStatus
              from OrderLineItem li
              left join WorkflowRun r on r.lineItemId = li.id and r.status <> 'cancelled'
              where li.orderId in (select value from json_each(${json(orderIds)}))
                and li.unfulfilledQuantity > 0
              order by li.orderId, li.title
            `.pipe(
              Effect.flatMap(
                decode(
                  Schema.Array(
                    Schema.Struct({
                      ...Domain.QueueOrderItem.fields,
                      orderId: Schema.String,
                      customAttributes: Schema.fromJsonString(
                        Schema.Array(Domain.OrderAttribute),
                      ),
                    }),
                  ),
                  "Invalid queue order item row",
                ),
              ),
              Effect.map((rows) =>
                rows.reduce<
                  readonly (Domain.QueueOrderItem & {
                    readonly orderId: string;
                  })[]
                >((acc, row) => {
                  const previous = acc.find(
                    (item) => item.lineItemId === row.lineItemId,
                  );
                  if (previous === undefined) return [...acc, row];
                  const worst = worstStatus(row.runStatus, previous.runStatus);
                  return acc.map((item) =>
                    item === previous ? { ...item, runStatus: worst } : item,
                  );
                }, []),
              ),
            );

      /**
       * `status` is a function of the steps; recomputing it in SQL from the
       * same rows the step write just touched is what keeps the two in one
       * transaction with nothing to drift. A started step counts as `active`
       * on its own: "someone has started work" is exactly what should protect
       * a run from being silently cancelled by reconcile.
       */
      const recomputeStatus = (runId: string, now: number) =>
        sql`
          update WorkflowRun set
            status = (
              select case
                when count(*) = sum(completedAt is not null) then 'done'
                when sum(completedAt is not null) > 0 or sum(startedAt is not null) > 0 then 'active'
                else 'pending'
              end
              from WorkflowRunStep s where s.runId = WorkflowRun.id
            ),
            updatedAt = ${now}
          where id = ${runId}
        `;

      const cancelPending = (orderId: string, now: number) =>
        sql`
          update WorkflowRun
          set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
          where orderId = ${orderId} and status = 'pending'
          returning id
        `.pipe(Effect.map((rows) => rows.length));

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
       * `canStart` has already required every step's team to be in `teams`,
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
          workflow: { workflow, steps },
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
          yield* Effect.forEach(
            steps,
            (step) => sql`
              insert into WorkflowRunStep
                (id, runId, position, stage, name, teamId, teamName, instructions,
                 startedAt, startedBy, startedByEmail, completedAt, completedBy,
                 completedByEmail, note)
              values (
                ${crypto.randomUUID()}, ${runId}, ${step.position}, ${step.stage},
                ${step.name}, ${step.teamId},
                ${teams.find((team) => team.id === step.teamId)?.name ?? ""},
                ${step.instructions}, null, null, null, null, null, null, null
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
           * restored. `PARTIALLY_FULFILLED` never lands here: the shipped
           * line's `unfulfilledQuantity` is 0 and `adjust` handles it per
           * line.
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
          const inserted = orderCanStart
            ? yield* Effect.forEach(
                matches.flatMap(({ lineItem, matched, hasLive }) =>
                  hasLive || matched.length !== 1 || matched[0] === undefined
                    ? []
                    : [{ lineItem, workflow: matched[0] }],
                ),
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
              ).pipe(Effect.map((results) => results.filter(Option.isSome)))
            : [];
          const created = inserted.length;
          const openRuns = runs.filter((run) => !isTerminal(run));
          /**
           * Tracks `Domain.unitsToMake`, so a refund that zeroes or lowers
           * `unfulfilledQuantity` reads exactly like a removal or an edit.
           */
          const adjust = (run: Domain.WorkflowRun) => {
            const lineItem = lineItems.find(
              (item) => item.id === run.lineItemId,
            );
            if (lineItem === undefined || Domain.unitsToMake(lineItem) === 0)
              return run.status === "pending"
                ? sql`
                      update WorkflowRun
                      set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                      where id = ${run.id}
                    `.pipe(Effect.as({ cancelled: 1, flagged: 0 }))
                : flagActive(sql`id = ${run.id}`, "item_removed", {}, now).pipe(
                    Effect.map((flagged) => ({ cancelled: 0, flagged })),
                  );
            const units = Domain.unitsToMake(lineItem);
            if (units === run.quantity)
              return Effect.succeed({ cancelled: 0, flagged: 0 });
            return sql`
                update WorkflowRun
                set quantity = ${units}, updatedAt = ${now}
                where id = ${run.id}
              `.pipe(
              Effect.andThen(
                run.status === "pending"
                  ? Effect.succeed(0)
                  : flagActive(
                      sql`id = ${run.id}`,
                      "quantity_changed",
                      { from: run.quantity, to: units },
                      now,
                    ),
              ),
              Effect.map((flagged) => ({ cancelled: 0, flagged })),
            );
          };
          const adjusted = yield* Effect.all(openRuns.map(adjust));
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
          // The open orders' line items with no live run on them; the tag test
          // runs here because tags are JSON text.
          const rows = yield* decode(
            Schema.Array(
              Schema.Struct({
                orderId: Schema.String,
                processedAt: Schema.Number,
                unfulfilledQuantity: Schema.Number,
                productTags: Schema.fromJsonString(Schema.Array(Schema.String)),
              }),
            ),
            "Invalid waiting line item row",
          )(
            yield* sql`
              select li.orderId, o.processedAt, li.unfulfilledQuantity, li.productTags
              from OrderLineItem li
              join ShopOrder o on o.id = li.orderId
              where o.cancelledAt is null and o.fulfillmentStatus <> 'FULFILLED'
                and li.unfulfilledQuantity > 0
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
              matchesTags(workflow, row) &&
              !rivals.some((rival) => matchesTags(rival, row)),
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
                const live = existing.find((run) => run.status !== "cancelled");
                if (live?.workflowId === input.workflow.workflow.id)
                  return Option.none();
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
                    run.status === "cancelled" &&
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
                const inserted = yield* insertRun(input);
                return Option.isNone(inserted)
                  ? Option.none()
                  : Option.some({ run: inserted.value, replaced });
              }),
            ),
        ),

        markOrderDeleted: Effect.fn("WorkflowRunRepository.markOrderDeleted")(
          function* ({ orderId }: { readonly orderId: string }) {
            const now = yield* Clock.currentTimeMillis;
            yield* cancelPending(orderId, now);
            yield* flagActive(
              sql`orderId = ${orderId}`,
              "order_deleted",
              {},
              now,
            );
          },
        ),

        listRunsForOrder: Effect.fn("WorkflowRunRepository.listRunsForOrder")(
          function* ({ orderId }: { readonly orderId: string }) {
            return yield* withSteps(
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
          const [detail] = yield* withSteps([run.value]);
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
              if (run.status === "done" || run.status === "cancelled")
                yield* new RunTerminalError({ runId, status: run.status });
              const now = yield* Clock.currentTimeMillis;
              yield* sql`
                update WorkflowRun
                set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
                where id = ${runId}
              `;
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
              if (run.status !== "cancelled")
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
         * Two statements: every ready step of every run that has at least one
         * ready step for the caller's teams (so siblings owned by other teams
         * are in hand), then those runs with their last stage and the order's
         * live note. Grouping happens here in TypeScript; `json_each` keeps the
         * team list a single bound parameter.
         */
        listQueue: Effect.fn("WorkflowRunRepository.listQueue")(function* ({
          teamIds,
        }: {
          readonly teamIds: readonly string[];
        }) {
          if (teamIds.length === 0) return [];
          const ready = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowRunStep s
              join WorkflowRun r on r.id = s.runId
              where r.status in ('pending', 'active')
                and ${readyWhere("s")}
                and exists (
                  select 1 from WorkflowRunStep m
                  where m.runId = s.runId
                    and m.teamId in (select value from json_each(${json(teamIds)}))
                    and ${readyWhere("m")}
                )
              order by s.runId, s.position
            `,
          );
          if (ready.length === 0) return [];
          const runIds = [...new Set(ready.map((step) => step.runId))];
          const runs = yield* decodeQueueRuns(
            yield* sql`
              select r.*, o.note,
                (select max(stage) from WorkflowRunStep c where c.runId = r.id) as stageCount
              from WorkflowRun r
              left join ShopOrder o on o.id = r.orderId
              where r.id in (select value from json_each(${json(runIds)}))
              order by r.flag is null, r.createdAt, r.orderName, r.lineItemId
            `,
          );
          return runs.flatMap(({ note, stageCount, ...run }): QueueRow[] => {
            const ofRun = ready.filter((step) => step.runId === run.id);
            const mine = ofRun.filter(
              (step) => step.teamId !== null && teamIds.includes(step.teamId),
            );
            if (mine.length === 0) return [];
            return [
              {
                run,
                stageCount,
                note,
                steps: mine.map((step) => ({
                  ...step,
                  siblings: ofRun
                    .filter(
                      (other) =>
                        other.stage === step.stage &&
                        !mine.some((m) => m.id === other.id),
                    )
                    .map((other) => ({
                      name: other.name,
                      teamName: other.teamName,
                    })),
                })),
              },
            ];
          });
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
          if (teamIds.length === 0) return [];
          const done = yield* decodeSteps(
            yield* sql`
              select s.* from WorkflowRunStep s
              join WorkflowRun r on r.id = s.runId
              where s.completedAt >= ${since}
                and s.teamId in (select value from json_each(${json(teamIds)}))
                and r.status <> 'cancelled'
              order by s.completedAt desc, s.position desc
              limit ${limit}
            `,
          );
          if (done.length === 0) return [];
          const runIds = [...new Set(done.map((step) => step.runId))];
          const runs = yield* decodeRuns(
            yield* sql`
              select * from WorkflowRun
              where id in (select value from json_each(${json(runIds)}))
            `,
          );
          const steps = yield* stepsForRuns(runIds);
          return done.flatMap((step): Domain.DoneItem[] => {
            const run = runs.find((candidate) => candidate.id === step.runId);
            return run === undefined
              ? []
              : [
                  {
                    run,
                    step,
                    undoBlockedBy: Domain.undoBlockedBy(
                      step,
                      steps.filter((other) => other.runId === run.id),
                    ),
                  },
                ];
          });
        }),

        uncompleteStep: Effect.fn("WorkflowRunRepository.uncompleteStep")(
          function* ({
            runStepId,
            actor,
            teamIds,
          }: Domain.UncompleteStepCommand) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const step = yield* requireStep(runStepId);
                const run = yield* requireRun(step.runId);
                if (run.status === "cancelled")
                  yield* new RunTerminalError({
                    runId: run.id,
                    status: run.status,
                  });
                // The same team rule `requireActionable` applies, inline
                // because undo's terminal rule differs (a `done` run is
                // undoable): undefined `teamIds` is the merchant and skips it.
                if (
                  teamIds !== undefined &&
                  (step.teamId === null || !teamIds.includes(step.teamId))
                )
                  yield* new RunNotAllowedError({
                    runId: run.id,
                    teamId: step.teamId ?? "",
                  });
                if (step.completedAt === null)
                  yield* new StepNotReadyError({ runStepId });
                const blocker = Domain.undoBlockedBy(
                  step,
                  yield* stepsForRuns([run.id]),
                );
                if (blocker !== null)
                  yield* new StepUndoBlockedError({ runStepId, ...blocker });
                const now = yield* Clock.currentTimeMillis;
                const by = actorColumns(actor);
                // A merchant "start" is only ever the backfill Done writes
                // (there is no merchant Start), so keeping it would leave
                // the step "In progress by Merchant" with the worker's Start
                // hidden. Clear it and the step is plain Ready again; a
                // member's start is real work and stays.
                yield* sql`
                  update WorkflowRunStep
                  set completedAt = null, completedBy = null,
                      completedByEmail = null, completedByRole = null,
                      startedAt = case when startedByRole = 'merchant' then null else startedAt end,
                      startedByRole = case when startedByRole = 'merchant' then null else startedByRole end,
                      reopenedAt = ${now}, reopenedByRole = ${by.role},
                      reopenedByEmail = ${by.email}
                  where id = ${runStepId}
                `;
                yield* recomputeStatus(run.id, now);
              }),
            );
          },
        ),

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
          const steps = yield* stepsForRuns([run.id]);
          if (
            !steps.some(
              (step) => step.teamId !== null && teamIds.includes(step.teamId),
            )
          )
            return Option.none();
          const ready = yield* readySteps(run.id);
          const items = yield* orderItems([run.orderId]);
          const [noteRow] = yield* sql`
            select note from ShopOrder where id = ${run.orderId}
          `;
          return Option.some({
            run,
            steps: steps.map((step): Domain.RunStepView => ({
              ...step,
              ready: ready.some((candidate) => candidate.id === step.id),
              undoBlockedBy:
                step.completedAt === null
                  ? null
                  : Domain.undoBlockedBy(step, steps),
            })),
            note: typeof noteRow?.note === "string" ? noteRow.note : null,
            items: items.map(({ orderId: _orderId, ...item }) => item),
          } satisfies Domain.RunView);
        }),

        startStep: Effect.fn("WorkflowRunRepository.startStep")(function* ({
          runStepId,
          actor,
          teamIds,
        }: Domain.StartStepCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { run } = yield* requireActionable({ runStepId, teamIds });
              if (!(yield* isReady(runStepId)))
                yield* new StepNotReadyError({ runStepId });
              const now = yield* Clock.currentTimeMillis;
              const by = actorColumns(actor);
              yield* sql`
                update WorkflowRunStep
                set startedAt = coalesce(startedAt, ${now}),
                    startedBy = coalesce(startedBy, ${by.id}),
                    startedByEmail = coalesce(startedByEmail, ${by.email}),
                    startedByRole = coalesce(startedByRole, ${by.role})
                where id = ${runStepId}
              `;
              yield* recomputeStatus(run.id, now);
            }),
          );
        }),

        completeStep: Effect.fn("WorkflowRunRepository.completeStep")(
          function* ({
            runStepId,
            actor,
            teamIds,
          }: Domain.CompleteStepCommand) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const { run } = yield* requireActionable({
                  runStepId,
                  teamIds,
                });
                if (!(yield* isReady(runStepId)))
                  yield* new StepNotReadyError({ runStepId });
                const now = yield* Clock.currentTimeMillis;
                const by = actorColumns(actor);
                yield* sql`
                  update WorkflowRunStep
                  set completedAt = ${now}, completedBy = ${by.id},
                      completedByEmail = ${by.email},
                      completedByRole = ${by.role},
                      startedAt = coalesce(startedAt, ${now}),
                      startedBy = coalesce(startedBy, ${by.id}),
                      startedByEmail = coalesce(startedByEmail, ${by.email}),
                      startedByRole = coalesce(startedByRole, ${by.role}),
                      reopenedAt = null, reopenedByRole = null,
                      reopenedByEmail = null
                  where id = ${runStepId}
                `;
                yield* recomputeStatus(run.id, now);
              }),
            );
          },
        ),

        setStepNote: Effect.fn("WorkflowRunRepository.setStepNote")(function* ({
          runStepId,
          actor,
          teamIds,
          note,
        }: Domain.SetStepNoteCommand) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const { run } = yield* requireActionable({ runStepId, teamIds });
              const now = yield* Clock.currentTimeMillis;
              // Clearing the note clears its attribution with it: `Note
              // (Merchant):` beside no note would be a label for nothing.
              const noteByRole = note === null ? null : actor.role;
              yield* sql`
                update WorkflowRunStep
                set note = ${note}, noteByRole = ${noteByRole}
                where id = ${runStepId}
              `;
              yield* sql`update WorkflowRun set updatedAt = ${now} where id = ${run.id}`;
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
              if (isTerminal(run))
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
            input: { readonly runStepId: string } | { readonly runId: string },
          ) {
            const order =
              "runStepId" in input
                ? sql`
                    select r0.orderId from WorkflowRun r0
                    join WorkflowRunStep s0 on s0.runId = r0.id
                    where s0.id = ${input.runStepId}
                  `
                : sql`select r0.orderId from WorkflowRun r0 where r0.id = ${input.runId}`;
            const rows = yield* sql`
              select distinct rs.teamId as teamId
              from WorkflowRunStep rs
              join WorkflowRun r on r.id = rs.runId
              where rs.teamId is not null and r.orderId in (${order})
            `;
            return rows.flatMap((row) =>
              typeof row.teamId === "string" ? [row.teamId] : [],
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
          yield* sql`
              update WorkflowRun
              set flag = null, flagAt = null, flagDetail = null, updatedAt = ${now}
              where id = ${run.id}
            `;
        }),

        assignRunStepTeam: Effect.fn("WorkflowRunRepository.assignRunStepTeam")(
          function* ({
            runStepId,
            team,
          }: {
            readonly runStepId: string;
            readonly team: {
              readonly id: Domain.TeamId;
              readonly name: Domain.TeamName;
            };
          }) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const step = yield* requireStep(runStepId);
                if (step.completedAt !== null)
                  yield* new StepFinishedError({ runStepId });
                const now = yield* Clock.currentTimeMillis;
                yield* sql`
                  update WorkflowRunStep
                  set teamId = ${team.id}, teamName = ${team.name}
                  where id = ${runStepId}
                `;
                yield* sql`update WorkflowRun set updatedAt = ${now} where id = ${step.runId}`;
              }),
            );
          },
        ),
      });
    }),
  );
}

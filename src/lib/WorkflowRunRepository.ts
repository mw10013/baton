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
 * a later stage of the run, or the order run an item run's completion made
 * ready. Names the step and team so the page can say who to ask.
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
  readonly items: readonly Domain.QueueOrderItem[];
}

export interface ReconcileCounts {
  /** Item runs created by this pass. */
  readonly created: number;
  readonly cancelled: number;
  readonly flagged: number;
  /** Order runs created by this pass (0 or 1). */
  readonly orderRuns: number;
}

export interface ReconcileAllCounts {
  /** Open, paid orders the pass visited. */
  readonly orders: number;
  /** Item and order runs created, summed. */
  readonly created: number;
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
  workflow.type === "item" &&
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

/**
 * {@link Domain.undoBlockedBy} for a step of `run`, narrowing the order-run
 * steps to that run's own order — the reads hand back every order run in the
 * batch, and an item run can only be blocked by the packing of its own order.
 * An order run has nothing downstream of it, hence the empty list.
 *
 * Module scope, not a closure inside the service: it captures nothing, and
 * oxlint's `unicorn(consistent-function-scoping)` flags it there.
 */
const undoVerdict = (
  run: Domain.WorkflowRun,
  step: Domain.WorkflowRunStep,
  runSteps: readonly Domain.WorkflowRunStep[],
  orderRunSteps: readonly (Domain.WorkflowRunStep & {
    readonly orderId: string;
  })[],
) =>
  Domain.undoBlockedBy(
    step,
    runSteps,
    Domain.isOrderRun(run)
      ? []
      : orderRunSteps.filter((other) => other.orderId === run.orderId),
  );

const NO_COUNTS: ReconcileCounts = {
  created: 0,
  cancelled: 0,
  flagged: 0,
  orderRuns: 0,
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
     * cancelled) orders would match `workflow` if its date allowed them, paid
     * or not, and the placed date of the earliest. For an item workflow a
     * line item counts when its tags match and `(lineItemId, workflowId)`
     * has no run; for the order workflow an order counts when it has a
     * non-cancelled item run and no order run. Row cost: the open orders'
     * line items, once per dialog open.
     */
    readonly countWaitingOrders: (input: {
      readonly workflow: Domain.WorkflowDetail;
    }) => Effect.Effect<
      Domain.WaitingOrders,
      SqlError.SqlError | WorkflowRunRepositoryError
    >;
    /**
     * Manual attach of an item workflow. `None` when `(lineItemId,
     * workflowId)` already has a run in any status. A new item run flags any
     * open order run of the order `item_added`. With `orderWorkflow` (the
     * startable order workflow, or null), a successful attach also creates
     * the order run when the order has none: attach is the merchant's
     * opt-in, so the date rule does not apply to it.
     */
    readonly createRun: (input: {
      readonly workflow: Domain.WorkflowDetail;
      readonly orderWorkflow: Domain.WorkflowDetail | null;
      readonly teams: StartContext["teams"];
      readonly order: Domain.ShopOrder;
      readonly lineItem: Domain.OrderLineItem;
      readonly source: Domain.RunSource;
    }) => Effect.Effect<
      Option.Option<Domain.WorkflowRun>,
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
    /** Only from `cancelled`; status is recomputed from the steps. Un-cancelling an item run flags any open order run `item_added`. */
    readonly uncancelRun: (input: {
      readonly runId: string;
    }) => Effect.Effect<
      void,
      | SqlError.SqlError
      | WorkflowRunRepositoryError
      | RunNotFoundError
      | RunTerminalError
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
     * cancelled one is. The readiness query does the rest: an order run
     * that was ready stops being ready when an item step re-opens.
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
     * Done is precisely the end of that. Finishing the last item run on an
     * order makes the order run's first stage ready (`readyWhere`); nothing
     * is created here.
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
     * The scope is the *order*, not the run, because readiness crosses runs:
     * finishing the last item run makes the order run's first stage ready, and
     * that stage belongs to a different team than the one that just acted. A
     * per-run answer would leave the packing team's queue stale until they
     * reloaded. `null` team ids are excluded — an unassigned step is in
     * nobody's queue.
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
       * The live line items of the orders behind the order runs on a queue
       * page, each with the worst status across its non-cancelled runs
       * (`pending` < `active` < `done`) or null when no item workflow touched
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
       * The steps of the non-cancelled order run on each of `orderIds`, for
       * the undo rule on item runs. A cancelled order run is skipped: its
       * steps are nobody's and its key is kept only for un-cancel.
       */
      const orderRunStepsFor = (orderIds: readonly string[]) =>
        orderIds.length === 0
          ? Effect.succeed([])
          : sql`
              select s.*, r.orderId as orderId from WorkflowRunStep s
              join WorkflowRun r on r.id = s.runId
              where r.lineItemId is null and r.status <> 'cancelled'
                and r.orderId in (select value from json_each(${json(orderIds)}))
              order by s.runId, s.position
            `.pipe(
              Effect.flatMap(
                decode(
                  Schema.Array(
                    Schema.Struct({
                      ...Domain.WorkflowRunStep.fields,
                      orderId: Schema.String,
                    }),
                  ),
                  "Invalid order run step row",
                ),
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
       * Order runs only: flags `pending` as well as `active`. An item run that
       * is still pending is adjusted silently because no one has started it;
       * an order run's premise ("every item is made") is what changed, and
       * nothing silent can restore it, so the worker must see it either way.
       */
      const flagOpenOrderRuns = (
        orderId: string,
        flag: Domain.RunFlag,
        detail: Domain.RunFlagDetail,
        now: number,
      ) =>
        flagWhere(
          sql`status in ('pending', 'active')`,
          sql`orderId = ${orderId} and lineItemId is null`,
          flag,
          detail,
          now,
        );

      /**
       * `lineItem: null` writes an order run: the four line-item columns null
       * together, and the conflict target is the partial index
       * `WorkflowRun_order_uidx`, whose predicate the clause must repeat
       * verbatim for SQLite to pick it. `canStart` has already required every
       * step's team to be in `teams`, so the `teamName` lookup cannot miss.
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
          readonly lineItem: Domain.OrderLineItem | null;
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
                ${lineItem?.id ?? null}, ${lineItem?.title ?? null},
                ${lineItem?.variantTitle ?? null}, ${lineItem?.sku ?? null},
                ${lineItem === null ? null : Domain.unitsToMake(lineItem)},
                ${lineItem === null ? null : json(lineItem.customAttributes)},
                ${source}, 'pending', null, null, null, ${now}, ${now}, null
              )
              ${
                lineItem === null
                  ? sql`on conflict (orderId, workflowId) where lineItemId is null do nothing`
                  : sql`on conflict (lineItemId, workflowId) do nothing`
              }
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

      /**
       * A pending order run whose item runs all ended cancelled has no
       * premise left; cancel it silently, as reconcile does any pending run
       * whose work vanished. Requires at least one item run so a run created
       * by manual attach on a stock-only order is not cancelled before its
       * item run exists. An active order run keeps its flags instead.
       */
      const cancelOrphanedOrderRun = (orderId: string, now: number) =>
        sql`
          update WorkflowRun
          set status = 'cancelled', cancelledAt = ${now}, updatedAt = ${now}
          where orderId = ${orderId} and lineItemId is null and status = 'pending'
            and exists (
              select 1 from WorkflowRun i
              where i.orderId = ${orderId} and i.lineItemId is not null
            )
            and not exists (
              select 1 from WorkflowRun i
              where i.orderId = ${orderId} and i.lineItemId is not null
                and i.status <> 'cancelled'
            )
          returning id
        `.pipe(Effect.map((rows) => rows.length));

      const openOrders = sql`
        select id from ShopOrder
        where cancelledAt is null and fulfillmentStatus <> 'FULFILLED' and fullyPaid = 1
      `;

      /**
       * Two gates, deliberately split. `Domain.isCancelled` and
       * `Domain.isFulfilled` are the stop gates and return early;
       * `Domain.canStartRuns` (paid) gates only run *creation*, item and
       * order runs alike. Adjusting open runs against their line items and
       * flagging order runs happen whether or not the order is currently
       * paid, so an edit that pushes a paid order back to unpaid keeps its
       * runs, still tracks removals and quantity changes, and simply creates
       * nothing new until the balance lands — a payment wobble must never
       * cancel work in progress.
       *
       * The order run is created here, with the item runs: when the order
       * qualifies and has at least one non-cancelled item run (created now
       * or earlier) and the startable order workflow's date allows the
       * order, one order run is inserted, `pending`. Its steps wait on
       * `readyWhere`. `WorkflowRun_order_uidx` refuses a second, and a
       * cancelled one keeps its key, so recovery is un-cancel.
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
           * Nothing left to make or pack. Pending item runs go silently
           * (no one started them); active item runs and every open order
           * run are flagged because their premise cannot be restored.
           * `PARTIALLY_FULFILLED` never lands here: the shipped line's
           * `unfulfilledQuantity` is 0 and `adjust` handles it per line.
           */
          if (Domain.isFulfilled(order)) {
            yield* earlyExit("fulfilled");
            const cancelled = yield* cancelPending(orderId, now);
            const flaggedItems = yield* flagActive(
              sql`orderId = ${orderId} and lineItemId is not null`,
              "order_fulfilled",
              {},
              now,
            );
            const flaggedOrderRuns = yield* flagOpenOrderRuns(
              orderId,
              "order_fulfilled",
              {},
              now,
            );
            return {
              ...NO_COUNTS,
              cancelled,
              flagged: flaggedItems + flaggedOrderRuns,
            };
          }
          const orderCanStart = Domain.canStartRuns(order);
          const lineItems = yield* decodeLineItems(
            yield* sql`select * from OrderLineItem where orderId = ${orderId}`,
          );
          // Every non-cancelled run plus every order run: open item runs
          // are adjusted below, done item runs count as "has an item run"
          // for order-run creation, and a cancelled or done order run
          // still holds its key.
          const runs = yield* decodeRuns(
            yield* sql`
                select * from WorkflowRun
                where orderId = ${orderId}
                  and (status <> 'cancelled' or lineItemId is null)
              `,
          );
          const startable = workflows.filter((workflow) =>
            canStart(workflow, teams),
          );
          const inserted = orderCanStart
            ? yield* Effect.forEach(
                lineItems.flatMap((lineItem) =>
                  startable
                    .filter(
                      (workflow) =>
                        workflow.workflow.type === "item" &&
                        matchesLineItem(workflow, order, lineItem),
                    )
                    .map((workflow) => ({ workflow, lineItem })),
                ),
                ({ workflow, lineItem }) =>
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
          const orderWorkflow = startable.find(
            ({ workflow }) => workflow.type === "order",
          );
          const hasItemRun =
            created > 0 ||
            runs.some(
              (run) => run.lineItemId !== null && run.status !== "cancelled",
            );
          const hasOrderRun = runs.some((run) => run.lineItemId === null);
          const orderRun =
            orderWorkflow !== undefined &&
            orderCanStart &&
            hasItemRun &&
            !hasOrderRun &&
            placedSince(orderWorkflow.workflow, order)
              ? yield* insertRun({
                  workflow: orderWorkflow,
                  teams,
                  order,
                  lineItem: null,
                  source: "tag",
                })
              : Option.none();
          if (Option.isSome(orderRun))
            yield* Effect.logInfo(
              `WorkflowRunRepository.reconcileOrder: orderId=${orderId} workflowId=${orderRun.value.workflowId} runId=${orderRun.value.id}: order run created`,
            ).pipe(
              Effect.annotateLogs({
                orderId,
                workflowId: orderRun.value.workflowId,
                runId: orderRun.value.id,
              }),
            );
          const itemRuns = runs.filter(
            (run) => run.lineItemId !== null && !isTerminal(run),
          );
          const openOrderRuns = runs.filter(
            (run) => run.lineItemId === null && !isTerminal(run),
          );
          /**
           * Tracks `Domain.unitsToMake`, so a refund that zeroes or lowers
           * `unfulfilledQuantity` reads exactly like a removal or an edit.
           * `removed` names the item so the order run's flag can carry it.
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
                    `.pipe(
                    Effect.as({
                      cancelled: 1,
                      flagged: 0,
                      removed: null,
                    }),
                  )
                : flagActive(sql`id = ${run.id}`, "item_removed", {}, now).pipe(
                    Effect.map((flagged) => ({
                      cancelled: 0,
                      flagged,
                      removed: flagged > 0 ? run.lineItemTitle : null,
                    })),
                  );
            const units = Domain.unitsToMake(lineItem);
            if (units === run.quantity)
              return Effect.succeed({
                cancelled: 0,
                flagged: 0,
                removed: null,
              });
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
                      { from: run.quantity ?? 0, to: units },
                      now,
                    ),
              ),
              Effect.map((flagged) => ({
                cancelled: 0,
                flagged,
                removed: null,
              })),
            );
          };
          const adjusted = yield* Effect.all(itemRuns.map(adjust));
          // Order runs already open: a new item, or an item removed in this
          // pass, breaks "all items made". Removal wins when both happen,
          // because it is the one the worker cannot see from the items list.
          const addedItem = inserted[0]?.value.item ?? null;
          const removedItem =
            adjusted.find((delta) => delta.removed !== null)?.removed ?? null;
          const orderRunFlag = (():
            | readonly [Domain.RunFlag, string]
            | null => {
            if (openOrderRuns.length === 0) return null;
            if (removedItem !== null) return ["item_removed", removedItem];
            if (addedItem !== null) return ["item_added", addedItem];
            return null;
          })();
          const orderRunFlags =
            orderRunFlag === null
              ? 0
              : yield* flagOpenOrderRuns(
                  orderId,
                  orderRunFlag[0],
                  { item: orderRunFlag[1] },
                  now,
                );
          const orphaned = yield* cancelOrphanedOrderRun(orderId, now);
          return adjusted.reduce<ReconcileCounts>(
            (counts, delta) => ({
              ...counts,
              cancelled: counts.cancelled + delta.cancelled,
              flagged: counts.flagged + delta.flagged,
            }),
            {
              created,
              cancelled: orphaned,
              flagged: orderRunFlags,
              orderRuns: Option.isSome(orderRun) ? 1 : 0,
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
              created: counts.reduce(
                (sum, { created, orderRuns }) => sum + created + orderRuns,
                0,
              ),
            } satisfies ReconcileAllCounts;
          },
        ),

        countWaitingOrders: Effect.fn(
          "WorkflowRunRepository.countWaitingOrders",
        )(function* ({
          workflow,
        }: {
          readonly workflow: Domain.WorkflowDetail;
        }) {
          if (workflow.workflow.type === "order") {
            const rows = yield* decode(
              Schema.Array(Schema.Struct({ processedAt: Schema.Number })),
              "Invalid waiting order row",
            )(
              yield* sql`
                select o.processedAt from ShopOrder o
                where o.cancelledAt is null and o.fulfillmentStatus <> 'FULFILLED'
                  and exists (
                    select 1 from WorkflowRun i
                    where i.orderId = o.id and i.lineItemId is not null and i.status <> 'cancelled'
                  )
                  and not exists (
                    select 1 from WorkflowRun r
                    where r.orderId = o.id and r.lineItemId is null
                  )
              `,
            );
            return summarise(rows);
          }
          // The open orders' line items that this workflow has no run for
          // yet; the tag test runs here because tags are JSON text.
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
                  where r.lineItemId = li.id and r.workflowId = ${workflow.workflow.id}
                )
            `,
          );
          const matching = rows.filter((row) => matchesTags(workflow, row));
          const byOrder = [
            ...new Map(matching.map((row) => [row.orderId, row])).values(),
          ];
          return summarise(byOrder);
        }),

        /**
         * The item run first, then the `item_added` flag on any open order
         * run, then — when the order has no order run yet and the order
         * workflow can start — the order run itself, so a run created here
         * is never flagged for the item that caused it.
         */
        createRun: Effect.fn("WorkflowRunRepository.createRun")(function* ({
          orderWorkflow,
          ...input
        }: Parameters<typeof insertRun>[0] & {
          readonly orderWorkflow: Domain.WorkflowDetail | null;
          readonly lineItem: Domain.OrderLineItem;
        }) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* insertRun(input);
              if (Option.isNone(run)) return run;
              const now = yield* Clock.currentTimeMillis;
              yield* flagOpenOrderRuns(
                input.order.id,
                "item_added",
                { item: input.lineItem.title },
                now,
              );
              if (orderWorkflow !== null)
                yield* insertRun({
                  workflow: orderWorkflow,
                  teams: input.teams,
                  order: input.order,
                  lineItem: null,
                  source: "manual",
                });
              return run;
            }),
          );
        }),

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
                  order by lineItemId is null, lineItemId, createdAt
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
              const now = yield* Clock.currentTimeMillis;
              yield* sql`update WorkflowRun set cancelledAt = null where id = ${runId}`;
              yield* recomputeStatus(runId, now);
              if (!Domain.isOrderRun(run))
                yield* flagOpenOrderRuns(
                  run.orderId,
                  "item_added",
                  { item: run.lineItemTitle ?? "" },
                  now,
                );
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
          const orderIds = [
            ...new Set(
              runs
                .filter((run) => run.lineItemId === null)
                .map((run) => run.orderId),
            ),
          ];
          const items = yield* orderItems(orderIds);
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
                items:
                  run.lineItemId === null
                    ? items.filter((item) => item.orderId === run.orderId)
                    : [],
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
          const orderRunSteps = yield* orderRunStepsFor([
            ...new Set(
              runs
                .filter((run) => !Domain.isOrderRun(run))
                .map((run) => run.orderId),
            ),
          ]);
          return done.flatMap((step): Domain.DoneItem[] => {
            const run = runs.find((candidate) => candidate.id === step.runId);
            return run === undefined
              ? []
              : [
                  {
                    run,
                    step,
                    undoBlockedBy: undoVerdict(
                      run,
                      step,
                      steps.filter((other) => other.runId === run.id),
                      orderRunSteps,
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
                const blocker = undoVerdict(
                  run,
                  step,
                  yield* stepsForRuns([run.id]),
                  yield* orderRunStepsFor([run.orderId]),
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
          const orderRunSteps = yield* orderRunStepsFor([run.orderId]);
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
                  : undoVerdict(run, step, steps, orderRunSteps),
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

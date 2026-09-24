import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { RunSteps } from "@/components/RunSteps";
import { BlockModal, RunNoteModal } from "@/components/RunTextModals";
import * as Domain from "@/lib/Domain";
import { formatNumber, formatStatus } from "@/lib/format";
import { adminOrderUrl, useResourceLinkTarget } from "@/lib/orderLinks";
import { hideModal, showModal } from "@/lib/polarisModal";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { errorMessage } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

const orderQueryKey = (shop: string, legacyId: string) =>
  ["order", shop, legacyId] as const;

/** See the note on `decodeOrdersView` in `app.orders.index.tsx`. */
const decodeDetail = Schema.decodeUnknownPromise(
  Schema.toType(Schema.NullOr(Domain.OrderDetailView)),
);
const decodeAttachResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.AttachResult),
);
const decodeRunResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.RunResult),
);
const decodeAssignResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.AssignRunTaskTeamResult),
);

const connecting = () =>
  Promise.reject(new Error("Still connecting. Try again in a moment."));

const attachResultMessage = Match.typeTags<
  Domain.AttachResult,
  string | null
>()({
  Ok: () => null,
  AlreadyExists: () => "That workflow is already running on this item.",
  LineItemNotFound: () => "That line item no longer exists.",
  WorkflowCannotStart: () =>
    "That workflow cannot start: it is off, has no tasks, or has an unassigned task.",
  RunLimit: ({ limit }) =>
    `Baton is already running ${formatNumber(limit)} workflows. Finish or cancel some before starting another.`,
  /* The page offers no change on a done run (`changeable`); this is the
     race where the run finished between the render and the click. */
  ItemDone: ({ workflowName }) =>
    `This item is finished on ${workflowName}. Reopen its last task to change it.`,
  OrderClosed: () =>
    "This order is cancelled or fulfilled in Shopify, so there is no work left to attach.",
});

const assignResultMessage = Match.typeTags<
  Domain.AssignRunTaskTeamResult,
  string | null
>()({
  Assigned: () => null,
  NotFound: () => "That task no longer exists.",
  TeamNotFound: () => "That team no longer exists. Choose another.",
  TaskFinished: () => "That task is already done and keeps its team.",
  RunNotOpen: () => "That workflow run is finished or cancelled.",
});

const runResultMessage = Match.typeTags<Domain.RunResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow run no longer exists.",
  NotAllowed: () => "Not allowed.",
  /* The reason editor, when a worker unblocked the run while it was open. */
  NotBlocked: () => "That workflow run is no longer blocked.",
  /* Also Put back on a task a worker finished or put back just now. */
  NotReady: () =>
    "That task changed just now, or a task in an earlier step is still open.",
  /* Every merchant control on a done run is the note or Reopen, and both are
     allowed there (`Domain.RunStatus`); the page offers nothing on a
     cancelled run but Undo cancel. So a Terminal here is a cancel that landed
     between the render and the click. */
  Terminal: () => "That workflow run was cancelled.",
  /* Mark done is hidden while a run is flagged; a flag that landed after the
     render is the only way here. */
  Flagged: ({ flag }) =>
    Domain.flagIsReconcile(flag)
      ? "That workflow run was flagged just now. Dismiss the flag first."
      : "That workflow run is blocked. Unblock it first.",
  // Reachable from Manage's Reopen: the row hides that button when the page's
  // own `Domain.undoBlockedBy` says so, and this is the race where a worker
  // started downstream between the render and the click.
  UndoBlocked: ({ teamName, taskName }) =>
    `${teamName} already started ${taskName}.`,
  ItemHasRun: ({ workflowName }) =>
    `This item is already on ${workflowName}. Cancel that run first to bring this one back.`,
});

/**
 * One merchant intervention, as the Manage rows send it. `kind` picks the
 * callable and `toast` is the acknowledgement, written at the button so the
 * task's own name reaches it ("Cut marked done") rather than a generic verb.
 * Cancel and un-cancel ride the same union deliberately: one in-flight
 * mutation on the page means one `busy` flag, and the merchant cannot start a
 * second write while the first is unacknowledged.
 */
type Intervention =
  | {
      readonly kind: "complete";
      readonly runTaskId: string;
      readonly toast: string;
    }
  | {
      readonly kind: "reopen";
      readonly runTaskId: string;
      readonly toast: string;
    }
  | {
      readonly kind: "putBack";
      readonly runTaskId: string;
      readonly toast: string;
    }
  | {
      readonly kind: "note";
      readonly runId: string;
      readonly note: string | null;
      readonly toast: string;
    }
  | {
      readonly kind: "block";
      readonly runId: string;
      readonly reason: string | null;
      readonly toast: string;
    }
  | {
      readonly kind: "blockReason";
      readonly runId: string;
      readonly reason: string | null;
      readonly toast: string;
    }
  | { readonly kind: "unblock"; readonly runId: string; readonly toast: string }
  | { readonly kind: "cancel"; readonly runId: string; readonly toast: string }
  | {
      readonly kind: "uncancel";
      readonly runId: string;
      readonly toast: string;
    };

/** Merchant words, not `WorkflowRun.status`: "pending" reads as "waiting for approval". */
const RUN_STATUS_BADGE = {
  pending: { label: "Not started", tone: "neutral" },
  active: { label: "In progress", tone: "info" },
  done: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "critical" },
} as const satisfies Record<Domain.RunStatus, { label: string; tone: string }>;

const RUN_FLAG_LABEL = {
  item_removed: "Item removed",
  quantity_changed: "Quantity changed",
  order_cancelled: "Order cancelled",
  blocked: "Blocked",
  order_fulfilled: "Already shipped in Shopify",
} as const satisfies Record<Domain.RunFlag, string>;

/** The one confirmation on this page: replacing a live run that has work on it. */
const CHANGE_WORKFLOW_MODAL = "change-workflow";
const NOTE_MODAL = "run-note";
const BLOCK_MODAL = "run-block";

/**
 * The ambiguous item's sentence: why the merchant is being asked, and nothing
 * that can drift from the select under it. It does not count the matches,
 * because a count that must agree with a list is a second source of truth; it
 * does not name the tags, because the merchant changes the workflow here, not
 * the product.
 */
const AMBIGUITY_SENTENCE =
  "More than one workflow matches this item, so none was started.";

/**
 * The confirmation body. Done outranks started because it is the bigger loss:
 * a finished task is work someone will have to do again under the new
 * workflow, while a started one is work in progress. Tasks do not carry over —
 * the new run is copied from its own definition — so the sentence says so
 * rather than leaving the merchant to assume otherwise.
 *
 * Counts steps, not task rows: a step is done when every task of it is and
 * started when any task of it is, and the total is the run's last step. The
 * merchant reads "task" only where a step holds more than one
 * ({@link Domain.WorkflowTask}), so a row count would name a noun a linear
 * shop never sees.
 */
const changeWarning = (
  from: Domain.WorkflowName,
  to: string,
  tasks: readonly Domain.WorkflowRunTask[],
) => {
  const steps = WorkflowLayout.stepsOf(tasks);
  const done = steps.filter((step) =>
    step.every((task) => task.completedAt !== null),
  ).length;
  const started = steps.filter((step) =>
    step.some((task) => task.startedAt !== null),
  ).length;
  const total = formatNumber(steps.length);
  const progress =
    done > 0
      ? `${formatNumber(done)} of ${total} steps done`
      : `${formatNumber(started)} of ${total} steps started`;
  return `${from} has ${progress}. Change to ${to} anyway? That work will not carry over.`;
};

/**
 * A flag as a badge: a closed vocabulary plus, where the flag names a thing,
 * that thing. `blocked` is deliberately absent from the second branch — its
 * reason is merchant prose up to `Domain.BLOCK_REASON_MAX_LENGTH` characters, and a
 * badge sized for one word stretches the row until the run's own controls
 * leave the viewport. The reason renders in `blockedStrip` instead.
 */
const flagLabel = (run: Domain.WorkflowRun) => {
  if (run.flag === null) return null;
  if (Domain.flagIsReconcile(run.flag) && run.flagDetail?.item !== undefined)
    return `${RUN_FLAG_LABEL[run.flag]}: ${run.flagDetail.item}`;
  return RUN_FLAG_LABEL[run.flag];
};

const lineItemTitle = ({ title, variantTitle }: Domain.OrderLineItem) =>
  variantTitle === null ? title : `${title} — ${variantTitle}`;

/**
 * One row of the facts grid, as a `label | value` pair filling the grid's two
 * columns. Empty facts return nothing rather than an em dash: a column of
 * placeholder dashes is noise that pushes the facts that do exist off screen.
 */
const fact = (label: string, value: React.ReactNode) =>
  value === null || value === undefined || value === "" ? null : (
    <React.Fragment key={label}>
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </React.Fragment>
  );

/**
 * Who blocked the run and when. Attribution only: the reason is merchant prose
 * and renders as its own wrapping paragraph in `blockedStrip`, so repeating it
 * here would print the same 1000 characters twice on one card.
 */
const blockedLine = (run: Domain.WorkflowRun): React.ReactNode => {
  const by = run.flagDetail?.by;
  return (
    <>
      {by === undefined
        ? "Blocked · "
        : `Blocked by ${Domain.actorLabel(by)} · `}
      <LocalDateTime value={run.flagAt ?? 0} format="time" />
    </>
  );
};

const stepCount = (tasks: readonly Domain.WorkflowRunTask[]) =>
  tasks.reduce((max, task) => Math.max(max, task.step), 0);

/**
 * A run's blocked state as a wrapping block rather than a badge. The reason is
 * merchant prose up to `Domain.BLOCK_REASON_MAX_LENGTH` characters; a badge is sized for
 * a closed vocabulary and a long reason there stretches the row until the run's
 * own controls leave the viewport. The ready task is named because `blocked` is
 * a run-level flag (`merchantBlockRun` takes a `runId`) and on a multi-step run
 * "blocked" alone does not say what is stuck.
 *
 * `actions` (Edit, which opens the Block modal on the reason, and Unblock)
 * arrive as a node rather than a callback because the buttons need the page's
 * `identified`, `busy` and mutation, none of which belong to a module-level
 * render helper — the same shape `taskTrail` uses for its picker. Unblock is
 * offered here as well as inside Manage: a merchant who opened the disclosure
 * should not have to close it to unblock.
 */
const blockedStrip = (
  { run, tasks }: Domain.WorkflowRunDetail,
  actions: React.ReactNode,
) => {
  const stuck = Domain.readyTasks(run, tasks)
    .map((task) => task.name)
    .join(", ");
  const reason = run.flagDetail?.reason;
  return (
    <s-box
      background="subdued"
      borderWidth="base"
      borderRadius="base"
      padding="small"
    >
      <s-stack gap="small-300">
        <s-text type="strong">
          {stuck === "" ? "Blocked" : `Blocked \u00B7 ${stuck}`}
        </s-text>
        {reason !== undefined && <s-paragraph>{reason}</s-paragraph>}
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text color="subdued">{blockedLine(run)}</s-text>
          {actions}
        </s-stack>
      </s-stack>
    </s-box>
  );
};

/**
 * Where the run is, as the card's one read-only answer: `Step 1 of 3 · Cut ·
 * since 3:10 PM`. Position and task names only: the team is inside Manage, on
 * its own line under the task, where a 64-character team name has room. It
 * replaced the inline task trail, which said the same thing in a notation the
 * merchant had to learn — a step number, bold for ready, `✓` and `●` marks,
 * the team in parentheses.
 *
 * Deliberately a second phrasing beside {@link RunSteps}, not a call into it.
 * That one describes *each task* inside the Manage disclosure, in the work
 * page's vocabulary, so the merchant and the worker say the same thing about
 * the same task. This one describes *the run* on a collapsed card and has to
 * cover a parallel step (several ready tasks at once), which is not a task
 * state. Keeping them apart is cheaper than a shared function with a mode flag.
 */
const nowLine = ({ run, tasks }: Domain.WorkflowRunDetail): React.ReactNode => {
  if (!Domain.runIsLive(run)) return null;
  /* The strip above already names the stuck task; a Now line under it would
     name the same task a second time on one card. */
  if (Domain.runIsBlocked(run)) return null;
  /* Counts steps, like the open form's `of M`: the number the merchant saw
     climb to `Step 2 of 2` must not become `3 steps` the day the run finishes. */
  if (!Domain.runIsOpen(run)) {
    const steps = stepCount(tasks);
    return `Done \u00B7 ${formatNumber(steps)} step${steps === 1 ? "" : "s"}`;
  }
  const ready = Domain.readyTasks(run, tasks);
  const lowest = Domain.lowestOpenStep(tasks);
  /* Every remaining task unassigned, or an inconsistent run: the attention
     rows below are the answer, not a position. */
  if (ready.length === 0 || lowest === null) return null;
  const names = ready.map((task) => task.name).join(", ");
  /** The step's start, not a task's: on a parallel step the earliest claim is when the run got here. */
  const since = ready.reduce<number | null>((earliest, task) => {
    if (task.startedAt === null) return earliest;
    return earliest === null
      ? task.startedAt
      : Math.min(earliest, task.startedAt);
  }, null);
  return (
    <>
      {`Step ${String(lowest)} of ${String(stepCount(tasks))} \u00B7 ${names}`}
      {since !== null && (
        <>
          {" \u00B7 since "}
          <LocalDateTime value={since} format="time" />
        </>
      )}
    </>
  );
};

/**
 * The two derived attention states of a run, against the live team roster the
 * view carries: an open task whose team is gone is named with an "Assign team"
 * picker (the remedy that makes a team delete safe), and a ready task on a
 * team with no members warns, linking to the team so the fix is one click.
 *
 * They render on the card, outside the Manage disclosure, because they are the
 * one thing that must be acted on and a disclosure would hide it. Every other
 * intervention — reassigning an already-assigned task, notes, block, cancel —
 * is inside Manage: one place to act on a run rather than two, and nothing on
 * the card is a click target, so scanning an order never risks a stray "done".
 */
const attentionRows = (
  { run, tasks }: Domain.WorkflowRunDetail,
  teams: readonly Domain.TeamRoster[],
  assign: (runTaskId: string) => React.ReactNode,
) => {
  const ready = Domain.readyTasks(run, tasks);
  const isReady = (task: Domain.WorkflowRunTask) =>
    ready.some((candidate) => candidate.id === task.id);
  const open = Domain.runIsOpen(run);
  const unassigned = open
    ? tasks.filter((task) => Domain.isRunTaskUnassigned(task, teams))
    : [];
  /** The roster row, not the snapshot name, so the warning can link to the team page. */
  const emptyTeams = open
    ? [
        ...new Map(
          tasks.filter(isReady).flatMap((task) => {
            const team = teams.find(
              (candidate) =>
                candidate.id === task.teamId && candidate.memberCount === 0,
            );
            return team === undefined ? [] : [[team.id, team] as const];
          }),
        ).values(),
      ]
    : [];
  if (unassigned.length === 0 && emptyTeams.length === 0) return null;
  return (
    <s-stack gap="small-500">
      {unassigned.map((task) => (
        <s-stack
          key={task.id}
          direction="inline"
          gap="small-300"
          alignItems="center"
        >
          <s-text type="strong">{`${task.name}: assign a team.`}</s-text>
          {assign(task.id)}
        </s-stack>
      ))}
      {emptyTeams.length > 0 && (
        <s-paragraph color="subdued">
          {"No members on "}
          {emptyTeams.map((team, index) => (
            <React.Fragment key={team.id}>
              {index > 0 && ", "}
              <s-link href={`/app/teams/${team.id}`}>{team.name}</s-link>
            </React.Fragment>
          ))}
          . Nobody can work this until someone joins, or you assign another
          team.
        </s-paragraph>
      )}
    </s-stack>
  );
};

const OrderParams = Schema.Struct({ legacyId: Schema.String });

/** The loader half of the subscribed page; see the index's `getLoaderData`. */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(OrderParams))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      ShopAgentClient.pipe(
        Effect.flatMap((client) => client.getOrderDetail(session.shop, data)),
      ),
    ),
  );

export const Route = createFileRoute("/app/orders/$orderId")({
  loader: ({ params }) => getLoaderData({ data: { legacyId: params.orderId } }),
  component: RouteComponent,
});

/**
 * One order: its note, every line item with its properties and workflow
 * runs, and the order's facts. Subscribed like the index: the loader paints,
 * `useSubscribedQuery` reads through `ShopAgent.subscribeOrder` — which subscribes the
 * shared `/app` connection to this order's pushes — so a webhook, resync, or
 * member task action on this order repaints the page. Every write returns a
 * tagged result that is copy-mapped into the banner rather than thrown.
 *
 * The `$orderId` param is the Shopify legacy id, so the URL matches the one
 * the admin uses for the same order (`Domain.GetOrderDetailInput`).
 */
function RouteComponent() {
  const { shop } = Route.useRouteContext();
  const { orderId: legacyId } = Route.useParams();
  const queryClient = useQueryClient();
  const shopify = useAppBridge();
  const loaderData = Route.useLoaderData();
  const resourceLinkTarget = useResourceLinkTarget();
  const [banner, setBanner] = React.useState<string | null>(null);
  const [attachChoice, setAttachChoice] = React.useState<
    Record<string, string>
  >({});
  /** The "Assign team" picker's choice per open run task. */
  const [assignChoice, setAssignChoice] = React.useState<
    Record<string, string>
  >({});
  /** The run task whose Manage row has its team picker open after Reassign; see `assignTeam`. */
  const [reassigning, setReassigning] = React.useState<string | null>(null);
  /**
   * Which live runs have their "Change workflow" picker open inside Manage;
   * closed is the default. Changing cancels the run that is there and does not
   * carry its tasks over, so it is a rare intervention and lives with the
   * others rather than at rest on the card. An item with no run needs no entry
   * here: its picker *is* the row, always open.
   *
   * Keyed by run id and read through `changingRun` for the same reason as
   * `managing`: a change replaces the run, and the id of the one that was
   * cancelled must not answer for the one that took its place.
   */
  const [changeOpen, setChangeOpen] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  /**
   * What the Change confirmation is about, or null when it is closed. The
   * modal is one element at page level rather than one per item, so the click
   * that opens it has to say which item and which workflow it meant.
   */
  const [changing, setChanging] = React.useState<{
    readonly lineItemId: string;
    readonly workflowId: string;
    readonly from: Domain.WorkflowName;
    readonly to: string;
    readonly warning: string;
  } | null>(null);
  /**
   * Which runs have their "Manage" disclosure open; closed is the default.
   *
   * It survives re-renders on purpose, and the next reader's instinct will be to
   * reset it when new data arrives — do not. The subscription updates the query
   * data without remounting, so a webhook or a worker's task action landing
   * while the merchant has a disclosure open must leave it open. What it must
   * not do is answer for a run that is no longer on this order, so reads go
   * through `managingRun` against the runs actually in hand.
   */
  const [managing, setManaging] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  /**
   * The run the Note and Block modals are about. Each modal is one element at
   * page level, as the Change confirmation is, so the click that opens one
   * has to say which run it meant.
   */
  const [modalRunId, setModalRunId] = React.useState<string | null>(null);

  const {
    data: detail,
    query: detailQuery,
    invalidate: invalidateDetail,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: orderQueryKey(shop, legacyId),
    subscribe: (stub, subscriberId) =>
      stub.subscribeOrder({ legacyId, subscriberId }).then(decodeDetail),
    initialData: loaderData,
  });

  /** Own writes also touch the index's aggregate, whose key is a prefix match. */
  const invalidate = () =>
    Promise.all([
      invalidateDetail(),
      queryClient.invalidateQueries({ queryKey: ["orders", shop] }),
    ]);

  const call = <A,>(
    op: (stub: NonNullable<typeof agent>["stub"]) => Promise<A>,
  ) => (agent ? withSocketRecovery(agent)(() => op(agent.stub)) : connecting());

  const onError = (error: Error) => {
    setBanner(error.message);
  };

  const attachMutation = useMutation({
    mutationFn: (input: typeof Domain.AttachWorkflowInput.Encoded) =>
      call((stub) => stub.attachWorkflow(input)).then(decodeAttachResult),
    onSuccess: async (result, { lineItemId }) => {
      setBanner(attachResultMessage(result));
      if (result._tag === "Ok") {
        /* The change picker is a disclosure, so a successful change must close
           it: left open, Manage would show the new run's actions and, under
           them, a still-enabled Change for the workflow just chosen. */
        if (result.replaced !== null) {
          const replacedId = result.replaced.id;
          setChangeOpen((current) => {
            const next = new Set(current);
            next.delete(replacedId);
            return next;
          });
        }
        setAttachChoice((current) => {
          const { [lineItemId]: _done, ...rest } = current;
          return rest;
        });
        setChanging(null);
        hideModal(CHANGE_WORKFLOW_MODAL);
        /* A replace is two facts — what started and what stopped — and the
           cancelled run's card stays on the page, so the toast is where the
           merchant learns the second one was theirs to expect. */
        if (result.replaced !== null)
          shopify.toast.show(
            `Changed to ${result.run.workflowName}. ${result.replaced.workflowName} was cancelled.`,
          );
      }
      await invalidate();
    },
    onError,
  });

  /**
   * Every merchant write against a run, through one mutation: the
   * `merchant*` callables plus cancel and un-cancel, which the header used to
   * send on their own. A refused write raises no banner — the row should not
   * have offered it, so the honest answer is the toast plus the re-render the
   * subscription brings, exactly as the worker's page behaves.
   */
  const interveneMutation = useMutation({
    mutationFn: (input: Intervention) =>
      call((stub) =>
        Match.value(input).pipe(
          Match.discriminatorsExhaustive("kind")({
            complete: ({ runTaskId }) =>
              stub.merchantCompleteTask({ runTaskId }),
            reopen: ({ runTaskId }) =>
              stub.merchantUncompleteTask({ runTaskId }),
            putBack: ({ runTaskId }) => stub.merchantUnstartTask({ runTaskId }),
            note: ({ runId, note }) => stub.merchantSetRunNote({ runId, note }),
            block: ({ runId, reason }) =>
              stub.merchantBlockRun({ runId, reason }),
            blockReason: ({ runId, reason }) =>
              stub.merchantSetBlockReason({ runId, reason }),
            unblock: ({ runId }) => stub.merchantDismissFlag({ runId }),
            cancel: ({ runId }) => stub.cancelRun({ runId }),
            uncancel: ({ runId }) => stub.uncancelRun({ runId }),
          }),
        ),
      ).then(decodeRunResult),
    onSuccess: async (result, input) => {
      if (result._tag === "Ok") shopify.toast.show(input.toast);
      else
        shopify.toast.show(runResultMessage(result) ?? "Nothing changed.", {
          isError: true,
        });
      await invalidate();
    },
    onError,
  });

  const assignMutation = useMutation({
    mutationFn: (input: typeof Domain.AssignRunTaskTeamInput.Encoded) =>
      call((stub) => stub.assignRunTaskTeam(input)).then(decodeAssignResult),
    onSuccess: async (result) => {
      setBanner(assignResultMessage(result));
      if (result._tag === "Assigned") setReassigning(null);
      await invalidate();
    },
    onError,
  });

  const resyncMutation = useMutation({
    mutationFn: (orderId: string) =>
      call((stub) => stub.resyncOrder({ orderId })),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => {
      shopify.toast.show(error.message, { isError: true });
    },
  });

  if (detailQuery.isError)
    return (
      <s-page heading="Order">
        <s-link slot="breadcrumb-actions" href="/app/orders">
          Orders
        </s-link>
        <s-banner tone="critical">
          {detailQuery.error instanceof Error
            ? detailQuery.error.message
            : "Could not load the order."}
        </s-banner>
      </s-page>
    );
  if (detail === null)
    return (
      <s-page heading="Order not found">
        <s-link slot="breadcrumb-actions" href="/app/orders">
          Orders
        </s-link>
        <s-paragraph color="subdued">
          That order is not stored here. It may be outside the sync window, or
          it may have been deleted in Shopify.
        </s-paragraph>
      </s-page>
    );

  const { order, lineItems, runs, itemWorkflows, teams } = detail;
  /**
   * The same aggregate the index computes in SQL, rebuilt from the run list
   * this page already carries so both pages read one `productionState`.
   * Only the `ready_to_ship` banner reads it: every other state here is per
   * item, and the cards carry it.
   */
  const state = Domain.productionState({
    order,
    runs: Domain.runCounts(runs.map(({ run }) => run)),
  });
  /** See `managing`: an id with no run on this order is stale and answers `false`. */
  const managingRun = (run: Domain.WorkflowRun) =>
    managing.has(run.id) && runs.some((other) => other.run.id === run.id);
  /** See `changeOpen`: same read-through guard, for the same reason. */
  const changingRun = (run: Domain.WorkflowRun) =>
    changeOpen.has(run.id) && runs.some((other) => other.run.id === run.id);
  const busy =
    attachMutation.isPending ||
    interveneMutation.isPending ||
    assignMutation.isPending;
  const intervene = (input: Intervention) => {
    interveneMutation.mutate(input);
  };
  /** A modal's write: `null` closes it, a message stays under its field. */
  const interveneFromModal = (input: Intervention) =>
    interveneMutation
      .mutateAsync(input)
      .then((result) =>
        result._tag === "Ok"
          ? null
          : (runResultMessage(result) ?? "Nothing changed."),
      )
      .catch(errorMessage);
  const openModal = (modalId: string, run: Domain.WorkflowRun) => {
    setModalRunId(run.id);
    showModal(modalId);
  };
  const modalRun = runs.find(({ run }) => run.id === modalRunId)?.run ?? null;

  /**
   * A team picker and an Assign button for one open task, in two places. On
   * the card, beside an unassigned task in `attentionRows`, it is open by
   * default, because a task with no team is the one thing on the card that
   * must be acted on. In a Manage row it opens only after Reassign is pressed
   * (`reassigning`), because a task that has a team is a fact, and four open
   * selects on a run whose tasks are all assigned read as four unanswered
   * questions; there it carries a Cancel that closes it again.
   *
   * The picker starts empty so Assign stays disabled until a team is chosen;
   * picking the task's current team is a harmless no-op write.
   */
  const assignTeam = (runTaskId: string, onCancel?: () => void) => (
    <s-grid
      gridTemplateColumns={
        onCancel === undefined
          ? "minmax(0, 16rem) auto"
          : "minmax(0, 16rem) auto auto"
      }
      gap="small-300"
      alignItems="end"
      justifyContent="start"
    >
      <s-select
        label="Assign team"
        labelAccessibilityVisibility="exclusive"
        placeholder="Assign team"
        value={assignChoice[runTaskId] ?? ""}
        disabled={!identified || busy}
        onChange={(event) => {
          const teamId = event.currentTarget.value;
          setAssignChoice((choice) => ({ ...choice, [runTaskId]: teamId }));
        }}
      >
        {teams.map((team) => (
          <s-option key={team.id} value={team.id}>
            {team.memberCount === 0 ? `${team.name} (no members)` : team.name}
          </s-option>
        ))}
      </s-select>
      <s-button
        variant="secondary"
        disabled={!identified || busy || !assignChoice[runTaskId]}
        onClick={() => {
          const teamId = assignChoice[runTaskId];
          if (teamId) assignMutation.mutate({ runTaskId, teamId });
        }}
      >
        Assign
      </s-button>
      {onCancel !== undefined && (
        <s-button
          variant="tertiary"
          onClick={() => {
            onCancel();
          }}
        >
          Cancel
        </s-button>
      )}
    </s-grid>
  );

  /**
   * The one Unblock button, rendered both in the blocked strip on the card and
   * in the Manage disclosure. Two call sites, one definition, so the disabled
   * rule and the toast cannot drift apart.
   */
  const unblockButton = (run: Domain.WorkflowRun) => (
    <s-button
      variant="secondary"
      disabled={!identified || busy}
      onClick={() => {
        intervene({
          kind: "unblock",
          runId: run.id,
          toast: "Run unblocked",
        });
      }}
    >
      Unblock
    </s-button>
  );

  /** Opens the Block modal on the standing reason: the strip's Edit. */
  const editReasonButton = (run: Domain.WorkflowRun) => (
    <s-button
      variant="secondary"
      disabled={!identified || busy}
      onClick={() => {
        openModal(BLOCK_MODAL, run);
      }}
    >
      Edit
    </s-button>
  );

  /**
   * The run's note on its card, as a wrapping paragraph in a quiet block: it
   * is up to `Domain.RUN_NOTE_MAX_LENGTH` characters of prose, and on one
   * line it truncates or stretches the row. Shown at rest, not inside
   * Manage, because it is what anyone opening the order should read; an
   * empty note shows nothing here and is added from Manage.
   */
  const noteBlock = (run: Domain.WorkflowRun) =>
    run.note === null || run.note.length === 0 ? null : (
      <s-box background="subdued" borderRadius="base" padding="small-300">
        <s-stack gap="small-300">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
            gap="small-300"
          >
            <s-text type="strong">Note</s-text>
            {Domain.runIsLive(run) && (
              <s-button
                variant="tertiary"
                disabled={!identified || busy}
                onClick={() => {
                  openModal(NOTE_MODAL, run);
                }}
              >
                Edit
              </s-button>
            )}
          </s-stack>
          <s-paragraph>{run.note}</s-paragraph>
        </s-stack>
      </s-box>
    );

  /**
   * The Manage disclosure: the member page's step cards with the merchant's
   * buttons ({@link RunSteps} states their shape), under a header line naming
   * the workflow, because the card does not; then the run-level actions —
   * Block or Unblock, Cancel run, Change workflow, Add note — in one row under
   * a rule. Every intervention lives here and nowhere else, so the card above
   * stays a read-only glance: item, status, where the run is, and whatever
   * needs attention.
   *
   * The Reopen verdict is computed here rather than fetched. The page already
   * holds every task of every run on this order, which is exactly what the
   * rule takes (`Domain.undoBlockedBy`) — the same function the write itself
   * runs, so the button and the refusal cannot disagree — and asking the
   * object for a verdict per task would only send back what is already here.
   * There is no Start: the merchant records work, they do not claim it.
   *
   * No action here is primary — not `Mark done`, not `Block`, not `Add note`.
   * Every write on this page is a merchant reaching past a worker — the bench
   * claims and completes tasks on the work page — and a primary button is the
   * grammar of "this is what you came here to do", which is false here.
   * `Block` keeps its critical tone; that says "irreversible for the bench",
   * not "come here for this". Reassign is tertiary: it opens a picker rather
   * than writing, and it sits on every open task.
   *
   * The note is the run's, not a task's: it shows on the card
   * (`noteBlock`), and `Add note` joins the run-level row here while it is
   * empty.
   */
  const manageRows = (
    { run, tasks }: Domain.WorkflowRunDetail,
    /**
     * The `Change workflow` button and, under it, its picker when open. They
     * arrive as nodes rather than a callback because both need the line item
     * they belong to — its options, its chosen id, its `submit` with the
     * confirmation modal — none of which a run-level helper holds. The same
     * shape `blockedStrip` takes its `Unblock` in.
     */
    change: {
      readonly button: React.ReactNode;
      readonly picker: React.ReactNode;
    } | null,
  ) => {
    const open = Domain.runIsOpen(run);
    /** A note is a record, not work: a done run takes one (`Domain.RunStatus`). */
    const addNote =
      Domain.runIsLive(run) && (run.note === null || run.note.length === 0);
    const readyIds = new Set(
      Domain.readyTasks(run, tasks).map((task) => task.id),
    );
    const stepTasks = tasks.map((task) => ({
      ...task,
      ready: readyIds.has(task.id),
    }));
    /* A subdued panel so the disclosure reads as a drawer the header's Manage
       button owns, not as more card. */
    return (
      <s-box background="subdued" borderRadius="base" padding="base">
        <s-stack gap="small-300">
          <s-text type="strong">{`${run.workflowName} workflow`}</s-text>
          <RunSteps
            tasks={stepTasks}
            showInstructions={false}
            renderActions={(task) => {
              const blocker =
                task.completedAt === null
                  ? null
                  : Domain.undoBlockedBy(task, tasks);
              /* A flag means stop, for the merchant too: the write refuses
                 Done on a flagged run (`Domain.runIsFlagged`), so the button
                 goes with it and Unblock or Dismiss on the run row is the way
                 on. Put back, the inverse of a worker's Start, is refused
                 under a flag for the reason on
                 `WorkflowRunRepository.unstartTask`. */
              const markDone = task.ready && !Domain.runIsFlagged(run);
              const putBack =
                task.ready &&
                task.startedAt !== null &&
                !Domain.runIsFlagged(run);
              const reopen = task.completedAt !== null && blocker === null;
              const reassign =
                open && task.completedAt === null && reassigning !== task.id;
              if (!markDone && !putBack && !reopen && !reassign) return null;
              return (
                <>
                  {markDone && (
                    <s-button
                      variant="secondary"
                      disabled={!identified || busy}
                      onClick={() => {
                        intervene({
                          kind: "complete",
                          runTaskId: task.id,
                          toast: `${task.name} marked done`,
                        });
                      }}
                    >
                      Mark done
                    </s-button>
                  )}
                  {putBack && (
                    <s-button
                      variant="secondary"
                      disabled={!identified || busy}
                      onClick={() => {
                        intervene({
                          kind: "putBack",
                          runTaskId: task.id,
                          toast: `${task.name} put back`,
                        });
                      }}
                    >
                      Put back
                    </s-button>
                  )}
                  {reopen && (
                    <s-button
                      variant="secondary"
                      disabled={!identified || busy}
                      onClick={() => {
                        intervene({
                          kind: "reopen",
                          runTaskId: task.id,
                          toast: `${task.name} reopened`,
                        });
                      }}
                    >
                      Reopen
                    </s-button>
                  )}
                  {reassign && (
                    <s-button
                      variant="tertiary"
                      disabled={!identified || busy}
                      onClick={() => {
                        setReassigning(task.id);
                      }}
                    >
                      Reassign
                    </s-button>
                  )}
                </>
              );
            }}
            renderExtra={(task) => {
              const blocker =
                task.completedAt === null
                  ? null
                  : Domain.undoBlockedBy(task, tasks);
              if (blocker !== null)
                /* The only screen that names the blocker, and the only one
                   that can act on it. A member is told nothing
                   (`Domain.taskActions`): they cannot undo, and the blocking
                   task is already on their page wearing its own badge. A
                   merchant can reopen it, so this is an instruction, and it
                   has to pick out a task that "the first started task in a
                   later step" does not pick out by eye.

                   Task first, team parenthetical: the other order —
                   "Finishing started Fit movement" — garden-paths, because a
                   reader who does not already know the team names takes the
                   first word as the subject and the second as a verb.

                   Reopen only clears a finished blocker; an in-progress one
                   is cleared with Put back on its own row, hence both verbs. */
                return (
                  <s-text color="subdued">
                    {`Can\u2019t reopen: ${blocker.taskName} (${blocker.teamName}) already started \u2014 put it back or reopen it first`}
                  </s-text>
                );
              if (open && task.completedAt === null && reassigning === task.id)
                return assignTeam(task.id, () => {
                  setReassigning(null);
                  setAssignChoice((current) => {
                    const { [task.id]: _dropped, ...rest } = current;
                    return rest;
                  });
                });
              return null;
            }}
          />
          {/* The task list is one object and the run's own actions are another:
            Block, Unblock, Cancel and the note act on the whole run, and mixed
            into the tasks they read as a fourth button on the last one. */}
          {(open || Domain.runIsBlocked(run) || addNote) && <s-divider />}
          {(open || addNote) && (
            <s-stack gap="small-300">
              {/* One row for everything that acts on the whole run. Block (or
                Unblock while blocked) leads because it is the intervention a
                merchant reaches for most; Cancel and Change are the rare,
                destructive ones and sit after it. Add note is last and is the
                one run action a done run keeps. */}
              <s-stack direction="inline" gap="small-300">
                {open &&
                  (Domain.runIsBlocked(run) ? (
                    unblockButton(run)
                  ) : (
                    <s-button
                      variant="secondary"
                      tone="critical"
                      disabled={!identified || busy}
                      onClick={() => {
                        openModal(BLOCK_MODAL, run);
                      }}
                    >
                      Block
                    </s-button>
                  ))}
                {open && (
                  <s-button
                    variant="secondary"
                    tone="critical"
                    disabled={!identified || busy}
                    onClick={() => {
                      intervene({
                        kind: "cancel",
                        runId: run.id,
                        toast: "Run cancelled",
                      });
                    }}
                  >
                    Cancel run
                  </s-button>
                )}
                {open && change?.button}
                {addNote && (
                  <s-button
                    variant="secondary"
                    disabled={!identified || busy}
                    onClick={() => {
                      openModal(NOTE_MODAL, run);
                    }}
                  >
                    Add note
                  </s-button>
                )}
              </s-stack>
              {open && change?.picker}
            </s-stack>
          )}
        </s-stack>
      </s-box>
    );
  };

  /**
   * One run inside its line item's card: what it is, how it is doing, and —
   * when the merchant opened Manage from the card header — the disclosure.
   *
   * The card is headed by the line item, and the run line is the status badge
   * and where the run is. The workflow's name is the Manage drawer's header
   * (`manageRows`): the merchant who wants it is the one who opened Manage,
   * and on a shop whose workflows are named after products the card would
   * otherwise print one string twice. `Undo cancel` stays here rather than moving to that
   * header, because a cancelled run has no Manage to hang it beside and an
   * item can carry several cancelled runs at once.
   */
  const renderRun = (
    detail: Domain.WorkflowRunDetail,
    change: Parameters<typeof manageRows>[1],
  ) => {
    const { run } = detail;
    const cancelled = !Domain.runIsLive(run);
    const now = nowLine(detail);
    const attention = attentionRows(detail, teams, assignTeam);
    return (
      <s-stack key={run.id} gap="small-300">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-badge tone={RUN_STATUS_BADGE[run.status].tone}>
            {RUN_STATUS_BADGE[run.status].label}
          </s-badge>
          {Domain.runIsFlagged(run) && (
            <s-badge tone="warning">{flagLabel(run)}</s-badge>
          )}
          {/* A finished run takes the quantity flag (`Domain.RunFlag`) but
              has no run-action row to carry Dismiss, and reopening it through
              Undo is a different decision from accepting the change. So the
              one action its flag allows sits beside the badge. */}
          {Domain.runIsDone(run) && Domain.runIsFlagged(run) && (
            <s-button
              variant="tertiary"
              disabled={!identified || busy}
              onClick={() => {
                intervene({
                  kind: "unblock",
                  runId: run.id,
                  toast: "Flag dismissed",
                });
              }}
            >
              Dismiss
            </s-button>
          )}
          {cancelled && (
            <s-button
              variant="tertiary"
              disabled={!identified || busy}
              onClick={() => {
                intervene({
                  kind: "uncancel",
                  runId: run.id,
                  toast: "Cancel undone",
                });
              }}
            >
              Undo cancel
            </s-button>
          )}
        </s-stack>
        {Domain.runIsBlocked(run) &&
          blockedStrip(
            detail,
            <>
              {editReasonButton(run)}
              {unblockButton(run)}
            </>,
          )}
        {now !== null && <s-text>{now}</s-text>}
        {noteBlock(run)}
        {attention}
        {!cancelled && managingRun(run) && manageRows(detail, change)}
      </s-stack>
    );
  };

  /**
   * An item holds at most one live run, so the picker under it is one of three
   * things and the item's own state decides which:
   *
   * - **ambiguous** — two or more workflows matched at the last reconcile and
   *   none started, because the server will not pick for the merchant. The
   *   picker offers every active workflow, the matches first: the item has
   *   no Manage, so the select is the only way to a workflow the tags did not
   *   pull in. The sentence above it says why it is asking
   *   ({@link AMBIGUITY_SENTENCE}).
   * - **no run** — the ordinary manual start, over every active workflow. It
   *   is the row's resting state, not a disclosure: an empty select with a
   *   Start button beside it *is* the statement that nothing is running, and
   *   it says it in one click rather than two.
   * - **a live run** — a *change*, which cancels what is there. That one is a
   *   rare intervention, so it lives inside Manage (`changeOpen`). The options
   *   drop the incumbent (choosing it again is a no-op the server answers with
   *   `AlreadyExists`), and a run with any task started or done asks first.
   *   A **done** run offers no change at all: see `changeable` below.
   *
   * Ambiguity is derived here rather than kept in state: a cancel elsewhere on
   * the page can make an item ambiguous again between renders, and state
   * seeded once would not notice.
   */
  const renderLineItem = (item: Domain.OrderLineItem) => {
    const removed = item.currentQuantity === 0;
    const toMake = Domain.unitsToMake(item);
    const itemRuns = runs.filter(({ run }) => run.lineItemId === item.id);
    const live = itemRuns.find(({ run }) => Domain.runIsLive(run));
    const matched = itemWorkflows.filter((workflow) =>
      item.matchedWorkflowIds.includes(workflow.id),
    );
    // The same test as `Domain.ambiguousItems`, on the raw id list, so this
    // item and the orders index cannot disagree about whether it is waiting on
    // a choice; `matched` only orders the picker, and a matched workflow that
    // has since lost a team or its tasks simply drops out of the options.
    const ambiguous =
      live === undefined &&
      item.matchedWorkflowIds.length >= 2 &&
      toMake > 0 &&
      !removed;
    // A done run is finished work with a record; changing it would rewrite
    // that history to `cancelled` for a rework the run cards do not model.
    // The server would allow it (`setRun` replaces any `Domain.runIsLive`
    // incumbent), so the page is the gate: change only while `runIsOpen`.
    const changeable = live === undefined || Domain.runIsOpen(live.run);
    const options = (() => {
      if (ambiguous)
        return [
          ...matched,
          ...itemWorkflows.filter(
            (workflow) => !matched.some((other) => other.id === workflow.id),
          ),
        ];
      if (live === undefined) return itemWorkflows;
      return itemWorkflows.filter(
        (workflow) => workflow.id !== live.run.workflowId,
      );
    })();
    const chosen = attachChoice[item.id];
    const actionLabel = live === undefined ? "Start" : "Change";
    const submit = () => {
      if (!chosen) return;
      const touched =
        live !== undefined &&
        live.tasks.some(
          (task) => task.startedAt !== null || task.completedAt !== null,
        );
      if (live !== undefined && touched) {
        setChanging({
          lineItemId: item.id,
          workflowId: chosen,
          from: live.run.workflowName,
          to: options.find((workflow) => workflow.id === chosen)?.name ?? "",
          warning: changeWarning(
            live.run.workflowName,
            options.find((workflow) => workflow.id === chosen)?.name ?? "",
            live.tasks,
          ),
        });
        showModal(CHANGE_WORKFLOW_MODAL);
        return;
      }
      attachMutation.mutate({ lineItemId: item.id, workflowId: chosen });
    };
    /**
     * The select and its submit, in two places: at rest under an item with no
     * run, and inside Manage behind `Change workflow`. One item is only ever in
     * one of those states, so both read the same `attachChoice[item.id]` and
     * send through the same `submit`.
     *
     * A grid, not an inline stack: a Polaris form control fills the inline size
     * it is given and has no width prop, so `s-select` in an inline stack takes
     * the whole row and pushes the submit onto the next line at every window
     * width. The leading label cell is an `s-text` rather than the select's own
     * label so the visible word stays "Workflow" while the accessible name
     * stays the verb.
     */
    const workflowPicker = (onCancel?: () => void) => (
      <s-grid
        gridTemplateColumns="max-content minmax(0, 20rem) auto auto"
        gap="base"
        alignItems="center"
        justifyContent="start"
      >
        <s-text color="subdued">Workflow</s-text>
        <s-select
          label={live === undefined ? "Choose workflow" : "Change workflow"}
          labelAccessibilityVisibility="exclusive"
          placeholder={
            live === undefined ? "Choose workflow" : "Change workflow"
          }
          value={chosen ?? ""}
          disabled={!identified || busy}
          onChange={(event) => {
            const workflowId = event.currentTarget.value;
            setAttachChoice((choice) => ({
              ...choice,
              [item.id]: workflowId,
            }));
          }}
        >
          {options.map((workflow, index) => (
            <React.Fragment key={workflow.id}>
              {/* Polaris `s-select` has no option groups, so a disabled
                  option is the rule between the matches and the rest. */}
              {ambiguous && index === matched.length && (
                <s-option value="" disabled>
                  {"\u2014"}
                </s-option>
              )}
              <s-option value={workflow.id}>{workflow.name}</s-option>
            </React.Fragment>
          ))}
        </s-select>
        <s-button
          variant="secondary"
          disabled={!identified || busy || !chosen}
          onClick={submit}
        >
          {actionLabel}
        </s-button>
        {onCancel !== undefined && (
          <s-button
            variant="tertiary"
            onClick={() => {
              onCancel();
            }}
          >
            Cancel
          </s-button>
        )}
      </s-grid>
    );
    /**
     * `Change workflow` and its picker, handed to `manageRows` through
     * `renderRun`. Null when there is nothing to change: a removed item, a done
     * run, or a shop whose only active workflow is the one already running.
     */
    const change =
      live === undefined || removed || !changeable || options.length === 0
        ? null
        : {
            button: (
              <s-button
                variant="secondary"
                onClick={() => {
                  setChangeOpen((current) => {
                    const next = new Set(current);
                    if (!next.delete(live.run.id)) next.add(live.run.id);
                    return next;
                  });
                }}
              >
                Change workflow
              </s-button>
            ),
            picker: changingRun(live.run)
              ? workflowPicker(() => {
                  setChangeOpen((current) => {
                    const next = new Set(current);
                    next.delete(live.run.id);
                    return next;
                  });
                  /* Both pickers read one choice per item, so a pick left
                     behind here would preselect the Start picker after a
                     later Cancel run. */
                  setAttachChoice((current) => {
                    const { [item.id]: _dropped, ...rest } = current;
                    return rest;
                  });
                })
              : null,
          };
    /**
     * Quantity and SKU, as one subdued line under the title. No product tags:
     * they were "why a workflow matched", and on an ambiguous item the
     * picker's option list, matches first, is that answer now.
     */
    const facts = [
      /* Ordered vs. to make differ after an edit or a refund; shipping does not move it ({@link Domain.unitsToMake}). */
      toMake === item.quantity
        ? `\u00D7 ${formatNumber(item.quantity)}`
        : `\u00D7 ${formatNumber(toMake)} to make (${formatNumber(item.quantity)} ordered)`,
      ...(item.sku === null ? [] : [`SKU ${item.sku}`]),
    ].join(" \u00B7 ");
    /**
     * `s-section` has no header action slot, so the header is built by hand:
     * the section takes no `heading` and an inline stack inside it holds the
     * `s-heading` and the button. This is what the Shopify admin's own order
     * cards look like. The label stays `Manage` in both states with a flipping
     * chevron — a `Hide` button in a card header reads as hiding the card, and
     * `Done` collides with `Mark done` inside the disclosure it toggles.
     *
     * The state is the chevron and nothing else. `aria-expanded` was measured
     * (2026-09-16) and does not work here: React omits the attribute when it is
     * false and writes it on the `s-button` host when true, but the host is not
     * the element carrying the button role, so it never reaches the
     * accessibility tree. The remaining lever is `accessibilityLabel`, which
     * replaces the accessible name — "Manage, expanded" — and that is a worse
     * trade than a silent chevron: it renames the control every merchant and
     * every test addresses by its visible word, for a state a screen reader
     * then hears as part of the name rather than as a state.
     */
    const manageButton =
      live === undefined ? null : (
        <s-button
          variant="secondary"
          icon={managingRun(live.run) ? "chevron-up" : "chevron-down"}
          onClick={() => {
            setManaging((current) => {
              const next = new Set(current);
              if (!next.delete(live.run.id)) next.add(live.run.id);
              return next;
            });
          }}
        >
          Manage
        </s-button>
      );
    /* No `accessibilityLabel` on the section: with no `heading`, `s-section`
       renders the label as a second, hidden heading and screen readers hear
       the title twice. The `s-heading` inside is the section's name. */
    return (
      <s-section key={item.id}>
        <s-stack gap="small-100">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="start"
            gap="base"
          >
            {/* The facts sit under the title as its subtitle, tight to it,
                so the card opens with one block rather than a title and a
                lone "× 1" a full gap apart. */}
            <s-stack gap="small-500">
              <s-heading>{lineItemTitle(item)}</s-heading>
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text color="subdued">{facts}</s-text>
                {removed && <s-badge tone="critical">Removed</s-badge>}
              </s-stack>
            </s-stack>
            {manageButton}
          </s-stack>

          {/* "Properties" is Shopify's merchant-facing name for line item
              `customAttributes`: the Help Center and theme docs say "line
              item properties", the API says `customAttributes`. Shortened
              because the heading already sits inside the line item's card. */}
          {item.customAttributes.length > 0 && (
            <s-stack gap="small-300">
              <s-text color="subdued">Properties</s-text>
              <s-grid
                gridTemplateColumns="max-content 1fr"
                gap="small-300 base"
                alignItems="start"
              >
                {item.customAttributes.map(({ key, value }) => (
                  <React.Fragment key={key}>
                    <s-text color="subdued">{key}</s-text>
                    <s-text>{value ?? ""}</s-text>
                  </React.Fragment>
                ))}
              </s-grid>
            </s-stack>
          )}

          <s-stack gap="small-100">
            {ambiguous && <s-paragraph>{AMBIGUITY_SENTENCE}</s-paragraph>}
            {itemRuns.map((itemRun) =>
              renderRun(
                itemRun,
                itemRun.run.id === live?.run.id ? change : null,
              ),
            )}
            {live === undefined &&
              !removed &&
              (options.length === 0 ? (
                <s-paragraph color="subdued">
                  No workflows can start.{" "}
                  <s-link href="/app/workflows">Create one.</s-link>
                </s-paragraph>
              ) : (
                workflowPicker()
              ))}
          </s-stack>
        </s-stack>
      </s-section>
    );
  };

  return (
    <s-page heading={order.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/orders">
        Orders
      </s-link>
      {/* The primary action leaves for the Shopify order: payment,
          fulfilment and the customer live there, and fulfilling is the next
          task once the work here is done. Resync is secondary because webhooks
          keep the order current; a primary Resync tells the merchant syncing
          is their job. It stays for the rare order that looks stale. */}
      <s-button
        slot="primary-action"
        variant="primary"
        href={adminOrderUrl(order)}
        target={resourceLinkTarget}
      >
        View in Shopify
      </s-button>
      <s-button
        slot="secondary-actions"
        loading={resyncMutation.isPending}
        disabled={!identified || resyncMutation.isPending}
        onClick={() => {
          resyncMutation.mutate(order.id);
        }}
      >
        Resync from Shopify
      </s-button>

      <SocketBanner />
      {(banner !== null ||
        order.lineItemsTruncated ||
        state === "ready_to_ship") && (
        /* In the main column, not `slot="supplemental-start"`: that slot
           renders above the main column only, so anything in it pushes the
           first card below the top of the aside. Here the banners are the
           first thing in the column and the card under them still lines up
           with the aside's top edge. */
        <s-stack gap="base">
          {state === "ready_to_ship" && (
            <s-banner tone="success">
              Every run is done.{" "}
              <s-link href={adminOrderUrl(order)} target={resourceLinkTarget}>
                Fulfil this order in the Shopify admin
              </s-link>
              ; it will show as Shipped here once Shopify reports it.
            </s-banner>
          )}
          {/* One cap, one sentence: every path stores the first 250 and
              neither pages, so "more than Baton tracks" is the whole of what
              happened (`OrderRepository.upsertOrder`). */}
          {order.lineItemsTruncated && (
            <s-banner tone="warning">
              {`Baton tracks up to ${formatNumber(Domain.ShopLimits.maxLineItemsPerOrder)} line items per order. This order has more; open it in Shopify for the full list.`}
            </s-banner>
          )}
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
        </s-stack>
      )}

      {lineItems.length === 0 ? (
        <s-paragraph color="subdued">No line items.</s-paragraph>
      ) : (
        lineItems.map(renderLineItem)
      )}

      {/* One modal for the page, driven by `changing`: a per-item one would
          mount a dialog under every line item of every order. */}
      <s-modal id={CHANGE_WORKFLOW_MODAL} heading="Change workflow?">
        <s-paragraph>{changing?.warning ?? ""}</s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={CHANGE_WORKFLOW_MODAL}
          command="--hide"
          onClick={() => {
            setChanging(null);
          }}
        >
          {changing === null ? "Cancel" : `Keep ${changing.from}`}
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={attachMutation.isPending}
          disabled={!identified || busy || changing === null}
          onClick={() => {
            if (changing !== null)
              attachMutation.mutate({
                lineItemId: changing.lineItemId,
                workflowId: changing.workflowId,
              });
          }}
        >
          Change workflow
        </s-button>
      </s-modal>

      <RunNoteModal
        id={NOTE_MODAL}
        note={modalRun?.note ?? null}
        pending={!identified || busy}
        onSave={(note) =>
          modalRun === null
            ? Promise.resolve("That workflow run no longer exists.")
            : interveneFromModal({
                kind: "note",
                runId: modalRun.id,
                note: note.trim() === "" ? null : note,
                toast: "Note saved",
              })
        }
      />
      <BlockModal
        id={BLOCK_MODAL}
        run={
          modalRun ?? { orderName: order.name, flag: null, flagDetail: null }
        }
        pending={!identified || busy}
        onBlock={(reason) =>
          modalRun === null
            ? Promise.resolve("That workflow run no longer exists.")
            : interveneFromModal({
                kind: "block",
                runId: modalRun.id,
                reason: reason.trim() === "" ? null : reason,
                toast: "Run blocked",
              })
        }
        onSaveReason={(reason) =>
          modalRun === null
            ? Promise.resolve("That workflow run no longer exists.")
            : interveneFromModal({
                kind: "blockReason",
                runId: modalRun.id,
                reason: reason.trim() === "" ? null : reason,
                toast: "Reason saved",
              })
        }
      />

      {order.note !== null && (
        <s-section slot="aside" heading="Order note">
          <s-paragraph>{order.note}</s-paragraph>
        </s-section>
      )}

      <s-section slot="aside" heading="Order details">
        <s-grid
          gridTemplateColumns="max-content 1fr"
          gap="small-200 base"
          alignItems="center"
        >
          {fact("Placed", <LocalDateTime value={order.processedAt} />)}
          {fact(
            "Payment",
            order.financialStatus === null ? null : (
              <s-stack direction="inline">
                <s-badge tone={order.fullyPaid ? "success" : "warning"}>
                  {formatStatus(order.financialStatus)}
                </s-badge>
              </s-stack>
            ),
          )}
          {fact("Fulfillment", formatStatus(order.fulfillmentStatus))}
          {fact(
            "Cancelled",
            order.cancelledAt === null ? null : (
              <LocalDateTime value={order.cancelledAt} />
            ),
          )}
          {fact(
            "Closed",
            order.closedAt === null ? null : (
              <LocalDateTime value={order.closedAt} />
            ),
          )}
          {fact(
            "Order attributes",
            order.customAttributes
              .map(({ key, value }) => `${key}: ${value ?? ""}`)
              .join(", "),
          )}
        </s-grid>
      </s-section>
    </s-page>
  );
}

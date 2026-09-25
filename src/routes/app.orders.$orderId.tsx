import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import {
  FlagBanner,
  flagTone,
  LineItemProperties,
  liftFlagLabel,
  RunNote,
} from "@/components/MemberRun";
import { RunSteps } from "@/components/RunSteps";
import { BlockModal, RunNoteModal } from "@/components/RunTextModals";
import { cancelWarning, changeWarning } from "@/lib/changeWarning";
import * as Domain from "@/lib/Domain";
import { formatNumber, formatStatus } from "@/lib/format";
import { adminOrderUrl, useResourceLinkTarget } from "@/lib/orderLinks";
import { hideModal, showModal } from "@/lib/polarisModal";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { errorMessage, textOrNull } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

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
  /* The page offers no change on a done run (`Domain.runActions`); this is
     the race where the run finished between the render and the click. */
  ItemDone: ({ workflowName }) =>
    `This item is finished on ${workflowName}. Reopen its last task to change it.`,
  OrderClosed: () =>
    "This order is cancelled or fulfilled in Shopify, so there is no work left to attach.",
  NothingToMake: () =>
    "This item has nothing left to make, so no workflow can start on it.",
});

const assignResultMessage = Match.typeTags<
  Domain.AssignRunTaskTeamResult,
  string | null
>()({
  Assigned: () => null,
  NotFound: () => "That task no longer exists.",
  TeamNotFound: () => "That team no longer exists. Choose another.",
  TaskFinished: () => "That task is already done and keeps its team.",
  RunNotOpen: () => "That workflow run is finished.",
  NotAllowed: () => "That task can no longer be reassigned.",
});

const runResultMessage = Match.typeTags<Domain.RunResult, string | null>()({
  Ok: () => null,
  /* Also a run another admin cancelled: a cancel leaves a task-less marker
     that no run write can act on (`Domain.RunStatus`), so the server answers
     as if the run were gone. */
  NotFound: () => "That workflow run no longer exists.",
  /* The page offers a write only where `Domain.runActions` or
     `Domain.taskActions` allows it and the server checks the same field, so
     this is the run changing between the render and the click. */
  NotAllowed: () => "That run changed just now, so nothing was done.",
  /* The reason editor, when a worker unblocked the run while it was open. */
  NotBlocked: () => "That workflow run is no longer blocked.",
  /* Also Put back on a task a worker finished or put back just now. */
  NotReady: () =>
    "That task changed just now, or a task in an earlier step is still open.",
  /* A run that finished between the render and the click. */
  Terminal: () => "That workflow run is finished.",
  /* Mark done is hidden while a run is flagged; a flag that landed after the
     render is the only way here. */
  Flagged: ({ flag }) =>
    Domain.flagIsReconcile(flag)
      ? "That workflow run was flagged just now. Dismiss the flag first."
      : "That workflow run is blocked. Unblock it first.",
  // Reachable from Manage's Reopen: the row hides that button when
  // `Domain.taskActions` carries a blocker, and this is the race where a
  // worker started downstream between the render and the click.
  UndoBlocked: ({ teamName, taskName }) =>
    `${teamName} already started ${taskName}.`,
});

/**
 * Merchant words, not `WorkflowRun.status`: "pending" reads as "waiting for
 * approval". Cancelled is neutral, not red: it is a decision the merchant
 * made, and red stays for a hold and for Shopify cancelling the order.
 */
const RUN_STATUS_BADGE = {
  pending: { label: "Not started", tone: "neutral" },
  active: { label: "In progress", tone: "info" },
  done: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const satisfies Record<Domain.RunStatus, { label: string; tone: string }>;

const RUN_FLAG_LABEL = {
  item_removed: "Item removed",
  quantity_changed: "Quantity changed",
  order_cancelled: "Order cancelled",
  blocked: "Blocked",
  order_fulfilled: "Already shipped in Shopify",
} as const satisfies Record<Domain.RunFlag, string>;

/** The one modal that both asks and confirms: the select and, on a touched run, the warning. */
const CHANGE_WORKFLOW_MODAL = "change-workflow";
const CANCEL_RUN_MODAL = "cancel-run";
const REASSIGN_MODAL = "reassign-task";
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
 * A flag as a badge: a closed vocabulary plus, where the flag names a thing,
 * that thing. `blocked` is deliberately absent from the second branch — its
 * reason is merchant prose up to `Domain.BLOCK_REASON_MAX_LENGTH` characters, and a
 * badge sized for one word stretches the row until the run's own controls
 * leave the viewport. The reason renders in the {@link FlagBanner} instead.
 *
 * The tone comes from {@link flagTone}, so the merchant and the worker see the
 * same split between a stop and a change. The words are this page's own on
 * purpose: the merchant's vocabulary ("Item removed", "Already shipped in
 * Shopify") is not the bench's.
 */
const flagLabel = (run: Domain.WorkflowRun) => {
  if (run.flag === null) return null;
  if (Domain.flagIsReconcile(run.flag) && run.flagDetail?.item !== undefined)
    return `${RUN_FLAG_LABEL[run.flag]}: ${run.flagDetail.item}`;
  return RUN_FLAG_LABEL[run.flag];
};

interface TaskWrite {
  readonly runTaskId: string;
  readonly toast: string;
}
interface RunWrite {
  readonly runId: string;
  readonly toast: string;
}
interface TextWrite extends RunWrite {
  readonly text: string | null;
}

/** The merchant as the actor every action set on this page is computed for. */
const MERCHANT: Domain.Actor = { role: "merchant" };

/** The roster as select options, an empty team named so the pick is not a surprise. */
const teamOptions = (teams: readonly Domain.TeamRoster[]) =>
  teams.map((team) => (
    <s-option key={team.id} value={team.id}>
      {team.memberCount === 0 ? `${team.name} (no members)` : team.name}
    </s-option>
  ));

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

const stepCount = (tasks: readonly Domain.WorkflowRunTask[]) =>
  tasks.reduce((max, task) => Math.max(max, task.step), 0);

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
 *
 * It renders on a blocked run too. That is the one card where "why it
 * stopped" and "where it is" are different questions: the banner above
 * answers the first and this line the second. A blocked run is still open
 * ({@link Domain.runIsOpen}), so its ready tasks are the ones the hold
 * stopped.
 */
const nowLine = ({ run, tasks }: Domain.WorkflowRunDetail): React.ReactNode => {
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
  /* One name, then a count. On a parallel step every ready task can carry a
     name at `Domain.NAME_MAX_LENGTH`, and listing three of them runs the line
     to four rows on a card meant to be glanced at. The Manage drawer lists
     each task; this line says where the run is. */
  const names =
    ready.length === 1
      ? ready[0].name
      : `${ready[0].name} and ${formatNumber(ready.length - 1)} more`;
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
 * Both are about work that can still move, so both follow
 * {@link Domain.taskActions}' `reassign`: the picker is that write, and the
 * warning's remedy is either it or a new member.
 *
 * They render on the card, outside the Manage disclosure, because they are the
 * one thing that must be acted on and a disclosure would hide it. Every other
 * intervention — reassigning an already-assigned task, notes, block, cancel —
 * is inside Manage: one place to act on a run rather than two, and nothing on
 * the card is a click target, so scanning an order never risks a stray "done".
 */
const attentionRows = (
  tasks: readonly (Domain.RunTaskView & {
    readonly actions: Domain.TaskActions;
  })[],
  teams: readonly Domain.TeamRoster[],
  assign: (runTaskId: string) => React.ReactNode,
) => {
  const assignable = tasks.filter(({ actions }) => actions.reassign);
  const unassigned = assignable.filter((task) =>
    Domain.isRunTaskUnassigned(task, teams),
  );
  /** The roster row, not the snapshot name, so the warning can link to the team page. */
  const emptyTeams = [
    ...new Map(
      assignable
        .filter((task) => task.ready)
        .flatMap((task) => {
          const team = teams.find(
            (candidate) =>
              candidate.id === task.teamId && candidate.memberCount === 0,
          );
          return team === undefined ? [] : [[team.id, team] as const];
        }),
    ).values(),
  ];
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
 *
 * The page decides no gate. Each line item's card is a switch on
 * {@link Domain.lineItemState}, and each button reads a field of
 * {@link Domain.runActions} or {@link Domain.taskActions}, which the
 * `ShopAgent` callable behind it checks again.
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
  /** The "Assign team" picker's choice per unassigned run task. */
  const [assignChoice, setAssignChoice] = React.useState<
    Record<string, string>
  >({});
  /**
   * What the Change workflow modal holds, or null when it is closed: the item,
   * the run being replaced (its name, for "Keep …", and its tasks, for the
   * warning), the options, and the modal's own pick. The modal is one element
   * at page level rather than one per item, so the click that opens it has to
   * say which item it meant.
   *
   * The pick lives here and not in `attachChoice`: that map belongs to the
   * at-rest Start picker, and a pick left behind in the modal would preselect
   * it after a later Cancel run.
   */
  const [changing, setChanging] = React.useState<{
    readonly lineItemId: string;
    readonly from: Domain.WorkflowName;
    readonly hasNote: boolean;
    readonly options: readonly Domain.Workflow[];
    readonly tasks: readonly Domain.WorkflowRunTask[];
    readonly workflowId: string | null;
  } | null>(null);
  /** The run the Cancel run modal asks about, with what its sentence names. */
  const [cancelling, setCancelling] = React.useState<{
    readonly runId: string;
    readonly tasks: readonly Domain.WorkflowRunTask[];
    readonly hasNote: boolean;
  } | null>(null);
  /**
   * The task the Reassign modal is about: its name for the heading, its
   * current team for the default and for "Keep …", and the modal's own pick.
   */
  const [reassigning, setReassigning] = React.useState<{
    readonly runTaskId: string;
    readonly taskName: Domain.TaskName;
    readonly teamName: Domain.TeamName;
    readonly teamId: string;
    readonly error: string | null;
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
   * page level, as the Change workflow modal is, so the click that opens one
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

  const call = <A,>(op: (stub: ShopAgentSocket["stub"]) => Promise<A>) =>
    agent ? withSocketRecovery(agent)(() => op(agent.stub)) : connecting();

  const onError = (error: Error) => {
    setBanner(error.message);
  };

  const attachMutation = useMutation({
    mutationFn: (input: typeof Domain.AttachWorkflowInput.Encoded) =>
      call((stub) => stub.merchantAttachWorkflow(input)).then(
        decodeAttachResult,
      ),
    onSuccess: async (result, { lineItemId }) => {
      setBanner(attachResultMessage(result));
      if (result._tag === "Ok") {
        setAttachChoice((current) => {
          const { [lineItemId]: _done, ...rest } = current;
          return rest;
        });
        setChanging(null);
        hideModal(CHANGE_WORKFLOW_MODAL);
        /* The replaced run is deleted (`Domain.RunStatus`), and the modal
           already named what it cost, so the toast says only where the item
           is now. A start over nothing, or over a cancelled marker, is a
           fresh run: "Started", never "resumed". */
        shopify.toast.show(
          result.replaced === null
            ? `Started ${result.run.workflowName}.`
            : `Changed to ${result.run.workflowName}.`,
        );
      }
      await invalidate();
    },
    onError,
  });

  /**
   * One mutation per action field, each calling the matching `merchant*`
   * callable: the field that rendered the button, the mutation behind it and
   * the callable that checks the field again share one name. A refused write
   * raises no banner — the page should not have offered it, so the honest
   * answer is the toast plus the re-render the subscription brings, exactly
   * as the worker's page behaves. `toast` is the acknowledgement, written at
   * the button so the task's own name reaches it ("Cut marked done").
   */
  const runWrite = {
    onSuccess: async (
      result: Domain.RunResult,
      input: { readonly toast: string },
    ) => {
      if (result._tag === "Ok") shopify.toast.show(input.toast);
      else
        shopify.toast.show(runResultMessage(result) ?? "Nothing changed.", {
          isError: true,
        });
      await invalidate();
    },
    onError,
  };
  const done = useMutation({
    mutationFn: ({ runTaskId }: TaskWrite) =>
      call((stub) => stub.merchantCompleteTask({ runTaskId })).then(
        decodeRunResult,
      ),
    ...runWrite,
  });
  const putBack = useMutation({
    mutationFn: ({ runTaskId }: TaskWrite) =>
      call((stub) => stub.merchantUnstartTask({ runTaskId })).then(
        decodeRunResult,
      ),
    ...runWrite,
  });
  const reopen = useMutation({
    mutationFn: ({ runTaskId }: TaskWrite) =>
      call((stub) => stub.merchantUncompleteTask({ runTaskId })).then(
        decodeRunResult,
      ),
    ...runWrite,
  });
  const note = useMutation({
    mutationFn: ({ runId, text }: TextWrite) =>
      call((stub) => stub.merchantSetRunNote({ runId, note: text })).then(
        decodeRunResult,
      ),
    ...runWrite,
  });
  const block = useMutation({
    mutationFn: ({ runId, text }: TextWrite) =>
      call((stub) => stub.merchantBlockRun({ runId, reason: text })).then(
        decodeRunResult,
      ),
    ...runWrite,
  });
  const editReason = useMutation({
    mutationFn: ({ runId, text }: TextWrite) =>
      call((stub) => stub.merchantSetBlockReason({ runId, reason: text })).then(
        decodeRunResult,
      ),
    ...runWrite,
  });
  const liftFlag = useMutation({
    mutationFn: ({ runId }: RunWrite) =>
      call((stub) => stub.merchantDismissFlag({ runId })).then(decodeRunResult),
    ...runWrite,
  });
  const cancel = useMutation({
    mutationFn: ({ runId }: RunWrite) =>
      call((stub) => stub.merchantCancelRun({ runId })).then(decodeRunResult),
    ...runWrite,
    onSuccess: async (result: Domain.RunResult, input: RunWrite) => {
      if (result._tag === "Ok") {
        setCancelling(null);
        hideModal(CANCEL_RUN_MODAL);
      }
      await runWrite.onSuccess(result, input);
    },
  });

  const reassign = useMutation({
    mutationFn: (input: typeof Domain.AssignRunTaskTeamInput.Encoded) =>
      call((stub) => stub.merchantAssignRunTaskTeam(input)).then(
        decodeAssignResult,
      ),
    onSuccess: async (result, { runTaskId }) => {
      const message = assignResultMessage(result);
      /* The attention row's picker has no modal to hold a message, so its
         refusal goes to the page banner; the modal keeps its own. */
      if (reassigning?.runTaskId === runTaskId) {
        if (message === null) {
          setReassigning(null);
          hideModal(REASSIGN_MODAL);
        } else
          setReassigning((current) =>
            current === null ? null : { ...current, error: message },
          );
      } else setBanner(message);
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
  const orderOpen = Domain.canAttachRun(order);
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
  const busy = [
    attachMutation,
    done,
    putBack,
    reopen,
    note,
    block,
    editReason,
    liftFlag,
    cancel,
    reassign,
  ].some((mutation) => mutation.isPending);
  const pending = !identified || busy;
  /** A modal's write: `null` closes it, a message stays under its field. */
  const fromModal = (write: Promise<Domain.RunResult>) =>
    write
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
   * The modal's warning, empty until a workflow is picked and on a run with
   * nothing started or done: a change there loses nothing.
   */
  const changingWarning = (() => {
    if (changing === null || changing.workflowId === null) return "";
    const touched = changing.tasks.some(
      (task) => task.startedAt !== null || task.completedAt !== null,
    );
    if (!touched) return "";
    const to =
      changing.options.find((workflow) => workflow.id === changing.workflowId)
        ?.name ?? "";
    return changeWarning(changing.from, to, changing.tasks, changing.hasNote);
  })();
  const cancellingWarning =
    cancelling === null
      ? ""
      : cancelWarning(cancelling.tasks, cancelling.hasNote);

  /**
   * The team picker and Assign button beside an unassigned task in
   * `attentionRows`, open at rest because a task with no team is a required
   * slot left empty, the one thing on the card that must be acted on. A task
   * that has a team changes it through the Reassign modal instead: a filled
   * slot is changed in a modal, an empty one is filled at rest.
   *
   * The picker starts empty so Assign stays disabled until a team is chosen.
   */
  const assignTeam = (runTaskId: string) => (
    <s-grid
      gridTemplateColumns="minmax(0, 16rem) auto"
      gap="small-300"
      alignItems="end"
      justifyContent="start"
    >
      <s-select
        label="Assign team"
        labelAccessibilityVisibility="exclusive"
        placeholder="Assign team"
        value={assignChoice[runTaskId] ?? ""}
        disabled={pending}
        onChange={(event) => {
          const teamId = event.currentTarget.value;
          setAssignChoice((choice) => ({ ...choice, [runTaskId]: teamId }));
        }}
      >
        {teamOptions(teams)}
      </s-select>
      <s-button
        variant="secondary"
        disabled={pending || !assignChoice[runTaskId]}
        onClick={() => {
          const teamId = assignChoice[runTaskId];
          if (teamId) reassign.mutate({ runTaskId, teamId });
        }}
      >
        Assign
      </s-button>
    </s-grid>
  );

  /**
   * The Manage disclosure: the member page's step cards with the merchant's
   * buttons ({@link RunSteps} states their shape), under a header line naming
   * the workflow, because the card does not; then the run-level actions —
   * Block, Cancel run, Change workflow — in one row under a rule. Every
   * intervention lives here and nowhere else, so the card above stays a
   * read-only glance: item, status, where the run is, and whatever needs
   * attention.
   *
   * No action here is primary — not `Mark done`, not `Block`. Every write on
   * this page is a merchant reaching past a worker — the bench claims and
   * completes tasks on the work page — and a primary button is the grammar of
   * "this is what you came here to do", which is false here. Nothing here is
   * red either: Polaris puts the critical tone on the button that performs a
   * destructive action, not on the one that opens the question, and Cancel
   * run and Change workflow each open a modal whose submit is red. Reassign
   * is tertiary: it opens a modal rather than writing, and it sits on every
   * open task.
   *
   * The note is on the card ({@link RunNote}) and has no button here.
   */
  const manageRows = (
    run: Domain.WorkflowRun,
    tasks: readonly (Domain.RunTaskView & {
      readonly actions: Domain.TaskActions;
    })[],
    actions: Domain.RunActions,
    /**
     * The `Change workflow` button. It arrives as a node rather than a
     * callback because opening the modal needs the line item it belongs to —
     * its options and its run's tasks — which a run-level helper does not
     * hold.
     */
    change: React.ReactNode | null,
  ) => {
    const byId = new Map(tasks.map((task) => [task.id, task.actions]));
    const runRow = actions.block || actions.cancel || change !== null;
    /* A subdued panel so the disclosure reads as a drawer the header's Manage
       button owns, not as more card. */
    return (
      <s-box background="subdued" borderRadius="base" padding="base">
        <s-stack gap="small-300">
          <s-text type="strong">{`${run.workflowName} workflow`}</s-text>
          <RunSteps
            tasks={tasks}
            showInstructions={false}
            renderActions={(task) => {
              const can = byId.get(task.id);
              if (can === undefined) return null;
              const canReopen = can.reopen?.blockedBy === null;
              if (!can.done && !can.putBack && !canReopen && !can.reassign)
                return null;
              return (
                <>
                  {can.done && (
                    <s-button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        done.mutate({
                          runTaskId: task.id,
                          toast: `${task.name} marked done`,
                        });
                      }}
                    >
                      Mark done
                    </s-button>
                  )}
                  {can.putBack && (
                    <s-button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        putBack.mutate({
                          runTaskId: task.id,
                          toast: `${task.name} put back`,
                        });
                      }}
                    >
                      Put back
                    </s-button>
                  )}
                  {canReopen && (
                    <s-button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        reopen.mutate({
                          runTaskId: task.id,
                          toast: `${task.name} reopened`,
                        });
                      }}
                    >
                      Reopen
                    </s-button>
                  )}
                  {can.reassign && (
                    <s-button
                      variant="tertiary"
                      disabled={pending}
                      onClick={() => {
                        setReassigning({
                          runTaskId: task.id,
                          taskName: task.name,
                          teamName: task.teamName,
                          teamId:
                            task.teamId !== null &&
                            teams.some((team) => team.id === task.teamId)
                              ? task.teamId
                              : "",
                          error: null,
                        });
                        showModal(REASSIGN_MODAL);
                      }}
                    >
                      Reassign
                    </s-button>
                  )}
                </>
              );
            }}
            renderExtra={(task) => {
              const blocker = byId.get(task.id)?.reopen?.blockedBy ?? null;
              if (blocker === null) return null;
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
                  {`Can’t reopen: ${blocker.taskName} (${blocker.teamName}) already started — put it back or reopen it first`}
                </s-text>
              );
            }}
          />
          {/* The task list is one object and the run's own actions are another:
            Block, Cancel and Change act on the whole run, and mixed
            into the tasks they read as a fourth button on the last one. */}
          {runRow && <s-divider />}
          {runRow && (
            /* One row for everything that acts on the whole run. Block leads
               because it is the intervention a merchant reaches for most.
               Cancel and Change are the rare ones and sit after it. */
            <s-stack direction="inline" gap="small-300">
              {actions.block && (
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    openModal(BLOCK_MODAL, run);
                  }}
                >
                  Block
                </s-button>
              )}
              {actions.cancel && (
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setCancelling({
                      runId: run.id,
                      tasks,
                      hasNote: run.note !== null && run.note.length > 0,
                    });
                    showModal(CANCEL_RUN_MODAL);
                  }}
                >
                  Cancel run
                </s-button>
              )}
              {change}
            </s-stack>
          )}
        </s-stack>
      </s-box>
    );
  };

  /**
   * A run's badges: its status and its flag, and no buttons — the flag's own
   * action is in its {@link FlagBanner}. They end the card's facts line,
   * under the title, because the badge is the item's state at a glance and
   * belongs next to the item it describes; on a line of their own lower down
   * they read as belonging to whatever sat above them.
   *
   * The flag badge stays while the banner shows: the badge is the glance, on
   * the title line and matching the orders index, and the banner is the
   * detail further down.
   */
  const runBadges = (run: Domain.WorkflowRun) => (
    <>
      <s-badge tone={RUN_STATUS_BADGE[run.status].tone}>
        {RUN_STATUS_BADGE[run.status].label}
      </s-badge>
      {Domain.runIsFlagged(run) && (
        <s-badge tone={flagTone(run) ?? "warning"}>{flagLabel(run)}</s-badge>
      )}
    </>
  );

  /**
   * One run inside its line item's card, below the item's title, facts and
   * properties. Top to bottom: the {@link FlagBanner} while flagged (why it
   * stopped, with Edit reason and the lift), the Now line (where it is), the
   * {@link RunNote}, the attention rows, then Manage and, when open, the
   * disclosure it toggles. The badges are on the facts line
   * ({@link runBadges}).
   *
   * The banner stays in the run block rather than above the item title: it
   * is about the run (the lift, the reason and who set it all act on or
   * describe the run), and a card that opened on red would not yet say which
   * item it is about. The badge on the title line flags the card first.
   *
   * Manage sits directly above the drawer it opens rather than in the card
   * header. It is a disclosure, not an action on the card, and a disclosure
   * belongs next to what it reveals; in the header it was the full card away
   * from its drawer, and a long title wrapped it onto a line of its own. The
   * label stays `Manage` in both states with a flipping chevron — `Hide`
   * reads as hiding the card, and `Done` collides with `Mark done` inside
   * the disclosure it toggles.
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
   *
   * The card is headed by the line item, and the run line is the status badge
   * and where the run is. The workflow's name is the Manage drawer's header
   * (`manageRows`): the merchant who wants it is the one who opened Manage,
   * and on a shop whose workflows are named after products the card would
   * otherwise print one string twice.
   */
  const renderRun = (
    item: Domain.OrderLineItem,
    run: Domain.WorkflowRun,
    views: readonly Domain.RunTaskView[],
  ) => {
    const tasks = views.map((task) => ({
      ...task,
      actions: Domain.taskActions(MERCHANT, order, run, task),
    }));
    const actions = Domain.runActions(MERCHANT, order, run, tasks, item);
    const now = nowLine({ run, tasks });
    const attention = attentionRows(tasks, teams, assignTeam);
    const options = itemWorkflows.filter(
      (workflow) => workflow.id !== run.workflowId,
    );
    /**
     * `Change workflow`, handed to `manageRows`. Absent when the field is
     * false or when the shop's only active workflow is the one already
     * running.
     */
    const change =
      !actions.changeWorkflow || options.length === 0 ? null : (
        <s-button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setChanging({
              lineItemId: item.id,
              from: run.workflowName,
              hasNote: run.note !== null && run.note.length > 0,
              options,
              tasks,
              workflowId: null,
            });
            showModal(CHANGE_WORKFLOW_MODAL);
          }}
        >
          Change workflow
        </s-button>
      );
    return (
      <s-stack key={run.id} gap="small-300">
        <FlagBanner
          run={run}
          actions={
            /* No `slot` on the buttons, so they sit in the banner body,
               which puts no gap between children; the stack supplies it. */
            actions.editReason || actions.liftFlag ? (
              <s-stack direction="inline" gap="small-300">
                {actions.editReason && (
                  <s-button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      openModal(BLOCK_MODAL, run);
                    }}
                  >
                    Edit reason
                  </s-button>
                )}
                {actions.liftFlag && (
                  <s-button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      liftFlag.mutate({
                        runId: run.id,
                        toast: Domain.runIsBlocked(run)
                          ? "Run unblocked"
                          : "Flag dismissed",
                      });
                    }}
                  >
                    {liftFlagLabel(run)}
                  </s-button>
                )}
              </s-stack>
            ) : null
          }
        />
        {now !== null && <s-text>{now}</s-text>}
        <RunNote
          note={run.note}
          canEdit={actions.note}
          pending={pending}
          onEdit={() => {
            openModal(NOTE_MODAL, run);
          }}
        />
        {attention}
        <s-stack direction="inline">
          <s-button
            variant="secondary"
            icon={managingRun(run) ? "chevron-up" : "chevron-down"}
            onClick={() => {
              setManaging((current) => {
                const next = new Set(current);
                if (!next.delete(run.id)) next.add(run.id);
                return next;
              });
            }}
          >
            Manage
          </s-button>
        </s-stack>
        {managingRun(run) && manageRows(run, tasks, actions, change)}
      </s-stack>
    );
  };

  /**
   * The select and its Start, at rest under an item with no run: the item's
   * empty state rather than an edit, so it is the one workflow control not in
   * a modal. A change on a running item goes through the Change workflow
   * modal instead, which deletes what is there.
   *
   * The options are the matched workflows first, then every other active
   * workflow ({@link Domain.lineItemState}): on an ambiguous item the item
   * has no Manage, so the select is the only way to a workflow the tags did
   * not pull in. On a cancelled item the cancelled workflow is among them;
   * picking it starts a fresh run.
   *
   * A grid, not an inline stack: a Polaris form control fills the inline size
   * it is given and has no width prop, so `s-select` in an inline stack takes
   * the whole row and pushes the submit onto the next line at every window
   * width. The leading label cell is an `s-text` rather than the select's own
   * label so the visible word stays "Workflow" while the accessible name
   * stays the verb.
   */
  const workflowPicker = (
    item: Domain.OrderLineItem,
    options: readonly Domain.Workflow[],
    matched: readonly Domain.WorkflowId[],
  ) => {
    const chosen = attachChoice[item.id];
    return (
      <s-grid
        gridTemplateColumns="max-content minmax(0, 20rem) auto"
        gap="base"
        alignItems="center"
        justifyContent="start"
      >
        <s-text color="subdued">Workflow</s-text>
        <s-select
          label="Choose workflow"
          labelAccessibilityVisibility="exclusive"
          placeholder="Choose workflow"
          value={chosen ?? ""}
          disabled={pending}
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
              {index > 0 && index === matched.length && (
                <s-option value="" disabled>
                  —
                </s-option>
              )}
              <s-option value={workflow.id}>{workflow.name}</s-option>
            </React.Fragment>
          ))}
        </s-select>
        <s-button
          variant="secondary"
          disabled={pending || !chosen}
          onClick={() => {
            if (chosen)
              attachMutation.mutate({
                lineItemId: item.id,
                workflowId: chosen,
              });
          }}
        >
          Start
        </s-button>
      </s-grid>
    );
  };

  /**
   * One line item's card: title, facts, properties, then the body its
   * {@link Domain.lineItemState} kind draws. On a closed order the resting
   * controls of `startable` and `unmatched` draw nothing: the page banner
   * already says why no work can start.
   */
  const renderLineItem = (item: Domain.OrderLineItem) => {
    const toMake = Domain.unitsToMake(item);
    const itemState = Domain.lineItemState(item, runs, itemWorkflows);
    /**
     * Quantity and SKU, as one subdued line under the title. No product tags:
     * they were "why a workflow matched", and on an ambiguous item the
     * picker's option list, matches first, is that answer now.
     */
    const facts = [
      /* Ordered vs. to make differ after an edit or a refund; shipping does not move it ({@link Domain.unitsToMake}). */
      toMake === item.quantity
        ? `× ${formatNumber(item.quantity)}`
        : `× ${formatNumber(toMake)} to make (${formatNumber(item.quantity)} ordered)`,
      ...(item.sku === null ? [] : [`SKU ${item.sku}`]),
    ].join(" · ");
    /**
     * A `switch` rather than `Match`: the branches return JSX, and a JSX
     * arrow in an object literal reads to oxlint as a component defined in
     * render. TypeScript still refuses a missing kind, through `never`.
     */
    const body = ((): React.ReactNode => {
      switch (itemState.kind) {
        case "removed": {
          return null;
        }
        case "unmatched": {
          return orderOpen ? (
            <s-paragraph color="subdued">
              No workflows can start.{" "}
              <s-link href="/app/workflows">Create one.</s-link>
            </s-paragraph>
          ) : null;
        }
        case "startable": {
          return orderOpen ? (
            <>
              {itemState.ambiguous && (
                <s-paragraph>{AMBIGUITY_SENTENCE}</s-paragraph>
              )}
              {workflowPicker(item, itemState.options, itemState.matched)}
            </>
          ) : null;
        }
        /* The one place the cancelled workflow's name survives, and the
           consequence the Cancel run modal promised, then the picker. */
        case "cancelled": {
          return (
            <>
              <s-paragraph color="subdued">
                {`${itemState.run.workflowName} workflow cancelled \u00B7 `}
                {itemState.run.cancelledAt !== null && (
                  <LocalDateTime
                    value={itemState.run.cancelledAt}
                    format="relative"
                  />
                )}
                {orderOpen && itemState.startable
                  ? ". Nothing starts on this item until you choose a workflow."
                  : "."}
              </s-paragraph>
              {orderOpen &&
                itemState.startable &&
                workflowPicker(item, itemState.options, itemState.matched)}
            </>
          );
        }
        case "running":
        case "finished": {
          return renderRun(item, itemState.run, itemState.tasks);
        }
        default: {
          return itemState satisfies never;
        }
      }
    })();
    const run =
      itemState.kind === "running" ||
      itemState.kind === "finished" ||
      itemState.kind === "cancelled"
        ? itemState.run
        : null;
    /* No `accessibilityLabel` on the section: with no `heading`, `s-section`
       renders the label as a second, hidden heading and screen readers hear
       the title twice. The `s-heading` inside is the section's name. */
    return (
      <s-section key={item.id}>
        <s-stack gap="small-100">
          {/* The facts sit under the title as its subtitle, tight to it, so
              the card opens with one block rather than a title and a lone
              "× 1" a full gap apart. The run's badges end the facts line
              ({@link runBadges}). */}
          <s-stack gap="small-500">
            <s-heading>{lineItemTitle(item)}</s-heading>
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text color="subdued">{facts}</s-text>
              {item.currentQuantity === 0 && (
                <s-badge tone="critical">Removed</s-badge>
              )}
              {run !== null && runBadges(run)}
            </s-stack>
          </s-stack>

          {/* "Properties" is Shopify's merchant-facing name for the list: the
              Help Center says "line item properties", REST and Liquid say
              properties, only the GraphQL API says customAttributes.
              Shortened because the heading already sits inside the line
              item's card. The rows are the work page's
              ({@link LineItemProperties}). */}
          {item.properties.length > 0 && (
            <s-stack gap="small-300">
              <s-text color="subdued">Properties</s-text>
              <LineItemProperties properties={item.properties} />
            </s-stack>
          )}

          {body !== null && body !== undefined && (
            <s-stack gap="small-100">{body}</s-stack>
          )}
        </s-stack>
      </s-section>
    );
  };

  return (
    <s-page heading={order.name} inlineSize="base">
      {/* No search on the link: the layout's middleware carries the
          merchant's filters and page back to the list (`OrdersSearch` in
          `app.orders.tsx`). */}
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
        !orderOpen ||
        order.lineItemsTruncated ||
        state === "ready_to_ship") && (
        /* In the main column, not `slot="supplemental-start"`: that slot
           renders above the main column only, so anything in it pushes the
           first card below the top of the aside. Here the banners are the
           first thing in the column and the card under them still lines up
           with the aside's top edge. */
        <s-stack gap="base">
          {/* The closed order, said once for the whole page rather than on
              every item ({@link Domain.canAttachRun}). The items keep their
              badges and banners; what goes is every write that does work. */}
          {!orderOpen && (
            <s-banner
              tone={Domain.isCancelled(order) ? "critical" : "info"}
              heading={
                Domain.isCancelled(order)
                  ? "Cancelled in Shopify"
                  : "Fulfilled in Shopify"
              }
            >
              Work on this order is read-only. Dismiss the flags to clear them
              from the team views.
            </s-banner>
          )}
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
          mount a dialog under every line item of every order. The select
          lives in it rather than inline under Manage because a filled slot
          is changed in a modal; only an empty one is filled at rest. */}
      <s-modal
        id={CHANGE_WORKFLOW_MODAL}
        heading="Change workflow?"
        onAfterHide={() => {
          setChanging(null);
        }}
      >
        <s-stack gap="base">
          <s-select
            label="Workflow"
            placeholder="Choose workflow"
            value={changing?.workflowId ?? ""}
            disabled={pending}
            onChange={(event) => {
              const workflowId = event.currentTarget.value;
              setChanging((current) =>
                current === null
                  ? null
                  : {
                      ...current,
                      workflowId: workflowId === "" ? null : workflowId,
                    },
              );
            }}
          >
            {(changing?.options ?? []).map((workflow) => (
              <s-option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </s-option>
            ))}
          </s-select>
          <s-paragraph>{changingWarning}</s-paragraph>
        </s-stack>
        {/* No onClick: `onAfterHide` is the one reset, for Keep, the backdrop and
            Escape alike, and it runs after the close so the label does not
            flip to "Cancel" mid-animation. */}
        <s-button
          slot="secondary-actions"
          commandFor={CHANGE_WORKFLOW_MODAL}
          command="--hide"
        >
          {changing === null ? "Cancel" : `Keep ${changing.from}`}
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={attachMutation.isPending}
          disabled={
            pending || changing === null || changing.workflowId === null
          }
          onClick={() => {
            if (changing !== null && changing.workflowId !== null)
              attachMutation.mutate({
                lineItemId: changing.lineItemId,
                workflowId: changing.workflowId,
              });
          }}
        >
          Change workflow
        </s-button>
      </s-modal>

      {/* Cancel run deletes the run's tasks and note and leaves the item
          cancelled (`Domain.RunStatus`), so the question is asked here and
          names the loss; there is no undo after it. */}
      <s-modal
        id={CANCEL_RUN_MODAL}
        heading="Cancel this run?"
        onAfterHide={() => {
          setCancelling(null);
        }}
      >
        <s-paragraph>{cancellingWarning}</s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={CANCEL_RUN_MODAL}
          command="--hide"
        >
          Keep run
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={cancel.isPending}
          disabled={pending || cancelling === null}
          onClick={() => {
            if (cancelling !== null)
              cancel.mutate({
                runId: cancelling.runId,
                toast: "Run cancelled.",
              });
          }}
        >
          Cancel run
        </s-button>
      </s-modal>

      {/* Reassign changes a filled slot, so it is a modal like Change
          workflow; the select opens on the current team so the merchant
          sees what they are replacing. */}
      <s-modal
        id={REASSIGN_MODAL}
        heading={
          reassigning === null ? "Reassign" : `Reassign ${reassigning.taskName}`
        }
        onAfterHide={() => {
          setReassigning(null);
        }}
      >
        <s-select
          label="Team"
          value={reassigning?.teamId ?? ""}
          disabled={pending}
          {...(reassigning === null || reassigning.error === null
            ? {}
            : { error: reassigning.error })}
          onChange={(event) => {
            const teamId = event.currentTarget.value;
            setReassigning((current) =>
              current === null ? null : { ...current, teamId, error: null },
            );
          }}
        >
          {teamOptions(teams)}
        </s-select>
        <s-button
          slot="secondary-actions"
          commandFor={REASSIGN_MODAL}
          command="--hide"
        >
          {reassigning === null ? "Cancel" : `Keep ${reassigning.teamName}`}
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={reassign.isPending}
          disabled={
            pending || reassigning === null || reassigning.teamId === ""
          }
          onClick={() => {
            if (reassigning !== null && reassigning.teamId !== "")
              reassign.mutate({
                runTaskId: reassigning.runTaskId,
                teamId: reassigning.teamId,
              });
          }}
        >
          Assign
        </s-button>
      </s-modal>

      <RunNoteModal
        id={NOTE_MODAL}
        note={modalRun?.note ?? null}
        pending={pending}
        onSave={(text) =>
          modalRun === null
            ? Promise.resolve("That workflow run no longer exists.")
            : fromModal(
                note.mutateAsync({
                  runId: modalRun.id,
                  text: textOrNull(text),
                  toast: "Note saved",
                }),
              )
        }
      />
      <BlockModal
        id={BLOCK_MODAL}
        run={
          modalRun ?? { orderName: order.name, flag: null, flagDetail: null }
        }
        pending={pending}
        onBlock={(reason) =>
          modalRun === null
            ? Promise.resolve("That workflow run no longer exists.")
            : fromModal(
                block.mutateAsync({
                  runId: modalRun.id,
                  text: textOrNull(reason),
                  toast: "Run blocked",
                }),
              )
        }
        onSaveReason={(reason) =>
          modalRun === null
            ? Promise.resolve("That workflow run no longer exists.")
            : fromModal(
                editReason.mutateAsync({
                  runId: modalRun.id,
                  text: textOrNull(reason),
                  toast: "Reason saved",
                }),
              )
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
        </s-grid>
      </s-section>
    </s-page>
  );
}

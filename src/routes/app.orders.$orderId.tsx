import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import {
  BlockBanner,
  ClosedLine,
  LineItemProperties,
  RunNote,
} from "@/components/MemberRun";
import { RunSteps } from "@/components/RunSteps";
import { BlockModal, RunNoteModal } from "@/components/RunTextModals";
import { Clamp } from "@/components/screen/Clamp";
import { Inline } from "@/components/screen/Inline";
import { Lines } from "@/components/screen/Lines";
import { type Pair, Pairs } from "@/components/screen/Pairs";
import { Panel } from "@/components/screen/Panel";
import { Prose } from "@/components/screen/Prose";
import { SelectRow } from "@/components/screen/SelectRow";
import { Things } from "@/components/screen/Things";
import { Token } from "@/components/screen/Token";
import {
  CANCEL_WARNING,
  cancelHeading,
  changeWarning,
} from "@/lib/changeWarning";
import * as Domain from "@/lib/Domain";
import { formatNumber, formatStatus } from "@/lib/format";
import { adminOrderUrl, useResourceLinkTarget } from "@/lib/orderLinks";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";
import { hideModal, showModal } from "@/lib/polarisModal";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useLiveQuery } from "@/lib/useLiveQuery";
import { errorMessage, textOrNull } from "@/lib/useMemberRunActions";

const orderQueryKey = (shop: string, legacyId: string) =>
  ["order", shop, legacyId] as const;

/** See the note on `decodeOrdersIndexData` in `app.orders.index.tsx`. */
const decodeDetail = Schema.decodeUnknownPromise(
  Schema.toType(Schema.NullOr(Domain.OrderPageData)),
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
const decodeSyncOrderResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.SyncOrderResult),
);

const connecting = () =>
  Promise.reject(new Error("Still connecting. Try again in a moment."));

const attachResultMessage = Match.typeTags<
  Domain.AttachResult,
  string | null
>()({
  Ok: () => null,
  AlreadyExists: () => "That workflow is already on this item.",
  LineItemNotFound: () => "That item no longer exists.",
  WorkflowNotEligible: () =>
    "That workflow can't start: it's off, has no steps, or has a task with no team.",
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
  TaskDone: () => "That task is already done and keeps its team.",
  /* The item's workflow was done or closed between the render and the click. */
  RunNotOpen: () => "That item's workflow is done or closed.",
  NotAllowed: () => "That task can no longer be assigned.",
});

/**
 * A refused run write's toast, in the `toast` slot's form (a fact in the
 * present tense; `CopySlot` in `Screen.ts`). The page offers a write only
 * where `Domain.runActions` or `Domain.taskActions` allows it and the server
 * checks the same field, so `NotAllowed` is the run changing between the
 * render and the click ({@link Domain.RunResult}): the sentence names the
 * task for a task verb and the workflow for a run verb.
 */
const runResultMessage = (
  result: Domain.RunResult,
  subject: "task" | "workflow",
) =>
  Match.value(result).pipe(
    Match.tagsExhaustive({
      Ok: () => null,
      /* Another admin changed the item's workflow, or the order was deleted. */
      NotFound: () => "That workflow is no longer on this item",
      NotAllowed: () => `The ${subject} changed on another screen`,
    }),
  );

/**
 * Merchant words, not `Run.state`. An open run nobody has touched
 * ({@link Domain.runIsUnstarted}) reads {@link Domain.RUN_UNSTARTED_LABEL}, not
 * {@link Domain.RUN_STATE_LABEL}'s `open`:
 * the merchant is asking whether the bench has picked it up yet, and the
 * stored state cannot say, since a run is `open` from creation. Closed is
 * neutral, not red: the work ended and nothing waits on anyone
 * ({@link Domain.RunState}); red stays for a hold. The reason is the line
 * under it ({@link ClosedLine}), not a badge of its own.
 */
const RUN_STATE_BADGE = {
  open: { label: Domain.RUN_STATE_LABEL.open, tone: "info" },
  done: { label: Domain.RUN_STATE_LABEL.done, tone: "success" },
  closed: { label: Domain.RUN_STATE_LABEL.closed, tone: "neutral" },
} as const satisfies Record<Domain.RunState, { label: string; tone: string }>;

/** {@link RUN_STATE_BADGE}'s open run before any task is started or done. */
const NOT_STARTED_BADGE = {
  label: Domain.RUN_UNSTARTED_LABEL,
  tone: "neutral",
} as const;

const runStateBadge = (run: Domain.Run, tasks: readonly Domain.RunTaskRow[]) =>
  Domain.runIsOpen(run) && Domain.runIsUnstarted(tasks)
    ? NOT_STARTED_BADGE
    : RUN_STATE_BADGE[run.state];

/** The one modal that both asks and confirms: the select and, on a touched run, the warning. */
const CHANGE_WORKFLOW_MODAL = "change-workflow";
const CANCEL_RUN_MODAL = "cancel-run";
const ASSIGN_MODAL = "assign-task";
const NOTE_MODAL = "run-note";
const BLOCK_MODAL = "run-block";

/**
 * The multi-match item's sentence: why the merchant is being asked, and nothing
 * that can drift from the select under it. It does not count the matches,
 * because a count that must agree with a list is a second source of truth; it
 * does not name the tags, because the merchant changes the workflow here, not
 * the product.
 */
const MULTI_MATCH_SENTENCE =
  "More than one workflow matches this item, so none was started.";

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

/** The teams as select options: names only (the controls table's "a choice among records" row on `Control`). */
const teamOptions = (teams: readonly Domain.TeamWithMemberCount[]) =>
  teams.map((team) => (
    <s-option key={team.id} value={team.id}>
      {team.name}
    </s-option>
  ));

const lineItemTitle = ({ title, variantTitle }: Domain.OrderLineItem) =>
  variantTitle === null ? title : `${title} — ${variantTitle}`;

/**
 * One row of the facts ({@link Pairs}). Empty facts return nothing rather
 * than an em dash: a column of placeholder dashes is noise that pushes the
 * facts that do exist off screen.
 */
const fact = (label: string, value: React.ReactNode): readonly Pair[] =>
  value === null || value === undefined || value === ""
    ? []
    : [{ key: label, label, value }];

const stepCount = (tasks: readonly Domain.RunTask[]) =>
  tasks.reduce((max, task) => Math.max(max, task.step), 0);

/**
 * Where the run is, as the card's one read-only answer: `Step 1 of 3 · Cut ·
 * since 3:10 PM`, or `Step 2 of 3 · 3 tasks · since 3:10 PM` on a parallel
 * step. Position and task names only: the team is inside Manage, on
 * its own line under the task, where a 32-character team name has room. It
 * replaced the inline task trail, which said the same thing in a notation the
 * merchant had to learn — a step number, bold for current, `✓` and `●` marks,
 * the team in parentheses.
 *
 * Deliberately a second phrasing beside {@link RunSteps}, not a call into it.
 * That one describes *each task* inside the Manage disclosure, in the
 * member's workflow page's vocabulary, so the merchant and the worker say the same thing about
 * the same task. This one describes *the run* on a collapsed card and has to
 * cover a parallel step (several current tasks at once), which is not a task
 * state. Keeping them apart is cheaper than a shared function with a mode flag.
 *
 * It renders on a blocked run too. That is the one card where "why it
 * stopped" and "where it is" are different questions: the banner above
 * answers the first and this line the second. A blocked run is still open
 * ({@link Domain.runIsOpen}), so its current tasks are the ones the hold
 * stopped.
 */
const nowLine = ({ run, tasks }: Domain.RunDetail): React.ReactNode => {
  /* A closed run's line is its reason ({@link ClosedLine}), not a position. */
  if (Domain.runIsClosed(run)) return null;
  /* Counts steps, like the open form's `of M`: the number the merchant saw
     climb to `Step 2 of 2` must not become `3 steps` the day the run is done. */
  if (!Domain.runIsOpen(run)) {
    const steps = stepCount(tasks);
    return `Done \u00B7 ${formatNumber(steps)} step${steps === 1 ? "" : "s"}`;
  }
  const current = Domain.currentTasks(run, tasks);
  const lowest = Domain.lowestOpenStep(tasks);
  /* Every remaining task unassigned, or an inconsistent run: the team issue
     rows below are the answer, not a position. */
  if (current.length === 0 || lowest === null) return null;
  /* The name, or on a parallel step a count. Every current task can carry a
     name at `Domain.NAME_MAX_LENGTH`: listing three runs the line to four rows,
     and `<name> and 2 more` reads as part of the name when the name is long.
     The Manage drawer lists each task; this line says where the run is. */
  const names =
    current.length === 1
      ? current[0].name
      : `${formatNumber(current.length)} tasks`;
  /** The step's start, not a task's: on a parallel step the earliest claim is when the run got here. */
  const since = current.reduce<number | null>((earliest, task) => {
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

/** A run's tasks with the merchant's actions, as {@link teamIssueRows} reads them. */
type ActionableTask = Domain.RunTaskRow & {
  readonly actions: Domain.TaskActions;
};

/**
 * The `team` issue on a run: one row per open task whose team is gone, named
 * with an Assign team select, the remedy that makes a team delete safe.
 * Follows {@link Domain.taskActions}' `assign`, because the select is that
 * write.
 */
const unassignedRows = (
  tasks: readonly ActionableTask[],
  teams: readonly Domain.TeamWithMemberCount[],
  assign: (runTaskId: string) => React.ReactNode,
) =>
  tasks
    .filter(({ actions }) => actions.assign)
    .filter((task) => Domain.runTaskIsUnassigned(task, teams))
    .map((task) => (
      <Lines key={task.id}>
        {/* The semantic `<strong>` only: at Polaris's regular weight it
            reads as the line's emphasis to a screen reader, and the select
            under it is what the eye goes to. */}
        <s-text type="strong">{`${task.name}: assign a team.`}</s-text>
        {assign(task.id)}
      </Lines>
    ));

/**
 * The team issue of a run, {@link unassignedRows}, against the shop's live
 * teams {@link Domain.OrderPageData} carries; `null` when it has none.
 *
 * They render on the card, outside the Manage disclosure, because they are the
 * one thing that must be acted on and a disclosure would hide it. Every other
 * intervention — moving a task to another team, notes, block, cancel —
 * is inside Manage: one place to act on a run rather than two, and nothing on
 * the card is a click target, so scanning an order never risks a stray "done".
 */
const teamIssueRows = (
  tasks: readonly ActionableTask[],
  teams: readonly Domain.TeamWithMemberCount[],
  assign: (runTaskId: string) => React.ReactNode,
) => {
  const unassigned = unassignedRows(tasks, teams, assign);
  if (unassigned.length === 0) return null;
  return <Lines>{unassigned}</Lines>;
};

const OrderParams = Schema.Struct({ legacyId: Schema.String });

/** The loader read of the live screen; see the index's `getLoaderData`. */
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
 * One order: its note, every item with its properties and workflow
 * runs, and the order's facts. Live like the index: the loader paints, then
 * `useLiveQuery` reads `ShopAgent.getOrderDetail` over the socket on every
 * invalidation, so a webhook, sync, or member task action on this order
 * repaints the page. Every write returns a
 * tagged result that is copy-mapped into the banner rather than thrown.
 *
 * The `$orderId` param is the Shopify legacy id, so the URL matches the one
 * the admin uses for the same order (`Domain.GetOrderDetailInput`).
 *
 * The page decides no gate. Each item's card is a switch on
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
  /** The Assign team select's choice per unassigned run task. */
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
   * at-rest Workflow select, and a choice left behind in the modal would preselect
   * it after a later Cancel workflow.
   */
  const [changing, setChanging] = React.useState<{
    readonly lineItemId: string;
    readonly from: Domain.WorkflowName;
    readonly run: Domain.Run;
    readonly options: readonly Domain.WorkflowNameRow[];
    readonly tasks: readonly Domain.RunTask[];
    readonly workflowId: string | null;
  } | null>(null);
  /** The run the Cancel workflow modal asks about, with what its heading names. */
  const [cancelling, setCancelling] = React.useState<{
    readonly runId: string;
    readonly workflowName: Domain.WorkflowName;
    readonly item: string;
  } | null>(null);
  /**
   * The task the Assign team modal is about: its name for the heading, its
   * current team for the default and for "Keep …", and the modal's own pick.
   */
  const [assigning, setAssigning] = React.useState<{
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
   * reset it when new data arrives — do not. A re-read updates the query
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
  } = useLiveQuery({
    queryKey: orderQueryKey(shop, legacyId),
    read: (stub) => stub.getOrderDetail({ legacyId }).then(decodeDetail),
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
        /* The replaced run is deleted (`Domain.RunState`), and the modal
           already named what it cost, so the toast says only where the item
           is now. An attach over nothing, or over a closed run, is a fresh
           run: "Attached", never "resumed". */
        shopify.toast.show(
          result.replaced === null
            ? `Attached ${result.run.workflowName}`
            : `Changed to ${result.run.workflowName}`,
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
   * answer is the toast plus the re-render the re-read brings, exactly
   * as the worker's page behaves. `toast` is the acknowledgement, written at
   * the button so the task's own name reaches it ("Cut done").
   */
  const runWrite = (subject: "task" | "workflow") => ({
    onSuccess: async (
      result: Domain.RunResult,
      input: { readonly toast: string },
    ) => {
      if (result._tag === "Ok") shopify.toast.show(input.toast);
      else
        shopify.toast.show(
          runResultMessage(result, subject) ?? "Nothing changed",
          { isError: true },
        );
      await invalidate();
    },
    onError,
  });
  const done = useMutation({
    mutationFn: ({ runTaskId }: TaskWrite) =>
      call((stub) => stub.merchantMarkTaskDone({ runTaskId })).then(
        decodeRunResult,
      ),
    ...runWrite("task"),
  });
  const putBack = useMutation({
    mutationFn: ({ runTaskId }: TaskWrite) =>
      call((stub) => stub.merchantPutBackTask({ runTaskId })).then(
        decodeRunResult,
      ),
    ...runWrite("task"),
  });
  const reopen = useMutation({
    mutationFn: ({ runTaskId }: TaskWrite) =>
      call((stub) => stub.merchantReopenTask({ runTaskId })).then(
        decodeRunResult,
      ),
    ...runWrite("task"),
  });
  const note = useMutation({
    mutationFn: ({ runId, text }: TextWrite) =>
      call((stub) => stub.merchantSetRunNote({ runId, note: text })).then(
        decodeRunResult,
      ),
    ...runWrite("workflow"),
  });
  const block = useMutation({
    mutationFn: ({ runId, text }: TextWrite) =>
      call((stub) => stub.merchantBlockRun({ runId, reason: text })).then(
        decodeRunResult,
      ),
    ...runWrite("workflow"),
  });
  const unblock = useMutation({
    mutationFn: ({ runId }: RunWrite) =>
      call((stub) => stub.merchantUnblockRun({ runId })).then(decodeRunResult),
    ...runWrite("workflow"),
  });
  const cancel = useMutation({
    mutationFn: ({ runId }: RunWrite) =>
      call((stub) => stub.merchantCancelRun({ runId })).then(decodeRunResult),
    ...runWrite("workflow"),
    onSuccess: async (result: Domain.RunResult, input: RunWrite) => {
      if (result._tag === "Ok") {
        setCancelling(null);
        hideModal(CANCEL_RUN_MODAL);
      }
      await runWrite("workflow").onSuccess(result, input);
    },
  });

  const assign = useMutation({
    mutationFn: (input: typeof Domain.AssignRunTaskTeamInput.Encoded) =>
      call((stub) => stub.merchantAssignRunTaskTeam(input)).then(
        decodeAssignResult,
      ),
    onSuccess: async (result, { runTaskId }) => {
      const message = assignResultMessage(result);
      /* The unassigned row's select has no modal to hold a message, so its
         refusal goes to the page banner; the modal keeps its own. */
      if (assigning?.runTaskId === runTaskId) {
        if (message === null) {
          setAssigning(null);
          hideModal(ASSIGN_MODAL);
        } else
          setAssigning((current) =>
            current === null ? null : { ...current, error: message },
          );
      } else setBanner(message);
      await invalidate();
    },
    onError,
  });

  const syncMutation = useMutation({
    mutationFn: (orderId: string) =>
      call((stub) => stub.syncOrder({ orderId })).then(decodeSyncOrderResult),
    /**
     * A toast (`CopySlot`): `Gone` is Sync from Shopify doing nothing, and
     * the page would otherwise refetch the same stored order and say
     * nothing about why (`Domain.SyncOrderResult`).
     */
    onSuccess: async (result) => {
      if (result._tag === "Gone")
        shopify.toast.show("Shopify no longer has this order");
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
            : "Couldn't load the order."}
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
          {`This order isn't in Baton. It may be older than ${String(ORDER_SYNC_WINDOW_DAYS)} days, or deleted in Shopify.`}
        </s-paragraph>
      </s-page>
    );

  const { order, lineItems, runs, matchedWorkflows, otherWorkflows, teams } =
    detail;
  const orderOpen = Domain.orderIsOpen(order);
  /**
   * The same aggregate the index computes in SQL, rebuilt from the runs
   * this page already carries so both pages read one `orderPosition`.
   * Only the `made` banner reads it: every other state here is per item, and
   * the cards carry it.
   */
  const state = Domain.orderPosition({
    order,
    runs: Domain.runCounts(runs.map(({ run }) => run)),
  });
  /** See `managing`: an id with no run on this order is stale and answers `false`. */
  const managingRun = (run: Domain.Run) =>
    managing.has(run.id) && runs.some((other) => other.run.id === run.id);
  const busy = [
    attachMutation,
    done,
    putBack,
    reopen,
    note,
    block,
    unblock,
    cancel,
    assign,
  ].some((mutation) => mutation.isPending);
  const pending = !identified || busy;
  /** A modal's write: `null` closes it, a message stays under its field. */
  const fromModal = (write: Promise<Domain.RunResult>) =>
    write
      .then((result) =>
        result._tag === "Ok"
          ? null
          : (runResultMessage(result, "workflow") ?? "Nothing changed"),
      )
      .catch(errorMessage);
  const openModal = (modalId: string, run: Domain.Run) => {
    setModalRunId(run.id);
    showModal(modalId);
  };
  const modalRun = runs.find(({ run }) => run.id === modalRunId)?.run ?? null;
  /**
   * The modal's warning, empty until a workflow is picked; on a run with no
   * record it is empty too, the rule on {@link changeWarning}.
   */
  const changingWarning = (() => {
    if (changing === null || changing.workflowId === null) return "";
    const to =
      changing.options.find((workflow) => workflow.id === changing.workflowId)
        ?.name ?? "";
    return changeWarning(changing.from, to, changing.run, changing.tasks);
  })();
  /**
   * The Assign team select and Assign button beside an unassigned task in
   * `unassignedRows`, open at rest because a task with no team is a required
   * field left empty, the one thing on the card that must be acted on. A task
   * that has a team changes it through the Assign team modal instead: a filled
   * field is changed in a modal, an empty one is filled at rest.
   *
   * The select starts empty so Assign stays disabled until a team is chosen.
   */
  const assignTeam = (runTaskId: string) => (
    <SelectRow
      select={
        <s-select
          label={Domain.VERB_LABEL.assign.merchant}
          labelAccessibilityVisibility="exclusive"
          placeholder={Domain.VERB_LABEL.assign.merchant}
          value={assignChoice[runTaskId] ?? ""}
          disabled={pending}
          onChange={(event) => {
            const teamId = event.currentTarget.value;
            setAssignChoice((choice) => ({ ...choice, [runTaskId]: teamId }));
          }}
        >
          {teamOptions(teams)}
        </s-select>
      }
      submit={
        <s-button
          variant="secondary"
          disabled={pending || !assignChoice[runTaskId]}
          onClick={() => {
            const teamId = assignChoice[runTaskId];
            if (teamId) assign.mutate({ runTaskId, teamId });
          }}
        >
          Assign
        </s-button>
      }
    />
  );

  /**
   * The Manage disclosure: the member page's step cards with the merchant's
   * buttons ({@link RunSteps} states their shape), under a header line naming
   * the workflow, because the card does not; then the run-level actions —
   * Block, Cancel workflow, Change workflow — in one row under a rule. Every
   * intervention lives here and nowhere else, so the card above stays a
   * read-only glance: item, state, where the run is, and its team issues.
   *
   * No action here is primary — not `Done`, not `Block`. Every write on
   * this page is a merchant reaching past a worker — the bench claims and
   * marks tasks done on the member's workflow page — and a primary button
   * is the grammar of
   * "this is what you came here to do", which is false here. Nothing here is
   * red either: Polaris puts the critical tone on the button that performs a
   * destructive action, not on the one that opens the question, and Cancel
   * run and Change workflow each open a modal whose submit is red. Assign
   * team is tertiary: it opens a modal rather than writing, and it sits on every
   * open task.
   *
   * The note is on the card ({@link RunNote}) and has no button here.
   */
  const manageRows = (
    run: Domain.Run,
    tasks: readonly (Domain.RunTaskRow & {
      readonly actions: Domain.TaskActions;
    })[],
    actions: Domain.RunActions,
    /**
     * The `Change workflow` button. It arrives as a node rather than a
     * callback because opening the modal needs the item it belongs to —
     * its options and its run's tasks — which a run-level helper does not
     * hold.
     */
    change: React.ReactNode | null,
  ) => {
    const byId = new Map(tasks.map((task) => [task.id, task.actions]));
    const runRow = actions.block || actions.cancel || change !== null;
    /* A drawer ({@link Panel}) the header's Manage button owns. */
    return (
      <Panel kind="drawer">
        <Lines>
          <s-heading>{`${run.workflowName} workflow`}</s-heading>
          <RunSteps
            tasks={tasks}
            showInstructions={false}
            renderActions={(task) => {
              const can = byId.get(task.id);
              if (can === undefined) return null;
              if (!can.done && !can.putBack && !can.reopen && !can.assign)
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
                          toast: `${task.name} done`,
                        });
                      }}
                    >
                      {Domain.VERB_LABEL.done.merchant}
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
                      {Domain.VERB_LABEL.putBack.merchant}
                    </s-button>
                  )}
                  {can.reopen && (
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
                      {Domain.VERB_LABEL.reopen.merchant}
                    </s-button>
                  )}
                  {can.assign && (
                    <s-button
                      variant="tertiary"
                      disabled={pending}
                      onClick={() => {
                        setAssigning({
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
                        showModal(ASSIGN_MODAL);
                      }}
                    >
                      {Domain.VERB_LABEL.assign.merchant}
                    </s-button>
                  )}
                </>
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
            <Inline>
              {actions.block && (
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    openModal(BLOCK_MODAL, run);
                  }}
                >
                  {Domain.VERB_LABEL.block.merchant}
                </s-button>
              )}
              {actions.cancel && (
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setCancelling({
                      runId: run.id,
                      workflowName: run.workflowName,
                      item:
                        run.variantTitle === null
                          ? run.lineItemTitle
                          : `${run.lineItemTitle} — ${run.variantTitle}`,
                    });
                    showModal(CANCEL_RUN_MODAL);
                  }}
                >
                  {Domain.VERB_LABEL.cancel.merchant}
                </s-button>
              )}
              {change}
            </Inline>
          )}
        </Lines>
      </Panel>
    );
  };

  /**
   * A run's badges: its state, and Blocked while
   * {@link Domain.runIsBlocked}; no buttons. They end the card's facts line, under the title, because the
   * badge is the item's state at a glance and belongs next to the item it
   * describes; on a line of their own lower down they read as belonging to
   * whatever sat above them. The Blocked badge stays while the banner shows:
   * the badge is the glance, and the banner, with the reason and Unblock, is
   * the detail further down.
   */
  const runBadges = (run: Domain.Run, tasks: readonly Domain.RunTaskRow[]) => (
    <>
      <s-badge tone={runStateBadge(run, tasks).tone}>
        {runStateBadge(run, tasks).label}
      </s-badge>
      {Domain.runIsBlocked(run) && (
        <s-badge tone="critical">{Domain.RUN_STATE_LABEL.blocked}</s-badge>
      )}
    </>
  );

  /**
   * One run inside its item's card, below the item's title, facts and
   * properties. Top to bottom: the {@link ClosedLine} on a closed run (why
   * and when it ended), the {@link BlockBanner} while blocked (why it
   * stopped, with Unblock), the Now line (where it is), the
   * {@link RunNote}, the team issue rows, then Manage and, when open, the
   * disclosure it toggles. The badges are on the facts line
   * ({@link runBadges}). A closed run keeps its tasks as the record, so
   * Manage still lists them, with no buttons ({@link Domain.taskActions}).
   *
   * The banner stays in the run block rather than above the item title: it
   * is about the run (Unblock, the reason and who set it all act on or
   * describe the run), and a card that opened on red would not yet say which
   * item it is about.
   *
   * Manage sits directly above the drawer it opens rather than in the card
   * header. It is a disclosure, not an action on the card, and a disclosure
   * belongs next to what it reveals; in the header it was the full card away
   * from its drawer, and a long title wrapped it onto a line of its own. The
   * label stays `Manage` in both states with a flipping chevron — `Hide`
   * reads as hiding the card, and `Done` collides with the task's Done
   * inside the disclosure it toggles.
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
   * The card is headed by the item, and the run line is the state badge
   * and where the run is. The workflow's name is the Manage drawer's header
   * (`manageRows`): the merchant who wants it is the one who opened Manage,
   * and on a shop whose workflows are named after products the card would
   * otherwise print one string twice.
   */
  const renderRun = (
    item: Domain.OrderLineItem,
    run: Domain.Run,
    views: readonly Domain.RunTaskRow[],
  ) => {
    const tasks = views.map((task) => ({
      ...task,
      actions: Domain.taskActions(MERCHANT, order, run, task),
    }));
    const actions = Domain.runActions(MERCHANT, order, run, tasks, item);
    const now = nowLine({ run, tasks });
    const teamIssues = teamIssueRows(tasks, teams, assignTeam);
    const options = [
      ...matchedWorkflows.map(({ workflow }) => workflow),
      ...otherWorkflows,
    ].filter(
      (workflow) => !Domain.runIsOpen(run) || workflow.id !== run.workflowId,
    );
    /**
     * `Change workflow`, handed to `manageRows`. Absent when the field is
     * false, when the shop's only workflow that is on is the one an open run
     * already has, and on a closed run, whose item takes a new workflow from
     * the Workflow select at rest under it ({@link workflowSelect}). A done run gets
     * it here rather than the select because replacing it loses a record, and
     * the modal is where the `confirm` slot names what ({@link changeWarning}).
     */
    const change =
      !actions.changeWorkflow ||
      options.length === 0 ||
      Domain.runIsClosed(run) ? null : (
        <s-button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setChanging({
              lineItemId: item.id,
              from: run.workflowName,
              run,
              options,
              tasks,
              workflowId: null,
            });
            showModal(CHANGE_WORKFLOW_MODAL);
          }}
        >
          {Domain.VERB_LABEL.changeWorkflow.merchant}
        </s-button>
      );
    return (
      <Lines key={run.id}>
        <ClosedLine run={run} viewer="merchant" />
        <BlockBanner
          run={run}
          actions={
            /* No `slot` on the buttons, so they sit in the banner body,
               which puts no gap between children; the stack supplies it. */
            actions.unblock ? (
              <Inline>
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    unblock.mutate({
                      runId: run.id,
                      toast: "Unblocked",
                    });
                  }}
                >
                  {Domain.VERB_LABEL.unblock.merchant}
                </s-button>
              </Inline>
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
        {teamIssues}
        <Inline>
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
        </Inline>
        {managingRun(run) && manageRows(run, tasks, actions, change)}
      </Lines>
    );
  };

  /**
   * The select and its Start, at rest under an item with no run: the item's
   * empty state rather than an edit, so it is the one workflow control not in
   * a modal. A change on an item with an open run goes through the Change workflow
   * modal instead, which deletes what is there.
   *
   * The options are the matched workflows first, then every other
   * workflow ({@link Domain.lineItemState}): on a multi-match item the item
   * has no Manage, so the select is the only way to a workflow the tags did
   * not pull in. On a closed item the closed workflow is among them; picking
   * it starts a fresh run.
   *
   * A {@link SelectRow}. The leading label is an `s-text` rather than the
   * select's own label so the visible word stays "Workflow" while the
   * accessible name stays the verb.
   */
  const workflowSelect = (
    item: Domain.OrderLineItem,
    options: readonly Domain.WorkflowNameRow[],
    matched: readonly Domain.WorkflowId[],
  ) => {
    const chosen = attachChoice[item.id];
    return (
      <SelectRow
        label={<s-text color="subdued">Workflow</s-text>}
        select={
          <s-select
            label="Workflow"
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
        }
        submit={
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
            {Domain.VERB_LABEL.attachWorkflow.merchant}
          </s-button>
        }
      />
    );
  };

  /**
   * One item's card: title, facts, properties, then the body its
   * {@link Domain.lineItemState} kind draws. On a closed order the resting
   * controls of `attachable`, `unmatched` and `ended` draw nothing: the
   * sidebar's Fulfillment and Cancelled lines already say why no work can
   * start.
   */
  const renderLineItem = (item: Domain.OrderLineItem) => {
    const toMake = Domain.unitsToMake(item);
    const itemState = Domain.lineItemState(
      item,
      runs,
      matchedWorkflows,
      otherWorkflows,
      teams,
    );
    /**
     * Quantity and SKU, as one subdued line under the title. No product tags:
     * they were "why a workflow matched", and on a multi-match item the
     * select's option list, matches first, is that answer now.
     */
    const facts = [
      /* Ordered vs. to make differ after an edit or a refund; fulfilment does not move it ({@link Domain.unitsToMake}). */
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
              No workflow matches this item. Create one on{" "}
              <s-link href="/app/workflows">Workflows</s-link>.
            </s-paragraph>
          ) : null;
        }
        case "attachable": {
          return orderOpen ? (
            <>
              {itemState.multiMatch && (
                <s-paragraph>{MULTI_MATCH_SENTENCE}</s-paragraph>
              )}
              {workflowSelect(item, itemState.options, itemState.matched)}
            </>
          ) : null;
        }
        /* The run as the record. Under a closed run, its reason line
           first, then what the Cancel workflow modal promised: the Workflow select,
           for a fresh run. A done run's Change workflow is in Manage, behind
           the modal that names what it loses. */
        case "ended": {
          return (
            <>
              {renderRun(item, itemState.run, itemState.tasks)}
              {orderOpen &&
                itemState.attachable &&
                Domain.runIsClosed(itemState.run) &&
                workflowSelect(item, itemState.options, itemState.matched)}
            </>
          );
        }
        case "open": {
          return renderRun(item, itemState.run, itemState.tasks);
        }
        default: {
          return itemState satisfies never;
        }
      }
    })();
    const withRun =
      itemState.kind === "open" || itemState.kind === "ended"
        ? itemState
        : null;
    /* No `accessibilityLabel` on the section: with no `heading`, `s-section`
       renders the label as a second, hidden heading and screen readers hear
       the title twice. The `s-heading` inside is the section's name. */
    return (
      <s-section key={item.id}>
        <Lines>
          {/* The facts sit under the title as its subtitle, tight to it, so
              the card opens with one block rather than a title and a lone
              "× 1" a full gap apart. The run's badges end the facts line
              ({@link runBadges}). */}
          <Lines>
            <s-heading>{lineItemTitle(item)}</s-heading>
            <Inline>
              {/* A token: a SKU is one unspaced word and may be long. */}
              <Token color="subdued">{facts}</Token>
              {item.currentQuantity === 0 && (
                <s-badge tone="critical">Removed</s-badge>
              )}
              {withRun !== null && runBadges(withRun.run, withRun.tasks)}
            </Inline>
          </Lines>

          {/* "Properties" is Shopify's merchant-facing name for the list: the
              Help Center says "line item properties", REST and Liquid say
              properties, only the GraphQL API says customAttributes.
              Shortened because the heading already sits inside the line
              item's card. The rows are the member's workflow page's
              ({@link LineItemProperties}). */}
          {item.properties.length > 0 && (
            <Lines>
              <s-text color="subdued">Properties</s-text>
              <LineItemProperties properties={item.properties} />
            </Lines>
          )}

          {body !== null && body !== undefined && <Lines>{body}</Lines>}
        </Lines>
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
          task once the work here is done. Sync from Shopify is secondary because
          webhooks keep the order current; a primary sync button tells the merchant syncing
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
        loading={syncMutation.isPending}
        disabled={!identified || syncMutation.isPending}
        onClick={() => {
          syncMutation.mutate(order.id);
        }}
      >
        Sync from Shopify
      </s-button>

      <SocketBanner />
      {/* In the main column, not `slot="supplemental-start"`: that slot
          renders above the main column only, so anything in it pushes the
          first card below the top of the aside. Here the banners are the
          first thing in the column and the card under them still lines up
          with the aside's top edge. Direct children of the page, not in a
          stack of their own: `s-page` spaces its direct children, and a
          wrapping stack sat flush against the first card.

          No banner for a closed order ({@link Domain.orderIsOpen}): the
          sidebar's Fulfillment and Cancelled lines say it, each closed run
          says why on its own card ({@link ClosedLine}), and nothing is
          waiting on the merchant. */}
      {state === "made" && (
        <s-banner tone="success">
          Every item is done.{" "}
          <s-link href={adminOrderUrl(order)} target={resourceLinkTarget}>
            Fulfill in Shopify
          </s-link>
          .
        </s-banner>
      )}
      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {lineItems.length === 0 ? (
        <s-paragraph color="subdued">No items.</s-paragraph>
      ) : (
        lineItems.map(renderLineItem)
      )}

      {/* One modal for the page, driven by `changing`: a per-item one would
          mount a dialog under every item of every order. The select
          lives in it rather than inline under Manage because a filled field
          is changed in a modal; only an empty one is filled at rest. */}
      <s-modal
        id={CHANGE_WORKFLOW_MODAL}
        heading="Change workflow?"
        onAfterHide={() => {
          setChanging(null);
        }}
      >
        <Things>
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
        </Things>
        {/* No onClick: `onAfterHide` is the one reset, for Keep, the backdrop and
            Escape alike, and it runs after the close so the label does not
            flip to "Cancel" mid-animation. */}
        <s-button
          slot="secondary-actions"
          commandFor={CHANGE_WORKFLOW_MODAL}
          command="--hide"
        >
          Cancel
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
          {Domain.VERB_LABEL.changeWorkflow.merchant}
        </s-button>
      </s-modal>

      {/* Cancel workflow closes the run (`Domain.RunState`) and there is no
          undo after it, so the question is asked here, naming the workflow
          and the item, and says what happens to the work
          ({@link CANCEL_WARNING}). The dismiss reads Keep workflow, not the
          Cancel that the controls table in `Screen.ts` gives every other modal: a
          Cancel beside a primary Cancel workflow is two Cancels. */}
      <s-modal
        id={CANCEL_RUN_MODAL}
        heading={
          cancelling === null ? "" : cancelHeading(cancelling.workflowName)
        }
        onAfterHide={() => {
          setCancelling(null);
        }}
      >
        <Lines>
          {cancelling !== null && <Clamp>{cancelling.item}</Clamp>}
          <s-paragraph>{CANCEL_WARNING}</s-paragraph>
        </Lines>
        <s-button
          slot="secondary-actions"
          commandFor={CANCEL_RUN_MODAL}
          command="--hide"
        >
          Keep workflow
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
                toast: `${cancelling.workflowName} cancelled`,
              });
          }}
        >
          {Domain.VERB_LABEL.cancel.merchant}
        </s-button>
      </s-modal>

      {/* Assign team changes a filled field, so it is a modal like Change
          workflow; the select opens on the current team so the merchant
          sees what they are replacing. */}
      <s-modal
        id={ASSIGN_MODAL}
        heading={
          assigning === null
            ? Domain.VERB_LABEL.assign.merchant
            : `${Domain.VERB_LABEL.assign.merchant}: ${assigning.taskName}`
        }
        onAfterHide={() => {
          setAssigning(null);
        }}
      >
        <s-select
          label="Team"
          value={assigning?.teamId ?? ""}
          disabled={pending}
          {...(assigning === null || assigning.error === null
            ? {}
            : { error: assigning.error })}
          onChange={(event) => {
            const teamId = event.currentTarget.value;
            setAssigning((current) =>
              current === null ? null : { ...current, teamId, error: null },
            );
          }}
        >
          {teamOptions(teams)}
        </s-select>
        <s-button
          slot="secondary-actions"
          commandFor={ASSIGN_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={assign.isPending}
          disabled={pending || assigning === null || assigning.teamId === ""}
          onClick={() => {
            if (assigning !== null && assigning.teamId !== "")
              assign.mutate({
                runTaskId: assigning.runTaskId,
                teamId: assigning.teamId,
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
            ? Promise.resolve("That workflow is no longer on this item.")
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
          /* The run left the page under an open modal (a socket refresh after
             a Change workflow): the heading names the order and a stand-in for
             the item, and the submit answers that the workflow is gone. */
          modalRun ?? {
            lineItemTitle: "this item",
            variantTitle: null,
            quantity: 1,
            orderName: order.name,
          }
        }
        pending={pending}
        onBlock={(reason) =>
          modalRun === null
            ? Promise.resolve("That workflow is no longer on this item.")
            : fromModal(
                block.mutateAsync({
                  runId: modalRun.id,
                  text: textOrNull(reason),
                  toast: "Blocked",
                }),
              )
        }
      />

      {order.note !== null && (
        <s-section slot="aside" heading="Order note">
          <Prose>{order.note}</Prose>
        </s-section>
      )}

      <s-section slot="aside" heading="Order details">
        <Pairs
          pairs={[
            ...fact("Placed", <LocalDateTime value={order.processedAt} />),
            ...fact(
              "Payment",
              <Inline>
                <s-badge tone={order.fullyPaid ? "success" : "warning"}>
                  {order.fullyPaid ? "Paid" : "Unpaid"}
                </s-badge>
              </Inline>,
            ),
            ...fact("Fulfillment", formatStatus(order.fulfillmentStatus)),
            ...fact(
              "Cancelled",
              order.cancelledAt === null ? null : (
                <LocalDateTime value={order.cancelledAt} />
              ),
            ),
          ]}
        />
      </s-section>
    </s-page>
  );
}

import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { adminOrderUrl, useResourceLinkTarget } from "@/lib/orderLinks";
import { hideModal, showModal } from "@/lib/polarisModal";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
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
  Schema.toType(Domain.AssignRunStepTeamResult),
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
    "That workflow cannot start: it is off, has no steps, or has an unassigned step.",
  RunLimit: ({ limit }) =>
    `Baton is already running ${formatNumber(limit)} workflows. Finish or cancel some before starting another.`,
  /* The page offers no change on a done run (`changeable`); this is the
     race where the run finished between the render and the click. */
  ItemDone: ({ workflowName }) =>
    `This item is finished on ${workflowName}. Reopen its last step to change it.`,
  OrderClosed: () =>
    "This order is cancelled or fulfilled in Shopify, so there is no work left to attach.",
});

const assignResultMessage = Match.typeTags<
  Domain.AssignRunStepTeamResult,
  string | null
>()({
  Assigned: () => null,
  NotFound: () => "That step no longer exists.",
  TeamNotFound: () => "That team no longer exists. Choose another.",
  StepFinished: () => "That step is already done and keeps its team.",
  RunNotOpen: () => "That workflow run is finished or cancelled.",
});

const runResultMessage = Match.typeTags<Domain.RunResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow run no longer exists.",
  NotAllowed: () => "Not allowed.",
  /* No merchant button sets a block reason yet (`merchantSetBlockReason` has
     no surface); the tag is here because the union is one union. */
  NotBlocked: () => "That workflow run is no longer blocked.",
  NotReady: () => "A step in an earlier stage is still open.",
  /* Every merchant control on a done run is a note or Reopen, and both are
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
  UndoBlocked: ({ teamName, stepName }) =>
    `${teamName} already started ${stepName}.`,
  ItemHasRun: ({ workflowName }) =>
    `This item is already on ${workflowName}. Cancel that run first to bring this one back.`,
});

/**
 * One merchant intervention, as the Manage rows send it. `kind` picks the
 * callable and `toast` is the acknowledgement, written at the button so the
 * step's own name reaches it ("Cut marked done") rather than a generic verb.
 * Cancel and un-cancel ride the same union deliberately: one in-flight
 * mutation on the page means one `busy` flag, and the merchant cannot start a
 * second write while the first is unacknowledged.
 */
type Intervention =
  | {
      readonly kind: "complete";
      readonly runStepId: string;
      readonly toast: string;
    }
  | {
      readonly kind: "reopen";
      readonly runStepId: string;
      readonly toast: string;
    }
  | {
      readonly kind: "note";
      readonly runStepId: string;
      readonly note: string | null;
      readonly toast: string;
    }
  | {
      readonly kind: "block";
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
  order_deleted: "Order deleted",
  blocked: "Blocked",
  order_fulfilled: "Already shipped in Shopify",
} as const satisfies Record<Domain.RunFlag, string>;

/** Teams named in the order summary before it collapses to "+N more", as the index's cell caps its own. */
const WAITING_ON_LIMIT = 3;

/** The one confirmation on this page: replacing a live run that has work on it. */
const CHANGE_WORKFLOW_MODAL = "change-workflow";

/**
 * `Engraving, Rush and Gift`. Not `Intl.ListFormat`: every other sentence on
 * these pages is English written by hand, and a half-localised one reads worse
 * than a consistent one.
 */
const nameList = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/**
 * Spelled out to five, digits past that. `Domain.WorkflowLimits.maxWorkflows`
 * is the real ceiling and "Seventeen workflows match this item" would be a
 * sentence nobody reads to the end of; five is where the list itself stops
 * being scannable anyway.
 */
const SPELLED = ["", "One", "Two", "Three", "Four", "Five"] as const;

/**
 * The ambiguous item's own sentence: which workflows matched, and the ask.
 * Each is named with its tag because the tag is what the merchant would go and
 * change on the product; the names alone leave them guessing which string on
 * this item pulled which workflow in.
 */
const ambiguitySentence = (matched: readonly Domain.Workflow[]) =>
  `${SPELLED[matched.length] ?? formatNumber(matched.length)} workflows match this item: ${nameList(
    matched.map((workflow) => `${workflow.name} (\u201C${workflow.tag}\u201D)`),
  )}. Choose one to start.`;

/**
 * The confirmation body. Done outranks started because it is the bigger loss:
 * a finished step is work someone will have to do again under the new
 * workflow, while a started one is work in progress. Steps do not carry over —
 * the new run is copied from its own definition — so the sentence says so
 * rather than leaving the merchant to assume otherwise.
 */
const changeWarning = (
  from: Domain.WorkflowName,
  to: string,
  steps: readonly Domain.WorkflowRunStep[],
) => {
  const done = steps.filter((step) => step.completedAt !== null).length;
  const started = steps.filter((step) => step.startedAt !== null).length;
  const total = formatNumber(steps.length);
  const progress =
    done > 0
      ? `${formatNumber(done)} of ${total} steps done`
      : `${formatNumber(started)} of ${total} steps started`;
  return `${from} has ${progress}. Change to ${to} anyway? Those steps will not carry over.`;
};

/**
 * A flag as a badge: a closed vocabulary plus, where the flag names a thing,
 * that thing. `blocked` is deliberately absent from the second branch — its
 * reason is merchant prose up to `Domain.StepNote`'s 1000 characters, and a
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
 * A step's state line inside a Manage row, in the work page's order — done,
 * under way, ready, waiting — so the merchant and the worker describe one step
 * the same way. `started by …` is appended to a Done line only when the
 * starter is not the completer: "Done by Merchant · 14:31 · started by
 * ben@…" is the shape of an intervention over someone's work, and printing
 * one name twice is not.
 */
const manageStateLine = (
  step: Domain.WorkflowRunStep,
  ready: boolean,
): React.ReactNode => {
  const completedBy = Domain.stepCompletedBy(step);
  const startedBy = Domain.stepStartedBy(step);
  if (step.completedAt !== null)
    return (
      <>
        {completedBy === null
          ? "Done · "
          : `Done by ${Domain.actorLabel(completedBy)} · `}
        <LocalDateTime value={step.completedAt} format="time" />
        {startedBy === null ||
        (completedBy !== null && Domain.sameActor(startedBy, completedBy))
          ? ""
          : ` · started by ${Domain.actorLabel(startedBy)}`}
      </>
    );
  if (step.startedAt !== null)
    return (
      <>
        In progress since <LocalDateTime value={step.startedAt} format="time" />
        {startedBy === null ? "" : ` by ${Domain.actorLabel(startedBy)}`}
      </>
    );
  if (ready) return "Ready";
  return `Waiting on step ${String(step.stage - 1)}`;
};

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

/** Stages, not steps: two steps that happen together read as one stop. */
const stageCount = (steps: readonly Domain.WorkflowRunStep[]) =>
  steps.reduce((max, step) => Math.max(max, step.stage), 0);

/**
 * A run's blocked state as a wrapping block rather than a badge. The reason is
 * merchant prose up to `Domain.StepNote`'s 1000 characters; a badge is sized for
 * a closed vocabulary and a long reason there stretches the row until the run's
 * own controls leave the viewport. The ready step is named because `blocked` is
 * a run-level flag (`merchantBlockRun` takes a `runId`) and on a multi-stage run
 * "blocked" alone does not say what is stuck.
 *
 * `unblock` arrives as a node rather than a callback because the button needs
 * the page's `identified`, `busy` and mutation, none of which belong to a
 * module-level render helper — the same shape `stepTrail` uses for its picker.
 * It is offered here as well as inside Manage: a merchant who opened the
 * disclosure should not have to close it to unblock.
 */
const blockedStrip = (
  { run, steps }: Domain.WorkflowRunDetail,
  unblock: React.ReactNode,
) => {
  const stuck = Domain.readySteps(run, steps)
    .map((step) => step.name)
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
          {unblock}
        </s-stack>
      </s-stack>
    </s-box>
  );
};

/**
 * Where the run is, as the card's one read-only answer: `Step 1 of 3 · Cut ·
 * Bench · since 3:10 PM`. It replaced the inline step trail, which said the
 * same thing in a notation the merchant had to learn — a stage number, bold
 * for ready, `✓` and `●` marks, the team in parentheses. The full step list is
 * inside Manage, where `manageStateLine` already renders each step's state in
 * words.
 *
 * The word is `Step` though the count is of stages: merchants count steps, and
 * a stage is an authoring detail (two steps that happen together). A parallel
 * stage is not lost — it lists both names after the position, `Step 2 of 3 ·
 * Engrave, Polish · Bench` — so the position stays a count of stops while the
 * row still says what is happening.
 *
 * Deliberately a second phrasing beside `manageStateLine`, not a call into it.
 * That one describes *one step* inside the Manage disclosure, in the work
 * page's vocabulary, so the merchant and the worker say the same thing about
 * the same step. This one describes *the run* on a collapsed card and has to
 * cover a parallel stage (several ready steps at once), which is not a step
 * state. Keeping them apart is cheaper than a shared function with a mode flag.
 */
const nowLine = ({ run, steps }: Domain.WorkflowRunDetail): React.ReactNode => {
  if (!Domain.runIsLive(run)) return null;
  /* The strip above already names the stuck step; a Now line under it would
     name the same step a second time on one card. */
  if (Domain.runIsBlocked(run)) return null;
  /* Counts stages, like the open form's `of M`: the number the merchant saw
     climb to `Step 2 of 2` must not become `3 steps` the day the run finishes. */
  if (!Domain.runIsOpen(run)) {
    const stages = stageCount(steps);
    return `Done \u00B7 ${formatNumber(stages)} step${stages === 1 ? "" : "s"}`;
  }
  const ready = Domain.readySteps(run, steps);
  const lowest = Domain.lowestOpenStage(steps);
  /* Every remaining step unassigned, or an inconsistent run: the attention
     rows below are the answer, not a position. */
  if (ready.length === 0 || lowest === null) return null;
  const names = ready.map((step) => step.name).join(", ");
  const teams = [...new Set(ready.map((step) => step.teamName))].join(", ");
  /** The stage's start, not a step's: on a parallel stage the earliest claim is when the run got here. */
  const since = ready.reduce<number | null>((earliest, step) => {
    if (step.startedAt === null) return earliest;
    return earliest === null
      ? step.startedAt
      : Math.min(earliest, step.startedAt);
  }, null);
  return (
    <>
      {`Step ${String(lowest)} of ${String(stageCount(steps))} \u00B7 ${names} \u00B7 ${teams}`}
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
 * view carries: an open step whose team is gone is named with an "Assign team"
 * picker (the remedy that makes a team delete safe), and a ready step on a
 * team with no members warns, linking to the team so the fix is one click.
 *
 * They render on the card, outside the Manage disclosure, because they are the
 * one thing that must be acted on and a disclosure would hide it. Every other
 * intervention — reassigning an already-assigned step, notes, block, cancel —
 * is inside Manage: one place to act on a run rather than two, and nothing on
 * the card is a click target, so scanning an order never risks a stray "done".
 */
const attentionRows = (
  { run, steps }: Domain.WorkflowRunDetail,
  teams: readonly Domain.TeamRoster[],
  assign: (runStepId: string) => React.ReactNode,
) => {
  const ready = Domain.readySteps(run, steps);
  const isReady = (step: Domain.WorkflowRunStep) =>
    ready.some((candidate) => candidate.id === step.id);
  const open = Domain.runIsOpen(run);
  const unassigned = open
    ? steps.filter((step) => Domain.isRunStepUnassigned(step, teams))
    : [];
  /** The roster row, not the snapshot name, so the warning can link to the team page. */
  const emptyTeams = open
    ? [
        ...new Map(
          steps.filter(isReady).flatMap((step) => {
            const team = teams.find(
              (candidate) =>
                candidate.id === step.teamId && candidate.memberCount === 0,
            );
            return team === undefined ? [] : [[team.id, team] as const];
          }),
        ).values(),
      ]
    : [];
  if (unassigned.length === 0 && emptyTeams.length === 0) return null;
  return (
    <s-stack gap="small-500">
      {unassigned.map((step) => (
        <s-stack
          key={step.id}
          direction="inline"
          gap="small-300"
          alignItems="center"
        >
          <s-text type="strong">{`${step.name}: assign a team.`}</s-text>
          {assign(step.id)}
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
 * One order: its note, every line item with its personalization and workflow
 * runs, and the order's facts. Subscribed like the index: the loader paints,
 * `useSubscribedQuery` reads through `ShopAgent.subscribeOrder` — which subscribes the
 * shared `/app` connection to this order's pushes — so a webhook, resync, or
 * member step action on this order repaints the page. Every write returns a
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
  /** The "Assign team" picker's choice per open run step. */
  const [assignChoice, setAssignChoice] = React.useState<
    Record<string, string>
  >({});
  /**
   * Which live runs have their "Change workflow" picker open inside Manage;
   * closed is the default. Changing cancels the run that is there and does not
   * carry its steps over, so it is a rare intervention and lives with the
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
   * data without remounting, so a webhook or a worker's step action landing
   * while the merchant has a disclosure open must leave it open. What it must
   * not do is answer for a run that is no longer on this order, so reads go
   * through `managingRun` against the runs actually in hand.
   */
  const [managing, setManaging] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  /** Which step's note editor is open and its draft; one at a time, as on the work page. */
  const [noteDraft, setNoteDraft] = React.useState<{
    runStepId: string;
    note: string;
  } | null>(null);
  /** The Block reason per run, kept while the disclosure is open. */
  const [blockReason, setBlockReason] = React.useState<Record<string, string>>(
    {},
  );

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
   * Every merchant write against a run, through one mutation: the five
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
            complete: ({ runStepId }) =>
              stub.merchantCompleteStep({ runStepId }),
            reopen: ({ runStepId }) =>
              stub.merchantUncompleteStep({ runStepId }),
            note: ({ runStepId, note }) =>
              stub.merchantSetStepNote({ runStepId, note }),
            block: ({ runId, reason }) =>
              stub.merchantBlockRun({ runId, reason }),
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
    mutationFn: (input: typeof Domain.AssignRunStepTeamInput.Encoded) =>
      call((stub) => stub.assignRunStepTeam(input)).then(decodeAssignResult),
    onSuccess: async (result) => {
      setBanner(assignResultMessage(result));
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
   *
   * Only the `ready_to_ship` banner reads it now. The page-level badge left:
   * `productionState` ranks `no_workflow` below `in_production`, so a
   * two-item order with one item running and one unrouted read "In
   * production" while the unrouted card sat below the fold. The ranking is
   * right for the index, where a merchant filters by it; here every state is
   * per item and the cards carry it.
   */
  const state = Domain.productionState({
    order,
    runs: Domain.runCounts(runs.map(({ run }) => run)),
    ambiguousItems: Domain.ambiguousItems(
      lineItems,
      runs.map(({ run }) => run),
    ),
  });
  /** See `managing`: an id with no run on this order is stale and answers `false`. */
  const managingRun = (run: Domain.WorkflowRun) =>
    managing.has(run.id) && runs.some((other) => other.run.id === run.id);
  /** See `changeOpen`: same read-through guard, for the same reason. */
  const changingRun = (run: Domain.WorkflowRun) =>
    changeOpen.has(run.id) && runs.some((other) => other.run.id === run.id);
  /**
   * The order in one line, above the cards: `3 items \u00B7 1 blocked \u00B7 1 made
   * \u00B7 waiting on Engraving`. It earns its place only when the cards below
   * cannot be taken in at a glance — more than one item, or something needing
   * attention — because on a healthy one-item order it would restate the single
   * card under it, which is what the deleted "<Workflow> started for N items"
   * line did. Every clause drops at zero, so the line never pads itself with
   * "0 blocked".
   *
   * `waiting on` is the orders index's own predicate restated over the runs in
   * hand (`ReadyWhere.readyWhere`, which `OrderRepository` runs in SQL): the
   * teams with a ready step on an open run. A team that no
   * longer exists is an attention state, not somebody holding the order, so an
   * unassigned step contributes nothing here — the card's own `Assign team`
   * row is where that is answered. Nor does a blocked run: the team cannot
   * move it, and `<B> blocked` is its clause.
   */
  const orderSummary = (() => {
    const flagged = runs.some(({ run }) => Domain.runIsFlagged(run));
    const unassigned = runs.some(
      ({ run, steps }) =>
        Domain.runIsOpen(run) &&
        steps.some((step) => Domain.isRunStepUnassigned(step, teams)),
    );
    if (lineItems.length <= 1 && !flagged && !unassigned) return null;
    const blocked = lineItems.filter((item) =>
      runs.some(
        ({ run }) => run.lineItemId === item.id && Domain.runIsBlocked(run),
      ),
    ).length;
    const made = lineItems.filter((item) => {
      const live = runs.filter(
        ({ run }) => run.lineItemId === item.id && Domain.runIsLive(run),
      );
      return live.length > 0 && live.every(({ run }) => !Domain.runIsOpen(run));
    }).length;
    const waitingOn = [
      ...new Set(
        runs
          .filter(({ run }) => !Domain.runIsBlocked(run))
          .flatMap(({ run, steps }) =>
            Domain.readySteps(run, steps)
              .filter((step) => !Domain.isRunStepUnassigned(step, teams))
              .map((step) => step.teamName),
          ),
      ),
    ].toSorted((a, b) => a.localeCompare(b));
    const extra = waitingOn.length - WAITING_ON_LIMIT;
    return [
      `${formatNumber(lineItems.length)} item${lineItems.length === 1 ? "" : "s"}`,
      ...(blocked > 0 ? [`${formatNumber(blocked)} blocked`] : []),
      ...(made > 0 ? [`${formatNumber(made)} made`] : []),
      ...(waitingOn.length > 0
        ? [
            `waiting on ${waitingOn.slice(0, WAITING_ON_LIMIT).join(", ")}${extra > 0 ? ` +${formatNumber(extra)} more` : ""}`,
          ]
        : []),
    ].join(" \u00B7 ");
  })();
  const busy =
    attachMutation.isPending ||
    interveneMutation.isPending ||
    assignMutation.isPending;
  const intervene = (input: Intervention) => {
    interveneMutation.mutate(input);
  };

  /**
   * A team picker and an Assign button for one open step, rendered both on the
   * card (beside an unassigned step, which is an attention state) and in the
   * Manage rows (where any open step can be reassigned). The picker starts
   * empty so Assign stays disabled until a team is chosen; picking the step's
   * current team is a harmless no-op write.
   */
  const assignTeam = (runStepId: string) => (
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
        value={assignChoice[runStepId] ?? ""}
        disabled={!identified || busy}
        onChange={(event) => {
          const teamId = event.currentTarget.value;
          setAssignChoice((choice) => ({ ...choice, [runStepId]: teamId }));
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
        disabled={!identified || busy || !assignChoice[runStepId]}
        onClick={() => {
          const teamId = assignChoice[runStepId];
          if (teamId) assignMutation.mutate({ runStepId, teamId });
        }}
      >
        Assign
      </s-button>
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

  /**
   * The note editor for one Manage row. It opens with the step's current text
   * already in the field, and that is the whole of the safeguard against a
   * merchant overwriting a worker: a step has one note, anyone with access to
   * the step may write it, and last write wins silently — so the only warning
   * anybody gets is seeing what they are about to destroy. Never open this
   * empty.
   *
   * The count appears late, at `Domain.NOTE_COUNT_FROM`, so the cap
   * (`Domain.STEP_NOTE_MAX_LENGTH`) announces itself before the write refuses
   * a paragraph that is already typed. The member's fields count from the same
   * number: the same text is typed into both.
   */
  const noteEditor = (step: Domain.WorkflowRunStep, draft: string) => (
    <s-stack gap="small-300">
      <s-text-field
        label="Note"
        labelAccessibilityVisibility="exclusive"
        placeholder="Note about this step"
        value={draft}
        disabled={!identified || busy}
        onInput={(event) => {
          setNoteDraft({ runStepId: step.id, note: event.currentTarget.value });
        }}
      />
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-button
          variant="secondary"
          disabled={!identified || busy}
          onClick={() => {
            interveneMutation.mutate(
              {
                kind: "note",
                runStepId: step.id,
                note: draft === "" ? null : draft,
                toast: "Note saved",
              },
              {
                onSuccess: (result) => {
                  if (result._tag === "Ok") setNoteDraft(null);
                },
              },
            );
          }}
        >
          Save note
        </s-button>
        <s-button
          variant="tertiary"
          onClick={() => {
            setNoteDraft(null);
          }}
        >
          Cancel
        </s-button>
        {draft.length >= Domain.NOTE_COUNT_FROM && (
          <s-text color="subdued">
            {`${formatNumber(Domain.STEP_NOTE_MAX_LENGTH - draft.length)} characters left`}
          </s-text>
        )}
      </s-stack>
    </s-stack>
  );

  /**
   * The Manage disclosure: one row per step in position order, then the
   * run-level actions — Block or Unblock, Cancel run, and Change workflow.
   * Every intervention lives here and nowhere else, in the order the worker
   * sees it on the work page, so the card above stays a read-only glance:
   * name, status, where the run is, and whatever needs attention.
   *
   * The Reopen verdict is computed here rather than fetched. The page already
   * holds every step of every run on this order, which is exactly what the
   * rule takes (`Domain.undoBlockedBy`) — the same function the write itself
   * runs, so the button and the refusal cannot disagree — and asking the
   * object for a verdict per step would only send back what is already here.
   * There is no Start: the merchant records work, they do not claim it.
   *
   * No action here is primary — not `Mark done`, not `Block`, not `Save note`.
   * Every write on this page is a merchant reaching past a worker — the bench
   * claims and completes steps on the work page — and a primary button is the
   * grammar of "this is what you came here to do", which is false here.
   * `Block` keeps its critical tone; that says "irreversible for the bench",
   * not "come here for this".
   *
   * A step with no state to change renders as one line rather than a bordered
   * box: on a three-stage run the boxes are most of the disclosure's height,
   * and a step two stages out has nothing to offer but its note and its team.
   * Both ride along on that line, so nothing this disclosure offered is lost.
   */
  const manageRows = (
    { run, steps }: Domain.WorkflowRunDetail,
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
    const readyIds = new Set(
      Domain.readySteps(run, steps).map((step) => step.id),
    );
    const reason = blockReason[run.id] ?? "";
    /* A subdued panel so the disclosure reads as a drawer the header's Manage
       button owns, not as more card. The step boxes inside invert the usual
       emphasis: the ready step is the one white box on grey, the rest blend. */
    return (
      <s-box background="subdued" borderRadius="base" padding="base">
        <s-stack gap="small-300">
          {steps.map((step) => {
            const ready = readyIds.has(step.id);
            const blocker =
              step.completedAt === null
                ? null
                : Domain.undoBlockedBy(step, steps);
            const reopenedBy = Domain.stepReopenedBy(step);
            const draft =
              noteDraft?.runStepId === step.id ? noteDraft.note : null;
            /**
             * The note as a wrapping paragraph in a quiet block, not an `s-text`
             * beside the step's own name: it is up to
             * `Domain.STEP_NOTE_MAX_LENGTH` characters of prose, and on one line
             * it truncates or stretches the row.
             */
            const note = draft === null && step.note !== null && (
              <s-box
                background="subdued"
                borderRadius="base"
                padding="small-300"
              >
                <s-paragraph color="subdued">
                  {Domain.stepNoteLine(step)}
                </s-paragraph>
              </s-box>
            );
            const noteButton = draft === null && (
              <s-button
                variant="tertiary"
                disabled={!identified || busy}
                onClick={() => {
                  setNoteDraft({
                    runStepId: step.id,
                    note: step.note ?? "",
                  });
                }}
              >
                {step.note === null ? "Note" : "Edit note"}
              </s-button>
            );
            if (!ready && step.completedAt === null)
              return (
                <s-stack key={step.id} gap="small-300">
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    <s-text color="subdued">
                      {`${String(step.stage)} ${step.name} \u00B7 ${step.teamName} \u00B7 `}
                      {manageStateLine(step, false)}
                    </s-text>
                    {noteButton}
                    {open && assignTeam(step.id)}
                  </s-stack>
                  {note}
                  {draft !== null && noteEditor(step, draft)}
                </s-stack>
              );
            return (
              <s-box
                key={step.id}
                padding="small"
                borderWidth="base"
                borderRadius="base"
                background={ready ? "base" : "subdued"}
              >
                <s-stack gap="small-300">
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    <s-text type="strong">{step.name}</s-text>
                    <s-text color="subdued">
                      {`${step.teamName} \u00B7 stage ${String(step.stage)}`}
                    </s-text>
                  </s-stack>
                  <s-text color="subdued">
                    {manageStateLine(step, ready)}
                  </s-text>
                  {reopenedBy !== null && step.reopenedAt !== null && (
                    <s-text color="subdued">
                      {`Reopened by ${Domain.actorLabel(reopenedBy)} \u00B7 `}
                      <LocalDateTime
                        value={step.reopenedAt}
                        format="relative"
                      />
                    </s-text>
                  )}
                  {note}
                  {draft !== null && noteEditor(step, draft)}
                  <s-stack direction="inline" gap="base" alignItems="center">
                    {/* A flag means stop, for the merchant too: the write
                        refuses Done on a flagged run (`Domain.runIsFlagged`),
                        so the button goes with it and Unblock or Dismiss on
                        the run row is the way on. */}
                    {ready && !Domain.runIsFlagged(run) && (
                      <s-button
                        variant="secondary"
                        disabled={!identified || busy}
                        onClick={() => {
                          intervene({
                            kind: "complete",
                            runStepId: step.id,
                            toast: `${step.name} marked done`,
                          });
                        }}
                      >
                        Mark done
                      </s-button>
                    )}
                    {step.completedAt !== null &&
                      (blocker === null ? (
                        <s-button
                          variant="secondary"
                          disabled={!identified || busy}
                          onClick={() => {
                            intervene({
                              kind: "reopen",
                              runStepId: step.id,
                              toast: `${step.name} reopened`,
                            });
                          }}
                        >
                          Reopen
                        </s-button>
                      ) : (
                        <s-text color="subdued">
                          {`Can\u2019t reopen: ${Domain.undoBlockerLine(blocker)} \u2014 reopen it first`}
                        </s-text>
                      ))}
                    {noteButton}
                  </s-stack>
                  {open && step.completedAt === null && assignTeam(step.id)}
                </s-stack>
              </s-box>
            );
          })}
          {/* The step list is one object and the run's own actions are another:
            Block, Unblock and Cancel act on the whole run, and mixed into the
            steps they read as a fourth button on the last one. A done run has
            no run action, so it gets no rule either. */}
          {(open || Domain.runIsBlocked(run)) && <s-divider />}
          {open && (
            <s-stack gap="small-300">
              {!Domain.runIsBlocked(run) && (
                <s-text-field
                  label="Reason"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="What is stopping this? (optional)"
                  value={reason}
                  disabled={!identified || busy}
                  onInput={(event) => {
                    const next = event.currentTarget.value;
                    setBlockReason((current) => ({
                      ...current,
                      [run.id]: next,
                    }));
                  }}
                />
              )}
              {/* One row for everything that acts on the whole run. Block (or
                Unblock while blocked) leads because it is the intervention a
                merchant reaches for most; Cancel and Change are the rare,
                destructive ones and sit after it. */}
              <s-stack direction="inline" gap="small-300">
                {Domain.runIsBlocked(run) ? (
                  unblockButton(run)
                ) : (
                  <s-button
                    variant="secondary"
                    tone="critical"
                    disabled={!identified || busy}
                    onClick={() => {
                      interveneMutation.mutate(
                        {
                          kind: "block",
                          runId: run.id,
                          reason: reason === "" ? null : reason,
                          toast: "Run blocked",
                        },
                        {
                          onSuccess: (result) => {
                            if (result._tag === "Ok")
                              setBlockReason((current) => ({
                                ...current,
                                [run.id]: "",
                              }));
                          },
                        },
                      );
                    }}
                  >
                    Block
                  </s-button>
                )}
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
                {change?.button}
              </s-stack>
              {change?.picker}
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
   * The run keeps its workflow name: its section is headed by the line item,
   * not the workflow. `Undo cancel` stays here rather than moving to that
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
          <s-text type="strong">{run.workflowName}</s-text>
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
        {Domain.runIsBlocked(run) && blockedStrip(detail, unblockButton(run))}
        {now !== null && <s-text>{now}</s-text>}
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
   *   picker offers exactly the workflows that matched, under the sentence
   *   naming them and the tag that pulled each one in.
   * - **no run** — the ordinary manual start, over every active workflow. It
   *   is the row's resting state, not a disclosure: an empty select with a
   *   Start button beside it *is* the statement that nothing is running, and
   *   it says it in one click rather than two.
   * - **a live run** — a *change*, which cancels what is there. That one is a
   *   rare intervention, so it lives inside Manage (`changeOpen`). The options
   *   drop the incumbent (choosing it again is a no-op the server answers with
   *   `AlreadyExists`), and a run with any step started or done asks first.
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
    // a choice; `matched` only narrows the picker, and a matched workflow that
    // has since lost a team or its steps simply drops out of the options.
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
      if (ambiguous) return matched;
      if (live === undefined) return itemWorkflows;
      return itemWorkflows.filter(
        (workflow) => workflow.id !== live.run.workflowId,
      );
    })();
    const chosen = attachChoice[item.id];
    const actionLabel = (() => {
      if (ambiguous) return "Choose";
      return live === undefined ? "Start" : "Change";
    })();
    const submit = () => {
      if (!chosen) return;
      const touched =
        live !== undefined &&
        live.steps.some(
          (step) => step.startedAt !== null || step.completedAt !== null,
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
            live.steps,
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
          label={`${actionLabel} workflow`}
          labelAccessibilityVisibility="exclusive"
          placeholder={`${actionLabel} workflow`}
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
          {options.map((workflow) => (
            <s-option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </s-option>
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
     * Quantity, SKU and — only where they explain something — the product tags,
     * as one subdued line rather than a row of badges. The tags are why a
     * workflow matched, which is the answer on an item where nothing matched or
     * two did; beside a running workflow's name they are noise next to the SKU.
     */
    const facts = [
      /* Ordered vs. to make differ after a refund or partial shipment. */
      toMake === item.currentQuantity
        ? `\u00D7 ${formatNumber(item.currentQuantity)}`
        : `\u00D7 ${formatNumber(toMake)} to make (${formatNumber(item.currentQuantity)} ordered)`,
      ...(item.sku === null ? [] : [`SKU ${item.sku}`]),
      ...(live === undefined && item.productTags.length > 0
        ? [`tags: ${item.productTags.join(", ")}`]
        : []),
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
        <s-stack gap="base">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="start"
            gap="base"
          >
            <s-heading>{lineItemTitle(item)}</s-heading>
            {manageButton}
          </s-stack>

          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text color="subdued">{facts}</s-text>
            {removed && <s-badge tone="critical">Removed</s-badge>}
          </s-stack>

          {item.customAttributes.length > 0 && (
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
          )}

          <s-stack gap="base">
            {ambiguous && (
              <s-paragraph>{ambiguitySentence(matched)}</s-paragraph>
            )}
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
      <s-button
        slot="secondary-actions"
        href={adminOrderUrl(order)}
        target={resourceLinkTarget}
      >
        View in Shopify
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
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
        state === "ready_to_ship" ||
        orderSummary !== null) && (
        /* In the main column, not `slot="supplemental-start"`: that slot
           renders above the main column only, so anything in it pushes the
           first card below the top of the aside. Here the banners are the
           first thing in the column and the card under them still lines up
           with the aside's top edge. */
        <s-stack gap="base">
          {orderSummary !== null && <s-text>{orderSummary}</s-text>}
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
          {/* Only on a multi-item order, and never a per-item quantity: each
              card already prints its own "×N", and a second copy in the aside
              is two numbers to keep in agreement. `unitsToMake` is the card's
              own count, so the total cannot disagree with the parts. */}
          {lineItems.length > 1 &&
            fact(
              "Items",
              `${formatNumber(lineItems.length)} items, ${formatNumber(
                lineItems.reduce(
                  (total, item) => total + Domain.unitsToMake(item),
                  0,
                ),
              )} units`,
            )}
          {fact("Placed", <LocalDateTime value={order.processedAt} />)}
          {fact(
            "Payment",
            order.financialStatus === null ? null : (
              <s-stack direction="inline">
                <s-badge tone={order.fullyPaid ? "success" : "warning"}>
                  {order.financialStatus}
                </s-badge>
              </s-stack>
            ),
          )}
          {fact("Fulfillment", order.fulfillmentStatus)}
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
          {fact(
            "Last synced",
            <>
              <LocalDateTime value={order.syncedAt} /> ({order.syncSource})
            </>,
          )}
        </s-grid>
      </s-section>
    </s-page>
  );
}

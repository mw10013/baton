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
  AlreadyExists: () => "That workflow is already attached to this line item.",
  LineItemNotFound: () => "That line item no longer exists.",
  WorkflowCannotStart: () =>
    "That workflow cannot start: it is off, has no steps, or has an unassigned step.",
});

const assignResultMessage = Match.typeTags<
  Domain.AssignRunStepTeamResult,
  string | null
>()({
  Assigned: () => null,
  NotFound: () => "That step no longer exists.",
  TeamNotFound: () => "That team no longer exists. Choose another.",
  StepFinished: () => "That step is already done and keeps its team.",
});

const runResultMessage = Match.typeTags<Domain.RunResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow run no longer exists.",
  NotAllowed: () => "Not allowed.",
  NotReady: () => "A step in an earlier stage is still open.",
  Terminal: () => "That workflow run is already finished.",
  // Reachable from Manage's Reopen: the row hides that button when the page's
  // own `Domain.undoBlockedBy` says so, and this is the race where a worker
  // started downstream between the render and the click.
  UndoBlocked: ({ teamName, stepName }) =>
    `${teamName} already started ${stepName}.`,
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

const RUN_STATUS_TONE = {
  pending: "info",
  active: "success",
  done: "neutral",
  cancelled: "critical",
} as const satisfies Record<Domain.RunStatus, string>;

const RUN_FLAG_LABEL = {
  item_removed: "Item removed",
  quantity_changed: "Quantity changed",
  order_cancelled: "Order cancelled",
  order_deleted: "Order deleted",
  blocked: "Blocked",
  item_added: "New item",
  order_fulfilled: "Already shipped in Shopify",
} as const satisfies Record<Domain.RunFlag, string>;

/** Where the note editor starts counting down to `Domain.STEP_NOTE_MAX_LENGTH`. */
const NOTE_COUNT_FROM = 800;

/** Teams named in the order summary before it collapses to "+N more", as the index's cell caps its own. */
const WAITING_ON_LIMIT = 3;

const PRODUCTION_STATE_BADGE = {
  no_workflow: { label: "No workflow", tone: "warning" },
  in_production: { label: "In production", tone: "info" },
  ready_to_ship: { label: "Ready to ship", tone: "success" },
  shipped: { label: "Shipped", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "critical" },
} as const satisfies Record<
  Domain.ProductionState,
  { label: string; tone: string }
>;

/**
 * A flag as a badge: a closed vocabulary plus, where the flag names a thing,
 * that thing. `blocked` is deliberately absent from the second branch — its
 * reason is merchant prose up to `Domain.StepNote`'s 1000 characters, and a
 * badge sized for one word stretches the row until the run's own controls
 * leave the viewport. The reason renders in `blockedStrip` instead.
 */
const flagLabel = (run: Domain.WorkflowRun) => {
  if (run.flag === null) return null;
  if (run.flag !== "blocked" && run.flagDetail?.item !== undefined)
    return `${RUN_FLAG_LABEL[run.flag]}: ${run.flagDetail.item}`;
  return RUN_FLAG_LABEL[run.flag];
};

/** "✓" done, "●" started, nothing for untouched. */
const stepMark = (step: Domain.WorkflowRunStep) => {
  if (step.completedAt !== null) return " ✓";
  if (step.startedAt !== null) return " ●";
  return "";
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

/** Whether two actor slots hold the same person, so a Done line can drop a repeated name. */
const sameActor = (a: Domain.Actor, b: Domain.Actor) =>
  a.role === "merchant"
    ? b.role === "merchant"
    : b.role === "member" && a.email === b.email;

/**
 * A step's state line inside a Manage row, in the work page's order — done,
 * under way, ready, waiting — so the merchant and the worker describe one step
 * the same way. `started by …` is appended to a Done line only when the
 * starter is not the completer: "Done by Merchant · 14:31 · started by
 * ben@…" is the shape of an intervention over someone's work, and printing
 * one name twice is not.
 */
const manageStateLine = (
  run: Domain.WorkflowRun,
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
        (completedBy !== null && sameActor(startedBy, completedBy))
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
  if (Domain.isOrderRun(run) && step.stage === 1)
    return "Waiting for every item to be made";
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

/** The lowest stage that still has an open step — the stage the run is at — or null once every step is done. */
const lowestOpenStage = (steps: readonly Domain.WorkflowRunStep[]) =>
  steps
    .filter((step) => step.completedAt === null)
    .reduce<number | null>(
      (lowest, step) =>
        lowest === null ? step.stage : Math.min(lowest, step.stage),
      null,
    );

/** Stages, not steps: two steps that happen together read as one stop. */
const stageCount = (steps: readonly Domain.WorkflowRunStep[]) =>
  steps.reduce((max, step) => Math.max(max, step.stage), 0);

/**
 * The steps a run is at: open, and in its lowest open stage — the same rule the
 * trail bolds and the queue claims. Several can be ready at once when a stage is
 * parallel, so this is a list and every caller must cope with more than one.
 */
const readySteps = (
  run: Domain.WorkflowRun,
  steps: readonly Domain.WorkflowRunStep[],
  openItemRuns: number,
) => {
  if (run.status === "cancelled" || run.status === "done") return [];
  /* An order run's item runs are its stage zero (`readyWhere`): while any is
     open, nothing on the order run is ready, so a blocked pending order run
     says "Blocked", not "Blocked · Pack". */
  if (Domain.isOrderRun(run) && openItemRuns > 0) return [];
  const lowest = lowestOpenStage(steps);
  return steps.filter(
    (step) => step.completedAt === null && step.stage === lowest,
  );
};

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
  openItemRuns: number,
  unblock: React.ReactNode,
) => {
  const stuck = readySteps(run, steps, openItemRuns)
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
 * What the run is doing right now, as one read-only line under the trail. The
 * merchant's question on this page is "where is this order", and before this
 * line the answer was only implied — by which step the trail printed in bold.
 *
 * Deliberately a second phrasing beside `manageStateLine`, not a call into it.
 * That one describes *one step* inside the Manage disclosure, in the work
 * page's vocabulary, so the merchant and the worker say the same thing about
 * the same step. This one describes *the run* on a collapsed card and has to
 * cover a parallel stage (several ready steps at once) and a pending order run
 * waiting on items, neither of which is a step state. Keeping them apart is
 * cheaper than a shared function with a mode flag.
 */
const nowLine = (
  { run, steps }: Domain.WorkflowRunDetail,
  openItemRuns: number,
): React.ReactNode => {
  if (run.status === "cancelled") return null;
  /* The strip above already names the stuck step; a Now line under it would
     name the same step a second time on one card. */
  if (run.flag === "blocked") return null;
  if (run.status === "done") {
    const stages = stageCount(steps);
    return `Done \u00B7 ${String(stages)} stage${stages === 1 ? "" : "s"}`;
  }
  if (Domain.isOrderRun(run) && run.status === "pending" && openItemRuns > 0)
    return `Waiting for ${formatNumber(openItemRuns)} item${openItemRuns === 1 ? "" : "s"}`;
  const ready = readySteps(run, steps, openItemRuns);
  if (ready.length === 0) return null;
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
      {`Now \u00B7 ${names} \u00B7 ${teams}`}
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
 * Steps as a compact inline trail — "1 Cut ✓ · 2 Engrave ● · 2 Polish" —
 * because the whole run must be readable at a glance inside the line item it
 * belongs to. A step is *ready* (bold) when it is open and nothing in an
 * earlier stage is still open, matching the queue; several can be ready at
 * once. The prefix is the stage number, and the summary counts stages, so
 * two steps that happen together read as one stop.
 *
 * The two derived attention states render here against the live roster the
 * view carries: an open step whose team is gone is red with an "Assign team"
 * picker (the remedy that makes a team delete safe), and a ready step on a
 * team with no members warns, linking to the team so the fix is one click.
 * Finished steps always show their snapshot.
 *
 * Reassigning an already-assigned step, and every other intervention, moved
 * into the "Manage" disclosure below the trail (`manageRows`): one place to
 * act on a run rather than two, and nothing here is a click target, so
 * scanning an order never risks a stray "done". Unassigned steps keep their
 * row outside Manage, always visible — they are the attention state, and a
 * disclosure would hide the one thing that must be acted on. The per-step
 * notes moved into Manage's rows for the same reason: a collapsed run is a
 * glance, not a transcript.
 */
const stepTrail = (
  { run, steps }: Domain.WorkflowRunDetail,
  teams: readonly Domain.TeamRoster[],
  assign: (runStepId: string) => React.ReactNode,
) => {
  const lowest = lowestOpenStage(steps);
  const isReady = (step: Domain.WorkflowRunStep) =>
    run.status !== "cancelled" &&
    step.completedAt === null &&
    step.stage === lowest;
  /**
   * `Stage 2 of 3` closes the trail row instead of heading it: the Now line
   * below already says where the run is in words, and a second line above the
   * trail saying it in numbers is one restatement too many inside a card with a
   * four-row budget. A finished run says `Done · N stages` on the Now line, so
   * there is nothing to count here.
   */
  const progress =
    run.status === "done" || lowest === null
      ? null
      : `Stage ${String(lowest)} of ${String(stageCount(steps))}`;
  const open = run.status === "pending" || run.status === "active";
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
  return (
    <s-stack gap="small-500">
      <s-stack direction="inline" gap="small-300" alignItems="center">
        {steps.map((step, index) => {
          const lost = unassigned.some((other) => other.id === step.id);
          return (
            <React.Fragment key={step.id}>
              {index > 0 && <s-text color="subdued">·</s-text>}
              <s-text
                color={step.completedAt === null ? undefined : "subdued"}
                type={isReady(step) ? "strong" : undefined}
              >
                {`${String(step.stage)} ${step.name}${stepMark(step)}`}
              </s-text>
              {lost ? (
                <s-badge tone="critical">Unassigned</s-badge>
              ) : (
                <s-text color="subdued">{`(${step.teamName})`}</s-text>
              )}
            </React.Fragment>
          );
        })}
        {progress !== null && <s-text color="subdued">{progress}</s-text>}
      </s-stack>
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
   * Which line items have their "Attach workflow" picker revealed. Attaching by
   * hand is the exception — the tag rules did not catch this item — so the
   * picker is not worth a permanent empty `s-select` on every item on every
   * visit.
   */
  const [attachOpen, setAttachOpen] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
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
      /* The picker is a disclosure now, so a successful attach must close it:
         left open, the card shows the new run and, under it, a still-enabled
         Attach for the same workflow. */
      if (result._tag === "Ok") {
        setAttachOpen((current) => {
          const next = new Set(current);
          next.delete(lineItemId);
          return next;
        });
        setAttachChoice((current) => {
          const { [lineItemId]: _done, ...rest } = current;
          return rest;
        });
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

  const {
    order,
    lineItems,
    runs,
    orderWorkflow,
    orderWorkflowBlocker,
    itemWorkflows,
    teams,
  } = detail;
  /**
   * The same aggregate the index computes in SQL, rebuilt from the run list
   * this page already carries so both pages read one `productionState`.
   */
  const state = Domain.productionState({
    order,
    runs: Domain.runCounts(runs.map(({ run }) => run)),
  });
  const orderRuns = runs.filter(({ run }) => Domain.isOrderRun(run));
  /** See `managing`: an id with no run on this order is stale and answers `false`. */
  const managingRun = (run: Domain.WorkflowRun) =>
    managing.has(run.id) && runs.some((other) => other.run.id === run.id);
  const itemRunCount = runs.length - orderRuns.length;
  /** Mirrors the date rule: placed before Turn on, unless a manual attach opted the order in. */
  const tooOld =
    orderWorkflow.activatedAt !== null &&
    order.processedAt < orderWorkflow.activatedAt &&
    !runs.some(({ run }) => !Domain.isOrderRun(run) && run.source === "manual");
  const itemRunsAllCancelled =
    itemRunCount > 0 &&
    runs.every(
      ({ run }) => Domain.isOrderRun(run) || run.status === "cancelled",
    );
  /** Open item runs: what a pending order run is waiting on (`readyWhere`), counted from the runs in hand. */
  const openItemRuns = runs.filter(
    ({ run }) =>
      !Domain.isOrderRun(run) &&
      (run.status === "pending" || run.status === "active"),
  ).length;
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
   * teams with a ready step on an open run, where an order run's steps are only
   * ready once no item run is open and at least one is done. A team that no
   * longer exists is an attention state, not somebody holding the order, so an
   * unassigned step contributes nothing here — the trail's own `Assign team`
   * row is where that is answered. Nor does a blocked run: the team cannot
   * move it, and `<B> blocked` is its clause.
   */
  const orderSummary = (() => {
    const flagged = runs.some(({ run }) => run.flag !== null);
    const unassigned = runs.some(
      ({ run, steps }) =>
        (run.status === "pending" || run.status === "active") &&
        steps.some((step) => Domain.isRunStepUnassigned(step, teams)),
    );
    if (lineItems.length <= 1 && !flagged && !unassigned) return null;
    const blocked = lineItems.filter((item) =>
      runs.some(
        ({ run }) => run.lineItemId === item.id && run.flag === "blocked",
      ),
    ).length;
    const made = lineItems.filter((item) => {
      const live = runs.filter(
        ({ run }) => run.lineItemId === item.id && run.status !== "cancelled",
      );
      return live.length > 0 && live.every(({ run }) => run.status === "done");
    }).length;
    const orderRunReady =
      openItemRuns === 0 &&
      runs.some(({ run }) => !Domain.isOrderRun(run) && run.status === "done");
    const waitingOn = [
      ...new Set(
        runs
          .filter(
            ({ run }) =>
              run.flag !== "blocked" &&
              (!Domain.isOrderRun(run) || orderRunReady),
          )
          .flatMap(({ run, steps }) =>
            readySteps(run, steps, openItemRuns)
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
  /**
   * One line per way the order run is not here yet, in the rule's own
   * order: a blocked definition first (the merchant can fix it), then the
   * order-side reasons it will never start, then the plain wait. Each is a
   * condition of order-run creation in `reconcileOrder` restated for the
   * person looking at this order, so no order is silently skipped.
   */
  const orderWorkflowLine = (workflow: Domain.Workflow) => {
    const name = workflow.name;
    if (orderWorkflowBlocker === "off")
      return (
        <>
          {`${name} is off. `}
          <s-link href="/app/order-workflow">Turn it on</s-link>
        </>
      );
    if (orderWorkflowBlocker !== null)
      return (
        <>
          {`${name} cannot start: it has ${orderWorkflowBlocker === "no_steps" ? "no steps" : "a step with no team"}. `}
          <s-link href="/app/order-workflow">Fix the workflow</s-link>
        </>
      );
    if (tooOld)
      return `Placed before ${name} was turned on. Attaching a workflow to an item opts the order in.`;
    if (itemRunCount === 0) return "No item on this order has a workflow.";
    if (itemRunsAllCancelled)
      return "Every item run on this order was cancelled.";
    return null;
  };
  const orderWorkflowNote = orderWorkflowLine(orderWorkflow);
  /**
   * The section shows only when it carries something: an order run, a blocker
   * the merchant can act on, or a reason this order will never get one. A
   * healthy order workflow that simply has not started yet still shows — its
   * trail is the answer to "what happens after this is made" — but an order
   * with none of those would be a heading, a subtitle and nothing else.
   */
  const orderWorkflowShows =
    orderRuns.length > 0 ||
    orderWorkflowBlocker !== null ||
    tooOld ||
    itemRunCount === 0 ||
    itemRunsAllCancelled;
  const busy =
    attachMutation.isPending ||
    interveneMutation.isPending ||
    assignMutation.isPending;
  const intervene = (input: Intervention) => {
    interveneMutation.mutate(input);
  };

  /**
   * A team picker and an Assign button for one open step, inline under the
   * trail. The picker starts empty so Assign stays disabled until a team is
   * chosen; picking the step's current team is a harmless no-op write.
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
   * The count appears late, at `NOTE_COUNT_FROM`, because a counter on an
   * empty field is a rule nobody asked about; it exists so the cap
   * (`Domain.STEP_NOTE_MAX_LENGTH`) announces itself before the write refuses
   * a paragraph that is already typed.
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
        {draft.length >= NOTE_COUNT_FROM && (
          <s-text color="subdued">
            {`${formatNumber(Domain.STEP_NOTE_MAX_LENGTH - draft.length)} characters left`}
          </s-text>
        )}
      </s-stack>
    </s-stack>
  );

  /**
   * The Manage disclosure: one row per step in position order, then the
   * run-level actions. Every intervention lives here and nowhere else, in the
   * order the worker sees it on the work page, so the trail above stays a
   * read-only glance.
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
  const manageRows = ({ run, steps }: Domain.WorkflowRunDetail) => {
    const open = run.status === "pending" || run.status === "active";
    const lowest = lowestOpenStage(steps);
    /** What a finished item step's undo can be blocked by, once packing has begun. */
    const orderRunSteps = Domain.isOrderRun(run)
      ? []
      : orderRuns.flatMap((other) => other.steps);
    const reason = blockReason[run.id] ?? "";
    return (
      <s-stack gap="small-300">
        {steps.map((step) => {
          const ready =
            open && step.completedAt === null && step.stage === lowest;
          const blocker =
            step.completedAt === null
              ? null
              : Domain.undoBlockedBy(step, steps, orderRunSteps);
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
            <s-box background="subdued" borderRadius="base" padding="small-300">
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
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text color="subdued">
                    {`${String(step.stage)} ${step.name} \u00B7 ${step.teamName} \u00B7 `}
                    {manageStateLine(run, step, false)}
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
              background={ready ? "subdued" : "base"}
            >
              <s-stack gap="small-300">
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">{step.name}</s-text>
                  <s-text color="subdued">
                    {`${step.teamName} \u00B7 stage ${String(step.stage)}`}
                  </s-text>
                </s-stack>
                <s-text color="subdued">
                  {manageStateLine(run, step, ready)}
                </s-text>
                {reopenedBy !== null && step.reopenedAt !== null && (
                  <s-text color="subdued">
                    {`Reopened by ${Domain.actorLabel(reopenedBy)} \u00B7 `}
                    <LocalDateTime value={step.reopenedAt} format="relative" />
                  </s-text>
                )}
                {note}
                {draft !== null && noteEditor(step, draft)}
                <s-stack direction="inline" gap="base" alignItems="center">
                  {ready && (
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
                        {`${blocker.teamName} started ${blocker.stepName} \u00B7 reopen it first`}
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
        {(open || run.flag === "blocked") && <s-divider />}
        {run.flag === "blocked" && (
          <s-stack direction="inline" gap="small-300">
            {unblockButton(run)}
          </s-stack>
        )}
        {open && run.flag !== "blocked" && (
          <s-stack gap="small-300">
            <s-text-field
              label="Reason"
              labelAccessibilityVisibility="exclusive"
              placeholder="What is stopping this? (optional)"
              value={reason}
              disabled={!identified || busy}
              onInput={(event) => {
                const next = event.currentTarget.value;
                setBlockReason((current) => ({ ...current, [run.id]: next }));
              }}
            />
            <s-stack direction="inline" gap="small-300">
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
            </s-stack>
          </s-stack>
        )}
        {open && (
          <s-stack direction="inline" gap="small-300">
            <s-button
              variant="tertiary"
              disabled={!identified || busy}
              onClick={() => {
                intervene({
                  kind: "cancel",
                  runId: run.id,
                  toast: "Run cancelled",
                });
              }}
            >
              Cancel
            </s-button>
          </s-stack>
        )}
      </s-stack>
    );
  };

  const renderRun = (detail: Domain.WorkflowRunDetail) => {
    const { run } = detail;
    const cancelled = run.status === "cancelled";
    const now = nowLine(detail, openItemRuns);
    return (
      <s-stack key={run.id} gap="small-300">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          {/* An order run's section is already headed by this very workflow's
              name, so printing it again here is the two-headings fault the
              "Line items" wrapper was deleted for. An item run keeps its name:
              its section is headed by the line item, not the workflow. */}
          {!Domain.isOrderRun(run) && (
            <s-text type="strong">{run.workflowName}</s-text>
          )}
          <s-badge tone={RUN_STATUS_TONE[run.status]}>{run.status}</s-badge>
          {run.flag !== null && (
            <s-badge tone="warning">{flagLabel(run)}</s-badge>
          )}
          {cancelled ? (
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
          ) : (
            <s-button
              variant="tertiary"
              onClick={() => {
                setManaging((current) => {
                  const next = new Set(current);
                  if (!next.delete(run.id)) next.add(run.id);
                  return next;
                });
              }}
            >
              {managingRun(run) ? "Hide" : "Manage"}
            </s-button>
          )}
        </s-stack>
        {run.flag === "blocked" &&
          blockedStrip(detail, openItemRuns, unblockButton(run))}
        {stepTrail(detail, teams, assignTeam)}
        {now !== null && <s-text color="subdued">{now}</s-text>}
        {!cancelled && managingRun(run) && manageRows(detail)}
      </s-stack>
    );
  };

  const renderLineItem = (item: Domain.OrderLineItem) => {
    const removed = item.currentQuantity === 0;
    const toMake = Domain.unitsToMake(item);
    const itemRuns = runs.filter(({ run }) => run.lineItemId === item.id);
    return (
      <s-section
        key={item.id}
        heading={lineItemTitle(item)}
        accessibilityLabel={lineItemTitle(item)}
      >
        <s-stack gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            {/* Ordered vs. to make differ after a refund or partial shipment. */}
            <s-text>
              {toMake === item.currentQuantity
                ? `\u00D7 ${formatNumber(item.currentQuantity)}`
                : `\u00D7 ${formatNumber(toMake)} to make (${formatNumber(item.currentQuantity)} ordered)`}
            </s-text>
            {item.sku !== null && (
              <s-text color="subdued">{`SKU ${item.sku}`}</s-text>
            )}
            {removed && <s-badge tone="critical">Removed</s-badge>}
            {item.productTags.map((tag) => (
              <s-badge key={tag}>{tag}</s-badge>
            ))}
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
            {itemRuns.length === 0 ? (
              <s-paragraph color="subdued">
                No workflow on this item.
              </s-paragraph>
            ) : (
              itemRuns.map(renderRun)
            )}
            {!removed && !attachOpen.has(item.id) && (
              <s-stack direction="inline" justifyContent="start">
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    setAttachOpen((current) => new Set(current).add(item.id));
                  }}
                >
                  Attach workflow
                </s-button>
              </s-stack>
            )}
            {!removed && attachOpen.has(item.id) && (
              /**
               * A grid, not an inline stack: a Polaris form control fills the
               * inline size it is given and has no width prop, so `s-select` in
               * an inline stack takes the whole row and pushes Attach onto the
               * next line at every window width.
               */
              <s-grid
                gridTemplateColumns="minmax(0, 20rem) auto auto"
                gap="base"
                alignItems="end"
                justifyContent="start"
              >
                <s-select
                  label="Attach workflow"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Attach workflow"
                  value={attachChoice[item.id] ?? ""}
                  disabled={!identified || busy}
                  onChange={(event) => {
                    const workflowId = event.currentTarget.value;
                    setAttachChoice((choice) => ({
                      ...choice,
                      [item.id]: workflowId,
                    }));
                  }}
                >
                  {itemWorkflows.map((workflow) => (
                    <s-option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </s-option>
                  ))}
                </s-select>
                <s-button
                  variant="secondary"
                  disabled={!identified || busy || !attachChoice[item.id]}
                  onClick={() => {
                    const workflowId = attachChoice[item.id];
                    if (workflowId)
                      attachMutation.mutate({
                        lineItemId: item.id,
                        workflowId,
                      });
                  }}
                >
                  Attach
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    setAttachOpen((current) => {
                      const next = new Set(current);
                      next.delete(item.id);
                      return next;
                    });
                  }}
                >
                  Cancel
                </s-button>
              </s-grid>
            )}
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
      {state !== null && (
        <s-badge slot="accessory" tone={PRODUCTION_STATE_BADGE[state].tone}>
          {PRODUCTION_STATE_BADGE[state].label}
        </s-badge>
      )}
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
        !order.lineItemsComplete ||
        state === "ready_to_ship" ||
        state === "no_workflow" ||
        orderSummary !== null) && (
        <s-stack slot="supplemental-start" gap="base">
          {orderSummary !== null && <s-text>{orderSummary}</s-text>}
          {state === "no_workflow" && (
            <s-paragraph color="subdued">
              No workflow's product tags match the items in this order.
            </s-paragraph>
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
          {!order.lineItemsComplete && (
            <s-banner tone="warning">
              This order has more line items than one fetch returns; the list
              below is partial.
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

      {orderWorkflowShows && (
        <s-section
          heading={orderWorkflow.name}
          accessibilityLabel="Order workflow"
        >
          <s-stack gap="base">
            {/* The invariant, never a guess at what the shop does in it: the
                system's only stipulation is that every item run on the order is
                done, and a shop using this phase for QA, photography or
                invoicing would read "Shipping" as a lie. */}
            <s-text color="subdued">Starts when every item is made</s-text>
            {orderRuns.length > 0 && orderRuns.map(renderRun)}
            {orderRuns.length === 0 && orderWorkflowNote !== null && (
              <s-paragraph color="subdued">{orderWorkflowNote}</s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}

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
          {fact("Order tags", order.tags.join(", "))}
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

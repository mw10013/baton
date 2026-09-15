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

const flagLabel = (run: Domain.WorkflowRun) => {
  if (run.flag === null) return null;
  if (run.flag === "blocked" && run.flagDetail?.reason !== undefined)
    return `Blocked: ${run.flagDetail.reason}`;
  if (run.flagDetail?.item !== undefined)
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

/** Who blocked the run and when, under the badge that already carries the reason. */
const blockedLine = (run: Domain.WorkflowRun): React.ReactNode => {
  const by = run.flagDetail?.by;
  const reason = run.flagDetail?.reason;
  return (
    <>
      {by === undefined
        ? "Blocked · "
        : `Blocked by ${Domain.actorLabel(by)} · `}
      <LocalDateTime value={run.flagAt ?? 0} format="time" />
      {reason === undefined ? "" : `: ${reason}`}
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
  const lowestOpenStage = steps
    .filter((step) => step.completedAt === null)
    .reduce<number | null>(
      (lowest, step) =>
        lowest === null ? step.stage : Math.min(lowest, step.stage),
      null,
    );
  const isReady = (step: Domain.WorkflowRunStep) =>
    run.status !== "cancelled" &&
    step.completedAt === null &&
    step.stage === lowestOpenStage;
  const stageCount = steps.reduce((max, step) => Math.max(max, step.stage), 0);
  const progress = (() => {
    if (run.status === "done")
      return `Done · ${String(stageCount)} stage${stageCount === 1 ? "" : "s"}`;
    if (lowestOpenStage === null) return null;
    return `Stage ${String(lowestOpenStage)} of ${String(stageCount)}`;
  })();
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
      {progress !== null && <s-text color="subdued">{progress}</s-text>}
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
  /** Which runs have their "Manage" disclosure open; closed is the default. */
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
    onSuccess: async (result) => {
      setBanner(attachResultMessage(result));
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
    itemUnits: 0,
    runs: Domain.runCounts(runs.map(({ run }) => run)),
    attention: false,
  });
  const orderRuns = runs.filter(({ run }) => Domain.isOrderRun(run));
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
          {`${name} is off, so it will not start on this order. `}
          <s-link href="/app/order-workflow">Turn it on</s-link>
          {" to start it here once every item with a workflow is made."}
        </>
      );
    if (orderWorkflowBlocker !== null)
      return (
        <>
          {`${name} cannot start: it has ${orderWorkflowBlocker === "no_steps" ? "no steps" : "a step with no team"}. `}
          <s-link href="/app/order-workflow">Fix the workflow</s-link>
          {" to start it here once every item with a workflow is made."}
        </>
      );
    if (tooOld)
      return `${name} will not start here: this order was placed before ${name} was turned on. Attaching a workflow to an item by hand opts the order in.`;
    if (itemRunCount === 0)
      return `${name} will not start here: no item on this order has a workflow. Attaching a workflow to an item opts the order in.`;
    if (itemRunsAllCancelled)
      return `${name} will not start here: every item run on this order was cancelled. Un-cancel one and finish it to start it.`;
    return `${name} starts when every item with a workflow is made.`;
  };
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
   * "<Workflow> started for N items": one line per item workflow with an
   * open or done run on this order, the merchant-copy verb from
   * `Domain.Workflow`. Cancelled runs are not "started" for this purpose.
   */
  const startedLines = [
    ...runs
      .filter(
        ({ run }) => !Domain.isOrderRun(run) && run.status !== "cancelled",
      )
      .reduce<Map<string, number>>(
        (acc, { run }) =>
          acc.set(run.workflowName, (acc.get(run.workflowName) ?? 0) + 1),
        new Map(),
      ),
  ].map(
    ([name, count]) =>
      `${name} started for ${formatNumber(count)} item${count === 1 ? "" : "s"}`,
  );

  /**
   * The note editor for one Manage row: the current text is in the field
   * before it is overwritten, which is the whole of the "the merchant can
   * overwrite a worker's note" safeguard (`docs/…-research.md` trade-offs).
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
      <s-stack direction="inline" gap="small-300">
        <s-button
          variant="primary"
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
   */
  const manageRows = ({ run, steps }: Domain.WorkflowRunDetail) => {
    const open = run.status === "pending" || run.status === "active";
    const lowestOpenStage = steps
      .filter((step) => step.completedAt === null)
      .reduce<number | null>(
        (lowest, step) =>
          lowest === null ? step.stage : Math.min(lowest, step.stage),
        null,
      );
    /** What a finished item step's undo can be blocked by, once packing has begun. */
    const orderRunSteps = Domain.isOrderRun(run)
      ? []
      : orderRuns.flatMap((other) => other.steps);
    const reason = blockReason[run.id] ?? "";
    return (
      <s-stack gap="small-300">
        {steps.map((step) => {
          const ready =
            open && step.completedAt === null && step.stage === lowestOpenStage;
          const blocker =
            step.completedAt === null
              ? null
              : Domain.undoBlockedBy(step, steps, orderRunSteps);
          const reopenedBy = Domain.stepReopenedBy(step);
          const draft =
            noteDraft?.runStepId === step.id ? noteDraft.note : null;
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
                {draft === null && step.note !== null && (
                  <s-text color="subdued">{Domain.stepNoteLine(step)}</s-text>
                )}
                {draft !== null && noteEditor(step, draft)}
                <s-stack direction="inline" gap="base" alignItems="center">
                  {ready && (
                    <s-button
                      variant="primary"
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
                  {draft === null && (
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
                  )}
                </s-stack>
                {open && step.completedAt === null && assignTeam(step.id)}
              </s-stack>
            </s-box>
          );
        })}
        {run.flag === "blocked" && (
          <s-stack gap="small-300">
            <s-text color="subdued">{blockedLine(run)}</s-text>
            <s-stack direction="inline" gap="small-300">
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
            </s-stack>
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
                variant="primary"
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
    return (
      <s-stack key={run.id} gap="small-300">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">{run.workflowName}</s-text>
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
              {managing.has(run.id) ? "Hide" : "Manage"}
            </s-button>
          )}
        </s-stack>
        {Domain.isOrderRun(run) &&
          run.status === "pending" &&
          openItemRuns > 0 && (
            <s-text color="subdued">
              {`Waiting for ${formatNumber(openItemRuns)} item${openItemRuns === 1 ? "" : "s"}`}
            </s-text>
          )}
        {stepTrail(detail, teams, assignTeam)}
        {!cancelled && managing.has(run.id) && manageRows(detail)}
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
            {!removed && (
              /**
               * A grid, not an inline stack: a Polaris form control fills the
               * inline size it is given and has no width prop, so `s-select` in
               * an inline stack takes the whole row and pushes Attach onto the
               * next line at every window width.
               */
              <s-grid
                gridTemplateColumns="minmax(0, 20rem) auto"
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
        startedLines.length > 0) && (
        <s-stack slot="supplemental-start" gap="base">
          {state === "no_workflow" && (
            <s-paragraph color="subdued">
              No workflow's product tags match the items in this order.
            </s-paragraph>
          )}
          {startedLines.length > 0 && (
            <s-stack gap="small-500">
              {startedLines.map((line) => (
                <s-text key={line} color="subdued">
                  {line}
                </s-text>
              ))}
            </s-stack>
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

      <s-section heading="Line items" accessibilityLabel="Line items">
        {lineItems.length === 0 ? (
          <s-paragraph color="subdued">No line items.</s-paragraph>
        ) : (
          lineItems.map(renderLineItem)
        )}
      </s-section>

      {(orderRuns.length > 0 || Domain.canStartRuns(order)) && (
        <s-section heading="Order workflow" accessibilityLabel="Order workflow">
          <s-stack gap="base">
            {orderRuns.length > 0 && orderRuns.map(renderRun)}
            {orderRuns.length === 0 && (
              <s-paragraph color="subdued">
                {orderWorkflowLine(orderWorkflow)}
              </s-paragraph>
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

import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Match, Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { SocketBanner } from "@/lib/SocketBanner";

const orderQueryKey = (shop: string, legacyId: string) =>
  ["order", shop, legacyId] as const;

/** See the note on `decodeOrdersView` in `app.orders.index.tsx`. */
const decodeDetail = Schema.decodeUnknownPromise(
  Schema.toType(Schema.NullOr(Domain.OrderDetailView)),
);
const decodeWorkflows = Schema.decodeUnknownPromise(
  Schema.toType(Schema.Array(Domain.WorkflowSummary)),
);
const decodeAttachResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.AttachResult),
);
const decodeRunResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.RunResult),
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
  WorkflowNotRoutable: () =>
    "That workflow cannot route work: it is archived, has no steps, or points at an archived team.",
});

const runResultMessage = Match.typeTags<Domain.RunResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow run no longer exists.",
  NotAllowed: () => "Not allowed.",
  NotReady: () => "A step in an earlier stage is still open.",
  Terminal: () => "That workflow run is already finished.",
});

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
} as const satisfies Record<Domain.RunFlag, string>;

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

const decodeAgentMessage = (data: string) => {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  })();
  return Schema.decodeUnknownOption(Domain.AgentMessage)(parsed, {
    onExcessProperty: "error",
  });
};

/**
 * App Bridge resolves the `shopify:` protocol to the right destination for
 * whichever surface the app is running on, so the link never hardcodes a store
 * handle and works embedded as well as in the mobile app.
 * `refs/shopify-docs/docs/api/app-home/latest/apis/user-interface-and-interactions/navigation-api.md:52`
 *
 * `legacyId` is `Order.legacyResourceId` — the REST id the admin routes on.
 * Stored as text because it exceeds the integers `SqlStorage.exec` round-trips
 * losslessly.
 */
const adminOrderUrl = ({ legacyId }: Domain.ShopOrder) =>
  `shopify://admin/orders/${legacyId}`;

/**
 * Picks a navigation target that actually works for the current input mode:
 * mobile Safari rejects `shopify://admin/...` resource URLs opened through
 * `_blank`, so touch and hover-less browsers navigate in place instead.
 * Ported from `../motio/src/routes/app.scan.tsx`, where the failure was found.
 */
const useResourceLinkTarget = () => {
  const [target, setTarget] = React.useState<"_self" | "_blank">("_self");

  React.useEffect(() => {
    const query = window.matchMedia("(pointer: coarse), (hover: none)");
    const updateTarget = () => {
      setTarget(query.matches ? "_self" : "_blank");
    };
    updateTarget();
    query.addEventListener("change", updateTarget);
    return () => {
      query.removeEventListener("change", updateTarget);
    };
  }, []);

  return target;
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
 * Steps as a compact inline trail — "1 Cut ✓ · 2 Engrave ● · 2 Polish" —
 * because the whole run must be readable at a glance inside the line item it
 * belongs to. A step is *ready* (bold) when it is open and nothing in an
 * earlier stage is still open, matching the queue; several can be ready at
 * once. The prefix is the stage number, and the summary counts stages, so
 * two steps that happen together read as one stop.
 */
const stepTrail = ({ run, steps }: Domain.WorkflowRunDetail) => {
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
  return (
    <s-stack gap="small-500">
      {progress !== null && <s-text color="subdued">{progress}</s-text>}
      <s-stack direction="inline" gap="small-300" alignItems="center">
        {steps.map((step, index) => (
          <React.Fragment key={step.id}>
            {index > 0 && <s-text color="subdued">·</s-text>}
            <s-text
              color={step.completedAt === null ? undefined : "subdued"}
              type={isReady(step) ? "strong" : undefined}
            >
              {`${String(step.stage)} ${step.name}${stepMark(step)}`}
            </s-text>
            <s-text color="subdued">{`(${step.teamName})`}</s-text>
          </React.Fragment>
        ))}
      </s-stack>
      {steps
        .filter((step) => step.note !== null)
        .map((step) => (
          <s-text key={step.id} color="subdued">
            {`${step.name} note: ${step.note ?? ""}`}
          </s-text>
        ))}
    </s-stack>
  );
};

export const Route = createFileRoute("/app/orders/$orderId")({
  component: RouteComponent,
});

/**
 * One order: its note, every line item with its personalization and workflow
 * runs, and the order's facts. Same shape as `/app/workflows/$workflowId`: no
 * route loader, one socket RPC for the read, and every write returns a tagged
 * result that is copy-mapped into the banner rather than thrown.
 *
 * The `$orderId` param is the Shopify legacy id, so the URL matches the one
 * the admin uses for the same order (`Domain.GetOrderDetailInput`).
 *
 * Live updates: the read goes through `ShopAgent.activateOrder`, which
 * attaches the shared `/app` connection to pushes as well as reading, so a
 * webhook or resync that touches this order repaints the page. The attachment
 * is released on unmount, the same way the index does it.
 */
function RouteComponent() {
  const { shop } = Route.useRouteContext();
  const { orderId: legacyId } = Route.useParams();
  const queryClient = useQueryClient();
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const agentRef = React.useRef(agent);
  agentRef.current = agent;
  /**
   * Mount-scoped, as on the index: the `/app` socket outlives this route, so a
   * stale `deactivate` from a replaced mount must not clear the newer mount's
   * attachment.
   */
  const sessionTokenRef = React.useRef<string | null>(null);
  sessionTokenRef.current ??= crypto.randomUUID();
  const sessionToken = sessionTokenRef.current;
  const deactivateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const resourceLinkTarget = useResourceLinkTarget();
  const [banner, setBanner] = React.useState<string | null>(null);
  const [attachChoice, setAttachChoice] = React.useState<
    Record<string, string>
  >({});

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket and sessionToken is mount-scoped connection metadata; the cache identity is the shop plus the order
  const detailQuery = useQuery({
    queryKey: orderQueryKey(shop, legacyId),
    staleTime: Infinity,
    queryFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.activateOrder({ legacyId, sessionToken }),
          ).then(decodeDetail)
        : connecting(),
    enabled: identified,
  });

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket; the cache identity is the shop plus the archived filter, shared with the workflows page
  const workflowsQuery = useQuery({
    queryKey: ["workflows", shop, false],
    staleTime: Infinity,
    queryFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.listWorkflows({ includeArchived: false }),
          ).then(decodeWorkflows)
        : connecting(),
    enabled: identified,
  });

  const invalidate = React.useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: orderQueryKey(shop, legacyId),
        }),
        queryClient.invalidateQueries({ queryKey: ["orders", shop] }),
      ]),
    [queryClient, shop, legacyId],
  );

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

  const runMutation = useMutation({
    mutationFn: ({
      runId,
      action,
    }: {
      readonly runId: string;
      readonly action: "cancel" | "uncancel";
    }) =>
      call((stub) =>
        action === "cancel"
          ? stub.cancelRun({ runId })
          : stub.uncancelRun({ runId }),
      ).then(decodeRunResult),
    onSuccess: async (result) => {
      setBanner(runResultMessage(result));
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

  React.useEffect(() => {
    if (identified) void invalidate();
  }, [identified, invalidate]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      if (Option.isNone(decodeAgentMessage(event.data))) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void invalidate();
      }, 500);
    };
    agent?.addEventListener("message", onMessage);
    return () => {
      if (timer) clearTimeout(timer);
      agent?.removeEventListener("message", onMessage);
    };
  }, [agent, invalidate]);

  /**
   * Deferred by one task and cancelled if the effect sets up again, so React
   * Strict Mode's setup → cleanup → setup probe cannot detach the attachment
   * the first read just created. Best-effort and outside `withSocketRecovery`:
   * the attachment is connection-scoped, so any failure means it is already
   * gone.
   */
  React.useEffect(() => {
    if (deactivateTimerRef.current) {
      clearTimeout(deactivateTimerRef.current);
      deactivateTimerRef.current = null;
    }
    return () => {
      deactivateTimerRef.current = setTimeout(() => {
        deactivateTimerRef.current = null;
        const closing = agentRef.current;
        if (closing?.identified)
          void closing.stub.deactivate({ sessionToken }).catch(() => null);
      }, 0);
    };
  }, [sessionToken]);

  const detail = detailQuery.data;

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
  if (detail === undefined)
    return (
      <s-page heading="Order">
        <s-link slot="breadcrumb-actions" href="/app/orders">
          Orders
        </s-link>
        <s-paragraph color="subdued">Loading order…</s-paragraph>
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

  const { order, lineItems, runs, orderWorkflow } = detail;
  const orderRuns = runs.filter(({ run }) => Domain.isOrderRun(run));
  const itemRunCount = runs.length - orderRuns.length;
  /** Mirrors the trigger's age rule: a manual attach opts an older order in. */
  const tooOld =
    orderWorkflow !== null &&
    order.processedAt < orderWorkflow.createdAt &&
    !runs.some(({ run }) => !Domain.isOrderRun(run) && run.source === "manual");
  const routableWorkflows = (workflowsQuery.data ?? []).filter(
    (workflow) =>
      workflow.scope === "item" &&
      workflow.stepCount > 0 &&
      workflow.archivedAt === null,
  );
  const busy = attachMutation.isPending || runMutation.isPending;

  const renderRun = (run: Domain.WorkflowRunDetail) => (
    <s-stack key={run.run.id} gap="small-300">
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-text type="strong">{run.run.workflowName}</s-text>
        <s-badge tone={RUN_STATUS_TONE[run.run.status]}>
          {run.run.status}
        </s-badge>
        {run.run.flag !== null && (
          <s-badge tone="warning">{flagLabel(run.run)}</s-badge>
        )}
        {run.run.status === "pending" || run.run.status === "active" ? (
          <s-button
            variant="tertiary"
            disabled={!identified || busy}
            onClick={() => {
              runMutation.mutate({ runId: run.run.id, action: "cancel" });
            }}
          >
            Cancel
          </s-button>
        ) : null}
        {run.run.status === "cancelled" && (
          <s-button
            variant="tertiary"
            disabled={!identified || busy}
            onClick={() => {
              runMutation.mutate({ runId: run.run.id, action: "uncancel" });
            }}
          >
            Undo cancel
          </s-button>
        )}
      </s-stack>
      {stepTrail(run)}
    </s-stack>
  );

  const renderLineItem = (item: Domain.OrderLineItem) => {
    const removed = item.currentQuantity === 0;
    const itemRuns = runs.filter(({ run }) => run.lineItemId === item.id);
    return (
      <s-section
        key={item.id}
        heading={lineItemTitle(item)}
        accessibilityLabel={lineItemTitle(item)}
      >
        <s-stack gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>{`\u00D7 ${formatNumber(item.currentQuantity)}`}</s-text>
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
                  {routableWorkflows.map((workflow) => (
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
      {order.cancelledAt !== null && (
        <s-badge slot="accessory" tone="critical">
          Cancelled
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
      {(banner !== null || !order.lineItemsComplete) && (
        <s-stack slot="supplemental-start" gap="base">
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

      {(orderRuns.length > 0 ||
        (orderWorkflow !== null && itemRunCount > 0)) && (
        <s-section heading="Order workflow" accessibilityLabel="Order workflow">
          <s-stack gap="base">
            {orderRuns.length > 0 ? (
              orderRuns.map(renderRun)
            ) : (
              <s-paragraph color="subdued">
                {tooOld
                  ? `${orderWorkflow?.name ?? ""} will not start here: this order was placed before that workflow was created. Attaching a workflow to an item by hand opts the order in.`
                  : `${orderWorkflow?.name ?? ""} starts when all items are made.`}
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
          {fact("Placed", formatDateTime(order.processedAt))}
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
          {fact("Cancelled", formatDateTime(order.cancelledAt))}
          {fact("Closed", formatDateTime(order.closedAt))}
          {fact("Order tags", order.tags.join(", "))}
          {fact(
            "Order attributes",
            order.customAttributes
              .map(({ key, value }) => `${key}: ${value ?? ""}`)
              .join(", "),
          )}
          {fact(
            "Last synced",
            `${formatDateTime(order.syncedAt)} (${order.syncSource})`,
          )}
        </s-grid>
      </s-section>
    </s-page>
  );
}

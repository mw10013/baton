import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { formatDateTime, formatNumber } from "@/lib/format";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { SocketBanner } from "@/lib/SocketBanner";

const ORDERS_PAGE_SIZE = 25;
const TAG_BADGE_LIMIT = 3;

const ordersQueryKey = (shop: string) => ["orders", shop] as const;

/**
 * `Schema.toType`, not the schema itself. A Durable Object RPC result has
 * already been through the repository's decoder, so what arrives is the
 * **decoded** shape — `fullyPaid` a boolean, `tags` an array. Decoding it again
 * against `Domain.OrdersView` would demand the *encoded* row shape (`0`/`1`,
 * a JSON string) and fail on the first order. `toType` derives a validator over
 * the decoded side, so the wire value is checked without re-running transforms
 * that already ran. Same reasoning as the better-auth boundary in `Auth.ts`.
 */
const decodeOrdersView = Schema.decodeUnknownPromise(
  Schema.toType(Domain.OrdersView),
);
const decodeSyncState = Schema.decodeUnknownPromise(
  Schema.toType(Domain.SyncState),
);

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

/** The detail page is addressed by `legacyId`; see `Domain.GetOrderDetailInput`. */
export const orderDetailHref = ({ legacyId }: Domain.ShopOrder) =>
  `/app/orders/${legacyId}`;

/**
 * The production-state badge, derived from the run counts the repository
 * aggregates per order. "Not routed" is the one an admin has to act on: a
 * paid, uncancelled order with no run means no workflow matched it, and
 * nothing else on the page or in the Shopify admin surfaces that. Unpaid or
 * cancelled orders are not eligible for runs (`workflow-runs-spec`), so an
 * empty cell there is correct rather than alarming.
 */
const runsBadge = ({ order, runs }: Domain.OrderRow) => {
  const eligible = order.fullyPaid && order.cancelledAt === null;
  if (runs.open === 0 && runs.done === 0)
    return eligible ? <s-badge tone="warning">Not routed</s-badge> : null;
  const label =
    runs.open === 0
      ? "Done"
      : `${formatNumber(runs.open)} active${runs.done > 0 ? ` · ${formatNumber(runs.done)} done` : ""}`;
  return (
    <s-stack direction="inline" gap="small-300">
      <s-badge tone={runs.open === 0 ? "neutral" : "info"}>{label}</s-badge>
      {runs.flagged > 0 && <s-badge tone="warning">Flagged</s-badge>}
    </s-stack>
  );
};

const tagBadges = (tags: readonly string[]) => (
  <s-stack direction="inline" gap="small-300">
    {tags.slice(0, TAG_BADGE_LIMIT).map((tag) => (
      <s-badge key={tag}>{tag}</s-badge>
    ))}
    {tags.length > TAG_BADGE_LIMIT && (
      <s-text color="subdued">{`+${String(tags.length - TAG_BADGE_LIMIT)}`}</s-text>
    )}
  </s-stack>
);

const syncStatusText = (
  view: Domain.OrdersView | undefined,
  isError: boolean,
) => {
  if (isError) return "Could not read sync status.";
  if (view === undefined) return "Loading…";
  if (view.syncState.workflowId !== null)
    return "Syncing… this page updates as orders arrive.";
  return view.syncState.lastFullSyncAt === null
    ? "Never synced."
    : `Last synced ${formatDateTime(view.syncState.lastFullSyncAt)}.`;
};

export const Route = createFileRoute("/app/orders/")({
  component: RouteComponent,
});

/**
 * The orders index: one table of what the Durable Object has stored, with
 * production state per order, and the window-sync button as a header action.
 * Everything per order — line items, personalization, workflows — lives on
 * `/app/orders/$orderId`.
 *
 * No route loader. Unlike `/app`, nothing here is worth a server round trip:
 * every read is an authenticated socket RPC on a connection the Worker already
 * gated, and the same socket delivers the invalidations that keep the table
 * live while a bulk stream and webhooks write underneath it. The cost is no SSR
 * paint, which is why the empty and connecting states are explicit.
 *
 * Invalidations are throttled because a bulk sync plus a burst of order webhooks
 * can poke many times in a second, and
 * `invalidateQueries` defaults to `cancelRefetch: true` while a Durable Object
 * RPC cannot be aborted — so N pokes would start N reads and discard N-1. A
 * trailing throttle collapses a burst into one refetch and still guarantees a
 * final read after the last poke.
 */
function RouteComponent() {
  const { shop } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const agentRef = React.useRef(agent);
  agentRef.current = agent;
  /**
   * Mount-scoped, exactly as on the home route: the `/app` socket outlives this
   * route, so a stale `deactivate` from a mount that has already been replaced
   * must not clear the newer mount's attachment. The query calls
   * `ShopAgent.activateOrders`, which reads and attaches in one round trip.
   */
  const sessionTokenRef = React.useRef<string | null>(null);
  sessionTokenRef.current ??= crypto.randomUUID();
  const sessionToken = sessionTokenRef.current;
  const deactivateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  /**
   * The repository pages forward only (keyset on `processedAt, id`), so
   * "previous" is a stack of the cursors already visited: the top is the
   * current page, the one beneath it is where "previous" goes.
   */
  const [cursors, setCursors] = React.useState<readonly (string | null)[]>([
    null,
  ]);
  const cursor = cursors.at(-1) ?? null;
  const [syncing, setSyncing] = React.useState(false);

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket and sessionToken is mount-scoped connection metadata; the cache identity is the shop, and `cursor` is read fresh on every fetch so a poke re-reads the page being viewed
  const ordersQuery = useQuery({
    queryKey: ordersQueryKey(shop),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    queryFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.activateOrders({
              limit: ORDERS_PAGE_SIZE,
              cursor,
              sessionToken,
            }),
          ).then(decodeOrdersView)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    enabled: identified,
  });

  const invalidate = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: ordersQueryKey(shop) }),
    [queryClient, shop],
  );

  React.useEffect(() => {
    if (identified) void invalidate();
  }, [identified, invalidate, cursor]);

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
   * the first read just created. A real unmount has no following setup, so its
   * deferred deactivate still runs. Best-effort and outside `withSocketRecovery`
   * for the reason the home route documents: the attachment is
   * connection-scoped, so any failure means it is already gone.
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

  const startSync = () => {
    if (!agent) return;
    setSyncing(true);
    withSocketRecovery(agent)(() => agent.stub.syncOrders())
      .then(decodeSyncState)
      .then(() => invalidate())
      .catch((error: unknown) => {
        shopify.toast.show(
          error instanceof Error ? error.message : "Could not start the sync.",
          { isError: true },
        );
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  const view = ordersQuery.data;
  const syncInFlight = view !== undefined && view.syncState.workflowId !== null;
  const orders = view?.page.orders ?? [];

  /**
   * Rendered twice: once into the page's `primary-action` slot, and once
   * inside the empty state where it is the only thing to do. The slot has to
   * sit on the button itself — `s-page` hoists the slotted element into the
   * admin's title bar, and a wrapper element in the slot is dropped.
   */
  const syncButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      loading={syncing}
      disabled={!identified || syncing || view === undefined || syncInFlight}
      onClick={startSync}
    >
      {`Sync last ${String(ORDER_SYNC_WINDOW_DAYS)} days`}
    </s-button>
  );

  const renderOrders = () => {
    /**
     * A failed read renders as a failure. Without this the page shows
     * "Loading orders…" forever on any error — a decode mismatch, a dropped
     * socket, a Durable Object fault all look identical to a slow fetch, and
     * the only way to see the cause is the browser console.
     */
    if (ordersQuery.isError)
      return (
        <s-banner tone="critical">
          {ordersQuery.error instanceof Error
            ? ordersQuery.error.message
            : "Could not load orders."}
        </s-banner>
      );
    if (view === undefined)
      return <s-paragraph color="subdued">Loading orders…</s-paragraph>;
    if (orders.length === 0)
      return (
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {`No orders stored yet. Pull the last ${String(ORDER_SYNC_WINDOW_DAYS)} days from Shopify in one bulk operation; after that, order webhooks keep them current.`}
          </s-paragraph>
          <s-stack alignItems="start">{syncButton(false)}</s-stack>
        </s-stack>
      );
    return (
      <s-table
        paginate
        loading={ordersQuery.isFetching}
        hasPreviousPage={cursors.length > 1}
        hasNextPage={view.page.nextCursor !== null}
        onPreviousPage={() => {
          setCursors((stack) =>
            stack.length > 1 ? stack.slice(0, -1) : stack,
          );
        }}
        onNextPage={() => {
          const next = view.page.nextCursor;
          if (next !== null) setCursors((stack) => [...stack, next]);
        }}
      >
        <s-table-header-row>
          <s-table-header listSlot="primary">Order</s-table-header>
          <s-table-header listSlot="secondary">Placed</s-table-header>
          <s-table-header listSlot="inline">Payment</s-table-header>
          <s-table-header listSlot="inline">Workflows</s-table-header>
          <s-table-header listSlot="labeled" format="numeric">
            Items
          </s-table-header>
          <s-table-header listSlot="labeled">Tags</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {orders.map((row) => (
            <s-table-row key={row.order.id} id={row.order.id}>
              <s-table-cell>
                <s-stack direction="inline" gap="small-300">
                  <s-link href={orderDetailHref(row.order)}>
                    {row.order.name}
                  </s-link>
                  {row.order.cancelledAt !== null && (
                    <s-badge tone="critical">Cancelled</s-badge>
                  )}
                </s-stack>
              </s-table-cell>
              <s-table-cell>
                {formatDateTime(row.order.processedAt)}
              </s-table-cell>
              {/* Blank when Shopify reports no financial status, which it
                  does for $0 and untransacted orders — the admin leaves the
                  cell empty rather than inventing a value. */}
              <s-table-cell>
                {row.order.financialStatus !== null && (
                  <s-badge tone={row.order.fullyPaid ? "success" : "warning"}>
                    {row.order.financialStatus}
                  </s-badge>
                )}
              </s-table-cell>
              <s-table-cell>{runsBadge(row)}</s-table-cell>
              <s-table-cell>{formatNumber(row.itemUnits)}</s-table-cell>
              <s-table-cell>{tagBadges(row.order.tags)}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  return (
    <s-page heading="Orders" inlineSize="large">
      <SocketBanner />
      {orders.length > 0 && syncButton(true)}

      <s-section padding="none" accessibilityLabel="Orders">
        <s-box padding="base">
          <s-stack gap="small-300">
            {view?.syncState.lastError !== null &&
              view?.syncState.lastError !== undefined && (
                <s-banner tone="critical">{view.syncState.lastError}</s-banner>
              )}
            <s-paragraph color="subdued">
              {[
                syncStatusText(view, ordersQuery.isError),
                view === undefined
                  ? null
                  : `${formatNumber(view.page.orderCount)} stored.`,
              ]
                .filter((part) => part !== null)
                .join(" ")}
            </s-paragraph>
          </s-stack>
        </s-box>
        {renderOrders()}
      </s-section>
    </s-page>
  );
}

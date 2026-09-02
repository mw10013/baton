import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { formatDateTime, formatNumber } from "@/lib/format";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";

const ORDERS_PAGE_SIZE = 25;

const ordersQueryKey = (shop: string) => ["orders", shop] as const;

/**
 * `Schema.toType`, not the schema itself. A Durable Object RPC result has
 * already been through the repository's decoder, so what arrives is the
 * **decoded** shape — `fullyPaid` a boolean, `tags` an array. Decoding it again
 * against `Domain.OrdersView` would demand the *encoded* row shape (`0`/`1`,
 * a JSON string) and fail on the first order. `toType` derives a validator over
 * the decoded side, so the wire value is checked without re-running transforms
 * that already ran. Same reasoning as the better-auth boundary in `Auth.ts`.
 *
 * `Domain.Counter` on the home page needs no such care only because it carries
 * no transforms; any domain schema that does must cross this seam as `toType`.
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

const attributeSummary = (attributes: readonly Domain.OrderAttribute[]) =>
  attributes.map(({ key, value }) => `${key}: ${value ?? ""}`).join(", ");

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
 * What still has to be made. Deliberately `currentQuantity`, not the number of
 * line-item rows: a cancelled or edited-down order keeps its line items and
 * drops their current quantity to zero, which is why the admin shows those
 * orders as "0 items" while the rows are still there. Counting rows would put a
 * work count on an order with no work left in it.
 */
const itemUnits = (lineItems: readonly Domain.OrderLineItem[]) =>
  lineItems.reduce((total, { currentQuantity }) => total + currentQuantity, 0);

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

export const Route = createFileRoute("/app/orders")({
  component: RouteComponent,
});

/**
 * The orders view: a table of what the Durable Object has stored, a button that
 * starts the window sync, and a per-order resync.
 *
 * No route loader. Unlike `/app`, nothing here is worth a server round trip:
 * every read is an authenticated socket RPC on a connection the Worker already
 * gated, and the same socket delivers the invalidations that keep the table
 * live while a bulk stream and webhooks write underneath it. The cost is no SSR
 * paint, which is why the empty and connecting states are explicit.
 *
 * Invalidations **are** throttled here, unlike the counter page. A bulk sync
 * plus a burst of order webhooks can poke many times in a second, and
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
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = React.useState<string | null>(
    null,
  );
  const resourceLinkTarget = useResourceLinkTarget();
  const [syncing, setSyncing] = React.useState(false);
  const [resyncingId, setResyncingId] = React.useState<string | null>(null);

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket; the cache identity is the shop, and `cursor` is read fresh on every fetch so a poke re-reads the page being viewed
  const ordersQuery = useQuery({
    queryKey: ordersQueryKey(shop),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    queryFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.getOrders({ limit: ORDERS_PAGE_SIZE, cursor }),
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

  const toast = (error: unknown, fallback: string) => {
    shopify.toast.show(error instanceof Error ? error.message : fallback, {
      isError: true,
    });
  };

  const startSync = () => {
    if (!agent) return;
    setSyncing(true);
    withSocketRecovery(agent)(() => agent.stub.syncOrders())
      .then(decodeSyncState)
      .then(() => invalidate())
      .catch((error: unknown) => {
        toast(error, "Could not start the sync.");
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  const resync = (orderId: string) => {
    if (!agent) return;
    setResyncingId(orderId);
    withSocketRecovery(agent)(() => agent.stub.resyncOrder({ orderId }))
      .then(() => invalidate())
      .catch((error: unknown) => {
        toast(error, "Could not resync the order.");
      })
      .finally(() => {
        setResyncingId(null);
      });
  };

  const view = ordersQuery.data;
  const syncInFlight = view !== undefined && view.syncState.workflowId !== null;
  const orders = view?.page.orders ?? [];
  const selected = orders.find(({ order }) => order.id === selectedOrderId);

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
        <s-paragraph color="subdued">
          No orders stored yet. Run a sync, or place an order on the shop and
          watch it arrive.
        </s-paragraph>
      );
    return (
      <>
        <s-paragraph color="subdued">
          {`${formatNumber(view.page.orderCount)} stored`}
        </s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Order</s-table-header>
            <s-table-header>Placed</s-table-header>
            <s-table-header>Payment</s-table-header>
            <s-table-header>Fulfillment</s-table-header>
            <s-table-header>Units</s-table-header>
            <s-table-header>Tags</s-table-header>
            <s-table-header> </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {orders.map(({ order, lineItems }) => (
              <s-table-row key={order.id} id={order.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-300">
                    <s-link
                      href={adminOrderUrl(order)}
                      target={resourceLinkTarget}
                    >
                      {order.name}
                    </s-link>
                    {order.cancelledAt !== null && (
                      <s-badge tone="critical">Cancelled</s-badge>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{formatDateTime(order.processedAt)}</s-table-cell>
                {/* Blank when Shopify reports no financial status, which it
                    does for $0 and untransacted orders — the admin leaves the
                    cell empty rather than inventing a value. */}
                <s-table-cell>
                  {order.financialStatus !== null && (
                    <s-badge tone={order.fullyPaid ? "success" : "warning"}>
                      {order.financialStatus}
                    </s-badge>
                  )}
                </s-table-cell>
                <s-table-cell>{order.fulfillmentStatus}</s-table-cell>
                <s-table-cell>
                  {formatNumber(itemUnits(lineItems))}
                </s-table-cell>
                <s-table-cell>{order.tags.join(", ")}</s-table-cell>
                <s-table-cell>
                  <s-button
                    variant="tertiary"
                    onClick={() => {
                      setSelectedOrderId(
                        selectedOrderId === order.id ? null : order.id,
                      );
                    }}
                  >
                    {selectedOrderId === order.id ? "Hide" : "Details"}
                  </s-button>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-stack direction="inline" gap="base" alignItems="start">
          <s-button
            variant="secondary"
            disabled={cursor === null}
            onClick={() => {
              setCursor(null);
            }}
          >
            Newest
          </s-button>
          <s-button
            variant="secondary"
            disabled={view.page.nextCursor === null}
            onClick={() => {
              setCursor(view.page.nextCursor);
            }}
          >
            Older
          </s-button>
        </s-stack>
      </>
    );
  };

  return (
    <s-page heading="Orders" inlineSize="large">
      <ClientOnly>
        <s-badge slot="header-actions" tone={identified ? "success" : "info"}>
          {identified ? "Connected" : "Connecting"}
        </s-badge>
      </ClientOnly>

      <s-section heading="Sync" accessibilityLabel="Sync">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {`Pulls the last ${String(ORDER_SYNC_WINDOW_DAYS)} days of orders from Shopify in one bulk operation, then keeps them current from order webhooks. Re-running it asks only for what changed since the last run.`}
          </s-paragraph>
          {view?.syncState.lastError !== null &&
            view?.syncState.lastError !== undefined && (
              <s-banner tone="critical">{view.syncState.lastError}</s-banner>
            )}
          <s-paragraph color="subdued">
            {syncStatusText(view, ordersQuery.isError)}
          </s-paragraph>
          <s-stack alignItems="start">
            <s-button
              variant="primary"
              loading={syncing}
              disabled={
                !identified || syncing || view === undefined || syncInFlight
              }
              onClick={startSync}
            >
              {`Sync last ${String(ORDER_SYNC_WINDOW_DAYS)} days`}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Orders" accessibilityLabel="Orders">
        <s-stack gap="base">{renderOrders()}</s-stack>
      </s-section>

      {selected !== undefined && (
        <s-section
          heading={`Line items — ${selected.order.name}`}
          accessibilityLabel="Line items"
        >
          <s-stack gap="base">
            {!selected.order.lineItemsComplete && (
              <s-banner tone="warning">
                This order has more line items than one fetch returns; the list
                below is partial.
              </s-banner>
            )}
            {selected.order.note !== null && (
              <s-paragraph>{selected.order.note}</s-paragraph>
            )}
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Title</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Qty</s-table-header>
                <s-table-header>Product tags</s-table-header>
                <s-table-header>Personalization</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {selected.lineItems.map((item) => (
                  <s-table-row key={item.id} id={item.id}>
                    <s-table-cell>
                      {item.variantTitle === null
                        ? item.title
                        : `${item.title} — ${item.variantTitle}`}
                    </s-table-cell>
                    <s-table-cell>{item.sku ?? ""}</s-table-cell>
                    <s-table-cell>
                      {formatNumber(item.currentQuantity)}
                    </s-table-cell>
                    <s-table-cell>{item.productTags.join(", ")}</s-table-cell>
                    <s-table-cell>
                      {attributeSummary(item.customAttributes)}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-stack alignItems="start">
              <s-button
                variant="secondary"
                loading={resyncingId === selected.order.id}
                disabled={!identified || resyncingId !== null}
                onClick={() => {
                  resync(selected.order.id);
                }}
              >
                Resync from Shopify
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

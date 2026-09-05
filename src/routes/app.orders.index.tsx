import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { formatDateTime, formatNumber } from "@/lib/format";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const ORDERS_PAGE_SIZE = 25;
const TAG_BADGE_LIMIT = 3;

/**
 * Keyed by the state filter as well as the shop: a filtered page and the
 * unfiltered one are different reads, and the order page's invalidation of
 * `["orders", shop]` is a prefix match so it still reaches both.
 */
const ordersQueryKey = (shop: string, state: Domain.ProductionState | null) =>
  ["orders", shop, state] as const;

/** `?state=ready_to_ship` is the packer's view; absent means every order. */
const OrdersSearch = Schema.Struct({
  state: Schema.optionalKey(Domain.ProductionState),
});

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

/** The detail page is addressed by `legacyId`; see `Domain.GetOrderDetailInput`. */
export const orderDetailHref = ({ legacyId }: Domain.ShopOrder) =>
  `/app/orders/${legacyId}`;

/**
 * The production-state badge, from `Domain.productionState` over the row.
 * "Not routed" is the one an admin has to act on: a paid, uncancelled order
 * with no run means no workflow matched it, and nothing else on the page or
 * in the Shopify admin surfaces that. An unpaid order with no runs cannot
 * start any, so its empty cell is correct rather than alarming. "Ready to
 * ship" is derived, never stored: it clears on its own once Shopify reports
 * the fulfilment.
 */
const stateBadge = (row: Domain.OrderRow) =>
  Match.value(Domain.productionState(row)).pipe(
    Match.withReturnType<React.ReactNode>(),
    Match.when(null, () => null),
    Match.when("not_routed", () => (
      <s-badge tone="warning">Not routed</s-badge>
    )),
    Match.when("in_production", () => (
      <s-stack direction="inline" gap="small-300">
        <s-badge tone="info">
          {`${formatNumber(row.runs.open)} active${row.runs.done > 0 ? ` · ${formatNumber(row.runs.done)} done` : ""}`}
        </s-badge>
        {row.runs.flagged > 0 && <s-badge tone="warning">Flagged</s-badge>}
      </s-stack>
    )),
    Match.when("ready_to_ship", () => (
      <s-badge tone="success">Ready to ship</s-badge>
    )),
    Match.when("shipped", () => <s-badge tone="neutral">Shipped</s-badge>),
    Match.when("cancelled", () => <s-badge tone="neutral">Cancelled</s-badge>),
    Match.exhaustive,
  );

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

const countText = (
  view: Domain.OrdersView | undefined,
  state: Domain.ProductionState | null,
) => {
  if (view === undefined) return null;
  const count = formatNumber(view.page.orderCount);
  return state === "ready_to_ship"
    ? `${count} orders made and waiting to be fulfilled in Shopify.`
    : `${count} stored.`;
};

/**
 * The loader half of the subscribed page: the first page of the current filter,
 * read Worker-side so it paints during SSR. The socket's `subscribeOrders`
 * takes over on identify (see `useSubscribedQuery`). Paging past the first page is
 * component state, so only the filter is a loader dep.
 */
const OrdersLoaderInput = Schema.Struct({
  state: Schema.NullOr(Domain.ProductionState),
});

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(OrdersLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data: { state }, context: { runEffect, session } }) =>
    runEffect(
      ShopAgentClient.pipe(
        Effect.flatMap((client) =>
          client.listOrders(session.shop, {
            limit: ORDERS_PAGE_SIZE,
            cursor: null,
            state,
          }),
        ),
      ),
    ),
  );

export const Route = createFileRoute("/app/orders/")({
  validateSearch: Schema.toStandardSchemaV1(OrdersSearch),
  loaderDeps: ({ search }) => ({ state: search.state ?? null }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

/**
 * The orders index: one table of what the Durable Object has stored, with
 * production state per order, and the window-sync button as a header action.
 * Everything per order — line items, personalization, workflows — lives on
 * `/app/orders/$orderId`.
 *
 * A subscribed page (the socket half of the loader-versus-socket rule on
 * `ShopAgentClient`): the loader paints the first page, then `useSubscribedQuery`
 * reads through `subscribeOrders` and refetches on every order-state push,
 * so the table stays current while a bulk stream and webhooks write
 * underneath it.
 */
function RouteComponent() {
  const { shop } = Route.useRouteContext();
  const { state = null } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const loaderData = Route.useLoaderData();
  /**
   * The repository pages forward only (keyset on `processedAt, id`), so
   * "previous" is a stack of the cursors already visited: the top is the
   * current page, the one beneath it is where "previous" goes. The cursor is
   * read fresh on every fetch rather than keyed, so an invalidation re-reads the page
   * being viewed.
   */
  const [cursors, setCursors] = React.useState<readonly (string | null)[]>([
    null,
  ]);
  const cursor = cursors.at(-1) ?? null;
  const cursorRef = React.useRef(cursor);
  cursorRef.current = cursor;
  const [syncing, setSyncing] = React.useState(false);

  /** A filter change is a new list, so the cursor stack starts over. */
  const setState = (next: Domain.ProductionState | null) => {
    setCursors([null]);
    void navigate({ search: next === null ? {} : { state: next } });
  };

  const {
    data: view,
    query: ordersQuery,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ordersQueryKey(shop, state),
    subscribe: (stub, subscriberId) =>
      stub
        .subscribeOrders({
          limit: ORDERS_PAGE_SIZE,
          cursor: cursorRef.current,
          state,
          subscriberId,
        })
        .then(decodeOrdersView),
    initialData: loaderData,
  });

  React.useEffect(() => {
    if (identified) void invalidate();
  }, [identified, invalidate, cursor]);

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
      disabled={!identified || syncing || syncInFlight}
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
    if (orders.length === 0 && state === "ready_to_ship")
      return (
        <s-paragraph color="subdued">
          No orders are made and waiting to be fulfilled.
        </s-paragraph>
      );
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
                <s-link href={orderDetailHref(row.order)}>
                  {row.order.name}
                </s-link>
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
              <s-table-cell>{stateBadge(row)}</s-table-cell>
              <s-table-cell>{formatNumber(row.itemUnits)}</s-table-cell>
              <s-table-cell>{tagBadges(row.order.tags)}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  const filterButton = (
    label: string,
    value: Domain.ProductionState | null,
  ) => (
    <s-button
      variant={state === value ? "primary" : "secondary"}
      disabled={state === value}
      onClick={() => {
        setState(value);
      }}
    >
      {label}
    </s-button>
  );

  return (
    <s-page heading="Orders" inlineSize="large">
      <SocketBanner />
      {(orders.length > 0 || state !== null) && syncButton(true)}

      <s-section padding="none" accessibilityLabel="Orders">
        <s-box padding="base">
          <s-stack gap="small-300">
            {view?.syncState.lastError !== null &&
              view?.syncState.lastError !== undefined && (
                <s-banner tone="critical">{view.syncState.lastError}</s-banner>
              )}
            <s-stack direction="inline" gap="small-300">
              {filterButton("All", null)}
              {filterButton("Ready to ship", "ready_to_ship")}
            </s-stack>
            <s-paragraph color="subdued">
              {[
                syncStatusText(view, ordersQuery.isError),
                countText(view, state),
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

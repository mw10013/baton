import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Option, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { adminOrderUrl, useResourceLinkTarget } from "@/lib/orderLinks";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const ORDERS_PAGE_SIZE = 25;
/**
 * Raw field text to the branded search, or `None` for anything the schema
 * refuses: empty, blank, or past its 32 characters. `None` is "no search",
 * which is what an emptied field means, so the caller needs no second test.
 */
const decodeOrderSearch = Schema.decodeUnknownOption(Domain.OrderSearch);
/**
 * Caps both the Tags and the Waiting on cells, on purpose: two collapsing
 * columns in one table should collapse at the same width and with the same
 * `+N`, so the table has one idiom rather than two.
 */
const TAG_BADGE_LIMIT = 3;

/**
 * Keyed by every filter as well as the shop: each filter combination is a
 * different read, and the order page's invalidation of `["orders", shop]` is
 * a prefix match so it still reaches every one of them.
 */
const ordersQueryKey = (
  shop: string,
  q: Domain.OrderSearch | null,
  state: Domain.ProductionState | null,
  paid: boolean | null,
  attention: boolean,
  team: Domain.TeamId | null,
) => ["orders", shop, q, state, paid, attention, team] as const;

/**
 * `?q=` is the order-number search; `?state=` picks a stage of the strip
 * (`ready_to_ship` is the packer's view); `?paid=` crosses it with the payment
 * gate; `?attention=true` keeps only orders with a run that needs attention
 * (`Domain.OrderRow.attention`); `?team=` keeps only orders waiting on that
 * team, which is the link the team detail page drills in with. Absent means
 * every order.
 */
const OrdersSearch = Schema.Struct({
  q: Schema.optionalKey(Domain.OrderSearch),
  state: Schema.optionalKey(Domain.ProductionState),
  paid: Schema.optionalKey(Schema.Boolean),
  attention: Schema.optionalKey(Schema.Boolean),
  team: Schema.optionalKey(Domain.TeamId),
});

/**
 * The stage filters, in lifecycle order. `cancelled` is deliberately absent: it
 * is rare, shows as a badge, and is not a stage an order moves through.
 * Only the open stages carry a count (see `Domain.OpenStageCounts`).
 *
 * No per-stage hint here: `stageText` already says what the selected stage
 * means at sentence length, and carrying both put a four-word gloss on every
 * button directly above the sentence that repeated it.
 */
const STAGES: readonly {
  readonly state: Domain.ProductionState | null;
  readonly label: string;
  readonly count: keyof Domain.OpenStageCounts | null;
}[] = [
  { state: null, label: "All orders", count: null },
  { state: "no_workflow", label: "No workflow", count: "no_workflow" },
  {
    state: "multiple_workflows",
    label: "Choose a workflow",
    count: "multiple_workflows",
  },
  { state: "in_production", label: "In production", count: "in_production" },
  { state: "ready_to_ship", label: "Ready to ship", count: "ready_to_ship" },
  { state: "shipped", label: "Shipped", count: null },
];

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
 * "No workflow" is the one an admin has to act on: a paid, uncancelled order
 * with no run means no workflow matched it, and nothing else on the page or
 * in the Shopify admin surfaces that. An unpaid order with no runs cannot
 * start any, so its empty cell is correct rather than alarming. "Ready to
 * ship" is derived, never stored: it clears on its own once Shopify reports
 * the fulfilment.
 *
 * Three alarms can sit on an in-production row and each names a different
 * remedy, which is why they are three badges rather than one. `Needs
 * attention` (rendered by the row, not here) is a configuration fault: the
 * remedy is the workflow editor or the members page. `Blocked` is a person
 * waiting on the merchant right now, so the remedy is the order page. `Order
 * changed` is Shopify having moved under a live run, and the remedy is
 * usually just to accept it. `Blocked` is critical because someone is
 * stopped; `Order changed` is a warning because nothing is.
 *
 * "Choose a workflow" is the same kind of fact as "No workflow" — an item the
 * merchant meant to route is not being made — but it outranks the aggregate
 * stage, so a row can be waiting on a choice *and* have work in progress. Both
 * are shown: the merchant otherwise reads the badge as "nothing is happening
 * on this order", which would be wrong.
 */
const stateBadge = (row: Domain.OrderRow) =>
  Match.value(Domain.productionState(row)).pipe(
    Match.withReturnType<React.ReactNode>(),
    Match.when(null, () => null),
    Match.when("no_workflow", () => (
      <s-badge tone="warning">No workflow</s-badge>
    )),
    Match.when("multiple_workflows", () => (
      <s-stack direction="inline" gap="small-300">
        <s-badge tone="warning">Choose a workflow</s-badge>
        {row.runs.open > 0 && (
          <s-badge tone="info">
            {`${formatNumber(row.runs.open)} active${row.runs.done > 0 ? ` · ${formatNumber(row.runs.done)} done` : ""}`}
          </s-badge>
        )}
        {row.runs.blocked > 0 && <s-badge tone="critical">Blocked</s-badge>}
        {row.runs.flagged > 0 && (
          <s-badge tone="warning">Order changed</s-badge>
        )}
      </s-stack>
    )),
    Match.when("in_production", () => (
      <s-stack direction="inline" gap="small-300">
        <s-badge tone="info">
          {`${formatNumber(row.runs.open)} active${row.runs.done > 0 ? ` · ${formatNumber(row.runs.done)} done` : ""}`}
        </s-badge>
        {row.runs.blocked > 0 && <s-badge tone="critical">Blocked</s-badge>}
        {row.runs.flagged > 0 && (
          <s-badge tone="warning">Order changed</s-badge>
        )}
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
  return view.syncState.lastFullSyncAt === null ? (
    "Never synced."
  ) : (
    <>
      Last synced <LocalDateTime value={view.syncState.lastFullSyncAt} />.
    </>
  );
};

/**
 * One sentence under the filters saying what the current stage means, with
 * the count where one is cheap to know. "All" and "Shipped" have no count on
 * purpose: that would be a full read of the shop's history on every refresh
 * of a subscribed page.
 */
const orders = (n: number) =>
  `${formatNumber(n)} ${n === 1 ? "order" : "orders"}`;

const stageText = (
  view: Domain.OrdersView | undefined,
  state: Domain.ProductionState | null,
) => {
  if (view === undefined) return null;
  const counts = view.page.openCounts;
  return Match.value(state).pipe(
    Match.withReturnType<string | null>(),
    Match.when(null, () => null),
    Match.when(
      "no_workflow",
      () =>
        `${orders(counts.no_workflow)} paid with no matching workflow. Attach one from the order page.`,
    ),
    Match.when("multiple_workflows", () =>
      counts.multiple_workflows === 0
        ? "No orders are waiting on a choice."
        : `${orders(counts.multiple_workflows)} have an item that matches more than one workflow. Open each one to choose.`,
    ),
    Match.when(
      "in_production",
      () => `${orders(counts.in_production)} with work in progress.`,
    ),
    Match.when(
      "ready_to_ship",
      () =>
        `${orders(counts.ready_to_ship)} made and waiting to be fulfilled in Shopify.`,
    ),
    Match.when("shipped", () => "Orders fulfilled in Shopify."),
    Match.when("cancelled", () => "Orders cancelled in Shopify."),
    Match.exhaustive,
  );
};

const emptyText = (state: Domain.ProductionState | null) =>
  Match.value(state).pipe(
    Match.when("no_workflow", () => "Every paid order has a workflow."),
    Match.when("multiple_workflows", () => "No orders need a workflow chosen."),
    Match.when("in_production", () => "Nothing is in production."),
    Match.when(
      "ready_to_ship",
      () => "No orders are made and waiting to be fulfilled.",
    ),
    Match.when("shipped", () => "No orders have been fulfilled yet."),
    Match.when("cancelled", () => "No cancelled orders."),
    Match.when(null, () => "No orders match these filters."),
    Match.exhaustive,
  );

/**
 * The loader half of the subscribed page: the first page of the current filter,
 * read Worker-side so it paints during SSR. The socket's `subscribeOrders`
 * takes over on identify (see `useSubscribedQuery`). Paging past the first page is
 * component state, so only the filter is a loader dep.
 */
const OrdersLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.OrderSearch),
  state: Schema.NullOr(Domain.ProductionState),
  paid: Schema.NullOr(Schema.Boolean),
  attention: Schema.Boolean,
  team: Schema.NullOr(Domain.TeamId),
});

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(OrdersLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(
    ({
      data: { q, state, paid, attention, team },
      context: { runEffect, session },
    }) =>
      runEffect(
        ShopAgentClient.pipe(
          Effect.flatMap((client) =>
            client.listOrders(session.shop, {
              limit: ORDERS_PAGE_SIZE,
              cursor: null,
              q,
              state,
              paid,
              attention,
              team,
            }),
          ),
        ),
      ),
  );

export const Route = createFileRoute("/app/orders/")({
  validateSearch: Schema.toStandardSchemaV1(OrdersSearch),
  loaderDeps: ({ search }) => ({
    q: search.q ?? null,
    state: search.state ?? null,
    paid: search.paid ?? null,
    attention: search.attention ?? false,
    team: search.team ?? null,
  }),
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
  const {
    q = null,
    state = null,
    paid = null,
    attention = false,
    team = null,
  } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const resourceLinkTarget = useResourceLinkTarget();
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
  const [syncing, setSyncing] = React.useState(false);

  /** A filter change is a new list, so the cursor stack starts over. */
  const setFilters = (next: {
    readonly q: Domain.OrderSearch | null;
    readonly state: Domain.ProductionState | null;
    readonly paid: boolean | null;
    readonly attention: boolean;
    readonly team: Domain.TeamId | null;
  }) => {
    setCursors([null]);
    void navigate({
      search: {
        ...(next.q === null ? {} : { q: next.q }),
        ...(next.state === null ? {} : { state: next.state }),
        ...(next.paid === null ? {} : { paid: next.paid }),
        ...(next.attention ? { attention: true } : {}),
        ...(next.team === null ? {} : { team: next.team }),
      },
    });
  };

  /**
   * The field's text while it is being typed. The URL is the filter; this is
   * the draft on the way to it, so a keystroke is not a navigation and not a
   * read. It re-seeds whenever `q` changes from outside the field — Clear
   * filters, the chip's own X, a back button — the same seeded-state shape
   * the workflow pages use for a loaded name.
   */
  const [searchDraft, setSearchDraft] = React.useState(q ?? "");
  const [seededSearch, setSeededSearch] = React.useState<string | null>(q);
  if (q !== seededSearch) {
    setSeededSearch(q);
    setSearchDraft(q ?? "");
  }
  const searchField = React.useRef<HTMLElementTagNameMap["s-text-field"]>(null);

  const {
    data: view,
    query: ordersQuery,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ordersQueryKey(shop, q, state, paid, attention, team),
    subscribe: (stub, subscriberId) =>
      stub
        .subscribeOrders({
          limit: ORDERS_PAGE_SIZE,
          cursor: cursorRef.current,
          q,
          state,
          paid,
          attention,
          team,
          subscriberId,
        })
        .then(decodeOrdersView),
    initialData: loaderData,
  });

  /**
   * The cursor reaches `subscribe` through a ref rather than the query key, so
   * writing it here is what makes it a real dependency of this effect: publish
   * the page to move to, then invalidate so the refetch reads it. Ordering
   * holds because every fetch is downstream of an invalidation, and the ref's
   * initial value already covers the first render.
   */
  React.useEffect(() => {
    cursorRef.current = cursor;
    if (identified) void invalidate();
  }, [identified, invalidate, cursor]);

  /**
   * Enter and blur, not a debounce: every other control in this row navigates
   * on the merchant's own action (a press-button click, a select change), and
   * a timer that navigated mid-number would page the table under the typing.
   * A no-op submit is dropped so re-blurring an unchanged field costs nothing.
   */
  const submitSearch = () => {
    const next = Option.getOrNull(decodeOrderSearch(searchDraft));
    if (next === q) return;
    setFilters({ q: next, state, paid, attention, team });
  };
  /**
   * The latest submit, held in a ref so the keydown listener below is attached
   * once rather than re-attached on every keystroke: `submitSearch` closes over
   * the draft and every filter, so it is a new function each render.
   */
  const submitRef = React.useRef(submitSearch);
  React.useEffect(() => {
    submitRef.current = submitSearch;
  });
  /** The field's shadow input does not submit a surrounding form, so Enter is listened for on the custom element (as `WorkflowTag` does). */
  React.useEffect(() => {
    const element = searchField.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        submitRef.current();
      }
    };
    element?.addEventListener("keydown", onKeyDown);
    return () => element?.removeEventListener("keydown", onKeyDown);
  }, []);

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
  const filtered =
    q !== null || state !== null || paid !== null || attention || team !== null;
  /**
   * Nothing stored and nothing filtered: the shop has never had orders here,
   * so the card is the empty state alone. Declared beside `orders` rather than
   * next to its first use because the section body, the filter row and
   * `renderOrders` all branch on it.
   */
  const neverStored = orders.length === 0 && !filtered;
  /**
   * `OrderRow.waitingOn` is ids — the Durable Object has no team names — and
   * this is the roster it was derived against, carried on the same view.
   */
  const teamName = new Map(
    (view?.teams ?? []).map(({ id, name }) => [id, name]),
  );

  /**
   * Who is holding the order: the teams with a ready step on one of its open
   * runs, collapsed and capped like `tagBadges`. `"Unknown team"` should
   * never render — the repository only emits ids that were in the roster it
   * read — but the lookup is nullable and a blank badge is worse than a
   * named gap.
   */
  const waitingOnBadges = (ids: readonly Domain.TeamId[]) => (
    <s-stack direction="inline" gap="small-300">
      {ids.slice(0, TAG_BADGE_LIMIT).map((id) => (
        <s-badge key={id}>{teamName.get(id) ?? "Unknown team"}</s-badge>
      ))}
      {ids.length > TAG_BADGE_LIMIT && (
        <s-text color="subdued">{`+${String(ids.length - TAG_BADGE_LIMIT)}`}</s-text>
      )}
    </s-stack>
  );

  /**
   * Rendered twice: once into the page's `primary-action` slot, and once
   * inside the empty state where it is the only thing to do. The slot has to
   * sit on the button itself — `s-page` hoists the slotted element into the
   * admin's title bar, and a wrapper element in the slot is dropped. Because
   * App Bridge hoists the slotted copy out of the iframe, the in-card twin is
   * not a duplicate in the frame's DOM, so frame- and page-scoped e2e locators
   * stay disjoint.
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

  /**
   * The never-stored state: the card is this block alone, with the stage strip
   * and the payment filters gone — filtering nothing by payment status is
   * noise, and the strip of zeroes is what used to squeeze this copy into the
   * bottom corner of the card. Same centred shape as the other index pages'
   * empty states.
   *
   * A shop that has synced and still has nothing gets different copy: "pull
   * the window" is the wrong instruction once the pull has happened and come
   * back empty.
   */
  const emptyState = () => {
    const synced = view !== undefined && view.syncState.lastFullSyncAt !== null;
    return (
      <s-box padding="base">
        <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
          <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
            <s-stack alignItems="center" gap="small-300">
              <s-heading>
                {synced
                  ? `No orders in the last ${String(ORDER_SYNC_WINDOW_DAYS)} days`
                  : "No orders yet"}
              </s-heading>
              <s-paragraph color="subdued">
                {synced
                  ? "The last sync found nothing to store. Order webhooks add new orders as they come in, or sync again to re-pull the window."
                  : `Pull the last ${String(ORDER_SYNC_WINDOW_DAYS)} days from Shopify in one bulk operation; after that, order webhooks keep them current.`}
              </s-paragraph>
            </s-stack>
            {syncButton(false)}
          </s-grid>
        </s-grid>
      </s-box>
    );
  };

  const renderOrders = () => {
    /**
     * A failed read renders as a failure. Without this the page shows
     * "Loading orders…" forever on any error — a decode mismatch, a dropped
     * socket, a Durable Object fault all look identical to a slow fetch, and
     * the only way to see the cause is the browser console.
     */
    if (ordersQuery.isError)
      return (
        <s-box padding="base">
          <s-banner tone="critical">
            {ordersQuery.error instanceof Error
              ? ordersQuery.error.message
              : "Could not load orders."}
          </s-banner>
        </s-box>
      );
    if (orders.length === 0 && filtered)
      return (
        <s-box padding="base">
          {/* The search names what it did not find, because the number the
              merchant typed is the whole question they asked; the stage copy
              answers a different one and would read as a non sequitur under a
              search that missed. */}
          {q === null ? (
            <s-paragraph color="subdued">{emptyText(state)}</s-paragraph>
          ) : (
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text color="subdued">
                {`No order matches "${Domain.normaliseOrderSearch(q)}".`}
              </s-text>
              <s-link
                onClick={() => {
                  setFilters({ q: null, state, paid, attention, team });
                }}
              >
                Clear the search
              </s-link>
            </s-stack>
          )}
        </s-box>
      );
    if (orders.length === 0) return emptyState();
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
          <s-table-header listSlot="labeled">Waiting on</s-table-header>
          <s-table-header listSlot="labeled" format="numeric">
            Items
          </s-table-header>
          <s-table-header listSlot="labeled">Tags</s-table-header>
          <s-table-header listSlot="labeled">Shopify</s-table-header>
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
                <LocalDateTime value={row.order.processedAt} />
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
              <s-table-cell>
                <s-stack direction="inline" gap="small-300">
                  {stateBadge(row)}
                  {row.attention && (
                    <s-badge tone="critical">Needs attention</s-badge>
                  )}
                </s-stack>
              </s-table-cell>
              {/* No placeholder for an empty cell. Empty means every ready
                  step is unassigned or on a deleted team (an unstaffed team
                  still shows, so the merchant knows whom to staff), and the
                  critical badge beside it already says so; the one other way to get here is
                  an order run whose item runs were all cancelled, which
                  carries a flag badge. A dash would flatten both into
                  "nothing to see". */}
              <s-table-cell>{waitingOnBadges(row.waitingOn)}</s-table-cell>
              <s-table-cell>{formatNumber(row.itemUnits)}</s-table-cell>
              <s-table-cell>{tagBadges(row.order.tags)}</s-table-cell>
              {/* The packer's handoff: a made order is fulfilled in the
                  Shopify admin, never here, so the ready-to-ship row links
                  straight to it. Other rows get the same link under a
                  neutral label. */}
              <s-table-cell>
                <s-link
                  href={adminOrderUrl(row.order)}
                  target={resourceLinkTarget}
                >
                  {Domain.productionState(row) === "ready_to_ship"
                    ? "Fulfil in Shopify"
                    : "View in Shopify"}
                </s-link>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  /**
   * The stage filter: one toggle per stage, in the order an order moves through
   * them, so the row doubles as a reading of where work sits.
   *
   * `s-press-button` rather than the `s-clickable` tiles this used to be. The
   * pressed, hover and focus states come from Polaris instead of being
   * approximated with a background colour on a div — the tiles looked like
   * plain text until one was selected — and it is the same control shape as the
   * payment and "Needs attention" filters beside it, so the card carries one
   * filter idiom rather than two stacked either side of a divider.
   *
   * The count rides in the label where there is one. An uncounted stage (see
   * `STAGES`) is just its name: a blank where a number belongs reads as a
   * number that failed to load.
   */
  const stageButton = ({
    state: value,
    label,
    count,
  }: (typeof STAGES)[number]) => {
    const n = count === null ? null : view?.page.openCounts[count];
    return (
      <s-press-button
        key={value ?? "all"}
        pressed={state === value}
        onClick={() => {
          setFilters({ q, state: value, paid, attention, team });
        }}
      >
        {n === undefined || n === null
          ? label
          : `${label} · ${formatNumber(n)}`}
      </s-press-button>
    );
  };

  /**
   * Same control as `stageButton`, for the same reason: the selected payment
   * filter used to be a `disabled` primary button, which reads to a screen
   * reader as "dimmed" — unavailable — when what it is is the one that is on.
   * `pressed` says that, and re-pressing it is a no-op rather than a dead
   * control.
   */
  const paidButton = (label: string, value: boolean | null) => (
    <s-press-button
      pressed={paid === value}
      onClick={() => {
        setFilters({ q, state, paid: value, attention, team });
      }}
    >
      {label}
    </s-press-button>
  );

  const attentionCount = view?.page.openCounts.attention ?? 0;

  return (
    <s-page heading="Orders" inlineSize="large">
      <SocketBanner />
      {/* Unconditional, empty list included: the resource-index template keeps
          the title-bar primary action and lets the empty state carry a second
          copy, so "sync is top right" holds on the visit where it matters most
          — a shop that has never synced has nothing else to do here.
          https://shopify.dev/docs/api/app-home/latest/patterns/templates/resource-index */}
      {syncButton(true)}

      <s-section padding="none" accessibilityLabel="Orders">
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="small-300">
            {view?.syncState.lastError !== null &&
              view?.syncState.lastError !== undefined && (
                <s-banner tone="critical">{view.syncState.lastError}</s-banner>
              )}
            <s-paragraph color="subdued">
              {syncStatusText(view, ordersQuery.isError)}
            </s-paragraph>
          </s-stack>
        </s-box>
        {/* One filter bar, gated on there being something to filter: see
            `neverStored`. The three rows share a grid so "Stage", "Payment"
            and "Waiting on" line up in a label column and their controls
            start at the same inline offset. */}
        {!neverStored && (
          <s-box padding="base">
            <s-stack gap="small-300">
              {/* Above the facet grid rather than inside it: a search is the
                  merchant arriving with an order in hand, not a facet crossed
                  with the others, and the placeholder is its own label. Width
                  capped like the team select, which fills whatever it is
                  given. The chip that says a search is on lives with the other
                  cross-cutting filters below. */}
              <s-grid
                gridTemplateColumns="minmax(0, 16rem)"
                justifyContent="start"
              >
                <s-text-field
                  ref={searchField}
                  label="Order number"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Order number"
                  value={searchDraft}
                  maxLength={32}
                  onInput={(event) => {
                    setSearchDraft(event.currentTarget.value);
                  }}
                  onBlur={submitSearch}
                />
              </s-grid>
              <s-grid
                gridTemplateColumns="auto 1fr"
                gap="base"
                alignItems="center"
              >
                <s-text color="subdued">Stage</s-text>
                <s-stack direction="inline" gap="small-300">
                  {STAGES.map(stageButton)}
                </s-stack>
                <s-text color="subdued">Payment</s-text>
                <s-stack direction="inline" gap="small-300">
                  {paidButton("All", null)}
                  {paidButton("Paid", true)}
                  {paidButton("Not paid", false)}
                  {/* Cross-cutting like payment, not a stage: the count is the
                      open orders with an unassigned or unstaffed step, and the
                      order page's "Assign team" picker is the remedy.

                      The one filter that stays an `s-button`: it is an alert,
                      not a neutral facet, and `s-press-button` only takes
                      `tone="neutral"`, so a press-button would cost the red
                      that is the whole point of the control. */}
                  {(attention || attentionCount > 0) && (
                    <s-button
                      variant={attention ? "primary" : "secondary"}
                      tone="critical"
                      onClick={() => {
                        setFilters({
                          q,
                          state,
                          paid,
                          attention: !attention,
                          team,
                        });
                      }}
                    >
                      {`Needs attention · ${formatNumber(attentionCount)}`}
                    </s-button>
                  )}
                  {/* The chip for the search, in the cross-cutting filter
                      row beside Clear filters and shaped like it. No
                      `accessibilityLabel`: the visible text is the accessible
                      name, so a locator and a screen reader read the same
                      string, and the sibling clear control labels itself the
                      same way. */}
                  {q !== null && (
                    <s-button
                      variant="tertiary"
                      onClick={() => {
                        setFilters({ q: null, state, paid, attention, team });
                      }}
                    >
                      {`Order ${Domain.normaliseOrderSearch(q)}`}
                    </s-button>
                  )}
                  {filtered && (
                    <s-button
                      variant="tertiary"
                      onClick={() => {
                        setFilters({
                          q: null,
                          state: null,
                          paid: null,
                          attention: false,
                          team: null,
                        });
                      }}
                    >
                      Clear filters
                    </s-button>
                  )}
                </s-stack>
                <s-text color="subdued">Waiting on</s-text>
                {/* A select rather than the press-buttons beside it: the team
                    list is unbounded where the payment states are three, and
                    a select whose value is the team already reads as the
                    active chip, so this is one control instead of a control
                    plus a chip. The primary way in is the drill-in from team
                    detail, which sets `?team=`.

                    Options are names only. A count per option would be a new
                    per-team aggregate on every refresh of a subscribed page,
                    which is the cost `Domain.OpenStageCounts` is bounded to
                    avoid. The grid caps the width: `s-select` fills whatever
                    inline size it is given. */}
                <s-grid
                  gridTemplateColumns="minmax(0, 16rem)"
                  justifyContent="start"
                >
                  <s-select
                    label="Waiting on"
                    labelAccessibilityVisibility="exclusive"
                    value={team ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setFilters({
                        q,
                        state,
                        paid,
                        attention,
                        team:
                          view?.teams.find(({ id }) => id === value)?.id ??
                          null,
                      });
                    }}
                  >
                    <s-option value="">Any team</s-option>
                    {view?.teams.map(({ id, name }) => (
                      <s-option key={id} value={id}>
                        {name}
                      </s-option>
                    ))}
                    {/* A link that set `?team=` outlives the team it named.
                        Without this the control would read "Any team" while
                        the list stayed filtered to nothing. */}
                    {team !== null && !teamName.has(team) && (
                      <s-option disabled value={team}>
                        Deleted team
                      </s-option>
                    )}
                  </s-select>
                </s-grid>
              </s-grid>
              {/* Only alongside rows. With none, `emptyText` says the same
                  thing in the body ("0 orders with work in progress." over
                  "Nothing is in production."), and printing both reads as a
                  stutter. */}
              {orders.length > 0 && stageText(view, state) !== null && (
                <s-paragraph color="subdued">
                  {stageText(view, state)}
                </s-paragraph>
              )}
            </s-stack>
          </s-box>
        )}
        {renderOrders()}
      </s-section>
    </s-page>
  );
}

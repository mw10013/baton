import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import {
  createFileRoute,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { QuotaBanners } from "@/components/QuotaBanners";
import { EmptyLine } from "@/components/screen/EmptyLine";
import { FilterRow } from "@/components/screen/FilterRow";
import { IndexSection } from "@/components/screen/IndexSection";
import { Inline } from "@/components/screen/Inline";
import { ListSearchField } from "@/components/screen/ListSearchField";
import { SearchLine } from "@/components/screen/SearchLine";
import { Strip } from "@/components/screen/Strip";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { adminOrderUrl, useResourceLinkTarget } from "@/lib/orderLinks";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";
import { ANY_OPTION_VALUE } from "@/lib/Screen";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useLiveQuery } from "@/lib/useLiveQuery";

const ORDERS_PAGE_SIZE = 25;

/**
 * Keyed by every filter, the search and the page as well as the shop: each
 * combination is a different read, and the order page's invalidation of
 * `["orders", shop]` is a prefix match so it still reaches every one of them.
 */
const ordersQueryKey = (
  shop: string,
  q: Domain.ListSearch | null,
  show: Domain.OrdersShow | null,
  team: Domain.TeamId | null,
  after: string | null,
) => ["orders", shop, q, show, team, after] as const;

/**
 * The strip, left to right: Open (the default, `?show=` left out), the
 * three open positions in the order an order moves, then Issues. These are
 * the five Show values `Domain.OrderCounts` counts; each cell is the value's
 * name over its count, and choosing it sets the Show filter. Fulfilled,
 * Cancelled and All carry no count and live only in the Show select.
 * Labels are `Domain.ORDERS_SHOW_LABEL`.
 */
const STRIP: readonly (keyof Domain.OrderCounts)[] = [
  "open",
  "not_started",
  "making",
  "made",
  "issues",
];

/**
 * The Show select's values, in its order: the strip's five, then the closed
 * positions and All. Open's option value is `"open"`, not `""`: an
 * `s-option` with an empty value takes its label as the value.
 */
const SHOW: readonly (Domain.OrdersShow | null)[] = [
  null,
  "not_started",
  "making",
  "made",
  "issues",
  "fulfilled",
  "cancelled",
  "all",
];

/**
 * `Schema.toType`, not the schema itself. A Durable Object RPC result has
 * already been through the repository's decoder, so what arrives is the
 * **decoded** shape — `fullyPaid` a boolean, `properties` an array. Decoding it again
 * against `Domain.OrdersIndexData` would demand the *encoded* row shape (`0`/`1`,
 * a JSON string) and fail on the first order. `toType` derives a validator over
 * the decoded side, so the wire value is checked without re-running transforms
 * that already ran. Same reasoning as the better-auth boundary in `Auth.ts`.
 */
const decodeOrdersIndexData = Schema.decodeUnknownPromise(
  Schema.toType(Domain.OrdersIndexData),
);
const decodeSyncResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.OrdersSyncResult),
);

/**
 * The row's link target. The detail page is addressed by `legacyId`; see
 * `Domain.GetOrderDetailInput`. No `search`: the layout's middleware puts the
 * merchant's filters and page on it (`OrdersSearch` in `app.orders.tsx`), so
 * the order page's URL carries them and its breadcrumb can take them back.
 */
const orderLocation = ({ legacyId }: Domain.ShopOrder) =>
  ({
    to: "/app/orders/$orderId",
    params: { orderId: legacyId },
  }) as const;

/**
 * The Status cell: the ladder badge, from `Domain.orderPosition` over the
 * row, one for every order, labelled by `Domain.ORDER_POSITION_LABEL`.
 * The Issues cell says when a not-started order waits on the merchant; an
 * order whose items matched no workflow is Not started and shows nothing
 * there, on purpose ({@link Domain.OrderIssue} says why). Made is
 * derived, never stored: it becomes Fulfilled on its own once Shopify
 * reports the fulfilment.
 */
const positionBadge = (row: Domain.OrderRow) => {
  const state = Domain.orderPosition(row);
  return (
    <s-badge
      tone={Match.value(state).pipe(
        Match.when("not_started", () => "neutral" as const),
        Match.when("making", () => "info" as const),
        Match.when("made", () => "success" as const),
        Match.when("fulfilled", () => "neutral" as const),
        Match.when("cancelled", () => "critical" as const),
        Match.exhaustive,
      )}
    >
      {Domain.ORDER_POSITION_LABEL[state]}
    </s-badge>
  );
};

/**
 * The Issues cell: one badge per `Domain.orderIssues` element, in that order,
 * labelled by `Domain.ORDER_ISSUE_LABEL`, toned `Domain.ORDER_ISSUE_TONE`.
 */
const issueBadges = (row: Domain.OrderRow) =>
  Domain.orderIssues(row).map((issue) => (
    <s-badge key={issue} tone={Domain.ORDER_ISSUE_TONE}>
      {Domain.ORDER_ISSUE_LABEL[issue]}
    </s-badge>
  ));

/**
 * The sync's whole status line: only while a sync runs. At rest there is
 * no line, not even a "Last synced" time: order webhooks keep the list
 * current after the first sync, so a standing timestamp would read as
 * something the merchant has to keep fresh, and an old one would make a
 * current list look stale.
 */
const syncStatusText = (
  data: Domain.OrdersIndexData | undefined,
  isError: boolean,
) => {
  if (isError) return "Couldn't read sync status.";
  if (data === undefined) return "Loading…";
  return data.syncState.inFlight
    ? "Syncing… this page updates as orders arrive."
    : null;
};

/**
 * What an empty list says, one line each (the `empty` slot, `CopySlot`).
 * With a team selected the list is narrowed by two filters, so the text says
 * that rather than claiming one value is empty. A search has its own heading
 * (see `renderOrders`).
 */
const emptyText = (
  show: Domain.OrdersShow | null,
  team: Domain.TeamId | null,
) =>
  team === null
    ? Match.value(show).pipe(
        Match.when(null, () => "No open orders."),
        Match.when("not_started", () => "No open orders are waiting to start."),
        Match.when("making", () => "Nothing is being made."),
        Match.when(
          "made",
          () => "No orders are made and waiting to be fulfilled.",
        ),
        Match.when("issues", () => "No orders have issues."),
        Match.when("fulfilled", () => "No orders have been fulfilled yet."),
        Match.when("cancelled", () => "No cancelled orders."),
        Match.when("all", () => "No orders yet."),
        Match.exhaustive,
      )
    : "No orders match these filters.";

/**
 * The loader read of the live screen: the current filters, search and page, read
 * Worker-side so it paints during SSR. The same `listOrders` over the socket
 * takes over on identify (see `useLiveQuery`). The page is in the URL like the
 * filters, so the SSR paint is the page the merchant left.
 */
const OrdersLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.ListSearch),
  show: Schema.NullOr(Domain.OrdersShow),
  team: Schema.NullOr(Domain.TeamId),
  after: Schema.NullOr(Domain.OrdersCursor),
});

/**
 * The first page, plus the usage the
 * page's limit banners need.
 *
 * `orders` is what the socket replaces on every order invalidation; `usage` is
 * loader-only and deliberately does not move under the socket. It is a
 * billing-cycle fact, and refreshing it on every webhook would be a read per
 * invalidation for a number that changes on a scale of days.
 */
interface OrdersIndexLoaderData {
  readonly orders: Domain.OrdersIndexData;
  readonly usage: Domain.ShopUsage;
}

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(OrdersLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(
    ({ data: { q, show, team, after }, context: { runEffect, session } }) =>
      runEffect(
        Effect.gen(function* () {
          const client = yield* ShopAgentClient;
          return {
            orders: yield* client.listOrders(session.shop, {
              limit: ORDERS_PAGE_SIZE,
              cursor: after,
              q,
              show,
              team,
            }),
            usage: yield* client.getUsage(session.shop),
          } satisfies OrdersIndexLoaderData;
        }),
      ),
  );

export const Route = createFileRoute("/app/orders/")({
  loaderDeps: ({ search }) => ({
    q: search.q ?? null,
    show: search.show ?? null,
    team: search.team ?? null,
    after: search.after ?? null,
  }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

/**
 * The orders index: one table of what the Durable Object has stored, with
 * the order position per order, and the Sync open orders button as a header action.
 * Everything per order — items, their properties, workflows — lives on
 * `/app/orders/$orderId`.
 *
 * A live screen (the loader-versus-socket rule on `ShopAgentClient`): the
 * loader paints the first page, then `useLiveQuery` reads `listOrders` over
 * the socket and refetches on every invalidation,
 * so the table stays current while a bulk stream and webhooks write
 * underneath it.
 */
function RouteComponent() {
  const { shop } = Route.useRouteContext();
  const {
    q = null,
    show = null,
    team = null,
    after = null,
  } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const nextPageEntry = useLocation({
    select: (location) => location.state.ordersNextPage === true,
  });
  const shopify = useAppBridge();
  const resourceLinkTarget = useResourceLinkTarget();
  const { orders: initialOrders, usage } = Route.useLoaderData();
  const [syncing, setSyncing] = React.useState(false);

  /**
   * A filter or search change is a new list, so the page resets to one. `replace: true`
   * for the member's workflows list's reason (`selectState` in `shop.$shop.workflows.index.tsx`): the
   * filters are a screen's state, not a trail.
   *
   * A patch over `prev`, not the whole set from this render: the URL commits
   * before the page re-renders with it, so a second control pressed in that
   * window would write the first one's old value back. A key left out of the
   * patch keeps its value; `null` clears it. Clearing writes `undefined` into
   * the search rather than omitting the key, because an omitted key is one
   * the layout's middleware retains (`OrdersSearch` in `app.orders.tsx`).
   */
  const setFilters = (patch: {
    readonly q?: Domain.ListSearch | null;
    readonly show?: Domain.OrdersShow | null;
    readonly team?: Domain.TeamId | null;
  }) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        q: patch.q === undefined ? prev.q : (patch.q ?? undefined),
        show: patch.show === undefined ? prev.show : (patch.show ?? undefined),
        team: patch.team === undefined ? prev.team : (patch.team ?? undefined),
        after: undefined,
      }),
      replace: true,
    });
  };

  /**
   * The repository pages forward only (keyset on `processedAt, id`), so the
   * URL holds the page being viewed and not the one before it. Next pushes a
   * history entry and marks it (`ordersNextPage`, declared in
   * `app.orders.tsx`), so on a marked entry the page before is the entry
   * before, and Previous is the browser's Back. Anywhere else — the list
   * reached by the breadcrumb, a nav link, a reload of a copied URL — the
   * page before is unknown, and Previous goes to page one, replacing the
   * entry so Back does not return to the page just left.
   */
  const nextPage = (cursor: string) => {
    void navigate({
      search: (prev) => ({ ...prev, after: cursor }),
      state: { ordersNextPage: true },
    });
  };
  const previousPage = () => {
    if (nextPageEntry) {
      router.history.back();
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, after: undefined }),
      replace: true,
    });
  };

  const {
    data,
    query: ordersQuery,
    invalidate,
    agent,
    identified,
  } = useLiveQuery({
    queryKey: ordersQueryKey(shop, q, show, team, after),
    read: (stub) =>
      stub
        .listOrders({
          limit: ORDERS_PAGE_SIZE,
          cursor: after,
          q,
          show,
          team,
        })
        .then(decodeOrdersIndexData),
    initialData: initialOrders,
  });

  const startSync = () => {
    if (!agent) return;
    setSyncing(true);
    withSocketRecovery(agent)(() => agent.stub.syncOpenOrders())
      .then(decodeSyncResult)
      .then((result) => {
        // A toast (`CopySlot`): the press did nothing, and the page would
        // otherwise only re-read the state it already shows.
        if (result._tag === "InFlight")
          shopify.toast.show("A sync is already running");
        return invalidate();
      })
      .catch((error: unknown) => {
        shopify.toast.show(
          error instanceof Error ? error.message : "Couldn't start the sync.",
          { isError: true },
        );
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  const syncInFlight = data?.syncState.inFlight ?? false;
  const orders = data?.page.orders ?? [];
  const filtered = q !== null || show !== null || team !== null;
  /**
   * Nothing stored and nothing filtered: the shop has never had orders here,
   * so the card is the empty state alone. Declared beside `orders` rather than
   * next to its first use because the section body, the filter box and
   * `renderOrders` all branch on it.
   */
  const neverStored = orders.length === 0 && !filtered;
  /** The team filter's select names the team its id points at. */
  const teamName = new Map(
    (data?.teams ?? []).map(({ id, name }) => [id, name]),
  );

  /**
   * Rendered twice: once into the page's `secondary-actions` slot, and once
   * inside the empty state where it is the only thing to do and so primary.
   * In the title bar it is secondary: syncing is a first-day step and a
   * repair when the list looks out of sync, not the page's routine action,
   * and a primary button there reads as a chore to repeat. The slot has to
   * sit on the button itself — `s-page` hoists the slotted element into the
   * admin's title bar, and a wrapper element in the slot is dropped. Because
   * App Bridge hoists the slotted copy out of the iframe, the in-card twin is
   * not a duplicate in the frame's DOM, so frame- and page-scoped e2e locators
   * stay disjoint.
   */
  const syncButton = (slotted: boolean) => (
    <s-button
      {...(slotted
        ? { slot: "secondary-actions" as const }
        : { variant: "primary" as const })}
      loading={syncing}
      disabled={!identified || syncing || syncInFlight}
      onClick={startSync}
    >
      Sync open orders
    </s-button>
  );

  /**
   * The never-stored state: the card is this block alone, with the filter bar
   * gone — filtering nothing is noise, and a bar of zeroes is what used to
   * squeeze this copy into the bottom corner of the card. Same centred shape as the other index pages'
   * empty states.
   *
   * A shop that has synced and still has nothing gets different copy: "pull
   * the window" is the wrong instruction once the pull has happened and come
   * back empty.
   */
  const emptyState = () => (
    <EmptyLine heading="No open orders" action={syncButton(false)}>
      {`Sync open orders to pull in what is on the bench, or wait for the next order. The sync takes the open, unfulfilled orders from the last ${String(ORDER_SYNC_WINDOW_DAYS)} days; after that, order webhooks keep them current.`}
    </EmptyLine>
  );

  /** The search as the screen prints it (`Domain.searchTermText`): `#1001`, or the typed words. */
  const term = q === null ? null : Domain.searchTermText(Domain.searchTerm(q));
  const clearSearch = () => {
    setFilters({ q: null });
  };

  /**
   * The filter slot: Show, the search, then Team, labels hidden on screen
   * (the controls table's row for a filter beside a search, `Control` in
   * `Screen.ts`), in a {@link FilterRow} above the table or the empty
   * sentence, so the controls that emptied the list stay in reach.
   *
   * The selects are disabled under a search, because the read ignores them
   * (`Domain.ListOrdersInput.q`) and a filter that looks set but does
   * nothing is the controls table's "never" (`Control` in `Screen.ts`). They
   * keep their values, so Clear search restores the list they describe.
   *
   * Show is the main filter ({@link Domain.OrdersShow}), and the strip sets
   * the same value. Team is a select rather than buttons: the
   * team list is unbounded. The primary way in is the drill-in from the team
   * page, which sets `?team=`. It keeps the orders waiting on the team
   * ({@link Domain.ListOrdersInput} `team`). Under Fulfilled it can only match nothing, because a closed
   * order waits on no team; that reads as an
   * empty list with its text, which is better than a control that disappears.
   * Options are names only: a count per option would be a new per-team
   * aggregate on every refresh of a live screen, which is the cost
   * `Domain.OrderCounts` is bounded to avoid.
   *
   * No chips: both filters are selects that always show their value, so a
   * chip per chosen value would repeat it, and the select already clears it.
   */
  const filters = () => (
    <FilterRow
      main={
        <s-select
          label="Show"
          labelAccessibilityVisibility="exclusive"
          value={show ?? "open"}
          disabled={q !== null}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFilters({
              show: SHOW.find((each) => each === value) ?? null,
            });
          }}
        >
          {SHOW.map((each) => (
            <s-option key={each ?? "open"} value={each ?? "open"}>
              {Domain.ORDERS_SHOW_LABEL[each ?? "open"]}
            </s-option>
          ))}
        </s-select>
      }
      search={
        <ListSearchField
          value={q}
          onSubmit={(next) => {
            setFilters({ q: next });
          }}
        />
      }
      secondary={
        <s-select
          label="Team"
          labelAccessibilityVisibility="exclusive"
          value={team ?? ANY_OPTION_VALUE}
          disabled={q !== null}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFilters({
              team: data?.teams.find(({ id }) => id === value)?.id ?? null,
            });
          }}
        >
          <s-option value={ANY_OPTION_VALUE}>Any team</s-option>
          {data?.teams.map(({ id, name }) => (
            <s-option key={id} value={id}>
              {name}
            </s-option>
          ))}
          {/* A link that set `?team=` outlives the team it named. Without
            this the control would read "Any team" while the list stayed
            filtered to nothing. */}
          {team !== null && !teamName.has(team) && (
            <s-option disabled value={team}>
              Deleted team
            </s-option>
          )}
        </s-select>
      }
    />
  );

  const renderOrders = () => {
    /**
     * A failed read renders as a failure. Without this the page shows
     * "Loading orders…" forever on any error — a decode mismatch, a dropped
     * socket, a Durable Object fault all look identical to a slow fetch, and
     * the only way to see the cause is the browser console.
     */
    if (ordersQuery.isError) return null;
    /**
     * An empty filtered list or a search that missed: one sentence in the
     * list's place ({@link EmptyLine}). The search names what it did not
     * find, because what the merchant typed is the whole question they
     * asked, and offers Clear search (the controls table's rule for a search
     * with nothing matching); the filter copy answers a different question
     * and would read as a non sequitur under a search that missed.
     */
    if (orders.length === 0 && filtered)
      return term === null ? (
        <EmptyLine>{emptyText(show, team)}</EmptyLine>
      ) : (
        <EmptyLine
          action={<s-button onClick={clearSearch}>Clear search</s-button>}
        >{`No order matches ${term}`}</EmptyLine>
      );
    if (orders.length === 0) return emptyState();
    return (
      <s-table
        paginate={after !== null || data.page.nextCursor !== null}
        loading={ordersQuery.isFetching}
        hasPreviousPage={after !== null}
        hasNextPage={data.page.nextCursor !== null}
        onPreviousPage={previousPage}
        onNextPage={() => {
          const next = data.page.nextCursor;
          if (next !== null) nextPage(next);
        }}
      >
        {/* Status and Issues are two columns because they are two facts:
            an order has one position and any number of issues. "Status" is
            right for a column, which holds exactly one value per row; the
            select is Show because its values are lists, not one fact. */}
        <s-table-header-row>
          <s-table-header listSlot="primary">Order</s-table-header>
          <s-table-header listSlot="secondary">Placed</s-table-header>
          <s-table-header listSlot="inline">Payment</s-table-header>
          <s-table-header listSlot="inline">Status</s-table-header>
          <s-table-header listSlot="inline">Issues</s-table-header>
          <s-table-header listSlot="labeled" format="numeric">
            Items
          </s-table-header>
          <s-table-header listSlot="labeled">Shopify</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {orders.map((row) => (
            <s-table-row key={row.order.id} id={row.order.id}>
              <s-table-cell>
                <s-link
                  href={router.buildLocation(orderLocation(row.order)).href}
                >
                  {row.order.name}
                </s-link>
              </s-table-cell>
              <s-table-cell>
                <LocalDateTime value={row.order.processedAt} format="date" />
              </s-table-cell>
              <s-table-cell>
                <s-badge tone={row.order.fullyPaid ? "success" : "warning"}>
                  {row.order.fullyPaid ? "Paid" : "Unpaid"}
                </s-badge>
              </s-table-cell>
              <s-table-cell>{positionBadge(row)}</s-table-cell>
              {/* No placeholder for an empty cell, for the Waiting on
                  cell's reason: emptiness is the point, and a merchant
                  scanning down the column sees the badges at once. */}
              <s-table-cell>
                <Inline>{issueBadges(row)}</Inline>
              </s-table-cell>
              <s-table-cell>{formatNumber(row.itemUnits)}</s-table-cell>
              {/* The order in the Shopify admin, where a made order is
                  fulfilled. An icon, not "View in Shopify" on every row:
                  the header already says where it goes, and the same three
                  words down the column were noise. The label carries the
                  link copy for a screen reader (`CopySlot` link row). */}
              <s-table-cell>
                <s-button
                  icon="external"
                  variant="tertiary"
                  href={adminOrderUrl(row.order)}
                  target={resourceLinkTarget}
                  accessibilityLabel={`Open ${row.order.name} in Shopify`}
                />
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  /**
   * The strip ({@link Strip}): each cell a radio button over the Show
   * filter. Choosing a cell sets Show to its value, so at most one cell is
   * chosen, and none under Fulfilled, Cancelled or All, which have no cell;
   * the Show select names those. Each count is the list its cell opens
   * ({@link Domain.OrderCounts}). No cell is red: the alarm colour belongs
   * with the remedy, on the Issues badges.
   */
  const strip = (
    <Strip
      cells={STRIP.map((key) => {
        const value = key === "open" ? null : key;
        return {
          key,
          label: Domain.ORDERS_SHOW_LABEL[key],
          count: data?.page.counts[key] ?? 0,
          chosen: show === value,
          onSelect: () => {
            setFilters({ show: value });
          },
        };
      })}
    />
  );

  /**
   * What replaces the strip under a search ({@link SearchLine}): how many
   * stored orders match, and Clear search. The count is the search's own
   * (`Domain.OrdersPage.matches`), over every page. A search that matched
   * nothing says so in the list's place instead.
   */
  const matches = data?.page.matches ?? 0;
  const searchLine =
    term === null || matches === 0 ? null : (
      <SearchLine
        count={matches}
        noun={["order", "orders"]}
        term={term}
        onClear={clearSearch}
      />
    );

  const syncError = data?.syncState.lastError ?? null;
  const syncStatus = syncStatusText(data, ordersQuery.isError);

  return (
    <s-page heading="Orders" inlineSize="large">
      <SocketBanner />
      {/* Above the sync button on purpose: the merchant who notices an order
          missing here is the one these two banners are for. */}
      <QuotaBanners usage={usage} />
      {/* Unconditional, empty list included: the resource-index template keeps
          the title-bar action and lets the empty state carry a second copy,
          so "sync is top right" holds on every visit.
          https://shopify.dev/docs/api/app-home/latest/patterns/templates/resource-index */}
      {syncButton(true)}

      {/* The head, in order: the sync's error and status, then the strip
          or under a search the line that replaces it, then the filter row.
          The strip and the filters are gated on there being something to
          filter: see `neverStored`. A failed read renders as a failure
          rather than "Loading orders…" forever: a decode mismatch, a dropped
          socket and a Durable Object fault all look like a slow fetch
          otherwise. */}
      <IndexSection
        label="Orders"
        head={
          <>
            {syncError !== null && (
              <s-banner tone="critical">{syncError}</s-banner>
            )}
            {syncStatus !== null && (
              <s-paragraph color="subdued">{syncStatus}</s-paragraph>
            )}
            {ordersQuery.isError && (
              <s-banner tone="critical">
                {ordersQuery.error instanceof Error
                  ? ordersQuery.error.message
                  : "Couldn't load orders."}
              </s-banner>
            )}
            {!neverStored && (q === null ? strip : searchLine)}
            {!neverStored && filters()}
          </>
        }
      >
        {renderOrders()}
      </IndexSection>
    </s-page>
  );
}

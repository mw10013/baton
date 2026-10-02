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

import { ListSearchField } from "@/components/ListSearchField";
import { LocalDateTime } from "@/components/LocalDateTime";
import { QuotaBanners } from "@/components/QuotaBanners";
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
 * Caps the Waiting on cell at two team names and a `+n`. The names sit one
 * per line, so the cap bounds the row's height, not its width (the width is
 * bounded by the names wrapping; see {@link waitingOnNames}). Three or more
 * current teams on one order is a parallel step across three teams, rare
 * enough that a count serves it.
 */
const WAITING_ON_LIMIT = 2;

/** The `?issues=` value a patch writes: `1` on, `undefined` off, the old value when the patch leaves it out. */
const issuesKeyOf = (next: boolean | undefined, prev: 1 | undefined) => {
  if (next === undefined) return prev;
  return next ? (1 as const) : undefined;
};

/**
 * Keyed by every filter, the search and the page as well as the shop: each
 * combination is a different read, and the order page's invalidation of
 * `["orders", shop]` is a prefix match so it still reaches every one of them.
 */
const ordersQueryKey = (
  shop: string,
  q: Domain.ListSearch | null,
  position: Domain.OrdersPositionFilter | null,
  issues: boolean,
  team: Domain.TeamId | null,
  after: string | null,
) => ["orders", shop, q, position, issues, team, after] as const;

/**
 * The strip, left to right: Open (the default, `?position=` left out), the
 * three open positions in the order an order moves, then Issues, which cuts
 * across them. These are the five values `Domain.OrderCounts` counts; each
 * cell is the value's name over its count and is a one-click filter. Fulfilled,
 * Cancelled and All carry no count and live only in the Status select.
 * Labels are `Domain.ORDERS_FILTER_LABEL`.
 */
const STRIP: readonly (keyof Domain.OrderCounts)[] = [
  "open",
  "not_started",
  "making",
  "made",
  "issues",
];

/**
 * The Status select's values, in its order: Open, the positions, All. Open's
 * option value is `"open"`, not `""`: an `s-option` with an empty value takes
 * its label as the value.
 */
const POSITIONS: readonly (Domain.OrdersPositionFilter | null)[] = [
  null,
  "not_started",
  "making",
  "made",
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
 * With a team selected the list is narrowed by more than one filter, so the
 * text says that rather than claiming one value is empty. A search has its
 * own heading (see `renderOrders`).
 */
const emptyText = (
  position: Domain.OrdersPositionFilter | null,
  issues: boolean,
  team: Domain.TeamId | null,
) => {
  if (team !== null) return "No orders match these filters.";
  if (!issues) return positionEmptyText(position);
  return Match.value(position).pipe(
    Match.when(
      (value) => value === null || value === "all",
      () => "No open orders have issues.",
    ),
    Match.when(
      (value) => value === "fulfilled" || value === "cancelled",
      () => "A fulfilled or cancelled order has no issues.",
    ),
    Match.orElse(
      (value) =>
        `No ${Domain.ORDERS_FILTER_LABEL[value ?? "open"].toLowerCase()} orders have issues.`,
    ),
  );
};

const positionEmptyText = (position: Domain.OrdersPositionFilter | null) =>
  Match.value(position).pipe(
    Match.when(null, () => "No open orders."),
    Match.when("not_started", () => "No open orders are waiting to start."),
    Match.when("making", () => "Nothing is being made."),
    Match.when("made", () => "No orders are made and waiting to be fulfilled."),
    Match.when("fulfilled", () => "No orders have been fulfilled yet."),
    Match.when("cancelled", () => "No cancelled orders."),
    Match.when("all", () => "No orders yet."),
    Match.exhaustive,
  );

/**
 * The loader half of the subscribed page: the current filters, search and page, read
 * Worker-side so it paints during SSR. The socket's `subscribeOrders` takes
 * over on identify (see `useSubscribedQuery`). The page is in the URL like the
 * filters, so the SSR paint is the page the merchant left.
 */
const OrdersLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.ListSearch),
  position: Schema.NullOr(Domain.OrdersPositionFilter),
  issues: Schema.Boolean,
  team: Schema.NullOr(Domain.TeamId),
  after: Schema.NullOr(Domain.OrdersCursor),
});

/**
 * The first page, plus the usage the
 * page's limit banners need.
 *
 * `orders` is what the socket replaces on every order push; `usage` is
 * loader-only and deliberately does not move under the socket. It is a
 * billing-cycle fact, and refreshing it on every webhook would be a read per
 * push for a number that changes on a scale of days.
 */
interface OrdersIndexLoaderData {
  readonly orders: Domain.OrdersIndexData;
  readonly usage: Domain.ShopUsage;
}

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(OrdersLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(
    ({
      data: { q, position, issues, team, after },
      context: { runEffect, session },
    }) =>
      runEffect(
        Effect.gen(function* () {
          const client = yield* ShopAgentClient;
          return {
            orders: yield* client.listOrders(session.shop, {
              limit: ORDERS_PAGE_SIZE,
              cursor: after,
              q,
              position,
              issues,
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
    position: search.position ?? null,
    issues: search.issues === 1,
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
    position = null,
    issues: issuesKey,
    team = null,
    after = null,
  } = Route.useSearch();
  const issues = issuesKey === 1;
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
    readonly position?: Domain.OrdersPositionFilter | null;
    readonly issues?: boolean;
    readonly team?: Domain.TeamId | null;
  }) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        q: patch.q === undefined ? prev.q : (patch.q ?? undefined),
        position:
          patch.position === undefined
            ? prev.position
            : (patch.position ?? undefined),
        issues: issuesKeyOf(patch.issues, prev.issues),
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
  } = useSubscribedQuery({
    queryKey: ordersQueryKey(shop, q, position, issues, team, after),
    subscribe: (stub, subscriberId) =>
      stub
        .subscribeOrders({
          limit: ORDERS_PAGE_SIZE,
          cursor: after,
          q,
          position,
          issues,
          team,
          subscriberId,
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
  const filtered = q !== null || position !== null || issues || team !== null;
  /**
   * Nothing stored and nothing filtered: the shop has never had orders here,
   * so the card is the empty state alone. Declared beside `orders` rather than
   * next to its first use because the section body, the filter box and
   * `renderOrders` all branch on it.
   */
  const neverStored = orders.length === 0 && !filtered;
  /**
   * `OrderRow.waitingOn` is ids — the Durable Object has no team names — and
   * these are the teams it was derived against, carried in the same read.
   */
  const teamName = new Map(
    (data?.teams ?? []).map(({ id, name }) => [id, name]),
  );

  /**
   * Who is holding the order: the teams with a current task on one of its open
   * runs, one name per line, capped by {@link WAITING_ON_LIMIT}. Text, not
   * badges: a badge is one state word (`CopySlot`'s controls table), and a
   * team name is a name. Text also wraps, so the column's floor is a name's
   * longest word, where a badge never wraps or truncates and a 32-character
   * name made the column 200px wide, which at a 1024px viewport (an 800px
   * iframe, 752px for the card) pushed the last columns past the card's edge
   * into a scroll the admin gives no scrollbar for. `"Deleted team"` should
   * never render — the repository only emits ids that were among the teams it
   * read — but the lookup is nullable and a blank line is worse than a named
   * gap.
   */
  const waitingOnNames = (ids: readonly Domain.TeamId[]) => (
    <s-stack direction="block" gap="small-300">
      {ids.slice(0, WAITING_ON_LIMIT).map((id) => (
        <s-text key={id}>{teamName.get(id) ?? "Deleted team"}</s-text>
      ))}
      {ids.length > WAITING_ON_LIMIT && (
        <s-text color="subdued">{`+${String(ids.length - WAITING_ON_LIMIT)}`}</s-text>
      )}
    </s-stack>
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
    <s-box padding="base">
      <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
        <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
          <s-stack alignItems="center" gap="small-300">
            <s-heading>No open orders</s-heading>
            <s-paragraph color="subdued">
              {`Sync open orders to pull in what is on the bench, or wait for the next order. The sync takes the open, unfulfilled orders from the last ${String(ORDER_SYNC_WINDOW_DAYS)} days; after that, order webhooks keep them current.`}
            </s-paragraph>
          </s-stack>
          {syncButton(false)}
        </s-grid>
      </s-grid>
    </s-box>
  );

  /** The search as the screen prints it (`Domain.searchTermText`): `#1001`, or the typed words. */
  const term = q === null ? null : Domain.searchTermText(Domain.searchTerm(q));
  const clearSearch = () => {
    setFilters({ q: null });
  };

  /**
   * The filter slot: the search, then Status and Team, then a chip per chosen
   * value. Rendered in the table's `filters` slot when there are rows, and
   * above the empty sentence when there are none, so the controls that
   * emptied the list stay in reach.
   *
   * The selects are disabled under a search, because the read ignores them
   * (`Domain.ListOrdersInput.q`) and a filter that looks set but does
   * nothing is the controls table's "never" (`Control` in `Screen.ts`). They
   * keep their values, so Clear search restores the list they describe.
   *
   * Status is the main filter ({@link Domain.OrdersPositionFilter}), labelled
   * because it is one axis now; Issues is not one of its values, it is the
   * strip's last cell and a chip. Team is a select rather than buttons: the
   * team list is unbounded. The primary way in is the drill-in from the team
   * page, which sets `?team=`. It keeps the orders the Waiting on column names
   * the team for. Under Fulfilled it can only match nothing, because a closed
   * order waits on no team (`Domain.OrderRow.waitingOn`); that reads as an
   * empty list with its text, which is better than a control that disappears.
   * Options are names only: a count per option would be a new per-team
   * aggregate on every refresh of a subscribed page, which is the cost
   * `Domain.OrderCounts` is bounded to avoid.
   *
   * The chips name what is chosen, so a filter the strip does not show
   * (Fulfilled, a team) is still visible, and removing one clears that
   * filter. None under a search, for the selects' reason.
   */
  const filters = (slotted: boolean) => (
    <s-stack {...(slotted ? { slot: "filters" } : {})} gap="small-300">
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 560px) 1fr 12rem 12rem, 1fr"
          gap="small-300"
          alignItems="end"
        >
          <ListSearchField
            value={q}
            onSubmit={(next) => {
              setFilters({ q: next });
            }}
          />
          <s-select
            label="Status"
            value={position ?? "open"}
            disabled={q !== null}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setFilters({
                position: POSITIONS.find((each) => each === value) ?? null,
              });
            }}
          >
            {POSITIONS.map((each) => (
              <s-option key={each ?? "open"} value={each ?? "open"}>
                {Domain.ORDERS_FILTER_LABEL[each ?? "open"]}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Team"
            value={team ?? ""}
            disabled={q !== null}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setFilters({
                team: data?.teams.find(({ id }) => id === value)?.id ?? null,
              });
            }}
          >
            <s-option value="">Any team</s-option>
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
        </s-grid>
      </s-query-container>
      {q === null && (position !== null || issues || team !== null) && (
        <s-stack direction="inline" gap="small-300">
          {position !== null && (
            <s-clickable-chip
              removable
              onRemove={() => {
                setFilters({ position: null });
              }}
            >
              {Domain.ORDERS_FILTER_LABEL[position]}
            </s-clickable-chip>
          )}
          {issues && (
            <s-clickable-chip
              removable
              onRemove={() => {
                setFilters({ issues: false });
              }}
            >
              {Domain.ORDERS_FILTER_LABEL.issues}
            </s-clickable-chip>
          )}
          {team !== null && (
            <s-clickable-chip
              removable
              onRemove={() => {
                setFilters({ team: null });
              }}
            >
              {teamName.get(team) ?? "Deleted team"}
            </s-clickable-chip>
          )}
        </s-stack>
      )}
    </s-stack>
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
        <s-box padding="base">
          <s-banner tone="critical">
            {ordersQuery.error instanceof Error
              ? ordersQuery.error.message
              : "Couldn't load orders."}
          </s-banner>
        </s-box>
      );
    /**
     * An empty filtered list or a search that missed: centred like
     * `emptyState`, since a lone line in the card's corner read as leftover
     * text rather than the answer. The search names what it did not find,
     * because what the merchant typed is the whole question they asked, and
     * offers Clear search (the controls table's rule for a search with
     * nothing matching); the filter copy answers a different question and
     * would read as a non sequitur under a search that missed.
     */
    if (orders.length === 0 && filtered)
      return (
        <>
          <s-box padding="base" paddingBlockEnd="none">
            {filters(false)}
          </s-box>
          <s-box padding="base">
            <s-grid justifyItems="center" paddingBlock="large-400">
              <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
                {term === null ? (
                  <s-paragraph color="subdued">
                    {emptyText(position, issues, team)}
                  </s-paragraph>
                ) : (
                  <>
                    <s-heading>{`No order matches ${term}`}</s-heading>
                    <s-button onClick={clearSearch}>Clear search</s-button>
                  </>
                )}
              </s-grid>
            </s-grid>
          </s-box>
        </>
      );
    if (orders.length === 0) return emptyState();
    return (
      <s-table
        paginate
        loading={ordersQuery.isFetching}
        hasPreviousPage={after !== null}
        hasNextPage={data.page.nextCursor !== null}
        onPreviousPage={previousPage}
        onNextPage={() => {
          const next = data.page.nextCursor;
          if (next !== null) nextPage(next);
        }}
      >
        {filters(true)}
        {/* Status and Issues are two columns because each has its own
            filter, and a column is headed by its filter's word. "Status" is
            right for a column, which holds exactly one value per row, and
            for the select, which picks one position. */}
        <s-table-header-row>
          <s-table-header listSlot="primary">Order</s-table-header>
          <s-table-header listSlot="secondary">Placed</s-table-header>
          <s-table-header listSlot="inline">Payment</s-table-header>
          <s-table-header listSlot="inline">Status</s-table-header>
          <s-table-header listSlot="inline">Issues</s-table-header>
          <s-table-header listSlot="labeled">Waiting on</s-table-header>
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
                <s-stack direction="inline" gap="small-300">
                  {issueBadges(row)}
                </s-stack>
              </s-table-cell>
              {/* No placeholder for an empty cell. On an order with
                  open runs, empty means every current task is unassigned
                  (a team with no members still shows, so the merchant knows
                  which team needs a member), and the Needs a team badge
                  beside it already says so. A dash would flatten that into
                  "nothing to see". A fulfilled or cancelled order is always
                  empty (`Domain.OrderRow.waitingOn`). */}
              <s-table-cell>{waitingOnNames(row.waitingOn)}</s-table-cell>
              <s-table-cell>{formatNumber(row.itemUnits)}</s-table-cell>
              {/* The packer's handoff: a made order is fulfilled in the
                  Shopify admin, never here, so the Made row links
                  straight to it. Other rows get the same link under a
                  neutral label. */}
              <s-table-cell>
                <s-link
                  href={adminOrderUrl(row.order)}
                  target={resourceLinkTarget}
                >
                  {Domain.orderPosition(row) === "made"
                    ? "Fulfill in Shopify"
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
   * One cell of the strip, the metrics-card composition
   * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/metrics-card.md`):
   * the value's name over its count, the whole cell a one-click filter. Open
   * clears the position and Issues; a position sets the position and keeps
   * Issues; Issues sets Issues and keeps the position, so Making then Issues
   * is the making orders with an issue.
   *
   * The chosen cells are filled (`background="subdued"`), and a chip under
   * the filters names each one. Not `aria-current`: `s-clickable` leaves it on
   * the host, and the native button in its shadow root, which is what a
   * screen reader reads, never gets it; the accessibility label says
   * "selected" instead, since that label does reach the button. A count
   * always renders, at zero if need be,
   * so nothing on the strip appears or disappears with the data. No cell is
   * red: the alarm colour belongs with the remedy, on the Issues badges.
   */
  const stripCell = (key: (typeof STRIP)[number]) => {
    const label = Domain.ORDERS_FILTER_LABEL[key];
    const n = data?.page.counts[key] ?? 0;
    const chosen = Match.value(key).pipe(
      Match.when("open", () => position === null && !issues),
      Match.when("issues", () => issues),
      Match.orElse((value) => position === value),
    );
    return (
      <s-clickable
        key={key}
        paddingBlock="small-400"
        paddingInline="small-100"
        borderRadius="base"
        background={chosen ? "subdued" : "transparent"}
        accessibilityLabel={`${label}, ${formatNumber(n)}${chosen ? ", selected" : ""}`}
        onClick={() => {
          setFilters(
            Match.value(key).pipe(
              Match.when("open", () => ({ position: null, issues: false })),
              Match.when("issues", () => ({ issues: true })),
              Match.orElse((value) => ({ position: value })),
            ),
          );
        }}
      >
        <s-grid gap="small-300">
          <s-heading>{label}</s-heading>
          <s-text>{formatNumber(n)}</s-text>
        </s-grid>
      </s-clickable>
    );
  };

  /**
   * What replaces the strip under a search (`Control` in `Screen.ts`, "a
   * search is on"): how many stored orders match, and Clear search. The
   * count is the search's own (`Domain.OrdersPage.matches`), over every page.
   * A search that matched nothing says so in the list's place instead.
   */
  const searchLine = () => {
    const matches = data?.page.matches ?? 0;
    if (term === null || matches === 0) return null;
    return (
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-text>
          {matches === 1
            ? `1 order matches ${term}`
            : `${formatNumber(matches)} orders match ${term}`}
        </s-text>
        <s-button onClick={clearSearch}>Clear search</s-button>
      </s-stack>
    );
  };

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

      <s-section padding="none" accessibilityLabel="Orders">
        {/* Rendered only with something in it: an empty box would still add
            its padding above the strip's own. */}
        {(syncError !== null || syncStatus !== null) && (
          <s-box padding="base" paddingBlockEnd="none">
            <s-stack gap="small-300">
              {syncError !== null && (
                <s-banner tone="critical">{syncError}</s-banner>
              )}
              {syncStatus !== null && (
                <s-paragraph color="subdued">{syncStatus}</s-paragraph>
              )}
            </s-stack>
          </s-box>
        )}
        {/* Gated on there being something to filter: see `neverStored`. The
            strip, or under a search the line that replaces it, then the
            table with its filter slot. Five columns where the card has room,
            three below. The track lists carry no commas, here and in the
            filter slot: a comma separates a responsive value's conditions. */}
        {!neverStored && q === null && (
          <s-box padding="base" paddingBlockEnd="none">
            <s-query-container>
              <s-grid
                gridTemplateColumns="@container (inline-size > 600px) 1fr 1fr 1fr 1fr 1fr, 1fr 1fr 1fr"
                gap="small"
              >
                {STRIP.map(stripCell)}
              </s-grid>
            </s-query-container>
          </s-box>
        )}
        {!neverStored && q !== null && searchLine() !== null && (
          <s-box padding="base" paddingBlockEnd="none">
            {searchLine()}
          </s-box>
        )}
        {renderOrders()}
      </s-section>
    </s-page>
  );
}

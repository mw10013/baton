import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import {
  createFileRoute,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Option, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { QuotaBanners } from "@/components/QuotaBanners";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { adminOrderUrl, useResourceLinkTarget } from "@/lib/orderLinks";
import { ORDER_IMPORT_WINDOW_DAYS } from "@/lib/orderSyncConstants";
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
 * The field sets no `maxLength`: Polaris would draw a character counter, and
 * no order number comes near the limit.
 */
const decodeOrderSearch = Schema.decodeUnknownOption(Domain.OrderSearch);
/**
 * Caps the Waiting on cell at two team badges and a `+n`. With
 * `Domain.TEAM_NAME_MAX_LENGTH` this bounds the cell's width: two names at the
 * cap are about 500px, where three pushed the table past the admin's content
 * width. Three or more current teams on one order is a parallel step across
 * three teams, rare enough that a count serves it.
 */
const TAG_BADGE_LIMIT = 2;

/**
 * Keyed by the view, every filter and the page as well as the shop: each
 * combination is a different read, and the order page's invalidation of
 * `["orders", shop]` is a prefix match so it still reaches every one of them.
 */
const ordersQueryKey = (
  shop: string,
  q: Domain.OrderSearch | null,
  view: Domain.OrdersIndexView | null,
  team: Domain.TeamId | null,
  after: string | null,
) => ["orders", shop, q, view, team, after] as const;

/**
 * The view row, left to right: Open (the default, `null` in the URL), the
 * ladder in the order an order moves, Fulfilled, All, and then Issues set
 * apart at the row's end. Each is one whole question and exactly one is
 * pressed ({@link Domain.OrdersIndexView}, which carries the rule and why the
 * row is not two crossed rows). Open, the positions and All read as one run:
 * a total, its parts in lifecycle order, then the scope widening to the whole
 * history. Issues cuts across the three open positions rather than following
 * them, so it sits outside that run instead of breaking it, at the row's far
 * edge. There is no label to the row's left: the row holds scopes
 * and positions side by side, and a label such as "Status" would promise one
 * axis. `count` is the `Domain.OrderCounts` key the button shows; Fulfilled
 * and All carry none. `cancelled` has no button. Labels are
 * `Domain.ORDERS_INDEX_VIEW_LABEL`.
 */
const VIEWS: readonly {
  readonly value: Exclude<Domain.OrdersIndexView, "cancelled"> | null;
  readonly count: keyof Domain.OrderCounts | null;
}[] = [
  { value: null, count: "open" },
  { value: "not_started", count: "not_started" },
  { value: "making", count: "making" },
  { value: "made", count: "made" },
  { value: "fulfilled", count: null },
  { value: "all", count: null },
];

/** Issues, set apart at the view row's end ({@link VIEWS}). */
const ISSUES_VIEW: (typeof VIEWS)[number] = {
  value: "issues",
  count: "issues",
};

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
 * The import's whole status line: only while an import runs. At rest there is
 * no line, not even a "Last imported" time: order webhooks keep the list
 * current after the first import, so a standing timestamp would read as
 * something the merchant has to keep fresh, and an old one would make a
 * current list look stale.
 */
const syncStatusText = (
  data: Domain.OrdersIndexData | undefined,
  isError: boolean,
) => {
  if (isError) return "Couldn't read import status.";
  if (data === undefined) return "Loading…";
  return data.syncState.inFlight
    ? "Importing… this page updates as orders arrive."
    : null;
};

/**
 * The Issues banner's heading: how many open orders have an issue, given the
 * team. No body: the Issues column carries the breakdown by kind, and
 * repeating it in the banner would be the table said twice.
 */
const issuesHeading = (n: number) =>
  n === 1
    ? "1 open order has an issue"
    : `${formatNumber(n)} open orders have issues`;

/**
 * What an empty view says, one line each. With a team selected the list is
 * narrowed by a filter as well as a view, so the text says that rather than
 * claiming the view itself is empty. A search has its own heading (see
 * `renderOrders`).
 */
const emptyText = (
  view: Domain.OrdersIndexView | null,
  team: Domain.TeamId | null,
) =>
  team === null
    ? Match.value(view).pipe(
        Match.when(null, () => "No open orders."),
        Match.when("issues", () => "No open orders have issues."),
        Match.when("not_started", () => "No open orders are waiting to start."),
        Match.when("making", () => "Nothing is being made."),
        Match.when(
          "made",
          () => "No orders are made and waiting to be fulfilled.",
        ),
        Match.when("fulfilled", () => "No orders have been fulfilled yet."),
        Match.when("cancelled", () => "No cancelled orders."),
        Match.when("all", () => "No orders yet."),
        Match.exhaustive,
      )
    : "No orders match these filters.";

/**
 * The loader half of the subscribed page: the current view, filters and page, read
 * Worker-side so it paints during SSR. The socket's `subscribeOrders` takes
 * over on identify (see `useSubscribedQuery`). The page is in the URL like the
 * filters, so the SSR paint is the page the merchant left.
 */
const OrdersLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.OrderSearch),
  view: Schema.NullOr(Domain.OrdersIndexView),
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
    ({ data: { q, view, team, after }, context: { runEffect, session } }) =>
      runEffect(
        Effect.gen(function* () {
          const client = yield* ShopAgentClient;
          return {
            orders: yield* client.listOrders(session.shop, {
              limit: ORDERS_PAGE_SIZE,
              cursor: after,
              q,
              view,
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
    view: search.view ?? null,
    team: search.team ?? null,
    after: search.after ?? null,
  }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

/**
 * The orders index: one table of what the Durable Object has stored, with
 * the order position per order, and the window-sync button as a header action.
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
    view = null,
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
   * A view or filter change is a new list, so the page resets to one. `replace: true`
   * for the member's workflows list's reason (`selectView` in `shop.$shop.workflows.index.tsx`): the
   * view and filters are a screen's state, not a trail.
   *
   * A patch over `prev`, not the whole set from this render: the URL commits
   * before the page re-renders with it, so a second control pressed in that
   * window would write the first one's old value back. A key left out of the
   * patch keeps its value; `null` clears it. Clearing writes `undefined` into
   * the search rather than omitting the key, because an omitted key is one
   * the layout's middleware retains (`OrdersSearch` in `app.orders.tsx`).
   */
  const setFilters = (patch: {
    readonly q?: Domain.OrderSearch | null;
    readonly view?: Domain.OrdersIndexView | null;
    readonly team?: Domain.TeamId | null;
  }) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        q: patch.q === undefined ? prev.q : (patch.q ?? undefined),
        view: patch.view === undefined ? prev.view : (patch.view ?? undefined),
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

  /**
   * The field's text while it is being typed. The URL is the filter; this is
   * the draft on the way to it, so a keystroke is not a navigation and not a
   * read. It re-seeds whenever `q` changes from outside the field — "Clear
   * the search", a back button — the same seeded-state shape
   * the workflow pages use for a loaded name.
   */
  const [searchDraft, setSearchDraft] = React.useState(q ?? "");
  const [seededSearch, setSeededSearch] = React.useState<string | null>(q);
  if (q !== seededSearch) {
    setSeededSearch(q);
    setSearchDraft(q ?? "");
  }
  const searchField =
    React.useRef<HTMLElementTagNameMap["s-search-field"]>(null);

  const {
    data,
    query: ordersQuery,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ordersQueryKey(shop, q, view, team, after),
    subscribe: (stub, subscriberId) =>
      stub
        .subscribeOrders({
          limit: ORDERS_PAGE_SIZE,
          cursor: after,
          q,
          view,
          team,
          subscriberId,
        })
        .then(decodeOrdersIndexData),
    initialData: initialOrders,
  });

  /**
   * Enter and blur, not a debounce: every other control in this row navigates
   * on the merchant's own action (a view button click, a select change), and
   * a timer that navigated mid-number would page the table under the typing.
   * A no-op submit is dropped so re-blurring an unchanged field costs nothing.
   * An emptied field submits at once (see the field's `onInput`).
   */
  const submitSearch = (draft: string = searchDraft) => {
    const next = Option.getOrNull(decodeOrderSearch(draft));
    if (next === q) return;
    setFilters({ q: next });
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
      .then(decodeSyncResult)
      .then(() => invalidate())
      .catch((error: unknown) => {
        shopify.toast.show(
          error instanceof Error ? error.message : "Couldn't start the import.",
          { isError: true },
        );
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  const syncInFlight = data?.syncState.inFlight ?? false;
  const orders = data?.page.orders ?? [];
  const filtered = q !== null || view !== null || team !== null;
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
   * runs, collapsed and capped like `tagBadges`. `"Unknown team"` should
   * never render — the repository only emits ids that were among the teams it
   * read — but the lookup is nullable and a blank badge is worse than a
   * named gap.
   */
  const waitingOnBadges = (ids: readonly Domain.TeamId[]) => (
    <s-stack direction="inline" gap="small-300">
      {ids.slice(0, TAG_BADGE_LIMIT).map((id) => (
        <s-badge key={id}>{teamName.get(id) ?? "Deleted team"}</s-badge>
      ))}
      {ids.length > TAG_BADGE_LIMIT && (
        <s-text color="subdued">{`+${String(ids.length - TAG_BADGE_LIMIT)}`}</s-text>
      )}
    </s-stack>
  );

  /**
   * Rendered twice: once into the page's `secondary-actions` slot, and once
   * inside the empty state where it is the only thing to do and so primary.
   * In the title bar it is secondary: importing is a first-day step and a
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
      Import open orders
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
              {`Import open orders to pull in what is on the bench, or wait for the next order. The import takes the open, unfulfilled orders from the last ${String(ORDER_IMPORT_WINDOW_DAYS)} days; after that, order webhooks keep them current.`}
            </s-paragraph>
          </s-stack>
          {syncButton(false)}
        </s-grid>
      </s-grid>
    </s-box>
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
     * An empty view or filtered list: centred like `emptyState`, since a
     * lone line in the card's corner read as leftover text rather than the
     * answer. The search names what it did not find, because the number the
     * merchant typed is the whole question they asked; the view copy
     * answers a different one and would read as a non sequitur under a
     * search that missed. No "Clear the search": the field's own clear
     * control does that.
     */
    if (orders.length === 0 && filtered)
      return (
        <s-box padding="base">
          <s-grid justifyItems="center" paddingBlock="large-400">
            <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
              {q === null ? (
                <s-paragraph color="subdued">
                  {emptyText(view, team)}
                </s-paragraph>
              ) : (
                <s-heading>
                  {`No order matches ${Domain.normaliseOrderSearch(q)}`}
                </s-heading>
              )}
            </s-grid>
          </s-grid>
        </s-box>
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
        {/* Status and Issues are two columns because each has its own view,
            and a column is headed by its view's word. "Status" is right for
            a column, which holds exactly one value per row; it was wrong for
            a row of buttons that was not one axis. */}
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
                <LocalDateTime value={row.order.processedAt} />
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
              {/* No placeholder for an empty cell. On an order in
                  production, empty means every current task is unassigned
                  (a team with no members still shows, so the merchant knows
                  which team needs a member), and the Needs a team badge
                  beside it already says so. A dash would flatten that into
                  "nothing to see". A fulfilled or cancelled order is always
                  empty (`Domain.OrderRow.waitingOn`). */}
              <s-table-cell>{waitingOnBadges(row.waitingOn)}</s-table-cell>
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
   * One button of the view row. The rule for both view rows, this one and
   * the member Workflows list's: a view is an `s-press-button`, because
   * `pressed` is a real state that reaches the native button in its shadow
   * root as `aria-pressed`, where `aria-pressed` on an `s-button` host never
   * did, and `variant="primary"` on an `s-button` means the page's main
   * action, which a view is not. No view is red: `s-press-button` takes only
   * `tone="neutral"`, and the alarm colour belongs with the remedy, on the
   * Issues badges and the Issues banner.
   *
   * The element flips its own `pressed` on every click, and React re-sets a
   * controlled property only when its value changes between renders.
   * Pressing the pressed view navigates to the same search, nothing
   * re-renders, and the element would stay unpressed; so `onClick` first
   * puts `pressed` back to what React rendered.
   *
   * A counted view always renders, at zero if need be, so nothing on the
   * row appears or disappears with the data. An uncounted one (Fulfilled,
   * All) is just its name: a blank where a number belongs reads as a number
   * that failed to load.
   *
   * Every view reads unpressed while a search is on, because the read
   * ignores the view (`Domain.ListOrdersInput.q`) and a pressed button that
   * is ignored is a lie the merchant would have to learn. Pressing one
   * clears the search and shows that view.
   */
  const viewButton = ({ value, count }: (typeof VIEWS)[number]) => {
    const label = Domain.ORDERS_INDEX_VIEW_LABEL[value ?? "open"];
    const n = count === null ? null : (data?.page.counts[count] ?? null);
    const pressed = q === null && view === value;
    const text = n === null ? label : `${label} · ${formatNumber(n)}`;
    return (
      <s-press-button
        key={value ?? "open"}
        pressed={pressed}
        onClick={(event) => {
          event.currentTarget.pressed = pressed;
          setFilters({ view: value, q: null });
        }}
      >
        {text}
      </s-press-button>
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
      {/* The Issues banner. It stands while any open order has an issue:
          every issue is something the merchant clears in Baton, so it goes
          away. Not dismissible, because dismissing would hide a state that
          is still true and it would return on the next load. Hidden while
          the Issues view is pressed, because the table below is that list.
          Toned {@link Domain.ORDER_ISSUE_TONE}, matching the Issues
          badges. The count is
          `Domain.OrderCounts`, which honours the team select, so it is the
          Issues button's number. On the orders index only, not the home
          page, so one screen owns it. After the quota banners, which say
          the app itself is stopped. */}
      {data !== undefined &&
        data.page.counts.issues > 0 &&
        !(q === null && view === "issues") && (
          <s-banner
            heading={issuesHeading(data.page.counts.issues)}
            tone={Domain.ORDER_ISSUE_TONE}
          >
            <s-button
              slot="secondary-actions"
              onClick={() => {
                setFilters({ view: "issues", q: null });
              }}
            >
              Show issues
            </s-button>
          </s-banner>
        )}
      {/* Unconditional, empty list included: the resource-index template keeps
          the title-bar action and lets the empty state carry a second copy,
          so "import is top right" holds on every visit.
          https://shopify.dev/docs/api/app-home/latest/patterns/templates/resource-index */}
      {syncButton(true)}

      <s-section padding="none" accessibilityLabel="Orders">
        {/* Rendered only with something in it: an empty box would still add
            its padding above the filter box's own. */}
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
        {/* One filter box, gated on there being something to filter: see
            `neverStored`. Top to bottom: the search, the view row, the team
            filter. The view row has no label, so it starts at the box's
            edge, and "Team" sits under that edge. */}
        {!neverStored && (
          <s-box padding="base">
            <s-stack gap="base">
              {/* Above the view row rather than beside it: a search is the
                  merchant arriving with an order in hand, and it ignores the
                  view and the team (`Domain.ListOrdersInput.q`). The
                  placeholder is its own label. Width capped like the team
                  select, which fills whatever it is given. The field shows
                  the search that is on, so no chip repeats it; clearing the
                  field clears the search and the view it left comes back. */}
              <s-grid
                gridTemplateColumns="minmax(0, 16rem)"
                justifyContent="start"
              >
                {/* An emptied field is the search cleared, so it submits
                    without waiting for Enter or blur: no half-typed number is
                    in it to page the table under, and the field's own clear
                    control leaves focus where it was. */}
                <s-search-field
                  ref={searchField}
                  label="Order number"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Order number"
                  value={searchDraft}
                  onInput={(event) => {
                    const draft = event.currentTarget.value;
                    setSearchDraft(draft);
                    if (draft === "") submitSearch(draft);
                  }}
                  onBlur={() => {
                    submitSearch();
                  }}
                />
              </s-grid>
              <s-stack
                direction="inline"
                gap="small-300"
                justifyContent="space-between"
              >
                <s-stack direction="inline" gap="small-300">
                  {VIEWS.map(viewButton)}
                </s-stack>
                {viewButton(ISSUES_VIEW)}
              </s-stack>
              <s-grid
                gridTemplateColumns="auto 1fr"
                gap="base"
                alignItems="center"
              >
                <s-text color="subdued">Team</s-text>
                {/* A select rather than view buttons: the team list is
                    unbounded, and a select whose value is the team already
                    reads as the active chip, so this is one control instead
                    of a control plus a chip. The primary way in is the
                    drill-in from the team page, which sets `?team=`. It keeps
                    the orders the Waiting on column names the team for, and
                    it narrows every view and count but not a search.

                    Always shown. Under Fulfilled it can only match nothing,
                    because a closed order waits on no team
                    (`Domain.OrderRow.waitingOn`); that reads as an empty list
                    with its text, which is better than a control that
                    disappears when a view is pressed. Under All it narrows
                    to the open orders waiting on that team.

                    Options are names only. A count per option would be
                    a new per-team aggregate on every refresh of a
                    subscribed page, which is the cost
                    `Domain.OrderCounts` is bounded to avoid. The grid
                    caps the width: `s-select` fills whatever inline size
                    it is given. */}
                <s-grid
                  gridTemplateColumns="minmax(0, 16rem)"
                  justifyContent="start"
                >
                  <s-select
                    label="Team"
                    labelAccessibilityVisibility="exclusive"
                    value={team ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setFilters({
                        team:
                          data?.teams.find(({ id }) => id === value)?.id ??
                          null,
                      });
                    }}
                  >
                    <s-option value="">Any team</s-option>
                    {data?.teams.map(({ id, name }) => (
                      <s-option key={id} value={id}>
                        {name}
                      </s-option>
                    ))}
                    {/* A link that set `?team=` outlives the team it
                        named. Without this the control would read "Any
                        team" while the list stayed filtered to
                        nothing. */}
                    {team !== null && !teamName.has(team) && (
                      <s-option disabled value={team}>
                        Deleted team
                      </s-option>
                    )}
                  </s-select>
                </s-grid>
              </s-grid>
            </s-stack>
          </s-box>
        )}
        {renderOrders()}
      </s-section>
    </s-page>
  );
}

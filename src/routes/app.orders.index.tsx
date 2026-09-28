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
/** Caps the Waiting on cell, so a shop with many teams cannot widen the table without bound. */
const TAG_BADGE_LIMIT = 3;

/**
 * Keyed by every filter and the page as well as the shop: each combination is
 * a different read, and the order page's invalidation of `["orders", shop]` is
 * a prefix match so it still reaches every one of them.
 */
const ordersQueryKey = (
  shop: string,
  q: Domain.OrderSearch | null,
  status: Domain.OrdersStatus | null,
  need: Domain.OrderNeed | null,
  team: Domain.TeamId | null,
  after: string | null,
) => ["orders", shop, q, status, need, team, after] as const;

/** One button of the Status or Needs row: its value, label, and the `Domain.OrderCounts` key it shows, if counted. */
interface FilterButton<A> {
  readonly value: A | null;
  readonly label: string;
  readonly count: keyof Domain.OrderCounts | null;
}

/**
 * The Status row: the production ladder (`Domain.ProductionState`), in the
 * order an order moves, with the two that are not positions at either end —
 * Open (to make, making and made) is the default view and All is the escape
 * hatch to the closed ones (`Domain.OrdersStatus`). Problems are
 * {@link NEEDS}. `cancelled` is deliberately absent: it is rare, shows as a
 * badge, and is not a position an order moves through. Only the open
 * positions carry a count (`Domain.OrderCounts`).
 */
const STATUSES: readonly FilterButton<Domain.OrdersStatus>[] = [
  { value: null, label: "Open", count: null },
  { value: "to_make", label: "To make", count: "to_make" },
  { value: "making", label: "Making", count: "making" },
  { value: "made", label: "Made", count: "made" },
  { value: "fulfilled", label: "Fulfilled", count: null },
  { value: "all", label: "All", count: null },
];

/**
 * The Needs row: the merchant's to-do list, one button per
 * `Domain.OrderNeed` in its order. The labels are the row badges' labels
 * ({@link NEED_LABEL}), so the button and the row say the same words.
 */
const NEED_LABEL: Record<Domain.OrderNeed, string> = {
  no_workflow: "No workflow",
  choose_workflow: "Choose a workflow",
  team: "Needs a team",
  blocked: "Blocked",
};

const NEEDS: readonly FilterButton<Domain.OrderNeed>[] = [
  { value: null, label: "Anything", count: null },
  ...Domain.OrderNeed.literals.map((need) => ({
    value: need,
    label: NEED_LABEL[need],
    count: need,
  })),
];

/**
 * The Needs row and the Team select are hidden under Fulfilled (and
 * Cancelled, which has no button): a need is only ever on an open order
 * (`Domain.OrderNeed`) and only an open order waits on a team
 * (`Domain.OrderRow.waitingOn`), so neither can match there and every need
 * count would be zero. Pressing Fulfilled also drops the need and the team, or
 * the list would be filtered to nothing by a control that is no longer on
 * screen. The order-number search is outside these rows and stays.
 */
const openOnlyFiltersShown = (value: Domain.OrdersStatus | null) =>
  value !== "fulfilled" && value !== "cancelled";

/**
 * `Schema.toType`, not the schema itself. A Durable Object RPC result has
 * already been through the repository's decoder, so what arrives is the
 * **decoded** shape — `fullyPaid` a boolean, `properties` an array. Decoding it again
 * against `Domain.OrdersView` would demand the *encoded* row shape (`0`/`1`,
 * a JSON string) and fail on the first order. `toType` derives a validator over
 * the decoded side, so the wire value is checked without re-running transforms
 * that already ran. Same reasoning as the better-auth boundary in `Auth.ts`.
 */
const decodeOrdersView = Schema.decodeUnknownPromise(
  Schema.toType(Domain.OrdersView),
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
 * The ladder badge, from `Domain.productionState` over the row, one for every
 * order. Whether To make is a problem is `needBadges`' to say. Made is
 * derived, never stored: it becomes Fulfilled on its own once Shopify
 * reports the fulfilment.
 */
const positionBadge = (row: Domain.OrderRow) =>
  Match.value(Domain.productionState(row)).pipe(
    Match.withReturnType<React.ReactNode>(),
    Match.when("to_make", () => <s-badge tone="neutral">To make</s-badge>),
    Match.when("making", () => <s-badge tone="info">Making</s-badge>),
    Match.when("made", () => <s-badge tone="success">Made</s-badge>),
    Match.when("fulfilled", () => <s-badge tone="neutral">Fulfilled</s-badge>),
    Match.when("cancelled", () => <s-badge tone="critical">Cancelled</s-badge>),
    Match.exhaustive,
  );

/**
 * One badge per `Domain.orderNeeds` element, in that order, which is the
 * order of the Needs row. Tone follows whether a person is stopped: `team`
 * and `blocked` are critical, the rest a warning.
 */
const needBadges = (row: Domain.OrderRow) =>
  Domain.orderNeeds(row).map((need) => (
    <s-badge
      key={need}
      tone={Match.value(need).pipe(
        Match.when("team", () => "critical" as const),
        Match.when("blocked", () => "critical" as const),
        Match.orElse(() => "warning" as const),
      )}
    >
      {NEED_LABEL[need]}
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
  view: Domain.OrdersView | undefined,
  isError: boolean,
) => {
  if (isError) return "Could not read import status.";
  if (view === undefined) return "Loading…";
  return view.syncState.inFlight
    ? "Importing… this page updates as orders arrive."
    : null;
};

/**
 * Under a need, the empty text names the problem, which is the question the
 * merchant pressed the button to ask; otherwise the status says what is
 * missing.
 */
const emptyText = (
  status: Domain.OrdersStatus | null,
  need: Domain.OrderNeed | null,
) =>
  Match.value(need).pipe(
    Match.when("no_workflow", () => "No open orders need a workflow."),
    Match.when(
      "choose_workflow",
      () => "No open orders need a workflow chosen.",
    ),
    Match.when("team", () => "No open orders need a team."),
    Match.when("blocked", () => "No open orders are blocked."),
    Match.when(null, () =>
      Match.value(status).pipe(
        Match.when("all", () => "No orders stored."),
        Match.when("to_make", () => "No open orders are waiting to be made."),
        Match.when("making", () => "Nothing is being made."),
        Match.when(
          "made",
          () => "No orders are made and waiting to be fulfilled.",
        ),
        Match.when("fulfilled", () => "No orders have been fulfilled yet."),
        Match.when("cancelled", () => "No cancelled orders."),
        Match.when(null, () => "No orders match these filters."),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

/**
 * The loader half of the subscribed page: the current filter and page, read
 * Worker-side so it paints during SSR. The socket's `subscribeOrders` takes
 * over on identify (see `useSubscribedQuery`). The page is in the URL like the
 * filters, so the SSR paint is the page the merchant left.
 */
const OrdersLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.OrderSearch),
  status: Schema.NullOr(Domain.OrdersStatus),
  need: Schema.NullOr(Domain.OrderNeed),
  team: Schema.NullOr(Domain.TeamId),
  after: Schema.NullOr(Domain.OrdersCursor),
});

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(OrdersLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(
    ({
      data: { q, status, need, team, after },
      context: { runEffect, session },
    }) =>
      runEffect(
        Effect.gen(function* () {
          const client = yield* ShopAgentClient;
          return {
            view: yield* client.listOrders(session.shop, {
              limit: ORDERS_PAGE_SIZE,
              cursor: after,
              q,
              status,
              need,
              team,
            }),
            usage: yield* client.getUsage(session.shop),
          } satisfies Domain.OrdersIndexLoaderData;
        }),
      ),
  );

export const Route = createFileRoute("/app/orders/")({
  loaderDeps: ({ search }) => ({
    q: search.q ?? null,
    status: search.status ?? null,
    need: search.need ?? null,
    team: search.team ?? null,
    after: search.after ?? null,
  }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

/**
 * The orders index: one table of what the Durable Object has stored, with
 * production state per order, and the window-sync button as a header action.
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
    status = null,
    need = null,
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
  const { view: initialView, usage } = Route.useLoaderData();
  const [syncing, setSyncing] = React.useState(false);

  /**
   * A filter change is a new list, so the page resets to one. `replace: true`
   * for the member's workflows list's reason (`selectTab` in `shop.$shop.workflows.index.tsx`): the
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
    readonly q?: Domain.OrderSearch | null;
    readonly status?: Domain.OrdersStatus | null;
    readonly need?: Domain.OrderNeed | null;
    readonly team?: Domain.TeamId | null;
  }) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        q: patch.q === undefined ? prev.q : (patch.q ?? undefined),
        status:
          patch.status === undefined
            ? prev.status
            : (patch.status ?? undefined),
        need: patch.need === undefined ? prev.need : (patch.need ?? undefined),
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
    data: view,
    query: ordersQuery,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ordersQueryKey(shop, q, status, need, team, after),
    subscribe: (stub, subscriberId) =>
      stub
        .subscribeOrders({
          limit: ORDERS_PAGE_SIZE,
          cursor: after,
          q,
          status,
          need,
          team,
          subscriberId,
        })
        .then(decodeOrdersView),
    initialData: initialView,
  });

  /**
   * Enter and blur, not a debounce: every other control in this row navigates
   * on the merchant's own action (a press-button click, a select change), and
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
          error instanceof Error
            ? error.message
            : "Could not start the import.",
          { isError: true },
        );
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  const syncInFlight = view?.syncState.inFlight ?? false;
  const orders = view?.page.orders ?? [];
  const filtered =
    q !== null || status !== null || need !== null || team !== null;
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
   * Who is holding the order: the teams with a current task on one of its open
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
              : "Could not load orders."}
          </s-banner>
        </s-box>
      );
    /**
     * A filtered list with nothing in it: centred like `emptyState`, since a
     * lone line in the card's corner read as leftover text rather than the
     * answer. The search names what it did not find, because the number the
     * merchant typed is the whole question they asked; the filter copy
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
                  {emptyText(status, need)}
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
        hasNextPage={view.page.nextCursor !== null}
        onPreviousPage={previousPage}
        onNextPage={() => {
          const next = view.page.nextCursor;
          if (next !== null) nextPage(next);
        }}
      >
        <s-table-header-row>
          <s-table-header listSlot="primary">Order</s-table-header>
          <s-table-header listSlot="secondary">Placed</s-table-header>
          <s-table-header listSlot="inline">Payment</s-table-header>
          <s-table-header listSlot="inline">Production</s-table-header>
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
              <s-table-cell>
                <s-stack direction="inline" gap="small-300">
                  {positionBadge(row)}
                  {needBadges(row)}
                </s-stack>
              </s-table-cell>
              {/* No placeholder for an empty cell. On an order in
                  production, empty means every ready step is unassigned or
                  on a deleted team (an unstaffed team still shows, so the
                  merchant knows whom to staff), and the critical badge
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
                  {Domain.productionState(row) === "made"
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
   * One button of the Status or Needs row. `s-press-button` for both rows:
   * the pressed, hover and focus states come from Polaris, and `pressed`
   * says "this one is on" where a disabled primary button read to a screen
   * reader as unavailable. No red on the bar — `s-press-button` only takes
   * `tone="neutral"`, and the alarm colour belongs on the row badges, where
   * the remedy is.
   *
   * A counted button always renders, at zero if need be, so nothing on the
   * bar appears or disappears with the data. An uncounted one (Open,
   * Fulfilled, All, Anything) is just its name: a blank where a number belongs
   * reads as a number that failed to load.
   */
  const pressButton = <A extends string>(
    { value, label, count }: FilterButton<A>,
    selected: A | null,
    select: (value: A | null) => void,
  ) => {
    const n = count === null ? null : (view?.page.counts[count] ?? null);
    return (
      <s-press-button
        key={value ?? "any"}
        pressed={selected === value}
        onClick={() => {
          select(value);
        }}
      >
        {n === null ? label : `${label} · ${formatNumber(n)}`}
      </s-press-button>
    );
  };

  const syncError = view?.syncState.lastError ?? null;
  const syncStatus = syncStatusText(view, ordersQuery.isError);

  return (
    <s-page heading="Orders" inlineSize="large">
      <SocketBanner />
      {/* Above the sync button on purpose: the merchant who notices an order
          missing here is the one these two banners are for. */}
      <QuotaBanners usage={usage} />
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
        {/* One filter bar, gated on there being something to filter: see
            `neverStored`. The rows share a grid so "Status", "Needs" and
            "Team" line up in a label column and their controls start at the
            same inline offset. */}
        {!neverStored && (
          <s-box padding="base">
            <s-stack gap="base">
              {/* Above the facet grid rather than inside it: a search is the
                  merchant arriving with an order in hand, not a facet crossed
                  with the others, and the placeholder is its own label. Width
                  capped like the team select, which fills whatever it is
                  given. The field shows the search that is on, so no chip
                  repeats it; clearing the field clears the search. */}
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
              <s-grid
                gridTemplateColumns="auto 1fr"
                gap="base"
                alignItems="center"
              >
                <s-text color="subdued">Status</s-text>
                <s-stack direction="inline" gap="small-300">
                  {STATUSES.map((button) =>
                    pressButton(button, status, (value) => {
                      setFilters({
                        status: value,
                        ...(openOnlyFiltersShown(value)
                          ? {}
                          : { need: null, team: null }),
                      });
                    }),
                  )}
                </s-stack>
                {openOnlyFiltersShown(status) && (
                  <>
                    <s-text color="subdued">Needs</s-text>
                    <s-stack direction="inline" gap="small-300">
                      {NEEDS.map((button) =>
                        pressButton(button, need, (value) => {
                          setFilters({ need: value });
                        }),
                      )}
                    </s-stack>
                    <s-text color="subdued">Team</s-text>
                    {/* A select rather than press-buttons: the team list is
                        unbounded, and a select whose value is the team
                        already reads as the active chip, so this is one
                        control instead of a control plus a chip. The primary
                        way in is the drill-in from team detail, which sets
                        `?team=`. It keeps the orders the Waiting on column
                        names the team for.

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
                  </>
                )}
              </s-grid>
            </s-stack>
          </s-box>
        )}
        {renderOrders()}
      </s-section>
    </s-page>
  );
}

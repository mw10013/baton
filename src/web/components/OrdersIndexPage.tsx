import { useAtomSet } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import { isFixtureOrder } from "../../contract/fixture.ts";
import { ORDER_SYNC_WINDOW_DAYS } from "../../contract/orders.ts";
import type { ShopUsage } from "../../domain/billing.ts";
import { formatNumber } from "../../domain/platform.ts";
import {
  type ListSearch,
  ORDER_ISSUE_LABEL,
  ORDER_ISSUE_TONE,
  ORDER_POSITION_LABEL,
  type OrderRow,
  type OrdersIndexData,
  ORDERS_SHOW_LABEL,
  type OrdersShow,
  orderIssues,
  orderPosition,
  searchTerm,
  searchTermText,
  type TeamId,
} from "../../domain/shop-work.ts";
import { toast } from "../client/app-bridge.ts";
import {
  merchantOrdersAtom,
  merchantSyncStatusAtom,
  merchantUsageAtom,
  seedUsage,
  ORDERS_STRIP,
  ordersIndexInput,
  seedOrders,
  syncOpenOrdersAtom,
} from "../client/shop-actor-client.ts";
import { ANY_OPTION_VALUE } from "./form.ts";
import { useLiveRead } from "./live-read.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import { QuotaBanners } from "./QuotaBanners.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { adminOrderUrl, useResourceLinkTarget } from "./order-links.ts";
import { CEILING, toastSyncFailure } from "./orders-sync.ts";
import { usePressWaiting } from "./press-waiting.ts";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { FilterRow } from "./screen/FilterRow.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";
import { Inline } from "./screen/Inline.tsx";
import { ListSearchField } from "./screen/ListSearchField.tsx";
import { SearchLine } from "./screen/SearchLine.tsx";
import { Strip } from "./screen/Strip.tsx";

/**
 * The Show select's values, in its order: the strip's five, then Open, Unpaid, the closed
 * positions and All; `null` is Making, the default. Making's option value is `"making"`, not
 * `""`: an `s-option` with an empty value takes its label as the value.
 */
const SHOW: readonly (OrdersShow | null)[] = [
  "no_workflow",
  "not_started",
  null,
  "made",
  "issues",
  "open",
  "unpaid",
  "fulfilled",
  "cancelled",
  "all",
];

/**
 * The Status cell: the ladder badge, from `orderPosition` over the row, one for every order. The
 * Issues cell is empty for a No workflow order on purpose (`OrderIssue` says why), and this badge
 * is the place the merchant sees it. Made is derived, never stored: it becomes Fulfilled on its
 * own once Shopify reports the fulfilment.
 */
function PositionBadge({ row }: { readonly row: OrderRow }) {
  const state = orderPosition(row);
  return (
    <s-badge
      tone={Match.value(state).pipe(
        Match.when("making", () => "info" as const),
        Match.when("made", () => "success" as const),
        Match.when("cancelled", () => "critical" as const),
        Match.orElse(() => "neutral" as const),
      )}
    >
      {ORDER_POSITION_LABEL[state]}
    </s-badge>
  );
}

/**
 * What an empty list says, one line each. With a team selected the list is narrowed by two
 * filters, so the text says that rather than claiming one value is empty. A search has its own
 * sentence.
 */
const emptyText = (show: OrdersShow | null, team: TeamId | null) =>
  team === null
    ? Match.value(show).pipe(
        Match.when(null, () => "Nothing is being made."),
        Match.when("open", () => "No open orders."),
        Match.when("unpaid", () => "No open orders are waiting on payment."),
        Match.when("no_workflow", () => "Every paid open order has a workflow."),
        Match.when("not_started", () => "No open orders are waiting to start."),
        Match.when("making", () => "Nothing is being made."),
        Match.when("made", () => "No orders are made and waiting to be fulfilled."),
        Match.when("issues", () => "No orders have issues."),
        Match.when("fulfilled", () => "No orders have been fulfilled yet."),
        Match.when("cancelled", () => "No cancelled orders."),
        Match.when("all", () => "No orders yet."),
        Match.exhaustive,
      )
    : "No orders match these filters.";

/** A filter or search change, as {@link OrdersIndexProps}' `onFilter` takes it. */
export interface OrdersFilterPatch {
  readonly q?: ListSearch | null;
  readonly show?: OrdersShow | null;
  readonly team?: TeamId | null;
}

/** {@link OrdersIndexPage}'s props: the loader's page and the route's navigation. */
export interface OrdersIndexProps {
  readonly data: OrdersIndexData;
  /** The shop's usage the loader read, for {@link QuotaBanners}; live from then on. */
  readonly usage: ShopUsage;
  /** The search, the filters and the page cursor in the URL, `null` when absent. */
  readonly q: ListSearch | null;
  readonly show: OrdersShow | null;
  readonly team: TeamId | null;
  readonly after: string | null;
  /** The order page's link, carrying the index's search, filters and page. */
  readonly orderLink: (legacyId: string) => PageLink;
  /** A filter or search change; the page goes back to one. A key left out keeps its value. */
  readonly onFilter: (patch: OrdersFilterPatch) => void;
  readonly onNextPage: (cursor: string) => void;
  readonly onPreviousPage: () => void;
}

/**
 * Sync open orders once hydrated: `MerchantSyncOpenOrders` on the layout's socket. Each answer is
 * a toast: started, a press that did nothing, the ceiling. Before hydration nothing presses.
 */
const useSyncOpenOrders = () => {
  const hydrated = useHydrated();
  const syncing = usePressWaiting(syncOpenOrdersAtom);
  const sync = useAtomSet(syncOpenOrdersAtom, { mode: "promiseExit" });
  const press = () => {
    if (!hydrated) return;
    void sync({ payload: undefined }).then(
      Exit.match({
        onSuccess: (answer) =>
          Match.valueTags(answer, {
            Started: () => toast("Syncing open orders"),
            InFlight: () => toast("A sync is already running"),
            Refused: () => toast(CEILING, { isError: true }),
          }),
        onFailure: (cause) =>
          toastSyncFailure(cause, () => "Couldn't start the sync.", "Couldn't start the sync."),
      }),
    );
  };
  return { syncing, press };
};

/**
 * The orders index: one table of what the shop's actor has stored, with the order's position and
 * issues per order, the strip, Show, the search and Team above it, and Sync open orders as a
 * title-bar action. Everything per item lives on the order page.
 *
 * A live screen, one tree from the server's render through hydration: the loader paints the
 * page, then the merchant socket keeps it current ({@link useLiveRead}); a webhook, a sync, a
 * sweep or any write to an order or its workflows refetches the page shown, and a sync starting
 * or ending refetches its status. A sync's failure is the critical banner in the list's head
 * (`lastError`); a press is a toast.
 *
 * A fixture order is not in Shopify ({@link isFixtureOrder}), so its row has no Shopify link.
 */
export default function OrdersIndexPage(props: OrdersIndexProps) {
  const { q, show, team, after } = props;
  const input = ordersIndexInput({ after, q, show, team });
  const read = useLiveRead({
    atom: merchantOrdersAtom(input),
    key: JSON.stringify([input.cursor, input.q, input.show, input.team]),
    loaded: props.data,
    seed: (registry, data) => {
      seedOrders(registry, { input, data });
    },
  });
  const status = useLiveRead({
    atom: merchantSyncStatusAtom,
    key: "sync-status",
    loaded: props.data.syncState,
    seed: () => {},
  });
  const usage = useLiveRead({
    atom: merchantUsageAtom,
    key: "usage",
    loaded: props.usage,
    seed: seedUsage,
  });
  const sync = useSyncOpenOrders();
  const resourceLinkTarget = useResourceLinkTarget();
  const { page, teams } = read.value;
  const orders = page.orders;

  const filtered = q !== null || show !== null || team !== null;
  /**
   * No open order stored and nothing filtered: the card is the empty state alone. Read off
   * `openOrders`, not the list: the default list is Making, and an empty one is not an empty
   * shop.
   */
  const neverStored = page.openOrders === 0 && !filtered;
  const teamNames = new Map(teams.map(({ id, name }) => [id, name]));
  const term = q === null ? null : searchTermText(searchTerm(q));
  const clearSearch = () => {
    props.onFilter({ q: null });
  };

  /**
   * Rendered twice: once into the page's `secondary-actions` slot, and once inside the empty
   * state where it is the only thing to do and so primary. In the title bar it is secondary:
   * syncing is a first-day step and a repair, not the page's routine action. App Bridge hoists
   * the slotted copy out of the iframe, so the in-card twin is not a duplicate in the frame.
   */
  const syncButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "secondary-actions" as const } : { variant: "primary" as const })}
      loading={sync.syncing}
      disabled={sync.syncing || status.value.inFlight}
      onClick={sync.press}
    >
      Sync open orders
    </s-button>
  );

  /**
   * The filter slot: Show, the search, then Team, labels hidden on screen. The selects are
   * disabled under a search, because the read ignores them, and keep their values, so Clear
   * search restores the list they describe. Team options are names only; a bookmarked `?team=`
   * that outlived its team reads "Deleted team" rather than "Any team" over an empty list.
   */
  const filters = (
    <FilterRow
      main={
        <s-select
          label="Show"
          labelAccessibilityVisibility="exclusive"
          value={show ?? "making"}
          disabled={q !== null}
          onChange={(event) => {
            const value = event.currentTarget.value;
            props.onFilter({ show: SHOW.find((each) => each === value) ?? null });
          }}
        >
          {SHOW.map((each) => (
            <s-option key={each ?? "making"} value={each ?? "making"}>
              {ORDERS_SHOW_LABEL[each ?? "making"]}
            </s-option>
          ))}
        </s-select>
      }
      search={
        <ListSearchField
          value={q}
          placeholder="Search by order number or item"
          onSubmit={(next) => {
            props.onFilter({ q: next });
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
            props.onFilter({ team: teams.find(({ id }) => id === value)?.id ?? null });
          }}
        >
          <s-option value={ANY_OPTION_VALUE}>Any team</s-option>
          {teams.map(({ id, name }) => (
            <s-option key={id} value={id}>
              {name}
            </s-option>
          ))}
          {team !== null && !teamNames.has(team) && (
            <s-option disabled value={team}>
              Deleted team
            </s-option>
          )}
        </s-select>
      }
    />
  );

  /**
   * Each cell a press over the Show filter: choosing it sets Show to its value, so at most one
   * cell is chosen, and none under Open, Unpaid, Fulfilled, Cancelled or All, which have no cell.
   */
  const strip = (
    <Strip
      cells={ORDERS_STRIP.map((key) => {
        const value = key === "making" ? null : key;
        return {
          key,
          label: ORDERS_SHOW_LABEL[key],
          count: page.counts[key],
          chosen: show === value,
          onSelect: () => {
            props.onFilter({ show: value });
          },
        };
      })}
    />
  );

  const searchLine =
    term === null || page.matches === null || page.matches === 0 ? null : (
      <SearchLine
        count={page.matches}
        noun={["order", "orders"]}
        term={term}
        onClear={clearSearch}
      />
    );

  const renderOrders = () => {
    if (orders.length === 0 && neverStored)
      return (
        <EmptyLine heading="No open orders" action={syncButton(false)}>
          {`Press Sync open orders to bring in your open orders from the last ${String(ORDER_SYNC_WINDOW_DAYS)} days, or wait for the next order. After that, Baton adds each new order as it is placed.`}
        </EmptyLine>
      );
    if (orders.length === 0)
      return term === null ? (
        <EmptyLine>{emptyText(show, team)}</EmptyLine>
      ) : (
        <EmptyLine
          action={
            <s-button variant="secondary" onClick={clearSearch}>
              Clear search
            </s-button>
          }
        >{`No order matches ${term}`}</EmptyLine>
      );
    const nextCursor = page.nextCursor;
    return (
      <s-table
        paginate={after !== null || nextCursor !== null}
        loading={read.waiting}
        hasPreviousPage={after !== null}
        hasNextPage={nextCursor !== null}
        onPreviousPage={props.onPreviousPage}
        onNextPage={() => {
          if (nextCursor !== null) props.onNextPage(nextCursor);
        }}
      >
        {/* Status and Issues are two columns because they are two facts: an order has one
            position and any number of issues. */}
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
                <s-link {...props.orderLink(row.order.legacyId)}>{row.order.name}</s-link>
              </s-table-cell>
              <s-table-cell>
                <LocalDateTime value={row.order.processedAt} format="date" />
              </s-table-cell>
              <s-table-cell>
                <s-badge tone={row.order.fullyPaid ? "success" : "warning"}>
                  {row.order.fullyPaid ? "Paid" : "Unpaid"}
                </s-badge>
              </s-table-cell>
              <s-table-cell>
                <PositionBadge row={row} />
              </s-table-cell>
              {/* No placeholder for an empty cell: emptiness is the point, and a merchant
                  scanning down the column sees the badges at once. */}
              <s-table-cell>
                <Inline>
                  {orderIssues(row).map((issue) => (
                    <s-badge key={issue} tone={ORDER_ISSUE_TONE}>
                      {ORDER_ISSUE_LABEL[issue]}
                    </s-badge>
                  ))}
                </Inline>
              </s-table-cell>
              <s-table-cell>{formatNumber(row.itemUnits)}</s-table-cell>
              {/* An icon, not "View in Shopify" on every row: the header already says where it
                  goes. The label carries the link copy for a screen reader. */}
              <s-table-cell>
                {!isFixtureOrder(row.order.legacyId) && (
                  <s-button
                    icon="external"
                    variant="tertiary"
                    href={adminOrderUrl(row.order)}
                    target={resourceLinkTarget}
                    accessibilityLabel={`Open ${row.order.name} in Shopify`}
                  />
                )}
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  const syncError = status.value.lastError;
  return (
    <s-page heading="Orders" inlineSize="large">
      {/* Unconditional, empty list included: the resource-index template keeps the title-bar
          action and lets the empty state carry a second copy. */}
      {syncButton(true)}
      {/* The head, in order: the quota banner, the sync's error, a failed read, then the strip or under a search
          the line that replaces it, then the filter row; the strip and the filters only when
          there is something to filter. */}
      <IndexSection
        label="Orders"
        head={
          <>
            <QuotaBanners usage={usage.value} />
            {syncError !== null && <s-banner tone="critical">{syncError}</s-banner>}
            {read.failed && <s-banner tone="critical">Couldn't load orders.</s-banner>}
            {!neverStored && (q === null ? strip : searchLine)}
            {!neverStored && filters}
          </>
        }
      >
        {renderOrders()}
      </IndexSection>
    </s-page>
  );
}

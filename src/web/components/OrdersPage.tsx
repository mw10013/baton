import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { type ReactNode, useContext, useMemo } from "react";
import { isFixtureOrder } from "../../contract/fixture.ts";
import { ORDER_SYNC_WINDOW_DAYS } from "../../contract/orders.ts";
import { OrdersSyncFailure } from "../../contract/shopify.ts";
import type { ShopOrder } from "../../domain/orders.ts";
import { formatNumber, ShopLimits } from "../../domain/platform.ts";
import {
  type ListOrdersInput,
  ORDER_POSITION_LABEL,
  type OrderRow,
  type OrdersIndexData,
  type OrdersPage as OrdersPageData,
  orderPosition,
} from "../../domain/shop-work.ts";
import { toast } from "../client/app-bridge.ts";
import {
  merchantOrdersAtom,
  merchantSyncStatusAtom,
  seedOrders,
  syncOpenOrdersAtom,
  syncOrderAtom,
} from "../client/shop-actor-client.ts";
import { thrownCopy } from "./form.ts";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";

/**
 * The Next page link's `href` and click for the page starting after `cursor`; the route builds
 * them, because the URL and the router are its.
 */
export type OrdersPageLink = (cursor: string) => {
  readonly href: string;
  readonly onClick: (event: Event) => void;
};

/**
 * The order ceiling's sentence, as the quota banner words it. Sync open orders answers `Refused`
 * at the ceiling, and until the billing slice brings that banner, a toast is the only place the
 * merchant learns why the press did nothing.
 */
const CEILING = `New orders stopped syncing at ${formatNumber(ShopLimits.maxOpenOrders)} open orders. Fulfill or cancel orders in Shopify, then Sync open orders.`;

/** Why a sync press could not act, as the toast says it; `what` names the press. */
const failureCopy = (reason: OrdersSyncFailure["_tag"], what: string) =>
  Match.value(reason).pipe(
    Match.when(
      "ReauthorizationRequired",
      () => "Couldn't reach Shopify. Reload Baton to reconnect.",
    ),
    Match.when("ShopifyUnavailable", () => "Couldn't reach Shopify. Try again."),
    Match.orElse(() => `Couldn't ${what}: Baton isn't installed on this shop.`),
  );

const isSyncFailure = Schema.is(OrdersSyncFailure);

/**
 * A press that failed, as its error toast: a session failure in `syncFailure`'s words, anything
 * else (a lost socket, a defect) in `thrownCopy`'s.
 */
const toastFailure = (
  cause: Cause.Cause<unknown>,
  syncFailure: (failure: OrdersSyncFailure) => string,
  fallback: string,
) => {
  const error = Cause.squash(cause);
  toast(isSyncFailure(error) ? syncFailure(error) : thrownCopy(error, fallback), {
    isError: true,
  });
};

/** Legacy's `adminOrderUrl`: the order in the Shopify admin, which App Bridge resolves. */
const adminOrderUrl = ({ legacyId }: ShopOrder) => `shopify://admin/orders/${legacyId}`;

/** The Status cell: legacy's position badge, from the row's order and its run counts. */
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

/** What the screen renders, the same before and after hydration. */
interface OrdersView {
  readonly page: OrdersPageData;
  readonly pageLink: OrdersPageLink;
  readonly banners: ReadonlyArray<string>;
  readonly syncInFlight: boolean;
  readonly syncing: boolean;
  readonly onSyncOpenOrders: () => void;
  /** A row's Sync from Shopify button. */
  readonly syncOrderButton: (order: ShopOrder) => ReactNode;
}

/** A row's Sync from Shopify button, as its press and loading state say. */
function SyncOrderButton(props: {
  readonly order: ShopOrder;
  readonly loading: boolean;
  readonly onClick: () => void;
}) {
  return (
    <s-button
      variant="tertiary"
      loading={props.loading}
      accessibilityLabel={`Sync ${props.order.name} from Shopify`}
      onClick={props.onClick}
    >
      Sync from Shopify
    </s-button>
  );
}

/**
 * A row's Sync from Shopify once hydrated: `MerchantSyncOrder` through the row's own
 * {@link syncOrderAtom}, whose state is the button's loading. `Gone` toasts; `Stored` toasts
 * nothing (legacy).
 */
function LiveSyncOrderButton({ order }: { readonly order: ShopOrder }) {
  const atom = syncOrderAtom(order.id);
  const loading = AsyncResult.isWaiting(useAtomValue(atom));
  const sync = useAtomSet(atom, { mode: "promiseExit" });
  const onClick = () => {
    void sync(undefined).then(
      Exit.match({
        onSuccess: (answer) =>
          Match.valueTags(answer, {
            Stored: () => {},
            Gone: () => toast("Shopify no longer has this order"),
          }),
        onFailure: (cause) =>
          toastFailure(
            cause,
            (failure) => failureCopy(failure._tag, "sync the order"),
            "Couldn't sync the order.",
          ),
      }),
    );
  };
  return <SyncOrderButton order={order} loading={loading} onClick={onClick} />;
}

/**
 * The screen itself: Sync open orders in the title bar on every visit (and again, primary, in the
 * empty state, where it is the only thing to do), the banners in the list's head, then the table
 * or the empty line, and Next page under the table while there is one. App Bridge hoists the
 * slotted button into the admin's title bar.
 *
 * There is no Previous: the keyset cursor pages forward only, and page one is the Orders link
 * away. A fixture order ({@link isFixtureOrder}) is not in Shopify, so its row has no Shopify link
 * and no Sync from Shopify.
 */
function OrdersScreen(view: OrdersView) {
  const syncButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "secondary-actions" as const } : { variant: "primary" as const })}
      loading={view.syncing}
      disabled={view.syncing || view.syncInFlight}
      onClick={view.onSyncOpenOrders}
    >
      Sync open orders
    </s-button>
  );
  return (
    <s-page heading="Orders" inlineSize="large">
      {syncButton(true)}
      <IndexSection
        label="Orders"
        foot={
          view.page.nextCursor === null ? undefined : (
            <s-link {...view.pageLink(view.page.nextCursor)}>Next page</s-link>
          )
        }
        head={
          view.banners.length === 0
            ? undefined
            : view.banners.map((banner) => (
                <s-banner key={banner} tone="critical">
                  {banner}
                </s-banner>
              ))
        }
      >
        {view.page.orders.length === 0 ? (
          <EmptyLine heading="No open orders" action={syncButton(false)}>
            {`Press Sync open orders to bring in your open orders from the last ${String(ORDER_SYNC_WINDOW_DAYS)} days, or wait for the next order. After that, Baton adds each new order as it is placed.`}
          </EmptyLine>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Placed</s-table-header>
              <s-table-header listSlot="inline">Payment</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Items
              </s-table-header>
              <s-table-header listSlot="labeled">Shopify</s-table-header>
              <s-table-header listSlot="labeled">Sync</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {view.page.orders.map((detail) => (
                <s-table-row key={detail.order.id}>
                  <s-table-cell>{detail.order.name}</s-table-cell>
                  <s-table-cell>
                    {DateTime.formatIsoDateUtc(DateTime.makeUnsafe(detail.order.processedAt))}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={detail.order.fullyPaid ? "success" : "warning"}>
                      {detail.order.fullyPaid ? "Paid" : "Unpaid"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <PositionBadge row={detail} />
                  </s-table-cell>
                  <s-table-cell>{formatNumber(detail.itemUnits)}</s-table-cell>
                  {isFixtureOrder(detail.order.legacyId) ? (
                    <>
                      <s-table-cell />
                      <s-table-cell />
                    </>
                  ) : (
                    <>
                      <s-table-cell>
                        <s-button
                          icon="external"
                          variant="tertiary"
                          href={adminOrderUrl(detail.order)}
                          target="_blank"
                          accessibilityLabel={`Open ${detail.order.name} in Shopify`}
                        />
                      </s-table-cell>
                      <s-table-cell>{view.syncOrderButton(detail.order)}</s-table-cell>
                    </>
                  )}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </IndexSection>
    </s-page>
  );
}

/**
 * The screen once hydrated: the merchant socket's atoms, the shown page's seeded from the
 * loader's before its first read, so the first live render of each page shows what the loader
 * read and the socket only keeps it current. The `/app` layout's socket holder (`ShopSocket`)
 * named the socket and keeps its notices flowing; a new page is a new cursor, so a new node to
 * seed, on the same socket. A node already there (the page was shown before) is refetched
 * instead. A webhook, a sync or a sweep refetches the page shown, and a sync starting or ending
 * refetches its status.
 */
function LiveOrders(props: OrdersPageProps) {
  const registry = useContext(RegistryContext);
  useMemo(
    () => seedOrders(registry, { input: props.input, data: props.data }),
    // Once per input shown, so not on `data`, which changes with its input: a refresh of the
    // node this render reads would notify it mid-render.
    [registry, props.input],
  );
  const orders = useAtomValue(merchantOrdersAtom(props.input));
  const status = AsyncResult.value(useAtomValue(merchantSyncStatusAtom));
  const syncing = AsyncResult.isWaiting(useAtomValue(syncOpenOrdersAtom));
  const syncOpenOrders = useAtomSet(syncOpenOrdersAtom, { mode: "promiseExit" });

  const onSyncOpenOrders = () => {
    void syncOpenOrders({ payload: undefined }).then(
      Exit.match({
        onSuccess: (answer) =>
          Match.valueTags(answer, {
            Started: () => toast("Syncing open orders"),
            InFlight: () => toast("A sync is already running"),
            Refused: () => toast(CEILING, { isError: true }),
          }),
        onFailure: (cause) =>
          toastFailure(cause, () => "Couldn't start the sync.", "Couldn't start the sync."),
      }),
    );
  };

  const banners = [
    ...(AsyncResult.isFailure(orders) ? ["Couldn't load orders."] : []),
    ...Option.toArray(Option.flatMapNullishOr(status, ({ lastError }) => lastError)),
  ];
  return (
    <OrdersScreen
      page={Option.getOrElse(AsyncResult.value(orders), () => props.data).page}
      pageLink={props.pageLink}
      banners={banners}
      syncInFlight={Option.exists(status, ({ inFlight }) => inFlight)}
      syncing={syncing}
      onSyncOpenOrders={onSyncOpenOrders}
      syncOrderButton={(order) => <LiveSyncOrderButton order={order} />}
    />
  );
}

/** {@link OrdersPage}'s props: `data` is what the loader read for `input`. */
interface OrdersPageProps {
  readonly input: ListOrdersInput;
  readonly data: OrdersIndexData;
  readonly pageLink: OrdersPageLink;
}

/**
 * The merchant's orders: a page of what the shop's actor has stored, newest first, with Sync
 * open orders, per row Sync from Shopify, and Next page. A live screen: the loader paints the
 * page, then the merchant socket keeps it current. Until React has hydrated it renders the
 * loader's page with no socket, so the server markup and the first client render agree.
 *
 * A sync's failure is the critical banner in the list's head (`lastError`); a press is a toast:
 * a sync started, or a press that did nothing or failed. Both presses are merchant procedures on
 * the socket (`MerchantSyncOpenOrders`, `MerchantSyncOrder`).
 */
export default function OrdersPage(props: OrdersPageProps) {
  const hydrated = useHydrated();
  if (hydrated) return <LiveOrders {...props} />;
  return (
    <OrdersScreen
      page={props.data.page}
      pageLink={props.pageLink}
      banners={[]}
      syncInFlight={false}
      syncing={false}
      onSyncOpenOrders={() => {}}
      syncOrderButton={(order) => (
        <SyncOrderButton order={order} loading={false} onClick={() => {}} />
      )}
    />
  );
}

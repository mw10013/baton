import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type {
  OrdersSyncResult,
  ShopOrder,
  OrdersSyncStatus,
  SyncOrderResult,
} from "../../../../src/domain/orders.ts";
import type { OrderRow, OrdersIndexData } from "../../../../src/domain/shop-work.ts";
import type { AppBridge } from "../../../../src/web/client/app-bridge.ts";
import OrdersPage, { type OrdersPageLink } from "../../../../src/web/components/OrdersPage.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const order = (n: number, overrides: Partial<ShopOrder> = {}): OrderRow => ({
  order: {
    id: `gid://shopify/Order/${n}`,
    legacyId: String(n),
    name: `#${n}`,
    processedAt: Date.UTC(2026, 9, n),
    updatedAt: Date.UTC(2026, 9, n),
    cancelledAt: null,
    fulfillmentStatus: "UNFULFILLED",
    fullyPaid: true,
    note: null,
    syncedAt: Date.UTC(2026, 9, n),
    ...overrides,
  },
  itemUnits: 2,
  runs: { open: 0, done: 0, blocked: 0, started: 0 },
  unassigned: false,
  multiMatchItems: 0,
});

/** The orders index's data for one page of `orders`, every order shown. */
const pageOf = (
  orders: ReadonlyArray<OrderRow>,
  nextCursor: string | null = null,
): OrdersIndexData => ({
  page: {
    orders,
    limit: 25,
    nextCursor,
    counts: { no_workflow: 0, not_started: 0, making: 0, made: 0, issues: 0 },
    openOrders: orders.length,
    matches: null,
  },
  syncState: { inFlight: false, lastError: null },
  teams: [],
});

/** The input the route reads page one with. */
const INPUT = { limit: 25, cursor: null, q: null, show: "all", team: null } as const;

/** The route's Next page link, as a plain `href` with the cursor; clicks are recorded. */
let pageClicks: Array<string> = [];
const pageLink: OrdersPageLink = (cursor) => ({
  href: `/app/orders?after=${encodeURIComponent(cursor)}`,
  onClick: (event) => {
    event.preventDefault();
    pageClicks.push(cursor);
  },
});

const idle: OrdersSyncStatus = { inFlight: false, lastError: null };

/**
 * What the two sync procedures answer from the in-memory actor; nothing interesting unless a test
 * says otherwise.
 */
interface Presses {
  readonly syncOpenOrders?: OrdersSyncResult;
  readonly syncOrder?: SyncOrderResult;
}

/**
 * App Bridge's `shopify` global, which the embedded document defines and a test page does not:
 * a stub whose toasts are recorded in {@link toasts}.
 */
let toasts: Array<{ message: string; isError: boolean }> = [];
const appBridge: AppBridge = {
  idToken: () => Promise.resolve("token"),
  modal: { hide: () => Promise.resolve() },
  toast: {
    show: (message, options) => {
      toasts.push({ message, isError: options?.isError === true });
    },
  },
};

beforeEach(() => {
  toasts = [];
  pageClicks = [];
  globalThis.shopify = appBridge;
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

const render = (
  page: OrdersIndexData,
  options: { status?: OrdersSyncStatus; presses?: Presses } = {},
) =>
  renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
      <OrdersPage input={INPUT} data={page} pageLink={pageLink} />
    </ShopSocket>,
    shopTestRegistry({
      MerchantListOrders: () => Effect.succeed(page),
      MerchantSyncStatus: () => Effect.succeed(options.status ?? idle),
      MerchantSyncOpenOrders: () =>
        Effect.succeed(options.presses?.syncOpenOrders ?? { _tag: "Started" }),
      MerchantSyncOrder: () => Effect.succeed(options.presses?.syncOrder ?? { _tag: "Stored" }),
    }),
  );

describe("OrdersPage", () => {
  it("renders a page of orders: name, payment, status, units to make and the Shopify link", async () => {
    const screen = await render(
      pageOf([order(2, { fullyPaid: false }), order(1, { cancelledAt: Date.UTC(2026, 9, 3) })]),
    );
    await expect.element(screen.getByText("#2", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("#1", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Unpaid").first()).toBeVisible();
    await expect.element(screen.getByText("Cancelled")).toBeVisible();
    await expect.element(screen.getByText("2026-10-02")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open #2 in Shopify" }))
      .toHaveAttribute("href", "shopify://admin/orders/2");
    await expect
      .element(screen.getByRole("button", { name: "Sync #1 from Shopify" }))
      .toBeVisible();
    await expect.element(screen.getByText("No open orders")).not.toBeInTheDocument();
  });

  it("an empty list is the empty state, with Sync open orders", async () => {
    const screen = await render(pageOf([]));
    await expect.element(screen.getByText("No open orders")).toBeVisible();
    await expect
      .element(screen.getByText(/^Press Sync open orders to bring in your open orders/u))
      .toBeVisible();
  });

  it("a fixture order's row offers neither the Shopify link nor Sync from Shopify", async () => {
    const screen = await render(
      pageOf([order(2), order(1, { id: "gid://shopify/Order/fixture-1", legacyId: "fixture-1" })]),
    );
    await expect.element(screen.getByText("#1", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Open #2 in Shopify" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Sync #2 from Shopify" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open #1 in Shopify" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Sync #1 from Shopify" }))
      .not.toBeInTheDocument();
  });

  it("Next page links to the page after the last row, and only while there is one", async () => {
    const cursor = "1760000000000:gid://shopify/Order/1";
    const screen = await render(pageOf([order(2), order(1)], cursor));
    const next = screen.getByRole("link", { name: "Next page" });
    await expect
      .element(next)
      .toHaveAttribute("href", `/app/orders?after=${encodeURIComponent(cursor)}`);
    await next.click();
    expect(pageClicks).toStrictEqual([cursor]);
    await expect
      .element(screen.getByRole("link", { name: "Previous page" }))
      .not.toBeInTheDocument();
  });

  it("the last page has no Next page", async () => {
    const screen = await render(pageOf([order(1)]));
    await expect.element(screen.getByText("#1", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("a sync that starts toasts that it is syncing", async () => {
    const screen = await render(pageOf([]));
    await screen.getByRole("button", { name: "Sync open orders" }).click();
    await expect
      .poll(() => toasts)
      .toStrictEqual([{ message: "Syncing open orders", isError: false }]);
  });

  it("a press while a sync runs toasts that one is already running", async () => {
    // The empty state's twin: outside the admin, the title bar's copy is in `s-page`'s actions,
    // which a narrow test page folds away; in the admin App Bridge hoists it.
    const screen = await render(pageOf([]), {
      presses: { syncOpenOrders: { _tag: "InFlight" } },
    });
    await screen.getByRole("button", { name: "Sync open orders" }).click();
    await expect
      .poll(() => toasts)
      .toStrictEqual([{ message: "A sync is already running", isError: false }]);
  });

  it("Sync from Shopify on an order Shopify no longer has toasts Gone", async () => {
    const screen = await render(pageOf([order(1)]), {
      presses: { syncOrder: { _tag: "Gone" } },
    });
    await screen.getByRole("button", { name: "Sync #1 from Shopify" }).click();
    await expect
      .poll(() => toasts)
      .toStrictEqual([{ message: "Shopify no longer has this order", isError: false }]);
  });

  it("a failed sync's error is the banner in the list's head", async () => {
    const screen = await render(pageOf([order(1)]), {
      status: { inFlight: false, lastError: "Step failed: poll-bulk-orders" },
    });
    await expect.element(screen.getByText("Step failed: poll-bulk-orders")).toBeVisible();
  });
});

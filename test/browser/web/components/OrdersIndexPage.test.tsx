import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type {
  OrdersSyncResult,
  ShopOrder,
  OrdersSyncStatus,
} from "../../../../src/domain/orders.ts";
import {
  ListSearch,
  type OrderRow,
  type OrdersIndexData,
  type OrdersShow,
  TeamId,
  TeamName,
} from "../../../../src/domain/shop-work.ts";
import type { AppBridge } from "../../../../src/web/client/app-bridge.ts";
import OrdersIndexPage, {
  type OrdersFilterPatch,
} from "../../../../src/web/components/OrdersIndexPage.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";
import { NO_USAGE } from "../../usage.ts";

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

const COUNTS = { no_workflow: 1, not_started: 2, making: 3, made: 4, issues: 5 };
const TEAM = Schema.decodeUnknownSync(TeamId)("team-1");

/** The orders index's data for one page of `orders`. */
const pageOf = (
  orders: ReadonlyArray<OrderRow>,
  options: { nextCursor?: string | null; openOrders?: number; matches?: number | null } = {},
): OrdersIndexData => ({
  page: {
    orders,
    limit: 25,
    nextCursor: options.nextCursor ?? null,
    counts: COUNTS,
    openOrders: options.openOrders ?? orders.length,
    matches: options.matches ?? null,
  },
  syncState: { inFlight: false, lastError: null },
  teams: [{ id: TEAM, name: Schema.decodeUnknownSync(TeamName)("Bench") }],
});

const idle: OrdersSyncStatus = { inFlight: false, lastError: null };

/**
 * What the two sync procedures answer from the in-memory actor; nothing interesting unless a test
 * says otherwise.
 */
interface Presses {
  readonly syncOpenOrders?: OrdersSyncResult;
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

/** What the route was asked to do: filters, pages and the order links' clicks. */
let filters: Array<OrdersFilterPatch> = [];
let pages: Array<string> = [];
let opened: Array<string> = [];

beforeEach(() => {
  toasts = [];
  filters = [];
  pages = [];
  opened = [];
  globalThis.shopify = appBridge;
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

/** The URL's keys, every one absent unless a test sets it. */
interface Keys {
  readonly q?: ListSearch | null;
  readonly show?: OrdersShow | null;
  readonly team?: TeamId | null;
  readonly after?: string | null;
}

const render = (
  page: OrdersIndexData,
  options: { status?: OrdersSyncStatus; presses?: Presses; keys?: Keys } = {},
) =>
  renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
      <OrdersIndexPage
        usage={NO_USAGE}
        data={page}
        q={options.keys?.q ?? null}
        show={options.keys?.show ?? null}
        team={options.keys?.team ?? null}
        after={options.keys?.after ?? null}
        orderLink={(legacyId) => ({
          href: `/app/orders/${legacyId}`,
          onClick: (event) => {
            event.preventDefault();
            opened.push(legacyId);
          },
        })}
        onFilter={(patch) => {
          filters.push(patch);
        }}
        onNextPage={(cursor) => {
          pages.push(cursor);
        }}
        onPreviousPage={() => {
          pages.push("previous");
        }}
      />
    </ShopSocket>,
    shopTestRegistry({
      MerchantListOrders: () => Effect.succeed(page),
      MerchantSyncStatus: () => Effect.succeed(options.status ?? idle),
      MerchantSyncOpenOrders: () =>
        Effect.succeed(options.presses?.syncOpenOrders ?? { _tag: "Started" }),
    }),
  );

const search = (text: string) => Schema.decodeUnknownSync(ListSearch)(text);

describe("OrdersIndexPage", () => {
  it("renders a page of orders: the order link, payment, status, issues, units and the Shopify link", async () => {
    const screen = await render(
      pageOf([
        order(3, {}),
        { ...order(2, { fullyPaid: false }), multiMatchItems: 1 },
        order(1, { cancelledAt: Date.UTC(2026, 9, 3) }),
      ]),
    );
    const link = screen.getByRole("link", { name: "#3", exact: true });
    await expect.element(link).toHaveAttribute("href", "/app/orders/3");
    await link.click();
    expect(opened).toStrictEqual(["3"]);
    const badges = (n: number) =>
      [
        ...(screen.container
          .querySelector(`s-table-row[id="gid://shopify/Order/${String(n)}"]`)
          ?.querySelectorAll("s-badge") ?? []),
      ].map((badge) => [badge.textContent, badge.getAttribute("tone")]);
    expect(badges(3)).toStrictEqual([
      ["Paid", "success"],
      ["No workflow", "neutral"],
    ]);
    expect(badges(2)).toStrictEqual([
      ["Unpaid", "warning"],
      ["Unpaid", "neutral"],
      ["Multiple workflows match", "critical"],
    ]);
    expect(badges(1)).toStrictEqual([
      ["Paid", "success"],
      ["Cancelled", "critical"],
    ]);
    await expect
      .element(screen.getByRole("link", { name: "Open #2 in Shopify" }))
      .toHaveAttribute("href", "shopify://admin/orders/2");
    await expect.element(screen.getByText("Sync from Shopify")).not.toBeInTheDocument();
    await expect.element(screen.getByText("No open orders")).not.toBeInTheDocument();
  });

  it("an empty shop is the empty state alone, with Sync open orders, and no strip or filters", async () => {
    const screen = await render(pageOf([]));
    await expect.element(screen.getByText("No open orders")).toBeVisible();
    await expect
      .element(screen.getByText(/^Press Sync open orders to bring in your open orders/u))
      .toBeVisible();
    await expect.element(screen.getByRole("combobox", { name: "Show" })).not.toBeInTheDocument();
  });

  it("an empty list under a filter says what is empty, and under a team that two filters narrowed it", async () => {
    const making = await render(pageOf([], { openOrders: 3 }));
    await expect.element(making.getByText("Nothing is being made.")).toBeVisible();
    await making.unmount();
    const team = await render(pageOf([], { openOrders: 3 }), {
      keys: { show: "made", team: TEAM },
    });
    await expect.element(team.getByText("No orders match these filters.")).toBeVisible();
  });

  it("a fixture order's row has no Shopify link", async () => {
    const screen = await render(
      pageOf([order(2), order(1, { id: "gid://shopify/Order/fixture-1", legacyId: "fixture-1" })]),
    );
    await expect.element(screen.getByRole("link", { name: "#1", exact: true })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Open #2 in Shopify" })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open #1 in Shopify" }))
      .not.toBeInTheDocument();
  });

  it("the strip holds the counts, Making chosen by default, and a cell sets Show", async () => {
    const screen = await render(pageOf([order(1)]));
    await expect.element(screen.getByRole("button", { name: "Making, 3, selected" })).toBeVisible();
    await expect.element(screen.getByRole("combobox", { name: "Show" })).toHaveValue("making");
    await screen.getByRole("button", { name: "Issues, 5" }).click();
    expect(filters).toStrictEqual([{ show: "issues" }]);
  });

  it("the Show and Team selects set their filter, and a team no longer there reads Deleted team", async () => {
    const gone = Schema.decodeUnknownSync(TeamId)("team-gone");
    const screen = await render(pageOf([order(1)]), { keys: { team: gone } });
    await expect.element(screen.getByRole("combobox", { name: "Team" })).toHaveValue("team-gone");
    await expect.element(screen.getByRole("option", { name: "Deleted team" })).toBeInTheDocument();
    await screen.getByRole("combobox", { name: "Show" }).selectOptions("All");
    await screen.getByRole("combobox", { name: "Team" }).selectOptions("Bench");
    await screen.getByRole("combobox", { name: "Team" }).selectOptions("Any team");
    // A Polaris select reports a change on `input` and on `change`; the route's replace makes the
    // second a no-op.
    expect(
      filters.filter(
        (patch, index) => JSON.stringify(patch) !== JSON.stringify(filters[index - 1]),
      ),
    ).toStrictEqual([{ show: "all" }, { team: TEAM }, { team: null }]);
  });

  it("a search replaces the strip with the match line and disables the selects", async () => {
    const screen = await render(pageOf([order(1)], { matches: 1 }), {
      keys: { q: search("1"), show: "made" },
    });
    await expect.element(screen.getByText("1 order matches #1")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /^Making, /u }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("combobox", { name: "Show" })).toBeDisabled();
    await expect.element(screen.getByRole("combobox", { name: "Team" })).toBeDisabled();
    await screen.getByRole("button", { name: "Clear search" }).click();
    expect(filters).toStrictEqual([{ q: null }]);
  });

  it("a search that matches nothing names the search and offers Clear search", async () => {
    const screen = await render(pageOf([], { openOrders: 2, matches: 0 }), {
      keys: { q: search("9999") },
    });
    await expect.element(screen.getByText("No order matches #9999")).toBeVisible();
    await screen.getByRole("button", { name: "Clear search" }).click();
    expect(filters).toStrictEqual([{ q: null }]);
  });

  it("the table pages forward by the cursor and back by the route's Previous", async () => {
    const cursor = "1760000000000:gid://shopify/Order/1";
    const screen = await render(pageOf([order(2), order(1)], { nextCursor: cursor }), {
      keys: { after: "1760000000001:gid://shopify/Order/3" },
    });
    await screen.getByRole("button", { name: "Go to next page" }).click();
    await screen.getByRole("button", { name: "Go to previous page" }).click();
    expect(pages).toStrictEqual([cursor, "previous"]);
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

  it("a failed sync's error is the banner in the list's head", async () => {
    const screen = await render(pageOf([order(1)]), {
      status: { inFlight: false, lastError: "Step failed: poll-bulk-orders" },
    });
    await expect.element(screen.getByText("Step failed: poll-bulk-orders")).toBeVisible();
  });
});

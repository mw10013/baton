import type { BrowserContext, FrameLocator, Page } from "playwright/test";

import { dev, expect, type Run, test } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";
import { cancelTestOrder, createTestOrder, type TestOrder } from "./test-orders.ts";

/**
 * The Backend's own Admin calls on the e2e store, against Shopify itself: the refresh grant with
 * no merchant present, one refresh under concurrent calls, and Shopify's real answer to a dead
 * refresh token. Each call is a press of Sync from Shopify on an order's page, on a real order
 * the spec creates on the store ({@link createTestOrder}) and cancels at the end; a fixture order
 * offers no such press. Each order's page is open in a tab of its own, so five presses can run at
 * once. A press that succeeds stores the order and toasts nothing, so a test waits for the button
 * to stop loading and for no error toast; since the session is ensured before the fetch, the
 * refresh has happened by then. The tests run in order and age the one store row on purpose, so
 * the spec is the `refresh` project, which runs alone after every other project.
 */
test.describe.configure({ mode: "serial" });

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const REAUTHORIZE = "Couldn't reach Shopify. Reload Baton to reconnect.";

/**
 * How long the store's webhooks for the new orders are given to arrive before the first test: each
 * fetches the order through the stored session, and one landing mid-test would make the refresh
 * a test waits for its own.
 */
const WEBHOOKS_SETTLE = 10_000;

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;
/** The spec's five real orders; the first is the one the single-press tests use. */
let orders: ReadonlyArray<TestOrder> = [];
/** Each order's page, in its own tab, by the order's GID. */
const tabs = new Map<string, { readonly page: Page; readonly frame: FrameLocator }>();

/** The orders index, every order shown: a real order has no workflow, so Making leaves it out. */
const gotoOrders = async () => {
  frame = await gotoApp(page, "app/orders?show=all");
};

const tabOf = (order: TestOrder) => {
  const tab = tabs.get(order.id);
  if (tab === undefined) throw new Error(`no tab for ${order.name}`);
  return tab;
};

/** The order page's Sync from Shopify, in the frame; App Bridge hoists a proxy of it. */
const syncButton = (order: TestOrder) =>
  tabOf(order).frame.locator('s-button[slot="secondary-actions"]', {
    hasText: "Sync from Shopify",
  });

/**
 * Presses Sync from Shopify on `order`'s page. A dispatched click on the frame's own button, not
 * a pointer one on the hoisted proxy: the press is the button's handler, and pointer clicks run
 * at once race on coordinates.
 */
const press = (order: TestOrder) => syncButton(order).dispatchEvent("click");

/** Waits until the press on `order` has answered: its button stops loading. */
const answered = (order: TestOrder) => expect(syncButton(order)).toHaveJSProperty("loading", false);

/** No press failed: no error toast in any tab. */
const noFailure = async () => {
  for (const tab of tabs.values()) await expect(tab.page.getByText(/^Couldn't/u)).toHaveCount(0);
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  orders = await Promise.all(Array.from({ length: 5 }, () => createTestOrder()));
  ({ context, page } = await openApp(browser));
  await gotoOrders();
  for (const order of orders)
    await expect(frame.locator("s-table-row", { hasText: order.name })).toBeVisible({
      timeout: 60_000,
    });
  await page.waitForTimeout(WEBHOOKS_SETTLE);
  for (const order of orders) {
    const tab = await context.newPage();
    const legacyId = order.id.split("/").at(-1) ?? "";
    tabs.set(order.id, { page: tab, frame: await gotoApp(tab, `app/orders/${legacyId}`) });
    await expect(syncButton(order)).toHaveJSProperty("disabled", false);
  }
});

const first = () => orders[0] ?? { id: "", name: "(no order)" };

/** The stored access token's expiry, once it is past `after`: the refresh or exchange landed. */
const refreshedAfter = async (backend: Run, after: number) => {
  await expect
    .poll(
      async () =>
        (await backend(dev((c) => c.GetShopSession({ shop }))))?.accessTokenExpiresAt ?? 0,
    )
    .toBeGreaterThan(after);
  return backend(dev((c) => c.GetShopSession({ shop })));
};

/**
 * Whatever the tests did, leave a live session: a reload exchanges when the stored token is not
 * fresh, and a failed `invalidate` test would otherwise leave a dead refresh token that breaks
 * the next run. Serial mode skips the remaining tests after a failure, so this cannot be a test.
 */
test.afterAll(async ({ backend }) => {
  test.setTimeout(120_000);
  await gotoOrders()
    .then(() => refreshedAfter(backend, Date.now()))
    .finally(() => context.close())
    .finally(() => Promise.all(orders.map((order) => cancelTestOrder(order))));
});

test("an expired token refreshes and the Admin call succeeds", async ({ backend }) => {
  const before = await backend(dev((c) => c.GetShopSession({ shop })));
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "keep" })));
  await press(first());
  await answered(first());
  await noFailure();
  const after = await refreshedAfter(backend, Date.now());
  const now = Date.now();
  expect(Math.abs((after?.accessTokenExpiresAt ?? 0) - (now + HOUR))).toBeLessThan(5 * MINUTE);
  expect(after?.refreshTokenExpiresAt ?? 0).toBeGreaterThan(now + MINUTE);
  expect(after?.refreshLeaseUntil).toBeNull();
  // Shopify says a refresh "can shorten" the successor's lifetime, so only record the values.
  test.info().annotations.push({
    type: "refreshTokenExpiresAt",
    description: `before=${before?.refreshTokenExpiresAt} after=${after?.refreshTokenExpiresAt}`,
  });
});

test("five parallel syncs all succeed, and a second refresh still works", async ({ backend }) => {
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "keep" })));
  await Promise.all(orders.map((order) => press(order)));
  const after = await refreshedAfter(backend, Date.now());
  expect(after?.refreshLeaseUntil).toBeNull();
  for (const order of orders) await answered(order);
  await noFailure();
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "keep" })));
  await press(first());
  await refreshedAfter(backend, Date.now());
});

test("reloading the embedded app reuses the refreshed row without an exchange", async ({
  backend,
}) => {
  const before = await backend(dev((c) => c.GetShopSession({ shop })));
  await gotoOrders();
  const after = await backend(dev((c) => c.GetShopSession({ shop })));
  expect(after?.accessTokenExpiresAt).toBe(before?.accessTokenExpiresAt);
});

test("a rejected refresh token is ReauthorizationRequired, Shopify's real 401", async ({
  backend,
}) => {
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "invalidate" })));
  const expired = await backend(dev((c) => c.GetShopSession({ shop })));
  await press(first());
  await expect(tabOf(first()).page.getByText(REAUTHORIZE).first()).toBeVisible();
  const after = await backend(dev((c) => c.GetShopSession({ shop })));
  expect(after?.accessTokenExpiresAt).toBe(expired?.accessTokenExpiresAt);
});

test("reloading the embedded app exchanges and restores the session", async ({ backend }) => {
  await gotoOrders();
  await refreshedAfter(backend, Date.now());
  const legacyId = first().id.split("/").at(-1) ?? "";
  const tab = tabOf(first());
  tabs.set(first().id, {
    page: tab.page,
    frame: await gotoApp(tab.page, `app/orders/${legacyId}`),
  });
  await press(first());
  await answered(first());
  await noFailure();
});

import type { BrowserContext, FrameLocator, Page } from "playwright/test";

import { dev, expect, test, testEmail } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { awaitHydration, clickHoisted, gotoApp, hoistedEnabled, openApp } from "./app.ts";
import {
  add,
  chooseTeam,
  listContext,
  listOrdersAnswer,
  openOrders,
  openScreen,
  own,
  ownBase,
  ownNumbers,
  searchField,
  searchOrders,
  showSelect,
  stripCell,
  stripChosen,
  stripCount,
  tableIdle,
} from "./orders-screens.ts";
import { cancelTestOrder, createTestOrder, type TestOrder } from "./test-orders.ts";

/**
 * The orders index inside the Shopify admin. The first cases run against Shopify itself, on one
 * real order the spec creates on the e2e store ({@link createTestOrder}): it arrives by webhook;
 * its row links to Shopify; Sync open orders runs; taken off the screen with the dev door's
 * `RemoveOrder`, only Sync open orders can bring it back, and does; cancelled in Shopify, its row
 * follows. A real order has a custom line item and no product, so no workflow ever matches it: it
 * is No workflow, which the default Show (Making) leaves out, so those cases open the index with
 * `?show=all`. The order is open and recent until the cancel, so the open-orders sync's 30-day
 * query includes it.
 *
 * The rest are legacy `e2e/orders.spec.ts`'s index cases, titles unchanged, each over orders,
 * teams and workflows it adds with `AddToFixture` under names, tags and order numbers of its own;
 * a case that reads a count reads it under its own team, or searches for its own orders.
 */
test.describe.configure({ mode: "serial" });

/** How long Sync open orders may take: Shopify's bulk export plus the stream, at worst. */
const SYNC_TIMEOUT = 180_000;

/**
 * How long a removed row must stay off the screen before the sync. Shopify sends several webhooks
 * within seconds of the create, and any of them stores the order again; once the row has stayed
 * away this long they are done, so a row that reappears after the press came from the sync.
 */
const QUIET = 10_000;

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;
let order: TestOrder | undefined;
let cancelled = false;

test.beforeAll(async ({ browser }) => {
  ({ context, page } = await openApp(browser));
  frame = await gotoApp(page, "app/orders?show=all");
});

test.afterAll(async () => {
  try {
    if (order !== undefined && !cancelled) await cancelTestOrder(order);
  } finally {
    await context.close();
  }
});

/** The screen's row for the spec's real order. */
const row = () => frame.locator("s-table-row", { hasText: order?.name ?? "(no order yet)" });

test("the orders screen shows an order Shopify sends by webhook", async () => {
  order = await createTestOrder();
  await expect(row()).toBeVisible({ timeout: 60_000 });
  await expect(row().getByText("Paid")).toBeVisible();
});

/**
 * Each row of the orders index opens the order in the Shopify admin through an icon button whose
 * accessible name says where it goes, and the order's name opens its page.
 */
test("the orders index links each order to Shopify", async () => {
  const name = order?.name ?? "";
  await expect(row().getByRole("link", { name: `Open ${name} in Shopify` })).toBeVisible();
  await frame.getByRole("link", { name, exact: true }).click();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
  // The hoisted breadcrumb's back arrow, to the list as it was.
  await page.getByRole("button", { name: "Orders", exact: true }).click();
  await expect(row()).toBeVisible();
  expect(listContext(page).show).toBe("all");
});

/**
 * The open-orders sync end to end: Sync open orders over the merchant socket, Shopify's bulk
 * export, the stream into the actor, and the notice that refreshes the table without a reload.
 * The Sync button is the gate on both ends: it disables while the sync runs and enables when it
 * ends, which is the honest signal that it finished. Both title-bar buttons are hoisted out of the
 * frame, so they are driven on `page`. The order's page is the only place its items are drawn,
 * and its Sync from Shopify syncs it alone.
 */
test("orders screen syncs open orders and lists them", async () => {
  test.setTimeout(SYNC_TIMEOUT);
  const sync = page.getByRole("button", { name: "Sync open orders" });
  await expect.poll(() => hoistedEnabled(sync)).toBe(true);
  await clickHoisted(sync);
  await expect.poll(() => hoistedEnabled(sync), { timeout: 30_000 }).toBe(false);
  await expect.poll(() => hoistedEnabled(sync), { timeout: 120_000 }).toBe(true);

  await expect(row()).toBeVisible({ timeout: 30_000 });
  await row()
    .getByRole("link", { name: order?.name ?? "", exact: true })
    .click();
  // One card per item, each an unslotted section; the aside's sections are slotted.
  await expect(frame.locator("s-section:not([slot])").first()).toBeVisible();

  const syncOne = page.getByRole("button", { name: "Sync from Shopify" });
  await expect.poll(() => hoistedEnabled(syncOne)).toBe(true);
  await clickHoisted(syncOne);
  await expect.poll(() => hoistedEnabled(syncOne), { timeout: 30_000 }).toBe(true);
  // The breadcrumb, to the list the order was opened from.
  await page.getByRole("button", { name: "Orders", exact: true }).click();
  await expect(row()).toBeVisible();
});

test("Sync open orders brings back an open order the screen no longer lists", async ({
  backend,
}) => {
  test.setTimeout(SYNC_TIMEOUT + 120_000);
  const orderId = order?.id ?? "";
  // Removed again whenever a late write brought the row back, until it stays away. A late write
  // can land right behind the removal (a Sync from Shopify queued in the actor stores the order
  // again), so the row not leaving within the wait is a retry, not a failure.
  await expect
    .poll(
      async () => {
        await backend(dev((c) => c.RemoveOrder({ shop, orderId })));
        await expect(row())
          .toHaveCount(0)
          .catch(() => undefined);
        await page.waitForTimeout(QUIET);
        return row().count();
      },
      { timeout: 60_000, intervals: [0] },
    )
    .toBe(0);

  await page.getByRole("button", { name: "Sync open orders" }).click();
  await expect(page.getByText("Syncing open orders").first()).toBeVisible();
  await expect(row()).toBeVisible({ timeout: SYNC_TIMEOUT });
  await expect(row().getByText("Paid")).toBeVisible();
  await expect(frame.getByText(/^Step failed/u)).toHaveCount(0);
});

test("a cancelled order shows Cancelled", async () => {
  if (order !== undefined) await cancelTestOrder(order);
  cancelled = true;
  await expect(row().getByText("Cancelled")).toBeVisible({ timeout: 60_000 });
});

/** One team with one member of the test's own, and a one-task workflow on it per tag. */
const bench = (team: string, workflows: ReadonlyArray<{ name: string; tag: string }>) => {
  const member = testEmail("orders");
  return {
    members: [member],
    teams: [{ name: team, members: [member] }],
    workflows: workflows.map(({ name, tag }) => ({
      name,
      tag,
      state: "active",
      tasks: [{ name: "Cut", team }],
    })),
  };
};

/**
 * Search: the field narrows the table to the one order, and Clear search or emptying the field
 * puts the list back. Two orders are added because a filter that cannot hide anything proves
 * nothing. The search ignores the filters, so it finds a making order under Made; while it is on
 * the strip gives way to the match line and the selects are disabled, and Clear search brings
 * the strip back with Made kept.
 */
test("the orders index searches by order number and clears back to the list", async ({
  backend,
}) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const ring = `E2E Ring ${id}`;
  const band = `E2E Band ${id}`;
  const base = ownBase();
  const [first, second] = [base + 1, base + 2];
  const item = { title: band, quantity: 1, tags: [`e2e-ring-${id}`] };
  await add(backend, {
    ...bench(team, [{ name: ring, tag: `e2e-ring-${id}` }]),
    orders: [
      { n: first, started: true, lineItems: [item] },
      { n: second, started: true, lineItems: [item] },
    ],
  });
  const link = (n: number) => frame.getByRole("link", { name: `#${String(n)}`, exact: true });

  frame = await openOrders(page);
  await expect(link(second)).toBeVisible();

  // Under Made, where neither making order is listed. Making is the default.
  await expect(stripChosen(frame, "Making")).toBeVisible();
  await stripCell(frame, "Made").click();
  await expect(link(second)).toHaveCount(0);
  await expect(stripChosen(frame, "Made")).toBeVisible();
  await expect(stripChosen(frame, "Making")).toHaveCount(0);

  // The digits alone: the search supplies the `#`. Enter submits; the field does not debounce.
  await searchOrders(frame, String(first));
  await expect(link(first)).toBeVisible();
  await expect(link(second)).toHaveCount(0);
  await expect(searchField(frame)).toHaveValue(String(first));
  await expect(frame.getByText(`1 order matches #${String(first)}`, { exact: true })).toBeVisible();
  await expect(stripCell(frame, "Made")).toHaveCount(0);
  await expect(showSelect(frame)).toBeDisabled();

  // Clear search brings the strip back, with Made still chosen.
  await frame.getByRole("button", { name: "Clear search" }).click();
  await expect(searchField(frame)).toHaveValue("");
  await expect(stripCell(frame, "Made")).toBeVisible();
  await expect(showSelect(frame)).toHaveValue("made");
  await expect(link(second)).toHaveCount(0);

  // Back to the default by the Making cell.
  await stripCell(frame, "Making").click();
  await expect(link(second)).toBeVisible();

  // An item's words find both, by title.
  await searchOrders(frame, band.toLowerCase());
  await expect(link(first)).toBeVisible();
  await expect(link(second)).toBeVisible();
  await searchField(frame).fill("");
  await expect(stripCell(frame, "Making")).toBeVisible();

  await searchOrders(frame, String(first));
  await expect(link(second)).toHaveCount(0);

  // Emptying the field is the search cleared, with no Enter: the list comes back.
  await searchField(frame).fill("");
  await expect(link(second)).toBeVisible();

  // A number no order carries: the empty state names it, and offers Clear search.
  const none = base + 99;
  await searchOrders(frame, String(none));
  await expect(frame.getByText(`No order matches #${String(none)}`, { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Clear search" }).click();
  await expect(link(second)).toBeVisible();

  // The search stays in the orders section: opened from the search, the order page keeps `q`,
  // and the Workflows nav link from there lands on the workflows list with no search.
  await searchOrders(frame, String(first));
  // The search's own list, so the link carries `q`.
  await expect(link(second)).toHaveCount(0);
  await link(first).click();
  await expect(frame.locator(`s-page[heading="#${String(first)}"]`)).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).not.toBeNull();
  await openScreen(page, "Workflows");
  await expect(searchField(frame)).toHaveValue("");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBeNull();
  frame = await openOrders(page);
  await expect(searchField(frame)).toHaveValue("");

  // A bare order number typed into the URL is the search: the router parses `q=<n>` as a number,
  // and it reads as the digits rather than being dropped. Typed means a document load.
  frame = await gotoApp(page, `app/orders?q=${String(first)}`);
  await expect(link(first)).toBeVisible();
  await expect(link(second)).toHaveCount(0);
  await expect(searchField(frame)).toHaveValue(String(first));
});

/**
 * Each strip cell's number is the number of rows choosing it shows, under the team select. The
 * counts ignore the search, so the team is what keeps this test to its own orders: the first two
 * wait on the test's team and nobody has started either, and the first also has an item matching
 * two workflows, which is an issue. The third matches nothing, so it is No workflow, waits on no
 * team and only the unnarrowed counts see it.
 */
test("each count is what choosing it shows, given the team", async ({ backend }) => {
  const id = own();
  const team = `E2E Issues Bench ${id}`;
  const cuff = `e2e-issues-${id}`;
  const rush = `e2e-issues-rush-${id}`;
  const base = ownBase();
  const [first, second, third] = [base + 1, base + 2, base + 3];
  await add(backend, {
    ...bench(team, [
      { name: `E2E Issues Cuff ${id}`, tag: cuff },
      { name: `E2E Issues Rush ${id}`, tag: rush },
    ]),
    orders: [
      {
        n: first,
        lineItems: [
          { title: "E2E Cuff", quantity: 1, tags: [cuff] },
          { title: "E2E Twice", quantity: 1, tags: [cuff, rush] },
        ],
      },
      { n: second, lineItems: [{ title: "E2E Cuff", quantity: 1, tags: [cuff] }] },
      { n: third, lineItems: [{ title: "E2E Unrouted", quantity: 1, tags: [] }] },
    ],
  });

  frame = await openOrders(page);
  // The third is counted under No workflow before the team narrows the counts.
  await expect.poll(() => stripCount(frame, "No workflow")).toBeGreaterThan(0);

  await chooseTeam(page, frame, team);
  const counted = [
    ["No workflow", 0],
    ["Not started", 2],
    ["Making", 0],
    ["Made", 0],
    ["Issues", 1],
  ] as const;
  for (const [label, n] of counted)
    await expect(frame.getByRole("button", { name: `${label}, ${String(n)}` })).toBeVisible();

  const rows = frame.locator("s-table-row");
  for (const [label, n] of counted) {
    await stripCell(frame, label).click();
    await expect(rows).toHaveCount(n);
  }
  await stripCell(frame, "Issues").click();
  await expect(frame.getByRole("link", { name: `#${String(first)}`, exact: true })).toBeVisible();

  // A search reads every stored order, team or not, and moves no count.
  await searchOrders(frame, String(third));
  await expect(frame.getByRole("link", { name: `#${String(third)}`, exact: true })).toBeVisible();
  // A No workflow order says so in Status and has nothing in Issues: Payment's and Status's
  // badges only.
  const unrouted = frame.locator("s-table-row", { hasText: `#${String(third)}` });
  await expect(unrouted.locator("s-badge", { hasText: "No workflow" })).toBeVisible();
  await expect(unrouted.locator("s-badge")).toHaveCount(2);
  await frame.getByRole("button", { name: "Clear search" }).click();
  for (const [label, n] of counted)
    await expect(frame.getByRole("button", { name: `${label}, ${String(n)}` })).toBeVisible();
});

/**
 * `OrdersShow` takes one value, and the strip and the Show select both set it: Making then
 * Issues is Issues alone, with only the Issues cell chosen. A value with no cell, Fulfilled,
 * leaves no cell chosen. The first order is making with a Multiple workflows match; the second is
 * making with none; both are listed under Making, the default. The team keeps the test to its
 * own orders.
 */
test("the counts at the top and the Show menu hold one value", async ({ backend }) => {
  const id = own();
  const team = `E2E Combine Bench ${id}`;
  const cuff = `e2e-combine-${id}`;
  const rush = `e2e-combine-rush-${id}`;
  const base = ownBase();
  const [first, second] = [base + 1, base + 2];
  await add(backend, {
    ...bench(team, [
      { name: `E2E Combine Cuff ${id}`, tag: cuff },
      { name: `E2E Combine Rush ${id}`, tag: rush },
    ]),
    orders: [
      {
        n: first,
        started: true,
        lineItems: [
          { title: "E2E Cuff", quantity: 1, tags: [cuff] },
          { title: "E2E Twice", quantity: 1, tags: [cuff, rush] },
        ],
      },
      {
        n: second,
        started: true,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: [cuff] }],
      },
    ],
  });

  frame = await openOrders(page);
  await chooseTeam(page, frame, team);
  const rows = frame.locator("s-table-row");
  await expect(rows).toHaveCount(2);

  await stripCell(frame, "Making").click();
  await expect(stripChosen(frame, "Making")).toBeVisible();
  await stripCell(frame, "Issues").click();
  await expect.poll(() => listContext(page).show).toBe("issues");
  await expect(rows).toHaveCount(1);
  await expect(frame.getByRole("link", { name: `#${String(first)}`, exact: true })).toBeVisible();
  await expect(showSelect(frame)).toHaveValue("issues");
  await expect(stripChosen(frame, "Issues")).toBeVisible();
  await expect(stripChosen(frame, "Making")).toHaveCount(0);

  await showSelect(frame).selectOption({ label: "Fulfilled" });
  await expect.poll(() => listContext(page).show).toBe("fulfilled");
  for (const label of ["No workflow", "Not started", "Making", "Made", "Issues"])
    await expect(stripChosen(frame, label)).toHaveCount(0);
});

/**
 * Thirty orders all waiting on one team of the test's own, each with its task started so all
 * thirty are Making, so the team filter keeps the list to this test's orders, and 30 is a full
 * first page (25) plus a second of five.
 */
const addTwoPages = async (backend: Parameters<typeof add>[0], team: string, base: number) => {
  const id = own();
  await add(backend, {
    ...bench(team, [{ name: `E2E Pages Ring ${id}`, tag: `e2e-pages-${id}` }]),
    orders: Array.from({ length: 30 }, (_, index) => ({
      n: base + 1 + index,
      started: true,
      lineItems: [{ title: "E2E Pages Band", quantity: 1, tags: [`e2e-pages-${id}`] }],
    })),
  });
};

/**
 * `OrdersSearch` on the `/app/orders` layout: the filters and the page ride the order page's URL,
 * so the breadcrumb and the browser's history both return to them. Previous on a page Next pushed
 * is the browser's Back.
 */
test("the orders index keeps its filters and page across the order page", async ({ backend }) => {
  const team = `E2E Pages Bench ${own()}`;
  const base = ownBase();
  await addTwoPages(backend, team, base);

  frame = await openOrders(page);
  const rows = frame.locator("s-table-row", { hasText: ownNumbers(base) });
  await stripCell(frame, "Making").click();
  await chooseTeam(page, frame, team);
  await expect(rows).toHaveCount(25);

  await frame.getByRole("button", { name: "Go to next page" }).click();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page).after).not.toBeNull();
  const expected = listContext(page);
  // The Making cell is the default, `?show=` left out.
  expect(expected.show).toBeNull();
  expect(expected.team).not.toBeNull();

  // The row's real href carries them, so open-in-new-tab does too.
  const link = rows.first().getByRole("link").first();
  const href = await link.evaluate((el) => el.getAttribute("href") ?? "");
  const hrefSearch = new URL(href, "http://localhost").searchParams;
  expect({
    show: hrefSearch.get("show"),
    team: hrefSearch.get("team"),
    after: hrefSearch.get("after"),
  }).toEqual(expected);

  const rowText = await rows.first().textContent();
  const name = ownNumbers(base).exec(rowText ?? "")?.[0] ?? "";
  await link.click();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
  await expect.poll(() => listContext(page)).toEqual(expected);

  // The breadcrumb is hoisted into the admin title bar, where its back arrow is named for the
  // page it returns to.
  await page.getByRole("button", { name: "Orders", exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page)).toEqual(expected);

  // Back to the order page, Back again to the page Next pushed, Forward to the order page: every
  // entry kept the filters and the page.
  await page.goBack();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
  await expect.poll(() => listContext(page)).toEqual(expected);
  await page.goBack();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page)).toEqual(expected);
  await page.goForward();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
  await expect.poll(() => listContext(page)).toEqual(expected);

  // Back once more to the page Next pushed, then Previous, to page one with the filters. Previous
  // is the browser's Back only before a history move: App Bridge replays an admin Back as a new
  // navigation in the frame, so this entry no longer carries `nextPage` and Previous goes to page
  // one by URL.
  const reloaded = listOrdersAnswer(page);
  await page.goBack();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page)).toEqual(expected);
  // A move through the admin's history can load the frame afresh, and a press before hydration
  // is dropped.
  await awaitHydration(frame);
  // A page shown before is refreshed twice on return: its live read at once, then again with the
  // router's background reload. Wait out both before the press.
  await (await reloaded).finished();
  await tableIdle(frame);
  await frame.getByRole("button", { name: "Go to previous page" }).click();
  await expect(rows).toHaveCount(25);
  await expect.poll(() => listContext(page)).toEqual({ ...expected, after: null });
});

/**
 * A filter is a new list, so the page resets, and it replaces the history entry, so Back leaves
 * the list rather than replaying the filters.
 */
test("a filter change resets the page and replaces history", async ({ backend }) => {
  const team = `E2E Pages Filter ${own()}`;
  const base = ownBase();
  await addTwoPages(backend, team, base);

  frame = await openOrders(page);
  const rows = frame.locator("s-table-row", { hasText: ownNumbers(base) });
  await stripCell(frame, "Making").click();
  await chooseTeam(page, frame, team);
  await expect(rows).toHaveCount(25);

  // Two filters chosen, no page turned: one Back leaves Orders for the screen before it. Forward
  // is not taken: the admin reloads the frame on that move and its session-token bounce lands on
  // Page not found, so the list is opened again from the nav.
  await page.goBack();
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await expect(frame.locator('s-page[heading="Orders"]')).toHaveCount(0);
  frame = await openOrders(page);
  await chooseTeam(page, frame, team);
  await expect(rows).toHaveCount(25);

  await frame.getByRole("button", { name: "Go to next page" }).click();
  await expect(rows).toHaveCount(5);
  await showSelect(frame).selectOption({ label: "All" });
  await expect
    .poll(() => {
      const { show, after } = listContext(page);
      return { show, after };
    })
    .toEqual({ show: "all", after: null });
  await expect(rows).toHaveCount(25);
});

/**
 * `lenientSearchKey`: an unreadable filter reads as that key being off, never as an error; an old
 * `?view=`, `?position=` or `?issues=` is not a key at all. The test adds 26 making orders of its
 * own, so the default list has a second page whatever else the store holds, and the table's pager
 * is there to read.
 */
test("a bad filter value reads as no filter", async ({ backend }) => {
  const id = own();
  const team = `E2E Bad Filter ${id}`;
  const base = ownBase();
  await add(backend, {
    ...bench(team, [{ name: `E2E Bad Filter ${id}`, tag: `e2e-bad-${id}` }]),
    orders: Array.from({ length: 26 }, (_, index) => ({
      n: base + 1 + index,
      started: true,
      lineItems: [{ title: "E2E Bad Band", quantity: 1, tags: [`e2e-bad-${id}`] }],
    })),
  });
  // A URL typed by hand is a document load: no in-app link carries an unreadable value.
  frame = await gotoApp(
    page,
    "app/orders?show=nonsense&position=made&issues=1&view=issues&after=nonsense",
  );
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  await expect(showSelect(frame)).toHaveValue("making");
  await expect(stripChosen(frame, "Making")).toBeVisible();
  // `after=nonsense` is not shaped like a cursor, so it is dropped too: this is page one and
  // there is no previous page.
  await expect(frame.getByRole("button", { name: "Go to previous page" })).toBeDisabled();
});

/**
 * Every issue kind lands in the Issues filter, and its badge is critical: the strip cell is
 * neutral, so the badge is where the alarm colour is. The team select keeps this test to its own
 * orders: the first waits on a team with a member and has an item matching two workflows, a
 * Multiple workflows match issue; the third has an unassigned task on a later step, a Needs a team
 * issue. The second's only task is on a team with no members, which is a workflow fault and no
 * order issue, so its team shows no issue. The Issues count honours the team, so each team shows
 * its own order.
 *
 * The fixture refuses an active workflow with an unassigned task, so the third's second step is
 * on a team that is then deleted on the teams screen, which is how a task becomes unassigned in
 * the app.
 */
test("every issue kind counts in the Issues filter and its badge is critical", async ({
  backend,
}) => {
  const id = own();
  const member = testEmail("flagged");
  const team = `E2E Flagged Bench ${id}`;
  const empty = `E2E Flagged Empty ${id}`;
  const orphan = `E2E Flagged Orphan ${id}`;
  const gone = `E2E Flagged Gone ${id}`;
  const base = ownBase();
  const [first, third] = [base + 1, base + 3];
  await add(backend, {
    members: [member],
    teams: [
      { name: team, members: [member] },
      { name: empty, members: [] },
      { name: orphan, members: [member] },
      { name: gone, members: [member] },
    ],
    workflows: [
      {
        name: `E2E Flagged Cuff ${id}`,
        tag: `e2e-flagged-${id}`,
        tasks: [{ name: "Cut", team }],
      },
      {
        name: `E2E Flagged Rush ${id}`,
        tag: `e2e-flagged-rush-${id}`,
        tasks: [{ name: "Expedite", team }],
      },
      {
        name: `E2E Flagged Empty team ${id}`,
        tag: `e2e-flagged-empty-${id}`,
        tasks: [{ name: "Wait", team: empty }],
      },
      {
        name: `E2E Flagged Orphan ${id}`,
        tag: `e2e-flagged-orphan-${id}`,
        tasks: [
          { name: "Cut", team: orphan, step: 1 },
          { name: "Pack", team: gone, step: 2 },
        ],
      },
    ],
    orders: [
      {
        n: first,
        lineItems: [
          { title: "E2E Cuff", quantity: 1, tags: [`e2e-flagged-${id}`] },
          {
            title: "E2E Twice",
            quantity: 1,
            tags: [`e2e-flagged-${id}`, `e2e-flagged-rush-${id}`],
          },
        ],
      },
      {
        n: base + 2,
        lineItems: [{ title: "E2E Nobody", quantity: 1, tags: [`e2e-flagged-empty-${id}`] }],
      },
      {
        n: third,
        lineItems: [{ title: "E2E Orphan", quantity: 1, tags: [`e2e-flagged-orphan-${id}`] }],
      },
    ],
  });

  await openScreen(page, "Teams");
  await searchOrders(frame, gone);
  await frame.getByRole("link", { name: gone, exact: true }).click();
  await expect(frame.locator(`s-page[heading="${gone}"]`)).toBeVisible();
  // Delete sits in the title bar's More actions menu, which App Bridge hoists; its in-frame
  // button still fires the modal (`teams.spec.ts`).
  await frame.locator("s-menu#team-actions s-button", { hasText: "Delete" }).evaluate((el) => {
    (el as HTMLElement).click();
  });
  await frame
    .locator("s-modal#delete-team")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();

  frame = await openOrders(page);
  await stripCell(frame, "Issues").click();
  await expect.poll(() => listContext(page).show).toBe("issues");

  const cases = [
    [team, first, "Multiple workflows match"],
    [orphan, third, "Needs a team"],
  ] as const;
  for (const [teamName, n, issue] of cases) {
    await chooseTeam(page, frame, teamName);
    await expect(frame.getByRole("button", { name: "Issues, 1, selected" })).toBeVisible();
    await expect(frame.locator("s-table-row")).toHaveCount(1);
    await expect(
      frame
        .locator("s-table-row", { hasText: `#${String(n)}` })
        .locator("s-badge", { hasText: issue }),
    ).toHaveAttribute("tone", "critical");
  }
  await chooseTeam(page, frame, empty);
  await expect(frame.getByRole("button", { name: "Issues, 0, selected" })).toBeVisible();
  await expect(frame.locator("s-table-row")).toHaveCount(0);
});

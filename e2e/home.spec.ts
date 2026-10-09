import { expect, type FrameLocator, type Page, test } from "@playwright/test";

import * as Domain from "@/lib/Domain";
import { ORDERS_STRIP } from "@/lib/ordersIndexQuery";

import { openApp } from "./app";
import { awaitHydration } from "./hydration";
import { seedConfig, seedMembers } from "./seed";

test.describe.configure({ mode: "serial" });

let page: Page;
let frame: FrameLocator;

const MEMBER = "e2e.home@example.com";
const TEAM = "E2E Home Bench";
const TAG = "e2e-home";

/**
 * One admin boot for the spec (`openApp`), after one seed: a team with a
 * member, an active workflow on it, and four orders whose items it matches,
 * one per position the strip counts plus a blocked one for Issues. That is
 * every setup fact holding (`Domain.SetupFacts`), so the guide is hidden.
 * The boot lands on home and every test but the last stays there: the
 * app's Home link is hidden (`rel="home"`), so there is no hoisted link
 * back, and help opens in a tab of its own, which the test closes.
 */
test.beforeAll(async ({ browser }) => {
  const item = { title: "E2E Home Cuff", quantity: 1, tags: [TAG] };
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Home Cuff",
        tag: TAG,
        tasks: [
          { name: "Cut", team: TEAM },
          { name: "Polish", team: TEAM },
        ],
      },
    ],
    [
      { n: 9801, lineItems: [item] },
      { n: 9802, started: true, lineItems: [item] },
      { n: 9803, done: true, lineItems: [item] },
      {
        n: 9804,
        started: true,
        blocked: "Waiting on the clasp",
        lineItems: [item],
      },
    ],
  );
  ({ page, frame } = await openApp(browser));
});

test.afterAll(async () => {
  await page.context().close();
});

/** Smoke test: the embedded iframe actually renders our app (not a Shopify login bounce, which would also resolve as an iframe but with no `s-page`). */
test("embedded app home loads", async () => {
  await expect(frame.locator('s-page[heading="Baton"]')).toBeVisible();
});

/** Both capacity meters render: a tile that fails to mount leaves the section looking intact while saying nothing about the plan. The `aria-label` is the tile heading (`CapacityTile`) and is what `plan.billing.spec.ts` reads the entitlement off. */
test("home renders a capacity meter per dimension", async () => {
  for (const label of ["Orders this billing cycle", "Members"])
    await expect(
      frame.locator(`progress[aria-label="${label}"]`),
    ).toBeVisible();
});

/**
 * Inside the embed the foot line's link carries `target="_blank"`, which App
 * Bridge turns into a top-frame redirect that opens a new tab: the admin
 * stays where it is and help opens beside it.
 */
test("home links to help in a new tab", async () => {
  const opened = page.context().waitForEvent("page");
  await frame.locator('s-link[href="/help"][target="_blank"]').click();
  const helpPage = await opened;
  await awaitHydration(helpPage);
  await expect(helpPage).toHaveURL(/\/help$/u);
  await expect(helpPage.locator('s-page[heading="Help"]')).toBeVisible();
  await helpPage.close();
});

/**
 * A cell of the home page's strip: a link whose accessible name is
 * "<label>, <count>" (`Strip`), with no ", selected", since nothing on the
 * home page is chosen.
 */
const homeStripCell = (label: string) =>
  frame.getByRole("link", { name: new RegExp(`^${label}, \\d+$`, "u") });

/** The seeded shop has a team with a member, an active workflow and runs, so every setup fact holds and the guide is left out. */
test("the seeded shop shows no setup guide", async () => {
  await expect(frame.locator('s-page[heading="Baton"]')).toBeVisible();
  await expect(frame.getByText("Getting started", { exact: true })).toHaveCount(
    0,
  );
});

/** The strip on home is the orders index's: the same five cells, in its order, with its labels. */
test("the strip shows five cells with the orders index's labels", async () => {
  for (const key of ORDERS_STRIP)
    await expect(homeStripCell(Domain.ORDERS_SHOW_LABEL[key])).toBeVisible();
  await expect(frame.getByRole("link", { name: /^Issues, 1$/u })).toBeVisible();
});

/**
 * A cell links to the orders index with its value chosen: Issues on home
 * lands on the orders index with `?show=issues`, its Issues cell chosen,
 * and the same count.
 */
test("a strip cell opens the orders index with that value chosen", async () => {
  await homeStripCell("Issues").click();
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("show"))
    .toBe("issues");
  await expect(
    frame.getByRole("button", { name: /^Issues, 1, selected$/u }),
  ).toBeVisible();
});

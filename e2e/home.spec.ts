import { expect, type FrameLocator, type Page, test } from "@playwright/test";

import { openApp } from "./app";
import { awaitHydration } from "./hydration";

test.describe.configure({ mode: "serial" });

let page: Page;
let frame: FrameLocator;

/**
 * One admin boot for the spec (`openApp`). It lands on home and no test here
 * leaves it: the app's Home link is hidden (`rel="home"`), so there is no
 * hoisted link back, and help opens in a tab of its own, which the test
 * closes.
 */
test.beforeAll(async ({ browser }) => {
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

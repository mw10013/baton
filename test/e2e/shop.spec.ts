import { awaitHydration, dev, expect, nextOpenSocket, ownMember, test } from "./fixtures.ts";
import type { Page } from "playwright/test";
import { memberShop, shell, signInWithForm } from "./screens.ts";
import { E2E_SHOP } from "./shop-fixture.ts";
import {
  card,
  closeMembers,
  openRuns,
  rowAction,
  rowLink,
  rowMenu,
  seedRuns,
  stateCount,
  world,
} from "./member-screens.ts";

test.use({ storageState: "playwright/.auth/member.json" });

const path = `/shop/${E2E_SHOP}/workflows`;

test.afterEach(closeMembers);

test("a Done in one window shows in the other window's workflows list", async ({
  backend,
  browser,
}) => {
  const w = world();
  await seedRuns(backend, w, { cutMembers: "maker" });
  const other = await openRuns(browser, w.MAKER, "ready");
  await expect(rowMenu(other, w.RING_ORDER)).toBeEnabled();
  const page = await openRuns(browser, w.MAKER, "ready");
  await expect(card(page, w.RING_ORDER)).toBeVisible();

  await rowAction(page, w.RING_ORDER, "Start");
  await expect(stateCount(page, "Started by you", 1)).toBeVisible();
  await page.goto(`${path}?state=started_by_you`);
  await expect(rowMenu(page, w.RING_ORDER)).toBeEnabled();
  await rowAction(page, w.RING_ORDER, "Done");

  // The other window is never touched: the Done arrives as a notice over its own socket.
  await expect(stateCount(other, "Done or closed", 1)).toBeVisible();
  await expect(rowLink(other, w.RING_ORDER)).toBeHidden();
});

test("sign-out in one window sends the other to sign-in; an admin is untouched", async ({
  backend,
  browser,
}) => {
  const { context, page } = await ownMember(browser, backend, "signout");
  await page.goto(path);
  await awaitHydration(page);
  const other = await context.newPage();
  const opened = nextOpenSocket(other);
  await other.goto(path);
  await awaitHydration(other);
  await opened;

  const adminContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const admin = await adminContext.newPage();
  await signInWithForm(admin, "a@a.com");
  await admin.waitForURL(/\/admin$/);

  await shell(page).signOut.click();

  await other.waitForURL(/\/sign-in/);
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(shell(admin).signOut).toBeVisible();
  await adminContext.close();
  await context.close();
});

test("a member removed while the page is open is told so", async ({ backend, browser }) => {
  const { email, context, page } = await ownMember(browser, backend, "removed");
  const opened = nextOpenSocket(page);
  await page.goto(path);
  await awaitHydration(page);
  await opened;

  await backend(dev((c) => c.RemoveMember({ shop: E2E_SHOP, email })));

  await expect(memberShop(page).noAccess).toBeVisible();
  await context.close();
});

test("a third window displaces the oldest, and Reconnect there takes it back", async ({
  backend,
  browser,
}) => {
  const { context, page: first } = await ownMember(browser, backend, "displaced");
  const open = async (page: Page) => {
    const opened = nextOpenSocket(page);
    await page.goto(path);
    await awaitHydration(page);
    await opened;
    return page;
  };
  await open(first);
  const second = await open(await context.newPage());
  const third = await open(await context.newPage());

  await expect(memberShop(first).signedInElsewhere).toBeVisible();
  await expect(memberShop(second).signedInElsewhere).toHaveCount(0);

  const reopened = nextOpenSocket(first);
  await memberShop(first).reconnect.click();
  await reopened;
  await expect(memberShop(first).signedInElsewhere).toHaveCount(0);
  await expect(memberShop(second).signedInElsewhere).toBeVisible();
  await expect(memberShop(third).signedInElsewhere).toHaveCount(0);
  await context.close();
});

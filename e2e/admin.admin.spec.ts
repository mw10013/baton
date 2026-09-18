import type { Browser, BrowserContext } from "@playwright/test";

import { expect, test } from "@playwright/test";

import { gotoMember, signIn } from "./member";
import { seedConfig } from "./seed";

/**
 * The operator console at `/admin` — not embedded, no App Bridge, no Shopify
 * cookies (the `admin` project supplies empty storage state). Runs against
 * `http://localhost:$PORT`, which is what `BETTER_AUTH_URL` mints magic links
 * against.
 *
 * Read-only by design: nothing here clicks Refresh plan, Destroy, or Sign out.
 * The admin identity therefore persists across runs, which is fine — the dev
 * seed deletes `User` rows only for the member emails it is given.
 *
 * Identity: `ADMIN_EMAIL` must be listed in `ADMIN_EMAILS` (`.env`) before its
 * first sign-in on a given local D1, because `Auth.ts` stamps `role = 'admin'`
 * in the user-create hook and never revisits it. Spot-checked in `beforeAll`
 * so a missing entry fails with a reason instead of a bounce to `/shop`.
 *
 * Signs in once, in `beforeAll`; every test replays that cookie jar into a
 * fresh context. The anonymous tests use the project's empty `page`.
 */

const ADMIN_EMAIL = "e2e.admin@example.com";
const UNKNOWN_SHOP = "e2e-no-such-shop.myshopify.com";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let adminState: StorageState;
const contexts: BrowserContext[] = [];

const adminPage = async (browser: Browser) => {
  const context = await browser.newContext({
    baseURL: seedConfig().appUrl,
    storageState: adminState,
  });
  contexts.push(context);
  return context.newPage();
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const listed = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase());
  if (!listed.includes(ADMIN_EMAIL))
    throw new Error(
      `Admin e2e requires ${ADMIN_EMAIL} in ADMIN_EMAILS (.env); it must be listed before that address first signs in.`,
    );
  const context = await browser.newContext({
    baseURL: seedConfig().appUrl,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await signIn(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/admin$/u);
  adminState = await context.storageState();
  await context.close();
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

test("an anonymous visitor is bounced from /admin to /login", async ({
  page,
}) => {
  await gotoMember(page, "/admin");
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.locator('s-page[heading="Log in"]')).toBeVisible();
});

test("an anonymous visitor is bounced from /admin/shops to /login", async ({
  page,
}) => {
  await gotoMember(page, "/admin/shops");
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.locator('s-page[heading="Log in"]')).toBeVisible();
});

test("the dashboard names the three consoles and links to each", async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await gotoMember(page, "/admin");
  await expect(page.locator('s-page[heading^="Admin v"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  for (const heading of [
    "Shops",
    "Shop Agent Objects",
    "Orphan Shop Agent Objects",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();

  await page.getByRole("button", { name: "View shops" }).click();
  await expect(page).toHaveURL(/\/admin\/shops$/u);
  await expect(page.locator('s-page[heading="Shops"]')).toBeVisible();
});

/**
 * The shops table lists `ShopSession` rows, which exist only where the app is
 * installed. The preview shop's row is present on any machine where the
 * embedded suite has run, so it is asserted when found and skipped on a fresh
 * D1 rather than failed.
 */
test("shops lists installed shops, filters by domain, and drills into one", async ({
  browser,
}) => {
  const { shop } = seedConfig();
  const page = await adminPage(browser);
  await gotoMember(page, "/admin/shops");
  await expect(
    page.locator("s-table-header", { hasText: "Shop Agent ID" }),
  ).toBeVisible();

  /* The search field lives in `s-table`'s filters slot, which Polaris keeps
     hidden until the table paginates; with one installed shop it is not
     fillable. The filter is a search param the field writes on change, so
     driving it by URL exercises the same loader path. */
  await gotoMember(page, `/admin/shops?filter=${shop}`);

  const row = page.locator(`s-table-row[id="${shop}"]`);
  const installed = (await row.count()) > 0;
  test.info().annotations.push({
    type: "installed",
    description: installed ? shop : "not installed on this D1",
  });
  if (!installed) return;

  await row.getByRole("button", { name: shop }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/shop/${shop}$`, "u"));
  await expect(page.locator(`s-page[heading="${shop}"]`)).toBeVisible();
  await expect(page.locator('s-section[heading="Plan"]')).toBeVisible();
  await expect(
    page.locator('s-section[heading="Shopify session"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh plan" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Shops" }).click();
  await expect(page).toHaveURL(/\/admin\/shops$/u);
});

test("a shop with no stored session shows the No session banner", async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await gotoMember(page, `/admin/shop/${UNKNOWN_SHOP}`);
  await expect(page.locator(`s-page[heading="${UNKNOWN_SHOP}"]`)).toBeVisible();
  await expect(page.locator('s-banner[heading="No session"]')).toBeVisible();
});

test("the Shop Agent Objects console renders its table and breadcrumb", async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await gotoMember(page, "/admin/shop-agent-objects");
  await expect(
    page.locator('s-page[heading="Shop Agent Objects"]'),
  ).toBeVisible();
  await expect(
    page.locator("s-table-header", { hasText: "Object ID" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/u);
});

test("the Orphan Shop Agent Objects console renders its table and breadcrumb", async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await gotoMember(page, "/admin/orphan-shop-agent-objects");
  await expect(
    page.locator('s-page[heading="Orphan Shop Agent Objects"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/u);
});

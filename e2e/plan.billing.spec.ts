import { expect, test, type FrameLocator, type Page } from "@playwright/test";

import * as Domain from "@/lib/Domain";

import { appFrame, closeDevConsole, gotoApp } from "./app";
import { awaitHydration } from "./hydration";
import { signIn } from "./member";
import { seedConfig } from "./seed";

/**
 * The one end-to-end test that leaves the app: `/app` → Manage plan →
 * Shopify's hosted pricing page → Select → Approve → back to `/app` with
 * `plan_handle` in the search string, in both directions. What it proves is
 * the return leg: `plan_handle` forces `SubscriptionPlan` to re-read the
 * Partner API instead of serving the 24-hour cached handle, so the ceiling on
 * the Plan card moves. Everything downstream of the resolved plan (member cap,
 * quota banner) is covered headless by the integration tests and
 * `members.spec.ts`; this spec only needs the Shopify round trip.
 *
 * Runs in the `billing` Playwright project and nowhere else, headed and by
 * hand (`pnpm test:e2e:billing`): the pricing page is behind a Cloudflare bot
 * check that challenges a headless browser and cannot be solved in code, so
 * `switchPlan` fails fast with a sentence when it appears instead of a
 * card-not-found timeout. Solve it once in the headed window, or let the store
 * cool down, and rerun.
 *
 * Free of charge because `sandbox-shop-01` is a development store in the same
 * Partner organization as `baton-local`, which makes every public plan $0 for
 * it. It still moves the shared store's real subscription, so whatever plan
 * the store started on is restored in `finally`.
 *
 * The tier is read from the `max` of the home page's orders capacity meter:
 * that attribute is `Domain.entitlementsOfPlan(...).ordersPerCycle` itself, the
 * one number that differs between tiers on that page. It is read off the
 * attribute rather than the text beside it because both the count and the
 * allowance are rendered in `<s-heading>`, whose text Polaris puts behind a
 * shadow slot.
 *
 * The second test pins a Shopify rule Baton relies on: a paid-to-paid
 * downgrade applies at once, not at the end of the cycle. App Pricing defers
 * only a downgrade to a free plan, and Baton has none. Pro to Basic must reach
 * the home page and the Partner API read on the redirect back, and the usage
 * outbox must drain.
 */

/** Must be listed in `ADMIN_EMAILS` before its first sign-in; same identity `admin.admin.spec.ts` uses. */
const ADMIN_EMAIL = "e2e.admin@example.com";

/** Display names from the Partner Dashboard listing (README, "Billing"). UI labels, not entitlements. */
const PLAN_CARD_NAME = { basic: "Basic", pro: "Pro" } as const;

/* `aria-label` is the tile heading (`CapacityTile`), and the meter is the only
   `progress` on the page carrying it. */
const ordersMeter = (frame: FrameLocator) =>
  frame.locator('progress[aria-label="Orders this billing period"]');

const readPlan = async (frame: FrameLocator): Promise<Domain.Plan> => {
  await expect(ordersMeter(frame)).toBeVisible({ timeout: 30_000 });
  const ceiling = Number(await ordersMeter(frame).getAttribute("max"));
  const plan = Domain.Plan.literals.find(
    (candidate) =>
      Domain.entitlementsOfPlan(candidate).ordersPerCycle === ceiling,
  );
  if (plan === undefined)
    throw new Error(
      `Orders meter ceiling not recognized: max=${String(ceiling)}`,
    );
  return plan;
};

const switchPlan = async (
  page: Page,
  target: Domain.Plan,
): Promise<FrameLocator> => {
  const app = appFrame(page);
  await app.getByRole("button", { name: "Manage plan" }).click();
  await expect(page).toHaveURL(/\/charges\/[^/]+\/pricing_plans/u, {
    timeout: 30_000,
  });

  const card = page.getByRole("heading", {
    name: PLAN_CARD_NAME[target],
    exact: true,
  });
  const challenge = page.getByText("connection needs to be verified");
  await expect(card.or(challenge).first()).toBeVisible({ timeout: 30_000 });
  if (await challenge.isVisible())
    throw new Error(
      "Shopify presented a bot-verification challenge on the pricing page; solve it in the headed window or let the store cool down, then rerun.",
    );
  /* On a same-organization development store the page is headed "Free to
     test" and the button reads "Test with this plan"; a live store's would
     read "Select". Only the plan the store is not on has a button, so scope to
     the nearest ancestor of the target's heading that contains one. */
  await card
    .locator(
      'xpath=ancestor::*[.//button[normalize-space(.)="Test with this plan" or normalize-space(.)="Select"]][1]',
    )
    .getByRole("button", { name: /^(?:Test with this plan|Select)$/u })
    .click({ timeout: 30_000 });

  await expect(
    page.getByRole("heading", { name: "Approve charge" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  /* Approve → welcome link `/app?plan_handle=…` → Partner re-read → iframe
     re-hydrate over the quick tunnel: generous on purpose. */
  await page.waitForURL(/\/apps\/[^/]+\/app/u, { timeout: 60_000 });
  const frame = appFrame(page);
  await awaitHydration(frame, 60_000);
  /* The welcome redirect is a full admin load, and the CLI's Dev Console
     comes back expanded with it; left open it outranks the iframe in the hit
     test and swallows the next Manage plan click (`closeDevConsole`). */
  await closeDevConsole(page);
  await expect(ordersMeter(frame)).toHaveAttribute(
    "max",
    String(Domain.entitlementsOfPlan(target).ordersPerCycle),
    { timeout: 60_000 },
  );
  return frame;
};

test("switching plans on Shopify's pricing page moves the ceiling on the Plan card, both ways", async ({
  page,
}) => {
  test.setTimeout(360_000);
  expect(Domain.entitlementsOfPlan("basic").ordersPerCycle).not.toBe(
    Domain.entitlementsOfPlan("pro").ordersPerCycle,
  );

  const start = await readPlan(await gotoApp(page));
  const other: Domain.Plan = start === "pro" ? "basic" : "pro";
  try {
    const frame = await switchPlan(page, other);
    expect(await readPlan(frame)).toBe(other);
    expect(await readPlan(await switchPlan(page, start))).toBe(start);
  } finally {
    if ((await readPlan(await gotoApp(page))) !== start)
      await switchPlan(page, start);
  }
});

/**
 * The operator console's cache fields for one shop, read as `label: value`
 * pairs. Each `Field` renders a `div.admin-field` holding its label and its
 * value, so the pairs come off the DOM without a bespoke test id per row.
 *
 * The match is anchored to the start of the row because one label contains
 * another: `hasText` is a case-insensitive substring, so a bare "Billing
 * period" also matches the "Orders this billing period" row, which renders
 * first and which `.first()` therefore returned — the recording carried the
 * order count under the billing-period key and the real cycle dates were never
 * read. A row's text begins with its own label, so `^` disambiguates. Labels
 * here are plain words; one containing a regex metacharacter would need
 * escaping.
 *
 * The only way to read these fields: the operator console renders them inside
 * shadow DOM, so `innerText` on the page body never sees them and a bare
 * `getByText` finds nothing.
 */
const readAdminFields = async (page: Page, labels: readonly string[]) => {
  const rows: Record<string, string> = {};
  for (const label of labels) {
    const field = page
      .locator("div.admin-field")
      .filter({ hasText: new RegExp(`^${label}`, "u") })
      .first();
    await expect(field).toBeVisible({ timeout: 30_000 });
    rows[label] = ((await field.textContent()) ?? "").replace(label, "").trim();
  }
  return rows;
};

const ADMIN_FIELDS = [
  "Cached plan",
  "Plan boundary",
  "Billing period",
  "Orders this billing period",
  "Usage events pending",
  "Shopify metered quantity",
] as const;

test("a paid-to-paid downgrade applies at once, and the usage outbox drains", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const start = await readPlan(await gotoApp(page));
  try {
    /* Pro to Basic: `switchPlan` already asserts the home page reads Basic on
       the redirect back. */
    if (start !== "pro") await switchPlan(page, "pro");
    await switchPlan(page, "basic");

    const context = await browser.newContext({
      baseURL: seedConfig().appUrl,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const admin = await context.newPage();
      await signIn(admin, ADMIN_EMAIL);
      await admin.goto(`/admin/shop/${seedConfig().shop}`);
      /* Refresh plan, not the cached row: the Partner API itself must report
         Basic now. */
      await admin.getByRole("button", { name: "Refresh plan" }).click();
      const fields = await readAdminFields(admin, ADMIN_FIELDS);
      await testInfo.attach("plan cache after Pro to Basic", {
        body: JSON.stringify(fields, null, 2),
        contentType: "application/json",
      });
      expect(fields["Cached plan"]).toContain("baton-basic");
      expect(fields["Usage events pending"]).toBe("0");
    } finally {
      await context.close();
    }
  } finally {
    if ((await readPlan(await gotoApp(page))) !== start)
      await switchPlan(page, start);
  }
});

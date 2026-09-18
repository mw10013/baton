import { expect, test, type FrameLocator, type Page } from "@playwright/test";

import * as Domain from "@/lib/Domain";

import { appFrame, gotoApp } from "./app";
import { awaitHydration } from "./hydration";

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
 * The tier is read from the Plan card's "Orders this month: n of m" line, the
 * one number that differs between tiers on that page and that comes straight
 * from `Domain.entitlementsOfPlan`; the plan heading is not used because
 * `<s-heading>` renders its text behind a Polaris shadow slot.
 */

/** Display names from the Partner Dashboard listing (README, "Billing"). UI labels, not entitlements. */
const PLAN_CARD_NAME = { basic: "Basic", pro: "Pro" } as const;

const ordersLine = (frame: FrameLocator) =>
  frame.getByText(/^Orders this month: [\d,]+ of [\d,]+$/u);

const readPlan = async (frame: FrameLocator): Promise<Domain.Plan> => {
  await expect(ordersLine(frame)).toBeVisible({ timeout: 30_000 });
  const text = (await ordersLine(frame).textContent()) ?? "";
  const ceiling = Number(
    (/of (?<ceiling>[\d,]+)$/u.exec(text)?.groups?.ceiling ?? "").replaceAll(
      ",",
      "",
    ),
  );
  const plan = Domain.Plan.literals.find(
    (candidate) =>
      Domain.entitlementsOfPlan(candidate).ordersPerMonth === ceiling,
  );
  if (plan === undefined)
    throw new Error(`Plan card ceiling not recognized: ${text}`);
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
  await expect(ordersLine(frame)).toContainText(
    `of ${Domain.entitlementsOfPlan(target).ordersPerMonth.toLocaleString("en-US")}`,
    { timeout: 60_000 },
  );
  return frame;
};

test("switching plans on Shopify's pricing page moves the ceiling on the Plan card, both ways", async ({
  page,
}) => {
  test.setTimeout(360_000);
  expect(Domain.entitlementsOfPlan("basic").ordersPerMonth).not.toBe(
    Domain.entitlementsOfPlan("pro").ordersPerMonth,
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

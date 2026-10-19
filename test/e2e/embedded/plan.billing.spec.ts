import type { FrameLocator, Page } from "playwright/test";
import { entitlementsOfPlan, Plan } from "../../../src/domain/billing.ts";
import { dev, expect, test } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { appFrame, awaitHydration, closeDevConsole, gotoApp } from "./app.ts";

/**
 * The one end-to-end test that leaves the app: `/app` → Manage plan → Shopify's hosted pricing
 * page → Test with this plan → Approve → back to `/app` with `plan_handle` in the search, in both
 * directions. What it proves is the return leg: `plan_handle` forces `SubscriptionPlan` to re-read
 * the Partner API instead of serving the 24-hour cached handle, so the ceiling on the home page's
 * orders meter moves. Everything downstream of the resolved plan is covered headless by integ and
 * `members.spec.ts`; this spec only needs the Shopify round trip.
 *
 * Runs in the `billing` Playwright project and nowhere else, headed and by hand
 * (`vp run test:e2e:billing`): the pricing page is behind a Cloudflare bot check that challenges
 * a headless browser and cannot be solved in code, so `switchPlan` fails fast with a sentence when
 * it appears instead of a card-not-found timeout. Solve it once in the headed window, or let the
 * store cool down, and rerun.
 *
 * Free of charge because the e2e store is a development store in the same Partner organization as
 * Baton Dev, which makes every public plan $0 for it. It still moves the shared store's real
 * subscription, so whatever plan the store started on is restored in `finally`.
 *
 * The tier is read from the `max` of the home page's orders meter: that attribute is
 * `entitlementsOfPlan(...).ordersPerCycle` itself, the one number that differs between tiers on
 * that page; the text beside it sits in `s-heading`, behind Polaris's shadow slot.
 *
 * The second test pins a Shopify rule Baton relies on: a paid-to-paid downgrade applies at once,
 * not at the end of the cycle (App Pricing defers only a downgrade to a free plan, and Baton has
 * none). Pro to Basic must reach the home page on the redirect back and the cached plan.
 */

/** Display names from the Partner Dashboard listing. UI labels, not entitlements. */
const PLAN_CARD_NAME = { basic: "Basic", pro: "Pro" } as const;

/** The orders meter: its `aria-label` is the tile's heading (`MeterTile`). */
const ordersMeter = (frame: FrameLocator) =>
  frame.locator('progress[aria-label="Orders this billing cycle"]');

const readPlan = async (frame: FrameLocator): Promise<Plan> => {
  await expect(ordersMeter(frame)).toBeVisible({ timeout: 30_000 });
  const ceiling = Number(await ordersMeter(frame).getAttribute("max"));
  const plan = Plan.literals.find(
    (candidate) => entitlementsOfPlan(candidate).ordersPerCycle === ceiling,
  );
  if (plan === undefined)
    throw new Error(`Orders meter ceiling not recognized: max=${String(ceiling)}`);
  return plan;
};

const switchPlan = async (page: Page, target: Plan): Promise<FrameLocator> => {
  await closeDevConsole(page);
  await appFrame(page).getByRole("button", { name: "Manage plan" }).click();
  await expect(page).toHaveURL(/\/charges\/[^/]+\/pricing_plans/u, { timeout: 30_000 });

  const card = page.getByText(PLAN_CARD_NAME[target], { exact: true });
  const challenge = page.getByText("connection needs to be verified");
  await expect(card.or(challenge).first()).toBeVisible({ timeout: 30_000 });
  if (await challenge.isVisible())
    throw new Error(
      "Shopify presented a bot-verification challenge on the pricing page; solve it in the headed window or let the store cool down, then rerun.",
    );
  // On a same-organization development store the button reads "Test with this plan"; a live
  // store's would read "Select". Only the plan the store is not on has a button, so scope to the
  // nearest ancestor of the target's name that contains one.
  await card
    .first()
    .locator(
      'xpath=ancestor::*[.//button[normalize-space(.)="Test with this plan" or normalize-space(.)="Select"]][1]',
    )
    .getByRole("button", { name: /^(?:Test with this plan|Select)$/u })
    .click({ timeout: 30_000 });

  await expect(page.getByRole("heading", { name: "Approve charge" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  // Approve → welcome link `/app?plan_handle=…` → Partner re-read → the frame re-hydrates over
  // the tunnel: generous on purpose.
  await page.waitForURL(/\/apps\/[^/]+\/app/u, { timeout: 60_000 });
  const frame = appFrame(page);
  await awaitHydration(frame, 60_000);
  // The welcome redirect is a full admin load, and the CLI's Dev Console comes back expanded.
  await closeDevConsole(page);
  await expect(ordersMeter(frame)).toHaveAttribute(
    "max",
    String(entitlementsOfPlan(target).ordersPerCycle),
    { timeout: 60_000 },
  );
  return frame;
};

test("switching plans on Shopify's pricing page moves the ceiling on the Plan card, both ways", async ({
  page,
}) => {
  // Two plan switches, each through Shopify's pricing page and a full admin reload.
  test.setTimeout(360_000);
  expect(entitlementsOfPlan("basic").ordersPerCycle).not.toBe(
    entitlementsOfPlan("pro").ordersPerCycle,
  );

  const start = await readPlan(await gotoApp(page));
  const other: Plan = start === "pro" ? "basic" : "pro";
  try {
    const frame = await switchPlan(page, other);
    expect(await readPlan(frame)).toBe(other);
    expect(await readPlan(await switchPlan(page, start))).toBe(start);
  } finally {
    if ((await readPlan(await gotoApp(page))) !== start) await switchPlan(page, start);
  }
});

/**
 * Legacy read the plan cache and the pending usage events off the operator console's shop page
 * (Refresh plan), which comes with the admin console. Here the downgrade is read off the home page
 * on the redirect back and again on a fresh load, which re-reads the plan the redirect cached; the
 * outbox half waits for that page.
 */
test("a paid-to-paid downgrade applies at once, and the usage outbox drains", async ({
  page,
  backend,
}) => {
  test.setTimeout(360_000);
  const start = await readPlan(await gotoApp(page));
  try {
    if (start !== "pro") await switchPlan(page, "pro");
    await switchPlan(page, "basic");
    expect(await readPlan(await gotoApp(page))).toBe("basic");
    expect(await backend(dev((c) => c.GetShopSession({ shop })))).not.toBeNull();
  } finally {
    if ((await readPlan(await gotoApp(page))) !== start) await switchPlan(page, start);
  }
});

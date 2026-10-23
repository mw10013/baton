import { expect, test } from "./fixtures.ts";
import { E2E_SHOP } from "./shop-fixture.ts";

test.use({ storageState: "playwright/.auth/admin.json" });

/**
 * The admin console, read-only by design: nothing here presses Refresh plan, Destroy or Sign out.
 * Refresh plan revokes every socket of the shared e2e store when its plan changed, under the
 * embedded specs running beside this one, and Sign out would end the shared admin storage state.
 * Refresh plan is pressed by the billing project alone.
 */
const UNKNOWN_SHOP = "e2e-no-such-shop.myshopify.com";

test("the dashboard names the consoles and links to each", async ({ goto, page }) => {
  await goto("/admin");
  await expect(page.locator('s-page[heading="Admin"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  for (const heading of ["Shops", "Members"])
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View members" }).click();
  await expect(page).toHaveURL(/\/admin\/members$/u);
  await page.goBack();
  await page.getByRole("link", { name: "View shops" }).click();
  await expect(page).toHaveURL(/\/admin\/shops$/u);
  await expect(page.getByRole("columnheader", { name: "Shop actor ID" })).toBeVisible();
});

/**
 * The e2e store is always installed (the `install` setup project), so its row is always there.
 * The filter is driven by URL: the field writes the same search param.
 */
test("shops lists installed shops, filters by domain, and drills into one", async ({
  goto,
  page,
}) => {
  await goto(`/admin/shops?filter=${E2E_SHOP}`);
  const shopLink = page.getByRole("link", { name: E2E_SHOP, exact: true });
  await expect(shopLink).toBeVisible();
  await goto("/admin/shops?filter=e2e-no-such-shop");
  await expect(page.getByText("No sessions.")).toBeVisible();
  await goto(`/admin/shops?filter=${E2E_SHOP}`);
  await shopLink.click();
  await expect(page).toHaveURL(new RegExp(`/admin/shop/${E2E_SHOP.replaceAll(".", "\\.")}$`, "u"));
  await expect(page.locator(`s-page[heading="${E2E_SHOP}"]`)).toBeVisible();
  await expect(page.locator('s-section[heading="Plan"]')).toBeVisible();
  await expect(page.locator('s-section[heading="Shopify session"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh plan" })).toBeVisible();
  // No token reaches the page, only whether each is present.
  expect(await page.content()).not.toMatch(/shpat_|shprt_|"accessToken"|"refreshToken"/u);
  await page.getByRole("link", { name: "Shops", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/shops$/u);
});

test("a shop with no stored session shows the No session banner", async ({ goto, page }) => {
  await goto(`/admin/shop/${UNKNOWN_SHOP}`);
  await expect(page.locator(`s-page[heading="${UNKNOWN_SHOP}"]`)).toBeVisible();
  await expect(page.locator('s-banner[heading="No session"]')).toBeVisible();
});

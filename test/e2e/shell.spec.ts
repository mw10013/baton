import { expect, test } from "./fixtures.ts";
import { shell, signInWithForm } from "./screens.ts";
import { E2E_SHOP } from "./shop-fixture.ts";

test.describe("as a member", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  test("the admin side sends a member home", async ({ goto, page }) => {
    await goto("/admin");
    await expect(page).toHaveURL(/\/shop$/);
  });

  test("the member home lists the member's one shop and opens it", async ({ goto, page }) => {
    await goto("/shop");
    // Polaris renders the link text in a shadow root, so the links are found by accessible name.
    await expect(page.getByRole("link", { name: /\.myshopify\.com$/ })).toHaveCount(1);
    await page.getByRole("link", { name: E2E_SHOP }).click();
    // The shop's root is its workflows list.
    await expect(page).toHaveURL(new RegExp(`/shop/${E2E_SHOP}/workflows$`));
  });
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the member side sends to sign-in and back", async ({ goto, page }) => {
    await goto("/shop");
    await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fshop$/);
  });
});

test.describe("as an admin", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Signing out deletes the session, so this test signs in its own instead of ending the one in
  // the shared admin storage state that other specs run on in parallel.
  test("sign out ends the session", async ({ page }) => {
    await signInWithForm(page, "a@a.com");
    await page.waitForURL(/\/admin$/);
    await shell(page).signOut.click();
    await page.waitForURL(/\/$/);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(await page.context().cookies()).toEqual([]);
  });
});

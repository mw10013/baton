import { expect, test, testEmail } from "./fixtures.ts";
import { memberShop, requestMagicLink, signIn } from "./screens.ts";
import { E2E_SHOP } from "./shop-fixture.ts";

// Inline delivery shows the link on the page; a deployed stage mails it instead.
test("a member signs in with the link the page shows", async ({ goto, page }) => {
  await goto("/sign-in");
  await requestMagicLink(page, "m1@m.com");
  await signIn(page).openLink.click();
  // The e2e store's member belongs to that one store, so the link lands on its workflows list.
  await page.waitForURL(new RegExp(`/shop/${E2E_SHOP}/workflows$`, "u"));
  await expect(memberShop(page).workflows).toBeVisible();
});

/**
 * The invite gate must not double as a member directory: a stranger sees the same "check your
 * email" panel a member sees, and the only difference, no link, is invisible outside inline
 * delivery.
 */
test("a non-member gets the same confirmation and no link", async ({ goto, page }) => {
  await goto("/sign-in");
  await requestMagicLink(page, testEmail("stranger"));
  await expect(signIn(page).checkEmail).toBeVisible();
  await expect(signIn(page).openLink).toBeHidden();
});

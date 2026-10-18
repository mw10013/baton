import { expect, test, testEmail } from "./fixtures.ts";
import { requestMagicLink, signIn } from "./screens.ts";

// Inline delivery shows the link on the page; a deployed stage mails it instead.
test("a member signs in with the link the page shows", async ({ goto, page }) => {
  await goto("/sign-in");
  await requestMagicLink(page, "m1@m.com");
  await signIn(page).openLink.click();
  await page.waitForURL(/\/shop$/);
  await expect(page.getByRole("heading", { name: "Your stores" })).toBeVisible();
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

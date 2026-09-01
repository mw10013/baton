import { expect, test, type Page } from "@playwright/test";

import { followMagicLink, gotoMember } from "./member";
import { seedConfig, seedMembers } from "./seed";

/**
 * The member area outside the Shopify admin — no iframe, no App Bridge, no
 * admin cookies (the `member` project supplies empty storage state). Runs
 * against `http://localhost:$PORT`, which is what `BETTER_AUTH_URL` mints magic
 * links against, so the link demo mode renders is followable in place.
 *
 * Every test seeds first, which also clears `Verification` — a magic link is
 * single-use, so without that reset a retry would re-follow a spent URL.
 *
 * `LOGIN_LIMITER` is 5 sends per 60s and every local request shares the
 * `unknown` IP key. The file spends 3 of those per run, so a second full retry
 * inside the same minute would start seeing the rate-limit banner in place of
 * the expected copy.
 */

const MEMBER_EMAIL = "e2e.member@example.com";
const STRANGER_EMAIL = "e2e.stranger@example.com";

const requestMagicLink = async (page: Page, email: string): Promise<void> => {
  await gotoMember(page, "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send magic link" }).click();
};

test("an anonymous visitor is bounced from the member area to /login", async ({
  page,
}) => {
  await gotoMember(page, "/shop");
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.locator('s-page[heading="Log in"]')).toBeVisible();
});

/**
 * The invite gate must not double as a member directory: a stranger sees the
 * same "check your email" panel a member sees, and the only difference — no
 * link — is invisible outside demo mode.
 */
test("a non-member gets the same confirmation and no link", async ({
  page,
}) => {
  await seedMembers(seedConfig(), [MEMBER_EMAIL]);
  await requestMagicLink(page, STRANGER_EMAIL);
  await expect(
    page.locator('s-section[heading="Check your email"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open your magic link" }),
  ).toBeHidden();
});

test("a seeded member signs in by magic link, opens their shop, and signs out", async ({
  page,
}) => {
  const config = seedConfig();
  await seedMembers(config, [MEMBER_EMAIL]);

  await requestMagicLink(page, MEMBER_EMAIL);
  await followMagicLink(page);

  await expect(page).toHaveURL(/\/shop$/u);
  await expect(page.locator('s-page[heading="Your shops"]')).toBeVisible();
  await expect(
    page.locator(`s-section[heading="${MEMBER_EMAIL}"]`),
  ).toBeVisible();

  await page.getByRole("link", { name: config.shop }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${config.shop}$`, "u"));
  await expect(
    page.getByText(`You have member access to this shop (${config.shop}).`),
  ).toBeVisible();

  await page.getByRole("link", { name: "Back to your shops" }).click();
  await expect(page).toHaveURL(/\/shop$/u);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/localhost:\d+\/$/u);
  await gotoMember(page, "/shop");
  await expect(page).toHaveURL(/\/login$/u);
});

/**
 * Revocation has to bite on the next request, not at the next sign-in: the
 * session cookie stays valid, so only the per-request `requireMember` check
 * stands between a removed member and the shop page. Re-seeding without the
 * member is what removing them on the admin members screen does to the `Member`
 * table.
 */
test("removing a member closes the shop page on their live session", async ({
  page,
}) => {
  const config = seedConfig();
  await seedMembers(config, [MEMBER_EMAIL]);

  await requestMagicLink(page, MEMBER_EMAIL);
  await followMagicLink(page);
  await expect(page.getByRole("link", { name: config.shop })).toBeVisible();

  await seedMembers(config, []);
  await gotoMember(page, `/shop/${config.shop}`);
  await expect(page.getByText("Not Found")).toBeVisible();
  await gotoMember(page, "/shop");
  await expect(page.getByRole("link", { name: config.shop })).toBeHidden();
});

import { expect, test } from "@playwright/test";

import { clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of member access: granting and revoking on
 * `/app/members`. What a member can then *do* with that grant is
 * `member-area.member.spec.ts`, which runs outside the admin entirely.
 *
 * Seeds membership to empty first so the empty state is a real assertion rather
 * than an accident of what a previous run left behind.
 */

const MEMBER_EMAIL = "e2e.member@example.com";
const EMPTY_STATE = "No members yet. Add an email above to grant access.";

test("members screen adds, normalizes, and deletes a member", async ({
  page,
}) => {
  /* `gotoApp` spends 4-6s on a healthy load and each of the mutations below
     re-runs the Shopify auth middleware, so the 30s default leaves no
     headroom: this passes in isolation but times out on the last assertion in a
     full-suite run. Same reason `teams.spec.ts` raises its own. */
  test.setTimeout(90_000);

  await seedMembers(seedConfig(), []);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Members", exact: true }));
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();

  /* Padded and mixed-case on purpose: `Domain.Email` trims and lowercases at
     decode, so the row that comes back is the proof that normalization is
     structural rather than something the login form does on its own. */
  await frame.getByLabel("Email").fill("  E2E.Member@Example.COM  ");
  await frame.getByRole("button", { name: "Add member" }).click();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toBeVisible();

  await frame.getByLabel("Email").fill(MEMBER_EMAIL);
  await frame.getByRole("button", { name: "Add member" }).click();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toHaveCount(1);

  /* Delete confirms inline, then the row is gone for good; re-adding the
     email mints a fresh row. */
  await frame.getByRole("button", { name: "Delete", exact: true }).click();
  /* Polaris renders the banner heading twice (one visually hidden), so match
     the host element's attribute like the `s-page` checks do. */
  await expect(
    frame.locator(`s-banner[heading="Delete ${MEMBER_EMAIL}?"]`),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "Delete", exact: true })
    .last()
    .click();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();

  await frame.getByLabel("Email").fill(MEMBER_EMAIL);
  await frame.getByRole("button", { name: "Add member" }).click();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toBeVisible();
});

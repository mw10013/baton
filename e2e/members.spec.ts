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

test("members screen adds, normalizes, and removes a member", async ({
  page,
}) => {
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

  await frame.getByRole("button", { name: "Remove" }).click();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();
});

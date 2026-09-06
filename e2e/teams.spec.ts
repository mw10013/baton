import { expect, test } from "@playwright/test";

import { clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of teams: creating, renaming, staffing, and deleting on
 * `/app/teams`. What a member then sees of their teams is
 * `member-area.member.spec.ts`, which runs outside the admin entirely.
 *
 * Seeds one member and zero teams first, so both empty states are real
 * assertions rather than an accident of what a previous run left behind.
 *
 * The 30s default test budget is too tight: `gotoApp` alone spends 4-6s on a
 * healthy load (15s before its reload rescue fires), and this spec then makes
 * eight round trips through server functions that each re-run the Shopify auth
 * middleware. A cold `/app/teams` module — Vite compiles route modules on
 * demand, so the first navigation after an edit pays for it — has exhausted the
 * default before the page ever renders.
 */

const MEMBER_EMAIL = "e2e.member@example.com";
const EMPTY_STATE = "No teams yet. Create one above.";
const TEAM = "E2E Cut";
const RENAMED = "E2E Cutting";

test("teams screen creates, staffs, renames, and deletes a team", async ({
  page,
}) => {
  test.setTimeout(90_000);

  await seedMembers(seedConfig(), [MEMBER_EMAIL]);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Teams", exact: true }));
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();

  /* Padded on purpose: `Domain.TeamName` trims at decode, so the row that comes
     back is the proof that normalization is structural rather than something
     the create form does on its own. */
  await frame.getByLabel("Name").fill(`  ${TEAM}  `);
  await frame.getByRole("button", { name: "Create team" }).click();
  await expect(frame.getByRole("link", { name: TEAM })).toBeVisible();

  /* Case-insensitive uniqueness is a unique index, not a pre-check, so the
     duplicate has to come back as the merchant-facing banner rather than as a
     raw constraint error. */
  await frame.getByLabel("Name").fill(TEAM.toLowerCase());
  await frame.getByRole("button", { name: "Create team" }).click();
  await expect(
    frame.getByText("A team with that name already exists."),
  ).toBeVisible();

  await frame.getByRole("link", { name: TEAM }).click();
  await expect(frame.locator(`s-page[heading="${TEAM}"]`)).toBeVisible();

  await frame.getByLabel(MEMBER_EMAIL).check();
  await frame.getByLabel("Name").fill(RENAMED);
  await frame.getByRole("button", { name: "Save" }).click();
  await expect(frame.locator(`s-page[heading="${RENAMED}"]`)).toBeVisible();
  await expect(frame.getByLabel(MEMBER_EMAIL)).toBeChecked();

  await clickHoisted(page.getByRole("link", { name: "Teams", exact: true }));
  await expect(frame.getByRole("link", { name: RENAMED })).toBeVisible();

  /* A fresh team has nobody on it until staffed; this one was staffed above,
     so the badge must be absent, and the delete dialog names no steps. */
  await expect(frame.getByText("No members", { exact: true })).toHaveCount(0);
  await frame.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    frame.locator(`s-banner[heading="Delete ${RENAMED}?"]`),
  ).toBeVisible();
  await expect(
    frame.getByText("No workflow steps are assigned to it."),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "Delete", exact: true })
    .last()
    .click();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();
});

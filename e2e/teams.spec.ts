import { expect, test } from "@playwright/test";

import { clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of teams: creating, renaming, staffing, and archiving on
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

test("teams screen creates, staffs, renames, and archives a team", async ({
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

  /* Archiving is the merchant-facing delete: the team leaves the default list
     but stays resolvable behind the toggle, which is what keeps historical
     work readable. */
  await frame.getByRole("button", { name: "Archive" }).click();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();
  await frame.getByLabel("Show archived").check();
  await expect(frame.getByRole("link", { name: RENAMED })).toBeVisible();
  /* `exact` matters: "Show archived" and the section's own copy both contain
     the word, so a substring match is a strict-mode violation, not a badge. */
  await expect(frame.getByText("Archived", { exact: true })).toBeVisible();

  await frame.getByRole("button", { name: "Restore" }).click();
  await frame.getByLabel("Show archived").uncheck();
  await expect(frame.getByRole("link", { name: RENAMED })).toBeVisible();
});

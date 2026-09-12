import { expect, type FrameLocator, test } from "@playwright/test";

import { clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of teams: creating, staffing, renaming, and deleting on
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

/**
 * A More actions menu item. The title-bar button is hoisted into the admin
 * chrome, and neither a synthetic click nor a forced pointer click on it opens
 * a menu Playwright can see in either document (probed 2026-09-12), so the
 * item is driven at its source: the in-frame `s-button` inside the `s-menu`
 * still exists, hidden, and a native click on it fires its `commandFor`
 * exactly as the host's menu would. The modal it opens is what gets asserted.
 */
const clickMenuItem = (frame: FrameLocator, name: string) =>
  frame
    .locator("s-menu#team-actions s-button", { hasText: name })
    .evaluate((el) => {
      (el as HTMLElement).click();
    });

const MEMBER_EMAIL = "e2e.member@example.com";
const EMPTY_STATE = "No teams yet.";
const TEAM = "E2E Cut";
const RENAMED = "E2E Cutting";

test("teams screen creates, staffs, renames, and deletes a team", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await seedMembers(seedConfig(), [MEMBER_EMAIL]);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Teams", exact: true }));
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();

  /* Padded on purpose: `Domain.TeamName` trims at decode, so the heading that
     comes back is the proof that normalization is structural rather than
     something the create dialog does on its own. Creating lands on the new
     team's page, since the next thing is always adding people. */
  await frame.getByRole("button", { name: "Create team" }).click();
  await frame
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(`  ${TEAM}  `);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${TEAM}"]`)).toBeVisible();
  await expect(frame.getByText("Not used by any workflow yet.")).toBeVisible();
  await expect(frame.getByText("Nobody is on this team")).toBeVisible();

  /* Case-insensitive uniqueness is a unique index, not a pre-check, so the
     duplicate has to come back as the field error in the dialog rather than
     as a raw constraint error. */
  await clickHoisted(page.getByRole("link", { name: "Teams", exact: true }));
  await expect(frame.getByRole("link", { name: TEAM })).toBeVisible();
  /* With teams present the Create button is the title-bar primary action,
     hoisted into the admin chrome by App Bridge (see `clickHoisted`); the
     modal itself stays in the frame. */
  await clickHoisted(page.getByRole("button", { name: "Create team" }));
  await frame
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(TEAM.toLowerCase());
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    frame.getByText("A team with that name already exists."),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Cancel" }).click();

  /* Search filters client-side; a miss shows the clear-filters state. Typed
     key by key: Polaris forwards native `input` events into its `onInput`,
     and `fill` can land as one value swap the element does not report. */
  await frame
    .getByRole("searchbox", { name: "Search teams by name" })
    .pressSequentially("zzz");
  await expect(frame.getByText("No teams match.")).toBeVisible();
  await frame.getByRole("button", { name: "Clear filters" }).click();
  await frame.getByRole("link", { name: TEAM }).click();
  await expect(frame.locator(`s-page[heading="${TEAM}"]`)).toBeVisible();

  /* Add members opens the App Bridge picker, which the admin host renders in
     the top-level document, not in the app iframe. The empty-team box carries
     its own in-frame Add members button (the title-bar one is hoisted); the
     picker is located by its heading on `page`, and its rows by text. */
  await frame.getByRole("button", { name: "Add members" }).click();
  const picker = page.getByRole("dialog").filter({
    hasText: `Add members to ${TEAM}`,
  });
  await expect(picker).toBeVisible();
  await picker.getByText(MEMBER_EMAIL).click();
  await picker.getByRole("button", { name: /^(?:Add|Select|Done)$/u }).click();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toBeVisible();

  /* Rename lives behind More actions and the name is the page heading. */
  await clickMenuItem(frame, "Rename");
  await frame.getByRole("textbox", { name: "Name", exact: true }).fill(RENAMED);
  await frame.getByRole("button", { name: "Save" }).click();
  await expect(frame.locator(`s-page[heading="${RENAMED}"]`)).toBeVisible();

  /* Remove confirms in a modal; the last member gets the empty-team sentence. */
  await frame.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    frame.getByText(`${RENAMED} will have no members.`),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "Remove", exact: true })
    .last()
    .click();
  await expect(frame.getByText("Nobody is on this team")).toBeVisible();

  await clickMenuItem(frame, "Delete");
  await expect(
    frame.getByText("No workflow steps are assigned to it."),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "Delete", exact: true })
    .last()
    .click();
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();
});

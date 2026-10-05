import { expect, test } from "@playwright/test";

import * as Domain from "@/lib/Domain";

import { appNavLink, clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of member access: granting, putting on teams, and revoking on
 * `/app/members`. What a member can then *do* with that grant is
 * `member-area.member.spec.ts`, which runs outside the admin entirely.
 *
 * Seeds membership to empty (and one empty team, for the checklist) first so
 * the empty state is a real assertion rather than an accident of what a
 * previous run left behind.
 */

const MEMBER_EMAIL = "e2e.member@example.com";
const TEAM = "Engraving";
const EMPTY_STATE = "No members yet";

test("members screen adds, puts on teams, normalizes, and removes a member", async ({
  page,
}) => {
  /* `gotoApp` spends 4-6s on a healthy load and each of the mutations below
     re-runs the Shopify auth middleware, so the 30s default leaves no
     headroom: this passes in isolation but times out on the last assertion in a
     full-suite run. Same reason `teams.spec.ts` raises its own. */
  test.setTimeout(120_000);

  await seedMembers(seedConfig(), [], [{ name: TEAM, members: [] }]);

  const frame = await gotoApp(page);
  /* Both dialogs render the same team checklist, so a bare `getByLabel(TEAM)`
     is ambiguous; scope to the modal in play. */
  const addModal = frame.locator("#add-member");
  const editModal = frame.locator("#edit-member-teams");
  await clickHoisted(appNavLink(page, "Members"));
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();

  /* Padded and mixed-case on purpose: `Domain.Email` trims and lowercases at
     decode, so the row that comes back is the proof that normalization is
     structural rather than something the dialog does on its own. The team
     checked in the dialog shows as a chip on the row. */
  await frame.getByRole("button", { name: "Add member" }).click();
  await frame
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("  E2E.Member@Example.COM  ");
  await addModal.getByLabel(TEAM).check();
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toBeVisible();
  await expect(frame.locator("s-chip", { hasText: TEAM })).toBeVisible();

  /* Re-adding is idempotent for the row, and an empty team selection leaves
     their teams alone: one row, chip still there. Once the list is non-empty
     the Add member button is the title-bar primary action, hoisted into the
     admin chrome by App Bridge (see `clickHoisted`). */
  await clickHoisted(page.getByRole("button", { name: "Add member" }));
  await frame
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(MEMBER_EMAIL);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toHaveCount(1);
  await expect(frame.locator("s-chip", { hasText: TEAM })).toBeVisible();

  /* Edit teams replaces the whole set; unchecking the only team shows the
     "No teams" badge, re-checking brings the chip back. */
  await frame.getByRole("button", { name: "Edit teams" }).click();
  /* The modal is headed `Teams`; the member's email is the body's first line. */
  await expect(
    editModal.getByText(MEMBER_EMAIL, { exact: true }),
  ).toBeVisible();
  await editModal.getByLabel(TEAM).uncheck();
  await frame.getByRole("button", { name: "Save" }).click();
  await expect(frame.getByText("No teams", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Edit teams" }).click();
  await editModal.getByLabel(TEAM).check();
  await frame.getByRole("button", { name: "Save" }).click();
  await expect(frame.locator("s-chip", { hasText: TEAM })).toBeVisible();

  /* Remove confirms in a modal that names the team the delete would empty,
     then the row is gone for good. */
  await frame.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    frame.getByText(`This will leave ${TEAM} with no members.`),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "Remove", exact: true })
    .last()
    .click();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();
});

/**
 * Seats past the plan's included count are billed, not refused. The seed
 * writes one more member than the widest tier includes, so the shop is past
 * its included seats whichever plan the dev store holds, and still under
 * `Domain.ShopLimits.maxMembers` after the add. The home page's Members tile
 * is where the merchant is told the extra seats are billed.
 */
test("adding a member past the included seats succeeds and the home tile says it is billed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = Array.from(
    { length: Domain.MAX_ENTITLEMENTS.membersIncluded + 1 },
    (_, index) => `e2e.seat${String(index).padStart(2, "0")}@example.com`,
  );
  expect(seeded.length).toBeLessThan(Domain.ShopLimits.maxMembers);
  await seedMembers(seedConfig(), seeded, []);

  const frame = await gotoApp(page);
  await expect(
    frame.getByText(/past your plan's included seats/u),
  ).toBeVisible();
  await clickHoisted(appNavLink(page, "Members"));
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
  await expect(frame.getByText(seeded[0] ?? "", { exact: true })).toBeVisible();

  await clickHoisted(page.getByRole("button", { name: "Add member" }));
  await frame
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(MEMBER_EMAIL);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toBeVisible();
});

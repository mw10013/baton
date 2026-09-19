import { expect, test } from "@playwright/test";

import * as Domain from "@/lib/Domain";

import { clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of member access: granting, staffing, and revoking on
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

test("members screen adds, staffs, normalizes, and removes a member", async ({
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
  await clickHoisted(page.getByRole("link", { name: "Members", exact: true }));
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
  await expect(frame.getByText(`Teams for ${MEMBER_EMAIL}`)).toBeVisible();
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
 * The plan's member cap, asserted at the surface a merchant sees. The seed
 * writes `Domain.MAX_ENTITLEMENTS.maxMembers` rows (it bypasses the cap on
 * purpose: `api.dev.seed` has no plan to resolve), which is at or over every
 * tier's ceiling, so the next add is refused whichever plan the store is on.
 * The number in the copy is therefore matched, not asserted: what this test
 * pins is that `MemberLimitError` becomes the banner sentence rather than a
 * 500, and that no row was written.
 */
test("adding a member past the plan's cap is refused with the plan's ceiling", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = Array.from(
    { length: Domain.MAX_ENTITLEMENTS.maxMembers },
    (_, index) => `e2e.cap${String(index)}@example.com`,
  );
  await seedMembers(seedConfig(), seeded, []);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Members", exact: true }));
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
  await expect(frame.getByText(seeded[0] ?? "", { exact: true })).toBeVisible();

  await clickHoisted(page.getByRole("button", { name: "Add member" }));
  await frame
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(MEMBER_EMAIL);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    frame.getByText(
      /Your plan allows [\d,]+ members?\. Upgrade to add more\./u,
    ),
  ).toBeVisible();
  await expect(frame.getByText(MEMBER_EMAIL, { exact: true })).toHaveCount(0);
});

/**
 * Derived seats at the surface. The seed writes two more members than the
 * widest tier grants, so the shop is over its seats whichever plan the store
 * holds, and the seat count is read back out of the banner rather than assumed:
 * `Domain.memberHasSeat` is derived from the plan in force, and a test that
 * hard-coded a tier would pass or fail on which plan the dev store happens to
 * be subscribed to.
 */
test("a shop over its seats badges the members without one and says how to fix it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = Array.from(
    { length: Domain.MAX_ENTITLEMENTS.maxMembers + 2 },
    (_, index) => `e2e.seat${String(index).padStart(2, "0")}@example.com`,
  );
  await seedMembers(seedConfig(), seeded, []);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Members", exact: true }));
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();

  const banner = frame.getByText(
    /Your plan includes [\d,]+ members\. Only the [\d,]+ oldest can sign in until you remove members or upgrade\./u,
  );
  await expect(banner).toBeVisible();
  const seats = Number(
    /includes (?<seats>[\d,]+) members/u
      .exec((await banner.textContent()) ?? "")
      ?.groups?.seats.replaceAll(",", "") ?? "",
  );
  expect(seats).toBeGreaterThan(0);
  /* The badge is on the newest rows, so the count is the overflow exactly. */
  await expect(frame.getByText("No seat", { exact: true })).toHaveCount(
    seeded.length - seats,
  );
});

import { expect, test } from "@playwright/test";

import * as Domain from "@/lib/Domain";

import { appNavLink, clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of member access: adding a member on the members
 * index, putting them on teams and taking them off on the member page, and
 * deleting them there. What a member can then *do* with that grant is
 * `member-area.member.spec.ts`, which runs outside the admin entirely.
 *
 * Seeds membership to empty (and two empty teams, for Add to teams) first so
 * the empty state is a real assertion rather than an accident of what a
 * previous run left behind.
 */

const MEMBER_EMAIL = "e2e.member@example.com";
const TEAMS = ["Engraving", "Polishing"] as const;
const EMPTY_STATE = "No members yet";

/** An address of exactly `length` characters. */
const emailOfLength = (length: number) =>
  `${"a".repeat(length - "@example.com".length)}@example.com`;

test("the members index adds a member and the member page adds it to teams, removes it, and deletes it", async ({
  page,
}) => {
  /* `gotoApp` spends 4-6s on a healthy load and each of the mutations below
     re-runs the Shopify auth middleware, so the 30s default leaves no
     headroom. Same reason `teams.spec.ts` raises its own. */
  test.setTimeout(120_000);

  await seedMembers(
    seedConfig(),
    [],
    TEAMS.map((name) => ({ name, members: [] })),
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Members"));
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();

  /* Padded and mixed-case on purpose: `Domain.Email` trims and lowercases at
     decode, so the heading that comes back is the proof that normalization
     is structural rather than something the dialog does on its own. Add
     asks for the email only and lands on the member page. */
  await frame.getByRole("button", { name: "Add member" }).click();
  await frame
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("  E2E.Member@Example.COM  ");
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    frame.locator(`s-page[heading="${MEMBER_EMAIL}"]`),
  ).toBeVisible();
  await expect(frame.getByText("Not on a team yet")).toBeVisible();

  /* Add to teams lists the candidates; below six there is no search. The
     empty state's own button opens it (the title-bar one is hoisted). */
  await frame.getByRole("button", { name: "Add to teams" }).click();
  const addDialog = frame.locator("s-modal#add-member-teams");
  for (const team of TEAMS)
    await addDialog.getByRole("checkbox", { name: team }).check();
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  for (const team of TEAMS)
    await expect(
      frame.locator("s-table-cell").getByRole("link", { name: team }),
    ).toBeVisible();

  /* Remove takes the member off one team at once, with no modal: Add to
     teams puts them back on this screen. */
  await frame
    .getByRole("button", { name: "Remove", exact: true })
    .first()
    .click();
  await expect(
    frame.locator("s-table-cell").getByRole("link", { name: TEAMS[0] }),
  ).toBeHidden();
  await expect(
    frame.locator("s-table-cell").getByRole("link", { name: TEAMS[1] }),
  ).toBeVisible();

  /* The index shows a count, not the names. */
  await clickHoisted(appNavLink(page, "Members"));
  const row = frame.locator("s-table-row", { hasText: MEMBER_EMAIL });
  await expect(row.locator("s-table-cell").nth(1)).toHaveText("1");
  await frame.getByRole("link", { name: MEMBER_EMAIL }).click();
  await expect(
    frame.locator(`s-page[heading="${MEMBER_EMAIL}"]`),
  ).toBeVisible();

  /* Delete is a title-bar button; its modal is headed "Delete member?" and
     names the email in its body. */
  await clickHoisted(page.getByRole("button", { name: "Delete", exact: true }));
  const deleteDialog = frame.locator("s-modal#delete-member");
  await expect(
    deleteDialog.getByText(MEMBER_EMAIL, { exact: true }),
  ).toBeVisible();
  await expect(deleteDialog.getByText(/This can't be undone\./u)).toBeVisible();
  await deleteDialog
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
  await expect(
    page.locator("#admin-next-toast-viewport").getByText("Member deleted"),
  ).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();
});

/**
 * The email cap (`Domain.EMAIL_MAX_LENGTH`): an address of 254 characters is
 * added, heads its page, and prints whole in the Details card. The field
 * sets no `maxLength` (the text-limit control): a 255-character address
 * stays in the field and Add refuses it with the field's own error; the
 * schema's refusal behind it is pinned by the integration test
 * "an email over 254 characters is refused and never stored". The added
 * member is deleted at the end, since the seeded member count is pinned
 * elsewhere.
 */
test("a 254-character email is added and printed whole, and 255 is refused on Add", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedMembers(seedConfig(), [], []);
  const longest = emailOfLength(Domain.EMAIL_MAX_LENGTH);
  const tooLong = emailOfLength(Domain.EMAIL_MAX_LENGTH + 1);

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Members"));
  await frame.getByRole("button", { name: "Add member" }).click();
  const field = frame.getByRole("textbox", { name: "Email", exact: true });
  await field.fill(tooLong);
  await expect(field).toHaveValue(tooLong);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.getByText("Up to 254 characters")).toBeVisible();

  await field.fill(longest);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${longest}"]`)).toBeVisible();
  await expect(
    frame.locator('s-section[heading="Details"]').getByText(longest, {
      exact: true,
    }),
  ).toBeVisible();

  await clickHoisted(page.getByRole("button", { name: "Delete", exact: true }));
  await frame
    .locator("s-modal#delete-member")
    .getByRole("button", { name: "Delete", exact: true })
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
  await expect(
    frame.locator(`s-page[heading="${MEMBER_EMAIL}"]`),
  ).toBeVisible();
});

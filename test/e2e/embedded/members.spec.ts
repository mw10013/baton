import type { BrowserContext, FrameLocator, Page } from "playwright/test";
import * as Schema from "effect/Schema";

import { EMAIL_MAX_LENGTH } from "../../../src/domain/platform.ts";
import { dev, expect, test, testEmail } from "../fixtures.ts";
import { E2E_SHOP as shop, E2eEmail, teamName } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The embedded half of member access on the e2e store: adding a member on the members index,
 * putting them on teams and taking them off on the member page, and deleting them there. The
 * specs run in parallel on one store, so each test works on its own address ({@link testEmail})
 * and its own teams (named from the test id, added with `AddToFixture`), finds its member through
 * the index's search, and asserts on nothing it did not add.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;

test.beforeAll(async ({ browser }) => {
  ({ context, page } = await openApp(browser));
});

test.afterAll(async () => {
  await context.close();
});

/** The App nav's link to `name`, hoisted into the admin's chrome. */
const openScreen = (name: "Members" | "Teams") =>
  page.getByRole("link", { name, exact: true }).click();

/** A toast App Bridge shows in the admin's own document, outside the app's frame. */
const toast = (text: string) => page.getByText(text, { exact: true });

/** Searches the members index for `email`, so the row is on the page whatever else the store has. */
const searchMembers = async (email: string) => {
  const search = frame.getByRole("searchbox", { name: "Search" });
  await search.fill(email);
  await search.press("Enter");
};

test("the members index adds a member and the member page adds it to teams, removes it, and deletes it", async ({
  backend,
}) => {
  const email = testEmail("member");
  // The test id's tail: a team name is at most 32 characters (`TEAM_NAME_MAX_LENGTH`).
  const id = test.info().testId.slice(-8);
  const teams = [`Engraving ${id}`, `Polishing ${id}`] as const;
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: {
          members: [],
          teams: teams.map((name) => ({ name: teamName(name), members: [] })),
          workflows: [],
          orders: [],
        },
      }),
    ),
  );

  frame = await gotoApp(page, "app/members");
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();

  // Padded and upper-cased on purpose: `Email` trims and lowercases at decode, so the heading
  // that comes back is the proof that normalization is structural. Add asks for the email only
  // and lands on the member page.
  await page.getByRole("button", { name: "Add member" }).click();
  await frame
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`  ${email.toUpperCase()}  `);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${email}"]`)).toBeVisible();
  await expect(frame.getByText("Not on a team yet")).toBeVisible();

  // Add to teams lists the candidates. The empty state's own button opens it (the title-bar one
  // is hoisted).
  await frame.getByRole("button", { name: "Add to teams" }).click();
  const addDialog = frame.locator("s-modal#add-member-teams");
  for (const team of teams) await addDialog.getByRole("checkbox", { name: team }).check();
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  for (const team of teams)
    await expect(frame.locator("s-table-cell").getByRole("link", { name: team })).toBeVisible();

  // Remove takes the member off one team at once, with no modal: Add to teams puts them back on
  // this screen.
  await frame.getByRole("button", { name: "Remove", exact: true }).first().click();
  await expect(frame.locator("s-table-cell").getByRole("link", { name: teams[0] })).toBeHidden();
  await expect(frame.locator("s-table-cell").getByRole("link", { name: teams[1] })).toBeVisible();

  // The index shows a count, not the names.
  await openScreen("Members");
  await searchMembers(email);
  const row = frame.locator("s-table-row", { hasText: email });
  await expect(row.locator("s-table-cell").nth(1)).toHaveText("1");
  await frame.getByRole("link", { name: email }).click();
  await expect(frame.locator(`s-page[heading="${email}"]`)).toBeVisible();

  // Delete member is a title-bar button; its modal is headed "Delete member?" and names the
  // email in its body.
  await page.getByRole("button", { name: "Delete member", exact: true }).click();
  const deleteDialog = frame.locator("s-modal#delete-member");
  await expect(deleteDialog.getByText(email, { exact: true })).toBeVisible();
  await expect(deleteDialog.getByText(/This can't be undone\./u)).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
  await expect(toast("Member deleted")).toBeVisible();
  await searchMembers(email);
  await expect(frame.getByText("No members match.")).toBeVisible();
});

/**
 * The email cap (`EMAIL_MAX_LENGTH`): an address of 254 characters is added, heads its page, and
 * prints whole in the Details card. The field sets no `maxLength` (the text-limit rule on
 * `TextLimit`): a 255-character address stays in the field and Add refuses it with the field's
 * own error; the schema's refusal behind it is pinned by the unit test "an email over 254
 * characters is refused and never stored". The added member is deleted at the end.
 */
test("a 254-character email is added and printed whole, and 255 is refused on Add", async () => {
  const own = testEmail("long");
  /** The test's own address padded to exactly `length` characters. */
  const ofLength = (length: number) =>
    Schema.decodeUnknownSync(E2eEmail)(`${"a".repeat(length - own.length)}${own}`);
  const longest = ofLength(EMAIL_MAX_LENGTH);
  const tooLong = `a${longest}`;

  frame = await gotoApp(page, "app/members");
  await page.getByRole("button", { name: "Add member" }).click();
  const field = frame.getByRole("textbox", { name: "Email", exact: true });
  await field.fill(tooLong);
  await expect(field).toHaveValue(tooLong);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.getByText("Up to 254 characters")).toBeVisible();

  await field.fill(longest);
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${longest}"]`)).toBeVisible();
  await expect(
    frame.locator('s-section[heading="Details"]').getByText(longest, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete member", exact: true }).click();
  await frame
    .locator("s-modal#delete-member")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(frame.locator('s-page[heading="Members"]')).toBeVisible();
});

import type { BrowserContext, FrameLocator, Page } from "playwright/test";
import * as Schema from "effect/Schema";

import { TEAM_NAME_MAX_LENGTH } from "../../../src/domain/shop-work.ts";
import { dev, expect, test, testEmail } from "../fixtures.ts";
import { E2E_SHOP as shop, E2eEmail } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The embedded half of teams on the e2e store: creating, adding members to, renaming, and
 * deleting on `/app/teams`, and the team page's paging. The specs run in parallel on one store,
 * so each test names its teams and members from its test id, finds its team through the index's
 * search, and asserts on nothing it did not add.
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

/** The test id's tail, short enough for a team name (`TEAM_NAME_MAX_LENGTH`). */
const shortId = () => test.info().testId.slice(-8);

/**
 * A More actions menu item. The title-bar button is hoisted into the admin chrome, and neither a
 * synthetic click nor a forced pointer click on it opens a menu Playwright can see in either
 * document, so the item is driven at its source: the in-frame `s-button` inside the `s-menu`
 * still exists, hidden, and a native click on it fires its `commandFor` exactly as the host's
 * menu would. The modal it opens is what gets asserted.
 */
const clickMenuItem = (name: string) =>
  frame.locator("s-menu#team-actions s-button", { hasText: name }).evaluate((el) => {
    (el as HTMLElement).click();
  });

/** Searches the teams index for `name`, submitted on Enter. */
const searchTeams = async (name: string) => {
  const search = frame.getByRole("searchbox", { name: "Search" });
  await search.fill(name);
  await search.press("Enter");
};

/** Opens the team called `name` from the teams index, through its search. */
const openTeam = async (name: string) => {
  await searchTeams(name);
  await frame.getByRole("link", { name, exact: true }).click();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
};

test("teams screen creates, adds members to, renames, and deletes a team", async ({ backend }) => {
  const member = testEmail("teams");
  const team = `E2E Cut ${shortId()}`;
  const renamed = `E2E Cutting ${shortId()}`;
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: { members: [member], teams: [], workflows: [], orders: [] },
      }),
    ),
  );

  frame = await gotoApp(page, "app/teams");
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();

  // Padded on purpose: `TeamName` trims at decode, so the heading that comes back is the proof
  // that normalization is structural. Creating lands on the new team's page, since the next
  // thing is always adding people. A one-line field shows no counter and refuses past its cap on
  // submit with its own error (`TextLimit`).
  await page.getByRole("button", { name: "Create team" }).click();
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  await nameField.fill("x".repeat(TEAM_NAME_MAX_LENGTH + 1));
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.getByText("Up to 32 characters")).toBeVisible();
  await nameField.fill(`  ${team}  `);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${team}"]`)).toBeVisible();
  await expect(frame.getByText("Nobody is on this team")).toBeVisible();

  // Uniqueness is a unique constraint, not a pre-check, so the duplicate has to come back as the
  // field error in the dialog rather than as a raw constraint error.
  await page.getByRole("link", { name: "Teams", exact: true }).click();
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await page.getByRole("button", { name: "Create team" }).click();
  await frame.getByRole("textbox", { name: "Name", exact: true }).fill(team);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.getByText("A team with that name already exists.")).toBeVisible();
  await frame.getByRole("button", { name: "Cancel" }).click();
  await expect(frame.getByText("A team with that name already exists.")).toBeHidden();

  // The search reads every team, submitted on Enter; a miss shows the clear-search state.
  await searchTeams(`zzz ${shortId()}`);
  await expect(frame.getByText("No teams match.")).toBeVisible();
  await frame.getByRole("button", { name: "Clear search" }).click();
  await openTeam(team);

  // Add members is our own `s-modal`, in the frame. The empty-team box carries its own Add
  // members button (the title-bar one is hoisted).
  await frame.getByRole("button", { name: "Add members" }).click();
  const addDialog = frame.locator("s-modal#add-team-members");
  await expect(addDialog.getByText(`Add members to ${team}`)).toBeVisible();
  await addDialog.getByRole("checkbox", { name: member }).check();
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(frame.locator("s-table-cell").getByText(member, { exact: true })).toBeVisible();

  // Rename lives behind More actions and the name is the page heading.
  await clickMenuItem("Rename");
  await frame.getByRole("textbox", { name: "Name", exact: true }).fill(renamed);
  await frame.getByRole("button", { name: "Save" }).click();
  await expect(frame.locator(`s-page[heading="${renamed}"]`)).toBeVisible();

  // Remove takes the member off at once, with no modal: Add members puts them back on this
  // screen.
  await frame.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(frame.getByText("Nobody is on this team")).toBeVisible();

  await clickMenuItem("Delete");
  const deleteDialog = frame.locator("s-modal#delete-team");
  await expect(deleteDialog.getByText("This can't be undone.")).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await expect(page.getByText("Team deleted", { exact: true })).toBeVisible();
  await searchTeams(renamed);
  await expect(frame.getByText("No teams match.")).toBeVisible();
});

/**
 * The team page pages its members table from the server: Previous after Next is the browser's
 * Back. Eleven members: one past a details page of ten, each the test's own address.
 */
test("the team page pages its members", async ({ backend }) => {
  const { testId, retry } = test.info();
  const pagesTeam = `E2E Pages ${shortId()}`;
  const members = Array.from({ length: 11 }, (_, i) =>
    Schema.decodeUnknownSync(E2eEmail)(
      `page${String(i).padStart(2, "0")}-${testId}-${String(retry)}@e2e.test`,
    ),
  );
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: { members, teams: [{ name: pagesTeam, members }], workflows: [], orders: [] },
      }),
    ),
  );

  frame = await gotoApp(page, "app/teams");
  await openTeam(pagesTeam);

  const membersTable = frame.locator('s-section[heading="Members"]');
  const memberRows = membersTable.locator("s-table-row");
  const search = () => new URL(page.url()).searchParams;
  await expect(memberRows).toHaveCount(10);

  await membersTable.getByRole("button", { name: "Go to next page" }).click();
  await expect(memberRows).toHaveCount(1);
  await expect.poll(() => search().get("membersAfter")).not.toBeNull();

  await membersTable.getByRole("button", { name: "Go to previous page" }).click();
  await expect(memberRows).toHaveCount(10);
  await expect.poll(() => search().get("membersAfter")).toBeNull();
});

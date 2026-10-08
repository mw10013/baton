import { expect, type FrameLocator, type Page, test } from "@playwright/test";

import * as Domain from "@/lib/Domain";

import { clickHoisted, openApp, openScreen } from "./app";
import { seedConfig, seedMembers } from "./seed";

test.describe.configure({ mode: "serial" });

let page: Page;
let frame: FrameLocator;

/** One admin boot for the spec (`openApp`); each test seeds and navigates. */
test.beforeAll(async ({ browser }) => {
  ({ page, frame } = await openApp(browser));
});

test.afterAll(async () => {
  await page.context().close();
});

/**
 * The embedded half of teams: creating, adding members to, renaming, and deleting on
 * `/app/teams`. What a member then sees of their teams is
 * `member-area.member.spec.ts`, which runs outside the admin entirely.
 *
 * Seeds one member and zero teams first, so both empty states are real
 * assertions rather than an accident of what a previous run left behind.
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
const EMPTY_STATE = "No teams yet";
const TEAM = "E2E Cut";
const RENAMED = "E2E Cutting";

test("teams screen creates, adds members to, renames, and deletes a team", async () => {
  await seedMembers(seedConfig(), [MEMBER_EMAIL]);

  await openScreen(page, "Teams");
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();

  /* Padded on purpose: `Domain.TeamName` trims at decode, so the heading that
     comes back is the proof that normalization is structural rather than
     something the create dialog does on its own. Creating lands on the new
     team's page, since the next thing is always adding people. */
  await frame.getByRole("button", { name: "Create team" }).click();
  /* A one-line field shows no counter and refuses past its cap on submit
     with its own error (the text-limit control). */
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  await nameField.fill("x".repeat(Domain.TEAM_NAME_MAX_LENGTH + 1));
  await expect(frame.getByText("characters", { exact: false })).toHaveCount(0);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.getByText("Up to 32 characters")).toBeVisible();
  await nameField.fill(`  ${TEAM}  `);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${TEAM}"]`)).toBeVisible();
  await expect(frame.getByText("Nobody is on this team")).toBeVisible();

  /* Uniqueness is a unique constraint, not a pre-check, so the
     duplicate has to come back as the field error in the dialog rather than
     as a raw constraint error. */
  await openScreen(page, "Teams");
  await expect(frame.getByRole("link", { name: TEAM })).toBeVisible();
  /* With teams present the Create button is the title-bar primary action,
     hoisted into the admin chrome by App Bridge (see `clickHoisted`); the
     modal itself stays in the frame. */
  await clickHoisted(page.getByRole("button", { name: "Create team" }));
  await frame.getByRole("textbox", { name: "Name", exact: true }).fill(TEAM);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    frame.getByText("A team with that name already exists."),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Cancel" }).click();
  /* The dialog releases focus on close; keys typed before that land in it and
     vanish, which showed up as an intermittent miss on the empty state below. */
  await expect(
    frame.getByText("A team with that name already exists."),
  ).toBeHidden();

  /* The search reads every team, submitted on Enter; a miss shows the
     clear-search state. Typed key by key: Polaris forwards native `input`
     events into its `onInput`, and `fill` can land as one value swap the
     element does not report. */
  const search = frame.getByRole("searchbox", { name: "Search" });
  await search.click();
  await search.pressSequentially("zzz");
  await expect(search).toHaveValue("zzz");
  await search.press("Enter");
  await expect(frame.getByText("No teams match.")).toBeVisible();
  await frame.getByRole("button", { name: "Clear search" }).click();
  await frame.getByRole("link", { name: TEAM }).click();
  await expect(frame.locator(`s-page[heading="${TEAM}"]`)).toBeVisible();

  /* Add members is our own `s-modal`, in the frame: App Bridge's Picker API is
     rendered by the admin host and gives no control over its layout. The
     empty-team box carries its own Add members button (the title-bar one is
     hoisted). Below six candidates the dialog has no search field, so the one
     seeded member is a bare choice; the Add button counts the selection. */
  await frame.getByRole("button", { name: "Add members" }).click();
  const addDialog = frame.locator("s-modal#add-team-members");
  await expect(addDialog.getByText(`Add members to ${TEAM}`)).toBeVisible();
  await addDialog.getByRole("checkbox", { name: MEMBER_EMAIL }).check();
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    frame.locator("s-table-cell").getByText(MEMBER_EMAIL, { exact: true }),
  ).toBeVisible();

  /* Rename lives behind More actions and the name is the page heading. */
  await clickMenuItem(frame, "Rename");
  await frame.getByRole("textbox", { name: "Name", exact: true }).fill(RENAMED);
  await frame.getByRole("button", { name: "Save" }).click();
  await expect(frame.locator(`s-page[heading="${RENAMED}"]`)).toBeVisible();

  /* Remove takes the member off at once, with no modal: Add members puts
     them back on this screen. */
  await frame.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(frame.getByText("Nobody is on this team")).toBeVisible();

  await clickMenuItem(frame, "Delete");
  await expect(
    frame.locator("s-modal#delete-team").getByText("This can't be undone."),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "Delete", exact: true })
    .last()
    .click();
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  await expect(
    page.locator("#admin-next-toast-viewport").getByText("Team deleted"),
  ).toBeVisible();
  await expect(frame.getByText(EMPTY_STATE)).toBeVisible();
});

/**
 * The team page pages its members table from the server, the controls
 * table's "a merchant table with more rows than its page" row (`Control` in
 * `Screen.ts`): Previous after Next is the browser's Back. Eleven members:
 * one past a details page of ten.
 */
test("the team page pages its members", async () => {
  const PAGES_TEAM = "E2E Pages";
  const members = Array.from(
    { length: 11 },
    (_, i) => `e2e.page${String(i).padStart(2, "0")}@example.com`,
  );
  await seedMembers(seedConfig(), members, [{ name: PAGES_TEAM, members }]);

  await openScreen(page, "Teams");
  await frame.getByRole("link", { name: PAGES_TEAM }).click();
  await expect(frame.locator(`s-page[heading="${PAGES_TEAM}"]`)).toBeVisible();

  const membersTable = frame.locator('s-section[heading="Members"]');
  const memberRows = membersTable.locator("s-table-row");
  const search = () => new URL(page.url()).searchParams;
  await expect(memberRows).toHaveCount(10);

  await membersTable.getByRole("button", { name: "Go to next page" }).click();
  await expect(memberRows).toHaveCount(1);
  await expect.poll(() => search().get("membersAfter")).not.toBeNull();

  await membersTable
    .getByRole("button", { name: "Go to previous page" })
    .click();
  await expect(memberRows).toHaveCount(10);
  await expect.poll(() => search().get("membersAfter")).toBeNull();
});

import { expect, type FrameLocator, test } from "@playwright/test";

import { appNavLink, clickHoisted, gotoApp } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The embedded half of teams: creating, adding members to, renaming, and deleting on
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
const EMPTY_STATE = "No teams yet";
const TEAM = "E2E Cut";
const RENAMED = "E2E Cutting";

test("teams screen creates, adds members to, renames, and deletes a team", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await seedMembers(seedConfig(), [MEMBER_EMAIL]);

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Teams"));
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

  /* Uniqueness is a unique constraint, not a pre-check, so the
     duplicate has to come back as the field error in the dialog rather than
     as a raw constraint error. */
  await clickHoisted(appNavLink(page, "Teams"));
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
  await frame.getByRole("button", { name: /^Add \d+$/u }).click();
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
 * The team page pages two tables on one URL (`membersAfter`, `workflowsAfter`),
 * the controls table's "a merchant table with more rows than its page" row
 * (`Control` in `Screen.ts`): Next on one table keeps the other's page, and
 * Previous is the browser's Back only when that table's Next pushed the
 * entry, so Previous on the members table never moves the Used by table.
 * Eleven members and eleven workflows: one past a details page of ten.
 */
test("the team page pages its members and its workflows independently", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const PAGES_TEAM = "E2E Pages";
  const members = Array.from(
    { length: 11 },
    (_, i) => `e2e.page${String(i).padStart(2, "0")}@example.com`,
  );
  await seedMembers(
    seedConfig(),
    members,
    [{ name: PAGES_TEAM, members }],
    Array.from({ length: 11 }, (_, i) => ({
      name: `E2E Pages Workflow ${String(i).padStart(2, "0")}`,
      tag: `e2e-pages-${String(i)}`,
      tasks: [{ name: "Cut", team: PAGES_TEAM }],
    })),
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Teams"));
  const row = frame.locator("s-table-row", { hasText: PAGES_TEAM });
  await expect(row.locator("s-table-cell").nth(2)).toHaveText("11");
  await frame.getByRole("link", { name: PAGES_TEAM }).click();
  await expect(frame.locator(`s-page[heading="${PAGES_TEAM}"]`)).toBeVisible();

  const membersTable = frame.locator('s-section[heading="Members"]');
  const usedBy = frame.locator('s-section[heading="Used by"]');
  const memberRows = membersTable.locator("s-table-row");
  const workflowRows = usedBy.locator("s-table-row");
  const search = () => new URL(page.url()).searchParams;
  await expect(memberRows).toHaveCount(10);
  await expect(workflowRows).toHaveCount(10);

  await membersTable.getByRole("button", { name: "Go to next page" }).click();
  await expect(memberRows).toHaveCount(1);
  await expect(workflowRows).toHaveCount(10);
  await usedBy.getByRole("button", { name: "Go to next page" }).click();
  await expect(workflowRows).toHaveCount(1);
  await expect(memberRows).toHaveCount(1);
  await expect.poll(() => search().get("membersAfter")).not.toBeNull();
  await expect.poll(() => search().get("workflowsAfter")).not.toBeNull();

  /* This entry was pushed by the Used by table's Next, so the members
     table's Previous is a navigation to its page one, not a Back, and the
     Used by table stays on its page two. */
  await membersTable
    .getByRole("button", { name: "Go to previous page" })
    .click();
  await expect(memberRows).toHaveCount(10);
  await expect(workflowRows).toHaveCount(1);
  await expect.poll(() => search().get("membersAfter")).toBeNull();
  await expect.poll(() => search().get("workflowsAfter")).not.toBeNull();

  /* The Used by table's Next did push this entry (Previous above replaced
     it), so its Previous is the browser's Back: page one of both. */
  await usedBy.getByRole("button", { name: "Go to previous page" }).click();
  await expect(workflowRows).toHaveCount(10);
  await expect(memberRows).toHaveCount(10);
  await expect.poll(() => search().get("workflowsAfter")).toBeNull();
});

/**
 * The drill-in that makes the orders "Team" filter discoverable from the
 * suspicion that prompts it: the team page's secondary action lands on
 * `/app/orders?team=<id>`, with the filter already set to that team and the
 * list showing the order the team is holding.
 *
 * The link hoists into admin chrome like every other title-bar control, so it
 * is located on `page` and driven through `clickHoisted`; the orders page it
 * lands on is back inside the frame.
 */
test("the team page drills in to the orders waiting on that team", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const DRILL_MEMBER = "e2e.drillin@example.com";
  const DRILL_TEAM = "E2E Drill Bench";
  await seedMembers(
    seedConfig(),
    [DRILL_MEMBER],
    [{ name: DRILL_TEAM, members: [DRILL_MEMBER] }],
    [
      {
        name: "E2E Drill Cuff",
        tag: "e2e-drill",
        tasks: [{ name: "Cut", team: DRILL_TEAM }],
      },
    ],
    [
      {
        n: 9401,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: ["e2e-drill"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Teams"));
  /* The index's Workflows column is a count, not the names. */
  const row = frame.locator("s-table-row", { hasText: DRILL_TEAM });
  await expect(row.locator("s-table-cell").nth(2)).toHaveText("1");
  await frame.getByRole("link", { name: DRILL_TEAM }).click();
  await expect(frame.locator(`s-page[heading="${DRILL_TEAM}"]`)).toBeVisible();

  await clickHoisted(
    page.getByRole("button", { name: "Orders waiting on this team" }),
  );
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  /* The select's value is the id the link carried — which is what makes the
     control read as the chosen team rather than as "Any team" over a
     filtered list. `toHaveValue` cannot answer this: `s-select` is a custom
     element, not an `<select>`, so its value is read off the element. */
  const team = new URL(page.url()).searchParams.get("team");
  expect(team).not.toBeNull();
  const select = frame.getByRole("combobox", { name: "Team" });
  await expect
    .poll(() =>
      select.evaluate((el) => (el as unknown as HTMLSelectElement).value),
    )
    .toBe(team);

  await expect(
    frame.getByRole("link", { name: "#9401", exact: true }),
  ).toBeVisible();
});

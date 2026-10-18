import { expect, test } from "./fixtures.ts";
import {
  card,
  closeMembers,
  openRuns,
  rowLink,
  seedRuns,
  stateCount,
  teamSelect,
  workflowPage,
  workflowsLink,
  workflowsSection,
  world,
} from "./member-screens.ts";

test.afterEach(closeMembers);

test("a member sees the teams they are on, and only those", async ({ backend, browser }) => {
  const w = world();
  await seedRuns(backend, w, { cutMembers: "maker" });

  // The mate is on Pack alone here: one team, so no Team select, and only Pack's box order.
  const mate = await openRuns(browser, w.MATE, "ready");
  await expect(stateCount(mate, "Ready", 1)).toBeVisible();
  await expect(card(mate, w.BOX_ORDER)).toBeVisible();
  await expect(rowLink(mate, w.RING_ORDER)).toBeHidden();
  await expect(teamSelect(mate)).toHaveCount(0);

  const maker = await openRuns(browser, w.MAKER, "ready");
  await expect(card(maker, w.RING_ORDER)).toBeVisible();
  await expect(rowLink(maker, w.BOX_ORDER)).toBeHidden();
});

test("a member on two teams picks between those two alone", async ({ backend, browser }) => {
  const w = world();
  await seedRuns(backend, w, { cutMembers: "both" });

  const mate = await openRuns(browser, w.MATE, "ready");
  await expect(stateCount(mate, "Ready", 2)).toBeVisible();
  // The e2e store has other tests' teams; the select names the mate's own.
  const options = await teamSelect(mate).locator("option").allTextContents();
  expect(options.map((text) => text.trim()).toSorted()).toEqual(
    ["Any team", w.CUT_TEAM, w.PACK_TEAM].toSorted(),
  );
});

test("a member starts and finishes a task on the workflow page", async ({ backend, browser }) => {
  const w = world();
  await seedRuns(backend, w, { cutMembers: "maker" });
  const page = await openRuns(browser, w.MAKER, "ready");

  await rowLink(page, w.RING_ORDER).click();
  const ticket = workflowPage(page, w.RING_ORDER);
  await expect(ticket).toBeVisible();
  await expect(ticket.locator("s-heading", { hasText: w.RING_ITEM })).toBeVisible();

  await ticket.getByRole("button", { name: "Start", exact: true }).click();
  await expect(ticket.getByRole("button", { name: "Put back", exact: true })).toBeVisible();
  await ticket.getByRole("button", { name: "Done", exact: true }).click();
  await expect(ticket.getByRole("button", { name: "Undo", exact: true })).toBeVisible();

  await workflowsLink(page).click();
  await expect(workflowsSection(page)).toBeVisible();
  await expect(stateCount(page, "Done or closed", 1)).toBeVisible();
});

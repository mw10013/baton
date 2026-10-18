import type { BrowserContext, FrameLocator, Page } from "playwright/test";

import * as Schema from "effect/Schema";
import { ShopFixtureData } from "../../../src/contract/fixture.ts";
import { WORKFLOW_STATE_LABEL } from "../../../src/domain/shop-work.ts";
import { dev, expect, type Run, test, testEmail } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The workflows index and the workflow page on the e2e store: legacy `workflows.spec.ts`'s
 * index and detail cases, titles unchanged. The specs run in parallel on one store, so each test
 * names its workflows, tags and teams from its test id, adds them with `AddToFixture`, and
 * asserts on nothing it did not add.
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

/** The test's own tail for names and tags: its id and its retry, so a retry adds afresh. */
const own = () => {
  const { testId, retry } = test.info();
  return `${testId.slice(-8)}${String(retry)}`;
};

/**
 * Adds `parts` beside the store's data, decoded as the fixture decodes them; a clash fails the
 * test, the names being its own.
 */
const add = (backend: Run, parts: Record<string, unknown>) =>
  backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: Schema.decodeUnknownSync(ShopFixtureData)({
          members: [],
          teams: [],
          workflows: [],
          orders: [],
          ...parts,
        }),
      }),
    ),
  );

/** A team with one member of the test's own, for tasks that need a team someone is on. */
const benchOf = (name: string) => ({
  members: [testEmail("workflows")],
  teams: [{ name, members: [testEmail("workflows")] }],
});

/**
 * A More actions menu item. The title-bar button is hoisted into the admin chrome, and the menu
 * it opens is not reachable from either document (see `teams.spec.ts`), so the in-frame
 * `s-button` inside the `s-menu` is clicked natively, which fires its `commandFor` as the host's
 * menu would.
 */
const clickMenuItem = (name: string) =>
  frame.locator("s-menu#workflow-actions s-button", { hasText: name }).evaluate((el) => {
    (el as HTMLElement).click();
  });

/** Searches the workflows index for `q`, submitted on Enter. */
const searchWorkflows = async (q: string) => {
  const search = frame.getByRole("searchbox", { name: "Search" });
  await search.fill(q);
  await search.press("Enter");
};

/** Opens the workflow called `name` from the workflows index, through its search. */
const openWorkflow = async (name: string, q: string) => {
  await searchWorkflows(q);
  await frame.getByRole("link", { name, exact: true }).click();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
};

test("creating a workflow with a taken tag is refused under the field and names the holder", async ({
  backend,
}) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const holder = `E2E Ring ${id}`;
  await add(backend, {
    ...benchOf(team),
    workflows: [
      { name: holder, state: "active", tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
    ],
  });

  frame = await gotoApp(page, "app/workflows");
  await expect(frame.locator('s-page[heading="Workflows"]')).toBeVisible();

  await page.getByRole("button", { name: "Create workflow" }).click();
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  await nameField.fill(`E2E Ring Rush ${id}`);
  await tagField.fill(`e2e-ring-${id}`);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.getByText(`is already ${holder}'s tag`, { exact: false })).toBeVisible();

  // A free tag, and the same dialog goes through.
  await tagField.fill(`e2e-ring-rush-${id}`);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.locator(`s-page[heading="E2E Ring Rush ${id}"]`)).toBeVisible();
});

/**
 * Duplicate asks for the new workflow's name and tag, both prefilled, and the new workflow lands
 * off with the tag the merchant chose.
 */
test("duplicate asks for a name and a tag, and the new workflow is inactive with the given tag", async ({
  backend,
}) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const source = `E2E Ring ${id}`;
  await add(backend, {
    ...benchOf(team),
    workflows: [
      { name: source, state: "active", tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
    ],
  });

  frame = await gotoApp(page, "app/workflows");
  await openWorkflow(source, id);

  await clickMenuItem("Duplicate");
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  await expect(nameField).toHaveValue(`${source} copy`);
  await expect(tagField).toHaveValue(`${source.toLowerCase()} copy`);

  // The source's own tag is taken, and the refusal lands under the field.
  await tagField.fill(`e2e-ring-${id}`);
  await frame.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(frame.getByText(`is already ${source}'s tag`, { exact: false })).toBeVisible();

  await tagField.fill(`e2e-ring-copy-${id}`);
  await frame.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${source} copy"]`)).toBeVisible();

  // The copy carries the tag the dialog collected, and is inactive.
  frame = await gotoApp(page, "app/workflows");
  await searchWorkflows(id);
  const copyRow = frame.locator("s-table-row").filter({ hasText: `${source} copy` });
  await expect(copyRow.getByText(`e2e-ring-copy-${id}`, { exact: true })).toBeVisible();
  await expect(copyRow.getByText(WORKFLOW_STATE_LABEL.inactive, { exact: true })).toBeVisible();
});

/** Edit tag: on the workflow page, immediate, and it makes no draft. */
test("editing the tag from the detail page writes immediately and starts no draft", async ({
  backend,
}) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const source = `E2E Ring ${id}`;
  const rival = `E2E Rush ${id}`;
  await add(backend, {
    ...benchOf(team),
    workflows: [
      { name: source, state: "active", tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
      { name: rival, state: "active", tag: `e2e-rush-${id}`, tasks: [{ name: "Cut", team }] },
    ],
  });

  frame = await gotoApp(page, "app/workflows");
  await openWorkflow(source, `ring ${id}`);

  await frame.getByRole("button", { name: "Edit tag" }).click();
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  await expect(tagField).toHaveValue(`e2e-ring-${id}`);

  // The rival's tag: refused under the field, and the dialog stays open.
  await tagField.fill(`e2e-rush-${id}`);
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await expect(frame.getByText(`is already ${rival}'s tag`, { exact: false })).toBeVisible();

  await tagField.fill(`e2e-ring-2-${id}`);
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    frame.getByText(`a product tagged “e2e-ring-2-${id}”`, { exact: false }),
  ).toBeVisible();
  // Immediate, not drafted: the page still shows the workflow's own tasks.
  await expect(frame.getByText("Cut", { exact: true })).toBeVisible();
});

/**
 * The filter rides the workflow page's URL (`WorkflowsSearch` on the `/app/workflows` layout),
 * so its breadcrumb returns to the filtered list.
 */
test("the workflows index keeps its filter across the workflow page", async ({ backend }) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const existing = `E2E Ring ${id}`;
  const off = `E2E Keep Off ${id}`;
  await add(backend, {
    ...benchOf(team),
    workflows: [
      { name: existing, state: "active", tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
      { name: off, tag: `e2e-keep-off-${id}`, state: "inactive", tasks: [{ name: "Cut", team }] },
    ],
  });

  frame = await gotoApp(page, "app/workflows");
  await expect(frame.getByRole("link", { name: off })).toBeVisible();
  const state = () => new URL(page.url()).searchParams.get("state");

  await frame.getByRole("button", { name: WORKFLOW_STATE_LABEL.active, exact: true }).click();
  await expect.poll(state).toBe("active");
  await expect(frame.getByRole("link", { name: off })).toHaveCount(0);

  await frame.getByRole("link", { name: existing }).click();
  await expect(frame.locator(`s-page[heading="${existing}"]`)).toBeVisible();
  await expect.poll(state).toBe("active");

  // The hoisted breadcrumb's back arrow.
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(frame.getByRole("link", { name: existing })).toBeVisible();
  await expect.poll(state).toBe("active");
  await expect(frame.getByRole("link", { name: off })).toHaveCount(0);
});

/**
 * The workflows index's two derived badges are separate: "Needs a team" for an unassigned task
 * and "Team has no members" for a task on a team with no members. The workflow page raises one
 * banner, for the fault that disables Turn on; the empty team is a badge on its step. Added off,
 * because the fixture refuses an active workflow with an unassigned task.
 */
test("the workflow page raises Needs a team as its one banner and marks an empty team's step No members", async ({
  backend,
}) => {
  const id = own();
  const both = `E2E Both faults ${id}`;
  const empty = `E2E Nobody ${id}`;
  await add(backend, {
    teams: [{ name: empty, members: [] }],
    workflows: [
      {
        name: both,
        tag: `e2e-both-faults-${id}`,
        state: "inactive",
        tasks: [
          { name: "Stamp", team: null },
          { name: "Attach ring", team: empty },
        ],
      },
    ],
  });

  frame = await gotoApp(page, "app/workflows");
  await searchWorkflows(id);
  const row = frame.locator("s-table-row", { hasText: both });
  await expect(row.getByText("Needs a team", { exact: true })).toBeVisible();
  await expect(row.getByText("Team has no members", { exact: true })).toBeVisible();

  await frame.getByRole("link", { name: both }).click();
  await expect(frame.locator(`s-page[heading="${both}"]`)).toBeVisible();
  const needsTeam = frame.locator('s-banner[heading="Needs a team"]');
  await expect(needsTeam).toHaveAttribute("tone", "critical");
  await expect(needsTeam).toContainText("No team on Stamp.");
  await expect(frame.locator("s-banner")).toHaveCount(1);
  await expect(frame.locator("s-badge", { hasText: "No members" })).toHaveCount(1);
});

/**
 * The workflows index searches in the actor, a word prefix of the name, keyed `?q=`. Enter
 * submits; the state buttons give way to how many workflows match and Clear search, which puts
 * the list back.
 */
test("the workflows index searches by name and clears back to the list", async ({ backend }) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const existing = `E2E Ring ${id}`;
  const glaze = `E2E Mug glaze${id}`;
  await add(backend, {
    ...benchOf(team),
    workflows: [
      { name: existing, tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
      { name: glaze, tag: `e2e-mug-${id}`, tasks: [{ name: "Glaze", team }] },
    ],
  });

  frame = await gotoApp(page, "app/workflows");
  await expect(frame.getByRole("link", { name: existing })).toBeVisible();

  await searchWorkflows(`glaze${id}`);
  await expect(frame.getByRole("link", { name: glaze })).toBeVisible();
  await expect(frame.getByRole("link", { name: existing })).toHaveCount(0);
  await expect(frame.getByText(`1 workflow matches glaze${id}`, { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(`glaze${id}`);

  await frame.getByRole("button", { name: "Clear search" }).click();
  await expect(frame.getByRole("link", { name: existing })).toBeVisible();
  await expect(frame.getByRole("link", { name: glaze })).toBeVisible();
});

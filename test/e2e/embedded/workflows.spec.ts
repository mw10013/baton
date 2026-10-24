import type { BrowserContext, FrameLocator, Page } from "playwright/test";

import * as Schema from "effect/Schema";
import { ShopFixtureData } from "../../../src/contract/fixture.ts";
import {
  noteCountFrom,
  TASK_INSTRUCTIONS_MAX_LENGTH,
  WORKFLOW_STATE_LABEL,
} from "../../../src/domain/shop-work.ts";
import { dev, expect, type Run, test, testEmail } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import {
  awaitHydration,
  clickHoisted,
  closeEditor,
  editorFrame,
  gotoApp,
  hoistedEnabled,
  openApp,
  openEditor,
} from "./app.ts";

/**
 * The workflows index, the workflow page and the editor on the e2e store. The specs run in
 * parallel on one store, so each test names its workflows, tags and teams from its test id, adds them with `AddToFixture`, and
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
  await expect(editorFrame(page).locator(`s-page[heading="E2E Ring Rush ${id}"]`)).toBeVisible();
  // Create left the editor open; the shared page needs it closed for the next test.
  await closeEditor(page);
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
  await page.locator('button[aria-label="Workflows"]').click();
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

/**
 * The task panel's Save and Delete, section buttons that share their names with the Rename and
 * Delete dialogs' confirms; scoped to the aside so the two never collide.
 */
const taskPanel = (editor: FrameLocator) => editor.locator('s-section[slot="aside"]');

/**
 * The draft lifecycle, which no unit test can see: a workflow never applied is a draft and
 * nothing else, so the editor offers Turn on workflow and that one press applies and activates;
 * from then on the first saved change starts a draft, Apply promotes it, and Discard throws it
 * away. Create opens the editor in its `s-app-window` straight away, so everything between Create
 * and Turn on is the window's frame (`editorFrame`); the workflow page comes back once it hides.
 * Title-bar controls are hoisted into the admin's chrome and are found on the page.
 */
test("a fresh workflow turns on from the editor, then edits go through the draft", async ({
  backend,
}) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const created = `E2E Cake ${id}`;
  await add(backend, { ...benchOf(team) });

  const editor = editorFrame(page);
  frame = await gotoApp(page, "app/workflows");
  await expect(frame.locator('s-page[heading="Workflows"]')).toBeVisible();

  // Create asks for a name and a tag. The tag mirrors the name, folded, until the merchant edits
  // it; after that the name can keep changing.
  await page.getByRole("button", { name: "Create workflow" }).click();
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  const taskName = editor.getByRole("textbox", { name: "Name", exact: true });
  await nameField.fill("Cake");
  await expect(tagField).toHaveValue("cake");
  await tagField.fill(`e2e-cake-${id}`);
  await nameField.fill(created);
  await expect(tagField).toHaveValue(`e2e-cake-${id}`);
  await frame.getByRole("button", { name: "Create", exact: true }).click();

  // Create lands in the editor, so the new workflow's first screen is the canvas.
  await expect(editor.locator(`s-page[heading="${created}"]`)).toBeVisible();
  await awaitHydration(editor);

  // Never applied: Turn on is the only commit on offer, disabled until there is a step.
  const turnOn = page.getByRole("button", { name: "Turn on workflow", exact: true });
  await expect(turnOn).toBeVisible();
  await expect.poll(() => hoistedEnabled(turnOn)).toBe(false);
  await expect(page.getByRole("button", { name: "Apply changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
  await expect(editor.locator("s-banner")).toHaveCount(0);

  await editor.getByRole("button", { name: "Add step" }).click();
  await taskName.fill("Bake");
  await editor.getByRole("combobox", { name: "Team", exact: true }).selectOption({ label: team });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Step 1", { exact: true })).toBeVisible();
  await expect.poll(() => hoistedEnabled(turnOn)).toBe(true);

  // One press applies the tasks and turns the switch on.
  await clickHoisted(turnOn);
  await expect(
    editor.getByText("starts this workflow on that item", { exact: false }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn off workflow", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes" })).toHaveCount(0);

  // Closing the window lands on the new workflow's page, on what is in force.
  await closeEditor(page);
  await expect(frame.locator(`s-page[heading="${created}"]`)).toBeVisible();
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();

  // Opening the editor is not an edit: no draft, so nothing to discard.
  await openEditor(page);
  await expect(page.getByRole("button", { name: "Discard changes" })).toHaveCount(0);

  // The first saved change starts the draft, on a task that exists only on the workflow so far:
  // the id-preserving copy under test.
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await taskName.fill("Bake and cool");
  await taskPanel(editor).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Discard changes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeVisible();

  // Two decisions, three verbs. A second task lands in its own step; "Join the previous step"
  // is the only thing that makes the two parallel, "Move to its own step" splits them back, and
  // moving only reorders.
  await editor.getByRole("button", { name: "Add step", exact: true }).click();
  await taskName.fill("Ice");
  await editor.getByRole("combobox", { name: "Team", exact: true }).selectOption({ label: team });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Step 2", { exact: true })).toBeVisible();

  await editor.getByRole("button", { name: "Edit Ice" }).click();
  await editor.getByRole("button", { name: "Join the previous step" }).click();
  await expect(editor.getByText("Step 2", { exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "Move to its own step" }).click();
  await expect(editor.getByText("Step 2", { exact: true })).toBeVisible();

  // Card order in the canvas: each card's label, top to bottom.
  const taskOrder = () =>
    editor
      .locator('s-clickable[accessibilityLabel^="Edit "]')
      .evaluateAll((cards: Array<Element>) =>
        cards.map((card) => card.getAttribute("accessibilityLabel")),
      );
  await editor.getByRole("button", { name: "Move earlier" }).click();
  await expect.poll(taskOrder).toEqual(["Edit Ice", "Edit Bake and cool"]);
  await editor.getByRole("button", { name: "Move later" }).click();
  await expect.poll(taskOrder).toEqual(["Edit Bake and cool", "Edit Ice"]);
  await taskPanel(editor).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(editor.getByText("Step 2", { exact: true })).toHaveCount(0);

  // Close keeps the draft, and the workflow page still shows only what runs.
  await closeEditor(page);
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();
  await expect(frame.getByText("Bake and cool")).toHaveCount(0);

  // Discard leaves the workflow exactly as it was. Its confirm belongs to the editor's document.
  // The click is retried until the confirm shows: a reopened window's hoisted title bar can read
  // enabled before App Bridge has wired it to the in-frame button, which `openEditor` says of
  // Edit, and a click in that window is a silent no-op.
  await openEditor(page);
  await expect(async () => {
    await clickHoisted(page.getByRole("button", { name: "Discard changes" }));
    await expect(
      editor.getByText("Your unsaved changes will be lost.", { exact: true }),
    ).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await editor.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
  await expect(editor.getByText("Bake", { exact: true })).toBeVisible();

  // Apply on a workflow that is on asks first, in the window's own document; applying from there
  // closes the window and the workflow page comes back on the new tasks.
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await taskName.fill("Bake and rest");
  await taskPanel(editor).getByRole("button", { name: "Save", exact: true }).click();
  await clickHoisted(page.getByRole("button", { name: "Apply changes" }));
  await expect(editor.getByText("This workflow is active,", { exact: false })).toBeVisible();
  await editor.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator('iframe[src*="chrome=window"]')).toHaveCount(0);
  await expect(frame.locator(`s-page[heading="${created}"]`)).toBeVisible();
  await expect(frame.getByText("Bake and rest", { exact: true })).toBeVisible();

  // Turn off confirms too, and says what keeps going.
  await clickHoisted(page.getByRole("button", { name: "Turn off workflow", exact: true }));
  await expect(
    frame.getByText("New orders won't start this workflow. Items already on it keep going.", {
      exact: true,
    }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn on workflow", exact: true })).toBeVisible();
});

test("another tab's edits and Discard reach an open editor without a press", async ({
  backend,
}) => {
  const id = own();
  const team = `E2E Live Bench ${id}`;
  const name = `E2E Live ${id}`;
  await add(backend, {
    ...benchOf(team),
    workflows: [{ name, tag: `e2e-live-${id}`, tasks: [{ name: "Cut", team }] }],
  });

  const editor = editorFrame(page);
  frame = await gotoApp(page, "app/workflows");
  await openWorkflow(name, id);
  const workflowPath = /app\/workflows\/[^/?#]+/u.exec(page.url())?.[0];
  if (workflowPath === undefined) throw new Error(`no workflow in ${page.url()}`);

  // The second tab: the same workflow's editor, as a page of the app's frame.
  const other = await context.newPage();
  try {
    const watching = await gotoApp(other, `${workflowPath}/edit`);
    await awaitHydration(watching);
    await expect(watching.getByRole("button", { name: "Edit Cut" })).toBeVisible();
    await expect(other.getByRole("button", { name: "Discard changes" })).toHaveCount(0);

    // A step added in the first tab shows in the second, with the draft's controls.
    await openEditor(page);
    await editor.getByRole("button", { name: "Add step" }).click();
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Pack");
    await editor.getByRole("combobox", { name: "Team", exact: true }).selectOption({ label: team });
    await editor.getByRole("button", { name: "Add step" }).click();
    await expect(editor.getByRole("button", { name: "Edit Pack" })).toBeVisible();
    await expect(watching.getByRole("button", { name: "Edit Pack" })).toBeVisible();
    await expect(other.getByRole("button", { name: "Discard changes" })).toBeVisible();

    // Discard in the first tab takes the step and the draft out of the second.
    await expect(async () => {
      await clickHoisted(page.getByRole("button", { name: "Discard changes" }));
      await expect(
        editor.getByText("Your unsaved changes will be lost.", { exact: true }),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    await editor.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(watching.getByRole("button", { name: "Edit Pack" })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
    await expect(watching.getByRole("button", { name: "Edit Cut" })).toBeVisible();
  } finally {
    await other.close();
    await closeEditor(page);
  }
});

/**
 * A task's instructions are capped at `TASK_INSTRUCTIONS_MAX_LENGTH` the way the run note is (the
 * text-limit control): no help line, a countdown from `noteCountFrom`, and Save refuses past the
 * cap with the field's own error while the text stays.
 */
test("the editor counts instructions down from 300 and refuses 501 on save", async ({
  backend,
}) => {
  const id = own();
  const team = `E2E Bench ${id}`;
  const existing = `E2E Ring ${id}`;
  await add(backend, {
    ...benchOf(team),
    workflows: [{ name: existing, tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] }],
  });

  const editor = editorFrame(page);
  frame = await gotoApp(page, "app/workflows");
  await openWorkflow(existing, id);
  await openEditor(page);
  await editor.getByRole("button", { name: "Edit Cut" }).click();

  const instructions = editor.getByRole("textbox", { name: "Instructions", exact: true });
  // No help line and no counter on a field far from its cap.
  await expect(editor.getByText("characters", { exact: false })).toHaveCount(0);
  await instructions.fill("x".repeat(noteCountFrom(TASK_INSTRUCTIONS_MAX_LENGTH)));
  await expect(editor.getByText("200 characters left")).toBeVisible();
  // Past the cap the field keeps the text and Save refuses with its own error.
  const over = "x".repeat(TASK_INSTRUCTIONS_MAX_LENGTH + 1);
  await instructions.fill(over);
  await expect(instructions).toHaveValue(over);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByText("Up to 500 characters")).toBeVisible();
  await expect(instructions).toHaveValue(over);
  // The editor is closed on the way out: the window covers the admin, and the next test's
  // navigation would land under it.
  await closeEditor(page);
});

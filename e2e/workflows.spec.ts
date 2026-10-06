import type { FrameLocator, Page } from "@playwright/test";

import { expect, test } from "@playwright/test";

import * as Domain from "@/lib/Domain";

import {
  appNavLink,
  clickHoisted,
  editorFrame,
  gotoApp,
  hoistedEnabled,
} from "./app";
import { awaitHydration } from "./hydration";
import { seedConfig, seedMembers } from "./seed";

/**
 * A More actions menu item on the detail page. The title-bar button is hoisted
 * into admin chrome, where its accessible name collides with the admin's own
 * disclosure, and the menu it opens is not reachable from either document
 * (see `teams.spec.ts`). The in-frame `s-button` inside the `s-menu` still
 * exists, hidden, and a native click fires its `commandFor` exactly as the
 * host's menu would.
 */
const clickMenuItem = (frame: FrameLocator, name: string) =>
  frame
    .locator("s-menu#workflow-actions s-button", { hasText: name })
    .evaluate((el) => {
      (el as HTMLElement).click();
    });

/**
 * The three workflow screens end to end: the list, the read-only detail
 * page, and the editor.
 *
 * What it is really here to prove is the draft lifecycle, because that is the
 * part no unit test can see. A workflow that has never been applied is a
 * draft and nothing else, so the editor offers **Turn on workflow** and that one click
 * applies and activates; from then on the first saved change starts a draft,
 * Apply promotes it, and Discard throws it away. It also covers the one thing
 * that makes the lazy draft possible — editing a task that only exists on the
 * workflow so far, whose id the draft then carries (`editDraft` in
 * `WorkflowRepository`).
 *
 * The draft state is asserted through the header's buttons rather than the
 * `Draft` accessory badge: App Bridge hoists accessory badges into admin
 * chrome, where "Draft" is not ours to locate reliably, while the button set
 * is the same fact and is what the merchant acts on.
 *
 * Title-bar controls (Create, Edit, Apply, Turn on workflow, Turn off
 * workflow, Close, More actions) are hoisted out of the iframe by App Bridge, so they are driven
 * with `clickHoisted` and are all buttons there. `clickHoisted` waits for the
 * hoisted proxy to be enabled, which matters here more than anywhere: the
 * editor's controls are disabled until the `ShopAgent` socket identifies, a
 * second or two after the window paints.
 *
 * Two frames, and which one a control is in is not a detail: the list and
 * detail pages are `frame` (`appFrame`), while the editor runs in its own
 * `s-app-window` iframe, `editor` (`editorFrame`), that the admin mounts
 * beside the app's rather than inside it. Create opens the editor straight
 * away, so everything between Create and Turn on workflow — the task forms, the canvas
 * — is `editor`, and the detail page only comes back once the window hides.
 * Modals render in whichever frame opened them.
 *
 * Budget: this spec makes far more round trips than `teams.spec.ts` and each
 * one re-runs the Shopify auth middleware, so it pins its own timeout for the
 * same reason that one does.
 */

const MEMBER = "e2e.workflows@example.com";
const TEAM = "E2E Bench";
const EMPTY_TEAM = "E2E Glazing";
const EXISTING = "E2E Ring";
const CREATED = "E2E Cake";

/**
 * The editor's Close: the X in the header the admin draws around an
 * `s-app-window`. The editor's own breadcrumb Close is gone — in window mode
 * the route renders no breadcrumb at all, and the admin owns the chrome
 * instead (`app.workflows.$workflowId_.edit.tsx`).
 *
 * Scoped to the window's dialog rather than taken by name alone because
 * Sidekick and the CLI's dev console answer to "Close" too, and by role
 * rather than by the admin's class names, which are hashed CSS modules that
 * change when the admin ships: this locator used `AppWindowModalDialog` until
 * the admin dropped it (2026-09-24).
 *
 * Returns once the window's iframe is gone, not when the click lands. The
 * admin animates the window out, and an Edit pressed during that animation
 * opens nothing: the closing window takes the new one with it (seen
 * 2026-09-24, when an Edit straight after this click left no window at all).
 */
const closeEditor = async (page: Page) => {
  await clickHoisted(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true }),
  );
  await expect(page.locator('iframe[src*="chrome=window"]')).toHaveCount(0);
};

/**
 * The detail page's Edit, which opens the editor window, returning once the
 * window's document is hydrated. A click before that lands in an inert body
 * and is dropped without an error (`awaitHydration`), so the first click in a
 * freshly opened editor needs this as much as a click on a fresh page does.
 */
const openEditor = async (page: Page) => {
  await clickHoisted(page.getByRole("button", { name: "Edit", exact: true }));
  await awaitHydration(editorFrame(page));
};

/**
 * The task panel's Save and Delete, which are section buttons rather than
 * hoisted page actions and share their names with the Rename and Delete
 * dialogs' confirms. Scoped to the aside so the two never collide.
 */
const taskPanel = (editor: FrameLocator) =>
  editor.locator('s-section[slot="aside"]');

test("a fresh workflow turns on from the editor, then edits go through the draft", async ({
  page,
}) => {
  test.setTimeout(180_000);

  await seedMembers(
    seedConfig(),
    [MEMBER],
    [
      { name: TEAM, members: [MEMBER] },
      { name: EMPTY_TEAM, members: [] },
    ],
    [
      {
        name: EXISTING,
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  const editor = editorFrame(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await expect(frame.locator('s-page[heading="Workflows"]')).toBeVisible();
  await expect(frame.getByRole("link", { name: EXISTING })).toBeVisible();

  /* Create asks for a name and a tag. The tag mirrors the name, folded,
     until the merchant edits it; after that the name can keep changing. */
  await clickHoisted(page.getByRole("button", { name: "Create workflow" }));
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  /* The task forms live in the editor window, so their Name field is a
     different element from the create dialog's. */
  const taskName = editor.getByRole("textbox", { name: "Name", exact: true });
  await nameField.fill("Cake");
  await expect(tagField).toHaveValue("cake");
  await tagField.fill("e2e-cake");
  await nameField.fill(CREATED);
  await expect(tagField).toHaveValue("e2e-cake");
  await frame.getByRole("button", { name: "Create", exact: true }).click();

  /* Create lands in the editor, as Flow's does, so the new workflow's first
     screen is the canvas rather than its detail page. */
  await expect(editor.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await awaitHydration(editor);

  /* Never applied: Turn on is the only commit on offer, and it is disabled
     until there is a step to apply. The disabled button beside the empty
     canvas is the whole explanation: no banner restates it. */
  const turnOn = page.getByRole("button", {
    name: "Turn on workflow",
    exact: true,
  });
  await expect(turnOn).toBeVisible();
  await expect.poll(() => hoistedEnabled(turnOn)).toBe(false);
  await expect(page.getByRole("button", { name: "Apply changes" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);
  await expect(editor.locator("s-banner")).toHaveCount(0);

  await editor.getByRole("button", { name: "Add step" }).click();
  await taskName.fill("Bake");
  await editor
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Step 1", { exact: true })).toBeVisible();
  /* No "Saved" line: the write is the pressed button's spinner, and the
     step on the canvas is its result. */
  await expect(editor.getByText("✓ Saved", { exact: false })).toHaveCount(0);
  await expect.poll(() => hoistedEnabled(turnOn)).toBe(true);

  /* One click applies the tasks and turns the switch on. */
  await clickHoisted(
    page.getByRole("button", {
      name: "Turn on workflow",
      exact: true,
    }),
  );
  await expect(
    editor.getByText("starts this workflow on that item", { exact: false }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Turn on", exact: true }).click();
  /* Applied and on: the editor now offers the other direction and nothing to
     apply. */
  await expect(
    page.getByRole("button", {
      name: "Turn off workflow",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes" })).toHaveCount(
    0,
  );

  /* The detail page shows what is in force, with no draft panel: there is one
     answer and the editor holds the other. */
  await closeEditor(page);
  await expect(frame.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Live workflow" }),
  ).toHaveCount(0);

  /* Opening the editor is not an edit: no draft, so nothing to discard. */
  await openEditor(page);
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);

  /* The first saved change starts the draft — on a task that exists only on
     the workflow so far, which is the id-preserving copy under test. */
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await taskName.fill("Bake and cool");
  await taskPanel(editor)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply changes" }),
  ).toBeVisible();

  /* Two decisions, three verbs. A second task lands in its own step;
     "Join the previous step" is the only thing that makes the two parallel,
     "Move to its own step" splits them back, and moving only reorders. */
  await editor.getByRole("button", { name: "Add step", exact: true }).click();
  await taskName.fill("Ice");
  await editor
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Step 2", { exact: true })).toBeVisible();

  await editor.getByRole("button", { name: "Edit Ice" }).click();
  await editor.getByRole("button", { name: "Join the previous step" }).click();
  await expect(editor.getByText("Step 2", { exact: true })).toHaveCount(0);

  await editor.getByRole("button", { name: "Move to its own step" }).click();
  await expect(editor.getByText("Step 2", { exact: true })).toBeVisible();

  /* Card order in the canvas: the label the card carries, top to bottom. */
  const taskOrder = () =>
    editor
      .locator('s-clickable[accessibilityLabel^="Edit "]')
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("accessibilityLabel")),
      );
  await editor.getByRole("button", { name: "Move earlier" }).click();
  await expect.poll(taskOrder).toEqual(["Edit Ice", "Edit Bake and cool"]);
  await editor.getByRole("button", { name: "Move later" }).click();
  await expect.poll(taskOrder).toEqual(["Edit Bake and cool", "Edit Ice"]);
  await taskPanel(editor)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(editor.getByText("Step 2", { exact: true })).toHaveCount(0);

  /* Close keeps the draft, and the detail page still shows only what runs. */
  await closeEditor(page);
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();
  await expect(frame.getByText("Bake and cool")).toHaveCount(0);

  /* Discard leaves the workflow exactly as it was. Its confirm dialog belongs
     to the editor's document, not the app's. */
  await openEditor(page);
  await clickHoisted(page.getByRole("button", { name: "Discard changes" }));
  await expect(
    editor.getByText("Your unsaved changes will be lost.", {
      exact: true,
    }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);
  await expect(editor.getByText("Bake", { exact: true })).toBeVisible();

  /* Apply on a workflow that is ON asks first, and that confirm is the one
     place a hoisted title-bar button has to open a modal back inside the
     window's own document. Applying from in there closes the window and the
     detail page comes back on the new tasks. */
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await taskName.fill("Bake and rest");
  await taskPanel(editor)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await clickHoisted(page.getByRole("button", { name: "Apply changes" }));
  await expect(
    editor.getByText("This workflow is active,", { exact: false }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await expect(frame.getByText("Bake and rest", { exact: true })).toBeVisible();

  /* Turn off confirms too, and says what keeps going. */
  await clickHoisted(
    page.getByRole("button", {
      name: "Turn off workflow",
      exact: true,
    }),
  );
  await expect(
    frame.getByText("Items already on it keep going.", { exact: false }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Turn on workflow",
      exact: true,
    }),
  ).toBeVisible();
});

/**
 * Turn on applies to every stored open order: an order placed while the
 * workflow was off gets its run the moment the workflow is turned on.
 */
test("turning on a workflow creates runs on the open orders already stored", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: EXISTING,
        state: "inactive",
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
    [
      {
        n: 9101,
        lineItems: [{ title: "E2E Band", quantity: 1, tags: ["e2e-ring"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await frame.getByRole("link", { name: EXISTING }).click();
  await expect(frame.locator(`s-page[heading="${EXISTING}"]`)).toBeVisible();

  await clickHoisted(
    page.getByRole("button", {
      name: "Turn on workflow",
      exact: true,
    }),
  );
  await frame.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Turn off workflow",
      exact: true,
    }),
  ).toBeVisible();

  /* The order page shows the run that Turn on created: the item's
     section carries Manage, whose drawer names the workflow, and with a run on
     it the card carries no Workflow select at rest. Scoped to the section
     because another item's Workflow select on the same page lists every workflow by
     name. */
  await clickHoisted(appNavLink(page, "Orders"));
  await frame.getByRole("link", { name: "#9101", exact: true }).click();
  await expect(frame.locator('s-page[heading="#9101"]')).toBeVisible();
  const band = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Band", exact: true }),
  });
  await expect(band.getByRole("combobox")).toHaveCount(0);
  await band.getByRole("button", { name: "Manage" }).click();
  await expect(
    band.getByText(`${EXISTING} workflow`, { exact: true }),
  ).toBeVisible();
});

/**
 * The tag is the workflow's key: unique across the shop, active or inactive, and
 * refused where the merchant typed it. The switch says nothing about it.
 */
test("creating a workflow with a taken tag is refused under the field and names the holder", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const HOLDER = "E2E Ring";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: HOLDER,
        state: "active",
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await expect(frame.locator('s-page[heading="Workflows"]')).toBeVisible();

  await clickHoisted(page.getByRole("button", { name: "Create workflow" }));
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  await nameField.fill("E2E Ring Rush");
  await tagField.fill("e2e-ring");
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    frame.getByText(`is already ${HOLDER}'s tag`, { exact: false }),
  ).toBeVisible();

  /* A free tag, and the same dialog goes through. */
  await tagField.fill("e2e-ring-rush");
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    editorFrame(page).locator('s-page[heading="E2E Ring Rush"]'),
  ).toBeVisible();
});

/**
 * Duplicate asks for the new workflow's name and tag, both prefilled, and
 * the new workflow lands off with the tag the merchant chose.
 */
test("duplicate asks for a name and a tag, and the new workflow is inactive with the given tag", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const SOURCE = "E2E Ring";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: SOURCE,
        state: "active",
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await frame.getByRole("link", { name: SOURCE, exact: true }).click();
  await expect(frame.locator(`s-page[heading="${SOURCE}"]`)).toBeVisible();

  await clickMenuItem(frame, "Duplicate");
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  await expect(nameField).toHaveValue(`${SOURCE} copy`);
  await expect(tagField).toHaveValue(`${SOURCE.toLowerCase()} copy`);

  /* The source's own tag is taken, and the refusal lands under the field. */
  await tagField.fill("e2e-ring");
  await frame.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(
    frame.getByText(`is already ${SOURCE}'s tag`, { exact: false }),
  ).toBeVisible();

  /* A free tag goes through, landing in the new workflow's editor — this route
     navigates the app's own frame, unlike Create, which opens the window. */
  await tagField.fill("e2e-ring-copy");
  await frame.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${SOURCE} copy"]`)).toBeVisible();

  /* The copy carries the tag the dialog collected, and is inactive. */
  await clickHoisted(appNavLink(page, "Workflows"));
  const copyRow = frame
    .locator("s-table-row")
    .filter({ hasText: `${SOURCE} copy` });
  await expect(
    copyRow.getByText("e2e-ring-copy", { exact: true }),
  ).toBeVisible();
  await expect(
    copyRow.getByText(Domain.WORKFLOW_STATE_LABEL.inactive, { exact: true }),
  ).toBeVisible();
});

/** Edit tag: on the detail page, immediate, and it makes no draft. */
test("editing the tag from the detail page writes immediately and starts no draft", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const SOURCE = "E2E Ring";
  const RIVAL = "E2E Rush";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: SOURCE,
        state: "active",
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
      {
        name: RIVAL,
        state: "active",
        tag: "e2e-rush",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await frame.getByRole("link", { name: SOURCE, exact: true }).click();
  await expect(frame.locator(`s-page[heading="${SOURCE}"]`)).toBeVisible();

  await frame.getByRole("button", { name: "Edit tag" }).click();
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  await expect(tagField).toHaveValue("e2e-ring");

  /* The rival's tag: refused under the field, and the dialog stays open. */
  await tagField.fill("e2e-rush");
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    frame.getByText(`is already ${RIVAL}'s tag`, { exact: false }),
  ).toBeVisible();

  await tagField.fill("e2e-ring-2");
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    frame.getByText("a product tagged “e2e-ring-2”", { exact: false }),
  ).toBeVisible();
  /* Immediate, not drafted: the page still shows the workflow's own tasks and
     the editor holds nothing. */
  await expect(frame.getByText("Cut", { exact: true })).toBeVisible();
});

/**
 * `WorkflowsSearch` on the `/app/workflows` layout: the filter rides the
 * workflow page's URL, so its breadcrumb returns to the filtered list.
 */
test("the workflows index keeps its filter across the workflow page", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const OFF = "E2E Keep Off";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: EXISTING,
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
      {
        name: OFF,
        tag: "e2e-keep-off",
        state: "inactive",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await expect(frame.getByRole("link", { name: OFF })).toBeVisible();
  const state = () => new URL(page.url()).searchParams.get("state");

  await frame
    .getByRole("button", {
      name: Domain.WORKFLOW_STATE_LABEL.active,
      exact: true,
    })
    .click();
  await expect.poll(state).toBe("active");
  await expect(frame.getByRole("link", { name: OFF })).toHaveCount(0);

  await frame.getByRole("link", { name: EXISTING }).click();
  await expect(frame.locator(`s-page[heading="${EXISTING}"]`)).toBeVisible();
  await expect.poll(state).toBe("active");

  /* The hoisted breadcrumb's back arrow; see the orders round trip. */
  await clickHoisted(page.locator('button[aria-label="Workflows"]'));
  await expect(frame.getByRole("link", { name: EXISTING })).toBeVisible();
  await expect.poll(state).toBe("active");
  await expect(frame.getByRole("link", { name: OFF })).toHaveCount(0);
});

/**
 * The workflows index's two derived badges are separate and are the orders
 * index's: "Needs a team" for an unassigned task and "Team has no members"
 * for a task on a team with no members (`stateBadges`). A workflow with
 * both shows both, and its workflow page shows one banner per issue under
 * the same headings, both critical like every issue (`TeamIssueBanners`,
 * `Domain.ORDER_ISSUE_TONE`). Seeded off, because the seed refuses to turn
 * on a workflow with an unassigned task.
 */
test("the workflow page raises Needs a team as its one banner and marks an empty team's step No members", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const BOTH = "E2E Both faults";
  const EMPTY = "E2E Nobody here";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [
      { name: TEAM, members: [MEMBER] },
      { name: EMPTY, members: [] },
    ],
    [
      {
        name: BOTH,
        tag: "e2e-both-faults",
        state: "inactive",
        tasks: [
          { name: "Stamp", team: null },
          { name: "Attach ring", team: EMPTY },
        ],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  const row = frame.locator("s-table-row", { hasText: BOTH });
  await expect(row.getByText("Needs a team", { exact: true })).toBeVisible();
  await expect(
    row.getByText("Team has no members", { exact: true }),
  ).toBeVisible();

  await frame.getByRole("link", { name: BOTH }).click();
  await expect(frame.locator(`s-page[heading="${BOTH}"]`)).toBeVisible();
  /* One banner, for the fault that disables Turn on; the empty team is a
     badge on its step, because it disables nothing. */
  const needsTeam = frame.locator('s-banner[heading="Needs a team"]');
  await expect(needsTeam).toHaveAttribute("tone", "critical");
  await expect(needsTeam).toContainText("No team on Stamp.");
  await expect(frame.locator("s-banner")).toHaveCount(1);
  await expect(frame.locator("s-badge", { hasText: "No members" })).toHaveCount(
    1,
  );
});

/**
 * The workflows index searches in the object, a word prefix of the name
 * (`Domain.ListWorkflowsInput`), keyed `?q=` as on the orders index. Enter
 * submits; the state buttons give way to how many workflows match and Clear
 * search, which puts the list back.
 */
test("the workflows index searches by name and clears back to the list", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const GLAZE = "E2E Mug glaze";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: EXISTING,
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
      {
        name: GLAZE,
        tag: "e2e-mug",
        tasks: [{ name: "Glaze", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await expect(frame.getByRole("link", { name: EXISTING })).toBeVisible();
  await awaitHydration(frame);

  const search = frame.getByRole("searchbox", { name: "Search" });
  await search.fill("glaz");
  await search.press("Enter");
  await expect(frame.getByRole("link", { name: GLAZE })).toBeVisible();
  await expect(frame.getByRole("link", { name: EXISTING })).toHaveCount(0);
  await expect(
    frame.getByText("1 workflow matches glaz", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("glaz");

  await frame.getByRole("button", { name: "Clear search" }).click();
  await expect(frame.getByRole("link", { name: EXISTING })).toBeVisible();
  await expect(frame.getByRole("link", { name: GLAZE })).toBeVisible();
});

/**
 * A task's instructions are capped at `Domain.TASK_INSTRUCTIONS_MAX_LENGTH`
 * the way the run note is (the text-limit control on `Control`): no help
 * line, a countdown from `Domain.noteCountFrom`, and Save refuses past the
 * cap with the field's own error while the text stays.
 */
test("the editor counts instructions down from 300 and refuses 501 on save", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: EXISTING,
        tag: "e2e-ring",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  const editor = editorFrame(page);
  await clickHoisted(appNavLink(page, "Workflows"));
  await frame.getByRole("link", { name: EXISTING }).click();
  await expect(frame.locator(`s-page[heading="${EXISTING}"]`)).toBeVisible();
  await openEditor(page);
  await editor.getByRole("button", { name: "Edit Cut" }).click();

  const instructions = editor.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  /* No help line and no counter on a field far from its cap. */
  await expect(editor.getByText("characters", { exact: false })).toHaveCount(0);
  await instructions.fill(
    "x".repeat(Domain.noteCountFrom(Domain.TASK_INSTRUCTIONS_MAX_LENGTH)),
  );
  await expect(editor.getByText("200 characters left")).toBeVisible();
  /* Past the cap the field keeps the text and Save refuses with its own error. */
  const over = "x".repeat(Domain.TASK_INSTRUCTIONS_MAX_LENGTH + 1);
  await instructions.fill(over);
  await expect(instructions).toHaveValue(over);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByText("Up to 500 characters")).toBeVisible();
  await expect(instructions).toHaveValue(over);
});

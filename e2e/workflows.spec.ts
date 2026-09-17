import type { FrameLocator, Page } from "@playwright/test";

import { expect, test } from "@playwright/test";

import { clickHoisted, editorFrame, gotoApp } from "./app";
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
 * draft and nothing else, so the editor offers **Turn on** and that one click
 * applies and activates; from then on the first saved change starts a draft,
 * Apply promotes it, and Discard throws it away. It also covers the one thing
 * that makes the lazy draft possible — editing a step that only exists on the
 * workflow so far, whose id the draft then carries (`ensureDraft`).
 *
 * The draft state is asserted through the header's buttons rather than the
 * `Draft` accessory badge: App Bridge hoists accessory badges into admin
 * chrome, where "Draft" is not ours to locate reliably, while the button set
 * is the same fact and is what the merchant acts on.
 *
 * Title-bar controls (Create, Edit, Apply, Turn on, Turn off, Close, More
 * actions) are hoisted out of the iframe by App Bridge, so they are driven
 * with `clickHoisted` and are all buttons there. `clickHoisted` waits for the
 * hoisted proxy to be enabled, which matters here more than anywhere: the
 * editor's controls are disabled until the `ShopAgent` socket identifies, a
 * second or two after the window paints.
 *
 * Two frames, and which one a control is in is not a detail: the list and
 * detail pages are `frame` (`appFrame`), while the editor runs in its own
 * `s-app-window` iframe, `editor` (`editorFrame`), that the admin mounts
 * beside the app's rather than inside it. Create opens the editor straight
 * away, so everything between Create and Turn on — the step forms, the canvas
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
 * Scoped to the window's dialog rather than taken by name alone because the
 * admin's portals and the CLI's dev console answer to "Close" too. The class
 * is a hashed CSS module of the admin's, hence the substring; `Dialog` and not
 * `Header`, which matches three nested elements and would trip strict mode.
 */
const closeEditor = (page: Page) =>
  clickHoisted(
    page
      .locator('[class*="AppWindowModalDialog"]')
      .getByRole("button", { name: "Close" }),
  );

/**
 * The step panel's Save and Delete, which are section buttons rather than
 * hoisted page actions and share their names with the Rename and Delete
 * dialogs' confirms. Scoped to the aside so the two never collide.
 */
const stepPanel = (editor: FrameLocator) =>
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
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  const editor = editorFrame(page);
  await clickHoisted(
    page.getByRole("link", { name: "Workflows", exact: true }),
  );
  await expect(frame.locator('s-page[heading="Workflows"]')).toBeVisible();
  await expect(frame.getByRole("link", { name: EXISTING })).toBeVisible();

  /* Create asks for a name and a tag. The tag mirrors the name, folded,
     until the merchant edits it; after that the name can keep changing. */
  await clickHoisted(page.getByRole("button", { name: "Create workflow" }));
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  /* The step forms live in the editor window, so their Name field is a
     different element from the create dialog's. */
  const stepName = editor.getByRole("textbox", { name: "Name", exact: true });
  await nameField.fill("Cake");
  await expect(tagField).toHaveValue("cake");
  await tagField.fill("e2e-cake");
  await nameField.fill(CREATED);
  await expect(tagField).toHaveValue("e2e-cake");
  await frame.getByRole("button", { name: "Create", exact: true }).click();

  /* Create lands in the editor, as Flow's does, so the new workflow's first
     screen is the canvas rather than its detail page. */
  await expect(editor.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();

  /* Never applied: Turn on is the only commit on offer, and it is blocked
     until there is a step to apply. */
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);
  await expect(
    editor.getByText("Add a step to this workflow.", { exact: true }),
  ).toBeVisible();

  await editor.getByRole("button", { name: "Add the first step" }).click();
  await stepName.fill("Bake");
  await editor
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Stage 1", { exact: true })).toBeVisible();
  await expect(editor.getByText("✓ Saved", { exact: false })).toBeVisible();

  /* One click applies the steps and turns the switch on, and the dialog says
     both halves. */
  await clickHoisted(page.getByRole("button", { name: "Turn on" }));
  await expect(
    editor.getByText("will start a run of this workflow", { exact: false }),
  ).toBeVisible();
  await expect(
    editor.getByText("Your steps are applied at the same time.", {
      exact: true,
    }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Turn on", exact: true }).click();
  /* Applied and on: the editor now offers the other direction and nothing to
     apply. */
  await expect(page.getByRole("button", { name: "Turn off" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes" })).toHaveCount(
    0,
  );

  /* The detail page shows what is in force, with no tabs: there is one
     answer and the editor holds the other. */
  await closeEditor(page);
  await expect(frame.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Live workflow" }),
  ).toHaveCount(0);

  /* Opening the editor is not an edit: no draft, so nothing to discard. */
  await clickHoisted(page.getByRole("button", { name: "Edit", exact: true }));
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);

  /* The first saved change starts the draft — on a step that exists only on
     the workflow so far, which is the id-preserving copy under test. */
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await stepName.fill("Bake and cool");
  await stepPanel(editor)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply changes" }),
  ).toBeVisible();

  /* Two decisions, three verbs. A second step lands in its own stage;
     "Run alongside the previous step" is the only thing that makes the two
     parallel, "Run on its own" splits them back, and moving only reorders. */
  await editor.getByRole("button", { name: "Add a step", exact: true }).click();
  await stepName.fill("Ice");
  await editor
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Stage 2", { exact: true })).toBeVisible();

  await editor.getByRole("button", { name: "Edit Ice" }).click();
  await editor
    .getByRole("button", { name: "Run alongside the previous step" })
    .click();
  await expect(editor.getByText("Stage 2", { exact: true })).toHaveCount(0);

  await editor.getByRole("button", { name: "Run on its own" }).click();
  await expect(editor.getByText("Stage 2", { exact: true })).toBeVisible();

  /* Card order in the canvas: the label the card carries, top to bottom. */
  const stepOrder = () =>
    editor
      .locator('s-clickable[accessibilityLabel^="Edit "]')
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("accessibilityLabel")),
      );
  await editor.getByRole("button", { name: "Move earlier" }).click();
  await expect.poll(stepOrder).toEqual(["Edit Ice", "Edit Bake and cool"]);
  await editor.getByRole("button", { name: "Move later" }).click();
  await expect.poll(stepOrder).toEqual(["Edit Bake and cool", "Edit Ice"]);
  await stepPanel(editor)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(editor.getByText("Stage 2", { exact: true })).toHaveCount(0);

  /* Close keeps the draft, and the detail page still shows only what runs. */
  await closeEditor(page);
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();
  await expect(frame.getByText("Bake and cool")).toHaveCount(0);

  /* Discard leaves the workflow exactly as it was. Its confirm dialog belongs
     to the editor's document, not the app's. */
  await clickHoisted(page.getByRole("button", { name: "Edit", exact: true }));
  await clickHoisted(page.getByRole("button", { name: "Discard changes" }));
  await expect(
    editor.getByText("Are you sure you want to discard these changes?", {
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
     detail page comes back on the new steps. */
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await stepName.fill("Bake and rest");
  await stepPanel(editor)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await clickHoisted(page.getByRole("button", { name: "Apply changes" }));
  await expect(
    editor.getByText("This workflow is turned on.", { exact: false }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await expect(frame.getByText("Bake and rest", { exact: true })).toBeVisible();

  /* Turn off confirms too, and says what keeps going. */
  await clickHoisted(page.getByRole("button", { name: "Turn off" }));
  await expect(
    frame.getByText("Runs already in progress keep going.", { exact: false }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
});

/**
 * Turn on by count: a workflow turned on after an order was placed does not
 * start on it — unless the merchant includes the waiting orders from the
 * Turn on dialog, which moves the coverage date back to the earliest one.
 */
test("turning on a workflow offers to include earlier unfulfilled orders, and including them starts their runs", async ({
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
        active: false,
        tag: "e2e-ring",
        steps: [{ name: "Cut", team: TEAM }],
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
  await clickHoisted(
    page.getByRole("link", { name: "Workflows", exact: true }),
  );
  await frame.getByRole("link", { name: EXISTING }).click();
  await expect(frame.locator(`s-page[heading="${EXISTING}"]`)).toBeVisible();

  await clickHoisted(page.getByRole("button", { name: "Turn on" }));
  await expect(
    frame.getByText("1 earlier order is unfulfilled and would match.", {
      exact: false,
    }),
  ).toBeVisible();
  await frame.getByRole("checkbox", { name: "Include them" }).check();
  await frame.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn off" })).toBeVisible();

  /* The order page shows the run that Include them started: the line item's
     section carries a run card naming the workflow, and with a run on it the
     card carries no workflow picker at rest. Scoped to the section because
     another item's picker on the same page lists every workflow by name. */
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await frame.getByRole("link", { name: "#9101" }).click();
  await expect(frame.locator('s-page[heading="#9101"]')).toBeVisible();
  const band = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Band", exact: true }),
  });
  await expect(band.getByText(EXISTING, { exact: true })).toBeVisible();
  await expect(band.getByRole("combobox")).toHaveCount(0);
});

/**
 * The tag is the workflow's key: unique across the shop, on or off, and
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
        active: true,
        tag: "e2e-ring",
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(
    page.getByRole("link", { name: "Workflows", exact: true }),
  );
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
 * Duplicate asks for the copy's name and tag, both prefilled, and the copy
 * lands off with the tag the merchant chose.
 */
test("duplicate asks for a name and a tag, and the copy is off with the given tag", async ({
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
        active: true,
        tag: "e2e-ring",
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(
    page.getByRole("link", { name: "Workflows", exact: true }),
  );
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

  /* A free tag goes through, landing in the copy's editor — this route
     navigates the app's own frame, unlike Create, which opens the window. */
  await tagField.fill("e2e-ring-copy");
  await frame.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${SOURCE} copy"]`)).toBeVisible();

  /* The copy carries the tag the dialog collected, and is off. */
  await clickHoisted(
    page.getByRole("link", { name: "Workflows", exact: true }),
  );
  const copyRow = frame
    .locator("s-table-row")
    .filter({ hasText: `${SOURCE} copy` });
  await expect(
    copyRow.getByText("e2e-ring-copy", { exact: true }),
  ).toBeVisible();
  await expect(copyRow.getByText("Inactive", { exact: true })).toBeVisible();
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
        active: true,
        tag: "e2e-ring",
        steps: [{ name: "Cut", team: TEAM }],
      },
      {
        name: RIVAL,
        active: true,
        tag: "e2e-rush",
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(
    page.getByRole("link", { name: "Workflows", exact: true }),
  );
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
  /* Immediate, not drafted: the page still shows the workflow's own steps and
     the editor holds nothing. */
  await expect(frame.getByText("Cut", { exact: true })).toBeVisible();
});

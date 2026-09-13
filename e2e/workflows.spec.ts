import type { Page } from "@playwright/test";

import { expect, test } from "@playwright/test";

import { clickHoisted, editorFrame, gotoApp, hoistedEnabled } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The three item-workflow screens end to end: the list, the read-only detail
 * page, and the editor.
 *
 * What it is really here to prove is the draft lifecycle, because that is the
 * part no unit test can see: opening the editor writes nothing, the first
 * saved change starts the draft, Apply promotes it and the Draft tab
 * disappears, and Discard throws it away. It also covers the one thing that
 * makes the lazy draft possible — editing a step that only exists on the
 * workflow so far, whose id the draft then carries (`ensureDraft`).
 *
 * Title-bar controls (Create, Edit, Apply, Turn on, Close, More actions) are
 * hoisted out of the iframe by App Bridge, so they are driven with
 * `clickHoisted` and are all buttons there. `clickHoisted` waits for the
 * hoisted proxy to be enabled, which matters here more than anywhere: the
 * editor's Apply and Discard are disabled until the `ShopAgent` socket
 * identifies, a second or two after the window paints.
 *
 * Two frames, and which one a control is in is not a detail: the list and
 * detail pages are `frame` (`appFrame`), while the editor runs in its own
 * `s-app-window` iframe, `editor` (`editorFrame`), that the admin mounts
 * beside the app's rather than inside it. Create opens the editor straight
 * away, so everything between Create and Apply — the trigger card, Edit tag,
 * the step forms, the canvas — is `editor`, and the detail page only comes
 * back once the window hides. Modals render in whichever frame opened them.
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

test("workflows create, edit, apply, and discard through the draft", async ({
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
        tags: ["e2e-ring"],
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
  await expect(
    editor.getByText("Starts when an order contains a product tagged", {
      exact: false,
    }),
  ).toBeVisible();

  /* The tag is edited from the trigger; Cancel leaves the workflow alone. */
  await editor.getByRole("button", { name: "Edit tag" }).click();
  await expect(
    editor.getByRole("textbox", { name: "Tag", exact: true }),
  ).toHaveValue("e2e-cake");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await editor.getByRole("button", { name: "Add the first step" }).click();
  await stepName.fill("Bake");
  await editor
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Stage 1", { exact: true })).toBeVisible();

  /* Off, so Apply needs no confirmation. */
  await clickHoisted(page.getByRole("button", { name: "Apply changes" }));
  await expect(frame.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await expect(frame.getByRole("button", { name: "Draft" })).toHaveCount(0);

  /* Turn on is its own decision, and it confirms. */
  await clickHoisted(page.getByRole("button", { name: "Turn on" }));
  await expect(
    frame.getByText("will start a run of this workflow", { exact: false }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Turn on", exact: true }).click();
  /* The state badge sits in the `accessory` slot, which App Bridge hoists out
     of the frame, so the proof that it is on is the title bar offering the
     other direction. */
  await expect(page.getByRole("button", { name: "Turn off" })).toBeVisible();

  /* Opening the editor is not an edit: no draft, so nothing to discard. */
  await clickHoisted(page.getByRole("button", { name: "Edit", exact: true }));
  await expect(
    editor.getByText("Nothing is saved yet.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);

  /* The first saved change starts the draft — on a step that exists only on
     the workflow so far, which is the id-preserving copy under test. */
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await stepName.fill("Bake and cool");
  await editor.getByRole("button", { name: "Save step" }).click();
  await expect(
    editor.getByText("Nothing is saved yet.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toBeVisible();

  /* Two decisions, three verbs. A second step lands in its own stage;
     "Run alongside the previous step" is the only thing that makes the two
     parallel, "Run on its own" splits them back, and moving only reorders —
     both stages stay solo across the move. */
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
  await expect(
    editor.getByText("Stage 1 · at the same time", { exact: true }),
  ).toBeVisible();
  await expect(editor.getByText("Stage 2", { exact: true })).toHaveCount(0);

  await editor.getByRole("button", { name: "Run on its own" }).click();
  await expect(editor.getByText("Stage 2", { exact: true })).toBeVisible();
  await expect(
    editor.getByText("Stage 1 · at the same time", { exact: true }),
  ).toHaveCount(0);

  /* Card order in the canvas: the label the card carries, top to bottom. */
  const stepOrder = () =>
    editor
      .locator('s-clickable[accessibilityLabel^="Edit "]')
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("accessibilityLabel")),
      );
  await editor.getByRole("button", { name: "Move earlier" }).click();
  await expect.poll(stepOrder).toEqual(["Edit Ice", "Edit Bake and cool"]);
  await expect(editor.getByText("Stage 1", { exact: true })).toBeVisible();
  await expect(editor.getByText("Stage 2", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Move later" }).click();
  await expect.poll(stepOrder).toEqual(["Edit Bake and cool", "Edit Ice"]);
  await editor.getByRole("button", { name: "Remove step" }).click();
  await expect(editor.getByText("Stage 2", { exact: true })).toHaveCount(0);

  /* Close keeps the draft, and the two tabs show the two answers. */
  await closeEditor(page);
  await frame.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(frame.getByText("Bake and cool")).toBeVisible();
  await frame.getByRole("button", { name: "Live workflow" }).click();
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();

  /* Discard leaves the workflow exactly as it was, and the tab goes with it.
     Its confirm dialog belongs to the editor's document, not the app's. */
  await clickHoisted(page.getByRole("button", { name: "Edit", exact: true }));
  await clickHoisted(page.getByRole("button", { name: "Discard changes" }));
  await editor.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);
  await expect(
    editor.getByText("Nothing is saved yet.", { exact: false }),
  ).toBeVisible();
  await expect(editor.getByText("Bake", { exact: true })).toBeVisible();

  /* Apply on a workflow that is ON asks first, and that confirm is the one
     place a hoisted title-bar button has to open a modal back inside the
     window's own document. Applying from in there closes the window and the
     detail page comes back on the new live steps. */
  await editor.getByRole("button", { name: "Edit Bake" }).click();
  await stepName.fill("Bake and rest");
  await editor.getByRole("button", { name: "Save step" }).click();
  await clickHoisted(page.getByRole("button", { name: "Apply changes" }));
  await expect(
    editor.getByText("Orders that come in after you apply", { exact: false }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Draft", exact: true }),
  ).toHaveCount(0);
  await expect(frame.getByText("Bake and rest", { exact: true })).toBeVisible();
});

/**
 * The order workflow: the shop's singleton, reached from its own nav entry.
 * It exists from the start, off and empty, has no Rename or Delete (so no
 * More actions at all), and follows the same four verbs as an item workflow:
 * Edit, add steps, Apply, Turn on. Its trigger box is the shop-wide rule.
 */
test("the order workflow opens from the nav, has no rename or delete, and turns on after steps are applied", async ({
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
        tags: ["e2e-ring"],
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
  );

  const frame = await gotoApp(page);
  const editor = editorFrame(page);
  await clickHoisted(
    page.getByRole("link", { name: "Order workflow", exact: true }),
  );
  await expect(frame.locator('s-page[heading="Order workflow"]')).toBeVisible();
  /* Scoped to the section: the Turn on dialog carries the same sentence. */
  await expect(
    frame
      .locator("s-section")
      .getByText("Runs once per paid order", { exact: false }),
  ).toBeVisible();
  /* No steps yet: Turn on is offered but disabled, with its reason. */
  await expect(
    frame.getByText("This workflow has no steps.", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() => hoistedEnabled(page.getByRole("button", { name: "Turn on" })))
    .toBe(false);
  /* No Rename, Delete, or Duplicate anywhere: the admin's own title bar
     carries a "More actions" of its own, so the menu items are the proof. */
  for (const name of ["Rename", "Delete", "Duplicate"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );

  /* The editor: the same steps canvas, no tag, in its own window. */
  await clickHoisted(page.getByRole("button", { name: "Edit", exact: true }));
  await expect(editor.getByRole("button", { name: "Edit tag" })).toHaveCount(0);
  for (const name of ["Rename", "Delete", "Duplicate"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await editor.getByRole("button", { name: "Add the first step" }).click();
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Pack");
  await editor
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await editor.getByRole("button", { name: "Add step" }).click();
  await expect(editor.getByText("Stage 1", { exact: true })).toBeVisible();
  await clickHoisted(page.getByRole("button", { name: "Apply changes" }));
  await expect(frame.locator('s-page[heading="Order workflow"]')).toBeVisible();

  /* Turn on: a fresh shop has no waiting orders, so the dialog is a plain
     confirm, and the page then says what "on" covers. It was disabled a
     moment ago for want of steps; `clickHoisted` waits that out. */
  await clickHoisted(page.getByRole("button", { name: "Turn on" }));
  await expect(
    frame.getByText("Checking earlier orders", { exact: false }),
  ).toHaveCount(0);
  await expect(frame.getByText("would match.", { exact: false })).toHaveCount(
    0,
  );
  await frame.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn off" })).toBeVisible();
  await expect(
    frame
      .locator("s-section")
      .getByText("Applies to orders placed since", { exact: false }),
  ).toBeVisible();

  /* A stale link to the singleton under the item routes lands here. */
  await expect(
    frame.getByRole("link", { name: "Workflows", exact: true }),
  ).toHaveCount(0);
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
        tags: ["e2e-ring"],
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

  /* The order page shows the run that Include them started. */
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await frame.getByRole("link", { name: "#9101" }).click();
  await expect(frame.locator('s-page[heading="#9101"]')).toBeVisible();
  await expect(
    frame.getByText(`${EXISTING} started for 1 item`, { exact: false }),
  ).toBeVisible();
});

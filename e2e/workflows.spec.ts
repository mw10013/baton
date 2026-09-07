import type { Page } from "@playwright/test";

import { expect, test } from "@playwright/test";

import { clickHoisted, gotoApp } from "./app";
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
 * `clickHoisted` and are all buttons there — the editor's Close is an `s-link`
 * in the page's `breadcrumb-actions` slot and still arrives as a button. The
 * modals they open render back inside the frame, as does everything else.
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
 * The editor's Close. Scoped to the breadcrumb region because the admin also
 * carries a portal close button and the dev console's, and all three answer to
 * the name "Close".
 */
const closeEditor = (page: Page) =>
  clickHoisted(
    page.getByLabel(/^Breadcrumbs/u).getByRole("button", { name: "Close" }),
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
  await clickHoisted(
    page.getByRole("link", { name: "Workflows", exact: true }),
  );
  await expect(frame.locator('s-page[heading="Workflows"]')).toBeVisible();
  await expect(frame.getByRole("link", { name: EXISTING })).toBeVisible();

  /* Create asks for a name and nothing else, then hands over to the editor. */
  await clickHoisted(page.getByRole("button", { name: "Create workflow" }));
  const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  await nameField.fill(CREATED);
  await frame.getByRole("button", { name: "Create", exact: true }).click();
  await expect(frame.locator(`s-page[heading="${CREATED}"]`)).toBeVisible();
  await expect(
    frame.getByText("No product tags yet, so this never starts.", {
      exact: false,
    }),
  ).toBeVisible();

  /* Tags are a property of the trigger, set where the sentence about them is. */
  await frame
    .getByRole("textbox", { name: "Add a product tag" })
    .fill("e2e-cake");
  await frame.getByRole("button", { name: "Add tag" }).click();
  await expect(
    frame.getByText("Starts when an order contains a product tagged", {
      exact: false,
    }),
  ).toBeVisible();

  await frame.getByRole("button", { name: "Add the first step" }).click();
  await nameField.fill("Bake");
  await frame
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await frame.getByRole("button", { name: "Add step" }).click();
  await expect(frame.getByText("Stage 1", { exact: true })).toBeVisible();

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
    frame.getByText("Nothing is saved yet.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);

  /* The first saved change starts the draft — on a step that exists only on
     the workflow so far, which is the id-preserving copy under test. */
  await frame.getByRole("button", { name: "Edit Bake" }).click();
  await nameField.fill("Bake and cool");
  await frame.getByRole("button", { name: "Save step" }).click();
  await expect(
    frame.getByText("Nothing is saved yet.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toBeVisible();

  /* Two decisions, three verbs. A second step lands in its own stage;
     "Run alongside the previous step" is the only thing that makes the two
     parallel, "Run on its own" splits them back, and moving only reorders —
     both stages stay solo across the move. */
  await frame.getByRole("button", { name: "Add a step", exact: true }).click();
  await nameField.fill("Ice");
  await frame
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption({ label: TEAM });
  await frame.getByRole("button", { name: "Add step" }).click();
  await expect(frame.getByText("Stage 2", { exact: true })).toBeVisible();

  await frame.getByRole("button", { name: "Edit Ice" }).click();
  await frame
    .getByRole("button", { name: "Run alongside the previous step" })
    .click();
  await expect(
    frame.getByText("Stage 1 · at the same time", { exact: true }),
  ).toBeVisible();
  await expect(frame.getByText("Stage 2", { exact: true })).toHaveCount(0);

  await frame.getByRole("button", { name: "Run on its own" }).click();
  await expect(frame.getByText("Stage 2", { exact: true })).toBeVisible();
  await expect(
    frame.getByText("Stage 1 · at the same time", { exact: true }),
  ).toHaveCount(0);

  /* Card order in the canvas: the label the card carries, top to bottom. */
  const stepOrder = () =>
    frame
      .locator('s-clickable[accessibilityLabel^="Edit "]')
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("accessibilityLabel")),
      );
  await frame.getByRole("button", { name: "Move earlier" }).click();
  await expect.poll(stepOrder).toEqual(["Edit Ice", "Edit Bake and cool"]);
  await expect(frame.getByText("Stage 1", { exact: true })).toBeVisible();
  await expect(frame.getByText("Stage 2", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Move later" }).click();
  await expect.poll(stepOrder).toEqual(["Edit Bake and cool", "Edit Ice"]);
  await frame.getByRole("button", { name: "Remove step" }).click();
  await expect(frame.getByText("Stage 2", { exact: true })).toHaveCount(0);

  /* Close keeps the draft, and the two tabs show the two answers. */
  await closeEditor(page);
  await frame.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(frame.getByText("Bake and cool")).toBeVisible();
  await frame.getByRole("button", { name: "Live workflow" }).click();
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();

  /* Discard leaves the workflow exactly as it was, and the tab goes with it. */
  await clickHoisted(page.getByRole("button", { name: "Edit", exact: true }));
  await clickHoisted(page.getByRole("button", { name: "Discard changes" }));
  await frame.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);
  await closeEditor(page);
  await expect(
    frame.getByRole("button", { name: "Draft", exact: true }),
  ).toHaveCount(0);
  await expect(frame.getByText("Bake", { exact: true })).toBeVisible();
});

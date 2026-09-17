import { expect, test } from "@playwright/test";

import { clickHoisted, gotoApp, hoistedEnabled } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The window sync end to end, against the real sandbox: click, and real orders
 * appear.
 *
 * This is the one test that exercises the whole chain nothing else can —
 * `@callable() syncOrders` over the authenticated socket, `runWorkflow`, a real
 * Shopify bulk operation, the poll loop, the NDJSON stream inside the Durable
 * Object, and the broadcast that makes the table refresh without a reload. Every
 * piece of that has an integration test with its neighbours stubbed; only this
 * one proves they are wired to each other.
 *
 * Timings are generous because the run is Shopify's, not ours: submitting the
 * bulk operation, waiting for Shopify to execute it, and the poll schedule's
 * first 5-second sleep put a realistic floor around 15-30s even for a sandbox
 * with fewer than a hundred orders. A two-minute budget is roughly 4x that
 * floor, not a hedge against an unknown.
 *
 * The sync button is the gate on both ends: it disables while `SyncState` holds
 * a reservation and re-enables when the completion callback clears it, so
 * "enabled again" is the honest signal that the run finished — more honest than
 * waiting for rows, which start landing mid-stream.
 *
 * Both action buttons sit in the page's `primary-action` slot, which App Bridge
 * hoists out of the iframe into the admin title bar, so they are located on
 * `page`, not `frame`, and driven through the hoisted helpers. The orders index
 * always slots the sync button, and on a shop with nothing stored the empty
 * state carries a second copy inside the frame; the hoisted one is out of the
 * iframe, so the two locators stay disjoint. The test starts from whichever is
 * enabled first, so it passes on both an empty shop (a wiped local Durable
 * Object) and one that has synced before.
 */
test("orders screen syncs the window and lists orders", async ({ page }) => {
  test.setTimeout(180_000);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  const syncName = { name: /^Sync last \d+ days$/u };
  const hoistedSync = page.getByRole("button", syncName);
  const emptyStateSync = frame.getByRole("button", syncName);
  await expect
    .poll(
      async () =>
        (await hoistedEnabled(hoistedSync)) ||
        (await emptyStateSync.isEnabled().catch(() => false)),
    )
    .toBe(true);
  const sync = (await hoistedSync.count()) > 0 ? hoistedSync : emptyStateSync;

  /* The completion signal is a *new* `Last synced` timestamp, not the transient
     "Syncing…" text and not the button re-enabling. A sandbox window syncs in
     seconds, so the in-flight state can come and go between polls, and the
     button is momentarily enabled between the click and the state update —
     both would pass without proving anything ran. Comparing the timestamp
     against the one on screen beforehand is the only assertion that can only
     be satisfied by a run that actually finished. */
  const status = frame.getByText(/^(?:Last synced|Never synced|Syncing)/u);
  const before = await status.textContent();

  await clickHoisted(sync);

  await expect
    .poll(
      async () => {
        const text = (await status.textContent()) ?? "";
        return text.startsWith("Last synced") && text !== before;
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  const rows = frame.locator("s-table-row");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });

  /* The order name links to the detail page, which is the only place
     personalization (`customAttributes`) and product tags are rendered — the
     fields the bulk path exists to collect. */
  await rows.first().getByRole("link").first().click();
  /* One card per line item, each an unslotted top-level section headed by the
     item's own title — which is a real synced order's, so the selector is
     structural rather than a title this spec cannot know. The aside's sections
     are slotted, so the first unslotted one is the first item card. */
  await expect(frame.locator("s-section:not([slot])").first()).toBeVisible();

  const resync = page.getByRole("button", { name: "Resync from Shopify" });
  await expect.poll(() => hoistedEnabled(resync)).toBe(true);
  await clickHoisted(resync);
  await expect
    .poll(() => hoistedEnabled(resync), { timeout: 30_000 })
    .toBe(true);
});

/**
 * The waiting-on column on the orders index: the team holding each open
 * order, read from the same `readyWhere` the worker queue runs on.
 */
test("the orders index names the team an open order is waiting on", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.orders@example.com";
  const TEAM = "E2E Bench";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Ring",
        tag: "e2e-ring",
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
    [
      {
        n: 9201,
        lineItems: [{ title: "E2E Band", quantity: 1, tags: ["e2e-ring"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));

  /* The waiting-on column, on the way past: the seeded run's first step is on
     E2E Bench, so the row names the team that is holding the order. Located
     inside the row, because the filter control on the same page carries the
     same words. */
  await expect(
    frame.locator("s-table-header", { hasText: "Waiting on" }),
  ).toBeVisible();
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9201" })
      .getByText(TEAM, { exact: true }),
  ).toBeVisible();

  await frame.getByRole("link", { name: "#9201" }).click();
  await expect(frame.locator('s-page[heading="#9201"]')).toBeVisible();
});

/**
 * Order-number search: the field narrows the table to the one order, the chip
 * says a search is on, and removing it puts the rest of the list back. Two
 * orders are seeded because a filter that cannot hide anything proves nothing.
 */
test("the orders index searches by order number and clears back to the list", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.orders@example.com";
  const TEAM = "E2E Bench";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Ring",
        tag: "e2e-ring",
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
    [
      {
        n: 9301,
        lineItems: [{ title: "E2E Band", quantity: 1, tags: ["e2e-ring"] }],
      },
      {
        n: 9302,
        lineItems: [{ title: "E2E Band", quantity: 1, tags: ["e2e-ring"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();

  /* The digits alone: `normaliseOrderSearch` supplies the `#`, which is what
     the chip then shows back. Enter submits; the field does not debounce. */
  await frame.getByRole("textbox", { name: "Order number" }).fill("9301");
  await frame.getByRole("textbox", { name: "Order number" }).press("Enter");
  await expect(frame.getByRole("link", { name: "#9301" })).toBeVisible();
  await expect(frame.getByRole("link", { name: "#9302" })).toHaveCount(0);
  const chip = frame.getByRole("button", { name: "Order #9301", exact: true });
  await expect(chip).toBeVisible();

  /* Removing the chip is the same write as clearing the field, so the list
     comes back and the field empties with it. */
  await chip.click();
  await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();
  await expect(
    frame.getByRole("textbox", { name: "Order number" }),
  ).toHaveValue("");

  /* A number no order carries: the empty state names it rather than falling
     back to the stage copy. */
  await frame.getByRole("textbox", { name: "Order number" }).fill("9999");
  await frame.getByRole("textbox", { name: "Order number" }).press("Enter");
  await expect(
    frame.getByText('No order matches "#9999".', { exact: false }),
  ).toBeVisible();
  /* `button`, not `link`: an `s-link` with no `href` is an action, and that
     is what it exposes to a screen reader. */
  await frame.getByRole("button", { name: "Clear the search" }).click();
  await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();
});

/**
 * The merchant's interventions end to end, against a seeded two-stage run:
 * Manage opens, Mark done records the merchant on the step, Reopen takes it
 * back, and Block / Unblock move the run flag. Each assertion reads the row's
 * own attribution rather than a toast, because the row is what the next person
 * to look at this order will see.
 *
 * No extra admin sign-in: the `e2e` project reuses the setup project's storage
 * state, so this is one more page load on the session the file already has.
 */
test("the merchant marks a step done, reopens it, and blocks the run", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.manage@example.com";
  const CUT_TEAM = "E2E Manage Cut";
  const POLISH_TEAM = "E2E Manage Polish";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [
      { name: CUT_TEAM, members: [MEMBER] },
      { name: POLISH_TEAM, members: [MEMBER] },
    ],
    [
      {
        name: "E2E Manage Cuff",
        tag: "e2e-manage",
        steps: [
          { name: "Cut", team: CUT_TEAM },
          { name: "Polish", team: POLISH_TEAM },
        ],
      },
    ],
    [
      {
        n: 9301,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: ["e2e-manage"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await frame.getByRole("link", { name: "#9301" }).click();
  await expect(frame.locator('s-page[heading="#9301"]')).toBeVisible();

  /* Collapsed, the run offers nothing to click but the disclosure: the trail
     is a glance, and every action lives behind Manage. */
  await expect(frame.getByRole("button", { name: "Mark done" })).toBeHidden();
  await frame.getByRole("button", { name: "Manage" }).click();

  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(frame.getByText("Done by Merchant")).toBeVisible();

  await frame.getByRole("button", { name: "Reopen" }).click();
  await expect(frame.getByText("Reopened by Merchant")).toBeVisible();
  await expect(frame.getByText("Done by Merchant")).toBeHidden();

  /* Both stages done takes the run to `done`. The card's badge says it in
     merchant words, not `WorkflowRun.status`. */
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(frame.getByText("Done by Merchant")).toBeVisible();
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(frame.getByText("Done", { exact: true })).toBeVisible();
});

/**
 * Reopen is not offered once someone downstream has moved — the same rule the
 * worker's Undo obeys, with the instruction instead of "ask them". Both stages
 * are marked done from this page, so Polish is the blocker on Cut's row.
 */
test("the merchant cannot reopen a step whose next stage is done", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.reopen@example.com";
  const CUT_TEAM = "E2E Reopen Cut";
  const POLISH_TEAM = "E2E Reopen Polish";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [
      { name: CUT_TEAM, members: [MEMBER] },
      { name: POLISH_TEAM, members: [MEMBER] },
    ],
    [
      {
        name: "E2E Reopen Cuff",
        tag: "e2e-reopen",
        steps: [
          { name: "Cut", team: CUT_TEAM },
          { name: "Polish", team: POLISH_TEAM },
        ],
      },
    ],
    [
      {
        n: 9302,
        advance: 2,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: ["e2e-reopen"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await frame.getByRole("link", { name: "#9302" }).click();
  await frame.getByRole("button", { name: "Manage" }).click();

  await expect(
    frame.getByText(`${POLISH_TEAM} started Polish · reopen it first`),
  ).toBeVisible();
  /* Polish itself is the last stage, so exactly one Reopen is on the page. */
  await expect(frame.getByRole("button", { name: "Reopen" })).toHaveCount(1);
});

/**
 * Block from the disclosure, unblock from the strip the block raises on the
 * card. The reason is merchant prose, so it renders as its own paragraph in
 * that strip rather than inside the badge, and the strip names the step the run
 * is stuck on. `Unblock` is offered in both places — the strip and the still-open
 * disclosure — so the click takes the first of the two.
 */
test("the merchant blocks a run with a reason and unblocks it", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.block@example.com";
  const TEAM = "E2E Block Bench";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Block Cuff",
        tag: "e2e-block",
        steps: [{ name: "Cut", team: TEAM }],
      },
    ],
    [
      {
        n: 9303,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: ["e2e-block"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await frame.getByRole("link", { name: "#9303" }).click();
  await frame.getByRole("button", { name: "Manage" }).click();

  await frame.getByLabel("Reason").fill("Out of walnut stock");
  await frame.getByRole("button", { name: "Block" }).click();
  await expect(
    frame.getByText("Blocked \u00B7 Cut", { exact: true }),
  ).toBeVisible();
  await expect(frame.getByText("Out of walnut stock")).toBeVisible();
  await expect(frame.getByText("Blocked by Merchant")).toBeVisible();

  await frame.getByRole("button", { name: "Unblock" }).first().click();
  await expect(frame.getByText("Blocked by Merchant")).toBeHidden();
  await expect(frame.getByRole("button", { name: "Block" })).toBeVisible();
});

/**
 * One workflow per line item, at the two places a merchant meets it.
 *
 * Two active workflows with a tag each, both on the same product, is a state
 * the app refuses to *create* — Apply and Turn on hold one active workflow per
 * tag — and the local seed is what makes it reachable, because it writes
 * definitions straight into SQLite. That is deliberate: the rule is enforced at
 * the switch, but the runtime has to cope with the state anyway (two workflows
 * whose tags land on one product through a merchant's retagging in Shopify),
 * and this is the fixture for it.
 *
 * So: the item matches two, nothing starts, the index shows the order under
 * _Choose a workflow_, and the order page asks. Then the same item is moved to
 * the other workflow, which is a replace and has to be confirmed.
 */
test("an item matching two workflows waits for the merchant to choose, then changes", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const MEMBER = "e2e.orders@example.com";
  const TEAM = "E2E Bench";
  const ENGRAVING = "E2E Engraving";
  const RUSH = "E2E Rush";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: ENGRAVING,
        tag: "e2e-engraved",
        steps: [{ name: "Engrave", team: TEAM }],
      },
      {
        name: RUSH,
        tag: "e2e-rush",
        steps: [{ name: "Expedite", team: TEAM }],
      },
    ],
    [
      {
        n: 9401,
        lineItems: [
          {
            title: "E2E Twice",
            quantity: 1,
            tags: ["e2e-engraved", "e2e-rush"],
          },
        ],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));

  /* The stage strip carries the new chip with a count, and the row's badge
     says the same thing. Scoped to the row for the badge, because the chip
     above the table has the same words. */
  await expect(
    frame.getByRole("button", { name: /^Choose a workflow/u }),
  ).toBeVisible();
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9401" })
      .getByText("Choose a workflow", { exact: true }),
  ).toBeVisible();

  await frame.getByRole("link", { name: "#9401" }).click();
  await expect(frame.locator('s-page[heading="#9401"]')).toBeVisible();

  /* An item with no run carries the picker at rest, and on an ambiguous one it
     offers exactly the two that matched — the item's sentence names them both,
     with the tag that pulled each one in. */
  const item = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Twice", exact: true }),
  });
  await expect(
    item.getByText(
      `Two workflows match this item: ${ENGRAVING} (\u201Ce2e-engraved\u201D) and ${RUSH} (\u201Ce2e-rush\u201D). Choose one to start.`,
      { exact: true },
    ),
  ).toBeVisible();
  const picker = item.getByRole("combobox", { name: "Choose workflow" });
  await expect(picker.getByRole("option")).toHaveCount(2);

  await picker.selectOption({ label: ENGRAVING });
  await item.getByRole("button", { name: "Choose", exact: true }).click();

  /* The run replaces the ask, and with it the picker: an item with a live run
     carries no workflow control at rest, only the header's Manage.

     Wait on that button before naming the workflow: while the picker is open
     the item carries the workflow's name three more times (the `s-option`, the
     native `option`, and the select's own value), which is a strict-mode
     violation rather than a retryable failure. */
  const manage = item.getByRole("button", { name: "Manage" });
  await expect(manage).toBeVisible();
  await expect(
    item.getByText("Choose one to start.", { exact: false }),
  ).toHaveCount(0);
  await expect(item.getByText(ENGRAVING, { exact: true })).toBeVisible();

  /* Changing is a rare intervention, so it is inside the disclosure with the
     other ones. A pending run with nothing started changes with no
     confirmation: the dialog is for work already done. */
  await manage.click();
  const change = item.getByRole("button", {
    name: "Change workflow",
    exact: true,
  });
  await change.click();
  await item
    .getByRole("combobox", { name: "Change workflow" })
    .selectOption({ label: RUSH });
  await item.getByRole("button", { name: "Change", exact: true }).click();

  /* The change replaces the run, so the disclosure the old one had open closes
     with it — `managing` and `changeOpen` are both keyed by run id. The picker
     going is the gate: `Manage` is on the card in every state, so waiting on it
     would pass before the write landed and read the workflow's name off the
     still-open select. */
  await expect(
    item.getByRole("combobox", { name: "Change workflow" }),
  ).toHaveCount(0);
  await expect(manage).toBeVisible();
  await expect(item.getByText(RUSH, { exact: true })).toBeVisible();
  /* The replaced run stays on the page, cancelled: a run is the record of a
     decision, and the merchant should see the one they undid. */
  await expect(item.getByText("Cancelled", { exact: true })).toBeVisible();

  /* And the order has left the stage: one live run, nothing left to choose. */
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9401" })
      .getByText("Choose a workflow", { exact: true }),
  ).toHaveCount(0);
});

import { expect, type Page, test } from "@playwright/test";

import { clickHoisted, gotoApp, hoistedEnabled } from "./app";
import { seedConfig, seedMembers } from "./seed";

/**
 * The import end to end, against the real sandbox: click, and real orders
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
 * bulk operation, waiting for Shopify to execute it, and the first 5-second
 * poll sleep put a realistic floor around 15-30s even for a sandbox with fewer
 * than a hundred orders. A two-minute budget is roughly 4x that floor, not a
 * hedge against an unknown.
 *
 * The import button is the gate on both ends: it disables while the Agents SDK
 * tracks a run and re-enables when the completion callback deletes that row,
 * so "enabled again" is the honest signal that the run finished — more honest
 * than waiting for rows, which start landing mid-stream.
 *
 * Both action buttons sit in the page's `primary-action` slot, which App Bridge
 * hoists out of the iframe into the admin title bar, so they are located on
 * `page`, not `frame`, and driven through the hoisted helpers.
 *
 * The hoisted copy is the one to drive, and the only one this test names. The
 * index slots it unconditionally, while the identically named twin inside the
 * empty state exists only while the shop has no open orders — so a test that
 * picked between them would be picking against a list that fills underneath
 * it: on a shop with orders the empty state is on screen for exactly as long
 * as it takes the first page to paint, and a locator captured in that window
 * points at a button that is about to be removed.
 */
test("orders screen imports open orders and lists them", async ({ page }) => {
  test.setTimeout(180_000);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  const sync = page.getByRole("button", { name: "Import open orders" });
  await expect.poll(() => hoistedEnabled(sync)).toBe(true);

  /* The completion signal is a *new* `Last imported` timestamp, not the
     transient "Importing…" text and not the button re-enabling. A sandbox
     imports in seconds, so the in-flight state can come and go between polls,
     and the button is momentarily enabled between the click and the state
     update — both would pass without proving anything ran. Comparing the
     timestamp against the one on screen beforehand is the only assertion that
     can only be satisfied by a run that actually finished.

     A shop that has never imported shows no line at all, so the text is read
     through `count()` first: `textContent()` on a locator that matches
     nothing does not reject, it waits — and with no action timeout
     configured, it waits out the whole test. */
  const status = frame.getByText(/^(?:Last imported|Importing)/u);
  const statusText = async () =>
    (await status.count()) > 0 ? await status.textContent() : null;
  const before = await statusText();

  await clickHoisted(sync);

  await expect
    .poll(
      async () => {
        const text = await statusText();
        return (
          text !== null && text.startsWith("Last imported") && text !== before
        );
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
 * order, read from the same `readyWhere` the member's run list runs on.
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
        tasks: [{ name: "Cut", team: TEAM }],
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

  /* The waiting-on column, on the way past: the seeded run's first task is on
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
        tasks: [{ name: "Cut", team: TEAM }],
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
     back to the filter copy. */
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
 * The merchant's interventions end to end, against a seeded two-step run:
 * Manage opens, Mark done records the merchant on the task, Reopen takes it
 * back, and Block / Unblock move the run flag. Each assertion reads the row's
 * own attribution rather than a toast, because the row is what the next person
 * to look at this order will see.
 *
 * No extra admin sign-in: the `e2e` project reuses the setup project's storage
 * state, so this is one more page load on the session the file already has.
 */
test("the merchant marks a task done, reopens it, and blocks the run", async ({
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
        tasks: [
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

  /* The drawer draws the member page's step cards (`RunSteps`). A task that
     has a team shows it as a line, not an open picker: the picker waits
     behind Reassign, and Cancel puts the line back. */
  await expect(frame.getByText("Step 1", { exact: true })).toBeVisible();
  const assignTeam = frame.getByRole("combobox", { name: "Assign team" });
  await expect(assignTeam).toHaveCount(0);
  const item = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Cuff", exact: true }),
  });
  await item.getByRole("button", { name: "Reassign" }).first().click();
  await expect(assignTeam).toBeVisible();
  await item.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(assignTeam).toHaveCount(0);

  /* The badge carries the state; the line under it is the team, then who. */
  const doneByMerchant = frame.getByText(`${CUT_TEAM} \u00B7 Merchant`);
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(doneByMerchant).toBeVisible();

  await frame.getByRole("button", { name: "Reopen" }).click();
  await expect(frame.getByText("Reopened by Merchant")).toBeVisible();
  await expect(doneByMerchant).toBeHidden();
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();

  /* Both steps done takes the run to `done`. The card says it in merchant
     words, not `WorkflowRun.status`: its badge, and the now line counting the
     steps. */
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(doneByMerchant).toBeVisible();
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(
    frame.getByText("Done \u00B7 2 steps", { exact: true }),
  ).toBeVisible();
});

/**
 * Put back from Manage, the merchant's inverse of a worker's Start
 * (`WorkflowRunRepository.unstartTask`). There is no merchant Start, so the
 * seed has the member start the task; Put back returns it to Ready.
 */
test("the merchant puts back a task a member started", async ({ page }) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.putback@example.com";
  const CUT_TEAM = "E2E Put Back Cut";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: CUT_TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Put Back Cuff",
        tag: "e2e-putback",
        tasks: [{ name: "Cut", team: CUT_TEAM }],
      },
    ],
    [
      {
        n: 9304,
        started: true,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: ["e2e-putback"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await frame.getByRole("link", { name: "#9304" }).click();
  await frame.getByRole("button", { name: "Manage" }).click();

  /* The card's run badge also says In progress, so read the task's line:
     team, who started it, since when. */
  await expect(
    frame.getByText(`${CUT_TEAM} \u00B7 ${MEMBER} \u00B7 since`),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Put back" }).click();
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Put back" })).toHaveCount(0);
});

/**
 * Reopen is not offered once someone downstream has moved — the same rule the
 * worker's Undo obeys (`Domain.undoBlockedBy`), but this is the only screen
 * that puts the blocker into words, because it is the only one that can act
 * on it. The assertion is the whole rendered sentence, which is what pins the
 * wording now that it lives inline in the route rather than in `Domain`:
 * task first, team parenthetical, and the verb supplied by the prefix. Both
 * steps are marked done from this page, so Polish is the blocker on Cut's
 * row.
 */
test("the merchant cannot reopen a task whose next step is done", async ({
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
        tasks: [
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
    frame.getByText(
      `Can’t reopen: Polish (${POLISH_TEAM}) already started — put it back or reopen it first`,
    ),
  ).toBeVisible();
  /* Polish itself is the last step, so exactly one Reopen is on the page. */
  await expect(frame.getByRole("button", { name: "Reopen" })).toHaveCount(1);
});

/**
 * Block from the disclosure, then edit the reason and unblock from the red
 * banner the block raises on the card — the member page's `FlagBanner`. Block
 * and the reason edit share one modal, keyed on whether the run is blocked.
 * The reason is merchant prose, so it renders as the banner's body rather
 * than inside the badge, and the Now line still says where the run is.
 * `Unblock` is on the page once, in the banner: the Manage row drops Block
 * while blocked and never repeats Unblock. Nothing in the Manage row is red.
 * The run note is always on the card, blank as the subdued word "Note", with
 * one Edit and no Add note.
 */
test("the merchant blocks a run with a reason, edits it, notes the run, and unblocks it", async ({
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
        tasks: [{ name: "Cut", team: TEAM }],
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
  /* No reason field on the card: the only one is in the closed modal. */
  await expect(frame.getByRole("textbox", { name: "Reason" })).toBeHidden();
  const item = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Cuff", exact: true }),
  });
  /* Every action in the Manage row is reversible in one tap, so none is red;
     red is for the modal submit that commits a loss. */
  await expect(item.locator('s-button[tone="critical"]')).toHaveCount(0);

  const blockModal = frame.locator("s-modal#run-block");
  await frame.getByRole("button", { name: "Block", exact: true }).click();
  await expect(blockModal.getByText("Block #9303?")).toBeVisible();
  await blockModal
    .getByRole("textbox", { name: "Reason" })
    .fill("Out of walnut stock");
  await blockModal.getByRole("button", { name: "Block", exact: true }).click();
  const banner = item.locator('s-banner[heading="Blocked"]');
  await expect(banner).toBeVisible();
  await expect(banner.getByText("Out of walnut stock")).toBeVisible();
  await expect(banner.getByText("Merchant", { exact: false })).toBeVisible();
  /* The banner says why it stopped; the Now line still says where. */
  await expect(
    item.getByText("Step 1 of 1 \u00B7 Cut", { exact: true }),
  ).toBeVisible();
  await expect(
    item.getByRole("button", { name: "Block", exact: true }),
  ).toHaveCount(0);
  await expect(item.locator('s-button[tone="critical"]')).toHaveCount(0);

  await banner.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(blockModal.getByText("Block reason")).toBeVisible();
  await expect(blockModal.getByRole("textbox", { name: "Reason" })).toHaveValue(
    "Out of walnut stock",
  );
  await blockModal
    .getByRole("textbox", { name: "Reason" })
    .fill("Walnut arrives Friday");
  await blockModal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(banner.getByText("Walnut arrives Friday")).toBeVisible();
  await expect(banner.getByText("Merchant", { exact: false })).toBeVisible();

  /* The blank note is the field's name, subdued, with its one Edit beside it.
     `filter({ has })` also matches every stack above the note's own, and
     ancestors precede descendants in document order, so `last()` is the
     note's row. */
  const blankNote = frame.locator('s-text[color="subdued"]', {
    hasText: /^Note$/u,
  });
  const placeholder = item.locator(blankNote);
  await expect(placeholder).toBeVisible();
  const noteRow = item.locator("s-stack").filter({ has: blankNote }).last();
  const noteModal = frame.locator("s-modal#run-note");
  await noteRow.getByRole("button", { name: "Edit", exact: true }).click();
  await noteModal
    .getByRole("textbox", { name: "Note" })
    .fill("Customer asked for gift wrap");
  await noteModal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(item.getByText("Customer asked for gift wrap")).toBeVisible();
  await expect(placeholder).toHaveCount(0);
  await expect(
    frame.getByRole("button", { name: "Add note", exact: true }),
  ).toHaveCount(0);

  const unblock = frame.getByRole("button", { name: "Unblock" });
  await expect(unblock).toHaveCount(1);
  await unblock.click();
  await expect(banner).toHaveCount(0);
  await expect(
    frame.getByRole("button", { name: "Block", exact: true }),
  ).toBeVisible();
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
 * the _Choose a workflow_ need, and the order page asks. Then the same item is
 * moved to the other workflow through the Change workflow modal, which holds
 * the select and, on a run with work on it, the warning.
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
        tasks: [{ name: "Engrave", team: TEAM }],
      },
      {
        name: RUSH,
        tag: "e2e-rush",
        tasks: [{ name: "Expedite", team: TEAM }],
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

  /* The Needs row carries the button with a count, and the row's badge says
     the same thing. Scoped to the row for the badge, because the button above
     the table has the same words. */
  const choose = frame.getByRole("button", { name: /^Choose a workflow/u });
  await expect(choose).toBeVisible();
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9401" })
      .getByText("Choose a workflow", { exact: true }),
  ).toBeVisible();
  await choose.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("need"))
    .toBe("choose_workflow");
  await expect(frame.getByRole("link", { name: "#9401" })).toBeVisible();

  await frame.getByRole("link", { name: "#9401" }).click();
  await expect(frame.locator('s-page[heading="#9401"]')).toBeVisible();

  /* An item with no run carries the picker at rest, and on an ambiguous one it
     offers every active workflow with the two that matched first. The
     sentence says why it asks and names nothing, so it cannot drift from the
     list. The shop may carry other tests' workflows, so the count is not
     pinned; the order is. */
  const item = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Twice", exact: true }),
  });
  await expect(
    item.getByText(
      "More than one workflow matches this item, so none was started.",
      { exact: true },
    ),
  ).toBeVisible();
  const picker = item.getByRole("combobox", { name: "Choose workflow" });
  const options = picker.getByRole("option");
  await expect(options.nth(0)).toHaveText(ENGRAVING);
  await expect(options.nth(1)).toHaveText(RUSH);

  await picker.selectOption({ label: ENGRAVING });
  await item.getByRole("button", { name: "Start", exact: true }).click();

  /* The run replaces the ask, and with it the picker: an item with a live run
     carries no workflow control at rest, only the header's Manage. The
     workflow's name is not on the card; it heads the Manage drawer. */
  const manage = item.getByRole("button", { name: "Manage" });
  await expect(manage).toBeVisible();
  await expect(
    item.getByText("so none was started", { exact: false }),
  ).toHaveCount(0);
  await manage.click();
  await expect(
    item.getByText(`${ENGRAVING} workflow`, { exact: true }),
  ).toBeVisible();

  /* Changing is a rare intervention, so its button is inside the disclosure
     with the other ones, and it opens a modal holding the select. A pending
     run with nothing started loses nothing, so the modal says nothing beyond
     its heading: the warning is for work already done. */
  const change = item.getByRole("button", {
    name: "Change workflow",
    exact: true,
  });
  await change.click();
  const changeModal = frame.locator("s-modal#change-workflow");
  await changeModal
    .getByRole("combobox", { name: "Workflow" })
    .selectOption({ label: RUSH });
  await expect(changeModal.getByText("will not carry over")).toHaveCount(0);
  await changeModal
    .getByRole("button", { name: "Change workflow", exact: true })
    .click();

  /* The change replaces the run, so the disclosure the old one had open closes
     with it — `managing` is keyed by run id. The modal hiding is the gate:
     `Manage` is on the card in every state, so waiting on it would pass
     before the write landed. */
  await expect(
    changeModal.getByRole("combobox", { name: "Workflow" }),
  ).toBeHidden();
  await expect(manage).toBeVisible();
  await manage.click();
  await expect(
    item.getByText(`${RUSH} workflow`, { exact: true }),
  ).toBeVisible();
  /* The replaced run stays on the page, cancelled: a run is the record of a
     decision, and the merchant should see the one they undid. */
  await expect(item.getByText("Cancelled", { exact: true })).toBeVisible();

  /* And the order has left the need: one live run, nothing left to choose. */
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9401" })
      .getByText("Choose a workflow", { exact: true }),
  ).toHaveCount(0);
});

/**
 * `Domain.OrderCounts` on screen: each Needs button's count is the number of
 * rows pressing it shows. The search narrows the counts too, which is what
 * keeps this test to its own two orders on a shop that also holds the
 * sandbox's real ones.
 */
test("the needs row counts what its button shows", async ({ page }) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.needs@example.com";
  const TEAM = "E2E Needs Bench";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Needs Cuff",
        tag: "e2e-needs",
        tasks: [{ name: "Cut", team: TEAM }],
      },
    ],
    [
      {
        n: 9501,
        lineItems: [{ title: "E2E Unrouted", quantity: 1, tags: [] }],
      },
      {
        n: 9502,
        blocked: "Waiting on the customer.",
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: ["e2e-needs"] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  const search = frame.getByRole("textbox", { name: "Order number" });
  await search.fill("#950");
  await search.press("Enter");
  await expect(frame.getByRole("button", { name: "Order #950" })).toBeVisible();

  const rows = frame.locator("s-table-row", { hasText: /#950\d/u });
  await expect(
    frame.getByRole("button", { name: "No workflow · 1", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Blocked · 1", exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(2);

  await frame
    .getByRole("button", { name: "No workflow · 1", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(frame.getByRole("link", { name: "#9501" })).toBeVisible();

  await frame.getByRole("button", { name: "Anything", exact: true }).click();
  await expect(rows).toHaveCount(2);

  /* Shipped hides the open-only filters and drops a pressed need, keeping
     the search and its chip; All brings the row back with the need cleared. */
  await frame.getByRole("button", { name: "Blocked · 1", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await frame.getByRole("button", { name: "Shipped", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("need"))
    .toBeNull();
  await expect(frame.getByText("Needs", { exact: true })).toHaveCount(0);
  await expect(frame.getByRole("combobox", { name: "Team" })).toHaveCount(0);
  await expect(frame.getByRole("button", { name: "Order #950" })).toBeVisible();
  await frame.getByRole("button", { name: "All", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: "Anything", exact: true }),
  ).toBeVisible();
  await expect(frame.getByRole("combobox", { name: "Team" })).toBeVisible();
  await expect(rows).toHaveCount(2);
});

/**
 * Thirty orders all waiting on one fresh team, so the team filter keeps the
 * list to this test's orders on a shop that also holds the sandbox's real
 * ones, and 30 is a full first page (`ORDERS_PAGE_SIZE`, 25) plus a second
 * of five.
 */
const seedTwoPages = async (team: string) => {
  const member = "e2e.pages@example.com";
  await seedMembers(
    seedConfig(),
    [member],
    [{ name: team, members: [member] }],
    [
      {
        name: "E2E Pages Ring",
        tag: "e2e-pages",
        tasks: [{ name: "Cut", team }],
      },
    ],
    Array.from({ length: 30 }, (_, index) => ({
      n: 9601 + index,
      lineItems: [
        { title: "E2E Pages Band", quantity: 1, tags: ["e2e-pages"] },
      ],
    })),
  );
};

/** The orders list's context as the admin's URL mirrors it from the app. */
const listContext = (page: Page) => {
  const url = new URL(page.url());
  return {
    status: url.searchParams.get("status"),
    team: url.searchParams.get("team"),
    after: url.searchParams.get("after"),
  };
};

/**
 * `OrdersSearch` on the `/app/orders` layout: the filters and the page ride
 * the order page's URL, so the breadcrumb and the browser's history both
 * return to them. Previous on a page Next pushed is the browser's Back.
 */
test("the orders list keeps its filters and page across the order page", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const TEAM = "E2E Pages Bench";
  await seedTwoPages(TEAM);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  const rows = frame.locator("s-table-row", { hasText: /#96\d\d/u });
  await frame.getByRole("button", { name: /^In production/u }).click();
  await frame
    .getByRole("combobox", { name: "Team" })
    .selectOption({ label: TEAM });
  await expect(rows).toHaveCount(25);

  await frame.getByRole("button", { name: "Go to next page" }).click();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page).after).not.toBeNull();
  const expected = listContext(page);
  expect(expected.status).toBe("in_production");
  expect(expected.team).not.toBeNull();

  /* The row's real href carries them, so open-in-new-tab does too. */
  const link = rows.first().getByRole("link").first();
  const href = await link.evaluate((el) => el.getAttribute("href") ?? "");
  const hrefSearch = new URL(href, "http://localhost").searchParams;
  expect({
    status: hrefSearch.get("status"),
    team: hrefSearch.get("team"),
    after: hrefSearch.get("after"),
  }).toEqual(expected);

  const rowText = await rows.first().textContent();
  const name = /#96\d\d/u.exec(rowText ?? "")?.[0] ?? "";
  await link.click();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
  await expect.poll(() => listContext(page)).toEqual(expected);

  /* The breadcrumb is hoisted into the admin title bar, where it is drawn
     twice: a back arrow labelled for the page it returns to, and the page's
     name beside it. The arrow is the one with the label. */
  await clickHoisted(page.locator('button[aria-label="Orders"]'));
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page)).toEqual(expected);

  /* Back to the order page, Back again to the page Next pushed, Forward to
     the order page: every entry kept the filters and the page. */
  await page.goBack();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
  await expect.poll(() => listContext(page)).toEqual(expected);
  await page.goBack();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page)).toEqual(expected);
  await page.goForward();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
  await expect.poll(() => listContext(page)).toEqual(expected);

  /* Back once more to the page Next pushed: Previous there is the browser's
     Back, to page one with the filters. */
  await page.goBack();
  await expect(rows).toHaveCount(5);
  await frame.getByRole("button", { name: "Go to previous page" }).click();
  await expect(rows).toHaveCount(25);
  await expect
    .poll(() => listContext(page))
    .toEqual({ ...expected, after: null });
});

/**
 * `setFilters` in `app.orders.index.tsx`: a filter is a new list, so the page
 * resets, and it replaces the history entry, so Back leaves the list rather
 * than replaying the filters.
 */
test("a filter change resets the page and replaces history", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const TEAM = "E2E Pages Filter";
  await seedTwoPages(TEAM);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  const rows = frame.locator("s-table-row", { hasText: /#96\d\d/u });
  await frame.getByRole("button", { name: /^In production/u }).click();
  await frame
    .getByRole("combobox", { name: "Team" })
    .selectOption({ label: TEAM });
  await expect(rows).toHaveCount(25);

  /* Two filters pressed, no page turned: one Back leaves Orders. */
  await page.goBack();
  await expect(frame.locator('s-page[heading="Orders"]')).toHaveCount(0);
  await page.goForward();
  await expect(rows).toHaveCount(25);

  await frame.getByRole("button", { name: "Go to next page" }).click();
  await expect(rows).toHaveCount(5);
  await frame.getByRole("button", { name: "All", exact: true }).click();
  await expect
    .poll(() => {
      const { status, after } = listContext(page);
      return { status, after };
    })
    .toEqual({ status: "all", after: null });
  await expect(rows).toHaveCount(25);
});

/** `lenientSearchKey`: an unreadable filter reads as that filter being off, never as an error. */
test("a bad filter value reads as no filter", async ({ page }) => {
  test.setTimeout(120_000);

  const frame = await gotoApp(
    page,
    "app/orders?status=nonsense&need=nonsense&after=nonsense",
  );
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Open", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    frame.getByRole("button", { name: "Anything", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  /* `after=nonsense` is not shaped like a cursor (`Domain.OrdersCursor`), so
     it is dropped too: this is page one and there is no previous page. */
  await expect(
    frame.getByRole("button", { name: "Go to previous page" }),
  ).toBeDisabled();
});

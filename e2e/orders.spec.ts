import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

import * as Domain from "@/lib/Domain";

import { appNavLink, clickHoisted, gotoApp, hoistedEnabled } from "./app";
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
 * Both action buttons sit in the page's `secondary-actions` slot, which App
 * Bridge hoists out of the iframe into the admin title bar, so they are located on
 * `page`, not `frame`, and driven through the hoisted helpers.
 *
 * The hoisted copy is the one to drive, and the only one this test names. The
 * index slots it unconditionally, while the identically named twin inside the
 * empty state exists only while the shop has no open orders — so a test that
 * picked between them would be picking against a list that fills underneath
 * it: on a shop with orders the empty state is on screen for exactly as long
 * as it takes the first page to paint, and a locator captured in that window
 * points at a button that is about to be removed.
 *
 * The one e2e test that reads the store's own orders, not the seed: it
 * requires the dev store (`SHOPIFY_DEV_STORE`) to have at least one open order
 * in Shopify. A store with none imports nothing, and the wait for the first
 * row times out.
 */
test("orders screen imports open orders and lists them", async ({ page }) => {
  test.setTimeout(180_000);

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Orders"));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  const sync = page.getByRole("button", { name: "Import open orders" });
  await expect.poll(() => hoistedEnabled(sync)).toBe(true);

  /* The completion signal is the "Importing…" line appearing and then going,
     the only import status the screen shows. Seeing it appear first is what
     proves a run was created: the button alone is enabled both before the click
     and after the run. The run's 15-30s floor keeps the line on screen far
     longer than the assertion's retry interval, so it cannot come and go
     unseen. */
  await clickHoisted(sync);

  const importing = frame.getByText(/^Importing/u);
  await expect(importing).toBeVisible({ timeout: 30_000 });
  await expect(importing).toBeHidden({ timeout: 120_000 });
  await expect.poll(() => hoistedEnabled(sync)).toBe(true);

  const rows = frame.locator("s-table-row");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });

  /* The order name links to the detail page, which is the only place
     properties and product tags are rendered — the
     fields the bulk path exists to collect. */
  await rows.first().getByRole("link").first().click();
  /* One card per item, each an unslotted top-level section headed by the
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
 * order, read from the same `currentWhere` the member's workflows list runs on.
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
  await clickHoisted(appNavLink(page, "Orders"));

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

/** The orders index's view labels, in view-row order (`Domain.ORDERS_INDEX_VIEW_LABEL`). */
const VIEW_LABELS = Object.values(Domain.ORDERS_INDEX_VIEW_LABEL);

/**
 * A view's button on the orders index, by label and whatever count it is
 * carrying: Fulfilled and All carry none. The count is part of the
 * accessible name, so a test that asserts the number names it in full.
 * The role resolves to the native button inside the `s-press-button`, which
 * is where `aria-pressed` is (`viewButton` in `app.orders.index.tsx`).
 */
const viewButton = (frame: FrameLocator, label: string) =>
  frame.getByRole("button", {
    name: new RegExp(`^${label}(?: · \\d+)?$`, "u"),
  });

/**
 * Order-number search: the field narrows the table to the one order, and
 * emptying the field puts the rest of the list back. Two
 * orders are seeded because a filter that cannot hide anything proves nothing.
 * The search ignores the view (`Domain.ListOrdersInput.q`), so it finds a
 * making order under Made, and every view reads unpressed while it is on.
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
  await clickHoisted(appNavLink(page, "Orders"));
  await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();

  /* Under Made, where neither making order is listed. */
  await viewButton(frame, "Made").click();
  await expect(frame.getByRole("link", { name: "#9302" })).toHaveCount(0);

  /* The digits alone: `normaliseOrderSearch` supplies the `#`. Enter submits;
     the field does not debounce. The search reads every stored order, so a
     making order is found under Made. */
  const search = frame.getByRole("searchbox", { name: "Order number" });
  await search.fill("9301");
  await search.press("Enter");
  await expect(frame.getByRole("link", { name: "#9301" })).toBeVisible();
  await expect(frame.getByRole("link", { name: "#9302" })).toHaveCount(0);
  await expect(search).toHaveValue("9301");
  for (const label of VIEW_LABELS)
    await expect(viewButton(frame, label)).toHaveAttribute(
      "aria-pressed",
      "false",
    );

  /* Pressing a view clears the search and shows that view. */
  await viewButton(frame, "Open").click();
  await expect(search).toHaveValue("");
  await expect(viewButton(frame, "Open")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();

  await test.step("pressing the pressed view keeps it pressed", async () => {
    await viewButton(frame, "Open").click();
    await expect(viewButton(frame, "Open")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(frame.getByRole("link", { name: "#9301" })).toBeVisible();
    await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();
  });

  await search.fill("9301");
  await search.press("Enter");
  await expect(frame.getByRole("link", { name: "#9302" })).toHaveCount(0);

  /* Emptying the field is the search cleared, with no Enter: the list comes
     back. */
  await search.fill("");
  await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();

  /* A number no order carries: the empty state names it rather than falling
     back to the view's copy. */
  await search.fill("9999");
  await search.press("Enter");
  await expect(
    frame.getByRole("heading", { name: "No order matches #9999" }),
  ).toBeVisible();

  await search.fill("");
  await expect(frame.getByRole("link", { name: "#9302" })).toBeVisible();

  /* A bare order number typed into the URL is the search (`OrderSearchParam`
     in `app.orders.tsx`): the router parses `q=9301` as a number, and it
     reads as the digits rather than being dropped as an unreadable key. */
  const typed = await gotoApp(page, "app/orders?q=9301");
  await expect(typed.getByRole("link", { name: "#9301" })).toBeVisible();
  await expect(typed.getByRole("link", { name: "#9302" })).toHaveCount(0);
  await expect(
    typed.getByRole("searchbox", { name: "Order number" }),
  ).toHaveValue("9301");
});

/**
 * The merchant's interventions end to end, against a seeded two-step run:
 * Manage opens, Done records the merchant on the task, Reopen takes it
 * back, and Block / Unblock move the run's block. Each assertion reads the row's
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
  await clickHoisted(appNavLink(page, "Orders"));
  await frame.getByRole("link", { name: "#9301" }).click();
  await expect(frame.locator('s-page[heading="#9301"]')).toBeVisible();

  /* Collapsed, the run offers nothing to click but the disclosure: the trail
     is a glance, and every action lives behind Manage. */
  await expect(
    frame.getByRole("button", {
      name: Domain.VERB_LABEL.done.merchant,
      exact: true,
    }),
  ).toBeHidden();
  await frame.getByRole("button", { name: "Manage" }).click();

  /* The drawer draws the member page's step cards (`RunSteps`). A task that
     has a team shows it as a line, not an open picker: a filled field is
     changed in the Assign team modal, which opens on the current team and
     offers to keep it. */
  await expect(frame.getByText("Step 1", { exact: true })).toBeVisible();
  await expect(
    frame.getByRole("combobox", { name: "Assign team" }),
  ).toHaveCount(0);
  const item = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Cuff", exact: true }),
  });
  await item.getByRole("button", { name: "Assign team" }).first().click();
  const assign = frame.locator("s-modal#assign-task");
  const team = assign.getByRole("combobox", { name: "Team" });
  await expect(team).toBeVisible();
  await expect(team.locator("option:checked")).toHaveText(CUT_TEAM);
  await assign.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(team).toBeHidden();

  /* The badge carries the state; the line under it is the team, then who. */
  const doneByMerchant = frame.getByText(`${CUT_TEAM} \u00B7 Merchant`);
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();
  await frame
    .getByRole("button", {
      name: Domain.VERB_LABEL.done.merchant,
      exact: true,
    })
    .first()
    .click();
  await expect(doneByMerchant).toBeVisible();

  await frame.getByRole("button", { name: "Reopen" }).click();
  await expect(frame.getByText("Reopened by Merchant")).toBeVisible();
  await expect(doneByMerchant).toBeHidden();
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();

  /* Both steps done takes the run to `done`. The card says it in merchant
     words, not `Run.status`: its badge, and the now line counting the
     steps. */
  await frame
    .getByRole("button", {
      name: Domain.VERB_LABEL.done.merchant,
      exact: true,
    })
    .first()
    .click();
  await expect(doneByMerchant).toBeVisible();
  await frame
    .getByRole("button", {
      name: Domain.VERB_LABEL.done.merchant,
      exact: true,
    })
    .first()
    .click();
  await expect(
    frame.getByText("Done \u00B7 2 steps", { exact: true }),
  ).toBeVisible();
});

/**
 * Put back from Manage, the merchant's inverse of a worker's Start
 * (`RunRepository.putBackTask`). There is no merchant Start, so the
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
  await clickHoisted(appNavLink(page, "Orders"));
  await frame.getByRole("link", { name: "#9304" }).click();
  await frame.getByRole("button", { name: "Manage" }).click();

  /* Read the task's line rather than its Started badge: team, who
     started it, since when. */
  await expect(
    frame.getByText(`${CUT_TEAM} \u00B7 ${MEMBER} \u00B7 since`),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Put back" }).click();
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Put back" })).toHaveCount(0);
});

/**
 * Reopen is not offered once someone downstream has moved — the same rule the
 * worker's Undo obeys (`Domain.reopenBlockedBy`), but this is the only screen
 * that puts the blocker into words, because it is the only one that can act
 * on it. The assertion is the whole rendered sentence, which is what pins the
 * wording now that it lives inline in the route rather than in `Domain`:
 * task first, team parenthetical, and the verb supplied by the prefix. Both
 * steps are done from this page, so Polish is the blocker on Cut's
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
  await clickHoisted(appNavLink(page, "Orders"));
  await frame.getByRole("link", { name: "#9302" }).click();
  await frame.getByRole("button", { name: "Manage" }).click();

  await expect(
    frame.getByText(
      `Can’t reopen: Polish (${POLISH_TEAM}) already started. Put it back or reopen it first.`,
    ),
  ).toBeVisible();
  /* Polish itself is the last step, so exactly one Reopen is on the page. */
  await expect(frame.getByRole("button", { name: "Reopen" })).toHaveCount(1);
});

/**
 * Block from the disclosure, then edit the reason and unblock from the red
 * banner the block raises on the card — the `BlockBanner` the member page shows too. Block
 * and the reason edit share one modal, keyed on whether the run is blocked.
 * The reason is merchant prose, so it renders as the banner's body rather
 * than inside the badge, and the Now line still says where the run is.
 * `Unblock` is on the page once, in the banner: the Manage row drops Block
 * while blocked and never repeats Unblock. Nothing in the Manage row is red.
 * The run note is always on the card, blank as its "Edit note" button alone,
 * with no placeholder word and no Add note.
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
  await clickHoisted(appNavLink(page, "Orders"));
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
  await expect(blockModal.getByText("Block E2E Cuff on #9303?")).toBeVisible();
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

  await banner
    .getByRole("button", { name: "Edit reason", exact: true })
    .click();
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

  /* The blank note is its one button, which names the note: the banner's
     Edit reason sits a few lines above it. */
  await expect(item.getByText("Note", { exact: true })).toHaveCount(0);
  const editNote = item.getByRole("button", { name: "Edit note", exact: true });
  await expect(editNote).toHaveCount(1);
  const noteModal = frame.locator("s-modal#run-note");
  await editNote.click();
  await noteModal
    .getByRole("textbox", { name: "Note" })
    .fill("Customer asked for gift wrap");
  await noteModal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(item.getByText("Customer asked for gift wrap")).toBeVisible();
  await expect(editNote).toHaveCount(1);
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
 * The card's layout, top to bottom: title, then the facts line carrying the
 * live run's badges; the properties, with a null value as an em dash so the
 * key never stands alone; the blocked banner, its reason cut to three lines
 * with Show more when the cut hides text; the Now line; the note; and Manage
 * last, directly above the drawer it opens.
 */
test("the order card puts the run's badges on the title line, Manage above its drawer, and cuts a long reason", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.card@example.com";
  const TEAM = "E2E Card Bench";
  const REASON =
    "Waiting on vector artwork from the customer before engraving the crest. ".repeat(
      12,
    );
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Card Board",
        tag: "e2e-card",
        tasks: [{ name: "Engrave", team: TEAM }],
      },
    ],
    [
      {
        n: 9311,
        blocked: REASON,
        lineItems: [
          {
            title: "E2E Board",
            quantity: 1,
            tags: ["e2e-card"],
            properties: [{ key: "Gift note", value: null }],
          },
        ],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Orders"));
  await frame.getByRole("link", { name: "#9311" }).click();
  const item = frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: "E2E Board", exact: true }),
  });
  const banner = item.locator('s-banner[heading="Blocked"]');
  await expect(banner).toBeVisible();

  /* The badges share the facts line with "× 1", above the properties. */
  const factsLine = item
    .locator("s-stack")
    .filter({ has: frame.getByText("\u00D7 1", { exact: true }) })
    .last();
  await expect(
    factsLine.locator("s-badge", { hasText: "Not started" }),
  ).toBeVisible();
  await expect(
    factsLine.locator("s-badge", { hasText: "Blocked" }),
  ).toBeVisible();

  await expect(item.getByText("Gift note", { exact: true })).toBeVisible();
  await expect(item.getByText("\u2014", { exact: true })).toBeVisible();

  /* Cut to three lines, then shown whole. */
  const reason = banner.locator(".member-prose").first();
  const clamped = await reason.boundingBox();
  await banner.getByText("Show more", { exact: true }).click();
  await expect(banner.getByText("Show less", { exact: true })).toBeVisible();
  const whole = await reason.boundingBox();
  expect(whole?.height ?? 0).toBeGreaterThan(clamped?.height ?? 0);

  /* Manage is below the note and the drawer opens under it. */
  const editNote = item.getByRole("button", { name: "Edit note", exact: true });
  const manage = item.getByRole("button", { name: "Manage" });
  const noteBox = await editNote.boundingBox();
  const manageBox = await manage.boundingBox();
  expect(manageBox?.y ?? 0).toBeGreaterThan(noteBox?.y ?? 0);
  await manage.click();
  const drawer = item.getByText("E2E Card Board workflow", { exact: true });
  await expect(drawer).toBeVisible();
  /* `s-text` lays out as `display: contents` and has no box, so the drawer
     is placed by document order rather than by position. */
  const drawerFollowsManage = await item.evaluate((section) => {
    const button = [...section.querySelectorAll("s-button")].find(
      (element) => element.textContent?.trim() === "Manage",
    );
    const header = [...section.querySelectorAll("s-text")].find(
      (element) => element.textContent === "E2E Card Board workflow",
    );
    return (
      button !== undefined &&
      header !== undefined &&
      (button.compareDocumentPosition(header) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
    );
  });
  expect(drawerFollowsManage).toBe(true);
});

/**
 * One workflow per item, at the two places a merchant meets it.
 *
 * Two workflows that are on, with a tag each, both on the same product, is a state
 * the app refuses to *create* — Apply and Turn on hold one workflow that is on per
 * tag — and the local seed is what makes it reachable, because it writes
 * definitions straight into SQLite. That is deliberate: the rule is enforced at
 * the switch, but the runtime has to cope with the state anyway (two workflows
 * whose tags land on one product through a merchant's retagging in Shopify),
 * and this is the fixture for it.
 *
 * So: the item matches two, nothing starts, the index shows the order under
 * Issues with the _Needs a workflow_ badge, and the order page asks. Then the same item is
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
  await clickHoisted(appNavLink(page, "Orders"));

  /* The row's Issues cell says what it is waiting on, and the Issues view
     holds it. */
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9401" })
      .getByText("Needs a workflow", { exact: true }),
  ).toBeVisible();
  await viewButton(frame, "Issues").click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("view"))
    .toBe("issues");
  await expect(frame.getByRole("link", { name: "#9401" })).toBeVisible();

  await frame.getByRole("link", { name: "#9401" }).click();
  await expect(frame.locator('s-page[heading="#9401"]')).toBeVisible();

  /* An item with no run carries the picker at rest, and on an ambiguous one it
     offers every workflow that is on, with the two that matched first. The
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
  const picker = item.getByRole("combobox", { name: "Workflow" });
  const options = picker.getByRole("option");
  await expect(options.nth(0)).toHaveText(ENGRAVING);
  await expect(options.nth(1)).toHaveText(RUSH);

  await picker.selectOption({ label: ENGRAVING });
  await item
    .getByRole("button", {
      name: Domain.VERB_LABEL.attachWorkflow.merchant,
      exact: true,
    })
    .click();

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
     with the other ones, and it opens a modal holding the select. A run
     with nothing started loses nothing, so the modal says nothing beyond
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
  /* The replaced run is gone, not kept beside the new one: Change workflow
     deletes it (`Domain.RunStatus`), and the modal already said what it cost. */
  await expect(item.getByText("Cancelled", { exact: true })).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Manage" })).toHaveCount(1);

  /* Cancel workflow asks first, because nothing brings the run back. After it
     the item's run is Closed, "Cancelled by you", and the item waits for the
     merchant: the picker offers every workflow, the closed one included, as
     a fresh run. */
  await item
    .getByRole("button", {
      name: Domain.VERB_LABEL.cancel.merchant,
      exact: true,
    })
    .click();
  const cancelModal = frame.locator("s-modal#cancel-run");
  await expect(
    cancelModal.getByText("Steps already done stay on record.", {
      exact: false,
    }),
  ).toBeVisible();
  await cancelModal
    .getByRole("button", {
      name: Domain.VERB_LABEL.cancel.merchant,
      exact: true,
    })
    .click();
  await expect(item.getByText("Closed", { exact: true })).toBeVisible();
  await expect(
    item.getByText("Cancelled by you", { exact: false }),
  ).toBeVisible();
  await item
    .getByRole("combobox", { name: "Workflow" })
    .selectOption({ label: RUSH });
  await item
    .getByRole("button", {
      name: Domain.VERB_LABEL.attachWorkflow.merchant,
      exact: true,
    })
    .click();
  await expect(item.getByText("Closed", { exact: true })).toHaveCount(0);
  await expect(manage).toBeVisible();

  /* And the order has left the issue: one live run, nothing left to choose. */
  await clickHoisted(appNavLink(page, "Orders"));
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9401" })
      .getByText("Needs a workflow", { exact: true }),
  ).toHaveCount(0);
});

/** A button inside one item's card, by its exact label. */
const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });

/**
 * Each order-page state against the controls its action set allows
 * (`Domain.runActions`, `Domain.taskActions`, `Domain.lineItemState`), one
 * seeded order per state, so the table the page is built from is looked at
 * rather than reasoned about.
 */
test("each order-page state draws the controls its action set allows", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const MEMBER = "e2e.states@example.com";
  const TEAM = "E2E States";
  const workflow = (name: string, tag: string) => ({
    name,
    tag,
    tasks: [
      { name: `${name} one`, team: TEAM },
      { name: `${name} two`, team: TEAM },
    ],
  });
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      workflow("E2E State A", "e2e-state-a"),
      workflow("E2E State B", "e2e-state-b"),
      workflow("E2E State C", "e2e-state-c"),
    ],
    [
      {
        // the line removed in Shopify under a started run: closed, no buttons
        n: 9501,
        advance: 1,
        after: { lineItems: [{ position: 1, currentQuantity: 0 }] },
        lineItems: [
          { title: "E2E Removed", quantity: 1, tags: ["e2e-state-a"] },
        ],
      },
      {
        // Shopify cancelled the order under a started run
        n: 9502,
        advance: 1,
        after: { cancelled: true },
        lineItems: [
          { title: "E2E Closed", quantity: 1, tags: ["e2e-state-a"] },
        ],
      },
      {
        // done, then the quantity dropped
        n: 9503,
        done: true,
        after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
        lineItems: [
          { title: "E2E Resized", quantity: 2, tags: ["e2e-state-a"] },
        ],
      },
      {
        // blocked before anyone started
        n: 9504,
        blocked: "Waiting on artwork.",
        lineItems: [{ title: "E2E Held", quantity: 1, tags: ["e2e-state-a"] }],
      },
      {
        // three workflows claim the item
        n: 9505,
        lineItems: [
          {
            title: "E2E Triple",
            quantity: 1,
            tags: ["e2e-state-a", "e2e-state-b", "e2e-state-c"],
          },
        ],
      },
      {
        // the merchant cancelled the run
        n: 9506,
        lineItems: [
          {
            title: "E2E Stopped",
            quantity: 1,
            tags: ["e2e-state-a"],
            progress: { advance: 1, cancelled: true },
          },
        ],
      },
      {
        // started, then the quantity dropped: resized, with the badge
        n: 9507,
        started: true,
        after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
        lineItems: [
          { title: "E2E Shrunk", quantity: 2, tags: ["e2e-state-a"] },
        ],
      },
    ],
  );

  /* By URL rather than through the index: the index opens on Open orders,
     and #9502 is cancelled in Shopify. */
  const open = async (n: number, title: string) => {
    const frame = await gotoApp(page, `app/orders/seed-${String(n)}`);
    await expect(
      frame.locator(`s-page[heading="#${String(n)}"]`),
    ).toBeVisible();
    return frame.locator("s-section").filter({
      has: frame.getByRole("heading", { name: title, exact: true }),
    });
  };
  /* A closed run offers nothing but the note: no Dismiss anywhere, and no
     Cancel workflow on a closed order (`Domain.runActions`). */
  const removed = await open(9501, "E2E Removed");
  await expect(removed.getByText("Closed", { exact: true })).toBeVisible();
  await expect(
    removed.getByText("Item removed or refunded in Shopify", { exact: false }),
  ).toBeVisible();
  await expect(button(removed, "Dismiss")).toHaveCount(0);
  await button(removed, "Manage").click();
  await expect(button(removed, Domain.VERB_LABEL.done.merchant)).toHaveCount(0);
  await expect(button(removed, "Block")).toHaveCount(0);
  await expect(button(removed, "Assign team")).toHaveCount(0);
  await expect(button(removed, Domain.VERB_LABEL.cancel.merchant)).toHaveCount(
    0,
  );

  const closed = await open(9502, "E2E Closed");
  await expect(closed.getByText("Closed", { exact: true })).toBeVisible();
  await expect(
    closed.getByText("Order cancelled in Shopify", { exact: false }),
  ).toBeVisible();
  await expect(button(closed, "Dismiss")).toHaveCount(0);
  await button(closed, "Manage").click();
  await expect(button(closed, Domain.VERB_LABEL.cancel.merchant)).toHaveCount(
    0,
  );
  await expect(button(closed, Domain.VERB_LABEL.done.merchant)).toHaveCount(0);
  await expect(button(closed, "Reopen")).toHaveCount(0);
  await expect(button(closed, "Assign team")).toHaveCount(0);
  await expect(button(closed, "Block")).toHaveCount(0);
  await expect(button(closed, "Change workflow")).toHaveCount(0);

  const resized = await open(9503, "E2E Resized");
  await expect(
    resized.getByText("Done", { exact: true }).first(),
  ).toBeVisible();
  /* A done run is never resized: no badge, nothing to dismiss. */
  await expect(resized.getByText(/^Quantity changed/u)).toHaveCount(0);
  await expect(button(resized, "Dismiss")).toHaveCount(0);
  await button(resized, "Manage").click();
  await expect(button(resized, "Reopen")).toBeVisible();
  await expect(button(resized, Domain.VERB_LABEL.cancel.merchant)).toHaveCount(
    0,
  );

  const held = await open(9504, "E2E Held");
  await expect(button(held, "Edit reason")).toBeVisible();
  await expect(button(held, "Unblock")).toBeVisible();
  await button(held, "Manage").click();
  await expect(button(held, Domain.VERB_LABEL.done.merchant)).toHaveCount(0);
  await expect(button(held, "Block")).toHaveCount(0);
  await expect(button(held, "Assign team").first()).toBeVisible();

  const triple = await open(9505, "E2E Triple");
  const options = triple
    .getByRole("combobox", { name: "Workflow" })
    .getByRole("option");
  await expect(options.nth(0)).toHaveText("E2E State A");
  await expect(options.nth(1)).toHaveText("E2E State B");
  await expect(options.nth(2)).toHaveText("E2E State C");

  const stopped = await open(9506, "E2E Stopped");
  await expect(stopped.getByText("Closed", { exact: true })).toBeVisible();
  await expect(
    stopped.getByText("Cancelled by you", { exact: false }),
  ).toBeVisible();
  await expect(
    stopped.getByRole("combobox", { name: "Workflow" }),
  ).toBeVisible();
  /* The done step stays on record under Manage, with no buttons. */
  await button(stopped, "Manage").click();
  await expect(stopped.getByText("E2E State A one")).toBeVisible();
  await expect(button(stopped, "Reopen")).toHaveCount(0);

  /* The quantity badge is a notice with no button: the next Done clears it. */
  const shrunk = await open(9507, "E2E Shrunk");
  await expect(
    shrunk.getByText("Quantity changed · 2 → 1", { exact: true }),
  ).toBeVisible();
  await button(shrunk, "Manage").click();
  await button(shrunk, Domain.VERB_LABEL.done.merchant).first().click();
  await expect(shrunk.getByText(/^Quantity changed/u)).toHaveCount(0);
});

/**
 * `Domain.OrderCounts` on screen: each counted view's number is the number of
 * rows pressing it shows, under the team select. The counts ignore the
 * search, so the team is what keeps this test to its own orders on a shop
 * that also holds the sandbox's real ones: `#9501` and `#9502` wait on a
 * fresh team, and `#9501` also has an item matching two workflows, which is
 * an issue. `#9503` matches nothing, so it waits on no team and only the
 * unnarrowed counts see it.
 */
test("each view's count is what pressing it shows, given the team", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.issues@example.com";
  const TEAM = "E2E Issues Bench";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [{ name: TEAM, members: [MEMBER] }],
    [
      {
        name: "E2E Issues Cuff",
        tag: "e2e-issues",
        tasks: [{ name: "Cut", team: TEAM }],
      },
      {
        name: "E2E Issues Rush",
        tag: "e2e-issues-rush",
        tasks: [{ name: "Expedite", team: TEAM }],
      },
    ],
    [
      {
        n: 9501,
        lineItems: [
          { title: "E2E Cuff", quantity: 1, tags: ["e2e-issues"] },
          {
            title: "E2E Twice",
            quantity: 1,
            tags: ["e2e-issues", "e2e-issues-rush"],
          },
        ],
      },
      {
        n: 9502,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: ["e2e-issues"] }],
      },
      {
        n: 9503,
        lineItems: [{ title: "E2E Unrouted", quantity: 1, tags: [] }],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Orders"));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  /* Every open order, `#9503` included, before the team narrows them. Read
     off the accessible name: the label is slotted into the button's shadow
     root, so the element `getByRole` resolves to has no text of its own. */
  const openCount = async () =>
    Number(
      /Open · (?<n>\d+)/u.exec(await viewButton(frame, "Open").ariaSnapshot())
        ?.groups?.n ?? Number.NaN,
    );
  await expect.poll(openCount).toBeGreaterThan(2);

  await frame
    .getByRole("combobox", { name: "Team" })
    .selectOption({ label: TEAM });
  const counted = [
    ["Open", 2],
    ["Issues", 1],
    ["Not started", 0],
    ["Making", 2],
    ["Made", 0],
  ] as const;
  for (const [label, n] of counted)
    await expect(
      frame.getByRole("button", { name: `${label} · ${String(n)}` }),
    ).toBeVisible();

  const rows = frame.locator("s-table-row");
  for (const [label, n] of counted) {
    await viewButton(frame, label).click();
    await expect(rows).toHaveCount(n);
  }
  await viewButton(frame, "Issues").click();
  await expect(frame.getByRole("link", { name: "#9501" })).toBeVisible();

  /* A search reads every stored order, team or not, and moves no count. */
  const search = frame.getByRole("searchbox", { name: "Order number" });
  await search.fill("9503");
  await search.press("Enter");
  await expect(frame.getByRole("link", { name: "#9503" })).toBeVisible();
  for (const [label, n] of counted)
    await expect(
      frame.getByRole("button", { name: `${label} · ${String(n)}` }),
    ).toBeVisible();
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

/** The orders index's context as the admin's URL mirrors it from the app. */
const listContext = (page: Page) => {
  const url = new URL(page.url());
  return {
    view: url.searchParams.get("view"),
    team: url.searchParams.get("team"),
    after: url.searchParams.get("after"),
  };
};

/**
 * `OrdersSearch` on the `/app/orders` layout: the filters and the page ride
 * the order page's URL, so the breadcrumb and the browser's history both
 * return to them. Previous on a page Next pushed is the browser's Back.
 */
test("the orders index keeps its filters and page across the order page", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const TEAM = "E2E Pages Bench";
  await seedTwoPages(TEAM);

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Orders"));
  const rows = frame.locator("s-table-row", { hasText: /#96\d\d/u });
  await viewButton(frame, "Making").click();
  await frame
    .getByRole("combobox", { name: "Team" })
    .selectOption({ label: TEAM });
  await expect(rows).toHaveCount(25);

  await frame.getByRole("button", { name: "Go to next page" }).click();
  await expect(rows).toHaveCount(5);
  await expect.poll(() => listContext(page).after).not.toBeNull();
  const expected = listContext(page);
  expect(expected.view).toBe("making");
  expect(expected.team).not.toBeNull();

  /* The row's real href carries them, so open-in-new-tab does too. */
  const link = rows.first().getByRole("link").first();
  const href = await link.evaluate((el) => el.getAttribute("href") ?? "");
  const hrefSearch = new URL(href, "http://localhost").searchParams;
  expect({
    view: hrefSearch.get("view"),
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
 * `setFilters` in `app.orders.index.tsx`: a view or a filter is a new list,
 * so the page resets, and it replaces the history entry, so Back leaves the
 * list rather than replaying the filters.
 */
test("a filter change resets the page and replaces history", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const TEAM = "E2E Pages Filter";
  await seedTwoPages(TEAM);

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Orders"));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  const rows = frame.locator("s-table-row", { hasText: /#96\d\d/u });
  await viewButton(frame, "Making").click();
  await frame
    .getByRole("combobox", { name: "Team" })
    .selectOption({ label: TEAM });
  await expect(rows).toHaveCount(25);

  /* A view and a filter chosen, no page turned: one Back leaves Orders. */
  await page.goBack();
  await expect(frame.locator('s-page[heading="Orders"]')).toHaveCount(0);
  await page.goForward();
  await expect(rows).toHaveCount(25);

  await frame.getByRole("button", { name: "Go to next page" }).click();
  await expect(rows).toHaveCount(5);
  await viewButton(frame, "All").click();
  await expect
    .poll(() => {
      const { view, after } = listContext(page);
      return { view, after };
    })
    .toEqual({ view: "all", after: null });
  await expect(rows).toHaveCount(25);
});

/** `lenientSearchKey`: an unreadable view or filter reads as that key being off, never as an error. */
test("a bad filter value reads as no filter", async ({ page }) => {
  test.setTimeout(120_000);

  const frame = await gotoApp(page, "app/orders?view=nonsense&after=nonsense");
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  await expect(viewButton(frame, "Open")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  /* `after=nonsense` is not shaped like a cursor (`Domain.OrdersCursor`), so
     it is dropped too: this is page one and there is no previous page. */
  await expect(
    frame.getByRole("button", { name: "Go to previous page" }),
  ).toBeDisabled();
});

/**
 * The Issues banner on the orders index. The sandbox holds real orders, so
 * the team select keeps this test to its own: `#9601` waits on a team with a
 * member and has an item matching two workflows, a Needs a workflow issue;
 * `#9602`'s only task is on a team with no members, a Team has no members
 * issue; `#9603` has an unassigned task on a later step, a Needs a team
 * issue. The banner's count honours the team (`Domain.OrderCounts`), so each
 * team shows its own order, and every one of the three is critical
 * (`Domain.ORDER_ISSUE_TONE`).
 *
 * The seed refuses to turn on a workflow with an unassigned task, so
 * `#9603`'s second step is seeded on a team that is then deleted on the
 * teams screen, which is how a task becomes unassigned in the app.
 */
test("the Issues banner stands while any open order has an issue, is critical for every issue, and goes with the Issues view", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const MEMBER = "e2e.banner@example.com";
  const TEAM = "E2E Banner Bench";
  const EMPTY_TEAM = "E2E Banner Empty";
  const ORPHAN_TEAM = "E2E Banner Orphan";
  const GONE_TEAM = "E2E Banner Gone";
  await seedMembers(
    seedConfig(),
    [MEMBER],
    [
      { name: TEAM, members: [MEMBER] },
      { name: EMPTY_TEAM, members: [] },
      { name: ORPHAN_TEAM, members: [MEMBER] },
      { name: GONE_TEAM, members: [MEMBER] },
    ],
    [
      {
        name: "E2E Banner Cuff",
        tag: "e2e-banner",
        tasks: [{ name: "Cut", team: TEAM }],
      },
      {
        name: "E2E Banner Rush",
        tag: "e2e-banner-rush",
        tasks: [{ name: "Expedite", team: TEAM }],
      },
      {
        name: "E2E Banner Empty team",
        tag: "e2e-banner-empty",
        tasks: [{ name: "Wait", team: EMPTY_TEAM }],
      },
      {
        name: "E2E Banner Orphan",
        tag: "e2e-banner-orphan",
        tasks: [
          { name: "Cut", team: ORPHAN_TEAM, step: 1 },
          { name: "Pack", team: GONE_TEAM, step: 2 },
        ],
      },
    ],
    [
      {
        n: 9601,
        lineItems: [
          { title: "E2E Cuff", quantity: 1, tags: ["e2e-banner"] },
          {
            title: "E2E Twice",
            quantity: 1,
            tags: ["e2e-banner", "e2e-banner-rush"],
          },
        ],
      },
      {
        n: 9602,
        lineItems: [
          { title: "E2E Nobody", quantity: 1, tags: ["e2e-banner-empty"] },
        ],
      },
      {
        n: 9603,
        lineItems: [
          { title: "E2E Orphan", quantity: 1, tags: ["e2e-banner-orphan"] },
        ],
      },
    ],
  );

  const frame = await gotoApp(page);
  await clickHoisted(appNavLink(page, "Teams"));
  await frame.getByRole("link", { name: GONE_TEAM }).click();
  await expect(frame.locator(`s-page[heading="${GONE_TEAM}"]`)).toBeVisible();
  /* Delete sits in the title bar's More actions menu, which App Bridge
     hoists; its in-frame button still fires the modal (`teams.spec.ts`). */
  await frame
    .locator("s-menu#team-actions s-button", { hasText: "Delete" })
    .evaluate((el) => {
      (el as HTMLElement).click();
    });
  await frame
    .getByRole("button", { name: "Delete", exact: true })
    .last()
    .click();
  await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();

  await clickHoisted(appNavLink(page, "Orders"));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  const banner = frame.locator("s-banner", {
    has: frame.getByRole("button", { name: "Show issues" }),
  });
  const team = frame.getByRole("combobox", { name: "Team" });

  await team.selectOption({ label: TEAM });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute(
    "heading",
    /^\d+ open orders? ha(?:s|ve) (?:an )?issues?$/u,
  );
  await expect(banner).toHaveAttribute("heading", "1 open order has an issue");
  await expect(banner).toHaveAttribute("tone", "critical");

  await banner.getByRole("button", { name: "Show issues" }).click();
  await expect.poll(() => listContext(page).view).toBe("issues");
  await expect(viewButton(frame, "Issues")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(frame.getByRole("link", { name: "#9601" })).toBeVisible();
  await expect(banner).toHaveCount(0);

  await viewButton(frame, "Open").click();
  await expect(banner).toBeVisible();

  /* The team with only a Team has no members order. */
  await team.selectOption({ label: EMPTY_TEAM });
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9602" })
      .getByText("Team has no members", { exact: true }),
  ).toBeVisible();
  await expect(banner).toHaveAttribute("tone", "critical");
  await expect(banner).toHaveAttribute("heading", "1 open order has an issue");

  /* The team with only a Needs a team order. */
  await team.selectOption({ label: ORPHAN_TEAM });
  await expect(
    frame
      .locator("s-table-row", { hasText: "#9603" })
      .getByText("Needs a team", { exact: true }),
  ).toBeVisible();
  await expect(banner).toHaveAttribute("tone", "critical");
  await expect(banner).toHaveAttribute("heading", "1 open order has an issue");
});

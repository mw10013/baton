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
  await expect(
    frame.locator('s-section[accessibilityLabel="Line items"]'),
  ).toBeVisible();

  const resync = page.getByRole("button", { name: "Resync from Shopify" });
  await expect.poll(() => hoistedEnabled(resync)).toBe(true);
  await clickHoisted(resync);
  await expect
    .poll(() => hoistedEnabled(resync), { timeout: 30_000 })
    .toBe(true);
});

/**
 * The order page names why the order workflow will not start here and links
 * to its own page: with the singleton off, "Turn it on" lands on
 * `/app/order-workflow`, the nav entry after Workflows.
 */
test("the order page's order-workflow link lands on the order workflow page", async ({
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
        tags: ["e2e-ring"],
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
  await expect(
    frame.getByText(
      "Order workflow is off, so it will not start on this order.",
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await frame.getByRole("link", { name: "Turn it on" }).click();
  await expect(frame.locator('s-page[heading="Order workflow"]')).toBeVisible();
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
        tags: ["e2e-manage"],
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

  /* Both stages done takes the run to `done`, which is the badge the orders
     index and the production state read. */
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(frame.getByText("Done by Merchant")).toBeVisible();
  await frame.getByRole("button", { name: "Mark done" }).first().click();
  await expect(frame.getByText("done", { exact: true })).toBeVisible();
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
        tags: ["e2e-reopen"],
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
 * Block and Unblock from the same disclosure, with the attribution line under
 * the badge. The reason travels into both.
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
        tags: ["e2e-block"],
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
  await expect(frame.getByText("Blocked: Out of walnut stock")).toBeVisible();
  await expect(frame.getByText("Blocked by Merchant")).toBeVisible();

  await frame.getByRole("button", { name: "Unblock" }).click();
  await expect(frame.getByText("Blocked by Merchant")).toBeHidden();
  await expect(frame.getByRole("button", { name: "Block" })).toBeVisible();
});

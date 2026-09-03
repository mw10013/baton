import { expect, test } from "@playwright/test";

import { clickHoisted, gotoApp } from "./app";

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
 */
test("orders screen syncs the window and lists orders", async ({ page }) => {
  test.setTimeout(180_000);

  const frame = await gotoApp(page);
  await clickHoisted(page.getByRole("link", { name: "Orders", exact: true }));
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();

  const sync = frame.getByRole("button", { name: /^Sync last \d+ days$/u });
  await expect(sync).toBeEnabled();

  /* The completion signal is a *new* `Last synced` timestamp, not the transient
     "Syncing…" text and not the button re-enabling. A sandbox window syncs in
     seconds, so the in-flight state can come and go between polls, and the
     button is momentarily enabled between the click and the state update —
     both would pass without proving anything ran. Comparing the timestamp
     against the one on screen beforehand is the only assertion that can only
     be satisfied by a run that actually finished. */
  const status = frame.getByText(/^(?:Last synced|Never synced|Syncing)/u);
  const before = await status.textContent();

  await sync.click();

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

  await frame.getByRole("button", { name: "Resync from Shopify" }).click();
  await expect(
    frame.getByRole("button", { name: "Resync from Shopify" }),
  ).toBeEnabled({ timeout: 30_000 });
});

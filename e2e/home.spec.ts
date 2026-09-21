import { test, expect } from "@playwright/test";

import { gotoApp } from "./app";

/** Smoke test: the embedded iframe actually renders our app (not a Shopify login bounce, which would also resolve as an iframe but with no `s-page`). */
test("embedded app home loads", async ({ page }) => {
  const frame = await gotoApp(page);
  await expect(frame.locator('s-page[heading="Baton"]')).toBeVisible();
});

/** Both capacity meters render: a tile that fails to mount leaves the section looking intact while saying nothing about the plan. The `aria-label` is the tile heading (`CapacityTile`) and is what `plan.billing.spec.ts` reads the entitlement off. */
test("home renders a capacity meter per dimension", async ({ page }) => {
  const frame = await gotoApp(page);
  for (const label of ["Orders this billing period", "Members"])
    await expect(
      frame.locator(`progress[aria-label="${label}"]`),
    ).toBeVisible();
});

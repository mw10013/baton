import { test, expect } from "@playwright/test";

import { gotoApp } from "./app";

/** Smoke test: the embedded iframe actually renders our app (not a Shopify login bounce, which would also resolve as an iframe but with no `s-page`). */
test("embedded app home loads", async ({ page }) => {
  const frame = await gotoApp(page);
  await expect(frame.locator('s-page[heading="Baton"]')).toBeVisible();
});

import type { BrowserContext, FrameLocator } from "playwright/test";

import { dev, expect, test } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { openApp } from "./app.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let frame: FrameLocator;

test.beforeAll(async ({ browser }) => {
  ({ context, frame } = await openApp(browser));
});

test.afterAll(async () => {
  await context.close();
});

test("the app loads embedded and shows the e2e store's domain", async () => {
  await expect(frame.getByText(shop, { exact: true })).toBeVisible();
  await expect(frame.getByRole("link", { name: "Orders", exact: true })).toBeVisible();
});

test("the exchange stored a real session", async ({ backend }) => {
  const session = await backend(dev((c) => c.GetShopSession({ shop })));
  expect(session).not.toBeNull();
  expect(session?.shopGid).toMatch(/^gid:\/\/shopify\/Shop\/\d+$/u);
  expect(session?.scope).toBe("read_orders,read_products");
});

test("the Orders link opens the orders screen inside the admin", async () => {
  await frame.getByRole("link", { name: "Orders", exact: true }).click();
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
});

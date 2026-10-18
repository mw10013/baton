import type { BrowserContext, Page } from "playwright/test";
import * as Schema from "effect/Schema";

import { ShopFixtureData } from "../../../src/contract/fixture.ts";
import { dev, expect, test, testEmail } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The App Home's setup guide on the e2e store. The store always has a team with a member (`ops`)
 * and no run until runs exist, so the guide always shows there and its first step is always done;
 * the test adds an active workflow of its own and asserts the steps' states, never the guide's
 * absence, since the specs share the store.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ context, page } = await openApp(browser));
});

test.afterAll(async () => {
  await context.close();
});

test("the App Home guide marks a team with a member and an active workflow done, and an item with a workflow not done", async ({
  backend,
}) => {
  const { testId, retry } = test.info();
  const id = `${testId.slice(-8)}${String(retry)}`;
  const team = `E2E Home ${id}`;
  const member = testEmail("home");
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: Schema.decodeUnknownSync(ShopFixtureData)({
          members: [member],
          teams: [{ name: team, members: [member] }],
          workflows: [
            {
              name: `E2E Home ${id}`,
              tag: `e2e-home-${id}`,
              state: "active",
              tasks: [{ name: "Cut", team }],
            },
          ],
          orders: [],
        }),
      }),
    ),
  );

  const frame = await gotoApp(page);
  const guide = frame.locator('s-section[accessibilityLabel="Getting started"]');
  await expect(guide.getByText("Getting started", { exact: true }).first()).toBeVisible();
  await expect(guide.getByText("2 of 3 done", { exact: true })).toBeVisible();
  await expect(guide.getByText("Create a team and add a member", { exact: true })).toBeVisible();
  await expect(
    guide.getByText("New orders arrive as they are placed.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      guide
        .locator('s-text[accessibilityVisibility="exclusive"]')
        .evaluateAll((els: Array<Element>) => els.map((el) => el.textContent)),
    )
    .toEqual(["Done", "Done", "Not done"]);
  // A done step keeps its place and loses its link.
  await expect(guide.getByRole("link", { name: "Workflows" })).toHaveCount(0);
});

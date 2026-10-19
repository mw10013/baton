import type { BrowserContext, FrameLocator, Page } from "playwright/test";
import * as Schema from "effect/Schema";

import { ShopFixtureData } from "../../../src/contract/fixture.ts";
import { ORDERS_SHOW_LABEL } from "../../../src/domain/shop-work.ts";
import { ORDERS_STRIP } from "../../../src/web/client/shop-actor-client.ts";
import { dev, expect, test, testEmail } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The App Home on the e2e store: the setup guide and the Orders strip. The store always has a team
 * with a member (`ops`), so the guide's first step is always done; the guide test adds an active
 * workflow of its own and asserts the first two steps' states, never the third's, since the specs
 * share the store and any of them may give an item a workflow. That also completes the guide, which
 * then leaves the page, so the test reads the guide's content only when the page shows it. The strip
 * tests read the strip's labels and where a cell leads, never its counts, which every spec moves.
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

test("the App Home guide marks a team with a member and an active workflow done", async ({
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
  // The loader renders the guide with the strip, and the guide is not live, so once the strip
  // shows, a missing guide is a complete one.
  await expect(frame.locator('s-section[heading="Orders"]')).toBeVisible();
  const guide = frame.locator('s-section[accessibilityLabel="Getting started"]');
  if ((await guide.count()) === 0) {
    test.info().annotations.push({
      type: "guide",
      description: "complete: another spec gave an item a workflow, so the page shows no guide",
    });
    return;
  }
  await expect(guide.getByText("Getting started", { exact: true }).first()).toBeVisible();
  await expect(guide.getByText(/^[23] of 3 done$/u)).toBeVisible();
  await expect(guide.getByText("Create a team and add a member", { exact: true })).toBeVisible();
  await expect(
    guide.getByText("New orders arrive as they are placed.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      guide
        .locator('s-text[accessibilityVisibility="exclusive"]')
        .evaluateAll((els: Array<Element>) => els.slice(0, 2).map((el) => el.textContent)),
    )
    .toEqual(["Done", "Done"]);
  // A done step keeps its place and loses its link.
  await expect(guide.getByRole("link", { name: "Workflows" })).toHaveCount(0);
});

/** A cell of the home page's strip: a link named for its label and its count. */
const homeStripCell = (frame: FrameLocator, label: string) =>
  frame.getByRole("link", { name: new RegExp(`^${label}, \\d+$`, "u") });

/** The strip on home is the orders index's: the same five cells, in its order, with its labels. */
test("the strip shows five cells with the orders index's labels", async () => {
  const frame = await gotoApp(page);
  const strip = frame.locator('s-section[heading="Orders"]');
  for (const key of ORDERS_STRIP)
    await expect(homeStripCell(frame, ORDERS_SHOW_LABEL[key])).toBeVisible();
  await expect(strip.locator("s-clickable")).toHaveCount(5);
});

/**
 * A cell links to the orders index with its value chosen: Issues on home lands on the orders index
 * with `?show=issues` and its Issues cell chosen.
 */
test("a strip cell opens the orders index with that value chosen", async () => {
  const frame = await gotoApp(page);
  await homeStripCell(frame, "Issues").click();
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("show")).toBe("issues");
  await expect(frame.getByRole("button", { name: /^Issues, \d+, selected$/u })).toBeVisible();
});

test("home renders a capacity meter per dimension", async () => {
  const frame = await gotoApp(page);
  for (const label of ["Orders this billing cycle", "Members"])
    await expect(frame.locator(`progress[aria-label="${label}"]`)).toBeVisible();
});

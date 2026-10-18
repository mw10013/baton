import type { FrameLocator, Page } from "playwright/test";
import * as Schema from "effect/Schema";

import { ShopFixtureData } from "../../../src/contract/fixture.ts";
import { dev, expect, type Run, test } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { appFrame } from "./app.ts";

/**
 * The orders index and the order page in the e2e specs: legacy `e2e/orders.spec.ts`'s helpers,
 * over data each test adds with `AddToFixture` under names, tags and order numbers of its own, so
 * no spec reads another's data.
 *
 * @module
 */

/** The test's own tail for names and tags: its id and its retry, so a retry adds afresh. */
export const own = () => {
  const { testId, retry } = test.info();
  return `${testId.slice(-8)}${String(retry)}`;
};

/**
 * The first of a run of order numbers of the test's own: a multiple of 100 in nine digits, so a
 * test's numbers share their first seven digits ({@link ownNumbers}) and no other test's do.
 */
export const ownBase = () => (1_000_000 + Math.floor(Math.random() * 8_999_999)) * 100;

/** A row of the orders index whose name is one of the numbers from `base` to `base + 99`. */
export const ownNumbers = (base: number) => new RegExp(`#${String(base / 100)}\\d\\d`, "u");

/**
 * Adds `parts` beside the store's data, decoded as the fixture decodes them; a clash fails the
 * test, the names being its own.
 */
export const add = (backend: Run, parts: Record<string, unknown>) =>
  backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: Schema.decodeUnknownSync(ShopFixtureData)({
          members: [],
          teams: [],
          workflows: [],
          orders: [],
          ...parts,
        }),
      }),
    ),
  );

/** The App nav's link to `name`, hoisted into the admin's chrome. */
const navLink = (page: Page, name: string) => page.getByRole("link", { name, exact: true });

/**
 * Opens the orders index from the App nav, bare (Making, no search, page one), and returns once
 * it shows. From a page under `/app/orders` it goes by Teams first, so the entry before the index
 * is never the index itself and the nav click is a navigation.
 */
export const openOrders = async (page: Page): Promise<FrameLocator> => {
  const frame = appFrame(page);
  if (new URL(page.url()).pathname.includes("/app/orders")) {
    await navLink(page, "Teams").click();
    await expect(frame.locator('s-page[heading="Teams"]')).toBeVisible();
  }
  await navLink(page, "Orders").click();
  await expect(page).toHaveURL(
    (url) => url.pathname.endsWith("/app/orders") && !url.search.includes("show="),
  );
  await expect(frame.locator('s-page[heading="Orders"]')).toBeVisible();
  return frame;
};

/** The App nav's Workflows or Teams link. */
export const openScreen = async (page: Page, name: "Workflows" | "Teams") => {
  await navLink(page, name).click();
  await expect(appFrame(page).locator(`s-page[heading="${name}"]`)).toBeVisible();
};

/**
 * A cell of the orders index's strip, by label and whatever count it is carrying. Its accessible
 * name is "<label>, <count>", with ", selected" on the chosen cell, so a test that asserts the
 * number names it in full, and {@link stripChosen} reads the suffix.
 */
export const stripCell = (frame: FrameLocator, label: string) =>
  frame.getByRole("button", { name: new RegExp(`^${label}, \\d+(?:, selected)?$`, "u") });

/** The chosen cell, by the suffix its accessible name carries. */
export const stripChosen = (frame: FrameLocator, label: string) =>
  frame.getByRole("button", { name: new RegExp(`^${label}, \\d+, selected$`, "u") });

/** The number a strip cell carries, read off its accessible name. */
export const stripCount = async (frame: FrameLocator, label: string) =>
  Number(
    new RegExp(`^${label}, (?<n>\\d+)`, "u").exec(
      (await stripCell(frame, label).getAttribute("aria-label")) ?? "",
    )?.groups?.["n"] ?? Number.NaN,
  );

/** The main filter, `OrdersShow`, labelled Show. */
export const showSelect = (frame: FrameLocator) => frame.getByRole("combobox", { name: "Show" });

/** Show: Open, every open order; the default is Making, which leaves out an order nobody started. */
export const showOpen = (frame: FrameLocator) => showSelect(frame).selectOption({ label: "Open" });

/** The search field both lists share (`ListSearchField`). */
export const searchField = (frame: FrameLocator) =>
  frame.getByRole("searchbox", { name: "Search" });

/** Searches the orders index for `text`, submitted on Enter. */
export const searchOrders = async (frame: FrameLocator, text: string) => {
  await searchField(frame).fill(text);
  await searchField(frame).press("Enter");
};

/**
 * Opens order `#n` from the orders index through its search, which reads every stored order
 * whatever the filters, and returns once its page shows.
 */
export const openOrder = async (page: Page, n: number) => {
  const frame = await openOrders(page);
  await searchOrders(frame, String(n));
  await frame.getByRole("link", { name: `#${String(n)}`, exact: true }).click();
  await expect(frame.locator(`s-page[heading="#${String(n)}"]`)).toBeVisible();
  return frame;
};

/** The order page's card for the item titled `title`. */
export const itemCard = (frame: FrameLocator, title: string) =>
  frame
    .locator("s-section")
    .filter({ has: frame.getByRole("heading", { name: title, exact: true }) });

/**
 * Chooses `label` in the orders index's Team select, and returns once the URL has taken the
 * team: a control pressed before the navigation commits would write the old team back.
 */
export const chooseTeam = async (page: Page, frame: FrameLocator, label: string) => {
  const before = listContext(page).team;
  await frame.getByRole("combobox", { name: "Team" }).selectOption({ label });
  await expect.poll(() => listContext(page).team).not.toBe(before);
};

/** The orders index's context as the admin's URL mirrors it from the app. */
export const listContext = (page: Page) => {
  const url = new URL(page.url());
  return {
    show: url.searchParams.get("show"),
    team: url.searchParams.get("team"),
    after: url.searchParams.get("after"),
  };
};

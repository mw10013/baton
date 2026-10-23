import type { Browser, BrowserContext, Locator, Page } from "playwright/test";
import * as Schema from "effect/Schema";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import { dev, expect, own, type Run, signInMember, test, testEmail } from "./fixtures.ts";
import { E2E_SHOP } from "./shop-fixture.ts";

/**
 * Helpers for the member's two screens in the e2e specs, over data each test adds with `AddToFixture` under names, tags, addresses and order numbers of
 * its own, so no spec reads another's data and the counts on the strip are the test's alone.
 *
 * @module
 */

/** The first of a run of order numbers of the test's own: a multiple of 1000, so 999 follow it. */
const ownBase = () => (1_000_000 + Math.floor(Math.random() * 8_999_999)) * 1000;

/** State labels, as the strip writes them. */
export const STARTED_BY_YOU = "Started by you";
export const READY = "Ready";
export const STARTED_BY_OTHERS = "Started by others";
export const BLOCKED = "Blocked";
export const DONE_OR_CLOSED = "Done or closed";
export const EMPTY_MINE = "Nothing started by you.";
export const EMPTY_TEAMMATES = "Nothing started by others.";
export const EMPTY_DONE = "Nothing done or closed in the last day.";
export const CUT_TASK = "Cut";
/** The landing state, which the URL never spells out. */
export const DEFAULT_STATE = "started_by_you";

/**
 * One test's world, every name ending in the test's own id: the maker on Cut, the mate on Cut
 * and Pack, the ring (Cut) and box (Pack) workflows and orders, and the order numbers the rest
 * take.
 */
export const world = () => {
  const id = own();
  const base = ownBase();
  const order = (offset: number) => `#${String(base + offset)}`;
  return {
    id,
    base,
    MAKER: testEmail("maker"),
    MATE: testEmail("mate"),
    CUT_TEAM: `E2E Runs Cut ${id}`,
    PACK_TEAM: `E2E Runs Pack ${id}`,
    RING_TAG: `e2e-runs-ring-${id}`,
    BOX_TAG: `e2e-runs-box-${id}`,
    BAND_TAG: `e2e-runs-band-${id}`,
    SPLIT_TAG: `e2e-runs-split-${id}`,
    RING_WORKFLOW: `E2E Runs Ring ${id}`,
    RING_ORDER: order(1),
    RING_ITEM: "E2E Ring Band",
    BOX_ORDER: order(2),
    BOX_VARIANT: "Large",
    BAND_ORDER: order(3),
    BAND_ITEM: "E2E Cuff",
    PAIR_ORDER: order(4),
    SPLIT_ORDER: order(5),
    LONG_ORDER: order(6),
    SAME_ORDER: order(7),
    order,
    /** Every order of the test's: its rows announce `Open <item> on #<base…>`. */
    ORDER_LINK: new RegExp(`^Open .+ on #${String(base / 1000)}\\d{3}$`, "u"),
    ORDER_TEXT: new RegExp(`Open [^"<>]+ on #${String(base / 1000)}\\d{3}`, "gu"),
  };
};
export type World = ReturnType<typeof world>;

/** Adds `parts` beside the store's data, decoded as the fixture decodes them. */
export const add = (backend: Run, parts: Record<string, unknown>) =>
  backend(
    dev((c) =>
      c.AddToFixture({
        shop: E2E_SHOP,
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

/** Filler Cut orders: the ring order is a Cut order too, so Ready is one more for each member. */
export const BULK_COUNT = 25;
const BULK_FIRST = 10;

/** Adds the test's two members, two teams, workflows and orders. */
export const seedRuns = (
  backend: Run,
  w: World,
  options: {
    readonly cutMembers: "both" | "maker";
    readonly withBand?: boolean;
    readonly withSplit?: boolean;
    readonly bandDoneByMerchant?: boolean;
    readonly withBulk?: boolean;
    readonly bulkCount?: number;
  },
) =>
  add(backend, {
    members: [w.MAKER, w.MATE],
    teams: [
      { name: w.CUT_TEAM, members: options.cutMembers === "both" ? [w.MAKER, w.MATE] : [w.MAKER] },
      { name: w.PACK_TEAM, members: [w.MATE] },
    ],
    workflows: [
      { name: w.RING_WORKFLOW, tag: w.RING_TAG, tasks: [{ name: "Cut", team: w.CUT_TEAM }] },
      {
        name: `E2E Runs Box ${w.id}`,
        tag: w.BOX_TAG,
        tasks: [{ name: "Pack", team: w.PACK_TEAM }],
      },
      ...(options.withSplit === true
        ? [
            {
              name: `E2E Runs Split ${w.id}`,
              tag: w.SPLIT_TAG,
              tasks: [
                { name: "Cut", team: w.CUT_TEAM, step: 1 },
                { name: "Pack", team: w.PACK_TEAM, step: 1 },
              ],
            },
          ]
        : []),
      ...(options.withBand === true
        ? [
            {
              name: `E2E Runs Band ${w.id}`,
              tag: w.BAND_TAG,
              tasks: [
                { name: "Cut", team: w.CUT_TEAM },
                { name: "Polish", team: w.PACK_TEAM },
              ],
            },
          ]
        : []),
    ],
    orders: [
      { n: w.base + 1, lineItems: [{ title: w.RING_ITEM, quantity: 1, tags: [w.RING_TAG] }] },
      {
        n: w.base + 2,
        lineItems: [
          {
            title: "E2E Gift Box",
            variantTitle: w.BOX_VARIANT,
            sku: "E2E-BOX-L",
            quantity: 1,
            tags: [w.BOX_TAG],
          },
        ],
      },
      ...(options.withBand === true
        ? [
            {
              n: w.base + 3,
              lineItems: [{ title: w.BAND_ITEM, quantity: 1, tags: [w.BAND_TAG] }],
              ...(options.bandDoneByMerchant === true ? { advance: 1, byMerchant: true } : {}),
            },
          ]
        : []),
      ...(options.withSplit === true
        ? [{ n: w.base + 5, lineItems: [{ title: "E2E Split", quantity: 2, tags: [w.SPLIT_TAG] }] }]
        : []),
      ...(options.withBulk === true
        ? Array.from({ length: options.bulkCount ?? BULK_COUNT }, (_unused, index) => ({
            n: w.base + BULK_FIRST + index,
            lineItems: [
              { title: `E2E Bulk Ring ${String(index + 1)}`, quantity: 1, tags: [w.RING_TAG] },
            ],
          }))
        : []),
    ],
  });

/** A property stamped on the live document: a navigation would boot a new one and lose it. */
interface MarkedWindow extends Window {
  batonDocumentMark?: true;
}
export const markDocument = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as MarkedWindow).batonDocumentMark = true;
  });
export const expectSameDocument = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => (window as MarkedWindow).batonDocumentMark === true)).toBe(true);
};

/** Each member signed in once per test, by address. */
const sessions = new Map<string, BrowserContext>();

/** The contexts a test opened, closed after it. */
export const closeMembers = async () => {
  await Promise.all([...sessions.values()].map((context) => context.close()));
  sessions.clear();
};

/** The workflows list's section: the page has no heading, the section's label names it. */
export const workflowsSection = (page: Page) =>
  page.locator('s-section[accessibilityLabel="Workflows"]');

/** Navigates and waits for hydration. */
export const gotoMember = async (page: Page, path: string) => {
  await page.goto(path);
  await page.locator("body[data-hydrated]").waitFor();
};

/**
 * Lands `email` on the workflows list in a new page of its own signed-in context, at `state`
 * when given. The first page for an address signs it in through the form.
 */
export const openRuns = async (
  browser: Browser,
  email: string,
  stateKey?: string,
): Promise<Page> => {
  const existing = sessions.get(email);
  const page =
    existing === undefined
      ? await signInMember(browser, email as Parameters<typeof signInMember>[1]).then(
          ({ context, page }) => {
            sessions.set(email, context);
            return page;
          },
        )
      : await existing.newPage();
  await gotoMember(
    page,
    `/shop/${E2E_SHOP}/workflows${stateKey === undefined ? "" : `?state=${stateKey}`}`,
  );
  await expect(workflowsSection(page)).toBeVisible();
  return page;
};

/** A state's cell on the strip: "<label>, <count>", with ", selected" on the chosen cell. */
export const stateCell = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`^${label}, [\\d,]+(, selected)?$`, "u") });

/** A state's cell carrying exactly `count`, chosen or not. */
export const stateCount = (page: Page, label: string, count: number) =>
  page.getByRole("button", {
    name: new RegExp(`^${label}, ${String(count)}(, selected)?$`, "u"),
  });

/** The chosen state's cell. */
export const chosenState = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`^${label}, [\\d,]+, selected$`, "u") });

/** The Team select, for a member on more than one team. */
export const teamSelect = (page: Page) => page.getByRole("combobox", { name: "Team" });

/** The Team select's chosen team, by its option's text. */
export const chosenTeam = (page: Page) => teamSelect(page).locator("option:checked");

/** The Team select reads Any team by its value (`ANY_OPTION_VALUE`). */
export const expectAnyTeam = (page: Page) => expect(teamSelect(page)).toHaveValue("any");

/** Switches states and waits for the URL and the chosen cell. */
export const selectState = async (page: Page, name: string, label: string): Promise<void> => {
  await stateCell(page, label).click();
  await expect(page).toHaveURL((url) => (url.searchParams.get("state") ?? DEFAULT_STATE) === name);
  await expect(chosenState(page, label)).toBeVisible();
};

/** The bar's way home: the shop's domain, linking to its workflows list. */
export const homeLink = (page: Page) => page.locator("a.top-bar-home");

/** The workflow page's way back, above its heading. */
export const workflowsLink = (page: Page) =>
  page.getByRole("link", { name: "Workflows", exact: true });

/** The `team` the address bar is carrying, or `null`. */
export const teamParam = (page: Page) => new URL(page.url()).searchParams.get("team");

/** The rows a cold request paints, counted in the HTML the server sent. */
export const serverRows = async (page: Page, w: World, path: string): Promise<number> => {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  return (await response.text()).match(w.ORDER_TEXT)?.length ?? 0;
};

/** A row's own link to the workflow page, found by its order. */
export const rowLink = (page: Page, orderName: string) =>
  page.getByRole("link", { name: new RegExp(`^Open .+ on ${orderName}$`, "u") });

/** The row for one order. */
export const card = (page: Page, orderName: string) =>
  page.locator("[data-part=resource-row]").filter({ has: rowLink(page, orderName) });

/** A row's lines, top to bottom. */
export const rowLines = (page: Page, orderName: string) =>
  card(page, orderName).locator("[data-part=row-head], [data-part=row-line]");

/** A row's menu button; enabled once the socket is open. */
export const rowMenu = (page: Page, orderName: string) =>
  card(page, orderName).getByRole("button", { name: `Actions for ${orderName}` });

/** Opens a row's menu and takes the named verb. */
export const rowAction = async (page: Page, orderName: string, action: string): Promise<void> => {
  await rowMenu(page, orderName).click();
  await card(page, orderName).getByRole("menuitem", { name: action, exact: true }).click();
};

/** The workflow page for `orderName`, by its heading. */
export const workflowPage = (page: Page, orderName: string) =>
  page.locator(`s-page[heading="${orderName}"]`);

/** One task's row inside a step box, by task name. */
export const taskRow = (box: Locator, name: string) =>
  box.locator("s-box").filter({ has: box.page().getByText(name, { exact: true }) });

/** The labels of a row's buttons, in document order, read from each `s-button` host. */
export const buttonLabels = (row: Locator) =>
  row.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const root = button.getRootNode();
      const host = root instanceof ShadowRoot ? root.host : button;
      return host.textContent?.trim() ?? "";
    }),
  );

export { test };

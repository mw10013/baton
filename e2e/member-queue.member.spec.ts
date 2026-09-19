import type { Browser, BrowserContext, Page } from "@playwright/test";

import type { SeedConfig } from "./seed";

import { expect, test } from "@playwright/test";

import { awaitEnabled, clickWhenEnabled, gotoMember, signIn } from "./member";
import { seedConfig, seedMembers } from "./seed";

/**
 * The member queue through a real browser: cookie → Worker gate → member
 * socket → `@callable()`. The integration suite already proves the object's
 * side; what only a browser can prove is that a member holding nothing but a
 * better-auth cookie reaches the Durable Object at all, that the page's
 * buttons drive the socket rather than a form post, and that a push or a
 * revocation changes the page with no navigation.
 *
 * This file signs in exactly twice — once per member, in `beforeAll` — and
 * every test re-creates its contexts from the storage state that produced,
 * because a magic-link round trip is the slowest step in the file. That is
 * what `keepIdentities` on the seed is for: a seed normally drops the
 * better-auth `User` of every email it touches, which would sign both members
 * out on the first re-seed. With it on, each test still gets a pristine
 * fixture (members, teams, workflows and orders are replaced wholesale) while
 * the two sessions survive.
 *
 * Two teams, so team scoping is observable from both sides: the maker is on
 * `CUT_TEAM` only and the mate is on both, so the mate's queue holds a card
 * the maker's cannot show.
 */

const MAKER = "e2e.queue.maker@example.com";
const MATE = "e2e.queue.mate@example.com";
const CUT_TEAM = "E2E Queue Cut";
const PACK_TEAM = "E2E Queue Pack";
const RING_TAG = "e2e-queue-ring";
const BOX_TAG = "e2e-queue-box";
/** Routed to `CUT_TEAM`, so both members see it. */
const RING_ORDER = "#9401";
/** Routed to `PACK_TEAM`, so only the mate sees it. */
const BOX_ORDER = "#9402";
/** Routed Cut → Polish across the two teams; seeded only where a test needs downstream work. */
const BAND_ORDER = "#9403";
const BAND_TAG = "e2e-queue-band";
/** The queue card names the step and nothing else: progress is the work page's. */
const CUT_STEP = "Cut";
const STARTED = "In progress since";
/** Per-tab empty text (`TAB_EMPTY` in `src/lib/queueTiers.ts`). */
const EMPTY_MINE = "Nothing in hand.";
const EMPTY_DONE = "Nothing finished in the last day.";
/** Every seeded order is `#94xx`, which is how a card is counted rather than read. */
const ORDER_LINK = /^#94\d\d$/u;
/**
 * Filler Cut orders, numbered clear of the three named ones. Twenty-five and
 * not twenty-four: the ring order is a Cut order too, so the mate's Up next
 * comes to twenty-seven and the maker's to twenty-six — both over
 * `Domain.QUEUE_PAGE` (25), and the two counts differ, so an assertion cannot
 * pass by reading the wrong page.
 */
const BULK_COUNT = 25;
const BULK_FIRST = 9410;

/** Tab labels, as `TAB_LABEL` writes them on the strip. */
const MINE = "Mine";
const UP_NEXT = "Up next";
const IN_PROGRESS = "In progress";
const BLOCKED = "Blocked";
const DONE_TODAY = "Done today";

/**
 * One workflow per team and one order for each, so every assertion about who
 * sees what is a fact about the seeded team rather than about ordering. Both
 * workflows are fully assigned, which turns them on, and both orders are
 * seeded fresh (`pending`, nothing started), so each carries exactly one ready
 * step.
 */
const seedQueue = (
  config: SeedConfig,
  options: {
    readonly cutMembers: readonly string[];
    readonly keepIdentities: boolean;
    /** Adds the two-stage band order, for the tests about downstream work. */
    readonly withBand?: boolean;
    /**
     * Seeds the band order with its first stage already finished **by the
     * merchant** — the state an intervention on the order page leaves behind,
     * reached here without an admin session (`SeedOrder.byMerchant`).
     */
    readonly bandDoneByMerchant?: boolean;
    /**
     * Enough more Cut orders to cross `Domain.QUEUE_PAGE`, which is the only
     * way to reach Show more. They carry nothing a test reads but their names:
     * the cut is about how many rows the read returns, not what is on them.
     */
    readonly withBulk?: boolean;
  },
) =>
  seedMembers(
    config,
    [MAKER, MATE],
    [
      { name: CUT_TEAM, members: options.cutMembers },
      { name: PACK_TEAM, members: [MATE] },
    ],
    [
      {
        name: "E2E Queue Ring",
        tag: RING_TAG,
        steps: [{ name: "Cut", team: CUT_TEAM }],
      },
      {
        name: "E2E Queue Box",
        tag: BOX_TAG,
        steps: [{ name: "Pack", team: PACK_TEAM }],
      },
      ...(options.withBand === true
        ? [
            {
              name: "E2E Queue Band",
              tag: BAND_TAG,
              steps: [
                { name: "Cut", team: CUT_TEAM },
                { name: "Polish", team: PACK_TEAM },
              ],
            },
          ]
        : []),
    ],
    [
      {
        n: 9401,
        lineItems: [{ title: "E2E Ring Band", quantity: 1, tags: [RING_TAG] }],
      },
      {
        n: 9402,
        lineItems: [{ title: "E2E Gift Box", quantity: 1, tags: [BOX_TAG] }],
      },
      ...(options.withBand === true
        ? [
            {
              n: 9403,
              lineItems: [{ title: "E2E Cuff", quantity: 1, tags: [BAND_TAG] }],
              ...(options.bandDoneByMerchant === true
                ? { advance: 1, byMerchant: true }
                : {}),
            },
          ]
        : []),
      ...(options.withBulk === true
        ? Array.from({ length: BULK_COUNT }, (_unused, index) => ({
            n: BULK_FIRST + index,
            lineItems: [
              {
                title: `E2E Bulk Ring ${String(index + 1)}`,
                quantity: 1,
                tags: [RING_TAG],
              },
            ],
          }))
        : []),
    ],
    { keepIdentities: options.keepIdentities },
  );

/**
 * A property stamped on the live document. Every assertion below about the UI
 * moving "without a reload" reads it back afterwards: a navigation would boot
 * a new document and take the stamp with it, whereas the router invalidation
 * and the query refetch this file is testing both keep the document they
 * started in.
 */
interface MarkedWindow extends Window {
  batonDocumentMark?: true;
}

const markDocument = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as MarkedWindow).batonDocumentMark = true;
  });

const expectSameDocument = async (page: Page): Promise<void> => {
  expect(
    await page.evaluate(
      () => (window as MarkedWindow).batonDocumentMark === true,
    ),
  ).toBe(true);
};

/** Signed-in cookie jars, minted once in `beforeAll` and replayed into a fresh context per test. */
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let makerState: StorageState;
let mateState: StorageState;

/**
 * `browser.newContext` inherits nothing from the project's `use`, so `baseURL`
 * is passed explicitly — without it the relative paths every helper navigates
 * to have nothing to resolve against.
 */
const memberContext = (
  browser: Browser,
  config: SeedConfig,
  storageState: StorageState,
) => browser.newContext({ baseURL: config.appUrl, storageState });

const contexts: BrowserContext[] = [];

/**
 * Land a signed-in member on their queue. `tab` goes in the URL rather than
 * through a click, because the tab is a search param and most tests here are
 * about the rows rather than about getting to them; the default landing tab
 * is Mine, which is empty until somebody starts something.
 */
const openQueue = async (
  browser: Browser,
  config: SeedConfig,
  storageState: StorageState,
  tab?: string,
): Promise<Page> => {
  const context = await memberContext(browser, config, storageState);
  contexts.push(context);
  const page = await context.newPage();
  await gotoMember(
    page,
    `/shop/${config.shop}${tab === undefined ? "" : `?tab=${tab}`}`,
  );
  await expect(page.locator('s-page[heading="Queue"]')).toBeVisible();
  return page;
};

/**
 * A tab's button on the strip, by label and whatever count it is carrying. The
 * count is part of the accessible name, so a test that wants to assert the
 * number names it in full instead.
 */
const tab = (page: Page, label: string) =>
  page.getByRole("button", {
    name: new RegExp(`^${label} · \\d+$`, "u"),
  });

/**
 * Switch tabs and wait for the switch to land. The wait is on the URL rather
 * than on `aria-pressed`, because `getByRole` may resolve to either the
 * `s-button` host or the native button inside its shadow root and only the
 * host carries the attribute — the search param is the same fact, on the
 * side that cannot be ambiguous.
 */
const selectTab = async (
  page: Page,
  name: string,
  label: string,
): Promise<void> => {
  await tab(page, label).click();
  await expect(page).toHaveURL(new RegExp(`[?&]tab=${name}(&|$)`, "u"));
};

/**
 * The queue row for one order: the innermost `s-box` holding that order's
 * link. `.last()`, not `.first()`: the tab's list container is an `s-box`
 * around every row and so matches the same filter, and it is the ancestor, so
 * document order puts it first.
 */
const card = (page: Page, orderName: string) =>
  page
    .locator("s-box")
    .filter({ has: page.getByRole("link", { name: orderName, exact: true }) })
    .last();

/**
 * Opens a row's detail. The row is three columns and only the middle one
 * toggles — an `s-clickable` around a button would be a button inside a
 * button — so the target is that clickable, by the label it announces.
 */
const expandRow = (page: Page, orderName: string) =>
  page.locator(`s-clickable[accessibilityLabel="Expand ${orderName}"]`).click();

test.describe.configure({ mode: "serial" });

/**
 * Seeded destructively first (no `keepIdentities`) so both members sign in as
 * first-time users against a fixture with no leftovers, exactly as a
 * standalone member spec would.
 */
test.beforeAll(async ({ browser }) => {
  const config = seedConfig();
  await seedQueue(config, {
    cutMembers: [MAKER, MATE],
    keepIdentities: false,
  });
  const signInAs = async (email: string): Promise<StorageState> => {
    const context = await memberContext(browser, config, {
      cookies: [],
      origins: [],
    });
    const page = await context.newPage();
    await signIn(page, email);
    // A one-shop member lands on the queue itself, not the picker.
    await expect(page.locator('s-page[heading="Queue"]')).toBeVisible();
    const state = await context.storageState();
    await context.close();
    return state;
  };
  makerState = await signInAs(MAKER);
  mateState = await signInAs(MATE);
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

/**
 * The whole path in one test: the cookie authorizes the socket, the socket
 * carries the write, and the answer repaints the page the member is standing
 * on. Nothing here posts a form — Start and Done are `@callable()`s, so a
 * broken gate or a socket that never identifies leaves the buttons disabled
 * and `clickWhenEnabled` fails on the button rather than on the outcome.
 */
test("a member starts and completes their team's ready step over the socket", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openQueue(browser, config, makerState, "upNext");

  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(page.getByText(CUT_STEP, { exact: true })).toBeVisible();
  await expect(page.getByText(STARTED)).toBeHidden();
  await markDocument(page);

  await clickWhenEnabled(page.getByRole("button", { name: "Start" }));
  /* Starting moves the row off the tab it was started from: Up next is what
     nobody has in hand, and the strip says where it went. That the counts
     moved at all is the page's own state following the object's — proof the
     answer was applied, not just accepted. */
  await expect(page.getByRole("button", { name: `${MINE} · 1` })).toBeVisible();
  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 0` }),
  ).toBeVisible();
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeHidden();

  await selectTab(page, "mine", MINE);
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expandRow(page, RING_ORDER);
  await expect(page.getByText(STARTED)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toBeHidden();

  /* The row's Done and the step's Done both finish the same step; the row's
     is the one a thumb hits. */
  await clickWhenEnabled(
    page.getByRole("button", { name: "Done", exact: true }).first(),
  );
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeHidden();
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();
  await expectSameDocument(page);
});

/**
 * Two members, two browsers, one team's work. The mate observes, the maker
 * acts, and the mate's page is never touched after it loads — so every change
 * it shows arrived as a `publish` over its own socket.
 *
 * The observer's page is opened first: its `subscribeQueue` has to be
 * registered before the write it is meant to hear about, and the maker's own
 * page load and socket handshake are the margin.
 *
 * The cross-team half rides along: the box order is routed to a team the maker
 * is not on, so it must be absent from the maker's queue while sitting in
 * plain sight on the mate's, and it must still be there after the ring work is
 * finished.
 */
test("a completed step lands on another member's queue without a reload", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });

  const mate = await openQueue(browser, config, mateState, "upNext");
  await expect(mate.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(mate.getByText(BOX_ORDER, { exact: true })).toBeVisible();
  await awaitEnabled(mate.getByRole("button", { name: "Start" }).first());
  await markDocument(mate);

  const maker = await openQueue(browser, config, makerState, "upNext");
  await expect(maker.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(maker.getByText(BOX_ORDER, { exact: true })).toBeHidden();
  await expect(maker.getByText("Pack")).toBeHidden();

  await clickWhenEnabled(maker.getByRole("button", { name: "Start" }));
  /* The push reaches the mate whatever tab they are on: the strip renumbers
     under them while they are still reading Up next. */
  await expect(
    mate.getByRole("button", { name: `${IN_PROGRESS} · 1` }),
  ).toBeVisible();
  await expect(
    mate.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();

  /* The mate's row says who has it without being opened; the start time is
     inside the detail, which only its own reader opens. */
  await selectTab(mate, "inProgress", IN_PROGRESS);
  await expect(mate.getByText(`In progress · ${MAKER}`)).toBeVisible();
  await expandRow(mate, RING_ORDER);
  await expect(mate.getByText(STARTED)).toBeVisible();

  await selectTab(maker, "mine", MINE);
  await clickWhenEnabled(
    maker.getByRole("button", { name: "Done", exact: true }).first(),
  );
  await expect(mate.getByText(RING_ORDER, { exact: true })).toBeHidden();
  /* The mate's other team is untouched by the ring order's fan-out, so the
     refetch must not have emptied the page wholesale. */
  await expect(
    mate.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();
  await expect(
    mate.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
  await expectSameDocument(mate);
});

/**
 * Taking a member off a team while they are standing on the queue. The seed
 * ends by revoking the connections of the members it replaced, which is what
 * `app.members` and `app.teams.$teamId` do after their own roster writes, so
 * this is the same close a merchant edit produces: code 4401, `/shop/$shop`
 * invalidates the router, and the loader re-runs against the new membership.
 *
 * The socket must be up before the re-seed or there is nothing to revoke and
 * the test would pass for the wrong reason — hence `awaitEnabled` first, which
 * is exactly the identified gate.
 *
 * The member keeps their shop membership here, so the answer is the queue's
 * "not on a team yet" state rather than not-found; `member-area.member.spec.ts`
 * owns the removed-from-the-shop case.
 */
test("removing a member from a team empties their open queue", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openQueue(browser, config, makerState, "upNext");
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await awaitEnabled(page.getByRole("button", { name: "Start" }));
  await markDocument(page);

  await seedQueue(config, { cutMembers: [MATE], keepIdentities: true });

  await expect(page.getByText(RING_ORDER, { exact: true })).toBeHidden();
  await expect(page.getByText("You’re not on a team yet.")).toBeVisible();
  await expectSameDocument(page);
});

/**
 * The strip, driven by the two real actors rather than the seed: untouched
 * work is counted under "Up next"; the maker's own Start moves the card to
 * "Mine" on their page and to "In progress" — naming them — on the mate's,
 * which arrives by push. The counts on the strip are the shape of the day,
 * and every tab stays on it whatever its count, so nothing reflows when a
 * number crosses zero.
 */
test("a started card moves to Mine for the starter and In progress for a teammate", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const mate = await openQueue(browser, config, mateState, "upNext");
  await expect(
    mate.getByRole("button", { name: `${UP_NEXT} · 2` }),
  ).toBeVisible();
  await awaitEnabled(mate.getByRole("button", { name: "Start" }).first());

  const maker = await openQueue(browser, config, makerState, "upNext");
  await expect(
    maker.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();
  await clickWhenEnabled(maker.getByRole("button", { name: "Start" }));
  await expect(
    maker.getByRole("button", { name: `${MINE} · 1` }),
  ).toBeVisible();
  /* The emptied tab keeps its place on the strip rather than disappearing. */
  await expect(
    maker.getByRole("button", { name: `${UP_NEXT} · 0` }),
  ).toBeVisible();

  await selectTab(maker, "mine", MINE);
  /* The tab is said by the strip and by nothing on the card: the card that
     moved to "Mine · 1" carries no badge repeating it. */
  await expect(card(maker, RING_ORDER).getByText(MINE)).toHaveCount(0);

  await expect(
    mate.getByRole("button", { name: `${IN_PROGRESS} · 1` }),
  ).toBeVisible();
  await expect(
    mate.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();
  await selectTab(mate, "inProgress", IN_PROGRESS);
  await expect(mate.getByText(`In progress · ${MAKER}`)).toBeVisible();
});

/**
 * The one place in the member area where the number on the strip is not the
 * number of rows under it. Up next is cut to `Domain.QUEUE_PAGE` (25) and the
 * strip still counts the whole tab, which is the promise being tested: a
 * member who reads "Up next · 27" above twenty-five rows must be able to reach
 * the other two — and the button that does it asks the object for a deeper
 * read rather than revealing rows the page was already holding. A member who
 * then narrows to one team must not be shown a stale expansion from the wider
 * list. The teammate drives it because the team select only renders for
 * someone on more than one team.
 */
test("Up next cuts at a page, pages on Show more, and re-cuts when the team changes", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, {
    cutMembers: [MAKER, MATE],
    keepIdentities: true,
    withBulk: true,
  });
  const page = await openQueue(browser, config, mateState, "upNext");

  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 27` }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(25);

  await page.getByRole("button", { name: "Show 2 more of 2" }).click();
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(27);
  await expect(
    page.getByRole("button", { name: /^Show \d+ more/u }),
  ).toHaveCount(0);

  /* The team counts are over every team whatever is selected, so the option
     names the same 26 before and after it is chosen. */
  await page
    .getByRole("combobox", { name: "Team" })
    .selectOption({ label: `${CUT_TEAM} · 26` });
  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 26` }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(25);
  await expect(
    page.getByRole("button", { name: "Show 1 more of 1" }),
  ).toBeVisible();
});

/**
 * The tab is a search param, so it survives a paste into the address bar and
 * it is what the back button walks out of. `replace: true` on the switch is
 * the second half: a member who glanced at three tabs presses Back once and
 * is out of the queue, not walked back through them.
 */
test("the tab is in the URL and switching tabs replaces it", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openQueue(browser, config, makerState);
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();

  await gotoMember(page, `/shop/${config.shop}?tab=upNext`);
  /* First paint, no click: the loader read the tab out of the URL. */
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();

  await selectTab(page, "attention", BLOCKED);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/shop/${config.shop}$`, "u"));
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();
});

/**
 * Done today and Undo. The finished step leaves the queue for the Done tab;
 * Undo puts it back, and because Undo keeps the original starter the card
 * returns to "Mine", not "Up next".
 */
test("undo puts a finished step back in progress", async ({ browser }) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openQueue(browser, config, makerState, "upNext");
  await expect(
    page.getByRole("button", { name: `${DONE_TODAY} · 0` }),
  ).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Start" }));
  await selectTab(page, "mine", MINE);
  await clickWhenEnabled(
    page.getByRole("button", { name: "Done", exact: true }).first(),
  );
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();
  await expect(
    page.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
  /* Unopened, the tab is a count and nothing else: its rows are a different
     read, so the Undo below is only reachable once the tab is chosen. */
  await selectTab(page, "done", DONE_TODAY);
  await expect(page.getByText(`by ${MAKER} at`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText(EMPTY_DONE)).toBeVisible();
  await expect(page.getByRole("button", { name: `${MINE} · 1` })).toBeVisible();
  /* Back under Mine, and the row says it is the reader's own without being
     opened; a row that arrives after the first paint stays collapsed. */
  await selectTab(page, "mine", MINE);
  await expect(page.getByText("In progress · you")).toBeVisible();
});

/**
 * Once downstream has started the fix is a conversation: the mate (on the
 * Polish team) starts the next stage, and the maker's Done today entry loses
 * its Undo button for the "ask them" line naming that team and step.
 */
test("undo is refused once downstream started", async ({ browser }) => {
  const config = seedConfig();
  await seedQueue(config, {
    cutMembers: [MAKER],
    keepIdentities: true,
    withBand: true,
  });
  const maker = await openQueue(browser, config, makerState, "upNext");
  /* A step nobody has started offers Start on the row; Done for it is in the
     detail, which is what the row opens. */
  await expandRow(maker, BAND_ORDER);
  await clickWhenEnabled(
    card(maker, BAND_ORDER).getByRole("button", { name: "Done", exact: true }),
  );
  await expect(
    maker.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
  await selectTab(maker, "done", DONE_TODAY);
  await expect(maker.getByRole("button", { name: "Undo" })).toBeVisible();

  const mate = await openQueue(browser, config, mateState, "upNext");
  await clickWhenEnabled(
    card(mate, BAND_ORDER).getByRole("button", { name: "Start" }),
  );

  await expect(
    maker.getByText(`${PACK_TEAM} started Polish · ask them`),
  ).toBeVisible();
  await expect(maker.getByRole("button", { name: "Undo" })).toBeHidden();
});

/**
 * The work page: opened from the card's order number, it lists every step
 * with its state, takes a note and a block, finishes the step, and reads the
 * actor back. Block comes before Done because blocking needs a ready step on
 * the member's team, and Cut is the maker's only one.
 */
test("the work page shows the step history and takes a note, a block, and Done", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, {
    cutMembers: [MAKER],
    keepIdentities: true,
    withBand: true,
  });
  const page = await openQueue(browser, config, makerState, "upNext");
  await page.getByRole("link", { name: BAND_ORDER, exact: true }).click();
  await expect(page.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();
  await expect(page.getByText("E2E Cuff ×1")).toBeVisible();
  await expect(page.getByText("Waiting on step 1")).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Add note" }));
  /* The cap announces itself before the write refuses it: past
     `Domain.NOTE_COUNT_FROM` (800) the field counts down to
     `Domain.STEP_NOTE_MAX_LENGTH` (1000). Nothing says so below the
     threshold, which is the other half of the rule. */
  await page.getByLabel("Note").fill("x".repeat(799));
  await expect(page.getByText("characters left")).toBeHidden();
  await page.getByLabel("Note").fill("x".repeat(950));
  await expect(page.getByText("50 characters left")).toBeVisible();
  await page.getByLabel("Note").fill("Left edge is rough");
  await clickWhenEnabled(page.getByRole("button", { name: "Save note" }));
  await expect(page.getByText("Note: Left edge is rough")).toBeVisible();

  /* The block, and what a block means: the banner heading names the flag, the
     body is the reason with no prefix, and Done is gone until the hold is
     lifted. Edit reason rewrites the text in place — two lines, kept as
     typed — without touching the hold. */
  await page.getByLabel("Reason").fill("Waiting on stones");
  await clickWhenEnabled(page.getByRole("button", { name: "Block" }));
  await expect(page.locator('s-banner[heading="Blocked"]')).toBeVisible();
  await expect(page.getByText("Waiting on stones")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);

  await clickWhenEnabled(page.getByRole("button", { name: "Edit reason" }));
  await page
    .getByLabel("Reason")
    .fill("Waiting on stones\nCalled the supplier");
  await clickWhenEnabled(page.getByRole("button", { name: "Save reason" }));
  await expect(page.getByText("Called the supplier")).toBeVisible();
  await expect(page.locator('s-banner[heading="Blocked"]')).toBeVisible();

  /* The same hold as the queue reads it: the card carries its one action
     inside the banner and offers no step buttons at all, which is the whole
     of "blocked means stop". */
  await page.getByRole("link", { name: "Queue", exact: true }).click();
  await expect(page.locator('s-page[heading="Queue"]')).toBeVisible();
  /* The breadcrumb carries no tab, so the queue lands on Mine; a held run is
     on Blocked, which the strip counts from wherever the reader is. */
  await selectTab(page, "attention", BLOCKED);
  const blocked = card(page, BAND_ORDER);
  await expect(blocked.getByRole("button", { name: "Unblock" })).toBeVisible();
  await expect(blocked.getByRole("button", { name: "Start" })).toHaveCount(0);
  await expect(
    blocked.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: BAND_ORDER, exact: true }).click();
  await expect(page.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Unblock" }));
  await clickWhenEnabled(
    page.getByRole("button", { name: "Done", exact: true }),
  );
  await expect(page.getByText(`Done by ${MAKER}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  await page.getByRole("link", { name: "Queue", exact: true }).click();
  await expect(page.locator('s-page[heading="Queue"]')).toBeVisible();
  /* Cut is done and Polish is the packer's, so the run is no card of the
     maker's any more; what remains of it on this page is the Done entry. */
  await expect(
    page.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
});

/**
 * What a worker sees after the merchant has been in. The intervention is
 * seeded rather than clicked: the merchant acts from the embedded admin, which
 * this project deliberately has no session for (see `playwright.config.ts` —
 * no `setup` dependency, so a run never prompts for Keychain access), and
 * `SeedOrder.byMerchant` puts the same rows in the object that
 * `merchantCompleteStep` would. `e2e/orders.spec.ts` drives the merchant's own
 * buttons; this is the other end of the wire.
 *
 * The Undo here is the *member's*, which is the point of the second half: the
 * "Reopened by …" line is one rendering, and a merchant reopen exercising it
 * is asserted on the order page instead.
 */
test("a merchant's completion reads as Merchant on the queue and the work page", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, {
    cutMembers: [MAKER],
    keepIdentities: true,
    withBand: true,
    bandDoneByMerchant: true,
  });
  const page = await openQueue(browser, config, makerState);

  await expect(
    page.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
  await selectTab(page, "done", DONE_TODAY);
  await expect(page.getByText("by Merchant at")).toBeVisible();

  await page.getByRole("link", { name: BAND_ORDER, exact: true }).click();
  await expect(page.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();
  await expect(page.getByText("Done by Merchant")).toBeVisible();

  /* The maker takes it back: the same line the merchant's reopen writes, with
     the member in the slot, and Cut is ready again. Start is offered because
     undo clears the merchant's backfilled start — the step is nobody's, not
     "in progress by Merchant". */
  await clickWhenEnabled(page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText(`Reopened by ${MAKER}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
});

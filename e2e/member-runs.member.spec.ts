import type { Browser, BrowserContext, Page } from "@playwright/test";

import type { SeedConfig } from "./seed";

import { expect, test } from "@playwright/test";

import { awaitEnabled, clickWhenEnabled, gotoMember, signIn } from "./member";
import { seedConfig, seedMembers } from "./seed";

/**
 * The member's run list through a real browser: cookie → Worker gate → member
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
 * `CUT_TEAM` only and the mate is on both, so the mate's list holds a card
 * the maker's cannot show.
 */

const MAKER = "e2e.runs.maker@example.com";
const MATE = "e2e.runs.mate@example.com";
const CUT_TEAM = "E2E Runs Cut";
const PACK_TEAM = "E2E Runs Pack";
const RING_TAG = "e2e-runs-ring";
const BOX_TAG = "e2e-runs-box";
/** Routed to `CUT_TEAM`, so both members see it. */
const RING_ORDER = "#9401";
/** Routed to `PACK_TEAM`, so only the mate sees it. */
const BOX_ORDER = "#9402";
/** Routed Cut → Polish across the two teams; seeded only where a test needs downstream work. */
const BAND_ORDER = "#9403";
const BAND_TAG = "e2e-runs-band";
/** A run's row names the step and nothing else: progress is the work page's. */
const CUT_STEP = "Cut";
/**
 * The work page's in-progress line. The badge beside the step name states
 * the state, so the line under it is team, actor and when, with no "In
 * progress" in it. A run's row says `In progress · <who>` instead.
 */
const STARTED = `${CUT_TEAM} · ${MAKER} · since`;
/** The same line for a finished step: the `Done` badge carries the verb. */
const FINISHED = `${CUT_TEAM} · ${MAKER}`;
/**
 * A row's line two where the reader holds the step themselves: where it
 * is in the run, not "In progress · you", which would be true of every row
 * under a pressed Mine. The ring workflow has one step, and the maker is on
 * one team, so no team name follows it either.
 */
const MINE_STATE = "Step 1 of 1";
/** Per-tab empty text (`TAB_EMPTY` in `src/lib/runTabs.ts`). */
const EMPTY_MINE = "Nothing in hand.";
const EMPTY_TEAMMATES = "Nobody else has work.";
const EMPTY_DONE = "Nothing finished in the last day.";
/**
 * Every seeded order is `#94xx`, which is how a row is counted rather than
 * read. The row itself is the link, so what it announces is its
 * `accessibilityLabel` rather than the order number printed inside it.
 */
const ORDER_LINK = /^Open #94\d\d$/u;
/**
 * Filler Cut orders, numbered clear of the three named ones. Twenty-five and
 * not twenty-four: the ring order is a Cut order too, so the mate's Up next
 * comes to twenty-seven and the maker's to twenty-six — both over
 * `Domain.RUN_PAGE` (25), and the two counts differ, so an assertion cannot
 * pass by reading the wrong page.
 */
const BULK_COUNT = 25;
const BULK_FIRST = 9410;

/** Tab labels, as `TAB_LABEL` writes them on the strip. */
const MINE = "Mine";
const UP_NEXT = "Up next";
const TEAMMATES = "Teammates";
const BLOCKED = "Blocked";
const DONE_TODAY = "Done today";

/**
 * One workflow per team and one order for each, so every assertion about who
 * sees what is a fact about the seeded team rather than about ordering. Both
 * workflows are fully assigned, which turns them on, and both orders are
 * seeded fresh (`pending`, nothing started), so each carries exactly one ready
 * step.
 */
const seedRuns = (
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
     * Enough more Cut orders to cross `Domain.RUN_PAGE`, which is the only
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
        name: "E2E Runs Ring",
        tag: RING_TAG,
        steps: [{ name: "Cut", team: CUT_TEAM }],
      },
      {
        name: "E2E Runs Box",
        tag: BOX_TAG,
        steps: [{ name: "Pack", team: PACK_TEAM }],
      },
      ...(options.withBand === true
        ? [
            {
              name: "E2E Runs Band",
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
 * Land a signed-in member on their run list. `tab` goes in the URL rather than
 * through a click, because the tab is a search param and most tests here are
 * about the rows rather than about getting to them; the default landing tab
 * is Mine, which is empty until somebody starts something.
 */
const openRuns = async (
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
  /* The section, not an `s-page` heading: the page has none, and the section's
     accessibility label is what names the landmark now. */
  await expect(
    page.locator('s-section[accessibilityLabel="Workflows"]'),
  ).toBeVisible();
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

/** The landing tab, `Domain.DEFAULT_RUN_TAB`, which the URL never spells out. */
const DEFAULT_TAB = "mine";

/**
 * Switch tabs and wait for the switch to land. The wait is on the URL rather
 * than on `aria-pressed`, because `getByRole` may resolve to either the
 * `s-button` host or the native button inside its shadow root and only the
 * host carries the attribute — the search param is the same fact, on the
 * side that cannot be ambiguous.
 *
 * The default tab is the absence of the key: `stripSearchParams` keeps it out
 * of the URL so the bare `/shop/$shop` stays the canonical way home
 * (`MemberSearch` in `src/routes/shop.$shop.tsx`).
 */
const selectTab = async (
  page: Page,
  name: string,
  label: string,
): Promise<void> => {
  await tab(page, label).click();
  await expect(page).toHaveURL(
    (url) => (url.searchParams.get("tab") ?? DEFAULT_TAB) === name,
  );
};

/**
 * The bar's mark: the member area's one standing way home. The link's
 * accessible name is the shop domain inside it, so it is found by its class
 * (`MemberBar.tsx`).
 */
const homeLink = (page: Page) => page.locator("a.member-bar-home");

/** The `team` the address bar is carrying, or `null`. */
const teamParam = (page: Page) => new URL(page.url()).searchParams.get("team");

/**
 * The rows a *cold* request paints, counted in the HTML the server sent rather
 * than in the DOM the socket has since had its hands on. `page.request` shares
 * the context's cookies, so this is the SSR paint a member gets when they open
 * the URL fresh — which is the whole claim these navigation tests make.
 */
const serverRows = async (page: Page, path: string): Promise<number> => {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  return html.match(/Open #94\d\d/gu)?.length ?? 0;
};

/**
 * A row's own link to the work page. The whole row is one `s-clickable href`,
 * so it announces itself by its label rather than by the order number printed
 * inside it.
 */
const rowLink = (page: Page, orderName: string) =>
  page.getByRole("link", { name: `Open ${orderName}`, exact: true });

/**
 * The row for one order: the innermost `s-box` holding that order's
 * link. `.last()`, not `.first()`: the tab's list container is an `s-box`
 * around every row and so matches the same filter, and it is the ancestor, so
 * document order puts it first.
 */
const card = (page: Page, orderName: string) =>
  page
    .locator("s-box")
    .filter({ has: rowLink(page, orderName) })
    .last();

/**
 * A row's kebab: every verb a row offers is inside the menu it opens, which
 * is the shape Polaris's own resource list gives a row. It carries the gate
 * the bare buttons used to — `useMemberRunActions` holds `pending` true until
 * the socket identifies — so `clickWhenEnabled` on it is still the wait for
 * the handshake and a broken gate still fails on the control rather than on
 * the outcome.
 */
const rowMenu = (page: Page, orderName: string) =>
  card(page, orderName).getByRole("button", {
    name: `Actions for ${orderName}`,
  });

/** Open a row's menu and take the named verb. */
const rowAction = async (
  page: Page,
  orderName: string,
  action: string,
): Promise<void> => {
  await clickWhenEnabled(rowMenu(page, orderName));
  await card(page, orderName)
    .getByRole("menuitem", { name: action, exact: true })
    .click();
};

test.describe.configure({ mode: "serial" });

/**
 * Seeded destructively first (no `keepIdentities`) so both members sign in as
 * first-time users against a fixture with no leftovers, exactly as a
 * standalone member spec would.
 */
test.beforeAll(async ({ browser }) => {
  const config = seedConfig();
  await seedRuns(config, {
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
    // A one-shop member lands on the run list itself, not the picker.
    await expect(
      page.locator('s-section[accessibilityLabel="Workflows"]'),
    ).toBeVisible();
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
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, makerState, "upNext");

  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(page.getByText(CUT_STEP, { exact: true })).toBeVisible();
  await markDocument(page);

  await rowAction(page, RING_ORDER, "Start");
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
  /* The row says where it is in the run and not that it is the reader's own,
     which the pressed tab already said; what changed is the verb in its menu,
     where Start has given way to Done. */
  await expect(page.getByText(MINE_STATE)).toBeVisible();
  await clickWhenEnabled(rowMenu(page, RING_ORDER));
  const ring = card(page, RING_ORDER);
  await expect(
    ring.getByRole("menuitem", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await ring.getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeHidden();
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();
  await expectSameDocument(page);
});

/**
 * The row has one link and one menu, and each does only its own job. Both
 * halves matter: the row body opens the work page, while the kebab and the
 * item it opens write without moving the reader — a row that navigated under
 * a thumb reaching for Done would cost the member their place in the list on
 * every piece they finish.
 */
test("a run's row opens the work page and its menu does not", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER], keepIdentities: true });
  const page = await openRuns(browser, config, makerState, "upNext");
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();

  /* The row body, not the order number: the number is plain text now and the
     whole row is the target. */
  await rowLink(page, RING_ORDER).click();
  await expect(page.locator(`s-page[heading="${RING_ORDER}"]`)).toBeVisible();

  await page.goBack();
  /* Wait for the run list itself, not for the order number: until Back lands,
     the order number on the work page's own heading matches too. */
  await expect(
    page.locator('s-section[accessibilityLabel="Workflows"]'),
  ).toBeVisible();
  await expect(card(page, RING_ORDER)).toBeVisible();
  const runsUrl = page.url();
  await rowAction(page, RING_ORDER, "Start");
  /* The write landed and the reader stayed put: the strip renumbered and the
     address bar still says the run list. */
  await expect(page.getByRole("button", { name: `${MINE} · 1` })).toBeVisible();
  await expect(page).toHaveURL(runsUrl);
});

/**
 * Two members, two browsers, one team's work. The mate observes, the maker
 * acts, and the mate's page is never touched after it loads — so every change
 * it shows arrived as a `publish` over its own socket.
 *
 * The observer's page is opened first: its `subscribeRuns` has to be
 * registered before the write it is meant to hear about, and the maker's own
 * page load and socket handshake are the margin.
 *
 * The cross-team half rides along: the box order is routed to a team the maker
 * is not on, so it must be absent from the maker's list while sitting in
 * plain sight on the mate's, and it must still be there after the ring work is
 * finished.
 */
test("a completed step lands on another member's run list without a reload", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });

  const mate = await openRuns(browser, config, mateState, "upNext");
  await expect(mate.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(mate.getByText(BOX_ORDER, { exact: true })).toBeVisible();
  await awaitEnabled(rowMenu(mate, RING_ORDER));
  await markDocument(mate);

  const maker = await openRuns(browser, config, makerState, "upNext");
  await expect(maker.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(maker.getByText(BOX_ORDER, { exact: true })).toBeHidden();
  await expect(maker.getByText("Pack")).toBeHidden();

  await rowAction(maker, RING_ORDER, "Start");
  /* The push reaches the mate whatever tab they are on: the strip renumbers
     under them while they are still reading Up next. */
  await expect(
    mate.getByRole("button", { name: `${TEAMMATES} · 1` }),
  ).toBeVisible();
  await expect(
    mate.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();

  /* The mate's row says who has it; the start time is on the work page the
     row links to, which is one tap away and not on the list. */
  await selectTab(mate, "inProgress", TEAMMATES);
  await expect(mate.getByText(`In progress · ${MAKER}`)).toBeVisible();

  await selectTab(maker, "mine", MINE);
  await rowAction(maker, RING_ORDER, "Done");
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
 * Taking a member off a team while they are standing on the run list. The seed
 * ends by revoking the connections of the members it replaced, which is what
 * `app.members` and `app.teams.$teamId` do after their own roster writes, so
 * this is the same close a merchant edit produces: code 4401, `/shop/$shop`
 * invalidates the router, and the loader re-runs against the new membership.
 *
 * The socket must be up before the re-seed or there is nothing to revoke and
 * the test would pass for the wrong reason — hence `awaitEnabled` first, which
 * is exactly the identified gate.
 *
 * The member keeps their shop membership here, so the answer is the list's
 * "not on a team yet" state rather than not-found; `member-area.member.spec.ts`
 * owns the removed-from-the-shop case.
 */
test("removing a member from a team empties their open run list", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, makerState, "upNext");
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await awaitEnabled(rowMenu(page, RING_ORDER));
  await markDocument(page);

  await seedRuns(config, { cutMembers: [MATE], keepIdentities: true });

  await expect(page.getByText(RING_ORDER, { exact: true })).toBeHidden();
  await expect(page.getByText("You’re not on a team yet.")).toBeVisible();
  await expectSameDocument(page);
});

/**
 * The strip, driven by the two real actors rather than the seed: untouched
 * work is counted under "Up next"; the maker's own Start moves the card to
 * "Mine" on their page and to "Teammates" — naming them — on the mate's,
 * which arrives by push. The counts on the strip are the shape of the day,
 * and every tab stays on it whatever its count, so nothing reflows when a
 * number crosses zero.
 */
test("a started card moves to Mine for the starter and Teammates for a teammate", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const mate = await openRuns(browser, config, mateState, "upNext");
  await expect(
    mate.getByRole("button", { name: `${UP_NEXT} · 2` }),
  ).toBeVisible();
  await awaitEnabled(rowMenu(mate, RING_ORDER));

  const maker = await openRuns(browser, config, makerState, "upNext");
  await expect(
    maker.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();
  await rowAction(maker, RING_ORDER, "Start");
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
    mate.getByRole("button", { name: `${TEAMMATES} · 1` }),
  ).toBeVisible();
  await expect(
    mate.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();
  await selectTab(mate, "inProgress", TEAMMATES);
  await expect(mate.getByText(`In progress · ${MAKER}`)).toBeVisible();

  /* The other side of that fact, on the starter's own page: the only started
     step is theirs, so their Teammates tab is empty and says so in three
     words rather than restating whose teams they are. */
  await selectTab(maker, "inProgress", TEAMMATES);
  await expect(maker.getByText(EMPTY_TEAMMATES)).toBeVisible();
});

/**
 * The one place in the member area where the number on the strip is not the
 * number of rows under it. Up next is cut to `Domain.RUN_PAGE` (25) and the
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
  await seedRuns(config, {
    cutMembers: [MAKER, MATE],
    keepIdentities: true,
    withBulk: true,
  });
  const page = await openRuns(browser, config, mateState, "upNext");

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
     names the same 26 before and after it is chosen. The button beside them
     carries no count at all: the tab counts are team-narrowed and this one is
     not, so on one row they would be counting different things. */
  await page.getByRole("button", { name: "All teams", exact: true }).click();
  await page.getByRole("menuitem", { name: `${CUT_TEAM} · 26` }).click();
  await expect(
    page.getByRole("button", { name: CUT_TEAM, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 26` }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(25);
  await expect(
    page.getByRole("button", { name: "Show 1 more of 1" }),
  ).toBeVisible();
});

/**
 * Five tabs are wider than a phone. They are a grid rather than a scroller:
 * `auto-fit` breaks the row on the container's width alone, so a count going
 * from 9 to 10 changes a label and never the layout, and a row that never
 * overflows has no scrollbar to appear over the tabs — which hiding one was
 * only ever a patch for.
 *
 * The team filter is not on the strip. A team name is merchant-typed and
 * unbounded, so there it would decide how many tabs a screen has room for; it
 * sits in the member bar instead, beside the shop, rather than taking a line
 * of its own above the fold. The mate drives this because the filter only
 * renders for a member on more than one team.
 */
test("the tabs are a grid that never scrolls and the team filter sits in the member bar", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, mateState, "upNext");
  await page.setViewportSize({ width: 375, height: 800 });

  const strip = page.locator(".run-strip-tabs");
  const metrics = await strip.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      overflows: element.scrollWidth > element.clientWidth,
      holdsTeamFilter:
        element.querySelector('[commandfor="run-team-menu"]') !== null,
    };
  });
  expect(metrics).toEqual({
    display: "grid",
    overflows: false,
    holdsTeamFilter: false,
  });

  await expect(
    page.locator('.member-bar [commandfor="run-team-menu"]'),
  ).toBeVisible();

  /* One team, no filter: the bar holds the shop and the session and nothing
     else, rather than a control with nothing to choose between. */
  const maker = await openRuns(browser, config, makerState, "upNext");
  await expect(
    maker.getByRole("button", { name: "All teams", exact: true }),
  ).toHaveCount(0);
});

/**
 * The team name is on a row for the one reader it tells something: a member
 * on several teams looking at all of them, for whom it is which bench to walk
 * to. Narrow to a team and every row of the list is that team, so the word is
 * printed on each and discriminates nothing; a member on one team never had a
 * second team for it to sort against. The same two facts decide whether the
 * filter exists at all.
 */
test("a row names its team only for a member on several teams looking at all of them", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const mate = await openRuns(browser, config, mateState, "upNext");
  await expect(card(mate, RING_ORDER).getByText(CUT_TEAM)).toHaveCount(1);

  await mate.getByRole("button", { name: "All teams", exact: true }).click();
  await mate.getByRole("menuitem", { name: `${CUT_TEAM} · 1` }).click();
  await expect(
    mate.getByRole("button", { name: CUT_TEAM, exact: true }),
  ).toBeVisible();
  await expect(card(mate, RING_ORDER).getByText(CUT_TEAM)).toHaveCount(0);

  const maker = await openRuns(browser, config, makerState, "upNext");
  await expect(card(maker, RING_ORDER).getByText(CUT_TEAM)).toHaveCount(0);
});

/**
 * The tab is a search param, so it survives a paste into the address bar and
 * it is what the back button walks out of. `replace: true` on the switch is
 * the second half: a member who glanced at three tabs presses Back once and
 * is out of the run list, not walked back through them.
 */
test("the tab is in the URL and switching tabs replaces it", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, makerState);
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
 * The team is the member's context, not the screen's: a bench narrows to one
 * team once and everything they do afterwards is that team's. It is in the
 * URL for the same two reasons the tab is — a cold load paints it, and Back
 * walks out of the list rather than through the filters — and `replace: true`
 * is what keeps one glance at one team from costing one press of Back.
 */
test("the team is in the URL and switching teams replaces it", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, mateState);
  await gotoMember(page, `/shop/${config.shop}?tab=upNext`);

  await page.getByRole("button", { name: "All teams", exact: true }).click();
  await page.getByRole("menuitem", { name: `${CUT_TEAM} · 1` }).click();
  await expect(page).toHaveURL(/[?&]team=/u);
  const team = teamParam(page);
  expect(team).not.toBeNull();

  /* One press, out: the team switch replaced the entry the tab switch made,
     so Back is the way out of the list rather than back through the filter. */
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/shop/${config.shop}$`, "u"));
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();

  /* Cold, with the team in the URL: the loader reads it, so the narrowed list
     is what the server paints — one Cut row, not two rows corrected after the
     socket answers. */
  const narrowed = `/shop/${config.shop}?tab=upNext&team=${String(team)}`;
  expect(await serverRows(page, narrowed)).toBe(1);
  await gotoMember(page, narrowed);
  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 1` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: CUT_TEAM, exact: true }),
  ).toBeVisible();
  await expect(rowLink(page, BOX_ORDER)).toHaveCount(0);
  /* Narrowed, every row is that team, so no row names it. */
  await expect(card(page, RING_ORDER).getByText(CUT_TEAM)).toHaveCount(0);
});

/**
 * Depth is context too, and it is the one that costs the most to lose: a
 * member who pressed Show more and opened a row from the second page comes
 * back to page one and has to find their place by scrolling. So `limit` rides
 * in the URL and the loader reads it, and the deepened list is what a cold
 * request paints.
 *
 * **A depth out of range clamps rather than fails** (`Domain.clampRunLimit`):
 * the address bar is text a member can edit, and the router's error boundary
 * over a shop's work is a worse answer than a list.
 */
test("depth is in the URL and a return lands on the same depth", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, {
    cutMembers: [MAKER, MATE],
    keepIdentities: true,
    withBulk: true,
  });
  const page = await openRuns(browser, config, mateState, "upNext");

  await page.getByRole("button", { name: "Show 2 more of 2" }).click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/u);
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(27);

  /* Cold at that depth: all 27 in the SSR paint, and no button offering rows
     that are already there. */
  const deep = `/shop/${config.shop}?tab=upNext&limit=50`;
  expect(await serverRows(page, deep)).toBe(27);
  await gotoMember(page, deep);
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(27);
  await expect(
    page.getByRole("button", { name: /^Show \d+ more/u }),
  ).toHaveCount(0);

  /* Below the floor and far above the ceiling: both are lists, neither is an
     error page. `limit=0` clamps to one row, which is the sharp end of the
     rule — the tab still counts 27 and offers the rest. */
  await gotoMember(page, `/shop/${config.shop}?tab=upNext&limit=0`);
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Show 25 more of 26" }),
  ).toBeVisible();

  await gotoMember(page, `/shop/${config.shop}?tab=upNext&limit=1000`);
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(27);
  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 27` }),
  ).toBeVisible();
});

/**
 * The two ways home are one screen. The bar's mark is the member area's only
 * standing link back, and the browser's Back is the other way; both have to
 * land on the list the member left, filters and depth included, or the filter
 * is a thing you set once per drill-down.
 *
 * Nothing in `MemberBar` or in the row's link names a search key: the layout's
 * middleware puts the context on every link built under `/shop/$shop`
 * (`MemberSearch` in `src/routes/shop.$shop.tsx`), which is why the work page's
 * URL carries filters it does not itself read.
 */
test("the bar's mark returns to the screen the member left", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, mateState, "upNext");
  await page.getByRole("button", { name: "All teams", exact: true }).click();
  await page.getByRole("menuitem", { name: `${CUT_TEAM} · 1` }).click();
  const team = teamParam(page);

  await rowLink(page, RING_ORDER).click();
  await expect(page.locator(`s-page[heading="${RING_ORDER}"]`)).toBeVisible();
  await expect(page).toHaveURL(/[?&]tab=upNext(?:&|$)/u);
  await expect(page).toHaveURL(
    new RegExp(`[?&]team=${String(team)}(&|$)`, "u"),
  );

  const expectLeftScreen = async (): Promise<void> => {
    await expect(
      page.locator('s-section[accessibilityLabel="Workflows"]'),
    ).toBeVisible();
    await expect(page).toHaveURL(/[?&]tab=upNext(?:&|$)/u);
    expect(teamParam(page)).toBe(team);
    await expect(
      page.getByRole("button", { name: `${UP_NEXT} · 1` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: CUT_TEAM, exact: true }),
    ).toBeVisible();
  };

  await homeLink(page).click();
  await expectLeftScreen();

  await rowLink(page, RING_ORDER).click();
  await expect(page.locator(`s-page[heading="${RING_ORDER}"]`)).toBeVisible();
  await page.goBack();
  await expectLeftScreen();
});

/**
 * A `team` in the URL is a shape, not a membership: the schema cannot know the
 * roster, and a member taken off a team keeps the id in every link they had
 * open. The screen resolves it against the teams `requireMember` returned and
 * reads an id that is not among them as All teams — the button already says
 * so, and the alternative is an empty list for a reason nothing on screen
 * states.
 */
test("a team the member is no longer on reads as all teams", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, mateState);
  await gotoMember(
    page,
    `/shop/${config.shop}?tab=upNext&team=not-a-team-of-theirs`,
  );

  await expect(
    page.getByRole("button", { name: "All teams", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 2` }),
  ).toBeVisible();
  await expect(rowLink(page, RING_ORDER)).toBeVisible();
  await expect(rowLink(page, BOX_ORDER)).toBeVisible();
});

/**
 * The three keys ride in a URL a member can edit, so none of them can fail:
 * a `tab` the schema cannot read is the default tab, a `limit` that is not a
 * number is a page, and an empty `team` is every team (`MemberSearch` in
 * `src/routes/shop.$shop.tsx`). The schema guards the whole member area now,
 * work page included, so the alternative to a default is the router's error
 * boundary over a shop's work because somebody mistyped one character.
 */
test("a value the search schema cannot read falls back to the default", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, {
    cutMembers: [MAKER, MATE],
    keepIdentities: true,
    withBulk: true,
  });
  const page = await openRuns(browser, config, mateState);

  await gotoMember(page, `/shop/${config.shop}?tab=bogus`);
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();

  await gotoMember(page, `/shop/${config.shop}?tab=upNext&limit=abc`);
  await expect(page.getByRole("link", { name: ORDER_LINK })).toHaveCount(25);

  await gotoMember(page, `/shop/${config.shop}?tab=upNext&team=`);
  await expect(
    page.getByRole("button", { name: "All teams", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `${UP_NEXT} · 27` }),
  ).toBeVisible();
});

/**
 * Done today and Undo. The finished step leaves the list for the Done tab;
 * Undo puts it back, and because Undo keeps the original starter the card
 * returns to "Mine", not "Up next".
 */
test("undo puts a finished step back in progress", async ({ browser }) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openRuns(browser, config, makerState, "upNext");
  await expect(
    page.getByRole("button", { name: `${DONE_TODAY} · 0` }),
  ).toBeVisible();

  await rowAction(page, RING_ORDER, "Start");
  await selectTab(page, "mine", MINE);
  await rowAction(page, RING_ORDER, "Done");
  await expect(page.getByText(EMPTY_MINE)).toBeVisible();
  await expect(
    page.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
  /* Unopened, the tab is a count and nothing else: its rows are a different
     read, so the Undo below is only reachable once the tab is chosen. The
     entry says "by you" rather than the reader's own address, which on this
     tier is the longest and least informative text on the page. */
  await selectTab(page, "done", DONE_TODAY);
  await expect(page.getByText("by you at")).toBeVisible();

  await rowAction(page, RING_ORDER, "Undo");
  await expect(page.getByText(EMPTY_DONE)).toBeVisible();
  await expect(page.getByRole("button", { name: `${MINE} · 1` })).toBeVisible();
  /* Back under Mine, where a row says where it is in the run rather than that
     it is the reader's own; a row that arrives after the first paint stays
     collapsed. */
  await selectTab(page, "mine", MINE);
  await expect(page.getByText(MINE_STATE)).toBeVisible();
});

/**
 * A `done` run is only its last step's Done, and the work page must offer
 * Undo there just as the run list's Done tier does (`Domain.stepActions`: Undo's
 * gate is `runIsLive`, not `runIsOpen`). The ring order has one step, so Done
 * on it finishes the run, and the page it links to is the page under test.
 */
test("a done run's work page offers Undo on its last step", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER], keepIdentities: true });
  const page = await openRuns(browser, config, makerState, "upNext");
  await rowLink(page, RING_ORDER).click();
  await expect(page.locator(`s-page[heading="${RING_ORDER}"]`)).toBeVisible();

  await clickWhenEnabled(
    page.getByRole("button", { name: "Done", exact: true }),
  );
  await expect(page.getByText(FINISHED)).toBeVisible();
  /* The run's own badge says it is finished; the step still offers Undo. */
  await expect(page.locator('s-badge:has-text("Done")').first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);

  await clickWhenEnabled(page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText(`Reopened by ${MAKER}`)).toBeVisible();
  await expect(page.getByText(STARTED)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

/**
 * Once downstream has started the fix is a conversation, and **neither member
 * screen says so in words**: the mate (on the Polish team) starts the next
 * stage, the maker's Done today entry loses its menu, and the work page the
 * row still links to simply stops offering Undo.
 *
 * The rule used to be a disabled Undo beside a clause naming the blocker, so
 * that the control read as a refusal rather than as one that was never
 * undoable. That holds while refusal is the exception, and in a running shop
 * it is the rule: a finished step is nearly always downstream of something
 * already started. The run list dropped both on that argument, deferring the
 * explanation to this page — and this page is where the explanation is least
 * needed, because it lists the whole run: the step standing in the way is on
 * screen, directly below, wearing an `In progress` badge. A sentence naming
 * it is the page arguing with itself.
 *
 * The wording survives on the merchant's order page alone, inline in
 * `app.orders.$orderId.tsx`, because that screen can reopen the blocker and
 * so has an instruction to give (`e2e/orders.spec.ts`).
 */
test("a blocked undo offers nothing and explains nothing, on the row or the work page", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, {
    cutMembers: [MAKER],
    keepIdentities: true,
    withBand: true,
  });
  const maker = await openRuns(browser, config, makerState, "upNext");
  /* The row carries one menu, whose verb is Start while nobody has the step
     and Done once the maker does, so finishing from the list takes no
     detour. */
  await rowAction(maker, BAND_ORDER, "Start");
  await selectTab(maker, "mine", MINE);
  await rowAction(maker, BAND_ORDER, "Done");
  await expect(
    maker.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
  await selectTab(maker, "done", DONE_TODAY);
  await awaitEnabled(rowMenu(maker, BAND_ORDER));

  const mate = await openRuns(browser, config, mateState, "upNext");
  await rowAction(mate, BAND_ORDER, "Start");

  await expect(rowMenu(maker, BAND_ORDER)).toHaveCount(0);
  await rowLink(maker, BAND_ORDER).click();
  await expect(maker.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();
  /* The blocker itself is the explanation: Polish is on the page, under the
     step that cannot be undone, with the badge that says why. */
  await expect(maker.getByText(`${PACK_TEAM} · ${MATE} · since`)).toBeVisible();
  await expect(maker.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(maker.getByText("Can’t undo")).toHaveCount(0);
});

/**
 * Two shapes the work page's step card holds to, neither of which any other
 * assertion here would catch.
 *
 * **The badge states the step's state and the line under it never repeats
 * the word.** A `Ready` badge over a line reading "Ready" printed the same
 * fact twice, a stride apart, and left the team crowded onto the header line
 * beside the step name — "Cut E2E Runs Cut", two unbounded merchant-authored
 * names with only a weight between them, which reads as one noun phrase. The
 * team leads the subdued line instead and the header holds one name.
 *
 * **The note editor takes the card's button row with it.** Save note is a
 * primary; leaving Done mounted beside it put two primaries in one card and
 * asked the reader which one commits the typing. It is also what makes the
 * field's visible label load-bearing — the `Add note` button that named it is
 * one of the buttons the editor just replaced.
 */
test("a step card says its state once and its note editor replaces the card's buttons", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER], keepIdentities: true });
  const page = await openRuns(browser, config, makerState, "upNext");
  await rowLink(page, RING_ORDER).click();
  await expect(page.locator(`s-page[heading="${RING_ORDER}"]`)).toBeVisible();

  /* The header line is the step alone; the team is the line under it, and
     the badge's word appears nowhere but the badge. */
  await expect(page.getByText(`1 · ${CUT_STEP}`)).toBeVisible();
  await expect(page.locator('s-badge:has-text("Ready")')).toBeVisible();
  /* Exact, so it is the line holding the team and nothing else: a `Ready`
     step's line is the team name alone. */
  await expect(page.getByText(CUT_TEAM, { exact: true })).toBeVisible();

  /* No breadcrumb: `MemberBar`'s mark above the heading is the link back, and
     it is the only one — `s-page` holds none of its own. */
  await expect(homeLink(page)).toHaveCount(1);
  await expect(
    page.locator("s-page").getByRole("link", { name: config.shop }),
  ).toHaveCount(0);

  await clickWhenEnabled(page.getByRole("button", { name: "Add note" }));
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add note" })).toHaveCount(0);
  /* The label is the only thing naming the field now, so it is visible
     rather than `exclusive` and the placeholder that restated the button is
     gone. */
  await expect(page.getByLabel("Note")).toBeVisible();
  await expect(page.getByPlaceholder("Note about this step")).toHaveCount(0);

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});

/**
 * **An open editor takes its container's buttons with it** (`editor` in
 * `src/routes/shop.$shop.work.$runId.tsx`). The step card above proves the
 * note half; this is the other two containers.
 *
 * The banner's Unblock used to stay mounted beside Save reason, which put two
 * commits in one box a stride apart and asked the reader which one takes the
 * typing. Lifting a hold mid-edit now costs Cancel then Unblock, the same two
 * presses a step's Undo costs while its note editor is open.
 *
 * The second half is the reach, which stops at the container: the Block
 * editor belongs to the page header, so it takes the page's Block action and
 * leaves every step card below it working.
 */
test("an open editor takes its container's buttons with it", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, { cutMembers: [MAKER], keepIdentities: true });
  const page = await openRuns(browser, config, makerState, "upNext");
  await rowLink(page, RING_ORDER).click();
  await expect(page.locator(`s-page[heading="${RING_ORDER}"]`)).toBeVisible();

  await clickWhenEnabled(
    page.getByRole("button", { name: "Block", exact: true }),
  );
  await expect(page.getByLabel("Reason")).toBeVisible();
  /* The step card is a different container, so it kept its whole row. */
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add note" })).toBeVisible();

  await page.getByLabel("Reason").fill("Crest file missing");
  await clickWhenEnabled(
    page.getByRole("button", { name: "Block", exact: true }),
  );
  await expect(page.locator('s-banner[heading="Blocked"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Unblock" })).toBeVisible();

  /* The banner is the reason editor's container, so Unblock goes with Edit
     reason and the hold offers Save reason and Cancel and nothing else. */
  await clickWhenEnabled(page.getByRole("button", { name: "Edit reason" }));
  await expect(page.getByRole("button", { name: "Unblock" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit reason" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Save reason" })).toBeVisible();

  /* Cancel hands the banner its buttons back and the hold never moved. */
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Unblock" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit reason" })).toBeVisible();
  await expect(page.getByText("Crest file missing")).toBeVisible();
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
  await seedRuns(config, {
    cutMembers: [MAKER],
    keepIdentities: true,
    withBand: true,
  });
  const page = await openRuns(browser, config, makerState, "upNext");
  await rowLink(page, BAND_ORDER).click();
  await expect(page.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();
  await expect(page.getByText("E2E Cuff ×1")).toBeVisible();
  await expect(
    page.getByText(`${PACK_TEAM} · waiting on step 1`),
  ).toBeVisible();

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
  await clickWhenEnabled(page.getByRole("button", { name: "Block" }));
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

  /* The same hold as the run list reads it: the card carries its one action
     inside the banner and offers no step buttons at all, which is the whole
     of "blocked means stop". */
  await homeLink(page).click();
  await expect(
    page.locator('s-section[accessibilityLabel="Workflows"]'),
  ).toBeVisible();
  /* The mark lands back on Up next, the tab this test came from; the held run
     is on Blocked, which the strip counts from wherever the reader is. */
  await expect(page).toHaveURL(/[?&]tab=upNext(?:&|$)/u);
  await selectTab(page, "attention", BLOCKED);
  const blocked = card(page, BAND_ORDER);
  /* No badge on the row either: "Blocked" there would repeat the pressed tab,
     the verb in the menu, and the reason on line two. The flags reconcile
     sets keep their badges, because each names a different thing Shopify
     did. */
  await expect(blocked.getByText("Blocked")).toHaveCount(0);
  await clickWhenEnabled(rowMenu(page, BAND_ORDER));
  await expect(
    blocked.getByRole("menuitem", { name: "Unblock", exact: true }),
  ).toBeVisible();
  await expect(
    blocked.getByRole("menuitem", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await expect(
    blocked.getByRole("menuitem", { name: "Done", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await rowLink(page, BAND_ORDER).click();
  await expect(page.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Unblock" }));
  await clickWhenEnabled(
    page.getByRole("button", { name: "Done", exact: true }),
  );
  await expect(page.getByText(FINISHED)).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  await homeLink(page).click();
  await expect(
    page.locator('s-section[accessibilityLabel="Workflows"]'),
  ).toBeVisible();
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
test("a merchant's completion reads as Merchant on the run list and the work page", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedRuns(config, {
    cutMembers: [MAKER],
    keepIdentities: true,
    withBand: true,
    bandDoneByMerchant: true,
  });
  const page = await openRuns(browser, config, makerState);

  await expect(
    page.getByRole("button", { name: `${DONE_TODAY} · 1` }),
  ).toBeVisible();
  await selectTab(page, "done", DONE_TODAY);
  await expect(page.getByText("by Merchant at")).toBeVisible();

  await rowLink(page, BAND_ORDER).click();
  await expect(page.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();
  await expect(page.getByText(`${CUT_TEAM} · Merchant`)).toBeVisible();

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

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
 * Sign-ins are the scarce resource. `LOGIN_LIMITER` allows 5 magic-link sends
 * per 60s across every local request (`wrangler.jsonc`), and
 * `member-area.member.spec.ts` already spends 4 in the same project run. So
 * this file signs in exactly twice — once per member, in `beforeAll` — and
 * every test re-creates its contexts from the storage state that produced.
 * That is what `keepIdentities` on the seed is for: a seed normally drops the
 * better-auth `User` of every email it touches, which would sign both members
 * out on the first re-seed and put four more sends on the budget. With it on,
 * each test still gets a pristine fixture (members, teams, workflows and
 * orders are replaced wholesale) while the two sessions survive. `signIn`
 * waits the limiter out if the previous file's sends are still inside the
 * window.
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
const CUT_STEP = "Cut · step 1 of 1";
const STARTED = "In progress since";
const EMPTY = "Nothing to do right now.";

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

/** Land a signed-in member on their queue with the socket identified. */
const openQueue = async (
  browser: Browser,
  config: SeedConfig,
  storageState: StorageState,
): Promise<Page> => {
  const context = await memberContext(browser, config, storageState);
  contexts.push(context);
  const page = await context.newPage();
  await gotoMember(page, `/shop/${config.shop}`);
  await expect(page.locator('s-page[heading="Your work"]')).toBeVisible();
  return page;
};

/** The queue card for one order: the `s-box` whose heading link is the order name. */
const card = (page: Page, orderName: string) =>
  page
    .locator("s-box")
    .filter({ has: page.getByRole("link", { name: orderName, exact: true }) })
    .first();

test.describe.configure({ mode: "serial" });

/**
 * The only two sends this file makes. Seeded destructively first (no
 * `keepIdentities`) so both members sign in as first-time users against a
 * fixture with no leftovers, exactly as a standalone member spec would.
 */
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
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
    await expect(page.locator('s-page[heading="Your work"]')).toBeVisible();
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
  const page = await openQueue(browser, config, makerState);

  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(page.getByText(CUT_STEP)).toBeVisible();
  await expect(page.getByText(STARTED)).toBeHidden();
  await markDocument(page);

  await clickWhenEnabled(page.getByRole("button", { name: "Start" }));
  await expect(page.getByText(STARTED)).toBeVisible();
  /* Start is gone because the step is started, which is the page's own state
     following the object's — proof the answer was applied, not just accepted. */
  await expect(page.getByRole("button", { name: "Start" })).toBeHidden();

  await clickWhenEnabled(page.getByRole("button", { name: "Done" }));
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeHidden();
  await expect(page.getByText(EMPTY)).toBeVisible();
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

  const mate = await openQueue(browser, config, mateState);
  await expect(mate.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(mate.getByText(BOX_ORDER, { exact: true })).toBeVisible();
  await awaitEnabled(mate.getByRole("button", { name: "Start" }).first());
  await markDocument(mate);

  const maker = await openQueue(browser, config, makerState);
  await expect(maker.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await expect(maker.getByText(BOX_ORDER, { exact: true })).toBeHidden();
  await expect(maker.getByText("Pack")).toBeHidden();

  await clickWhenEnabled(maker.getByRole("button", { name: "Start" }));
  await expect(mate.getByText(STARTED)).toBeVisible();

  await clickWhenEnabled(maker.getByRole("button", { name: "Done" }));
  await expect(mate.getByText(RING_ORDER, { exact: true })).toBeHidden();
  /* The mate's other team is untouched by the ring order's fan-out, so the
     refetch must not have emptied the page wholesale. */
  await expect(mate.getByText(BOX_ORDER, { exact: true })).toBeVisible();
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
  const page = await openQueue(browser, config, makerState);
  await expect(page.getByText(RING_ORDER, { exact: true })).toBeVisible();
  await awaitEnabled(page.getByRole("button", { name: "Start" }));
  await markDocument(page);

  await seedQueue(config, { cutMembers: [MATE], keepIdentities: true });

  await expect(page.getByText(RING_ORDER, { exact: true })).toBeHidden();
  await expect(page.getByText("You’re not on a team yet.")).toBeVisible();
  await expectSameDocument(page);
});

/**
 * The tiers, driven by the two real actors rather than the seed: untouched
 * work is "Up next"; the maker's own Start moves the card under "Mine" on
 * their page and under "In progress" — naming them — on the mate's, which
 * arrives by push. The counts in the headings are the shape of the day.
 */
test("a started card moves to Mine for the starter and In progress for a teammate", async ({
  browser,
}) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const mate = await openQueue(browser, config, mateState);
  await expect(mate.getByText("Up next · 2")).toBeVisible();
  await awaitEnabled(mate.getByRole("button", { name: "Start" }).first());

  const maker = await openQueue(browser, config, makerState);
  await expect(maker.getByText("Up next · 1")).toBeVisible();
  await clickWhenEnabled(maker.getByRole("button", { name: "Start" }));
  await expect(maker.getByText("Mine · 1")).toBeVisible();
  await expect(maker.getByText("Up next")).toBeHidden();
  await expect(card(maker, RING_ORDER).getByText("Mine")).toBeVisible();

  await expect(mate.getByText("In progress · 1")).toBeVisible();
  await expect(mate.getByText("Up next · 1")).toBeVisible();
  await expect(mate.getByText(`by ${MAKER}`)).toBeVisible();
});

/**
 * Done today and Undo. The finished step leaves the queue and appears under
 * the collapsed tier; Undo puts it back, and because Undo keeps the original
 * starter the card returns under "Mine", not "Up next".
 */
test("undo puts a finished step back in progress", async ({ browser }) => {
  const config = seedConfig();
  await seedQueue(config, { cutMembers: [MAKER, MATE], keepIdentities: true });
  const page = await openQueue(browser, config, makerState);
  await expect(page.getByText("Done today")).toBeHidden();

  await clickWhenEnabled(page.getByRole("button", { name: "Start" }));
  await clickWhenEnabled(page.getByRole("button", { name: "Done" }));
  await expect(page.getByText(EMPTY)).toBeVisible();
  await expect(page.getByText("Done today · 1")).toBeVisible();
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByText(`by ${MAKER} at`)).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText("Mine · 1")).toBeVisible();
  await expect(page.getByText(STARTED)).toBeVisible();
  await expect(page.getByText("Done today")).toBeHidden();
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
  const maker = await openQueue(browser, config, makerState);
  await clickWhenEnabled(
    card(maker, BAND_ORDER).getByRole("button", { name: "Done" }),
  );
  await expect(maker.getByText("Done today · 1")).toBeVisible();
  await maker.getByRole("button", { name: "Show" }).click();
  await expect(maker.getByRole("button", { name: "Undo" })).toBeVisible();

  const mate = await openQueue(browser, config, mateState);
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
  const page = await openQueue(browser, config, makerState);
  await page.getByRole("link", { name: BAND_ORDER, exact: true }).click();
  await expect(page.locator(`s-page[heading="${BAND_ORDER}"]`)).toBeVisible();
  await expect(page.getByText("E2E Cuff ×1")).toBeVisible();
  await expect(page.getByText("Waiting on step 1")).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Note" }));
  await page.getByLabel("Note").fill("Left edge is rough");
  await clickWhenEnabled(page.getByRole("button", { name: "Save note" }));
  await expect(page.getByText("Note: Left edge is rough")).toBeVisible();

  await page.getByLabel("Reason").fill("Waiting on stones");
  await clickWhenEnabled(page.getByRole("button", { name: "Block" }));
  await expect(page.getByText("Blocked: Waiting on stones")).toBeVisible();
  await expect(page.locator('s-section[heading="Blocked"]')).toBeVisible();

  await clickWhenEnabled(page.getByRole("button", { name: "Done" }));
  await expect(page.getByText(`Done by ${MAKER}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  await page.getByRole("link", { name: "‹ Your work" }).click();
  await expect(page.locator('s-page[heading="Your work"]')).toBeVisible();
  /* Cut is done and Polish is the packer's, so the run is no card of the
     maker's any more; what remains of it on this page is the Done entry. */
  await expect(page.getByText("Done today · 1")).toBeVisible();
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

  await expect(page.getByText("Done today · 1")).toBeVisible();
  await page.getByRole("button", { name: "Show" }).click();
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
  await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
});

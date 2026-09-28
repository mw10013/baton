import type {
  SeedLineItem,
  SeedMember,
  SeedOrder,
  SeedProgress,
  SeedTeam,
  SeedWorkflow,
  SeedWorkflowTask,
} from "./seed.ts";

/**
 * The canonical development fixture, posted by `pnpm seed` (`scripts/seed.ts`)
 * and importable by any Playwright spec that wants the whole shop rather than
 * a two-row world. Lives under `e2e/` so nothing in the worker bundle imports
 * test data.
 *
 * Deliberately NOT adopted by the existing specs: each seeds the exact shape
 * its assertions compute (a workflows list with N cards, a team with M members). Pinning
 * those to this shared fixture would make one edit here silently retune
 * unrelated assertions. `pnpm seed` and manual exploration are its consumers.
 *
 * The shop is a fictional made-to-order gift maker — engraved boards, leather
 * journals, signet rings, embroidered blankets — so every screen reads the way
 * a merchant's would: a worker at Engraving sees "Engrave · Signet ring ·
 * #1002", not "Task 2a · Workflow 03". Realism is what makes UX judgments
 * about the member area honest; the abstract names it replaced only proved
 * the plumbing.
 *
 * Logins, by role, so one browser profile per persona covers the product:
 *
 * - `lead@m.com` is on every team: one login that sees every list. It is
 *   fixture data, not `ADMIN_EMAILS` — that env var grants the better-auth
 *   admin role and is deliberately not coupled to a reseed.
 * - `m1@m.com` is on two maker teams, Engraving and Finishing: the one
 *   login whose workflows list is grouped by team.
 * - `m2@m.com` is on Rush alone: the one persona whose workflows list is the
 *   cross-cutting workflow rather than a product's.
 *
 * Three, which is Basic's `membersIncluded`, so a seeded shop bills no seat
 * on either plan. The other maker teams carry only the lead; a persona that
 * needs its own team is added by the spec that needs it (`seedMembers`),
 * never by growing this list past the smallest plan.
 *
 * Every maker team owns tasks in at least two workflows so no list is
 * single-workflow, and every hand-off crosses a team boundary. Tags are the
 * workflow names in tag form, which is what the create dialog prefills.
 *
 * The derived attention states are all seeded so every warning is visible
 * after one `pnpm seed`, and each carries its reading in its name so the row
 * cannot be mistaken for a mistake: `Retired team (empty)` has nobody on it,
 * `Tag stamping (unassigned task)` has a task with no team (what a team delete
 * leaves behind) and one on the empty team, `Sample pull (no steps)`
 * has none, and `Frame and glaze` is seeded off.
 *
 * An invariant the ordinary write path enforces and the seed only checks in
 * part, so the fixture must honour it by construction: a workflow with an
 * unassigned task cannot be on; the seed defaults it off.
 *
 * Orders are written straight into the shop's object, bypassing Shopify, so
 * every lifecycle state a workflows list or order page can show exists without tagging
 * sandbox products. A populated workflows list from *real* orders additionally needs
 * the sandbox products tagged with the workflow tags by hand.
 *
 * Two order vocabularies the rows below lean on, both documented on
 * `e2e/seed.ts`: an item's own `progress` overrides the order's, which is
 * what puts one order's items in four different states; and `after` is a second
 * state for the order written *after* the work started, which is the only way
 * to reach the closed and resized runs a late cancel, fulfilment or refund
 * produces.
 *
 * `Rush order` is the fixture's one cross-cutting workflow: a product carrying
 * `rush` beside its own tag is claimed by two workflows, nothing starts, and
 * the row reads **Choose a workflow**. It is deliberately the kind of mistake
 * a merchant makes — "rush" was meant as an order label, not a workflow.
 *
 * The rows from `#2001` are generated rather than hand-written, and are always
 * seeded: the member's workflows list and the orders index are only honest at a few
 * hundred cards and more than one page, and a second fixture without them would
 * only leave it unclear which one a screen was judged against.
 */

export const LEAD = "lead@m.com";
const maker = (i: number) => `m${String(i)}@m.com`;

// Maker teams.
const WOODSHOP = "Woodshop";
const ENGRAVING = "Engraving";
const LEATHER = "Leather";
const JEWELRY = "Jewelry";
const TEXTILES = "Textiles";
const FINISHING = "Finishing";
// Cross-cutting: not a product's team, it owns the first task of `Rush order`.
const RUSH = "Rush";
export const RETIRED_TEAM_EMPTY = "Retired team (empty)";
/**
 * Exactly 64 characters, `Domain.NAME_MAX_LENGTH`: the longest team name the
 * app accepts, so a task's team line has to wrap under a task name that is
 * just as long.
 */
const AT_CAP_TEAM =
  "Hand stitching, edge painting and final inspection bench, room 2";

export const members: readonly SeedMember[] = [LEAD, maker(1), maker(2)];

export const teams: readonly SeedTeam[] = [
  { name: WOODSHOP, members: [LEAD] },
  { name: ENGRAVING, members: [LEAD, maker(1)] },
  { name: LEATHER, members: [LEAD] },
  { name: JEWELRY, members: [LEAD] },
  { name: TEXTILES, members: [LEAD] },
  { name: FINISHING, members: [LEAD, maker(1)] },
  { name: RUSH, members: [LEAD, maker(2)] },
  // nobody on it: "No members" on the team page and on the tasks it owns
  { name: RETIRED_TEAM_EMPTY, members: [] },
  { name: AT_CAP_TEAM, members: [LEAD, maker(1)] },
];

const task = (
  name: string,
  team: string | null,
  extra: Partial<Pick<SeedWorkflowTask, "step" | "instructions">> = {},
): SeedWorkflowTask => ({ name, team, ...extra });

// Product tags the workflows match on; `orders` below carry the same.
const TAG = {
  board: "engraved-cutting-board",
  journal: "leather-journal",
  ring: "signet-ring",
  blanket: "embroidered-blanket",
  frame: "photo-frame",
  petTag: "pet-tag",
  sample: "wholesale-sample",
  clock: "wall-clock",
  giftBox: "gift-box",
  keychain: "keychain",
  heirloom: "heirloom-journal",
  // Not a product: the label a merchant puts on an order, which is exactly
  // why a product carrying it as well as its own tag is ambiguous.
  rush: "rush",
} as const;

/**
 * A name cut to exactly `Domain.NAME_MAX_LENGTH` (64) characters. `AT_CAP_TASK`
 * is longer than that behind every numbered prefix, and the cut lands inside
 * a word, so the name keeps all 64 characters after the seed trims it.
 */
const atCap = (name: string) => name.slice(0, 64);

const AT_CAP_TASK =
  "Condition, burnish and inspect the edges against the customer's reference";

/** Exactly 64 characters: the longest workflow name, which the Manage drawer prints as its header. */
const AT_CAP_WORKFLOW =
  "Heirloom leather journal, hand-stitched spine, embossed monogram";

/**
 * Each workflow is a distinct shape so the editor, workflows list, and order page each
 * have one row per case to look at: linear, a parallel step in the middle
 * with the first team returning, a parallel first step, instructions with a
 * pending draft, the off / unassigned / no-tasks rows, and one at the caps.
 *
 * Named after the process, not the product ("Stamp and bind" for the leather
 * journal): the member's row and workflow page print the item beside its
 * workflow, and a workflow named like its product reads as the item said
 * twice. The comment on each says which product it is for.
 */
export const workflows: readonly SeedWorkflow[] = [
  {
    // the cutting board: three-task linear, the bread-and-butter product
    name: "Cut, engrave and oil",
    tag: TAG.board,
    tasks: [
      task("Cut and sand", WOODSHOP, {
        instructions:
          "Cut to the size on the order. Sand to 220 grit; check for tear-out on the end grain.",
      }),
      task("Engrave", ENGRAVING, {
        instructions:
          "Engraving text is in the properties. Confirm spelling against the order before running the laser.",
      }),
      task("Oil and finish", FINISHING),
    ],
  },
  {
    // the leather journal: parallel middle step; Leather starts and returns at the end
    name: "Stamp and bind",
    tag: TAG.journal,
    tasks: [
      task("Cut leather", LEATHER, { step: 1 }),
      task("Stamp monogram", ENGRAVING, {
        step: 2,
        instructions: "Initials in the properties; centre on the cover.",
      }),
      task("Stitch spine", LEATHER, { step: 2 }),
      task("Condition and inspect", LEATHER, { step: 3 }),
    ],
  },
  {
    // the signet ring: linear; instructions on every task; Jewelry starts and returns
    name: "Cast and engrave",
    tag: TAG.ring,
    tasks: [
      task("Cast", JEWELRY, {
        instructions: "Ring size and metal are in the properties.",
      }),
      task("Engrave crest", ENGRAVING, {
        instructions: "Crest file is named after the order number.",
      }),
      task("Polish", JEWELRY, {
        instructions: "High polish unless the order says brushed.",
      }),
    ],
  },
  {
    // the blanket: two-task; a pending draft adds a third task so the detail page shows
    // both sides
    name: "Embroider and fold",
    tag: TAG.blanket,
    tasks: [
      task("Embroider", TEXTILES, {
        instructions: "Name and thread colour are in the properties.",
      }),
      task("Steam and fold", FINISHING),
    ],
    draft: {
      tasks: [
        task("Embroider", TEXTILES, {
          instructions: "Name and thread colour are in the properties.",
        }),
        task("Attach care label", TEXTILES),
        task("Steam and fold", FINISHING),
      ],
    },
  },
  {
    // the photo frame: parallel first step, three wide; seeded off so the list has an "Off"
    // row and it starts nothing until it is turned on
    name: "Frame and glaze",
    active: false,
    tag: TAG.frame,
    tasks: [
      task("Cut frame", WOODSHOP, { step: 1 }),
      task("Engrave caption", ENGRAVING, { step: 1 }),
      task("Cut glass", FINISHING, { step: 1 }),
      task("Assemble", WOODSHOP, { step: 2 }),
    ],
  },
  {
    // the pet tag: one unassigned task (what a team delete leaves) and one on the empty
    // team: "Needs a team" in the list, both banners on the detail page,
    // Turn on refused until the task is assigned
    name: "Tag stamping (unassigned task)",
    tag: TAG.petTag,
    tasks: [task("Stamp", null), task("Attach ring", RETIRED_TEAM_EMPTY)],
  },
  {
    // the wholesale sample: zero tasks, "No tasks"
    name: "Sample pull (no steps)",
    tag: TAG.sample,
    tasks: [],
  },
  {
    // cross-cutting: every product also tagged `rush` is claimed by this one
    // as well as its own, so nothing starts and the item reads "Choose a
    // workflow". A product tagged only `rush` follows it on its own.
    name: "Rush order",
    tag: TAG.rush,
    tasks: [
      task("Expedite", RUSH, {
        instructions: "Pull the materials first; this jumps the bench queue.",
      }),
      task("Pack rush", FINISHING),
    ],
  },
  {
    // the gift box, the long one: twelve tasks over eight steps, two of them three wide,
    // so the editor, a card's sibling list, and "task 4 of 12" each have a
    // row that is not three tasks long
    name: "Box assembly (many tasks)",
    tag: TAG.giftBox,
    tasks: [
      task("Cut box panels", WOODSHOP, { step: 1 }),
      task("Cut liner", TEXTILES, { step: 1 }),
      task("Cut leather strap", LEATHER, { step: 1 }),
      task("Engrave lid", ENGRAVING, {
        step: 2,
        instructions: "Lid text is in the properties; centre on the grain.",
      }),
      task("Cast charm", JEWELRY, { step: 2 }),
      task("Press liner", FINISHING, { step: 2 }),
      task("Assemble box", WOODSHOP),
      task("Fit liner", FINISHING),
      task("Attach strap", WOODSHOP),
      task("Add charm", FINISHING),
      task("Quality check", WOODSHOP, {
        instructions:
          "Open and close the lid ten times; the strap must not bind.",
      }),
      task("Wrap and box", FINISHING),
    ],
  },
  {
    // the wall clock: a draft that MOVES a task to another team rather than adding one: runs
    // open when it is applied keep the team they snapshotted, which is the
    // thing the blanket's add-a-task draft cannot show
    name: "Clock assembly",
    tag: TAG.clock,
    tasks: [
      task("Cut face", WOODSHOP),
      task("Engrave numerals", ENGRAVING, {
        instructions: "Numeral style is in the properties.",
      }),
      task("Fit movement", FINISHING),
    ],
    draft: {
      tasks: [
        task("Cut face", WOODSHOP),
        task("Engrave numerals", WOODSHOP, {
          instructions: "Numeral style is in the properties.",
        }),
        task("Fit movement", FINISHING),
      ],
    },
  },
  {
    // on, and it starts runs: an empty team does not block a start, so the
    // second task lands on a team nobody is on — the order page's card names it
    // and no workflows list anywhere shows the card. Distinct from
    // Pet tag, which is off because a task has no team at all.
    name: "Ring and stamp (empty team task)",
    active: true,
    tag: TAG.keychain,
    tasks: [task("Cut", LEATHER), task("Attach ring", RETIRED_TEAM_EMPTY)],
  },
  {
    // at the caps: `Domain.WorkflowLimits.maxTasks` tasks and every name at
    // `Domain.NAME_MAX_LENGTH`, so the Manage drawer and the member run page
    // are judged at their longest, not at three short tasks. One task, then
    // three in parallel, then one per step.
    name: AT_CAP_WORKFLOW,
    tag: TAG.heirloom,
    tasks: Array.from({ length: 20 }, (_, index) =>
      task(
        atCap(`${String(index + 1)}. ${AT_CAP_TASK}`),
        index % 2 === 0 ? LEATHER : AT_CAP_TEAM,
        { step: index <= 3 ? Math.min(index + 1, 2) : index - 1 },
      ),
    ),
  },
];

/** One tag, several (the ambiguous case: `rush` beside the product's own), or none at all. */
const tagsOf = (tag: string | readonly string[] | null): readonly string[] => {
  if (tag === null) return [];
  return typeof tag === "string" ? [tag] : tag;
};

const item = (
  title: string,
  tag: string | readonly string[] | null,
  quantity: number,
  properties: Record<string, string | null> = {},
  extra: Partial<
    Pick<SeedLineItem, "currentQuantity" | "progress" | "workflow">
  > = {},
): SeedLineItem => ({
  title,
  quantity,
  tags: tagsOf(tag),
  properties: Object.entries(properties).map(([key, value]) => ({
    key,
    value,
  })),
  ...extra,
});

/**
 * Exactly 200 characters, which is a title long enough to wrap on a run's row
 * and on the order page, so neither is ever judged on short ones alone.
 */
const LONG_TITLE =
  "Engraved cutting board, extra large end-grain walnut with a hand-cut juice groove, rounded finger grips, a personalized inscription across the front face, a food-safe oil finish, and gift wrapping for the day".slice(
    0,
    200,
  );

/**
 * Exactly the 1000 characters a block reason may hold, so the banner, the card
 * and the order page each have to carry the longest one a worker can type.
 */
const LONG_BLOCK_REASON =
  "The crest is a scan of a wax seal and the fine lines fill in at this depth; we have tried three passes and it still reads as a smudge, so we are waiting on vector artwork from the customer. "
    .repeat(6)
    .slice(0, 1000);

/**
 * One order per state a worker or the orders index can meet, oldest first
 * (the seed spaces them a millisecond apart). Read down the list as a day on the
 * floor: new work, work under way, work waiting on packing, the rows that need
 * a person's attention, and the rows where Shopify changed the order after the
 * bench had already started on it.
 */
const floorOrders: readonly SeedOrder[] = [
  {
    // fresh: nothing started; Woodshop's list has its first card
    n: 1001,
    lineItems: [
      item("Engraved cutting board", TAG.board, 1, {
        Engraving: "The Millers · est. 2019",
      }),
    ],
  },
  {
    // two items, each one task in, and both next tasks started at
    // Engraving: "Started" over "Engraving · lead@m.com · since …" on two cards
    n: 1002,
    advance: 1,
    started: true,
    lineItems: [
      item("Signet ring", TAG.ring, 1, { Size: "9", Metal: "Sterling silver" }),
      item("Leather journal", TAG.journal, 1, { Initials: "J.R.M." }),
    ],
  },
  {
    // parallel step current: Engraving and Leather each hold a card for the
    // same journal and see each other as "together with"
    n: 1003,
    advance: 1,
    lineItems: [
      item("Leather journal", TAG.journal, 2, { Initials: "A.K." }),
      item("Ceramic mug", null, 1),
    ],
  },
  {
    // every item made: the order run is current, so Quality check has a card
    // listing both items as Done
    n: 1004,
    advance: 2,
    note: "Gift — please leave the price off the slip.",
    lineItems: [
      item("Embroidered blanket", TAG.blanket, 1, {
        Name: "Theodore",
        Thread: "Navy",
      }),
      item("Embroidered blanket", TAG.blanket, 1, {
        Name: "Eloise",
        Thread: "Rose",
      }),
    ],
  },
  {
    // inspected (three rounds make the board, a fourth passes Inspect):
    // Pack and Print label current together, Packing and Shipping each see
    // the other
    n: 1005,
    advance: 4,
    lineItems: [
      item("Engraved cutting board", TAG.board, 1, {
        Engraving: "Nonna's Kitchen",
      }),
    ],
  },
  {
    // fully made, packed, and still unfulfilled in Shopify: the Made filter
    // has a row
    n: 1006,
    done: true,
    lineItems: [item("Signet ring", TAG.ring, 1, { Size: "7", Metal: "Gold" })],
  },
  {
    // one of two units refunded after ordering (`currentQuantity` below
    // `quantity`), so the run and the order page read "×1 to make"
    n: 1007,
    note: "Customer cancelled one board after ordering.",
    lineItems: [
      item(
        "Engraved cutting board",
        TAG.board,
        2,
        { Engraving: "Home Sweet Home" },
        { currentQuantity: 1 },
      ),
    ],
  },
  {
    // blocked by a worker with a reason: the Blocked banner, with Unblock
    // and Edit reason, on the card
    n: 1008,
    advance: 1,
    blocked: "Crest file missing from the order — asked the customer.",
    lineItems: [
      item("Signet ring", TAG.ring, 1, { Size: "10", Metal: "Gold" }),
    ],
  },
  {
    // unpaid: nothing routes, and an unpaid order with no runs has no issue:
    // Not started with an empty Issues cell
    n: 1009,
    unpaid: true,
    lineItems: [item("Leather journal", TAG.journal, 1, { Initials: "S.P." })],
  },
  {
    // no workflow matches: Not started, with an empty cell in the orders
    // index's Issues column
    n: 1010,
    lineItems: [item("Gift card", null, 1)],
  },
  {
    // two workflows claim the one item (its own tag plus `rush`), so nothing
    // starts: a "Choose a workflow" issue badge on the index, and the order page's picker
    // offers exactly those two
    n: 1011,
    lineItems: [
      item("Signet ring", [TAG.ring, TAG.rush], 1, {
        Size: "8",
        Metal: "Gold",
      }),
    ],
  },
  {
    // one ambiguous item beside one that started fine: Making in the Status
    // column, "Choose a workflow" in the Issues column
    n: 1012,
    lineItems: [
      item("Engraved cutting board", [TAG.board, TAG.rush], 1, {
        Engraving: "Rush — Dad's birthday",
      }),
      item("Leather journal", TAG.journal, 1, { Initials: "T.W." }),
    ],
  },
  {
    // the same ambiguity with the choice already made by hand: one run the
    // merchant chose, no warning on the index, and Change offers the other
    // claimant
    n: 1013,
    lineItems: [
      item(
        "Engraved cutting board",
        [TAG.board, TAG.rush],
        1,
        { Engraving: "Rush — anniversary" },
        { workflow: "Cut, engrave and oil" },
      ),
    ],
  },
  {
    // five items across five workflows, none started: five lists each hold
    // one card from this order and the summary line reads "5 items"
    n: 1014,
    lineItems: [
      item("Engraved cutting board", TAG.board, 1, {
        Engraving: "The Okonkwos",
      }),
      item("Leather journal", TAG.journal, 1, { Initials: "R.O." }),
      item("Signet ring", TAG.ring, 1, {
        Size: "6",
        Metal: "Sterling silver",
      }),
      item("Embroidered blanket", TAG.blanket, 1, {
        Name: "Ada",
        Thread: "Cream",
      }),
      item("Wall clock", TAG.clock, 1, { Numerals: "Roman" }),
    ],
  },
  {
    // four items in four states at once — made, blocked, started, not
    // started — which is the row the order summary line and the per-item
    // badges are written for
    n: 1015,
    lineItems: [
      item(
        "Engraved cutting board",
        TAG.board,
        1,
        { Engraving: "Bake with love" },
        { progress: { done: true } },
      ),
      item(
        "Signet ring",
        TAG.ring,
        1,
        { Size: "11", Metal: "Gold" },
        {
          progress: {
            advance: 1,
            blocked:
              "Crest artwork is too fine to engrave at this size — waiting on a redraw.",
          },
        },
      ),
      item(
        "Leather journal",
        TAG.journal,
        1,
        { Initials: "M.E.B." },
        { progress: { advance: 1, started: true } },
      ),
      item("Embroidered blanket", TAG.blanket, 1, {
        Name: "Juniper",
        Thread: "Sage",
      }),
    ],
  },
  {
    // three of the same board, each personalized, the third removed from the
    // order after it was placed: the Removed badge beside two live siblings
    n: 1016,
    lineItems: [
      item("Engraved cutting board", TAG.board, 1, { Engraving: "Kitchen 1" }),
      item("Engraved cutting board", TAG.board, 1, { Engraving: "Kitchen 2" }),
      item(
        "Engraved cutting board",
        TAG.board,
        1,
        { Engraving: "Kitchen 3" },
        { currentQuantity: 0 },
      ),
    ],
  },
  {
    // quantity edited down before anything started: "× 2 to make (3 ordered)"
    n: 1017,
    lineItems: [
      item(
        "Engraved cutting board",
        TAG.board,
        3,
        { Engraving: "Farmhouse" },
        { currentQuantity: 2 },
      ),
    ],
  },
  {
    // nothing on the order at all: "No items." on the order page
    n: 1018,
    lineItems: [],
  },
  {
    // cancelled in Shopify after the ring was already cast: the run closes,
    // "Order cancelled in Shopify", and leaves every list for Done or closed
    n: 1019,
    advance: 1,
    after: { cancelled: true },
    lineItems: [item("Signet ring", TAG.ring, 1, { Size: "5", Metal: "Gold" })],
  },
  {
    // fulfilled in Shopify while the journal was still on the bench: the run
    // closes, "Fulfilled in Shopify"
    n: 1020,
    advance: 1,
    after: { fulfillmentStatus: "FULFILLED" },
    lineItems: [item("Leather journal", TAG.journal, 1, { Initials: "C.L." })],
  },
  {
    // one of the two units refunded after the work started: the run is
    // resized to ×1 and wears "Quantity changed · 2 → 1" until the next Done
    n: 1021,
    started: true,
    after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
    lineItems: [
      item("Engraved cutting board", TAG.board, 2, {
        Engraving: "Two of a kind",
      }),
    ],
  },
  {
    // the merchant recorded the task from the order page: "Done" over "<team> · Merchant · …"
    n: 1022,
    advance: 1,
    byMerchant: true,
    lineItems: [
      item("Embroidered blanket", TAG.blanket, 1, {
        Name: "Rowan",
        Thread: "Slate",
      }),
    ],
  },
  {
    // and blocked it from the same page: "Blocked by Merchant"
    n: 1023,
    advance: 1,
    byMerchant: true,
    blocked: "Customer is changing the crest — hold until they confirm.",
    lineItems: [
      item("Signet ring", TAG.ring, 1, { Size: "9", Metal: "Brushed gold" }),
    ],
  },
  {
    // the cut is done and the next task belongs to a team with nobody on it:
    // the order page's card names the team and no workflows list shows it
    n: 1024,
    advance: 1,
    lineItems: [item("Keychain", TAG.keychain, 1, { Initials: "D.V." })],
  },
  // A run whose team was deleted outright would be `#1025`. The seed names
  // teams that have to exist and cannot delete one mid-fixture, so that state
  // stays with the e2e specs instead of being faked here.
  {
    // every text field at its limit at once: a title that wraps, a block
    // reason at exactly 1000 characters, and a property with no value
    // (what an empty gift-note field sends)
    n: 1026,
    advance: 1,
    blocked: LONG_BLOCK_REASON,
    lineItems: [item(LONG_TITLE, TAG.board, 1, { "Gift note": null })],
  },
  {
    // a product that is only ever a rush job, so Rush has a workflows list of its own
    // and `m9` is not looking at an empty page
    n: 1027,
    lineItems: [item("Rush gift wrap", TAG.rush, 1, { Note: "Same-day" })],
  },
  {
    n: 1028,
    advance: 1,
    lineItems: [item("Rush gift wrap", TAG.rush, 1, { Note: "Courier 4pm" })],
  },
  {
    n: 1029,
    advance: 1,
    started: true,
    lineItems: [
      item("Rush gift wrap", TAG.rush, 1, { Note: "Counter pickup" }),
    ],
  },
  {
    // the order page at its longest: an ambiguous item, a run at the caps in
    // step 2 with step 1 done, and an item nothing matches. Manage on the
    // journal opens 20 tasks with 64-character task, team and workflow names.
    n: 1030,
    lineItems: [
      item("Engraved cutting board", [TAG.board, TAG.rush], 1, {
        Engraving: "Rush — Dad's birthday",
      }),
      item(
        "Heirloom leather journal",
        TAG.heirloom,
        1,
        { Initials: "T.W." },
        {
          progress: { advance: 1 },
        },
      ),
      item("Gift card sleeve", null, 2),
    ],
  },
  {
    // the line removed in Shopify while the board was on the bench: the run
    // closes, "Item removed or refunded in Shopify", with the Removed badge
    n: 1031,
    advance: 1,
    after: { lineItems: [{ position: 1, currentQuantity: 0 }] },
    lineItems: [
      item("Engraved cutting board", TAG.board, 1, { Engraving: "Removed" }),
    ],
  },
  {
    // done, then one of two units refunded: a done run is the record of
    // what was made, so it stays Done at ×2 with no badge; Reopen in Manage
    n: 1032,
    done: true,
    after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
    lineItems: [item("Leather journal", TAG.journal, 2, { Initials: "Q.C." })],
  },
  {
    // blocked before anyone started: Not started plus Blocked, Edit reason
    // and Unblock in the banner, Assign team in Manage, no Done
    n: 1033,
    blocked: "Waiting on the customer's photo.",
    lineItems: [item("Wall clock", TAG.clock, 1, { Numerals: "Arabic" })],
  },
  {
    // three workflows claim the item: the picker lists the three matches,
    // a rule, then every other workflow
    n: 1034,
    lineItems: [
      item("Engraved journal board", [TAG.board, TAG.journal, TAG.rush], 1),
    ],
  },
  {
    // the merchant cancelled the run after a step was done: Closed, "Cancelled
    // by you", the done step still on record, and the picker to start one
    // afresh; reconcile starts nothing on it
    n: 1035,
    lineItems: [
      item(
        "Signet ring",
        TAG.ring,
        1,
        { Size: "8", Metal: "Silver" },
        { progress: { advance: 1, cancelled: true } },
      ),
    ],
  },
];

/**
 * The startable products and their workflows' tags, cycled by the generated
 * rows below. Frame and glaze (off), Tag stamping (unassigned task) and
 * Sample pull (no steps) are left out because they start nothing, and `rush` because a second tag would
 * make every generated row ambiguous.
 */
const MAKER_PRODUCTS = [
  ["Engraved cutting board", TAG.board],
  ["Leather journal", TAG.journal],
  ["Signet ring", TAG.ring],
  ["Embroidered blanket", TAG.blanket],
  ["Wall clock", TAG.clock],
  ["Gift box", TAG.giftBox],
] as const;

const productAt = (index: number) =>
  MAKER_PRODUCTS[index % MAKER_PRODUCTS.length] ?? MAKER_PRODUCTS[0];

/**
 * The biggest single order the fixture holds: 25 items, every one
 * personalized differently so the cards are tellable apart, which is both the
 * longest order page and the largest "together with" group on a workflows list.
 */
const bigOrder = (n: number): SeedOrder => ({
  n,
  note: "Corporate gifting — one box per person, names on the sheet.",
  lineItems: Array.from({ length: 25 }, (_, index) => {
    const [title, tag] = productAt(index);
    return item(title, tag, 1, {
      Engraving: `${title} ${String(index + 1)} of 25 · order ${String(n)}`,
    });
  }),
});

/** Cycled over the generated orders so every tier of the workflows list is populated, not only Ready. */
const SCALE_PROGRESS: readonly SeedProgress[] = [
  {},
  { advance: 1 },
  { advance: 1, started: true },
  { advance: 2 },
  { done: true },
];

/**
 * Volume, always seeded: the workflows list's tiers are uncapped apart from Ready and
 * the orders index pages at 25, so neither can be judged at ten orders. Kept
 * to a few hundred runs — every one is a real reconcile and every round a real
 * write, and the reseed has to stay quick enough that people still run it.
 */
const scaleOrders = (from: number, count: number): readonly SeedOrder[] =>
  Array.from({ length: count }, (_, index) => {
    const n = from + index;
    return {
      n,
      ...SCALE_PROGRESS[index % SCALE_PROGRESS.length],
      lineItems: Array.from(
        { length: index % 2 === 0 ? 1 : 2 },
        (_unused, slot) => {
          const [title, tag] = productAt(index + slot);
          return item(title, tag, 1, { Engraving: `Order ${String(n)}` });
        },
      ),
    };
  });

export const orders: readonly SeedOrder[] = [
  ...floorOrders,
  bigOrder(2001),
  ...scaleOrders(2002, 40),
];

export const fixture = { members, teams, workflows, orders } as const;

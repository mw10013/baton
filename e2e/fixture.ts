import type {
  SeedLineItem,
  SeedMember,
  SeedOrder,
  SeedProgress,
  SeedTeam,
  SeedWorkflow,
  SeedWorkflowStep,
} from "./seed.ts";

/**
 * The canonical development fixture, posted by `pnpm seed` (`scripts/seed.ts`)
 * and importable by any Playwright spec that wants the whole shop rather than
 * a two-row world. Lives under `e2e/` so nothing in the worker bundle imports
 * test data.
 *
 * Deliberately NOT adopted by the existing specs: each seeds the exact shape
 * its assertions compute (a queue with N cards, a team with M members). Pinning
 * those to this shared fixture would make one edit here silently retune
 * unrelated assertions. `pnpm seed` and manual exploration are its consumers.
 *
 * The shop is a fictional made-to-order gift maker — engraved boards, leather
 * journals, signet rings, embroidered blankets — so every screen reads the way
 * a merchant's would: a worker at Engraving sees "Engrave · Signet ring ·
 * #1002", not "Step 2a · Workflow 03". Realism is what makes UX judgments
 * about the member area honest; the abstract names it replaced only proved
 * the plumbing.
 *
 * Logins, by role, so one browser profile per persona covers the product:
 *
 * - `lead@m.com` is on every team: one login that sees every queue. It is
 *   fixture data, not `ADMIN_EMAILS` — that env var grants the better-auth
 *   admin role and is deliberately not coupled to a reseed.
 * - `m1@m.com` is on two maker teams, Engraving and Finishing: the one
 *   login whose queue is grouped by team.
 * - `m2@m.com` is on Rush alone: the one persona whose queue is the
 *   cross-cutting workflow rather than a product's.
 *
 * Three, which is Basic's `maxMembers`, so a seeded shop holds a seat for
 * every login whichever plan it is on. The other maker teams carry only the
 * lead; a persona that needs its own team is added by the spec that needs it
 * (`seedMembers`), never by growing this list past the smallest plan.
 *
 * Every maker team owns steps in at least two workflows so no queue is
 * single-workflow, and every hand-off crosses a team boundary. Tags are the
 * workflow names in tag form, which is what the create dialog prefills.
 *
 * The derived attention states are all seeded so every warning is visible
 * after one `pnpm seed`, and each carries its reading in its name so the row
 * cannot be mistaken for a mistake: `Retired team (empty)` has nobody on it,
 * `Pet tag (unassigned step)` has a step with no team (what a team delete
 * leaves behind) and one on the empty team, `Wholesale sample (no steps)`
 * has none, and `Photo frame` is seeded off.
 *
 * An invariant the ordinary write path enforces and the seed only checks in
 * part, so the fixture must honour it by construction: a workflow with an
 * unassigned step cannot be on; the seed defaults it off.
 *
 * Orders are written straight into the shop's object, bypassing Shopify, so
 * every lifecycle state a queue or order page can show exists without tagging
 * sandbox products. A populated queue from *real* orders additionally needs
 * the sandbox products tagged with the workflow tags by hand.
 *
 * Two order vocabularies the rows below lean on, both documented on
 * `e2e/seed.ts`: a line item's own `progress` overrides the order's, which is
 * what puts one order's items in four different states; and `after` is a second
 * state for the order written *after* the work started, which is the only way
 * to reach the flags a late cancel, shipment or refund produces.
 *
 * `Rush order` is the fixture's one cross-cutting workflow: a product carrying
 * `rush` beside its own tag is claimed by two workflows, nothing starts, and
 * the row reads **Choose a workflow**. It is deliberately the kind of mistake
 * a merchant makes — "rush" was meant as an order label, not a workflow.
 *
 * The rows from `#2001` are generated rather than hand-written, and are always
 * seeded: the member queue and the orders index are only honest at a few
 * hundred cards and more than one page, and a second flagless fixture would
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
// Cross-cutting: not a product's team, it owns the first step of `Rush order`.
const RUSH = "Rush";
export const RETIRED_TEAM_EMPTY = "Retired team (empty)";

export const members: readonly SeedMember[] = [LEAD, maker(1), maker(2)];

export const teams: readonly SeedTeam[] = [
  { name: WOODSHOP, members: [LEAD] },
  { name: ENGRAVING, members: [LEAD, maker(1)] },
  { name: LEATHER, members: [LEAD] },
  { name: JEWELRY, members: [LEAD] },
  { name: TEXTILES, members: [LEAD] },
  { name: FINISHING, members: [LEAD, maker(1)] },
  { name: RUSH, members: [LEAD, maker(2)] },
  // nobody on it: "No members" on the team page and on the steps it owns
  { name: RETIRED_TEAM_EMPTY, members: [] },
];

const step = (
  name: string,
  team: string | null,
  extra: Partial<Pick<SeedWorkflowStep, "stage" | "instructions">> = {},
): SeedWorkflowStep => ({ name, team, ...extra });

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
  // Not a product: the label a merchant puts on an order, which is exactly
  // why a product carrying it as well as its own tag is ambiguous.
  rush: "rush",
} as const;

/**
 * Each workflow is a distinct shape so the editor, queue, and order page each
 * have one row per case to look at: linear, a parallel stage in the middle
 * with the first team returning, a parallel first stage, instructions with a
 * pending draft, and the off / unassigned / no-steps rows.
 */
export const workflows: readonly SeedWorkflow[] = [
  {
    // three-step linear, the bread-and-butter product
    name: "Engraved cutting board",
    tag: TAG.board,
    steps: [
      step("Cut and sand", WOODSHOP, {
        instructions:
          "Cut to the size on the order. Sand to 220 grit; check for tear-out on the end grain.",
      }),
      step("Engrave", ENGRAVING, {
        instructions:
          "Engraving text is in the personalization. Confirm spelling against the order before running the laser.",
      }),
      step("Oil and finish", FINISHING),
    ],
  },
  {
    // parallel middle stage; Leather starts and returns at the end
    name: "Leather journal",
    tag: TAG.journal,
    steps: [
      step("Cut leather", LEATHER, { stage: 1 }),
      step("Stamp monogram", ENGRAVING, {
        stage: 2,
        instructions: "Initials in the personalization; centre on the cover.",
      }),
      step("Stitch spine", LEATHER, { stage: 2 }),
      step("Condition and inspect", LEATHER, { stage: 3 }),
    ],
  },
  {
    // linear; instructions on every step; Jewelry starts and returns
    name: "Signet ring",
    tag: TAG.ring,
    steps: [
      step("Cast", JEWELRY, {
        instructions: "Ring size and metal are in the personalization.",
      }),
      step("Engrave crest", ENGRAVING, {
        instructions: "Crest file is named after the order number.",
      }),
      step("Polish", JEWELRY, {
        instructions: "High polish unless the order says brushed.",
      }),
    ],
  },
  {
    // two-step; a pending draft adds a third step so the list shows "Draft
    // pending" and the detail page shows both sides
    name: "Embroidered blanket",
    tag: TAG.blanket,
    steps: [
      step("Embroider", TEXTILES, {
        instructions: "Name and thread colour are in the personalization.",
      }),
      step("Steam and fold", FINISHING),
    ],
    draft: {
      steps: [
        step("Embroider", TEXTILES, {
          instructions: "Name and thread colour are in the personalization.",
        }),
        step("Attach care label", TEXTILES),
        step("Steam and fold", FINISHING),
      ],
    },
  },
  {
    // parallel first stage, three wide; seeded off so the list has an "Off"
    // row and it starts nothing until it is turned on
    name: "Photo frame",
    active: false,
    tag: TAG.frame,
    steps: [
      step("Cut frame", WOODSHOP, { stage: 1 }),
      step("Engrave caption", ENGRAVING, { stage: 1 }),
      step("Cut glass", FINISHING, { stage: 1 }),
      step("Assemble", WOODSHOP, { stage: 2 }),
    ],
  },
  {
    // one unassigned step (what a team delete leaves) and one on the empty
    // team: "Needs attention" in the list, both banners on the detail page,
    // Turn on refused until the step is assigned
    name: "Pet tag (unassigned step)",
    tag: TAG.petTag,
    steps: [step("Stamp", null), step("Attach ring", RETIRED_TEAM_EMPTY)],
  },
  {
    // zero steps: "No steps"
    name: "Wholesale sample (no steps)",
    tag: TAG.sample,
    steps: [],
  },
  {
    // cross-cutting: every product also tagged `rush` is claimed by this one
    // as well as its own, so nothing starts and the item reads "Choose a
    // workflow". A product tagged only `rush` follows it on its own.
    name: "Rush order",
    tag: TAG.rush,
    steps: [
      step("Expedite", RUSH, {
        instructions: "Pull the materials first; this jumps the bench queue.",
      }),
      step("Pack rush", FINISHING),
    ],
  },
  {
    // the long one: twelve steps over eight stages, two of them three wide,
    // so the editor, a card's sibling list, and "step 4 of 12" each have a
    // row that is not three steps long
    name: "Gift box (many steps)",
    tag: TAG.giftBox,
    steps: [
      step("Cut box panels", WOODSHOP, { stage: 1 }),
      step("Cut liner", TEXTILES, { stage: 1 }),
      step("Cut leather strap", LEATHER, { stage: 1 }),
      step("Engrave lid", ENGRAVING, {
        stage: 2,
        instructions:
          "Lid text is in the personalization; centre on the grain.",
      }),
      step("Cast charm", JEWELRY, { stage: 2 }),
      step("Press liner", FINISHING, { stage: 2 }),
      step("Assemble box", WOODSHOP),
      step("Fit liner", FINISHING),
      step("Attach strap", WOODSHOP),
      step("Add charm", FINISHING),
      step("Quality check", WOODSHOP, {
        instructions:
          "Open and close the lid ten times; the strap must not bind.",
      }),
      step("Wrap and box", FINISHING),
    ],
  },
  {
    // a draft that MOVES a step to another team rather than adding one: runs
    // open when it is applied keep the team they snapshotted, which is the
    // thing the blanket's add-a-step draft cannot show
    name: "Wall clock",
    tag: TAG.clock,
    steps: [
      step("Cut face", WOODSHOP),
      step("Engrave numerals", ENGRAVING, {
        instructions: "Numeral style is in the personalization.",
      }),
      step("Fit movement", FINISHING),
    ],
    draft: {
      steps: [
        step("Cut face", WOODSHOP),
        step("Engrave numerals", WOODSHOP, {
          instructions: "Numeral style is in the personalization.",
        }),
        step("Fit movement", FINISHING),
      ],
    },
  },
  {
    // on, and it starts runs: an empty team does not block a start, so the
    // second step lands on a team nobody is on — the order page names it
    // under "waiting on" and no queue anywhere shows the card. Distinct from
    // Pet tag, which is off because a step has no team at all.
    name: "Keychain (empty team step)",
    active: true,
    tag: TAG.keychain,
    steps: [step("Cut", LEATHER), step("Attach ring", RETIRED_TEAM_EMPTY)],
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
  personalization: Record<string, string | null> = {},
  extra: Partial<
    Pick<
      SeedLineItem,
      "currentQuantity" | "unfulfilledQuantity" | "progress" | "workflow"
    >
  > = {},
): SeedLineItem => ({
  title,
  quantity,
  tags: tagsOf(tag),
  customAttributes: Object.entries(personalization).map(([key, value]) => ({
    key,
    value,
  })),
  ...extra,
});

/**
 * Exactly 200 characters, which is a title long enough to wrap on a queue card
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
    // fresh: nothing started; Woodshop's queue has its first card
    n: 1001,
    lineItems: [
      item("Engraved cutting board", TAG.board, 1, {
        Engraving: "The Millers · est. 2019",
      }),
    ],
  },
  {
    // two items, each one step in, and both next steps in progress at
    // Engraving: "In progress since … by lead@m.com" on two cards
    n: 1002,
    advance: 1,
    started: true,
    lineItems: [
      item("Signet ring", TAG.ring, 1, { Size: "9", Metal: "Sterling silver" }),
      item("Leather journal", TAG.journal, 1, { Initials: "J.R.M." }),
    ],
  },
  {
    // parallel stage ready: Engraving and Leather each hold a card for the
    // same journal and see each other as "together with"
    n: 1003,
    advance: 1,
    lineItems: [
      item("Leather journal", TAG.journal, 2, { Initials: "A.K." }),
      item("Ceramic mug", null, 1),
    ],
  },
  {
    // every item made: the order run is ready, so Quality check has a card
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
    // Pack and Print label ready together, Packing and Shipping each see
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
    // fully made, packed, and still unfulfilled in Shopify: the Ready-to-ship
    // filter has a row
    n: 1006,
    done: true,
    lineItems: [item("Signet ring", TAG.ring, 1, { Size: "7", Metal: "Gold" })],
  },
  {
    // one of two units refunded after ordering (`unfulfilledQuantity` below
    // `quantity`), so the run and the order page read "×1 to make"
    n: 1007,
    note: "Customer cancelled one board after ordering.",
    lineItems: [
      item(
        "Engraved cutting board",
        TAG.board,
        2,
        { Engraving: "Home Sweet Home" },
        { unfulfilledQuantity: 1 },
      ),
    ],
  },
  {
    // blocked by a worker with a reason: the "Needs attention" banner and
    // Dismiss on the card
    n: 1008,
    advance: 1,
    blocked: "Crest file missing from the order — asked the customer.",
    lineItems: [
      item("Signet ring", TAG.ring, 1, { Size: "10", Metal: "Gold" }),
    ],
  },
  {
    // unpaid: nothing routes and the Not-paid filter has a row
    n: 1009,
    unpaid: true,
    lineItems: [item("Leather journal", TAG.journal, 1, { Initials: "S.P." })],
  },
  {
    // no workflow matches: "No workflow" on the orders index
    n: 1010,
    lineItems: [item("Gift card", null, 1)],
  },
  {
    // two workflows claim the one item (its own tag plus `rush`), so nothing
    // starts: "Choose a workflow" on the index, and the order page's picker
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
    // one ambiguous item beside one that started fine: the order reads
    // "Choose a workflow" even with the journal already in production
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
        { workflow: "Engraved cutting board" },
      ),
    ],
  },
  {
    // five items across five workflows, none started: five queues each hold
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
    // four items in four states at once — made, blocked, in progress, not
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
        { currentQuantity: 0, unfulfilledQuantity: 0 },
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
    // nothing on the order at all: "No line items." on the order page
    n: 1018,
    lineItems: [],
  },
  {
    // cancelled in Shopify after the ring was already cast: the run is
    // flagged "Order cancelled" rather than quietly disappearing
    n: 1019,
    advance: 1,
    after: { cancelled: true },
    lineItems: [item("Signet ring", TAG.ring, 1, { Size: "5", Metal: "Gold" })],
  },
  {
    // shipped in Shopify while the journal was still on the bench:
    // "Already shipped"
    n: 1020,
    advance: 1,
    after: { fulfillmentStatus: "FULFILLED" },
    lineItems: [item("Leather journal", TAG.journal, 1, { Initials: "C.L." })],
  },
  {
    // one of the two units refunded after the work started: the run holds the
    // ×2 it snapshotted and the order now says ×1 — "Quantity changed"
    n: 1021,
    started: true,
    after: { lineItems: [{ position: 1, unfulfilledQuantity: 1 }] },
    lineItems: [
      item("Engraved cutting board", TAG.board, 2, {
        Engraving: "Two of a kind",
      }),
    ],
  },
  {
    // the merchant recorded the step from the order page: "Done by Merchant"
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
    // the cut is done and the next step belongs to a team with nobody on it:
    // the order page names the team under "waiting on" and no queue shows it
    n: 1024,
    advance: 1,
    lineItems: [item("Keychain", TAG.keychain, 1, { Initials: "D.V." })],
  },
  // A run whose team was deleted outright would be `#1025`. The seed names
  // teams that have to exist and cannot delete one mid-fixture, so that state
  // stays with the e2e specs instead of being faked here.
  {
    // every text field at its limit at once: a title that wraps, a block
    // reason at exactly 1000 characters, and a personalization with no value
    // (what an empty gift-note field sends)
    n: 1026,
    advance: 1,
    blocked: LONG_BLOCK_REASON,
    lineItems: [item(LONG_TITLE, TAG.board, 1, { "Gift note": null })],
  },
  {
    // a product that is only ever a rush job, so Rush has a queue of its own
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
];

/**
 * The startable product workflows, cycled by the generated rows below. Photo
 * frame (off), Pet tag (unassigned step) and Wholesale sample (no steps) are
 * left out because they start nothing, and `rush` because a second tag would
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
 * longest order page and the largest "together with" group on a queue.
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

/** Cycled over the generated orders so every tier of the queue is populated, not only Up next. */
const SCALE_PROGRESS: readonly SeedProgress[] = [
  {},
  { advance: 1 },
  { advance: 1, started: true },
  { advance: 2 },
  { done: true },
];

/**
 * Volume, always seeded: the queue tiers are uncapped apart from Up next and
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

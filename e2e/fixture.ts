import type {
  SeedMember,
  SeedOrder,
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
 * - `lead@m.com` is on every team: one login that sees every queue, maker
 *   and packer alike. It is fixture data, not `ADMIN_EMAILS` — that env var
 *   grants the better-auth admin role and is deliberately not coupled to a
 *   reseed.
 * - `m1@m.com` … `m6@m.com` are makers, one per item-workflow team in the
 *   order the teams are listed. `m7@m.com` is on two maker teams, the one
 *   login whose queue is grouped by team. `m8@m.com` is on no team ("no
 *   teams" on the members page and "not on a team yet" after sign-in).
 * - `p1@m.com` … `p3@m.com` are the packing side, one per team that owns an
 *   order-workflow step; `p4@m.com` is on two of them. Keeping them a
 *   separate series means "sign in as a packer" needs no lookup.
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
 * Invariants the ordinary write path enforces and the seed only checks in
 * part, so the fixture must honour them by construction:
 *
 * - At most one `type: "order"` entry, and no tags on it
 *   (`WorkflowRepository.replaceWorkflows` refuses both).
 * - A workflow with an unassigned step cannot be on; the seed defaults it
 *   off.
 *
 * Orders are written straight into the shop's object, bypassing Shopify, so
 * every lifecycle state a queue or order page can show exists without tagging
 * sandbox products. A populated queue from *real* orders additionally needs
 * the sandbox products tagged with the item-workflow tags by hand.
 */

export const LEAD = "lead@m.com";
const maker = (i: number) => `m${String(i)}@m.com`;
const packer = (i: number) => `p${String(i)}@m.com`;

// Maker teams, in `m1` … `m6` order.
const WOODSHOP = "Woodshop";
const ENGRAVING = "Engraving";
const LEATHER = "Leather";
const JEWELRY = "Jewelry";
const TEXTILES = "Textiles";
const FINISHING = "Finishing";
// Packing side, in `p1` … `p3` order.
const QC = "Quality check";
const PACKING = "Packing";
const SHIPPING = "Shipping";
export const RETIRED_TEAM_EMPTY = "Retired team (empty)";

export const members: readonly SeedMember[] = [
  LEAD,
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(maker),
  ...[1, 2, 3, 4].map(packer),
];

export const teams: readonly SeedTeam[] = [
  { name: WOODSHOP, members: [LEAD, maker(1)] },
  { name: ENGRAVING, members: [LEAD, maker(2), maker(7)] },
  { name: LEATHER, members: [LEAD, maker(3)] },
  { name: JEWELRY, members: [LEAD, maker(4)] },
  { name: TEXTILES, members: [LEAD, maker(5)] },
  { name: FINISHING, members: [LEAD, maker(6), maker(7)] },
  { name: QC, members: [LEAD, packer(1)] },
  { name: PACKING, members: [LEAD, packer(2), packer(4)] },
  { name: SHIPPING, members: [LEAD, packer(3), packer(4)] },
  // nobody on it: "No members" on the team page and on the steps it owns
  { name: RETIRED_TEAM_EMPTY, members: [] },
];

const step = (
  name: string,
  team: string | null,
  extra: Partial<Pick<SeedWorkflowStep, "stage" | "instructions">> = {},
): SeedWorkflowStep => ({ name, team, ...extra });

// Product tags the item workflows match on; `orders` below carry the same.
const TAG = {
  board: "engraved-cutting-board",
  journal: "leather-journal",
  ring: "signet-ring",
  blanket: "embroidered-blanket",
  frame: "photo-frame",
  petTag: "pet-tag",
  sample: "wholesale-sample",
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
    tags: [TAG.board],
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
    tags: [TAG.journal],
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
    tags: [TAG.ring],
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
    tags: [TAG.blanket],
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
    tags: [TAG.frame],
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
    tags: [TAG.petTag],
    steps: [step("Stamp", null), step("Attach ring", RETIRED_TEAM_EMPTY)],
  },
  {
    // zero steps: "No steps"
    name: "Wholesale sample (no steps)",
    tags: [TAG.sample],
    steps: [],
  },
  {
    // the order workflow singleton, on: an inspection, then packing and the
    // label in parallel, then the hand-off
    name: "Order workflow",
    type: "order",
    tags: [],
    steps: [
      step("Inspect", QC, {
        stage: 1,
        instructions:
          "Every item against the order. Personalization spelled right, no finish defects.",
      }),
      step("Pack", PACKING, { stage: 2 }),
      step("Print label", SHIPPING, { stage: 2 }),
      step("Hand to carrier", SHIPPING, { stage: 3 }),
    ],
  },
];

const item = (
  title: string,
  tag: string | null,
  quantity: number,
  personalization: Record<string, string> = {},
  extra: Partial<
    Pick<SeedOrder["lineItems"][number], "unfulfilledQuantity">
  > = {},
): SeedOrder["lineItems"][number] => ({
  title,
  quantity,
  tags: tag === null ? [] : [tag],
  customAttributes: Object.entries(personalization).map(([key, value]) => ({
    key,
    value,
  })),
  ...extra,
});

/**
 * One order per state a worker or the orders index can meet, oldest first
 * (the seed spaces them a second apart). Read down the list as a day on the
 * floor: new work, work under way, work waiting on packing, and the two
 * rows that need a person's attention.
 */
export const orders: readonly SeedOrder[] = [
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
];

export const fixture = { members, teams, workflows, orders } as const;

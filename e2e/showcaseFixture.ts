import type {
  SeedLineItem,
  SeedMember,
  SeedOrder,
  SeedProgress,
  SeedTeam,
  SeedWorkflow,
  SeedWorkflowTask,
} from "./seed.ts";

import {
  SHOWCASE_PRODUCTS,
  skuOf,
  type ShowcaseProduct,
} from "./showcaseProducts.ts";

/**
 * The showcase fixture, posted by `pnpm seed --showcase`
 * (`scripts/seed.ts`): the data the help's pictures are taken against. It is
 * the same fictional made-to-order gift workshop as the development fixture
 * (`e2e/fixture.ts`), with every name one a merchant would type: no team that
 * carries its own diagnosis, `ana@example.com` rather than `lead@m.com`, 40
 * open orders and two closed ones placed over the last ten days, newest
 * first, so the orders index reads like a working week.
 *
 * The development fixture stays the default of `pnpm seed`, and this one is
 * opt-in, because the kit page, the visual review and several JSDoc examples
 * lean on the development fixture's names and worst cases.
 *
 * Its products exist in the dev store: `pnpm showcase:store` writes them from
 * the table both modules import (`e2e/showcaseProducts.ts`), so an item's
 * title, variant, SKU and tags here match the product a merchant opens in
 * Shopify. Seeded orders are numbered from `#1201`, clear of the numbers
 * Shopify gives the store's real orders, so a search for one number finds one
 * row.
 *
 * `ana@example.com` is the member the member pictures are taken as: on two
 * teams, Engraving and Finishing, so her workflows list has a Team select.
 * Every member is on a team. `Weekend crew` has nobody ("No members"), and its
 * workflow, `Weekend engraving`, is the one with a "Team has no members"
 * fault. `Packing` has one member and is the team a screenshot pass deletes to
 * make "Needs a team": `Stamp and bind`'s last step is on it.
 */

const ANA = "ana@example.com";
const BEN = "ben@example.com";
const CARMEN = "carmen@example.com";
const DANA = "dana@example.com";
const ELI = "eli@example.com";
const FARAH = "farah@example.com";
const GUS = "gus@example.com";

const WOODSHOP = "Woodshop";
const ENGRAVING = "Engraving";
const LEATHER = "Leather";
const JEWELRY = "Jewelry";
const TEXTILES = "Textiles";
const FINISHING = "Finishing";
const PACKING = "Packing";
const WEEKEND_CREW = "Weekend crew";

export const members: readonly SeedMember[] = [
  ANA,
  BEN,
  CARMEN,
  DANA,
  ELI,
  FARAH,
  GUS,
];

export const teams: readonly SeedTeam[] = [
  { name: WOODSHOP, members: [BEN, DANA] },
  { name: ENGRAVING, members: [ANA, BEN, CARMEN] },
  { name: LEATHER, members: [CARMEN, ELI] },
  { name: JEWELRY, members: [FARAH] },
  { name: TEXTILES, members: [DANA] },
  { name: FINISHING, members: [ANA, ELI] },
  { name: PACKING, members: [GUS] },
  { name: WEEKEND_CREW, members: [] },
];

const product = (handle: string): ShowcaseProduct => {
  const found = SHOWCASE_PRODUCTS.find((entry) => entry.handle === handle);
  if (found === undefined) throw new Error(`no showcase product ${handle}`);
  return found;
};

const BOARD = product("engraved-cutting-board");
const JOURNAL = product("leather-journal");
const RING = product("signet-ring");
const BLANKET = product("embroidered-baby-blanket");
const CLOCK = product("wall-clock");
const FRAME = product("photo-frame");
const GIFT_SET = product("journal-and-pen-gift-set");
const GIFT_CARD = product("gift-card");

/** The one tag of a product a single workflow follows. */
const tagOf = (entry: ShowcaseProduct): string => {
  const [tag] = entry.tags;
  if (tag === undefined) throw new Error(`${entry.handle} has no tag`);
  return tag;
};

const WEEKEND_TAG = "weekend-engraving";

const task = (
  name: string,
  team: string,
  instructions: string,
  step?: number,
): SeedWorkflowTask => ({
  name,
  team,
  instructions,
  ...(step === undefined ? {} : { step }),
});

const EMBROIDER = task(
  "Embroider name",
  TEXTILES,
  "The name and thread colour are in the properties. Test the stitch on a scrap first.",
);
const FOLD_AND_WRAP = task(
  "Fold and wrap",
  FINISHING,
  "Steam out the creases, fold in thirds and wrap in tissue.",
);

export const workflows: readonly SeedWorkflow[] = [
  {
    name: "Cut, engrave and oil",
    tag: tagOf(BOARD),
    tasks: [
      task(
        "Cut and sand",
        WOODSHOP,
        "Cut to the size on the order. Sand to 220 grit and check the end grain for tear-out.",
      ),
      task(
        "Engrave",
        ENGRAVING,
        "The text is in the properties. Check the spelling against the order before running the laser.",
      ),
      task(
        "Oil and inspect",
        FINISHING,
        "Two coats of food-safe oil, 20 minutes apart. Look for rough spots in the light.",
      ),
    ],
  },
  {
    name: "Stamp and bind",
    tag: tagOf(JOURNAL),
    tasks: [
      task(
        "Cut cover",
        LEATHER,
        "Cut the cover from the marked hide, grain side up.",
      ),
      task(
        "Stamp initials",
        ENGRAVING,
        "The initials are in the properties. Centre them on the front cover.",
      ),
      task(
        "Bind",
        LEATHER,
        "Stitch the signatures to the spine and glue the cover on.",
      ),
      task(
        "Pack",
        PACKING,
        "Wrap in tissue and put it in a gift box with the card.",
      ),
    ],
  },
  {
    name: "Cast, engrave, polish",
    tag: tagOf(RING),
    tasks: [
      task(
        "Cast",
        JEWELRY,
        "Ring size and metal are in the properties. Cast one size up for finishing.",
      ),
      task(
        "Engrave crest",
        ENGRAVING,
        "The crest file is named after the order number.",
      ),
      task(
        "Polish",
        JEWELRY,
        "High polish unless the order says brushed. Check the size on the mandrel.",
      ),
    ],
  },
  {
    name: "Embroider and fold",
    tag: tagOf(BLANKET),
    tasks: [EMBROIDER, FOLD_AND_WRAP],
    draft: {
      tasks: [
        EMBROIDER,
        task(
          "Sew in care label",
          TEXTILES,
          "Sew the label into the bottom left seam.",
        ),
        FOLD_AND_WRAP,
      ],
    },
  },
  {
    name: "Clock assembly",
    tag: tagOf(CLOCK),
    tasks: [
      task(
        "Cut face",
        WOODSHOP,
        "Cut the face to 30 cm and drill the centre hole.",
        1,
      ),
      task(
        "Engrave numerals",
        ENGRAVING,
        "The numeral style is in the properties.",
        1,
      ),
      task(
        "Assemble",
        FINISHING,
        "Fit the movement and the hands, then check the time against a reference clock.",
        2,
      ),
    ],
  },
  {
    name: "Frame and glaze",
    state: "inactive",
    tag: tagOf(FRAME),
    tasks: [
      task("Cut mat", WOODSHOP, "Cut the mat to the frame size."),
      task("Glaze and fit", FINISHING, "Clean the glass and fit the backing."),
    ],
  },
  {
    name: "Gift set assembly",
    tag: "gift-set",
    tasks: [
      task(
        "Assemble set",
        FINISHING,
        "Put the journal and the pen in the gift box and tie the ribbon.",
      ),
    ],
  },
  {
    name: "Weekend engraving",
    tag: WEEKEND_TAG,
    tasks: [
      task(
        "Engrave",
        WEEKEND_CREW,
        "Weekend jobs are engraved on Saturday morning.",
      ),
    ],
  },
];

/** One line of an order: a showcase product's own title, variant, SKU and tags, with the properties the customer typed. */
const line = (
  entry: ShowcaseProduct,
  value: string,
  quantity: number,
  properties: Readonly<Record<string, string>> = {},
  extra: Partial<
    Pick<SeedLineItem, "currentQuantity" | "progress" | "workflow">
  > = {},
): SeedLineItem => {
  const sku = skuOf(entry, value);
  return {
    title: entry.title,
    variantTitle: value,
    ...(sku === null ? {} : { sku }),
    quantity,
    tags: entry.tags,
    properties: Object.entries(properties).map(([key, text]) => ({
      key,
      value: text,
    })),
    ...extra,
  };
};

const ENGRAVING_TEXT = "Engraving text";

/** An order before it has a number and a date; both come from its place in {@link orders}. */
type OrderSpec = Omit<SeedOrder, "n" | "placedDaysAgo">;

/**
 * Orders where nothing is closed, one group per kind in the table the
 * showcase is built from. Interleaved by {@link interleave} so the index does
 * not read as one kind after another.
 */
const notStarted: readonly OrderSpec[] = [
  {
    lineItems: [
      line(BOARD, "Maple", 1, { [ENGRAVING_TEXT]: "The Hendersons" }),
    ],
  },
  {
    lineItems: [
      line(BOARD, "Walnut", 2, { [ENGRAVING_TEXT]: "Ella and Marcus, 2024" }),
    ],
  },
  { lineItems: [line(JOURNAL, "Tan", 1, { Initials: "R.K.W." })] },
  { lineItems: [line(RING, "Silver", 1, { "Ring size": "9" })] },
  { lineItems: [line(BLANKET, "Cream", 1, { "Name to embroider": "Olivia" })] },
  { lineItems: [line(CLOCK, "Oak", 1, { Numerals: "Roman" })] },
  { lineItems: [line(JOURNAL, "Black", 1, { Initials: "T.B." })] },
  {
    lineItems: [
      line(GIFT_SET, "Tan", 1, {}, { workflow: "Gift set assembly" }),
    ],
  },
];

const startedByAna: readonly OrderSpec[] = [
  {
    lineItems: [
      line(
        BOARD,
        "Maple",
        1,
        { [ENGRAVING_TEXT]: "Grandma Rose" },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        JOURNAL,
        "Tan",
        1,
        { Initials: "S.A.L." },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        RING,
        "Gold",
        1,
        { "Ring size": "7" },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        BOARD,
        "Walnut",
        1,
        { [ENGRAVING_TEXT]: "Home sweet home" },
        { progress: { advance: 2, started: true, by: ANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        BLANKET,
        "Sage",
        1,
        { "Name to embroider": "Theodore" },
        { progress: { advance: 1, started: true, by: ANA } },
      ),
    ],
  },
];

const startedBy = (
  by: string,
  entry: ShowcaseProduct,
  value: string,
  properties: Readonly<Record<string, string>>,
  progress: SeedProgress = {},
): OrderSpec => ({
  lineItems: [
    line(entry, value, 1, properties, {
      progress: { started: true, ...progress, by },
    }),
  ],
});

const startedByOthers: readonly OrderSpec[] = [
  startedBy(
    BEN,
    BOARD,
    "Walnut",
    { [ENGRAVING_TEXT]: "Welcome" },
    { advance: 1 },
  ),
  startedBy(
    BEN,
    BOARD,
    "Maple",
    { [ENGRAVING_TEXT]: "The Parks" },
    { advance: 1 },
  ),
  startedBy(CARMEN, JOURNAL, "Black", { Initials: "M.J." }, { advance: 1 }),
  startedBy(FARAH, RING, "Silver", { "Ring size": "6" }),
  startedBy(DANA, BLANKET, "Cream", { "Name to embroider": "Ava" }),
  startedBy(BEN, CLOCK, "Walnut", { Numerals: "Arabic" }),
  startedBy(CARMEN, JOURNAL, "Tan", { Initials: "D.L.H." }, { advance: 2 }),
  startedBy(
    ELI,
    BOARD,
    "Maple",
    { [ENGRAVING_TEXT]: "Bon appétit" },
    { advance: 2 },
  ),
];

const betweenSteps = (
  by: string,
  entry: ShowcaseProduct,
  value: string,
  properties: Readonly<Record<string, string>>,
  advance: number,
): OrderSpec => ({
  lineItems: [line(entry, value, 1, properties, { progress: { advance, by } })],
});

const makingBetweenSteps: readonly OrderSpec[] = [
  betweenSteps(BEN, BOARD, "Maple", { [ENGRAVING_TEXT]: "Nana's kitchen" }, 1),
  betweenSteps(ELI, BOARD, "Walnut", { [ENGRAVING_TEXT]: "Cheers" }, 2),
  betweenSteps(CARMEN, JOURNAL, "Tan", { Initials: "P.N." }, 1),
  betweenSteps(FARAH, RING, "Silver", { "Ring size": "8" }, 1),
  // The journals at the last step, Pack: the ones that need a team when Packing is deleted.
  betweenSteps(CARMEN, JOURNAL, "Black", { Initials: "C.O." }, 3),
  betweenSteps(CARMEN, JOURNAL, "Tan", { Initials: "J.F." }, 3),
];

const blocked: readonly OrderSpec[] = [
  {
    lineItems: [
      line(
        BOARD,
        "Walnut",
        1,
        { [ENGRAVING_TEXT]: "Smith family" },
        {
          progress: {
            advance: 1,
            by: ANA,
            blocked:
              "The board has a crack along the grain. Asked for a new blank.",
          },
        },
      ),
    ],
  },
  {
    lineItems: [
      line(
        RING,
        "Gold",
        1,
        { "Ring size": "10" },
        {
          progress: {
            advance: 1,
            byMerchant: true,
            blocked:
              "The customer is changing the crest. Waiting for the new file.",
          },
        },
      ),
    ],
  },
];

const made: readonly OrderSpec[] = [
  {
    lineItems: [
      line(
        BOARD,
        "Maple",
        1,
        { [ENGRAVING_TEXT]: "Fresh bread" },
        { progress: { done: true, by: ELI } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        BLANKET,
        "Cream",
        1,
        { "Name to embroider": "Noah" },
        { progress: { done: true, by: DANA } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        JOURNAL,
        "Black",
        1,
        { Initials: "A.B." },
        { progress: { done: true, by: CARMEN } },
      ),
    ],
  },
  {
    lineItems: [
      line(
        RING,
        "Silver",
        1,
        { "Ring size": "7" },
        { progress: { done: true, by: FARAH } },
      ),
      line(
        BLANKET,
        "Sage",
        1,
        { "Name to embroider": "Ivy" },
        { progress: { done: true, by: DANA } },
      ),
    ],
  },
];

const oddOnes: readonly OrderSpec[] = [
  // two workflows match: the Multiple workflows match card, No workflow on
  // the index
  { lineItems: [line(GIFT_SET, "Black", 1)] },
  // nothing to attach: a gift card alone (No workflow), and beside a board
  // (Not started, by the board's run)
  { lineItems: [line(GIFT_CARD, "$50", 1)] },
  {
    lineItems: [
      line(GIFT_CARD, "$25", 1),
      line(BOARD, "Maple", 1, { [ENGRAVING_TEXT]: "Merry Christmas" }),
    ],
  },
  // unpaid: no runs are made until it is paid, so Unpaid on the index
  {
    unpaid: true,
    lineItems: [line(BOARD, "Walnut", 1, { [ENGRAVING_TEXT]: "Thank you" })],
  },
  // three items in three states, with an order note, SKUs, properties and a run note
  {
    note: "Gift for Sam's wedding on the 14th. Please pack everything in one box.",
    lineItems: [
      line(
        BOARD,
        "Walnut",
        1,
        { [ENGRAVING_TEXT]: "Sam and Priya, 14 October" },
        {
          progress: {
            advance: 1,
            started: true,
            by: ANA,
            note: "Customer confirmed the spelling of Priya by email.",
          },
        },
      ),
      line(
        JOURNAL,
        "Tan",
        1,
        { Initials: "S.P." },
        { progress: { done: true, by: ELI } },
      ),
      line(CLOCK, "Oak", 1, { Numerals: "Roman" }),
    ],
  },
];

/** The four ways an order closes, placed longest ago so they sit at the bottom of the index. */
const closed: readonly OrderSpec[] = [
  {
    fulfillmentStatus: "UNFULFILLED",
    after: { fulfillmentStatus: "FULFILLED" },
    lineItems: [
      line(
        BOARD,
        "Maple",
        1,
        { [ENGRAVING_TEXT]: "Happy retirement" },
        { progress: { done: true, by: ELI } },
      ),
    ],
  },
  {
    after: { cancelled: true },
    lineItems: [
      line(
        JOURNAL,
        "Tan",
        1,
        { Initials: "G.H." },
        { progress: { advance: 1, by: CARMEN } },
      ),
    ],
  },
  {
    after: { lineItems: [{ position: 2, currentQuantity: 0 }] },
    lineItems: [
      line(
        BLANKET,
        "Sage",
        1,
        { "Name to embroider": "Leo" },
        { progress: { advance: 1, by: DANA } },
      ),
      line(
        RING,
        "Silver",
        1,
        { "Ring size": "8" },
        { progress: { advance: 1, by: FARAH } },
      ),
    ],
  },
  {
    after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
    lineItems: [
      line(
        BOARD,
        "Walnut",
        2,
        { [ENGRAVING_TEXT]: "Cabin" },
        { progress: { advance: 1, by: BEN } },
      ),
    ],
  },
];

/** Takes one from each group in turn, so kinds are spread through the index. */
const interleave = <T>(groups: readonly (readonly T[])[]): readonly T[] => {
  const longest = Math.max(...groups.map((group) => group.length));
  return Array.from({ length: longest }, (_unused, index) =>
    groups.flatMap((group) => {
      const entry = group[index];
      return entry === undefined ? [] : [entry];
    }),
  ).flat();
};

const specs: readonly OrderSpec[] = [
  ...closed,
  ...interleave([
    notStarted,
    startedByAna,
    startedByOthers,
    makingBetweenSteps,
    blocked,
    made,
    oddOnes,
  ]),
];

/** Numbered from `#1201` upward, oldest first; placed ten days ago for the first, today for the last. */
export const orders: readonly SeedOrder[] = specs.map((spec, index) => ({
  ...spec,
  n: 1201 + index,
  placedDaysAgo: Math.floor(
    ((specs.length - 1 - index) * 10) / (specs.length - 1),
  ),
}));

export const fixture = { members, teams, workflows, orders } as const;

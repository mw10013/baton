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
 * Naming is the point: every row reads back to its entry by eye.
 *
 * - Ordinal `NN` (zero-padded so ten sorts after nine) is the join key across
 *   kinds: `member-NN@shop.com` is the member of `Team NN`, which owns the
 *   first step of `Workflow NN`, which is selected by product tag
 *   `workflow-NN`.
 * - `admin@shop.com` is on every active team: one login that sees every queue.
 *   It is fixture data, not `ADMIN_EMAILS` — that env var grants the
 *   better-auth admin role and is deliberately not coupled to a reseed.
 * - Linear steps are `Step N` (N = position). Steps that share a stage are
 *   `Step Na`, `Step Nb` (N = stage): the queue card shows the step name but
 *   not the stage, so the letter is the only thing telling a worker two cards
 *   are siblings.
 * - Order workflows are `Order Workflow NN`, their own sequence, no tags.
 * - Archived rows carry an `Archived` suffix. A real merchant would not rename
 *   before archiving, but this is not demo data: archived rows surface on
 *   screens with no badge (a step whose team is archived just shows no team,
 *   an archived member appears as an actor on a completed step), and the
 *   suffix is what makes those readings unambiguous.
 *
 * Invariants the ordinary write path enforces and the seed only checks in
 * part, so the fixture must honour them by construction:
 *
 * - An archived team may own steps only in archived workflows
 *   (`ShopAgent.archiveTeam` refuses otherwise). `Team 07 Archived` owns a step
 *   in `Workflow 07 Archived` and nowhere else.
 * - At most one non-archived order workflow, and no tags on any order
 *   workflow (`WorkflowRepository.replaceWorkflows` refuses both).
 * - Archived members and teams are archived after their membership edges are
 *   written (`setTeamMember` refuses archived rows); the seed route orders
 *   that itself.
 *
 * Definitions only. Runs come from synced orders whose line items carry a
 * matching tag, so a populated queue also needs the sandbox products tagged
 * `workflow-01` … `workflow-06` by hand in the admin. One archived state cannot
 * be seeded at all: an archived member who has *worked*. Sign in as
 * `member-09@shop.com` before archiving, start a step, then archive.
 */

const ordinal = (i: number) => String(i).padStart(2, "0");
const member = (i: number) => `member-${ordinal(i)}@shop.com`;
const team = (i: number) => `Team ${ordinal(i)}`;

export const ADMIN = "admin@shop.com";
export const TEAM_07_ARCHIVED = `${team(7)} Archived`;

/** Members of `Team 01` … `Team 06`; each is the sole ordinary member of theirs. */
const ACTIVE_ORDINALS = [1, 2, 3, 4, 5, 6] as const;

export const members: readonly SeedMember[] = [
  ADMIN,
  ...ACTIVE_ORDINALS.map(member),
  member(7), // active member whose only team is archived → "no teams"
  member(8), // never added to a team
  { email: member(9), archived: true }, // archived, still on active Team 01
  { email: member(10), archived: true }, // archived, on the archived team
];

export const teams: readonly SeedTeam[] = [
  ...ACTIVE_ORDINALS.map((i) => ({
    name: team(i),
    members: [ADMIN, member(i), ...(i === 1 ? [member(9)] : [])],
  })),
  {
    name: TEAM_07_ARCHIVED,
    members: [member(7), member(10)],
    archived: true,
  },
];

/** Step owner by ordinal; 7 is the archived team, whose name carries the suffix. */
const owner = (i: number) => (i === 7 ? TEAM_07_ARCHIVED : team(i));

const step = (
  name: string,
  teamOrdinal: number,
  extra: Partial<Pick<SeedWorkflowStep, "stage" | "instructions">> = {},
): SeedWorkflowStep => ({ name, team: owner(teamOrdinal), ...extra });

const instructions = (name: string) => `Instructions for ${name}`;

/**
 * Every active team owns steps in at least two workflows so no queue is
 * single-workflow, and every hand-off crosses a team boundary. Each workflow
 * is a distinct shape so the editor, queue, and order page each have one row
 * per case to look at.
 */
export const workflows: readonly SeedWorkflow[] = [
  {
    // minimal linear
    name: "Workflow 01",
    tags: ["workflow-01"],
    steps: [step("Step 1", 1), step("Step 2", 2)],
  },
  {
    // three-step linear
    name: "Workflow 02",
    tags: ["workflow-02"],
    steps: [step("Step 1", 2), step("Step 2", 3), step("Step 3", 4)],
  },
  {
    // one parallel stage in the middle; the first team returns at the end
    name: "Workflow 03",
    tags: ["workflow-03"],
    steps: [
      step("Step 1", 3, { stage: 1 }),
      step("Step 2a", 4, { stage: 2 }),
      step("Step 2b", 5, { stage: 2 }),
      step("Step 3", 3, { stage: 3 }),
    ],
  },
  {
    // parallel first stage, three wide
    name: "Workflow 04",
    tags: ["workflow-04"],
    steps: [
      step("Step 1a", 4, { stage: 1 }),
      step("Step 1b", 5, { stage: 1 }),
      step("Step 1c", 6, { stage: 1 }),
      step("Step 2", 1, { stage: 2 }),
    ],
  },
  {
    // instructions on every step
    name: "Workflow 05",
    tags: ["workflow-05"],
    steps: [
      step("Step 1", 5, { instructions: instructions("Step 1") }),
      step("Step 2", 6, { instructions: instructions("Step 2") }),
    ],
  },
  {
    // two parallel stages, mixed instructions
    name: "Workflow 06",
    tags: ["workflow-06"],
    steps: [
      step("Step 1", 6, { stage: 1 }),
      step("Step 2a", 1, { stage: 2, instructions: instructions("Step 2a") }),
      step("Step 2b", 2, { stage: 2 }),
      step("Step 3a", 3, { stage: 3 }),
      step("Step 3b", 4, { stage: 3 }),
    ],
  },
  {
    // archived; the only place the archived team may own a step
    name: "Workflow 07 Archived",
    archived: true,
    tags: ["workflow-07"],
    steps: [step("Step 1", 7), step("Step 2", 1)],
  },
  {
    // zero steps: "not routing" without being archived
    name: "Workflow 08",
    tags: ["workflow-08"],
    steps: [],
  },
  {
    // the active order workflow, with a stage inside an order run
    name: "Order Workflow 01",
    scope: "order",
    tags: [],
    steps: [
      step("Step 1", 1, { stage: 1 }),
      step("Step 2a", 2, { stage: 2 }),
      step("Step 2b", 3, { stage: 2 }),
    ],
  },
  {
    // archived order workflow; restoring it must be refused while 01 is active
    name: "Order Workflow 02 Archived",
    scope: "order",
    archived: true,
    tags: [],
    steps: [step("Step 1", 2)],
  },
];

/**
 * Orders written straight into the shop's object, bypassing Shopify, so the
 * lifecycle states show without tagging sandbox products. `#9001` has one of
 * two units refunded (`unfulfilledQuantity` below `currentQuantity`), so its
 * run and the order page read "×1 to make". `#9002` is fully made and still
 * unfulfilled, so the Ready-to-ship filter has a row. `#9003` is in
 * production with nothing special.
 */
export const orders: readonly SeedOrder[] = [
  {
    n: 9001,
    note: "One unit refunded after ordering",
    lineItems: [
      {
        title: "Product 01",
        quantity: 2,
        currentQuantity: 2,
        unfulfilledQuantity: 1,
        tags: ["workflow-01"],
        customAttributes: [{ key: "Engraving", value: "Seed 9001" }],
      },
    ],
  },
  {
    n: 9002,
    done: true,
    lineItems: [
      { title: "Product 01", quantity: 1, tags: ["workflow-01"] },
      { title: "Product 02", quantity: 1, tags: ["workflow-02"] },
    ],
  },
  {
    n: 9003,
    lineItems: [
      { title: "Product 03", quantity: 3, tags: ["workflow-03"] },
      { title: "Untagged", quantity: 1, tags: [] },
    ],
  },
];

export const fixture = { members, teams, workflows, orders } as const;

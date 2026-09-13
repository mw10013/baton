/**
 * Local endpoint URL from `PORT` in `.env` and the shop domain derived from
 * `SHOPIFY_PREVIEW_URL` in `.env.playwright` (`/store/<handle>/…` →
 * `<handle>.myshopify.com`).
 */
export interface SeedConfig {
  readonly appUrl: string;
  readonly shop: string;
}

export const seedConfig = (): SeedConfig => {
  const port = process.env.PORT;
  const preview = process.env.SHOPIFY_PREVIEW_URL;
  const handle =
    preview && URL.canParse(preview)
      ? new URL(preview).pathname.split("/")[2]
      : undefined;
  if (!port || !handle)
    throw new Error(
      "Seed e2e requires PORT in .env plus SHOPIFY_PREVIEW_URL in .env.playwright.",
    );
  return {
    appUrl: `http://localhost:${port}`,
    shop: `${handle}.myshopify.com`,
  };
};

/** A member to seed, by email. */
export type SeedMember = string;

/** A team to create, plus which of the seeded `members` belong to it; an empty list seeds "No members". */
export interface SeedTeam {
  readonly name: string;
  readonly members: readonly string[];
}

/**
 * A step of a seeded workflow; `team` names one of the seeded `teams`, or is
 * `null` to seed the step unassigned. A step with no `stage` follows the
 * previous one; give several steps the same `stage` to make them ready
 * together.
 */
export interface SeedWorkflowStep {
  readonly name: string;
  readonly team: string | null;
  readonly stage?: number;
  readonly instructions?: string;
}

/** A line item of a seeded order; `tags` are the product tags a workflow matches on. Quantities default down the chain `quantity` → `currentQuantity` → `unfulfilledQuantity`. */
export interface SeedLineItem {
  readonly title: string;
  readonly quantity: number;
  readonly currentQuantity?: number;
  readonly unfulfilledQuantity?: number;
  readonly tags: readonly string[];
  readonly customAttributes?: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
}

/**
 * An order to seed; `n` becomes `#n`. `done` completes every run it routes
 * to. `advance` completes that many rounds of ready steps instead (item runs
 * first; the order run only once every item is made), `started` then Starts
 * whatever is ready, and `blocked` flags every open run with that reason.
 */
export interface SeedOrder {
  readonly n: number;
  readonly fulfillmentStatus?: string;
  readonly unpaid?: boolean;
  readonly done?: boolean;
  readonly advance?: number;
  readonly started?: boolean;
  readonly blocked?: string;
  readonly note?: string;
  readonly lineItems: readonly SeedLineItem[];
}

/** A workflow definition to create, steps inline and in order. `type: "order"` describes the shop's one order workflow (fixed name; `tags: []`) rather than creating one. */
export interface SeedWorkflow {
  readonly name: string;
  readonly type?: "item" | "order";
  /** On/off switch; defaults to on when there are steps and every step is assigned. */
  readonly active?: boolean;
  readonly tags: readonly string[];
  /** The workflow's steps; may be empty. */
  readonly steps: readonly SeedWorkflowStep[];
  /** A pending draft beside the workflow; `tags` default to the workflow's. */
  readonly draft?: {
    readonly tags?: readonly string[];
    readonly steps: readonly SeedWorkflowStep[];
  };
}

/**
 * Seeds via `/api/dev/seed` (`src/routes/api.dev.seed.ts`): replaces the shop's
 * members with exactly `members`, its teams with exactly `teams`, and its
 * workflow definitions with exactly `workflows`, and drops the better-auth
 * identity of each listed email, so every run signs in as a first-time user and
 * a Playwright retry starts from identical state. Call at the start of any test
 * that depends on membership, team, workflow, or session state — no cleanup
 * needed.
 *
 * Omitting `workflows` still clears the shop's definitions: the seed is
 * destructive in every dimension it covers, so a test that says nothing about
 * workflows gets none rather than the previous test's.
 *
 * The seed writes over the app's own HTTP origin, not the admin tunnel, so it
 * works identically from the embedded and member projects.
 */
export const seedMembers = async (
  config: SeedConfig,
  members: readonly SeedMember[],
  teams: readonly SeedTeam[] = [],
  workflows: readonly SeedWorkflow[] = [],
  orders: readonly SeedOrder[] = [],
): Promise<void> => {
  const response = await fetch(`${config.appUrl}/api/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      shop: config.shop,
      members,
      teams,
      workflows,
      orders,
    }),
  });
  if (!response.ok)
    throw new Error(
      `seed failed: ${String(response.status)} ${await response.text()}`,
    );
};

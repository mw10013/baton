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

/**
 * Progress for one seeded run. `done` completes every step; `advance`
 * completes that many rounds of ready steps instead (`done` and `advance`
 * together are refused); `started` then Starts whatever is ready; `blocked`
 * flags the run with that reason. `byMerchant` records the completions and the
 * block as the merchant instead of the seed member, which is the fixture for
 * what a worker sees after an intervention; `started` stays the member's
 * either way.
 */
export interface SeedProgress {
  readonly done?: boolean;
  readonly advance?: number;
  readonly started?: boolean;
  readonly blocked?: string;
  readonly byMerchant?: boolean;
}

/** A line item of a seeded order; `tags` are the product tags a workflow matches on. `currentQuantity` defaults to `quantity`. */
export interface SeedLineItem {
  readonly title: string;
  readonly quantity: number;
  readonly currentQuantity?: number;
  readonly tags: readonly string[];
  readonly customAttributes?: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  /** This item's run alone; the order's own progress keys are ignored for it. */
  readonly progress?: SeedProgress;
  /**
   * One of the seeded `workflows`, by name, set on the item as the merchant's
   * Choose / Change does: it resolves an item two workflows claim, or attaches
   * one where no tag matched. Applied before progress, so the run it creates
   * is one the rounds below then advance.
   */
  readonly workflow?: string;
}

/**
 * A second state for the order, written after progress, so its runs come to
 * carry the flags only a change that lands *after* work started can produce:
 * `order_cancelled`, `order_fulfilled`, `quantity_changed`, `item_removed`.
 * `lineItems` are addressed by 1-based position in the order's own
 * `lineItems`, and a quantity left out keeps what the first write gave it.
 */
export interface SeedOrderChange {
  readonly cancelled?: boolean;
  readonly fulfillmentStatus?: string;
  readonly lineItems?: readonly {
    readonly position: number;
    readonly currentQuantity?: number;
  }[];
}

/**
 * An order to seed; `n` becomes `#n`. The order's own progress keys apply to
 * every run on it that its line item does not override with a `progress` of
 * its own, which is how one order's items end up in different states.
 */
export interface SeedOrder extends SeedProgress {
  readonly n: number;
  readonly fulfillmentStatus?: string;
  readonly unpaid?: boolean;
  readonly note?: string;
  readonly lineItems: readonly SeedLineItem[];
  readonly after?: SeedOrderChange;
}

/** A workflow definition to create, steps inline and in order. */
export interface SeedWorkflow {
  readonly name: string;
  /** On/off switch; defaults to on when there are steps and every step is assigned. */
  readonly active?: boolean;
  /** The workflow's one tag; products carrying it follow this workflow. */
  readonly tag: string;
  /** The workflow's steps; may be empty. */
  readonly steps: readonly SeedWorkflowStep[];
  /** A pending draft beside the workflow; the tag is not drafted. */
  readonly draft?: { readonly steps: readonly SeedWorkflowStep[] };
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
 *
 * It also closes every member socket the previous fixture left open, because
 * the `Member` rows those connections were authorized against are gone — so a
 * page under test reacts to the new fixture instead of acting on the old one.
 *
 * `keepIdentities` keeps the better-auth session of each listed email alive
 * across the re-seed, so a spec that re-seeds per test can sign in once and
 * replay the cookie jar instead of paying a magic-link round trip each time.
 * Leave it off wherever a test wants a first-time user.
 */
export const seedMembers = async (
  config: SeedConfig,
  members: readonly SeedMember[],
  teams: readonly SeedTeam[] = [],
  workflows: readonly SeedWorkflow[] = [],
  orders: readonly SeedOrder[] = [],
  options: { readonly keepIdentities?: boolean } = {},
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
      ...(options.keepIdentities === undefined
        ? {}
        : { keepIdentities: options.keepIdentities }),
    }),
  });
  if (!response.ok)
    throw new Error(
      `seed failed: ${String(response.status)} ${await response.text()}`,
    );
};

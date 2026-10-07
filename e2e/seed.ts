import type * as Domain from "@/lib/Domain";

import { devShop, localUrl } from "./devStore";

/** The local endpoint and the shop to seed, from {@link localUrl} and {@link devShop}. */
export interface SeedConfig {
  readonly appUrl: string;
  readonly shop: string;
}

export const seedConfig = (): SeedConfig => ({
  appUrl: localUrl(),
  shop: devShop(),
});

/** A member to seed, by email. */
export type SeedMember = string;

/** A team to create, plus which of the seeded `members` belong to it; an empty list seeds "No members". */
export interface SeedTeam {
  readonly name: string;
  readonly members: readonly string[];
}

/**
 * A task of a seeded workflow; `team` names one of the seeded `teams`, or is
 * `null` to seed the task unassigned. A task with no `step` follows the
 * previous one; give several tasks the same `step` to make them current
 * together.
 */
export interface SeedWorkflowTask {
  readonly name: string;
  readonly team: string | null;
  readonly step?: number;
  readonly instructions?: string;
}

/**
 * Progress for one seeded run. `done` marks every task done; `advance`
 * marks that many rounds of current tasks done instead (`done` and `advance`
 * together are refused); `started` then Starts whatever is ready; `blocked`
 * blocks the run with that reason. `byMerchant` records those Dones and the
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
  /**
   * The email of the seeded member who starts, does or blocks, in place of the
   * first member; refused (400) for an email the fixture did not seed. The
   * member need not be on the task's team.
   */
  readonly by?: string;
  /** The run's note, written last (a note records no author). Only on an item's `progress`: an order's own `note` is the order note. */
  readonly note?: string;
  /** Last, Cancel workflow as the merchant: the run closes (`merchant_cancelled`), keeps its tasks, and nothing starts on the item. */
  readonly cancelled?: boolean;
}

/** An item of a seeded order; `tags` are the product tags a workflow matches on. `currentQuantity` defaults to `quantity`. */
export interface SeedLineItem {
  readonly title: string;
  /** Left out is `null`, as Shopify sends an item with one variant. */
  readonly variantTitle?: string;
  readonly sku?: string;
  readonly quantity: number;
  readonly currentQuantity?: number;
  readonly tags: readonly string[];
  readonly properties?: readonly {
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
 * A second state for the order, written after progress, so its runs end up as
 * only a change that lands *after* work started can leave them: closed
 * (`order_cancelled`, `fulfilled`, `item_removed`) or resized with the
 * quantity badge.
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
 * every run on it that its item does not override with a `progress` of
 * its own, which is how one order's items end up in different states.
 */
export interface SeedOrder extends Omit<SeedProgress, "note"> {
  readonly n: number;
  readonly fulfillmentStatus?: string;
  readonly unpaid?: boolean;
  /** Whole days before now that the order was placed; left out is today, and it stays under the retention age. */
  readonly placedDaysAgo?: number;
  readonly note?: string;
  readonly lineItems: readonly SeedLineItem[];
  readonly after?: SeedOrderChange;
}

/** A workflow definition to create, tasks inline and in order. */
export interface SeedWorkflow {
  readonly name: string;
  /** The switch; defaults to active when there are tasks and every task is assigned. */
  readonly state?: Domain.WorkflowState;
  /** The workflow's one tag; products carrying it follow this workflow. */
  readonly tag: string;
  /** The workflow's tasks; may be empty. */
  readonly tasks: readonly SeedWorkflowTask[];
  /** A pending draft beside the workflow; the tag is not drafted. */
  readonly draft?: { readonly tasks: readonly SeedWorkflowTask[] };
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

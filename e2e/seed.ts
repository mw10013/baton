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

/** A member to seed; a bare string is active, the object form can archive. */
export type SeedMember =
  | string
  | { readonly email: string; readonly archived: boolean };

/** A team to create, plus which of the seeded `members` belong to it. */
export interface SeedTeam {
  readonly name: string;
  readonly members: readonly string[];
}

/** A step of a seeded workflow; `team` names one of the seeded `teams`. */
export interface SeedWorkflowStep {
  readonly name: string;
  readonly team: string;
}

/** A workflow definition to create, steps inline and in order. */
export interface SeedWorkflow {
  readonly name: string;
  readonly tags: readonly string[];
  readonly steps: readonly SeedWorkflowStep[];
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
): Promise<void> => {
  const response = await fetch(`${config.appUrl}/api/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shop: config.shop, members, teams, workflows }),
  });
  if (!response.ok)
    throw new Error(
      `seed failed: ${String(response.status)} ${await response.text()}`,
    );
};

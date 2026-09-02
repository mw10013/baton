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

/** A team to create, plus which of the seeded `members` belong to it. */
export interface SeedTeam {
  readonly name: string;
  readonly members: readonly string[];
}

/**
 * Seeds membership via `/api/e2e/seed` (`src/routes/api.e2e.seed.ts`): replaces
 * the shop's members with exactly `members` and its teams with exactly `teams`,
 * and drops the better-auth identity of each listed email, so every run signs
 * in as a first-time user and a Playwright retry starts from identical state.
 * Call at the start of any test that depends on membership, team, or session
 * state — no cleanup needed.
 *
 * The seed writes over the app's own HTTP origin, not the admin tunnel, so it
 * works identically from the embedded and member projects.
 */
export const seedMembers = async (
  config: SeedConfig,
  members: readonly string[],
  teams: readonly SeedTeam[] = [],
): Promise<void> => {
  const response = await fetch(`${config.appUrl}/api/e2e/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shop: config.shop, members, teams }),
  });
  if (!response.ok)
    throw new Error(
      `seed failed: ${String(response.status)} ${await response.text()}`,
    );
};

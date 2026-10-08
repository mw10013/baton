import { spawnSync } from "node:child_process";

/**
 * Dev server ready: the run's `globalSetup`, before any project. Asks
 * `scripts/dev.ts status --json` whether the dev server answers on its port,
 * whether the tunnel the admin embeds through is reachable, and whether the
 * shop has its `ShopSession` row, which `/api/dev/seed` needs (it refuses a
 * shop with no session, 409) and `pnpm dev:start` creates by installing the
 * app. Each failure names the fix.
 *
 * It replaced the setup project's "shopify app installed" test, which booted
 * the admin (8 to 10 s per run) only to check a row `dev:start` already
 * guarantees, and which every project that seeds relied on through
 * Playwright's config-order rule rather than a dependency. A dead tunnel now
 * fails the run in one line instead of in every embedded test. It is a
 * `globalSetup` rather than a test in the `setup` project because the member,
 * admin and public projects need the server too, and depending on `setup`
 * would run "shopify admin auth" before them, which prompts for Keychain
 * access whenever the exported session is stale.
 */
export default function preflight(): void {
  /* `status` exits 1 when unhealthy and still prints the JSON. */
  const { stdout, stderr } = spawnSync(
    "node",
    ["--env-file=.env", "scripts/dev.ts", "status", "--json"],
    { encoding: "utf8" },
  );
  const status = ((): {
    readonly answering?: boolean;
    readonly tunnel?: string;
    readonly shopSession?: boolean;
  } => {
    try {
      return JSON.parse(stdout) as object;
    } catch {
      throw new Error(
        `dev server ready: scripts/dev.ts status --json printed no status; run pnpm dev:start\n${stderr}`,
      );
    }
  })();
  const problems = [
    status.answering === true
      ? null
      : "the dev server does not answer on its port; run pnpm dev:start",
    status.tunnel === "reachable"
      ? null
      : "the tunnel is not reachable; restart with pnpm dev:stop && pnpm dev:start",
    status.shopSession === true
      ? null
      : "the shop has no ShopSession, so seeding is refused; run pnpm dev:start to install the app",
  ].filter((problem) => problem !== null);
  if (problems.length > 0)
    throw new Error(`dev server ready: ${problems.join("; ")}`);
}

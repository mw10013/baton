import { defineConfig } from "@playwright/test";
import path from "path";

import { localUrl, previewUrl } from "./e2e/devStore";

export const storageStatePath = path.join(
  process.cwd(),
  "playwright",
  ".auth",
  "shopify-admin.json",
);

try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch (_error) {
  void _error;
}

/**
 * The E2E suite. Each practice is stated on the helper that enforces it; this
 * comment is the index.
 *
 * - Interaction gate: nothing fills or clicks before `awaitHydration`
 *   (`e2e/hydration.ts`). Specs reach it through `gotoApp` (`e2e/app.ts`, the
 *   embedded app) and `gotoMember` (`e2e/member.ts`, `/shop`, `/login`,
 *   `/admin`). A hand-driven `playwright-cli` session waits on the same
 *   `body[data-hydrated="true"]` selector.
 * - Frames: the embedded app and the workflow editor are separate iframes,
 *   reached through `appFrame` and `editorFrame` (`e2e/app.ts`).
 * - Admin session: the `setup` project exports Chrome's Shopify cookies
 *   through `refreshShopifyAuth` (`scripts/lib/shopify-playwright-auth.ts`),
 *   which also documents how that export fails. Before a run, open the store's
 *   admin in a normal Chrome window.
 * - Data: each spec seeds the exact shape its assertions compute through
 *   `e2e/seed.ts`. `e2e/fixture.ts` is the shared shop for `pnpm seed` and
 *   manual exploration, not for specs.
 * - Projects: listed below, each with its reason. `pnpm test:e2e` runs e2e,
 *   member and admin headless; billing runs only through
 *   `pnpm test:e2e:billing`.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./playwright/test-results",
  // Embedded Shopify app cold starts can exceed Playwright's 5s default assertion timeout.
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "./playwright/report" }]],
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: ["**/*.setup.ts"],
      use: {
        channel: "chrome",
        baseURL: previewUrl(),
      },
    },
    {
      name: "e2e",
      testMatch: ["**/*.spec.ts"],
      testIgnore: [
        "**/*.admin.spec.ts",
        "**/*.member.spec.ts",
        "**/*.billing.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        channel: "chrome",
        baseURL: previewUrl(),
        storageState: storageStatePath,
      },
    },
    /**
     * The member area (`/shop/*`) is the one part of the app that is NOT
     * embedded: `BETTER_AUTH_URL` in `.env` points at `http://localhost:$PORT`,
     * so the magic link a member follows never touches the admin tunnel. Hence
     * a project of its own — no `setup` dependency (nothing here needs a
     * Shopify admin session, so a run never prompts for Keychain access) and no
     * `storageState`, because the whole point is that a member with zero
     * Shopify cookies can sign in. It still seeds through the app, which
     * needs a `ShopSession`: the `setup` project's "shopify app installed"
     * test creates one, and runs first because Playwright takes the projects
     * with no dependencies in config order under `workers: 1`.
     */
    {
      name: "member",
      testMatch: ["**/*.member.spec.ts"],
      use: {
        channel: "chrome",
        baseURL: localUrl(),
        storageState: { cookies: [], origins: [] },
      },
    },
    /**
     * The operator console (`/admin/*`) is served straight off
     * `http://localhost:$PORT` like the member area below, and signs in through
     * the same magic-link flow, so it gets the member project's shape: no
     * `setup` dependency and empty storage state.
     */
    {
      name: "admin",
      testMatch: ["**/*.admin.spec.ts"],
      use: {
        channel: "chrome",
        baseURL: localUrl(),
        storageState: { cookies: [], origins: [] },
      },
    },
    /**
     * Plan switching drives Shopify's hosted pricing page, which sits behind a
     * Cloudflare bot check that challenges a headless browser and cannot be
     * solved programmatically. So this project is never selected by
     * `test:e2e` (headless, the routine run); it runs only through
     * `test:e2e:billing`, headed, by hand, and not in a loop, because the check
     * also fires after several plan changes in a short window. `headless:
     * false` is set here as well so a bare `--project=billing` does not walk
     * into the challenge. Each spec mutates the shared dev store's real
     * subscription and restores it in `finally`.
     */
    {
      name: "billing",
      testMatch: ["**/*.billing.spec.ts"],
      dependencies: ["setup"],
      use: {
        channel: "chrome",
        headless: false,
        baseURL: previewUrl(),
        storageState: storageStatePath,
      },
    },
  ],
});

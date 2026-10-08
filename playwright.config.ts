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
 * The E2E suite. Each practice is stated on the helper that holds its
 * reasoning; this comment is the index, one line per practice.
 *
 * - Interaction gate: `awaitHydration` (`e2e/hydration.ts`), reached through
 *   `gotoApp` (`e2e/app.ts`) and `gotoMember` (`e2e/member.ts`); a
 *   hand-driven `playwright-cli` session waits on the same selector.
 * - Frames: `appFrame` and `editorFrame` (`e2e/app.ts`), the app's iframe and
 *   the workflow editor's.
 * - Hoisted controls: `clickHoisted`, `hoistedEnabled` and `closeDevConsole`
 *   (`e2e/app.ts`): the admin's DOM, the native click, and the overlay that
 *   defeats it.
 * - Polaris controls: by role and name, never by host tag; Playwright's
 *   actionability is enough (`e2e/member.ts` header, `hostTagLocatorHits`
 *   in `scripts/lib/rules-lint.ts`).
 * - The editor window: `openEditor` and `closeEditor`
 *   (`e2e/workflows.spec.ts`), the one known flake and its retry.
 * - One admin boot per embedded spec: `openApp` (`e2e/app.ts`), serial mode;
 *   `openScreen` opens a screen bare and waits out its loaders
 *   (`awaitNavigated` in `e2e/hydration.ts`).
 * - Admin session: the `setup` project, through `refreshShopifyAuth`
 *   (`scripts/lib/shopify-playwright-auth.ts`).
 * - Preflight: "dev server ready" (`e2e/preflight.ts`), the `globalSetup`.
 * - Data: each spec seeds what its assertions compute (`e2e/seed.ts`);
 *   `e2e/fixture.ts` is for `pnpm seed`, not for specs.
 * - Timeouts: this config holds them; a test that sets its own says why.
 * - Projects: below, in run order, cheap first, each with its reason.
 *   `pnpm test:e2e` runs public, admin, member and e2e headless and stops
 *   after three failures; billing runs only through `pnpm test:e2e:billing`.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/preflight.ts",
  // A test that needs longer sets its own with `test.setTimeout` and says why.
  timeout: 60_000,
  outputDir: "./playwright/test-results",
  // Embedded Shopify app cold starts can exceed Playwright's 5s default assertion timeout.
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "./playwright/report" }]],
  use: {
    trace: "on-first-retry",
    // Without these a click on a missing element waits out the whole test timeout.
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
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
    /**
     * The public help (`/help/*`) needs no session of any kind: served off
     * `http://localhost:$PORT` like the member area, with empty storage state
     * and no `setup` dependency, and it reads no shop data, so it seeds
     * nothing.
     */
    {
      name: "public",
      testMatch: ["**/*.public.spec.ts"],
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
     * The member area (`/shop/*`) is the one part of the app that is NOT
     * embedded: `BETTER_AUTH_URL` in `.env` points at `http://localhost:$PORT`,
     * so the magic link a member follows never touches the admin tunnel. Hence
     * a project of its own — no `setup` dependency (nothing here needs a
     * Shopify admin session, so a run never prompts for Keychain access) and no
     * `storageState`, because the whole point is that a member with zero
     * Shopify cookies can sign in. It still seeds through the app, which
     * needs a `ShopSession`; the preflight (`e2e/preflight.ts`) refuses the
     * run before any project when there is none.
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
    {
      name: "e2e",
      testMatch: ["**/*.spec.ts"],
      testIgnore: [
        "**/*.admin.spec.ts",
        "**/*.member.spec.ts",
        "**/*.billing.spec.ts",
        "**/*.public.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        channel: "chrome",
        baseURL: previewUrl(),
        storageState: storageStatePath,
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

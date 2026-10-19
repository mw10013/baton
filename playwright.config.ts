import { defineConfig, devices } from "playwright/test";
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import process from "node:process";

import { e2ePortOf } from "./scripts/lib/worktree.ts";

process.loadEnvFile(".env");
const websitePort = Number(process.env.WEBSITE_PORT);
if (!Number.isInteger(websitePort))
  throw new Error("WEBSITE_PORT is not set; copy .env.example to .env");
/** The e2e server's port: above the dev server's, as the server's own script computes it. */
const port = e2ePortOf(websitePort);
/**
 * The e2e server's own URL. The dev client and the install's fixture load use it in every
 * project, because the `embedded` and `install` projects' `baseURL` is the Shopify admin.
 */
export const e2eServerURL = `http://localhost:${port}`;
/** Where the Shopify admin cookie export lives; it holds a login, so it stays under `playwright/.auth/`. */
export const storageStatePath = "playwright/.auth/shopify-admin.json";

const AppHandleLine = Schema.TemplateLiteralParser(['handle = "', Schema.String, '"']);
const decodeAppHandleLine = Schema.decodeUnknownOption(AppHandleLine);

/** The app's handle, from the `handle = "…"` line of `shopify.app.toml`, as `scripts/dev.ts` reads `client_id`. */
const appHandle = () =>
  Option.getOrThrowWith(
    Array.findFirst(readFileSync("shopify.app.toml", "utf8").split("\n"), (line) =>
      Option.map(decodeAppHandleLine(line.trim()), ([, handle]) => handle),
    ),
    () => new Error('shopify.app.toml has no handle = "<app handle>" line'),
  );

/** The app inside the e2e store's admin, where the `embedded` project opens it. */
const embeddedURL = () => {
  const store = process.env.SHOPIFY_E2E_STORE;
  if (!store) throw new Error("SHOPIFY_E2E_STORE is not set; see .env.example");
  return `https://admin.shopify.com/store/${store}/apps/${appHandle()}/app`;
};

/**
 * The browser settings of a project that opens the app inside the e2e store's admin: real Chrome,
 * under the exported Shopify admin login.
 */
const embeddedUse = () => ({
  channel: "chrome",
  baseURL: embeddedURL(),
  storageState: storageStatePath,
  actionTimeout: 10_000,
  navigationTimeout: 30_000,
});

/**
 * Runs the e2e specs against the e2e server (`scripts/e2e-server.ts`): Shopify CLI on this
 * checkout's e2e store, serving the e2e stage on its own port. The server script destroys the
 * stage before starting it, so every run begins from the seed alone. The setup chain then opens
 * the app in the store (`install`, which also loads the e2e fixture), signs each role in
 * (`setup`), and only then starts the specs. A reused server keeps the last run's sessions and
 * actor state, though `install` replaces the fixture's rows, so reuse is opt-in for iterating
 * (`E2E_REUSE_SERVER=1`). The top-level `use.baseURL` is set explicitly because Playwright
 * derives it only from the deprecated `webServer.port`.
 */
export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/preflight.ts",
  outputDir: "playwright/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { outputFolder: "playwright/report" }]] : "list",
  use: { baseURL: e2eServerURL, trace: "on-first-retry" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, dependencies: ["install"] },
    {
      name: "chromium",
      testIgnore: ["**/embedded/**", "**/*.billing.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    { name: "shopify-admin", testMatch: /shopify-admin\.setup\.ts/ },
    {
      name: "install",
      testMatch: /install\.setup\.ts/,
      dependencies: ["shopify-admin"],
      use: embeddedUse(),
    },
    {
      name: "embedded",
      testMatch: "**/embedded/**/*.spec.ts",
      testIgnore: "**/*.billing.spec.ts",
      // Not `shopify-admin`: the install's load and this project's first load would exchange
      // tokens on the one session row at once.
      dependencies: ["install"],
      // Per-file serial mode and one admin boot per file; files must not share a worker's page.
      fullyParallel: false,
      // One store row serves every embedded spec: a load in one file exchanges a token, which
      // would break the refresh spec's steps mid-run if two files ran at once.
      workers: 1,
      timeout: 60_000,
      expect: { timeout: 10_000 },
      use: embeddedUse(),
    },
    // Shopify's pricing page challenges a headless browser, so the plan switch runs headed, by
    // hand and not in a loop: only `vp run test:e2e:billing` (which sets `E2E_BILLING`) defines
    // the project, so a plain run cannot pick it up.
    ...(process.env.E2E_BILLING === "1"
      ? [
          {
            name: "billing",
            testMatch: "**/*.billing.spec.ts",
            // `setup` (which follows `install`) signs the admin in for the shop page's half.
            dependencies: ["setup"],
            fullyParallel: false,
            workers: 1,
            timeout: 360_000,
            expect: { timeout: 10_000 },
            use: embeddedUse(),
          },
        ]
      : []),
  ],
  webServer: {
    command: "vp run test:e2e:server",
    url: `${e2eServerURL}/`,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
  },
});

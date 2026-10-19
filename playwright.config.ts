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

/** The timeouts and browser `embedded` and `refresh` share. */
const embeddedProject = {
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: embeddedUse(),
};

/**
 * Runs the e2e specs against this checkout's long-lived e2e server (`vp run e2e:start`,
 * `scripts/e2e.ts`): Shopify CLI on the checkout's e2e store, serving the e2e stage on its own
 * port. Playwright does not start it, and a run reuses it as it is; the preflight (`globalSetup`)
 * fails the run in one line when it is not running or its tunnel does not serve. The setup chain
 * then opens the app in the store (`install`, which also loads the e2e fixture, replacing the
 * shop's members, teams, workflows and orders from the last run), signs each role in (`setup`),
 * and only then starts the specs. `vp run e2e:restart` is the clean slate.
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
      testIgnore: ["**/*.billing.spec.ts", "**/refresh.spec.ts"],
      // Behind `install`, not just `shopify-admin`: the install's load and a first load here would
      // both exchange a token on the one session row. Also behind `setup`, which `chromium`
      // depends on, so the two projects sit at one depth and Playwright runs them at once.
      dependencies: ["install", "setup"],
      // Per-file serial mode and one admin boot per file; files must not share a worker's page.
      fullyParallel: false,
      // Loads reuse the stored token, so files can run side by side; only `refresh` ages the
      // session row, and it runs alone after this project. Each spec asserts on its own rows only,
      // since the others (and `chromium`) write the same shop meanwhile.
      workers: 4,
      ...embeddedProject,
    },
    {
      name: "refresh",
      testMatch: "**/embedded/refresh.spec.ts",
      // After `embedded` and so after `chromium` too (one depth deeper than both): it expires
      // and invalidates the session row, and any load beside it would exchange a fresh token.
      dependencies: ["embedded"],
      fullyParallel: false,
      workers: 1,
      ...embeddedProject,
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
});

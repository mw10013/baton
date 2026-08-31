import { defineConfig } from "@playwright/test";
import path from "path";

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

try {
  process.loadEnvFile(path.join(process.cwd(), ".env.playwright"));
} catch (_error) {
  void _error;
}

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
        baseURL: process.env.SHOPIFY_PREVIEW_URL,
      },
    },
    {
      name: "e2e",
      testMatch: ["**/*.spec.ts"],
      dependencies: ["setup"],
      use: {
        channel: "chrome",
        baseURL: process.env.SHOPIFY_PREVIEW_URL,
        storageState: storageStatePath,
      },
    },
  ],
});

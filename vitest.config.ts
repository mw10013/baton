import { defineConfig } from "vitest/config";

/**
 * `pnpm test` runs both projects. The integration project runs inside
 * workerd (`test/integration/vitest.config.ts`); the browser project runs
 * React hooks and components in headless Chromium
 * (`test/browser/vitest.config.ts`), which is the only place a test can read
 * or set `document`. Each project owns its own test options: Vitest inherits
 * only global options (reporters, coverage, globalSetup) from this file.
 *
 * The projects are inline `extends` entries, not file paths: a file entry is
 * rooted at its own directory, and the TanStack Start plugin resolves its
 * entries from that root, so it would look for `src/` under `test/`.
 */
export default defineConfig({
  test: {
    projects: [
      { extends: "./test/integration/vitest.config.ts" },
      { extends: "./test/browser/vitest.config.ts" },
    ],
  },
});

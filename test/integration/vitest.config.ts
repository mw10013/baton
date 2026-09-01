import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
/* oxlint-disable */
import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const rootDir = path.resolve(import.meta.dirname, "../..");
  const migrationsPath = path.join(rootDir, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    root: rootDir,
    plugins: [
      cloudflareTest({
        main: "./src/test-worker.ts",
        remoteBindings: false,
        wrangler: {
          configPath: path.join(rootDir, "wrangler.jsonc"),
        },
        miniflare: {
          /**
           * `wrangler.jsonc` holds placeholders for the Partner ids and keeps
           * `BILLING_ENABLED` off, so the values that make the real code paths
           * reachable are supplied here rather than in the deployed config.
           * Billing is deliberately ON under test: `SubscriptionPlan`'s cache,
           * revalidation, and boundary-clamp logic are what
           * `subscription-plan.test.ts` covers, and the shipped `false` would
           * short-circuit all of it.
           */
          bindings: {
            TEST_MIGRATIONS: migrations,
            SHOPIFY_API_KEY: "test_api_key",
            SHOPIFY_API_SECRET: "test_api_secret",
            SHOPIFY_APP_URL: "https://example.com",
            SHOPIFY_PARTNER_ORG_ID: "1",
            SHOPIFY_PARTNER_APP_ID: "1",
            SHOPIFY_PARTNER_API_TOKEN: "test_partner_token",
            BILLING_ENABLED: "true",
            ADMIN_AUTH_SECRET: "test_admin_auth_secret",
            ADMIN_PASSWORD: "test_admin_password",
            ADMIN_PASSWORD1: "test_admin_password1",
            BETTER_AUTH_URL: "http://localhost",
            BETTER_AUTH_SECRET: "test_better_auth_secret",
            DEMO_MODE: "true",
          },
          durableObjects: {
            TEST_SQL_DO: {
              className: "TestSqlMigrationsDO",
              useSQLite: true,
            },
          },
        },
      }),
      tsconfigPaths({
        projects: [path.join(rootDir, "tsconfig.json")],
      }),
      tanstackStart(),
      viteReact({
        babel: {
          plugins: [
            ["@babel/plugin-proposal-decorators", { version: "2023-11" }],
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.join(rootDir, "src"),
      },
    },
    test: {
      // TanStack server-fn RPC helpers read `process.env.TSS_SERVER_FN_BASE` at
      // runtime when building their request URL, so the worker test env must
      // inject it for direct RPC calls used by integration tests.
      env: {
        TSS_SERVER_FN_BASE: process.env.TSS_SERVER_FN_BASE ?? "/_serverFn/",
      },
      include: ["test/integration/*.test.ts"],
      setupFiles: ["test/apply-migrations.ts"],
      testTimeout: 30000,
    },
  };
});

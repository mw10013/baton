import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import process from "node:process";
import { test as setup } from "playwright/test";

import { storageStatePath } from "../../playwright.config.ts";
import { exportShopifyAdminAuth } from "../../scripts/lib/agent-chrome.ts";

/**
 * Exports the agent Chrome's Shopify login for the embedded projects on every run: it is a live
 * read of about a second, so no copy on disk is ever trusted stale.
 */
setup("shopify admin auth", async () => {
  setup.setTimeout(60_000);
  const store = process.env.SHOPIFY_E2E_STORE;
  if (!store) throw new Error("SHOPIFY_E2E_STORE is not set; see .env.example");
  await Effect.runPromise(
    exportShopifyAdminAuth({ output: storageStatePath, store }).pipe(
      Effect.tap((count) => Console.log(`Wrote ${String(count)} cookies to ${storageStatePath}`)),
      Effect.provide(NodeServices.layer),
    ),
  );
});

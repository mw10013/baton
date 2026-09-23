import * as NodeServices from "@effect/platform-node/NodeServices";
import { test as setup } from "@playwright/test";
import { Console, Effect } from "effect";
import * as fs from "node:fs";

import { storageStatePath } from "../playwright.config";
import {
  adminSessionFresh,
  chromeProfile,
  refreshShopifyAuth,
} from "../scripts/lib/shopify-playwright-auth.ts";
import { gotoApp } from "./app";

/**
 * Whether the export on disk is still worth using, judged by the cookie it
 * holds and by the file's own age (`adminSessionFresh`): a fresh export avoids
 * a Keychain prompt. This does not validate server-side revocation; the
 * embedded tests still exercise the real session.
 */
const adminSessionValid = (): boolean => {
  try {
    const { cookies } = JSON.parse(
      fs.readFileSync(storageStatePath, "utf8"),
    ) as {
      cookies: readonly {
        name: string;
        domain: string;
        expires: number;
      }[];
    };
    return adminSessionFresh(cookies, fs.statSync(storageStatePath).mtimeMs);
  } catch {
    return false;
  }
};

/**
 * Call the shared effect directly so cancellation reaches the Keychain process
 * and scoped files. Its 150-second deadline fits inside the test timeout and
 * includes a separate 120-second bound for approving a Keychain prompt.
 */
setup("shopify admin auth", async () => {
  setup.setTimeout(180_000);
  if (adminSessionValid()) {
    fs.chmodSync(storageStatePath, 0o600);
    return;
  }
  await Effect.runPromise(
    refreshShopifyAuth({
      output: storageStatePath,
      profile: chromeProfile(),
    }).pipe(
      Effect.tap((count) =>
        Console.log(`Wrote ${count.toString()} cookies to ${storageStatePath}`),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});

/**
 * Opens the app once under the exported session so the shop's `ShopSession`
 * row exists before anything seeds. `/api/dev/seed` refuses a shop with no
 * session (409), and after `pnpm d1:reset` the only thing that creates one is
 * the embedded app loading in the admin. The `member` and `admin` projects
 * seed without depending on this project (see `playwright.config.ts`), and
 * with `workers: 1` Playwright runs the projects with no dependencies in
 * config order, so this project's tests finish before their first seed.
 */
setup("shopify app installed", async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStatePath });
  try {
    await gotoApp(await context.newPage());
  } finally {
    await context.close();
  }
});

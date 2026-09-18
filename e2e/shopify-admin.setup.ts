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

/**
 * Check the exported admin cookie's actual expiry rather than assuming a fixed
 * session lifetime. Fresh exports avoid Keychain access. This does not validate
 * server-side revocation; the embedded tests still exercise the real session.
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
    return adminSessionFresh(cookies);
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

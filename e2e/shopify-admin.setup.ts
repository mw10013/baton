import { test as setup } from "@playwright/test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";

import { storageStatePath } from "../playwright.config";

/**
 * True when the exported storage state still carries a live admin session.
 * `koa.sid` (admin.shopify.com) is the gate: it is the actual admin session
 * cookie with a ~1 week lifetime, while the accounts.shopify.com identity
 * cookies live ~1 year. In the window where identity is valid but `koa.sid`
 * is expired, admin bounces to the accounts "Choose an account" screen — the
 * app iframe never loads, `data-hydrated` never appears, and specs die as
 * mystery 30s timeouts misattributed to hydration. The 5-minute buffer keeps
 * a session from expiring mid-run.
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
    const koa = cookies.find(
      ({ domain, name }) =>
        domain === "admin.shopify.com" && name === "koa.sid",
    );
    return (
      !!koa &&
      (koa.expires === -1 || koa.expires * 1000 > Date.now() + 5 * 60_000)
    );
  } catch {
    return false;
  }
};

/**
 * Validate-first / validate-after auth refresh, not a blind export.
 *
 * Fast path: if the existing export's `koa.sid` is still valid, do nothing —
 * no Keychain access, silent. Otherwise shell out to the refresh script,
 * which decrypts the logged-in session from Chrome's cookie database (macOS
 * Keychain may prompt for "Chrome Safe Storage" — click Always Allow; the
 * 3-minute timeout leaves room for that click). Re-validating after the
 * export matters because a blind refresh of a logged-out Chrome happily
 * exports expired cookies and reproduces the same obscure bounce; failing
 * here converts it into an instant, actionable error instead.
 *
 * Runs as the `setup` Playwright project, so the e2e project's contexts (a
 * declared dependency) always load the refreshed state.
 */
setup("shopify admin auth", () => {
  setup.setTimeout(180_000);
  if (adminSessionValid()) return;
  execSync("node scripts/refresh-shopify-playwright-auth.ts", {
    stdio: "inherit",
  });
  if (!adminSessionValid())
    throw new Error(
      `Stale Shopify admin session in ${storageStatePath} even after refresh: log into https://admin.shopify.com in Chrome (Default profile), then rerun.`,
    );
});

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { e2eServerURL } from "../../playwright.config.ts";
import { loadFixtureWhenInstalled } from "../../scripts/lib/load-fixture.ts";
import { gotoApp } from "./embedded/app.ts";
import { test as setup } from "./fixtures.ts";
import { E2E_SHOP, e2eFixture } from "./shop-fixture.ts";

/**
 * Installs the app on the e2e store and loads the e2e fixture, once, before any spec: the
 * embedded load's token exchange writes the shop's `ShopSession`, which `LoadFixture` needs. One
 * test, so setup's parallelism cannot split the load from the install. The fixture wait fits
 * inside the test's timeout.
 *
 * It is also the suite's one plan check: an e2e store with no app subscription sends `/app` to
 * Shopify's plan selection page, so the load never hydrates, and every spec would fail the same
 * way. Here it fails once, saying what to do.
 */
setup("install the app and load the e2e fixture", async ({ page }) => {
  setup.setTimeout(60_000);
  await gotoApp(page).catch((error: unknown) => {
    if (page.url().includes("/pricing_plans"))
      throw new Error(
        `pick a plan on ${E2E_SHOP.replace(/\.myshopify\.com$/u, "")} (docs/shopify-stores-runbook.md)`,
      );
    throw error;
  });
  await Effect.runPromise(
    loadFixtureWhenInstalled(`${e2eServerURL}/api/dev`, E2E_SHOP, e2eFixture, Duration.seconds(30)),
  );
});

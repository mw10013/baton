import type { Browser, Locator } from "playwright/test";

import { gotoApp } from "../../../scripts/lib/embedded-app.ts";
import { storageStatePath } from "../../../playwright.config.ts";

export {
  appFrame,
  awaitHydration,
  closeDevConsole,
  gotoApp,
} from "../../../scripts/lib/embedded-app.ts";

/**
 * Opens the embedded app once for a whole spec file: a context under the exported admin session,
 * one page, and {@link gotoApp}. Call it from `beforeAll` in a file set to serial mode, and close
 * the context in `afterAll`. One boot per file, because the boot (seconds, through the tunnel) is
 * the cost; serial mode is what makes the shared page safe, and after a failure Playwright skips
 * the rest of the file because the page may be in any state.
 */
export const openApp = async (browser: Browser) => {
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  return { context, page, frame: await gotoApp(page) };
};

/** Whether a hoisted title-bar control is there and enabled: App Bridge mirrors `disabled` onto it. */
export const hoistedEnabled = async (locator: Locator): Promise<boolean> =>
  (await locator.count()) > 0 &&
  locator.evaluate(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true",
  );

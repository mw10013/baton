import type { Browser, FrameLocator, Locator, Page } from "playwright/test";
import { expect, test } from "playwright/test";

import { awaitHydration, gotoApp as gotoAdminApp } from "../../../scripts/lib/embedded-app.ts";
import { storageStatePath } from "../../../playwright.config.ts";
import { reportLoad, watchFrameRequests } from "./frame-requests.ts";

export { appFrame, awaitHydration, closeDevConsole } from "../../../scripts/lib/embedded-app.ts";

/**
 * {@link gotoAdminApp} under {@link watchFrameRequests}: a load that does not hydrate fails with
 * the frame's pending requests and console attached by {@link reportLoad}.
 */
export const gotoApp = async (page: Page, path = ""): Promise<FrameLocator> => {
  watchFrameRequests(page);
  const since = Date.now();
  const frame = await gotoAdminApp(page, path).catch(async (error: unknown) => {
    await reportLoad(page, test.info(), since, false);
    throw error;
  });
  await reportLoad(page, test.info(), since, true);
  return frame;
};

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

/**
 * The editor's `s-app-window` iframe, which the admin mounts beside the app's own frame rather
 * than inside it. `appFrame` excludes it, so the two never collide.
 */
export const editorFrame = (page: Page): FrameLocator =>
  page.frameLocator('iframe[src*="chrome=window"]');

/** Whether a hoisted title-bar control is there and enabled: App Bridge mirrors `disabled` onto it. */
export const hoistedEnabled = async (locator: Locator): Promise<boolean> =>
  (await locator.count()) > 0 &&
  locator.evaluate(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true",
  );

/**
 * Clicks a hoisted title-bar control once it is visible and {@link hoistedEnabled}, with a native
 * DOM click. App Bridge can place the proxy under an `aria-disabled` ancestor that never clears,
 * and Playwright then reads every descendant as disabled and refuses `.click()`; a native click
 * on a control that is still disabled is a silent no-op, so enabled is polled first.
 */
export const clickHoisted = async (locator: Locator) => {
  await expect(locator).toBeVisible();
  await expect.poll(() => hoistedEnabled(locator)).toBe(true);
  await locator.evaluate((el) => {
    (el as HTMLElement).click();
  });
};

/**
 * The editor's Close: the X in the header the admin draws around an `s-app-window`, scoped to
 * the element that holds the window's iframe and that header, because the CLI's Dev Console and
 * Sidekick answer to "Close" too (the admin does not mark the window a `dialog`, so no dialog
 * role scopes it). Returns once the window's iframe is gone: an Edit pressed while the admin
 * animates the window out opens nothing.
 */
export const closeEditor = async (page: Page) => {
  await page
    .locator('iframe[src*="chrome=window"]')
    .locator("xpath=ancestor::*[.//button][1]")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator('iframe[src*="chrome=window"]')).toHaveCount(0);
};

/**
 * The workflow page's Edit, which opens the editor window, returning once the window's document
 * is hydrated. The click is retried until the window's iframe appears: after `closeEditor` the
 * admin rebuilds the page's hoisted title bar, and the Edit proxy reads enabled before App
 * Bridge has rewired it to the in-frame `s-button`, so a click in that window is a silent no-op.
 */
export const openEditor = async (page: Page) => {
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await expect(async () => {
    await edit.click();
    await expect(page.locator('iframe[src*="chrome=window"]')).toBeAttached({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await awaitHydration(editorFrame(page));
};

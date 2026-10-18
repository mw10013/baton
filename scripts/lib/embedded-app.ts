import type { FrameLocator, Page } from "playwright";

/**
 * The embedded app's iframe: its `src` carries `embedded=1`; the Shopify admin's own chrome is the
 * top-level `page`. Re-resolved on every call on purpose: App Bridge re-renders the iframe during
 * navigation, so a captured `contentFrame()` handle detaches and throws, where a `frameLocator`
 * never does. `embedded=1` alone is not unique: an open `s-app-window` is a second embedded
 * iframe carrying it, and every locator built on that fails with a strict mode violation, so
 * `chrome=window` is excluded to keep this the app's own frame.
 */
export const appFrame = (page: Page): FrameLocator =>
  page.frameLocator('iframe[src*="embedded=1"]:not([src*="chrome=window"])');

/**
 * Waits until the document in `scope` is safe to interact with: the `data-hydrated` marker on
 * `<body>`, which flips in the commit that clears the body's `inert`. Playwright's actionability
 * is inert-blind, so a click inside an inert subtree passes every check and is silently
 * swallowed by the browser.
 */
export const awaitHydration = (scope: Page | FrameLocator, timeout?: number): Promise<void> =>
  scope.locator("body[data-hydrated]").waitFor({ state: "attached", timeout });

/**
 * Collapses the Shopify CLI's Dev Console panel if it is expanded. The panel is an admin-document
 * overlay over the lower half of the viewport that outranks the app's iframe in the top
 * document's hit test, so a click Playwright finds actionable inside the frame lands on the
 * console instead, and silently: the action reports success and the app never sees the event.
 * Whether it is expanded comes from the Shopify admin session the storage state was exported from, so it
 * varies between machines and runs; it is closed here rather than left to whoever opened it last.
 *
 * Expansion is read from the panel's geometry, not the toggle: the button keeps the name "Close
 * Dev Console" in both states and has no `aria-expanded`, so an unconditional click would
 * expand a collapsed console every other run. Collapsing slides the "Dev Console" heading below
 * the viewport. No heading means no console (a production-like admin), and nothing to do.
 */
export const closeDevConsole = async (page: Page): Promise<void> => {
  const heading = page.getByRole("heading", { name: "Dev Console" }).first();
  if ((await heading.count()) === 0) return;
  const expanded = () =>
    heading.evaluate((el) => el.getBoundingClientRect().bottom < globalThis.innerHeight);
  if (!(await expanded())) return;
  await page.getByRole("button", { name: "Close Dev Console" }).evaluate((el) => {
    (el as HTMLElement).click();
  });
  await page.waitForFunction(
    (el) => el === null || el.getBoundingClientRect().bottom >= globalThis.innerHeight,
    await heading.elementHandle(),
    { timeout: 5_000 },
  );
};

/**
 * Waits until the embedded app is safe to interact with, including after a CLI navigation.
 *
 * One wait, no reload: a cold load through the tunnel requests some 250 unbundled modules and
 * hydrates in about 3 s (5 s at the 90th percentile), so a frame that is not hydrated after 15 s is
 * stuck on a request that will never finish, and a reload only hides which one. The stall once
 * absorbed here was Alchemy's dev proxy cutting large `Connection: close` responses short, which
 * the Shopify CLI's proxy then held open forever; `patches/@alchemy.run__cloudflare-runtime*` fixes it.
 */
export const prepareApp = async (page: Page): Promise<FrameLocator> => {
  const frame = appFrame(page);
  await awaitHydration(frame, 15_000);
  await closeDevConsole(page);
  return frame;
};

/**
 * Shopify immediately redirects to re-run the embed handshake. Waiting for `"load"` can abort
 * navigation; `"commit"` resolves before that redirect and {@link prepareApp} gates interaction.
 */
export const gotoApp = async (page: Page, path = ""): Promise<FrameLocator> => {
  await page.goto(path, { waitUntil: "commit" });
  return prepareApp(page);
};

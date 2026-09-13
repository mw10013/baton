import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

import { awaitHydration } from "./hydration";

/**
 * The embedded app's iframe — its `src` carries `embedded=1` (admin chrome is the
 * top-level `page`). Re-resolved on every call on purpose: App Bridge re-renders
 * the iframe during navigation/mutations, so a captured `page.frames()` /
 * `contentFrame()` handle detaches and throws `frame was detached`; a
 * `frameLocator` never does.
 *
 * `embedded=1` alone is no longer unique: an open `s-app-window` is a second
 * embedded iframe carrying it too, and every locator built on this one then
 * fails with `strict mode violation: ... resolved to 2 elements`. Excluding
 * `chrome=window` keeps this the app's own frame; see `editorFrame`.
 */
export const appFrame = (page: Page): FrameLocator =>
  page.frameLocator('iframe[src*="embedded=1"]:not([src*="chrome=window"])');

/**
 * The workflow editor's iframe. The editor opens in an App Bridge
 * `s-app-window`: a full-screen iframe the admin mounts as a SIBLING of the
 * app's own, not a child of it, so nothing in the editor is reachable through
 * `appFrame`. It is identified by the `chrome=window` search flag the opener
 * puts on `src` (`src/lib/workflowEditorWindow.ts`) rather than by the admin's
 * generated iframe `name` or hashed class, neither of which is ours to rely on.
 *
 * Its title-bar controls (Apply changes, Discard changes, Close) hoist into
 * admin chrome like any page's, so those still go through `clickHoisted` — but
 * the modals they open render in THIS frame, not the app's.
 */
export const editorFrame = (page: Page): FrameLocator =>
  page.frameLocator('iframe[src*="chrome=window"]');

/**
 * Land on the authed home and return once it is safe to interact INSIDE the
 * iframe.
 *
 * The gate is `awaitHydration` (`e2e/hydration.ts`) against the iframe: the
 * `data-hydrated` marker on the embedded document's `<body>`, which flips in
 * the commit that clears its `inert`.
 *
 * Hoisted sidebar links do NOT need this — App Bridge lifts them into the
 * admin document, outside the inert body, and they render only after
 * hydration, so their visibility is itself the gate (see `clickHoisted`).
 *
 * `goto` uses `waitUntil: "commit"`, NOT the default `"load"`. A `goto` is bound
 * to one navigation and throws if that navigation is superseded before it
 * resolves. The Shopify admin SPA immediately client-redirects the
 * `/apps/<handle>` route to re-run the embed/auth handshake; under `"load"` that
 * redirect aborts the navigation we're still awaiting → `net::ERR_ABORTED` (a
 * long-standing intermittent flake — a trace caught the doc request dying ~77ms
 * in; the same bounce, landing a beat later, instead stalls the hydration wait
 * to its full timeout). `"commit"` resolves the instant the response commits,
 * before the SPA runs the redirect, so it can never be aborted. No readiness is
 * lost: unlike `goto`, the `awaitHydration` below is a retrying poll over the
 * live DOM, so it rides through the redirect and is the real gate.
 *
 * Local previews serve Vite's unbundled module graph (~186 requests/load)
 * through a Cloudflare quick tunnel. Individual module requests can remain
 * pending indefinitely, leaving the complete SSR page visible while the client
 * entry never reaches `hydrateRoot` and the hydration marker never appears —
 * the client entry is a dynamic import, so the waterfall runs after
 * `readyState=complete` and a stall has no page-level symptom. After 15s,
 * reload the admin document once to retry that module graph. Instrumented
 * healthy runs (2026-07-17) put the marker at 4.3–6.2s from goto, so 15s is
 * ~2.4× the healthy max, not a hedge. The second wait uses Playwright's
 * default operation timeout and is therefore bounded by the remaining per-test timeout
 * (each multi-load spec pins one via `test.setTimeout`; the global default
 * 30s would preempt this rescue and turn it into a "Target closed" error as
 * teardown closes the context).
 *
 * A missing marker is NOT always a hydration/tunnel problem: an expired
 * `koa.sid` admin session (~1-day lifetime) lands the run on the
 * accounts.shopify.com "Choose an account" screen — no app iframe, no marker,
 * same 30s-timeout signature, and the reload can't fix it. That mode is
 * handled upstream by `shopify-admin.setup.ts` (validates expiry,
 * auto-refreshes from Chrome). Deliberately not implemented here (revisit if
 * flakes persist): checking `page.url()` for `accounts.shopify.com` in the
 * catch to fail fast on any residual auth bounce, and a preflight that fails
 * fast when the dev server / quick tunnel is down (the tunnel URL rotates on
 * every `pnpm app:dev` restart).
 */
export async function gotoApp(page: Page): Promise<FrameLocator> {
  await page.goto("", { waitUntil: "commit" });
  const frame = appFrame(page);
  await awaitHydration(frame, 15_000).catch(async () => {
    await page.reload({ waitUntil: "commit" });
    await awaitHydration(frame);
  });
  await closeDevConsole(page);
  return frame;
}

/**
 * Collapses the Shopify CLI's Dev Console panel if it is expanded.
 *
 * The panel is an admin-document overlay covering the lower half of the
 * viewport, and it outranks the app's iframe in the top document's hit test.
 * A click Playwright considers actionable — visible, stable, on top *inside
 * the frame* — then lands on the console's extensions table instead, silently:
 * the action reports success and the app never sees the event (measured
 * 2026-09-12: a Cancel at page (796, 546) hit `table._ExtensionsTable_`).
 * Playwright's occlusion check cannot see this, because it runs in the frame
 * and the occluder is in the parent document.
 *
 * Whether it is expanded comes from the admin session the storage state was
 * exported from, so it varies between machines and runs — which is exactly why
 * it is closed here rather than left to whoever opened it last. Collapsed it
 * is a pill in the corner; nothing this suite drives sits under it.
 *
 * Expansion is read from the panel's own geometry, not from the toggle: the
 * button keeps the accessible name "Close Dev Console" in both states, so
 * clicking it unconditionally would expand a collapsed console every other
 * run. The class prefix is the CLI's own markup (a hashed CSS module), hence
 * the substring match and the no-op when nothing matches — a console that
 * renamed or vanished must not fail a suite that does not depend on it.
 */
const closeDevConsole = async (page: Page): Promise<void> => {
  const panel = page.locator('[class*="ExtensionsTable"]').first();
  if ((await panel.count()) === 0) return;
  /** Expanded means the panel's own rows are on screen, not just its pill. */
  const expanded = () =>
    panel.evaluate(
      (el) => el.getBoundingClientRect().bottom < globalThis.innerHeight,
    );
  if (!(await expanded())) return;
  await page
    .getByRole("button", { name: "Close Dev Console" })
    .evaluate((el) => {
      (el as HTMLElement).click();
    });
  await expect.poll(expanded).toBe(false);
};

/**
 * Whether a hoisted control is enabled. `toBeEnabled()` cannot answer this
 * for the same reason `clickHoisted` exists: the `aria-disabled` ancestor
 * App Bridge places the control under makes Playwright report every
 * descendant as disabled. Reads the element's own `disabled` state instead,
 * which is what the app's `disabled` prop drives — App Bridge mirrors it onto
 * the proxy as a real `disabled` attribute plus its own `aria-disabled`, so
 * both are checked. Resolves `false` while the element is absent so it
 * composes with `expect.poll`.
 */
export const hoistedEnabled = async (locator: Locator): Promise<boolean> =>
  (await locator.count()) > 0 &&
  locator.evaluate(
    (el) =>
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("aria-disabled") !== "true",
  );

/**
 * Click an App-Bridge-hoisted control (e.g. an `s-app-nav` link). App Bridge
 * lifts these OUT of the iframe into admin chrome, under an ancestor with
 * `aria-disabled="true"` that never clears. Playwright treats every descendant of
 * an `aria-disabled` ancestor as disabled, so `.click()` / `toBeEnabled()` time
 * out with "element is not enabled" — even though a human can click it. Assert
 * visibility (also the hydration gate: `s-app-nav` only renders post-hydration),
 * then fire a native DOM click.
 *
 * Pass a PAGE-scoped locator: the hoist moves the control out of the iframe, so
 * `frame.getByRole(...)` cannot see it. That split is also why the index pages
 * can show a title-bar create button and an identically named one in the empty
 * state without tripping strict mode — each locator sees exactly one of them.
 *
 * Visibility is NOT enough to click on: `hoistedEnabled` is polled first
 * because the proxy renders as soon as the page hydrates, while the app's own
 * `disabled` prop is still true. Several of these controls are disabled until
 * the `ShopAgent` socket identifies (`useShopAgent`), which takes the token
 * mint plus a connect and handshake after hydration. Measured 2026-09-12 on a
 * fresh open of the editor's `s-app-window`: hydrated at 1933ms from the Edit
 * click, Discard changes proxy visible at 1940ms, socket open at 2071ms,
 * identified and the proxy enabled at 2328ms — a ~390ms window where the
 * control is on screen and dead. A native `el.click()` on a disabled button is
 * a silent no-op, so without this the click reports success, nothing happens,
 * and the failure surfaces later at whatever the click was supposed to open.
 * This is the actionability guarantee an ordinary Playwright `.click()` gives
 * and the `aria-disabled` ancestor takes away.
 */
export async function clickHoisted(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() => hoistedEnabled(locator)).toBe(true);
  await locator.evaluate((el) => {
    (el as HTMLElement).click();
  });
}

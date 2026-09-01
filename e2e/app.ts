import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * The embedded app's iframe — its `src` carries `embedded=1` (admin chrome is the
 * top-level `page`). Re-resolved on every call on purpose: App Bridge re-renders
 * the iframe during navigation/mutations, so a captured `page.frames()` /
 * `contentFrame()` handle detaches and throws `frame was detached`; a
 * `frameLocator` never does.
 */
export const appFrame = (page: Page): FrameLocator =>
  page.frameLocator('iframe[src*="embedded=1"]');

/**
 * Land on the authed home and return once it is safe to interact INSIDE the
 * iframe.
 *
 * The gate is the `data-app-interactive` marker (`src/routes/app.tsx`),
 * which flips with the `useHydrated()` commit that also clears the wrapper's
 * `inert`. It is load-bearing because Playwright's actionability is inert-blind
 * (verified in `refs/playwright`: `injectedScript.ts` never reads `inert`; its
 * `enabled` check only looks at `aria-disabled`; the hit-test is pure geometry).
 * So a click on an inert-wrapped element passes every actionability check,
 * Playwright dispatches it, and the browser swallows the activation — a silent
 * drop, no error. Waiting for the marker is the only honest "in-iframe is
 * interactive now" signal; `useHydrated()` itself exposes no DOM marker.
 *
 * Hoisted sidebar links do NOT need this — they render outside the inert wrapper
 * and only after hydration, so their visibility is itself the gate (see
 * `clickHoisted`).
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
 * lost: unlike `goto`, the `data-app-interactive` `waitFor` below is a retrying
 * poll over the live DOM, so it rides through the redirect and is the real gate.
 *
 * Local previews serve Vite's unbundled module graph (~186 requests/load)
 * through a Cloudflare quick tunnel. Individual module requests can remain
 * pending indefinitely, leaving the complete SSR page visible while the client
 * entry never reaches `hydrateRoot` and the hydration marker never appears —
 * the client entry is a dynamic import, so the waterfall runs after
 * `readyState=complete` and a stall has no page-level symptom. After 15s,
 * reload the admin document once to retry that module graph. Instrumented
 * healthy runs (2026-07-17) put the marker at 4.3–6.2s from goto, so 15s is
 * ~2.4× the healthy max, not a hedge. The second `waitFor` uses
 * Playwright's default operation
 * timeout (`0`) and is therefore bounded by the remaining per-test timeout
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
  const hydrated = frame.locator('[data-app-interactive="true"]');
  await hydrated
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(async () => {
      await page.reload({ waitUntil: "commit" });
      await hydrated.waitFor({ state: "attached" });
    });
  return frame;
}

/**
 * Click an App-Bridge-hoisted control (e.g. an `s-app-nav` link). App Bridge
 * lifts these OUT of the iframe into admin chrome, under an ancestor with
 * `aria-disabled="true"` that never clears. Playwright treats every descendant of
 * an `aria-disabled` ancestor as disabled, so `.click()` / `toBeEnabled()` time
 * out with "element is not enabled" — even though a human can click it. Assert
 * visibility (also the hydration gate: `s-app-nav` only renders post-hydration),
 * then fire a native DOM click.
 */
export async function clickHoisted(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate((el) => {
    (el as HTMLElement).click();
  });
}

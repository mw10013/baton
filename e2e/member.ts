import type { Page } from "@playwright/test";

import { expect } from "@playwright/test";

import { awaitHydration } from "./hydration";

/**
 * Member-area counterpart to `app.ts` — the non-embedded `/shop/*` and `/login`
 * surface, which has no iframe and no App Bridge. Gates on `awaitHydration`
 * (`e2e/hydration.ts`) against the page.
 *
 * Deliberately without `gotoApp`'s 15s timeout and reload rescue: those exist
 * because the embedded app is served through a Cloudflare quick tunnel where
 * individual requests in Vite's unbundled module graph can hang forever. This
 * runs against `http://localhost:$PORT` with no tunnel in the path, so the
 * default timeout is honest and a rescue would be cargo-culted.
 *
 * Controls are located by role and name, and Playwright's own actionability
 * is enough for them: `getByRole("button")` on a Polaris `s-button` resolves
 * through the shadow root to the native `<button>` inside it, and Polaris
 * mirrors the host's `disabled` onto that button as a real attribute
 * (measured 2026-10-07), so `.click()` waits for enabled and `toBeEnabled()` /
 * `toBeDisabled()` read the truth. `s-clickable` renders the same way. The
 * host tag is never a locator for a control: on `locator("s-button")`
 * Playwright reports a disabled control as enabled, because the host is
 * neither a native form control nor `aria-disabled`. `scripts/rules-lint.ts`
 * refuses it under `e2e/`. Hoisted controls are another matter: they are the
 * admin's DOM, not Polaris's, and go through `clickHoisted` (`e2e/app.ts`).
 */

/** Land on a member-area path and return once it is safe to interact. */
export const gotoMember = async (page: Page, path: string): Promise<void> => {
  await page.goto(path);
  await awaitHydration(page);
};

/**
 * Follow the demo-mode magic link and wait out the hydration of the document it
 * lands on. Needs its own helper because the navigation is not one we issue:
 * `s-link` (`src/routes/login.tsx`) renders a native anchor to a server route,
 * not a TanStack `<Link>`, so the click leaves the SPA entirely — verify `302`
 * → `/login-callback` `307` → `/shop` — and boots a brand-new document. Every
 * other in-app navigation in the member area is a real `<Link>` and stays
 * client-side, needing no wait at all.
 */
export const followMagicLink = async (page: Page): Promise<void> => {
  await page.getByRole("link", { name: "Open your sign-in link" }).click();
  await awaitHydration(page);
};

/** Submit the login form; the caller decides what the answer should be. */
export const requestMagicLink = async (
  page: Page,
  email: string,
): Promise<void> => {
  await gotoMember(page, "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
};

/** Sign in end to end — request the link, follow it, land where the role says. */
export const signIn = async (page: Page, email: string): Promise<void> => {
  await requestMagicLink(page, email);
  await expect(
    page.locator('s-section[heading="Check your email"]'),
  ).toBeVisible();
  await followMagicLink(page);
};

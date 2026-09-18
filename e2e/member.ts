import type { Locator, Page } from "@playwright/test";

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
  await page.getByRole("link", { name: "Open your magic link" }).click();
  await awaitHydration(page);
};

/** Submit the login form; the caller decides what the answer should be. */
export const requestMagicLink = async (
  page: Page,
  email: string,
): Promise<void> => {
  await gotoMember(page, "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send magic link" }).click();
};

/** Sign in end to end — request the link, follow it, land where the role says. */
export const signIn = async (page: Page, email: string): Promise<void> => {
  await requestMagicLink(page, email);
  await expect(
    page.locator('s-section[heading="Check your email"]'),
  ).toBeVisible();
  await followMagicLink(page);
};

/**
 * Whether a Polaris control is accepting clicks. `toBeEnabled()` cannot answer
 * this: Playwright's enabled check knows native form controls and
 * `aria-disabled`, and an `s-button` is neither — so a disabled one reports as
 * enabled, the click is dispatched into nothing, and the spec fails later at
 * whatever the click was supposed to cause. Reads the element's own `disabled`
 * state instead, the way `hoistedEnabled` (`e2e/app.ts`) does for the embedded
 * side. `closest` covers both shapes `getByRole` can resolve to — the
 * `s-button` host, or the native button inside its shadow root, where the
 * shadow boundary stops `closest` and the element itself is the one carrying
 * `disabled`.
 */
const controlEnabled = (locator: Locator): Promise<boolean> =>
  locator.evaluate((el) => {
    const control = el.closest("s-button") ?? el;
    return (
      !(control as HTMLButtonElement).disabled &&
      control.getAttribute("aria-disabled") !== "true"
    );
  });

/**
 * Wait for a control to come alive without clicking it: on the queue that is
 * the member's socket identifying, which a spec needs before something *else*
 * happens to that socket, such as a revocation.
 */
export const awaitEnabled = async (locator: Locator): Promise<void> => {
  await expect(locator).toBeVisible();
  await expect.poll(() => controlEnabled(locator)).toBe(true);
};

/**
 * Click a control once it is really clickable.
 *
 * On `/shop/$shop` this doubles as the wait for the `ShopAgent` socket: the
 * queue's buttons are disabled until the socket identifies, because the socket
 * is the only transport its actions have (`src/routes/shop.$shop.queue.tsx`).
 * Hydration is therefore not enough to click on — the document is interactive
 * while the connect and the `cf_agent_identity` handshake are still in
 * flight — and this poll is what closes that window.
 */
export const clickWhenEnabled = async (locator: Locator): Promise<void> => {
  await awaitEnabled(locator);
  await locator.click();
};

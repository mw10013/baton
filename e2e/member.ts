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

/** The limiter's answer, rendered as the login form's error banner (`src/routes/login.tsx`). */
const RATE_LIMITED = "Too many attempts. Try again later.";

/**
 * How long to wait before asking again after the limiter refused. `waitForTimeout`
 * rather than a poll because there is nothing to poll: the window is time, and
 * a resend before it rolls over spends nothing and answers the same.
 */
const RETRY_MS = 15_000;

/** Attempts, so a jammed limiter fails the spec instead of hanging until the test timeout. */
const RETRY_LIMIT = 5;

/**
 * Sign a member in end to end — request the link, follow it, land on `/shop`.
 *
 * Waits out `LOGIN_LIMITER` (`wrangler.jsonc`: 5 sends per 60s, keyed by IP,
 * and every local request shares the `unknown` key) rather than failing on it.
 * The member project's specs share that one budget, so whether a send is
 * refused depends on what ran in the previous file and how fast — a fact about
 * scheduling, not about the code under test, and not something a spec should
 * fail on. Callers still keep their own send count low (sign in once per file
 * and reuse the storage state); this is the backstop for the overlap between
 * files.
 *
 * The wait costs real wall time, so a caller doing this in a `beforeAll` must
 * raise the hook's timeout (`test.setTimeout`) past `RETRY_LIMIT * RETRY_MS`.
 */
export const signIn = async (page: Page, email: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    await requestMagicLink(page, email);
    const sent = page.locator('s-section[heading="Check your email"]');
    const limited = page.getByText(RATE_LIMITED);
    await expect(sent.or(limited)).toBeVisible();
    if (!(await limited.isVisible())) break;
    if (attempt + 1 >= RETRY_LIMIT)
      throw new Error(
        `magic link for ${email} rate limited ${String(RETRY_LIMIT)} times`,
      );
    await page.waitForTimeout(RETRY_MS);
  }
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

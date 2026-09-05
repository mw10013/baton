import type { Page } from "@playwright/test";

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

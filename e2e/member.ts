import type { Page } from "@playwright/test";

/**
 * Member-area counterpart to `app.ts` — the non-embedded `/shop/*` and `/login`
 * surface, which has no iframe and no App Bridge.
 *
 * The hydration gate is the `data-hydrated` marker on `<html>`
 * (`src/routes/__root.tsx`), which flips with the same `useHydrated()` commit
 * the embedded wrapper uses. It is load-bearing because until React attaches
 * its listeners the SSR'd markup is fully painted and React-dead, and
 * Playwright's actionability checks are satisfied by it. Pre-hydration, "Sign
 * out" (`onClick`) is a no-op and "Send magic link" (`<form onSubmit>` with
 * `preventDefault`) falls through to a native GET `/login?email=...` — the
 * page reloads showing the same form. Either way the spec fails much later,
 * at an assertion for a result the click never requested. The buttons now
 * carry `disabled={!hydrated}` as well, so an ungated click would at least
 * wait on `toBeEnabled`; the gate stays because typed input is also lost
 * to controlled-field state on the hydration flip.
 *
 * Deliberately without `gotoApp`'s 15s timeout and reload rescue: those exist
 * because the embedded app is served through a Cloudflare quick tunnel where
 * individual requests in Vite's unbundled module graph can hang forever. This
 * runs against `http://localhost:$PORT` with no tunnel in the path, so the
 * default timeout is honest and a rescue would be cargo-culted.
 */
export const awaitHydration = (page: Page): Promise<void> =>
  page.locator('html[data-hydrated="true"]').waitFor({ state: "attached" });

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

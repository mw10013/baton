import type { FrameLocator, Page } from "@playwright/test";

/**
 * Wait until the document in `scope` is safe to interact with.
 *
 * The gate is the `data-hydrated` marker on `<body>` (`src/routes/__root.tsx`),
 * which flips in the same commit that clears the body's `inert`. It is
 * load-bearing because Playwright's actionability is inert-blind (verified in
 * `refs/playwright`: `injectedScript.ts` never reads `inert`; its `enabled`
 * check only looks at `aria-disabled`; the hit-test is pure geometry). A click
 * inside an inert subtree passes every actionability check, is dispatched,
 * and is silently swallowed by the browser — the spec then fails much later,
 * at an assertion for a result the click never requested. Typed input is
 * likewise dropped, so `fill` needs this gate as much as `click`.
 *
 * Takes a `Page` for the non-embedded `/login`, `/shop`, and `/admin`
 * surfaces and a `FrameLocator` for the embedded app iframe, so both areas
 * wait on one selector. No timeout override here: callers that need a rescue
 * (the tunnel-served embedded app, see `gotoApp`) wrap this themselves.
 */
export const awaitHydration = (scope: Page | FrameLocator): Promise<void> =>
  scope.locator('body[data-hydrated="true"]').waitFor({ state: "attached" });

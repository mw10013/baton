# Polaris runbook

How Polaris web components reach the site, what must stay in sync, and how to move versions.

## How it works

- **Polaris is a CDN script, not an npm package.** The root document (`src/web/routes/__root.tsx`) loads it in `<head>` from the one URL in `src/web/components/polaris.ts` (`POLARIS_URL`). Today that is `https://cdn.shopify.com/shopifycloud/polaris-2.0.js`.
- **Only its types are installed:** `@shopify/polaris-types`, a dev dependency listed in `compilerOptions.types` in `tsconfig.json`. They type the `s-*` JSX elements.
- **It must load in `<head>`, before the body is parsed,** so every `s-*` element upgrades parent-first. Loaded at body end, a server-rendered `s-table-row` upgrades before its `s-table` and renders empty.
- **Standalone look:** with no App Bridge, Polaris 2.0 defaults to the "Admin Next" theme and adds `p-partial-theme-admin-next` to `<html>` before React hydrates; `<html suppressHydrationWarning>` covers that one mismatch. The site is light only: the bundle ships a dark palette but never applies it.
- **Network:** every page, and every browser test, needs `cdn.shopify.com`: the script, its fonts, icons and assets. A future Content Security Policy must allow that origin for scripts, styles and fonts.
- **Browser tests** load the same `POLARIS_URL` in `test/browser/setup.ts` and wait for `s-page` to be defined, because the test page has no server-rendered `<head>`.

## Keep these in sync

The bundle and the types are matched by hand; nothing checks them against each other.

| What                     | Where                                            |
| ------------------------ | ------------------------------------------------ |
| Script URL               | `POLARIS_URL` in `src/web/components/polaris.ts` |
| Types package, exact pin | `@shopify/polaris-types` in `package.json`       |

Shopify's rule: the types' major and minor line follow the script, e.g. `polaris-2.0.js` with `@shopify/polaris-types@2.0.*`. Change the script URL and the types package in the same commit.

## Reference copies in `refs/`

- `vp run refs fetch polaris` snapshots the bundle from `POLARIS_URL` into `refs/polaris/`: raw (`*.min.js`) and formatted (`*.js`, about 32k lines) for reading. The CDN sends no version header; the only version marker is the build hash comment on the bundle's first line, which the stamp records. Shopify can change the bundle behind the same URL, so a refetch is the way to see what is live.
- The formatted bundle answers questions the docs do not, such as theme selection and dark mode.
- `vp run refs fetch shopify-docs` mirrors the docs. The Polaris pages of interest: `refs/shopify-docs/docs/api/app-home/latest/` (Polaris 2.0 since its stable release) and `refs/shopify-docs/docs/apps/build/app-home/polaris2.md`.
- The types are read from `node_modules/@shopify/polaris-types`.

## App Bridge

Not loaded today; the plain `s-*` components do not need it. These do, and so are out of reach until the embedded app exists: `s-app-nav`, `s-app-window`, `ui-title-bar`, `ui-save-bar`, `ui-modal`, and the `shopify.*` APIs (toast, `shopify.modal`, `shopify.idToken`). `s-modal` is Polaris and works without it.

When a route adds it:

- `<meta name="shopify-api-key" content="…">` plus `https://cdn.shopify.com/shopifycloud/app-bridge.js` in `<head>`.
- **App Bridge must be the document's first script.** Shopify's App Store requirements say so. The root document renders a route's `head` (`<HeadContent />`) before the Polaris script for this reason, so put App Bridge in the route's `head`, not after Polaris.
- With App Bridge present, Polaris follows the merchant admin's theme instead of defaulting to Admin Next.

## Moving to a new Polaris version

Release candidates can change during their soak period, and Shopify publishes a promoted release at a **new URL**; it never updates the RC URL in place. So a move is always deliberate:

1. Find the new script URL and the matching `@shopify/polaris-types` version in Shopify's versioning docs (`refs/shopify-docs`, after a refetch).
2. Change `POLARIS_URL` in `src/web/components/polaris.ts`.
3. `vp add -D -E @shopify/polaris-types@<version>`.
4. `vp run refs fetch polaris shopify-docs`, then read the migration guide for changed or removed components and props.
5. Verify:

   ```sh
   vp check                 # catches props the new types reject
   vp test --project browser
   vp run test:e2e
   ```

   Then look at the pages in the dev server: theme, table rendering and fonts are not covered by the type check.

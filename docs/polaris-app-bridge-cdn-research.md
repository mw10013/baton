# Polaris + App Bridge CDN setup, versioning, and local refs

How the Shopify CDN scripts get into the document, what (if anything) pins
their versions, how the npm companion packages relate to the CDN artifacts,
and what `refs/` covers today vs what could be added.

## 1. How the CDN scripts load today

Two CDN artifacts, two injection points, one constants file.

`src/lib/shopifyConstants.ts:1-4`:

```ts
export const CDN_URL = "https://cdn.shopify.com";
export const APP_BRIDGE_URL =
  "https://cdn.shopify.com/shopifycloud/app-bridge.js";
export const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
```

| Artifact   | URL                              | Injected at                                             | By                                                    |
| ---------- | -------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| App Bridge | `.../shopifycloud/app-bridge.js` | `<head>`, first script tag, with `data-api-key`         | `/app` route `head()` in `src/routes/app.tsx:158-160` |
| Polaris    | `.../shopifycloud/polaris.js`    | body-end, after children, before TanStack `<Scripts />` | `RootDocument` in `src/routes/__root.tsx:92-96`       |

Ordering is a requirement, not a preference. `app.tsx:150-157` cites App
Store requirement 2.2.3 (`app-bridge.js` before any other script tag);
`__root.tsx:92-94` notes App Bridge stays the document's first script while
Polaris loads at body-end.

The same constants also feed:

- `Link` preload / preconnect headers on HTML documents
  (`src/lib/Shopify.ts:359-368`):
  `<CDN_URL>; rel="preconnect", <APP_BRIDGE_URL>; rel="preload"; as="script",
<POLARIS_URL>; rel="preload"; as="script"`.
- The minimal recovery documents (`renderAppBridgePage`,
  `renderExitIframePage` in `src/lib/Shopify.ts:393-449`): bare HTML with
  only the App Bridge script (plus a `window.open(..., "_top")` for
  exit-iframe). Used for the session-token bounce, missing shop/host, and
  billing-plan exit — covered by `test/integration/shopify-admin-auth.test.ts`.

## 2. Versioning: npm is pinned, the CDN is not

`package.json` pins (exact, no ranges):

| Package                     | Version  | Role                                            |
| --------------------------- | -------- | ----------------------------------------------- |
| `@shopify/app-bridge-react` | `4.2.13` | `useAppBridge()` hook + component wrappers      |
| `@shopify/app-bridge-types` | `0.7.2`  | dev: global JSX typings for App Bridge elements |
| `@shopify/polaris-types`    | `1.0.7`  | dev: global JSX typings for `s-*` elements      |

The CDN URLs above carry **no version**. Both are evergreen:

- `app-bridge.js`: "CDN-hosted, so your app always gets the latest version"
  (`refs/shopify-bridge/packages/app-bridge-react/README.md:59`). There is no
  versioned App Bridge CDN URL; version-lock requests are long-standing
  upstream issues with no resolution.
- `polaris.js`: the **legacy unversioned entry point**, currently serving 1.0
  ("Advances to 1.1 when 1.1 goes stable, then tracks 1.x. Never serves 2.x").

Measured 2026-09-07 (HEAD request): both scripts return `200` with
`cache-control: max-age=60, stale-while-revalidate=300` and a `last-modified`
of _today_ — i.e. Shopify pushes CDN updates roughly daily and clients
revalidate every minute. There is no ETag/version header to pin against.

### Polaris does have versioned channels — we just don't use them

Per Shopify docs (web search, shopify.dev "Web components" + "Polaris CDN is
adopting semantic versioning" changelog):

| Script tag                          | Serves                                         |
| ----------------------------------- | ---------------------------------------------- |
| `polaris-1.js`                      | newest stable 1.x (recommended for production) |
| `polaris-1.1-rc.js`                 | 1.1 release candidate                          |
| `polaris-1.1.js` / `polaris-1.0.js` | frozen stable releases (security fixes only)   |
| `polaris.js`                        | legacy unversioned entry (what we use)         |

`@shopify/polaris-types` "uses the same major version as the CDN release",
so types major `1.x` tracks CDN major `1`. Open question for this repo:
stay on `polaris.js` or move to `polaris-1.js` (Shopify's prod
recommendation) / `polaris-1.0.js` (frozen).

## 3. How each npm package relates to its CDN artifact

### App Bridge: `app-bridge.js` + `@shopify/app-bridge-react` + `@shopify/app-bridge-types`

- The CDN script creates the `shopify` global. `useAppBridge()` (used in
  `src/routes/app.tsx:406` and five child routes) is a thin accessor over
  that global — it throws without the script tag, which is why the `/app`
  route cannot use `ssr: 'data-only'` (`src/routes/app.tsx:339-340`).
- `@shopify/app-bridge-types` is the **source of truth in reverse**: Shopify
  publishes canonical types to the CDN at
  `https://cdn.shopify.com/shopifycloud/app-bridge.d.ts`, and the npm
  package's build _downloads the CDN file into `dist/index.d.ts`_
  (`refs/shopify-bridge/packages/app-bridge-types/scripts/build.mjs:5-20`).
  A scheduled workflow diffs CDN vs published npm and opens an automated
  "CDN types update" PR on drift
  (`.../scripts/check-cdn-updates.mjs`, workflow `check-cdn-types.yml`).
  So the types package lags the CDN by up to one patch release, by design.
- This repo consumes the types as globals. `tsconfig.json:13-14` lists both
  type packages in `compilerOptions.types`, and two bridge modules copy the
  globals into React 19's module-scoped JSX lookup:
  `src/lib/shopifyAppBridgeElements.ts` (`s-app-nav`, `ui-save-bar`) and the
  type-only `import type {} from "@shopify/polaris-types"` in
  `src/components/DefaultErrorComponent.tsx:1-2`.

### Polaris: `polaris.js` + `@shopify/polaris-types`

- `polaris.js` registers the `s-*` custom elements used across routes
  (`s-page`, `s-section`, `s-button`, …). No npm runtime package — the CDN
  script _is_ the implementation.
- `@shopify/polaris-types` ships `dist/polaris.d.ts` (global JSX entries) +
  `dist/custom-elements.json` (machine-readable element catalog, per its
  `package.json` `customElements` field). Same lag pattern as App Bridge:
  docs tell TS users to track `@shopify/polaris-types@latest` to keep step
  with the evergreen script.

## 4. What `scripts/refs.ts` covers today

- `shopify-bridge` → `Shopify/shopify-app-bridge`,
  tag `@shopify/app-bridge-react@{v}`, version read from our
  `dependencies.@shopify/app-bridge-react` (`scripts/refs.ts:159-163`).
  Stamp confirms: `resolved: @shopify/app-bridge-react@4.2.13`
  (`refs/shopify-bridge/.ref.json`). This gives us the React wrappers and
  the types _source_, but **not** the CDN `app-bridge.js` implementation
  (closed source, not in the repo) and **not** the live `app-bridge.d.ts`.
- `shopify-docs` (opt-in) → includes the `api-polaris` section
  (`scripts/refs-shopify-docs.ts:81-84`): prose docs for Polaris, not code.
- Gaps: **no `polaris-types` ref** even though it is a direct devDependency
  (would be a one-line `REFS` entry: npm or GitHub source pinned to
  `devDependencies.@shopify/polaris-types`); **no CDN snapshot refs** at all
  (neither `app-bridge.js` / `polaris.js` nor `app-bridge.d.ts`).

Note `refs/` is gitignored (`.gitignore:18`) — refs are per-machine reference
copies, not committed. Anything that must travel with the repo belongs in
`docs/`, not `refs/`.

## 5. What can actually be pulled down as a ref

| Desired artifact                                                   | Source                                                                                                        | Fetchable?                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@shopify/app-bridge-react` source                                 | `Shopify/shopify-app-bridge`, tag `@shopify/app-bridge-react@{v}`                                             | yes — already our `shopify-bridge` ref                                      |
| `@shopify/app-bridge-types` source                                 | same repo, `packages/app-bridge-types`                                                                        | yes — inside the same ref                                                   |
| Live `app-bridge.d.ts` (newer than npm)                            | `https://cdn.shopify.com/shopifycloud/app-bridge.d.ts` (53 KB)                                                | yes — plain `curl`, floats above the npm pin by design                      |
| `app-bridge.js` implementation                                     | CDN only, closed source (repo hosts wrappers/types, not the bundle)                                           | snapshot-only: minified blob, no version, changes ~daily                    |
| `@shopify/polaris-types` (`polaris.d.ts` + `custom-elements.json`) | npm package `@shopify/polaris-types@1.0.7` (no repo URL in its manifest; provenance is the CDN release train) | yes via npm tarball, same staged-tar path as the existing `partysocket` ref |
| `polaris.js` / `polaris-1.js` / `polaris-1.0.js` implementations   | CDN only                                                                                                      | snapshot-only, same caveats as `app-bridge.js`                              |
| Old `polaris-react` (React components)                             | `Shopify/polaris-react`, archived                                                                             | **do not ref** — deprecated predecessor, not the web components we ship     |

Do not confuse the archived `polaris-react` repo with current Polaris: the
former is the deprecated React library (archived, 13.x); the latter is
CDN-only web components with no public implementation repo.

## 6. The old minified + formatted CDN copy ("aux format")

Searched `docs/`, `refs/`, and `scripts/` for a vendored CDN bundle, a
formatted copy, and anything named `aux`: **not found**. No `*.js`
snapshot over ~500 KB exists outside `node_modules`/`.wrangler`, and no
formatting tooling beyond `oxfmt` (which explicitly excludes `refs/`,
`package.json:37`) is wired up. Possibilities, in likelihood order:

1. It lives in another checkout (`bang`? `tceas`? — both are refs here, not
   the reverse).
2. It was a one-off local download, never committed (consistent with
   `refs/` being gitignored — a snapshot would vanish on a fresh clone).
3. "aux" refers to a formatter preset or a scratch dir outside this repo.

If it resurfaces, the natural home per repo convention is `refs/` (LLM
reference, gitignored, fetched by `scripts/refs.ts`) — but a _formatted_
snapshot is a build artifact of a fetch, so `refs.ts` would need a
post-pass (fetch minified → prettify → write), exactly like the existing
image-localization post-passes. A checked-in copy under `docs/` buys
persistence at the cost of committing a ~daily-stale multi-hundred-KB blob.

## 7. Options

1. **Add a `polaris-types` ref** (cheap, unambiguous). New `REFS` entry
   pinned to `devDependencies.@shopify/polaris-types` via the npm-tarball
   path (`partysocket` precedent, `scripts/refs.ts:139-145`). Gives
   `polaris.d.ts` + `custom-elements.json` locally, drift-checked by
   `refs check`.
2. **Add CDN snapshot refs** (`app-bridge.d.ts`, optionally the `.js`
   bundles). New `sourceKind` in `refs.ts` (plain-URL fetch + `.ref.json`
   stamp with `fetchedAt`); no version pin possible, so `check` reports age
   only (same shape as branch/competitor refs). Formatting the minified JS
   needs a prettify post-pass (oxfmt handles JS; or keep raw + note it).
3. **Move `polaris.js` → `polaris-1.js`** (or frozen `polaris-1.0.js`) in
   `shopifyConstants.ts`. Independent of refs; decides whether the app
   floats on the legacy channel or a semver channel. Types major stays `1`
   either way.
4. **Leave snapshots out entirely** and rely on `polaris.d.ts` /
   `custom-elements.json` + `app-bridge.d.ts` for LLM reference. The `.js`
   bundles are minified runtime with ~daily churn; their marginal value over
   the `.d.ts` + custom-elements catalog is mostly behavior edge cases.

Suggested default: (1) + live `app-bridge.d.ts` snapshot now; (2-for-JS) only
if a debugging session actually needs runtime internals; (3) as a separate
conscious decision with a test pass, since it changes what merchants load.

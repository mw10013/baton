# Refs tooling: adopting prelive's `scripts/refs.ts` and evaluating siteone-crawler for Shopify docs

Research into replacing baton's 18 hardcoded `refs:*` package.json scripts with the
declarative `scripts/refs.ts` CLI from `../ableton-extension-prelive`, and whether
[siteone-crawler](https://github.com/janreges/siteone-crawler) should replace the custom
Shopify docs fetch script (`refs/bang/scripts/refs-shopify-docs.ts`).

**Status: implemented 2026-08-31** — `scripts/refs.ts` + `scripts/refs-shopify-docs.ts` ported,
`refs:*` package.json scripts replaced by `refs`/`refs:all`/`refs:check`, `refs/effect4` renamed
to `refs/effect`, dropped refs deleted. The research below is the evidence the port rests on.

**Verdict:**

1. **Adopt refs.ts — clear win.** Single declarative table, versions resolved from
   package.json pins instead of duplicated in script strings, `refs check` reports drift,
   staged fetches that never clobber an existing ref on failure, `.ref.json` stamps
   recording provenance. Baton's copy drops the crawl/fluidTopics machinery it doesn't need.
2. **Do NOT use siteone-crawler for shopify.dev — keep the native `.md` fetch.** The test
   crawl is decisive: shopify.dev serves first-party markdown (`content-type: text/markdown`)
   at every `/docs/**.md` URL, and siteone's HTML→markdown conversion of the same page
   **destroys every fenced code block** (native `subscribe.md`: 20 fences; siteone output: 0 —
   GraphQL arrives as backslash-escaped prose). Port `refs-shopify-docs.ts` from bang into
   refs.ts as an opt-in ref instead. §4 has the full comparison; §5 covers the image gap and
   how to close it without siteone.
3. **Keep siteone-crawler in the toolbox** for any future ref whose site has no first-party
   markdown and no repo (none of baton's current refs qualify).
4. **Rename `effect4` → `effect`** as part of the migration: ref name `effect`, dir
   `refs/effect`, script pinned via `dependencies.effect` (currently `4.0.0-rc.108`).
   Effect v4 RC *is* effect now; the `4` suffix adds nothing. §6.

---

## 1. What baton has today

Eighteen `refs:*` scripts in package.json, each shaped like:

```
"refs:effect4": "rm -rf refs/effect4 && mkdir -p refs/effect4 && curl -L https://github.com/Effect-TS/effect/archive/refs/tags/effect@4.0.0-rc.108.tar.gz | tar -xz -C refs/effect4 --strip-components=1"
```

Problems, all observed in this repo:

- **Version duplicated by hand.** `effect@4.0.0-rc.108` appears in the script string *and*
  in `dependencies`. Every dep bump requires remembering to edit the script; nothing checks.
  All 18 happen to be in sync today, but only by discipline.
- **No drift detection.** Nothing reports that a ref on disk was fetched from an older tag
  than the current pin, or when.
- **`rm -rf` before download.** A failed fetch (network, moved tag) leaves the ref deleted.
- **Silent pipe failure.** `curl | tar` without pipefail: tar accepts empty input, so a 404
  tarball can "succeed" into an empty dir.
- **No inventory.** `refs/shopify-rr` and `refs/tces` exist on disk with no script;
  `refs:shopify-cli`, `refs:agents`, `refs:partysocket` have scripts but no dir on disk.
  `refs/shopify-docs` (47 MB, 4597 files) has no script here at all — it was produced by
  `refs/bang/scripts/refs-shopify-docs.ts` in the bang repo.
- **No provenance.** A ref dir carries no record of what tag/branch it came from or when.

## 2. What prelive's refs.ts does

`../ableton-extension-prelive/scripts/refs.ts` (1484 lines, Effect v4 + `effect/unstable/cli`
`Command`/`Flag`/`Argument`, `effect/unstable/process` `ChildProcess`). Commands:

```
node scripts/refs.ts fetch <name...>   fetch those refs
node scripts/refs.ts fetch --all       fetch every ref except the opt-in ones
node scripts/refs.ts check             report refs that drifted from the pins (exit 1 if any)
node scripts/refs.ts list              same report, without exiting non-zero
```

Mechanics that matter for baton:

- **Declarative `REFS` table.** One entry per ref: `{ name, repo, tag: "effect@{v}", version: { from, dep } }`.
- **Versions resolved from package.json pins.** `version: { from: ".", dep: "effect" }`
  reads `dependencies.effect` at fetch time; the dep bump is the only edit. Ranges are
  rejected (`pin it exactly`) — baton already pins exactly, so this is free.
- **`refs check`.** Per-ref status: `ok 4.0.0-rc.108`, `STALE have X want Y`, `MISSING`.
  Branch-tracked refs (no pin) report age: `main fetched 12d ago`. CI-able (exit 1 on drift).
- **Staged fetches.** Download into a temp dir, stamp, then `rm`+`rename` into `refs/<name>`.
  A failed fetch leaves the existing copy intact — the inverse of baton's `rm -rf` first.
- **Explicit pipe failure.** Download and tar exit codes both checked ("the `pipefail` the
  old bash pipeline had").
- **`.ref.json` stamp** per ref: source repo/url, resolved tag, version, `fetchedAt`.
- **`private: true`** refs fetch via `gh api` (baton's `refs:bang` already does this ad hoc).
- **`optIn: true`** refs are skipped by `fetch --all` — the slot for the multi-minute
  shopify-docs fetch.
- **Crawl / Fluid Topics support** for sites with no repo — prelive uses this for the Live,
  Logic, Cubase and Max manuals. Baton needs none of it today (§4); porting can drop
  `Crawl`, `FluidTopics`, and their ~800 lines, keeping the door open to re-add `Crawl`
  from prelive if a crawl-only source ever appears.

Compatibility check, verified in this repo: `effect@4.0.0-rc.108` in `node_modules` ships
both `effect/unstable/cli` (Argument, Command, Flag, CliError) and `effect/unstable/process`
(ChildProcess, ChildProcessSpawner). The port needs `@effect/platform-node` (already a
devDependency) and nothing else.

### Proposed REFS table for baton

| name | source | version from |
| --- | --- | --- |
| effect (renamed from effect4) | Effect-TS/effect `effect@{v}` | dep `effect` |
| tan-start | TanStack/router `@tanstack/react-start@{v}` | dep `@tanstack/react-start` |
| tan-router | TanStack/router `@tanstack/react-router@{v}` | dep `@tanstack/react-router` |
| tan-query | TanStack/query `@tanstack/react-query@{v}` | dep `@tanstack/react-query` |
| tan-form | TanStack/form `@tanstack/react-form@{v}` | dep `@tanstack/react-form` |
| vitest | vitest-dev/vitest `v{v}` | dep `vitest` |
| playwright | microsoft/playwright `v{v}` | dep `@playwright/test` |
| workers-sdk | cloudflare/workers-sdk `wrangler@{v}` | dep `wrangler` |
| agents | cloudflare/agents `agents@{v}` | dep `agents` |
| shopify-app-js | Shopify/shopify-app-js `@shopify/shopify-api@{v}` | dep `@shopify/shopify-api` |
| shopify-bridge | Shopify/shopify-app-bridge `@shopify/app-bridge-react@{v}` | dep `@shopify/app-bridge-react` |
| shopify-codegen | Shopify/shopify-app-js `@shopify/api-codegen-preset@{v}` | dep `@shopify/api-codegen-preset` |
| shopify-cli | Shopify/cli `{v}` | literal (CLI version, no dep) |
| shopify-app-template | Shopify/shopify-app-template-react-router | branch `main` |
| cloudflare-docs | cloudflare/cloudflare-docs | branch `production` |
| bang | mw10013/bang, `private: true` | branch `main` |
| partysocket | npm registry tarball | transitive pin — see below |
| shopify-docs | ported fetch script (§4) | literal, `optIn: true` |

Straggler decisions (settled 2026-08-31):

- **partysocket: keep.** Important for debugging — it is what `agents` runs on and gets dug
  into to find issues. Not a direct dep, but `agents` pins it exactly
  (`node_modules/agents/package.json` `dependencies.partysocket: "1.3.0"`), so the port adds
  two small pieces: a `transitiveOf` version source that reads the pin out of
  `node_modules/agents/package.json` (an agents bump moves the ref automatically, and
  `refs check` reports drift against whatever agents currently pins), and an `npmPack`
  fetch kind that downloads
  `https://registry.npmjs.org/partysocket/-/partysocket-{v}.tgz` through the same
  staged-tar path as GitHub tarballs (same shape as today's `npm pack` script, minus the
  leftover `.tgz` cleanup).
- **shopify-session-prisma: drop.** Moved far away from Prisma session storage; the ref also
  duplicates the shopify-app-js monorepo at a different tag.
- **tces (orphan dir): drop.** It is our own public repo — no need to vendor it here.
- **shopify-rr (orphan dir): drop.** Was on the fence; decided to remove. Re-adding later is
  one REFS entry if it turns out to be missed.

## 3. siteone-crawler itself

- Rust CLI, MIT, actively maintained; installed here already: `siteone-crawler 2.5.1.20260627`
  via `brew install janreges/tap/siteone-crawler`.
- Crawls a site into markdown with assets: `--markdown-export-dir`, `--include-regex`,
  `--markdown-exclude-selector`, `--allowed-domain-for-external-files`, optional `--browser`
  (Chromium render, ~20s/page vs ~0.3s plain).
- Genuinely powerful, and prelive uses it in production for four product manuals — but its
  refs.ts JSDoc is also a catalog of sharp edges learned the hard way: heading characters
  mangled by the converter (`cue_points` → `cue\points`, needed a post-crawl repair pass),
  inline `<svg>` dropped silently, `--max-queue-length` silently dropping images while
  exiting 0, `include` regex matched against the whole URL, comma-splitting of
  `--include-regex`, external assets stored where the links don't point
  (`flattenExternalAssets` fixes up). Every crawl prelive ships needed 1–3 site-specific
  post-passes to be trustworthy.

The tool is the right choice **when the only source is HTML**. That is the situation for
Ableton/Apple/Steinberg manuals. It is not the situation for shopify.dev.

## 4. Test crawl vs native `.md` on shopify.dev

Bounded test run (7 pages, webhooks subtree, no browser, 2 workers / 3 req/s):

```
siteone-crawler --url='https://shopify.dev/docs/apps/build/webhooks' \
  --include-regex='^https://shopify\.dev/docs/apps/build/webhooks' \
  --regex-filtering-only-for-pages \
  --allowed-domain-for-external-files=shopify-assets.shopifycdn.com \
  --markdown-export-dir=<staging> ...
```

Findings, siteone output vs `curl https://shopify.dev/docs/apps/build/webhooks/subscribe.md`:

| | native `.md` | siteone crawl of same page |
| --- | --- | --- |
| fenced code blocks | **20** | **0** — code emitted as escaped prose: `mutation webhookSubscriptionCreate\($topic: WebhookSubscriptionTopic\!...\)` |
| headings | clean (`## Subscribe to a topic`) | anchor junk: `## Anchor to What you can build(...webhooks.htmlwhat-you-can-build)What you can build` |
| page chrome | none — content only, YAML frontmatter with `source_url` | full nav menu, "Skip to main content", sidebar TOC leak into every file (fixable per-site with `--markdown-exclude-selector`, but selectors rot silently) |
| punctuation | clean | `\(`, `\!`, `\{` escapes throughout prose and tables |
| size (subscribe page) | 16.7 KB | 25.3 KB (chrome + escapes) |
| images | **not downloaded** — absolute URLs into shopify.dev/CDN | **downloaded** — content figures AND ~16 site-chrome icons (light+dark logo pairs, 32px nav icons); one page saved with a query-param hash (`get-started.160845adce.md`) |

The code-block loss alone disqualifies the crawl: code examples are the main reason the ref
exists, and escaped prose is neither runnable nor reliably greppable. Shopify maintains the
`.md` rendering server-side (every HTML page advertises it:
`<link rel="alternate" type="text/markdown" ...>`); a local HTML→markdown conversion can only
be worse than the markdown Shopify already writes.

### Why the custom script's other machinery also survives

`refs/bang/scripts/refs-shopify-docs.ts` (678 lines) does three things siteone cannot replace:

- **Subset selection.** Sitemap-driven (`sitemap_standard.xml.gz`) with per-section URL
  prefixes plus `namePrefixes` allowlists for admin-graphql (~30 commented-in resource name
  prefixes out of the full API). This is the "we only want a subset" control, already tuned.
  A crawler discovers by following links; bounding it to the same subset means reproducing
  the same allowlists as regexes, with less precision.
- **Webhook topic pages are client-rendered.** Verified:
  `/docs/api/webhooks/2026-01/topics/orders-create` serves a **319-byte** shell with zero
  content, and its `.md` is 404. The landing `2026-01.md` exists but links **0** topic pages.
  The script decodes the React Router `.data` payload
  (`decodeReactRouterData`/`readWebhookTopics`) and renders per-topic markdown itself.
  siteone would need `--browser` at ~20s/page across hundreds of topics — hours, for worse
  output.
- **Native `.md` fetch at concurrency 8** with per-URL error reporting; output mirrors URL
  paths (`refs/shopify-docs/docs/...`), each file carrying `source_url` frontmatter.

Port shape: fold it into refs.ts as `{ name: "shopify-docs", optIn: true }` with a
`shopifyDocs` source kind (its own module or section), or keep it as a sibling script that
refs.ts shells out to. The former gives it the staging + stamp + `check` age reporting for
free; the stamp's `version` slot can record the pinned webhooks API version (`2026-01`).

## 5. The images gap, and closing it without siteone

Native `.md` references images by absolute URL
(`https://shopify.dev/assets/assets/images/apps/how-webhooks-work-Dhi08wMg.png`), so the
current ref has no local images. The test crawl proves the images are plain `<img src>` —
publicly fetchable, no JS needed. If local images are wanted:

- Post-pass in the ported script: regex image URLs out of each fetched `.md`
  (`shopify.dev/assets/...` and `shopify-assets.shopifycdn.com/...`), download once
  (dedupe by URL), rewrite links to a local `_assets/` path. ~40 lines inside machinery
  that already exists; naturally skips site-chrome icons because only content markdown is
  scanned, where siteone pulled 16 icon/logo files alongside 7 content figures.
- Or accept absolute URLs (status quo): grep-ability of the ref is unaffected; only offline
  image viewing is lost.

Decision (2026-08-31): add the post-pass during the port — cheap, and it makes the ref
self-contained the way every other ref is.

## 6. The `effect4` → `effect` rename

Effect v4 (still `4.0.0-rc.*`) is the only Effect this project uses; the `4` marker has no
remaining job. Touch points, verified by grep:

- `package.json` — `refs:effect4` script (subsumed by the refs.ts migration; entry name `effect`).
- `AGENTS.md:41` — `**Effect v4 Docs**: refs/effect4/ai-docs/src/` → `refs/effect/ai-docs/src/`
  (CLAUDE.md mirrors AGENTS.md). Keep the "Effect v4" label in prose if the RC distinction
  is worth flagging; the path drops the `4`.
- `refs/effect4/` dir on disk → `refs/effect/` (delete + refetch, or `git mv`-style rename —
  refs are gitignored, so just rename).
- No code references `refs/effect4` (grep over src/, test/, scripts/ came back empty).

Standalone version if done before the refs.ts port: rename the script key to `refs:effect`,
change both `effect4` occurrences in its command to `effect`, update AGENTS.md, rename the dir.

## 7. Proposed migration plan

1. Port `scripts/refs.ts` from prelive: keep `Ref`/`VersionSource`, resolve/fetch/check/list,
   staging, stamps, `private`, `optIn`; drop `Crawl` + `FluidTopics` (~800 lines).
   Adjust `repoRoot` and the REFS table per §2. Wire package.json:
   `"refs": "node scripts/refs.ts"`, `"refs:all": "node scripts/refs.ts fetch --all"`,
   `"refs:check": "node scripts/refs.ts check"`; delete the 18 `refs:*` scripts.
2. Fold in the shopify-docs fetcher from `refs/bang/scripts/refs-shopify-docs.ts` as an
   opt-in ref, adding the image post-pass (§5). Copy the section/namePrefix subset as-is
   (decided: it suffices — customer/fulfillment etc. stay excluded); re-check only the
   pinned webhooks version (`2026-01`) at port time.
3. Do the `effect4` → `effect` rename (§6) as part of the table.
4. Stragglers (decided, see §2): implement the partysocket `npmPack` + `transitiveOf`
   pieces; delete `refs/shopify-session-prisma`, `refs/shopify-rr`, `refs/tces` and any
   AGENTS.md mentions.
5. Typecheck `scripts/`: add a `scripts/tsconfig.json` and a `typecheck:scripts` script the
   way prelive does (`tsc -p scripts --noEmit`), folded into `pnpm typecheck`.
6. `node scripts/refs.ts check` after `pnpm install` bumps (optionally in CI) so ref drift
   becomes visible instead of silent.

## 8. Resolved questions (2026-08-31)

- Local images for shopify-docs: **post-pass** — download into `_assets/`, rewrite links (§5).
- Admin-graphql `namePrefixes` allowlist: **copy as-is** from bang; the exclusions
  (customer, fulfillment, orders, ...) match baton's needs for now.
- `typecheck:scripts`: **yes** — plan step 5.

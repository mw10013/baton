# Refs tooling: pulling the competitor app sites into `refs/`

Research into adding the five anchor apps from
`docs/Shopify Production Workflow Competitor Deep Dive.md` to `scripts/refs.ts`, so their
marketing sites, help pages and App Store listings are local, greppable and dated instead of
re-fetched by hand on every research pass.

Companion to `docs/refs-tooling-research.md`, which established the current `scripts/refs.ts`
and deliberately dropped prelive's crawl machinery ("no baton ref needs a crawl"). One ref now
does.

**Status: implemented 2026-08-31.** Everything lives in `scripts/refs.ts` -- five `optIn`
entries plus the fetch/convert/crawl machinery at the bottom of the file. No new script files:
`refs-shopify-docs.ts` is the one sibling module and it stays the only one. Every measurement
below was run against the live sites on that date; §9 records what the build changed.

**Verdict:**

1. **Five refs, one per app** (`route-to-ship`, `kanbanify`, `makers-production-view`,
   `makerbatch`, `benchcue`), each `optIn: true` and carrying no version at all. Each is
   independently fetchable and independently aged by `refs check`.
2. **One converter, two acquisition paths.** `siteone-crawler` has a standalone single-file mode
   (`--html-to-markdown=<file> --html-to-markdown-output=<file>`), already used by prelive's
   `htmlToMarkdown` for post-crawl repair. That means a plain `curl`-per-URL fetch and a full
   browser crawl can share the *same* HTML→markdown converter — the hybrid is not two
   conversion pipelines, it is two ways of getting HTML onto disk. §3.
3. **Only kanbanify needs the crawler.** It is a pure client-rendered SPA: every path returns
   the same 4,409-byte `<div id="root">` shell. The other four sites serve their content in the
   HTML and need nothing more than a URL list. §2, §4.
4. **App Store listings are the highest-value target of the five sources.** A converted listing
   carries the exact per-tier pricing, the full **Data access** scope disclosure, launch date and
   review count — the deep dive's core evidence, in 19 KB of markdown. §4.2.
5. **Port back a trimmed `Crawl` from prelive** — the interface, `crawlInto`, `assertCrawler`,
   `repairCrawledMarkdown`, `htmlToMarkdown`, `allFiles`. Leave `FluidTopics`,
   `flattenExternalAssets`, `convertAssetPages`, `rescueInlineFigure` and `versionFrom` behind;
   nothing here needs them. §6.

---

## 1. Why these are not like the existing refs

Every ref in `scripts/refs.ts` today is either library source pinned to a `package.json`
version, a tracked branch, or shopify.dev's first-party markdown. Competitor marketing sites
are none of those:

- **No version to pin to, and no substitute for one.** There is no tag, no branch, no
  dependency. An early version of this used a hand-edited `COMPETITOR_SNAPSHOT` date shared by
  all five, which was wrong twice over: nothing upstream produces that date, so it was a
  note-to-self wearing a pin's clothing; and because `checkRefs` compares the pin against the
  stamp, editing it marked all five STALE even when only one had been re-read. Competitor refs
  now carry no version — the target names the source URL, and each ages independently off its
  own `fetchedAt`:
  `route-to-ship  https://apps.shopify.com/route-to-ship  fetched 12d ago`. That is the correct
  amount to claim.
- **The content is the product contract, not an API.** These refs exist to answer "what did
  Route to Ship's pricing page actually say on the day we read it", which is a dated claim. The
  `.ref.json` stamp's `fetchedAt` is doing more work here than for any other ref.
- **They are someone else's live server.** Hence `optIn: true` across the board — the same
  reasoning the `optIn` JSDoc already gives for `shopify-docs`.

## 2. Site inventory — measured 2026-08-31

| App | Site | Render | Discovery | Public pages |
| --- | --- | --- | --- | --- |
| Route to Ship | `www.routetoship.com` | SSR, content in HTML | `sitemap.xml` — **35 URLs** (20 product, 15 blog) | 35 |
| Kanbanify | `kanbanify.ungari.org` | **client-rendered SPA** | none (no robots.txt, no sitemap — both return the shell) | 2 |
| Maker's Production View | `fleartex.com` | SSR (Astro 5.18.2) | none (`sitemap.xml` and `sitemap-index.xml` both fall back to the homepage) | 3 |
| MakerBatch | `makerbatch.vercel.app` | Next.js | none (`sitemap.xml` → 404) | **1** |
| BenchCue: Maker Card | `maker-card.revertcreations.com` | SSR Next | `sitemap.xml` — 5 URLs | 5 |
| (all five) | `apps.shopify.com/<handle>` | SSR, 200 to plain `curl` | 5 known handles | 5 |

Three of these findings materially change the plan:

**Kanbanify is a two-route SPA with its copy compiled into one JS bundle.** `/pricing`, `/docs`,
`/features`, `/faq`, `/support` and `/privacy` all return the identical 4,409-byte shell; the
bundle (`/assets/index-r3tvASLW.js`, 334 KB) declares exactly two routes, `/` and `/privacy`.
Its marketing copy is in the bundle as compiled JSX string literals (`Kanban` ×17, `Flow` ×8,
`marker` ×13) — present, but not in a form worth extracting by hand. This is the one site that
needs `--browser`.

**MakerBatch has no public marketing site.** `https://makerbatch.vercel.app/` returns a Next.js
**404** and the document is `<meta name="robots" content="noindex">`; the deployment *is* the
embedded Shopify app. The only page that resolves is `/privacy` (14.9 KB) — which is exactly
where the deep dive's MakerBatch evidence came from (`read_orders` scope, Supabase/Vercel
infrastructure, redaction handling). See the scope exception in §5.

**Route to Ship's sitemap is 43% blog.** 15 of 35 URLs are `/blog/*` SEO posts. Kept, per the
scope decision, but they are the part of the ref most likely to grow and least likely to
describe the product contract.

## 3. Mechanism: one converter, two acquisition paths

`siteone-crawler` is two tools behind one binary. prelive's `refs.ts` uses both, but only ever
the second one *after* the first:

```ts
// crawl: discovery + fetch + convert, all in the crawler
siteone-crawler --url=... --include-regex=... --markdown-export-dir=<staging>

// convert only: one HTML file already on disk -> one markdown file
siteone-crawler --html-to-markdown=<in.html> --html-to-markdown-output=<out.md> \
                --markdown-exclude-selector=<css>
```

The second form is what makes the hybrid cheap. For the four SSR sites the acquisition is a
plain `HttpClient` GET per known URL — the machinery `scripts/refs-shopify-docs.ts` already has,
minus the sitemap-prefix matching — written to a temp `.html`, converted, and the `.html`
discarded. No crawler discovery, no `--include-regex` (whose whole-URL-vs-path trap cost prelive
a silent empty crawl), no queue-length guards, no rate limiting against someone else's server
beyond the handful of URLs actually wanted.

Only kanbanify takes the crawl path, and only because its HTML has no content in it.

Both paths land in the same converter, so `repairHeading` (§6) applies to both, and a
`--markdown-exclude-selector` tuned for a site works identically whichever way its HTML arrived.

## 4. Conversion quality — measured, not assumed

`docs/refs-tooling-research.md` §4 rejected siteone for shopify.dev because the converter
destroyed every fenced code block (20 → 0). That verdict was about *code*. These are marketing
pages with no code in them, so the same converter is being asked a much easier question. It
answers it well.

### 4.1 Route to Ship `/pricing`

60,000 bytes of HTML → **7,668 bytes** of markdown. The entire plan ladder survives intact and
legible:

```markdown
### Production

For small custom shops

$39/mo

billed monthly
- 3team members
- 250orders / month

\+ extra user$15/mo

order overage$0.15/order
```

Two converter artifacts, both cosmetic and both worth knowing before trusting a grep:

- **Adjacent inline elements concatenate.** `<span>3</span><span>team members</span>` becomes
  `3team members`, and `$0` + `/mo` becomes `$0/mo`. Values are all recoverable, but a grep for
  `3 team members` misses. Not repairable by flags; live with it, or add a spacing pass.
- **`+` is escaped as `\+`** in prose. Same class as the `\(` / `\!` escaping noted in the
  shopify.dev comparison, and harmless outside code.

Site chrome is a single logo line — this site needs no `--markdown-exclude-selector` at all.

### 4.2 App Store listing (`apps.shopify.com/route-to-ship`)

204,792 bytes → **18,929 bytes**. This is the single richest source of the five, and it converts
cleanly. The **Data access** section in particular is the App Store's structured scope
disclosure, which no other source states this precisely:

```markdown
### Data access

#### View customer data:
Sensitive data, device and activity data
- #### Sensitive data
Name, email address, phone number, physical address
- #### Device and activity data
Geolocation, IP address, browser and operating system

#### View staff and contributor data:
Store owner
...
#### View and edit store data:
Customers, products, orders
```

Also recovered: every pricing tier with its full feature bullets, `Works with` (Customer
accounts / Shopify Flow / Shopify Admin), `Launched July 8, 2026`, the developer's postal
address, and `## Reviews (1)`.

The one cost is chrome: the navbar category list, the footer category table, and a
related-apps carousel that leaks foreign review counts (`23 total reviews`, `69 total reviews`)
into the file — a real hazard when the point of the ref is review-count evidence. This is the
one source that **needs** `--markdown-exclude-selector`, and the selectors need a comment saying
why, because per `docs/refs-tooling-research.md` §3 a selector that stops matching fails
silently and the boilerplate quietly returns.

### 4.3 Kanbanify under `--browser`

The crawl (`--browser --browser-wait=networkidle --browser-wait-extra=3000
--screenshot-viewport=1600x30000`) produced `index.md` (5,598 B), `privacy.md` (5,041 B) and
`logo.svg` — the whole site, rendered. It recovered the exact Flow contract the deep dive cites,
as a primary source:

> Kanbanify ships its own Flow trigger that fires when an order changes stage, and a Flow action
> to assign card markers automatically — for example, sending a Slack alert when an order moves
> backward in your workflow.

It also surfaced pricing-tier detail the deep dive does not currently record (`Multiple Workflow
Boards`, `Product-Type Workflows`), which is the argument for the ref existing at all.

Two artifacts:

- **The cookie-consent banner is the first line of `index.md`.** A `--markdown-exclude-selector`
  candidate.
- **Internal link rewriting is inconsistent** — `[Privacy Policy](privacy.md)` (rewritten) sits
  two lines above `[Kanbanify](index.html)` (not rewritten). Cosmetic; both files are present.

Cheap, too: two pages, and the run completed in seconds rather than the ~20s/page the `Crawl`
JSDoc warns about, because Chromium was already installed.

## 5. Scope: everything each site publishes

**Decided: take every public page.** An earlier draft of this document proposed excluding legal
pages as a category. That was wrong, and reversing it is the single most consequential scope
correction here, because for the two smallest apps the privacy policy *is* the technical
documentation:

- **MakerBatch's `/privacy` is the only public page that exists** (§2). It is the documented
  source for `read_orders`, the Supabase/Vercel infrastructure disclosure, and the redaction
  behavior. Without it the ref would be an App Store listing and nothing else.
- **BenchCue's `/privacy`** carries the "held in volatile application memory ... for no more
  than five minutes ... never written to BenchCue's database" claim, which is the most
  interesting architectural fact recorded about that app.

These sites are one to thirty-five pages each. The cost of taking all of them is nothing, and
the cost of guessing wrong about which page holds the evidence is a missing primary source.

Per-app page counts as fetched:

| Ref | Site pages | App Store |
| --- | --- | --- |
| `route-to-ship` | 35 (20 product + 15 blog, from the sitemap) | listing + reviews |
| `kanbanify` | 2 (crawled with `--browser`) | listing + reviews |
| `makers-production-view` | 3 | listing + reviews |
| `makerbatch` | 1 | listing + reviews |
| `benchcue` | 5 | listing + reviews |

**Review pages are fetched separately.** A listing page carries only the review count and
rating; the review *text* lives at `apps.shopify.com/<handle>/reviews`. The deep dive leans
heavily on one Purple Carrot review whose body appears nowhere on the listing page, so
`reviews.md` is a second fetch per app rather than an optional extra.

## 6. Fetch posture and user-agent

The fetch identifies itself as `baton/refs-competitors (+https://github.com/mw10013/baton)`,
matching the existing `refs-shopify-docs.ts` convention. It is not, and must not be presented
as, ClaudeBot or any other agent's crawler.

Per-site robots as measured:

| Site | robots.txt |
| --- | --- |
| `routetoship.com` | `Allow: /`; explicitly allows GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot. Disallows `/billing`, `/onboarding`, `/signup` — none are in scope. |
| `maker-card.revertcreations.com` | `Allow: /`; disallows `/app`, `/auth`, `/api`, `/print`, `/webhooks` — none are in scope. |
| `apps.shopify.com` | `User-agent: *` disallows `/internal/`, `/services/`, `*q=*` and auth-param URLs. App listing paths are allowed. |
| `kanbanify.ungari.org` | No robots.txt (the path returns the SPA shell). |
| `makerbatch.vercel.app` | No robots.txt; the app itself is `noindex`, which governs indexing, not fetching. |
| `fleartex.com` | `Content-Signal: search=yes, ai-train=no, use=reference` for `*`, plus `Disallow: /` for a named list of AI crawlers **including ClaudeBot**. |

**fleartex, decided:** include, fetched under the `baton/refs-competitors` user-agent. The site's
`Disallow` list names specific AI training/answer-engine crawlers, and this is not one of them;
the `*` policy it publishes is `Allow: /` with `use=reference`, which is precisely the use here —
three pages, read locally, as reference. Worth restating in the `Ref` JSDoc so the reasoning
travels with the entry rather than living only in this document, which is explicitly disposable
(`CLAUDE.md`: a JSDoc "must never reference files under `docs/`").

Rate limiting: `--workers=2 --max-reqs-per-sec=3` for the kanbanify crawl (prelive's settings);
the URL-list path fetches at `concurrency: 4`, below `refs-shopify-docs.ts`'s 8, since these are
small personal servers rather than shopify.dev.

## 7. Shape as built

### 7.1 `Ref` additions in `scripts/refs.ts`

`resolve` gets one new case returning the listing URL as the target with `version` left unset,
which is what puts these on the age-reported branch of `checkRefs`:

```ts
interface Competitor {
  /** App Store listing handle: apps.shopify.com/<handle>. */
  readonly listing: string;
  /** Pages served as HTML, fetched by URL and converted locally. */
  readonly site?: {
    readonly origin: string;
    /** Explicit paths, or a sitemap to enumerate when the site publishes one. */
    readonly paths?: readonly string[];
    readonly sitemap?: string;
  };
  /** Client-rendered site: crawl with --browser instead of fetching HTML. */
  readonly crawl?: Crawl;
  /** CSS selectors dropped before conversion, for both paths. */
  readonly excludeSelector?: readonly string[];
}
```

Entries, all `optIn: true` and versionless:

| name | listing handle | site |
| --- | --- | --- |
| `route-to-ship` | `route-to-ship` | `www.routetoship.com`, sitemap (35) |
| `kanbanify` | `kanbanify` | `crawl` with `browser: true` (2) |
| `makers-production-view` | `maker-production-view` | `fleartex.com`, paths `/`, `/maker-production-view/support/` |
| `makerbatch` | `makerbatch` | `makerbatch.vercel.app`, path `/privacy` |
| `benchcue` | `maker-card` | `maker-card.revertcreations.com`, sitemap (5) |

Layout inside each ref: `listing.md` for the App Store page, and site pages mirroring their URL
path the way `refs-shopify-docs.ts` already does (`toLocalPath`).

### 7.2 `competitorInto(staging, competitor)`, in `scripts/refs.ts`

Kept in `refs.ts` rather than split into a sibling module. `refs-shopify-docs.ts` earns its
own file by being a genuinely different acquisition strategy (first-party `.md` endpoints plus
a React Router data decode, ~700 lines); the competitor fetch is the ordinary
fetch-and-convert path this script already needed, and splitting it out bought nothing but
another file to open. It reuses `RefsError` and the existing spawner rather than introducing a
parallel error type. The steps:

1. GET the App Store listing → `listing.html` → convert → `listing.md`.
2. If `site`: resolve the URL list (explicit `paths`, or `<loc>` entries from `sitemap`), GET
   each, convert, discard the HTML.
3. If `crawl`: hand off to the ported `crawlInto`.
4. Run `repairCrawledMarkdown` over the staging dir (§6 below), then the image post-pass — the
   `localizeImages` function in `refs-shopify-docs.ts` is already generic over a staging dir and
   only needs its `IMAGE_URL_RE` host allowlist parameterised.

### 7.3 What to port back from prelive, and what to leave

Port: the `Crawl` interface (dropping `filterAssetsToo`, `convertAssetPages`, `inlineFigure`,
`versionFrom`, `ignore` — none apply to a two-page SPA), `crawlInto`, `assertCrawler`,
`htmlToMarkdown`, `repairCrawledMarkdown`/`repairHeading`, and `allFiles` (baton's
`refs-shopify-docs.ts` already has its own copy of `allFiles`; the two should merge).

`repairHeading` is worth porting even though these are marketing pages, not API references: the
mangling it fixes (`_`, `*`, `[`, `]` in heading lines each replaced by a bare `\`) is a converter
bug, not a property of any one site, and it is unconditional in prelive for that reason. A
product page with a heading like `Produced ≠ fulfilled` is fine, but one containing `line_item`
or `[beta]` would silently lose it.

Leave behind: `FluidTopics` entirely, `flattenExternalAssets` (no cross-domain asset hosts in
scope), `rescueInlineFigure`, and the `--max-queue-length` / `--max-visited-urls` runaway guards
tuned for thousand-page manuals — though keeping them costs nothing and the JSDoc explaining
*why* they exist is the valuable part.

## 8. Implementation plan (done)

1. Port the trimmed `Crawl` machinery from `../ableton-extension-prelive/scripts/refs.ts` (§7.3),
   including its JSDoc — the sharp edges it documents were paid for once already.
2. Write `scripts/refs-competitors.ts` (§7.2), reusing `refs-shopify-docs.ts`'s
   `canonicalizeDocUrl`, `toLocalPath`, `persist` and `localizeImages`. Factor the shared pieces
   rather than copying them a third time.
3. Add the five `REFS` entries (§7.1), each carrying a JSDoc for its site-specific facts:
   kanbanify's SPA shell, MakerBatch's 404 root, fleartex's robots posture.
4. Tune `--markdown-exclude-selector` for `apps.shopify.com` (navbar categories, footer category
   table, related-apps carousel) and kanbanify (cookie banner). Verify by diffing the output, not
   by trusting the exit code — a stale selector fails silently.
5. `pnpm typecheck && pnpm lint`, then fetch all five and read the output before committing.

## 9. What the build changed, and what it caught

Two bugs the verification pass caught that the plan had not anticipated:

- **The nav strip failed twice, for two different reasons.** The converter emits site
  navigation as a `<details><summary>...</summary>` block that no `--markdown-exclude-selector`
  can remove (`header`, `nav` and the navbar's own id each leave the output byte-identical,
  because the wrapping happens after the selectors run). First the strip was anchored to the
  start of the file, but each page carries `source_url` frontmatter by the time it runs, so it
  matched nothing. Then, anchored per line, it was still keyed to the literal label `Menu` --
  and the converter emits `Links` for the same navbar on these pages, so it silently kept
  matching nothing while a check grepping for `Menu` reported success. It now matches any
  `<summary>` label and keys on the block containing `surface_type=navbar` links instead.
  The lesson is the one this document already records about selectors: a chrome filter that
  stops matching fails silently, so the check has to look for the chrome, not for the filter's
  own assumption about it.
- **Image links needed resolving, not just matching.** Unlike the shopify.dev refs, these pages
  reference images root-relatively (`/shots/queue.png`), which resolve to nothing locally. Each
  link is resolved against the URL its page came from, which is why `localizeImages` carries a
  `sources` map rather than a bare regex. 59 images localized across the five refs, 0 broken
  local links.

The carousel-leak guard in `downloadInto` is a direct consequence of §4.2: a
`--markdown-exclude-selector` that stops matching fails silently, and the failure mode here
writes *other apps'* review counts into a file whose purpose is review-count evidence. So the
fetch asserts the carousel is gone rather than trusting the crawler's exit code.

Verified after the final fetch: 0 nav blocks, 0 foreign review counts, 0 broken image links,
`Data access` present in all five listings, and the Purple Carrot review body present in
`refs/route-to-ship/reviews.md`.

## 10. Open items

- **Kanbanify's cookie-consent banner** is still the first line of `refs/kanbanify/index.md`.
  One line, from the crawl path; left rather than guessing at a selector whose silent rot would
  be worse than the noise.
- **The inline-element concatenation artifact** (§4.1): `<span>3</span><span>team members</span>`
  converts to `3team members`, so a grep for `3 team members` misses. Values are all recoverable.
  Left as-is, deliberately.
- **Route to Ship's `/demo`** fetched successfully but is likely a video/booking embed; worth a
  look before citing it as a screen.

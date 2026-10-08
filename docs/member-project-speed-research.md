# Research: the member project as the next speed target

Opened 2026-10-07, after `docs/e2e-speed-plan.md` landed (91 tests, 4.3 min; the embedded
project at about 130 s with its boots). The member project is the largest remaining block.
This records what it costs, where the cost is, what could be done, and whether any of it could
move to the Vitest browser project instead. Measured against the running dev server on
2026-10-07; every number below is from those runs. Reviewed the same day: the leak chain was
checked against the dev server's client transforms, the module count was re-measured, and the
fix was applied for a minute and measured (see "Verified" below).

## What the member project is

Three specs, 45 tests, served off `http://localhost:$PORT` with no tunnel and no admin:

| spec                         | tests | what it signs in                              |
| ---------------------------- | ----- | --------------------------------------------- |
| `member-runs.member.spec.ts` | 40    | two members once in `beforeAll`, cookies kept |
| `member-area.member.spec.ts` | 5     | per test, as the test requires                |
| `admin.admin.spec.ts`        | 7     | one admin once in `beforeAll` (admin project) |

Run alone with `--project=member`: 1.7 min wall, 45 passed, and the per-test durations sum to
about 95 s. The rest is the `beforeAll` sign-ins. Per test the spread is narrow: 1.2 s for the
cheapest (a row-shape test: seed, open the list, read one line) to 4.0 s for the most expensive
(the deepest-read test, which opens the list several times). The median is about 1.8 s.

## Where a test's time goes (measured)

A script against the dev server, signed in as the maker, repeated four times:

| step                                                               | time           |
| ------------------------------------------------------------------ | -------------- |
| a test-sized seed (2 members, 2 teams, 2 workflows, 2 orders)      | 40–90 ms       |
| the same with 29 orders (the paging tests' shape)                  | 125–155 ms     |
| `browser.newContext` with the cookie jar, plus `newPage`           | 90–100 ms      |
| `page.goto` of the workflows list to `data-hydrated`               | 1,090–1,170 ms |
| rows visible after hydration                                       | 5 ms           |
| socket identified (a row menu enabled)                             | 10 ms          |
| a client-side navigation (a strip cell, URL changed, loaders done) | 90–120 ms      |
| a magic-link sign-in (`signIn`)                                    | 1,700 ms       |

Two corrections to the first speed research:

- **Seeding is not a cost here either.** The 0.8 s figure was the `pnpm seed` fixture with 75
  orders. A spec's seed is a twentieth of that. Forty-five seeds are about 3 s of the 95.
- **The socket is not a cost.** Identify lands 10 ms after hydration.

So a member test is, to within a few hundred milliseconds, one document load. The cheapest test
is 1.2 s because the load is 1.1 s. Forty-five tests pay about 50 s of their 95 s in document
loads; the tests that open two members' pages, or reopen the list, pay two or three.

## Why a document load is 1.1 s on localhost

The document itself is not the cost: the server answers the workflows list in 30 ms with 16 KB
of HTML. The load is 941 requests, 934 of them scripts (re-measured on `/login`, which needs
no sign-in and loads the same graph: the route tree imports every route's non-component half,
so every document pays the same modules), each a separate module of Vite's unbundled dev
graph, and the browser's hydration waits for all of them. The slowest single request is
Polaris from the CDN at about 100 ms; the rest is the count.

By package, from the initiator of each request (CDP `Network.requestWillBeSent`):

| modules | package                                            |
| ------- | -------------------------------------------------- |
| 254     | kysely                                             |
| 185     | better-auth                                        |
| 96      | @better-auth/core                                  |
| 79      | zod                                                |
| 73      | `src/`                                             |
| 54      | jose                                               |
| 42      | @tanstack/react-router                             |
| 36      | @tanstack/router-core                              |
| 20      | @tanstack/start-client-core                        |
| 12      | better-call                                        |
| 9       | @noble/hashes, @opentelemetry/semantic-conventions |

About 620 of the 939 modules are better-auth's server side and what it depends on, and none of
it belongs in a browser. The chain, the same for every one of them:

```
better-auth (server)  <- src/lib/Auth.ts
                      <- src/lib/AdminServerFnMiddleware.ts
                      <- src/routes/admin.orphan-shop-agent-objects.tsx  (and the other admin routes)
                      <- src/routeTree.gen.ts
                      <- src/router.tsx
                      <- src/client.tsx
```

The mechanism: `AdminServerFnMiddleware.ts` exports two things. `adminServerFnMiddleware` is
a `createMiddleware().server(...)`, whose body TanStack Start strips from the client build. But
`requireAdmin` beside it is a plain module-level `Effect.gen` that reads `Auth`, and nothing
strips that, so the `Auth` import survives on the client, and `Auth.ts` imports `betterAuth`,
its Kysely adapter, the magic-link plugin, `Repository`, `KV` and `Email`. The admin routes
import the middleware at module level (they must, for `.middleware([...])`), `routeTree.gen.ts`
imports every route, and the router imports the tree. So every page of the app, including the
merchant's embedded screens, loads the authentication server's module graph.
`MemberServerFnMiddleware.ts` has no such export and leaks nothing on its own; it is reached
through the same `Auth.ts` once that is in the graph.

**This is a product defect, not a test one.** The production client bundle confirms it:
`dist/client/assets/index-*.js` is 1.30 MB, 369 KB gzipped, and holds `betterAuth`,
`createKyselyAdapter`, `magicLink`, `SelectQueryBuilder` and `jose`, beside separate chunks for
Kysely's bun, node and D1 SQLite dialects. A merchant downloads the authentication server to
read the orders index. The fix (below) is a few lines, and it is the first lever for the suite
because it shortens every document load in every project, and the merchant's too.

## Levers

In order of payoff, with the measurement each rests on.

### 1. Keep the server out of the client graph (product fix; largest)

Move `requireAdmin` out of `AdminServerFnMiddleware.ts` into a module that only server-side
code imports (an `AdminAccess.ts` beside `MemberAccess.ts`, which is the same shape: the
member's guard already lives apart from its middleware and is imported only inside server
function handlers, which the compiler strips). `admin.tsx` then imports the guard from there;
its use is inside a `createServerFn` handler, which the client build drops along with the
import. The middleware module keeps only the `.server()` chain.

Then pin it so it cannot come back. The first draft of this research offered two candidates
(grep the built client chunks for `betterAuth`, or assert a module count); both are
superseded by what TanStack Start already ships. **Import protection**
(`refs/tan-start/docs/start/framework/react/guide/import-protection.md`; the plugin is in
`@tanstack/start-plugin-core` 1.171.40 under `dist/esm/import-protection/`, wired into the
Vite plugin, enabled by default) checks every import of every file under `src/` in each
environment and denies the ones that cross. Today it denies only `*.server.*` files and
`@tanstack/react-start/server` on the client, which is why it has said nothing about this
leak. Two rules close it:

- `importProtection.client.specifiers: [/^better-auth(\/|$)/, /^kysely(\/|$)/]` in
  `vite.config.ts`: the two packages that cost, denied by raw import string, wherever they are
  reached from.
- `import "@tanstack/react-start/server-only"` at the top of `Auth.ts` (the file is the
  concept: it holds the better-auth instance, the Kysely adapter, the plugins) and of
  `Repository.ts` (the D1 store). A marked file imported from the client is denied with a
  trace from the route entry to the offending line.

Its build-mode check runs after tree-shaking, so a build violation is definitive and
`pnpm build` (which every deploy script runs) fails on the leak. Its dev default is `mock`:
warn once in the Vite log and replace the module with a Proxy, which an agent would not see.
Set `behavior: "error"` so the dev server refuses the request with the trace; the docs warn
that dev can report an edge that tree-shaking would later remove, and that is the right
answer here because the rule for this repo is that the edge does not exist at all. Type-only
imports are exempt, so `import type` of `Domain` shapes through a marked file still works.

**Verified.** The fix was applied for a minute (an `AdminAccess.ts` holding `requireAdmin`,
the middleware importing it, `admin.tsx` importing it) and `/login` measured three times:

| load            | requests | scripts | to `data-hydrated` |
| --------------- | -------- | ------- | ------------------ |
| today           | 941      | 934     | 1,020–1,050 ms     |
| after the split | 210      | 204     | 340–450 ms         |

The client transform of the new middleware module holds one import, `createMiddleware`, the
same as `MemberServerFnMiddleware.ts` does today. The graph after the fix is the 64 modules
under `src/`, the router and Start client (about 100), Vite's prebundled deps (Effect, React)
and Polaris. The first draft guessed about 320; the rest is prebundled. The document load
falls by about 0.65 s. Across the member project's roughly 50 document loads that is about
30 s of 95. The embedded project's boots are dominated by the admin and the tunnel, so the
gain there is smaller but real: the app iframe's hydration is the same module graph through
the tunnel.

Also the production bundle: index from 1.3 MB to something under half, which is the merchant's
first paint on every screen.

### 2. One page per member per spec (test change; second)

The embedded specs' pattern, on the member side: `beforeAll` signs in and opens one page per
member; each test seeds, then reaches its state by a client-side navigation (a strip cell, the
team select, a row link, the bar's mark) at about 0.1 s instead of a `page.goto` at 1.1 s
(or whatever lever 1 leaves it at). Saves about 1 s per document load avoided today, and
about 0.3 s after lever 1: about 45 s today, about 15 s after lever 1.

What it costs. `member-runs.member.spec.ts` is 2,000 lines and 40 tests, most of which open the
list by URL with `?state=` because the test is about rows, not about getting there. Each
would open by a strip cell instead, which exists for every state. The tests that prove a live
update between two members keep two pages, one per member, which the pattern allows. The
tests that need a fresh context (the revocation test, "removing a member closes the shop page
on their live session") keep opening one. Serial mode applies, so a failure skips the rest of
the spec, as the embedded specs accept. The `data-navigating` marker and `awaitNavigated` are
already there for the wait after a client navigation; the member list is the same router.

Do this after lever 1 and only if the remaining gap matters: at 15 s for a 2,000-line
rewrite, it may not.

### 3. Sign in less (small)

Three `beforeAll` sign-ins (maker, mate, admin) at 1.7 s each, plus the sign-ins inside
`member-area.member.spec.ts`, which are the thing under test there. The cookie jars could be
exported once per run to disk, as `setup` does for the Shopify admin, and the three specs could
replay them. Saves about 5 s. Not worth a file until the two above are in.

### 4. Vite dependency prebundling (not a fix)

`optimizeDeps.include` for better-auth and Kysely would fold their 620 modules into a few
prebundled files in dev and cut the load without touching the leak. It would leave the
production bundle as it is, which is the half that matters. Listed so it is not proposed
again.

### 5. Parallel workers and a second store

As deferred in the first research: not until the above are measured.

## Could any of it be a Vitest browser test instead?

The question asked on 2026-10-07: whether some of the member tests, or pieces of them, belong
in `test/browser/` rather than in Playwright.

**What the browser project is today.** Two files, both hook tests: the socket provider
(`shop-agent-socket-host.test.tsx`) and `useLiveQuery` (`use-live-query.test.tsx`), rendered
with `vitest-browser-react` in a real headless Chromium through `@vitest/browser-playwright`.
They exist because those hooks need a real `WebSocket`, `document.visibilityState` and timers,
which workerd cannot give. No Polaris script is loaded, no router, no server.

**What would have to be true to render a screen part there.** Polaris web components come
only from the CDN: `https://cdn.shopify.com/shopifycloud/polaris.js`, 740 KB, 110 ms on this
connection; `@shopify/polaris-types` in `package.json` is types alone, and there is no npm
runtime. The app itself loads that URL, unversioned, on every document, so the test would use
exactly what the product uses, with the same drift. A setup file would append the script tag
and await `customElements.whenDefined("s-box")` once per test file. The parts are plain React
over Polaris elements with no router: `ResourceRow`, `RowLine`, `Clamp`, `Strip`,
`ClampedProse` import nothing from TanStack. `dev.kit.tsx` already composes them with the
seed's worst cases, which is the test's fixture ready-made.

**What that gives.** The tests whose rule is "how a part lays out a given string under
Polaris's CSS", with nothing on the other side of a request. In `member-runs.member.spec.ts`
these are the five at the end:

| test                                                                              | what it reads                                                        | cost  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- |
| a 64-character task name is shown whole on the workflows list                     | `scrollWidth` of a row line                                          | 1.3 s |
| a block reason shows two lines on the workflows list                              | the clamp inside `s-paragraph`'s shadow root                         | 1.3 s |
| an email in Started by does not widen the row                                     | `scrollWidth` of the card and the document                           | 1.3 s |
| the workflow name is printed only when it differs from the item title             | `Domain.runRowLines`' last line (already pinned in `domain.test.ts`) | 1.4 s |
| the member's workflow page is headed by the order and prints the item title whole | the heading's clamp                                                  | 1.3 s |

Plus, in `workflows.spec.ts`, the countdown half of "the editor counts instructions down from
300 and refuses 501 on save" (the 501 refusal is a server function and stays).

In the browser project each is a `render` of `ResourceRow` with `runRowLines`' output and
the same `evaluate`, in milliseconds, with no dev server. About 8 s leaves the e2e run.

**Does the CDN fetch hit the network every time?** Yes, under both test runners, and a
local cache would not change much. The CDN answers with `cache-control: max-age=60,
stale-while-revalidate=300` and a `last-modified` of the same day (Polaris is republished
unversioned at that URL; on 2026-10-08 the file was an hour old). A fresh Chromium cache
would serve it for a minute and then revalidate on every load. Neither runner keeps a cache
anyway: Vitest's browser provider launches a fresh Chromium profile per run, and Playwright
gives each `browser.newContext` its own empty cache, which is why every e2e page load pays
the 100 ms for Polaris as well, in every project, today. So in the browser project the fetch
is once per test file per run, about 100 ms each, and never served from disk. If that
dependence is unwanted, the alternative is a vendored snapshot: a script fetches
`polaris.js` into a gitignored file (as `scripts/refs.ts` does for `refs/`, with a check that
reports drift against the CDN's `last-modified`), and the setup file loads that instead. It
makes the file deterministic and offline, at the cost of a snapshot that is by construction
behind what the product loads, since the product's URL is unversioned. The research's
reading: take the CDN and the 100 ms, and vendor only if `pnpm test` ever has to run offline.

**What it does not give.** Everything else in the member project is the cookie reaching the
Worker, the socket carrying a write, a loader's answer, a redirect, or history. The browser
project has no Worker behind it, so a click that writes has nothing to write to. Thirty-five
of the forty tests stay where they are.

**Assessment.** Feasible, and small. The honest reasons to do it are quality, not time: the
row-shape rules would run under `pnpm test` with no dev server, fail on the part rather than on
a seeded screen, and stop needing a seed whose only purpose is to put a long string on the
screen. The reasons not to: a new setup file and a CDN dependency in a project that has none
today (an offline `pnpm test` would fail that file), and 8 s is 3% of the run. Do it, if at
all, as part of the member work, not for speed.

## Expected result

| after                 | member project                | whole run (today 4.3 min) |
| --------------------- | ----------------------------- | ------------------------- |
| lever 1 (the leak)    | 70 s measured (60.6 s summed) | 3.3 min measured (201 s)  |
| levers 1 and 2        | about 50 s                    | about 3.4 min             |
| plus the browser move | about 45 s                    | about 3.3 min             |

The lever 1 row is measured (2026-10-07, after the split and the pin); the other rows are
estimates made before it, against a 4.3 min whole run.

## Decisions (2026-10-07)

Taken in Plannotator on 2026-10-07; all four recommendations accepted as written.

1. **The leak fix (lever 1) is part of this work**, not a plan of its own: the plan that comes
   out of this research starts with it, measures the document load after it, and takes the
   rest from there.
2. **Lever 2 is parked.** After the leak fix a document load is about 0.4 s, so one page per
   member per spec saves about 15 s for a 2,000-line rewrite of `member-runs.member.spec.ts`
   that also changes how most of its tests reach their state. If the suite's length matters
   again, the first research's "parallel workers and a second store" is the next lever and
   costs no rewrite.
3. **The browser move is not now.** The quality argument stands (a row-shape rule fails on
   the part, under `pnpm test`, with no seed), but it adds a CDN fetch to a project that has
   none and saves 8 s. Do it the next time a row-shape rule changes, as part of that change,
   with the five tests and the countdown listed above as the scope.
4. **The pin is import protection**, in the same change as the split: `behavior: "error"`
   in dev and build, the `better-auth` and `kysely` specifiers denied on the client, and the
   `server-only` marker on `Auth.ts` and `Repository.ts`. The default `mock` in dev would
   hide the next leak behind a log line nobody reads.
5. **The new module is `AdminAccess.ts`** beside `MemberAccess.ts`, holding `requireAdmin`
   with its JSDoc moved whole, so the two files mirror each other as the member one's JSDoc
   already describes. Lever 3 (sign in less) stays parked.

The plan is `docs/member-project-speed-plan.md`.

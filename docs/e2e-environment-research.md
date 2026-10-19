# E2E environment: research

Status: open, written 2026-10-19 after the public pages and help slice. Nothing is decided and no code has changed. For a review with the user, then a plan.

The question: the e2e suite costs too much time and too many tokens, and keeps failing for reasons that are not the code under test. What should the e2e environment be (servers, tunnels, data, parallelism) so that a run is fast, starts reliably, and a failure means a bug?

---

## 0. The short version

- **Most lost runs come from the environment, not the specs.** Since 2026-10-17: app frames that never hydrated (a proxy defect, since patched), a Cloudflare quick-tunnel rate limit (an hour of runs), a hot reload mid-run, and today a new tunnel hostname that was not in DNS yet. The specs' own failures (brittle locators, a Polaris quirk) were found and fixed quickly.
- **Every run rebuilds the whole environment.** Playwright starts `scripts/e2e-server.ts`, which destroys the checkout's e2e stage and starts `shopify app dev`, which opens a **new random quick tunnel**, pushes that URL to Shopify, and boots `alchemy dev`. Nothing checks that the tunnel answers before `install` loads the app through it. Legacy ran a long-lived server and checked that the tunnel answered first.
- **"One e2e server for every worktree" does not fit**, because a server runs one checkout's code, and a worktree runs e2e to test its own changes. The unit is **one long-lived e2e server per checkout**.
- **Recommended direction** (§4): a long-lived e2e server per checkout, started once like `vp run dev`; a data reset per run instead of a stage destroy; a fixed tunnel hostname per checkout (named Cloudflare tunnel, `shopify app dev --tunnel-url`); a preflight that the app answers through the tunnel; then parallel embedded specs, with the session-breaking spec isolated.

---

## 1. What exists today

### 1.1 Servers and checkouts

| Piece        | Today                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkouts    | `main` plus worktrees `wt-01`…`wt-03` (`git worktree list`), each its own `.env` (`worktree:init`).                                                                                                                                                                             |
| Dev server   | `vp run dev` per checkout, long-lived: `shopify app dev` on `mw10013-dev-shop-NN`, its own quick tunnel, `alchemy dev` on stage `dev_<user>[_wtNN]`. On 2026-10-19 four ran at once (main and three worktrees idle since 10-16/10-17); the three worktree servers were stopped. |
| E2E server   | Per **run**, per checkout. `playwright.config.ts` `webServer` runs `vp run test:e2e:server` and waits for `http://localhost:<e2ePort>/` (180 s). `reuseExistingServer` only with `E2E_REUSE_SERVER=1`.                                                                          |
| What it does | `scripts/e2e-server.ts`: `checkStores` (dev and e2e stores exist, on `basic`), `alchemy destroy --stage <e2eStage> --yes`, then `shopify app dev --config shopify.app.toml --store $SHOPIFY_E2E_STORE` with `SANDBOX_ENVIRONMENT=e2e`.                                          |
| Stage        | `scripts/lib/worktree.ts` `stage("e2e")`: `e2e-mw` (main), `e2e-mw-wt-NN` (worktrees).                                                                                                                                                                                          |
| Port         | `WEBSITE_PORT + 100` (`E2E_PORT_OFFSET`); main's is 4000.                                                                                                                                                                                                                       |
| Store        | `SHOPIFY_E2E_STORE`, `mw10013-e2e-shop-NN`, one per checkout index (main 00). Stores 00–09 exist (`docs/shopify-stores-runbook.md`); each needs store auth and a plan picked.                                                                                                   |
| Shopify app  | One app for dev and e2e (`shopify.app.toml`, handle `baton-local`); every `shopify app dev` is a dev preview on its own store.                                                                                                                                                  |
| Logs         | `.logs/e2e/current`.                                                                                                                                                                                                                                                            |

The readiness check is a localhost `GET /`. It says nothing about the tunnel, which is the path the admin uses.

### 1.2 The chain an embedded load goes through

Admin page (admin.shopify.com) → iframe → **quick tunnel** (`*.trycloudflare.com`, new per run) → Shopify CLI proxy (sends `Connection: close`) → Alchemy `WorkerProxy` → workerd → Vite (cold, unbundled modules; ~250 requests on a cold load).

Every hop is a place a run has failed (§2). The proxy defect is patched (`patches/@alchemy.run__cloudflare-runtime@…patch`, see `docs/e2e-flakiness-research.md`).

### 1.3 Data

- **Seed** (`seed/e2e.sql`): one admin, `a@a.com`. Shop data cannot be seeded: shop rows need a `ShopSession`, which only the first embedded load writes (token exchange). `src/backend/seed.ts` says so.
- **Setup projects**, in order: `shopify-admin` (refresh the exported admin cookies from Chrome when older than a day; may raise a Keychain prompt) → `install` (open the app in the store admin, which writes the `ShopSession`; then `LoadFixture` with `e2eFixture`: members m1, m2, team `ops`) → `setup` (sign in `a@a.com` and `m1@m.com`, save storage states).
- **Isolation by convention** (`docs/testing-research.md` §2.3): only setup loads the fixture; each spec adds its own rows through `DevRpcs.AddToFixture` under test-id-derived names (`fixtures.ts` `testEmail`, `own()`, `ownMember`), and asserts only on its own rows. No reset call exists; `DevRpcs` has `LoadFixture`, `AddToFixture`, `RemoveMember`, `RemoveOrder`, `GetShopSession`, `ExpireShopSession`.
- **Shared state that specs touch:** the store's one session row (every embedded load exchanges a token on it; `refresh.spec` expires it on purpose); one `ShopActor` per shop (sockets, live reads); real Shopify orders (`orders.spec` creates and cancels them on the e2e store).

### 1.4 Parallelism and size

| Project    | Runs                                        | Files / tests     | Why                                                                                                                                    |
| ---------- | ------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `chromium` | parallel (CPU workers)                      | 9 / ~32 (+6 help) | public and member pages; own rows per test                                                                                             |
| `embedded` | `workers: 1`, serial per file, 60 s timeout | 10 / ~47          | one session row for all files (a load in one file breaks `refresh.spec` mid-run); one admin boot per file (seconds through the tunnel) |
| `billing`  | only with `E2E_BILLING=1`, headed           | 1                 | Shopify's pricing page challenges headless browsers                                                                                    |

Measured: full run 6.3 min on 2026-10-19 (83 tests). Earlier: 4.3–5.4 min at 49 tests; 5.1–5.7 min at 59–72. App loads: median ~3.1–3.3 s, max 6–9 s. The embedded project is most of the wall time.

---

## 2. What has gone wrong

From every plan's §7 and `docs/e2e-flakiness-research.md`.

| Date  | What                                                                                                                                                                                                              | Class                    | Status                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| 10-17 | `embedded/app.spec` hydration timeout, a Polaris icon fetch failing; passed on re-run                                                                                                                             | environment (proxy)      | root-caused 10-18                                                  |
| 10-17 | Baseline run broken: a `src/` edit hot-reloaded the e2e Backend mid-run ("Service not found: ShopActor")                                                                                                          | environment (hot reload) | rule: no `src/` edits during a run                                 |
| 10-17 | Three full runs each lost a different embedded spec at the hydration wait                                                                                                                                         | environment (proxy)      | root-caused 10-18                                                  |
| 10-18 | `refresh.spec` and `install` lost to the hydration wait; 3 of ~9 runs                                                                                                                                             | environment (proxy)      | fixed: pnpm patch to `WorkerProxy`                                 |
| 10-18 | Same-URL GET stuck behind Chrome's cache lock (`getShopifyApp`)                                                                                                                                                   | app bug                  | fixed: POST                                                        |
| 10-18 | trycloudflare rate limit (HTTP 429 / 1015), ~13:57–14:56: no run could start the server                                                                                                                           | environment (tunnel)     | open                                                               |
| 10-18 | `orders.spec` 5 rows not 25: Polaris drops Previous while loading; strict-mode locator ("Orders")                                                                                                                 | spec                     | fixed                                                              |
| 10-19 | `orders-pages.spec` twice: briefly duplicated search field                                                                                                                                                        | spec / Polaris           | fixed: open on `?q=`                                               |
| 10-19 | Billing run's `install` timed out on a cold tunnel; stale `admin.json`                                                                                                                                            | environment (tunnel)     | `billing` now depends on `setup`                                   |
| 10-19 | `run.test.tsx` (browser, not e2e) note modal: `fill` appended under load; failed in two slices before it was read                                                                                                 | test                     | fixed                                                              |
| 10-19 | Two full runs lost in `install` before any spec: the app loaded ~100 ms after the CLI's Ready, while the new tunnel's hostname did not resolve yet (`ERR_NAME_NOT_RESOLVED`; resolver 1.1.1.2, negative TTL 60 s) | environment (tunnel DNS) | open                                                               |
| 10-19 | `shell.spec` strict-mode: the new landing has two **Sign in** links                                                                                                                                               | spec (slice change)      | fixed; the implementer did not run the spec that reads the landing |

Patterns:

1. **The environment is rebuilt every run**, so every run pays its startup and exposes every hop of §1.2 fresh: new tunnel, new DNS name, cold Vite, new stage.
2. **Failures in setup are total.** `install` failing skips all 81 other tests; a reader sees "1 failed, 81 did not run" and re-runs.
3. **No preflight.** Readiness is localhost; the tunnel path is first exercised by `install`.
4. **Re-running was the reflex.** The cost is not one run (~6 min) but the loop around it (tokens, attention, hours on 10-18).

---

## 3. Constraints that shape the answer

- **A server runs one checkout's code.** A worktree's e2e tests its uncommitted changes, so it cannot share main's server. Sharing is possible only between runs of the **same** checkout.
- **The admin's iframe loads the app over HTTPS from the local browser,** so a public URL is needed only for what Shopify itself calls. `shopify app dev --use-localhost` serves on `https://localhost` with a local certificate. The admin page runs in the local browser, so the iframe can load localhost. But webhooks (Shopify → app) need a public URL, and `orders.spec`/`refresh.spec` rely on real orders and webhooks.
- **`shopify app dev --tunnel-url https://host:port`** uses a tunnel that is already running instead of a quick tunnel. A named Cloudflare tunnel (`cloudflared tunnel`, a DNS route on a zone we own) gives a fixed hostname per checkout: no new DNS name per run, no quick-tunnel rate limit, and the app URL Shopify holds stays the same.
- **The session row is shared.** Every embedded load exchanges a token on the store's one `ShopSession`. Parallel embedded loads on one store race on that row (the config comment on `embedded`'s dependencies says so); `refresh.spec` expires it on purpose.
- **E2E stores are plentiful.** `mw10013-e2e-shop-00`…`09` exist (one per checkout index today). More shops per checkout would give each embedded worker its own session row, at the cost of store setup (store auth, a plan picked) per shop.
- **A long-lived server hot-reloads.** Editing `src/` while a run is in progress breaks it (10-17). Today's restart-per-run hides this; a long-lived server makes the rule matter.
- **Billing stays headed and by hand.** Out of this research except where it shares setup.

---

## 4. Options

### 4.1 Server lifetime

- **A. Restart per run (today).** Clean slate, no stale state; pays startup (~1 min) and the fresh-tunnel risk every run.
- **B. Long-lived per checkout (recommended).** `vp run e2e:start` / `e2e:stop` / `e2e:status`, like `vp run dev`; Playwright `reuseExistingServer: true` and fails fast with "start the e2e server" if it is not up. A run resets data (4.2) instead of destroying the stage. Legacy did this.
- **C. One shared e2e server for all checkouts.** Rejected by §3's first constraint, unless only `main` runs e2e (worktrees would rely on main after merge).

### 4.2 Data between runs (needed by B)

- **Reset call:** a `DevRpcs.ResetShop` (or `ResetStage`) that deletes the e2e shop's rows and its actor's storage, then `LoadFixture`. Keeps the `ShopSession` so `install`'s token exchange is not needed every run. Care: the actor's storage delete needs `storage.sync()` (staging lesson, 2026-10-17).
- **Keep convention-based isolation** (own rows per test); the reset only removes the leftovers of previous runs so tables do not grow.
- **Alternative:** destroy only the D1 database and actor namespace, not the whole stage. Heavier, closer to today.

### 4.3 Tunnel

- **Named tunnel per checkout (recommended):** `cloudflared` with a fixed hostname, e.g. `e2e-00.<zone>`, `dev-00.<zone>`; `shopify app dev --tunnel-url`. Needs a Cloudflare zone; one-time `cloudflared tunnel create` per hostname. Removes the DNS race, the 429s, and per-run URL pushes. Could apply to dev servers too.
- **Preflight (cheap, independent of the rest):** before Playwright starts specs, fetch the app through the public URL until it answers (bounded, e.g. 60 s), and fail with a clear message otherwise. Fixes 10-19's failures even with quick tunnels.
- **`--use-localhost`:** no tunnel at all for loads; loses webhooks. Possible for a "no-webhook" embedded subset only.

### 4.4 Parallel embedded specs

- **Isolate the session-breakers:** `refresh.spec` (expires the session) into its own project that runs after `embedded`.
- **Then several workers on one store:** each worker its own admin page; the token-exchange race on the one session row has to be checked (make the exchange idempotent, or serialize only the first load).
- **Or one store per worker:** workers × e2e stores per checkout; each worker installs on its own store. Most isolation, most setup.
- **Measure first:** per-file wall time, admin boot time, and how many loads run at once before the tunnel/Vite slow down.

### 4.5 Process

- A setup failure stops the run and prints the cause; nobody re-runs a run whose setup failed without reading the error.
- A run's environment problems are logged once in a ledger (this doc's §2) rather than in each plan's §7.
- Scoped e2e (`vp run test:e2e <spec>`) for implementers should include every spec that reads a changed screen (`shell.spec` missed on 10-19).

---

## 5. Measurements to take before deciding

1. Time to start the e2e server today, split: stage destroy, CLI start, tunnel ready, DNS resolvable, first `GET /` through the tunnel.
2. Per-project and per-file wall time of a full run; admin boot per file.
3. A full run against an already-running server (`E2E_REUSE_SERVER=1`), to bound what B saves.
4. Two and four embedded workers on one store: does the token exchange race, and how do load times move?

---

## 6. Questions

:::question
Q1. Where does the e2e server live?

- [ ] Long-lived per checkout, started like `vp run dev` (B)
- [ ] Restart per run, as today, plus a tunnel preflight (A)
- [ ] One shared server; only `main` runs e2e (C)

Recommended: Long-lived per checkout (B)
:::

:::question
Q2. How is data reset between runs on a long-lived server?

- [ ] A `ResetShop` dev call (rows and actor storage), then `LoadFixture`; session kept
- [ ] Destroy the D1 database and actor namespace per run
- [ ] No reset; rely on own-rows isolation and let tables grow

Recommended: A `ResetShop` dev call
:::

:::question
Q3. Which tunnel?

- [ ] Named Cloudflare tunnel per checkout, fixed hostname, `--tunnel-url` (needs a zone)
- [ ] Keep quick tunnels, add a preflight
- [ ] `--use-localhost` for loads, webhook specs on a tunnel

Recommended: Named tunnel per checkout; the preflight lands first either way
:::

:::question
Q4. Parallel embedded specs?

- [ ] `refresh.spec` alone after; the rest on N workers, one store
- [ ] One e2e store per worker
- [ ] Stay serial; spend the effort on startup only

Recommended: decide after §5's measurements; start with `refresh.spec` isolated and 2 workers on one store
:::

:::question
Q5. Dev servers too?

The same named-tunnel setup would give each dev server a fixed URL (no new tunnel per `vp run dev`).

- [ ] Yes, same change for dev
- [ ] E2E only

Recommended: E2E first, dev after it proves out
:::

---

## 7. Out of scope

- The billing project (headed, by hand).
- Rewriting specs beyond what isolation or parallelism needs.
- CI (there is none for e2e today).

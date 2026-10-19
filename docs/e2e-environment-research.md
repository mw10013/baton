# E2E environment: research

Status: settled 2026-10-19 (§6). Written after the public pages and help slice, then checked against the code, the logs and the sources on the same day, with §5's measurements taken. No code has changed. Next: a plan.

The question: the e2e suite costs too much time and too many tokens, and keeps failing for reasons that are not the code under test. What should the e2e environment be (servers, tunnels, data, parallelism) so that a run is fast, starts reliably, and a failure means a bug?

---

## 0. The short version

- **Most lost runs come from the environment, not the specs.** Since 2026-10-17 the causes were: app frames that never hydrated (a proxy defect, patched 10-18), a quick-tunnel rate limit (an hour with no run on 10-18), a hot reload mid-run, a cold first load, and a new tunnel hostname that was not in DNS yet (10-19). The specs' own failures were found and fixed quickly.
- **Every run rebuilds the environment, and the tunnel is the fragile part.** Playwright starts `scripts/e2e-server.ts`. It checks the stores, destroys the checkout's e2e stage and starts `shopify app dev`, which creates a **new quick tunnel** and boots `alchemy dev`. Nothing checks that the tunnel answers before `install` loads the app through it. Main and `wt-01` created about 26 quick tunnels in the hour before the 10-18 rate limit.
- **Startup is not where the time goes; the serial embedded project is.** Measured (§5): starting the server takes ~45 s. A full run against a server that is already up still takes 6.0 min, and 336 s of its 361 s are the `embedded` project running on one worker. With `refresh.spec` moved to the end, 2 embedded workers ran all 83 tests green in **3.8 min**. 4 workers ran in **2.2 min**, apart from one spec that assumes it runs alone.
- **"One e2e server for every worktree" does not fit.** A server runs one checkout's code, and a worktree runs e2e to test its own changes. The unit is **one long-lived e2e server per checkout**.
- **Decided direction** (§6, review of 2026-10-19), in this order:
  1. A tunnel preflight, because it is cheap and independent of the rest.
  2. Parallel embedded specs (4 workers, `refresh.spec` alone at the end) after a short audit of specs that assert on whole-shop state.
  3. A long-lived e2e server per checkout, with no new reset call: install's `LoadFixture` already replaces the shop's data.
- **Quick tunnels stay; named tunnels are not used.** The long-lived server is what cuts tunnel creations, and the preflight is what catches a tunnel that is not ready.

---

## 1. What exists today

### 1.1 Servers and checkouts

| Piece        | Today                                                                                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkouts    | `main` plus worktrees `wt-01`…`wt-03` (`git worktree list`), each with its own `.env` (`worktree:init`).                                                                                                                                                                                                                    |
| Dev server   | `vp run dev` per checkout, long-lived: `shopify app dev` on `mw10013-dev-shop-NN`, its own quick tunnel, `alchemy dev` on stage `dev-<user>[-wt-NN]` (`scripts/dev.ts`).                                                                                                                                                    |
| E2E server   | Started per **run**, per checkout. `playwright.config.ts` `webServer` runs `vp run test:e2e:server` and waits up to 180 s for `http://localhost:<e2ePort>/`. `reuseExistingServer` applies only with `E2E_REUSE_SERVER=1`.                                                                                                  |
| What it does | `scripts/e2e-server.ts`: `checkStores` (dev and e2e stores exist, on `basic`, via `shopify store list`), `alchemy destroy --stage <e2eStage> --yes` (local state only; dev and e2e touch nothing in the cloud), then `shopify app dev --config shopify.app.toml --store $SHOPIFY_E2E_STORE` with `SANDBOX_ENVIRONMENT=e2e`. |
| Stage        | `stage("e2e")` in `scripts/lib/worktree.ts`: `e2e-mw` (main), `e2e-mw-wt-NN` (worktrees).                                                                                                                                                                                                                                   |
| Port         | `WEBSITE_PORT + 100` (`E2E_PORT_OFFSET`); 4000 on main. The CLI's own proxy, the target of the tunnel, takes a random port.                                                                                                                                                                                                 |
| Store        | `SHOPIFY_E2E_STORE`, `mw10013-e2e-shop-NN`, one per checkout index (00 on main). Stores 00–09 exist (`docs/shopify-stores-runbook.md`). Each needs `shopify store auth` (the orders and refresh specs create orders) and a plan picked.                                                                                     |
| Shopify app  | One app for dev and e2e (`shopify.app.toml`, handle `baton-local`). Each `shopify app dev` is a dev preview on its own store, and the CLI pushes that store's app URL on every start ("Update URLs: Yes").                                                                                                                  |
| Logs         | `.logs/e2e/current`. Per-load timings go to `.logs/e2e/frame-loads.jsonl` when `E2E_FRAME_LOG=1`.                                                                                                                                                                                                                           |

The readiness check is a localhost `GET /`. It says nothing about the tunnel, which is the path the admin uses.

### 1.2 The chain an embedded load goes through

1. Admin page (admin.shopify.com)
2. iframe
3. **Quick tunnel** (`*.trycloudflare.com`, new per run; `cloudflared tunnel --url http://localhost:<CLI proxy port>`)
4. Shopify CLI proxy (sends `Connection: close`)
5. Alchemy `WorkerProxy`
6. workerd
7. Vite (unbundled modules: 256–285 requests per load, 35–88 of them in flight at the peak)

Every hop is a place a run has failed (§2). The proxy defect is patched (`patches/@alchemy.run__cloudflare-runtime@…patch`, see `docs/e2e-flakiness-research.md`).

Cloudflare documents two limits of quick tunnels that this chain is close to. Each quick tunnel "supports up to 200 in-flight requests", and requests over that cap get HTTP 429. Quick tunnels "are for testing and development" and have "no uptime guarantee" (see Cloudflare's TryCloudflare page). One load peaks under 100 requests in flight. Four parallel loads through one quick tunnel could exceed 200.

### 1.3 Data

- **Seed** (`seed/e2e.sql`): one admin, `a@a.com`. Shop data cannot be seeded: shop rows need a `ShopSession`, which only the first embedded load writes (token exchange). `seedFileFor` in `src/backend/seed.ts` says so.
- **Setup projects**, in order:
  1. `shopify-admin` refreshes the exported admin cookies from Chrome when they are no longer fresh (`adminSessionFresh`), which may raise a Keychain prompt about once a day.
  2. `install` opens the app in the store admin, which writes the `ShopSession`, then runs `LoadFixture` with `e2eFixture`: members m1 and m2, team `ops`.
  3. `setup` signs in `a@a.com` and `m1@m.com` and saves their storage states.
- **Isolation by convention** (`docs/testing-research.md` §2.3):
  - Only setup loads the fixture.
  - Each spec adds its own rows through `DevRpcs.AddToFixture`, under names derived from the test id (`testEmail`, `own()`, `ownMember` in `fixtures.ts`).
  - Each spec asserts only on its own rows.
  - `DevRpcs` has `LoadFixture`, `AddToFixture`, `RemoveMember`, `RemoveOrder`, `GetShopSession` and `ExpireShopSession`.
  - **`LoadFixture` already acts as a per-shop reset.** It replaces the shop's members, teams, workflows and orders (actor storage included) and leaves the session, Better Auth and other shops alone.
- **Shared state that specs touch:**
  - **The store's one session row.** An embedded load **reuses** a stored access token that is still fresh and exchanges only when the row is missing or near expiry (`authenticateAdmin` in `src/backend/shopify.ts`). A full run logs two exchanges: the install, and `refresh.spec`'s restore. `refresh.spec` expires and invalidates the row on purpose, and while it does, any other load would exchange.
  - **One `ShopActor` per shop**: sockets, live reads.
  - **Real Shopify orders.** `orders.spec` and `refresh.spec` create orders on the e2e store and cancel them, and the orders arrive by **webhook**.
  - **Whole-shop derived state**: the App Home's setup guide, the orders strip's counts, seat and quota meters. Any spec that adds data moves these.

### 1.4 Parallelism and size

| Project    | Runs                                                             | Files / tests | Why                                                                                                    |
| ---------- | ---------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `chromium` | parallel (default workers)                                       | 9 / 32        | public, member and admin pages; each test has its own rows                                             |
| `embedded` | `workers: 1`; each file serial with one admin boot; 60 s timeout | 10 / 47       | `refresh.spec` owns the session row; one boot per file because a boot through the tunnel takes seconds |
| `billing`  | only with `E2E_BILLING=1`, headed                                | 1             | Shopify's pricing page challenges headless browsers                                                    |

Plus `shopify-admin`, `install` and `setup`: 4 tests. That makes 83 in a full run.

**Phases.** Playwright starts `chromium` only after `embedded` has finished, even though `chromium` depends only on `setup`. `chromium` sits one level deeper in the dependency graph (`install → setup → chromium`, `install → embedded`). This was observed in all five runs of §5: in the serial run, `chromium` started at 347.8 s of 361 s. Its 12–13 s therefore add to the wall time instead of overlapping with `embedded`.

**Recorded run times:**

| Tests | Wall time   | Note                                       |
| ----- | ----------- | ------------------------------------------ |
| 49    | 3.9–5.4 min | plans and `docs/e2e-flakiness-research.md` |
| 67–72 | 5.1–5.7 min |                                            |
| 77    | 5.9–6.1 min |                                            |
| 83    | 6.3 min     | 2026-10-19                                 |
| 83    | 6.0 min     | §5, server already up                      |

App loads: median 3.1–3.3 s, p90 4.5–5.0 s, max 6–9 s (`docs/e2e-flakiness-research.md`, `.logs/e2e/frame-loads.jsonl`).

---

## 2. What has gone wrong

Sources: every plan's §7, `docs/e2e-flakiness-research.md`, `.logs/e2e/` and git history. The table keeps environment incidents and the spec failures that cost a run. Spec bugs fixed within a step are left out.

| Date  | What                                                                                                                                                                                                                                                                               | Class                       | Status                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| 10-14 | Dev and e2e shared Vite's `deps_ssr` cache: an e2e re-optimization broke the dev server (`ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR`)                                                                                                                                                | environment (shared cache)  | fixed (stages plan §16)                                            |
| 10-17 | `orders.spec` failed: no `shopify store auth` on the e2e store; a 5-run batch was invalid                                                                                                                                                                                          | environment (store setup)   | human step; in the stores runbook                                  |
| 10-17 | `embedded/app.spec` hydration timeout and a Polaris icon fetch failure; passed on re-run                                                                                                                                                                                           | environment (proxy)         | root-caused 10-18                                                  |
| 10-17 | A `src/` edit hot-reloaded the e2e Backend mid-run ("Service not found: ShopActor"); this was under today's restart-per-run server                                                                                                                                                 | environment (hot reload)    | rule: no `src/` edits during a run                                 |
| 10-17 | Three full runs each lost a different embedded spec (`socket.spec`, `teams.spec`, …) at the hydration wait                                                                                                                                                                         | environment (proxy)         | root-caused 10-18                                                  |
| 10-18 | Hydration wait lost 3 of ~9 full runs (`install`, `home.spec`, `refresh.spec`); 1 of 8 in a batch                                                                                                                                                                                  | environment (proxy)         | fixed: pnpm patch to `WorkerProxy`                                 |
| 10-18 | Same-URL GET stuck behind Chrome's cache lock (`getShopifyApp`)                                                                                                                                                                                                                    | app bug                     | fixed: POST                                                        |
| 10-18 | `install` failed with "pick a plan on mw10013-e2e-shop-00": `.env`'s `SHOPIFY_PARTNER_APP_ID` held Baton Staging's id; plans picked by hand                                                                                                                                        | environment (store setup)   | fixed; plan trial ends 2026-10-20                                  |
| 10-18 | Quick-tunnel **creation** rate-limited (error 1015), ~13:57–14:56. All 12 e2e starts on main in that window died after ~7 s with "Could not start Cloudflare tunnel: max retries reached", and `wt-01` lost 4. In the hour before, main and `wt-01` had created ~26 quick tunnels. | environment (tunnel)        | open                                                               |
| 10-18 | `orders.spec` paging read 5 rows, not 25: Polaris keeps Previous enabled but ignores a press while loading. Separately, "Orders" locators matched the admin nav and a meter tile.                                                                                                  | spec                        | fixed                                                              |
| 10-19 | `orders-pages.spec` failed twice on a briefly duplicated search field                                                                                                                                                                                                              | spec / Polaris              | fixed: open on `?q=`                                               |
| 10-19 | Billing run: `install` timed out on a cold first load (passed next run). Separately, `billing` read a stale `admin.json`.                                                                                                                                                          | environment (cold) / config | `billing` now depends on `setup`                                   |
| 10-19 | `run.test.tsx` (browser, not e2e) note modal: `fill` appended under load; failed in two slices before anyone read it                                                                                                                                                               | test                        | fixed                                                              |
| 10-19 | Two full runs (11:05, 11:06) lost in `install` before any spec: the new tunnel's hostname did not resolve (`ERR_NAME_NOT_RESOLVED`; system resolver 1.1.1.2, negative TTL 60 s), then resolved a minute later                                                                      | environment (tunnel DNS)    | open                                                               |
| 10-19 | `shell.spec` strict-mode: the new landing has two **Sign in** links                                                                                                                                                                                                                | spec (slice change)         | fixed; the implementer did not run the spec that reads the landing |

Patterns:

1. **Most environment failures are the tunnel or a cold path.** Each run creates a tunnel and a DNS name, pays for a cold Vite and a new stage, and then exposes every hop of §1.2.
2. **A setup failure is total.** When `install` fails, all 82 other tests are skipped. A reader sees "1 failed, 82 did not run" and re-runs.
3. **There is no preflight.** Readiness is checked on localhost, so `install` is the first thing that goes through the tunnel.
4. **Re-running was the reflex.** The cost is not one run (~6 min) but the loop around it: tokens, attention, and hours on 10-18. Those retry loops are also what created the tunnels that triggered the rate limit.
5. **Store setup is a hidden dependency** (auth, plan, app id). It fails like the environment, but it is configuration.

---

## 3. Constraints that shape the answer

- **A server runs one checkout's code.** A worktree's e2e tests its uncommitted changes, so it cannot share main's server. A server can be shared only between runs of the **same** checkout.
- **A public URL is needed for whatever Shopify calls itself.** The admin's iframe loads from the local browser, so `shopify app dev --use-localhost` (HTTPS on localhost, mkcert) could serve it. Shopify documents that localhost "isn't compatible with the Shopify features that directly invoke your app", webhooks among them, and `orders.spec` and `refresh.spec` depend on order webhooks. `--use-localhost` and `--tunnel-url` are mutually exclusive (`shopify app dev --help`, CLI 4.9.0).
- **`shopify app dev --tunnel-url https://host:PORT` uses a tunnel that is already running.** In CLI 4.9.0's source, the CLI parses `PORT` as its own proxy port and `https://host` as the app URL it pushes. The tunnel therefore has to route `host` to `http://localhost:PORT`. A named Cloudflare tunnel would give that a fixed hostname (not used, Q3): no new DNS name, no quick-tunnel creation limit, no 200-request cap. Available: zone `mw10013.com` (Free plan) is in the Cloudflare account `cf` is signed in to. The account has no tunnels yet, and `cloudflared` 2026.9.1 is installed.
- **A fixed hostname would make the dev endpoints public and findable** (moot: Q3 keeps quick tunnels). `/api/dev` (`DevRpcs`: `LoadFixture`, `ExpireShopSession`, …) is served on dev and e2e stages. The CLI proxy forwards every path, so `/api/dev` is reachable through the tunnel today. Only the random quick-tunnel name hides it. The e2e client calls `/api/dev` on localhost, and nothing Shopify sends needs it.
- **The session row is shared, but loads do not race on it.** Loads reuse a fresh token (§1.3). Two loads can both exchange only when the row is missing or near expiry, as when `install` and a first embedded load start together, which is why `embedded` depends on `install`. The real exclusivity is `refresh.spec`, which ages the row on purpose.
- **Specs that assert on whole-shop state break under parallelism.** Measured (§5.4): with 4 workers, `home.spec`'s guide test fails every time. It expects the "Getting started" guide, but the App Home hides the guide once all three steps are done (`setupIsComplete` in `app.index.tsx`), and `order-page.spec`, running at the same time, completes the third step. The spec's own JSDoc says it never asserts "the guide's absence", but its first assertion needs the guide to be present.
- **E2E stores are plentiful but cost setup by hand.** `mw10013-e2e-shop-00`…`09` exist, one per checkout index. A second store per checkout needs a naming rule, `shopify store auth` and a plan picked.
- **Hot reload exists with either lifetime.** The 10-17 mid-run reload happened under today's restart-per-run server. A long-lived server makes the window of exposure longer, but the rule is the same: no `src/` edits during a run. In exchange, it serves edits without a restart. A change to dependencies or the stack still needs one.
- **The rate limit is per machine, not per checkout.** Main and the worktrees create quick tunnels from one IP: dev servers, e2e servers, and every retry.
- **Billing stays headed and by hand.** It is out of this research except where it shares setup.

---

## 4. Options

### 4.1 Server lifetime

- **A. Restart per run (today).** Clean slate. Pays ~45 s of startup (§5.1) and one new quick tunnel every run.
- **B. Long-lived per checkout (recommended).**
  - `vp run e2e:start`, `e2e:stop`, `e2e:status` and `e2e:restart`, built like `vp run dev` (`scripts/dev.ts`: adopt, herdr, lock).
  - Playwright gets `reuseExistingServer: true` and fails fast with "start the e2e server" when the server is not up.
  - `e2e:restart` is today's destroy-and-start, for a clean slate on demand.
  - Saves ~45 s per run and nearly all tunnel creations; the measured run saving was 6.3 → 6.0 min.
  - The main win is fewer moving parts per run, not time.
- **C. One shared e2e server for all checkouts.** Rejected by §3's first constraint, unless only `main` runs e2e.
- **D. Run e2e on the dev server, as legacy did.** Legacy had no separate e2e server. `globalSetup: e2e/preflight.ts` ran against the long-lived dev server on the dev store, and the e2e seed replaced the dev shop's data ("run `pnpm seed` after any e2e run"). Rejected: Baton keeps dev data and e2e data apart (separate store, stage and fixture), and that separation is what lets an agent use the dev store while e2e runs.

### 4.2 Data between runs (needed by B)

Measured (§5.3): four runs in a row on one server all set up and passed, apart from the spec-assumption failure of §3. Install's `LoadFixture` replaced the shop's data each time. What a long-lived server keeps between runs:

- Better Auth users for `@e2e.test` addresses, and their sessions.
- Canceled Shopify orders on the store (these accumulate today too, because they live in Shopify).

- **No new reset call (recommended).** Keep install's `LoadFixture` and own-rows isolation. Leftover users do not break the specs, because addresses are per test id and per retry. `e2e:restart` clears everything when wanted.
- **A `ResetShop` dev call.** It would also delete leftover Better Auth users. It is new code with no failure to fix yet.
- **Destroy the D1 database and actor namespace per run.** This is close to today and gains little.

### 4.3 Tunnel

- **Preflight (cheap, independent, first).** Run it as Playwright `globalSetup`, as legacy did, so that `chromium` does not inherit `shopify-admin`'s Keychain prompt. It does two things:
  1. Wait until the tunnel hostname resolves on a **public** resolver.
  2. Then fetch `/` through the tunnel until it answers, within a bound of about 60 s, and fail with one clear message otherwise.

  The order matters. A lookup through the system resolver before the record exists caches "not found" for 60 s. That is the 10-19 failure, and legacy's `TunnelState` JSDoc records the same on 2026-09-27. Legacy's check, a single 10 s fetch where a 530 answer means dead and no answer means unknown, did not wait.

  Measured (§5.1): public DNS already resolved when the CLI printed its URL. The tunnel answered `/` 13 s later, once Vite had served its first request.

- **Named tunnel per checkout (rejected in review, Q3).**
  - One remotely managed tunnel run by `cloudflared tunnel run --token`, with one public hostname per server, for example `e2e-00.mw10013.com → http://localhost:<fixed CLI port>`. The server would run `shopify app dev --tunnel-url https://e2e-00.mw10013.com:<port>`.
  - It would remove the DNS race, the creation rate limit and the 200 in-flight cap.
  - It would cost a `cloudflared` process to own, a one-time Cloudflare setup, and a guard for `/api/dev` on a findable hostname (§3).
  - What stays open with quick tunnels instead: the creation rate limit (made rare by a long-lived server and no setup-failure retries, §4.5), and the 200 in-flight cap (4 workers peaked at 88 per load in §5.4; watch it if workers go up).
- **`--use-localhost`.** No tunnel for loads, but no webhooks either. It could serve the embedded files that need no webhook; `orders.spec` and `refresh.spec` would still need a tunnel. It means two server shapes, so it is not recommended.

### 4.4 Parallel embedded specs

Measured (§5.4):

| Embedded workers | `refresh.spec`     | Full run | Result                                                                                            |
| ---------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| 1 (today)        | in `embedded`      | 6.0 min  | 83 passed                                                                                         |
| 2                | own project, after | 3.8 min  | 83 passed                                                                                         |
| 4                | own project, after | 2.2 min  | `home.spec` guide test failed (3 of 3 runs); its 3 serial siblings and `refresh.spec` did not run |

At 4 workers, load times rose from a median of 3.3 s to 4.1 s (p90 6.4 s, max 6.5 s). There were no hydration failures and no 429s, but peak in-flight per load reached 88, so four loads at once can approach the quick tunnel's cap of 200.

- **`refresh.spec` alone, after the rest.** It is its own project and depends on `embedded`. It adds ~58 s of serial tail, so 4 workers come to ~3 min in all.
- **Or give `refresh.spec` its own e2e store**, so it runs at the same time as the rest (~2.2 min). This costs a second store per checkout and its setup.
- **Audit the embedded specs for whole-shop assertions before raising workers.** Fix `home.spec`'s guide test to tolerate a complete guide. Check the seat, quota and strip assertions (`members.spec` "past the included seats", home's strip and meters), and the webhook timing of `orders.spec`.
- **Let `chromium` overlap `embedded`.** One way: `embedded` also depends on `setup`, which costs ~2 s, so both sit at the same depth (§1.4). This saves `chromium`'s ~12 s.
- **One store per worker:** the most isolation and the most setup. The session row is not the bottleneck it was assumed to be (§3), so this is not needed.

### 4.5 Process

- A setup failure stops the run and prints the cause. Nobody re-runs a run whose setup failed without reading the error first: every retry also creates a tunnel today.
- A run's environment problems go once into a ledger (this doc's §2), not into each plan's §7.
- Scoped e2e (`vp run test:e2e <spec>`) for implementers should include every spec that reads a changed screen (`shell.spec` was missed on 10-19).

---

## 5. Measurements (taken 2026-10-19)

All on main, against `mw10013-e2e-shop-00`. The dev server kept running. For runs 2–5 an untracked config, deleted afterwards, changed only the `embedded` project's `workers` and moved `refresh.spec` into its own project.

### 5.1 Server start, split

From `.logs/e2e` (~190 starts, 10-15 to 10-19) and one timed start:

| Step                                                                            | Time from `vp run test:e2e:server` |
| ------------------------------------------------------------------------------- | ---------------------------------- |
| `vp run` + `checkStores` (`shopify store list`)                                 | 9.3 s                              |
| `alchemy destroy` (with CLI start-up)                                           | +13.2 s → 22.5 s                   |
| CLI Ready, tunnel URL printed (log median over all starts: 9.1 s after destroy) | +8.7 s → 31.2 s                    |
| Public DNS (8.8.8.8, 1.1.1.1) resolves the new hostname                         | 31.3 s (at once)                   |
| Website ready on localhost (log median: 15.9 s after destroy)                   | 38.8 s                             |
| `/` answers through the tunnel                                                  | 44.5 s                             |
| `install`'s token exchange / fixture loaded (log medians after destroy)         | ~22 s / ~26 s                      |

The CLI prints Ready while localhost still refuses connections: its proxy logged `ECONNREFUSED 127.0.0.1:4000` for `/`. Playwright's localhost wait covers that gap; it does not cover DNS.

### 5.2 Per-project and per-file time (serial, today's config)

Full run, 83 passed, 6.0 min against a server already up:

- `install`: 9.0 s (first load after start); later runs 5–7 s.
- `embedded`: 336 s of the 361 s wall time.
- `chromium`: 12.4 s, started after `embedded` (§1.4).

| Embedded file       | Span (s) | Tests |
| ------------------- | -------- | ----- |
| `orders.spec`       | 89       | 12    |
| `refresh.spec`      | 59       | 5     |
| `workflows.spec`    | 56       | 8     |
| `order-page.spec`   | 38       | 7     |
| `home.spec`         | 22       | 4     |
| `members.spec`      | 20       | 3     |
| `teams.spec`        | 19       | 2     |
| `orders-pages.spec` | 9        | 2     |
| `socket.spec`       | 9        | 1     |
| `app.spec`          | 7        | 3     |

The difference between the summed test time (235 s) and the span (336 s) is about 100 s of per-file boots and teardown.

### 5.3 Reused server

Runs 1–5 ran on one server without a restart. Each `install` loaded the fixture over the last run's data, and every setup passed. The serial run took 6.0 min against 6.3 min that morning with a fresh server: B saves ~20–45 s per run.

### 5.4 Parallel embedded

- 2 workers: 3.8 min, 83 passed.
- 4 workers: 2.2 min, failing only the `home.spec` guide test, in 3 of 3 runs (§3).
- With `E2E_FRAME_LOG=1` at 4 workers, 29 loads: median 4.1 s, p90 6.4 s, max 6.5 s, peak in-flight 42 median and 88 max. All loads hydrated.
- There was no session race: each loaded the stored token.

### 5.5 Not measured

- Whether the 10-19 DNS miss came from the system resolver's own negative cache, filled by an early lookup, or from Cloudflare's propagation. In the one timed start, public resolvers answered at once.

---

## 6. Questions

Answered in review on 2026-10-19: Q1, Q2, Q5 and Q7 as recommended. Named tunnels are not used at all, which answers Q3 and removes the questions that depended on a named tunnel (§3, §4.3).

:::question
Q1. Where does the e2e server live?

A long-lived server saves ~45 s and one new quick tunnel per run (§5.1, §5.3). Legacy ran e2e on its long-lived dev server (§4.1 D). Baton keeps e2e apart, so the long-lived server is a second one per checkout.

- [x] Long-lived per checkout: `e2e:start`/`stop`/`status`/`restart`, Playwright reuses it and fails fast without it (B)
- [ ] Restart per run, as today, plus the preflight (A)
- [ ] One shared server; only `main` runs e2e (C)

Recommended: Long-lived per checkout (B)
:::

:::question
Q2. What does a long-lived server do about data between runs?

Four runs in a row on one server set up and passed: install's `LoadFixture` already replaces the shop's members, teams, workflows and orders (§4.2). What it keeps (leftover `@e2e.test` users, sessions) breaks nothing.

- [x] Nothing new: install's `LoadFixture` per run, `e2e:restart` for a clean slate
- [ ] A new `ResetShop` dev call that also deletes leftover Better Auth users
- [ ] Destroy the D1 database and actor namespace per run

Recommended: Nothing new
:::

:::question
Q3. Which tunnel?

A fixed hostname would remove the DNS race, the creation rate limit (~26 tunnels in the hour before 10-18's) and the 200 in-flight cap, at the cost of a Cloudflare setup and a `cloudflared` process. Answered: named tunnels are not used.

- [ ] Named Cloudflare tunnel, one hostname per checkout's e2e server, `--tunnel-url` (preflight first)
- [x] Keep quick tunnels, add the preflight
- [ ] `--use-localhost` for loads, a tunnel only for the webhook specs

Recommended: Named tunnel per checkout; the preflight lands first either way
:::

:::question
Q5. How far does embedded parallelism go?

2 workers: 3.8 min, green. 4 workers: 2.2 min, but `home.spec`'s guide test fails every time, because it assumes no other spec completes the setup guide (§5.4). `refresh.spec` must run alone either way.

- [x] 4 workers after a spec audit (fix `home.spec`, check seats, meters and strip), `refresh.spec` alone after (~3 min)
- [ ] 2 workers now, `refresh.spec` alone after (3.8 min)
- [ ] 4 workers, and `refresh.spec` on a second e2e store per checkout, concurrently (~2.2 min)
- [ ] Stay serial

Recommended: 4 workers after the audit, `refresh.spec` alone after
:::

:::question
Q7. In what order does the work land?

Each step stands alone. The preflight and the parallelism give the most for the least.

- [x] 1 preflight, 2 parallel embedded (with the audit and `chromium` overlap), 3 long-lived server
- [ ] 1 long-lived server, 2 parallelism
- [ ] Everything in one plan

Recommended: 1 preflight, 2 parallel embedded, 3 long-lived server
:::

Settled by the evidence, so no longer questions:

- **"Measure first" (the old Q4's recommendation).** Done in §5.
- **One store per embedded worker.** Loads reuse the stored token, so the session row is not contended outside `refresh.spec` (§3, §5.4).

Dropped in review, because named tunnels are not used:

- **Q4, guarding `/api/dev` on a fixed hostname.** Quick-tunnel names stay random, so nothing changes from today.
- **Q6, named tunnels for dev servers.**

---

## 7. Out of scope

- The billing project (headed, by hand).
- Rewriting specs beyond what isolation or parallelism needs.
- CI (there is none for e2e today).
- The stores runbook's line that `dev-shop-00` and `e2e-shop-00` are "kept and unused", which contradicts their use by main. A runbook fix, noted here so it is not lost.

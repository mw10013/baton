# Plan: e2e environment

Implements `docs/e2e-environment-research.md`. Every question in its §6 was settled on 2026-10-19:

- Q1: a long-lived e2e server per checkout.
- Q2: no new reset call.
- Q3: keep quick tunnels and add a preflight; named tunnels are not used, now or later.
- Q5: 4 embedded workers after a spec audit, with `refresh.spec` alone after them.
- Q7: preflight, then parallel embedded, then the long-lived server.

Read the research's §0, §1.3, §1.4, §3 and §5 first; this plan does not repeat their reasoning or numbers.

## 0. Rules for the implementer

- **AGENTS.md.**
  - Vite+ only; `vp check --fix` after every change.
  - Effect Schema for parsing (no hand trimming or regex tests on input); `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`.
  - The JSDoc rules: never cite this plan, the research or any `docs/` file in code; state a rule once, on the symbol that enforces it.
- **Commits.** Work on `main`. Commit at the end of each green step. Stage paths explicitly; never `git add -A` or `git commit -a`. Do not push.
- **Each step ends green.**
  - `vp check --fix`, and `vp test <files>` for the tests the step touches.
  - E2E only where a step says so, and only that scope (`vp run test:e2e <spec or --project=…>`, never with `--`). Never the full e2e suite: the reviewer runs it once.
  - The full `vp test` once, in Step 3.
  - A step that cannot end green is recorded in §7 before moving on. Do not re-run through a failure you understand; record it.
  - A setup failure (`install`, the preflight) is read before anything is re-run: every e2e start today creates a quick tunnel, and retries are what rate-limited this machine on 10-18.
- **The dev server on main keeps running.** Never stop it, `db:reset` it, or touch the dev store. Never `cloud:reset`, `deploy:staging` or touch staging.
- **Named tunnels, `cloudflared` set up by hand, and `--tunnel-url` are out.** The user rejected them.
- **What does not change.** No table, no procedure, no product code, no `DevRpcs` growth. Spec changes are limited to what Step 2's audit needs.
- Do not rewrite the steps. Record in §7 what you built differently, and what surprised you, as you go.

## 1. Outcome

- **Preflight.** Before any spec, a Playwright `globalSetup` checks the following, and fails the run with one sentence that says what to do:
  - this checkout's e2e server answers on localhost;
  - the server's quick-tunnel hostname resolves on public DNS;
  - `/` answers through the tunnel.

  It never queries the system resolver before public DNS has the name.

- **Parallel embedded.**
  - `embedded` runs on 4 workers.
  - `refresh.spec` runs alone afterwards, in its own project.
  - `chromium` overlaps `embedded` instead of waiting for it.
  - Specs that asserted on whole-shop state no longer do.
  - A full run takes about 3 min, against 6.0 min before.
- **Long-lived e2e server.**
  - `vp run e2e:start | e2e:stop | e2e:status | e2e:restart | e2e:logs`, built like `vp run dev`.
  - Playwright no longer starts a server. The preflight fails fast with "start it: `vp run e2e:start`".
  - `e2e:restart` is today's destroy-and-start, for a clean slate.
  - A run reuses the server; install's `LoadFixture` replaces the shop's data, as it does today.

## 2. What this plan rests on

- **Playwright 1.64.1 runs plugin setup (the `webServer`) before `globalSetup`** (`createGlobalSetupTasks` in `node_modules/.pnpm/playwright@1.64.1/node_modules/playwright/lib/runner/index.js`). So until Step 3 the preflight runs after today's per-run server is up.
- **Playwright runs projects in phases by dependency depth** (`createPhasesTask`, same file). A project starts only once every project at an earlier depth has finished. This is why `chromium` (`install → setup → chromium`) waits for `embedded` (`install → embedded`) today.
- **Default workers:** `workers: undefined` is half the logical CPUs, which is 6 on this machine (12). Project `workers` caps that project inside the global pool.
- **The tunnel URL:**
  - `findTunnelUrl` in `scripts/dev.ts` reads `APP_URL=` from the environment of whatever listens on the port.
  - The e2e server's CLI gives its web command the same environment (`scripts/e2e-server.ts`).
  - The CLI's own output is not a reliable source: in a terminal its status panel redraws over the line.
- **The 10-19 DNS failure:**
  - The system resolver (1.1.1.2) had cached "not found" (negative TTL 60 s).
  - Public resolvers answered as soon as the CLI printed its URL (research §5.1).
  - Legacy's `TunnelState` JSDoc in `refs/baton-legacy/scripts/dev.ts` records the same (2026-09-27).
- **Legacy's preflight:** `refs/baton-legacy/e2e/preflight.ts` (default export `preflight`, a `globalSetup`) and `statusCommand` / `tunnelState` in `refs/baton-legacy/scripts/dev.ts`. A 530 from Cloudflare means the tunnel is dead; no answer is unknown, not dead. Port its reasons, not its single-shot check.
- **Session row:**
  - Embedded loads reuse a fresh stored token (`authenticateAdmin` in `src/backend/shopify.ts`).
  - Only `refresh.spec` ages the row on purpose.
  - `embedded` must not start before `install` has written the row, because two first loads would both exchange (the comment on `embedded`'s `dependencies` in `playwright.config.ts`).
- **Measured parallel failure:** with 4 workers, `home.spec`'s "the App Home guide marks a team with a member and an active workflow done" fails every time. The App Home renders the guide only while `!setupIsComplete(facts)` (`src/web/routes/app.index.tsx`), and a concurrent `order-page.spec` completes the third step.
- **`scripts/dev.ts`** already has everything a long-lived server needs: adopt by process, cwd and store; herdr placement; `.logs/dev.lock`; `stopServer`; `findTunnelUrl`; `answering`. It is explicitly blind to the e2e server (it matches `--store <SHOPIFY_DEV_STORE>`).
- **`db:reset`** (`scripts/dev.ts`) removes `.alchemy/local` and `.alchemy/state` **for every stage**, e2e included. Under a long-lived e2e server that pulls the database out from under it.
- **Data between runs:** `LoadFixture` replaces an installed shop's members, teams, workflows and orders, actor storage included. Four consecutive runs on one server passed setup (research §5.3).

## 3. Names

| Where               | Name                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight           | `test/e2e/preflight.ts`, default export (Playwright `globalSetup`)                                                                                                                                        |
| Shared server lib   | `scripts/lib/server.ts` (or the nearest fit in `scripts/lib/`): what `dev.ts` and the e2e server share, moved out of `scripts/dev.ts` (`findTunnelUrl`, `answering`, process and lock helpers, placement) |
| Tunnel probe        | `tunnelReady` (public DNS, then `/` through the tunnel), in the shared lib so `dev:status` can report it too                                                                                              |
| E2E server CLI      | `scripts/e2e.ts` with `start`, `stop`, `status`, `restart`, `logs`; `scripts/e2e-server.ts` becomes its foreground server body or is folded in                                                            |
| Package scripts     | `e2e:start`, `e2e:stop`, `e2e:status`, `e2e:restart`, `e2e:logs`; `test:e2e:server` removed                                                                                                               |
| Playwright projects | `embedded` (4 workers, without `refresh.spec`), `refresh` (`refresh.spec`, 1 worker, after `embedded`)                                                                                                    |
| Lock, logs          | `.logs/e2e.lock`, `.logs/e2e/current` (unchanged)                                                                                                                                                         |
| herdr tab           | `e2e`, beside `dev`                                                                                                                                                                                       |

## 4. Steps

### Step 1: Preflight (research §4.3)

1. **Check first:** confirm on a per-run start that `globalSetup` runs after the `webServer` is up (§2). If it does not, make the preflight a setup project that `shopify-admin` depends on, and record why.
2. Move `findTunnelUrl` and `answering` out of `scripts/dev.ts` into the shared lib, unchanged in behaviour. `dev:status` must print the same.
3. `tunnelReady(url)`:
   1. Poll `resolve4` against public resolvers only (`node:dns` `Resolver` with `setServers(["1.1.1.1", "8.8.8.8"])`) until the hostname resolves.
   2. Then poll `fetch(url + "/", { redirect: "manual" })` until any answer other than Cloudflare's 530.

   The whole check is bounded at 90 s, longer than the 60 s negative TTL, so one early system lookup by anything else can still clear. Use `Schedule` for the polling. A typed error says which half failed and what was last seen.

4. `test/e2e/preflight.ts` does three things:
   1. Checks localhost `answering` on `e2ePortOf(WEBSITE_PORT)`.
   2. Reads the tunnel URL with `findTunnelUrl`.
   3. Runs `tunnelReady`, then prints one line (`e2e preflight: <url> ready in <s>`).

   Wire it as `globalSetup` in `playwright.config.ts`. Its JSDoc carries the rule: why public DNS first, and why it is not a setup project (`chromium` must not inherit `shopify-admin`'s Keychain prompt).

5. `dev:status` reports the tunnel with `tunnelReady`'s single-shot form (ready / not resolving / not answering), so a person sees the same signal.
6. Unit-test what is pure (the 530 rule; the error messages) under `test/unit/scripts/…` mirroring the lib. Run one scoped e2e that exercises the preflight: `vp run test:e2e test/e2e/embedded/app.spec.ts`. Record the preflight's time in §7.

### Step 2: Parallel embedded (research §4.4)

1. **Audit, before raising workers.** Read every embedded spec for assertions on whole-shop state that another spec can move: the setup guide; seat, quota and capacity meters; the orders strip's counts; the orders index counts and pages; anything that counts or lists every row. The movers are the other embedded specs and, now that it overlaps `embedded`, every `chromium` spec on `E2E_SHOP` (members, teams, sign-ins); check both directions. Also check timing that assumed being alone: `orders.spec`'s webhook settle, `orders.spec`'s RemoveOrder/Sync window. Fix each so it asserts only on what it added, or on a shape rather than a count. Record each fix as a Deviation, one line each. A spec whose meaning cannot survive this is a `DECISION:` under Issues; keep it serial in the meantime (its own serial project after `embedded`, like `refresh`).
2. Known fix: `home.spec`'s guide test must tolerate a guide that is already complete and so absent. It still checks the guide's content when the guide is shown. Its file JSDoc already states the intended rule ("never … the guide's absence"); make the test match it.
3. `playwright.config.ts`:
   - `embedded`: `workers: 4`, `testIgnore` adds `**/refresh.spec.ts`.
   - New `refresh` project: `refresh.spec` only, `workers: 1`, `dependencies: ["embedded"]`, same `use`, timeout and expect as `embedded`.
   - `embedded` also depends on `setup`, so `chromium` and `embedded` share a phase (§2). Keep it behind `install` either way.
   - Update the comments on `embedded`'s `workers` and `dependencies`, and `refresh.spec`'s file JSDoc ("`workers: 1` keeps the other embedded specs off it"), to the new rule: the session row is aged only in the `refresh` project, which runs alone after `embedded`.
4. If the global pool (6) starves `chromium` while `embedded` holds 4, record what you saw. Do not raise the global `workers` without recording why.
5. Run `vp run test:e2e --project=embedded --project=refresh` (its setup dependencies come along) once after the audit. If it fails, run the failing spec alone, fix or record, and run the two projects once more at most. Record the wall time and the per-project spans in §7. Also run `--project=chromium` once to see that it now overlaps; record its start offset.
6. `docs/testing-research.md` §2.3 says the embedded project keeps `workers: 1`. Add a dated line there that it now runs 4 workers with `refresh` alone after. Do not rewrite the section.

### Step 3: Long-lived e2e server (research §4.1 B, §4.2)

1. Generalise `scripts/dev.ts`'s server management into the shared lib, parameterised by environment (`dev` | `e2e`). The parameters: store variable, port, stage, lock path, log directory, herdr tab label, web environment, and what `start` does after the server answers (dev: open the app and apply the dev fixture; e2e: nothing, because `install` does it per run). `vp run dev` must behave exactly as before. Read `scripts/dev.ts`'s module JSDoc rules (adopt, placement, lock) and keep them, stated once on the shared symbols.
2. `scripts/e2e.ts`:
   - `start`: adopt a running e2e server, else place one like dev (herdr tab `e2e`, or foreground for a person, or detached). It does **not** destroy the stage.
   - `stop`.
   - `status`: answering, tunnel via `tunnelReady`, stage, store, port, uptime.
   - `restart`: stop, `alchemy destroy --stage <e2e stage> --yes`, start; today's clean slate.
   - `logs`.

   `checkStores` stays on `start`. Package scripts per §3; remove `test:e2e:server`.

3. `playwright.config.ts`: remove `webServer`. The preflight's localhost check now fails with `the e2e server is not running: vp run e2e:start`. Drop `E2E_REUSE_SERVER`. Rewrite the config's JSDoc: the server is long-lived, a run reuses it, and `install`'s `LoadFixture` replaces the shop's data each run.
4. `db:reset`: it deletes every stage's local data. Make it stop this checkout's e2e server first, and say so in its output and JSDoc. It is not restarted; the preflight tells the next run. `dev:stop` and `dev:status` stay blind to the e2e server.
5. When does a running e2e server need `e2e:restart`? A change to dependencies, `alchemy.run.ts` or the stack, `patches/`, or the schema's `0001_init`. `src/` edits hot-reload, and the no-edits-during-a-run rule is unchanged. State this once, on `restart`'s description and in `scripts/e2e.ts`'s module JSDoc. If `status` can cheaply tell that one of those files is newer than the server's start, print a hint; otherwise skip it and record that.
6. Update every reference to the old flow: `git grep -n -E "test:e2e:server|E2E_REUSE_SERVER|webServer"` across `scripts/ test/ docs/*-runbook.md README.md .claude/skills/` (the stores runbook says "The e2e store needs the e2e server"). In `.claude/skills/implement-plan/SKILL.md`, add only what a reviewer now needs before its full run: `vp run e2e:start` (or `e2e:status`). Do not edit plans or research docs other than §7 here.
7. Unit tests for the parameterisation (the environment → parameters mapping) if it is a pure function. Then the full `vp test` once. Then one e2e check on the long-lived server: `vp run e2e:start`, `vp run e2e:status`, `vp run test:e2e test/e2e/embedded/app.spec.ts` twice (the second against the same server, which must pass setup again), `vp run e2e:restart`, the same spec once more, `vp run e2e:stop`. Record times in §7.
8. Leave the e2e server **stopped** at the end, and record that the reviewer starts it with `vp run e2e:start` before the full run.

## 5. Verification checklist

- `git grep -n -E "test:e2e:server|E2E_REUSE_SERVER"` is empty outside `docs/` plans and research.
- `playwright.config.ts` has no `webServer`, has `globalSetup`, `embedded` with `workers: 4`, and a `refresh` project depending on `embedded`.
- `vp run dev:status` prints what it printed before, plus the tunnel state; the dev server was never restarted (its uptime in `ps`).
- `vp run e2e:status` with the server stopped says so and exits non-zero. With the server started, it shows the tunnel ready.
- A run with the e2e server stopped fails in the preflight in under 5 s with the start command, and no test starts.
- No named tunnel, `cloudflared` config or `--tunnel-url` anywhere (`git grep -n -E "tunnel-url|cloudflared"` shows only the CLI's own quick tunnel references, if any).

## 6. Done when

- §1 holds, every step is green and committed, and §7 is filled in with the measured times. The e2e server is stopped and the reviewer's full run is the next action.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step (`**2026-10-19, Step 2:** …`).

- A **deviation** is anything built differently from the step that specified it, and each spec fix from Step 2's audit. Say what, and why.
- An **issue** is anything the plan did not predict. Say what you saw, what you did, and whether it is open. Anything that changes scope or what a spec means is `DECISION:`.
- **Command results** carry counts and times.
- **Human steps requested** lists what only the reviewer or the user can do (a Keychain prompt, a store setting).

### Plan review

- **2026-10-19, reviewer:** §2's Playwright claims hold in 1.64.1: `createGlobalSetupTasks` runs `createPluginSetupTasks` (the `webServer`) before the `globalSetups`, and `createPhasesTask` phases by depth. With `embedded` also depending on `setup`, the depths are `shopify-admin` 0, `install` 1, `setup` 2, `chromium` and `embedded` 3, `refresh` 4; so `refresh` also waits for `chromium`, which is what "alone" needs. Step 1.1's check is a confirmation, not an open question.
- **2026-10-19, reviewer (fixed in Step 2.1):** the audit read only embedded specs as movers, but Step 2.3 newly overlaps `chromium` with `embedded` on the same shop (`E2E_SHOP`; `chromium`'s members and shop specs add members and teams). A count or meter an embedded spec reads can move under a `chromium` spec, and the reverse. Step 2.1 now names `chromium`'s specs as movers too.
- **2026-10-19, reviewer (note for Step 3.1):** `findServerPane` in `scripts/dev.ts` matches any herdr pane running this checkout's `shopify app dev` or `alchemy dev`, without the store; with an `e2e` tab beside `dev` it can find the e2e server's pane. The generalised pane lookup must be keyed by store as the process match is, so `dev:stop`/`dev:status` stay blind to the e2e server.

### Deviations

- **2026-10-19, Step 1:** the shared lib is `scripts/lib/server.ts`. Step 1 moved `findTunnelUrl`, `answering`, `portListeners`, `pidsFrom` and `decodePid` (the last three because the first needs them and `dev.ts` keeps using them). `tunnelReady`'s single-shot form is `tunnelState` (`ready` / `not resolving` / `not answering`); it asks public DNS first too, so a status check never fills the system resolver's negative cache. `dev:status` prints `tunnel:  <url> (<state>)` and `--json` adds `tunnelState`; every other line is unchanged.
- **2026-10-19, Step 1:** `TunnelError` carries `phase` and a `message` built by the pure `tunnelErrorMessage`, which is what the unit test checks; the 530 rule is `tunnelServes`.
- **2026-10-19, Step 2 (audit fix):** `home.spec` guide test: once the strip shows, a page with no guide is a complete guide (the guide is read by the loader only, not live), so the test annotates and returns; when the guide shows, it checks the same content as before. File JSDoc updated to match.
- **2026-10-19, Step 2 (audit fix):** `orders.spec` real-order cases opened `?show=all` and found the row on page one. Fixture orders are placed "now", so 25 added beside it (`orders.spec`'s own 30/26-order cases are serial, but `order-page.spec` and the `chromium` run seeds are not) push the real order to page two. The first case now opens `?show=all&q=<the order's number>` once the order exists; the search list is live, so the webhook row still arrives without a reload.
- **2026-10-19, Step 2 (audit fix):** `order-page.spec` "an item matching two workflows…" read its run-less order on Show: Open's page one, the same page-one bet against the 56 open orders `orders.spec` adds. It now reads the row under the Issues filter (about 7 issue orders per run, far from a page), and the closing check is "Issues no longer lists it" plus its row by search without the match text. The team filter could not be used: it needs a run.
- **2026-10-19, Step 2 (audited, unchanged):** `members.spec` "past the included seats" is monotone within a run (members are only ever added, or deleted by their own test). `orders.spec`'s search case reads its own Making orders on page one, and nothing beside it adds 25 Making orders in seconds. `orders-pages.spec` searches its own title prefix, which no other title shares. `workflows.spec`, `teams.spec` and embedded `members.spec` search their own names. `socket.spec`, `app.spec` and home's strip and meter tests read shapes. `chromium`: `/admin/members` is not paged and asserts its own rows; `shop.spec` and `member-workflows.spec` counts are per member of their own; `admin.spec` reads the shop row, which only `refresh` ages, after. `orders.spec`'s QUIET window and RemoveOrder/Sync: no spec running beside it touches real Shopify orders (`refresh` is after), so the window still holds.
- **2026-10-19, Step 2:** the `embedded`/`refresh` timeouts and `use` are one `embeddedProject` object in `playwright.config.ts`.
- **2026-10-19, Step 3:** everything `dev.ts` used for its server moved to `scripts/lib/server.ts`, parameterised by `serverParams(environment)` (store variable, port, lock, log, herdr tab, foreground script) and `loadServer` (adds port, store, stage). The adopt/placement/lock rules are stated once, on `startServer` and `withLock`; `dev.ts`'s module JSDoc links to them. `dev`, `dev:stop`, `dev:status` and `dev:logs` print what they printed before (`dev:status` plus the Step 1 tunnel state).
- **2026-10-19, Step 3:** `scripts/e2e-server.ts` stays as the foreground body behind a new package script `e2e:serve` (the e2e analogue of `app:dev`, which the launcher types into the pane); it no longer destroys the stage or checks the stores. `checkStores` runs in `e2e:start` (and so in `e2e:restart`), and the destroy moved to `e2e:restart`.
- **2026-10-19, Step 3:** `web:e2e` now passes `--stage "$stage"` to `alchemy dev` instead of setting `ALCHEMY_STAGE`, as `web:dev` does, so the e2e server's Alchemy process is found by stage exactly like dev's. The pane lookup (the reviewer's note) matches the CLI by store and Alchemy by stage, as the pid lookup does, so `dev:status` reported `herdr pane wH:p2` while the e2e server ran in `wH:p3`.
- **2026-10-19, Step 3:** `e2e:status` reports the tunnel with the single-shot `tunnelState`, not the waiting `tunnelReady`, so it returns at once; healthy means running, answering and tunnel `ready`. The restart hint is cheap and implemented: `status` compares the server's start (`ps -o lstart=`, decoded with `Schema.DateFromString`) with the mtimes of `package.json`, `pnpm-lock.yaml`, `alchemy.run.ts`, `src/backend/stack.ts`, `patches/*` and `migrations/0001_init.sql`, and prints `restart: changed since start: …`. Not exercised live (no such file changed during the check).
- **2026-10-19, Step 3:** a tunnel the preflight finds not ready fails with `tunnelReady`'s message plus "read vp run e2e:logs, then a new tunnel: vp run e2e:stop && vp run e2e:start" (not `e2e:restart`, which also destroys the data a new tunnel does not need).
- **2026-10-19, Step 3:** `db:reset` stops the e2e server under the e2e lock after stopping dev, and says so in its output (`ok    stop the e2e server`), description and the module JSDoc. Checked by reasoning only, as instructed: it now also needs `SHOPIFY_E2E_STORE` in `.env` (`worktree:init` writes it).
- **2026-10-19, Step 3:** runbooks updated: `worktrees-runbook.md` (the e2e section, rewritten for the long-lived server), `dependency-patches-runbook.md` (`e2e:start`), `shopify-stores-runbook.md` (the "needs the e2e server" line; the "kept and unused" line left alone). `implement-plan` skill: one sentence before the full run.

### Issues

- **2026-10-19, Step 2:** the `--project=chromium` run selects `chromium` and its setup chain only, so it cannot show the overlap with `embedded`; the overlap (and whether the global pool of 6 starves `chromium` while `embedded` holds 4, Step 2.4) is first visible in the reviewer's full run. Open; nothing to decide. The depths are as the plan review states (`embedded` now depends on `setup`).
- **2026-10-19, Step 3 (fixed):** the first `e2e:start` put the server in herdr pane `wH:p3`, but `e2e:status` said "background": `scripts/e2e-server.ts` spawned the CLI with Effect's default `detached`, a process group of its own, so the pane's foreground group held only `vp run e2e:serve` and its node. The CLI and `s6-log` are now spawned with `detached: false`; after a stop and start, `e2e:status` reports `herdr pane wH:p3`, and `e2e:stop` stops it by Ctrl-C in 1.0–1.2 s.

### Command results

- **2026-10-19, before Step 1:** the dev server on main (CLI pid 40057) started Mon Oct 19 10:21:04 (`ps -o lstart=`); this is the uptime to compare at the end.
- **2026-10-19, Step 1:** `vp check --fix` clean. `vp test test/unit/scripts/lib/server.test.ts`: 4 passed, 0.3 s. `vp run test:e2e test/e2e/embedded/app.spec.ts`: 5 passed, 52.9 s, on a per-run server. Step 1.1 confirmed: the `[WebServer]` start line comes before `e2e preflight: https://flush-llc-basename-heel.trycloudflare.com ready in 0.5s`, so `globalSetup` runs after the `webServer` is up. The preflight took 0.5 s (the `webServer` had already waited for localhost, and public DNS had the name).
- **2026-10-19, Step 2:** `vp check --fix` clean. `vp run test:e2e --project=embedded --project=refresh`: 51 passed (4 setup, 42 embedded, 5 refresh), first try, 3.6 min by Playwright, 217 s wall including the per-run server's start (preflight 0.4 s). From `.logs/e2e/current`: server marker 12:57:17, fixture loaded 12:57:46, `embedded` ≈ 12:57:46–12:59:33 (≈107 s, against 336 s serial), `refresh` ≈ 12:59:33–13:00:38 (≈65 s). `vp run test:e2e --project=chromium`: 36 passed (4 setup, 32 chromium), 55 s wall; `chromium`'s first result at 44 s, right after `setup` at 43 s, last at 55 s (≈12 s span).
- **2026-10-19, Step 3:** `vp check --fix` clean. `vp test test/unit/scripts/lib/server.test.ts`: 7 passed, 0.3 s. Full `vp test`: 91 files, 1127 tests passed, 50.0 s (52 s wall). With the e2e server stopped: `vp run e2e:status` exits 1 with "start it: vp run e2e:start"; `vp run test:e2e test/e2e/embedded/app.spec.ts` fails in the preflight in 0.8 s with "e2e preflight: the e2e server is not running: vp run e2e:start", no test started.
- **2026-10-19, Step 3 (long-lived server):** `vp run e2e:start` 32 s (stores 2.1 s, answering 29.1 s; first start, before the process-group fix), again after the fix 21.1 s to answering; a third `e2e:start` adopted it in 0.0 s. `vp run test:e2e test/e2e/embedded/app.spec.ts` on that server: 7 passed (4 setup, 3 app) in 17.4 s (18 s wall), then 7 passed in 13.6 s (14 s wall) against the same server, preflight 0.1 s each. `vp run e2e:restart`: 30 s (stop 1.0 s, destroy 5.2 s, stores 1.2 s, answering 22.3 s), then the spec: 7 passed in 17.9 s (19 s wall), preflight 0.5 s. `vp run e2e:stop`: 1.2 s. The e2e server is **stopped**; the reviewer starts it with `vp run e2e:start` (or checks `vp run e2e:status`) before the full run.
- **2026-10-19, end:** the dev server on main was never restarted: CLI pid 40057, started Mon Oct 19 10:21:04, `dev:status` healthy in herdr pane `wH:p2` throughout. `git grep -n -E "test:e2e:server|E2E_REUSE_SERVER"` is empty outside plans and research; `tunnel-url|cloudflared` shows only the CLI's own quick tunnel (`scripts/lib/server.ts` JSDoc, the unit test's title).

### Human steps requested

- None. The `shopify-admin` setup did not prompt for Keychain in any run.

### Implementation review

## 8. Out of scope

- Named Cloudflare tunnels, `--tunnel-url`, `--use-localhost` (rejected in review).
- A `ResetShop` or any new dev call (Q2).
- A second e2e store per checkout for `refresh.spec`, or one store per worker.
- The billing project (headed, by hand); it keeps depending on `setup`.
- CI for e2e.
- The stores runbook's "kept and unused" line for `dev-shop-00` / `e2e-shop-00` (research §7), unless Step 3.6 touches that paragraph anyway.

# pnpm 10.17.1 → 12.8.1 upgrade — research

**Status: implemented 2026-10-04 (shim 12.9.1, repo edits applied, install green,
typecheck/lint/test green, dev boot verified 2026-10-04, see §10).** Researched against upstream 12.8.1; the install
script delivered 12.9.1 (patches only, §3), so the repo pin is `pnpm@12.9.1`.
Current pin was `package.json:129` (`pnpm@10.17.1`).
Sources are the upstream release notes for
[v11.0.0](https://github.com/pnpm/pnpm/releases/tag/v11.0.0),
[v12.0.0](https://github.com/pnpm/pnpm/releases/tag/v12.0.0),
[v12.8.1](https://github.com/pnpm/pnpm/releases/tag/v12.8.1), and the
[v10→v11 migration guide](https://pnpm.io/11.x/migration) (which also covers
v10→v12; there is no separate v12 migration page). Every repo claim below was
verified by reading the file or running the command, not from memory.

**Verdict:**

1. **Safe to upgrade.** The repo change is two files plus a fresh install and
   a committed lockfile. No Dockerfile, CI config, `.npmrc`, patches, or
   exotic dependencies to migrate (§4).
2. **This machine uses the standalone-script install** (`~/Library/pnpm`,
   `PNPM_HOME` in `~/.zshrc`), not corepack/brew/volta/mise (§2). Upgrading
   the tool itself is per-machine; upgrading the repo is the
   `packageManager` pin plus `pnpm-workspace.yaml`.
3. **`minimumReleaseAge: 0` — decided 2026-10-04**, or the new 24-hour
   freshness default will block pre-release tracking (`effect@4.0.0-rc.*`).
4. **`allowBuilds: { workerd: true }`** replaces the current build settings;
   the current file lists `workerd` under both keys, which collapses to one
   entry.
5. **Pin the runtime with `devEngines.runtime`** (`node 26.10.0`,
   `onFail: download`) — decided 2026-10-03, applied as part of the upgrade
   (§6). Brew stays the supplier; the pin makes the project deterministic
   regardless of what brew does next.

---

## 1. Current state

| Fact                                                                                                                                                                                                                          | Verified                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| pnpm pin `pnpm@10.17.1`                                                                                                                                                                                                       | `package.json:129`, `pnpm --version` in repo → `10.17.1`                                                     |
| Lockfile `lockfileVersion: '9.0'`                                                                                                                                                                                             | `pnpm-lock.yaml:1`                                                                                           |
| Store `v10`                                                                                                                                                                                                                   | `pnpm store path` → `~/Library/pnpm/store/v10`                                                               |
| Build settings: `ignoredBuiltDependencies` + `onlyBuiltDependencies`, both `[workerd]`                                                                                                                                        | `pnpm-workspace.yaml:4-8`                                                                                    |
| Node `^26.0.0` required by repo; active Node is brew `v26.10.0`                                                                                                                                                               | `package.json:126-128`, `which -a node`, `node --version`                                                    |
| Brew Node arrived as a dependency of `shopify-cli`, not by direct install; the CLI's wrapper hardcodes it (`/opt/homebrew/bin/shopify:1`: `#!/usr/bin/env /opt/homebrew/opt/node/bin/node`), so the CLI never consults `PATH` | `brew info node` ("Installed (as dependency)"), `brew uses --installed node` → `shopify/shopify/shopify-cli` |
| Interactive `node` resolves to brew's copy purely by `PATH` order (`/opt/homebrew/bin` precedes `~/Library/pnpm`); no version manager (nvm/fnm/volta/mise) installed, nothing Node-related in shell init                      | `echo $PATH`, `which volta mise fnm nvm n`, grep over `~/.zshrc`                                             |
| pnpm-managed Node 24.14.0 exists but is dormant: shadowed on `PATH`, below the repo's `engines ^26`, selected by nothing (no `devEngines.runtime` / `useNodeVersion` pin anywhere)                                            | `~/Library/pnpm/node -> nodejs/24.14.0/bin/node`; grep over repo                                             |
| No `.npmrc`, no `package.json#pnpm` field, no `auditConfig`, no `patchedDependencies`/`pnpmfile`, no git/tarball deps, no `npm_config_*`, no `pnpm server`/`pnpm link` usage                                                  | grep over repo (only hits: the two `pnpm-workspace.yaml` keys, `scripts/worktree.ts:122`)                    |
| `scripts/worktree.ts:122` uses bare `pnpm install --frozen-lockfile`                                                                                                                                                          | still valid in v12; only the `--frozen-lockfile false` form was removed                                      |

The double listing of `workerd` is redundant but harmless under v10:
`onlyBuiltDependencies` whitelists builds, `ignoredBuiltDependencies`
silently denies the rest without warning. Under v11 both keys are gone and
the single `allowBuilds` map holds the whole policy, so the two lines become
one entry (`workerd: true`).

## 2. How pnpm is installed on this machine

Probably the standalone script (`curl -fsSL https://get.pnpm.io/install.sh | sh -`).
The original command is not recorded anywhere on disk, but the layout only
that script produces is all present:

- `~/Library/pnpm/pnpm` is a 62 MB executable (Mar 2026), not a brew cellar
  link or a corepack shim. `corepack` is not installed; no volta/mise/fnm
  shims found.
- `~/.zshrc:23-28` carries the exact `PNPM_HOME="/Users/mw/Library/pnpm"`
  block the install script appends.
- `~/Library/pnpm/.tools/pnpm/` (9 versions, 9.x–10.x) and
  `~/Library/pnpm/.tools/@pnpm+macos-arm64/` (7 versions) are the
  version-switcher store: the shim runs the version the project's
  `packageManager` field pins, downloading it on demand.
- `~/Library/pnpm/nodejs/24.14.0` plus the `node` symlink is pnpm-managed
  Node (from `pnpm env use`, the v10 name for what v11 calls
  `pnpm runtime set`). It is currently shadowed by brew Node on `PATH`.
- `~/Library/pnpm/global/5` holds the global installs.

Consequences for the upgrade:

- The shim in this repo reports `10.17.1` even outside the repo
  (`/tmp` → `10.17.1`), so the shim itself is 10.17.1 and no version switch
  happens here today. Upgrading the tool means upgrading that shim:
  re-run the install script or `pnpm self-update`.
- The tool upgrade is **per-machine, not per-worktree**. Every worktree
  shares `~/Library/pnpm`, including the content-addressable store. Each
  worktree still needs its own `pnpm install` afterwards (separate
  `node_modules`; the v10→v11 store re-index is a one-time cost on first use).
- The pnpm-managed Node 24.14.0 does not satisfy the repo's `engines ^26`,
  but it never runs: brew Node 26.10.0 wins on `PATH`, and nothing
  pins a runtime for pnpm to enforce. v11+ requires Node 22+ to run pnpm
  itself, which brew Node satisfies. Runtime action is the §6 pin, not a
  Node install.

## 3. Upstream changes

### v10 → v11 (the large one)

- **Node 22+ required**, pnpm ships as pure ESM.
- **Build policy consolidated:** `onlyBuiltDependencies`,
  `neverBuiltDependencies`, `ignoredBuiltDependencies`,
  `onlyBuiltDependenciesFile`, `ignoreDepScripts` removed → `allowBuilds`
  map (`{ name: true | false }`). Default-deny preserved; `strictDepBuilds`
  defaults to `true` (unreviewed builds fail instead of warning).
- **Secure defaults:** `minimumReleaseAge` 0 → 1440 (1 day: newly published
  versions are not resolved for 24h), `blockExoticSubdeps` false → true
  (only direct deps may use git/tarball URLs),
  `verifyDepsBeforeRun` false → `install` (`pnpm run`/`exec` auto-installs
  when `node_modules` is stale), `optimisticRepeatInstall` false → true.
- **Config sources narrowed:** `.npmrc` carries auth/registry only; all
  other settings live in `pnpm-workspace.yaml` or global `config.yaml`;
  `npm_config_*` env vars no longer read (use `pnpm_config_*`); the
  `package.json#pnpm` field ignored. Codemod handles the moves:
  `pnpx codemod run pnpm-v10-to-v11`.
- **Package-manager strictness settings collapsed** into `pmOnFail`
  (`download | ignore | warn | error`); `devEngines.packageManager` accepts
  ranges alongside the exact `packageManager` pin.
- **Per-project runtime pin:** `devEngines.runtime` (succeeding v10's
  `useNodeVersion`) declares the Node/Deno/Bun version in `package.json`;
  with `onFail: download` pnpm fetches it into its managed `nodejs/` store
  and runs scripts under it, independent of `PATH` and Homebrew.
- **Store v10 → v11:** SQLite-backed index (`index.db`), hex digests,
  bundled manifests. Faster warm installs; first run re-fetches the index.
- **Global installs isolated** (per-group dir with own lockfile);
  `pnpm link <name>` / `link --global` / bare `link` / `install -g` (no args)
  / `pnpm server` removed.
- **npm CLI no longer the fallback:** publish/login/logout/view/deprecate/
  unpublish/dist-tag/version reimplemented natively; remaining passthroughs
  throw "not implemented".
- **Audit moves to GHSA:** `auditConfig.ignoreCves` → `ignoreGhsas`
  (IDs must be converted by hand); `pnpm audit` uses the bulk advisories
  endpoint.
- **Lockfile:** `patchedDependencies` format simplified
  (`Record<selector, hash>`); old format auto-migrates.

### v11 → v12 (incremental)

- Unknown `pnpm-workspace.yaml` keys now **fail** when the running pnpm
  satisfies the `packageManager` pin (warning otherwise) — typos surface
  instead of silently dropping policy.
- `pnpm install --frozen-lockfile false` removed; use `--no-frozen-lockfile`.
- Git deps on known hosts canonicalized to HTTPS (no SSH probing; use git
  `insteadOf` for private-over-SSH). Unknown hosts and embedded-credential
  URLs unchanged.
- Canonical cycle breaking in peer resolution: lockfile becomes a pure
  function of the graph — first re-resolving install may re-key cyclic peer
  variants once; frozen installs consume old lockfiles unchanged.
- `packageImportMethod: auto` tries hardlinks before cloning on Linux
  (macOS unchanged, clone-first on APFS).
- `engineStrict` tightened one level (incompatible package behind a regular
  `dependencies` edge fails even under an optional ancestor).
- `sudo` on global-modifying commands (`setup`, `self-update`, `add -g`)
  errors instead of writing to root's home.
- `pnpm add yarn` / `add -g node` now record/install the real thing
  (package-manager-aware), not the npm wrapper package.

### v12.0 → v12.8.1 (patches, no action)

Frozen-lockfile CPU cap (≤16 link workers), `dedupe` convergence on hashed
peer suffixes, exec-bit restore for `file:`/injected deps, `pnpm run`/`exec`
no longer creating `node_modules` for dependency-less projects,
`verifyDepsBeforeRun` mtime fix. All strictly beneficial.

## 4. Impact on baton

| Upstream change                                                                                                          | Impact here                                                                                                                                            | Action                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `onlyBuilt`/`ignoredBuilt` → `allowBuilds`                                                                               | **Breaking.** Current `pnpm-workspace.yaml:4-8` keys are ignored with an error under v11+.                                                             | `allowBuilds: { workerd: true }`                             |
| `packageManager` pin                                                                                                     | Cosmetic until bumped; then enforces the new unknown-key strictness.                                                                                   | Bump to `pnpm@12.8.1`                                        |
| `minimumReleaseAge: 1440`                                                                                                | **Real friction.** Pre-release tracking (`effect@4.0.0-rc.*`, fast TanStack) stalls 24h on `add`/`update`.                                             | Set `minimumReleaseAge: 0` (keeps v10 behavior)              |
| `strictDepBuilds: true`                                                                                                  | New deps with postinstall fail until allow-listed. Intended; first failure will surprise.                                                              | None now; use `pnpm approve-builds` when adding deps         |
| Store v10 → v11                                                                                                          | One-time index re-fetch; CI-style caches keyed on store path miss once.                                                                                | None in repo; re-run `pnpm install` per worktree             |
| Peer-resolution canonicalization                                                                                         | One-time lockfile re-keying on first resolving install.                                                                                                | Commit the resulting `pnpm-lock.yaml`                        |
| `verifyDepsBeforeRun: install`                                                                                           | `pnpm run`/`exec` may trigger installs (e.g. under `scripts/dev.ts`, which shells `pnpm app:dev`). Masks stale installs less, adds occasional latency. | Awareness only                                               |
| `blockExoticSubdeps: true`                                                                                               | None: zero git/tarball deps, direct or transitive.                                                                                                     | None                                                         |
| `.npmrc` / `package.json#pnpm` / `npm_config_*`                                                                          | None: none exist here.                                                                                                                                 | None                                                         |
| `link`, `server`, `install -g` (bare), npm passthrough, `auditConfig`                                                    | None: unused.                                                                                                                                          | None                                                         |
| Git-URL canonicalization, `engineStrict` tightening, Linux import method, `sudo` globals, `pnpm add yarn/node` semantics | None: no git deps, `engineStrict` unset, macOS dev machines, no such invocations.                                                                      | None                                                         |
| Node 22+ runtime requirement                                                                                             | None: brew Node 26.10.0.                                                                                                                               | None; runtime pin is about determinism, not eligibility (§6) |

## 5. Upgrade plan

1. Upgrade the shim on this machine (all worktrees share it): re-run the
   standalone install script, or `pnpm self-update` once a v12 shim exists.
2. In the repo: replace `pnpm-workspace.yaml:4-8` with
   `allowBuilds: { workerd: true }`, add `minimumReleaseAge: 0` (see §6),
   bump `package.json:129` to `pnpm@12.9.1`, and add the `devEngines.runtime`
   pin (see §6). (Or `pnpx codemod run pnpm-v10-to-v11` plus the
   `minimumReleaseAge` and `devEngines` lines by hand.) The runtime pin is
   honored from v11 on, so it takes effect with the upgraded shim, not
   before — order matters only in that the shim goes first.
3. Fresh install and commit: `pnpm install` (expect store re-index, a runtime
   download if the active Node ever drifts from the pin, and a possible
   lockfile diff), then `pnpm typecheck`, `pnpm lint`,
   `pnpm test`, `pnpm dev:start --seed`; confirm the `workerd` build runs.
   Verify the pin with `pnpm node --version` (reports the pinned runtime,
   not the `PATH` Node).
4. In each linked worktree: `source ~/.zshrc` (or open new tabs) in every
   shell opened before the shim upgrade, including its `server` tab; stop its
   server; `git merge --ff-only main` (or `git rebase main` if it has its own
   commits); `pnpm install`; then `pnpm dev:start`. `wt-NN` has its own
   `node_modules` and `.wrangler`; the store is shared, so the re-index
   happens once.
5. `pnpm refs:check` anywhere; `pnpm refs fetch` only in the main worktree
   (unchanged rule, `docs/worktrees-runbook.md:193`).

## 6. Decisions

- **`devEngines.runtime` pin — decided 2026-10-03, part of the upgrade.**
  Brew stays the supplier (it already serves the CLI by hardcoded path and
  the shell by `PATH` order); the pin makes the project deterministic
  regardless of what `brew upgrade` does next. Exact version, matching the
  Node verified on this machine today:

  ```json
  "devEngines": {
    "runtime": { "name": "node", "version": "26.10.0", "onFail": "download" }
  }
  ```

  With `onFail: download`, pnpm fetches that exact build into
  `~/Library/pnpm/nodejs/` when the running Node drifts, and runs scripts
  under it. Scope: pnpm-run scripts and `pnpm node` only — interactive
  `node` stays on `PATH`, the Shopify CLI stays on its shebang. Stale
  `nodejs/24.14.0` can be removed with `pnpm env remove` once the pin is
  live. Bump the pinned version deliberately, never as a side effect of a
  brew update.

- **`minimumReleaseAge: 0` — decided 2026-10-04, applied.** Same rationale
  as before; revisit if the repo ever needs the delay.
- **No other decision pending.** `allowBuilds` mapping is forced,
  `pmOnFail` needs no setting (no strictness settings exist today), and
  `devEngines.packageManager` ranges are unnecessary while the exact pin
  suffices.

## 7. Implementation log (2026-10-04)

Shim first: re-ran the standalone install script, which delivered **12.9.1**
(released 2026-10-03; patches only over 12.8.1 — wasm split, GitLab
provenance fix, audit TLS fix, frozen-lockfile+catalog fix, no action).
The v12 installer uses a new layout: `~/Library/pnpm/pnpm` (62 MB,
self-managing 10.17.1) is gone, replaced by shims in `~/Library/pnpm/bin/`
pointing at an isolated global install (`global/v11/...`), plus new
`store/v11`. It rewrote the `~/.zshrc` pnpm block to put `$PNPM_HOME/bin` on
`PATH` by itself. Old store (`v10`), `.tools/`, and managed Node 24.14.0 are
untouched. Version switching verified: `/tmp` reports 12.9.1, the repo (pin
10.17.1 at the time) reported 10.17.1.

Repo edits, all in the worktree uncommitted: `pnpm-workspace.yaml`
(`allowBuilds` + `minimumReleaseAge: 0`, see below), `package.json`
(`packageManager` → `pnpm@12.9.1`, `devEngines.runtime` pin for node
26.10.0/`onFail: download`). The pin works: `pnpm node --version` reports
26.10.0, and pnpm provisioned the managed `node@runtime:26.10.0` copy (one
58 MB download) even though brew's copy matches exactly.

First `pnpm install` under 12.9.1 failed with `ERR_PNPM_IGNORED_BUILDS`:
eight packages with unreviewed scripts, an error (not a warning) under the
new `strictDepBuilds: true` default. Under v10 these same scripts were
silently blocked by `onlyBuiltDependencies: [workerd]` and the repo worked,
so the fix reproduces v10 exactly — deny everything except `workerd`:

| Package                                                   | Scripts do                                 | Why deny is safe                                                                           |
| --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `esbuild` 0.27.5 + 0.28.1 (via vite/tsx)                  | `install.js` validates the platform binary | Binary ships via `@esbuild/*` optional deps, which pnpm links regardless; v10 never ran it |
| `core-js-pure` (via babel/mimetext/agents)                | message-only postinstall                   | Ships complete; matches upstream's own `core-js: false` example                            |
| `msw` (via @vitest/mocker, test path only)                | message-only postinstall                   | No repo code imports it directly (grep)                                                    |
| `msgpackr-extract` (via msgpackr/effect, runtime dep)     | optional native accel binding              | Pure-JS fallback; v10 never built it and Effect works                                      |
| `@mongodb-js/zstd`, `node-liblzma` (via just-bash/agents) | prebuild-install or source compile         | Optional native accel; v10 never built them                                                |
| `@parcel/watcher` (via graphql-codegen CLI)               | compiles file-watching binding             | Only matters for codegen `--watch`; one-shot runs unaffected                               |

Second install green (1.1s, "Already up to date"). Lockfile analysis
(`name@version` pairs HEAD vs worktree): the **only** version change in the
whole tree is `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0; everything else
is the predicted one-time peer-suffix re-keying (484 insertions, 186
deletions), plus pnpm's own `@pnpm/exe` self-management entries.

Verification: `pnpm typecheck` green, `pnpm lint` green (oxlint,
rules-lint, spec check), `pnpm test` green — 35 files, 718 tests.

Dev-server boot did not verify in this session; see §8 for the failure and
§10 for the resolution.

## 8. Dev-server boot failure (resolved, see §10)

`dev:start --seed` adopted the previously running server, which answered on
the port but seeded 500. Cause found in `logs/local-worker.log`: at 12:22
the live Vite server saw the `package.json` edit, auto-restarted
("package.json changed, restarting server...") into the middle of the first
v12 install, and its dependency scan failed ("Failed to run dependency
scan", react-dom unresolvable mid-relink). All subsequent worker requests
500'd with `ERR_RESOLVE_PACKAGE_ENTRY_FAIL` for `@tanstack/react-start` in
the workerd SSR runner. Sequencing mistake — the server should have been
stopped before the install — not an upgrade defect, but the later fresh
boots (server stopped first, clean `node_modules`) also timed out waiting
for port 3800, with their output going to the Herdr tab rather than the log,
so the current boot error is unseen. Two red herrings eliminated along the
way: a manually launched `vite dev` fails on `SHOPIFY_API_KEY` only because
that variable is injected by `shopify app dev` (`src/lib/Shopify.ts:229`),
and the `@tanstack/start-server-core@1.169.32` in the stack is the same
version HEAD's lockfile already pins, not a float.

## 9. Handoff state (superseded by §10)

What `pnpm clean` + fresh install established AFTER §8 was written: with the
server stopped first, `pnpm clean` (the repo script: wipes `node_modules`,
`.wrangler`, `.tanstack`, `build`, `dist`) followed by `pnpm install`
completed exit 0 in ~5s. The tree is therefore pristine — the poisoned-state
question is removed. Two `dev:start --seed` attempts on the clean tree both
ended in the 180s "no answer on port 3800" timeout with no new output in
`logs/local-worker.log` (Herdr-tab boots don't tee there; the last log lines
are still the 12:22 incident). Final `dev:status`: not running, port free.

Uncommitted worktree changes (do NOT commit unless asked): `package.json`
(pin 12.9.1 + `devEngines.runtime`), `pnpm-lock.yaml` (re-key + MCP SDK
1.29.0 → 1.30.0 + `@pnpm/exe` self-management entries), `pnpm-workspace.yaml`
(`allowBuilds` with the §7 deny list + `minimumReleaseAge: 0`), and this doc
(§7–§9). HEAD moved during the session (user's parallel commits, now at
`02e8efc` "Memoize list reads and pin their query plans"); §§1–6 of this doc
were committed along the way, §§7–9 are worktree-only.

Machine state that survives: shim is 12.9.1 (`/tmp` reports 12.9.1);
`~/.zshrc` pnpm block rewritten by the installer to `$PNPM_HOME/bin` —
shells opened before ~12:19 still point at the deleted old binary and report
`pnpm not found` until they `source ~/.zshrc` or reopen. Store holds both
`v10` and `v11`; managed runtimes hold 24.14.0 (stale, removable) and the
newly provisioned 26.10.0. Because `clean` wiped `.wrangler`, the local
ShopSession is gone: the next `dev:start` will reinstall the app on
`sandbox-shop-00`, which may need the store admin open in Chrome.

Suggested order for the next session: (1) one clean `dev:start --seed` with
nothing else running — the poisoned state is gone, so a success here closes
the issue; (2) if the worker still 500s on `@tanstack/react-start`, compare
against the `wt-01` worktree server (port 3801, untouched v10 modules —
probe read-only, never touch its server per `docs/worktrees-runbook.md`);
(3) note the 12:27 seed 500 happened with the old server too, so if the boot
succeeds but seed fails, suspect app-level drift from today's data-model
commits (seed fixture vs new task/task-state schema), not pnpm. Standing
green evidence: typecheck, lint (oxlint + rules-lint + spec check), and the
full suite (35 files, 718 tests) all pass on the v12 tree.

## 10. Resolution (2026-10-04)

The boot failure in §8–§9 was not the upgrade. The Herdr `server` tab's shell
was opened before the installer rewrote the `~/.zshrc` pnpm block, so its
`PATH` still pointed at the deleted `~/Library/pnpm/pnpm`. Every
`dev:start` typed `pnpm app:dev` into that shell, which answered
`zsh: command not found: pnpm`, and the start timed out with nothing in
`logs/local-worker.log`. A standalone `pnpm dev` booted Vite and workerd
cleanly on the v12 tree and resolved every module, which confirmed the
dependencies were fine.

Fix: `source ~/.zshrc` in the server tab, then `pnpm dev:reset` to rebuild the
local D1 and object state that `pnpm clean` had wiped. The reset stopped,
wiped, migrated, started, installed on `sandbox-shop-00` and seeded, all ok.
`dev:status` reports healthy, and `pnpm node --version` reports the pinned
26.10.0.

Any other long-lived shell has the same stale `PATH`, including the
`server` tabs of the linked worktrees. Each needs `source ~/.zshrc` or a new
tab before it runs pnpm.

After the reset, the embedded app returned `{"status":500,"message":"HTTPError"}`.
The cause was a separate dev-server issue, not pnpm. Vite's watcher crawled the
real `refs/` directory in the main checkout and reported 168 `tsconfig.json`
files as added. For each one Vite cleared its tsconfig cache and sent a full
reload. During that storm SSR failed with two React copies
(`Cannot read properties of null (reading 'useEffect')`). Linked worktrees are
unaffected because their `refs` is a symlink. Fix: `server.watch.ignored:
["**/refs/**"]` in `vite.config.ts`. A cold `dev:stop` + `dev:start` then logged
no tsconfig events, no reloads and no errors.

Remaining (2026-10-04): the linked worktrees, per §5 step 4. Each still runs
10.17.1 modules until it takes in `main` and reinstalls, and their long-lived
shells still have the stale `PATH`.

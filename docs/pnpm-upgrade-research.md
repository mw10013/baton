# pnpm 10.17.1 → 12.8.1 upgrade — research

**Status: researched 2026-10-03, not yet applied.** Current pin is
`package.json:129` (`pnpm@10.17.1`); latest upstream is `12.8.1`.
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
3. **Set `minimumReleaseAge: 0`** as part of the upgrade, or the new 24-hour
   freshness default will block pre-release tracking (`effect@4.0.0-rc.*`).
4. **`allowBuilds: { workerd: true }`** replaces the current build settings;
   the current file lists `workerd` under both keys, which collapses to one
   entry.

---

## 1. Current state

| Fact                                                                                                                                                                         | Verified                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| pnpm pin `pnpm@10.17.1`                                                                                                                                                      | `package.json:129`, `pnpm --version` in repo → `10.17.1`                                  |
| Lockfile `lockfileVersion: '9.0'`                                                                                                                                            | `pnpm-lock.yaml:1`                                                                        |
| Store `v10`                                                                                                                                                                  | `pnpm store path` → `~/Library/pnpm/store/v10`                                            |
| Build settings: `ignoredBuiltDependencies` + `onlyBuiltDependencies`, both `[workerd]`                                                                                       | `pnpm-workspace.yaml:4-8`                                                                 |
| Node `^26.0.0` required by repo; active Node is brew `v26.10.0`                                                                                                              | `package.json:126-128`, `which -a node`, `node --version`                                 |
| pnpm-managed Node 24.14.0 exists but is shadowed                                                                                                                             | `~/Library/pnpm/node -> nodejs/24.14.0/bin/node`; brew precedes it on `PATH`              |
| No `.npmrc`, no `package.json#pnpm` field, no `auditConfig`, no `patchedDependencies`/`pnpmfile`, no git/tarball deps, no `npm_config_*`, no `pnpm server`/`pnpm link` usage | grep over repo (only hits: the two `pnpm-workspace.yaml` keys, `scripts/worktree.ts:122`) |
| `scripts/worktree.ts:122` uses bare `pnpm install --frozen-lockfile`                                                                                                         | still valid in v12; only the `--frozen-lockfile false` form was removed                   |

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
  but it never runs: brew Node 26.10.0 wins on `PATH`. v11+ requires Node 22+
  to run pnpm itself, which brew Node satisfies. No Node action needed.

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

| Upstream change                                                                                                          | Impact here                                                                                                                                            | Action                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `onlyBuilt`/`ignoredBuilt` → `allowBuilds`                                                                               | **Breaking.** Current `pnpm-workspace.yaml:4-8` keys are ignored with an error under v11+.                                                             | `allowBuilds: { workerd: true }`                     |
| `packageManager` pin                                                                                                     | Cosmetic until bumped; then enforces the new unknown-key strictness.                                                                                   | Bump to `pnpm@12.8.1`                                |
| `minimumReleaseAge: 1440`                                                                                                | **Real friction.** Pre-release tracking (`effect@4.0.0-rc.*`, fast TanStack) stalls 24h on `add`/`update`.                                             | Set `minimumReleaseAge: 0` (keeps v10 behavior)      |
| `strictDepBuilds: true`                                                                                                  | New deps with postinstall fail until allow-listed. Intended; first failure will surprise.                                                              | None now; use `pnpm approve-builds` when adding deps |
| Store v10 → v11                                                                                                          | One-time index re-fetch; CI-style caches keyed on store path miss once.                                                                                | None in repo; re-run `pnpm install` per worktree     |
| Peer-resolution canonicalization                                                                                         | One-time lockfile re-keying on first resolving install.                                                                                                | Commit the resulting `pnpm-lock.yaml`                |
| `verifyDepsBeforeRun: install`                                                                                           | `pnpm run`/`exec` may trigger installs (e.g. under `scripts/dev.ts`, which shells `pnpm app:dev`). Masks stale installs less, adds occasional latency. | Awareness only                                       |
| `blockExoticSubdeps: true`                                                                                               | None: zero git/tarball deps, direct or transitive.                                                                                                     | None                                                 |
| `.npmrc` / `package.json#pnpm` / `npm_config_*`                                                                          | None: none exist here.                                                                                                                                 | None                                                 |
| `link`, `server`, `install -g` (bare), npm passthrough, `auditConfig`                                                    | None: unused.                                                                                                                                          | None                                                 |
| Git-URL canonicalization, `engineStrict` tightening, Linux import method, `sudo` globals, `pnpm add yarn/node` semantics | None: no git deps, `engineStrict` unset, macOS dev machines, no such invocations.                                                                      | None                                                 |
| Node 22+ runtime requirement                                                                                             | None: brew Node 26.10.0.                                                                                                                               | None                                                 |

## 5. Upgrade plan

1. Upgrade the shim on this machine (all worktrees share it): re-run the
   standalone install script, or `pnpm self-update` once a v12 shim exists.
2. In the repo: replace `pnpm-workspace.yaml:4-8` with
   `allowBuilds: { workerd: true }`, add `minimumReleaseAge: 0` (see §6),
   bump `package.json:129` to `pnpm@12.8.1`. (Or `pnpx codemod run
pnpm-v10-to-v11` plus the `minimumReleaseAge` line by hand.)
3. Fresh install and commit: `pnpm install` (expect store re-index and a
   possible lockfile diff), then `pnpm typecheck`, `pnpm lint`,
   `pnpm test`, `pnpm dev:start --seed`; confirm the `workerd` build runs.
4. Repeat step 3 in each linked worktree (`wt-NN` has its own
   `node_modules`/`.wrangler`; the store is shared so the re-index happens
   once).
5. `pnpm refs:check` anywhere; `pnpm refs fetch` only in the main worktree
   (unchanged rule, `docs/worktrees-runbook.md:193`).

## 6. Decisions

- **`minimumReleaseAge: 0` — recommended.** The v11 default is a supply-chain
  improvement in general, but this repo pins release candidates and updates
  aggressively; a 24h resolution blackout on every fresh publish costs more
  than it protects here. Revisit if the repo ever needs the delay.
- **No other decision pending.** `allowBuilds` mapping is forced,
  `pmOnFail` needs no setting (no strictness settings exist today), and
  `devEngines.packageManager` ranges are unnecessary while the exact pin
  suffices.

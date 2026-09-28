# Linked worktrees with Herdr — research

> Superseded in places. "Slot" is now just "worktree" (main worktree, linked worktree `wt-NN`), and decision 10 replaced the numbering: main is index 0, linked worktrees count from 1, and branch, port and store all derive from the index. `docs/worktrees-runbook.md` is current.

Goal: run several coding agents on Baton at once, each in its own Git linked worktree and Herdr workspace, each with its own dev server, port and Shopify dev store, all against the one `baton-local` app.

Versions checked: herdr 0.9.0, Shopify CLI 4.7.0 (`refs/shopify-cli`, the installed binary), git 2.55.0. The pasted plan from another LLM was checked against the repo; where it and the repo disagree, the repo wins and the difference is called out.

## TL;DR

- **One app, one dev store per worktree works.** `shopify app dev` previews are scoped to the dev store: the tunnel URL, redirect URLs, webhooks and the `admin_link` extension go to that store only, through store-scoped dev-session mutations. There is no per-app lock. Shopify's own docs recommend one shared dev app with a dev store per developer. `shopify.app.toml` (`baton-local`, with its managed pricing plans) stays shared and unchanged.
- **The only hard collision is the web port.** `shopify.web.toml` has `port = 3800`; a second session aborts with `Hard-coded port 3800 is not available`. Every other port the CLI and Vite plugin open is random or falls back to a free one.
- **The web port does not need a generated `shopify.web.toml`.** Shopify CLI reads `BACKEND_PORT` from its own environment before the TOML's `port`. Delete `port` from the tracked `shopify.web.toml` and start the CLI with `BACKEND_PORT=$PORT`; `.env` stays the only place the port is written. The generated-toml plan in the pasted conversation is the fallback if this does not hold up in a manual test.
- **The store is hard-coded in three places** (`app:dev`, `DEFAULT_SEED_SHOP`, `SHOPIFY_PREVIEW_URL`) and `scripts/dev.ts` parses it out of the `app:dev` script. Move it to one `.env` key.
- **`refs` as a symlink works with no ignore change.** `.gitignore` already says `refs` (no slash). `git worktree remove` deletes the link and leaves the target alone (tested). The real wrinkle is that refs are pinned to the dependency versions of the checkout that fetched them, and a shared `refs` has only one version.
- **`AGENTS.md` says "Commit to `main`. Do not create branches."** That rule has to change for linked worktrees.

## How Herdr does worktrees

`herdr worktree` (0.9.0):

```
herdr worktree list   [--workspace ID | --cwd PATH]
herdr worktree create [--workspace ID | --cwd PATH] [--branch NAME] [--base REF] [--path PATH] [--label TEXT] [--focus] [--no-focus]
herdr worktree open   [--workspace ID | --cwd PATH] (--path PATH | --branch NAME) [--label TEXT]
herdr worktree remove --workspace ID [--force]
```

- `create` runs `git worktree add` for a new branch and opens a Herdr workspace rooted at it, linked to the source workspace (`baton`, `w1`). `worktree list` reports `source_checkout_path`, `is_linked_worktree` and `open_workspace_id` per worktree.
- The default location is `~/.herdr/worktrees` (config `[worktrees] directory`, commented out in the default `config.toml`); `--path` overrides it per worktree. The exact subpath under that directory was not checked because no worktree was created during this research. The location matters for one thing only: a linked worktree is **outside** the main checkout, so the `refs` link must be absolute.
- `remove --workspace ID` removes the checkout; `workspace close --group` closes the source workspace **and** its linked ones, so do not use it to close just a worktree.
- `pnpm dev:start` already works per workspace. It looks for the `server` tab in `HERDR_WORKSPACE_ID` (`placeServer` in `scripts/dev.ts`), adopts a `shopify app dev` by working directory, and holds `logs/dev.lock` in the checkout. A second workspace gets its own `server` tab and its own lock with no code change.

## Shopify: one app, two stores

Evidence from `refs/shopify-cli/packages/app/src/cli/`:

| Question                                                              | Answer                                                                                                                                                                                                       | Where                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Does `automatically_update_urls_on_dev` rewrite the app's global URL? | No. Dev patches the URLs in memory only (`setDevApplicationURLs`); they reach Shopify inside the dev-session manifest. `updateURLs` is never called from dev, and on the Dev Dashboard client it is a no-op. | `services/dev.ts` `handleUpdatingOfPartnerUrls`; `models/app/app.ts` `patchAppConfiguration` |
| Is the dev session store-scoped?                                      | Yes. `DevSessionCreate/Update/Delete` go to the store's own endpoint, `https://<store>/app_dev/unstable/graphql.json`.                                                                                       | `cli-kit/src/public/node/api/app-dev.ts`; `services/dev/processes/dev-session/`              |
| Any one-session-per-app lock?                                         | None. The same store twice would silently overwrite each other's preview (last write wins).                                                                                                                  | —                                                                                            |
| Where is the chosen store remembered?                                 | `<checkout>/.shopify/project.json`, keyed by client_id (gitignored, so per worktree). Order: `--store`, then `build.dev_store_url` in the TOML, then `project.json`, then a prompt.                          | `services/store-context.ts` `storeContext`                                                   |
| Tunnel                                                                | Each session spawns its own `cloudflared` quick tunnel on a random proxy port.                                                                                                                               | `plugin-cloudflare/src/tunnel.ts`                                                            |
| Docs                                                                  | "isolated to the chosen dev store and does not affect the app URL on other stores"; teams "can safely share a single development instance of an app", one store each.                                        | `refs/shopify-docs/docs/apps/build/cli-for-apps/test-apps-locally.md`                        |

Baton already relies on this: `app:dev:stress` runs the same `shopify.app.toml` against `stress-shop-01`.

Do not add `build.dev_store_url` to `shopify.app.toml`. Each session would write its store back into the shared, committed file.

### Ports

| Port                                          | How it is chosen                                                                                                                                                                                                                    | Two worktrees      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Web (Vite)                                    | `BACKEND_PORT` env, else `shopify.web.toml` `port`, else random (`getBackendPort() ?? backendConfig.configuration.port ?? getAvailableTCPPort()` in `services/dev.ts`). A TOML `port` that is taken throws (`validateCustomPorts`). | **Collides today** |
| CLI proxy (what cloudflared forwards to)      | random                                                                                                                                                                                                                              | fine               |
| GraphiQL                                      | 3457, falls back to random with a warning                                                                                                                                                                                           | fine               |
| Theme app extension, UI extension dev servers | not started: the only extension is `extensions/baton-order-link`, an `admin_link`                                                                                                                                                   | fine               |
| workerd inspector (`@cloudflare/vite-plugin`) | 9229, falls back to the next free port (`src/debug.ts`, `get-port`)                                                                                                                                                                 | fine               |

There is a second hazard that is not a collision: `vite dev --port $PORT` without `strictPort` quietly moves to the next free port when `PORT` is taken, while the CLI proxy keeps dialing `PORT`. Set `server.strictPort: true` in `vite.config.ts` so a wrong or duplicate port fails loudly.

### The port without a generated `shopify.web.toml`

Today `.env` `PORT` and `shopify.web.toml` `port` must agree by hand (the comment in `shopify.web.toml` says why). With a single web that has both roles, Shopify CLI resolves the backend port from `BACKEND_PORT` first, uses it as the frontend port too, points the proxy at it and passes it to `pnpm dev` as `PORT`.

So:

1. Remove `port = 3800` from `shopify.web.toml` (tracked, identical in every worktree).
2. `app:dev` exports `.env` and sets `BACKEND_PORT` from it, e.g. `set -a && source .env && set +a && BACKEND_PORT=$PORT shopify app dev --config shopify.app.toml --store $SHOPIFY_DEV_STORE`.
3. `pnpm dev` keeps sourcing `.env`, which now agrees with the CLI by construction.

This removes a file to generate, a file to gitignore and a check that two files agree. The unverified part is only that a `BACKEND_PORT` that is taken fails clearly; `strictPort` covers that from Vite's side. Verify with one manual run before building on it.

Fallback if it does not work: gitignore `shopify.web.toml`, track `shopify.web.toml.example`, have `worktree:init` write the port in. Shopify CLI discovers only files named exactly `shopify.web.toml`, so the `.example` file is not picked up.

### The store as one `.env` key

The store name `sandbox-shop-01` is written in:

- `package.json` `app:dev` (`--store sandbox-shop-01`). `scripts/dev.ts` `loadConfig` regex-parses `--store` and `--config` out of this script to build the shop domain and the admin URL it opens for install.
- `scripts/lib/seed.ts` `DEFAULT_SEED_SHOP`.
- `.env.playwright` `SHOPIFY_PREVIEW_URL` (`…/store/sandbox-shop-01/apps/baton-local/app`), which `e2e/seed.ts` also parses for the shop domain.

Proposal: `SHOPIFY_DEV_STORE=sandbox-shop-01` in `.env`. `app:dev` passes `--store $SHOPIFY_DEV_STORE`. `dev.ts` reads the env var instead of parsing the script. `DEFAULT_SEED_SHOP` derives from it. `SHOPIFY_PREVIEW_URL` either derives from store + handle (drop the key) or stays and `worktree:init` writes it.

### Other per-worktree state

- `.wrangler/` (local D1, Durable Objects, KV) is per checkout. A new worktree starts with no `ShopSession`; `pnpm dev:start --seed` installs and seeds it, as after `dev:reset`.
- The CLI's first run in a new directory sends a sample `app/uninstalled` webhook for its store to its own local server (`processes/uninstall-webhook.ts`, triggered because that directory has no cached app id). Local only; harmless on empty state.
- A store's preview outlives the session and points at a dead tunnel until the next `app dev` or `shopify app dev clean --store <store>`.
- `BETTER_AUTH_URL=http://localhost:3800` in `.env` must follow `PORT` (magic links for `/shop` and `/admin` are minted from it; `src/lib/Auth.ts`).
- `playwright.config.ts` already reads `PORT` for the member and admin projects. Only its `?? "3000"` fallback is wrong; make it fail instead.
- `playwright/.auth/shopify-admin.json` is per checkout and regenerated by the `setup` project from Chrome's cookies. The cookies are for the Shopify account, so they cover any store in it.
- The billing e2e project gets $0 plans only because the store is a development store in the same organization as `baton-local` (`e2e/plan.billing.spec.ts`). The second store has to be created in that same organization.

## `refs`

`refs` is a real directory in the main checkout today. (The comment in `shopify.app.staging.toml` still says "via the refs symlink", from when it pointed at a sibling repo.)

- **Link target.** `git rev-parse --path-format=absolute --git-common-dir` returns `<main>/.git` in a linked worktree; its parent is the main checkout. The link is `<linked>/refs -> <main>/refs`, absolute because Herdr places worktrees outside the main checkout.
- **Ignore rule.** Already `refs` with no trailing slash (`.gitignore:18`); `git status --ignored` in a linked worktree shows `!! refs` for the link. No change.
- **Removal.** Tested in a scratch repo: `git worktree remove` on a clean linked worktree with an ignored `refs` symlink succeeds and leaves `<main>/refs` intact. Herdr's `worktree remove` was not tested; do the first one on a throwaway worktree.
- **`scripts/refs.ts` through the link.** It resolves `repoRoot` from its own file location and writes `path.join(root, "refs", name)`, which follows the link into the main checkout. It removes `refs/<name>` and renames a staging directory into place, never `refs` itself, so the link survives.
- **Shopify CLI.** Web discovery follows symlinks and would find `refs/bang/shopify.web.toml`. The `web_directories = ["."]` in `shopify.app.staging.toml` already narrows discovery to the repo root (see `docs/shopify-web-toml-conflict-research.md`), and that file is tracked, so every worktree has it.
- **Version pins.** `AGENTS.md` promises that `refs/` matches the dependency versions in use, and `pnpm refs:check` compares against the `package.json` of the checkout that runs it. A worktree that bumps a dependency and runs `pnpm refs fetch` replaces the ref for every worktree, including `main`, which is still on the old version. See question 5.

## `pnpm worktree:init`

What it does, given the decisions below:

1. Refuse to run in the main checkout (git dir equals common dir).
2. Refuse a `--port` or `--store` that another worktree's `.env` already claims (`git worktree list --porcelain`, read each `.env`). This is the whole port registry; no separate file.
3. `.env`: if missing, copy the **main checkout's** `.env` (not `.env.example`, which has blank secrets) and set `PORT`, `BETTER_AUTH_URL` and `SHOPIFY_DEV_STORE`. If present, verify those three and fail on disagreement rather than rewrite.
4. `refs`: create the link if missing; verify its target if present; fail if it is a real directory.
5. `pnpm install` (the pnpm store is global and hardlinked, so this is fast).
6. Apply the D1 migrations to the new checkout's empty local D1 (found in the manual run below).
7. Print the next step: `pnpm dev:start --seed`.

There is no `.env.playwright` step: decision 9 removed the file.

An Effect CLI script in `scripts/` like `scripts/dev.ts` fits. Everything above is idempotent: a second run only verifies.

Workflow (one long-lived worktree per slot, decision 8):

```
# once, in the baton workspace (main checkout)
herdr worktree create --branch wt-02 --label wt-02
# once, in the new workspace
pnpm worktree:init --port 3801 --store sandbox-shop-02
pnpm dev:start --seed

# per task, in baton-02
git merge --ff-only main        # start from current main
# ... agent works, commits to wt-02 ...
git rebase main                 # if main moved meanwhile
# per task, back in main
git merge --ff-only wt-02
```

## Decisions

1. **Second dev store: create `sandbox-shop-02`** in the Dev Dashboard, in the same organization as `baton-local`, rather than reusing `stress-shop-01`, which holds volume data and would be shared. Install goes through `pnpm dev:start`, which opens the admin URL and walks through the managed pricing plan selection like any install.
2. **Port: `BACKEND_PORT`, no `port` in `shopify.web.toml`.** `.env` is the single place the port is written, and `shopify.web.toml` stays tracked and identical everywhere. Verify by hand first (check 2 below); fall back to a generated `shopify.web.toml` only if it fails.
3. **`worktree:init` takes explicit `--port` and `--store`**, not a slot number, and refuses a value another worktree's `.env` already claims.
4. **`SHOPIFY_PREVIEW_URL` is derived** from `SHOPIFY_DEV_STORE` and the handle `baton-local` (in `wrangler.jsonc` as `SHOPIFY_APP_HANDLE`); the key is removed (`e2e/devStore.ts`).
5. **Only the main checkout changes `refs`.** `pnpm refs fetch` refuses in a linked worktree and says to run it in main; `refs:check` runs anywhere. A dependency bump made on a branch reaches `refs` when it is merged and fetched on `main`.
6. **`AGENTS.md` git rule becomes:** "In the main checkout, commit to `main`. In a linked worktree, commit to that worktree's branch; never check out `main` there. Merging is done from the main checkout."
7. **`worktree:init` runs `pnpm install` but does not start the server.** `dev:start` already decides where the server runs, and keeping it separate keeps `init` safe to re-run.
8. **One long-lived worktree per slot, branch `wt-NN`**, where `NN` is the store number (`wt-02` ↔ `sandbox-shop-02` ↔ port 3801), Herdr label `wt-NN`. The main checkout is slot 01 (`main`, `sandbox-shop-01`, 3800). Setup happens once per slot, not once per task. Options considered are below.
9. **`.env.playwright` is removed.** With `SHOPIFY_PREVIEW_URL` derived, its only other key was `SHOPIFY_CHROME_PROFILE`, which picks the Chrome profile whose Shopify cookies the Playwright `setup` project exports. It was never set (bang's copy does not have it either), so every run used Chrome's `Default`. The profile is now the constant `CHROME_PROFILE = "Default"` in `scripts/lib/shopify-playwright-auth.ts`; `node scripts/refresh-shopify-playwright-auth.ts --profile "Profile 1"` still covers a login kept in another Chrome profile. One fewer file per checkout.

10. **Naming from one index (replaces 3 and the numbering in 8).** Decided from first principles, so the pattern carries to projects without Shopify:
    - The main worktree is index 0 and keeps the name `main`: it is where merges, pushes and `refs` fetches happen, not a peer. Linked worktrees are interchangeable peers counted from 1: `wt-01`, `wt-02`. The earlier scheme (main as 01, first linked worktree `wt-02`) left a visible gap and an off-by-one in the port (`3799+NN`).
    - Everything a worktree must not share derives from the index: branch, folder and Herdr label `wt-NN`, port `3800 + NN`, dev store `sandbox-shop-NN`. `worktree:init --index NN` takes only the number and refuses a branch that is not `wt-NN`.
    - Dev stores stay a pool shared across projects (bang uses the same stores), named `sandbox-shop-NN`, not per project (`baton-dev-NN` was considered and rejected as too granular). Sharing is safe because each project is its own app on the store; only store data is shared. `sandbox-shop-00` was created for the main worktree; the first linked worktree moves to `sandbox-shop-01`, and `sandbox-shop-02` waits for a `wt-02`.
    - Numbers, not names: they sort, give ports by arithmetic, and say nothing about the work, which changes task to task.

## Branch naming: options considered

The names are generic, not feature names. The real choice underneath is whether a worktree lives for one task or for many.

| Option               | Example              | Lifetime                                                                                                     | Per-task cost                                                                                                                                                                               | Trade-offs                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Slot branch       | `wt-02`              | worktree kept across tasks; after each merge into `main`, the worktree fast-forwards to `main` and continues | none                                                                                                                                                                                        | `02` ties branch, Herdr label `wt-02`, store `sandbox-shop-02` and port 3801 together. `.wrangler` state, `node_modules`, the store install and the Herdr workspace survive between tasks. The branch never gets deleted, and its name says nothing about its content (which you want). Local data accumulates; `pnpm dev:reset` clears it when needed. |
| B. Slot plus counter | `wt-02-1`, `wt-02-2` | worktree removed after each merge, a new one created per task                                                | `herdr worktree create`, `worktree:init`, `pnpm install`, `dev:start --seed` and the admin install/token exchange again, because `.wrangler` (and its `ShopSession`) goes with the checkout | Clean state every task. Counter has to be tracked or found from `git branch --list 'wt-02-*'`.                                                                                                                                                                                                                                                          |
| C. Dated             | `wt/2026-09-27-a`    | as B                                                                                                         | as B                                                                                                                                                                                        | No counter to track, but two worktrees on one day need a suffix, and the name no longer points at a slot.                                                                                                                                                                                                                                               |

Rules for A (chosen):

- Before a new task, in the worktree: `git merge --ff-only main`. It fails loudly if the worktree has commits that were never merged, which is the case to catch.
- Merge from the main checkout with `git merge wt-02` (fast-forward or merge commit both leave `wt-02` an ancestor of `main`, so the fast-forward above works either way).
- A slot is removed only when you retire it: `herdr worktree remove --workspace <id>`, then `git branch -D wt-02`.
- Git lets a branch be checked out in only one worktree, so `wt-02` cannot be opened twice by accident.

## Verified by hand (2026-09-27)

Slot 02 was set up by hand as `worktree:init` would, with the main checkout's server running on 3800 / `sandbox-shop-01` throughout.

1. `herdr worktree create --workspace w1 --branch wt/02 --base main --label baton-02 --no-focus` created the checkout at `~/.herdr/worktrees/baton/wt-02` (`<directory>/<repo>/<branch with / as ->`) and workspace `baton-02`. Both were renamed to `wt-02` afterwards.
2. With `port` removed from `shopify.web.toml`, `BACKEND_PORT=3801 shopify app dev --config shopify.app.toml --store sandbox-shop-02` started Vite on `127.0.0.1:3801` behind its own tunnel. Both 3800 and 3801 answered 200 at the same time.
3. A fresh checkout has no local D1 tables: the CLI's sample `app/uninstalled` webhook failed with `no such table: ShopSession` until `pnpm d1:migrate:apply` ran. `worktree:init` has to apply the migrations.
4. Installing from the store 02 admin, with plan selection (`plan_handle=baton-basic`), wrote a `ShopSession` for `sandbox-shop-02` into the worktree's D1 only; main's D1 still holds only `sandbox-shop-01`.

Not done: routing an `orders/create` webhook to each worktree (skipped; store-scoped dev sessions predict it), and `herdr worktree remove` (slot 02 is kept; plain `git worktree remove` was tested in a scratch repo).

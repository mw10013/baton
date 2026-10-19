# Worktrees runbook

How this repository's long-lived worktrees are laid out, set up and used.

## Layout

There is a fixed set of worktrees, `wt-01`, `wt-02`, …, created once and reused task after task. Each checkout runs its own dev server (`shopify app dev`, which runs `alchemy dev`) on its own port and its own Shopify dev store.

| Checkout | Branch  | Folder                 | `WEBSITE_PORT`       | `SHOPIFY_DEV_STORE`   | `SHOPIFY_E2E_STORE`   | herdr workspace        |
| -------- | ------- | ---------------------- | -------------------- | --------------------- | --------------------- | ---------------------- |
| main     | `main`  | wherever you cloned it | set in `.env` (3900) | `mw10013-dev-shop-00` | `mw10013-e2e-shop-00` | `baton`                |
| `wt-NN`  | `wt-NN` | chosen by T3 Code      | main's port + NN     | `mw10013-dev-shop-NN` | `mw10013-e2e-shop-NN` | `wt-NN`, under `baton` |

- **Folders:** `git worktree list` shows every checkout's folder, with main first. Look them up there; don't assume a path.
- **Per checkout:** `.env`, `node_modules/`, `.alchemy/` (local data and Alchemy state for every local stage), `.logs/` and `.shopify/` (the CLI's record of the store). `vp run worktree:init` writes `WEBSITE_PORT`, `SHOPIFY_DEV_STORE` and `SHOPIFY_E2E_STORE` into a worktree's `.env`, checks both stores exist (also available as `vp run stores:check`) and refuses a port or store another checkout holds: two `shopify app dev` sessions on one store overwrite each other's app URL. Missing stores must be created by hand; see [Shopify stores](./shopify-stores-runbook.md).
- **Stages:** each checkout has its own dev, test and e2e stage, `<environment>-<user>` in main and `<environment>-<user>-wt-NN` in a worktree (`dev-mw-wt-01`). `node scripts/stage.ts dev` prints the checkout's dev stage. They are all local, under the checkout's `.alchemy/`.
- **Shared:** `refs/` and each deployed stage's `.env.<stage>` (today `.env.staging`) exist once, in main. `vp run worktree:init` gives each worktree a symlink to each.
- **herdr:** each checkout's dev server runs in a `dev` tab in that checkout's herdr workspace.

## Set up a worktree

Create each worktree once, from a T3 thread on the main checkout. There is no T3 project action for setup: the new worktree's agent runs the bootstrap itself.

1. **Pick the next free `NN`.** `git worktree list` shows the existing ones. `main` must already contain the worktree scripts (`scripts/worktree.ts`, `scripts/dev.ts`), because a new worktree only gets committed files.
2. **Create it with T3's `t3_thread_launch` tool:**

   ```json
   {
     "title": "wt-NN",
     "workspaceStrategy": {
       "type": "worktree",
       "baseRef": "main",
       "branch": "wt-NN",
       "startFromOrigin": false
     },
     "message": "Bootstrap this worktree per docs/worktrees-runbook.md: run `vp install --frozen-lockfile`, `vp run worktree:init`, `vp run dev` and `vp run dev:status`, in that order, stopping at the first failure. Report the dev URL, health, port and herdr placement, or the failing command and its output."
   }
   ```

   T3 creates the named branch and folder and starts the agent there. Keep `workspaceStrategy.branch` explicit; use this launch instead of the UI's **New worktree** option. Keep the thread's permission setting on **Auto**, so the bootstrap commands run without prompts.

3. **The new thread bootstraps the worktree,** in its own checkout:

   ```sh
   vp install --frozen-lockfile
   vp run worktree:init
   vp run dev
   vp run dev:status
   ```

4. **Check what it reports:**
   - `pnpm port` prints main's port + NN;
   - `vp run dev:status` reports healthy;
   - herdr shows `wt-NN` under `baton`, with a `dev` tab.

Before seeding the new worktree's dev store, a person authorizes it once with `shopify store auth`; see [Shopify stores](./shopify-stores-runbook.md).

`vp run worktree:init` is safe to run again; a second run only checks. If it fails, it says what to fix; fix it and rerun the bootstrap from that command.

**If the launch fails, stop and tell the user.** Don't work around it, for example by creating the worktree with git: T3 decides where worktrees live, and that can change between T3 releases.

## Open a thread on a worktree

Use one of these in the T3 composer:

- the branch picker in **Current checkout** mode: choose `wt-NN`, and the thread binds to that worktree;
- **New thread in this worktree**, from an existing `wt-NN` thread;
- **Previous worktree**.

Don't use **New worktree**: it creates a throwaway worktree with a generated name.

If T3 asks "Delete the worktree too?" when you delete a thread, answer **No**.

## Dev server

Run these in the checkout whose server you mean:

```sh
vp run dev         # start it, or adopt the one already running
vp run dev:status   # healthy?, where it runs, port
vp run dev:logs     # tail of .logs/dev/current
vp run dev:stop
```

- `dev` puts the server in the checkout's herdr `dev` tab and opens the workspace if needed. The scripts' `--help` explains where it runs in each case.
- Logs are always in `.logs/dev/current`.
- Don't start or stop another checkout's server unless asked.

## End-to-end tests

E2E uses the checkout's `.env`; there is no separate `.env.e2e`. It derives its port as `WEBSITE_PORT + 100` (`4001` in `wt-01`) and uses `SHOPIFY_E2E_STORE`, separate from the dev server's store. The stage is `e2e-<user>-wt-NN` in a worktree.

```sh
vp run e2e:start            # start this checkout's E2E server once; it stays up
vp run test:e2e             # run every project against it
vp run test:e2e:headed      # same suite with visible browsers
vp run test:e2e:ui          # Playwright UI
vp run e2e:status           # running, answering, tunnel ready; hints when a restart is due
vp run e2e:stop             # stop it
```

The E2E server is long-lived, like the dev server, and placed the same way (herdr tab `e2e`). It runs Shopify CLI and its tunnel on the E2E store and writes logs to `.logs/e2e/current` (`vp run e2e:logs`). Playwright does not start it: a run's preflight fails at once with `vp run e2e:start` when it is down, or when its tunnel does not serve. Every run opens the app in the E2E store first and loads the E2E fixture, which replaces the shop's data from the last run, so every project needs the Shopify admin login. That project and the embedded one use installed Google Chrome; see [the E2E admin login](./shopify-stores-runbook.md#the-e2e-admin-login) for cookie export and Keychain access. The other browser project uses Playwright Chromium (`vp exec playwright install chromium` if missing).

`src/` edits hot-reload into the running server; do not edit during a run. `vp run e2e:restart` (stop, destroy the E2E stage, start) is the clean slate, and is needed after a change to dependencies, `alchemy.run.ts` or the stack, `patches/`, or the schema's `0001_init`. `vp run db:reset` stops the E2E server too, because it removes every stage's local data; start it again afterwards. Auth exports, results and reports live under ignored `playwright/`.

## Working across checkouts

Every checkout shares one git repository, so every branch is visible everywhere at once, with no fetch.

- **Read anything from anywhere:** `git show main:src/x.ts`, `git diff main...wt-02`, `git log wt-02`.
- **Commands can run in another checkout,** because it is just another folder: `git -C <path> status`, or `(cd <path> && vp test)`.
- **Write and commit only in your own checkout,** to its own branch. Landing on `main` (below) is the one exception.
- **A worktree never checks out `main`.** `main` is always checked out in the main checkout, and git allows a branch in only one checkout at a time.
- **For a scratch copy of another commit,** run `git worktree add --detach /tmp/<name> <ref>`, and `git worktree remove` it afterwards. It has no `.env`, so no dev server; it is for reading and tests only.

## Keeping up with `main`, and getting work onto it

History stays linear: worktree branches are rebased, and `main` only moves by fast-forward. `wt-NN` branches are never pushed, so rebasing them is always safe.

- **Start of a task in `wt-NN`:** run `git rebase main`. With no commits of its own, the branch just moves up to `main`.
- **During a task:** commit to `wt-NN` as needed, and rebase onto `main` again whenever other work has landed.
- **Getting the work onto `main`:** this happens only when the user asks.

  1. In `wt-NN`, run `git rebase main`, then `vp check` and `vp test`.
  2. Fast-forward `main`, from either checkout:
     - from `wt-NN`: `git -C <main checkout> merge --ff-only wt-NN`;
     - from main: `git merge --ff-only wt-NN`.

  `--ff-only` refuses rather than create a merge commit; if it does, rebase again. It also refuses if uncommitted changes in main touch the same files, and then it changes nothing.

  To land as one commit, first run `git reset --soft main && git commit` in `wt-NN`.

- **Pushing:** only from main, and only when the user asks. A push to `main` deploys staging.
- **After a rebase or landing:**
  - If `pnpm-lock.yaml` changed, run `vp install` and restart the server.
  - If `alchemy.run.ts` or config changed, restart the server.
  - Other worktrees pick up the landed work when they next rebase.

If a sync replaces the initial database schema and the dev logs report missing columns, back up the checkout's `.alchemy/local` and `.alchemy/state`, then run `vp run db:reset`. This removes local data and state for **every** stage in this checkout and restarts dev, so stop E2E first. It then opens the app in the dev store and loads the dev fixture (see the stores runbook), which writes the dev store's products and orders; it does not touch deployed stages.

## Retire a worktree (rare)

1. `vp run dev:stop` in the worktree.
2. Close its herdr workspace.
3. From main: `git worktree remove <wt-NN folder>`, then `git branch -D wt-NN`. Its stages are all local, so removing the folder removes them; nothing is left in Cloudflare state.
4. Archive its T3 threads.

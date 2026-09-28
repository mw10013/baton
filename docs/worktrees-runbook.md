# Worktrees runbook

How to run several agents on Baton at once, each in its own git worktree with its own dev server and Shopify dev store. For people and for agents. The reasoning behind each choice is in `docs/worktrees-research.md`.

## The model

Git calls every checkout of a repository a **worktree**. The original one, `~/Documents/src/baton`, is the **main worktree**. The extra ones, made with `git worktree add` (which `herdr worktree create` runs), are **linked worktrees**. All of them share one git history.

Here each worktree is a complete, separate copy of Baton that one agent works in:

- its own copy of the code, on its own branch;
- its own dev server, on its own port;
- its own Shopify dev store, where that server's app is installed;
- its own local database (`.wrangler/`);
- its own Herdr workspace.

Two worktrees never share a port, a store or a database, so two agents can run the app, seed data and run tests at the same time without touching each other.

Every worktree has an **index**, and the index names everything it must not share. The main worktree is 0 and keeps the name `main`; linked worktrees count from 1.

| Worktree | Index | Folder                           | Branch  | Port      | Dev store         | Herdr workspace |
| -------- | ----- | -------------------------------- | ------- | --------- | ----------------- | --------------- |
| main     | 0     | `~/Documents/src/baton`          | `main`  | 3800      | `sandbox-shop-00` | `baton`         |
| `wt-01`  | 1     | `~/.herdr/worktrees/baton/wt-01` | `wt-01` | 3801      | `sandbox-shop-01` | `wt-01`         |
| `wt-NN`  | NN    | `~/.herdr/worktrees/baton/wt-NN` | `wt-NN` | `3800+NN` | `sandbox-shop-NN` | `wt-NN`         |

- A linked worktree's name is `wt-NN`, and the same string is its branch, its folder and its Herdr workspace label. Never a feature name; numbers sort, give ports by arithmetic, and say nothing about the work, which changes task to task.
- The dev stores are a pool shared across projects: every project's worktree `NN` uses `sandbox-shop-NN`. That is safe because each project is its own app on the store; only store data (products, orders) is shared.
- All worktrees share one Shopify app, `baton-local` (`shopify.app.toml`), and its pricing plans. `shopify app dev` previews are per store, so worktrees do not interfere.
- `PORT` and `SHOPIFY_DEV_STORE` in the worktree's `.env` say which one you are in. Every script, the Playwright config and the Shopify CLI read them from there. Ask `.env`, not this table: `pnpm port`, or `grep -E '^(PORT|SHOPIFY_DEV_STORE)=' .env`.
- Per worktree, never shared: `.env`, `node_modules`, `.wrangler/` (local D1, Durable Objects, KV), `.shopify/`, `logs/`, `playwright/`.
- Shared: git history and `refs/` (a symlink in each linked worktree to the main worktree's `refs/`).
- Linked worktrees are long-lived. One takes task after task on the same `wt-NN` branch; you create it once.

## Create a linked worktree (once)

Prerequisites:

1. A development store `sandbox-shop-NN` in the same Shopify organization as `baton-local` (Dev Dashboard → Dev stores), with products. Same organization is what makes the app's plans free on it. The domain comes from the name you type and changes if it is taken, so check it reads exactly `sandbox-shop-NN.myshopify.com`. The one e2e test that imports real orders needs at least one open order in it.
2. Logged into that store's admin in your normal Chrome (`Default` profile). The Playwright setup borrows that login.

From the main worktree's Herdr workspace (`baton`):

```bash
herdr worktree create --branch wt-NN --base main --label wt-NN --no-focus
```

This runs `git worktree add`, creates branch `wt-NN` from `main` in `~/.herdr/worktrees/baton/wt-NN`, and opens workspace `wt-NN` nested under `baton` in the sidebar.

In the new workspace:

```bash
pnpm worktree:init --index NN      # e.g. --index 1 in wt-01: port 3801, sandbox-shop-01
pnpm dev:start --seed
```

- `worktree:init` derives the port and store from the index. It refuses the main worktree, a branch other than `wt-NN`, and a port or store another worktree already uses. It copies `.env` from the main worktree with this worktree's `PORT`, `BETTER_AUTH_URL` and `SHOPIFY_DEV_STORE`, links `refs`, runs `pnpm install`, and applies the D1 migrations. Running it again only checks.
- `dev:start` starts the server in the workspace's `server` tab and, the first time, opens the store's admin so the app installs (pick a plan). It waits for the install, then seeds.

## A task in a linked worktree

Agents work in a linked worktree; merging into `main` happens in the main worktree.

**1. Start from current `main`** (in the linked worktree):

```bash
git status                  # must be clean
git merge --ff-only main
```

`--ff-only` fails if `wt-NN` has commits `main` does not. That means earlier work was never merged: merge it (step 4) or ask before discarding it.

**2. Work and commit** on `wt-NN`. Never `git checkout main` in a linked worktree; git refuses anyway, because `main` is checked out in the main worktree. Do not create other branches.

**3. Take in `main`'s newer changes, when needed** (in the linked worktree):

```bash
git rebase main
```

`wt-NN` exists only on this machine and only this worktree uses it, so rebasing it is safe. Resolve conflicts here, where this worktree's server and tests can check the result. Then re-run what the change touches (`pnpm typecheck`, `pnpm lint`, the tests).

**4. Merge into `main`:**

```bash
# in the linked worktree first, if main has moved since step 1:
git rebase main
# then in the main worktree:
git merge --ff-only wt-NN
git push                    # when you want staging to build
```

`--ff-only` keeps `main` linear, as its history is today. If it fails, `main` moved after the rebase: rebase again in the linked worktree and retry. Conflicts are always resolved in the linked worktree, never in the main worktree.

**Rebase, not squash.** Rebase plus `--ff-only` puts every commit the agent made onto `main`, and afterwards `wt-NN` is part of `main`, so the next `git merge --ff-only main` in the linked worktree just works. `git merge --squash wt-NN` in main gives one commit per task, but `wt-NN` then no longer matches `main`: the next task needs `git reset --hard main` in the linked worktree, and forgetting it merges the old commits a second time. When a task's commits are noise and you want one commit, squash inside the linked worktree before merging back:

```bash
# in the linked worktree
git reset --soft main       # keep the changes, drop the task's commits
git commit                  # one commit with everything
```

`wt-NN` stays in line with `main` either way.

**5. Next task:** back to step 1. The branch is not deleted.

### After pulling in changes

A rebase or fast-forward can change what the running server depends on:

| What changed                                                              | Do                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Source files                                                              | nothing; Vite reloads                                                                                           |
| `package.json` / `pnpm-lock.yaml`                                         | `pnpm install`, then `pnpm dev:stop && pnpm dev:start`                                                          |
| `migrations/` or the Durable Object schema (`src/lib/ShopAgentSchema.ts`) | `pnpm dev:reset` (wipes and reseeds this worktree's local state; schemas are edited in place while prototyping) |
| `shopify.app.toml`, `extensions/`, `vite.config.ts`, `wrangler.jsonc`     | `pnpm dev:stop && pnpm dev:start`                                                                               |

## Dev server and tests, per worktree

Each command acts on the worktree it is run in:

```bash
pnpm dev:status      # where the server runs, port, tunnel, ShopSession
pnpm dev:start       # start or adopt; installs on this worktree's store if needed
pnpm dev:stop
pnpm dev:reset       # wipe this worktree's .wrangler, restart, install, seed
pnpm dev:logs
pnpm seed
npm run test:e2e --   # e2e, member and admin projects against this worktree's port and store
```

- The server runs in the `server` tab of the worktree's own Herdr workspace, even when the command is run from another workspace.
- Local URLs: `http://localhost:$(pnpm port)`. Embedded app: `https://admin.shopify.com/store/<SHOPIFY_DEV_STORE>/apps/baton-local/app`.
- Name `playwright-cli` sessions `$(pnpm port)-<purpose>`, so sessions from different worktrees never collide.

## `refs/`

One copy, in the main worktree. In a linked worktree, `refs` is a symlink to it, so paths like `refs/effect/...` work everywhere. `pnpm refs fetch` runs only in the main worktree (it refuses in a linked one), so `refs/` always matches `main`'s dependency versions. `pnpm refs:check` runs anywhere.

## Remove a linked worktree

Only when you no longer want it. Merge or discard its work first.

```bash
# in the linked worktree
pnpm dev:stop
# in the main worktree
herdr worktree list                          # find its workspace id
herdr worktree remove --workspace <id>
git branch -D wt-NN
```

The `refs` symlink goes with the folder; the main worktree's `refs/` is untouched. The dev store keeps a preview pointing at a dead tunnel; `shopify app dev clean --store sandbox-shop-NN` restores the released version if that matters.

## Rules for agents

- Find your worktree in `.env` (`PORT`, `SHOPIFY_DEV_STORE`) and use only that port and store.
- In the main worktree, commit to `main`. In a linked worktree, commit to its `wt-NN` branch; never check out `main` and never create other branches.
- Do not merge into `main` or push from a linked worktree. Merging and pushing happen in the main worktree, when the user asks.
- Do not run `pnpm refs fetch` in a linked worktree.
- Do not stop, reset or start another worktree's server; each `dev:*` command acts on the worktree it runs in.
- Do not edit `.env` to change `PORT` or `SHOPIFY_DEV_STORE`; they belong to the worktree.

## Troubleshooting

| Symptom                                                | Cause and fix                                                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Port 3801 is already in use` from Vite                | Another process holds this worktree's port (Vite's `strictPort` refuses to move). `lsof -i :3801`; usually a server from an earlier run: `pnpm dev:stop`. |
| `worktree:init`: `PORT=… is already used by …`         | Another worktree's `.env` holds that port or store. Use this worktree's own index.                                                                        |
| `worktree:init`: `.env disagrees with --index`         | This worktree's `.env` was set up for another index. Fix the three keys by hand, or pass the index it was set up with.                                    |
| `no such table: ShopSession`                           | This worktree's local D1 has no schema. `pnpm d1:migrate:apply`, or `pnpm dev:reset`.                                                                     |
| `SHOPIFY_DEV_STORE is missing from .env`               | A `.env` from before worktrees. Add `SHOPIFY_DEV_STORE=sandbox-shop-NN`.                                                                                  |
| `git merge --ff-only main` fails in a linked worktree  | It has unmerged commits. Merge them into `main` (steps 3–4), or discard them with `git reset --hard main` only if you mean to lose them.                  |
| `git merge --ff-only wt-NN` fails in the main worktree | `main` moved. `git rebase main` in the linked worktree, then retry.                                                                                       |
| e2e setup says the admin session is expired            | Open this worktree's store admin in normal Chrome, let it load, retry.                                                                                    |

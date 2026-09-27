# Dev server control: one command an agent runs and a person can pick up

## What was asked

Getting local development into a working state is a set of manual steps the
user runs for the agent: stop the server, `pnpm d1:reset`, `pnpm app:dev`,
press `p` so the embedded app loads in the admin, `pnpm seed`. The goal is one
command that an agent and a person can both run, covering:

- **Start / recovery**: bring the dev server up, or back up, without wiping
  anything. This is the common case: an e2e run fails to connect, or the user
  sits down to work.
- **Reset**: wipe local state (D1 and every Durable Object), then come back up
  installed and seeded, for example after a schema change. Reset is an option
  on the way to a running server, not the point of the command.

And one constraint that shapes the rest: when the agent is done, or even after
the agent has exited, the user wants to see the Shopify CLI as if they had
started it themselves: its log scrolling, its status panel, and `p` to open
the app. The user runs everything in Herdr, with `app:dev` in its own pane.

A first cut, `scripts/dev-reset.ts`, was deleted rather than evolved: this
spec starts from first principles.

## The steps and what each one needs

| step             | what it needs                                                                                                                                 | what it produces                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| stop the server  | the `shopify app dev` process; killing it takes its `vite dev` child with it                                                                  | a free port                             |
| wipe state       | the server stopped first: `d1:reset` deletes `.wrangler`, and a running server keeps the deleted SQLite files open and diverges from new ones | empty D1 and Durable Objects            |
| start the server | the Shopify CLI, not `pnpm dev`: `automatically_update_urls_on_dev` points the app at this session's tunnel, and the admin needs that URL     | a running app and a preview URL         |
| install (`p`)    | a running server and a browser logged into the dev store's admin                                                                              | the `ShopSession` row, as a side effect |
| seed             | the `ShopSession` row (`/api/dev/seed` returns 409 without it)                                                                                | members, teams, workflows, orders       |

`.wrangler` holds both stores: local D1 under `state/v3/d1` and every Durable
Object's SQLite under `state/v3/do`. `d1:reset` removes the whole directory, so
it resets both, despite the name.

## The Shopify CLI with and without a terminal

`shopify app dev` checks whether it has a terminal.

- **With a terminal**: it draws its status panel, takes `p`, `q` and the other
  shortcuts, and stops on Ctrl-C. It owns that terminal until it exits.
- **Without one**: same server, tunnel and URL update, but plain log lines and
  no shortcuts. Verified 2026-09-27: started from an agent's shell with output
  to `logs/app-dev.log`, it came up, served on the port and printed
  `Ready, watching for changes in your app`.

In both forms, `pnpm app:dev` runs `pnpm dev` underneath, and `pnpm dev` pipes
Vite's output through `tee logs/local-worker.log`. So the Worker's log is
always in `logs/local-worker.log`, whichever form runs; only the CLI's own
lines (preview URL, tunnel URL, ready line) live in the pane or in the
background log file.

An agent's shell can only use the second form, because a foreground process
blocks it. That is the conflict: the agent needs to start the server
unattended, and the user wants the first form afterwards.

## Where the server runs

### A. Detached background process

The CLI runs with no terminal, logging to a file, and outlives the command
that started it.

- Works anywhere: in Herdr, outside it, in an agent with no terminal
  multiplexer.
- The user sees the log with `tail -f`, but no status panel and no `p`. The
  preview URL is in the log.
- To get the interactive CLI back, the user stops it and starts it themselves.

### B. A Herdr pane

Herdr exposes its session through the `herdr` CLI to any process running in
one of its panes (`HERDR_ENV=1`). The relevant commands (herdr 0.9.0, all
responses JSON):

- `herdr tab create --label server --cwd "$PWD" --no-focus` creates a tab
  without taking the user's focus; the response carries its root pane ID.
  `herdr pane split --current --direction down --cwd "$PWD" --no-focus` does
  the same for a sibling pane.
- `herdr pane run <pane> "pnpm app:dev"` types the command and Enter into the
  pane's shell. The CLI gets a real terminal: panel, shortcuts, everything.
- `herdr pane wait-output <pane> --match "Ready, watching" --timeout 180000`
  waits for readiness, including output that is already on screen.
- `herdr pane send-keys <pane> p` presses `p`.
- `herdr pane read <pane> --source recent-unwrapped --lines 200` reads the
  screen.
- `herdr pane send-keys <pane> q` or `ctrl+c` stops it.
- `herdr pane process-info --pane <pane>` returns the pane's foreground
  processes with their `argv` and `cwd`. Verified 2026-09-27.

The pane is part of the user's Herdr session, not the agent's process, so it
survives the agent exiting. When the user comes back, the server is in its
pane, running exactly as if they had typed `pnpm app:dev`. Which pane is a
convention, below.

**Finding the server pane again.** `pane list` returns no label field for
unlabelled panes, so a label is not a dependable handle. `process-info` is:
list the panes whose `cwd` is this checkout, and pick the one whose foreground
process is `shopify app dev`. That finds a pane the user started by hand
exactly as it finds one the command started, and a pane whose CLI exited
simply stops matching.

Limits:

- Only works when the command runs inside Herdr. Outside it the command falls
  back to A.
- The pane's shell must be at a prompt for `pane run`. A pane where the CLI is
  hung needs `ctrl+c` first, or a new pane.
- Whether the ready line appears verbatim in the TTY form, where the CLI draws
  with Ink, is unverified. If `wait-output` does not match it, readiness falls
  back to the port listening plus an HTTP answer.

### Herdr layout and worktrees

Checked 2026-09-27 against herdr 0.9.0 and this session:

- The hierarchy is workspace, tab, pane. This repo is one workspace (`w1`,
  label `baton`) with four tabs of two panes each.
- `tab list` returns each tab's `label` (today `1` to `4`, the defaults), and
  `tab create --label` and `tab rename` set it. `pane list` returns no pane
  label. So a tab label is a dependable handle and a pane label is not.
- `tab create` has no position option: a tab the command creates is appended
  at the end. The command can find a tab by label, but it cannot put one
  first; only you can keep it there.
- `herdr worktree create` / `open` open a git worktree as its own workspace,
  linked to the primary one (`workspace close --group` closes the primary and
  its linked worktree workspaces). So each worktree has its own tabs, and a
  per-workspace convention carries over to worktrees unchanged.

What worktrees mean for the dev server, beyond Herdr:

- `.wrangler` lives in the checkout, so each worktree already has its own
  local D1 and Durable Objects.
- `.env` is untracked, so each worktree needs its own copy, with its own
  `PORT`.
- The Shopify CLI is the real limit, and a different dev store does not lift
  it. The app URL and redirect URLs belong to the app, not to a store:
  `automatically_update_urls_on_dev` rewrites them on the app itself
  (`refs/shopify-docs/docs/apps/build/cli-for-apps/app-configuration.md`,
  the `[build]` reference). So two worktrees running `shopify app dev` for
  Baton Local at once would each point the app at their own tunnel, and the
  last one to start wins every store. Shopify's forum describes the same
  collision for teams sharing one dev app
  (https://community.shopify.com/c/shopify-apps/unable-to-use-same-development-environment-for-multiple/td-p/2403617).
  `--tunnel-url` and `--use-localhost`
  (`refs/shopify-docs/docs/apps/build/cli-for-apps/networking-options.md`)
  change which URL is written, not that there is only one; localhost also
  rules out webhooks, which Baton depends on. The documented way to serve two
  at once is one Shopify app per concurrent environment, linked with
  `shopify app config link` into its own `shopify.app.<name>.toml`
  (`manage-app-config-files.md`). The alternative is one worktree serving at
  a time.

Worktrees are deferred. The design only has to leave room for them: the
command finds servers by process and cwd, keeps state per checkout (`.env`,
`.wrangler`, `logs/`), and passes the app config as a parameter
(`--config shopify.app.toml` today) rather than assuming it.

Conventions for where the server runs:

1. **None.** The command finds the server by process wherever it is, and
   starts a new one as a split beside the agent. Nothing to learn, but you
   hunt for it, and it moves each time.
2. **A tab labelled `server` in each workspace.** The command finds a running
   server by process first. If none runs, it uses the `server` tab's pane
   when that pane is at a prompt, and creates the tab (labelled, unfocused,
   appended) when there is none. You keep it first by moving it once; the
   command depends on the label, never the position.
3. **Tab 1, left pane, by position.** Easy to remember, but the command would
   type into whatever occupies that pane. Today that is your opencode pane,
   and any layout change silently retargets it.

Decided: 2. It gives you one place to look in every workspace, including
future worktree workspaces, and the command never types into a pane it did
not identify by label or process.

### Choosing the pane

A tab is not a precise enough target: the `server` tab can hold several
panes, and one of them may already be running the server. The command
resolves a pane in this order and stops at the first match:

1. **A pane already running the server.** Any pane in the workspace whose
   foreground process is `shopify app dev` with this checkout as its cwd, in
   whatever tab. `pane process-info` reports it directly, so this is how the
   command finds an existing server pane without a label. Adopted.
2. **You typed the command** (stdin is a TTY) **and there is no `server`
   tab**: your tab becomes the `server` tab (`tab rename`), and the server
   runs in the pane you typed in (foreground, mode C). Typing it by hand
   means "here".
3. **You typed the command in the `server` tab**: it runs in your pane,
   foreground.
4. **Otherwise** (an agent, or you typing in another tab while a `server`
   tab exists): an idle pane in the `server` tab. Idle means the shell
   itself is the foreground process: `process-info` returns
   `foreground_process_group_id` equal to `shell_pid`, as it did for every
   idle pane in this session. With several idle panes, the first in layout
   order (`pane layout`). With none, the command splits the tab (unfocused)
   and uses the new pane. It never types into a busy pane.
5. **No `server` tab and no TTY** (an agent): the command creates the tab,
   labelled `server`, unfocused. It does not rename the agent's own tab: the
   agent's pane is busy, and that tab is where you talk to the agent.

The summary names the pane it used, so an agent can `pane read` it later.

### C. Foreground in the caller's terminal

When a person runs the command in a terminal (stdin is a TTY), the command
does its preparation (stop, optional wipe) and then hands the terminal to
`shopify app dev` with inherited stdio. The person gets the real CLI in the
terminal they are already in, with no Herdr involvement. Anything that must
happen after the server is up (waiting for the install, seeding) runs
alongside in the same process, and its few lines interleave with the CLI's
panel.

### Selection

Automatic, and the `--help` text states these rules:

1. A `shopify app dev` already serving this checkout (in a pane, or in the
   background) is adopted: `start` leaves it running, `stop` and `reset` stop
   it, whoever started it.
2. Otherwise, inside Herdr (`HERDR_ENV=1`), whether a person or an agent ran
   the command: a pane in the tab labelled `server`, chosen as in "Choosing
   the pane". The server is always in one place.
3. Otherwise, foreground (C) when stdin is a TTY: a person typed the command
   outside Herdr.
4. Otherwise, background (A).

The command's summary says which it used and how to reach the server (pane
ID, or log path).

## The install step

### What `p` does, and why it is the whole install

The CLI prints a preview URL when it starts (from `logs/app-dev.log` on
2026-09-27):

`https://admin.shopify.com/store/sandbox-shop-01/apps/7c6cceb7f8f9991a543d43648b08e72d?dev-console=show`

`p` opens that URL in the default browser. The admin loads the embedded app,
the app receives a session token, and `exchangeAndStore`
(`src/lib/Shopify.ts`) trades it for an offline token and writes the
`ShopSession` row. So `p` needs no row beforehand; it creates it. That is why
`p` after a wipe works.

The earlier draft said "install needs a `ShopSession` row", which read as a
precondition. It is the result. The draft also proposed saving the row before
the wipe and inserting it back afterwards to skip the browser; that is
dropped. It writes into the database behind the app's back and breaks when the
schema changes, and `p` already works.

### Who presses `p`

Nothing is wrong with `p`. The question is only how the command triggers it
when nobody is at the keyboard. Decided: the command runs
`open <preview URL>` itself, in every mode, including your own terminal, so
`reset` finishes unattended. `open` is exactly what `p` does.

The URL is built rather than read from the CLI's output, because in mode C
the CLI owns the terminal and the command cannot read its output:
`https://admin.shopify.com/store/<store>/apps/<client_id>`, with `<store>`
from the `--store` the command passes to `shopify app dev` and `<client_id>`
from `shopify.app.toml`. No Playwright, no cookie export, no Keychain prompt.

The cost: a tab opens in your default browser on every install, including
when an agent runs `reset` while you are away, and the install fails (after a
timeout, with a message saying to log in) if that browser is not logged into
the dev store's admin.

### Why not a headless browser

Building the URL is the easy part. The hard part is that the page behind it
only loads for someone logged into the Shopify admin, and that login lives in
your Chrome profile. A headless Chromium starts with an empty profile, so it
lands on the Shopify login page and no token exchange happens. It has to be
given a login from somewhere:

- **Copy Chrome's cookies in.** What `refreshShopifyAuth`
  (`scripts/lib/shopify-playwright-auth.ts`) does for the e2e `setup`
  project: decrypt Chrome's cookie database through the macOS Keychain (a
  prompt), and trust the export for a day. This is the fragile part the e2e
  setup already carries.
- **A dedicated Playwright profile, logged in once.** Launch Chromium with a
  persistent profile directory, log into the admin in it once by hand
  (headed), then reuse it headless. No Keychain. Unverified: how long Shopify
  keeps that profile logged in, and whether its login flow (two-step
  verification, bot checks) tolerates an automated browser.

Either can be added later behind the same install step if the tab becomes a
nuisance. `open` needs neither.

### How the command knows the install is done

It checks for the dev shop's `ShopSession` row in local D1, not whether a
browser loaded something, with
`wrangler d1 execute <database> --local --json --command "select 1 from ShopSession where shop = ?"`
(the database name read from `wrangler.jsonc`, as `scripts/d1-reset.ts`
does). Verified 2026-09-27 with the dev server running: it took 2.4 seconds
and returned the row the running server had written, so it reads the same
files the server uses. The command only reads, so it cannot conflict with the
server's writes. `start` skips the install when the row is already there, and
`status` uses the same check. `/api/dev/seed` is the wrong probe: it answers
409 without the row, but when the row exists it seeds.

## Package scripts and the new CLI

The package scripts are the entry points people and agents already know. They
stay, and each keeps doing one thing. The new CLI composes the same code as
functions, not by shelling out to `pnpm`.

| script                                                         | today                         | after                                                      |
| -------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `app:dev`                                                      | `shopify app dev`             | unchanged: the CLI runs it, a person can still run it bare |
| `dev`                                                          | `vite dev`, used by `app:dev` | unchanged                                                  |
| `d1:reset`                                                     | Effect CLI, local and remote  | thin wrapper over a shared `resetLocal` in `scripts/lib`   |
| `seed`                                                         | plain Node `fetch`            | thin wrapper over a shared Effect `seed` in `scripts/lib`  |
| `dev:start`, `dev:stop`, `dev:status`, `dev:reset`, `dev:logs` | none                          | `scripts/dev.ts start`, `stop`, `status`, `reset`, `logs`  |

`d1:reset --env staging|production` stays in `scripts/d1-reset.ts`: remote
resets have nothing to do with the dev server. Only its local branch moves to
`scripts/lib` so `dev.ts` can call it.

## Command shape

One Effect CLI, `scripts/dev.ts`, with subcommands.

| subcommand | does                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`   | reports: mode and handle (pane or pid), port listening, HTTP answering, tunnel reachable, `ShopSession` present. Read-only; exit code = health |
| `start`    | idempotent: adopt a running server or start one; install if `ShopSession` is missing; never wipes; `--seed` seeds                              |
| `stop`     | stops the server in whichever mode it runs                                                                                                     |
| `reset`    | `stop`, wipe `.wrangler` and migrate, `start`, install, seed. `--no-seed` skips the seed                                                       |
| `logs`     | prints the recent CLI output from the pane or the background log, and the tail of the Worker log                                               |

`start` is the one an agent reaches for when an e2e run fails to connect.
`reset` is the one after a schema change. Seeding never happens implicitly on
`start`: it overwrites hand-made data.

Health for `start` is local: port listening and an HTTP answer. `status` also
requests the tunnel URL, because the tunnel can die while the port stays up;
when it reports that, `stop` then `start` fixes it.

Found while testing the implementation (2026-09-27):

- **The tunnel URL comes from the server's environment, not the CLI's
  output.** `shopify app dev` passes it to `pnpm dev` as `APP_URL`, which
  `ps -E` reads from the process listening on the port. In a terminal the
  CLI's status panel redraws over the line that printed the URL, so reading
  the pane found it once and then lost it.
- **Only Cloudflare's 530 proves a tunnel dead.** For about a minute after a
  start the macOS resolver held a cached "not found" for the new hostname
  while `dig` already resolved it. `status` reports that as "no answer yet"
  and does not count it as unhealthy.
- **SIGTERM to the CLI leaves `vite dev` holding the port.** Outside a pane,
  `stop` signals the CLI and the port's listener together; in a pane it
  presses Ctrl-C, which reaches the whole foreground group and takes 0.3 to
  1 seconds.
- **The foreground CLI must not be detached.** The Effect spawner detaches
  by default off Windows, which would put the CLI in its own process group,
  outside the terminal's foreground group, where reading keys stops it.
  Foreground spawns pass `detached: false`.

Measured: `reset` inside Herdr took 24 seconds end to end (stop 0.9s, wipe
2.5s, server answering 13s, install through the browser 5s, seed 1s).

Two agents can run `start` at once (parallel sessions in one checkout). A lock
file under `logs/` held for the duration of `start`, `stop` and `reset` keeps
them from starting two servers.

## Logs

Decided: rename the log files in this work. They grew one at a time and
their names do not say what they hold:

| file today                                 | written by                              | holds                         |
| ------------------------------------------ | --------------------------------------- | ----------------------------- |
| `server.log`                               | `pnpm dev` (`tee`)                      | local Vite and Worker output  |
| `app-dev.log`                              | the old `dev-reset.ts`, background mode | local Shopify CLI output      |
| `tail.log`, `tail-compact.log`             | `pnpm tail`                             | the top-level deployed Worker |
| `staging.log`, `staging-compact.log`       | `pnpm tail:staging`                     | the staging Worker            |
| `production.log`, `production-compact.log` | `pnpm tail:PRODUCTION`                  | the production Worker         |

The new names follow one pattern, `<environment>-<source>[.compact].log`,
which sorts by environment and says what each file holds:

| new                                                      | replaces                       |
| -------------------------------------------------------- | ------------------------------ |
| `local-worker.log`                                       | `server.log`                   |
| `local-cli.log`                                          | `app-dev.log`                  |
| `default-worker.log`, `default-worker.compact.log`       | `tail.log`, `tail-compact.log` |
| `staging-worker.log`, `staging-worker.compact.log`       | `staging*.log`                 |
| `production-worker.log`, `production-worker.compact.log` | `production*.log`              |

`default` is wrangler's name for the top-level environment (no `--env`). The
rename touches `package.json`, the Server Log Monitoring section of
`AGENTS.md`, and `dev.ts`. One-off files such as `refs-fetch*.log` are not
written by any script and are out of scope.

## Effect implementation notes

- CLI: `effect/unstable/cli` (`Command.make`, `Flag`,
  `Command.withSubcommands`, `Command.run`, `NodeRuntime.runMain`), as
  `scripts/d1-reset.ts`, `refs.ts` and `spec.ts` already do. Reference:
  `refs/effect/ai-docs/src/70_cli/10_basics.ts`. The mode rules go in
  `Command.withDescription` so `--help` prints them.
- Processes: `ChildProcessSpawner` from `effect/unstable/process`
  (`refs/effect/ai-docs/src/60_child-process`). A spawn is scoped and killed
  when its scope closes, unless `handle.unref` ran first: the finalizer
  skips the kill for an unreferenced process. `detached` defaults to `true`
  off Windows (`ChildProcess.ts`, `detached` option). A child's stdout can be
  `pipe`, `inherit`, `ignore`, `overlapped` or a `Sink`, not a file, so the
  background mode spawns `sh -c 'exec pnpm app:dev > logs/<cli log> 2>&1'`
  with stdin ignored. Foreground mode spawns with `inherit` on all three and
  waits for the exit code.
- Herdr: a small service over the `herdr` CLI, with a schema per response it
  reads (`tab list`, `tab create`, `pane list`, `pane process-info`). Behind a
  `ServerHost` service with Herdr, background and foreground
  implementations.
- Errors: one tagged error per step (`StopFailed`, `ResetFailed`,
  `StartTimedOut`, `InstallTimedOut`, `SeedFailed`), each carrying the output
  worth showing.
- Existing pieces to fold in: the local branch of `scripts/d1-reset.ts` and
  `scripts/seed.ts`.

## Output

- One line per step with elapsed time; child output hidden unless the step
  fails, then the failing step's output or the last lines of the log.
- A final summary: mode, where the server is (pane ID or log path), local URL,
  shop, installed or already installed, seeded or not.
- `--json` on `status` for agents.

## Decisions

Answered 2026-09-27:

1. Mode selection is automatic (see Selection), and `--help` explains the
   rules.
2. A person running the command in a terminal outside Herdr gets the real
   CLI in that terminal (mode C). Inside Herdr it goes to the `server` tab
   (decision 14).
3. A server someone started by hand is adopted by `start` and stopped by
   `stop` and `reset`.
4. Seeding: `reset` seeds by default (`--no-seed` skips); `start` seeds only
   with `--seed`.
5. `reset` always wipes everything; no partial resets.
6. `start` checks local health only; `status` also checks the tunnel.
7. Output: step lines with timings, child output only on failure, `--json` on
   `status`.
8. `scripts/dev-reset.ts`, `dev:reset` and `dev:stop` are deleted now, before
   `dev.ts` exists.
9. No saving and restoring of `ShopSession` across a wipe.
10. Install: the command runs `open <preview URL>` in every mode, including
    your own terminal. No headless browser for now.
11. Log files take the `<environment>-<source>[.compact].log` names, renamed
    in this work.
12. The install check reads local D1 with `wrangler d1 execute --local`; no
    new endpoint.
13. Herdr convention: one tab labelled `server` per workspace. The command
    finds it by label and creates it, labelled, when it is missing.
14. Inside Herdr the server always runs in the `server` tab, including when
    you type `pnpm dev:start` yourself in another pane.
15. Worktrees are deferred. The design keeps state per checkout and finds
    servers by process and cwd so that nothing blocks them later.
16. Typing the command in a Herdr pane when no `server` tab exists makes that
    tab the `server` tab and runs the server in the caller's pane.
17. Typing the command in another tab while a `server` tab exists sends the
    server to the `server` tab and prints which pane.

No open questions remain.

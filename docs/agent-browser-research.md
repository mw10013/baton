# Agent browser: research

Status: implemented, 2026-10-23. §7 is answered, §8 records the spikes, and §10 records the build. The machine-level runbook is in Notes (§9). This covers how an agent drives and inspects Baton in a browser while nobody is at the laptop. Sources:

- `chrome-devtools-mcp` 1.12.0: its `--help`, the README, `docs/cli.md` on GitHub, the bundled `skills/chrome-devtools-cli` skill, and `build/src/daemon/utils.js` and `build/src/bin/chrome-devtools.js`, all read from the published package.
- This repo's `.mcp.json`, `scripts/browser.ts`, `scripts/lib/shopify-admin-auth.ts`, `src/backend/shop-access.ts`, and the shopify-stores and playwright-cli runbooks.
- A Notes research file on the same problem, written from memory and since replaced by the runbook (§9). §1 checks its claims.

## 0. Verdict

Give agents their own Chrome, logged in to Shopify once by hand, and drive it with the `chrome-devtools` CLI:

- **A Chrome only agents use.** It has its own profile and a debugging port (9333, because your own Chrome already listens on 9222 for `--autoConnect`), and it stays running. Chrome shows no permission dialog for it, because the profile holds nothing of yours.
- **One human step: the Shopify login.** Do it once, in that window. The profile keeps it, and the admin renews its own session the way your Chrome does.
- **The `chrome-devtools` CLI first.** It ships in the same npm package as the MCP and has the same tools. Agents run it through Bash, and scripts and skills can call it too. It attaches to the agent Chrome with `--browserUrl`.
- **Keep the current MCP.** `.mcp.json` keeps `chrome-devtools` with `--autoConnect`, for when you want an agent working in your own Chrome. A second MCP server for the agent Chrome is the fallback if the CLI falls short (§5).
- **Fail fast when the login lapses.** A check before browser work confirms the agent Chrome is up and the admin loads without the sign-in page. Otherwise the agent stops and tells you.

The dev server doesn't change. Each checkout runs one, and any number of browsers use it.

## 1. The problem

`.mcp.json` runs `chrome-devtools-mcp --autoConnect`. That attaches to your running Chrome, which shows an "Allow remote debugging?" dialog the first time each MCP server process connects. Until someone clicks Allow, every tool call times out. Away from the laptop, nobody clicks, and the agent is stuck.

The dialog guards your everyday profile: your email, bank and every other login. An agent working unattended shouldn't be in that profile. So the fix is to stop needing it, not to get past the dialog.

The Notes research reaches the same direction. Its flags check out against 1.12.0: `--browserUrl`, `--userDataDir`, `--isolated` and `--headless` all exist, and `--autoConnect` needs Chrome 144+.

## 2. Options considered

| Option                                                                      | Dialog?                 | Login                   | Verdict                                                     |
| --------------------------------------------------------------------------- | ----------------------- | ----------------------- | ----------------------------------------------------------- |
| `--autoConnect` to your Chrome (today)                                      | Yes, per MCP process    | Yours                   | Keep for attended work only                                 |
| MCP launches its own Chrome, `--isolated`                                   | No                      | None, every run         | No login, so no admin                                       |
| MCP launches its own Chrome, `--userDataDir`                                | No                      | Kept in the profile     | One process per profile at a time, so agents can't share it |
| **Agent Chrome on a debugging port, everyone attaches with `--browserUrl`** | **No**                  | **Kept in the profile** | **Recommended**                                             |
| Copy cookies from your Chrome (`e2e:auth`)                                  | Keychain asks for Allow | Copied, doesn't renew   | Fallback only                                               |
| Screen sharing to click Allow from a phone                                  | Yes                     | Yours                   | Still needs a person each time                              |

**Why not copy cookies.** `scripts/lib/shopify-admin-auth.ts` reads Chrome's cookie store, which is encrypted with a key in the macOS Keychain. Reading it shows its own Allow dialog, about once a day per the shopify-stores runbook. The copied session also doesn't renew itself, which is why it goes stale. It moves your credentials out of the profile the dialog protects. It stays useful for one thing: re-seeding the agent Chrome if its login ever lapses.

## 3. How Baton signs people in, and what a second browser means

From `src/backend/shop-access.ts` and the shopify-stores runbook:

- **Embedded app (inside the Shopify admin):** each tab gets its own short-lived Shopify session token. No cookie. The shop's actor gives each tab its own socket.
- **Member pages (outside the admin, on `localhost:<port>`):** a Better Auth cookie, under Better Auth's default name.
- **Per checkout:** its own dev server, dev store (`mw10013-dev-shop-NN`) and tunnel.

| Case                                                                          | Works?  | Why                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You in your Chrome + an agent in the agent Chrome, same shop, same dev server | Yes     | Separate browsers are separate Shopify sign-ins. Each tab has its own session token.                                                                     |
| Two agents in the admin, same shop                                            | Yes     | Each tab has its own session token.                                                                                                                      |
| Agents on different checkouts, in the admin                                   | Yes     | Different store, tunnel and server. One Shopify login covers every store in the account.                                                                 |
| An agent signed in as a member while you are                                  | Yes     | Different browsers, different cookies.                                                                                                                   |
| Two agents signed in as members in the agent Chrome                           | Clashes | Cookies ignore the port, so every `localhost` member page in one browser shares one cookie. The second sign-in replaces the first, across checkouts too. |

The fix for the last row: an agent opens member pages with `new_page --isolatedContext <name>`, which gives that tab its own cookies. Admin pages stay in the default, logged-in context.

What a browser can't separate:

- **Shop data is shared.** You and an agent see the same orders, workflows and members, and an agent's changes show on your screen through live reads.
- **`vp run fixture` and `vp run db:reset` replace the shop's data for everyone.** Agents run them only when asked. `db:reset` also opens the admin URL in your default browser, which is your Chrome.
- **Full admin URLs.** Agents navigate to `admin.shopify.com/store/<store>/…`, never relying on the admin's remembered store.

## 4. The agent Chrome

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.chrome-agent" \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows
```

- **Own `--user-data-dir`.** Chrome refuses a debugging port on the everyday profile. A separate directory is also what keeps your logins out.
- **Throttling flags.** Agents mostly work in background tabs. Without these, Chrome slows timers and rendering in them.
- **Headed.** You log in through its window and can watch it. Headless can't do the Shopify login.
- **Shared by every checkout.** One profile outside the repo, so one Shopify login covers main and every worktree.
- **Started by a script.** `vp run browser agent` starts it with `open -gna` if port 9333 isn't answering, and does nothing otherwise.
- **The port** is open to any process on this Mac. Acceptable on a personal laptop.

## 5. CLI or MCP

Both run the same tools. The choice comes down to everything around them.

**For the CLI:**

- **Its shape matches the agent Chrome.** A background server started once and shared. An MCP server lives and dies with one agent session, which is why `--autoConnect` re-prompts after a restart.
- **Any agent can use it.** Claude Code, Codex, other threads and worktrees, with no client setup.
- **Scripts and skills can call it.** The login check and the admin's iframe steps can run the same way every time. An MCP tool can only be called by a model.
- **Output size is under control.** A large snapshot can go to a file and be searched instead of landing whole in context.
- **It matches the repo.** The Playwright CLI is used the same way.

**For the MCP:**

- **Screenshots.** The MCP returns the image to the agent. The CLI writes a file the agent then reads.
- **Maturity.** The MCP is the main, well-tested way in. The CLI is newer.

Decision: CLI first. If it falls short (§7), add a second MCP server for the agent Chrome beside the current one:

```json
"chrome-devtools-agent": {
  "command": "vpx",
  "args": ["chrome-devtools-mcp@latest", "--browserUrl=http://127.0.0.1:9333", "--redactNetworkHeaders", "--usageStatistics=false", "--performanceCrux=false"]
}
```

## 6. The `chrome-devtools` CLI

**Packaging.** The npm package `chrome-devtools-mcp` holds two commands: `chrome-devtools-mcp` (the MCP server) and `chrome-devtools` (the CLI). Neither is installed on this Mac today. `.mcp.json` runs the MCP through `vpx`, which downloads the package and runs it without putting a command on the PATH.

**Install it globally with Vite+**, the way `cf`, `shopify` and `codex` are already installed here:

```sh
vp install -g --node lts chrome-devtools-mcp@latest
chrome-devtools status
```

- It puts `chrome-devtools` and `chrome-devtools-mcp` in `~/.local/share/vite-plus/bin`, which is already on the PATH. Every project, worktree and agent gets the same command, with nothing added to any project.
- `--node lts` saves the latest Node LTS for this tool. The package needs Node `^20.19 || ^22.12 || >=23`.
- Upgrade by running the same command again. `vp list -g` shows the installed version.
- The upstream docs say `npm i -g`. Vite+ keeps its global packages apart from npm's, and AGENTS.md rules out npm.
- Not chosen: a dev dependency, which every project would have to carry, and `vpx` for every call, which re-resolves `@latest` and puts no command on the PATH.
- The bundled skill ships inside the installed package, so it matches the installed version: `~/.local/share/vite-plus/packages/chrome-devtools-mcp/<install id>/lib/node_modules/chrome-devtools-mcp/skills/chrome-devtools-cli/SKILL.md`. The install id changes on every reinstall.

**Installed 2026-10-23:** `chrome-devtools-mcp` 1.12.0 on Node 24.22.1. A smoke test passed in a throwaway headless Chrome: `start --sessionId=ab --headless --isolated`, then `new_page`, `list_pages`, `take_snapshot`, `take_screenshot --filePath`, `stop`. `status` without the session id reported no server, which confirms `--sessionId` keeps servers apart. Usage statistics are on by default, so `start` needs `--no-usage-statistics`, as `.mcp.json` already turns them off.

**How it runs** (`docs/cli.md`, `daemon/utils.js`):

- The CLI talks to a background `chrome-devtools-mcp` over a Unix socket at `/tmp/chrome-devtools-mcp-<uid>/server.sock`. One per user by default.
- `--sessionId <hex>` runs a separate background server with its own socket.
- The first tool call starts the background server if none is running.
- `start` restarts it: it stops a running one first.
- `start` forwards MCP flags, `--browserUrl` and `--userDataDir` among them. Headless and isolated are its defaults when no browser flag is given.
- Every page tool takes a `pageId` first, so agents can keep to their own tabs.
- Output is Markdown-like text, or JSON with `--output-format=json`.
- File-writing tools may write anywhere unless `start --workspace=<dir>` limits them.
- `wait_for` and `fill_form` aren't in the CLI.

**Pitfalls this sets up:**

- **A plain tool call can start the wrong browser.** If no background server is running, the first call launches a throwaway headless Chrome instead of attaching to the agent Chrome. The setup script must start it with `--browserUrl` first, and the skill must say to run that script, not `start`.
- **One agent's `start` restarts everyone's.** On the shared default socket, `start` kills the server other agents are using. Agents never run `start` themselves.
- **No `wait_for`.** After navigation, waiting is up to the caller. `vp run browser open` already has Baton's hydration wait, which a script can reuse.

**Bundled skill.** `skills/chrome-devtools-cli/SKILL.md` teaches the commands for that exact version. Its upstream advice ("do not run start/status/stop before each use") assumes one user and the default launch, so Baton needs its own short note on the agent Chrome and the setup script.

## 7. Questions, answered 2026-10-23

**Q1. How is the CLI installed?**
Answer: `vp install -g --node lts chrome-devtools-mcp@latest` (§6). It's a machine tool, not a project dependency, and it matches how `cf` and `shopify` are installed. Done 2026-10-23. Whether `.mcp.json` should then call the installed `chrome-devtools-mcp` instead of `vpx …@latest` is a separate, later choice.

**Q2. One background server for everyone, or one per checkout?**
Answer: one per checkout, with a refinement: other projects and their worktrees use the CLI too, so the worktree index isn't unique. The session id is the checkout's `WEBSITE_PORT`, which is unique across checkouts and, by convention, across projects. Digits are valid hex. For the same reason the agent Chrome is machine-wide (`~/.chrome-agent`), not Baton's.

**Q3. What is the command called, and what does it do?**
Answer: `vp run browser agent`, a subcommand beside `open`, `ready` and `close`. It starts the agent Chrome if port 9333 is silent, checks the Shopify login (Q5), and starts this checkout's background server with `--browserUrl` if it isn't running or Chrome was just started. Running it again is harmless.

**Q4. Where does the agent's guide live?**
Answer: the verify-baton skill, in its sections on the agent Chrome and on inspecting with the chrome-devtools CLI. It points to the bundled skill for commands instead of copying it.

**Q5. What does the login check look at, and how does it tell you?**
Answer: as recommended. The command opens the dev store's admin in a new tab and fails with "not logged in to Shopify" when it lands on accounts.shopify.com. The skill tells the agent to stop and send a push notification with its own tool. The script sends nothing.

**Q6. Should `vp run browser open` (Playwright) attach to the agent Chrome too?**
Answer: yes. Tested first: `playwright cli attach --cdp=http://127.0.0.1:9333` saw the logged-in admin and the app frame, and `detach` left Chrome running. `open` now attaches in a new tab of its own, and `close` closes only that tab and detaches. verify-baton keeps its Playwright harness and no longer needs the Keychain export. The e2e suite still uses the export.

## 8. Spikes

S1–S3 ran 2026-10-23 against main's dev server and `mw10013-dev-shop-00`. All passed.

- **S1. Agent Chrome and login: passed.** Launched with `open -na "Google Chrome" --args --user-data-dir=$HOME/.chrome-baton-agent --remote-debugging-port=9333 …` plus the §4 flags. The profile moved to `~/.chrome-agent` afterwards, and the login moved with it. `open -na` starts a second Chrome process beside yours. Port 9333 answered at once, with no dialog. The user logged in to Shopify once in that window. Not yet confirmed: that your own Chrome stayed signed in.
- **S2. CLI attach: passed.** `start --sessionId=00 --browserUrl=http://127.0.0.1:9333 --no-usage-statistics` attached with no dialog. On the embedded app:
  - `take_snapshot` reaches inside the app's cross-origin iframe. The frame's content appears under an `Iframe "Baton Dev"` node with its own uids.
  - `click` on a uid inside the frame worked: the "Making" card opened Orders filtered to Making.
  - `fill` on the frame's search box worked: the list narrowed to #1242.
  - `take_screenshot` and `list_console_messages` worked.
  - Uids change with each snapshot. Take a fresh one before acting on a page that changed.
  - Snapshots repeat the frame's full URL, `id_token` included, on every link, about 37 KB for Orders. Write them with `--filePath` and search the file.
- **S3. Two background servers: passed.** `--sessionId=00` and `--sessionId=01` attached to the one Chrome at the same time, with separate sockets (`/tmp/chrome-devtools-mcp-00-501/`, `-01-501/`). Each opened a background tab (`new_page --background true`) in parallel, then took a snapshot and a screenshot of it. Both background tabs rendered in full. Both servers list every tab in the browser with the same page numbers. Not covered: two checkouts on different stores, since only main's dev server was running.
- **S4. Session lifetime: not run.** Watch whether the agent Chrome's Shopify login holds over the next days.

## 9. The Notes runbook

Written 2026-10-23: `../notes/systems/chrome-devtools-cli-runbook.md`. It holds the machine-level part, which isn't Baton's: the global install, upgrade and uninstall, where the bundled skill lives, how the background server behaves, the agent Chrome (launch, login, safe quit, moving the profile), and recovery. A runbook, not research, because research files get deleted once settled. The two Notes research files it replaces were removed. Baton-specific use stays in this repo.

## 10. As built, 2026-10-23

- `scripts/browser.ts`: new `agent` subcommand. `open` attaches to the agent Chrome in its own tab instead of launching Playwright's Chrome with the Keychain export, and lost its `--headed` flag. `close` closes that tab and detaches.
- The login check waits for a page that decides it: the admin's own title (`<store> · Home · Shopify`) or accounts.shopify.com. A first version that stopped at the first non-empty title passed a logged-out Chrome: Chrome titles a loading tab with its URL, and a lapsed login passes through `admin.shopify.com/login` first. Tested both ways, the logged-out case against a throwaway Chrome with an empty profile.
- verify-baton (`SKILL.md`, `verify.sh`), the Playwright CLI runbook and AGENTS.md now describe the agent Chrome. `V doctor` runs `vp run browser agent` instead of checking the export file.
- Not changed: the e2e suite and `vp run e2e:auth`, which keep the Keychain export, and `.mcp.json`.

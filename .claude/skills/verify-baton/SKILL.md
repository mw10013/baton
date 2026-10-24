---
name: verify-baton
description: Drive Baton's embedded Shopify admin app in this checkout's dev store the way a merchant does, and file proof (screenshots, ARIA snapshots, console, an action log). Use to prove a UI change works in the real app, to reproduce a bug a merchant would see, or when asked to verify or check Baton in a browser. Not the e2e suite; this drives the dev server and dev store by hand.
---

# Verify Baton

Baton runs inside the Shopify admin: the admin's own page holds the App nav and the hoisted title bar, and the app is an iframe in it. Every drive goes through this checkout's dev server (`vp run dev`), its dev store (`SHOPIFY_DEV_STORE` in `.env`) and the Playwright CLI session `dev`, attached to the agent Chrome. The helper is `.claude/skills/verify-baton/verify.sh`; run it from the checkout root. Below, `V` means that path.

The recipe for each feature is in [features/README.md](features/README.md). Read it before driving.

## The agent Chrome

Runs drive the agent Chrome: one Chrome per machine, with its own profile (`~/.chrome-agent`) on port 9333, logged in to Shopify once by a person. It is not the user's own Chrome, so it never shows a permission dialog and works with nobody at the laptop. `vp run browser agent` starts it if needed, checks the Shopify login, and attaches this checkout's chrome-devtools server. `V start` and `V doctor` run it.

- Every project and checkout on the machine shares it. Open your own tab and touch only that one. `vp run browser open` opens one for the `dev` session, and `vp run browser close` closes only that tab.
- Always use full admin URLs (`admin.shopify.com/store/<store>/…`), never the admin's remembered store.
- **Login lapsed** (`not logged in to Shopify`): stop the run, and send the user a push notification saying a person must log in to Shopify in the agent Chrome. Never sign in yourself.

## Isolation

- One run per checkout at a time. The dev server, the dev store and the `dev` browser session belong to the checkout, and a second driver would share them. `V start` refuses while another run is open.
- A worktree (`wt-NN`) has its own server, port and store, so runs in different checkouts are independent.
- The dev server is usually the user's own, running in their herdr tab. `V start` adopts it and `V stop` leaves it running. It stops only a server this run started.
- The dev store's data is the user's working data. Create things under names of your own (`Verify <run-id> …`) and delete them before stopping. Never run `vp run db:reset` or `vp run fixture` without the user's OK: both rewrite the store.

## Launch

```bash
.claude/skills/verify-baton/verify.sh start <run-id>
```

Pick a short run id such as `teams-rename-1`. `start` records whether the dev server was already up, runs `vp run dev` (starts it or adopts the running one), then `vp run browser open`. That runs `vp run browser agent`, attaches the `dev` session to the agent Chrome in a new tab, opens the app in the dev store, waits for the iframe's `body[data-hydrated]` and collapses the Shopify CLI's Dev Console. It is ready when it prints `Run open: .logs/verify/<run-id>`.

A cold load through the tunnel hydrates in about 3 s. If `open` fails, check the doctor output, then `vp run dev:logs`.

From an empty database, run `vp run db:reset` before starting, and only with the user's OK. It recreates, migrates and seeds the database, opens the app once (which installs it and writes the shop session), and applies the dev fixture.

## Doctor

```bash
.claude/skills/verify-baton/verify.sh doctor
```

Exits 1 unless all of these hold: `healthy: yes`, the port is listening and answering, the tunnel shows `(ready)`, and `vp run browser agent` succeeds. That may start the agent Chrome; it changes nothing else. It also shows whether the `dev` browser is open and whether a run is open. Run it first, and again whenever a drive looks wrong.

- Not healthy: `vp run dev`, or read `.logs/dev/current`.
- A drive lands on a Shopify login page: the agent Chrome's login lapsed. See [The agent Chrome](#the-agent-chrome).

## Drive

Target elements by role and accessible name. Never use snapshot refs (`e12`, `f1e14`) in a recipe, because they change on every snapshot. Polaris renders inside shadow DOM, so `getByRole` and ARIA snapshots find what text matching misses.

| Command                                                             | Where it acts                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `V goto app/teams`                                                  | Loads an app path inside the admin and waits for hydration. Paths: `app`, `app/orders`, `app/workflows`, `app/teams`, `app/members`. |
| `V in click "getByRole('button', { name: 'Create', exact: true })"` | Inside the app's iframe. `in fill <locator> <text>`, `in select <locator> <value>` and `in check <locator>` take the same shape.     |
| `V top press Enter`                                                 | Sends a key to whatever has focus, in the frame or not.                                                                              |
| `V top click "getByRole('link', { name: 'Teams', exact: true })"`   | The admin's own page: the App nav, toasts, the hoisted title bar.                                                                    |
| `V app '<body>'`                                                    | Runs Playwright code with `page` and `frame` (the app's `FrameLocator`) in scope. Return a value to read state back.                 |
| `V note <text>`                                                     | Adds a line to the run's log.                                                                                                        |
| `vp run browser ready`                                              | Re-runs the hydration and Dev Console checks after a navigation the app did itself.                                                  |

Assert with `V app`, which returns JSON:

```bash
V app 'await frame.locator(`s-page[heading="Teams"]`).waitFor(); return { url: page.url(), rows: await frame.locator("s-table-row").count() };'
```

Title-bar buttons such as `Create team`, `Create workflow`, `Add member` and `Delete member` are mirrored into the admin's title bar. Click them with `V top click "getByRole('button', { name: 'Create team' })"`. A **More actions** menu item (Rename, Delete) never opens through the admin's menu. Click the hidden in-frame item natively:

```bash
V app 'await frame.locator("s-menu#team-actions s-button", { hasText: "Rename" }).evaluate(el => el.click());'
```

Pages and lists show their name as an `s-page` heading (`s-page[heading="Orders"]`), sections as `s-section[heading="…"]`, and modals as `s-modal#<id>`.

## Evidence

```bash
V proof <name>
```

Writes `<name>.png` (screenshot), `<name>.yml` (ARIA snapshot of the admin and the app frame) and `<name>.console.txt` into `.logs/verify/<run-id>/`. Every `in`, `top`, `app`, `goto` and `note` is appended to `log.md` there with a timestamp, so the log records each action and the proofs record the state it led to. `.logs/` is git-ignored and nothing prunes `.logs/verify/`.

Proof standards:

- Drive the merchant's path: the App nav, buttons and fields. Never use `/api/dev/*`, test-control RPCs or `AddToFixture` as the action under test.
- Take a proof after the action and of the resulting state. A toast alone is not proof: reopen the thing from its list, or `V goto` the page again, and take a second proof.
- Verify side effects in a second view: the record after a reload, the orders strip count after a task changes, the team's members on the member page.
- Report a journey whose precondition the store lacks as failed, with the reason. Never weaken it to make it pass.
- Snapshots and console logs can hold session tokens. Do not commit or paste them unredacted.

## Cleanup

```bash
V stop
```

Closes the `dev` session's tab and detaches from the agent Chrome, which keeps running. Stops the dev server only if this run started it, and closes the run. The evidence stays in `.logs/verify/<run-id>/`. Before `stop`, delete what the run created in the store, through the UI. Never kill a process by name. If `stop` fails partway, run `vp run browser close` and remove `.logs/verify/current`. Never quit the agent Chrome: other agents use it.

## Inspect with the chrome-devtools CLI

For what Playwright doesn't show well (the CSS cascade, network bodies, performance traces, Lighthouse), use the `chrome-devtools` CLI on the same agent Chrome. `vp run browser agent` prints this checkout's flag, `--sessionId=<WEBSITE_PORT>`; pass it on every command. Its commands and options are in the `chrome-devtools-cli` skill that ships inside the installed `chrome-devtools-mcp` package.

- Never run `chrome-devtools start` or `stop` yourself. `vp run browser agent` starts this checkout's server with the right browser. Without it, the first command launches a separate, logged-out headless Chrome.
- `chrome-devtools list_pages` shows every tab in the agent Chrome, other agents' included. Act only on your own page id.
- Element uids change with every snapshot. Take a fresh `take_snapshot` before acting on a page that changed.
- Snapshots repeat the app frame's URL, session token included, on every link. Write them with `--filePath` and search the file instead of printing them.

## Gotchas

- Accessible names match as substrings unless `exact: true`: `ana@example.com` also matches `dana@example.com`, and the CLI then fails with a strict mode violation. Pass `exact: true` for every name.
- A click on a disabled Polaris button reports success. After every action, assert its result with `V app '… .waitFor() …'`; never assume the click took.
- `V` exits 1 on a failed locator or wait and prints `### Error`. Never pipe it through `tail` or `head`, which hides both.
- The Shopify CLI's Dev Console overlays the lower half of the admin and swallows clicks without an error. `open` and `ready` collapse it. If a click reports success and nothing happens, run `vp run browser ready` and retry.
- A click inside a frame that is not hydrated yet is dropped without an error, because the body is `inert` until hydration. After any navigation, wait for the target `s-page` heading or run `vp run browser ready`.
- The admin's own nav has an Orders link too. App nav links are the ones whose `href` contains `/apps/`. Use `getByRole('link', { name: 'Orders', exact: true }).and(locator('a[href*="/apps/"]'))`.
- The console always shows a 403 for `admin.shopify.com/favicon.ico` and two admin warnings (ShopifyQL, deprecated parameters). They are the admin's, not Baton's.
- An open workflow editor is a second embedded iframe (`chrome=window`). The `in` target excludes it. Drive the editor with `V app` and `page.frameLocator('iframe[src*="chrome=window"]')`.
- `vp run browser open` closes the `dev` session's tab and opens a new one, so never run it while another agent drives this checkout.

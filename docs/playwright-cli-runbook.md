# Playwright CLI for LLM checks

Optional while implementing or verifying Baton. Choose CLI or Chrome MCP as useful.
Run commands from the checkout root. Headless by default; use `open --headed` when helpful.

## Start

```sh
vp run dev
vp run browser open
```

If login is missing or expired, run `vp run e2e:auth`, then reopen. This exports a
Shopify login from macOS Keychain and can require a person. Chrome must be installed.

`open` restarts this checkout's `dev` session, loads the login, opens the dev store,
waits for hydration and collapses Dev Console. It reloads once if hydration stalls.
Read `.playwright-cli/dev-ready.yml` for element references.

## Drive and verify

```sh
vp exec playwright cli -s=dev click f1e14
vp run browser ready
vp exec playwright cli -s=dev screenshot --filename=.playwright-cli/check.png
```

Replace `f1e14` with a current snapshot reference; `f…` references identify iframe content.
Run `ready` after navigation: it repeats the readiness checks and replaces
`dev-ready.yml`. Verify the resulting content, not just that a click returned.
Use snapshots or role locators for Polaris; DOM text checks can miss its shadow content.

`run-code` executes Playwright JavaScript against the current `page`; use it for
more complex checks. The app frame selector is
`iframe[src*="embedded=1"]:not([src*="chrome=window"])`.
Use normal clicks for app controls; JavaScript `.click()` bypasses pointer checks.

```sh
vp run browser close
```

## Files and cleanup

- `.playwright/cli.config.json`: committed defaults; 100 MiB output budget, 10-second
  action timeout. The directory separates browser sessions between checkouts. No login here.
- `.playwright-cli/`: ignored snapshots, screenshots, console logs and traces, retained
  for debugging. Oldest files are pruned as CLI commands run; the budget is best-effort.
- `dev-ready.yml`: latest prepared snapshot; overwritten by `open` and `ready`.
- `playwright/.auth/shopify-admin.json`: ignored login export, outside that cleanup budget.

Verification evidence storage is undecided.
Explicit filenames resolve from the checkout root, not automatically from `.playwright-cli/`.

Snapshots and logs can contain login tokens. Do not commit or share them unredacted.
`close` stops the browser; it does not delete artifacts. Manual fallback:
`vp run clean:playwright-cli` removes files roughly 48 hours old.

## Recover

- **Server/tunnel failure:** inspect `vp run dev:status` and `.logs/dev/current`;
  restore `vp run dev`, then reopen.
- **Login redirect:** refresh with `vp run e2e:auth`, then reopen.
- **Stale reference:** run `ready` and use the new snapshot.
- **Readiness failure:** inspect the page and dev logs. Try `open --headed` or Chrome MCP.
- **Wrong data:** this drives the dev store. `vp run fixture` restores fixture data.
- **A Baton window or page spins forever while the Worker logs 200 for its document:** check
  whether Codex Browser Use is attached to the tab (Chrome shows "is debugging this browser").
  It holds every page load in that tab until its site approval clears. When that approval fails
  (for example, at a ChatGPT usage limit), loads never finish, and reloading doesn't help.
  Retest in a tab Browser Use isn't attached to before treating it as an app bug.

CLI and e2e share their iframe, hydration and console guards in
`scripts/lib/embedded-app.ts`. The wrapper serializes those functions into `run-code`
because its VM cannot import modules. Keep new helper dependencies in that serialization.

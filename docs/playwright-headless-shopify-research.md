# Headless Playwright and Shopify authentication

Research date: 2026-09-17. Scope: running the complete E2E suite headless against local development, with Chrome's existing Shopify session. CI and unattended execution are out of scope.

## Result

The full suite passed headless: **31 passed, 0 failed, in 3.4 minutes**, run by Luna outside the execution sandbox. The headed baseline passed all 31 tests in 3.6 minutes. Those runs required no application or authentication fixes.

The normal package command had explicitly forced `--headed`. Following review, it now defaults to headless and has a separate headed variant:

```bash
# Full local suite, headless.
npm run test:e2e -- --reporter=line

# Same suite with visible browsers.
npm run test:e2e:headed -- --reporter=line
```

Both select the embedded and member projects. The suite replaces local test fixtures, including members, teams, workflows, orders, and identities. Start the local app and Shopify preview first; Playwright does not start them.

The installed Playwright Test CLI defaults to headless. It exposes `--headed`, not a corresponding `--headless` test-runner flag. `--debug` and `PWDEBUG=1` enable headed debugging. The project continues to use `channel: "chrome"`; no browser-distribution change was needed. [Playwright browsers](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)

`AGENTS.md` now defaults both E2E execution and interactive `playwright-cli` exploration to headless. Use headed mode when the user requests a visible browser or manual interaction is needed, such as signing in.

## Verification

After implementing the review changes, Luna ran `npm run test:e2e -- --reporter=line --output=playwright/headless-after-auth-fixes`: **31 passed, 0 failed, in 5.0 minutes**. The parent independently checked its passing `.last-run.json`. Typecheck, lint, and the six exporter regression tests also passed.

| Check                                          | Result                                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial headless embedded smoke                | Setup and home test passed in 16.1 seconds; refreshed 15 cookies                                                                                                                        |
| Repeated headless embedded smoke               | Setup and three home tests passed in 20.2 seconds; reused the saved export                                                                                                              |
| Headless anonymous member redirect             | Passed outside the sandbox in 1.4 seconds                                                                                                                                               |
| Full headed baseline                           | 31 passed in 3.6 minutes                                                                                                                                                                |
| Full headless baseline, Luna                   | 31 passed in 3.4 minutes; exit code 0                                                                                                                                                   |
| Updated exporter, real Chrome session          | Successfully wrote 15 cookies                                                                                                                                                           |
| Exporter regression tests                      | Six passed: atomic replacement/permissions, stale-state preservation, partial-write cleanup, database/WAL cleanup, secret-safe errors, and cancellation of a child that ignores SIGTERM |
| Full headless suite after review changes, Luna | 31 passed in 5.0 minutes; exit code 0; new default npm command                                                                                                                          |

Baseline commands and evidence:

```bash
# Historical headed baseline, before test:e2e changed to headless.
npm run test:e2e -- --reporter=line --output=playwright/headed-research-baseline

# Full headless baseline.
pnpm exec playwright test --project=e2e --project=member --reporter=line --output=playwright/headless-full-suite

# Exporter regression tests (Node runtime, not the Workers test pool).
node --test scripts/lib/shopify-playwright-auth.test.ts
```

Both baseline output directories contain `.last-run.json` with `status: "passed"` and an empty `failedTests` array. The parent independently checked the headless result.

Some initial attempts failed inside the execution sandbox before test logic: Chrome aborted with permission errors involving `bootstrap_check_in`, Crashpad, and `kill EPERM`. Running outside the sandbox resolved them. They were not Shopify authentication or test assertion failures.

Ignored Playwright artifacts and storage state can contain authenticated page data. Do not commit or publish them. No cookie values or Keychain secret were printed during the investigation.

## Current authentication flow

Relevant files:

- `playwright.config.ts`: Chrome channel, saved-state path, setup dependency, and independent member project.
- `e2e/shopify-admin.setup.ts`: saved-session freshness check and direct invocation of shared refresh logic.
- `scripts/refresh-shopify-playwright-auth.ts`: command-line interface.
- `scripts/lib/shopify-playwright-auth.ts`: asynchronous Keychain lookup, cookie extraction, cleanup, validation, and atomic publication.
- `e2e/app.ts`: admin navigation, iframe selection, hydration wait, and one reload attempt.

1. Playwright loads `.env` and `.env.playwright`. `SHOPIFY_PREVIEW_URL` identifies the embedded admin page.
2. Setup reads `playwright/.auth/shopify-admin.json` and checks the actual expiry of `koa.sid` on `admin.shopify.com`, with a five-minute buffer. A fresh export skips Keychain access and has its permissions restricted to `0600`.
3. If refresh is needed, setup calls the shared Effect directly. The old blocking exporter subprocess has been removed.
4. The exporter checks that the selected Chrome profile's cookie database exists, then runs `/usr/bin/security find-generic-password` asynchronously to retrieve the Chrome Safe Storage secret.
5. It copies the Chrome cookie database and any WAL into a private, scoped temporary directory, then decrypts cookies for the selected Shopify hosts. The SQLite handle closes even on failure.
6. Before publishing, it checks the exported admin cookie's expiry. An expired or missing session fails without replacing the previous export.
7. It writes a `0600` file inside a private staging directory on the destination filesystem, then renames it over the destination atomically. Scope cleanup removes the staging directory and database copies on completion, failure, or interruption.
8. Each embedded test context loads the saved state before navigating. The member project has empty storage and no Shopify setup dependency.

The Keychain secret decrypts Chrome cookies. It is not a Shopify API key or the user's Shopify password. The resulting JSON contains decrypted browser cookies and is separate from Shopify CLI login, Baton's D1 session, and member Better Auth sessions.

Automated Chrome uses isolated contexts, not the user's regular profile. The exporter alone reads that profile. Cookie-only state (`origins: []`) proved sufficient for the full local suite. Playwright can also preserve localStorage and IndexedDB, but no need to add those was demonstrated. [Playwright authentication](https://playwright.dev/docs/auth)

## Profile configuration

Set the Chrome directory name in `.env.playwright`:

```dotenv
SHOPIFY_CHROME_PROFILE=Default
```

Use the directory name from Chrome's `chrome://version` Profile Path, such as `Default` or `Profile 1`, not the profile's display name. Automatic setup and the CLI use this setting. The CLI loads `.env.playwright`; an explicit `--profile` overrides the environment setting.

```bash
node scripts/refresh-shopify-playwright-auth.ts
node scripts/refresh-shopify-playwright-auth.ts --profile "Profile 1"
```

A missing profile fails before accessing Keychain. Profile names cannot contain path separators or refer to parent/current directories. `--dry-run` still accesses Keychain and decrypts cookies; it only skips publication.

## Keychain prompts and cancellation

Headless controls browser windows. It does not suppress macOS prompts from the separate `security` command. A refresh can therefore need a Keychain approval even while E2E browsers run headless.

Apple distinguishes allowing one access from Always Allow for the requesting application. The relevant caller here is `security`; inspect the prompt's requesting application. No Keychain policy was changed during this work. The user cannot confirm whether their previous Always Allow choice prevented later prompts, so that remains unresolved. [Apple Keychain access](https://support.apple.com/en-lamr/guide/mac-help/kychn002/mac)

Playwright already supplies `--password-store=basic` and `--use-mock-keychain` to automated Chrome. Those flags do not control the exporter's separate Keychain lookup.

The old implementation used two nested `execSync` calls with no child-process timeout. Because they blocked Node's event loop, the outer Playwright timeout was not a reliable limit on a stalled prompt. [Node child processes](https://nodejs.org/api/child_process.html)

That implementation has been replaced:

- Keychain lookup deadline: 120 seconds.
- Overall refresh deadline: 150 seconds, inside the 180-second setup test timeout.
- Interruption closes the child-process scope, sends SIGTERM, and escalates to SIGKILL after two seconds if necessary.
- Errors omit captured Keychain output. Denied/failed access, timeout, and missing profile have actionable messages.
- Setup calls shared refresh logic directly, so there is no outer exporter process to orphan a Keychain child.

A regression test confirms that cancellation terminates a synthetic child even when it ignores SIGTERM. The real exporter also completed successfully with the new implementation.

## Why no browser preflight was added

The proposed preflight would navigate to Shopify and distinguish a login/account-selection redirect from a missing iframe or failed app hydration. That could produce clearer errors when a cookie has a future expiry but Shopify has revoked it.

It is **not required for headless execution**. The full suite already exercised authentication and passed. Adding another browser navigation would add time and another place for tunnel failures. Following review, it was not implemented.

The existing expiry check is deliberately described as a freshness check, not server validation. The exporter validates freshness before atomic publication; that does not imply a browser preflight was added.

## Remaining findings

These are documented limitations, not demonstrated headless blockers:

| Finding                                                               | Current decision                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Future-dated or session cookies can still be rejected by Shopify      | Keep the local expiry check; the embedded tests exercise acceptance. No extra browser preflight.                 |
| Exported browser state does not persist rotated cookies after tests   | Keep refresh from the selected regular Chrome profile. No new session-renewal mechanism.                         |
| Database and WAL are copied separately                                | The possible snapshot race remains; no observed failure justified replacing the copying strategy in this change. |
| Decryption assumes the current v10 format and strips a 32-byte prefix | Record as compatibility work if Chrome changes. Chromium schema version 24 added the host hash prefix.           |
| Fixed Shopify host selection; partition metadata is omitted           | Full-suite evidence supports the current selection. No generalized profile exporter.                             |

[Chromium cookie-store source](https://chromium.googlesource.com/chromium/src/net/+/master/extras/sqlite/sqlite_persistent_cookie_store.cc) documents the schema prefix.

The requested changes are limited to local headless commands, agent instructions, subprocess cancellation, temporary-file cleanup, owner-only output, atomic writes, and profile configuration. Cleanup manages files created by each new invocation; it does not scan or delete historical temporary files.

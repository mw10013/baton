# Headless dev setup: the shop credential and the admin login

Research, 2026-10-04. The question started as "can the dev scripts share a Chrome profile so no
window opens during a reset". Working through it from first principles splits it into two separate
needs with separate answers; the profile is the answer to only one of them.

## Decisions (2026-10-04)

- **The reset keeps opening the app in everyday Chrome, now with `open -g`.** Everyday Chrome is
  always logged in, and the token it produces renews itself (a 1-hour access token with a 90-day
  refresh token, renewed by `refreshShopSessionIfExpired` in `src/lib/Shopify.ts`), so this path has
  worked; the only problem was the tab coming to the front. `open -g` opens the URL without bringing
  Chrome forward. Chrome still makes the new tab its active tab, so the tab shows when Chrome is
  brought forward or is already in front, and it stays open after the install. Smallest change first;
  see how it works in practice.
- **No dev-only logic in the app's code.** Option A below (mint the token with the client credentials
  grant) works, tested 2026-10-04, but needs a dev route and a dev-only branch in the token renewal
  code. Rejected for that reason.
- **No AppleScript.** Opening the tab in the background and closing it by tab ID through `osascript`
  was considered and rejected.
- **The Chrome profile is for later**, for the e2e suite (Need 2) and possibly the reset (option C).
  The rest of this document is kept as the research for that.

The questions at the end are open only for that later work.

## First principles

### What we are trying to do

Every worktree should get to a working local app (server up, app installed on its dev store, data
seeded) and run its tests without a window opening on the developer's screen. A window appears only
when the developer asks for one: opening the app to look at it, or a headed test run.

### The two needs

A browser shows up in today's scripts for two reasons that look alike and are not.

1. **The dev server needs a shop credential.** Baton calls the Admin API with the offline access token
   in the `ShopSession` row in local D1. Without it, `/api/dev/seed` refuses (409) and nothing that
   talks to Shopify works. This is a server-to-Shopify credential. No person and no page is involved
   in using it; a browser is involved today only because of how we get it.
2. **The e2e suite needs a browser logged into the Shopify admin.** The embedded app's tests drive the
   admin page with the app in a frame, so the test browser itself must hold a Shopify admin login.
   This one is inherent: the browser is the thing under test.

Today both are served by the developer's everyday Chrome (a window for the first, a cookie copy for the
second), and the e2e setup project also does the first job ("shopify app installed"). That is the
mixing-up: one fragile mechanism carries two needs, so every fix to one disturbs the other.

### Need 1: why a reset needs a browser at all

It does not need one in principle. The credential is lost only because `dev:reset` deletes it: wiping
`.wrangler` deletes local D1 and the `ShopSession` row with it, while Shopify still has the app
installed and the token is still valid. We then get a new one the only way the scripts know, token
exchange, which needs the app loaded in a logged-in admin, which needs a browser.

What Baton does when it gets the credential is small: `exchangeAndStore` in `src/lib/Shopify.ts`
exchanges the session token, fetches the shop GID, and writes the row (`storeShopSession`). Nothing
else runs on install, so getting the row another way skips no app behaviour.

Three ways to have the row after a reset, none of them needing a browser:

- **A. Mint it with the client credentials grant.** Shopify gives an app a token for a store in the
  same organization from its client ID and secret alone, with no person involved
  (`refs/shopify-docs/docs/apps/build/authentication-authorization/client-credentials-grant.md`). The
  dev stores are created in our organization. A dev-only route beside `/api/dev/seed` would request the
  token with the secret the Shopify CLI already passes to the dev server (`SHOPIFY_API_SECRET`), fetch
  the shop GID, and call `storeShopSession`; `dev:start` calls it instead of `open`. It works from an
  empty D1, in any worktree, every time. Differences from a real install: the token lasts 24 hours and
  has no refresh token, so the route re-mints when it expires (or the next time the developer opens the
  app, token exchange replaces it with a normal one, since `exchangeAndStore` re-exchanges an expired
  session). Confirmed 2026-10-04: a `client_credentials` request for this app on `sandbox-shop-01` returned 200 with `scope` `read_orders,read_products` (the app's full scopes) and `expires_in` 86399.
- **B. Keep the row across the reset.** `dev:reset` reads the `ShopSession` row before the wipe and
  writes it back after. No Shopify feature to rely on, and the token stays the real expiring offline
  token with its refresh token, which `Shopify.ts` renews. It fails when there is no row to keep: a new
  worktree, or a reset after a failed one. Rejected in an earlier session: a reset should really
  reset, and B carries state through it.
- **C. Keep token exchange, in a headless browser.** The profile proposal below. It still needs a
  logged-in browser, so it carries Need 2's whole login problem into the reset. If the reset and the
  e2e suite share the profile, the reset must launch Chrome through Playwright (see "The idea"), which
  an earlier session ruled out for the reset.

The one case none of them covers is the first install of the app on a new dev store, which a person
does once per store, in a browser, as a merchant would.

**Recommendation: A.** The grant works for this app and store (tested 2026-10-04). It takes the
browser out of `dev:start` and `dev:reset` entirely, which is the disruption that started this, and it
keeps the reset a real reset: D1 starts empty and the credential is new. What it does not exercise is
token exchange, the step a merchant's install runs; that step is exercised whenever a person opens the
app and by every e2e run. If A does not work, C on a profile the reset alone uses (plain headless
Chrome, no Playwright) is the fallback.

### Need 2: the admin login for the e2e suite

This is the only place a browser login is needed, and it is already headless: the `e2e` project runs
headless Chrome with cookies copied from everyday Chrome. What hurts is the copy: the Keychain prompt,
the "quit Chrome with Cmd-Q" failure, reading personal browser data. The fix for that is a Chrome
profile the tests own, logged into once, described under "The idea" below.

It is a separate change with its own risk (whether Shopify accepts a login in a Playwright-launched
browser), and nothing in Need 1 waits on it. Once Need 1 has a dev route, the setup project's
"shopify app installed" test calls that route instead of loading the app, so the e2e suite stops doing
the dev server's job.

**Recommendation: do Need 1 first and alone. Take up Need 2 later, if the cookie copy keeps hurting.**

## Why a browser is needed at all (as the scripts do it today)

- **The Shopify admin login.** When a person logs into `admin.shopify.com`, Shopify stores a session
  cookie in the browser. Since September 2026 that cookie is `_merchant_essential` on `.shopify.com`
  (the JSDoc on `adminSessionFresh` in `scripts/lib/shopify-playwright-auth.ts` records the change from
  `koa.sid`). Every admin load sends a new copy of it, so a browser used daily stays logged in without
  ever showing the login page.
- **Baton's access token for the shop.** The scripts get it through token exchange: the admin loads
  the embedded app in a frame, App Bridge hands the app a short-lived session token signed for the
  shop, and Baton's server trades that for the access token and writes the row. Token exchange is how
  a merchant's install works; it is not the only grant Shopify offers (see Need 1).

## What happens today

### The dev reset

`pnpm dev:reset` (`scripts/dev.ts`) wipes `.wrangler`, which deletes local D1 and with it the
`ShopSession` row. Shopify still has the app installed on the dev store; only the token is gone. To get
it back, `finishStart` waits for the tunnel to answer, then runs `open <app url>`: the macOS default
browser opens `admin.shopify.com/store/<store>/apps/<client id>`. That browser is the developer's
everyday Chrome, already logged in, so the app loads, the token exchange runs, and the row appears. The
script opens the URL again every 30 seconds until the row exists or 180 seconds pass.

What this costs:

- A browser window comes to the front during every reset, including resets an agent runs, and its tab
  stays open afterwards. A slow install leaves one tab per reopen.
- It depends on the default browser being Chrome or another browser the developer keeps logged in.
  When it is not logged in, the reset waits 180 seconds and fails with `InstallTimedOut`.

Until 2026-10-04 the script opened the browser as soon as the local port answered, before the new
quick tunnel was reachable; the measured gap was 68.9 seconds on one run. The app frame failed to
load, nothing reloaded it, and the install timed out. The tunnel wait and the reopen fixed that. This
research is about the window, not about that failure.

### The e2e suite

Playwright starts its own browser with no cookies, so the `setup` project (`e2e/shopify-admin.setup.ts`)
copies the admin login out of everyday Chrome with `refreshShopifyAuth`:

1. Copy Chrome's cookie database for the `Default` profile (`CHROME_PROFILE`).
2. Read the `Chrome Safe Storage` key from the macOS Keychain (`/usr/bin/security`). Chrome encrypts
   cookie values on disk with it. This is the Keychain prompt.
3. Decrypt the Shopify cookies and write them as Playwright storage state to
   `playwright/.auth/shopify-admin.json`.

The `e2e` project starts real Chrome (`channel: "chrome"`) with that file. The copy does not update
when everyday Chrome does, so it is trusted for 24 hours (`SESSION_MAX_AGE_MS`) and then copied again.

What this costs:

- A Keychain prompt on some runs, which an unattended run cannot answer (120-second bound in
  `readSafeStoragePassword`).
- A refresh fails when everyday Chrome has not loaded the admin recently, and also when Chrome has
  the admin open but has not written its cookies to disk; the fix for the second case is quitting
  Chrome with Cmd-Q (the JSDoc on `writeStorageState`).
- It reads the developer's personal browser data: every cookie on the Shopify hosts, decrypted, in a
  file in the repo (mode `0600`, ignored by git).

The setup project has a second test, "shopify app installed", that opens the embedded app once in
headless Playwright Chrome with the copied cookies so the `ShopSession` row exists before anything
seeds. After `pnpm d1:reset` that test is the install: the token exchange already runs headless,
without a window, in this repo today. The reset's install and this test do the same job by two
different means.

### What the two have in common

Both need "a browser logged into the Shopify admin", and both get it from the everyday Chrome
profile: the reset by opening a window in it, the e2e suite by copying from it. Each problem above
comes from that profile being someone's daily browser, which scripts can neither run in the background
nor read without the Keychain.

## The idea: one Chrome profile for the dev tools (option C for Need 1, the fix for Need 2)

Give the dev tools a Chrome profile of their own, a folder Chrome is pointed at with `--user-data-dir`,
for example `.chrome-dev/` in the checkout (ignored by git). A person logs into the Shopify admin in it
once, in a visible window. After that:

- **The dev reset** opens the app headless on that profile through Playwright
  (`chromium.launchPersistentContext(profileDir, { channel: "chrome", headless: true })`, then
  `gotoApp`), the same load the setup project's "shopify app installed" test does. The token
  exchange writes the `ShopSession`, and the script closes the context once the row appears. No window
  opens. The install is the real one a merchant goes through, so the reset stays a full reset.

  Every launch on the profile has to go through Playwright, the one-time login included. Playwright
  starts Chrome with `--use-mock-keychain` (its default arguments in `playwright-core`), so the
  profile's cookies are encrypted with a fixed mock key, not the `Chrome Safe Storage` Keychain item.
  Chrome started directly on the same folder uses the real key, cannot decrypt those cookies, and the
  profile reads as logged out (and the reverse). Playwright also gives the script the page URL, which
  is how it tells a logged-out profile (the load lands on `accounts.shopify.com`) from a slow one;
  Chrome started from the command line does not print the page URL.

- **The e2e suite** gets its admin login from the same profile, in one of two ways:
  - **Export.** The setup project opens the profile headless, loads the admin (which renews the
    session cookie), and writes `context.storageState()` to `playwright/.auth/shopify-admin.json`.
    The `e2e` and `billing` projects stay as they are and keep a fresh context per test. The cookie
    decryption, the Keychain read and the 24-hour freshness check go away; the export runs on every
    run, because it costs a page load, not a prompt.
  - **Persistent context.** The `e2e` project runs every test in `launchPersistentContext` on the
    profile. This needs a custom `context`/`page` fixture, every test shares one context (cookies,
    local storage, open frames), and only one process can hold the profile, so a headed debugging
    session and a run cannot overlap.

  The export keeps test isolation and the project layout and holds the profile for seconds instead
  of for the whole run.

- **The login stays current by use.** Each reset and each e2e run loads the admin, and each load
  replaces the session cookie in the profile, the same way daily use keeps everyday Chrome logged in.
  A new login is needed only after a gap longer than Shopify's session lifetime, or when Shopify ends
  the session.

Why a separate profile and not the everyday one: Chrome holds a lock on a profile folder while it is
open, so a second Chrome launched on it hands its URL to the running process instead of starting, and
Playwright cannot launch on it at all. Since Chrome 136, Chrome also ignores the remote-debugging
switches Playwright drives it through when they point at the default profile folder
(https://developer.chrome.com/blog/remote-debugging-port), so even a closed everyday Chrome cannot be
driven. Reading its cookie file from outside needs the Keychain.

### When the profile is logged out

The headless load lands on Shopify's login page instead of the admin. The reset sees that from the
page URL and says so in one line: run `pnpm dev:login`, which opens the profile headed through
Playwright at `admin.shopify.com` and waits for the person to reach the admin. The setup project fails
with the same line. Whether the reset should fall back to `open` in the default browser is a question
below.

### What changes, roughly

- A small shared module (for example `scripts/lib/dev-profile.ts`): the profile folder, the launch
  options, and "open the app and report whether it reached the admin". The reset, `dev:login` and the
  setup project all call it.
- `scripts/dev.ts`: the install step calls that module instead of `open`; a `dev:login` command opens
  the profile headed for the one-time login.
- `e2e/shopify-admin.setup.ts`: the "shopify admin auth" test exports storage state from the profile.
  `scripts/lib/shopify-playwright-auth.ts` (Keychain read, cookie decryption, `adminSessionFresh`,
  `SESSION_MAX_AGE_MS`) is no longer needed.
- `playwright.config.ts`: the "Admin session" line of its index comment.
- `.gitignore`: the profile folder, if it is in the checkout.

## Unknowns for the profile

Settled already:

- **Headless Chrome runs the app's frame, App Bridge and the token exchange.** The setup project's
  "shopify app installed" test does exactly this after every `d1:reset`.
- **No Keychain prompt on the profile.** Every launch goes through Playwright, which passes
  `--use-mock-keychain`; Chrome never asks the Keychain for that profile's key.

Still open, each a short spike:

1. **Can a person log into `accounts.shopify.com` in a Playwright-launched headed Chrome?** Playwright
   marks the browser as automated (`navigator.webdriver`), and Shopify's login may challenge or refuse
   it, the way the hosted pricing page's Cloudflare check challenges a headless browser (the `billing`
   project's comment in `playwright.config.ts`). The billing project passing headed is a good sign. A
   first login on a new profile may also ask for a verification code; that happens once.
2. **Does a session cookie rotated in a headless load persist to the profile?** It should: a
   persistent context writes its cookie database on close. Close the context, reopen it, and check
   that the admin still loads.
3. **How long does an unused profile stay logged in?** Shopify does not document the admin session's
   lifetime, and `_merchant_essential` carries a one-year expiry that says nothing about it (the JSDoc
   on `SESSION_MAX_AGE_MS`). If a week without a reset or an e2e run logs it out, the one-time login
   becomes a weekly one. Only time answers this; the logged-out message makes it cheap either way.

## Questions

Only the first three need an answer now; the rest belong to Need 2 and can wait.

1. **Do you agree with the split: Need 1 (the dev server's credential) first and alone, Need 2 (the
   e2e admin login) later and separately?** Recommendation: yes. Need 1 is the disruption that started
   this, it can be solved with no browser at all, and it does not depend on any of the profile's
   unknowns.
2. **For Need 1, is a credential minted by the client credentials grant (A) acceptable for a reset,
   given that the reset then no longer runs token exchange?** Recommendation: yes. The reset still
   starts from an empty D1 and gets a new credential, so it is a real reset; token exchange stays
   covered by the e2e suite and by every time you open the app. It needs no saved state, covers a new
   worktree and a failed reset, and is one dev route plus one call in `dev:start`; `open` and the
   reopen loop leave `scripts/dev.ts`. Fallback if you say no or the grant fails: C on a profile the
   reset alone uses, with plain headless Chrome.
3. **Does the grant work for this app?** Answered 2026-10-04: yes (200, full scopes, 24-hour
   token; see option A).
4. **When a new worktree's dev store does not have the app installed yet, what should `dev:start` do?**
   Neither A nor B can install an app; a person must, once per store. Recommendation: stop with one
   line naming the install URL, rather than open a window. `pnpm worktree:init` is the natural place to
   say it once.

Need 2, for later (recommendations as in the earlier review):

5. One profile per checkout or one shared? Shared, with a lock file.
6. When the profile is logged out, fall back to the everyday browser or stop? Stop with a
   `pnpm dev:login` line.
7. E2E: export storage state from the profile, or run in a persistent context? Export.
8. Keep `refreshShopifyAuth` as a fallback? Delete it once the profile works.

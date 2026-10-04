# A browser profile for the dev scripts

Research, 2026-10-04. The question: two dev tools need a browser that is logged into the Shopify
admin, and both get one by leaning on the developer's everyday Chrome. Can they share one browser
profile of their own instead, so that no window opens during a reset and no cookies are copied out of
Chrome for the e2e suite?

Nothing here is decided. "Questions" at the end lists what needs an answer before a plan.

## Why a browser is needed at all

Two separate credentials are involved, and only one of them is the problem.

- **The Shopify admin login.** When a person logs into `admin.shopify.com`, Shopify stores a session
  cookie in the browser. Since September 2026 that cookie is `_merchant_essential` on `.shopify.com`
  (the JSDoc on `adminSessionFresh` in `scripts/lib/shopify-playwright-auth.ts` records the change from
  `koa.sid`). Every admin load sends a new copy of it, so a browser used daily stays logged in without
  ever showing the login page.
- **Baton's access token for the shop.** Baton calls the Admin API with an offline access token stored
  in the `ShopSession` row in local D1. Shopify issues it only through token exchange: the admin
  loads the embedded app in a frame, App Bridge hands the app a short-lived session token signed for
  the shop, and Baton's server trades that for the access token and writes the row.

So getting a `ShopSession` needs the app loaded inside the admin, and loading the admin needs a browser
holding a valid admin login.

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

### What the two have in common

Both need "a browser logged into the Shopify admin", and both get it from the everyday Chrome
profile: the reset by opening a window in it, the e2e suite by copying from it. Each problem above
comes from that profile being someone's daily browser, which scripts can neither run in the background
nor read without the Keychain.

## The idea: one Chrome profile for the dev tools

Give the dev tools a Chrome profile of their own, a folder Chrome is pointed at with `--user-data-dir`,
for example `.chrome-dev/` in the checkout (ignored by git). A person logs into the Shopify admin in it
once, in a visible window. After that:

- **The dev reset** runs Chrome headless against that profile, with no Playwright:

  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --user-data-dir=.chrome-dev "<app url>"
  ```

  Chrome loads the admin with the profile's login, the app's token exchange writes the `ShopSession`,
  and the script ends the Chrome process once the row appears. No window opens. The install is the real
  one a merchant goes through, so the reset stays a full reset.

- **The e2e suite** starts Chrome on the same profile (Playwright's `launchPersistentContext` with the
  profile folder and `channel: "chrome"`) instead of a copied cookie file. The cookie copy, the Keychain
  read and the 24-hour freshness check go away, and the setup project with them.
- **The login stays current by use.** Each reset and each e2e run loads the admin, and each load
  replaces the session cookie in the profile, the same way daily use keeps everyday Chrome logged in.
  A new login is needed only after a gap longer than Shopify's session lifetime, or when Shopify ends
  the session.

Why a separate profile and not the everyday one: Chrome locks a profile folder while it is open, so a
second Chrome process cannot use the profile the developer has open, and reading its cookie file from
outside needs the Keychain.

### When the profile is logged out

The headless load lands on Shopify's login page instead of the admin. The reset can see that from the
page URL in Chrome's output or from the `ShopSession` row never appearing, and should then say so in
one line: log in with a provided command (Chrome on the same profile, visible, at
`admin.shopify.com`). Whether it should fall back to `open` in the default browser is a question below.

### What changes, roughly

- `scripts/dev.ts`: the install step starts headless Chrome on the profile instead of `open`, and stops
  it when the row appears; a `dev:login` command opens the profile visibly for the one-time login.
- `playwright.config.ts` and `e2e/`: the projects launch on the profile; `e2e/shopify-admin.setup.ts`
  and most of `scripts/lib/shopify-playwright-auth.ts` are no longer needed.
- `.gitignore`: the profile folder.

## Unknowns to test before a plan

1. **Does Shopify accept headless Chrome on a logged-in profile?** The e2e suite already loads the
   embedded app in headless Chrome with copied cookies, which suggests yes; a profile-based load has not
   been tried. Shopify may also treat the new profile as a new device on first login and ask for a
   verification code; that happens once, in the visible login.
2. **Does Chrome read its own cookies for a second profile without a Keychain prompt?** Chrome
   encrypts every profile's cookies with the same `Chrome Safe Storage` item, and Chrome itself is
   allowed to read it, so no prompt is expected; not yet observed.
3. **How long does an unused profile stay logged in?** Shopify does not document the admin session's
   lifetime. If a week without a reset or an e2e run logs it out, the one-time login becomes a weekly
   one.
4. **Does headless `--headless=new` run the app's frame and App Bridge fully**, so the token exchange
   happens without any interaction? The e2e suite's headless runs say yes for the copied-cookie case.

## Questions

1. **One profile per checkout, or one shared by every worktree?** One Shopify login covers every dev
   store in the organization, so a shared profile (for example under `~/.baton/`) means one login for
   all worktrees. But Chrome locks the folder, so two worktrees resetting or running e2e at the same
   time would collide. A profile per checkout avoids the collision and needs one login per worktree.
2. **When the profile is logged out, fall back to `open` in the default browser, or stop with the
   login instruction?** The fallback keeps a reset from failing; stopping keeps one way of doing it.
3. **Does the billing project, which runs headed (`pnpm test:e2e:billing`), move to the profile too?**
   A headed run on the profile would also keep it logged in.
4. **Keep `refreshShopifyAuth` as a fallback for the e2e suite, or delete it** once the profile works?

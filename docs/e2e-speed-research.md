# Research: E2E suite speed and fail-fast

Opened 2026-10-07, after the order-not-started work. Revised 2026-10-07 with measurements
from the last HTML report and three timing runs against the dev server; corrections to the
first draft are marked "Correction".

## The problem

Two measurements from `npm run test:e2e --` on 2026-10-07 (92 tests, local dev server):

| run                               | result               | wall time |
| --------------------------------- | -------------------- | --------- |
| first, after the positions change | 14 failed, 78 passed | 26.4 min  |
| final, after the fixes            | 92 passed            | 7.5 min   |

Both are too slow to be useful:

- **A green run takes 7.5 minutes.** That is too long to run after every change, so the suite
  runs rarely, and a break lands long after the change that caused it.
- **A red run took 26 minutes.** The 14 failures had one or two causes (the default list moved
  from Open to Making), and the suite spent about 19 extra minutes confirming the same failure 14
  times. A run that fails should report the failure within a minute or two.

## Where the time goes (measured)

Correction: the first draft said there was no record of per-test durations. There is. The
HTML report (`playwright/report/index.html`) embeds the run as JSON, and `--reporter=list`
prints a duration per test. The last report on disk is the green run of 2026-10-05 (87 tests,
before the five added since), 6.6 min wall, and the sum of the test durations is 390 s of the
399 s wall: the time is inside the tests, not between them.

| spec                         | tests | total | per test |
| ---------------------------- | ----- | ----- | -------- |
| `orders.spec.ts`             | 16    | 141 s | 8.8 s    |
| `member-runs.member.spec.ts` | 40    | 83 s  | 2.1 s    |
| `workflows.spec.ts`          | 9     | 79 s  | 8.7 s    |
| `members.spec.ts`            | 3     | 25 s  | 8.2 s    |
| `teams.spec.ts`              | 2     | 24 s  | 12.2 s   |
| `home.spec.ts`               | 2     | 12 s  | 6.2 s    |
| `member-area.member.spec.ts` | 5     | 9 s   | 1.8 s    |
| `admin.admin.spec.ts`        | 7     | 9 s   | 1.3 s    |
| `shopify-admin.setup.ts`     | 2     | 8 s   |          |

Grouped by project: the embedded project (orders, workflows, members, teams, home) is 32 tests
and 281 s, about 8.5 s per test. The member, admin and public projects are 52 tests and about
100 s, about 1.9 s per test. The embedded project is three quarters of the run with a third of
the tests.

Three timing runs on 2026-10-07 against the running dev server say why:

| step                                                            | time       |
| --------------------------------------------------------------- | ---------- |
| `/api/dev/seed` (the `pnpm seed` fixture)                       | 0.8 s      |
| `gotoApp` (admin document, app iframe, hydration)               | 4.0–9.2 s  |
| `clickHoisted(appNavLink(...))` to the next screen visible      | 0.9–1.0 s  |
| `gotoApp(page, "app/orders")` with the admin already warm       | 4.0 s      |
| setup "shopify app installed" (one `gotoApp` to make a session) | 7.6–10.4 s |
| member sign-in by magic link (`signIn`)                         | ~3 s       |
| a member page load (`gotoMember`)                               | ~1 s       |

A hoisted nav click is a client-side navigation: the iframe's `performance.timeOrigin` does
not change across it, so the `gotoApp` then `clickHoisted(Orders)` pattern pays the admin boot
once, not twice. Every embedded test pays it at least once, because every test starts from a
fresh `page`. The slowest test, "each order-page state draws the controls its action set
allows" (20.7 s), calls `gotoApp` once per seeded state; the editor tests pay a second document
boot for the `s-app-window` iframe (about 2 s to hydration) on each `openEditor`.

Corrections to the first draft's leads:

- **Seeding is not a cost.** A seed is 0.8 s; the 13 seeds in `orders.spec.ts` are about 10 s
  of its 141 s. Nothing to gain there.
- **Cutting tests by count is the wrong lever.** `member-runs.member.spec.ts` has 40 of the
  92 tests and costs 83 s because it signs in twice in `beforeAll` and replays the cookie jar;
  cutting half of it would save 40 s. The lever is the number of admin boots.
- **Lead 5 (overlap with the integration project) stands as a quality point, not a speed one.**

## What the configuration does today

From `playwright.config.ts` and the specs:

- `workers: 1`, `fullyParallel: false`. Every spec seeds through `/api/dev/seed`, which replaces
  the shop's data, and there is one dev store per worktree, so tests cannot run at the same time
  against one store. The member, admin and public projects do not touch the admin, but they seed
  the same shop, so they cannot run beside the embedded project either.
- `expect: { timeout: 10_000 }`. An `expect(...)` gives up after 10 s. `clickHoisted` and
  `clickWhenEnabled` start with an `expect(...).toBeVisible()`, so they fail in 10 s.
- **No `actionTimeout`.** A plain `click`, `fill`, `selectOption` or `waitFor` on an element
  that never appears waits until the test's own timeout. The first run's failures read
  `locator.click: Test timeout of 120000ms exceeded`: each was a plain `.click()` or
  `selectOption` on a frame locator (`showOpen`, the `#9201` link), and each waited the full
  two minutes for a row that was never going to render.
- Per-test timeouts are raised in the specs: `test.setTimeout(120_000)` on 24 tests, `180_000`
  on 5, `240_000` on 1 (`orders.spec.ts`, `workflows.spec.ts`, `members.spec.ts`,
  `teams.spec.ts`). The member, admin, public and home specs use the 30 s default. The longest
  measured green test is 20.7 s, so the raised values are five to ten times what the tests take.
- No `maxFailures`, so the run never stops early, however many tests fail.
- `retries: 0` locally (2 under `CI`), so a failure is not repeated, which helps.
- `gotoApp` waits up to 15 s for hydration, then reloads and waits again. Measured today the
  marker lands at 4 to 9 s, so 15 s is a fair rescue line, not padding.
- `reporter: html` only. Playwright adds its `line` reporter when nothing prints to the
  terminal, and `line` prints no durations; `list` does.
- The `setup` project opens the admin once to make sure a `ShopSession` exists (8 to 10 s on
  every run, even when the session export is fresh), and the member project relies on config
  order to run after it.

Tests per spec:

| spec                             | tests |
| -------------------------------- | ----- |
| `member-runs.member.spec.ts`     | 40    |
| `orders.spec.ts`                 | 16    |
| `workflows.spec.ts`              | 9     |
| `admin.admin.spec.ts`            | 7     |
| `member-area.member.spec.ts`     | 5     |
| `help.public.spec.ts`            | 5     |
| `home.spec.ts`                   | 3     |
| `members.spec.ts`                | 3     |
| `teams.spec.ts`                  | 2     |
| `plan.billing.spec.ts` (not run) | 2     |

Plus the two `setup` tests (admin auth export, app installed).

## The web-component practice, checked

The index comment on `playwright.config.ts` names four practices: the hydration gate, the two
frames, the admin session export, and per-spec seeds. Each claim was checked against the helper
it names on 2026-10-07 and holds. It is incomplete rather than wrong: it leaves out the three
things that actually make clicking tricky, all in `e2e/app.ts` and `e2e/member.ts`:

1. **Hoisted controls (`clickHoisted`, `hoistedEnabled`).** App Bridge lifts `s-app-nav` links
   and title-bar buttons out of the iframe into admin chrome under an `aria-disabled` ancestor,
   so Playwright's own `.click()` refuses them. The helper asserts visibility, polls the
   element's own `disabled`, then fires a native `el.click()`. That native click skips every
   actionability check Playwright has (scroll, stability, occlusion), which is why
   `closeDevConsole` exists: the CLI's Dev Console panel sits over the iframe and swallowed
   clicks the helper reported as successful. This is the admin's DOM, not ours, so the
   workaround is unavoidable; the risk is that a new admin overlay reproduces the Dev Console
   failure silently.
2. **Polaris `s-button` disabled state (`clickWhenEnabled`, `awaitEnabled`, `awaitDisabled`).**
   The helpers poll `disabled` by hand on the premise that Playwright cannot see it. Checked
   2026-10-07 on the member's workflows list with one `evaluate`: `getByRole("button")`
   resolves through the `s-button`'s shadow root to the native `<button>` inside it, and
   Polaris mirrors the host's `disabled` onto that button as a real `disabled` attribute.
   Playwright's `isEnabled()` then reads `false`, so `.click()` waits for enabled on its own
   and `toBeEnabled()` / `toBeDisabled()` are correct. The premise holds only for a locator
   on the host tag itself (`locator("s-button")`), which reports enabled whatever the host
   says. So the rule is: locate controls by role, never by `s-*` tag, and Playwright's own
   actionability is enough; the three helpers are redundant for every role-located button
   and can go. (`s-clickable`, which the strip cells use, renders the same way: a native
   `<button>` in the shadow root.)
3. **The editor window (`openEditor`, `closeEditor`).** After a close the admin rebuilds the
   hoisted title bar, and the Edit proxy reads enabled before App Bridge has rewired it; a
   native click there is a silent no-op (one run in six, traced 2026-10-06). The opener clicks
   until the window's iframe appears. That is a retry on an effect, the only honest check
   available, and it is the one place the suite still has a known flake.

The hydration gate itself (`inert` on body, `data-hydrated` flipping in the same commit) is
sound and cheap, and the reasoning in `src/routes/__root.tsx` and `e2e/hydration.ts` matches
Playwright's source. Nothing in the suite uses `waitForTimeout`, `force: true` or shadow-piercing
selectors; locators are by role and name, with `s-*` tag selectors for page, section, row, modal
and badge. Two tests read `shadowRoot` to measure text overflow, which is fine.

The "silly stuff" is not in the helpers. It is in the shape of the embedded specs: one fresh
admin boot per test, a per-state test that boots the admin per state, timeouts set by hand on
every test, and nothing that stops a systematic failure early.

## Recommendations

In order of payoff per hour, all against the measurements above.

1. **Fail fast in the config, not in the specs.** Set `use.actionTimeout: 10_000` and
   `use.navigationTimeout: 30_000`, so a missing element fails in the same 10 s an `expect`
   does. Set `timeout: 60_000` as the default test timeout and delete every
   `test.setTimeout` except the sync test (180 s, Shopify's bulk operation) and the per-state
   test if it stays as it is. The `gotoApp` rescue path's second `awaitHydration` is then bounded
   by the action timeout, which is what it should be. Expected: a red run's first failure in
   under 30 s of its test starting.
2. **Stop a systematic break early.** `--max-failures=3` in the `test:e2e` script (three, not
   `-x`, so a single flake does not end the run with one line of evidence). Together with 1,
   the 26 min run becomes about 3 min. `--last-failed` is the re-run after a fix.
3. **Print durations.** Reporter `[["list"], ["html", ...]]`. Every later decision needs them.
4. **Order the projects cheap first.** Run member, admin and public before the embedded
   project: they are 52 tests in 100 s with no tunnel in the path, and they fail for different
   reasons. Replace the setup project's "shopify app installed" admin load with a preflight that
   calls the server directly (`dev:status` already knows `answering`, `tunnel` and
   `shopSession`): it drops 8 to 10 s and gives the preflight `gotoApp`'s JSDoc asks for, so a
   dead tunnel fails in one line instead of in every test.
5. **One admin boot per embedded spec.** Do what `member-runs.member.spec.ts` already does:
   `test.describe.configure({ mode: "serial" })`, one `page` opened in `beforeAll` through
   `gotoApp`, and each test seeding (0.8 s) then navigating by hoisted nav link (1 s) instead
   of booting the admin (4 to 9 s). Seeds stay per test, so the fixture is still exact. The cost
   is Playwright's serial rule: after a failure the rest of the spec is skipped, which is what
   recommendation 2 wants anyway. In the per-state test, open each order from the index or by
   `router.navigate` inside the frame instead of `gotoApp` per state. Expected: the embedded
   project from about 280 s to about 100 s, the whole green run to about 3.5 min.
6. **Cut for clarity, not for time.** Where an e2e test pins a rule the integration project
   already pins, and the browser adds nothing (no hoist, no iframe, no socket, no history), cut
   it. The saving is small after 5, so each cut is a judgement, listed test by test in the plan
   for a decision.
7. **Defer parallel workers.** A second dev store per worktree means a second install and a
   second admin session export per worktree, to halve at most the embedded part. Not worth it
   until 1 to 5 are in and measured. `--only-changed` selects by changed test files, not
   changed app files, so it is not a smoke subset.
8. **Retire the `s-button` polls and complete the index comment.** Replace
   `clickWhenEnabled` with `.click()`, `awaitEnabled` with `expect(...).toBeEnabled()` and
   `awaitDisabled` with `expect(...).toBeDisabled()` across `member-runs.member.spec.ts`
   (17 sites), delete the helpers from `e2e/member.ts`, and keep the socket-identified wait
   where a spec needs it as an explicit `toBeEnabled()` on the button it is about to press.
   Add a lint line to `scripts/rules-lint.ts` refusing `locator("s-button")` and
   `locator("s-clickable")` in `e2e/`, so the host-tag locator that defeats Playwright's check
   cannot come back. Then add the hoisted-control and editor-window rows to the index JSDoc on
   `playwright.config.ts`, each pointing at its helper, and state the locate-by-role rule
   there. `hoistedEnabled` stays: the hoisted proxies are the admin's DOM, not Polaris's.

## Decisions (2026-10-07)

Answered in Plannotator on 2026-10-07.

1. **Target: green under 4 min, first failure under 30 s.** Recommendations 1 to 5; no
   second store.
2. **The routine run stops after three failures** (`--max-failures=3`).
3. **Embedded specs go serial**, one admin boot per spec in `beforeAll`; a failure skips the
   rest of that spec.
4. **The setup project's admin load becomes an HTTP preflight** over the server, the tunnel
   and the `ShopSession`; `dev:start` owns the install.
5. **The plan lists cut candidates** with the integration test that pins each rule, for a
   per-test decision.
6. **A second dev store per worktree is deferred.** Wait and see what 1 to 5 reach.

## Cut candidates (2026-10-07)

From phase 6 of `docs/e2e-speed-plan.md`; for the user to decide one test at a time. Nothing
is cut. Each integration test was checked to exist under that title. "Cost" is the test's
own duration in the phase 4 run (after the shared-page change, so no admin boot is in it);
cutting an embedded test saves that and nothing else, because the spec's one boot stays.

| e2e test                                                                                                      | integration test (file, title)                                                                                                                                                                          | what the browser adds                                                                                                                                                                                                                                                                                                                                                                            | cost  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `orders.spec.ts` "a bad filter value reads as no filter"                                                      | `search-params.test.ts` "an unreadable value reads as absent, as an explicit undefined that replaces the raw text"                                                                                      | The old `?view=`, `?position=`, `?issues=` keys and a malformed `?after=` going through the route's `search` validator on a document load, and the Previous button disabled. The integration test pins `lenientSearchKey` alone, not the route's wiring of it. Also the only test that loads the orders index from a typed URL with junk in it; it costs a second admin boot on the shared page. | 3.1 s |
| `orders.spec.ts` "the strip and the Show select hold one value"                                               | none: no integration test pins the strip and the select as two controls on one `?show=` value                                                                                                           | The rule is the two controls' binding in `app.orders.index.tsx`; only the browser sees it. **Not a candidate.**                                                                                                                                                                                                                                                                                  | 1.2 s |
| `orders.spec.ts` "each count is what choosing it shows, given the team"                                       | `order-repository.test.ts` "a count ignores the search and the main filter and honours the team"                                                                                                        | That each strip cell's number equals the rows its click lists, through the route and the live query. The integration test pins the count's SQL, not that the screen reads the same count it filters by.                                                                                                                                                                                          | 2.0 s |
| `workflows.spec.ts` "the editor counts instructions down from 300 and refuses 501 on save"                    | `domain.test.ts` "TaskInstructions refuses 501 characters and accepts 500"                                                                                                                              | The counter appearing at 300 left ("200 characters left") and the field error on Save; both are the editor's, browser-only. Split candidate: the 501 refusal is pinned, the counter is not.                                                                                                                                                                                                      | 3.0 s |
| `workflows.spec.ts` "creating a workflow with a taken tag is refused under the field and names the holder"    | `workflow-repository.test.ts` "createWorkflow refuses a tag another workflow holds, active or inactive, and names the holder" (the plan named the seed test; this is the one that pins the create path) | The refusal landing under the Tag field in the Create modal, and the same modal going through with a free tag into the editor window.                                                                                                                                                                                                                                                            | 1.9 s |
| `members.spec.ts` "a 254-character email is added and printed whole, and 255 is refused on Add"               | `repository.test.ts` "an email over 254 characters is refused and never stored"                                                                                                                         | The field keeping 255 characters (no `maxLength`) and Add showing "Up to 254 characters"; the 254-character address printed whole in the heading and the Details card. The integration test pins the store's refusal only.                                                                                                                                                                       | 2.6 s |
| `member-runs.member.spec.ts` "under a search every task line prints its state"                                | `domain.test.ts` "under a search every task line prints its state"                                                                                                                                      | The search box submitting and the row lines rendering `Domain.runRowLines`' output. The submit is also driven by "search by order number finds the item whatever state is chosen". Closest to a pure duplicate.                                                                                                                                                                                  | 1.4 s |
| `member-runs.member.spec.ts` "a row names its team only for a member on several teams looking at all of them" | `domain.test.ts` "a row names its team when the member is on more than one team and the list is not narrowed to one, or the list is a search"                                                           | The Team select writing `?team=` and the row dropping its team name, and a one-team member's row never showing it. The rule is pinned; the select's wiring is also driven by other member tests. Close to a pure duplicate.                                                                                                                                                                      | 2.1 s |

The whole list costs about 17 s of a 4.1 min run. The last two are the closest to duplicates;
the rest each carry a browser-only half (a field error, a counter, a two-control binding, the
route's search validator) that no integration test pins.

# Plan: E2E suite speed and fail-fast

Written 2026-10-07 from `docs/e2e-speed-research.md` and its Decisions section. This is for
an implementer who has not read the research; the numbers it rests on are repeated here.
Read the research once before starting, and read every JSDoc this plan tells you to edit before
editing it: the helpers in `e2e/` carry measured reasons, and a step that contradicts one is
wrong until the measurement is redone.

## Goal

| measure                                 | today      | target      |
| --------------------------------------- | ---------- | ----------- |
| green `pnpm test:e2e` (92 tests)        | 7.5 min    | under 4 min |
| first failure reported, from test start | 2 to 4 min | under 30 s  |
| a systematic break (14 failures)        | 26 min     | under 3 min |

Where the time is: the embedded project (`orders`, `workflows`, `members`, `teams`, `home`;
32 tests) costs about 280 s because every test boots the Shopify admin in a fresh page
(`gotoApp`, 4 to 9 s). The member, admin and public projects (52 tests) cost about 100 s. A
seed is 0.8 s. A hoisted nav click between app screens is 1 s and stays in the same document.
A red run was slow because no `actionTimeout` is set, so a plain `.click()` on a missing
element waited out the whole 120 to 240 s per-test timeout.

## Decisions already taken (do not reopen)

1. Target as above; no second dev store.
2. The routine run stops after three failures.
3. Embedded specs go serial: one admin boot per spec in `beforeAll`; a failure skips the rest
   of that spec.
4. The setup project's "shopify app installed" admin load becomes an HTTP preflight.
5. Cut candidates are listed (phase 6) for the user to decide one by one; cut nothing on your
   own.
6. A second store is deferred.

## Ground rules

- Run `pnpm typecheck`, `pnpm lint` and `pnpm fmt` after each phase; keep every file `fmt`
  touches.
- Run the suite with `--reporter=list` and record durations in the Measurements section at
  the end of this doc after phases 1, 3, 4 and 5.
- Re-run `pnpm seed` after any e2e run before using the dev store.
- Do not commit.
- No `waitForTimeout`, no `force: true`, no new `evaluate(... click ...)` outside the existing
  hoisted helper. A new wait is on a signal the app sets, named in a JSDoc.
- Locate controls by role and name, never by `s-*` tag (phase 2 explains why).
- When a measured reason in a JSDoc stops being true, rewrite the JSDoc in the same change.

## Phase 1: fail fast in the config

Files: `playwright.config.ts`, `package.json`, every `*.spec.ts` with `test.setTimeout`.

1. In `playwright.config.ts` `use`, add `actionTimeout: 10_000` and
   `navigationTimeout: 30_000`. Add a top-level `timeout: 60_000`. Change the reporter to
   `[["list"], ["html", { outputFolder: "./playwright/report" }]]`.
2. Remove every `test.setTimeout(...)` except:
   - "orders screen syncs open orders and lists them" (`orders.spec.ts`): keep 180 s. Its
     JSDoc says why (Shopify's bulk operation).
   - `plan.billing.spec.ts`: keep its 360 s; the billing project is hand-run and headed.
   - "each order-page state draws the controls its action set allows": keep until phase 3
     rewrites it, then remove.
3. Check `gotoApp` in `e2e/app.ts`: its second `awaitHydration` is now bounded by
   `actionTimeout` (10 s) rather than the test timeout. Update the sentence in its JSDoc that
   says the second wait "uses Playwright's default operation timeout and is therefore bounded
   by the remaining per-test timeout". The 15 s first wait is explicit and stays.
4. In `package.json`, add `--max-failures=3` to `test:e2e` and `test:e2e:headed`, not to
   `test:e2e:billing`.
5. Verify: run `pnpm test:e2e`; all green; durations printed. Then break one locator on
   purpose (for example rename the heading in `showOpen`'s `selectOption` to a label that
   does not exist), run `pnpm test:e2e --project=e2e`, and confirm the first failure lands
   within about 30 s of its test starting and the run stops after three. Restore the locator.

Acceptance: green run unchanged in count; per-test durations in the terminal; the forced red
run stops in under 3 min.

## Phase 2: retire the `s-button` polls

Files: `e2e/member.ts`, `e2e/member-runs.member.spec.ts`, `scripts/lib/rules-lint.ts`,
`test/integration/rules-lint.test.ts`.

Why: measured 2026-10-07, `getByRole("button")` on a Polaris `s-button` resolves through
the shadow root to the native `<button>` inside it, and Polaris mirrors the host's
`disabled` onto that button as a real `disabled` attribute. Playwright's `isEnabled()` reads it
correctly, so `.click()` already waits for enabled, and `toBeEnabled()` / `toBeDisabled()`
are correct. Only a locator on the host tag (`locator("s-button")`) reports enabled wrongly.
`s-clickable` renders the same way.

1. In `e2e/member-runs.member.spec.ts`, at each of the 17 `clickWhenEnabled(x)` sites,
   write `await x.click()`. Where the JSDoc beside the site says the click doubles as the wait
   for the socket to identify, keep that sentence: it is still true, because the button is
   disabled until then and `.click()` waits on it.
2. Replace `awaitEnabled(x)` with `await expect(x).toBeEnabled()` and `awaitDisabled(x)`
   with `await expect(x).toBeDisabled()`.
3. Delete `controlEnabled`, `awaitEnabled`, `awaitDisabled` and `clickWhenEnabled` from
   `e2e/member.ts`. Replace the file's header JSDoc paragraph about `toBeEnabled()` with the
   rule: locate by role and name; Playwright's own actionability is enough for Polaris
   controls; the host tag is never a locator for a control. Keep `hoistedEnabled` and
   `clickHoisted` in `e2e/app.ts`: hoisted proxies are the admin's DOM, not Polaris's.
4. In `scripts/lib/rules-lint.ts`, add a rule for files under `e2e/`: refuse
   `locator("s-button"` and `locator('s-button'` and the same for `s-clickable`, with the
   message "locate a control by role, never by its host tag (e2e/member.ts)". Add a test in
   `test/integration/rules-lint.test.ts` titled by the rule. The existing `locator("s-button")`
   in the specs that are not controls (there are three in `orders.spec.ts`, one in
   `workflows.spec.ts`; check each) either become role locators or, if they measure the host's
   geometry, keep the host locator and the lint is scoped so it does not refuse them: decide
   per site and say why in a comment at the site.
5. Verify: `pnpm test:e2e --project=member` green; `pnpm lint` green; `pnpm test` green.

Acceptance: no hand-rolled enabled poll on the member side; lint refuses the host-tag
locator.

## Phase 3: one admin boot per embedded spec

Files: `e2e/orders.spec.ts`, `e2e/workflows.spec.ts`, `e2e/members.spec.ts`,
`e2e/teams.spec.ts`, `e2e/home.spec.ts`, `e2e/app.ts`.

Pattern, taken from `e2e/member-runs.member.spec.ts`, which already does this on the member
side:

```ts
test.describe.configure({ mode: "serial" });

let page: Page;
let frame: FrameLocator;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStatePath });
  page = await context.newPage();
  frame = await gotoApp(page);
});

test.afterAll(async () => {
  await page.context().close();
});
```

Each test then seeds (`seedMembers`, 0.8 s) and navigates by hoisted nav link
(`clickHoisted(appNavLink(page, "Orders"))`, 1 s) or by an in-app link, instead of calling
`gotoApp`. The seed replaces the shop's data under a page that is already open; the page
reads the new data on its next navigation, and the per-shop socket's invalidation may
repaint it before that. Both are fine: every test navigates before it asserts.

1. Add a helper in `e2e/app.ts`, `openApp(browser)`, that does the `beforeAll` body above
   and returns `{ page, frame }`; `storageStatePath` is exported by `playwright.config.ts`.
   JSDoc: why one boot per spec (the measurement), and that serial mode skips the rest of a
   spec after a failure, which decision 3 accepts.
2. Convert `home.spec.ts` first (3 tests, no seeds), run it, measure. Expected: about 6 s for
   the boot plus about 1 s per test.
3. Convert `teams.spec.ts` and `members.spec.ts`.
4. Convert `workflows.spec.ts`. The editor opens in an `s-app-window` iframe; `openEditor` and
   `closeEditor` are unchanged. A test that ends with the editor open must close it, or the
   next test's nav click lands under the window: add `closeEditor` where a test leaves it
   open, and say so in the test.
5. Convert `orders.spec.ts`. Two tests need care:
   - "orders screen syncs open orders and lists them" reads the store's real orders and takes
     15 to 30 s; keep it first in the file so the others' seeds do not race it, and keep its
     180 s timeout.
   - "each order-page state draws the controls its action set allows" calls `gotoApp` once per
     seeded state. Replace with an in-frame navigation: open the index with Show set to the
     state's list, click the order's link, assert the heading. For a state whose order is on
     no index list (the JSDoc at the call says #9502 is cancelled in Shopify, hence opened by
     URL), keep `gotoApp(page, "app/orders/seed-9502")` for that one state only, and say why
     at the site. Remove the test's `setTimeout`.
6. Tests that assert history (`"the orders index keeps its filters and page across the order
page"`, `"a filter change resets the page and replaces history"`, `"the workflows index
keeps its filter across the workflow page"`) use `page.goBack()`. Under a shared page the
   history holds the earlier tests' entries too; each of these must assert the URL or heading
   it lands on, never a count of entries. Read each before converting.
7. Verify after each file: that file green with `--reporter=list`; then the whole suite.

Acceptance: `pnpm test:e2e` green; the embedded project under about 120 s; the whole run
under 4 min. Record the numbers.

## Phase 4: cheap projects first, and a preflight

Files: `playwright.config.ts`, `e2e/shopify-admin.setup.ts`, `package.json`.

1. Reorder `projects` to `setup`, `public`, `admin`, `member`, `e2e`, `billing`. Under
   `workers: 1` Playwright runs the projects with no dependencies in config order, then the
   dependents; `e2e` depends on `setup`, so `setup` still runs first. Update the member
   project's JSDoc sentence about running after `setup`.
2. Replace the test "shopify app installed" in `e2e/shopify-admin.setup.ts` with
   "dev server ready": run `node --env-file=.env scripts/dev.ts status --json` with
   `node:child_process` `execFileSync`, parse it, and assert `answering === true`,
   `tunnel === "reachable"` and `shopSession === true`, each with a message that names the
   fix (`pnpm dev:start`). Its JSDoc says what it replaced and why (8 to 10 s of admin boot
   per run that only checked a row `dev:start` already guarantees), and that a dead tunnel now
   fails the run in one line instead of in every embedded test. Keep "shopify admin auth".
3. The member project's seed needs the `ShopSession` row too; the preflight asserts it, so the
   member project should depend on `setup` now (`dependencies: ["setup"]`), which also drops
   the config-order reasoning from its JSDoc. Check that the auth test does not prompt for the
   Keychain on a member-only run; if it does, keep the member project independent and have
   the preflight run as a `globalSetup` instead (`refs/playwright/docs/src/test-api/
class-testconfig.md`, `globalSetup`).
4. Verify: `pnpm test:e2e` green. Stop the dev server (`pnpm dev:stop`), run again, and confirm
   one failing preflight and no embedded test run. Start it again (`pnpm dev:start`).

Acceptance: a run with the server down fails in under 20 s with one message.

## Phase 5: timeouts and reasons

After phases 1 to 4, read the durations. Any test over 20 s gets a sentence in its JSDoc
saying where the time goes, or gets fixed. Any `test.setTimeout` left (the sync test, billing)
has its reason in its JSDoc already; check it is still true.

## Phase 6: cut candidates (list only; the user decides)

Add a section "Cut candidates" to the end of `docs/e2e-speed-research.md`, one row per e2e
test that pins a rule an integration test already pins and where the browser adds nothing
(no hoist, no iframe, no socket, no history). Columns: e2e test, integration test (file and
title), what the browser adds, cost. Verify each integration test exists before listing it.
Starting list, to verify and extend:

| e2e test                                                                                        | pinned by                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `orders.spec.ts` "a bad filter value reads as no filter"                                        | `test/integration/search-params.test.ts` "an unreadable value reads as absent..."                                                        |
| `orders.spec.ts` "the strip and the Show select hold one value"                                 | find the `Domain.OrdersShow` test in `test/integration/domain.test.ts`                                                                   |
| `orders.spec.ts` "each count is what choosing it shows, given the team"                         | `test/integration/order-repository.test.ts` "a count ignores the search and the main filter and honours the team"                        |
| `workflows.spec.ts` "the editor counts instructions down from 300 and refuses 501 on save"      | `test/integration/domain.test.ts` "TaskInstructions refuses 501 characters and accepts 500" (the counter is browser-only; split or keep) |
| `workflows.spec.ts` "creating a workflow with a taken tag is refused..."                        | `test/integration/workflow-repository.test.ts` "seed: ... duplicate tag refused" (the field error is browser-only)                       |
| `members.spec.ts` "a 254-character email is added and printed whole, and 255 is refused on Add" | find the email length rule's test; the field cap is browser-only                                                                         |
| `member-runs.member.spec.ts` "under a search every task line prints its state"                  | `test/integration/domain.test.ts` same title                                                                                             |
| `member-runs.member.spec.ts` "a row names its team only for a member on several teams..."       | `test/integration/domain.test.ts` "a row names its team when the member is on more than one team..."                                     |

Do not cut anything in this plan.

## Phase 7: the index comment

File: `playwright.config.ts`.

Rewrite the index JSDoc so it has one line per practice, each naming the helper that holds
the reasoning:

- Interaction gate: `awaitHydration` (unchanged).
- Frames: `appFrame`, `editorFrame` (unchanged).
- Hoisted controls: `clickHoisted`, `hoistedEnabled`, `closeDevConsole` (`e2e/app.ts`): the
  admin's DOM, native click, the overlay that defeats it.
- Polaris controls: by role and name, never by host tag; Playwright's actionability is enough
  (`e2e/member.ts` header, the lint rule).
- The editor window: `openEditor`, `closeEditor` (`e2e/workflows.spec.ts`), the one known
  flake and its retry.
- One admin boot per embedded spec: `openApp` (`e2e/app.ts`), serial mode.
- Admin session: `setup` (unchanged).
- Preflight: "dev server ready" in `e2e/shopify-admin.setup.ts`.
- Data: per-spec seeds (unchanged).
- Timeouts: config holds them; a spec that sets its own says why.
- Projects: in run order, cheap first.

## Measurements

Fill in after each phase.

| after phase | tests | green wall | embedded project            | first failure (forced)                                   |
| ----------- | ----- | ---------- | --------------------------- | -------------------------------------------------------- |
| baseline    | 92    | 7.5 min    | ~280 s                      | 2 to 4 min                                               |
| 1           | 92    | 6.9 min    | 290 s                       | 22.6 s; three failures, stopped at 2.1 min               |
| 3           | 92    | 4.3 min    | 100 s in tests + five boots | not rerun                                                |
| 4           | 91    | 4.1 min    | 96 s in tests + five boots  | preflight with the server down: 1.6 s                    |
| 5           | 91    | 4.4 min    | 107 s in tests + five boots | 16.4 s; the spec's other 15 skipped, run done at 1.7 min |
| review      | 91    | 4.3 min    | 134 s in tests + five boots | not rerun                                                |

Durations are from `--reporter=list`. "In tests" sums the per-test times; each spec's
`beforeAll` boot (about 6 s) is not in them. Phase 4 has one test fewer because the setup
project's "shopify app installed" test became the preflight. The other projects after phase
5: member 92 s, public 12 s, admin 9 s. No test is over 20 s; the longest is the workflows
draft lifecycle at 14.6 s, one test that opens and closes the editor window four times.

## Deviations and issues

Record here, as you go, every place the implementation departs from this plan and every
problem found that the plan did not foresee. One entry per item: what the plan said, what was
done instead or what broke, why, and what the user should decide if anything. An empty section
at the end means the plan was followed exactly, which should be stated. Likely entries, from
the research:

- A shared page under serial mode exposing state between tests (an open modal, a search term
  in the URL, an editor window left open).
- `goBack` landing on an earlier test's entry.
- The `s-button` lint refusing a non-control host locator that a spec needs.
- The member project needing `setup` for the preflight and the auth test prompting for the
  Keychain.
- An integration test named in phase 6 that does not exist or pins a narrower rule.

- **The 4 min target is missed narrowly.** Green runs took 4.1 and 4.4 min after phase 4.
  The embedded project is now about 130 s with its boots; the member project, untouched by
  this plan, is 92 s and the largest remaining block. Decide whether to take the member
  project on next (it signs in twice per spec and opens a fresh context per test) or accept
  the result.
- **Phase 3 needed an app change: `data-navigating` on `<body>`** (`src/routes/__root.tsx`),
  and `awaitNavigated` in `e2e/hydration.ts` waits on it. Under a shared page a test clicked
  the previous test's link: the URL changes before the loaders run, and a screen visited
  before paints its cached loader data while the router reruns the loader in the background
  (stale-while-revalidate, with the router reporting itself idle), so a reseeded workflow of
  the same name was clicked by its old id ("That workflow no longer exists."). The marker is
  on while the router is loading or any match is fetching, gated on `hydrated`. The plan's
  ground rule allows a wait on a signal the app sets; the plan did not foresee the app
  change.
- **Phase 3 added `openScreen` (`e2e/app.ts`)** in place of the bare
  `clickHoisted(appNavLink(...))` the plan sketched. A nav click to a screen the app is
  already under does not land on the bare screen: the teams index re-ran nothing after a
  seed, `/app/workflows?state=active` stayed as it was, and the Orders link from an order
  page kept `?show=` (the orders layout's `retainSearchParams`, by design). `openScreen`
  goes through another screen first when the URL is under the target, then waits for the
  bare URL and `awaitNavigated`.
- **Home has no hoisted link back** (`rel="home"` hides it). `home.spec.ts` never leaves
  home, and "adding a member past the included seats ... home tile" in `members.spec.ts`
  calls `gotoApp` on the shared page, a second boot, because home reads the seats in its
  loader and does not refetch on the seed's publish.
- **Three other `gotoApp` calls stay on shared pages, each with its reason at the site:**
  the typed `?q=9301` URL and the junk-filter URL in `orders.spec.ts` (a URL typed by hand is
  a document load; no in-app link carries those values), and #9502 in the order-page states
  test (cancelled in Shopify, on no list). The other five states go through the index with
  Show set to All.
- **Two specs had editors left open:** "creating a workflow with a taken tag ..." and "the
  editor counts instructions down ..." now end with `closeEditor`.
- **History tests:** none counted entries; they assert headings and URLs and pass unchanged
  under the shared page. "a filter change resets the page and replaces history" still asserts
  that one Back leaves Orders by the heading's absence; under the shared page the entry before
  is `openScreen`'s hop screen (Teams), and the following Forward check proves it was one
  entry.
- **Phase 4 took the plan's fallback: the preflight is a `globalSetup`** (`e2e/preflight.ts`),
  not a test in the `setup` project, and the member project stays independent. "shopify admin
  auth" refreshes the export from Chrome's cookies through the Keychain whenever the export
  is stale (`adminSessionFresh`), so making member, admin and public depend on `setup` would
  prompt on member-only runs. The `globalSetup` covers every project, including public and
  admin, which need the server too.
- **The `s-button` lint refuses only the bare host tag** (`locator("s-button")`,
  `locator("s-clickable")`, any quote). The plan said to refuse the prefix; two sites need a
  qualified host selector and click nothing: `s-button[variant="primary"]` in
  `member-runs.member.spec.ts` (the variant is a host attribute no role exposes) and
  `s-clickable[accessibilityLabel^="Edit "]` in `workflows.spec.ts` (card order by label).
  Each says why in a comment. `orders.spec.ts` has no host locator: its `s-button` is a
  `querySelectorAll` inside an `evaluate`. `buttonLabels` in `member-runs.member.spec.ts`
  now locates by role and reads each label from the shadow host.
- **`e2e/member.ts` had no header paragraph about `toBeEnabled()`**; the claim sat on the
  deleted `controlEnabled`. The rule went into the file's header.
- **Billing ran green afterwards, headed** (2026-10-07, `pnpm test:e2e:billing`): both tests
  passed in 35 s and 38 s, with no Cloudflare challenge. Their `setTimeout(360_000)` had no
  reason in their JSDoc, so each test now says why. Their clicks with no explicit timeout are
  now bounded by the config's 10 s `actionTimeout`, and that was enough on this run.
- **Phase 6:** the plan named the seed test for the taken tag; the create path's own test,
  "createWorkflow refuses a tag another workflow holds, active or inactive, and names the
  holder", is the one listed. "the strip and the Show select hold one value" has no
  integration test and is listed as not a candidate.

## Review (2026-10-07)

Reviewed against this plan on 2026-10-07: the diff, typecheck, lint, fmt, the rules-lint
integration tests and a fresh `pnpm test:e2e` (91 passed, 4.3 min; the "review" row above).
Every deviation above is accepted as it stands, including the two the plan did not foresee:

- **`data-navigating` on `<body>` is accepted.** It is the plan's only change outside `e2e/`,
  `scripts/` and the tests. The bit the test needs, "the loaders have finished since the last
  navigation", exists only inside the router: the URL commits before the loaders run, the
  router reports itself idle while it revalidates a cached match in the background, and the
  seed reuses names, so the stale paint and the fresh paint are the same to any locator. The
  alternatives are worse: distinct names per test is a convention that fails silently (an
  absence assertion passes against the stale paint), and a zero `gcTime` costs merchants their
  cached lists. The marker stays a `data-` attribute, not `aria-busy`, which would hold
  assistive announcements for the whole page on every background refetch. Only
  `awaitNavigated` reads it and only `openScreen` calls that; a spec never waits on it
  directly.
- **The 4 min target stands missed at 4.1 to 4.4 min**, accepted. The member project is the
  next target if the run is to get under it, as a piece of work of its own.
- **Nothing is cut.** The cut candidates stay listed in the research doc for a later decision.

## Open issues (to take up later)

- **The member project is the largest remaining block** (92 s of a 4.1 to 4.4 min run). It
  is the next target if the run is to get under 4 min.
- **Cut candidates** are listed at the end of `docs/e2e-speed-research.md`, about 17 s in
  total. Two are close to pure duplicates of integration tests ("under a search every task
  line prints its state" and "a row names its team only for a member on several teams
  looking at all of them"); "the strip and the Show select hold one value" has no
  integration test and is not a candidate.

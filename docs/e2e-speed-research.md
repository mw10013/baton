# Research: E2E suite speed and fail-fast

Opened 2026-10-07, after the order-not-started work. Not started; this records the problem
and the leads, and is to be taken up later.

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

## What the configuration does today

From `playwright.config.ts` and the specs:

- `workers: 1`, `fullyParallel: false`. Every spec seeds through `/api/dev/seed`, which replaces
  the shop's data, and there is one dev store per worktree, so tests cannot run at the same time
  against one store.
- `expect: { timeout: 10_000 }`. An `expect(...)` gives up after 10 s.
- **No `actionTimeout`.** A `click`, `fill` or `selectOption` on an element that never appears
  waits until the test's own timeout runs out. The first run's failures read
  `locator.click: Test timeout of 120000ms exceeded`: each one waited the full two minutes for a
  link that was never going to render.
- Per-test timeouts are raised in the specs: `test.setTimeout(120_000)` on 24 tests, `180_000`
  on 5, `240_000` on 1 (`orders.spec.ts`, `workflows.spec.ts`, `members.spec.ts`,
  `teams.spec.ts`). The member, admin, public and home specs use the 30 s default.
- No `maxFailures`, so the run never stops early, however many tests fail.
- `retries: 0` locally (2 under `CI`), so a failure is not repeated, which helps.
- `gotoApp` waits up to 15 s for hydration, then reloads and waits again.
- `reporter: html`. The line reporter used here prints no per-test durations, so there is no
  record yet of which tests take the time.

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

## Where the time likely goes (to measure, not yet measured)

1. **A failing test waits out its whole timeout.** With no `actionTimeout`, a broken locator
   costs 120 to 240 s instead of about 10. This alone accounts for most of the 26 minutes.
2. **Every embedded test boots the admin.** `gotoApp` loads the Shopify admin, its chrome and
   the app iframe through the tunnel, and waits for hydration. That is several seconds per test
   before the test does anything.
3. **Every test seeds.** `/api/dev/seed` replaces the shop's members, teams, workflows and
   orders and reconciles them.
4. **One worker.** The suite is serial by necessity while all tests share one store.
5. **Overlap with the integration project.** `pnpm test` (772 tests in workerd) already pins the
   action matrices, the filters, the counts and the publish tables. Some e2e tests may assert the
   same rules through the browser at many times the cost. `member-runs.member.spec.ts` alone has
   40 tests.

## Leads

Fail fast:

- Set `use.actionTimeout` (and `navigationTimeout`) near the `expect` timeout, so a missing
  element fails in seconds.
- Lower the per-test `setTimeout` values to what each test needs, measured, and state why on
  any test that needs more.
- Set `maxFailures` (for example 3 to 5) for the routine run, so a systematic break stops the
  run. `-x` stops at the first failure.
- Run what is likely to break first: `--last-failed` after a red run, or the specs that cover
  the change.
- A preflight before the first test: dev server answering, tunnel answering, admin session
  valid. A dead tunnel today fails every test on a timeout. The `gotoApp` JSDoc already names
  this as not done.

Faster green run:

- Measure first: run with `--reporter=json` (or read the HTML report) and rank tests by
  duration.
- Cut tests whose rule an integration test already pins, keeping e2e for what only a browser
  shows: hydration, the iframe and App Bridge, hoisted title-bar actions, the member's
  magic-link sign-in, real navigation and history.
- Fold tests that seed the same shape and walk the same screen into one test.
- Reuse one admin page across the tests of a spec where state allows, instead of a fresh
  `gotoApp` per test.
- Parallel workers. This needs either one store per worker (the worktree scheme already gives
  one store per index) or seeds that leave other tests' data alone (per-test order number
  ranges are already in use: `#92xx`, `#93xx`, ...).
- Run the member, admin and public projects, which do not go through the tunnel or the admin,
  apart from the embedded project, since they are cheaper and fail for different reasons.

## Questions

1. What is the target? For example: green run under 2 minutes; red run reports its first
   failure within 1 minute.
2. Should the routine run stop early (`maxFailures`), or always run everything and report
   every failure?
3. Is a smaller smoke subset acceptable for the routine run, with the full suite run before a
   merge?
4. May e2e tests be cut where an integration test pins the same rule, and who decides each cut:
   the research or you, test by test?
5. Is a second dev store per worktree acceptable, to run two workers?

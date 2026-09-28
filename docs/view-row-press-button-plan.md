# Plan: view rows on `s-press-button`, No workflow leaves Issues, an Issues banner on Orders

Written 2026-09-28 from `docs/view-row-press-button-research.md`, whose section 6 holds the decisions. This plan is for an agent to carry out without further questions. Every fact below was checked against the code on 2026-09-28; if the code has moved, record it under Deviations and follow the code.

## Ground rules

- Follow `AGENTS.md`: glossary words only (`src/lib/Domain.ts`, top), `Domain` predicates rather than inline comparisons, JSDoc carries its reasoning and never cites `docs/`. Do not commit.
- Every JSDoc that states a rule this plan changes is listed under its step. Aligning JSDoc is part of the step, not a follow-up: a JSDoc that still describes the old behaviour is a defect.
- After each step: `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`. After all steps: `pnpm fmt` repo-wide and keep every file it touches, then the e2e suites named in step 4.
- The three steps are independent and can be done in any order, but step 2 before step 3 keeps the banner from ever counting No workflow.

## Step 1. Both view rows to `s-press-button`

### Why

`s-press-button` is Polaris's toggle: `pressed` renders `aria-pressed` on the native button inside the shadow root, so a screen reader hears the state. `s-button` has no pressed state, and `variant="primary"` means the page's main action, which a view is not. `s-press-button` takes only `tone="neutral"` and `variant="secondary" | "tertiary"` (`PressButtonProps` in `@shopify/polaris-types`), so Issues and Blocked lose their red; that is accepted (research Q1, Q3).

### 1a. Orders index, `src/routes/app.orders.index.tsx`

`viewButton` (near line 662):

- Replace `<s-button>` with `<s-press-button>`.
- Props: `key`, `pressed={q === null && view === value}`, `onClick`. Remove `variant`, `tone` and `accessibilityLabel`. Keep the child text `{text}`.
- The self-toggle guard: the CDN `polaris.js` click handler runs `pressed = !pressed` on every click, and React 19 re-sets a controlled property only when its value changes between renders. Clicking the already-pressed view navigates to the same search, nothing re-renders, and the element would stay unpressed. In `onClick`, before `setFilters`, set `event.currentTarget.pressed = pressed;` so the element is put back to what React believes. Type the handler parameter as the element event (`React.MouseEvent` is not it; use the `onClick` type `s-press-button` declares, which the JSX intrinsic gives you when the arrow function is written inline).
- Rewrite the `viewButton` JSDoc. Keep the paragraphs about a counted view always rendering and about every view reading unpressed during a search. Replace the first paragraph with: it is an `s-press-button` because `pressed` is a real state that reaches the native button, where `aria-pressed` on an `s-button` host never did; no red on the row, because `s-press-button` takes only `tone="neutral"` and the alarm colour belongs with the remedy, on the Issues badges and the banner; and the one-line self-toggle guard with the reason above. Do not cite `docs/`.
- The view-row JSDoc above `VIEWS` (near line 51) and the `ISSUES_VIEW` comment do not mention the element; leave them.

### 1b. Workflows list (member), `src/routes/shop.$shop.workflows.index.tsx`

`viewRow` (near line 722):

- Replace `<s-button>` with `<s-press-button>`.
- Props: `key`, `pressed={each === view}`, `inlineSize="fill"`, `onClick`. Remove `variant`, `tone` and the host `aria-pressed`.
- Same self-toggle guard in `onClick` as 1a, with `each === view` as the value to restore.
- Rewrite the `viewRow` JSDoc paragraph that begins "Five views and nothing else". Delete the claim that `variant="primary"` "is the only selected state any of these components has"; it is wrong. Say: a view is an `s-press-button`, whose `pressed` reaches the native button as `aria-pressed`; `inlineSize="fill"` keeps the reason it has now; Blocked has no colour because `s-press-button` takes only `tone="neutral"`, and a member is not usually the one who clears a block. Keep the sentence about zero-count views staying, and the first paragraph. The comment inside the JSX about `s-button-group` and `s-stack` stays.
- `.run-view-row` in `src/styles.css` is a grid over the element's host; check the row still lays out with `s-press-button` hosts (the class does not name the element).

### 1c. Tests

`e2e/orders.spec.ts`:

- `viewButton` (near line 157): the name regex drops the `(?:, selected)?` group. Update its JSDoc (near line 154), which explains the suffix.
- Delete `expectSelected` (near line 163). Every call site goes back to `await expect(viewButton(frame, label)).toHaveAttribute("aria-pressed", "true" | "false")`, which is what these lines were before commit 8724449 (`git show 8724449 -- e2e/orders.spec.ts` shows the exact lines).
- In the search test ("the orders index searches by order number and clears back to the list"), after the step that presses Open, add: press Open again and assert `aria-pressed` is still `"true"` and the list is unchanged. This is the test for the self-toggle guard; title it so it reads as the rule ("pressing the pressed view keeps it pressed").
- The two `s-button[tone="critical"]` assertions near lines 535 and 555 are about row content, not the view row; check they do not target the view row before leaving them.

`e2e/member-runs.member.spec.ts`:

- `selectView` (near line 285) may keep waiting on the URL; add an `aria-pressed` assertion on `view(page, label)` after the URL settles, and reword its JSDoc: the attribute is now on the native button, which `getByRole` resolves to, so it is no longer ambiguous. If `view()` is a text or CSS locator rather than `getByRole`, leave the URL wait as the primary and add the attribute check on a `getByRole("button", { name })` locator.
- Any `s-button` locator that reads the view row (`allTextContents` near line 1577 reads a different row; check) must become `s-press-button` if it targets views.

### 1d. Memory of the change

`src/routes/app.orders.index.tsx` and the member route JSDocs must not say "as the member screen's view row is" in a way that is now circular; say the rule once on the orders index and `{@link}` it from the member route, or state it on each with the same words. One rule, two sites, per `AGENTS.md`.

## Step 2. No workflow leaves Issues (Way B)

### Why

`no_workflow` fires only on an order with no run of any status and no ambiguous item, so it catches a forgotten tag only when the whole order is untagged; a forgotten tag beside a tagged item is already silent. In a shop that also sells ready-made products, every ready-made order is a permanent issue the merchant cannot clear in Baton, so the Issues count never reaches zero and the banner in step 3 would never go away. The tags are the merchant's statement of what Baton makes; an unmatched order is Not started, which is true and visible, and the order page offers a workflow picker on every item.

### 2a. `src/lib/Domain.ts`

- Glossary, "Order issues" table (near line 130): delete the `no workflow` row. Three rows remain.
- `ORDER_ISSUE_LABEL` (near line 265): delete `no_workflow`. Its JSDoc says "the Issues view holds all four": make it three.
- `OrderIssue` (near line 2311): delete the `"no_workflow"` literal.
- `OrderIssue` JSDoc (near line 2270): delete the `no_workflow` table row. Rewrite the "An issue is an undecided item" paragraph: an item whose run the merchant cancelled was decided; an item that matched no workflow is not an issue either, because matching by tag is the merchant's statement of what Baton makes, an unmatched item is by that statement not Baton's work, and flagging it on every order for a ready-made product would be a permanent false alarm that teaches the merchant to ignore the count. State the accepted risk in the same paragraph: a made-to-order product nobody tagged sits in Not started, where the merchant sees it, and its order page offers the picker. Keep the unpaid paragraph and everything after it.
- `orderIssues` (near line 2549): delete the `no_workflow` entry from the `issue` record. Delete the JSDoc sentence about `no_workflow` testing fulfilment itself, since it is about the deleted branch. `canStartRuns` is still used by `choose_workflow`.
- `RunCounts` JSDoc (near line 2422): the sentence about `closed` says "an order whose only runs were closed is not "No workflow"". Rewrite: `closed` is counted so a closed run still holds its item for `ambiguousItems` and the order page; it no longer bears on any issue.
- The tag-vocabulary bullet list (near line 1214): the bullet "an order or item that no workflow's tag matches shows "No workflow"" becomes: the order page says no workflow can start on such an item and offers the picker; the orders index shows the order under Not started with nothing in Issues.
- `OrderSeed` or fixture-kind JSDoc (near line 2122): "the row reads as unpaid rather than "No workflow"" becomes "the row reads as unpaid, with nothing in Issues".
- `ProductionState` JSDoc (near line 2200): no change; it already lists "an order whose items matched no workflow" under Not started.
- Grep `Domain.ts` for `no_workflow`, `No workflow` and `no workflow` after editing; none may remain except in the `ProductionState` JSDoc.

### 2b. `src/lib/OrderRepository.ts`

- Delete the `NO_WORKFLOW` fragment (near line 200) and its JSDoc. Update the `CHOOSING` JSDoc, which says "`NO_WORKFLOW` excludes this whole term".
- `COUNT_FACT.issues` (near line 212): becomes `choosing or unstaffed or blockedRuns > 0`. Update the JSDoc ("`issues` is the three `Domain.orderIssues` elements or'd: choosing, unstaffed, blocked").
- `viewFilter` for `"issues"` (near line 1046): remove the `NO_WORKFLOW` disjunct. Update the JSDoc above it ("the three `Domain.orderIssues` elements").
- The `OPEN` JSDoc (near line 148) says an item whose run closed "is neither "No workflow" nor "Choose a workflow"": make it "is not "Choose a workflow" (a closed run is a decided item)".
- If `ANY_RUN` is now unused, delete it; if `paid` in the count statement's facts is now unused, delete it and its JSDoc. `pnpm lint` reports unused symbols.
- If any `facts` column (`closedRuns`, `paid`) was only there for `NO_WORKFLOW`, remove it from the count statement, the row type and the tests that read it. Keep `closedRuns` if `RunCounts.closed` still needs it for rows.

### 2c. Tests

- `test/integration/domain.test.ts`, `describe("Domain.orderIssues")`: the test titled "no_workflow: paid, open, no run and no ambiguous item" (near line 101) becomes "an order with no run and no ambiguous item has no issue" and asserts `[]` for `row(NONE)`; keep the other assertions in it that still hold (unpaid `[]`, open run `[]`, done run `[]`, choosing `["choose_workflow"]`). The closed-run test near line 110 still passes; retitle it if its title names No workflow.
- `test/integration/order-repository.test.ts`: the Issues-view test near line 471 lists `#1005` as No workflow; remove it from the expected names and from the comment near line 481. The counts near line 554: `issues: 5` becomes `4`. Check `checks.cut` (`issues: 1`, choosing `#1013`) is unchanged. The seed JSDoc near line 294 names `#1005`; reword to say it is Not started with no issue.
- `pnpm spec check` verifies the glossary's screen column equals `ORDER_ISSUE_LABEL`; both change in this step.
- `test/integration/rules-lint.test.ts` and `scripts/lib/rules-lint.ts`: check whether "No workflow" needs to be a retired word in screen copy. Recommendation: do not retire it; the order page still says "No workflows can start" for an unmatched item, which is a sentence, not the badge.

### 2d. E2E

- `e2e/fixture.ts` near line 503: order `#1010` ("Gift card", no tag) is seeded "for a No workflow badge in the Issues column". Keep the order (it still exercises Not started) and reword the comment: Not started with an empty Issues cell.
- `e2e/orders.spec.ts`: no assertion names "No workflow" (checked 2026-09-28). The count test "each view's count is what pressing it shows, given the team" expects `["Issues", 1]` for `#9501`, which is a Choose a workflow order; unchanged. Run the orders suite to confirm no count expectation depended on `#1010`.
- The orders index empty-state copy for Issues, "No open orders have issues." (near line 186), stands.

### 2e. Screens

- `src/routes/app.orders.index.tsx` JSDoc near line 114 ("Whether a not-started order is stuck is the Issues cell's to say"): now only partly true, since an unmatched order is Not started with an empty Issues cell. Reword: the Issues cell says when a not-started order waits on the merchant; an order whose items matched no workflow is Not started and shows nothing, on purpose, and `{@link Domain.OrderIssue}` says why.
- `issueBadges` JSDoc near line 137: tone mapping now has `team` and `blocked` critical, `choose_workflow` warning; the `Match.orElse` still returns warning. Leave the code, check the JSDoc words.
- The order page `src/routes/app.orders.$orderId.tsx` renders nothing from `ORDER_ISSUE_LABEL` (checked); no change.

## Step 3. Issues banner on Orders

### Why

With No workflow gone, every issue is something the merchant can clear in Baton, so a banner that stands while any open order has one is honest and goes away. It is on Orders only (research Q4), not dismissible, hidden while the Issues view is pressed, and its tone follows the worst issue present.

### 3a. Data: `Domain.OrderCounts` and `OrderRepository.listOrders`

The banner's tone needs to know whether any issue is critical (Needs a team or Blocked) rather than only Choose a workflow. `OrderCounts` carries `issues` but not its split.

- Add `criticalIssues: Schema.Number` to `OrderCounts` (`src/lib/Domain.ts` near line 2626): open orders with a `team` or `blocked` issue, given the team. Extend the JSDoc: it is for the Issues banner's tone, so critical stays rare enough to mean something; it is a subset of `issues`.
- `COUNT_FACT` in `OrderRepository.ts`: add `criticalIssues: "unstaffed or blockedRuns > 0"`. `COUNT_FACT` is `satisfies Record<keyof Domain.OrderCounts, string>`, so the compiler names every place that builds counts; add the sum to the count statement and the `Number(countRow?.[n] ?? 0)` read (near line 1318). `criticalIssues` is not a view, so `viewFilter` does not change.
- `test/integration/order-repository.test.ts` counts near line 554: add `criticalIssues` to both expected objects (open: unstaffed `#1004` plus any blocked orders in the seed; count them from the seed comments near line 380 and record the number under Deviations if it differs from what the seed comments say). Add `criticalIssues` to the `checks.out` view/count comparison only if that loop is generic over counts; it compares each view to its count, and `criticalIssues` has no view, so exclude it there.
- Integration test for the rule: in `describe("Domain.orderIssues")` or the repository counts test, a case titled "criticalIssues counts the open orders with a team or blocked issue".

### 3b. The banner: `src/routes/app.orders.index.tsx`

- Render after `<QuotaBanners usage={usage} />` and before `{syncButton(true)}`, so the quota banners (the app itself is stopped) come first.
- Condition: `data !== undefined && data.page.counts.issues > 0 && !(q === null && view === "issues")`. Read the issue count from `data.page.counts`; do not derive it from the visible rows, which are one page of one view.
- Markup:

  ```tsx
  <s-banner
    heading={issuesHeading(counts.issues)}
    tone={counts.criticalIssues > 0 ? "critical" : "warning"}
  >
    <s-button
      slot="secondary-actions"
      onClick={() => setFilters({ view: "issues", q: null })}
    >
      Show issues
    </s-button>
  </s-banner>
  ```

  `secondary-actions` is the banner's action slot (`refs/shopify-docs/docs/api/app-home/latest/web-components/feedback-and-status-indicators/banner.md`, "Create a banner with actions"). No `dismissible`.

- Heading copy: `1 open order has an issue` / `N open orders have issues`, `N` through `formatNumber`. Put the two forms in one small function beside `syncStatusText` with a JSDoc. No body text: the Issues column carries the breakdown by kind, and repeating it here would be the table said twice.
- Team select: counts honour the team (`Domain.OrderCounts` JSDoc), so the banner does too, and its count matches the Issues button's. Say so in the banner's JSDoc.
- JSDoc on the banner element or its helper, with the rules: stands while any open order has an issue; not dismissible, because dismissing hides a state that is still true and it would return on the next load; hidden on the Issues view, because the table below is that list; tone critical when any Needs a team or Blocked, otherwise warning, matching the badges; Orders only, not home, so that one screen owns it. Each rule in words, with its reason. The glossary word is "issue".
- `scripts/rules-lint.ts` refuses retired words in screen copy; "issue" and "order" are glossary words.

### 3c. Tests

`e2e/orders.spec.ts`, one new test titled "the Issues banner stands while any open order has an issue and goes with the Issues view":

1. Seed an order with a Choose a workflow issue (the pattern near line 715 does this with `#9401`).
2. On Orders, assert a banner with heading matching `/^\d+ open orders? ha(s|ve) (an )?issues?$/u` is visible and has `tone="warning"`.
3. Press the Show issues button in the banner; assert the URL search has `view=issues`, the Issues view is pressed (`aria-pressed`), and the banner is gone.
4. Press Open; assert the banner is back.
5. Optionally, with the team select set to a team with no issues, assert the banner is gone (counts honour the team).

A critical-tone case needs an unstaffed or blocked order; the count test near line 1106 seeds a team with a member, so reuse its shape with an empty team if a cheap seed exists (`seedMembers` with a team of no members gives `unstaffed`). If it is not cheap, record it under Deviations and leave the tone assertion to the integration test on `criticalIssues`.

### 3d. Inventory

`docs/page-banners-research.md` keeps an inventory of standing banners. Add a row for "Open orders have issues" (tone warning or critical, source `src/routes/app.orders.index.tsx`, page Orders). This is the one `docs/` edit in the plan; no JSDoc cites it.

## Step 4. Verification

Run, in this order, and paste each result into Deviations if it is not clean:

```bash
pnpm typecheck
pnpm lint
pnpm spec check
pnpm test
pnpm fmt
npm run test:e2e -- e2e/orders.spec.ts
npm run test:e2e -- e2e/member-runs.member.spec.ts
```

Then a manual check on the running app (`pnpm dev:start`, then `pnpm playwright-cli` headless, session `$(pnpm port)-testing`): open Orders, click the pressed view twice, and read `aria-pressed` on the native button inside the pressed `s-press-button` after the second click. It must be `"true"`. Do the same on the member Workflows list.

## Done when

- Both view rows are `s-press-button`, no `variant`, `tone`, `aria-pressed` host attribute or ", selected" suffix remains on them, and the e2e suites assert `aria-pressed`.
- `no_workflow` appears nowhere in `src/`, `test/` or `e2e/`; "No workflow" appears only in the `ProductionState` JSDoc, the order-page sentence "No workflows can start", and comments that say an unmatched order is Not started.
- The Issues banner renders on Orders under the conditions in 3b, with the e2e test in 3c passing.
- Every JSDoc listed above says the new rule with its reason, and `pnpm spec check` passes.

## Deviations and issues

Record here anything that differed from this plan: a line number that moved, a symbol that was renamed, a test that needed a different seed, a step skipped and why, an e2e failure with its output. One bullet per item, dated, with the file and what was done instead.

- 2026-09-28, `e2e/orders.spec.ts`: the self-toggle check is a `test.step` titled "pressing the pressed view keeps it pressed" inside the search test, since a step inside a test cannot be a test title of its own.
- 2026-09-28, `e2e/orders.spec.ts`: the critical tone was cheap to seed (a workflow whose task is on a team with no members), so the banner test covers both tones through the team select instead of leaving critical to the integration test.
- 2026-09-28, `src/lib/Domain.ts`: the `OrdersIndexView` JSDoc also named No workflow ("no workflow is never making or made"); reworded to drop it.
- 2026-09-28, `src/lib/OrderRepository.ts`: `ANY_RUN`, the `paid` fact and the `closedRuns` fact in the count statement were only there for `NO_WORKFLOW` and are deleted. `RunCounts.closed` for rows comes from `runRows`, unchanged.
- 2026-09-28, 1d: the member route states the element and guard briefly and names the orders index's `viewButton` as holding the rule; `{@link}` cannot reach a const inside a component.
- 2026-09-28, step 4 manual check: not run by hand. The orders e2e step presses the pressed Open view and asserts `aria-pressed="true"` on the native button; on the member Workflows list, `selectView` now asserts `aria-pressed` after every switch, including presses of the already-pressed default view. Both suites pass (17 and 26).
- 2026-09-28, review: `RunCounts.closed` (`src/lib/Domain.ts`, `OrderRepository.listOrders` run rows) had no reader once `no_workflow` went, and its rewritten JSDoc claimed `ambiguousItems` and the order page read it, which they do not (both read run rows). Cut the field from the schema, `runCounts`, the per-page run query and the three tests that asserted it; the `RunCounts` JSDoc now says closed runs are not counted and where the closed-run rules live. The domain test "an item whose run closed is decided and is no issue" went with it, since `orderIssues` can no longer see a closed run; `#1010` in `order-repository.test.ts` still pins the rule.
- 2026-09-28, review: the `OrdersIndexView` JSDoc's "most cells could never be anything but zero" made exact again: four of the nine cells (three issues crossed with three positions).
- 2026-09-28, review: typecheck, lint, spec check, 501 unit tests, fmt, and the orders (18) and member-runs (25) e2e suites all pass.

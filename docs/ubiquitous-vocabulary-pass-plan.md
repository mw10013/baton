# Ubiquitous vocabulary pass: implementation plan

For an implementing LLM. The decisions are in
`docs/ubiquitous-vocabulary-routes-and-screens-research.md` (Decisions
section, seven items). Read that file first. This plan is how to land it.

## What this pass does, in one paragraph

The member side of the app gets the same noun the merchant side already
uses for a run: the item's workflow. The member's list is headed
"Workflows" at `/shop/$shop/workflows`, its rows lead with the item and
the workflow name, and each row opens `/shop/$shop/workflows/$runId`, a
page headed by the item. The glossary in `src/lib/Domain.ts` gains a
Screens table naming every screen, and a list of which vocabulary tier
each kind of site speaks. Every JSDoc, test and e2e comment that said
"run list" or "work page" says the Screens-table name instead. No
identifier is renamed and no storage changes.

## Ground rules

From `AGENTS.md`, restated because each one bites here:

- Do not commit. Do not branch. Work on `main`.
- No migrations, no storage changes. None are needed.
- `pnpm typecheck && pnpm lint && pnpm test` green at the end of every
  stage. `npm run test:e2e --` at the end of Stage 4 and Stage 6.
  `pnpm fmt` repo-wide at the end and keep every file it touches.
- Rules stay on the symbol that owns them. Predicates, never inline
  comparisons. A JSDoc never references `docs/`.
- Plain prose in JSDoc, comments and copy. No flourishes.
- The glossary in `src/lib/Domain.ts` is the vocabulary. When this plan
  and the glossary disagree after Stage 1, the glossary wins; record the
  disagreement under Deviations.
- `scripts/rules-lint.ts` refuses "run", "line item", "finished", "in
  progress", "mark done", "unclaimed" in string literals and JSX text.
  "Workflows — Baton", "Finishing workflow", "#1001" all pass. If a new
  string trips it, the string is wrong, not the lint.
- `src/routeTree.gen.ts` and `worker-configuration.d.ts` are generated.
  Do not hand-edit them. The route tree regenerates when `pnpm dev` or
  `pnpm typecheck` runs.
- Chrome DevTools MCP (`.mcp.json`, `chrome-devtools`) is available:
  after Stage 4, open the member's workflows list and workflow page and
  the merchant's order page and read the words as a person would. Start
  the app with `pnpm app:dev`, get the port with `pnpm port`, seed with
  `pnpm seed`, wait for `body[data-hydrated="true"]` before clicking. The
  member area needs a magic-link sign-in; `e2e/member.ts` `signIn` shows
  how the tests do it, and `pnpm playwright-cli --headed` is the way to
  do it by hand if the MCP session has no cookie.

## Stage 0: baseline

Run `pnpm typecheck && pnpm lint && pnpm test`. Record anything already
failing under Issues so it is not blamed on this work. Read, whole, the
Glossary block at the top of `src/lib/Domain.ts`, `scripts/lib/action-table.ts`
from `checkGlossary` to the end, `src/routes/shop.$shop.tsx`,
`src/routes/shop.$shop.index.tsx`, `src/routes/shop.$shop.work.$runId.tsx`
and `src/components/MemberBar.tsx`.

## Stage 1: the glossary

Everything later leans on this. Nothing on a screen changes in this stage.

### 1a. The run row

In the Nouns table of the Glossary block, replace the `run` row's screen
cell. Today:

```
| run      | one item going through one workflow                      | `Run`                           | (none): the merchant sees the item's workflow, the member work |
```

After:

```
| run      | one item going through one workflow                      | `Run`                           | the item's workflow, on both sides; never bare, never "run"   |
```

Add one sentence to the paragraph under the Nouns table, after the
sentence that ends `refuses "run", "line item" and the other retired
words in screen strings.`:

> The run's screen word is "workflow" with the item beside it ("Brass
> hinge ×2 · Finishing", "Finishing workflow · #1001"). Bare "workflow"
> is the definition, which only the merchant's Workflows pages show.

### 1b. The Screens table

Add a new paragraph and table to the Glossary block, after the Verbs
table (it is the last table today). The paragraph's first line must
start with `Screens.` because `glossaryTables` in
`scripts/lib/action-table.ts` names a table by the first line of the
paragraph before it.

```
 * Screens. A JSDoc, a test or a research doc names a screen by its spec
 * name, never by its route segment and never with "run". The heading is
 * what the person sees on the page. Two screens share the spec name
 * "workflow page", one per side; a JSDoc that mentions both sides
 * qualifies with "the merchant's" or "the member's".
 *
 * | side     | route file                        | heading                      | spec name                   |
 * | -------- | --------------------------------- | ---------------------------- | --------------------------- |
 * | merchant | `app.index`                       | Baton                        | the home page               |
 * | merchant | `app.orders.index`                | Orders                       | the orders index            |
 * | merchant | `app.orders.$orderId`             | the order's name             | the order page              |
 * | merchant | `app.workflows.index`             | Workflows                    | the workflows index         |
 * | merchant | `app.workflows.$workflowId`       | the workflow's name          | the workflow page           |
 * | merchant | `app.workflows.$workflowId_.edit` | the workflow's name          | the workflow editor         |
 * | merchant | `app.teams.index`                 | Teams                        | the teams index             |
 * | merchant | `app.teams.$teamId`               | the team's name              | the team page               |
 * | merchant | `app.members`                     | Members                      | the members page            |
 * | member   | `shop.index`                      | Your shops                   | the shop picker             |
 * | member   | `shop.$shop.workflows.index`      | Workflows                    | the workflows list          |
 * | member   | `shop.$shop.workflows.$runId`     | the item's title             | the workflow page           |
 * | member   | `shop.$shop_.lapsed`              | Subscription inactive        | the lapsed page             |
```

The route file cells are backticked, so `checkGlossary` will require
each to occur as a word elsewhere in `Domain.ts`. They will not, because
route files are not identifiers. Handle this in 1d.

### 1c. The tier list

Add to the header JSDoc at the very top of `Domain.ts` (the one starting
"The domain vocabulary, and the one place a behavioural rule is written
down."), as a new bullet after the last one:

```
 * - Which tier a site speaks. Identifiers, types, callables, route
 *   parameters (`$runId`), log messages, JSDoc, tests and research speak
 *   the domain tier: "run" is the word there. Route segments, string
 *   literals, JSX text, headings and labels speak the screen tier: the
 *   glossary's screen columns, and `scripts/rules-lint.ts` refuses the
 *   retired words in them. A JSDoc that explains copy quotes the copy.
 *   A JSDoc that names a screen uses the Screens table's spec name.
```

### 1d. The check

In `scripts/lib/action-table.ts`:

- `checkGlossary` currently reads every backticked identifier-shaped
  word in the Glossary block and requires it elsewhere in the source.
  Route file names contain `.` and `$`, so the identifier regex
  `/^[A-Za-z_][A-Za-z0-9_]*$/u` already excludes them. Verify that with a
  run of `pnpm action-table check` after 1b; if any Screens cell is
  reported missing, that cell is wrong.
- Add `checkScreens(source, routeFiles)`: for each row of the table whose
  intro starts with `Screens.`, the `route file` cell plus `.tsx` must be
  in `routeFiles`. Report `Glossary: Screens: no route file <name>` for
  each miss, and `Glossary: Screens: <file> has no row` for each
  `app.*`, `shop.*` route file under `src/routes/` that renders an
  `s-page` and has no row. Exclude `app.tsx`, `shop.tsx`, `shop.$shop.tsx`
  (layouts), `app.orders.tsx` and `app.workflows.tsx` (layouts with an
  `Outlet`), and
  `app.orders.from-shopify.tsx` (a redirect) and the new
  `shop.$shop.index.tsx` (a redirect). There is no `app.teams.tsx`.
  `admin.*`, `auth.*`,
  `webhooks.*`, `login*`, `privacy`, `index` are not merchant or member
  screens and are out of scope.
- Wire it into the `check` command in `scripts/action-table.ts`, reading
  the file list with `readdirSync` on `src/routes`.
- Add a test in `test/integration/action-table.test.ts` titled "every screen a merchant or
  member uses has a Screens row, and every row's route file exists".

Do not add heading verification. Headings are the person's words and
several are dynamic (the order's name); a check would have to special-case
them. Record under Deviations if you find a cheap way.

### 1e. Gate

`pnpm typecheck && pnpm lint && pnpm test`. `pnpm action-table check`
will fail on `shop.$shop.workflows.index` and `shop.$shop.workflows.$runId`
not existing yet, and on `shop.$shop.index` and `shop.$shop.work.$runId`
having no row. That is expected until Stage 2. Either land Stage 2 before
running the gate, or run the gate and record the two expected failures.
Do not add rows for the old files.

## Stage 2: routes

### 2a. Rename

- `git mv src/routes/shop.$shop.work.$runId.tsx src/routes/shop.$shop.workflows.$runId.tsx`.
  Change `createFileRoute("/shop/$shop/work/$runId")` to
  `createFileRoute("/shop/$shop/workflows/$runId")`. The `routeTree.gen.ts`
  regenerates on the next `pnpm typecheck`.
- `git mv src/routes/shop.$shop.index.tsx src/routes/shop.$shop.workflows.index.tsx`.
  Change `createFileRoute("/shop/$shop/")` to
  `createFileRoute("/shop/$shop/workflows/")`.
- Create a new `src/routes/shop.$shop.index.tsx` that only redirects:

```ts
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The shop root is the member's home, and home is the workflows list.
 * A redirect rather than the list itself so the URL a member reads
 * says the noun (`/shop/$shop/workflows`). The search (`MemberSearch`
 * in `shop.$shop.tsx`) is carried across, so a bookmarked
 * `/shop/x?tab=blocked` still lands on Blocked.
 */
export const Route = createFileRoute("/shop/$shop/")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/shop/$shop/workflows",
      params,
      search,
    });
  },
});
```

Check `refs/tan-router/docs/` for the current `redirect` signature and
whether `search` passes through as an object; the pattern is in
`src/lib/MemberAccess.ts` (`redirect({ to: "/shop/$shop/lapsed", ... })`).

### 2b. Every link

- `src/routes/shop.$shop.workflows.index.tsx`: `workLocation` builds
  `{ to: "/shop/$shop/work/$runId", ... }`. Change the path. Rename the
  helper to `workflowLocation`; it is a local const, not a domain
  identifier, and the old name will read wrong beside the new path.
- `src/components/MemberBar.tsx`: the mark's `<Link to="/shop/$shop">`
  can stay (the redirect carries the search), but a link that redirects
  is one hop more than a link that lands. Change it to
  `to="/shop/$shop/workflows"`. Update its JSDoc ("The mark is home. The
  link around it goes to `/shop/$shop`, the run list") to name the
  workflows list.
- `src/routes/shop.index.tsx`: `<Link to="/shop/$shop">` on the shop
  picker. Same change, same reason.
- `src/lib/MemberAccess.ts`: the lapsed redirect is unaffected.
- `src/lib/Domain.ts` lines that name the path: the JSDoc on
  `RunLoaderData` (`/shop/$shop/work/$runId (shop.$shop.work.$runId)`)
  and on `RunView` ("Everything `/shop/$shop/work/$runId` renders").
  Change both paths and file names.
- `grep -rn "shop/\$shop/work\|shop\.\$shop\.work\|\"/shop/\$shop\"" src test e2e scripts`
  until it returns nothing but this plan.

### 2c. e2e paths

`e2e/*.ts` navigate with template strings like
`` `/shop/${config.shop}?tab=upNext` ``. Every one that expects to land
on the list becomes `` `/shop/${config.shop}/workflows?tab=upNext` ``.
`gotoMember(page, path)` in `e2e/member.ts` takes the path, so each
caller's path changes; the helper's own JSDoc mentions `/shop/$shop` and
is updated too. A test that asserts the URL after sign-in
(`e2e/member-area.member.spec.ts`, "lands on their run list") expects
`/shop/<shop>$` today and must expect `/shop/<shop>/workflows` after.
Keep one test that visits bare `/shop/<shop>?tab=blocked` and asserts it
lands on `/shop/<shop>/workflows?tab=blocked`: that is the redirect's
test, titled "the shop root redirects to the workflows list and keeps the
search".

### 2d. Gate

`pnpm typecheck && pnpm lint && pnpm test && pnpm action-table check`.

## Stage 3: the member screens

### 3a. The workflows list

In `src/routes/shop.$shop.workflows.index.tsx`:

- `head`: `title: "Workflows — Baton"`.
- The `s-section accessibilityLabel="Work"` becomes
  `accessibilityLabel="Workflows"`. The comment above it that says "The
  document title says "Work"" is rewritten to say the heading is the
  rows' noun. `e2e/member-area.member.spec.ts` locates
  `s-section[accessibilityLabel="Work"]` three times; change those.
- The page renders no visible heading, on purpose: the comment above
  `<s-page inlineSize="small">` says the tab strip is the heading and a
  bench tablet has no room for another. Keep that. The word lives in the
  document title and the section's accessibility label. Rewrite that
  comment so it says "Workflows" where it says "Work" and keeps its
  reasoning.

### 3b. The row

In `renderItem`, line one today is

```tsx
<s-text color="subdued">{run.orderName}</s-text>
<s-text type="strong">{run.lineItemTitle}</s-text>
```

After: item first and strong, the workflow name, then the order subdued.

```tsx
<s-text type="strong">{run.lineItemTitle}</s-text>
<s-text color="subdued">{`${run.workflowName} · ${run.orderName}`}</s-text>
```

`RunListRun` in `Domain.ts` is `Run` with a list of fields omitted, and
`workflowName` is in that omit list. Remove it from the list. Then read
`RunRepository.listRuns` and its SQL: if the row query names columns
rather than `select *`, add `workflow_name` (or whatever the column is;
read the `create table` in `ShopAgent.ts`). The `RunListView` decode will
fail loudly if the column is missing, so `pnpm test` catches it.

The row's `accessibilityLabel` is `` `Open ${run.orderName}` ``. Change it
to `` `Open ${run.lineItemTitle} on ${run.orderName}` ``; the e2e helper
`rowLink` in `e2e/member-runs.member.spec.ts` and the `ORDER_LINK` regex
`/^Open #94\d\d$/u` match the old label and must change with it. The
Recent tab's `renderDone` and the closed-run rows use the same label
shape; change all of them the same way.

Update the JSDoc on `renderItem` ("Line one is the order, the item's
title and the quantity badge") to say line one is the item, then its
workflow and order.

### 3c. The workflow page

In `src/routes/shop.$shop.workflows.$runId.tsx`:

- `<s-page heading={run.orderName}>` becomes `heading={run.lineItemTitle}`.
- `head` title: `` `${loaderData?.view?.run.lineItemTitle ?? "Not found"} — Baton` ``.
- Directly under the heading, before `SocketBanner`, one subdued line:
  `` `${run.workflowName} workflow · ${run.orderName}` ``. The comment
  above the item block says "No workflow name or age, because a member
  cannot act on either"; that reasoning is withdrawn by the research
  (the name is what lets the member and merchant talk about one thing).
  Rewrite the comment: the workflow name is the noun both sides share,
  and the order is the qualifier.
- `RunItem` still renders the item line (title, variant, quantity, SKU,
  properties) below. The heading now repeats the title. Keep `RunItem`
  as is: the variant, quantity and SKU are what a maker reads, and the
  heading is a title. If it reads as a duplicate on screen (Stage 4),
  drop the title from `RunItem` on this page only and record it.

### 3d. Gate

`pnpm typecheck && pnpm lint && pnpm test`.

## Stage 4: look at it

Start the app (`pnpm app:dev`, `pnpm seed`). With Chrome DevTools MCP or
`pnpm playwright-cli --headed`, sign in as `m1@m.com` (see `e2e/fixture.ts`
for personas) and:

- Land on `/shop/<shop>`: it must arrive at `/shop/<shop>/workflows`.
- The tab title says "Workflows — Baton". Each row reads item, then
  workflow and order.
- Open a row. The heading is the item title, the line under it is
  "<workflow> workflow · #<order>". Steps and tasks below.
- Open the merchant's order page for the same order in the embedded app
  and confirm the item card's drawer says "<workflow> workflow": the two
  screens now say the same thing about the same run.
- Bookmark-style: visit `/shop/<shop>?tab=blocked&team=<id>` and confirm
  the redirect keeps both.

Then `npm run test:e2e --`. Fix what fails; record anything you changed
on the screens because of what you saw.

## Stage 5: align the JSDocs

This is the sweep. It is mechanical but it is most of the diff.

### 5a. The two phrases

```
grep -rn "run list\|work page\|runs page\|work list" src test e2e scripts
```

Every hit becomes the Screens-table name:

- "the run list", "the member's run list", "a run list" → "the workflows
  list" (or "the member's workflows list" where the merchant side is
  also in the sentence).
- "the work page" → "the workflow page" (or "the member's workflow page"
  where the merchant's workflow page could be meant; a merchant-side
  JSDoc that already says "the workflow page" for
  `app.workflows.$workflowId` keeps it).

Counts at the time of writing, so you know the size: `Domain.ts` ~20,
`shop.$shop.workflows.index.tsx` ~13, `e2e/fixture.ts` ~13,
`e2e/member-runs.member.spec.ts` ~31, `ShopAgent.ts` 8,
`test/integration/member-area.test.ts` 6, `run-repository.test.ts` 5,
`currentWhere.ts` 5, `styles.css` 4, `shop.$shop.tsx` 4,
`RunRepository.ts` 4, and single digits in `member-runs-socket.test.ts`,
`app.orders.$orderId.tsx`, `ShopAgentClient.ts`, `MemberBar.tsx`,
`member-area.member.spec.ts`, `order-repository.test.ts`, `RunSteps.tsx`,
`MemberRun.tsx`.

Do not touch identifiers: `RunListView`, `RunListItem`, `RunListRun`,
`RunListTask`, `RunListLoaderData`, `listRuns`, `runTabs.ts`,
`useMemberRunActions`, `MemberRun.tsx`, `.run-detail-line`, `.member-work`
are domain tier and stay. A CSS class is an identifier.

A sentence that changes meaning when the phrase is swapped (rare: "the
run list carries the age" is still true of the workflows list) is
rewritten, not word-swapped. Read each hit.

### 5b. Test titles

Test titles are the rules in plain words. A title that says "run list"
or "work page" is renamed with its sentence. `grep -rn "test(\"\|it(\"" test e2e | grep -i "run list\|work page"`.

### 5c. The taskActions JSDoc

The paragraph that started this ("A task offers the same verbs on the
run list and the work page, and no verb is styled as primary") becomes:

```
 * A task offers the same verbs on the workflows list and the workflow
 * page, and no verb is styled as primary. Primary belongs to the page,
 * not to a task: a step can have two current tasks, and Polaris allows
 * one primary button per card.
```

The paragraph after it (about the blocker) was already rewritten and
stays.

### 5d. Glossary consistency

The glossary's Nouns paragraph says the member's row is
`<order> · <item>`. After 3b it is item first. Rewrite that sentence:

> An item is always shown under its order on the merchant's order page,
> and beside it in the member's row (`<item> · <workflow> · <order>`), so
> the order carries the disambiguation and the word stays short.

### 5e. Gate

`pnpm typecheck && pnpm lint && pnpm test && pnpm action-table check`.
`grep -rn "run list\|work page" src test e2e scripts` returns nothing.

## Stage 6: AGENTS.md, fmt, final gate

- `AGENTS.md`, first bullet list: add one bullet after the glossary
  bullet: "The Screens table in the glossary names every merchant and
  member screen; a JSDoc, test or research doc uses that name, never the
  route segment and never "run". `pnpm action-table check` verifies each
  row's route file exists."
- `AGENTS.md`, Playwright section, the example that opens the member
  area, if any path in it changed.
- `pnpm fmt`. Keep every file it touches.
- `pnpm typecheck && pnpm lint && pnpm test && npm run test:e2e --`.
- Delete `docs/ubiquitous-vocabulary-routes-and-screens-research.md` and
  this plan only when the user says so. They will.

## Deviations

Record here anything done differently from this plan, with the reason.
One bullet each. Empty means the plan was followed exactly.

- Screens table, lapsed row: the heading cell is "the shop's domain", not
  "Subscription inactive". The `s-page` heading is `shop`; "Subscription
  inactive" is the section heading and the document title.
- `checkScreens` takes `routeFiles` as file name → source, not a name list,
  and defines a screen as an `app.*`/`shop.*` file that renders `<s-page`
  and no `<Outlet`. That makes the exclusion list unnecessary: the layouts
  and redirects the plan listed are excluded by the rule, including
  `shop.$shop.tsx`, whose not-found `s-page` belongs to the layout. The
  test reads the route files with `import.meta.glob` because the workers
  pool has no `readdirSync`.
- `login-callback.tsx` redirects a one-shop member to
  `/shop/$shop/workflows` directly (the plan listed the bar and the picker
  links only); same reason, one hop fewer.
- The shop-root redirect's rule test is in e2e as planned; the integration
  tests in `member-area.test.ts` that fetched `/shop/<shop>` now fetch
  `/shop/<shop>/workflows` and `/shop/<shop>/workflows/none`.
- The row's `Open <item> on <order>` label broke every e2e locator that
  found a row by exact order text. `rowLink` now matches
  `^Open .+ on <order>$`, `getByText(<ORDER>, { exact: true })` became
  `rowLink(...)`, and workflow-page heading assertions use new `*_ITEM`
  constants.
- Stage 4: the heading repeated the item line ("Rush gift wrap" over
  "Rush gift wrap ×1"). `RunItem` is used only on the member's workflow
  page, so it dropped the title there and reads "<variant> · Quantity n"
  or "Quantity n". A bare "×1" read orphaned; "Quantity" is the word the
  quantity badge already uses. `itemLabel` lost its only caller and was
  removed.
- Workflow page not-found copy: "This work is not on one of your teams"
  became "This workflow is not on one of your teams".
- 5c: the `taskActions` paragraph had already been rewritten since the plan
  ("...and neither screen styles one as primary."); only the screen names
  changed.
- Sweep extras: "work list(s)" in `Domain.ts` and one e2e test title
  became "Mine, Up next, Teammates and Blocked"; the order page's "run
  list" (its list of runs, domain tier) became "runs"; the
  "Invalid run list row" decode message became "Invalid RunListRun row";
  merchant-side mentions qualify as "the member's workflows list/workflow
  page"; `app.workflows.tsx` and `app.orders.tsx` said "workflows list" and
  "orders list" for merchant screens and now say "workflows index" and
  "orders index". Line-wrapped "run / list" and "work / page" were found
  and fixed separately.
- Review (second pass): the Recent tab's closed-run row still read
  `<order> · <item>`, and the done-task row put the order before the task.
  Both now name the run as every row does: the closed row is `<item>`,
  `<workflow> · <order>`; the done row is `<task>`, `<item> · <workflow> ·
<order>`, with "by <who> at <time>" on line two. Their JSDocs say so.
- Review: the glossary sentence "Bare "workflow" is the definition, which
  only the merchant's Workflows pages show" contradicted the member's list
  heading "Workflows". Rewritten: a bare workflow name is the definition on
  the merchant's pages; the member's list never shows a definition and every
  row names its item.
- Review: the `/shop/$shop` layout JSDoc still said the landing content lives
  in the index route; it now says the index redirects to the workflows list.
- Review: merchant-side "orders list" / "workflows list" in two e2e titles,
  `app.tsx`, `app.orders.tsx` and `ShopAgent.removeWorkflow` now say "orders
  index" / "workflows index", the Screens-table names.

## Issues

Record here anything found that this plan does not cover: a failing test
at baseline, a screen that reads wrong after Stage 4, a phrase the sweep
could not translate, a check that could not be written as specified. One
bullet each, with the file and what you did or did not do about it.

- Baseline was green (typecheck, lint, 479 tests).
- Seed data named most workflows after their product, so rows read
  "Leather journal Leather journal · #1003". Closed: the fixture's workflows
  (`e2e/fixture.ts`) are now named after the process ("Stamp and bind"),
  products keep their names, and the fixture's JSDoc says why. No screen rule
  hides a workflow name equal to the item title: a merchant who names them
  the same sees the repeat, which is what they typed.
- The merchant's order page was checked in source, not in the browser
  (the embedded app needs the Shopify admin): the item card reads
  "<workflow> workflow", matching the member page's line.
- The Recent tab's done-task row still leads with the task name and puts
  the order before it; only its accessibility label changed.
- `BlockModal` asked "Block #<order>?". Closed: it asks "Block <item> on
  <order>?", the run as the member's row names it, on both sides; the order
  page's stand-in for a run that left under an open modal says "this item".
- Lint: the `checkScreenColumns` helpers and the pre-existing nine warnings
  (test helpers not capturing scope, `continue`, `replace` with a global
  regex, `${` in plain strings that are lint fixtures) are fixed or, for the
  fixtures and `Effect.forEach`, disabled on the line with the reason.
  `pnpm lint` reports zero warnings.
- The workflows list's "to see work." (not-on-a-team copy) was left as is.

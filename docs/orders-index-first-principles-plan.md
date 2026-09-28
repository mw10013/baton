# The orders index: implementation plan

Implementation plan for `docs/orders-index-first-principles-research.md`. Every question there is decided (its section 6). Read the research first, sections 3, 4, 8, 9 and 10 in particular: the reasoning there has to end up inline in JSDoc, because the research doc will be deleted.

Written 2026-09-28 for an LLM agent. Work in this worktree on its branch. Do not commit unless told. After each step: `pnpm typecheck && pnpm lint && pnpm test`. At the end: `pnpm fmt`, keep every file it touches. Record anything that did not go as written in section 16 of this file.

## 1. What this delivers

Words, once. A **view** is one whole question about a list, chosen by pressing its button; exactly one is pressed; each carries a count. The **view row** is the line the buttons sit on. Two screens have one: the member's workflows list (Mine · Up next · Teammates · Blocked · Recent) and the merchant's orders index (after this change: Open · Issues · Not started · Making · Made · Fulfilled · All). A **filter** narrows within the chosen view and combines with the others: the order-number search and the team select. Nothing on screen says "view" or "filter"; the buttons say their labels. "Tab" means a browser tab and nothing else.

1. **One view row** on the orders index, no label to its left: Open · Issues · Not started · Making · Made · Fulfilled · All. Open is the default. Each view is one whole predicate; nothing crosses. The Status row, the Needs row, the "Anything" button, and the show-and-hide under Fulfilled are gone.
2. **Counts** on Open, Issues, Not started, Making and Made, narrowed by the team select and by nothing else. Fulfilled and All stay uncounted.
3. **Two badge columns**: **Status** (one position badge) and **Issues** (zero or more issue badges). The Production column is gone.
4. **Search ignores the view and the team.** A number in the field searches every stored order; the view buttons show unpressed while a search is on; pressing a view clears the search.
5. **The word is issue.** `OrderNeed` becomes `OrderIssue`, `orderNeeds` becomes `orderIssues`, `OrderRow.attention` becomes `unstaffed`, and the labels move into `Domain.ts` as checked constants.
6. **The first rung is Not started.** `ProductionState` literal `to_make` becomes `not_started`; its label is "Not started". The derivation and the SQL are unchanged in meaning.
7. **The word is view, on both screens.** The member side renames `RunTab` and everything around it; "tab" is retired from screen copy. The seven `*View` read structs lose the suffix so "view" means one thing in the code.
8. **Two glossary tables** (Order positions, Order issues) with screen columns that `pnpm spec check` compares against `PRODUCTION_STATE_LABEL` and `ORDER_ISSUE_LABEL`, and one new Nouns row for "view".
9. **JSDoc across `Domain`, `OrderRepository`, `RunRepository`, `ShopAgent`, the routes, the components, the e2e fixture and the tests** aligned so no sentence says need, Needs row, Anything, Status row, Production column, to make, cross-count, or tab (for anything that is not a browser tab).

Nothing in this plan changes stored data. No schema edit, no state reset.

## 2. Decisions this plan makes beyond the research

The research settled the model and the words; these are the calls needed to write code. They are the plan's, not the user's. List any you change in section 16.

- **The orders index's view literal is `OrdersIndexView`**, replacing `OrdersStatus`: `Schema.Union([Schema.Literal("issues"), ProductionState, Schema.Literal("all")])`. `null` is Open (the default, `orderIsOpen`). `"cancelled"` stays a legal value with no button, as today (research Q7).
- **The URL key is `?view=`** on both screens: it replaces `?status=` and `?need=` on the orders index and `?tab=` on the member's workflows list. Nothing links with `?status=` or `?need=` today (the team page drills in with `?team=` only). A member's bookmarked `?tab=` is an unknown key and reads as the default view, Mine.
- **Search ignores view and team in the repository, not the route.** `ListOrdersInput` states the rule on `q`: when `q` is not null the read is over every stored order and `view` and `team` are ignored. The route keeps `view` in the URL while searching, so clearing the field returns to the view the merchant was on; it renders every view unpressed while `q` is set; pressing a view writes `{ view, q: null }`. Counts are always narrowed by `team` and never by `q`.
- **The team select is always shown.** Under Fulfilled it can only match nothing (a closed order waits on no team, `OrderRow.waitingOn`); that reads as an empty list with the empty text, which is better than a control that disappears. Under All it narrows to open orders waiting on that team, which is meaningful.
- **`OrderCounts` becomes `{ open, issues, not_started, making, made }`**, all over open orders, narrowed by team. `open` is the sum of the other three positions. The rule on the symbol: **a count is what pressing that view would show, given the team.**
- **The Issues view predicate** is `OPEN and (NO_WORKFLOW or CHOOSING or <team gap> or exists BLOCKED_RUN)`, the four `orderIssues` elements or'd, restated in SQL beside them.
- **`ORDERS_INDEX_VIEW_LABEL`** lives in `Domain.ts` beside the other label constants: the five `PRODUCTION_STATE_LABEL` entries plus `open: "Open"`, `issues: "Issues"`, `all: "All"`. It is not a glossary table (Open and All are scopes, not words with a rule); the two glossary tables cover the words. The route reads it and never spells a label.
- **`ORDER_ISSUE_LABEL`** is `{ no_workflow: "No workflow", choose_workflow: "Choose a workflow", team: "Needs a team", blocked: "Blocked" }`. The badge labels do not change.
- **Empty text per view**, one line each: Open "No open orders."; Issues "No open orders have issues."; Not started "No open orders are waiting to start."; Making "Nothing is being made."; Made "No orders are made and waiting to be fulfilled."; Fulfilled "No orders have been fulfilled yet."; All "No orders stored."; with a team selected, "No orders match these filters."; under a search, the existing "No order matches <number>" heading.
- **The Issues cell has no placeholder** when empty, for the reason already on the Waiting on cell: emptiness is the point.
- **Member-side names**: `RunTab` → `WorkflowsListView`, `DEFAULT_RUN_TAB` → `DEFAULT_WORKFLOWS_LIST_VIEW`, `RunQuery.tab` → `RunQuery.view`, `src/lib/runTabs.ts` → `src/lib/workflowsListViews.ts` with `VIEWS`, `VIEW_LABEL`, `VIEW_EMPTY`, CSS class `.run-strip-tabs` → `.run-view-row`, the word "strip" → "view row". `RunTier` stays. The five keys (`mine`, `upNext`, `teammates`, `blocked`, `done`) stay.
- **Struct renames** (research 10f): `OrdersView` → `OrdersIndexData`, `OrderDetailView` → `OrderPageData`, `WorkflowDetailView` → `WorkflowPageData`, `WorkflowDraftView` → `WorkflowDraftDetail`, `RunListView` → `WorkflowsListData`, `RunView` → `RunPageData`, `RunTaskView` → `RunTaskRow`, `runTaskViews` → `runTaskRows`. `OrdersIndexLoaderData` stays, its field `view` → `orders`. The repository callable `getRunView` (`RunRepository.ts`, called from `ShopAgent.ts`) becomes `getRunPage`.
- **"tab" becomes a retired word** in `scripts/lib/rules-lint.ts` (`/\btabs?\b/iu`). The lint reads string literals and JSX text, so JSDoc about browser tabs is untouched. `e2e/orders.spec.ts` line 1188 ("open-in-new-tab") is a comment and stays.

## 3. What this does not change

`productionState`'s branches and `orderIssues`' rules (only the names), the order page (it reads `productionState` for the Made banner and `LineItemState` for everything else; only the literal rename touches it), the home page, the sync button and banners, pagination and the keyset cursor, the team drill-in, the member's workflows list's behaviour (its five views keep their keys, order, counts, empty texts and depth), `RunCounts`, `RunTier`, `OrdersIndexData.teams`, seeds, billing.

## 4. Prerequisites

- `pnpm port` gives the dev port. E2E runs headless with `npm run test:e2e --`.
- To look at the page use the Chrome DevTools MCP (`navigate_page`, `take_snapshot`, `take_screenshot`, `click`) or `pnpm playwright-cli --session="$(pnpm port)-orders" open ...`. Wait for `body[data-hydrated="true"]` before interacting.
- `pnpm seed` seeds a shop with one order per state; the e2e fixture (`e2e/fixture.ts`) seeds the same set for the specs.

## 5. Target render

```
[ Order number            ]

[Open · 35] [Issues · 5] [Not started · 5] [Making · 30] [Made · 0] [Fulfilled] [All]

Team  [Any team           ⌃]

Order   Placed           Payment  Status       Issues             Waiting on  Items  Shopify
#9605   Sep 28, 1:13 AM  Paid     Making                          Bench       2      View in Shopify
#1575   Sep 22, 3:26 AM  Paid     Not started  No workflow                    1      View in Shopify
#1561   Sep 4, 8:57 PM   Paid     Making       Needs a team                   3      View in Shopify
#1402   Aug 30, 2:10 PM  Paid     Made                                        1      Fulfil in Shopify
```

Rules the render follows:

- Every view is an `s-press-button`; `pressed` is the selected one, Open when nothing is in the URL, none while `q` is set. No red on the view row.
- A counted view always renders with its number, at zero if need be. Fulfilled and All are bare labels.
- The Status cell is one badge from `PRODUCTION_STATE_LABEL` with today's tones (Not started neutral, Making info, Made success, Fulfilled neutral, Cancelled critical). The Issues cell is one badge per `orderIssues` element in that order, `team` and `blocked` critical, the rest warning.
- The view row and the team select share the grid so "Team" lines up under the view row's left edge; the view row's left cell is empty.

## 6. Step 1. Member side: tab becomes view, structs lose `View`

A rename with no behaviour change, done first so every later step is written in the settled words. The compiler finds every site.

1. `Domain.ts`: `RunTab` → `WorkflowsListView`, `DEFAULT_RUN_TAB` → `DEFAULT_WORKFLOWS_LIST_VIEW`, `RunQuery.tab` → `view`. Rewrite the `WorkflowsListView` JSDoc: the five views of the member's workflows list, in view-row order; four are the tiers of `tierOf`; `done` is the Recent window; the view is the unit of a read. Say why the word is view: it is Shopify's word for the same control on its own index pages ("Select a view"), the Polaris web components have no tab component, and "tab" in this codebase means a browser tab (the socket per tab). Update `RunTier`, `RecentItem`, `RunQuery`, `sameRunQuery`, the `runActions` paragraph that names "Mine, Up next, Teammates and Blocked tabs", and the header's "which tier a site speaks" bullet if it mentions tabs.
2. The seven struct renames and `getRunPage` from section 2, in `Domain.ts`, then every reader: `RunRepository.ts`, `ShopAgent.ts`, `ShopAgentClient.ts`, `app.orders.$orderId.tsx`, `app.orders.index.tsx`, `shop.$shop.workflows.$runId.tsx`, `shop.$shop.workflows.index.tsx`, the workflow routes, `test/integration/*` (`domain`, `member-runs-socket`, `run-actions`, `spec`). Update each struct's JSDoc opening line to name its screen by the Screens table's spec name ("Everything the orders index renders, in one socket round trip"). Say on `OrdersIndexData` why the suffix is `Data`: TanStack's own word for what a screen reads, and `View` now means a view-row button.
3. `src/lib/runTabs.ts` → `src/lib/workflowsListViews.ts`: `TABS` → `VIEWS`, `TAB_LABEL` → `VIEW_LABEL`, `TAB_EMPTY` → `VIEW_EMPTY`; JSDoc says view row, not strip.
4. `src/routes/shop.$shop.tsx`: the search key `tab` → `view`; `retainSearchParams(["view", "team", "limit"])`; the `stripSearchParams` default; rewrite the JSDoc.
5. `src/routes/shop.$shop.workflows.index.tsx`: `selectTab` → `selectView`, `tab` → `view` throughout, `strip` → `viewRow`, the class `.run-strip-tabs` → `.run-view-row`; the long comment on the strip ("Polaris has no tab component ... so a tab here is an `s-button`") becomes: Polaris has no view component either, its index pages put views in a menu, and a view here is an `s-button` pressed by variant, five in a grid so they never wrap.
6. `src/styles.css`: the class and its comments. `src/components/MemberRun.tsx`, `src/components/MemberBar.tsx`: comments.
7. `src/lib/useSubscribedQuery.ts` names `RunQuery`; check for `tab` and rename.
8. `RunRepository.ts`: `query.tab` → `query.view`; JSDoc on `listRuns` and `listRecent`.
9. `ShopAgent.ts`: the same, and the comment near the orders read.
10. `e2e/member-runs.member.spec.ts`: the `tab()` helper → `view()`, `DEFAULT_TAB` → `DEFAULT_VIEW`, `?tab=` → `?view=`, the `.run-strip-tabs` locator, test titles ("the tabs are a grid that never scrolls ..." → "the views are a grid that never scrolls ..."), comments.
11. `scripts/lib/rules-lint.ts`: add `/\btabs?\b/iu` to `RETIRED`; run `pnpm lint` and fix any copy hit (there should be none; a hit is a label that said "tab").
12. Grep `src`, `test`, `e2e`, `scripts` for `\btab` and confirm every remaining hit is a browser tab (socket, billing, "open in new tab") or the word "table". List any you left on purpose in section 16.

## 7. Step 2. Domain

All in `src/lib/Domain.ts`. The JSDoc on each symbol carries the rule; the rules named here are the ones a test must have (each rule has a test whose title is the rule).

1. **`ProductionState`**: `to_make` becomes `not_started`. Rewrite the JSDoc: the ladder is **Not started · Making · Made · Fulfilled**, and Cancelled beside it. State why the first rung is "Not started" and not "To make": the rung holds every open order with no open and no done run, which includes an unpaid order, an order whose items matched no workflow, an order whose only run the merchant cancelled, and an order whose only item Shopify removed; in three of those the bench will make nothing, so "to make" was a promise the app could not keep, and "not started" is true of all four. Keep the paragraph on never-stored and the packer's round trip. Keep the sentence that the SQL in `OrderRepository.listOrders` restates it.
2. **`PRODUCTION_STATE_LABEL`**, new, beside `RUN_STATE_LABEL`: `{ not_started: "Not started", making: "Making", made: "Made", fulfilled: "Fulfilled", cancelled: "Cancelled" }` with `satisfies Record<ProductionState, string>`. JSDoc: the glossary's Order positions screen column. Note that "Not started" is also `RUN_UNSTARTED_LABEL`, the merchant's word for an open run nobody has touched; it is the same fact one level down and the two never render on one row.
3. **`productionState`**: rename the branch. Update its JSDoc's "reads `to_make`" sentences; the closed-runs sentence becomes: an order whose runs are all closed reads not started, which is right, because nothing has started and the items may take a new workflow from the picker; whether that is an issue is `orderIssues`' question and the answer is no (a closed run is a decided item).
4. **`OrderIssue`** replaces `OrderNeed`, same four literals. Rewrite the JSDoc: **an issue is an open order that will not move until the merchant acts**, the orders index's Issues view and Issues column. Keep the four-row table (rule, remedy). Add the rule that decides the closed-run case in one sentence: **an issue is an undecided item**; an item whose run the merchant cancelled was decided (Cancel workflow says "Baton is not making this"), so it is no issue, while an item that matched no workflow was never decided, so it is No workflow until a workflow is attached or the order is fulfilled in Shopify. Say why the No workflow badge is kept on every stock order of a shop that also sells stock: hiding it would hide an untagged made-to-order product, and that customer never gets their order. Keep the sentences on unpaid-and-ambiguous, on open-only, and on independence from the position. Say why the word is issue and not need or attention: Shopify's badge guidance pairs the critical tone with "issues needing action"; "need" is verb-shaped and did not fit Blocked; "attention" names what a badge does about a problem, not the problem.
5. **`ORDER_ISSUE_LABEL`**, new, beside `PRODUCTION_STATE_LABEL`: the four labels above, `satisfies Record<OrderIssue, string>`. JSDoc: the glossary's Order issues screen column; the button used to carry these words too and now only the badges do.
6. **`orderIssues`** replaces `orderNeeds`; same body; the parameter `attention` becomes `unstaffed`. JSDoc: the one definition; the Issues column renders its result; the Issues view is its non-emptiness, restated in SQL.
7. **`OrderRow.unstaffed`** replaces `attention`. JSDoc: the same paragraph with the word changed; it is the `team` element of `orderIssues`, and the badge reads "Needs a team".
8. **`OrdersIndexView`** replaces `OrdersStatus` (section 2). JSDoc: the orders index's view row; each view is a whole question and the views are exclusive, which is why the old Status and Needs rows were merged (six of their twelve crossings could never be anything but zero, and Fulfilled had to hide the Needs row); `null` is Open, the default, because retention keeps a year and a merchant opening Orders is looking at the bench; `"issues"` is `orderIssues` non-empty; the five positions are `productionState`; `"all"` is the whole history and the only view that reads closed orders besides `"fulfilled"`; `"cancelled"` is legal with no button. Say the view row has no label on purpose: "Status" promised one axis and the row holds scopes and positions side by side, as the Shopify admin's own views do. Link `WorkflowsListView` as the other view row, so the two JSDocs point at each other.
9. **`ORDERS_INDEX_VIEW_LABEL`** (section 2), `satisfies Record<Exclude<OrdersIndexView, "cancelled"> | "open", string>` or equivalent; include `cancelled` if simpler and let the route skip it.
10. **`OrderCounts`** becomes `{ open, issues, not_started, making, made }`. JSDoc rule: **a count is what pressing that view would show, given the team.** Counts honour the team select and nothing else; not the search, because search ignores the views; not the pressed view, because a view never narrows its own row. Over open orders only, through the partial index, for the reason already there; so Fulfilled and All carry none. Keep the throttle sentence.
11. **`ListOrdersInput`**: `status` and `need` become `view: Schema.NullOr(OrdersIndexView)`. Rewrite the JSDoc on `q`: **search ignores the view and the team**: when `q` is not null the read is over every stored order and `view` and `team` are not applied, because the number the merchant typed is the whole question and "no match under Made" sent them to All to type it again. Keep "always send the key". `SubscribeOrdersInput` extends it; nothing else spells the old keys.
12. **Glossary** (the header JSDoc). One new Nouns row:

    | word | meaning                                                                                                   | symbol                                 | screen                        |
    | ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------- |
    | view | one whole question about a list, chosen by pressing its button; exclusive; the row's first is the default | `WorkflowsListView`, `OrdersIndexView` | its label (Mine, Issues, ...) |

    After the Workflow states table, two tables. Their intros must start with exactly `Order positions` and `Order issues` (the checker finds a table by its intro).

    Order positions, one per order, derived by `productionState` and never stored:

    | word        | meaning                           | screen      |
    | ----------- | --------------------------------- | ----------- |
    | not started | open, no open run and no done run | Not started |
    | making      | open, an open run                 | Making      |
    | made        | open, done runs and no open run   | Made        |
    | fulfilled   | Shopify says `FULFILLED`          | Fulfilled   |
    | cancelled   | Shopify says `cancelledAt`        | Cancelled   |

    Under it one sentence: "open" is `orderIsOpen`, not fulfilled and not cancelled, the orders index's default view, labelled Open.

    Order issues, zero or more per open order, derived by `orderIssues`:

    | word            | meaning                                                | screen            |
    | --------------- | ------------------------------------------------------ | ----------------- |
    | no workflow     | paid, no run on any item, no item choosing             | No workflow       |
    | choose workflow | an item matched two or more workflows                  | Choose a workflow |
    | team            | an open task unassigned, or on a deleted or empty team | Needs a team      |
    | blocked         | a run on the order is blocked, the run-state word      | Blocked           |

    The checker matches a row's `word` to a constant key by `camel(row.word)` (`scripts/lib/spec.ts`; "put back" → `putBack`). The new constants are keyed by their literals, which are snake case (`not_started`, `no_workflow`, `choose_workflow`), so `camel` alone will not find them. In step 3, make the lookup try `camel(word)` and then `word.replaceAll(" ", "_")`, and say so in its JSDoc: verb keys are camel case because they name action-struct fields, state keys are the literals. Do not rename the literals to camel case.

    One sentence after the Screens table: the orders index's view row speaks the two tables plus Open, Issues and All (`ORDERS_INDEX_VIEW_LABEL`); the member's workflows list's view row is `VIEW_LABEL` in `workflowsListViews.ts`.

13. Grep `Domain.ts` for `need`, `Needs`, `Anything`, `Status row`, `Needs row`, `to make`, `to_make`, `attention`, `tab` and fix every hit that is not the badge label "Needs a team", the order page's `attentionRows` (the order page's own word for its two per-task states, out of scope), or a browser tab.

## 8. Step 3. Spec checker

`scripts/lib/spec.ts` and `scripts/spec.ts`:

1. `ScreenLabels` gains `productionStates` and `orderIssues`.
2. `checkScreenColumns` gains `compare("Order positions", "Order positions", screen(labels.productionStates))` and the same for `"Order issues"`. The row-to-key lookup tries `camel(word)` then `word.replaceAll(" ", "_")` (step 2 item 12).
3. `scripts/spec.ts` `SCREEN_LABELS` passes `Domain.PRODUCTION_STATE_LABEL` and `Domain.ORDER_ISSUE_LABEL`.
4. `pnpm spec check` passes. `pnpm spec print` shows the two tables.

## 9. Step 4. Repository

`src/lib/OrderRepository.ts`, `listOrders`:

1. Input: `{ limit, cursor, q, view, team }`. Update the interface JSDoc: `view` filters by `Domain.OrdersIndexView`, each SQL fragment restating a branch of `productionState` or the union of `orderIssues`; `q` set means `view` and `team` are not applied (`Domain.ListOrdersInput.q`); `counts` follows `Domain.OrderCounts`.
2. `statusFilter` becomes `viewFilter`: the five position branches as today (`to_make` → `not_started`), plus `issues` → `sql.and([OPEN, sql.or([NO_WORKFLOW, CHOOSING, blockedRun, `exists (${BLOCKED_RUN})`])])` (check the SQL helper has `or`; if not, spell it), `null` → `OPEN`, `all` → `1 = 1`. Delete `needFilter`.
3. The page `where`: `sql.and([keyset, searchFilter, ...(q === null ? [viewFilter, teamFilter] : [])])`. Say in a comment that this is the search rule from `Domain.ListOrdersInput.q`.
4. `COUNT_FACT`: keep `not_started`, `making`, `made`; replace the four need facts with one `issues` fact: `(paid and openRuns = 0 and doneRuns = 0 and closedRuns = 0 and not choosing) or choosing or team or blockedRuns > 0`. Update its JSDoc: each counted view's predicate over the `facts` rows.
5. The count statement: `facts` keeps `OPEN` and `teamFilter` and drops `searchFilter`. Select `count(*)`, `sum(issues)`, `sum(not_started)`, `sum(making)`, `sum(made)`. Delete `statusFact` and `needFact`. Rewrite the comment: one count per view over the open orders the team leaves; nothing crosses; the `cross join` paragraph stays.
6. `attentionRows` and `needsAttention` become `unstaffedRows` and `unstaffed`; the row field is `unstaffed`.
7. Grep the file for `need`, `Needs`, `status`, `to_make`, `attention`, `cross` and fix every JSDoc hit. The `OPEN` JSDoc's closed-run sentence should say "not started" and "is no issue: a closed run is a decided item".

## 10. Step 5. `ShopAgent`

`src/lib/ShopAgent.ts`: `listOrders` and `subscribeOrders` pass `view` through; nothing else changes. Update the two callables' JSDoc and the comment near line 1940 that names `attention` and `waitingOn`. `ShopAgentClient.ts`: the `listOrders` signature follows `ListOrdersInput`.

## 11. Step 6. Routes

`src/routes/app.orders.tsx`:

1. `OrdersSearch` is `{ q, view, team, after }`; `retainSearchParams(["q", "view", "team", "after"])`.
2. Rewrite the JSDoc paragraph on the keys: `?view=` picks a view (`Domain.OrdersIndexView`; absent is Open); `?q=` searches every stored order and the view and team are then ignored, though they stay in the URL so clearing the field returns to them; `?team=`, `?after=` as today. The collision note about the workflows index's `status` key can go (there is no `status` key now); keep the rest.

`src/routes/app.orders.index.tsx`:

1. Delete `STATUSES`, `NEEDS`, `NEED_LABEL`, `openOnlyFiltersShown`, `FilterButton.count` as a `keyof OrderCounts` on the need side. New `VIEWS: readonly { value: OrdersIndexView | null; count: keyof Domain.OrderCounts | null }[]` in the order Open, Issues, Not started, Making, Made, Fulfilled, All, labels from `Domain.ORDERS_INDEX_VIEW_LABEL`. JSDoc: the view row; why there is no label and why Open and All sit beside positions (one sentence each; the rule is on `Domain.OrdersIndexView`, link it).
2. `ordersQueryKey(shop, q, view, team, after)`; `OrdersLoaderInput` and `loaderDeps` use `view`; `setFilters` patch takes `view` and drops `status` and `need`.
3. `pressButton`: `pressed={q === null && selected === value}`; on click `setFilters({ view: value, q: null })`. JSDoc: unpressed under a search because the read ignores the view (`Domain.ListOrdersInput.q`); pressing one clears the search.
4. `positionBadge` reads `Domain.PRODUCTION_STATE_LABEL[state]` for its text; tones as today. `issueBadges` replaces `needBadges`, reads `Domain.ORDER_ISSUE_LABEL`.
5. Table header: `Status` then `Issues` in place of `Production`; two cells. JSDoc on the header: two columns because each has its own view; the Status word is right for a column (one value per row) and was wrong for the old button row.
6. `emptyText(view, team)` per section 2.
7. The filter box: search field; then one grid row with an empty left cell and the view row; then the Team row, always rendered. Delete the Needs row and the Status label. Update the block comments: the "Status", "Needs" and "Team" alignment sentence becomes the view row and the Team row sharing a grid.
8. `filtered` is `q !== null || view !== null || team !== null`.
9. Grep the file for `need`, `Needs`, `Anything`, `Status row`, `Production`, `to_make`, `To make`, `attention`, `openOnly`, `cross`, `tab` and fix every hit. The `syncButton`, `emptyState`, pagination and search JSDoc are untouched except where they name the Status or Needs row.

`src/routes/app.orders.$orderId.tsx`: the `Domain.productionState` call and `state === "made"` are unchanged; grep for `to_make`, `To make`, `need` and fix JSDoc hits only. `attentionRows` stays: it is the order page's per-task word and not this change's.

`src/routes/app.teams.$teamId.tsx`: the drill-in link is `?team=` and unchanged; check its JSDoc does not say "Needs row".

## 12. Step 7. Seeds and e2e fixtures

- `src/routes/api.dev.seed.ts`, `scripts/seed.ts`: grep for `need`, `To make`, `attention`, `tab` in comments; fix wording. No data change.
- `e2e/fixture.ts`: the comments at lines 48, 250, 502 to 520 name the index's badges; make them say Issues column, Not started, and "Needs a team" as a badge. No data change.

## 13. Step 8. Tests

Titles are rules. Replace, do not add beside.

`test/integration/domain.test.ts`:

- `Domain.productionState`: "no open and no done run is not started"; "an order whose runs are all closed is not started"; the rest renamed.
- `Domain.orderIssues` replaces `Domain.orderNeeds`: "an item whose run closed is decided and is no issue"; "team: the order has an unstaffed task" (the field is `unstaffed`); "a fulfilled or cancelled order has no issues"; the rest renamed.
- The label constants are total by `satisfies`; no test needed. Say so in section 16.
- Member-side tests that name `tab` (`tierOf`, `RunQuery`): rename to `view`; titles that say "tab" say "view".

`test/integration/order-repository.test.ts`, `OrderRepository.listOrders filters`:

- "each position view returns exactly the orders productionState gives that position, and an order whose only run is closed is not started".
- "the Issues view returns exactly the orders orderIssues gives at least one issue" (replaces the per-need test; assert the union over the seeded states).
- "a count is what pressing that view would show, given the team" (replaces the cross test and the "narrows the counts to the search" test: assert counts do not change with `q`, do change with `team`, and do not change with `view`).
- "search ignores the view and the team": seed an order that is fulfilled and one waiting on team A; with `q` set to each number and `view: "made"`, `team: B`, both are found.
- "a view under a team narrows to the open orders waiting on it" (replaces "a need under All narrows to open orders" as needed).
- `OrderRepository.listOrders need team` becomes `... unstaffed`; the titles say "unstaffed" where they say "attention".
- Every `need: null` / `status:` in inputs becomes `view:`.

`test/integration/run-repository.test.ts`, `member-runs-socket.test.ts`, `shop-agent-workflows.test.ts`, `orders-sync-workflow.test.ts`, `run-actions.test.ts`, `spec.test.ts`: `tab:` → `view:`, `need: null` → `view: null`, struct names per section 2; `needsAttention` assertions in `shop-agent-workflows.test.ts` are the run summary's field, a different symbol; check and leave.

`e2e/orders.spec.ts`:

- "the needs row counts what its button shows" becomes "each view's count is what pressing it shows, given the team": press Issues, Not started, Making, Made in turn; the row count equals the button's number; pick a team, the numbers change; type a search, the numbers do not.
- "the orders index searches by order number and clears back to the list": add that a search under Made finds an order that is not made, that every view reads unpressed while the field has a value, and that pressing Open clears the field.
- "a bad filter value reads as no filter": `app/orders?view=nonsense&after=nonsense`; Open is pressed.
- "the orders index keeps its filters and page across the order page": use `?view=`.
- The "Anything" and "Needs" locators go. Column header assertions: "Status", "Issues".
- Read the column-cell assertions: a row's Status badge and Issues badges are in two cells now.

`e2e/member-runs.member.spec.ts`: step 1 item 10.

Run `pnpm test` after this step and `npm run test:e2e -- orders teams home member` after step 6 and again here.

## 14. Step 9. JSDoc alignment pass

Do this as its own step after the code compiles and tests pass, file by file, reading every JSDoc and comment top to bottom:

- `src/lib/Domain.ts`: the header (the "waiting" paragraph mentions the orders index's Waiting on column; keep); the glossary; `ProductionState`; `PRODUCTION_STATE_LABEL`; `OrdersIndexView`; `ORDERS_INDEX_VIEW_LABEL`; `OrderIssue`; `ORDER_ISSUE_LABEL`; `OrdersCursor` (names `?status=`? check); `ListOrdersInput`; `OrderRow` (`unstaffed`, `waitingOn`, `ambiguousItems`); `productionState`; `orderIssues`; `RunCounts` (its JSDoc says "reads as to make"); `OrderCounts`; `OrdersIndexData`; `ClosedReason` (check it does not say "to make"); `LineItemState` (check); `RunTier`; `WorkflowsListView`; `RecentItem`; `RunQuery`; the seven renamed structs; the `runActions` paragraph naming the member's views.
- `src/lib/OrderRepository.ts`: `OPEN` and its neighbours; `COUNT_FACT`; the `listOrders` interface JSDoc; every comment inside `listOrders`.
- `src/lib/RunRepository.ts`: `listRuns`, `listRecent`, `getRunPage`, and every "tab" in a comment.
- `src/lib/ShopAgent.ts`: `listOrders`, `subscribeOrders`, `listRuns`, `subscribeRuns`, the orders comment; leave the browser-tab sentences.
- `src/routes/app.orders.tsx`, `src/routes/app.orders.index.tsx`, `src/routes/app.orders.$orderId.tsx`, `src/routes/app.teams.$teamId.tsx`, `src/routes/shop.$shop.tsx`, `src/routes/shop.$shop.workflows.index.tsx`, `src/components/MemberRun.tsx`, `src/components/MemberBar.tsx`, `src/styles.css`, `src/lib/workflowsListViews.ts`, `e2e/fixture.ts`, `e2e/orders.spec.ts`, `e2e/member-runs.member.spec.ts`, the two seeds.
- Grep the tree (`src`, `test`, `e2e`, `scripts`) for `OrderNeed`, `orderNeeds`, `OrdersStatus`, `to_make`, `To make`, `Needs row`, `Status row`, `Anything`, `Production column`, `need=`, `status=`, `attention` (outside the order page's `attentionRows` and the member run summary's `needsAttention`), `cross`, `RunTab`, `runTabs`, `strip`, `\btab` (outside browser-tab sentences), and the seven old struct names. Every hit is gone, renamed, or a deliberate sentence, and section 16 lists the deliberate ones.
- No JSDoc references `docs/`. Reasoning is inline: why one view row, why no label beside it, why the word is view and not tab, why Not started, why issue, why the closed-run item is no issue, why the No workflow badge stays on stock orders, why search ignores the views, why counts honour the team only, why the read structs are `*Data` named by screen.

## 15. Step 10. Look, then final checks

1. No state reset is needed: nothing stored changes.
2. `pnpm seed`, then open the orders index and press each view. Screenshot each. Check against section 5: seven views, five with counts; two badge columns; Team row always present; a search under Made finds a not-made order and unpresses every view; pressing a view clears the field. Open the member's workflows list: five views, same as before, `?view=` in the URL after pressing one.
3. `pnpm typecheck && pnpm lint && pnpm test && npm run test:e2e --`.
4. `pnpm fmt`; keep every file it touches.
5. Delete `docs/orders-index-first-principles-research.md` and this plan only when told.
6. Final report: what changed, and section 16.

## 16. Deviations and issues

Record here, as you go, anything that did not go as written: a decision in section 2 you changed, a step that needed more than it said, a test that could not be titled as given, a JSDoc sentence you kept on purpose. One bullet each, with the file.

- `scripts/rules-lint.ts` is the command; the `RETIRED` list the plan names is in `scripts/lib/rules-lint.ts`. "tab" was added there, with a row in its table. No copy hit.
- The loader-data fields named `view` were renamed too, because `view` now means a view-row button: `OrdersIndexLoaderData.view` → `orders` (as planned), `RunListLoaderData.view` → `list`, `RunLoaderData.view` → `page` (`Domain.ts`). Local variables holding a struct followed: `view`/`loaderView`/`initialView` → `data`, `list`, `page` in the three routes, `readRunView` → `readRunPage` (`ShopAgent.ts`), the decoders in `ShopAgentClient.ts`, and `taskView` → `taskRow` (`domain.test.ts`).
- `.run-strip` (the sticky wrapper around the member's view row) became `.run-view-row-sticky`, so "strip" is gone from the member side, not only `.run-strip-tabs` (`styles.css`, `shop.$shop.workflows.index.tsx`).
- In `OrderRepository.listOrders`, `blockedTask`/`blockedRun` (which test for an unstaffed task, not a block) became `unstaffedTask`/`unstaffedRun`, so the Issues predicate reads `NO_WORKFLOW or CHOOSING or unstaffedRun or exists BLOCKED_RUN`. `COUNT_FACT` gained `open: "1"` so it still covers every `OrderCounts` key.
- The orders index's filter box does not use an empty left grid cell for the view row: the view row is its own inline stack at the box's edge and the Team row (a two-column grid) sits under it, which is what section 5's render shows (`app.orders.index.tsx`).
- `emptyText` keeps a "No open orders." line for Open; it is only reachable with a team selected, where the team line wins, so it never renders. Kept for exhaustiveness (`app.orders.index.tsx`).
- `pnpm spec print` does not print glossary tables (it never did); the two new tables are checked by `pnpm spec check`, and `spec.test.ts` gained "a spaced word finds its snake-case literal key" for the snake-case lookup.
- The label constants (`PRODUCTION_STATE_LABEL`, `ORDER_ISSUE_LABEL`, `ORDERS_INDEX_VIEW_LABEL`) are total by `satisfies`; no test was added for them.
- `order-repository.test.ts`: the describe is "OrderRepository.listOrders views" (was "filters"); "OrderRepository.listOrders need team" became "OrderRepository.listOrders unstaffed" with the title "an order with an unassigned or unstaffed open task is unstaffed, and the Issues view holds it", since there is no per-issue filter left to keep only those orders. The "narrows the counts to the search" test was removed; the count test asserts the opposite for every view, team and search.
- `e2e/orders.spec.ts`: the counts test no longer relies on the search to isolate its orders (counts ignore the search now); it seeds orders on a fresh team and checks the counts under the team select. The Open count is read from the button's accessible name, because the label is slotted into the shadow root and the resolved element has no `textContent`.
- Other non-browser "tab" sentences outside the plan's list were reworded: `app.workflows.tsx` ("status tabs" → "status buttons", and the collision reason, which no longer holds, rewritten), `workflowEditorWindow.ts` ("Draft tab" → "Draft badge"), `app.workflows.$workflowId.tsx` and `e2e/workflows.spec.ts` ("draft tab"/"no tabs" → "draft panel"). Remaining "tab" hits are browser tabs, the keyboard "tab order", "open-in-new-tab", Herdr terminal tabs in `scripts/`, `refs-shopify-docs.ts` doc-example tabs, and the one sentence in `shop.$shop.tsx` that says the key used to be `?tab=`.
- Loose uses of "view" for a read or a screen were reworded (`Domain.ts` "orders view", "page view", "back-office view", "production-floor view"; `ShopAgent.ts`, `RunRepository.ts`, `MemberRun.tsx`, `admin.shop.$shop.tsx`, `SubscriptionPlan.ts`, `app.orders.$orderId.tsx`). "Needs attention" and "attention state" on the workflow side (workflow and team warnings, `attentionRows` on the order page, `needsAttention` on the run summary) are a different concept and were left.
- Review (2026-09-28): the `OrdersIndexView` JSDoc and the `null` branch comment in `OrderRepository.listOrders` said Fulfilled and All were the only views that read closed orders; Cancelled reads them too. Both sentences now name all three (`Domain.ts`, `OrderRepository.ts`).
- Deliberate sentences that keep a retired word: `Domain.ts` says why the first rung is not "To make" and why the view row is not a "Status row" crossed with an issue row; `spec.test.ts` uses "To make" as the doctored cell.

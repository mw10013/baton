# Orders index filters: implementation plan

Hand-off plan for approach C in `docs/orders-index-filters-research.md` (Decisions 1 to 8 and the "What the counts cost" decision, 2026-09-23). Read that doc's "Two axes, not one", "Approaches: C", "Decisions" and "What the counts cost" sections first. This plan is self-contained otherwise.

Five files carry the change: `src/lib/Domain.ts`, `src/lib/OrderRepository.ts`, `src/routes/app.orders.index.tsx`, `test/integration/order-repository.test.ts`, `test/integration/domain.test.ts`, plus the e2e specs and fixture comments that name the old controls. No schema change, no migration, no new table or index. The app home card (approach D) is out of scope; see "Out of scope".

The implementing agent may use the Chrome DevTools MCP (`mcp__chrome-devtools__*`) to look at the page against local dev. Open `http://localhost:$(pnpm port)/app/orders` inside the Shopify admin the way `e2e/app.ts` does, or run the orders e2e project headed. Take a screenshot at the end of phase 3 and compare it with "Target render" before moving to phase 4.

## The change in one paragraph

Today one "Stage" row mixes scopes (Open, All), lifecycle positions (In production, Ready to ship, Shipped) and problems (No workflow, Choose a workflow), a red "Needs attention" toggle sits in the "Payment" row, "Clear filters" resets everything including the search and the team, and every count is the shop-wide open count regardless of the other filters. After the change the bar is: the order-number search; a **Status** row (Open · In production · Ready to ship · Shipped · All), lifecycle only; a **Needs** row (Anything · No workflow · Choose a workflow · Needs a team · Blocked · Order changed), one press-button per problem, each carrying a count that honours the status row, the team select and the search; and a **Team** select. Payment, the attention toggle, Clear filters, and the sentence under the bar are gone. `productionState` loses `no_workflow` and `multiple_workflows` and its precedence; the five problems become a separate `Domain.orderNeeds` derivation that the row badges and the filter both read.

## Target render

```
[ Order number            ]

Status   [Open] [In production · 51] [Ready to ship · 11] [Shipped] [All]
Needs    [Anything] [No workflow · 2] [Choose a workflow · 2] [Needs a team · 1] [Blocked · 0] [Order changed · 3]
Team     [Any team            ⌃]

Order    Placed            Payment   Workflows                          Waiting on      Items  Shopify
#2041    Sep 23, 8:02 PM   Paid      Ready to ship                                       1     Fulfil in Shopify
#2040    Sep 23, 8:02 PM   Paid      1 active   Needs a team             Jewelry         1     View in Shopify
#2039    Sep 23, 8:02 PM   Paid      2 active   Choose a workflow        Engraving …     2     View in Shopify
```

Rules the render follows:

- Every button in both rows is an `s-press-button`. `pressed` is the selected one. Open and Anything are the defaults and are pressed when nothing is in the URL. No red on the bar: the alarm colour is on the row badges, where the remedy is.
- A counted button always renders, at zero if need be. Nothing on the bar appears or disappears with the data. The uncounted ones (Open, Shipped, All, Anything) render as bare labels, as now.
- The Needs row is hidden when Status is Shipped: a shipped order has no open work and no problem can be filtered under it. Under All, a Needs button narrows to open orders that have that problem (a shipped order with a stale flag is not a to-do). Under Open, In production and Ready to ship the two rows cross.
- The search chip (`Order #9301`) stays, as the only chip, at the end of the Needs row where "Clear filters" used to be. It is the one filter whose control does not show its own value at rest.
- The Workflows cell shows the position badge (`1 active`, `Ready to ship`, `Shipped`, `Cancelled`, or nothing) followed by one badge per need, in the order of the Needs row. "Needs a team" replaces the words "Needs attention" on the badge so the badge and the button say the same thing.
- The empty text under a Needs filter names the problem: "No open orders need a workflow." and so on (see phase 3).

## Vocabulary

| Word         | Meaning                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status       | Lifecycle position: `null` (open work), `in_production`, `ready_to_ship`, `shipped`, `all`. URL param `status`.                                                       |
| Need         | A problem with a remedy: `no_workflow`, `choose_workflow`, `team`, `blocked`, `changed`. URL param `need`. `null` is "Anything".                                      |
| Not started  | An open order with no runs. It has a `productionState` of `null` and shows under Open and All only. It was "No workflow" when paid; that is now a need, not a status. |
| Needs a team | The old `attention`: an open task that is unassigned, on a deleted team, or on an unstaffed team.                                                                     |

## Order of work

Run `pnpm typecheck && pnpm lint && pnpm test` after phases 1, 2 and 3. Run the orders, teams and home e2e projects after phase 4: `npm run test:e2e -- orders teams home`. Run `pnpm fmt` at the end and keep every file it touches.

### Phase 0: measure before touching anything

The research doc estimated rows read; the decision was to measure first. Durable Object SQLite reports `rowsRead` on every cursor from `ctx.storage.sql.exec`. The Effect SQL client used by `OrderRepository` may not surface it; if it does not, write the measurement as a throwaway integration test beside `test/integration/order-repository.test.ts` that seeds the `seedStates` fixture, runs the count statement through the raw `SqlStorage` handle the test harness exposes, and prints `rowsRead`. Record three numbers in "Deviations and issues" at the bottom of this plan: rows read by the current `openCounts` statement, by the current page read (the five statements), and the open-order and run counts of the seed. Repeat at the end of phase 2 with the new statements. Delete the throwaway test before finishing, or keep it as a real test with an upper bound assertion if the number is stable; say which in the deviations section.

If the harness gives no way at `rowsRead`, say so in the deviations section, run `EXPLAIN QUERY PLAN` on the old and new count statements instead, and record that both use `ShopOrder_open_idx` and `WorkflowRun_orderId_idx` and no full scan.

### Phase 1: Domain

All in `src/lib/Domain.ts`. The JSDoc on each symbol carries the rule; the rules named here are the ones a test must have (`AGENTS.md`: each rule has a test whose title is the rule).

1. **`ProductionState`** becomes `"in_production" | "ready_to_ship" | "shipped" | "cancelled"`. Remove `"no_workflow"` and `"multiple_workflows"`. Rewrite the JSDoc: it is the lifecycle position, one per order, `null` for an open order with no runs; problems live on `OrderNeed`. Keep the sentence that the SQL in `OrderRepository.listOrders` restates it and must move with it. Drop the paragraph about `multiple_workflows` outranking.

2. **`productionState`** loses the `multiple_workflows` and `no_workflow` branches. Order: cancelled, shipped, `none` → `null`, `open` → `in_production`, else `ready_to_ship`. The `ambiguousItems` field is no longer read; narrow the `Pick` to `"order" | "runs"`. Update the JSDoc: it no longer takes three fields, and the reason it takes a `Pick` at all (the order page rebuilds the aggregate) still holds.

3. **`OrderNeed`**, new: `Schema.Literals(["no_workflow", "choose_workflow", "team", "blocked", "changed"])` with type. JSDoc states the rule for each, in the order of the Needs row, and names the remedy:
   - `no_workflow`: paid, uncancelled, unfulfilled, no live run on any item, and no ambiguous item. Remedy: attach a workflow on the order page.
   - `choose_workflow`: `ambiguousItems > 0` and the order can start runs (`canStartRuns`). Remedy: choose on the order page. Note that an unpaid order with an ambiguous item is not choosing, as `CHOOSING` in the repository already says.
   - `team`: `OrderRow.attention`. Remedy: assign on the order page, or staff the team.
   - `blocked`: `runs.blocked > 0`. Remedy: the order page.
   - `changed`: `runs.flagged > 0`. Remedy: accept the change on the order page.
     State that a need is only ever on an open order (uncancelled, unfulfilled), and that needs are independent: one order can carry several.

4. **`orderNeeds`**, new: `(row: Pick<OrderRow, "order" | "runs" | "attention" | "ambiguousItems">) => readonly OrderNeed[]`, in `OrderNeed` order. Returns `[]` for a cancelled or fulfilled order. This is the one definition; the row badges render its result, and the SQL predicates in the repository restate each element. `no_workflow` is `canStartRuns(order) && !isFulfilled(order) && runs.open === 0 && runs.done === 0 && ambiguousItems === 0`. `canStartRuns` reads paid and uncancelled only, so the fulfilment test is explicit here; the JSDoc says why (a fulfilled order with no runs is every historical order the window sync pulled in, and is not a to-do).

5. **`OrdersStatus`** replaces `OrdersFilterState`: `Schema.Union([ProductionState, Schema.Literal("all")])`. Keep the JSDoc's reasoning about `null` being open work and `"all"` being the escape hatch. `"cancelled"` remains a legal value with no button, as now.

6. **`OrderCounts`** replaces `OpenStageCounts`:

   ```
   in_production, ready_to_ship,
   no_workflow, choose_workflow, team, blocked, changed
   ```

   JSDoc rule: **a count is what pressing that button would show, given every other filter.** Status counts honour the selected need, team and search; need counts honour the selected status, team and search. Both are computed over open orders only, so `shipped` and `all` carry no status count, and under status `shipped` the need counts are meaningless and the route hides the row. Keep the reasoning about the partial index and why Shipped and All are uncounted.

7. **`ListOrdersInput`**: rename `state` to `status: Schema.NullOr(OrdersStatus)`; replace `paid` and `attention` with `need: Schema.NullOr(OrderNeed)`; keep `q`, `team`, `limit`, `cursor`. Update the "always send the key" note so it covers `need`. `SubscribeOrdersInput` extends it; check nothing else spells the old keys.

8. **`OrdersPage.openCounts`** becomes `counts: OrderCounts`.

9. **`OrderRow.attention`** stays as the field (it is what SQL computes); its JSDoc gains one line: it is the `team` element of `orderNeeds`, and the badge reads "Needs a team".

10. Grep `src/` for `OrdersFilterState`, `OpenStageCounts`, `openCounts`, `multiple_workflows`, `no_workflow` and fix every site. Expected: `OrderRepository.ts`, `app.orders.index.tsx`, `app.orders.$orderId.tsx` (only the `productionState` call, which drops `ambiguousItems`; its JSDoc paragraph about the ranking of `no_workflow` is now wrong and is deleted), `ShopAgent.ts` and `ShopAgentClient.ts` (type pass-through only).

`scripts/rules-lint.ts` refuses inline `.status ===` and `.flag ===` comparisons outside `Domain.ts`. The route must call `orderNeeds` and `productionState`, never compare the fields.

Tests, in `test/integration/domain.test.ts`:

- Retitle and reshape the `Domain.productionState` table: delete the "ambiguous outranks" cases and "paid, one ambiguous item, no runs"; add "an open order with no runs is null whether or not it is paid".
- New `describe("Domain.orderNeeds")` with one case per rule in step 3, the independence case ("an order can be blocked and choosing at once, in row order"), and "a shipped or cancelled order has no needs".

### Phase 2: repository

All in `src/lib/OrderRepository.ts`.

1. **Signature**: `listOrders({ limit, cursor, q, status, need, team, teams })`. Update the interface JSDoc: delete the paragraph that says `openCounts` honours none of the filters, and state the `OrderCounts` rule instead, with the two-row crossing spelled out.

2. **Fragments**: keep `OPEN`, `ANY_RUN`, `OPEN_RUN`, `DONE_RUN`, `LIVE_RUN_FOR_ITEM`, `AMBIGUOUS_ITEM`, `CHOOSING`. Add `BLOCKED_RUN` and `CHANGED_RUN` (open run with `flag = 'blocked'`, open run with `flag is not null and flag <> 'blocked'`), same correlated shape, served by `WorkflowRun_orderId_idx`. Add `NO_WORKFLOW` = `fullyPaid = 1 and not exists (ANY_RUN) and not (CHOOSING)`. Each fragment's JSDoc names the `OrderNeed` it restates.

3. **`statusFilter`** replaces `stateFilter`: `null` → `OPEN`; `in_production` → `OPEN and exists (OPEN_RUN)`; `ready_to_ship` → `OPEN and exists (DONE_RUN) and not exists (OPEN_RUN)`; `shipped`, `cancelled`, `all` as now. No `not (CHOOSING)` anywhere: the statuses partition open orders by run state alone. Not-started orders (no runs) fall in Open and All only, as the Domain JSDoc says.

4. **`needFilter`** replaces `paidFilter` and `attentionFilter`: `null` → `1 = 1`; each need → `OPEN and <its fragment>`, where `team` is the existing `attentionRun`. The `OPEN` term is what makes a need under All narrow to open orders.

5. **Counts in one pass, honouring the other filters.** One statement over `ShopOrder where OPEN and searchFilter and teamFilter`, with seven conditional sums:
   - `in_production`: `sum(exists (OPEN_RUN) and <needFilter-without-OPEN or 1=1>)`
   - `ready_to_ship`: `sum(exists (DONE_RUN) and not exists (OPEN_RUN) and <need>)`
   - each need: `sum(<need fragment> and <statusFilter-as-open-predicate>)`, where the status predicate is `1 = 1` for `null` and `all`, the run predicate for `in_production` and `ready_to_ship`, and the whole statement is skipped (all zeros) for `shipped` and `cancelled`.
     The status sums must not be narrowed by the status filter, and the need sums must not be narrowed by the need filter; each row's count is the answer to "what if I pressed this one, keeping everything else".

6. **Hoist the run summary.** The current statement runs up to five correlated `exists` per open order. Replace them with one CTE over open runs, grouped by order:

   ```sql
   with run_summary as (
     select orderId,
       sum(status in ('pending', 'active')) as open,
       sum(status = 'done') as done,
       sum(status in ('pending', 'active') and flag = 'blocked') as blocked,
       sum(status in ('pending', 'active') and flag is not null and flag <> 'blocked') as changed
     from WorkflowRun
     where status in ('pending', 'active', 'done')
     group by orderId
   )
   select ... from ShopOrder left join run_summary on run_summary.orderId = ShopOrder.id
   where OPEN and ...
   ```

   This is the same shape as the per-page `runRows` read. `CHOOSING` and `attentionRun` stay correlated: one walks line items, the other tasks, and neither has a cheap grouped form. If `EXPLAIN QUERY PLAN` shows the CTE materialising the whole `WorkflowRun` table rather than using an index, add `and orderId in (select id from ShopOrder where OPEN)` to the CTE's `where`, or restrict it by `WorkflowRun_open_age_idx` if that index covers it; record which in the deviations section. `WorkflowRun` rows for closed orders are bounded by retention (365 days), so even the unrestricted CTE is one read of the run table, not a cross product.

7. **Page read.** The page's `where` is `keyset and searchFilter and statusFilter and needFilter and teamFilter`. The five per-page reads (units, runs, attention, ambiguous, waiting-on) are unchanged.

8. **Return** `counts` instead of `openCounts`.

9. **Throttle.** `useSubscribedQuery` already coalesces published invalidations at `INVALIDATION_THROTTLE_MS` (2 s). Do not add another. Note in the `OrderCounts` JSDoc that this throttle is the bound on refreshes per tab, with a `{@link}` to the constant.

Tests, in `test/integration/order-repository.test.ts`. The `seedStates` fixture seeds 14 orders; keep it and re-derive the expected sets:

- Retitle "each state returns exactly the orders productionState gives that state" to "each status returns exactly the orders productionState gives that status, and open orders with no runs are under Open and All only". The loop over `pages.all.orders` now also asserts `productionState(row) === null` rows are in `open` and in no other list.
- New "each need returns exactly the orders orderNeeds includes it in": list under each of the five needs and check row by row against `Domain.orderNeeds(row)`.
- Replace "counts the open stages once, independent of the page's filters" with "a count is what pressing that button would show, given every other filter": assert `counts` under (status null, need null) equal the list lengths; under (status in_production, need null) the need counts equal the lengths of each need list crossed with in_production; under (need blocked, status null) the status counts equal in_production and ready_to_ship lists crossed with blocked; under team set, everything crossed with the team.
- Delete "paid crosses with state and pages under it". Payment is not a filter.
- "keeps only orders with an unassigned or unstaffed open task, and counts them" becomes a `need: "team"` test with the same assertions.
- "leaves the open-stage counts alone, as the other filters do" (in the `q` describe) inverts: "narrows the counts to the search".
- "keeps exactly the rows waiting on that team, and leaves the counts alone" (waitingOn) inverts the same way.
- `#1012` (one ambiguous item beside one in production) is the case that changes meaning: it is now `in_production` with need `choose_workflow`. Assert it explicitly in the status test and the need test, with a comment saying it is the row the research doc used as the undercount example.

### Phase 3: the route

All in `src/routes/app.orders.index.tsx`.

1. **Search schema**: `OrdersSearch` becomes `{ q, status, need, team }`. Drop `state`, `paid`, `attention`. No compatibility shim for old `?state=` URLs: nothing outside this repo links to them, and the team page link carries only `?team=`. Update the JSDoc.

2. **`STAGES`** becomes `STATUSES`: `[null Open][in_production][ready_to_ship][shipped][all]`, with `count` keys into `OrderCounts` for the middle two. JSDoc: lifecycle only; problems are `NEEDS`.

3. **`NEEDS`**, new: `[null Anything][no_workflow "No workflow"][choose_workflow "Choose a workflow"][team "Needs a team"][blocked "Blocked"][changed "Order changed"]`, each with its `count` key except `null`. JSDoc: the merchant's to-do list; the labels are the badge labels so the button and the row say the same words.

4. **`setFilters`** takes `{ q, status, need, team }`.

5. **`stateBadge`** becomes `positionBadge`: `null` → nothing; `in_production` → the `N active · M done` info badge; `ready_to_ship`, `shipped`, `cancelled` as now. Then a `needBadges(row)` that maps `Domain.orderNeeds(row)` to badges: warning tone for `no_workflow` and `choose_workflow` and `changed`, critical for `team` and `blocked`. Render `positionBadge` then `needBadges` in the Workflows cell. Delete the inline `row.attention &&` badge. Rewrite the JSDoc: the three-alarm paragraph moves to `OrderNeed` in Domain, and this one says only that badges follow `orderNeeds` order and tone follows whether a person is stopped.

6. **`stageText`**: delete, with its `orders()` helper and the paragraph that rendered it.

7. **`emptyText`**: takes `(status, need)`. With a need set, name it: "No open orders need a workflow." / "No open orders need a workflow chosen." / "No open orders need a team." / "No open orders are blocked." / "No open orders have changed." With no need, the status texts as now (minus the two deleted statuses).

8. **Filter bar**: three grid rows labelled Status, Needs, Team. Both button rows use one `pressButton` helper over `STATUSES` and `NEEDS`. Delete `paidButton`, the attention `s-button`, `Clear filters`, and `filtered` where it only served Clear (`filtered` is still needed for the empty-state branch and `neverStored`). Hide the Needs row when `status === "shipped"` or `"cancelled"`; the JSDoc on the row says why. Keep the search chip at the end of the Needs row. Relabel the select "Team" (both `label` and the visible `s-text`). Rewrite the long comment on the attention button (it is deleted) and the comment on the select ("Waiting on" reasoning is now about the column, not the filter).

9. **`ordersQueryKey`**, `getLoaderData`, `loaderDeps`, `useSubscribedQuery` call: new param names.

10. Search for the string "Needs attention" across `src/`. The orders index and any component that renders the row badge use "Needs a team". Other pages (the order detail page's banner, the team page) keep their own wording unless they are naming the same fact; if they are, change them and list each in the deviations section.

Look at the page now (Chrome MCP or headed e2e) and compare with "Target render".

### Phase 4: e2e and fixtures

- `e2e/orders.spec.ts`, the "an item matching two workflows" test: the button locator `/^Choose a workflow/u` still matches (the Needs row button has the same text). The row-scoped badge assertion still matches. Add one assertion that pressing the button leaves `#9401` visible and sets `?need=choose_workflow`.
- `e2e/orders.spec.ts`: add one test "the needs row counts what its button shows": seed one order with no matching workflow and one blocked, assert `No workflow · 1` and `Blocked · 1`, press `No workflow`, assert exactly the one row, press `Anything`, assert both rows.
- `e2e/teams.spec.ts`, the drill-in test: the combobox is named "Team" now. Change the `getByRole("combobox", { name: "Waiting on" })` locator. The "Clear filters" click at line ~103 is on the teams page, not the orders page; leave it.
- `e2e/fixture.ts` comments at lines ~72, 221, 443 to 480 describe what the seeded orders show. Update the words: "Needs attention" → "Needs a team"; "under Choose a workflow" stays; `#1012` reads "In production with Choose a workflow".
- `e2e/home.spec.ts`: check nothing asserts on orders-page controls.
- `pnpm seed` and the dev seed route: check the seed's own comments for the old vocabulary and update them.

### Phase 5: JSDoc alignment sweep

The rule from `AGENTS.md`: a rule is stated once on the symbol that enforces it, and other sites `{@link}` it. After phases 1 to 4, grep for every one of these strings and fix or delete the sentence that carries it:

| String                               | Where it will still be wrong                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrdersFilterState`                  | any JSDoc that survived the rename                                                                                                                                     |
| `OpenStageCounts`, `openCounts`      | `OrderRepository.ts` interface JSDoc, `ShopAgent.ts` if it mentions the strip                                                                                          |
| `multiple_workflows`                 | `Domain.ts` `AMBIGUOUS_ITEM` and `CHOOSING` neighbours in the repository, `app.orders.$orderId.tsx`                                                                    |
| "outranks"                           | `productionState`, `stateBadge`, `stateFilter` JSDoc, the test comment about `#1012`                                                                                   |
| "stage" (lower case, in orders code) | the index route, the repository, `Domain.ts`; the word now belongs to nothing on this page. Workflow steps were already renamed away from "stage" in commit `2188c0f`. |
| "Needs attention"                    | badge JSDoc, `OrderRow.attention` JSDoc, e2e fixture comments                                                                                                          |
| "cross-cutting"                      | `OpenStageCounts.attention` and the attention button comment                                                                                                           |
| "Clear filters"                      | the search-draft JSDoc in the route ("re-seeds whenever q changes from outside the field — Clear filters, …")                                                          |
| "Payment" as a filter                | the route's filter-bar comments and `neverStored` JSDoc ("the payment filters gone")                                                                                   |
| "partition"                          | `stateFilter` JSDoc says the chips partition the open orders; statuses still do, needs do not                                                                          |

`pnpm lint` runs `scripts/rules-lint.ts`; make sure no route compares `.status`, `.flag` or `.role` inline.

## Verification checklist

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` green after each phase.
- [ ] `npm run test:e2e -- orders teams home` green.
- [ ] Phase 0 numbers recorded below, before and after.
- [ ] Screenshot of the page with no filters matches "Target render"; every button in both rows renders, counts at zero included.
- [ ] Press each Needs button with Team set to a team: the count on the button equals the rows shown.
- [ ] Press Shipped: the Needs row is gone. Press All: it is back, and pressing Blocked shows only open blocked orders.
- [ ] The team page's drill-in lands with the Team select set and the row filtered.
- [ ] `pnpm fmt` run last; every file it touched is kept.

## Out of scope

- The app home "Needs you" card (approach D). It links into this page with `?need=<need>`, so build it after this lands.
- The order detail page's own wording for blocked and changed runs. It names the same facts with its own banners; leave it unless phase 3 step 10 finds it saying "Needs attention" for the team case.
- A `?state=` redirect for old URLs. Not needed.
- Counts for Shipped and All. Uncounted by decision 5 and the cost analysis.

## Deviations and issues

The implementing agent records here anything that departed from the plan, anything that turned out wrong in it, and the phase 0 measurements. One bullet per item, with the phase and step it belongs to, what was done instead, and why. Leave the heading in place even if empty.

- (phase 0) Measured through a throwaway integration test that handed `SqliteClient.layer` a storage whose `sql.exec` recorded every cursor, then summed `rowsRead` over one `listOrders` call on `seedStates` (status and need null, no team, no search, limit 25). Seed: 14 orders, 11 open, 14 runs. The test was deleted: `rowsRead` is stable for a fixed seed, but an upper bound would be pinned to the SQLite planner of the day and fail on an engine bump without a regression behind it.
- (phase 0) rows read, before: count statement 212; page reads 146 (11 + 32 + 30 + 41 + 32); total 358. `EXPLAIN QUERY PLAN` on the old count: `SCAN ShopOrder USING INDEX ShopOrder_open_idx`, every run fragment on `WorkflowRun_orderId_idx` except `DONE_RUN`, which the planner served from `WorkflowRun_status_idx`.
- (phase 0) rows read, after: count statement 123; page reads 146 (unchanged); total 269. Plan: `SCAN o USING INDEX ShopOrder_open_idx`, `SEARCH r USING INDEX WorkflowRun_orderId_idx`, then `SCAN ShopOrder USING INDEX ShopOrder_open_idx` for `facts`. No full scan.
- (phase 2, step 5) The seven sums read a materialised `facts` CTE (one row per open order: `paid`, the four run counters, `choosing`, `team`) rather than restating the correlated fragments in each sum. Each correlated subquery then runs once per order however many sums read it: 123 rows read materialised against 130 without. The predicates over `facts` live in `COUNT_FACT` in `OrderRepository.ts`, beside the fragments they restate.
- (phase 2, step 5) The count statement is not skipped under `shipped` and `cancelled`. Skipping it zeroed the status counts too, so the Status row read "In production · 0" under Shipped while pressing it showed 52. That breaks the `OrderCounts` rule the plan states. Under those statuses the need counts are zero (the status fact is `0`) and the status counts are the open counts. The grid test covers `shipped`.
- (phase 2, step 6) The unrestricted CTE drove from `WorkflowRun_status_idx`, reading every pending, active and done run in the retention window, closed orders included (114 rows on the seed). Adding `orderId in (select id from ShopOrder where OPEN)` did not change the driver; SQLite kept the status index and added a bloom filter (121). What worked: `from ShopOrder o cross join WorkflowRun r on r.orderId = o.id where <OPEN on o>`. `cross join` is SQLite's documented way to fix join order, and the plan is then open orders first, runs by `WorkflowRun_orderId_idx`. On the seed it costs 9 rows more than the unrestricted form. In production it reads the open orders' runs and not the year of closed ones. The `ShopOrder` columns are qualified because `WorkflowRun` has its own `cancelledAt`.
- (phase 2, tests) The plan names `#1012` as the order with one ambiguous item beside one in production. In `seedStates` that order is `#1013`; `#1012` is ambiguous with no runs. The explicit asserts and comments are on `#1013`.
- (phase 2, tests) Besides the per-combination grid (every status including `shipped` × every need × no team or Cut, each count checked against the length of the list its button shows), the tests add "counts cross the two rows" with literal numbers and "a need under All narrows to open orders". `seedNeeds` extends `seedStates` with one blocked run, one reconcile flag, one task on a departed team, and two ready tasks on Cut.
- (phase 1, step 6) `OrderCounts` names the throttle as `INVALIDATION_THROTTLE_MS` in `useSubscribedQuery` in prose, not `{@link}`. The constant is module-private to a client hook, and `Domain.ts` does not import from `src/lib/useSubscribedQuery.ts`.
- (phase 3, step 8) Pressing Shipped also clears `need`. Otherwise a need set before pressing Shipped would keep filtering the list (to nothing: needs are open-only) with the Needs row hidden and no control to clear it. `needsShown` in the route carries the rule.
- (phase 3, step 10) "Needs attention" stays on `AttentionBanner` (`WorkflowSteps.tsx`) and on the workflows index badge. Both describe a workflow's configuration, not an order. The `Domain.ts` vocabulary paragraph now says that on the orders index the same fact is the `team` need with the badge "Needs a team".
- (phase 4) `e2e/fixture.ts` line ~443 still says "Needs attention" banner: it describes the member run list's attention tab for a blocked run, not the orders index team badge, so it is unchanged. The `#1009` comment no longer mentions the removed Not-paid filter.
- (phase 4) The new e2e test searches `#950` before asserting `No workflow · 1` and `Blocked · 1`. The e2e shop also holds the sandbox's imported orders, and the search keeps the counts to the test's two orders. This also covers counts honouring the search on screen.
- (phase 1) `shop-agent-workflows.test.ts` asserted `productionState === "multiple_workflows"` for the seeded ambiguous order. It now asserts `orderNeeds` is `["choose_workflow"]` before the choice and excludes it after. `orders-sync-workflow.test.ts` needed the input rename only.
- (follow-up, added after the plan) Under Shipped, seeded `#1020` showed teams in Waiting on. It is a fulfilled order whose active run reconcile flagged `order_fulfilled`. `waitingOn` and the Team filter left out blocked runs only, so the flagged run's ready task still named its team, although a flag refuses Start and Done and the team cannot move it. Rule added on `Domain.OrderRow.waitingOn`: only an open order waits on a team, the same line `OrderNeed` draws. `waitingRows` joins `ShopOrder` and applies the open gate. `teamFilter` carries `OPEN`, so the cell and the filter stay one fact under All and Shipped. The gate is written once as `openAs(alias)` beside `OPEN`, for statements that also read `WorkflowRun` and so cannot use the bare form (`run_summary` uses it too). Test: "a shipped or cancelled order waits on no team"; it fails with the gate removed. JSDoc aligned on `ListOrdersInput.team`, the repository's `waitingRows` and `teamFilter`, the route's Waiting on cell comment, and the team page's drill-in comment. Flagged runs on _open_ orders ("Order changed") still name their team; leaving those out as well is a separate decision.
- (review, phase 3 step 8) The search chip lived only in the Needs row, so under Shipped the search still applied with no chip to clear it. `searchChip` is one element that ends the Needs row, or the Status row while that row is hidden.
- (review, follow-up) `teamFilter` carries `OPEN`, so under Shipped a set team filtered the list to nothing while the select stayed on screen, and the empty text read "No orders have been fulfilled yet." The Team select now follows the same rule as the Needs row: hidden under Shipped and Cancelled, and cleared when Shipped is pressed. `needsShown` became `openOnlyFiltersShown` and carries both rules; the e2e needs test covers Shipped hiding both, keeping the chip, and All bringing them back.

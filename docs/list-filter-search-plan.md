# Filters and search on the orders index and the workflows list: implementation plan

This plan carries out the fourteen decisions in `docs/list-filter-search-research.md`. Read
that doc first: "What the two screens are, conceptually", "Vocabulary", "Proposals" and
"The keys and the words, again" say why. In one paragraph: the word "view" is retired for
"filter" and "search"; the orders index gets a metrics strip of its five counted values
(each cell a one-click filter) and its search, Status and Team controls in the table's
filter slot with chips for chosen values; the member's workflows list keeps its one axis,
drawn as one joined row, and gets a search in the member bar; URL keys name the axis
(`?position=` on the orders index, `?state=` on both workflows screens) and the literals
match the labels; search on both sides matches order number, item title, variant title
and SKU, ignores the filters, and the screen says so; the member's row shows the variant
title.

What does not change: which orders are open, what an issue is, which state a row falls in
(`viewOf`'s rule, renamed), the counts' rule (they honour the team and nothing else), the
Done or closed window, the keyset paging, the team drill-in from the team page, the
merchant's workflows index behaviour (On, Off, All and its name search).

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A vocabulary word moves in the same change as its symbols: identifiers, types, JSDoc,
    test titles, log messages, label constants, URL keys. The retired word goes on the
    retired list in that change.
  - Status, flag and role predicates are `Domain` functions; `scripts/rules-lint.ts`
    refuses inline comparisons. A Baton field, literal or URL key is never named `status`.
  - The copy and controls tables on `CopySlot` and `Control` in `src/lib/Screen.ts` are the
    screens' spec; a placeholder is "Search by <field>"; a search with nothing matching is
    one sentence and a Clear search button. `pnpm spec check` refuses an example no screen
    shows.
  - A JSDoc never cites a file under `docs/`.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`,
  `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Nothing stored changes: no column, no stored literal, no migration. `RunListRun` gains two
  fields that `Run` already stores. No `pnpm dev:reset` is needed for the schema; run it
  once at the end for the browser check.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go.
- Research docs under `docs/` are dated and are not rewritten. Leave every "view" in `docs/`
  alone.

## The names

One table for every rename and every new name. Literals are snake case, as `not_started`
and `empty_team` are.

| kind                    | where                                                  | from                                                                    | to                                                                                           |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| vocabulary row          | `src/lib/domain/ShopWork.ts`, shop work table          | view                                                                    | filter, count, search, default (four rows; wording in Phase 1)                               |
| retired word            | `scripts/lib/rules-lint.ts` `RETIRED`                  | (none)                                                                  | `\bviews?\b` in screen copy                                                                  |
| reserved stem           | `scripts/lib/rules-lint.ts` `RESERVED_STEMS`           | (none)                                                                  | `view`, with the stem table's why: "retired; a filter, a search, or the member's list state" |
| orders main filter      | `ShopWork.ts`                                          | `OrdersIndexView` (`issues` \| position \| `all`)                       | `OrdersPositionFilter` (position \| `all`); `null` is Open                                   |
| orders issues filter    | `ShopWork.ts` `ListOrdersInput`                        | the `issues` value of `view`                                            | `issues: Schema.Boolean`                                                                     |
| orders labels           | `ShopWork.ts`                                          | `ORDERS_INDEX_VIEW_LABEL`                                               | `ORDERS_FILTER_LABEL` (`open`, the five positions, `all`, `issues`)                          |
| orders input field      | `ShopWork.ts` `ListOrdersInput`                        | `view: NullOr(OrdersIndexView)`                                         | `position: NullOr(OrdersPositionFilter)`, `issues: Boolean`                                  |
| orders URL keys         | `src/routes/app.orders.tsx` `OrdersSearch`             | `q`, `view`, `team`, `after`                                            | `q`, `position`, `issues`, `team`, `after`                                                   |
| search text             | `ShopWork.ts`                                          | `OrderSearch` (order number only)                                       | `ListSearch` (both lists); `OrderSearch` is deleted                                          |
| search normaliser       | `ShopWork.ts`                                          | `normaliseOrderSearch`                                                  | `searchTerm` (returns the order name or the word prefix; rule in Phase 2)                    |
| member main filter      | `ShopWork.ts`                                          | `WorkflowsListView` (`mine`, `teammates`, `upNext`, `blocked`, `done`)  | `WorkflowsListState` (`started_by_you`, `started_by_others`, `ready`, `blocked`, `done`)     |
| member open states      | `ShopWork.ts`                                          | `RunView` (the four open ones)                                          | `RunListState`                                                                               |
| member default          | `ShopWork.ts`                                          | `DEFAULT_WORKFLOWS_LIST_VIEW = "mine"`                                  | `DEFAULT_WORKFLOWS_LIST_STATE = "started_by_you"`                                            |
| which state a row is in | `ShopWork.ts`                                          | `viewOf`                                                                | `listStateOf`                                                                                |
| member query            | `ShopWork.ts` `RunQuery`                               | `team`, `view`, `limit`                                                 | `team`, `state`, `limit`, `q: NullOr(ListSearch)`                                            |
| member counts           | `ShopWork.ts` `RunListCounts`                          | `mine`, `upNext`, `teammates`, `blocked`, `done`, `total`, `teamCounts` | `started_by_you`, `started_by_others`, `ready`, `blocked`, `done`, `total`, `teamCounts`     |
| member row run          | `ShopWork.ts` `RunListRun`                             | omits `variantTitle`, `sku`                                             | keeps both                                                                                   |
| member URL keys         | `src/routes/shop.$shop.tsx` `MemberSearch`             | `view`, `team`, `limit`                                                 | `state`, `team`, `limit`, `q`                                                                |
| member labels file      | `src/lib/workflowsListViews.ts`                        | `VIEWS`, `VIEW_LABEL`, `VIEW_EMPTY`                                     | `src/lib/workflowsListStates.ts`: `STATES`, `STATE_LABEL`, `STATE_EMPTY`                     |
| member row CSS          | `src/styles.css`                                       | `.run-view-row`, `.run-view-row-sticky`                                 | `.run-state-row`, `.run-state-row-sticky`                                                    |
| workflows index filter  | `ShopWork.ts`                                          | `WorkflowsIndexView`                                                    | `WorkflowsIndexState`                                                                        |
| workflows index URL key | `src/routes/app.workflows.tsx` `WorkflowsSearch`       | `view`                                                                  | `state`                                                                                      |
| log field               | `src/lib/agent/ShopWork.ts` `readRuns`                 | `view=`                                                                 | `state=`                                                                                     |
| route locals            | both index routes                                      | `viewButton`, `viewRow`, `selectView`, `VIEWS`                          | `stripCell`, `stateRow`, `selectState`, `STATES`                                             |
| e2e helpers             | `e2e/orders.spec.ts`, `e2e/member-runs.member.spec.ts` | `viewButton`, `view`, `selectView`, `viewKey`, `DEFAULT_VIEW`           | `stripCell`, `stateButton`, `selectState`, `stateKey`, `DEFAULT_STATE`                       |

Screen labels do not change: Open, Not started, Making, Made, Fulfilled, Issues, All,
Started by you, Started by others, Ready, Blocked, Done or closed, Team, Any team, All
teams. New copy: the placeholders "Search by order number or item" (both sides), the
Status select's label "Status" (visible), the search line "N orders match <term>" / "N
workflows match <term>", the heading "No order matches <term>" (exists) and "Nothing
matches <term>" (member), and the button "Clear search".

## Phase 1: the words

### 1.1 The vocabulary (`src/lib/domain/ShopWork.ts`)

Replace the `view` row with four rows in the shop work table:

| word    | meaning                                                                                                   | symbols                                                                                            | screen                                                    |
| ------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| filter  | one axis of a list with a fixed set of values; the list shows the rows matching every chosen filter       | `OrdersPositionFilter`, `WorkflowsListState`, `WorkflowsIndexState`, `ListOrdersInput`, `RunQuery` | the axis name (Status, Team) or the value (Making, Ready) |
| count   | how many rows a filter value would show, given the other filters and never the search                     | `OrderCounts`, `RunListCounts`                                                                     | the number beside the value                               |
| search  | free text matched against a row's order number, item title, variant title and SKU; finds, does not narrow | `ListSearch`, `searchTerm`                                                                         | Search by order number or item                            |
| default | what a list shows with no filter and no search                                                            | `null` position (Open); `DEFAULT_WORKFLOWS_LIST_STATE`                                             | Open; Started by you                                      |

Rewrite the paragraph under the table that says "The merchant's two indexes read the view
row too": each list's main filter is keyed by its axis's word, `?position=` on the orders
index, `?state=` on the workflows index and the workflows list, and the literal is the
label's words. Update the Screens paragraph in `src/lib/Domain.ts` that names
`ORDERS_INDEX_VIEW_LABEL` and `workflowsListViews.ts`.

`pnpm spec check` reads the vocabulary tables and checks each symbol exists; the symbols
above arrive in Phase 2, so run the check at the end of Phase 2, not here.

### 1.2 The lint (`scripts/lib/rules-lint.ts`)

- `RETIRED`: add `/\bviews?\b/iu`. This refuses "view" in screen copy. Check the screens
  for existing copy that says it (grep `view` in JSX text and literals under `src/routes`
  and `src/components`); the research found none, the e2e helpers name it only in
  comments.
- `RESERVED_STEMS`: add `"view"` with a row in the stem table. Run `pnpm lint` to see which
  exports trip: expected only the symbols this plan renames. If an unrelated export carries
  the stem as a substring (`preview`, `review`, `viewer`), add it to
  `RESERVED_STEM_ALLOWED` with a sentence why, and record it under Deviations.
- `test/integration/rules-lint.test.ts`: add the retired-word case for "view" beside the
  existing ones.

### 1.3 The screens' spec (`src/lib/Screen.ts`)

- Copy table, `empty` row: "for a view, echoes the view's label" becomes "for a filter
  value, echoes its label".
- Controls table, "a count of items needing work" row: the control becomes "a cell on the
  strip, or a value of the main filter, with its count; and a badge on each row".
- Controls table: add a row "a search is on" whose control is "the filters are replaced by
  one line saying how many rows match and a Clear search button; the search field stays",
  never "filters that look set but do nothing".
- Copy table, `placeholder` example: "Search by order number or item" is a fine new
  example only if a screen shows it (Phase 5 does).

### 1.4 Done when

`pnpm lint` fails only on the symbols Phase 2 renames.

## Phase 2: the domain

All in `src/lib/domain/ShopWork.ts` unless said.

### 2.1 The orders main filter

```ts
/**
 * The orders index's main filter, on the order's position ({@link orderPosition}):
 * `null` is Open, the default, {@link orderIsOpen}; a position is itself; `"all"` is
 * every stored order, cancelled included, and the only value that reads both open
 * and closed orders. Keyed `?position=` in the URL (`OrdersSearch` in `app.orders.tsx`)
 * because that is the axis's word; the column the merchant reads is headed Status,
 * which is the screen's word for one value per row and not a Baton key
 * (the vocabulary's entry test on `status`).
 *
 * Issues is not a value here: an issue crosses the three open positions, so it is its
 * own filter, {@link ListOrdersInput} `issues`. The two combine (Making and Issues is a
 * legal, often empty, list), and so does Team; a search ignores all three.
 */
export const OrdersPositionFilter = Schema.Union([
  OrderPosition,
  Schema.Literal("all"),
]);
```

`ORDERS_FILTER_LABEL`: `open: "Open"`, the five positions from `ORDER_POSITION_LABEL`,
`all: "All"`, `issues: "Issues"`, typed `Record<OrdersPositionFilter | "open" | "issues", string>`.
The JSDoc on `OrderPosition` and `orderIssues` that says "Issues view" says "Issues filter".

`ListOrdersInput`: `position: Schema.NullOr(OrdersPositionFilter)`, `issues: Schema.Boolean`,
`q: Schema.NullOr(ListSearch)`, `team`, `limit`, `cursor`. Keep the "always send the key"
notes. The `q` JSDoc keeps its rule, reworded: **search ignores the filters**: when `q` is
not null, `position`, `issues` and `team` are not applied.

`OrderCounts` is unchanged (`open`, `issues`, `not_started`, `making`, `made`); its JSDoc's
"pressing that view" becomes "choosing that value", and "a view never narrows its own row"
becomes "a count ignores the main filter and the issues filter, because it describes the
list the merchant can switch to; it honours the team and nothing else".

### 2.2 The search

```ts
/**
 * What a person types into a list's search field, on both sides. Trimmed and capped at
 * 64 characters because it reaches SQL as a `like` pattern. `#` alone (or `##`) is
 * refused: {@link searchTerm} would read it as the order number `#`, a prefix every
 * order shares.
 */
export const ListSearch = trimmedText("ListSearch", 64).check(...)

/**
 * The one reading of a search, used by both repositories and by the screens' "matches"
 * line, so the SQL and the copy agree: digits with an optional leading `#` are an
 * order number, matched whole against `ShopOrder.name` (`1001`, `#1001`, ` #1001 `
 * all mean `#1001`); anything else is a word prefix, matched case-insensitively
 * against the item title, the variant title and the SKU (`sig` finds "Signet ring",
 * `ring` finds it too, `9` is a number and does not). No `field:value`, no operators:
 * the admin's syntax exists because it has forty fields; a list here has four.
 */
export const searchTerm = (q: ListSearch): { kind: "orderName"; name: string } | { kind: "prefix"; text: string }
```

Delete `OrderSearch` and `normaliseOrderSearch`. `OrderSearchParam` in `app.orders.tsx`
becomes `ListSearchParam` or is replaced by `ListSearch` directly; check what it adds.

A word prefix in SQL: `x like ? escape '\'` with `term%` and `% term%`, the term escaped
for `%`, `_` and `\`. One helper, `prefixPatterns(text)`, beside `searchTerm`, used by both
repositories.

### 2.3 The member's main filter

```ts
/** The four states an open run's row can be in, from the member's seat: {@link WorkflowsListState} less Done or closed. */
export const RunListState = Schema.Literals(["blocked", "started_by_you", "started_by_others", "ready"]);

/**
 * The workflows list's main filter: the state of the work from where the member
 * stands, one value at a time. Four hold open runs only ({@link RunState}), grouped by
 * {@link listStateOf}; `done` is the Done or closed window ({@link RecentItem}). The
 * literal is the label's words (`started_by_you` reads Started by you), the
 * stored-literal rule applied to a URL key. Keyed `?state=` because every value is a
 * state word, the task's (`started`, `ready`) or the run's (`blocked`, `done`,
 * `closed`), read from the member's seat; {@link RunState} is the run's own stored
 * state and this is the list's filter, two symbols for two things.
 */
export const WorkflowsListState = Schema.Literals(["started_by_you", "started_by_others", "ready", "blocked", "done"]);
export const DEFAULT_WORKFLOWS_LIST_STATE: WorkflowsListState = "started_by_you";
export const listStateOf = (...): RunListState => ... // viewOf's body, unchanged
```

`RunQuery`: `team`, `state: WorkflowsListState`, `limit`, `q: Schema.NullOr(ListSearch)`.
`sameRunQuery` compares `q` too. `RunListCounts` keys follow the literals. `RunListRun`
keeps `variantTitle` and `sku` (drop them from the `Struct.omit` list). `WorkflowsListData`'s
JSDoc: "exactly one of `items` and `recent` is populated" becomes "without a search
exactly one is populated; under a search `items` holds the open matches whatever their
state and `recent` the Done or closed matches, so a member who marked the wrong thing
done can find it by number".

`WorkflowsIndexState` replaces `WorkflowsIndexView`, same literals, JSDoc says the key is
`?state=` and All is absent.

### 2.4 Done when

`pnpm typecheck` passes for `src/lib/domain/`; the rest of `src/` fails only on the
renamed names. `pnpm spec check` accepts the four vocabulary rows.

## Phase 3: the repositories and the object

### 3.1 `src/lib/OrderRepository.ts` `listOrders`

- The `view` switch becomes two fragments: `positionFilter` (`null` is `orderIsOpen`'s
  SQL, a position its branch, `all` nothing) and `issuesFilter` (the union of the issue
  predicates, as the `issues` view's SQL is today). Both combine with `teamFilter`.
- The search fragment reads `searchTerm`: `orderName` is `name = ?`; `prefix` is an
  `exists` over the order's items on title, variant title and SKU with
  `prefixPatterns`. A search applies alone, as today.
- The count statement is unchanged in shape: `open`, `issues` and the three positions,
  narrowed by the team only. Its JSDoc's "view" words become "filter value".

### 3.2 `src/lib/RunRepository.ts` `listRuns` (the member read)

- Rename the locals (`byView`, `inView`) and the count keys.
- `q` set: skip the state grouping for the returned rows. `items` is every open run the
  member's teams can see whose order name equals the term or whose item title, variant
  title or SKU has the prefix, sorted by `byAge`, cut to `limit`; the counts are still
  computed over the ungrouped rows (they ignore the search). `listRecent` takes the same
  `q` and returns the window's matches.
- The team filter is skipped under a search, as the orders side does.

### 3.3 `src/lib/agent/ShopWork.ts`

- `listOrders` and `subscribeOrders` pass the new input through; the `onExcessProperty:
"error"` parse now expects `position` and `issues`.
- `readRuns`: when `query.q` is set, read `listRecent` with the term and the real limit
  as well, so both halves come back; the log line says `state=` and `q=<set|null>` (never
  the text, which is unbounded).

### 3.4 Done when

`pnpm typecheck` passes outside `src/routes/` and `e2e/`. The integration tests in Phase 6
are what pin this phase; write them with it if that is easier.

## Phase 4: the orders index

### 4.1 `src/routes/app.orders.tsx`

`OrdersSearch`: `q`, `position`, `issues` (a lenient boolean: `"1"` is true, anything else
absent), `team`, `after`; `retainSearchParams` lists the five. The JSDoc's `?view=` paragraph
becomes the `?position=` and `?issues=` one, with the search rule.

### 4.2 `src/routes/app.orders.index.tsx`

Layout, top to bottom inside the orders section:

1. **The strip.** The metrics-card composition
   (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/metrics-card.md`): an
   `s-grid` of five `s-clickable` cells, each an `s-heading` (Open, Not started, Making,
   Made, Issues) over the count from `OrderCounts`. Clicking sets the filter: Open sets
   `position: null, issues: false`; a position sets `position`; Issues sets `issues: true`
   and leaves `position`. The cell whose value is set gets `background="subdued"` and
   `aria-current="true"` (`s-clickable` has no `pressed`; record under Deviations if the
   attribute does not reach the native element and use a visible mark instead). A count
   always renders, at zero if need be. The grid wraps to two or three columns under
   `@container` the way the composition shows.
2. **The filter slot.** `s-table`'s `slot="filters"` holds one `s-grid`: the
   `s-search-field` (label "Search", placeholder "Search by order number or item"), the
   Status `s-select` (label "Status", values Open, Not started, Making, Made, Fulfilled,
   Cancelled, All; Open is `""`), the Team `s-select` (as today, "Any team"). The
   "Team" text label goes; the select's own label is visible now, as Status's is.
3. **The chips.** Under the filter row, one `s-clickable-chip removable` per chosen value:
   the position's label when not Open, "Issues" when set, the team's name when set.
   Removing one clears that filter. No chips when nothing is chosen.
4. **Under a search.** The strip and the chips are not rendered; in their place one line,
   "N orders match <term>" (the term as `searchTerm` prints it: `#1001` or the typed
   text), and a "Clear search" `s-button`. The selects are disabled. Clearing restores the
   filters the URL kept.
5. **The table.** Unchanged columns. The empty copy per filter: `emptyText(position,
issues, team)` keeps one sentence per value; with Issues set and a position set, "No
   <position> orders have issues."; with a team set, "No orders match these filters."
   The search's empty state is the existing heading "No order matches <term>" plus the
   Clear search button (the controls table's rule).

Delete `viewButton`, the `VIEWS` constant and the press-button row. Keep the sync button,
the banners, `neverStored`, the paging and the subscription as they are.

### 4.3 `src/routes/app.teams.$teamId.tsx`

The drill-in link `/app/orders?team=` is unchanged.

### 4.4 Done when

The orders index renders with the strip, the filter slot and chips; `pnpm typecheck` and
`pnpm lint` pass for the route. The e2e tests come in Phase 6.

## Phase 5: the workflows list and the workflows index

### 5.1 `src/lib/workflowsListStates.ts` (renamed from `workflowsListViews.ts`)

`STATES` in row order, `STATE_LABEL` with the same five labels, `STATE_EMPTY` with the
same five sentences. The JSDoc keeps its reasoning (why the order, why each label) with
"view" replaced by "state" or "value". Add `SEARCH_EMPTY = "Nothing matches"` for the
search's empty line, built as "Nothing matches <term>".

### 5.2 `src/routes/shop.$shop.tsx`

`MemberSearch`: `state` (unreadable reads as the default), `team`, `limit`, `q`
(`ListSearch`, unreadable reads as absent); `retainSearchParams` and `stripSearchParams`
updated. The `?tab=` paragraph in its JSDoc becomes "an old `?view=` or `?tab=` lands on
the default".

The member bar (`MemberBar`) gets the search field beside the team menu: an
`s-search-field` (label "Search", placeholder "Search by order number or item"), value from
`q`, submitted on blur or Enter and on being emptied, as the orders index does. On a phone
the bar wraps the field under the shop name; check at 420 px.

### 5.3 `src/routes/shop.$shop.workflows.index.tsx`

- Rename `view` to `state` throughout; `selectState`, `stateRow`, `STATES`.
- **The joined row.** The five `s-press-button`s stay, in `.run-state-row`. The CSS
  (Phase 5.4) removes the gaps and the inner corners so the five read as one control.
- **Line one of a row.** `lineItemTitle`, then `·` and `variantTitle` when it is not
  null, then the workflow and the order as today. `runRowLine` is unchanged.
- **Under a search.** The state row is not rendered; one line "N workflows match <term>"
  with a Clear search button, where N is `items.length + recent.length`. Rows: the open
  matches, then a divider and the Done or closed matches rendered with the existing
  `recent` row. "Nothing matches <term>" when both are empty. The team menu stays in the
  bar but is disabled under a search.
- `showTeam` is true under a search whatever `team` says, since the rows span teams.

### 5.4 `src/styles.css`

`.run-view-row` and `.run-view-row-sticky` become `.run-state-row` and
`.run-state-row-sticky`. The grid stays (three, two, one columns by width, the reasoning
comment kept). The join is `gap: 0` with a shared border: each button loses its inner
corners (`border-radius: 0`) and the row's outer corners keep the radius, with a `1px`
divider between neighbours. Because the row wraps by width, the outer corners are set
per breakpoint, where the grid already knows which cell is first and last in each line.
`s-press-button` draws its border in its shadow root; if its custom properties do not
reach the radius, the fallback is the `0.375rem` gap kept and a stronger pressed fill so
the chosen value is unmistakable. Try the join first and record the outcome under
Deviations.

### 5.5 `src/routes/app.workflows.tsx` and `app.workflows.index.tsx`

`WorkflowsSearch` key `view` becomes `state`; `WorkflowsIndexState`; the locals rename.
The JSDoc that says "the vocabulary's view row" says "the list's main filter, keyed by the
axis". Behaviour unchanged.

### 5.6 `src/components/MemberRun.tsx`, `src/routes/shop.$shop.workflows.$runId.tsx`

Comments only: "the pressed view" becomes "the chosen state".

### 5.7 Done when

Both screens render; `pnpm typecheck` and `pnpm lint` pass across `src/`.

## Phase 6: the tests

### 6.1 Unit (`test/integration/domain.test.ts`)

- `Domain.viewOf` describe becomes `Domain.listStateOf`; same cases, new literals.
- `sameRunQuery`: a case for `q`.
- `searchTerm`: "digits with an optional # are an order number", "anything else is a
  word prefix", "# alone is refused by ListSearch".

### 6.2 Integration

- `test/integration/order-repository.test.ts`: the `view` cases become `position` and
  `issues` cases; add "Making and Issues combine", "a search by item title finds the order
  whatever the filters", "a search by SKU", "a search by variant title", "a count ignores
  the search and the main filter and honours the team" (retitled from the view wording).
- `test/integration/run-repository.test.ts`: the literals; "under a search items hold the
  open matches across states and recent the Done or closed matches"; "the counts ignore
  the search".
- `test/integration/shop-agent-workflows.test.ts`, `member-runs-socket.test.ts`: the
  `RunQuery` shape.
- `test/integration/search-params.test.ts`: unchanged unless the lenient boolean needs a
  case; add one for `issues`.
- `test/integration/rules-lint.test.ts`: Phase 1.2.

### 6.3 End to end

- `e2e/orders.spec.ts`: `viewButton` becomes `stripCell` (by heading text, reading the
  count from the cell) and a `statusSelect` helper. The search test asserts the strip is
  gone and the "match" line shows, then that Clear search brings the strip back with the
  kept filter. The counts test ("each count is what choosing it shows, given the team")
  reads the strip. The Issues test reads `?issues=1`. Add "Making and Issues combine" and
  "a chip removes its filter".
- `e2e/member-runs.member.spec.ts`: `?view=` becomes `?state=`, literals renamed,
  `selectState`. Add "search by order number finds the item whatever state is chosen" and
  "line one shows the variant title". Run against the seed; `e2e/fixture.ts` comments
  updated.
- `e2e/workflows.spec.ts`: `?state=`.
- `e2e/app.ts`: the example path.

### 6.4 Done when

`pnpm test` and `npm run test:e2e --` pass.

## Phase 7: check it in the browser

`pnpm dev:reset`, then on `sandbox-shop-NN`:

1. Orders index: the strip's five counts match the table under each cell; Making plus
   Issues shows the blocked and team-gap orders only; the chips remove; a search for a
   number, a title prefix and a SKU each find the order under any filter, the strip is
   replaced by the match line, Clear search restores the filter.
2. Team page: Open team orders lands on `?team=` with the chip showing the team.
3. Workflows list, as a member on two teams, on a desktop width and at 420 px: the row
   reads as one control, the variant shows on line one, the search in the bar finds a
   started, a ready and a done item by number and by title, the team menu is disabled
   under a search.
4. Workflows index: On, Off, All at `?state=`.
5. A bookmark with `?view=` on each screen lands on the default.

## Deviations and issues

Record here, as they happen, anything that did not go as the plan says: a name the lint
or the spec check refused, a Polaris attribute that did not reach the native element, a
layout that did not hold at 420 px, a test whose title had to change, a decision the plan
got wrong. One entry per item, with what the plan said, what happened, what was done
instead and why. Leave the plan's own text as written; the deviation is the record.

| #   | phase | what the plan said                                                           | what happened                                                                                                                                                                                                                                                                                     | what was done instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 1.2   | `RETIRED` adds `/\bviews?\b/iu`; the research found no screen copy saying it | The lint refused "View in Shopify", the link out on the orders index rows and the order page                                                                                                                                                                                                      | `/\bviews?\b(?! in Shopify\b)/iu`: the verb on a link out stays, the noun is refused; the lint table row and the rules-lint test say so                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | 1.2   | `RESERVED_STEMS` `view` may trip `preview`, `review`, `viewer`               | Nothing tripped: `viewer` is a parameter, not an export                                                                                                                                                                                                                                           | No `RESERVED_STEM_ALLOWED` entry. Risk 1 closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | 1.3   | Screen.ts tables only                                                        | `Control` had a `view` literal                                                                                                                                                                                                                                                                    | Renamed to `filter`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4   | 2.2   | `searchTerm(q: ListSearch)`, `prefixPatterns`                                | The member read filters open runs it already holds, in TypeScript; the screens print the term                                                                                                                                                                                                     | `searchTerm` takes a string; added `SearchTerm`, `searchTermText` (what the match line prints) and `searchMatches` (the TypeScript twin of the SQL, ASCII case folding only, so the two agree). Risk 6 confirmed and noted on `searchTerm`                                                                                                                                                                                                                                                                     |
| 5   | 2.3   | `listStateOf`, `RunQuery.state`                                              | `scripts/rules-lint.ts` refused `query.state === "done"` in `RunRepository` and the object                                                                                                                                                                                                        | Added `Domain.workflowsListStateIsDone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | 2.4   | `pnpm spec check` may refuse struct names in the `symbols` cell              | It accepted them                                                                                                                                                                                                                                                                                  | Risk 4 closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | 3.1   | Order number search was a prefix                                             | The plan says an order number matches whole                                                                                                                                                                                                                                                       | `name = ?`; the tests "is a prefix, so #10 takes …" and "is case-insensitive, so ab takes #AB1001" became "an order number matches whole, so #10 takes nothing" and the item-word cases                                                                                                                                                                                                                                                                                                                        |
| 8   | 3.3   | `readRuns` reads `listRecent` with the term and the real limit               | The Done or closed count is team-narrowed while a search ignores the team                                                                                                                                                                                                                         | Under a search `listRecent` is read twice: the count over the narrowed teams with no term, the rows over every team with the term                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | 4.1   | `OrderSearchParam` becomes `ListSearchParam` or is replaced                  | Both layouts read `?q=`                                                                                                                                                                                                                                                                           | `ListSearchParam` moved to `src/lib/searchParams.ts`, beside `lenientSearchKey`, rather than exported from a route                                                                                                                                                                                                                                                                                                                                                                                             |
| 10  | 4.2   | "N orders match <term>"                                                      | One page holds at most 25 rows, so N was unknown                                                                                                                                                                                                                                                  | Added `OrdersPage.matches`, a count read only under a search. Nothing stored                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 11  | 4.2   | The filter grid in the table's `filters` slot                                | The table is not rendered when the list is empty, which would take the controls that emptied it away                                                                                                                                                                                              | In the slot when there are rows, above the empty sentence when there are none. The field is `ListSearchField` (`src/components/`), shared with the member bar; its Enter listener follows the element, so a remount keeps it                                                                                                                                                                                                                                                                                   |
| 12  | 4.2   | `@container` columns                                                         | Commas inside a track list (`repeat(5, …)`, `minmax(0, …)`) split the responsive value, and the queries had no container                                                                                                                                                                          | Comma-free track lists, each grid wrapped in `s-query-container`. Strip: five columns above 600 px, three below                                                                                                                                                                                                                                                                                                                                                                                                |
| 13  | 4.2   | `aria-current` on the chosen cell                                            | Risk 2 confirmed: it stays on the `s-clickable` host; the native button in the shadow root never gets it                                                                                                                                                                                          | Removed. The chosen cell is filled (`background="subdued"`) and named by a chip                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 14  | 4.2   | Status select, Open is `""`                                                  | An `s-option` with an empty value takes its label as the value                                                                                                                                                                                                                                    | Open's value is `"open"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | 4.2   | Empty copy for Issues with a position                                        | Issues with All or Fulfilled or Cancelled needed a sentence                                                                                                                                                                                                                                       | With Open or All: "No open orders have issues."; with Fulfilled or Cancelled: "A fulfilled or cancelled order has no issues."; with an open position: "No <position> orders have issues."                                                                                                                                                                                                                                                                                                                      |
| 16  | 5.2   | The search field in the member bar                                           | The bar's start was an inline `s-stack`, which squeezed the shop name; a cap on the `s-search-field` host did not take                                                                                                                                                                            | `.member-bar-start` is a wrapping flex row that grows into the bar; the field sits in `.member-bar-search` (basis 14rem, cap 22rem). One line at 1280 px, under the shop name at 420 px. Risk 5 closed                                                                                                                                                                                                                                                                                                         |
| 17  | 5.3   | Line one: title, then variant                                                | Done or closed rows name the item too                                                                                                                                                                                                                                                             | `itemTitle` on every row kind, open, done and closed                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 18  | 5.4   | Join the five buttons                                                        | Risk 3: the radius is reachable only through a build-hashed private custom property (`--p-border-radius-action-…`); joined in a wrapping grid the last line's empty cell leaves a hole and neighbours double their borders. Polaris's segmented control (`s-button-group gap="none"`) cannot wrap | Kept the 0.375rem gap. The pressed fill is unchanged: it is already distinct, and strengthening it needs the same private properties. Reasoning on `.run-state-row` in `styles.css`                                                                                                                                                                                                                                                                                                                            |
| 19  | 6.3   | "line one shows the variant title" against the seed                          | The seed wrote `variantTitle` and `sku` as `null`                                                                                                                                                                                                                                                 | `SeedOrdersInput` items and the dev seed route take optional `variantTitle` and `sku`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | 5.4   | Deviation 18 kept the gap                                                    | Review (2026-10-02): the JSDoc on `WorkflowsListState` and the state-row comment in the route still said the five were joined                                                                                                                                                                     | Both say the gap stays and point at `.run-state-row` for why                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 21  | 4.2   | Deviation 13 dropped `aria-current`                                          | Review: the chosen cell had no accessible mark at all; the fill and the chip are visual                                                                                                                                                                                                           | The cell's `accessibilityLabel` ends ", selected" when chosen; it reaches the native button where `aria-current` did not; `stripCell` in `e2e/orders.spec.ts` allows the suffix and `stripChosen` asserts it                                                                                                                                                                                                                                                                                                   |
| 22  | 2.2   | Deviation 4 made `searchTerm` take a `string`                                | Review: every caller holds a `ListSearch`, so the widening bought nothing and let an unvalidated string reach the `like` pattern                                                                                                                                                                  | `searchTerm(q: ListSearch)`; the domain tests decode first                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 23  | 2.3   | Deviation 5 added `Domain.workflowsListStateIsDone`                          | Review: the route still compared `state === "done"` inline twice; the lint does not see a comparison on a URL value                                                                                                                                                                               | The route reads the predicate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 24  | 6.2   | A search-params case for `issues`                                            | Review: none was added                                                                                                                                                                                                                                                                            | Added: "a flag key reads 1 as on and anything else as absent"                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 25  | 4.2   | (none)                                                                       | Review: the query key's JSDoc had drifted onto `issuesKeyOf`; the member match line printed `String(n)` where the orders line prints `formatNumber(n)`                                                                                                                                            | Moved; `formatNumber` on both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 26  | 2.2   | Digits are an order number                                                   | Review: a SKU that is all digits can never be found, since the term reads as an order number and matches the name whole. By design, not a defect                                                                                                                                                  | Nothing; recorded so the gap is known if a shop's SKUs are numeric                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 27  | 5.3   | "N workflows match" where N is `items.length + recent.length`                | Review: each half is cut to `limit` and there is no Show more under a search, so N can be the page and not the matches, and a match past the cut is unreachable. The orders side counts every match (deviation 10)                                                                                | Mirrored deviation 10: `WorkflowsListData.matches` (open matches before the cut from `listRuns`, plus `listRecent`'s `total`, which `q` now narrows too; the state row's Done or closed count is read with no term) and Show more under a search deepens both halves. Pinned by "a search cuts at a page, counts every match, and pages on Show more" (e2e) and "the match count is every match before the cut" (repository). Deviation 1 stays as is: "View in Shopify" is Shopify's own wording for the link |

Known risks going in, each to be confirmed or closed here:

1. `RESERVED_STEMS` `view` may trip an unrelated export (`preview`, `review`, `viewer`).
2. `s-clickable` may not carry `aria-current` through its shadow root; the strip's chosen
   cell then needs a visible mark of its own.
3. `s-press-button`'s shadow root may not expose border radius for the joined row.
4. `pnpm spec check` may refuse a vocabulary row whose `symbols` cell lists a struct field
   (`ListOrdersInput`, `RunQuery`); if so, list the structs only.
5. The member bar may not fit the shop name, the team menu and a search field on a phone;
   the field may need to collapse to an icon that opens it.
6. SQLite `like` is case-insensitive for ASCII only; a title with accented letters matches
   on exact case. Acceptable; note it on `searchTerm` if confirmed.

## Status

Done (2026-10-01), all seven phases, not committed. `pnpm typecheck`, `pnpm lint` (with
`pnpm spec check`), `pnpm test` (662) and `npm run test:e2e` (71) pass after `pnpm dev:reset`.
The orders index and the workflows list were checked in the browser, the list at 1280 and
420 px. Deviations above.

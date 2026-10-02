# Plan: a metrics strip and a filter row on the workflows list

Written 2026-10-02 from the decisions in `docs/workflows-list-strip-research.md`. It is for
an agent that has not seen that research. Read the research's "What the strip would
change" and "Decisions" sections first; this plan does not repeat the reasoning, only what
to change and in what order.

## Before you start

- Read `AGENTS.md`. The rules that bite here: JSDoc carries its reasoning and never cites
  `docs/`; a control change starts at the controls table on `Control` in
  `src/lib/Screen.ts`; use the vocabulary's words ("workflow" on screen, "state", "filter",
  "search", "count"); never hand-format, run `pnpm fmt` and keep everything it touches;
  do not commit unless told to.
- Start the task with `git merge --ff-only main` in the worktree.
- Model the new code on the orders index, `src/routes/app.orders.index.tsx`: `stripCell`,
  the strip's `s-query-container` / `s-grid`, `filters`, and `searchLine`. Copy its shape;
  do not import from it (it is a route).
- The screen is `shop.$shop.workflows.index.tsx`, called "the workflows list" in JSDoc and
  tests (the Screens table in the vocabulary).

## What changes, in one table

| piece                     | today                                                                                     | after                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| state filter              | `stateRow`: five `s-press-button` in `.run-state-row`, label "Ready · 77", sticky wrapper | `strip`: five `s-clickable` cells, `s-heading` label over `s-text` count, chosen cell `background="subdued"` |
| layout of the filter      | CSS grid, 3 / 2 / 1 columns by media query                                                | `s-query-container` + `s-grid`, five columns over 600px of container, three below, as on orders              |
| sticky                    | `.run-state-row-sticky`                                                                   | none                                                                                                         |
| search                    | `ListSearchField` in `MemberBar`'s `filter` slot, wrapped in `.member-bar-search`         | `ListSearchField` in a filter row in the section, under the strip                                            |
| team                      | `teamMenu`: `s-button` + `s-menu`, "All teams", items "Casting · 12"                      | `s-select` labelled "Team", first option "Any team" (value `""`), then team names only; hidden for one team  |
| `MemberBar`               | `filter` prop, `.member-bar-start` wraps it                                               | no `filter` prop                                                                                             |
| `Domain.RunListCounts`    | five state counts, `total`, `teamCounts`                                                  | five state counts                                                                                            |
| `Domain.RunListTeamCount` | exported struct                                                                           | deleted                                                                                                      |
| under a search            | state row hidden, "N workflows match …" + Clear search, team menu disabled                | strip hidden, same line, Team select disabled                                                                |

Nothing else changes: the states, their order and labels (`STATES`, `STATE_LABEL`), the
`?state=`, `?team=`, `?limit=`, `?q=` keys, `MemberSearch` in `src/routes/shop.$shop.tsx`,
the read's state counts, the search and what it matches, the empty states and their "Go to"
button, the rows.

## Phase 1: the spec

### 1.1 The controls table (`src/lib/Screen.ts`, JSDoc on `Control`)

Read the table. The row "a count of items needing work" already says "a cell on the strip,
or a value of the main filter, with its count", which now holds on both screens, so no row
should need to change. If any row or the tone list names the press-button row, the state
row or the member bar as where a filter lives, change that row first. Run `pnpm spec check`.

### 1.2 The vocabulary

`grep -rn "state row" src` finds the phrase in `src/lib/Domain.ts`,
`src/lib/domain/ShopWork.ts`, `src/lib/agent/ShopWork.ts`, `src/lib/RunRepository.ts`,
`src/lib/workflowsListStates.ts` and `src/styles.css`. The orders index calls its control
"the strip". Replace "state row" with "strip" in each JSDoc, keeping the sentence true (the
strip is not sticky, is not a grid of buttons). If the vocabulary table at the top of
`src/lib/domain/ShopWork.ts` has a row naming the state row, update it in the same change
(`docs/vocabulary-runbook.md` is the procedure). Do not touch `refs/`.

## Phase 2: the read

### 2.1 `src/lib/domain/ShopWork.ts`

- Delete `RunListTeamCount` and its type.
- Remove `total` and `teamCounts` from `RunListCounts`.
- Rewrite the JSDoc on `RunListCounts`: the five counts after `query.team` narrows them and
  never the search. Drop the sentence about `total` and `teamCounts` and the team select not
  moving under the finger; the select now shows names only, so nothing on it moves.

### 2.2 `src/lib/RunRepository.ts`

- In `listRuns`, delete the `teamCounts` computation and the `total` and `teamCounts` fields
  of the returned `counts`. `items` is still needed for `narrowed` and the search.
- Fix the JSDoc that says "`teamCounts` and `total` are over all of `teamIds` whatever
  `query.team`" (near the `listRuns` declaration in the repository's interface). The type
  there is `Omit<Domain.RunListCounts, "done">`; it stays.

### 2.3 `src/lib/agent/ShopWork.ts` and anything else the compiler names

`pnpm typecheck` lists every use of the removed fields. Remove each; none should need a
replacement.

### 2.4 Tests (`test/integration/run-repository.test.ts`)

Two tests assert team counts:

- "listRuns counts the whole state and returns only the limit; the team counts ignore the
  narrowing" (around the `capped.counts.teamCounts` assertion).
- "listRuns narrows rows and their tasks to one team, and a team the member is not on reads
  empty" (the `onlyA.counts.teamCounts` and `foreign.counts.teamCounts` assertions).

Remove the team-count assertions and keep the rest of each test. Retitle the first to drop
"the team counts ignore the narrowing" since that rule no longer exists. Neither title is
pinned by a spec table (checked 2026-10-02), but run `pnpm spec check` after renaming to be
sure.

### 2.5 Done when

`pnpm typecheck` passes except in `src/routes/shop.$shop.workflows.index.tsx`, and
`pnpm test test/integration/run-repository.test.ts` passes.

## Phase 3: the screen

### 3.1 `src/components/MemberBar.tsx`

- Remove the `filter` prop and its JSDoc paragraph ("`filter` is a slot beside the shop…").
- Remove `{filter}` from `.member-bar-start`. Keep the `div` only if it still does work
  (it holds the home link); if it does not, render the link directly and delete the class
  in 3.3.
- Remove the `import type * as React` if nothing else uses it.

### 3.2 `src/routes/shop.$shop.workflows.index.tsx`

1. **The strip.** Replace `stateRow` with `strip`, a function per cell modelled on
   `stripCell` in `app.orders.index.tsx`:
   - `s-clickable` with `paddingBlock="small-400"`, `paddingInline="small-100"`,
     `borderRadius="base"`, `background={chosen ? "subdued" : "transparent"}`.
   - `accessibilityLabel={`${STATE_LABEL[each]}, ${formatNumber(n)}${chosen ? ", selected" : ""}`}`.
     Use `formatNumber` for the count, as orders does.
   - Children: `s-grid gap="small-300"` holding `s-heading` (the label) and `s-text` (the
     count).
   - `onClick` calls `selectState(each)`. No `event.currentTarget.pressed` reset; that was
     for `s-press-button`.
   - Wrap the cells as orders does:
     `<s-query-container><s-grid gridTemplateColumns="@container (inline-size > 600px) 1fr 1fr 1fr 1fr 1fr, 1fr 1fr 1fr" gap="small">`.
     The page is `inlineSize="small"`; check whether five columns ever fit (see Issues, 1).
   - JSDoc on the strip: it is the state filter, one axis, so no State select and no chips;
     the chosen cell is filled and its label says "selected" because `aria-current` does not
     reach the native button inside `s-clickable` (copy the reason from `stripCell`); a
     count always renders, at zero too; no cell is red, for the reason the old JSDoc gave
     for Blocked. Keep the existing sentence about zero-count states staying enabled.
2. **The team select.** Replace `teamMenu` and its JSDoc and `teamMenuId`:
   - Render only when `teams.length > 1`.
   - `s-select label="Team" value={team ?? ""} disabled={q !== null}`; `onChange` reads
     `event.currentTarget.value` and calls `selectTeam(teams.find(({ id }) => id === value)?.id ?? null)`.
   - First option `<s-option value="">Any team</s-option>`, then one `s-option` per team
     with the name only.
   - `team` here is already resolved against the member's teams (an id they are not on reads
     as `null`); keep that. Do not add the orders index's "Deleted team" option (see
     Deviations, 2).
   - Delete `teamCount`.
   - JSDoc: why a select (as orders: the team list is unbounded), why names only (a count in
     the closed select would count something different from the strip beside it), why
     hidden for one team, why disabled under a search (`Control` in `Screen.ts`).
3. **The filter row.** A new `filterRow` under the strip: `s-query-container` +
   `s-grid gridTemplateColumns="@container (inline-size > 480px) 1fr 12rem, 1fr" gap="small-300" alignItems="end"`
   holding `ListSearchField` (`value={q}`, `onSubmit={setSearch}`) and the team select. With
   one team, render `ListSearchField` alone, full width. Pick the breakpoint by looking (see
   Phase 5); 480px is a starting point. It renders whether or not a search is on, so the
   field stays where the member typed.
4. **`renderBody`.** Order: the strip (only when `term === null`), then the filter row, then
   `renderSearch(term)` or `renderRuns()`. Drop the `.run-state-row-sticky` wrapper and its
   comment. `renderSearch` keeps its match line and Clear search unchanged.
5. **`MemberBar`.** Pass only `shop` and `email`.
6. **JSDoc elsewhere in the file** that says the team filter and search are in the member
   bar, or that the state row is sticky, or names `s-press-button`: rewrite to match. The
   comment above `s-page` about the missing heading should now say the strip says the
   page's subject, not the state row.
7. Keep "Go to Ready · N" in `renderEmpty`. Its JSDoc says "Go to" keeps it from being
   confused with "the state-row button above it"; make that "the strip cell above it".

### 3.3 `src/styles.css`

Delete `.run-state-row-sticky`, `.run-state-row` and its two media queries, and
`.member-bar-search`, with their comments. Reword `.member-bar-start`'s comment (it no
longer holds the screen's controls) or delete the rule if 3.1 removed the `div`.

### 3.4 `src/lib/workflowsListStates.ts`

JSDoc only: the order comment mentions the phone's two-column row pairing the Started
states. The strip is three columns on a phone (Started by you, Started by others, Ready;
then Blocked, Done or closed), so the Started states still sit side by side; say that.

### 3.5 Done when

`pnpm typecheck` and `pnpm lint` pass.

## Phase 4: the e2e tests

`e2e/member-runs.member.spec.ts` and `e2e/member-area.member.spec.ts`.

1. **Finding a state.** `stateButton` matches `^${label} · \d+$`. The cell's accessible
   name is now `${label}, ${n}` with ", selected" on the chosen one. Change the matcher to
   `new RegExp(`^${label}, [\\d,]+(, selected)?$`, "u")`, and rename it `stateCell`.
   Every `getByRole("button", { name: `${READY} · 0` })` style assertion becomes a name of
   the form `${READY}, 0`(allowing the ", selected" suffix where the cell is chosen; a
helper`stateCount(page, label, n)`that builds the regex keeps this readable).`s-clickable`without`href`renders a native`button`in its shadow root, so the role
stays`button`; confirm by running one test before rewriting all of them.
2. **The chosen state.** `selectState` waits for `aria-pressed="true"`. Wait for the name
   to end in ", selected" instead. The same at the two `aria-pressed` assertions after
   Clear search.
3. **The team.** Replace `getByRole("button", { name: "All teams", exact: true }).click()`
   followed by a click on the team's name with
   `page.getByRole("combobox", { name: "Team" }).selectOption({ label: CUT_TEAM })` (check
   the role `s-select` exposes; orders' e2e specs show how they drive its Team select, copy
   that). Assertions that the button reads "All teams" become assertions that the select's
   value is `""` or that its selected option reads "Any team".
4. **The layout test** "the states are a grid that never scrolls and the team filter sits
   in the member bar" asserts `.run-state-row`'s grid and the team menu's place in the bar.
   Its rules are gone. Replace it with a test of the new rule: at 375px wide the strip does
   not overflow its section and the search field and Team select are inside the section,
   not inside `.member-bar`. Title it with the rule, for example "the strip never scrolls
   and the search and team sit in the section".
5. **`.run-state-row` locators** (one asserts it has count 0 under a search): locate the
   strip by a class or `data-testid` you add in 3.2, or by the absence of the cells.
6. Comments in the specs that mention the state row, `s-press-button` or `aria-pressed`
   are rewritten to match.
7. "a team the member is no longer on reads as all teams": keep the rule, retitle to "…
   reads as any team", and assert the select's value is `""`.

Run `npm run test:e2e -- e2e/member-runs.member.spec.ts e2e/member-area.member.spec.ts`
until it passes. The dev server must be running (`pnpm dev:start`).

## Phase 5: look at it

Render the workflows list with `pnpm playwright-cli` (see `AGENTS.md`, Playwright CLI;
wait for `body[data-hydrated="true"]`) at 320, 375, 768 and 1280 wide, with a member on
several teams and a member on one team, with and without a search. Screenshot each. Check:
the strip never scrolls sideways; long labels ("Started by others", "Done or closed") wrap
inside their cell without moving the count; the chosen cell is visible; the filter row
breaks to two lines on a phone; nothing is in the member bar but the shop, the email and
Sign out. Adjust the two grid breakpoints if needed and say why in the JSDoc.

## Phase 6: finish

`pnpm fmt`, then `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`, and
the two e2e specs. Keep every file `pnpm fmt` touches. Do not commit unless told to.

## Deviations from the orders index

These are deliberate. Say each in the JSDoc where it applies.

1. **No State select.** Orders has one because Fulfilled, Cancelled and All are not on its
   strip. Every member state is on the strip, so a select would be a second control for the
   same axis.
2. **No "Deleted team" option.** Orders keeps an unknown `?team=` and shows "Deleted team"
   so the select does not read "Any team" over an empty list. The workflows list already
   resolves an id the member is not on to `null`, so the list really is every team and
   "Any team" is true. Keep the member's rule; it is pinned by the e2e test in Phase 4, 7.
3. **No chips.** Orders' chips name filters its strip cannot show. Here the chosen state is
   the filled cell and the team is the select's value.
4. **Team select hidden for one team.** Orders always shows it; a merchant always has the
   choice of any team. A member on one team has no choice to make.
5. **Five cells including history.** Orders keeps history (Fulfilled, All) off the strip
   and uncounted. Done or closed stays a cell with its count: it is the member's undo and
   its count is bounded to the last day.
6. **No page heading.** Orders has "Orders". The workflows list keeps none, as today, for
   the bench tablet's height.

## Issues to watch

1. **Five columns may never fit.** The page is `inlineSize="small"`, and the strip's
   container is the section inside it. If the section is under 600px at every viewport the
   strip is always 3 + 2. That is acceptable but means the five-column branch is dead; if so,
   lower the breakpoint to what five labels need (measure "Started by others" as an
   `s-heading`) or state in the JSDoc that 3 + 2 is the layout.
2. **The selected cell is a light mark.** `background="subdued"` is fainter than the pressed
   fill. If it is hard to see in Phase 5's screenshots, report it rather than inventing a new
   style; the orders strip has the same mark and should change with it.
3. **`s-clickable` and the rows.** The rows below are also `s-clickable` (as links). A
   strip cell has no `href`, so it renders a button; check in the accessibility tree that
   the cells are buttons and the rows are links, or the e2e role queries will match the
   wrong thing.
4. **The search field's width.** `.member-bar-search` capped it at 22rem in the bar. In the
   section it fills its grid track; check it does not look stretched at 1280.
5. **Shared bench tablets.** The member bar was where a member could see filter state and
   session together. That is a loss only if the strip scrolls away, which it now does. Note
   it in Phase 5's report if it reads badly; do not reintroduce sticky without asking.
6. **`RunListCounts` over the socket.** The type is decoded on the client. Removing fields
   is safe only if client and server deploy together, which they do (one Worker). No
   migration; nothing stored.

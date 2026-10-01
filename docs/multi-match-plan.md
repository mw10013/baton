# Multi-match: implementation plan

This plan carries out decisions 4 and 6 in `docs/ambiguous-item-naming-research.md`: the order
issue's screen label changes from Needs a workflow to **Multiple workflows match**, and the
shop work word "ambiguous" is renamed **multi-match** everywhere, then retired. Read that doc
first: "What the situation is" and "The screen label" say why. Nothing about behaviour changes.
What matches, what reconcile creates, which orders show the issue and the item card's sentence
all stay as they are. This is a rename and one label.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A vocabulary word moves in the same change as its symbols: every identifier, type, JSDoc,
    test title, log message and label constant. The retired word goes on a retired list in
    that change.
  - A label change starts at the vocabulary row; `pnpm lint` checks that the vocabulary's
    screen column equals `ORDER_ISSUE_LABEL`.
  - A JSDoc never cites a file under `docs/`.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`,
  `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Nothing here is stored: `OrderIssue` is derived and never stored, and no column or stored
  literal carries the word. No `pnpm dev:reset` is needed for the schema. Run it once at the
  end for the browser check.
- Record anything that does not go as written under [Deviations and issues](#deviations-and-issues)
  as you go.
- Research docs under `docs/` are dated and are not rewritten. Leave every "ambiguous" in
  `docs/` alone.

## The names

One table for every rename. The stem is `multiMatch` in camelCase, `multi_match` as the
`OrderIssue` literal (snake case, as `empty_team`), `MULTI_MATCH` in screaming case. The
vocabulary word is "multi-match"; `pnpm vocab:audit` splits it into "multi" and "match", and
both are then covered by the row.

| kind                       | where                                                                                   | from                                        | to                                             |
| -------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| vocabulary word            | `src/lib/domain/ShopWork.ts`, shop work vocabulary table                                | ambiguous                                   | multi-match                                    |
| order-issues table word    | `src/lib/domain/ShopWork.ts`, order issues table                                        | ambiguous                                   | multi-match                                    |
| screen word (both rows)    | the two tables above                                                                    | Needs a workflow                            | Multiple workflows match                       |
| `OrderIssue` literal       | `src/lib/domain/ShopWork.ts`                                                            | `"ambiguous"`                               | `"multi_match"`                                |
| label constant key + value | `ORDER_ISSUE_LABEL`                                                                     | `ambiguous: "Needs a workflow"`             | `multi_match: "Multiple workflows match"`      |
| issues JSDoc table         | `OrderIssue` JSDoc, Issue column                                                        | `` `ambiguous` ``                           | `` `multi_match` ``                            |
| function                   | `src/lib/domain/ShopWork.ts`                                                            | `ambiguousItems`                            | `multiMatchItems`                              |
| `OrderRow` field           | `src/lib/domain/ShopWork.ts`                                                            | `ambiguousItems`                            | `multiMatchItems`                              |
| `LineItemState` field      | `attachable` member                                                                     | `ambiguous: Schema.Boolean`                 | `multiMatch: Schema.Boolean`                   |
| `orderIssues` local        | `src/lib/domain/ShopWork.ts`                                                            | `ambiguous: ...`                            | `multi_match: ...`                             |
| reconcile outcomes cell    | `reconcileItem` JSDoc outcomes table                                                    | `nothing: ambiguous`                        | `nothing: multi-match`                         |
| count fields               | `ReconcileCounts`, `ReconcileAllSums` (`src/lib/RunRepository.ts`) and their zero value | `ambiguous`                                 | `multiMatch`                                   |
| SQL constants              | `src/lib/OrderRepository.ts`                                                            | `AMBIGUOUS_ITEM`, `AMBIGUOUS`               | `MULTI_MATCH_ITEM`, `MULTI_MATCH`              |
| SQL column alias           | `src/lib/OrderRepository.ts` (`issues` expression and the select)                       | `ambiguous`                                 | `multiMatch`                                   |
| locals                     | `OrderRepository.listOrders`                                                            | `ambiguousRows`, `ambiguous`                | `multiMatchRows`, `multiMatch`                 |
| locals                     | `RunRepository.reconcileOrder`                                                          | `ambiguous`                                 | `multiMatch`                                   |
| log fields                 | `RunRepository.ts`, `src/lib/agent/ShopWork.ts`                                         | `ambiguous=`, `: ambiguous, no run created` | `multiMatch=`, `: multi-match, no run created` |
| route constant             | `src/routes/app.orders.$orderId.tsx`                                                    | `AMBIGUITY_SENTENCE`                        | `MULTI_MATCH_SENTENCE`                         |

The sentence's text does not change: "More than one workflow matches this item, so none was
started." It already agrees with the new label.

**Prose.** In JSDoc, comments and test titles, "an ambiguous item" becomes "a multi-match item",
"the ambiguity" becomes "the multi-match", "resolves an ambiguity" becomes "resolves a
multi-match", "is ambiguous" becomes "is a multi-match". Read each sentence after the change; if
the result reads badly, rephrase with the meaning ("an item two or more eligible workflows
match") rather than force the word in.

**Not this word.** These use "ambiguous" or "disambiguate" in its ordinary English sense, about
something else, and stay as they are:

- `src/lib/Repository.ts` (team name conflicts, around `renameTeam`)
- `src/lib/domain/Orders.ts` (the order's name disambiguation)
- `src/lib/domain/Billing.ts` (a stored cycle)
- `src/lib/ShopAgentSchema.ts` (the step position constraint)
- `test/integration/member-area.test.ts`, `test/integration/order-repository.test.ts` (the
  "unambiguously the cycle before" comment only), `e2e/members.spec.ts`,
  `e2e/member-runs.member.spec.ts`, `e2e/plan.billing.spec.ts`, `scripts/refs.ts`

Phase 4's reserved stem must not refuse any of them. None is an exported identifier today;
check that with the grep in phase 4.

## Phase 1: the vocabulary rows and the label

In `src/lib/domain/ShopWork.ts`:

1. The shop work vocabulary table: the `ambiguous` row's word becomes `multi-match`; its
   symbol cell becomes `` `multiMatchItems`, `OrderIssue` `multi_match` ``; its screen cell
   becomes `Multiple workflows match`. The meaning cell stays: "an item two or more eligible
   workflows match, with no run".
2. The order issues table (the `Order issues, shop work` block): the row's word becomes
   `multi-match`, the screen cell `Multiple workflows match`. The meaning cell stays.
3. `ORDER_ISSUE_LABEL`: `multi_match: "Multiple workflows match"`.
4. `OrderIssue`: the literal `"multi_match"`, first, as `"ambiguous"` was. In the JSDoc table
   above it, the Issue cell becomes `` `multi_match` `` and the Rule cell
   `` `multiMatchItems > 0` and the order can create runs ``. The Remedy cell stays.
5. The `orderIssues` body: the key becomes `multi_match`.

6. `scripts/lib/spec.ts`, `keyOf`: it maps a vocabulary word to its label constant's key,
   camel case if the constants have it, else the word with spaces replaced by `_` ("empty
   team" → `empty_team`). A hyphen is not replaced today, so "multi-match" would look for a
   key `multi-match` and `pnpm spec check` would report "Vocabulary: Order issues multi-match:
   no constant". Make the snake-case branch replace a space or a hyphen
   (`word.replaceAll(/[ -]/gu, "_")`), say so in its JSDoc ("`multi-match` → `multi_match`"),
   and add a case to `test/integration/spec.test.ts` beside the existing screen-column cases:
   a hyphenated word finds its snake-case key. Do not respell the word "multi match" to avoid
   this: the word is hyphenated in prose, and the table word is the prose word.

Steps 1 to 6 go in together: `checkScreenColumns` compares each order-issues row's screen
cell with `ORDER_ISSUE_LABEL[keyOf(word)]`, and `checkOrderIssues` compares the Issue column of
the `OrderIssue` JSDoc table with the literals, in order.

The padding of both tables changes with the longer word. `test/integration/spec.test.ts`
matches some order-issues rows by exact text (the `TEAM_ROW`, `EMPTY_TEAM_ROW` constants and
the expected message "the Issue column is ambiguous, empty_team, ..."). Run `pnpm fmt` first,
then update those strings to the re-padded rows and the new literal.

Phase 1 does not pass the checks on its own: the vocabulary row names `multiMatchItems`, which
`pnpm lint` requires to exist, and the literal change breaks every `ambiguous` key until phase 2. Do phases 1 and 2 back to back and run the checks once, after phase 2. This is the one
exception to "after each phase".

## Phase 2: the identifiers

Rename every row of "The names" table except the vocabulary and label rows done in phase 1.
Use the TypeScript rename where you can, so references move with the symbol. Then:

1. `src/lib/domain/ShopWork.ts`: `multiMatchItems` and its JSDoc; `OrderRow.multiMatchItems`
   and its JSDoc ("How many of the order's items are **multi-match**: ..."); the `Pick` in
   the `orderIssues` signature; `LineItemState`'s `multiMatch` and the JSDoc bullet on
   `attachable`; the body that sets it (`multiMatch: matched.length >= 2 && unitsToMake(item) > 0`);
   the outcomes table cell `nothing: multi-match` (the test reads this table out of the source,
   so its parser must still accept the cell; free text after a colon is allowed); the
   `reconcileItem` JSDoc paragraph ("two or more is **multi-match**"); the `SeedProgress`
   JSDoc ("resolves a multi-match item"); every other "ambiguous" or "ambiguity" in the file.
2. `src/lib/OrderRepository.ts`: `MULTI_MATCH_ITEM`, `MULTI_MATCH`, the `issues` expression
   (`"multiMatch or unassigned or emptyTeam or blockedRuns > 0"`), the select alias
   `as multiMatch`, the locals, `multiMatchItems:` on the row, and every JSDoc that names
   them, including the one that says the item is not "Needs a workflow" (it becomes "Multiple
   workflows match"). The SQL alias and the `issues` expression must change together: the
   expression reads the alias by name.
3. `src/lib/RunRepository.ts`: `ReconcileCounts.multiMatch`, `ReconcileAllSums.multiMatch`,
   the zero value, the locals, the sums, the log line, and the JSDoc.
4. `src/lib/agent/ShopWork.ts`: the two log lines (`multiMatch=${...}`), the destructured
   field, the annotation key, and the JSDoc ("resolves a multi-match", "an item it made a
   multi-match", ...).
5. `src/routes/app.orders.$orderId.tsx`: `MULTI_MATCH_SENTENCE` and its JSDoc ("The
   multi-match item's sentence"), `itemState.multiMatch`, and the two JSDoc mentions.

Done when: `pnpm typecheck`, `pnpm lint`, `pnpm test` pass, and
`grep -rn -i "ambigu" src` returns only the "Not this word" sites.

## Phase 3: the tests

1. `test/integration/domain.test.ts`: the `ambiguousItems` parameter and field, the
   `describe("Domain.multiMatchItems")` block, its local, the expected issue lists
   (`["multi_match"]`, `["multi_match", "unassigned", "blocked"]`), and the titles:
   - "an ambiguous item does not move the position: one item chosen, another waiting" →
     "a multi-match item does not move the position: one item chosen, another waiting"
   - "an order with no run and no ambiguous item has no issue" → "... no multi-match item ..."
   - "ambiguous: an item two workflows match, on an order that can create runs" →
     "multi-match: an item two workflows match, on an order that can create runs"
   - the JSDoc naming `AMBIGUOUS_ITEM` → `MULTI_MATCH_ITEM`
2. `test/integration/run-repository.test.ts`: every `ambiguous:` count becomes `multiMatch:`;
   the title "turning one of the two off resolves the ambiguity and starts the survivor" →
   "turning one of the two off resolves the multi-match and starts the survivor".
3. `test/integration/run-actions.test.ts`: `attachable.multiMatch`.
4. `test/integration/order-repository.test.ts`: the JSDoc on `#1012` and `#1013`, the issue
   literal, `describe("OrderRepository.listOrders multi-match")`, the title "the index's
   multi-match predicate agrees with multiMatchItems", `MULTI_MATCH_ITEM`, `multiMatchItems`.
5. `test/integration/shop-agent-workflows.test.ts`: the shop name `wf-multi-match.myshopify.com`,
   the comment, `multiMatchItem`, the issue literal in both places.
6. Grep every test title you changed against the `pinned by` cells and data-model tables
   (`grep -rn "<old title>" src`). None is pinned today; if one is, change the cell in the same
   step.

Done when: `pnpm test` passes and `grep -rn -i "ambigu" test` returns only the "Not this word"
sites.

## Phase 4: the screens' end-to-end tests and the retirement

1. `e2e/orders.spec.ts`: every `getByText("Needs a workflow", ...)` becomes
   `getByText("Multiple workflows match", ...)`; the JSDoc mentions of the badge and of an
   "ambiguous" item follow. The item card's sentence assertion stays.
2. `e2e/fixture.ts`: the comments naming the badge or an ambiguous item. Leave fixture data
   (tags, order numbers) alone.
3. Retire the code word. In `scripts/lib/rules-lint.ts`, add `"ambigu"` to `RESERVED_STEMS`
   (the stem, so `ambiguity` and `ambiguous` are both refused) and a row to the table in its
   JSDoc: `| ambigu | retired; the word is multi-match |`. Before adding it, run
   `grep -rn -i "export.*ambigu" src/lib` and confirm nothing is left.
4. Retire the old label. In the same file, add `/\bneeds a workflow\b/iu` to `RETIRED` and a
   row to its JSDoc table: `| needs a workflow | the fault is that more than one workflow matches; the label is Multiple workflows match |`.
   It is a phrase, not a word, but it is the one that read as "none matched", and the list is
   where a screen string is kept from coming back.
5. `test/integration/rules-lint.test.ts`: a case for each, in the shape of the existing ones:
   - under "an exported identifier carries no reserved stem": "an export named ambiguousItems
     is refused"
   - under "a retired word stays off every merchant and member screen": "needs a workflow is
     retired in screen copy"

Done when: `pnpm lint` and `pnpm test` pass; `pnpm vocab:audit` lists neither "ambiguous" nor
"multi"; `grep -rn -i "ambigu\|needs a workflow" src test e2e scripts` returns only the "Not
this word" sites and the two new retirement entries and their tests.

## Phase 5: check it in the browser

1. `pnpm dev:reset` (it seeds). The seed has a multi-match order (the `e2e/fixture.ts` comment
   on the "rush" tag says which).
2. Run `npm run test:e2e -- e2e/orders.spec.ts`.
3. Open the orders index's Issues view with `pnpm playwright-cli` (headless, session
   `$(pnpm port)-localdev`, wait for `body[data-hydrated="true"]`). The multi-match order's
   Issues column shows the critical badge Multiple workflows match. Open the order: the item
   card shows "More than one workflow matches this item, so none was started." and the picker.
   Take a screenshot of each and look at the badge at its real width: it is three words where
   the old one was three shorter ones, and the Issues column may wrap. If it wraps badly,
   record it; do not shorten the label.

Done when: the e2e spec passes and both screens show the new label and the unchanged sentence.

## Deviations and issues

Record here, as you go. One entry per deviation: the phase and step, what the plan said, what
you found, the options you saw, the one taken, and why. An issue this plan does not cover goes
here too, with a one-line proposal.

| phase.step | plan said                                                               | found                                                                                                                                                                                                                                                                                             | options                                                 | taken, and why                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | "Run `pnpm fmt` first, then update those strings to the re-padded rows" | `pnpm fmt` (oxfmt) does not pad markdown tables inside JSDoc; the three tables kept their old widths with one long row                                                                                                                                                                            | hand-pad; leave ragged                                  | Re-padded the vocabulary nouns table, the order issues table and the `OrderIssue` table with a one-off script (column widths only, no cell text changed), then updated `TEAM_ROW`, `EMPTY_TEAM_ROW` and the doctored remedy row in `spec.test.ts` to the new padding. |
| 1.6        | a case "a hyphenated word finds its snake-case key"                     | "Multiple workflows match" is in both the nouns table and the order issues table, so a bare `"\| Multiple workflows match \|"` replace hits the nouns row, which `checkScreenColumns` does not read                                                                                               | match the order issues row by its meaning cell's tail   | The test replaces `on an order that can create runs \| Multiple workflows match \|`, which only the order issues row has. Title: "a hyphenated word finds its snake-case literal key", beside "a spaced word finds its snake-case literal key".                       |
| 3          | `grep -rn -i "ambigu" test` returns only the "Not this word" sites      | `test/integration/shop-agent-workflows.test.ts` has the comment "needs a workflow for its orders to match", ordinary English about a product, not the label                                                                                                                                       | rephrase; leave                                         | Left it: it is a comment (not screen copy, so `RETIRED` does not read it) and means what it says.                                                                                                                                                                     |
| 5.1        | the seed's multi-match order (`#1011`) on the index                     | `npm run test:e2e -- e2e/orders.spec.ts` replaces the sandbox's orders with its own, so after it the store holds the e2e orders, not the seed's                                                                                                                                                   | re-seed; use the e2e order                              | Took the screenshots on `#9601`, the Issues banner test's multi-match order. Run `pnpm dev:reset` to get the seed back.                                                                                                                                               |
| 5.3        | look at the badge at its real width                                     | At 1440px and 1024px the badge Multiple workflows match sits on one line                                                                                                                                                                                                                          | none needed                                             | Nothing to change.                                                                                                                                                                                                                                                    |
| issue      | (not covered)                                                           | The orders index clips its last column at 1024px: the Shopify column's "View in Shopify" link is cut off at the card's right edge. The Issues view shows it with three orders and the Multiple workflows match badge on one line, so the badge is not the cause; the table is wider than the card | wrap a column; drop or narrow one; let the table scroll | Not fixed here. Proposal: check the orders index at 1024px and below and decide which column gives way.                                                                                                                                                               |

## Status

| phase | state | notes                                                                                      |
| ----- | ----- | ------------------------------------------------------------------------------------------ |
| 1     | done  | tables re-padded by hand (see deviations)                                                  |
| 2     | done  | typecheck, lint, test pass                                                                 |
| 3     | done  | 597 tests pass; no changed title is pinned                                                 |
| 4     | done  | `vocab:audit` lists neither "ambiguous" nor "multi"                                        |
| 5     | done  | `e2e/orders.spec.ts` 17 passed; both screens show the new label and the unchanged sentence |

## Review, 2026-10-01

Every rename in "The names" is in place; `pnpm typecheck`, `pnpm lint`, `pnpm fmt` and the 597
tests pass; `grep -rn -i "ambigu\|needs a workflow" src test e2e scripts` returns only the "Not
this word" sites and the two retirement entries. On the deviations:

- 1 (hand-padded tables): accepted. oxfmt never touches a JSDoc table, so every such table in the
  repo is padded by hand; the plan's "run `pnpm fmt` first" was the plan's error.
- 3 (the seed comment): rephrased to "includes a workflow its orders match", so the retirement
  grep has no false positive.
- 5.1 (e2e orders on the dev store): `pnpm dev:reset` run; the store holds the seed again.
- issue (last column clipped at 1024px): fixed in the same change. The cause was the table's
  minimum width: eight columns needed 894px against the 752px a 1024px viewport leaves the card
  (the admin keeps its nav at that width, so the iframe is 800px), and `s-table` scrolls the
  overflow without a scrollbar the admin shows. The Waiting on column set 200px of that: a team
  name in an `s-badge` never wraps. The cell is now text, one name per line (a badge is one
  state word, and a name is not a state), so the column's floor is a name's longest word; and
  Placed shows the day alone, since the index is sorted by the time. The table now fits at a
  1000px viewport and up; no column was cut.

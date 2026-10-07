# Plan: the position ladder is the bench

Written 2026-10-07 from the decisions in `docs/order-not-started-research.md` (option E and the
strip, decisions 1 to 10). Read that doc's Decisions section first; this plan does not restate the
reasoning, only what to change. Nothing is decided here that is not decided there.

The change in one paragraph: `OrderPosition` grows from five values to seven. The two new ones,
`unpaid` and `no_workflow`, split today's `not_started` (no run on any item) by Shopify's payment
fact. `not_started` now means a run exists and no task on any of the order's runs was started or
done; `making` means a task was. The touched fact is a `startedAt` column on `Run`, recomputed
with `state`. The orders index's strip becomes No workflow · Not started · Making · Made · Issues,
Making the default; Open and Unpaid live in the Show select without counts. The member side does
not change.

Rules for the implementer:

- Work in the order below; each phase ends green on `pnpm typecheck`, `pnpm lint` and `pnpm test`.
  Phase 6 ends green on `npm run test:e2e --`.
- Every spec table named here is read by `pnpm spec check` (part of `pnpm lint`). A rule change
  starts at its row; the lint tells you when a row and the code disagree.
- The vocabulary is at the top of `src/lib/domain/ShopWork.ts`; use its words in code, JSDoc and
  tests. `docs/vocabulary-runbook.md` is the procedure for adding a word.
- No migration: edit `initializeSchema` in line and run `pnpm dev:reset` yourself afterwards.
- Grep before you finish: `Not started`, `not started`, `not_started`, `To make`, `"Open"` and
  `open:` across `src/`, `test/`, `e2e/` and `scripts/`, and read every hit. Stale JSDoc is a bug
  here, because the JSDoc is the spec.
- `pnpm fmt` at the end; keep every file it touches.
- Do not commit.
- Record every deviation from this plan, and every issue you hit, in the last section.

## Phase 1. Vocabulary and domain (`src/lib/domain/ShopWork.ts`)

**The "Order positions" vocabulary table** becomes, in this order:

| word        | meaning                                                            | screen      |
| ----------- | ------------------------------------------------------------------ | ----------- |
| unpaid      | open, no run on any item, not fully paid                           | Unpaid      |
| no workflow | open, no run on any item, fully paid                               | No workflow |
| not started | open, an open run, no done run, no task on any open run started    | Not started |
| making      | open, an open run, and a done run or a started task on an open run | Making      |
| made        | open, done runs and no open run                                    | Made        |
| fulfilled   | Shopify says `FULFILLED`                                           | Fulfilled   |
| cancelled   | Shopify says `cancelledAt`                                         | Cancelled   |

"Started" here is `startedAt` set on a task, which Done without Start backfills, so "started or
done" collapses to "started". The meaning column is prose; `pnpm spec check` compares the screen
column to `ORDER_POSITION_LABEL`.

**`OrderPosition`**: add `"unpaid"` and `"no_workflow"` before `"not_started"`. Rewrite its JSDoc:
the ladder is the bench; the first bench rung, Not started, holds only orders a member can Start;
Unpaid and No workflow are the two no-run cases, split by Shopify's one payment fact so neither
word is ever false (an unpaid order whose item would match is not "No workflow", and the merchant
does not go looking for a tag); No workflow covers an untagged item, a cancelled run and an item
Shopify removed, since the item has no workflow on it now whatever the history; No workflow is a
position and not an issue because an issue is an alarm and a ready-made order would alarm forever.
Delete the paragraph that explains why the rung is "Not started, not To make"; replace it with one
sentence: To make was retired when the rung held unpaid and untagged orders, and is not revived
because Not started agrees with the item badge on the order page (`RUN_UNSTARTED_LABEL`), which
now means the same thing. Keep the "never stored" paragraph and the "rule is a function" paragraph.

**`ORDER_POSITION_LABEL`**: add `unpaid: "Unpaid"` and `no_workflow: "No workflow"`. Its JSDoc
already points at `RUN_UNSTARTED_LABEL`; add that the two now mean the same thing.

**`Run`** (the schema struct): add `startedAt: Schema.NullOr(Schema.Number)` after `state`, with
JSDoc: the earliest `startedAt` of the run's tasks, denormalized like `state` and recomputed with
it by every task write; null is an untouched run ({@link runIsUnstarted} over the tasks says the
same thing; this column says it on the run row, for the orders index's per-order facts).

**`runIsStarted`**: new `Domain` predicate, `(run: { readonly startedAt: number | null }) =>
run.startedAt !== null`. JSDoc: the row-side twin of `!runIsUnstarted(tasks)`; the orders index
and `runCounts` read it, the order page keeps reading the tasks. (`scripts/rules-lint.ts` refuses
an inline `startedAt !== null` outside `src/lib/domain/`, so every reader goes through this.)

**`RunCounts`**: add `started: Schema.Number` with JSDoc "open runs with a started task
({@link runIsStarted})". Rewrite the struct's JSDoc: the sentence "an order whose only runs were
closed reads as not started" becomes "reads as no workflow or unpaid". **`runCounts`** counts
`started` as `runIsOpen(run) && runIsStarted(run)`.

**`orderPosition`**: the checks in order: cancelled, fulfilled, then no open and no done run
(`order.fullyPaid` ? `no_workflow` : `unpaid`), then an open run (`runs.done > 0 || runs.started >
0` ? `making` : `not_started`), else `made`. Rewrite the JSDoc's middle paragraph to say this and
why (the research's three-row table: no run, runs untouched, a task started). Keep the sentence
that the SQL in `OrderRepository.listOrders` restates these branches.

**`OrdersShow`**: add `"open"` to the second literal set (`"open" | "issues" | "all"`). Rewrite
the JSDoc: `null` is the default and is **Making**, `?show=` left out; `"open"` is every open
order ({@link orderIsOpen}); a position is itself; `"issues"` and `"all"` as before. The paragraph
"Open is the default because retention keeps a year of orders" becomes: Making is the default
because a merchant opening Orders wants what the bench is doing now, the analog of the member's
Started by you; Open is a Show value and not a cell because its count is Shopify's and the
merchant already has it there.

**`ORDERS_SHOW_LABEL`**: keyed by `OrdersShow` alone (drop the `| "open"` in the `satisfies`).
Order of the entries: `no_workflow`, `not_started`, `making`, `made`, `issues`, `open`, `unpaid`,
`fulfilled`, `cancelled`, `all`. Its JSDoc: "the strip's five, then Open, Unpaid, the closed
positions and All". The `open` key keeps the label "Open".

**`OrderCounts`**: keys `no_workflow`, `not_started`, `making`, `made`, `issues`; `open` is gone.
JSDoc: one count per strip cell, in strip order.

**Stale text to fix in this file**: the `OrderIssue` JSDoc paragraph that says an untagged item
"sits in Not started, where the merchant sees it" (it now sits in No workflow, where the merchant
sees it better); the `OrderSeed.unpaid` JSDoc ("the row reads as unpaid" is now literally true,
say so); any other hit of the grep in the rules above.

**Tests** (`test/integration/domain.test.ts`, `describe("Domain.orderPosition")`): `NONE` gains
`started: 0`. Replace the table's cases with one per branch, titled by the rule:

- "no run on any item, not fully paid, is unpaid"
- "no run on any item, fully paid, is no workflow"
- "an open run with no started task and no done run is not started"
- "an open run with a started task is making"
- "an open run beside a done run is making, whatever the open run's tasks say"
- "a blocked untouched run is not started" (`started: 0, blocked: 1`)
- "only done runs is made"
- "made stays made when an edit leaves the order unpaid" (keep)
- the fulfilled and cancelled cases (keep)
- "a multi-match item does not move the position" (keep, with `started: 1`)

Delete "an open order with no runs is not started whether or not it is paid"; its two halves are
the first two cases. `test/integration/spec.test.ts` has a doctored copy of the `not started`
row ("a spaced word finds its snake-case literal key"); update the string it replaces to the new
row text. `test/integration/shop-agent-workflows.test.ts` asserts `"making"` on an order whose
run was just created; that is now `"not_started"`.

## Phase 2. The store (`src/lib/ShopAgentSchema.ts`, `src/lib/RunRepository.ts`)

**DDL**: add `startedAt integer,` to `Run` after `state`, with the comment "Denormalized from the
tasks with state: the earliest task startedAt, null when no task is started (RunRepository's
recomputeState)". Add the check `check (state <> 'done' or startedAt is not null)` beside the
other checks (done implies started, as the task-level check does). No index: every reader
reaches the row through `Run_orderId_state_idx` and reads the column as a residual.

**Data-model table** (JSDoc on `initializeSchema`): add a `run` row after the `state` row:
`startedAt` is derived from the tasks and stored, the earliest task start, recomputed with `state`
by every task write in the same transaction; null is an untouched run, and a done run always
carries one | schema+app | pinned by: "a run's startedAt is the earliest task start, recomputed
with its state by every task write, null when no task is started". Write that test in
`test/integration/data-model.test.ts` beside the `state` test: start a task, Put back, Done
without Start, Reopen, and read `Run.startedAt` after each.

**`recomputeState`**: set `startedAt = (select min(startedAt) from RunTask s where s.runId =
Run.id)` in the same update as `state`. Every call site already covers Start, Done, Put back and
Reopen; verify there is no task write that skips it (grep `update RunTask`).

**Run inserts**: every `insert into Run (` lists its columns; `startedAt` is null on insert (a
fresh run has no started task) so no insert changes, but read each to confirm none copies
`startedAt` from a replaced run (Change workflow inserts fresh; `runHasRecord` says what is
lost). The `Run` reads (`select * from Run`, decoded through `Domain.Run`) pick the column up
through the schema struct.

`pnpm dev:reset` after this phase.

## Phase 3. The orders index query (`src/lib/OrderRepository.ts`)

**Fragments**: add `STARTED_RUN`, `select 1 from Run r where r.orderId = ShopOrder.id and
r.state = 'open' and r.startedAt is not null`, with a JSDoc that it is served by
`Run_orderId_state_idx` on both terms with `startedAt` as a residual.

**`showFilter`** (`Match.value(show)`):

- `"unpaid"`: `OPEN`, `fullyPaid = 0`, `not exists (OPEN_RUN)`, `not exists (DONE_RUN)`
- `"no_workflow"`: the same with `fullyPaid = 1`
- `"not_started"`: `OPEN`, `exists (OPEN_RUN)`, `not exists (DONE_RUN)`, `not exists (STARTED_RUN)`
- `"making"`: `OPEN`, `exists (OPEN_RUN)`, `(exists (DONE_RUN) or exists (STARTED_RUN))`
- `"made"`, `"fulfilled"`, `"cancelled"`, `"issues"`, `"all"`: unchanged
- `"open"` and `null`: `null` was Open; now `null` is Making and `"open"` is `OPEN`. Write
  `Match.when(null, ...)` as the `"making"` branch (one fragment, two cases) and
  `Match.when("open", () => sql.literal(OPEN))`.

Update the JSDoc on `showFilter` and the one on `OPEN` (the sentence about a closed run being "in
no position fragment but `not_started`'s" becomes "but `unpaid`'s and `no_workflow`'s").

**The count statement**: `run_summary` gains `sum(r.state = 'open' and r.startedAt is not null)
as startedRuns`; `facts` gains `coalesce(rs.startedRuns, 0) as startedRuns` and
`ShopOrder.fullyPaid as fullyPaid`; the select sums the five `COUNT_FACT`s in strip order and
drops `count(*)`. **`COUNT_FACT`** becomes, `satisfies Record<keyof Domain.OrderCounts, string>`:

- `no_workflow`: `openRuns = 0 and doneRuns = 0 and fullyPaid`
- `not_started`: `openRuns > 0 and doneRuns = 0 and startedRuns = 0`
- `making`: `openRuns > 0 and (doneRuns > 0 or startedRuns > 0)`
- `made`: `doneRuns > 0 and openRuns = 0`
- `issues`: unchanged

The per-page `runRows` aggregate that builds each row's `RunCounts` gains `started` the same way.

**Tests** (`test/integration/order-repository.test.ts`): the fixture writes `Run` rows directly,
so give the runs that are meant to be touched a `startedAt`, and leave at least one open run
untouched and one unpaid order with no run. Update the expected name lists per Show value (add
`unpaid`, `no_workflow` and `open` to the `list(...)` map), the `counts` objects (five keys), and
the JSDoc above the fixture that explains which orders land where. The loop "The SQL and the
TypeScript agree row by row" is the proof the fragments match `orderPosition`; keep it. Add a
case: an order with one done run and one untouched open run lists under `making`.

## Phase 4. Screens

**`src/routes/app.orders.index.tsx`**:

- `STRIP`: `["no_workflow", "not_started", "making", "made", "issues"]`, `keyof Domain.OrderCounts`.
  Rewrite its JSDoc: the four positions in the order an order moves, then Issues, which cuts
  across them; Making is the default, `?show=` left out, and is the chosen cell then; Open,
  Unpaid, Fulfilled, Cancelled and All carry no count and live in the Show select.
- `SHOW`: `[ "no_workflow", "not_started", null, "made", "issues", "open", "unpaid", "fulfilled",
"cancelled", "all" ]`, where `null` is Making. The select's `value` and each `s-option`'s value
  and key use `"making"` for `null` where they used `"open"`; the JSDoc's reason (an empty option
  value takes its label) stays.
- The strip cell for `making` sets `show: null`; every other cell sets its key. `chosen` is
  `show === value` as now.
- `positionBadge`: add `unpaid` and `no_workflow`, both `"neutral"`. Rewrite its JSDoc: the Issues
  cell is empty for a No workflow order on purpose (`OrderIssue` says why), and the badge is the
  place the merchant sees it.
- The route's loader and `setFilters` treat `null` as the default already; confirm nothing maps
  `null` to the label "Open" (the `?? "open"` fallbacks at the select).

**`src/routes/app.orders.$orderId.tsx`**: `Domain.runCounts` now needs `startedAt` on each run,
which `Domain.Run` carries, so the call does not change; confirm the `made` banner still keys on
`state === "made"` and nothing else reads the position. `RUN_STATE_BADGE`'s JSDoc: add one
sentence that the order's Not started and the item's Not started now mean the same thing.

**`src/routes/dev.kit.tsx`**: the two `Strip` renders use the seed's worst cases; give them the
new five labels and keep the long-count case.

**`src/lib/Screen.ts`**: `pnpm spec check` refuses a copy-table example no screen shows. If a row
cites "Open" as a strip cell or "Not started" with its old meaning, update the example; do not
add rows.

## Phase 5. Seeds

- `e2e/fixture.ts`: the comments on orders 1009 ("unpaid ... Not started"), 1010 ("no workflow
  matches: Not started") and 1033 ("blocked before anyone started: Not started plus Blocked")
  now read Unpaid, No workflow and Not started plus Blocked. Any order the fixture means as "being
  made" needs a started task; check each order comment against the new table and mark the ones
  that change position.
- `e2e/showcaseFixture.ts`: the `notStarted` group now reads Not started on the index, which is
  what the showcase research planned; no data change. The unpaid order reads Unpaid; the
  gift-card orders read No workflow.
- `scripts/lib/seed.ts` and `OrderSeed`: no data change unless a seed comment names a position.

## Phase 6. End to end (`e2e/orders.spec.ts`)

- The strip tests that click or assert "Open" as a cell (`stripChosen(frame, "Open")`,
  `stripCell(frame, "Open").click()`, `stripCount(frame, "Open")`): the default chosen cell is
  now Making, and the way back from Made to the default is the Show select's Open or the Making
  cell. Rewrite each in those terms; the test titled on Open's role gets a new title.
- The counted table (`["Open", 2], ["Issues", 1], ...`): five rows, `No workflow` first, `Open`
  gone; the numbers follow the fixture's new positions.
- The loop over `["Open", "Not started", "Making", "Made", "Issues"]` becomes the five strip
  labels.
- The order page's facts line assertion on a "Not started" badge stays.
- Add one assertion: a No workflow order shows the No workflow badge and an empty Issues cell.

Run `npm run test:e2e --`, then `pnpm seed --showcase`, open the orders index as the merchant and
look at the strip and the first page of rows at 1280 × 800. The strip should read No workflow ·
Not started · Making · Made · Issues with Making chosen, and the Not started count should be the
showcase's eight untouched orders.

## Phase 7. Help

`src/lib/helpPages.ts`'s `orders-list` description already names Not started, Making and Made;
add No workflow to it ("Not started, Making and Made; No workflow and Unpaid; ..."). The page's
body is not written yet (`src/components/help/bodies.tsx` has no orders entry); it is written
under these decisions in the help work, not here.

## Verification

- `pnpm typecheck`, `pnpm lint` (spec check included), `pnpm test`, `npm run test:e2e --`, all green.
- `pnpm spec print` shows the seven positions.
- The grep in the rules above finds no stale text.
- `git diff --stat` touches nothing under `src/lib/agent/` except where a run insert or task
  write needed `startedAt`; the member side does not change.

## Deviations and issues

Fill this in as you go; leave it in the file. One bullet per item, in this form:

- **What** (file and symbol). **Why** the plan could not be followed as written, or what broke.
  **What was done instead**, or what is left open and for whom.

Things this plan expects you may hit:

- `scripts/rules-lint.ts` refusing `runIsStarted` or the word `started` in an export: say which
  rule, and what name you used instead.
- A `pnpm spec check` failure on a vocabulary context, a screen column, or a copy example: paste
  the message and say which row you changed.
- The count statement's plan: if `explain query plan` on the new `run_summary` no longer drives
  from `ShopOrder_open_idx`, say so and leave the fix for review.
- An e2e order whose position changes in a way the test's prose did not expect.

### Recorded during implementation (2026-10-07)

- **`pnpm spec print`** (Verification). It renders the action tables and the data-model rows, not
  the vocabulary, so it cannot show the seven positions. `pnpm spec check` compares the
  vocabulary's screen column with `ORDER_POSITION_LABEL` and passes with all seven; that stands in.
- **`emptyText`** (`app.orders.index.tsx`). The plan names no empty-list copy for the new Show
  values. Written: `null` (Making) "Nothing is being made.", `"open"` "No open orders.",
  `"unpaid"` "No open orders are waiting on payment.", `"no_workflow"` "Every paid open order has
  a workflow." Open for review against the `empty` row of the copy table.
- **`show: null` in tests** (seven files under `test/integration/`). Every read that passed
  `null` meant the old default, Open, so each now passes `"open"`; the meaning of each test is
  unchanged. The position-filter test in `order-repository.test.ts` adds that Show left out lists
  exactly Making.
- **Fixtures that write `Run` directly**. The new check (done implies `startedAt`) refused them:
  `seedStates` in `order-repository.test.ts` gives every done run `startedAt = 1` and the open runs
  of a case marked `started`; `data-model.test.ts` sets `startedAt` with `state = 'done'`. In
  `run-actions.test.ts` the `Run` update moved after the task writes and recomputes `startedAt`
  from them; a "task any" cell can pair a done run with unstarted tasks, a state no write
  produces, so that update falls back to `0` for a done run.
- **`seedStates` positions** (`order-repository.test.ts`). `#1003`'s open run is untouched beside
  a done run (the plan's added case, making), `#1004`'s and `#1013`'s are started, `#1014`'s is
  untouched (not started), so the fixture now has every open position. `#1015` in `seedIssues` is
  not started, not "being made"; its JSDoc says so.
- **`e2e/fixture.ts` `#1012`**. Its comment said Making; it has a run nobody has touched, so it
  is Not started now. The comment was rewritten rather than giving the order progress, which
  would have changed what the workflows lists show. `#1001` now says Not started too.
- **`e2e/showcaseFixture.ts`**. Only the gift card alone reads No workflow; the gift card beside
  a board reads Not started by the board's run. The comment says which.
- **`e2e/orders.spec.ts`**. `#9301`, `#9302`, `#9701` and `#9702` are meant as orders being made,
  so they are seeded with `started: true` and stay under Making, the default. `#9501` and `#9502`
  stay untouched, so the counted table reads No workflow 0, Not started 2, Making 0, Made 0,
  Issues 1 under the team. The No workflow assertion is on `#9503` in that test.
- **Unpaid twice on a row** (observation, not changed). An unpaid order's row shows "Unpaid" in
  the Payment column and again as its Status badge. Open for review: the research's decisions do
  not mention the Payment column.
- **Count statement plan**. The query-plan tests in `order-repository.test.ts` pass unchanged:
  `run_summary` still drives from `ShopOrder_open_idx` and probes `Run_orderId_state_idx`.
- **`neverStored` and `Domain.OrdersPage.openOrders`** (`app.orders.index.tsx`,
  `OrderRepository.listOrders`). Not in the plan, found by e2e: the index showed its first-run
  state ("No open orders", no strip, no filters) whenever the default list was empty, which held
  while the default was Open. With Making the default, a shop whose open orders are all untouched
  showed that state and hid the strip. `OrdersPage` gained `openOrders`, the count statement's
  `count(*)` (the open orders the team leaves), which is not an `OrderCounts` key because Open has
  no cell; `neverStored` reads it, and an empty unfiltered Making list gets the `empty` line
  "Nothing is being made." The counts test pins it at 12, unpaid `#1009` included.
- **E2E tests that open an untouched order** (`e2e/orders.spec.ts`, `e2e/workflows.spec.ts`).
  Most seed an order nobody has started and open it from the index, which under the new default
  does not list it. They now choose Show: Open first (`showOpen`), rather than seeding progress
  that would change what they test. `seedTwoPages`' thirty orders are meant as Making (the tests
  click Making) and are seeded `started: true`.
- **`e2e/workflows.spec.ts` "a fresh workflow turns on from the editor"** (not caused by this
  plan). Since 8c2a6d7 put "Items already on it keep going." in the Delete workflow modal too, the
  Turn off assertion matched two paragraphs and failed in strict mode. It now matches the Turn off
  modal's whole body (`TURN_OFF_BODY`).
- **Phase 6 look** (`pnpm seed --showcase`, orders index at 1280 × 800). The strip reads No
  workflow 2 · Not started 12 · Making 24 · Made 4 · Issues 3 with Making chosen, and the Show
  select reads Making. Not started is 12, not the showcase's 8: the other four are `#1001` to
  `#1004`, the dev store's real orders that the e2e sync test stored and the showcase seed does
  not remove. No workflow holds the gift card alone and the Multiple workflows match order, each
  with the neutral No workflow badge.

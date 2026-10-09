# Reconcile spec: implementation plan

This plan carries out the nine decisions in `docs/reconcile-spec-research.md` (under
"Decisions"). Read that doc first: "What exists today" says what is already in the tree, the
four faults say what is misnamed, and the drafts A, B and C under "The proposed spec, drafted
from the implementation" are the starting text for the JSDocs this plan writes. This plan says
what to change, in what order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that is the concept or enforces it. Other
    sites `{@link}` it. A JSDoc never cites a file under `docs/`; it carries its reasoning
    inline. A `refs/` path is fine; a line number is not.
  - A vocabulary word moves in the same change as its symbols. Identifiers, JSDoc, tests and
    logs say the vocabulary word; screens say the screen word.
  - `pnpm spec check` runs under `pnpm lint`. A table it parses has a fixed header and fixed
    words in its fixed-word columns; a `pinned by` title must exist in some test as an
    `it(...)` title, or be `(none yet)`.
  - While prototyping there are no migrations: edit `initializeSchema` in
    `src/lib/ShopAgentSchema.ts` in place and run `pnpm dev:reset` yourself.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`. Keep every file
  `pnpm fmt` touches. After phase 2, `pnpm dev:reset`.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go, with the two options you saw and
  the one you took.
- Each phase is one change. Do not merge phases. Where a phase deletes, delete.

## The decisions, in the order the phases take them

| decision  | what                                                                                                 | phase |
| --------- | ---------------------------------------------------------------------------------------------------- | ----- |
| 8, 9      | `ReconcileOutcome` → `ReconcileAction`, the actions table; `ReconcileAllSums` → `ReconcileAllCounts` | 1     |
| (fault 2) | the "reconcile all" row's meaning and symbol cells                                                   | 1     |
| 7         | billing's reconcile → `checkMeters`, meter quantity, diverge; the "meters checked" trigger row       | 2     |
| 1, 2, 5   | the effects table and the pass rules table on `reconcileItem`; enforcers keep a link                 | 3     |
| 3, 6      | the sync pipeline table on `ShopAgentHost`, no `pinned by`                                           | 4     |
| 4         | every `(none yet)` on reconcile's own tables gets its test                                           | 5     |

## Phase 1: the shop-work renames

Goal: reconcile's identifiers use words the tree already has. Nothing behaves differently.

### 1.1 `ReconcileOutcome` → `ReconcileAction`

In `src/lib/domain/ShopWork.ts`: the schema, the type, `NOTHING`'s annotation, the return type
of `reconcileItem`, and every "outcome" in the JSDocs on `ReconcileAction` and `reconcileItem`
becomes "action". The second table's intro reads "What it does to one item. Each row is a
fixture set, each cell one input; ... `action` is `create`, `close` with its reason, `resize`
or `nothing`, with free text after a colon." Its last column header is `action`.

In `src/lib/RunRepository.ts`: the `outcome` field and variables in `reconcileOrder` become
`action`; `plans` and `planned` stay (they are what they are). The JSDoc sentence "calls
`Domain.reconcileItem` per item, and executes the outcomes" says "executes the actions".

In `scripts/lib/spec.ts`: `RECONCILE_OUTCOME_WORDS` → `RECONCILE_ACTION_WORDS`,
`ReconcileOutcomeCell` → `ReconcileActionCell`, `ReconcileOutcomeRow` → `ReconcileActionRow`
(its `outcome` field → `action`), `parseReconcileOutcomes` → `parseReconcileActions`,
`expandReconcileOutcome` → `expandReconcileAction`; the parser's expected header ends in
`action`; its error prefix reads `reconcileItem actions`. In `scripts/spec.ts`: the calls, the
`print` heading `reconcileItem actions`, and both command descriptions.

In `test/integration/run-actions.test.ts`: the describe title `Domain.reconcileItem actions`,
the JSDoc above it, `row.outcome` → `row.action`. In `test/integration/spec.test.ts`: the
describe title `reconcile actions table parser` and every identifier.

Grep `-i outcome` under `src scripts test` afterwards: the two prose uses in
`workflowEditorWindow.ts` and `admin.shop.$shop.tsx` are English and stay; nothing else may
remain.

### 1.2 `ReconcileAllSums` → `ReconcileAllCounts`

In `src/lib/RunRepository.ts`: the interface and its JSDoc ("the pass's counts, added over its
orders, for the caller's one log line and the release decision"), the `reconcileAll` return
type and its `satisfies`. In `src/lib/agent/ShopWork.ts`: `sums` → `counts` in
`reconcileAllNow`, in its log annotations and in the JSDoc ("the pass logs its counts").

### 1.3 The "reconcile all" row

In the shop-work nouns table (`src/lib/domain/ShopWork.ts`), the row becomes:

| word          | meaning                                                                                                                                | symbol                                                        | screen |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| reconcile all | reconcile every stored open, paid order once, after anything that changes which workflows are eligible or whether a run may be created | `ShopWorkAgent.reconcileAllNow`, `RunRepository.reconcileAll` | (none) |

`pnpm spec check`'s vocabulary check requires every backticked symbol to occur in the file
outside the vocabulary; `RunRepository.reconcileAll` occurs in the `reconcileItem` JSDoc
already. If the check refuses it, see how the `reconcile` row names
`RunRepository.reconcileOrder` and follow that.

### 1.4 Done when

`pnpm typecheck`, `pnpm lint`, `pnpm test` pass; `pnpm vocab:audit` no longer lists `outcome`
or `sum`; `pnpm spec print` prints `reconcileItem actions` with the same thirteen rows and
fixture counts as before.

## Phase 2: billing's reconcile becomes a meter check

Goal: the word "reconcile" means one thing, in shop work. Billing checks its meters.

### 2.1 The vocabulary rows (`src/lib/domain/Billing.ts`)

Two rows in the billing nouns table:

| word           | meaning                                                                                                                                | symbol                                                                                   | screen                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| meter quantity | Shopify's count on a meter this billing cycle, as the Partner API reports it; null when the app subscription has no item for the meter | `MeterQuantitiesInput`, `ShopUsage` fields `meterQuantityOrders`, `meterQuantityMembers` | (none): the admin page's "Shopify metered orders" |
| diverge        | a meter's quantity and Baton's count differ by more than the units still queued; logged, never corrected                               | `meterDiverges`                                                                          | (none)                                            |

The vocabulary paragraph that lists JSDoc terms ("Provisional cycle", "high-water mark",
"boundary") is unchanged.

### 2.2 The renames

| today                                                                                                                         | becomes                                       | files                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ReconcileUsageInput`                                                                                                         | `MeterQuantitiesInput`                        | `domain/Billing.ts`, `agent/Billing.ts`, `ShopAgent.ts`, `ShopAgentClient.ts`, `OrderRepository.ts`              |
| `BillingAgent.reconcileUsage`, `ShopAgent.reconcileUsage`, `ShopAgentClient.reconcileUsage`, `OrderRepository.reconcileUsage` | `checkMeters`                                 | the same four, `SubscriptionPlan.ts`                                                                             |
| `ShopUsage.lastReconciledOrders`, `lastReconciledMembers`                                                                     | `meterQuantityOrders`, `meterQuantityMembers` | `domain/Billing.ts`, `OrderRepository.ts` (select, update, decode), `ShopAgentSchema.ts`, `admin.shop.$shop.tsx` |
| log `ShopAgent.reconcileUsage: ... metered usage diverges`                                                                    | `ShopAgent.checkMeters: ... meter diverges`   | `agent/Billing.ts`                                                                                               |
| log `usage reconciliation failed`                                                                                             | `meter check failed`                          | `SubscriptionPlan.ts`                                                                                            |
| `callableEffect("ShopAgent.reconcileUsage", ...)`                                                                             | `"ShopAgent.checkMeters"`                     | `ShopAgent.ts`                                                                                                   |
| `Effect.fn("ShopAgentClient.reconcileUsage")`, `Effect.fn("OrderRepository.reconcileUsage")`                                  | `checkMeters`                                 | `ShopAgentClient.ts`, `OrderRepository.ts`                                                                       |

The `ShopUsage` field JSDocs: "Shopify's own `USAGE_METER_ORDER` quantity at the last check;
null when the app subscription has no item for the meter (measured 2026-09-19: ...)" keeps the
measured note as it is. The `MeterQuantitiesInput` JSDoc: "Shopify's quantity per meter for
the current billing cycle, which `SubscriptionPlan` pushes after every revalidation for the
divergence check (`meterDiverges`); null where the app subscription lacks the meter. Plain RPC
input for the same reason as `BillingCycleInput`. The push also sends the queue."

The `checkMeters` JSDoc on `BillingAgent` keeps every sentence of today's `reconcileUsage`
JSDoc, with "reconcile" removed: "Stores Shopify's quantity per meter and compares each with
the local counter plus the pending units (`meterDiverges`). Nothing is corrected. ... Flushes
after the check, not before: ...".

In `admin.shop.$shop.tsx` the two `Field` labels "Shopify metered orders" and "Shopify metered
members" stay: screen words, and "metered" is Shopify's.

In `initializeSchema`: the two columns renamed in place, the DDL comment with them. Then
`pnpm dev:reset`.

Tests: `test/integration/order-repository.test.ts` (`repository.reconcileUsage` →
`checkMeters`), `test/integration/shop-agent-callables.test.ts` (the callable name list),
`test/integration/subscription-plan.test.ts` (the stub's `name === "reconcileUsage"`). Any
test title that says "reconcile" about billing is retitled in Shopify's words.

### 2.3 The trigger row

In the `ShopUsage` triggers table, one new row, after "revalidation during a trial":

| trigger        | order count | seat mark | queue | pinned by                                                                        |
| -------------- | ----------- | --------- | ----- | -------------------------------------------------------------------------------- |
| meters checked | —           | —         | sent  | a meter check stores Shopify's quantities, logs a divergence and sends the queue |

The test is in phase 5 (5.3). Until then the cell is `(none yet)`.

### 2.4 Done when

`grep -rn -i reconcil src/lib/agent/Billing.ts src/lib/domain/Billing.ts src/lib/SubscriptionPlan.ts src/lib/ShopifyPartner.ts src/lib/ShopifyAppEvents.ts`
returns nothing. The `ShopifyPartner.ts` JSDoc that says "nothing to reconcile against" says
"nothing to check against". `pnpm dev:reset` succeeds; the admin shop page shows both metered
fields. `pnpm lint` passes with the new rows and the new trigger row.

## Phase 3: the effects table and the pass rules table

Goal: a person reads reconcile in one JSDoc, on `reconcileItem`, and `pnpm spec check` holds
the two new tables.

### 3.1 The tables (`src/lib/domain/ShopWork.ts`)

The `reconcileItem` JSDoc gains two tables after the actions table, in this order, with these
intros. Take the rows from drafts A and B in the research, as edited there, with the test
titles phase 5 writes already in the `pinned by` cells (the check tolerates a title that does
not exist yet only as `(none yet)`, so either write phase 5's tests first or write the cells
as `(none yet)` and fill them in phase 5; the latter is the plan's order).

Table 3, the effects table. Intro: "What each action does beyond the item's run. `run row` is
`inserted with its tasks`, `closed`, `quantity rewritten` or `untouched`; `counted order` is
`counted if not yet` or `—`; `queue` is `+1 order event` or `—`; `ceiling flag` is `raised`,
`may release` or `—`. A seeded order is never counted and a second run on a counted order
counts nothing: those are rows of the triggers table on `ShopUsage`, not restated here." Header:
`action | run row | counted order | queue | ceiling flag | pinned by`.

Table 4, the pass rules. Intro: "The rules of a pass, in the order a pass meets them. `where`
names the symbol that enforces the rule; the rule is stated here and that symbol links it."
Header: `rule | where | pinned by`. Rows: the ten in draft B. Rule 2's `where` is
`OrderRepository.upsertOrder`, `RunRepository.reconcileAll`; rule 7's is
`ShopWorkAgent.afterCeilingReleased`, `reconcileAllNow`.

The prose paragraphs already on `reconcileItem` (two gates, one run per item, the snapshot)
stay above the tables. Add one sentence to the first paragraph: "Storing the order is sync, the
orders word; reconcile begins once the order is stored."

### 3.2 The enforcers link back

Each symbol a `where` cell names keeps its mechanics and loses its restated rules, replaced by
one sentence and a link:

- `RunRepository.reconcileOrder`: "The rules of a pass are the pass rules table on
  `Domain.reconcileItem`; this is where rules 1, 4, 5 and 6 are enforced." Keep the paragraph
  on why it declines rather than fails (that is reasoning, not a rule) and the sentence on
  `multiMatch` counting.
- `RunRepository.reconcileAll`: keep "one transaction each", "open, paid only", the
  **Unbounded** paragraph; link rule 2.
- `ShopWorkAgent.reconcileAllNow`: keep the "Unconditional, because a workflow turning off
  creates runs too" paragraph; the second-pass and flush paragraphs become one sentence each
  with a link to rules 7 and 8.
- `ShopWorkAgent.eligibleContext`, `Domain.EligibleContext`: link rule 3.
- `ShopWorkAgent.afterCeilingReleased`: link rule 7.
- `ReconcileCounts`, `ReconcileAllCounts`: link rule 10.

No sentence is deleted whose reasoning is not on `reconcileItem`. When in doubt, move the
sentence to `reconcileItem`'s prose rather than drop it.

### 3.3 The parsers (`scripts/lib/spec.ts`)

Two parsers beside `parseReconcileActions`, both using `nthTable(source, "reconcileItem",
header, n)` with `n` 2 and 3:

- `parseReconcileEffects`: fixed words per column, exported as `RECONCILE_EFFECT_WORDS = {
  runRow: [...], countedOrder: [...], queue: [...], ceilingFlag: [...] }`; `action` is one of
  the five row labels (`create`, `close (any reason)`, `resize`, `nothing: declined`,
  `nothing (every other reason)`), each exactly once; `pinned by` a title or `NONE_YET`.
  Returns rows with `line` and `pinnedBy` so `checkPinned` takes them.
- `parseReconcilePassRules`: header `rule | where | pinned by`; `rule` non-empty; `where` is
  one or more backticked symbols; `pinned by` a title or `NONE_YET`. Same return shape.

Both fail with a message naming `reconcileItem`, the table, the line and the cell, as the
existing two do.

In `scripts/spec.ts` `check`: two more `Result.match` entries, each `checkPinned(rows,
testSources, "reconcileItem")`. In `print`: two more sections, `reconcileItem effects` and
`reconcileItem pass rules`, one line per row, and after all reconcile sections one line
`reconcileItem: N rows pinned by (none yet)` counting across the triggers, effects and pass
rules tables. Update both command descriptions.

In `test/integration/spec.test.ts`: a describe per parser with the same shape as `reconcile
triggers table parser`: parses the live source; refuses a bad fixed word; refuses a missing
header; refuses an empty rule.

### 3.4 Done when

`pnpm spec print` shows all four reconcile tables and the `(none yet)` count. `pnpm lint`
passes. The `reconcileItem` JSDoc reads top to bottom as the whole of reconcile.

## Phase 4: the sync pipeline table

Goal: the one place three contexts meet is written down where the agent map is.

### 4.1 The table (`src/lib/agent/Host.ts`)

Under the sentence "The class's sync wiring is the other place the contexts meet: store
(orders), reconcile (shop work), flush (billing), publish (host)." add: "One row per source of
orders. `store` is the orders write; `reconcile` is the shape from the triggers table on
`Domain.reconcileItem`, `reconcile` or `reconcile all`; `flush` is when the usage queue is
sent; `release` is when a released open-run ceiling runs its reconcile all; `publish` is who is
told. No `pinned by`: the rows are wiring, covered by the webhook, stream and ceiling suites by
scenario." Then draft C's five rows, header
`source | store | reconcile | flush | release | publish`.

The sentence in `syncOrderWebhook`'s JSDoc ("Each order goes through four steps, each owned by
one module") stays and gains "the table on `ShopAgentHost`" as its link. `onOrdersStream`'s two
comments about the flush and the release stay.

### 4.2 The parser

`parseSyncPipeline(source)` in `scripts/lib/spec.ts`: `nthTable(source, "ShopAgentHost",
header, 1)` (the services table is table 0); `source` non-empty; `reconcile` cell begins with
one of `RECONCILE_SHAPE_WORDS` (`reconcile`, `reconcile all`) or is `—`; the other cells
non-empty. `scripts/spec.ts` reads `src/lib/agent/Host.ts` (add it to the sources it loads),
checks the parse, and prints the rows under `ShopAgentHost sync pipeline`. A parser test in
`spec.test.ts`.

### 4.3 Done when

`pnpm spec print` shows the pipeline rows; `pnpm lint` passes.

## Phase 5: the tests

Goal: no `(none yet)` on reconcile's own tables or on the new trigger row. Each test's title is
the cell, verbatim; write the title into the cell in the same change.

### 5.1 The triggers table, two rows

| row               | title                                                             | file                           | asserts                                                                                          |
| ----------------- | ----------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Sync from Shopify | the one-order sync stores the order and creates its run           | `shop-agent-callables.test.ts` | after `syncOrder` on an order with one matching item, one run exists; a second call creates none |
| Delete workflow   | deleting one of two matching workflows creates the survivor's run | `shop-agent-workflows.test.ts` | two on workflows match one item, no run; `removeWorkflow` on one; the other's run exists         |

### 5.2 The effects table, one row

| row    | title                                             | file                     | asserts                                                                                    |
| ------ | ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| resize | a resize rewrites the quantity and counts nothing | `run-repository.test.ts` | quantity changes on an open run; `countedAt` unchanged; no new usage event; flag untouched |

### 5.3 The pass rules, six rows

| rule | title                                                                              | file                           | asserts                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1    | a pass reads the stored order, and a run whose item is gone closes as item removed | `run-repository.test.ts`       | upsert an order with two items and runs; upsert again with one item; the orphaned run is `closed` with `item_removed`            |
| 2    | a pass that fails leaves neither the order nor its runs                            | `order-repository.test.ts`     | `upsertOrder` with an `afterWrite` that fails; the order row is absent and no run exists                                         |
| 3    | every order in a pass sees the same eligible snapshot                              | `shop-agent-workflows.test.ts` | a reconcile all over two orders with a team deleted between them through the test's hook creates both runs or neither, never one |
| 6    | a pass that closes and declines reports released and raises the flag again         | `run-repository.test.ts`       | at the ceiling, an order whose pass closes one run and declines another: `ceilingReleased` true and `openRunsLimitedAt` set      |
| 8    | a reconcile all sends the usage queue even when it fails                           | `shop-agent-workflows.test.ts` | a pass whose second order's reconcile fails; the flush was called                                                                |
| 10   | no reconcile count reaches a screen                                                | `shop-agent-workflows.test.ts` | `SwitchResult.Ok`, `ApplyResult.Ok` and the toasts carry no count; a string search of the screen copy for the counts' names      |

Rule 3's test may need a hook the code does not have (a way to delete a team between two
orders of one pass). If it would need production code written only for the test, record it
under Deviations and pin rule 3 instead by a unit test on `eligibleContext` being called once
per `reconcileAllNow`, retitling the cell.

Rule 10 is a claim about screens, not about a pass. If it cannot be a test worth having,
strike the row rather than write a weak test, and record it.

### 5.4 The billing trigger row

| row            | title                                                                            | file                             | asserts                                                                                                      |
| -------------- | -------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| meters checked | a meter check stores Shopify's quantities, logs a divergence and sends the queue | `shop-agent-usage-flush.test.ts` | after `checkMeters` with quantities below the local count: both columns stored, a warning logged, queue sent |

### 5.5 Done when

`pnpm spec print` reports `reconcileItem: 0 rows pinned by (none yet)` and the `ShopUsage`
table has none. `pnpm test` passes.

## Phase 6: the whole

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`; keep every file `fmt` touches.
- `pnpm vocab:audit`: `outcome`, `sum`, `reading` absent; `quantity` and `diverge` absent
  because they have rows.
- `grep -rn -i reconcil src/lib/domain/Billing.ts src/lib/agent/Billing.ts` returns nothing.
- Read the `reconcileItem` JSDoc once, top to bottom, as the user would: four tables, prose
  for the why, no sentence that restates a row.
- Update `docs/reconcile-spec-research.md`'s Status line (add one) to say the plan is done and
  where the tables are. Do not edit the rest of the research.

## Deviations and issues

Record here, as you go, anything that did not go as written: what the plan said, what you
found, the two options you saw, and the one you took. One entry per item, dated. Empty until
the work starts.

- **2026-10-01, 1.4 grep.** The plan expected two prose uses of "outcome" to remain. Four
  remain: the two named, plus the `Result` row of the Shape families table in `Domain.ts` and
  "a union of tagged outcomes" on the `…Result` JSDoc in `domain/ShopWork.ts`. Both describe
  the `Result` family in English, not reconcile. Options: rename them, or keep them. Kept. The
  comment "the match is not the outcome" in `run-repository.test.ts` was about reconcile and
  now says "not the run".
- **2026-10-01, 2.4 grep.** Two billing sites said "reconcile" about shop work, not billing:
  `flushUsageEvents` named `ShopWorkAgent`'s `reconcileAllNow`, and `openRunsLimitedAt` said
  "Set when reconcile declined". Options: keep them and accept a non-empty grep, or reword.
  Reworded ("every workflow edit through `ShopWorkAgent`", "Set when a run was declined, not
  created"), so the grep is empty. In the same change: "meter readings" became "quantities" in
  prose, parameters (`readings` → `quantities`) and two `subscription-plan.test.ts` titles; the
  test's `reconciled` ref became `checked`; "drift check" on the pending-units fields became
  "divergence check".
- **2026-10-01, 2.2 DDL.** `initializeSchema` has no comment on the two columns; only the
  column names changed. Checked on the admin shop page after `pnpm dev:reset`, signed in as an
  `ADMIN_EMAILS` address through the demo-mode magic link: "Shopify metered orders" shows 0 and
  "Shopify metered members" shows 12, read from the renamed columns.
- **2026-10-01, 3.1 rule 8.** Draft B said "after a stream, never per order", which reads as
  contradicting the webhook row of the pipeline table (flush after the order). Options: keep
  the draft, or say what it meant. The cell says "once after a stream, not per streamed order".
- **2026-10-01, 3.1 prose.** The ceiling reasoning moved from `reconcileOrder` and
  `reconcileAllNow` into one paragraph on `reconcileItem`, written as the reasons for rules 4
  to 8 so it does not restate them. The first and snapshot paragraphs now cite rules 1, 3 and 9
  instead of restating them.
- **2026-10-01, 4.2 parser.** `jsdocBefore` in `scripts/lib/spec.ts` found only
  `export const`; `ShopAgentHost` is a class. It now accepts `export class <name>` too.
- **2026-10-01, 5 files.** Four tests are not in the file the plan named:
  - Sync from Shopify is in a new `shop-agent-sync-order.test.ts`. `shop-agent-callables.test.ts`
    is the role gate, and the test needs an Admin API stand-in. `@shopify/shopify-api`
    registers its fetch at import, so the stand-in goes through `setAbstractFetchFunc`, not
    `globalThis.fetch`.
  - Rule 2 is in `run-repository.test.ts`: it needs `RunRepository`, which
    `order-repository.test.ts` does not provide.
  - Rule 8 is in `shop-agent-usage-flush.test.ts`, whose fetch stand-in observes the flush. The
    reconcile all fails on a stored order whose `processedAt` cannot be decoded.
  - Meters checked reports quantities above the local count, not below: the event queued to
    show "sends the queue" adds one unit of tolerance, and the local count is zero. The warning
    is read from the console, which the object shares with the test.
- **2026-10-01, 5.3 rule 3.** No production hook was needed. The test builds `ShopWorkAgent`
  over the object's storage with `Repository.listTeams` wrapped to delete the team right after
  it is read; both orders get their runs and the teams are read once. Title as planned.
- **2026-10-01, 5.3 rule 10.** Kept, not struck. The test asserts that `applyDraft` and
  `setWorkflowOn`, each running a reconcile all that creates a run, return only `_tag` and
  `workflow`. No string search of screen copy: the toasts read these results, and a search for
  field names would be the weak test the plan warned against.
- **2026-10-01, tables.** The JSDoc tables this change touched were aligned by a script over
  the cell widths; `pnpm fmt` does not align tables inside JSDoc.
- **2026-10-01, review.** Three things the first pass left: the pass rules were cited by
  number from thirteen JSDoc sites but the rows carried none, so the `rule` cells now start
  `1.` to `10.`; `OrderRepository.upsertOrder` and `ShopAgent.onOrdersStream` are `where`
  symbols that did not link back, and now do; the ceiling paragraph on
  `RunRepository.reconcileOrder` had been copied to `reconcileItem`, not moved, and is now the
  one sentence and link that 3.2 asked for.

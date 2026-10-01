# Reconcile spec research: words, context and form

Status: implemented 2026-10-01 by `docs/reconcile-spec-plan.md`. The triggers, actions, effects
and pass rules tables are on `reconcileItem` (`src/lib/domain/ShopWork.ts`); the sync pipeline
table is on `ShopAgentHost` (`src/lib/agent/Host.ts`); the meters checked row is in the
triggers table on `ShopUsage` (`src/lib/domain/Billing.ts`).

Written 2026-10-01. The ask: Baton hinges on reconcile and reconcile all, which take an order,
store it, create and close runs, count the order for billing and queue usage, and there is no
spec for them. Check the words and the bounded context first; then find the lightest form that
lets a person and an LLM agree on what the functionality must do, drives the implementation and
the tests, and is not exhaustive.

## The short version

1. **Half the spec already exists.** `docs/reconcile-research.md` (decided 2026-09-30) and
   `docs/reconcile-plan.md` put a per-item planner, `reconcileItem`, in the shop-work context
   with two tables on it: the **triggers table** (when a pass runs, in which shape, what skips
   it, which test pins it) and the **outcomes table** (what one pass does to one item; the
   actions table, if question 8 is accepted). Both
   are in the tree today, `pnpm spec check` parses both, and the test under
   `Domain.reconcileItem outcomes` reads the outcomes table out of the source and runs every
   fixture. That is the form you remember from `runActions`, already applied here.
2. **What has no spec is the pass and the pipeline.** The outcomes table says what happens to
   an item. Nothing says, as a spec, what a pass does around the items: the ceiling budget, the
   order of closes and creates, the one transaction, the count for billing, the usage queue,
   the ceiling release and the second pass, the flush, the publish, the snapshot of eligible
   workflows. Each fact is in a JSDoc somewhere (`reconcileOrder`, `reconcileAll`,
   `reconcileAllNow`, `fetchAndUpsertOrder`, `syncOrderWebhook`, `onOrdersStream`), none is
   stated as a rule with a test title, and no table reads across them. That is the gap.
3. **The words are right, with four faults.** Reconcile, reconcile all, eligible, match,
   multi-match and units to make have rows in the shop-work vocabulary, and reconcile sits
   where the map says it should: shop work, downstream of orders, the rule in
   `src/lib/domain/ShopWork.ts` and the SQL in `RunRepository.ts`. The faults: billing uses
   "reconcile" for something else (`reconcileUsage`, `ReconcileUsageInput`,
   `lastReconciledOrders`) with no row and no Shared words row; the "reconcile all" row's
   meaning cell is narrower than its triggers; and two names I or the plan introduced,
   `ReconcileOutcome` and `ReconcileAllSums`, use words the tree does not otherwise have.
4. **Recommended form.** Keep `reconcileItem` as the one place a person reads reconcile. Add
   two things to its JSDoc: an **effects table** (one row per action, columns for what it does
   beyond the run row: the counted order, the usage queue, the ceiling flag) and a **pass rules
   list** (numbered one-sentence invariants with a `pinned by` title each, the data-model
   tables' form). Add a **sync pipeline table** to the agent map on `ShopAgentHost`, one row per
   source of orders, one column per step (store, reconcile, flush, release, publish), because
   that pipeline is where three contexts meet and the class is the only symbol that sees it.
   `pnpm spec check` grows one check: every `pinned by` title exists, with `(none yet)` allowed
   as it is today. No new fixture expansion.

## What exists today

What the user is calling "reconcile and reconcile all" is three things with three owners:

| what                     | symbol                                                                                      | context, layer                  | spec on it today                                                                                       | checked by                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| the rule, per item       | `reconcileItem` (`src/lib/domain/ShopWork.ts`)                                              | shop work, domain               | triggers table, outcomes table, prose: two gates, one run per item, snapshot, idempotent               | `pnpm spec check` parses both; the outcomes test reads the table        |
| the pass, one order      | `RunRepository.reconcileOrder` (`src/lib/RunRepository.ts`)                                 | shop work, repository           | JSDoc prose: reads storage not the caller; ceiling counted once; declines, never fails                 | three hand-titled tests under `RunRepository.reconcileOrder`            |
| the pass, every order    | `RunRepository.reconcileAll`, `ShopWorkAgent.reconcileAllNow`, `reconcileAllIfOn`           | shop work, repository + service | JSDoc prose: one transaction per order; open paid only; unbounded; second pass on release; flush after | `shop-agent-workflows.test.ts`, two titles                              |
| the pipeline, one order  | `fetchAndUpsertOrder` and `reconciler` in `ShopAgent.ts`; `OrdersAgent.fetchAndUpsertOrder` | the class, where contexts meet  | JSDoc on `syncOrderWebhook`: "four steps, each owned by one module: store, reconcile, flush, publish"  | nothing parses it                                                       |
| the pipeline, the stream | `onOrdersStream` with `runShopAgentOrdersStream`                                            | the class                       | JSDoc prose: flush after the stream; one release pass after the stream, not per order                  | `shop-agent-orders-stream.test.ts`, `shop-agent-orders-ceiling.test.ts` |
| the metering hook        | `insertRun` calling `OrderRepository.countOrder`                                            | shop work calling billing       | the triggers table on `ShopUsage` ("first run on an order", "another run on a counted order")          | `pnpm spec check` checks its pinned titles                              |

Three facts from the code that a spec has to carry and nothing states as a rule today:

- **The ceiling budget is per pass, spent in item order.** `reconcileOrder` reads the open-run
  count once, computes `room = maxOpenRuns − count` only if some item could create, and each
  `create` spends one; the item that finds `room ≤ 0` is `declined`. Closes in the same pass do
  not refund the budget; they set `ceilingReleased` and the caller runs a reconcile all.
- **Release is computed before the decline flag is raised.** A pass that both closes and
  declines reports released (so the caller runs the second pass) and raises the banner again
  for what it declined. The comment in the body says so; no rule and no test title does.
- **A run whose item is gone is an item at zero units.** `reconcileOrder` plans a stored run
  with no stored item as `{ currentQuantity: 0 }`, so it closes `item_removed`. The outcomes
  table's "units 0" row covers the outcome but not the fact that a missing item is read as
  zero.

Test titles that exist, for the `pinned by` cells below: "creates one run per matching item
with copied tasks and team names", "is idempotent, and a closed item creates nothing on
reconcile", "reconcile yields to the ceiling and records it; the run's last Done clears the
flag", "a close by reconcile releases the ceiling and says so", "a reconcile all whose own
closes release the ceiling runs once more", "retagging an on workflow reconciles stored orders
against the new tag", "a reseed reconciles the orders it did not replace", "an order is counted
once, when its first run is created", "a second sync never queues a second count". The triggers
table still has `(none yet)` on Sync from Shopify and Delete workflow.

## The words and the context

### What is right

- **Context.** The map in `src/lib/Domain.ts` says shop work is downstream of orders,
  conformist on words, a translation on model. Reconcile is exactly that translation: it reads
  orders words (cancelled, fulfilled, paid, current quantity, product tags) and writes shop-work
  words (run, close, resize). The rule is in `src/lib/domain/ShopWork.ts`, which may import
  Orders; the SQL is in `RunRepository.ts`; the orchestration is in `agent/ShopWork.ts`. The
  orders service never imports shop work: `OrdersAgent.fetchAndUpsertOrder` takes the
  reconciler as a parameter. That is the right direction and the lint holds it.
- **The pipeline is not a context.** Store is orders, reconcile is shop work, count and flush
  are billing, publish is platform. The agent map on `ShopAgentHost` already says "the class's
  sync wiring is the other place the contexts meet". So the pipeline spec belongs on the class,
  not in a context file. There is no fourth context hiding here.
- **Rows.** reconcile, reconcile all, eligible, match, multi-match, units to make have rows in
  the shop-work nouns table. `pnpm vocab:audit` lists two reconcile words without a row,
  `outcome` (`ReconcileOutcome`) and `sum` (`ReconcileAllSums`); both are faults 3 and 4 below. "Creation gate", "stop gate", "eligible context" and "source" stay JSDoc
  terms by decision 3 of the reconcile research.

### Fault 1: "reconcile" means two things

Billing has `BillingAgent.reconcileUsage`, `ShopAgent.reconcileUsage`, `ReconcileUsageInput`,
`OrderRepository.reconcileUsage` and the columns `lastReconciledOrders`, `lastReconciledMembers`.
What it does: store Shopify's meter readings, compare them with the local counters plus the
pending queue, log a warning if they diverge, and flush. Its own JSDoc says "Nothing is
corrected." It makes nothing agree with anything; it is a check that records what it saw.

First principles: a word has one meaning in its context, and a word two contexts share is a row
of the Shared words table and travels with its noun ("open order", "open run"). "Reconcile" in
shop work means make the runs agree with the order. In billing it would have to mean make the
local meter agree with Shopify's, and the code refuses to do that on purpose. So it is not a
shared sense of one word; it is a second concept wearing the word. The nearest honest words are
"check" (the JSDoc already says "the check", "the divergence checks") and "reading" (the JSDoc
says "meter readings").

Cost: a grep-rename across `agent/Billing.ts`, `ShopAgent.ts`, `ShopAgentClient.ts`,
`OrderRepository.ts`, `domain/Billing.ts`, `SubscriptionPlan.ts`, `initializeSchema` (two
columns; edit in place, then `pnpm dev:reset`), the `ShopUsage` JSDoc and its tests. No screen
says the word. Roughly twenty sites.

**What Shopify calls the thing.** The Partner API's `activeSubscription` returns, per
subscription item, a `usage` field with `quantity` and `cost` "for the current billing cycle"
(`refs/shopify-docs/docs/api/partner/latest/active-subscription.md`). App Pricing calls the
counter a usage meter, and the App Events API takes usage events. So Shopify's words are
**meter** (the counter), **quantity** (the number on it this cycle) and **usage event** (one
report of units). Two of the three already have rows in the billing vocabulary, and the tree
already has `meterQuantity` in `ShopifyPartner.ts` reading that exact field. "Reading" was my
word, not Shopify's, and it is the vague one: a meter has a quantity, nobody reads it.

**What Baton does with it.** Stores the quantity, compares it with its own count plus the
units still queued, and logs a warning when they differ. The predicate is `meterDiverges`; the
JSDoc calls it "the divergence check". Nothing is corrected, on purpose: a divergence is the
only evidence that Shopify is not billing what Baton counted. So the verb is "check" and the
fault word is "diverge". "Drift" appears in the tree only as a code word for copies of code
falling apart, never for a meter, so it is not a candidate.

Recommendation, in Shopify's words plus one plain verb:

| today                                                     | proposed                                      | why                                                |
| --------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| `reconcileUsage` (service, callable, client, repository)  | `checkMeters`                                 | it checks each meter and changes nothing           |
| `ReconcileUsageInput`                                     | `MeterQuantitiesInput`                        | the input is Shopify's quantity per meter          |
| `ShopUsage.lastReconciledOrders`, `lastReconciledMembers` | `meterQuantityOrders`, `meterQuantityMembers` | Shopify's quantity on each meter at the last check |
| `meterDiverges`                                           | unchanged                                     | already the word                                   |
| "usage reconciliation failed" (log)                       | "meter check failed"                          |                                                    |

Two vocabulary rows in billing: **meter quantity**, "Shopify's count on a meter this billing
cycle, as the Partner API reports it; null when the app subscription has no item for the meter"
(`MeterQuantitiesInput`, `ShopUsage.meterQuantityOrders`; screen none); and **diverge**, "a
meter's quantity and Baton's count differ by more than the units still queued; logged, never
corrected" (`meterDiverges`; screen none). One row in the `ShopUsage` triggers table, which
today has no row for this trigger: "meters checked | — | — | sent | <title>". "Usage" stays as
the umbrella word (`ShopUsage`, usage event): it is Shopify's word for the whole of
usage-based pricing, and the row is Baton's usage figures. Question 1 below.

### Fault 3: "outcome" is a word the tree does not otherwise use

`ReconcileOutcome` and the "outcomes table" came from the reconcile research (decision 10
said "returns an `Outcome` union"); I introduced the word. The tree uses "outcome" nowhere
else as an identifier. The Shape families table has `Result` for "the outcomes of one write, a
tagged union, decoded by `ShopAgentClient` on the way back", and `ReconcileOutcome` is not
that: nothing has been written when it is returned, and it never reaches the browser.

What is it, from first principles? `reconcileItem` looks at one item and says what reconcile
will do to it: create, close, resize, or nothing. The repository then does it; its own code
calls the list `plans` and `planned`. So it is the action reconcile takes, decided before it is
taken. The tree's word for "what may be done" is **action**: `runActions`, `taskActions`, the
action matrices. Reconcile's actions are the system's, not a person's, but the word carries
the same sense, and "the actions table" reads beside "the action matrices" without a new word.
Rejected: `ReconcilePlan` (plan is billing's word for the tier, and would become a shared word
for nothing), `ReconcileDecision` (a new word for the same thing), `ReconcileResult` (would
pass the shape-family lint and lie about what the family means).

Recommendation: `ReconcileOutcome` → `ReconcileAction`; the outcomes table → the actions
table, its last column `action`; `parseReconcileOutcomes`, `RECONCILE_OUTCOME_WORDS`,
`expandReconcileOutcome` and the test title `Domain.reconcileItem outcomes` follow. The drafts
below already say "action". Question 8.

### Fault 4: "sums" says nothing

`ReconcileAllSums` is what `RunRepository.reconcileAll` returns: the per-order
`ReconcileCounts` added up over the pass (orders walked, runs created, multi-match items) plus
whether any order's closes released the ceiling. It exists for one log line and for the second
pass. "Sums" names the arithmetic, not the thing; a reader who does not know the code cannot
tell what is being summed. The tree's word for this shape is **counts**: `ReconcileCounts`,
`OrdersStreamCounts`.

Recommendation: `ReconcileAllSums` → `ReconcileAllCounts`, "the pass's counts, added over its
orders, for one log line and the release decision"; `sums` in `reconcileAllNow` → `counts`.
Neither gets a vocabulary row: a count for a log line is a mechanism word. Question 9.

### Fault 2: the "reconcile all" row is narrower than its triggers

The row says "reconcile every stored open, paid order once, after a workflow changes". The
triggers table runs it after Delete team and after the open-run ceiling releases, neither of
which is a workflow changing. Recommended meaning cell: "reconcile every stored open, paid order
once, after anything that changes which workflows are eligible or whether a run may be created".
Symbol cell: add `RunRepository.reconcileAll` beside `ShopWorkAgent.reconcileAllNow`, since the
reconcile row names its repository twin. Not a question; a fix in the same change as the spec.

### Not a fault, but say it once

"Sync" is the orders word (making Baton's copy of an order agree with Shopify) and "reconcile"
is the shop-work word (making the runs agree with the order). The user's framing, "they take
order data and sync it up to the database", is the pipeline: a sync followed by a reconcile.
The spec should say in one sentence that store is sync and never call reconcile a sync, so the
two words stay apart as the vocabulary has them.

## What a light spec is, in this tree

The tree already has four spec forms, each checked by `pnpm spec check`. The choice for the
missing pieces is which of them fits, not a new form. Store is sync, the orders word; reconcile
is shop work's; the spec never calls one the other.

| form                     | where                                              | fits when                                                                                   | checked how                                             |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| action matrix            | `runActions`, `taskActions`, the outcomes table    | inputs are a few enumerable states and every cell is a case: the test expands every fixture | parsed, rows must not overlap, the test reads the table |
| triggers table           | `ShopUsage`, the triggers table on `reconcileItem` | one row per event, columns are fixed-word effects, a `pinned by` test title                 | parsed, effect words from a list, every title exists    |
| rules table              | `initializeSchema`, `D1_TABLES`                    | invariants that are not cases: one row per rule, `holds by`, `pinned by`                    | parsed, every title exists                              |
| copy and controls tables | `CopySlot`, `Control` in `Screen.ts`               | screens                                                                                     | parsed, every example is shown somewhere                |

The missing reconcile rules are of two kinds, and each maps to one existing form:

- **Side effects per action** are a triggers table: the row is the action (`create`,
  `close`, `resize`, `nothing: declined`), the columns are fixed-word effects (the run row, the
  counted order, the usage queue, the ceiling flag), and each has a test title. This is the
  `ShopUsage` form with reconcile's actions as the trigger column.
- **Pass invariants** (one transaction, read storage not the caller, ceiling counted once,
  release before decline, second pass once, flush whatever happened, snapshot) are rules, not
  cases: the data-model form, one row per rule, `holds by` replaced by `where` (which symbol
  enforces it), `pinned by` a title.

The sync pipeline is a triggers table too: the row is the source of orders (webhook, open-orders
sync, one-order sync, seed), the columns are the steps.

Prose stays for the why: the two gates, one run per item, "a late run, not a wrong one". The
tables carry the what; the paragraphs carry the reasoning, as `reconcileItem`'s JSDoc does
today.

### Where the spec lives

Two defensible homes for the pass rules:

- **On the enforcer.** AGENTS.md: a rule is stated once "on the symbol that enforces it or the
  symbol that is the concept". `reconcileOrder` enforces the transaction and the budget;
  `reconcileAllNow` enforces the second pass and the flush. Each rule would sit on its enforcer
  and `reconcileItem` would `{@link}` them.
- **On the concept.** `reconcileItem` is the symbol that is reconcile, its JSDoc already holds
  the two tables, and a person reading the spec reads one JSDoc. The pass rules would name
  their enforcer in a `where` column, and the enforcers' JSDocs would say "the rules are on
  `reconcileItem`" and link.

Recommendation: the concept. The user's stated purpose is one place a human reads to agree with
the LLM; splitting the rules across a repository, a service and the class defeats it, and the
data-model tables already put repository behaviour ("one transaction", "written never derived")
on a domain-side symbol with a `holds by` column. The enforcers keep one line each and a link.
Question 2 below.

The pipeline table is different: it is not shop work's, so it does not go on `reconcileItem`.
The agent map on `ShopAgentHost` (`src/lib/agent/Host.ts`) already has a services table and the
sentence about the sync wiring. The pipeline table goes under it. Question 4 below.

## The proposed spec, drafted from the implementation

Everything below is what the code does today, written as rules. Where no test pins a row the
cell says `(none yet)`, as the triggers table does. The user edits these drafts; the plan then
carries the edits into the JSDocs and the tests.

### A. Effects table, on `reconcileItem`

What each action does beyond the item's run. `run row` is one of `inserted with its tasks`,
`closed`, `quantity rewritten`, `untouched`; `counted order` is one of `counted if not yet`,
`—`; `queue` is one of `+1 order event`, `—`; `ceiling flag` is one of `raised`, `may release`,
`—`.

| action                       | run row                 | counted order      | queue          | ceiling flag | pinned by                                                                           |
| ---------------------------- | ----------------------- | ------------------ | -------------- | ------------ | ----------------------------------------------------------------------------------- |
| create                       | inserted with its tasks | counted if not yet | +1 order event | —            | an order is counted once, when its first run is created                             |
| close (any reason)           | closed                  | —                  | —              | may release  | a close by reconcile releases the ceiling and says so                               |
| resize                       | quantity rewritten      | —                  | —              | —            | (none yet)                                                                          |
| nothing: declined            | untouched               | —                  | —              | raised       | reconcile yields to the ceiling and records it; the run's last Done clears the flag |
| nothing (every other reason) | untouched               | —                  | —              | —            | is idempotent, and a closed item creates nothing on reconcile                       |

"Counted if not yet": a seeded order is never counted, and a second run on a counted order
counts nothing; those are rows of the `ShopUsage` triggers table and this table links them
rather than restating them.

### B. Pass rules, on `reconcileItem`

One row per invariant of a pass, in the order a pass meets them. `where` names the symbol that
enforces the rule.

| rule                                                                                                                                                            | where                                                       | pinned by                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| a pass reads the stored order, items and runs, never the caller's copy; a stored run whose item is not stored is read as an item at zero units                  | `RunRepository.reconcileOrder`                              | (none yet)                                                                          |
| a pass runs inside its order's write: the store and its runs commit together or not at all; reconcile all opens one transaction per order                       | `OrderRepository.upsertOrder`, `RunRepository.reconcileAll` | (none yet)                                                                          |
| the eligible workflows and the teams are read once before the transaction and every order in the pass sees the same snapshot                                    | `ShopWorkAgent.eligibleContext`                             | (none yet)                                                                          |
| the open-run ceiling is counted once per pass; each create spends one; a close in the same pass refunds nothing                                                 | `RunRepository.reconcileOrder`                              | reconcile yields to the ceiling and records it; the run's last Done clears the flag |
| at the ceiling a pass declines and returns; it never fails, so the webhook returns 2xx and the order is stored without its run                                  | `RunRepository.reconcileOrder`                              | reconcile yields to the ceiling and records it; the run's last Done clears the flag |
| release is decided before the decline flag: a pass that closes and declines reports released and raises the flag again                                          | `RunRepository.reconcileOrder`                              | (none yet)                                                                          |
| a release runs one reconcile all after the transaction, over every stored open paid order; a reconcile all whose own closes release runs once more, never twice | `ShopWorkAgent.afterCeilingReleased`, `reconcileAllNow`     | a reconcile all whose own closes release the ceiling runs once more                 |
| the usage queue is sent after a reconcile all whether or not it finished, and after a stream, never per order                                                   | `reconcileAllNow`, `ShopAgent.onOrdersStream`               | (none yet)                                                                          |
| a pass is idempotent: a second pass over the same stored order and the same snapshot writes nothing                                                             | `reconcileItem`                                             | is idempotent, and a closed item creates nothing on reconcile                       |
| no count a pass makes reaches a screen; the counts are the log line's                                                                                           | `ReconcileCounts`, `ReconcileAllSums`                       | (none yet)                                                                          |

Six of ten rows have no test. That is the honest state; the plan adds the tests, or the user
strikes rows that do not earn one.

### C. Sync pipeline table, on `ShopAgentHost`

One row per source of orders. `store` is the orders write; `reconcile` is the shape from the
triggers table; `flush` is when the usage queue is sent; `release` is when a released ceiling
runs its reconcile all; `publish` is who is told.

| source                        | store                                               | reconcile                          | flush                 | release                       | publish                                  |
| ----------------------------- | --------------------------------------------------- | ---------------------------------- | --------------------- | ----------------------------- | ---------------------------------------- |
| order webhook                 | fetch one, upsert; dedupe, staleness, order ceiling | reconcile, inside the upsert       | after the order       | after the order               | the order, to the teams before and after |
| open-orders sync (the stream) | upsert each streamed order                          | reconcile each, inside its upsert  | once after the stream | once after the stream         | all                                      |
| one-order sync (the button)   | fetch one, upsert; no dedupe                        | reconcile, inside the upsert       | after the order       | after the order               | the order                                |
| workflow and team verbs       | —                                                   | reconcile all                      | after the pass        | inside the pass (second pass) | all                                      |
| seed (dev)                    | upsert each                                         | reconcile each, then reconcile all | after                 | —                             | all                                      |

The `pinned by` column is omitted here on purpose: the rows are wiring, and the tests that
cover them are the stream, ceiling and webhook suites by file, not by rule. Question 5 asks
whether that is acceptable or whether this table too should carry titles.

### D. The vocabulary changes

| change                                                        | where                                    |
| ------------------------------------------------------------- | ---------------------------------------- |
| billing's `reconcileUsage` family renamed (question 1)        | billing files, `initializeSchema`, tests |
| the "reconcile all" row's meaning and symbol cells            | the shop-work nouns table                |
| one sentence on `reconcileItem`: store is sync, not reconcile | the `reconcileItem` JSDoc                |

## What `pnpm spec check` would do

Today it parses the triggers and outcomes tables on `reconcileItem` and checks every
`pinned by` title in the triggers table exists. The additions reuse `nthTable` and
`checkPinned` in `scripts/lib/spec.ts`:

- parse the effects table (table 3 on `reconcileItem`) with fixed-word columns, refuse a word
  outside its list, check titles;
- parse the pass rules table (table 4) as the data-model parser does, check titles;
- parse the pipeline table on `ShopAgentHost` for its header and fixed `reconcile` words only.

No fixture expansion for any of them: none is a case matrix. `pnpm spec print` prints the rows
and counts the `(none yet)` cells, so the gap is visible on every run.

## Decisions

Reviewed 2026-10-01 in Plannotator. Accepted as recommended:

1. **The pass rules live on `reconcileItem`**, as tables 3 and 4 of its JSDoc with a `where`
   column naming the enforcer; `reconcileOrder`, `reconcileAll` and `reconcileAllNow` keep one
   sentence and a link each.
2. **The effects that count as spec** are the run row, the counted order, the usage queue and
   the ceiling flag. Not logs, not the publish.
3. **The pipeline table lives on `ShopAgentHost`** in `src/lib/agent/Host.ts`, under the
   services table.
4. **`(none yet)` stays allowed by the check and `pnpm spec print` counts it, but the plan
   writes the missing tests.** The user: "we do want these to be part of the implementation
   plan. Since we're doing the work, we don't want to end up with none yet when we can have
   tests for them." So the plan's test phase covers every `(none yet)` on reconcile's own
   tables, the triggers table's two included; the check tolerates the cell for the next spec,
   not for this one.
5. **The pass is a rules table**, not prose.
6. **The pipeline table carries no `pinned by`.**
7. **Billing's reconcile is renamed to Shopify's words** (Fault 1): `checkMeters`,
   `MeterQuantitiesInput`, `ShopUsage.meterQuantityOrders` and `meterQuantityMembers`,
   `meterDiverges` unchanged; billing rows for meter quantity and diverge; a "meters checked"
   row in the `ShopUsage` triggers table. Same change as the spec, under the vocabulary runbook.
8. **`ReconcileOutcome` becomes `ReconcileAction`** and the outcomes table the actions table
   (Fault 3); `parseReconcileOutcomes`, `RECONCILE_OUTCOME_WORDS`, `expandReconcileOutcome` and
   the test title follow.
9. **`ReconcileAllSums` becomes `ReconcileAllCounts`** (Fault 4); `sums` in `reconcileAllNow`
   becomes `counts`.

## Questions

No open questions remain (2026-10-01).

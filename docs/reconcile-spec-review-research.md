# Reconcile spec review: gaps, contradictions and concerns from first principles

Written 2026-10-01. Status: implemented 2026-10-01 by `docs/reconcile-spec-review-plan.md`.

The ask: the reconcile specs (the triggers, actions, effects and pass rules
tables on `reconcileItem` in `src/lib/domain/ShopWork.ts`, the pipeline table on
`ShopAgentHost` in `src/lib/agent/Host.ts`, and the rows they lean on in `RunState`,
`ClosedReason`, `ShopUsage` and `syncOrder`) were derived from the implementation. Read them as
a spec, from first principles, and say where they are incomplete, contradictory or worrying,
so the spec can be fixed first and the code and tests made to follow.

This doc reads the spec, not the code, except where a question needs a fact about what the
code does today. Those facts are marked "today:". A finding about the code is a finding
about the spec: either the spec should say it, or the code should stop doing it.

## The short version

1. **The spec has no statement of what "agree" means.** Reconcile is defined as "make an
   order's runs agree with the order and the eligible workflows", and the tables then list
   cases. Nothing states the condition that holds after a pass. That one paragraph is the
   highest-leverage thing to add: it is the rule the thirteen action rows are examples of, it
   is what idempotence (pass rule 9) is relative to, and it is what a property test checks.
   Section 1 drafts it.
2. **The actions table is not total.** Three combinations of its own column values hit no
   row: a closed order with an item that has no run; an open order with an item at zero units
   and no run; an unpaid order with a multi-match item. Today the code answers `nothing` for
   all three. The spec should say so, and `pnpm spec check` should refuse a matrix that does
   not cover every combination. Section 2.
3. **Two column words are undefined.** `units` takes `0`, `changed`, `same`, `some`, `any`,
   and the preamble defines none of them; `changed` is relative to the run's quantity, not to
   Shopify's ordered quantity, which a reader cannot know. Section 2.
4. **The ceiling release trigger is written as a contradiction.** "the open-run ceiling
   releasing | skipped when: still at the ceiling". The trigger is a write that lowers the
   open-run count; the skip is "no run was declined, or the count is still at the ceiling".
   And the spec never lists which writes lower the count. Today the retention sweep deletes
   open runs and does not ask; Reopen raises the count and does not check the ceiling.
   Section 3.
5. **One test title pins four cells.** "reconcile yields to the ceiling and records it; the
   run's last Done clears the flag" is the `pinned by` of pass rules 4 and 5 and of the
   `nothing: declined` effects row. One test for three rules is one test. Section 6.
6. **Three definitions of multi-match disagree on the payment gate.** The nouns row says
   "two or more eligible workflows match, with no run"; the issues row adds "on an order
   that can create runs"; `multiMatchItems` the function has no gate and `ReconcileCounts`
   has one. Section 4.
7. **Two interactions the spec does not see.** Line-item truncation (sync rule 10) plus pass
   rule 1 (a run whose item is not stored reads as zero units) closes a real run as "Item
   removed or refunded in Shopify" when an item drops out of the kept 250. And a closed
   run holding its item means an item refunded to zero and edited back up shows a quantity
   beside "Item removed", with no issue raised. Section 5.
8. **Three non-triggers should be rows.** A product retag in Shopify, the retention sweep,
   and Delete workflow's effect on its own runs are each something a merchant will ask
   about, and the table is silent. The Attach row shows the pattern: a row whose shape is
   `none` with the reason. Section 3.

The recommendations are in each section and gathered at the end with the questions.

## 1. What a pass guarantees

The vocabulary says reconcile makes "an order's runs agree with the order and the eligible
workflows; idempotent". Agree how? The actions table answers by cases. From first principles
the answer is a post-condition: after a pass over stored order `O` with eligible snapshot
`S`, for every item `i` of `O`, with `r` the run on `i` if any:

- **Stop.** If `O` is cancelled or fulfilled: `r` is not open. (It is closed with the
  order's reason if it was open; `done` and `closed` runs are untouched.)
- **Fit.** Else if `r` is open: `r.quantity` equals the item's units to make; and if the units
  are zero, `r` is closed `item_removed` instead.
- **Record.** Else if `r` is `done` or `closed`: untouched. The item is decided.
- **Create.** Else (no run): a run exists from the one workflow in `S` that matches `i`, if
  `O` can create runs, `i` has units, exactly one workflow matches, and the shop is under the
  ceiling. Otherwise no run.
- **Orphan.** A stored run whose item is not stored is treated as an item at zero units.

Plus two properties over the whole: a pass writes only what the condition requires (no
write when it already holds, which is pass rule 9), and the condition is reached in one
transaction (pass rule 2).

What this buys:

- The thirteen action rows become derivable. A reader checks a row against four sentences
  instead of holding thirteen rows in their head. The matrix stays as the fixture set.
- The gaps in section 2 are visible by construction: every combination of the inputs falls
  into one clause.
- It is a property test: generate order states, runs and snapshots, apply `reconcileItem`'s
  action, check the condition, apply again, check nothing is returned. That test is stronger
  than the thirteen fixtures and shorter to write. The matrix test stays because the rows are
  the human-readable examples.

Recommendation: add the post-condition to the `reconcileItem` JSDoc above the tables, in
roughly the five clauses above, and a test titled with it. Question 1 asks whether the five
clauses are right, which is the real review.

## 2. The actions table

The table's column values, as written: `order` ∈ {cancelled, fulfilled, closed, open};
`paid` ∈ {any, yes, no}; `units` ∈ {any, 0, changed, same, some}; `run on item` ∈ {open;
open, unstarted; open, started; done or closed; none}; `matches` ∈ {any, 0, 1, 2+, "1, at
the ceiling"}.

### Rows it does not have

| order  | paid | units | run on item | matches           | today   | should say                                                  |
| ------ | ---- | ----- | ----------- | ----------------- | ------- | ----------------------------------------------------------- |
| closed | any  | any   | none        | any               | nothing | nothing: the order is over, nothing to create               |
| open   | any  | 0     | none        | any               | nothing | nothing: no units to make                                   |
| open   | no   | some  | none        | 2+                | nothing | nothing: not choosing until it pays (see sec. 4)            |
| open   | no   | some  | none        | 1, at the ceiling | nothing | nothing: created when it pays; the ceiling is not consulted |

The first two are plain omissions. The third and fourth depend on how the parser reads
`matches`: if "1, at the ceiling" is a value distinct from "1", then the `paid: no` row
with `matches: 1` does not cover it. Either way, the reader cannot tell.

Recommendation: add the rows, and make `pnpm spec check` refuse a matrix whose rows do not
cover every combination of its column values exactly once. The check already refuses
overlap; totality is the other half and is cheap once the column vocabularies are listed.
Question 2.

### Words the preamble does not define

The preamble defines `any`, `closed` under `order`, `open` under `run on item`, and
`matches`. It does not define the `units` words:

- `0`: units to make is zero.
- `some`: above zero.
- `same`: above zero and equal to the run's quantity.
- `changed`: above zero and not equal to the run's quantity.

Two things a reader needs and cannot infer: that `changed` compares to the run's quantity
and not to Shopify's `quantity` (ordered), and that `0` is not a case of `changed`. The
same preamble should say `paid` reads `fullyPaid` and nothing else, since the creation gate
is `orderCanCreateRuns` and a reader will otherwise wonder whether "paid" includes
authorized or partially paid.

Recommendation: one sentence per column word in the preamble, as the triggers table does
for `shape`.

### The resize rows

"resize: no badge" and "resize: badge from the original" say what the action does, not
what the badge holds afterwards. Today:

- The badge is `quantityChangedFrom`, the quantity before the first resize after a task
  started, and a resize back to that number clears it. The table does not say the badge
  clears on return.
- An unstarted run keeps a badge it already has. A run can be unstarted and badged: a task
  started, the quantity changed (badge set), the task was put back (`startedAt` cleared,
  so `runIsUnstarted` is true again). The next resize "without a badge" keeps the old one
  unless the units return to the original.

Both may be right. The spec should say which: the simplest statement is "the badge is the
quantity the first started task was cut to; it clears when the units return to it or the run
closes; a resize on an unstarted run never sets it and never clears it". Question 3.

### The item order at the ceiling

Rule 4 says each create spends one unit of room, so at the ceiling the items that get runs
are the first ones in the pass. Which order the pass walks items in is not stated. It does not
matter for correctness, but a merchant who sees item 3 of 5 get a run and items 4 and 5
declined will ask. Recommendation: one clause on rule 4, "items in their stored order".

## 3. The triggers table

### The release row contradicts itself

"the open-run ceiling releasing | reconcile all | skipped when: still at the ceiling". A
ceiling that is releasing is not still at the ceiling. What the row means, read with
`releaseOpenRunLimit`'s JSDoc: the trigger is any write that lowers the open-run count; it
runs a reconcile all when a run was declined earlier (the flag is set) and the count is now
under the ceiling; otherwise nothing.

Recommendation: rename the trigger "a write that lowers the open-run count" and the skip "no
run was declined, or the count is still at the ceiling", and list the writes in the row's
pinned-by or in a pass rule.

### Which writes lower the count

The spec never lists them. Today `releaseOpenRunLimit` is called after a run's last Done,
Cancel workflow and a close by reconcile, and its JSDoc says "only those". But the open-run
count also drops when:

- the retention sweep deletes an order with open runs. The retention sweep is the delete
  that keeps the object's storage bounded: an order whose `processedAt` is older than
  `ShopLimits.orderRetentionDays` (365 days) is deleted on the next pass, open or closed, with
  its runs, in one transaction and with no close recorded. It rides the open-orders sync and,
  at most every six hours, the webhook path; there is no alarm. The rule is on `ShopLimits`
  and the SQL is `OrderRepository.sweepExpiredOrders`;
- Change workflow replaces an open run (count unchanged, −1 then +1, so no release);
- a manual attach over a closed run (+1, no release).

And it rises without a ceiling check on Reopen (a `done` run becomes open). Manual attach
does check (`RunLimit`).

From first principles the ceiling is a safety valve, so a sweep that forgets to release and a
reopen that goes one over are both tolerable, but the spec should say so rather than leave a
reader to discover the list in a repository JSDoc. Recommendation: a pass rule, "the open-run
count is lowered by a run's last Done, Cancel workflow, a close by reconcile and the retention
sweep; the first three ask whether the ceiling released and the sweep does not, because its
orders are a year old; Reopen and Change workflow may raise the count past the ceiling by
one". Question 4 asks whether the sweep should ask too (it is one call).

### Rows that should exist for things that never trigger

The Attach row is the model: shape `none`, skipped when "always: the merchant's choice". Three
more things a merchant will do and expect a result from:

| trigger                           | shape | skipped when                                                                                      |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| a product retagged in Shopify     | none  | always: an item's tags are a snapshot taken at sync; the next sync of its order sees them         |
| the retention sweep               | none  | always: it deletes the order and its runs, open ones included, with no close recorded             |
| Delete workflow, for its own runs | none  | always: a run copies its definition and carries on; only its multi-match survivors are reconciled |

The first is the one most likely to surprise: "I tagged the product and no workflow started".
The `OrderLineItem` JSDoc says tags are a snapshot, but nothing in the reconcile spec does, and
the triggers table is where a person looks. Question 5 asks whether a retag should instead
be a trigger (a `products/update` webhook resyncing the open orders that carry the product),
which is a product decision, not a spec fix.

The third is stated from `WorkflowState`'s "open runs carry on" for Turn off and the `Run`
row's copied definition; I did not find a statement for Delete. If Delete does delete runs,
that is a stop with no `ClosedReason` and the spec is missing more than a row. Question 6.

### "Open" in the pinned titles means "open and paid"

Turn on's title: "creates runs on every stored open order, however old it is". Reconcile all
walks open _paid_ orders (the vocabulary row and pass rule 7 say so). The title drops the
word. Minor; fix the titles so a reader of the table alone is not misled.

### Two ceilings share a column

"order ceiling" (webhook, Sync open orders rows: `maxOrdersPerCycle`, billing) and "the
open-run ceiling" (`maxOpenRuns`, shop work) both appear under `skipped when`. The Platform
vocabulary has "ceiling" as one word for all of `ShopLimits`. In this table the two do
different things: the order ceiling stops the store, the open-run ceiling declines a create
inside it. Recommendation: always qualify, "order ceiling" and "open-run ceiling", in every
cell; the bare "the ceiling" in "still at the ceiling" and in rules 4 to 6 should be
"open-run ceiling".

## 4. Multi-match has three definitions

| where                            | definition                                                | payment gate |
| -------------------------------- | --------------------------------------------------------- | ------------ |
| shop-work nouns row              | an item two or more eligible workflows match, with no run | no           |
| order issues row, `orderIssues`  | …on an order that can create runs                         | yes          |
| `multiMatchItems` (the function) | units to make, two or more matches, no run in any state   | no           |
| `ReconcileCounts.multiMatch`     | the same, counted only when the order can create runs     | yes          |

The actions table's "nothing: multi-match" row is `paid: yes`; the unpaid case has no row
(section 2). The JSDoc on `OrderRow` says "An unpaid order with a multi-match item is not
choosing: reconcile would not create a run either way". That is the right reason, and it
belongs in the noun.

Recommendation: one definition, in the nouns row, with the gate: "an item two or more
eligible workflows match, with units to make and no run, on an order that can create runs".
`multiMatchItems` the function then either takes the order or is renamed to say it counts
candidates. The issues row links the noun instead of restating it. Question 7.

## 5. Interactions the spec does not see

### Truncation closes a real run as "Item removed"

Sync rule 10: an order keeps at most 250 items, the rest dropped and the order flagged. Pass
rule 1: a stored run whose item is not stored reads as an item at zero units, and closes
`item_removed`. Together: an order with 260 items, a run on the 255th (created when it was
among the kept 250, before an edit added items ahead of it, or because Shopify's order of
items differs between the bulk file and the single fetch), and the next sync drops it. The
run closes with the screen line "Item removed or refunded in Shopify", which is false.

The probability is low (a made-to-order shop with a 250-item order), and the two rules are
each right alone. But a spec whose rules combine into a lie should say which one yields.
Options:

- Rule 1 yields: on a truncated order (`lineItemsTruncated`), a run whose item is not stored
  is untouched. The cost is that a genuinely removed item on a truncated order is never
  closed.
- Rule 10 yields: an order past 250 items is refused, not truncated. The cost is the order
  is not in Baton at all.
- Accept it and say so in rule 1.

Recommendation: the first. Question 8.

### A closed run holds its item, and the screen shows the contradiction

Decision 7 of the reconcile research: an item refunded to zero and edited back does not
restart. The run stays closed `item_removed`. The order page then shows the item with
units to make beside "Item removed or refunded in Shopify", and no issue is raised
(`orderIssues` has no row for it; the position is "not started"). The merchant's remedy is
Change workflow, which they will find only if they look.

This is not a contradiction in the spec; it is a consequence the spec should own. Either an
issue ("Closed with units to make", or reuse the picker's prompt) or a sentence on
`ClosedReason` saying the merchant reattaches by hand. Question 9.

### Reconcile all's own closes are nearly unreachable

Pass rule 7's second half: "a reconcile all whose own closes release runs once more, never
twice". Reconcile all walks open paid orders, so the stop gate never fires in it; the only
close it can make is `item_removed`, which requires a run on an item at zero units that no
earlier pass closed. Every write that changes an item's units runs a reconcile in the same
transaction, and a pass is idempotent, so the condition can arise only from a path that
writes items without reconciling. I found none in the spec. The rule is harmless and the
test exists, but a reader will look for the case and not find it. Recommendation: say in
rule 7 that the case exists for a run whose item was dropped without a reconcile, or drop
the clause. Question 10.

### The snapshot and a deleted team

The `reconcileItem` prose: "A team deleted in the middle of a sync is not seen by the rest of
it; the price is a late run, not a wrong one." Today `deleteTeam` nulls `RunTask.teamId` for
existing tasks, then reconciles all. A run created from the stale snapshot after the null
carries the dead team id on its task; `orderIssues` reads teams live, so the task reads
"Needs a team". That is a run with a fault, not a late one. The fault is visible and the fix
is one assignment, so the outcome is fine; the sentence should say "a run whose task shows
Needs a team" rather than "a late run".

## 6. The pass rules

### One title pins three rules

| pinned title                                                                        | rules and rows it pins                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| reconcile yields to the ceiling and records it; the run's last Done clears the flag | rule 4, rule 5, effects row `nothing: declined`    |
| is idempotent, and a closed item creates nothing on reconcile                       | rule 9, effects row `nothing (every other reason)` |

AGENTS.md: "Each rule has a test whose title is the rule." A test that pins three rules is
a test whose failure says nothing about which rule broke, and a rule whose test also checks
two others is one nobody can retitle. Rule 4 (budget counted once, no refund) and rule 5
(declines, never fails, webhook 2xx) are different claims with different fixtures: rule 4
needs two creates and a close in one pass; rule 5 needs the webhook path. Recommendation:
split, one title per rule. Question 11 asks whether that is worth the test count.

### Rule 8 is two rules

"the usage queue is sent after a reconcile all whether or not it finished, and once after a
stream, not per streamed order". The first half is shop work's; the second is sync rule 12
restated. Keep the first; link the second.

### Rule 3's snapshot is per webhook, but which webhook

"read once before the transaction" is right for a webhook and a reconcile all. For the
stream, the snapshot is per stream, so a Turn on during a ten-minute stream is seen by none of
its orders, and the Turn on's own reconcile all runs concurrently with the stream's
per-order transactions. Both reconcile the same orders with different snapshots; each pass is
idempotent, so the result is the union, which is right. Say it: "a reconcile all and a stream
may interleave; every order ends under the newer snapshot because each pass is idempotent".
Otherwise a reader assumes a lock that is not there.

### Nothing bounds a reconcile all

Reconcile all is one transaction per stored open paid order, on every Turn on, Turn off,
Delete workflow, Delete team, Apply changes, tag edit and ceiling release, twice on a
release. The spec has no bound and no cost rule. Retention bounds stored orders at a year;
the order ceiling bounds new orders at 100 a cycle; a shop at both has at most roughly 1,200
orders, and reconcile all reads items and runs for each. That is fine today. It is worth one
sentence so the next person does not add a trigger without seeing the cost, and so the
Durable Object's CPU limit is a known risk: "reconcile all is bounded by retention and the
order ceiling, not by a limit of its own". Question 12.

### A reconcile all that fails partway

Rule 2 says one transaction per order; rule 8 says the queue is sent even on failure. Neither
says what the orders already walked are left as. From rules 2 and 9: they keep their writes
and the next trigger finishes the rest. Say it on rule 2.

## 7. The payment gate, from first principles

`orderCanCreateRuns` is `fullyPaid` and not cancelled. The JSDoc on it names the choice:
authorized is not paid, and a manual-capture shop would need a clause. Two cases the spec
does not reach:

- **A fully refunded order.** A refund that returns the money without refunding the line
  items leaves `currentQuantity` alone, and Shopify's `fullyPaid` stays true for an order
  whose charges were captured. The runs carry on. For a made-to-order shop a refund usually
  comes with a cancel, which is the stop gate; a refund without a cancel is a merchant who
  wants the item made anyway (a goodwill refund). So the gate is probably right, but the spec
  should say "a refund is not a stop; only a cancel, a fulfillment or units at zero stop
  work". Question 13.
- **An archived order** (`closedAt` set in Shopify). Not mirrored, by the `ShopOrder` JSDoc.
  Shopify archives fulfilled or cancelled orders, both already stop gates, and a merchant can
  archive an open order by hand. Then Baton keeps making it. Likely rare; the spec should
  name it as not a stop.

## 8. What the effects table does not say

- **`create` → "counted if not yet"** is right, and the two exceptions are linked to
  `ShopUsage`. But the count is "orders Baton created a run for" and manual attach also
  creates. Attach is outside reconcile (shape `none`), so its counting is on `orderIsOpen`'s
  JSDoc. A reader of the effects table will not find it. One sentence under the table.
- **`close` → "may release"** is the ceiling flag; the block and the badge also clear
  (`closeOpenRuns`). The decision was that the effects that count are the run row, the count,
  the queue and the flag, so this is in scope only if "run row: closed" is meant to include
  what closing clears. The `RunState` prose says it. Fine as is; noted.

## Recommendations, gathered

| #   | change                                                                                                       | where                                    |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 1   | State the post-condition of a pass (section 1), with a test, ideally a property test                         | `reconcileItem` JSDoc, above the tables  |
| 2   | Add the missing action rows; `pnpm spec check` refuses a non-total matrix                                    | actions table; `scripts/lib/spec.ts`     |
| 3   | Define `units` and `paid` column words in the preamble                                                       | actions table preamble                   |
| 4   | State the badge rule: set, cleared on return, never touched on an unstarted run                              | resize rows, `Run.quantityChangedFrom`   |
| 5   | Rewrite the release trigger row; list the writes that lower the count; say the sweep and Reopen do not check | triggers table, a new pass rule          |
| 6   | Add non-trigger rows: product retag, retention sweep, Delete workflow's own runs                             | triggers table                           |
| 7   | Qualify every "ceiling" as order ceiling or open-run ceiling                                                 | triggers table, pass rules 4–7           |
| 8   | One definition of multi-match, with the gate, in the noun                                                    | nouns row, issues row, `multiMatchItems` |
| 9   | Rule 1 yields on a truncated order                                                                           | pass rule 1, `reconcileOrder`            |
| 10  | Own the closed-run-with-units case: an issue or a sentence                                                   | `ClosedReason` or `OrderIssue`           |
| 11  | One test title per rule: split rules 4, 5 and the declined row                                               | pass rules, effects table, tests         |
| 12  | Rule 8 keeps its first half and links sync rule 12                                                           | pass rule 8                              |
| 13  | Say a stream and a reconcile all may interleave and why that is safe                                         | pass rule 3                              |
| 14  | Say what bounds a reconcile all and what a partial failure leaves                                            | pass rules 2 and 7                       |
| 15  | Say a refund and an archive are not stops                                                                    | `reconcileItem` gates prose              |
| 16  | Titles say "open paid order" where reconcile all is meant                                                    | triggers table pinned titles             |

## Decisions

Reviewed 2026-10-01 in Plannotator: every recommendation accepted as drafted. The questions
that produced them, restated as decisions:

1. The post-condition in section 1 is the rule of reconcile, with question 8's exception
   (a run whose item is not stored on a truncated order is left alone).
2. `pnpm spec check` refuses a non-total action matrix, for `reconcileItem`, `runActions`
   and `taskActions`.
3. The badge: set by the first resize after a task started; cleared when the units return to
   the original or the run closes; a resize on an unstarted run clears any badge it has.
4. The retention sweep asks whether the ceiling released; the rule lists every write that
   lowers the open-run count with no exception.
5. A product retag in Shopify is not a trigger; the triggers table gets a `none` row saying
   tags are a snapshot taken at sync.
6. Delete workflow leaves its runs to carry on, as Turn off does; the triggers table says so.
7. Multi-match has one definition, in the nouns row, with the payment gate;
   `multiMatchItems` takes the order or is renamed.
8. On a truncated order, a run whose item is not stored is left alone (rule 1 yields).
9. A closed run on an item with units to make: a sentence on `ClosedReason` says the
   merchant reattaches by hand; no issue yet.
10. Rule 7's second half stays, with a sentence naming the case it guards.
11. One test title per rule: rules 4 and 5 and the declined effects row each get their own.
12. Reconcile all gets no bound of its own; the rule states what bounds it.
13. A refund is not a stop, and neither is an archive; the gates prose says so.
14. Rule 4 stays: closes refund nothing inside a pass; the reconcile all after a release
    creates what was declined.

The plan that carries these into the JSDocs, `scripts/lib/spec.ts` and the tests is the
next step.

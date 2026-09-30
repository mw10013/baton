# The vocabulary's `stored` column, and how far the ubiquitous language reaches into storage

Research, 2026-09-30. Question: two vocabulary tables carry a `stored` column. What is it, why is
it there, and does it mark a place where storage names diverge from the vocabulary? Can the
vocabulary reach all the way down to table and column names, where does that break, and should
we try?

## 1. What the `stored` column is

It appears in exactly two tables, both in `src/lib/domain/ShopWork.ts`:

| table           | word    | stored             |
| --------------- | ------- | ------------------ |
| Run states      | open    | `open`             |
| Run states      | blocked | `blockedAt` set    |
| Run states      | done    | `done`             |
| Run states      | closed  | `closed`           |
| Workflow states | on      | `activatedAt` set  |
| Workflow states | off     | `activatedAt` null |

The sibling tables use a different header or none. Task states has `derived from` (`startedAt`
set, `doneAt` set, current or not). Order positions and order issues say in their intro "derived
by X and never stored" and have no column.

So the column answers one question per state word: **what in the row makes this word true?**
There are three kinds of answer, and the column mixes them:

1. A literal that is the word: `open`, `done`, `closed` are the values of `Run.status`.
2. A predicate over a column that is not a literal: `blockedAt` set. There is no `blocked` literal;
   the word is the predicate `runIsBlocked`, and the column holds more than the word (when, and
   `blockedBy` who).
3. A predicate over a column whose name is not the word: `activatedAt` set or null for on and off.

It is not a second naming system for storage. It is a pointer from the concept to the evidence,
the same job the data-model tables do with the phrases "stored, never derived", "derived and
stored", "derived, never stored" (the vocabulary paragraph on `initializeSchema`). It got its
name in commit 7d6f233 ("Refine run domain language"), when both cells said `active`; the
vocabulary pass then made rule 4 of the entry test ("A stored literal is the vocabulary word
where the store is ours; Shopify's literals are stored as sent and read through a predicate")
and changed the run's literal from `active` to `open`. The workflow's `activatedAt` was kept on
purpose and deferred to the reconcile spec, because the column is the coverage date, which the
merchant moves from the workflow page, so `onAt` or `onSince` would misname it
(`docs/domain-vocabulary-plan.md`, Phase 5 row 9; `docs/reconcile-research.md`, "coverage date").

What the check does with it: `checkVocabulary` in `scripts/lib/spec.ts` takes every backticked
identifier in the vocabulary block and requires it to occur in the source outside the block. So
`blockedAt` and `activatedAt` are pinned to exist somewhere, but nothing pins them to be columns,
and nothing pins `open` to be the literal in the `check` constraint.

**Answer to the first question.** The column is not there because storage names differ from the
vocabulary. It is there because a state word is not always a stored literal, and the reader of a
state table needs to know which words are literals (rename the literal when you rename the word)
and which are predicates over other columns (rename nothing; the word lives in `runIsBlocked`).
The one cell where the storage name does differ from the word, `activatedAt`, is a known,
recorded, deferred exception, not the column's reason for being.

## 2. How aligned storage already is

The structural fact that makes alignment cheap: **the Effect Schema struct is the row.** `ShopOrder`,
`OrderLineItem`, `Run`, `RunTask`, `Workflow`, `ShopUsage` are declared once as `Schema.Struct`
with the encoded side being the SQLite row (epoch-ms integers, 0/1 booleans, JSON text). Column
names are camelCase and equal the field names, which equal the identifiers in code. There is no
snake_case mapping layer, no ORM aliasing, no "storage name" distinct from the "code name". One
name serves three layers. Table names are the vocabulary's `symbol` cells (`Run`, `RunTask`,
`Workflow`, `WorkflowTask`, `WorkflowDraft`, `Team`, `Member`, `ShopSession`, `ShopUsage`,
`UsageEvent`).

Baton's own literals are vocabulary words: `open`/`done`/`closed`, `merchant`/`member` in the
`*ByRole` columns, `unassigned` and `ambiguous` are code literals with vocabulary rows. The
`closedReason` literals (`fulfilled`, `order_cancelled`, `item_removed`, `merchant_cancelled`) are
compound but built from vocabulary words.

Inventory of every place a stored name is not the vocabulary word, with the reason:

| stored name                                        | vocabulary word      | kind of divergence                                                                                                     | verdict                                                                                                                     |
| -------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Run.status`, `RunStatus`, `Run_status_idx`        | "Run states"         | Two words for one concept. The tables say state; `OrderState`, `TaskState`, `SyncState` say state; the run says status | Real divergence, Baton's own word. Fix (section 4).                                                                         |
| `Workflow.activatedAt`                             | on / off             | Column is the coverage date, not the switch                                                                            | Known and deferred to the reconcile spec. Keep the deferral.                                                                |
| `ShopUsage.membersHighWater`                       | seat                 | The vocabulary row itself points at it; "high-water mark" is declared a JSDoc term, not a word                         | Real divergence, Baton's own word. Fix (section 4).                                                                         |
| `lineItemId`, `lineItemTitle`, `OrderLineItem`…    | item                 | Screen word is "item"; code word is Shopify's `LineItem`. 300+ occurrences across `src/`                               | Sanctioned by rule 3 (Shopify's things get Shopify's words) and by the same split as run/workflow. Keep; say so on the row. |
| `Run` table                                        | run                  | Screen says "workflow"; code says run                                                                                  | The map's own rule: identifiers speak the vocabulary word, screens the screen word. Aligned.                                |
| `ShopOrder` table                                  | order                | `Order` is a SQL reserved word                                                                                         | Forced. Already explained in a DDL comment.                                                                                 |
| `fulfillmentStatus`, `cancelledAt`, `FULFILLED`    | fulfilled, cancelled | Shopify's field and literal                                                                                            | Rule 4's second clause: stored as sent, read through `orderIsFulfilled`. Aligned by rule.                                   |
| `eventHandle`, `idempotencyKey`, `attempts`        | usage event          | Shopify's App Events words and outbox mechanism                                                                        | Shopify's or mechanism. Not vocabulary by rule 1.                                                                           |
| `webhookId`, `receivedAt`, `lastError`, `syncedAt` | (none)               | Mechanism columns                                                                                                      | Not vocabulary by rule 1 (a word names a concept, not a mechanism). Correct that they have no row.                          |
| `cycleStartAt`, `cycleEndAt`, `ordersThisCycle`    | billing cycle        | "cycle" for "billing cycle" inside a billing-owned row                                                                 | The noun is implied by the table. Acceptable; the row already names them.                                                   |
| `User`, `Session`, `Account`, `Verification`       | (none)               | better-auth's tables, better-auth's names                                                                              | Vendor schema, like Shopify's literals. The D1 data-model row already says "better-auth's tables are better-auth's".        |
| D1 `createdAt text` (ISO) vs object epoch-ms       | (none)               | Representation, not naming                                                                                             | Not a naming question, so out of scope here; recorded as a follow-up in section 6 so it is not lost.                        |

`pnpm vocab:audit` confirms the picture from the identifier side. It lists every word used in an
exported identifier under `src/lib/` that has no vocabulary row, most frequent first; the most
frequent are `agent`, `state`, `session`, `message`, `connection`, `line`, `bulk`, `socket`,
`repository`.
Apart from `state` (the status/state split above) and `line` (the line-item split above), these
are mechanism and platform words, which is what the entry test says should be outside.

## 3. Where full alignment breaks down, and why that is fine

The goal "the vocabulary is ubiquitous, including column names" is right, and the repo is most
of the way there. It cannot be total, for four reasons that are each already a rule somewhere.
The problem is they are stated in four places (the map's entry test, the data-model vocabulary,
DDL comments, the D1 table), not once.

1. **Foreign vocabularies.** Shopify's fields and literals, better-auth's tables, and SQL's
   reserved words are not ours to rename. Rule 3 and rule 4's second clause cover Shopify; the D1
   row covers better-auth; a DDL comment covers `Order`. Aligning these would mean translating at
   the boundary, which invites the exact drift the vocabulary exists to stop (a stored `fulfilled`
   that is not Shopify's `FULFILLED`).

2. **A state word is often richer than a literal.** "blocked" is `blockedAt`, `blockedBy`,
   `blockReason`. Storing a `blocked` literal beside them would be a second copy of one fact,
   with a check constraint to keep them in step, for no reader's benefit. The data-model table
   already tolerates exactly one such copy (`Run.status`, "derived from the tasks and stored")
   and explains why (the workflows list and the definitions badge read it without a join). The
   vocabulary word for a richer state is the predicate, not a column, and the `stored` cell is
   where that is said.

3. **Derived words have no storage.** Positions, issues and task states are computed per read. The
   vocabulary covers them fully on the screen side and there is nothing to align on the storage
   side. This is a feature: fewer stored words means fewer places to rename.

4. **Storage holds mechanisms.** Idempotency keys, delivery ids, attempt counts, sweep timestamps.
   Rule 1 says a mechanism is not a vocabulary word. So the honest statement of the goal is not
   "every column is a vocabulary word" but: **every stored concept is stored under its word, and a
   column that is not a concept is named plainly and is not in the vocabulary.** That is
   checkable, and the repo nearly satisfies it today.

Cost of aligning now versus later: while prototyping there are no migrations (`initializeSchema`
is edited in place and `pnpm dev:reset` restores state), so a column rename costs a grep. After
launch a column rename in the object is a migration run in every shop's Durable Object. Whatever
alignment is wanted is cheapest right now and only gets more expensive.

## 4. Recommendations

R1. **Keep the `stored` column, and fix the three forms a cell may take.** Today a cell is free
text. "Grammar" here means a closed list of cell forms, the way the data-model table fixes its
cardinality phrases ("exactly one", "at most one") so the same fact is always said the same way
and a parser can read it. State the three forms once on the map's vocabulary paragraph, next to
rule 4, reusing the data-model table's derivation phrases so the two specs share words:

- a bare literal (`` `open` ``): stored, never derived; the literal is the word, and renaming the
  word renames the literal;
- a predicate over a column (`` `blockedAt` set ``, `` `activatedAt` null ``): the word is its
  predicate (`runIsBlocked`, `workflowIsOn`) and the cell names the evidence;
- derived, never stored: no `stored` column; the table's intro names the derivation.

Then rename Task states' `derived from` header to `stored` so all four state tables read alike,
since its cells are already of the second form.

R2. **Pin the cell to the DDL.** Extend `pnpm spec check`: every backticked name in a `stored`
cell must be a column of a table in `initializeSchema` (or a literal in a `check (... in (...))`
constraint of one). Today the check only proves the name occurs somewhere in source. This is the
check that turns "stored literal is the word" from a rule in prose into a rule the build holds.

R3. **Fix the two Baton-owned divergences in place, now.**

- `Run.status` → `Run.state`, `RunStatus` → `RunState`, `Run_status_idx` → `Run_state_idx`, and
  the identifiers that follow (`recomputeStatus` → `recomputeState`). Shopify's `status` fields
  (`fulfillmentStatus`, `BulkOperationStatus`) stay, which leaves "status" meaning "Shopify's
  word" and "state" meaning "ours", a clean split the audit would then show.
- `ShopUsage.membersHighWater` → `seatsThisCycle`, beside `ordersThisCycle`. The seat row's
  meaning already says a cycle's seats are its highest member count, so the name says the concept
  and the JSDoc on the field keeps the high-water explanation.

R4. **Write the exceptions once, on the map.** A short list under the entry test: a foreign
vocabulary's table, field or literal (Shopify's, better-auth's) keeps its name and is read through
a predicate; a SQL reserved word takes the noun's symbol form (`ShopOrder`); a mechanism column
has no row and is named plainly. Then the DDL comments and the D1 row can `{@link}` it instead of
each explaining their own case.

R5. **Leave `activatedAt` deferred and `lineItem` alone.** `activatedAt` is a rename that has to
wait for the concept it actually names (the coverage date) to get its row in the reconcile spec;
renaming it now to match on/off would be wrong twice. `lineItem` is Shopify's word for Shopify's
thing, and the screen word "item" is a brevity choice already documented on the noun row; add a
half-sentence to that row saying the identifiers say `lineItem` so the next reader does not
"fix" it.

Not recommended: a separate storage glossary or a naming-map table. There is no mapping layer to
document; the struct is the row. A second table would be the divergence it describes.

## 5. Decisions (2026-09-30)

Each question was put with a recommendation; every recommendation was accepted.

Q1. Rename `Run.status` and `RunStatus` to `state` / `RunState` (R3)? **Accepted: yes.** It is
the one Baton-owned literal column whose name is not the word its table uses, the rename is
mechanical, and it costs nothing before launch. Against: "status" is a common word and the churn
touches the action tables' JSDoc and a few dozen sites.

Q2. Rename `membersHighWater` to `seatsThisCycle` (R3)? **Accepted: yes.** The seat row already
points at the column; the name should not need the row to be understood. Against: "high water"
says how it is computed, which `seatsThisCycle` does not; the field JSDoc keeps that.

Q3. Keep `lineItem` in identifiers and columns with "item" on screens (R5)? **Accepted: keep.**
It is Shopify's word for Shopify's thing, the same rule that keeps `FULFILLED`. Renaming would
touch 300+ sites and make the GraphQL and webhook types read differently from the rows they fill.

Q4. Add the DDL check on `stored` cells (R2)? **Accepted: yes.** Small parser work in
`scripts/lib/spec.ts`; it pins rule 4 the way the screen-column check pins the labels.

Q5. Unify the four state tables on a `stored` header with the three cell forms (R1), rather
than the current mix of `stored`, `derived from` and prose? **Accepted: yes.** One header, one
grammar, one place to read the rule.

Q6. Keep `activatedAt` deferred to the reconcile spec (R5)? **Accepted: yes.** It is the one
cell that fails rule 4, and the plan already records why the obvious fix is wrong.

## 6. Follow-ups

- **Time representation differs across the two stores.** D1 stores `createdAt` and the other
  timestamps as ISO 8601 text (better-auth's convention, which `Member` and `Team` followed); the
  object stores every time as epoch-ms integers, and the DDL comment on `initializeSchema` says one
  store should not mix. Not a vocabulary question and not blocking. Decide, in its own change,
  whether `Member` and `Team` move to epoch-ms so Baton's own D1 rows match the object and only
  better-auth's tables stay ISO, or whether the split stays and is stated on the D1 data-model
  table. Recorded here so it is not lost.

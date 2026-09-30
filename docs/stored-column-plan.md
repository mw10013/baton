# Plan: the `stored` column and storage names

Implements the decisions in `docs/stored-column-research.md` (section 5, all accepted
2026-09-30). Written for an implementing agent. Read `AGENTS.md` first; its rules apply
throughout and are not repeated here except where a step depends on one.

## Ground rules for this change

- No migrations. The object schema is edited in place in `initializeSchema`
  (`src/lib/ShopAgentSchema.ts`); after the schema changes, run `pnpm dev:reset` yourself. Do not
  add a migration file.
- Do not commit. Leave the work in the tree.
- Run `pnpm fmt` at the end and keep every file it touches.
- Never delete or move a file under `docs/`.
- Every rename moves the vocabulary row, the identifiers, the JSDoc, the tests and the log
  messages in the same change (`docs/vocabulary-runbook.md`, step 4).
- Record every departure from this plan, and every problem met, in section 9 at the bottom of
  this file. Do not silently adapt.

## Outcome

When done:

1. All four state tables in `src/lib/domain/ShopWork.ts` (Run states, Task states, Workflow
   states, and the intro sentences on Order positions and Order issues) say how a word is held in
   the store using one of three fixed cell forms, and the map in `src/lib/Domain.ts` states the
   three forms once.
2. `pnpm spec check` refuses a `stored` cell that names a column or literal the DDL does not have.
3. The run's stored state column and its literal type are `state` and `RunState`, not `status`
   and `RunStatus`. Shopify's `status` fields are untouched.
4. `ShopUsage.membersHighWater` is `ShopUsage.seatsThisCycle`.
5. The map lists the three exceptions to "the stored name is the word" in one place, and the
   DDL comments and the D1 table link to it instead of explaining their own case.
6. The `item` noun row says the identifiers say `lineItem` and why.

## Step 0: ground yourself

Read, in this order: the vocabulary paragraph and entry test on `src/lib/Domain.ts` (the block
starting "What a word must pass to get a row"); the four state tables at the top of
`src/lib/domain/ShopWork.ts`; the data-model JSDoc on `initializeSchema` in
`src/lib/ShopAgentSchema.ts`, including its "Vocabulary, so the same fact is always said the same
way" paragraph; `vocabularyTables`, `checkVocabulary` and `checkScreenColumns` in
`scripts/lib/spec.ts`; the wiring in `scripts/spec.ts` (the `check` command); and
`test/integration/spec.test.ts`.

Run `pnpm typecheck && pnpm lint && pnpm spec check && pnpm test` once before touching anything
and note the baseline test count in section 9.

## Step 1: one `stored` header and three cell forms (R1)

### 1.1 The rule, on the map

In `src/lib/Domain.ts`, in the entry-test list, replace the bullet

> A stored literal is the vocabulary word where the store is ours; Shopify's literals are stored
> as sent and read through a predicate.

with a bullet that keeps that sentence and adds the cell forms. Wording to use (adjust only to fit
the surrounding style):

> A stored literal is the vocabulary word where the store is ours; Shopify's literals are stored
> as sent and read through a predicate. A state table's `stored` column says how each word is
> held, in one of three forms, the data-model table's derivation words: a bare literal in
> backticks (`` `open` ``) is stored, never derived, and the literal is the word, so renaming the
> word renames the literal; a column with `set` or `null` (`` `blockedAt` set ``) means the word
> is derived, never stored, from that column, and lives in its predicate (`runIsBlocked`); a
> table whose words are derived from other rows has no `stored` column and its intro names the
> derivation. `pnpm spec check` holds every `stored` cell to a column or literal of
> `initializeSchema`.

Two things to preserve: the data-model table's own phrases ("stored, never derived", "derived,
never stored") are reused verbatim so the two specs share words; and `runIsBlocked` is a real
export (the check requires every backticked identifier in the vocabulary block to exist).

### 1.2 The tables

In `src/lib/domain/ShopWork.ts`:

- Task states: rename the header `derived from` to `stored`. Rewrite each cell into the second
  form. The current cells are "not current, `startedAt` null", "current, `startedAt` null",
  "`startedAt` set (current on an open run)", "`doneAt` set". `current` is not a column; it is the
  flag `currentTasks` computes. Keep the column names in the second form and move the `current`
  qualification into the intro sentence, which already explains `current`. Proposed cells:
  waiting → `` `startedAt` null, `doneAt` null; not current ``; ready → `` `startedAt` null,
`doneAt` null; current ``; started → `` `startedAt` set ``; done → `` `doneAt` set ``. The
  check in step 2 must accept a cell with more than one column and a trailing `; current` /
  `; not current` clause; see 2.2.
- Run states and Workflow states: cells already fit the forms. Leave them.
- Order positions and Order issues: no `stored` column; their intros already say "derived by X
  and never stored". Change "never stored" to "derived, never stored" in both intros so the phrase
  matches the data-model table's word.

Do not change any `screen` cell. `checkScreenColumns` compares them to the label constants.

## Step 2: the DDL check on `stored` cells (R2)

### 2.1 Parse the DDL

Add to `scripts/lib/spec.ts` a function `ddlColumns(source: string)` that reads the
`initializeSchema` template in `src/lib/ShopAgentSchema.ts` and returns, per table, its column
names and the literals of every `check (<col> in ('a', 'b'))` constraint. A regex over the SQL
text is enough: find each `create table if not exists <Name> (` and take the body up to the
matching `);`; within it, each line whose first token is an identifier followed by a type
(`text`, `integer`, `real`) is a column; a `check (\w+ in \(([^)]*)\))` gives literals. Skip
`--` comment lines. Table-level `check`, `unique` and index statements are not columns.

Write it as a pure function over the source string, like the other parsers in that file, so the
test can feed it a doctored string.

### 2.2 The check

Add `checkStoredCells(context: string, ddl: string): readonly string[]`. For every vocabulary
table in `context` (use `vocabularyTables`) that has a `stored` header, for every row:

- Split the cell on `;`. The last part may be `current` or `not current`; accept and drop it.
- Split the rest on `,`. Each part must match one of: `` `<literal>` `` (first form) or
  `` `<column>` set `` / `` `<column>` null `` (second form). Anything else is reported:
  "ShopWork.ts, <table intro>, <word>: stored cell `<cell>` is not a literal, `<column>` set or
  `<column>` null".
- A first-form literal must be a `check ... in (...)` literal of some table in `ddl`. Report:
  "<word>: stored literal `<literal>` is in no check constraint of initializeSchema".
- A second-form column must be a column of some table in `ddl`. Report: "<word>: stored column
  `<column>` is in no table of initializeSchema".

The table the column belongs to is not checked against the row's noun; the vocabulary table does
not name a table, and inferring it (Run states → `Run`) is a guess this change does not make.
Record in section 9 if you find a reason to.

### 2.3 Wire and test

In `scripts/spec.ts`, read `src/lib/ShopAgentSchema.ts` the way the data-model check already
does, and add `...ActionTable.checkStoredCells(contexts.ShopWork, schemaSource)` to the `check`
command's failure list, next to `checkScreenColumns`. Update the command's description string and
the `pnpm spec check` line in `AGENTS.md` so both say the stored cells are checked.

In `test/integration/spec.test.ts`, add a `describe("the vocabulary's stored column is a column or literal of initializeSchema")` with:

- "ShopWork.ts passes" against the real files;
- "a doctored cell form is reported" (a cell like `` `open` sometimes ``);
- "a literal in no check constraint is reported" (doctor `open` to `opened`);
- "a column in no table is reported" (doctor `blockedAt` to `blockedOn`);
- "a trailing current clause is accepted" (the Task states rows as written).

Follow the style of the existing `checkScreenColumns` tests, which read the real file and
doctor one cell with a string replace.

## Step 3: `status` → `state` on the run (R3)

Scope: Baton's run only. `fulfillmentStatus`, `BulkOperationStatus`, `OrdersSyncStatus` and every
HTTP or Shopify status stay. After this step, "status" in `src/lib/` means Shopify's or the
platform's word and "state" means Baton's.

### 3.1 Schema

In `initializeSchema`: the `Run` column `status` → `state`, in the column line, in the four
`check (...)` constraints that read it, in `Run_status_idx` → `Run_state_idx`, and in the two
partial indexes' `where status = ...` clauses. Update the DDL comment above the column
("Denormalized from the tasks ... `recomputeStatus`") to the new names.

In the data-model table on `initializeSchema`, the row "`status` is derived from the tasks and
stored, recomputed by every task write ..." → "`state` is ...". Its `pinned by` is "(none yet)";
leave that.

### 3.2 Domain

In `src/lib/domain/ShopWork.ts`: `RunStatus` → `RunState` (the `Schema.Literals` and its type);
the `Run` struct's field `status` → `state`; the parameter types of `runIsClosed`, `runIsOpen`,
`runIsDone` and every other `{ readonly status: RunStatus }`; every `{@link RunStatus}`; and every
JSDoc sentence that says "status" of a run ("the run's status", "run status"). Grep
`src scripts test e2e` for `RunStatus`, `\.status\b`, `status:` and `"status"` and judge each hit
by the scope rule above. The vocabulary's Run states table needs no cell change; its intro may
say "state".

### 3.3 Repositories, object, routes, tests

`src/lib/RunRepository.ts` (SQL strings: `where r.status = 'open'`, `set status = 'closed'`,
the insert column list, `recomputeStatus` → `recomputeState` and its JSDoc), `src/lib/OrderRepository.ts`,
`src/lib/agent/ShopWork.ts`, `src/lib/changeWarning.ts`, `src/lib/domain/Orders.ts`,
`src/routes/app.orders.$orderId.tsx`, `test/integration/*.test.ts`, `e2e/orders.spec.ts`,
`e2e/member-runs.member.spec.ts`, and `scripts/lib/spec.ts` (the `RunStatus` import, the `RUNS`
fixture map, the fixture struct's `status` field, and the fixture JSDoc table whose cells say
"status `open`"). No route carries a run state in a `?status=` search param; the one mention in
`src/routes/app.workflows.tsx` is the editor window's and stays.

### 3.4 The lint

`scripts/rules-lint.ts` refuses an inline `.status` or `.flag` comparison outside the domain
files with the regex `/\.(?:status|flag) (?:===|!==) "/u`. Add `state` to the alternation so a
`run.state === "open"` outside `src/lib/domain/` is still refused. Its test in
`test/integration/rules-lint.test.ts` gets one case for `.state`. Leave `status` in the
alternation: Shopify's fields still have status predicates in `Orders.ts`.

`scripts/vocab-allowlist.txt` has `status` as a function word. Leave it; after this step it is
still the word Shopify's fields use.

### 3.5 Reset

Run `pnpm dev:reset` after 3.1 so the local object matches the new DDL.

## Step 4: `membersHighWater` → `seatsThisCycle` (R3)

Field rename only. "High-water mark" stays a JSDoc term (the billing vocabulary intro lists it as
one) and the triggers table's `seat mark` column and the pinned test titles ("an add past the
high-water mark queues one seat event and raises the mark", ...) do not change; `pnpm spec check`
refuses a title no test carries, so leave both sides alone.

Sites: `src/lib/domain/Billing.ts` (the seat row's `symbol` cell, the `ShopUsage` struct field and
its JSDoc, `{@link ShopUsage.membersHighWater}` in the triggers paragraph and wherever else),
`src/lib/ShopAgentSchema.ts` (the `ShopUsage` column), `src/lib/OrderRepository.ts` (the row
schemas at the top, the `select ... membersHighWater from ShopUsage` and the `membersHighWater = 0`
update, and every use between), `src/lib/agent/Billing.ts`, `src/routes/admin.shop.$shop.tsx`
(`usage.membersHighWater`), `src/routes/app.index.tsx` (a JSDoc mention), and any test that reads
the field. Grep `membersHighWater` across `src test e2e scripts` until it returns nothing.

The seat row's meaning cell already says "a cycle's seats are its highest member count"; leave
it. On the field's JSDoc keep the sentence that it is the cycle's high-water mark, so the name
says the concept and the JSDoc says the computation.

Run `pnpm dev:reset` again (or once, after both schema steps).

## Step 5: the exceptions, once on the map (R4)

In `src/lib/Domain.ts`, directly after the entry-test list, add a short paragraph headed by a
sentence such as "Where a stored name is not the word, and why:" with three items:

- A foreign vocabulary's table, field or literal keeps its owner's name and is read through a
  predicate: Shopify's (`fulfillmentStatus`, `FULFILLED`, `eventHandle`) and better-auth's
  (`User`, `Session`, `Account`, `Verification`).
- A SQL reserved word takes the noun's symbol form: `ShopOrder`, because `Order` collides with
  `order by` in every hand-written query.
- A mechanism column (`idempotencyKey`, `attempts`, `webhookId`, `lastError`, `syncedAt`) names
  no concept, has no row, and is named plainly.

Then shorten the sources that explain their own case to a pointer: the `ShopOrder, not Order`
DDL comment in `initializeSchema` keeps one line and says "see the exceptions on the vocabulary in
`Domain.ts`"; the D1 table's `User` row keeps its rule sentence unchanged (it is a data-model
rule, and its pinned test must still match). Do not `{@link}` from a `--` SQL comment; write the
file name in words.

`checkVocabulary` will require every backticked identifier above to occur in `Domain.ts` or a
context file. `fulfillmentStatus`, `eventHandle` and `idempotencyKey` are fields in
`Orders.ts` and `Billing.ts`; `User`, `Session`, `Account`, `Verification`, `webhookId`,
`syncedAt` may not be. If the check reports one, either write it without backticks or add the
qualified form the check understands (`` `X` in Platform ``) only when the symbol really is
there. Record what you did in section 9.

## Step 6: the `item` row and `activatedAt` (R5)

In `src/lib/domain/Orders.ts`, the `item` noun row's `screen` cell is "item; never "line item"".
Add to the paragraph under the table one sentence: the identifiers and columns say `lineItem`
(`OrderLineItem`, `lineItemId`) because that is Shopify's `LineItem`, and "item" is the screen's
short form beside its order; do not rename either.

Do not touch `Workflow.activatedAt` or the Workflow states table's cells. It is deferred to the
reconcile spec (`docs/reconcile-research.md`, "coverage date").

## Step 7: verify

In order, all must pass:

```bash
pnpm typecheck
pnpm lint
pnpm spec check
pnpm graphql-codegen   # only if a #graphql literal changed; it should not have
pnpm test
pnpm fmt
git status --short
```

Then `pnpm dev:reset` and the two e2e specs that read run state:

```bash
npm run test:e2e -- e2e/orders.spec.ts e2e/member-runs.member.spec.ts
```

Final greps, each expected empty:

```bash
grep -rn "RunStatus\|recomputeStatus\|Run_status_idx\|membersHighWater" src scripts test e2e
grep -rn "derived from" src/lib/domain/ShopWork.ts   # the old header
```

And `pnpm vocab:audit` should no longer list `state` near the top once `RunState` has a row's
symbol; if it still lists `state` with a count above a handful, list the examples in section 9
rather than adding `state` to the allowlist. A domain word never goes on the allowlist.

## Step 8: report

Report the baseline and final test counts, the e2e result, the `git status --short` output, and
the contents of section 9.

## 9. Deviations and issues

The implementing agent records here, as it goes. One bullet per item, dated, with the step
number. Do not delete an entry; if one is resolved, add a second bullet saying how.

Format:

- `<date> step <n>: <what the plan said> → <what was done instead> because <reason>`
- `<date> step <n>: issue: <what was met>; <what was done or left>`

Entries:

- 2026-09-30 step 0: baseline `pnpm typecheck`, `pnpm lint`, `pnpm spec check` pass; `pnpm test` 30 files, 554 tests pass.
- 2026-09-30 step 1.2: the plan said both Order positions and Order issues intros say "never stored" → only Order positions did; the Order issues intro said "derived by {@link orderIssues}" alone. Both now read "derived, never stored, by {@link ...}".
- 2026-09-30 step 1.2: the Task states intro now also says `current` is "the flag, not a column", that a `stored` cell ending "; current" or "; not current" adds it, and that a started task on an open run is always current (the qualification the old `started` cell carried in parentheses).
- 2026-09-30 step 2.2: the bad-form message quotes the cell with double quotes (`stored cell "<cell>" is not ...`) instead of backticks, because the cell itself contains backticks. The table name in every message is the intro up to its first comma, colon or period ("Run states"), not the whole intro line.
- 2026-09-30 step 2.2: a cell with two or more `;` clauses where the last is not a current clause is reported as a bad form; only one trailing current clause is accepted.
- 2026-09-30 step 3.2: `RUN_STATUS_BADGE` and `runStatusBadge` in `src/routes/app.orders.$orderId.tsx` were renamed `RUN_STATE_BADGE` and `runStateBadge`, and `RunTerminalError`'s field `status` became `state`; neither was in the plan's list.
- 2026-09-30 step 3.3: the workflows index's `?status=` search param (`on` / `off`, a workflow's state, in `app.workflows.tsx` and `app.workflows.index.tsx`) was left as `status`; the plan scoped this step to the run. It is Baton's word for a workflow state under the name "status", so it breaks the rule "state means Baton's" that step 3 states. Left for a decision.
- 2026-09-30 step 3.3: issue: the workflows index filters on a workflow's state (`on` / `off`) through a search param named `status` (`WorkflowsSearch` in `src/routes/app.workflows.tsx`, read in `src/routes/app.workflows.index.tsx`, retained by `retainSearchParams(["status"])`, and covered by the e2e test "the workflows index keeps its status filter across the workflow page"). After step 3, "status" in code means Shopify's or the platform's word and "state" means Baton's, so this param breaks that rule. The param sits in the URL a merchant can bookmark or share, and the orders index's `OrdersSearch` is named alongside it in the JSDoc, so renaming it touches saved links and the two indexes' search-param convention. Open: rename to `state`, keep `status` as a URL word the rule exempts (and say so on the map), or choose another name. Left unchanged; to be taken up separately.
- 2026-09-30 step 3.4: the plan said to add a `.state` case to the pattern's test in `test/integration/rules-lint.test.ts` → the pattern had no test and lived unexported in `scripts/rules-lint.ts`. It moved to `scripts/lib/rules-lint.ts` as the exported `INLINE_COMPARISONS`, with a JSDoc, and the test got a describe with two cases (the `.state` refusal, and status, flag, admin role and a predicate). The `Domain.ts` map bullet naming the lint now says "`.status`, `.state`, `.flag`".
- 2026-09-30 step 5: `checkVocabulary` reported `Session`, `Account`, `Verification` and `webhookId`. The better-auth tables and the mechanism columns are written without backticks, as whole lists, so each list reads the same way; the Shopify names (`fulfillmentStatus`, `FULFILLED`, `eventHandle`) and `ShopOrder` / `Order` keep theirs.
- 2026-09-30 step 6: `lineItemId` in the new sentence failed `checkVocabulary` (it is a field in ShopWork, not Orders, and the `` `X` in Context `` form cannot name ShopWork: its regex takes one capital followed by lowercase letters). Written as "the run's lineItemId" without backticks.
- 2026-09-30 step 7: `grep -rn "derived from" src/lib/domain/ShopWork.ts` is not empty: three prose sentences (on `OrderPosition`, on a workflows-index field, and on `RunState`) use the phrase in ordinary text. The old header is gone.
- 2026-09-30 step 7: `pnpm vocab:audit` lists `state` at 22 (20 before the change), second after `agent`. The rise is `RunState`. No vocabulary row names `RunState` as its symbol: the Run states table has no symbol column and the `run` noun row's symbol is `Run`. The exported identifiers with the stem: `ConnectionState`, `LineItemState`, `lineItemState`, `MemberConnectionState`, `MerchantConnectionState`, `OrderState`, `RunState`, `SubscriptionState`, `SyncState`, `TaskState`, `taskStateOf`. Not added to the allowlist.
- 2026-09-30 step 7: final `pnpm test` 30 files, 561 tests pass (554 + 5 stored-cell tests + 2 inline-comparison tests). `pnpm dev:reset` ran; `npm run test:e2e -- e2e/orders.spec.ts e2e/member-runs.member.spec.ts`: 43 passed.
- 2026-09-30 follow-up: the `?status=` issue above is resolved. The key is `view`, not `state`: the On, Off and All buttons are the vocabulary's view row (a preset of a list, one at a time, chosen by its button), which the orders index already keys as `?view=`; the workflows index's views are the new `Domain.WorkflowsIndexView` (`on`, `off`; All is the absent default, as Open is on `OrdersIndexView`), named on the `view` row. `WorkflowsSearch`, `retainSearchParams`, the index's filter code (`statusBadges` → `stateBadges`, `statusButton` → `viewButton`) and the e2e test ("the workflows index keeps its view across the workflow page") moved with it. An old `?status=on` link is an unknown key and reads as All.
- 2026-09-30 follow-up: the rule "status is Shopify's and the platform's word, state is Baton's; a Baton field, literal or URL key is never named `status`" is now a sentence of the entry test on the map in `Domain.ts`; the `INLINE_COMPARISONS` JSDoc points to it. `OrdersSyncResult`, which step 3 had left with a `status` field (`started` / `in_flight` / `refused`), is now a tagged union (`Started` / `InFlight` / `Refused`) like every other `Result` on the Shape families table; it was briefly renamed to an invented `outcome` field, which the vocabulary has no word for, before the family's rule was applied.
- 2026-09-30 follow-up: `checkVocabulary`'s `` `X` in Context `` form now takes a context with two capitals (`ShopWork`); the `item` row's sentence in `Orders.ts` says `` `lineItemId` in ShopWork `` in backticks, and `spec.test.ts` has a case for the form.

# Data-model spec review: implementation plan

This plan carries out the fourteen decisions and the recommendations in
`docs/data-model-spec-review-research.md`. Read that doc first: section 1 is the unpinned rows,
section 2 the contradictions, section 3 the three product rules and how each was decided,
sections 4 and 5 the convention slips and the missing rows, section 6 the three product choices
the preamble gains, and the Questions list the way each question went. This plan says what to
change, in what order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md`, `docs/vocabulary-runbook.md` and the preambles on `initializeSchema`
  (`src/lib/ShopAgentSchema.ts`) and `D1_TABLES` (`src/lib/D1Schema.ts`). The rules that matter
  most here:
  - The two data-model tables are the spec for both stores. One row per structural rule, in the
    preamble's vocabulary (cardinality, reference, lifetime, history, derivation, consistency
    words), with `holds by` and `pinned by`. `pnpm spec check` parses both, holds `about` to the
    nouns list in `scripts/lib/spec.ts` (`DATA_MODEL_NOUNS`) or a backticked table name, and
    refuses a `pinned by` title no test carries.
  - A structural change starts at the row, then the DDL or migration and the write paths, then
    the pinned test. A failing pinned test means the row and the code disagree; fix one of them,
    never delete the test.
  - A rule is stated once. A JSDoc never cites a file under `docs/`; it carries its reasoning
    inline. Behavioural rules stay on the `Domain` symbol.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- The project is prototyping: there are no migrations for the object. A DDL change is made in
  line in `initializeSchema`, and you run `pnpm dev:reset` yourself afterwards. D1 changes go in
  `migrations/0001_init.sql` in line for the same reason, and `pnpm d1:reset` recreates it.
- After each phase run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`),
  `pnpm test`, `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go: what the plan said, what you found,
  the two options you saw, and the one you took. A row whose pinned test fails on the first run
  is the thing this section is for: say which side you changed and why.
- Phases 1 and 3 change no behaviour. Phase 2 changes the DDL and, in two places, may change
  behaviour; each is named, and the research says which way it goes. Phase 4 writes tests. Do
  not fold phase 2 into phase 1, so a behaviour change is never hidden inside a wording change.

## The decisions, in the order the phases take them

| decision or rec. | what                                                                                         | phase   |
| ---------------- | -------------------------------------------------------------------------------------------- | ------- |
| rec. 24, 10, 11  | the preamble: three product choices; columns in rules; durations name their symbol           | 1       |
| rec. 2, 1        | the preamble: which test kind pins which `holds by`; "(none yet)" is temporary               | 1, 3    |
| 1, rec. 3        | the counted mark: first run only; the seed clause leaves the row                             | 1, 2    |
| 4                | retention stands; the row names its symbol and says "open runs included"                     | 1, 4    |
| 2, rec. 4        | a run's quantity follows its item while open; `quantityChangedFrom` is the creation quantity | 1, 4    |
| 3, 13, rec. 5    | a run's lifetime; a replaced run leaves no history; one run per item, never per unit         | 1, 4    |
| 9, rec. 19       | a sync replaces items whole; an item Shopify no longer lists is deleted                      | 1, 4    |
| rec. 20, 10      | item tags snapshot at sync; the tag compares trimmed and case-insensitively                  | 1, 4    |
| rec. 9, 17       | `about` discipline; the steps row gains "numbered from 1 with no gap" and the draft clause   | 1, 4    |
| rec. 12          | the workflow `state` row is struck; "turning off deletes nothing" takes its place            | 1, 4    |
| rec. 15          | the run task consistency pairs, with DDL checks                                              | 1, 2, 4 |
| 8, rec. 18       | a run task's team name never follows a rename                                                | 1, 4    |
| 7, rec. 16       | three `ShopUsage` rows: orders count, seat mark, provisional cycle                           | 1, 4    |
| rec. 21          | a usage event is kept until accepted or its cycle ends                                       | 1       |
| 5, rec. 7        | the D1 uninstall row says what the code does; the paragraph under the table goes             | 1, 4    |
| 6, rec. 8        | a renamed domain is a new shop                                                               | 1       |
| rec. 13, 14      | the merchant row; the member and user row                                                    | 1, 4    |
| 12, rec. 23      | who repairs a half-done team delete                                                          | 1, 2, 4 |
| 11, rec. 22      | a member's access is the row: recorded as a choice in the row                                | 1       |
| 14, rec. 1, 2    | `pnpm spec check` refuses "(none yet)" in the data-model tables once phase 4 is done         | 3       |

## Phase 1: the spec text

Goal: both tables say everything the research decided, in the preamble's words, and every row
that is a rule carries the title its phase 4 test will have. No DDL and no code path changes.
`pnpm spec check` will refuse a title no test carries, so in this phase every new or changed
title is written as "(none yet)" and phase 4 replaces it; the table in 4.1 maps each row to its
title so the two phases agree.

### 1.1 The preamble on `initializeSchema`

Add, before the vocabulary paragraph, a paragraph that states the three product choices
(research section 6), in this order and about this length:

- A run is for an item on an order, never for stock, and for the whole item: five chairs on one
  line are one run with quantity 5, and the unique item on `Run` is that choice, not an index.
- Every history fact is a snapshot on the row it belongs to, and there is no history table: what
  is replaced or deleted is gone. "No history" on a workflow, a member and a run means this.
- Identity lives in D1 and work lives here; work points into D1 by id and D1 never points back.

Amend the vocabulary paragraph in two places:

- After the derivation words: "a rule names a column when the column is a vocabulary `stored`
  cell or the subject of a consistency word, and never names an index."
- Add: "a duration names its `ShopLimits` symbol and the window the number must exceed, never
  the number."

Add, after the "A structural change starts at the row" paragraph, the test convention: a
`schema` row is pinned by a test that writes a violating row straight to the store and expects
the refusal; an `app` row by a test through the write path; a `schema+app` row by one test with
both halves, or by two titles joined with `; `. "(none yet)" is a row with no test yet, and
`pnpm spec check` refuses it once every row is pinned (phase 3).

### 1.2 The object table's rows

Rewrite the table so its rows are the following, in this order. A row marked "existing" keeps
its `pinned by`; a row marked "new title" takes "(none yet)" in this phase and the title in 4.1.
`about` follows the vocabulary: a definition task row says `workflow`, a draft row says `draft`,
the layout row says `step`, and `task` means a run task.

| about             | rule                                                                                                                                                                                                                                                              | holds by   | pinned by                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------- |
| order             | an order is Shopify's record, mirrored; which orders are stored is the rule on `syncOrder`; each sync overwrites the order whole except `countedAt`                                                                                                               | app        | existing                     |
| order             | an order's counted mark is set at most once, when its first run is created, and survives every sync; only deleting the order removes it                                                                                                                           | app        | existing                     |
| order             | an order whose `processedAt` is past `orderRetentionDays` is deleted, open runs included; its items and its runs go with it, and it is never stored again                                                                                                         | schema+app | existing; new title          |
| item              | an item has exactly one order and goes with it                                                                                                                                                                                                                    | schema     | existing                     |
| item              | a sync replaces the order's items whole; an item Shopify no longer lists is deleted, and reconcile closes its open run as `item_removed`                                                                                                                          | app        | new title                    |
| item              | an item's product tags snapshot the product at sync; the next sync overwrites them; a run created from them is not revisited                                                                                                                                      | app        | new title                    |
| item              | an item has at most one run, in every state, and a run is for the whole item, never per unit; a person replaces an open or closed run, and a done run is a record that is never replaced                                                                          | schema+app | existing; new title          |
| workflow          | a workflow is identified by its tag and by its name; no two workflows share either; the name is compared exactly, the tag trimmed and case-insensitively, as Shopify's admin treats tags                                                                          | schema+app | existing; new title          |
| step              | a workflow has zero or more steps, numbered from 1 with no gap; a step has one or more tasks, done in parallel; a task is in exactly one step; the draft obeys the same rule at every write                                                                       | app        | new title                    |
| draft             | a workflow has at most one draft; the draft holds tasks only                                                                                                                                                                                                      | schema     | existing                     |
| draft             | Apply replaces the workflow's tasks with the draft's, whole, in one transaction; a run starting between two edits sees one definition; Apply of a draft with no tasks leaves a workflow with no tasks                                                             | app        | new title                    |
| workflow          | no history: a delete removes the workflow, its tasks and its draft, and nothing else                                                                                                                                                                              | schema+app | existing                     |
| workflow          | turning a workflow off deletes nothing and closes nothing; its open runs carry on                                                                                                                                                                                 | app        | new title                    |
| workflow          | a definition task's team points to a D1 row; dangling reads as null, which means unassigned; a team delete nulls it on every definition task, draft task and run task                                                                                             | app        | existing                     |
| run               | a run snapshots its workflow's id and name, its order's id, name and processed date, and its item's id, title, variant, SKU and properties; it references none of them and survives a workflow delete                                                             | schema+app | existing                     |
| run               | an open run's quantity follows its item's current quantity on every reconcile; `quantityChangedFrom` holds the quantity the run was created with and is null when they agree; a done or closed run's quantity is frozen                                           | app        | new title                    |
| run               | a run is deleted by its order's retention and by a person replacing it, and by nothing else; a replaced run leaves no history                                                                                                                                     | app        | new title                    |
| run               | a run's tasks go with it; only deleting the run deletes tasks                                                                                                                                                                                                     | schema     | existing                     |
| run               | a run's tasks and steps are a snapshot of the definition's at creation                                                                                                                                                                                            | app        | existing                     |
| task              | a run task snapshots its team's name at creation; a rename never reaches it; history shows the name and never resolves the team                                                                                                                                   | app        | existing                     |
| run               | `state` is derived from the tasks and stored, recomputed by every task write in the same transaction; `closed` is the exception, written never derived                                                                                                            | app        | new title                    |
| run               | `closedAt` and `closedReason` are set together, once, and only on a closed run; nothing leaves closed                                                                                                                                                             | schema+app | existing                     |
| run               | only an open run can be blocked; a run that is done or closed carries no block                                                                                                                                                                                    | schema+app | existing                     |
| task              | `startedAt` and `startedByRole` are set together and cleared together by Put back; `doneAt` and `doneByRole` are set together and cleared together by Reopen; a `member` role has its email beside it and a `merchant` role has null; done does not imply started | schema+app | new title                    |
| task              | reopen is latest only: `reopenedAt`, `reopenedByRole` and `reopenedByEmail` are set together and a later Done clears them                                                                                                                                         | schema+app | new title                    |
| `SyncState`       | exactly one row                                                                                                                                                                                                                                                   | schema     | existing                     |
| `ShopUsage`       | exactly one row                                                                                                                                                                                                                                                   | schema     | existing                     |
| `ShopUsage`       | `ordersThisCycle` is derived from the counted orders in the cycle and stored; it is recounted when the cycle moves                                                                                                                                                | app        | a triggers-table title (4.1) |
| `ShopUsage`       | `seatsThisCycle` is stored, never derived: the cycle's highest member count; a new cycle resets it to the member count                                                                                                                                            | app        | a triggers-table title (4.1) |
| `ShopUsage`       | a provisional cycle has a start and no end; a billing cycle has both, set together                                                                                                                                                                                | app        | a triggers-table title (4.1) |
| `WebhookDelivery` | one row per Shopify delivery id, kept past `webhookDeliveryRetentionDays`, which exceeds Shopify's retry window                                                                                                                                                   | schema+app | new title                    |
| `UsageEvent`      | one row per idempotency key, kept until Shopify accepts it or its cycle ends, whichever is first; a refused event is retried on every flush until then                                                                                                            | schema+app | existing                     |
| `UsageEvent`      | an expired usage event is kept past `expiredUsageEventRetentionDays`, then deleted                                                                                                                                                                                | app        | existing                     |

Rows that leave: "`state` is stored, never derived: `on` or `off`" (its fact is the workflow
states table's `stored` column) and "who did what is a snapshot (`*ByEmail`, `teamName`)" (its
two facts are now the team-name row and the consistency-pairs row).

Two existing rows change wording without changing their test: the first order row gains the
pointer to `syncOrder`, and the definition-task row moves from `about` `task` to `workflow` and
names the three task tables the delete nulls.

The first run row is the snapshot row split by Recommendation 4: it now lists what is
snapshotted and drops "every edit to the three", since the quantity row says what an item edit
does.

### 1.3 The column comments in `initializeSchema`

- `ShopOrder.countedAt`: replace "and always null on a seeded one" with "the seed pre-marks the
  orders it writes so a seeded store does not fill the meter; that is the seed's rule, on
  `OrderRepository`'s seed function". Today: the seed writes `countedAt = 0`, so the row's old
  clause was right and the comment was wrong; the product rule drops the seed either way.
- `Run.quantityChangedFrom`: a one-line comment that it is the creation quantity, or null when the
  run's quantity equals it, with `{@link}` to the rule on `Domain.Run`. Check the JSDoc on
  `Run` in `src/lib/domain/ShopWork.ts` says the same; today the resize keeps the first value
  (`quantityChangedFrom ?? quantity`), which is the creation quantity, and a change back clears it.
- `WebhookDelivery` and `UsageEvent` comments: name the `ShopLimits` symbol, not the number, where
  they say 7 or 60.

### 1.4 The D1 table and its preamble

Rewrite these rows; every other D1 row stays as it is.

| about  | rule                                                                                                                                                                                                 | holds by   | pinned by           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------- |
| shop   | a shop is identified by its domain and has exactly one object; the object id is set once and never rewritten; a renamed domain is a new shop, and the old row and object are removed by hand         | schema+app | existing            |
| shop   | uninstall deletes the shop row, its members and teams go with it, and destroys the object whole; a reinstall is a new shop with nothing; `shop/redact` does nothing more                             | schema+app | new title           |
| shop   | the merchant is the admin session, not a member; a member row never stands for the merchant, and run history records a merchant act with the role and no email                                       | app        | new title           |
| member | a member's access is the row: no role, no state; a merchant pauses nobody, only removes them; sign-in identity is the email                                                                          | app        | existing            |
| member | a member is matched to a signed-in user by email at sign-in and at no other time; nothing points from a member to a user or back; a member's email never changes, so a change is a delete and an add | app        | new title           |
| team   | a team delete goes to D1 first, then nulls every object pointer; the next team delete for the shop and the orphan page's sweep null pointers to any team that is gone                                | app        | existing; new title |

Strike the paragraph under the table that begins "The uninstall row records the current
behaviour" and the sentence about `findOrphanShopAgentIds`. Replace it with one sentence: the
uninstall webhook is the one teardown point, and a destroy that fails is retried by Shopify's
webhook retries and past that cleaned up by hand from the orphan page.

Keep the "a shop has exactly one object" and "a team never crosses shops" paragraphs.

### 1.5 Done when

`pnpm spec check` passes with the new "(none yet)" rows counted (it accepts them today); every
row's `about` is a noun from `DATA_MODEL_NOUNS` or a backticked table; `pnpm spec print` shows
the data-model rows as written here; every existing test passes unchanged.

## Phase 2: the DDL and the two write paths

Goal: the store refuses what the new `schema` and `schema+app` rows say it refuses, and the two
write paths the new rows name do what the rows say. Each change here is a behaviour change and
is listed; nothing else in this phase is.

### 2.1 Run task checks (consistency-pairs row)

In `initializeSchema`, on `RunTask`, add checks beside the existing reopen check:

```sql
check ((startedAt is null) = (startedByRole is null)),
check ((doneAt is null) = (doneByRole is null)),
check ((startedByRole = 'member') = (startedByEmail is not null)),
check ((doneByRole = 'member') = (doneByEmail is not null)),
check ((reopenedByRole = 'member') = (reopenedByEmail is not null))
```

SQLite evaluates a check with a null operand as true, so the two `= 'member'` checks hold only
when the role is set; confirm that with a direct insert in the phase 4 test rather than trusting
this sentence. Then read every write to `RunTask` in `src/lib/RunRepository.ts` (start, done, put
back, reopen, the merchant's Done on a ready task, the create-run copy) and make each one set or
clear its pair in one statement. If a write path today sets a time without its role, or a role
without its email, that is a deviation to record: the row says the pair moves together, so the
write path changes, not the row.

Run `pnpm dev:reset` after the DDL change.

### 2.2 Items a sync no longer lists (item sync row)

Today: `OrderRepository`'s order write deletes the order's items and reinserts the ones Shopify
sent, so the "replaces whole" half holds. Verify the second half: when an item row is gone and
its run is open, reconcile must close the run as `item_removed`. Read `reconcileItem`'s outcomes
table in `src/lib/domain/ShopWork.ts` and `RunRepository.reconcileOrder`. If a run whose item row
is missing is left open today, add the close to reconcile (the outcomes table gains or amends a
row, since that table is the spec for reconcile; a behaviour change there starts at the cell), and
record it under deviations as "the row said; the code did not". If it is already closed, say so
in the deviations section with the row of the outcomes table that does it.

### 2.3 The half-done team delete (D1 team row)

Today: `Repository.deleteTeam` deletes the D1 row and `ShopAgent.deleteTeam` nulls the object's
pointers. Verify who nulls a pointer when the second half failed: read `deleteTeam` in
`src/lib/ShopAgent.ts` and the orphan page's route (`admin.orphan-shop-agent-objects`). The row
says the next team delete for the shop and the orphan page's sweep both do it. If neither does
today, make the object's `deleteTeam` null every pointer whose team is absent from the shop's D1
teams (one query with the shop's live team ids, run before nulling the deleted one), and leave
the orphan page alone if adding a sweep there is more than a call to the same object method;
record whichever you did. This is the one place the research's recommendation names two actors
and the code may have one; the row is amended to name only what exists, and that amendment is a
deviation to record.

### 2.4 Done when

`pnpm typecheck`, `pnpm lint`, `pnpm test` pass; the DDL carries the five checks; the deviations
section says what 2.2 and 2.3 found.

## Phase 3: `pnpm spec check` and "(none yet)"

Goal: the checker reports how many data-model rows are unpinned and, once phase 4 lands, refuses
any.

In `scripts/spec.ts`, where the data-model tables are checked, count rows whose `pinned by` is
`NONE_YET` across both tables and print the count in `spec print`. Add a ceiling constant,
`DATA_MODEL_NONE_YET_MAX`, set to the count after phase 1, with a comment that it only goes down
and reaches zero in phase 4. `spec check` fails when the count exceeds it. In phase 4's last step
set it to zero. Do not refuse "(none yet)" in the other tables (reconcile, sync, triggers): their
rules are theirs.

Done when `pnpm spec check` fails if a new unpinned row is added above the ceiling, and the
ceiling is the phase 1 count.

## Phase 4: the tests

Goal: every row has a test whose title is the row, in the file that owns the store, written to
the convention in 1.1: `schema` rows by a direct violating write, `app` rows through the write
path, `schema+app` by both.

### 4.1 The titles

Replace each "(none yet)" from phase 1 with the title below and write the test. Object rows go in
`test/integration/data-model.test.ts` unless a repository test file already holds the behaviour
(`run-repository.test.ts`, `order-repository.test.ts`, `shop-agent-sync-order.test.ts`), in which
case add the test there and name that file in the deviations section. D1 rows go in
`test/integration/d1-data-model.test.ts` or `repository.test.ts`. The three `ShopUsage` rows
reuse triggers-table titles, which already exist as tests; read the triggers table on `ShopUsage`
in `src/lib/domain/Billing.ts` and pick the row that pins the fact, and if none does, write one
and add it to the triggers table too, since a metering change starts at that row.

| row                      | title                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| order, retention         | the retention sweep deletes an order with an open run                                                                                  |
| item, sync               | a sync replaces the order's items whole, and an item Shopify no longer lists is deleted and its open run closes as item_removed        |
| item, tags               | an item's product tags are rewritten by the next sync and a run created from the old tags is not revisited                             |
| item, one run            | a done run is never replaced; an open or closed one is                                                                                 |
| workflow, tag            | a workflow's tag matches an item's tag regardless of case and surrounding space                                                        |
| step                     | a workflow's steps are numbered from 1 with no gap, every step has a task, and the draft obeys the same rule                           |
| draft, Apply             | Apply replaces the workflow's tasks whole in one transaction, and an empty draft leaves a workflow with no tasks                       |
| workflow, off            | turning a workflow off leaves its open runs open and deletes nothing                                                                   |
| run, quantity            | an open run's quantity follows its item and quantityChangedFrom is the creation quantity; a done or closed run's quantity is frozen    |
| run, lifetime            | a run is deleted only by its order's retention or by a person replacing it, and a replaced run leaves no history                       |
| run, state               | a run's state is recomputed by every task write in the same transaction, and closed is written, never derived                          |
| task, pairs              | a run task's started, done and reopened times move with their roles, a member's email beside the role, and done does not imply started |
| task, reopen             | reopen is latest only: a later Done clears reopenedAt, reopenedByRole and reopenedByEmail                                              |
| `ShopUsage`, orders      | the triggers-table row that recounts (today "rolls the cycle forward on the first order past its end")                                 |
| `ShopUsage`, seats       | "a new cycle resets the mark to the member count and queues it as the cycle's first seat event"                                        |
| `ShopUsage`, provisional | "opens a provisional cycle before a billing cycle is known"                                                                            |
| `WebhookDelivery`        | a webhook delivery is one row per delivery id and the sweep deletes it only past webhookDeliveryRetentionDays                          |
| shop, uninstall          | uninstall deletes the shop row, its members and teams, and destroys the object                                                         |
| shop, merchant           | a merchant act is recorded on the task with the role and no email, and no member row stands for the merchant                           |
| member, user             | a member is matched to a user by email at sign-in and nothing points between them                                                      |
| team, repair             | the next team delete nulls pointers to a team that is already gone                                                                     |

A title that already exists under another name (the merchant row and the Apply row are likely
candidates in `run-actions.test.ts` and `run-repository.test.ts`) is reused: put the existing
title in the row instead of writing a second test, and say so in the deviations section.

### 4.2 What each test must do

- A `schema` or `schema+app` row's direct-write half inserts or updates the violating row with
  raw SQL against the test store and asserts the constraint error, the way the existing "the
  unique index itself refuses a second row for an item" test does.
- The retention test creates an order past the cutoff with an open run and asserts the sweep
  deletes the order, the item, the run and its tasks.
- The quantity test edits the item twice and asserts `quantityChangedFrom` is the creation
  quantity after both, then edits back and asserts null, then closes the run and edits again and
  asserts nothing moved.
- The lifetime test replaces a closed run and asserts the old run id and its tasks are gone, then
  attempts a replace on a done run and asserts the refusal.
- The uninstall test runs the webhook handler against a shop with a row and an object holding a
  row, and asserts no shop row, no member, no team and an object with no stored data.
- The team-repair test deletes the D1 row directly, leaves the pointers, runs the next team
  delete and asserts the dangling pointers are null.

### 4.3 Done when

No data-model row says "(none yet)"; `DATA_MODEL_NONE_YET_MAX` is zero; `pnpm spec check` passes;
every test passes; `pnpm fmt` has run and its files are kept.

## Deviations and issues

Record here as you go. One entry per deviation, in this form:

- **Where:** phase and step.
- **The plan said:** the sentence.
- **Found:** what the code or the test actually did.
- **Options:** the two you saw.
- **Took:** the one you took, and what changed in the row, the DDL or the code because of it.

Issues that are not deviations (a question the plan did not answer, a row that turned out to be
two rules, a test that could not be written as described) go here too, marked **Issue**.

### Recorded during implementation (2026-10-02)

- **Where:** phase 1.2, the run quantity row; phase 1.3, `Run.quantityChangedFrom`.
  **The plan said:** "`quantityChangedFrom` holds the quantity the run was created with and is null
  when they agree", and "today the resize keeps the first value, which is the creation quantity".
  **Found:** it is not the creation quantity. The badge rule on `Domain.Run` sets it only on the
  first resize after a task started or was done, to the quantity before that resize; a resize on an
  unstarted run never sets it and clears it; a Done clears it; a close clears it. A run created at
  3, resized to 2 while unstarted, then to 1 after a Start, reads "2 → 1", not "3 → 1".
  **Options:** change the badge rule and the reconcile effects table to read against the creation
  quantity, or keep the badge rule and have the row point at it. **Took:** kept the code. The badge
  is a behavioural rule and already lives on `Domain.Run`, pinned by the resize row of the effects
  table; the data-model row states the structure (an open run's quantity follows the item, a done
  or closed run's is frozen) and names the badge rule rather than restating it. Question 2's intent,
  that the badge reads against what the maker worked to, is what the badge rule does. If the
  creation quantity is wanted literally, it is a change to the badge rule, starting at the effects
  table's resize rows.
- **Where:** phase 1.2, the consistency-pairs row; phase 2.1.
  **The plan said:** "done does not imply started".
  **Found:** `markTaskDone` backfills the started columns with the Done's actor when there was no
  Start, and the taskActions bullets say so ("A Done without a Start records the actor as the
  starter too"). So done implies started.
  **Options:** stop the backfill, or state the implication. **Took:** the row says "done implies
  started, since a Done without a Start records its actor as the starter", and the DDL gains a
  sixth check, `doneAt is null or startedAt is not null`. The email checks use `is 'member'`
  rather than `= 'member'`, so an email with no role is refused too (with `=`, a null role makes
  the check null, which passes).
- **Where:** phase 1.2, the Apply row.
  **The plan said:** "Apply of a draft with no tasks leaves a workflow with no tasks".
  **Found:** Apply refuses a draft with no tasks and the workflow keeps its tasks (pinned by
  "apply refuses an empty draft and an unassigned task, on and off alike; ...").
  **Options:** allow the empty Apply, or state the refusal. **Took:** the row states the refusal;
  no behaviour change.
- **Where:** phase 1.2, the team-name row.
  **Found:** Assign a team rewrites a run task's `teamName` with the new team's name.
  **Took:** the row says the name is snapshotted "when its team is set, at creation or by assign a
  team; a rename never reaches it".
- **Where:** phase 2.2. **Found:** already closed. The Orphan clause of "What a pass guarantees" on
  `reconcileItem` reads a stored run whose item is not stored as an item at zero units, which the
  outcomes row `open | any | 0 | open | any | close item_removed` closes, unless the order's items
  were truncated at sync. **Took:** no code change; the item-sync row gains the truncation clause
  and is pinned by the three existing tests that hold it.
- **Where:** phase 2.3. **Found:** a retry of the same delete repaired it; the next delete of another
  team did not, and the orphan page sweeps objects, not team pointers. **Options:** add the repair to
  the object's `deleteTeam`, or add a sweep to the orphan page as well. **Took:** `deleteTeam` now
  reads the ids the object points to (`WorkflowRepository.teamIdsInUse`), then the shop's teams, and
  nulls every id not among them along with the deleted one; the in-use read comes first so a team
  created between the two reads is never a candidate. The orphan page is unchanged: a sweep there
  would call every live shop's object, more than a call to the same method. The D1 row names only
  the next team delete.
- **Where:** phase 3. **Found:** a `pinned by` cell joins titles with `; `, and several existing
  titles contain `; ` themselves, so splitting on it breaks them. **Took:** `checkPinned` holds a
  cell when its `; `-separated parts group, in order, into titles a test carries, for every table.
  The ceiling constant `DATA_MODEL_NONE_YET_MAX` went in at zero, since phase 4 landed in the same
  change; the phase 1 count of new titles was 13.
- **Where:** phase 4.1. Titles reused instead of written:
  - retention: "the retention sweep deletes an order with its open runs and records no close"
    (`order-repository.test.ts`);
  - item sync: "replaces the line-item set on every accepted write" (`order-repository.test.ts`),
    "a line removed from the order closes its open run as item_removed" and "on a truncated order a
    run whose item is not stored is left alone" (`run-repository.test.ts`);
  - one run per item: "setRun over an open run deletes it ...", "a closed run holds its item and a
    manual attach replaces it", "setRun over a done run is refused, naming the done workflow"
    (`run-repository.test.ts`);
  - step: "step is dense from 1 ..." (`workflow-layout.test.ts`) and "add/move/remove keep positions
    dense and unique; edges are no-ops" (`workflow-repository.test.ts`);
  - Apply: three titles in `workflow-repository.test.ts`;
  - `WebhookDelivery`: the two existing `order-repository.test.ts` titles for the write path, and a
    new "a webhook delivery is one row per delivery id" for the direct-write half;
  - the three `ShopUsage` rows: the triggers-table titles the plan named.
    New tests: nine in `data-model.test.ts` (tag case, turning off, quantity, lifetime, state, pairs,
    reopen, merchant act, webhook delivery), one in `shop-agent-sync-order.test.ts` (item tags), one
    in `shopify-webhook.test.ts` (uninstall), one in `d1-data-model.test.ts` (member and user), one in
    `shop-agent-workflows.test.ts` (team repair), and two in `spec.test.ts` for the checker.
- **Issue:** the uninstall test cannot read an object's storage without addressing it, which starts
  a fresh object. It writes an order into the object, runs the webhook, and asserts the order is
  gone once the object is addressed again; with the destroy removed from the handler the test fails.
  It is `it.live`, because the first address after the destroy can reach the aborted instance and
  is retried on a real clock.
- **Issue:** two `order-repository.test.ts` fixtures wrote `doneAt` with no role and no start, which
  the new checks refuse; the fixtures now write `doneByRole`, `startedAt` and `startedByRole` with it.

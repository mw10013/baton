# Data-model spec on the schema: implementation plan

Implementation plan for `docs/data-model-spec-research.md`. Every question there is decided (its Decisions section). Read the research first: the reasoning in "What the first draft got wrong" and "Spec-first, and adjudication" must end up inline in JSDoc, because the research doc will be deleted.

Written 2026-09-26 for an LLM agent. Work on `main`, no branches. Do not commit unless told. After each step: `pnpm typecheck && pnpm lint && pnpm test`. At the end: `pnpm fmt`, keep every file it touches. Record anything that did not go as written in section 12 of this file.

## 1. What this delivers

1. **The schema in its own file.** `src/lib/ShopAgentSchema.ts` holds the Durable Object DDL and `runShopAgentMigrations`. `ShopAgent.ts` imports it.
2. **A data-model table as the JSDoc on the schema.** One row per structural rule: `| about | rule | holds by | pinned by |`. It replaces the 130-line prose block. The rule column is the spec; the schema conforms to it.
3. **The schema holds what it can.** Rules the database can refuse become `check` constraints or keys in the DDL, in line, no migration.
4. **The table is checked.** `pnpm action-table check` parses it, refuses an unknown `about` word or `holds by` value, and refuses a `pinned by` title that no test carries.
5. **Every `schema` row has a raw-insert test** that bypasses the repositories and shows the database refusing the row.
6. **JSDoc across `Domain`, the repositories, `ShopAgent` and `Repository`** is aligned: a structural rule is stated once, in the table; every other site links to it or explains its own code without restating the rule.
7. **AGENTS.md** carries the process rule: a structural change starts at the row.

## 2. Decisions this plan makes beyond the research

The research settled the format and the rows; these are the calls needed to write code. They are the plan's, not the user's, so list any you change in section 12.

- **The spec symbol is `initializeSchema`**, exported from `ShopAgentSchema.ts`. The parser finds a table by the JSDoc before `export const <name> =`, so the symbol must be exported and the table must be the first markdown table in that JSDoc. Nothing else in the file has a JSDoc table.
- **`about` accepts glossary nouns and table names.** Glossary nouns: `order`, `item`, `workflow`, `draft`, `step`, `task`, `run`. Table names: any `create table` name in the same file, backticked. The research's `singleton`, `dedupe` and `outbox` become `` `SyncState` ``, `` `WebhookDelivery` `` and `` `UsageEvent` `` rows.
- **`holds by` is one of `schema`, `app`, `schema+app`.** No `?`: after this plan every row has been implemented and the value is known. `?` in the research meant "implementer decides"; you are the implementer.
- **`pinned by` is an exact `it(...)` title or `(none yet)`.** The check is a string search over `test/**/*.test.ts` for `it("<title>"`. The title must be the whole string; the plan's new tests use the row's rule sentence as the title, so the row and the test read the same.
- **Which rows get `check` constraints.** Listed in step 3. A row moves from `app` to `schema+app` when a constraint refuses the row but the write path also keeps a wider promise (a transaction, a same-statement recompute); to `schema` when the constraint alone is the whole rule.
- **The action-table script keeps its name.** `pnpm action-table check` gains the data-model table rather than a new script; a rename to a general `spec` script is out of scope.
- **The research doc is not deleted by this plan.** Say in the final report that it can be.

## 3. What this does not change

Behavioural rules and their tables (`RunStatus`, `runActions`, `taskActions`), the glossary, the repositories' write paths except where a new `check` requires two columns be set in one statement, the D1 schema, the seed, any route, any screen copy, the `WorkflowLayout` module. `step` stays an integer column (research decision 8).

## 4. Prerequisites and the reset protocol

- Schema edits go into the initial DDL in line. No migration. The user resets local state after schema changes.
- **When the DDL changes (step 3), stop and tell the user before continuing to any step that runs the app.** The user must:
  1. stop the local dev server;
  2. run `pnpm d1:reset`, which recreates local D1 from migrations and wipes `.wrangler`, which holds every local Durable Object's SQLite as well;
  3. destroy any remote Shop Agent objects on staging through the admin page's orphan tool if staging is in use (the constructor reruns `runShopAgentMigrations`, and `create table if not exists` will not add a `check` to an existing table);
  4. restart the local dev server with `pnpm app:dev`, then `pnpm seed`.
     Tests do not need this: `vitest-pool-workers` gives each test a fresh object.
- Put the same instruction in the final report, with the list of DDL lines that changed, so the user knows why.
- `pnpm port` gives the dev port. E2E runs headless with `npm run test:e2e --`; run it once at the end since the schema underneath every page changed.

## 5. Step 1. Extract `src/lib/ShopAgentSchema.ts`

1. Create `src/lib/ShopAgentSchema.ts`. Move `initializeSchema` (the JSDoc and the `Effect.gen` with the DDL) and `runShopAgentMigrations` from `ShopAgent.ts` into it, unchanged in this step. Export both. Imports needed: `SqliteMigrator` from `@effect/sql-sqlite-do`, `Effect` from `effect`, `SqlClient` from `effect/unstable/sql`, `causeToErrorMessage` from `@/lib/LayerEx`.
2. In `ShopAgent.ts`, import `runShopAgentMigrations` from `@/lib/ShopAgentSchema`. Drop `SqliteMigrator` from its imports if nothing else uses it. The constructor call at the `this.runEffect(runShopAgentMigrations)` site and the JSDoc on `makeRunEffect` that mentions `runShopAgentMigrations` stay as they are.
3. `test/integration/member-runs-socket.test.ts` imports `runShopAgentMigrations` from `@/lib/ShopAgent`; point it at the new module. Grep for any other importer.
4. `src/lib/Shopify.ts` mentions `runShopAgentMigrations` in a JSDoc; leave it.

Check: typecheck, lint, test all pass with no behaviour change.

## 6. Step 2. The table

Replace the JSDoc on `initializeSchema` with the block below, then move the surviving prose to where it belongs (step 2b). Write the table with the `pinned by` titles this plan creates in step 5; until step 5 lands, `pnpm action-table check` will fail on them, which is expected and is why step 4 and step 5 come before the first green run.

### 2a. The JSDoc

```
/**
 * The data model of one shop's Durable Object, as rules. The table is the
 * spec: it says what is true of the data, never which column or index makes
 * it true; the DDL below conforms to it. `about` is a glossary noun
 * (`Domain`) or a table name. `holds by` is the implementer's report of who
 * guarantees the rule: `schema` when the database refuses a violating row,
 * `app` when a write path or transaction does, `schema+app` when both are
 * needed. `pinned by` is the title of the test that asserts the rule.
 * `pnpm action-table check` parses the table, refuses an unknown word, and
 * refuses a title no test carries.
 *
 * A structural change starts at the row: change the sentence, then the DDL
 * and the write paths, then the pinned test. A failing pinned test says the
 * row and the code disagree, not which is wrong; the fix is to one of them,
 * never to the test. Behavioural rules (what a state permits) are not here;
 * they live on the `Domain` symbol that is the concept, {@link Domain.RunStatus}
 * and the action matrices.
 *
 * Vocabulary, so the same fact is always said the same way: cardinality is
 * "exactly one", "at most one", "one or more", "zero or more"; a reference
 * "snapshots" (copied at write, never re-read), "points to" (live; follows a
 * rename) or "references none"; a pointer into D1 "points to a D1 row;
 * dangling reads as null", since no foreign key can cross stores; lifetime
 * is "goes with" (cascades), "survives", "only X deletes"; history is "no
 * history", "latest only", "one row per event"; derivation is "stored, never
 * derived", "derived and stored", "derived, never stored"; consistency is
 * "set together", "cleared together", "implies"; a one-row table has
 * "exactly one row".
 *
 * | about             | rule                                                                                                                                   | holds by   | pinned by                                                                                       |
 * | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
 * | order             | an order is Shopify's record, mirrored; each sync overwrites it whole except `countedAt` and its items' `matchedWorkflowIds`            | app        | (none yet)                                                                                      |
 * | order             | an order is billed at most once, on its first run                                                                                      | app        | (none yet)                                                                                      |
 * | order             | an order older than retention is deleted; its items go with it; its runs survive                                                       | schema+app | (none yet)                                                                                      |
 * | item              | an item has exactly one order and goes with it                                                                                         | schema     | an item has exactly one order and goes with it                                                  |
 * | item              | an item has at most one run, over every status; a closed run holds the slot until a person replaces it                                 | schema     | the unique index itself refuses a second row for an item, and a closed run still holds the slot |
 * | workflow          | a workflow is identified by its tag; no two workflows share one; the name is a label two may share                                     | schema     | a workflow is identified by its tag; no two workflows share one; the name is a label two may share |
 * | workflow          | a workflow has zero or more steps in order; a step has one or more tasks, done in parallel; a task is in exactly one step             | app        | (none yet)                                                                                      |
 * | workflow          | a workflow has at most one draft; the draft holds tasks only                                                                           | schema     | a workflow has at most one draft; the draft holds tasks only                                    |
 * | workflow          | definition tasks change only by Apply, whole, in one transaction; a run starting between two edits sees one definition                | app        | (none yet)                                                                                      |
 * | workflow          | no history: a delete removes the workflow, its tasks and its draft, and nothing else                                                   | schema+app | deleteWorkflow cascades its draft and tasks                                                     |
 * | workflow          | `activatedAt` is stored, never derived, and is both the switch and the coverage date                                                   | app        | skips orders placed before the workflow was turned on; manual attach still works                |
 * | task              | a definition task's team points to a D1 row; dangling reads as null, which means unassigned                                           | app        | (none yet)                                                                                      |
 * | run               | a run snapshots its workflow, order and item and references none of them; it survives their delete and edit                            | schema+app | a run snapshots its workflow, order and item and references none of them                        |
 * | run               | a run's tasks go with it; only deleting the run deletes tasks                                                                          | schema     | a run's tasks go with it; only deleting the run deletes tasks                                   |
 * | run               | a run's tasks and steps are a snapshot of the definition's at creation                                                                 | app        | creates one run per matching item with copied tasks and team names                              |
 * | task              | a run task's team is both: it points to the team (a D1 row, deletable while the run is open) and snapshots the team's name for history | app        | (none yet)                                                                                      |
 * | run               | `status` is derived from the tasks and stored, recomputed by every task write in the same transaction; `closed` is the exception, written never derived | app | (none yet)                                                                            |
 * | run               | `closedAt` and `closedReason` are set together, once, and only on a closed run; nothing leaves closed                                  | schema+app | `closedAt` and `closedReason` are set together, once, and only on a closed run                  |
 * | run               | only an open run can be blocked; a run that is done or closed carries no block                                                         | schema+app | only an open run can be blocked; a run that is done or closed carries no block                  |
 * | run               | who did what is a snapshot (`*ByEmail`, `teamName`); history never resolves through `Member` or `Team`                                 | app        | (none yet)                                                                                      |
 * | run               | reopen is latest only; a later Done clears it                                                                                          | app        | (none yet)                                                                                      |
 * | task              | a team delete nulls the team on open run tasks and leaves done ones alone                                                              | app        | (none yet)                                                                                      |
 * | `SyncState`       | exactly one row                                                                                                                        | schema     | `SyncState` and `ShopUsage` have exactly one row each                                           |
 * | `ShopUsage`       | exactly one row                                                                                                                        | schema     | `SyncState` and `ShopUsage` have exactly one row each                                           |
 * | `WebhookDelivery` | one row per Shopify delivery id, kept for a while and swept by age                                                                     | schema+app | (none yet)                                                                                      |
 * | `UsageEvent`      | one row per idempotency key, kept until Shopify accepts it                                                                             | schema+app | (none yet)                                                                                      |
 *
 * Two rows are provisional and marked so in the research: "billed at most
 * once, on its first run" and "a team delete nulls open run tasks only" are
 * the current behaviour; the user will confirm them once billing and team
 * delete firm up.
 *
 * Versioned through `SqliteMigrator` rather than a bare `create table if not
 * exists` block, so the next migration has somewhere to go.
 */
export const initializeSchema = ...
```

Adjust `pinned by` cells to the exact titles you write in step 5; where a listed title already exists (the `RunRepository one row per item` test, `deleteWorkflow cascades its draft and tasks`, and so on), copy it verbatim from the test file. If step 3 changes a row's `holds by`, change the cell.

### 2b. Where the old prose goes

Go through the old JSDoc paragraph by paragraph. Each sentence is one of four kinds; do this to each:

1. **A structural rule.** It is now a row. Delete the sentence.
2. **SQL rationale** (why `ShopOrder` not `Order`; ids as `text` because of 52-bit round-tripping; why `(processedAt desc, id desc)`; two task tables rather than a flag so a task-id write is never ambiguous and `unique (workflowId, position)` holds per side; why `WorkflowRepository.writeLayout` parks tasks at `-position`; `WorkflowTask.teamId` has no foreign key because SQLite cannot cross into D1; epoch-ms not ISO). Move each to a `--` comment directly above the DDL line it explains, in the style of the existing `ShopOrder_processedAt` comment. Keep the reasoning; drop the narrative connectives.
3. **A behavioural rule already on a `Domain` symbol** (`activatedAt` moves on Turn on / Turn off / never on Apply; a run starts only when `processedAt >= activatedAt`; what a `done` run permits; reopen clearing; `currentWhere`). Delete it here; check the `Domain` symbol carries it (`Domain.Workflow`'s vocabulary block and `Domain.RunStatus` do). If a sentence is not on any `Domain` symbol, move it there, do not keep it here.
4. **Subsystem plumbing** (`UsageEvent`'s accept-then-delete protocol and why `idempotencyKey` is the key; `ShopUsage`'s seeded-null cycle and `setBillingCycle`; `SyncState` holding only what the last import left; `WebhookDelivery` as Shopify's retry dedupe). Move each to the JSDoc of the function that owns the behaviour: the App Events flush for `UsageEvent`, `setBillingCycle` / `OrderRepository.countOrder` for `ShopUsage`, `ShopAgent.syncOrders` for `SyncState`, the webhook receive path for `WebhookDelivery`. If that function's JSDoc already says it, delete rather than duplicate. Leave a one-line `--` comment on the table naming the owner ("-- the App Events outbox; protocol on `ShopAgent.flushUsageEvents`", using the real name).

After 2b the JSDoc on `initializeSchema` is the block in 2a and nothing else.

## 7. Step 3. DDL changes so the schema holds what it can

All in the DDL inside `initializeSchema`. Each is a `check` SQLite enforces on insert and update, so before adding one, read every write that touches the columns and confirm it sets them in one statement. A write that sets `status = 'closed'` in one `update` and `closedAt` in a second would fail the check between the two even inside a transaction. `RunRepository`'s close (`set status = 'closed', closedAt = ..., closedReason = ...`) and block (`set blockedAt = ..., blockReason = ..., blockedBy = ...`) are single statements today; verify the unblock, the reopen and the task-write status recompute too.

1. **`Run`: closed is one fact.**
   ```sql
   check ((status = 'closed') = (closedAt is not null)),
   check ((closedAt is null) = (closedReason is null)),
   ```
   Row "`closedAt` and `closedReason` are set together, once, and only on a closed run" becomes `schema+app` (the "once" and "nothing leaves closed" halves stay with the write paths, which never update these columns after the close).
2. **`Run`: a block needs an open run.**
   ```sql
   check (blockedAt is null or status = 'active'),
   ```
   The close write in `RunRepository` already clears `blockedAt`, `blockReason`, `blockedBy` in the same statement that sets `status = 'closed'` (checked 2026-09-26), so this check is satisfied by the existing write. Also confirm the status recompute that moves a run to `done` clears the block, or that Done is refused while blocked (the action matrix says it is: `done` needs "not blocked"), so a `done` run never carries `blockedAt`. Whether `blockReason` and `blockedBy` are always set with `blockedAt` is for you to check against the block write; if they are, add `check ((blockedAt is null) = (blockedBy is null))` and note it.
3. **`RunTask`: reopen is one fact.**
   ```sql
   check ((reopenedAt is null) = (reopenedByRole is null)),
   ```
   The row "reopen is latest only; a later Done clears it" stays `app` (the constraint says nothing about "latest" or "clears"); note the constraint on the row's `--` comment instead.
4. **Task tables: positions and steps start at 1.**
   ```sql
   check (position >= 1), check (step >= 1),
   ```
   on `WorkflowTask`, `WorkflowDraftTask` and `RunTask`. `WorkflowLayout` writes dense `1..n`, but `writeLayout` parks tasks at `-position` mid-transaction, so **do not add `position >= 1` on `WorkflowTask` or `WorkflowDraftTask`** unless you first change the parking scheme; SQLite checks are immediate. Add `step >= 1` on all three and `position >= 1` on `RunTask` only, and record that asymmetry as a `--` comment. If you would rather change the parking to a large offset so the check can hold everywhere, do it and record it in section 12.
5. Do not add a constraint the row does not ask for. An index change is not a spec change and needs no row.

Then stop and tell the user to run the reset protocol (section 4) before any step that runs the dev server.

## 8. Step 4. Parse and check the table

In `scripts/lib/action-table.ts`:

1. Generalise `jsdocBefore` and the table-locating half of `parse` so a second table shape can reuse them; the existing `parse` for `runActions` and `taskActions` must keep its exact behaviour and messages (its test asserts them).
2. Add `parseDataModel(source: string): Result<readonly DataModelRow[], ParseError>` that finds the JSDoc before `export const initializeSchema =`, takes its first table, requires the header `about | rule | holds by | pinned by`, and decodes each row:
   - `about`: one of the glossary nouns `order`, `item`, `workflow`, `draft`, `step`, `task`, `run`, or a backticked name that matches a `create table if not exists <Name>` in the same source. Refuse anything else with a message naming the word.
   - `rule`: non-empty.
   - `holds by`: `schema`, `app`, or `schema+app`.
   - `pinned by`: `(none yet)` or non-empty text.
3. Add `checkPinned(rows, testSources: Record<string, string>): string[]` returning one message per row whose `pinned by` is not `(none yet)` and whose exact title does not occur as `it("<title>"` or `it(\n  "<title>"` in any test source. Match on the title string appearing inside `it(` followed by optional whitespace and a quote; do not attempt to parse TypeScript.
4. In `scripts/action-table.ts` `check`, read `src/lib/ShopAgentSchema.ts` and every `test/**/*.test.ts`, run `parseDataModel` and `checkPinned`, and add their messages to `failures`. In `print`, render the rows as `about: rule [holds by] — pinned by`.
5. In `test/integration/action-table.test.ts`, add a `describe("data model table")` with: the real table parses; a doctored header is refused; an unknown `about` word is refused; an unknown `holds by` is refused; `checkPinned` returns `[]` against the real tests (load them with `import.meta.glob("/test/integration/*.test.ts", { query: "?raw", import: "default", eager: true })`) and returns one message when a title is doctored. Load the schema source with `import "@/lib/ShopAgentSchema.ts?raw"`.
6. Update the header comment of `scripts/action-table.ts` and the AGENTS.md line for `pnpm action-table check` to say it also checks the data-model table.

## 9. Step 5. Tests

New file `test/integration/data-model.test.ts`, one `describe("data model")`, using the same repository harness as `test/integration/run-repository.test.ts` (`runInRepository`, `SqlClient`, the seed helpers). Each `it` title is the row's rule sentence verbatim, so the `pinned by` cell and the test agree by construction. For every `schema` and `schema+app` row, the pattern is the existing "the unique index itself refuses a second row for an item" test: write the forbidden row with raw `sql`, bypassing the repositories, and assert `SqlError`; then, where the row also claims a positive fact (cascade, survival), assert that with a raw select.

1. **an item has exactly one order and goes with it**: insert an `OrderLineItem` with an `orderId` no `ShopOrder` has; expect refusal (foreign keys are on in the DO's SQLite: nothing in `src/` sets the pragma, and the existing `deleteWorkflow cascades its draft and tasks` test passes only because they are; if this insert succeeds anyway, that is a finding for section 12, not a test to weaken). Then delete the order and assert its items are gone.
2. **a workflow is identified by its tag; no two workflows share one; the name is a label two may share**: two workflows with one tag refused; two with one name accepted.
3. **a workflow has at most one draft; the draft holds tasks only**: second `WorkflowDraft` row for one workflow refused. For "tasks only", assert the `WorkflowDraft` table has no `name` or `tag` column by selecting `pragma table_info(WorkflowDraft)` and checking the column set is `workflowId, createdAt, updatedAt`; that is the one place a column list belongs in a test, because the rule is about what the draft does not hold.
4. **a run snapshots its workflow, order and item and references none of them**: create a run through reconcile, then raw-delete the workflow, the order (and so the item), and assert the run row and its tasks are still there with the snapshotted names. Existing tests cover the workflow half through the repository; this one goes underneath them.
5. **a run's tasks go with it; only deleting the run deletes tasks**: raw-delete a run, assert its tasks are gone; insert a `RunTask` with a `runId` no run has, expect refusal.
6. **`closedAt` and `closedReason` are set together, once, and only on a closed run**: three raw updates on an open run, each expected to fail: `closedAt` without `closedReason`; `closedReason` without `closedAt`; `status = 'closed'` without either. Then close through `cancelRun` and assert all three columns agree.
7. **only an open run can be blocked; a run that is done or closed carries no block**: raw update setting `blockedAt` on a closed run, expect refusal; block an open run through the repository, cancel it, assert `blockedAt` is null.
8. **`SyncState` and `ShopUsage` have exactly one row each**: insert `id = 2` into each, expect refusal; assert count is 1 after a fresh migration.
9. The `RunTask` reopen check and the `step >= 1` checks from step 3 have no row of their own; cover them inside test 5 with one extra refused insert each, so the constraint is not silent.

Do not write tests for the `app` rows in this plan; they are `(none yet)` on purpose (research decision 5) and follow one at a time. Do update the `pinned by` cells to the titles that already exist for the rows the research identified.

## 10. Step 6. Align the JSDoc

The rule: a structural rule is stated once, in the table. Every other site either links to it or explains its own code without making the claim. The link text is ``the data model on `initializeSchema` (`ShopAgentSchema.ts`)``; `Domain.ts` does not import the schema module, so this is a plain reference, not `{@link}`.

Go through each site below. Read the JSDoc, find the sentence that states a structural rule, and either delete it (if the surrounding text stands without it) or replace it with a link. Keep any sentence that explains why this code does what it does. Do not touch behavioural rules.

- `src/lib/Domain.ts`
  - `Run` struct JSDoc ("every display field is a snapshot ... `lineItemId` is unique: one row per item, `done` and `closed` included"): keep the sentence about why a snapshot matters for this struct's readers; replace the one-row-per-item and no-foreign-key claims with the link.
  - `WorkflowDraft` JSDoc ("at most one per workflow (`workflowId` is the primary key)"): replace with "One per workflow at most; the data model on `initializeSchema` says so and the draft holds tasks only." Drop the primary-key aside; how it holds is the table's `holds by`.
  - `WorkflowTask` / `teamId` JSDoc ("a live pointer to a D1 `Team`, not a snapshot"): keep; it explains this field's reads. Add the link.
  - `Workflow` vocabulary block: keep as vocabulary (it is merchant copy and behaviour). Where it says "Runs copy it wholesale and never look back at it" and "delete a workflow and its runs stay", add the link after the sentence; do not delete, since this block is the merchant-facing statement.
  - `RunStatus` gate table row "holds the item's slot": keep; it is the behavioural face of the structural rule. Add the link in the paragraph under the table.
  - `Team` JSDoc near "`TeamMember` cascades; nothing else structural points here. Run history survives the delete because `RunTask` snapshots": this is the D1 side; leave, since the D1 table is a follow-up.
  - `ShopLimits` / billing JSDoc mentioning `countOrder` "bills exactly once": leave; the row is provisional.
- `src/lib/RunRepository.ts`
  - `setRun` JSDoc ("An item holds at most one run, so this is a replace"): keep the first clause as the reason for the replace, add the link, delete any restatement of `unique lineItemId` mechanics that the DDL comment now carries.
  - The `on conflict do nothing` comment in `reconcileOrder` and the "Delete first: the unique `lineItemId` must be free" comment in `setRun`: keep; they explain the statements.
  - `unassignTeam`-adjacent and `assignTask` JSDoc mentioning snapshotting `teamName`: keep; add the link on the first.
- `src/lib/WorkflowRepository.ts`
  - `deleteWorkflow` JSDoc ("draft tasks by cascade. Every run stays ... a run snapshots `workflowName`") and the JSDoc near "so nothing cascades from the `Workflow` delete": replace the cascade and survival claims with the link; keep the sentence that says what the merchant sees.
  - `discardDraft` ("Deletes the draft (tasks cascade)"): keep; one word.
  - `unassignTeam` JSDoc ("closed run keep the pointer and their `teamName` snapshot"): keep; it is the row's own write path. Add the link.
- `src/lib/ShopAgent.ts`: after step 1 the only mentions are in method JSDocs ("Runs in flight snapshot their tag and tasks", the team-delete comments near `unassignTeam`). Read each; add the link where the sentence is a claim about the data model rather than about the method.
- `src/lib/Repository.ts` (D1): the team and member delete JSDocs say run history survives because actor emails and team names are snapshots. Keep; add the link, since the rule they rely on is now stated on the DO side.
- `src/lib/OrderRepository.ts`: the retention delete comment ("`OrderLineItem` cascades; `RunTask` cascaded") explains the statement; keep. Add the link on the retention sweep's JSDoc where it says runs survive.

Then grep once more for `one row per item`, `at most one draft`, `never look back`, `no history`, `cascade` across `src/` and confirm every remaining hit is either the table, a DDL comment, a link, or a sentence about the code beside it.

## 11. Step 7. AGENTS.md

Add one bullet after the action-matrix bullet:

> The data-model table in the JSDoc on `initializeSchema` (`src/lib/ShopAgentSchema.ts`) is the spec for the Durable Object's schema: one row per structural rule, in the glossary's words, with `holds by` (schema, app, schema+app) and `pinned by` (a test title). `pnpm action-table check` parses it and refuses a title no test carries. A structural change starts at the row, then the DDL and write paths, then the pinned test. A failing pinned test means the row and the code disagree; fix one of them, never delete the test. Behavioural rules stay on the `Domain` symbol.

Update the `pnpm action-table check` line in the Commands block to mention the data-model table.

## 12. Deviations and issues

Record here, as you go, anything that did not go as written: a check that a write path could not satisfy in one statement and what you did instead; a row whose `holds by` came out different from the table in 2a; a test in step 5 that could not be written as described (for example, foreign keys found off); a JSDoc site not listed in step 6 that restated a rule; a decision in section 2 you changed and why. One bullet each, with the file and the reason. The user reads this section first.

- **Row corrected: retention deletes runs.** The 2a row "an order older than retention is deleted; its items go with it; its runs survive" disagrees with the code: `OrderRepository.sweepExpiredOrders` deletes an expired order's runs in the same transaction, on purpose (`Domain.Run`: "the snapshots are for reading, not for outliving the order"; `deleteSeedOrders` does the same). Section 3 rules out behaviour changes, so the row now reads "its items and its runs go with it" (`src/lib/ShopAgentSchema.ts`). If you wanted runs to survive retention, that is a behaviour change to make from the row.
- **Row corrected: what a run survives.** For the same reason, "it survives their delete and edit" became "it survives a workflow delete and every edit to the three": a run does not survive its order's delete. The raw-SQL test still shows that no key ties a run to its order, workflow or item.
- **Extra constraint:** `check ((blockedAt is null) = (blockedBy is null))` on `Run`. The block write sets `blockedAt` and `blockedBy` together, and every unblock and close clears both. `blockReason` is optional text, so it has no such check.
- **Test fixtures that the new checks refuse.** `test/integration/run-actions.test.ts`: rows with "open or done, blocked any" expanded to a blocked done run, a state the schema now refuses. Review (2026-09-27) moved the rule into `expand` (`scripts/lib/action-table.ts`): "any" under `blocked` names a block on the open run only, stated on the `runActions` matrix and pinned by "a done run is never blocked" in `action-table.test.ts`; the test-side `storable` filter is gone. `test/integration/order-repository.test.ts`: raw `blockedAt = 1` updates now also set `blockedBy`, and "counts a block on open runs only, and counts closed runs" no longer blocks a done run, since that state cannot be stored.
- **Stale JSDoc removed** (not listed in step 6): `WorkflowRepository.deleteWorkflow` said `Run.workflowId` is "the conflict key of `unique (lineItemId, workflowId)`". The schema has `unique (lineItemId)` only.
- **Moved elsewhere than the plan said.** `SyncState`'s prose went on `OrderRepository.getSyncState`, not on `ShopAgent.syncOrders`, because `syncOrders` already explains the in-flight half. `ShopUsage`'s went on `ShopUsageRow` (what the row holds) and `OrderRepository.setBillingCycle` (the seeded-null cycle, `shopGid`). `UsageEvent`'s went on `OrderRepository.flushUsageEvents`. `WebhookDelivery`'s was already on `OrderRepository.recordWebhookDelivery`, so it was deleted from the schema JSDoc, and only the `receivedAt` index reason moved to a DDL comment.
- **Left as is:** the step paragraph in `Domain.WorkflowTask`'s JSDoc ("every task belongs to exactly one step") overlaps the steps row. It defines the concept and says `WorkflowLayout` holds it, and that row is `app` with no test yet.
- **Parking scheme unchanged.** `position >= 1` is on `RunTask` only, with a DDL comment explaining why. `step >= 1` is on all three task tables.
- **Foreign keys are on** in the DO's SQLite. A mutation run with each constraint removed failed all eight `data-model` tests.
- **E2E run after the user's reset** (2026-09-27): 66 passed.

## 13. Final report

When every step is green (`pnpm typecheck && pnpm lint && pnpm test && npm run test:e2e --`, then `pnpm fmt`), report:

1. The DDL lines that changed, and the reset protocol from section 4, stated as instructions for the user to run now.
2. The final table's `holds by` column where it differs from 2a.
3. Section 12 verbatim.
4. That `docs/data-model-spec-research.md` and this plan can be deleted once the user has read them.

# Action tables as the editable spec: implementation plan

For an implementing LLM. The decisions are in
`docs/action-table-spec-research.md` (Decisions 1 to 11); this plan is how
to land them. Read that file first, then the Glossary block at the top of
`src/lib/Domain.ts`: every word in the tables below comes from it.

## Ground rules

From `AGENTS.md`, restated because each one bites here:

- Do not commit. Do not branch. Work on `main`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` after each stage. `pnpm fmt`
  repo-wide at the end and keep every file it touches.
- A JSDoc never references `docs/`. It carries its reasoning inline.
- Rules stay on the symbol that owns them. Predicates, never inline
  comparisons (`scripts/rules-lint.ts` refuses them).
- Plain prose in JSDoc and comments. No flourishes.
- Chrome DevTools MCP (`.mcp.json`, `chrome-devtools`) is available if
  seeing a page helps, for example to confirm that a button the table says
  is offered is drawn. `pnpm playwright-cli` is the other option. Wait for
  `body[data-hydrated="true"]` before clicking. Neither is required: this
  work changes no page.
- Record anything that departs from this plan under Deviations and issues,
  as you go, one bullet each with the reason.

## What lands

1. The two action matrices move from the JSDoc on the `RunActions` and
   `TaskActions` schemas to the JSDoc on the `runActions` and `taskActions`
   functions, redrawn with one column per input.
2. `scripts/lib/action-table.ts`: pure parse, expand and glossary check.
3. `scripts/action-table.ts`: `check` and `print`; `check` joins
   `pnpm lint`.
4. `test/integration/run-actions.test.ts` reads the tables from the source
   text and asserts the functions against every expanded row, and drives
   every `ShopAgent` callable into every expanded row's state, expecting
   `NotAllowed` on blank cells and success on filled ones.
5. JSDoc across `Domain.ts` is aligned to the new placement and the
   glossary's words where it speaks of the tables.
6. One line in `AGENTS.md`.

## Target shape

### The `runActions` JSDoc

Replace the JSDoc on `export const RunActions = Schema.Struct(` with one
line, and move the rest onto `export const runActions = (`. The result:

```ts
/** What an actor may do to one run: the result of {@link runActions}, whose JSDoc holds the matrix. */
export const RunActions = Schema.Struct({ ... });

/** The "m" in {@link runActions}' table: the merchant, or a member whose team holds a ready or started task on the run. */
const holdsReadyTask = ...

/**
 * What an actor may do to one run, as the page and the server both read it.
 * The page renders a run-level button only when its field is true, and the
 * `ShopAgent` callable for that write computes the same object from the same
 * inputs and refuses with `NotAllowed` when the field is false, so a stale
 * tab or a second admin cannot write what the page would not offer. The
 * repository keeps its own guards underneath; they protect the write from
 * every caller, reconcile and tests included.
 *
 * The table is the rule. `test/integration/run-actions.test.ts` reads it
 * out of this comment and asserts every row, so a change starts at a cell
 * and the test names the cell until the formula follows. `pnpm lint`
 * refuses a malformed table.
 *
 * "M" is the merchant. "m" is a member whose team holds a ready or started
 * task on the run ({@link readyTasks}, {@link taskIsOnTeams}), the team gate
 * `RunRepository` applies to Block, Edit reason and Unblock; for the
 * note it is a member who can see the run ({@link runIsVisibleTo}). Blank is
 * never. Each state column is one input; a row is one fixture, and a word
 * such as "closed" under `order` stands for every state it names.
 *
 * | order  | run    | blocked | units | note | block | editReason | unblock | cancel | changeWorkflow |
 * | ------ | ------ | ------- | ----- | ---- | ----- | ---------- | ------- | ------ | -------------- |
 * | open   | open   | no      | some  | M m  | M m   |            |         | M      | M              |
 * | open   | open   | yes     | some  | M m  |       | M m        | M m     | M      | M              |
 * | open   | open   | no      | none  | M m  | M m   |            |         | M      |                |
 * | open   | done   | no      | some  | M m  |       |            |         |        |                |
 * | open   | closed | no      | some  | M m  |       |            |         |        |                |
 * | closed | open   | no      | some  | M m  |       |            |         |        |                |
 *
 * Why a cell is blank where it might not be:
 *
 * - `note` is never blank: a note is a record, not work.
 * - `block` is blank on a blocked run: it is already held, and a second
 *   Block would overwrite who held it.
 * - `editReason` and `unblock` need {@link runIsBlocked}. Closing a run
 *   clears its block, so a closed run is never blocked, and a closed
 *   order's runs are all closed.
 * - `cancel` is blank on a done run: it is a record, reopened rather than
 *   cancelled. On a closed order reconcile has already closed every open
 *   run; there is nothing to cancel.
 * - `changeWorkflow` needs units to make ({@link unitsToMake}): a new run
 *   on an item Shopify removed or refunded to zero would be a run with no
 *   work behind it, and reconcile would close it as `item_removed` on its
 *   next pass. A closed item takes a new workflow from its picker instead
 *   ({@link lineItemState}). Reading it needs the line item, which only the
 *   merchant's callers hold, so `item` is optional and its absence answers
 *   false: member pages never offer Change workflow.
 * - There is no member `cancel` or `changeWorkflow`: those are the
 *   merchant's decisions about what the shop makes.
 */
export const runActions = (
```

### The `taskActions` JSDoc

Same move: one line on `TaskActions`, the rest on `taskActions`.

```ts
/**
 * What an actor may do to one task: the result of {@link taskActions}, whose JSDoc holds the matrix.
 */
export const TaskActions = Schema.Struct({
  ...
  /** `null` when Reopen is not offered; otherwise the blocker, `null` meaning the button. */
  reopen: ...
});

/**
 * What an actor may do to one task, by the same contract as
 * {@link runActions}: the page draws a button only when its field is true,
 * the `ShopAgent` callable refuses with `NotAllowed` when it is false, and
 * the test reads this table. "M" is the merchant, "m" a member whose team
 * the task is on ({@link taskIsOnTeams}).
 *
 * | order  | run          | blocked | task     | downstream | start | done | putBack | reopen  | assign |
 * | ------ | ------------ | ------- | -------- | ---------- | ----- | ---- | ------- | ------- | ------ |
 * | open   | open         | no      | ready    | -          | m     | M m  |         |         | M      |
 * | open   | open         | no      | started  | -          |       | M m  | M m     |         | M      |
 * | open   | open         | no      | waiting  | -          |       |      |         |         | M      |
 * | open   | open         | yes     | any open | -          |       |      |         |         | M      |
 * | open   | open or done | any     | done     | none       |       |      |         | M m     |        |
 * | open   | open or done | any     | done     | started    |       |      |         | blocker |        |
 * | open   | closed       | no      | any      | -          |       |      |         |         |        |
 * | closed | open or done | no      | any      | -          |       |      |         |         |        |
 *
 * `blocker` under `reopen` is the button with a sentence: the started
 * downstream task ({@link undoBlockedBy}) is carried so the merchant page
 * can say what stands in the way.
 *
 * - `start` is member only. "Started" records that a worker picked the task
 *   up, and a merchant marking it started on their behalf would put a name
 *   on work nobody has begun.
 * - `done` and `putBack` stop under a block: a block means stop
 *   ({@link runIsBlocked}). Put back goes to the whole team, not only the
 *   starter (`RunRepository.unstartTask`).
 * - `reopen` is offered under a block because it takes work back rather
 *   than doing more, and on a done run because undoing its last Done is
 *   the point. Not on a closed run: closed is final ({@link RunStatus}),
 *   and reopening a task would put work back on a run nothing can finish.
 * - `assign` is blank on a done task: it keeps the team that did it
 *   (`TaskFinishedError`). One verb for a task with no team and for moving
 *   one that has a team.
 * - Everything is blank on a closed order ({@link orderIsOpen}) and a
 *   closed run: Shopify, or the merchant, says the work is over.
 *
 * (keep the two paragraphs "The verbs a task offers are the same on the
 * run list and the work page..." and "Nothing on a member screen renders
 * that blocker..." verbatim; they are screen rules, not cells)
 */
export const taskActions = (
```

Check each bullet against Rule 4 of the research: keep reasons, delete
restatements of cells. The lists above are the intended result; if a
sentence in the current JSDoc carries a reason not listed here, keep it and
note it under Deviations.

### Vocabulary the parser accepts

State columns and words. This is the JSDoc of `expand` in
`scripts/lib/action-table.ts`, in this exact form so the `check` error can
print it.

| column     | word         | fixture                                                                              |
| ---------- | ------------ | ------------------------------------------------------------------------------------ |
| order      | open         | `{ cancelledAt: null, fulfillmentStatus: "UNFULFILLED" }`                            |
| order      | closed       | cancelled `{ cancelledAt: 1, ... "UNFULFILLED" }`; fulfilled `{ null, "FULFILLED" }` |
| run        | open         | status `active`                                                                      |
| run        | done         | status `done`                                                                        |
| run        | closed       | status `closed`                                                                      |
| run        | open or done | `active`; `done`                                                                     |
| blocked    | yes / no     | `blockedAt` 1 / null                                                                 |
| blocked    | any          | both                                                                                 |
| units      | some / none  | `currentQuantity` 1 / 0 (runActions only)                                            |
| task       | ready        | `ready: true, startedAt: null, doneAt: null`                                         |
| task       | started      | `ready: true, startedAt: 1, doneAt: null`                                            |
| task       | waiting      | `ready: false, startedAt: null, doneAt: null`                                        |
| task       | done         | `ready: false, startedAt: 1, doneAt: 2`                                              |
| task       | any open     | ready; started; waiting                                                              |
| task       | any          | ready; started; waiting; done                                                        |
| downstream | none         | `undoBlockedBy: null`                                                                |
| downstream | started      | `undoBlockedBy: BLOCKER` (a fixed `UndoBlocker`)                                     |
| downstream | -            | not applicable; fixture `null`                                                       |

Action cells: `""`, `M`, `m`, `M m`, and `blocker` (only under `reopen`).

`runActions` rows have no task column. Their fixture carries one task on
the member's team with `ready` equal to "run is open", as the test's
`tasksOf` does today.

The `ready` and `started` words are the glossary's. The `ready` flag they
set is the code's broader one (true for a started task too); the rename is
a follow-up, not this work.

## Stages

Do them in order. Each ends green on typecheck, lint and test.

### Stage 0: baseline

Run `pnpm typecheck && pnpm lint && pnpm test`. Record anything already
failing under Deviations and issues so it is not blamed on this work.

### Stage 1: rewrite the two JSDoc tables in place

In `src/lib/Domain.ts`, without moving anything yet:

1. Replace the `RunActions` table with the column form from Target shape.
2. Replace the `TaskActions` table with its column form.
3. Trim the bullets under each to reasons (Rule 4). Use the bullet lists in
   Target shape.
4. Change the "m" sentence on `RunActions` and on `holdsReadyTask` to "a
   ready or started task" (Decision 11).
5. Add the "The table is the rule..." paragraph.

No code change. `pnpm typecheck && pnpm lint && pnpm test` stay green: the
old test still passes because the formulas did not change.

### Stage 2: move the JSDoc onto the functions

1. Cut the JSDoc from `export const RunActions =` and paste it above
   `export const runActions = (`. Leave the one-line JSDoc on the schema
   given in Target shape.
2. Same for `TaskActions` / `taskActions`. The field JSDoc on `reopen`
   inside the schema stays.
3. `holdsReadyTask` sits between the two; its JSDoc already links
   `runActions`. Leave it.

Then align every other JSDoc that speaks of the tables (Stage 7 lists the
grep; do the obvious ones now):

- The module JSDoc, line "The action tables cover buttons": unchanged in
  substance, but confirm it still reads right with the tables on the
  functions.
- `runIsBlocked`'s gate table links `{@link taskActions}` and
  `{@link runActions}`: already the functions. Leave.
- Search `Domain.ts` and `src/` for `RunActions` and `TaskActions` in
  comment text (not type positions) and repoint any that mean the matrix
  to `runActions` / `taskActions`.

### Stage 3: `scripts/lib/action-table.ts`

Pure module. Imports `effect` only (`Schema`, `Option`, `Result` as
needed). No `node:fs`, no `node:path`: the test imports this file into
workerd.

Exports:

```ts
/** One parsed row: the state words by column, the cell by action. */
export interface Row {
  readonly state: Readonly<Record<string, string>>;
  readonly cells: Readonly<Record<string, Cell>>;
}
export type Cell = "" | "M" | "m" | "M m" | "blocker";

/** Which columns are state and which are actions, per table. */
export const TABLES = {
  runActions: {
    state: ["order", "run", "blocked", "units"],
    actions: [
      "note",
      "block",
      "editReason",
      "unblock",
      "cancel",
      "changeWorkflow",
    ],
  },
  taskActions: {
    state: ["order", "run", "blocked", "task", "downstream"],
    actions: ["start", "done", "putBack", "reopen", "assign"],
  },
} as const;
export type TableName = keyof typeof TABLES;

/**
 * Find the JSDoc immediately preceding `export const <name> =` in `source`,
 * take its first markdown table, and decode it. Fails with a message that
 * names the line and the offending word or cell.
 */
export const parse: (
  source: string,
  name: TableName,
) => Result<readonly Row[], ParseError>;

/** Expand one row's state words into every concrete fixture it names. JSDoc holds the vocabulary table from the plan. */
export const expand: (name: TableName, row: Row) => readonly Fixture[];

/** The row rendered back as one line, for `it` titles and `print`. */
export const renderRow: (name: TableName, row: Row) => string;

/**
 * No two rows of a table expand to a common fixture. Independence is what
 * makes a row safe to edit alone.
 */
export const overlaps: (
  name: TableName,
  rows: readonly Row[],
) => readonly [Row, Row][];

/**
 * Every backticked identifier in the Glossary block occurs as a word
 * elsewhere in the source. A rename that skipped the glossary is the
 * failure this catches; it does not prove the word is the right kind of
 * thing (a literal, an export). Reports the missing words.
 */
export const checkGlossary: (source: string) => readonly string[];
```

Implementation notes:

- Locating the JSDoc: find the index of `\nexport const ${name} =`, walk
  backwards over whitespace, require the preceding text to end with `*/`,
  and find the matching `/**` before it. Strip the leading `*` from each
  line. Take the lines from the first line starting with `|` to the last
  consecutive one.
- Table decoding: split each line on `|`, trim cells, drop the first and
  last empty pieces, skip the `---` separator row. Header must equal
  `[...state, ...actions]` for the table in order; anything else fails.
  Each state cell must be a word the vocabulary knows for that column;
  each action cell must be one of the five, and `blocker` only under
  `reopen`.
- Fixture type: `{ order: OrderState, run: { status, blockedAt }, task?:
{ teamId, ready, startedAt, doneAt, undoBlockedBy }, item?: {
currentQuantity } }`. Import the `Domain` types with `import type` only
  so the script has no runtime dependency on `src/`; use plain literals for
  the values. `teamId` is a placeholder the test replaces with its `T`.
  Simplest: `expand` takes a `teamId: string` argument.
- Glossary block: the block comment that starts with ` * Glossary.` at the
  top of the file. Identifiers: `` `([A-Za-z_][A-Za-z0-9_]*)` `` inside
  it; ignore multi-word backticks and values with spaces. A word is present
  when `\b<word>\b` matches the source with the glossary block removed.
- Use `Effect.Schema` for the cell and word unions so the error messages
  list the allowed values.

The parser gets its own tests in `test/integration/action-table.test.ts`.
There is no Node-pool Vitest project (`vitest.config.ts` points at the
workers pool only), and one runner is enough: the module is pure, so it
runs under workerd like anything else. Feed it inline source strings.
Cases, each titled with the rule:

- "the table is the first one in the JSDoc before the export"
- "an unknown state word fails and the error lists the vocabulary"
- "a cell outside M, m, M m, blank and blocker fails"
- "blocker is refused outside the reopen column"
- "any and or words multiply fixtures"
- "two rows that share a fixture are an overlap"
- "a glossary word absent from the rest of the file is reported"

### Stage 4: `scripts/action-table.ts`

An `effect/unstable/cli` command in the style of `scripts/refs.ts`
(`Command.make`, `NodeRuntime.runMain`). Reads `src/lib/Domain.ts` with
`node:fs` (`readFileSync` is fine; the file is small).

- `check`: for both tables, `parse`, then `overlaps`; then
  `checkGlossary`. Print each failure on its own line. Exit 1 on any via
  `CliError.UserError`.
- `print`: for both tables, print `renderRow` for each row, and the number
  of fixtures each expands to.

Add to `package.json`:

```json
"lint": "oxlint --format agent && node scripts/rules-lint.ts && node scripts/action-table.ts check",
"action-table": "node scripts/action-table.ts"
```

Add the two commands to the `## Commands` block in `AGENTS.md`:

```
pnpm action-table check # Parse the action tables in Domain.ts and check the glossary (also run by pnpm lint)
pnpm action-table print # Render the parsed action tables and their fixture counts
```

`pnpm lint` must now fail if you break a table on purpose. Try it: change
one `M m` to `Mm`, run `pnpm lint`, confirm the message names the row and
the cell, revert.

### Stage 5: the test reads the tables

`test/integration/run-actions.test.ts`:

1. `import source from "@/lib/Domain.ts?raw";` and
   `import * as ActionTable from "../../scripts/lib/action-table.ts";`.
   Add `"../scripts/lib/action-table.ts"` to `test/tsconfig.json`'s
   `include`. If `?raw` needs a module declaration under the test tsconfig,
   `vite/client` is already in its `types`; confirm `pnpm typecheck` is
   happy before going further.
2. Delete `RUN_MATRIX` and `TASK_MATRIX`, `Cell`, `TaskCell`, `expected`,
   `tasksOf`, and the "open, nothing to make" `it` (it is now a row).
3. For each table:

   ```ts
   const rows = Result.getOrThrow(ActionTable.parse(source, "runActions"));
   describe("Domain.runActions matrix", () => {
     for (const row of rows)
       it(ActionTable.renderRow("runActions", row), () => {
         for (const fixture of ActionTable.expand("runActions", row, T)) {
           deepStrictEqual(Domain.runActions(MERCHANT, ...), expectedOf(row, "M"));
           deepStrictEqual(Domain.runActions(MEMBER, ...), expectedOf(row, "m"));
         }
       });
   });
   ```

   `expectedOf` turns cells into the result object. For `taskActions`,
   `reopen` is `null`, `{ blockedBy: null }` for `M m`, or
   `{ blockedBy: BLOCKER }` for `blocker`. Keep `BLOCKER` in the test and
   pass it to `expand` (or have `expand` take `{ teamId, blocker }`).

4. Keep as titled `it` cases, unchanged: "without the line item, Change
   workflow is not offered", "a member whose team holds no ready task gets
   only the note, and only if the run is theirs to see", "a task on none of
   the member's teams offers the member nothing", "reopen is not offered on
   a closed run". Delete "a fulfilled order is closed the same way as a
   cancelled one", "a closed run offers only the note" and "cancel is not
   offered on a closed order": each is now a row's expansion. If one of
   them asserts something a row does not (read it before deleting), keep
   it and say so under Deviations.
5. Update the file's opening comment: the matrices are read from
   `Domain.ts`, not copied.
6. The `ShopAgent refuses what the action set refuses` half is rewritten in
   Stage 5b. Leave it as is until then.

Run `pnpm test`. Then prove the loop: change one cell in `Domain.ts` (say
`cancel` on the done row to `M`), run `pnpm lint` (passes: well formed),
run `pnpm test` (fails, and the failing title is the row), revert.

### Stage 5b: the callables walk the rows

Replace the hand-written walk in `describe("ShopAgent refuses what the
action set refuses")` with a loop over the same parsed rows. The pure half
proves the formula matches the table; this half proves every callable reads
that formula with the right inputs in every state.

**Putting a live run into a row's state.** Do not replay history through
the callables. The test already writes the Durable Object's SQLite directly
(`exec`) for states reconcile or Shopify would produce; use it for every
column:

| column     | word      | SQL on the seeded two-task run (Cut at step 0, Polish at step 1)                       |
| ---------- | --------- | -------------------------------------------------------------------------------------- |
| order      | open      | `update ShopOrder set cancelledAt = null, fulfillmentStatus = 'UNFULFILLED'`           |
| order      | closed    | cancelled: `set cancelledAt = 1`; fulfilled: `set fulfillmentStatus = 'FULFILLED'`     |
| run        | open      | `update Run set status = 'active', closedAt = null, closedReason = null`               |
| run        | done      | `set status = 'done'`, and both tasks `doneAt` set                                     |
| run        | closed    | `set status = 'closed', closedAt = 1, closedReason = 'merchant_cancelled'`             |
| blocked    | yes/no    | `update Run set blockedAt = 1, blockedBy = 'x'` / `blockedAt = null, blockedBy = null` |
| units      | some/none | `update OrderLineItem set currentQuantity = 1` / `0`                                   |
| task       | ready     | the task under test is Cut: `startedAt = null, doneAt = null`; Polish untouched        |
| task       | started   | Cut `startedAt = 1`                                                                    |
| task       | waiting   | the task under test is Polish, Cut not done                                            |
| task       | done      | the task under test is Cut, `startedAt = 1, doneAt = 2`                                |
| downstream | none      | Polish `startedAt = null`                                                              |
| downstream | started   | Polish `startedAt = 3` (Cut done, Polish ready and started)                            |

Read the `Run`, `RunTask`, `ShopOrder` and `OrderLineItem` `create table`
blocks in `src/lib/ShopAgent.ts` for the exact column names and the check
constraints before writing the statements (`blockedBy*`, `closedReason`
values, `startedByRole`). Write one `reset(fixture)` helper that sets every
column the fixture touches back to a known value first, then applies the
row: a fixture must not inherit state from the previous one.

**Which callable is which cell.** Merchant calls go over the merchant
socket (`merchantActions`) or the RPC stub (`agent.*`); member calls over a
member socket on the run's team.

| table       | cell             | merchant                                   | member                  |
| ----------- | ---------------- | ------------------------------------------ | ----------------------- |
| runActions  | `note`           | `merchant.setRunNote`                      | `member.setRunNote`     |
| runActions  | `block`          | `merchant.blockRun`                        | `member.blockRun`       |
| runActions  | `editReason`     | `merchant.setBlockReason`                  | `member.setBlockReason` |
| runActions  | `unblock`        | `merchant.unblockRun`                      | `member.unblockRun`     |
| runActions  | `cancel`         | `agent.merchantCancelRun`                  | (no member callable)    |
| runActions  | `changeWorkflow` | `agent.merchantAttachWorkflow` (see below) | (no member callable)    |
| taskActions | `start`          | (no merchant callable)                     | `member.startTask`      |
| taskActions | `done`           | `merchant.completeTask`                    | `member.completeTask`   |
| taskActions | `putBack`        | `merchant.unstartTask`                     | `member.unstartTask`    |
| taskActions | `reopen`         | `merchant.uncompleteTask`                  | `member.uncompleteTask` |
| taskActions | `assign`         | `agent.merchantAssignRunTaskTeam`          | (no member callable)    |

A cell with no callable for that actor is skipped for that actor; the
table already says `M` only or `m` only there, and the test for the pure
function covers the false side.

`changeWorkflow` is the one cell whose callable does not answer
`NotAllowed`: `merchantAttachWorkflow` returns `ItemDone`, `OrderClosed`,
`NothingToMake`, or attaches a fresh run on a closed item (the picker's
path, which the table does not govern). Assert it by result tag: a filled
cell expects `Ok` with `replaced` set; a blank cell expects one of the
three refusal tags, and on the closed-run row it is not called, with a
comment saying the closed item's picker is `lineItemState`'s rule, not
this table's. Re-seed the run after a successful attach (the run was
replaced) before the next fixture.

**The loop.**

```ts
for (const row of runRows)
  it(`callables: ${ActionTable.renderRow("runActions", row)}`, async () => {
    for (const fixture of ActionTable.expand("runActions", row, team.id)) {
      await reset(shop, fixture);
      for (const [cell, call] of RUN_CALLS)
        for (const who of ["M", "m"] as const) {
          const fn = call[who];
          if (fn === undefined) continue;
          const result = await fn();
          if (offered(row.cells[cell], who)) expect(result._tag).toBe("Ok");
          else expect(result).toEqual(NOT_ALLOWED);
          await reset(shop, fixture); // a successful call changed the state
        }
    }
  });
```

Same shape for `taskRows` with the task under test chosen per the SQL
table above (Cut for ready, started, done; Polish for waiting; `any` and
`any open` expand to each). A filled `reopen` cell with `blocker` expects
`UndoBlocked`, not `Ok`: the callable refuses for a different reason and
the table says the button is drawn with that sentence. Assert the tag the
callable actually returns and say so in a comment on the `RUN_CALLS` /
`TASK_CALLS` map.

Seed once per `describe` (team, order, workflow, attached run, both
sockets), as the walk does today; only the SQL reset runs per fixture.
Keep the test under the 30 s timeout: two tables, twenty-odd fixtures,
eleven callables, two actors is a few hundred socket calls, which the
current walk's timing suggests is well inside it. If it is not, split by
table into two `it` blocks per row and record the timing under Deviations.

Delete the hand-written walk once the loop is green. The comment on the
`describe` says what this proves and links `runActions` and `taskActions`.

### Stage 6: `AGENTS.md`

Under the first bullet (JSDoc rules), add:

```
- An action matrix in a JSDoc (`runActions`, `taskActions` in `src/lib/Domain.ts`) is the spec: the test reads it out of the source, and a behaviour change starts at the cell. `pnpm lint` checks that the tables parse and that every word the glossary names still exists.
```

### Stage 7: align the JSDoc

The tables moved and the words changed; other comments may still describe
the old placement or the old words. Grep and fix, in `src/` and `test/`:

```
grep -rn -e "RunActions" -e "TaskActions" src test | grep -v "Domain\.\(Run\|Task\)Actions\b" | grep -v "^src/lib/Domain.ts:.*Schema\.\|: RunActions\|: TaskActions"
grep -rn -e "matrix" -e "action table" -e "action set" -e "State \\\\ action" src test
grep -rn -e "reassign" -e "completedAt" -e "pending" src test | grep -v BulkOperation
grep -rn "ready task" src
```

For each hit that is prose (a comment, a JSDoc, a test title), decide:
points at the matrix → `{@link runActions}` / `{@link taskActions}`;
old word → glossary word; "ready task" meaning ready-or-started → "ready or
started task". Type positions and the field JSDoc inside the schemas stay.
List every file you touched under Deviations.

Also check `src/lib/ShopAgent.ts` callables that compute the action set
(`NotAllowed` sites): if one has a comment naming the table, repoint it.

### Stage 8: finish

1. `pnpm typecheck && pnpm lint && pnpm test`.
2. `pnpm fmt` repo-wide. Keep every file it touches.
3. `git status` and read the diff of `Domain.ts` once, top to bottom, as a
   reviewer would: the survey view should be on the functions and nothing
   else should have changed in the file.
4. Fill in Deviations and issues below. Do not delete this file or the
   research: the user does that after review.

## Deviations and issues

The implementing LLM records here, as it goes, anything that departed from
this plan or needed a judgement call, with the reason. One bullet each. The
user reads this section first at review.

- **Baseline** was green: typecheck, lint, 452 tests. The only noise is the
  suite's existing uncaught-exception log lines (Workflows engine,
  `OfflineSessionNotFoundError`), present before and after.
- **Stages 1 and 2 done as one edit.** The end state is the same; the
  intermediate state had no separate value.
- **Kept three reasons the target bullets dropped**, since each explains a
  blank cell: `block` "On a done or closed run there is no work left to
  hold"; `cancel` "A closed run is over already"; `changeWorkflow` "A done
  run is a record ({@link RunStatus})". Dropped as restatements of cells:
  "Every field except `note` is false when..." on `runActions`, and the
  "only on a started task" / "merchant only, on an open task" clauses on
  `taskActions`.
- **`Row` carries `line`** (the source line of the row). `check` needs it
  to name both rows of an overlap; the parser tests assert it.
- **`expand` takes `{ teamId, blocker }` and is generic over both**, so the
  test passes branded `TeamId` / `UndoBlocker` and gets fixtures the
  `Domain` functions accept without casts; `overlaps` and `print` pass
  placeholders. The one comparison `run.status === "active"` for the
  runActions fixture's `ready` is spelled out in `expand` with a comment:
  the module imports `Domain` for types only.
- **`Cell` is a `Schema.Literals`, and so is each column's vocabulary**;
  the expansion maps are typed `Record<word, ...>` against them, so a word
  added to one without the other fails typecheck.
- **Kept two pure tests the plan marked for deletion**, because no row
  covers what they assert: "a fulfilled order is closed the same way as a
  cancelled one" checks done and closed runs on a closed order (the table's
  closed-order row is an open run only), and "cancel is not offered on a
  closed order" checks a blocked run there (the row is unblocked only). A
  comment above them says so. "a closed run offers only the note" was
  deleted: the `open | closed` row is the same fixture.
- **Callable walk: task under test.** The plan's SQL table put a done run
  as "both tasks done", which makes Cut's downstream started. So on a done
  run, "done, downstream none" tests Polish (both done), and "done,
  downstream started" tests Cut. Rows the table allows but the app never
  produces (a done run with an open task under a closed order; a done run
  with a block) are written directly; the gate answers them as the table
  says. `tasksFor` in the test holds the mapping.
- **Callable walk: `blockedBy` is JSON** (`Schema.fromJsonString(Actor)`),
  so the reset writes the merchant actor, not `'x'`.
- **Callable walk: filled `assign` answers `Assigned`, not `Ok`**, and a
  filled `blocker` under `reopen` answers `UndoBlocked`. `taskOk` in the
  test names both.
- **Callable walk structure.** Seeding moved to `beforeAll` inside the
  `describe`, and the file-level `afterEach` that wiped D1 moved to that
  `describe`'s `afterAll`: with one `it` per row, the per-test wipe would
  have deleted the team and session the later rows' callables read. The
  loop bodies are named functions (`checkRunRow`, `checkTaskRow`,
  `checkChangeWorkflow`) rather than inline closures, to satisfy oxlint's
  `no-loop-func` and `no-continue`. The whole walk takes about half a
  second, well under the timeout.
- **Stage 7 "ready task" sweep limited to the Block/Unblock team gate**:
  `runIsBlocked`'s JSDoc in `Domain.ts`, and `setRunNote`, `blockRun`,
  `unblockRun` and `requireReadyTeam` in `RunRepository.ts`, now say "ready
  or started task". The other hits in `src/` (run-list membership, parallel
  steps, `readyWhere`) use the code's broad `ready` in its own sense and
  belong to the rename follow-up; changing them now would be churn that
  rename redoes. The `RunActions`/`TaskActions` and "matrix"/"action set"
  greps found no prose pointing at the old placement; `ShopAgent.ts`'s
  `requireRunAction` already links `Domain.runActions`.
- **Files touched**: `src/lib/Domain.ts`, `src/lib/RunRepository.ts`,
  `test/integration/run-actions.test.ts`, `test/tsconfig.json`,
  `package.json`, `AGENTS.md`; new `scripts/lib/action-table.ts`,
  `scripts/action-table.ts`, `test/integration/action-table.test.ts`.
  `pnpm fmt` touched no other file.
- **Loop proved**: `M m` → `Mm` makes `pnpm lint` fail with
  `runActions, line N: cell "Mm" under block; expected one of: blank, M, m,
M m, blocker`; `any open` → `any` on the blocked task row makes it fail
  with `rows share a fixture`; `cancel` → `M` on the done row passes lint
  and fails two tests titled with that row (pure and callable). All
  reverted.

### Review (2026-09-26)

Checked against the plan and the research decisions. Typecheck, lint and
the suite were green before and after. Changes made in review:

- **Rows now cover what the two kept pure tests asserted, and those tests
  are gone.** The runActions closed-order row is `closed | open or done |
any | some` plus `closed | closed | no | some`; the taskActions
  closed-order row is `closed | open or done | any | any | -`. The callable
  walk passes on the new fixtures too. "reopen is not offered on a closed
  run" was also deleted: the `open | closed | no | any` row is that
  fixture for both actors. The hand tests left are the outsider and
  no-item ones, which Rule 3 keeps because they are not state.
- **`RunStatus`'s gate table used the broad `ready`.** "Start, Done | task
  ready" and "Put back | task started and ready" now read Start: ready;
  Done: ready or started; Put back: started, the glossary's words.
- **The parser checks the separator row.** It skipped the second line by
  position, so a table missing its `---` row would have dropped its first
  data row without a message. `check` now refuses it; the parser test
  "the row after the header must be the separator" pins it.

Also changed, then left as is, for the record:

- The Glossary's verbs table had a "who" column repeating the tables' M /
  m per action, which nothing checked. Dropped; the header now points at
  the two matrices for who.
- `checkChangeWorkflow` accepts any of the three refusal tags on a blank
  cell rather than the one the fixture should produce. Tightening it means
  ordering the refusals as `merchantAttachWorkflow` does; not worth it
  until a wrong tag matters.
- `holdsReadyTask`, `RunTaskView.ready` and the run-list JSDoc keep the
  broad `ready`, per Decision 11.

## Follow-ups

Carried from `docs/action-table-spec-research.md`; not part of this work.

- **Rename the broad `ready`.** `readyTasks`, `readyWhere`,
  `RunTaskView.ready` and `holdsReadyTask` are true for a started task; the
  glossary's `ready` means nobody has it. Pick a word for "step current"
  (`current` was floated) and rename, together with the task badge
  "In progress" → "Started" in the UI pass. When that lands, `expand` maps
  `ready` and `started` onto the new flag, and the "m" paragraph on
  `runActions` says "a current task".
- **Revisit `RunStatus`'s gate table** and `runIsBlocked`'s for the same
  treatment once the parser exists (research Decision 6).
- **Upgrade the glossary check** to assert literals against
  `Schema.Literals` and symbols against exports, if presence ever lets a
  stale row through (research Decision 10).

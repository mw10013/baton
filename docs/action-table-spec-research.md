# Action tables as the editable spec

## What we are deciding

`Domain.runActions` and `Domain.taskActions` are the one gate for every run
and task write: the page draws a button when a field is true, the `ShopAgent`
callable refuses when it is false. The code is about forty lines of boolean
formulas and stays as it is. It is correct and simple, but it is not a view
you can survey: to know what a blocked run offers you evaluate `working`,
`held` and `ready` in your head.

The JSDoc on each function already holds the survey view, a state × action
matrix. The problem is that the matrix is written three times, and only two
copies are checked against each other:

| copy                                                                   | checked by |
| ---------------------------------------------------------------------- | ---------- |
| function body                                                          | the test   |
| `RUN_MATRIX` / `TASK_MATRIX` in `test/integration/run-actions.test.ts` | the test   |
| markdown table in the JSDoc                                            | nothing    |

Decision taken in conversation: the JSDoc table is the artifact a person
edits and an LLM implements from. The test's hand-copied matrix goes away,
and the test reads the table out of the JSDoc instead. Editing a cell then
fails the test until the code follows, which is the "align the
implementation with the spec" loop, with the failing test naming the cell.

Not doing: deriving the spec from the tests (rejected), turning the code into
a lookup table (the formulas generalize to states the table does not list),
moving the spec to `docs/` (goes stale, not in the diff).

## Status after the domain language work (2026-09-25)

`docs/domain-language-research.md` and `docs/domain-language-plan.md` have
landed. This doc was re-checked against `src/lib/Domain.ts` and
`test/integration/run-actions.test.ts` as they are now. Four things in the
earlier draft were wrong or have moved; each is corrected below and marked
**Correction**.

1. **The words changed.** `reassign` is `assign`; a finished task is `done`,
   not `completed`; run status `pending` is gone, so "open" is one stored
   value, `active`. The JSDoc tables in `Domain.ts` already use the new
   words. The draft tables below are redrawn in them.
2. **The tables sit on the schemas today, and move to the functions.** The
   matrix for `runActions` is the JSDoc on
   `export const RunActions = Schema.Struct(...)`, and likewise
   `TaskActions`; the functions `runActions` and `taskActions` carry no
   JSDoc. The matrix is a rule about what the function computes from its
   inputs, so it belongs on the function (see Decision 8).
3. **The test cannot read the file.** `run-actions.test.ts` runs under
   `@cloudflare/vitest-pool-workers`, inside workerd, where `node:fs` does
   not exist. The draft's "the test imports the parser, which reads
   `Domain.ts`" fails at runtime. The parser takes source text as a
   parameter; the test gets the text through Vite's `?raw` import, the CLI
   through `node:fs`.
4. **`ready` has two senses.** The glossary's `ready` is "step current,
   nobody has it". In code, `RunTaskView.ready`, `readyTasks` and
   `holdsReadyTask` are true for a started task too (recorded under
   Deviations in the plan; the rename is deferred to the UI pass). The
   table's `task` column uses the glossary's narrow words, and the
   expansion maps them onto the broad flag plus `startedAt`. The "m"
   paragraph on `RunActions` should say "a ready or started task" until
   the rename lands.

The domain language research also assigned this work one more job: the
`check` command asserts the glossary in `Domain.ts` against the code. That
is added under The parser.

## What the tables look like today

`RunActions`:

```
| State \ action        | note | block | editReason | unblock | cancel | changeWorkflow |
| --------------------- | ---- | ----- | ---------- | ------- | ------ | -------------- |
| open, not blocked     | M m  | M m   |            |         | M      | M              |
| open, blocked         | M m  |       | M m        | M m     | M      | M              |
| open, nothing to make | M m  | M m   |            |         | M      |                |
| done                  | M m  |       |            |         |        |                |
| closed                | M m  |       |            |         |        |                |
| order closed          | M m  |       |            |         |        |                |
```

`TaskActions`:

```
| State \ action                                   | start | done | putBack | reopen    | assign |
| ------------------------------------------------ | ----- | ---- | ------- | --------- | ------ |
| run open, not blocked, task ready, not started   | m     | M m  |         |           | M      |
| run open, not blocked, task ready, started       |       | M m  | M m     |           | M      |
| run open, not blocked, task waiting              |       |      |         |           | M      |
| run open, blocked, any open task                 |       |      |         |           | M      |
| run open or done, task done, no downstream start |       |      |         | M m       |        |
| run open or done, task done, downstream started  |       |      |         | (blocker) |        |
| run closed                                       |       |      |         |           |        |
| order closed                                     |       |      |         |           |        |
```

Two things make these hard to execute as written.

**The state column is prose.** "open, blocked" is a label. The test today
maps each label to concrete fixtures by hand (`run("active", true)` with an
open order). A parser cannot build a fixture from "run open or done, task
done, downstream started"; something has to say what rows of `run`, `order`
and `task` that means. Several labels also cover more than one fixture
("order closed" is cancelled and fulfilled; "any open task" is three task
shapes), and the test lists all of them.

**The "m" column has a definition outside the table.** For `RunActions`,
"m" means a member whose team holds a ready-or-started task on the run,
except for `note`, where it means a member who can see the run. For
`TaskActions` it means a member whose team the task is on. A member outside
those sets gets nothing, which the test covers with `OUTSIDER` cases the
table does not show.

## Proposal for the table format

### Rule 1: state is columns, not a label

Replace the single "State" column with one column per input the function
reads, using the glossary's words. A row is then a fixture, and the parser
builds it mechanically.

`RunActions`:

```
| order  | run    | blocked | units | note | block | editReason | unblock | cancel | changeWorkflow |
| ------ | ------ | ------- | ----- | ---- | ----- | ---------- | ------- | ------ | -------------- |
| open   | open   | no      | some  | M m  | M m   |            |         | M      | M              |
| open   | open   | yes     | some  | M m  |       | M m        | M m     | M      | M              |
| open   | open   | no      | none  | M m  | M m   |            |         | M      |                |
| open   | done   | no      | some  | M m  |       |            |         |        |                |
| open   | closed | no      | some  | M m  |       |            |         |        |                |
| closed | open   | no      | some  | M m  |       |            |         |        |                |
```

`TaskActions`:

```
| order  | run          | blocked | task     | downstream | start | done | putBack | reopen  | assign |
| ------ | ------------ | ------- | -------- | ---------- | ----- | ---- | ------- | ------- | ------ |
| open   | open         | no      | ready    | -          | m     | M m  |         |         | M      |
| open   | open         | no      | started  | -          |       | M m  | M m     |         | M      |
| open   | open         | no      | waiting  | -          |       |      |         |         | M      |
| open   | open         | yes     | any open | -          |       |      |         |         | M      |
| open   | open or done | any     | done     | none       |       |      |         | M m     |        |
| open   | open or done | any     | done     | started    |       |      |         | blocker |        |
| open   | closed       | no      | any      | -          |       |      |         |         |        |
| closed | open or done | no      | any      | -          |       |      |         |         |        |
```

Each state cell has a small closed vocabulary, and each word expands to one
or more concrete fixtures:

| column     | word           | fixtures                                                       |
| ---------- | -------------- | -------------------------------------------------------------- |
| order      | open           | uncancelled, unfulfilled                                       |
| order      | closed         | cancelled; fulfilled (two fixtures)                            |
| run        | open           | `active` (**Correction**: one fixture; `pending` is gone)      |
| run        | done, closed   | that status                                                    |
| run        | open or done   | `active`; `done`                                               |
| blocked    | yes / no / any | `blockedAt` set / null / both                                  |
| units      | some / none    | `currentQuantity` 1 / 0                                        |
| task       | ready          | `ready` true, `startedAt` null, `doneAt` null                  |
| task       | started        | `ready` true, `startedAt` set, `doneAt` null                   |
| task       | waiting        | `ready` false, `startedAt` null, `doneAt` null                 |
| task       | any open       | ready; started; waiting (three fixtures)                       |
| task       | done           | `ready` false, `startedAt` set, `doneAt` set                   |
| task       | any            | every task fixture                                             |
| downstream | none / started | `undoBlockedBy` null / a blocker; `-` means n/a (fixture null) |

`RunActions` rows have no `task` column, but the function reads the run's
tasks to decide who "m" is. The expansion supplies one task on the member's
team, ready when the run is open, exactly what `tasksOf` does in the test
today.

"any" and "or" words multiply fixtures, so one row tests every combination
it names. That is what the hand-written test does today by listing several
fixtures per label; the table now says it.

### Rule 2: the action cells keep the M / m vocabulary

A cell is blank, `M`, `m`, or `M m`. For `reopen`, `blocker` means "offered
to M and m, carrying the downstream blocker" and `M m` means "offered, no
blocker". Those are the only five cell values, and the parser refuses any
other.

### Rule 3: who "m" is stays in prose, once, above the table

The test keeps its `OUTSIDER` cases as ordinary `it(...)` tests with the
rule as the title ("a member whose team holds no ready task gets only the
note, and only if the run is theirs to see"). They are not rows: the table
is about state, and membership is a second axis that would double every row.
The paragraph above the table defines "m", and the tests for the outsider
link to it.

### Rule 4: the bullets under the table carry reasons only

Today the bullets restate cells in words ("`cancel`: open runs on an open
order, merchant only") and then give the reason. Keep only the reason
sentences. A cell is the rule; a bullet explains a cell that would otherwise
look arbitrary. Examples that stay:

- `start` is member only: a merchant marking a task started would put a name
  on work nobody has begun.
- `block` is not offered on a blocked run: a second Block would overwrite who
  held it.
- `reopen` is offered under a block because it takes work back rather than
  doing more.
- `changeWorkflow` needs units to make: a new run on a removed item would be
  a run with no work behind it.

Anything that is a restatement of a cell goes. The two paragraphs at the
end of the `TaskActions` JSDoc (no primary verb on a task; member screens
do not render the blocker) are screen rules, not cells, and stay.

### Rule 5: the table is found by the symbol that owns it

The parser locates the table by the exported function whose JSDoc holds it:
the JSDoc immediately preceding `export const runActions =` and
`export const taskActions =`, first markdown table in each. No special
markers in the source. The schemas `RunActions` and `TaskActions` keep a
one-line JSDoc saying they are the result of that function and the matrix
is there.

## The parser

`scripts/lib/action-table.ts`, three pure functions and no I/O:

- `parse(source, symbol)`: find the JSDoc preceding `export const <symbol> =`
  in the text, extract the first markdown table, decode it with an Effect
  `Schema` into rows of `{ state, cells }`. Refuses an unknown column, an
  unknown state word, or a cell outside the five values.
- `expand(row)`: state words to concrete `{ order, run, task, item }`
  fixtures, per the vocabulary table above. Its JSDoc is where the
  vocabulary lives (Decision 2).
- `checkGlossary(source)`: the job `docs/domain-language-research.md`
  assigned here. Every backticked identifier in the Glossary block must
  occur as a word elsewhere in `Domain.ts` (an export, a field, or a
  `Schema.Literals` value). A rename that skips the glossary fails. This is
  a presence check, not a type check: it does not prove `active` is a
  `RunStatus` literal, only that the word still exists in the file. That is
  the cheap check that catches the failure we have seen (a rename leaving a
  stale word); the stronger one costs a TypeScript-aware parse for no
  observed failure.

Two consumers:

1. `test/integration/run-actions.test.ts` does
   `import source from "@/lib/Domain.ts?raw"` (Vite inlines the file text
   at transform time, so it works inside workerd; `vite/client` types are
   already in both tsconfigs), parses both tables, expands each row, and
   asserts `Domain.runActions` / `Domain.taskActions` against the cells for
   `MERCHANT` and `MEMBER`. The `it` title is the row rendered back as
   text, so a failure names the cell. The second half of that file, which
   drives the `ShopAgent` callables into every blank cell, iterates the same
   rows. `test/tsconfig.json` gains `../scripts/lib/action-table.ts` in its
   include list.
2. `scripts/action-table.ts`, an `effect/unstable/cli` command in the style
   of `scripts/refs.ts`, reads `Domain.ts` with `node:fs`: `check` parses
   both tables, runs `checkGlossary`, and exits 1 on any failure, so a typo
   fails `pnpm lint` and not just `pnpm test`; `print` renders the parsed
   tables back to the terminal, which is the quick way to confirm the
   parser read what you meant.

The lint hook is the one that matters for the editing loop: you change a
cell, `pnpm lint` says the table is well formed, `pnpm test` says the code
does not match yet, the LLM changes the formula, `pnpm test` passes.

## Why parse the source rather than keep the table in a data file

A `.json` or `.ts` fixture next to the test is easier to parse and has no
vocabulary to define. It was rejected because the table would then live away
from the function it governs: a reader of `Domain.ts` would see the formulas
and not the survey, and a reviewer of a `Domain.ts` diff would not see the
spec change in the same hunk. The parsing cost is a regex for the comment
block and a split on `|`, a few dozen lines.

## Decisions

Answered in review on 2026-09-25; every recommendation was accepted.

1. **State is columns, not prose labels.** A prose label needs a
   hand-written label-to-fixture mapping, a fourth copy of the state space
   the parser cannot check. Columns say exactly which inputs matter, and a
   new input is a column, not a new adjective in every label.
2. **The state vocabulary lives in the parser**, as the JSDoc on the
   expansion function in `scripts/lib/action-table.ts`. A second table above
   the first in `Domain.ts` would be noise; an unknown word gets the list
   from the `check` error.
3. **One row expands to several fixtures.** "order closed" is cancelled and
   fulfilled; "any open" is three task shapes. Listing them separately
   multiplies the rows to say nothing. A future action that distinguishes
   them gets the specific word on its row.
4. **`reopen`'s `blocker` cell stays in the matrix.** It is one word in one
   column and a real merchant-facing behaviour: the button becomes a
   sentence. Splitting it out would leave the table claiming a button the
   page does not show.
5. **Parser in `scripts/lib/`, CLI in `scripts/`, imported by the test.**
   The `check` command is what puts a malformed table under `pnpm lint`.
   `test/tsconfig.json` needs `scripts/lib/action-table.ts` included.
6. **Only `runActions` and `taskActions` for now.** The other `Domain.ts`
   tables name a predicate or a file per rule, not a truth value per state,
   so there is nothing to assert them against. Revisit `RunStatus`'s gate
   table after this lands.
7. **Rows are independent, and `check` refuses overlapping rows.**
   Independence is what makes a row safe to edit alone; overlap detection
   is cheap once fixtures are concrete.

Answered in review on 2026-09-25 after the re-check:

8. **The tables move from the schemas onto the functions.** From first
   principles: the matrix is a truth table over the function's inputs
   (actor, order, run, tasks, item). The schema is the shape of the output
   and knows none of those inputs; it cannot own a rule about them. The
   module rule puts a rule on "the function that enforces it", and
   `runActions` is what the page and `ShopAgent` call, what every `{@link}`
   in the file points at, and what the test asserts against. The schema
   keeps one line: the result of `runActions`, matrix there. Churn was not
   a consideration.
9. **`?raw` import in the workers-pool test.** The matrix half and the
   callable half share fixtures and belong in one file; the callable half
   needs workerd. `?raw` is a Vite feature, so it works under
   `@cloudflare/vitest-pool-workers` the same as any import.
10. **Glossary check is word presence.** Every backticked identifier in the
    Glossary block must occur elsewhere in `Domain.ts`. That catches the
    one failure mode observed (a rename that leaves an old word in the
    glossary) with a regex. Upgrade to a literal-and-export check only if a
    stale row ever gets past it.
11. **The broad-`ready` rename lands after this work**, with the UI pass.
    The table uses the glossary's narrow `ready` and `started`, and the
    expansion maps them to the broad flag plus `startedAt`; nothing in the
    table format depends on the rename. The one wording fix now is the "m"
    paragraph on `runActions`: "a ready or started task on the run".

## Rollout

The implementation plan is `docs/action-table-spec-plan.md`.

0. Done: `docs/domain-language-research.md` and its plan landed.
1. Rewrite the two JSDoc tables to the column format and trim the bullets to
   reasons (Rules 1 to 4), and move each from its schema onto its function
   (Decision 8). Fix the "m" paragraph on `runActions` (Decision 11). No
   code change; the formulas already agree.
2. Write `scripts/lib/action-table.ts` (`parse`, `expand`, `checkGlossary`)
   and `scripts/action-table.ts` (`check`, `print`). Add `check` to
   `pnpm lint` after `rules-lint`.
3. Replace `RUN_MATRIX` and `TASK_MATRIX` in the test with the parsed rows
   via `?raw`. Keep the outsider, closed-order, no-item and closed-run tests
   as titled `it` cases.
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`.
5. Add one line to `AGENTS.md` under the JSDoc rule: an action matrix in
   JSDoc is the spec, the test reads it, and a change starts at the table;
   `pnpm lint` checks the glossary.
6. Delete this file, after copying Follow-ups into the next research doc
   or the plan that picks them up.

## Follow-ups

Not part of this work. Recorded so they are not lost when this file is
deleted.

- **Rename the broad `ready`.** `readyTasks`, `readyWhere`,
  `RunTaskView.ready` and `holdsReadyTask` are true for a started task; the
  glossary's `ready` means nobody has it. Pick a word for "step current"
  (`current` was floated) and rename, together with the task badge
  "In progress" → "Started" in the UI pass. When that lands, the expansion
  in `scripts/lib/action-table.ts` maps `ready` and `started` onto the new
  flag, and the "m" paragraph on `runActions` says "a current task".
- **Revisit `RunStatus`'s gate table** for the same treatment once the
  parser exists (Decision 6).
- **Upgrade the glossary check** to assert literals against
  `Schema.Literals` and symbols against exports, if presence ever lets a
  stale row through (Decision 10).

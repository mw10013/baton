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

## What the tables look like today

`runActions`:

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

`taskActions`:

```
| State \ action                                        | start | done | putBack | reopen    | reassign |
| ----------------------------------------------------- | ----- | ---- | ------- | --------- | -------- |
| run open, not blocked, task ready, not started        | m     | M m  |         |           | M        |
| run open, not blocked, task ready, started            |       | M m  | M m     |           | M        |
| run open, not blocked, task waiting                   |       |      |         |           | M        |
| run open, blocked, any open task                      |       |      |         |           | M        |
| run open or done, task completed, no downstream start |       |      |         | M m       |          |
| run open or done, task completed, downstream started  |       |      |         | (blocker) |          |
| run closed                                            |       |      |         |           |          |
| order closed                                          |       |      |         |           |          |
```

Two things make these hard to execute as written.

**The state column is prose.** "open, blocked" is a label. The test today
maps each label to concrete fixtures by hand (`run("active", true)` with an
open order). A parser cannot build a fixture from "run open or done, task
completed, downstream started"; something has to say what rows of `run`,
`order` and `task` that means. Several labels also cover more than one
fixture ("open" is `pending` and `active`; "order closed" is cancelled and
fulfilled), and the test lists all of them.

**The "m" column has a definition outside the table.** For `runActions`,
"m" means a member whose team holds a ready task on the run, except for
`note`, where it means a member who can see the run. For `taskActions` it
means a member whose team the task is on. A member outside those sets gets
nothing, which the test covers with `OUTSIDER` cases the table does not show.

## Proposal for the table format

### Rule 1: state is columns, not a label

Replace the single "State" column with one column per input the function
reads, using the vocabulary of the `Domain` predicates. A row is then a
fixture, and the parser builds it mechanically.

`runActions`:

```
| order  | run     | blocked | units | note | block | editReason | unblock | cancel | changeWorkflow |
| ------ | ------- | ------- | ----- | ---- | ----- | ---------- | ------- | ------ | -------------- |
| open   | open    | no      | some  | M m  | M m   |            |         | M      | M              |
| open   | open    | yes     | some  | M m  |       | M m        | M m     | M      | M              |
| open   | open    | no      | none  | M m  | M m   |            |         | M      |                |
| open   | done    | no      | some  | M m  |       |            |         |        |                |
| open   | closed  | no      | some  | M m  |       |            |         |        |                |
| closed | open    | no      | some  | M m  |       |            |         |        |                |
```

`taskActions`:

```
| order  | run          | blocked | task      | downstream | start | done | putBack | reopen  | reassign |
| ------ | ------------ | ------- | --------- | ---------- | ----- | ---- | ------- | ------- | -------- |
| open   | open         | no      | ready     | -          | m     | M m  |         |         | M        |
| open   | open         | no      | started   | -          |       | M m  | M m     |         | M        |
| open   | open         | no      | waiting   | -          |       |      |         |         | M        |
| open   | open         | yes     | any open  | -          |       |      |         |         | M        |
| open   | open or done | any     | completed | none       |       |      |         | M m     |          |
| open   | open or done | any     | completed | started    |       |      |         | blocker |          |
| open   | closed       | no      | any       | -          |       |      |         |         |          |
| closed | open or done | no      | any       | -          |       |      |         |         |          |
```

Each state cell has a small closed vocabulary, and each word expands to one
or more concrete fixtures:

| column     | word           | fixtures                                        |
| ---------- | -------------- | ----------------------------------------------- |
| order      | open           | uncancelled, unfulfilled                        |
| order      | closed         | cancelled; fulfilled (two fixtures)             |
| run        | open           | `pending`; `active` (two fixtures)              |
| run        | done, closed   | that status                                     |
| run        | open or done   | `pending`; `active`; `done`                     |
| blocked    | yes / no / any | `blockedAt` set / null / both                   |
| units      | some / none    | `currentQuantity` 1 / 0                         |
| task       | ready          | ready, not started, not completed               |
| task       | started        | ready, started, not completed                   |
| task       | waiting        | not ready, not started                          |
| task       | any open       | ready; started; waiting (three fixtures)        |
| task       | completed      | completed                                       |
| task       | any            | every task fixture                              |
| downstream | none / started | `undoBlockedBy` null / a blocker; `-` means n/a |

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

Anything that is a restatement of a cell goes.

### Rule 5: the table is fenced and named so the parser can find it

The parser locates the table by the exported symbol whose JSDoc holds it
(`runActions`, `taskActions`) and takes the first markdown table in that
comment. No special markers in the source.

## The parser

`scripts/lib/action-table.ts`: read `src/lib/Domain.ts`, find the JSDoc
immediately preceding `export const <name> =`, extract the markdown table,
decode it with an Effect `Schema` into rows of `{ state, cells }`. Expanding
state words into fixtures is a second function in the same module, so the
parse (pure text) and the expansion (knows about `Domain` row shapes) are
separate and each is small.

Two consumers:

1. `test/integration/run-actions.test.ts` imports it, expands each row, and
   asserts `Domain.runActions` / `Domain.taskActions` against the cells for
   `MERCHANT` and `MEMBER`. The `it` title is the row rendered back as text,
   so a failure names the cell. The second half of that file, which drives
   the `ShopAgent` callables into every blank cell, iterates the same rows.
2. `scripts/action-table.ts`, an `effect/unstable/cli` command in the style
   of `scripts/refs.ts`: `check` parses both tables and exits 1 on a
   malformed table or an unknown word, so a typo fails `pnpm lint` and not
   just `pnpm test`; `print` renders the parsed tables back to the terminal,
   which is the quick way to confirm the parser read what you meant.

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

## Domain language comes first

The column headers and cell words of the tables are domain terms, and the
current terms are uneven (task state words, the team-move verb, `completedAt`
against status `done`). That work is split out to
`docs/domain-language-research.md` and lands before this doc resumes, so the
tables are rewritten once, in the final words. The table drafts above use
today's words and will be redrawn.

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
3. **One row expands to several fixtures.** "open" is `pending` and
   `active`, "order closed" is cancelled and fulfilled. Listing them
   separately doubles the rows to say nothing. A future action that
   distinguishes them gets the specific word on its row.
4. **`reopen`'s `blocker` cell stays in the matrix.** It is one word in one
   column and a real merchant-facing behaviour: the button becomes a
   sentence. Splitting it out would leave the table claiming a button the
   page does not show.
5. **Parser in `scripts/lib/`, CLI in `scripts/`, imported by the test.**
   The `check` command is what puts a malformed table under `pnpm lint`.
   `test/tsconfig.json` may need `scripts/lib` included.
6. **Only `runActions` and `taskActions` for now.** The other `Domain.ts`
   tables name a predicate or a file per rule, not a truth value per state,
   so there is nothing to assert them against. Revisit `RunStatus`'s gate
   table after this lands.
7. **Rows are independent, and `check` refuses overlapping rows.**
   Independence is what makes a row safe to edit alone; overlap detection
   is cheap once fixtures are concrete.

## Rollout

0. Land `docs/domain-language-research.md` first.
1. Rewrite the two JSDoc tables to the column format and trim the bullets to
   reasons (Rules 1 to 4). No code change; the formulas already agree.
2. Write `scripts/lib/action-table.ts` (parse, expand) and
   `scripts/action-table.ts` (`check`, `print`). Add `check` to `pnpm lint`.
3. Replace `RUN_MATRIX` and `TASK_MATRIX` in the test with the parsed rows.
   Keep the outsider, closed-order and no-item tests as titled `it` cases.
4. Run `pnpm lint`, `pnpm test`, `pnpm fmt`.
5. Add one line to `AGENTS.md` under the JSDoc rule: an action matrix in
   JSDoc is the spec, the test reads it, and a change starts at the table.
6. Delete this file.

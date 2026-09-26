# Follow-ups from the action-table work

The one place for what is left after `docs/action-table-spec-research.md`
and `docs/action-table-spec-plan.md`. Those two are done and can be
deleted; nothing here depends on them.

## What landed (2026-09-26)

- The action matrices are the JSDoc on `runActions` and `taskActions` in
  `src/lib/Domain.ts`, one column per input. They are the spec.
- `scripts/lib/action-table.ts` parses them; `pnpm action-table check`
  runs under `pnpm lint` and refuses a malformed table, overlapping rows,
  and a glossary word that occurs nowhere else in the file.
- `test/integration/run-actions.test.ts` reads the tables from the source,
  asserts both functions on every row, and drives every `ShopAgent`
  callable into every row's state.
- The glossary's verbs table no longer says who may do each verb; the
  matrices do.

## Follow-ups, in order

### 1. Rename the broad `ready`

**Problem.** The glossary's task states are `waiting`, `ready`, `started`,
`done`, and `ready` means "its step is current, nobody has it". The code's
`ready` flag is broader: true for a started task too. Sites that carry the
broad meaning:

- `Domain.readyTasks`, the TypeScript readiness rule.
- `src/lib/readyWhere.ts`, the same rule as SQL.
- `Domain.RunTaskView.ready`, the field the work page and the gate read.
- `Domain.holdsReadyTask`, the "m" of `runActions`.
- The run-list and parallel-step JSDoc in `RunRepository.ts`,
  `OrderRepository.ts`, `ShopAgent.ts`, `RunSteps.tsx` and
  `app.orders.$orderId.tsx` that say "ready task" in the broad sense.

The Block, Unblock, Edit reason and note JSDoc already say "ready or
started task", so those are done.

**Decision to make.** One word for "its step is current", whether or not
someone has it. `current` was floated. Then:

- Rename the flag and the functions (`currentTasks`, `currentWhere`,
  `RunTaskView.current`, `holdsCurrentTask`, or whatever the word is).
- Sweep the "ready task" prose in the files above to the new word where it
  means the broad sense; leave it where it means the glossary's narrow one
  (Start is on a ready task).
- In `scripts/lib/action-table.ts`, `expand` maps the `ready` and
  `started` words onto the new flag plus `startedAt`; the table words do
  not change.
- The "m" paragraph on `runActions` says "a current task on the run".
- Update the glossary's task-states table in the same change: the
  "derived from" column names the new flag.

**Do it with the UI pass.** The task badge says "In progress" where the
glossary says "Started" (`RunSteps.tsx`, `runTabs.ts`, the three route
files). One rename touching the same screens is less churn than two.

### 2. Decide what to do with the other rule tables

`RunStatus`'s gate table and `runIsBlocked`'s table in `Domain.ts` are a
different kind of table: one row per action naming the predicate that
gates it, not a truth value per state. The parser cannot assert them as
they are, which is why the research (Decision 6) left them out.

**Decision to make.** Either:

- Leave them as prose tables. They are the survey a reader wants on the
  status concept, and the action matrices already pin each cell they
  describe. Then say so in one sentence on each, so the next reader does
  not ask why the lint ignores them.
- Or turn one into a truth table the test can read. `RunStatus` is the
  candidate: columns `open`, `done`, `closed`, cells yes / no per action.
  That needs a third table shape in `TABLES` and a fixture per cell that
  is not an actor call (reconcile resizes, holds the slot, counts against
  the ceiling), so it is a different test, not a row in the existing one.

Recommendation: the first. The gate tables say which predicate, and the
matrices say the result; that is two different facts, not a duplicate.

### 3. Tighten the glossary check only if it lets a stale row through

Today `checkGlossary` asserts that every backticked identifier in the
Glossary block occurs somewhere else in `Domain.ts`. It does not check
that a literal such as `merchant_cancelled` is in the right
`Schema.Literals` or that a symbol is an export. That is enough for the
one failure seen so far (a rename that left the old word in the glossary).
Upgrade it when, and only when, a stale glossary row gets past it.

## Not follow-ups

Recorded so they are not reopened:

- `checkChangeWorkflow` in the callable walk accepts any of `ItemDone`,
  `OrderClosed`, `NothingToMake` on a blank cell rather than the one the
  fixture should produce. The cell is proved refused; which tag comes back
  is `merchantAttachWorkflow`'s own rule with its own tests.
- The outsider tests ("a member whose team holds no ready task...", "a task
  on none of the member's teams...") and the no-item test stay as hand
  tests. Membership is a second axis the table does not draw (research
  Rule 3).

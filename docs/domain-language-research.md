# Domain language from first principles

## Why this comes first

The action tables in `Domain.runActions` and `Domain.taskActions` are about
to become the spec a person edits and a test reads
(`docs/action-table-spec-research.md`). Every column header and cell word in
those tables is a domain term. If the terms are wrong, the tables are written
in the wrong words and the rename lands after the spec is agreed, which is
the wrong order. So the vocabulary gets settled first, on its own, and
everything after is written in it.

The current vocabulary grew in fits and starts and borrowed from Route to
Ship. Some of it is good (done versus closed, block as the one flag), some of
it is uneven (task states, the team-move verb, definition versus instance
names). Nothing here is precious. We are prototyping: schema changes are made
in line, every Durable Object and local database is reset, and no migration
is written. So column names, literal values and field names are all on the
table, not only prose.

## Where the vocabulary will live

`src/lib/Domain.ts` opens with a module JSDoc that states the rules policy
(one owner per rule, predicates not literals). Below it, a second block holds
the **glossary**: nouns, states and verbs as tables, one row per term, with
the word, what it means to a person, the symbol that is it, and the screen
label. That is the artifact a human and an LLM reason at. It is in every
`Domain.ts` diff, and `AGENTS.md` points at it for "use these words".

It is not a model description. Rule prose stays on the symbols it governs.
The glossary only fixes words.

Kept honest by the same `check` command the action tables get: every symbol
the glossary names must exist as an export of `Domain.ts`, and every literal
value it lists must match the `Schema.Literals` in code. A rename that skips
the glossary fails `pnpm lint`.

## What Baton is, in one paragraph

A merchant sells made-to-order items. Each item on an order has to be made
by the shop's own people before it can be fulfilled. Baton takes the order
from Shopify, decides how each item gets made (a **workflow**: an ordered
list of steps, each done by a team), and gives the people at the bench a
list of what to do next. When the bench finishes, the merchant fulfils in
Shopify and Baton steps out of the way. Shopify owns the order; Baton owns
the making.

## The nouns

| noun      | what it is                                                               | today                                          |
| --------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| shop      | one Shopify store, one tenant                                            | `ShopAgent`, `shop`                            |
| merchant  | the person who owns the shop and uses the Shopify admin                  | `merchant` (`ConnectionRole`), `MERCHANT`      |
| member    | a person at the bench, signed in to the member app, on one or more teams | `member`, `Member`                             |
| team      | a group of members that does a kind of work                              | `Team`                                         |
| order     | a Shopify order, mirrored                                                | `ShopOrder`                                    |
| line item | one product on an order, with a quantity                                 | `OrderLineItem`; "item" in prose and on screen |
| workflow  | a definition: the ordered steps an item goes through                     | `Workflow`                                     |
| step      | one position in a workflow; may hold several tasks done in parallel      | `step`, a number on the task                   |
| task      | one unit of work in a step, assigned to a team                           | `WorkflowTask` (definition)                    |
| run       | one line item's trip through one workflow                                | `WorkflowRun`; "run" on screen                 |
| run task  | one task of a run, the thing a member starts and finishes                | `WorkflowRunTask`, `RunTaskView`               |
| block     | a person's hold on a run, with an optional reason                        | `blockedAt`, `blockedBy`, `blockReason`        |
| note      | free text on a run                                                       | `note`                                         |

Observations:

- **Step and task are both real.** A step is the position, a task is the
  work at that position. "Step 2 of 3 · Engrave crest": step is the number,
  task is the name. Keep both.
- **Definition versus instance.** `Workflow` / `WorkflowRun` is a good pair:
  different words for different things. `WorkflowTask` / `WorkflowRunTask`
  reuses "task" for both, so "task ready" can be misread as a property of
  the definition. Acceptable, but see Q1.
- **"Item"** is used loosely for the line item. Fine as long as it never
  means the product.
- **Block** is already consistent: Block, Blocked, Unblock, block reason.
  Keep.
- **Merchant** is one person in the model but in reality any staff account
  with app access. The word stays; it names the role, not the person.

## The states

### Run

Stored `status`: `pending`, `active`, `done`, `closed`. Plus `blockedAt`
(the flag) and `closedReason` (on a closed run). `pending`, `active` and
`done` are recomputed from the tasks on every task write
(`recomputeStatus` in `WorkflowRunRepository`); `closed` is written. On
screen: the member sees "In progress", "Blocked", "Done", "Closed ·
<reason>"; the merchant's order page has a run badge per status,
`RUN_STATUS_BADGE`: "Not started", "In progress", "Done", "Closed".

- `pending` and `active` never differ in any action cell; the action tables
  call both "open". `pending` has two readers: reconcile's resize
  (`runIsUnstarted`, to resize without the quantity badge) and the merchant's
  "Not started" badge. The JSDoc also calls it "unstarted". Four words
  (pending, unstarted, Not started, open) for one value.
- `active` is set on the first Start or Done. Both screens say "In
  progress". The tables say "open". None of the three words is on screen
  and in code at once.
- `done` versus `closed`, a person finished it versus something else ended
  it, is the clearest part of the model. Keep.

### Run task

Not stored as a status. Derived from `startedAt`, `completedAt`, and
`ready` (computed from the run's other tasks by `readyTasks`). Spec prose
today uses "ready", "started", "waiting", "completed", "any open". On
screen (`RunSteps.tsx`, the one task card both the member's work page and
the merchant's drawer draw): "Ready", "In progress", "Done", and nothing for
a task whose step is not current.

- Four real states, five prose words, and screen labels that differ from
  both. "completed" in prose is "Done" on screen; "started" in prose is "In
  progress" on screen, the same word the run badge uses one card up, so a
  merchant reads "In progress" twice for two different facts; "waiting" has
  no screen word.
- "ready" is overloaded: it is a state (its step is current) and a modifier
  (a started task is still ready). The tables need it to be one thing.

### Order

Shopify's facts (`cancelledAt`, `fulfillmentStatus`, `fullyPaid`) and two
derived views: `orderIsOpen` for gating and `ProductionState` for the index
ladder (To make · Making · Made · Fulfilled, and Cancelled). "open" in the
action tables is `orderIsOpen`. These are fine; the ladder was settled
recently and uses Shopify's words where Shopify owns the fact.

### Actor

`merchant` or `member`; "M" and "m" in the tables. A member is further
qualified by team membership, which the tables leave to prose.

## The verbs

| field            | member screen | merchant screen        | what it does                         | storage it touches                                   |
| ---------------- | ------------- | ---------------------- | ------------------------------------ | ---------------------------------------------------- |
| `start`          | Start         | none                   | claims a ready task                  | `startedAt`, `startedBy*`                            |
| `done`           | Done          | Done                   | finishes a task                      | `completedAt`, `completedBy*`                        |
| `putBack`        | Put back      | Put back               | unclaims a started task              | clears `started*`                                    |
| `reopen`         | Undo          | Reopen                 | unfinishes a done task               | clears `started*` and `completed*`, sets `reopened*` |
| `reassign`       | none          | Assign team / Reassign | moves a task to another team         | `teamId`, `teamName`                                 |
| `note`           | Edit note     | Edit note              | writes the run note                  | `note`                                               |
| `block`          | Block         | Block                  | holds the run                        | `blockedAt`, `blockedBy`, `blockReason`              |
| `editReason`     | Edit reason   | Edit reason            | changes the hold's reason            | `blockReason`                                        |
| `unblock`        | Unblock       | Unblock                | lifts the hold                       | clears `block*`                                      |
| `cancel`         | none          | Cancel run             | closes the run, `merchant_cancelled` | `status`, `closedAt`, `closedReason`                 |
| `changeWorkflow` | none          | Change workflow        | replaces the run with a fresh one    | deletes and recreates the row                        |

Observations:

- **Done has two roots.** The verb is Done, the run status is `done`, the
  column is `completedAt`, the prose word is "completed". One concept, two
  words, and the column is the odd one out.
- **`reopen` has two screen names**, Undo (member) and Reopen (merchant).
  The code records this as deliberate: the member takes back their own Done,
  the merchant reopens someone's record. The storage slot is `reopened*`.
- **`reassign` is "Assign team" on four buttons and "Reassign" on one.** An
  unassigned task (its team was deleted) is assigned, not reassigned. One
  word is needed and "reassign" is wrong for half the cases.
- **`putBack`** has no slot of its own and needs none.
- **`reopen` clears the Start slot too**, so a reopened task reads Ready, not
  Started. The state table below says done → ready for that reason.

## Proposed glossary

This is the block as it would appear in `Domain.ts`, below the rules policy.
It is the thing to edit in review. Each row is the word we will use
everywhere: spec tables, JSDoc prose, field names, and, in a later pass,
screen labels.

### Nouns

| word     | meaning                                                  | symbol                          |
| -------- | -------------------------------------------------------- | ------------------------------- |
| merchant | the shop's owner, acting from the Shopify admin          | `Actor` role `merchant`         |
| member   | a person at the bench, on one or more teams              | `Actor` role `member`, `Member` |
| team     | the group a task is assigned to                          | `Team`                          |
| order    | a Shopify order                                          | `ShopOrder`                     |
| item     | one line item of an order                                | `OrderLineItem`                 |
| workflow | the definition: steps of tasks                           | `Workflow`, `WorkflowTask`      |
| step     | a position in a workflow; its tasks are done in parallel | `step`                          |
| run      | one item going through one workflow                      | `Run`                           |
| task     | one unit of work on a run, on one team                   | `RunTask`                       |
| block    | a person's hold on a run                                 | `runIsBlocked`                  |
| note     | free text on a run                                       | `RunNote`                       |

### Run states

| word    | meaning                                           | stored          | screen                                                  |
| ------- | ------------------------------------------------- | --------------- | ------------------------------------------------------- |
| open    | work can be recorded                              | `active`        | In progress (merchant: Not started until a task starts) |
| blocked | open, and a person holds it                       | `blockedAt` set | Blocked                                                 |
| done    | a person finished the last task                   | `done`          | Done                                                    |
| closed  | something else ended it; `closedReason` says what | `closed`        | Closed · <reason>                                       |

### Task states

| word    | meaning                            | derived from            | screen                       |
| ------- | ---------------------------------- | ----------------------- | ---------------------------- |
| waiting | its step is not current            | not ready               | (none)                       |
| ready   | its step is current, nobody has it | ready, `startedAt` null | Ready                        |
| started | a person has it                    | ready, `startedAt` set  | Started (today: In progress) |
| done    | finished                           | `doneAt` set            | Done                         |

### Verbs

| word            | on a | who | effect                              |
| --------------- | ---- | --- | ----------------------------------- |
| start           | task | m   | ready → started                     |
| done            | task | M m | ready or started → done             |
| put back        | task | M m | started → ready                     |
| reopen          | task | M m | done → ready                        |
| assign          | task | M   | moves it to a team                  |
| note            | run  | M m | writes the note                     |
| block           | run  | M m | open → blocked                      |
| edit reason     | run  | M m | changes the block's reason          |
| unblock         | run  | M m | blocked → open                      |
| cancel          | run  | M   | open → closed, `merchant_cancelled` |
| change workflow | item | M   | replaces the run                    |

## Changes the glossary implies

Storage renames are free now, so the list includes them.

| change                                                                                                                                               | kind                      | reason                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `completedAt` / `completedBy*` → `doneAt` / `doneBy*`                                                                                                | column, field             | one root for Done; `completedBy` and status `done` disagree today                                                      |
| `taskCompletedBy` → `taskDoneBy`                                                                                                                     | function                  | follows the column                                                                                                     |
| `reassign` → `assign`; button "Assign team" only                                                                                                     | field, label              | covers unassigned and move; "reassign" is wrong for the first                                                          |
| `AssignRunTaskTeam*` keep                                                                                                                            | none                      | already the right word                                                                                                 |
| drop `pending`; `status` is `active`, `done`, `closed`                                                                                               | literal, column           | never changes a button; reconcile's "nobody worked yet" test becomes "no task started or done", which is what it means |
| `runIsUnstarted` → derived from tasks                                                                                                                | function                  | see previous row; the merchant's "Not started" badge reads it too, so the badge survives                               |
| task badge "In progress" → "Started"                                                                                                                 | label (later)             | "In progress" is the run's word; a task and its run must not share it                                                  |
| task state words in JSDoc: waiting, ready, started, done                                                                                             | prose                     | one word per state; "completed" goes                                                                                   |
| keep Undo (member) / Reopen (merchant)                                                                                                               | none                      | recorded once on `reopen`; see Q3                                                                                      |
| `WorkflowRun` → `Run`, `WorkflowRunTask` → `RunTask`, ids, table names, `WorkflowRunRepository` → `RunRepository`, `WorkflowRunDetail` → `RunDetail` | type, column, table, file | the type that is the concept carries the glossary word; see Q1                                                         |
| glossary block in `Domain.ts`                                                                                                                        | new                       | the artifact                                                                                                           |
| `check` asserts glossary symbols and literals exist                                                                                                  | script                    | keeps it from going stale                                                                                              |

Not changing: `Workflow` / `WorkflowTask` (the definition pair), `blocked*` columns, `closedReason` values, `ProductionState`
and `OrderNeed` (settled recently, Shopify's words where Shopify owns the
fact), `ConnectionRole`.

## Decisions

Settled in review on 2026-09-25. No open questions remain. The
implementation plan is `docs/domain-language-plan.md`.

- **Rename `WorkflowRun` to `Run` and `WorkflowRunTask` to `RunTask`**, with
  `WorkflowRunId` → `RunId`, `WorkflowRunTaskId` → `RunTaskId`,
  `WorkflowRunDetail` → `RunDetail`, the two SQLite tables, and
  `WorkflowRunRepository` → `RunRepository` (file renamed to match). The
  reasons, from first principles: `Domain.ts` already exports thirty-six
  symbols prefixed `Run` or `run` and five prefixed `WorkflowRun`, so the
  struct that is the concept was the odd one out; the two pairs
  (`Workflow` / `WorkflowTask`, `Run` / `RunTask`) now differ in their first
  word, where `WorkflowTask` / `WorkflowRunTask` differed by one inner word;
  "a run is one item's trip through a workflow" names the thing the bench
  works on, and `Run` is that word; nothing else in `src/` is called `Run`,
  `RunTask`, `RunId` or `RunTaskId`.

- **Drop `pending`.** `status` is `active`, `done`, `closed`.
  `runIsUnstarted` reads the tasks, and the merchant's "Not started" badge
  reads it.
- **Keep Undo (member) and Reopen (merchant)** as two screen words for one
  verb, recorded once on `reopen`.
- **Rename `completedAt` / `completedBy*` to `doneAt` / `doneBy*`**, and
  `taskCompletedBy` to `taskDoneBy`.
- **The glossary carries screen labels** as the target, even where the page
  still says something else.
- **`active` stays the stored value under "open".** No `open` literal.
- **Task badge "In progress" becomes "Started"** in the UI pass. "In
  progress" is the run's word.

## Rollout

1. Questions settled (see Decisions).
2. Write the glossary block into `Domain.ts` in the final words.
3. Apply the storage and field renames in one change: schema in
   `ShopAgent.ts`, `Domain.ts` structs and functions, repositories, routes,
   seed, tests. Reset local state.
4. Rewrite JSDoc prose in `Domain.ts` and the repositories to the glossary
   words where it uses old ones.
5. Add the glossary check to the `check` command when that script is
   written in the action-table work; until then, `pnpm typecheck` catches
   every rename.
6. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`.
7. Add one line to `AGENTS.md`: the glossary in `Domain.ts` is the
   vocabulary; use its words in code, JSDoc and research.
8. Resume `docs/action-table-spec-research.md`.
9. Delete this file.

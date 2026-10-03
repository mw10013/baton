# How to store a workflow's tasks and its draft

Written 2026-10-03. The question: a workflow definition and its draft are the same kind of thing,
a list of tasks in steps, and today they live in two pairs of tables (`Workflow` / `WorkflowTask`
and `WorkflowDraft` / `WorkflowDraftTask`). Is that the right shape, from first principles, for a
codebase that wants to be simple to write and hard to get wrong? Refactoring cost is not a factor:
we are prototyping and can reset every store. Runs are out of scope except where the definition
feeds them.

Recommendation, short form: store each task list as one JSON column on the `Workflow` row,
`tasks` for what is in force and `draftTasks` for the draft, and drop all four task tables. The
rest of this doc is the argument, the alternatives, and the questions.

## What exists today

Four tables in the Durable Object (`initializeSchema`, `src/lib/ShopAgentSchema.ts`):

| table               | key                                   | holds                                               |
| ------------------- | ------------------------------------- | --------------------------------------------------- |
| `Workflow`          | `id`                                  | name, tag, `state` (on / off), `updatedAt`          |
| `WorkflowTask`      | `id`; unique `(workflowId, position)` | position, step, name, teamId, instructions          |
| `WorkflowDraft`     | `workflowId`                          | `updatedAt` only; its existence is "a draft exists" |
| `WorkflowDraftTask` | `id`; unique `(workflowId, position)` | the same columns as `WorkflowTask`                  |

The two task tables have the same shape, and the DDL comment gives the reason for two tables: "a
task-id write can never be ambiguous about its side, and unique (workflowId, position) holds on
each side independently."

How the verbs use them (`src/lib/WorkflowRepository.ts`):

- **Edit** is implicit. Opening the editor writes nothing. The first change calls `ensureDraft`,
  which inserts a `WorkflowDraft` row and copies every `WorkflowTask` into `WorkflowDraftTask`
  **under the same id**. So the id the editor sent for a workflow task names the draft's copy a
  moment later, and `requireEditableTask` looks in the draft first and the workflow second.
- **Every editor write** (`addStep`, `addTask`, `updateTask`, `moveTask`, `joinTask`,
  `separateTask`, `removeTask`) lands on `WorkflowDraftTask`. Layout edits read the draft's
  `(id, position, step)` rows, run a pure `WorkflowLayout` function over the whole list, and write
  the whole list back. Because of `unique (workflowId, position)`, `writeLayout` first parks every
  row at `-position`, then assigns final positions; `position` therefore has no `>= 1` check.
- **Apply** (`promoteDraft`) deletes the workflow's tasks, `insert ... select`s the draft's tasks
  into `WorkflowTask` with their ids, bumps `Workflow.updatedAt`, deletes the draft. Refuses no
  draft, an empty draft, an unassigned task.
- **Discard** deletes the `WorkflowDraft` row; the tasks cascade.
- **Run creation** reads `WorkflowTask` through `listOnWorkflowDetails` and copies into `RunTask`.
  Nothing on that path names a draft table.

Where two tables cost something today, every site that must remember there are two:

| site                                        | what it does twice                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `ensureDraft`                               | copies rows table to table, preserving ids                                 |
| `requireEditableTask`, `getTask`            | look in the draft table, then the workflow table                           |
| `promoteDraft`                              | delete, insert-select, delete                                              |
| `writeLayout`                               | parks at `-position` to get round the unique index                         |
| `listTeamWorkflows`, `listAllTeamWorkflows` | `union` over both task tables for the team page and the teams index        |
| `unassignTeam`                              | three updates (both task tables plus `RunTask`)                            |
| `teamIdsInUse`                              | `union` over three tables                                                  |
| `replaceWorkflows` (seed)                   | `writeTasks` parameterised by table name                                   |
| `getWorkflow`                               | four selects                                                               |
| the data-model table                        | two `draft` rows, one `step` row that says "the draft obeys the same rule" |

The DDL's stated reason has partly eroded: the ids **are** shared between the two tables (that is
the point of `ensureDraft`), so a task id is ambiguous about its side whenever a draft exists, and
`requireEditableTask` is the code that resolves it. The reason that still stands is the second one:
the position uniqueness is per side.

## First principles

**What a definition is.** A workflow's tasks are one value: an ordered list, grouped into steps,
that is only ever read whole and only ever written whole. Run creation copies the whole list. The
editor's every layout operation already reads the whole list, transforms it in `WorkflowLayout`,
and writes the whole list. The list is bounded, at most `WorkflowLimits.maxTasks` (20) tasks, and a
shop has at most `maxWorkflows` (50) workflows: a thousand tasks in the worst shop, a few hundred
kilobytes. Nothing queries tasks of a definition by anything but the workflow, except the team
pointer (next paragraph). A thing read whole, written whole, small and bounded, is a document, not
a set of rows.

**What a draft is.** The draft is a second value of the same type, attached to the workflow, that
exists from the first edit until Apply or Discard. Its one job is to let a merchant edit without
the definition in force changing underneath open orders, and to let them throw the edit away. The
vocabulary says "one or none". A second value of the same type that is one-or-none is a nullable
field, not a second entity.

**Who reads what.** Run creation reads the definition in force and must never see the draft. The
editor reads the draft when there is one and the definition otherwise, and writes the draft. The
workflow page reads both to show a Draft badge. The team page and the teams index ask "which
workflows use this team", counting drafts. A team delete nulls the pointer in both and in run
tasks. That is the whole list.

**What must stay true.** From the data-model table and the JSDoc on `Workflow`:

1. A run starting between two edits sees one whole definition. Apply is one transaction.
2. No history: what is replaced is gone.
3. No unsaved state anywhere: every edit is on the server at once.
4. Opening the editor writes nothing; the first change creates the draft.
5. A task keeps its id from the workflow into the draft and back, so the editor can edit a task it
   is looking at before any draft exists, and so the task it is editing is the same task after
   Apply.
6. Steps are dense from 1 and non-decreasing along position; a step has one or more tasks.
7. A team delete leaves every pointer null, in the definition, the draft and the runs.
8. Apply and Turn on refuse an empty definition and an unassigned task.

Rule 5 is the one that shapes the answer most. It is what forced the two tables to share ids, and
it is what every relational alternative struggles with.

**What the schema can hold and what it cannot.** Today's schema holds "at most one draft" (the
primary key on `WorkflowDraft`), "a task is in exactly one workflow", and "positions are unique per
side". It cannot hold "steps are dense from 1" or "a step has one or more tasks" (both `app`), and
the position uniqueness it does hold is the thing that makes `writeLayout` park rows. The strongest
form of a rule is not a constraint the database checks; it is a representation in which the
violation cannot be written. An array has no gaps in its indexes.

## Options

### A. Two table pairs (today)

Described above. Correct, tested, and every rule has a home. The cost is the table of sites above:
ten places that know about two tables, a shared-id convention that the schema cannot express, a
parking trick in `writeLayout`, and a fifth of the repository's lines spent moving rows between
tables that mean the same thing.

### B. One task table with a side column

`WorkflowTask (id, workflowId, side check (side in ('workflow', 'draft')), position, step, ...)`,
unique `(workflowId, side, position)`, with `WorkflowDraft` kept for existence or replaced by
`Workflow.draftUpdatedAt`.

This fails rule 5 or the primary key: the same id cannot be on both sides under `id text primary
key`. Either the key becomes `(id, side)` and every task write takes two keys, or the ids diverge
and the editor is handed new ids on first change. And it adds a hazard the two tables did not have:
every read of the definition in force must say `where side = 'workflow'`, and the one that forgets
feeds the draft to run creation. The two-table design made that mistake a compile-time one (a
different table name); B makes it a runtime one. B is the current design with its one real safety
removed. Rejected.

### C. Task sets with two pointers

```
Workflow (id, ..., tasksId references WorkflowTaskSet, draftId references WorkflowTaskSet)
WorkflowTaskSet (id, workflowId, updatedAt)
WorkflowTask (id, setId references WorkflowTaskSet on delete cascade, position, step, ...)
```

One task table, no side column. Apply: `draftId` becomes `tasksId`, the old set is deleted and its
tasks cascade. Discard: delete the draft set. Edit: copy the in-force set to a new set, point
`draftId` at it. Run creation joins through `tasksId` and cannot reach the draft by accident,
because the draft is a different set, not a different flag.

This is a clean relational answer and it is what a database person would draw. Its problems are
rule 5 and the vocabulary. Copying a set gives the copies new ids (same primary key problem as B),
so the editor's first change on a never-drafted workflow must either be two round trips (create the
draft, get the new ids, then edit) or return a task the client was not holding. And the word for a
`WorkflowTaskSet` row in ordinary speech is "version", which the JSDoc on `Workflow` lists as a
word Baton does not use, because a version table is a history table waiting to happen. It is also
still three tables, a cascade, two nullable pointers that must be kept consistent, and a parking
trick in `writeLayout` (the unique index moves to `(setId, position)` and the problem comes with
it). C is better than A and worse than D.

### D. One row, two JSON columns

```
create table if not exists Workflow (
  id text primary key,
  name text not null unique check (...),
  tag text not null unique check (...),
  state text not null check (state in ('on', 'off')),
  -- The definition in force: a JSON array of tasks in position order, each
  -- {id, step, name, teamId, instructions}. What run creation copies.
  tasks text not null default '[]',
  -- The draft: null when there is none; the same shape otherwise.
  draftTasks text,
  updatedAt integer not null
);
```

`WorkflowTask`, `WorkflowDraft`, `WorkflowDraftTask` and their indexes go. The verbs:

| verb             | SQL                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| first edit       | `update Workflow set draftTasks = tasks where id = ? and draftTasks is null`, then the edit                                                            |
| any editor write | read `draftTasks`, decode, transform with `WorkflowLayout`, encode, `update Workflow set draftTasks = ?`                                               |
| Apply            | `update Workflow set tasks = draftTasks, draftTasks = null, updatedAt = ? where id = ?`                                                                |
| Discard          | `update Workflow set draftTasks = null, updatedAt = ? where id = ?`                                                                                    |
| run creation     | `select * from Workflow where state = 'on'`; decode `tasks`                                                                                            |
| team "Used by"   | `select id, name from Workflow where exists (select 1 from json_each(tasks) where json_extract(value, '$.teamId') = ?) or exists (... draftTasks ...)` |
| team delete      | read every workflow, null the pointer in both arrays in code, write back; or `json_set` per row                                                        |
| seed             | one insert per workflow                                                                                                                                |

What each rule becomes:

1. One transaction: Apply is one statement. Trivially atomic.
2. No history: the old `tasks` value is overwritten.
3. No unsaved state: unchanged.
4. Opening writes nothing: unchanged. The first change is `coalesce(draftTasks, tasks)`.
5. Task ids carry across: free. The id is a string inside the document, so the copy on first edit
   and the carry-over on Apply preserve it with no convention to remember and no shared-key trick.
6. Dense steps, one or more tasks per step: `position` disappears from storage. The array index is
   the position, and it cannot have a gap. `step` stays, and `WorkflowLayout.normalize` already
   makes it dense on every write; the Effect `Schema` for the array checks it on every read and
   write, so a bad document cannot enter. The `writeLayout` parking trick and the missing
   `position >= 1` check both disappear, because there is no unique index to collide with.
7. Team delete: one loop over at most 50 rows in one transaction, plus the `RunTask` update. The
   same code nulls both arrays, so the two cannot drift.
8. Apply refusals: unchanged; they are already computed in code from the decoded list.

What it costs:

- **Rules move from `schema` to `app`.** Today's `schema` rows for the draft ("at most one draft;
  the draft holds tasks only") become `app`, or vanish because the representation makes them
  meaningless (a nullable column is at most one by nature). The `step >= 1` and non-empty `name`
  checks move into the `Schema` decoder. The data-model table's discipline is intact: the rows say
  `app` and name the test through the write path. This is the trade the doc asks you to weigh: a
  constraint the database checks versus a representation that has nothing to check.
- **SQL cannot see into a task without `json_each`.** The only queries that look inside are the
  team ones, and `json_each` is already the pattern in `OrderRepository` for product tags. With
  twenty tasks and fifty workflows there is nothing to index.
- **A document column is opaque in the console.** `select * from Workflow` shows JSON. Today it
  shows JSON for `productTags`, `properties` and `blockedBy` too, so the pattern is established.
- **Size.** A Durable Object row is capped at 2 MB (`refs/cloudflare-docs`, Durable Objects
  limits). Twenty tasks with the longest allowed instructions are well under a hundred kilobytes.

What else simplifies: `WorkflowDraftTask`, `WorkflowDraftTasks`, `WorkflowWithDraft`,
`WorkflowDraftDetail` and the `draft.draft` nesting in `WorkflowPageData` collapse to `tasks` and
`draftTasks: Array | null` on one shape. `ensureDraft`, `requireEditableTask`, `insertDraftTaskRow`,
`writeLayout`, `layoutOf`, `relayout`, `insertTask` and `promoteDraft` become a single
`editDraft(workflowId, f: (tasks) => tasks)` helper and a handful of one-statement updates. The
repository shrinks by roughly half. `WorkflowLayout` is unchanged; it was already written for this.

### E. D, with the draft derived instead of stored

Same two columns, but the editor always writes `tasks` and Apply snapshots it into `appliedTasks`
(null until the first Apply). Run creation reads `appliedTasks`. "A draft exists" is derived:
`tasks` differs from `appliedTasks`. Discard is `tasks = coalesce(appliedTasks, '[]')`.

Fewer states than D (there is no "draft exists but equals the definition", and an edit undone by
hand makes the Draft badge go away, which is right), and nothing to keep in step. Against it: it
changes the vocabulary row for draft from "the workflow's edited copy, from Edit until Apply or
Discard" to "the tasks, when they differ from what is applied"; the Draft badge needs a structural
comparison of two decoded arrays on every workflow page read; and the column the editor writes is
no longer called draft, which puts the hazard of B back in a smaller form: the hot path must read
`appliedTasks`, and `tasks` is the attractive wrong name. D keeps today's words exactly. E is
offered as a question, not the recommendation.

## Comparison

| property                                   | A today             | B side column       | C task sets            | D two JSON columns         | E derived draft      |
| ------------------------------------------ | ------------------- | ------------------- | ---------------------- | -------------------------- | -------------------- |
| tables for definitions                     | 4                   | 3                   | 3                      | 1                          | 1                    |
| task id stable across Edit and Apply       | by convention       | no, or compound key | no                     | by construction            | by construction      |
| run creation can read the draft by mistake | different table     | forgotten `where`   | different set          | different column           | different column     |
| dense steps held by                        | app                 | app                 | app                    | representation + app       | representation + app |
| at most one draft held by                  | schema              | schema              | schema                 | representation             | representation       |
| Apply                                      | 3 statements        | 3 statements        | 2 statements + cascade | 1 statement                | 1 statement          |
| layout write                               | park, then renumber | same                | same                   | encode array               | encode array         |
| sites that know about two sides            | 10                  | every query         | 2 pointers             | 2 columns, named           | 2 columns, named     |
| team "Used by" query                       | union of 2          | 1 table             | 1 table via join       | `json_each` over 2 columns | same as D            |
| console readability                        | rows                | rows                | rows                   | JSON                       | JSON                 |

## Recommendation

**D.** Store `tasks` and `draftTasks` as JSON on the `Workflow` row, drop the four task tables,
keep `RunTask` as rows. Reasons, in order of weight:

1. It matches what the thing is. A definition is read whole, written whole, bounded and small; the
   editor already treats it as a whole value through `WorkflowLayout`. The tables were a projection
   of a document into rows, and every one of the ten sites above is the cost of projecting it back.
2. It makes rule 5 free. The id-sharing convention, the two-table lookup and the carry-over on
   Apply were all the price of giving a task one identity across two tables. Inside one document
   that identity needs no code.
3. It turns the hardest `app` rule into a non-rule. Positions cannot have gaps in an array. The
   parking trick, the missing check, and the "the draft obeys the same rule at every write" clause
   go away because there is nothing to obey.
4. It keeps the vocabulary. "draft: one or none" is `draftTasks is null`. Every verb row in the
   vocabulary stays as written. The only word that changes meaning is `position`, which stops being
   stored and becomes the array index, so the `step` noun row's symbol cell changes.
5. It is the established pattern. `productTags`, `properties` and `blockedBy` are already JSON
   columns read through `Schema` and queried with `json_each`.

Keep `RunTask` as rows. A run task is acted on singly, has its own state columns and consistency
checks, and the member's workflows list filters it by team through `RunTask_teamId_idx` across
every open run in the shop. That is row-shaped work; a definition is not. The asymmetry is the
point: the definition is copied into rows at the moment it becomes work.

What the change touches, for scale, not for cost:

- `initializeSchema`: the `Workflow` DDL and the data-model rows about `step`, `draft` and the
  team pointer; the `holds by` cells move to `app`; new tests through the write path for each.
- `Domain.WorkflowTask` loses `position` (or keeps it as a derived field the decoder fills from the
  index, if the screens want it; the screens use `stepsOf`, which sorts by step then position, so
  the array order is enough). `WorkflowDraftTask`, `WorkflowDraftTasks`, `WorkflowWithDraft`,
  `WorkflowDraftDetail` go; `WorkflowDraft` becomes the pair `draftTasks`, `draftUpdatedAt` or goes
  (question 2).
- `WorkflowRepository`: the editor writes become one helper; `getWorkflow`, `listOnWorkflowDetails`,
  `listTeamWorkflows`, `listAllTeamWorkflows`, `unassignTeam`, `teamIdsInUse`, `replaceWorkflows`,
  `duplicateWorkflow` each lose a table.
- `RunRepository`: the copy into `RunTask` reads the decoded array; position is the index plus one.
- `pnpm spec check`: the `stored` cells and the data-model parser need no new feature; the rows
  change. `scripts/rules-lint.ts` is unaffected.
- Seed fixtures: already arrays; the `step` defaulting stays in code.

## Questions

1. **D or E?** D keeps the draft as a stored, explicit thing with today's words. E makes it derived
   from a comparison and removes a state, at the cost of renaming the column the editor writes and
   comparing two arrays on every workflow page read. I recommend D. Do you want E instead?
2. **One date or two?** Today `Workflow.updatedAt` moves on Apply, rename, retag and Discard, and
   `WorkflowDraft.updatedAt` moves on every draft edit; the workflow editor shows the draft's date
   while one exists and the workflow page shows the workflow's. With D, either keep both as
   `updatedAt` and `draftUpdatedAt` (set and cleared with `draftTasks`, one more set-together pair),
   or keep one `updatedAt` that every write moves, and both screens show it. I recommend one date:
   the pair exists only to make the workflow page not show a draft edit, and it is not clear a
   merchant wants that distinction.
3. **Store `position` or not?** The array index is the position. Storing it too gives a
   `WorkflowTask` shape identical to today's and to `RunTask`'s, at the cost of a redundant field
   the decoder must check against the index. I recommend not storing it: the decoder fills it in
   from the index when the shape needs it, so `stepsOf` and the screens see the same field they do
   today, and nothing can disagree.
4. **Where does the team pointer repair live?** Today `unassignTeam` is three SQL updates. With D
   it is a read-modify-write over every workflow row (at most 50) plus the `RunTask` update, in one
   transaction; or `json_set` through `json_each`, which is harder to read. I recommend the
   read-modify-write in code, because the same decoded `Schema` does the nulling and the writing,
   and the SQL form would be the one place that edits a task without going through it.
5. **Should the `Schema` for a task list enforce the step rule on read as well as write?** On write
   it must. On read, a check costs little at this size and turns a corrupt row into a typed decode
   error at the repository instead of a wrong screen. I recommend both, which is what the other JSON
   columns do.
6. **Anything about the draft the editor needs that this loses?** The editor today receives
   `draft.tasks` with team names joined and `draft.draft.updatedAt`. Under D it receives
   `draftTasks` with the same join and the one date. I see nothing else it reads from the draft row.
   If you know of a planned use for a draft-level fact beyond its tasks and date (a note, an author,
   a lock), say so, because that would argue for keeping a small `WorkflowDraft` row after all.

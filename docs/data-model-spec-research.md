# A data-model spec on the schema: what it says, how it reads, what keeps it true

## What was asked

The JSDoc on `initializeSchema` in `src/lib/ShopAgent.ts` is about 130 lines
of prose over 12 tables. You want a lightweight spec in its place: not a
column list, but the constraints and invariants of the data model that the
rest of the codebase has to honour, written in English a person can read
and hold in their head, so that

- you can say what the data model must do without reading the DDL;
- the implementing LLM fills in the columns, types and indexes;
- when code and spec disagree there is something to adjudicate against,
  because today the implementation is the only truth and a bug has no
  definition.

Two examples you gave: an item has at most one run, ever, with no cancelled
runs kept beside a live one; and a workflow has exactly one definition and
at most one draft.

## What is already there

The invariants exist, but they are spread over three places and stated as
narrative in each:

| invariant                            | said in                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| one run per item, over every status  | schema JSDoc ("`lineItemId` is `unique`: one row per item"), `RunStatus` table ("holds the item's slot"), `RunRepository.setRun` JSDoc, and the test `RunRepository one row per item` |
| at most one draft per workflow       | schema JSDoc, `Domain.WorkflowDraft` JSDoc                                                                                                                                            |
| a run snapshots and never references | schema JSDoc, `Domain.Workflow` vocabulary block ("runs copy it wholesale and never look back at it"), `RunStatus`                                                                    |
| no definition history                | schema JSDoc twice, `Domain.Workflow` ("delete a workflow and its runs stay")                                                                                                         |
| status derived from tasks, stored    | schema JSDoc, `RunStatus` JSDoc                                                                                                                                                       |

So the problem is not missing rules. It is that the rules are sentences
inside paragraphs about indexes and reserved words, and that no one of the
three places is the one you edit. The same shape as the action-matrix
problem before `runActions` got its table: the rule was known, stated in
several places, and nothing said which statement was normative.

The schema JSDoc mixes four kinds of text, and only one of them is spec:

1. **Structural rules of the data model.** Cardinality, identity, what
   cascades and what survives, what is a snapshot and what is a live
   pointer, what history is kept. About 20 sentences. This is the spec.
2. **Behavioural rules.** When `activatedAt` moves, which status reconcile
   resizes, what a `done` run permits. These already live on the `Domain`
   concept symbols (`RunStatus`, `Workflow`, `runActions`) per the AGENTS.md
   rule, and the schema doc repeats them.
3. **SQL rationale.** Why `ShopOrder` not `Order`, why ids are `text`, why
   `(processedAt desc, id desc)`, why two task tables instead of a flag.
   Worth keeping, but it explains the DDL and belongs next to it.
4. **Subsystem plumbing.** The `UsageEvent` outbox protocol, `ShopUsage`
   cycle seeding. This is behaviour of the billing code and belongs on
   those functions.

## Prior art for structured English

Three traditions write data-model constraints as controlled English, and
they agree on the vocabulary:

- **Object-Role Modeling verbalization** (Halpin). Every fact type and
  constraint reads back as a sentence: "Each Workflow has at most one
  Draft." "Each Item is worked by at most one Run." It was designed so a
  domain expert could validate a model without reading a diagram.
- **SBVR / RuleSpeak** (the OMG business-rules standard). A small keyword
  set carries the logic: _each_, _exactly one_, _at most one_, _at least
  one_, _must_, _never_, _only if_. The rest of the sentence is domain
  words. SBVR itself is heavy; the keyword discipline is the useful part.
- **Alloy** multiplicities: `one`, `lone`, `some`, `set`. Same four
  cardinalities as ORM, one word each, plus the idea that a spec is a
  handful of signatures and facts, not a schema.

What they share: a fixed set of cardinality words, a fixed set of
relationship verbs, and domain nouns from a glossary. That is exactly the
shape this codebase already uses for the glossary and the action matrices,
so the data-model spec can be the third table of the same kind.

## The format: one table, one row per rule

A rule is one sentence in the glossary's words, using a small controlled
vocabulary, with two columns beside it that say how it is enforced and
which test pins it.

```
| about    | rule                                                              | holds by   | pinned by                                             |
| -------- | ----------------------------------------------------------------- | ---------- | ----------------------------------------------------- |
| item     | an item has at most one run, over every status                    | schema     | the unique index itself refuses a second row for an item |
| workflow | a workflow has at most one draft                                  | schema     | (none yet)                                            |
| run      | a run snapshots its workflow, order and item; it references none  | schema+app | a run survives a workflow delete                      |
```

The columns:

- **about**: the glossary noun the rule is about. Order, item, workflow,
  draft, task, run, or a singleton. Rows group by it.
- **rule**: one sentence, present tense, using the vocabulary below. It
  says what is true, never which column or index makes it true.
- **holds by**: `schema` (a constraint the database refuses), `app` (a
  write path or transaction), or `schema+app`. This column is a fact the
  implementer fills in, not a decision the author makes; see question 4.
- **pinned by**: the title of the test that asserts the rule, verbatim, or
  `(none yet)`. A test title is the one form of spec that cannot go stale
  silently, and the codebase already writes titles as rules.

The controlled vocabulary, chosen so the same fact is always said the same
way:

| kind        | words                                                          | meaning                                                                           |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| cardinality | exactly one, at most one, one or more, zero or more            | ORM / Alloy multiplicities in plain English                                       |
| identity    | is identified by                                               | the natural key; a surrogate id is assumed and not mentioned                      |
| reference   | snapshots, points to, references none                          | copy at write and never re-read; live pointer that follows renames; no key at all |
| cross-store | points to a D1 row; dangling reads as null                     | a pointer no foreign key can enforce, and what a dangling one means               |
| lifetime    | goes with, survives, only X deletes                            | cascades on delete; is not cascaded; the exhaustive list of deleters              |
| history     | no history, latest only, one row per event                     | overwritten in place; last occurrence kept; append-only log                       |
| derivation  | stored never derived, derived and stored, derived never stored | where the truth lives                                                             |
| consistency | set together, cleared together, implies                        | columns that move as one; a state that requires another                           |
| singleton   | exactly one row                                                | the `check (id = 1)` tables                                                       |

A rule that needs a word outside this table is either two rules or a
behavioural rule that belongs on a `Domain` symbol.

## The spec, drafted from the current schema

This is what the table looks like for the schema as it stands. Drafting it
is the test of the format: if the invariants you care about fit in about
twenty rows, the format is lightweight enough. Rows marked `?` are places
where the current schema's behaviour is stated in the JSDoc but no test pins
it, or where the JSDoc is silent.

| about     | rule                                                                                                                                                    | holds by   | pinned by                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| order     | an order is Shopify's record, mirrored; each sync overwrites it whole except `countedAt` and the items' `matchedWorkflowIds`                            | app        | ?                                                                                               |
| order     | an order is billed at most once, on its first run                                                                                                       | app        | ?                                                                                               |
| order     | an order older than retention is deleted; its items go with it; its runs survive                                                                        | schema+app | ?                                                                                               |
| item      | an item has exactly one order and goes with it                                                                                                          | schema     | ?                                                                                               |
| item      | an item has at most one run, over every status; a closed run holds the slot until a person replaces it                                                  | schema     | the unique index itself refuses a second row for an item, and a closed run still holds the slot |
| workflow  | a workflow is identified by its tag; no two workflows share one; the name is a label two may share                                                      | schema     | ?                                                                                               |
| workflow  | a workflow has zero or more steps in order; a step has one or more tasks, done in parallel; a task is in exactly one step                               | app        | ?                                                                                               |
| workflow  | a workflow has at most one draft; the draft holds tasks only                                                                                            | schema     | ?                                                                                               |
| workflow  | definition tasks change only by Apply, whole, in one transaction; a run starting between two edits sees one definition                                  | app        | ?                                                                                               |
| workflow  | no history: a delete removes the workflow, its tasks and its draft, and nothing else                                                                    | schema+app | deleteWorkflow cascades its draft and tasks                                                     |
| workflow  | `activatedAt` is stored, never derived, and is both the switch and the coverage date                                                                    | app        | skips orders placed before the workflow was turned on; manual attach still works                |
| task      | a task's team points to a D1 row; dangling reads as null, which means unassigned                                                                        | app        | ?                                                                                               |
| run       | a run snapshots its workflow, order and item and references none of them; it survives their delete and edit                                             | schema+app | is idempotent, and a closed item starts nothing on reconcile (partial)                          |
| run       | a run's tasks go with it; only deleting the run deletes tasks                                                                                           | schema     | ?                                                                                               |
| run       | a run's tasks and steps are a snapshot of the definition's at creation                                                                                  | app        | creates one run per matching item with copied tasks and team names                              |
| task      | a run task's team is both: it points to the team (a D1 row, deletable while the run is open) and snapshots the team's name for history                  | app        | ?                                                                                               |
| run       | `status` is derived from the tasks and stored, recomputed by every task write in the same transaction; `closed` is the exception, written never derived | app        | ?                                                                                               |
| run       | `closedAt` and `closedReason` are set together, once; nothing leaves closed                                                                             | app        | cancelRun closes with merchant_cancelled and keeps the tasks (partial)                          |
| run       | only an open run can be blocked; a run that is done or closed carries no block                                                                          | app        | ?                                                                                               |
| run       | who did what is a snapshot (`*ByEmail`, `teamName`); history never resolves through `Member` or `Team`                                                  | app        | ?                                                                                               |
| run       | reopen is latest only; a later Done clears it                                                                                                           | app        | ?                                                                                               |
| task      | a team delete nulls the team on open run tasks and leaves done ones alone                                                                               | app        | ?                                                                                               |
| singleton | `SyncState` and `ShopUsage` have exactly one row each                                                                                                   | schema     | ?                                                                                               |
| dedupe    | `WebhookDelivery` is one row per Shopify delivery id, kept for a while and swept by age                                                                 | schema+app | ?                                                                                               |
| outbox    | `UsageEvent` is one row per idempotency key, kept until Shopify accepts it                                                                              | schema+app | ? (the app-events tests cover the HTTP side, not the row's lifetime)                            |

Twenty-five rows. The column of `?` is the finding: most of the data
model's rules have no test named for them. The run-repository tests cover
the behaviour around the rules well, but the structural rule itself
("blocked implies open", "closed is set together") is asserted nowhere by
that name. Writing the table produces the missing test list for free.

What the table leaves out on purpose, and where it goes instead:

- Which status permits which action: `RunStatus`'s gate table and the
  action matrices. The data-model table says a closed run holds the slot;
  it does not say what a closed run offers.
- Index choices, the reserved-word rename, `text` ids: SQL comments beside
  the DDL, where the `ShopOrder` index already has one.
- The `UsageEvent` accept-then-delete protocol and `ShopUsage` cycle
  seeding: JSDoc on the flush and `setBillingCycle` functions.

## What the first draft got wrong (annotations, 2026-09-26)

Your annotations found four places where the rows spoke the schema's
language rather than the glossary's. Each is a small argument for the
spec: the table read off the DDL said what the tables hold, and you could
not recognise the model in it. The rows above are corrected; the reasons:

**Steps and tasks.** The glossary says a workflow has steps and a step has
tasks done in parallel. The schema has no step table: `step` is an integer
column on each task, kept dense `1..m` by `WorkflowLayout`, and `position`
is a second integer that orders tasks within the whole workflow for
display and gives `unique (workflowId, position)` something to hold. So
the first draft wrote "no two tasks share a position", which is true of
the columns and says nothing a person would call a rule. The row now says
what the model means: steps in order, tasks within a step, every task in
exactly one step. Whether that is held by a `WorkflowStep` table or by an
integer column is the implementer's choice, and this is a clean example of
the spec staying above it. On the question you raised, whether a step
table would be a better relational model: the current choice buys
single-table layout edits and one `unique` constraint, and costs the
step-level invariants (dense numbering, no empty step) being held by
`WorkflowLayout` rather than the database. With the spec row in place
either design satisfies it. Decided 2026-09-26: the column stays. A step
table would hold the step invariants (dense from 1, no empty step) no
better, since SQLite cannot express them without triggers, and would add a
join per task read, a second snapshot table per run and a two-table
transaction per layout edit. It earns its place only when a step gains
attributes of its own, and today it has none.

**A task's team.** The first draft said "team names copied", which is the
history half only. A run task carries both a live pointer to the team and
a snapshot of its name: the pointer is how the task appears on that team's
list and follows a rename; the snapshot is what a done task shows once the
team is gone. The team can be deleted while the run is open, which is the
fact the row now leads with, and a delete nulls the pointer on open tasks
(unassigned, on nobody's list) and leaves done tasks alone. Two rows now
say this: the definition task's team and the run task's team, since they
differ in whether a name is kept.

**"Blocked implies open".** "Open" is the glossary's run-state word for
"work can be recorded", stored as `active`, as opposed to done or closed.
A blocked run is an open run a person is holding. The row was correct and
unreadable; it now says only an open run can be blocked, and that done
and closed runs carry no block.

**"Log".** A grouping word I invented for the two append-only tables. The
rows now name what each table is for: `WebhookDelivery` is the dedupe
record of Shopify delivery ids, `UsageEvent` is the billing outbox. The
`about` column should hold glossary nouns or a table name, never a word
the glossary does not have; that is the check the parser will apply.

## Approaches compared

**A. Rule table on the schema symbol.** The table above sits as the JSDoc
on `initializeSchema`, with the SQL rationale demoted to comments in the
DDL. One place to read the whole model. The diff that changes a `create
table` shows the row above it.

**B. Rows distributed to the `Domain` concept symbols.** Each row goes on
`Domain.Run`, `Domain.Workflow`, `Domain.WorkflowDraft`, and so on, next to
the behavioural rules already there. Consistent with "a rule lives on the
symbol that is the concept". But the thing you asked to see whole is the
data model, and no `Domain` symbol is the data model; you would open six
JSDocs to check that cardinalities agree, the scatter the earlier JSDoc
research warned about.

**C. Sentence list instead of a table.** A bulleted list of normative
sentences reads more naturally than a table and needs no parser. It loses
the two columns that do the work: without `pinned by` nothing checks that
a rule has a test, and without `holds by` a reader cannot tell a database
guarantee from a write-path promise, which is the difference between "a
bug here is impossible" and "a bug here is one missed call away".

**D. Spec in code.** Effect `Schema` structs with refinements, or a typed
invariant object the tests iterate. Precise, but it is not English, and
the point is that you write it and the LLM implements it. The table can
be read by a script the way the action matrices are, which gets most of
the checking without giving up the prose.

**E. Leave the prose, add headings.** Cheapest. Fixes readability, not the
problem: a heading does not say which sentence is normative, and nothing
checks a heading.

Recommendation: **A**, table format as above, with SQL rationale moved to
DDL comments and behavioural prose replaced by `{@link}` to the `Domain`
symbol that owns it. The schema JSDoc goes from about 130 lines of prose to
a 25-row table and a short paragraph.

## What keeps it true

The action matrices stay true because a script parses them and a test
reads them. The same three mechanisms apply, in increasing cost:

1. **Parse and check the table** (`pnpm action-table check`, extended).
   Every `about` is a glossary noun. Every `holds by` is one of the three
   values. Every `pinned by` that is not `(none yet)` is the title of an
   `it(...)` somewhere under `test/`, by string match, the same way the
   glossary check greps for its words. Cost: an afternoon; the parser in
   `scripts/lib/action-table.ts` is generic over columns already.
2. **Every `schema` row has a raw-insert test.** The existing test "the
   unique index itself refuses a second row for an item" is the pattern:
   bypass the repository, insert the forbidden row, expect `SqlError`. It
   proves the database holds the rule and not merely the code paths tried
   so far. Roughly ten rows qualify.
3. **Every `app` row has a test whose title is the rule.** Most of the
   `?` cells. These are ordinary repository tests; the work is naming and
   writing about a dozen.

And one process rule for AGENTS.md, mirroring the action-matrix rule: a
structural change to the data model starts at the row. Add or change the
sentence, then change the DDL and the write paths to match, then write or
rename the pinned test. A PR that changes a `create table` without touching
a row is either a pure implementation change (index, type, rename) or a
missing row, and the reviewer asks which.

## Spec-first, and adjudication

Going forward the direction is spec to schema. The table supports that
because a row is complete before any column exists: "a workflow has at most
one draft" says nothing about `WorkflowDraft.workflowId` being the primary
key, and the implementer is free to pick that or a unique index. The
`holds by` column is then a report back: the human wrote `?` or left it
blank, the implementer fills in `schema`, and the human can push back
("I wanted that in the database, not the code").

When code and spec disagree there are three outcomes, and the table makes
each one a visible edit:

- **The code is wrong.** The pinned test fails or is missing; fix the code.
  The row does not change.
- **The spec is wrong.** On reflection the rule should be different. Edit
  the sentence, then the code, then the test title. The row's diff is the
  decision record.
- **The spec is silent.** The behaviour is real but no row covers it.
  Either add a row (it was a rule) or leave it (it is an implementation
  detail the next implementer may change). Deciding which is the human's
  call, and it is a one-line call.

What the table does not do is decide by itself. A failing pinned test says
"these two disagree", not "the code is wrong", and the AGENTS.md rule should
say so: the fix is to the row or to the code, never to delete the test.

## Follow-ups

Not part of the first pass. Each is its own research or plan once the
table is on the schema symbol.

1. **The D1 side.** `Member`, `Team`, `TeamMember` and the session tables
   in `migrations/0001_init.sql` have the same kind of rules (a member is
   on zero or more teams; a team is identified by its name within a shop;
   deleting a team unassigns its tasks in every shop's object) and no JSDoc
   at all, because a `.sql` file has none. The cross-store rows above (a
   task's team points to a D1 row) are half of a rule whose other half is
   on the D1 side. Same table format, on `Repository` or on a symbol that
   owns the migration text. The format should not assume one store.

2. **Column audit.** Once the spec says what each table is for, ask of
   every column whether a row needs it. `ShopOrder` and `OrderLineItem`
   are the suspects: they mirror Shopify fields (`financialStatus`,
   `fulfillmentStatus`, `fullyPaid`, `note`, `properties`, `productTags`,
   `requiresShipping`, `lineItemsTruncated`) and some may be there because
   the sync had them rather than because a screen or a rule reads them.
   The audit is: for each column, the reader that needs it, or delete it.
   Cheap while the schema is a single migration and local state is reset
   freely.

3. **The two murky rows.** "billed at most once, on its first run" and
   "a team delete nulls open run tasks only" stay marked `?` until the
   foundation is in and the billing and team-delete behaviour firm up.

## Decisions (2026-09-26)

All seven recommendations accepted; no open questions remain.

1. Extract the schema and its JSDoc to `src/lib/ShopAgentSchema.ts`; the
   table lives there.
2. Structural rules only. Behavioural gates stay on the `Domain` symbols.
3. Table, not sentence list.
4. `holds by` is the implementer's report; the author writes `schema` only
   to demand a database guarantee, and `?` or blank otherwise.
5. First pass: parse the table, check every `pinned by` title exists, and
   write the raw-insert tests for `schema` rows. Named tests for `app` rows
   follow one at a time as the `?` cells come up.
6. Plain-English cardinalities.
7. The two rows I was unsure of are basically right; they keep their `?`
   and are revisited once the foundation is in (follow-up 3).
8. `step` stays an integer column on the task; no step table.

## Status

Research. Nothing in `src/` depends on this file; it is deleted once the
table lands on the schema symbol and AGENTS.md carries the process rule.

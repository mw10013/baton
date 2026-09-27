# Name uniqueness: which names are unique, compared how, declared where

## What was asked

A question about how the two schemas declare unique indexes turned into a
question about the rules themselves. Three things to settle:

1. Should team names be unique case-insensitively (today) or exactly as
   typed?
2. How should the `Team` uniqueness be declared: a separate named
   `create unique index`, or `unique (shop, name)` inside `create table`?
3. Workflow names are not unique; the tag is. Is that still right?

The schema is a single migration on both stores and local state is reset
freely, so any answer here is an in-place edit, not a migration.

## First principles

A value that a row carries falls into one of three roles:

- **Identity**: what code uses to find the row. Always the `id`. Never
  shown, never chosen by a person.
- **Key**: a value a machine matches against. The workflow tag is the only
  one: it is compared with Shopify product tags to decide which workflow an
  item follows. A key must be unique, and it must compare the way the other
  side compares.
- **Label**: a value a person reads to pick one row from several. A label
  needs to be unique only if it is the only thing a person has to tell rows
  apart on some screen.

How a value compares follows from its role. A key compares the way its
partner system does. A label compares the way a person reads it.

## Current state

| value           | store | role  | unique   | case                                  | declared as                                                  |
| --------------- | ----- | ----- | -------- | ------------------------------------- | ------------------------------------------------------------ |
| `Member.email`  | D1    | key   | per shop | lowercased at decode (`Domain.Email`) | `unique (shop, email)` in `create table`                     |
| `Team.name`     | D1    | label | per shop | case preserved, unique ignoring case  | `create unique index Team_shop_name_uidx ... collate nocase` |
| `Workflow.tag`  | DO    | key   | per shop | lowercased at decode (`WorkflowTag`)  | `tag text not null unique` on the column                     |
| `Workflow.name` | DO    | label | no       | case preserved                        | —                                                            |
| task name       | DO    | label | no       | case preserved                        | —                                                            |

Two patterns are already in use for case:

- **Keys fold case at the boundary.** `Email` and `WorkflowTag` lowercase on
  decode, so storage is canonical and every comparison is plain `=`. No
  collation anywhere.
- **Team names use a collation.** The unique index says `collate nocase`,
  and so does the rename check in `Repository.renameTeam`
  (`name = ? collate nocase`). This is the only place in either schema where
  a uniqueness rule depends on a collation.

Separately, list queries sort names with `order by ... collate nocase`
(teams in `Repository`, workflows in `WorkflowRepository`). That is a
display rule, not a uniqueness rule; see "Sorting" below.

## 1. Team names: case-insensitive or exact

A team has no tag and no handle. Merchants and members tell teams apart by
name alone: the teams index, the team page heading, a member's teams, and
the team picker on each workflow task (the order page and the workflow
editor). So team names must be unique within a shop. That part is settled.

The open part is whether "Sewing" and "sewing" count as the same name.

**Case-insensitive (today).**

- Stops two teams that differ only in case, so no picker shows what looks
  like the same team twice.
- Costs a collation on the index and on the rename check, and a rule every
  future query comparing team names has to remember. A query that forgets it
  is silently case-sensitive.
- It is the one place the schema's uniqueness depends on collation, so it is
  the one place a reader has to know what `nocase` does (ASCII-only folding,
  for one).

**Exact.**

- `unique (shop, name)`, plain `=`, no collation. Nothing to remember.
- "Sewing" and "sewing" can coexist. The database refuses an exact
  duplicate but accepts a case variant, because they are different strings.
  So "by accident" means a merchant who meant the existing team typed it with
  different capitals and got a second team instead of a refusal. That is
  unlikely: teams are created rarely, a shop has a handful, and the create
  dialog is on the teams index, where the existing team is in view. If both
  exist, each is still distinct in every picker; they look alike, not
  identical.
- Consistent with the principle: a label compares the way a person reads
  it, and a person reads "Sewing" and "sewing" as different spellings.

**Recommendation: exact.** The collation guards a mistake that is unlikely
and visible when it happens, and it is the only collation-dependent rule in
the schema. Removing it leaves one rule for all labels (compare exactly)
and one for all keys (fold at the boundary, compare exactly).

What changes:

- `D1_TABLES` row for team: "a team is identified by its name within a
  shop; the name is trimmed and non-empty" (drop "case-insensitively"), and
  its pinned title.
- `migrations/0001_init.sql`: drop `Team_shop_name_uidx`, add
  `unique (shop, name)` to `create table Team`.
- `Repository.renameTeam`: drop `collate nocase` from the `nameTaken` check.
- `Domain.TeamName` JSDoc: the trim reasoning currently cites `collate
nocase`; restate it against exact uniqueness (a leading space would still
  be the difference between a duplicate refused and one accepted).
- `test/integration/repository.test.ts`: "createTeam rejects a
  case-insensitive duplicate name" becomes a test that an exact duplicate is
  refused and a case variant is accepted, titled from the new row.
- `e2e/teams.spec.ts`: the duplicate-name step fills `TEAM.toLowerCase()`;
  it should fill `TEAM` and expect the refusal.

## 2. Declaring the Team constraint

**Recommendation: `unique (shop, name)` inside `create table Team`.** This
matches how `Member` declares `unique (shop, email)` in the same file and
how the object declares `unique (workflowId, position)`.

Why not a column-level `unique` on `name`: it would make names unique across
all shops. The rule spans two columns, so it has to be the table-level form.

Why not a separate named index: a separate `create unique index` earns its
place only when something needs what only it offers:

- a stable name that code or a test looks up (the better-auth
  `Account_issuer_accountId_uidx`, which the drift test in
  `test/integration/auth.test.ts` finds by name);
- a partial index (`where ...`) or an expression;
- adding uniqueness to an existing table in a later D1 migration, since
  SQLite cannot add a constraint without rebuilding the table.

None applies to `Team`. With exact comparison there is not even a collation
to carry. The inline form keeps the rule next to the column's other rules
and needs no invented name.

The same test settles the general convention: inline `unique` for plain
uniqueness (column-level for one column, table-level for several); a
separate named index only for the three cases above. Both schemas already
follow it everywhere except `Team`.

## 3. Workflow names

### Why names are not unique today

A workflow has a tag, and the tag is its key. Baton mints the tag (the
create dialog prefills it from the name), the merchant puts it on products
in Shopify, and an item follows the workflow whose tag its product carries.
The tag is called a tag, though there is exactly one, because merchants
already know tags; a new word like "handle" would be a concept to learn.

With the tag unique, making the name unique too would mean two "taken"
errors on create, duplicate and rename. Leaving the name free kept those
flows to one. The rule that makes that safe is on the `Workflow` vocabulary
JSDoc in `Domain.ts`: "everything that shows a workflow to the merchant
outside its own page shows the tag beside the name."

### That rule is not followed

These screens show a workflow by name alone:

| where                                                  | what it shows           |
| ------------------------------------------------------ | ----------------------- |
| the order page, attach and change pickers (`s-option`) | `workflow.name`         |
| the order page, item card and toasts                   | `run.workflowName`      |
| the teams index, workflows column                      | `workflow.workflowName` |
| the team page, `UsedByCard`                            | `workflow.workflowName` |
| the member's workflows list and workflow page          | `run.workflowName`      |

The attach and change pickers are the sharpest case: two workflows named
"Engraving" appear as two identical options, and the merchant picks one
blind. Members never see tags at all, so on member screens the name is the
only thing they have.

### Options

**A. Keep names free; show the tag everywhere the rule says.** Add the tag
to the pickers, the teams index, `UsedByCard` and the order page card. On
member screens the tag would appear as well, or the rule is narrowed to
merchant screens and members live with ambiguity. Every future screen that
lists workflows has to remember the rule. Runs snapshot `workflowName`
today, not the tag, so member screens would need a `workflowTag` snapshot
column on `Run`.

**B. Make names unique per shop, compared exactly.** `name text not null
unique` on `Workflow` (the object is per shop, so no shop column). The name
then identifies a workflow to merchants and members alike, on every screen,
with no rule to remember. The cost:

- a second refusal (`NameTaken`) beside `TagTaken` on create, duplicate and
  rename. Because the tag is prefilled from the name, a collision on one
  usually means a collision on both, so the dialog would mostly show both
  errors together;
- the Duplicate dialog must prefill a new name ("Engraving copy") as well
  as a new tag;
- `TagTakenLink` and the `WorkflowResult.TagTaken` reasoning ("a name no
  longer identifies a workflow") become unnecessary; the refusal can name
  the holder.

A run's `workflowName` snapshot is unaffected: a deleted workflow's runs
keep its old name, and a new workflow may reuse it. That is the same as a
deleted team's name being reused.

**Recommendation: B.** It puts workflows and teams under one rule: a label
a person picks by is unique in its shop, compared exactly. The alternative
asks every workflow-listing screen, on both sides, to carry a second field,
and five screens already do not. The extra refusal is a one-time cost in
three dialogs.

## Sorting

`order by name collate nocase` sorts "apple" beside "Apple" instead of
after "Zebra". That only matters when a shop mixes capitalisation across
names, which merchants are unlikely to do, and where they do, the order is
still stable. With exact uniqueness it would be the only `collate` left in
either store, and a reader would have to stop and work out what it does.
Drop it from the team and workflow name sorts and sort with plain
`order by name`.

`m.email collate nocase` in the member-teams query (`Repository`) is
redundant: `Domain.Email` already lowercases on decode, so every stored
email is lowercase. Drop it.

The order search in `OrderRepository` (`name like ? escape '\\' collate
nocase`) is noise too. SQLite's `like` is case-insensitive for ASCII by
default and ignores collation (`'ABC' like 'ab%'` is 1 under no collation,
`binary` and `nocase`), nothing sets `case_sensitive_like`, and `ShopOrder`
has no index on `name`, so the query plan is a scan either way. Drop it,
correct the `searchFilter` JSDoc to credit `like` itself, and pin the
behaviour with a test that searches a lettered name in the other case.

## Decisions

No open questions remain.

1. Team names are compared exactly: "Sewing" and "sewing" are two teams.
2. `Team` declares `unique (shop, name)` inside `create table`;
   `Team_shop_name_uidx` is dropped.
3. Workflow names are unique per shop, compared exactly (option B).
4. No `collate nocase` on name sorts. The redundant `m.email collate nocase`
   is dropped.
5. The order search drops `collate nocase`; a test pins that it is still
   case-insensitive. Neither store uses `collate` afterwards.

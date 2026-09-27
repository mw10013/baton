# A data-model spec for D1: where it lives, what it says, what keeps it true

## What was asked

`docs/data-model-spec-research.md` landed: the data-model table is the JSDoc
on `initializeSchema` in `src/lib/ShopAgentSchema.ts`, `pnpm action-table
check` parses it and refuses a pinned title no test carries, and
`test/integration/data-model.test.ts` holds the raw-insert tests. Its first
follow-up is the D1 side: `ShopSession`, `Member`, `Team`, `TeamMember` and
the better-auth tables in `migrations/0001_init.sql` have the same kind of
structural rules and no place to state them, because a `.sql` file has no
JSDoc and no symbol for the parser to find.

This doc answers where the D1 table lives, what its rows are, how the rows
that straddle the two stores are split, and what the checker and tests need
to change. The format, vocabulary and process rule are the ones already
decided and are not reopened.

## What is already there

The rules exist. They are stated in three places, as narrative, and no one
of them is the one you edit:

| rule                                                                      | said in                                                                                                         | pinned by                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| a member is identified by shop and email; the email is lowercase, trimmed | migration DDL (`unique (shop, email)`, the `check`), `Domain.Email` JSDoc                                       | "Email decode trims and lowercases" (the decode, not the row)                                             |
| a member goes with its shop                                               | migration comment, `Domain.Member` JSDoc                                                                        | "deleteShopSession cascades that shop's members only"                                                     |
| delete a member and they leave their teams; nothing else points at them   | migration comment, `Domain.Member` JSDoc, `Repository.deleteMember` JSDoc                                       | "findMemberAccess is none for a deleted member" (partial)                                                 |
| re-adding an email mints a new id; history keeps the old email as text    | migration comment, `Domain.Member` JSDoc, `Domain.tierOf` JSDoc                                                 | "addMember after deleteMember mints a new id"                                                             |
| a team is identified by its name within a shop, case-insensitively        | migration DDL (`collate nocase`), `Domain.TeamName` JSDoc, `Repository.createTeam` JSDoc                        | "createTeam rejects a case-insensitive duplicate name"                                                    |
| a team never crosses shops                                                | migration comment ("holds by construction"), `Repository.setMemberTeams` JSDoc                                  | "setTeamMember refuses cross-shop pairs"                                                                  |
| a team delete is D1 first, then every object pointer; dangling reads null | migration comment, `Domain.Team` JSDoc, `Repository.deleteTeam` JSDoc, `ShopAgent.deleteTeam` JSDoc, object row | "deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it" |
| a shop has exactly one object                                             | migration DDL (`shopAgentId unique`), `Repository.upsertShopSession` JSDoc                                      | (none)                                                                                                    |
| better-auth's tables are better-auth's                                    | migration comment                                                                                               | "hand-written migration matches better-auth's runtime expectations"                                       |

The finding is the same as last time: the rules are known and the tests
mostly exist, but the team-delete rule is stated in five places and nothing
says which is normative. The migration's comment block is the closest thing
to a spec today, and a migration is append-only: the next `.sql` file that
changes `Team` will not edit the comment in `0001_init.sql`, and the parser
cannot find a table in a file with no `export const`.

One thing the D1 side has that the object did not: a structural drift test.
`test/integration/auth.test.ts` diffs the migration against better-auth's
`getSchema` on every run, so the better-auth tables are already pinned as a
block. The app-owned tables have no equivalent; the spec table is what gives
them one.

## Where the table lives

The parser (`scripts/lib/action-table.ts`, `firstTable`) finds a table by
the JSDoc immediately before `export const <name> =` and, for `about`, takes
table names from `create table if not exists` in the same source. D1 breaks
both assumptions: the DDL is in `migrations/*.sql`, applied by wrangler, and
no TypeScript symbol owns it.

**A. A new `src/lib/D1Schema.ts` with an exported constant that carries the
table.** The constant has to be a real value, not an empty export that
exists for its JSDoc. The honest candidate is the list of app-owned table
names:

```ts
/** <the data-model table> */
export const D1_TABLES = [
  "ShopSession",
  "Member",
  "Team",
  "TeamMember",
] as const;
```

The list earns its place with one test: the migrations create exactly these
tables plus better-auth's, read from `sqlite_master`. That is the D1
counterpart of the drift test, and it catches a migration that adds a table
nobody wrote a row for. The parser takes table names for `about` from the
constant (or from `migrations/*.sql`; either works, the constant is
simpler). Mirrors `ShopAgentSchema.ts`: one file per store, the spec at the
top, the same shape.

**B. On `Repository` in `src/lib/Repository.ts`.** The symbol that enforces
most of the `app` rows. Two problems: it is `export class`, so the parser
grows a second symbol form; and it is not the whole D1 side. `Auth.ts` owns
the better-auth tables and `ShopAgent.deleteTeam` owns the cross-store
order. The `Repository` JSDoc is also already long with path-selection
prose (`D1Session` vs `D1Primary`) that has nothing to do with structure.

**C. A comment block in `migrations/0001_init.sql`.** Next to the DDL, like
the object's table is. But append-only: after `0002` the spec in `0001` is
a spec for a schema that no longer exists, and it would need a parser for
SQL comments. Rejected.

**D. Move the D1 DDL into code.** A `D1Schema.ts` that holds the DDL as a
string and a script that emits `migrations/*.sql` from it, so the spec and
the DDL are in one file as they are for the object. Nothing here needs it:
wrangler's migration runner is fine, the migration is one file, and
generating SQL from TypeScript adds a build step to protect a co-location
that a `{@link}` provides. Rejected for now; A does not preclude it.

**E. One table for both stores, on `initializeSchema`.** The format was
told not to assume one store, and a single table would read whole. But the
parser's `about` check is per source file, the object's table is already
25 rows, and a reader who wants the D1 model would scroll past the object's.
Two tables, one format, one checker.

Recommendation: **A**. The file is `src/lib/D1Schema.ts`, the symbol is
`D1_TABLES`, and the migration's comment blocks shrink to SQL rationale and
a pointer to the symbol, the way the object's DDL comments do.

## The spec, drafted from the current migration

Same columns, same vocabulary. `about` is a glossary noun (`member`,
`team`, `shop`) or a backticked table name. `shop` is not in the glossary's
noun table today; it is the word the glossary uses throughout and should be
added to `DATA_MODEL_NOUNS` and, if the glossary's table lacks it, the
glossary. Rows marked `(none yet)` are the finding.

| about     | rule                                                                                                                      | holds by   | pinned by                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| shop      | a shop is identified by its domain and has exactly one object; the object id is set once and never rewritten              | schema     | (none yet)                                                                                              |
| shop      | uninstall deletes the shop and its members and teams go with it; the object survives and is swept as an orphan            | schema+app | (none yet; "deleteShopSession cascades that shop's members only" and "...teams" cover the cascade half) |
| shop      | the plan cache is stored, never derived; only revalidation writes it and re-authentication never touches it               | app        | updateShopSessionPlan rewrites only the plan cache fields                                               |
| member    | a member is identified by shop and email; the email is stored lowercase and trimmed                                       | schema     | (none yet)                                                                                              |
| member    | a member has exactly one shop and goes with it                                                                            | schema     | deleteShopSession cascades that shop's members only                                                     |
| member    | a member is on zero or more teams; delete a member and they leave their teams; nothing else structural points at a member | schema     | (none yet)                                                                                              |
| member    | no history: re-adding a deleted email mints a new id; run history keeps the old email as a snapshot in the object         | app        | addMember after deleteMember mints a new id                                                             |
| member    | a member's access is the row: no role, no state; sign-in identity is the email                                            | app        | findMemberAccess is none for a deleted member                                                           |
| team      | a team is identified by its name within a shop, case-insensitively; the name is trimmed and non-empty                     | schema     | createTeam rejects a case-insensitive duplicate name                                                    |
| team      | a team has exactly one shop and goes with it                                                                              | schema     | deleteShopSession cascades that shop's teams                                                            |
| team      | a team has zero or more members; a membership is one row per team and member, no history; a team never crosses shops      | schema+app | setTeamMember refuses cross-shop pairs                                                                  |
| team      | a team delete goes to D1 first, then nulls every object pointer; a retry repairs a half-done delete                       | app        | deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it |
| `User`    | better-auth's tables are better-auth's: a session and an account go with their user; a role is one of a closed set        | schema     | hand-written migration matches better-auth's runtime expectations                                       |
| `Session` | expired sessions and verifications are swept on the sign-in path, never read                                              | app        | sweeps expired Session and Verification rows on the way out                                             |

Fourteen rows. Notes on the ones that needed a decision:

**The object survives uninstall.** `deleteShopSession` cascades D1 and
nothing else; `findOrphanShopAgentIds` and the admin orphan page exist
because of it. That is the current behaviour and it is stated nowhere as a
rule. The row says it. If the intended rule is that uninstall clears the
object too, the row is where that decision is recorded first.

**Membership has no history.** `TeamMember.createdAt` is when the edge was
made and nothing keeps a removed edge. Said once, on the team row, because
the members page reads `inTeamSince` from it and might one day want more.

**"A team never crosses shops" is `schema+app`.** The migration says it
holds by construction because an edge points at `Member.id`, which belongs
to one shop. That is true of the two foreign keys, but nothing in the
database compares `Team.shop` to `Member.shop`; `setTeamMember` scopes both
sides through the shop. A raw insert of a cross-shop edge succeeds. So it
is `schema+app` unless a trigger or a composite key is added, which is
question 5.

**The better-auth block is one row.** The drift test already pins the whole
shape column by column. Rows per table would restate better-auth's schema in
our words with nothing of ours to say about it. One row that names the
owner and the test is the truthful amount.

## Cross-store rules: the split

Three rules have a half in each store. The object's table already carries
its half as reader rules:

| object row (exists)                                                                                       | D1 row (proposed)                                                                                   |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| a definition task's team points to a D1 row; dangling reads as null, which means unassigned               | a team delete goes to D1 first, then nulls every object pointer                                     |
| a run task's team is both: it points to the team (deletable while the run is open) and snapshots the name | (same row)                                                                                          |
| who did what is a snapshot (`*ByEmail`, `teamName`); history never resolves through `Member` or `Team`    | no history: re-adding a deleted email mints a new id; run history keeps the old email in the object |

The split is by side, not by duplication: the store that holds the pointer
says what a dangling pointer means; the store that holds the row says what
its delete does and in what order. Neither sentence restates the other, and
each `{@link}`s across. The one test that spans both,
`deleteTeam nulls every task pointer, D1 first ...`, pins the D1 row
because the D1 side initiates; the object rows keep `(none yet)` until a
raw-read test shows a dangling id rendering as unassigned, which is the
object's half.

The vocabulary needs one addition for the deleter's side. The existing
"points to a D1 row; dangling reads as null" is the pointer-holder's phrase.
The proposed counterpart is **"deletes here first, then nulls every object
pointer"**: a delete that cannot be one transaction, and the order it runs
in. It is the only cross-store write today.

## What keeps it true

1. **Generalise the parser.** `parseDataModel` takes the symbol name and the
   set of table names instead of hard-coding `initializeSchema` and grepping
   the same source for `create table`. `checkPinned` is already
   source-agnostic. `scripts/action-table.ts` reads `D1Schema.ts` beside
   `ShopAgentSchema.ts` and reports failures with the symbol name, which it
   does already. Cost: an hour.

2. **Fix `checkPinned` for `it.effect(`.** The title regex matches `it(`
   only. Every D1 repository test is `it.effect(` or `it.live(`, so every D1
   pinned title would be reported missing today. This is also a latent bug
   for the object's table: a row pinned to an `it.effect` test would fail
   the check. The fix is `it(?:\.\w+)?\(` and a test for it in
   `action-table.test.ts`.

3. **Raw-insert tests for the `schema` rows.** `data-model.test.ts` is the
   pattern; the D1 version runs through `env.D1` with migrations applied,
   which `repository.test.ts` already does. Six rows qualify: one object per
   shop, member identity, member goes with shop, member leaves teams, team
   identity, team goes with shop. D1 enforces foreign keys by default, so
   the cascade tests are real. Where they live is question 6.

4. **The tables-exist test.** `D1_TABLES` plus better-auth's names equals
   `sqlite_master` after migrations. Gives the constant its job and catches
   a table with no row.

5. **The process rule in AGENTS.md** gains a clause: "the same table on
   `D1_TABLES` (`src/lib/D1Schema.ts`) is the spec for D1; a migration that
   adds or changes a table starts at its row." The command it names is
   `pnpm spec check` (decision 8). Adding a D1 migration is the
   one place the two stores differ in process: the object's schema is edited
   in line while prototyping, D1 gets a new numbered file, and the row is
   the thing that says why.

## Decisions (2026-09-27)

All eight questions are decided; recommendations 1 through 7 were accepted
as written, and 8 went the other way.

1. The table lives in `src/lib/D1Schema.ts` as the JSDoc on `D1_TABLES`,
   the list of app-owned table names, which a test checks against
   `sqlite_master` after migrations.
2. `ShopSession` is in scope: three rows. It is the root every cascade
   hangs from, and "one object per shop" is the rule the two-store design
   rests on.
3. Better-auth is one row, pinned to the drift test. Rows we do not own
   would need editing on every better-auth bump.
4. Uninstall leaves the object; the row records the current behaviour. A
   change to "goes with it" starts at the row, in a later billing or
   uninstall pass.
5. "A team never crosses shops" stays `schema+app`. The write path is one
   function and a trigger is more schema than the rule is worth at this
   roster size.
6. The D1 raw-insert tests go in a second file, `d1-data-model.test.ts`,
   with the same header comment and title convention as
   `data-model.test.ts`; the two harnesses do not share a file.
7. `shop`, `member` and `team` join `DATA_MODEL_NOUNS`.
8. **Rename the check.** `pnpm action-table check` now checks two action
   tables, a glossary, a screens table and two data models, and the name
   describes a fifth of that. The script becomes `scripts/spec.ts` and
   the commands `pnpm spec check` and `pnpm spec print`; `scripts/lib/action-table.ts`
   becomes `scripts/lib/spec.ts`; AGENTS.md, `package.json`, the test file
   and every JSDoc that names the command change in the same pass. Leaving
   a name that no longer says what the thing does is exactly the drift the
   tables exist to stop.

## Status

Research, decided; ready for a plan. Nothing in `src/` depends on this
file. It is deleted once the table is on `D1_TABLES`, `pnpm spec check`
reads both, and AGENTS.md carries the D1 clause. `docs/data-model-spec-research.md` and `docs/data-model-spec-plan.md`
are done and can be deleted now.

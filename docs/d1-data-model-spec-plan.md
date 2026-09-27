# Data-model spec for D1: implementation plan

Implementation plan for `docs/d1-data-model-spec-research.md`. Every question there is decided (its Decisions section). Read the research first, then `src/lib/ShopAgentSchema.ts`, `scripts/lib/action-table.ts`, `scripts/action-table.ts` and `test/integration/data-model.test.ts`: this plan repeats their shape for D1 and the reasoning in the research must end up inline in JSDoc, because the research doc will be deleted.

Written 2026-09-27 for an LLM agent. Work on `main`, no branches. Do not commit unless told. After each step: `pnpm typecheck && pnpm lint && pnpm test`. At the end: `pnpm fmt`, keep every file it touches. Record anything that did not go as written in section 12 of this file.

## 1. What this delivers

1. **The check renamed.** `scripts/action-table.ts` becomes `scripts/spec.ts`, `scripts/lib/action-table.ts` becomes `scripts/lib/spec.ts`, and the commands are `pnpm spec check` and `pnpm spec print`. Every file that names the old command changes.
2. **A parser that reads two data models.** `parseDataModel` takes the symbol name and the table names instead of assuming `initializeSchema` and grepping its own source for `create table`. `checkPinned` matches `it.effect(` and `it.live(` as well as `it(`.
3. **`src/lib/D1Schema.ts`** exporting `D1_TABLES`, the app-owned D1 table names, with the D1 data-model table as its JSDoc.
4. **Tests.** A raw-insert test for every `schema` and `schema+app` row, and a test that the migrations create exactly `D1_TABLES` plus better-auth's tables, in `test/integration/d1-data-model.test.ts`.
5. **JSDoc aligned** across `migrations/0001_init.sql`, `Domain`, `Repository`, `ShopAgent` and `ShopAgentSchema`: each D1 structural rule stated once, in the table; every other site links to it or explains its own code without restating the rule.
6. **AGENTS.md** carries the D1 clause and the new command name.

## 2. Decisions this plan makes beyond the research

- **`D1_TABLES` is `["ShopSession", "Member", "Team", "TeamMember"] as const`.** The better-auth tables are not in it; the tables-exist test adds them from a second constant in the test (`UserRole`, `User`, `Session`, `Account`, `Verification`) because better-auth owns those names and the drift test already pins them.
- **The "one object per shop" row is `schema+app`, not `schema`.** The unique index holds "exactly one object"; "set once and never rewritten" is `upsertShopSession` omitting the column from its `SET` list. The research table said `schema`; this plan corrects it.
- **`about` nouns for D1 are `shop`, `member`, `team`.** All three join `DATA_MODEL_NOUNS`. `shop` is not in the glossary's noun table (`Domain.ts` glossary); add a row for it there, in the same change: `| shop | one Shopify store, the tenant | \`ShopSession\`, \`Shop\` | its domain |`. The glossary check (`checkGlossary`) requires each glossary word to occur in `Domain.ts`outside the glossary;`shop` does.
- **Nothing in the D1 DDL changes.** Every row is held by what the migration already declares or by a write path. The migration file changes only in its comments (step 5). If you find a row that needs DDL, edit `migrations/0001_init.sql` in line (no new migration while prototyping) and follow section 4.
- **The table's `pinned by` titles are the rule sentences** for the tests this plan writes, exactly as in `data-model.test.ts`. Existing tests keep their titles and are pinned by them verbatim.
- **The script's root command is `spec`**, description "The action matrices in src/lib/Domain.ts and the data-model tables in src/lib/ShopAgentSchema.ts and src/lib/D1Schema.ts". Subcommands stay `check` and `print`.

## 3. What this does not change

Behavioural rules and their tables, the glossary's other rows, any repository write path, `ShopAgent.deleteTeam`'s order of operations, better-auth's schema, the seed, any route, any screen copy. The object's data-model table changes only where a cross-store row gains a `{@link}` (step 5).

## 4. Prerequisites and the reset protocol

- D1 schema edits, if any, go into `migrations/0001_init.sql` in line. No new migration. The user resets local state.
- **Tell the user to reset when, and only when, a `create table`, `create index` or `insert or ignore` line in `migrations/0001_init.sql` changes.** Comment-only edits do not need it: wrangler records applied migrations by file name, not content. If DDL does change, stop before any step that runs the app and tell the user to:
  1. stop the local dev server;
  2. run `pnpm d1:reset`, which recreates local D1 from migrations and wipes `.wrangler`, which also holds every local Durable Object's SQLite;
  3. restart the local dev server with `pnpm app:dev`, then `pnpm seed`.
     Tests do not need this: `test/apply-migrations.ts` applies the migrations to a fresh D1 per run.
- **At the end of the plan, ask the user to restart the dev server once regardless** (the rename touches `package.json` scripts and the dev server was started before them), then do the manual check in step 8. Put the same instruction in the final report.
- `pnpm port` gives the dev port. Chrome MCP is available for step 8; `npm run test:e2e --` runs the E2E suite headless.

## 5. Step 1. Rename the check

Mechanical. Do it first so every later edit uses the new names.

1. `git mv scripts/action-table.ts scripts/spec.ts`, `git mv scripts/lib/action-table.ts scripts/lib/spec.ts`, `git mv test/integration/action-table.test.ts test/integration/spec.test.ts`.
2. In `scripts/spec.ts`: `Command.make("action-table")` becomes `Command.make("spec")`; the variable `actionTableCommand` becomes `specCommand`; the header comment, the `check` and `print` descriptions and the `UserError` cause/message say "spec", not "action tables". Import path `./lib/spec.ts`.
3. `package.json`: `"spec": "node scripts/spec.ts"`, and the `lint` script runs `node scripts/spec.ts check`. Delete the `action-table` script.
4. Update every import of `../../scripts/lib/action-table.ts`: `test/integration/spec.test.ts`, `test/integration/run-actions.test.ts`. The module's exported namespace name in those files (`ActionTable`) may stay; the parse functions for the matrices are still action tables. Keep it.
5. Update every mention of the command or path. Grep `action-table` across the repo excluding `refs/`, `dist/`, `docs/` and `node_modules/`. Known sites: `AGENTS.md` (lines in the rules list and the Commands block), `src/lib/Domain.ts` (three JSDocs), `src/lib/ShopAgentSchema.ts` (JSDoc), `scripts/lib/rules-lint.ts` (JSDoc), `scripts/lib/spec.ts` (its own header JSDoc mentions `scripts/action-table.ts`), `test/integration/data-model.test.ts`, `test/integration/rules-lint.test.ts`. After this step `grep -rn "action-table" --exclude-dir=refs --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=docs .` returns nothing.

Check: `pnpm spec check` and `pnpm spec print` run; typecheck, lint, test green. No behaviour change.

## 6. Step 2. Generalise the parser

In `scripts/lib/spec.ts`:

1. **`parseDataModel(source, options)`** where `options` is `{ readonly symbol: string; readonly tables: ReadonlySet<string> }`. Remove the `DATA_MODEL` constant and the `create table if not exists` grep from inside it. Error messages use `options.symbol` where they used `DATA_MODEL`. Add `DATA_MODEL_NOUNS` entries `"shop"`, `"member"`, `"team"`.
2. **Two helpers for the callers**, exported:
   - `tablesDeclared(source: string): ReadonlySet<string>`: the `create table if not exists <name>` names in a source. The object's caller uses it on `ShopAgentSchema.ts`.
   - `tablesNamed(source: string, symbol: string): ReadonlySet<string>`: the string literals of the `as const` array assigned at `export const <symbol> =`. The D1 caller uses it on `D1Schema.ts`. A regex over the array literal is fine; the value is a list of identifiers.
3. **`checkPinned(rows, testSources, symbol)`**: the title regex becomes `\bit(?:\.\w+)?\(\s*(["'\`])<title>\1`so`it.effect(`and`it.live(`count. Messages use`symbol`.
4. Update the JSDoc on `parseDataModel` and `checkPinned` to say what they take. The rule "Every `pinned by` title is carried by a test" keeps its bold sentence.

In `scripts/spec.ts`:

5. Read `src/lib/D1Schema.ts` beside `ShopAgentSchema.ts`. `check` runs `parseDataModel` and `checkPinned` for both: `{ symbol: "initializeSchema", tables: tablesDeclared(schemaSource) }` and `{ symbol: "D1_TABLES", tables: tablesNamed(d1Source, "D1_TABLES") }`. `print` prints both under their symbol names.

In `test/integration/spec.test.ts`:

6. The existing data-model tests pass the new options. Add: `it("a pinned title written with it.effect or it.live is found")` and `it("the D1 table parses and every pinned title is carried by a test")` reading `@/lib/D1Schema.ts?raw`. The D1 test will fail until steps 3 and 4 land; that is the order.

## 7. Step 3. `src/lib/D1Schema.ts`

Create the file with this content. Adjust `pinned by` cells to the exact titles step 4 writes; copy existing titles verbatim from the test files.

```ts
import type * as Domain from "@/lib/Domain";

/**
 * The data model of D1, the store every shop shares, as rules. The same
 * spec as {@link initializeSchema} in `ShopAgentSchema.ts`, with the same
 * columns and vocabulary: the table says what is true of the data, never
 * which column or index makes it true, and `migrations/0001_init.sql`
 * conforms to it. `pnpm spec check` parses it and refuses a title no test
 * carries; a structural change starts at the row, then the migration and
 * the write paths, then the pinned test.
 *
 * D1 is where identity lives: shops, members, teams and sign-in. Work lives
 * in each shop's Durable Object, which points into D1 by id and never the
 * other way. No foreign key crosses the two stores, so a cross-store rule
 * has a half on each side: the object's table says what a dangling pointer
 * means ("points to a D1 row; dangling reads as null"); this table says
 * what a delete here does and in what order ("deletes here first, then
 * nulls every object pointer"), because D1 is where the delete starts. The
 * two sentences link to each other and neither restates the other.
 *
 * The value is the app-owned tables, which one test checks against
 * `sqlite_master` after the migrations run, so a migration that adds a
 * table nobody wrote a row for fails. Better-auth's tables are not listed:
 * better-auth owns their shape, and the auth schema drift test pins them
 * column by column.
 *
 * | about     | rule                                                                                                                                | holds by   | pinned by                                                                                                |
 * | --------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
 * | shop      | a shop is identified by its domain and has exactly one object; the object id is set once and never rewritten                        | schema+app | a shop is identified by its domain and has exactly one object                                            |
 * | shop      | uninstall deletes the shop and its members and teams go with it; the object survives and is swept as an orphan                      | schema+app | (none yet)                                                                                               |
 * | shop      | the plan cache is stored, never derived; only revalidation writes it and re-authentication never touches it                         | app        | updateShopSessionPlan rewrites only the plan cache fields                                                |
 * | member    | a member is identified by shop and email; the email is stored lowercase and trimmed                                                 | schema     | a member is identified by shop and email; the email is stored lowercase and trimmed                      |
 * | member    | a member has exactly one shop and goes with it                                                                                      | schema     | deleteShopSession cascades that shop's members only                                                      |
 * | member    | a member is on zero or more teams; delete a member and they leave their teams; nothing else structural points at a member           | schema     | delete a member and they leave their teams; nothing else structural points at a member                   |
 * | member    | no history: re-adding a deleted email mints a new id; run history keeps the old email as a snapshot in the object                   | app        | addMember after deleteMember mints a new id                                                              |
 * | member    | a member's access is the row: no role, no state; sign-in identity is the email                                                      | app        | findMemberAccess is none for a deleted member                                                            |
 * | team      | a team is identified by its name within a shop, case-insensitively; the name is trimmed and non-empty                               | schema     | a team is identified by its name within a shop, case-insensitively; the name is trimmed and non-empty    |
 * | team      | a team has exactly one shop and goes with it                                                                                        | schema     | deleteShopSession cascades that shop's teams                                                             |
 * | team      | a team has zero or more members; a membership is one row per team and member, no history; a team never crosses shops                | schema+app | setTeamMember refuses cross-shop pairs                                                                   |
 * | team      | a team delete goes to D1 first, then nulls every object pointer; a retry repairs a half-done delete                                 | app        | deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it |
 * | `User`    | better-auth's tables are better-auth's: a session and an account go with their user; a role is one of a closed set                  | schema     | hand-written migration matches better-auth's runtime expectations                                        |
 * | `Session` | expired sessions and verifications are swept on the sign-in path, never read                                                        | app        | sweeps expired Session and Verification rows on the way out                                              |
 *
 * "A team never crosses shops" is `schema+app`, not `schema`: an edge
 * points at a `Member.id` and a `Team.id` that each belong to one shop, but
 * nothing in the database compares the two shops, so a raw cross-shop edge
 * inserts; `setTeamMember` and `setMemberTeams` scope both sides through
 * the shop. A trigger would make it `schema` and is not worth a migration
 * at the current roster size.
 *
 * The uninstall row records the current behaviour: `deleteShopSession`
 * cascades D1 and nothing else, and `findOrphanShopAgentIds` exists because
 * of it. If uninstall should clear the object, that decision changes this
 * row first.
 */
export const D1_TABLES = [
  "ShopSession",
  "Member",
  "Team",
  "TeamMember",
] as const;
export type D1Table = (typeof D1_TABLES)[number];
```

Notes:

- `about` for the better-auth rows is a backticked table name, which the parser accepts when it is in `tables`. `User` and `Session` are not in `D1_TABLES`. Either add them to `tablesNamed`'s result by a second exported constant `BETTER_AUTH_TABLES` in the same file, which the tables-exist test also uses, or make the `about` rows `member`. Do the first: `export const BETTER_AUTH_TABLES = ["UserRole", "User", "Session", "Account", "Verification"] as const;` with a one-line JSDoc ("Better-auth's tables, owned by better-auth; the drift test in `auth.test.ts` pins their shape."), and `tablesNamed` takes both symbols. Then the test's second constant in section 2 is this one instead.
- The `import type * as Domain` line is only needed if you `{@link Domain.Member}` in the JSDoc; if you do not, omit it. Do link `Domain.Member` and `Domain.Team` from the two paragraphs that mention them.
- `{@link initializeSchema}` needs `import type { initializeSchema } from "@/lib/ShopAgentSchema"` for the link to resolve; add it as a type-only import.

Check: `pnpm spec print` shows the D1 rows under `D1_TABLES`. `pnpm spec check` fails only on the three not-yet-written titles.

## 8. Step 4. Tests

Create `test/integration/d1-data-model.test.ts`. Header comment in the style of `data-model.test.ts`: the `schema` and `schema+app` rows of the table on `D1_TABLES`, titles are the rule verbatim, each test writes the forbidden row with raw SQL through `env.D1` so it proves the database refuses it. Use the `afterEach` cleanup from `repository.test.ts` (delete from `TeamMember`, `Team`, `Member`, `ShopSession`). Insert rows with `env.D1.prepare(...).bind(...).run()` and expect a rejection; a helper `rejects(promise)` that asserts the promise fails is enough. D1 enforces foreign keys and `on delete cascade` by default.

Tests, titles exact:

1. `it("a shop is identified by its domain and has exactly one object", ...)`: insert two `ShopSession` rows with the same `shopAgentId`, the second is refused; insert two with the same `shop`, refused. Then, through `Repository.upsertShopSession`, upsert the same shop with a different `shopAgentId` and read it back unchanged (the `app` half).
2. `it("a member is identified by shop and email; the email is stored lowercase and trimmed", ...)`: raw insert of `" A@X.com"` is refused by the check; two members with the same shop and email are refused; the same email in two shops is allowed.
3. `it("delete a member and they leave their teams; nothing else structural points at a member", ...)`: seed a shop, a member, a team and an edge; delete the member row raw; the edge is gone, the team remains. Then `pragma_foreign_key_list` on every table in `D1_TABLES` and `BETTER_AUTH_TABLES` lists no reference to `Member` except `TeamMember.memberId`. (This is the "nothing else structural" clause, checked against the live schema rather than asserted.)
4. `it("a team is identified by its name within a shop, case-insensitively; the name is trimmed and non-empty", ...)`: `"Cut"` then `"cut"` in one shop refused; `" Cut"` refused by the check; `""` refused; `"Cut"` in two shops allowed.
5. `it("the migrations create exactly D1_TABLES and better-auth's tables", ...)`: `select name from sqlite_master where type = 'table'`, minus names starting with `_cf_`, `sqlite_` and `d1_migrations`, equals the union of the two constants as sets.

The `schema+app` cross-shop row is pinned by the existing `setTeamMember refuses cross-shop pairs`; do not write a raw test that asserts the database refuses it, because it does not. The two cascade rows are pinned by existing `repository.test.ts` titles; leave them.

Check: `pnpm spec check` green, `pnpm test` green.

## 9. Step 5. Align the JSDoc

The rule for every site: a structural D1 rule is stated once, in the table on `D1_TABLES`. A site that used to state it either deletes the sentence or replaces it with a link, `{@link D1_TABLES}` from TypeScript or "the data model on `D1_TABLES`, `D1Schema.ts`" from SQL. A site keeps what explains its own code (why a query is shaped this way, which D1 path it reads through). Go through these in order.

1. **`migrations/0001_init.sql`.** The comment block above `Member` and the one above `Team` are the old spec. Reduce each to SQL rationale plus a one-line pointer:
   - `Member`: keep "Uniqueness is among existing rows only, so re-adding an email mints a new id" as the reason there is no soft delete; add `-- The rules are on D1_TABLES (src/lib/D1Schema.ts).`; delete the sentences about run history snapshots and `TeamMember` cascading (both are rows now, one here and one on the object).
   - `Team`: keep why teams are in D1 not the object (identity, referential integrity both ways, opaque id from the object); delete the paragraph on nulling pointers and history (a row on each side now). Correct the `TeamMember` comment: "a team never crosses shops" does not hold by construction; the foreign keys give one shop per side and `setTeamMember` compares them. Say so in one sentence and point at the row.
   - The `ShopSession` table has no comment. Add one line: `-- shopAgentId is set once; upsertShopSession never rewrites it. Rules on D1_TABLES.`
   - Leave the better-auth block; it is about better-auth, and the drift test is its pin.
2. **`src/lib/Domain.ts`.**
   - `Member` JSDoc: keeps the merchant copy sentence ("delete a member and they leave their teams") because the glossary rule says copy lives on the concept. Delete the structural sentences (cascade, snapshot mechanics, new id on re-add) and replace with "Structure on {@link D1_TABLES}; how run history survives the delete is a row on {@link initializeSchema}." Keep the "email-keyed with no userId" paragraph on `MemberId`: it is why, not what.
   - `Team` JSDoc: same treatment. Keep the merchant copy and the "team with nobody on it is valid" paragraph (behaviour). Delete the list of which tables get nulled; link to the D1 row for the order and the object rows for what is nulled.
   - `TeamName`, `Email`: keep; they explain the decode, not the row.
   - `UserRole`: keep the reference to the migration; it explains why the enum has two values.
   - `tierOf`: the paragraph on "re-adding mints a new id" cites the migration file; cite the row instead ("the member row on {@link D1_TABLES}").
   - Glossary noun table: add the `shop` row (section 2).
3. **`src/lib/Repository.ts`.**
   - `deleteMember` JSDoc: "`TeamMember` cascades" is the row; keep the sentence about sessions not being revoked and the guard rejecting on the next request (behaviour), replace the run-history sentence's citation of `initializeSchema` with a link to the D1 member row plus the object row.
   - `deleteTeam` JSDoc: keep "only `ShopAgent.deleteTeam` calls this" and the roster-read-before-delete reason; the "D1 half of a team delete" sentence links to the D1 team-delete row.
   - `setMemberTeams` and `setTeamMember`: keep the cross-shop scoping explanation; add "which is what holds the cross-shop half of the team row on {@link D1_TABLES}".
   - `upsertShopSession`: keep the billing reasoning for omitting `shopAgentId`; add one clause that this is also the `app` half of the shop row.
4. **`src/lib/ShopAgent.ts`.** `deleteTeam` JSDoc: keep the race analysis whole (it is why the order is D1 first, which is the reasoning the row cannot carry); its first sentence links to the D1 row.
5. **`src/lib/ShopAgentSchema.ts`.** The three cross-store rows (`a definition task's team points to a D1 row`, `a run task's team is both`, `who did what is a snapshot`) do not change text. Add to the vocabulary paragraph the D1 counterpart phrase: `a delete that cannot share the object's transaction "deletes here first, then nulls every object pointer", stated on the D1 side ({@link D1_TABLES})`. Add one sentence after the table: "The other half of each cross-store row is on `D1_TABLES` (`D1Schema.ts`)."
6. **`src/lib/Auth.ts`** and **`src/lib/MemberAccess.ts`**: read their JSDoc for restated member rules (email as identity, row equals access). Replace a restatement with a link; keep anything about the sign-in flow.

After this step, grep for the phrases "mints a new id", "TeamMember cascades", "collate nocase" and "D1 first" outside `D1Schema.ts`, the migration and the tests. Each remaining hit is either a link or an explanation of code at that site; if it is a restated rule, fix it.

Check: typecheck, lint (`rules-lint` refuses retired words; the new JSDoc must not say "run" for a workflow instance), test.

## 10. Step 6. AGENTS.md

1. The data-model bullet becomes: "The data-model tables are the spec for both stores: the JSDoc on `initializeSchema` (`src/lib/ShopAgentSchema.ts`) for the Durable Object and on `D1_TABLES` (`src/lib/D1Schema.ts`) for D1. One row per structural rule, in the glossary's words, with `holds by` (schema, app, schema+app) and `pinned by` (a test title). `pnpm spec check` parses both and refuses a title no test carries. A structural change starts at the row, then the DDL or migration and the write paths, then the pinned test. A cross-store rule has a half on each table: the pointer's side says what dangling means, the row's side says what its delete does and in what order. A failing pinned test means the row and the code disagree; fix one of them, never delete the test. Behavioural rules stay on the `Domain` symbol."
2. The Screens bullet and the Commands block say `pnpm spec check` / `pnpm spec print`, with the description updated to name both data models.
3. The first bullet's parenthetical `(runActions, taskActions in src/lib/Domain.ts)` is unchanged.

## 11. Step 7. Restart and look

Tell the user: restart the dev server (`pnpm app:dev`), and run `pnpm d1:reset` first only if section 4 said so. When it is up, use Chrome MCP (or `pnpm playwright-cli`) against `http://localhost:$(pnpm port)` to open the members page and the teams index, add a team, add a member to it, delete the team, and confirm the members page still lists the member with no team. This exercises every D1 write path the JSDoc changes touched; nothing should differ. Then run `npm run test:e2e --` once.

## 12. Deviations and issues

Record here anything that did not go as written: a step done differently and why, a row whose `holds by` came out different from the table above, a title that had to change, a JSDoc site not listed in step 5 that restated a rule, a test that could not be written as described (for example if D1 in the test pool does not enforce a constraint the plan assumes). One bullet each, dated. Empty means everything went as written.

- 2026-09-27: `D1Schema.ts` has no imports. The plan's `import type * as Domain` and `import type { initializeSchema }` are refused by oxlint `no-unused-vars` (a JSDoc `{@link}` is not a use); the repo already writes cross-module `{@link Domain.X}` without imports (`currentWhere.ts`), so the links are written the same way.
- 2026-09-27: `tablesNamed(source, symbols)` takes a list of symbols, per the note in step 3, so one call reads `D1_TABLES` and `BETTER_AUTH_TABLES`.
- 2026-09-27: four pinned titles were missing after step 3, not three: the shop row's title is new too.
- 2026-09-27: the JSDoc on `D1_TABLES` gained a paragraph on why the shop row is `schema+app` (section 2's correction), and ends by pointing at `initializeSchema` for the other half of each cross-store row.
- 2026-09-27: step 5 also touched `Domain.actorIsMember`, which restated "re-adding mints a new id" as its reason; it now cites the member row on `D1_TABLES`. `Repository.deleteMember` (interface JSDoc) and `Repository.createTeam` were read: the first now links the member rows; the second explains its conflict check and was left.
- 2026-09-27: the tables-exist test reads `sqlite_master` without trouble in the test pool; the foreign-key test asks `pragma_foreign_key_list` with a constant argument per table, because D1's authorizer refuses a dynamic one (as `auth.test.ts` notes).
- 2026-09-27: step 7's manual click-through was not done separately. The dev server was already up and every app-code change is JSDoc, so the E2E suite ran against it instead; `teams.spec.ts` ("creates, staffs, renames, and deletes a team") and `members.spec.ts` cover the same D1 write paths. 66 passed.

## 13. Final report

When done, report in this order:

1. Whether typecheck, lint, test and E2E are green, with output for anything that is not.
2. Whether the user must run `pnpm d1:reset` (only if DDL changed; list the lines) and that the dev server must be restarted.
3. The files created, renamed and changed, one line each.
4. The `pinned by` column as landed: every row's title and which test file carries it.
5. Section 12 verbatim.
6. That `docs/d1-data-model-spec-research.md`, `docs/d1-data-model-spec-plan.md`, `docs/data-model-spec-research.md` and `docs/data-model-spec-plan.md` can be deleted.

- 2026-09-27 (review): `tierOf` said the email was "the snapshot that row calls the durable one", which the D1 member row does not say; it now cites the snapshot row on `initializeSchema`. Three JSDoc lines left overlong by the link edits (`Repository.deleteMember` interface, `upsertShopSession`, `actorIsMember`) were rewrapped. The after-table sentence on `initializeSchema` is a `{@link}` like the one in its vocabulary paragraph. Step 5.6 (`Auth.ts`, `MemberAccess.ts`) was read and left: neither restates a member rule; `MemberAccess` explains why a hit proves install and `Auth` explains why the sweep runs where it does.

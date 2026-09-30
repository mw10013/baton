# Plan: store every Baton time as epoch-ms integers

Implements the decisions in `docs/timestamp-representation-research.md` (section 5, all accepted
2026-09-30). Written for an implementing agent. Read `AGENTS.md` first; its rules apply
throughout and are not repeated here except where a step depends on one. Read the research doc
before starting: it has the inventory and the reasons this plan does not restate.

## Ground rules for this change

- No new migration file. Edit `migrations/0001_init.sql` in place. After the schema change, run
  `pnpm dev:reset` yourself; restart or reset the dev server whenever you need to
  (`pnpm dev:start`, `pnpm dev:stop`, `pnpm dev:reset`). Do not ask first.
- Local only. Do not touch staging or production D1, do not deploy, do not push. Recreating the
  remote databases is the user's step.
- Do not commit. Leave the work in the tree.
- Run `pnpm fmt` at the end and keep every file it touches.
- Never delete or move a file under `docs/`.
- Leave better-auth's tables (`UserRole`, `User`, `Session`, `Account`, `Verification`) and the
  `agents` SDK's `cf_agents_*` tables exactly as they are. `sweepExpiredAuth` in
  `src/lib/Repository.ts` keeps its ISO comparison.
- Record every departure from this plan, and every problem met, in section "Deviations and
  issues" at the bottom of this file. Do not silently adapt.

## Outcome

When done:

1. `Member.createdAt`, `Team.createdAt` and `TeamMember.createdAt` are `integer not null` in D1,
   written as epoch milliseconds, and read as numbers.
2. The rule "Baton stores every time as epoch-ms integers" is stated once, in the JSDoc on
   `EpochMillis` (`src/lib/domain/Platform.ts`), with the vendor exception. The DDL comments in
   `initializeSchema` and `0001_init.sql` link to it in one line and do not restate it.
3. A test whose title is the rule checks every `*At` column of every Baton table in both stores
   is `integer`.
4. `LocalDateTime`, `formatDateTime`, `formatTime` and `formatRelative` take `number`, not
   `string | number`.
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; the members, teams and team screens show the
   same dates they did before.

## The rule text

Use this wording, adjusted only for JSDoc form. It is the test title too, so keep the test title
and the first sentence of the JSDoc identical:

> Baton stores every time as epoch-ms integers in a column whose name ends in At

JSDoc body to follow that sentence, in substance:

- "Baton" means the tables Baton writes the DDL for: `D1_TABLES` in D1 and every table in
  `initializeSchema`.
- A vendor's table stores time as the vendor writes it and Baton reads it through the vendor's
  API or a decoding schema: better-auth writes ISO 8601 text through its adapter
  (`refs/better-auth/packages/core/src/db/adapter/factory.ts`, the `supportsDates` branch), and
  the `agents` SDK writes epoch seconds in its `cf_agents_*` tables.
- Why milliseconds: the source is milliseconds (`Clock.currentTimeMillis`, `Date.now()`, this
  schema's decode), integer comparison needs no format discipline, and seconds would lose order
  within a second (a shop can place several orders in the same millisecond, per the
  `ShopOrder_processedAt` index comment).
- What `EpochMillis` itself does (decode a Shopify `DateTime` to that number) stays, after the
  rule. Keep the existing `NaN` reasoning.

Per `AGENTS.md`, the JSDoc must not reference `docs/`.

## Step 0: ground yourself

Read: `docs/timestamp-representation-research.md`; the JSDoc on `EpochMillis`
(`src/lib/domain/Platform.ts`); the DDL comment at the top of the `initializeSchema` SQL
(`src/lib/ShopAgentSchema.ts`, "Every table stores time as epoch-ms integers, not D1 Team's ISO
text"); `migrations/0001_init.sql`; `Member`, `Team`, `TeamDetail` in `src/lib/domain/ShopWork.ts`;
`src/lib/format.ts`; `src/components/LocalDateTime.tsx`; `test/integration/d1-data-model.test.ts`
and `test/integration/data-model.test.ts`.

Then run `pnpm typecheck`, `pnpm lint` and `pnpm test` once so you know the baseline. Record any
failure that exists before your change in the deviations section.

Another plan, `docs/stored-column-plan.md`, renames `Run.status` and `membersHighWater` and edits
comments in `initializeSchema`. If it has landed before you start, the line numbers and some
comment text will differ from what this plan quotes; work from the current text. The two plans do
not change the same columns.

## Step 1: the schema

In `migrations/0001_init.sql`, change `createdAt text not null` to `createdAt integer not null` in
`Member`, `Team` and `TeamMember`. Leave `Member_shop_createdAt_idx` as it is.

Add one comment line above `Member` (the first Baton table after `ShopSession` that has a time)
saying Baton's times are epoch-ms integers, the rule on `EpochMillis` in
`src/lib/domain/Platform.ts`. The existing better-auth comment ("Dates are ISO-8601 text
(better-auth writes toISOString())") stays; it describes the vendor's side.

## Step 2: the write paths

In `src/lib/Repository.ts`, five sites build the time as
`new Date(yield* Clock.currentTimeMillis).toISOString()`: `addMember`, `setMemberTeams`,
`createTeam`, `setTeamMember`, `addTeamMembers`. Replace each with the number itself
(`yield* Clock.currentTimeMillis`). Keep the variable name `createdAt`.

Do not change `sweepExpiredAuth`: its `now` compares against better-auth's `expiresAt`, which is
ISO text.

Search `src/`, `scripts/`, `e2e/` and `test/` for any other writer of these three columns (seed
code, raw inserts) and convert it the same way.

## Step 3: the read shapes

In `src/lib/domain/ShopWork.ts`:

- `Member.createdAt`: `Schema.String` → `Schema.Number`.
- `Team.createdAt`: `Schema.String` → `Schema.Number`.
- `TeamDetail` members' `inTeamSince`: `Schema.NullOr(Schema.String)` →
  `Schema.NullOr(Schema.Number)`. Its one-line JSDoc stays.

Let typecheck find what follows. Do not cast.

## Step 4: the screens

In `src/lib/format.ts`, narrow `formatDateTime`'s parameter to `number | null | undefined`,
`formatTime`'s and `formatRelative`'s `value` to `number`. In `src/components/LocalDateTime.tsx`,
narrow `value` to `number`.

Typecheck should then pass with no change in `app.members.tsx`, `app.teams.index.tsx` and
`app.teams.$teamId.tsx`, since the values are now numbers. If any other caller passes a string,
stop and record it in the deviations section before changing that caller: the research found
none.

## Step 5: the rule

1. Rewrite the JSDoc on `EpochMillis` in `src/lib/domain/Platform.ts` to state the rule (section
   "The rule text" above), then what the schema does. Remove the false claim "every stored
   timestamp uses, matching `ShopSession.*ExpiresAt`".
2. Replace the first two lines of the DDL comment in `initializeSchema` ("Every table stores time
   as epoch-ms integers, not D1 Team's ISO text: the two stores already differ, and one store
   should not mix.") with one line pointing at the rule. It is a SQL comment inside a template
   string, so `{@link}` does not apply; name the symbol and file, e.g. "Times are epoch-ms
   integers: the rule on `EpochMillis` (`src/lib/domain/Platform.ts`)."
3. If `src/lib/Domain.ts` or `D1Schema.ts` restates the representation anywhere, replace it with
   a link. Search for "ISO", "epoch", "toISOString" under `src/lib/` and check each hit.

## Step 6: the test

Add the test in two places, one per store, both with the exact title:

`Baton stores every time as epoch-ms integers in a column whose name ends in At`

- D1, in `test/integration/d1-data-model.test.ts`: for each name in `D1_TABLES`, read
  `select name, type from pragma_table_info('<table>')` with the table name interpolated as a
  constant. D1's authorizer rejects a pragma table function with a dynamic argument (see the
  comment in `test/integration/auth.test.ts`), so do not bind it as a parameter and do not join
  it against `sqlite_master`. Assert every column whose name ends in `At` has type `INTEGER`
  (compare case-insensitively). Also assert at least one such column was found, so an empty
  result cannot pass.
- The object, in `test/integration/data-model.test.ts`: inside `runInRepository`, after
  `runShopAgentMigrations`, list tables from `sqlite_master` where `type = 'table'`, excluding
  names that start with `sqlite_`, `_cf_` or `cf_`, and the migrator's own table (find its name
  from `SqliteMigrator`; record it in the deviations section if it is not obvious). For each,
  read `pragma_table_info` and assert the same thing. Durable Object SQLite may not have D1's
  authorizer restriction; use the same constant-argument form anyway for symmetry.

Place each test next to the existing `sqlite_master` test in its file. Update each file's header
JSDoc in one clause if it lists what the file pins.

Also update the D1 fixtures in `test/integration/d1-data-model.test.ts`: `NOW` is an ISO string
bound into `createdAt`; make it an epoch-ms number (for example `Date.UTC(2026, 0, 1)`). Search
`test/` for other ISO strings bound into `Member`, `Team` or `TeamMember` and convert them.

Before you finish, prove the test bites: temporarily change one of the three columns back to
`text` in `0001_init.sql`, run `pnpm d1:reset` and the D1 test, see it fail, restore the column,
reset again. Record the failure message in the deviations section.

## Step 7: verify

1. `pnpm dev:reset` (wipes local D1 and object state, restarts, installs, seeds).
2. `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`), `pnpm test`.
3. Open the members page, the teams index and one team page in the embedded app, with
   `pnpm playwright-cli` headless (`AGENTS.md`, "Playwright CLI"). Wait for
   `body[data-hydrated="true"]`. Check the created date and the "in team since" date render as
   dates, not as numbers or "Invalid Date". Take a screenshot of each for the report.
4. Add a member and a team through the UI; confirm the new row shows today's date.
5. `npm run test:e2e --` for the admin and member projects if they cover these screens; record
   what you ran.
6. `pnpm fmt`, keep everything it touches.

## Step 8: report

In the deviations section: what you changed that this plan did not name, anything that failed
and how you resolved it, the test-bites evidence, and the list of files changed
(`git status --short`). Then tell the user the one step left to them: recreating staging and
production D1 from the edited `0001_init.sql`.

## Deviations and issues

Record here, one entry per item: the step, what the plan said, what you did instead or what went
wrong, and why.

- Step 0: baseline `pnpm typecheck`, `pnpm lint` and `pnpm test` (562 tests) all passed before
  the change. `docs/stored-column-plan.md` had already landed; worked from the current text.
- Step 5.3: the search under `src/lib/` found no restatement of the rule in `Domain.ts` or
  `D1Schema.ts`. `Orders.ts` (`ShopOrder`) and `ShopWork.ts` (`WorkflowFields`) say their encoded
  side is "epoch-ms integers"; that describes the row, not the rule, and was left as is.
- Step 5.1: the `{@link D1_TABLES}` and `{@link initializeSchema}` in the `EpochMillis` JSDoc are
  not imported into `Platform.ts`, the same form `ShopWork.ts` already uses for both.
- Step 5.1: the milliseconds reason cites the `ShopOrder_processedAt` index for the same-millisecond
  orders (the index comment says so), with `id` as its tiebreak.
- Step 6: the object file had no `sqlite_master` test to sit beside, so the object test is the
  last test in `data-model.test.ts`. The migrator's table is `effect_sql_migrations` (the
  `table` default in `effect/src/unstable/sql/Migrator.ts`). The object test reads
  `pragma_table_info` through `sql.unsafe` with the table name interpolated, as the D1 test does.
- Step 6: oxlint warned on the first drafts of both tests (`no-await-expression-member` in the D1
  test; `no-array-method-this-argument` on `Effect.forEach` in the object test, a false positive
  that reads it as `Array.prototype.forEach`). Rewrote with a destructured `results` and
  `Effect.all(tables.map(...))`; lint is clean.
- Step 6, test bites: with `Member.createdAt` back to `text` and `pnpm d1:reset`, the D1 test
  failed with
  `AssertionError: expected [ { table: 'Member', …(2) } ] to deeply equal []`, received
  `[{ name: "createdAt", table: "Member", type: "TEXT" }]`. Restored the column; the full suite
  passes (564 tests).
- Step 7.3 and 7.4: used a temporary Playwright spec in `e2e/` (reusing `gotoApp` and
  `clickHoisted`) instead of `pnpm playwright-cli`, since the embedded app needs the admin's
  stored auth state that the e2e project already loads. It added `ts.check@example.com` and team
  `TsCheck` through the UI, then read the members table, the teams table and the Engraving team
  page. Every Added, Created and On team since cell rendered as a date (`Sep 30, 4:57 PM`), the
  new rows included. The spec was deleted afterwards and `pnpm seed` re-run to reset the data.
- Step 7.5: ran `npm run test:e2e -- e2e/members.spec.ts e2e/teams.spec.ts
e2e/member-area.member.spec.ts e2e/admin.admin.spec.ts`: 18 passed.
- Step 7.6: `pnpm fmt` changed nothing beyond this change's files.
- Files changed (`git status --short`): `migrations/0001_init.sql`,
  `src/components/LocalDateTime.tsx`, `src/lib/Repository.ts`, `src/lib/ShopAgentSchema.ts`,
  `src/lib/domain/Platform.ts`, `src/lib/domain/ShopWork.ts`, `src/lib/format.ts`,
  `test/integration/d1-data-model.test.ts`, `test/integration/data-model.test.ts`, and this file.

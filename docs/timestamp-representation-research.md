# How Baton stores time: epoch-ms integers or ISO text

Research, 2026-09-30. Follow-up from `docs/stored-column-research.md`, section 6. Question: the
two stores do not store time the same way. What exactly differs, which representation is
better, and what should change so Baton stores time one way wherever Baton owns the schema?

## 1. What the follow-up is about

SQLite has no date type. A time is stored as one of three things: `text` (ISO 8601, e.g.
`2026-09-30T14:03:11.412Z`), `integer` (seconds or milliseconds since the Unix epoch), or `real`
(Julian day). Which one a column uses is a choice each table makes, and nothing in SQLite stops
two tables, or two columns of one table, from choosing differently.

The follow-up recorded that D1 stores `createdAt` as ISO text while the Durable Object stores
every time as epoch-ms integers. That is true but not the whole picture: D1 already mixes the
two inside Baton's own tables. The split is not by store. It is by who wrote the table.

## 2. Inventory

Every time column in both stores, grouped by who owns the schema.

| store | table                                        | time columns                                                                                                                                                                                                                     | stored as                                   | owner            |
| ----- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------- |
| D1    | `ShopSession`                                | `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `planHandleExpiresAt`, `planBoundaryAt`                                                                                                                                         | `integer` epoch-ms                          | Baton            |
| D1    | `Member`                                     | `createdAt`                                                                                                                                                                                                                      | `text` ISO 8601                             | Baton            |
| D1    | `Team`                                       | `createdAt`                                                                                                                                                                                                                      | `text` ISO 8601                             | Baton            |
| D1    | `TeamMember`                                 | `createdAt` (read as `inTeamSince` on the team page)                                                                                                                                                                             | `text` ISO 8601                             | Baton            |
| D1    | `User`, `Session`, `Account`, `Verification` | `createdAt`, `updatedAt`, `expiresAt`, `banExpires`, `*TokenExpiresAt`                                                                                                                                                           | `text` ISO 8601                             | better-auth      |
| DO    | every Baton table                            | `processedAt`, `updatedAt`, `cancelledAt`, `syncedAt`, `countedAt`, `receivedAt`, `lastCompletedAt`, `cycleStartAt`, `activatedAt`, `createdAt`, `blockedAt`, `closedAt`, `startedAt`, `doneAt`, `reopenedAt`, `occurredAt`, ... | `integer` epoch-ms                          | Baton            |
| DO    | `cf_agents_*` (e.g. `cf_agents_workflows`)   | `created_at`, ...                                                                                                                                                                                                                | `integer` epoch **seconds** (`unixepoch()`) | the `agents` SDK |

So of Baton's own tables, three columns are the odd ones out: `Member.createdAt`,
`Team.createdAt`, `TeamMember.createdAt`. Everything else Baton owns is epoch-ms.

How the three got there: the migration comment on better-auth's tables says "Dates are ISO-8601
text (better-auth writes toISOString())", and `Member` and `Team` were written in the same file
next to them, following that convention. `ShopSession` did not, because its expiries come from
`@shopify/shopify-api`, which `Shopify.ts` decodes with `Schema.DateFromMillis`.

Two pieces of existing prose already claim a uniformity the code does not have:

- `EpochMillis` in `src/lib/domain/Platform.ts`: "the epoch milliseconds every stored timestamp
  uses, matching `ShopSession.*ExpiresAt`". False for `Member`, `Team`, `TeamMember`.
- The DDL comment in `initializeSchema`: "Every table stores time as epoch-ms integers, not D1
  Team's ISO text: the two stores already differ, and one store should not mix." It frames the
  difference as between stores, but D1 already mixes, inside Baton's own tables.

### How the three columns flow today

- Written in `src/lib/Repository.ts` at five sites, each as
  `new Date(yield* Clock.currentTimeMillis).toISOString()`: `addMember`, `createTeam`, and three
  `TeamMember` inserts (`setMemberTeams`, `setTeamMember`, `addTeamMembers`). The Effect
  clock gives milliseconds; the code converts them to text to store them.
- Read through `Member`, `Team` and `TeamDetail` in `src/lib/domain/ShopWork.ts` as
  `Schema.String`.
- Ordered in SQL: `order by createdAt, email` on the members page and the team page, served by
  `Member_shop_createdAt_idx`. Lexical order of `toISOString()` output equals time order, so this
  works, and would work identically on integers.
- Shown by `LocalDateTime` on three screens: `app.members.tsx`, `app.teams.index.tsx`,
  `app.teams.$teamId.tsx`. These are the only callers that pass a string; every other
  `LocalDateTime` caller (about thirty) passes a number. `formatDateTime`, `formatTime` and
  `formatRelative` in `src/lib/format.ts` take `string | number` only because of these three.
- Test fixtures in `test/integration/d1-data-model.test.ts` insert ISO strings.

Nothing does arithmetic on them. Nothing compares them across stores.

## 3. Which representation is better

For tables Baton owns, **epoch-ms integers**. The reasons, most important first:

1. **It is already the answer for 95% of Baton's columns.** The object has about twenty time
   columns, all epoch-ms; `ShopSession` has four. Moving three columns costs less than moving
   twenty-four, and it is the three that are the exception.
2. **The source is milliseconds.** `Clock.currentTimeMillis`, `Date.now()`, and
   `EpochMillis` (Shopify's `DateTime` decoded on the way in) all produce a number. Storing text
   means converting at every write and, where a caller does arithmetic, parsing on read.
3. **Arithmetic and comparison in SQL are plain.** Retention sweeps, staleness checks and plan
   expiry (`planHandleExpiresAt <= ?`, `processedAt < ?`) compare integers. On ISO text the
   comparison is lexical, which is correct only while every value has the exact same format:
   `2026-09-30T14:03:11Z` and `2026-09-30T14:03:11.000Z` are the same instant and sort
   differently. `toISOString()` is consistent, but nothing in the schema enforces it; a fixture or
   a hand-written insert can break the order silently.
4. **Milliseconds, not seconds.** The `ShopOrder_processedAt` index comment already records that
   a shop can place several orders in the same millisecond; seconds would lose order that
   milliseconds keep. The `agents` SDK's `unixepoch()` seconds are its own business.
5. **One screen type.** With all Baton times numbers, `LocalDateTime` and the formatters take
   `number` and the `string` branch goes away.

What ISO text has going for it, and why it does not decide it here:

- **Readable in a raw query.** In the D1 console or `wrangler d1 execute`, an ISO string reads as
  a date; an integer does not. Mitigated by
  `select datetime(createdAt / 1000, 'unixepoch')`, and the object's tables, which are the bulk
  of the data, are already integers.
- **SQLite's date functions take it directly.** Baton does no date math in SQL beyond
  comparisons, so this buys nothing today.
- **better-auth requires it.** True for better-auth's tables only (below).

### Vendor tables keep their vendor's format

better-auth writes through its adapter factory, which turns every `Date` into `toISOString()`
when the database does not support dates (`refs/better-auth/packages/core/src/db/adapter/factory.ts`,
the `supportsDates` branch). D1 does not, and the auth drift test pins these tables to
better-auth's expectations. Storing epoch-ms there would mean a custom adapter and fighting
every better-auth upgrade. The `agents` SDK's `cf_agents_*` tables are the same case: its DDL,
its `unixepoch()`, its readers.

This is the rule the stored-column research already settled for names: a foreign vocabulary's
table, field and literal keep their form. Time representation is one more case of it.

So the uniform rule is by owner, not by store:

> Baton stores every time as epoch-ms `integer` in a column whose name ends in `At`. A vendor's
> table (better-auth, the `agents` SDK) stores time as the vendor writes it, and Baton reads it
> through the vendor's API or a schema that decodes it.

The `At` suffix half is already true: every Baton time column ends in `At`, and every Baton
`integer` column ending in `At` is a time. That makes the rule checkable by a test that reads
`pragma table_info` for every Baton table in both stores and requires each `*At` column to be
`integer`.

## 4. Recommendations

R1. **Move `Member.createdAt`, `Team.createdAt` and `TeamMember.createdAt` to epoch-ms
integers.** Edit `migrations/0001_init.sql` in place (`text not null` → `integer not null`),
replace the five `toISOString()` writes in `Repository.ts` with `yield* Clock.currentTimeMillis`,
change `Member.createdAt`, `Team.createdAt` and `TeamDetail`'s `inTeamSince` to `Schema.Number`,
update the D1 test fixtures, then `pnpm dev:reset`. `Member_shop_createdAt_idx` and both
`order by createdAt, email` queries are unchanged.

R2. **State the rule once, on `EpochMillis`, and pin it with a test.** `EpochMillis` is the
symbol that is the concept (a time as Baton stores it), and its JSDoc already makes the claim,
wrongly today. Rewrite that JSDoc as the rule in section 3, with the vendor exception. Replace
the DDL comment in `initializeSchema` and add one to `0001_init.sql` beside `Member`, each a
single line that links to it instead of restating it. The test's title is the rule; it lists
the Baton tables of each store from `D1_TABLES` and `sqlite_master` and checks every `*At`
column is `integer`.

R3. **Narrow `LocalDateTime`, `formatDateTime`, `formatTime` and `formatRelative` to
`number`.** After R1 no caller passes a string. The narrower type makes a future ISO string a
type error at the screen instead of a silent second format.

R4. **Leave better-auth's and the `agents` SDK's tables as they are.** `sweepExpiredAuth`
keeps comparing ISO text, which is correct because better-auth is the only writer and always
writes `toISOString()`.

Not recommended:

- Epoch **seconds** for Baton columns, to match the `agents` SDK. Loses the millisecond order the
  orders keyset depends on, and would touch every object column to match a vendor.
- ISO text everywhere. It would move twenty-four columns to match three, and every sweep and
  expiry comparison would become a lexical comparison the schema cannot guard.
- A `DateTime.Utc` in the structs instead of `number`. The struct is the row
  (`docs/stored-column-research.md`, section 2); decoding to a richer type is a separate change
  with its own costs and no reader asking for it.

## 5. Decisions (2026-09-30)

Each question was put with a recommendation; every recommendation was accepted. The
implementation plan is `docs/timestamp-representation-plan.md`.

Q1. Move the three D1 `createdAt` columns to epoch-ms integers (R1)? **Accepted: yes.** They are
the only Baton-owned columns off the convention, and the change is five write sites, three schema
fields, one migration file and a fixture. Against: the D1 console shows numbers instead of dates
for these three columns, as it already does for `ShopSession`.

Q2. Make the rule by owner, not by store, with vendor tables exempt (section 3, R4)?
**Accepted: yes.** better-auth writes ISO text through its own adapter and the `agents` SDK writes
seconds through its own DDL; matching either means owning their write path. "Each store is
uniform" is unreachable in D1 without a custom better-auth adapter and in the object without
forking the SDK's tables.

Q3. Where the rule lives and how it is pinned (R2)? **Accepted: JSDoc on `EpochMillis`, one-line
links from both DDL comments, and a test titled with the rule that checks every `*At` column of
every Baton table in both stores is `integer`.** Not a row on each data-model table: that would be
two rows saying one thing, and `about` must be a vocabulary noun or a table name, which "time" is
neither.

Q4. How do staging and production D1 take the change? **Accepted: edit `0001_init.sql` in place,
as every other prototype schema change so far.** Local D1 is reset by the implementer with
`pnpm dev:reset`. Recreating the remote databases is outward-facing and is done by the user, not
by the implementing agent. If a remote database turns out to hold data worth keeping, the
fallback is a `0002` migration that rebuilds the three tables with
`cast(unixepoch(createdAt, 'subsec') * 1000 as integer)` (SQLite has no `alter column`).

Q5. Narrow the formatters and `LocalDateTime` to `number` (R3)? **Accepted: yes, in the same
change.** Once R1 lands the `string` branch is dead, and leaving it open is how a second format
would come back unnoticed. A Shopify `DateTime` string reaches a screen through `EpochMillis`.

# Teams — research

Research only, not a spec. Adds a **team** concept: a shop has many teams, a team has many members, a member can belong to many teams. Core question: **where does `Team` live — D1 or the ShopAgent Durable Object's private SQLite?**

Follows `docs/member-access-research.md` (member = a D1 row granting an email access to one shop; no roles; management only in the embedded app).

## Untangling the identity model first

Three different things currently get called "the member" in conversation. They are not the same row:

| Concept                | Where                   | Key                       | Cardinality                |
| ---------------------- | ----------------------- | ------------------------- | -------------------------- |
| **Person / login**     | D1 `User` (better-auth) | `email` (globally unique) | one per human              |
| **Membership / grant** | D1 `Member`             | `(shop, email)` unique    | one per human **per shop** |
| **Shop**               | D1 `ShopSession` + DO   | `shop` domain             | one per install            |

`migrations/0001_init.sql`:

```sql
create table if not exists Member (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  email text not null check (email = lower(trim(email))),
  createdAt text not null,
  unique (shop, email)
);
```

So:

- "Members must be globally unique" → true of **`User.email`**, not of `Member`. A `Member` row is already **shop-scoped**; the same email has one row per shop they belong to.
- Multi-shop membership is already the default (`listMemberShops(email)` → `/shop` list). Restricting one email to one shop was explicitly dropped: "constraining would be artificial".
- `Member` has **no `userId` FK** (decided 2026-08-31): the row predates the `User` row in the no-invite flow. Email is the join key everywhere.

**Consequence for teams:** a team membership should reference the shop-scoped **`Member`**, not the global `User`. A team never crosses shops, and a `Member` never crosses shops, so `TeamMember → Member` is a clean same-scope edge. There is nothing to "sync globally" — the global part (`User`) is untouched.

## What already exists that matters

- **The DO already reads D1.** `src/lib/ShopAgent.ts:185-199` builds `Repository` over `env.D1` inside `makeRunEffect`, primary semantics ("every read from inside the object is correctness-sensitive"). So "team lives in D1" does **not** mean the DO can't see it.
- **Member-area guard is D1-only.** `requireMember` (`src/lib/MemberServerFnMiddleware.ts`) does `findMember({ shop, email })` then hands off to `ShopAgentClient`. Team resolution would slot in right there.
- **Member management is embedded-only** (mw, emphatic) via `Repository.addMember/deleteMember` (`src/routes/app.members.tsx`), D1 writes.
- **Uninstall tears down both stores**: `Member` cascades from `ShopSession`; `destroyShopAgent` runs `storage.deleteAll()`. Either placement gets cleaned on uninstall.
- **Domain data (orders) lives in the DO** (`OrderRepository` over `ctx.storage`). Anything a team is _for_ — assignment, scoping what a member sees — will be a join against DO tables.
- **D1 has no transactions**, only `batch`. DO SQLite has real transactions. Neither can span the other.

## Memory diagram — today

```
D1 (shared, global)                       ShopAgent DO (one per shop)
┌───────────────────────────┐             ┌──────────────────────────────┐
│ User      email (unique)  │             │ ShopOrder                    │
│ Session/Account/Verif.    │             │ OrderLineItem                │
│ ShopSession  shop (pk) ───┼── name ────▶│ WebhookDelivery              │
│ Member  (shop,email) ─FK──┘             │ SyncState                    │
└───────────────────────────┘             └──────────────────────────────┘
        ▲ requireMember(shop,email)                ▲ ShopAgentClient / RPC
        │                                          │
   /shop/$shop server fn ──────────────────────────┘
```

## Approaches

### A — `Team` + `TeamMember` in D1, beside `Member` (recommended)

```sql
create table if not exists Team (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  name text not null,
  createdAt text not null,
  unique (shop, name collate nocase)
);

create table if not exists TeamMember (
  teamId text not null references Team (id) on delete cascade,
  memberId text not null references Member (id) on delete cascade,
  createdAt text not null,
  primary key (teamId, memberId)
);
```

```
D1                                              DO
┌────────────────────────────────┐              ┌──────────────────┐
│ ShopSession ◀─┬─ Member        │              │ ShopOrder …      │
│               └─ Team ◀─ TeamMember ─▶ Member │  (later: Job.teamId text — opaque ref)
└────────────────────────────────┘              └──────────────────┘
```

- **Referential integrity is complete.** Removing a member removes their team rows; deleting a team removes its members; uninstall cascades everything. Zero sync code.
- **Atomic writes** via one `d1.batch` in `Repository`, same as `addMember`.
- **Guard gets teams for free**: `requireMember` → one extra query `select teamId from TeamMember join Member …` → context `{ shop, teams }`. Whatever the DO is asked to do can carry `teams` as an input, exactly how `shop` is passed today.
- **Embedded teams screen** is a sibling of `app.members.tsx`, all `Repository`, no DO round trip.
- **Cross-store edge (the only one):** if DO domain rows later hold a `teamId` (e.g. a job assigned to a team) and the team is deleted in D1, the DO holds a dangling id. Mitigations, cheapest first: (1) reads treat unknown `teamId` as "unassigned"; (2) `deleteTeam` server fn also calls `shopAgent.unassignTeam(teamId)` best-effort after the D1 delete; (3) soft-delete teams. (1) is enough for a spike.
- **Cost:** the DO joining "orders assigned to my teams" does not have team _membership_ locally. Not needed — the caller resolves `teams` from D1 before the DO call, and the DO filters `where teamId in (…)`.

### B — `Team` + `TeamMember` in the DO SQLite

```
D1                              DO
┌──────────────────┐            ┌────────────────────────────────────┐
│ Member(shop,email)│ ─ email ─▶│ Team ◀─ TeamMember(teamId, email)   │
└──────────────────┘   (no FK)  │ ShopOrder … Job.teamId ─FK─▶ Team   │
                                └────────────────────────────────────┘
```

- **Pro:** co-located with domain data; `Job → Team` can be a real FK in one transaction; the "team is scoped to the shop agent" intuition is literal.
- **Con — the sync problem the question is about.** `TeamMember` must point at something in D1. Deleting a `Member` in D1 must also delete `TeamMember` rows in the DO: two stores, no atomicity, a DO RPC from `deleteMember`, plus a reconciliation path for when that RPC fails. Adding a member to a team means the DO must trust the caller that the email is a current `Member` (it can check D1 — it has `Repository` — but it's a network read per write).
- **Con:** the embedded teams screen and the members screen split across two stores and two clients; the member-area guard needs a DO call just to know the member's teams (`requireMember` becomes D1 + DO).
- **Con:** DO reads of D1 are primary-only and cold-start sensitive; putting authorization-relevant data behind a DO hop adds latency to every member request.

### C — Move `Member` into the DO too; keep a thin D1 index

Everything shop-scoped in the DO, D1 keeps `(email, shop)` only for the login gate and `/shop` list (you cannot fan out a query across all DOs to answer "which shops is this email in?").

- That thin index **is the current `Member` table**. C collapses to B plus moving `Member`'s authority — same sync problem, now for members as well. Rejected.

### D — Cache: authority in D1 (A), DO holds a read-through copy

Only worth it if the DO must evaluate team membership on hot paths without a caller (alarms, webhooks, streams). Nothing today needs that: webhooks/bulk sync are shop-scoped, not member-scoped. Defer; A upgrades to D into A+cache without schema change.

## Trade-off summary

| Criterion                        | A: D1          | B: DO             | C: DO + index |
| -------------------------------- | -------------- | ----------------- | ------------- |
| FK to `Member`                   | yes            | no                | no (index)    |
| Sync code between stores         | none           | Member→DO deletes | Member→DO too |
| Atomic team writes               | `d1.batch`     | txn               | txn           |
| FK from domain rows (Job → Team) | no (opaque id) | yes               | yes           |
| Member-area guard cost           | +1 D1 query    | +1 DO RPC         | +1 DO RPC     |
| Embedded management UI           | one store      | two stores        | two stores    |
| Uninstall cleanup                | cascade        | deleteAll         | both          |

## Recommendation

**A.** Teams are an **identity/membership** concept ("who"), not workflow data ("what"); `Member` already lives in D1 for the same reason, and the DO already reads D1 when it needs to. The one thing lost — a hard FK from a DO row to a team — is cheap to tolerate; the thing gained is never writing cross-store sync. Directionally: **D1 owns people and grants; the DO owns the shop's work.** Team is on the people side.

Details:

- **Uniqueness:** `unique (shop, name collate nocase)`; trim on the way in via a `Domain.TeamName` schema like `Domain.Email`. No slug — teams are addressed by `id` in URLs/inputs; a display name can be renamed freely.
- **`TeamMember.memberId` not `email`**: keeps the edge within the shop scope by construction (a `memberId` belongs to exactly one shop). Cascade on `Member` delete comes free.
- **Guard shape:** `requireMember` returns `{ shop, memberId, teamIds }` (one joined query). No new middleware.
- **Domain link (later):** DO rows carry `teamId text` (nullable, no FK); reads treat unknown ids as unassigned.
- **No roles on teams** (lead/manager) — same posture as `Member`.

## Naming caveat

`docs/member-access-research.md` rejected "team" partly because it "begs _can a shop have multiple teams?_ (no — SMB target, one flat member list per shop)". This request reverses that premise. Fine, but pick the word deliberately: **team** (generic), **department** (org-chart flavor, spike doc lists it as a non-goal), **station/work center** (manufacturing flavor, implies a physical place, closer to competitors' vocabulary). The data model is identical either way.

## Decisions (2026-09-02, with mw)

- **Purpose: scoping work.** Baton = made-to-order **production workflows** (not Shopify Flow, not Cloudflare Workflows): a sequential list of steps, **each step owned by a team**. Workflow/step/job rows live in the DO and reference `teamId` as an opaque D1 id — approach A as recommended.
- **Word: team.** Route-to-ship (the model Baton is a junior copy of) says "department" — too heavy for a no-code merchant. "Group" too abstract/Unix. Team = friendly SaaS vocabulary. Supersedes the earlier rejection.
- **Zero teams → sees nothing to do.** Member logs in → `/shop` lists their shops → picks one → no team means no steps own work for them → empty state. Membership is login; teams are work.
- **Management is embedded-only** (Shopify admin). Member area is where members _use_ the app. Shopify admin who wants the member-side view **adds themself as a member** (already the decided owner flow) and optionally to a team.

## Member deletion semantics (clarified)

Already answered by the existing model; restating because it came up:

- `Member` is a **per-shop grant**, `User` is the **global login**. Deleting a member in shop X deletes only `Member(X, email)`. `TeamMember` rows for that member cascade. Shop Y's grant and the `User` row are untouched.
- If that was their **last** grant, the invite-only gate (`Member` row required before a magic link is sent) means they **can no longer log in** — effectively gone, without touching `User`. A later re-add anywhere re-enables the same `User`.
- `User` rows are inert without a grant. Actual `User` purge (GDPR/erasure) is an operator action via the better-auth `admin` plugin, not a merchant action — a merchant must never be able to delete another shop's access.
- Same email added by two shops = one `User`, two `Member` rows, independent team memberships per shop. Nothing to reconcile.

## Follow-up answers (2026-09-02, mw)

- **Zero teams allowed.** No mandatory team, no auto-created default. A shop won't get far without one, but nothing enforces it.
- **Workflow shape (prototype):** a Baton workflow = n **sequential** steps; **exactly one team per step**. Parallel steps (route-to-ship "pipelines") not ruled out, not now.
- **Team deletion vs history:** open — a step without a team makes no sense, and historical workflows must stay readable. See below.
- **Member view:** first cut = focus on work the member can do / is doing / has done in that shop. Whole-job vs own-step visibility undecided.

### History conundrum — the standard answer, so it stops being a conundrum

The worry: delete a team, or move a member between teams, and historical bookkeeping breaks. It doesn't if history is written as **events that snapshot identity at the time**, and teams are **archived, not deleted**.

- **Archive, don't delete.** `Team.archivedAt text` (null = active). Archived teams vanish from pickers and the member's work queue; a step or historical record still resolves the name. Merchant-facing copy says "Archive team"; hard delete is not offered. Same trick as Shopify itself (archived products/orders).
- **Work history records who and which team, denormalized.** When a member starts/blocks/completes a step, the DO writes an event row with `memberId`, `email`, `teamId`, `teamName` **as they were at that moment**. Later moving the member to another team, renaming a team, or archiving it rewrites nothing. The event is a fact about the past, not a pointer to the present.
- **Current assignment is a pointer; history is a snapshot.** Two different things: `Step.teamId` (who owns this step _now_, live pointer, D1 id) vs `StepEvent.teamId/teamName` (who did it _then_, frozen). Only the pointer cares whether the team is active.
- **Membership changes never touch the DO.** Moving a member between teams is a D1 `TeamMember` change. The member's queue is recomputed on next request from `requireMember → teamIds`; past events keep their snapshot.
- **Workflow templates vs workflow instances (coming soon).** The template (step list + owning teams) is edited by the merchant; an instance is stamped onto a job when work starts and carries its own copy of the steps. Editing/archiving a team then affects future instances only. Route-to-ship's "pipeline" behaves this way. This cleanly bounds the blast radius of every edit.

Net: no cross-store cascade needed, no history rewrite, and "can I delete this team?" becomes "archive; the pointer-holding steps on the _template_ must be reassigned first" — a one-query check in D1 if templates live there, or a DO check if they live in the DO (they will; they are work, not people).

## Open questions

None outstanding. Resolved 2026-09-02 (mw):

- **Workflow templates live in the DO**, referencing `teamId` as an opaque D1 id (approach A throughout).
- **Archive guard: refuse.** A team cannot be archived while a template step points at it — no dangling steps. Implementation: `archiveTeam` server fn asks the DO `countStepsOwnedBy(teamId)` before the D1 update; the merchant reassigns first. (Cross-store, but read-then-write with a merchant in the loop; a race only produces a stale count, and the DO can re-check on its next template edit.)

All subject to revision as the POC progresses.

## Explicitly not now

Team roles/leads, team-level permissions, nested teams, moving members between shops, org plugin teams (`better-auth` organization plugin — already rejected).

---

# Teams — spec (phase 1)

Implementable spec derived from the research above. Decisions (2026-09-02, mw): **teams only** (workflow templates + archive guard deferred), **list + detail routes** in the embedded app, **edit `0001_init.sql`** (pre-release, `pnpm d1:reset`), **guard returns teams + member area shows them**.

## Goals / non-goals

- Goals: CRUD-ish teams per shop in D1; membership edges to `Member`; archive not delete; member-area guard exposes `teamIds`; member sees their teams or an empty state.
- Non-goals: workflow templates, `countStepsOwnedBy` archive guard (archive is **unguarded** this phase; the guard slots into `archiveTeam` later), roles, DO changes of any kind.

## Schema — `migrations/0001_init.sql` (append after `Member`)

```sql
create table if not exists Team (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  name text not null check (name = trim(name) and length(name) > 0),
  createdAt text not null,
  archivedAt text
);

create unique index if not exists Team_shop_name_uidx on Team (shop, name collate nocase);

create table if not exists TeamMember (
  teamId text not null references Team (id) on delete cascade,
  memberId text not null references Member (id) on delete cascade,
  createdAt text not null,
  primary key (teamId, memberId)
);

create index if not exists TeamMember_memberId_idx on TeamMember (memberId);
```

- `archivedAt` null = active. Uniqueness applies across active **and** archived (an archived name blocks reuse; rename the archived one first — keeps history names unambiguous).
- `TeamMember_memberId_idx` serves the guard join (`memberId → teamIds`).
- Same-shop invariant for `TeamMember` is by construction (both `Team.shop` and `Member.shop` are FK-bound); `addTeamMember` still asserts it in SQL (below) so a forged id pair cannot cross shops.

## Domain — `src/lib/Domain.ts`

```ts
export const TeamId = Schema.NonEmptyString.pipe(Schema.brand("TeamId"));
export type TeamId = typeof TeamId.Type;

export const MemberId = Schema.NonEmptyString.pipe(Schema.brand("MemberId"));
export type MemberId = typeof MemberId.Type;

// trim on decode, like Email; 1..64 chars after trim
export const TeamName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)).pipe(
      Schema.brand("TeamName"),
    ),
    { decode: Getter.transform((s) => s.trim()), encode: Getter.passthrough() },
  ),
);
export type TeamName = typeof TeamName.Type;

export const Team = Schema.Struct({
  id: TeamId,
  shop: Shop,
  name: TeamName,
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});
export type Team = typeof Team.Type;

export const TeamMember = Schema.Struct({
  teamId: TeamId,
  memberId: MemberId,
  createdAt: Schema.String,
});
export type TeamMember = typeof TeamMember.Type;

export const TeamDetail = Schema.Struct({
  team: Team,
  members: Schema.Array(
    Schema.Struct({ member: Member, inTeam: Schema.Boolean }),
  ),
});
export type TeamDetail = typeof TeamDetail.Type;

export const MemberAccess = Schema.Struct({
  shop: Shop,
  memberId: MemberId,
  teams: Schema.Array(Schema.Struct({ id: TeamId, name: TeamName })),
});
export type MemberAccess = typeof MemberAccess.Type;
```

- `Member.id` becomes `MemberId` (brand). Existing call sites use `Domain.Member["id"]` via Pick so nothing else changes.
- Mirror `Email`'s `decodeTo` shape exactly (check `Domain.ts:180` for the `Getter` import used there).

## Repository — `src/lib/Repository.ts`

New service methods; all writes through `sqlPrimary`, embedded-screen reads through `sqlPrimary` (same reason as `listMembers`), guard read through `sql` (session; same tolerance as `findMember`).

```ts
readonly listTeams: (params: { readonly shop: Domain.Shop; readonly includeArchived: boolean })
  => Effect.Effect<readonly Domain.Team[], SqlError.SqlError | RepositoryError>;
readonly createTeam: (team: Pick<Domain.Team, "shop" | "name">)
  => Effect.Effect<Domain.Team, SqlError.SqlError | RepositoryError | TeamNameTakenError>;
readonly renameTeam: (team: Pick<Domain.Team, "shop" | "id" | "name">)
  => Effect.Effect<void, SqlError.SqlError | TeamNameTakenError | TeamNotFoundError>;
readonly setTeamArchived: (team: Pick<Domain.Team, "shop" | "id"> & { readonly archived: boolean })
  => Effect.Effect<void, SqlError.SqlError | TeamNotFoundError>;
readonly findTeamDetail: (team: Pick<Domain.Team, "shop" | "id">)
  => Effect.Effect<Option.Option<Domain.TeamDetail>, SqlError.SqlError | RepositoryError>;
readonly setTeamMember: (params: { readonly shop: Domain.Shop; readonly teamId: Domain.TeamId; readonly memberId: Domain.MemberId; readonly inTeam: boolean })
  => Effect.Effect<void, SqlError.SqlError | TeamNotFoundError>;
readonly findMemberAccess: (member: Pick<Domain.Member, "shop" | "email">)
  => Effect.Effect<Option.Option<Domain.MemberAccess>, SqlError.SqlError | RepositoryError>;
```

Errors (add beside `RepositoryError`, same `Schema.TaggedError` style):

```ts
export class TeamNameTakenError extends Schema.TaggedError<TeamNameTakenError>()(
  "TeamNameTakenError",
  { shop: Domain.Shop, name: Domain.TeamName },
) {}
export class TeamNotFoundError extends Schema.TaggedError<TeamNotFoundError>()(
  "TeamNotFoundError",
  { shop: Domain.Shop, teamId: Domain.TeamId },
) {}
```

SQL sketches (lowercase, positional via tagged template):

```ts
// createTeam — detect the unique violation, don't pre-check (race-free)
yield* sqlPrimary`insert into Team (id, shop, name, createdAt, archivedAt) values (${id}, ${shop}, ${name}, ${createdAt}, null)`.pipe(
  Effect.catchIf(isUniqueViolation, () => new TeamNameTakenError({ shop, name })),
);
// isUniqueViolation: SqlError whose cause message contains "UNIQUE constraint failed: Team.shop, Team.name" — verify exact D1 text in the integration test before relying on it.

// renameTeam
const result = yield* sqlPrimary`update Team set name = ${name} where id = ${id} and shop = ${shop}`.raw;   // check meta.changes === 0 → TeamNotFoundError; unique violation → TeamNameTakenError

// setTeamArchived
update Team set archivedAt = case when ${archived} then coalesce(archivedAt, ${now}) else null end where id = ? and shop = ?

// findTeamDetail — one round trip via batch-free join, decoded to TeamDetail
select m.id, m.shop, m.email, m.createdAt, tm.teamId is not null as inTeam
from Member m left join TeamMember tm on tm.memberId = m.id and tm.teamId = ?
where m.shop = ? order by m.createdAt, m.email
-- plus: select * from Team where id = ? and shop = ?  (Option.none if missing)

// setTeamMember (inTeam=true) — the shop assertion is in the insert-select, so a cross-shop pair inserts zero rows
insert into TeamMember (teamId, memberId, createdAt)
select t.id, m.id, ? from Team t join Member m on m.shop = t.shop
where t.id = ? and t.shop = ? and m.id = ? and t.archivedAt is null
on conflict do nothing
-- (inTeam=false)
delete from TeamMember where teamId = ? and memberId in (select id from Member where id = ? and shop = ?)

// findMemberAccess — replaces findMember in the guard; one query, session client
select m.id as memberId, t.id as teamId, t.name as teamName
from Member m left join TeamMember tm on tm.memberId = m.id
left join Team t on t.id = tm.teamId and t.archivedAt is null
where m.shop = ? and m.email = ? order by t.name collate nocase
-- zero rows → Option.none; rows with null teamId collapse to teams: []
```

- `.raw` / `meta.changes`: confirm the D1 sql client exposes changed-row count (see `refs/effect` `unstable/sql` + `D1Session.ts`). If not, fall back to `select 1` after update.
- Keep `findMember` for other callers; the guard moves to `findMemberAccess`.
- JSDoc per method only where the D1Primary/D1Session choice or a subtle SQL trick (insert-select shop assertion) needs reasoning, matching the existing style.

## Guard — `src/lib/MemberServerFnMiddleware.ts`

```ts
export const requireMember = (input: {
  readonly shop: string;
  readonly email: Domain.Email;
}) =>
  Effect.gen(function* () {
    const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(input.shop);
    const access = yield* (yield* Repository).findMemberAccess({
      shop,
      email: input.email,
    });
    return yield* Option.match(access, {
      onNone: () => Effect.fail(notFound()),
      onSome: Effect.succeed,
    });
  });
```

- Return type changes from `Shop` to `MemberAccess`. Update `shop.$shop.tsx` (and any other `requireMember` caller — grep) to destructure `{ shop }`. Behavior for non-members unchanged (`notFound`).

## Embedded UI

### `src/routes/app.teams.tsx` — list

- Loader `getTeams({ includeArchived })` (search param `?archived=1`, validated with `Schema`), via `shopifyServerFnMiddleware` + `Repository.listTeams`.
- Server fns: `createTeamFn({ name })`, `renameTeamFn({ teamId, name })`, `setTeamArchivedFn({ teamId, archived })`. Validators `Schema.toStandardSchemaV1(...)` with `Domain.TeamName`-compatible input (raw string; decode inside handler like `decodeEmail`).
- Page: `<s-page heading="Teams">`; "Create team" section with one text field (pattern = `app.members.tsx` form + `useMutation` + `router.invalidate`); table of teams: name (link to `/app/teams/$teamId`), member count (add `memberCount` to `listTeams` via correlated subquery), created, Archive/Restore button; "Show archived" toggle.
- Errors: `TeamNameTakenError` → field error "A team with that name already exists." via `mutationErrorMessage` / `fieldError` (check how `form.ts` maps tagged errors; extend if it only knows `Email`).
- Nav: add `<s-link href="/app/teams">Teams</s-link>` in `app.tsx` after Members.

### `src/routes/app.teams.$teamId.tsx` — detail

- Loader `getTeamDetail({ teamId })` → `Repository.findTeamDetail`; `Option.none` → `notFound()`.
- Page: heading = team name, subdued "Archived" badge if archived; inline rename field; section "Members" listing every shop member with an `s-checkbox` bound to `inTeam`; toggling calls `setTeamMemberFn({ teamId, memberId, inTeam })` then invalidates. Checkboxes disabled while archived (server also refuses: insert-select filters `archivedAt is null`; removal still allowed).
- Empty state when the shop has no members: link to `/app/members`.

## Member area — `src/routes/shop.$shop.tsx`

- Loader already calls `requireMember`; return `{ shop, teams: access.teams, ... }`.
- Render a "Your teams" section: list names; if empty → `<s-banner>`-style empty state: "You're not on a team yet. Ask the shop owner to add you to a team to see work." (Copy mirrors the decision "zero teams → sees nothing to do".)
- No new server fn; no DO call.

## Tests

- `test/integration/repository.test.ts`: create/list (nocase uniqueness, archived excluded by default, included with flag), rename conflict → `TeamNameTakenError`, archive/restore idempotent, `setTeamMember` cross-shop pair inserts nothing, archived team refuses add, member delete cascades `TeamMember`, shop delete cascades `Team`, `findMemberAccess` returns `teams: []` for teamless member and excludes archived teams, `Option.none` for non-member.
- `test/integration/member-area.test.ts`: `/shop/$shop` loader shape includes `teams`; non-member still `notFound`.
- `test/integration/auth.test.ts` schema drift test: unaffected (only better-auth tables), but run it.
- Browser/e2e: optional smoke — create team, add member, see team on member page (`api.e2e.seed.ts` may need a `teams` seed hook).

## Implementation order

1. Migration + `Domain` types → `pnpm d1:reset`, `pnpm typecheck`.
2. `Repository` methods + errors + integration tests.
3. `requireMember` → `MemberAccess`; fix callers; member-area test.
4. `app.teams.tsx`, `app.teams.$teamId.tsx`, nav link.
5. `shop.$shop.tsx` teams section.
6. `pnpm typecheck && pnpm lint && pnpm test`.

## Deferred hooks (so phase 2 is additive)

- `archiveTeam` becomes: `shopAgent.countStepsOwnedBy(teamId)` → refuse if > 0 → `setTeamArchived`. Only the server fn changes; repository API stays.
- DO rows carry `teamId text` (opaque); event rows snapshot `teamId, teamName, memberId, email`.

# Member archive — spec

Spec date: 2026-09-04. Implements the decision in `seed-revamp-research.md` →
"Member delete is a hole". Mirrors the team archive already in the code
(`Team.archivedAt`, `Repository.setTeamArchived`, `src/routes/app.teams.index.tsx`).

Written to be handed to an implementer with no other context than this repo.
Where this spec and the code disagree, the code's existing conventions win and
the spec should be amended.

## Problem

`WorkflowRunStep.startedBy` / `completedBy` and the block flag's `by` hold a D1
`Member.id` as bare text — no foreign key, no email snapshot (`src/lib/ShopAgent.ts`
`initializeSchema`, `src/lib/WorkflowRunRepository.ts` `startStep` /
`completeStep` / `blockRun`). `ShopAgent.listQueue` resolves `startedByEmail` by
reading the live roster through `Repository.listMembers` and mapping by id.

`Repository.deleteMember` is `delete from Member where shop = ? and email = ?`,
cascading `TeamMember`. It is what the Members page "Remove" button calls. After
it runs, every step that member started or completed resolves to nobody, and
re-adding the email mints a new `Member.id`, so the old ids never resolve again.

Teams solved the same problem with `archivedAt` ("a team that ever owned work
must stay resolvable by name forever", `migrations/0001_init.sql`). Members get
the same treatment.

## Goals / non-goals

- **Goals.** (1) A merchant archives a member instead of deleting; the row and
  id survive. (2) An archived member cannot sign in, cannot reach `/shop/*`, and
  is not offered as someone to assign. (3) Re-adding an archived email restores
  the same row. (4) History keeps resolving: `startedByEmail` for an archived
  member still shows their email. (5) The dev seed can produce archived members.
- **Non-goals.** Hard delete of any kind (including "delete if never worked").
  GDPR erasure (out of scope until a compliance webhook needs it; would be a
  separate "anonymize email in place" operation, not a row delete). A member
  archive guard like `archiveTeam`'s "still owns steps" check — members own
  nothing structural, so archive is always allowed. Reassigning or releasing
  steps an archived member had started. Auditing who archived whom.
- **No migration file.** Prototype: edit `migrations/0001_init.sql` in place
  and `pnpm d1:reset`. Nothing is deployed.

## Vocabulary

| Concept                                | Merchant copy                       | Code                    |
| -------------------------------------- | ----------------------------------- | ----------------------- |
| Member whose access has been revoked   | "Archived" badge; button "Archive"  | `Member.archivedAt` set |
| Giving access back                     | button "Restore"                    | `archivedAt = null`     |
| Adding an email that is archived       | "Add member" (same button as today) | `addMember` un-archives |
| Member who may sign in and see a queue | no special copy                     | `archivedAt is null`    |

## Rules (normative)

```text
Member.archivedAt text          null = active; ISO-8601 like Team.archivedAt
nothing deletes a Member row    (ShopSession cascade excepted — that is uninstall)
unique (shop, email)            unchanged; spans active and archived

may sign in / be listed as a shop of theirs / enter /shop/*  ⇔  archivedAt is null
may be added to a team                                        ⇔  archivedAt is null  (removal always allowed)
resolves as an actor on run history                           ⇔  row exists          (archived included)
addMember on an existing row                                  ⇒  archivedAt = null   (restore), id unchanged
setMemberArchived(archived = true)                            ⇒  archivedAt = coalesce(archivedAt, now)
setMemberArchived(archived = false)                           ⇒  archivedAt = null
```

Archiving does not touch `TeamMember` edges. The member stays on their teams
for history (team detail shows them, badged); active-roster reads filter them
out by `archivedAt`, the same way `findMemberAccess` joins archived teams away.

A step an archived member had started keeps `startedBy`; `completeStep`'s
`coalesce(startedBy, ?)` already lets a teammate finish it. No release is
needed.

## Schema

`migrations/0001_init.sql`, `Member` table — add one column, and add a comment
in the style of the `Team` comment above it:

```sql
create table if not exists Member (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  email text not null check (email = lower(trim(email))),
  createdAt text not null,
  archivedAt text,
  unique (shop, email)
);
```

Comment to carry: archivedAt (null = active) is the merchant-facing delete; run
history in the ShopAgent references `Member.id` with no FK, so nothing hard
deletes a member that may have worked. Uniqueness spans active and archived so
re-adding an email restores the same id and history re-attaches.

No index: every read is by `(shop, email)` or `(shop)` and already covered.

The ShopAgent schema does not change.

## Domain (`src/lib/Domain.ts`)

- `Member` gains `archivedAt: Schema.NullOr(Schema.String)`. JSDoc: same
  reasoning as `Team.archivedAt`, pointing at the `startedBy` / `completedBy`
  columns as the reason a member can never be deleted.
- `TeamDetail.members` inherits the field through `...Member.fields`; nothing
  else to add.
- `MemberAccess` unchanged (an archived member never resolves to one).

## Repository (`src/lib/Repository.ts`)

New error, beside `TeamNotFoundError`:

```ts
export class MemberNotFoundError extends Schema.TaggedError<MemberNotFoundError>()(
  "MemberNotFoundError",
  { shop: Domain.Shop, email: Domain.Email },
) {}
```

| Function            | Change                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listMembers(shop)` | **Returns archived members too.** Order `archivedAt is not null, createdAt, email` (active first, like `listTeams`). Rationale in JSDoc: the queue's actor roster (`ShopAgent.listQueue`) must resolve archived ids, and the Members page shows both; callers that want only active filter in memory.                                                                   |
| `addMember`         | `on conflict (shop, email) do update set archivedAt = null`. JSDoc: re-adding is restore; the id and every history reference survive. Still idempotent for an active member (`archivedAt` is already null).                                                                                                                                                             |
| `deleteMember`      | **Removed.** Replaced by `setMemberArchived`.                                                                                                                                                                                                                                                                                                                           |
| `setMemberArchived` | New. `(member: Pick<Member, "shop" \| "email"> & { archived: boolean }) => Effect<void, SqlError \| MemberNotFoundError>`. `update Member set archivedAt = <coalesce(archivedAt, now)                                                                                                                                                                                   | null> where shop = ? and email = ? returning id`; no row → `MemberNotFoundError`. Through `sqlPrimary`. Copy `setTeamArchived`'s idempotency JSDoc. |
| `findMember`        | Unchanged: returns the row whatever its state. Only tests call it; the guard uses `findMemberAccess`.                                                                                                                                                                                                                                                                   |
| `listMemberShops`   | Add `and archivedAt is null`. This is the sign-in gate (`login.tsx`), the `user.create.before` backstop (`Auth.ts`), and the `/shop` index. JSDoc: an archived member has no shops.                                                                                                                                                                                     |
| `findMemberAccess`  | Add `and m.archivedAt is null` to the `where`. Archived → `Option.none()` → the existing 404 path in `MemberServerFnMiddleware`.                                                                                                                                                                                                                                        |
| `findTeamDetail`    | Roster query becomes `where m.shop = ? and (m.archivedAt is null or tm.teamId is not null)`: archived members appear only on teams they are still on, so the screen can badge them and offer removal, never addition.                                                                                                                                                   |
| `setTeamMember`     | Insert-select gains `and m.archivedAt is null` next to `t.archivedAt is null`. The existence check after a no-op insert stays; when the member is archived and not on the team, fall through to `TeamNotFoundError` is wrong — add a second check: if the member row exists but is archived, fail with `MemberNotFoundError`. Removal branch unchanged (unconditional). |

Export `MemberNotFoundError` from the module and add it to the `Repository.of`
return where relevant. Log nothing new; these are plain writes.

## Auth (`src/lib/Auth.ts`, `src/routes/login.tsx`)

No code change. Both already go through `listMemberShops`, which now excludes
archived members, so an archived email gets the same "check your email" with no
link that a stranger gets, and `user.create.before` refuses to create a `User`
for it. `ADMIN_EMAILS` still bypasses membership; unchanged.

Existing better-auth `Session` rows for an archived member are not revoked. The
member-area guard rejects them on the next request (`findMemberAccess` →
`Option.none()`), which is the same behaviour deletion had. Document this in
the `setMemberArchived` JSDoc.

## ShopAgent (`src/lib/ShopAgent.ts`)

No code change. `listQueue` keeps calling `listMembers` and now sees archived
rows, which is the point. Update its JSDoc sentence about the roster to say
archived members are included so `startedByEmail` survives an archive.

## Members page (`src/routes/app.members.tsx`)

Mirror `app.teams.index.tsx`:

- Search schema `{ archived?: boolean }`, `loaderDeps` on it, "Show archived"
  checkbox that navigates with `search: { archived: true | undefined }`.
- Loader: `listMembers(shop)` then filter `archivedAt === null` unless
  `archived === true`. (Filter in the server fn, not the component, so the
  client never receives rows it will not show.)
- `removeMemberFn` → `setMemberArchivedFn` with validator
  `Schema.Struct({ email: Schema.String, archived: Schema.Boolean })`, calling
  `setMemberArchived`. Map `MemberNotFoundError` to a user message the way the
  teams route maps `TeamNotFoundError` ("That member no longer exists.").
- Row: `s-badge tone="info"` "Archived" beside the email when `archivedAt !== null`;
  the action button is "Archive" (tone critical, tertiary — same as today's
  Remove) for active rows and "Restore" (tertiary) for archived rows.
- Copy in the "Add member" section: replace "removing it revokes access" with
  "archiving it revokes access; archived members keep their history and can be
  restored". Adding an email that is archived restores it, so say so in the
  same paragraph.
- Empty state text unchanged ("No members yet. Add an email above to grant
  access."). It now means "no active members" when the checkbox is off; that is
  consistent with teams.
- Mutation fallback message: "Could not update the member."

## Team detail page (`src/routes/app.teams.$teamId.tsx`)

- Archived members reach the page only when `inTeam` (repository rule). Show
  the same "Archived" badge after the email label. The checkbox is enabled (so
  the merchant can remove them) but once unchecked they leave the roster on
  the next load; that is correct.
- The existing `disabled={memberMutation.isPending || (archived && !member.inTeam)}`
  stays. Nothing else.

## Dev seed (`src/routes/api.dev.seed.ts`, `e2e/seed.ts`, `scripts/seed.ts`)

`DevSeedInput.members` becomes

```ts
Schema.Array(
  Schema.Union([
    Domain.Email,
    Schema.Struct({ email: Domain.Email, archived: Schema.Boolean }),
  ]),
);
```

so every existing caller (`e2e/seed.ts` passes strings) keeps working. The
route normalises to `{ email, archived }`, adds all members, applies team
membership, and only then calls `setMemberArchived` for the archived ones —
order matters because `setTeamMember` refuses an archived member. The wipe
(`delete from Member where shop = ?`) stays: the seed is destructive by design
and local-only, and the ids it deletes belong to runs it also deletes
(`replaceWorkflows` clears `WorkflowRun`).

`e2e/seed.ts`: `seedMembers` accepts `readonly (string | { email: string; archived: boolean })[]`.
`scripts/seed.ts` is rewritten separately (`seed-revamp-research.md`); do not
change its fixture here beyond keeping it compiling.

## Tests

Integration (`test/integration/`):

- `repository.test.ts`
  - Replace "deleteMember removes the row; findMember reflects it" with
    "setMemberArchived keeps the row; findMember still finds it with
    archivedAt set".
  - "setMemberArchived is idempotent: archiving twice keeps the first
    archivedAt; restoring clears it".
  - "setMemberArchived on an unknown email fails with MemberNotFoundError".
  - "addMember on an archived email restores it with the same id".
  - "listMembers includes archived members, active first".
  - "listMemberShops omits shops where the member is archived".
  - "findMemberAccess is none for an archived member".
  - "setTeamMember refuses to add an archived member (MemberNotFoundError)
    and still removes one".
  - "findTeamDetail lists an archived member only while they are on the team".
  - The existing "…memberCount drops" test at the `deleteMember` call: change
    to remove via `setTeamMember(inTeam: false)`; archive alone must **not**
    change `memberCount` (assert that too — it documents that edges survive).
- `auth.test.ts`: "membership revocation removes the shop from
  listMemberShops" → archive instead of delete; same assertion.
- `member-area.test.ts`: "closes the shop page the moment membership is
  deleted" → archived; same 404 and listing assertions. Add: restoring via
  `addMember` reopens it (status back to 500 in that harness, per the test's
  own note about the fake offline token).
- `shop-agent-workflows.test.ts` (or `workflow-run-repository.test.ts`, whichever
  already drives `startStep` with a real member): "startedByEmail still
  resolves after the member is archived".

E2E (`e2e/members.spec.ts`): rename to "members screen adds, normalizes,
archives, and restores a member". After the duplicate-add assertion: click
"Archive", expect the empty state; tick "Show archived", expect the email with
an "Archived" badge and a "Restore" button; click "Restore", untick, expect the
email without the badge.

## Files touched

| File                                 | Change                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/0001_init.sql`           | `Member.archivedAt` + comment                                                                                                                                                                              |
| `src/lib/Domain.ts`                  | `Member.archivedAt`                                                                                                                                                                                        |
| `src/lib/Repository.ts`              | `MemberNotFoundError`, `setMemberArchived`, remove `deleteMember`, filters in `listMemberShops`, `findMemberAccess`, `findTeamDetail`, `setTeamMember`; `addMember` upsert; `listMembers` ordering + JSDoc |
| `src/lib/ShopAgent.ts`               | JSDoc only                                                                                                                                                                                                 |
| `src/routes/app.members.tsx`         | archive/restore UI, show-archived search param                                                                                                                                                             |
| `src/routes/app.teams.$teamId.tsx`   | Archived badge on roster rows                                                                                                                                                                              |
| `src/routes/api.dev.seed.ts`         | `archived` on members, ordering of archive after team membership                                                                                                                                           |
| `e2e/seed.ts`, `e2e/members.spec.ts` | type widening; archive/restore flow                                                                                                                                                                        |
| `scripts/seed.ts`                    | compile only                                                                                                                                                                                               |
| `test/integration/*.test.ts`         | as listed                                                                                                                                                                                                  |

Run `pnpm d1:reset`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`
(keep every file it touches), then `npm run test:e2e -- members`.

## Open questions

None. Two choices made here that an implementer might otherwise reopen:

- **`listMembers` returns archived rows** rather than taking
  `includeArchived` like `listTeams`. The queue join is the caller that must
  never forget archived rows, and it is easier to get right when the roster
  is simply complete. If a third caller wants only active members, add the
  parameter then.
- **Re-add restores** rather than failing with "already exists, restore
  instead". A merchant typing an email into "Add member" wants that person to
  have access; making them find the archived row first is friction with no
  safety benefit, since archive is reversible.

# Teams — research

Research only, not a spec. Adds a **team** concept: a shop has many teams, a team has many members, a member can belong to many teams. Core question: **where does `Team` live — D1 or the ShopAgent Durable Object's private SQLite?**

Follows `docs/member-access-research.md` (member = a D1 row granting an email access to one shop; no roles; management only in the embedded app).

## Untangling the identity model first

Three different things currently get called "the member" in conversation. They are not the same row:

| Concept                | Where                | Key                          | Cardinality             |
| ---------------------- | -------------------- | ---------------------------- | ----------------------- |
| **Person / login**     | D1 `User` (better-auth) | `email` (globally unique)  | one per human           |
| **Membership / grant** | D1 `Member`          | `(shop, email)` unique       | one per human **per shop** |
| **Shop**               | D1 `ShopSession` + DO | `shop` domain                | one per install         |

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

| Criterion                           | A: D1          | B: DO             | C: DO + index |
| ----------------------------------- | -------------- | ----------------- | ------------- |
| FK to `Member`                      | yes            | no                | no (index)    |
| Sync code between stores            | none           | Member→DO deletes | Member→DO too |
| Atomic team writes                  | `d1.batch`     | txn               | txn           |
| FK from domain rows (Job → Team)    | no (opaque id) | yes               | yes           |
| Member-area guard cost              | +1 D1 query    | +1 DO RPC         | +1 DO RPC     |
| Embedded management UI              | one store      | two stores        | two stores    |
| Uninstall cleanup                   | cascade        | deleteAll         | both          |

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
- **Current assignment is a pointer; history is a snapshot.** Two different things: `Step.teamId` (who owns this step *now*, live pointer, D1 id) vs `StepEvent.teamId/teamName` (who did it *then*, frozen). Only the pointer cares whether the team is active.
- **Membership changes never touch the DO.** Moving a member between teams is a D1 `TeamMember` change. The member's queue is recomputed on next request from `requireMember → teamIds`; past events keep their snapshot.
- **Workflow templates vs workflow instances (coming soon).** The template (step list + owning teams) is edited by the merchant; an instance is stamped onto a job when work starts and carries its own copy of the steps. Editing/archiving a team then affects future instances only. Route-to-ship's "pipeline" behaves this way. This cleanly bounds the blast radius of every edit.

Net: no cross-store cascade needed, no history rewrite, and "can I delete this team?" becomes "archive; the pointer-holding steps on the *template* must be reassigned first" — a one-query check in D1 if templates live there, or a DO check if they live in the DO (they will; they are work, not people).

## Open questions

None outstanding. Resolved 2026-09-02 (mw):

- **Workflow templates live in the DO**, referencing `teamId` as an opaque D1 id (approach A throughout).
- **Archive guard: refuse.** A team cannot be archived while a template step points at it — no dangling steps. Implementation: `archiveTeam` server fn asks the DO `countStepsOwnedBy(teamId)` before the D1 update; the merchant reassigns first. (Cross-store, but read-then-write with a merchant in the loop; a race only produces a stale count, and the DO can re-check on its next template edit.)

All subject to revision as the POC progresses.

## Explicitly not now

Team roles/leads, team-level permissions, nested teams, moving members between shops, org plugin teams (`better-auth` organization plugin — already rejected).

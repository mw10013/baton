# Seeding development data: members, teams, workflows

Research only. Goal: one command (or one HTTP call) that puts a known,
regular set of members, teams, and workflows into a dev shop
(`sandbox-shop-01.myshopify.com`) so screens have something to show.

## Where the data actually lives

| Entity                        | Store                          | Table                                     | Id                    | Notes                                                                               |
| ----------------------------- | ------------------------------ | ----------------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| Member                        | D1 (shared)                    | `Member`                                  | `crypto.randomUUID()` | `shop` FKs `ShopSession(shop)`; `unique (shop, email)`                              |
| Team                          | D1 (shared)                    | `Team` + `TeamMember`                     | `crypto.randomUUID()` | `shop` FKs `ShopSession(shop)`; `Team_shop_name_uidx` on `(shop, name)`             |
| Auth identity                 | D1                             | `User`/`Session`/`Account`/`Verification` | better-auth           | **not seeded** — created on first magic-link verify                                 |
| Workflow / WorkflowStep       | ShopAgent DO SQLite (per shop) | `Workflow`, `WorkflowStep`                | `crypto.randomUUID()` | `WorkflowStep.teamId` is a **D1 `Team.id` with no FK** (`src/lib/ShopAgent.ts:127`) |
| WorkflowRun / WorkflowRunStep | ShopAgent DO SQLite            | —                                         | —                     | derived from orders; not seed material                                              |

So the answer to "is it just the SQLite schema?" is **no**. Members and teams
are D1 rows, workflows are DO rows, and workflow _steps_ straddle both: a step
is only meaningful if its `teamId` matches a live D1 `Team.id`
(`ShopAgent.addStep` refuses a `teamId` that is not an active team —
`src/lib/ShopAgent.ts:1519`, via `activeTeam`).

## Why "put it in the initial migration" does not work as stated

1. **D1 members/teams cannot be inserted by `migrations/0001_init.sql`.**
   `Member.shop` and `Team.shop` FK to `ShopSession(shop)`, and that row only
   exists after the app is installed on the shop and OAuth stores the offline
   token (`Repository.upsertShopSession`, `src/lib/Repository.ts:268`). A
   migration runs before any install, so the insert either fails on the FK or
   (with FKs off) orphans rows that the next install would not adopt. The
   existing e2e seed endpoint calls this out deliberately: it refuses to
   fabricate `ShopSession` for exactly this reason
   (`src/routes/api.e2e.seed.ts` JSDoc).
2. **DO SQLite workflow rows _could_ be seeded in `initializeSchema`** (it is a
   `SqliteMigrator` step, so a trailing `insert or ignore` would run once per
   shop, first time the object wakes). But the migration runs in _every_
   environment for _every_ shop, including a real production install, and it
   cannot know the D1 team ids for its shop — so seeded `WorkflowStep.teamId`
   values would have to be hardcoded constants that only line up if D1 was
   seeded with the same constants for that shop. That means the migration is no
   longer self-contained; it is half of a cross-store convention.
3. Workflows are also capped: `Domain.WorkflowLimits.maxWorkflows = 50`,
   `maxSteps = 20`, `maxTags = 20` (`src/lib/Domain.ts:350`). Six workflows is
   comfortably inside the cap but consumes six of the merchant's 50 if it ever
   ships.

## Recommended approach: extend the existing seed endpoint

`src/routes/api.e2e.seed.ts` already does 80% of this: `POST` with
`{ shop, members, teams }`, gated on `env.ENVIRONMENT === "local"` (404
otherwise), writing through `D1Primary`, wiping the shop's `Team`/`Member` and
the listed emails' `User` rows so every run starts clean. `e2e/seed.ts` is the
typed client.

Proposal:

- Add an optional `workflows` field to `E2eSeedInput`, carrying steps inline:
  `{ name, tags, steps: [{ name, team }] }[]`, where `team` names a team from
  the same payload. The fixture stays one JSON literal — nothing about the
  shape forces step-by-step calls.
- Add a single `ShopAgent.seedWorkflows` callable taking that whole array with
  `team` already resolved to a D1 `Team.id` by the route, and writing all
  workflows and steps in **one transaction**. Step `position` comes from array
  order.
- Make it destructive at the top of the same transaction:
  `delete from WorkflowRun; delete from Workflow;` (`WorkflowStep` cascades from
  `Workflow`, `WorkflowRunStep` from `WorkflowRun`). `WorkflowRun` needs its own
  delete because it deliberately has no FK to `Workflow` — a run is a snapshot
  that must survive a definition change.
- Add a `pnpm seed` script that POSTs the canonical fixture below, so it is one
  command for a human and still reusable from Playwright. Rename the route to
  `api.dev.seed` if it is no longer e2e-only (keep the `ENVIRONMENT === "local"`
  gate either way).

#### Why one callable rather than `createWorkflow` + `addStep` per step

Driving the existing callables reuses their invariant checks (workflow
writable, active team, `unique (workflowId, position)`) but costs one DO round
trip per step and can leave a half-built workflow if step 2 fails. Those checks
are moot here: team ids come from `Team` rows the route created milliseconds
earlier, and positions come from array order. The trade is a second write path
into `Workflow`/`WorkflowStep` that skips validation — acceptable because the
route is 404 outside `ENVIRONMENT === "local"`, and it buys atomicity plus a
clean wipe that the per-step path cannot express.

Cost: one schema field, one loop, one script. Benefit: no production blast
radius, no cross-store hardcoded ids, works after install (when it must), and
it is re-runnable — which a migration is not.

### If you still want it in the schema

The one place it is defensible is a `2_seed development data` migration step in
`ShopAgent` guarded on `env.ENVIRONMENT === "local"`, inserting only
`Workflow` rows (no steps, since teams are unknowable there). Steps still need
the runtime path. Not recommended: it splits the fixture in two.

## Canonical fixture (n = 6)

`i` runs 1..6. Everything derives from `i`, so any screen can be read back to
its seed row by eye.

| i   | Member     | Team     | Workflow     | Product tag  |
| --- | ---------- | -------- | ------------ | ------------ |
| 1   | `m1@m.com` | `Team 1` | `Workflow 1` | `workflow-1` |
| 2   | `m2@m.com` | `Team 2` | `Workflow 2` | `workflow-2` |
| …   | …          | …        | …            | …            |
| 6   | `m6@m.com` | `Team 6` | `Workflow 6` | `workflow-6` |

- Membership: `m{i}@m.com` is the sole member of `Team {i}`.
- Emails must be lowercase/trimmed — `Member` has
  `check (email = lower(trim(email)))`; `m{i}@m.com` satisfies it.
- Tags are lowercased and de-duped on decode (`Domain.ProductTags`), so
  `workflow-{i}` round-trips unchanged.

### Steps: the one real design choice

A workflow whose steps all belong to one team exercises nothing — the member
queue, hand-offs, and `moveStep` all want steps crossing teams. Suggested:

**Decided:** `Workflow {i}` gets **2 steps** — `Step 1` on `Team {i}`,
`Step 2` on `Team {i % 6 + 1}`. Every team then owns 2 steps across 2 different
workflows, so no queue is single-workflow and every hand-off crosses a team
boundary. Still fully predictable from `i`.

| Workflow   | Step 1 | Step 2 |
| ---------- | ------ | ------ |
| Workflow 1 | Team 1 | Team 2 |
| Workflow 2 | Team 2 | Team 3 |
| Workflow 3 | Team 3 | Team 4 |
| Workflow 4 | Team 4 | Team 5 |
| Workflow 5 | Team 5 | Team 6 |
| Workflow 6 | Team 6 | Team 1 |

### Out of scope: making queues non-empty

**Decided: the seed stops at definitions.** Workflows only produce work once
**orders** exist — a `WorkflowRun` is created when a synced line item's product
tags match a workflow's tags (`WorkflowRunRepository`). Populating the member
queue would mean either tagging sandbox products `workflow-1`…`workflow-6` in
the Shopify admin, or manual attach (`ShopAgent.attachWorkflow`). Deferred; the
seed does neither for now. The `delete from WorkflowRun` above is already in
place for when it changes.

## Answers to the direct questions

- **Shop name needed?** Yes — every row is shop-scoped. `sandbox-shop-01`
  resolves to `sandbox-shop-01.myshopify.com`; the e2e seed already derives that
  from `SHOPIFY_PREVIEW_URL`, so a `pnpm seed` script can default to it.
- **Do we need anything in D1?** Yes, and it is the majority of the seed:
  `Member`, `Team`, `TeamMember`.
- **Do we need `User` rows?** No. Sign-in creates them on first magic-link
  verify, and the invite-only backstop in `Auth`'s `user.create.before` hook
  admits any email that has a `Member` row — so seeding members is sufficient to
  make `m{i}@m.com` able to log in. `ADMIN_EMAILS` still governs the admin.
- **Is the DO SQLite schema enough?** No — see above.

## Decisions

1. **Steps** — 2 per workflow, wrapping across teams (table above).
2. **Idempotency** — destructive. The seed wipes `WorkflowRun` and `Workflow`
   before inserting, matching what it already does to `Member` and `Team`. An
   additive skip-by-name seed would preserve the previous run's hand edits,
   which is the opposite of what a reseed is for.
3. **Scope** — definitions only. No product tagging, no run attachment.

4. **Route name** — rename `api.e2e.seed` → `api.dev.seed` in the same change.
   The gate is `ENVIRONMENT === "local"`, not "tests", and once `pnpm seed`
   exists Playwright is one of two peer callers rather than the owner. Leaving
   it `e2e`-named invites someone editing tests to reshape or delete the
   prototyping fixture without realizing. The rename touches one route file and
   the fetch URL in `e2e/seed.ts` — both already in scope.

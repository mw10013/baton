# Seed revamp: naming, coverage, archived data

Research only, 2026-09-04. Supersedes the fixture half of `seed-data-research.md`
(the plumbing decisions there — one endpoint, destructive replace, local-only —
stand and are not revisited).

Goal: a fixture that (1) reads back to its seed entry by eye from any screen,
(2) covers every definition-side state the app can render today — linear
steps, stages, instructions, order workflows, archived teams and workflows,
members with no team — and (3) can be shared with Playwright instead of each
spec hand-rolling its own emails and team names.

## What exists today

`scripts/seed.ts` posts one JSON literal to `/api/dev/seed`. Fixture: `m{i}@m.com`
in `Team {i}`, `Workflow {i}` with tag `workflow-{i}` and two wrapping steps, plus
a `Necklace` workflow with stages and a `Pack & ship` order workflow on a
`Packing` team. Six of everything, unpadded.

Gaps against the goal:

| Gap                                                    | Why it matters                                                                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No archived team or workflow                           | Archived-team `teamName: null` in the editor, the archived section of the workflows index, un-archive into an occupied order slot — all unreachable without hand clicks |
| No member outside a team, no member in several         | Member area "no teams" state and multi-queue member never shown                                                                                                         |
| `Necklace`, `Pack & ship`, `Packing` break the pattern | Special names read as product data, not fixture; nothing says they are the stage / order examples                                                                       |
| Unpadded numbers                                       | `Workflow 10` sorts before `Workflow 2` the day there are ten                                                                                                           |
| Seed schema has no `archived` field                    | `DevSeedInput` and `SeedWorkflowsInput` cannot express it (`src/routes/api.dev.seed.ts`, `src/lib/Domain.ts`)                                                           |
| Playwright specs define their own constants            | `e2e/*.spec.ts` each declare `MEMBER_EMAIL`, `TEAM`, … — fine for isolation, but drift from what a dev sees locally                                                     |

## What can and cannot be archived

Checked against the schema and repositories, since the request assumed all three
entity kinds archive:

| Entity   | Archivable                           | Mechanism                                                                             | Constraint the fixture must respect                                                                                                                                                                                 |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team     | yes                                  | `Team.archivedAt` in D1; `Repository.setTeamArchived`                                 | `ShopAgent.archiveTeam` refuses a team that owns a step of a non-archived workflow. The seed bypasses that check, so the fixture must honour it by hand: an archived team may only own steps in archived workflows. |
| Workflow | yes                                  | `Workflow.archivedAt` in the Durable Object; `WorkflowRepository.setWorkflowArchived` | Archived rows keep their names; names are unique case-insensitively across active and archived. At most one **active** order workflow per shop; archived order workflows are unlimited.                             |
| Member   | yes (after `member-archive-spec.md`) | `Member.archivedAt` in D1; `Repository.setMemberArchived`                             | Archived members stay on their teams for history; the seed must add team membership **before** archiving because `setTeamMember` refuses an archived member. Re-adding an archived email restores it.               |

### Member delete was a hole

Run steps store who started and completed them as a bare `Member.id`
(`startedBy` / `completedBy`, plus the block flag's `by`), and the queue
resolves the email from the live roster. The old `Repository.deleteMember` hard
deleted the row, so every step an ex-member had worked read as done by nobody,
and re-adding the email minted a new id. This doc assumes the fix in
`member-archive-spec.md` has landed: `Member.archivedAt`, no hard delete,
re-add restores the same row, history keeps resolving. The seed input gains
`members: (email | { email, archived })[]` from that spec.

So "archive data" means archived teams, archived workflows, and archived
members.

## Naming conventions

Principles: one pattern per entity kind, zero-padded two-digit ordinal, ordinal
is the join key across kinds (member 01 ↔ Team 01 ↔ Workflow 01 ↔ tag
`workflow-01`), and any _state_ the number cannot carry goes in a word suffix so
the name still says what it is on a screen that hides the badge.

| Kind                 | Pattern              | Examples              | Notes                                                                                                                          |
| -------------------- | -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Member               | `member-NN@shop.com` | `member-01@shop.com`  | Lowercase already, so `Domain.Email` round-trips unchanged.                                                                    |
| Admin member         | `admin@shop.com`     | `Team 01` … `Team 06` |                                                                                                                                | one member across every queue |
| `member-01@shop.com` | `Team 01`            |                       | ordinary single-team member                                                                                                    |
| `member-02@shop.com` | `Team 02`            |                       |                                                                                                                                |
| `member-03@shop.com` | `Team 03`            |                       |                                                                                                                                |
| `member-04@shop.com` | `Team 04`            |                       |                                                                                                                                |
| `member-05@shop.com` | `Team 05`            |                       |                                                                                                                                |
| `member-06@shop.com` | `Team 06`            |                       |                                                                                                                                |
| `member-07@shop.com` | `Team 07 Archived`   |                       | active member whose only team is archived → member area shows no teams                                                         |
| `member-08@shop.com` | none                 |                       | member never added to a team                                                                                                   |
| `member-09@shop.com` | `Team 01`            | archived              | archived member still on an active team: badge on team detail, absent from Members list until "Show archived", sign-in refused |
| `member-10@shop.com` | `Team 07 Archived`   | archived              | archived member on an archived team: both badges, nothing active anywhere                                                      |

Archived members who have **worked** cannot be seeded: runs come from orders,
not the seed. To see an archived actor on history, sign in as
`member-09@shop.com` before archiving, start a step, then archive from the
Members page. This is the one archived state that stays manual.

Teams: `Team 01` … `Team 06` active, `Team 07 Archived` archived.

### Item workflows

Every active `Team 0i` owns steps in at least two workflows so no queue is
single-workflow, and every hand-off crosses a team (kept from the current
fixture). Stages, instructions, and step counts vary by ordinal so each workflow
is a distinct case:

| Workflow               | Tag           | Steps (team)                                                                                | Exercises                                               |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Workflow 01`          | `workflow-01` | `Step 1` (01), `Step 2` (02)                                                                | minimal linear                                          |
| `Workflow 02`          | `workflow-02` | `Step 1` (02), `Step 2` (03), `Step 3` (04)                                                 | three-step linear                                       |
| `Workflow 03`          | `workflow-03` | `Step 1` (03), `Step 2a` (04), `Step 2b` (05), `Step 3` (03)                                | one parallel stage, team repeats                        |
| `Workflow 04`          | `workflow-04` | `Step 1a` (04), `Step 1b` (05), `Step 1c` (06), `Step 2` (01)                               | parallel first stage, three wide                        |
| `Workflow 05`          | `workflow-05` | `Step 1` (05, instructions), `Step 2` (06, instructions)                                    | instructions on every step                              |
| `Workflow 06`          | `workflow-06` | `Step 1` (06), `Step 2a` (01, instructions), `Step 2b` (02), `Step 3a` (03), `Step 3b` (04) | two parallel stages, mixed instructions                 |
| `Workflow 07 Archived` | `workflow-07` | `Step 1` (07 Archived), `Step 2` (01)                                                       | archived workflow; its archived team is valid only here |
| `Workflow 08`          | `workflow-08` | none                                                                                        | zero steps → "not routing" without archive              |

Team step load (active workflows only): 01 ×4, 02 ×3, 03 ×4, 04 ×4, 05 ×3,
06 ×4. `Team 07 Archived` owns one step, in an archived workflow only, so the
`archiveTeam` invariant holds.

### Order workflows

| Workflow                     | Steps (team)                                  | Exercises                                                                   |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `Order Workflow 01`          | `Step 1` (01), `Step 2a` (02), `Step 2b` (03) | the active order workflow; a stage inside an order run                      |
| `Order Workflow 02 Archived` | `Step 1` (02)                                 | archived order workflow; un-archiving it must be refused while 01 is active |

No dedicated packing team: the point of the seed is the mechanics, and giving
`Team 01`–`03` the order steps means a member sees an order run land in the same
queue as their item runs.

### Totals

| Kind      | Count | Of which archived |
| --------- | ----- | ----------------- |
| Members   | 11    | 2                 |
| Teams     | 7     | 1                 |
| Workflows | 10    | 2                 |

Well inside `WorkflowLimits` (50 workflows, 20 steps, 20 tags).

## Products and tags

Tags select item workflows; the seed writes definitions only and never touches
Shopify (decision kept from `seed-data-research.md`). For a populated queue the
sandbox products need the tags below applied once by hand in the admin:

| Product | Tags                         | Why                                                                                 |
| ------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| 1       | `workflow-01`                | one run per item                                                                    |
| 2       | `workflow-02`                |                                                                                     |
| 3       | `workflow-03`                |                                                                                     |
| 4       | `workflow-04`                |                                                                                     |
| 5       | `workflow-05`, `workflow-07` | archived tag alongside a live one: exactly one run, proving archived does not route |
| 6       | `workflow-06`, `workflow-08` | zero-step tag alongside a live one: same proof for "not routing"                    |

The real product names in the sandbox are not in the repo; open question 1.

## Seed schema changes (implemented 2026-09-04)

Small and additive; every existing caller keeps its shape.

- `DevSeedInput.members[]` accepts `{ email, archived }` (delivered by `member-archive-spec.md`); archive runs after team membership is written.
- `DevSeedInput.teams[].archived?: boolean` (`src/routes/api.dev.seed.ts`). After
  `createTeam` + `setTeamMember`, call `repository.setTeamArchived` when true.
  Membership is written before archiving because `setTeamMember` refuses an
  archived team.
- `SeedWorkflowsInput.workflows[].archived?: boolean` (`src/lib/Domain.ts`) and
  `replaceWorkflows` writes `archivedAt = now` when true
  (`src/lib/WorkflowRepository.ts`). The route passes it through.
- Validation the seed should keep even though it bypasses the ordinary path:
  at most one non-archived `scope: "order"` workflow (otherwise the fixture
  itself breaks the invariant `OrderWorkflowExistsError` protects), and no tags
  on an order workflow.
- `e2e/seed.ts` types gain the same optional `archived`, `scope`, `stage`,
  `instructions` fields so Playwright can express the whole fixture.

## Sharing the fixture with Playwright

Two callers, one fixture, three options:

1. **Keep specs self-contained (status quo).** Each spec seeds the minimum it
   asserts on. Robust, but the local dev shop and the test shop never look alike.
2. **Move the fixture to a module both import**, e.g. `e2e/fixture.ts` exporting
   the JSON literal plus named handles (`fixture.members.admin`,
   `fixture.workflows[2]`). `scripts/seed.ts` posts it; a spec that wants the
   full shop calls `seedFixture(config)` and asserts against the handles instead
   of string literals. Specs that need a tiny world keep calling `seedMembers`.
3. Generate the fixture from a spec-side builder. Over-engineered for ~30 rows.

Recommend 2. The module lives under `e2e/` rather than `src/` so nothing in the
worker bundle imports test data, and `scripts/seed.ts` already runs under Node
with TypeScript.

## Decisions (2026-09-04)

1. **Products.** Tagged by hand in the admin. The seed never touches Shopify.
2. **`admin@shop.com` and `ADMIN_EMAILS`.** Keep them separate. `ADMIN_EMAILS`
   grants the better-auth `admin` role, a deployment concern that outlives any
   reseed; `admin@shop.com` is fixture data meaning "a member of every team".
   Coupling them would make the fixture depend on a `.env` value the seed
   cannot see or verify.
3. **Member archive.** Specced in `member-archive-spec.md`; lands first. The
   fixture then carries two archived members (`member-09` on an active team,
   `member-10` on the archived team) so both badge placements and the sign-in
   refusal are testable from a fresh seed.
4. **Order workflow name.** `Order Workflow 01` with `scope: "order"`.
5. **Step names.** `Step 2a` / `Step 2b` for steps in a shared stage. The queue
   card shows the step name and not the stage number, so the letter is the only
   thing that tells a worker (or a tester) two cards are siblings.
6. **Playwright.** Move the fixture to `e2e/fixture.ts`; `scripts/seed.ts`
   imports and posts it. Existing specs stay self-contained — a spec that seeds
   two members to test one button should not inherit ten workflows. The module
   exists so the one future "whole shop" spec (queue, order page, archived
   sections) asserts against the same names a developer sees locally.
7. **Archived naming.** Keep the `Archived` suffix in the fixture. Real
   merchants will not rename before archiving, but the fixture is not demo
   data: its job is tie-out, and archived rows surface on screens with no
   badge — a step whose team is archived just renders no team, an archived
   member appears as an actor on a completed step. The suffix makes those
   readings unambiguous. If demo-realistic data is ever wanted, that is a
   second fixture, not a change to this one.

## Open questions

All three steps landed 2026-09-04: `member-archive-spec.md`, the `archived` seed fields, and `e2e/fixture.ts` + `scripts/seed.ts`. Sequence was: (1) `member-archive-spec.md`, (2) seed schema `archived` fields,
(3) `e2e/fixture.ts` + `scripts/seed.ts` rewrite.

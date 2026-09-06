# Delete model: workflows, teams, members — spec

Spec date: 2026-09-05. Status: **ready to implement after `workflow-draft-spec.md` has landed** (2026-09-06). Written to be handed to an implementer with no other context than this repo and `CLAUDE.md`. Back-end code follows Effect v4 idioms as already used in `src/lib/Repository.ts`, `src/lib/WorkflowRepository.ts`, and `src/lib/ShopAgent.ts`: `Context.Service` repositories, `Effect.fn` named operations, `Schema.TaggedError` failures, `sql.withTransaction` for multi-statement writes, results crossing the socket as tagged unions rendered with `Match.tag`.

## Where the code is right now

### Prerequisite: the draft model

This work starts after `workflow-draft-spec.md` has landed: `Workflow` + `WorkflowStep` (what starts runs) and `WorkflowDraft` + `WorkflowDraftStep` (what the editor writes), `createDraft` / `applyDraft` / `discardDraft` / `setWorkflowActive`. "Step" below means a row in either step table unless stated.

Nothing of the delete policy exists yet. Archive is still the model for all three entities:

| Entity   | Store     | Archive today                                                                                                                                                                                                                                                               |
| -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow | DO SQLite | `Workflow.archivedAt`; `WorkflowRepository.setWorkflowArchived` refuses while `active = 1` (`WorkflowActiveError`); `ShopAgent.workflowWritable` refuses step edits on archived; `includeArchived` on `listWorkflows`; name uniqueness `collate nocase` spans archived rows |
| Team     | D1        | `Team.archivedAt`; `Repository.setTeamArchived`; `ShopAgent.archiveTeam` guard: refuses while any workflow or draft step points at it (`countStepsOwnedBy`, count → archive → re-check); `TeamArchiveResult.InUse`                                                          |
| Member   | D1        | `Member.archivedAt`; `Repository.setMemberArchived`; `addMember` un-archives on email conflict; archived member cannot sign in; still resolves as actor on run history via live roster join                                                                                 |

### What runs already snapshot

`WorkflowRun`: `workflowId` (no FK), `workflowName`, order and line-item snapshot.
`WorkflowRunStep`: `name`, `teamId` (no FK, **not null**, live pointer), `teamName` (snapshot), `instructions`, `startedBy` / `completedBy` (bare `Member.id`, **no email snapshot**), block-flag actor likewise.

Consequences:

- A run is self-sufficient with respect to its **workflow**. Deleting the workflow row (steps, draft, draft steps cascade) leaves every run renderable.
- A run is **not** self-sufficient with respect to its **teams**. `listQueue`, `startStep`, `completeStep`, `blockRun`, `dismissFlag` all select by `teamId in (member's teamIds)`. Remove the team and the step is unworkable by anyone.
- A run is **not** self-sufficient with respect to its **members**. `startedByEmail` on the queue is a live join against D1 `Member`. Remove the member and history shows nobody.

### Existing "needs attention" machinery (reuse, don't reinvent)

Already in place for a step whose team is archived or missing:

- `ShopAgent.getWorkflowDetail` resolves `teamName: null` for a step whose team is not active.
- `app.workflows.$workflowId.tsx` shows a needs-attention banner listing those steps, on the workflow and on the draft.
- `applyDraft` and `setWorkflowActive` refuse with `TeamNotActive { stepNames }`.
- `canStart` in `WorkflowRunRepository.ts` requires every step's team to be in `activeTeams`.
- `ShopAgent.activeTeam` validates the team on `addStep` / `updateStep` against the live D1 roster.

Team delete becomes one more way to enter this state, with the copy changed from "archived" to "deleted" / "unassigned".

### Cross-store facts that shape the design

- `Team` and `Member` live in D1. Steps and runs live in the ShopAgent Durable Object's private SQLite. No foreign key can cross that boundary, so every team/member pointer from a step is application-level.
- The Durable Object is single-threaded per shop. Anything done inside one callable is atomic with respect to other callables for that shop (`archiveTeam`'s JSDoc already relies on this).
- D1 is not inside the object's transaction. Any operation that touches both stores has a window between the two writes.

## Where we want to go

### Principles (decided 2026-09-05, mw)

1. **Delete, never archive.** Workflows, teams, members. `archivedAt` goes away on all three.
2. **Workflow delete cascades its runs.** Open and finished, item and order scope. No trace remains. No Off-first requirement. Confirm dialog states the counts.
3. **Team delete nulls the pointer.** Every workflow step, every draft step, and every open run step that pointed at the team becomes unassigned. Finished run steps keep their `teamName` snapshot untouched.
4. **Member delete removes membership.** `TeamMember` cascades. Run history keeps the actor as an email snapshot, not a live join.
5. **Attention state is derived, never stored.** No run error status, no flag to set and clear. A workflow, run, or team "needs attention" when a read finds the condition; fixing the condition clears it with no extra write.
6. **Empty teams are a warning, never a run-level problem.** A team with no members is valid. A workflow with steps assigned to it can still start runs, but nobody can work those steps; the team page and the steps show "No members". Adding one member fixes everything with zero data changes.
7. **Blockers become warnings.** No delete is refused for being "in use". The confirm dialog tells the merchant what will break; the merchant decides.

### Merchant model, one sentence each

- Delete a workflow and its runs go with it.
- Delete a team and its steps become unassigned until you assign another team.
- Delete a member and they leave their teams.
- Warnings, not blockers, tell you what that broke. The fix is always "assign a team" or "add a member".

### Workflows

> **Superseded by `workflow-delete-runs-spec.md` (2026-09-06):** deleting a workflow now removes the definition only — every run stays on its order and keeps working — and the confirm dialog carries no run counts. The rest of this section still describes the shipped shape.

```text
deleteWorkflow(workflowId), one DO transaction:
  delete from WorkflowRunStep where runId in (select id from WorkflowRun where workflowId = ?)   (or rely on cascade)
  delete from WorkflowRun where workflowId = ?
  delete from Workflow where id = ?          (WorkflowStep, WorkflowDraft, WorkflowDraftStep cascade)
  publish("all")
```

- Confirm dialog: "Delete <name>? N runs in progress and M finished runs will be deleted. This can't be undone." Counts come from a read at dialog-open time; staleness is harmless because the delete removes whatever exists at commit time.
- Items mid-production drop out of the floor's view. Starting a replacement workflow for them is manual (`source = 'manual'` runs via attach). The age rule (`processedAt >= workflow.createdAt`) means a replacement workflow will not pick them up automatically. Accepted.
- Turn off remains the non-destructive move: stops new runs, open runs finish. The Turn off dialog says so.
- Name is freed immediately; the one-order-workflow slot is freed immediately. Uniqueness is now among existing rows only.
- Removes: `Workflow.archivedAt`, `setWorkflowArchived`, `WorkflowActiveError`, `workflowWritable` (collapses to NotFound), `includeArchived`, `Archived` result tags, Archive/Restore UI, archived-last ordering, `archived` seed fixtures for workflows.

### Teams

```text
deleteTeam(teamId):
  1. D1:  delete from Team where id = ? and shop = ?       (TeamMember cascades)
  2. DO:  in one transaction
            update WorkflowStep      set teamId = null where teamId = ?
            update WorkflowDraftStep set teamId = null where teamId = ?
            update WorkflowRunStep set teamId = null where teamId = ? and completedAt is null (open steps only; finished keep the pointer and the name)
          publish("all")
```

**Why D1 first, then DO.** The two stores cannot share a transaction, so there is a window between step 1 and step 2. Consider a concurrent `addStep` pointing at the team:

- If its `activeTeam` check reads D1 **after** step 1, the team is gone and the write is refused. Correct.
- If its check reads D1 **before** step 1 but its write lands **before** step 2, step 2 nulls it. Correct, and step 2 is idempotent.
- The DO is single-threaded, so the write cannot interleave with step 2 itself.

The reverse order (DO first, D1 second) has a real hole: a step written between the DO cleanup and the D1 delete would validate fine and then dangle forever with nothing scheduled to clean it. D1-first closes that. The remaining risk is step 2 failing after step 1 succeeded (DO unreachable). Mitigation is the next point.

**Dangling pointers are treated as null on every read.** `teamId` pointing at a team that no longer exists in D1 renders and behaves exactly like `teamId is null`: unassigned, needs attention, the workflow cannot start runs, the step is in no queue. This makes the cross-store window harmless, makes a failed step 2 self-healing (the next read shows the truth; a later `deleteTeam` retry or a lazy repair on `getWorkflowDetail` can null it properly), and means the confirm-dialog pre-check has no correctness job at all.

**Guard removed.** `archiveTeam`'s count → archive → re-check sequence goes. `countStepsOwnedBy` / `listStepsOwnedBy` stay, extended to count open run steps too, and feed the dialog instead of a refusal.

**Confirm dialog:** "Delete <team>? N workflow steps and M in-progress steps are assigned to it. They will become unassigned. Workflows with unassigned steps stop starting for new orders, and in-progress steps wait until you assign a team."

**Bulk reassign in the dialog: not required.** Discussed and set aside (mw, 2026-09-05): nulling plus the derived warning plus per-step assign is enough. Can be added later if a real merchant hits a large cascade.

**Per-step "Assign team" on open run steps: required.** This is the remedy that makes team delete safe. Small operation: `assignRunStepTeam({ runStepId, teamId })` sets `teamId` and `teamName` from the live roster on an open run step. Guard: team exists in D1 (same `activeTeam` check as `addStep`). UI: on the order page run card, an unassigned open step shows a team picker.

**Empty team.** Team page shows "No members" badge. Workflow step assigned to a team with no members shows a warning. `canStart` does **not** check membership; `applyDraft` and `setWorkflowActive` do **not** refuse over it. A run whose ready step belongs to an empty team is simply in nobody's queue until someone joins.

### Members

```text
deleteMember(memberId):
  D1: delete from Member where id = ? and shop = ?      (TeamMember cascades; ShopSession untouched)
```

- **Prerequisite: snapshot the actor.** Add `startedByEmail` and `completedByEmail` (and the block flag's actor email, wherever that lives) to `WorkflowRunStep`, written at `startStep` / `completeStep` / `blockRun` time exactly like `teamName`. `listQueue` stops joining D1 for `startedByEmail` and reads the column.
- After that a member owns nothing structural. No guard.
- Confirm dialog warns only when true: "This will leave <team> with no members." Otherwise a plain confirm.
- Re-adding an email mints a new member id. History keeps the old email as text.
- Retained-data note: a deleted member's email lives on in run steps. Erasure, if ever required, is a separate "overwrite email in run steps" operation, not a row delete. Accepted (mw, 2026-09-05).
- Removes: `Member.archivedAt`, `setMemberArchived`, `addMember`'s un-archive-on-conflict, archived filter in member listing and sign-in, the `?archived` view on `app.members.tsx`, `member-archive-spec.md` is superseded.

### Derived attention state, where it surfaces

| Surface                             | Condition                                    | Copy                                        |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Workflow detail, workflow and draft | step with `teamId null` or unresolvable      | "Unassigned. Assign a team."                |
| Workflow detail, workflow and draft | step's team has zero members                 | "No members on <team>."                     |
| Workflow list                       | any of the above on the workflow's steps     | badge "Needs attention"                     |
| Apply / Turn on                     | unassigned step                              | refuse: `StepUnassigned { stepNames }`      |
| Apply / Turn on                     | empty team                                   | allow (warning only)                        |
| Order page run card                 | open step with `teamId null` or unresolvable | red step, team picker "Assign team"         |
| Order page run card                 | open ready step whose team has zero members  | warning "No members on <team>"              |
| Orders index                        | order with any run in the above states       | attention count / filter (fits stage strip) |
| Team page                           | zero members                                 | badge "No members"                          |

All computed at read time from `WorkflowStep` / `WorkflowDraftStep` / `WorkflowRunStep` joined against the live D1 team roster and membership counts. No new columns for state.

### Schema changes

DO SQLite (`initializeSchema`, edit in place, wipe local):

```sql
-- Workflow: drop archivedAt
-- WorkflowStep, WorkflowDraftStep: teamId text   (nullable; null = unassigned)
-- WorkflowRunStep: teamId text         (nullable; null = unassigned; finished steps keep the old id)
--                  startedByEmail text, completedByEmail text   (actor snapshots)
```

D1 (`migrations/0001_init.sql`, edit in place, `pnpm d1:reset`):

```sql
-- Member: drop archivedAt; unique (shop, email) now spans existing rows only
-- Team:   drop archivedAt; Team_shop_name_uidx unchanged in shape
```

Rewrite the JSDoc rationales on `Member`, `Team`, `Workflow` (Domain.ts) and the schema comments in `0001_init.sql` and `initializeSchema`: the reason history survives is snapshots on run rows, not kept configuration rows.

### Surfaces to touch (inventory, 2026-09-05)

- `src/lib/Domain.ts`: drop `archivedAt` from three schemas; `WorkflowStep.teamId` / `WorkflowDraftStep.teamId` / `WorkflowRunStep.teamId` nullable; new `AssignRunStepTeamInput`, `DeleteWorkflowInput`, `DeleteTeamInput`, `DeleteMemberInput`; drop `SetWorkflowArchivedInput`, `TeamArchiveResult`, `Archived` tags; `TeamNotActive` becomes `StepUnassigned`.
- `src/lib/Repository.ts` (D1): `deleteTeam`, `deleteMember` replace `setTeamArchived`, `setMemberArchived`; `listTeams` / `listMembers` lose `includeArchived`; `addMember` loses the un-archive branch; `findMemberAccess` / sign-in lose the archived filter; add `countTeamMembers` or fold member count into `listTeams` (already `TeamSummary.memberCount`).
- `src/lib/WorkflowRepository.ts`: `deleteWorkflow`; `unassignTeam(teamId)` over `WorkflowStep` and `WorkflowDraftStep`; drop `setWorkflowArchived`, `WorkflowActiveError`, `includeArchived`; `applyDraft` and `setWorkflowActive` refuse with `StepUnassigned` instead of `TeamNotActive`; `countStepsOwnedBy` / `listStepsOwnedBy` include open run steps (or a sibling in the run repository).
- `src/lib/WorkflowRunRepository.ts`: `deleteRunsForWorkflow` (or inside `deleteWorkflow`); `assignRunStepTeam`; `canStart` drops `archivedAt`, treats null/unresolvable team as cannot-start; `listQueue` reads `startedByEmail` from the row; `startStep` / `completeStep` / `blockRun` write actor emails.
- `src/lib/ShopAgent.ts`: `deleteWorkflow`, `deleteTeam` (D1 then DO, as above), `assignRunStepTeam` callables; drop `setWorkflowArchived`, `archiveTeam`, `workflowWritable`'s archive branch; `activeTeam` becomes `teamExists`; `getWorkflowDetail` marks unassigned / dangling / empty-team steps.
- Routes: `app.workflows.index.tsx` (Delete action, attention badge, no Archive/Restore), `app.workflows.$workflowId.tsx` (Delete with counts dialog, unassigned copy), `app.teams.index.tsx` (Delete with counts dialog, "No members" badge, no InUse refusal), `app.teams.$teamId.tsx`, `app.members.tsx` (Delete, empty-team warning, no `?archived` view), `app.orders.$orderId.tsx` (Assign team picker on unassigned open steps), orders index attention filter.
- Seed: `api.dev.seed.ts`, `e2e/fixture.ts`, `e2e/seed.ts` drop `archived` on members, teams, workflows; add a fixture with an unassigned step and one with an empty team so both warnings are visible after `pnpm seed`.
- Tests touching archive today: `auth.test.ts`, `member-area.test.ts`, `repository.test.ts`, `shop-agent-workflows.test.ts`, `workflow-repository.test.ts`, `workflow-run-repository.test.ts`, `e2e/members.spec.ts`, `e2e/teams.spec.ts`.

### Order of work

1. Land `workflow-draft-spec.md`.
2. Workflow delete with run cascade, confirm dialog with counts, drop `Workflow.archivedAt` and the archive UI. Independent of teams and members.
3. Actor email snapshot on run steps; `listQueue` reads it.
4. Member delete replaces member archive; drop `Member.archivedAt`; dialog's empty-team warning.
5. Nullable `teamId` on both step tables; dangling-equals-null on every read; derived attention state in detail page, list, order page, `canStart`, Apply / Turn on.
6. `assignRunStepTeam` and the order-page picker.
7. Team delete (D1 then DO), drop `Team.archivedAt` and the guard; "No members" badge.
8. JSDoc and schema comment rewrites; seed fixtures; tests; `pnpm fmt`.

### Domain results

- `DeleteWorkflowResult = Deleted | NotFound`; `DeleteTeamResult = Deleted | NotFound`; `DeleteMemberResult = Deleted | NotFound`.
- `AssignRunStepTeamResult = Assigned | NotFound | TeamNotFound | StepFinished`.
- `ApplyResult` and `ActivateResult`: `TeamNotActive` becomes `StepUnassigned { stepNames }`; `ActivateResult` loses `Archived`.
- Counts for the dialogs: `WorkflowDeleteCounts { openRuns, finishedRuns }` from a read callable; `TeamDeleteCounts { workflowSteps, draftSteps, openRunSteps }` from `countStepsOwnedBy` extended; `MemberDeleteWarning { emptiedTeams: string[] }`.
- `StepWithTeamName.teamName` becomes `NullOr(String)` (already) and gains `memberCount: NullOr(Number)` so the empty-team warning is derived at read time.

### Vocabulary

Merchant copy, to be stated in the `Team` and `Member` JSDocs in `Domain.ts` and linked from routes (what, not why):

- Delete a workflow and its runs go with it.
- Delete a team and its steps become **unassigned** until you **assign a team**.
- Delete a member and they leave their teams.
- A team with nobody on it shows **No members**.
- **Needs attention** is the badge for a workflow, run, or team in any of these states. It is derived on read, never stored.

### Tests

`test/integration` (Vitest) and the affected e2e specs. Required cases:

1. Delete workflow with open and finished runs → workflow, steps, draft, draft steps, runs, run steps all gone; a second workflow's runs untouched; name reusable immediately.
2. Delete workflow that is the active order workflow → slot freed; a new order workflow can be created and turned on.
3. Delete team with steps on the workflow, on a draft, and on an open run → all three `teamId` null; finished run step keeps `teamId` and `teamName`; `TeamMember` rows gone.
4. Delete team where the DO step fails after the D1 step → reads treat the dangling id as unassigned; a retry of `deleteTeam` nulls it.
5. `canStart` false for a workflow with an unassigned step; `applyDraft` and `setWorkflowActive` refuse with `StepUnassigned` naming the steps; an empty team does not refuse either.
6. `assignRunStepTeam` on an open unassigned step sets `teamId` and `teamName` from D1; refused on a finished step and on an unknown team; the step then appears in the new team's queue.
7. `startStep` / `completeStep` / `blockRun` write actor emails; `listQueue` returns them after the member is deleted.
8. Delete member → `TeamMember` cascades, sign-in refused, run history still shows the email; re-adding the email mints a new id.
9. Attention state: workflow list badge, detail banners on both sides, order page red step, team page "No members", each derived from the same read and cleared by assigning a team or adding a member with no other write.
10. Seed fixtures: one workflow with an unassigned step, one team with no members, no `archived` keys anywhere.

### Decisions on the former open questions (2026-09-05, mw)

- **Team delete nulls every `WorkflowStep` and every `WorkflowDraftStep` row.** One statement per table, no other join.
- **Orders index attention filter follows the order page.** The order page picker is the remedy; the index filter is discovery. Ship discovery only once the remedy exists (steps 5 and 6), then add the filter as its own small change.

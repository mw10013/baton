# Delete vs archive — research

Research date: 2026-09-05. Question: now that `workflow-versions-spec.md` is implemented, does Baton still need to _archive_ workflows, teams, and members, or can it _delete_ them the way Shopify Flow and Route to Ship do? Sources: `refs/flow-manual/manage/manage.md`, `refs/flow-manual/manage/monitor.md`, the "Flow Versioning Model" artifact (live Flow session, 2026-09-05), `docs/route-to-ship-departments-research.md`, `docs/team-research.md`, `docs/member-archive-spec.md`, and the current schema in `src/lib/ShopAgent.ts` `initializeSchema` and `migrations/0001_init.sql`.

## Short answer

Archive was adopted for one reason: **history must keep resolving names**. That reason is now mostly satisfied by snapshots rather than by keeping rows alive, so the case for archive has weakened to the point where delete is the better default for workflows. Teams and members are different only where a _live pointer_ still exists: open run steps point at a `teamId` the queue joins on, and run steps hold a bare `Member.id` with no email snapshot. Close those two holes and all three can delete.

Recommendation: **delete workflows; delete teams and members with guards; drop `archivedAt` everywhere.** Details and the open questions are below.

## Why archive was chosen, per entity

| Entity   | Where the decision was recorded                                                                    | Stated reason                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team     | `team-research.md` "History conundrum"; `Team` JSDoc in `Domain.ts`                                | A step or historical record must always resolve the team name. Also: `WorkflowStep.teamId` cannot be a foreign key (D1 vs DO SQLite).               |
| Member   | `member-archive-spec.md`; `Member` JSDoc                                                           | `WorkflowRunStep.startedBy` / `completedBy` and the block flag actor hold `Member.id` as bare text, no email snapshot; delete leaves history blank. |
| Workflow | `Workflow` JSDoc: "Archive, never delete, so a run can always resolve the name it was copied from" | Runs need the workflow name. Also doubled as "off" before the `active` switch existed.                                                              |

Each reason is a **name-resolution** concern. None of them is "the merchant will want this back" or "compliance requires retention".

## What the schema already snapshots

From `initializeSchema`:

```text
WorkflowRun       workflowId (no FK), workflowName, versionId (no FK), order + line-item snapshot
WorkflowRunStep   name, teamId (no FK), teamName, instructions, startedBy, completedBy (bare Member.id)
```

So today:

- **Workflow delete is already safe for history.** Runs reference `workflowId` and `versionId` without foreign keys and carry `workflowName` plus every step's name, team name, and instructions. Deleting `Workflow` (cascading `WorkflowVersion` and `WorkflowStep`) leaves every run fully renderable. The only join that goes null is `versionAppliedAt` on `WorkflowRunDetail` (the "From version applied …" line on the order page), and its own JSDoc already treats null as tolerable.
- **Team delete is safe for finished history, not for open work.** `WorkflowRunStep.teamName` covers rendering. But `listQueue` and the step actions select by `teamId in (member's teams)`, a live pointer. Delete the team and every _open_ run step it owns becomes unworkable by anyone. Archive has the same effect today, so this is not new, but archive can be undone with Restore and delete cannot.
- **Member delete is not safe.** `startedBy` / `completedBy` resolve to an email by reading the live D1 roster. No snapshot exists. This is the one place archive is doing real work.

## How the reference apps behave

### Shopify Flow

- Delete exists, is irreversible, and **requires the workflow to be off first** ("Only inactive workflows can be deleted"). Bulk delete from the list.
- The manual offers two alternatives instead of an archive concept: turn it off, or export a copy.
- Runs are retained 14 days after completion regardless of the workflow's existence, so "delete removes the runs" is effectively true for Flow but is a property of its short retention, not of the delete. Baton runs are the production record and must not follow that.
- No archive state anywhere. The list has All / Active / Inactive tabs only.

### Route to Ship

- Pipelines (≈ Baton workflows), departments (≈ teams), and users (≈ members) all have a plain **Delete** with no confirm dialog, per the user's observation (2026-09-05).
- Deleting a pipeline leaves orders in whatever stage they were in; the order simply no longer references a pipeline. Runs are not cancelled.
- Behaviour of department delete on an in-flight order, and of user delete on task history, was **not** observed. `route-to-ship-departments-research.md` records only that a throwaway department was created and deleted, and that a department cannot appear twice in a pipeline. This is the gap worth one more live inspection (see "Further research").
- Data retention: 30 days after uninstall, then permanent deletion (`refs/route-to-ship/support.md`).

Neither app has an archive, and neither treats history as a reason to keep configuration rows alive.

## Cost of the archive machinery today

Rough footprint from a grep of the working tree:

- `archivedAt` on `Workflow`, `Team`, `Member`; `includeArchived` flags on list operations; `workflowArchived` on `OwnedStep`.
- Result tags `Archived` on `WorkflowResult`, `StepResult`, `ActivateResult`; `WorkflowActiveError` ("archive refused while on"); `TeamArchiveResult` with in-use counts.
- `workflowWritable` gate in `ShopAgent` exists only to refuse edits to archived workflows.
- Seed fixtures with `archived: true` and list ordering that pushes archived rows last.
- ~126 UI references across the workflows, teams, and members routes: Archived badges, Archive / Restore actions, tooltips, "Turn off first" hints.
- **Name reservation.** Uniqueness is `collate nocase` across active and archived rows. Creating a workflow with an archived workflow's name is refused, and `addMember` on an archived email silently restores the old row. Both are hard to explain to a merchant and are the specific confusion the user raised.
- **Two hidden states.** A workflow can be Off, Archived, or both. Flow has one.

Delete replaces all of this with one operation per entity and, for teams, one guard.

## Proposed policy

### Workflows: delete, no archive

```text
deleteWorkflow(workflowId):
  active must be 0                       else Active     (Flow's rule; the UI says "Turn off first")
  delete from Workflow where id = ?      (versions and steps cascade)
  runs are untouched
```

- Open runs finish on their own. They are self-contained copies; the queue never joins `Workflow`. This matches Route to Ship (orders keep their stage) and is the right call for days-long physical work. A run card whose `workflowId` no longer resolves shows "Workflow deleted" where it would have linked to the definition.
- Finished runs stay forever as history, rendered from their snapshots. Baton does not adopt Flow's 14-day retention.
- The name is freed immediately; the one-order-workflow slot is freed immediately.
- Confirm dialog, unlike Route to Ship: the action is irreversible and the merchant loses the definition. Copy: "Delete <name>? Runs already started will finish. This can't be undone." Mention the count of open runs if any.
- Alternative considered and rejected: refuse delete while open runs exist. That blocks exactly the "I want this gone" case and gives the merchant no way forward short of cancelling production work.

### Teams: delete with a guard

```text
deleteTeam(teamId):
  no step of a live or draft version points at it          else InUse { stepCount }   (existing countStepsOwnedBy)
  no open run step (completedAt is null, run not done/cancelled) points at it   else InUse { openStepCount }
  delete from Team (TeamMember cascades)
```

- The first guard exists today as the archive guard and moves unchanged.
- The second guard is new and is what makes delete safe where archive relied on Restore. The merchant's path is to finish or cancel that work, or reassign the step's team on the open run. Reassign does not exist yet; whether it is worth building before allowing team delete is an open question below.
- Finished history renders from `teamName`. Nothing else references a team.

### Members: snapshot, then delete

- Add `startedByEmail` / `completedByEmail` (and the blocked-flag actor's email) to `WorkflowRunStep`, written at the moment of the action exactly like `teamName`. This is the "events snapshot identity" rule from `team-research.md` that members never received.
- With the snapshot in place, `deleteMember` (which still exists in the repository) becomes safe: history resolves from the row, not the roster. Members own nothing structural, so no guard.
- Re-adding the same email mints a new `Member.id`. That is fine once history no longer depends on ids.
- Compliance note: a deleted member's email then lives on in run steps. A future erasure request is "overwrite email in run steps", a separate operation, same as the note in `member-archive-spec.md`.

### Retired versions

Unchanged. `WorkflowVersion` rows retire rather than delete because `WorkflowRun.versionId` points at them and Discard already deletes drafts. Deleting the workflow cascades them all; nothing else should. This is the one place "keep the row" still earns its place, and it is invisible to the merchant.

## What gets removed

- `archivedAt` on all three tables; `includeArchived`; `workflowArchived`; the `Archived` / `Active` result tags; `WorkflowActiveError` becomes the delete-time `Active` refusal; `workflowWritable` collapses to a NotFound check.
- Archive / Restore UI, Archived badges, `archived` seed fixtures, archived-last list ordering.
- Name-collision-with-archived behaviour and `addMember`-restores-archived behaviour, both replaced by plain uniqueness among existing rows.
- `member-archive-spec.md` is superseded; the `Team` / `Member` / `Workflow` JSDoc rationales need rewriting to "snapshots, not rows, carry history".

## Further research

Worth one live session in Route to Ship (`sandbox-shop-01`), ~30 minutes, before committing the team policy:

1. Put a department in a pipeline, start an order through it, then delete the department. Does the pipeline lose the step, does the order's task vanish, or is delete refused?
2. Delete a pipeline while an order is mid-way. Confirm the order keeps its stage and what the order page shows in place of the pipeline.
3. Delete a user who has completed tasks. Does task history still show their name?

Flow needs no more research; its delete semantics are fully documented and were observed live.

## Open questions

1. **Team delete and open run steps.** Refuse (simple, may frustrate), or ship "reassign team on an open run step" first so the merchant always has a way out? Recommendation: refuse in the first pass with the open-step count in the message, and add reassign when a real merchant hits it.
2. **Confirm dialog on delete.** Route to Ship has none; Flow does. Recommendation: confirm for workflows and teams (structural, irreversible), plain delete for members.
3. **Run card copy for a deleted workflow.** "Workflow deleted" versus silently dropping the link. Recommendation: say it; the floor should know the definition is gone.
4. **Should delete also be offered from the list**, like Flow's bulk delete? Recommendation: detail page only for now.

## Amendments, 2026-09-05 (later): Route to Ship pipeline delete, observed live

Deleted `Pipeline 01` in `sandbox-shop-01` while order #1558 was attached to it (Department 01 done, 2 steps completed; the pipeline dashboard counted it as 1 active order at 50%). Then recreated the pipeline with the same name, tag `workflow-01`, Sequential, Require All Steps, Department 01.

What happened:

- **No confirm dialog.** One click on the trash icon and the row was gone.
- **Order #1558 lost its pipeline, not its history.** The "Order Pipeline" section (Department 01 · Done · 2 steps) disappeared from the order page and the "IN PRODUCTION" stage vanished from its timeline. The Pipeline picker fell back to "Choose a pipeline". The line item is now marked "No pipeline yet — nothing is being made for this item."
- **Task history survived.** Past Work still lists 3 tasks across 3 orders including #1558 · Department 01 · Step 2, with started/completed timestamps and the worker's name. Task records hang off the department, not the pipeline.
- **Open work survived as orphans.** The dashboard's "Production by department" still shows Department 01 with 1 order of open work and "work ready now: 1" after the delete. The department task rows were not removed, so the department queue still counts them.
- **Recreating the pipeline did not re-attach the order.** #1558 stays unassigned; a merchant would re-pick the pipeline per order.

So Route to Ship is neither a clean cascade nor a clean "leave runs alone". It unlinks the order from the pipeline, leaves department-level task rows in place (finished and open), and lets the department queue keep counting orphaned open tasks. For Baton this is the outcome to avoid: a run is one object, and either it goes with the workflow or it stays whole.

### Decision (mw, 2026-09-05): workflow delete cascades runs

- `deleteWorkflow` deletes the workflow, its versions and steps, **and every run of that workflow** (open and finished, item and order scope; run steps cascade). No Off-first requirement.
- Confirm dialog with counts: "Delete <name>? N runs in progress and M finished runs will be deleted. This can't be undone."
- Items mid-production lose their run and drop out of the floor's view. Re-routing them is manual (the existing manual run source); the age rule means a replacement workflow will not pick them up. Accepted.
- Turn off stays as the non-destructive move: stops new runs, open runs finish. The Turn off dialog says so.
- Rationale: one rule ("deleted means gone, including its runs") beats orphaned runs with no definition behind them, which is the confusing state Route to Ship lands in.

Sandbox note: `Pipeline 01` was recreated after the experiment, but order #1558 is no longer attached to it.

## Teams and members: proposed policy (2026-09-05, discussed, not yet decided)

Written after the workflow-delete decision above. Guiding idea: the "step whose team is archived" state already exists end to end (editor shows the step with no team name, detail page shows a needs-attention banner, Apply and Turn on refuse, routing skips the workflow). Team delete becomes one more way to enter that state instead of a new concept.

### Teams: delete, cascade to "unassigned", confirm with counts and an optional reassign

- **Definition steps** (live and draft versions) pointing at the deleted team become **unassigned**. That is the existing red state with new copy ("Team deleted" instead of "Team archived"). The workflow is not routable until the merchant assigns a team.
- **Open run steps** pointing at the team also become unassigned. They keep the snapshotted `teamName` for the record, but no member's queue shows them, so the run is stuck. This is the one genuinely new hole and it needs a way out. Two remedies, both proposed:
  1. The confirm dialog offers **"Reassign these steps to: [team picker]"** as a one-shot bulk move of every affected definition step and open run step.
  2. The order page gets a **per-step "Assign team"** action on run steps, for cases the merchant chooses to sort out later.
     Without at least one of these, delete strands physical work with no remedy except cancelling the run.
- **Finished run steps** are untouched. They render from the snapshot.
- **Dialog copy** (draft): "Delete Cut & Sew? 4 workflow steps and 7 in-progress steps are assigned to it. Reassign them to [picker] or leave them unassigned. Workflows with unassigned steps stop routing until you fix them."
- No guard. Archive's `countStepsOwnedBy` refusal goes away; its count feeds the dialog instead.

### Empty teams: allow, warn, don't block

- A team with zero members is structurally fine and is already reachable today (create a team, add nobody).
- Its steps are routable but nobody can work them. That is a staffing problem, not a data problem. Show a **"No members"** badge on the team and a warning on any workflow step assigned to it. Do **not** refuse Apply or Turn on over it.
- Blocking here would force member delete to have a guard ("can't remove the last person until the team's steps are reassigned"), which is the tangle to avoid.

### Members: snapshot the actor, then delete freely

- Add `startedByEmail` / `completedByEmail` (and the blocked-flag actor's email) to `WorkflowRunStep`, written at the moment of the action, exactly like `teamName`. After that a member row owns nothing structural.
- `deleteMember` cascades `TeamMember` (already does). No guard.
- Dialog warns only when relevant: "This will leave Cut & Sew with no members."
- Re-adding the same email mints a new member. History keeps the old email as text.
- Cost: a deleted member's email lives on in run steps. A future erasure request is a separate "overwrite email in run steps" operation, not a row delete.

### Schema consequences

- `WorkflowStep.teamId` becomes **nullable** (unassigned). No team-name snapshot needed on definition steps.
- `WorkflowRunStep.teamId` becomes **nullable**; `teamName` stays as the historical record. Add the actor email columns above.
- `archivedAt` dropped from `Workflow`, `Team`, `Member`; `includeArchived`, `workflowArchived`, the `Archived` result tags, `WorkflowActiveError`, `TeamArchiveResult`'s in-use refusal, Archive/Restore UI, archived seed fixtures, and the cross-archived name reservation all go.
- Team delete is a D1 delete followed by a Durable Object call that nulls the pointers (and optionally reassigns them). Same cross-store sequence `archiveTeam` uses today, minus the guard. Order: DO first (null/reassign pointers), then D1 delete, so a failure leaves a team that still exists rather than dangling pointers.
- Routability predicate: a step with `teamId is null` makes the workflow not routable, replacing the "team archived" clause.

### Route to Ship

Not worth another inspection for this question. Their tasks belong to departments rather than to a pipeline instance, so department delete answers a different question, and the pipeline-delete experiment above showed they tolerate orphans. Do not take lessons from it here.

### Open for mw's call (next session)

1. **Team delete remedies.** Ship both the reassign picker in the confirm dialog and the per-step "Assign team" on the order page, or one first? Recommendation: dialog picker first, since it handles the bulk case at the moment of damage; per-step assign second.
2. **Email snapshot on run steps.** Is retaining a deleted member's email as text in `WorkflowRunStep` acceptable? Recommendation: yes; it is what makes member delete guard-free, and erasure can be a later targeted overwrite.

Also confirm (assumed yes from the discussion): empty teams allowed with a warning badge, no Apply / Turn on refusal; `teamId` nullable on both step tables rather than left dangling.

### Order of work once decided

1. Workflow delete (cascade runs, confirm with counts, drop `Workflow.archivedAt`). Independent of teams/members.
2. Actor email snapshot on run steps.
3. Member delete replaces member archive; drop `Member.archivedAt`; supersede `member-archive-spec.md`.
4. Nullable `teamId` on both step tables; "unassigned" state in editor, detail banners, order page, routability.
5. Team delete with dialog counts and reassign; per-step assign; drop `Team.archivedAt`; "No members" badge.
6. Rewrite the `Team` / `Member` / `Workflow` JSDoc rationales to "snapshots, not rows, carry history"; seed fixtures; tests; `pnpm fmt`.

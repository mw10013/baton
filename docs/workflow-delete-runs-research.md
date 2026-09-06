# Workflow delete vs. its runs, and what a run may be edited — research

Research date: 2026-09-06. Revisits principle 2 of `delete-model-spec.md` ("workflow delete cascades its runs") and pins down which edits a workflow run accepts. Code state: `af1bc41`.

## TL;DR

- **Recommendation: stop cascading runs on workflow delete.** Delete the definition (steps, draft, draft steps) and leave every run, open and finished, exactly where it is. Runs already snapshot everything they render, no read joins `WorkflowRun` back to `Workflow`, and the order line item is the natural home for them. The change is small: one repository function, one dialog, one JSDoc, one test.
- The Shopify Flow precedent we followed does not say what we assumed. Flow refuses to delete an active workflow and keeps runs for only 14 days after completion; its manual never says deletion removes run history. We copied a policy Flow does not document.
- **Run edits today are exactly: assign a team to an open step.** The back end already accepts reassignment of an assigned open step; the UI only exposes the picker on unassigned steps. Recommendation: expose reassignment on any open step. Nothing else about a run is editable (no add, remove, or reorder), and that should stay.
- **Empty-team remedy exists but is two pages away.** The order page warns "No members on X"; the fix (add a member on the team page) has no link from the warning. Add the link.

## 1. Where the cascade came from

`delete-model-spec.md`, principle 2 (decided 2026-09-05):

> Workflow delete cascades its runs. Open and finished, item and order scope. No trace remains.

The vocabulary JSDoc on `Domain.Workflow` restates it as merchant copy: "delete a workflow and its runs go with it". The implementation is `WorkflowRepository.deleteWorkflow` (`src/lib/WorkflowRepository.ts:787`): one transaction deleting `WorkflowRunStep`, `WorkflowRun`, then `Workflow` (steps, draft, draft steps cascade by foreign key). `ShopAgent.removeWorkflow` wraps it and publishes so order pages repaint without the runs.

The rationale was Flow parity. What the Flow manual (`refs/flow-manual/manage/manage.md`, `monitor.md`) actually says:

| Flow behaviour                                                   | Source                              |
| ---------------------------------------------------------------- | ----------------------------------- |
| Only inactive workflows can be deleted; Turn off first           | `manage.md` "Delete a workflow"     |
| Turn off optionally cancels in-progress runs                     | `manage.md` step 4 under deactivate |
| Runs are stored 14 days after completion, then removed           | `monitor.md` caution box, twice     |
| Runs list is global ("Recent runs" / activity), not per-workflow | `monitor.md`                        |
| What deletion does to runs                                       | **not stated**                      |

So Flow's model is: history is short-lived anyway, and you cannot delete something that is running. Flow's runs are seconds-long automations with no human work in them. Baton's runs are days of production work on a physical item, with names of the people who did each step. The precedent does not transfer.

## 2. Is a run independent of its workflow? Yes.

Verified against the schema (`src/lib/ShopAgent.ts:298`) and every read path.

**Schema.** `WorkflowRun.workflowId text not null` with **no foreign key** to `Workflow`. `workflowName` is a snapshot. Order and line-item fields are snapshots. `WorkflowRunStep` snapshots `name`, `stage`, `position`, `instructions`, `teamName`, `startedByEmail`, `completedByEmail`. The JSDoc above the schema already states the intent: "a run must survive an order delete, a line item dropped by an edit, and a definition edit or rename, because it is the record of work someone may already have started."

**Reads.** No query in `WorkflowRunRepository.ts` or `OrderRepository.ts` joins `Workflow` from a run. The queue, order page, orders index attention count, and run detail all read the run and its step rows alone. The only places `WorkflowRun.workflowId` is consulted:

- `createRun` (`WorkflowRunRepository.ts:646`): the `unique (lineItemId, workflowId)` / `(orderId, workflowId)` conflict targets.
- `startOrderRun` (`:742`): finds the order run for the active order workflow.
- `listWorkflows` (`WorkflowRepository.ts:737`): correlated counts of open and finished runs per workflow, for the list and the delete dialog.
- Routes: none. The order page never links a run back to its workflow.

**Writes.** `startStep`, `completeStep`, `blockRun`, `dismissFlag`, `assignRunStepTeam`, `cancelRun`, and the sync's flag reconciliation all address run and step rows by id. None touches `Workflow`.

**Apply.** `applyDraft` replaces the workflow's tags and steps and never touches runs. Confirmed and worth keeping: a run is a copy taken at start, and the merchant who edits a definition expects items already on the floor to finish on the steps they started with.

**Conclusion.** Removing the two `delete from WorkflowRun*` statements from `deleteWorkflow` leaves the system consistent. An orphan run (its `workflowId` names no row) renders, queues, starts, completes, blocks, and cancels exactly as before. The counts in `listWorkflows` simply stop counting it, which is right: it no longer belongs to any definition.

## 3. Trade-offs

### Keep the cascade (today)

- Pro: no orphans, so "runs of workflow X" is always a complete set and the workflow list's run counts are total.
- Pro: one fewer state to explain ("this run's workflow no longer exists").
- Con: deleting a definition erases production history. A finished run is the only record that a line item went through Cut, Sew, Finish and who did each. The order line item still exists and now says "No workflow", which is false.
- Con: deleting a workflow with open runs pulls in-progress items out of every queue with no flag, no note, nothing on the order page. The spec accepted this ("items mid-production drop out of the floor's view") and pushed the merchant toward Turn off, but the delete dialog is the only thing standing between a misclick and lost work.
- Con: the confirm dialog carries the whole burden, and its counts are read at dialog-open time.

### Delete the definition only (recommended)

- Pro: history is preserved where it belongs, on the order and line item. A finished run reads the same the day after the workflow is deleted as the day before.
- Pro: open runs keep going. The floor finishes what it started; nobody needs to re-attach a replacement workflow by hand.
- Pro: delete becomes safe enough that the dialog can be a plain confirm, and Turn off no longer has to be sold as "the non-destructive move" because delete is non-destructive to work.
- Pro: matches how every other delete in the model already behaves. Team delete keeps finished steps' `teamName`; member delete keeps `startedByEmail`. Workflow delete would keep `workflowName`. One rule: **deleting configuration never deletes work**.
- Con: orphan runs exist. The workflow list's "N finished runs" undercounts history for a deleted-and-recreated workflow with the same name. Acceptable: the list counts a definition's runs, not a name's.
- Con: the order page attach picker, which uses `unique (lineItemId, workflowId)` to refuse a second run, will happily start a run of a **new** workflow for an item that already has an orphan run of the deleted one. That is arguably correct (different definition, different work) and is what happens today after Turn off plus a new workflow anyway.
- Con: no UI lists "runs of the workflow I deleted". Nothing lists runs per workflow today either; runs are found through orders. No loss.

### Middle ground considered and rejected: keep finished, cancel open

Delete the definition, keep finished runs, and cancel open runs with a flag. Rejected because the cancel is the destructive half and it is exactly the half that Turn off already handles gracefully (open runs finish). If a merchant wants open runs stopped, the per-run Cancel exists. Deleting a definition should not also make a decision about in-flight work.

## 4. What the change touches

Small. Everything below was checked against the current code.

- `WorkflowRepository.deleteWorkflow` (`src/lib/WorkflowRepository.ts:787`): drop the two run deletes. Keep the transaction and `requireWorkflow`.
- `Domain.Workflow` JSDoc (`src/lib/Domain.ts:503`): "delete a workflow and its runs go with it" becomes "delete a workflow and its runs stay on their orders; open ones finish". Same sentence in the schema JSDoc at `src/lib/ShopAgent.ts:157` ("every run it ever started").
- `ShopAgent.removeWorkflow` JSDoc: publish is still right (the workflows list changes) but the reason changes.
- `app.workflows.$workflowId.tsx:1059`: the hint "Delete removes its runs too" goes; the confirm dialog stops warning about run counts, or keeps them as information ("N runs in progress will keep going on their orders").
- `app.workflows.index.tsx:76`: the delete-row copy with run counts, same treatment.
- Tests: `workflow-run-repository.test.ts:2194` ("deleteWorkflow removes its runs and run steps") inverts to "leaves its runs". `shop-agent-workflows.test.ts:225` and `:553` check definition and draft only and stay.
- `delete-model-spec.md`: principle 2 and the Workflows section are superseded by this doc.

Nothing in the queue, order page, orders index, sync, or attach path changes.

## 5. Editing a workflow run: what exists, what should

No draft, no apply, no step add/remove/reorder on a run. That is right and stays: a run is the record of what was done, and the definition is the place to change what will be done.

The full set of run-level writes a person can make today:

| Operation          | Who    | Where      | Guard                                                         |
| ------------------ | ------ | ---------- | ------------------------------------------------------------- |
| Start / Complete   | member | queue      | step's team in member's teams; step ready                     |
| Note on a step     | member | queue      | same                                                          |
| Block / dismiss    | member | queue      | same                                                          |
| Cancel / un-cancel | admin  | order page | run exists                                                    |
| **Assign team**    | admin  | order page | step open; team exists in D1 (`StepFinished`, `TeamNotFound`) |

### 5a. Reassignment of an assigned step

**Back end: allowed.** `WorkflowRunRepository.assignRunStepTeam` (`:1333`) and `ShopAgent.assignRunStepTeam` (`:2363`) refuse only a finished step and an unknown team. They do not check that the step is currently unassigned. The integration test at `shop-agent-workflows.test.ts:827` even assigns twice (A rejected as deleted, then B) and then confirms `StepFinished` after completion.

**UI: not exposed.** `stepTrail` in `app.orders.$orderId.tsx:164` builds `unassigned` from `Domain.isRunStepUnassigned` and renders the "Assign team" picker only for those steps. An assigned open step shows `(TeamName)` as plain text.

**Recommendation: expose it.** Show the picker (or a small "Reassign" affordance) on every open step, not just unassigned ones. Reasons:

- The write already exists and is already safe. Forbidding it in the UI is a policy the back end does not enforce, so it is not really a rule.
- Real need: a team is overloaded, a step was assigned to the wrong team in the definition and the merchant fixed the draft but the run on the floor still points at the old team, a rush order needs a different crew.
- Reassigning a **started** step is the one case that deserves thought. The step has `startedBy` from team A's member. Moving it to team B leaves that snapshot intact (history: A started it) and puts it in B's queue to complete. That is coherent. If it feels wrong, the guard is one line: refuse when `startedAt is not null`. I would not add it; the merchant on the order page can see the step is started and decide.

Semantics to keep as-is: assignment always snapshots `teamName` from the live D1 roster; it never changes the definition; the step immediately appears in the new team's queue and leaves the old one.

### 5b. Empty team on a run step

**Detection: done.** `getOrderDetail` carries the roster with `memberCount`; `stepTrail` warns "No members on X. Nobody can work this until someone joins." for a ready open step on an empty team. The team page shows a "No members" badge; the member delete dialog warns "This will leave X with no members" (`app.members.tsx:151`).

**Remedy: exists, not linked.** Adding a member to a team is the checkbox list on `app.teams.$teamId.tsx:342`. The order page warning is plain text with no link. From the order page the merchant has to know to go to Teams, find the team, tick a member.

**Recommendation:** make the team name in the warning a link to `/app/teams/<id>`. Also acceptable: offer the Assign team picker on the step as an alternative remedy ("or assign another team"), which 5a gives for free. No inline "add member" on the order page; team membership is a team-page concern and the two-click trip is fine once there is a link.

### 5c. Everything else stays forbidden

No add, remove, reorder, rename, or edit-instructions on run steps. `WorkflowRunStep` has `unique (runId, position)` and stage invariants that only `createRun` writes. Keeping runs immutable in shape is what makes the "run is a snapshot" story true and lets `deleteWorkflow` be a one-liner.

## 6. Decisions (2026-09-06, mw)

1. **Delete dialog is silent about runs.** Plain confirm, no counts, no informational line.
2. **Reassignment is uniform: no special case for a started step.** A started open step can be reassigned like any other open step; its `startedByEmail` snapshot is untouched. Whether a **finished** step is also reassignable is still open (see 7); the existing `StepFinished` refusal stays until that is decided.
3. **Drop the run counts from the workflow list.** They were there to feed the destructive dialog; without it they are noise. Flow shows none. `WorkflowSummary.openRuns` / `finishedRuns` and the `listWorkflows` correlated subqueries go; `countRunsForWorkflow` (the dialog read) goes with them.
4. **The cascade came from Flow plus a wish for simplicity** while the edit/apply/delete interactions were still unclear. With runs confirmed as snapshots the simplicity argument no longer needs the cascade, and deleting finished or in-flight work is not what a merchant wants. Recommendation in section 3 stands.

## 7. Reassignment scope (decided 2026-09-06, mw)

- **Finished step: never reassigned.** `assignRunStepTeam` overwrites `teamName`, the only record of which team completed the step; the existing `StepFinished` refusal stays.
- **Started open step: reassignable like any other open step.** The write touches only `teamId` / `teamName`; `startedAt` / `startedBy` / `startedByEmail` stay, so history keeps the starter and the new team's member becomes the completer. There is no un-start operation, so refusing would leave Cancel as the only remedy for a worker who left mid-step or a step started by the wrong team. No `StepStarted` result; two states on the picker (open, finished) instead of three.

Spec: `workflow-delete-runs-spec.md`.

# Workflow editor in two tabs: research

Status: research, 2026-10-24. Written from the code on `main` at `03fe6b7` and the production reproduction of 2026-10-24. No code has changed. The questions are in §7. All ten were answered on 2026-10-24: every recommendation accepted, Q5 with changed copy.

## 0. Summary

The editor is a loader-only screen. It reads the workflow once, and again only after its own presses. No notice reaches it, and no write it sends says which draft it was looking at. So a tab cannot see another tab's draft, and the actor cannot tell a stale write from a fresh one.

Recommendation (§6): **refuse a stale write with a clear message, push workflow changes to open editors, and fix the Apply and Discard dialogs.** The refusal is what makes the editor correct, and it costs nothing at the margin. The push makes refusals rare and shows the Draft badge live. The dialog fix is needed under any option.

## 1. The bug, as reproduced on production

1. Tab A opens the editor of an active workflow and adds a step. That creates the draft.
2. Tab B opens the same editor, presses Discard changes and confirms.
3. Tab A presses Apply changes, then Apply in the dialog.

What happens:

- A red banner says "There are no changes to apply." It renders behind the Apply dialog, which stays open.
- Tab A still shows the Draft badge and the discarded step.
- Adding another step in tab A re-syncs the list, and the earlier step disappears without notice.

Separately, a tab that opened before another tab made a draft shows no Draft badge until it writes something itself.

## 2. How draft state reaches the editor today

**The read.** The route `app.workflows.$workflowId_.edit` loads `workflowDetail`, a server function. It goes Website → Backend → the shop's actor over HTTP, and the actor's `Workflows.getWorkflowDetail` answers `WorkflowPageData`: the workflow, its `tasks`, its `draftTasks` (`null` when there is no draft) and the shop's teams. The workflow page `app.workflows.$workflowId` uses the same read.

**The writes.** Every editor control is a `Merchant…` procedure on the tab's shop socket (`addStepAtom`, `applyDraftAtom`, `discardDraftAtom`, …, in `useEditorPresses`). A task write lands on the draft through `WorkflowRepository`'s `editDraft`, which first runs `update Workflow set draftTasks = coalesce(draftTasks, tasks)`. So the first edit creates the draft, and any edit after a Discard or an Apply silently creates a new one. The copy keeps task ids, which is what lets a task write name a task by id whether or not a draft exists.

**The re-read.** After a task write, `onTaskResult` sets the banner and calls `onChanged`, which is `router.invalidate({ sync: true })`: the loader runs again over HTTP. After Apply, Discard, rename and delete, the re-read or the navigation happens only on `Ok` (`useEditorPresses`).

**The notices.** The actor pushes a `Notice` to every socket of the shop after a write, naming reactivity keys, and `noticesAtom` refreshes the live reads that observe them (§5 of `docs/live-read-research.md`). Only `ORDERS_KEY` and `SYNC_KEY` exist. The workflow procedures notify `ORDERS_KEY` on Apply, Edit tag, the switch, Turn on and delete, because those change what the order pages' Workflow select lists. Task writes and Discard notify nothing. `makeWorkflows`' JSDoc states it: "nothing reads workflows live, so there is no workflows key." That was a deliberate deferral: live-read Q8 kept the workflows, members and teams pages loader-only.

**What a write carries.** Only ids: `workflowId` for Add step, Apply, Discard; `taskId` for the task writes; plus the fields. Nothing says what the tab saw.

Legacy (`refs/baton-legacy/src/routes/app.workflows.$workflowId_.edit.tsx`) has the same shape: a loader, `router.invalidate` after each press, no guard. The bug was ported, not introduced.

## 3. Why a stale tab cannot see a discard, and what else goes wrong

Three gaps add up to the reported bug.

1. **No push.** Tab B's Discard sends no notice, and tab A has no live read to refresh anyway. Tab A keeps the loader answer it had after its own last press.
2. **No base in the write.** Tab A's Apply says only `workflowId`. The actor finds no draft and answers `NoDraft`, which is true but explains nothing. Tab A's next Add step finds no draft either, so `editDraft` copies `tasks` into a new draft and adds the step there. The re-read then shows a list without the step from step 1. The tab was never told that step was discarded.
3. **The dialogs ignore a refusal.** In `useEditorPresses`, `apply` and `discard` hide their modal and re-read only on `Ok`. On any other answer the modal stays open, the banner is set under it, and the loader is not re-read. So the tab shows the Draft badge and the step after the actor told it there is no draft. The `notifyIfOk` JSDoc says "the refused tab … invalidates its own loader on every answer", which holds for the task writes (`onTaskResult`) and not for these two.

The same gaps cause worse cases than the reported one:

- **Apply of changes the tab never saw.** Tabs A and B both edit the same draft. Each shows only its own writes plus whatever its last re-read returned. Tab A presses Apply and promotes tab B's edits too, unseen. This is silent and it changes what new runs copy.
- **An edit on a layout the tab does not show.** Move up, Separate and Join act on the server's current layout by task id. If another tab moved tasks, the result can differ from what the stale tab expected.
- **An edit after another tab's Apply.** The stale tab's next task write starts a new draft from the newly applied tasks. If it names a task that the Apply removed, the answer is `NotFound` ("That task no longer exists. Reload the page."). Otherwise it succeeds silently.
- **A hidden Draft badge.** The workflow page and a stale editor show no draft that another tab created, so a merchant can believe a workflow has no pending changes.

What the domain does not cause: there is one draft per workflow, by design (`draft` in `docs/glossary.md`: "one or none"), and Discard in tab B throwing away tab A's step is the rule working. The defect is that tab A is not told, and can act on a draft that no longer exists.

## 4. Options

### Fix 0 (needed under every option): the Apply and Discard dialogs

On every answer to Apply and Discard, `Ok` or not, hide the dialog and re-read. Then the banner is visible and the tab shows what the actor has. This alone turns the reported Apply into "There are no changes to apply." beside a list without the discarded step. It does not stop the silent cases in §3: the Add step after a Discard still lands on a new draft, and an Apply still promotes unseen edits.

Marginal cost: one loader read on a refused Apply or Discard, which today does not happen. That is one Website request, one Backend request and one actor request, reading one `Workflow` row in the actor and the shop's teams in D1. It happens only on a refusal, so it is noise.

### Option A: push workflow changes to open editors

A new reactivity key (`WORKFLOWS_KEY`) is notified after every successful workflow write, task writes and Discard included, and after a team delete that unassigns tasks (`WorkflowRepository.unassignTeam`). The editor and the workflow page become live reads, as the order page is: a socket query for the detail (`MerchantWorkflowDetail`), wrapped in `liveQuery(…, [WORKFLOWS_KEY])`, seeded by the loader through `liveLoad`, read with `useLiveRead`.

What it fixes: another tab's draft, Discard or Apply shows up within a socket round trip. That covers the Draft badge, the discarded step and the stale layout. A hidden tab holds the key and refetches when it becomes visible, before the merchant can press anything.

What it does not fix: a press that is sent before the notice's refetch lands. Two merchants pressing within the same second, or a tab whose socket is reconnecting, still writes against a stale view. So A narrows the window, it does not close it. Apply of unseen edits remains possible.

A detail to get right: notices are throttled per key, 2 s leading and trailing (`NOTICE_THROTTLE`). If the writer's own tab relied on the notice, a second press within 2 s would show its result up to 2 s late. So the writer's tab still refreshes its own read on the answer, directly on the atom (no longer `router.invalidate`), and the notice serves the other tabs.

Marginal cost, per successful workflow write, with _k_ other tabs observing that key:

- One notice frame to every socket of the shop. The actor is already awake for the write. Outgoing WebSocket messages are not billed as requests.
- _k_ socket reads. Each is one incoming WebSocket message (billed at 1/20 of a Durable Object request), one `Workflow` row read in the actor's SQLite, and one D1 query reading the shop's `Team` rows plus their `TeamMember` rows (the `memberCount` subquery).
- The writer's own re-read moves from HTTP (a Website request, a Backend request and an actor request) to one socket message. That is cheaper than today.
- Member tabs and order pages receive the frame and refetch nothing, because nothing they observe carries the key. The orders memo is not cleared, because `Runs.notify` clears memos only for `ORDERS_KEY`.

At list rates (Durable Object requests $0.15 per million, SQLite and D1 rows read $0.001 per million; check current pricing before relying on the figures), a shop with 10 teams and 30 team memberships, 2 other observing tabs, pays about 0.1 request and 82 rows read per edit: about $1.5 × 10⁻⁸. Edits run at human speed, so the cost is negligible. It saves cost against today for the writer.

Work: a socket read procedure, a key, a notify on each workflow write, a live loader and `useLiveRead` in two pages, and seeding that already copes with a task changing underneath (the `seeded` block in `EditorScreen`). The infrastructure exists. Live-read Q8 said converting these pages later would be cheap, and this is that conversion.

### Option B: a revision on the task lists, and a refusal for a stale write

The `Workflow` row gains an integer revision of its task lists. It moves on every write to `tasks` or `draftTasks`: each task write, Apply, Discard, Apply and turn on, and `unassignTeam`. It does not move on rename, Edit tag or the switch, which do not touch the task lists. `WorkflowPageData` carries it. Every editor write sends the revision it last read. The actor compares it inside the write's transaction and refuses a mismatch with a new tag on the result unions (named `Changed` here, see Q4) before any other check. The editor then hides any dialog, re-reads, and shows the banner "This workflow changed since you opened it. Check the steps and try again." (Q5). The add form and the task panel keep what the merchant typed, because they clear only on `Ok`, so a retry is one press.

What it fixes: every case in §3. Tab A's Apply after tab B's Discard is refused as changed, not as "no changes". Tab A's Add step after the Discard is refused, so no new draft appears under it. An Apply always promotes exactly the draft the tab showed. A move acts on the layout the tab showed.

What it does not fix: awareness. A stale tab learns only when it presses. Two tabs editing the same draft refuse each other's next press once per switch between tabs. Each refusal re-reads, so it costs one press, never lost typing.

Why not existing fields:

- **`updatedAt`** moves on rename, Edit tag and the switch too, so it would refuse an edit after an unrelated rename in another tab. It has millisecond resolution, so two writes in the same millisecond would compare equal. And it means "Last updated on", which a guard should not overload.
- **Draft identity only** (an id minted when the draft is created) refuses a write after a Discard or an Apply, but not after another tab's edit to the same draft. So an Apply of unseen edits stays possible. That is the case that changes what runs copy.
- The name "version" is excluded by `Workflow`'s JSDoc in `src/domain/shop-work.ts` ("Not used, in code or copy: version, …").

Marginal cost: nothing measurable. `editDraft` already reads the row (twice: `requireWorkflowRow` before and after the coalesce), Apply and Discard read it too, and the revision is compared in that read. The bump is one more column in an `update` the write already makes, so rows written do not change. The migration is one `alter table Workflow add column … integer not null default 0`, appended (production keeps migration history, per `migrations` in `src/backend/shop-actor.ts`). SQLite adds a defaulted column without rewriting rows. The wire grows by one integer per press.

Work: one migration; the revision on `WorkflowWithDraftTasks`, `WorkflowPageData` and the editor's inputs (`AddStepInput`, `AddTaskInput`, `UpdateTaskInput`, `MoveTaskInput`, `SeparateTaskInput`, `JoinTaskInput`, the remove input, `ApplyDraftInput`, `DiscardDraftInput`, `ApplyAndTurnOnInput`); a check in `editDraft`, `applyDraft`, `discardDraft` and `applyAndTurnOn`; a new tag on `TaskResult`, `ApplyResult`, `DiscardResult` and the switch's result; the editor's messages. The remove input is today the shared `TaskIdInput`, so it needs its own input.

### Option C: A and B together

B makes every write correct. A makes B's refusal rare and shows the draft live. With both, a refusal happens only when two presses race within a socket round trip, and the editor never acts on a draft it cannot see.

Marginal cost: A's cost plus nothing.

### Rejected

- **A lock or presence ("Being edited in another tab").** It needs a record of which sockets have which editor open, released on close and on a dropped socket, and a stale lock blocks the merchant. It also does not remove the need for B, because a lock can be lost mid-edit.
- **A draft per tab or per person.** The domain has one draft per workflow, and the workflow page shows it. Several drafts would need a merge at Apply, and the merchant would meet a third noun, which the domain rules out.
- **Last write wins, as today, with only Fix 0.** It leaves the silent cases in §3, including Apply of unseen edits.
- **Merging a stale write onto the current draft** (apply the stale tab's edit to the newer list when they do not conflict). The task writes are relative edits, so a merge is often well defined. But the merchant would still Apply a list they never saw. Refusing and re-reading is simpler and shows them the list first.

## 5. Comparison

|                                     | Fix 0 only                 | A (push)                                                              | B (refuse)                       | C (both)                       |
| ----------------------------------- | -------------------------- | --------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| Reported Apply after Discard        | "No changes", list re-read | Tab already shows no draft                                            | Refused as changed, list re-read | Tab already shows no draft     |
| Add step after Discard              | Silent new draft           | Usually shown first, a race remains                                   | Refused                          | Shown first, a race is refused |
| Apply of another tab's unseen edits | Possible, silent           | Narrowed, possible                                                    | Impossible                       | Impossible                     |
| Draft badge from another tab        | Only after own press       | Live                                                                  | Only after own press             | Live                           |
| Marginal cost per edit              | None                       | _k_ × (1/20 request + 1 row + teams' rows), writer cheaper than today | None                             | As A                           |
| Work                                | Small                      | Medium                                                                | Medium                           | Medium + medium                |

## 6. Recommendation

**C, in this order: Fix 0, then B, then A.** Fix 0 and B close the defect: no tab can write against a draft it does not see, and every refusal is visible. A then removes most refusals and the stale Draft badge, and it costs less than today for the writing tab. Each step is useful on its own, so the plan can ship them as separate commits, and A can be dropped if Q1 says so.

## 7. Questions and answers

1. **Push, refuse, or both?** **Answer (2026-10-24): accepted.** _Recommended: both (§6)._ Refusing alone is correct but leaves the stale badge and a refusal on every switch between two editing tabs. Pushing alone narrows the window but keeps an Apply of unseen edits possible.
2. **Which writes does the revision guard?** **Answer (2026-10-24): accepted.** _Recommended: every task write, Apply, Discard and Apply and turn on. Not rename, Edit tag, the switch or delete._ Rename and Edit tag are immediate and do not touch the task lists. The switch on an applied workflow checks its tasks on the actor, whatever the tab shows. Delete is confirmed and final, and a stale tab deleting a workflow it can see is what the merchant asked for.
3. **Does a team delete move the revision?** **Answer (2026-10-24): accepted.** _Recommended: yes._ `unassignTeam` writes the task lists, and the stated rule is "moves on every write to `tasks` or `draftTasks`", with no exception to explain. A stale editor then re-reads before its next write and shows the task as unassigned, instead of answering `TeamNotFound` later.
4. **What are the column and the result tag called?** **Answer (2026-10-24): accepted.** _Recommended: `tasksRevision` on the row, `Changed` on the result unions._ "version" is excluded by the domain's vocabulary, and the column counts writes to the task lists only. Add both to `docs/glossary.md` if accepted.
5. **What does the refusal say?** **Answer (2026-10-24): accepted, with other copy.** _Recommended: "This workflow was changed in another tab. Check the steps and try again."_ **Changed in the answer:** the copy is "This workflow changed since you opened it. Check the steps and try again.", which is true whether the change came from another tab or another person. It may have been another person, not another tab, and the copy could say "changed elsewhere". "Another tab" is the common case for one merchant and is plain.
6. **One `WORKFLOWS_KEY`, or a key per workflow?** **Answer (2026-10-24): accepted.** _Recommended: one key._ The observers are the editor and the workflow page, a few tabs per shop, so a per-workflow key saves only a few reads. Live keys are static today (`liveQuery`'s key list), and per-id keys would change that.
7. **Does the workflows index become live too?** **Answer (2026-10-24): accepted.** _Recommended: not in this work._ It shows no draft state. It shows faults and step counts, which change only on Apply and team changes. Make it live later if a stale index is reported.
8. **Should the writer's own read come from its answer instead of a re-read?** **Answer (2026-10-24): accepted.** _Recommended: no, not now._ Returning `WorkflowPageData` from every task write would save one socket read per press, but it widens ten result unions. With A, the re-read is already one socket message.
9. **Does Fix 0 ship on its own first, ahead of the plan?** **Answer (2026-10-24): accepted.** _Recommended: yes._ It is a few lines in `useEditorPresses`, independent of the revision, and it makes the reported Apply show its banner and the true list now.
10. **E2E coverage.** **Answer (2026-10-24): accepted.** _Recommended: one spec with two pages on one editor_: Discard in one, then Apply and Add step in the other, asserting the refusal banner, the closed dialog and the re-read list. With A, add a check that the second page's Draft badge appears without a press. Unit tests cover the guard in the repository.

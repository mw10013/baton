# Step ownership on the member side: research

Date: 2026-09-22.

Question: a member pressed Start on a step, and the only things the page now
offers are Done and Add note. Should a member be able to give the step back?
Should another member be able to take it over? How far back can a run be
unwound from the member side? And where else does the member side refuse
something a small shop would expect to be allowed?

Short answer: Baton has no per-person assignment, so there is nothing to
unassign. Start is a record of who began, not a lock. Every gap the question
names is either already open (a teammate can press Done, Undo, or edit the
note today) or is a missing verb on a record, not a missing permission. The
proposals in section 4 add one member verb, **Put back** (clear the Start
record), and rely on the merchant's existing Reopen for everything further
back. Decisions are in section 6.

## 1. What the model is today

Read from `src/lib/Domain.ts` (`WorkflowRunStep`, `stepActions`,
`RunStatus` table, `tierOf`, `undoBlockedBy`, `memberHasSeat`) and
`src/lib/WorkflowRunRepository.ts` (`requireActionable`, `startStep`,
`completeStep`, `uncompleteStep`, `setStepNote`).

### Steps belong to teams, not people

- A run step carries `teamId` / `teamName`. That is the only assignment. The
  gate on every member write is "the step's team is one of the caller's teams"
  (`requireActionable`). Nothing checks who started the step.
- `startedBy` / `startedByEmail` / `startedByRole` are a **record** written by
  Start, and backfilled by a Done without Start. `startStep` writes them with
  `coalesce`, so a second Start by anyone is a no-op, not a takeover.
- `completedBy*` is written by Done, unconditionally. `reopened*` is written
  by Undo and cleared by the next Done. All three are last-actor slots, not a
  history. There is no audit table.

So the screenshot's "Finishing · lead@m.com · since 4:08 AM" means "this step
is in progress, and lead@m.com was the one who pressed Start". It does not
mean lead@m.com owns it.

### What any teammate can already do to a started step

`stepActions` gates on `teamIds` only, so a second member of the Finishing
team sees the same buttons on the same step:

| action                | who                                                      | result on the record                                                  |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| Done                  | any member of the step's team, or the merchant           | `completedBy` = them; `startedBy` stays the original starter          |
| Add / Edit note       | any member of the step's team, or the merchant           | one note per step, last write wins, attributed by role only           |
| Undo (finished step)  | any member of the step's team, or the merchant           | clears `completedBy`, keeps a member's `startedBy`, sets `reopenedBy` |
| Block / Unblock (run) | any member with a ready step on the run, or the merchant | run flag, with the actor in the flag detail                           |
| Start                 | any member of the step's team, if not already started    | first press wins; later presses change nothing                        |

The permission system is already as porous as the question asks about. The
only thing it lacks is a way to get from "started by A" back to "Ready".

### What "Mine" means

The run list's Mine tab is `tierOf`: a run is mine when any of its steps has
`startedByEmail` equal to my email. Start is therefore the one member verb
that changes whose list a run sits on. That is the whole reason Start exists
as a separate button from Done: it says "I have this" to the rest of the team
and moves the run out of Up next for everybody else.

That also names the cost of a Start pressed by mistake: the run leaves Up
next, sits on the wrong person's Mine tab, and every teammate reads it as
taken. Nobody on the member side can put it back today.

### How far back a run can be unwound today

- **Undo** reopens a finished step. It is refused when a step in a later
  stage has been started (`undoBlockedBy`), and that verdict is precomputed
  per step. A member sees Undo only on steps whose undo is not blocked.
- Undo clears a merchant "start" (which is only ever Done's backfill) but
  keeps a member's `startedBy`, so an undone step comes back as **In
  progress by the original starter**, not as Ready. The screenshot is exactly
  this: step 3 was undone ("Reopened by lead@m.com") and came back in
  progress.
- To reach "step 1 is Ready" from the screenshot, the member side has no
  route at all: step 3 is started, so Undo on step 2 is blocked; step 3 is not
  finished, so it has no Undo of its own. The chain is stuck behind a Start.
- The merchant's order page has the same rule with one more verb per step
  (Mark done, Reopen, Assign team, note) plus Block and Cancel per run. Reopen
  is the same `uncompleteStep` and hits the same blocker. So the merchant
  cannot unwind it either.

The gap is precise: **there is no inverse of Start.** Done has Undo, Block has
Unblock, Cancel has Un-cancel, assign has re-assign. Start has nothing.

### Losing a seat

`memberHasSeat` is derived on every request from plan and roster order.
Nothing is written on a downgrade, so a member who loses their seat keeps
their `startedBy` records. Their started steps stay In progress under their
email. Teammates on the same team can still press Done on those steps, and the
merchant can Mark done or reassign the team, so the work is not stuck. What is
wrong is the label: the step says it is being worked by someone who cannot
sign in, and the run is missing from everyone else's Mine tab. Same shape as
the mistaken Start, so the same fix covers it.

Deleting a member has the same effect on the record and is already
documented on `Member`: history keeps the email as text.

### Reassigning the team on an open started step

`assignRunStepTeam` (merchant only) moves an open step to another team and
deliberately keeps `startedBy`. The new team then sees "In progress · <old
team member> · since …" on a step none of them started, with only Done
offered. That is another face of the same missing verb.

## 2. First principles

The product is for small shops with no roles and no audit trail. Three
principles follow, and each one is already visible in the code:

1. **Records, not locks.** Every actor slot is a snapshot for the human
   reading the page, never a gate. Adding a self-only rule anywhere would be
   the first lock in the system and would need a role to override it.
2. **Every verb has an inverse, and the inverse is as open as the verb.**
   Undo is offered to the whole team, not just the completer. Whatever undoes
   Start should be offered to the whole team too.
3. **A mistake costs one press.** Done today is undone by one Undo, from the
   run list's Done today tier. A Start by mistake should cost the same.

Against those, the three candidate designs from the question:

| design                                                           | verdict                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| self-unassign only                                               | first lock in the system, and a stuck step when the starter is gone (seat lost, member deleted, on holiday). Rejected.    |
| any teammate may put back                                        | matches how Done, Undo and notes already work. Recommended.                                                               |
| any teammate may take over (replace `startedBy` with themselves) | a second verb for the same fix. Put back then Start is two presses and reads the same. Not worth its own button; see 6.2. |

## 3. What Route to Ship and the other refs do

The refs are marketing pages, App Store listings and screenshots, not source,
so this is what the vendors say and show.

### Route to Ship (`refs/route-to-ship/`)

- Work goes to **departments**, not people. `index.md`, "Custom Pipelines":
  "Create departments (Print, Engrave, Pack). Add people to each." Same
  model as Baton's teams.
- A worker **accepts** a step. `demo.md`, "Worker-first UX": "Workers see
  only their queue. Tap accept, tick the list, mark done." The step then
  shows the person's name and a timer ("Linda Park · Engraving · Engrave
  item ⏱ 6:12" in the `index.md` mockup). That is Baton's Start.
- The My Work screenshot (`_assets/CN7m4-iSrJQDEAE=-2.png`) shows each
  in-progress row with a Done button and a `⋮` menu whose contents are never
  shown. No text anywhere mentions un-accepting, releasing or handing a step
  to someone else.
- **No step goes backwards.** `who-its-for.md`: "Orders move forward as each
  step is completed." Rework is handled by **Escalate** to a line manager,
  which freezes the order: "This order has been escalated. Actions are
  disabled until resolved by a line manager." What the line manager can then
  do is not documented.
- **Roles exist**: Admin and User, plus a Line Manager flag, scoped by
  department (User Management screenshot `_assets/CIX77eiSrJQDEAE=.png`;
  `pricing.md` "Role-Based Access"). Only escalation is shown to be gated by
  them.
- Seats: `pricing.md` FAQ says exceeding the user limit means buying an
  add-on seat or upgrading. Nothing says what happens to a removed person's
  in-progress work.
- History: "Timestamps every handoff" (`index.md`), a Past Work page, and
  "Every step is recorded" (`who-its-for.md`). No activity log or per-order
  history screen is shown.

So Route to Ship answers the question with roles and a freeze: a worker who
accepted by mistake has no visible way out, and unwinding is a manager's
job. That is the enterprise-shaped answer this doc is arguing against, and
it costs them a role system Baton has decided not to have.

### The others

- **Kanbanify** (`refs/kanbanify/`): one assignee per order card, picked
  from a roster by anyone. The assign popover (`_assets/CI6V1oyY-5QDEAE=-2.png`)
  has **Assign to me** and **Unassign**, and re-picking is a takeover. Cards
  move backwards freely by drag or the stage changer. No roles, no gating,
  no history. This is the "fully porous" design, and it works because the
  assignee is a label on a card, which is what Baton's `startedBy` is too.
- **Maker's Production View** (`refs/makers-production-view/`): no people
  at all, but an **Undo** link beside every "Mark produced" count
  (`_assets/queue.png`). Every verb has an inverse.
- **MakerBatch**, **BenchCue**: no staff, assignment or undo. Not relevant.

Across the five, nobody keeps an audit log, only Route to Ship has roles, and
the two apps that let people take work (Route to Ship, Kanbanify) differ
exactly on the question asked: Kanbanify has Unassign and Route to Ship does
not. Kanbanify is the model closer to Baton's stated constraints.

## 4. Proposal

### 4.1 Add `Put back` on an in-progress step

- Member side: a `Put back` button beside Done on any step that is In
  progress, ready, on one of the member's teams, run open and not flagged.
  Same gate as Done, so nothing new for `stepActions` to say beyond one more
  boolean.
- Write: `unstartStep` clears `startedAt` / `startedBy` / `startedByEmail` /
  `startedByRole`. Refused if the step is finished (`StepNotReadyError`), or
  the run is not open, or the step is not the caller's team.
- Result on the page: the step goes back to Ready with the team name, the run
  returns to Up next for everybody. The Mine tab on the starter's phone loses
  the row.
- Merchant side: the same verb in the Manage row of a started step, next to
  Mark done. This is the affordance the question guessed at for the seat and
  reassignment cases.
- No `unstartedBy` slot. The step is plain Ready again and the next Start
  writes a fresh record. A "put back by" line would be a fourth last-actor
  slot with nothing to hang it on.

Wording: `Put back`, not `Unassign` (there is no assignment to undo, and the
merchant page uses assign for teams) and not `Release` or `Give up`. `Put
back` says where the step goes: back on the shelf. Alternatives are in 6.1.

### 4.2 Undo returns a step to Ready, not to In progress

Change `uncompleteStep` to clear the member `startedBy` as well as the
merchant one. Reasons:

- Today an undone step reads "In progress · A · since <original start
  time>", which is a time that is now wrong and a claim A did not make.
- With Put back it would take two presses to reach Ready from Done. Undo
  then Put back is a two-step inverse of a one-step action.
- The `reopened*` slot already records who reopened it and when, so nothing
  is lost. "Reopened by A · 11h ago" is the honest state line.

This is a change of an existing rule (decision 6.3).

### 4.3 The unwind path becomes: Put back, then Undo, repeated

From the screenshot: Put back step 3 (now Ready). Undo step 2, which is no
longer blocked because nothing later is started. Undo step 1. Step 1 is
Ready. Three presses, each of them the one-step inverse of what happened,
each visible to the whole team as it happens. No new "reset run" verb is
needed, and none is proposed: a reset would skip the confirmation the page
gives at each step and would need its own blocker rules.

### 4.4 Take over is not a verb

A teammate who wants a started step presses Put back and then Start. Two
presses, both already on the page, and the intermediate state (Ready) is a
true state. A single Take over would have to decide whether the record
should keep the old starter somewhere, and the model has nowhere to keep it.

## 5. Other places the member side refuses more than it needs to

Read against the same principles.

- **Note is single-slot, last write wins, attributed by role only.** Two
  members editing the same note overwrite each other and the page shows
  `Note (Merchant)` or nothing. Not a permission gap. Noted because the
  question asked about "any other team member can edit the note", and the
  answer is yes, at the cost of losing whatever was there.
- **Start is not offered on a step that is ready but not on my team.** By
  design: teams are the one assignment. A member on the Woodshop team cannot
  press Start on an Engraving step. Keep it. A shop where one person does
  everything has one team.
- **A member cannot cancel or un-cancel a run.** Both are merchant verbs on
  the order page; members have Block, which they can also lift. Symmetric.
  Keep.
- **A member cannot dismiss a reconcile flag.** Item removed, quantity
  changed, order cancelled and order fulfilled are Shopify facts and the
  merchant is the one who can check them. Keep. Blocked, the one flag members
  set, they can also lift.
- **A member cannot reassign the team on a step.** The workflow's teams are
  merchant configuration. Keep. Put back covers the case where the member's
  problem was "I should not be on this", because it hands the step back to
  whoever the merchant put on the team.
- **Undo is hidden, not disabled, when blocked.** A member sees no Undo on
  step 2 while step 3 is in progress and gets no sentence saying why. With
  Put back on step 3 on the same page, the path is now visible. Keep the
  hidden button.
- **Merchant Start does not exist.** The merchant can Mark done and Reopen
  but not Start. Consistent with "the merchant records, the team works". Keep.

## 6. Decisions

Reviewed in Plannotator on 2026-09-22. Every recommendation was accepted. No
open questions remain.

1. The verb is `Put back`.
2. `Put back` is offered to the whole team of the step, not only the starter.
3. Undo clears a member's Start as well as the merchant's: an undone step
   returns as Ready, with the `reopened*` slot as the only trace. The Done
   today row therefore returns to Up next, not to Mine (this changes the
   current e2e expectation "undo puts a finished step back in progress").
4. No confirmation dialog on `Put back`, on either side.
5. The merchant gets `Put back` in the Manage row of a started step, beside
   Mark done.
6. Reassigning a step's team leaves `startedBy` alone.

Implementation: `docs/step-ownership-plan.md`.

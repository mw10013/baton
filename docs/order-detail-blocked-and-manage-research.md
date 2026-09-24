# Order detail: blocked state and Manage actions research

The blocked badge and strip, the Manage action row, the note, and the Change workflow flow on the merchant order page (`/app/orders/$orderId`), compared against the member run page (`/shop/$shop/workflows/$runId`), which has already been through its own research and reads better.

Written 2026-09-24. Screenshots: order #1030, "Heirloom leather journal" run, blocked by the merchant with reason "WE are stuck", a 20-task workflow where step 2 is three parallel tasks with the same name.

## What exists today

| Surface         | Order page                                                                                                                                                                                                                                  | Member run page                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocked badge   | `s-badge tone="warning"` (amber) beside the status badge, from `flagLabel`. Every flag is `warning`.                                                                                                                                        | `flagTone`: `critical` (red) for `blocked` and `order_cancelled`, `warning` for the three reconcile flags. Run list uses it for the row badge; the Blocked tab goes critical while it has rows. |
| Blocked block   | `blockedStrip`: a grey `s-box background="subdued"` with a bold line "Blocked · <ready task names joined by comma>", the reason paragraph, then "Blocked by Merchant · 11:30 AM" with Edit and Unblock.                                     | `FlagBanner`: `s-banner tone="critical" heading="Blocked"`, the reason as typed, "Merchant · 3m ago", Edit and Unblock in the banner's action slot.                                             |
| Unblock         | Twice: in the strip, and first in the Manage row (where Block sits while not blocked). `unblockButton` is one definition rendered at both sites.                                                                                            | Once, in the banner.                                                                                                                                                                            |
| Cancel run      | `tone="critical"` secondary button in the Manage row. No confirmation.                                                                                                                                                                      | Not offered.                                                                                                                                                                                    |
| Block           | `tone="critical"` secondary button in the Manage row, opens `BlockModal`.                                                                                                                                                                   | Plain secondary page action, opens the same `BlockModal`.                                                                                                                                       |
| Note            | `noteBlock` on the card only when non-empty, with a tertiary Edit. `Add note` in the Manage row while empty. Both open `RunNoteModal`.                                                                                                      | Always drawn while the run is live: the note as prose, or the subdued word "Note" as placeholder, with one secondary Edit. Opens `RunNoteModal`.                                                |
| Change workflow | Toggle button in the Manage row; the picker (label, select, Change, Cancel) expands under the row. Open state is a `Set<runId>` so several runs can hold an open picker at once. A pick on a touched run then opens the confirmation modal. | Not offered.                                                                                                                                                                                    |

Both pages already share `BlockModal`, `RunNoteModal`, and `RunSteps`. The member page's flag banner and note block are not shared; the order page has its own `blockedStrip` and `noteBlock`.

## 1. The Blocked badge colour

Today the order page paints every flag `warning`, so "Blocked" sits in amber next to a blue "In progress". The member side already decided this in `flagTone`: `critical` where work must stop and someone outside the bench has to act, `warning` where the work changed under the maker and the response is to read and acknowledge. Blocked is the former. The reasoning holds on the merchant side and more so: the merchant is the person who has to act.

Polaris uses `critical` (red) for "stopped, needs intervention" and `warning` (amber) for "needs attention, not stopped". Blocked is stopped.

Recommendation: import `flagTone` from `MemberRun` and use it for the order page badge. That makes `blocked` and `order_cancelled` red and the three reconcile flags amber, the same split the worker sees, with one function deciding for both pages. The `RUN_FLAG_LABEL` wording stays the order page's own, since the merchant vocabulary ("Item removed", "Already shipped in Shopify") differs from the worker's ("No longer needed", "Already shipped") on purpose.

## 2. The blocked strip: colour and shape

The member page's `FlagBanner` is a red `s-banner` with the heading "Blocked", the reason, the attribution, and the buttons in the banner's own action row. The order page draws a grey box with the same content laid out by hand.

Options:

1. **Reuse `FlagBanner` as is** (recommended). Same component, same tone, same attribution line, same button slot. The order page passes Edit and Unblock as `actions`. One less bespoke block on the order page, and the merchant sees the same thing the worker sees, which matters when they are on the phone together.
2. **Keep `blockedStrip` but give the box a critical tint.** Polaris `s-box` has `background="subdued"` only; there is no critical background token on the box. The way to get red is the banner.
3. **Keep the grey box.** It reads as an info block, not a hold. The user's instinct that it "needs to really jump out" is right.

One cost of option 1: an `s-banner` inside a section is heavier than a subdued box, and a blocked run's card becomes tall. That is the correct weight for a stopped run. A card with a red badge and a red banner is loud, and it should be.

A second cost: the banner has no place for the "what is stuck" line. See 3, which argues that line should go anyway.

## 3. The strip's words

The strip today says, on the screenshot run:

> **Blocked · 2. Condition, burnish and inspect the edges against the customer, 3. Condition, burnish and inspect the edges against the customer, 4. Condition, burnish and inspect the edges against the customer**
> WE are stuck
> Blocked by Merchant · 11:30 AM [Edit] [Unblock]

Three problems.

**"Blocked" three times on one card.** The badge says Blocked, the strip heading says Blocked, the attribution says Blocked by Merchant. The banner solves the first two: with a red banner headed "Blocked" the badge is arguably redundant too, but the member run list keeps both (badge in the row, banner on the page) because they are on different screens. On the order card they are on the same card, four lines apart.

Options for the badge:

- a. Keep the badge and drop "Blocked" from the attribution line: "Merchant · 11:30 AM", the member page's exact form. Two mentions, both structural (badge, heading).
- b. Drop the badge while the banner is shown. The banner's heading is the badge. One mention. But the badge row is the one place the collapsed card summarises state at a glance, and a merchant scanning six cards reads badges, not banners. Also the badge is what the orders index shows, so the card and the index should agree.

Recommendation: a. Keep the badge, reuse the member attribution line without the verb.

**The ready-task list does not scale.** `blockedStrip`'s heading joins every ready task name. On a parallel step that is N copies of the name; on a real workflow the names are 60 characters each. The JSDoc justified it: "blocked is a run-level flag and on a multi-step run 'blocked' alone does not say what is stuck." But the card already answers "where is the run" through `nowLine`, which `blockedStrip` suppresses while blocked to avoid naming the task twice. So the strip took over the Now line's job and does it worse, as a comma list in bold.

Options:

- a. **Drop the task list from the strip and let `nowLine` render while blocked** (recommended). The card then reads: badges, red banner (reason, who, when, Edit, Unblock), then "Step 2 of 18 · Condition, burnish and inspect…" in the same form every other card uses. `nowLine` already handles a parallel step. The banner says why it stopped, the Now line says where. The blocked run is the one card where "where" and "why" are different questions, and they get different lines.
- b. Keep the list but cap it: first task name plus "and 2 more". Still a second position line in a different notation.
- c. Keep the list but name the step, not the tasks: "Blocked at step 2". That is `nowLine`'s first half again.

Under option a, the only thing that goes is the JSDoc rule "the ready task is named because blocked is run-level", and the reason it existed is served by the Now line.

**The reason under a bold heading reads as a subheading.** In the banner it is body text under "Blocked", the way the member page shows it. Fine once the banner is in.

Proposed render on the screenshot run:

> [In progress] [Blocked]
> ┌ red banner ─────────────────────────────
> │ **Blocked**
> │ WE are stuck
> │ Merchant · 11:30 AM
> │ [Edit] [Unblock]
> └────────────────────────────────────────
> Step 2 of 18 · Condition, burnish and inspect the edges against the customer

The reason line should use `Prose` so a multi-line reason keeps its line breaks, as it does on the member page.

## 4. The Manage row: Unblock, Cancel run, Block

Screenshot 2 shows the row under 18 step cards: `[Unblock] [Cancel run (red)] [Change workflow] [Add note]`.

**Unblock twice.** The JSDoc reason: "a merchant who opened the disclosure should not have to close it to unblock." But the strip is on the card above the disclosure, not hidden by it, and on a 20-task workflow the disclosure is the thing that scrolls the strip away, not the thing that closes it. The second Unblock exists so the merchant at the bottom of a long drawer does not have to scroll to the top. That is a scrolling argument, and it applies equally to Edit, which is not duplicated.

Recommendation: remove Unblock from the Manage row. Block is the only hold action in the row, offered while the run is open and not blocked; while blocked, the row's first slot is empty and the banner is the one place to lift the hold. The member page has one Unblock and nobody has asked for a second. Fewer places for the same write means the banner is the blocked run's control surface, which is the message the red colour sends.

**Cancel run in red.** Polaris `tone="critical"` on a secondary button means "destructive, and this click does it." Cancel run has no confirmation today (`intervene({ kind: "cancel" })` writes on click) and is reversible by `Undo cancel` on the card. Block is also red, opens a modal, and is reversible by Unblock. Neither is irreversible. The order page's own JSDoc says Block "keeps its critical tone; that says 'irreversible for the bench'", which is a stretch: a blocked run comes back with one tap.

Polaris guidance: use critical on the action that commits the destructive change, usually the primary button of a confirmation, not on the button that opens the confirmation. The change-workflow modal already does this correctly: plain "Change workflow" button in the row, red "Change workflow" in the modal.

Options:

- a. **No red in the Manage row** (recommended). Block and Cancel run become plain secondary buttons. The BlockModal's submit is already `critical`. Cancel run either gains a small confirmation with a red submit, or stays a one-click reversible write in plain tone. Given `Undo cancel` sits right on the card afterward, no confirmation is defensible; the toast "Run cancelled" and the Undo button are the safety net.
- b. Red on Cancel run only, on the grounds that cancelling wipes the run from every team's view. But so does blocking (the run drops out of every team's ready tier), and Cancel is undoable.
- c. Keep both red. Two red buttons in a four-button row makes neither stand out.

Question 4a: should Cancel run get a confirmation? Recommendation: no, keep the one-click write, because `Undo cancel` is on the card and a confirmation on a reversible action trains merchants to click through confirmations. The Change workflow confirmation is different: that one is not undoable (see 6).

## 5. The note

**"Add note" implies "Remove note".** The user is right. The note is a nullable column on the run, always present, and `SetRunNoteCommand` with `note: null` is how it clears. The member page models this correctly: the note block is always drawn while the run is live, showing the text or the subdued placeholder "Note", with one Edit button. The order page has two entry points (Edit on the card when non-empty, Add note in Manage when empty) for one field.

Options:

- a. **Copy the member page's note block to the card** (recommended). Draw it on every live run's card: prose or subdued "Note", with a secondary Edit. Remove `Add note` from the Manage row. The note is what anyone opening the order should read, which is the existing JSDoc's own argument for showing it on the card at rest; the placeholder finishes that argument for the empty case.
- b. Keep `noteBlock` for the non-empty case and rename `Add note` to `Edit note`. Fixes the verb, keeps two places.
- c. Keep as is.

Under a, the Manage row loses two buttons (Unblock, Add note) and keeps Block, Cancel run, Change workflow. A done run, which has no Manage row, still shows its note with Edit on the card, so the "a done run takes a note" rule is preserved without the row.

Where on the card: the member page puts the note above the tasks, under the item. On the order card the equivalent slot is after the Now line and before the attention rows, which is where `noteBlock` already sits. Keep it there.

Should it share code with the member page? The member block is twelve lines of JSX inline in the route. Lifting it into `MemberRun.tsx` as `RunNote({ note, canEdit, pending, onEdit })` and using it on both pages is cheap and keeps the placeholder word and the verb from drifting. Recommendation: share it.

One difference to keep: the member page draws nothing for a blank note on a cancelled run. The order card should do the same, since `Domain.runIsLive` gates the edit either way.

## 6. Change workflow: inline picker or modal

Today: `Change workflow` toggles an inline picker under the row. The picker persists per run in `changeOpen`, so it stays open across navigation within the page, and several runs can hold one open. The toggle is the only way to dismiss it other than its own Cancel. On a touched run, submit opens the confirmation modal; on an untouched run it writes at once.

The user's observations are all real:

- A merchant who opens it and walks away comes back to a select floating under a button row with no heading saying why.
- With Manage open on two runs, two pickers can dangle at once.
- Every other write on this page (note, block reason, the change confirmation itself) is a modal. The picker is the one inline editor left, and the previous research round removed the others for the same reason.

Options:

1. **One modal for Change workflow** (recommended). `Change workflow` opens `s-modal` with the select and, when the run is touched, the warning sentence already built by `changeWarning`. Submit is the red "Change workflow"; secondary is "Keep <from>". No inline state, no per-run open set, and the touched-run path stops being two dialogs in sequence (pick inline, then confirm in a modal). Untouched runs get the same modal with the warning line omitted; a modal for a no-loss change is one extra click, and it removes the surprise of an instant write from a select.
2. Keep inline but close it on any other action and on blur. Patches the dangling state, keeps the two-shape inconsistency.
3. Keep inline, add a heading and a Cancel. That is a modal drawn in the wrong place.

Under option 1, the at-rest picker for an item with no run (the "Start" case and the ambiguous case) stays inline. That one is not a dangling editor: it is the item's resting state, open because the item has no run and choosing is the only thing to do. The two pickers today share `workflowPicker` and `attachChoice`; after the change they share the select's option list and the `submit`, and the modal owns its own choice state so a pick left in the modal does not preselect the at-rest picker (the same leak the current Cancel handler clears by hand).

Modal content, touched run:

> **Change workflow?**
> [Workflow ▾ select, current workflow excluded]
> Heirloom leather journal… has 1 of 18 steps done. Change to <picked> anyway? That work will not carry over.
> [Keep Heirloom leather journal…] [Change workflow (red)]

The warning line updates as the select changes; before a pick it is the first sentence only and the submit is disabled.

Question 6a: with the picker in a modal, does the row need both `Change workflow` and `Cancel run`? They are different operations (replace vs stop) and both stay.

## 7. What Change workflow does to the run

Confirmed from `WorkflowRunRepository.setRun`, in one transaction:

1. If the item's live run is already this workflow: no-op.
2. If the live run is `done`: refused (`RunFinishedError`); the page hides the button for done runs.
3. Otherwise the live run is set to `cancelled` (the row is kept, not deleted, with `cancelledAt`).
4. If the item has a **cancelled** run for the target workflow, that row is un-cancelled and its status recomputed. Its tasks, with whatever was done on them, come back.
5. Else a fresh `WorkflowRun` is inserted with tasks copied from the workflow definition. `insertRun` does not write `note`, `flag`, or `flagDetail`, so the new run starts with a null note and no flag.

So the mental model "delete and rebuild" is close but not exact. The old row is cancelled and stays; `Undo cancel` is not offered on it while another live run holds the item (the partial index would refuse the un-cancel), but the history is there. And a switch back to a workflow the item previously ran resumes that earlier run rather than starting over, which is case 4 above and is documented on `setRun` as "what the merchant means".

**Should tasks merge across workflows?** No. Two workflows are two task lists with no shared identity; a task named "Cut" in both is a coincidence of text, not the same work, and a merge by name would silently mark work done that a different team may define differently. The current design (nothing carries; the confirmation says so) is right and should not be revisited.

**Should the note carry over?** The note is a run column, so the fresh run's note is null today. Cases:

| Case                                                                                    | Note before switch                                | Carry over?                                                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Merchant picked the wrong workflow at attach time, run untouched, switches immediately. | Usually blank.                                    | Harmless either way.                                                                                                           |
| Run partly done, the item turns out to need a different process.                        | "Customer wants initials M.E.B. not M.B.E."       | Useful: the note is about the item, and the new teams need it.                                                                 |
| Run partly done, note is about the old process.                                         | "Second hide, first had a scar" or "Foil arrived" | Stale: the new teams read a note about steps they will never do, and nothing says it is old.                                   |
| Run blocked with a reason, then switched.                                               | Reason lives in `flagDetail`, not the note.       | Not carried today (fresh run has no flag). The hold ends with the switch. That seems right.                                    |
| Switch back to a workflow the item ran before (case 4 above).                           | The earlier run's own note comes back with it.    | Already carries, because the row is reused. The note the merchant just wrote on the interim run is left on that cancelled run. |

There is no author or timestamp on the note, so a carried-over note cannot be labelled "from the previous run". A stale note is indistinguishable from a fresh one.

Options:

1. **Do not carry the note** (recommended). Consistent with "nothing carries over", one rule to explain, and the confirmation sentence already says it. The cost is the second row of the table: the merchant retypes an item-level note. That is a rare event (switching a partly done run) times a note that is usually short.
2. Carry the note. Saves the retype in one case, risks a misleading note in another, and makes case 4 inconsistent (which note wins, the reused run's or the interim run's?).
3. Show the old note in the Change workflow modal, prefilled into a note field, so the merchant edits it as part of the switch. Most correct, but it turns a one-select modal into a form, for a rare event. Not worth it now.
4. Copy the old note into the new run's note prefixed "From <old workflow>: ". Labels it, but the prefix is prose nobody asked for and the field has a cap.

If option 1, the confirmation sentence could grow by a clause, "That work and the note will not carry over", only when the old run has a note. Recommendation: add the clause conditionally; it costs nothing and answers the question before the merchant asks it.

**Should the old teams be told?** No mechanism exists and none is proposed. Cancelling the old run drops it out of every team's ready tier on their next socket update, the same way Cancel run does. A worker with the old run page open gets the "Cancelled" badge and read-only page on refresh. That is the existing behaviour for Cancel run and is adequate; a notification system for reassignments would be a feature the shop has not asked for. The one thing worth checking in the plan: a worker who had a task **started** on the old run and presses Done after the switch gets a clean refusal (`RunTerminalError`) and the page's existing "no longer" copy, not a stack trace.

## Decisions (2026-09-24)

Every recommendation below was accepted as written. The implementation plan is `docs/order-detail-blocked-and-manage-plan.md`.

| #   | Decision                                                                                   | Detail                                                                                                             |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Q1  | Blocked badge red on the order page?                                                       | Yes, via the member page's `flagTone`: blocked and order-cancelled red, reconcile flags amber, one function.       |
| Q2  | Replace `blockedStrip` with the member page's red `FlagBanner`?                            | Yes. Edit and Unblock go in the banner's action slot.                                                              |
| Q3a | Keep the Blocked badge when the banner is shown?                                           | Yes, the badge is the glance and matches the index. Drop "Blocked by" from the attribution: "Merchant · 11:30 AM". |
| Q3b | Drop the ready-task list from the strip and let the Now line render while blocked?         | Yes. The banner says why, the Now line says where.                                                                 |
| Q4  | Remove the second Unblock from the Manage row?                                             | Yes. The banner is the one place to lift a hold.                                                                   |
| Q4a | Any red button in the Manage row? Confirmation on Cancel run?                              | No red in the row; red stays on modal submits. No confirmation on Cancel run, since Undo cancel is on the card.    |
| Q5  | Note block always drawn on a live run's card with a placeholder and one Edit, no Add note? | Yes. Share the block with the member page as a small component.                                                    |
| Q6  | Change workflow in a modal instead of the inline picker?                                   | Yes. Select and warning in one modal, red submit. The at-rest Start/ambiguous picker stays inline.                 |
| Q7a | Merge tasks across workflows?                                                              | No. Confirmed not worth pursuing.                                                                                  |
| Q7b | Carry the note to the new run?                                                             | No. Add "and the note" to the warning sentence when the old run has one.                                           |
| Q7c | Tell the old teams?                                                                        | No mechanism; the run leaves their view like a cancelled run does. Verify the stale-page refusal copy in the plan. |

After Q1 to Q6 the Manage row is `[Block] [Cancel run] [Change workflow]` in plain secondary tone, and the card at rest reads badge, red banner when blocked, Now line, note, attention rows.

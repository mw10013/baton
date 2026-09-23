# Member run page research

The member work page (`/shop/$shop/workflows/$runId`, `src/routes/shop.$shop.workflows.$runId.tsx`). What is on it today, why each piece reads as noise, the decisions taken so far, and the questions still open with more research behind each.

Written 2026-09-23. Reworked the same day after the first review; closed after the second. Implementation: `docs/member-run-page-plan.md`.

## Vocabulary

The product has runs, tasks, steps, orders and items. It has no "job". Earlier drafts used the word; this one does not, and copy proposed here must not either.

## What the page shows today, top to bottom

| #   | Element                                                          | Source                                               |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Page heading `#2009`                                             | `run.orderName`                                      |
| 2   | Page action `Block` (when not flagged)                           | secondary-actions slot                               |
| 3   | Card: `Leather journal ×1`                                       | `RunItem`: title, variant, quantity                  |
| 4   | Card: `Engraving  Order 2009`                                    | `Personalization`: the line item's custom attributes |
| 5   | Card: badge `Leather journal` + `ordered 21m ago`                | `run.workflowName`, `run.orderProcessedAt`           |
| 6   | Card: Blocked banner with Edit / Unblock                         | `FlagBanner`                                         |
| 7   | Card `Note` with `Add note` / `Edit`                             | `run.note`                                           |
| 8   | Card `Order note` (when Shopify has one)                         | `view.orderNote`                                     |
| 9   | Card `Steps`: `Step n` label, task cards                         | `WorkflowLayout.stepsOf`                             |
| 10  | Task card: name, badge, team · who · when, instructions, buttons | `taskState`, `Domain.taskActions`                    |

Three things in the screenshot are seed values, not layout:

- `Engraving  Order 2009` is a personalization row. The attribute key is `Engraving` and the seeded value is the string `Order 2009`. Real data reads `Engraving  M.E.B.`.
- The `Leather journal` badge is the workflow name. The seed named the workflow after the product.
- The banner says `Blocked` twice because the seeded block reason is the word `Blocked`.

The seed stays as it is (decision 14). Judge the page knowing these three lines are placeholders.

## Decisions

Taken in the first review. Each is final unless reopened.

1. **Heading.** `#2009` alone. The item is the first strong line under it. No `Order` prefix: `#` is the order convention in Shopify and on the run list. Two runs from one order are told apart on the list, which shows item title beside the number, before the page opens.
2. **Workflow badge.** Removed from the member page. The merchant order page keeps it.
3. **Flag banner.** Moves to page level, directly under the heading, above the item, where `SocketBanner` sits. The mutation error banner moves with it.
4. **Note, filled state.** Prose with a small `Edit` beside it. No `Note` heading. The verb is always `Edit`. There is no `Add`, because there is one note per run and nothing to add to or remove from.
5. **Order note.** Folded into the same prose block, prefixed `From the order:` in subdued text.
6. **`waiting on step 2`.** Removed. A waiting task shows the team name and nothing else.
7. **Primary buttons.** None on task cards. All task buttons are secondary. Polaris allows one primary per page and one primary per card (`refs/shopify-docs/docs/apps/design/layout.md`, "Cards that offer interactivity"), and two ready tasks would otherwise draw two. The badge already carries the state.
8. **Button order.** The advancing action first, the reverting one second. `Start · Done` on Ready, `Done · Put back` on In progress, `Undo` on Done.
9. **`Start` and `Done` together on a Ready task.** Both stay, Start first, neither primary. The run list's row menu already offers one-tap Done on a ready task and the page must not be stricter than the list.
10. **Note, blank state.** Same layout as the filled state: the word `Note` in subdued text where the prose would be, and `Edit` beside it. Not `No note`: the reviewer chose `Note` as the placeholder, so the line names the field rather than reporting its emptiness. On a cancelled run with a blank note, nothing renders.
11. **Step grouping.** `Step n` subheading over one bordered box per step. Parallel tasks sit inside that box separated by rules. No `Steps` heading and no outer card. This supersedes the first draft's one-card-for-all-tasks form.
12. **Age.** `ordered 21m ago` removed from this page. The run list carries age.
13. **Item.** Plain text under the heading, no border: item line, personalization, SKU.
14. **Seed data.** Unchanged. The placeholder values listed above stay.

## Research behind the later decisions

Kept for the reasoning. Every question here is closed; the answer is in Decisions.

### 1. Note, blank state

Rejected wording: `Add a note for this job`. Two faults: "job" is not a concept here, and "add" implies a collection.

What the blank state has to do: tell a member the note exists and is theirs to write, in one line, with the same verb as the filled state.

Options:

- **A. Same shape as filled.** A subdued line `No note` where the prose would be, and the same `Edit` beside it. The filled and blank states are one layout with different text. Nothing is added; the note is edited from blank to something.
- **B. Link line only.** A single link-styled line `Edit note` and no placeholder text. One line, no button, but a link with no object beside it reads as a menu item.
- **C. Page action.** `Note` beside `Block` in the page's secondary actions, and nothing in the body when the note is blank. Cleanest page. A worker who has not been told the note exists will not find it, and Polaris caps a page at three secondary actions, which Block, Note and a future third would reach.
- **D. Always show the field.** An inline text area, always present, saved on blur. No modal, no verb at all. Rejected earlier for the block reason for the same reason it fails here: a mounted text area on every visit for a field written on a few.

Chosen: A, with `Note` rather than `No note` as the placeholder (decision 10). It is the only option where the blank and filled states are visibly the same thing: there is always a note, it may be blank, and the only verb is Edit.

### 2. Step grouping

Rejected: the number inside the task card (`2  Stamp monogram`). Two cards each showing `2` did not make it obvious that they are one step with two parallel tasks. The reviewer preferred the `Step n` subheading because it makes the grouping apparent.

The requirement is that a step with parallel tasks reads as one stop, at a glance, and a step with one task does not pay for that with an extra label row it does not need. Those pull against each other; the options trade one for the other.

Options:

- **A. Today.** Outer `Steps` card, `Step n` subheading, one bordered card per task. Grouping is carried by the subheading alone; the task cards under one subheading look identical to the task cards under the next, so the eye has to read the captions to find the boundaries.
- **B. Subheading plus one box per step.** No outer card and no `Steps` heading. Each step is a `Step n` subheading over one bordered box. Parallel tasks sit inside that box separated by rules, the way run list rows are separated. The boundary between steps is a gap and a caption; the boundary between parallel tasks is a rule inside a shared border. Grouping is visible without reading anything.
- **C. Subheading only on multi-task steps.** Same as A but the `Step n` caption is omitted for single-task steps. Cheaper on a three-step run with one parallel step, but the page then has captions on some steps and not others, and a reader cannot tell whether an uncaptioned card is step 1 or an orphan.
- **D. One card, rules between tasks, captions as rows.** One outer card, `Step n` as a subdued row inside it, tasks separated by rules. Compact and consistent with the run list, but a caption row between rules looks like a task with no content, which is the ambiguity the reviewer hit.

Chosen: B (decision 11). It keeps the subheading the reviewer liked, gives parallel tasks a shared border that says "one stop" without reading, drops the `Steps` heading and the outer card, and a single-task step is a caption over one box, which is no worse than today. It replaces decision "one card with rules between tasks" from the first draft, which was accepted under the assumption that step numbers lived in the cards; with subheadings restored the one-card form becomes option D.

### 3. Start and Done on a Ready task

The reviewer accepted keeping both, then said in a separate note that they no longer know whether one-tap Done is worth two verbs side by side. So the question is open.

What Start does, from the code:

- Records `startedAt` and who, which the task line then prints as `since 2:11 PM`.
- Moves the run into the member's Mine tier on the run list and into Teammates for the rest of the team (`Domain.tierOf`). This is the whole of what those two tabs show.
- Enables Put back, the fix for a Start pressed by mistake.

What one-tap Done skips: all of the above, for a task that took less time than the two taps would.

What the run list already does: a ready task's row menu offers `Start`, `Done` and, once started, `Put back` (`shop.$shop.index.tsx`, `menuItems`). One-tap Done from Ready is already the list's behaviour. Removing Done from Ready on the work page would make the page stricter than the list it was opened from, which is the worse inconsistency.

What the competitor does: Route to Ship's demo copy is "Tap accept, tick the list, mark done" (`refs/route-to-ship/demo.md`). That is a two-tap minimum, and accept is what makes the worker's queue theirs. It also has checklist step types, which Baton does not, so the tick in the middle is not a step Baton would have. Kanbanify's cards have a completion action and an inline stage changer, no start. Neither settles it.

Options:

- **A. Both, Start first.** One tap to finish, two taps if the member wants the run in Mine. The pair reads as a choice, which it is. This is today minus the primary styling and with the order fixed.
- **B. Start only.** Two taps to finish, always. Every completion has a `startedAt`. Consistent within the page, inconsistent with the run list, and a member finishing a thirty-second task pays a tap for a timestamp nobody reads.
- **C. Done only.** One tap, no claim. Mine and Teammates tabs stop meaning anything for tasks done this way. Rejected; it removes a feature to fix a layout.
- **D. Done only on the page, Start only on the list.** The list is where a member picks work up, the page is where they finish it. Clean story, but a member who opens a page to read the instructions before starting has no Start button.

Chosen: A (decision 9). Two verbs side by side is acceptable once neither is primary, because the badge says Ready and the buttons are the two things a ready task can become. If it still reads as a choice that needs explaining, the fix is to test with a member, not to remove a tap.

### 4. Age and item card

Chosen: both removals (decisions 12 and 13).

- **`ordered 21m ago`.** Removed from this page. The run list shows age in its detail line, which is where triage happens.
- **Item card.** No border. The item, personalization and SKU sit as plain text under the heading. With the flag banner moved out and the badge row gone the card would hold two or three lines, and a border around two lines on a page whose other box is the task list makes two boxes compete.

## Proposed page, top to bottom

```
#2009                                        [Block]

[Blocked banner, when flagged: heading, reason, who · when, Edit · Unblock]

Leather journal ×1
Engraving  M.E.B.
SKU LJ-A5

Waiting on gold foil, ETA Thursday. — K          [Edit]
   (blank: "Note"                                [Edit])
From the order: Gift, please no invoice.

Step 1
┌──────────────────────────────────────────────┐
│ Cut leather                       Done       │
│ Leather · lead@m.com · Sep 23, 2:11 PM        │
└──────────────────────────────────────────────┘

Step 2
┌──────────────────────────────────────────────┐
│ Stamp monogram                    Ready      │
│ Engraving                                    │
│ Initials in the personalization; centre.     │
│ [Start] [Done]                               │
├──────────────────────────────────────────────┤
│ Stitch spine                      In progress│
│ Leather · lead@m.com · since 2:11 PM          │
│ [Done] [Put back]                            │
└──────────────────────────────────────────────┘

Step 3
┌──────────────────────────────────────────────┐
│ Condition and inspect                        │
│ Leather                                      │
└──────────────────────────────────────────────┘
```

Gone: the `Note` and `Steps` headings, the outer steps card, the item card's border, the workflow badge, the age, `waiting on step 2`, `Add note`, every primary button. Kept: `Step n` subheadings. Moved: the flag banner to page level. Changed: parallel tasks share one box.

## Questions to answer

None. Every question is closed; see Decisions.

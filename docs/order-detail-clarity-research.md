# Order detail clarity research

The merchant order page (`/app/orders/$orderId`, `src/routes/app.orders.$orderId.tsx`) shows six things that read as unlabeled fragments: "Placed", the tags line, the ambiguity sentence, the personalization rows, the run "now" line, and the Assign team picker on every Manage row. This doc takes each one, lists the options, and recommends. Questions for you are at the end of each section with the recommendation beside them.

Written 2026-09-23. Screenshot under discussion: an order with an ambiguous "Engraved cutting board" item (two workflows matched) and a "Leather journal" item on a three-step run with Manage open.

## 1. "Placed" in Order details

### Is it a Shopify word

Yes. Shopify uses "placed" for the order's `processedAt` moment throughout the admin and the docs: the order timeline entry is "Order was placed", the REST docs describe `processed_at` as when the order was placed, and the App Home component docs' own example is "Order #1234 placed on January 15, 2024" (`refs/shopify-docs/docs/api/app-home/latest/web-components/layout-and-structure/section.md`). The admin's order list column header is "Date" and the order header line is "#1001 · Sep 23 at 9:55 pm", so merchants see the date without a label there, but the verb they know for it is "placed". Our orders index already uses "Placed" as its column header (`app.orders.index.tsx`), so the detail page and the index agree.

The `Domain.ShopOrder.processedAt` JSDoc says the same: it is "the date shown under the order number in the admin".

### Options

1. **Keep "Placed"** (recommended). It is Shopify's word, it matches the index column, and the aside reads "Placed · Payment · Fulfillment" as three facts about the order in the admin's vocabulary.
2. **"Ordered"**. Plainer, but the item facts already say "ordered" in "× 2 to make (3 ordered)", where it means the line quantity. Two meanings on one page.
3. **"Date"**. What the admin list column says. Vague when Cancelled and Closed dates sit under it.

### Decision

Keep "Placed". No change.

## 2. The tags line on an ambiguous item

Today the facts line under the title prints `tags: a, b` only when the item has no live run (`facts` in `renderLineItem`): the tags are "why a workflow matched", and the comment says they are the answer on an item where nothing matched or two did. On the ambiguous item the same tags are then quoted again in the ambiguity sentence, so they appear twice within three lines.

### Options

1. **Drop the tags from the facts line entirely** (recommended). The workflow picker's options are the workflows, and each workflow's tag is visible on the workflow page. The one case where the tag mattered, "why did this match", is already answered by the picker showing only matching workflows. On an item with no run and no match, the tags explain why nothing matched, but that case is better served by a short sentence ("No workflow matches this item's tags") than by a tag dump the merchant has to compare against their workflow list by hand.
2. **Keep the tags only when nothing matched.** Narrower than today. Keeps the diagnostic for the no-match case and removes the duplication on the ambiguous case.
3. **Keep as is.** Duplication stays.

### Decision

Drop the tags line (option 1).

## 3. The ambiguity sentence

Today: "Two workflows match this item: Engraved cutting board (“engraved-cutting-board”) and Rush order (“rush”). Choose one to start." Then a `Workflow` label, a select whose placeholder is "Choose workflow", and a "Choose" button. The sentence spells a count, lists every name with its tag, and repeats "choose" three times across the block.

The spelled count exists because `SPELLED` was written to avoid "2 workflows", and the comment admits that past five it stops being scannable. You are right that a count that must agree with the list is a maintenance liability for no reader benefit.

### Options

1. **One short sentence, no count, no names** (recommended). "More than one workflow matches this item. Choose one to start." The select under it lists exactly the matching workflows, which is the list. The tags go away with section 2.
2. **No sentence, just a placeholder.** Select placeholder "Choose a workflow (2 match)" with no paragraph. Terse, but puts the count back and hides the fact that the merchant has to act.
3. **Keep the sentence, drop the tags.** "Two workflows match this item: Engraved cutting board and Rush order. Choose one to start." Still a count and a list that duplicates the select.
4. **Show the matches as a short list, not a sentence, and make the select the only control.** Same information as option 3 in a different shape; still duplicates the select.

Option 1 also lets the button be "Start" instead of "Choose": the sentence already says choose, the select placeholder says choose, and the action is starting a run. Today the label is "Choose" on an ambiguous item and "Start" on an item with no run (`actionLabel`), which is a distinction the merchant does not need.

### Decisions

- Sentence becomes "More than one workflow matches this item. Choose one to start." (option 1).
- Button label is "Start" on both the ambiguous and the no-run item.

### Open question: choosing a workflow that did not match

You asked whether the ambiguous picker needs to handle the merchant wanting an entirely different workflow, one that did not match this item's tags.

What exists: the ambiguous picker offers only the matched workflows (`options` in `renderLineItem`), the no-run picker offers every active workflow, and Change workflow inside Manage offers every active workflow except the incumbent. So the merchant can already get to any workflow in two steps: start one of the matches, open Manage, Change workflow. Nothing is started or done at that point, so the change asks no confirmation and loses nothing.

Options:

1. **Leave it as two steps** (recommended). The case is rare: the item's tags said two workflows apply and the merchant wants a third. Two clicks is a fine price for it, and the picker stays a list of the matches, which is what the sentence above it promises.
2. **Offer every active workflow, matched ones first.** One step, but the select then lists things the sentence did not mention, and the "which of these matched" signal needs a separator or a suffix ("Rush order · matched") that adds the words we are trying to remove. `s-select` has no option groups in the Polaris web components, so the separator would have to be a disabled option.

Your answer: the two-step path is not something a merchant would think of, and there is no Manage on an item without a run, so the dropdown should show every workflow. Agreed. Revised below in iteration 2.

## 4. Personalization rows ("Engraving · Rush — Dad's birthday", "Initials · T.W.")

These are the line item's `customAttributes`, the personalization the maker works from (`Domain.OrderAttribute`). They render as a bare two-column grid between the facts line and the workflow block with no heading, so "Engraving" and "Initials" sit in the same subdued grey as the facts above them and the merchant has to guess whether they are Baton's labels or the customer's.

The Order details aside does the same for order-level attributes but at least gives them a row label, "Order attributes".

### Options

1. **Label the block** (recommended). A small subdued heading, "Personalization", above the grid. Same treatment as "Order attributes" in the aside and "Note" on the run. One word tells the merchant these are the customer's inputs.
2. **Render them like Shopify's admin does.** The admin's line item card shows properties as `Key: value` lines directly under the variant title, no heading. That works there because the admin has no other text between the title and the properties. Here the facts line and the workflow block sit either side, so the rows need a name.
3. **Move them into a box with a border.** More visual weight than they deserve; they are data, not an action.
4. **Fold them into the facts line.** "× 1 · Engraving: Rush — Dad's birthday". Long values wrap badly and the maker wants to find the personalization at a glance.

### What Shopify calls them

Three names, by audience:

- **Line item properties** is the merchant-facing name. It is the term in the Help Center, in theme customization guides ("add line item properties to your cart form"), and in the Flow manual (`refs/flow-manual/reference/triggers/order-created.md` lists "line item properties" among the order fields).
- **Custom attributes** is the API name (`LineItem.customAttributes` in Admin GraphQL, `properties` in REST). Merchants never see this phrase.
- **No label at all** is what the admin order page does: the properties print as `Key: Value` lines under the variant title inside the line item row.

"Personalization" and "Customizations" are not Shopify terms for this. "Customizations" in Shopify docs means checkout and market customization.

### Question

Q5. Heading text. Options, in order of recommendation:

1. **"Properties"**. The Shopify word with "line item" dropped, since the heading already sits inside the line item's card. Short, matches what a merchant who has set this up in their theme calls it.
2. **"Line item properties"**. Exact Shopify term. Three words for a heading over two rows.
3. **"Personalization"**. What the maker means by it, but not what Shopify or the merchant's theme calls it, so it is a word we made up for this page.

### Decision

"Properties".

## 5. The run header inside the item card

Under the Leather journal item:

```
Leather journal  [Not started]
Step 1 of 3 · Cut leather · Leather
```

Then, with Manage open:

```
Cut leather  Leather · step 1
Ready
Mark done
Assign team ▾  Assign
Step 2 · Stamp monogram · Engraving · Waiting on step 1
Assign team ▾  Assign
...
```

Three problems.

### 5a. "Leather journal" twice

The first is the item title (`s-heading`). The second is `run.workflowName` in `renderRun`. They coincide because the seed workflow is named after the product, which is what a shop with one workflow per product does, so the coincidence is the common case, not an accident of the seed.

The code comment defends keeping the workflow name because "its section is headed by the line item, not the workflow". True, but when they match it prints one string twice, and when they differ the second string has no label to say it is a workflow.

Options:

1. **Label it** (recommended). Print `Workflow · Leather journal` or a subdued "Workflow" lead in the same label-value shape as the facts and personalization rows, so the line says what it is even when it equals the item title. The status badge stays beside it.
2. **Suppress the name when it equals the item title.** Hides the redundancy but leaves the "what is this" problem for every other shop, and the badge then floats alone.
3. **Drop the workflow name from the card and show it only in Manage.** The merchant loses the one line that says which workflow is running when an item could have matched several.

### 5b. "Step 1 of 3 · Cut leather · Leather"

This is `nowLine`: position, ready task names, ready teams, and "since" time, all joined by middle dots. It replaced an earlier notation that the JSDoc describes as needing to be learned, and it is better than that, but it still asks the reader to know that the second fragment is a task and the third is a team. "Leather" as a team name next to "Cut leather" as a task name makes the worst case obvious.

Options:

1. **Say what each fragment is** (recommended). One sentence: "Step 1 of 3, Cut leather, ready for Leather team." Or with a start: "Step 1 of 3, Cut leather, Leather team since 14:31." The word "team" after the team name is the fix. It costs four characters and removes the guess. For a parallel step: "Step 2 of 3, Stamp monogram and Stitch spine, ready for Engraving and Leather teams."
2. **Label-value rows.** "Step · 1 of 3", "Task · Cut leather", "Team · Leather". Three rows where one line did the job; too tall for a card that is meant to be glanced at, and worse on a parallel step.
3. **Drop the team from the line and leave it to Manage.** Shorter, but the team is the answer to "who is this waiting on", which is the merchant's most common question when looking at the card.

Whichever shape wins here should also be the shape of the Manage row's one-line form (`Step 2 · Stamp monogram · Engraving · Waiting on step 1`), which has the same problem: four fragments, no labels. Recommended: "Step 2 · Stamp monogram · Engraving team · Waiting on step 1". And in the ready task's box, "Leather · step 1" becomes "Leather team · step 1".

The member run page (`shop.$shop.workflows.$runId.tsx`) prints the team name alone after the state badge too. Whatever is decided here should apply there, so the merchant and the worker see the same line.

### 5c. Manage rows: "Assign team" on every task

This is the abomination. `manageRows` renders `assignTeam(task.id)` on every open task, ready or not, because the comment says "any open task can be reassigned" from Manage. So a three-step run with every task already assigned shows four empty "Assign team" selects with four disabled "Assign" buttons, each one looking like an unanswered form field. Nothing says the task already has a team except the team name buried in the fragment line above it.

The attention row on the card (`attentionRows`) already covers the case that matters: a task whose team was deleted shows "Stamp monogram: assign a team." with a picker, outside Manage, as the one thing that must be acted on. So the pickers inside Manage only serve the rare deliberate reassignment of an already-assigned task.

Options:

1. **Replace the picker with a "Reassign" tertiary button that reveals the picker** (recommended). Each open task row shows its team as text. A small tertiary "Reassign" beside it opens the select and an "Assign" button inline for that one task. The row's resting state is a fact, not a form. This matches how Manage already treats Change workflow: a button, then the picker on demand.
2. **Show the select pre-filled with the current team, no separate Assign button, save on change.** Fewer clicks, and the select doubles as the team label. But four selects still look like four decisions, and save-on-change is a write the merchant can trigger by scrolling on a trackpad over a select.
3. **Move reassignment into a single "Reassign teams" action at run level that opens a modal with one row per open task.** Cleanest card, and one modal for the rare case. More code, and a modal for a one-field change on one task is heavy.
4. **Remove reassignment from Manage entirely; keep only the deleted-team attention row.** Simplest. But a merchant who set up the wrong team on a workflow and has runs in flight has no way to fix a run without cancelling and restarting it.

Option 1 also lets the ready task's box lose a row: today it is name, state, Mark done, then a full-width select and button. It becomes name, state, and a button row: "Mark done · Reassign".

### Decisions

- Manage row reassignment: a tertiary "Reassign" that reveals the picker (5c option 1).
- Reassignment survives; the deleted-team attention row alone is not enough.

### Open: 5a and 5b, without adding words

You are on the fence about "Workflow · Leather journal" and "Leather team" because both fix ambiguity by adding words, and the page is already wordy. Fair. The alternative to labelling a fragment is to cut it or to give it a position that says what it is. Taking each:

**5a, the workflow name.** Cut it from the card. The run line becomes the status badge and the now line, with the workflow name shown in two places that already exist: the Manage drawer's header (it has none today; "Leather journal workflow" as the drawer's first line costs nothing there because the drawer is where the merchant goes to read detail) and the Change workflow picker, which lists the alternatives and can show the incumbent as the disabled first option. The card loses one line and the duplicate goes with it. The cost is the one I flagged before, an item that matched several workflows no longer says which one is running at a glance, but the badge next to the item title still says a run exists, and one click on Manage says which. On a shop whose workflow names match product titles, which is the common shop, the card says nothing twice.

**5b, the team on the now line.** Cut it. "Step 1 of 3 · Cut leather · since 14:31" is the position; the team is in Manage. That is section 5b's option 3, which I argued against because "who is this waiting on" is the merchant's question. But the honest answer is that a merchant asking that question opens Manage anyway, because the answer they want is not the team name but whether anyone on it has started, and that is what the Manage row shows. The now line is a glance, and a glance does not need the team.

**Manage rows, and the unbounded-name problem.** This is where your Q10 comment lands and it changes the shape of the answer. Task names, team names, and workflow names are merchant text with no useful cap, so a one-line row of middle-dot fragments is not a layout, it is a hope. The fix for both "what is this fragment" and "what happens when it is long" is the same: a table. Columns are labelled once in the header, so no row needs the word "team", and a long name wraps inside its cell instead of pushing the state off the line.

```
Manage
Leather journal workflow

Step  Task                   Team       Status
1     Cut leather            Leather    Ready                 Mark done · Reassign
2     Stamp monogram         Engraving  Waiting on step 1     Reassign
2     Stitch spine           Leather    Waiting on step 1     Reassign
3     Condition and inspect  Leather    Waiting on step 2     Reassign
─────
Block · Cancel run · Change workflow · Add note
```

`s-table` is already in use on the orders index, so this is a known component, and it collapses to a list on narrow widths on its own (`listSlot`). The ready row keeps its emphasis through the Status cell and the action buttons rather than through a white box on grey. Done rows show "Done by … · 14:31" in Status and "Reopen" in the actions. The "Can't reopen" sentence goes in Status too, where it wraps. The Reassign picker opens as a row under the task row, the way Change workflow's picker already opens under its button.

This also settles what the member run page should look like: the same four columns, with the member's own buttons in the last one. One table shape, two pages, and the words "step", "task", "team" and "status" appear once per page, in the header, instead of once per row.

### Decisions

- Cut the workflow name from the card; it becomes the Manage drawer's header line.
- Cut the team from the now line.

### Table: withdrawn

You are on the fence about the table as too heavy, and you like the member run page's step cards. Withdrawn. Iteration 2 below reuses the member page's shape instead.

## 6. Manage as a whole

Stepping back from the rows: Manage opens a grey drawer with every task and every run-level action. The card above it is meant to be a glance and Manage the place to act. That split is right. What makes Manage feel urgent is that its resting state is full of controls: pickers on every row, "Mark done" on the ready one, and a four-button run action row of which two are red.

You said this is a conundrum we keep iterating on without a good answer, and that one-line rows cannot survive unbounded names. Agreed on both. The reason the iterations have not converged is that every version has tried to make a sentence out of four fields, and a sentence has no place for a long value to go. The table in section 5 is the first shape where the words are fixed and only the values vary. That is what makes it worth trying before another round of copy.

Q10 as originally asked (Reassign on waiting tasks or only the ready one) is answered in iteration 2: it is a tertiary button in the task's button row, on every open task.

## 7. Iteration 2

Two of your comments set the frame for this pass.

**We keep assuming the numbers are reasonable.** Today they are enforced caps in `Domain.WorkflowLimits` and `Domain.NAME_MAX_LENGTH`, but the caps are provisional: the `WorkflowLimits` JSDoc says "raise freely", and they will probably go up. So the layout has to be sound at these numbers and not depend on them staying put; nothing below assumes a count small enough to fit on a screen.

| Thing                              | Cap           |
| ---------------------------------- | ------------- |
| Workflows per shop                 | 50            |
| Tasks per workflow                 | 20            |
| Name length (workflow, task, team) | 64 characters |

At today's caps the layout has to survive a 50-option workflow select, a 20-task run, and 64-character names in every slot. Those are the numbers to seed and look at, and the shape has to be one that degrades to a longer scroll, not a broken line, when they rise. A native `s-select` with 50 options is fine; it is a scrolling list. A 20-task run inside Manage is long, but it is inside Manage, and the member page already shows the same 20 tasks with no disclosure at all. A 64-character task name on one line beside a 64-character team name is the case the one-line rows fail on, and it is why the fragments have to become stacked lines.

**The member page's step cards are the shape you like.** Its layout (`docs/member-run-page-plan.md`, "Target render") is: a subdued `Step n` caption, one bordered box per step, parallel tasks separated by rules inside the box. In each task: the name and a state badge on one line, then the team on its own subdued line, then who and when, then the buttons. The team is never labelled "team" because its position, the second line under a task name, says what it is. A waiting task has no badge and no prose; the caption above it says what it waits on. That layout has already been through its own research round and has answers to the things this page is still arguing about: the badge carries the state so no sentence has to, and every value has its own line so a 64-character name wraps without colliding with anything.

### 7a. The ambiguous item: every workflow in the select

An item without a run has one control, the workflow select and its Start button. There is no Manage. So the select has to be the whole answer.

Proposed:

```
Engraved cutting board
× 1

Properties
Engraving   Rush — Dad's birthday

More than one workflow matches this item, so none was started.
Workflow  [ Choose workflow            ▾ ]  [Start]
            Engraved cutting board
            Rush order
            ────────────
            Leather journal
            ...
```

- The sentence says why the merchant is being asked. It does not count or name anything, so it cannot drift from the list.
- The select lists every active workflow, matched ones first, then the rest in name order. The separator is a disabled `s-option` with an em-dash label, since the Polaris `s-select` has no option groups; if that looks wrong in the browser, drop the separator and keep the ordering alone. Matched-first ordering is enough to make the usual pick the first thing under the cursor, and the merchant who wants a different workflow scrolls.
- The no-run item (nothing matched) keeps the same control with no sentence, as today.
- "Choose workflow" as the placeholder and "Start" as the button, on both. The word "choose" appears once.

### 7b. The card at rest

Per line item, with Manage closed:

```
Leather journal                                          [ Manage ˅ ]
× 1 · SKU LJ-A5

Properties
Initials   T.W.

[Not started]  Step 1 of 3 · Cut leather
```

The run line is the status badge and the now line. No workflow name (it is inside Manage), no team (inside Manage), no tags. The attention row (a task whose team was deleted, or a ready task on an empty team) stays on the card under the run line, as today, because it is the one thing the merchant must act on. The blocked strip stays on the card for the same reason. A cancelled run is its badge and Undo cancel, as today.

### 7c. Manage: the member page's steps, with the merchant's buttons

Manage opens the same step cards the member sees, inside the subdued drawer, with a header line naming the workflow:

```
Leather journal workflow

Step 1
┌────────────────────────────────────────────┐
│ Cut leather                        Ready   │
│ Leather                                    │
│ [Mark done] [Reassign]                     │
└────────────────────────────────────────────┘

Step 2
┌────────────────────────────────────────────┐
│ Stamp monogram                             │
│ Engraving                          Reassign│
├────────────────────────────────────────────┤
│ Stitch spine                               │
│ Leather                            Reassign│
└────────────────────────────────────────────┘

Step 3
┌────────────────────────────────────────────┐
│ Condition and inspect                      │
│ Leather                            Reassign│
└────────────────────────────────────────────┘
─────
[Block] [Cancel run] [Change workflow] [Add note]
```

What changes from today's Manage:

- **One shape for every task.** Today a ready or done task gets a bordered box and a waiting task gets a one-line fragment string; the two shapes are why the drawer reads as noise. Every task now has the same three lines: name and badge, team, then whatever applies (who and when, reopened by, buttons). A waiting task is two lines and a tertiary Reassign.
- **The badge says the state.** "Ready", "In progress", "Done". No "Waiting on step 1" prose, because the `Step 2` caption above the task says it. This is the member page's rule (`taskState` there) and the merchant reads the same thing the worker reads.
- **The team is a line, not a fragment.** "Cut leather · Leather" becomes "Cut leather" over "Leather". No word "team" needed; nothing else ever sits on that line.
- **Reassign is a tertiary button.** On every open task, in the button row when there is one, alone at the end of the team line when there is not. Clicking it swaps that task's team line for the picker and an Assign button; Assign or a Cancel puts the line back. One picker open at a time is not enforced; there is no reason to.
- **Done tasks** show "Done" badge, then "Leather · Merchant · 14:31", then Reopen or the "Can't reopen" sentence as today. The sentence wraps on its own line, so a long blocker name has room.
- **Run actions** unchanged: one row under a rule.

The code shape: the member page's `renderTask` and the step loop under it move to a shared component (`src/components/RunSteps.tsx` or beside `MemberRun.tsx`), taking the task list and a render-buttons callback. The member page passes Start, Done, Put back, Undo; the order page passes Mark done, Put back, Reopen, Reassign. The JSDoc rules on `taskState` and on the step loop move with them and become the one statement both pages link. The order page's `manageStateLine` and its one-line waiting form are deleted.

### 7d. Does it scale

The three caps, against this layout:

- **20 tasks**: twenty three-line boxes inside the drawer, about the height of two screens. Acceptable because it is behind Manage and the merchant opened it to see exactly this. The member page shows the same twenty without a disclosure and that was accepted in its own research. If it turns out too long in practice, the fix is the same on both pages (collapse done steps to their caption), and it is a later change, not this one.
- **64-character names**: every name has its own line, so it wraps within the card. The now line on the card at rest is the only place two names share a line ("Step 1 of 3 · Cut leather"), and a parallel step joins task names with commas there; at two 64-character names it wraps to a second line, which is fine for a subdued line under a badge.
- **50 workflows**: one select. Not a layout problem.
- **Several line items, each with a run**: each item is its own card with its own Manage, so the page is N cards of three or four lines at rest. Twenty items is twenty cards, which is what the Shopify admin's own order page does with twenty line items.

The verification step, per the visual-work rule: seed a shop with a 20-task workflow and 64-character task and team names, open an order with three items on it, and look at the card at rest and with Manage open before calling it done.

### Decisions (2026-09-24)

- 7a: every active workflow in the ambiguous select, matched first; sentence "More than one workflow matches this item, so none was started."
- 7c: Manage reuses the member page's step cards through a shared component, with the merchant's buttons swapped in.
- 7c: Reassign is a tertiary button on every open task.
- 7d: accept the 20-task drawer length for now; seed the worst case and look. Collapsing done steps is a later change for both pages together.

All four accepted on the understanding that the layout is evaluated working, not on paper. The plan is in `docs/order-detail-clarity-plan.md`.

## Summary

| #   | Status  | Change                                                                                                                          | Where                                                 |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | decided | Keep "Placed"                                                                                                                   | aside                                                 |
| 2   | decided | Drop the `tags:` line from item facts                                                                                           | `facts` in `renderLineItem`                           |
| 3   | decided | Ambiguity sentence becomes "More than one workflow matches this item. Choose one to start."; button label "Start" in both cases | `ambiguitySentence`, `actionLabel`, `SPELLED` deleted |
| 3b  | decided | Ambiguous select lists every active workflow, matched first; sentence adds "so none was started"                                | `options`, `ambiguitySentence`                        |
| 4   | decided | "Properties" heading over the custom attribute grid                                                                             | `renderLineItem`                                      |
| 5a  | decided | Cut the workflow name from the card; show it as the Manage drawer header                                                        | `renderRun`, `manageRows`                             |
| 5b  | decided | Cut the team from the now line                                                                                                  | `nowLine`                                             |
| 5c  | decided | Reassign is a tertiary button that reveals the picker; reassignment stays                                                       | `manageRows`, `assignTeam`                            |
| 7c  | decided | Manage reuses the member page's step cards via a shared component                                                               | new `RunSteps` component, both run pages              |

None of these touch the Domain, the object, or the schema. The e2e specs that address "Choose", "Assign team" placeholders, or the ambiguity sentence text will need their selectors updated; I have not audited which ones.

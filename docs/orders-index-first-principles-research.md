# The orders index, from first principles

Why the filter bar on the orders index keeps coming out wrong, what the page is for, what the current model gets right and where the presentation betrays it, and the questions to decide. Written 2026-09-28 from `src/routes/app.orders.index.tsx`, `Domain.ts` (`ProductionState`, `OrdersStatus`, `OrderNeed`, `orderNeeds`, `productionState`, `OrderRow`), `OrderRepository.listOrders`, the plan that built the two rows (commit 603884f, 2026-09-23) and the closed-runs work (2026-09-25), plus the screenshot of the page as it stands.

## 1. What the page is for

Baton watches orders so the merchant can see production. An order's items match workflows by tag; when the order is paid, runs start; teams work the tasks; when every run is done the merchant fulfils in Shopify and the order leaves. The orders index is the merchant's view of that pipeline. It answers, in order of how often a merchant asks:

1. **What needs me?** Something is stuck and only the merchant can unstick it: an item matched no workflow, an item matched two, a task has no team or an empty team, a person blocked a run.
2. **What is on the bench?** Who has what, so the merchant can answer a customer or move people.
3. **What can I fulfil?** Everything made, waiting for the packer.
4. **Where is order #1234?** A customer is on the phone.
5. **What happened to an order that is gone?** Rare. Fulfilled and cancelled orders are history.

Everything on the bar should map to one of those five. The current bar was built axis by axis (a position axis, a problem axis, a team axis) rather than question by question, and that is the root of the trouble.

## 2. The model underneath is right

The domain already separates two things that are independent, and the separation is correct:

- **Position** (`ProductionState`): one per order, a ladder. To make · Making · Made are Baton's rungs; Fulfilled · Cancelled are Shopify's facts. Derived on every read from the order row and its run counts, never stored.
- **Problem** (`OrderNeed`): zero or more per order, each with a remedy the merchant owns. No workflow, Choose a workflow, Needs a team, Blocked. Only on open orders.

A problem is not a position: an order being made can also be waiting on a choice for another item. That is why they cannot be one row of buttons, and the 2026-09-23 split was right to pull them apart. Nothing in this document proposes changing `productionState` or `orderNeeds`, and the SQL that restates them stays.

What went wrong is what the page made of that split.

## 3. What the page gets wrong

### 3a. The row called Status is not a status row

"Status" promises one axis with one value per order. The row holds three kinds of thing:

| button                | kind                     |
| --------------------- | ------------------------ |
| Open                  | a scope (three rungs)    |
| To make, Making, Made | positions                |
| Fulfilled             | a position               |
| All                   | a scope (every position) |

Open beside To make reads as a sibling and is a parent. All beside Fulfilled reads as a sibling and is the union. That is why "Open" begs for "Closed": if the row were an axis, an axis with Open must have its complement. It is not an axis. It is a row of views, each a whole question, the way the Shopify admin's Orders page tabs are (All · Unfulfilled · Unpaid · Open · Archived: scopes and statuses side by side, and nobody minds, because the row has no label saying "Status"). The word "Status" on the left of the row is what makes it wrong.

### 3b. The column called Production is not the row called Status

The row is labelled Status; the column its buttons filter is labelled Production, and that column holds both the position badge and the problem badges. A merchant pressing "Making" looks for a Making column and finds Production. A merchant pressing "Needs a team" looks for a Needs column and finds the same one. The header should say what the badge is, and the two kinds of badge should not share a cell if each has its own filter.

### 3c. Two crossed rows produce a table of mostly empty cells

Both rows are always on screen and the counts on each honour the other, so pressing a status button changes the numbers on the needs row and pressing a need changes the numbers on the status row. The rule ("a count is what pressing that button would show") is principled, but with these two axes most of the cross product is structurally zero:

| need \ status     | To make  | Making                     | Made                    |
| ----------------- | -------- | -------------------------- | ----------------------- |
| No workflow       | possible | never (no run of any kind) | never                   |
| Choose a workflow | possible | possible (another item)    | possible (another item) |
| Needs a team      | never    | possible                   | never                   |
| Blocked           | never    | possible                   | never                   |

Six of twelve cells can never be anything but zero. A merchant who presses Made and sees `Blocked · 0` learns nothing, and one who presses Blocked and sees `To make · 0` learns nothing. That is the "behaves weirdly": the bar keeps offering combinations the model forbids, with counts that dutifully say zero.

### 3d. Fulfilled makes controls vanish and filters reset

Pressing Fulfilled hides the Needs row and the Team select and silently drops the need and team from the URL, because no fulfilled order can carry either. That is the right consequence of the wrong structure: a control that must disappear when a sibling is pressed is not a sibling.

### 3e. "Needs" is the wrong noun and "Anything" is the wrong default

"Needs" as a row label is a verb made a noun and reads as a question ("needs what?"). "Anything" as its resting value reads as a filter ("orders that need anything") when it means no filter. And Blocked is not a need in the sense of the other three: the other three are gaps the merchant fills (attach, choose, assign); Blocked is a hold a person set on purpose, and its remedy is to go read why. It shares the row because it shares the count query, not because it is the same kind of thing.

### 3f. Search crosses the view

Search is question 4 (find one order) and the view row is questions 1 to 3, 5. Crossing them means typing #1575 under Made finds nothing, and the merchant has to press All and type again. The number the merchant typed is the whole question.

### 3g. The vocabulary is off the glossary

The glossary in `Domain.ts` has tables for run states, task states, workflow states and verbs, each with a checked screen column. It has no table for order states. "To make", "Making", "Made", "Fulfilled", "Cancelled", "No workflow", "Choose a workflow", "Needs a team", "Waiting on" and "Open" are all screen words with no glossary row, and their labels live in the route (`STATUSES`, `NEED_LABEL`, `positionBadge`), not in a checked constant. "Status" and "need" are not glossary words either; `OrdersStatus` and `OrderNeed` are symbols named after page furniture. "Blocked" is a run-state word in the glossary and an order-need word on this page; that reuse is deliberate and fine (the need is "a run on this order is blocked"), but nothing says so.

"To make / Making / Made" is ours, chosen on 2026-09-25 over Shipped and Ready to ship. Making and Made stay. The first rung becomes Not started (section 9, Q11): "To make" promises making on orders where nothing will be made.

## 4. Proposal

One row of views, one column per badge kind, the glossary made complete.

### 4a. One row of views, no label

```
[ Order number            ]

[Open · 35] [Issues · 5] [Not started · 5] [Making · 30] [Made · 0] [Fulfilled] [All]

Team  [Any team           ⌃]
```

Each button is a whole question. They are exclusive, so nothing crosses, nothing hides, and no count is structurally zero:

| view        | question                  | predicate                       | count |
| ----------- | ------------------------- | ------------------------------- | ----- |
| Open        | what is on my bench       | `orderIsOpen`                   | yes   |
| Issues      | what needs me             | `orderIssues(row).length > 0`   | yes   |
| Not started | what has not started      | `productionState = not_started` | yes   |
| Making      | who has what              | `productionState = making`      | yes   |
| Made        | what can I fulfil         | `productionState = made`        | yes   |
| Fulfilled   | history                   | `productionState = fulfilled`   | no    |
| All         | everything, cancelled too | none                            | no    |

Open is the default and the first button. Issues is second because it is the merchant's first question and the reason the badges are red. The ladder follows in order. Fulfilled and All stay uncounted for the reason already on `OrderCounts` (the open partial index).

Counts honour the team select and nothing else (see 4d on search). A count is still "what pressing this shows", but with one row the rule has nothing to cross with and the numbers only move when the team changes, which is what a merchant expects a team select to do.

The specific issue is not a filter. Under Issues the rows carry their issue badges, and five or ten orders with red badges are scannable; a shop that needs a per-need filter has a bigger problem than a filter. If that ever proves wrong, a select ("Any problem · No workflow · ...") shown only under Issues is the addition, never a second row of buttons.

Blocked stays inside Issues. Its count and its predicate are already there; what changes is that it is no longer a button beside three gaps it does not resemble.

### 4b. Two badge columns, headed by their words

```
Order   Placed           Payment   Status    Issues             Waiting on   Items  Shopify
#9605   Sep 28, 1:13 AM  Paid      Making                       Bench        2      View in Shopify
#1575   Sep 22, 3:26 AM  Paid      Not started  No workflow                     1      View in Shopify
#1561   Sep 4, 8:57 PM   Paid      Making    Needs a team                    3      View in Shopify
```

**Status** holds the one position badge. The word is right for a column because there is exactly one value per row; it was wrong for the button row because the row was not an axis. **Issues** holds the issue badges, empty when there are none, and its emptiness is the point: a merchant scanning down it sees the red at once. Two columns, two words, each the word of the view that filters it.

The Payment column stays as is. Unpaid is why an order sits at To make with no badge, and it is a Shopify fact, not a Baton problem, so it does not belong in Issues. (Question 4.)

### 4c. Glossary rows for order states and problems

Two new tables in the glossary, with label constants checked by `pnpm spec check` like the four existing ones:

Order positions (`ProductionState`, one per order, {@link productionState}):

| word        | meaning                           | screen      |
| ----------- | --------------------------------- | ----------- |
| open        | not fulfilled, not cancelled      | Open        |
| not started | open, no open run and no done run | Not started |
| making      | open, an open run                 | Making      |
| made        | open, done runs and no open run   | Made        |
| fulfilled   | Shopify says `FULFILLED`          | Fulfilled   |
| cancelled   | Shopify says `cancelledAt`        | Cancelled   |

Order issues (`OrderIssue`, zero or more per open order, {@link orderIssues}; the word is section 8):

| word            | meaning                                                | screen            |
| --------------- | ------------------------------------------------------ | ----------------- |
| no workflow     | paid, no run on any item, no item choosing             | No workflow       |
| choose workflow | an item matched two or more workflows                  | Choose a workflow |
| needs a team    | an open task unassigned, or on a deleted or empty team | Needs a team      |
| blocked         | a run on the order is blocked (the run-state word)     | Blocked           |

`PRODUCTION_STATE_LABEL` and `ORDER_ISSUE_LABEL` move out of the route into `Domain.ts` beside the other label constants, and the route reads them. The Screens table already names this page "the orders index".

### 4d. Search ignores the view

An order number typed into the field searches every stored order, and the view buttons show unpressed while a search is on (or stay pressed and are ignored; question 5). Clearing the field returns to the view. The team select is also ignored under a search: the merchant with a number in hand wants the order, not the order if it is on that team.

### 4e. What goes away

The `Needs` row, `NEEDS`, `NEED_LABEL` in the route, `openOnlyFiltersShown`, the drop-need-and-team-on-Fulfilled logic, the `Anything` button, `OrdersStatus`'s reason for existing as a separate union (`null` is Open and `"all"` is All; the new view literal replaces it), the `need` URL parameter (replaced by the view), the cross-count SQL (one count per view, narrowed by team only), the empty-state copy for need filters (one line for Issues: "No open orders have issues."), and the `Blocked · 0` under Made.

## 5. Trade-offs

- **One row loses the per-issue filter.** A merchant cannot ask "just the ones with no workflow". The badge answers it by eye at bench scale; a select can be added under Issues if it is missed. What is gained: no crossing, no hiding, no structural zeros, and one fewer noun to explain.
- **Seven buttons.** Six today plus Issues. Fits at the large page width the screenshot shows. If it must shrink, Not started is the one to cut (4a keeps it because the ladder's first rung was added deliberately on 2026-09-25 so the merchant sees the rung and its count; under this proposal its count is stable and meaningful). See question 3.
- **Search ignoring the view is a behaviour change.** Today a URL with `q` and `status` means both. After 4d a URL with `q` shows the search. Team drill-in links carry no `q`, so nothing that exists today breaks.
- **"Closed" is not available as a screen word.** Shopify's admin uses Closed for an archived order, a different fact, so a Closed button beside Open would mean one thing here and another one tab over in the admin. That is why 4a keeps Fulfilled and All rather than Open and Closed. The domain word `closed` for a run stays; it never renders beside an order's Shopify status.
- **`OrderRow.attention` is misnamed either way.** The boolean is the team gap only; section 8 renames it `unstaffed`.

## 6. Decisions (2026-09-28)

Q1 to Q6 of the first round were accepted as recommended:

- **One row of views** (4a). The Needs row goes.
- **The concept word is issue** (third round). Section 8 has the refactor.
- **The first rung stays** as a view; it is named Not started (Q11).
- **Unpaid stays in the Payment column**, not among the issues.
- **Under a search the view buttons are unpressed**; pressing one clears the field.
- **Open carries a count.**

Second round: a Shopify-cancelled order is history under All, no button (decided). The concept word is **issue** (accepted third round). Cancel workflow stays as it is, modal and label (decided). Section 9 compares the cancelled run with the order that matches nothing, withdraws Q8, closes Q9 and Q10. **Q11 accepted (fourth round): the first rung is Not started.** Fifth round: the plan had called the seven buttons "tabs" without a decision; section 10 is the naming study. **Q12 accepted (fifth round): the word is view, on both screens, with the member-side rename.** **Q13 accepted: the read structs take the `Data` suffix, named by screen (10f).** Every question is decided.

## 7. The first-round questions, as asked

Kept for the record; the answers are in section 6.

**Q1. One row of views, or keep two rows and repair them?** Two repaired rows would be: a Status row that is positions only (To make · Making · Made · Fulfilled · Cancelled, multi-select or with Open as an implicit default) and a Needs row with the cross-counts kept. It keeps the per-need filter and keeps every fault in 3c and 3d. **Recommend one row (4a).** The page has been repaired three times as two rows and comes back wrong each time; the crossing is the fault, not the copy.

**Q2. The concept word for the problems.** (Superseded by section 8.) Candidates: _need_ (current; reads as a verb, "Needs" row, "Anything"), _attention_ ("Needs attention" view, "Attention" column; Shopify's own phrase for a product or channel with a problem, so the merchant has seen it), _issue_ (software word, and a blocked run is not an issue), _problem_ (blunt, and Choose a workflow is a decision not a problem), _to-do_ (right meaning, wrong register for a column header). **Recommend attention**: "Needs attention" for the view, "Attention" for the column, `OrderAttention` for the literal, `orderAttention` for the derivation, and rename `OrderRow.attention` to `unstaffed`. If "attention" feels borrowed, _need_ is the fallback with the row label "Needs attention" and no "Anything" button, which removes most of what reads badly.

**Q3. Keep To make as a view?** A To make order is unpaid, or has no workflow, or is choosing, or has every run closed. The middle two are Needs attention; the others are rare. **Recommend keep it.** It is the first rung of the ladder the badges draw, and a ladder with a missing first button reads as broken. Cut it only if the row is too wide at the narrow admin width.

**Q4. Should Unpaid become an Attention badge?** It is the commonest reason a paid-looking shop has To make orders with no red badge. **Recommend no.** Payment is a Shopify fact the merchant does nothing about in Baton, and the Payment column already says it. Attention holds only what the merchant fixes here.

**Q5. Under a search, are the view buttons unpressed or pressed-and-ignored?** **Recommend unpressed**, with the field showing the number: the bar then reads "you are looking at a search", and pressing any view clears the field and shows that view. Pressed-and-ignored is a lie the merchant has to learn.

**Q6. Counts on Open?** Open is the default and pressed on arrival. A count there is the shop's open-order total, which is the number the home page could also carry. **Recommend yes**, since every other open view carries one and the bare label reads as a number that failed to load, the reasoning already on `pressButton`.

**Q7. Where does Cancelled show?** (Reopened; see section 9.) No button today, by design (rare, a badge, not a rung). **Recommend unchanged**: under All with its critical badge, and the empty-text branch for `cancelled` goes with the `OrdersStatus` union.

## 8. Naming the problems

Second pass, after the annotation on the first: the thing to name is the problem, not the attention it deserves. "Order attention" names kinds of attention, which is not a thing. Shopify's own badge guidance already has the words: `critical` is for "urgent issues needing action", `warning` for "problems requiring attention". Issues and problems are the nouns; attention is what a badge does about them.

The first pass also called Choose a workflow "a pending choice, not an issue". That was wrong. Until one of the two workflows is chosen nothing runs and the product is not made. All four are the same kind of thing: **the order is not moving, and only the merchant can move it.**

| word    | view button  | column   | code                            | reads                                                                                                                     |
| ------- | ------------ | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| issue   | Issues · 5   | Issues   | `OrderIssue`, `orderIssues`     | Shopify's word for the critical tone; "Issues · 5" is a count of things; the column header is a plural noun like Items    |
| problem | Problems · 5 | Problems | `OrderProblem`, `orderProblems` | Shopify's word for the warning tone; plainer; as a column header reads as a verdict on the order rather than a list on it |

**Recommendation: issue.** Both are Shopify's words and both are right; issue wins on the column header and the button, where a plural noun that names a list reads better than one that names a fault. The refactor:

| today                                        | after                              | note                                                       |
| -------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `OrderNeed`                                  | `OrderIssue`                       | the literal; same four values                              |
| `orderNeeds(row)`                            | `orderIssues(row)`                 | returns the list, in literal order                         |
| `OrderRow.attention`                         | `OrderRow.unstaffed`               | the team gap alone; the badge stays "Needs a team"         |
| `OrderCounts` need keys                      | one `issues` count                 | one row of views, so the per-need counts go                |
| `ListOrdersInput.need`                       | gone                               | replaced by the view                                       |
| `NEED_LABEL` in the route                    | `ORDER_ISSUE_LABEL` in `Domain.ts` | the glossary's screen column, checked by `pnpm spec check` |
| `needBadges`, `NEEDS`                        | `issueBadges`; no row              |                                                            |
| SQL `NO_WORKFLOW`, `CHOOSING`, `BLOCKED_RUN` | unchanged                          | they name the case, not the concept                        |
| glossary                                     | an "Order issues" table            | the four words, their rule, their badge                    |

The view is **Issues** and the column is **Issues**. The four badge labels stay: No workflow · Choose a workflow · Needs a team · Blocked. Section 7 keeps the first-round wording ("Needs attention", "Attention") as the record of what was asked; section 4 is updated.

## 9. Cancel workflow, from first principles

Two cancels exist and only one needs thought.

**A Shopify order cancel is final.** The Admin API says cancellation is irreversible. Baton closes the runs and the order reads Cancelled for good. It is history, it sits under All, and a search by number finds it. No button. Decided.

**The merchant's Cancel workflow.** What it does today: closes the item's run (reason `merchant_cancelled`), work stops, steps already done stay on the run as the record, the item keeps its slot so reconcile starts nothing new on it, and the picker offers a fresh run. The modal says: "Work on it stops. Steps already done stay on record. You can attach another workflow to the item afterwards."

Why would a merchant press it?

| the merchant wants                                                                                                       | the verb                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| a different workflow on the item                                                                                         | **Change workflow**, which replaces the run in one step               |
| Baton to stop making this item: ship it from stock, it was made elsewhere, the customer will be refunded, it is a sample | **Cancel workflow**: take the item off the bench, nothing replaces it |
| nothing, it was a slip                                                                                                   | the modal asks first                                                  |

So Cancel workflow has one intent: **this item is not being made in Baton.** Everything else follows from that.

**What deleting the verb would remove.** Without it, "not making this in Baton" has no expression. The run stays open on the bench until Shopify fulfils the order, and every team with a task on it sees a job nobody should do. Removing the item in Shopify does not cover ship-from-stock or made-elsewhere, because the item still ships. Keep the verb.

**The order that matches nothing.** The annotation asked to look at this case beside Cancel workflow, and it is the right comparison. What happens today:

- The import and the webhooks take in every open, unfulfilled order, tags or no tags. The billing rule already expects this: `ShopUsage.ordersThisCycle` counts only orders Baton started a run on, and its JSDoc says "a shop can hold any number of orders no workflow matches and this stays at zero". Pass-through is designed in and costs the merchant nothing.
- When it is paid, reconcile starts nothing. The order shows the **To make** status and the **No workflow** badge until it is fulfilled in Shopify.
- On the order page each item offers the picker with every active workflow, matched ones first (`lineItemState`, kind `startable`). So yes: the merchant can attach any workflow to an item whose tags matched nothing. Only a shop with no active workflow at all sees "No workflows can start. Create one."
- Nothing lets the merchant say "not ours". The badge stays until the order is fulfilled in Shopify, which for a stock order is the same day.

Side by side:

| the item                            | why nothing runs                        | today reads      | issue       |
| ----------------------------------- | --------------------------------------- | ---------------- | ----------- |
| matched no workflow                 | Baton was never told what to do with it | To make          | No workflow |
| had a run the merchant cancelled    | Baton was told: do not make it          | To make          | none        |
| removed in Shopify (units now zero) | there is nothing to make                | To make, 0 items | none        |

The two rows differ in exactly one way: **an issue is an undecided item.** The no-match item is undecided, so it shows the No workflow badge, and the merchant answers by attaching a workflow (it was ours) or by fulfilling in Shopify (it was not). The cancelled item was decided, so it shows no badge. That is the rule as coded, it is consistent, and it needs no new state and no new word. Keep the No workflow badge even though, in a shop that sells stock items as well as made-to-order items, every stock order will show it until the order is fulfilled. Removing it would also hide a made-to-order product that was never tagged, and that customer never gets their order. A stock order showing No workflow for a day costs nothing.

**The position is the one thing that reads wrong**, and it reads wrong for all three rows: "To make" is a promise, and in each row the bench will make nothing. The first rung means "nothing has started on this order", which covers unpaid, unmatched, cancelled and removed alike. Three ways to fix it:

| fix                                       | after                                             | cost                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| leave it                                  | To make, no badge                                 | the word lies on the cancelled order                                                                                                              |
| a closed run takes its item off the bench | Made (the packer's queue)                         | Made for an order nobody made; and a pass-through order never needs Baton's queue, the merchant fulfils stock from the Shopify orders page anyway |
| rename the rung to **Not started**        | Not started, no badge, for every row of the table | the ladder loses its one-verb triad; "Not started" is also the merchant's word for an unstarted run, which is the same fact one level down        |

**Recommend the rename.** It changes one label and nothing in `productionState` or the SQL. "Not started · Making · Made" is true in every case, including the two the triad promised wrongly, and the view button "Not started · 5" answers "what has not started" which was already its question in 4a. The 2026-09-25 choice of To make was made before the pass-through case was looked at.

**Q8, withdrawn.** A merchant-cancelled order is a decided item, not an issue.

**Q9, closed.** No reopen. A slip is undone in the picker with a fresh run, the modal warned, and the closed line keeps the record.

**Q10, closed.** No change to the modal and no rename. It is Cancel workflow.

**Q11. Rename the first rung to Not started?** Accepted 2026-09-28. The three fixes are in the table above. **Recommend yes.** If the triad matters more than the two odd cases, "leave it" is the fallback, and the cancelled order reads To make with no badge, which is today.

## 10. The word for the row of buttons

### 10a. What happened

The implementation plan called the seven buttons "tabs" without a decision. The word came from the member's Workflows list, whose five buttons (Mine · Up next · Teammates · Blocked · Recent) are `RunTab` in the code, `?tab=` in the URL, and "tab" in every JSDoc and test around them. That code's own comment admits the stretch: "Polaris has no tab component ... so a tab here is an `s-button`, pressed by variant". The word was borrowed from the old Polaris React library, whose `Tabs` component drew a shop's saved views as underlined tabs across the top of a table. That is not what the admin does now and not what Baton draws.

### 10b. The facts

- **Shopify's word today is view.** On this store's Orders and Products pages the control is a button labelled "All" that opens a menu; the menu's accessible name is "Select a view" and its entries (All, Unfulfilled, Unpaid, Open, Archived on Orders; All, Active, Draft, Archived on Products) are radio items. Beside it sits "Search and filter". So the admin's bar has two different things: a **view**, one chosen at a time, each a whole question about the list; and **filters**, which narrow whatever view is chosen and combine.
- **The Polaris web components have no tab component.** The component list (`refs/shopify-docs/docs/api/app-home/latest/web-components/`) has buttons, a press button, a choice list, chips, a select, and nothing called tab. The one docs page that says "tabs" is a navigation guideline ("use tabs sparingly for secondary navigation") whose picture is a nav menu.
- **A tab, in general UI vocabulary**, is one of a row of labelled controls across the top of a panel, one selected, selecting one swaps the content below. Named after tabbed folders; browser tabs are the same idea. Drawn as flat text with an underline or a raised edge, not as a bordered button.
- **"tab" already means browser tab in Baton's code**, in the socket and billing reasoning: "one socket per tab", "a stale tab or a second admin", "as long as the tab lives". Those uses are correct and must stay. Using the same word for a list button gives the word two meanings in one codebase.
- **What Baton draws**, on both screens, is a row of Polaris press buttons (`s-press-button` on the orders index, `s-button` with a pressed variant on the member list), each with a label and a count, exactly one pressed, and pressing one swaps the whole list. Behaviourally that is Shopify's view. Visually it is buttons.

### 10c. The thing being named

One of a small fixed set of whole questions about a list, exclusive, chosen by pressing its button, each carrying a count. Two screens have one: the member's Workflows list (five) and the merchant's orders index (seven after this change). The team select and the order-number search are not this: they narrow within the chosen one and combine, which is what Shopify calls a filter.

| word   | one button reads as               | the row reads as       | for                                                                                                                              | against                                                                                                                                   |
| ------ | --------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| view   | the Blocked view, the Issues view | the view row           | Shopify's word, on the same kind of bar, one menu over from Baton; separates cleanly from "filter"; true of what the button does | the code already uses `View` as the suffix of seven read-model structs (`OrdersView`, `RunView`, `RunListView`, ...), a second meaning    |
| tab    | the Blocked tab                   | the tab row, the strip | current member-side word; short                                                                                                  | not Shopify's word; not what a tab looks like; already means browser tab in the socket code; the user read it cold and could not place it |
| filter | the Blocked filter                | the filter row         | plain; what the user first called them                                                                                           | Shopify uses it for the other thing (search, team); All is not a filter; the buttons are exclusive and filters combine                    |
| list   | the Blocked list                  | the lists              | plain                                                                                                                            | the member's screen is already "the workflows list", so a list inside the list                                                            |
| tier   | the Blocked tier                  |                        | already a domain word for the four groups the object sorts open runs into (`RunTier`)                                            | Recent is not a tier and neither is Fulfilled; it names the grouping rule, not the button                                                 |
| queue  | the Blocked queue                 |                        | shop-floor register                                                                                                              | wrong for Recent, Fulfilled, All, Issues                                                                                                  |

### 10d. Recommendation: view, on both screens, and retire "tab" for anything that is not a browser tab

The word is Shopify's, it is what the button does, and it leaves "filter" free for the search and the team select, which is the same split the admin's own bar makes. The member-side rename is the cost of getting it right once; leaving the member list on "tab" while the orders index says "view" would be the third word for one thing.

The `View` suffix on the read-model structs is the one real collision, and it is resolved by renaming the structs, not by picking a worse word for the buttons: those seven names mean "everything one screen renders in one round trip" and the suffix was a loose choice. What to call them is Q13 (section 10f).

The renames, both screens:

| today                                                          | after                                                                | where                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunTab`, `DEFAULT_RUN_TAB`, `RunQuery.tab`                    | `WorkflowsListView`, `DEFAULT_WORKFLOWS_LIST_VIEW`, `RunQuery.view`  | `Domain.ts`, `RunRepository.ts`, `ShopAgent.ts`, member routes                                                                                       |
| `src/lib/runTabs.ts`: `TABS`, `TAB_LABEL`, `TAB_EMPTY`         | `src/lib/workflowsListViews.ts`: `VIEWS`, `VIEW_LABEL`, `VIEW_EMPTY` | member list route, e2e                                                                                                                               |
| `?tab=` on the member URL                                      | `?view=`                                                             | `shop.$shop.tsx`, member list, e2e helpers                                                                                                           |
| `.run-strip-tabs`, "strip"                                     | `.run-view-row`, "view row"                                          | `styles.css`, member list, e2e                                                                                                                       |
| "tab" in JSDoc, comments, test titles on the member side       | "view"                                                               | `Domain.ts` (`RunTab`, `RunTier`, `RecentItem`, `RunQuery`, the `runActions` paragraph), `RunRepository.ts`, `MemberRun.tsx`, `MemberBar.tsx`, tests |
| the orders index's new literal (plan section 2, "`OrdersTab`") | `OrdersIndexView`, `?view=`, `ORDERS_INDEX_VIEW_LABEL`               | plan                                                                                                                                                 |
| the seven `*View` read structs                                 | `*Read`, `RunTaskRow`                                                | `Domain.ts` and every reader                                                                                                                         |

The literals are named by the screen's glossary spec name ("the workflows list", "the orders index") plus the word, so a reader knows which row without opening the file. `RunTier` stays: it is the object's grouping rule, four of the member's views are tiers, and the JSDoc already says so.

Glossary: one new Nouns row, so the word has a home:

| word | meaning                                                                                                   | symbol                                 | screen                        |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------- |
| view | one whole question about a list, chosen by pressing its button; exclusive; the row's default is the first | `WorkflowsListView`, `OrdersIndexView` | its label (Mine, Issues, ...) |

And `scripts/rules-lint.ts` gains "tab" as a retired word in screen copy, so it cannot come back on a label; JSDoc about browser tabs is untouched because the lint reads string literals and JSX text only.

### 10e. What this costs

The member side is a rename with no behaviour change: about thirty sites in `Domain.ts`, `RunRepository.ts`, `runTabs.ts`, the member list route and layout, two components, `styles.css`, and the member e2e helpers. The struct renames are mechanical and the compiler finds every site. A member's bookmarked `?tab=mine` reads as the default view, which is Mine, so nothing breaks. It is one more step in the plan, and it is the step that stops this word from confusing the next reader.

**Q12. The word is view, on both screens, with the renames above?** Accepted 2026-09-28. **Recommend yes.** The fallback is to keep "tab" on both screens and accept that it is the old Polaris word and a second meaning of a word the socket code needs; that is cheaper today and costs the same confusion again later.

### 10f. The suffix for what a screen reads

The code already has a suffix convention: `*Input` is what a callable takes (`ListRunsInput`, `BlockRunInput`), `*Result` is what a write answers (`RunResult`, `AttachResult`), `*Row` is one table row (`OrderRow`, `ShopUsageRow`), `*Item` is one list entry (`RunListItem`, `RecentItem`), `*Detail` is a record with its children (`RunDetail` is a run and its tasks, `TeamDetail`). The seven `*View` structs are the odd ones: each is what one screen reads in one round trip, and two of them are not even that (`WorkflowDraftView` is a draft with its tasks, nested inside `WorkflowDetailView`; `RunTaskView` is a task with its `current` flag).

| suffix   | example               | for                                                                                                                                | against                                                                              |
| -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Data     | `OrdersIndexData`     | the plainest word; TanStack's own word for it (`loaderData`, `useLoaderData`); `OrdersIndexLoaderData` already exists in the route | generic on its own; the prefix has to carry the meaning                              |
| Read     | `OrdersIndexRead`     | says where it came from: one read of the object                                                                                    | a verb as a noun; "an OrdersIndexRead" reads oddly; not an idiom                     |
| Output   | `OrdersIndexOutput`   | the pair of `*Input`                                                                                                               | dull, and `*Result` is already the pair of `*Input` on the write side                |
| Snapshot | `OrdersIndexSnapshot` | true of a subscribed page: every push is a new one                                                                                 | implies versions kept; a new concept word for no new concept                         |
| Screen   | `OrdersIndexScreen`   | ties to the Screens table                                                                                                          | "screen" is the page the person sees, not its data; two meanings for a glossary word |

**Recommend Data**, and name each by the glossary's screen name so the Screens table and these structs line up: a reader who knows the screen knows the struct.

| today                | after                 | why this name                                                                                                                |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `OrdersView`         | `OrdersIndexData`     | the orders index; `OrdersIndexLoaderData` stays as the loader's `{ orders: OrdersIndexData, usage }`                         |
| `OrderDetailView`    | `OrderPageData`       | the order page                                                                                                               |
| `WorkflowDetailView` | `WorkflowPageData`    | the merchant's workflow page                                                                                                 |
| `WorkflowDraftView`  | `WorkflowDraftDetail` | not a screen: a draft with its tasks, the `*Detail` shape (`RunDetail`), nested in `WorkflowPageData` and read by the editor |
| `RunListView`        | `WorkflowsListData`   | the member's workflows list                                                                                                  |
| `RunView`            | `RunPageData`         | the member's workflow page; "Run" rather than "Workflow" because the merchant's page has that name and the route is `$runId` |
| `RunTaskView`        | `RunTaskRow`          | not a screen: one task row with its `current` flag; `runTaskViews` → `runTaskRows`                                           |

Generic is right here because these structs have no rule of their own: each is a bundle the socket hands a screen, and the meaning is in the prefix. Read is the fallback if "Data" reads too plain.

**Q13. `Data` as the suffix, named by screen, as the table says?** Accepted 2026-09-28. **Recommend yes.**

## 11. Not in scope

The order page's own controls, the sync button and banners, pagination, the team drill-in from the team page (`?team=` keeps working), `productionState` and `orderNeeds` themselves, and the member's Workflows list's behaviour: its five views (Mine · Up next · Teammates · Blocked · Recent) are already one row of views and are the shape 4a copies. Section 10 renames them from "tab" to "view" and changes nothing else about them.

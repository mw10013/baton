# Shipped vs fulfilled research

2026-09-25. Answers: where "shipped" comes from, why two words appear, what the fulfilled banner and its flags actually do, and how the action tables in `Domain.ts` decide what a page offers. Decisions are in section 8; how the bug got through is section 7; sections 9 and 10 rethink the closed order and the stage names; section 11 is the simpler model that replaces 4, 5 and 9.

## 1. Where Baton gets "fulfilled"

One field, three paths, one predicate.

- **Field.** `Order.displayFulfillmentStatus` on the Admin GraphQL API. It is the order's _aggregated_ fulfillment status "for display purposes", non-null, enum `OrderDisplayFulfillmentStatus` (`refs/shopify-docs/docs/api/admin-graphql/latest/enums/OrderDisplayFulfillmentStatus.md`). Values and the words the admin shows for them:

  | Value                                      | Admin shows         | Meaning                                                     |
  | ------------------------------------------ | ------------------- | ----------------------------------------------------------- |
  | `UNFULFILLED`                              | Unfulfilled         | none of the items fulfilled                                 |
  | `PARTIALLY_FULFILLED`                      | Partially fulfilled | some items fulfilled                                        |
  | `FULFILLED`                                | Fulfilled           | all items fulfilled                                         |
  | `IN_PROGRESS`                              | In progress         | fulfillment requested from a service, or marked in progress |
  | `ON_HOLD`                                  | On hold             | every unfulfilled item on hold                              |
  | `SCHEDULED`                                | Scheduled           | unfulfilled items scheduled for later                       |
  | `REQUEST_DECLINED`                         | Request declined    | a fulfillment service declined                              |
  | `OPEN`, `PENDING_FULFILLMENT`, `RESTOCKED` | legacy              | replaced by the values above                                |

- **Paths in.** The bulk import (`OrdersBulkRepository.ts`), the single-order fetch (`OrderSync.ts`, used by the `orders/*` webhooks and Resync) both select `displayFulfillmentStatus` and store it verbatim in `ShopOrder.fulfillmentStatus` as a plain string. The `orders/fulfilled` webhook (`shopify.app.toml`) is what makes the fulfilled transition arrive without polling; `orders/updated` is deliberately not subscribed.

- **Predicate.** `Domain.isFulfilled` is `fulfillmentStatus === "FULFILLED"`, and it is the only fulfillment value Baton acts on. `PARTIALLY_FULFILLED`, `IN_PROGRESS`, `ON_HOLD` and the rest are all treated as open. Nothing reads `Order.fulfillable`, `fulfillmentOrders`, or line-level fulfillment. The JSDoc on `unitsToMake` says why: Shopify does not lower `currentQuantity` when a unit ships, so a line shipped early is still work until the whole order is `FULFILLED`.

So yes, the confusion is well founded: "shipped" in Baton is exactly Shopify's `FULFILLED`, renamed.

## 2. What "fulfilled" does once stored

Three readers, all through `isFulfilled`.

1. **Reconcile** (`WorkflowRunRepository.reconcileOrder`). A `FULFILLED` order is a stop gate, second only to cancelled: pending runs are deleted, active runs get the `order_fulfilled` flag, done runs are untouched, nothing new starts. A partial fulfillment does nothing.
2. **The action sets** (`canAttachRun` = not cancelled and not fulfilled). Every field of `runActions` and `taskActions` that does work is false on a closed order. What survives: the note, `liftFlag` (Dismiss), and the merchant's Cancel run. Manual attach is refused.
3. **The orders index** (`productionState`). Fulfilled reads as position `shipped`, whatever its runs say. That is why a fulfilled order with an `In progress` run still sits under Shipped, and why every historical order the bulk sync pulls in is Shipped with no runs at all.

## 3. The two vocabularies

The app carries two concepts that are correct but named inconsistently.

| Concept             | Owner   | Source                                   | Values                                                        |
| ------------------- | ------- | ---------------------------------------- | ------------------------------------------------------------- |
| Fulfillment status  | Shopify | `displayFulfillmentStatus`, stored as-is | Unfulfilled, Partially fulfilled, Fulfilled, In progress, ... |
| Production position | Baton   | `productionState`, derived per read      | In production, Ready to ship, Shipped, Cancelled              |

They are not equivalent. Fulfillment is a fact Shopify records about the order. Position is Baton's ladder, derived from run counts, with fulfillment overriding the top rung. The one point of contact is `FULFILLED` → `shipped`.

Where each word appears today:

| Surface                                          | Word used                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| Orders index status button and badge             | Shipped                                                                |
| Orders index empty state                         | "No orders have been fulfilled yet."                                   |
| Order page sidebar                               | Fulfillment: Fulfilled (Shopify's value, `formatStatus`)               |
| Order page closed banner                         | Fulfilled in Shopify                                                   |
| Order page ready banner                          | "Fulfil this order in the Shopify admin; it will show as Shipped here" |
| Order page run badge                             | Already shipped in Shopify                                             |
| Order page flag banner (shared `MemberRun` copy) | heading Already shipped, body Fulfilled in Shopify.                    |
| Member run list flag                             | Already shipped / Fulfilled in Shopify.                                |
| Domain literal and flag                          | `shipped`, `order_fulfilled`                                           |

So the same screen says Shipped, Fulfilled, and "Already shipped ... Fulfilled in Shopify" within a few lines, and the ready banner has to explain that fulfilling becomes shipping. That explanation is the tell: a word that needs translating on the page is the wrong word.

### What the merchant expects

Shopify's admin never says "shipped" as an order status. The Orders list filter is Fulfillment status with Unfulfilled / Partially fulfilled / Fulfilled / Scheduled / On hold; the order page badge says Fulfilled; the action is "Fulfill item(s)" / "Mark as fulfilled"; the notification is "Shipping confirmation" but that is the customer's email, not the merchant's status. Fulfilled also covers local pickup, digital goods and dropship, none of which ship from the bench. A merchant who has used Shopify for a week reads Fulfilled as their word.

"Shipped" has one thing going for it: it is what a maker says. But the maker only meets the word inside a flag on a fulfilled order, where the body already says "Fulfilled in Shopify".

## 4. The closed-order banner

Current copy, on a fulfilled or cancelled order:

> **Fulfilled in Shopify**
> Work on this order is read-only. Dismiss the flags to clear them from the team views.

What is true and what is not.

- **"Work on this order is read-only."** True in effect: Start, Done, Put back, Reopen, Reassign, Block, Change workflow, attach are all false. But it is stated in the code's terms. The merchant's question is "why can't I do anything to this In progress run?", and the answer is "because Shopify says the order is finished". The run badge still says In progress next to Already shipped in Shopify, which is the contradiction the sentence is trying to paper over.
- **"Dismiss the flags to clear them from the team views."** Not true. `dismissFlag` nulls the flag and nothing else. `tierOf` puts a flagged run under Blocked; an unflagged open run goes to Mine or Up next, and the member list query (`WorkflowRunRepository` `listRuns`) joins the order only to carry its state for the action set, it does not filter closed orders out. So after Dismiss the row leaves the member's Blocked tab and reappears under Up next with no Start and no Done: a run they cannot touch, with no banner saying why. Only Cancel run (which deletes the run, decision Q13) removes it. The sentence promises what Cancel run does and points at Dismiss.
- **"the flags"** is one per open run at the moment of fulfillment. An order fulfilled with three items in production has three, each dismissed separately, each on its own card. An order fulfilled with all runs done, or with no runs (every historical order), has zero flags and the sentence is about nothing. The banner does not know which case it is in.

Whether it is necessary at all: the sidebar says Fulfillment: Fulfilled and the work buttons are gone. A banner earns its place only when there is something to explain, and that something is "there are open runs Shopify has finished for you". On an order with no open runs there is nothing to say.

## 5. Cancel run under Manage

`runActions.cancel` is true for the merchant on any open run, closed order included, and the table says why: "Cancel run is how the merchant clears an `order_cancelled` run out of the team views." That is the only remedy that actually delivers what the banner promises, and it is under a collapsed Manage section, one per line item, behind a confirmation modal that names the loss. So the honest flow on a fulfilled order with three flagged runs is: expand Manage three times, Cancel run three times, confirm three times. The wishy-washy feeling is the gap between the banner (says Dismiss) and the mechanism (needs Cancel).

## 6. How the tables work, concretely

### 6a. The nouns

- **Order.** Shopify's. Baton stores a copy. **Closed** here means Shopify has finished with it: cancelled or fully fulfilled. It has nothing to do with whether a workflow is attached. Every other order is **open**. (The code's name for this test is `canAttachRun`, which is a poor name for the concept and should become `orderIsOpen`.)
- **Line item.** One product on the order, with `currentQuantity` units still to make.
- **Workflow.** The merchant's recipe: ordered steps, each step one or more tasks, each task assigned to a team.
- **Run.** One line item's copy of one workflow, with its own tasks. Status `pending` (no task started), `active` (a task started), `done` (every task completed), `cancelled` (the merchant's marker that the item's run was cancelled; no tasks). At most one run per line item.
- **Task.** One step's work on one run, on one team. Fields: `ready` (its step is the current one), `startedAt`, `completedAt`, `teamId`.
- **Flag.** One optional label on a run saying something happened to it that a person should read: `blocked` (a member set it, with a reason), or one reconcile sets: `quantity_changed`, `item_removed`, `order_cancelled`, `order_fulfilled`.
- **Reconcile.** The routine that runs after every order write from Shopify. It compares the stored order with its runs and starts, resizes, flags or deletes runs.

### 6b. Why two action sets: runs and tasks

Because two different people act on two different things.

- **Task actions** are the bench verbs. A member looks at _their_ task on a run and asks: can I start it, finish it, put it back, undo it? The merchant can also finish, reopen, and reassign a task. So `taskActions` is per task and per actor: `start`, `done`, `putBack`, `reopen`, `reassign`.
- **Run actions** are about the whole run, not one step. Write a note on it, hold it (block), lift a hold or a flag, cancel it, swap its workflow. None of those belong to one task. So `runActions` is per run and per actor: `note`, `block`, `editReason`, `liftFlag`, `cancel`, `changeWorkflow`.

Two functions because a page renders them in two places: run-level buttons under the item's card header, task-level buttons on each step row. One function would return a nested object and every reader would pick it apart the same way.

### 6c. Dismiss and Unblock

A run can carry one flag. There are two kinds of flag and one button to clear either:

- **Blocked**: a person held the run. The button says **Unblock**.
- **Reconcile flag**: Shopify changed something (quantity, item removed, order cancelled, order fulfilled). The button says **Dismiss**.

Both buttons call the same write, which clears the flag. The table calls that write `liftFlag`. That is all it is.

**Why Dismiss exists at all, and what happens to the quantity.** When Shopify lowers a quantity from 3 to 2, reconcile writes 2 onto an active run _and_ flags it. So the new quantity is already persisted; the flag exists only so the maker, who may have cut 3, stops and reads before tapping Done. On a _done_ run reconcile does not overwrite the quantity; the merchant's Dismiss does. That is the one "done, quantity flag" row. The honest answer to "why dismiss" is: the flag is a notice, and Dismiss is how a notice with a button on it goes away. Section 11 proposes dropping the button.

### 6d. The run table, one row at a time

For each row, what a merchant (M) and a member whose team has a ready task on the run (m) can do. Every other actor: nothing but the note when the run is visible to them.

| Row                   | What it is                                                                    | Who can what                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| open, no flag         | ordinary work in progress                                                     | both: note, block. Merchant: cancel, change workflow.                                                           |
| open, blocked         | a member held it with a reason                                                | both: note, edit the reason, Unblock. Merchant: cancel, change workflow. Nobody: block again (already blocked). |
| open, reconcile flag  | Shopify changed something (quantity, item removed, order cancelled/fulfilled) | both: note, Dismiss. Merchant: cancel, change workflow. Nobody: block (it would overwrite the news).            |
| open, nothing to make | line item at zero units, flag already dismissed                               | both: note, block. Merchant: cancel. Nobody: change workflow (no work to route).                                |
| done, no flag         | finished                                                                      | note only.                                                                                                      |
| done, quantity flag   | finished, then Shopify changed the quantity                                   | note; merchant Dismiss (accepts the new quantity).                                                              |
| order closed          | Shopify cancelled or fulfilled the order                                      | note; Dismiss if flagged; merchant cancel. Nothing that does work.                                              |

The **task** table is the same idea for the bench verbs: a task can be started (member only), finished or put back only when it is ready, uncompleted, on an unflagged open run, on an open order; reopened when finished; reassigned by the merchant while open. On a closed order every cell is blank.

### 6e. What a flag changes, concretely

Take a run with a member mid-task, and Shopify reports the order fulfilled. Reconcile stamps `order_fulfilled` on it. From then on:

| Effect                                     | Where                                  | Why                                                              |
| ------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------- |
| Start, Done, Put back disappear            | `runIsFlagged`, refused server-side    | a flag means stop until someone reads it                         |
| the one button offered is Dismiss          | `runIsBlocked` false → word is Dismiss | it was reconcile, not a person, so there is no hold to "unblock" |
| the row moves to the member's Blocked tab  | `tierOf`: a flag wins the tier         | it needs attention before anything else                          |
| the order counts as `changed` on the index | `runCounts.flagged`                    | the merchant's Needs row says "Changed"                          |
| the banner heading reads Already shipped   | `flagHeading` in `MemberRun`           | the flag names itself; the tab word stays Blocked                |

Dismiss undoes the first four. It does not, today, change where the row lives once it is unflagged, which is section 4's problem.

### 6f. What the tables cover, plainly

The tables say **which buttons appear** on a run or task, for a given person. They do not say **which runs appear in a list**. The member's Mine, Up next, Teammates and Blocked tabs each decide that on their own, in SQL and in `tierOf`, with no shared rule. That is the gap: a fulfilled order's run has no buttons (the table says so) but is still listed (nothing says otherwise).

## 7. How this got through

Two separate mistakes, with different causes.

### 7a. The word

"Shipped" was not chosen; it was inherited. It first appears on 2026-09-03 in the Route to Ship competitor research, quoting their setting: "Orders count as shipped when fulfilled in Shopify." Route to Ship's name is a shipping metaphor, so their whole vocabulary is Ready to ship / Shipped, and the research adopted it for Baton's ladder (In production · Ready to ship · Shipped) without asking what the merchant's own admin calls the same thing. The `order_fulfilled` flag arrived the next day in the order workflow spec with Shopify's word, because it was written against the API. From then on the two words coexisted: the literal was `shipped`, the flag was `order_fulfilled`, and each later screen picked whichever word its author had just been reading. The orders index (2026-09-23) used the literal; the flag banner used the flag; the sidebar prints Shopify's value raw. Nobody was wrong locally.

The prevention is the naming rule you already keep (memory: naming research separates admin on-screen text, Help Center term, and API name): for any concept Shopify already names, the on-screen word is Shopify's on-screen word unless there is a written reason. Section 3 is that table for this one concept. It was never made for "shipped" because the word came in through a competitor comparison, not a naming pass.

### 7b. The zombie run

The banner sentence, the `cancel` cell's justification, and the member-list query all date from the same two days (2026-09-23 and 2026-09-24, the status/needs split and the state-model consolidation). Reading them together:

1. **The `waitingOn` rule was stated for the index only.** "Only an open order waits on a team ... the only action left is the worker's Dismiss on their own run list." That JSDoc already describes the worker dismissing a flag on a closed order, and stops there. It does not say what the worker sees afterwards. The rule was written from the merchant's index looking outward, not from the bench.

2. **The `cancel` cell told the truth, quietly.** "Cancel run is how the merchant clears an `order_cancelled` run out of the team views." That sentence is the design admitting that Dismiss does not clear the team views. It sits in the middle of a seven-row table's footnotes, where it reads as a justification for one cell rather than as a statement that the banner two files away is wrong.

3. **The banner was written last, from the table.** The consolidation commit rewrote the order page against `runActions`, and the banner copy describes the table's "order closed" row (note, liftFlag, cancel remain) in prose: "read-only", "dismiss the flags". `liftFlag` was the friendlier verb to name, so it named it, and inherited the assumption that lifting a flag on a closed order finishes the story.

4. **No test could catch it, because no rule was written for it.** Every rule in this area has a test titled with the rule, and the tests are exhaustive for the tables: "every blank cell of the run and task matrices is refused by its callable", "a fulfilled order is closed the same way as a cancelled one". `listRuns` has seven tests and none puts a closed order in front of a member, because there was no sentence saying what should happen. The method works when a rule exists; it cannot find a rule that was never stated.

So the root cause is that the tables cover buttons and not lists. There is no rule for _is this row shown to this person_, so visibility is decided in three unrelated places (`tierOf`, the `listRuns` SQL, `waitingOn`) with no shared row for "order closed", and the merchant page copy was free to assume an answer.

### 7c. What would have caught it, and what prevents the next one

- **A visibility table.** One function, `runVisibility(actor, order, run)` or a row on `RunTab`, stating for every run state which member tab holds it, with "order closed" as a row. The same shape as `runActions`: page and read query both derive from it, one test per row. Once "order closed, unflagged" has a cell, it has to say something, and "Up next, no actions" would not survive being written down.

- **Copy that quotes the table.** Any sentence on a page that promises an outcome ("clears them from the team views") names the predicate it relies on in a code comment beside it, the way the banner's own comment already links `canAttachRun` for the read-only half. A promise with no predicate to link is the smell.

- **Walk the closed-order row through every surface.** Sections 4 and 5 of this doc are that walk for fulfilled: banner, run card, Manage, member Blocked tab, member Up next, index. The consolidation research did this per card kind for the merchant page and per matrix for writes, and did not do it for reads. A "state × surface" pass, one row per closed state, one column per screen, is cheap and would have shown the empty cell.

### 7d. Others likely lurking in the same gap

Checked while writing this; each is the same class, a read path with no stated closed-order rule.

- **Member work page (`getRunView`) on a closed order.** Reachable by link from the list or a stale tab. The action set is all false, so it renders a run with no buttons and, after Dismiss, no banner. Same fix as Q3.
- **Done today (`listDone`) on a cancelled order.** Reopen is `mine && task.completedAt !== null`, and `mine` requires the order open, so Reopen is refused. The row shows without saying why. Minor, but the same shape.
- **Member counts (`RunQuery`) include closed-order runs** wherever `listRuns` does, so the Up next badge counts rows nobody can start. Falls out of Q3.
- **`dismissFlag` does not read the order.** It checks the run and the team, not `canAttachRun`. That is by design (`liftFlag` is true on a closed order), but it means there is no server-side statement of what Dismiss means on a closed order beyond "null the flag". If Q3 is adopted, that JSDoc should say Dismiss is also what removes the row from the bench.
- **Cancel run's confirmation modal names the loss on a closed order** the same way as on an open one, though there is nothing left to lose. Cosmetic; goes away with Q6.
- **Order sidebar prints `formatStatus(fulfillmentStatus)`**, which will render `On hold`, `Scheduled`, `Request declined` and the legacy values as ordinary text while Baton treats all of them as open. Correct behaviour, but a merchant seeing "In progress" under Fulfillment beside a run badge "In progress" is the same two-vocabulary problem again. Covered by Q1 only partly; worth a note on `ShopOrder.fulfillmentStatus` that non-`FULFILLED` values are displayed and never acted on.

## 8. Decisions (2026-09-25)

No open questions remain.

| #              | Decision                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Q1             | Fulfilled replaces Shipped everywhere; literal `shipped` becomes `fulfilled`.                  |
| Q2             | Third rung is **Made**.                                                                        |
| Q7             | No partial fulfillment.                                                                        |
| Q9             | Moot: under section 11 closed runs leave every list by one rule.                               |
| Q11            | Adopt section 11: closed runs replace the reconcile flags and Dismiss; Block is the only flag. |
| Q12            | Second rung is **Making**.                                                                     |
| Q13            | Done today becomes **Recent**.                                                                 |
| Q14            | First rung is **To make**. The ladder is To make · Making · Made · Fulfilled (and Cancelled).  |
| Q3–Q6, Q8, Q10 | Superseded by Q11.                                                                             |

## 9. The closed order, from first principles

You asked why an order that Shopify has closed would need anyone to dismiss anything. Taking it from the top.

### 9a. Where the flag came from

Flags were designed for `quantity_changed` and `item_removed`: Shopify changed the work under a maker, the maker must read that before continuing, and after reading they carry on (or stop, for a removed item). "Stop, read, acknowledge, continue" is the right shape for those. `order_cancelled` and `order_fulfilled` were given the same shape because they arrived through the same routine, reconcile, and the shape was already there. But they are not changes to the work; they are the end of the work. Acknowledging the end of something is not a step anybody asked for.

### 9b. How often does it happen?

Fulfilled with open runs is not the edge case it looks like. Baton never writes fulfillments, so _every_ order is fulfilled in the Shopify admin by a person, and that person can do it before the last Done is tapped. Three ordinary ways:

1. **The bench skipped the app.** The item was made and packed, nobody tapped Done on the last step, the packer fulfilled in Shopify. On a real floor this is the common case, not the rare one. Baton is "out of sync" only in the sense that the app is behind reality.
2. **The merchant shipped early.** Rush order, they took it off the bench.
3. **Made elsewhere.** Restocked, dropshipped, substituted.

In all three the work is over. Nobody wants to be asked anything. The one case where "stop and read" is right is the maker mid-cut when the merchant fulfills by mistake, and even there the useful signal is "this left your list, here is why", not a flag they have to clear.

Cancelled with open runs is different: the maker mid-cut should stop, and a row that vanishes silently from Mine is a worse signal than one that says Order cancelled. But that too is a _notice_, not a to-do.

### 9c. What state should the runs go into?

Options, when Shopify reports `FULFILLED` and runs are open:

- **A. Close them as done.** Reconcile completes every remaining task with a system actor (`completedByRole` gains a value such as `shopify`), the run becomes `done`. The member's Done today shows the run with "Fulfilled in Shopify" where a name would be. The merchant's card shows Done with the same note on the closed tasks. Nothing to dismiss; nothing lingers on any list. The record of who did what survives: human-completed tasks keep their names, system-completed ones say Shopify.
- **B. Close them as stopped.** A new terminal status (`closed`) with a reason. Truer when the work was not actually done, but it is a fourth terminal state to explain on every screen, and the merchant cannot tell A from B by looking anyway.
- **C. Keep the flag, fix the lists (Q3 as written).** The maker gets a notice, dismisses it, the row goes. The merchant may still have several to dismiss.
- **D. Delete the runs.** No record. Rejected for the same reason Q13 kept the marker.

For `cancelled` with open runs:

- **A'. Same as A** but the tasks are not completed; the run gets the existing `cancelled` marker with a reason `order_cancelled`, tasks deleted as Cancel run does today. The member's list loses the row; the Done today list, or a small "Stopped" line, says why.
- **C'. Keep the flag.** The maker sees Order cancelled on their Mine row until they dismiss it.

### 9d. Recommendation

**A for fulfilled, C' for cancelled, and Dismiss becomes the only thing a member does with a closed-order flag.**

- Fulfilled is the normal end of an order. Treat it as the last Done, tapped by Shopify. This matches your instinct that a closed order "moves along". The Ready to ship banner already tells the merchant "fulfil in Shopify and it will show as fulfilled here"; A makes that sentence the whole story.
- Cancelled is an interruption, and the person holding the item is the one who needs to hear it. Keeping the flag there is right; what changes is that after Dismiss the row leaves the bench (Q3), and the merchant page has one "Dismiss all" (Q5) instead of one per item, or nothing at all if the merchant is content to let the team dismiss their own.
- With A there is no `order_fulfilled` flag, no Dismiss on fulfilled orders, no Cancel run on a fulfilled order, and the fulfilled banner (Q4) reduces to a count of runs Shopify closed, or nothing.

This reverses part of what was agreed on 2026-09-24 (Q5: one page-level banner on a cancelled or fulfilled order; the "order closed" row's liftFlag and cancel cells for fulfilled). It does not touch the tables' shape; it removes one flag value and adds one task-completion role.

## 10. Stages, from first principles

The ladder In production · Ready to ship · Shipped was taken from Route to Ship. What a made-to-order merchant actually needs from the Orders list is three questions:

1. Which orders have nobody working on them yet? (not started, or waiting on a choice)
2. Which are on the bench? (in production)
3. Which are made and waiting for me to fulfil? (the packer's queue)

Everything past 3 belongs to Shopify: fulfilled, cancelled. Baton shows them only so the list is complete.

So the positions are: **not started**, **in production**, **made**, then Shopify's **fulfilled** and **cancelled**. The current model already has these five (`null`, `in_production`, `ready_to_ship`, `shipped`, `cancelled`); only the words for the last three were borrowed.

Candidates for the third rung, the one that is Baton's own:

| Word            | For                                                                                                             | Against                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Made**        | Baton's brand is made-to-order; "made" is the bench's verb done; one word; contrasts cleanly with In production | reads oddly for a workflow that ends in packing rather than making |
| Ready           | short, neutral                                                                                                  | ready for what? needs the column header to explain                 |
| Ready to fulfil | exactly what the merchant does next, in Shopify's word                                                          | three words; a phrase nobody says aloud                            |
| Ready to ship   | current; physical and clear                                                                                     | wrong for pickup and digital; "ship" is not Shopify's word         |
| Finished        | plain                                                                                                           | collides with the run status Done                                  |
| Complete        | plain                                                                                                           | Shopify uses "completed" for a different thing (order archived)    |

Recommendation: **Made**. In production · Made · Fulfilled reads as a made-to-order app talking about making, with Shopify's word at the point where Shopify takes over. The index header "Workflows" above the badge would become "Production" so the column names the ladder.

## 11. A simpler model

Your annotation on section 8 is the right diagnosis: if the rules cannot be laid out in a page, a merchant will not follow them. This section proposes the model that fits on a page. It is a proposal to replace sections 4, 5 and 9, not to add to them.

### 11a. The one idea

**Shopify events never create a to-do. They just change the work.**

Today every Shopify change (quantity, item removed, order cancelled, order fulfilled) creates a flag that someone must dismiss. That is four kinds of homework, on two screens, one per run. The simpler rule: the change is applied, the run reflects it, and nothing waits on anyone.

### 11b. What that means for each event

| Shopify says             | Today                                                                      | Proposed                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quantity changed (3 → 2) | run quantity becomes 2, flag, Start/Done refused until Dismiss             | run quantity becomes 2. The run wears a warning badge **Quantity changed · 3 → 2** on the list row and the work page until a person finishes the next task on it. No button. |
| Item removed or refunded | flag `item_removed`, Dismiss, then a zero-unit run lingers                 | run is **closed**, reason "removed". Leaves the bench.                                                                                                                       |
| Order cancelled          | pending runs deleted, active flagged, Dismiss per run, Cancel run to clear | every open run is **closed**, reason "order cancelled". Leaves the bench.                                                                                                    |
| Order fulfilled          | same as cancelled with `order_fulfilled`                                   | every open run is **closed**, reason "fulfilled". Leaves the bench.                                                                                                          |

"Closed" is one new terminal run status with a reason, replacing the four reconcile flags and the merchant's `cancelled` marker (Cancel run becomes closed, reason "cancelled by merchant"). A run ends one of two ways: **done** (every task finished by a person) or **closed** (ended by something else, and the reason says what). That is the whole state list: not started, in progress, done, closed.

### 11c. What is left of flags

One thing: **Block**. A member or merchant holds a run with a reason; Unblock lifts it. It is the only thing a person sets, the only thing a person clears, and the only thing the Blocked tab holds. The tab stops being overloaded (your annotation 4), and "Dismiss" disappears from the app.

### 11d. The member's view

- A closed run leaves Mine, Up next and Teammates the moment it closes. The member does not have to do anything.
- It appears in **Done today** with a one-line reason instead of a name: "Fulfilled in Shopify", "Order cancelled in Shopify", "Item removed". That is the answer to "poof, it's gone": it is gone from the work lists, and the recent list says why. Rename the tab **Recent** if "Done" reads wrong for a closed run.
- The one moment this could surprise someone is a maker mid-task on an order the merchant cancels. Their row leaves Mine on the next refresh. On a subscribed page that is seconds. A short toast on that refresh ("Order #1020 was cancelled in Shopify") is cheap and optional. It is a notice, not a to-do.

### 11e. The merchant's view

- Order page: the run card shows **Closed · Fulfilled in Shopify** (or the reason) where it shows In progress today. Tasks keep whoever finished them. No banner, no Dismiss, no Cancel run on a closed order; the sidebar's Fulfillment line and the badge say it.
- Orders index: a fulfilled or cancelled order reads Fulfilled or Cancelled. The Needs row loses "Changed" (nothing is waiting) and keeps Blocked, Needs a team, Choose a workflow, No workflow.
- Ready banner stays: "Every run is done. Fulfil this order in Shopify."

### 11f. What it costs

- A quantity change no longer stops the maker. If they cut 3 and the order dropped to 2, they find out from the badge, not from a stop. Given that the run's quantity was already being overwritten today, the flag was only ever a notice with a button on it.

**Making the quantity change noticeable without machinery.** The badge is warning-toned (the same tone the flag banner uses today), sits on the row in Mine and Up next and in the work page header, and reads the whole change, "Quantity changed · 3 → 2", not a small "was 3". It clears itself when a person completes the next task on that run, because completing a step after the change is proof someone worked with the new number. Nobody dismisses anything, and it cannot be missed by the one person it matters to, since it is on the row they tap to work. Stored as one nullable field on the run (`quantityChangedFrom`), nulled on the next task completion; no flag, no tier, no count.

- Cancel run loses its "fresh run of the same workflow" trick? No: a closed item can still take a new workflow from the picker, same as the cancelled marker today.
- The rules in `Domain.ts` shrink: `RunFlag` becomes `blocked` only (or a boolean plus reason), the action tables lose the flag rows, `liftFlag` becomes `unblock`, `orderNeeds` loses `changed`, the "order closed" row is all blank except the note. Roughly one third of the run-state rules go away, and every one that remains has a plain sentence.

### 11g. The page that explains it to a merchant

If the model is right, this is the whole help text:

> A run is one item's trip through a workflow. It is **in progress** while your team works on it, **done** when the last step is finished, and **closed** if Shopify ends it first (the order was fulfilled or cancelled, or the item was removed). A member can **block** a run that needs attention; unblock it to continue. Nothing else needs your action.

If that paragraph cannot be written for a model, the model is wrong.

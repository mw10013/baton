# Plan: the help read-through

The last phase on the roadmap in `docs/help-research.md`, run 2026-10-08 after the Reference cycle
closed. One read-only agent read all 26 bodies in tree order (the research said 27; the tree has
5 + 5 + 5 + 3 + 4 + 4) against the screens and the Domain code, for cross-page consistency. The
orchestrator spot-checked the eight wrong-fact items against the code and all hold. The report
follows verbatim; the Decisions section after it records what the user accepted and what was
done.

## The reader's report

Help read-through: 26 bodies read in tree order, checked against the screens and the Domain code. No files were changed.

The tree has 26 pages with bodies, not 27: 5 + 5 + 5 + 3 + 4 + 4 (`HELP_BODIES` in `src/components/help/bodies.tsx`). The Workflows roadmap row in `docs/help-research.md` says "6 pages", but the tree holds 5.

**Nothing found on 7 pages:** Creating a team and adding members, Turning a workflow on or off, Renaming, duplicating and deleting a workflow, Creating a team, Adding a member, Who can do what, Limits.

## Wrong facts

1. **Recording your work**: "On the Workflows list, the **…** button on a row has the same buttons without opening the page."
   - Wrong. Placed right after "You can press Done without pressing Start first", it promises Done from the list on a ready task, and the list does not offer that.
   - Evidence: `src/routes/shop.$shop.workflows.index.tsx` `menuItems`: "An unstarted task lists Start and not Done, although Done is allowed there". `if (can.start) return [ …Start… ]` returns only Start. A blocked row lists Unblock alone.
   - Fix: "On the Workflows list, the **…** button on a row has **Start** on a ready task, and **Done** and **Put back** on a started one."

2. **States and badges**, the filters table, Started by others row (`src/lib/helpReference.ts` `LIST_FILTER_ROWS.started_by_others`): "Items with a task someone else started, a teammate or the merchant."
   - Wrong. The merchant never starts a task. A merchant's Done leaves the task done, not started.
   - Evidence: `VERB_LABEL.start: { member: "Start", merchant: null }`, and the taskActions bullet "`start` is member only". Who can do what itself says "Only a member starts a task."
   - Fix: "Items with a task a teammate started."

3. **Removing and deleting**: "Every task on the team, in every workflow, loses its team and reads **Needs a team**."
   - Wrong. The task reads "No team". Needs a team is the workflow's badge (Workflows page) and banner (workflow page).
   - Evidence: `src/components/WorkflowSteps.tsx` `TeamLine`: `{Domain.workflowTaskIsUnassigned(task) ? "No team" : task.teamName}`.
   - Fix: "Every task on the team, in every workflow, loses its team and reads No team. The workflow reads **Needs a team**."

4. **Finding your work** ("The Workflows list shows the items with a task on your teams.") and **States and badges** ("A member's Workflows list holds the items with a task on their teams.")
   - Wrong. The list holds only items whose current task is on the member's teams. An item whose task for your team is in a later step is not listed until that step is current. First order says this correctly: "The first step's tasks show on the Workflows list…".
   - Evidence: `src/lib/RunRepository.ts` (around line 772): `cross join RunTask m on m.teamId = tt.value and m.doneAt is null … where ${currentWhere("m")}`. The route says "Every task on a row is current: that is what put it on the list".
   - Fix (Finding): "The Workflows list shows the items whose current task is on one of your teams."
   - Fix (States): "A member's Workflows list holds the items whose current task is on one of their teams."

5. **Creating a workflow**: "A second badge shows when something stops it:"
   - The list then includes **Team has no members**, which the page itself says "still starts". The page contradicts itself.
   - Evidence: `WORKFLOW_FAULT_ROWS.empty_team`: "The workflow still starts". States and badges words it correctly: "a second badge when something stops it or is missing".
   - Fix: "A second badge shows when something stops it or is missing:"

6. **Editing steps and tasks**: "Every step needs a team, so until the shop has one, the editor says to create a team first."
   - Steps have no team. Tasks do. Creating your first workflow says "Every task goes to a team".
   - Evidence: the vocabulary row "task | one unit of work on a run, on one team", and `applyBlocker` checks tasks.
   - Fix: "Every task needs a team, so until the shop has one, the editor says to create a team first."

7. **How Baton works**: "The order page shows each item with its workflow and the step it is on, such as Step 2 of 3 and the task's name."
   - The item's card does not show the workflow's name. That is in Manage only. The `howBatonWorks1` alt text, correctly, names no workflow.
   - Evidence: `renderRun` JSDoc in `app.orders.$orderId.tsx`: "The workflow's name is the Manage drawer's header".
   - Fix: "The order page shows each item and the step its workflow is on, such as Step 2 of 3 and the task's name."

8. **Getting started (Installing Baton and choosing a plan, and the hub)**: no page in the setup walk tells the merchant to press **Sync open orders** after installing.
   - Syncing from Shopify says: "Press it after installing Baton". Nothing syncs on install: `syncOpenOrders` is only the button.
   - First order's "Baton reads each new order from Shopify as it is placed" leaves orders already open at install unexplained.
   - Fix: add to Installing, after the steps: "Then, on the Orders page, press **Sync open orders** to bring in the open orders from the last 30 days."
   - Related, structural: page 3 (Creating your first workflow) sends the reader to page 4 midway ("Every task goes to a team, so create a team first"). Swapping pages 3 and 4 in `HELP_SECTIONS`, with the hub description "create a team and a workflow", removes the detour. That is your call.

## Loose against another page or the code

9. **Removing and deleting**: "If an item matched two workflows and one of them now has a task with no team, the other starts on it. How that works is in Matching items by product tag."
   - The link goes to a page that does not hold that fact. Matching's "When two workflows match" covers only "If you turn one of the two off or delete it, the other starts on the item."
   - Fix (on Matching): "If you turn one of the two off, delete it, or delete a team one of its tasks is on, the other starts on the item."

10. **Fixing an issue**: "Nobody can press Done on it until the block is lifted."
    - Blocking an item says: "its tasks cannot be started, done or put back."
    - Evidence: `taskActions` "`done` and `putBack` stop under a block".
    - Fix: "Nobody can start, finish or put back its tasks until the block is lifted."

11. **Matching items by product tag**: "If an item carries the tags of two workflows, neither starts."
    - Only active (eligible) workflows count. Fixing an issue and the issue row say "two or more active workflows". `itemMatches` and the multi-match vocabulary row say "two or more eligible workflows".
    - Fix: "If an item carries the tags of two active workflows, neither starts."

12. **Creating your first workflow**: "Each paid order with an item that carries the tag starts it, open orders included."
    - "open orders included" implies closed ones start too. Matching says the same fact correctly: "every open paid order … starts it, however old the order is".
    - Fix: "Every open paid order with an item that carries the tag starts it, however old the order is."

13. **States and badges**: "the strip counts the four between No workflow and Made."
    - "between" reads as exclusive (two positions), and the strip also has Issues.
    - Evidence: `STRIP` in `app.orders.index.tsx`.
    - Fix: "the strip counts No workflow, Not started, Making and Made."

14. **Finding your work** ("A blocked item is listed here, not under Started or Ready.") and `LIST_FILTER_ROWS.blocked` (same words)
    - No filter is called "Started". The labels are Started by you and Started by others (`STATE_LABEL` in `src/lib/workflowsListStates.ts`).
    - Fix: "A blocked item is listed here, not under Started by you, Started by others or Ready."

15. **Finding your work**: "search by its order number or by the item's name, variant or SKU."
    - Reading the orders list says "the start of a word in an item's title, variant or SKU". The vocabulary's search row says "item title".
    - Fix: "search by its order number, or by the start of a word in the item's title, variant or SKU."

16. **Finding your work**: "The **Show 25 more** button at its foot loads the next 25."
    - The bold label is not what the screen prints.
    - Evidence: `src/components/screen/ShowMore.tsx`: `` `Show ${…min(page, hidden)} more of ${…hidden}` `` prints "Show 25 more of 40", and fewer than 25 near the end.
    - Fix: "A **Show more** button at its foot, which says how many are left, loads up to 25 more."

17. **Reading an order**: "When Shopify closes the order while an item's workflow is still open, or you cancel a workflow, the item reads **Closed**…"
    - The reasons listed next include "item removed or refunded in Shopify", which closes a workflow on an open order. The opening clause leaves that case out.
    - Fix: "When Shopify closes the order or removes the item while its workflow is still open, or you cancel a workflow, the item reads **Closed** and the line under it says why:"

18. **Signing in**: "If a store's Baton subscription is not active, its workflows are unavailable until the merchant renews it."
    - Plans and billing names the screen: "Members who sign in see **Subscription inactive**". The member's own page does not.
    - Evidence: `src/routes/shop.$shop_.lapsed.tsx`: `const heading = "Subscription inactive"`.
    - Fix: "If a store's Baton subscription is not active, the store reads **Subscription inactive** and its workflows are unavailable until the merchant renews it."

19. **One Shopify screen, four names**:
    - Installing's description: "the plan page".
    - Installing's body: "Shopify shows Baton's plans", "sends you back to the plans".
    - Plans and billing: "Shopify's pricing page", and on the same page "it sends you to the plans" and "the plans say how long it is".
    - Fix: one name. In Installing step 2: "Shopify's pricing page shows Baton's plans. Choose one." In Installing's description: "From the App Store to the pricing page and the trial." Then use "the pricing page" throughout Plans and billing.

20. **Syncing from Shopify, page description**: "When Baton reads orders, Sync from Shopify on an order, and the open-order limit."
    - It leaves out the page's own **Sync open orders** section.
    - Fix: "When Baton reads orders, Sync open orders, Sync from Shopify on an order, and the open-order limit."

21. **Attaching or changing a workflow**: "…has the **Workflow** select under its card instead, the cancelled workflow among the choices."
    - True only while that workflow is still active with steps. The options are active workflows only (`lineItemState`: `other` is "every other active workflow with tasks").
    - Fix: "…has the **Workflow** select under its card instead, with the cancelled workflow among the choices while it is active."

22. **Matching items by product tag**: "If nothing else on the order matches, the order reads **No workflow** on the Orders page."
    - Not if it is unpaid. Attaching gets this right: "or **Unpaid** if it is not paid".
    - Fix: "If nothing else on the order matches, the order reads **No workflow** on the Orders page, or **Unpaid** if it is not paid."

23. **Made, worded differently across pages**:
    - First order: "When the last task of every item's workflow is done, the order reads **Made**."
    - Reading an order: "When every item's workflow is done, a banner…"
    - Reading the orders list (and `orderPosition`): "no item's workflow is open and at least one is done".
    - The first two are wrong for an order with a cancelled or untagged item.
    - Fix (First order): "When no item's workflow is still open and at least one is done, the order reads **Made**."

24. **Installing Baton and choosing a plan** repeats Plans and billing. "What a plan includes" and "The trial" are the reference page's facts, the trial word for word. This is the known follow-up ("Plans and billing may not be wanted as a page"), so it is not a new decision. If both pages stay, cut Installing's bulleted list down to a link to Plans and billing.

## Tone nits, grouped

25. **"The bench" metaphor, which the help rules ban:**
    - Reading the orders list: "The page opens on **Making**, the orders the bench is working on now." Fix: "The page opens on **Making**, the orders members are working on now."
    - Reading an order: "Use them when the bench cannot, such as for a member who is away." Fix: "Use them when a member cannot, such as when they are away."

26. **Labels not in bold:**
    - First order: "the next step's tasks read Ready".
    - Removing and deleting: "find it under Started by others".
    - Recording your work: "moves an order from Not started to Making" and "The task reads Ready again".
    - Blocking an item and leaving a note: "stays Not started".
    - Reading an order: "Baton reads it as Fulfilled".

27. **Spelling:** Syncing from Shopify has "A partial fulfilment". Every other page and Shopify spell it "fulfillment".

28. **"greyed" and "disabled" both used** for one state:
    - "greyed": Syncing ("the button is greyed"), Removing and deleting ("It is greyed for a moment").
    - "disabled": Creating your first workflow, Editing, Turning a workflow on or off.
    - Pick one.

29. **Contractions are mixed**, against the copy tone list ("Contractions, as Shopify's grammar guide asks", `CopySlot` in `src/lib/Screen.ts`). "They don't need a Shopify account" sits beside "does not", "cannot" and "is not" on most pages, around 70 instances. This is a sweep, not a per-sentence fix.

30. **Matching items by product tag**: "When that is, is in Syncing from Shopify." Fix: "When it syncs is in Syncing from Shopify."

31. **Fixing an issue**: "On the Orders page, show **Issues** to list every order that has one."
    - "show" as a verb next to a select named Show is ambiguous. It is also "every open order" (Reading the orders list).
    - Fix: "On the Orders page, press **Issues** on the strip to list every open order that has one."

32. **Words no screen says:**
    - Plans and billing's description: "included allowances". The screen says "included". Fix: "…members, what your plan includes and Manage plan."
    - Finding your work's description and body: "The strip's five states", "counts them by state". States and badges calls the same values "filters, not badges". Use one word. The vocabulary's word for these values is "filter".

33. **Picture against its sentence:** First order puts `findingYourWork2` beside "The first step's tasks show on the Workflows list…". The picture's Ready rows (Engrave and others) are second-step tasks: `recordingYourWork1` shows Cut and sand done before Engrave.
    - Fix: "Each task whose step is current shows on the Workflows list of every member on its team, and reads **Ready**."

34. **Task pages with non-imperative section headings**, against the anatomy table's "heading imperative":
    - Installing: "What a plan includes", "The trial".
    - Creating a workflow: "The Workflows page", "The name and the tag", "What a new workflow is".
    - Fixing an issue: "What an issue is" and the three issue names.
    - Turning a workflow on or off: "Active and Inactive".
    - Every page does it, so it looks deliberate. Either the anatomy row or the headings should move.

## Decisions (2026-10-08)

All 34 items accepted as the reader proposed, with these calls by the user:

- **8b.** Swap Creating your first workflow and Creating a team and adding members in
  `HELP_SECTIONS`, so the team comes first; the Getting started hub description and any "first
  workflow" sentence that assumes the order are updated to match.
- **19.** Shopify's plan screen is "the pricing page" everywhere in help.
- **24.** Installing keeps its plan and trial sections until the Plans and billing question in the
  research's follow-ups is decided.
- **28.** "disabled", not "greyed": a fact about the control, not today's theme. The two
  "greyed" sentences become "The button is disabled while a sync runs" and "Delete is disabled
  for a moment while it runs", or the nearest that keeps the why.
- **29.** No contraction sweep. The research's tone rules note that the copy table's contraction
  rule is for screens; help prose may write "does not" in full.
- **34.** The anatomy table's task row changes from "heading imperative" to a noun heading, which
  is what every task page does; the anatomy's example headings follow.

## Done (2026-10-08)

Every item is in. Bodies are under `src/components/help/`; the paths below are relative to it
unless they start with `src/` or `docs/`.

1. `members/recording-your-work.tsx`: the row's **…** button has **Start** on a ready task, and
   **Done** and **Put back** on a started one. JSDoc names what `menuItems` offers.
2. `src/lib/helpReference.ts` `LIST_FILTER_ROWS.started_by_others`: "Items with a task a teammate
   started." JSDoc says why the merchant is never the starter.
3. `teams-and-members/removing-and-deleting.tsx`: the task reads No team (plain, as `TeamLine`
   prints a line, not a badge), the workflow reads **Needs a team**.
4. `members/finding-your-work.tsx` and `reference/states-and-badges.tsx`: the list holds the
   items whose current task is on one of your (their) teams. JSDoc cites
   `RunRepository.runListItems`.
5. `workflows/creating.tsx`: "A second badge shows when something stops it or is missing:".
6. `workflows/editing.tsx`: "Every task needs a team".
7. `getting-started/how-baton-works.tsx`: "shows each item and the step its workflow is on".
8. `getting-started/installing.tsx`: a paragraph after the steps, "Then, on the Orders page, press
   **Sync open orders** to bring in the open orders placed in the last 30 days. After that, Baton
   reads each new order as it is placed." Departure: "placed in the last 30 days" for "from the
   last 30 days", the sync's query (Syncing's own words), and a second sentence that links it to
   First order's "reads each new order". JSDoc cites `ShopAgent.syncOpenOrders`, whose only
   caller is the button.
   8b. `src/lib/helpPages.ts`: `first-team` now before `first-workflow`; the hub reads "Install
   Baton, create a team and a workflow, and follow the first order through."; `bodies.tsx` map
   reordered to match. `getting-started/first-workflow.tsx`: "Every task goes to a team, so create
   a team first" became "Every task goes to a team, which is why Creating a team and adding
   members comes before this page. Until the shop has a team, the editor says to create one before
   adding steps." `first-team.tsx` and `first-order.tsx` assume no order: First team's "Its tasks
   wait until a member joins" is the empty state's own sentence and stays.
9. `workflows/matching.tsx`: "If you turn one of the two off, delete it, or delete a team one of
   its tasks is on, the other starts on the item." JSDoc adds Delete team to the triggers that
   reconcile (its row on `reconcileItem`: "deleting a team creates the survivor's run").
10. `orders/fixing-issues.tsx`: "Nobody can press **Start**, **Done** or **Put back** on its tasks
    until the block is lifted." Departure: "finish" and "mark done" are both refused by the copy
    lint, so the sentence names the three buttons. `taskActions`' blocked row is blank under start,
    done and putBack; the JSDoc now says Start too.
11. `workflows/matching.tsx`: "two active workflows".
12. `getting-started/first-workflow.tsx`: "Every open paid order with an item that carries the
    tag starts it, however old the order is."
13. `reference/states-and-badges.tsx`: "the strip counts No workflow, Not started, Making and
    Made" (`STRIP`).
14. `members/finding-your-work.tsx` and `LIST_FILTER_ROWS.blocked`: "not under Started by you,
    Started by others or Ready".
15. `members/finding-your-work.tsx`: "search by its order number, or by the start of a word in the
    item's title, variant or SKU". JSDoc cites `Domain.searchTerm`.
16. `members/finding-your-work.tsx`: "The button at its foot says how many are left, such as
    **Show 25 more of 40**, and loads up to 25 more." Departure: the report's **Show more** is not
    what the screen prints; `ShowMore` prints "Show n more of N", so the bold label is a real
    instance of it. JSDoc cites `ShowMore`.
17. `orders/order-page.tsx`: "When Shopify closes the order or removes the item while its workflow
    is still open, or you cancel a workflow, …".
18. `members/signing-in.tsx`: "the store reads **Subscription inactive** and its workflows are
    unavailable" (the lapsed page's section heading).
19. "The pricing page" throughout: Installing's description (`helpPages.ts`), its step 2
    ("Shopify's pricing page shows Baton's plans. Choose one."), "sends you back to the pricing
    page", "The pricing page shows the numbers and the rates", and the trial sentence; Plans and
    billing's trial sentence and "it sends you to the pricing page". The trial sentence is still
    word for word on both pages. Both JSDocs say help calls Shopify's plan selection page the
    pricing page.
20. `src/lib/helpPages.ts`: Syncing's description adds Sync open orders.
21. `orders/attaching-a-workflow.tsx`: "with the cancelled workflow among the choices while it is
    active".
22. `workflows/matching.tsx`: "…on the Orders page, or **Unpaid** if it is not paid."
23. `getting-started/first-order.tsx`: "When no item's workflow is still open and at least one is
    done, the order reads **Made**." Also `orders/order-page.tsx`, which the report found wrong but
    gave no fix for: "When the order reads **Made**, with no item's workflow still open and at
    least one done, a banner at the top says every item is done, with a **Fulfill in Shopify**
    link." The banner is drawn on `orderPosition`'s `made` (`app.orders.$orderId.tsx`), and the
    JSDoc says so.
24. Nothing, per the decision.
25. `orders/orders-list.tsx`: "the orders members are working on now". `orders/order-page.tsx`:
    "Use them when a member cannot, such as when they are away."
26. Bolded: First order's **Ready**; Removing's **Started by others**; Recording's **Not started**,
    **Making** and **Ready** again, plus the same paragraph's "moves back to **Not started**",
    which the report did not list; Blocking's **Not started**; Reading an order's **Fulfilled**.
27. `orders/syncing.tsx`: "fulfillment", in the body and the JSDoc.
28. `orders/syncing.tsx`: "the button is disabled while it works" (the Decisions' "while a sync
    runs" is refused by the copy lint's "runs"). `teams-and-members/removing-and-deleting.tsx`:
    "It is disabled for a moment while the page connects", which keeps the real why (Delete waits
    for the socket to identify), where the Decisions' "while it runs" would not be true. The
    "greyed" in the Syncing and Attaching JSDocs became "disabled". The alt texts in
    `src/lib/helpPictures.ts` that say "greyed" are unchanged: an alt text describes what the
    picture shows, which is a greyed button.
29. `docs/help-research.md`, "Tone and naming rules for help": a bullet saying the copy table's
    contraction rule is for screens and help prose may write "does not" in full.
30. `workflows/matching.tsx`: "When it syncs is in Syncing from Shopify."
31. `orders/fixing-issues.tsx`: "press **Issues** on the strip to list every open order that has
    one."
32. `src/lib/helpPages.ts`: Plans and billing's description "…members, what your plan includes
    and Manage plan."; Finding your work's description "The strip's five filters". The body:
    "counts them by filter. Press a filter to list its items." and "A search looks across every
    filter and every team." JSDoc says "five filters".
33. `getting-started/first-order.tsx`: "Each task whose step is current shows on the Workflows
    list of every member on its team, and reads **Ready**." The `findingYourWork2` alt text
    already describes Ready rows of current tasks and needs no change.
34. `docs/help-research.md`, "Page anatomy, by type", task row: "one `s-section` per task or per
    thing the tasks need, heading a noun ("The Workflows page", "What an issue is", "Needs a
    team") or the task's own words ("Create a team")". Departure: the Decisions say every task page
    uses noun headings, but most task sections are headed by their task ("Create a team", "Add a
    step", "Delete a workflow"); the row now states both, which is what the pages do. The anatomy
    has no other example headings to follow.

Checks: `pnpm typecheck` clean; `pnpm lint` clean (oxlint, rules-lint, spec check); `pnpm test`
39 files, 785 tests passed; `pnpm exec playwright test --project=public` 6 passed against the dev
server on 3800. `pnpm fmt` not run, nothing committed.

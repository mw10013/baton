# Plan: the Orders help pages

The next row on the roadmap in `docs/help-research.md`, written 2026-10-08 after 21c7315. Five
page bodies under the Orders section (the hub stays as the skeleton renders it), nine merchant
pictures, and one picture placed again from Workflows. Run the way
`docs/help-teams-and-members-plan.md` was: two builders split by file, then the orchestrator's
pass and review.

The plan was not reviewed before implementation; its decisions are at the end, and the review
comes after, on the Deviations section.

## Before you start

- Read `docs/help-research.md`: "Page anatomy, by type", "Tone and naming rules for help",
  "Screenshots", "Decisions", "Roadmap" (its "Carried into the content stages" list names the
  orders facts decided elsewhere), "How a content cycle runs". Read
  `docs/help-teams-and-members-plan.md` whole: this plan has the same shape, and its Deviations,
  Review and Follow-ups record what the admin forced on the script and what the review changed.
- The code this extends: `scripts/help-screenshots.ts` (`MERCHANT_SHOTS`, the four shapes, the
  overlap check, `openScreen`, `clickHoisted`, `hoistedEnabled`, `cancelModal`, `clickMenuItemIn`,
  `openRow`, `openOrder`, `orderWith`, `parkPointer`, `awaitNavigated`, `--section`),
  `src/lib/helpPictures.ts` (the nine `orders/*` entries are already in, with provisional
  `aspectRatio` and alt text, marked "Provisional until shot" in their comments),
  `src/components/help/bodies.tsx`, the bodies under `src/components/help/workflows/` (`matching.tsx`
  and `managing.tsx` are the templates), `test/integration/help-pages.test.ts`,
  `e2e/help.public.spec.ts`.
- The admin drivers: `e2e/app.ts` (`gotoApp`, `appFrame`, `openScreen`, `clickHoisted`,
  `hoistedEnabled`), `e2e/hydration.ts`, and the locators in `e2e/orders.spec.ts` (the strip's
  cells are buttons named `<label>, <count>`; the Show select is the combobox "Show"; the Team
  select is the combobox "Team"; the search is the searchbox "Search"; a row link is the order's
  name, `#1235`; the order page's title-bar buttons are hoisted: "View in Shopify" and "Sync from
  Shopify"; each item card is an `s-section` with the item's heading; "Manage" is a button in the
  card that opens a drawer in the card, not a modal; the modal ids are `change-workflow`,
  `cancel-run`, `assign-task`, `run-note`, `run-block`; the Cancel workflow modal's dismiss is
  **Keep workflow**, not Cancel; the team page's More actions is `s-menu#team-actions` and its
  Delete modal is `s-modal#delete-team`). Copy a locator into the script; do not import a spec.
- The merchant screens the pages describe: `src/routes/app.orders.index.tsx` (the Orders page:
  the strip and `STRIP`, the Show select and `ORDERS_SHOW_LABEL`, the Team select, the search field
  and its placeholder, the columns, `emptyText` and `emptyState`, the sync banners, the quota
  banner in `QuotaBanners.tsx`, `ORDERS_PAGE_SIZE`), `src/routes/app.orders.tsx` (`OrdersSearch`),
  `app.orders.$orderId.tsx` (the order page: `renderLineItem`, `runBadges`, `RUN_STATE_BADGE`,
  `renderRun`, `ClosedLine`, `BlockBanner`, `nowLine`, `RunNote`, `unassignedRows`, the Manage
  drawer and `RunSteps`, `workflowSelect`, `MULTI_MATCH_SENTENCE`, the five modals,
  `attachResultMessage`, `assignResultMessage`, the aside sections, the not-found page, the Made
  banner), `src/lib/changeWarning.ts` and `runHasRecord`, `CANCEL_WARNING`,
  `app.orders.from-shopify.tsx` and `extensions/baton-order-link/shopify.extension.toml` (Open in
  Baton), `src/lib/orderSyncConstants.ts` (`ORDER_SYNC_WINDOW_DAYS`); the rules in
  `src/lib/domain/ShopWork.ts` (the JSDoc and tables on `OrderPosition`, `ORDER_POSITION_LABEL`,
  `orderPosition`, `OrderIssue`, `ORDER_ISSUE_LABEL`, `OrderRow.unassigned`, `OrderCounts`,
  `OrdersShow`, `ListOrdersInput.team`, `searchTerm`, `RUN_STATE_LABEL`, `RUN_UNSTARTED_LABEL`,
  `TASK_STATE_LABEL`, `VERB_LABEL`, `ClosedReason`, `RunState`, the `runActions` and
  `taskActions` matrices, the triggers and outcomes tables on `reconcileItem`), the four tables on
  `syncOrder` in `src/lib/domain/Orders.ts`, `ShopLimits` in `src/lib/domain/Platform.ts`
  (`maxOpenOrders`, `orderRetentionDays`), `openOrdersAtCeiling` in `src/lib/domain/Billing.ts`, the
  webhook topics in `shopify.app.toml`. Every claim a page makes is checked against the route or
  the Domain symbol, never written from this plan.
- The copy lint reads `src/components/`: a body may not say "run", "in progress", "finish",
  "finished", "view" (except "View in Shopify"), "tab", "import", "resync", "picker", "staff",
  "attention", "please", "needs a workflow", start a sentence with "Saved" or "Syncing", or join two
  ideas with a semicolon. The text of an `s-link` whose href is under `/help/` is held to the
  unanchored patterns only. Two consequences for this cycle: the order page's badge for a started
  item reads **In progress** and a body cannot print it (say "a blue badge", as the existing alt
  texts do, and record it in Deviations); the showcase's order note on #1235 says "Please" and
  cannot be quoted in a body or an alt text.
- The dev server must be healthy (`pnpm dev:status`). Do not run the whole e2e suite. Every run of
  the script ends with `pnpm seed`.
- Do not run `pnpm fmt` and do not commit. Record every departure from this plan, every problem,
  and every sentence you could not verify, under your own heading in
  [Deviations and issues](#deviations-and-issues).

## The pictures

Nine merchant pictures on the showcase shop. One of them follows a write: the team Packing is
deleted through the admin, which is the only way an order reads **Needs a team**, and the script
puts the showcase back with `pnpm seed --showcase` once the block's last picture is taken. Every
modal is cancelled. `matching1` (order #1211's page with the multi-match sentence and the
Workflow select) is placed again on Fixing an issue.

| name                | file                                | shape | screen and state                                                                                                                                                                                                                                              |
| ------------------- | ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ordersList1         | `orders/orders-list-1.png`          | page  | the Orders page as it opens: Sync open orders in the title bar, the strip with Making chosen, the Show, Team and search row, the 24 Making orders with their Paid, Making and Issues badges and the Shopify icon per row                                      |
| orderPage1          | `orders/order-page-1.png`           | page  | order #1235's page: View in Shopify and Sync from Shopify, three item cards (the walnut board started with a note under it, the journal done, the wall clock not started), their Properties, Edit note and Manage, the Order note and Order details asides    |
| orderPage2          | `orders/order-page-2.png`           | page  | #1235 with Manage open on the walnut board: the workflow's name, each step's tasks with their badges and team · email · time lines, Done and Put back, then Block, Cancel workflow and Change workflow                                                        |
| attachingAWorkflow1 | `orders/attaching-a-workflow-1.png` | page  | order #1218's page (a gift card, no workflow): the item card with the Workflow select reading Choose workflow and a greyed Attach                                                                                                                             |
| attachingAWorkflow2 | `orders/attaching-a-workflow-2.png` | modal | the Change workflow modal on #1206 (Grandma Rose, one step done and one started) with Clock assembly chosen, so the paragraph says what will not carry over and Change workflow is enabled                                                                    |
| attachingAWorkflow3 | `orders/attaching-a-workflow-3.png` | modal | the Cancel workflow modal on #1206: its heading naming the workflow, the item, the sentence on what stops and what stays, Keep workflow and Cancel workflow                                                                                                   |
| fixingIssues1       | `orders/fixing-issues-1.png`        | page  | the Orders page with Show set to Issues, after Packing is deleted: Issues chosen on the strip, the rows with Needs a team (the eight Stamp and bind orders not yet past Pack) and Blocked (#1209, #1216); Multiple workflows match is not there, see Review 1 |
| fixingIssues2       | `orders/fixing-issues-2.png`        | page  | order #1209's page: the Blocked badge beside the blue one, the Blocked banner with ana@example.com's reason and the Unblock button                                                                                                                            |
| fixingIssues3       | `orders/fixing-issues-3.png`        | page  | order #1234's page after Packing is deleted: the journal's card with the line saying Pack needs a team, the Assign team select and the greyed Assign                                                                                                          |

The rows are the shooting order. The Orders block goes **after** the Teams and members block and
**before** the Getting started sub-block that begins with `firstWorkflow1`. The Teams and members
block ends with the Delete modal open on Packing's page, so `ordersList1`'s `take` starts with the
same open-modal guard `firstWorkflow1` uses, and cancels it. The block's last shot is followed by
`pnpm seed --showcase`, so `firstWorkflow1` and every member shot see the showcase as seeded, with
Packing back.

## Phase 1: the script (builder A)

Owns `scripts/help-screenshots.ts`, the nine PNGs, and the `aspectRatio`, alt text and comment of
the nine `orders/*` entries in `src/lib/helpPictures.ts`. Does not touch bodies, the bodies map or
the tests.

1. **Two small helpers.** `dismissModal(frame, name)` presses the named button and waits for no
   open `s-modal dialog`, so `cancelModal` can stay as it is and the Cancel workflow modal's **Keep
   workflow** is reached the same way. An `after` hook on a merchant shot entry (optional, run
   after the shape has written the file) for the reseed, or an equivalent you prefer; say which in
   Deviations. The reseed is `pnpm seed --showcase`, the command the run already uses at its
   start; `runCommand` is there.
2. **The nine shots**, as `take` functions, in the order of the table:
   - `ordersList1`: cancel an open modal if any (the guard); `openScreen(page, "Orders")`; wait for
     the title bar's "Sync open orders" enabled (`hoistedEnabled`, so it is not greyed) and for the
     row link "#1203" (the oldest Making order) or whichever row is last; `parkPointer`; shape
     page. 24 rows, one page, no pager. Record the height.
   - `orderPage1`: `openRow(page, "#1235")`; wait for the aside heading "Order note" and the
     hoisted "Sync from Shopify" enabled; shape page.
   - `orderPage2`: press **Manage** in the first item card (the walnut board, `s-section:not([slot])`
     first, or filter by its heading); wait for the heading "Cut, engrave and oil workflow" and for
     the card's **Done** button enabled (the verbs are `disabled` until the socket identifies);
     shape page.
   - `attachingAWorkflow1`: `openOrder(page, "#1218")` then `parkPointer`; wait for the combobox
     "Workflow" in the item card and "Sync from Shopify" enabled; shape page.
   - `attachingAWorkflow2`: `openOrder(page, "#1206")`; press **Manage**; wait for **Change
     workflow** enabled and press it; in `s-modal#change-workflow` choose the option labelled
     "Clock assembly" in the combobox "Workflow" (`selectOption`, which works headless though the
     list does not render); wait for the modal's paragraph to contain "anyway?" and its "Change
     workflow" button enabled; shape modal.
   - `attachingAWorkflow3`: `cancelModal`; press **Cancel workflow** (Manage is still open); wait
     for `s-modal#cancel-run`'s text "Steps already done stay on record."; shape modal.
   - `fixingIssues1`: `dismissModal(frame, "Keep workflow")`; `openScreen(page, "Teams")`;
     `openRow(page, "Packing")`; `clickMenuItemIn(frame, "team-actions", "Delete")`; wait for
     `s-modal#delete-team`'s Delete enabled and press it; wait for `s-page[heading="Teams"]` and
     `awaitNavigated` (the toast is hidden by style). Then `openScreen(page, "Orders")`; choose
     "Issues" in the combobox "Show"; wait for the URL to carry `show=issues`, `awaitNavigated`,
     the row link "#1211" and the badge text "Needs a team"; `parkPointer`; shape page. Expect 11
     rows: two Blocked, one Multiple workflows match, eight Needs a team (#1213, #1219, #1221,
     #1222, #1234, #1238, #1239, #1240). Record the rows seen.
   - `fixingIssues2`: `openRow(page, "#1209")`; wait for `s-banner[heading="Blocked"]` and its
     **Unblock** enabled; shape page.
   - `fixingIssues3`: `openOrder(page, "#1234")` then `parkPointer`; wait for the text "Pack:
     assign a team." and the select "Assign team"; shape page. After the shape: the reseed.
3. **Run it** with `--section orders`, set the nine `aspectRatio` values from the printed sizes,
   drop "Provisional until shot" from the comments, run again and confirm the sizes hold. Then run
   it once with no flag to confirm the whole set still passes in one page and that the Getting
   started sub-block and the member shots are unchanged after the reseed. Restore the other
   sections' pictures a full run re-shoots with
   `git checkout -- public/assets/help/members public/assets/help/getting-started public/assets/help/workflows public/assets/help/teams-and-members`
   (only the seed's clock differs).
4. **Look at each picture** and rewrite its entry comment and alt text (30 to 60 words, the
   screen's words, what matters named, never "Please" or "run") from what is there, not from this
   plan.
5. Report in Deviations: what each picture shows, anything that reads wrong, every overlay stem the
   check met that the last plans' tables do not list, the height of the two list pictures, and how
   long the pass took with the delete and the reseed in it.

## Phase 2: the five pages (builder B)

Owns `src/components/help/orders/*.tsx`, `src/components/help/bodies.tsx`,
`test/integration/help-pages.test.ts` and `e2e/help.public.spec.ts`. Does not touch the script, the
inventory or the PNGs.

Each body is a component under `src/components/help/orders/<slug>.tsx`, registered in `HELP_BODIES`
as `"orders/<slug>"`, in the Workflows bodies' shape: `s-section` per sub-topic, `Things`,
`s-paragraph`, `NumberedList`, `HelpPicture`, `s-link` by the target page's title; a JSDoc naming
the routes and Domain symbols the page was checked against. Two to four sections a page; a
control's label and a badge's label bold and exact; a screen sentence that is not a control or
badge reported in plain words, not quoted; a member spelled as their email. A number stays on
Limits and Plans and billing (the open-order limit, retention), except the sync window, which the
screen itself prints (the empty state and the not-found page say 30 days). Links to pages with no
body yet (Limits, Plans and billing, States and badges, Who can do what) are still links.

1. **Reading the orders list** (`orders-list`), concept. Lead: the definition of the list (every
   open order Baton has, with where each stands). Sections: the strip and the Show select (the four
   positions in the order an order moves, then **Issues**, which cuts across them; a cell's count;
   choosing a cell sets Show; **Making** is what the page opens on; **Open**, **Unpaid**,
   **Fulfilled**, **Cancelled** and **All** are in the Show select and have no cell; one value at
   a time; the counts are over open orders and follow the Team select only; picture `ordersList1`);
   what each position means (**Unpaid**, **No workflow**, **Not started**, **Making**, **Made**,
   **Fulfilled**, **Cancelled**, one sentence each from the positions table on `OrderPosition`:
   Unpaid and No workflow are the two no-workflow cases split by payment, No workflow also covers
   an item whose workflow you cancelled or Shopify removed, Not started holds orders a member can
   Start, Made becomes Fulfilled on its own when Shopify reports the fulfilment, nothing in Baton
   is pressed for it); each row (Order, Placed, Payment, Status, Issues, Items as units, the
   Shopify icon that opens the order in Shopify; the Issues cell holds one badge per issue and is
   empty when there is none, link Fixing an issue; previous and next pages); the Team select and
   search (**Any team** or a team: an order waiting on that team, its current task on the team and
   not blocked; a team with no members still matches; search by an order number, whole, or the
   start of a word in an item's title, variant or SKU; a search reads every order, closed ones
   too, and sets the filters aside until **Clear search**; the line counting the matches replaces
   the strip). No page says the strip's counts as numbers.
2. **Reading an order** (`order-page`), concept. Lead: what the page shows (each item, its
   workflow and where it stands). Sections: the title bar and getting here (**Orders** breadcrumb;
   **View in Shopify**; **Sync from Shopify**, link Syncing from Shopify; from Shopify's order page,
   **Open in Baton** under its More actions lands here; an order Baton never stored shows a page
   saying it is not in Baton, older than 30 days or deleted); each item (title and variant; units
   and SKU, with units to make against units ordered when they differ; **Removed** when Shopify
   removed it; the properties a customer typed; the badges **Not started**, a blue one once a
   task is started, **Done**, **Closed**, and **Blocked** beside any of them; the line Step k of n
   with the task's name and how long it has been there, or Done with its step count; the note and
   **Edit note**; picture `orderPage1`); Manage (opens under the item: the workflow's name, each
   step with its tasks, **Ready**, **Started** and **Done** with the team, who and when; **Done**,
   **Put back** and **Reopen** on a task, which do what a member's do, link Who can do what;
   **Assign team** on a task; **Block**, **Cancel workflow** and **Change workflow**, link
   Attaching or changing a workflow and Fixing an issue; picture `orderPage2`); the aside and the
   end of the work (**Order note**, the note from Shopify, only when there is one; **Order
   details**: Placed, Payment, Fulfillment, Cancelled; when every item is done a banner says so with
   **Fulfill in Shopify**; when Shopify closes the order the item says why: fulfilled in Shopify,
   cancelled in Shopify, removed or refunded in Shopify, cancelled by you, and the buttons go, Edit
   note stays).
3. **Attaching or changing a workflow** (`attaching-a-workflow`), task. Sections: attach a workflow
   (on an item with no workflow, the **Workflow** select lists the workflows whose tag matches
   first, then the rest; choose and press **Attach**; picture `attachingAWorkflow1`; an unpaid
   order can take one, a cancelled or fulfilled order cannot, nor an item with nothing left to
   make; the item reads **Not started** and the order counts as an order on your plan, link Plans
   and billing); change a workflow (**Manage**, **Change workflow**, choose, the modal says what
   will not carry over, done steps, a block, a note, and says nothing when there is nothing to
   lose; **Change workflow**; picture `attachingAWorkflow2`; an item whose workflow is done can be
   changed too; an item whose workflow ended, closed, is given a new one from the **Workflow**
   select with no modal); cancel a workflow (**Manage**, **Cancel workflow**, the modal names the
   workflow and the item and says work stops, done steps stay on record and another workflow can
   be attached; **Keep workflow** or **Cancel workflow**; picture `attachingAWorkflow3`; the item
   then says cancelled by you, and the order reads **No workflow** when no other item has one; a
   tag match never undoes your cancel, attach by hand; a done workflow has no Cancel, **Reopen**
   its last task instead).
4. **Fixing an issue** (`fixing-issues`), task. Lead: an issue is an item waiting on you, shown on
   the Orders page under **Issues**, one badge per issue on the row; picture `fixingIssues1`.
   Sections: Multiple workflows match (two active workflows match the item's tags, so none started;
   on the order page the item says so and the **Workflow** select lists the matches first; choose
   and press **Attach**; or turn one of the two off or delete it and the other starts; picture
   `matching1` placed again; link Matching items by product tag); Needs a team (a task on no
   team, because its team was deleted; the order page shows a line naming the task, the **Assign
   team** select and **Assign**; picture `fixingIssues3`; the workflow itself shows **Needs a
   team** on the Workflows page until you assign a team in the editor and apply, link Editing steps
   and tasks; a task someone already did keeps its team); Blocked (a member or you pressed Block;
   the item shows **Blocked** and a banner with the reason and who, link Blocking an item and
   leaving a note; **Unblock** clears it; to block yourself: **Manage**, **Block**, a reason,
   **Block**; a block does not move the order's position; cancelling or changing the workflow
   clears the block too; picture `fixingIssues2`).
5. **Syncing from Shopify** (`syncing`), concept. Lead: Baton keeps a copy of each open order and
   Shopify tells it when one changes. Sections: how orders arrive (Shopify tells Baton when an
   order is created, paid, cancelled, fulfilled or edited, and Baton reads the whole order each
   time; what it follows: paid starts the workflow, cancelled or fulfilled ends every open one on
   it, an edited quantity resizes the item or removes it; what it does not: a partial fulfilment,
   an archived order, a refund that leaves the quantity, a product retagged in Shopify until its
   order is read again, link Matching items by product tag; nothing is ever removed by a sync,
   orders leave by retention, link Limits); Sync open orders (on the Orders page; reads the open,
   unfulfilled orders of the last 30 days and adds what Baton lacks; press it after installing, or
   when the banner says new orders stopped syncing; one at a time, and the page shows when it is
   running and the last error; an order already in Baton is updated, never doubled); Sync from
   Shopify on an order (reads that one order now; press it when Shopify shows the order closed and
   Baton shows it open, or when an edit has not arrived; if Shopify no longer has the order a
   message says so and Baton keeps its copy); the open-order limit (past the limit no new order is
   stored; the Orders page says new orders stopped syncing; fulfill or cancel orders in Shopify,
   then **Sync open orders**; the number is on Limits, link it).

Check every sentence against the screen and the Domain symbol. Where a sentence and the screen
disagree, the screen wins and Deviations records it.

### Tests

The existing tests cover the new entries and bodies (inventory equals files, every picture placed,
alt length, aspect ratio, the e2e walk over `HELP_BODIES`). Add nothing unless a body needs it;
run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm exec playwright test --project=public`
and record the result. Until builder A's pictures exist, three tests fail on the missing files;
say so rather than skipping.

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `pnpm exec playwright test --project=public`
  green; the dev store ends on the dev fixture.
- `pnpm help:screenshots --section orders` run twice leaves the same sizes; a run with no flag
  passes and leaves the other sections' pictures equal but for the clock.
- `pnpm fmt` repo-wide at the end, by the orchestrator.

## Decisions

Taken 2026-10-08 while writing the plan, without review; the review is on the result.

1. **The hub has no body.** As in the last three cycles.
2. **The list is pictured as it opens, on Making**, 24 rows tall, rather than on a shorter
   filter. The picture's job is the page the merchant sees first. The review decides whether the
   height is too much for the column.
3. **Packing is deleted for Needs a team**, through the admin, the way the fixture intends ("the
   team a screenshot pass deletes"); the block reseeds the showcase after its last picture so no
   later picture sees it. The Teams and members cycle's decision 2 deferred this delete to here.
4. **The Issues list is shot after the delete**, so one picture carries all three issue badges,
   and it is placed on both Reading the orders list and Fixing an issue. Reversed in part by the
   review: the delete ends the multi-match, so the picture carries two badges (Review 1).
5. **Syncing from Shopify has no picture.** Sync open orders is in `ordersList1`'s title bar and
   Sync from Shopify in every order page picture; neither opens a modal, and pressing either
   writes to the store.
6. **No picture of Shopify's own order page** for Open in Baton. The research's exception row
   allows one, but it needs a real order synced into Baton, which no pass does, and a fifth
   shape. Reading an order says it in a sentence.
7. **#1235 is the order pictured** for Reading an order: three items in three states, a note on
   one, an order note. **#1206** (Grandma Rose, the Getting started order) carries the two modals.
   **#1218** (a gift card) shows the Workflow select at rest; its select lists every active
   workflow since nothing matches it.
8. **"In progress" is not printed.** The lint refuses it and the badge says it. The body says "a
   blue badge" where the alt texts do; the review takes up whether the badge should read
   something the help can say.
9. **The 30-day window is said; the ceiling and retention numbers are not.** The screen prints the
   window on two pages; the other numbers are on Limits.
10. **Counts are never written as numbers** on the list page, as the strip changes.

## Deviations and issues

(filled in by the builders, one heading each)

### Script and pictures

Phase 1, builder A. Files touched: `scripts/help-screenshots.ts`, the nine
`public/assets/help/orders/*.png` (new), the nine `orders/*` entries in `src/lib/helpPictures.ts`
(aspect ratio, alt text, comment; "Provisional until shot" dropped). Nothing else.

**The script**

- **`dismissModal(frame, name)`** presses the named button and waits for no open
  `s-modal dialog`; `cancelModal` is now `dismissModal(frame, "Cancel")`. The guard both
  `ordersList1` and `firstWorkflow1` start with is a helper, `cancelOpenModal(page)`, so the
  guard is written once.
- **The reseed is an `after` field on a merchant shot entry**, an Effect (`reseedShowcase`, the
  same `runCommand("pnpm", ["seed", "--showcase"])` the run starts with), yielded in
  `shootMerchant`'s loop after the shape has written the file. Only `fixingIssues3` has one.
- **`itemCard(frame, title)`**, copied from `e2e/orders.spec.ts`. The card's heading is the
  item's title **and variant** ("Engraved cutting board — Walnut", "Gift card — $50"), not the
  title alone. The plan's "filter by its heading" with the title alone found nothing (first run).
- **`openModalBy(control, modal)`: Change workflow and Cancel workflow are pressed with a native
  `click()`, retried until the modal's `dialog[open]` shows.** Not in the plan. Playwright's
  `click()` on either button in the Manage drawer reported success and opened nothing, every time
  it was tried: Change workflow in two runs (once plain, once retried in a `toPass` for 20 s),
  Cancel workflow in one. A probe found the app frame on top at the button's
  centre (`elementsFromPoint`: `IFRAME._WebFrame_…`), so no admin overlay took the click. I did
  not find why; the e2e spec presses the same buttons with `click()` in a 1280 × 720 default
  window. A native click opens the modal on the first try.
- **`awaitFrameButton(scope, name)`**: `toBeEnabled()` on an in-frame button, used for Done in
  the drawer (the verbs wait on the socket), Change workflow, the two modals' primary buttons,
  the team's Delete and Unblock.
- **`ordersList1` waits for "#1203"**, which holds: it is the last Making row (its ring was
  removed, its blanket is past step 1). `hoistedEnabled` on Sync open orders, then `parkPointer`.
- **Orders are found by the fixture's helpers, not literal numbers**: `orderWith("Sam and Priya,
14 October")` (#1235, the constant `ORDER_PAGE`), `orderOf("Gift card", "$50")` (#1218),
  `orderWith("Grandma Rose")` (#1206), `orderWith("Smith family")` (#1209), `orderWith("C.O.")`
  (#1234). All five numbers equal the plan's.
- **`fixingIssues1` does not wait for "#1211"**; see the next section. It waits for #1209 and for
  the badge text Needs a team.
- `fixingIssues3` waits for the text "Pack: assign a team." and the combobox "Assign team", as the
  plan says; both are what `unassignedRows` renders.

**Multiple workflows match cannot share a picture with Needs a team**

The plan's `fixingIssues1` (decision 4) expected 11 rows with all three issue badges. After
Packing is deleted the list has 10, and #1211 is not among them. Deleting Packing leaves Stamp and
bind with a task on no team, so it is no longer eligible (`ITEM_MATCHES` in `OrderRepository.ts`
and `workflowIsEligible`: every task must be on a team). The gift set's tags then match one eligible
workflow, Gift set assembly, so the multi-match ends. The strip's counts suggest more: No workflow
went from 2 (in `ordersList1`) to 1 and Not started from 9 to 10. That fits the reconcile all that
follows a change in which workflows are eligible starting Gift set assembly on #1211. I did not
open #1211 to confirm. No state of the showcase shows all three badges at once: Needs a team
requires the delete, and the delete ends the multi-match. I shot the picture after the delete
(Needs a team and Blocked). Multiple workflows match is still pictured on the order page by
`matching1`. **Builder B's Fixing an issue and Reading the orders list must not say this picture
shows Multiple workflows match**; decision 4 needs a review.

**What each picture shows** (sizes in CSS px, the files are twice that)

- `ordersList1` (1056 × 1356, page): title bar Orders with Sync open orders and `…`. The strip
  reads No workflow 2, Not started 9, Making 24 (chosen, grey), Made 4, Issues 3. One row holds
  the Show select (Making), the search field "Search by order number or item" and the Team select
  (Any team). Columns Order, Placed, Payment, Status, Issues, Items, Shopify. 24 rows, #1242 down
  to #1203, every one Paid and Making, Blocked in Issues on #1216 and #1209, #1235 with 3 items,
  the others with 1. No pager. **Height 1356**, the tallest picture in the help.
- `orderPage1` (1056 × 876, page): Orders / #1235, Sync from Shopify, View in Shopify (dark),
  `…`. Walnut board: × 1 · SKU CB-WALNUT, the blue In progress badge, Properties, Engraving text,
  "Step 2 of 3 · Engrave · since 1:13 AM", the note, Edit note, Manage. Tan journal: Done badge,
  Initials S.P., "Done · 4 steps". Oak wall clock: Not started badge, Numerals Roman, "Step 1 of
  2 · 2 tasks". Aside: Order note (the showcase note, which says "Please"), Order details (Placed,
  Paid badge, Unfulfilled). The page foot's "Learn more in Reading an order." link shows under
  the cards.
- `orderPage2` (1056 × 1365, page): the same page with Manage open (chevron up) on the board.
  The grey drawer is headed "Cut, engrave and oil workflow". It shows Step 1: Cut and sand, a grey
  Done badge, "Woodshop · ben@example.com · Oct 8, 1:13 AM". Step 2: Engrave, a green Started
  badge, "Engraving · ana@example.com · since 1:13 AM", then Done, Put back and Assign team (plain
  text). Step 3: Oil and inspect, "Finishing", Assign team. Under a rule are Block, Cancel workflow
  and Change workflow. The journal and clock cards follow, collapsed.
- `attachingAWorkflow1` (1056 × 266, page): Orders / #1218; Gift card — $50, × 1, no badge; the
  row "Workflow [Choose workflow] Attach" with Attach greyed; Order details Placed Oct 3, Paid,
  Unfulfilled; the Learn more link.
- `attachingAWorkflow2` (620 × 250, modal): "Change workflow?", the Workflow select reading Clock
  assembly, "Cut, engrave and oil has 1 of 3 steps done. Change to Clock assembly anyway? That
  work will not carry over.", Cancel, a red Change workflow.
- `attachingAWorkflow3` (620 × 204, modal): "Cancel Cut, engrave and oil?", "Engraved cutting
  board — Maple", `CANCEL_WARNING`, Keep workflow, a red Cancel workflow.
- `fixingIssues1` (1056 × 730, page): the strip reads No workflow 1, Not started 10, Making 24,
  Made 4, Issues 10 (chosen). Show reads Issues. 10 rows: Needs a team on #1240, #1239, #1238,
  #1234, #1222, #1221, #1219, #1213 (#1239 and #1219 Not started, the rest Making), Blocked on
  #1216 and #1209. **Height 730.** The plan's eight Needs a team orders are exactly these.
- `fixingIssues2` (1056 × 506, page): Orders / #1209; walnut board with In progress and a red
  Blocked badge; Engraving text Smith family; the red banner "Blocked", the reason,
  "ana@example.com · just now", Unblock; then "Step 2 of 3 · Engrave" (no "since" while blocked),
  Edit note, Manage.
- `fixingIssues3` (1056 × 438, page): Orders / #1234; Leather journal — Black, In progress,
  Initials C.O., "Step 4 of 4 · Pack", Edit note, then "Pack: assign a team." (regular weight on
  screen, a semantic `<strong>`), the Assign team select (placeholder Assign team) and a greyed
  Assign, then Manage. No Needs a team badge on the page, as builder B's Teams and members notes
  said.

**Reads wrong or slightly off**

- The blue badge reads In progress in four pictures (decision 8): the alt texts say "a blue
  badge".
- `orderPage1` and `orderPage2` show the order note with "Please" in it, as the plan expected. No
  alt text quotes it.
- `fixingIssues2` says "just now" for the block: the seed stamps the block at seed time. Every
  rerun reads the same.
- The order pages show "Learn more in Reading an order." under the cards, `ordersList1` and
  `fixingIssues1` show no such link. Not a problem; noted because the alt texts do not mention it.
- `attachingAWorkflow3`'s top 1 px row shows faint text from the page behind the modal's
  translucent top edge, the same artefact the last plan saw on `addingAMember2`. It cannot be seen
  at display size. Not fixed (it is the shared modal shape).
- The provisional alt texts were wrong in places: `ordersList1` put the Team select and search
  "under the Show select" (all three share one row, Team last); `orderPage2` said "who started it
  and when" for each task (a done task shows who did it and when, a waiting one only its team);
  `fixingIssues1` named Multiple workflows match; `fixingIssues3` said "a bold line" (it is
  regular weight). The provisional ratios were all off (1056/1400 against 1356, 1056/900 against
  876, and so on). The alt texts are 49 to 60 words.

**Overlay stems**

| stem                                                   | what                             | handled by                                                |
| ------------------------------------------------------ | -------------------------------- | --------------------------------------------------------- |
| `_glow_h6i84_131` with `_glow5_`, `_glow6_`, `_glow7_` | unknown admin glow, three layers | nothing (a rerun passed), as the Workflows review decided |

The Workflows plan already lists it. It refused `fixingIssues1` once in eight runs, the shot
right after the team delete (the delete's toast is hidden by style, so the glow may come with it).
The next run passed. No other stem.

**Runs and timing**

- `--section orders`: eight runs. Four failed while the script was being fixed (the heading, the
  Change workflow click twice, then #1211). One passed (merchant pass 19 s, command 28 s). One
  refused on `_glow_`, then two passed with the same nine sizes (16 s and 16 s, command 21 s
  each). The delete, its navigation and the mid-run reseed are inside the 16 s.
- Full run (no flag): the first failed on `matching2` (Workflows block, "stop matching until you
  retag them" not seen in 30 s; a block I did not change, so I took it as the tunnel); the second
  passed: 41 pictures, merchant pass 43 s, command 55 s. Every Getting started, Workflows and Teams
  and members size equals the inventory's. The re-shot getting-started and members pictures
  differed from HEAD by under 0.1 % of their pixels (`magick compare -metric AE`), the clock, so
  the reseed put Packing back before `firstWorkflow1` and the member shots. All four other
  sections were restored with the plan's `git checkout --`.
- Every run ended with the script's own `pnpm seed`; `pnpm dev:status` healthy after.

**Checks**

`pnpm typecheck` and `pnpm lint` green (with builder B's files in the tree as they stood).
`pnpm exec vitest run --project integration test/integration/help-pages.test.ts`: 7 passed (the
inventory equals the files, alt length, aspect ratios, every picture placed). The full `pnpm test`
and the public e2e project are builder B's and were not rerun by me. `pnpm fmt` not run.

**Unverified**

- Why Playwright's click on Change workflow and Cancel workflow opens nothing here. Closed
  2026-10-08, see "The drawer click" below.
- That #1211 got a Gift set assembly workflow after the delete (from the strip's counts only).
  Closed 2026-10-08: it is the Delete team row of the triggers table on `reconcileItem`, pinned
  by the integration test "deleting a team creates the survivor's run on an item two workflows
  had matched", and the strip's counts (No workflow 2 to 1, Not started 9 to 10) are that test's
  outcome on the showcase.
- What `_glow_` is.

### Pages and tests

Phase 2, builder B. Files touched: `src/components/help/orders/orders-list.tsx`, `order-page.tsx`,
`attaching-a-workflow.tsx`, `fixing-issues.tsx`, `syncing.tsx` (new), `src/components/help/bodies.tsx`
(five imports and five entries). The tests needed no change. Every sentence was checked against the
route, component or Domain symbol named in its body's JSDoc. `orderPage1` and `orderPage2` were read
against the prose once builder A had written them, and they agree (Step 2 of 3 · Engrave · since,
Done · 4 steps, Step 1 of 2 · 2 tasks, the Manage drawer's Done, Put back, Assign team, Block, Cancel
workflow, Change workflow).

**Departures from the plan, each from the code**

- **No lead in the body.** A page's lead is its `description` in `src/lib/helpPages.ts`, which I do
  not own, and every existing body opens with an `s-section`. Each definition the plan calls the lead
  is the first sentence of the first section; Fixing an issue has a first section, "What an issue
  is", that holds it with `fixingIssues1`.
- **`fixingIssues1` is placed on Reading the orders list too** (decision 4), in the row section after
  the Issues cell. Phase 2 item 1 named only `ordersList1`.
- **"In progress" is not printed** (decision 8). Reading an order says "a blue badge while the work
  goes on" for `RUN_STATE_LABEL.open`.
- **The Now line says "since when", not "how long".** `nowLine` prints `since <time>` (the earliest
  start among the current tasks), and only once a task is started. A parallel step prints a count of
  tasks, and a done workflow `Done · n steps`; the page says both.
- **Reading an order's Manage section adds that the merchant's own presses read Merchant**
  (`actorLabel`), and that Assign team moves only a task not yet done (`taskActions.assign`). It
  explains Reopen as the member's Undo (`VERB_LABEL.reopen`).
- **Closed is limited to workflows still open.** The plan said "when Shopify closes the order the
  item says why". Reconcile closes only an open workflow; a done one stays Done on a fulfilled order
  (the actions table on `reconcileItem`). The page says "while an item's workflow is still open".
  The Removed badge is `currentQuantity === 0`, so the page says "removed in Shopify, or refunded in
  full".
- **The Workflow select under a closed item is said for a cancelled workflow only.** It shows under a
  closed workflow only on an open order with units to make (`renderLineItem`, `lineItemState`
  `attachable`), which in practice is the merchant's own cancel: `fulfilled` and `order_cancelled`
  close the order, `item_removed` leaves no units. The page says the cancelled workflow is among the
  choices (`lineItemState` includes it).
- **Attach: the unmatched case.** With no active workflow with a step, the item has no select and
  says no workflow matches, pointing to Workflows (`unmatched`). Added in a sentence.
- **Multiple workflows match: "turn off or delete the workflows that should not match. When one is
  left, it starts".** The plan said "turn one of the two off". Two or more can match
  (`multiMatchItems`), and turning one of three off leaves a multi-match.
- **Needs a team: a fix in the workflow does not reach orders already on it.** Run tasks are copies,
  and Apply changes creates workflows only on items with none (the triggers table on
  `reconcileItem`), so the page says to assign a team on each order's page as well. "A task someone
  already did keeps its team" became "keeps the team's name": `deleteTeam` nulls `RunTask.teamId` on
  done tasks too (`update RunTask set teamId = null where teamId = ?` in `WorkflowRepository.ts`);
  only the `teamName` snapshot stays, and Assign is not offered on a done task.
- **Blocked adds that nobody can press Done under a block** (`taskActions`: `done` and `putBack`
  stop under a block; Assign team does not).
- **Syncing: a refund is not followed at once.** `unitsToMake` says an edit or a refund lowers
  `currentQuantity`, but `shopify.app.toml` subscribes no refund topic (create, paid, cancelled,
  fulfilled, edited; `orders/updated` deliberately not). So the page says an edit resizes the
  workflow and a refund that lowers the quantity does the same "the next time the order is read".
  Not verified against Shopify: whether a refund with a restock fires `orders/edited`.
- **Syncing: what "the page shows when it is running".** There is no status line (the comment on the
  head in `app.orders.index.tsx`): the button is greyed while a sync runs (`syncInFlight`) and the
  rows fill. A second press elsewhere gets a toast. The last error is a red banner until the next
  sync starts (the endings table on `syncOrder`: `started` clears it). The page says those.
- **Syncing: the limit banner is on the home page too** (`QuotaBanners` is rendered by
  `app.index.tsx` and `app.orders.index.tsx`). The page says it stays until Sync open orders starts,
  and that at the limit the sync does not start (`Refused`, the "refused at the order ceiling"
  ending), since the banner's remedy is to close orders first.
- **Partial fulfilment says why**: the work goes on until the whole order is fulfilled
  (`unitsToMake`, `orderIsFulfilled`).

**Screen sentences reported, not quoted:** the Order not found page ("This order isn't in Baton. It
may be older than 30 days, or deleted in Shopify."), `MULTI_MATCH_SENTENCE`, the unmatched item's
sentence, the `unassignedRows` line ("<task>: assign a team."), `changeWarning` (as "the modal names
what the item has of these"), `CANCEL_WARNING` (as "work on the item stops, steps already done stay
on record, and you can attach another workflow afterwards"), `cancelHeading`, the `ClosedLine`
reasons (in lowercase prose: fulfilled in Shopify, order cancelled in Shopify, item removed or
refunded in Shopify, cancelled by you), the Made banner ("Every item is done."), the quota banner, the
Sync from Shopify Gone toast ("a message says so"), the sync error banner, the search's match line
(`SearchLine`), and the Properties, Order note and Order details labels except where they are section
headings named as such. Bold is kept for controls and badges: No workflow, Not started, Making, Made,
Issues, Show, Open, Unpaid, Fulfilled, Cancelled, All, Team, Any team, Paid, Multiple workflows match,
Needs a team, Blocked, Clear search, Orders, View in Shopify, Sync from Shopify, Sync open orders,
More actions, Open in Baton, Removed, Done, Closed, Edit note, Manage, Ready, Started, Put back,
Reopen, Assign team, Assign, Block, Cancel workflow, Change workflow, Keep workflow, Workflow,
Attach, Unblock, Reason, Fulfill in Shopify, Order note, Order details. **More actions** is Shopify's
menu on its own order page, not Baton's.

**Found in the code, outside my files**

- `OrdersSearch` in `src/routes/app.orders.tsx` says "an absent `show` is Open". It is Making
  (`OrdersShow`, `ORDERS_SHOW_LABEL`, the index's `SHOW` and `filters`). Stale JSDoc.
- The Open in Baton extension's `description` in `extensions/baton-order-link/shopify.extension.toml`
  reads "Open this order's production runs in Baton". "runs" is a retired screen word. Whether
  Shopify shows that description to a merchant I could not verify. The lint does not read `.toml`.
- `deleteTeam` nulls the team on done run tasks as well as open ones, so "a done task keeps its team"
  (the `assign` bullet on `taskActions`, `TaskDoneError`) holds for the name snapshot, not the id.
  Not a bug a screen shows; noted because the earlier Teams and members prose says "keeps the team's
  name", which is the accurate form.

**Unverified:** whether Shopify fires `orders/edited` for a refund with restock (Syncing's refund
sentence assumes not). The Open in Baton path from Shopify's More actions is from the extension's
target and the route, not a run against a real Shopify order (decision 6). Nothing else.

**Checks.** `pnpm typecheck` green. `pnpm lint` green. `pnpm test`: 778 passed, 3 failed, all three
builder A's in-flight work at the time of the run: "every picture in the inventory is a file…"
(four orders PNGs not yet written), "a merchant picture's aspect ratio is its file's" (provisional
ratios), and "every picture's alt text is 30 to 60 words" (`ordersList1` at 64 words). "every
picture in the inventory is placed by a help page body" passes: all nine `orders/*` entries are
placed. `pnpm exec playwright test --project=public`: 5 passed, 1 failed, the body walk, on
`/assets/help/orders/fixing-issues-1.png` not yet existing. Both need rerunning once builder A's
pictures and entries are final. `pnpm fmt` not run (some new lines exceed the width). `pnpm seed`
not run: nothing I ran writes to the store.

## Review (2026-10-08)

Read both Deviations sections, the nine pictures, the five bodies and the diffs outside the
plan's file lists; ran `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (781) and the
`public` e2e project (6), all green; the store is on the dev fixture. The pictures are clean: no
overlay, toast, hover, black corner or cut control. Every sentence checked against its screen
holds, and the nine alt texts say what the pictures show. The user was away for this review, so
each recommendation was taken as written (the Follow-ups section says which changed code) and
nothing waits on an answer except finding 3, which is a product question.

1. **No showcase state shows all three issue badges at once.** Deleting Packing makes Stamp and
   bind ineligible (a task on no team), so the gift set matches one workflow and #1211 leaves
   the Issues list; the strip's No workflow count drops from 2 to 1 and Not started rises from 9
   to 10, which is Gift set assembly starting on #1211 by the reconcile that follows the delete.
   Decision 4 falls in part: `fixingIssues1` shows Needs a team and Blocked, `matching1` shows the
   multi-match on the order page, and neither body claims more. Recommend accepting as built, and
   noting on the research that a team delete can end a multi-match (the triggers table's Delete
   team row already says so).
2. **`ordersList1` is 1356 CSS px tall**, the tallest picture in the help, since the page opens on
   Making and the showcase has 24 Making orders. The strip, the selects and the first rows are
   what the page needs, and a shorter filter would picture a list the merchant does not open on.
   Recommend keeping it (decision 2) and revisiting only if a reader complains of the scroll.
3. **The item badge reads "In progress", a word the copy lint retires.** Four pictures show it,
   the bodies and alt texts say "a blue badge", and `RUN_STATE_LABEL.open` is not a file the lint
   reads, which is why the screen can print what help cannot. The order's position word for the
   same state is Making. Recommend renaming the badge to **Making** by the vocabulary runbook
   (a vocabulary row, the label constant, the member screens that print it, the tests and the
   pictures that show it), so an item and its order use one word and help can name the badge.
   That is a vocabulary change and the user's call, not a follow-up of this cycle; the bodies
   stay at "a blue badge" until it is made.
4. **The `OrdersSearch` JSDoc says an absent `show` is Open.** It is Making (`OrdersShow`,
   `ORDERS_SHOW_LABEL`, the index's `SHOW`). Recommend one word: Making.
5. **The Open in Baton extension's description says "production runs".** Shopify may show the
   description in the admin's extension listing, and "run" is retired. Recommend "Open this
   order's work in Baton".
6. **The showcase fixture's JSDoc says 38 open orders and four closed.** By `orderIsOpen` it is
   40 and 2: #1203 (a removed ring beside an open blanket) and #1204 (a resized board) are open
   orders with a closed or resized workflow, and `ordersList1` sums to 40. Recommend correcting
   the comment; the docs that repeat the number are the user's.
7. **Blocking an item and leaving a note joins two ideas with a semicolon** after a `</strong>`,
   which the lint's pattern (a word character before the `;`) does not catch. Recommend two
   sentences; the pattern can stay, since the next audit will read the bodies.
8. **Accept the builders' departures**: `dismissModal` with `cancelModal` on it,
   `cancelOpenModal` as the shared guard, the `after` hook carrying `pnpm seed --showcase` on
   `fixingIssues3`, `itemCard` by title and variant, `awaitFrameButton`, and `openModalBy` (a
   native click, retried) for the two drawer buttons that Playwright's click left closed. Why
   the click fails is unverified and does not change the pictures.
9. **Accept the content departures**: no lead in a body (the tree's description is the lead, as
   on every page); Closed only for a workflow still open when Shopify closed the order; the
   Workflow select under a closed item said for a cancelled workflow only; the unmatched sentence;
   "the workflows that should not match" for three or more matches; a fix in the editor not
   reaching items already on the workflow, and a done task keeping the team's name; nobody can
   press Done under a block; a refund followed the next time the order is read (no refund topic
   is subscribed, unverified whether Shopify sends `orders/edited` for one); the greyed button and
   the red banner as what the Orders page shows of a sync; the limit banner on the home page too.
   Each was checked against the code.
10. **Syncing says "30 days" three times** where the screen says it twice (the empty state and
    the not-found page). Recommend leaving it: the window is the one number a merchant must know
    to press Sync open orders at the right time, and decision 9 allowed it.

Nothing else is open.

## Follow-ups (2026-10-08)

Taken by the orchestrator on its own recommendations, the user being away; uncommitted, with
`pnpm typecheck`, `pnpm lint`, `pnpm test` and the `public` e2e project green after them.

1. Accepted as built; the picture table and decision 4 above say what the picture shows.
2. Accepted as built.
3. Done 2026-10-08 on the user's say-so, by the vocabulary runbook: the run-states row's screen
   cell and `RUN_STATE_LABEL.open` read **Making**; the JSDoc paragraph under the task-states
   table says why (one word for the fact that puts an order under Making, and Started stays the
   task's word); "in progress" stays on the retired list, its why column naming Making; the
   stale "member's word" sentence on the constant is gone (no member screen prints `open`);
   Reading an order names the badge and says an item's Making means the order's; the five alt
   texts that said "a blue badge" (`howBatonWorks1`, `orderPage1`, `orderPage2`,
   `fixingIssues2`, `fixingIssues3`) say Making, and those pictures were retaken. Nothing
   asserted the old string but the lint test's own fixture, which stays: it tests the pattern.
4. The `OrdersSearch` JSDoc says Making.
5. The extension's description reads "Open this order's work in Baton".
6. The fixture's JSDoc says 40 open orders and two closed ones.
7. Blocking an item and leaving a note reads "...as **Blocked**. The block does not move..."
   8, 9, 10. Accepted as built; nothing changed.

## The drawer click (2026-10-08)

Two time-boxed investigations after the user asked for the native-click workaround in
`openModalBy` to be understood, not only kept. The first could not reproduce it on the dev
fixture in any variant of device scale factor, window height, overlays, pointer position or
timing, and suspected the Dev Console. An instrumented run on the showcase then reproduced it on
both buttons and showed nothing over the button in either document and the Dev Console below
the window. The second investigation found the cause:

- **A viewport resize leaves a dead input band at the foot of the app frame.** After
  `page.setViewportSize` has grown and restored the window (the page shape does this for every
  picture taller than the window), the frame document receives no `pointerdown`, `mousedown`,
  `mouseup` or `click` for any point under about 716 CSS px of the 800 high window, at every x.
  The admin document receives all four, on the iframe. Before a resize the same click reaches
  the frame and opens the modal, five of five. An SPA navigation does not clear it; a full reload
  does. The two buttons sit at 749.
- **Not the app.** The `s-button` host is the same connected element across two seconds, a
  `MutationObserver` on the frame's body sees nothing until the modal opens, `nowLine` renders
  its time once, and `useLiveQuery` fires nothing here. The DOM and `elementsFromPoint` are the
  same in the working and the failing state. The loss is in the browser's hit test under
  viewport emulation of a page with a cross-origin iframe, which a merchant's browser never
  does. Not tested: a real headed window resize.
- **Kept:** the native click, now with the cause on its JSDoc and without the plain-click
  attempt and probe the instrumented run used. A reload per page-shape picture would also clear
  it and would cost more than it saves.

# Closed runs and the production ladder: implementation plan

Implementation plan for `docs/shipped-vs-fulfilled-research.md`. Every question there is decided (section 8). Read the research first, especially sections 6, 9, 10 and 11: the reasoning there must end up inline in JSDoc, because the research doc will be deleted.

Written 2026-09-25 for an LLM agent. Work on `main`, no branches. Do not commit unless told. After each step: `pnpm typecheck && pnpm lint && pnpm test`. At the end: `pnpm fmt`, keep every file it touches. Record anything that did not go as written in section 14 of this file.

## 1. What this delivers

1. **Shopify events never create a to-do.** The four reconcile flags (`item_removed`, `quantity_changed`, `order_cancelled`, `order_fulfilled`) and Dismiss are gone. A run ends `done` (a person finished the last task) or `closed` (something else ended it, with a reason). A quantity change updates the run and shows a self-clearing badge.
2. **Block is the only flag.** Unblock is the only lift. The member's attention tab holds blocks and nothing else.
3. **Closed runs leave every work list by construction**: the list queries already select `status in ('pending', 'active')`. They appear on the member's Recent tab with their reason.
4. **The ladder is renamed**: To make · Making · Made · Fulfilled · Cancelled. "Shipped" and "Ready to ship" do not appear anywhere. The `shipped` literal becomes `fulfilled`.
5. **The merchant's cancelled marker becomes a closed run**, reason `merchant_cancelled`. `RunStatus` is `pending | active | done | closed`.
6. **`canAttachRun` becomes `orderIsOpen`.**
7. **JSDoc across `Domain`, `WorkflowRunRepository`, `ShopAgent`, routes, components, seeds and tests** is aligned so no sentence mentions a reconcile flag, Dismiss, shipped, or the cancelled marker.

## 2. Decisions this plan makes beyond the research

The research settled the model; these are the calls needed to write code. They are the plan's, not the user's, so list any you change in section 14.

- **Closed runs keep their tasks.** Today the merchant's Cancel run deletes the tasks and leaves a bare marker. Under one `closed` status, every close keeps the tasks as a record (research 11e: "tasks keep whoever finished them"). Cancel run's confirmation modal keeps its warning, reworded: work stops, steps already done stay on record. Nothing deletes tasks except deleting the run row itself (Change workflow, attach onto a closed item, `deleteWorkflow` semantics unchanged).
- **Pending runs on a closing order are closed, not deleted.** One rule for every open run. (Today pending runs are deleted on cancel and fulfil.)
- **Item removed closes the run, open or pending**, reason `item_removed`, when `currentQuantity` reaches zero. A `done` run is left alone as today.
- **Quantity change**: reconcile writes the new `quantity` onto a `pending` or `active` run. On an `active` run it also sets `quantityChangedFrom` to the old value when null (a second change keeps the original "from"). A `pending` run is resized silently. A `done` run is never resized (record of what was made). `quantityChangedFrom` is nulled by `completeTask` on that run. It is never a gate: no action reads it.
- **Closed runs hold the line item's slot** exactly as the cancelled marker did: reconcile starts nothing on an item with any run row. The picker on a closed item offers every workflow as a fresh run and replaces the row (`setRun` today).
- **`closedAt` and `closedReason`** replace `cancelledAt`. `closedReason` is `fulfilled | order_cancelled | item_removed | merchant_cancelled`.
- **Block storage**: `flag`, `flagAt`, `flagDetail` are replaced by `blockedAt integer`, `blockReason text`, `blockedBy text` (JSON `Actor`). No `flag` column remains.
- **The orders index gets a To make button** so the first rung is visible and countable: Open · To make · Making · Made · Fulfilled · All. Open stays the default and means to make + making + made. `ProductionState` gains `to_make` in place of `null`; `productionState` returns a value for every order.
- **Recent** replaces Done today: the same window (`DONE_WINDOW_MS`), listing finished tasks as now plus closed runs, newest first.

## 3. What this does not change

Reconcile's matching and start rules, ambiguity, the workflow editor, teams, billing, the open-run ceiling, the order sync, webhooks, GraphQL documents, the Change workflow modal, the Reassign modal, the note, Block and Unblock as writes, the member page layout beyond what section 9 lists.

## 4. Prerequisites

- Schema edits go into the initial DDL in `src/lib/ShopAgent.ts` in line. No migration: the user resets every Durable Object and local state after schema changes. Say so in the final report.
- `pnpm port` gives the dev port. E2E runs headless with `npm run test:e2e --`.
- To look at rendered pages use either `pnpm playwright-cli --session="$(pnpm port)-closed" open ...` or the Chrome DevTools MCP (`mcp__chrome-devtools__navigate_page`, `take_snapshot`, `take_screenshot`, `click`). Chrome MCP is easier for the embedded admin because its session is already signed in. Wait for `body[data-hydrated="true"]` before interacting.
- `pnpm seed` seeds a maker/packer shop with lifecycle orders; step 11 updates its fixtures so every new state has an order to look at.

## 5. Step 1. Domain: statuses, reasons, block, quantity

All in `src/lib/Domain.ts`. Keep the file's header contract: one definition per rule, predicates everywhere else, `scripts/rules-lint.ts` unchanged and still passing.

1. `RunStatus = ["pending", "active", "done", "closed"]`. Rewrite its JSDoc as the one place the run lifecycle is stated. Put the research 11g paragraph in it verbatim as the merchant-facing statement, then the gate table, rewritten for `closed`:

   | action                               | gate                                                           |
   | ------------------------------------ | -------------------------------------------------------------- |
   | Start, Done                          | `runIsOpen`, task ready, not `runIsBlocked`                    |
   | note                                 | always (a note is a record)                                    |
   | Block, Unblock, edit reason          | `runIsOpen`; Unblock and edit reason only while `runIsBlocked` |
   | Put back                             | `runIsOpen`, task started and ready, not blocked               |
   | assign a task's team                 | `runIsOpen`, task open                                         |
   | Cancel (close, `merchant_cancelled`) | `runIsOpen`, order open                                        |
   | Reopen a finished task               | `runIsOpen` or `runIsDone`, order open; see `undoBlockedBy`    |
   | reconcile resizes                    | `runIsOpen`; badge only if `active`                            |
   | reconcile closes                     | `runIsOpen`                                                    |
   | holds the line item's slot           | always, `done` and `closed` included                           |
   | replaced by a manual attach          | `runIsOpen` or `runIsClosed`; a `done` run is a record         |
   | counts against the shop ceiling      | `runIsOpen`                                                    |

2. `ClosedReason = ["fulfilled", "order_cancelled", "item_removed", "merchant_cancelled"]` with a JSDoc table: reason, who sets it, what the member's Recent line and the merchant's card say.
3. Delete `RunFlag`, `RunFlagDetail`, `runIsFlagged`, `flagIsReconcile`, `dismissAcceptsQuantity`, `alreadyFlaggedQuantity`, `DismissFlagInput`, `runIsCancelled`. Add `runIsClosed`. Keep `runIsBlocked` as `run.blockedAt !== null`.
4. `WorkflowRun`: drop `flag`, `flagAt`, `flagDetail`, `cancelledAt`. Add `blockedAt: NullOr(Number)`, `blockReason: NullOr(BlockReason)`, `blockedBy: NullOr(fromJsonString(Actor))`, `quantityChangedFrom: NullOr(Number)`, `closedAt: NullOr(Number)`, `closedReason: NullOr(ClosedReason)`. JSDoc on `quantityChangedFrom` states the rule from section 2 and why it is not a gate.
5. Rename `canAttachRun` to `orderIsOpen`; JSDoc: closed means Shopify cancelled or fully fulfilled it, nothing to do with workflows attached. Keep `isCancelled`, `isFulfilled`, `canStartRuns`. On `unitsToMake`, add the Q7 sentence: partial fulfillment is deliberately ignored; a line fulfilled ahead of the order stays work until the order is `FULFILLED`.
6. `RunCounts`: `open`, `done`, `blocked`, `closed`. Drop `flagged`, `cancelled`. `runCounts` follows.
7. `ProductionState = ["to_make", "making", "made", "fulfilled", "cancelled"]`. `productionState` returns `ProductionState`, never null: cancelled, then fulfilled, then no open and no done run is `to_make`, any open run is `making`, else `made`. Note in JSDoc that an order whose runs are all closed reads `to_make`, which is right: nothing is being made and the item may take a new workflow. `OrdersStatus` = `ProductionState | "all"`; `null` stays "open work" (to make + making + made) and its JSDoc keeps the retention reasoning.
8. `OrderNeed = ["no_workflow", "choose_workflow", "team", "blocked"]`. Drop `changed`. `no_workflow` reads `runs.closed === 0` where it read `runs.cancelled === 0`. `OrderCounts` gains `to_make`, loses `changed`.
9. `RunActions = { note, block, editReason, unblock, cancel, changeWorkflow }`. Rewrite the matrix:

   | State \ action        | note | block | editReason | unblock | cancel | changeWorkflow |
   | --------------------- | ---- | ----- | ---------- | ------- | ------ | -------------- |
   | open, not blocked     | M m  | M m   |            |         | M      | M              |
   | open, blocked         | M m  |       | M m        | M m     | M      | M              |
   | open, nothing to make | M m  | M m   |            |         | M      |                |
   | done                  | M m  |       |            |         |        |                |
   | closed                | M m  |       |            |         |        |                |
   | order closed          | M m  |       |            |         |        |                |

   Every blank explained inline as now. Note: `cancel` on a closed order is blank because reconcile has already closed every open run; there is nothing to cancel.

10. `TaskActions`: unchanged shape. `workable` reads `!runIsBlocked(run)` where it read `!runIsFlagged`. Matrix rows say "blocked" not "flagged".
11. `LineItemState`: kind `cancelled` becomes `closed` (`run`, `options`, `matched`, `startable`). JSDoc: one card per reason is not needed; the reason is a line of copy.
12. `tierOf`: a blocked run is `attention`; otherwise as today. `RunTab` JSDoc: the attention tab holds blocks only. `TAB_LABEL.done` becomes "Recent" (in `runTabs.ts`); the `done` key stays.
13. `DoneItem` becomes `RecentItem = Union([{ kind: "task", run, task, undoBlockedBy, order }, { kind: "closed", run, order }])`. JSDoc: what Recent is for ("what left my lists lately") and why closed runs belong there.
14. Seed: `SeedProgress.blocked` stays. `SeedOrderChange` keeps `cancelled` and `fulfillmentStatus`; JSDoc now says these produce closed runs. `SeedProgress.cancelled` (Cancel run as merchant) stays and produces `merchant_cancelled`.
15. `Domain.ts` header: replace the paragraph on flags and the "Undo was allowed by the write and hidden by one of three pages" story with the research 7 lesson in two sentences: the tables cover buttons; rows leaving lists is the status, so there is one rule for both.

## 6. Step 2. `ShopAgent` DDL

In the `WorkflowRun` DDL: `status` check gains `closed`, loses `cancelled`; drop `flag`, `flagAt`, `flagDetail`, `cancelledAt`; add `blockedAt integer`, `blockReason text`, `blockedBy text`, `quantityChangedFrom integer`, `closedAt integer`, `closedReason text check (closedReason in ('fulfilled', 'order_cancelled', 'item_removed', 'merchant_cancelled'))`. Keep the partial index on open runs. Any index on `flag` goes.

## 7. Step 3. `WorkflowRunRepository`

- `reconcileOrder`: the cancelled and fulfilled branches each call one new `closeOpenRuns(orderId, reason, now)` that sets `status = 'closed', closedAt, closedReason` on every `pending` or `active` run, and returns the count. Delete `removePending` and `flagActive`. The zero-units branch of `adjust` closes with `item_removed` instead of flagging. The quantity branch resizes as section 2 says. Delete `flagQuantityChanged` and the "already told" check.
- `cancelRun`: `closed`/`merchant_cancelled`, tasks untouched, `blockedAt` and friends cleared. Refuses unless `runIsOpen` and the order is open (`orderIsOpen`), matching the matrix.
- `blockRun` / `setBlockReason` / new `unblockRun` replace `dismissFlag`. `unblockRun` nulls the three block columns; keeps `requireReadyTeam`.
- `completeTask`: also `set quantityChangedFrom = null` on the run.
- `listRuns`: unchanged in shape; the flag-first ordering becomes blocked-first. Confirm the status filter already excludes `closed`.
- `listDone` becomes `listRecent`: union of finished tasks and closed runs with `closedAt` in the window, newest first, decoded to `RecentItem`.
- `setRun` (manual attach): replaces a `closed` row as it replaced a `cancelled` one.
- Reconcile counts: return `{ started, resized, closed }` in place of `removed`/`flagged`; update `ReconcileCounts` and every log line (`step=` fields per AGENTS.md logging rules).
- JSDoc: `reconcileOrder`'s long comment is rewritten around "close, never flag"; remove every "flagged", "Dismiss", "marker" sentence in the file.

## 8. Step 4. `ShopAgent` callables

- Delete `memberDismissFlag`, `merchantDismissFlag`. Add `memberUnblockRun`, `merchantUnblockRun` with `RunIdInput`, gated by `runActions(...).unblock`.
- `merchantCancelRun` gated by `runActions(...).cancel` (now false on a closed order).
- `listRuns` counts unchanged; `listDone` callable becomes `listRecent`.
- Every `NotAllowed` check reads the renamed fields. Log messages: no `flag=` fields remain.

## 9. Step 5. Pages

**Orders index (`app.orders.index.tsx`, `app.orders.tsx`)**

- Status buttons: Open · To make · Making · Made · Fulfilled · All. Counts for to_make, making, made through the partial index as today; Fulfilled and All carry none. `?status=` accepts the new literals; old values fall back to open work through `lenientSearchKey` (verify).
- Badges: To make (neutral), Making (info), Made (success), Fulfilled (neutral), Cancelled (critical). Column header "Workflows" becomes "Production".
- Needs row: drop Changed. Empty states reworded ("No orders have been fulfilled yet." stays).
- The `OrderRepository.listOrders` SQL restates the new branches; its "must move with it" comments point at the renamed functions.

**Order page (`app.orders.$orderId.tsx`)**

- No page-level banner on a closed order. The sidebar's Fulfillment and Cancelled lines carry it. Keep the `made` banner: "Every run is done. Fulfil this order in the Shopify admin." Drop the "will show as Shipped" clause.
- Run badge: Not started · In progress · Done · Closed. A closed run shows one line under the badge: `CLOSED_REASON_LABEL[reason]` plus the time, e.g. "Fulfilled in Shopify · 3h ago", "Order cancelled in Shopify", "Item removed or refunded in Shopify", "Cancelled by you". Remove `RUN_FLAG_LABEL`, `flagLabel`, the `FlagBanner` usage for reconcile flags. The block banner stays (`BlockBanner`, renamed from `FlagBanner`, block only, with Unblock and Edit reason).
- Quantity badge: warning tone, "Quantity changed · 3 → 2", on a run with `quantityChangedFrom`, beside the status badge.
- Cancel run: offered only where `runActions.cancel` is true. Modal copy: "Cancel the {workflow} run on {item}? Work on it stops. Steps already done stay on record. You can start another workflow on the item afterwards."
- Closed item card (`lineItemState.kind === "closed"`): the reason line, then the picker when `startable`.
- Remove Dismiss everywhere on the page.

**Member pages (`shop.$shop.index.tsx`, `shop.$shop.workflows.$runId.tsx`, `MemberRun.tsx`, `useMemberRunActions.ts`, `runTabs.ts`)**

- `dismiss` mutation becomes `unblock`; the stale-write toast copy loses the "flagged just now" branch.
- `flagHeading`/`flagBody`/`flagTone` collapse to the block case; rename to `blockHeading` etc. or inline.
- Quantity badge on the row in Mine and Up next and in the work page header, as above.
- Tab label "Recent"; empty text "Nothing finished or closed in the last day." Recent rows: finished tasks as today; a closed run row reads the run's line, then "Closed · Fulfilled in Shopify" (or reason) and the time, no buttons.
- Work page on a closed run (reached by link): the reason line where the block banner would be; no actions except the note.

## 10. Step 6. Seeds and e2e fixtures

- `api.dev.seed.ts` and `e2e/seed.ts`: `after.cancelled` and `after.fulfillmentStatus` now yield closed runs; `progress.cancelled` yields `merchant_cancelled`. Remove any fixture that expects a flag. Add one order per closed reason and one with a quantity change on an active run so `pnpm seed` shows every state.
- `e2e/orders.spec.ts`, `e2e/member-runs.member.spec.ts`: replace Dismiss expectations with: closed runs are absent from Mine/Up next/Blocked, present on Recent with their reason; the merchant sees the Closed badge and reason line; Cancel run absent on a closed order; the quantity badge appears and clears after the next Done.

## 11. Step 7. Tests

Every rule has a test whose title is the rule. Rewrite or add:

- `domain.test.ts`: `productionState` per rung including all-closed → to_make; `orderNeeds` without changed; `runCounts` with closed.
- `run-actions.test.ts`: new matrices, cell by cell; "a closed run offers only the note"; "cancel is not offered on a closed order"; "every blank cell of the run and task matrices is refused by its callable" against the new callables.
- `workflow-run-repository.test.ts`: "FULFILLED closes every open run, leaves done alone, creates nothing"; "order cancel closes every open run"; "a line at zero units closes its run as item_removed"; "a quantity change resizes an active run and records the original quantity once; completing a task clears it"; "a pending run is resized silently"; "a done run is never resized"; "cancelRun closes with merchant_cancelled and keeps the tasks"; "listRuns never lists a closed run"; "listRecent lists finished tasks and closed runs in the window, newest first"; "a closed run holds the item's slot and a manual attach replaces it".
- `order-repository.test.ts`: index filters and counts per rung; "a fulfilled or cancelled order has no needs and waits on no team".
- `shop-agent-workflows.test.ts`, `shop-agent-callables.test.ts`: unblock callables; dismiss gone.
- `pnpm test` green, `npm run test:e2e --` green.

## 12. Step 8. JSDoc alignment pass

Do this as its own step after the code compiles and tests pass, file by file, reading every JSDoc and comment top to bottom:

- `src/lib/Domain.ts`: header; `RunStatus`; `ClosedReason`; `WorkflowRun` fields; `orderIsOpen`; `unitsToMake`; `ProductionState`; `OrdersStatus`; `OrderNeed`; `OrderRow.waitingOn` (the "flagged leftovers" paragraph goes; a closed order's runs are closed, so the list is empty by the status rule); `productionState`; `orderNeeds`; `RunCounts`; `OrderCounts`; `runActions`; `taskActions`; `LineItemState`; `RunTab`; `tierOf`; `RecentItem`; `SeedProgress`; `SeedOrderChange`.
- `src/lib/WorkflowRunRepository.ts`: `reconcileOrder`, `adjust`, `cancelRun`, `unblockRun`, `listRuns`, `listRecent`, `setRun`, `ReconcileCounts`.
- `src/lib/ShopAgent.ts`: callable comments; the `runActions` enforcement paragraph.
- `src/lib/OrderRepository.ts`: every "restates `productionState`/`orderNeeds`" comment.
- `src/lib/runTabs.ts`, `src/lib/useMemberRunActions.ts`, `src/components/MemberRun.tsx`, `src/components/RunSteps.tsx`, the four routes, `e2e/seed.ts`, `src/routes/api.dev.seed.ts`.
- Grep the tree for `flag`, `Flag`, `dismiss`, `Dismiss`, `shipped`, `Shipped`, `ship`, `cancelled marker`, `marker`, `ready_to_ship`, `in_production`, `canAttachRun`, `DoneItem`, `listDone`, `Done today`. Every hit is either gone, renamed, or a deliberate sentence about Shopify's own fulfillment vocabulary. `refs/` and `docs/` are excluded.
- No JSDoc references `docs/`. Reasoning is inline.

## 13. Step 9. Look, then final checks

1. `pnpm d1:reset` is not needed; the Durable Object state is. Tell the user to reset it.
2. `pnpm seed`, then with Chrome MCP or playwright-cli open the orders index and each status button, one order per closed reason, the member Mine/Up next/Blocked/Recent tabs, and a work page on a closed run. Screenshot each and check the copy against sections 9 and 10 of this plan.
3. `pnpm typecheck && pnpm lint && pnpm test && npm run test:e2e --`.
4. `pnpm fmt`; keep every file it touches.
5. Delete `docs/shipped-vs-fulfilled-research.md` and this plan only when told.
6. Final report: what changed, the state reset the user must do, and section 14.

## 14. Deviations and issues

- `ReconcileCounts` (`WorkflowRunRepository.ts`): kept `created` instead of renaming it to `started`. `ReconcileAllCounts`, the seed and the logs already use `created`. It is now `{ created, resized, closed, ambiguous }`.
- `RunListView.done` is renamed `recent` (`Domain.ts`). The tab key and `counts.done` stay `done`, as the plan says.
- `RunResult` `Flagged { flag }` is now `Blocked` with no fields. `RunFlaggedError` is now `RunBlockedError`.
- New `RunOrderClosedError` (`WorkflowRunRepository.cancelRun`): the repository guard for "order open". `ShopAgent.runResult` maps it to `Terminal`.
- A closed run keeps its note. The plan did not say either way. Cancel run used to clear the note because it deleted the tasks; a closed run is now a record, so the note stays with it. Closing clears the block and the quantity badge (`closeOpenRuns`).
- A quantity change back to the original number clears `quantityChangedFrom` instead of showing "3 → 3" (`reconcileOrder` `adjust`).
- Closed runs keep open tasks, and `readyWhere` ignores run status. Two fixes follow, neither named in the plan:
  - `WorkflowRunRepository.getRunView` marks no task ready on a closed run.
  - `WorkflowRepository.unassignTeam` nulls `teamId` only on open tasks of open runs, so a team delete does not drop a closed run from that team's Recent. The `Team` JSDoc in `Domain.ts` was updated to match.
- New partial index `WorkflowRun_closed_idx (closedAt) where status = 'closed'` in the DDL, which serves `listRecent`.
- `ClosedReason` copy: member wording for `merchant_cancelled` is "Cancelled by the merchant"; the merchant's is "Cancelled by you" (`MemberRun.closedReasonText`).
- The closed item card on the order page renders the run itself: reason line, note, and Manage listing the kept tasks with no buttons. The picker follows when `startable`.
- The work page on a closed run shows an info `s-banner` headed "Closed" with the reason and time, where the block banner would be.
- The orders index badges are the bare rung names from the plan. The old "n active · m done" text on the in-production badge is gone.
- The order card keeps a critical Blocked badge on the title line beside the status badge (`runBadges`), as before; the first pass dropped it and e2e caught it.
- E2E: 65/65 pass after a state reset. `the orders list keeps its filters and page across the order page` failed once in a full run (25 rows expected after Previous) and passed alone and in the next full run; looks timing-related, not this change.
- The step 9 screenshot pass was not done; e2e covers the same states on the order page and the member tabs.

### Review pass (2026-09-25, second agent)

- Checked the diff against sections 1 to 12 and the research's sections 6, 9, 10 and 11. Every decision in section 2 is implemented as written; the deviations above are accurate.
- Did the step 9 screenshot pass with Chrome: orders index (Open · To make · Making · Made · Fulfilled · All, Production column, no Changed need), order pages for `fulfilled` (#1020), `merchant_cancelled` (#1035) and the quantity badge (#1021), the member Recent tab with a closed row ("Closed · Fulfilled in Shopify · 4m ago"), the work page on that closed run (Closed banner, Edit note only), and the Mine row wearing "Quantity changed · 2 → 1". All match sections 9 and 10.
- Fixes made in the pass: the member work page's Closed banner now renders `ClosedLine` instead of restating the reason and time; the member's stale-write copy for `Terminal` says "finished or closed", matching the merchant's; two stale test comments (`canAttachRun`, "marker") and the e2e fixture title "E2E Shipped Ring" were renamed.
- Left as is: the `Domain.ts` header still lists `.flag` among the comparisons `rules-lint` refuses, because the lint regex is unchanged (section 5 says so) and still refuses it.

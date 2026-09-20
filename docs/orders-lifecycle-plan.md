# Orders lifecycle implementation plan

Implements the decisions in `docs/orders-lifecycle-research.md` §12. That document is the reasoning; this one is the work order. Read §5, §6, §9 and §10 of the research before starting. Line numbers below are as of commit `033cf44`; treat them as hints and search by symbol.

Rules for the implementer:

- Follow `CLAUDE.md`. In particular: predicates live in `Domain`, every rule gets a test whose title is the rule, JSDoc carries its reasoning inline and never cites `docs/`, run `pnpm fmt` and keep everything it touches, do not commit.
- Do not fix anything the research marks **moot**; delete it.
- Record every deviation from this plan and every problem hit in §11 at the bottom of this file, as you go, not at the end.
- **Schema changes are made in line, with no migration; the operator resets all local and Durable Object state from scratch.** See §1 before writing any code.

## 0. Scope

Eight pieces, in this order. Each is independently typecheckable and testable; stop and record if one blocks the next.

1. Schema change, in line (notify operator first).
2. API version to 2026-10.
3. Line items: one query at 250, always replace.
4. Drop order-level tags.
5. Retention: 365-day rule; orders index defaults to open.
6. Bulk sync rework: one fixed-query import.
7. Manual attach guard.
8. Quantity increase on a done line.

Then the JSDoc pass (§9) and verification (§10).

## 1. Schema change

**No migration.** The app is a prototype; the operator resets every Durable Object and all local storage from scratch. Edit `"1_initialize schema"` (`initializeSchema`, `src/lib/ShopAgent.ts:430-499`) in place and do not add a second `SqliteMigrator` entry.

Changes to the create-table statements:

- `ShopOrder` (`:434-452`): remove `tags text not null` (`:445`) and `lineItemsComplete integer not null` (`:448`). Keep `lineItemsTruncated`.
- Remove `ShopOrder_closed_idx` (`:455-462`); it served only the 90-day closed-order sweep, which §5 deletes. Add `create index ShopOrder_processedAt_idx on ShopOrder (processedAt)` for the 365-day sweep's `processedAt < ?` scan. Keep `ShopOrder_open_idx`.
- `SyncState` (`:491-499`): columns become `id, lastError, lastCompletedAt`. Remove `workflowId, startedAt, lastFullSyncAt, lastFullSyncWindowStart`. Keep the `insert or ignore` seed row.

`test/apply-migrations.ts` runs the record and needs no change.

**Before running the dev server or any integration test with the changed schema, tell the operator:** "The `ShopOrder` and `SyncState` schema changed. Stop `pnpm app:dev`, then run `pnpm d1:reset` and delete `.wrangler/state` so the Durable Object SQLite is recreated from scratch." Wait for confirmation. Record in §11 when this happened.

## 2. API version to 2026-10

- `src/lib/Shopify.ts:275`: `ApiVersion.July26` → `ApiVersion.October26`.
- `.graphqlrc.ts:7,12`: same.
- Run `pnpm graphql-codegen`; commit nothing, but keep the regenerated `.codegen/` output.
- Run `pnpm typecheck`. Any type change from the schema bump is a deviation; record it.

`shopify.app.toml:17` already says `2026-10`. Nothing else references the version.

## 3. Line items: one query at 250, always replace

Research §6. The single-order query fetches `lineItems(first: 100)` and does not page; the bulk path always has the full set. The merge branch exists only to protect items 101+ on the webhook path. Replace the whole mechanism with one page of 250.

- `src/lib/orderSyncConstants.ts`: delete `ORDER_SYNC_LINE_ITEMS`. `src/lib/OrderSync.ts:180`: use `Domain.ShopLimits.maxLineItemsPerOrder` (250) as the `first` argument. Keep `pageInfo { hasNextPage }` in the selection; it now feeds `lineItemsTruncated` only.
- `OrderSync.ts:60,89`: delete `lineItemsComplete`; `lineItemsTruncated = hasNextPage` (`:61`).
- `src/lib/Domain.ts:1500`: delete `ShopOrder.lineItemsComplete`. Keep `lineItemsTruncated` (`:1510`).
- `src/lib/ShopAgentOrdersStream.ts:204`: delete the `lineItemsComplete: true` field. The cap at `:99-100` and `lineItemsTruncated: truncated` stay.
- `src/lib/OrderRepository.ts` `upsertOrder` (`:823-864`): remove `lineItemsComplete` from insert and update (`:836,853`); the branch at `:862-864` becomes unconditional: delete the order's line items, then `insertLineItems`. Also remove it from the select list at `:464-465`.
- JSDoc on `upsertOrder` (`:207`) and on `OrderSync.ts:119-130`: state the rule once, on `upsertOrder`: "Line items are replaced wholesale on every accepted write. Every fetch path asks Shopify for the first 250, which is the connection maximum and above `maxLineItemsPerOrder`; an order with more is stored truncated and flagged, never merged." Explain why 250 is Baton's ceiling (single-query cost stays under 1,000 points with `variant { id } product { id tags }` per node).
- `src/lib/ShopAgent.ts:1535` (the `lineItems` variable passed into the query): delete.

Tests, `test/integration/order-repository.test.ts`:

- Delete "merges instead of replacing when the fetch was truncated" (`:209`).
- Rename "replaces the line-item set when the write reports it is complete" (`:195`) to "replaces the line-item set on every accepted write" and drop the `lineItemsComplete` setup.
- Add "accepts an equal updatedAt and rewrites the row" (research #20, the tie rule). Same file, next to "leaves the row and its line items alone for an older updatedAt" (`:175`).

Order page: where `lineItemsTruncated` is shown (`src/routes/app.orders.$orderId.tsx`, search `lineItemsTruncated`), the copy must say "Baton tracks up to 250 line items per order. This order has more; open it in Shopify for the full list."

## 4. Drop order-level tags

Research §5. Order-level tags are stored and displayed but never matched; `productTags` on line items is what routing uses and stays.

Delete, in this order so typecheck guides you:

- `Domain.ts:1490` (`ShopOrder.tags`), `Domain.ts:1700` (bulk line schema `tags`).
- `OrderSync.ts:27` (schema), `:86` (`toShopOrder`), `:143` (query selection). Keep `:51` (product tags).
- `src/lib/OrdersBulkRepository.ts:44` (`tags` in the bulk query). Keep `:62` (`product { id tags }`).
- `OrderRepository.ts:464-465, 827, 834, 850` (select, insert, update).
- `src/routes/app.orders.index.tsx:176` (`tagBadges`) and the cell at `:681`; remove the column header with it.
- `src/routes/app.orders.$orderId.tsx:1700` (`fact("Order tags", …)`). Keep the line-item `productTags` line at `:1437-1449`.
- Any test fixture that sets `tags` on a `ShopOrder` (grep `tags:` under `test/`). Line-item `productTags` fixtures stay.

Run `pnpm graphql-codegen` after editing the two `#graphql` strings.

## 5. Retention: 365-day rule; orders index defaults to open

Research §9. One rule replaces three.

### 5a. Sweep

- `Domain.ts:545`: `orderRetentionDays: 90` → `365`. Rewrite its JSDoc: "An order whose `processedAt` is older than this is deleted on the next sweep, open or closed, with or without runs. Baton is a working set, not an archive; Shopify keeps every order. The sweep runs on the bulk path and, at most every `sweepIntervalMs`, on the webhook path; there is no alarm, because a shop receiving no webhooks is not growing." Add a `Domain` predicate `orderExpired(order, now)` if any TypeScript site needs it; the SQL is the enforcer.
- `OrderRepository.sweepExpiredOrders` (`:1588-1650`): predicate becomes `processedAt < ?` (now − 365 days), `limit sweepBatch`. Drop the closed/cancelled/closedAt and `updatedAt` clauses and the `not exists (… run in pending/active)` clause. Before deleting the orders' runs (`:1622-1629`), flag active runs `order_deleted` and cancel pending ones exactly as `WorkflowRunRepository.markOrderDeleted` (`:1479`) does; reuse that function per order id if it is cheap, otherwise inline the same two statements in batch form and `{@link}` it. Keep the orphan-run delete (`:1638-1644`) and `lastSweepAt` (`:1648`).
- `ShopAgent.ts:2020-2024` comment ("quiet shop still ages out"): rewrite per the JSDoc above.

Test: rename "deletes only closed, untouched orders with no live run, plus orphaned runs" (`order-repository.test.ts:1480`) to "deletes any order older than 365 days, open or closed, flagging its runs, plus orphaned runs". Cover: an open 366-day order with an active run is deleted and the run is gone; a closed 364-day order stays; a 366-day order with a pending run is deleted.

### 5b. Orders index defaults to open

Today `state: null` renders "All orders" and `listOrders` filters `1 = 1` (`OrderRepository.ts:1019-1048`, `app.orders.index.tsx:60,80-89,311`).

- Add `"all"` to the `state` search literal set in `app.orders.index.tsx:60`. `null` now means **open**: everything except `shipped` and `cancelled`.
- `OrderRepository.listOrders` `stateFilter`: `Match.when(null, …)` returns the open predicate (not shipped, not cancelled, using whatever expressions the `shipped` and `cancelled` branches already use, negated); `Match.when("all", () => "1 = 1")`.
- Stage strip (`:80-89`): first chip "Open" (`null`), last chip "All" (`"all"`). Keep the rest.
- Add a `Domain` predicate if the open/closed split is computed in TypeScript anywhere for this list (grep `ProductionState` uses in the route); the rules-lint refuses inline comparisons.

Test: in whichever integration test covers `listOrders` state filters (grep `stateFilter` or `listOrders` in `test/integration/order-repository.test.ts`), add "lists open orders by default and everything under all".

E2E `e2e/orders.spec.ts`: the default view no longer shows shipped orders. Check the fixtures the spec seeds; if it asserts a shipped order on the default view, switch that assertion to `?state=all`.

## 6. Bulk sync rework: one fixed-query import

Research §5. Every click runs the same query; the agents SDK is the only run tracker; no window, no reservation, no TTL, no storage guard, no progress.

### 6a. Constants

`src/lib/orderSyncConstants.ts` keeps three exports: `ORDERS_SYNC_WORKFLOW_NAME`, `ORDER_IMPORT_WINDOW_DAYS = 30` (rename from `ORDER_SYNC_WINDOW_DAYS`; used by the query and the tooltip), `BULK_GIVE_UP_MS = 5 * 60_000`. Delete `ORDER_SYNC_OVERLAP_MS`, `BULK_POLL_ATTEMPTS`, `ORDER_SYNC_LINE_ITEMS` (§3). Add a short JSDoc on `BULK_GIVE_UP_MS`: "Ten times the expected duration of an open-work export; when to stop the spinner, not when to expect success. Shopify itself only fails a bulk query after 10 days."

### 6b. OrdersBulkRepository

- `bulkOrdersQueryText` (`:92`) takes no arguments and returns the constant query: `orders(query: "created_at:>='<iso now − ORDER_IMPORT_WINDOW_DAYS>' <OPEN_WORK_FILTER>", sortKey: CREATED_AT)`. Compute the date at call time. Keep `OPEN_WORK_FILTER` and its JSDoc (`:26`) explaining why `-fulfillment_status:fulfilled` rather than `unfulfilled`.
- Remove `tags` from the selection (§4).
- Add `cancel(id)` to the service (`:141`): `bulkOperationCancel(id: $id) { bulkOperation { id status } userErrors { field message } }`. Run `pnpm graphql-codegen`.
- Tests `test/integration/orders-sync-workflow.test.ts:195,203` (`bulkOrdersQueryText`): collapse to one, "the import query is fixed: open, unfulfilled, created in the last 30 days".

### 6c. OrdersSyncWorkflow

Rewrite `run` (`src/lib/OrdersSyncWorkflow.ts:254-416`). Params become `{ shop }` only (`OrdersSyncParams` `:35`). Delete `timedPollStep` (`:99-125`). Keep `bulkIsActive` (`:127`, already treats `CANCELING` as active), `completedBulkUrl`, `pollBulkOrdersQuery`, `ensureSessionProps`, `submitBulkOrdersQuery`, and the `OrdersSyncWorkflowError` class.

Steps:

1. `submit`: `step.do("submit", …)` → operation id.
2. Poll loop: `for (let elapsed = 0; elapsed < BULK_GIVE_UP_MS; elapsed += 5_000) { await step.sleep("poll wait", "5 seconds"); const op = await step.do("poll", …fetch bulkOperation(id)); if COMPLETED → break with url; if FAILED | CANCELED | EXPIRED → throw; }`. Give each `step.do` a unique name per iteration (`poll ${i}`) or the SDK caches the first result. If the loop exits without a url: `step.do("cancel", …bulkOperationCancel(id))` (ignore its errors), then throw `OrdersSyncWorkflowError` with message "Shopify did not finish the export in time. Try again."
3. `stream`: `step.do("stream", …)` with default retries and timeout, calling the agent's `onOrdersStream(url)` as today (`:389` region). Then `step.reportComplete()`.
4. `COMPLETED` with no url means zero orders: call the agent's `onOrdersSyncEmpty` as today (`ShopAgent.ts:1814`) and `reportComplete`.

Errors: unhandled errors auto-report to the agent through the SDK (`_autoReportError`), which calls `onWorkflowError`. Do not wrap.

Tests `orders-sync-workflow.test.ts:44,69,105` (shape tests): update for the new params; add "gives up after five minutes, cancels the Shopify operation, and fails with a merchant message" and "an EXPIRED or FAILED operation fails without cancelling". Mock the Shopify client the way the existing tests do.

### 6d. ShopAgent

Delete: `SYNC_RESERVATION_TTL_MS` (`:1045`), `ordersSyncWorkflowExists` (`:1066`), `orderSyncWindow` (`:1087`), the storage-guard branch in `syncOrders` (`:1642`), and the deterministic-id builder (`:1058`).

`syncOrders` (`:1581-1743`) becomes:

```
if (this.importStarting) return { status: "in_flight" }
const running = this.getWorkflows({ status: ["queued", "running", "waiting"] }).workflows
  .filter(w => w.workflowName === ORDERS_SYNC_WORKFLOW_NAME)
if (running.length > 0) {
  const stale = running.filter(w => olderThan(w, 10 minutes))
  for each stale: await this.getWorkflowStatus(ORDERS_SYNC_WORKFLOW_NAME, w.id)   // refreshes the row from the Workflows API
  if (this.getWorkflows({ same filter }).workflows.length > 0) return { status: "in_flight" }
}
if (cycle at order ceiling) → set lastError as today (":1669" branch), publish, return
this.importStarting = true
try { await this.runWorkflow(ORDERS_SYNC_WORKFLOW_NAME, { shop: this.name }, { agentBinding: SHOP_AGENT_BINDING }) }
finally { this.importStarting = false }
publish("all"); return { status: "started" }
```

Check `getWorkflows` / `getWorkflowStatus` signatures in `refs/agents/packages/agents/src/index.ts` (search `getWorkflows(criteria`). The row's `createdAt` (or equivalent) is what "older than 10 minutes" reads; confirm the column name in `cf_agents_workflows`. Write the JSDoc on `syncOrders` explaining: `runWorkflow` awaits `workflow.create` before inserting its tracking row, so the synchronous `importStarting` flag is what makes two same-tick clicks safe; the SDK never reaps a stuck row, so the 10-minute refresh is Baton's; a throw between `create` and the insert leaves an untracked instance that runs to completion harmlessly because the query is fixed and the upsert idempotent.

Keep `onOrdersStream` (`:1750`), `onOrdersSyncEmpty` (`:1814`), `onOrdersSyncError` (`:1828`). `onWorkflowComplete` (`:1858`): replace `completeSync` with a `setLastCompletedAt(now)` repository call. `onWorkflowError` (`:1886`): replace `failSync` with `setLastError(message)` (the existing lastError-only setter, `OrderRepository.ts:354-361`). Both then `publish("all")`.

Orders view (`:2231-2243`): `syncState` becomes `{ inFlight: boolean, lastError: string | null, lastCompletedAt: number | null }`, `inFlight` derived from `getWorkflows` with the filter above (no refresh here; the loader is read-only).

`Domain.SyncState` (`Domain.ts:1746-1753`) and `Domain.OrdersSyncResult` (`:2125`): update to the shapes above.

### 6e. OrderRepository

Delete `reserveSync`, `completeSync`, `failSync`, `clearSync` (`:313-361`, `:1318-1394`). Keep `getSyncState` (now reads `lastError, lastCompletedAt`) and the `lastError` setter; add `setLastCompletedAt`. `lastFullSyncWindowStart` (`:1334`) goes with the column.

Test `order-repository.test.ts:1545` ("starts idle, reserves, and completes"): replace with "records the last completed import and the last error".

Test `orders-sync-workflow.test.ts:135` ("refuses a second sync while one is reserved"): replace with "refuses a second import while one is tracked as running". `:167` (storage guard): delete.

### 6f. Route

`src/routes/app.orders.index.tsx`:

- Button label (`:534`): "Import open orders". Tooltip / help text: "Imports open, unfulfilled orders from the last 30 days. Safe to run again."
- `syncStatusText` (`:186-200`): "Importing…" while `inFlight`; "Last imported {relative time}" when `lastCompletedAt`; nothing when neither.
- Empty-state copy (`:558`): "No open orders. Import open orders to pull in what is on the bench, or wait for the next order."
- `lastError` banner (`:779-781`): unchanged.
- `decodeSyncState` (`:104`): new shape.
- `ORDER_SYNC_WINDOW_DAYS` import (`:14`) → `ORDER_IMPORT_WINDOW_DAYS`.

E2E `e2e/orders.spec.ts:37` "orders screen syncs the window and lists orders": rename to "orders screen imports open orders and lists them"; the wait regex at `:56-72` becomes `/^(?:Last imported|Importing)/`.

### 6g. wrangler.jsonc

The binding `ORDERS_SYNC_WORKFLOW` / `OrdersSyncWorkflow` (`:49-53, :138-142, :205-209`) is unchanged. Do not rename the class; deployed instances reference it.

## 7. Manual attach guard

Research #6, §12. `ShopAgent.attachWorkflow` (`:3005`) checks `canStart(detail, roster)` (`:3029`) and then `WorkflowRunRepository.setRun` (`:1412`), which checks only for an existing run. Nothing refuses a cancelled or fulfilled order.

- Add `Domain.canAttachRun(order)`: `!isCancelled(order) && !isFulfilled(order)` (`Domain.ts:1560-1568`). JSDoc: "Manual attach is the merchant overriding the tag, activation-date and payment gates on purpose; it is not an override of the order being over. A cancelled or fully fulfilled order has no work left, so attach is refused. Unpaid is allowed: the merchant may start work on a deposit." Payment stays open on purpose.
- In `attachWorkflow`, after the `canStart` check, refuse with a typed error when `!Domain.canAttachRun(order)`. Surface the message on the order page the same way the existing attach errors are shown (search the `attachWorkflow` call in `app.orders.$orderId.tsx`).
- Update the `canStart` JSDoc (`WorkflowRunRepository.ts:164`) to `{@link}` the new predicate.

Test, `test/integration/shop-agent-workflows.test.ts` next to `:582`: "manual attach is refused on a cancelled or fulfilled order and allowed on an unpaid one".

## 8. Quantity increase on a done line

Research #7, §12. `adjust` (`WorkflowRunRepository.ts:1283-1318`) runs over `openRuns` only, so a `done` run never sees a quantity change.

- Extend the set `adjust` iterates to include `done` runs. For a `done` run: on any quantity change (up or down), set the `quantity_changed` flag exactly as `flagActive` does for active runs; do not resize, do not cancel, do not create a run. Implement via a `flagWhere(status in ('active','done'), …)` sibling or by widening `flagActive` (`:1019-1024`); pick whichever keeps one rule in one place, and name it for what it does.
- `Domain.ts:2617,2664` (JSDoc saying a `done` run is never touched): rewrite. Rule: "A `done` run keeps its quantity; a later change on its line item flags it `quantity_changed` so the merchant sees it on the order page and run list. Reopening is the merchant's call through Undo, after which the run is active and ordinary quantity handling applies. No run is ever created for a line item that already has one, `done` included."
- Confirm the order page and run list already render `quantity_changed` on a `done` run (they render flags by run, not by status; verify, and fix the filter if a `done` run's flags are hidden).

Test, `test/integration/workflow-run-repository.test.ts` next to `:914`: "a quantity change on a done line flags the run and changes nothing else". Update `:1172` and `:1274` titles if they assert "leaves done alone" for quantity (they are about fulfilment and cancellation and should still hold).

## 9. JSDoc pass

After §1–§8 compile and pass, do the **doc** rows of research §10 in one pass, against the surviving code: #3, #4, #9, #10, #11, #13, #15, #16, #18, #19, #20, #21. For #21, refresh or delete `docs/limits-and-plans-research.md`, `docs/limits-and-plans-plan.md`, `docs/rules-inventory.md` as their content dictates; then delete `docs/orders-lifecycle-research.md` and this plan (`CLAUDE.md`: research docs go stale). Do the deletion as the very last step, after §10, and only after the operator confirms.

## 10. Verification

In order:

1. `pnpm typecheck`, `pnpm lint` (rules-lint will refuse inline status comparisons), `pnpm graphql-codegen`, `pnpm test`.
2. `pnpm fmt`; keep every file it touches.
3. Local run. After the operator has reset local and Durable Object state (§1): `pnpm app:dev`, then `pnpm seed`. Use Chrome MCP (`mcp__chrome-devtools__*`) or `pnpm playwright-cli` against `http://localhost:$(pnpm port)`; wait for `data-hydrated` before interacting.
   - Orders index: default chip is "Open"; "All" shows shipped orders; no tags column.
   - Click "Import open orders" twice quickly: one import, button disabled, "Importing…", then "Last imported …". Check `logs/server.log` for one `OrdersSyncWorkflow` submit.
   - Order page: no "Order tags" fact; attach on a cancelled order is refused with a message.
   - Home page limits card unchanged.
4. `npm run test:e2e --` for `e2e/orders.spec.ts` at minimum.
5. If the dev store has an order with a `done` run, edit its quantity in Shopify admin and confirm the `quantity_changed` flag appears.

Anything you could not verify, say so in §11 rather than reporting it as done.

## 11. Deviations and issues

The implementer records here, as work proceeds. One entry per item: what the plan said, what was done instead or what went wrong, why, and what the operator needs to decide or do. Include the timestamp of the schema-reset notification (§1) and the operator's confirmation.

Timestamps are local (2026-09-20).

- **§1, schema reset.** Operator notified after §1–§8 were written and `pnpm typecheck` /
  `pnpm lint` / `pnpm graphql-codegen` were clean, before any test run: "the `ShopOrder` and
  `SyncState` schema changed; stop `pnpm app:dev`, run `pnpm d1:reset`, delete
  `.wrangler/state`." Operator confirmed ("Done — run the tests") and `pnpm test` was run
  after that.
- **§1, the new index.** The plan asked for `ShopOrder_processedAt_idx on ShopOrder
(processedAt)`. Not added. The existing `ShopOrder_processedAt` over `(processedAt desc, id
desc)` already serves `where processedAt < ? order by processedAt` — a range scan reads a
  descending index as readily as an ascending one, and `processedAt` is its leading column. A
  second index would cost a write per order for nothing. The reasoning is now a SQL comment
  beside the index. `ShopOrder_closed_idx` was dropped as planned.
- **§5a, flagging runs before the sweep deletes them.** The plan asked the sweep to flag
  active runs `order_deleted` and cancel pending ones, as `markOrderDeleted` does, before
  deleting the order's runs. Not done: the very next statement in the same transaction deletes
  those rows, so the flag would be written and destroyed without ever being read. The flag
  exists so a member sees why their work stopped, which needs a surviving row. The omission is
  documented at the delete.
- **§6c, the error sink.** The plan says unhandled errors auto-report through the SDK and "do
  not wrap". The `Effect.onError` → `onOrdersSyncError` sink is kept, as research §5 specifies
  ("Error sink stays"): it records the merchant-facing message through its own durable step
  _before_ the failure propagates, where the SDK's post-throw notification is best-effort and
  swallowed. Nothing catches or transforms the error; `onOrdersSyncError` lost its `startedAt`
  and now writes `lastError` only. `onWorkflowError` writes the same column from the
  platform's account of the failure.
- **§6a, a fourth constant.** `orderSyncConstants.ts` keeps four exports, not three:
  `BULK_POLL_INTERVAL_MS = 5000` joins them. The give-up bound is wall-clock, so the poll loop
  needs the interval as a named number to derive its step count from — and the test derives
  the number of polls it has to mock from the same two constants rather than hard-coding 60.
- **§6c, `OrdersSyncResult`.** The workflow's `step.reportComplete()` now carries no payload —
  the object knows everything about the run — so `onWorkflowComplete` decodes nothing. The
  name `Domain.OrdersSyncResult` was reused for what `syncOrders` answers the button
  (`started` / `in_flight` / `refused`), as §6d asks. `Domain.OrderSyncField` was deleted with
  the window.
- **§6d, `Domain.SyncState`.** Split rather than widened: `SyncState` is the stored row
  (`lastError`, `lastCompletedAt`) that the repository reads and writes, and
  `Domain.OrdersSyncStatus` is that plus `inFlight` for the orders view, so the DO-only fact
  and the SQLite row are one definition each. `OrdersView.syncState` is the latter, which is
  the shape §6d specifies.
- **§6d, `getWorkflows` filtering.** The SDK's criteria take `workflowName`, so the filter is
  SQL inside the object rather than a `.filter` in TypeScript. The staleness clock is the
  tracking row's `createdAt` (`cf_agents_workflows.created_at`, seconds, exposed as a `Date`).
- **§6e, `clearSync`.** Replaced by `clearSyncError`, called on the way into a new import so a
  banner from the previous one does not outlive it.
- **§8, the flag on a `done` run whose units reach zero.** The plan says "on any quantity
  change (up or down)". Zero is excluded: a `done` run whose line ships has
  `unfulfilledQuantity` 0 by definition, so flagging it would put "Quantity changed 2 → 0" on
  every partially fulfilled order the moment the work succeeded. The rule as implemented — a
  `done` run is flagged when its units differ from its quantity _and_ are not zero — is stated
  on `Domain.RunFlag` and has the test.
- **§8, dismissing the flag.** The order page renders a `done` run's flag (it renders flags by
  run, not by status) but its run-action row is gated on `runIsOpen`, so before this change a
  `done` run could never carry a flag _and_ never needed a Dismiss. It can now, so a Dismiss
  button sits beside the badge for a flagged `done` run; `merchantDismissFlag` already has no
  status gate.
- **§10, `e2e/orders.spec.ts` needed more than the planned rename.** Two problems, both
  uncovered by running it. (a) The status line is now absent on a shop that has never
  imported, where it used to read "Never synced."; `locator.textContent()` on a locator that
  matches nothing does not reject, it _waits_, and this project configures no action timeout,
  so the test burned its whole 180s budget there. It now reads the text through `count()`
  first. (b) The spec chose between the hoisted import button and its empty-state twin by
  counting them once, which races a list that fills underneath it. It now names only the
  hoisted button, which the index slots unconditionally.
- **§10, what was not verified.** Two checks were made against the running dev server rather
  than by hand: the default chip is `Open` (`aria-pressed="true"`) and the index has no Tags
  column, both read off a Playwright page snapshot. Not done: clicking Import twice _in the
  browser_ within one tick (the rule has an integration test, and the server log shows one
  submit per click), and §10.5, editing the quantity of an order with a `done` run in the
  Shopify admin — that needs an order on the dev store in that state and is the operator's to
  do.
- **§10, what was run.** `pnpm typecheck`, `pnpm lint` (oxlint plus `scripts/rules-lint.ts`),
  `pnpm graphql-codegen` against the 2026-10 schema, `pnpm test` (396 passed, 22 files),
  `pnpm fmt`, then `pnpm seed` and the whole local E2E suite (42 passed), not only
  `e2e/orders.spec.ts`. The import was exercised for real twice against the sandbox:
  `logs/server.log` shows one `ShopAgent.syncOrders: status=started` per click and
  `OrdersSyncWorkflow.run: status=complete objectCount=16` about six seconds later each time.
- **§9 / #21, the four documents.** `docs/limits-and-plans-research.md`,
  `docs/limits-and-plans-plan.md` and `docs/rules-inventory.md` are all stale (the plan is
  marked implemented; the research prices a `raw` column that no longer exists and a storage
  guard this change removed; the inventory's line numbers and its `OrderSyncField` row are
  gone). Deletion was put to the operator with that reading and **declined**: all five
  documents, including `docs/orders-lifecycle-research.md` and this file, stay on disk. The
  JSDoc rows of research §10 were done; only the document deletion was not.
- **Review (2026-09-20), two fixes after the implementation above.** (a) A `done` run's
  `quantity_changed` flag returned on every later reconcile because its `quantity` never
  changes: reconcile now skips a `done` run already flagged for the same units
  (`Domain.alreadyFlaggedQuantity`), and Dismiss on that flag writes the reported units into
  `quantity` (`Domain.dismissAcceptsQuantity`), so the change is accepted rather than merely
  hidden. Test: "a dismissed quantity flag on a done run does not return on the next
  reconcile". (b) The stale-row refresh in `syncOrders` left a row whose instance Cloudflare
  reports `instance.not_found`, disabling the button for good; that row is now deleted. Test:
  "a tracked import whose instance is gone is cleared on the next click" — the local
  Workflows shim prints an `instance.not_found` uncaught-exception line and a workerd "code
  had hung" notice for it; the test passes. The `orderRetentionDays` JSDoc no longer claims
  the sweep flags runs before deleting them.

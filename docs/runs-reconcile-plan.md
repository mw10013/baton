# Plan: runs and reconcile (slice F)

Implements `docs/runs-reconcile-research.md` (settled 2026-10-18, Q1–Q16) under `docs/legacy-port-research.md` §0.1 (A1–A3), §0.2 (naming by role) and §0.3 (member routes). Read the research's §0, §1.0, §1.3 and §4 first; this plan does not restate the reasons.

Legacy paths are relative to `refs/baton-legacy/`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; the JSDoc rules (no `//` above a declaration, no reference to this plan, the research or any `docs/` file in code); the logging and SQL rules; layout only in parts under `src/web/components/screen/`.
- Work in the checkout you were launched in (`main`, or `wt-NN` if the orchestrator splits Step 7 off). Commit at the end of each green step. Stage paths explicitly; never `git add -A` or `git commit -a`.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ) and `vp run test:e2e`. A step that cannot end green is recorded in §7 before moving on.
- A step that adds or deletes a route under `src/web/routes/` regenerates `src/web/routeTree.gen.ts` (`vp build`) before `vp check`.
- **No table changes**: `migrations/0001_init.sql` and the actor's `0001_init` stay as they are. Never `db:reset` the `staging` stage, `cloud:reset` or `alchemy deploy`; touch the `dev` stage only by running the dev server.
- Names follow roadmap §0.2: `makeRunRepository` stores, `makeRuns` is the runs application service; nothing is called an agent. "Workflow" alone is the product's definition; Cloudflare's is the orders sync Workflow.
- Each callable lands as the research's §1.3 table says, and nothing else. Member procedures take the member's identity from `CurrentCaller`, never the payload. No new `DevRpcs`; three test-only `IntegRpcs` rows (`ApiOrderDetail`, `ApiWorkflowsList`, `ApiMemberWorkflowPage`).
- **Transactions.** Never nest one: a repository method that takes `transaction` is called outside any other. `reconcileOrder` opens none; it runs inside `upsertOrder`'s (as `afterWrite`) or inside `reconcileAll`'s per-order one. **No `MembershipRepository` (D1) call, no Admin API call and no usage flush inside a `transaction(…)`**: the eligible context (teams) is read before.
- **Billing stays a seam** (research Q3): `countOrder` and `flushUsage` are arguments the actor passes as no-ops; their call sites are legacy's and are pinned in unit. No `ShopUsage` cycle code, no `UsageEvent` writes.
- One notice key for orders and their runs: `ORDERS_KEY`. Every run write notifies it on its success variant only.
- Legacy is the spec, not the source. Keep legacy's method, error and verb names, test titles (byte for byte), copy, page sizes and part names. Port SQL and JSDoc rules verbatim, lowercase. Screen names are legacy's Screens table's: the orders index, the order page, the home page, the workflows list, the member's workflow page; never "run" in a screen name, a route segment or copy.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- The integ suite leaks `.alchemy/local/baton-test-…-ShopActor` directories; delete the ones your runs create.

## 1. Outcome

- A run per item, created, resized and closed by reconcile on every order write (the webhook, Sync from Shopify, the open-orders stream) inside that order's transaction, and on every stored open paid order after Turn on, Turn off, the editor's Turn on, Delete workflow and Delete team (always) and Apply and Edit tag (when active).
- The merchant's orders index is legacy's: strip, Show, Team, search, run positions, issues, the order link, Previous and Next. The order page shows each item's run with legacy's verbs (Attach, Change workflow, Cancel workflow, Done, Put back, Reopen, Note, Block, Unblock, Assign team) and Sync from Shopify. The home page shows the Orders strip. The admin's order link opens the order page.
- A member opens `/shop/$key` and lands on the workflows list (`/shop/$key/workflows`): their teams' current work by state, search, team, Show more, with Start, Done, Put back, Undo, Unblock; the member's workflow page (`/shop/$key/workflows/$runId`) with the task history, note, block and print. Both are live: a write on any socket shows on every other.
- `LoadFixture` and `AddToFixture` create the fixture's runs with their progress; the dev fixture shows legacy's showcase shop at work.
- The counter page and its procedures are gone.
- The billing hooks (`countOrder`, `flushUsage`) are in place as no-ops for G.

## 2. What this plan rests on

- **The actor's repositories and services.** `makeOrderRepository`, `makeWorkflowRepository` over `(sql, syncTransaction(sql))`; `makeOrders`, `makeMembership`, `makeWorkflows` built once per activation in `src/backend/shop-actor.ts`; `reconcileAll` passed to the last two as `() => Effect.void`, called at legacy's sites (pinned in `test/unit/backend/shop-actor/workflows.test.ts` and `membership.test.ts`).
- **The `afterWrite` seams.** `OrderUpsert.afterWrite` runs inside `upsertOrder`'s transaction after the items are written, only when the write happened, and returns its value as `upsertOrder`'s `afterWrite` (`order-repository.ts`); `runOrdersStream` takes `afterWrite?: (order) => Effect` (`orders-stream.ts`). Nothing passes one yet.
- **`WorkflowRepository.listActiveWorkflowsByTags`** (plain statements, query-plan test) and **`listActiveWorkflowNames`**, ported in E for F; `unassignTeam` already nulls `RunTask.teamId`.
- **The domain** (`src/domain/shop-work.ts`, `orders.ts`): every run schema, input, result union, the matrices, `reconcileItem`, `lineItemState`, `orderPosition`, `orderIssues`, `workflowsListFrom`, `runRowLines`, `OrderPageData`, `OrdersIndexData`, `WorkflowsListData`, `RunPageData`. Do not redefine any.
- **The gate** answers a member's `teamIds` and email (`ShopAccess.resolve`, `MemberCaller`).
- **Tests.** `ActorSqliteTest` and the harness pattern of `test/unit/backend/shop-actor/workflows.test.ts`; `openAs` with a forged merchant or member caller (`test/integ/actor-clients.ts`; `memberAs` in `socket-facts.test.ts`); `shopActorClientLayer`; e2e `ownMember`, `AddToFixture`, `scripts/test-order.ts`, `openApp`.
- **The screens' patterns** from A, C and E: loader seeds a procedure atom, atoms refetch on their reactivity key; mutation atoms read with `mode: "promiseExit"`; `thrownCopy`; `appHref`; `-search-params.ts` (`lenientSearchKey`, `ListSearchParam`); `-table-pages.ts` (`useNextPageEntry`); `polaris-modal.ts`; one `<s-page>` kept alive from SSR through hydration (slice E's lesson).
- **Unproven**, checked first where needed: reconcile inside `upsertOrder`'s transaction on workerd (Step 3); `runListItems`' plan on `node:sqlite` (Step 2); the Effect 4 `Cache` API for the memos (Step 3); where a signed-in member's landing is decided (Step 7).

## 3. Names and constants

| Name                                                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReconcileCounts`, `ReconcileAllCounts`                          | In `src/domain/shop-work.ts` beside the pass rules that name them; `reconcileCountsChanged` with them (legacy `RunRepository.ts`).                                                                                                                                                                                                                                                                                                                                                                |
| `makeRunRepository` (`src/backend/shop-actor/run-repository.ts`) | `makeRunRepository({ sql, transaction, countOrder })`: legacy `RunRepository`'s 18 methods and 9 errors (`RunRepositoryError`, `RunNotFoundError`, `RunTerminalError`, `RunBlockedError`, `RunOrderClosedError`, `RunNotAllowedError`, `RunNotBlockedError`, `TaskNotReadyError`, `TaskDoneError`), `WorkflowsByTags`, `ReconcileContext`; legacy `currentWhere.ts` as a private. `countOrder: (orderId: string, now: number) => Effect<void, SqlError>`, called by `insertRun` after the insert. |
| Order repository additions                                       | `listOrders(ListOrdersInput)` → `OrdersPage` (legacy's, replacing the run-free one, with `OPEN_RUN`, `ITEM_MATCHES`, `MULTI_MATCH_ITEM` and friends), `getOrderByLegacyId(legacyId)`, `getLineItem(lineItemId)`.                                                                                                                                                                                                                                                                                  |
| `makeRuns` (`src/backend/shop-actor/runs.ts`)                    | `makeRuns({ runRepository, orderRepository, workflowRepository, membershipRepository, notify, flushUsage, shop })`: `eligibleContext`, `reconciler` (→ per-order `afterWrite`), `reconcileAll(caller, id)`, `listOrders`, `getOrderDetail`, `listRuns`, `getRunPage`, the nine merchant and seven member writes (legacy's verbs), the memos. Log prefix `Runs.`. `flushUsage: Effect<void>`.                                                                                                      |
| Merchant procedures                                              | `MerchantGetOrderDetail` (`GetOrderDetailInput` → `OrderPageData \| null`); `MerchantAttachWorkflow` → `AttachResult`; `MerchantCancelRun`, `MerchantMarkTaskDone`, `MerchantReopenTask`, `MerchantPutBackTask`, `MerchantSetRunNote`, `MerchantBlockRun`, `MerchantUnblockRun` → `RunResult`; `MerchantAssignRunTaskTeam` → `AssignRunTaskTeamResult`. `MerchantListOrders` becomes `ListOrdersInput` → `OrdersIndexData`.                                                                       |
| Member procedures                                                | `MemberListRuns` (`LiveRunsInput` → `WorkflowsListData`), `MemberGetRun` (`RunIdInput` → `RunPageData \| null`); `MemberStartTask`, `MemberMarkTaskDone`, `MemberReopenTask`, `MemberPutBackTask`, `MemberSetRunNote`, `MemberBlockRun`, `MemberUnblockRun` → `RunResult`.                                                                                                                                                                                                                        |
| Retired                                                          | `MemberGetCount`, `MemberIncrement`, `MerchantGetCount`, `MerchantResetCount`, `COUNT_KEY`, `Count`, the snapshot's count, `ShopPage`, the count atoms; `MemberActivation`, `MemberWhoAmI`, `MerchantWhoAmI` and `Activation` too unless a socket-fact test still needs one (record which).                                                                                                                                                                                                       |
| Stub methods                                                     | `getOrderDetail({ legacyId })`, `listOrders(ListOrdersInput)` (grown), `listRuns({ teamIds, memberEmail, query })`, `getRunPage({ runId, teamIds })` on `ShopActorShape` (`tag.ts`) and `ShopActors`.                                                                                                                                                                                                                                                                                             |
| Loader methods                                                   | `BackendApi.listOrders` (grown to `q`, `show`, `team`, `after`), `orderDetail`, `workflowsList`, `memberWorkflowPage`; server functions in `src/web/server/orders.ts` and a new `src/web/server/workflows-list.ts` (member).                                                                                                                                                                                                                                                                      |
| Routes                                                           | `app.orders.tsx` (layout: `q`, `show`, `team`, `after`), `app.orders.index.tsx`, `app.orders.$orderId.tsx`; `shop.$key.tsx` (layout: `state`, `team`, `limit`, `q`; gate loader; not-found), `shop.$key.index.tsx` (redirect), `shop.$key.workflows.index.tsx`, `shop.$key.workflows.$runId.tsx`.                                                                                                                                                                                                 |
| Components                                                       | `RunSteps`, `RunTextModals` (`RunNoteModal`, `BlockModal`), `MemberRun` (`ClosedLine`, `BlockBanner`, `RunNote`, `LineItemProperties`, `RunItem`) under `src/web/components/`; `change-warning.ts`, `order-links.ts` (`adminOrderUrl`, `useResourceLinkTarget`), `workflows-list-states.ts`, the member run actions (legacy `useMemberRunActions`) beside their callers.                                                                                                                          |
| Parts                                                            | `Clamp`, `ClampedProse`, `StepList` (with `FramedList`), `Strip` (`StripCell`), `Name` (Step 5); `SelectRow` (Step 6); `ResourceRow` (`RowLine`, `RowHead`), `ShowMore`, `PageBody` (Step 7), under `src/web/components/screen/`, each with its `Screen.ts` row as JSDoc. `LocalDateTime` gains `format: "dateTime" \| "date" \| "time" \| "relative"`.                                                                                                                                           |
| Constants                                                        | `ORDERS_PAGE_SIZE` 25 (exists), `ORDERS_ARRIVAL_INPUT`, `ORDERS_STRIP` (legacy `ordersIndexQuery.ts`); `RUN_PAGE` 25, `RUN_LIMIT_MAX` 100, `DONE_WINDOW_MS` (domain).                                                                                                                                                                                                                                                                                                                             |

## 4. Steps

### Step 1: Domain completions and the matrices

- `ReconcileCounts`, `ReconcileAllCounts`, `reconcileCountsChanged` in `shop-work.ts`, with legacy's JSDoc.
- JSDoc that names legacy symbols that do not exist here (`RunRepository.…`, `ShopWorkAgent.…`, `ShopAgent.…`, `OrderRepository.listOrders`, `initializeSchema`, `pnpm spec check`, `scripts/rules-lint.ts`, `test/integration/…`) names this repo's (`makeRunRepository`'s `reconcileOrder`, `Runs.reconcileAll`, …) in backticks, or drops the sentence where it only described legacy's tooling.
- Tests, unit (`test/unit/domain/shop-work.test.ts` or a new `run-actions.test.ts`): legacy `run-actions.test.ts`'s pure half. One `it` per row of `runActions` (10), `taskActions` (9) and `reconcileItem`'s actions table (13), the cells written as data in the test. **Titles:** render them once by running legacy's own parser read-only (`scripts/lib/spec.ts`'s `renderRow`, `parseReconcileActions` over `src/lib/domain/ShopWork.ts`, from a script outside `refs/`) and paste the output; record the command in §7. Plus "without the item, Change workflow is not offered", "a task on no team is nobody's: every member cell is blank and every merchant cell holds", and "a pass guarantees stop, fit, record, create and orphan, and a second pass writes nothing" (over every combination of the actions table's column values).
- Verify: green.

### Step 2: Storage

- **Check first.** Port `runListItems` and `tasksForRuns` and run legacy's "the workflows list read starts from the member's teams through the team index" by `explain query plan` over `ActorSqliteTest`. Record the plan text in §7. If `node:sqlite` plans it differently from the title's claim, record it and assert the plan the DO's SQLite gives in integ instead (one test through the actor), continuing either way.
- `makeRunRepository` (§3), every method, SQL lowercase, legacy's JSDoc; `transaction` for legacy's `sql.withTransaction`; `countOrder` called where legacy's `insertRun` calls `orderRepository.countOrder`.
- Order repository: legacy `listOrders` (counts, Show, Team, search, `matches`, `openOrders`, keyset by `processedAt desc, id desc`), `getOrderByLegacyId`, `getLineItem`, with their JSDoc and SQL twins. The run-free `listOrders` goes.
- Tests, unit over `ActorSqliteTest`: legacy `run-repository.test.ts` (titles unchanged) but its five `RunRepository metering` titles (G); `seedStepped`'s `replaceWorkflows` becomes a test-local insert, as E's `insertWorkflows`; a recording `countOrder` asserts it is called once per created run and never for resize, close or a second run on the order. Legacy `data-model.test.ts`'s eleven run titles. Legacy `order-repository.test.ts`'s `OrderRepository.listOrders`, `… multi-match`, `… by tag`, `… query plans`, `… filters`, `… q`, `… team issues`, `… team` describes. `test/unit/backend/shop-actor/order-repository.test.ts`'s run-free list tests follow the new shape.
- Verify: green.

### Step 3: Runs, reconcile wiring, procedures, fixture

- **Check first** (integ, on workerd): a webhook for an order whose item carries an active workflow's tag creates its run inside the upsert, through `afterWrite` (legacy "the one-order sync stores the order and creates its run"). Record the result. **If the transaction stalls or refuses** (a D1 read leaking in, the sync scheduler): record it under Issues with the cause, and stop at a WAITING line; the orchestrator brings it to the user (roadmap Q6 puts reconcile inside the transaction).
- **Check first** (unit): the Effect 4 `Cache` API in `refs/effect/packages/effect/src/Cache.ts` (`make`, `get`, `invalidateAll`, success-only retention as legacy's `keepSuccesses`); record what the memos use.
- `makeRuns` (§3) from legacy `agent/ShopWork.ts`'s run half and its `listOrders`, `getOrderDetail`, `readRuns`, `readRunPage`: `eligibleContext` (D1 teams before any transaction), `reconciler` with its log line, `reconcileAll` with its log line and `Effect.ensuring(flushUsage)`, `requireRunAction` / `requireTaskAction` before each write, `runResult`, the result mappers, Attach's check order with `Effect.ensuring(flushUsage)`, Assign's team check, the log lines (`Runs.<verb>: shop=… runId=…|task=… [memberId=…]`; never the note or reason). Memos per activation, cleared by `notify` when it names `ORDERS_KEY` (wrap the actor's `notify` once).
- The actor: builds the run repository and `makeRuns` once per activation (`countOrder: () => Effect.void`, `flushUsage: Effect.void`); passes `runs.reconcileAll` to `makeWorkflows` and `makeMembership`; gives `makeOrders` the reconciler, which `fetchAndUpsertOrder` loads once and passes as `afterWrite` (legacy `agent/Orders.ts`), with `changed = upsert.changed || Option.exists(upsert.afterWrite, reconcileCountsChanged)`; `onOrdersStream` passes `afterWrite: yield* runs.reconciler()`; `flushUsage` after the webhook and Sync from Shopify and `ensuring` the stream, where legacy flushes (the two "billing seam" JSDoc sentences there become the calls). `MerchantListOrders` and the stub `listOrders` read through `runs.listOrders`.
- `src/contract/shop-actor.ts`: the ten merchant and nine member procedures of §3 with the domain's payloads and unions, no declared error; `MerchantListOrders` on `ListOrdersInput` / `OrdersIndexData`; the contract's `OrdersListInput` and `OrdersListPage` deleted. `ORDERS_KEY`'s JSDoc: an order or one of its runs changed. Handlers pass straight through to `runs`; member handlers build the `MemberActor` and `teamIds` from `CurrentCaller`.
- The fixture: `loadFixture` and `addFixture` apply each order's `workflow` choices, progress and `after` (legacy `ShopWork.seedOrders` and `applyProgress`), after the rows are inserted and outside their transaction: per order, reconcile in its own transaction, attach each item's `workflow` (`setRun`), apply progress through the run repository's writes (each its own transaction), apply `after` through an upsert with the reconciler; then `reconcileAll("loadFixture", shop)`; one `notify([ORDERS_KEY])`. Fixture orders keep `countedAt` 0. `src/backend/fixture.ts` and `src/contract/fixture.ts` JSDoc that says "nothing applies it" says what does.
- Tests. Unit (`test/unit/backend/shop-actor/runs.test.ts`): `makeRuns` over the repositories on `ActorSqliteTest` and the D1 adapter, recording `notify` and `flushUsage`: result mapping per verb; the gate refuses before the repository; notices only on the success variant; teams read before any transaction; `flushUsage` after reconcile all (even when it fails) and after Attach; the memo titles of legacy `list-memo.test.ts` that are not about Durable Object rows; legacy `orders-stream`'s "creates runs on every streamed open order that matches, however old, and a re-stream creates none"; the fixture's progress with legacy's seed titles ("seedOrders runs each item on its own progress and leaves its siblings alone", "seedOrders chooses a workflow for an item two claim, and the order stops asking", "seedOrders applies \`after\` once the work has started, so a cancel closes the run and a quantity change resizes it", "a seeded run records its \`by\` member as the starter and the doer", "a seeded Done on a team \`by\` is not on is recorded as that team's first member", "a seeded run's note is written after its progress", "a reseed reconciles the orders it did not replace"). The existing `workflows.test.ts` and `membership.test.ts` reconcile-site tests keep passing with the real body behind them where they use it. Integ (`test/integ/runs.test.ts`, forged sockets): every procedure; legacy `shop-agent-workflows.test.ts`'s fifteen `ShopAgent workflow run callables` titles but the one already ported; `member-runs-socket.test.ts`'s `member workflows list socket` titles and "assigning a task's team publishes to every screen", "Attach workflow publishes to every screen", "Cancel workflow publishes to every screen", and the run half of "a refused call publishes nothing"; `run-actions.test.ts`'s `callables:` rows (19) and "a member whose teams hold no task of the run gets nothing, the note included", "callables: a task on no team refuses the member's Done and takes the merchant's", "Undo is offered to the task's whole team, not only to who pressed Done"; `shop-agent-sync-order.test.ts`'s "the one-order sync stores the order and creates its run", "a webhook on the same version whose reconcile creates a run publishes", "a product retagged in Shopify changes nothing until its order syncs again", "an item's product tags are rewritten by the next sync and a run created from the old tags is not revisited"; `setup-facts.test.ts`'s "each step is undone on an empty shop and done once its fact holds", "the guide hides when all three hold", "the guide shows again when a fact stops holding", "an item with a workflow in any state completes the third step" (E's "a run waits for runs" title is replaced by them); a member refused every merchant run procedure and a merchant every member one with `Forbidden`.
- Verify: green.

### Step 4: Loaders and client atoms

- Stub methods of §3 on the actor, `ShopActorShape` and `ShopActors` (and `ShopActors.layerTest`'s `die` stubs).
- `BackendApi`: `listOrders` grows (`ListOrdersRequest` gains `q`, `show`, `team`; strict contract, lenient decode in the route); `orderDetail({ sessionToken, legacyId })`; `workflowsList(request, { key, query })` and `memberWorkflowPage(request, { key, runId })` resolve the member through `ShopAccess` (401 → `Unauthorized`, 403 → `Forbidden`, 404 → `NotAShopMember`, as `shopSnapshot`) and pass `{ teamIds, memberEmail }`; the member loaders also answer the member's teams (id and name) for the Team select, from the gate's access row. Server functions (GET).
- Client: query and mutation atoms for every new procedure in `src/web/client/shop-actor-client.ts`, reads `withReactivity([ORDERS_KEY])` and seedable (serialization keys per input), as `merchantOrdersAtom`; the reconnect notice keeps naming `ORDERS_KEY`.
- `IntegRpcs`: `ApiOrderDetail`, `ApiWorkflowsList`, `ApiMemberWorkflowPage`, built as `ApiWorkflowsPage`.
- Tests. Unit (`api.test.ts`): each method refuses a bad token or no session; no `ShopSession` → `ShopNotInstalled`; a non-member → `NotAShopMember`, all before any actor call. Integ: the three loaders over `addToFixture` (with progress from Step 3); legacy `member-area.test.ts`'s "is gated by membership like the shop page" and "requireMember admits every member of a subscribed shop".
- Verify: green, e2e included (the screens are unchanged but `MerchantListOrders`'s shape moved under the orders index: adapt `OrdersPage` minimally to the new data, columns unchanged).
- Write `CHECKPOINT: Backend half done (<commit>)` under §7 "Command results", then **WAITING: the orchestrator reviews and says how Steps 5–7 run.** Stop.

### Step 5: Shared run components

- `MemberRun` (`closedReasonText` use, `ClosedLine`, `BlockBanner`, `RunNote`, `LineItemProperties`, `RunItem`), `RunSteps`, `RunTextModals` (`TextModal`, `RunNoteModal`, `BlockModal`, with `PolarisModal`'s backdrop guard and dirty flag) from legacy, under `src/web/components/`.
- Parts `Clamp`, `ClampedProse`, `StepList` with `FramedList`, `Strip` with filter-press and link cells, `Name`; `LocalDateTime`'s formats (legacy `LocalDateTime.tsx`).
- `/dev/kit`: sections for the new parts and components, worst-case data.
- Tests. Browser: `RunSteps` (badges, actor lines, actions slot), `RunNoteModal` and `BlockModal` (dirty, limit, field error, close on null), `Strip` (chosen cell, link cells), `ClampedProse` (Show more and Show less); the kit renders.
- Verify: green.

### Step 6: Merchant screens

- `app.orders.tsx` becomes the layout (`q`, `show`, `team`, `after` by `lenientSearchKey`; carried on the index's links and the order page's breadcrumb through `appHref`, a nav click drops them, as E's workflows layout); `app.orders.index.tsx` is legacy's full index (§1.1 of the research): strip, Show, search with `SearchLine`, Team with Deleted team, per-filter empty text, columns Order (link), Placed (`LocalDateTime` date), Payment, Status, Issues, Items, Shopify (`useResourceLinkTarget`), Previous and Next (`useNextPageEntry`), Sync open orders and its toasts; the per-row Sync column goes; fixture orders keep no Shopify link.
- `app.orders.$orderId.tsx`, the order page, from legacy: loader `orderDetail`, seeds `MerchantGetOrderDetail`; items by `lineItemState`; the workflow select (`SelectRow`, matched first, divider, others) and Attach; the run (badges, `BlockBanner` with Unblock, now line, `RunNote` with Edit note, "assign a team" rows, Manage drawer with `RunSteps` and Done, Put back, Reopen, Assign team, Block, Cancel workflow, Change workflow); the five modals; `change-warning.ts` (`changeWarning`, `cancelHeading`, `CANCEL_WARNING`); toasts and messages verbatim (`attachResultMessage`, `assignResultMessage`, `runResultMessage`); View in Shopify, Sync from Shopify (`MerchantSyncOrder`, Gone toast); the made banner; Order note and Order details; Order not found; the error page. One `<s-page>` alive from SSR through hydration (slice E's rule: the live half as hooks, never a component swap at the page's position).
- `app.orders.from-shopify.tsx` redirects to `/app/orders/$orderId` by `id`'s last segment, forwarding every other parameter (legacy).
- The home page: the Orders strip (link cells to `/app/orders?show=…`, Making with none) from the index's arrival read, seeded by the home loader (`listOrders` with `ORDERS_ARRIVAL_INPUT` beside `setupFacts`), live; above today's links.
- Tests. Unit: `change-warning.test.ts` (six titles); the orders layout's lenient keys (legacy `search-params.test.ts`'s two non-flag titles). Browser: `OrdersPage` tests follow the new columns and filters; `SelectRow`. e2e (`test/e2e/embedded/orders.spec.ts` and a new `order-page.spec.ts`; data by `AddToFixture` with names and tags from the test id; real orders by `scripts/test-order.ts` where a title needs Shopify): legacy `e2e/orders.spec.ts`'s sixteen titles, and `home.spec.ts`'s "the strip shows five cells with the orders index's labels" and "a strip cell opens the orders index with that value chosen". A title that counts every order (the counts, Show, Issues titles) asserts on its own orders only: filter by its own tag or search, as E's specs do; record any title whose meaning that changes. Slice A's three orders titles keep passing.
- Verify: green.

### Step 7: Member screens

- **Check first:** where a signed-in member's landing is decided (`homeFor`, the sign-in page's redirect, the magic-link callback). Record it. A one-shop member lands on `/shop/<key>/workflows`; a member of none or several on `/shop`.
- `shop.$key.tsx`: `validateSearch` (`state` → default `started_by_you`, `team`, `limit` → `clampRunLimit`, `q`; never fails), the gate-only loader (the count snapshot goes; refusals as today), `ShopSocket`, `notFoundComponent` ("No access", "You no longer have access to this store.", Your stores), a 3401 close → `router.invalidate()`; the bar names the shop and its mark opens the workflows list at the first page; Your stores keeps today's bar.
- `shop.$key.index.tsx` redirects to `/shop/$key/workflows` with the search. `shop.$key.workflows.index.tsx`, the workflows list, and `shop.$key.workflows.$runId.tsx`, the member's workflow page, from legacy (§1.1): strip, Team select for two or more teams, search, rows (`ResourceRow`, `RowLine`, menus), Done or closed, Show more and the narrow sentence, empty states, "You're not on a team yet."; the page's heading, item, Block, banners, note and order note, `RunSteps` with Start, Done, Put back, Undo, the two modals, print CSS, "Workflow not found"; the Workflows back link (`history.back()` when the list opened it, else the list). `workflows-list-states.ts`; the member run actions (legacy `useMemberRunActions`: pending, the banner sentence, `runResultMessage`). Parts `ResourceRow`, `ShowMore`, `PageBody`. No toasts in the member area.
- The counter retired (§3 "Retired"): contract, actor handlers, snapshot, client atoms, `ShopPage` and its browser test; integ tests that used the count re-anchor on a run read and a run write (a notice across sockets, `MemberListRuns` as the read).
- Tests. Browser: `ResourceRow` (menu beside the clickable), `ShowMore`, the list's states. e2e (`test/e2e/workflows-list.spec.ts`, `member-workflow-page.spec.ts`; each spec's team, members (`ownMember`), workflow and orders with progress added by `AddToFixture` under names from its test id): legacy `e2e/member-runs.member.spec.ts`'s forty titles and `member-area.member.spec.ts`'s four non-lapsed titles; `shop.spec.ts`'s four socket titles re-anchored ("an increment in one window updates the count in another" becomes a Done in one window shown in another under a new title; record it). A title whose legacy fixture shared one seeded shop arranges its own.
- Verify: green.

### Step 8: Docs

- `docs/legacy-port-research.md` §1.1: the actor tables row (`Run`, `RunTask` read and written) and the member area; the orchestrator updates §3.
- `docs/glossary.md`: the Domain section's symbol column names this repo's symbols for reconcile, reconcile all, live and memo (`Runs.reconcileAll`, the run repository's `reconcileOrder`, the five live screens).
- `CHECKPOINT: ready for staging (<commit>)` under §7 "Command results". The orchestrator runs staging (`deploy:staging`, no reset: no table changed).
- Verify: `vp check` green.

## 5. Verification checklist

- `vp check`, `vp test`, `vp run test:e2e` green at the end; counts and times in §7.
- `MerchantRpcs` has the ten new merchant procedures and `MemberRpcs` the nine member ones; no count procedure remains; every `createServerFn` added is GET.
- `ShopActorShape` gained exactly `getOrderDetail`, `listRuns`, `getRunPage` and `listOrders`'s new shape.
- No `transaction(…)` nested; no `MembershipRepository`, Admin API or `flushUsage` call inside one (read `runs.ts`, `orders.ts`, the fixture's apply, handler by handler).
- `countOrder` and `flushUsage` are no-ops in the actor, called at legacy's sites (unit-pinned).
- Every legacy title §4 names is present byte for byte (`grep -rlF` each); every title dropped or moved is listed in §7 with its reason.
- No uppercase SQL keyword in `run-repository.ts` or `order-repository.ts`.
- No screen name, route segment or copy uses "run" (`grep -rn "/runs\|\brun\b" src/web/routes src/web/components` and read each hit; identifiers like `runId` pass).
- The production bundle (`.alchemy/bundles/Backend/`, today's entries) contains no `IntegRpcs` or `ShopifyFake` string.

## 6. Done when

- §1 holds on the dev stage; every step is green and committed; §7 is filled in; the `CHECKPOINT` lines are written.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict. Command results go under their own heading with counts and times.

### Plan review

2026-10-18, by the lead, read-only against this repo, `refs/baton-legacy/` and `refs/effect/`. Each item says what is wrong or missing, then the detail the step is built to. The steps above stand; where an item corrects one, the item wins.

**Plan-wide**

- **The orders-read reshape is one step, Step 3.** As written, Step 2 deletes the run-free `listOrders` and Step 3 deletes `OrdersListInput` / `OrdersListPage`, but their consumers move in Step 4. Neither step could end green. The consumers are:
  - `ListOrdersRequest` in `src/contract/orders.ts`, and `src/web/server/orders.ts`
  - `tag.ts`, `shop-actors.ts`, `api.ts`
  - `IntegRpcs` `ListOrders` / `ApiListOrders`, with their uses in `test/integ/orders.test.ts` and `orders-sync.test.ts`
  - `merchantOrdersQuery` / `merchantOrdersAtom` / `seedOrders` in `shop-actor-client.ts`
  - `OrdersPage.tsx` and the browser tests `OrdersPage.test.tsx` and `ShopSocket.test.tsx`
  - `api.test.ts`'s "BackendApi orders"

  **Build to:**
  - **Step 2** adds the run-aware `listOrders` and keeps the run-free read, renamed `listOrdersRunFree`, for its callers.
  - **Step 3** moves every consumer and deletes the old shapes and `listOrdersRunFree`. That covers `MerchantListOrders`, the stub, `ListOrdersRequest` (gaining `q`, `show`, `team`, `cursor`), the two existing `IntegRpcs` rows, the client query keyed by the whole `ListOrdersInput`, the minimal `OrdersPage` (`data.page.orders[i].order`, `.itemUnits`, `data.page.nextCursor`) and the tests.
  - **Step 4** adds only the new loaders. The wire key is `cursor` (`ListOrdersInput.cursor`); `after` is the URL key only.

- **`ShopActorShape` changes**, which correct §5:
  - It gains `getOrderDetail`, `listRuns`, `getRunPage` and `applyFixture` (see Step 3).
  - `listOrders` changes shape.
  - It **loses `snapshot`** (Step 7).
- **The counter's retirement is wider than §3 lists**, and in part narrower.
  - **These go too:** `ShopSnapshot`, `ShopActorShape.snapshot` / `ShopActors.snapshot` (`layerTest`'s positional `snapshot` argument shifts `dev.test.ts`'s and `fixture.test.ts`'s arguments), `getShopSnapshot` / `ShopPageData`, `test/browser/test-setup.test.tsx`'s count handler (re-anchor the harness guard on `MemberListRuns`), `test/e2e/screens.ts` `shop()`, and `fixtures.ts`'s `nextOpenSocket` JSDoc.
  - **`BackendApi.shopSnapshot`** becomes the gate-only `shopAccess`, answering the caller.
  - **These stay:**
    - `MemberActivation`, because `socket-facts.test.ts`'s hibernation test reads it.
    - `MemberWhoAmI` and `MerchantWhoAmI`, socket-ready probes in about eleven integ files.
    - `Activation`.
- **Paths.** `changeWarning.ts`, `orderLinks.ts`, `ordersIndexQuery.ts`, `useMemberRunActions.ts`, `workflowsListStates.ts`, `polarisModal.ts`, `format.ts` and `searchParams.ts` are in legacy `src/lib/`. `MemberRun`, `RunSteps`, `RunTextModals` and `LocalDateTime` are in `src/components/`; the parts are in `src/components/screen/`. Here `polaris-modal.ts` is `src/web/client/polaris-modal.ts`. The home page is `src/web/routes/app.index.tsx`; `HomePage.tsx` is the public landing.
- **Pattern precedent.** Only slice A's orders and sync screens are seeded or live atoms (`merchantOrdersAtom`, `seedOrders`). C's and E's screens are loader data plus `router.invalidate()`. Copy A.
- **Mutation atoms for row verbs** (workflows list, order page):
  - **Why:** `ShopActorClient.mutation` interrupts its first call on a second press (`syncOrderAtom`'s JSDoc).
  - **Build to:** `Atom.family` keyed by `runTaskId` or `runId`, as `syncOrderAtom`.
- **One `<s-page>` alive.** The implementation to copy is `WorkflowEditorPage.tsx`'s `useEditorPresses` plus `usePressWaiting` (`press-waiting.ts`): idle presses before hydration, one screen at one position. `WorkflowPage.tsx` and today's `OrdersPage.tsx` still swap components (`hydrated ? <Live…/> : <…Screen/>`); do not copy them. The rule applies to the new orders index, the order page and the home strip.

**Step 1**

- **Where the declarations come from.** `ReconcileCounts { created, resized, closed, multiMatch }`, `ReconcileAllCounts { orders, created, multiMatch }` and `reconcileCountsChanged` (created, resized or closed above 0) come from legacy `src/lib/RunRepository.ts` (≈ lines 99–132), with their per-field JSDoc. "The run half of the signal `ShopAgent`'s `publish` gates on" becomes the `changed` of `makeOrders`' `fetchAndUpsertOrder`. `{@link Domain.x}` becomes `{@link x}`.
- **Titles, two renderers.** `runActions` and `taskActions` titles are `Spec.renderRow(name, row)`; the `reconcileItem` action titles are `row.text` (cells joined `" | "`). Keep legacy's describes: `"Domain.runActions matrix"`, `"Domain.taskActions matrix"`, `"Domain.reconcileItem actions"`, `"Domain.reconcileItem post-condition"`.
  - **The command** (read-only; the script lives outside the repo and refs, imports legacy's `scripts/lib/spec.ts` by absolute path, and resolves `effect` from the repo): `node /tmp/baton-spec/titles.ts [path to ShopWork.ts or src/domain/shop-work.ts]`. The ported `shop-work.ts` renders the same 10, 9 and 13 rows as legacy.
  - Recreate the script if `/tmp` was cleared: `Spec.parse(source, "runActions" | "taskActions")` then `Spec.renderRow`, and `Spec.parseReconcileActions(source)` then `.text`, unwrapping `Result` by hand (`_tag === "Success"`).
- **Cells as data.** Follow `test/unit/domain/orders.test.ts`'s `SYNC_ROWS`: each row carries its words and cells, and a word→value map expands them. The post-condition is the cartesian product of the action table's column words, built in the test (legacy's `reconcileActionUniverse` gives 216).
- **Missing pure title.** Port "lineItemState has one kind per layout" (legacy `test/integration/run-actions.test.ts`, describe `"Domain.lineItemState"`), adapted to the five-argument `lineItemState`.
- **The JSDoc sweep covers both `shop-work.ts` and `orders.ts`.** The legacy names to rewrite are more than the step lists:
  - `ShopAgentSchema.ts`, `ShopAgentClient`, `ShopAgentHost`
  - `OrderRepository.countOrder` (now the run repository's `countOrder` argument), `OrderRepository.markSeedOrdersCounted` (gone)
  - `currentWhere.ts`, `useLiveQuery`, `Screen.ts`, `scripts/lib/spec.ts`
  - "Agents SDK"
  - legacy route and file names (`app.orders.tsx`, `shop.$shop…`, `workflowsListStates.ts`, `api.dev.seed.ts`, `ShopAgent.seedWorkflows`)
  - three dead `{@link initializeSchema}`

**Step 2**

- **`makeRunRepository(sql, transaction, countOrder)` is positional**, as `makeOrderRepository(sql, transaction)`, with `type RunRepository = ReturnType<…>` (§3's object form is dropped).
- **`currentWhere` is shared, not private.** Legacy's orders-index team filter uses it too (`OrderRepository.listOrders`, `currentWhere("s")`), and its JSDoc names three readers that must agree. Build it as `src/backend/shop-actor/current-where.ts` (`currentWhere(alias)`), imported by both repositories.
- **Eleven `sql.withTransaction` sites, not ten:** `reconcileAll` (per order), `setRun`, `cancelRun`, `reopenTask`, `putBackTask`, `startTask`, `markTaskDone`, `setRunNote`, `blockRun`, `unblockRun`, `assignRunTaskTeam`.
- **`countOrder`'s test is wrong as written.** Legacy `insertRun` calls `countOrder(order.id, now)` once per inserted run, **a second item's run on the same order included** (once-per-order is `countOrder`'s own body, G). The recording test asserts:
  - one call `(orderId, now)` per created run, including a manual attach and a replace;
  - none for a resize, a close, a no-op second pass, a conflicting insert, or `setRun`'s `None`.
- **`listOrders` takes `ListOrdersInput & { teams }`.** `unassigned` is derived against the live D1 teams (legacy input `{ …, teams: EligibleContext["teams"] }`). Port its module constants: `openAs`, `OPEN_RUN`, `DONE_RUN`, `STARTED_RUN`, `BLOCKED_RUN`, `RUN_FOR_ITEM`, `ITEM_MATCHES` (exported; it uses `json_extract`, which is fine), `MULTI_MATCH_ITEM`, `MULTI_MATCH`, `COUNT_FACT`. Also port `detailOf`, shared by `getOrder` and `getOrderByLegacyId`. `getLineItem` → `Option<{ order, lineItem }>`. Legacy reads without a transaction; either is allowed, record the choice.
- **Legacy JSDoc that is false here is not ported verbatim:**
  - "Durable Object SQLite refuses to nest". `Transaction` here says nothing refuses; fix the same sentence already on `OrderUpsert.afterWrite`.
  - `ShopAgent.publish`, `initializeSchema`, "`ShopOrder_open_idx` in `ShopAgent.ts`".
  - The two "Pinned by '… reads at most N rows …'" sentences, whose titles are dropped (Q14).
- **Tests.**
  - `seedStepped`'s test-local insert must take `instructions` (Artwork carries "300 dpi"). E's `insertWorkflows` hard-codes null and is local to its file.
  - Port legacy `test/integration/reconcile-context.ts` as a local helper.
  - 75 of `run-repository.test.ts`'s 80 titles port. The five `RunRepository metering` titles are G's.
  - The run-free test "pages newest first through a keyset cursor" is legacy's own title under `"OrderRepository.listOrders"`, so it becomes legacy's.
- **Query-plan capture.** Legacy's `runInRepositoryCountingRows` / `planOf` is not here, and the `"OrderRepository.listOrders query plans"` statements are dynamic. Capture the compiled statements with `Statement.CurrentTransformer` (`refs/effect/packages/effect/src/sql/Statement.ts`, `self => Effect.sync(() => (captured.push(self.compile()), self))`), then ``sql.unsafe(`explain query plan ${q}`, params)``. The lead's reviewer verified this on `@effect/sql-sqlite-node`.
- **Check-first result** (verified read-only on `node:sqlite` 3.53.4 against the actor's DDL): `runListItems`' plan has `SEARCH m USING INDEX RunTask_teamId_idx (teamId=? AND doneAt=?)` and no `SCAN` of `s|m|r|p`. Legacy's title holds in unit, and no integ fallback is expected. The implementer still records the plan text.

**Step 3**

- **The fixture stores `after` already applied** (`fixtureRows` writes `after`'s `cancelledAt`, `fulfillmentStatus` and `currentQuantity`). Reconcile would then never see the placed order.
  - **Build to:** `fixtureRows` stores the order as placed. `ActorFixtureRows` carries, per order, its `after`, the progress (per item, or the order's keys without `note`) and each item's chosen workflow as the minted `WorkflowRow.id`.
  - Change `fixture.test.ts`'s two baked-row titles ("gives fixture orders their prefixed ids and applies `after`", "builds line items by position, with `after`'s quantity last") and record the change.
- **`by` needs the fixture's members inside the actor.** Legacy `memberActorOf` reads the seed's member list in order, `{ memberId, email, teamIds }`, never D1; "that team's first member" is the first in that list on the task's team. `fixtureRows` derives the list from `data.members` order and `identity.teamMembers` and passes it in `ActorFixtureRows`. Progress with neither `by` nor `byMerchant` is recorded as the merchant (legacy used the seeding member, which has no counterpart here); record it.
- **`AddToFixture` would reconcile against no teams.** `Fixtures.add` calls `actors.addFixture` before `members.addToShop` (D1), so every fixture workflow would read as not eligible.
  - **Build to:** split the actor call. `addFixture` inserts and checks conflicts as today; D1 `addToShop` runs; then a new stub method `applyFixture(rows)` applies the work and reconciles all. `Fixtures.load` calls `applyFixture` after `replaceShop` too, so both share one path.
  - Writing D1 first is refused: an actor `Conflict` would leave D1 rows behind.
- **Building `notify` and `makeRuns`.** Build `makeRuns({ …, notify: rawNotify })` right after the repositories. It returns an Effect, because `Cache` construction is effectful. It exposes `runs.notify`, which clears both memos when the keys name `ORDERS_KEY` and then calls `rawNotify`. Every other sender takes `runs.notify`: `makeOrders`, `makeMembership`, `makeWorkflows`, `removeOrder`, `onOrdersStream` (and its `onError`), the fixture and the sync sinks.
- **`runs.reconcileAll(caller, id)` has error `never`** (the seam's type): `Effect.ensuring(flushUsage)` then `Effect.orDie`.
- **`makeOrders` also takes `flushUsage`.** There are three billing sentences:
  - The webhook flushes with a plain `yield*` after its fetch path only (not on stale or refused).
  - `syncOrder` is wrapped in `ensuring`.
  - `onOrdersStream` puts `ensuring` on the stream call.

  `fetchAndUpsertOrder` loads `yield* reconciler` after the Admin fetch and the null check, before the upsert. The combined `changed` drives the log line, the notice and `Upserted.changed`. Widen `syncFailure`'s parameter type.

- **Cache (check first, done by the lead's reviewer; the implementer confirms):**
  - Use `Cache.makeWith(lookup, { capacity: 32, timeToLive: exit => Exit.isFailure(exit) ? Duration.zero : Duration.infinity })` (legacy `keepSuccesses`; `Cache.make` has one fixed TTL), with `Cache.get` and `Cache.invalidateAll`.
  - Keys are `Data.Class` instances: orders `{ limit, cursor, q, show, team, teams }` and runs `{ teamIds: sorted }`.
  - The memo covers `listOrders`' page and `runListItems` only. `syncState` and `listRecent` are read live.
  - Memo reads stay outside transactions, because the lookup forks.
- **Log lines are legacy's, with the prefix `Runs.`.** Legacy has none for Attach or `memberUnblockRun`: keep none. Drop legacy's `instrumentationIsOn` timing lines (no such switch here). Formats:
  - `runId=` for cancel, note and block or unblock;
  - `task=` for done, reopen and put back;
  - `task= teamId=` for assign;
  - member lines add `memberId=`;
  - `reconcileOrder`: `orderId= created= resized= closed= multiMatch=`;
  - `reconcileAll`: `caller= id= orders= created= multiMatch=`.
- **Member identity in handlers.** `CurrentCaller` is the `ConnectionCaller` union: narrow on `role === "member"`. `MemberCaller`'s fields are unbranded, while `MemberActor` needs `MemberId`, `TeamId` and the domain `Email`. Decode once with Schema in one helper; do not cast.
- **Attach's check order:** line item, then workflow eligible (D1 teams read first), then order open, then units, then `setRun` `None` → `AlreadyExists`, then notify, then `Ok { run, replaced }`; `ensuring(flushUsage)`. **Assign:** `requireTaskAction`, then `teamExists` (D1, read before the write's transaction) → `TeamNotFound`, then the write. **`runResult`:** `RunNotFoundError` → `NotFound`; Terminal, Blocked, OrderClosed, NotAllowed, NotBlocked and TaskNotReady → `NotAllowed`.
- **Titles.**
  - The 19 `callables:` titles are templates: `` `callables: ${renderRow(…)}` ``. Render them with Step 1's command plus the prefix.
  - The seed titles are under legacy's `"ShopAgent seed callables"`. Add "the seed publishes once to every screen" and "a seeded order is placed placedDaysAgo days before now, in the order given"; the two metering seed titles are G's.
  - "a refused call publishes nothing" already exists (`test/integ/workflows.test.ts`). The run half is a second test with the same title, in `runs.test.ts`.
  - E's title to replace is "setupFacts after a team with a member and an active workflow holds the first two; a run waits for runs". Its sibling "setupFacts on a shop with no team and no workflow holds none of the three" is replaced by legacy's "each step is undone on an empty shop and done once its fact holds".
  - `memberAs` in `socket-facts.test.ts` is local with `teamIds: []`; `runs.test.ts` needs its own with real team ids.
- **Stale JSDoc to fix in Step 3:** `shop-actor.ts`'s no-op `reconcileAll`, `workflows.ts`'s seam note, `order-repository.ts`'s "Nothing passes one yet", `contract/shop-actor.ts`'s `teamIds` "nothing reads it yet", `fixture.ts`'s two.

**Step 4**

- **Team names are not on the gate's caller.** `ShopAccess.member` drops `MemberAccess.teams`' names, keeping only `teamIds`.
  - **Build to:** add `ShopAccess.resolveMember({ key, cookie })` → `{ caller: MemberCaller, teams }` for the member loaders. Never put names on `MemberCaller`, which travels in a header.
  - The `api.test.ts` fake grows the same way.
- **The member loaders answer legacy's loader data.**
  - `workflowsList(request, { key, state, team, limit, q })` → `{ memberId, memberEmail, teams, query, list }`. `team` is free text in the URL (≤ `TEAM_SEARCH_MAX`); the Backend resolves it against the member's teams, so an unknown team is `null`, and builds the `RunQuery`.
  - `memberWorkflowPage(request, { key, runId })` → `{ memberId, memberEmail, teams, page }`.
  - Every method takes `(request, payload)`, so `orderDetail(request, { sessionToken, legacyId })`.
- **Unit refusals.** `ShopNotInstalled` applies to `orderDetail` and `listOrders` only. The member loaders test 401 → `Unauthorized`, 403 → `Forbidden`, 404 → `NotAShopMember` and 503 → defect, each with no actor call, as `shopSnapshot`'s tests do.
- **`ApiWorkflowsList` and `ApiMemberWorkflowPage` carry a `cookie`** in their payload and pass `{ cookie, ip: undefined }`, because `IntegHandlers`' `noRequest` has no cookie. `ApiOrderDetail` follows `ApiWorkflowsPage`.
- **`member-area.test.ts`.** "is gated by membership like the shop page" becomes data versus `NotAShopMember` for another shop. "requireMember admits every member of a subscribed shop" needs plan seats, so it is G: listed as moved.

**Steps 5–6**

- **Legacy names that are not separate parts.** `StripCell` is a type, `RowHead` an interface, and `TextModal` is private to `RunTextModals`. `MemberRun` also exports `blockedByLabel`. Import `closedReasonText` from the domain (`shop-work.ts`).
- **`Screen.ts` rows** go into each part's JSDoc as the existing parts carry them: a markdown table `part | job | component | fixes | used on | never` (see `SearchLine.tsx`). `Name`, `Clamp` and `ClampedProse` carry legacy's text rows ("capped name", "Shopify text", "free text").
- **Missing helpers to port:**
  - `formatDate`, `formatTime`, `formatRelative` and `formatStatus` (legacy `src/lib/format.ts`; `formatNumber` is already in `platform.ts`)
  - `changeWarning`, `cancelHeading`, `CANCEL_WARNING` into `src/web/components/change-warning.ts`, with the test at `test/unit/web/components/change-warning.test.ts`
  - `ANY_OPTION_VALUE` ("any")
  - `ORDERS_ARRIVAL_INPUT` and `ORDERS_STRIP`, beside `ORDERS_PAGE_SIZE` in `shop-actor-client.ts`

  `RUN_PAGE`, `RUN_LIMIT_MAX`, `clampRunLimit` and `DONE_WINDOW_MS` already exist.

- **Result messages are per screen.** The merchant `attachResultMessage`, `assignResultMessage` and `runResultMessage` live in the order page's module; NotFound reads "That workflow is no longer on this item". The member `runResultMessage` lives in the member run actions; NotFound reads "This workflow no longer exists". Do not share them. Port `errorMessage`. Legacy's `textOrNull` trims by hand, so here it is an Effect Schema decode.
- **`appHref` cannot carry `show` or `team`.** Add both to `PAGE_KEYS` in `-app-search.ts`.
- **`app.orders.tsx` becomes a layout** (`<Outlet />`, `lenientSearchKey` for `q`, `show`, `team`, `after`) and its loader moves to `app.orders.index.tsx`, both as `app.workflows.tsx` and `app.workflows.index.tsx` do. Paging is `s-table` `paginate`, as `MembersIndexPage.tsx`. `from-shopify`: a missing or empty `id` goes to `/app/orders`.
- **The home strip** lives in `<s-section heading="Orders">` with `<SocketBanner />` (legacy). Cells take `{ href, onClick }` (`useNavigateOnClick` and `appHref`), because `/dev/kit` is outside the admin.
- **`search-params.test.ts`'s two non-flag titles** test `lenientSearchKey` itself over a generic key: "an unreadable value reads as absent, as an explicit undefined that replaces the raw text" and "a readable value decodes, and an absent key stays absent".
- **e2e: a real test order can never get a run.** `createTestOrder` makes a custom line item with no product, and reconcile matches product tags. Real orders serve only "orders screen syncs open orders and lists them" and "the orders index links each order to Shopify"; every run title arranges through `AddToFixture`. Legacy's fixed order numbers become per-test numbers. Title 11's "No workflow … only the unnarrowed counts see it" cannot be exact on a shared store: assert its own orders and record it. The two home strip titles drop `Issues, 1` for the same reason.
- **Specs the plan does not name that break, adapted in Step 6:**
  - Slice A's three `orders.spec.ts` titles: the default Show is Making, so open with `?show=all` or search by name.
  - `orders-pages.spec.ts`'s two titles: their orders have no items, so use `?show=all`; "Next page" becomes the table's pager.
  - `home.spec.ts`'s guide title asserts "2 of 3 done" and "Not done" on the shared store, which breaks once any spec creates a run. Assert the first two facts only, leave the third to integ, and record it.

**Step 7**

- **Landing is decided in three places, not one.** They are `BackendApi.requestMagicLink`'s `callbackURL: returnTo ?? "/shop"` (and `IntegRpcs.IssueMagicLink`'s copy), `sign-in.tsx`'s `redirect({ to: homeFor(me.role) })`, and `homeFor` in `src/web/client/session.ts`.
  - **Build to:** legacy's `/login-callback` route (`refs/baton-legacy/src/routes/login-callback.tsx`) as `src/web/routes/login-callback.tsx`: one shop goes to `/shop/<key>/workflows`, otherwise `/shop`. It is the default `callbackURL` and sign-in's signed-in redirect for a member; `returnTo` still wins. Port its title "sends a one-shop member to their workflows list and a two-shop member to /shop".
  - Never put the landing in `/shop`'s index loader. That breaks `http.spec.ts`, `shell.spec.ts` and Your stores.
  - **Update the e2e waits** to the landing: `auth.setup.ts`, `screens.ts` `signInWithForm`, `fixtures.ts` `ownMember`, `sign-in.spec.ts`, and `shell.spec.ts`'s "the member home lists the member's one shop and opens it".
- **What `shop.$key.tsx` also needs from legacy `shop.$shop.tsx`:**
  - `search.middlewares: [retainSearchParams(["state","team","q"]), stripSearchParams({ state: DEFAULT_WORKFLOWS_LIST_STATE, limit: RUN_PAGE })]`
  - the `HistoryState.fromWorkflowsList` augmentation beside `nextPage`
  - refusals thrown: `notFound()`, and `redirect` for 401

  Port legacy's CSS: `.row-head*`, `.resource-row-menu`, `.page-body`, `.member-area`, and the print rule `.print-hide, s-button { display: none }`. The bar gains `print-hide`. `BackLink` gains an `onNavigate` for `history.back()`.

- **3401 has no hook.** `closeOutcome` maps it to `"lost"`, which retries. Add an `onRevoked` signal from `retryPolicy`'s `onError` that the layout turns into `router.invalidate()`. Invalidate on 4404 as well, so the loader renders "No access" once `ShopPage` (which rendered `notAMemberAtom`) is gone.
- **The bar.** `MemberBar` is rendered by `shop.tsx` with `TopBar({ title, to })`. Inside `$key`, it reads the key (`useParams({ strict: false })`) and names the shop; its mark opens `/shop/<key>/workflows`.
- **Counts.** `member-area.member.spec.ts` has five titles, none lapsed.
  - "a non-member gets the same confirmation and no link" already exists in `sign-in.spec.ts`.
  - "an anonymous visitor is bounced from the member area to /login" is covered by `shell.spec.ts`'s sign-in bounce (`/sign-in` here).
  - That leaves three to port; list the mapping.
- **"removing a member from a team empties their open workflows list"** cannot be arranged in the member (chromium) project: no merchant socket, and no new `DevRpcs`. It moves to integ (merchant removes the team member, then the member's `MemberListRuns` is empty after the 3401 reconnect) under the same title; list it as moved.
- **Other specs to update:**
  - `actor-upgrade.spec.ts`'s not-a-member title, which uses `ShopPage` copy and the count.
  - `shop.spec.ts`'s removal title: the copy becomes "You no longer have access to this store.". Drop its `mode: "serial"`.

**Step 8 and §5**

- **The glossary has four rows, not three.**
  - **live:** the Meaning names four screens; it becomes five (the home strip). Its symbol is `useLiveQuery`.
  - **memo:** "the Cache values in ShopWorkAgent" becomes `makeRuns`' memos.
  - **reconcile all:** `Runs.reconcileAll` and the run repository's `reconcileAll`.
  - **reconcile:** `reconcileItem` and the run repository's `reconcileOrder`.
- **Roadmap §1.1:** the actor tables row and the "Per-shop actor" row ("Procedures are a demo counter.").
- **The bundle check reads the newest entries only:** `ls -t .alchemy/bundles/Backend/_distilled_worker-entry__virtual_alchemy-entry_worker-*.js | head -3 | xargs grep -c "IntegRpcs\|ShopifyFake"`.
- **The "run" copy grep** becomes `grep -rniE "/runs|\bruns?\b" src/web/routes src/web/components src/web/client`. Read only the string and JSX hits.

### Deviations

- 2026-10-18, Step 1: the matrix rows live in a new `test/unit/domain/run-actions.test.ts` (legacy's file name), with "lineItemState has one kind per layout" under `"Domain.lineItemState"` beside them; the word→value maps and the reconcile universe are built in the test (216 fixtures, asserted).
- 2026-10-18, Step 1: JSDoc sweep: legacy tooling sentences (`pnpm spec check`, `scripts/rules-lint.ts`, `scripts/lib/spec.ts`, the controls table in `Screen.ts`, `useLiveQuery`'s throttle, "Always send the key … `onExcessProperty`") are dropped or restated as the rule alone; `initializeSchema` / `ShopAgentSchema.ts` become "the actor's data model"; `RunRepository.x` / `OrderRepository.x` become "the run (order) repository's `x`"; `ShopWorkAgent.reconcileAllNow` / `eligibleContext` become `Runs.reconcileAll` / `Runs.eligibleContext`; `ShopAgent.*` become `Orders.*`, `Runs.merchantAttachWorkflow` or the bare callback name; legacy route and file names become the screen's name. Table cells kept their padding where the row is parsed (the three matrices render unchanged).
- 2026-10-18, Step 1: rule 14's "where" cell names `onOrdersStream`, `onOrdersSyncEmpty` (this repo has no completion callback; the stream and the empty callback clear the tracking record).
- 2026-10-18, Step 2: `currentWhere` is `src/backend/shop-actor/current-where.ts` (review); `makeRunRepository(sql, transaction, countOrder)` positional, with a `CountOrder` type. The order repository's run-aware `listOrders` reads without a transaction, as legacy; the run-free read stays as `listOrdersRunFree` for its callers until Step 3 (review).
- 2026-10-18, Step 2: legacy JSDoc that was false here is restated: "Durable Object SQLite refuses to nest" (on `OrderUpsert.afterWrite` too), `ShopAgent.publish`, `initializeSchema`, the two "Pinned by '… reads at most N rows …'" sentences (dropped). The order repository's module JSDoc now says what it leaves out (billing).
- 2026-10-18, Step 2: run-repository tests port 75 of legacy's 80 titles (the five `RunRepository metering` titles are G's); the recording `countOrder` has its own describe "RunRepository countOrder" (three new titles); `seedStepped` writes its workflow straight to SQL with `instructions`; legacy `reconcile-context.ts` is a local helper. Data-model's eleven run titles are in `test/unit/backend/shop-actor/data-model.test.ts` under "data model".
- 2026-10-18, Step 2: the order repository's eight `OrderRepository.listOrders*` describes port 20 legacy titles, none dropped (no rows-read title is in them); one new title for `getOrderByLegacyId` and `getLineItem`. Runs and tasks there are written straight to SQL. This repo's run-free "pages newest first through a keyset cursor" is replaced by legacy's own version; "the dev fixture's rows decode through the repository" reads items through `getOrder`.
- 2026-10-18, Step 3: `makeRuns` also takes `transaction` (for the fixture's per-order reconcile) and exposes `notify` (the actor's, memos cleared first on `ORDERS_KEY`) and `applyFixture`; the actor names it `notify` and every sender uses it. `RunMember` (`Required<MemberActor>`) is the member identity the member writes take; the actor decodes it once from `CurrentCaller` (`currentMember`, Schema over `MemberId`, `Email`, `TeamId`).
- 2026-10-18, Step 3: the orders read's consumers moved here (review): `ListOrdersRequest` spreads `ListOrdersInput`, `merchantOrdersQuery` / `merchantOrdersAtom` are keyed by the whole `ListOrdersInput` (serialization key from its five fields), `seedOrders` seeds `OrdersIndexData`; `OrdersListInput`, `OrdersListPage` and `listOrdersRunFree` are deleted.
- 2026-10-18, Step 3: the interim orders screen reads `show: "all"` (no search, no team), so slice A's screen keeps listing every stored order until Step 6's full index (whose default is Making); its Status badge now reads the row's run counts and Items its `itemUnits`.
- 2026-10-18, Step 3: `fixtureRows` stores each order as placed and carries `work` (per order: each item's chosen workflow id and its progress, the item's own or the order's keys without `note`, and `after`) and `members` (`{ memberId, email, teamIds }` in fixture order); `fixture.test.ts`'s two baked-row titles are renamed "gives fixture orders their prefixed ids and stores them as placed" and "builds line items by position, as placed", and a new title pins the carried work.
- 2026-10-18, Step 3: `ShopActorShape.applyFixture({ rows, caller })` and `ShopActors.applyFixture`; `Fixtures.load` calls it after `loadFixture`, `Fixtures.add` after D1's `addToShop` (review). A Start with no `by` is recorded as the task's team's first fixture member (none: no Start); a Done, block or note with neither `by` nor `byMerchant` is the merchant's.
- 2026-10-18, Step 3: billing seam pins for the orders service are new unit titles under "Orders usage flush" ("the webhook flushes after its fetch path, never on a stale or refused delivery", "Sync from Shopify flushes even when the fetch fails"); `noReconciler` in `test/unit/backend/layers.ts` serves tests that are not about runs.
- 2026-10-18, Step 3: the integ tests are two files: `test/integ/runs.test.ts` (the check-first title "a webhook for an order whose item carries an active workflow's tag creates its run inside the upsert", the 14 `ShopAgent workflow run callables` titles not yet here, the 4 sync-order titles, the 4 setup-facts titles, "the seed publishes once to every screen" and the two role-refusal titles over the run procedures) and `test/integ/run-callables.test.ts` (stage `runcallables`: the 19 `callables:` rows, the three literal titles, five `member workflows list socket` titles, three publish titles and the run half of "a refused call publishes nothing"). Slice E's two setup-facts titles in `test/integ/workflows.test.ts` are removed for legacy's four. The `callables:` rows drive "M" and "m" over sockets; "v" is pinned by the unit matrix only. The setup guide titles assert `setupIsComplete` over `ApiSetupFacts`.
- 2026-10-18, Step 3: `test/unit/backend/shop-actor/runs.test.ts` (23 tests): new titles under "Runs result mapping", "Runs gate and notices" (teams never read while a transaction is open, across reconcile all, Attach, Assign and the reconciler), "Runs usage flush"; legacy's "the list memo" (five titles, counting repository list reads instead of SQL rows; "publish" is `runs.notify([ORDERS_KEY])`; a failed lookup is a defect here), the stream title, and eight "ShopAgent seed callables" titles through `applyFixture`. Dropped: "Home and the orders index read the same listOrders input" (Step 6, `ORDERS_ARRIVAL_INPUT`), the two metering seed titles (G). "a seeded run records its `by` member as the starter and the doer": legacy's second run was the seeding member's; here its Done is the merchant's and its Start the team's first fixture member. "a reseed reconciles the orders it did not replace" arranges the untouched order with `AddToFixture` (here `LoadFixture` replaces every order).
- 2026-10-18, Step 3: `export type Runs` is `Effect.Success<ReturnType<typeof makeRuns<never>>>` (the generic left `R` unknown).
- 2026-10-18, Step 4: the member loaders' wire shapes are in a new `src/contract/workflows-list.ts` (`WorkflowsListRequest`, `WorkflowsListPageData`, `MemberWorkflowPageRequest`, `MemberWorkflowPageData`; legacy's loader data without `shop`); `OrderDetailRequest` joins `src/contract/orders.ts`. `ShopAccess.resolveMember({ key, cookie })` answers `{ caller, teams }` (review); `resolve` reads its `caller`. The Backend decodes the gate's member once (`MemberId`, `Email`, `TeamId`) for the actor's run reads (`memberOf`).
- 2026-10-18, Step 4: the member server functions (`src/web/server/workflows-list.ts`, GET) turn `Unauthorized` into a sign-in redirect back to the screen and `Forbidden` / `NotAShopMember` into `notFound()`, for Step 7's "No access"; `orderDetail` (GET, `src/web/server/orders.ts`) rescues the token as the other embedded loaders do.
- 2026-10-18, Step 4: client atoms: `merchantOrderDetailQuery` / `Atom` (by `legacyId`), `memberRunsQuery` / `Atom` (by the whole `RunQuery`), `memberRunQuery` / `Atom` (by `runId`), each with reactivity `ORDERS_KEY`, a serialization key and a `seed…`; the nine merchant and seven member writes as `Atom.family` mutation atoms keyed by the item, run or task (review).
- 2026-10-18, Step 4: integ loader tests are a new `test/integ/run-loaders.test.ts` (stage `runloaders`): three new titles for the loaders over `AddToFixture` with progress, and legacy's "is gated by membership like the shop page" as data for the member's shop versus `NotAShopMember` for another shop (and `Unauthorized` signed out). "requireMember admits every member of a subscribed shop" moves to G (plan seats). Unit: a new describe "BackendApi run loaders" (orderDetail's refusals before any actor call; the two member loaders' answers, team resolution, and 401/403/404/503 with no actor call).
- 2026-10-18, Step 5: `RunTextModals`' `textOrNull` is a Schema decode (`RunNote`, `BlockReason`; a blank text is null); `TextModal` is generic over the decoded value, so `onSave` / `onBlock` receive `RunNote | null` / `BlockReason | null` and callers trim nothing. The cap is checked before the decode.
- 2026-10-18, Step 5: `Strip` link cells take `{ href, onClick }` (`useNavigateOnClick`'s shape; the review); `StripCell` is a type. `FramedList` is its own part file beside `StepList`. `Clamp`'s JSDoc points to `ClampedProse` for the free-text row; the existing `Prose` row is unchanged. No layout constant added (this repo's equivalent of legacy's `layout.ts` covers these parts).
- 2026-10-18, Step 5: `formatStatus` lives in `src/domain/platform.ts` beside `formatNumber`; `formatDate`, `formatTime`, `formatRelative` are private to `LocalDateTime`. `ClosedLine`, `RunItem` and `BlockBanner` take a `Pick<Run, …>` of the fields they read; `LineItemProperties` keys a pair by index and key.
- 2026-10-18, Step 5: the kit's orders strip and workflows-list labels are local constants until Steps 6 and 7 bring `ORDERS_STRIP` and the list's states; the kit test is renamed "renders every part and run piece at both widths without an error". Browser titles are new (`test/browser/web/components/run.test.tsx`), plus a unit title for `formatStatus`.

- 2026-10-18, Step 6: components `OrdersIndexPage.tsx` (replaces `OrdersPage.tsx`; browser test renamed `OrdersIndexPage.test.tsx`, titles rewritten for the new columns and filters) and `OrderPage.tsx`; the orders layout's keys are in `routes/-orders-search.ts` (`OrdersSearch`, `decodeOrdersSearch`), outside the route file. One `<s-page>` alive: the live reads are `useLiveRead` (`components/live-read.ts`: an idle atom before hydration, then seed and read; a new loader answer for the same key refetches the node, because the router renders a revisited page with its cached loader answer first), the order page's keyed presses are `useKeyedPresses` (`press-waiting.ts`: `registry.set` plus `AtomRegistry.getResult`, as `useAtomSet`'s `promiseExit`), so no row component is swapped in at hydration.
- 2026-10-18, Step 6: the index's filters and pages are a patch over `router.latestLocation`, not the render's keys (legacy's `search: prev => …`): e2e showed a strip click right after a Team change writing the old team back.
- 2026-10-18, Step 6: no second `<SocketBanner />` in the home page's Orders section: the `/app` layout's socket holder already renders it above every page. Fixture orders show neither View in Shopify nor Sync from Shopify on the order page, and the made banner drops its Fulfill in Shopify link for them. The order page's foot line (help) waits for slice I. The error page is the live read failing (heading "Order", "Couldn't load the order."). Sync open orders' and Sync from Shopify's failure copy moved to `components/orders-sync.ts`. `ANY_OPTION_VALUE` is in `components/form.ts`. The kit gains a Select row section; its "Run" and "Run steps" headings became "Workflow on an item" and "Workflow steps" (copy grep).
- 2026-10-18, Step 6: e2e: legacy's nine index titles are in `orders.spec.ts` (after slice A's three, which open `?show=all`), its seven order page titles in `order-page.spec.ts`; helpers in `embedded/orders-screens.ts`. Data per test by `AddToFixture` with names, tags and order numbers of its own; screens open by the App nav (`openOrders`) and the index's search (`openOrder`), not by URL. Changed meaning: "the orders index links each order to Shopify" uses the spec's real order (fixture orders have no Shopify link) and returns by the breadcrumb; "orders screen syncs open orders and lists them" opens the spec's own real order, not the first row; "the orders index searches by order number and clears back to the list" asserts the Workflows nav lands with no `q` and an empty search field rather than a named workflow on page one (the shared store has many workflows), and uses a never-used number of its own for "No order matches"; "a bad filter value reads as no filter" adds 26 making orders of its own so the pager is there; "every issue kind…" opens the team to delete through the teams search, and reads "Issues, N, selected". `orders-pages.spec.ts` opens on a search for its orders' own item title rather than `?show=all` (show=all lists every order the run has added, which can push its two old orders past page two), and pages with "Go to next page". `home.spec.ts`'s guide title is now "the App Home guide marks a team with a member and an active workflow done" (first two facts only); the two strip titles drop the counts.

- 2026-10-18, Step 7, landing: decided in three places (review). `src/web/routes/login-callback.tsx` (loader `resolveLanding` in `server/session.ts`: no session → "Sign-in failed"; admin → `/admin`; member → `memberLanding(shops)` in `client/session.ts`) is the default `callbackURL` (`BackendApi.requestMagicLink`, `IntegRpcs.IssueMagicLink`) and sign-in's signed-in redirect for a member; `homeFor` (the guards) is unchanged. Legacy's title is a unit test of `memberLanding` (`test/unit/web/client/session.test.ts`, describe "login-callback").
- 2026-10-18, Step 7: `BackendApi.shopSnapshot` → `shopAccess` (answers the gate's caller; `ShopSnapshotInput` → `ShopAccessInput`). The layout loader is `getShopAccess` in `server/workflows-list.ts` (not `server/shop.ts`: an exported non-server-fn helper there pulled `backend.ts` into the client bundle, which import protection refuses), sharing a private `memberRefusal` with the two member loaders.
- 2026-10-18, Step 7: 3401 is its own `CloseOutcome`, `revoked` (still retried); `applyCloseOutcome` bumps a new `membershipChangedAtom` on `revoked`, `not-a-member` and `uninstalled` (its members go with it), and the layout's `MembershipWatch` turns each bump into `router.invalidate()`. This is the "onRevoked signal from retryPolicy's onError" (the policy's `onError` is `applyCloseOutcome`). `notAMemberAtom` is gone (nothing read it after `ShopPage`).
- 2026-10-18, Step 7: parts `ResourceRow` (`RowLine`, `RowHead`, `RowMenu`, `insideRow`), `ShowMore`, `PageBody`, plus `MemberArea` (legacy's part, the host of `.member-area`; not in §3's list). `TopBar` takes `home` (`/shop`, or `/shop/$key/workflows` with the key) and carries `print-hide`; `MemberBar` decodes the key from `useParams({ strict: false })`. `BackLink` gains `onNavigate`; `opensElsewhere` moved into `navigate.ts` for both. The kit shows the new parts and the real strip labels (`workflows-list-states.ts`); its test counts 7 linked clickables.
- 2026-10-18, Step 7: `MemberSearch` lives in `routes/-member-search.ts`; `fromWorkflowsList` beside `nextPage` in `-table-pages.ts` (with `useFromWorkflowsList`). The list's controls navigate `from` the route with `search: prev => …` (built from `router.latestLocation`). The member run actions are `components/member-run-actions.ts` (`useMemberRunActions` over the keyed atoms and `useKeyedPresses`; `pending` also while the socket is not `open`, read only after hydration); the screens are `WorkflowsListPage.tsx` and `MemberWorkflowPage.tsx`, one `<s-page>` each with `useLiveRead`. The workflow page's note block is `<div id="note">` (legacy's `s-stack#note`).
- 2026-10-18, Step 7, counter retired: `MemberGetCount`, `MemberIncrement`, `MerchantGetCount`, `MerchantResetCount`, `Count`, `COUNT_KEY` (also out of the reconnect notice), `ShopSnapshot`, `ShopActorShape.snapshot`, `ShopActors.snapshot` (`layerTest` loses its second argument), the actor's count `Ref` and `snapshot`, `getShopSnapshot` / `ShopPageData`, `countQuery` / `countAtom` / `merchantCountQuery` / `merchantCountAtom` / `incrementAtom` / `resetCountAtom` / `seedShop`, and the now-unread client atoms `activationAtom`, `whoAmIAtom`, `merchantWhoAmIAtom`; `ShopPage.tsx` and its browser test; `screens.ts` `shop()`. Kept: `MemberActivation`, `MemberWhoAmI`, `MerchantWhoAmI`, `Activation` (procedures and contract).
- 2026-10-18, Step 7, integ re-anchored: `shop-actor.test.ts` "two sockets share one actor: a write on one notifies both" (a Start on a fixture run of its own member, `MemberListRuns` the read, notice `[ORDERS_KEY]`); "roles: a merchant resets and a member may not; a member increments and a merchant may not" → "roles: a merchant reads the orders index and a member may not; a member reads the workflows list and a merchant may not"; the forged-header title uses `MerchantListOrders`. `socket-facts.test.ts`'s dispatched-close title reads `MemberListRuns` and writes `MemberSetRunNote` on a missing run (`NotFound`). Unit: "BackendApi.shopSnapshot" → "BackendApi.shopAccess", "answers the gate's caller and the actor's snapshot" → "answers the gate's caller". The browser harness guard reads `memberRunsQuery`.
- 2026-10-18, Step 7, decision 5: `WORLD` in `run-callables.test.ts` gains Relay (Cut on Bench, Polish on Idle); the "v" row is titled "callables: a member whose teams hold a task of the run but no current one writes the note and nothing else" (Carol: sees the run, note `Ok`; Block, Start and Done on the waiting Polish, and Unblock after the merchant's block, `NotAllowed`). "removing a member from a team empties their open workflows list" (moved from e2e) is in the same file: a real cookie socket, the merchant's `MerchantSetTeamMember` off Bench, close 3401, then `MemberListRuns` (retried across the reconnect) is empty.
- 2026-10-18, Step 7, e2e (written, not run, per the lead): waits moved to the landing (`auth.setup.ts`, `signInWithForm`, `ownMember` via a new `signInMember`, `sign-in.spec.ts`, `shell.spec.ts`); `own()` moved to `fixtures.ts`; `shop.spec.ts`: "an increment in one window updates the count in another" → "a Done in one window shows in the other window's workflows list", the removal title expects "You no longer have access to this store.", `mode: "serial"` dropped; `actor-upgrade.spec.ts`'s not-a-member title asserts "No access" and no Workflows section. `test/e2e/member-screens.ts` holds legacy's member-runs helpers over per-test `AddToFixture` data.
- 2026-10-18, Step 7, lead's spec fixes (unverified until the post-merge e2e run): `openOrders`' `navLink` is scoped to links into an app (`a[href*="/apps/"]`), since the admin's own Orders link can sit beside the app's. `workflows.spec.ts` "a fresh workflow turns on from the editor, then edits go through the draft": read as the spec racing, not a regression: the reopened window's hoisted Discard can read enabled before App Bridge wires it (the race `openEditor` documents for Edit), so the click is retried until the confirm shows.

### Issues

- 2026-10-18, Step 2: the first full e2e run lost `refresh.spec.ts` to `openApp`'s 10 s hydration wait (1 failed, 4 did not run, 44 passed); the spec alone passed (7 passed, 1.2 min) and a second full run was clean. Step 2 changes no Website code.
- 2026-10-18, Step 3 check first: on workerd a webhook for an order whose item carries an active workflow's tag created its run inside the upsert's transaction through `afterWrite` (the D1 teams read before it): passed (1 test, 9.8 s). No stall; no WAITING.
- 2026-10-18, Step 3 check first (Cache): Effect 4's `Cache.makeWith(lookup, { capacity, timeToLive: exit => … })`, `Cache.get`, `Cache.invalidateAll` hold as the review said; the memos use them with keep-successes (`Duration.zero` on failure, infinity on success) and `Data.Class` keys. Atom family keys compare structurally too (`Equal`), so the orders atom is keyed by the whole `ListOrdersInput`.
- 2026-10-18, Step 3: while removing `OrdersListInput` / `OrdersListPage` from `src/contract/shop-actor.ts` a slice by position also cut the caller, middleware and close-code declarations between them (`MemberCaller` … `MAX_CONNECTIONS_PER_MEMBER`); caught by the diff stat before any check or commit and restored from `HEAD`.
- 2026-10-18, Step 3: integ notes found while finishing the tests: a forged socket is not open until a call has gone over it, so a test expecting a notice calls `…WhoAmI` first; `PubSub.takeAll` waits for at least one item, so draining an empty subscription uses `takeUpTo`; `fileStage` refuses a dash (`runcallables`).
- 2026-10-18, Step 3: test-writing helpers were cut off twice (the run ended while background forks ran, then an API session limit); their files were checked title by title, the three gaps above fixed, and the rest kept.

- 2026-10-18, Step 6: e2e found the live screens kept a stale page: the router renders a revisited page with its cached loader answer, then reloads it, and the node seeded from the first answer kept it until the next notice (fixed in `useLiveRead`). It also found a filter pressed right after another writing the first one's old value back (fixed by patching `router.latestLocation`).
- 2026-10-18, Step 6: a Back out of the orders index to Teams, then Forward, makes the admin load the frame afresh at `/auth/session-token?team=…`, and the frame shows the router's "Page not found". Not fixed here (the session-token bounce, not the orders screens); "a filter change resets the page and replaces history" no longer takes Forward.
- 2026-10-18, Step 6: trycloudflare rate-limited this machine (error 1015) from about 13:57 to 14:56; every `vp run test:e2e` in that window failed to start the web server ("Could not start Cloudflare tunnel: max retries reached"). Not a code fault.
- 2026-10-18, Step 6: hydration flake (`awaitHydration` in `openApp`, `orders.spec.ts` beforeAll) once in a filtered development run, 13:46–13:47; the re-run at 13:47 passed that point. No full-suite run hit it.
- 2026-10-18, Steps 5–6 e2e after the flake-fix merge (e76df60): run 1 (15:32–15:37) lost `embedded/workflows.spec.ts` "editing the tag from the detail page writes immediately and starts no draft" at `awaitHydration` (via `gotoApp`, 15.1 s), 5 did not run. The attachment named one frame request pending with no response head for 15 070 ms: the `getShopifyApp` server function (`/_serverFn/…src/web/server/shopify.ts…getShopifyApp_createServerFn_handler`) through the trycloudflare tunnel. Not the old flake (the proxy fix is in); not investigated further. The one allowed re-run passed whole.

### Command results

- 2026-10-18, Step 1, titles: `node /tmp/baton-spec/titles.ts` (legacy `ShopWork.ts`) and `node /tmp/baton-spec/titles.ts src/domain/shop-work.ts` render the same 10, 9 and 13 rows (`diff` empty, before and after the JSDoc sweep); the test's titles are that output pasted.
- 2026-10-18, Step 1: `vp check` pass (293 files); `vp test` 65 files, 738 tests, 56.5 s; `vp run test:e2e` 49 passed, 4.2 min.
- 2026-10-18, Step 2, check first: `runListItems`' plan on `node:sqlite` (actor DDL): `SEARCH s USING INDEX sqlite_autoindex_RunTask_2 (runId=?)`; `LIST SUBQUERY 2`; `SCAN tt VIRTUAL TABLE INDEX 1:`; `SEARCH m USING INDEX RunTask_teamId_idx (teamId=? AND doneAt=?)`; `CORRELATED SCALAR SUBQUERY 1` / `SEARCH p USING INDEX sqlite_autoindex_RunTask_2 (runId=?)`; `SEARCH r USING INDEX sqlite_autoindex_Run_1 (id=?)`; `CORRELATED SCALAR SUBQUERY 3` / `SEARCH p …`. No SCAN of s, m, r or p: legacy's title holds in unit, no integ fallback. The two `OrderRepository.listOrders query plans` titles hold on `node:sqlite` too.
- 2026-10-18, Step 2: `vp check` pass (298 files); `vp test` 67 files, 851 tests, 55.0 s; `vp run test:e2e` 44 passed, 1 failed, 4 did not run (4.3 min, hydration timeout, Issues); the spec alone 7 passed (1.2 min); second full run 49 passed, 4.4 min.
- 2026-10-18, Step 3: `vp check` pass (301 files); `vp test` 70 files, 932 tests, 48.4 s; `vp run test:e2e` 49 passed, 4.3 min.
- 2026-10-18, Step 4: `vp check` pass (304 files); `vp test` 71 files, 943 tests, 48.8 s; `vp run test:e2e` 49 passed, 5.1 min.
- CHECKPOINT: Backend half done (4d2294a)
- WAITING: the orchestrator reviews and says how Steps 5–7 run.
- 2026-10-18, Step 5: `vp check` pass (314 files); `vp test` 72 files, 957 tests, 61.8 s; `vp run test:e2e` 49 passed, 4.7 min (13:09–13:14).

- 2026-10-18, Step 6: `vp check` pass (327 files); `vp test` 74 files, 969 tests, 60.5 s (15:27–15:28). e2e deferred until after the flake-fix merge (lead's instruction): the last full run (15:08–15:14) had 63 passed, 1 failed, 3 did not run; the failure was "the orders index keeps its filters and page across the order page" at an assertion (Previous pressed before the frame the admin reloaded on Back had hydrated), since given an `awaitHydration` before the press, not yet run. Filtered runs passed: `order-page.spec.ts` 7/7; `home.spec.ts` 3/3; `orders-pages.spec.ts` 2/2; `refresh.spec.ts`, `socket.spec.ts`, `app.spec.ts` all passed after their adaptations; every `orders.spec.ts` title passed in some run, the two history titles not together in a final full run.
- 2026-10-18, Step 6, the known flake (logged by the lead from the implementer's report). A filtered `orders.spec.ts` development run, 13:46–13:47, failed in `beforeAll` at `awaitHydration`; its re-run passed.
- WAITING: orchestrator merges the wt-01 flake fix
- 2026-10-18, Steps 5–6 e2e after the flake-fix merge: `vp check` pass (328 files); `vp run test:e2e` run 1 (15:32–15:37) 61 passed, 1 failed, 5 did not run (hydration timeout, Issues); run 2 (15:37–15:43) 67 passed, 5.7 min, "the orders index keeps its filters and page across the order page" included.

- 2026-10-18, Step 7: `vp check` pass (341 files linted, 402 formatted); `vp test` 75 files, 971 tests, 51.0 s (53 s wall, 16:06). First run lost the moved removal title to a read sent while the socket was down (fixed by retrying the read); the file alone then passed 33/33. No e2e run (lead's instruction). 29 leaked `baton-test-*-ShopActor` directories deleted.
- 2026-10-18, Step 8 (the lead): docs.
  - `docs/glossary.md`: memo, live (adds the home page's orders strip, `useLiveRead`), reconcile and reconcile all now name this repo's symbols.
  - `docs/legacy-port-research.md` §1.1: the per-shop actor row (the counter retired) and the actor tables row (`Run`, `RunTask` read and written, the member area).
- 2026-10-18, Step 8, §5 owed lines (the lead):
  - The count procedures, `COUNT_KEY`, `ShopSnapshot` and `snapshot` are gone from `src` and `test`.
  - `MemberRpcs` has 11 procedures: the nine run procedures, plus `MemberWhoAmI` and `MemberActivation`, which are kept.
  - Every server function slice F added is GET; the two POSTs are older.
  - No uppercase SQL in the two repositories.
  - Bundle check: the three newest Backend entries (15:48–15:58) hold 0 `IntegRpcs` / `ShopifyFake`.
  - Copy grep: the hits are modal ids (`run-note`, `run-block`, `cancel-run`), imports and kit data. No visible copy says "run".
- 2026-10-18, Step 8: `vp check` and `vp test` results in the next line. **No e2e** (the orchestrator runs it after merging wt-01 round 2).
  - Unverified until that run: Steps 6–7's specs, the `openOrders` navLink scope and the `workflows.spec.ts:336` fix.
  - Owed: the two member e2e specs (Needs a decision (Step 7) 1).
- 2026-10-18, Step 8: `vp check` pass (341 files); `vp test` 75 files, 971 tests, 47.5 s (16:09).

### Human steps requested

### Implementation review

2026-10-18, the lead, at the Backend half checkpoint (Steps 1–4, `fd2876f`).

- **Suites, re-run by the lead.**
  - `vp check`: pass (364 files formatted, 304 linted).
  - `vp test`: 71 files, 943 tests, 48.1 s.
  - `vp run test:e2e`, first run: the `install` setup lost `openApp`'s 10 s hydration wait, so 1 failed and 47 did not run.
  - Second run: 48 passed and 1 failed (`embedded/home.spec.ts`, the same wait).
  - Third run: 49 passed, 4.9 min.
  - The flake is the one carried since the orders slice (`orders-slice-plan.md`, `workflows-plan.md` Step 2). Each run loses a different spec at `awaitHydration`, never at an assertion.
- **§5 walked, for the Backend half.**
  - `MerchantRpcs` gains ten procedures: nine writes and `MerchantGetOrderDetail`. `MerchantListOrders` is now on `ListOrdersInput` / `OrdersIndexData`.
  - `MemberRpcs` gains nine.
  - The three added `createServerFn` (`orderDetail`, `workflowsList`, `memberWorkflowPage`) are GET.
  - `ShopActorShape` gained `getOrderDetail`, `listRuns`, `getRunPage`, `applyFixture` and the new `listOrders`.
  - The count procedures and `snapshot` remain; they retire in Step 7, so that §5 line is owed then.
  - `runs.ts` was read handler by handler. Every `transaction(…)` wraps a repository call alone, and the D1 `teams()` read comes before it. `flushUsage` is `ensuring` on reconcile all and Attach, and on the webhook and Sync from Shopify in `orders.ts`. Nothing is nested. `countOrder` and `flushUsage` are `Effect.void` in the actor.
  - No uppercase SQL keyword in the run repository, the order repository or `current-where.ts`.
  - The production Backend bundle's three newest entries hold no `IntegRpcs` / `ShopifyFake`.
  - The copy grep waits for the screens (Steps 5–7).
- **Titles.** Every legacy file Steps 1–4 cite was diffed title by title against `test/` with `grep -rF`. Every title the plan names is present, byte for byte. The absent ones are:
  - billing, slice G's: five `RunRepository metering` and sixteen order-repository cycle and usage titles, plus two `countedAt` / usage-counter seed titles;
  - "Home and the orders index read the same listOrders input" (Step 6, recorded);
  - `member-area`'s other titles (Step 7 or out of scope);
  - titles the plan never named:
    - legacy's decorator-only `shop-agent-callables` titles (no decorators here);
    - three non-run `data-model` titles;
    - "a webhook that moves the order's updatedAt publishes even when no run moved";
    - "the open-orders stream publishes to every screen when it finishes".
- **Code read.**
  - The gate-then-write pattern, the result mappers, Attach's check order, Assign's D1 team check and `applyFixture`'s order follow legacy and the review. The order is: reconcile in its own transaction, then `setRun`, progress, `after` through the reconciler, `reconcileAll` and one `notify`.
  - `RunNotAllowedError({ teamId: "" })` from the gate is legacy's, verbatim.
- **Cleanup.** The lead deleted the 14 `.alchemy/local/baton-test-*-ShopActor` directories its own `vp test` leaked. The 36 older ones predate this slice's runs.

**Fixed by the lead**

- Nothing in code. The plan review's corrections (6e51e68) were built to as written.

**Needs a decision**

1. **How Steps 5–7 run** (the WAITING line): the same implementer, one step per commit, with the lead verifying at the end of Step 7.
2. **The embedded hydration flake.** In this slice it hit 3 of about 9 full e2e runs, each time a different spec at `openApp`'s 10 s `awaitHydration`. Steps 5–7 add many embedded and member specs, which will raise the odds. Options:
   - raise the wait (e.g. 20 s);
   - give embedded specs one Playwright retry;
   - investigate the slow loads in `.logs/e2e`.
3. **Fixture actors with no seeding member.** A Start with no `by` is recorded as the task team's first fixture member. A Done, block or note with neither `by` nor `byMerchant` is recorded as the merchant. This is legacy's rule with the seeding member replaced (review). Confirm, or name a different default.
4. **The interim orders screen** shows every stored order (`show: "all"`) until Step 6 brings the full index, whose default is Making. Fine as an interim step; no action unless Steps 5–7 are split across sessions.
5. **The `callables:` rows' third case** (a member who sees the run but holds no current task) is pinned by the unit matrix only. Integ drives the merchant and the member on the task's team. Accept, or add one integ row.

**Decisions** (2026-10-18; the orchestrator's answers, which the user agreed):

1. Steps 5–7 go to the same implementer, on `main`, one step per commit; the lead verifies at the end of Step 7. No worktree split. The run stops at Step 8's `CHECKPOINT: ready for staging`.
2. **The hydration flake gets no fix in this slice.** A separate thread investigates it in wt-01.
   - Do not change `awaitHydration`, `prepareApp`, timeouts or retries.
   - A failure counts as the known flake only if all three hold:
     - it fails at `awaitHydration`, never at an assertion;
     - the spec passes alone;
     - a full re-run passes.
   - Log each occurrence under Command results: the spec, the run and the time, for matching against `.logs/e2e`.
   - The lead's two occurrences at this checkpoint: run 1 ended about 12:31, at `install.setup.ts`; run 2 ran about 12:31–12:36, at `embedded/home.spec.ts`. Neither spec was re-run alone; the third full run passed.
3. Fixture actors with no seeding member: confirmed as built.
4. The interim orders screen: no action; Step 6 brings the full index.
5. Step 7 adds one integration `callables:` row: a member who sees the run but holds no current task.

**Needs a decision (Step 7)**

1. **The two member e2e specs are not written.** `test/e2e/workflows-list.spec.ts` and `member-workflow-page.spec.ts` (legacy `member-runs.member.spec.ts`' 39 e2e titles and `member-area.member.spec.ts`' three: "a seeded member signs in by magic link, lands on their workflows list, and signs out", "removing a member closes the shop page on their live session", "a member sees the teams they are on, and only those") were cut when the lead stopped e2e work; the helpers they need are in `test/e2e/member-screens.ts`. Write them in the post-merge e2e step, or accept the browser, unit and integ coverage.
2. **The bar names the shop on "No access".** `MemberBar` is the `/shop` layout's and reads the key from the URL, so the not-found page's bar shows the domain the URL already holds and links to its (refused) workflows list. Legacy rendered no bar there. Accept, or hide the shop on the not-found match.

## 8. Out of scope

- Billing (G): `countOrder`'s body, the cycle, the usage outbox and flush, the metering titles, `QuotaBanners`, the lapsed page and the plan half of member access, the home page's plan tiles and Manage plan.
- Help (I): foot line links, the member bar's Help link.
- `scripts/lib/spec.ts`'s parsers; `list-reads-rows.test.ts`'s rows-read counts.
- `merchantListRunsForOrder`, `seedOrders`, `seedWorkflows`.

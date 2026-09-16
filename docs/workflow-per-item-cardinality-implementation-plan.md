# One workflow per line item: implementation plan

Status 2026-09-16: **done, uncommitted**. Typecheck, lint, 296 unit tests and 28 Playwright tests all pass against a reset local shop. The reasoning and every product decision are in
[`docs/workflow-per-item-cardinality-research.md`](./workflow-per-item-cardinality-research.md);
its "Decisions from review, 2026-09-16" list is binding. This document is the order of
work. Like the other implementation plans in `docs/`, it is disposable once the code is
in and any deviations are folded back into the research doc.

Vocabulary is the research doc's. A _run_ (`Domain.WorkflowRun`) is one workflow applied
to one line item. A run is _live_ when its status is not `cancelled` (so `pending`,
`active` and `done` all count: a finished item does not get a second route). An item is
_ambiguous_ when two or more active, startable workflows match its tags and it has no
live run. Line cites are as of commit `83c5d46`; re-grep if they have drifted.

## What changes, in one paragraph

Today reconcile inserts the cross product of line items × matching workflows
(`src/lib/WorkflowRunRepository.ts:886-912`). After this work an item holds at most one
live run, enforced by a partial unique index. A tag match that finds exactly one workflow
starts it; two or more start nothing and the item is recorded as ambiguous, which the
orders index shows as a new stage _Choose a workflow_ and the order page resolves with the
existing picker, now limited to the matching workflows. Manual attach on an item that
already has a live run becomes a replace: cancel the old run, start (or un-cancel) the new
one, in one transaction, with a confirmation in the UI when work has begun. Apply and
Turn on refuse a tag that another _active_ workflow already carries. Turn off and delete
now also run the reconcile pass, because removing one of two matching workflows can
resolve an ambiguity and should start the survivor's runs.

## Ground rules for this work

- **Schema goes into the initial schema, not a second migration.** The app is in
  prototyping and every Durable Object is reset from scratch; every previous column
  addition was made in place inside `"1_initialize schema"` in `src/lib/ShopAgent.ts`
  (there are zero `alter table` statements in the repo). Do the same. **Consequence:**
  once Phase 1 lands, every existing local Durable Object has a stale schema. The dev
  server must be stopped, `.wrangler` state wiped (`pnpm d1:reset` recreates local D1
  and drops the DO storage), the server restarted, and `pnpm seed` re-run before any
  browser check. Tell the user at the Phase 1 checkpoint; do not do it unannounced.
- **The invariant is in the database.** A partial unique index, not only application
  logic, guarantees one live run per item. Every write path (reconcile, attach, replace,
  un-cancel) must be correct under it, and `insert … on conflict` must be written so a
  violation of the new index is a silent no-op, not a thrown `SqlError`.
- **Ambiguity is stored, then derived.** Reconcile writes the ids of the workflows that
  matched each item to a new `OrderLineItem.matchedWorkflowIds` column. "Ambiguous" is
  derived from it at read time (two or more ids and no live run), in TS for the detail
  page and in SQL for the index, so a cancel that leaves an item with two matches and no
  run reads as ambiguous again without another reconcile. `ProductionState` stays
  derived and never stored, as its JSDoc promises (`src/lib/Domain.ts:1292-1297`).
- **One result union per callable, no exceptions for the UI.** New refusals are new
  variants on the existing unions (`ApplyResult`, `ActivateResult`, `AttachResult`, the
  run result), mapped in `ShopAgent.ts` the way the existing ones are, with copy in one
  place per union.
- **Copy is fixed.** See "Copy" at the end. Do not invent variants.
- **Do not remove existing comments.** Update the JSDoc that describes the old
  behaviour (listed per phase); the "why" of each new rule goes inline, never as a link
  to `docs/`.
- Follow `CLAUDE.md`: Effect v4 idioms, namespace imports, lowercase SQL with positional
  parameters, `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep every file it touches),
  no commit.

## Phase 1: domain and schema

Files: `src/lib/Domain.ts`, `src/lib/ShopAgent.ts` (`initializeSchema`).

1. **`OrderLineItem.matchedWorkflowIds`.** Add `matchedWorkflowIds: Schema.Array(WorkflowId)`
   (or the existing id schema for workflows, whichever `WorkflowRun.workflowId` uses) to
   the `OrderLineItem` struct, after `productTags`. JSDoc, inline reasoning: "The active,
   startable workflows whose tags matched this item at the last reconcile, whether or not
   a run was started. Two or more with no live run is an ambiguity the merchant resolves
   from the order page; the picker there offers exactly these. Written by reconcile only;
   the order sync writes `[]` because matching happens after the write, inside
   `afterWrite`." Check every place `OrderLineItem` rows are constructed (the sync in
   `src/lib/OrderSync.ts:113` region, `OrderRepository.ts:312-333`, the local-only seed
   callables, the test fixtures) and give them `[]`.

2. **Schema DDL.** In `initializeSchema`:
   - `OrderLineItem` gains `matchedWorkflowIds text not null default '[]'`.
   - `WorkflowRun` gains the partial unique index, next to the existing two
     (`src/lib/ShopAgent.ts:513-514`):
     ```sql
     create unique index if not exists WorkflowRun_live_item_uidx
       on WorkflowRun (lineItemId) where status <> 'cancelled';
     ```
   - Update the long schema JSDoc (`src/lib/ShopAgent.ts:360-380`) where it says
     "`unique (lineItemId, workflowId)` spans every status so a cancelled run keeps its
     key": add the sentence that the partial index is the one-live-run-per-item rule, and
     that `(lineItemId, workflowId)` is now only the un-cancel key.

3. **`ProductionState`** (`src/lib/Domain.ts:1298-1305`) gains `"multiple_workflows"`,
   placed between `no_workflow` and `in_production` in the literal list. It is a stage:
   it has a chip, a count, a badge and a filter, exactly like `no_workflow`.

4. **`OrderRow`** (`src/lib/Domain.ts:1424-1457`) gains `ambiguousItems: Schema.Number`,
   the count of the order's ambiguous line items. JSDoc: derived per read like `runs`,
   defined as items with two or more `matchedWorkflowIds`, units still to make, and no
   live run.

5. **`productionState`** (`src/lib/Domain.ts:1473-1491`). Its input becomes
   `Pick<OrderRow, "order" | "runs" | "ambiguousItems">`. Add `ambiguous:
ambiguousItems > 0` to the `Match.value` record and a branch
   `Match.when({ cancelled: false, fulfilled: false, canStart: true, ambiguous: true }, () => "multiple_workflows")`
   placed **after** `shipped` and **before** `no_workflow`. That is: an open, paid order
   with any ambiguous item reads `multiple_workflows` even if other items are in
   production. Reasoning, in the precedence JSDoc at `:1459-1472`: an ambiguity is a
   merchant decision that blocks an item the merchant meant to route, so it outranks
   the aggregate stage; a plain unrouted item does not, which is why `no_workflow`
   stays below `in_production`. Note there that `OrderRepository.listOrders` restates
   these branches in SQL and must move with them (the doc already says so; keep it true).

6. **`OpenStageCounts`** (`src/lib/Domain.ts:1519-1526`) gains
   `multiple_workflows: Schema.Number`.

7. **Result unions.**
   - `ApplyResult` (`:894-905`) and `ActivateResult` (`:922-936`) each gain
     `Schema.Struct({ _tag: Schema.Literal("TagTaken"), tag: WorkflowTag, workflowName: WorkflowName })`
     (use whatever the name and tag schemas are called). JSDoc on the union: refused only
     when this workflow is, or is becoming, active and another active workflow carries
     the tag; off workflows may share tags so a replacement can be built before the swap.
   - `AttachResult` (`:2534-2540`): `Ok` gains `replaced: Schema.NullOr(WorkflowRun)`,
     the run that was cancelled to make room, or null.
   - The run result union that `cancelRun` / `uncancelRun` return through `runResult`
     (`src/lib/ShopAgent.ts:852`; find the union in Domain) gains
     `Schema.Struct({ _tag: Schema.Literal("ItemHasRun"), workflowName: WorkflowName })`
     for un-cancel refused because another live run now occupies the item.

8. **`AttachWorkflowInput`** is unchanged. Replace is not a separate input; the server
   decides from the item's state.

9. **Checkpoint (user-facing).** After Phase 1 typechecks, tell the user the schema
   changed and that the dev server needs a stop, `pnpm d1:reset`, restart, and
   `pnpm seed` before any browser verification. Continue with Phases 2 to 5 meanwhile;
   they do not need a running server.

## Phase 2: `WorkflowRunRepository`

File: `src/lib/WorkflowRunRepository.ts`.

1. **`insertRun`** (`:756-811`). Change `on conflict (lineItemId, workflowId) do nothing`
   to `on conflict do nothing` so a violation of either unique index returns no row and
   `Option.none()`. JSDoc: name both indexes and say why the conflict target is
   unqualified.

2. **`reconcileOrder`** (`:828-963`), the creation block at `:886-912`. Replace the
   cross product with, per line item:
   - `matched = startable.filter((workflow) => matchesLineItem(workflow, order, lineItem))`.
   - Write `update OrderLineItem set matchedWorkflowIds = ? where id = ?` with the ids
     (JSON, same `json` helper the file already has). Write it on every reconcile, even
     when unchanged, so the column never goes stale. Do this even when
     `orderCanStart` is false, so an unpaid order already carries its matches when
     payment arrives; skip the insert in that case as today.
   - `hasLive = runs.some((run) => run.lineItemId === lineItem.id)` (the `runs` list is
     already `status <> 'cancelled'`).
   - Insert with `source: "tag"` only when `orderCanStart && !hasLive && matched.length === 1`.
   - `matched.length >= 2` inserts nothing. No flag, no log at warning level; one
     `Effect.logInfo` per ambiguous item in the message format
     `reconcileOrder: shop=… orderId=… lineItemId=… matched=<n>: ambiguous, no run started`
     with the fields annotated.
     Update the function's JSDoc and the comment at `:886` that describes the cross
     product. The "existing runs win" rule needs no code: `hasLive` covers a second
     workflow turned on later.

3. **`ReconcileCounts`** (`:85-90`) gains `ambiguous: number` (items left ambiguous by
   this pass); `NO_COUNTS` and the reduce at `:954-961` follow. `ShopAgent.reconciler`
   logs it (Phase 5).

4. **`createRun`** (`:1025-1028`, contract `:241-255`) becomes **`setRun`**, the replace.
   Same input. In one transaction:
   - Read the item's live run, if any. If it is for the same `workflowId`, return
     `Option.none()` (the caller maps that to `AlreadyExists`, as today).
   - If there is a live run for a different workflow, cancel it exactly as `cancelRun`
     does (`status = 'cancelled', cancelledAt = now, updatedAt = now`). Keep its id.
   - If a cancelled run exists for `(lineItemId, workflowId)`, un-cancel it the way
     `uncancelRun` does (`cancelledAt = null`, then `recomputeStatus`). Otherwise
     `insertRun`.
   - Return `Option.some({ run, replaced })` where `replaced` is the cancelled run or
     null. Adjust the interface type accordingly.
     JSDoc: the merchant's choice on the order page is "this item's workflow is X", and
     un-cancelling a previously cancelled run for X rather than inserting a fresh one is
     the existing recovery semantics of the run key, so steps already done on that earlier
     run come back. Also record why the order of operations matters: cancel first, so the
     partial index is free before the insert.

5. **`uncancelRun`** (`:1088-1103`). Before clearing `cancelledAt`, check for another
   live run on the same item; if one exists, fail with a new
   `RunItemBusyError({ workflowName })` (define next to `RunTerminalError`). Without this
   the update would throw a raw `SqlError` from the partial index.

6. **`countWaitingOrders`** (`:986-1023`). The `not exists (run for this workflow)`
   predicate becomes `not exists (live run for this item)`: an item already routed
   elsewhere will not start on Turn on, so it must not be counted. Items that would be
   ambiguous (another active workflow also matches) are also not started on Turn on;
   exclude them too, by evaluating `matchesTags` against every active workflow in the
   context, not just the one being turned on. The interface takes `StartContext`
   already; if it does not carry the other workflows, extend it. JSDoc: the count is
   "orders that Include them would actually start".

7. **`reconcileAll`** (`:968-984`) is unchanged in shape; its `created` sum stays. Add
   `ambiguous` to `ReconcileAllCounts` if cheap; otherwise leave it and note the
   deviation.

## Phase 3: `WorkflowRepository`

File: `src/lib/WorkflowRepository.ts`.

1. **`requireTagsFree(workflowId, tags)`**, private, next to `requireStartableSteps`.
   Query

   ```sql
   select name, tags from Workflow where id <> ? and activatedAt is not null
   ```

   decode tags, fold both sides the way `matchesTags` does (they are stored folded, so
   plain equality is enough; say so), and on the first overlap fail with
   `WorkflowTagTakenError({ tag, workflowName })` (define next to
   `WorkflowNameTakenError`, `:55`).

2. **`applyDraft`** (`:1268-1304`). After `requireStartableSteps`, and only when the
   workflow's `activatedAt` is not null, call `requireTagsFree(workflowId, draft.tags)`.
   Off workflows are not checked here; Turn on checks them. Update the contract JSDoc at
   `:328-348`.

3. **`setWorkflowActive`** (`:1197-1230`). On the `active === true` branch, after
   `requireStartableSteps`, call `requireTagsFree(workflowId, workflow.tags)` (the
   applied tags, not the draft's). Update the contract at `:276-298` with the case walk
   from the research doc in two sentences: whichever workflow is on holds the tag; the
   swap is turn v1 off, turn v2 on.

4. `updateWorkflowTags` (`:1165-1195`) is unchanged: it writes the draft, and the check
   runs at Apply.

5. **`duplicateWorkflow`** JSDoc (`:236-245`) still describes the old hazard ("would
   start a second, near-identical run"). Rewrite the reason: a copy carrying the
   original's tags could not be turned on at all now (`TagTaken`), so dropping tags saves
   the merchant a refusal, not a duplicate run.

## Phase 4: `OrderRepository`

File: `src/lib/OrderRepository.ts`.

1. **Fragments** (`:75-81`). Add, beside `ANY_RUN` / `OPEN_RUN` / `DONE_RUN`:

   ```ts
   const LIVE_RUN_FOR_ITEM = `select 1 from WorkflowRun r where r.lineItemId = li.id and r.status <> 'cancelled'`;
   const AMBIGUOUS_ITEM = `select 1 from OrderLineItem li where li.orderId = ShopOrder.id and li.unfulfilledQuantity > 0 and json_array_length(li.matchedWorkflowIds) >= 2 and not exists (${LIVE_RUN_FOR_ITEM})`;
   ```

   Use whatever column reconcile uses for "units still to make" (`unfulfilledQuantity`
   today; match `Domain.unitsToMake`). `json_array_length` is SQLite JSON1, available in
   Durable Object SQLite; the Phase 7 repository test is the proof.

2. **`stateFilter`** (`:519-544`). Add
   `multiple_workflows` → `sql.and([OPEN, "fullyPaid = 1", \`exists (${AMBIGUOUS_ITEM})\`])`,
   and add `not exists (${AMBIGUOUS_ITEM})`to the`no_workflow`, `in_production`and`ready_to_ship` branches so the filters stay disjoint and match the TS precedence.

3. **Per-row `ambiguousItems`** (`:603-651` region). One more aggregate per page,
   `select orderId, count(*) from OrderLineItem li where … ambiguous … group by orderId`,
   mapped into `OrderRow.ambiguousItems` (0 when absent).

4. **`openCounts`** (`:704-712`, mapped `:732-737`). Add
   `sum(fullyPaid = 1 and exists (AMBIGUOUS_ITEM))` and subtract ambiguous orders from
   the other three sums the same way the filter does, so the chips add up the way they do
   today. Keep the contract at `:143-154`: counts honour none of the filters.

5. **`getLineItem`** and whatever `readOrderDetail` uses to load line items must return
   `matchedWorkflowIds`; the decoder picks it up if the struct has it.

## Phase 5: `ShopAgent`

File: `src/lib/ShopAgent.ts`.

1. **Result mappers.** `applyResult` (`:653-691`) and `activateResult` (`:736-775`) map
   `WorkflowTagTakenError` → `{ _tag: "TagTaken", tag, workflowName }`. `runResult`
   (`:852`) maps `RunItemBusyError` → `{ _tag: "ItemHasRun", workflowName }`.

2. **`attachWorkflow`** (`:2457-2506`). Call `setRun` instead of `createRun`. `None` →
   `AlreadyExists` as today. `Some({ run, replaced })` → `{ _tag: "Ok", run, replaced }`.
   Rewrite the JSDoc: manual attach is "set this item's workflow"; the definition half
   of the predicate still applies; a live run for another workflow is cancelled in the
   same transaction; the UI, not the server, asks for confirmation, because the server
   cannot know whether the merchant has seen the trail.

3. **`reconcileAll`** (private, `:2309-2331`) currently no-ops when the workflow is off.
   Remove that gate for the two callers that change the active set downward:
   `setWorkflowActive(false)` and `removeWorkflow` (`:2226`). Both must run the pass
   with the fresh `startContext()` so `matchedWorkflowIds` drops the departed workflow
   and any item that was ambiguous between it and one survivor starts the survivor's run.
   `ActivateResult.Ok.started` is therefore meaningful on Turn off too; the toast copy
   handles it (Phase 6). Keep the no-op for `applyDraft` on an off workflow (nothing
   changed for matching). JSDoc the reason on `reconcileAll`.

4. **`reconciler`** (`:2333-2358`) logs `ambiguous` alongside `created/cancelled/flagged`
   in the same message format.

5. **`readOrderDetail`** (`:2369-2390`). `itemWorkflows` stays as it is (every active
   workflow with steps); the page narrows to `matchedWorkflowIds` for an ambiguous item
   itself.

6. **`shop-agent-callables.test.ts`** `CALLABLE_ROLES`: no new callables in this plan, so
   nothing to add; confirm it still passes.

## Phase 6: UI

### 6.1 Orders index, `src/routes/app.orders.index.tsx`

1. **`STAGES`** (`:72-82`): insert
   `{ state: "multiple_workflows", label: "Choose a workflow", count: "multiple_workflows" }`
   between `no_workflow` and `in_production`. Update the comment at `:63-71` if it
   enumerates the stages.
2. **`stateBadge`** (`:122-146`): `multiple_workflows` →
   `<s-badge tone="warning">Choose a workflow</s-badge>`. If the row also has open runs,
   append the same "N active · M done" text the `in_production` branch renders, so the
   merchant sees both facts. Keep the `Blocked` / `Order changed` sub-badges logic.
3. **`stageText`** (`:185-212`) and **`emptyText`** (`:214-226`): a sentence and an
   empty state for the new stage; copy below.
4. `ordersQueryKey` / `OrdersSearch` need no change beyond the enum widening.

### 6.2 Order detail, `src/routes/app.orders.$orderId.tsx`

1. **`PRODUCTION_STATE_BADGE`** (`:134-143`):
   `multiple_workflows: { label: "Choose a workflow", tone: "warning" }`.
2. **State recompute** (`:693-696`): pass `ambiguousItems`, computed in TS from
   `lineItems` and `runs` with the same three conditions as the SQL. Put that helper in
   `Domain` (`ambiguousItems(lineItems, runs)`) so the definition lives once, next to
   `runCounts`.
3. **Per-item render** (`:1211-1218` and the picker at `:1219-1291`). Derive per item:
   `liveRun = itemRuns.find(({ run }) => run.status !== "cancelled")`,
   `ambiguous = !liveRun && item.matchedWorkflowIds.length >= 2 && unitsToMake > 0`.
   - **Ambiguous:** replace "No workflow on this item." with the ambiguity sentence
     (copy below), and render the picker **open by default** with options limited to
     `itemWorkflows.filter((w) => item.matchedWorkflowIds.includes(w.id))`. Button label
     _Choose_. No Cancel button (there is nothing to go back to). Do not seed
     `attachOpen` state for it; render from the derived flag.
   - **No live run, not ambiguous:** as today: "No workflow on this item." plus the
     _Attach workflow_ disclosure, options `itemWorkflows`.
   - **Live run:** the run card as today, and the disclosure button reads
     _Change workflow_, options `itemWorkflows` minus the live run's workflow, action
     button _Change_. On click, if the live run has any step with `startedAt` or
     `completedAt` set, open a confirmation (the app's existing modal or `s-modal`
     pattern; see how `DELETE_WORKFLOW_WARNING` is confirmed on the workflows page) with
     the confirmation copy below; on confirm, mutate. A `pending` run with nothing
     started mutates directly.
   - Cancelled runs keep rendering as today with _Undo cancel_; the `ItemHasRun` result
     from an un-cancel shows its message as an error toast through `runResultMessage`
     (`:59-69`).
4. **`attachMutation`** (`:580-602`): on `Ok` with `replaced !== null`, toast
   _"Changed to <workflow>. <old workflow> was cancelled."_; on `Ok` with `replaced === null`,
   keep today's behaviour. `attachResultMessage` (`:39-47`) needs no new variants.
5. **Banner** (`:1328-1357`): add a `state === "multiple_workflows"` paragraph (copy
   below) beside the `no_workflow` one.

### 6.3 Workflows: switch, editor, shared messages

1. `activateResultMessage` (`src/components/WorkflowSwitch.tsx:48-57`) and
   `applyResultMessage` (`src/routes/app.workflows.$workflowId_.edit.tsx:60-67`) map
   `TagTaken` to the copy below.
2. `startedToast` (`src/lib/workflowShared.ts:77-80`) must read correctly for Turn off
   with `started > 0`; copy below.
3. `turnOnBlocker` / `applyBlocker` (`workflowShared.ts:91-116`) are client-side
   predictions used to pre-disable buttons. Do **not** add the tag check there; it needs
   every other workflow's tags and the server refusal is enough. Note it in Deviations
   if you decide otherwise.
4. `itemTriggerLine` (`workflowShared.ts:46-55`) gains a final sentence only when the
   workflow has a tag: _"Each tag starts one workflow."_ Keep the rest verbatim.

## Phase 7: tests

Harness patterns are in `test/integration/order-repository.test.ts:18-36`,
`workflow-run-repository.test.ts:19-47` (repository level, fresh DO per program) and
`shop-agent-workflows.test.ts:19-111` (ShopAgent level, unique shop name per test).

1. **`domain.test.ts`** (`:50-92` table): add rows for `multiple_workflows` above
   `in_production` and for the `ambiguous && !canStart` case (unpaid stays null / not
   this state). Add `ambiguousItems` helper cases.
2. **`workflow-run-repository.test.ts`**, in the `reconcileOrder` block (`:343-985`):
   - two workflows, distinct tags, one item carrying both → zero runs,
     `matchedWorkflowIds` has both, `counts.ambiguous === 1`;
   - same, then turn one off and reconcile → one run for the survivor;
   - item with a live run, second workflow later matches → still one run, both ids
     recorded;
   - `setRun` on an item with a live run of another workflow → old cancelled, new
     pending, `replaced` is the old run, in one transaction;
   - `setRun` choosing a workflow whose run on this item was cancelled → un-cancel, steps
     preserved;
   - `uncancelRun` when another live run occupies the item → `RunItemBusyError`;
   - the partial index itself: raw `insert` of a second live run throws, `insertRun`
     returns `None`;
   - `countWaitingOrders` excludes items with a live run elsewhere and items that would
     be ambiguous.
3. **`workflow-repository.test.ts`**: `applyDraft` on an active workflow whose draft
   takes an active sibling's tag → `WorkflowTagTakenError`; same draft on an off
   workflow → ok; `setWorkflowActive(true)` with a taken tag → error; turn the sibling
   off first → ok; case-folded overlap is caught.
4. **`order-repository.test.ts`** (`seedStates` at `:243-301`): add an order with an
   ambiguous item (write `matchedWorkflowIds` directly) and one that is ambiguous on one
   item and in production on another; assert the state filter partition and
   `openCounts.multiple_workflows`, and that the other counts exclude them. This test is
   also the proof that `json_array_length` works in DO SQLite.
5. **`shop-agent-workflows.test.ts`** (`attachWorkflow` block `:518-593`): `Ok` with
   `replaced` set; `AlreadyExists` for the same workflow; `TagTaken` mapping through
   `applyDraft` and `setWorkflowActive`; `ItemHasRun` through `uncancelRun`; Turn off
   returning `started > 0` when it resolves an ambiguity.
6. **Playwright.** Extend `e2e/workflows.spec.ts` and `e2e/orders.spec.ts`:
   - seed two active workflows with the same tag through `seedWorkflows` (the local-only
     seed bypasses the definition check, which is what makes this reachable) and an
     order carrying it → the index shows the _Choose a workflow_ chip with a count, the
     order page shows the open picker with exactly two options, choosing one produces a
     run card and the chip count drops;
   - on that run, click _Change workflow_, pick the other, confirm → new card, old card
     cancelled;
   - Turn on a second workflow with a tag the first holds → the refusal toast names the
     first workflow;
   - keep `workflows.spec.ts:255-309` green (its "No workflow on this item." count 0
     assertion still holds).
     Wait for `data-hydrated` / `data-app-interactive` before interacting, as the other
     specs do.

## Phase 8: verification and wrap-up

1. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e --`, `pnpm fmt` (keep
   every touched file). No `#graphql` strings change, so `pnpm graphql-codegen` is not
   needed unless a deviation touches one.
2. After the user has reset and restarted the dev server (Phase 1 checkpoint), verify in
   the embedded admin with Chrome: seed, put the same tag on two active workflows via
   seed, sync an order, and walk the three e2e flows by hand. Screenshot the _Choose a
   workflow_ item state and the confirmation dialog; those two are the review artefacts.
3. **Docs.** In `docs/workflow-tags-concept-and-ux-research.md`, replace the body of
   "Duplicate tags across workflows are fine" (lines 104 to 119) with two sentences
   pointing at the cardinality research doc and stating the new rule, and change
   conclusion item 4's "no uniqueness constraint, no duplicate warning" to "one active
   workflow per tag, refused at Apply and Turn on". In `docs/order-detail-ux-research.md`,
   amend Decision 12 to "one workflow per item, enforced". Leave the rest of both docs.
4. Record deviations under "Deviations" below, then leave the work uncommitted for
   review.

## Copy

| Where                                     | Text                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Orders index chip                         | `Choose a workflow`                                                                                                                    |
| Orders index badge                        | `Choose a workflow`                                                                                                                    |
| Orders index `stageText`, N > 0           | `N orders have an item that matches more than one workflow. Open each one to choose.`                                                  |
| Orders index `stageText`, N = 0           | `No orders are waiting on a choice.`                                                                                                   |
| Orders index `emptyText` for the filter   | `No orders need a workflow chosen.`                                                                                                    |
| Order page badge                          | `Choose a workflow`                                                                                                                    |
| Order page banner, `multiple_workflows`   | `An item on this order matches more than one workflow. Choose one below to start it.`                                                  |
| Item, ambiguous (two)                     | `Two workflows match this item: Engraving and Rush. Choose one.`                                                                       |
| Item, ambiguous (three or more)           | `Three workflows match this item: Engraving, Rush and Gift. Choose one.` (spell out up to five; "N workflows" beyond)                  |
| Ambiguous picker action                   | `Choose`                                                                                                                               |
| Disclosure on an item with a live run     | `Change workflow`                                                                                                                      |
| Change picker action                      | `Change`                                                                                                                               |
| Change confirmation, title                | `Change workflow?`                                                                                                                     |
| Change confirmation, body                 | `Engraving has 2 of 4 steps done. Change to Rush anyway? Those steps will not carry over.` (use "1 of 4 steps started" when none done) |
| Change confirmation, actions              | `Change workflow` / `Keep Engraving`                                                                                                   |
| Toast, attach replaced                    | `Changed to Rush. Engraving was cancelled.`                                                                                            |
| `ItemHasRun` (un-cancel refused)          | `This item is already on Rush. Cancel that run first to bring this one back.`                                                          |
| `TagTaken` (Apply and Turn on)            | `“engraved” already starts Engraving. Turn Engraving off first, or change this tag.`                                                   |
| `startedToast`, Turn off with started > 0 | `Turned off. N orders moved to the workflow that still matches.`                                                                       |
| `itemTriggerLine` suffix                  | `Each tag starts one workflow.`                                                                                                        |

Workflow names in the copy are examples; interpolate the real ones. Keep the curly
quotes around the tag, matching `itemTriggerLine`.

## Out of scope

- Reading a product's tags outside an order, or warning at Apply that some product
  carries two workflows' tags. Baton has `read_products` only for the order sync and the
  research doc records why the runtime state is needed regardless.
- Reconciling when a team is deleted or a member leaves (changes `canStart`). Existing
  behaviour; unchanged.
- A cap greater than one, a deterministic pick, a `failed` run status, changes to
  `WorkflowLimits.maxWorkflows`.
- Filtering the _Attach workflow_ / _Change workflow_ options by tag match. They stay
  the full active list; only the ambiguous picker narrows.
- Pre-disabling Turn on / Apply on the client for a taken tag.

## Deviations

Record here, as the work lands, anything done differently from the phases above and
why. Keep each entry short: what the plan said, what was done instead, the reason, and
which tests cover it. Fold product-level changes back into the research doc's decisions
list when the work is reviewed.

- **`reconcileAll` split, not un-gated.** The plan said to remove the "off workflow is
  a no-op" gate for the two callers that shrink the active set. Done by splitting the
  private helper in two — `reconcileAllNow(caller, workflowId)` always runs, and
  `reconcileAllIfActive(caller, workflow)` keeps the gate — because `removeWorkflow` has
  no `Workflow` row left to pass by the time it reconciles. Turn on **and** Turn off both
  use `reconcileAllNow`; Apply and the coverage date keep the gate. Covered by
  `shop-agent-workflows.test.ts` "turning one of two matching workflows off starts the
  survivor and says how many".

- **`ReconcileAllCounts.ambiguous` added** (the plan left it optional). It was one
  `reduce` and the reconciler's log line reads better for it.

- **`countWaitingOrders` takes the whole `StartContext`.** `StartContext` did not reach
  it before, contrary to the plan's note; the interface now takes
  `StartContext & { workflow }` and `ShopAgent.countWaitingOrders` spreads
  `startContext()` in.

- **`startedToast` forks on the verb rather than the caller forking the copy.** Turn off
  with `started === 0` keeps the existing "Turned off. Open runs finish."; only
  `started > 0` gets the plan's "N orders moved to the workflow that still matches."
  Losing the reassurance about work in progress on every Turn off would have been a
  regression for the common case. The verb is exported as `TURNED_OFF` so the two halves
  cannot drift.

- **`showModal` added to `polarisModal.ts`.** The Change confirmation is opened from a
  handler that first has to record _which_ item and workflow it is about, so
  `commandFor` / `command="--show"` alone could not open it. The new helper is
  `hideModal`'s counterpart and carries the same reason.

- **The ambiguity sentence and the confirmation body live in
  `app.orders.$orderId.tsx`, not `Domain`.** They are page copy with no second reader;
  `Domain.ambiguousItems` (the count) is the part both pages share and it did go there.

- **`workflow-run-repository.test.ts` "a run of a deleted workflow sits alongside a new
  run on the same line item" was rewritten**, not extended: under the partial index it
  cannot sit alongside. It now asserts the replace, and that the orphan keeps its
  snapshotted `workflowName` while going `cancelled`.

- **The partial-index test proves the index directly and does not try to reach
  `insertRun`'s `on conflict do nothing` through the public API.** Every write path now
  frees the item before inserting, so that branch is unreachable by design; the test
  raw-inserts a second live run (refused), then cancels the incumbent and raw-inserts
  again (accepted), which is what "partial over `status <> 'cancelled'`" means.

- **Two Playwright selectors in the new specs needed scoping, not the code.** On an
  ambiguous item the workflow's name appears four times (the run card plus the open
  picker's `s-option`, native `option` and the select's value), and a strict-mode
  violation is thrown rather than retried, so the spec waits for the _Change workflow_
  disclosure — which renders only once the picker is closed — before naming the
  workflow. And `E2E Ring` is a prefix of `E2E Ring v2`, so the workflows spec needs
  `exact: true` on the holder's link. Both were spec bugs; no product change.

- **The Turn on dialog stays open on `TagTaken`,** which is right (nothing was
  confirmed), so the spec dismisses it before reading the banner behind it.

- **Phase 8.2 artefacts were captured through a throwaway Playwright spec**, not a
  hand-driven Chrome session: the embedded admin needs the `shopify-admin.setup.ts`
  storage state, and reproducing that by hand would have proved less than the seeded
  fixture does. The spec was deleted after the two screenshots.

- **Review fixes, 2026-09-16.** (1) The SQL stage filters and counts excluded a bare
  `AMBIGUOUS_ITEM`, while `Domain.productionState` only reaches `multiple_workflows`
  when the order can start runs; an unpaid order with an ambiguous item and a manual
  run fell out of every bucket. Now one `CHOOSING` fragment
  (`fullyPaid = 1 and exists (AMBIGUOUS_ITEM)`) is what the other stages exclude;
  fixture `#1014` covers it. (2) The order page's per-item ambiguity test used the
  ids intersected with `itemWorkflows`; it now uses the raw id count like
  `Domain.ambiguousItems`, and the intersection only narrows the picker. (3) _Change
  workflow_ is not offered on a `done` run; research doc decision 6.

# Order workflow singleton, `activatedAt`, upfront order runs, and the `/app/order-workflow` route — implementation plan

Plan date: 2026-09-07. Implements every decision in `order-workflow-singleton-and-route-research.md`. Assumes `184bbf9`. Read that document first; this one says what to change, in what order, and what each stage must prove before the next starts.

## Ground rules for the implementer

- **Follow `CLAUDE.md` exactly**: Effect v4 idioms, namespace imports, JSDoc with reasoning inline and no references to `docs/`, no hand formatting, `pnpm fmt` at the end of every stage and keep every file it touches, `pnpm typecheck` and `pnpm lint` after every stage, `pnpm graphql-codegen` after touching any `#graphql` string. Do not commit unless told to; when told, commit to `main`.
- **Effect style on the back end.** Repository methods are `Effect.fn("Name")(function* (...) {...})`. Expected failures are `Schema.TaggedError` classes, caught at the `ShopAgent` callable seam with `Effect.catchTag` and turned into the `Domain.*Result` union the page decodes. No `throw`, no `try/catch`, no `async/await` inside repositories or the agent. Sequence with `Effect.gen`, branch with `Match`/`Option`, never with `null` checks where an `Option` already exists. Immutable data throughout.
- **SQL read cost.** Durable Object SQLite bills every row a statement touches. Never `count(*)` to ask whether something exists: use `exists (select 1 ... )` or `select 1 ... limit 1`. Never `select *` then filter in TS when a `where` can do it. Counting is fine only where the count itself is the answer (`stepCount` on the list, the step limit) and the set is bounded (steps are at most 20). Every new query in this plan is called out with its expected row cost.
- **No second migration.** Every schema change edits `initializeSchema` under `"1_initialize schema"` in `src/lib/ShopAgent.ts`. Local state is wiped with `pnpm d1:reset` and rebuilt with `pnpm seed`. Do not write a migration 2 and do not discuss one.
- **Stages are independent commits.** Each stage ends green on `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the e2e specs it names. Do not start the next stage on a red one.
- **Merchant copy.** The word for an order's date is **placed**. The field names `processedAt`, `activatedAt`, `createdAt` never appear in merchant-facing text. "On" and "off" are the switch words; "pause" appears nowhere, in code or copy.

## Stage 0 — read before writing

Files the plan touches, so the implementer can load them once:

| Area             | Files                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain           | `src/lib/Domain.ts`                                                                                                                                                                                                                                                                                                                                     |
| Schema and agent | `src/lib/ShopAgent.ts` (`initializeSchema` ~`:210`–`:370`, callables `createWorkflow` `:1489`, `updateWorkflow` `:1533`, `applyDraft` `:1604`, `setWorkflowActive` `:1659`, `removeWorkflow` `:1702`, `startContext` `:1756`, `sweepOrderRuns` `:1777`, `reconciler` `:1792`, order detail `~:1835`, `attachWorkflow` `:1943`, `seedWorkflows` `:2533`) |
| Repositories     | `src/lib/WorkflowRepository.ts`, `src/lib/WorkflowRunRepository.ts`, `src/lib/OrderRepository.ts`, `src/lib/OrderSync.ts`, `src/lib/OrdersBulkRepository.ts`                                                                                                                                                                                            |
| Client           | `src/lib/ShopAgentClient.ts`, `src/lib/workflowShared.ts`                                                                                                                                                                                                                                                                                               |
| Routes           | `src/routes/app.tsx`, `app.workflows.index.tsx`, `app.workflows.$workflowId.tsx`, `app.workflows.$workflowId_.edit.tsx`, `app.orders.$orderId.tsx`, `app.orders.index.tsx`, `app.teams.$teamId.tsx`, `shop.$shop.queue.tsx`, `api.dev.seed.ts`                                                                                                          |
| Tests            | `test/integration/workflow-repository.test.ts`, `workflow-run-repository.test.ts`, `shop-agent-workflows.test.ts`, `order-repository.test.ts`, `orders-sync-workflow.test.ts`, `domain.test.ts`; `e2e/seed.ts`, `e2e/fixture.ts`, `e2e/workflows.spec.ts`, `e2e/orders.spec.ts`                                                                         |

## Stage 1 — `activatedAt` replaces `active`; order `createdAt` goes

Pure model change. No UI behaviour changes except the words "created" → "turned on" in two strings. Self-verifying through `pnpm typecheck`.

### 1.1 Schema (`initializeSchema`)

- `Workflow`: replace `active integer not null default 0 check (active in (0, 1))` with `activatedAt integer` (nullable, no default). Update the table JSDoc: `activatedAt` is the on/off switch **and** the coverage date in one column; null is off; set by Turn on to now or to an earlier date the merchant chose; changed by the merchant on the workflow page; cleared by Turn off; never touched by Apply. Say why in the JSDoc: one fact instead of two that must agree, and Apply must not move it because an unpaid order placed while the workflow was on is still that workflow's business when it pays.
- `ShopOrder`: remove the `createdAt` column. Add to the `processedAt` line's JSDoc (on `Domain.ShopOrder`, see 1.2) that Shopify's `createdAt` is deliberately not persisted.

### 1.2 Domain (`src/lib/Domain.ts`)

- `WorkflowFields`: `active: SqliteBoolean` → `activatedAt: Schema.NullOr(Schema.Number)`. Add `export const isActive = (workflow: { readonly activatedAt: number | null }) => workflow.activatedAt !== null;` and use it everywhere `workflow.active` was read. Grep `\.active\b` across `src`, `test`, `e2e`; every hit that is a workflow (not an order run status `'active'`, not `isActive` on a session) changes. The run status literal `'active'` is unrelated and stays.
- `SetWorkflowActiveInput`: becomes `{ workflowId, active: boolean, activatedAt?: number }` where `activatedAt` is honoured only with `active: true` (the Include-them path in Stage 4 sends the earliest waiting order's date). Add `SetWorkflowActivatedAtInput = { workflowId, activatedAt: number }` for the page's Change control.
- `ActivateResult`: unchanged shape. Add `ChangeActivatedAtResult = Ok | NotFound | Off` (`Off`: the workflow is not on, so there is no date to move).
- `SeedWorkflowsInput`: `active?: boolean` stays as the fixture's word; the repository maps it to `activatedAt = createdAt`.
- `ShopOrder`: drop `createdAt`. JSDoc on `processedAt`: _"Shopify's `processedAt`: the date shown under the order number in the admin, the one importers back-date, and the only date Baton compares. Shopify's `createdAt` (the row timestamp) is deliberately not persisted so nobody has to ask which one matters."_
- The `WorkflowType` JSDoc (`~:467`): delete the five-condition trigger paragraph now; Stage 3 replaces the mechanism. Write the new text then, but delete the stale text here so Stage 1 does not carry a lie.
- Rewrite the merchant-copy paragraph on `Domain.Workflow` (`~:484`–`:540`) to the five sentences in the research (§2 "The merchant copy on `Domain.Workflow`"), and replace the "`active = 1` implies at least one step" sentence with "`activatedAt` not null implies at least one step, every one assigned at the moment of Turn on".

### 1.3 Repositories

- `WorkflowRepository`:
  - `setWorkflowActive`: `update Workflow set activatedAt = ${active ? (activatedAt ?? now) : null}`. Keep `requireStartableSteps` on the on path.
  - New `setWorkflowActivatedAt({ workflowId, activatedAt })`: `update Workflow set activatedAt = ${activatedAt}, updatedAt = ${now} where id = ${workflowId} and activatedAt is not null returning *`; empty result → `WorkflowOffError` (new tagged error) if the row exists, `WorkflowNotFoundError` otherwise. Two statements at most, one row each.
  - `listActiveWorkflowDetails`: `where activatedAt is not null`.
  - `requireStartableSteps`: the `steps.length === 0` test is on an already-loaded array and stays. But `applyDraft` and `setWorkflowActive` load steps with `select *` to run it; that is the whole step list (≤20 rows) and is needed for the unassigned check, so it stays. Do **not** add a separate `count(*)`.
  - `replaceWorkflows` (seed): write `activatedAt = ${active ? now : null}`; keep the "active needs steps" check.
- `WorkflowRunRepository`:
  - `canStart`: `Domain.isActive(workflow) && steps.length > 0 && ...`.
  - `matchesLineItem`: `order.processedAt >= (workflow.activatedAt ?? Infinity)` is wrong style; write it as `workflow.activatedAt !== null && order.processedAt >= workflow.activatedAt`. Update its JSDoc: the date rule is placement against Turn on, and it is what makes an edit webhook on an old order safe.
  - `startOrderRunIfReady`, `startReadyOrderRuns`: same substitution for now (`createdAt` → `activatedAt`). Both are deleted in Stage 3; keep them compiling here.
  - `orderColumns` and `decodeOrders`: drop `createdAt`.
- `OrderRepository`: drop `createdAt` from the insert, the upsert `set`, and the column list. `OrderSync.OrderNode`, `toShopOrder`, `orderSyncQuery`, and `OrdersBulkRepository`'s bulk query: drop `createdAt`. Run `pnpm graphql-codegen`.

### 1.4 Agent and client

- `ShopAgent.setWorkflowActive`: pass `activatedAt` through. New callable `setWorkflowActivatedAt` mirroring it, returning `ChangeActivatedAtResult`, publishing `"all"` afterwards. The reconcile-all that both must trigger is added in Stage 3; leave a `// Stage 3: reconcile all` comment out of the code and just do the write here.
- `sweepOrderRuns`: `if (!Domain.isActive(workflow)) return;` for now.
- Order detail (`~:1846`): `if (!Domain.isActive(orderWorkflow.workflow)) return "off";`.

### 1.5 Pages

- Every `workflow.active` read in routes becomes `Domain.isActive(workflow)`.
- `workflowShared.ts`: `ORDER_WORKFLOW_TRIGGER` and `itemTriggerLine`: "Orders placed before this workflow was **turned on** are skipped" replaces "was created". `app.orders.$orderId.tsx` `tooOld`: compare to `activatedAt`, copy "placed before _name_ was turned on".
- The workflow detail page (`app.workflows.$workflowId.tsx`): under the badges, one line: on → `Applies to orders placed since ${formatDateTime(activatedAt)}`; off → nothing (the Off badge is enough). The Change control is Stage 4.

### 1.6 Tests and seed

- Integration tests: every `active: true/false` expectation on a workflow becomes an `activatedAt` expectation (`expect.any(Number)` / `null`). Every `createdAt` on a seeded order goes. Add one repository test: `setWorkflowActivatedAt` on an off workflow fails `WorkflowOffError`; on an on one updates and returns the row.
- `e2e/seed.ts`, `e2e/fixture.ts`, `api.dev.seed.ts`: drop order `createdAt`.
- Run `pnpm d1:reset && pnpm seed` before e2e.

**Done when:** typecheck, lint, tests, and `e2e/workflows.spec.ts` + `e2e/orders.spec.ts` are green, and `grep -rn "\.active\b" src` finds only run-status and session hits.

## Stage 2 — the order workflow is a singleton

### 2.1 Domain

- `export const ORDER_WORKFLOW_ID = "order" as WorkflowId` (decode it through `WorkflowId` once at module scope rather than casting, if the brand allows; otherwise `Schema.decodeSync(WorkflowId)("order")`). `export const ORDER_WORKFLOW_NAME = "Order workflow"`.
- `CreateWorkflowInput`: drop the union; it is the item struct alone, `type` key removed (create is item-only).
- `UpdateWorkflowInput` (rename), `DuplicateWorkflowInput`, `DeleteWorkflowInput`: unchanged shapes; the refusals are repository-side.
- `WorkflowResult`: drop `OrderWorkflowExists`.
- `DeleteWorkflowResult`: add `Singleton`. `WorkflowResult` (used by rename): add `Singleton`. Message in `workflowShared.ts`: "The order workflow can't be deleted or renamed. Turn it off instead."
- `OrderDetailView.orderWorkflow`: `Workflow` (not `NullOr`). `orderWorkflowBlocker` stays.
- `OrderWorkflow` schema: `name: Schema.Literal(ORDER_WORKFLOW_NAME)` is tempting but would break the shared `WorkflowFields` spread; keep `WorkflowName` and enforce the literal in SQL (below).

### 2.2 Schema

In `initializeSchema`, immediately after `Workflow_order_uidx`:

```sql
insert or ignore into Workflow (id, name, type, activatedAt, tags, createdAt, updatedAt)
values ('order', 'Order workflow', 'order', null, '[]', ${now}, ${now})
```

with `now` from `Clock.currentTimeMillis` inside the migration effect (it already has `SqlClient`; add `Clock`). Add a `check (type <> 'order' or (id = 'order' and name = 'Order workflow'))` to the table so no write path can produce a second order workflow under another id or rename this one; `Workflow_order_uidx` stays as the second backstop. One row, once.

### 2.3 Repository

- `createWorkflow`: item-only; delete `requireOrderWorkflowSlot`, `existingOrderWorkflowId`, `OrderWorkflowExistsError`. Keep `requireNoTagsForOrderWorkflow` for `updateWorkflowTags` (it still needs to refuse tags on the singleton).
- `deleteWorkflow`, `updateWorkflow` (rename), `duplicateWorkflow`: `if (workflowId === Domain.ORDER_WORKFLOW_ID) return yield* new SingletonWorkflowError({ workflowId })`. Zero reads.
- `getOrderWorkflow`: `requireWorkflow(ORDER_WORKFLOW_ID)` plus steps; return type loses the `Option`.
- `replaceWorkflows` (seed): delete item workflows only (`delete from Workflow where type = 'item'`); for the fixture's `type: "order"` entry, `update Workflow set activatedAt = ..., updatedAt = ... where id = 'order'`, delete its steps and draft, insert the fixture's steps and draft; when the fixture has no order entry, reset the singleton to `activatedAt = null`, no steps, no draft. The fixture's `name` on an order entry is ignored (log a warning if it differs from `ORDER_WORKFLOW_NAME`). Keep the "at most one order entry" and "active needs steps" checks.
- `WorkflowRunRepository`: `workflows.find(({ workflow }) => workflow.type === "order")` sites can stay until Stage 3 removes them.

### 2.4 Agent and client

- `ShopAgent.removeWorkflow`, `updateWorkflow`, `duplicateWorkflow`: `Effect.catchTag("SingletonWorkflowError", () => Effect.succeed({ _tag: "Singleton" }))`.
- Order detail: `orderWorkflow` is no longer nullable; drop the `=== null` branch.
- `ShopAgentClient`: `getOrderWorkflow` type follows.

### 2.5 Pages (minimal; Stage 5 rebuilds them)

- `app.workflows.index.tsx`: delete `CREATE_ORDER_MODAL`, `orderName` state, `createOrderMutation`, and the empty-state branch of `renderOrderWorkflow` (the row branch stays until Stage 5).
- `app.workflows.$workflowId.tsx` and `_.edit.tsx`: hide **Rename** and **Delete** when `workflow.id === Domain.ORDER_WORKFLOW_ID` (Duplicate is already hidden). Stage 5 moves these pages.
- `app.orders.$orderId.tsx`: `orderWorkflow` non-null; drop the null branch of `orderWorkflowLine`.

### 2.6 Tests and seed

- `workflow-repository.test.ts` `:612`, `:1243` (`OrderWorkflowExistsError`), `shop-agent-workflows.test.ts` `:666`: replace with tests that `createWorkflow` no longer accepts `type: "order"` (type-level), that the singleton exists after migration with `activatedAt null` and no steps, and that delete / rename / duplicate on `ORDER_WORKFLOW_ID` return `Singleton`.
- Every test that created an order workflow by `createWorkflow({ type: "order" })` now uses `ORDER_WORKFLOW_ID` directly and adds steps to it.
- `e2e/fixture.ts:179`: the order entry keeps `type: "order"`; its `name` becomes `"Order workflow"`.

**Done when:** green, and `grep -rn "OrderWorkflowExists\|requireOrderWorkflowSlot\|CREATE_ORDER_MODAL" src test e2e` is empty.

## Stage 3 — order run created with the item runs; reconcile-all on definition change

The largest behavioural change. Read `WorkflowRunRepository.reconcileOrder` (`~:848`–`:1060`) and `attachWorkflow` end to end before starting.

### 3.1 Creation (`reconcileOrder`)

After `inserted` is computed and before `adjust`:

```
const orderWorkflow = startable.find(({ workflow }) => workflow.type === "order");
if (orderWorkflow !== undefined && orderCanStart && order.processedAt >= orderWorkflow.workflow.activatedAt) {
  const hasItemRun = inserted.length > 0 || runs.some((run) => run.lineItemId !== null);
  const hasOrderRun = runs.some((run) => run.lineItemId === null);   // `runs` already holds this order's open runs; add done/cancelled by widening that select to all statuses for lineItemId is null
  if (hasItemRun && !hasOrderRun) yield* insertRun({ workflow: orderWorkflow, teams, order, lineItem: null, source: "tag" });
}
```

Keep it as Effect code, not this pseudocode. Notes:

- `runs` is currently `status in ('pending', 'active')`. The order-run existence test must see cancelled and done order runs too (a cancelled order run keeps its key; recovery is un-cancel, never a second insert). Widen that one select to `where orderId = ? and (status in ('pending','active') or lineItemId is null)`. Same row cost class as today; the order's runs are a handful.
- `insertRun` already refuses a duplicate `(orderId, null, workflowId)` through `WorkflowRun_order_uidx` and returns `Option.none`; rely on that rather than a second read.
- Cancelled item runs do not count as "has item run" for creation: use `runs.some(run => run.lineItemId !== null && run.status !== 'cancelled') || inserted.length > 0`.

### 3.2 Creation on manual attach (`attachWorkflow`)

After a successful item-run insert: if the order workflow is on, `order.processedAt >= activatedAt` **or** this attach is the opt-in (attach ignores the date, and the research keeps "an attached item opts the order in"), and no order run exists for the order, insert one with `source: "manual"`. One `exists` read.

### 3.3 Readiness (`readyWhere`)

Extend the literal so an **order-run** step is ready only when the order has no open item run and at least one done item run:

```sql
(
  ${alias}.completedAt is null
  and not exists (select 1 from WorkflowRunStep p where p.runId = ${alias}.runId and p.completedAt is null and p.stage < ${alias}.stage)
  and (
    exists (select 1 from WorkflowRun r where r.id = ${alias}.runId and r.lineItemId is not null)
    or (
      not exists (select 1 from WorkflowRun i join WorkflowRun r on r.orderId = i.orderId where r.id = ${alias}.runId and i.lineItemId is not null and i.status in ('pending','active'))
      and exists (select 1 from WorkflowRun i join WorkflowRun r on r.orderId = i.orderId where r.id = ${alias}.runId and i.lineItemId is not null and i.status = 'done')
    )
  )
)
```

Every subquery is `exists`, so each stops at the first matching row. Add `create index if not exists WorkflowRun_order_items_idx on WorkflowRun (orderId, lineItemId, status)` to `initializeSchema` unconditionally: the gate runs on every queue read and every step action. Update the `readyWhere` JSDoc: the item runs are stage zero of the order run.

### 3.4 Cancellation of a pending order run

In `reconcileOrder`'s `adjust` pass (or right after it): if the order has an order run in `pending` and every item run on the order is `cancelled` (and at least one exists), cancel the order run. One `update ... where id = ? and status = 'pending' and not exists (open or done item run)`. Active order runs keep their existing flags.

### 3.5 Delete the trigger

Remove `startOrderRunIfReady`, `startReadyOrderRuns`, their interface entries, every call site (`~:1045`, `:1149`, `:1325`), `ShopAgent.sweepOrderRuns` and its calls, and the `optedIn/anyDone/anyOpen/started` query. Rewrite the `WorkflowType` JSDoc: _the order run is created with the item runs when the order first reconciles as paid, or on manual attach; its steps become ready when every item run is done or cancelled with at least one done (`readyWhere`)._

### 3.6 Reconcile-all on definition change

New `WorkflowRunRepository.reconcileAll(context)`: `select id from ShopOrder where cancelledAt is null and fulfillmentStatus <> 'FULFILLED' and fullyPaid = 1` (fulfilled orders are excluded on purpose: reconcile treats fulfilled as terminal, and there is nothing left to make or pack; unpaid orders are excluded because they reconcile when they pay) (add index `ShopOrder (fulfillmentStatus, cancelledAt)` if not present; this is the bounded working set, not the whole window) then `Effect.forEach(ids, id => reconcileOrder({...context, orderId: id}), { concurrency: 1 })`, returning summed counts. Row cost: the candidate ids plus each order's line items and runs; bounded by unfulfilled orders, which is the merchant's live floor.

Call it from `ShopAgent` after: `setWorkflowActive` with `active: true`, `setWorkflowActivatedAt`, and `applyDraft` when the workflow is on. Log `reconcileAll: shop=… workflowId=… orders=… created=…`. Publish afterwards.

### 3.7 Presentation of a waiting order run

- `shop.$shop.queue.tsx`: order-run steps that are not ready because items are open must not appear as claimable. The queue already selects by `readyWhere`, so they simply do not appear; verify, and add a test.
- `app.orders.$orderId.tsx`: an order run in `pending` whose order has open item runs renders its card with the subdued line "Waiting for N items". Derive N from `runs` in hand; no new column.
- `Domain.productionState` and `OrderRepository.listOrders`' SQL forms: unchanged. An order with item runs and a pending order run is `in_production`, which is right.

### 3.8 Tests

- `workflow-run-repository.test.ts` `:2216` and every test that asserted lazy order-run creation: rewrite to assert the order run exists immediately after the first paid reconcile, that its steps are not ready while an item run is open, ready once all are done, that a stock-only order gets no order run, that manual attach on a stock-only order creates one, that all-cancelled item runs cancel a pending order run, and that a second reconcile inserts nothing.
- `reconcileAll`: turning on a workflow with a waiting paid unfulfilled order creates its runs; an order placed before `activatedAt` is untouched; a fulfilled order is untouched.
- `shop-agent-workflows.test.ts`: `sweepOrderRuns` expectations go.

**Done when:** green, and `grep -rn "startOrderRunIfReady\|startReadyOrderRuns\|sweepOrderRuns" src test` is empty.

## Stage 4 — Turn on by count, and the Change control

### 4.1 Count of waiting orders

New `WorkflowRunRepository.countWaitingOrders({ workflowId, workflows, teams })` → `{ count: number; earliestProcessedAt: number | null }`. Candidates: `select o.id, o.processedAt from ShopOrder o where o.cancelledAt is null and o.fulfillmentStatus <> 'FULFILLED'` (paid or not: an unpaid one qualifies the day it pays). For an item workflow, load those orders' line items in one query (`where orderId in (...)` in chunks of 100) and apply `matchesLineItem` with the date check removed, skipping pairs that already have a run (`not exists`). For the order workflow, an order counts when it has at least one non-cancelled item run and no order run. Row cost: the unfulfilled working set and its line items, once per dialog open; acceptable.

Expose as `ShopAgent.countWaitingOrders` (callable, read-only, no publish). Return `Domain.WaitingOrders = { count, earliestProcessedAt }`.

### 4.2 Turn on dialog (both workflow pages)

On opening the Turn on modal, call `countWaitingOrders`. Body:

- count 0: existing trigger sentence only.
- count > 0: existing sentence, then `${count} earlier ${count === 1 ? "order is" : "orders are"} unfulfilled and would match.` and a checkbox **Include them** (unchecked). Turn on sends `activatedAt: earliestProcessedAt` when checked.

The toast after success: "Turned on." or "Turned on. Started N runs on waiting orders." (N from the reconcile-all result; return it through `ActivateResult.Ok` as `started: number`).

### 4.3 Change control (both workflow pages)

Under the badges, on an on workflow: `Applies to orders placed since ${date}` · **Change**. Change opens a modal with an App Home date field, **date only**, defaulting to the current value's date; the stored instant is midnight of that date in the shop's timezone (the `ShopSession` / shop info timezone already loaded for the app; if none is at hand, the browser's). Turn on and Include-them keep storing exact instants; only the hand-chosen date is day-granular, because that is how the merchant thinks of it. Body "Runs start on orders placed on or after this date. Earlier orders are never touched." Sends `setWorkflowActivatedAt`. Toast: "Updated. Started N runs on waiting orders." when N > 0, else "Updated."

**Done when:** green; e2e in `workflows.spec.ts`: turn on a workflow with a seeded waiting order, see the count line, include it, see the run on the order page.

## Stage 5 — `/app/order-workflow`, and the Workflows page goes item-only

### 5.1 Routes

- `src/routes/app.order-workflow.index.tsx`: copy `app.workflows.$workflowId.tsx`, then: no `$workflowId` param (loader calls `getWorkflowDetail(shop, { workflowId: Domain.ORDER_WORKFLOW_ID })`), heading `Domain.ORDER_WORKFLOW_NAME`, no breadcrumb, no More actions menu, no Rename/Delete/Duplicate modals, the "When it runs" trigger box only (delete the item branch), Edit → `/app/order-workflow/edit`. Keep Turn on/off with the Stage 4 dialog, the Live/Draft tabs, the Applies-since line with Change, `AttentionBanner`, `StageFlow`.
- `src/routes/app.order-workflow.edit.tsx`: copy `app.workflows.$workflowId_.edit.tsx`, same removals (no tag editor, no Rename/Delete), breadcrumb `Order workflow` → `/app/order-workflow`, Close → `/app/order-workflow`.
- `app.workflows.$workflowId.tsx` and `_.edit.tsx`: in the loader, `if (params.workflowId === Domain.ORDER_WORKFLOW_ID) throw redirect({ to: "/app/order-workflow" })` (and `/edit`). Delete every `workflow.type === "order"` branch, `ORDER_WORKFLOW_TRIGGER` import, and `shownTags === null` handling; `shownTags` is always tags now.
- `app.workflows.index.tsx`: delete the order section, `renderOrderWorkflow`, the `One per shop` badge, `ORDER_WORKFLOW_TRIGGER` import, and the `Item workflows` heading (keep the subdued description paragraph). `workflows = allWorkflows.filter(Domain.isItemWorkflow)` stays, or better: `listWorkflows` gains `{ type: "item" }` and the filter moves to SQL (`where type = 'item'`); do the SQL form.
- `app.tsx`: `<s-link href="/app/order-workflow">Order workflow</s-link>` after Workflows.
- `app.orders.$orderId.tsx`: the three `orderWorkflowLine` links → `/app/order-workflow`.
- `app.teams.$teamId.tsx:204`: `href={owned.workflowId === Domain.ORDER_WORKFLOW_ID ? "/app/order-workflow" : \`/app/workflows/${owned.workflowId}\`}`.
- `Domain.WorkflowsIndexLoaderData` JSDoc: item only.

### 5.2 e2e

- `e2e/workflows.spec.ts` "the order workflow is created from its own section…" → "the order workflow opens from the nav, has no rename or delete, and turns on after steps are applied".
- New assertions in `orders.spec.ts`: the order page's "Fix the workflow" link lands on `/app/order-workflow`.

**Done when:** green; `grep -rn "type === \"order\"" src/routes` is empty; `routeTree.gen.ts` regenerated by the dev server (do not hand edit).

## Stage 6 — sweep the docs in code

- `Domain.Workflow` vocabulary JSDoc: final pass against the research's five sentences.
- `shopify.app.toml` comment on `orders/paid`: leave as is; it is still true.
- Grep `src` for "created" in merchant strings about workflows and "pause"; both must be empty.
- `pnpm fmt`, keep everything it touches.

## Verification checklist for the whole change

1. `pnpm d1:reset && pnpm seed`; open `/app/order-workflow`: Off, no steps, no Rename/Delete, Turn on disabled with "no steps".
2. Edit, add a step, Apply, Turn on: dialog shows no count on a fresh seed; page shows "Applies to orders placed since …".
3. Seed an order placed earlier, unfulfilled, matching an item workflow; open that workflow's Turn on: count line appears; Include them; the order page shows the item run and the pending order run "Waiting for 1 item".
4. Complete the item run in the member queue; the order run's first stage appears in the queue.
5. Turn the order workflow off: nothing on the order changes.
6. Resync the order: nothing new is created.
7. `pnpm test`, `npm run test:e2e --`.

## Decisions the implementer must not reopen

Singleton with fixed id and fixed name; no delete, no rename, no duplicate for it. Zero steps only before the first Apply. `activatedAt` replaces `active`, set by Turn on, changeable on the page, cleared by Turn off, untouched by Apply. Order run created with item runs, readiness-gated. No catch-up sweeps; reconcile-all after Turn on, Change, and Apply-while-on. `processedAt` is the only order date; `createdAt` is not stored. Sibling nav entry. No migration 2.

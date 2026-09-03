# Workflow runs — spec

Spec date: 2026-09-02. Implements the decisions in `workflow-instantiation-research.md`. Builds on the definitions spec in `workflow-definition-research.md`.

## Goals / non-goals

- Goals: a paid order's matching line items get one `WorkflowRun` per matching workflow, whichever path (webhook, bulk, manual resync) delivered it; runs copy their steps and the line item's personalization; every order upsert from any source reconciles existing runs against line items; team members see and complete steps in the member area; admins see runs per order in the embedded app and can attach a workflow to a line item by hand or cancel a run.
- Non-goals (deferred by decision, schema leaves room): per-order steps, parallel groups, per-unit progress, step kinds/instructions/approval, Shopify writes (tags, fulfillment), notifications, retroactive routing button.

## Vocabulary

- **Run**: one workflow applied to one line item. Code: `WorkflowRun`. Merchant/member copy: "workflow" ("Engraving workflow on Necklace ×2"), never "run" or "job".
- **Run step**: a copied step inside a run. Code: `WorkflowRunStep`. Copy: "step".
- **Current step**: the lowest-position run step with `completedAt is null`.
- **Flag**: attention marker on a run; set by reconcile, cleared by a person.

## Rules (normative)

### Eligibility

```
eligible(order) = order.fullyPaid && order.cancelledAt === null
```

### Tag routing predicate

For each `(lineItem, workflow)`:

```
workflow.archivedAt is null
&& workflow has ≥ 1 step
&& every step's teamId is an active team
&& lineItem.productTags ∩ workflow.tags ≠ ∅
&& lineItem.currentQuantity > 0
&& lineItem.unfulfilledQuantity > 0
&& order.processedAt >= workflow.createdAt
```

Manual attach skips the last four lines (tags, quantity, fulfilled, age) but keeps the first three.

### Run key

`unique (lineItemId, workflowId)`, any status. Create is `insert ... on conflict do nothing`. A cancelled run keeps the key, so neither the sync nor manual attach can create a second one; recovery from a mistaken cancel is **un-cancel** on that run.

### Status

Derived from steps, stored for querying, always written in the same transaction as the step change:

| status      | meaning                                              |
| ----------- | ---------------------------------------------------- |
| `pending`   | no step completed                                    |
| `active`    | ≥ 1 step completed, not all                          |
| `done`      | all steps completed                                  |
| `cancelled` | stopped by reconcile (only from `pending`) or person |

Transitions: `pending → active → done`; `pending → cancelled` (reconcile or person); `active → cancelled` (person only); `cancelled → pending | active` (un-cancel, person only; status recomputed from completed steps); `done` terminal.

### Flags

Column `flag text` nullable, one of `item_removed | quantity_changed | order_cancelled | order_deleted`, plus `flagAt integer`, `flagDetail text` (JSON: `{ from, to }` quantities for `quantity_changed`, else `{}`). Later flag overwrites earlier. Only `active` runs get flagged; `pending` runs are cancelled or updated silently; `done` runs are never touched.

### Sources

`webhook`, `manual`, and `bulk` all create and reconcile runs with the same rules. The age rule in the predicate, not the source, keeps history from starting work. Manual attach is the only path that skips the age rule.

### Reconcile (after every `upsertOrder` with `written: true`)

```
1. runs   := all runs for orderId (any status)
2. items  := all line items for orderId
3. if !eligible(order):
     pending runs → cancelled
     active runs  → flag order_cancelled (only if cancelledAt set)
     stop
4. for item in items where currentQuantity > 0 and unfulfilledQuantity > 0:
     for workflow in matching(item):
       insert run (source 'tag') on conflict do nothing
5. for run in runs where status in (pending, active):
     item := items[run.lineItemId]
     if item missing or item.currentQuantity == 0:
       pending → cancelled ; active → flag item_removed
     else if item.currentQuantity != run.quantity:
       run.quantity := item.currentQuantity
       active → flag quantity_changed {from, to}
6. notifyChanged()
```

Step 4 runs before step 5 so a run created in this pass is not immediately re-examined. Bounded by `lineItems(first: 100) × maxWorkflows 50`; the age rule short-circuits most bulk orders.

### Order delete

`deleteOrder` runs: `pending → cancelled`, `active → flag order_deleted`, `done` untouched. No cascade: `WorkflowRun` has no FK to `OrderLineItem` or `ShopOrder`; display fields are snapshotted.

### Definition edits

Never touch runs. Archiving a workflow stops new runs (predicate) and leaves existing ones. Archiving a team is already refused while it owns definition steps; run steps snapshot `teamName`, and a run step whose `teamId` is no longer active simply shows in nobody's queue until an admin reassigns via cancel + manual attach (accepted; the team guard makes this rare).

## Schema — `src/lib/ShopAgent.ts` `initializeSchema` (append)

```sql
create table if not exists WorkflowRun (
  id text primary key,
  workflowId text not null,
  workflowName text not null,
  orderId text not null,
  orderName text not null,
  lineItemId text not null,
  lineItemTitle text not null,
  variantTitle text,
  sku text,
  quantity integer not null,
  customAttributes text not null,
  source text not null check (source in ('tag', 'manual')),
  status text not null check (status in ('pending', 'active', 'done', 'cancelled')),
  flag text check (flag in ('item_removed', 'quantity_changed', 'order_cancelled', 'order_deleted')),
  flagAt integer,
  flagDetail text,
  createdAt integer not null,
  updatedAt integer not null,
  cancelledAt integer,
  unique (lineItemId, workflowId)
);
create index if not exists WorkflowRun_orderId_idx on WorkflowRun (orderId);
create index if not exists WorkflowRun_status_idx on WorkflowRun (status);

create table if not exists WorkflowRunStep (
  id text primary key,
  runId text not null references WorkflowRun (id) on delete cascade,
  position integer not null,
  name text not null,
  teamId text not null,
  teamName text not null,
  completedAt integer,
  completedBy text,
  unique (runId, position)
);
create index if not exists WorkflowRunStep_teamId_idx on WorkflowRunStep (teamId, completedAt);
```

- `workflowId` no FK: a definition may be archived, never deleted, but the run must outlive any future delete.
- `completedBy` = `MemberId` (opaque D1 id, cross-store, no FK).
- `customAttributes` (personalization) is copied from the line item at creation, JSON like `OrderLineItem.customAttributes`. The queue card reads only the run.

## Domain — `src/lib/Domain.ts`

```ts
WorkflowRunId, WorkflowRunStepId        // NonEmptyString + brand
RunSource   = Literals("tag", "manual")
RunStatus   = Literals("pending", "active", "done", "cancelled")
RunFlag     = Literals("item_removed", "quantity_changed", "order_cancelled", "order_deleted")

WorkflowRun {
  id, workflowId: WorkflowId, workflowName: WorkflowName,
  orderId: String, orderName: String,
  lineItemId: String, lineItemTitle: String, variantTitle: NullOr(String), sku: NullOr(String),
  quantity: Number, customAttributes: Array(Struct({ key, value })), source: RunSource, status: RunStatus,
  flag: NullOr(RunFlag), flagAt: NullOr(Number), flagDetail: NullOr(Struct({ from: optional(Number), to: optional(Number) })),
  createdAt: Number, updatedAt: Number, cancelledAt: NullOr(Number)
}
WorkflowRunStep { id, runId, position: Number, name: StepName, teamId: TeamId, teamName: TeamName, completedAt: NullOr(Number), completedBy: NullOr(MemberId) }
WorkflowRunDetail { run: WorkflowRun, steps: Array(WorkflowRunStep) }

QueueItem {                              // member queue row
  run: WorkflowRun,
  step: WorkflowRunStep,                 // the current step, owned by one of the member's teams
  note: NullOr(String)                   // ShopOrder.note, live
}

// inputs
ListRunsForOrderInput   { orderId: String (max 128) }
AttachWorkflowInput     { lineItemId: String, workflowId: WorkflowId }
CancelRunInput          { runId: WorkflowRunId }
ListQueueInput          { teamIds: Array(TeamId) }                              // server-side only, from MemberAccess
CompleteStepInput       { runStepId: WorkflowRunStepId, memberId: MemberId, teamIds: Array(TeamId) }
DismissFlagInput        { runId: WorkflowRunId, memberId: MemberId, teamIds: Array(TeamId) }

// results
AttachResult   = Union({ _tag: "Ok", run }, { _tag: "AlreadyExists" }, { _tag: "LineItemNotFound" }, { _tag: "WorkflowNotRoutable" })
RunResult      = Union({ _tag: "Ok" }, { _tag: "NotFound" }, { _tag: "NotAllowed" }, { _tag: "NotCurrent" }, { _tag: "Terminal" })
UncancelRunInput { runId: WorkflowRunId }
```

`WorkflowNotRoutable` = archived, zero steps, or an inactive team. `NotAllowed` = the step's team is not in the caller's `teamIds`. `NotCurrent` = a lower-position step is still open. `Terminal` = run is `done` or `cancelled`.

## `src/lib/WorkflowRunRepository.ts` — DO SQLite

`Context.Service` + `Layer.effect` over `SqlClient`, added to `durableRepositoryLayer`. `Effect.fn("WorkflowRunRepository.<op>")`, rows decoded via `Domain`.

```ts
reconcileOrder({ order, lineItems, workflows, activeTeamIds, now })
                                              → { created: number, cancelled: number, flagged: number }
   // the algorithm above; `workflows` = WorkflowDetail[] for non-archived workflows, loaded by the caller once per upsert
createRun({ workflow: WorkflowDetail, order, lineItem, source, now })
                                              → Option<WorkflowRun>          // None on conflict
markOrderDeleted({ orderId, now })            → void
listRunsForOrder({ orderId })                 → readonly WorkflowRunDetail[]
getRun({ runId })                             → Option<WorkflowRunDetail>
cancelRun({ runId, now })                     → void | RunNotFoundError | RunTerminalError
uncancelRun({ runId, now })                   → void | RunNotFoundError | RunTerminalError   // only from cancelled; status := steps all done ? done : any done ? active : pending; clears cancelledAt
listQueue({ teamIds })                        → readonly QueueItem[]
   // join: current step = min(position) where completedAt is null, per run with status in (pending, active); teamId in teamIds;
   // left join ShopOrder for note; order by flag desc nulls last, run.createdAt asc
completeStep({ runStepId, memberId, teamIds, now })
                                              → void | RunNotFoundError | NotAllowedError | NotCurrentError | RunTerminalError
   // one transaction: check team, check no open lower position, set completedAt/completedBy, recompute run.status
dismissFlag({ runId, teamIds })               → void | RunNotFoundError | NotAllowedError
   // allowed when the current step's team is in teamIds; clears flag/flagAt/flagDetail
countActiveRunsForWorkflow({ workflowId })    → number                       // definitions UI badge
```

Transactions: `sql.withTransaction` for `reconcileOrder`, `completeStep`, `createRun`. No nested transactions: `reconcileOrder` is called from inside `upsertOrder`'s transaction, so it must be written as plain statements and composed by the caller. Concretely, `OrderRepository.upsertOrder` gains an optional `afterWrite` effect run inside its transaction; `ShopAgent` passes the reconcile.

## Hook points — `src/lib/ShopAgent.ts`

- `fetchAndUpsertOrder` and `runShopAgentOrdersStream`: on `written: true`, run `reconcileOrder` inside the upsert transaction (see above). Both need `workflows` and `activeTeamIds`; load once per call (webhook/manual) or once per stream (bulk). A stale `activeTeamIds` snapshot for one bulk run is acceptable.
- `deleteOrder`: call `markOrderDeleted` before deleting the order row.
- Every path ends with the existing `notifyChanged()`.

### Embedded app callables (`@callable()`, socket)

```text
listRunsForOrder({ orderId })          → WorkflowRunDetail[]
attachWorkflow({ lineItemId, workflowId }) → AttachResult    // source 'manual'
cancelRun({ runId })                   → RunResult
uncancelRun({ runId })                 → RunResult
```

`attachWorkflow` loads the line item and its order from SQLite, checks the workflow with the first three predicate lines, then `createRun`. `listWorkflows` summary gains `activeRunCount` via `countActiveRunsForWorkflow` for the definitions page.

### Member area (`ShopAgentClient`, server fns)

Plain DO RPC methods, not `@callable()` (the member area has no socket). `ShopAgentClient` gains:

```text
listQueue(shop, { teamIds })                            → QueueItem[]
completeStep(shop, { runStepId, memberId, teamIds })    → RunResult
dismissFlag(shop, { runId, memberId, teamIds })         → RunResult
```

`teamIds` and `memberId` come from `requireMember`'s `MemberAccess` in the server fn, never from the browser. The DO trusts them: the only caller is the worker, and the DO name is the shop.

## Browser

### `src/routes/shop.$shop.queue.tsx` (member area)

- Loader: `requireMember` → `listQueue({ teamIds })`.
- Page: `<s-page heading="Your work">`. Grouped by team when the member has more than one. Row: order name, line item (title, variant, ×quantity), workflow name, step name, personalization summary, order note, flag banner when flagged. Actions: "Done" (complete step), "Dismiss" on flagged rows. Both server fns with `memberServerFnMiddleware` + `requireMember`, then `router.invalidate()`.
- Flagged rows sort first with a warning tone. Copy per flag: item removed from order / quantity changed from X to Y / order cancelled / order deleted.
- Empty: "Nothing to do right now."
- Link from `shop.$shop.tsx` team list.

### `src/routes/app.orders.tsx` (embedded)

- Line-items panel gains a "Workflows" column per line item: run name + current step + status badge + flag badge; "Cancel" action per run.
- "Attach workflow" per line item: `<s-select>` over routable workflows (from `listWorkflows`, filtered client-side by `stepCount > 0 && archivedAt === null`) + button → `attachWorkflow`. `AlreadyExists` → inline message. Cancelled runs show an "Undo cancel" action.
- Query: `listRunsForOrder({ orderId })` keyed by selected order, invalidated on attach/cancel and on `notifyChanged` like orders.

### `src/routes/app.workflows.index.tsx`

- Column "Active runs" from `activeRunCount`. No behavior change.

## Logging

`ShopAgent.reconcileOrder: shop=<shop> orderId=<id> source=<source> created=<n> cancelled=<n> flagged=<n>` with the same fields annotated. `completeStep` and `cancelRun` log `runId`, `step`, `memberId`.

## Tests

`test/integration/workflow-run-repository.test.ts` (harness = `workflow-repository.test.ts`):

- `reconcileOrder` matrix, each seeded with one order, two line items, two workflows (tags `a`, `b`), active teams:
  1. paid, tags match → 1 run per match, steps copied with `teamName`, `source = 'tag'`.
  2. same input twice → no duplicates, counts `created: 0`.
     2b. cancel a run, reconcile again → still cancelled, no duplicate; un-cancel → status recomputed from steps, `cancelledAt` null.
  3. not paid → no runs; later paid → runs.
     3b. same paid order with `source = 'bulk'` or `'manual'` → identical result to webhook.
  4. `processedAt < workflow.createdAt` → no runs; manual attach still works.
  5. `unfulfilledQuantity = 0` → no runs.
  6. line item `currentQuantity → 0`: pending run cancelled; active run flagged `item_removed`, steps intact.
  7. line item row removed (lineItemsComplete reinsert without it): same as 6.
  8. quantity 2 → 3: pending run quantity updated silently; active run updated + flagged with `{from: 2, to: 3}`.
  9. new line item on later upsert → run created only for it.
  10. `cancelledAt` set: pending cancelled, active flagged `order_cancelled`, done untouched.
  11. archived workflow / zero steps / inactive team → no run.
  12. done run never touched by any of the above.
- `completeStep`: wrong team → `NotAllowed`; step 2 before step 1 → `NotCurrent`; step 1 → run `active`; last step → `done`; on cancelled → `Terminal`; `completedBy` recorded.
- `listQueue`: only current steps of the given teams; flagged first; `customAttributes` present on the run after the line item is gone.
- `markOrderDeleted`: pending cancelled, active flagged, done untouched; runs survive `deleteOrder`.
- `dismissFlag`: clears; wrong team `NotAllowed`.

`test/integration/shop-agent-workflows.test.ts` additions: `attachWorkflow` on unknown line item → `LineItemNotFound`; on archived workflow → `WorkflowNotRoutable`; twice → `AlreadyExists`; `cancelRun` on done → `Terminal`; `uncancelRun` on a non-cancelled run → `Terminal`. Webhook path: `syncOrder` on a paid order creates runs (mock admin returns the fixture); duplicate webhook id → no second reconcile; stale `updatedAt` → no reconcile.

`test/integration/shop-agent-orders-stream.test.ts` addition: bulk stream of two paid orders, one older than the workflow → runs only for the newer one; re-stream creates none.

`test/integration/member-area.test.ts` addition: `listQueue` server fn returns only the member's teams' steps; `completeStep` with a foreign `runStepId` → `NotAllowed`.

Browser smoke (optional): pay a seeded order → queue shows step → Done → step 2 appears for the next team → order panel shows `done`.

## Implementation order

1. Schema append + `Domain` types → `pnpm typecheck`.
2. `WorkflowRunRepository` with `createRun`, `listRunsForOrder`, `getRun`, `cancelRun`, `markOrderDeleted` + tests.
3. `reconcileOrder` + `afterWrite` seam in `upsertOrder` + wiring in `fetchAndUpsertOrder`, bulk stream, `deleteOrder` + reconcile tests + webhook/stream tests.
4. `listQueue`, `completeStep`, `dismissFlag` + tests.
5. Embedded callables + `app.orders.tsx` runs column, attach, cancel; `activeRunCount` on workflows list.
6. `ShopAgentClient` methods + `shop.$shop.queue.tsx` + member-area tests.
7. `pnpm typecheck && pnpm lint && pnpm test && pnpm fmt`.

## Deferred hooks

- `WorkflowStep.perOrder`: run steps copy it; `completeStep` on a per-order step completes the same position on every run of that `orderId`; queue collapses them to one row. Needs `WorkflowRun.orderId` (present).
- `parallelGroup` on `WorkflowStep` and `WorkflowRunStep`: "current step" becomes "all open steps in the lowest open group".
- Per-unit progress: `WorkflowRunStep.completedQuantity`.
- Step `kind` / `instructions`: copied onto run steps at creation.
- Retroactive "apply to open orders" button: iterate eligible orders through `reconcileOrder` with the age rule off.

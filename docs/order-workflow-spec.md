# Order workflow — spec

Spec date: 2026-09-04. Implements the decisions in `order-workflow-research.md` → Decisions (2026-09-04). Builds on `workflow-stages-spec.md` (stages, step actions) and `workflow-runs-spec.md` (runs, reconcile).

Written to be handed to an implementer with no other context than this repo. Where this spec and the code disagree, the code's existing conventions win and the spec should be amended.

## Goals / non-goals

- **Goals.** (1) A merchant can define **one** order workflow: steps and stages like any workflow, no tags. (2) When every line-item run on an order is finished and at least one is done, an **order run** starts on that order. (3) Order runs use the existing queue, step actions, flags, cancel, and un-cancel unchanged. (4) A line item that appears after the order run exists flags it `item_added`. (5) Editor, workflows index, queue, and order page render order workflows and order runs.
- **Non-goals.** Tag selection of order workflows, more than one active order workflow, order workflows that start at paid, fulfillment writes, partial shipment, per-order units, an `order_fulfilled` flag, an orders-index column. All deferred; see the research doc → Part 5 and Decisions.
- **No migration.** Prototype: every schema change edits `initializeSchema` in `src/lib/ShopAgent.ts` in place; wipe local Durable Object state and `pnpm seed`.

## Vocabulary

| Concept                                                    | Merchant / member copy                             | Code                                   |
| ---------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| Workflow that runs once per order after the items are made | "order workflow" in labels; otherwise its own name | `Workflow.scope = 'order'`             |
| Workflow that runs on one line item (today's kind)         | "workflow"                                         | `Workflow.scope = 'item'`              |
| The order workflow applied to one order                    | "{workflow name} on #1042"                         | `WorkflowRun` with `lineItemId = null` |
| A run that is `done` or `cancelled`                        | not shown                                          | finished (`isTerminal`)                |
| Marker that a new item arrived after the order run started | "New item: Gift box ×1"                            | `flag = 'item_added'`                  |

## Rules (normative)

### One active order workflow

```text
at most one Workflow with scope = 'order' and archivedAt is null, per shop
an order workflow has tags = []      (refused on create and update)
scope is set on create and never changes
```

Enforced in `WorkflowRepository`, not by a SQL constraint, so the error is a typed `OrderWorkflowExistsError` the UI can name. Archiving the order workflow frees the slot; un-archiving it is refused while another is active (same error).

### Trigger

```text
readyForOrderRun(order, orderWorkflow) =
  isEligibleOrder(order)                                          (fullyPaid, cancelledAt null)
  and isRoutable(orderWorkflow, activeTeams)                      (not archived, ≥ 1 step, teams active)
  and (order.processedAt >= orderWorkflow.createdAt                (age rule)
       or exists run where orderId = order.id and lineItemId is not null and source = 'manual')
  and exists  run where orderId = order.id and lineItemId is not null and status = 'done'
  and not exists run where orderId = order.id and lineItemId is not null and status in ('pending', 'active')
  and not exists run where orderId = order.id and lineItemId is null and workflowId = orderWorkflow.id   (any status)
```

Stock-only orders (no item runs) never trigger. An order whose item runs were all cancelled never triggers. Cancel of the last open item run triggers when another is done.

**Manual attach opts an old order in.** The age rule exists so a bulk backfill never starts work on history. Manual attach already overrides it for the item, so an admin who pulls an old order into production by hand gets the order run too; otherwise the item finishes and the page keeps promising packing that never comes. Tag-routed runs cannot exist on an order older than their workflow, so the exception only reaches orders a person chose.

Evaluated, inside the existing transaction, at the end of:

| Call site              | Why it can complete an order                                |
| ---------------------- | ----------------------------------------------------------- |
| `completeStep`         | `recomputeStatus` may have reached `done`                   |
| `cancelRun` (item run) | last open item run cancelled                                |
| `reconcileOrder`       | cancels pending item runs; also the only path for bulk sync |

`uncancelRun`, `attachWorkflow`, `startStep`, `setStepNote`, `blockRun`, `dismissFlag` never trigger. Cancelling an order run does not re-trigger: the key is single-use, recovery is un-cancel.

### Order run row

Same table. `lineItemId`, `lineItemTitle`, `quantity`, `customAttributes`, `variantTitle`, `sku` are null. `source = 'tag'` (there is no manual attach for order runs in this phase; the value means "created by the rules"). Status, steps, stages, ready rule, `recomputeStatus`, Start / Done / note / blocked: unchanged.

### Flags on an order run

| Event                                                                            | order run `pending`                    | `active`                           | `done`    |
| -------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------- | --------- |
| Item run created after the order run (`reconcileOrder` insert, `attachWorkflow`) | flag `item_added`                      | flag `item_added`                  | untouched |
| Item run un-cancelled                                                            | flag `item_added`                      | flag `item_added`                  | untouched |
| Item run flagged `item_removed` by reconcile                                     | flag `item_removed`                    | flag `item_removed`                | untouched |
| `quantity_changed` on an item run                                                | nothing                                | nothing                            | untouched |
| Order not eligible (cancelled / unpaid)                                          | cancelled (`cancelPending`, unchanged) | flag `order_cancelled` (unchanged) | untouched |
| Order deleted                                                                    | cancelled                              | flag `order_deleted`               | untouched |

`item_added` and `item_removed` on an order run are set on `pending` as well as `active` runs. This differs from item runs, where a pending run is adjusted silently: an order run's premise ("all items made") is what changed, and there is no silent adjustment that restores it. `flagActive` therefore gains a variant, `flagOpen`, used only for order runs. `flagDetail` carries `{ item: lineItemTitle }`.

Dismiss is unchanged: any member whose team owns a ready step of the run, no precondition.

## Schema — `src/lib/ShopAgent.ts` `initializeSchema` (edit in place)

```sql
create table if not exists Workflow (
  id text primary key,
  name text not null check (name = trim(name) and length(name) > 0),
  scope text not null default 'item' check (scope in ('item', 'order')),
  tags text not null,
  createdAt integer not null,
  updatedAt integer not null,
  archivedAt integer
);

create table if not exists WorkflowRun (
  id text primary key,
  workflowId text not null,
  workflowName text not null,
  orderId text not null,
  orderName text not null,
  lineItemId text,                    -- null: order run
  lineItemTitle text,
  variantTitle text,
  sku text,
  quantity integer,
  customAttributes text,
  source text not null check (source in ('tag', 'manual')),
  status text not null check (status in ('pending', 'active', 'done', 'cancelled')),
  flag text check (flag in ('item_removed', 'quantity_changed', 'order_cancelled', 'order_deleted', 'blocked', 'item_added')),
  flagAt integer,
  flagDetail text,
  createdAt integer not null,
  updatedAt integer not null,
  cancelledAt integer,
  check ((lineItemId is null) = (lineItemTitle is null)
     and (lineItemId is null) = (quantity is null)
     and (lineItemId is null) = (customAttributes is null)),
  unique (lineItemId, workflowId)
);
create unique index if not exists WorkflowRun_order_uidx
  on WorkflowRun (orderId, workflowId) where lineItemId is null;
```

`unique (lineItemId, workflowId)` still guards item runs; SQLite treats nulls as distinct there, so the partial index is what makes an order run single-use per `(orderId, workflowId)`. The `check` keeps the four nullable columns null or set together. Update the table-comment JSDoc above `initializeSchema` (`src/lib/ShopAgent.ts` ~line 147) to say a run is one workflow applied to one line item **or to one order**.

## Domain — `src/lib/Domain.ts`

```ts
export const WorkflowScope = Schema.Literals(["item", "order"]);
// Workflow: + scope: WorkflowScope
// WorkflowSummary / WorkflowDetail: unchanged shape (inherit scope)

export const RunFlag = Schema.Literals([..., "item_added"]);
export const RunFlagDetail = Schema.Struct({ ..., item: Schema.optionalKey(Schema.String) });

// WorkflowRun: lineItemId, lineItemTitle, quantity, customAttributes become NullOr.
// variantTitle and sku already are.
export const isOrderRun = (run: WorkflowRun) => run.lineItemId === null;

export const CreateWorkflowInput = Schema.Struct({ name: WorkflowName, scope: WorkflowScope, tags: ProductTags });
// UpdateWorkflowInput: unchanged (name, tags); scope is not editable.

export const WorkflowResult = Schema.Union(..., Schema.Struct({ _tag: Schema.Literal("OrderWorkflowExists") }));

// QueueItem: + items: Schema.Array(QueueOrderItem), populated only for order runs, else []
export const QueueOrderItem = Schema.Struct({
  lineItemId: BoundedId,
  title: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  customAttributes: Schema.Array(OrderAttribute),
  runStatus: Schema.NullOr(RunStatus),      // null: no item workflow on this item
});

// OrderDetailView: + orderWorkflow: Schema.NullOr(Workflow)   (the active one, for the placeholder)
```

Keep one `WorkflowRun` struct with nullable fields rather than a union: every decoder, action, and card reads the same row, and `isOrderRun` is the only branch point.

## `src/lib/WorkflowLayout.ts`

Unchanged. Stages apply to order workflows identically.

## `src/lib/WorkflowRepository.ts`

- `createWorkflow({ name, scope, tags })`: when `scope = 'order'`, refuse `tags.length > 0` with `WorkflowRepositoryError` (programming error, the UI never sends tags) and refuse when an active order workflow exists with `OrderWorkflowExistsError`. Counts toward `WorkflowLimits.maxWorkflows` like any workflow.
- `updateWorkflow`: refuse non-empty tags on an order workflow.
- `setWorkflowArchived({ archived: false })`: on an order workflow, refuse when another active order workflow exists.
- `listWorkflows`, `listActiveWorkflowDetails`, `getWorkflow`: select `scope`; no filter changes. Callers pick `scope === 'order'` in TypeScript.
- `replaceWorkflows` (seed): accepts `scope`, defaults `'item'`.
- New: `OrderWorkflowExistsError` tagged error, mapped to `WorkflowResult._tag = "OrderWorkflowExists"` in `ShopAgent.workflowResult`.

## `src/lib/WorkflowRunRepository.ts`

### Creation

`insertRun` takes `lineItem: Domain.OrderLineItem | null`. With `null` it writes the four nullable columns as null and relies on the partial unique index for `on conflict do nothing` (SQLite: `on conflict (orderId, workflowId) where lineItemId is null do nothing`, matching the index's predicate exactly).

### `startOrderRunIfReady`

Private helper, not on the service interface:

```ts
const startOrderRunIfReady = ({ orderId, workflows, activeTeams }: RoutingContext & { orderId }) =>
  // 1. orderWorkflow = workflows.find(w => w.workflow.scope === 'order'); none → 0
  // 2. order = select ShopOrder; missing or !isEligibleOrder → 0
  // 3. !isRoutable(orderWorkflow) → 0
  // 4. one select over WorkflowRun for orderId: any item run done, no item run open,
  //    any manual item run; order.processedAt < createdAt and none manual → 0
  // 5. insertRun({ lineItem: null }) → Option; log on Some
```

Called with the caller's `RoutingContext`. `completeStep` and `cancelRun` do not have one today; they gain an optional `routing?: RoutingContext` parameter that the Durable Object supplies (it already builds one for reconcile via `routingContext()` in `ShopAgent.ts`). When absent (tests that only exercise steps), the trigger is skipped.

### `reconcileOrder`

After step 4 (inserts) and step 5 (adjust), add:

```text
6. orderRuns := open order runs for orderId
   for each orderRun:
     if any item run for the order has createdAt > orderRun.createdAt → flagOpen item_added { item }
     if any item run flagged item_removed in this pass                → flagOpen item_removed { item }
7. startOrderRunIfReady(...)          (only reached when the order is eligible)
```

Step 3 (ineligible order) already cancels pending and flags active runs by `orderId`, which covers order runs with no change.

### `cancelRun`, `uncancelRun`, `createRun` (attach)

- `cancelRun`: after the update, if the run was an item run, `startOrderRunIfReady`.
- `uncancelRun`: after `recomputeStatus`, if the run is an item run, `flagOpen item_added` on any open order run of the order.
- `createRun` (manual attach): after a `Some`, `flagOpen item_added` on any open order run.

### `listQueue`

Query unchanged. After grouping, for the order runs in the page, one query:

```sql
select li.id, li.title, li.variantTitle, li.currentQuantity, li.customAttributes, r.status
from OrderLineItem li
left join WorkflowRun r on r.lineItemId = li.id and r.status <> 'cancelled'
where li.orderId in (select value from json_each(?)) and li.currentQuantity > 0
order by li.orderId, li.title
```

An item with two runs yields two rows; collapse to the "worst" status (`pending` < `active` < `done`) in TypeScript. Items read live, never snapshotted, so a late item shows on the card as soon as reconcile stores it.

### `listRunsForOrder`

`order by lineItemId is null, lineItemId, createdAt` so order runs come last.

## `src/lib/ShopAgent.ts`

- `createWorkflow` callable: input gains `scope`.
- `listRunsForOrder` / `OrderDetailView`: include `orderWorkflow` (active order workflow or null) so the order page can render the placeholder.
- `completeStep`, `cancelRun`: pass `routing: yield* routingContext()` through.
- Logging, one line per trigger: `WorkflowRunRepository.startOrderRun: shop=${shop} orderId=${orderId} workflowId=${workflowId}` with `{ shop, orderId, workflowId }` annotated. Reconcile's existing summary line gains `orderRuns=${n}`.

## `src/lib/ShopAgentClient.ts`

`createWorkflow` signature gains `scope`. Nothing else.

## Browser

### `src/routes/app.workflows.index.tsx`

- Create form: a choice group "This workflow is for" with "Making one item" (default, shows the tags field) and "The whole order, after every item is made" (hides tags, shows the sentence "Starts when every item on an order that has a workflow is done. One order workflow per shop."). Option disabled with that sentence when an active order workflow already exists.
- Table: a "Scope" column, or the order workflow pulled into its own short section above the table titled "Order workflow". Prefer the section; it makes the one-per-shop rule visible.
- `OrderWorkflowExists` result renders as a banner.

### `src/routes/app.workflows.$workflowId.tsx`

- Order scope: hide the tags field; show a read-only "Order workflow" badge and the trigger sentence. Steps, stages, instructions, archive: unchanged.

### `src/routes/app.orders.$orderId.tsx`

- After the line items, a section "Order workflow":
  - order run exists: same run component as item runs (name, status badge, flag badge, stages and steps, cancel / un-cancel).
  - no run, `orderWorkflow` active, and at least one item run on the order: "{name} starts when all items are made." When the order predates the workflow and no item run is manual: "{name} will not start here: this order was placed before that workflow was created. Attaching a workflow to an item by hand opts the order in."
  - otherwise: section omitted.
- Flag label for `item_added`: "New item: {item}".

### `src/routes/shop.$shop.queue.tsx`

- `renderItem`: when `isOrderRun(item.run)`, header is `{orderName} · {workflowName}` and the body lists `item.items` as `{title} — {variantTitle} ×{quantity}` with a small status badge (`Done`, `In progress`, `Not started`, `No workflow`) and that item's personalization beneath. Order note, steps, Start / Done / note / block / dismiss: unchanged.
- `lineItemLabel` guards null; it is only called for item runs.

## Seed — `scripts/seed.ts`, `src/routes/api.dev.seed.ts`

Add one order workflow, `{ name: "Pack & ship", scope: "order", tags: [], steps: [QC → Packing team, Pack → Packing team] }`, and a "Packing" team with one member. Seed input schema gains optional `scope`.

## Tests

### `test/integration/workflow-repository.test.ts`

- create order workflow; second active one refused with `OrderWorkflowExistsError`; archive first, create second allowed; un-archive first refused.
- tags on order scope refused (create and update).

### `test/integration/workflow-run-repository.test.ts`

Fixture: one item workflow (tag `necklace`), one order workflow (QC, Pack), order with two tagged items and one untagged.

- all item runs done → one order run, `pending`, steps copied with stages.
- one done + one cancelled → order run; all cancelled → none; untagged-only order → none.
- trigger twice (complete last step, then reconcile again) → still one order run.
- order workflow archived before the last completion → none; created after `processedAt` → none, unless an item run on the order is `source = 'manual'` (opt-in).
- item added by reconcile after order run pending / active → `item_added` with item title; done → untouched.
- `attachWorkflow` and `uncancelRun` after order run → `item_added`.
- item removed after order run → `item_removed` on both runs.
- order cancelled with pending order run → cancelled; active → `order_cancelled`.
- `listQueue` for the Packing team returns the order run with `items` (three rows, statuses `done`, `done`, `null`); `listRunsForOrder` orders it last.
- reconcile matrix from `workflow-runs-spec.md` re-run with the order workflow present to show item-run behaviour is unchanged.

### `test/integration/shop-agent-workflows.test.ts`

Through the member seam: complete the last item step, then `listQueue` for the Packing team shows the order run; `completeStep` on its QC step works; `cancelRun` on the order run from the embedded callable works.

### Browser smoke (optional, headed Playwright per `AGENTS.md`)

Create the order workflow, seed an order, finish the items in the queue, see the packing card, finish it, see `done` on the order page.

## Implementation order

1. Schema, Domain, decoders (`scope`, nullable run columns, `item_added`, `QueueOrderItem`). Typecheck.
2. `WorkflowRepository` invariant and error; `ShopAgent.createWorkflow`; tests.
3. `insertRun` with `lineItem: null`; `startOrderRunIfReady`; wire into `completeStep`, `cancelRun`, `reconcileOrder`; tests for the trigger matrix.
4. Flags: `flagOpen`, reconcile step 6, `uncancelRun`, `createRun`; tests.
5. `listQueue` items; `listRunsForOrder` order; `OrderDetailView.orderWorkflow`.
6. UI: index, editor, order page, queue card.
7. Seed; browser smoke.

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt` after each step.

## Effect v4 conventions to hold to

Same as `workflow-stages-spec.md`: `Effect.fn` for every service method, tagged errors for expected failures mapped to result unions at the Durable Object boundary, one transaction per action owned by the caller (`startOrderRunIfReady` never opens its own), logging by message plus `annotateLogs`.

## Deferred hooks

Tag selection of order workflows (`tags` column already present; lift the invariant and add a union-over-items predicate), default plus override (untagged order workflow fires only when no tagged one matches), `order_fulfilled` flag (`ShopOrder.fulfillmentStatus` is stored), manual attach of an order workflow to an order, orders-index "packed" column. None require changing anything in this spec.

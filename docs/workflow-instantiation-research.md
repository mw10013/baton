# Workflow Instantiation Research

Research date: 2026-09-02

Scope: when Baton turns a Shopify order into running production workflows, how "paid" is detected across all order write paths, and what happens to running workflows when the order changes afterward. Definitions are covered in `workflow-definition-research.md`; Route to Ship's routing model in `route-to-ship-tag-routing-research.md`.

## Conclusion

- **Trigger in the upsert, not in the webhook.** Every order write (webhook, bulk sync, manual resync) already funnels through one seam: `ShopAgent.fetchAndUpsertOrder` → `OrderRepository.upsertOrder`. Run the instantiation check there, after the row is written, regardless of source. The `orders/paid` topic is a hint, never the gate.
- **Gate = `fullyPaid` true and `cancelledAt` null.** Not `financialStatus = 'PAID'`: a partially refunded order stays paid for production purposes, and `fullyPaid` already covers that.
- **Idempotency comes from the instance key `(lineItemId, workflowId)`, not from "does the order have any workflows".** A unique index makes a repeat upsert a no-op; a later-added line item gets its instances on its own.
- **Order changes after instantiation: reconcile line items, never rewrite steps.** Line item disappears or `currentQuantity` hits 0 → instance cancelled if not started, flagged if started. New line item → new instance. Quantity change → update a snapshot, flag if started. Product tags change → no reroute. Order cancelled → cancel unstarted, flag started.
- **No competitor documents any of this.** Route to Ship, MakerBatch store a copy and say nothing about drift. Kanbanify, Maker's Production View, BenchCue read live and hold almost no state, so the problem doesn't exist for them. Baton has to pick a policy on its own.

## Current State In Baton

### Write paths

All three sources land in the same upsert (`src/lib/ShopAgent.ts`, `src/lib/OrderRepository.ts`):

| Source                | Entry                                            | Dedupe / staleness                                                  |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| webhook (`"webhook"`) | `syncOrder` → `fetchAndUpsertOrder`              | `WebhookDelivery` log, payload `updated_at` vs stored, upsert guard |
| manual (`"manual"`)   | `resyncOrder` (callable) → `fetchAndUpsertOrder` | upsert guard only                                                   |
| bulk (`"bulk"`)       | `onOrdersStream` → `runShopAgentOrdersStream`    | upsert guard only                                                   |

Webhook payloads are stripped to `id, admin_graphql_api_id, updated_at` (`shopify.app.toml:38-53`), so the topic carries no order data. Subscribed: `orders/create, updated, paid, cancelled, fulfilled, partially_fulfilled, delete`. Topic is only branched on for delete (`src/routes/webhooks.orders.ts:73`).

The upsert guard:

```sql
on conflict(id) do update set ...
where excluded.updatedAt >= ShopOrder.updatedAt
returning id
```

`written: false` means stale; line items untouched. `written: true` with `lineItemsComplete` deletes and reinserts all line items (`OrderRepository.ts:299-301`).

### What is already stored

`ShopOrder`: `financialStatus`, `fullyPaid`, `cancelledAt`, `closedAt`, `fulfillmentStatus`, `updatedAt`.
`OrderLineItem`: `productId`, `productTags` (lowercased JSON array), `quantity`, `currentQuantity`, `unfulfilledQuantity`, `nonFulfillableQuantity`.

Both the single-order and bulk queries fetch the same fields (`OrderSync.ts:133-168`, `OrdersBulkRepository.ts:25-67`), so instantiation has identical inputs from every source.

### What is missing

- No instance table. `Workflow` / `WorkflowStep` have no link to orders (`ShopAgent.ts:188-207`).
- No old-vs-new comparison anywhere. `upsertOrder` returns only `{ written }`. `fullyPaid` is stored and rendered, never read for logic.
- `orders/paid` arrives and is treated as a generic refetch.

## Detecting "Paid"

### Shopify semantics

`OrderDisplayFinancialStatus` (2026-07): `AUTHORIZED, EXPIRED, PAID, PARTIALLY_PAID, PARTIALLY_REFUNDED, PENDING, REFUNDED, VOIDED`. `PAID` = "Payment was automatically or manually captured, or the order was marked as paid." Source: https://shopify.dev/docs/api/admin-graphql/2026-07/enums/OrderDisplayFinancialStatus

`orders/paid` "Occurs whenever an order is paid." Baton already subscribes. The Events equivalent filters on `order.displayFinancialStatus:'PAID'` and triggers on `totalReceivedSet`, which confirms it's a financial-status transition, not a separate concept. Source: https://shopify.dev/docs/apps/build/events/migrate-from-webhooks

Shopify says deliveries may duplicate and does not promise ordering, so `orders/paid` can arrive before `orders/create` or twice. Source: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries

### Why not gate on the topic

- Bulk sync and manual resync have no topic. A merchant who installs, clicks "sync 30 days", and expects work to appear needs the same gate.
- `orders/paid` can be missed (dev tunnel down, 4h retry exhausted). The safety net is the next `orders/updated` or a resync, both of which hit the upsert.
- Orders created already paid (most checkouts) fire `orders/create` with `fullyPaid = true`; whether `orders/paid` also fires is not something to depend on.

### Gate definition

```
eligible(order) = order.fullyPaid && order.cancelledAt === null
```

Why `fullyPaid` over `financialStatus === 'PAID'`:

- `PARTIALLY_REFUNDED` is still paid for the remaining items, and `currentQuantity` already reflects refunded units per line.
- `fullyPaid` is Shopify's own boolean for "nothing outstanding".

Deliberately excluded: `AUTHORIZED` (manual capture shops), `PENDING` (COD, bank transfer), `PARTIALLY_PAID`. A shop that wants production to start on authorization needs a setting; not phase 1.

## Instantiation Design

### Where

Inside `upsertOrder`'s transaction, after line items are written, or as a second step in `fetchAndUpsertOrder` / the bulk stream keyed off `written: true`. Doing it in the same SQLite transaction is preferable: the DO is single-threaded per shop, so no concurrency between webhook and bulk beyond what the upsert guard already handles, and instance creation can't be lost between two writes.

Skip when `written: false` (stale). A stale write cannot change eligibility.

### Routing predicate (from definition spec)

Per line item, per workflow:

```
match = workflow.archivedAt is null
     && workflow.stepCount > 0
     && every step.team is active
     && intersect(workflow.tags, lineItem.productTags) non-empty
     && lineItem.currentQuantity > 0
```

One instance per `(lineItemId, workflowId)`, enforced with a unique index. Instances copy steps (name, position, teamId, snapshotted teamName) so later definition edits don't touch running work.

### Idempotency

The user's proposal ("if paid and no workflows on the order, create them") breaks in two cases:

1. Order paid, none of its products match any workflow → zero instances. Every later upsert re-evaluates. Harmless but wasteful, and it means a workflow added tomorrow retroactively catches every already-paid order on its next resync. That may or may not be wanted (see Questions).
2. Order paid, instances created, then edited to add a tagged line item → "already has workflows" blocks the new one.

`(lineItemId, workflowId)` unique index solves both without an order-level flag: `insert ... on conflict do nothing` per candidate pair. Optionally record `ShopOrder.routedAt` for display and as a fast-path skip when nothing changed.

### Retroactivity

Because the check runs on every upsert, a newly created workflow will attach to old paid orders the next time those orders are touched (webhook, resync, bulk). Options:

- **A. Allow it** (default with no extra logic). Simple; may surprise a merchant with a wall of old jobs after a bulk resync.
- **B. Only route orders whose `processedAt >= workflow.createdAt`.** Cheap, deterministic, matches "new orders flow into pipelines".
- **C. Mark order `routedAt` at first eligible evaluation; never revisit for new workflows, only for line-item changes.**

Recommendation: B. It's the least surprising and needs no new state.

## Order Changes After Instantiation

### How changes reach Baton

| Shopify event                | Webhook Baton gets           | Visible after refetch                                       |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------- |
| Order edit: remove line item | `orders/updated`             | line item still present, `currentQuantity = 0`              |
| Order edit: reduce quantity  | `orders/updated`             | `currentQuantity` lower, `quantity` unchanged               |
| Order edit: add variant      | `orders/updated`             | new `LineItem` id                                           |
| Refund (with or w/o restock) | `orders/updated`             | `currentQuantity` lower, `nonFulfillableQuantity` higher    |
| Cancel                       | `orders/cancelled`+`updated` | `cancelledAt` set                                           |
| Product tag edited           | nothing on the order         | `productTags` changes only when the order is next refetched |
| Delete                       | `orders/delete`              | row removed, `OrderLineItem` cascades                       |

`orders/edited` (not subscribed) delivers deltas, not state: "Line item changes are quantity deltas rather than lists of products … delta is always positive." Source: https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/edit-orders. Since Baton refetches full state anyway, deltas add nothing. Not needed.

`LineItem.quantity` = "units ordered, including refunded and removed units"; `currentQuantity` excludes them. Source: https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem. Removed line items are not deleted from the order; they stay with `currentQuantity = 0`. So `OrderLineItem` row disappearance only happens on `lineItemsComplete` reinsert when Shopify actually drops the item (rare) or on order delete.

### Diff mechanism

Line-item level reconciliation needs the previous state. Two options:

- **Read before write.** Select existing `OrderLineItem` rows for the order inside the upsert transaction, then compare. Cheapest; the DO is single-writer so it's consistent.
- **Diff against instances instead of old line items.** After the upsert, join `WorkflowRun` to `OrderLineItem` for that order. An instance whose line item now has `currentQuantity = 0` or no row is "orphaned"; a line item with no instance for a matching workflow is "new". This needs no snapshot of old line items and is what the reconcile step naturally wants anyway.

Recommendation: the second. It's one query and is self-healing (a missed event is caught on the next upsert).

### Policy matrix

Instance status vocabulary assumed: `pending` (no step started), `active` (some step done or claimed), `done`, `cancelled`. Plus a nullable `flag` / `attentionReason`.

| Change                                       | Instance `pending`         | Instance `active`                             | Instance `done` |
| -------------------------------------------- | -------------------------- | --------------------------------------------- | --------------- |
| line item removed / `currentQuantity → 0`    | cancel                     | keep, flag `item_removed`; team decides       | leave           |
| `currentQuantity` reduced (still > 0)        | update snapshot qty        | update snapshot qty, flag `quantity_changed`  | leave           |
| `currentQuantity` increased                  | update snapshot qty        | update snapshot qty, flag `quantity_changed`  | leave           |
| new line item matching a workflow            | create instance            | create instance                               | create instance |
| order cancelled                              | cancel all                 | flag `order_cancelled`, keep visible          | leave           |
| order deleted                                | delete (cascade) or cancel | cancel + flag; row cascade would lose history | see Questions   |
| product tag changed (seen on refetch)        | no change                  | no change                                     | no change       |
| workflow definition edited/archived          | no change (copied steps)   | no change                                     | no change       |
| order un-cancelled (Shopify doesn't support) | n/a                        | n/a                                           | n/a             |
| refund to `REFUNDED`, `fullyPaid` still true | same as qty → 0 per line   | same                                          | leave           |

Principles behind it:

- **Never silently destroy work someone has touched.** Once `active`, the system only annotates. Kanbanify's only related mechanism is a Flow trigger "when an order moves backward", i.e. a human decision, not automation.
- **Automatically clean up what nobody has touched.** `pending` instances are pure derived state; recomputing them is safe.
- **Quantity is a snapshot on the instance**, refreshed from `currentQuantity`. The instance represents "make this line item", not "make N units", so a qty change is informational unless the shop tracks per-unit progress (not phase 1).
- **Tags are routing input at instantiation time only.** Rerouting existing work on tag changes is unbounded (a tag edit on one product would touch every open order). Route to Ship documents routing "when a new Shopify order syncs in" and nothing about later tag changes.
- **Cancellation is not un-doable in Shopify**, so cancelling pending instances is safe.

### Un-cancel and "flag cleared" flow

Flags need a UI action: "dismiss" (acknowledge, keep working) or "cancel instance" (stop). Either is a member/admin action, not automated. A flag should carry `reason`, `setAt`, and the observed values (old/new qty) so the UI can explain itself.

### Order delete

`orders/delete` currently removes the `ShopOrder` row and cascades line items. If `WorkflowRun` references `OrderLineItem` with `on delete cascade`, in-progress work vanishes. Options: soft-delete the order (`deletedAt`), or have instances reference `orderId`/`lineItemId` without a foreign key and snapshot `orderName`, `title`, `sku` at creation. Recommendation: snapshot the display fields on the instance and do not cascade; mark instances `flag = order_deleted`. Deleting a paid order in Shopify is rare (requires cancel/archive first), so this mostly matters for test data.

## Instance Table Sketch

Not a spec; enough to show the keys the policies above need.

```sql
create table if not exists WorkflowRun (
  id text primary key,
  workflowId text not null,
  workflowName text not null,
  orderId text not null,
  orderName text not null,
  lineItemId text not null,
  lineItemTitle text not null,
  quantity integer not null,
  status text not null check (status in ('pending','active','done','cancelled')),
  flag text,
  flagAt integer,
  createdAt integer not null,
  updatedAt integer not null,
  unique (lineItemId, workflowId)
);
create index WorkflowRun_orderId_idx on WorkflowRun (orderId);

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
```

`status` is derived: `pending` while no step has `completedAt`; `active` once any does; `done` when the last does. Storing it avoids a join for the queue view but must be updated in the same transaction as step completion.

## Reconcile Algorithm (per upsert, `written: true`)

1. If `!eligible(order)`: cancel `pending` instances for this order; flag `active` ones `order_cancelled` if `cancelledAt` set. Stop.
2. Load line items for the order and all instances for the order.
3. For each line item with `currentQuantity > 0`, for each matching workflow (predicate above, plus retroactivity rule): `insert ... on conflict do nothing`.
4. For each instance whose line item is missing or has `currentQuantity = 0`: `pending` → cancel; `active` → flag `item_removed`.
5. For each instance whose `quantity != lineItem.currentQuantity`: update; if `active`, flag `quantity_changed`.
6. `notifyChanged()`.

Steps 1, 4, 5 are the safety net for missed events; nothing depends on the topic. Complexity is O(lineItems × workflows), bounded by `lineItems(first: 100)` and `maxWorkflows: 50`.

## Competitor Evidence

Scan of `refs/route-to-ship`, `refs/kanbanify`, `refs/makers-production-view`, `refs/makerbatch`, `refs/benchcue` for edit/cancel/refund/resync semantics after production starts: **zero statements** in any of them.

- Route to Ship: "Paid orders flow in automatically" (`refs/route-to-ship/integrations/shopify.md:19`); routing "when a new Shopify order syncs in" (`refs/route-to-ship/blog/how-to-build-production-pipeline-shopify.md:77`); "Refunded and cancelled orders don't count toward your monthly orders" (`refs/route-to-ship/pricing.md:134`), which implies refund/cancel webhooks are consumed at least for metering. Nothing about the affected job.
- Kanbanify: "We do not maintain a separate permanent database of your orders … store workflow statuses directly in your store via Shopify Metafields" (`refs/kanbanify/privacy.md:50`). Live read, so line-item drift can't happen; only a stage/assignee side-car exists.
- Maker's Production View: "unfulfilled orders into a live production queue … fetched live from Shopify each time the production queue is viewed" (`refs/makers-production-view/index.md:15`, `privacy.md:51-52`). Persists only a per-line "produced quantity". Gate is unfulfilled, not paid.
- MakerBatch: stores order data "for as long as the app is installed"; groups "open, unfulfilled" line items (`refs/makerbatch/privacy.md:20,28`). Gate is unfulfilled.
- BenchCue: read-only, no persisted production state (`refs/benchcue/faq.md:21`).

Takeaway: the two apps closest to Baton's model (stored copy, work materialized at ingest) simply don't say. The live-read apps avoid the question by holding almost no state. Baton's flag-don't-destroy policy is a reasonable middle: instances are derived until touched, then become records.

## Decisions (mw, 2026-09-02)

1. **Retroactivity: no.** A new workflow only routes orders with `processedAt >= workflow.createdAt` (`processedAt` = when Shopify processed the checkout). "From now on" is what merchants expect; an "apply to existing open orders" button can come later.
2. **Gate: `fullyPaid` only.** No `AUTHORIZED`/`PENDING` support; everything automated on paid.
3. **Line item removed with active work: flag and keep.** Badge loud, flagged runs sort to top of the queue; member dismisses or cancels. Auto-cancel only for `pending` runs (nobody touched them). Trade-off accepted: a missed badge wastes work, but auto-cancel hides half-made items and needs a restore path.
4. **Quantity: snapshot on the run, whole line item marches together.** No per-unit status in phase 1. Qty change on an active run only flags it.
5. **Order delete: keep runs, snapshot display fields.** Shopify's `orderDelete` "permanently deletes" but "You can only delete specific order types"; normal paid online orders are cancelled and archived, not deleted (https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderDelete). Archiving sets `closedAt` and the order still exists. So delete is rare, mostly test data. Runs hold `orderName`, `lineItemTitle`, `sku` and have no FK to `OrderLineItem`; on delete, `pending` → cancelled, others flagged `order_deleted`. Rejected: cascade (loses done-work history), soft-delete on `ShopOrder` (touches every orders query).
6. **Noun: `WorkflowRun` in code.** Merchant copy avoids the noun: "this workflow on line item X". Rejected "job" (reads interchangeable with workflow), `LineItemWorkflow` (awkward), `WorkflowRun` (abstract). Table sketch above should read `WorkflowRun` / `WorkflowRunStep`.

## Remaining Questions

- **Fulfilled before done.** If Shopify fulfills the line item (`unfulfilledQuantity = 0`) while the run is `pending`/`active`, do anything? Default: nothing in phase 1; a `fulfilled_externally` flag is cheap if wanted.

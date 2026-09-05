# Order lifecycle — spec

Spec date: 2026-09-04. Implements six decisions taken on 2026-09-04 after a review of how a Shopify order moves through paid, cancelled, edited, refunded, and fulfilled, and how Route to Ship handles the same points. Builds on `workflow-runs-spec.md` (runs, reconcile, flags) and `order-workflow-spec.md` (order runs).

Written to be handed to an implementer with no other context than this repo. Where this spec and the code disagree, the code's existing conventions win and the spec should be amended.

## Decisions being implemented

| #   | Decision                                                                                                                                                                | Section               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | Subscribe to `orders/create`, `orders/updated`, `orders/delete` only.                                                                                                   | Webhooks              |
| 2   | `fullyPaid` gates only the **creation** of runs. Only `cancelledAt` cancels or flags existing runs. An order that drops back to unpaid after an edit leaves work alone. | Eligibility split     |
| 3   | A refund that leaves `currentQuantity` alone but zeroes or lowers `unfulfilledQuantity` is handled like a removal or a quantity change.                                 | Units to make         |
| 4   | An order fulfilled in Shopify while runs are open flags them `order_fulfilled`. No fulfillment holds, no new scope, no fulfillment writes.                              | Fulfilled before done |
| 5   | The orders index and order page show a derived **Ready to ship** state (all runs done, not yet fulfilled) and **Shipped**. Never stored.                                | Production state      |
| 6   | Automatic payment capture is a documented requirement. No code.                                                                                                         | Non-goals             |

## Goals / non-goals

- **Goals.** (1) Fewer webhook deliveries and Admin API calls for the same events. (2) Work in progress is never cancelled by a payment wobble; only a real cancel does that. (3) A maker never makes a unit that has been refunded. (4) A packer can see, on the orders index, which orders are made and waiting to be fulfilled in Shopify, and those drop off the list on their own once Shopify reports the fulfillment. (5) A run left open after the merchant already shipped the order is visibly flagged.
- **Non-goals.** Writing fulfillments, placing fulfillment holds, requesting `write_merchant_managed_fulfillment_orders`, treating `AUTHORIZED` as paid, per-unit progress, order tags written back to Shopify, any customer-facing email. All deliberately rejected; Route to Ship does none of them either.
- **No migration.** Prototype: schema changes edit `initializeSchema` in `src/lib/ShopAgent.ts` in place; wipe local Durable Object state and `pnpm seed`. This spec adds **no** columns; every new state is derived.

## Vocabulary

| Concept                                                                   | Merchant / member copy       | Code                                                        |
| ------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| Order may have new runs created for it                                    | not shown                    | `canStartRuns(order)` = `fullyPaid && cancelledAt === null` |
| Order was cancelled in Shopify                                            | "Cancelled"                  | `order.cancelledAt !== null`                                |
| Order was fulfilled in Shopify                                            | "Shipped"                    | `order.fulfillmentStatus === "FULFILLED"`                   |
| Units of a line item still to be made                                     | "×{n}"                       | `unitsToMake(lineItem)` = `unfulfilledQuantity`             |
| Every run on the order is `done` and Shopify has not reported fulfillment | "Ready to ship"              | `productionState(row) === "ready_to_ship"`                  |
| Run left open after the order was fulfilled in Shopify                    | "Already shipped in Shopify" | `flag = 'order_fulfilled'`                                  |

## Rules (normative)

### Webhooks

```text
shopify.app.toml [[webhooks.subscriptions]] uri = "/webhooks/orders"
topics = ["orders/create", "orders/updated", "orders/delete"]
include_fields unchanged
```

`orders/updated` fires for every change this app acts on: paid, cancelled, edited, refunded, fulfilled, tagged. The dropped topics fired a second delivery for the same change with the same `updated_at`, which the stale guard in `ShopAgent.syncOrder` only catches when the first delivery has already finished its fetch. The handler in `src/routes/webhooks.orders.ts` does not change: it already branches only on `ORDERS_DELETE`.

### Eligibility split

Replace the single `isEligibleOrder` predicate with two:

```text
canStartRuns(order)  = order.fullyPaid and order.cancelledAt is null      (creation gate)
isCancelled(order)   = order.cancelledAt is not null                      (stop gate)
```

`reconcileOrder(orderId)`, in order, inside the caller's transaction:

```text
1. order := stored ShopOrder; none → NO_COUNTS
2. if isCancelled(order):
     cancel every pending run on the order
     flag every active run 'order_cancelled'          (item runs and order runs alike)
     return                                           (unchanged from today)
3. if order.fulfillmentStatus = 'FULFILLED':
     cancel every pending item run
     flag every active item run 'order_fulfilled'
     flag every open order run 'order_fulfilled'      (pending and active, like item_added)
     return                                           (nothing left to make or pack)
4. lineItems := stored OrderLineItem rows; openRuns := pending/active runs on the order
5. created := if canStartRuns(order) then insert a run per (routable item workflow, matching line item) else 0
6. adjust every open item run against its line item (see Units to make)
7. flag open order runs item_removed / item_added exactly as today
8. if canStartRuns(order) then startOrderRunIfReady else 0
```

Steps 6 and 7 run whether or not the order is currently paid. That is the whole of decision 2: a paid order that an edit pushes to `fullyPaid = false` keeps its runs, still tracks removals and quantity changes, and simply creates nothing new until the balance is paid. The new line the edit added gets its run on the re-read that follows payment, and flags the order run `item_added` if one exists, which is the behaviour `order-workflow-spec.md` already defines for late items.

`startOrderRunIfReady` keeps `canStartRuns(order)` as its first guard. Consequence worth stating: on an order that went unpaid mid-production, the order run does not start until payment lands, and by then the new item's run exists and holds it back until that item is made too. That is the right order of events for a packer.

`matchesLineItem` keeps `processedAt >= workflow.createdAt` and `productTags` as today; its quantity clause becomes `unitsToMake(lineItem) > 0` (below). `currentQuantity > 0` is implied.

### Units to make

```text
unitsToMake(lineItem) = lineItem.unfulfilledQuantity
```

Shopify lowers `unfulfilledQuantity` when a unit ships **or is refunded**, and leaves `currentQuantity` alone for a refund. `unfulfilledQuantity` is therefore the number a maker should see, and it is what `WorkflowRun.quantity` snapshots at insert and tracks on reconcile. `currentQuantity` stays on the line item and the order page as "ordered".

Reconcile step 6, per open item run:

```text
lineItem := line item behind run.lineItemId
if lineItem is none or unitsToMake(lineItem) = 0:
    pending → cancel
    active  → flag 'item_removed' with { item: run.lineItemTitle }      (removed, fully refunded, or shipped)
else if unitsToMake(lineItem) ≠ run.quantity:
    set run.quantity := unitsToMake(lineItem)
    pending → silent
    active  → flag 'quantity_changed' with { from, to }
```

This is today's rule with `currentQuantity` replaced by `unitsToMake`. The `quantity_changed` flag and its labels already exist. No new flag is needed for refunds.

The order run's `items` list (`listQueue` → `orderItems`) reports `unfulfilledQuantity` as `quantity` and filters `unfulfilledQuantity > 0`, so a refunded unit never appears on the packing card.

### Fulfilled before done

New flag value `order_fulfilled`. Set only by reconcile step 3, only when the order's stored `fulfillmentStatus` is exactly `FULFILLED`. `PARTIALLY_FULFILLED` is handled per line by step 6 (the shipped line's `unfulfilledQuantity` is 0). No pending item run survives step 3; open order runs are flagged in either status because their premise ("pack what was made") cannot be restored silently, the same reasoning as `item_added`.

Dismiss, block, and later reconcile flags overwrite it like any other flag. It is never written outside reconcile.

### Production state

A pure function over what the index already carries, in `Domain`:

```text
productionState({ order, runs }: OrderRow):
  cancelledAt not null                                   → 'cancelled'
  runs.open = 0 and runs.done = 0:
      canStartRuns(order)                                → 'not_routed'
      otherwise                                          → null           (unpaid, nothing to say)
  fulfillmentStatus = 'FULFILLED'                        → 'shipped'
  runs.open > 0                                          → 'in_production'
  otherwise (open = 0, done > 0, not fulfilled)          → 'ready_to_ship'
```

`ProductionState = Schema.Literals(["not_routed", "in_production", "ready_to_ship", "shipped", "cancelled"])`. Never stored; computed on the client from the decoded row, and in SQL only for the filter below. Because it is derived, the round trip is automatic: the packer fulfils in Shopify, `orders/updated` arrives, reconcile stores `FULFILLED`, the next read computes `shipped`, and the order leaves the Ready-to-ship list without anyone touching Baton.

The orders index gains a filter, `ready` (search param `?state=ready_to_ship`, default all). `OrderRepository.listOrders` takes `state: ProductionState | null` and, for `ready_to_ship`, adds to the keyset `where`:

```sql
and cancelledAt is null
and fulfillmentStatus <> 'FULFILLED'
and exists (select 1 from WorkflowRun r where r.orderId = ShopOrder.id and r.status = 'done')
and not exists (select 1 from WorkflowRun r where r.orderId = ShopOrder.id and r.status in ('pending', 'active'))
```

Only `ready_to_ship` needs a SQL form today; the other states are display only. `orderCount` counts the filtered set when a state is given.

## Domain (`src/lib/Domain.ts`)

- `RunFlag`: add `"order_fulfilled"`. Update the JSDoc above it with one sentence on when it is set.
- `ProductionState` literal schema and `productionState(row: OrderRow): ProductionState | null`, implemented with `Match.value` over the tuple of facts, the same style as the existing `flagMessage` in the queue route. Keep it total: every branch returns.
- `ListOrdersInput` (or whatever `activateOrders` decodes today): add `state: Schema.NullOr(ProductionState)`.
- `OrderLineItem` JSDoc: one sentence that `unfulfilledQuantity` is the units to make and why.

## `src/lib/WorkflowRunRepository.ts`

- Rename `isEligibleOrder` → `canStartRuns`; add `isCancelled`. Both exported, both used by the routes (`app.orders.index.tsx` line 61 today inlines the paid-and-not-cancelled check; replace it with `Domain`-level or repository-level import, whichever the route already imports from).
- Add `unitsToMake` next to `matchesLineItem`; use it in `matchesLineItem`, `insertRun` (`quantity` column), the `adjust` closure, and `orderItems`.
- `reconcileOrder`: restructure to the eight steps above. Implementation notes:
  - Express the early exits as a `Match.value(order).pipe(Match.when(isCancelled, …), Match.when(isFulfilled, …), Match.orElse(…))` or three guarded `if` returns; either is fine, but each branch must return `ReconcileCounts` and the function must stay one `Effect.fn` with no nested transaction.
  - Steps 5 and 8 are gated by `canStartRuns`; steps 6 and 7 are not. Write the gate once as a `const canStart = canStartRuns(order)` and read it twice; do not duplicate the predicate.
  - `flagActive(sql\`orderId = ${orderId} and lineItemId is not null\`, "order_fulfilled", {}, now)`and`flagOpenOrderRuns(orderId, "order_fulfilled", {}, now)`for step 3, reusing the existing helpers. Count both into`flagged`.
  - Logging: one `Effect.logInfo` per early exit, `WorkflowRunRepository.reconcileOrder: orderId=… status=cancelled|fulfilled`, with `Effect.annotateLogs({ orderId, status })`.
- `startOrderRunIfReady`: swap `isEligibleOrder` for `canStartRuns`; no other change.
- `orderItems`: `li.unfulfilledQuantity as quantity` and `where … and li.unfulfilledQuantity > 0`.

## `src/lib/OrderRepository.ts`

- `listOrders({ limit, cursor, state })`. Build the `where` with `sql.and([keyset, stateFilter])` where `stateFilter` is `sql.literal("1 = 1")` for `null` and the fragment above for `ready_to_ship`. Use `Option`/`Match`, not a string switch. The count query takes the same `stateFilter`.
- JSDoc on `listOrders`: why only `ready_to_ship` has a SQL form.

## `src/lib/ShopAgent.ts`

- `activateOrders` and `listOrders` callables: thread `state` through. Decode with the widened input schema; `onExcessProperty: "error"` stays.
- No schema change.

## `shopify.app.toml`

Trim the topic list. Keep the `include_fields` comment. Re-run `pnpm shopify app deploy` (or `app:dev`, which pushes config) so the subscription set on the dev store matches; note this in the PR description since a stale subscription set keeps delivering the dropped topics until pushed.

## Routes

### `src/routes/app.orders.index.tsx`

- `runsBadge` becomes a `stateBadge` driven by `Domain.productionState(row)`:

  | State           | Badge                                                         |
  | --------------- | ------------------------------------------------------------- |
  | `not_routed`    | warning "Not routed" (unchanged)                              |
  | `in_production` | info "{open} active · {done} done" (unchanged) plus "Flagged" |
  | `ready_to_ship` | success "Ready to ship"                                       |
  | `shipped`       | neutral "Shipped"                                             |
  | `cancelled`     | neutral "Cancelled"                                           |
  | `null`          | empty cell                                                    |

- A segmented control or two `s-button`s in the header: "All" / "Ready to ship". Selection is a route search param validated with `Schema` in `validateSearch`, passed into the query key and the `activateOrders` call, and resets the cursor stack.
- The page subtitle when filtered: "{n} orders made and waiting to be fulfilled in Shopify."

### `src/routes/app.orders.$orderId.tsx`

- Header badge from `productionState({ order, runs })`, computing `RunCounts` from the `runs` array the view already carries (a small pure helper in `Domain`, `runCounts(runs: readonly WorkflowRun[]): RunCounts`, reused nowhere else yet but keeps the two pages on one definition).
- Under the badge when `ready_to_ship`: "Every run is done. Fulfil this order in the Shopify admin; it will show as Shipped here once Shopify reports it." Link to the Shopify admin order page (`shopify:admin/orders/{legacyId}` is what App Bridge accepts).
- Flag label for `order_fulfilled`: "Already shipped in Shopify".
- Line item rows show "×{unfulfilledQuantity} to make" when it differs from `currentQuantity`, else "×{currentQuantity}".

### `src/routes/shop.$shop.queue.tsx`

- `flagMessage`: `order_fulfilled` → "This order was already shipped in Shopify." `item_removed` message becomes "No longer needed: {item}" since it now also covers refunded and shipped.
- The order run card lists items by `unfulfilledQuantity` via `items` (repository change; no client change beyond the label).

## Seed — `scripts/seed.ts`, `src/routes/api.dev.seed.ts`

Add one order with two units where one is refunded (`quantity 2, currentQuantity 2, unfulfilledQuantity 1, nonFulfillableQuantity 1`) and one order whose runs are all done and `fulfillmentStatus = 'UNFULFILLED'`, so the Ready-to-ship filter has a row locally.

## Tests

### `test/integration/workflow-run-repository.test.ts`

Eligibility split:

- paid order with one pending and one active run; re-upsert with `fullyPaid: false, financialStatus: "PENDING"` and a third tagged line → pending and active runs untouched, no run for the new line, no order run; re-upsert paid → run for the new line created, order run flagged `item_added` if it existed.
- unpaid-after-edit order with a line dropped to zero → the pending run is still cancelled and the active one still flagged `item_removed` (adjust runs without the paid gate).
- cancelled order behaviour unchanged (existing test at "on order cancel").

Units to make:

- `unfulfilledQuantity` drops 2 → 1 with `currentQuantity` unchanged: pending run quantity updated silently; active run flagged `quantity_changed { from: 2, to: 1 }`.
- `unfulfilledQuantity` → 0 with `currentQuantity` 2: pending cancelled, active flagged `item_removed`.
- inserted run snapshots `quantity = unfulfilledQuantity`, not `currentQuantity`.
- `listQueue` order run `items` uses `unfulfilledQuantity` and omits a fully refunded line.

Fulfilled before done:

- order with one pending item run, one active item run, one active order run; re-upsert with `fulfillmentStatus: "FULFILLED"` → pending cancelled; active item run and order run flagged `order_fulfilled`; done runs untouched; `created = 0` even with a new tagged line.
- `PARTIALLY_FULFILLED` with one line at `unfulfilledQuantity = 0` → only that line's run affected, via `item_removed`.

### `test/integration/order-repository.test.ts`

- `listOrders({ state: "ready_to_ship" })` returns exactly the orders with ≥ 1 done run, no open run, not cancelled, not `FULFILLED`; `orderCount` matches; keyset paging still works under the filter.

### `test/integration/shopify-webhook.test.ts`

- No change needed; it already sends `orders/updated`. Add one assertion that reads `shopify.app.toml` and checks the order topics equal `["orders/create", "orders/updated", "orders/delete"]`, so a future edit that re-adds a topic is a conscious one.

### Unit (`test/unit/` or alongside, per repo convention)

- `productionState` table test: one row per state plus the `null` case.

### Browser smoke (optional, headed Playwright per `AGENTS.md`)

Seed, open the orders index, switch to Ready to ship, see the seeded order, open it, see the badge and the Shopify link.

## Implementation order

1. `shopify.app.toml` trim + toml assertion test. Typecheck.
2. `Domain`: `order_fulfilled`, `ProductionState`, `productionState`, `runCounts`. Unit test.
3. `WorkflowRunRepository`: `canStartRuns`, `isCancelled`, `unitsToMake`; reconcile restructure; `orderItems`. Integration tests for the three groups above.
4. `OrderRepository.listOrders` state filter; `ShopAgent` threading; test.
5. Routes: index badge and filter, order page badge and copy, queue labels.
6. Seed; browser smoke.

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt` after each step. `pnpm graphql-codegen` is not needed; no `#graphql` string changes.

## Effect v4 conventions to hold to

- Every service method is `Effect.fn("Service.method")`; helpers that only compose statements may be plain arrows returning `Effect`.
- Expected failures are tagged errors (`Schema.TaggedError`), mapped to result unions at the Durable Object boundary. This spec adds none.
- One transaction per action, owned by the caller. `reconcileOrder` never opens one; it runs inside `upsertOrder`'s via `afterWrite`.
- Branching on data is `Match.value(...).pipe(Match.when, Match.orElse)` or `Option.match`, exhaustive. No `switch` on string literals, no thrown errors, no `let`.
- Predicates (`canStartRuns`, `isCancelled`, `unitsToMake`) are pure, exported, and the only place their rule lives; routes and SQL fragments derive from them rather than restating them.
- Logging: single-string messages with `key=value` fields, structured copies in `Effect.annotateLogs`.
- Schemas describe every value that crosses the Durable Object boundary; `Schema.toType` on the client side, as `app.orders.index.tsx` already does.

## Deferred hooks

- Treat `AUTHORIZED` as `canStartRuns` for manual-capture shops: one clause in the predicate, off by default. Not planned.
- Write an order tag when `ready_to_ship` is reached, for merchants who automate fulfillment with Shopify Flow: `write_orders` already covers it. Not planned.
- Per-unit progress: `unitsToMake` is the number it would count against. Not planned.

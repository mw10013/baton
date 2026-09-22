# Orders, webhooks, scopes, and billing: implementation plan

Date: 2026-09-22. Research and decisions:
`docs/orders-webhooks-billing-research.md`. Every decision there is
settled; this plan does not reopen them.

## Ground rules for the implementer

- Read `CLAUDE.md` first. JSDoc rules, `Domain` predicates, one test per
  rule with the rule as the title, `pnpm fmt` and keep everything it
  touches, no commits unless told.
- **Prototype phase.** Schema changes are made in line in
  `ShopAgent.initializeSchema` and `migrations/0001_init.sql`. No new
  migration files. All local Durable Object state and local D1 are reset
  from scratch. Tell the user when to restart the dev server and reset;
  see "When to ask for a reset".
- Work in the order given. Each step ends with `pnpm typecheck`,
  `pnpm lint`, and the tests named in the step. Run `pnpm graphql-codegen`
  after any change to a `#graphql` string.
- The Chrome DevTools MCP is available for looking at the app in a browser.
  Playwright CLI via `pnpm playwright-cli` is the documented alternative.
  Neither is required for any step below.
- Record anything you did differently, could not do, or found wrong in
  the "Deviations and issues" section at the end of this file.

## Invariants after this change

State these on the symbols named, per `CLAUDE.md`:

1. Baton reads orders and never writes them. Scope `read_orders`.
2. A webhook is a knock. The handler records the delivery, fetches the
   order, upserts, reconciles. Topic is a log field only.
3. Runs are created only for a paid order (`Domain.canStartRuns`).
4. An order is counted once, when its first run is created. Never reversed.
5. After a run exists, only these change it: cancellation (pending
   cancelled, active flagged), order-level `FULFILLED` (same), a line's
   `currentQuantity` change (pending resized or cancelled, active and done
   flagged).
6. Partial fulfillment changes nothing.
7. A plan change may land at once or at the boundary; the plan cache is
   correct either way.

## Step 1. Scope

Files: `shopify.app.toml`, `src/routes/privacy.tsx`,
`test/integration/shopify-webhook.test.ts`.

1. `scopes = "read_orders,read_products"`.
2. In `privacy.tsx`, replace the paragraph that says order access "is held
   under write_orders" with one that names `read_orders` and drops the
   "does not currently write" hedge.
3. Add a test beside "subscribes to create, updated, and delete only" that
   reads `[access_scopes].scopes` from the toml and asserts
   `["read_orders", "read_products"]`. Title: "requests read_orders and
   read_products only".

Verify: `pnpm test -- shopify-webhook`.

## Step 2. Webhook topics

Files: `shopify.app.toml`, `src/routes/webhooks.orders.ts`,
`test/integration/shopify-webhook.test.ts`.

1. Replace the `/webhooks/orders` subscription block with two blocks:

   ```toml
   [[webhooks.subscriptions]]
   uri = "/webhooks/orders"
   topics = ["orders/create", "orders/paid", "orders/cancelled", "orders/fulfilled"]
   include_fields = ["id", "admin_graphql_api_id", "updated_at"]

   [[webhooks.subscriptions]]
   uri = "/webhooks/orders"
   # `orders/edited` carries an `order_edit` object: `order_id`, no
   # `updated_at`, so the stale guard cannot apply and it always fetches.
   # No `include_fields`: the payload differs per edit, so Shopify's
   # identical-payload debounce is not a concern.
   topics = ["orders/edited"]
   ```

   Rewrite the comment on the first block: `orders/updated` is not
   subscribed because it fires on every save of the order and every
   change Baton acts on has its own topic; the `updated_at` comment about
   debounce stays.

2. In `webhooks.orders.ts`:
   - Keep `OrderWebhookPayload` for the order-shaped topics.
   - Add `OrderEditWebhookPayload = Schema.Struct({ order_edit: Schema.Struct({ order_id: Schema.Number }) })`.
   - Decode with `Schema.Union` of the two, or branch on the presence of
     `order_edit`. The order GID for an edit is
     `gid://shopify/Order/${String(order_id)}`; `updatedAt` is `null` for
     that branch, which the existing stale guard already treats as "no
     guard".
   - Remove `ORDERS_DELETE_TOPIC` and the `deleteOrder` branch.
   - Update the route JSDoc: five topics, the edit payload shape, the
     numeric-id argument (exact in practice, compared against nothing)
     moves from the delete case to the edit case.
3. Tests in `shopify-webhook.test.ts`:
   - Retitle and update the toml test: "subscribes to create, paid, edited,
     cancelled, and fulfilled only". Parse both blocks; assert the union
     of topics in a fixed order.
   - Add "an orders/edited delivery resolves the order from
     order_edit.order_id and always fetches": post an `order_edit` payload
     for a stored order, assert the row was refreshed (`syncSource`
     `"webhook"`) even though the stored `updatedAt` is newer than any
     payload value.
   - Delete "orders/delete removes the stored order".
   - Existing stale and redelivery tests: change their topic to
     `orders/paid`.

Verify: `pnpm test -- shopify-webhook`. Then `shopify app deploy` (or the
dev flow's config push) so the dev store drops `orders/updated` and
`orders/delete`; note in Deviations if you could not push.

## Step 3. Remove order deletion

Files: `src/lib/ShopAgent.ts`, `src/lib/ShopAgentClient.ts`,
`src/lib/OrderRepository.ts`, `src/lib/WorkflowRunRepository.ts`,
`src/lib/Domain.ts`, `src/components/MemberRun.tsx`,
`src/routes/app.orders.$orderId.tsx`, tests.

1. `ShopAgent.deleteOrder` and its client binding: remove.
2. `OrderRepository.deleteOrder`: remove. Keep `deleteSeedOrders` and
   `sweepExpiredOrders`; they are separate paths.
3. `WorkflowRunRepository.markOrderDeleted`: remove.
4. `Domain.RunFlag`: remove `"order_deleted"` and its row in the rule
   table. `MemberRun.tsx` and the order page's flag labels: remove the
   `order_deleted` arms.
5. Tests: delete "markOrderDeleted cancels pending, flags active, leaves
   done; runs survive deleteOrder" and the delete-reversal test named in
   Step 5. Grep `test/` for `deleteOrder`, `order_deleted`,
   `markOrderDeleted` and remove or retarget every hit.

Verify: `pnpm test -- workflow-run-repository order-repository
shop-agent-callables`.

## Step 4. Quantity source and partial fulfillment

Files: `src/lib/Domain.ts`, `src/lib/WorkflowRunRepository.ts`,
`src/lib/OrderRepository.ts`, `src/lib/OrderSync.ts`,
`src/lib/OrdersBulkRepository.ts`, `src/lib/ShopAgent.ts`,
`src/routes/api.dev.seed.ts`, `src/routes/app.orders.$orderId.tsx`, tests.

1. `Domain.unitsToMake` reads `currentQuantity`. Rewrite its JSDoc and the
   `OrderLineItem` field JSDoc: `currentQuantity` drops on an edit or a
   refund and on nothing else; fulfillment does not move it, which is why
   a line shipped early still shows as work until the order is fulfilled.
2. Replace every `unfulfilledQuantity > 0` in SQL with
   `currentQuantity > 0`: `OrderRepository` `AMBIGUOUS_ITEM` and the open
   index at the second hit, `WorkflowRunRepository.reconcileAll`'s
   candidate query and the `Pick` on its eligibility helper.
3. Drop `unfulfilledQuantity` and `nonFulfillableQuantity` from
   `OrderSync` (schema, mapper, query), `BulkOrdersQuery`,
   `Domain.OrderLineItem`, the `OrderLineItem` table in
   `ShopAgent.initializeSchema`, the upsert column list, the seed override
   schemas in `Domain` and `api.dev.seed.ts`, and the seed mapper in
   `ShopAgent`. Run `pnpm graphql-codegen`.
4. `reconcileOrder`: the `FULFILLED` branch stays. Delete the JSDoc
   sentence "PARTIALLY_FULFILLED never lands here ... `adjust` handles it
   per line" and state instead that partial fulfillment changes nothing
   because `currentQuantity` does not move on fulfillment. `adjust` is
   unchanged apart from reading through `unitsToMake`.
5. `OrdersBulkRepository.OPEN_WORK_FILTER` JSDoc: the sentence about
   keeping partials in the set is still true and still wanted; leave it.
6. Tests in `workflow-run-repository.test.ts`: delete "PARTIALLY_FULFILLED
   touches only the shipped line, via item_removed". Retitle the refund
   tests to say `currentQuantity`: "a refund that lowers currentQuantity
   alone updates pending silently and flags active" and "a full refund
   cancels pending and flags active item_removed". Add "partial
   fulfillment changes no run": stage `PARTIALLY_FULFILLED` with unchanged
   `currentQuantity`, assert no run changed and no flag set. Fixtures that
   set `unfulfilledQuantity` move to `currentQuantity`.
7. `Domain.RunFlag` table: the `item_removed` row says the line's
   `currentQuantity` hit zero.

Verify: `pnpm test -- workflow-run-repository order-repository domain
shop-agent-orders-stream`.

## Step 5. Metering: count on first run, never reverse

Files: `src/lib/OrderRepository.ts`, `src/lib/WorkflowRunRepository.ts`,
`src/lib/ShopAgent.ts`, `src/lib/Domain.ts`, `README.md`, tests.

Design: `WorkflowRunRepository.insertRun` is the single door through which
a run is created (reconcile, `reconcileAll`, the two manual `source:
"manual"` sites in `ShopAgent`). Counting hangs off that door.

1. `OrderRepository` exposes `countOrder(orderId: string, now: number)`:
   inside the caller's transaction, `update ShopOrder set countedAt = now
where id = ? and countedAt is null`; if a row changed, increment
   `ShopUsage.ordersThisCycle` and `queueUsageEvent({ idempotencyKey:
countKey(orderId), orderId, value: 1, occurredAt: now })`. The
   `countedAt is null` guard is the whole idempotency story; say so in
   the JSDoc. Keep the seeded-order refusal in `queueUsageEvent`.
2. Remove from `OrderRepository`: `reverseOrder`, `reverseKey`, the old
   three-transition `countOrder`, the `StoredOrderCounting` probe fields
   that only served it (`countedAt`, `cancelledAt`, `fullyPaid`,
   `firstCycleStartAt` on the probe; keep whatever the version check
   needs), and the `countOrder` call in `upsertOrder`. `firstCycleStartAt`
   goes from the `ShopOrder` table and `Domain.ShopOrder`; the placement
   rule it served ("a backfilled order paid after install never bills") is
   now covered by run creation, which `reconcileOrder` already limits to
   orders processed after the workflow was created.
3. `Domain`: remove `orderCountsTowardCycle`. `UsageEvent.value` becomes
   `Schema.Literal(1)` or stays a positive integer check; either way
   negative values are gone. Delete the test "an order counts toward the
   cycle when it is paid, not cancelled, and placed no earlier than the
   cycle it was first stored in".
4. `WorkflowRunRepository` depends on `OrderRepository` (check the layer
   wiring in `ShopAgent`; `OrderRepository` must not depend back, which
   is why it takes `afterWrite` as a parameter today). After a successful
   `insertRun`, call `orderRepository.countOrder(order.id, now)`. If the
   dependency direction is awkward, the fallback is an `onRunInserted`
   callback injected where `ShopAgent` builds the reconciler and the
   manual-start paths; record which you chose in Deviations.
5. `setBillingCycle`'s recount from `countedAt >= start` is unchanged and
   still correct.
6. `README.md` Billing: replace the table row and prose that promise
   "Cancel in the same period, no charge" with "counted once when Baton
   starts work on the order; never reversed". Note the meter display name
   should become "Orders in production" in the Partner Dashboard; the
   handle stays `orders-synced`.
7. Tests in `order-repository.test.ts`, usage block. Delete: "cancelling a
   counted order inside the cycle queues a reversal and gives the count
   back", "cancelling in a later cycle queues nothing", "a reversed order
   paid again does not bill twice", "deleting a counted order inside the
   cycle reverses it, and in a later cycle does not", "an order that
   arrives unpaid and is paid later counts in the payment's cycle", "a
   backfilled order paid after install does not count". Rewrite "counts an
   order against the pushed billing cycle" and "counting an order queues
   one usage event" to count through `countOrder` directly. Add in
   `workflow-run-repository.test.ts`: "an order is counted once, when its
   first run is created" (two lines, two runs, one event; re-reconcile,
   still one), "a paid order with no matching line is not counted", "a
   manual run start counts the order if nothing has yet", "cancelling an
   order after its run was created queues nothing". Keep the cycle,
   dead-event, flush, and ceiling tests as they are.
8. `test/integration/shop-agent-workflows.test.ts` "seedOrders leaves the
   usage counter at one seed's worth however often it is reseeded": the
   seed path calls `reconcileAll`, so the count now comes from run
   creation; re-read the assertion and fix the expected number.

Verify: `pnpm test -- order-repository workflow-run-repository domain
shop-agent-workflows shop-agent-orders-ceiling shopify-app-events`.

## Step 6. Plan cache: drop `pendingPlanHandle` and `cancelAtEndOfCycle`

Files: `migrations/0001_init.sql`, `src/lib/Domain.ts`,
`src/lib/Repository.ts`, `src/lib/ShopifyPartner.ts`,
`src/lib/SubscriptionPlan.ts`, `src/routes/app.index.tsx`,
`src/routes/admin.shop.$shop.tsx`, `test/integration/*`.

1. `0001_init.sql`: remove `pendingPlanHandle` and `planCancelAtEndOfCycle`
   from `ShopSession`. Edit in place.
2. `Domain.ShopSession`, the column list constant beside it,
   `Domain.PlanStatus.Subscribed`, `Domain.ActiveSubscription`, and the
   admin-console view type near line 2294: remove both fields.
3. `Repository.updateShopSessionPlan` and the two select lists: remove the
   columns.
4. `ShopifyPartner`: remove `cancelAtEndOfCycle` and `pendingUpdate` from
   the query string, the response schema, and the mapping; remove
   `pendingHandle` from the result.
5. `SubscriptionPlan`: remove the fields from `subscribed`, `cachedStatus`,
   and the `updateShopSessionPlan` call. Nothing else in it depends on
   them.
6. `app.index.tsx`: remove the `cancelAtEndOfCycle` date block and the
   field on the loader result. `admin.shop.$shop.tsx`: remove
   `scheduledChange` and the "Scheduled change" row; `ADMIN_FIELDS` in
   `e2e/plan.billing.spec.ts` drops the same label.
7. `Domain.PlanStatus` JSDoc: delete the paragraph about pending tiers and
   the 2026-09-19 measurement. Replace with one sentence: a plan change may
   apply at once or at the next boundary; the cache is right either way,
   because a handle change lands on the next revalidation and the
   deadline is clamped to the boundary. Nothing longer.
8. Tests: `subscription-plan.test.ts` (the `cancelAtEndOfCycle: true`
   cases and the `planCancelAtEndOfCycle` fixture field), `repository.test.ts`,
   `member-fixtures.ts`, `member-area.test.ts`, `worker-agent-gate.test.ts`:
   remove the fields. Delete the test that asserts `stored.planCancelAtEndOfCycle`.

Verify: `pnpm test -- subscription-plan repository member-area
worker-agent-gate`.

## Step 7. Full verification

1. `pnpm typecheck`, `pnpm lint`, `pnpm fmt`, `pnpm graphql-codegen`.
2. `pnpm test` in full.
3. Grep the repo for every removed name and confirm zero hits outside
   `refs/` and `docs/`: `write_orders`, `orders/updated`, `orders/delete`,
   `ORDERS_DELETE`, `deleteOrder`, `markOrderDeleted`, `order_deleted`,
   `reverseOrder`, `reverseKey`, `orderCountsTowardCycle`,
   `firstCycleStartAt`, `unfulfilledQuantity`, `nonFulfillableQuantity`,
   `pendingPlanHandle`, `pendingHandle`,
   `cancelAtEndOfCycle`, `planCancelAtEndOfCycle`.
4. Optional browser check with Chrome DevTools MCP or Playwright CLI after
   the reset: import open orders, pay one on the dev store, confirm one
   run and one usage event; edit its quantity in the Shopify admin and
   confirm the pending run resized; cancel it and confirm the run is
   cancelled and no second event exists.

## When to ask for a reset

Ask the user to stop the dev server, run `pnpm d1:reset`, wipe local
Durable Object state (`.wrangler`), and restart, at exactly one point:
after Step 6 is typechecked and before Step 7's full test run and any
browser check. Steps 3 to 6 all change the SQLite or D1 schema in place;
running the app against old state before then will fail on missing or
extra columns. Say so in one line when you reach that point.

## JSDoc candidates from the verification

Not written. Each is a rule or a piece of subtlety the code does not currently
state, found while verifying this change rather than while planning it. Decide
per item; `CLAUDE.md` wants a rule stated once on the symbol that enforces it,
with a test whose title is the rule.

### 1. The order ceiling now measures work started, not orders stored

The strongest of these. `Domain.cycleAtOrderCeiling` gates on
`ShopUsage.ordersThisCycle`, which this change redefined: it used to be roughly
"stored, paid, not cancelled" and is now "orders Baton created a run for"
(`OrderRepository.countOrder`). The word doing the work is "counted", and its
meaning moved underneath three JSDocs that still read the old way:

- `cycleAtOrderCeiling`: "the count has reached `maxOrdersPerCycle`".
- `ShopLimits.maxOrdersPerCycle`: "Orders counted per billing cycle before
  syncing of _new_ orders stops".
- `Domain.ShopUsage.ordersThisCycle`: no JSDoc at all, which is why nothing
  anchors the definition.

A reader would reasonably take all three as a bound on stored orders. It is
not: a shop can store any number of orders no workflow matches and never
approach the ceiling, because none of them are counted. That is defensible —
the ceiling still bounds the billable quantity, which is what "enterprise
fencing" means — but it is not what the prose says, and it is the kind of
thing that is only wrong once, expensively.

Proposal: give `ordersThisCycle` the definition ("orders Baton created a run
for this cycle; {@link OrderRepository.countOrder} is the rule"), and have the
other two link it rather than restate it. The rule-titled test would be
something like "the ceiling counts orders work started on, not orders stored";
`order-repository.test.ts`'s ceiling case already has to count an order
explicitly before the ceiling trips, so the test exists and only the title and
an assertion on an uncounted order are missing.

### 2. `countOrder` never rolls the billing cycle

Recorded in Deviations but stated nowhere in source. `countOrder` increments
`ordersThisCycle` and resolves nothing; `upsertOrder` is the only path that
calls `currentCycle` and therefore the only path that rolls a stale cycle
forward. A run started by hand on a shop that has taken no order since its
cycle ended increments the outgoing cycle until the next `setBillingCycle`
recounts from `countedAt`. Self-correcting, and small, but it is the sort of
asymmetry that reads as a bug to the next person.

Proposal: one sentence on `countOrder` saying it counts into whatever cycle is
stored and deliberately does not resolve one, and why that is safe.

### 3. Partial fulfillment, stated where a reader would look for it

`Domain.unitsToMake` and the `FULFILLED` branch of `reconcileOrder` both say
fulfillment does not move `currentQuantity`. `Domain.isFulfilled` — the
predicate a reader reaches for when asking "what does Baton do about
shipping?" — says only "Shopify reported every fulfillable unit shipped".
Possibly worth a clause pointing at the rule. Low value; the rule is already
stated twice and `CLAUDE.md` prefers once.

### 4. Not recommended: a dated live measurement

The `orders/edited` behaviour confirmed above (always fetches, GID resolves
from `order_edit.order_id`) is already stated on `OrderEditWebhookPayload` in
`webhooks.orders.ts`, as reasoning rather than as a measurement. Adding
"confirmed live 2026-09-22" would cut directly against Step 6, which deleted
the 2026-09-19 `PlanStatus` measurement on the grounds that dated observations
go stale and accumulate. Left alone deliberately; noted so the decision is
visible rather than forgotten.

### 5. Test-side, not source

Neither belongs in `src/`, both cost real time to rediscover:

- The operator console renders its fields in shadow DOM, so `innerText` on the
  page body cannot see them and `readAdminFields` in `plan.billing.spec.ts` is
  the only way to read them. Worth a line on that helper.
- The E2E suite deletes its seed orders as it finishes, so a metering read
  taken straight after a suite run shows zero and looks like a metering bug.
  Worth a line wherever the seed's lifecycle is described.

## Deviations and issues

Record here anything done differently from the steps above, anything
skipped, and anything found to be wrong in this plan or the research.
One entry per item: what, why, and what the user should look at.

- **Step 2: config pushed and confirmed.** The operator console reads the
  shop's scope as `read_orders,read_products`, so the push landed and the shop
  re-authorised without re-consent, as the research predicted.
- **Step 2: the `orders/edited` test asserts a non-200, not `syncSource`.** No
  test in `test/integration` stubs the Admin API — there is no fetch mocking
  anywhere in `test/` — so a successful fetch is not observable from a delivery
  through the real worker. The test instead asserts that the `WebhookDelivery`
  row resolved to the right GID (which is what proves `order_edit.order_id` was
  read) and that the response is not 200, which is only reachable if the stale
  guard did _not_ short-circuit. The stale case beside it still asserts 200, so
  the pair is the contrast.
- **Step 4 / Step 7: `PARTIALLY_FULFILLED` survives, once.** Step 7's grep list
  demands zero hits, but Step 4 asks for a test that stages
  `PARTIALLY_FULFILLED` to prove nothing moves. The test is worth more than the
  grep; `PARTIALLY_FULFILLED` should come off the grep list. The one hit is
  `test/integration/workflow-run-repository.test.ts`, "partial fulfillment
  changes no run".
- **Step 5: the dependency, not the callback.** `WorkflowRunRepository.layer`
  now requires `OrderRepository`; the four wiring sites became
  `Layer.provideMerge(OrderRepository.layer)`. No `onRunInserted` callback.
- **Step 5: the order ceiling now trips on run creation, not on storage.**
  `Domain.cycleAtOrderCeiling` reads `ShopUsage.ordersThisCycle`, which is now
  the metered count, so `maxOrdersPerCycle` caps orders Baton started work on
  rather than orders stored. That follows from the metering decision and is
  consistent with it — the ceiling still bounds the billable quantity — but it
  is a behaviour change the plan did not name, and the ceiling test in
  `order-repository.test.ts` had to count an order before the ceiling would
  trip.
- **Step 5: `setBillingCycle` is now the only cycle correction for manual
  starts.** `countOrder` increments without resolving the cycle, so the
  roll-forward rides `upsertOrder` alone. A run started by hand on a quiet
  shop past its cycle end increments the outgoing cycle until the next
  revalidation recounts from `countedAt`. Per the plan's design; recorded
  because nothing else states it.
- **Step 5: `shop-agent-workflows.test.ts` seed test needed a workflow.**
  "seedOrders leaves the usage counter at one seed's worth" counted 0, not 2,
  because the shop had no workflow for the seeded orders to match. Added a
  `seedWorkflows` call; the expected numbers are unchanged.
- **Step 5: `Domain.UsageEvent.value` and `UsageEventRow.value` are
  `Schema.Literal(1)`.** Both, so the stored row and the sent event agree and
  no cast is needed at the flush.
- **Step 3: the orphaned-run sweep is kept.** Nothing creates an orphan now —
  every delete takes the runs with it — so its JSDoc says so and calls it a
  floor rather than a workflow. `sweepExpiredOrders` is on the plan's keep
  list, so this is not a removal the plan asked for.
- **Reset done, and the new schema verified live.** Local D1 and `.wrangler`
  were reset and the dev server restarted. `pnpm seed` writes 69 orders and
  119 runs with no column errors, and the full E2E suite (53 tests, embedded +
  member + admin) passes against the reset state.
- **Step 5 verified on live data.** After a fresh seed the operator console
  reads `Orders this billing period = 65 of 250` for 69 stored orders, with
  `Usage events pending = 0`. The four uncounted orders are the two ambiguous
  ones the reconcile logs as "no run started", the unpaid one, and one whose
  tags match no workflow — exactly the orders that got no run. Under the old
  rule this would have read 68. Seeded orders count locally and queue no
  billing event, which is what the zero pending confirms.
- **Step 6 verified on live data.** The shop page renders Cached plan, Plan
  boundary, Billing period, Orders this billing period, Usage events pending
  and Shopify metered quantity, and no longer renders "Scheduled change".
- **Step 7's browser check is done; all five topics deliver.** Driven through
  the Shopify admin against `sandbox-shop-01`, each one arriving at
  `/webhooks/orders`, fetching, and reconciling with no errors:

  | Action in the Shopify admin  | Topic              | What it proved                                                                                                                                                                        |
  | ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Complete a draft order       | `ORDERS_CREATE`    | the subscription is live                                                                                                                                                              |
  | Mark an order paid           | `ORDERS_PAID`      | the subscription is live                                                                                                                                                              |
  | Edit a line quantity, 3 to 2 | `ORDERS_EDITED`    | the second block is live, `order_edit.order_id` resolves to a GID, and the absent `updated_at` does not trip the stale guard — the one thing the unit test could only show indirectly |
  | Cancel the order             | `ORDERS_CANCELLED` | reached `reconcileOrder: status=cancelled`                                                                                                                                            |
  | Mark an order fulfilled      | `ORDERS_FULFILLED` | reached `reconcileOrder: status=fulfilled`                                                                                                                                            |

  The orders used carry no product tag any seeded workflow matches, so every
  reconcile logged `created=0` and the meter stayed at `65 of 250` with zero
  pending events — which is the metering rule stated from the other side: no
  run, no charge, however many topics knock.

## Review of the implementation (2026-09-22)

Checked against the steps and invariants above. Typecheck, lint, fmt, and
the full suite pass. Every removed name greps to zero outside `refs/` and
`docs/`; `PARTIALLY_FULFILLED` was taken off the Step 7 list, per the
deviation. Changes made on review:

- JSDoc candidate 1 done. `Domain.ShopUsage.ordersThisCycle` carries the
  definition; `cycleAtOrderCeiling` and `ShopLimits.maxOrdersPerCycle` link
  it. The ceiling test in `order-repository.test.ts` is retitled to the rule
  and asserts that a stored, uncounted order does not move the ceiling.
- JSDoc candidate 2 fixed rather than documented. `countOrder` resolves the
  cycle through `currentCycle` before it writes the marker, so a manual
  start past the cycle end rolls the cycle as an upsert would. Test: "a
  manual run start past the cycle end counts into the new cycle". The order
  matters: the roll recounts from `countedAt`, so the marker is written
  after it.
- Candidates 3 and 4 left out, as recommended.
- Candidate 5: the shadow-DOM note is on `readAdminFields`. The seed-cleanup
  note was not written: nothing in `e2e/` deletes seed orders at the end of
  a run, so the observation could not be placed.
- `Domain.canAttachRun` now says a manual attach bills the order like any
  first run, since it is the one path that meters an order Shopify has not
  been paid for.
- The `orders/edited` test says why it asserts a non-200.

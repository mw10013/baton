# Orders, webhooks, scopes, and billing: research

Date: 2026-09-22. Revision 4, all decisions settled. Implementation plan: `docs/orders-webhooks-billing-plan.md`.

Source: an external LLM discussion (it called the app "The Pond") about
webhooks, order lifecycle, App Pricing, and usage billing, checked against
what Baton does today and against the Shopify docs in `refs/` and on
shopify.dev.

## 1. Decisions

Settled:

| Decision                 | Outcome                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Scope                    | `read_orders`. No lint rule.                                                                                 |
| Metering                 | Count once when the first run is created for an order. Never reverse. Rename the meter's display name later. |
| `orders/delete`          | Drop it and everything behind it.                                                                            |
| `orders/updated`         | Drop it. Subscribe to specific topics.                                                                       |
| Partial fulfillment      | Ignore. Only order-level `FULFILLED` acts.                                                                   |
| Cancellation             | Keep automatic: cancel pending, flag active, leave done.                                                     |
| Downgrade timing         | Support immediate and scheduled alike. No further testing. One terse JSDoc line.                             |
| `pendingPlanHandle`      | Drop. Schema edited in place; no migration, all state reset.                                                 |
| Cancel without uninstall | You looked: the hosted plan page has no cancel control.                                                      |
| Flagged-run review UX    | Separate research.                                                                                           |

Settled in the third pass:

| Decision                   | Outcome                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `refunds/create`           | Not subscribed. Section 3.                                         |
| Post-start quantity change | Keep resize-pending, flag-active, on `currentQuantity`. Section 4. |
| `cancelAtEndOfCycle`       | Drop. Section 6.                                                   |

## 2. Scope

Settled. Facts for the record: `shopify.app.toml` has
`scopes = "write_orders,read_products"`; no `Order` mutation exists in
`src/`; every `orders/*` topic and the `Order` query need only
`read_orders` (`WebhookSubscriptionTopic`, 2026-10;
`refs/shopify-docs/docs/api/usage/access-scopes.md`).

Changes: toml scope line, the privacy page paragraph that mentions
`write_orders`, a toml scope test beside the topic-list test, config
redeploy. Existing installs get `app/scopes_update` with no re-consent
because no scope is added.

## 3. Webhooks

### How Baton uses a webhook

A webhook is a knock. `syncOrder` records the delivery id, applies the
`updated_at` stale guard when the payload has one, fetches the order with
`OrderSync`, upserts it, and runs `reconcileOrder` from the fetched state.
The topic is used for the log line and for nothing else. Reconcile does not
know or care which topic knocked. That is what makes retries and
out-of-order delivery safe, and it means the only question about any topic
is: does Baton need a knock when this happens?

### The topics

| Topic              | Knock for                                | Payload has order id               | Payload has `updated_at` |
| ------------------ | ---------------------------------------- | ---------------------------------- | ------------------------ |
| `orders/create`    | Order exists; show it, count nothing yet | yes                                | yes                      |
| `orders/paid`      | Create runs, count the order             | yes                                | yes                      |
| `orders/edited`    | Line items changed by a merchant edit    | as `order_edit.order_id` (numeric) | no                       |
| `orders/cancelled` | Stop pending, flag active                | yes                                | yes                      |
| `orders/fulfilled` | Order shipped; stop pending, flag active | yes                                | yes                      |
| `refunds/create`   | A refund happened                        | as `order_id`                      | no                       |

`orders/edited` per the Shopify order-editing guide: "triggered whenever an
order edit is completed", payload "reports what the edit changed, not the
order's new state", and `order_id` converts to
`gid://shopify/Order/<order_id>`. It has no `updated_at`, so it always
fetches. It needs its own toml subscription block without `include_fields`
and a second payload schema in `webhooks.orders.ts`. Edits are rare, so
always-fetch is fine.

### Who can change quantities, and which knock it produces

- **Merchant or staff, in the admin or through an app with
  `write_order_edits`.** Any non-archived order, paid or unpaid, can have
  line quantities raised, lowered, lines added or removed. Every committed
  edit fires `orders/edited`.
- **Customer.** A customer cannot change an order themselves. Since
  2026-01 customer accounts can _request_ an edit
  (`requested_order_edit/created`); nothing changes on the order until the
  merchant resolves it, and the change then lands as a merchant order
  edit (fires `orders/edited`) or as a refund (fires `refunds/create`).
- **Refund.** Lowers `currentQuantity` and `unfulfilledQuantity` on the
  refunded line. Fires `refunds/create` and nothing else Baton would
  subscribe to.
- **Fulfillment.** Lowers `unfulfilledQuantity` only. Fires
  `orders/fulfilled` when the whole order ships.

So every quantity change a person makes on purpose arrives through
`orders/edited`. The one quantity change that does not is a refund.

### `refunds/create`

Your policy is that a refund is not a production command. Under that
policy a refund knock would only ever produce a flag, and a merchant who
wants production stopped cancels the order, which knocks through
`orders/cancelled`. Without `refunds/create`, a refund's quantity effect
is still picked up by the next knock on that order or by a manual resync,
and reconcile handles it then exactly as it would have earlier, because
reconcile is from first principles.

What you give up: a maker is not told about a refund at the moment it
happens. What you avoid: a second `order_id`-shaped payload schema, a
subscription block, and a topic whose only job is to trigger a flag you
have said should not drive production.

Settled: not subscribed. Topic set is `orders/create`,
`orders/paid`, `orders/edited`, `orders/cancelled`, `orders/fulfilled`.

### Costs

Every delivery is a Worker request, a Durable Object request, an HMAC
check, a `WebhookDelivery` row, and one Admin API query unless the stale
guard fires. With the specific set an order that pays at checkout costs
two knocks and two queries (`create` then `paid`, later `updated_at`), an
order that pays later costs the same two spread out, and cancellation,
fulfillment, and edits add one each. `orders/updated` would add one per
save of the order for any reason. Cloudflare's per-request prices are
fractions of a cent per million; the query and the bookkeeping are the
real cost, and the specific set minimises both.

### What the specific set loses

Only changes with no topic: note and attribute edits, tags, archive,
financial transitions other than paid. Baton acts on none of them. The
order page shows Shopify's note and attributes from the last fetch.

### `orders/delete`

Settled: drop. Shopify only lets a merchant delete an order that is
already cancelled, archived, or from a test gateway, so `orders/cancelled`
has already done the work. Removal list: `deleteOrder` on the agent and
repository, `markOrderDeleted`, the `order_deleted` flag, the delete
branch and `ORDERS_DELETE_TOPIC` in the webhook route, their tests. The
retention sweep purges the row after a year.

## 4. What touches a run after it exists

### The timeline that matters

Runs are created only when the order is paid (`Domain.canStartRuns`).
Before paid there are no runs; an edit just replaces the stored line
items. After paid there are three windows:

1. Paid, run created, nobody has started it (pending).
2. Run started (active).
3. Run done.

A merchant edit can arrive in any of them. An unpaid-then-edited order is
the easy case: at payment, runs are created from whatever the lines say
then.

### Options for windows 1 to 3

- **A. Today's behaviour.** Pending run resized to the new quantity or
  cancelled if the line went to zero; active run flagged
  (`quantity_changed` or `item_removed`) with the numbers; done run
  flagged only. The maker on an active run decides; the pending run just
  matches the order, which is what the maker and merchant expect of a
  run nobody has touched.
- **B. Flag only.** Every window gets a flag; nothing is resized. A pending
  run for 5 sits there after the order says 3 until someone dismisses it.

You asked whether a resize on a pending run is a surprise or an
expectation. It is the expectation: the run is a copy of the order line
that nobody has acted on, and the order is the source of truth until
someone does. Flagging it instead creates work for a person to do what
the system already knows.

Settled: **A**, with one change. Today `adjust` reads
`unfulfilledQuantity`, which also drops when a line ships. With partial
fulfillment ignored, it must read `currentQuantity`, which drops only on
edits and refunds. `unitsToMake` moves to `currentQuantity` for the same
reason. Everything else in `adjust`, `dismissAcceptsQuantity`, and the
tests stays; the tests that stage a partial fulfillment go.

### Partial fulfillment

Settled: ignore. Only `displayFulfillmentStatus == FULFILLED` acts, which
is exactly when `orders/fulfilled` fires. A line shipped early changes
nothing in Baton.

## 5. Usage metering

Settled: count once, on first run creation, never reverse.

`countOrder` moves from the upsert to the point in `reconcileOrder` where
the first run for an order is created. Same transaction, so `countedAt`
still guards the one-time transition and idempotency is unchanged. The
predicate is "a run was created for this order" instead of "paid and not
cancelled".

Removal list: `reverseOrder`, the `#reverse` idempotency key, negative
`UsageEvent` values (`value` becomes `1`), the reversal branch in
`countOrder`, the delete reversal, the `orderCountsTowardCycle` paid
predicate, the README line "Cancel in the same period, no charge", and
the tests for reversal, re-pay-after-reversal, delete reversal, and
paid-but-unmatched counting. The `orders-synced` handle can stay; the
display name changes in the Partner Dashboard when you get to it.

Cycle logic (provisional cycle, roll forward, recount on a pushed period,
dead events, outbox flush) is unaffected.

## 6. App Pricing

### Downgrade timing

Superseded by `docs/plan-change-timing-research.md`: every plan change applies at once.

Settled: support both. Two dated measurements disagree (`PlanStatus`
JSDoc, 2026-09-19: immediate on the $0 dev store; your e2e recollection:
scheduled), a $0 store has nothing to prorate, and the docs do not say.
The cache is correct either way: a handle change lands on the next
revalidation and the deadline is clamped to the boundary regardless. The
JSDoc gets one line to that effect and the two measurements go.

### `pendingPlanHandle`

Settled: drop the column, the Partner query field, and the operator
console row. Schema edited in place, no migration, state reset.

### `cancelAtEndOfCycle`

You checked the hosted plan page: no cancel control. The documented ways
a subscription ends are uninstall and the app-side Partner API
`appSubscriptionCancel` mutation, which Baton never calls. That leaves no
path to "installed, cancelled, still inside the paid cycle".

Settled: drop the field from the Partner query, `PlanStatus`,
`ShopSession`, and the home-page date. If Shopify later adds a merchant
cancel, `activeSubscription` returns null after the boundary and Baton
answers `Unsubscribed`, which already redirects to plan selection, so
nothing breaks; the merchant just does not see the date in advance.

### Everything else

Matches docs and code: no subscription webhooks after 2026-04-28; state
from redirect parameters and `activeSubscription` polling; upgrades
immediate and prorated; App Events answer `202` to anything and report
errors only in the Dev Dashboard; `PERIOD_CLOSED` for events outside the
cycle; 24 hours after uninstall to flush. Baton's plan cache, billing
redirect, outbox, dead-event rule, and uninstall flush follow all of it.

## 7. Work list

Prototype phase: schema edited in place, all Durable Object and local D1
state reset, no migrations.

1. Scope to `read_orders`; privacy page; toml scope test.
2. Topics: `orders/create`, `orders/paid`, `orders/edited`,
   `orders/cancelled`, `orders/fulfilled`. Second subscription block and
   payload schema for `orders/edited`. Drop `updated` and `delete`. Update
   the toml test.
3. Remove `deleteOrder`, `markOrderDeleted`, `order_deleted`.
4. Reconcile: `adjust` and `unitsToMake` read `currentQuantity`; remove
   partial-fulfillment handling and tests.
5. Metering: count on first run creation; remove reversal; `value` is
   `1`; README billing prose.
6. `PlanStatus` JSDoc: one line, both timings supported. Drop
   `pendingPlanHandle` and `cancelAtEndOfCycle` end to end.
7. Separate research: flagged-run review UX.

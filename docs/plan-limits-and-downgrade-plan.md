# Plan limits and downgrades: implementation plan

Companion to `docs/plan-limits-and-downgrade-research.md`, which holds the reasoning and the
decisions. This document is the hand-off: an implementer should be able to work from it
without re-reading the research, but every "why" lives there.

**Status: not started.** Written against HEAD `e557111` on 2026-09-19. `BILLING_ENABLED` is
already gone; do not look for it.

## 0. Rules for the implementer

1. **No migration files.** Databases and Durable Objects are reset from scratch during
   prototyping. Every schema change goes inline into the existing DDL: the
   `1_initialize schema` migration in `src/lib/ShopAgent.ts` and `migrations/0001_init.sql`.
   No second `SqliteMigrator` entry, no `migrations/0002_*.sql`.
2. **Every limit constant carries a provisional JSDoc**, as `Domain.ENTITLEMENTS` and
   `Domain.ShopLimits` already do. Numbers are proposals. JSDoc never references `docs/`.
3. **Rules are `Domain` predicates.** A member's seat, an order's countability, and the
   ceiling test are functions in `src/lib/Domain.ts` with a JSDoc that states the rule and a
   test whose title is the rule. `scripts/rules-lint.ts` (run by `pnpm lint`) refuses inline
   status comparisons outside `Domain.ts`.
4. **Effect idioms throughout**: `Effect.fn`, `Effect.gen`, `Schema.TaggedError`, `sql`
   template literals, `Effect.annotateLogs` for structured fields. Copy the surrounding style.
5. **Lowercase SQL keywords, positional parameters** (the `sql` tag does this).
6. **Log format**: `<operation>: shop=<shop> key=<value>: <detail>`; every value in the
   message is also in `annotateLogs`. No unbounded values in messages.
7. **Run after each step**: `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm fmt`
   repo-wide keeping every file it touches. `pnpm graphql-codegen` is not needed (the Partner
   API query is a plain string, not a `#graphql` literal).
8. **Do not commit.** Leave the working tree for review.
9. **Record deviations in §15 and issues in §16 as you go**, not at the end.
10. Steps are ordered so each leaves the app working. Do them in order; each has its own
    verification.

## 1. Scope

| Step | Change                                                                                   | Files                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Read `pendingUpdate`, `cancelAtEndOfCycle`, cycle start from the Partner API; cache them | `ShopifyPartner.ts`, `Domain.ts`, `Repository.ts`, `SubscriptionPlan.ts`, `migrations/0001_init.sql`                           |
| 2    | Revoke sockets on any plan change, not only on lapse                                     | `SubscriptionPlan.ts`, test                                                                                                    |
| 3    | Shorten the plan cache on the Manage plan click                                          | `Repository.ts`, `app.index.tsx`, `QuotaBanners.tsx`                                                                           |
| 4    | Derived member seats, enforced in `requireMember`                                        | `Domain.ts`, `Repository.ts`, `MemberAccess.ts`, `worker.ts`, `shop.$shop_.lapsed.tsx`, `migrations/0001_init.sql`             |
| 5    | Members page and home: seat state, scheduled-change line                                 | `app.members.tsx`, `app.index.tsx`, `Domain.ts`                                                                                |
| 6    | Order counter keyed by billing cycle, pushed to the object                               | `Domain.ts`, `ShopAgent.ts`, `OrderRepository.ts`, `ShopAgentClient.ts`, `SubscriptionPlan.ts`                                 |
| 7    | Enterprise ceiling `ShopLimits.maxOrdersPerCycle`                                        | `Domain.ts`, `ShopAgent.ts`, `OrderRepository.ts`, `QuotaBanners.tsx`                                                          |
| 8    | Usage events: outbox, App Events client, flush, reversal on cancellation                 | `ShopifyAppEvents.ts` (new), `ShopAgent.ts`, `OrderRepository.ts`, `Domain.ts`, `Shopify.ts`, `wrangler.jsonc`, `.env.example` |
| 9    | Reconcile local count against Shopify's `usage.quantity` on revalidation                 | `ShopifyPartner.ts`, `SubscriptionPlan.ts`, `ShopAgentClient.ts`, `ShopAgent.ts`                                               |
| 10   | Copy and README: billing period wording, meters, plan table                              | `app.index.tsx`, `app.orders.index.tsx`, `QuotaBanners.tsx`, `admin.shop.$shop.tsx`, `README.md`                               |
| 11   | Dev-store verification of downgrade timing and the meter                                 | `e2e/plan.billing.spec.ts`                                                                                                     |

Out of scope: an explicit seat order (`Member.seatOrder`), any alarm or cron, Bang's progress
meters (a later UI pass), a member activate/deactivate concept (rejected).

## 2. Constants and types (read first, land in the step that needs them)

### 2.1 `Domain.Entitlements`

Rename `ordersPerMonth` to `ordersPerCycle` and update the JSDoc: the included orders per
billing cycle, past which the usage meter bills. `maxMembers` gains: "Members beyond this, in
`createdAt` order, hold no seat; see `memberHasSeat`."

```ts
export interface Entitlements {
  /** Orders included per billing cycle. Past this the usage meter bills; nothing blocks until {@link ShopLimits.maxOrdersPerCycle}. */
  readonly ordersPerCycle: number;
  /** Seats. Members past this many, ordered by `createdAt` then `email`, are refused by `requireMember`; see {@link memberHasSeat}. */
  readonly maxMembers: number;
}
```

Values stay 250 / 3 and 1,000 / 10.

### 2.2 `Domain.ShopLimits`

Add:

```ts
  /** Orders counted per billing cycle before syncing of *new* orders stops for the rest of the cycle. Provisional; enterprise fencing, not a tier. */
  maxOrdersPerCycle: 10_000,
```

### 2.3 `Domain.USAGE_METER_ORDER`

```ts
/** The App Pricing usage meter handle for a counted order, identical on every plan. Case-sensitive; must match the Partner Dashboard exactly. */
export const USAGE_METER_ORDER = "orders-synced";
```

### 2.4 `Domain.ActiveSubscription`

```ts
export const ActiveSubscription = Schema.Struct({
  handle: PlanHandle,
  /** Next contract boundary: cycle end, or trial end during a trial. */
  boundaryAt: Schema.NullOr(Schema.Number),
  /** `currentBillingCycle.startTime`; null during a trial. */
  cycleStartAt: Schema.NullOr(Schema.Number),
  /** The allowlisted handle in `pendingUpdate`, if a plan change is scheduled for the boundary. */
  pendingHandle: Schema.NullOr(PlanHandle),
  cancelAtEndOfCycle: Schema.Boolean,
  /** Shopify's count for `USAGE_METER_ORDER` this cycle, when the contract carries the meter. */
  usageQuantity: Schema.NullOr(Schema.Number),
});
```

### 2.5 `Domain.ShopSession` and D1 DDL

Three columns on `ShopSession` in `migrations/0001_init.sql`, after `planHandleExpiresAt`:

```sql
  pendingPlanHandle text,
  planBoundaryAt integer,
  planCycleStartAt integer
```

Same three fields on `Domain.ShopSession`, all `Schema.NullOr`, with `pendingPlanHandle` as
`Schema.String` for the same reason `planHandle` is (a handle outside the allowlist must not
take auth down). JSDoc: written only by `updateShopSessionPlan`; null means none or unknown.

### 2.6 `Domain.ShopUsage` and the object's DDL

Replace `monthKey` / `ordersThisMonth` with a cycle:

```sql
    create table if not exists ShopUsage (
      id integer primary key check (id = 1),
      shopGid text,
      cycleStartAt integer,
      cycleEndAt integer,
      ordersThisCycle integer not null default 0,
      ordersLimitedAt integer,
      openRunsLimitedAt integer,
      lastSweepAt integer,
      lastReconciledQuantity integer
    );
    insert or ignore into ShopUsage (id) values (1);
```

`Domain.ShopUsage`:

```ts
export const ShopUsage = Schema.Struct({
  /** The billing cycle the count belongs to; both null until the Worker has pushed one (`setBillingCycle`), in which case the count is by UTC calendar month as a fallback. */
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  ordersThisCycle: Schema.Number,
  /** Set when a new order was refused because of {@link ShopLimits.maxOrdersPerCycle}; null once the cycle rolls. */
  ordersLimitedAt: Schema.NullOr(Schema.Number),
  openRunsLimitedAt: Schema.NullOr(Schema.Number),
  databaseSize: Schema.Number,
  lastSweepAt: Schema.NullOr(Schema.Number),
  /** Usage events not yet accepted by Shopify. Non-zero for long is an operator signal. */
  pendingUsageEvents: Schema.Number,
});
```

Delete `monthKeyOf` and `monthStartOf` once nothing reads them (step 6).

### 2.7 New `Domain` predicates

```ts
/**
 * A member holds a seat when fewer than `maxMembers` members of the shop were added before
 * them, ordering by `createdAt` then `email`. Derived on every check from the plan in force
 * and the roster as it stands: nothing is written on a downgrade, a downgrade learned about
 * in a webhook changes only the next answer, and no plan history can grant a seat past the
 * current limit. The merchant frees a seat by removing a member or upgrading.
 */
export const memberHasSeat = (seatRank: number, maxMembers: number) =>
  seatRank < maxMembers;

/** An order counts toward the cycle when it is first stored, paid, not cancelled, and placed inside the cycle (exempting the install backfill). */
export const orderCountsTowardCycle = (
  order: Pick<ShopOrder, "fullyPaid" | "cancelledAt" | "processedAt">,
  cycleStartAt: number,
) =>
  order.fullyPaid &&
  order.cancelledAt === null &&
  order.processedAt >= cycleStartAt;

/** The cycle is at its ceiling when the count has reached `ShopLimits.maxOrdersPerCycle`. */
export const cycleAtOrderCeiling = (ordersThisCycle: number) =>
  ordersThisCycle >= ShopLimits.maxOrdersPerCycle;
```

Tests in `test/integration/domain.test.ts`, one per predicate, titled by the rule.

### 2.8 `Domain.MemberAccess`

Add `seatRank: Schema.Number` (0-based). `requireMember` compares it; the socket gate does
not forward it.

### 2.9 Loader data

`AppIndexLoaderData` gains `pendingPlan: Plan | null`, `planBoundaryAt: number | null`,
`cancelAtEndOfCycle: boolean`. `MembersLoaderData` gains `maxMembers: number` (members are
already ordered `createdAt, email`, so the page derives the seat cutoff by index; do not send
a per-row flag).

## 3. Step 1: read and cache the scheduled change

`src/lib/ShopifyPartner.ts`:

- Extend `activeSubscriptionQuery`:

  ```graphql
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      items {
        handle
        usage {
          quantity
        }
      }
      currentBillingCycle {
        startTime
        endTime
      }
      trialEndsAt
      cancelAtEndOfCycle
      pendingUpdate {
        items {
          handle
        }
      }
    }
  }
  ```

- Extend `ActiveSubscriptionResponse` to match; every new field `Schema.optional` or
  `Schema.NullOr` so a response that omits one still decodes.
- `pendingHandle`: apply the same allowlist match to `pendingUpdate.items` as to `items`. Zero
  or more than one match means `null`, with the same warning log.
- `usageQuantity`: the `usage.quantity` of the item whose `handle` is `USAGE_METER_ORDER`,
  else `null`. Note: the usage meter appears as its own item in `items`; the existing
  plan-handle match already tolerates that because it decodes against `PlanHandle`.
- `cycleStartAt`: `parseBoundary(currentBillingCycle?.startTime)`.

`src/lib/Repository.ts`: `updateShopSessionPlan` takes and writes the three new columns.
`upsertShopSession` continues to omit them.

`src/lib/SubscriptionPlan.ts` `revalidate`: pass `pendingPlanHandle`, `planBoundaryAt`,
`planCycleStartAt` through. `boundaryAt` is stored now as well as used for the clamp.

`Domain.PlanStatus` `Subscribed` gains `pendingPlan: NullOr(Plan)`, `boundaryAt: NullOr(Number)`,
`cancelAtEndOfCycle: Boolean`, decoded from the row in `cachedStatus` and from the API in
`revalidate`. Both paths go through one helper so they cannot drift.

Verify: `subscription-plan.test.ts` gains "caches the scheduled plan change and the boundary"
and "a pending handle outside the allowlist is cached as none". Admin shop page shows the
pending handle and boundary (step 10).

## 4. Step 2: revoke on any plan change

`revalidate` currently revokes only when `handle === null && shopSession.planHandle !== null`.
Change the condition to `handle !== shopSession.planHandle` (string compare, null included).
A never-cached row (`planHandle` null, `planHandleExpiresAt` null) with a fresh handle is not a
change; keep that exclusion explicit, since otherwise every first resolve revokes.

Update the JSDoc: a downgrade can leave a member without a seat on an open socket with a
keepalive; the reconnect re-runs the gate. Seated members reconnect and pass.

Verify: rename and extend the existing revoke tests: "revokes the shop's connections when the
cached plan changes tier", "does not revoke on first fetch".

## 5. Step 3: shorten the cache on Manage plan

`Repository.ts`:

```ts
/** Pulls the plan cache deadline forward to at most `notAfter`, never backward, and never on a never-fetched row. */
readonly shortenShopSessionPlanExpiry: (input: { shop: Domain.Shop; notAfter: number }) => Effect.Effect<void, SqlError.SqlError>;
// update ShopSession set planHandleExpiresAt = min(planHandleExpiresAt, ?) where shop = ? and planHandleExpiresAt is not null
```

`SubscriptionPlan.ts`: a constant

```ts
/** How long the cache stays fresh after the merchant opens the pricing page. Bounds a lost welcome redirect to minutes rather than `PLAN_HANDLE_MAX_AGE_MS`; costs one Partner call per Manage plan click. */
const PLAN_HANDLE_MANAGE_WINDOW_MS = 15 * 60 * 1000;
```

and a service method `expectChange(shop)` that calls the repository with `now + window`.

`app.index.tsx`: a POST server function `prepareManagePlanFn` with
`shopifyServerFnMiddleware` that calls `expectChange`, then the button's `onClick` awaits it
before `window.open(managePlanUrl, "_top")`. On failure still open the page; log the failure
(the cache is a latency optimisation, never a gate on the click). The `managePlan` node is
passed into `QuotaBanners` as today, so both buttons get it.

Verify: `repository.test.ts` "shortens the plan deadline but never extends it or writes a
never-fetched row"; e2e billing spec unchanged (the redirect path still works).

## 6. Step 4: derived member seats

`migrations/0001_init.sql`: add `create index if not exists Member_shop_createdAt_idx on Member (shop, createdAt, email);`.

`Repository.findMemberAccess`: add the rank to the same round trip. Extend the query with a
correlated subquery:

```sql
select m.id as memberId, t.id as teamId, t.name as teamName,
  (select count(*) from Member p
   where p.shop = m.shop and (p.createdAt < m.createdAt or (p.createdAt = m.createdAt and p.email < m.email))) as seatRank
from Member m ...
```

Decode `seatRank` as `Schema.Number` and return it on `MemberAccess`.

`MemberAccess.requireMember`: after the plan resolves to `Subscribed`, compute
`Domain.entitlementsOfPlan(plan).maxMembers` and refuse when
`!Domain.memberHasSeat(access.seatRank, maxMembers)`. The refusal is
`redirect({ to: "/shop/$shop/lapsed", params: { shop }, search: { reason: "seat" } })`.
Update the JSDoc: the seat rule, why it is derived, and why the answer is the lapsed page
(the member cannot fix it; the merchant can).

`shop.$shop_.lapsed.tsx`: accept an optional `reason` search param (`"seat"`), validated with
a `Schema.Literals`. Copy for `seat`: "Your shop's Baton plan does not include a seat for you.
Ask the shop owner to free a seat or upgrade." Heading "No seat on this plan". Default copy
unchanged. Keep the page static.

`worker.ts` `authorizeShopAgentMember`: unchanged in code, since the redirect already maps to
`402`. Update the comment to name both reasons.

Verify: `member-area.test.ts` and `worker-agent-gate.test.ts`: "the fourth member of a
three-seat shop is refused with the seat reason", "removing an earlier member seats the
next", "a member's seat follows the plan in force at each request" (seed Pro, four members,
flip the cached handle to Basic, assert the fourth is refused and the third still passes).
`repository.test.ts`: "seat rank orders by createdAt then email".

## 7. Step 5: members page and home page

`app.members.tsx`:

- Loader adds `maxMembers` from `resolveEntitlements`.
- Rows at index `>= maxMembers` show an `s-badge` "No seat" beside the email. The list is
  already in seat order.
- A critical banner when `members.length > maxMembers`: "Your plan includes N members. Only
  the N oldest can sign in until you remove members or upgrade." with Remove pointing at the
  existing per-row action and the Manage plan control (import the same server function from
  step 3; move `prepareManagePlanFn` and the button into a small `ManagePlanButton` component
  under `src/components/` so three pages share it).

`app.index.tsx`:

- Members line becomes "Members: n of m" plus, when `n > m`, "(n − m without a seat)".
- Scheduled change line, from `PlanStatus`: when `pendingPlan` is set, "Changes to
  {Pro|Basic} on {date}"; when `cancelAtEndOfCycle`, "Subscription ends on {date}". Use the
  existing `LocalDateTime` component. When the pending plan's `maxMembers` is below the
  current member count, a warning banner: "Basic includes 3 members; you have 9. Remove
  members before {date} or the 3 oldest keep their seats."
- Route context from `app.tsx` `authenticateAppRoute` gains `pendingPlan`, `boundaryAt`,
  `cancelAtEndOfCycle` from the `Subscribed` status.

Verify: `e2e/members.spec.ts` gains a case that seeds `maxMembers + 2` members on Basic and
asserts two "No seat" badges and the banner sentence.

## 8. Step 6: cycle-keyed counter

The Worker pushes the cycle to the object; the object counts against it. This is the one
piece of plan-adjacent state the object stores, and it is a period, not an entitlement.

`ShopAgent.ts`: a plain RPC (not `@callable()`) `setBillingCycle(input: Domain.BillingCycleInput)`
with `{ shopGid, cycleStartAt, cycleEndAt }`. It writes the three columns on `ShopUsage`. When
`cycleStartAt` differs from the stored one, it also resets `ordersThisCycle` to the number of
orders already counted in the new cycle (`select count(*) from ShopOrder where countedAt >= ?`,
see step 8 for `countedAt`; before step 8 lands, reset to 0) and clears `ordersLimitedAt`.

`ShopAgentClient.ts`: expose `setBillingCycle(shop, input)`.

`SubscriptionPlan.revalidate`: after the cache write, when the contract has a `cycleStartAt`,
call `setBillingCycle`. Failure is logged and ignored, same as the revoke: the plan answer is
correct regardless, and the next revalidation retries.

`OrderRepository.countTowardQuota`: read `cycleStartAt` from `ShopUsage` in the same
transaction (one row). When it is null, fall back to the UTC month start of `syncedAt` (the
old behaviour, kept so a shop counts before its first revalidation). Use
`Domain.orderCountsTowardCycle(order, cycleStartAt)`. Roll-forward when `syncedAt >= cycleEndAt`:
set `cycleStartAt = cycleEndAt`, `cycleEndAt = null`, count 0, clear `ordersLimitedAt`; the
boundary-clamped revalidation lands the exact next cycle within minutes.

`ShopAgent.getUsage`: no roll-forward in the returned value any more; the row is authoritative.
Add `pendingUsageEvents` (0 until step 8) and `databaseSize` as today.

Rename every `ordersThisMonth` / `monthKey` reader: `QuotaBanners.tsx`, `app.index.tsx`,
`app.orders.index.tsx`, `admin.shop.$shop.tsx`, `deleteSeedOrders`, the tests named in §14 item 5.

Verify: `order-repository.test.ts` "counts an order against the pushed billing cycle",
"falls back to the calendar month before a cycle is known", "rolls the cycle forward on the
first order past its end". `subscription-plan.test.ts` "pushes the billing cycle to the object
on revalidation".

## 9. Step 7: enterprise ceiling

`ShopAgent.syncOrder` (webhook path), after the duplicate and stale checks and before
`fetchAndUpsert`: if `getOrderUpdatedAt(orderId)` is none (a new order) and
`Domain.cycleAtOrderCeiling(usage.ordersThisCycle)`, set `ordersLimitedAt = coalesce(ordersLimitedAt, now)`,
log at error level with `status=order-ceiling`, publish so the merchant's open pages refresh,
and return. Updates to stored orders still flow. The webhook returns 2xx: a retry cannot
change the answer.

`ShopAgent.syncOrders` (bulk path): the same test beside the storage guard, with
`setSyncError({ error: "Baton is built for shops under 10,000 orders a billing period; syncing resumes when the period ends." })`.

`QuotaBanners.tsx`: a critical banner when `usage.ordersLimitedAt !== null`, same sentence
plus the cycle end date.

Verify: `shop-agent-workflows.test.ts` or a new `shop-agent-orders-ceiling.test.ts`: lower
`ShopLimits.maxOrdersPerCycle` through the same scoped-override seam the open-run tests use,
assert a new order is dropped, an existing order still updates, and the flag clears on
`setBillingCycle` with a new start.

## 10. Step 8: usage events

### 10.1 Credential and config

No new secret. The App Events API authenticates with the app's Client ID and Secret, which
the Worker already holds as `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`. Add
`SHOPIFY_APP_EVENTS_API_VERSION: "2026-07"` to `wrangler.jsonc` `vars` (all three blocks).
Nothing changes in `.env.example`.

### 10.2 `src/lib/ShopifyAppEvents.ts` (new)

A `Context.Service` with one method:

```ts
readonly send: (event: Domain.UsageEvent) => Effect.Effect<void, ShopifyAppEventsError>;
```

`Domain.UsageEvent`: `{ shopGid, eventHandle, timestamp (ms), idempotencyKey, value: number }`.

Token: `POST https://api.shopify.com/auth/access_token` with JSON
`{ client_id, client_secret, grant_type: "client_credentials" }`; the response carries
`access_token`, `scope` (`write_global_api_app_events`) and `expires_in` seconds (3599). Hold
the token in a `Ref` inside the layer with its expiry, and mint a new one when fewer than five
minutes remain or a send answers `401`. One token per object instance is fine: the object is
single-threaded and the token is per app, not per shop.

Event: `POST https://api.shopify.com/app/${version}/events` with `Authorization: Bearer`, body
`{ shop_id, event_handle, timestamp (ISO), idempotency_key, attributes: { value } }`. Any
non-2xx is an error; `202` is success and says nothing about billing validity (that shows only
in the Dev Dashboard logs). Same `HttpClient` shape as `ShopifyPartner` (`filterStatusOk`,
`retryTransient` twice). Provide the service in the object's layer beside
`FetchHttpClient.layer` in `ShopAgent.ts` (the `layer` built around line 625); the client id
and secret come through the same `Config` reads `Shopify.layerNoDeps` uses.

### 10.3 Outbox

Object DDL:

```sql
    create table if not exists UsageEvent (
      idempotencyKey text primary key,
      orderId text not null,
      value integer not null,
      occurredAt integer not null,
      attempts integer not null default 0,
      lastError text
    );
```

And on `ShopOrder`: `countedAt integer` (null when never counted).

`countTowardQuota` becomes `countOrder`: when the order counts, set `countedAt = syncedAt`,
increment `ordersThisCycle`, and insert a `UsageEvent` with key `${order.id}#count` and value
`1`. In the same `upsertOrder` transaction, when the stored row had `countedAt` inside the
current cycle and `cancelledAt` was null, and the incoming order has `cancelledAt` set:
decrement `ordersThisCycle` (floor 0), insert `${order.id}#reverse` with value `-1`, and clear
`countedAt`. Both keys are under 64 characters for any Shopify order GID.

### 10.4 Flush

`OrderRepository.flushUsageEvents`: read up to `ShopLimits.sweepBatch` rows ordered by
`occurredAt`, `send` each; delete on success, else increment `attempts` and store the error
message (bounded to 200 characters). Run it at the end of `syncOrder` and at the end of the
bulk import's stream, outside the upsert transaction, with failures logged at warning level and
never failing the carrier request. Include `shopGid` on the event from `ShopUsage.shopGid`;
when it is null (no cycle pushed yet) leave the rows in place and log once at debug.

`getUsage` reports `pendingUsageEvents = count(*) from UsageEvent`.

### 10.5 Uninstall

`webhooks.app.uninstalled.ts`: before `destroyShopAgent`, call a plain RPC
`flushUsageEvents()` on the object and log the remaining count. A flush failure does not stop
the destroy: the 24-hour window is Shopify's and the storage must still go.

### 10.6 Tests

`order-repository.test.ts`: "counting an order queues one usage event", "cancelling a counted
order inside the cycle queues a reversal and gives the count back", "cancelling in a later
cycle queues nothing", "a re-sync never queues a second count". A stub `ShopifyAppEvents`
layer recording sends: "flush deletes accepted events and keeps refused ones with the error".

## 11. Step 9: reconciliation

`SubscriptionPlan.revalidate`: when the contract reports `usageQuantity`, call a plain RPC
`reconcileUsage(shop, { quantity })` on the object, which stores `lastReconciledQuantity` and,
when it differs from `ordersThisCycle` by more than `pendingUsageEvents`, logs a warning
`SubscriptionPlan.reconcile: shop=... local=... shopify=... pending=...`. Nothing is corrected
automatically; the admin shop page shows both numbers.

Verify: `subscription-plan.test.ts` "reconciles the usage figure on revalidation";
`shop-agent-callables.test.ts` lists the new RPCs as non-callable.

## 12. Step 10: copy and README

- "Orders this month" becomes "Orders this billing period" everywhere, with "resets {date}"
  when `cycleEndAt` is known.
- `QuotaBanners` over-quota banner: "You've used n of m included orders this billing period.
  Extra orders are billed at your plan's rate." plus Manage plan.
- Admin shop page: cycle start and end, pending handle, boundary, `ordersThisCycle`,
  `pendingUsageEvents`, `lastReconciledQuantity`, `ordersLimitedAt`.
- README "Billing": plan table carries the `orders-synced` meter (tiered, graduated: 250 / 1,000
  units at $0.00, then $0.15 / $0.10), the credentials section notes that App Events uses the app's Client ID and Secret,
  and "Top features" reads "250 orders a billing period included, then $x per order".

## 13. Step 11: dev-store verification

Extend `e2e/plan.billing.spec.ts` (headed, `pnpm test:e2e:billing`): after a Pro to Basic
switch, open `/admin/shop/<shop>`, click Refresh plan, and record in §17 of this document what
`pendingPlanHandle` and `planBoundaryAt` read. That answers whether paid-to-paid downgrades
defer. Then sync one order and confirm on the admin page that `pendingUsageEvents` returns to
0 and, after a second Refresh plan, `lastReconciledQuantity` moves. The `orders-synced` meter already
exists on both plans (tiered, graduated, cost per unit; README "Billing" has the tiers).

## 14. Test and verification checklist (whole change)

1. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`: green.
2. `pnpm seed` succeeds and `deleteSeedOrders` still subtracts.
3. `pnpm test:e2e` green, including the new members case.
4. Headed billing spec run, with the §17 record filled in.
5. `grep -rn "ordersThisMonth\|monthKey\|ordersPerMonth\|monthKeyOf\|monthStartOf" src test e2e` returns nothing.

## 15. Deviations

The implementer records here anything that departed from this plan: what the plan said, what
was done instead, and why. One entry per deviation, newest last. Leave the heading in place
even if empty.

| Step | Plan said | Done instead | Why |
| ---- | --------- | ------------ | --- |

## 16. Issues

Problems found during implementation that the plan did not anticipate: a Shopify response
shape that differs from the documentation, a test seam that does not exist, a question only
the project owner can answer. One entry per issue with what was observed, what was done in the
meantime, and what remains open. Leave the heading in place even if empty.

| Step | Observed | Interim | Open |
| ---- | -------- | ------- | ---- |

## 17. Verification record

Filled in by the implementer after §14, including the dev-store readings from step 11.

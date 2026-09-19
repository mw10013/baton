# Plan limits and downgrades: implementation plan

Companion to `docs/plan-limits-and-downgrade-research.md`, which holds the reasoning and the
decisions. This document is the hand-off: an implementer should be able to work from it
without re-reading the research, but every "why" lives there.

**Status: implemented and reviewed, uncommitted.** Written against HEAD `8af4666` on 2026-09-19,
implemented the same day, and reviewed the same day; the review's fixes are recorded in §15 and
§16. `BILLING_ENABLED` is already gone; do not look for it. Steps 1-10 are in the working tree and
verified against the local dev store, including the usage meter, the reconciliation read, and a
live plan switch in both directions (§17). Step 11's spec is written; its headed run is the one
pending item.

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
  and the per-plan "Top features" lines, which are 40-character fields rather than one
  sentence — README "Billing" holds the exact lines and what each must agree with.

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

| Step      | Plan said                                                                             | Done instead                                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (§2.5)  | Three new `ShopSession` columns                                                       | Four: `planCancelAtEndOfCycle integer not null default 0` as well                                                                                                            | §3 requires `cancelAtEndOfCycle` to be decoded from the row in `cachedStatus`, and no column carried it. Without one, "Subscription ends on {date}" would appear only on the request that revalidated and never again until the cache expired. `not null default 0` so a never-revalidated row decodes as "not cancelled" rather than as a third state the page would have to render.                                                                                                                    |
| 1         | `upsertShopSession` takes `Omit<ShopSession, "planHandle" \| "planHandleExpiresAt">`  | A named `Domain.ShopSessionUpsert` schema, omitting all six plan-cache columns                                                                                               | `Shopify.ts` _decodes_ the row it upserts against a schema. With six columns the decode would have had to restate their defaults on the authentication path, which is exactly the coupling the narrow-update split exists to avoid. One name, two agreeing signatures.                                                                                                                                                                                                                                   |
| 5 (§7)    | `app.tsx` route context gains `pendingPlan`, `boundaryAt`, `cancelAtEndOfCycle`       | The home loader resolves the status itself and puts them in `AppIndexLoaderData`                                                                                             | The file's own rule, stated on `resolveEntitlements` and repeated in `app.index.tsx`: the loader is isomorphic, so taking plan facts from context means the browser supplying them on most page views. The loader resolves the status once and takes both the entitlements and the scheduled change off it.                                                                                                                                                                                              |
| 6 (§8)    | When `cycleStartAt` is null, fall back to the UTC month start of `syncedAt` per write | The object _opens_ a provisional cycle at that instant and writes it (`Domain.provisionalCycleStart`)                                                                        | §14 item 5 forbids `monthStartOf` surviving, and a written cycle collapses two code paths into one: everything downstream reads a cycle that exists. `setBillingCycle` replaces it with Shopify's period on the first revalidation.                                                                                                                                                                                                                                                                      |
| 6 (§8)    | `setBillingCycle` resets the count to the orders already counted in the new cycle     | Same, and it recounts on _every_ start change rather than only the first                                                                                                     | Same statement, but stated as a rule: a cycle change means orders before the new start belong to a closed period. Zeroing would have made the merchant-facing count disagree with the invoice for a shop that had already counted into a provisional cycle.                                                                                                                                                                                                                                              |
| 8 (§10.4) | `OrderRepository.flushUsageEvents` uses `ShopifyAppEvents`                            | It does, as a requirement of the _effect_ (`R`), not of `OrderRepository.layer`                                                                                              | `OrderRepository.layer` is built from a bare SQLite client by the object and by `order-repository.test.ts`. A layer dependency would force an `HttpClient` on every construction site, including tests that never flush.                                                                                                                                                                                                                                                                                 |
| 8 (§10.3) | `deleteSeedOrders` subtracts by `fullyPaid`                                           | Subtracts by `countedAt is not null`, and deletes the seed's queued `UsageEvent` rows                                                                                        | `countedAt` is the marker the meter actually writes, so the subtraction matches what was added however the order later changed. The queued events go because a fixture must not bill a development store.                                                                                                                                                                                                                                                                                                |
| 7/9       | The webhook ceiling reads `getUsage()`                                                | It reuses the single `getUsage()` read the retention sweep already needed                                                                                                    | The webhook path pays every read per delivery, and the two checks want the same one-row table.                                                                                                                                                                                                                                                                                                                                                                                                           |
| —         | (not in the plan)                                                                     | `api.dev.seed` now adds members uncapped instead of at `MAX_ENTITLEMENTS.maxMembers`                                                                                         | The add-time cap is a rule about _adding_; the seat rule is derived. A local fixture that cannot seed a shop past its seats cannot exercise `memberHasSeat` at all, which is what the new `members.spec.ts` case needs.                                                                                                                                                                                                                                                                                  |
| —         | (not in the plan)                                                                     | The dev fixture seeds three members (`lead`, `m1` on two maker teams, `m2` on Rush) instead of ten                                                                           | Ten was `MAX_ENTITLEMENTS.maxMembers`, so a sandbox on Basic read "10 of 3" with seven "No seat" badges on every reseed. Three is the smallest plan's ceiling, so every seeded login holds a seat whichever plan the store is on; the specs seed their own personas through `seedMembers`, so no test depended on the ten.                                                                                                                                                                               |
| 11 (§13)  | Extend the billing spec to record the readings                                        | Done as a second test that attaches the admin cache fields to the Playwright report and asserts only what Baton owns                                                         | Shopify's downgrade timing is Shopify's behaviour: asserting a particular answer would encode a guess as a requirement. The test records; §17 is where the answer goes.                                                                                                                                                                                                                                                                                                                                  |
| 8         | (not anticipated)                                                                     | A seeded order counts toward `ordersThisCycle` but queues **no** usage event (`Domain.orderIsSeeded`, enforced in `queueUsageEvent`)                                         | Found on the dev store: `pnpm seed` left 69 events in the outbox, which the next webhook would have sent. The local counter is reversible — `deleteSeedOrders` subtracts on the next reseed — but a billing event is not, because Shopify enforces idempotency keys permanently. A fixture that bills is a fixture that costs money.                                                                                                                                                                     |
| 5 (§7)    | The seat banner lives on the members page only                                        | The home page carries it too                                                                                                                                                 | The home page is where the merchant lands after the downgrade and where the Manage plan control is; the banner names the fix and the seat count in one place. The members page keeps its own for the row actions.                                                                                                                                                                                                                                                                                        |
| 5 (§7)    | The home loader calls `resolveEntitlements`                                           | It resolves the status once and takes the entitlements off it through `entitlementsOfStatus`                                                                                 | The loader already resolved the status for the scheduled change, and `resolveEntitlements` would have resolved it a third time per view (after `beforeLoad`). The redirect arm is stated once in `entitlementsOfStatus`; `resolveEntitlements` is now a thin caller of it.                                                                                                                                                                                                                               |
| 8 (§10.3) | Only a cancellation reverses a counted order                                          | `orders/delete` reverses too, when the row was counted inside the current cycle                                                                                              | A deleted order is not work carried, and a GID that is deleted and later re-synced would otherwise count locally a second time while Shopify's permanent idempotency key silently dropped the second event: local and Shopify would diverge by one.                                                                                                                                                                                                                                                      |
| 7 (§9)    | The bulk-path ceiling is tested once beside the storage guard                         | Also per order inside the stream: a fresh order past the ceiling is skipped, updates still flow                                                                              | One bulk run could otherwise insert arbitrarily many fresh orders past `maxOrdersPerCycle`, which made the JSDoc's "the one hard stop" untrue on the path most likely to hit it.                                                                                                                                                                                                                                                                                                                         |
| 8 (§10.4) | Refused events retry on every flush                                                   | An event whose cycle has ended is dead-lettered: kept for the admin page, never retried, excluded from the reconcile tolerance                                               | Shopify refuses an event dated into a closed period, so such a row can never succeed; retried forever it sat ahead of live events in every flush and, counted in `pendingUsageEvents`, hid one unit of billing divergence each in `reconcileUsage`.                                                                                                                                                                                                                                                      |
| 6/8       | `setBillingCycle` recounts on a start change                                          | When the shop had no `shopGid` yet (provisional or trial cycle), it also drops queued events dated before the new start; once addressed, a missed event stays dead-lettered  | The recount already drops those orders from the count. Events queued before the shop was addressable could never have been sent, so flushing them afterwards would bill them into the new period against a count that excludes them. An event that was addressable and still missed its period is a real loss and is kept as dead for the admin page rather than silently removed.                                                                                                                       |
| 6 (§2.7)  | An order counts on first insert only                                                  | It also counts when a stored order's `fullyPaid` goes false to true, in the cycle of the payment, provided it was first stored in that cycle (`ShopOrder.firstCycleStartAt`) | The §16 decision. A made-to-order shop that collects later would otherwise carry work that is never billed. The payment's cycle is the only one Shopify accepts an event for; "first stored inside the cycle" restates the backfill exemption in terms the payment path can honour (first sync would have billed the whole install backfill, which is by definition first synced inside the cycle), so an install backfill of old-but-newly-paid orders does not bill. `countedAt` stays the one marker. |

## 16. Issues

Problems found during implementation that the plan did not anticipate: a Shopify response
shape that differs from the documentation, a test seam that does not exist, a question only
the project owner can answer. One entry per issue with what was observed, what was done in the
meantime, and what remains open. Leave the heading in place even if empty.

| Step | Observed                                                                                                                                                                                                                                                                                                         | Interim                                                                                                                                                                                                                                                                                                   | Open                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8    | **Workers `fetch` sends no `User-Agent`, and `api.shopify.com` answers that with a `403` and an HTML body** — from its edge, before the API sees the credentials. Every usage event failed this way. Measured against the live endpoint: the same request `400`s on the merits with a UA and `403`s without one. | Fixed: the App Events client sets `User-Agent: Baton/<app handle>`.                                                                                                                                                                                                                                       | Nothing. Verified end to end.                                                                                                                                  |
| 8    | **The token response does not match the documented shape.** Shopify's tutorials show `{ access_token, scope, expires_in }`; the live endpoint returned `{ access_token, token_type }`. Requiring `expires_in` failed every mint.                                                                                 | Fixed: only `access_token` is required, and the lifetime falls back to the documented 60 minutes when `expires_in` is absent.                                                                                                                                                                             | Nothing. Verified end to end.                                                                                                                                  |
| 8    | **A send failure was recorded on the outbox row and nowhere else.** `lastError` is a column no surface renders, so a meter that had silently stopped billing produced no log line.                                                                                                                               | Fixed: a refused send logs at warning with the idempotency key, the attempt count, and Shopify's own reason. The token endpoint's refusal body is read rather than thrown away, and a body that fails to decode is logged by its _keys_ only, never its values, so a live token cannot reach a log.       | Nothing.                                                                                                                                                       |
| 9    | **`activeSubscription.items` carried no meter item**, so reconciliation had never run.                                                                                                                                                                                                                           | **Closed.** The contract predated the meter being configured on the plan; a contract carries the item set it was created with. Replacing it brought the item back, and reconciliation then read `quantity: 2` against a local count of 2. See "Reconciliation, and why the meter item was missing" below. | A meter added or re-handled on a live plan leaves existing contracts unable to report usage. Worth a note in any future meter change.                          |
| 8    | The App Events docs bundled in `refs/shopify-docs` only ever show `https://api.shopify.com/app/unstable/events`, and an unauthenticated probe cannot tell a good version from a bad one — every version answers `401`, auth first.                                                                               | Shipped `2026-07` behind `SHOPIFY_APP_EVENTS_API_VERSION` in all three `wrangler.jsonc` blocks.                                                                                                                                                                                                           | **Closed.** `2026-07` accepted seven live events on 2026-09-19, each logged `App billing event / orders-synced / OK`.                                          |
| 8    | `ShopUsage.shopGid` is null until the Worker has pushed a cycle, and a usage event cannot be addressed without it.                                                                                                                                                                                               | The flush leaves such rows in place and logs once at debug rather than dropping them; they go out on the first flush after a revalidation. Covered by "leaves events queued until a billing cycle names the shop".                                                                                        | Nothing. The window is one plan revalidation wide.                                                                                                             |
| 8    | The App Events API answers `202` to events it will later refuse, so "sent" is not "billed".                                                                                                                                                                                                                      | The outbox deletes on a 2xx (there is nothing better to wait for) and the divergence check on `reconcileUsage` is the only real signal; the admin page shows both numbers.                                                                                                                                | **Closed** for the handle question: the Dev Dashboard confirms the events are billable. The divergence check itself is still untested, which is the row above. |
| 11   | `shop-agent-callables.test.ts` did not list `setBillingCycle`, `reconcileUsage` and `flushUsageEvents` as non-callable (§11).                                                                                                                                                                                    | Closed in review: the test now pins them as plain RPCs.                                                                                                                                                                                                                                                   | Nothing.                                                                                                                                                       |
| 14   | `pnpm seed` and `pnpm test:e2e` run green against the reset dev store, the usage path was exercised with real orders, and the plan switch was driven through a real browser rather than the headed spec.                                                                                                         | —                                                                                                                                                                                                                                                                                                         | Nothing. §13's questions are answered in §17; the spec itself is written but has not been executed as a spec.                                                  |
| 6    | The first seed after the server restart read `0 of 1,000` with a null billing period.                                                                                                                                                                                                                            | Re-seeding produced the right numbers; that first run predated the reloaded Durable Object. Not reproducible afterwards.                                                                                                                                                                                  | Nothing. Noted so a future reader does not chase it.                                                                                                           |
| 11   | **Seven test orders were left on `sandbox-shop-01`** (`#1564`-`#1571`, tagged `baton-usage-check`, $1 each), created through `orderCreate` to exercise the meter. Six counted and billed; `#1564` did not, for the reason above.                                                                                 | Deleted on 2026-09-19 after review; §17 keeps the readings they produced.                                                                                                                                                                                                                                 | Nothing.                                                                                                                                                       |
| 6    | **An order that arrives unpaid and is paid later never counts.** See "Orders paid after they arrive" below — the project owner's lean is that it should count.                                                                                                                                                   | **Decided and implemented**: it counts on the `fullyPaid` false-to-true transition, in the payment's cycle, exempting orders first stored in an earlier cycle (§15). `Domain.orderCountsTowardCycle` is the rule; `OrderRepository.countOrder` holds the three transitions.                               | Nothing.                                                                                                                                                       |

### Reconciliation, and why the meter item was missing — settled

Run on 2026-09-19 with `baton-pro`'s tier 1 temporarily dropped to a single unit, then reverted.
Both open Shopify questions closed in one session.

**The threshold theory was wrong.** The metered item does not wait for usage to accrue a cost.
It was absent because the shop's contract **predated the meter being configured on the plan**,
and an App Pricing contract carries the item set it was created with. Replacing the contract —
any plan switch does it — brought the item back immediately, before a single event:

```json
{
  "handle": "orders-synced",
  "price": { "__typename": "TieredPrice" },
  "usage": { "quantity": 0, "cost": { "amount": "0.0" } }
}
```

That matters more than the theory it replaced. A shop that subscribed before a meter existed
will never report usage, and no amount of waiting fixes it; a shop that subscribed after one
reports from zero. If a meter is ever added or re-handled on a live plan, existing contracts
need re-selecting or their usage silently stops being readable.

**Reconciliation then worked end to end.** Two paid orders inside the new cycle, and
`/admin/shop/<shop>` after Refresh plan:

| Field                        | Reading                                                |
| ---------------------------- | ------------------------------------------------------ |
| Billing period               | Sep 19, 5:19 PM - Oct 19, 5:19 PM (the fresh contract) |
| Orders this billing period   | 2 of 1,000                                             |
| Usage events pending         | 0                                                      |
| **Shopify metered quantity** | **2**                                                  |

Local 2, Shopify 2, no divergence warning. That exercises the last untested link: `usageQuantity`
read from the contract, pushed through `reconcileUsage`, stored, and displayed. It also exercises
`setBillingCycle`'s recount — the object had been counting against the old cycle, and the push
of the new one recounted from `countedAt` to exactly the two orders that belong to it.

**Downgrade timing, answered at the same time.** A paid-to-paid downgrade is **immediate**, not
deferred. Straight after approving Pro to Basic the contract read `items: [{ handle:
"baton-basic" }]` with `pendingUpdate: null` — no scheduled change, the handle had already
moved. So `pendingPlanHandle` stays null through an ordinary downgrade, and the scheduled-change
line on `/app` is for cancellations and whatever else Shopify chooses to defer, not for tier
switches. Caveat worth keeping: this is a development store at $0, and Shopify may treat a
downgrade that owes a proration differently on a live store.

One incidental confirmation: Basic carries a 14-day trial, and on that contract
`currentBillingCycle` was `null` with the trial running — the trial path
{@link Domain.ActiveSubscription} documents, seen for real. No cycle is pushed to the object
while a shop is in trial, and it counts against its provisional cycle until the trial ends.

### Orders paid after they arrive

The one open product question, found by accident: test order `#1564` was created with
`financialStatus: PAID` but no transaction, so Shopify reported `fullyPaid: false`. Baton stored
it and did not count it, and when it is paid later it will still not count, because counting
fires **on first insert only** — `countOrder` returns early for any write that is not `fresh`.

That is exactly what this plan and the research asked for, and it was harmless while the count
only drove a banner. It now decides a charge. A made-to-order shop that invoices and collects
later — deposits, trade accounts, COD — would have that work carried and never billed.

**The owner's lean is that it should count.** Before it is implemented, three things have to be
decided, because the rule is one rule and these are its edges:

1. **What the trigger is.** The natural one is the `fullyPaid` false-to-true transition on a
   stored order, which is the mirror of the cancellation reversal already in `countOrder`: same
   place, same probe (`StoredOrderCounting` already reads the stored row before the upsert
   overwrites it), opposite direction. It would need `fullyPaid` added to that probe.
2. **Which cycle it lands in.** Counting on payment means the _payment's_ cycle, not the
   order's. An order placed in September and paid in October bills in October. That is defensible
   and it is also what Shopify can accept — `PERIOD_CLOSED` refuses an event dated into a closed
   period — but it means `orderCountsTowardCycle`'s `processedAt >= cycleStartAt` term is wrong
   for this path, and the backfill exemption has to be restated in terms of payment rather than
   placement or an install backfill of old-but-newly-paid orders would bill.
3. **Whether `countedAt` still means one thing.** Today it is "counted, and reversible until the
   cycle ends". If payment can count an order, `countedAt` has to keep being the single marker
   that makes both the count and the reversal fire exactly once, across two different triggers.

Not started. It is a change to `Domain.orderCountsTowardCycle`, `countOrder`'s probe, and their
tests, and it wants its own pass rather than being folded into this one.

## 17. Verification record

Filled in by the implementer after §14, including the dev-store readings from step 11.

| Check                                                                                         | Result                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm typecheck`                                                                              | green                                                   |
| `pnpm lint`                                                                                   | green, no new warnings                                  |
| `pnpm test`                                                                                   | green, 380 tests / 21 files                             |
| `pnpm fmt`                                                                                    | green, repo-wide                                        |
| `grep -rn "ordersThisMonth\|monthKey\|ordersPerMonth\|monthKeyOf\|monthStartOf" src test e2e` | no matches                                              |
| `pnpm seed`, twice, and `deleteSeedOrders`                                                    | green; the counter lands on one seed's worth either way |
| `pnpm test:e2e`                                                                               | green, 42 tests, including the new seat case            |
| Headed billing spec (§13)                                                                     | green, see the second run below                         |

### Second run, after the review fixes, 2026-09-19 (later the same day)

Run against a fresh `pnpm d1:reset`, a restarted dev server, and `pnpm seed`, on the code
that carries the §15 review rows.

| Check                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm fmt`        | green                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test`                                      | green, 394 tests / 22 files                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Headed billing spec (§13), both tests            | green on the second run; the first run failed once on the Manage plan click after a welcome redirect. Two causes fixed the same day: the click waited unboundedly on the cache-shortening server call (`ManagePlanButton` now opens after at most 1.5 s), and the spec did not collapse the CLI Dev Console after the welcome redirect, where it re-expands and swallows the next click (`switchPlan` now does). Green twice more afterwards. |
| Ten `baton-usage-check` orders (`#1564`-`#1573`) | cancelled in bulk, then deleted one by one                                                                                                                                                                                                                                                                                                                                                                                                    |

Readings off `/admin/shop/<shop>` after the spec left the store on Basic:

| Field                      | Reading                           |
| -------------------------- | --------------------------------- |
| Cached plan                | `basic` / `baton-basic`           |
| Billing period             | Sep 19, 5:59 PM - Oct 19, 5:59 PM |
| Plan boundary              | Oct 2, 5:59 PM (trial end)        |
| Scheduled change           | (none)                            |
| Orders this billing period | 0 of 250                          |
| Usage events pending       | 0                                 |
| Usage events dead          | 0                                 |
| Shopify metered quantity   | 0                                 |
| Members                    | 10 of 3                           |

**Reversal, live.** One paid order (`#1574`, custom item, $1) was created from a draft, cancelled
forty seconds later with the refund deferred, then deleted. The log shows the three transitions
in order: the `orders/create` webhook counted it and the flush sent one event
(`flushUsageEvents: sent=1 pending=0`); the cancellation reversed it and the flush sent the
second (`sent=1 pending=0` again); the `orders/delete` webhook found `countedAt` already cleared
and reversed nothing. Refresh plan afterwards read local 0 against Shopify 0 with no divergence
warning: the `+1` and the `-1` netted out on both sides.

That closes the observation from the review: on the pre-fix code, cancelling the two orders
counted in the current cycle produced no flush line at all, and the flush's failure path
reported `remaining: 0`, so a refused reversal was invisible. The same flow on the fixed code
logs both sends.

### Dev-store readings, `sandbox-shop-01.myshopify.com`, 2026-09-19

Read off `/admin/shop/<shop>` after Refresh plan, with the store on Pro:

| Field                      | Reading                           |
| -------------------------- | --------------------------------- |
| Cached plan                | `pro` / `baton-pro`               |
| Billing period             | Sep 19, 1:51 PM - Oct 19, 1:51 PM |
| Plan boundary              | Oct 19, 1:51 PM                   |
| Scheduled change           | (none)                            |
| Orders this billing period | 67 of 1,000                       |
| Usage events pending       | 0                                 |
| Shopify metered quantity   | (none)                            |
| Members                    | 10 of 10                          |

What this proves beyond the tests: step 1 reads `currentBillingCycle.startTime` and
`cancelAtEndOfCycle` off the real Partner API; step 6's `setBillingCycle` push reaches the
Durable Object, because the billing period shown here is read from `ShopUsage`, which only the
object holds; and the object recounts the cycle from `countedAt` when a new period is pushed.

The raw contract, read straight from the Partner API:

```json
{
  "cancelAtEndOfCycle": false,
  "trialEndsAt": null,
  "currentBillingCycle": {
    "startTime": "2026-09-19T17:51:29Z",
    "endTime": "2026-10-19T17:51:29Z"
  },
  "items": [{ "handle": "baton-pro", "usage": null }],
  "pendingUpdate": null
}
```

One plan item and no meter item. **Superseded**: this reading was taken on the contract that
predated the meter, and §16's settled section explains why the item was absent and records the
replacement contract carrying it at `quantity: 0`. Reconciliation was then tested end to end;
the paragraphs below are kept as the record of the first reading only.

### Why no usage event has been emitted yet

The store holds 89 orders; the 30-day window sync pulled 6 into the object, all `PAID`, placed
Sep 1 to Sep 5. The billing cycle starts Sep 19, 17:51 UTC — the day the store subscribed — so
`Domain.orderCountsTowardCycle` excludes every one of them and nothing is counted or metered.
That is the backfill exemption working as designed: a shop that installs mid-cycle must not
burn its allowance on orders placed before it had the app. A later incremental sync
(`field=updated_at`) found nothing new, so no stream ran.

Emitting a first event therefore needs a paid order **placed after the cycle start**, which
means a new order on the dev store. Nothing in the app can conjure one.

### The usage path, exercised end to end

Six paid orders were created on the dev store through `orderCreate` (`#1565`-`#1571`), each
placed inside the cycle. Each one's `orders/create` webhook counted it, queued a `+1` event
under `orders-synced`, and the flush drained the outbox: `ShopAgent.flushUsageEvents:
shop=sandbox-shop-01.myshopify.com sent=7 pending=0`. The Dev Dashboard logs them as
**`App billing event` / `orders-synced` / `OK`** — billable, not merely received.

Getting there took three fixes, each recorded in §16: the missing `User-Agent`, the
undocumented token-response shape, and a send failure that was invisible in the logs. The first
two would have failed **every** usage event in production, silently, because the App Events API
answers `202` regardless and the only counter-evidence is a metered quantity that never moves.

A seventh order (`#1564`) was created with `financialStatus: PAID` but no transaction, so
Shopify reported `fullyPaid: false`; it was stored and correctly **not** counted. That is the
rule working, and it is also the open product question in §16.

Both questions this paragraph once left open are answered in §16's settled section: the
downgrade was immediate on the development store, and `2026-07` accepted the events with
`lastReconciledQuantity` moving to match. The billing spec still attaches the downgrade reading
to the Playwright report as `plan cache after Pro to Basic`, and its headed run is the one
pending item in the checklist above.

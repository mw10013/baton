# Limits and plans: bounding per-shop growth and tying it to a subscription

Research into where Baton's per-shop data can grow without bound, which limits to introduce,
how to enforce them without paying for a `count(*)` on every write, and how a two-plan Shopify
App Pricing catalog should map onto those limits.

Every code reference was checked against the tree on 2026-09-17. Competitor figures come from
the fetched marketing sites and App Store listings under `refs/` (no competitor source code
exists, so their enforcement is inferred from published behavior only). Cloudflare and Shopify
figures come from `refs/cloudflare-docs` and `refs/shopify-docs`.

**Status: research only. Nothing implemented.** Reviewed with annotations on 2026-09-17; the
decisions taken are recorded in §10 and the remaining open questions in §11.

**Prototype constraints that bind any implementation:**

- **No separate SQL migration.** The project is in prototyping; the databases and Durable
  Objects get reset. Any schema change (a `ShopUsage` table, dropping `raw`, a new index) goes
  inline into the existing `1_initialize schema` migration in `src/lib/ShopAgent.ts` and
  `migrations/0001_init.sql`.
- **Every number in this doc is provisional.** Plan limits, prices, retention days, and the
  soft ceilings are proposals. The constants that land in code must carry a JSDoc saying so, so
  no later reader (human or LLM) treats them as tuned figures or derives anything from them.

**Verdict:**

1. **Orders are the only table that can threaten the 10 GB ceiling, and the fix is retention,
   not a cap.** A hard cap on stored orders would stop production. A calendar-month order
   _quota_ (Route to Ship's model) plus a _retention window_ that deletes closed orders and
   their runs after N days keeps the working set proportional to shop size, not shop age. §4.
2. **Four tables have no delete path at all today:** `ShopOrder`, `WorkflowRun` (+`WorkflowRunStep`),
   `WebhookDelivery`, and D1 `Session`/`Verification`. Those are the sweeper targets. §2.
3. **Only two plans: `baton-basic` and `baton-pro`**, handles that already exist in
   `Domain.PlanHandle`. Basic ≈ Route to Ship "Production" ($39 / 3 seats / 250 orders); Pro ≈
   "Team" ($99 / 10 seats / 1,000 orders). Metered dimensions: **orders per month** and
   **members**. Everything else (workflows, steps, teams) is a flat constant high enough that a
   medium shop never sees it. §6.
4. **Never `select count(*)` to enforce a plan limit.** DO SQLite bills every row scanned, and
   `count(*)` scans the whole table (or index). Keep one counter row per metered dimension in a
   singleton table, maintained in the same transaction as the insert. One row read per check.
   The two existing workflow-definition counts (50 workflows, 20 steps) are fine as `count(*)`
   because the tables are tiny and the writes are rare. §7.
5. **Storage is a second, plan-independent guard.** Read `ctx.storage.sql.databaseSize` at sync
   start and refuse the bulk import past a soft ceiling (say 2 GB, a fifth of the hard limit),
   logging the size on every sync. Cheap, no table scan, catches the pathological shop. §7.4.
6. **Plan state stays in the Worker (D1 `ShopSession.planHandle`) and reaches the DO as an
   integer argument per call,** exactly as the existing `Domain.Entitlements` comment
   prescribes. Replace the placeholder `dailyActionLimit` with the real fields. §8.

---

## 1. What Baton stores per shop today

Everything per-shop lives in the `ShopAgent` Durable Object's SQLite, one object per shop
(`src/lib/ShopAgent.ts:402-552`, single migration `1_initialize schema`). Shared auth and
membership live in D1 (`migrations/0001_init.sql`).

| Store | Table                               | Bounded today? | By what                                                                            |
| ----- | ----------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| DO    | `ShopOrder`                         | **No**         | 30-day sync window bounds _intake_, nothing bounds _accumulation_                  |
| DO    | `OrderLineItem`                     | **No**         | cascade from `ShopOrder` only; bulk path has no per-order line-item cap            |
| DO    | `WebhookDelivery`                   | **No**         | no `delete` statement exists anywhere                                              |
| DO    | `WorkflowRun`                       | **No**         | cancel/done are status flips; no FK to `ShopOrder`, so order deletion orphans runs |
| DO    | `WorkflowRunStep`                   | **No**         | cascade from `WorkflowRun`, which is never deleted                                 |
| DO    | `Workflow`                          | Yes            | `WorkflowLimits.maxWorkflows = 50` (`src/lib/Domain.ts:396`)                       |
| DO    | `WorkflowStep`, `WorkflowDraftStep` | Yes            | `WorkflowLimits.maxSteps = 20` per workflow                                        |
| DO    | `WorkflowDraft`                     | Yes            | one per workflow                                                                   |
| DO    | `SyncState`                         | Yes            | singleton `check (id = 1)`                                                         |
| D1    | `Member`, `Team`, `TeamMember`      | **No**         | merchant-driven, no cap                                                            |
| D1    | `Session`, `Verification`           | **No**         | `Session_expiresAt_idx` exists, nothing sweeps it                                  |
| D1    | `ShopSession`, `User`, `Account`    | Yes            | one per install / per member                                                       |

The Agents SDK also writes its own tables into the same SQLite (workflow tracking rows from
`this.runWorkflow`, connection state). App code never prunes them and the migration never sees
them. Worth measuring once `databaseSize` is logged (§7.4).

## 2. The four unbounded growth paths, ranked by bytes

### 2.1 `ShopOrder` + `OrderLineItem` (the 10 GB risk)

`ShopOrder` carries a `raw text not null` column holding the full re-encoded `OrderNode` JSON
(`src/lib/OrderSync.ts:88-89`) alongside the parsed columns, so every order is stored roughly
twice. `OrderLineItem` has three JSON columns (`productTags`, `matchedWorkflowIds`,
`customAttributes`).

Intake paths all funnel through `OrderRepository.upsertOrder` (`src/lib/OrderRepository.ts:369-419`):

- Bulk sync (`runShopAgentOrdersStream`): the bulk query's only filter is
  `created_at:>=` (first sync) or `updated_at:>=` (later syncs) clamped to
  `ORDER_SYNC_WINDOW_DAYS = 30` (`src/lib/orderSyncConstants.ts:6`,
  `src/lib/OrdersBulkRepository.ts:69-80`). **No status or fulfillment filter.** First sync on
  a new install pulls every order created in the last 30 days, fulfilled or not.
- Webhooks: seven order topics (`src/routes/webhooks.orders.ts`), each a single-order
  fetch-and-upsert.
- Manual resync and local seed.

Delete paths: the `orders/delete` webhook only, plus the seed wipe. **No age-based pruning.**
After a year, a shop holds a year of orders. After three, three.

Rough sizing (assumptions stated, not measured):

| Per row                                                                                | Estimate                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ShopOrder` incl. `raw`                                                                | ~4–8 KB (customAttributes and note dominate; `raw` doubles it) |
| `OrderLineItem`                                                                        | ~0.5–1 KB                                                      |
| Order with 3 line items                                                                | ~6–11 KB                                                       |
| `WorkflowRun` + up to 20 `WorkflowRunStep` (instructions ≤2000 ch, note ≤1000 ch each) | ~2–40 KB                                                       |

At ~15 KB per order all-in, 10 GB is ~650k orders. A medium shop at 1,000 orders/month reaches
that in ~55 years, so **the hard ceiling is not the practical concern; cost and query time
are.** Storage bills at $0.20/GB-month past 5 GB across the account, and every unindexed scan
(the five `sum(...)` chips on the orders index, `src/lib/OrderRepository.ts:769-784`, scan all
open orders per page load) gets slower and pricier as the table grows. The `raw` column is the
single biggest lever: dropping it or trimming it to the fields actually re-read halves the
order footprint.

### 2.2 `WorkflowRun` + `WorkflowRunStep`

One run per (line item × workflow), plus every cancelled or replaced run kept as the un-cancel
key (`src/lib/ShopAgent.ts:509-515`). Each run snapshots up to 20 steps with `instructions` and
`note` text. Only creator is `WorkflowRunRepository.insertRun`
(`src/lib/WorkflowRunRepository.ts:847-897`). **The only `delete from WorkflowRun` in the repo is
the dev seed.** No FK to `ShopOrder`, so `orders/delete` leaves runs behind forever.

### 2.3 `WebhookDelivery`

Pure dedupe log: one row per delivery, seven topics, Shopify retries up to 8× over 4 hours.
Written by `recordWebhookDelivery` (`src/lib/OrderRepository.ts:812-825`), read only by primary
key. **No delete statement exists.** Cheapest fix in the codebase: delete rows older than
Shopify's retry horizon (a few days is plenty; 7 days is safe) in the same transaction that
records a new one, or on the sync alarm.

### 2.4 D1 `Session` and `Verification`

Better-auth writes a `Session` per magic-link sign-in and a `Verification` per link
(`src/lib/Auth.ts:129-165`, 300 s expiry). Nothing in `src/` deletes expired rows; they go only
when the `User` goes. Global rather than per-shop, so not a 10 GB concern, but it is
unbounded and the index to sweep on already exists (`Session_expiresAt_idx`,
`migrations/0001_init.sql:106`).

### 2.5 Uncapped but merchant-driven: `Member`, `Team`, `TeamMember`

`Repository.addMember` (`src/lib/Repository.ts:500-511`) and `createTeam` (`:668-691`) have no
cap. These grow only as fast as a merchant clicks, so a plan limit is about product tiering,
not storage.

## 3. What the competitors limit and how

Full detail is in the fetched listings. The decision-relevant shape:

| App                     | Price                                         | What is metered                                                                                                                                                            | Order storage strategy                                                                                                                                |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route to Ship           | Free $0 / $39 / $99 / $249 / ($499 site-only) | **Seats** (1/3/10/30/100) and **orders per calendar month** (25/250/1,000/5,000/∞), overage $0.15/$0.10/$0.05 per order; pipelines and departments unlimited on every tier | Postgres, webhook-fed, **paid orders only**, **no backfill before install** (support-gated), no documented retention, 30-day post-uninstall retention |
| Kanbanify               | $7/mo (Grow $12 "coming soon")                | Nothing on Basic; Grow unlocks multiple boards                                                                                                                             | **No order DB.** State lives in Shopify metafields; orders read live                                                                                  |
| MakerBatch              | Free / $15 / $19                              | **Line items concurrently in production** (25/200/∞)                                                                                                                       | Stores unfulfilled orders only, so the working set self-bounds                                                                                        |
| BenchCue                | $7/mo                                         | Nothing                                                                                                                                                                    | Nothing persisted; 5-minute in-memory window                                                                                                          |
| Maker's Production View | $15/mo                                        | Nothing                                                                                                                                                                    | Live fetch; persists only per-line-item produced status                                                                                               |

Three of five avoid the problem by not storing orders at all. Of the two that do, Route to
Ship is the one Baton mirrors architecturally, and its published rules are the ones worth
copying:

- **Counting rule:** unique orders synced per calendar month; a multi-line order counts once;
  refunded and cancelled orders don't count. Reset on the calendar month, not the billing
  anniversary.
- **On exceed, paid plans are never blocked.** Overage auto-bills. "We never block your
  production work; order syncing always continues." Only the Free tier can hard-stop, and they
  don't say what it does.
- **Seats hard-block on Free**, soft-block (paid add-on) on paid tiers.
- **Intake filter:** paid orders only, and only orders created after install. This is their
  real storage bound: no historical backfill unless support runs it.

MakerBatch's "items in production at once" is the other interesting model: it meters the _live_
working set rather than a monthly flow, and the count goes back down when work completes. It
maps naturally onto Baton's `WorkflowRun where status in ('pending','active')`, which is
exactly what a shop's floor is doing right now. It is also harder to explain on a pricing page
than "orders per month." See §10.

## 4. What to limit, and whether by plan or by constant

The user constraint is small vs. medium shops, two plans at most, nothing enterprise-scale, and
the second plan's non-metered limits high enough that a real medium shop never touches them.

| Dimension                            | Kind                  | Basic   | Pro     | Rationale                                                                                                                                                                                                                                                                         |
| ------------------------------------ | --------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orders synced per calendar month** | plan, metered         | 250     | 1,000   | Route to Ship Production/Team. The only limit that maps to storage and to shop size. Count on first insert of an order id, not on every upsert.                                                                                                                                   |
| **Members**                          | plan, hard            | 3       | 10      | Route to Ship seats. Checked at `addMember`; D1 count is a small indexed query (`unique (shop, email)`), and the write is rare, so `count(*)` is acceptable here.                                                                                                                 |
| **Order retention (closed orders)**  | constant              | 90 days | 90 days | Sweeper deletes orders where `closedAt` or `cancelledAt` is older than the window and no live run references them. Bounds accumulation independent of plan.                                                                                                                       |
| **Live runs (pending + active)**     | constant soft ceiling | 5,000   | 5,000   | Not a product limit, a safety valve: `reconcileAll` iterates every open paid order with concurrency 1 and `listQueue` has no `limit`. Past this, `reconcileOrder` fails with a distinct error the UI surfaces, the same way a workflow cap does. Silently skipping would hide it. |
| Workflows                            | constant              | 50      | 50      | Already enforced (`WorkflowLimits.maxWorkflows`). Medium shops have a handful.                                                                                                                                                                                                    |
| Steps per workflow                   | constant              | 20      | 20      | Already enforced.                                                                                                                                                                                                                                                                 |
| Teams                                | constant              | 25      | 25      | New. Cheap D1 count, rare write.                                                                                                                                                                                                                                                  |
| Members per team                     | constant              | none    | none    | Bounded by members × teams.                                                                                                                                                                                                                                                       |
| Line items per order (bulk path)     | constant              | 250     | 250     | Bulk path currently has no cap; single-order path already merges past 100. 250 is generous for a small or medium shop. Truncate and set a flag on the order so the index can show it, rather than fail the sync.                                                                  |
| `WebhookDelivery` age                | constant              | 7 days  | 7 days  | Piggyback: delete a small batch of old rows in the transaction that records a new delivery. §4.3.                                                                                                                                                                                 |
| D1 `Session` / `Verification`        | constant              | expired | expired | Piggyback on sign-in: delete expired rows for that user (or a bounded global batch) when a magic link is issued. §4.3.                                                                                                                                                            |
| DO storage soft ceiling              | constant              | 2 GB    | 2 GB    | `databaseSize` check at sync start; refuse the bulk import and surface a banner.                                                                                                                                                                                                  |

Two things deliberately **not** metered by plan: workflows and teams. A medium shop with 50
workflows or 25 teams is not a medium shop, so the constant does the enterprise fencing and the
plan copy stays "seats and orders," which is the pitch Route to Ship has already trained the
market on.

### 4.1 Orders per month: what happens at the limit

Route to Ship's rule is the right one for a production tool: **never stop syncing on a paid
plan.** Options, in order of preference:

1. **Soft limit with a banner.** Past the quota, keep syncing, show "You've used 1,050 of 1,000
   orders this month, upgrade to Pro" in the app. No overage billing, no code in the sync path
   beyond the counter. Simplest, and the App Pricing usage meter is not needed.
2. **Usage-based overage through App Pricing.** Shopify App Pricing does accommodate this,
   and the fit with Route to Ship's model is exact. Details in §5.1. It costs a second API
   client (App Events API), a meter per plan in the Partner Dashboard, and an idempotent event
   per counted order. Defer until a shop actually overruns, but design the `ShopUsage` counter
   so the transition is "also emit an event," not a rewrite.
3. **Hard stop.** Orders past the quota are not synced. Rejected: a missed order in a
   made-to-order shop is a missed shipment.

Decision (2026-09-17): 1 now, 2 is the likely next step because it lets a shop keep going
while paying for the flexibility. Because Baton's first sync
pulls 30 days of history, **the first month counts historical orders toward the quota** unless
the quota counter is only incremented for orders with `processedAt >= installedAt` or the
first sync is exempt. Route to Ship sidesteps this by not backfilling at all. Simplest fix:
exempt orders whose `processedAt` predates the counter's month start.

### 4.2 Retention: what "closed" means and what gets deleted

A closed order is one with `closedAt` or `cancelledAt` set, or `fulfillmentStatus = 'FULFILLED'`
(the same predicate as the `ShopOrder_open_idx` partial index, negated). Delete when it has
been closed for longer than the retention window **and** no `WorkflowRun` for it is in
`pending` or `active`. Cascade:

- `OrderLineItem` cascades from `ShopOrder` already.
- `WorkflowRun` has no FK. Add `delete from WorkflowRun where orderId = ?` to the same
  transaction, which cascades `WorkflowRunStep`. Done runs older than the window are exactly
  the rows the member "Done" tab no longer shows (`DONE_WINDOW_MS` is 24 h,
  `src/lib/Domain.ts:2442`).
- Also delete orphaned runs whose `orderId` no longer exists (the `orders/delete` webhook has
  been leaving these behind since day one).

How the sweep is scheduled is its own question, §4.3. Whatever runs it deletes in batches of
a few hundred rows keyed by the existing `ShopOrder_processedAt` index so each pass is bounded.
Deletes bill as rows written.

Is 90 days right? A merchant may want to look back at a fulfilled order's production notes for
a return. 90 days matches a typical return window and is well under the 60-day Shopify order
scope plus the sync window. Tie it to a constant, not a plan, so nobody loses history by
downgrading.

### 4.3 Scheduling cleanup: alarm versus piggyback

Nothing in `src/` or `wrangler.jsonc` schedules anything today: no `alarm()`, no cron trigger,
no Agents SDK `schedule()`. Two ways to run the sweeps in §2:

**DO alarm (or the Agents SDK `schedule` / `scheduleEvery` built on it).** Cost is small and
documented: each `setAlarm()` bills as one row written, and each alarm invocation bills as one
request at $0.15/million with 1 million/month included
(`refs/cloudflare-docs/src/content/partials/durable-objects/durable-objects-pricing.mdx:18,67`).
A daily alarm per shop is ~30 requests and ~30 writes per shop per month, which is noise
against the order writes. The real costs are indirect: an alarm wakes an evicted object (a
constructor run plus the SDK's `_ensureSchema` and schedule-table scan), it keeps a
`cf_agents_schedules` row per schedule in the same SQLite, and the SDK's own keepAlive and
teardown machinery already uses the single alarm slot, so app scheduling has to go through
`schedule()` rather than `ctx.storage.setAlarm()` directly. That is more surface than the
sweeps need.

**Piggyback on traffic the object already handles.** Every sweep target has a natural write
that can carry the cleanup in the same transaction:

| Target                                  | Carrier                                                                                | Batch                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `WebhookDelivery` older than 7 days     | `recordWebhookDelivery`                                                                | `delete ... where receivedAt < ? limit 50`, one indexed scan on a new `receivedAt` index |
| Orphaned `WorkflowRun` (no `ShopOrder`) | `deleteOrder` (fix the cause) plus a one-time pass                                     | delete by `orderId` in the same transaction                                              |
| Closed orders past retention            | end of `syncOrders` (merchant-triggered, already the heavy path) and every Nth webhook | ≤200 orders per pass, keyed by `processedAt`                                             |
| D1 `Session` / `Verification` expired   | magic-link issue and sign-in                                                           | `delete ... where expiresAt < ? limit 100` on the existing `expiresAt` index             |

A shop that goes quiet never gets cleaned, but a quiet shop is also not growing, so the bound
holds. The trade-off is latency on the carrier request: a bounded `delete ... limit N` on an
indexed column is a few milliseconds and a few rows written. `limit` on `delete` needs SQLite
compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`; if the DO runtime lacks it, use
`delete where rowid in (select rowid ... limit N)`, which is standard.

Recommendation: piggyback first, for every sweep. Revisit an alarm only if a measured shop
shows retention lagging, which the `databaseSize` log (§7.4) will make visible.

## 5. Shopify App Pricing facts that constrain the design

From `refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing.md` and the Partner API
object docs (`refs/shopify-docs/docs/api/partner/latest/objects/ActiveSubscription.md`):

- Plans are configured in the Partner Dashboard, not in code. Up to 8 public and 15 private
  plans. Baton needs two public plans, plus the `-test` handles already reserved in
  `Domain.PlanHandle`.
- The app reads the current plan through the Partner API `activeSubscription(appId, shopId)`.
  It exposes `items { handle }`, `currentBillingCycle { endTime }`, `trialEndsAt`,
  `cancelAtEndOfCycle`. **No plan name, no status field.** Baton already handles this in
  `src/lib/ShopifyPartner.ts:166-187` (handle allowlist, none-or-ambiguous → unsubscribed).
- No webhooks. Cancellations and freezes are discovered by polling. Baton caches for at most
  24 h (`PLAN_HANDLE_MAX_AGE_MS`, `src/lib/SubscriptionPlan.ts:68`), so a downgrade takes up to
  a day to tighten limits. Acceptable for soft limits.
- Rate limit 4 req/s per Partner API client. Fine for a per-shop daily revalidate.
- Dev stores in the same Partner org get every plan free (contracts at $0). Route to Ship's
  Free tier is a separate product decision, not a dev-store mechanism. Baton does not need a
  free plan for testing.
- Usage meters: up to 5 per plan, 6 tiers each, monthly billing, no caps. Available if §4.1
  option 2 is ever wanted.
- Currently `BILLING_ENABLED` is `"false"` in local, staging, and production
  (`wrangler.jsonc:21,124,191`), so every shop resolves to `baton-pro` without a Partner API
  call. Flipping it on is the last step, after the Partner Dashboard plans exist with those
  exact handles.

### 5.1 Usage-based charges under App Pricing

From `refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges.md`
and `build-billing-event.md`. Baton is on App Pricing via the Partner API, and usage is a
first-class part of it:

- A plan carries a monthly base fee plus up to 5 **usage meters**, each with a handle (for
  example `order_synced`), a pricing structure (fixed, graduated, or volume), up to 6 tiers,
  and **included units**. "Base fee $39 + 250 included orders + $0.15 per extra order" is
  configured entirely in the Partner Dashboard. That is Route to Ship's ladder verbatim.
- The app reports usage by POSTing a billing event to the **App Events API**
  (`https://api.shopify.com/app/unstable/events`) with `shop_id` (GID), `event_handle`,
  `timestamp`, a permanent `idempotency_key`, and `attributes.value`. Negative values reverse
  usage (a cancelled order). This is a separate credential from the Partner API token: an API
  key with the `write_global_api_app_events` scope.
- Shopify aggregates and bills; the app never computes a charge. Included units are applied by
  Shopify, so the app sends an event for **every** counted order, not only the overage.
- The API always returns `202`; billing validation errors (`NO_SUBSCRIPTION`,
  `SUBSCRIPTION_NOT_METERED`, `PERIOD_CLOSED`, `IDEMPOTENCY_KEY_ERROR`) show up only in the Dev
  Dashboard logs. No webhook, no synchronous failure.
- Constraints: monthly billing only, **no usage caps** (a merchant cannot set a spend ceiling),
  events must fall inside the current billing cycle, and after uninstall there is a 24-hour
  window to flush pending events before `PERIOD_CLOSED`.
- The billing cycle is the merchant's, anchored on subscription start, not the calendar month.
  If Baton's in-app quota resets on the calendar month (Route to Ship's rule) while Shopify's
  included units reset on the cycle, the two counts disagree at the edges. Simplest
  reconciliation when usage billing lands: reset `ShopUsage.monthKey` on
  `currentBillingCycle.endTime` from `activeSubscription` rather than on the calendar month.

## 6. The two plans

|                         | `baton-basic`                 | `baton-pro`              |
| ----------------------- | ----------------------------- | ------------------------ |
| Positioning             | small shop, one or two makers | medium shop with a floor |
| Price (proposal)        | $29–39/mo                     | $79–99/mo                |
| Trial                   | 14 days (likely)              | none (likely)            |
| Orders / calendar month | 250                           | 1,000                    |
| Members                 | 3                             | 10                       |
| Workflows, steps, teams | same constants on both        | same constants on both   |
| On order overrun        | banner, keep syncing          | banner, keep syncing     |

Accepted on 2026-09-17 as the working proposal, subject to revision. No free tier. The trial
probably lives on Basic only. Pricing is a placeholder against the Route to Ship ladder; the
entitlement table is the decision that touches code, and its JSDoc must say the values are
provisional (see the prototype constraints at the top). Basic's numbers are Route to Ship "Production" exactly, Pro's are
"Team" exactly, so a merchant comparing listings sees the same shape at a slightly lower price
with no per-seat add-on math.

`Domain.Entitlements` becomes:

```ts
export interface Entitlements {
  readonly ordersPerMonth: number;
  readonly maxMembers: number;
}
/**
 * Provisional. These are working proposals from the limits research, not
 * tuned figures: nothing was measured to arrive at them and nothing should
 * be derived from them. Change freely; the Partner Dashboard plan copy has
 * to move with them.
 */
const ENTITLEMENTS = {
  basic: { ordersPerMonth: 250, maxMembers: 3 },
  pro: { ordersPerMonth: 1_000, maxMembers: 10 },
} as const satisfies Record<Plan, Entitlements>;
```

and the plan-independent constants sit next to `WorkflowLimits`, with the same JSDoc:

```ts
/** Provisional, see {@link ENTITLEMENTS}. */
export const ShopLimits = {
  maxTeams: 25,
  maxLiveRuns: 5_000,
  maxLineItemsPerOrder: 250,
  orderRetentionDays: 90,
  webhookDeliveryRetentionDays: 7,
  storageSoftLimitBytes: 2_000_000_000,
} as const;
```

The existing `dailyActionLimit` placeholder and its two display sites (`src/routes/app.index.tsx:53`,
`src/routes/admin.shop.$shop.tsx:251`) go away.

## 7. Enforcing without paying for `count(*)`

### 7.1 What a row read costs

DO SQLite bills like D1 (`refs/cloudflare-docs/src/content/partials/workers/d1-pricing.mdx`):
a query is charged for every row it _scans_, regardless of row size. `select count(*) from
ShopOrder` scans every row (or every index entry, which is cheaper per byte but the same row
count). Paid tier: 25 billion reads/month included, then $0.001/million. Writes: 50 million
included, then $1.00/million, and **deletes and index maintenance each count as a write.**

So a `count(*)` on a 50k-row order table costs 50k reads. At 1,000 order writes a month that
is 50M reads/month per shop from the check alone, which is still inside the free allotment for
a handful of shops but scales as shops × orders², and it adds latency to every webhook. The
cost concern is real but the latency and the quadratic shape are the better reasons to avoid it.

`SqlStorageCursor.rowsRead` / `rowsWritten` (`refs/cloudflare-docs/.../sqlite-storage-api.mdx:229-236`)
give the billed count per query, so the numbers can be logged in dev before committing to a
design.

### 7.2 Counter row per metered dimension

Add a singleton table alongside `SyncState`:

```sql
create table if not exists ShopUsage (
  id integer primary key check (id = 1),
  monthKey text not null,            -- '2026-09'
  ordersThisMonth integer not null default 0,
  liveRuns integer not null default 0
);
insert or ignore into ShopUsage (id, monthKey) values (1, strftime('%Y-%m', 'now'));
```

- `upsertOrder` already returns `id` only on insert-or-update. Split it so a **fresh insert**
  (the `on conflict` branch not taken) increments `ordersThisMonth` in the same transaction:
  one row read, one row written. Detect "fresh" with `insert ... on conflict do update ...
returning (changes-style flag)` or a prior `select 1 from ShopOrder where id = ?` (one
  indexed read).
- Month rollover: at the top of the transaction, `update ShopUsage set monthKey = ?,
ordersThisMonth = 0 where monthKey <> ?`. One read, at most one write per month.
- The quota check reads `ShopUsage` (one row) and compares with the `ordersPerMonth` integer
  passed in from the Worker. Over quota on a paid plan: still insert, set a flag the UI reads.
- `liveRuns` increments in `insertRun` and decrements in every status transition to `done` or
  `cancelled`. `recomputeStatus` already runs a `count(*) = sum(...)` over a run's steps
  (`src/lib/WorkflowRunRepository.ts:795`); that is per-run and bounded by 20, fine.

Drift: a counter can drift from truth after a bug or a manual fix. Add an admin-only
"recount" action that runs the real `count(*)` once and resets the row. The cost is paid
deliberately, not per write.

### 7.3 Where `count(*)` is still fine

- `Workflow` (≤50 rows) and `WorkflowDraftStep` (≤20 per workflow): already `count(*)`, tables
  are tiny, writes are merchant clicks. Leave them.
- D1 `Member` and `Team` per shop: indexed on `shop`, tens of rows, rare writes. A `count(*)`
  inside the insert transaction is correct and cheap. D1 bills the same way but the row counts
  are trivial.
- The five `sum(...)` chips on the orders index (`src/lib/OrderRepository.ts:769-784`) scan
  every open order on every page load. Not a limit query, but it is the most-run scan in the
  app and the retention sweeper is what keeps it small. If it shows up in `rowsRead` logging,
  fold the five sums into `ShopUsage`-style counters maintained by reconcile.

### 7.4 Storage guard

`ctx.storage.sql.databaseSize` returns bytes with no scan
(`refs/cloudflare-docs/.../sqlite-storage-api.mdx:246-268`). At `syncOrders` start:

- Log `ShopAgent.syncOrders: shop=… databaseSize=…` with the value annotated, every run. This
  is the observability the app currently lacks (no `PRAGMA`, no size metric anywhere in `src/`).
- If over `storageSoftLimitBytes`, fail the sync with a distinct error the UI turns into a
  banner and the admin page surfaces. Webhooks continue (they are single orders), so the floor
  keeps running; only the bulk backfill is refused.

Past the hard 10 GB, writes fail with `SQLITE_FULL` and reads still work, so the soft guard is
what makes the failure mode graceful.

## 8. Where each check lives

The `Domain.Entitlements` comment already prescribes the pattern and nothing implements it
yet: the Worker resolves the plan from D1 and passes integers into DO methods as required
arguments. Concretely:

| Check                                   | Caller resolves                                                                                                                     | DO method gains                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| orders per month                        | `webhooks.orders.ts` and the `syncOrders` callable resolve `entitlements.ordersPerMonth` via `SubscriptionPlan.resolveEntitlements` | `syncOrder(id, { ordersPerMonth })`, `syncOrders({ ordersPerMonth })` |
| members                                 | `app.members` server fn, in the Worker, D1 only                                                                                     | none (D1 check)                                                       |
| teams                                   | `app.teams.index` server fn                                                                                                         | none                                                                  |
| live runs                               | reconcile inside the DO, constant                                                                                                   | none                                                                  |
| retention, webhook sweep, storage guard | DO alarm and sync start, constants                                                                                                  | none                                                                  |

Webhooks are the awkward one: the webhook route currently has no plan resolution. Resolving on
every webhook adds a D1 read per delivery (cached row, cheap) and, once a day, a Partner API
call. Acceptable. The alternative, caching the plan in the DO, is what the Domain comment argues
against.

A downgrade (Pro → Basic) with 8 members: don't delete anyone. Block _adding_ until under the
cap, the same as Route to Ship's Free seat rule. Same for orders: the quota is a flow, so the
next calendar month simply starts at the lower number.

## 9. Implementation order

1. Drop `ShopOrder.raw` (§10.5). One column, one call site, inline schema edit.
2. Piggyback sweeps with no plan dependency: `WebhookDelivery` age, orphaned `WorkflowRun`, D1
   `Session`/`Verification` (§4.3). Zero product risk.
3. `databaseSize` logging on every sync, plus `rowsRead` logging on the orders-index chips and
   the bulk fold, to replace the estimates in §2.1 with measurements.
4. `ShopUsage` counter table and the bulk-path line-item cap.
5. Order retention sweep (the one with product consequences; needs the "closed" predicate
   agreed).
6. Replace `dailyActionLimit` with `ordersPerMonth` / `maxMembers`; add `ShopLimits`; wire
   member and team caps in D1; wire the order quota banner.
7. Partner Dashboard: create `baton-basic` / `baton-pro` and the `-test` twins; flip
   `BILLING_ENABLED` per environment.
8. Later: usage meter + App Events API for overage (§5.1).

## 10. Decisions taken (annotation review, 2026-09-17)

1. **Meter monthly orders**, not live work.
2. **Which orders count:** accepted as proposed. An order counts on its first insert into
   `ShopOrder`, only if paid, only if `processedAt` falls in the current month, so the 30-day
   backfill on install does not eat the first month's quota. Cancelled orders are not
   decremented for now.
3. **Retention is a storage constant**, not a plan differentiator. 90 days stands until
   measured.
4. **Soft limit with a banner now.** Usage-based overage through App Pricing is the expected
   next step (§5.1), because it lets a shop keep going while paying for it.
5. **Drop `ShopOrder.raw`.** Analysis: nothing reads it. There is no `json_extract` anywhere in
   `src/`; the column is excluded from every list read (`src/lib/OrderRepository.ts:263`), and
   its only stated purpose (`src/lib/Domain.ts:1145`) is promoting a new order-level field to a
   column without a resync. That convenience is worth nothing in prototyping, where the objects
   get reset anyway, and worth little after: a resync is bounded by the 30-day window and is a
   button press. `raw` holds the order node's own fields (never line items), so it is a
   near-duplicate of the parsed columns, roughly doubling `ShopOrder` bytes. Remove the column
   from the schema, `toOrderRaw` in `src/lib/OrderSync.ts`, the `raw` field on the repository's
   input type, and the two write sites in `ShopAgent.ts` (`:1424`, `:3743`). If a change-detection
   hash is ever wanted, `updatedAt` already does that job in the `on conflict` guard.
6. **Prices are placeholders**, carried in code only behind a provisional JSDoc.
7. **Schema changes go inline** into the existing migration. No new migration files.
8. **Sweeps piggyback** on existing traffic rather than alarms, pending measurement (§4.3).
9. **Line items per order truncate at 250 with a flag** rather than failing the sync.
10. **The live-run ceiling errors visibly**; it does not silently skip auto-start.

## 11. Open questions

1. **First sync imports only the open working set. Decided 2026-09-17.** Route to Ship does
   sync; it just never imports orders that predate install (webhooks from install onward, an
   incremental Admin GraphQL sync as safety net, paid orders only; a historical backfill is an
   email to support, `refs/route-to-ship/support.md`,
   `refs/route-to-ship/integrations/shopify.md:19`). That is a simplicity choice on their side,
   not a feature. From first principles a maker needs the orders still to be made, so the
   first-sync bulk query adds `fulfillment_status:unfulfilled` (and not cancelled, paid) to the
   existing 30-day window. Webhooks carry everything after install unchanged; later syncs keep
   the `updated_at` window so an order that fulfills after import is updated, not dropped. A
   fulfilled order that never receives a post-install webhook simply never appears, which is
   correct for a production tool. Baton already has the bulk machinery, so this is a better
   day-one experience than Route to Ship's at no cost. Backfill stays exempt from the monthly
   quota (§10.2) and retention (§4.2) bounds the steady state.
2. **Calendar month or billing cycle for the quota reset?** Calendar month is what Route to
   Ship publishes and what the banner copy assumes; the billing cycle is what App Pricing's
   included units use. Matters only once usage billing lands (§5.1).
3. **`delete ... limit N` support in the DO SQLite build** needs a one-line check before the
   piggyback sweeps are written.

# Limits and plans: implementation plan

Companion to `docs/limits-and-plans-research.md`, which holds the reasoning and the decisions.
This document is the hand-off: an implementer should be able to work from it without re-reading
the research, but every "why" lives there.

**Status: reviewed and accepted 2026-09-17, ready to implement.** Written against commit
`66feb4f`. Every recommendation in §15 was accepted; the plan text already assumes them.

## 0. Rules for the implementer

1. **No migration files.** The databases and Durable Objects are reset from scratch. Every
   schema change goes inline into the existing DDL: the `1_initialize schema` migration in
   `src/lib/ShopAgent.ts` (around line 402) and `migrations/0001_init.sql`. Do not add a
   second `SqliteMigrator` entry, do not add `migrations/0002_*.sql`.
2. **Every limit constant carries a provisional JSDoc.** The numbers are proposals. The JSDoc
   must say so explicitly so a later reader does not treat them as tuned, and must not
   reference files under `docs/` (project rule). Template in §2.1.
3. **Effect idioms throughout** (`Effect.fn`, `Effect.gen`, tagged errors via
   `Schema.TaggedError`, `sql` template literals, `Effect.annotateLogs` for structured fields).
   Copy the surrounding style of each file.
4. **Lowercase SQL keywords, positional parameters** (the `sql` tag already does this).
5. **Log format** from CLAUDE.md: `<operation>: shop=<shop> key=<value>: <detail>`, and every
   value that appears in the message is also in `annotateLogs`.
6. **Run after each step:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm fmt`
   repo-wide keeping every file it touches. `pnpm graphql-codegen` after step 2 (the bulk query
   string changes).
7. **Do not commit.** Leave the working tree for review.
8. **Record deviations** in §16 as you go, not at the end.
9. Steps are ordered so each one leaves the app working. Do them in order; each has its own
   verification.

## 1. Scope

In scope, in order:

| Step | Change                                                     | Files                                                                                         |
| ---- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | Drop `ShopOrder.raw`                                       | `ShopAgent.ts`, `OrderRepository.ts`, `OrderSync.ts`, `ShopAgentOrdersStream.ts`, `Domain.ts` |
| 2    | First sync imports only the open working set               | `OrdersBulkRepository.ts`, test                                                               |
| 3    | Constants: `ShopLimits`, real `Entitlements`               | `Domain.ts`, `app.index.tsx`, `admin.shop.$shop.tsx`                                          |
| 4    | `WebhookDelivery` sweep                                    | `ShopAgent.ts` (DDL), `OrderRepository.ts`                                                    |
| 5    | D1 `Session` / `Verification` sweep                        | `Repository.ts`, `Auth.ts`                                                                    |
| 6    | `ShopUsage` counter + `getUsage()`                         | `ShopAgent.ts`, `OrderRepository.ts`, `Domain.ts`                                             |
| 7    | Line-item cap on the bulk path + `lineItemsTruncated` flag | `ShopAgentOrdersStream.ts`, `OrderRepository.ts`, `Domain.ts`, orders UI                      |
| 8    | Member and team caps (D1)                                  | `Repository.ts`, `app.members.tsx`, `app.teams.index.tsx`                                     |
| 9    | Live-run ceiling                                           | `WorkflowRunRepository.ts`, `Domain.ts`                                                       |
| 10   | Order retention sweep                                      | `ShopAgent.ts` (DDL + call sites), `OrderRepository.ts`, `WorkflowRunRepository.ts`           |
| 11   | Storage guard + size logging                               | `ShopAgent.ts`                                                                                |
| 12   | Quota and usage surfaces in the UI                         | `app.index.tsx`, `app.orders.index.tsx`, `admin.shop.$shop.tsx`                               |

Out of scope (deliberately): usage-based overage billing through the App Events API, any alarm
or cron. See the research doc §5.1 and §4.3. Creating the plans in the Partner Dashboard and
flipping `BILLING_ENABLED` is the project owner's, not the implementer's; the spec for it is in
`README.md` under "Billing" and already written. If step 3 changes an entitlement number, update
the README table in the same change.

## 2. Constants and types (step 3, but read first)

All in `src/lib/Domain.ts`.

### 2.1 Replace the placeholder entitlements

Current (`Domain.ts:68-97`): `Entitlements { dailyActionLimit }`, `ENTITLEMENTS = { basic: 2000,
pro: 10_000 }`. Replace with:

```ts
export interface Entitlements {
  /** Orders counted toward the calendar-month quota. A soft limit: the UI warns, nothing blocks. */
  readonly ordersPerMonth: number;
  /** Hard cap on `Member` rows per shop, enforced at add time. */
  readonly maxMembers: number;
}

/**
 * Provisional. Working proposals from the limits research, not tuned
 * figures: nothing was measured to arrive at them and nothing should be
 * derived from them. Change freely, and move the Partner Dashboard plan copy
 * with them.
 *
 * `ordersPerMonth` is compared in the Worker against `ShopUsage` read from the
 * Durable Object; the object never sees the number. `maxMembers` is compared
 * in the Worker against a D1 count. Neither reaches `ShopAgent`.
 */
const ENTITLEMENTS = {
  basic: { ordersPerMonth: 250, maxMembers: 3 },
  pro: { ordersPerMonth: 1_000, maxMembers: 10 },
} as const satisfies Record<Plan, Entitlements>;
```

Keep `entitlementsOfPlan`, `MAX_ENTITLEMENTS`, `adminShopEntitlements` and their existing
JSDoc. Rewrite the long JSDoc above `ENTITLEMENTS` (`Domain.ts:72-93`): its "every limit
reaches ShopAgent as a required RPC argument" claim is no longer the design. The new design
is: the object tracks usage, the Worker compares. Say that.

Also drop `"baton-basic-test"` and `"baton-pro-test"` from `Domain.PlanHandle` (`Domain.ts:42-48`)
and simplify `planOfHandle` accordingly; same-org dev stores get public plans at $0, so the test
handles serve nothing. `test/integration/subscription-plan.test.ts` may reference them.

Update the two display sites that read `dailyActionLimit`: `src/routes/app.index.tsx:53` and
`src/routes/admin.shop.$shop.tsx:251`. Step 12 replaces them with real usage; for step 3 just
make them show `ordersPerMonth` and `maxMembers` so typecheck passes.

### 2.2 Add `ShopLimits` next to `WorkflowLimits` (`Domain.ts:396`)

```ts
/** Provisional, see the note on `ENTITLEMENTS`. Plan-independent ceilings. */
export const ShopLimits = {
  /** `Team` rows per shop. */
  maxTeams: 25,
  /** `WorkflowRun` rows in `pending` or `active` per shop; a safety valve, not a product limit. */
  maxLiveRuns: 5_000,
  /** Line items kept per order on the bulk path; the rest are dropped and the order flagged. */
  maxLineItemsPerOrder: 250,
  /** A closed order untouched for this long is deleted with its runs. */
  orderRetentionDays: 90,
  /** `WebhookDelivery` rows older than this are deleted; Shopify retries for at most 4 hours. */
  webhookDeliveryRetentionDays: 7,
  /** `syncOrders` refuses to start a bulk import when the object's SQLite is past this. */
  storageSoftLimitBytes: 2_000_000_000,
  /** Rows deleted per sweep pass, so no carrier request pays for more than this. */
  sweepBatch: 200,
  /** Minimum gap between retention passes triggered from the webhook path. */
  sweepIntervalMs: 6 * 60 * 60 * 1000,
} as const;
```

### 2.3 New domain shapes

```ts
export const ShopUsage = Schema.Struct({
  /** `YYYY-MM` in UTC. */
  monthKey: Schema.String,
  ordersThisMonth: Schema.Number,
  /** Set when reconcile declined to auto-start a run because of `ShopLimits.maxLiveRuns`; null once under the ceiling again. */
  liveRunsLimitedAt: Schema.NullOr(Schema.Number),
  /** `ctx.storage.sql.databaseSize` at read time. */
  databaseSize: Schema.Number,
  lastSweepAt: Schema.NullOr(Schema.Number),
});
export type ShopUsage = typeof ShopUsage.Type;

export const monthKeyOf = (now: number) =>
  new Date(now).toISOString().slice(0, 7);
export const monthStartOf = (now: number) =>
  Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
```

Add `lineItemsTruncated: Schema.Boolean` to `Domain.ShopOrder` (step 7) and to `OrderRow` if
the index shows it.

## 3. Step 1: drop `ShopOrder.raw`

Nothing reads the column. Verified: no `json_extract` in `src/`, and `orderColumns`
(`OrderRepository.ts:263`) already excludes it.

- `ShopAgent.ts` DDL (~line 419): remove `raw text not null,`.
- `OrderRepository.ts`: remove `raw` from `OrderUpsert` (line 24), from the insert column list
  and values, and from the `do update set` list (lines ~381-412). Delete the "Order-level JSON
  only" JSDoc.
- `OrderSync.ts`: delete `toOrderRaw` (line 88) and `encodeOrderNode` if `toOrderRaw` was its
  only caller (check with grep; the JSDoc at line 57-66 explains it exists for `raw`).
- Call sites passing `raw:`: `ShopAgentOrdersStream.ts` (~line 183), `ShopAgent.ts:1424`
  (`fetchAndUpsertOrder`), `ShopAgent.ts:3743` (`seedOrders`, `raw: "{}"`).
- `Domain.ts:1145-1150`: delete the paragraph about the `raw` column in the `ShopOrder` JSDoc.
- Tests: `test/integration/order-repository.test.ts` and `shop-agent-orders-stream.test.ts`
  build `OrderUpsert` values; remove `raw` there.

Verify: typecheck, tests. Grep `raw` under `src/` to confirm only unrelated hits remain
(`rawUrl`, comments about "raw SqlError").

## 4. Step 2: first sync imports only the open working set

`bulkOrdersQueryText` (`src/lib/OrdersBulkRepository.ts:69-80`) builds the order search string
from `field` and `windowStart`. Change: when `field === "created_at"` (the first sync; see
`orderSyncWindow`, `ShopAgent.ts:975-986`), append the open-work filter; when
`field === "updated_at"` leave it unfiltered so an order that fulfilled after import is
updated, not dropped.

```ts
const OPEN_WORK_FILTER = "status:open fulfillment_status:unshipped";
// created_at:>='...' status:open fulfillment_status:unshipped
```

Before writing it, confirm the two terms against the order search syntax in
`refs/shopify-docs` (grep `fulfillment_status:unshipped`; Shopify defines `unshipped` as
unfulfilled or partially fulfilled, and `status:open` as neither closed nor cancelled). If the
docs say otherwise, use whatever expresses "not cancelled, not closed, not fully fulfilled" and
record the deviation. No `financial_status` term: unpaid orders should still appear, and
`Domain.canStartRuns` already keeps runs from starting on them.

Put the reasoning in the JSDoc on `bulkOrdersQueryText`: a maker's day-one working set is the
orders still to be made; history that is already shipped has no production value and only
occupies storage; later syncs are unfiltered on purpose.

Verify: `pnpm graphql-codegen` (the query text is in a `#graphql` literal, though the
placeholder substitution happens at runtime; codegen should still pass), existing
`orders-sync-workflow.test.ts`, and add a unit assertion that `bulkOrdersQueryText({ field:
"created_at", ... })` contains the filter and `{ field: "updated_at", ... }` does not.

## 5. Step 4: `WebhookDelivery` sweep (piggyback)

DDL (`ShopAgent.ts:446-452`): add
`create index if not exists WebhookDelivery_receivedAt_idx on WebhookDelivery (receivedAt);`.

`OrderRepository.recordWebhookDelivery` (`OrderRepository.ts:812-825`): after the
`insert or ignore`, in the same effect (no transaction needed; two statements is fine):

```sql
delete from WebhookDelivery
where webhookId in (
  select webhookId from WebhookDelivery
  where receivedAt < ?
  order by receivedAt
  limit ?
)
```

with `? = delivery.receivedAt - ShopLimits.webhookDeliveryRetentionDays * 86_400_000` and
`ShopLimits.sweepBatch`. The subselect form is used because `delete ... limit` needs a compile
flag SQLite may lack in the DO runtime. Log at debug level with the deleted count only when it
is nonzero.

Verify: extend `order-repository.test.ts`: insert a delivery with an old `receivedAt`, record a
new one, assert the old row is gone and the new one remains.

## 6. Step 5: D1 `Session` / `Verification` sweep (piggyback)

Both tables have `expiresAt text` ISO strings (`migrations/0001_init.sql:91-138`).
`Session_expiresAt_idx` exists; add `Verification_expiresAt_idx on Verification (expiresAt)`
inline in `0001_init.sql`.

Add to `Repository` (`src/lib/Repository.ts`):

```ts
const sweepExpiredAuth = Effect.fn("Repository.sweepExpiredAuth")(function* () {
  const now = new Date(yield* Clock.currentTimeMillis).toISOString();
  yield* sqlPrimary`delete from Session where id in (select id from Session where expiresAt < ${now} limit ${ShopLimits.sweepBatch})`;
  yield* sqlPrimary`delete from Verification where id in (select id from Verification where expiresAt < ${now} limit ${ShopLimits.sweepBatch})`;
});
```

Call it from the magic-link `sendMagicLink` callback in `src/lib/Auth.ts` (~line 152) before the
send, on both the demo and real branches. Failures must not block the sign-in: wrap in
`Effect.catchCause` that logs a warning. If `Repository` is not in the layer available inside
`sendMagicLink`, call it from the login server function instead and record the deviation.

Verify: `test/integration/auth.test.ts` or `repository.test.ts`: seed an expired `Verification`
and `Session`, trigger a magic link, assert both are deleted.

## 7. Step 6: `ShopUsage` counter and `getUsage()`

### 7.1 DDL

Add alongside `SyncState` (`ShopAgent.ts:453-461`):

```sql
create table if not exists ShopUsage (
  id integer primary key check (id = 1),
  monthKey text not null,
  ordersThisMonth integer not null default 0,
  liveRunsLimitedAt integer,
  lastSweepAt integer
);
insert or ignore into ShopUsage (id, monthKey) values (1, '');
```

`monthKey` starts empty so the first write rolls it over.

### 7.2 Counting inside `upsertOrder`

In `OrderRepository.upsertOrder` (`OrderRepository.ts:369-419`), inside the existing
transaction, before the insert:

```ts
const existing =
  yield * sql`select 1 from ShopOrder where id = ${order.id} limit 1`;
const fresh = existing.length === 0;
```

One primary-key read. After the insert succeeds (`written.length > 0`), if
`fresh && order.fullyPaid && order.cancelledAt === null && order.processedAt >= monthStartOf(order.syncedAt)`:

```sql
update ShopUsage set monthKey = ?, ordersThisMonth = 0 where monthKey <> ?;   -- rollover, both ? = monthKeyOf(order.syncedAt)
update ShopUsage set ordersThisMonth = ordersThisMonth + 1 where id = 1;
```

The rollover runs only on the counting path, so a quiet shop rolls over on its first counted
order of the month, which is the only time it matters. `processedAt >= monthStart` is what
exempts the 30-day backfill from the first month's quota (research §10.2). Cancelled orders
are not decremented.

Add the `fresh` flag to the `upsertOrder` return (`{ written, fresh }`), and count
`ordersInserted` in `OrdersStreamCounts` (`ShopAgentOrdersStream.ts`) for the log line in
`onOrdersStream`.

### 7.3 `getUsage()` callable

On `ShopAgent`, a `@callable()` with `role: "merchant"` returning `Domain.ShopUsage`:

- read the `ShopUsage` row;
- `databaseSize: this.ctx.storage.sql.databaseSize`;
- roll `monthKey` forward in the returned value (not in storage) when it lags the current
  month, reporting `ordersThisMonth: 0`, so the UI never shows last month's count.

Add a repository method `getUsage()` for the row and reuse it in step 10 and 11. Expose it on
`ShopAgentClient` too (`src/lib/ShopAgentClient.ts`, same pattern as the existing methods) so
`/app` loaders can read it server-side.

Verify: `order-repository.test.ts`: upsert three fresh paid orders in-month, one backfilled
(`processedAt` last month), one unpaid, one re-upsert of an existing id; assert
`ordersThisMonth = 3`. Roll the clock to next month, upsert one more, assert `1`.

## 8. Step 7: line-item cap on the bulk path

`ShopAgentOrdersStream.ts` buffers line items per order in `OrderBuffer` via `addLine`. Cap the
buffer at `ShopLimits.maxLineItemsPerOrder`: past it, drop the line and set
`truncated = true` on the buffer. When the order is emitted, pass
`lineItemsTruncated: truncated` into `toShopOrder` (`OrderSync.ts:70`), which needs a new
parameter defaulting to `false`.

DDL: add `lineItemsTruncated integer not null default 0` to `ShopOrder`. Add it to
`Domain.ShopOrder`, `orderColumns`, the insert and `do update set` lists, and the row decoder.
On the single-order path, set `lineItemsTruncated = !lineItemsComplete` so the two paths agree
on what the flag means: the stored set is not the whole order.

UI: on the order detail page (`src/routes/app.orders.$orderId.tsx`) show an `s-banner` (tone
`warning`) when `lineItemsTruncated`: "This order has more than 250 line items. Only the first
250 are shown." On the index, no change unless `OrderRow` already carries a badge slot.

Log once per truncated order at warning level:
`ShopAgent.onOrdersStream: shop=… orderId=… lineItems truncated at 250`.

Verify: `shop-agent-orders-stream.test.ts`: feed an NDJSON fixture with 251 line items, assert
250 stored and the flag set.

## 9. Step 8: member and team caps (D1, Worker-side)

Both are cheap indexed `count(*)` queries on tables with tens of rows; the research accepts
`count(*)` here.

`Repository.ts`:

```ts
const countMembers = Effect.fn("Repository.countMembers")(function* (
  shop: Domain.Shop,
) {
  /* select count(*) from Member where shop = ? */
});
const countTeams = Effect.fn("Repository.countTeams")(function* (
  shop: Domain.Shop,
) {
  /* select count(*) from Team where shop = ? */
});
```

Add tagged errors `MemberLimitError { shop, limit }` and `TeamLimitError { shop, limit }` in
`Repository.ts`, following `TeamNameTakenError`.

`addMember`: take a `limit: number` parameter. Inside a `sqlPrimary.withTransaction` (check
that the D1 client in this repo supports it; `setMemberTeams` uses `db.batch()`, so if there is
no transaction helper, do count-then-insert as a batch and accept the small race, recording the
deviation): if `count >= limit` and the email is not already a member (the insert is
idempotent, so re-adding must never fail on the cap), fail with `MemberLimitError`.

`createTeam`: same with `ShopLimits.maxTeams` and `TeamLimitError`; no parameter needed.

Server functions:

- `src/routes/app.members.tsx` `addMemberFn` (~line 74): resolve `resolveEntitlements(shop)`
  (already imported in `app.index.tsx`; same middleware), pass `maxMembers`, and
  `Effect.catchTag("MemberLimitError", failWith(MEMBER_LIMIT))` with
  `MEMBER_LIMIT = "Your plan allows N members. Upgrade to add more."` built from the limit. The
  page already renders a bare `Error` message as a banner (see `failWith` in `src/lib/teams.ts`).
- `src/routes/app.teams.index.tsx` `createTeamFn` (line 46): catch `TeamLimitError` the same
  way with `TEAM_LIMIT`.

Do not delete anyone on downgrade; the cap only blocks adding.

Verify: `repository.test.ts` for both counts and both errors; `member-area.test.ts` or a new
route test that the error message reaches the response.

## 10. Step 9: live-run ceiling

`WorkflowRunRepository.insertRun` (`WorkflowRunRepository.ts:847-897`) is the single creator.
Before the insert, count live runs using the existing `WorkflowRun_status_idx`:

```sql
select count(*) from WorkflowRun where status in ('pending', 'active')
```

This scans at most `maxLiveRuns` index entries per run insert, which is bounded by the ceiling
itself; the research accepts it and explicitly prefers it over a second maintained counter.

Two callers, two behaviors:

- **Auto-start from `reconcileOrder`** (`:1038`): when `count >= ShopLimits.maxLiveRuns`, do
  not insert, and `update ShopUsage set liveRunsLimitedAt = coalesce(liveRunsLimitedAt, ?)`
  with `now`. Log at error level once per reconcile. This is not a silent skip: step 12 renders
  a persistent banner from `liveRunsLimitedAt`. Failing the transaction instead would fail the
  webhook, and Shopify would retry it for four hours, so the order write must succeed.
- **Manual `setRun`** (`:1186-1236`): fail with a new `WorkflowRunLimitError { limit }` (tagged,
  next to the existing errors in the file) so the merchant sees an error on the order page.
  Map it to a message in the order page's server fn the same way other repository errors are
  mapped there.

Clear `liveRunsLimitedAt` (set null) whenever a run leaves `pending`/`active`, in
`recomputeStatus` and `cancelRun`/`cancelPending`. Cheap: one row write on transitions that
already write.

Verify: `workflow-run-repository.test.ts`: set the limit low through a test seam (make
`insertRun` read the limit from a parameter defaulting to `ShopLimits.maxLiveRuns`, or expose
the constant through the repository layer), fill to the ceiling, assert auto-start records
`liveRunsLimitedAt` and `setRun` fails.

## 11. Step 10: order retention sweep (piggyback)

### 11.1 Predicate

An order is **closed** when `cancelledAt is not null or closedAt is not null or
fulfillmentStatus = 'FULFILLED'`, the negation of `ShopOrder_open_idx`. It is **expired** when
also `updatedAt < now - orderRetentionDays` (untouched since it closed; `updatedAt` is
Shopify's, refreshed on every upsert). It is **deletable** when additionally no `WorkflowRun`
for it is `pending` or `active`.

DDL: add a partial index the sweep can walk:

```sql
create index if not exists ShopOrder_closed_idx on ShopOrder (updatedAt)
  where fulfillmentStatus = 'FULFILLED' or cancelledAt is not null or closedAt is not null;
```

### 11.2 `OrderRepository.sweepExpiredOrders({ now })`

One transaction:

```sql
-- 1. pick a batch
select id from ShopOrder
where (fulfillmentStatus = 'FULFILLED' or cancelledAt is not null or closedAt is not null)
  and updatedAt < ?
  and not exists (select 1 from WorkflowRun r where r.orderId = ShopOrder.id and r.status in ('pending','active'))
order by updatedAt
limit ?;
-- 2. for the batch: delete from WorkflowRun where orderId in (...)   -- cascades WorkflowRunStep
-- 3. delete from ShopOrder where id in (...)                          -- cascades OrderLineItem
-- 4. orphans: delete from WorkflowRun where orderId not in (select id from ShopOrder) and updatedAt < ?
--    (runs flagged order_deleted by markOrderDeleted, kept for the member to see, then aged out)
-- 5. update ShopUsage set lastSweepAt = ?
```

Bind the ids with `sql.in` or the repo's equivalent; keep the batch at `ShopLimits.sweepBatch`
so bound parameters stay under the DO's 100-parameter limit (batch the `in` lists at 90 if
needed). Return `{ orders, runs }` deleted counts and log them at info level when nonzero:
`ShopAgent.sweep: shop=… orders=… runs=…`.

Step 4 in the list above deliberately uses `updatedAt` on `WorkflowRun`, not the order's,
since the order is gone.

### 11.3 Carriers

- **End of `onOrdersStream`** (`ShopAgent.ts:~1585`), after the fold and before `publish`:
  always run one pass. This is merchant-triggered and already the heavy path.
- **`syncOrder`** (webhook, `ShopAgent.ts:1713`), after `fetchAndUpsert`: run one pass only if
  `ShopUsage.lastSweepAt` is null or older than `ShopLimits.sweepIntervalMs`. Read it with the
  `getUsage` repository method; one row read per webhook.
- Nowhere else. No alarm.

`publish` after a pass that deleted anything, since index pages may be showing deleted rows;
`publish("all")` is already what `onOrdersStream` does.

Verify: `order-repository.test.ts`: seed a fulfilled order 100 days old with a done run, a
fulfilled order 100 days old with an active run, an open order 100 days old, a fulfilled order
10 days old, and an orphaned run; run the sweep; assert exactly the first order, its run, and
the orphan are gone. Assert `lastSweepAt` is set.

## 12. Step 11: storage guard and size logging

In `ShopAgent.syncOrders` (`ShopAgent.ts:1458`), after the in-flight check and before
`reserveSync`:

```ts
const databaseSize = this.ctx.storage.sql.databaseSize;
yield* Effect.logInfo(`ShopAgent.syncOrders: shop=${shop} databaseSize=${String(databaseSize)}`).pipe(Effect.annotateLogs({ shop, databaseSize }));
if (databaseSize >= ShopLimits.storageSoftLimitBytes) {
  yield* repository.failSync({ message: "Storage limit reached; bulk sync refused. Contact support." });  // check failSync's actual signature
  yield* Effect.logError(...);
  yield* publish();
  return yield* repository.getSyncState();
}
```

`failSync` already writes `SyncState.lastError`, which the orders page shows; confirm the exact
shape at `OrderRepository.ts:829-885`. Webhooks are not gated: single-order writes keep the
floor running, only the bulk import is refused.

Also log `databaseSize` at the end of `onOrdersStream` next to the counts, so the two numbers
bracket every import.

`rowsRead` instrumentation is optional: if the Effect SQL client used in `ShopAgent` exposes
the underlying `SqlStorageCursor`, log `rowsRead` for the orders-index count query and the bulk
fold. If it does not, skip it and record the deviation; `databaseSize` is the required signal.

Verify: `shop-agent-callables.test.ts` or `orders-sync-workflow.test.ts`: with the constant
overridden low through a test seam, assert `syncOrders` returns a state with `lastError` set
and no workflow started.

## 13. Step 12: UI surfaces

Keep it small; these are merchant-facing but not the point of the change.

- **`/app` index** (`src/routes/app.index.tsx`): replace "Daily action limit" with two lines
  from `getUsage()` (via `ShopAgentClient` in the loader) and `resolveEntitlements`:
  "Orders this month: 412 of 1,000" and "Members: 4 of 10" (member count from
  `Repository.countMembers`). When orders exceed the limit, an `s-banner` tone `warning`:
  "You've synced 1,050 of 1,000 orders this month. Syncing continues. Upgrade for more." with
  the existing Manage plan button. When `liveRunsLimitedAt` is set, an `s-banner` tone
  `critical`: "Baton stopped starting new runs because 5,000 are already in progress. Finish or
  cancel runs to resume."
- **Orders index** (`src/routes/app.orders.index.tsx`): the same two banners, since that is
  where a merchant looks when something is missing. Reuse one component.
- **Admin shop page** (`src/routes/admin.shop.$shop.tsx:251`): replace the "Daily action limit"
  field with `ordersThisMonth / ordersPerMonth`, `databaseSize` formatted in MB, `lastSweepAt`,
  and `liveRunsLimitedAt`.

Copy lives next to the components, not in `Domain`.

Verify: `pnpm typecheck`, run the app (`pnpm app:dev`) and check the three pages render with a
seeded shop (`pnpm seed`).

## 14. Test and verification checklist (whole change)

1. `pnpm typecheck && pnpm lint && pnpm test` green.
2. `pnpm graphql-codegen` green after step 2.
3. `pnpm fmt` run, all touched files kept.
4. `pnpm d1:reset`, then start the app and sync a dev shop: confirm the first sync log shows
   `field=created_at`, the bulk query carries the open-work filter, `databaseSize` is logged,
   `ordersThisMonth` matches the count of paid, in-month orders inserted.
5. Grep for the removed identifiers: `raw`, `dailyActionLimit`, `toOrderRaw`. None should
   remain in `src/`.

## 15. Questions for review, with recommendations

All accepted on 2026-09-17. Kept for the record; the implementer follows the recommendations.

1. **Live-run ceiling on auto-start (§10).** Skip the insert, record `liveRunsLimitedAt`, and
   render a persistent critical banner; or fail the transaction so the webhook returns non-2xx?
   **Recommendation: banner, do not fail the webhook.** A failed webhook is retried for four
   hours and then dropped, and the retry cannot fix the condition (the shop is at the ceiling
   until someone finishes runs), so failing buys nothing except a lost order write. Skipping
   the run but storing the order keeps the order visible on the index with the "no workflow"
   chip, the banner names the cause, and the next reconcile after a run completes starts it
   because `reconcileAll` walks every open order. At 5,000 live runs the shop is far outside
   the target, so this path is a safety valve that should almost never fire.
2. **First-sync filter terms (§4).** Keep unpaid open orders visible?
   **Recommendation: yes.** A pending-payment order is still work the maker will see soon;
   `canStartRuns` already prevents a run on it, and the paid webhook flips it. Filtering paid
   only would hide an order that becomes paid an hour after install until its webhook arrives,
   which it will, so this is low stakes either way.
3. **Line-item truncation UI (§8).** Detail-page banner only?
   **Recommendation: yes.** 250 line items is rare enough that an index badge is noise, and
   the log line covers operators.
4. **Retention age test (§11.1).** `updatedAt` older than 90 days?
   **Recommendation: yes.** It is the only timestamp both paths refresh, it is what
   `ShopOrder_closed_idx` can order by, and "closed and untouched for 90 days" is the intent.
   `closedAt` would delete an order a merchant edited last week.
5. **UI scope (§13).** Trim?
   **Recommendation: keep all three, but share one banner component.** The orders index is
   where a merchant notices a missing order; the app index is where they manage the plan; the
   admin page is where you diagnose. Each is a few lines once the component exists.
6. **Test plan handles.** Keep `baton-basic-test` / `baton-pro-test`?
   **Recommendation: drop them.** Dev stores in the same Partner organization get public plans
   at $0, which is the whole purpose the test handles served. Removing two literals from
   `Domain.PlanHandle` and `planOfHandle` is a one-line change; add it to step 3.
7. **Prices.** The README now says $29 and $79, marked provisional.
   **Recommendation: leave them.** A number in the README is what lets you create the plan
   without a second round trip; change both places when the listing is finalized.
8. **Welcome link.** Confirmed from `src/routes/app.tsx:138`: the redirect is detected by
   `plan_handle` in the search string, which Shopify appends automatically. **`/app` is the
   welcome link.** No question remains.
9. **How many plan sets.** `shopify.app.toml` is `baton-local` with a real client id;
   `shopify.app.staging.toml` is a skeleton with no client id; there is no production toml.
   **Recommendation: create the plans for `baton-local` now, and again for each app as it is
   created.** Plans are per app, so there is no way around repeating it.

## 16. Deviations

The implementer records here anything that departed from this plan: what the plan said, what
was done instead, and why. One entry per deviation, newest last. Leave the heading in place
even if empty.

| Step | Plan said | Done instead | Why |
| ---- | --------- | ------------ | --- |
|      |           |              |     |

# Open-order ceiling: implementation plan

This plan carries out the decisions in `docs/open-orders-research.md` (2026-10-04, seven
recommendations accepted as written, re-read against the code the same day). Read that doc first:
"Short answer" is the two populations, "What the ceiling fences today" is what goes, option B is
what replaces it, "Second reading" lists every site, and Decisions holds the seven calls. Nothing
is open there. Where this plan had to choose something
the research did not, the choice is under "Decided at planning time".

Four phases. Phase 1 rewrites the spec: the Platform ceiling row, the predicate in Billing, the
`syncOrder` tables in Orders, the README line. Phase 2 is the object: the count, the three gates,
the flag, the logs. Phase 3 is the two screens: the quota banner's copy and the admin shop page's
new field. Phase 4 is the tests: the helper, the ceiling suite, and the four tests outside it. Each
phase starts at the spec text, then the code, then the tests, and ends with a "done when".

## Before you start

- Read `AGENTS.md`, `docs/vocabulary-runbook.md`, and the JSDoc on: the Platform vocabulary's
  ceiling row and `ShopLimits` (`src/lib/domain/Platform.ts`); `Entitlements`, `ShopUsage` with
  its triggers table and three assumptions, `cycleAtOrderCeiling`, `membersAtCeiling`
  (`src/lib/domain/Billing.ts`); `orderIsOpen`, `syncOrder` with its four tables, `SyncAction`,
  `OrdersSyncResult` (`src/lib/domain/Orders.ts`); `ShopUsageRow`, `OPEN`, `openAs`,
  `upsertOrder`, `countOrder`, `currentCycle`, `countedSince`, `markOrdersLimited`, `readUsage`,
  `usageAtCycle`, `setBillingCycle` and the counts statement in `listOrders`
  (`src/lib/OrderRepository.ts`); `OrdersStreamCounts` (`src/lib/ShopAgentOrdersStream.ts`);
  `syncOpenOrders`, `onOrdersStream`, `syncOrderWebhook`, `getUsage` (`src/lib/ShopAgent.ts`);
  `getUsage` in `src/lib/agent/Billing.ts`; `QuotaBanners` (`src/components/QuotaBanners.tsx`);
  the Plan section of `src/routes/admin.shop.$shop.tsx`; the `ShopOrder` and `ShopUsage` DDL
  and the data-model table (`src/lib/ShopAgentSchema.ts`); the copy table's banner row on
  `CopySlot` (`src/lib/Screen.ts`). On the checker side: `parseTriggerTable`,
  `parseSyncActions` and `checkPinned` (`scripts/lib/spec.ts`), `RESERVED_STEMS` and `RETIRED`
  (`scripts/lib/rules-lint.ts`). On the test side: `test/integration/order-ceiling.ts`,
  `test/integration/shop-agent-orders-ceiling.test.ts`, the ceiling tests in
  `order-repository.test.ts` ("the ceiling counts orders work started on..."),
  `shop-agent-sync-order.test.ts` ("the order ceiling is read at the cycle the sync lands in..."),
  `orders-sync-workflow.test.ts` ("a sync refused at the order ceiling flags the refusal..." and
  the refused half of "Sync open orders publishes to every screen when it starts or is refused"),
  `domain.test.ts` ("Domain.cycleAtOrderCeiling"), and `rows-read.ts`.
- The rules that matter most here:
  - A rule is stated once, on the symbol that is the concept or enforces it. The ceiling's rule
    moves from `cycleAtOrderCeiling` to its successor and every site that restated the cycle
    reading (rule 5, the `atCeiling` parameter, the `upsertOrder` comments, the webhook JSDoc) is
    rewritten to say the open-order reading, or cut where it only explained the cycle.
  - A JSDoc never cites a file under `docs/`. Carry the reasoning inline.
  - The vocabulary's words. "Open order" is a shared word (the Shared words table on the map in
    `src/lib/Domain.ts`) and travels with its noun: `openOrdersAtCeiling`, `maxOpenOrders`,
    `countOpenOrders`, `openOrders`. "Ceiling" is the Platform word for a per-shop limit the
    object enforces. "Counted order" stays the meter's word and never names the ceiling again.
    `pnpm lint` refuses `is<State>` exports and reserved stems; none of the new names carry one.
  - Every pinned title in a spec table is a test title that exists. `pnpm spec check` refuses
    a title no test carries, so a table row and its test change in the same step.
  - `pnpm fmt` after every phase; keep every file it touches.
  - Do not commit.

## The decisions, by phase

| decision                                                                      | phase   |
| ----------------------------------------------------------------------------- | ------- |
| 1. replace the per-cycle ceiling with an open-order ceiling                   | 1, 2    |
| 2. 2,500 open orders, provisional, per shop, plan-independent                 | 1       |
| 3. the banner names the way out; no automatic re-sync                         | 3       |
| 4. no tag gate at sync                                                        | none    |
| 5. the open-order count on the admin shop page; no second home page tile      | 2, 3    |
| 6. turnaround assumed days to weeks; first long-turnaround merchant raises it | 1       |
| 7. the trial rule goes with the cycle ceiling; every site listed              | 1, 2, 4 |
| 8. the refusal flag is cleared when the next new order is stored              | 2.4     |

## Decided at planning time

1. **The count is derived, never stored.** `count(*) from ShopOrder where <OPEN>` is a covering
   scan of `ShopOrder_open_idx`, one row per open order, at most the ceiling's worth, and it
   cannot drift. A counter column would need a write on every sync that moves an order in or out
   of the open set and on every retention delete, and a reconciliation when it disagreed. Not
   worth a column. The statement spells the predicate verbatim through the existing `OPEN`
   constant so SQLite proves the partial index serves it (the reason on `listOrders`).
2. **The count is read only for a new order.** Rule 8 is unchanged: a stored order always takes
   its update. So the webhook reads the count only when `getOrderUpdatedAt` answers none, the
   write reads it only when the primary-key probe finds no row, and the sync start reads it
   always (it is about to stream new orders). No count is read for the stored-order webhooks that
   are most of a shop's traffic.
3. **Sync open orders is still refused before it starts at the ceiling.** The sync fetches open
   orders only; at the ceiling every new one would be refused and the stored ones' updates cannot
   lower the count (a fulfilled order is not in the sync's result; fulfilments reach Baton by
   webhook). One visible refusal beats a stream that stores nothing new and refuses two thousand
   times. Same mechanics as today: `markOrdersLimited`, publish, `Refused`.
4. **Open is `orderIsOpen`.** Not cancelled and not `FULFILLED`, exactly the partial index's
   predicate and exactly what the orders strip's Open count reads. No third state, no position.
5. **The predicate is `openOrdersAtCeiling(openOrders: number)` in Billing**, beside
   `membersAtCeiling`, with `ShopLimits.maxOpenOrders` in Platform. It stays in Billing because
   `ShopLimits` and the other ceiling live there and the refusal flag is a `ShopUsage` field; the
   JSDoc says it is about the object's load, not billing, and names the meter as the thing it is
   not.
6. **`openOrders` rides on `ShopUsage`**, derived at read like `pendingUsageEvents` and
   `databaseSize`: a subselect in `readUsage`. It is what the admin shop page shows and what the
   ceiling reads; one statement, one definition. No data-model row: it is not stored.
7. **`ordersLimitedAt` keeps its name** ("when the ceiling last refused a new order" is still
   what it means) and its JSDoc changes. The three cycle clears go; decision 8 replaces them:
   cleared in `upsertOrder` when a fresh write lands.
8. **Rule 5 becomes the open-order reading**: "the order ceiling is read against the open orders
   stored at that moment, wherever it is read: before a start, before a webhook's fetch, and per
   new order in the write; a sync refused before it starts is refused once, visibly, and a stream
   that crosses the ceiling refuses each new order and streams on". Pinned by "the order ceiling
   is read against the open orders stored: a fulfilled order makes room for a new one".
9. **The `ceiling` column of the actions table keeps its name and its two values** (`at`,
   `under`); only the sentence defining it changes. The table's fixtures and the overlap check
   are untouched.
10. **The banner copy** is one of the copy table's banner forms, fact then what clears it, no
    date: "New orders stopped syncing at 2,500 open orders. Fulfill or cancel orders in Shopify,
    then Sync open orders." The number comes through `formatNumber(ShopLimits.maxOpenOrders)`.
    "Fulfill" is the spelling the orders index already uses ("Fulfilled").
11. **The admin field** is "Open orders", a plain count beside "Database size", with the ceiling
    as its denominator: "1,204 of 2,500". The operator reads headroom, not a bare number.
12. **Log lines** say `status=order-ceiling openOrders=<n> limit=<n>` where they said
    `ordersThisCycle=` or `limit=` alone; `openOrders` and `limit` go in the annotations too.
13. **The test helper** becomes `withMaxOpenOrders`, same seam, same file renamed to
    `open-order-ceiling.ts`. Tests that reached the ceiling by writing `ordersThisCycle` reach it
    by inserting open `ShopOrder` rows directly (a `storeOpenOrders(shop, n)` helper beside it:
    `insert into ShopOrder` with `fulfillmentStatus = 'UNFULFILLED'`, `cancelledAt null`, distinct
    ids, no items), because the ceiling now counts rows, and lowering the ceiling to 2 keeps the
    inserts to two.
14. **`usageAtCycle` is deleted.** Its two callers were the two ceiling reads. The webhook's
    sweep rate limit reads `getUsage` (the row as stored; a lagging cycle is the documented
    behaviour of that read and the sweep does not care which cycle it is).
15. **The seed is not exempt.** Seeded orders are open orders and count. The seeds are small;
    the row-count fixture lifts the ceiling as it does today.

## Phase 1: the spec

### 1.1 Platform

- `ShopLimits`: replace `maxOrdersPerCycle: 2500` with `maxOpenOrders: 2500`. JSDoc: "Open
  orders (`orderIsOpen` in Orders) stored at one moment, past which no _new_ order is stored
  until one closes. The quantity that loads the object: every orders index read and every
  member read is linear in it, whatever cycle the orders arrived in. Provisional; enterprise
  fencing, not a tier, and plan-independent like `maxMembers`; the first long-turnaround merchant
  who meets it is the reason to raise it. See `openOrdersAtCeiling` in Billing."
- The vocabulary's ceiling row: "`maxOpenOrders`, `maxMembers` on `ShopLimits`".

### 1.2 Billing

- `cycleAtOrderCeiling` becomes `openOrdersAtCeiling = (openOrders: number) => openOrders >=
ShopLimits.maxOpenOrders`. Its JSDoc carries the rule and the reasoning: the ceiling is about
  the object's load, which is set by open orders at a moment (incoming rate × turnaround), not by
  orders counted in a cycle; it reads rows Shopify has not closed, so it holds orders Baton never
  billed (unpaid, unmatched) and counted orders from earlier cycles alike; a refused order is
  lost to Baton until the merchant closes orders in Shopify and presses Sync open orders, inside
  its 30-day window (the paragraph on the webhook answering 2xx stays, reworded for "until the
  count drops" instead of "for the rest of the cycle"); `ordersLimitedAt` raises the banner.
  Say plainly what it is not: the usage meter (`ShopUsage.ordersThisCycle`) has no ceiling of its
  own; past the plan's included orders Baton bills and never refuses.
- `ShopUsage.ordersThisCycle` JSDoc: cut "It is also what `cycleAtOrderCeiling` reads, so the
  ceiling bounds work started"; say "Never decremented, never a ceiling: the meter bills, the
  open-order ceiling (`openOrdersAtCeiling`) refuses."
- `ShopUsage.ordersLimitedAt` JSDoc: "Set when a new order was refused at
  `ShopLimits.maxOpenOrders`; cleared when the next new order is stored
  (`OrderRepository.upsertOrder`)".
- Add `openOrders: Schema.Number` to `ShopUsage` with the JSDoc "Open orders stored, at read
  time: the quantity `openOrdersAtCeiling` reads, shown on the admin shop page. Derived from the
  rows, never stored." Place it beside `databaseSize`.
- The triggers table's assumption 3 ("A trial's counted orders count toward
  `maxOrdersPerCycle`") goes. Renumber nothing: the list has three items and becomes two.
- `Entitlements.ordersPerCycle` JSDoc: "Past this the usage meter bills; nothing refuses an order
  but `ShopLimits.maxOpenOrders`, which reads open orders, not this count."

### 1.3 Orders: the `syncOrder` tables

- The gating paragraph: "A new order at the order ceiling is refused because the ceiling is a
  fact about new orders in the cycle the sync lands in" becomes "A new order at the order
  ceiling is refused because the ceiling is a count of the open orders stored, and a new order
  is one more; a stored order's update never changes the count upward."
- The `ceiling` column's definition: "`ceiling` is `openOrdersAtCeiling` of the open orders
  stored when the write begins."
- Rule 5: the text in decided-at-planning 8, `where` unchanged, pinned by "the order ceiling is
  read against the open orders stored: a fulfilled order makes room for a new one".
- Rule 8's pinned title: "the ceiling counts open orders, not counted ones: a new order is
  refused at it, a stored one still updates, and a closed order makes no claim on it".
- The `atCeiling` parameter JSDoc: "`openOrdersAtCeiling` of the open orders stored when the
  write begins. Ignored when `stored` is set."
- `OrdersSyncResult` JSDoc: "`Refused` is the order ceiling" stays; nothing about a cycle.
- The "When a sync happens" and "What each ending leaves" tables: no cell changes; "the shop at
  the order ceiling, before the start" is still true.

### 1.4 README

- Line 24: "Past the allowance orders keep syncing and are billed; the one refusal is
  `Domain.ShopLimits.maxOpenOrders`, open orders stored at one moment."

### 1.5 Done when

- `pnpm spec check` parses every table. It will fail on the two retitled pinned rows until
  phase 4 renames the tests; run it again after phase 4.
- `grep -rn maxOrdersPerCycle src README.md` returns nothing. `cycleAtOrderCeiling` returns
  nothing.

## Phase 2: the object

### 2.1 The count

- `OrderRepository`: add `countOpenOrders: () => Effect<number, SqlError>`, the statement
  `select count(*) from ShopOrder where ${OPEN}`. JSDoc: the one definition of the open-order
  count, what the ceiling and `ShopUsage.openOrders` read; spelled through `OPEN` so the partial
  index serves it; one row per open order.
- `readUsage`: add `(select count(*) from ShopOrder where <OPEN>) as openOrders` beside
  `pendingUsageEvents`; `ShopUsageRow` gains `openOrders: Schema.Number`. `ShopUsageRow`'s JSDoc
  (line 44) says "when the order ceiling last refused something" already; add "and how many open
  orders it carries".
- `agent/Billing.ts` `getUsage` needs no change: it spreads the row.

### 2.2 The write

- `upsertOrder`: remove the `currentCycle(order.syncedAt)` call (the counting path rolls the
  cycle itself in `countOrder`). Replace with: when `stored` is undefined, `const openOrders =
yield* countOpenOrders()`; `atCeiling: stored === undefined && Domain.openOrdersAtCeiling(openOrders)`.
  Rewrite the two comments: the probe comment ("what the ceiling gates on") stays; the
  "Resolved on every path, before the insert, because the ceiling is a fact about the cycle"
  comment becomes "Counted inside the transaction, so a stream storing its two-thousandth order
  reads the 1,999 before it; `syncOrder` ignores `atCeiling` for a stored order (rule 8), so no
  count is read for one."
- The `refused` field's JSDoc: "`Domain.ShopLimits.maxOpenOrders`" for "maxOrdersPerCycle"; the
  rest holds.
- `markOrdersLimited` JSDoc: same substitution.
- Delete `usageAtCycle` from the service, its JSDoc and its implementation.

### 2.3 The gates in `ShopAgent`

- `syncOpenOrders`: replace `repository.usageAtCycle(now)` and `cycleAtOrderCeiling` with
  `repository.countOpenOrders()` and `openOrdersAtCeiling`. Comment: "The order ceiling, read
  against the open orders stored now (rule 5 on `Domain.syncOrder`). No storage guard beside it:
  the ceiling is what bounds how much this object can take on." Log
  `status=order-ceiling openOrders=<n> limit=<n>`.
- `syncOrderWebhook`: read `repository.getUsage()` for the sweep (the comment "One read serves
  both the ceiling and the sweep" goes); when `Option.isNone(stored)`, read `countOpenOrders()`
  and refuse at `openOrdersAtCeiling`. Rewrite the JSDoc block: "The one hard stop on orders. It
  gates _new_ orders only... keeps receiving its updates" holds; "a retry cannot change the
  answer" holds. Log as above.
- `onOrdersStream`: the refused log's `limit` reads `maxOpenOrders`.
- `ShopAgentOrdersStream`: `ordersRefused`'s JSDoc names `maxOpenOrders`.
- `syncOpenOrders`'s JSDoc (around line 780): "Rule 5 there: the order ceiling is read before
  the start" holds.

### 2.4 The flag (decision 8)

- `upsertOrder`, fresh write path: after the insert, `update ShopUsage set ordersLimitedAt =
null where id = 1 and ordersLimitedAt is not null`. Comment: "A new order stored is syncing
  resumed, which is what the banner said had stopped; the gap it left is the merchant's to close
  with Sync open orders, and the banner has told them so."
- Remove `ordersLimitedAt = null` from the three cycle writes: the provisional open and the
  roll-forward in `currentCycle`, and the recount in `setBillingCycle`. Their comments mention
  only the count and the mark, so no prose changes.
- The rule is stated on `upsertOrder` (the symbol that enforces it) and `ShopUsage.ordersLimitedAt`
  links it.

### 2.5 Done when

- `pnpm typecheck` and `pnpm lint` pass.
- `grep -rn usageAtCycle src test` returns nothing.

## Phase 3: the screens

### 3.1 The quota banner

- `QuotaBanners`: the text in decided-at-planning 10; the `cycleEndAt` fragment goes. The
  component JSDoc: "shown only after the fact: once a new order was refused at the order ceiling.
  It names what clears it: closing orders in Shopify, then Sync open orders, which stores the
  refused orders still open and inside its 30-day window." Keep the paragraph on included orders
  not being a banner.
- `scripts/rules-lint.ts` refuses "please" and "successfully" in copy and the retired words; the
  sentence has none. `pnpm spec check` reads examples from the copy table only; the banner's
  text is not an example there, so nothing to add.

### 3.2 The admin shop page

- In the Plan section's grid, after "Database size": `<Field label="Open orders"
value={`${formatNumber(usage.openOrders)} of ${formatNumber(Domain.ShopLimits.maxOpenOrders)}`} />`.
  A comment: "The ceiling's quantity against the ceiling: the operator's signal for a shop
  approaching it (`Domain.openOrdersAtCeiling`), beside the storage it drives."
- "Orders limited" stays as is; its value is `ordersLimitedAt`.
- `e2e/plan.billing.spec.ts` reads a fixed list of fields; a new field does not disturb it.

### 3.3 The home tile's detail

- `app.index.tsx`, the Orders tile's `detail` when not over: "Each order synced from Shopify
  counts once." becomes "Each order counts once, when work starts on it." The meter's word is
  counted order (the Billing vocabulary); a synced order nothing matches is never counted, and
  the old sentence said the opposite. The plan copy "Billed once work starts on an order" already
  says it the right way; the tile agrees with it.

### 3.4 Done when

- The orders index and the home page render with the flag set (set it by SQL on the dev store,
  `update ShopUsage set ordersLimitedAt = <now> where id = 1`, and read the banner; clear it).
- The admin shop page shows "Open orders" with the seeded count over 2,500.

## Phase 4: the tests

### 4.1 The helper

- Rename `test/integration/order-ceiling.ts` to `open-order-ceiling.ts`; `withMaxOrdersPerCycle`
  becomes `withMaxOpenOrders`, patching `maxOpenOrders`. Add `storeOpenOrders(shop, n)` (decided 13) for the object tests, and a repository-level twin where a test runs inside
  `runInRepository`. Update the eight importers.

### 4.2 The ceiling suite (`shop-agent-orders-ceiling.test.ts`)

- The file JSDoc: "at `Domain.ShopLimits.maxOpenOrders` open orders stored, a _new_ order is
  refused until one closes".
- `setCount` goes; each test calls `storeOpenOrders(shop, 2)` under `withMaxOpenOrders(2, ...)`.
  `setBillingCycle` calls stay only where a test needs a cycle for the count (none of the three
  do); drop them and `CYCLE_END`, whose comment explained a cycle read that no longer happens.
- "a new order refused at the ceiling publishes nothing": unchanged otherwise.
- "refuses a new order at the ceiling and flags the refusal": assert `orderCount` is 2 (the
  stored two) and `usage.openOrders` is 2; drop `ordersThisCycle`.
- "clears the refusal flag when a new billing cycle starts" becomes "clears the refusal flag
  when a new order is stored" (decision 8): store two, refuse a third, mark one of the
  two fulfilled by SQL (`update ShopOrder set fulfillmentStatus = 'FULFILLED'`), sync a new order
  through `seedOrders` or a direct `upsertOrder`, assert `ordersLimitedAt` is null and
  `openOrders` is 2.

### 4.3 The four outside it

- `order-repository.test.ts`: retitle to rule 8's new title. Fixture under `withMaxOpenOrders(2)`:
  store two open orders (both uncounted, which is the point: the count no longer matters); a third
  is refused; an update to the first still flows; then fulfil the second by storing it again with
  `fulfillmentStatus: "FULFILLED"` and store a third, which is written. Assert `refused` on the
  third's first attempt, `written` on its second, and `openOrders` 2 at the end.
- `shop-agent-sync-order.test.ts`: the rule 5 test becomes "the order ceiling is read against
  the open orders stored: a fulfilled order makes room for a new one". Webhook half: two open
  stored, a webhook for a new order refused; a webhook on one of the two whose fetch returns it
  `FULFILLED` (the suite already mocks the fetch) stores it closed; the refused order's webhook
  again, now stored. Sync half: two open stored, `syncOpenOrders` answers `Refused`; fulfil one by
  SQL; `syncOpenOrders` answers `Started`. Drop the `atOldCeiling` cycle fixture.
- `orders-sync-workflow.test.ts`: both sites replace `update ShopUsage set ordersThisCycle = 2`
  and the `setBillingCycle` call with `storeOpenOrders(shop, 2)`. Titles unchanged.
- `domain.test.ts`: `describe("Domain.openOrdersAtCeiling")`, "the shop is at its order ceiling
  when the open orders have reached maxOpenOrders".
- `rows-read.ts`: `withMaxOpenOrders(1_000_000, ...)`; the comment "so a seed can store more
  orders than one cycle allows" becomes "than the ceiling allows".

### 4.4 Done when

- `pnpm spec check` passes: every pinned title in the `syncOrder` tables and the triggers table
  exists.
- `pnpm test` passes. `pnpm vocab:audit` lists no new word (the new identifiers are vocabulary
  words with their nouns).

## Verification

1. `pnpm typecheck`, `pnpm lint` (runs `spec check` and `rules-lint`), `pnpm test`, `pnpm fmt`.
2. `grep -rn -i "ordersPerCycle\|cycle" src/lib/domain/Billing.ts` and read every hit: none
   should describe the ceiling.
3. `pnpm dev:reset`, then: the home page and orders index with no banner; set `ordersLimitedAt`
   by SQL and read the banner's sentence; store a seeded order and see it clear. The
   admin shop page's "Open orders" field.
4. `npm run test:e2e --` once; `plan.billing.spec.ts` reads the admin fields.

## Out of scope, noticed

- `docs/page-banners-research.md` and other dated research describe the cycle ceiling. Research
  docs are dated and are not rewritten (`docs/vocabulary-runbook.md`).

## Deviations and issues

Record here, as you go, anything that did not go as written: a test that failed for a reason this
plan did not name, a statement the planner served from the wrong index, a copy sentence the lint
refused, a step skipped and why. One entry per item, dated,
with the phase, what was expected, what happened, and what was done. An empty section at the end
means everything went as written; say so explicitly rather than leaving it blank.

| date       | phase          | expected                                                                                                        | happened                                                                                                                                                                                                                                                                                                                                                             | done                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | -------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-04 | 3.3            | The home tile's sentence changes and nothing else does                                                          | `pnpm spec check` refused the copy table: the `body` row's example on `CopySlot` (`src/lib/Screen.ts`) was the old sentence, "Each order synced from Shopify counts once."                                                                                                                                                                                           | Changed the example to the new sentence, "Each order counts once, when work starts on it."                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-10-04 | 4.1            | A repository-level twin of `storeOpenOrders` for tests inside `runInRepository`                                 | The one repository test reaches the ceiling by storing two open orders through `upsertOrder`, which is the fixture 4.3 describes                                                                                                                                                                                                                                     | No twin added; `storeOpenOrders` is object-level only                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-10-04 | 4.3            | The rule 5 webhook half fulfils a stored order through a webhook whose fetch answers `FULFILLED`                | The suite's Admin API stand-in answered `ORDER_ID` with an unfulfilled order and one fixed item id for every request                                                                                                                                                                                                                                                 | The stand-in now answers the id the request names (`ORDER_ID` when none), takes its fulfillment status from a new `orderFulfillmentStatus` variable reset in `afterEach`, and gives a second order its own item id, since the item key is shop-wide. No other test in the file changed                                                                                                                                                                            |
| 2026-10-04 | 4.2            | "clears the refusal flag when a new order is stored" stores the new order through `seedOrders` or `upsertOrder` | As written                                                                                                                                                                                                                                                                                                                                                           | Used `seedOrders`, which writes through `upsertOrder`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-10-04 | 2.3            | Decided 2: no count is read for a stored-order webhook                                                          | Decided 6 puts `openOrders` on `ShopUsage` as a subselect in `readUsage`, and decided 14 has the webhook's sweep read `getUsage`, so every webhook that reaches the sweep runs the open-order count (a covering scan of `ShopOrder_open_idx`, at most the ceiling's worth of entries), beside the `pendingUsageEvents` count the old `usageAtCycle` read already ran | Left as planned; deferred, see open issue 1 below                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-10-04 | Verification 3 | Set `ordersLimitedAt` by SQL on the dev store and read the banner; read the admin field                         | The object has no dev SQL route                                                                                                                                                                                                                                                                                                                                      | Set the flag with `sqlite3` on the local object's file under `.wrangler/state`, screenshotted the orders index and home through a temporary Playwright spec and the admin shop page through a temporary admin spec (both deleted). The banner reads "New orders stopped syncing at 2,500 open orders. Fulfill or cancel orders in Shopify, then Sync open orders."; the admin field reads "1 of 2,500". `pnpm seed` then stored new orders and the flag read null |

| 2026-10-04 | 2.4 | Decision 8: the flag is cleared when the next new order is stored | Reviewed after implementation: a shop held at the ceiling by its own incoming rate stores one order for every fulfilment, so the banner would clear within minutes of being raised, before the merchant read it, while the refused orders stayed lost; and Sync open orders, the way out the banner names, is itself refused at the ceiling (decided 3) | Decision 8 revised, 2026-10-04 (recorded in the research doc): the flag is cleared when Sync open orders starts, by `OrderRepository.clearOrdersLimited`, and by nothing else. The `upsertOrder` clear went; the ceiling suite's test became "keeps the refusal flag when a new order is stored after one closes", and the rule 5 test asserts the flag through the refused and started sync |
| 2026-10-04 | 2.3 | Open issue 1 below | Resolved the same day | `OrderRepository.lastSweepAt` reads the one column; the webhook's sweep reads it instead of `getUsage`, so a stored-order webhook runs no count. `pendingUsageEvents` left the webhook path with it |

### Open issues

None open. Issue 1 was resolved on 2026-10-04 (the deviations table has the entry); its text is kept for the record.

1. **The webhook sweep reads the open-order count on every delivery** (2026-10-04, phase 2.3; resolved).
   Decided 2 says the count is read only for a new order, so a webhook on a stored order, most of
   a shop's traffic, reads none. Decided 6 puts `openOrders` on `ShopUsage` as a subselect in
   `readUsage`, and decided 14 has `syncOrderWebhook`'s retention sweep read `getUsage` for
   `lastSweepAt`. Together they run `select count(*) from ShopOrder where <OPEN>` on every webhook
   that reaches the sweep. The cost is a covering scan of `ShopOrder_open_idx`, at most the
   ceiling's 2,500 entries, beside the `pendingUsageEvents` count the old `usageAtCycle` read
   already ran. The fix that holds decided 2: a narrow read of `lastSweepAt` for the sweep (a new
   `OrderRepository` method, or `lastSweepAt` on an existing narrow row), leaving `getUsage` to the
   screens. To decide: whether the scan is worth a method, and whether `pendingUsageEvents` should
   leave the webhook path with it.

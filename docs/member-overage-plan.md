# Member overage: implementation plan

Date: 2026-09-22. Research and decisions: `docs/member-overage-research.md`,
sections 8 (decisions) and 9 (probe results). Every decision there is
settled; this plan does not reopen them.

## Ground rules for the implementer

- Read `CLAUDE.md` first. JSDoc rules, `Domain` predicates (never inline
  comparisons in routes or the object; `pnpm lint` refuses them), one test
  per rule with the rule as the title, `pnpm fmt` and keep everything it
  touches, no commits unless told.
- **Prototype phase.** Schema changes are made in line in
  `ShopAgent.initializeSchema` and `migrations/0001_init.sql`. No new
  migration files. All local Durable Object state and local D1 are reset
  from scratch; see "When to ask for a reset".
- **The dev server is stopped when you start.** Steps 1 to 7 need no
  server: they end with `pnpm typecheck`, `pnpm lint`, and the integration
  tests named in the step (`pnpm test -- <file>`), which run in their own
  Workers runtime. Do not ask for the server before Step 8.
- Run `pnpm graphql-codegen` after any change to a `#graphql` string. Step 3
  touches one in `ShopifyPartner.ts`, which is a Partner API query, not
  Admin; codegen ignores it, run it anyway.
- The Chrome DevTools MCP is available for Step 8 and is the preferred way to
  look at the app. `pnpm playwright-cli` is the alternative. The Shopify
  admin is signed in on the Chrome that the MCP drives; the embedded app is
  at `https://admin.shopify.com/store/sandbox-shop-01/apps/baton-local/app`
  and the operator console at `http://localhost:3800/admin/shop/sandbox-shop-01.myshopify.com`
  (port from `pnpm port`; admin sign-in is any email in `ADMIN_EMAILS`).
- Record anything you did differently, could not do, or found wrong in
  "Deviations and issues" at the end of this file. One entry per item: what,
  why, what the user should look at.

## 1. Outcome

Members stop being capped per plan. A plan includes some seats; members past
that are billed per seat per billing cycle through a second App Pricing usage
meter, `members`, exactly as orders past the included allowance are billed
through `production-orders`. Nobody is locked out on a downgrade. A hard
ceiling on roster size stays, plan-independent, like `maxOrdersPerCycle`.

The Partner Dashboard side is done: both plans carry the `members` meter
(tier 1 at $0.00 up to 3 on Basic and 10 on Pro, then $15.00 and $10.00 per
unit) and the orders meter is now `production-orders` with tiers at 20 and 30. `README.md`, "Plans", is the record. Code has to match it.

## 2. Rules, stated once

Each rule lives on the symbol named, as JSDoc, and has a test whose title is
the rule. Other sites `{@link}` it.

| Rule                                                                                                                                                                                                 | Symbol                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A plan includes `membersIncluded` seats; members past that are billed by the `members` meter, never refused. Nothing in the app compares the roster to the included count except the home-page tile. | `Domain.Entitlements.membersIncluded`                    |
| The billable seat quantity for a cycle is its high-water mark: the roster size at cycle start, plus one for each add that raises the mark. Never reversed on removal.                                | `Domain.seatEventValue` (new, section 4)                 |
| A plan change is a new contract with a new cycle from the switch moment and every meter at zero; trial usage is not reported and does not carry. Measured on the dev store 2026-09-22.               | `Domain.ActiveSubscription` (JSDoc only, a few lines)    |
| A changed `cycleStartAt` is a new cycle: the order count is recounted from rows and the seat mark is reset to the roster, which is sent as the cycle's first seat event.                             | `OrderRepository.setBillingCycle`                        |
| A shop holds at most `ShopLimits.maxMembers` members on any plan. Refused at add time, message says to contact support.                                                                              | `Domain.ShopLimits.maxMembers`, `Domain.rosterAtCeiling` |
| A usage event's value is a positive integer; it is `1` for an order and the roster size or `1` for seats.                                                                                            | `Domain.UsageEvent.value`                                |

## 3. What goes away

Delete, do not deprecate. Each site is listed so none is missed.

| Site                                                                                                                                                                                | What                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/Domain.ts`                                                                                                                                                                 | `memberHasSeat`, `MemberAccess.seatRank`, the `maxMembers` field of `Entitlements` (renamed, see Step 1)                   |
| `src/lib/Repository.ts`                                                                                                                                                             | `MemberLimitError`; the `limit` argument and the count check in `addMember`; the `seatRank` subquery in `findMemberAccess` |
| `src/lib/MemberAccess.ts`                                                                                                                                                           | The seat branch of `requireMember` and its JSDoc paragraphs                                                                |
| `src/lib/SubscriptionPlan.ts`                                                                                                                                                       | The comment sentence about a downgrade making a member `402`                                                               |
| `src/routes/shop.$shop_.lapsed.tsx`                                                                                                                                                 | The `seat` reason, its copy, and `LapsedSearch` (the route keeps one reason and no search)                                 |
| `src/routes/app.members.tsx`                                                                                                                                                        | `memberLimitMessage`, the `MemberLimitError` catch, `seatless`, the "No seat" badge, the banner                            |
| `src/routes/app.index.tsx`                                                                                                                                                          | `seatless`, the critical banner, the "seats used" headline and detail                                                      |
| `src/routes/api.dev.seed.ts`                                                                                                                                                        | The "Uncapped on purpose" comment (the seed now passes the ceiling like any add)                                           |
| `migrations/0001_init.sql`                                                                                                                                                          | The comment on `Member_shop_createdAt_idx` about the seat rank (keep the index; the members page orders by it)             |
| `test/integration/domain.test.ts`                                                                                                                                                   | The two `memberHasSeat` tests                                                                                              |
| `test/integration/repository.test.ts`                                                                                                                                               | Every test on `MemberLimitError` and `seatRank`                                                                            |
| `test/integration/member-area.test.ts`, `auth.test.ts`, `worker-agent-gate.test.ts`, `member-runs-socket.test.ts`, `shop-agent-connections.test.ts`, `shop-agent-workflows.test.ts` | Every assertion that a member past the seats is refused or `402`; grep `seat` in each                                      |
| `e2e/members.spec.ts`                                                                                                                                                               | "refuses a member past the plan's seats" (the `Upgrade to add more` test) and "a shop over its seats badges..."            |
| `e2e/fixture.ts`                                                                                                                                                                    | Any comment about seeding past the seats                                                                                   |

## 4. Design

### Where the seat meter lives

The orders outbox is the object's `UsageEvent` table, flushed by
`OrderRepository.flushUsageEvents`. Seats reuse it. Two columns change:
`orderId` becomes nullable and a new `eventHandle text not null` says which
meter a row belongs to. The flush sends each row under its own handle instead
of `Domain.USAGE_METER_ORDER`. One outbox, one flush, one dead-row rule, one
pending count.

The roster is D1's, so the object cannot count it. The Worker tells the
object the roster size at the two moments that matter:

1. **On add.** `app.members.tsx`'s add action, after the insert, calls a new
   plain-RPC `ShopAgent.recordRoster({ size })`. The object compares `size`
   to `ShopUsage.membersHighWater`; if greater, it sets the mark to `size`
   and queues one seat event of value `size - mark` (which is 1 for a single
   add, but the arithmetic is the rule, not the constant), then flushes.
2. **On cycle roll.** `Domain.BillingCycleInput` gains `memberCount`.
   `SubscriptionPlan.revalidate` already counts nothing, so it reads
   `Repository.countMembers(shop)` before the push. In
   `OrderRepository.setBillingCycle`'s existing `changed` branch, the mark
   is set to `memberCount` and one seat event of value `memberCount` is
   queued, dated `cycleStartAt`. The unchanged branch does nothing with it.

Both paths queue and the existing flush sends. A seat event's idempotency key
is `seat#<cycleStartAt>#<mark>`: unique per cycle and per mark, so a replayed
`recordRoster` with the same size is a no-op at the row level even if the
mark comparison were somehow raced. Keep it under 64 characters.

The included count never reaches the object. The meter's $0 band absorbs it,
which is the same split orders already use ("compare here, count there").

### Why the value on a roll is the whole roster, not the overage

Shopify's meter starts each cycle at zero and prices units by the graduated
tiers on the plan. Sending 5 on a Basic contract bills 2; sending 5 on Pro
bills 0. The app sends the roster and the plan decides, so a plan change
needs no app-side arithmetic. This is what the probe showed and what the
`Domain.ActiveSubscription` JSDoc will say.

### The ceiling

`Domain.ShopLimits.maxMembers = 12`. `Domain.rosterAtCeiling(count)` is the
predicate (`count >= maxMembers`). `Repository.addMember` refuses with a new
`MemberCeilingError` when the email is not already a member and the roster is
at the ceiling; `app.members.tsx` turns it into "This shop has reached the
maximum number of members. Contact support to raise it." The seed does not
bypass it: the fixture has 3 members.

### What the merchant sees

- Home page Members tile: headline `N members`, `M included`; detail
  "K past your plan's included seats are billed at your plan's rate." when
  `N > M`, else "Members sign in with their email on the member area." No
  prices anywhere in the app.
- Members page: no badge, no banner, add always works below the ceiling.
- Lapsed page: subscription only.
- Operator console: "Members" stays as `N of M` with `M` the included
  count; add "Members high-water" from `ShopUsage.membersHighWater`. The
  "Shopify metered quantity" field becomes two fields, one per meter.

## 5. Steps

### Step 1. Domain

File: `src/lib/Domain.ts`. Tests: `test/integration/domain.test.ts`.

1. `Entitlements.maxMembers` becomes `membersIncluded`. JSDoc: the rule in
   section 2. `ENTITLEMENTS` values stay 3 and 10. Update the `ENTITLEMENTS`
   JSDoc: the paragraph "A cut to `maxMembers` takes seats away..." becomes
   one sentence, a cut to `membersIncluded` only moves the $0 band, and
   "`ordersPerCycle` must equal tier 1 of the meter" now says the same of
   `membersIncluded` and `USAGE_METER_MEMBER`.
2. `USAGE_METER_MEMBER = "members"` beside `USAGE_METER_ORDER`, same JSDoc
   shape. `USAGE_METER_ORDER` already reads `production-orders`.
3. `UsageEvent.value` becomes a positive integer (`Schema.Int` with a
   `> 0` check, whatever the codebase's idiom is; grep `Schema.isMaxLength`
   for how checks are written). JSDoc: the rule in section 2, and why a
   negative is still a bug (nothing is reversed).
4. `ShopUsage` gains `membersHighWater: Schema.Number` (default 0) with a
   JSDoc that states the high-water rule and links `seatEventValue`.
   `lastReconciledQuantity` becomes two fields,
   `lastReconciledOrders` and `lastReconciledMembers`, both nullable.
5. `seatEventValue(rosterSize, highWater)` returns `rosterSize - highWater`
   when positive, else `0`. Pure; the object calls it. JSDoc: the rule.
6. `BillingCycleInput` gains `memberCount: Schema.Number`.
   `ReconcileUsageInput` becomes `{ orders: NullOr(Number), members: NullOr(Number) }`.
   `ActiveSubscription.usageQuantity` becomes `usage: { orders, members }`
   with the same nullability.
7. `ActiveSubscription` JSDoc gets the probe takeaway in a few lines, dated:
   a plan change is a new contract, a new cycle from the switch moment, and
   every meter at zero; trial usage is not reported and does not carry;
   usage lands within about 30 s. Measured on the dev store.
8. `ShopLimits.maxMembers: 12` with a one-line JSDoc, and
   `rosterAtCeiling(count)`. `ShopLimits.maxOrdersPerCycle` becomes `35`;
   its JSDoc already says provisional and enterprise fencing, so only the
   number moves. The `cycleAtOrderCeiling` test reads the constant and
   follows.
9. New `RecordRosterInput = Schema.Struct({ size: Schema.Number })`.
10. Delete `memberHasSeat` and `MemberAccess.seatRank`.

Tests, titles verbatim:

- "the seat event value is the roster past the cycle's high-water mark, and zero when not past it"
- "a shop is at its ceiling when the roster has reached maxMembers"
- Delete the two `memberHasSeat` tests.

### Step 2. Object: outbox, mark, roll

Files: `src/lib/ShopAgent.ts` (schema, `recordRoster`, `reconcileUsage`),
`src/lib/OrderRepository.ts`, `src/lib/ShopAgentClient.ts`.
Tests: `test/integration/order-repository.test.ts`,
`test/integration/shop-agent-callables.test.ts` (`setBillingCycle` and
`reconcileUsage` live there; grep to confirm).

1. Schema, in line: `UsageEvent.orderId` nullable; add
   `eventHandle text not null`; `ShopUsage` gains
   `membersHighWater integer not null default 0`, and
   `lastReconciledQuantity` becomes `lastReconciledOrders` and
   `lastReconciledMembers`.
2. `countOrder` inserts `eventHandle = USAGE_METER_ORDER`.
3. `flushUsageEvents` selects `eventHandle` and sends it. `UsageEventRow`
   follows (`value` positive integer, `orderId` nullable, `eventHandle`).
4. `deleteSeedOrders` keeps deleting by `orderId like` and must not touch
   seat rows (`orderId is null` rows are untouched by that `like` already;
   say so in a comment).
5. New `OrderRepository.recordRoster({ size })`: in one transaction, read
   `membersHighWater`, compute `seatEventValue`, and when positive update
   the mark and insert a `UsageEvent` row with `eventHandle =
USAGE_METER_MEMBER`, `orderId = null`, `occurredAt = now`,
   `idempotencyKey = seat#<cycleStartAt>#<size>`. When `cycleStartAt` is
   null (no cycle pushed yet), open the provisional cycle the way
   `countOrder` does, so the key has a cycle to name. Return the value
   queued.
6. `setBillingCycle`, in the `changed` branch only: set
   `membersHighWater = memberCount`, insert the seat event with
   `occurredAt = cycleStartAt` and value `memberCount` (when positive), key
   `seat#<cycleStartAt>#<memberCount>`. The existing order recount stays.
   JSDoc: the rule in section 2.
7. `reconcileUsage` stores both readings. `ShopAgent.reconcileUsage` runs
   the drift check per meter: orders as today; members compare
   `membersHighWater` to the reading, tolerance the pending seat events.
   Pending counts per handle need a small change to the `ShopUsageRow`
   query; keep one `pendingUsageEvents` total for the console and add the
   per-handle numbers only if the drift check needs them (it does; the
   simplest is two subqueries).
8. `ShopAgent.recordRoster` as plain RPC (not `@callable()`; the caller is
   the Worker's add-member action), same shape as `setBillingCycle`. It
   ends with `flushUsageEvents`.
9. `ShopAgentClient.recordRoster` and the widened `setBillingCycle` and
   `reconcileUsage` inputs.

Tests, titles verbatim:

- "an add past the high-water mark queues one seat event and raises the mark"
- "an add at or under the high-water mark queues nothing"
- "a member removal queues nothing and leaves the mark"
- "a new cycle resets the mark to the roster and queues it as the cycle's first seat event"
- "an unchanged cycle leaves the mark and queues nothing"
- "the flush sends each event under its own meter handle"
- "seat events survive deleteSeedOrders"
- "the members drift check tolerates pending seat events" (beside the
  existing orders drift test)

### Step 3. Partner read

File: `src/lib/ShopifyPartner.ts`. Test: `test/integration/subscription-plan.test.ts`,
which is where `activeSubscription` is exercised.

1. `meterQuantity` takes a handle. `activeSubscription` returns
   `usage: { orders: meterQuantity(items, USAGE_METER_ORDER), members: meterQuantity(items, USAGE_METER_MEMBER) }`.
2. Test: "reports each meter's quantity by handle, null when the contract lacks the item".

### Step 4. Worker: plan revalidation and member add

Files: `src/lib/SubscriptionPlan.ts`, `src/lib/Repository.ts`,
`src/lib/MemberAccess.ts`, `src/routes/app.members.tsx`,
`src/routes/shop.$shop_.lapsed.tsx`, `src/routes/api.dev.seed.ts`.
Tests: `test/integration/repository.test.ts`, `member-area.test.ts`,
`auth.test.ts`, `worker-agent-gate.test.ts`, `member-runs-socket.test.ts`,
`shop-agent-connections.test.ts`, `shop-agent-workflows.test.ts`,
`subscription-plan.test.ts` (tests `revalidate`).

1. `SubscriptionPlan.revalidate`: before the `setBillingCycle` push, read
   `Repository.countMembers(shop)` and pass it as `memberCount`. Pass both
   readings to `reconcileUsage`. Drop the `402`-on-downgrade sentence from
   the revoke comment; the revoke itself stays (a lapse still needs it).
2. `Repository.addMember`: drop `limit`; refuse with `MemberCeilingError`
   when not already a member and `Domain.rosterAtCeiling(count)`. Keep the
   race note, reworded for the ceiling. Make `countMembers` public on the
   service if it is not.
3. `Repository.findMemberAccess`: drop the `seatRank` subquery and field.
   `countMembers` is already on the service interface.
4. `MemberAccess.requireMember`: `Subscribed` succeeds with the access; the
   redirect with `reason: "seat"` goes. Trim the JSDoc to plan-then-member.
5. `app.members.tsx`: the add action calls `addMember` then
   `shopAgentClient.recordRoster(shop, { size: count })` where `count` is
   `countMembers` after the insert; best-effort with `Effect.ignore({ log: "Warn" })`
   like the pushes in `revalidate`, because a queued seat event that failed
   to record is an operator signal, not a reason to fail the add. Catch
   `MemberCeilingError` into the sentence in section 4. Delete `seatless`,
   the badge, the banner, `maxMembers` in the loader.
6. `lapsed.tsx`: one reason. Remove `validateSearch` and `LapsedSearch`.
7. `api.dev.seed.ts`: `addMember` without `limit`; drop the "Uncapped"
   comment. The seed does not call `recordRoster`: the seed replaces the
   roster wholesale and the next cycle roll or add sends the mark.

Tests, titles verbatim:

- "addMember refuses at the ceiling and says so, and is a no-op for an existing email"
- "requireMember admits every member of a subscribed shop"
- "revalidate pushes the roster size with the cycle and both meter readings"
- Update every test that expected `402` or the lapsed redirect for a member
  past the seats: those members are now admitted. The lapse cases stay.

### Step 5. Merchant and operator surfaces

Files: `src/routes/app.index.tsx`, `src/routes/admin.shop.$shop.tsx`,
`src/components/QuotaBanners.tsx` (check for seat text; likely none).

1. Home page Members tile per section 4. `count`/`limit` on
   `CapacityTile` stay so the meter fills; past the limit it reads as over,
   the same as the orders tile.
2. Operator console: rename the Members field's denominator to
   `membersIncluded`; add "Members high-water"; split "Shopify metered
   quantity" into "Shopify metered orders" and "Shopify metered members".
3. Delete the critical banner and `seatless`.

No integration test for markup; Step 8 looks at it.

### Step 6. JSDoc alignment

Every JSDoc and comment that describes the seat cap, the seat rank, or the
single meter is now wrong. The rules in section 2 are stated once on their
symbols in Steps 1 to 4; this step is the sweep for everything else, and it
is a delete-or-relink pass, not a rewrite. Grep `src`, `migrations`, `e2e`,
and `test` for `seat`, `maxMembers`, `memberHasSeat`, `usageQuantity`,
`lastReconciledQuantity`, and `Literal(1)` and treat every hit. Known sites
on 2026-09-22, beyond those Steps 1 to 5 already touch:

| Site                                                                                | What                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Domain.Entitlements` (fields JSDoc)                                                | `membersIncluded`: "Seats included; members past this many are billed by {@link USAGE_METER_MEMBER}." One line, like `ordersPerCycle`'s.                |
| `Domain.ENTITLEMENTS` JSDoc                                                         | "compare here, count there" paragraph: `membersIncluded` is compared nowhere but the home tile; the roster size reaches the object as a number to send. |
| `Domain.USAGE_METER_ORDER` JSDoc                                                    | "one handle across tiers" holds for both meters; say so once here and give `USAGE_METER_MEMBER` a one-line JSDoc that links it.                         |
| `Domain.MembersLoaderData.maxMembers` JSDoc                                         | Field becomes `membersIncluded`; the JSDoc about the row-index cutoff goes (nothing reads a cutoff).                                                    |
| `Domain.AppIndexLoaderData` and its comments                                        | `memberCount` stays; any mention of seats goes.                                                                                                         |
| `src/worker.ts` (gate JSDoc, ~line 350, and the `isRedirect` comment, ~line 386)    | `402` is for a lapsed subscription only. Drop "or one the plan has no seat for" and "and a member outside the plan's seats".                            |
| `src/lib/SubscriptionPlan.ts` (~line 95 and the revoke comment)                     | The revoke exists for a lapse reaching open sockets; the downgrade sentence goes. The `~95` JSDoc on the cycle push adds "and the roster size".         |
| `src/lib/MemberAccess.ts` (module and `requireMember` JSDoc)                        | Two conditions, not three: membership, then plan.                                                                                                       |
| `src/lib/Repository.ts` (`addMember` race note, `findMemberAccess` JSDoc ~line 996) | Race note reworded for the ceiling; the seat-rank paragraph goes.                                                                                       |
| `migrations/0001_init.sql` (`Member_shop_createdAt_idx` comment)                    | The index serves the members page ordering; say that.                                                                                                   |
| `src/routes/shop.$shop_.lapsed.tsx` JSDoc                                           | One condition; the "seat" paragraphs go.                                                                                                                |
| `src/routes/api.dev.seed.ts` (~line 187)                                            | Comment goes with the cap.                                                                                                                              |
| `src/routes/admin.shop.$shop.tsx`                                                   | Field labels per Step 5.                                                                                                                                |
| `OrderRepository.countKey` JSDoc                                                    | Now one of two key shapes; name the seat key beside it and where it is built.                                                                           |
| `README.md`                                                                         | Already updated; confirm the names it uses exist after Step 1.                                                                                          |

Rule of thumb from `CLAUDE.md`: if a comment restates a rule that now
lives on a symbol, replace the restatement with `{@link}`. If it explains
a mechanism that no longer exists, delete it.

### Step 7. README and docs

1. `README.md`, "Plans": the bullet on the member meter already states the
   rule; make sure the names it uses (`membersIncluded`,
   `USAGE_METER_MEMBER`) now exist. The feature-line paragraph says "line 2
   with `membersIncluded`"; keep.
2. `e2e/fixture.ts` and `e2e/members.spec.ts`: delete the two seat tests
   (section 3) and add one: "adding a member past the included seats
   succeeds and the home tile says it is billed". Seed
   `entitlementsOfPlan("basic").membersIncluded + 1` members (Basic is the
   store's usual plan; read the plan off the orders meter `max` as
   `plan.billing.spec.ts` does if it must work on either), open the home
   page, assert the Members tile detail matches
   `/past your plan's included seats/u`.

Then `pnpm typecheck`, `pnpm lint`, `pnpm test`. All green before Step 8.

### Step 8. Reset, run, look

**Ask for the reset here.** Say in one line: the server is already
stopped; run `pnpm d1:reset` (it recreates local D1 and removes `.wrangler`,
which is where local Durable Object state lives), then `pnpm app:dev`, and
say when it is up. Both schemas changed in place in Steps 2 and 4, so old
state will fail on missing columns.

Once up, `pnpm seed`, then with the Chrome MCP:

1. Open the embedded app. Home page shows the Members tile as `3 members`,
   `3 included` (Basic) with the sign-in sentence.
2. Members page: add `probe.seat4@example.com`. No error. Home page tile
   now says one member past the included seats is billed.
3. Operator console for the shop: "Members high-water" reads 4, "Usage
   events pending" reads 0 within a minute (the add flushed), and after
   "Refresh plan", "Shopify metered members" reads 4 if the store is in a
   paid cycle. **If the store is in the Basic trial** (it was on
   2026-09-22; `Plan boundary` shows a trial end), the meter reads nothing
   and "Usage events pending" may hold the seat event as sent-but-unreported;
   that is the probe's finding 3, not a bug. Record which case you saw.
4. Remove the member. Home tile returns to `3 of 3`; high-water stays 4.
5. Add again. High-water stays 4, no new event (pending count unchanged).
6. Plan switch, Basic to Pro, through Manage plan on the home page (on the
   dev store the button reads "Test with this plan", then "Approve"). Back
   on the home page, tile reads `4 members`, `10 included`. Operator console
   after Refresh plan: "Billing period" starts at the switch time,
   high-water 4, one new pending or sent seat event, "Shopify metered
   members" 4 after a minute.
7. Switch back to Basic so the store is left as found. Note in Deviations
   that this lands the store in its trial remainder.
8. Add members up to the ceiling (12) and one more; the last add shows the
   support sentence. Then remove them down to the fixture's three, or
   `pnpm seed` again.
9. The seed leaves the order count in the mid-twenties against a ceiling of 35. Nothing to click; confirm the operator console's "Orders limited"
   is empty and the home page's orders tile shows the count over Basic's
   20 with the "billed at your plan's rate" detail.

Then `npm run test:e2e -- members` for the members spec.

## 6. Tests and the changed limits

Checked 2026-09-22 after the allowances moved to 20 and 30 in code:

- Integration tests read the constants, never the numbers. `pnpm test`
  passed 400 of 400 at 20 and 30. The two ceiling tests
  (`shop-agent-orders-ceiling.test.ts`, `order-repository.test.ts` around
  line 1229) override `maxOrdersPerCycle` for their run and restore it, and
  `domain.test.ts` reads it, so 35 needs no test edit.
- E2e reads every limit off `Domain`: `plan.billing.spec.ts` identifies the
  plan by the orders tile's `max`, and the two members tests that seed past
  `MAX_ENTITLEMENTS.maxMembers` are deleted in Step 7. `home.spec.ts` only
  asserts the tiles mount. No e2e hard-codes 250, 1,000, 3, or 10.
- The seed goes through `upsertOrder`, which refuses a fresh order at the
  ceiling, and `deleteSeedOrders` gives the previous seed's count back
  first, so a re-seed of 28 fixture orders never trips 35 on its own.
- **The dev store has 88 real orders.** An orders sync counts each one that
  routes to a workflow, on top of the seed. If that reaches 35, syncing
  stops for the cycle and the operator console shows "Orders limited". That
  is the ceiling working, not a bug; record the count you saw in Deviations
  and ask the user whether to raise the number. Do not raise it yourself.

## 7. When to ask for a reset

Exactly once, at the top of Step 8, in one line. Nothing before it needs a
running server. If the user has already reset before you reach Step 8, say
so and go on.

## 8. Out of scope

- Reversal on removal. Decided no.
- Prices in the app. Decided none.
- Partner Dashboard edits. Done by the user.

## Deviations and issues

Record here anything done differently from the steps above, anything
skipped, and anything found to be wrong in this plan or the research. One
entry per item: what, why, and what the user should look at.

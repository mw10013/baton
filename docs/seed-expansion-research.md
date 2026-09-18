# Seed expansion: edge cases, multi-item orders, and scale

Research into expanding the development fixture (`e2e/fixture.ts`, posted by `pnpm seed` through
`src/routes/api.dev.seed.ts` to `ShopAgent.seedWorkflows` / `ShopAgent.seedOrders`) so that every
workflow and order edge case the code already handles is visible after one reseed, and so the
member queue and orders index can be felt at a realistic size.

Every code reference was checked against the tree on 2026-09-18.

**Status: research only. Nothing implemented.** Decisions taken during review are in §9.

## 1. What the fixture covers today

Nine members (`lead@m.com` on every team, `m1`…`m6` one per maker team, `m7` on two, `m8` on
none), seven teams (one empty), seven workflows, ten orders. Every order state the index can show
has one row: fresh, in progress, parallel stage ready, all items made, inspected, done and
unfulfilled, partial refund, blocked, unpaid, no workflow.

What it does **not** cover, in order of how much the code already supports it:

| Gap                                                                               | Code support | Fixture support                                           |
| --------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------- |
| Line item matching two workflows ("Choose a workflow")                            | full         | none                                                      |
| Order with many line items (5+)                                                   | full         | max 2                                                     |
| Line items on one order in different states                                       | full         | none: `advance`/`blocked`/`done` apply to the whole order |
| Cancelled order with open runs (`order_cancelled` flag)                           | full         | none                                                      |
| Fulfilled order with open runs (`order_fulfilled`, "Already shipped")             | full         | none                                                      |
| Item removed / quantity changed after runs started                                | full         | none (only pre-run partial refund)                        |
| Merchant intervention (`byMerchant`: "Done by Merchant", "Blocked by Merchant")   | full         | none                                                      |
| Manually attached run (`RunSource` = merchant)                                    | full         | none                                                      |
| Run on a workflow whose team was since emptied or deleted ("Deleted team" filter) | full         | none                                                      |
| Quantity > 1 with `currentQuantity` < `quantity` (edited order)                   | full         | none                                                      |
| Line item with null custom attribute value                                        | full         | none                                                      |
| Order with no line items                                                          | full         | none                                                      |
| Long strings (step instructions near limit, 1000-char block reason, long titles)  | full         | none                                                      |
| Volume: hundreds of queue cards, >25 orders (index pagination)                    | untested     | none                                                      |
| Workflow at `maxSteps` (20) or many parallel stages                               | full         | max 4 steps, max 3 wide                                   |
| Draft that changes a step's team while runs are open                              | full         | draft only adds a step                                    |

Multi-item orders exist (#1002, #1003, #1004) but never more than two items and never with the
items in different states, so the order summary line (`3 items · 1 blocked · 1 made · waiting on
…`, `src/routes/app.orders.$orderId.tsx:773-812`) is never exercised.

## 2. How routing works, as it constrains the fixture

- **Match rule** (`src/lib/WorkflowRunRepository.ts:161-200`): a workflow is _startable_ when it is
  on, has steps, and every step names a team that exists (an empty team does not block). A line
  item matches when `unfulfilledQuantity > 0`, one of its product tags equals the workflow's tag,
  and the order was placed at or after `activatedAt`.
- **Tags are unique per workflow** (`src/lib/ShopAgent.ts:493`). Ambiguity therefore needs one
  line item carrying two tags that two startable workflows claim.
- **Two or more matches ⇒ nothing starts** and the item is _ambiguous_
  (`WorkflowRunRepository.ts:1067-1084`). It is derived per read, never stored
  (`src/lib/Domain.ts:1631`). The orders index shows the warning badge **Choose a workflow** and a
  stage filter of the same name (`src/routes/app.orders.index.tsx:81-85, 142-155`); the order
  page limits the picker to the matched workflows and labels the button **Choose**
  (`app.orders.$orderId.tsx:1304-1322`). The queue shows nothing because no run exists.
- **One live run per line item**, `quantity = unitsToMake` snapshotted at insert. Never one run
  per unit.
- **Off / no-steps / unassigned workflows are not in `matchedWorkflowIds` at all.** Two claimants
  with one off ⇒ the survivor starts. Turning a workflow on back-fills every open paid order
  placed since `activatedAt` (`ShopAgent.ts:2536-2567`).
- **Drafts never route.** Apply swaps `WorkflowStep`; open runs keep their snapshotted steps.
- **Seeded orders are processed in array order, one second apart, at `now`**
  (`ShopAgent.ts:3856-3862`), so the index keyset order equals fixture order and the date rule
  never skips a seeded order.
- **Seed order pipeline** (`ShopAgent.ts:3893-3900`): upsert + reconcile, then `done`, then
  `advance` rounds, then `started`, then `blocked`. All operate on _every open run of the order_.

## 3. Proposed fixture additions

Naming conventions kept: product-realistic titles, tags equal the workflow name in tag form,
warning rows carry their reading in parentheses, members stay `lead@m.com` / `mN@m.com`, orders
number upward from `#1001` and read top to bottom as a day on the floor.

### 3.1 Members and teams

- Keep `lead@m.com` on every team, including new ones. The seed's `addMember` limit is
  `MAX_ENTITLEMENTS.maxMembers = 10` (`api.dev.seed.ts:167`, `Domain.ts:102`), and the fixture
  has 9. That number is provisional, not tuned; the fixture is never constrained by it. If a
  later fixture needs more members, raise the constant (or pass a seed-only ceiling), never trim
  the fixture.
- Add `m9@m.com` on the new **Rush** team (§3.2) so the cross-cutting queue has a dedicated
  persona as well as the lead.
- No new teams beyond Rush. `maxTeams = 25` is far off.

### 3.2 Workflows

| Workflow                     | Tag          | Shape                                                       | Purpose                                                                                                                                                                                                            |
| ---------------------------- | ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Rush order`                 | `rush`       | 2 steps: Expedite (Rush) → Pack rush (Finishing)            | Cross-cutting tag. Any product tagged `rush` as well as its own tag becomes ambiguous. Reads like a real merchant mistake: "rush" was meant as an order label, not a workflow.                                     |
| `Gift box (many steps)`      | `gift-box`   | 12 steps, four stages 3 wide then linear                    | Long workflow: editor layout, run card with many siblings, `stageCount` in the queue. Under `maxSteps = 20`.                                                                                                       |
| `Wall clock`                 | `wall-clock` | 3 steps, draft **moves** Engrave from Engraving to Woodshop | Draft that changes a team, so applying while runs are open shows runs keeping their snapshot. Existing blanket draft only adds a step.                                                                             |
| `Keychain (empty team step)` | `keychain`   | 2 steps, second on `Retired team (empty)`, **on**           | On and startable (empty team does not block), so its runs land on a team nobody is on: the "waiting on" list names a team with no members and the queue never shows the step. Distinct from Pet tag, which is off. |

Existing workflows stay as they are. `Photo frame` stays off so the no-match-because-off case
remains.

### 3.3 Orders

Grouped by what they show. Numbers continue from `#1011`.

**Ambiguity**

- `#1011` one item tagged `[signet-ring, rush]`: **Choose a workflow**, picker offers Signet ring
  and Rush order.
- `#1012` two items: a board tagged `[engraved-cutting-board, rush]` (ambiguous) and a plain
  journal (starts). Shows `multiple_workflows` outranking `in_production` on one order.
- `#1013` one item tagged `[engraved-cutting-board, rush]` **with a choice already made**: needs
  the per-item `workflow` override in §4 so the run exists with `source = merchant`. Reads as
  "1 active" with no warning, and the change-workflow modal shows the incumbent.

**Multi-item orders**

- `#1014` five items across five workflows, all fresh: five cards in five queues, summary line
  `5 items`.
- `#1015` four items in four states: board done, ring blocked, journal in progress, blanket not
  started. Needs §4. This is the order that makes the summary line and the per-item badges
  honest.
- `#1016` three units of the same board as three separate line items with different
  engravings, one of them `currentQuantity: 0` (removed after ordering): the `Removed` badge next
  to live siblings.
- `#1017` one item quantity 3, `currentQuantity: 2`, `unfulfilledQuantity: 2`: `× 2 to make (3
ordered)` where the edit happened before any run.
- `#1018` no line items: the `No line items.` order page and "No workflow" on the index.

**Post-start changes** (need §4 or seed ordering; see notes)

- `#1019` cancelled with a run one step in: `cancelledAt` set, run flagged `order_cancelled`.
  Needs a `cancelled: true` order flag applied _after_ progress (§4).
- `#1020` `fulfillmentStatus: "FULFILLED"` with a run one step in: `order_fulfilled`, "Already
  shipped in Shopify". Same mechanism: the status must be written after the run starts, because
  `reconcileOrder` exits early on a fulfilled order before creating anything.
- `#1021` quantity change after start: quantity 2, run started, then `unfulfilledQuantity: 1`:
  `quantity_changed` flag. Needs a two-phase write (§4).

**Merchant intervention**

- `#1022` `advance: 1, byMerchant: true`: "Done by Merchant" on a card.
- `#1023` `advance: 1, blocked: "…", byMerchant: true`: "Blocked by Merchant".

**Teams**

- `#1024` a keychain: run waiting on the empty team. Orders index "Waiting on" filter has a real
  team with nobody on it; the queue shows nothing to anyone.
- `#1025` a run on a step whose team was **deleted**: not expressible by the seed (steps name
  teams that must exist). Leave out; the "Deleted team" filter stays covered by e2e specs only.
  Noted as a known gap rather than faked.

**Text limits**

- `#1026` block reason at 1000 characters, a 200-character line item title, and a
  personalization value with a null (`customAttributes: [{ key: "Gift note", value: null }]`).

**Rush queue**

- `#1027`–`#1029` three plain `rush`-only items (a product that is _only_ a rush order) so the
  Rush team has an ordinary queue and `m9` is not empty.

### 3.4 Scale set (medium)

Target: a few hundred queue cards for `lead@m.com`, more than one index page, no reseed slower
than a few seconds. Every run is a real reconcile pass and every round is a repository write, so
the numbers are deliberately modest. Live-run cap is 5000 (`ShopLimits.maxLiveRuns`); this stays
under 300.

- `#2001` one order with **25 line items**, mixed products, all fresh: the biggest single order
  page and the largest "together" group on the queue. `maxLineItemsPerOrder = 250` applies to the
  bulk path only, not the seed.
- `#2002`–`#2041` forty generated orders, one or two items each, products cycled through the six
  maker workflows, progress cycled through `{}`, `advance: 1`, `advance: 1, started: true`,
  `advance: 2`, `done: true`. Generated by a helper in the fixture, not written by hand, so the
  shape reads as one line of intent.

Expected exposure, from the queue code (`src/routes/shop.$shop.index.tsx`,
`WorkflowRunRepository.ts:1434-1492`):

- `listQueue` has no `LIMIT`; only the **Up next** tier is capped at 10 with "Show all N".
  **Mine**, **In progress** and **Blocked** are uncapped, so `started: true` on many orders is
  what produces a long page.
- Per-team chip counts are recomputed client-side per render, O(items × teams).
- The whole queue refetches on every socket push (throttled ~2 s).
- Orders index pages at 25 (`ORDERS_PAGE_SIZE`); 40+ orders gives two pages plus stage-filter
  counts worth reading.

The scale set is always seeded, with no environment flag. The member UI is known not to scale
yet; the seed exists to show where it breaks and how it feels, and two fixtures would only
confuse which one a screen was judged against. Cost is reseed time, roughly 300 runs' worth of
writes, to be measured once implemented.

## 4. Seed schema changes needed

The fixture rows in §3.3 marked "needs §4" require `SeedOrdersInput` (`Domain.ts:1328-1372`) and
`ShopAgent.seedOrders` (`ShopAgent.ts:3734-3902`) to grow. The current design applies progress to
every open run of the order; mixed-state orders and post-start changes are unreachable.

Proposed, smallest change that reaches every row above:

1. **Per-line-item progress overrides.** Add to `lineItems[]` an optional `progress` object with
   the same keys the order already has (`done`, `advance`, `started`, `blocked`, `byMerchant`).
   When present it wins over the order-level values for that item's run. `seedOrders` already
   iterates runs per order; the change is to look up the override by `lineItemId` when choosing
   what to do with each run. Order-level keys keep their meaning for every item without an
   override.
2. **Explicit workflow choice.** Optional `workflow: WorkflowName` on a line item: after
   reconcile, call `setRun` with that workflow (source `merchant`). This seeds the
   already-chosen ambiguous item (#1013) and a manually attached run.
3. **Post-start order changes.** Optional order-level `then` block applied _after_ progress:
   `{ cancelled?: true, fulfillmentStatus?: string, lineItems?: { position, unfulfilledQuantity }[] }`.
   The seed re-upserts the order with the change and lets `afterWrite: reconcile` flag the runs
   exactly as a webhook would. Reusing `upsertOrder` keeps the invariant that seeded state is
   indistinguishable from synced state (`ShopAgent.ts:3723-3733`).
4. **Members past 10.** Not needed for the medium scale set. If ever needed, raise
   `maxMembers` or give the seed its own ceiling; the fixture is not shaped around the limit.
5. **One rule for `done` and `advance`.** The schema should refuse both on one order or one
   item (`Schema.filter`), rather than documenting that they do not combine while the code runs
   both. Today `done` first makes `advance` a silent no-op.
6. **Reconcile after `seedWorkflows`.** `replaceWorkflows` deletes runs and workflows but not
   orders, so a Playwright caller that reseeds workflows without `orders` leaves surviving orders
   with stale `matchedWorkflowIds` and no runs. `seedWorkflows` should end with
   `reconcileAllNow` so seeded state never diverges from what the ordinary path would produce.
   In scope: an e2e spec asserting against stale routing would be asserting against a corrupted
   world.

All new keys stay optional, so `onExcessProperty: "error"` still catches typos and existing
Playwright callers are unchanged.

## 5. Seed mechanics to fix alongside

- **`ordersThisMonth` climbs on every reseed and never refunds.** Each fresh paid seeded order
  increments `ShopUsage.ordersThisMonth` (`src/lib/OrderRepository.ts:439-460`); `deleteOrder`
  does not decrement (`:548-549`). With ~70 orders per seed the quota banner ("You've synced X of
  1000 orders this month") appears on `/app` after ~14 reseeds. Fix: `seedOrders` resets the
  counter to the number it is about to write, or subtracts what it deletes. Seed-only code path,
  so no production semantics change.
- **`seedWorkflows` bypasses `maxWorkflows` and accepts `active: true` with an unassigned step**
  (`src/lib/WorkflowRepository.ts:1014-1130`). The second yields a workflow shown as Active that
  routes nothing. The fixture avoids it by construction; the seed should refuse it the way the
  ordinary path does, so a future fixture cannot seed an impossible state.
- **`done` and `advance` on one order** are documented as not combinable (`Domain.ts:1342-1345`)
  but the code runs both. Fix in the schema (§4 item 5).
- **Reseeding workflows alone leaves stale `matchedWorkflowIds`** on surviving orders because
  `replaceWorkflows` deletes runs and workflows but not orders. `pnpm seed` always sends both, so
  today it only bites a Playwright caller that omits `orders`. Fix by reconciling at the end of
  `seedWorkflows` (§4 item 6).
- **Stale comment**: `app.orders.index.tsx:672-680` refers to an "order run", a concept the
  codebase no longer has. Remove when touching the index.

## 6. What the expanded seed will let us judge

- Whether **Choose a workflow** reads as an error to a merchant, and whether the order-page
  picker labelled Choose is discoverable from the index badge.
- Whether the queue's tier model (Blocked → Mine → In progress → Up next) holds when Mine and
  In progress have dozens of cards and no cap.
- Whether the per-team chips are enough grouping at 200+ cards, or whether the queue needs team
  sections, pagination, or virtualization.
- Whether the order summary line and per-item badges carry a five-item mixed-state order.
- Whether "waiting on an empty team" is visible enough on the index for a merchant to act.
- How long a reseed of ~70 orders and ~300 runs takes locally, which bounds how often anyone
  will actually run it.

## 7. Out of scope

- Real Shopify orders. Seeded orders exist only in the object's SQLite; a queue from real orders
  still needs sandbox products tagged by hand.
- Runs on deleted teams (#1025): the seed resolves steps by team name and cannot delete a team
  mid-fixture. Stays with e2e specs.
- Retention sweeps and webhook deliveries: no seed surface, unrelated to workflow edge cases.

## 8. Vocabulary

The fixture's comments and any new workflow or order names should avoid the terms
`Domain.ts:585-587` bans: version, live, saved, published, retired (as a state), applied (as a
state), route/routing, pause, "product tag". The existing `Retired team (empty)` is a team name,
not a workflow state, and stays.

## 9. Decisions and open questions

Decided on 2026-09-18:

- Scale set is **medium**: one 25-item order plus ~40 generated orders.
- Per-item progress overrides in `SeedOrdersInput` are **in scope** (§4).
- Ambiguity comes from a **new cross-cutting `Rush order` workflow**, not from overlapping
  existing product tags.
- Seed mechanics (§5) are covered here rather than in a separate doc.

- Scale set is **always seeded**, no flag. One fixture, one world.
- **`m9@m.com` is added** for Rush. Member, team and workflow limits are provisional numbers;
  a fixture that needs more raises the limit rather than shrinking.
- **§5 is all in scope**: the `ordersThisMonth` reset, the `seedWorkflows` guards, the
  `done`/`advance` rule, the reconcile after `seedWorkflows`, and the stale comment.
- **Post-start changes use a `then` block** on the order (§4 item 3). The problem it solves: a
  cancelled order, a fulfilled order, or a quantity change only produces the interesting flags
  (`order_cancelled`, `order_fulfilled`, `quantity_changed`) when the change lands _after_ a run
  exists, because reconcile on an already-cancelled or fulfilled order exits before creating
  anything. The seed therefore has to write the order twice: first as it was when the run
  started, then as it is now. Two ways to say that: (a) a `then` field on the fixture row
  holding the second state, applied by `seedOrders` after progress; or (b) a second HTTP call
  from `scripts/seed.ts` with a separate array of changed rows. (a) keeps one order's story on
  one fixture row, which is what makes the fixture readable, and Playwright specs get it for
  free. (b) avoids a schema change but a reader has to find `#1019` in two places to know what
  it shows. Recommendation and decision: (a).

No open questions remain.

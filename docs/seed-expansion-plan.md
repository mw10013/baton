# Seed expansion: implementation plan

Companion to `docs/seed-expansion-research.md`, which holds the reasoning and the decisions.
This document is the hand-off: an implementer with no other context should be able to work
through it top to bottom. Every path and line number was checked on 2026-09-18; line numbers
drift, symbol names do not.

Read `CLAUDE.md` first. In particular: JSDoc for anything subtle, never reference `docs/` from a
JSDoc, Effect idioms throughout, `pnpm fmt` after every change and keep every file it touches,
no commits unless told, `pnpm typecheck` and `pnpm lint` before declaring a step done.

Record every departure from this plan in §10 as you go, not at the end, and anything the work
is left standing around — a sharp edge kept, a number still open — in §11.

## 1. Outcome

After `pnpm seed`, one fixture (no flags) gives:

- every order and workflow edge case the code already handles, one row each, readable by name;
- the "Choose a workflow" state, produced by a new cross-cutting `Rush order` workflow;
- orders whose line items are in different states, cancelled or fulfilled after work started,
  or changed in quantity after work started;
- a 25-item order plus ~40 generated orders so the member queue and orders index run at a few
  hundred cards and more than one page;
- seed mechanics that cannot drift from the ordinary write path: usage counter reset on reseed,
  the same guards `replaceWorkflows` lacks today, a reconcile after workflows are replaced, and a
  schema that refuses `done` together with `advance`.

Playwright specs that call `seedMembers` keep working unchanged: every new key is optional.

## 2. Files

| File                                                                                            | Change                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/Domain.ts`                                                                             | Extend `SeedOrdersInput`; add `SeedLineItemProgress`, `SeedOrderThen`; schema filter refusing `done` + `advance`.                                              |
| `src/lib/ShopAgent.ts`                                                                          | `seedOrders`: per-item progress, explicit `workflow`, `then` phase, usage reset. `seedWorkflows`: reconcile after replace, refuse active with unassigned step. |
| `src/lib/WorkflowRepository.ts`                                                                 | `replaceWorkflows`: refuse `active` with a null `teamId` step; enforce `WorkflowLimits.maxWorkflows` / `maxSteps`.                                             |
| `src/lib/OrderRepository.ts`                                                                    | New `resetUsageOrders(count)` (or equivalent) for the seed.                                                                                                    |
| `src/routes/api.dev.seed.ts`                                                                    | Pass the new optional keys through; resolve `workflow` names to ids for `lineItems[].workflow`.                                                                |
| `e2e/seed.ts`                                                                                   | Mirror the new optional keys on `SeedLineItem` / `SeedOrder`.                                                                                                  |
| `e2e/fixture.ts`                                                                                | The expanded fixture (§6).                                                                                                                                     |
| `scripts/seed.ts`                                                                               | Unchanged except the summary line, if counts change shape.                                                                                                     |
| `test/integration/shop-agent-callables.test.ts`, `test/integration/workflow-repository.test.ts` | Tests for the new seed behaviour (§8).                                                                                                                         |
| `src/routes/app.orders.index.tsx`                                                               | Delete the stale "order run" comment near line 672.                                                                                                            |

## 3. Domain schema

`src/lib/Domain.ts`, `SeedOrdersInput` (currently at `:1328-1372`).

### 3.1 Per-line-item progress

Extract the order-level progress keys into a reusable struct and reuse it on line items:

```ts
/**
 * Seed progress for one run: `done` completes every step; `advance` completes
 * that many rounds of ready steps; `started` then Starts what is ready;
 * `blocked` flags the run. `done` and `advance` are exclusive: the seed runs
 * `done` first, which would make `advance` a silent no-op, so the schema
 * refuses the pair rather than document it.
 */
const SeedProgress = Schema.Struct({
  done: Schema.optionalKey(Schema.Boolean),
  advance: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  started: Schema.optionalKey(Schema.Boolean),
  byMerchant: Schema.optionalKey(Schema.Boolean),
  blocked: Schema.optionalKey(StepNote),
}).check(
  Schema.makeFilter((p) => !(p.done === true && p.advance !== undefined), {
    title: "done and advance are exclusive",
  }),
);
```

Use the Effect v4 filter API that the rest of `Domain.ts` already uses (search the file for an
existing `.check(` with a custom predicate and copy its form; `refs/effect/ai-docs/src/` has
the reference if none exists). Do not invent an API.

The order struct spreads `SeedProgress.fields` and keeps `n`, `fulfillmentStatus`, `unpaid`,
`note`, `lineItems`. The line item struct gains:

```ts
/** Overrides the order's progress for this item's run alone. */
progress: Schema.optionalKey(SeedProgress),
/**
 * Name of a seeded workflow to set on this item after reconcile, as the
 * merchant's Choose / Change would (`setRun`, source `manual`). Resolves an
 * ambiguous item or attaches where nothing matched. The seed route resolves
 * the name to an id; the Durable Object receives `workflowId`.
 */
workflowId: Schema.optionalKey(Schema.String),
```

Note the split: the fixture and `api.dev.seed.ts` speak workflow **names** (same reason steps
name teams: ids are minted by the seed moments earlier). `SeedOrdersInput` carries the id. The
route builds the name→id map from the `seedWorkflows` result, which means `seedWorkflows` must
**return** `{ name, id }[]`. Today it returns `void`; change it (§5.1).

### 3.2 Post-start changes: `then`

```ts
/**
 * Applied after every progress step, as a second `upsertOrder` with
 * `afterWrite: reconcile`, so the run flags the way a webhook would produce:
 * `order_cancelled`, `order_fulfilled`, `quantity_changed`, `item_removed`.
 * Written second on purpose: reconcile on an already-cancelled or fulfilled
 * order exits before creating runs, so the first write must be the order as
 * it was when work started.
 */
then: Schema.optionalKey(
  Schema.Struct({
    cancelled: Schema.optionalKey(Schema.Boolean),
    fulfillmentStatus: Schema.optionalKey(Schema.String),
    /** By 1-based position in `lineItems`. */
    lineItems: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          position: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
          currentQuantity: Schema.optionalKey(Schema.Number),
          unfulfilledQuantity: Schema.optionalKey(Schema.Number),
        }),
      ),
    ),
  }),
),
```

Update the JSDoc on `SeedOrdersInput` (`Domain.ts:1319-1326`) and on the order fields to
describe the phase order: reconcile → `workflowId` → progress → `then`.

## 4. `ShopAgent.seedOrders`

`src/lib/ShopAgent.ts:3734-3902`. Keep the existing helpers; change the per-order loop.

### 4.1 Phase order per order

1. **Upsert + reconcile** (unchanged).
2. **Explicit workflow.** For each line item with `workflowId`: load the workflow via
   `WorkflowRepository.getWorkflow`, the roster via `this.teams()`, and call
   `WorkflowRunRepository.setRun({ workflow, teams, order, lineItem, source: "manual" })`
   exactly as the attach callable does (`ShopAgent.ts:2735-2775`). Fail the seed loudly
   (`WorkflowRepositoryError`) if the workflow cannot start; a fixture naming an off workflow
   is a fixture bug. The line item comes from `OrderRepository.getLineItem` with the id
   `${orderId}/line-${position}` the seed just wrote.
3. **Progress.** Replace the four order-wide calls with a per-run dispatch. Load
   `listRunsForOrder` once; for each open run, pick `progress = lineItem.progress ?? order`
   (the order's own progress keys) by matching `run.lineItemId` to
   `${orderId}/line-${position}`; then apply `done` → `advance` → `started` → `blocked` to
   that run alone. The existing helpers take an `orderId` and act on every open run; refactor
   them to take a run (its `WorkflowRunDetail`) instead, reloading between rounds because a
   completed step changes what is ready. `advanceRound` per run is `seedReadySteps([detail])`.
4. **`then`.** Build a copy of the `Domain.ShopOrder` with `cancelledAt: now` when
   `cancelled`, `fulfillmentStatus` replaced when given, `updatedAt: now`, and line items with
   the overridden quantities merged by position. Call `orderRepository.upsertOrder` again with
   `afterWrite: reconcile(order)`. Nothing else: the flags come from reconcile.

### 4.2 Usage reset

`ShopUsage.ordersThisMonth` climbs by one per fresh paid seeded order
(`OrderRepository.ts:439-460`) and `deleteOrder` never decrements (`:548-549`). Add to
`OrderRepository` a seed-only method:

```ts
/** Seed only: the counter after a reseed is the seeded paid orders, not the sum of every reseed. */
readonly setUsageOrdersThisMonth: (count: number) => Effect.Effect<void, SqlError.SqlError>;
```

(`update ShopUsage set ordersThisMonth = ? where id = 1`.) `seedOrders` calls it **before** the
loop with `0`: the upserts then count each order up naturally, and the end state equals what a
single seed would have produced. Do not subtract on delete; the counter is a quota, not a
ledger, and only the seed knows the whole set is being replaced.

### 4.3 Logging

Keep the existing `ShopAgent.seedOrders: orderId=… runId=…: completed` form. Add one summary
log at the end: `ShopAgent.seedOrders: shop=… orders=N runs=N ambiguous=N` with annotations,
so a slow reseed is diagnosable from `logs/server.log`.

## 5. `seedWorkflows` and `replaceWorkflows`

### 5.1 Return ids and reconcile

`ShopAgent.seedWorkflows` (`ShopAgent.ts:3699-3720`): after `replaceWorkflows`, run
`this.reconcileAllNow("seedWorkflows", "seed")` so orders that survive a workflows-only reseed
(a Playwright caller omitting `orders`) are re-matched rather than left with stale
`matchedWorkflowIds` and no runs. Then return `readonly { name: WorkflowName; id: string }[]`
for the route to map names to ids. `replaceWorkflows` already mints the ids; return them.

Call order in `api.dev.seed.ts` stays workflows → orders, so this reconcile finds no seeded
orders on `pnpm seed` (they were deleted at the start of the previous `seedOrders`, and the
new ones are written after). It only matters for the workflows-only caller.

### 5.2 Guards

`WorkflowRepository.replaceWorkflows` (`WorkflowRepository.ts:1014-1130`, guards at
`:1060-1083`). Add, in the same style as the existing three:

- `active` with any step whose `teamId` is null → `WorkflowRepositoryError`
  `"an active workflow needs every step assigned"`. Mirrors `ActivateResult.StepUnassigned`.
- more than `WorkflowLimits.maxWorkflows` entries, or a workflow (or draft) with more than
  `WorkflowLimits.maxSteps` steps → `WorkflowRepositoryError` naming the limit. These are the
  ordinary path's limits (`Domain.ts:386-393`); the seed must not be able to exceed them.

The fixture's `active` default (on when every step is assigned) already satisfies the first.

## 6. The fixture

`e2e/fixture.ts`. Keep the file's voice: one comment per row saying what a person sees. Keep
`lead@m.com` on every team, including Rush.

### 6.1 Members and teams

- Add `m9@m.com`; add team `Rush` with `[LEAD, maker(9)]`.
- `MAX_ENTITLEMENTS.maxMembers` is 10 and the fixture will have 10. If a later row needs an
  eleventh, raise the constant in `Domain.ts` and note it in §10; the number is provisional.

### 6.2 Workflows (add four)

| Name                         | Tag          | Steps                                                                                                                                                                                             |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Rush order`                 | `rush`       | `Expedite` (Rush) → `Pack rush` (Finishing)                                                                                                                                                       |
| `Gift box (many steps)`      | `gift-box`   | 12 steps: stage 1 three wide (Woodshop, Textiles, Leather), stage 2 three wide (Engraving ×1, Jewelry, Finishing), then six linear steps alternating Finishing / Woodshop. Instructions on a few. |
| `Wall clock`                 | `wall-clock` | `Cut face` (Woodshop) → `Engrave numerals` (Engraving) → `Fit movement` (Finishing); `draft` moves `Engrave numerals` to Woodshop.                                                                |
| `Keychain (empty team step)` | `keychain`   | `Cut` (Leather) → `Attach ring` (`RETIRED_TEAM_EMPTY`); explicitly `active: true`.                                                                                                                |

Add the four tags to `TAG`. Names must be ≤ 64 characters (`NAME_MAX_LENGTH`).

### 6.3 Orders (add, numbered on from `#1011`)

Line item titles are free strings, not `Domain` names, so long ones are allowed.

| #         | Row                          | Fixture keys                                                                                                                                            |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1011      | ambiguous ring               | one item, tags `[ring, rush]`                                                                                                                           |
| 1012      | ambiguous plus routed        | board `[board, rush]`; journal `[journal]`                                                                                                              |
| 1013      | ambiguity resolved           | board `[board, rush]`, `workflow: "Engraved cutting board"`                                                                                             |
| 1014      | five fresh items             | board, journal, ring, blanket, wall clock; no progress                                                                                                  |
| 1015      | four states                  | board `progress: { done: true }`; ring `progress: { advance: 1, blocked: "…" }`; journal `progress: { advance: 1, started: true }`; blanket no progress |
| 1016      | three boards, one removed    | three board items; third `currentQuantity: 0, unfulfilledQuantity: 0`                                                                                   |
| 1017      | quantity edited before start | board qty 3, `currentQuantity: 2`                                                                                                                       |
| 1018      | no line items                | `lineItems: []`                                                                                                                                         |
| 1019      | cancelled after start        | ring, `advance: 1`, `then: { cancelled: true }`                                                                                                         |
| 1020      | shipped after start          | journal, `advance: 1`, `then: { fulfillmentStatus: "FULFILLED" }`                                                                                       |
| 1021      | quantity cut after start     | board qty 2, `started: true`, `then: { lineItems: [{ position: 1, unfulfilledQuantity: 1 }] }`                                                          |
| 1022      | done by merchant             | blanket, `advance: 1, byMerchant: true`                                                                                                                 |
| 1023      | blocked by merchant          | ring, `advance: 1, blocked: "…", byMerchant: true`                                                                                                      |
| 1024      | waiting on empty team        | keychain, `advance: 1`                                                                                                                                  |
| 1026      | text limits                  | board with 200-char title, `blocked` at exactly 1000 chars, custom attribute `{ key: "Gift note", value: null }`                                        |
| 1027–1029 | plain rush queue             | one item each, tags `[rush]`                                                                                                                            |
| 2001      | 25-item order                | generated: cycle the six maker tags, distinct personalization each                                                                                      |
| 2002–2041 | scale set                    | generated: 1–2 items each, progress cycled `{}`, `{advance:1}`, `{advance:1, started:true}`, `{advance:2}`, `{done:true}`                               |

`#1025` (run on a deleted team) is deliberately absent; see the research doc §3.3.

Write the generated rows with two small helpers in the fixture (`bigOrder(n)`,
`scaleOrders(from, count)`) and keep them below the hand-written list, so the day-on-the-floor
reading of `#1001`–`#1029` is not interrupted. Give every generated item a distinct
personalization (`Engraving: "Order 2007"`) so cards are tellable apart on the queue.

Update the fixture's header JSDoc: the persona list (`m9`), the ambiguity row, the scale set and
why it is always seeded, and the `then` / `progress` vocabulary.

### 6.4 `e2e/seed.ts` types

Add `progress?`, `workflow?` to `SeedLineItem` and `then?` to `SeedOrder`, with JSDoc matching
the Domain schema. `seedMembers` needs no change.

### 6.5 `api.dev.seed.ts`

- Add the new optional keys to `DevSeedInput`; `orders` currently reuses
  `Domain.SeedOrdersInput.fields.orders`, which now carries `workflowId` rather than a name, so
  define the route's order schema separately (as it already does for steps by team name) and map
  `workflow` → `workflowId` using the ids `seedWorkflows` returns. Unknown workflow name → 400
  naming order and item, in the style of the existing team error.
- Keep `onExcessProperty: "error"` on the Durable Object side.

## 7. Cleanups

- `src/routes/app.orders.index.tsx` ~`:672-680`: remove the reference to an "order run".
- `Domain.ts:1342-1345`: replace "the two are not combined" with the schema rule from §3.1.

## 8. Tests

Integration tests run under `pnpm test` (Vitest, workers pool). Extend the existing seed
coverage rather than adding files:

- `test/integration/shop-agent-callables.test.ts` (already exercises `seedOrders`):
  - per-item `progress` leaves sibling items untouched;
  - `workflowId` on a two-tag item creates one `manual` run and the order reads
    `in_production`, not `multiple_workflows`;
  - `then: { cancelled: true }` after `advance: 1` flags the active run `order_cancelled`;
  - `then` quantity cut flags `quantity_changed`;
  - reseeding twice leaves `ordersThisMonth` equal to the paid seeded count;
  - `done` + `advance` on one order is a schema error.
- `test/integration/workflow-repository.test.ts` (already exercises `replaceWorkflows`):
  active with unassigned step refused; over `maxSteps` refused; return value carries ids.
- `test/integration/shop-agent-workflows.test.ts` or the callables file: `seedWorkflows` after
  seeded orders re-matches them (stale `matchedWorkflowIds` gone).

Playwright: run `npm run test:e2e --` once at the end. The specs seed their own shapes and must
still pass; the shared fixture is not asserted by any spec.

## 9. Order of work and checks

1. §3 schema, §5.2 guards, §4.2 usage reset. `pnpm typecheck`, `pnpm lint`, `pnpm test`.
2. §4.1 seedOrders phases, §5.1 return + reconcile, §6.5 route. Same checks.
3. §6 fixture, §6.4 types, §7 cleanups. `pnpm seed` against a running `pnpm app:dev`; time it
   and record the duration in §10.
4. Open the app as the merchant and as `lead@m.com` (`refs`: playwright-cli usage in
   `CLAUDE.md`). Confirm by eye: **Choose a workflow** badge and filter with three orders;
   `#1015` summary line reads four states; `#1019`, `#1020` show the flag badges; Rush team
   queue for `m9`; lead's queue has hundreds of cards and the **Show all** button; orders index
   has a second page.
5. `pnpm fmt`, then `npm run test:e2e --`.
6. Fill in §10. Do not commit.

## 10. Deviations

Record here, as you go, anything done differently from the plan, anything that did not work,
and what was done about it. One entry per item, dated, with file references. Include measured
reseed time and the final counts (members, teams, workflows, orders, runs). Leave the section
in the file when done; it is the record the next reader needs.

**2026-09-18 — `then` is called `after`.** `oxlint`'s `unicorn(no-thenable)` is an error, not a
warning, and it fires on any object literal with a `then` key — `Domain.SeedOrdersInput`, the
route's schema, `e2e/seed.ts`, and every fixture row that used one. Renamed to `after`
everywhere; the phase and its reasoning are unchanged (`Domain.SeedOrderChange`).

**2026-09-18 — the reconcile moved from `seedWorkflows` to the end of `seedOrders`** (§5.1).
As specified it broke `e2e/member-queue.member.spec.ts:425` in the full suite, deterministically
and only there. Cause: `seedWorkflows` runs before the previous fixture's orders are deleted, and
a seeded order's `processedAt` is `now + index * 1000`, so the tail of a 13-order fixture is dated
up to twelve seconds in the future — past the _new_ workflows' `activatedAt`. The reconcile
therefore started runs on orders `seedOrders` was about to delete, and `deleteOrder` leaves runs
alone by design (`orders/delete` flags them instead), so those runs survived as queue cards
carrying their own snapshot of an order that no longer existed. Nothing could clear them and the
next spec's first card was one of them.

The reconcile now runs at the end of `seedOrders`, after the fixture's own orders are written, so
it only reaches the rows a seed does not own — synced orders, which is the case §5.1 was for.
`seedOrders` also deletes the runs of the seed orders it deletes (`ShopAgent.seedOrders`), which
is right on its own: a fixture row being replaced has no trail worth keeping. Full e2e suite
passes (39). `api.dev.seed.ts` calls both callables in order, so no caller loses the reconcile;
`seedWorkflows`'s JSDoc says so.

**2026-09-18 — the seed tests live in `test/integration/shop-agent-workflows.test.ts`**, not
`shop-agent-callables.test.ts` (§8). That file only enumerates the callable role gate; it has no
D1 or agent fixtures, while the workflows file already has `seedTeam` and the agent helpers. The
`done` + `advance` schema rule is covered in `domain.test.ts` instead, where a decode failure is a
value rather than an RPC rejection that vitest reports as an unhandled error. The re-match test
writes a synced order straight into the object's SQLite: a seeded order cannot play that part,
since `seedOrders` deletes every seeded row before it writes.

**2026-09-18 — `#1026`'s long strings are sliced, not spelled out.** `LONG_TITLE` and
`LONG_BLOCK_REASON` in `e2e/fixture.ts` are a sentence repeated and cut to exactly 200 and 1000
characters; a 1000-character literal in the fixture would bury the row it belongs to.

**2026-09-18 — review follow-ups.** Three changes after review of the work above:
`processedAt` is now `now + index`, a millisecond apart rather than a second, so the tail of the
fixture is never dated more than a blink into the future and the reconcile bug in the entry above
is unreachable rather than merely avoided. The usage counter is decremented by the paid seeded
orders being deleted rather than zeroed, so synced orders keep their share. Both the delete and
the decrement live in `OrderRepository.deleteSeedOrders` rather than as raw SQL in the agent;
`setUsageOrdersThisMonth` is gone.

**2026-09-18 — measured.** `pnpm seed` against a running `pnpm app:dev`: **471–519 ms** in the
object (`ShopAgent.seedOrders`), under 1.2 s wall including node start. Final counts: **10
members, 8 teams, 11 workflows, 69 orders, 119 runs**, 2 ambiguous items.

That is fewer runs than §1's "a few hundred cards": `lead@m.com`'s queue reads **All · 99**
(Engraving 32, Woodshop 31, Leather 22, Textiles 13, Finishing 12, Jewelry 12, Rush 1) with
Blocked · 7 and the **Show all** button, and the orders index pages at 25 with 69 orders. The
scale set is the §6.3 table as written (40 orders, one or two items each); raising it is
`scaleOrders(2002, N)` in `e2e/fixture.ts` and costs about 4 ms per order.

**2026-09-18 — checked by eye** through the embedded app and the member area (temporary specs,
deleted after):

- orders index stage filters: No workflow · 8, **Choose a workflow · 2**, In production · 51,
  Ready to ship · 11, Needs attention · 1; **Waiting on** lists Rush and Retired team (empty);
  page one holds 25 rows, so there is a second page.
- `#1015` summary line: `4 items · 1 blocked · 1 made · waiting on Engraving, Leather, Textiles`,
  with the four items reading Done, Blocked, In progress, Not started.
- `#1013` carries one run on Engraved cutting board and no warning, so the chosen workflow
  resolved the ambiguity; `#1011` and `#1012` are the two left asking.
- `#1024` reads `Step 2 of 2 · Attach ring · Retired team (empty)` with the no-members banner.
- `#2001` is 25 items, and the Gift box rows read `Step 1 of 8`.
- `lead@m.com`'s queue shows the `after` rows as flags: `#1019` cancelled, `#1020` "Fulfilled in
  Shopify.", `#1021` "From 2 to 1."; `#1023` reads "Merchant"; `m9@m.com` sees the Rush queue.

## 11. Left standing

Not deviations: things the work is done around, and what a reader should know before changing
them. Each names the decision it is waiting on, so nothing here lives only in a chat log.

**`deleteOrder` leaves `WorkflowRun` rows behind, and a run carries its own copy of the order name
and item title, so an orphan is a queue card nothing can clear.** That is correct for the webhook
path — `orders/delete` flags the runs rather than erasing the trail. The seed does not use
`deleteOrder`: `OrderRepository.deleteSeedOrders` removes seed orders, their line items, their runs
and their share of the usage counter in one transaction. The retention sweep deletes runs in its own
statement. It stays a sharp edge for any future third caller of `deleteOrder`.

**`seedWorkflows` on its own leaves stored orders matched against workflows it just deleted.** The
reconcile that repairs that is at the end of `seedOrders`, and `api.dev.seed.ts` always calls
both, in that order. A future caller reaching the Durable Object directly — an integration test,
a script — has to call both too, or reconcile itself. Said in the JSDoc on both callables; there
is no guard.

**The fixture now has exactly `MAX_ENTITLEMENTS.maxMembers` (10) members.** An eleventh persona
needs that constant raised (`Domain.ts`), which §6.1 already allows for; the point is that there
is no headroom left, so the next fixture row that wants a login hits it.

**The scale set is short of §1's "a few hundred cards".** Measured above: 99 ready cards for the
lead, 119 runs. It is enough to see the Up next cap, the team chips and a second index page, and
not enough to judge whether the queue's uncapped tiers hold. `scaleOrders(2002, N)` in
`e2e/fixture.ts` is the one number to change (about 4 ms per order); raising it past `#2041` also
moves the numbering the §6.3 table fixes, so it is a decision rather than a tweak.

**The generated rows' personalization key is `Personalization`, not `Engraving`.** The §6.3 table
said `Engraving: "Order 2007"`, which reads wrong on a blanket or a clock once the six products
are cycled. Hand-written rows keep the product's own key (`Engraving`, `Initials`, `Size`).

**`#1025` (a run on a deleted team) is still absent**, for the reason research §3.3 gives: the
seed resolves steps by team name and cannot delete a team mid-fixture. The state stays covered by
e2e specs only. A seed-only "delete this team after seeding" key would reach it; nobody has asked
for one.

# Usage metering: implementation plan

This plan carries out the decisions in `docs/usage-metering-research.md`. Read that doc first:
its diagrams and call trees explain how metering works today. This plan says what to change,
in what order, and how to know each step is done.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that enforces it or is the concept. Other
    sites `{@link}` it and do not restate it.
  - Each rule has a test whose title is the rule.
  - A spec change starts at the table row, then the code, then the pinned test.
  - JSDoc never cites files under `docs/`. This plan and the research doc will be deleted.
  - Use the glossary's words (`src/lib/Domain.ts`, top of file). Update the glossary in the same
    change as any rename.
  - Do not commit unless the user says so. You are in linked worktree `wt-01`; never check out
    `main`.
- No migrations while prototyping: if a table changes, edit the schema in place
  (`initializeSchema` in `src/lib/ShopAgentSchema.ts`). No step below should need a schema change.
- After each phase run: `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`,
  `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written in [Deviations and issues](#deviations-and-issues)
  as you go, not at the end.

## Naming: app subscription

Shopify's words: a **pricing plan** is what the app defines in the Partner Dashboard (Basic,
Pro); an **app subscription** (Shopify's `AppSubscription` type) is one shop's purchase of a
plan, with its own trial, billing cycle, meter counts and status. A plan change ends one app
subscription and starts another. Baton uses both words the same way.

`Domain.ActiveSubscription` is renamed **`AppSubscription`**, and the glossary word is
**"app subscription"**. Not `Subscription`: `Domain.Subscription` already exists, and is the
live-query subscription a socket registers (used by `ShopAgent`, `ShopAgentClient`,
`useSubscribedQuery`). "Subscription" alone stays that concept's word; the billing one is always
"app subscription".

## Phase 1: vocabulary

Goal: every billing word used in code is in the glossary, and there is one word per idea.

### 1.1 Glossary rows

In the glossary JSDoc at the top of `src/lib/Domain.ts`, add a new table after the Nouns table,
introduced by a paragraph whose first line starts with `Billing.` (the checker in
`scripts/lib/spec.ts` finds glossary tables by that first line; a new name is not checked against
a label constant, so nothing else needs to change there).

| word             | meaning                                                                      | symbol                                          | screen                         |
| ---------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| plan             | the App Pricing tier a shop buys                                             | `Plan`, `PlanHandle`                            | (none): the Manage plan button |
| app subscription | one shop's purchase of a plan, as the Partner API reports it; one or none    | `AppSubscription`                               | (none)                         |
| billing cycle    | one month of an app subscription; both meters start at zero                  | `ShopUsage` fields `cycleStartAt`, `cycleEndAt` | billing cycle                  |
| trial            | the days before an app subscription's first billing cycle; nothing is billed | `AppSubscription` field `cycleStartAt` null     | (none)                         |
| meter            | a counter Shopify keeps per app subscription                                 | `USAGE_METER_ORDER`, `USAGE_METER_MEMBER`       | (none)                         |
| counted order    | an order Baton started a run for; one unit, once                             | `ShopOrder` field `countedAt`                   | "Orders this billing cycle"    |
| seat             | one unit of the members meter; a cycle's seats are its highest roster size   | `ShopUsage` field `membersHighWater`            | (none): members                |
| included         | a plan's $0.00 first tier on a meter                                         | `Entitlements`                                  | included                       |
| usage event      | one report of units to Shopify, queued until Shopify accepts it              | `UsageEvent`                                    | (none)                         |
| dead event       | a usage event dated before the current billing cycle; never sent             | `usageEventIsDead`                              | (none)                         |

Rules for the table:

- Every backticked identifier in the glossary must occur elsewhere in `Domain.ts`, or
  `pnpm spec check` fails (`checkGlossary`). Check `countedAt` and `membersHighWater` are
  mentioned outside the glossary; they are today.
- Follow the paragraph with two or three sentences: "billing cycle" is the word on screens and
  in code; "provisional cycle", "high-water mark" and "boundary" are JSDoc terms on their own
  symbols, not glossary words.

### 1.2 Rename `ActiveSubscription` to `AppSubscription`

- `src/lib/Domain.ts`: the schema and its type.
- Every use: `src/lib/ShopifyPartner.ts`, `src/lib/OrderRepository.ts`,
  `test/integration/subscription-plan.test.ts` (about 20 occurrences; `grep -rn ActiveSubscription src test`).
- Keep `ShopifyPartner.activeSubscription` (the method) as it is: it names Shopify's query,
  whose "active" means the app subscription in force now, as opposed to the shop's past ones.
  Say so in one line on the method's JSDoc.
- Keep the `SubscriptionPlan` service name: it resolves the shop's plan from its app
  subscription. Its JSDoc says "app subscription" where it means one.

### 1.3 "contract" → "app subscription"

"Contract" appears about 68 times across `src/`. Replace it only where it means the App Pricing
app subscription. Leave any other sense alone (for example a function's contract). Files to
review: `SubscriptionPlan.ts`, `ShopifyPartner.ts`, `ShopifyAppEvents.ts`, `Domain.ts`,
`OrderRepository.ts`, `ShopAgent.ts`, `ShopAgentClient.ts`, `Repository.ts`, `worker.ts`,
`routes/app.tsx`, `routes/admin.shop.$shop.tsx`, `wrangler.jsonc` comments. Where "the
contract" reads better as "the plan", use "the plan".

### 1.4 "billing period" → "billing cycle"

Screen copy and tests:

- `src/components/QuotaBanners.tsx`: "…this billing period." → "…this billing cycle."
- `src/routes/app.index.tsx`: heading "Orders this billing period".
- `src/routes/admin.shop.$shop.tsx`: label "Orders this billing period".
- `src/lib/ShopAgent.ts` (`syncOrders` error): "…orders a billing period; importing resumes
  when the period ends." → "…orders a billing cycle; importing resumes when the billing cycle
  ends."
- `e2e/home.spec.ts`, `e2e/plan.billing.spec.ts`: the label strings, and the comment near
  `plan.billing.spec.ts` line 151 that explains a text match.
- `README.md`: the home page section and the Billing section ("Avoid 'a month' — the period is
  the billing cycle…" already says it).

JSDoc and comments: every "billing period" in `src/` and `test/`
(`grep -rn "billing period" src test e2e README.md`), including the test title
`"opens a provisional cycle before a billing period is known"` → `"…before a billing cycle is
known"`. If a data-model or spec table pins that title, change both together.

Then add "billing period" to the retired words: `RETIRED` in `scripts/lib/rules-lint.ts`, with
the comment style the other entries use. Run `node scripts/copy-audit.ts` to confirm no screen
string still says it.

**Done when:** `pnpm lint` passes, `grep -rn "billing period" src e2e` returns nothing,
`grep -rn ActiveSubscription src test` returns nothing, and the e2e specs that name the heading
pass (`npm run test:e2e -- e2e/home.spec.ts e2e/plan.billing.spec.ts`; if the dev server is not
running, record it under Issues rather than skipping silently).

## Phase 2: the spec

Goal: one table states what every trigger does to the counts and the queue, parsed by
`pnpm spec check`, each row naming its test.

### 2.1 The triggers table on `ShopUsage`

Put this table in the JSDoc on `ShopUsage` in `src/lib/Domain.ts`. Keep the existing prose that
explains why counting is by billing cycle; move per-field detail to the fields.

Header: `trigger | order count | seat mark | queue | pinned by`.

| trigger                                  | order count | seat mark         | queue                                                          | pinned by                                                                                                                      |
| ---------------------------------------- | ----------- | ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| first run on an order                    | +1          | —                 | +1 order event, then sent                                      | an order is counted once, when its first run is created                                                                        |
| another run on a counted order           | —           | —                 | —                                                              | a re-sync never queues a second count                                                                                          |
| run on a seeded order                    | —           | —                 | —                                                              | a seeded order is never counted                                                                                                |
| member added, roster above the mark      | —           | → roster          | +1 seat event (the rise), then sent                            | an add past the high-water mark queues one seat event and raises the mark                                                      |
| member added, roster at or below mark    | —           | —                 | —                                                              | (write the test in 2.3)                                                                                                        |
| member removed                           | —           | —                 | —                                                              | (write the test in 2.3)                                                                                                        |
| first count past the cycle end           | recounted   | → 0               | —                                                              | rolls the cycle forward on the first order past its end                                                                        |
| cycle pushed, same start                 | —           | → roster if above | +1 seat event (the rise)                                       | an unchanged cycle raises the mark to a roster past it, so an add whose recordRoster failed is billed at the next revalidation |
| cycle pushed, new start                  | recounted   | → roster          | seat events in the cycle dropped; +1 seat event (whole roster) | a new cycle resets the mark to the roster and queues it as the cycle's first seat event                                        |
| cycle pushed, shop never addressed       | recounted   | → roster          | every event before the start dropped                           | the first billing cycle discards events queued before the shop could be addressed                                              |
| revalidation during a trial              | —           | —                 | —                                                              | (write the test in 2.3)                                                                                                        |
| Shopify accepts an event                 | —           | —                 | row deleted                                                    | flush deletes accepted events and keeps refused ones with the error                                                            |
| Shopify refuses an event                 | —           | —                 | `attempts` +1, `lastError` set                                 | flush deletes accepted events and keeps refused ones with the error                                                            |
| an event's billing cycle ends unsent     | —           | —                 | row is dead; kept, never sent                                  | a queued event is dead once the cycle that dated it has ended: skipped by the flush and reported apart                         |
| retention sweep, dead event over 60 days | —           | —                 | row deleted                                                    | (Phase 4.4)                                                                                                                    |

Cell words: `—` means unchanged. Use exactly the words above in the order-count and seat-mark
columns (`+1`, `—`, `recounted`, `→ 0`, `→ roster`, `→ roster if above`), so the parser can
check them. The queue column is free text.

The "then sent" in the first and fourth rows is only true after Phase 4.1. Write the rows as
the code will be when this plan is done; the pinned tests for them are added in Phase 4.1.

Under the table, state three assumptions the rows rely on, each one sentence:

1. A billing cycle starts where the previous one ended. The seat mark's same-start check depends
   on it. A plan change starts a new app subscription with its meters at zero, where sending
   the roster again is correct billing.
2. Billing cycles are a month or less. The recount (`countedSince`) is wrong for a longer cycle.
   The Partner Dashboard offers usage meters on monthly plans only.
3. A trial's counted orders count toward `ShopLimits.maxOrdersPerCycle`. Decided, not an
   oversight: the ceiling is provisional, and the first billing cycle recounts them out and
   clears the refusal.

### 2.2 Parse and check it

In `scripts/lib/spec.ts`:

- Add `parseTriggerTable(source)` next to `parseDataModel`, reading the first table in the JSDoc
  on `ShopUsage` with the header above (use `firstTable` and `cellsOf`, as `parseDataModel`
  does). Fail on: wrong cell count, empty trigger, an order-count or seat-mark word outside the
  lists above, an empty pinned-by.
- Generalise `checkPinned` to take rows of `{ line, pinnedBy }` so both tables use it. Keep the
  `(none yet)` escape (`NONE_YET`), but the goal of this plan is to leave no row at `(none yet)`.
- In `scripts/spec.ts`, call both from `checkCommand`, and add the table to `printCommand`.
- Update the header comment of `scripts/spec.ts` and the description string of `check` to name
  the new table.
- Update `AGENTS.md`: the paragraph listing the spec tables gains one sentence naming the
  triggers table on `ShopUsage`.
- In `test/integration/spec.test.ts`, where `parseDataModel` is tested,
  add the same kind of test for `parseTriggerTable`: a bad word in a count
  column is refused.

### 2.3 Tests for the rows that have none

In `test/integration/order-repository.test.ts`, inside `describe("OrderRepository usage")`, add:

- `"an add at or below the high-water mark queues nothing"`
- `"a member removal leaves the seat mark and queues nothing"`. There is no removal call on the
  object; the test is that `recordRoster` with a smaller size changes nothing.

In `test/integration/subscription-plan.test.ts`:

- `"a revalidation during a trial pushes no billing cycle"`: stub the Partner response with
  `currentBillingCycle: null` and `trialEndsAt` set; assert `setBillingCycle` was not called.
  Follow how the file already stubs `ShopifyPartner` and `ShopAgentClient`.

Put each title into its table row.

### 2.4 The data-model table

In `initializeSchema`'s table (`src/lib/ShopAgentSchema.ts`), the `UsageEvent` row is
`(none yet)`. Pin it to `"counting an order queues one usage event"` if that test asserts one
row per key; otherwise add a test titled with the rule. Add one row:

| `UsageEvent` | a dead event is kept for 60 days after its billing cycle ends, then deleted | app | (Phase 4.4 title) |

**Done when:** `pnpm spec check` parses the triggers table, `pnpm spec print` shows it, every
row's pinned-by names a real test, and `pnpm test` passes.

## Phase 3: align the JSDoc

Goal: each rule is stated once. The triggers table is the summary; the symbols below state their
own rule and link to the table (`{@link ShopUsage}`) instead of re-telling what happens elsewhere.

Work through this list. For each: read it, cut sentences that restate another symbol's rule,
replace them with a link, fix "contract"/"billing period" if Phase 1 missed any, and keep the
reasoning that is only true here.

| symbol                                                                                            | file                          | what to do                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ShopUsage` and its fields                                                                        | `Domain.ts`                   | Holds the table. Field docs say what the field is; `ordersThisCycle` links `countOrder`, `membersHighWater` links `seatEventValue`.                                                           |
| `AppSubscription`                                                                                 | `Domain.ts`                   | Keep the trial/boundary explanation and the 2026-09-22 measurement. Use "app subscription".                                                                                                   |
| `BillingCycleInput`, `RecordRosterInput`, `ReconcileUsageInput`                                   | `Domain.ts`                   | One sentence each on who sends it and why it is plain RPC. Link the table row for what it does.                                                                                               |
| `provisionalCycleStart`                                                                           | `Domain.ts`                   | Keep. Say it is the stand-in until the first `setBillingCycle`.                                                                                                                               |
| `UsageEvent`, `usageEventIsDead`                                                                  | `Domain.ts`                   | Add the 60-day deletion (after Phase 4.4) to `usageEventIsDead`.                                                                                                                              |
| `seatEventValue`, `meterDiverges`                                                                 | `Domain.ts`                   | Already rules. Check wording only.                                                                                                                                                            |
| `Entitlements`, `ENTITLEMENTS`                                                                    | `Domain.ts`                   | Use "included" and "seat" as the glossary defines them.                                                                                                                                       |
| `orderIsSeeded`                                                                                   | `Domain.ts`                   | After Phase 4.3: rewrite to say the seed marks its orders counted, or delete it if nothing uses it.                                                                                           |
| `countOrder`, `currentCycle`, `countedSince`                                                      | `OrderRepository.ts`          | `countOrder` is the rule's owner: keep. `currentCycle`: link the table's "first count past the cycle end" row. `countedSince`: keep the monthly-only reasoning, link assumption 2.            |
| `setBillingCycle`, `recordRoster`, `reconcileUsage`, `flushUsageEvents`                           | `OrderRepository.ts`          | Each keeps its own mechanics; cut sentences that describe other methods.                                                                                                                      |
| `setBillingCycle`, `recordRoster`, `reconcileUsage`, `flushUsageEvents`, `getUsage`               | `ShopAgent.ts`                | These are thin RPC wrappers. One or two sentences each, linking the `OrderRepository` method. Keep why each is plain RPC.                                                                     |
| the same methods                                                                                  | `ShopAgentClient.ts`          | Same.                                                                                                                                                                                         |
| `SubscriptionPlan`, `revalidate`, `planHandleExpiresAt`, `PLAN_HANDLE_MAX_AGE_MS`, `expectChange` | `SubscriptionPlan.ts`         | `PLAN_HANDLE_MAX_AGE_MS`: after Phase 4.5 the daily cron, not a page load, is what bounds a quiet shop; say so. `expectChange`: add the flush (Phase 4.2).                                    |
| `ShopifyPartner.activeSubscription`, `meterQuantity`                                              | `ShopifyPartner.ts`           | "app subscription" wording; one line on why the method keeps Shopify's name.                                                                                                                  |
| `ShopifyAppEvents`                                                                                | `ShopifyAppEvents.ts`         | Wording only.                                                                                                                                                                                 |
| `QuotaBanners`                                                                                    | `components/QuotaBanners.tsx` | Wording only.                                                                                                                                                                                 |
| the home page route component                                                                     | `routes/app.index.tsx`        | Decision 9: add to the JSDoc that the Members tile shows the roster, not the billed seats (`ShopUsage.membersHighWater`), and that they differ only after a removal in a cycle. No UI change. |
| `addMemberFn`                                                                                     | `routes/app.members.tsx`      | Link `recordRoster`; cut restated seat rules.                                                                                                                                                 |
| `README.md` Billing section                                                                       | `README.md`                   | Keep the Partner Dashboard setup. Replace the metering explanation bullets with one sentence pointing at `ShopUsage` in `src/lib/Domain.ts`.                                                  |

**Done when:** no JSDoc in the list restates a rule another symbol owns, `pnpm lint` passes, and
`grep -rniw contract src` shows only non-billing senses.

## Phase 4: behaviour fixes

One sub-phase at a time. Each starts at its triggers-table row (already written in Phase 2),
then the code, then the pinned test. Run the checks after each.

### 4.1 Send the queue after every path that creates a run

Today the queue is sent after a webhook's order sync, a bulk import, a member add, a
revalidation, and the uninstall webhook. These run-creating paths do **not** send it:

- `ShopAgent.merchantAttachWorkflow`: the merchant's Attach and Change workflow.
- `ShopAgent.resyncOrder`: the merchant's Resync on the order page. It reconciles the one order.
- The workflow edits that reconcile every open, paid order (`RunRepository.reconcileAll`):
  `updateWorkflowTag`, `applyDraft`, `setWorkflowActivatedAt` (through `reconcileAllIfActive`,
  skipped when the workflow is off), and `setWorkflowActive` (Turn on and Turn off),
  `applyAndActivate` and `removeWorkflow` (always). Turn off and delete create runs too: an
  item two on workflows matched has no run, and when one of them leaves, the other's run starts.

Confirm the list by tracing every caller of `RunRepository.insertRun` up to a callable or RPC
method. For each that does not flush, send the queue after the write commits, with the
module-level `flushUsageEvents(shop)` helper in `ShopAgent.ts` (it logs and never fails). Use
`Effect.ensuring` as the bulk import does, so a failed write still sends what it queued.

Never flush inside a transaction.

Tests (in `test/integration/shop-agent-callables.test.ts` or next to the existing attach
tests; follow how the file stubs `ShopifyAppEvents`):

- `"attaching a workflow sends the usage event it queued"`
- `"turning a workflow on sends the usage events for the orders it counted"`
- `"resyncing an order sends the usage event it queued"`

Pin them on the triggers table's "first run on an order" row. If one pinned-by cell cannot hold
two titles, add a row "first run on an order, from a workflow edit" with the second.

### 4.2 Send the queue on Manage plan

`SubscriptionPlan.expectChange` (called by the Manage plan button's server function before it
leaves the app) already has `ShopAgentClient`. After it shortens the cache deadline, call
`shopAgentClient.flushUsageEvents(shop)`, ignoring failure with a logged warning like the other
best-effort calls in `revalidate`.

Order matters: shorten the deadline first. The button waits at most 1.5 s
(`PREPARE_MANAGE_PLAN_WAIT_MS` in `ManagePlanButton.tsx`) before opening the pricing page.
If the flush makes the request longer than that, the page still opens. Record under Issues
whether the Worker finishes the flush after the browser navigates away. If it does not, use the
request's `waitUntil` (check how `worker.ts` exposes the execution context) and record that.

Test in `test/integration/subscription-plan.test.ts`:
`"Manage plan sends the usage queue before the plan can change"`.

Add a triggers-table row: `Manage plan pressed | — | — | sent | <title>`.

### 4.3 Take the seed check out of `countOrder`

Seeding runs only when `ENVIRONMENT` is `local` (`/api/dev/seed`, and `ShopAgent.seedOrders`).
Today `countOrder` returns early for a seeded order id. Move that to the seed:

1. Add an `OrderRepository` method used only by the seed, for example
   `markSeedOrdersCounted(orderIds)`, that sets `countedAt = 0` where `countedAt is null`. Zero
   is before every billing cycle, so `countedSince` never counts it and the `countedAt is null`
   check in `countOrder` skips it.
2. In `ShopAgent.seedOrders`, call it for each seeded order after `upsertOrder` stores the row
   and before reconcile creates its runs. Today reconcile runs inside `upsertOrder`'s
   `afterWrite`; put the mark at the start of that `afterWrite` so it is in the same
   transaction.
3. Remove `if (Domain.orderIsSeeded(orderId)) return;` from `countOrder`.
4. Update `orderIsSeeded`'s JSDoc, or delete it and its test if nothing else uses it.
   `SEED_ORDER_ID_PREFIX` stays.
5. Keep the test `"a seeded order is never counted"`, now through the seed path. Update the
   data-model row in `initializeSchema` ("…a seed order is never counted") only if its wording
   no longer matches.

Check: `pnpm seed` twice in a row leaves the home page's order count unchanged. If you cannot
run the dev server, record it under Issues.

### 4.4 Delete dead events after 60 days

1. Add `deadUsageEventRetentionDays: 60` to `ShopLimits` in `Domain.ts`, with a one-line doc
   in the style of `webhookDeliveryRetentionDays`.
2. Delete `UsageEvent` rows where `occurredAt < cycleStartAt` (dead) and
   `occurredAt < now − 60 days`, at most `ShopLimits.sweepBatch` per pass. Put it in
   `OrderRepository.sweepExpiredOrders` or a sibling that the same two callers run (the bulk
   import and the webhook path's every-6-hours sweep). Say in its JSDoc why 60: it covers the
   billing cycle the event died in and the next, and each failed send was logged when it
   happened.
3. Update `usageEventIsDead`'s JSDoc and `ShopUsage.deadUsageEvents`' doc: the count is now
   "dead events from the last 60 days".
4. Test: `"the retention sweep deletes dead usage events older than 60 days and keeps younger ones"`.
   Pin it on the triggers-table row and the data-model row from 2.4.

### 4.5 A daily re-read for shops nobody opens

1. In `wrangler.jsonc`, add a cron trigger, once a day (for example `"17 4 * * *"`), for the
   top-level config and every `env`. Check in
   `refs/cloudflare-docs/src/content/docs/workers/` whether `triggers` is inherited by `env`
   blocks; if not, repeat it in each.
2. In `src/worker.ts`, add a `scheduled` handler to the default export, running an Effect with
   the same layers `fetch` uses. It lists every `ShopSession` whose `planHandleExpiresAt` is
   null or not after now, and calls `SubscriptionPlan.refresh` for each with bounded
   concurrency (for example 4). One shop's failure is logged and does not stop the others.
   Log one summary line: `scheduled.revalidatePlans: shops=<n> failed=<m>`.
3. Add the D1 query as a `Repository` method, for example `listShopsWithStalePlan(now)`. Check
   whether `ShopSession` has an index that serves it; D1 tables are small per install, so a scan
   is acceptable, but say so in its JSDoc.
4. `refresh` pushes `setBillingCycle` and `reconcileUsage`, which send the queue. Nothing else
   is needed for the Durable Object.
5. JSDoc on the handler states the rule: every installed shop re-reads its plan at least once a
   day, whether or not anyone opens the app. Update `PLAN_HANDLE_MAX_AGE_MS`' reasoning (the
   daily cron is now what bounds a quiet shop).
6. Test: `"the daily check re-reads every shop whose cached plan is stale, and only those"`.
   Write it against an exported Effect (the handler's body), not the `scheduled` export itself,
   so it runs in the existing test setup. Add a row to the triggers table: `daily check, plan
stale | as a cycle push | as a cycle push | as a cycle push | <title>` — or, if that does not
   fit the column words, state the rule on the handler and add a data-model row on `D1_TABLES`
   (`shop | every shop re-reads its plan at least daily | app | <title>`). Record which.
7. Local check: find in `refs/workers-sdk` how to trigger a scheduled event under the Vite
   plugin (`/cdn-cgi/handler/scheduled` on Wrangler dev). Run it once against the dev store and
   read `logs/local-worker.log` for the summary line. Record the result under Issues if it
   cannot be run.

## Phase 5: final checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`.
- `pnpm spec print`: the triggers table is shown with every row pinned.
- `npm run test:e2e --` (at least `e2e/home.spec.ts` and `e2e/plan.billing.spec.ts`).
- `pnpm graphql-codegen` only if a `#graphql` string changed (none should).
- Re-read the triggers table against the research doc's diagrams. Every arrow in "What
  `setBillingCycle` does" and "Which cycle a count lands in" has a row.
- Fill in the summary at the top of Deviations and issues.

## Deviations and issues

Record here as you go. One entry per item. A deviation is anything done differently from this
plan. An issue is anything found that the plan did not cover, or a step that could not be
completed or verified.

**Summary**: all five phases done. `pnpm typecheck`, `pnpm lint` (with `pnpm spec check`),
`pnpm test` (30 files, 524 tests) and `pnpm fmt` pass. `pnpm spec print` shows the triggers
table with every row pinned. `e2e/home.spec.ts` passes against the dev server; a reseed left the
home page's order count unchanged (2 before, 2 after); the local cron trigger logged
`scheduled.revalidatePlans: shops=0 failed=0`. `e2e/plan.billing.spec.ts` passes after
fixing a stale label (issue 1).

### Deviations

| #   | phase/step | planned                                                                                                                                                                            | done instead                                                                                                                                                                                                                                                                 | why                                                                                                                                                                                    |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 1.2        | rename every `ActiveSubscription`                                                                                                                                                  | kept the Partner API operation name `query ActiveSubscription(...)` in `ShopifyPartner.ts`                                                                                                                                                                                   | it names Shopify's `activeSubscription` query, like the method; renaming it changes a GraphQL string for no reader's benefit                                                           |
| 2   | 1.3        | "contract" → "app subscription" in `src/`                                                                                                                                          | also renamed the `contract(...)` test helper in `subscription-plan.test.ts` to `appSubscription(...)`, and fixed `README.md`'s Billing bullets and a leftover `Domain.ActiveSubscription` there                                                                              | same concept, same word                                                                                                                                                                |
| 3   | 1.4        | retire "billing period" in screen copy                                                                                                                                             | also relabelled the admin shop page's "Billing period" field to "Billing cycle" (and its e2e label list); kept "Billing period" in the README's Partner Dashboard field table                                                                                                | the admin label is Baton's copy; the README row is the Partner Dashboard's own field name                                                                                              |
| 4   | 1.4        | add "billing period" to `RETIRED`                                                                                                                                                  | added it with a row in the pattern table and a test, "billing period is a retired word in screen copy"                                                                                                                                                                       | each rule has a test                                                                                                                                                                   |
| 5   | 2.1        | one "first run on an order" row pinned to the counting test                                                                                                                        | kept that row (queue `+1 order event`) and added three rows "…, from Attach", "…, from a workflow edit", "…, from Resync", each pinned to its 4.1 test; added "first count, no cycle stored yet" (the provisional-cycle arrow in the research doc) and "Manage plan pressed" | one title per cell; every arrow in the research diagrams has a row                                                                                                                     |
| 6   | 2.3        | write "an add at or below the high-water mark queues nothing", "a member removal leaves the seat mark and queues nothing", "a revalidation during a trial pushes no billing cycle" | pinned the existing tests "an add at or under the high-water mark queues nothing", "a member removal queues nothing and leaves the mark", "pushes no billing cycle during a trial, which has none"                                                                           | they already assert exactly those rules                                                                                                                                                |
| 7   | 2.4        | pin the `UsageEvent` row to "counting an order queues one usage event"                                                                                                             | added "a usage event is one row per idempotency key, kept until Shopify accepts it"                                                                                                                                                                                          | the counting test does not show the key is unique or that a refused row stays                                                                                                          |
| 8   | 2.4        | new row "kept for 60 days after its billing cycle ends"                                                                                                                            | "a dead usage event is kept until 60 days after it was dated, then deleted"                                                                                                                                                                                                  | the sweep ages on `occurredAt`, as 4.4 specifies; the row says what the code does                                                                                                      |
| 9   | 4.1        | flush after each run-creating callable                                                                                                                                             | `reconcileAllNow` sends the queue (`Effect.ensuring`), which covers every workflow edit and the seed; `merchantAttachWorkflow` and `resyncOrder` send it with `Effect.ensuring`                                                                                              | one site for the six workflow edits instead of six                                                                                                                                     |
| 10  | 4.1        | test "resyncing an order sends the usage event it queued"                                                                                                                          | "resyncing an order sends the usage queue, even when the resync fails"                                                                                                                                                                                                       | the Admin API fetch cannot be stubbed in the test isolate (`@shopify/shopify-api` captures `fetch` at import); the test pre-queues an event and shows the failed resync still sends it |
| 11  | 4.1        | tests stub `ShopifyAppEvents`                                                                                                                                                      | new file `test/integration/shop-agent-usage-flush.test.ts` replaces `globalThis.fetch` for `api.shopify.com` at module load                                                                                                                                                  | the object builds its own `ShopifyAppEvents`; Effect's fetch client caches `globalThis.fetch` on first use, so the stand-in must be in place before any request                        |
| 12  | 4.3        | keep the test "a seeded order is never counted", through the seed path                                                                                                             | the repository test composes the seed's `afterWrite` (mark, then count) and asserts `countedAt = 0`; the seed-callable test "reseeding leaves the usage counter unchanged" now also asserts no pending events                                                                | the repository test pins the rule; the callable test covers the real seed                                                                                                              |
| 13  | 4.3        | update or delete `orderIsSeeded`                                                                                                                                                   | deleted it and its domain test; the rule is on `OrderRepository.markSeedOrdersCounted`, and `SEED_ORDER_ID_PREFIX` says the seed marks its orders                                                                                                                            | nothing else used it                                                                                                                                                                   |
| 14  | 4.4        | delete dead events in the sweep                                                                                                                                                    | `sweepExpiredOrders` also returns `usageEvents`, and its callers log `sweptUsageEvents`; its error type gains `OrderRepositoryError` (it reads the cycle)                                                                                                                    | the count belongs in the existing sweep log line                                                                                                                                       |
| 15  | 4.5        | triggers-table row or D1 row for the daily check                                                                                                                                   | D1 row on `D1_TABLES`: "every installed shop re-reads its plan at least once a day, whether or not anyone opens the app"                                                                                                                                                     | "as a cycle push" is not a count or mark word                                                                                                                                          |
| 16  | 4.5        | rule on the handler                                                                                                                                                                | rule and body are `revalidateStalePlans` in `SubscriptionPlan.ts` (exported for the test); `scheduled` in `worker.ts` builds the `SubscriptionPlan` layers (`makeScheduledLayer`) and links it                                                                               | the test runs the Effect without importing `worker.ts`                                                                                                                                 |
| 17  | 4.5        | cron in every env                                                                                                                                                                  | one top-level `triggers` block                                                                                                                                                                                                                                               | `triggers` is an inheritable key (`refs/cloudflare-docs/.../wrangler/configuration.mdx`, "Inheritable keys")                                                                           |

### Issues

| #   | phase/step | what was found                                                                                                                                                                                                                                                                                                                                                                                               | impact                                                                                                                                                                                                                                                                                                                                                                                                                                              | status (open / resolved / needs the user)            |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | 1.4, 5     | `e2e/plan.billing.spec.ts` (headed, by hand) failed its first run: it read an admin field "Shopify metered quantity" that commit 58c3379 had split into "Shopify metered orders" and "Shopify metered members"                                                                                                                                                                                               | the spec was stale before this change; fixed its label list, and all 4 billing tests pass                                                                                                                                                                                                                                                                                                                                                           | resolved                                             |
| 2   | 4.2        | the Manage plan button navigates away after at most 1.5 s, and the flush is expected to finish anyway because `worker.ts` passes the request's promise to `ctx.waitUntil` (up to 30 s after the client disconnects). The user has not used `waitUntil` before and is not confident it is reliable here                                                                                                       | if `waitUntil` does not hold the work, or the Durable Object call is cancelled with the request, queued events can miss the cycle and go unbilled at a plan change. Not observed on a deployed Worker                                                                                                                                                                                                                                               | open: review with another model before relying on it |
| 3   | 4.1        | the resync test's refused RPC is logged by workerd as "uncaught exception … OfflineSessionInvalidError"                                                                                                                                                                                                                                                                                                      | log noise only; the suite already logs eight such lines from other tests                                                                                                                                                                                                                                                                                                                                                                            | resolved                                             |
| 4   | 4.5        | the local cron run found no stale shop (`shops=0`)                                                                                                                                                                                                                                                                                                                                                           | the Partner call path under cron was exercised by the integration test, not by the local trigger                                                                                                                                                                                                                                                                                                                                                    | resolved                                             |
| 5   | 5          | the full E2E run left an import stuck (the local Workflows instance slept after its first poll and never woke), and "orders screen imports open orders and lists them" then failed on every run: the orders index disabled Import open orders for any tracking row, while only a click could clear a stale one, so one dead instance disabled the button for good. Outside this plan, found while running it | fixed: the orders index now counts a tracking row as an import only while it is younger than `IMPORT_STALE_MS` (rule on that constant, `importRowIsFresh` enforces it); test "a tracking row disables Import open orders only while it is fresh", and "a tracked import whose instance is gone is cleared on the next click" now expects the button enabled. The E2E test passes against the stuck row. Why the local instance stalled is not known | resolved (the stall's cause is open)                 |

# Spec simplification: implementation plan

This plan carries out the nineteen recommendations decided in
`docs/spec-simplification-research.md` (2026-10-02, three Plannotator passes). Read that doc
first: section 1 is shop work, section 2 billing, section 3 sync, section 4 the two larger
questions, and Decisions says how each went. The draft is kept as it is (Question A, tabled);
nothing here touches `WorkflowDraft`, `WorkflowDraftTask`, Apply or Discard. Seats is Option 2.
Recommendation 17 (keep `AdminShopPlanCache`) needs no work.

The plan is in six phases, one per area. Each phase starts at the spec row, then changes the
code, then the pinned tests, and ends with a "done when". Phases are independent of each other
except where a note says otherwise, but they all touch `src/lib/domain/ShopWork.ts`,
`src/lib/ShopAgentSchema.ts` and `test/integration/data-model.test.ts`, so do them one at a
time and run the checks between.

## Before you start

- Read `AGENTS.md`, `docs/vocabulary-runbook.md`, and the preambles on `reconcileItem`,
  `runActions`, `taskActions` (`src/lib/domain/ShopWork.ts`), `syncOrder`
  (`src/lib/domain/Orders.ts`), `ShopUsage` (`src/lib/domain/Billing.ts`), `initializeSchema`
  (`src/lib/ShopAgentSchema.ts`) and `ShopAgentHost` (`src/lib/agent/Host.ts`). The rules that
  matter most here:
  - A behaviour change starts at the cell or the row. `pnpm spec check` parses every table named
    above, holds the action matrices total (every combination of state words exactly once),
    refuses a `pinned by` title no test carries, refuses a vocabulary word whose symbol is gone,
    and holds the vocabulary's screen columns to the label constants. Expect it to fail after
    every spec edit until the code and the tests follow.
  - A rule is stated once and linked from everywhere else. When a rule goes, grep for its
    `{@link}`s and the prose that restates it; a JSDoc that still explains a mechanism that no
    longer exists is a bug.
  - A JSDoc never cites a file under `docs/`.
  - Retire a word through `docs/vocabulary-runbook.md`: strike its row, and if a screen word
    goes, add it to the retired list in `scripts/rules-lint.ts` only if it must never come back.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- The project is prototyping: there are no migrations for the object. A DDL change is made in
  line in `initializeSchema`, and you run `pnpm dev:reset` yourself afterwards. Phases 1, 2, 4
  and 5 change the DDL.
- After each phase run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`),
  `pnpm test`, `pnpm fmt`, and for phases 1 and 2 the e2e suites named in the phase. Keep every
  file `pnpm fmt` touches.
- Deleting a test is allowed here, unlike in the data-model plan, because the rule it pinned is
  being deleted. The test to delete is the one whose title is a `pinned by` cell of a row this
  plan strikes. A test that fails for any other reason is a deviation: record it, do not delete
  it.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go: what the plan said, what you found,
  the two options you saw, and the one you took.

## The recommendations, by phase

| rec. | what                                                                              | phase |
| ---- | --------------------------------------------------------------------------------- | ----- |
| 1    | remove the open-run ceiling and everything that serves it                         | 1     |
| 2    | keep the resize, drop the quantity badge                                          | 1     |
| 3    | drop the truncation flag and its reconcile clause                                 | 1     |
| 4    | drop the orphan-run sweep                                                         | 1     |
| 8    | multi-match has no payment gate                                                   | 1     |
| 5    | `reopen` is a boolean; the blocker is not named                                   | 2     |
| 6    | drop the reopen record                                                            | 2     |
| 7    | a person may replace any run, done included                                       | 2     |
| 9    | drop Edit reason                                                                  | 2     |
| 10   | `RunResult` is `Ok`, `NotFound`, `NotAllowed`                                     | 2     |
| 11   | drop the team delete dialog's counts                                              | 3     |
| 12   | cut `empty_team` as an order issue; keep it as a workflow fault                   | 3     |
| 13   | the seed writes `countedAt` itself and leaves the spec                            | 3     |
| 14   | the seat mark is maintained by the revalidation alone (Option 2)                  | 4     |
| 15   | the flush deletes an expired usage event and logs it                              | 4     |
| 16   | cut the meter divergence check                                                    | 4     |
| 18   | drop `WebhookDelivery` and the dedupe                                             | 5     |
| 19   | a stale tracking row is deleted on the next press without asking Cloudflare       | 5     |
| 17   | keep `AdminShopPlanCache`                                                         | none  |
| all  | the vocabulary, the data-model table, the pipeline table, the research doc status | 6     |

## Two departures from the research, decided at planning time

Both are recorded here so the implementer does not rediscover them, and again under Deviations
when the phase lands.

1. **Recommendation 5 keeps the `downstream` column of `taskActions`.** The research said the
   column goes. It cannot: "no later step has started" is still the rule, and the matrix needs
   a state word to test it. What goes is the third value of `reopen` (`blocker`) and the name of
   the blocker. The `started` row's `reopen` cell becomes blank.
2. **Recommendation 7 splits the done and closed rows of `runActions` by units.** With Change
   workflow offered on any run with units, a done run at zero units offers nothing and a done
   run with units offers `M`, so `units` is no longer `any` on those rows. The matrix goes from
   8 rows to 10 and loses the `editReason` column.

## Phase 1: reconcile and the run

Recommendations 1, 2, 3, 4 and 8. Everything here is in `reconcileItem`'s tables, `Run`,
`ShopOrder`, the DDL, `RunRepository.reconcileOrder`, `OrderRepository.sweepExpiredOrders` and
the three sync paths.

### 1.1 The spec text

On `reconcileItem` (`src/lib/domain/ShopWork.ts`):

- The guarantee paragraph: strike the "and the shop is under the open-run ceiling" clause from
  **Create**; strike the **Orphan** bullet's "unless the order's items were truncated" clause, so
  it reads "a stored run whose item is not stored is read as an item at zero units".
- Strike the paragraph "Why the open-run ceiling rules (pass rules 4 to 7) read as they do".
- The triggers table: strike the row "a write that lowers the open-run count". The retention
  row stays.
- The actions table: strike the two `1, at the ceiling` rows. Merge the two `changed` rows into
  one, `open | any | changed | open | any | resize`. Merge the two `2+` rows into one,
  `open | any | some | none | 2+ | nothing: multi-match`. The preamble loses the sentences
  defining `1, at the ceiling`, "the open-run ceiling is read only for `create`", and "the badge
  a resize leaves is the rule on `Run` `quantityChangedFrom`"; `open` under `run on item` no
  longer says "unstarted or started", just "open". The table is then 13 rows.
- The effects table: strike the `open-run ceiling flag` column and the `nothing: declined` row.
  The `resize` row's `pinned by` becomes one title, "a resize rewrites the quantity and counts
  nothing". The `close` row's `open-run ceiling flag` words go with the column.
- The pass rules: strike 4, 5, 6, 7 and 11 and renumber. Rule 1 loses its "unless" clause and
  its second pinned title. Rule 9 (now 6) loses "stop, fit, record, create and orphan" if the
  guarantee's wording changes; keep the five words if the guarantee keeps them.
- `ReconcileAction`: `resize` loses `badge`; `nothing` loses `declined`.

On `Run`: strike the `quantityChangedFrom` field and its badge-rule paragraph. `updatedAt`'s
JSDoc becomes one line: bumped by every run and task write; no reader today. `runIsUnstarted`'s
JSDoc loses the sentence about the resize; it stays for `runHasRecord`.

On `RunState`: the rules table loses the row "counts against the open-run ceiling". The
paragraph under it loses "does not count against `ShopLimits.maxOpenRuns`".

On `taskActions`: the `reopen` bullet loses its last two sentences (Reopen at the ceiling).

On `multiMatchItems` and the vocabulary's multi-match row: the gate goes. The row reads "an
item two or more eligible workflows match, with units to make and no run in any state". The
`OrderIssue` table's `multi_match` row reads "`multiMatchItems > 0`" and the paragraph "An
unpaid order with a multi-match item is not choosing" goes; `orderIssues` loses the "gate
applied twice" comment.

On `ShopOrder` (`src/lib/domain/Orders.ts`): strike `lineItemsTruncated`. On `syncOrder`, rule
10 reads "an order keeps at most 250 items on either path; the rest are not stored; on the
stream a child whose parent is not the open order fails the sync".

On `ShopLimits` (`src/lib/domain/Platform.ts`): strike `maxOpenRuns`. `maxLineItemsPerOrder`'s
comment reads "line items fetched per order on either path; the rest are not stored".
`orderRetentionDays`'s paragraph stays.

On `ShopUsage` (`src/lib/domain/Billing.ts`): strike `openRunsLimitedAt`. The `ceiling`
vocabulary row on Platform names `maxOrdersPerCycle` and `maxMembers` only.

On `initializeSchema` (`src/lib/ShopAgentSchema.ts`), the data-model table:

- `item`: the sync row loses "unless the order's items were truncated at sync" and its third
  pinned title.
- `run`: the quantity row reads "an open run's quantity follows its item's units to make on
  every reconcile; a done or closed run's quantity is frozen", pinned by "an open run's quantity
  follows its item, and a done or closed run's quantity is frozen".
- `order`: the retention row stays.

The pipeline table on `ShopAgentHost` (`src/lib/agent/Host.ts`) loses its `release` column.

### 1.2 The code

- DDL: drop `Run.quantityChangedFrom`, `ShopOrder.lineItemsTruncated`,
  `ShopUsage.openRunsLimitedAt`. Then `pnpm dev:reset`.
- `RunRepository.reconcileOrder`: remove the ceiling count, the decline path, the
  `openRunsLimitedAt` write, `releaseOpenRunLimit` and its three callers (`markTaskDone`,
  `cancelRun`, the reconcile close), `ceilingReleased` on `ReconcileCounts` and
  `ReconcileAllCounts`, the truncation branch (pass rule 1), and the `badge` handling on resize.
  `markTaskDone` stops clearing `quantityChangedFrom`.
- `ShopWorkAgent` (`src/lib/agent/ShopWork.ts`): remove `afterCeilingReleased`,
  `releaseOpenRunLimit`, every `if (ceilingReleased)` and the `"ceilingReleased"` reason to
  `reconcileAllNow`. `merchantAttachWorkflow` stops answering `RunLimit`.
- `ShopAgent.ts`, `ShopAgentOrdersStream.ts`, `agent/Orders.ts`: remove `ceilingReleased`
  plumbing and the `afterCeilingReleased` calls after the webhook, the one-order sync, the
  stream and the sweep.
- `OrderRepository.sweepExpiredOrders`: remove the orphaned-runs statement and its comment; the
  returned `runs` count is the cascaded runs alone. Remove `markOrdersLimited`'s sibling for
  open runs if one exists.
- `OrderSync.ts`, `ShopAgentOrdersStream.ts`, `agent/Orders.ts`: stop computing and writing
  `lineItemsTruncated`; keep the `first: 250` fetch and the log line that says the order had
  more.
- `AttachResult`: strike `RunLimit`. `src/routes/app.orders.$orderId.tsx`,
  `src/routes/shop.$shop.workflows.index.tsx`, `src/routes/shop.$shop.tsx`: remove the
  `RunLimit` branches and the open-runs banner (`src/components/QuotaBanners.tsx` keeps the
  orders banner only). `src/routes/admin.shop.$shop.tsx` drops the open-runs limited field.
- `src/components/MemberRun.tsx` and `src/routes/shop.$shop.workflows.$runId.tsx`: remove the
  quantity badge and its condition.
- `src/routes/app.orders.$orderId.tsx`: remove the truncation warning.
- `multiMatchItems`, `orderIssues`, and the SQL twin `MULTI_MATCH_ITEM` in
  `OrderRepository.listOrders`: remove the `fullyPaid` gate.
- `scripts/lib/spec.ts`: `RECONCILE_ACTION_WORDS.matches` loses `1, at the ceiling`; the
  reconcile fixture builder loses `atCeiling`; `reconcileItem`'s signature loses it too.

### 1.3 The tests

Delete the tests titled:

- a declined run raises the open-run ceiling flag and the run's last Done clears it
- a close by reconcile releases the open-run ceiling and says so
- the open-run ceiling is counted once per pass, each create spends one and a close refunds
  nothing
- at the open-run ceiling a pass declines, the webhook answers 2xx and the order is stored
  without its run
- a pass that closes and declines reports released and raises the flag again
- a reconcile all whose own closes release the open-run ceiling runs once more
- the write that releases the open-run ceiling creates the runs that were declined
- the retention sweep releases the open-run ceiling when its deletes make room
- a resize on an unstarted run clears the quantity badge
- a resize back to the original clears the badge, and a Done clears it
- a quantity change resizes an open run and records the original quantity once; completing a
  task clears it
- on a truncated order a run whose item is not stored is left alone
- caps an order's line items and flags it rather than failing the sync (replace with "stores the
  first 250 line items of an order and does not fail the sync")

Retitle: "a pass reads the stored order, and a run whose item is gone closes as item removed"
stays as is. The multi-match tests that assert "an unpaid order is not choosing" become "a
multi-match item on an unpaid order is an issue". The data-model test for the run quantity row
takes its new title. The `run-actions.test.ts` reconcile fixture test regenerates from the
table; it needs no title change. Delete any test whose title mentions the open-run ceiling or
`maxOpenRuns` in `shop-agent-sync-order.test.ts`, `shop-agent-workflows.test.ts` and
`run-repository.test.ts` that the list above does not name, and record each under Deviations.

E2E: `e2e/member-runs.member.spec.ts` references `RunLimit`; remove that branch.

### 1.4 Done when

`pnpm spec check` parses a 13-row actions table and a 4-row, 4-column effects table; the pass
rules number six; `grep -rn "maxOpenRuns\|openRunsLimitedAt\|ceilingReleased\|declined\|quantityChangedFrom\|lineItemsTruncated" src test e2e scripts` is empty except `declined` in
unrelated prose, if any; `pnpm test` and the three e2e projects pass.

## Phase 2: the verbs on a run

Recommendations 5, 6, 7, 9 and 10. Everything here is in the two action matrices, `RunTask`,
`RunTaskRow`, `RunResult`, `AttachResult`, `LineItemState`, the DDL, `RunRepository` and the
two run pages.

### 2.1 The spec text

On `taskActions`:

- `TaskActions.reopen` becomes `Schema.Boolean`. The preamble's "`reopen` has three values"
  paragraph goes. The `downstream` column stays (departure 1); its `started` row's `reopen` cell
  is blank. The sentence "When reopen is blocked, the merchant sees which task is in the way"
  goes; the `reopen` bullet says a done task reopens when no later step has a task started or
  done, and names no one.
- Strike `ReopenBlocker`, `reopenBlockedBy`, `firstStarted`, `RunTaskRow.reopenBlockedBy`. Add
  `RunTaskRow.laterStepStarted: Schema.Boolean` with the one-line rule ("a task in a later step
  of the run has started or is done"); `runTaskRows` computes it. `taskActions` reads it.
- On `RunTask`: strike `reopenedAt`, `reopenedByRole`, `reopenedByEmail`, `taskReopenedBy`, and
  the "reopened records the last actor" paragraph. Reopen clears the started and done columns and
  records nothing, as Put back does. The `RunResult` JSDoc's `ReopenBlocked` sentence goes.

On `runActions`:

- Strike the `editReason` column and field, and the `editReason` clause of the `block` bullet.
- `changeWorkflow`: the bullet reads "needs units to make; offered on any run, done and closed
  included, behind the confirm on `runHasRecord`". Split the done and closed rows by units
  (departure 2): `open | done | no | some | M m v | | | M | M`, `open | done | no | none |
M m v | | | | |`, and the same pair for `closed`. `cancel` stays blank on done and closed.
- The `RunState` rules table: the row "replaced by a manual attach" reads "always; the confirm
  names what is lost", and the paragraph under it loses "a done run is a record that is never
  replaced". `LineItemState`: `done` and `closed` merge into one kind, `run`, carrying `run`,
  `tasks`, `options`, `matched`, `attachable`; `open` stays its own kind because it carries no
  picker. The preamble's bullets follow.
- `AttachResult`: strike `ItemDone`. `RunResult` becomes `Ok`, `NotFound`, `NotAllowed`, with a
  one-paragraph JSDoc: `NotAllowed` is the action set refusing the write, or a race between the
  render and the click, and the page re-reads either way.
- Strike `SetBlockReasonInput`, `SetBlockReasonCommand`, the `edit reason` verb row, `editReason`
  from `Verb` and `VERB_LABEL`.

On `initializeSchema`'s table: the `item` one-run row reads "a person replaces a run in any
state"; the `task` reopen row ("reopen is latest only") is struck; the started/done pairs row
loses nothing.

### 2.2 The code

- DDL: drop `RunTask.reopenedAt`, `reopenedByRole`, `reopenedByEmail` and their three checks.
  Then `pnpm dev:reset`.
- `RunRepository`: `reopenTask` stops writing the reopened columns and stops computing the
  blocker; it refuses with the existing `NotAllowed` path when `laterStepStarted`. Remove
  `ReopenBlockedError`, `setBlockReason` and `RunNotBlockedError`. `setRun` stops refusing a done
  run. Map `RunTerminalError`, `TaskNotReadyError`, the blocked refusal and any remaining
  repository guard to `NotAllowed` in `agent/ShopWork.ts`'s result mapping; the error classes may
  stay internal. The list and page reads stop selecting the reopened columns and the blocker.
- `agent/ShopWork.ts`: remove `setBlockReason`; `ShopAgent.ts` removes its callable;
  `test/integration/agent-socket.ts` removes its helper.
- `src/lib/useMemberRunActions.ts`, `src/lib/ShopAgentSocketHost.tsx`,
  `src/routes/shop.$shop.workflows.$runId.tsx`, `src/routes/app.orders.$orderId.tsx`: remove the
  Edit reason modal and verb, the per-tag toasts for `Terminal`, `NotReady`, `NotBlocked`,
  `Blocked`, `ReopenBlocked`, the blocker sentence, and the `ItemDone` branch. One `NotAllowed`
  toast per verb, in the `toast` slot's form (a fact in the present tense), for example "The task
  changed on another screen". `src/components/RunSteps.tsx` stops rendering the reopened line.
- `lineItemState`: build the merged `run` kind; the order page's card switches on four kinds.
- `scripts/lib/spec.ts`: remove `editReason` from the run action list and the `Blocker`
  fixture; the `downstream` words map to `laterStepStarted: false / true`.

### 2.3 The tests

Delete the tests titled:

- reopen is latest only: a later Done clears reopenedAt, reopenedByRole and reopenedByEmail
- setRun over a done run is refused, naming the done workflow

Retitle "setRun over an open run deletes it in the same transaction and reports it as replaced"
to cover a done run too, or add "setRun over a done run replaces it and reports it as replaced".
The `run-actions.test.ts` matrix test regenerates from the tables. `change-warning.test.ts`
drops the reopened fields from its fixtures. Tests that assert a `ReopenBlocked`, `Terminal`,
`NotReady`, `NotBlocked` or `Blocked` tag assert `NotAllowed` instead; keep their titles unless
the title names the old tag.

E2E: `e2e/orders.spec.ts` references the blocker sentence; it asserts the absence of Reopen on
the blocked task instead.

### 2.4 Done when

`pnpm spec check` parses a 10-row `runActions` table without `editReason` and a 9-row
`taskActions` table whose `started` row has a blank `reopen`; `RunResult` has three tags;
`grep -rn "ReopenBlocker\|reopenBlockedBy\|reopenedAt\|editReason\|setBlockReason\|ItemDone\|NotBlocked\|NotReady\|\"Terminal\"" src test e2e scripts` is empty; `pnpm test` and the e2e
projects pass.

## Phase 3: teams, the empty team, the seed

Recommendations 11, 12 and 13.

### 3.1 The spec text

- `TeamDeleteCounts` and `TeamTaskCounts` are struck. `DeleteTeamResult`'s JSDoc keeps "nothing
  refuses". The team page's delete modal body is one sentence in the `confirm` slot: "Tasks on
  this team become unassigned until you assign another team." Check the copy table's example
  column still finds every example.
- `OrderIssue` loses `empty_team`; `orderIssues` and `OrderRow` lose `emptyTeam`; the issues
  table and the vocabulary's order-issues table lose the row; `ORDER_ISSUE_LABEL` loses the key.
  The fault stays on the workflow screens: add a `WorkflowFault` literal set (`unassigned`,
  `empty_team`) with `WORKFLOW_FAULT_LABEL` (`Needs a team`, `Team has no members`) and a
  four-line vocabulary table "Workflow faults, shop work" beside the order issues, so the label
  constant has a vocabulary row for `pnpm spec check`. `ORDER_ISSUE_LABEL.unassigned` reads from
  it so the label is one string. The paragraph on `OrderIssue` about "the tone is not whether
  Apply allows the fault" is rewritten for `unassigned` alone; the sentence about Needs a team
  being shown for an assigned team with no members stays as history of why the two labels
  differ.
- The `ShopUsage` triggers table loses the row "run on a seeded order". `SEED_ORDER_ID_PREFIX`'s
  JSDoc says the seed writes `countedAt` on the rows it inserts, so a seeded store does not fill
  the meter; it is the seed's own rule and not a spec row. The `countedAt` column comment and
  the data-model's counted-mark row stop mentioning the seed.

### 3.2 The code

- `WorkflowRepository`, `ShopAgent.ts`, `ShopAgentClient.ts`, `src/lib/teams.ts`,
  `src/routes/app.teams.$teamId.tsx`: remove the counts read and the callable; the dialog body
  becomes the sentence.
- `OrderRepository.listOrders`: remove `emptyTeamRun` and the member-count input it needs from
  D1; `agent/ShopWork.ts` stops reading team member counts for the orders index (the workflows
  index and page keep reading them). `src/routes/app.orders.index.tsx` and
  `app.orders.$orderId.tsx` stop rendering the badge and banner; `app.workflows.index.tsx` and
  `src/components/WorkflowSteps.tsx` read `WORKFLOW_FAULT_LABEL`.
- `OrderRepository.markSeedOrdersCounted` goes; the seed's upsert writes `countedAt` on insert.

### 3.3 The tests

Delete "a seeded order is never counted" and the `emptyTeam` cases in `order-repository.test.ts`
and `domain.test.ts` that assert the order issue. Keep the workflow-side tests (the workflows
index badge, the workflow page banner) and retitle any that say "issue" to say "fault".
`spec.test.ts` has two fixtures quoting the `empty_team` issues row; update them to the new
table. Add "the seed writes countedAt on every order it inserts" to the seed test.

### 3.4 Done when

`grep -rn "TeamDeleteCounts\|TeamTaskCounts\|emptyTeamRun\|markSeedOrdersCounted" src test` is
empty; the orders index makes no D1 read for member counts; `pnpm spec check` finds the new
vocabulary table and every label; `pnpm test` passes.

## Phase 4: billing

Recommendations 14, 15 and 16. Everything here is in `ShopUsage`'s triggers table, the
`OrderRepository` billing methods, `BillingAgent`, `SubscriptionPlan`, `ShopifyPartner` and the
admin shop page.

### 4.1 The spec text

On `ShopUsage` (`src/lib/domain/Billing.ts`), the triggers table:

- Strike "member added, member count above the mark", "member added, member count at or below
  the mark", "member removed".
- "cycle pushed, same start" becomes "revalidation, same cycle start: `—` / `→ member count if
above` / `+1 seat event (the rise), then sent`", pinned by "a revalidation raises the mark to a
  member count past it and sends the rise".
- "cycle pushed, new start" loses "seat events in the cycle dropped" from its queue cell: the
  queue cell is "+1 seat event (whole member count), then sent".
- "meters checked" is struck; its "sent" moves onto the two revalidation rows (they already say
  "then sent").
- "an event's billing cycle ends unsent" reads "row deleted at the next flush, logged", pinned by
  "the flush deletes an event dated before the current cycle and logs it".
- Strike "retention sweep, expired event over 60 days old".
- The paragraph above the table loses "`recordMemberCount`" from its list of carriers; the three
  assumptions stay. The `seat` vocabulary row stays; `seatsThisCycle`'s JSDoc says the
  revalidation is its one writer.
- Strike `RecordMemberCountInput`, `MeterQuantitiesInput`, `meterDiverges`, the `diverge` and
  `meter quantity` vocabulary rows, `ShopUsage.meterQuantityOrders`, `meterQuantityMembers`,
  `pendingOrderUnits`, `pendingMemberUnits`, `expiredUsageEvents`, and the `expired event`
  vocabulary row's "never sent" becomes "deleted at the next flush". `usageEventIsExpired` stays
  as the one rule the flush reads; its JSDoc is rewritten: an expired event can never be sent,
  so the flush deletes it and logs it. `AppSubscription.usage` is struck.
- `ShopLimits` loses `expiredUsageEventRetentionDays`.
- The `initializeSchema` table: strike the `UsageEvent` "expired usage event is kept past 60
  days" row; the `ShopUsage` seat row reads "the cycle's highest member count, raised by the
  revalidation alone; a new cycle resets it to the member count".

### 4.2 The code

- DDL: drop `ShopUsage.meterQuantityOrders`, `meterQuantityMembers`. Then `pnpm dev:reset`.
- `OrderRepository`: remove `recordMemberCount`, `raiseSeatMark`'s second caller, `checkMeters`,
  the pending-unit and expired counts in `usageAtCycle`, the expired-events statement in
  `sweepExpiredOrders`, and the "drop queued seat events" statement in `setBillingCycle`.
  `flushUsageEvents` deletes a row whose `occurredAt` is before the cycle start, with a
  `logWarning` naming the key and handle, instead of skipping it.
- `BillingAgent` (`src/lib/agent/Billing.ts`): remove `recordMemberCount` and `checkMeters`.
  `ShopAgent.ts` and `ShopAgentClient.ts` remove both callables. `setBillingCycle` on the object
  sends the queue after its write, since the meter check no longer does.
- `SubscriptionPlan.ts`: remove the meter push and the divergence log; the cycle push stays.
  `ShopifyPartner.ts` stops reading the meter quantities.
- `src/routes/app.members.tsx`: remove the `recordMemberCount` call and its failure handling.
- `src/routes/admin.shop.$shop.tsx`: remove the Shopify metered quantities, pending units and
  expired count fields.

### 4.3 The tests

Delete the tests titled:

- an add past the high-water mark queues one seat event and raises the mark
- an add at or under the high-water mark queues nothing
- a member removal queues nothing and leaves the mark
- a meter check stores Shopify's quantities, logs a divergence and sends the queue
- a queued event expires once the cycle that dated it has ended: skipped by the flush and
  reported apart
- the retention sweep deletes expired usage events older than 60 days and keeps younger ones

Retitle "an unchanged cycle raises the mark to a member count past it, so an add whose
recordMemberCount failed is billed at the next revalidation" to "a revalidation raises the mark
to a member count past it and sends the rise". Add "the flush deletes an event dated before the
current cycle and logs it". `subscription-plan.test.ts`, `shop-agent-usage-flush.test.ts` and
`shop-agent-callables.test.ts` lose their `checkMeters` and `recordMemberCount` cases.

### 4.4 Done when

The triggers table has 12 rows and `pnpm spec check` finds every title;
`grep -rn "recordMemberCount\|checkMeters\|meterDiverges\|meterQuantity\|pendingOrderUnits\|pendingMemberUnits\|expiredUsageEvent" src test` is empty; `pnpm test` passes.

## Phase 5: sync

Recommendations 18 and 19.

### 5.1 The spec text

On `syncOrder` (`src/lib/domain/Orders.ts`):

- Rule 2 reads "a payload version not newer than the row returns without a fetch; an edit, which
  has no version, always fetches". The webhook row's `skipped when` loses "a delivery id already
  seen" and its `pinned by` loses "treats a redelivered webhook id as a no-op".
- Rule 3 reads "one open-orders sync at a time, and the Agents SDK's tracking row is the only
  record of it; a fresh row disables the button; a row older than `SYNC_STALE_MS` is dead and the
  next press deletes it". Its `pinned by` second title becomes "a tracking row older than ten
  minutes is deleted on the next press".
- The `sync` vocabulary row and `SyncState`'s JSDoc are unchanged. The `WebhookDelivery` line
  leaves `scripts/vocab-allowlist.txt`.
- `ShopLimits` loses `webhookDeliveryRetentionDays`. The `initializeSchema` table loses the
  `WebhookDelivery` row.

### 5.2 The code

- DDL: drop the `WebhookDelivery` table and its index. Then `pnpm dev:reset`.
- `OrderRepository`: remove `recordWebhookDelivery` and the delivery sweep in
  `sweepExpiredOrders`. `ShopAgent.syncOrderWebhook` removes the dedupe call and its duplicate
  log line.
- `ShopAgent.syncOpenOrders`: a tracked row older than `SYNC_STALE_MS` is deleted before the
  start; remove `refreshWorkflow`, `getWorkflowStatus`'s use here and the
  `isWorkflowInstanceNotFoundError` branch if nothing else uses it. The JSDoc's three cases
  become two.

### 5.3 The tests

Delete "treats a redelivered webhook id as a no-op", "a webhook delivery is one row per delivery
id; reports the first delivery as new and a redelivery as seen; sweeps deliveries past the
retention window and keeps the new one", and "a tracked sync whose instance is gone is cleared on
the next click". Add "a redelivered webhook rewrites the same version and changes nothing a
screen shows" (it can reuse the equal-version fixture) and "a tracking row older than ten minutes
is deleted on the next press".

### 5.4 Done when

`grep -rn "WebhookDelivery\|recordWebhookDelivery\|refreshWorkflow" src test scripts` is empty;
the webhook test suite passes with a redelivery fixture; `pnpm test` passes.

## Phase 6: the vocabulary, the data model and the record

- Run `pnpm vocab:audit` and strike every vocabulary row whose symbol this plan removed that an
  earlier phase missed. Check the Shared words and Screens tables are untouched.
- Read the `initializeSchema` table top to bottom once and the `D1_TABLES` table once, against
  the DDL as it now is; every row names only columns that exist.
- Read the `ShopAgentHost` pipeline table; it has five columns.
- Update the status line of `docs/spec-simplification-research.md` to say the plan was
  implemented, with the date, and copy this plan's Deviations section there in one line per
  deviation.
- Run the full gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e --`,
  `pnpm fmt`.

### Done when

Everything passes; `git status` shows only the files this plan names plus whatever `pnpm fmt`
touched; nothing is committed.

## Deviations and issues

Record here, as you go, every place the work departed from this plan or found something the
plan did not foresee. One entry per item, in the order found:

- **What the plan said.** The phase and sentence.
- **What you found.** The fact, with the file and symbol.
- **The options.** The two ways it could go.
- **What you did.** The one you took and why, in a sentence.

Two are known at planning time and belong here once their phase lands:

- Phase 2, recommendation 5: the `downstream` column stays (departure 1 above).
- Phase 2, recommendation 7: the done and closed rows split by units (departure 2 above).

Things this plan expects may come up, so the implementer knows they are not surprises:

- A test the plan does not name fails because it exercised the ceiling, the badge, truncation or
  the reopen record incidentally. Fix the fixture; do not delete the test unless its title is a
  rule this plan strikes. Record it.
- `pnpm spec check` refuses a table mid-phase because the rows and the tests are out of step.
  Expected until the phase ends; not a deviation.
- The orders index's SQL twin for multi-match and the `MULTI_MATCH_ITEM` constant may carry the
  payment gate in more than one clause. Record each site.
- The admin shop page may read a `ShopUsage` field this plan removes through a shape the plan
  does not name (`ShopUsageRow`, `usageAtCycle`). Remove the field from the shape; record it.
- A reconcile all after a team delete or a Turn on used to be the path that created runs
  declined at the ceiling. With the ceiling gone that path creates nothing new, but the trigger
  rows for those verbs stay, since they still create the survivor's run. If a test for one of
  them relied on the ceiling, record it.

### Recorded during implementation

The two departures above landed as written in phase 2. Implemented 2026-10-02; the full gate
passes (typecheck, lint, 675 tests, 72 e2e). Not committed.

1. **What the plan said.** Phase 1, 1.1 effects table: strike the `nothing: declined` row; the close row loses its ceiling words.
   **What I found.** The close row's only pinned title, "a close by reconcile releases the open-run ceiling and says so", is a test 1.3 deletes, and with one `nothing` row left "(every other reason)" qualifies nothing.
   **The options.** Pin the close row on a new test, or on an existing close test; keep or rename the `nothing` row.
   **What I did.** Pinned the close row on the existing "a line at zero units closes its run as item_removed" and renamed the row `nothing`, since an existing test already states the rule.

2. **What the plan said.** Phase 1, 1.1 pass rules: "Rule 9 (now 6)".
   **What I found.** Striking 4 to 7 and 11 makes old 8, 9, 10 the new 4, 5, 6: idempotence is rule 5, not 6.
   **The options.** Follow the plan's number, or the arithmetic.
   **What I did.** Numbered by the arithmetic and moved every cross-reference (`RunRepository`, `agent/ShopWork.ts`, `ShopAgent.ts`, the guarantee paragraph).

3. **What the plan said.** Phase 1, 1.2 and 1.3: remove the `RunLimit` branches in `shop.$shop.workflows.index.tsx`, `shop.$shop.tsx` and `e2e/member-runs.member.spec.ts`.
   **What I found.** Those are `Domain.RunLimit`, the workflows list's row-depth schema, not `AttachResult`'s `RunLimit` tag.
   **The options.** Remove them anyway, or leave them.
   **What I did.** Left them; only the order page's `RunLimit` attach message went.

4. **What the plan said.** Phase 1: the orphan-run sweep goes.
   **What I found.** Rule 9 on `syncOrder` was pinned by "deletes any order older than 365 days, open or closed, with its runs, plus orphaned runs", whose fixture planted an orphan.
   **The options.** Delete the test, or retitle it and drop the orphan fixture.
   **What I did.** Retitled it "deletes any order older than 365 days, open or closed, with its runs" and dropped the orphan; the rule it pins still stands.

5. **What the plan said.** Phase 1, 1.3: delete any other ceiling test and record each.
   **What I found.** Four more: "Reopen is allowed at the open-run ceiling and takes the shop one over it", "Cancel workflow releases the ceiling", "manual attach fails at the ceiling rather than silently doing nothing", "a Done that releases the ceiling creates the declined runs". The domain test "multi-match counts only on an order that can create runs" asserted the payment gate.
   **The options.** Keep and rewrite, or delete.
   **What I did.** Deleted all five; the multi-match one is replaced by "a multi-match item on an unpaid order is an issue".

6. **What the plan said.** Phase 1: `afterCeilingReleased` goes.
   **What I found.** "every order in a pass sees the same eligible snapshot" used it as its reconcile-all trigger.
   **The options.** Expose `reconcileAllNow` for the test, or trigger it through a real verb.
   **What I did.** Triggered it by deleting a spare workflow (`removeWorkflow`), which reads the teams once like the old path.

7. **What the plan said.** Phase 1: drop the badge.
   **What I found.** `reconcileItem` read the run's tasks only for the badge, and `RunListRun` kept `quantity` only for the badge (the row never printed it).
   **The options.** Leave both, or cut them.
   **What I did.** `reconcileItem`'s run input lost its tasks (and `reconcileOrder` its `withTasks` read); `RunListRun` omits `quantity`.

8. **What the plan said.** Phase 1: tests that exercised the badge or the gate incidentally.
   **What I found.** "a refund that lowers currentQuantity reads like an edit: unstarted resized silently, started resized with the badge"; the order-repository fixture `#1014` is an unpaid multi-match.
   **The options.** Delete, or retitle and update the expectations.
   **What I did.** Retitled the first "…: started or not, the run is resized"; `#1014` is now an issue and the counts moved with it. The e2e `E2E Shrunk` fixture and its badge assertions went.

9. **What the plan said.** Phase 2, departure 2's sample row `open | done | no | some | M m v | | | M | M`.
   **What I found.** With `editReason` gone the row has five action cells and the sample puts `M` under `cancel`, which the plan's own rule keeps blank on done and closed.
   **The options.** Copy the row, or follow the rule.
   **What I did.** Followed the rule: `M m v | | | | M`.

10. **What the plan said.** Phase 2: the merged `LineItemState` kind is `run`, and the card "switches on four kinds".
    **What I found.** `scripts/rules-lint.ts` refuses "run" as a string in a route, and the kinds are five (removed, unmatched, attachable, open, the merged one).
    **The options.** Allow the word in the lint, or name the kind otherwise.
    **What I did.** Named it `ended`; five kinds.

11. **What the plan said.** Phase 2: a person may replace any run, done included; the merged kind carries the picker.
    **What I found.** The picker at rest replaces with no confirm, so a done run's record would be lost silently, against `changeWorkflow`'s "behind the confirm on `runHasRecord`".
    **The options.** Show the picker under a done run, or keep a done run's change in Manage's modal.
    **What I did.** A done run's Change workflow is in Manage, behind the modal whose `confirm` names what is lost; the picker at rest stays under a closed run only, and Manage hides Change workflow there. A done or closed run's options include its own workflow, and `setRun` reads only an open run of the same workflow as `AlreadyExists`.

12. **What the plan said.** Phase 2, 2.2: remove `RunNotBlockedError`; map the remaining guards to `NotAllowed`.
    **What I found.** Unblock still uses `RunNotBlockedError` (a second Unblock racing the first), and `TaskNotReadyError` is step order; the done-when grep's `NotBlocked` and `NotReady` match both class names.
    **The options.** Rename or remove the classes, or keep them internal.
    **What I did.** Kept both internal, mapped to `NotAllowed`, as 2.2 allows; the grep matches only those names.

13. **What the plan said.** Phase 2: strike `reopenBlockedBy`.
    **What I found.** `RecentItem` carried it for the Done or closed list, and `RunSteps.renderExtra` existed only for the blocker sentence.
    **The options.** Keep them, or follow the strike through.
    **What I did.** `RecentItem` carries `laterStepStarted`; `Domain.laterStepStarted` replaces `reopenBlockedBy`; `renderExtra` is gone.

14. **What the plan said.** Phase 2: `TaskActions.reopen` becomes a boolean.
    **What I found.** The agent's reopen gate read `reopen !== null`, which is true for `false`, so the gate let every reopen through; the live matrix test caught it.
    **The options.** None: a bug.
    **What I did.** Fixed both gates to `({ reopen }) => reopen`.

15. **What the plan said.** Phase 2: the started/done pairs row "loses nothing".
    **What I found.** Its pinned title named the reopened times.
    **The options.** Keep a stale title, or retitle.
    **What I did.** Retitled "a run task's started and done times move with their roles, a member's email beside the role, and done implies started"; the RunTask constraints test lost its reopen check.

16. **What the plan said.** Phase 2: tests whose rule is struck.
    **What I found.** "setBlockReason rewrites the reason, keeps by, and refuses anything that is not a standing block", "undo records the reopener and the next Done clears it, for a member and for the merchant", spec.test "blocker is refused outside the reopen column".
    **The options.** Rewrite, or delete.
    **What I did.** Deleted; retitled "reopening a task is refused once any task in a later step has started", "listRecent lists … with whether a later step started; …", "setRunNote records no author: last write wins" and the e2e "the merchant blocks a run with a reason, notes the run, and unblocks it"; added "setRun over a done run replaces it and reports it as replaced". The e2e "Reopened by …" assertions went.

17. **What the plan said.** Phase 2: "one `NotAllowed` toast per verb".
    **What I found.** Every verb's `NotAllowed` is the same fact; what differs is whether a task or the run changed.
    **The options.** A sentence per verb, or per subject.
    **What I did.** Per subject: "The task changed on another screen" for task verbs and "The workflow changed on another screen" for run verbs, on the order page's toasts and the member pages' banner.

18. **What the plan said.** Phase 3: "the orders index makes no D1 read for member counts".
    **What I found.** The team read and its member count are one D1 statement (`Repository.listTeams`), and the index needs the read for ids and names.
    **The options.** Add a count-free team read, or stop consuming the count.
    **What I did.** `listOrders` takes teams as `{id, name}` and reads no member count; the statement is unchanged.

19. **What the plan said.** Phase 3: stop rendering the empty-team badge and banner on the order screens.
    **What I found.** The order page also had a "No members on <team>" line under a run.
    **The options.** Keep it as a hint, or cut it with the issue.
    **What I did.** Cut it.

20. **What the plan said.** Phase 3: the seed's upsert writes `countedAt` on insert.
    **What I found.** `upsertOrder` had no way to take one.
    **The options.** A raw update in the seed, or an input on the upsert.
    **What I did.** Added the seed-only `OrderUpsert.countedAt`, written on insert and never on update. The review of 2026-10-02 reversed this: an input on the general upsert lets any caller exempt an order from billing, so `markSeedOrdersCounted` is back as the seed's own method and the upsert is as it was.

21. **What the plan said.** Phase 3: test fallout.
    **What I found.** Domain "empty team: …" and "an order with both team faults …", order-repository "a current task on a team with no members makes the order emptyTeam, …"; two countTasksByTeam tests also covered listTeamWorkflows and unassignTeam; spec.test fixtures quoted the `empty_team` row and the seeded trigger row; the e2e issue-kinds and team-delete tests.
    **The options.** Delete, or keep the surviving halves.
    **What I did.** Deleted the three; retitled "listTeamWorkflows spans workflows and both sides" and "unassignTeam nulls the team on both sides"; moved the fixtures to the `blocked` row and the Manage plan row; the e2e asserts the empty team shows no issue and the new delete sentence.

22. **What the plan said.** Phase 4: tests beyond the list.
    **What I found.** "a new cycle supersedes seat events queued under a provisional cycle" pinned the dropped statement, "the members drift check tolerates pending seat events" the divergence check; subscription-plan had a meterQuantity test and a null-quantities test; two seat tests drove the mark through `recordMemberCount`.
    **The options.** Rewrite, or delete.
    **What I did.** Deleted the four; the two seat tests now drive the mark through revalidations and a counted order, one retitled "…, and the next revalidation sends the whole count"; "revalidate pushes the member count with the cycle" lost its meter half.

23. **What the plan said.** Phase 4: drop the expired-events sweep.
    **What I found.** `sweepExpiredOrders` returned a `usageEvents` count that two log lines printed, and its JSDoc still named the orphan sweep from phase 1.
    **The options.** Keep the field at zero, or remove it.
    **What I did.** Returns `{orders, runs}`; the log lines and the JSDoc follow.

24. **What the plan said.** Phase 4: `ShopifyPartner.ts` stops reading the meter quantities.
    **What I found.** The query selected `usage { quantity }`, and the billing e2e read the two metered fields.
    **The options.** Leave the selection, or drop it.
    **What I did.** Dropped it and `meterQuantity`; the billing e2e (run by hand, not run here) lost the two fields.

25. **What the plan said.** Phase 5: the redelivery test "can reuse the equal-version fixture".
    **What I found.** The webhook's version check skips an equal version before any fetch, so a redelivery that carries a version never rewrites.
    **The options.** Test the skip, or test a versionless redelivery.
    **What I did.** Delivered an edit (no version) twice against a fixed Shopify version in `shop-agent-sync-order.test.ts`, pinned on rule 2.

26. **What the plan said.** Phase 5: drop `WebhookDelivery` and the dedupe.
    **What I found.** `OrderWebhookInput.webhookId` was read by nothing else; the edited-webhook test proved it reached the object through the delivery row; the allowlist's `delivery` word served only `WebhookDelivery`.
    **The options.** Keep them, or cut them.
    **What I did.** Cut all three; the edited-webhook test keeps its non-200 assertion.

27. **What the plan said.** Phase 5: tests.
    **What I found.** The plan names one combined title for three tests (the data-model row and two repository tests).
    **The options.** None.
    **What I did.** Deleted the three; "a tracked sync whose instance is gone …" became "a tracking row older than ten minutes is deleted on the next press".

28. **What the plan said.** Phase 6: the vocabulary.
    **What I found.** The `reconcile all` row said "or whether a run may be created", which only the ceiling's release did.
    **The options.** Keep, or cut.
    **What I did.** Cut the clause.

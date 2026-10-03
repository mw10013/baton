# Spec simplification: rules and edge cases that can go

Written 2026-10-02. Status: decided 2026-10-02 after three reviews in Plannotator; plan in
`docs/spec-simplification-plan.md`, implemented 2026-10-02, not committed. Every numbered
recommendation is accepted; the draft stays as it is (Question A, tabled). Decisions are at the
end, and the plan's deviations after them.

The ask: read every spec in the code base and say what can be simplified, so there is less code,
fewer edge cases and a smaller model with fewer rules. The test for each finding is the one the
project already applied twice: a team rename never reaches a run task, because a run copies what
it needs at creation and is never revisited; and the retention sweep deletes an order past the
cutoff whatever its runs hold, because one date is a rule and "unless work is still open" is a
case. A rule that holds in one sentence beats a rule with exceptions, even when an exception is
reasonable on its own.

The specs read: the vocabulary and context map (`src/lib/Domain.ts`, `src/lib/domain/*.ts`),
the two data-model tables (`initializeSchema`, `D1_TABLES`), the sync tables on `syncOrder`, the
reconcile tables on `reconcileItem`, the action matrices on `runActions` and `taskActions`, the
run-state and block tables on `RunState` and `runIsBlocked`, the usage triggers table on
`ShopUsage`, the pipeline table on `ShopAgentHost`, and the copy and controls tables in
`Screen.ts`. The code was read where a fact about today's behaviour was needed; those facts are
marked "today:". Counts of files and test lines are from `grep` on 2026-10-02 and are rough
footprints, not measurements.

## The short version

Seven rules carry most of the edge-case weight. Each is a mechanism built to handle a case the
product's own principles say not to handle.

1. **The open-run ceiling and its release.** A 5000-open-run safety valve that nothing in the
   product needs, with decline, a flag, a banner, release detection on four writes, a reconcile
   all after release, a "runs once more, never twice" proof, and a Reopen exception. Five of the
   eleven pass rules and three rows of three tables exist for it. Section 1.1.
2. **The quantity badge.** Reconcile resizing an open run is one rule; the badge that remembers
   the old number has six clauses, a column, a check and two action rows of its own. Section 1.2.
3. **Orphans and truncation.** A run whose item is not stored, an order whose items were cut at
   250, a run whose order is gone: three rare states, each with its own clause, flag or sweep.
   The retention principle answers all three. Section 1.3.
4. **Reopen's downstream blocker and the reopen record.** Who stands in the way is computed per
   task on every read and carried to two pages; who reopened is three columns with three checks,
   cleared by the next Done. Section 1.4.
5. **Done is a record that is never replaced.** A done run is the one run a merchant cannot
   Change workflow over, which gives attach a fourth outcome and the run-state table an exception.
   Change workflow already erases started and blocked records behind a confirm. Section 1.5.
6. **The seat high-water mark.** Seats are billed as the cycle's highest member count, which
   needs a mark, a rise calculation, a push from the members page, and three trigger rows that
   distinguish a cycle push with the same start from one with a new start. Section 2.1.
7. **Diagnostics in the spec.** Meter divergence, expired usage events kept 60 days, five plan
   cache states, webhook delivery dedupe: operator conveniences carried as rules with tests.
   Sections 2.2 to 2.4 and 3.1.

Two larger questions follow the same principle but change what the merchant sees: whether the
draft stays (section 4.1) and whether the payment gate stays (section 4.2). Both are asked, not
recommended away.

## 1. Shop work

### 1.1 The open-run ceiling

Today: `ShopLimits.maxOpenRuns` is 5000. At the ceiling reconcile declines a create, raises
`openRunsLimitedAt`, and the orders index shows a banner. Every write that lowers the open-run
count (a run's last Done, Cancel workflow, a close by reconcile, the retention sweep) asks whether
the ceiling released, and a release runs a reconcile all over every stored open paid order,
outside the write's transaction, publishing to everyone. A reconcile all whose own closes release
the ceiling runs once more, never twice. Reopen is allowed at the ceiling and may go one over.
Manual attach answers `RunLimit`.

What it costs: pass rules 4, 5, 6, 7 and 11 on `reconcileItem`; the `declined` field on
`ReconcileAction` and the `nothing: declined` effects row; the `1, at the ceiling` rows of the
actions table (two); the `a write that lowers the open-run count` trigger row; the ceiling row on
`RunState`; `ShopUsage.openRunsLimitedAt`; `RunRepository.releaseOpenRunLimit`;
`ShopWorkAgent.afterCeilingReleased` and the `release` column of the pipeline table on
`ShopAgentHost`; the `ceilingReleased` field on two counts shapes; `AttachResult.RunLimit`; the
banner and its copy; the Reopen exception. Footprint: 8 files mention `declined`, 6 mention
`openRunsLimitedAt`, roughly 25 test lines.

What it protects against: storage. The order ceiling already bounds it: at most
`maxOrdersPerCycle` new orders a cycle, kept `orderRetentionDays`, so a shop stores on the order
of 1200 orders at most, and the open runs on them are a few thousand in the worst case the app
is not built for anyway. The JSDoc on `cycleAtOrderCeiling` says the order ceiling is positioning
rather than protection; the open-run ceiling is a second fence inside the first.

**Recommendation 1.** Remove the open-run ceiling: `maxOpenRuns`, the decline, the flag, the
banner, the release detection, the post-release reconcile all, and the Reopen exception. Pass
rules 4 to 7 and 11 go. The actions table loses its two ceiling rows and the `matches` column
goes back to `0`, `1`, `2+`. The effects table loses the `open-run ceiling flag` column.

### 1.2 The quantity badge

Today: reconcile rewrites an open run's quantity to the item's units. The first resize after a
task started sets `quantityChangedFrom` to the old quantity; a later resize keeps it; a resize
back to the original clears it; a Done clears it; a close clears it; a resize on an unstarted run
never sets it and clears any it has. The order page and the member's workflow page show
"Quantity changed · 3 → 2". Nothing reads it as a gate.

What it costs: a column; the `badge` field on `ReconcileAction.resize`; two actions-table rows
where one would do (`open, unstarted` and `open, started`); a four-title `pinned by` cell on the
resize effects row; `runIsUnstarted` as a reconcile input (it stays for `runHasRecord`); the
badge rule paragraph on `Run`; a clause in `markTaskDone`. Footprint: 5 files, roughly 20 test
lines.

**Recommendation 2.** Keep the resize and drop the badge. The rule becomes one sentence: an
open run's quantity equals its item's units to make. The maker reads the current number on the
card. If the shop wants to know the number changed, Shopify's order timeline has it.

### 1.3 Orphans and truncation

Three states, each with its own handling:

- **An order's items were cut at 250.** `ShopLimits.maxLineItemsPerOrder`;
  `ShopOrder.lineItemsTruncated`; the order page warns; pass rule 1 leaves a run alone when its
  item is not stored and the order is truncated; sync rule 10. Footprint: 10 files, 16 test
  lines.
- **A run whose item is not stored**, on an untruncated order. Pass rule 1 reads it as zero
  units and closes it `item_removed`. This is the main rule and it is right: a sync replaces the
  items whole, so an item that is not stored is an item Shopify no longer lists.
- **A run whose order is not stored.** The retention sweep's second statement deletes runs
  older than retention by their own `updatedAt` whose order is gone. The code's own comment says
  no live path leaves one. `Run.updatedAt` is kept for this reader alone. Footprint: 15 files
  mention orphan (most are the admin's orphan-object page, which is a different orphan).

**Recommendation 3.** Drop the truncation flag and its clause. Keep the fetch at 250 (it is the
API's page size) and store what comes back. A made-to-order shop does not place 250 distinct
lines on one order, and if one does, the run on line 251 closes as removed, which the merchant
reattaches by hand. Pass rule 1 loses its "unless" clause, sync rule 10 loses its flag, the
order page loses a warning, and `lineItemsTruncated` leaves the schema.

**Recommendation 4.** Drop the orphan-run sweep and `Run.updatedAt`'s stated reason. If no live
path leaves one, a sweep for it is a test surface for a state that does not occur. Should one
ever appear, the admin's object page can be the place to notice it.

### 1.4 Reopen

Today, Reopen carries two mechanisms beyond the verb:

- **The downstream blocker.** `reopenBlockedBy` finds the first started task in a later step;
  `RunTaskRow.reopenBlockedBy` carries it on every task of both run pages; `TaskActions.reopen`
  is three-valued (not offered, the button, the sentence); `RunResult.ReopenBlocked` names the
  blocker; `ReopenBlocker` is a schema; the `downstream` column of `taskActions` exists for it,
  with two rows and a `-` value. The merchant's order page draws the sentence, the member's page
  draws nothing. Footprint: 4 files, 12 test lines.
- **The reopen record.** `reopenedAt`, `reopenedByRole`, `reopenedByEmail`; three check
  constraints; the "latest only" data-model row; `markTaskDone` clears them; `taskReopenedBy`.
  Footprint: 7 files, 49 test lines.

**Recommendation 5.** Make `reopen` a boolean: offered when the task is done, the run is not
closed, and no task in a later step has started. The blocker is not named; the merchant reading
the order page sees the later task marked Started two cards down. `ReopenBlocker`,
`RunTaskRow.reopenBlockedBy`, `RunResult.ReopenBlocked` and the `downstream` column go; the two
`done` rows of `taskActions` become one.

**Recommendation 6.** Drop the reopen record. Reopen clears the started and done columns and
records nothing of its own, exactly as Put back does today. A reopened task reads Ready and the
next Done writes a fresh record. Three columns, three checks and one data-model row go.

### 1.5 Done is a record that is never replaced

Today: a merchant may Change workflow over an open or closed run but not over a done one;
`setRun` refuses with `ItemDone`, `AttachResult` carries the tag, `runActions.changeWorkflow`
is blank on a done run, `RunState`'s table has a row for it, and `LineItemState` has separate
`done` and `closed` kinds because only `closed` offers the picker. Yet Change workflow over a
started or blocked run already erases records, behind a confirm that names what is lost
(`runHasRecord`, decided 2026-10-02).

**Recommendation 7.** One rule: a person may replace any run, and the confirm says what is lost.
A done run is replaced like a started one; the confirm already says "started" and "done" records
go. `AttachResult.ItemDone` goes, the `RunState` row becomes "replaced by a manual attach:
always", `runActions.changeWorkflow` depends on units alone, and `LineItemState.done` and
`LineItemState.closed` become one kind with the run, its tasks and the picker.

### 1.6 Multi-match and payment

Today: multi-match has a payment clause in three places. The nouns row says "on an order that
can create runs; an unpaid order is not choosing, since reconcile would create nothing either
way"; `multiMatchItems` gates on `orderCanCreateRuns`; `orderIssues` applies the gate a second
time "once per twin"; the SQL twin carries `fullyPaid = 1`. The reasoning is that choosing early
is pointless because reconcile would not act. But the choice is a manual attach, and manual attach
is allowed on an unpaid order on purpose (deposits). So choosing early is useful, not pointless.

**Recommendation 8.** Multi-match is two or more matches, units to make, and no run. The payment
gate leaves the noun, the function, the issue and the SQL twin. The actions table's `2+` rows
collapse from two to one (`paid` becomes `any` for multi-match, since the outcome is `nothing`
either way).

### 1.7 Edit reason and the race results

Today: Block has a sibling verb, Edit reason, with its own input, modal, `runActions.editReason`
column and a race result `NotBlocked` for "the hold was lifted while the editor was open".
`RunResult` carries eight tags; four of them (`NotBlocked`, `NotReady`, `Terminal`, `Blocked`)
exist to word a toast for a click that raced a change on another screen, and the page re-reads
after any of them.

**Recommendation 9.** Drop Edit reason. To change a reason, Unblock and Block again; the block
is a hold, not a document. `editReason` leaves `runActions` and `RunActions`, `SetBlockReasonInput`
and `SetBlockReasonCommand` go, `NotBlocked` goes.

**Recommendation 10.** Collapse the race results. `RunResult` becomes `Ok`, `NotFound`,
`NotAllowed`. The toast for `NotAllowed` says the task changed and the page re-reads, which is
what every race toast does today in different words. The repository keeps its internal guards;
only the tags that cross the socket collapse.

### 1.8 Team delete

Today: a team delete goes to D1 first, then nulls every pointer on definition tasks, draft tasks
and run tasks; a retry repairs a partial failure; the next team delete for the shop nulls pointers
to any team already gone; the dialog shows three counts (`TeamDeleteCounts`: workflow tasks,
draft tasks, open run tasks) computed from the object; the teams index shows "Used by" through
`TeamWorkflowByTeam`.

The cross-store null is the one piece the user named as unavoidable, and it is. The counts are a
nicety: four schemas and a read for a dialog that could say "Tasks on this team become
unassigned until you assign another."

**Recommendation 11.** Keep the null-on-delete and the dangling-reads-as-null rule. Drop
`TeamDeleteCounts` and `TeamTaskCounts` from the dialog; the body says the consequence in words,
as the controls table asks. Keep "Used by" if the teams pages need it; it is a read, not a rule.

### 1.9 Smaller findings, shop work

- **`hasEmptyTeam` as an order issue.** `empty_team` ("Team has no members") is derived on the
  orders index from a current task whose team has no members, which needs the team member counts
  from D1 on every list read. The teams index already badges a team with no members. Cutting the
  issue removes a cross-store join from the hottest list and a row from the issues table.
  Recommendation 12: cut `empty_team` as an order issue; keep the teams index badge and the
  workflow page's banner, which read the same fact where it is fixed.
- **`v`, the visible member who may write a note.** A member whose team holds a later task may
  write a note and nothing else. One letter in the matrix, one `runIsVisibleTo`. Small; keep.
- **Seed rules in the spec.** "A seeded order is never counted" is a trigger row and a rule on
  `markSeedOrdersCounted`; `SEED_ORDER_ID_PREFIX` is a vocabulary-adjacent constant. Dev-only
  logic in a production spec. Recommendation 13: the seed writes `countedAt` itself and the spec
  row goes; the seed is not a trigger.

## 2. Billing

### 2.1 Seats

What Shopify needs from Baton. The members meter is a counter Shopify keeps per app
subscription, reset to zero at every billing cycle. Baton sends usage events, each a positive
number of units, and Shopify adds them up. The plan's tiers price the total: the first
`membersIncluded` units are the $0.00 band, the rest are billed. So Baton's whole job is to make
the cycle's total equal the number of seats the shop should pay for that cycle. The question
is what "the number of seats for a cycle" means, and how many moving parts it takes to send it.

**Today: the cycle's highest member count, reported as it rises.** The object keeps a mark,
`seatsThisCycle`. Two paths move it:

1. The members page. After an add, the Worker counts the D1 members and calls
   `recordMemberCount` with the count. If the count is above the mark, the object sends the
   rise as one event and raises the mark. This call is best-effort: if it fails the add still
   stands.
2. The revalidation. At least once a day, and on every plan change, the Worker reads the app
   subscription from Shopify and pushes the billing cycle into the object (`setBillingCycle`)
   with the current member count. If the cycle start is unchanged, the push raises the mark to
   the count if above it (catching up a failed path 1). If the start is new, the push resets the
   mark to the count, sends the whole count as the cycle's first event, and drops any seat events
   still queued inside the new cycle (there can be some, because the order-counting path rolls
   the cycle forward on its own when an order lands past the end, with the mark at zero). If the
   shop was never addressed before, it drops every event dated before the start.

A worked month, basic plan with 3 seats included. The shop has 5 members when the cycle starts
on 24 Jan. The push sends 5; Shopify bills 2. On 3 Feb a sixth member is added; the page sends
the rise, 1; Shopify's total is 6, billed 3. On 10 Feb a member is removed (5 members) and on 12
Feb one is added (6): nothing is sent, the mark is already 6. On 24 Feb the cycle rolls; the next
push sends 6 as the new cycle's first event.

What that costs: `seatsThisCycle`, `seatEventValue`, `recordMemberCount` on the object and the
client, `RecordMemberCountInput`, the members page's call and its failure handling, the
same-start versus new-start branch in `setBillingCycle`, the drop of queued events, the
"never addressed" case, and six trigger rows with three stated assumptions. Two paths that can
both move the mark is where the mess comes from: every rule has to say what happens when one
ran and the other did not.

**Option 1: the member count at cycle start, one event per cycle.** The revalidation push is the
only path. When the push sees a new cycle start, it sends the current member count as one event.
Nothing else ever sends a seat event. The mark, the rise, the members page's call and the
same-start branch all go; `setBillingCycle` on an unchanged start writes the dates and nothing
else.

The same month: the 24 Jan push sends 5, billed 2. The 3 Feb add sends nothing; Shopify's total
stays 5 for the rest of the cycle. The 24 Feb push sends 6, billed 3. So the sixth seat is free
from 3 Feb to 24 Feb. Your install example: a shop installs, the cycle begins, the push sends 0
(no members yet), and the five members added that afternoon are free until the next cycle,
when the push sends 5. With monthly cycles, the most any seat can be free is one cycle, and it
is only the cycle a member was added in. A shop whose team is stable pays exactly what it pays
today. Two details: the push lands at the first revalidation after the cycle starts, which is
within a day, so "count at cycle start" is the count on that day; and a shop on a trial has no
cycle, sends nothing, and is billed nothing, which is true today too.

Can it be gamed? Yes. A merchant with six members deletes three on the 23rd, the push on the
24th sees three, and the merchant re-adds them on the 25th; the three seats are free for the
cycle. The price is that those three members are locked out across the boundary (a delete is
access, the member row on `D1_TABLES`), the merchant does it every month, and each re-add mints
a new member id, which is harmless since history keeps emails. Inconvenient, but a merchant who
wants to can. Today's model and Option 2 are not gameable this way: a removal never lowers the
mark, and after the new cycle's push resets the mark to three, the re-add on the 25th is a count
above the mark and bills the rise within a day.

**Option 2: the mark, maintained by the revalidation alone.** Today the mark has two writers:
the members page after every add, and the revalidation push. Option 2 keeps the second and
deletes the first. The rule becomes: at every revalidation the Worker reads the member count and
pushes it with the cycle; the object raises the mark to the count when above it and sends the
rise; a new cycle start resets the mark to the count and sends the whole count. That is already
what `setBillingCycle` does on a push; Option 2 only stops the members page from also doing it.

What goes: `ShopAgent.recordMemberCount`, `ShopAgentClient.recordMemberCount`,
`BillingAgent.recordMemberCount`, `OrderRepository.recordMemberCount`, `RecordMemberCountInput`,
the members page's call and the paragraph on what happens when it fails, the "best-effort" and
"caught up by the next revalidation" reasoning on `setBillingCycle`, and three trigger rows
(member added above the mark, member added at or below it, member removed), replaced by one:
"revalidation, member count above the mark: mark raised, rise sent". The drop of queued seat
events on a new cycle start goes too: it existed because the members page could queue a seat
event between the counting path's roll-forward and the push, and with one writer nothing queues
a seat event but the push itself.

What stays: `seatsThisCycle`, `seatEventValue`, the same-start versus new-start branch, and the
drop of every event dated before the start on a shop never addressed (that one is about order
events queued during a provisional cycle and is not a seats rule).

What changes for the merchant: an add bills within a day (the daily revalidation, or sooner on
a page load that finds the plan cache stale) instead of at the moment of the add. Shopify's
total for the cycle is the same number it is today. The same month: 24 Jan push sends 5; the 3
Feb add sends nothing at the add, and the 4 Feb revalidation sees 6 above the mark of 5 and
sends 1; 10 Feb removal and 12 Feb add send nothing; 24 Feb push sends 6.

**Option 3: no members meter; `membersIncluded` is a hard ceiling per plan.** No seat events at
all; the add refuses past the plan's number. Simplest, but it contradicts the stated rule that
members bill and never refuse, and it makes the plan reach the object, which the entitlements
JSDoc argues against.

**Recommendation 14.** Option 2. Option 1 is smaller but can be gamed at the cycle boundary,
and a billing rule a merchant can step around is a rule the operator ends up policing. Option 2
removes the second writer, which is where every "what if one ran and the other did not" clause
comes from, bills every seat in the cycle it was added, and cannot be gamed.

### 2.2 Expired usage events

Today: an event whose cycle ended before Shopify accepted it is kept, skipped by the flush,
counted apart (`expiredUsageEvents`), shown on the admin shop page, and deleted after 60 days by
the retention sweep. `usageEventIsExpired`, `expiredUsageEventRetentionDays`, a sweep clause, a
data-model row, a trigger row, and the divergence tolerance's reasoning about them.

**Recommendation 15.** The flush deletes an expired event and logs it. The log line is the
record; nothing else bounds, counts or sweeps it.

### 2.3 Meter divergence

Today: every revalidation pushes Shopify's own meter quantities into the object
(`MeterQuantitiesInput`), which stores them (`meterQuantityOrders`, `meterQuantityMembers`),
computes per-meter pending units (`pendingOrderUnits`, `pendingMemberUnits`), and logs when the
difference exceeds the pending units (`meterDiverges`). Nothing is corrected from it. A null
can mean three things, documented in a paragraph measured on 2026-09-19.

**Recommendation 16.** Cut the divergence check: the input, the two columns, the two pending
counts, `meterDiverges`, the `meters checked` trigger row's storing clause. The admin shop page
shows Baton's counts; the Partner Dashboard shows Shopify's; an operator compares them when a
merchant asks.

### 2.4 Admin plan cache states

Today: `AdminShopPlanCache` has five states (`NeverFetched`, `Unsubscribed`, `Subscribed`,
`Stale`, `Unrecognized`) for the admin page, finer than the enforcement path's two. Small, pure,
tested.

**Recommendation 17.** Keep; it is a display function with no rule behind it. Listed so the
inventory is complete.

### 2.5 What stays in billing

The provisional cycle (`provisionalCycleStart`) stays: a run created between install and the
first revalidation has to count against something, and one function does it. The order ceiling
and its banner stay: it is the one fence the product wants. The counted order, set once and
surviving every sync, stays: it is the copy-at-creation principle applied to billing.

## 3. Orders sync

### 3.1 Webhook delivery dedupe

Today: `WebhookDelivery` keeps one row per Shopify delivery id for 7 days, swept by the
retention sweep; `recordWebhookDelivery` answers new or seen; a seen id returns before the
fetch. But the write it protects is already idempotent: the version check skips an older payload
and rewrites an equal one, which the JSDoc on `syncOrder` says is free. The dedupe saves one
fetch on a redelivery, which Shopify sends only after a failure.

**Recommendation 18.** Drop the `WebhookDelivery` table, its sweep, its retention window, its
data-model row and sync rule 2's first clause. A redelivery fetches and rewrites, which is
correct.

### 3.2 The stale tracking row

Today: the Sync open orders button is disabled while a tracking row is fresh
(`SYNC_STALE_MS`, 10 minutes); a stale row is asked about through the Workflows API on the next
press and deleted if its instance is gone. Sync rule 3.

**Recommendation 19.** A row older than 10 minutes is not running; delete it on the next press
without asking Cloudflare. The sync gives up at 5 minutes anyway, so a row older than 10 is
always dead.

### 3.3 What stays in sync

The version check stays: it is what makes a webhook, a stream and a button safe to interleave,
and it is three lines. The retention refusal for a new order past the cutoff stays: without it a
year-old order edited in Shopify would come back uncounted and bill twice. The fixed 30-day
query stays. The partial-file and give-up rules stay.

## 4. Two larger questions

### 4.1 The draft

Today: Edit creates a private copy of the workflow's tasks; every editor write goes to the draft;
Apply replaces the workflow's tasks whole and deletes the draft; Discard deletes it; Apply and
Turn on both refuse an unassigned task and an empty draft; `applyAndTurnOn` does both in one
call. Two tables, five inputs, four results, a route of 997 lines for the editor and a draft
section on the workflow page. The stated reason: an order arriving between two edits sees a
whole definition, never a half one.

What the draft guarantees is real and worth keeping: **a run is never created from a definition
that is half edited.** The first version of this doc called that case rare and proposed living
with it. That was wrong. Orders arrive at any hour, a webhook reconciles the order the moment it
is stored, and Delete team, a tag edit and Turn on each run a reconcile all over every open paid
order. A merchant who takes ten minutes to restructure a five-step workflow while it is on would
have every matching order in those ten minutes routed by whatever the definition was at that
second, and some of those runs would be wrong. A production workflow in the middle of an edit
must not create runs, full stop.

The draft is one way to guarantee that. The switch is another, and it already exists. Today a
workflow that is off creates nothing, its open runs carry on, and Turn on runs a reconcile all
that creates runs on every stored open paid order the workflow matches. So the rule can be:

**A workflow's tasks are edited while it is off.** Edit on a workflow that is on turns it off
first, with a confirm saying that new matching orders wait until it is turned on again. Every
edit writes the definition directly; there is no copy. Turn on refuses an empty workflow and an
unassigned task, exactly as it does today, and then its reconcile all creates the runs for every
order that arrived during the edit, from the finished definition. Nothing is lost and nothing
is routed by a half definition: an order that lands mid-edit sits in Not started for the
duration and gets its run at Turn on.

**Discard has to stay.** The first version of this section gave it up, and that was rejected on
review: a merchant who cannot get back to the last working definition will be afraid to edit at
all, and a merchant who has made a bad edit needs a way out other than remembering what it was.
Shopify Flow's model, which Baton's follows, has a draft with Apply changes and Discard changes,
and that familiarity is worth keeping.

So Discard needs a copy of the tasks to go back to. The question is which copy is the one being
edited:

- **Today: edit the copy.** The draft is a second set of task rows in two tables of their own,
  under their own ids, with its own position uniqueness; Apply carries the ids over to the
  workflow's tables and deletes the draft. The workflow can stay on while the merchant edits,
  because runs read the workflow's tables and never the draft's.
- **Alternative: keep the copy.** Turn off saves the tasks as one JSON value on the workflow row
  (`tasksBeforeEdit`, say). The editor writes the workflow's own tasks, directly. Discard changes
  restores the saved value and the editor shows the restored tasks; Turn on validates as today,
  clears the saved value, and its reconcile all routes every order that arrived during the edit.
  One column instead of two tables; Turn on is Apply; Discard is one update.

The saved copy is written by Turn off always, not by the first edit, so the rule is one
sentence: turning a workflow off saves its tasks, Discard changes restores them, Turn on forgets
them. A workflow turned off for some other reason carries a copy it never uses, which is
harmless. Discard on a workflow that has never been on restores to no tasks, as today.

What the merchant sees. Today: Edit, make changes under a Draft badge while the workflow keeps
running, Apply changes or Discard changes. Alternative: Turn off (or Edit, which turns off with a
confirm saying new matching orders wait), make changes, Discard changes or Turn on. The verbs
are Flow's; the one difference is that the workflow is off while edited, and orders that arrive
meanwhile sit in Not started until Turn on, when they are routed by the finished definition.

What the alternative removes: `WorkflowDraft` and `WorkflowDraftTask`, the two-table reasoning
on the DDL, `CreateDraftInput`, `ApplyDraftInput`, `ApplyAndTurnOnInput`, `DraftResult`,
`ApplyResult` (Turn on's `SwitchResult` already carries `NoTasks` and `TaskUnassigned`), the
"at most one draft" and "Apply replaces whole" data-model rows, the Apply trigger row, Edit as a
verb that creates something, and the draft section of the workflow page. What it keeps:
`DiscardDraftInput` and `DiscardResult` under new names, and the editor route, which now writes
the workflow's tasks.

One thing to check in the plan: a tag or name edit is immediate today and stays so; the tag edit
runs a reconcile all, which creates nothing from an off workflow, so it is harmless mid-edit.

**Question A.** Replace the draft tables with a saved copy and "edit while off", keeping
Discard? Recommendation: yes, if a workflow being off during its edit is acceptable; the orders
that arrive meanwhile are routed at Turn on, so nothing is lost, but the bench does not see them
until then. If an edit must not pause the workflow, keep today's draft as it is; nothing else in
this doc depends on it.

### 4.2 The payment gate

Today: `orderCanCreateRuns` is `fullyPaid` and not cancelled. It gates run creation only; a paid
order that goes unpaid keeps its runs. Manual attach ignores it. The actions table has a `paid`
column with four rows for `no`, all answering `nothing`. `AUTHORIZED` is not paid.

Without it, reconcile creates runs on any open order with a match. A fraudulent or abandoned
order would start work; Shopify's own payment states are the merchant's protection, and the
merchant cancels in Shopify, which closes the runs.

**Question B.** Keep the payment gate? Recommendation: keep it. It is one boolean read, and
starting bench work on an unpaid order is a real cost in a made-to-order shop. The `paid` column
stays; with recommendations 1 and 8 it has two `no` rows instead of four.

## 5. What the simplifications do to the specs

With every recommendation accepted and the draft kept:

| spec                           | today                       | after                                                    |
| ------------------------------ | --------------------------- | -------------------------------------------------------- |
| `reconcileItem` actions table  | 17 rows, 5 columns          | 11 rows, 5 columns (`matches` without the ceiling value) |
| `reconcileItem` effects table  | 5 rows, 5 columns           | 4 rows, 4 columns                                        |
| `reconcileItem` pass rules     | 11                          | 6                                                        |
| `reconcileItem` triggers table | 14 rows                     | 13 rows (the ceiling release row goes)                   |
| `taskActions` matrix           | 9 rows, `downstream` column | 8 rows, no `downstream`                                  |
| `runActions` matrix            | 8 rows, `editReason` column | 8 rows, no `editReason`                                  |
| `RunResult`                    | 8 tags                      | 3 tags                                                   |
| `AttachResult`                 | 8 tags                      | 6 tags                                                   |
| `ShopUsage` triggers table     | 18 rows                     | 13 rows (Option 2 for seats)                             |
| `syncOrder` invariants         | 17                          | 15                                                       |
| object data-model table        | 33 rows                     | 28 rows                                                  |
| object tables                  | 12                          | 11 (no `WebhookDelivery`)                                |
| `Run` columns                  | 22                          | 20                                                       |
| `RunTask` columns              | 17                          | 14                                                       |
| `ShopUsage` columns            | 11                          | 6                                                        |
| `ShopLimits`                   | 9 entries                   | 6 entries                                                |

The counts are from reading the tables and will move a little in the plan.

## 6. What stays, and why

- **Copy at creation.** A run snapshots its workflow, order and item, and a task snapshots its
  team's name and its actor's email. This is the principle the rest of the doc applies; nothing
  here weakens it.
- **Retention is blind.** One date, one delete, open runs included.
- **A closed run holds its item.** Reconcile never undoes a cancel or restarts work Shopify
  ended. One rule, and it is what keeps reconcile idempotent.
- **One run per item, single match only.** Multi-match asks; it never guesses.
- **The stop gate and the creation gate.** Cancelled or fulfilled closes; paid creates. Two
  gates, each one predicate.
- **The version check.** Three lines that make three writers safe.
- **The order ceiling.** The one fence.
- **The null-on-team-delete.** Unavoidable across two stores, and the user has already accepted
  it.

## Recommendations, gathered

1. Remove the open-run ceiling and everything that serves it (1.1).
2. Keep the resize, drop the quantity badge and `quantityChangedFrom` (1.2).
3. Drop the truncation flag and its reconcile clause; store what the 250 fetch returns (1.3).
4. Drop the orphan-run sweep (1.3).
5. `reopen` is a boolean; the blocker is not named (1.4).
6. Drop the reopen record: `reopenedAt`, `reopenedByRole`, `reopenedByEmail` (1.4).
7. A person may replace any run, done included; the confirm says what is lost (1.5).
8. Multi-match has no payment gate (1.6).
9. Drop Edit reason; Unblock and Block again (1.7).
10. `RunResult` is `Ok`, `NotFound`, `NotAllowed` (1.7).
11. Drop the team delete dialog's counts; keep the null-on-delete (1.8).
12. Cut `empty_team` as an order issue; keep the teams index badge and workflow page banner (1.9).
13. The seed writes `countedAt` itself and leaves the spec (1.9).
14. The seat mark is maintained by the revalidation alone; the members page stops writing it
    (2.1, Option 2).
15. The flush deletes an expired usage event and logs it (2.2).
16. Cut the meter divergence check and Shopify's stored quantities (2.3).
17. Keep `AdminShopPlanCache` (2.4).
18. Drop `WebhookDelivery` and the dedupe (3.1).
19. A stale tracking row is deleted on the next press without asking Cloudflare (3.2).

## Questions

Each with a recommendation. Answer in place.

- **A. Replace the two draft tables with a saved copy, editing while off, keeping Discard?**
  Tabled: the draft stays as it is (see Decisions). The section stands as the record of the
  alternative.
- **B. Keep the payment gate?** Recommendation: yes (4.2). One boolean, and starting unpaid
  work is a real cost.
- **C. Remove the open-run ceiling outright (recommendation 1), or keep a hard stop with no
  release?** Recommendation: remove. A hard stop with no release still needs the flag, the
  banner and a merchant act to clear it; the order ceiling already bounds storage.
- **D. Reopen: drop only the blocker's name (recommendation 5), or also drop the downstream rule
  and let any done task reopen?** Recommendation: keep the rule as a boolean. Reopening under a
  started later step leaves a started task that is not current, which no verb can move.
- **E. Replace a done run (recommendation 7): behind the existing confirm, or refuse as today?**
  Recommendation: behind the confirm. Started and blocked records already go that way.
- **F. Seats (recommendation 14): Option 1, the count when the cycle is first seen, one event
  per cycle; Option 2, the mark maintained by the daily revalidation alone; or Option 3, no
  meter and a per-plan ceiling?** Recommendation: Option 2. Option 1 can be gamed by removing
  members before the boundary and re-adding after; Option 2 removes the members page as a writer
  of the mark, bills every seat within a day, and cannot be gamed.
- **G. Drop Edit reason (recommendation 9)?** Recommendation: yes. It is the smallest cut here
  and the easiest to put back.
- **H. Cut `empty_team` as an order issue (recommendation 12)?** Recommendation: yes. The fault
  is fixed on the team page, where it is already shown.
- **I. Drop webhook dedupe (recommendation 18)?** Recommendation: yes. The version check makes a
  redelivery a free rewrite.

## Decisions

Answered 2026-10-02 in Plannotator, first pass:

- Recommendations 12 (cut `empty_team` as an order issue) and 13 (the seed leaves the spec)
  accepted; the `v` letter stays.
- B: the payment gate stays.
- C: the open-run ceiling is removed outright.
- D: Reopen is a boolean; the downstream rule stays, the blocker's name goes.
- E: a done run is replaced behind the existing confirm.
- G: Edit reason goes.
- H: `empty_team` leaves the order issues.
- I: the webhook dedupe table goes.
- A (the draft) and F (seats): sent back for a fuller explanation; sections 4.1 and 2.1 were
  rewritten.

Second pass, 2026-10-02:

- Recommendations 1 to 11, 15 to 19 and every item of 1.9 accepted. With the first pass, every
  numbered recommendation except 14 is accepted.
- F (seats): asked whether Option 1 can be gamed (it can, at the cycle boundary) and what Option
  2 removes against today (one of the mark's two writers). Section 2.1 answers both;
  recommendation 14 is now Option 2.
- A (the draft): "edit while off" rejected as written because it gave up Discard, which the
  merchant needs, and because the Flow model (draft, Apply changes, Discard changes) is the
  familiar one. Section 4.1 was rewritten to keep Discard through a saved copy on the workflow
  row, still editing while off.

Third pass, 2026-10-02:

- F: recommendation 14, Option 2, accepted.
- A: tabled. The draft stays as it is. "Edit while off" is a model the merchant would have to be
  taught, where Flow's draft lets a running workflow be edited and is what the merchant expects.
  Tempting to remove, but a stranger model; to be slept on, not decided now.

Every numbered recommendation is accepted. The plan covers 1 to 19 with 14 as Option 2 and
leaves the draft, `WorkflowDraft` and `WorkflowDraftTask` untouched.

## Deviations

From the plan's "Recorded during implementation", one line each:

- The effects table's close row is pinned on "a line at zero units closes its run as item_removed"; the one `nothing` row is `nothing`.
- The pass rules renumber to six by arithmetic: idempotence is rule 5.
- `Domain.RunLimit` (list depth) stays; only `AttachResult`'s `RunLimit` went.
- The retention test lost its orphan and "plus orphaned runs".
- Five more ceiling or payment-gate tests deleted; one replaced by "a multi-match item on an unpaid order is an issue".
- The snapshot test triggers its reconcile all through `removeWorkflow`.
- `reconcileItem` reads no tasks; `RunListRun` omits `quantity`.
- Badge and gate fallout retitled or re-expected; the e2e `E2E Shrunk` fixture went.
- Departure 2's sample row put `M` under `cancel`; the rule keeps it blank.
- The merged item kind is `ended` (the lint refuses "run"); five kinds.
- A done run's Change workflow is in Manage behind the confirm; the picker at rest stays under a closed run.
- `RunNotBlockedError` and `TaskNotReadyError` stay internal, mapped to `NotAllowed`.
- `RecentItem` carries `laterStepStarted`; `RunSteps.renderExtra` went.
- The agent's reopen gate read `reopen !== null`; fixed to the boolean.
- The started/done pairs row was retitled without the reopened times.
- Edit reason, reopen-record and blocker-cell tests deleted; several retitled; "setRun over a done run replaces it and reports it as replaced" added.
- `NotAllowed` copy is one sentence per subject (task or workflow), not per verb.
- The orders index keeps its one D1 team read; `listOrders` reads no member count.
- The order page's "No members on <team>" line went with the issue.
- The seed's `countedAt` was first an input on `upsertOrder`; the review (below) put it back as the seed-only `markSeedOrdersCounted`.
- Departure 2 at planning time: the done and closed rows of `runActions` split by units.
- Empty-team and team-count test fallout deleted, retitled or moved.
- Four more billing tests deleted (dropped statement, divergence, meter reads); two seat tests re-driven.
- `sweepExpiredOrders` returns `{orders, runs}`.
- `ShopifyPartner` no longer selects meter usage; the hand-run billing e2e lost two fields.
- The redelivery test is a versionless edit delivered twice, since an equal version is skipped before any fetch.
- `OrderWebhookInput.webhookId` and the allowlist's `delivery` went with the dedupe.
- Three delivery tests deleted; the tracked-sync test became the stale-row test.
- The `reconcile all` vocabulary row lost "or whether a run may be created".

Reviewed 2026-10-02 after implementation; the gate passed and the 28 deviations matched the code. Changes from the review:

- The seed-only `OrderUpsert.countedAt` went back to `markSeedOrdersCounted`: an input on the general upsert let any caller exempt an order from billing.
- The `RunState` row and the `changeWorkflow` bullet now say a closed run is replaced from the picker with no confirm; the done run keeps the confirm (deviation 11).
- Stale prose fixed: pass rule 9 is 5 on `syncOrder` rule 16; `blockedBy`, `RunItem`, `ClampedProse`, `COUNT_FACT`, `listOrders`' team comment, `TeamWithMemberCount`, `OrderPageData.teams`, `WorkflowTaskView.memberCount`, the mechanism-column list, `BillingAgent`'s row on the object map, `BillingCycleInput`, `RunNotAllowedError`, the one-order sync, the webhook route's rule 2 sentence.
- `TeamIssueBanners` is `TeamFaultBanners`.
- The member pages' `NotAllowed` banner adds the effect sentence the `banner` slot asks for.
- Added "a cycle push sends the seat event it queued" at the object, since the deleted meter-check test was the only one that saw a push send.
- The edited-webhook test now asserts the object's `status=fetch` line for the order, since a 500 alone could be a decode failure.

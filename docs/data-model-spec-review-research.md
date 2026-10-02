# Data-model spec review: gaps, contradictions and open questions from first principles

Written 2026-10-02. Status: decided 2026-10-02, every question answered; plan in
`docs/data-model-spec-plan.md`, implemented 2026-10-02 (uncommitted; deviations recorded in the plan). Decisions are under each section and in the
Questions list.

The ask: the two data-model tables, on `initializeSchema` in `src/lib/ShopAgentSchema.ts` (the
shop's Durable Object) and on `D1_TABLES` in `src/lib/D1Schema.ts` (D1), were written after the
code, from the code. Read them as a spec for a made-to-order production app, from first
principles and ignoring the implementation, and say where they are incomplete, contradictory or
unclear, so the spec can drive the schema, the write paths and the tests rather than describe them.

This doc reads the two tables, their preambles, the vocabulary tables in `src/lib/Domain.ts` and
`src/lib/domain/`, and the DDL the tables claim to govern (`initializeSchema`'s SQL and
`migrations/0001_init.sql`), because the DDL is part of what the spec must agree with. It reads
the code only where a fact is needed about what happens today; those facts are marked "today:".
A finding about the code is a finding about the spec: either the spec should say it, or the code
should stop doing it.

## The short version

1. **Nine rows are pinned by nothing.** Eight in the object table, one in D1. A spec that drives
   tests cannot carry an unpinned row; each is either pinned or struck. Section 1.
2. **The object table contradicts itself and its own DDL in three places.** The counted mark on a
   seed order (the row says the seed sets it, the column comment says it is always null); a run
   "snapshots its item and survives every edit" while reconcile resizes an open run's quantity;
   and "no history" on a workflow while nothing says what replacing a run does to the old run.
   Section 2.
3. **Three product rules, each decided.** Retention deletes old orders whatever their work
   holds, and the row stands. Uninstall destroys the object, which the D1 row says it does not: the
   row is wrong, not the code. A shop is identified by its domain; Shopify's one-time domain rename
   is not supported. Section 3.
4. **The spec's own conventions slip.** `about` says `task` for a definition task where the
   vocabulary says `workflow`; rows name columns though the preamble says never; numbers are
   "retention", "60 days" and "a while" in three rows; one row duplicates the vocabulary's
   stored cell and is pinned by a behaviour test. Section 4.
5. **Rules with no row.** Which test kind pins a `schema` row versus an `app` row; who the
   merchant is in D1; how a member row meets a better-auth user; the consistency pairs on a run
   task (`startedAt` with its role, `doneAt` with its role); the billing counters' derivation;
   what a draft must satisfy; a run's lifetime in the spec's lifetime words. Section 5.

Every recommendation is numbered. The questions that need the user are gathered at the end, each
with a recommendation.

## 1. Unpinned rows

The object table's `pinned by` is "(none yet)" on:

- a workflow has zero or more steps in order; a step has one or more tasks; a task is in exactly
  one step
- definition tasks change only by Apply, whole, in one transaction
- run `state` is derived from the tasks and stored; `closed` is the exception
- who did what is a snapshot; history never resolves through `Member` or `Team`
- reopen is latest only; a later Done clears it
- `WebhookDelivery` is one row per delivery id, kept for a while and swept by age

D1's table has one: uninstall deletes the shop, its members and teams go with it, the object
survives and is swept as an orphan.

Three of these are the rules the product most depends on (steps and tasks, Apply is atomic, run
state is derived). `pnpm spec check` accepts "(none yet)" today, so the gap is invisible.

**Recommendation 1.** Pin every row or strike it. A row with no test is not yet a rule the spec
holds; it is a note. Add a `pnpm spec check` count of "(none yet)" rows with a ceiling that only
goes down, or refuse the word outright once the nine are pinned.

**Recommendation 2.** Say which kind of test pins which `holds by`. A `schema` row is pinned by a
test that writes a violating row straight to the store and expects the refusal (the unique index
test on item is the model). An `app` row is pinned by a test through the write path. A
`schema+app` row has both halves in one test, or names two titles. The preamble says `holds by`
is "the implementer's report of who guarantees the rule" and says nothing about the test; today
some `schema` rows are pinned by write-path tests, which pass even if the constraint is dropped.

## 2. Contradictions

### 2.1 The counted mark on a seed order

The row: "an order's counted mark is set at most once, by its first run or, for a seed order, by
the seed". The column comment on `countedAt`: "Null until Baton first creates a run for the
order, and always null on a seeded one". These cannot both hold. Beyond the contradiction, "seed"
is a development mechanism (`pnpm seed`) in a product spec; a merchant has no seed.

**Recommendation 3.** Keep the rule to its product half: "set at most once, when the order's
first run is created; survives every sync; only deleting the order removes it." If the dev seed
must pre-mark orders so a seeded store does not fill the meter, that is a fact about the seed
script, stated on the seed script. Fix the column comment to match. Question 1.

### 2.2 A run's quantity

The row: "a run snapshots its workflow, order and item and references none of them; it survives a
workflow delete and every edit to the three". The DDL has `Run.quantity` and
`Run.quantityChangedFrom`, and the vocabulary says reconcile "resizes an open run" and that units
to make is "Shopify's current quantity". So an item edit does reach the run: an open run's quantity
follows the item, and `quantityChangedFrom` remembers what it was. The row says the opposite.

The spec's own derivation words can say this precisely. Identity and title are "snapshots";
quantity is "derived and stored" from the item while the run is open and frozen once the run is
done or closed.

**Recommendation 4.** Split the row. "A run snapshots its workflow's and order's identity and
name, and its item's identity, title, variant, SKU and properties; it references none of them and
survives a workflow delete." Then: "an open run's quantity follows its item's current quantity on
every reconcile and `quantityChangedFrom` holds the quantity it was created with; a done or closed
run's quantity is frozen." Pin the second with a test whose title is the row. Question 2 asks
whether `quantityChangedFrom` is the creation quantity or the last one, since the DDL does not say.

### 2.3 Replacing a run

The item row says "a closed run holds its item until a person replaces it", and `lineItemId` is
unique over every state. So Change workflow and Attach on an item with a closed run must delete the
old run and its tasks. No row says so. "No history" is stated for workflows and members, not for
runs, and the run rows read as if a run is only ever deleted with its order.

This is a product decision, not a detail: a merchant who cancels a run after a member finished two
tasks, then attaches another workflow, erases the record of that work. The orders index and the
member's history show nothing of it.

**Recommendation 5.** State a run's lifetime in the spec's lifetime words: "a run is deleted by
its order's retention and by a person replacing it, and by nothing else; a replaced run leaves no
history." If that is not the product, the alternative is a partial unique index (one _open_ run
per item) and closed runs kept beside the new one, which changes the item row and the matrices'
`changeWorkflow` column. Question 3.

## 3. Product rules, decided

### 3.1 Retention and open work

The row: "an order older than retention is deleted, its items and its runs go with it, and it is
never stored again". Retention is `ShopLimits.orderRetentionDays`, 365 days on `processedAt`. The
question raised was whether an order with an open run should be spared, since long-lead shops and
back-dated imports exist.

**Decision (2026-10-02): no.** Retention deletes every order past the cutoff, open run or not. The
case for sparing open work was the long lead time; it does not outweigh a second rule on the
sweep, a second index condition, a second test and an order that can never leave. Work still open
a year after the order was placed is an edge case the sweep may take with the order. The row stands
as written; Recommendation 6 is withdrawn.

### 3.2 Uninstall

The D1 row: "uninstall deletes the shop and its members and teams go with it; the object survives
and is swept as an orphan", with a paragraph saying this records current behaviour. It does not.
Today: the uninstall webhook flushes the usage outbox, deletes the shop row and destroys the
object, and a destroy failure returns non-2xx so Shopify retries the teardown. The compliance
route's JSDoc says the same and says why `shop/redact` is a no-op: acting on it would resurrect a
destroyed object to delete it again, and Shopify does not say whether it fires after a reinstall
inside the 48-hour delay. The orphan page exists for an object with no row or no stored data, not
for the uninstall path. The row is wrong about the code it was written from.

**Decision (2026-10-02): uninstall deletes the object.** No reinstall re-adoption, no redact rule.
An object that outlives its shop is a failed destroy, visible in the logs, cleaned up by hand.

**Recommendation 7 (replaces the earlier one).** Rewrite the row: "uninstall deletes the shop
row, its members and teams go with it, and destroys the object whole; a reinstall is a new shop
with nothing; `shop/redact` does nothing more." `holds by` `schema+app`, pinned by a test that
runs the uninstall handler and finds no row and no object. Strike the paragraph under the table
that says the object survives.

### 3.3 A shop is identified by its domain

The row: "a shop is identified by its domain". The question raised was whether Shopify lets a
merchant rename the `myshopify.com` domain, which would make the domain an unstable identity.

Evidence. Shopify's Help Center, on the business settings page: "You can change it only 1 time
from your Shopify admin", "the previous `myshopify.com` domain automatically redirects to the new
one", and, on third-party apps, "third-party apps or services might ask for your `myshopify.com`
as a Shopify account ID or account number to connect your account". So a rename is real, once per
store, and Shopify itself tells merchants that apps treat the domain as the account id.

What a rename does to Baton, with nothing changed. The admin session token and every webhook
carry the new domain. The app has no row for it, so the merchant is taken through install as a
new shop: a new row, a new object, no workflows, no runs, no members. The old row stays, its
token dead, and the old object stays with the work in it. Neither is visible to the orphan page,
which lists objects with no row. Nothing breaks; the merchant starts over and an operator cleans
up the old pair by hand.

What supporting it would cost. The shop's Shopify id (`shopGid`) would become the row's key and
the object id's source, and the domain a unique, rewritable column beside it; every site that
reads a shop by domain (session lookup, the webhook handler, the member's shop picker, the member
routes' `$shop` segment, log lines) would resolve the domain to the id first. It is not "the gid
everywhere": the domain stays the name on every screen, in every URL and in every log line, and
the id is the join key under it. It is one column, one derivation and a lookup in the session
path, plus a handler for `shop/update` to move the domain. It is also a store a merchant renames
once in its life, if ever.

**Decision (2026-10-02): not supported.** A domain rename reads as a new shop. The row stands.
Recommendation 8 is replaced by: add to the row "a renamed domain is a new shop; the old row and
object are removed by hand", so the next reader does not take the gap for an oversight.

Sources: [Shopify Help Center, business settings](https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-business-settings).

## 4. The spec's conventions slip

### 4.1 `about`

The vocabulary says `task` is "one unit of work on a run, on one team" (`RunTask`) and that
`workflow` covers `Workflow` and `WorkflowTask`. The object table files "a task's team points to a
D1 row" (a definition task rule) under `task`, and files every draft rule under `workflow` though
`draft` is a vocabulary word, and has no row that says `step`. A reader using the vocabulary cannot
find the definition task rules.

**Recommendation 9.** `about` is the vocabulary noun the rule's subject is: definition task rows
say `workflow`, draft rows say `draft`, and the steps row says `step`. Have `pnpm spec check` hold
`about` to the nouns tables plus the table names, which it may already do; if it does, the nouns
table is what lets `task` through, and the fix is in the rows.

### 4.2 Columns in rules

The preamble: "it says what is true of the data, never which column or index makes it true". Eight
rows name columns (`countedAt`, `state`, `closedAt`, `closedReason`, `*ByEmail`, `teamName`,
`idempotencyKey`). They are right to: the vocabulary's state tables name the same columns in their
`stored` cells, and a rule about consistency ("set together") has to name what is set.

**Recommendation 10.** Amend the preamble: a rule names a column when the column is a vocabulary
`stored` cell or the subject of a consistency word, and never names an index. That is the line
the rows already keep.

### 4.3 Numbers

"older than retention", "60 days", "kept for a while and swept by age". The first names a rule
without its symbol, the second a number without its symbol, the third nothing. "A while" is not a
rule; the rule is "kept at least as long as Shopify retries a delivery", and the number
(`webhookDeliveryRetentionDays`, 7) is the implementer's report.

**Recommendation 11.** Every duration row names its `ShopLimits` symbol and says the reason the
number must exceed, never the number: "kept past `webhookDeliveryRetentionDays`, which exceeds
Shopify's retry window", "deleted past `expiredUsageEventRetentionDays`, which exceeds the dispute
window". The number lives once, on `ShopLimits`.

### 4.4 A row that duplicates the vocabulary

"`state` is stored, never derived: `on` or `off`" restates the workflow states table's `stored`
column, and is pinned by "a workflow that is on creates runs on every stored open paid order,
however old it is", a reconcile behaviour that proves nothing about storage. `AGENTS.md`: a rule
is stated once.

**Recommendation 12.** Strike the row. If a structural rule about the switch is wanted, it is
"turning a workflow off deletes nothing and closes nothing" (lifetime), which the vocabulary's "open
runs carry on" implies and no test pins.

## 5. Rules with no row

### 5.1 Who the merchant is

The DDL comment on `RunTask`: "a 'merchant' role, who acts from the order page and has no Member
row". The D1 table has no row saying the merchant is not a member and that a merchant's identity is
the Shopify admin session. A member who is also the shop's owner acts in two roles with no link.

**Recommendation 13.** D1 row, `about` `shop`: "the merchant is the admin session, not a member;
a member row never stands for the merchant, and run history records a merchant act with the role
and no email."

### 5.2 A member and a better-auth user

A member is "identified by shop and email; sign-in identity is the email", and `User.email` is
unique across every shop. So one person on three shops is one `User` and three `Member` rows, and
the only join is the lowercase email at sign-in. Nothing points either way, which is right, and no
row says it. Member email changes are delete and re-add, which mints a new id and leaves teams, and
that is a product fact a merchant will meet.

**Recommendation 14.** D1 row, `about` `member`: "a member is matched to a signed-in user by
email at sign-in and at no other time; nothing points from a member to a user or back; a member's
email never changes, so a change is a delete and an add."

### 5.3 Consistency pairs on a run task

The DDL checks `(reopenedAt is null) = (reopenedByRole is null)` and nothing for the other two
pairs. The spec has words for this ("set together", "cleared together") and uses them only for the
close and the block. On a run task: `startedAt`, `startedByRole` set together and cleared together
by Put back; `doneAt`, `doneByRole` set together and cleared together by Reopen; a `member` role
has an email beside it and a `merchant` role has null; done implies started, since a Done without a
Start records its actor as the starter (the action-matrices review decided that; this doc first
assumed the opposite).

**Recommendation 15.** One row per pair, `holds by` `schema+app`, with the checks added to the DDL
so a role without its time cannot be written, and a sixth check that a done task is a started
one.

### 5.4 The billing counters

`ShopUsage` has one row in the spec: "exactly one row". Its fields carry rules the triggers table on
`ShopUsage` in Billing implies and the data-model does not state: `ordersThisCycle` is recounted
from counted orders when the cycle moves, so it is "derived and stored" from `countedAt`;
`seatsThisCycle` is a high-water mark, "stored, never derived", reset by a new cycle; whether
`cycleStartAt` and `cycleEndAt` are set together or a provisional cycle has a start and no end.

A provisional cycle is the stand-in a shop counts against before Baton knows its real billing
cycle. A shop's first counted order can land before its first plan revalidation (a webhook arrives
on the install's heels) or during a trial, which has no billing cycle. Rather than refuse to count,
the object opens a cycle starting at the first instant of the current UTC month, counts against
that, and the first real billing cycle replaces it (`provisionalCycleStart` in Billing, and the
"cycle pushed, shop never addressed" trigger row). Today: the provisional cycle has a start and no
end; `cycleEndAt` is null until a real cycle is set.

**Recommendation 16.** Three rows on `ShopUsage`, in the derivation and consistency words, each
pinned by a triggers-table title where one fits. The triggers table stays the behaviour spec;
these rows say what shape the data has between triggers. Question 7 covers the provisional
cycle's end.

### 5.5 What a draft must satisfy

"A workflow has zero or more steps in order; a step has one or more tasks" is stated for the
workflow. The draft has the same shape and the spec does not say whether it obeys the same layout
rule at every write or only at Apply, nor whether Apply of an empty draft is a workflow with no
tasks or a refusal.

**Recommendation 17.** "The draft obeys the workflow's layout rule at every write; Apply refuses a
draft with no tasks, and the workflow keeps its tasks." Revised at implementation: the code
already refused it, pinned by its own test, and a refusal keeps a live workflow from being emptied
by a stray Apply; an empty workflow would not be eligible anyway. Add "steps are
numbered from 1 with no gap" to the layout row, since that is the rule the pure layout module keeps
and the DDL comment explains.

### 5.6 Team name on an open run

"A run task also snapshots its team's name; history shows the name and never resolves the team." A
rename of "Finishing" to "Finish" therefore shows the old name on every open run's task for as long
as the run lives, while the definition and the team page show the new one. For history that is
right. For open work it is a visible inconsistency in the member's list, which filters by the live
team id and labels by the stale name.

**Recommendation 18.** Leave it. A run copies everything at creation and the rule is simple to
state and to test; a rewrite on rename is a second cross-store write with its own half-done case
and retry, for a cosmetic stale name on open work. State the row as it is ("a run task snapshots
its team's name at creation; a rename never reaches it") and pin it. Decided 2026-10-02: Question 8 went this way.

### 5.7 Which orders are stored

The order rows say what a stored order is and when it leaves. Nothing in the data-model says which
orders are stored at all; that is the sync rules on `syncOrder` in Orders. A reader of the
data-model should be sent there.

**Recommendation 19.** One row: "which orders are stored, and what a sync does to an order's
items, is the rule on `syncOrder`; a sync replaces the order's items whole, and an item Shopify no
longer lists is deleted" if that is the rule, or "is kept at zero quantity" if that is. Today the
item rows say nothing about what a sync does to items, though `closedReason` has `item_removed`.
Question 9.

### 5.8 Item tags

"`productTags` is a snapshot taken at sync time" is on the `OrderLineItem` schema in Orders, not in
the table. Together with "a workflow is identified by its tag" it is the whole matching contract:
a tag edit in Shopify reaches Baton on the next sync and no earlier.

**Recommendation 20.** Item row: "an item's product tags snapshot the product at sync; the next
sync overwrites them; a run created from them is not revisited." Question 10 asks whether tag
comparison is exact or case-insensitive, since Shopify's admin treats tags case-insensitively and
the workflow row says the name is compared exactly without saying the same of the tag.

### 5.9 A usage event that is refused forever

"One row per idempotency key, kept until Shopify accepts it" and "an expired event is kept 60 days
then deleted". A refused, unexpired event is retried on every flush with no ceiling. It expires when
its cycle ends, so the bound is one cycle; the spec should say that is the bound.

**Recommendation 21.** Amend the row: "kept until Shopify accepts it or its cycle ends, whichever
first; a refused event is retried on every flush until then."

### 5.10 A member's access

"A member's access is the row: no role, no state." So a merchant cannot pause a member without
deleting them and losing their team memberships. Acceptable now; worth saying it is a choice.

**Recommendation 22.** No change; add Question 11 so the choice is on record.

### 5.11 Who repairs a half-done team delete

"A retry repairs a half-done delete." The row does not say who retries. If it is the merchant
pressing Delete again on a team that is already gone from D1, the screen has to offer that; if it
is a sweep, the spec should name it.

**Recommendation 23.** Say which: "the next team delete for the shop, and the orphan sweep, null
pointers to any team that is gone." Question 12.

## 6. Does the model fit the product

Read as a whole, the model is: identity in D1 (shop, member, team), work in the shop's object
(order mirror, definitions, runs), billing counters beside the work, pointers from work to identity
by id and never back. That is the right split for a Durable Object per tenant and the right
direction for the pointers. The decisions that matter most and are not written down:

- **One run per item, not per unit.** `lineItemId` unique means five chairs on one line are one
  run with quantity 5. A bench that makes chairs one at a time has no per-unit state. The
  vocabulary's "units to make" and the quantity on the card say this is deliberate. It should be a
  row, so the next person does not read the unique index as an accident. Question 13.
- **A run is for an item on an order, never for stock.** A made-to-order shop sometimes makes
  ahead. Nothing in the model allows a run without an order, and nothing should yet; the row above
  says so by implication.
- **Every history fact is a snapshot and no history row exists.** Who did what is on the task;
  what was replaced is gone; what was deleted is gone. The spec says "no history" on workflows and
  members and should say the same on runs (Recommendation 5), so the absence of an event table is a
  stated choice.

**Recommendation 24.** Add a short paragraph above the object table that states these three
choices in the spec's words, so the table's rows are read against them.

## Questions

All decided 2026-10-02. The decision is the rule; a changed row and its test follow.

1. **Counted mark on a seed order.** Decided: the product rule is "first run only"; the seed's
   behaviour is the seed script's business and leaves the spec.
2. **Which quantity does `quantityChangedFrom` hold.** Decided 2026-10-02, revised the same day at
   implementation: the quantity the maker was working to, not the creation quantity. The badge rule
   on `Domain.Run` is the rule: the first resize after a task started or was done sets it to the
   quantity before that resize; a resize on an unstarted run never sets it; an edit back to it, a
   Done and a close clear it. A run created at 3, cut to 2 before anyone starts, then cut to 1
   reads "2 → 1", since 2 is what the maker began with. The data-model row states the structure
   and points at the badge rule.
3. **Does replacing a run delete the old one with no history?** Decided: yes, and the row says so;
   history is a feature to revisit, not a side effect of the index.
4. **Should retention skip an order with an open run?** Decided: no. Retention deletes every old
   order, whatever its runs hold. Section 3.1.
5. **Reinstall and redact.** Decided: uninstall destroys the object and that is the whole rule;
   no re-adoption, no redact handling. The D1 row is corrected to say so. Section 3.2.
6. **Domain rename.** Decided: not supported; a renamed domain is a new shop, and the row says so.
   The domain stays the identity and the name everywhere; `shopGid` stays a column. Section 3.3
   has the evidence and what support would have cost.
7. **Provisional cycle.** Answered in section 5.4: it is the stand-in cycle a shop counts against
   before its first real billing cycle, starting at the first instant of the current UTC month,
   with a start and no end. Recommendation: a row, "a provisional cycle has a start and no end; a
   billing cycle has both, set together", pinned by the "opens a provisional cycle" trigger title.
8. **Team rename on open runs.** Decided: leave the snapshot alone (section 5.6); the run copies
   everything at creation and a rename never reaches it.
9. **An item Shopify no longer lists.** Decided: deleted on sync, with the run closed
   `item_removed`.
10. **Tag comparison.** Decided: whatever Shopify's admin does when it decides two tags are the
    same, stated on the workflow row beside the name rule.
11. **Member suspension.** Decided: no state; recorded as a choice.
12. **Who repairs a half-done team delete?** Decided: the next team delete and the orphan sweep.
13. **One run per item.** Decided: yes, and it gets a row.
14. **Test convention.** Decided: Recommendation 2 (schema rows pinned by a direct-write refusal,
    app rows by the write path), and `pnpm spec check` refuses "(none yet)" once the nine are
    pinned.

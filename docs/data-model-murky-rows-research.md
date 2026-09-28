# The two provisional data-model rows

## What was asked

`docs/data-model-spec-research.md` left two rows of the Durable Object's
data-model table marked provisional (follow-up 3), and the JSDoc on
`initializeSchema` in `src/lib/ShopAgentSchema.ts` still says so:

> Two rows are provisional: "billed at most once, on its first run" and "a
> team delete nulls the team on open run tasks" are the current behaviour,
> to be confirmed once billing and team delete firm up.

This doc says what each row is trying to state, where it disagrees with
the code or with another row, and what has to change to take the
"provisional" note off.

Short version: both rows describe the code roughly correctly, but each
mixes a structural rule with a behavioural one, each already has a test
the table does not name, and each has one real gap. The billing row has
an edge case where retention deletes the "already counted" mark, and seed
data adds special cases to the meter. The team-delete row contradicts the
D1 table and keeps pointers nothing reads. All four changes are decided (see Decisions).

## Row 1: "an order is billed at most once, on its first run"

### What the code does

`OrderRepository.countOrder` is the billing meter. `RunRepository.insertRun`,
the only path that creates a run, calls it inside the same transaction. It
runs:

```sql
update ShopOrder set countedAt = ? where id = ? and countedAt is null returning id
```

If a row comes back, it adds 1 to `ShopUsage.ordersThisCycle` and queues a
`UsageEvent` with idempotency key `<orderId>#count`. If no row comes back
(the order was counted before), it does nothing. `countedAt` is left out of
`upsertOrder`'s `on conflict do update`, so a re-sync never clears it.

Tests that already pin this:

- `an order is counted once, when its first run is created`
  (`run-repository.test.ts`): two runs on one order count once, and a
  second reconcile counts nothing.
- `a re-sync never queues a second count` (`order-repository.test.ts`).
- `a seeded order counts locally but queues no billing event`.

The table lists the row as `(none yet)`.

### What is murky

**1. "Billed" is the wrong word.** The object counts, it does not bill.
Shopify bills from the `UsageEvent` the object sends, and it remembers
every idempotency key permanently: a second event with the same
`<orderId>#count` key is ignored. So Shopify itself guarantees "billed at
most once per order", whatever the object does. The object's own rule is
about its local count and the `countedAt` mark.

**2. Half the row is behavioural.** "On its first run", meaning an order
costs a unit when Baton starts work on it and not when it is paid or
stored, is billing policy. It is already stated normatively on
`OrderRepository.countOrder` and `Domain.ShopUsage`. Under the AGENTS.md
rule, behavioural rules live on those symbols. The structural part is the
mark: set at most once, never cleared by a sync, removed only when the
order goes.

**3. Seed data adds special cases to the meter.** See the next section.

**4. Retention can delete the mark and let the order come back.** See the
section after that.

### Seed orders and the meter

Seeding (`pnpm seed`, `ShopAgent.seedOrders`) is local-only: it refuses
unless `ENVIRONMENT === "local"`. Seed orders still go through the meter,
so the code has three pieces that exist only for them:

- `queueUsageEvent` checks `Domain.orderIsSeeded` and queues nothing for a
  seed order, so a fixture never reaches Shopify.
- `deleteSeedOrders`, run at the start of every reseed, counts the seed
  orders that have a `countedAt` and subtracts that from
  `ordersThisCycle`. Without it, every reseed would add another fixture's
  worth to the count.
- `deleteSeedOrders` then clears `ordersLimitedAt` if the subtraction
  brings the count back under the ceiling. It is the one place outside a
  cycle roll that clears the flag.

Tests for these: `a seeded order counts locally but queues no billing
event`, `deleteSeedOrders clears the limited flag when giving the count
back leaves the cycle under the ceiling`, `seat events survive
deleteSeedOrders`, and `seedOrders leaves the usage counter at one seed's
worth however often it is reseeded`.

The stated reason for counting seed orders at all (`Domain.orderIsSeeded`)
is so "a prototyping shop can exercise the quota banner". The ceiling and
the banner are already covered without seed data: the tests in
`shop-agent-orders-ceiling.test.ts` and the usage tests in
`order-repository.test.ts` build their own orders and never seed. The
seed fixture is far below the ceiling anyway, so a normal seed never shows
the banner.

If seed orders are simply never counted (`countOrder` returns early for a
seed id), this is what goes away:

- the `orderIsSeeded` check in `queueUsageEvent`, which moves up into
  `countOrder`, so the check is still one line;
- the count subtraction and the `ordersLimitedAt` clearing in
  `deleteSeedOrders`, which becomes plain deletes of seed orders, their
  items and their runs;
- the "or once `deleteSeedOrders` gives the refused seed's count back"
  clause on `Domain.ShopUsage.ordersLimitedAt`, and most of the
  `deleteSeedOrders` JSDoc;
- two of the four tests above. The other two become "a seeded order is
  never counted" and "reseeding leaves the usage counter unchanged".

It also simplifies row 1: a seed order never gets a `countedAt`, so the
seed case is no longer an exception to "set at most once".

### Retention and the counted mark

Plainly: Baton keeps orders for 365 days. After that, the retention sweep
deletes the order, and the `countedAt` value is deleted with it, since it
is a column on the order row.

The bulk import only fetches orders from the last 30 days, so it cannot
bring an expired order back. A webhook can. If a merchant edits, refunds
or fulfils an order more than a year old, Shopify sends `orders/updated`,
and `upsertOrder` stores the order again as if it were new, with
`countedAt` empty. If a workflow matches and the order is open and paid,
reconcile starts a run and `countOrder` counts the order again.

What happens then:

- Shopify ignores the second `#count` event, so the merchant is not
  billed twice.
- The object's `ordersThisCycle` is one higher than Shopify's count, so
  the Home page usage and Shopify's invoice disagree by one.
- A run shows up on a member's list for an order Baton had already
  dropped, and the next retention sweep deletes the order and its run
  again.

It is rare, but it is a bug: the count drifts and a member sees work that
disappears. It should be fixed.

**The fix.** `upsertOrder` refuses an order whose `processedAt` is older
than `ShopLimits.orderRetentionDays`, the same way it already refuses a
new order past the monthly order ceiling. A refused order is not written:
no order row, no item rows, no run, no count. Nothing piles up.
The only row the webhook leaves is its `WebhookDelivery` row, which every
webhook writes for duplicate detection and which the sweep deletes after 7
days. That is the same as today.

"A retention row" in the first draft meant a line in the data-model spec
table (the rules table in the `initializeSchema` JSDoc), not rows in the
database. The table already has a retention line, "an order older than
retention is deleted; its items and its runs go with it". The fix adds
one clause to that line: "and is never stored again".

Cost: one comparison in `upsertOrder`, one integration test ("an order
older than retention is not stored"), and the clause in the table.

### Proposed rows

```
| order | an order's counted mark is set at most once, by its first run, and survives every sync; only deleting the order removes it; a seed order is never counted | app        | an order is counted once, when its first run is created |
| order | an order older than retention is deleted, its items and its runs go with it, and it is never stored again                                               | schema+app | an order older than retention is not stored               |
```

The policy (why the first run and not payment, never reversed) stays on
`countOrder` and `Domain.ShopUsage`. The rows link to them.

## Row 2: "a team delete nulls the team on open run tasks and leaves done ones alone"

Decided: null every pointer (see Decisions). This section is kept as the
reasoning.

### What the code does

`ShopAgent.deleteTeam` deletes the D1 row first, then calls
`WorkflowRepository.unassignTeam`. In one transaction, that nulls `teamId` on:

- every `WorkflowTask` and `WorkflowDraftTask` pointing at the team;
- every `RunTask` pointing at the team that is not done **and** whose run
  is open (`status = 'active'`, blocked included).

It leaves the pointer, and the `teamName` snapshot, on done tasks and on
every task of a closed run, including tasks that were never done.

Tests that pin this today:

- `unassignTeam nulls open run tasks only; the task leaves every list and cannot be worked; assignRunTaskTeam brings it back`
- `a team delete leaves a closed run's tasks on their team, so the run stays on that team's Recent`
- `countTasksByTeam counts workflow and draft tasks; unassignTeam nulls both sides`
- `deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it` (pinned by the D1 row)

### What was murky

1. **Ambiguous wording.** "Open run tasks" can mean tasks that are not
   done, or tasks of open runs. The code means both, and "leaves done ones
   alone" leaves out closed runs.
2. **Contradicts the D1 table.** The D1 row says a team delete "nulls
   every object pointer". The object keeps some on purpose.
3. **One rule over four rows.** The D1 row, the definition task's team
   row, the run task's team row and this row each state part of it.
4. **The kept pointers have no reader.** Every team-scoped read takes team
   ids from the member's current D1 teams, where the deleted team no
   longer exists. `deleteTeam` closes those members' connections, and
   history screens show `teamName`, not `teamId`. The closed-run test
   asserts a Recent list nobody can open once the team is gone.

### What changes

- `unassignTeam` drops the `doneAt is null and runId in (select … status
= 'active')` clause: one plain update per task table.
- The closed-run test is deleted. The other test is renamed to the rule,
  and its behaviour half ("cannot be worked", "assignRunTaskTeam brings it
  back") moves to its own test.
- The D1 row stays as written; it becomes true.
- On the object side the four rows become two:

```
| task | a task's team points to a D1 row; dangling reads as null, which means unassigned; a team delete nulls it on every task, definition, draft and run | app | a team delete nulls the team on every task; history keeps the name |
| task | a run task also snapshots its team's name; history shows the name and never resolves the team                                                        | app | creates one run per matching item with copied tasks and team names |
```

Cost: the update touches every historical task of the team, up to a year
of rows through `RunTask_teamId_idx`, in one transaction. Team deletes are
rare and merchant-initiated.

## Other work around the two rows

1. **Remove the "two rows are provisional" paragraph** from the
   `initializeSchema` JSDoc.
2. **Fill in the `pinned by` cells that already have tests**, listed
   above, so `pnpm spec check` guards them.
3. **Reopen after a team delete.** Under the decided option the pointer is
   null, so a reopened done task comes back unassigned. Add one test: "a
   reopened task whose team was deleted is unassigned".
4. **The monthly-cycle assumption.** `countedSince` recounts a new cycle
   from `countedAt >= cycleStart`, which is correct only while a cycle is
   a month or less. `README.md` forbids a yearly plan and nothing in code
   enforces it. That is billing behaviour and stays on `countedSince`; it
   is listed so it is not forgotten when `countedAt` is touched.
5. **The older research doc.** Follow-up 1 (the D1 table) has landed as
   `D1_TABLES`. Follow-up 2 (column audit) shows in the DDL: `ShopOrder`
   no longer has `financialStatus` or `requiresShipping`. Once this doc is
   resolved, `docs/data-model-spec-research.md` has nothing left open and
   can be deleted.

## Decisions (2026-09-28)

All recommendations accepted; no open questions remain.

1. **Team delete nulls every team pointer**: definition, draft and run
   tasks, done or not, open run or closed. History reads `teamName`.
2. **Seed orders are never counted.** `countOrder` returns early for a
   seed id; the `orderIsSeeded` check leaves `queueUsageEvent`;
   `deleteSeedOrders` becomes plain deletes with no `ShopUsage`
   arithmetic and no `ordersLimitedAt` clearing.
3. **`upsertOrder` refuses an order older than retention.** Nothing is
   written for it; the retention row gains "and it is never stored again".
4. **Pinned test titles are renamed to the rows.** Behaviour carried in a
   current title moves to its own test, so no assertion is lost.

## Status

Research. Nothing in `src/` depends on this file. Deleted, along with
`docs/data-model-spec-research.md`, once the rows, code and tests above
land.

# Index counts: where the reads go and what to do about them

Implemented 2026-10-04 by `docs/index-counts-performance-plan.md`; that plan's "Deviations and issues"
records what differed from this research.

Research, 2026-10-03. The question: the orders index (merchant) and the workflows list (member) each
show counts per filter value, every push from the object makes every subscribed tab refetch them, and
the refetch runs the count queries. With the workflow definitions now stored as JSON, are those
queries paying for `json_each`, would tables with indexes be faster, and should the counts be
precomputed on write instead?

Short answer: the JSON is not the cost. The cost is a query plan SQLite picks without statistics,
and it is quadratic in open orders. One composite index and one planner hint fix it, measured.
After that the merchant read is linear and small, the member read is linear and the fan-out to
members is what remains. Precomputing on write is the wrong tool for that; an in-object memo keyed
by a write counter is the right one, if the fan-out numbers warrant it. Questions at the end, each
with a recommendation.

This is the counts work the publish fan-out research (`docs/publish-fan-out-research.md`,
2026-10-03) deferred. That doc decided the push side: no publish after a write that changed nothing,
the order named in `publishToTeams`, hidden browser pages defer their refetch, and no
instrumentation in production for now (revised 2026-10-03 in this doc's review: instrumentation runs
in local and staging). This doc takes those as given and measures the read side; the two meet in
the cost table below, where pushes per day is their number and rows per refetch is this one's.

## What the two screens read

Both screens follow the subscribe pattern on `Domain.Subscription`: the loader paints one read, the
socket subscribes, and every `invalidated` frame the object publishes makes the tab refetch the same
read, throttled to one per two seconds per tab (`useSubscribedQuery`). A refetch is the whole screen
data in one round trip: the rows for the page and the count for every filter value.

| screen             | read                                                                          | statements per refetch | what the counts need                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the orders index   | `OrderRepository.listOrders`, plus `Repository.listTeams` from D1             | 6 (7 under a search)   | one statement over every open order: the run states per order (grouped), and two correlated subqueries per order, multi-match (items × tags × matched workflows' tasks) and unassigned (open runs × their open tasks against the live team ids) |
| the workflows list | `RunRepository.listRuns` then `listRecent` with `limit: 0` for the Done count | 4                      | every current task of every open run that has a current task on the member's teams, grouped in code into the four states; the Done count is two indexed counts over a day                                                                       |

Where JSON is read: only `ITEM_MATCHES`, the multi-match probe. Per item it walks the item's tags
(`json_each` of a short array), probes `Workflow.tag` (unique index) per tag, and for each matched
workflow walks its `tasks` array (at most `WorkflowLimits.maxTasks`, 20) once. That is a handful of
rows per item and it does not grow with the number of workflows. Runs and run tasks are rows, not
JSON. Breaking the definitions back into tables would replace a `json_each` over one row with an
indexed probe into another table and read the same number of rows. The prior analysis in the
draft-storage research reached the same conclusion and the measurements below confirm it.

## Measurements

A temporary integration test seeded one object through the real repositories (`upsertOrder` with
`reconcileOrder`, then `startTask` and `markTaskDone` to spread the states) and wrapped
`storage.sql.exec` to sum `SqlStorageCursor.rowsRead`, which is the number Cloudflare bills. Three
scales, each with 20 workflows of 3 tasks across 6 teams, 2 items per order, 30% of orders
fulfilled. Times are Miniflare on a laptop and only good for ratios; rows read are exact and
platform-independent. Query plans are from `explain query plan` on the statement the read actually
ran.

| stored orders | open orders | runs  | run tasks |
| ------------- | ----------- | ----- | --------- |
| 300           | 210         | 420   | 1,260     |
| 1,000         | 700         | 1,400 | 4,200     |
| 3,000         | 2,100       | 4,200 | 12,600    |

Production never runs `analyze`, so the "no stats" column is what deploys today.

### The orders index

Rows read per refetch, default filters (Open, no team, no search):

| open orders | today (no stats)   | with `Run (orderId, state)` index |
| ----------- | ------------------ | --------------------------------- |
| 210         | 107,753 (10 ms)    | 9,758 (3 ms)                      |
| 700         | 1,042,884 (74 ms)  | 30,058 (7 ms)                     |
| 2,100       | 9,006,684 (586 ms) | 88,058 (21 ms)                    |

Today's read is quadratic: rows read grow 84× for a 10× increase in open orders. With the index it
is linear, about 42 rows per open order.

The Issues filter, which adds the issue predicates to the page query as well:

| open orders | today                 | with the index  |
| ----------- | --------------------- | --------------- |
| 2,100       | 26,600,394 (1,735 ms) | 159,291 (37 ms) |

The team filter, which adds a correlated subquery over `Run` joined to `RunTask` per open order:

| open orders | today                 | with the index only   | with the index and `+s.teamId` |
| ----------- | --------------------- | --------------------- | ------------------------------ |
| 2,100       | 13,275,183 (3,652 ms) | 10,652,058 (3,308 ms) | about 27,000 (5 ms)            |

The last column was measured on the team predicate alone over the open orders (26,848 rows); the
page and count statements add the default read's cost on top.

### The workflows list

Rows read per refetch for a member on 2 of the 6 teams, default state, no team filter:

| open orders | `listRuns` today | `listRecent` (Done count) | team-first rewrite of the first statement |
| ----------- | ---------------- | ------------------------- | ----------------------------------------- |
| 210         | 7,469 (5 ms)     | 246                       | 3,811                                     |
| 700         | 24,899 (11 ms)   | 806                       | 12,701                                    |
| 2,100       | 74,699 (44 ms)   | 2,406                     | 21,154 (8 ms)                             |

A member on all 6 teams reads 110,102 rows (241 ms) at 2,100 open orders. The fan-out research
measured `readRuns` at 0 to 1 ms on the dev store, which has a few open orders; the read is linear in
open tasks, so the dev store number says nothing about a loaded shop. The read is linear, about
18 rows per open run for a two-team member, because the first statement reads every open task and
probes its run's tasks twice (`currentWhere` for the task and again inside the team `exists`). The
rewrite, which starts from the member's teams through `RunTask_teamId_idx` and only then reads the
qualifying runs' current tasks, takes about 3× off. The `(orderId, state)` index does not change this
read.

### Floors, for comparison

| read                                                   | rows at 2,100 open orders |
| ------------------------------------------------------ | ------------------------- |
| count the open orders (partial index scan)             | 3,000                     |
| runs grouped by state                                  | 4,200                     |
| position counts only, issues left out, no stored facts | 20,998                    |
| one `startTask` write                                  | 14                        |

The position counts alone, derived from the grouped run states with no precomputation, cost about
10 rows per open order. The issue predicates are the other 32 of the 42.

## Where the rows go

Three plan defects, two of them live today.

**1. The per-order run subqueries use the state index.** `OPEN_RUN`, `DONE_RUN`, `BLOCKED_RUN` and
`unassignedRun` are all `exists (select 1 from Run r where r.orderId = ShopOrder.id and r.state =
'open' ...)`. `Run` has a single-column index on `orderId` and another on `state`. With no
`sqlite_stat1` both look like one equality each, and the planner takes `Run_state_idx`: for each of
the 2,100 open orders it walks all 4,200 open runs and filters by `orderId`. That is the 9 million.
The counts statement already fought this once for `run_summary` (the `cross join` comment on
`listOrders`), but the correlated subqueries have no join to pin. A composite index
`Run (orderId, state)` serves both terms, so the planner takes it every time, with or without
statistics. `Run_state_idx` then has no reader left and can go.

**2. The team filter drives from the team's tasks.** `teamFilter` joins `Run wr` to `RunTask s`
with `s.teamId = ?` and `currentWhere(s)`, whose first term is `s.doneAt is null`.
`RunTask_teamId_idx (teamId, doneAt)` matches two equality terms, the unique `(runId, position)`
matches one, so per open order the planner reads every open task on the team and then checks each
one's run against the order: open orders × the team's open tasks. The composite index on `Run` does
not help because the planner still prefers the two-term index on `RunTask`. Writing `+s.teamId = ?`
(SQLite's unary plus disables index use for that term, https://www.sqlite.org/optoverview.html, "Disabling
index use") leaves `runId` as the only indexable term, and the plan becomes `Run` by
`(orderId, state)` then `RunTask` by `runId`: 27 thousand rows instead of 10 million.

**3. `ITEM_MATCHES` flips if statistics ever exist.** Without statistics the probe is what the
JSDoc says: `json_each` of the item's tags, then `SEARCH w USING INDEX (tag=?)`. After `analyze`
the planner reverses the join and scans every workflow per item (`SCAN w USING INDEX
sqlite_autoindex_Workflow_1`, the name index, then `json_each` of its tasks), 270 rows per open
order instead of 42. The existing plan test in `order-repository.test.ts` runs without statistics and
passes. Nothing in the app runs `analyze`, and nothing should; the test should say so, and a second
assertion should hold the plan of the whole counts statement, not only the probe in isolation.

Not a defect, but noted: the `facts` CTE scans `ShopOrder` through `ShopOrder_open_idx` (3,000
rows, fine), and `run_summary` reads the open orders' runs through the new index (4,200 rows, fine).

## What it costs on Cloudflare

Marginal rates, Durable Object pricing
(`refs/cloudflare-docs/src/content/partials/durable-objects/durable-objects-pricing.mdx`). Every
estimate here is units × rate; plan allowances are shared across the account and are not netted out.

| dimension    | marginal rate           |
| ------------ | ----------------------- |
| rows read    | $0.001 per million      |
| rows written | $1.00 per million       |
| requests     | $0.15 per million       |
| duration     | $12.50 per million GB-s |

An incoming WebSocket message counts as one twentieth of a request; outgoing frames are free. The
object hibernates between frames and the keepalive is answered at the edge (`SocketKeepalivePing`),
so duration is paid only while a read or write runs, at 128 MB: one second of object time is
0.125 GB-s.

Rows read are the dimension these reads move. A push fans out to every subscribed tab in scope, so
the monthly rows are pushes × refetches per push × rows per refetch. Three shop shapes, 30 days,
every member keeping the workflows list open and every push reaching all of them (the worst case;
task-action pushes reach only the order's teams). Dollars are rows × $0.001 per million, per shop per
month:

| shop   | open orders | members | pushes/day | today        | after the index | after index + member rewrite |
| ------ | ----------- | ------- | ---------- | ------------ | --------------- | ---------------------------- |
| small  | 210         | 5       | 200        | 0.9 B, $0.87 | 0.3 B, $0.28    | 0.2 B, $0.21                 |
| medium | 700         | 12      | 800        | 32 B, $32    | 7.9 B, $7.90    | 5.5 B, $5.50                 |
| large  | 2,100       | 30      | 2,000      | 675 B, $675  | 140 B, $140     | 65 B, $65                    |

The other dimensions are small beside rows at every shape. At the large shape the refetches are
31 WebSocket messages per push, 1.9 million a month, which is 93 thousand billable requests, about
$0.01; the serialized read time per push is 1.9 s today and 1.3 s after the index, 0.24 and 0.16 GB-s,
about $0.18 and $0.12 a month.

Per push, the member reads dominate once the merchant read is fixed: at the large shape the
merchant refetch is 88 thousand rows and the thirty member refetches are 2.2 million. The 2,000
pushes a day is the large shape's own traffic: order webhooks plus a start and a done on every task
of 4,200 runs over two weeks.

Latency matters more than money. The object is one thread. A push at the large shape today costs
586 ms for the merchant read plus 44 ms per member, serialized: the last tab waits about two seconds
and a second push lands behind it. After the index it is 21 ms plus 30 × 44 ms, about 1.3 s, almost
all of it members. The per-tab throttle collapses bursts on the client, but not the fan-out.

Two things the money table hides. `readOrders` reads the teams from D1 on every refetch, a D1 row
read and a network hop per merchant refetch; the member read does not touch D1. And `maxMembers` is
12 today, so the "30 members" column is a shape the ceiling does not admit yet.

## Does it scale

The review asked whether the thing works at all at a realistic medium shop: 2,000 open orders, 25
members, and two merchants with the orders index open all day. The measured numbers say yes, and
they say which step makes it so. Shape: 2,100 open orders (the measured scale), 25 members all on
the workflows list, 2 merchants on the orders index, 2,000 pushes a day, every push reaching
everyone (worst case). Rows at $0.001 per million; time is the serialized read work on the object's
one thread per push.

| step                  | rows per push | rows per month | $ per month | object time per push |
| --------------------- | ------------- | -------------- | ----------- | -------------------- |
| today                 | 19.9 M        | 1,190 B        | $1,190      | 2.3 s                |
| A: index and hint     | 2.0 M         | 123 B          | $123        | 1.1 s                |
| A + member rewrite    | 1.0 M         | 60 B           | $60         | 0.4 s                |
| A + rewrite + C3 memo | 0.29 M        | 17 B           | $17         | 0.1 s                |

How each row is built. Today: 2 × 9.0 M (merchants) + 25 × 74.7 k (members). A: 2 × 88 k + 25 ×
74.7 k. Rewrite: the member read becomes about 33 k (21 k for the first statement, 9 k for the runs,
2 k for the Done count). C3: the merchants share one computation because they read the same
default filter, and the members share one computation per distinct set of teams, which is bounded
by the number of teams, never by the number of members; six teams is the worst case here, so
88 k + 6 × 33 k.

Three things follow.

**The counts are not the problem, the fan-out is.** The merchant counts statement after A is 88
thousand rows and 21 ms for 2,100 open orders; two merchants or ten make no difference once it is
memoized, and even unmemoized it is 42 rows per open order. What scales with members is repeating
the same member read once per member, and C3 removes that: the read is per team set, and 25 members
on six teams are at most six reads. The counts stay on the screen.

**Members do not need a hard cap for cost.** At the shape above, a member costs about 24 cents a
month after the rewrite without the memo (33 k rows × 60 k pushes × $0.001 per million) and nothing
marginal with it. The member ceiling can be a product and billing decision; it does not have to be
an infrastructure one.

**The single thread is fine at this shape.** 2,000 pushes a day is one every 25 seconds across a
14-hour day; 0.4 s of work per push without the memo is under 2% of the thread, 0.1 s with it is
under 0.5%. The bad case is a bulk sync of 2,000 orders publishing 2,000 times in a minute: the
client throttle caps each tab at 30 refetches a minute, so 27 tabs are 810 refetches a minute, about
13 a second, 12 s of work per minute without the memo (20% of the thread, no queueing that a tab
would notice) and about 1 s with it. Duration at these rates is cents.

Open orders are the real axis, and it is linear after A: 42 rows per open order for the merchant
read, about 16 per open run for the member read after the rewrite. Doubling the shop doubles the
bill. At 4,000 open orders the shape above is roughly $35 a month with the memo and $120 without.

**Against what a shop pays.** Baton's own prices are not set. Route to Ship's ladder
(`refs/route-to-ship/pricing.md`, read 2026-10-03) is the nearest comparison for the same kind of
shop:

| Route to Ship tier | $/month | members included | orders/month included | extra member | order overage |
| ------------------ | ------- | ---------------- | --------------------- | ------------ | ------------- |
| Production         | $39     | 3                | 250                   | $15          | $0.15         |
| Team               | $99     | 10               | 1,000                 | $12          | $0.10         |
| Floor              | $249    | 30               | 5,000                 | $10          | $0.05         |
| Enterprise         | $499    | 100              | unlimited             | $6           |               |

The shape above, 25 members and 2,000 open orders (about 4,000 to 5,000 orders a month on a two-week
cycle), is Route to Ship's Floor tier at $249 a month. Baton's marginal infrastructure for that shop
is $17 a month with A and C3 together, 7% of that price, and $60 without C3, 24%. The medium shape
(12 members, 700 open orders) is their Team tier at $99 plus two extra members, about $123; Baton's
marginal cost there is $7.90 with A alone and about $2 with C3. These are worst-case assumptions
throughout: every push reaches every member, every member has the list open all day, two merchants
watch the orders index all day.

What this does not cover: whether 2,000 open orders at one moment is a medium shop for made-to-order
work. That is a product number, not measured here.

## What C3 is, concretely

**It is an Effect `Cache`, held by the object for as long as the object lives.** Effect v4 ships a
`Cache` module (`node_modules/effect/dist/Cache.d.ts`, `Cache.make`, `Cache.get`,
`Cache.invalidateAll`): a keyed store with a `lookup` effect for misses, single-flight for
concurrent requests of the same key, a capacity bound, and optional time to live. It keeps its
entries in a `MutableHashMap`, so keys are compared structurally when they are `Data` values. It is
the idiomatic shape for "remember the answer until told otherwise"; a hand-rolled `Map` and counter
would be reimplementing it. The earlier draft of this section sketched exactly that and the review
rightly asked for the Effect form.

The cache lives in the object's Effect runtime, which is built once per object instance
(`makeRunEffect` in `ShopAgent.ts` builds a `ManagedRuntime` from the layers over this instance's
`storage`). A `Cache.make` inside `ShopWorkAgent`'s `make` is therefore one cache per object, in the
object's memory, alive exactly as long as the instance. It is not a table, not a row, and not JSON in
the SQLite file. The SQLite file stays the durable truth; the cache is a copy of a few recent
answers derived from it.

**Two caches, one per read.**

```ts
// inside ShopWorkAgent's make
class OrdersKey extends Data.Class<{
  readonly limit: number;
  readonly cursor: string | null;
  readonly q: string | null;
  readonly show: Domain.OrdersShow | null;
  readonly team: Domain.TeamId | null;
  readonly teamIds: string; // the D1 team ids, sorted and joined
}> {}
class RunsKey extends Data.Class<{ readonly teamIds: string }> {}

const ordersMemo =
  yield *
  Cache.make<OrdersKey, Domain.OrdersPage, SqlError>({
    capacity: 32,
    lookup: (key) => repository.listOrders({ ...key, teams }),
  });
const runsMemo =
  yield *
  Cache.make<RunsKey, readonly Domain.RunListItem[], SqlError>({
    capacity: 32,
    lookup: (key) => runRepository.runListItems(split(key.teamIds)),
  });
```

| read                            | memoized value                                                                   | key                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| orders index (`readOrders`)     | the `OrdersPage`: page rows, aggregates, counts                                  | `limit`, `cursor`, `q`, `show`, `team`, and the D1 team ids sorted and joined |
| workflows list (`runListItems`) | every row the teams own, unsorted and uncapped, as the function returns it today | the member's team ids, sorted and joined                                      |
| Done count (`listRecent`)       | not memoized                                                                     | its window slides with the clock; 2 to 4 thousand rows; stays a real read     |

`runListItems` is the memo point for members, not `listRuns`, because `listRuns` adds the
per-member part: grouping into `started_by_you` and the rest by `memberEmail`, the team narrowing,
the sort and the cut. That is array work over at most a few hundred items and reads no rows.
Twenty-five members on six teams share at most six cached `runListItems` results and each gets
their own grouping from it. Merchants share one `readOrders` result per filter combination.

**A read is `Cache.get`.** `readOrders` becomes `Cache.get(ordersMemo, new OrdersKey({...}))` and
`listRuns` reads its items with `Cache.get(runsMemo, new RunsKey({...}))`. On a miss the cache
forks the lookup, stores the entry at once, and every other `get` for that key while it runs joins
the same fiber: twenty-five refetches arriving within the two-second throttle run the SQL once. On a
hit the value comes back with no SQL and no rows read.

**Invalidation is `Cache.invalidateAll`, called from `publish`.** `publish` is the one place every
write already goes to tell the tabs their data changed. C3 adds one effect there, before the frames
are sent: invalidate both caches. So the cache is cleared by exactly the event that invalidates the
tabs, and a tab's refetch after a push always computes fresh, because the clear happened before the
frame left. A write that publishes nothing leaves the cache as it is; that is the same write leaving
every open tab as it is, and the fan-out research's decision 1 (a write that changed nothing
publishes nothing) is the only such case by design. The one input outside the object is the D1 team
list, which `readOrders` reads on every call today and keeps reading; its ids are part of the key, so
a team added or deleted changes the key and the old entry is never asked for again.

**The race.** A write can land while a lookup is running. `Cache.get` puts the entry in the map
before the lookup finishes, and `invalidateAll` clears the map, so a publish during a lookup removes
the in-flight entry: the caller still gets the value (correct for the moment it was asked, and that
tab is about to be told to refetch anyway) and nothing stale is kept. This is the library's own
behaviour, read from `Cache.js`, not something the wrapper has to arrange. The object is
single-threaded, so there is no finer interleaving to worry about.

**Eviction and hibernation.** When the object is evicted (idle, or redeployed) or hibernates between
WebSocket frames, the instance and its runtime go away and the cache with them. The next event, a
frame or an RPC, constructs a fresh instance with an empty cache. The first `get` of each key after
that runs the SQL, as every read does today, and stores the result; the next `get` of the same key
hits. "One read on eviction" means: per distinct key, one SQL computation at exactly today's price,
then memory until the next publish. Nothing has to be restored because nothing was state.

**Does the object stay awake through a push and its refetches?** The review asked why we assume
so, given the two-second throttle, and whether eviction mid-fan-out is possible. The documented
lifecycle (`refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx`,
"Durable Object lifecycle state transitions"): after the last request or event finishes, the object
sits idle in memory, and only after **10 seconds** with no incoming request or event does it
hibernate; a non-hibernateable object is evicted after 70 to 140 seconds. Every refetch is an
incoming WebSocket message, so each one restarts that clock. The Agents SDK accepts sockets through
the hibernation API (`acceptWebSocket` in `refs/agents/packages/agents/src/lifecycle/connection.ts`),
`ShopAgent` sets no timers that would block hibernation, and the keepalive is answered at the edge,
so between pushes the object does hibernate and duration is not charged.

The two-second lag is smaller than it sounds. The client throttle is leading-edge: the first
`invalidated` frame a tab receives triggers its refetch at once, and only a second frame inside the
window waits for the trailing edge two seconds later (`INVALIDATION_THROTTLE_MS` in
`useSubscribedQuery`). So after one push the refetches arrive one round trip later, tens to a few
hundred milliseconds, while the object has just finished the write. After a burst the trailing
refetches arrive two seconds after the last frame; two seconds is well inside the ten before
hibernation. Eviction between a push and its refetches would need ten quiet seconds that the
refetches themselves prevent.

The design does not depend on this. If the runtime moved or evicted the object anyway, the next
refetch would cold-start it (constructor, runtime build, one schema check) and the first `get` of
each key would run the SQL once; the other tabs' refetches for the same key, arriving in the same
window, join that lookup. The saving per push is still one computation per distinct key. Staying
awake is what the documented timing says will happen, not a condition the correctness or the cost
model rests on. The one thing to keep true is the hibernation precondition list: no pending
`setTimeout`, no unfinished I/O, no standard-API WebSocket; the plan should pin a check that
`ShopAgent` holds none.

**Memory.** A cached `OrdersPage` is 26 rows plus five counts; a `runListItems` result is every
current task on the teams' open runs, a few hundred items at 2,100 open orders, tens of kilobytes.
`capacity: 32` bounds the key count. The object has 128 MB.

**Why not persist it.** A cache table in SQLite would survive eviction, cost a row write per
computation ($1.00 per million, cents) and a version-row read on every hit, so a hit is no longer
free. It would save one recomputation per key per wake, which is one read at today's price. Not
worth a table, a data-model row and a pinned test.

**What changes in the code.** Two `Cache.make` calls and two `Data.Class` keys in `ShopWorkAgent`'s
`make`, `readOrders` and `listRuns` reading through `Cache.get`, one `invalidateAll` of both in the
class's `publish` (reached through the `ShopWorkAgent` service the class already holds), and a rule
on `publish`: every write that changes what a list read returns publishes, and the caches clear with
it. Two tests: a second read of the same key executes no SQL (the `rowsRead` wrapper from the bench
shows zero rows), and a publish between two reads makes the second one recompute.

### Pushing the data instead of invalidating: first principles

The review asked whether the loader/socket agreement should be broken rather than preserved. The
agreement today: a tab registers a `Subscription` (who it is, which order or no order), the object
sends a bare `invalidated` frame, and the tab refetches its own query by its own key through the
same read the loader used. The alternative: the object holds each tab's full query, computes the
result on every publish, and sends the data in the frame; the tab writes it into its query cache.

What each costs and saves, per push, at the target shape:

| dimension                 | invalidate + C3                                                   | push the data                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| SQL computations          | one per distinct key, on demand                                   | one per distinct key, eagerly                                                                                                   |
| rows read                 | the same                                                          | the same                                                                                                                        |
| messages                  | 1 frame out + 1 RPC in + 1 reply out per tab                      | 1 frame out per tab; incoming WebSocket messages are billed at 1/20 of a request, so 27 tabs are about $0.01 a month either way |
| latency to a fresh screen | push, then a round trip                                           | push only; about one round trip sooner                                                                                          |
| hidden and idle tabs      | the tab decides; decision 3 defers hidden tabs                    | the object computes and sends to every tab, hidden or not                                                                       |
| bursts                    | coalesced on the client, two seconds per tab                      | must coalesce on the object; a timer fights hibernation (fan-out research, recommendation 5)                                    |
| filters and paging        | the tab's query key; the object knows only the subscription scope | the object stores each tab's filters and cursor and re-subscribes on every change                                               |
| loader and socket         | one read, one contract                                            | two paths into the same contract: the loader reads, the socket is written to                                                    |

On rows and dollars the two are equal once C3 shares the computation. The push saves one round trip
of latency per refresh and one small RPC; it costs the object a copy of every tab's query, moves
burst coalescing and visibility gating onto the object where they are harder, and gives up the
property that one read serves both paint paths. For a bench tablet that is visible all day the
latency saving is real but small (a round trip to the edge, tens of milliseconds, against the
two-second client throttle that already bounds freshness). Recommendation: keep the agreement, build
C3, and revisit a data push only if measured freshness, not cost, turns out to be the complaint.

## Options

**A. Fix the plans.** Add `Run (orderId, state)`, drop `Run_state_idx`, write `+s.teamId` in
`teamFilter`, and pin the plans in tests that run without statistics. No data-model row changes: the
table on `initializeSchema` says what is true of the data, never which index makes it true. Measured
effect above. This is the whole of the merchant-side problem and it is a day's work including the
tests. The member rewrite (team-first) belongs here too: it is a change of driving table, not of the
predicate, and `currentWhere` stays the one definition three readers share.

**B. Break the JSON back into tables.** No. The JSON read is bounded by `maxTasks` and the probe
starts from the item's tags; a task table would be probed the same number of times. Rejected on the
measurements.

**C. Precompute on write.** Three shapes:

- _C1, derived columns on `ShopOrder`_ (position and the three issue flags), recomputed in the same
  transaction as every run and task write, every sync and every reconcile. The counts become one
  grouped read over the open orders, about one row each. Against it: `unassigned` depends on the live
  D1 team list, which the object does not own and cannot see change, so a stored value is wrong
  between a team delete and the next write; `multi_match` depends on which workflows are on, so it is
  wrong between Turn off and the reconcile that follows (the draft-storage research rejected storing
  the match count for exactly this). Every write path grows a recompute step and every data-model row
  about runs gains a "and the order's facts follow" half. Saves about 40 rows per open order per
  refetch; after A, that is 88 thousand rows per merchant refetch, which is not where the cost is.
- _C2, five shop-level counts in one row._ The same invalidation surface as C1 with the recompute
  over the whole shop on every write. Worse.
- _C3, a memo in the object keyed by a write counter._ A JavaScript `Map` on the `ShopAgent`
  instance, not a table and not JSON in SQLite, that remembers the last result of each list read until
  the next write. Spelled out in the next section. No schema change, no write path change, no new
  invariant on the rows.

**D. Reduce the fan-out.** Member pushes are already scoped by team; merchant run mutations publish
`"all"` because the repository result does not carry the order, which is a small widening worth
fixing when touched. Pushing the data instead of the invalidation would be C3 in a worse shape: it
breaks the per-query key and the loader/socket agreement. Not recommended.

## Recommendation

1. Do A now, as one change: the index, the hint, the member rewrite, and three plan tests (the
   counts statement, the team filter, and `ITEM_MATCHES` inside the counts statement) each asserting
   the index it must use and that nothing scans `Run` or `Workflow`. Add a rows-read assertion
   alongside: seed a small fixed scale and assert rows read per open order under a bound, through the
   same `rowsRead` wrapper the bench used. Rows read are deterministic, so the test is stable.
2. Decide C3 by the target shape (Q1), not by logs: the fan-out research decided against
   instrumentation for now, and the rows-read model above is deterministic enough to decide on. If
   the target is a dozen members on the workflows list, A alone brings the medium shape to under $8 a
   month in rows and C3 waits; if it is thirty, build C3 after A, since members are $130 of the $140.
3. Do not build C1 or C2, and do not move the definitions back into tables.

## Decisions

Reviewed in Plannotator 2026-10-03, two rounds.

1. Keep the benchmark as a test with a rows-read bound per open order and per open run (Q3).
2. Nothing ever runs `analyze`; the plan tests run without statistics and the rule goes on
   `initializeSchema` (Q4).
3. Drop `Run_state_idx` once the composite index is in (Q5).
4. The member rewrite goes into A, with a plan test that it drives from `RunTask_teamId_idx` (Q7).
5. Leave the D1 teams read on `readOrders`; it is part of C3's key (Q8).
6. Instrumentation: the fan-out research's decision 4 is revised. The `ms=` and `rows=` line on
   `readOrders`, matching `readRuns`, runs in local and staging. Nothing waits on it or relies on it,
   and no stress testing is planned (Q6).
7. The limits are provisional. `maxMembers` 12 was set to exercise billing, not as a product
   number; the working target is 25 members as a hard limit, with two merchants on the orders index
   at that size. The scale section is computed for that shape (Q1).
8. A and C3 are built together, as one change: the index, the hint, the member rewrite, the plan
   and rows-read tests, and the two Effect caches with their invalidation in `publish` (Q2 and the
   C3 question, second round).
9. C3 uses Effect's `Cache`, not a hand-rolled map; the section above is rewritten to it (second
   round).
10. The loader/socket agreement stays; the object invalidates and the tab refetches, with C3 sharing
    the computation. A data push is not pursued unless freshness becomes the complaint (third round).
11. $17 a month marginal for the 25-member, 2,000-open-order shop is an acceptable infrastructure
    cost; the cost worry is settled (fifth round).
12. The object's wake and sleep around a push is stated from the documented lifecycle (10 seconds
    idle before hibernation) and the leading-edge throttle, in the C3 section; the cost model does not
    depend on it (fourth round).

## Open

Nothing. Every question has an answer above; the next step is a plan.

## Method notes

The bench wrapped `state.storage.sql` in a `Proxy` whose `exec` recorded every cursor, and summed
`rowsRead` after each read; `SqlStorageCursor.rowsRead` is documented as the value used for SQL
billing (`refs/cloudflare-docs/src/content/docs/durable-objects/api/sqlite-storage-api.mdx`).
Plans came from `explain query plan` on the recorded statement text with the recorded parameters.
The composite index phase ran `create index Run_orderId_state_idx on Run (orderId, state)` on the
seeded object before measuring; the statistics phase ran `analyze`. The order ceiling was lifted
with the test helper `withMaxOrdersPerCycle` so more than 100 orders could be stored.

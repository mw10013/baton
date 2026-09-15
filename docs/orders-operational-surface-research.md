# Orders as the merchant's operational surface

Research date: 2026-09-15. Scope: where a merchant goes to see what production is
doing and to decide whether to intervene. The question was raised as "should the
teams and members pages grow workflow/step drill-down?" and was settled as **no**
on 2026-09-15 (see Decisions). The rest of the doc is the consequence: Orders is
the operational surface, and this is what it is missing.

Companion docs: `docs/teams-members-ux-research.md` (the roster pages themselves),
`docs/merchant-run-intervention-research.md` (what a merchant may do to a running
step, and how it is recorded), `docs/member-ux-research.md` (the worker queue whose
"ready" predicate this doc reuses).

## Decisions (2026-09-15)

1. **Teams and members pages stay a roster.** They manage who exists and who is on
   what. They do not grow run status, step lists, or intervention. The one
   workflow-shaped thing they keep is the existing **Used by** card — which
   workflows reference a team, deliberately collapsed to workflows rather than
   steps (`src/lib/usedBy.ts:24`, rendered at `src/routes/app.teams.$teamId.tsx:454`
   and on the index at `src/routes/app.teams.index.tsx:179`). That is configuration,
   not production state, and it is where the line sits.
2. **Nothing member-scoped, at all.** Not a work list, not an activity feed.
3. **Orders is the surface** for "what is going on and do I need to step in."
4. **Team-scoped viewing arrives as a filter on Orders**, not as a page under Teams,
   and it means **currently waiting on** that team — the ready step, through the same
   `readyWhere` predicate the worker queue uses — labelled "Waiting on", not "Team".
   Not "owns a step anywhere in the run".

## Refinements after code review (2026-09-15, second pass)

Four corrections to the sections below, made after checking every cited line. Where
a section below disagrees with this list, this list wins; the plan in
`docs/orders-operational-surface-implementation-plan.md` is written against it.

1. **`readyWhere` is a closure, not a shared definition.** It is declared inside
   `WorkflowRunRepository.layer` (`src/lib/WorkflowRunRepository.ts:586`) and is not
   reachable from `OrderRepository.listOrders`, which is where the column and the filter
   have to run (`src/lib/OrderRepository.ts:433` is already the one read that joins
   `WorkflowRun` per index row). "Agree by construction" therefore needs the predicate
   hoisted to a module both repositories import; a copy would be the drift this doc
   argues against. The same read's `emptyReady` fragment (`OrderRepository.ts:463`)
   is already a looser hand-copy of it — open and nothing open in an earlier stage,
   without the order-run gate — and should be replaced by the hoisted predicate so
   `attention` means "ready" the way the queue means it.
2. **The cell carries team ids, not names.** The Durable Object has no team names;
   `listOrders` receives the live D1 roster (`teams: readonly TeamRoster[]`) only to
   compute `attention`. `OrderRow` gains `waitingOn: readonly TeamId[]`, and
   `OrdersView` gains the roster it was already read with, so the route resolves names
   and the `?team=` filter is an id — the same id the team detail page links with.
3. **Alarm disambiguation is the cheaper change and goes first.** It is a second
   counter in `RunCounts`, a second badge branch, and no schema work. The column is
   the larger change. They ship as one commit but the badge split is step 1.
4. **No index-row actions, Assign team included.** The "one exception worth
   considering" under §4 is withdrawn. The critical badge already names its remedy and
   the order page is one click away; one action in a row is the precedent for the
   next.

One factual fix: the production column's header reads **Workflows**
(`src/routes/app.orders.index.tsx:467`), not "Production". The doc's "Production
cell" below means that column.

## What shipped (2026-09-15)

All four steps of the recommended sequence are in. Where the sections below
disagree with this list, this list wins — it is what the code does.

1. **The predicate lives in `src/lib/readyWhere.ts`**, a module exporting the SQL
   text for a caller's step alias, wrapped in `sql.literal` by each repository.
   `WorkflowRunRepository` keeps its `readyWhere(alias)` closure as a one-line
   wrapper, so `listQueue`, `readySteps`, `isReady` and every step guard are
   unchanged. The module's JSDoc reserves the aliases `p`, `r` and `i`: an outer
   table named `r` would be silently shadowed inside the predicate's own
   subqueries, so `OrderRepository` aliases its runs `wr`.
2. **`attention` tightened, as Refinement §1 predicted.** `emptyReady` now runs the
   real predicate instead of its looser hand-copy, so a pending order run's step on
   an unstaffed team is no longer an alarm until the item runs are done — there was
   nothing the merchant could do about it before then. `test/integration/order-repository.test.ts`
   asserts both directions of that gate.
3. **Three alarms, three badges.** `Domain.RunCounts` carries `flagged` (reconcile
   flags only) and `blocked`, disjoint because `WorkflowRun.flag` is one column.
   The row renders `Blocked` critical and `Order changed` warning beside
   `Needs attention`; the copy is fixed and the reasoning is in `stateBadge`'s
   JSDoc.
4. **Names are resolved through the roster the view carries, not minted at the
   boundary.** `OrdersView` gained `teams: readonly TeamRoster[]` — the same list
   `attention` and `waitingOn` were derived against, bound once in
   `ShopAgent.readOrders`. Nothing constructs a `TeamId` from a SQL value or from a
   DOM value: the repository's fold looks each row's `teamId` up in a
   `Map<string, TeamRoster>` and takes the branded `id` from the entry, and the
   filter's `s-select` maps its value back through `view.teams`. `TeamId.make` is
   used nowhere.
5. **Sorting is server-side.** `waitingOn` comes back sorted by team name, because
   the cell collapses past `TAG_BADGE_LIMIT` and an unstable order would move which
   teams hide behind the `+N` between refreshes of a subscribed page.
6. **The filter is its own row with its own label, and there is no chip.** §3's
   "Placement" said to put it beside the `paid` select as two selects on one row and
   to show a chip only when active. It is instead a third row under Payment,
   labelled `Waiting on` in the same label column as Stage and Payment — and the
   select's value _is_ the chip, so one control replaces a control plus a chip. A
   disabled `Deleted team` option covers a `?team=` link that outlived its team, so
   the control never reads `Any team` over a filtered list.
7. **`Domain.productionState` takes `Pick<OrderRow, "order" | "runs">`.** The order
   page rebuilds the aggregate from its own run list and was already passing
   `itemUnits: 0, attention: false` as filler; `waitingOn` would have been a third
   invented value on a call that reads none of them. Narrowing to the two fields the
   function reads means future `OrderRow` growth never touches that call site.
8. **`s-page` accepts several `secondary-actions`.** The team page's
   `Orders waiting on this team` button and its `More actions` menu trigger both
   hoist into the admin title bar; the fallback of putting the link inside the menu
   was not needed. The teams index deliberately has no per-row link, with a comment
   saying so where a reviewer would otherwise add one.

## Why not teams and members

**Members are not a unit of work.** Work routes to teams: `listQueue` is keyed on
`teamIds` (`src/lib/WorkflowRunRepository.ts:1436`) and the only step assignment
that exists is `assignRunStepTeam` (line 1808). A member appears on a run solely as
after-the-fact attribution — the `Actor` union and its `role` / `id` / `email`
columns (`actorColumns`, `src/lib/WorkflowRunRepository.ts:189`). So a member-scoped
view could only ever render an attribution history. That is a productivity-monitoring
feature: a different product, with a real labour-surveillance downside, and close to
zero value at made-to-order shop sizes. Member pages stay about access — teams,
invite, sign out.

**A team drill-down would fork the navigation tree.** Orders → order → run → step is
one path to a step; Teams → team → workflow → run → step would be a second one to the
same step. Two paths drift: filters, empty states, undo affordances, and the realtime
subscription wiring all get a second implementation and then disagree. The merchant
intervention surface that just landed on the order page would need a second home, and
its correctness leans on run-local reasoning (`undoVerdict`,
`src/lib/WorkflowRunRepository.ts:203`) that does not travel.

**The cost is in the reads, not the markup.** Team-scoped aggregates across runs mean
new indexed reads in the Durable Object plus new invalidation fan-out —
`ShopAgent.ts:1366` scopes publishes by the order's team ids
(`listOrderTeamIds`, `src/lib/WorkflowRunRepository.ts:1770`), and a team-global list
is a different subscription shape than anything published today.

**The team question is capacity, not navigation.** "Is this team backed up?" is
answered by counts and by a scannable list. "Where is order #1042 stuck?" is answered
from the order, which the merchant already has. Neither wants a team → step tree.

**A team queue already exists** — the member work page at `/shop/$shop`. If merchants
ever do ask to see one, the cheap answer is a read-only "view as team" of that page
rather than a parallel merchant-side surface.

## What Orders is missing

### 1. A "Waiting on" column — build this first

The index answers _what stage is this order in_ and never _who is holding it_. A row
renders the production badge and nothing else about the run: `No workflow` /
`3 active · 1 done` / `Ready to ship` / `Shipped` / `Cancelled`, plus `Flagged` and
`Needs attention` (`stateBadge`, `src/routes/app.orders.index.tsx:94`; row markup at
line 462). The columns are Order, Date, Payment, Production, Items, Tags, Shopify.
No step name, no team name, anywhere.

So a team filter on its own would hand the merchant a list of orders where each row
still does not say why it is there.

**Add a column, between Production and Items, naming the ready step(s) and their
team** for open orders. That single change turns the index from a stage list into a
dispatch board: the team question becomes answerable by scanning, before any filter
exists. It is also the column whose definition the filter must then match.

#### What the column actually renders

The cardinality problem is much bigger than parallel stages. An order's runs are a
**cross product of line items and matching item workflows**, plus at most one order
run:

- Reconcile starts a run for _every_ startable item workflow that matches _each_ line
  item (`src/lib/WorkflowRunRepository.ts:1060`), and `unique (lineItemId, workflowId)`
  (`src/lib/ShopAgent.ts:542`) is exactly the key that permits many workflows on one
  line item while refusing a duplicate of the same one. A merchant can attach more by
  hand on top of that (`createRun`, `source: "manual"`).
- The order run is the singleton: `Workflow_order_uidx` allows one `type: "order"`
  workflow per shop, and `WorkflowRun_order_uidx` one run for it per order.

So one index row's ready steps are a union over (line items × matching item workflows

- 1. runs, each of which can have several steps ready in a parallel stage. Five items
     crossed with two workflows is ten runs before anything parallel. Step names are
     unbounded here; teams are not — a shop has a handful.

**Render distinct team names, not step names.** The cell is the set of teams with a
ready step across the order's open runs, sorted by name, capped at three with a `+N`
overflow — reusing the existing `TAG_BADGE_LIMIT` of 3 on the same page
(`src/routes/app.orders.index.tsx:20`) so the table has one collapse idiom rather than
two. Three reasons:

- It is the same move `groupUsedBy` already made on the team pages, for the same
  reason: collapse to the unit the list grows with (`src/lib/usedBy.ts:24` — "the list
  grows with workflows, not with steps"). Here the list grows with teams, not with the
  item × workflow cross product.
- The merchant's question at index altitude is _who is holding this_, which is a team
  question. _Which step_ is a detail-page question, and the detail page already answers
  it.
- It makes the column and the filter the same fact rendered two ways. "Waiting on
  team X" filters exactly the rows whose cell contains X — no explaining why a row
  matched.

**Unassigned ready steps contribute nothing to the cell.** They do not render as
"Unassigned". That fault is already a critical `Needs attention` badge in the
Production cell, and `OrderRow.attention` is defined to cover precisely it
(`src/lib/Domain.ts:1437`). Rendering it in two cells makes one fault look like two
alarms.

**This makes the empty cell meaningful rather than ambiguous.** Work through
`readyWhere` (`src/lib/WorkflowRunRepository.ts:586`): an open item run always has at
least one ready step, and when the last item run finishes, the order run's first stage
becomes ready. So for an order in production the cell is non-empty _unless_ every
ready step is unassigned — which is exactly when the critical badge is showing. Empty
cell plus critical badge reads correctly as "nobody is holding it because nobody is
assigned to it".

**A `pending` order run needs no special case.** Its steps are not ready until the
items are made, but the item runs holding it up are open on the same order, so their
teams are already in the same cell. The order is correctly shown as waiting on the
makers, not on the packers.

The one genuinely blank case left: an **order run whose item runs were all cancelled**.
`readyWhere` needs at least one item run `done` on the order, so such an order run can
never become ready. Creation cannot produce it — `reconcileOrder` gates the order run
on `hasItemRun` (`src/lib/WorkflowRunRepository.ts:1091`) — but an order edit that
removes every line item before any work starts cancels the pending item runs and leaves
the order run open. Reconcile flags that run (`item_removed`), so the row is not silent;
the waiting-on cell is simply empty beside a flag badge, which is honest. Do not paper
over it with placeholder copy in the column — if this proves common, it belongs in the
alarm work below, not here.

### 2. Alarm disambiguation

Three different faults, two badges, and the merchant's next click is somewhere
different for each.

- **`attention`** — a _configuration_ fault, derived on every read and never stored:
  an open run has an open step that is unassigned, or a ready step on a team with no
  members (`Domain.OrderRow.attention`, `src/lib/Domain.ts:1437`; the definition of
  unassigned is in the workflow docblock at line 583). The remedy is the workflow
  editor or the members page. Renders as a critical badge
  (`src/routes/app.orders.index.tsx:485`).
- **`blocked`** — a _worker raising a hand_: the one flag a person sets, with an
  optional reason (`RunFlag`, `src/lib/Domain.ts:2037`). The remedy is the order page,
  probably intervention.
- **Reconcile flags** — `item_removed`, `quantity_changed`, `order_cancelled`,
  `order_deleted`, `item_added`, `order_fulfilled`: _the order moved under a live
  run_. The remedy is usually to accept and move on, sometimes to cancel the run.

Today the last two both render as one `Flagged` warning badge inside the
`in_production` branch (`src/routes/app.orders.index.tsx:104`), sitting next to the
critical `Needs attention` badge — three remedies compressed into two indistinguishable
alarms. At minimum, split the worker-set `blocked` from the reconcile flags, since
those are the two a merchant acts on differently and `flagDetail` already carries
enough to tell them apart.

### 3. The team filter

**Settled: the filter means _currently waiting on team X_** — the team has a ready
step, evaluated through `readyWhere` inside `listQueue`
(`src/lib/WorkflowRunRepository.ts:1436`). It is labelled **"Waiting on"**, not
"Team".

The rejected reading was _owns a step anywhere in the run_: a superset that pulls in
orders the team finished days ago and orders it will not touch for two more stages,
which reads as noise. Labelled "Team", merchants read the filter that way regardless
and then distrust the result, which is why the label carries the predicate.

Two consequences worth holding on to. Reusing the queue's predicate makes the
merchant's filter and the worker's queue agree by construction rather than by comment
— one definition, two surfaces. And it is the same predicate the waiting-on column
uses, so the filter selects exactly the rows whose cell names the team: nothing to
explain about why a row matched.

**Placement.** The filter card today is the stage strip plus `paid` and
`Needs attention`, and it deliberately carries "one filter idiom rather than two"
(`src/routes/app.orders.index.tsx:521`). A team picker is a select, not a toggle, so
it breaks that idiom. Put it beside the `paid` select — two selects, one row — and
treat the primary _entry path_ as a drill-in from team detail that sets `?team=`, with
the chip shown only when active. Merchants arrive at this from a suspicion about a
particular team, not by browsing a picker.

**Do not put counts on the team options.** `OpenStageCounts` is bounded on purpose:
open stages only, read through the partial index over unfulfilled uncancelled orders,
and independent of the `paid` filter so the strip reads the same in every payment view
(`src/lib/Domain.ts:1505`). Keep it independent of team for the same reason. A count
per team option is a new aggregate on every refresh of a subscribed page.

**Query keys are fine.** `ordersQueryKey` already fans out per filter combination and
relies on prefix invalidation of `["orders", shop]`
(`src/routes/app.orders.index.tsx:26`). Team is one more dimension; the prefix match
still reaches it. The cost is one more cached read per distinct combination, not a new
invalidation path.

### 4. Intervention stays on the detail page

Index rows triage and navigate; the order page acts. Bulk start/complete from an index
row is where correctness bugs live — undo blocking, `undoVerdict`, downstream packing
state — and none of that reasoning survives being flattened into a row.

~~The one exception worth considering is **Assign team** for an unassigned step~~ —
withdrawn, see Refinements §4. No actions in index rows.

## Recommended sequence

Done, in this order; see "What shipped" above.

1. **Alarm disambiguation.** Split the worker's `blocked` from reconcile drift in
   `RunCounts` and the badge, so the badge implies the remedy. Smallest change, no
   schema work.
2. **Waiting-on column.** Hoist `readyWhere`, add `waitingOn` team ids to `OrderRow`
   and the roster to `OrdersView`, render distinct team names capped at three. Makes
   the index answer "who is holding this" with no new filter, no new page, and no new
   subscription shape.
3. **Team filter**, as _Waiting on_, through the same hoisted predicate.
4. **Link in from team detail** — the `?team=` drill-in that makes the filter
   discoverable from the suspicion that prompts it.

Steps 1 and 2 are one change and worth doing whether or not the team filter is ever
built; steps 3 and 4 are a second change, and step 3 is much weaker without step 2.

## Deliberately not doing

- A team dashboard, work list, or step tree under `/app/teams`.
- Any member-scoped work or activity view.
- Per-team counts on the orders stage strip or filter options.
- Step actions in index rows, Assign team included.

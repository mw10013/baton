# Member queue at scale: bounding the page, the read, and the fan-out

Research into why `/shop/$shop` (the member queue) stops working as a shop grows, what it costs
today, and which of several designs to take. Measured against the running dev server on
2026-09-18 with the seeded `sandbox-shop-01` fixture, logged in as `lead@m.com` (a member of
every team). Code references were checked against the tree the same day.

**Status: research only. Nothing implemented.** Open questions in §9.

**Verdict:**

1. **The page is unbounded in three places, and all three are the same list.** `listQueue`
   returns every ready step of every open run for the member's teams; `listDone` returns up to
   100 finished steps; the route renders all of it (Up next capped at 10 cards client-side,
   Done behind a toggle, but both fully fetched and hydrated). §2.
2. **SQLite row reads are not the cost.** Durable Object SQLite bills $0.001 per million rows
   read after 25 billion included per month. A queue read is a few hundred rows. What scales
   badly is the **fan-out multiplier**: every member write publishes to every connected member
   on the touched teams, and each of them re-runs the full read and re-serializes the full view.
   The bill for that is DO wall-clock, JSON bytes, and client decode + render time, not rows. §3.
3. **The push mechanism is a bare invalidation hint** (`{ type: "invalidated" }`,
   `src/lib/ShopAgent.ts:1223`), throttled 2 s on the client. It carries nothing, so the client
   cannot tell a relevant change from an irrelevant one, and refetches the whole view either
   way. That design is correct for correctness and should stay; the fix is to make the view it
   refetches small and to let the object say "nothing changed for you." §3, §5.
4. **Recommendation: bound the view server-side, split Done off the subscribed read, and
   redesign the card into a row.** Cap every tier in the object (counts still exact), page Up
   next and Done by cursor on demand, stamp the view with a version so a no-op push is a no-op
   refetch, and render one line per run with the card as the expanded state. Keep the
   invalidate-and-refetch model. Do not build delta pushes or virtualization for 1.0. §6, §7.

---

## 1. The problem as observed

Screenshot of the full page at the seeded size (`logs/queue-full.jpeg`, 39,582 px tall at 2×):

| Measure                                | Value                                                          |
| -------------------------------------- | -------------------------------------------------------------- |
| Queue items (`view.items`)             | 99 runs, 123 ready steps                                       |
| Done today (`view.done`)               | 100 (the `DONE_LIMIT` cap, hit)                                |
| Cards in the DOM (Done expanded)       | 174 bordered `s-box` cards                                     |
| Document height                        | 19,791 px, ≈21 viewports at 941 px                             |
| SSR HTML                               | 330 KB                                                         |
| of which dehydrated loader data        | 250 KB (one `<script>`), ≈1.25 KB per run row                  |
| of which rendered DOM                  | 79 KB                                                          |
| Reads of the full view on a cold visit | 2: the loader (`listQueue`), then `subscribeQueue` on identify |

The seed is a medium shop's morning: 99 open runs, 100 completions in the last day. A Basic
plan allows 250 orders a month and Pro 1,000 (`docs/limits-and-plans-research.md` §6), so at
Pro the open list can be several hundred runs and Done saturates its cap every day. The page
does not fail at that size; it becomes a scroll with no landmarks, and every push re-renders
all of it.

Three distinct scaling failures share the page:

- **Visual.** A card is ≈180 px for a one-step run, more with a flag banner, notes, or several
  steps. Twenty-plus viewports is not a queue; a member cannot see what is next without
  scrolling past what is not theirs. The `UP_NEXT_CAP = 10` and the Done toggle
  (`src/routes/shop.$shop.index.tsx:64-71, 340-378`) are render caps only; the chips filter
  client-side on the full list.
- **Payload.** 250 KB of dehydrated state on every SSR, and the same bytes again on every
  socket refetch, per member, per push.
- **Fan-out.** One Done click by one member becomes N full reads and N × 250 KB serializations
  in one object, where N is the number of members connected on the touched teams.

## 2. What the page does today

### 2.1 The read

`ShopAgent.readQueue` (`src/lib/ShopAgent.ts:3050-3075`) runs two repository calls and
returns `Domain.QueueView = { items, done }`:

- `listQueue({ teamIds })` (`src/lib/WorkflowRunRepository.ts:1434-1500`): every ready step
  (`readyWhere`: open, and nothing open in an earlier stage of the run) of every open run that
  has at least one ready step for the member's teams, then those runs joined to the order note.
  No limit. Grouping happens in TypeScript.
- `listDone({ teamIds, since: now − 24 h, limit: 100 })` (`:1502-1540`): finished steps for
  the member's teams in the window, plus their runs, plus **every step of those runs**
  (`stepsForRuns`) to compute `undoBlockedBy`. Three statements; the third is the widest.

Neither takes a page or a cursor. `Domain.DONE_LIMIT` is the only server-side bound
(`src/lib/Domain.ts:2603`, "so a busy shop's queue read stays one screen of rows"; at 100
cards it is not one screen).

The same read serves two callers: the SSR loader via `ShopAgentClient.listQueue` (plain RPC),
and `subscribeQueue` over the member socket (`:3102-3120`), which registers the connection's
subscription and returns the view in one round trip.

### 2.2 The tiers

`tierQueue` (`src/lib/queueTiers.ts`) buckets items client-side into Blocked, Mine, In
progress, Up next, each sorted oldest-order-first. The route comment at
`shop.$shop.index.tsx:64-71` states the assumption the design rests on: "the other tiers are
small by construction … and Up next is the only unbounded one." That holds for Mine and In
progress (a person holds a few things). It does **not** hold for Blocked: a reconcile pass can
flag dozens of runs at once (`order_cancelled`, `quantity_changed`, `order_fulfilled`), and
every flag lands in the first tier with a full banner. In the screenshot Blocked is 7 and
already fills the first three viewports.

### 2.3 The push

`publish(touched, teams)` (`src/lib/ShopAgent.ts:1373-1387`) iterates every open connection
and, for a member connection whose `teamIds` intersect `teams`, sends
`{ type: "invalidated" }`. The five member mutations publish to the teams owning any step on
any run of the touched order (`publishToTeams`, `listOrderTeamIds`); everything else
(bulk sync, reconcile, merchant edits, workflow apply/switch) publishes `"all"`, which reaches
every member.

The message carries no data by design ("best-effort hints, never the new value: SQLite stays
authoritative", `:1346-1350`). The client (`src/lib/useSubscribedQuery.ts`) throttles
invalidations leading + trailing over 2 s (`INVALIDATION_THROTTLE_MS`) and refetches through
`subscribeQueue`, which re-registers the subscription and returns the whole view.

So the loop per write is: one write → `listOrderTeamIds` (one indexed query) → K sends → K
throttled full reads → K × full JSON serializations → K full React re-renders of 174 cards.

## 3. What it costs, honestly

Reads cost money, but not where the pain is.

| Dimension                       | Rate (`refs/cloudflare-docs`, DO pricing partial)          | At one queue read                              | Verdict                               |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| SQLite rows read                | 25 B/month included, then $0.001 / million                 | ≈ 500–2,000 rows (steps × `readyWhere` probes) | Negligible at any plausible N         |
| DO requests (WebSocket message) | 1 M/month included, then $0.15 / million; WS messages ÷ 20 | 1/20 of a request                              | Negligible                            |
| DO duration                     | $12.50 / million GB-s; billed while awake                  | Read + serialize 250 KB ≈ single-digit ms      | Small per read, multiplies by fan-out |
| Bytes on the wire               | Free egress on Workers, but paid for in client time        | 250 KB per refetch                             | The real cost, on the phone           |
| Client render                   | Not billed                                                 | 174 Polaris web components, 223 step blocks    | The other real cost                   |

Worked example, Pro-sized shop: 10 members on the floor, each completing a step every two
minutes over an 8-hour shift → 2,400 writes/day. Each write reaches, say, 6 of the 10 (teams
overlap through `listOrderTeamIds`) → 14,400 full refetches/day → **3.6 GB of JSON serialized by
one Durable Object and decoded by tablets on shop Wi-Fi**, to move a few cards. Row reads for
the same day: ≈ 20 million, or two cents. The throttle halves the refetch count under bursts
but not the per-refetch size.

The bulk sync is not a storm: `onOrdersStream` publishes `"all"` once when the stream
finishes, and `syncOrders` once when it starts (`src/lib/ShopAgent.ts:1617, 1663`). What does
reach every member per event is the webhook path: each `syncOrder` reconciles one order and
publishes with `teams = "all"`, so every connected member refetches the full view once per
order webhook, whether or not their teams own a step on it.

Conclusion: **optimize bytes per refetch and refetches per write, in that order.** Rows read
can be ignored as a design input.

## 4. Where the design already points

Two idioms in the tree already solve the same problem for the merchant side:

- **Cursor pagination on the orders index.** `OrderRepository` pages by
  `(processedAt, id)` cursor with a limit (`src/lib/OrderRepository.ts:58-63, 201`), and the
  orders index subscribes with the same `subscribeOrders` pattern (`ShopAgent.ts:1985-2008`),
  refetching only the current page on a push. The queue can do the same with
  `(orderProcessedAt, orderName, id)`, the sort key `byAge` already uses.
- **Team-scoped publish.** `publishToTeams` already narrows member pushes; the remaining
  `"all"` publishers are the ones a bounded view makes cheap rather than the ones to fix.

## 5. Options

### A. Bound the read in the object (server-side tier caps + counts)

`listQueue` computes tiers in SQL (flag not null; started by me; started by anyone; else) and
applies a per-tier limit, returning `{ tier, items, total }` for each. Blocked, Mine, In
progress get a generous cap (say 25); Up next gets 10 with a cursor. Chip counts come from a
single `group by teamId` over ready steps instead of `items.filter` on the client.

- **Pro:** payload drops from ≈250 KB to ≈15–30 KB regardless of shop size. Every refetch, SSR
  or push, is small. Counts stay exact. No client architecture change: `useSubscribedQuery`
  keeps working, the page just receives less.
- **Con:** the team chip filter becomes a server parameter (the subscription must carry it, or
  the page refetches on chip change). `tierOf` moves from TypeScript into SQL, with the "mine
  by email, not id" rule (`queueTiers.ts:27-34`) reproduced there. Two truths unless the
  TypeScript version is deleted.
- **Cost:** medium. One repository function, one Domain schema change, route reshuffle.

### B. Split Done off the subscribed read

Done today becomes its own query: not fetched on SSR, not part of `subscribeQueue`, loaded
when the member opens the tier, paged 10 at a time by `(completedAt, id)` cursor. Its
subscription is the same team subscription (a push invalidates it too, but only while open).

- **Pro:** removes the widest statement (`stepsForRuns` over 100 runs) and half the payload
  from every refetch. Done is the tier a member reaches for rarely (to Undo), and the
  heading count is what they read.
- **Con:** the JSDoc on `QueueView` (`Domain.ts:2582-2588`) argues for one snapshot so a
  teammate's Undo "moves a card between the two halves under one push." With two queries the
  two halves can be one push apart for up to 2 s. Acceptable: the card reappears in Up next on
  the next refetch either way.
- **Cost:** low. `listDone` already takes `limit`; add `before` and a count.

### C. Version-stamped invalidation (skip the no-op refetch)

The object keeps a per-team monotonic `version` (bumped in the same transaction as any
`WorkflowRun`/`WorkflowRunStep` write that touches the team). The push carries
`{ type: "invalidated", version }`; `subscribeQueue` returns `version` with the view; the
client refetches only if the pushed version is newer than what it holds, and `subscribeQueue`
accepts `ifVersion` and returns `unchanged` when equal.

- **Pro:** cuts the fan-out for the common case where the push reached a member whose
  teams' view did not actually change (over-broad `listOrderTeamIds`, bulk sync publishing
  `"all"`). Cheap: one integer per team in a singleton table, same pattern the plans research
  chose for counters (`limits-and-plans-research.md` §7).
- **Con:** only helps when the view is unchanged. Under a real write the refetch still runs.
  Does nothing for page size. Adds a write per mutation.
- **Cost:** low–medium.

### D. Delta pushes (send the changed rows)

The push carries the changed runs and steps; the client patches its cache.

- **Pro:** the smallest possible bytes per write; no refetch at all.
- **Con:** breaks the stated invariant that pushes are hints and SQLite is the truth. Needs
  sequence numbers, gap detection, and a full refetch on reconnect anyway (the reconnect path
  already exists and would remain). Tier membership depends on rows the client may not hold
  (readiness crosses stages; `undoBlockedBy` crosses runs), so a patch is not enough to
  recompute a card without the full run. This is the design that produces "queue silently
  wrong" bugs, which the current JSDoc explicitly traded away.
- **Cost:** high, and it changes the contract for every subscribed page.

### E. Client virtualization (TanStack Virtual, windowed rendering)

Render only the cards in the viewport.

- **Pro:** fixes DOM size and render time for any list length.
- **Con:** fixes nothing about payload, SSR, or fan-out; Polaris web components inside a
  virtualizer are awkward (variable card heights, `s-box` layout); SSR renders nothing below
  the fold, which is fine, but the loader still ships 250 KB. Solves the least important of the
  three failures.
- **Cost:** medium. Not in the dependency set today.

### F. Redesign the card into a row (UI)

One line per run: order name, item title, step name, age, one status word, and the primary
action. Tap expands to the current card (attributes, instructions, note, flag banner, siblings).
Blocked rows show the flag as a badge, not a banner. Done today is a count in a heading with a
"Show" that pages 10 at a time. Search by order number at the top for the "find one order by
name" trip the route comment names.

- **Pro:** ≈40 px per run instead of ≈180; 100 runs is two viewports, not twenty-one. A
  member scans a column of order numbers, which is how they think about the floor. Does not
  depend on A–C, and A–C do not depend on it.
- **Con:** the current card's argument (instructions visible before Start, the flag as a
  banner that "cannot wait") gets weaker; the expanded row has to carry it. One tap more to
  read instructions. Needs a design pass with Polaris web components: `s-clickable` for the
  row (already used in `WorkflowStages.tsx`), `s-badge` for the flag, `s-box` / `s-stack` for
  the expanded body. `s-table` exists and the admin pages use it, but it is a data table with a
  header row and no expandable body, so it is the wrong shape for a queue row.
- **Cost:** medium. Route rewrite; the domain and object are untouched.

### G. Narrow the `"all"` publishers

The webhook path (`syncOrder` → reconcile) publishes `teams = "all"`. Reconcile knows the runs
it created, cancelled, and flagged, so it can name the teams (`listOrderTeamIds` by order id)
and publish to those. Same for `cancelRun`, `uncancelRun`, and `assignRunStepTeam`, which each
touch one run.

- **Pro:** a webhook for an order no member team owns stops refetching every member's queue.
  On a shop with many non-workflow orders that is most webhooks.
- **Con:** one more query per webhook. The workflow-level publishers (apply, on/off, delete,
  tag change, team delete) stay `"all"`; they genuinely change every queue.
- **Cost:** low. Independent of everything above.

## 6. Comparison

| Option              | Bytes / refetch | Refetches / write       | Visual length | Changes the push contract | Effort  |
| ------------------- | --------------- | ----------------------- | ------------- | ------------------------- | ------- |
| A. Server tier caps | ↓↓↓             | —                       | ↓             | No                        | Med     |
| B. Split Done       | ↓↓              | ↓ (Done only when open) | ↓             | No                        | Low     |
| C. Version stamp    | —               | ↓ (no-op pushes)        | —             | Additive field            | Low–Med |
| D. Delta pushes     | ↓↓↓             | ↓↓↓                     | —             | **Yes**                   | High    |
| E. Virtualization   | —               | —                       | ↓↓ (DOM only) | No                        | Med     |
| F. Row layout       | —               | —                       | ↓↓↓           | No                        | Med     |
| G. Narrow `"all"`   | —               | ↓ (webhooks)            | —             | No                        | Low     |

## 7. Recommendation

Take **A + B + F now, G alongside, C as the follow-up, never D, and E only if F is not
enough**.

1. **B first**: pull Done out of `QueueView`. Cheapest change, halves every refetch, removes
   the `stepsForRuns` scan. `QueueView` becomes `{ items, doneCount }`; a new
   `subscribeDone({ before, limit })` serves the tier when opened.
2. **A**: `listQueue` takes `{ teamIds, teamFilter, upNextLimit, upNextBefore }` and returns
   tiers with totals and per-team counts. Blocked, Mine, In progress are returned whole but
   with a hard ceiling (25 each; past that the heading says "Blocked · 40, showing 25" and the
   member is told to use the merchant order index, which is the history view). Up next pages
   by cursor. The chip becomes a subscription parameter, so a chip change is a refetch of a
   small page, not a client filter over a big one.
3. **F**: rows, not cards, with the card as the expanded row. Keep the tier order and the
   oldest-first sort. Keep Blocked visually loud (badge + tinted row), not tall.
4. **G**: the webhook reconcile and the single-run mutations publish to the teams they touched.
5. **C** when a real shop shows refetch counts that matter. Measure first with a log line on
   `subscribeQueue` carrying `shop`, `teamIds.length`, `items.length`, and elapsed ms.

After 1–3 a Pro-sized queue is ≈30 KB per refetch and two viewports, and a write costs K small
reads instead of K large ones. The invalidate-and-refetch model, `useSubscribedQuery`, and the
"hint not value" invariant all stay.

## 8. Prototype constraints that bind the implementation

- **No new migration.** Any schema addition (a per-team version row for C, an index on
  `WorkflowRun (status, orderProcessedAt)` for the cursor) goes inline into
  `1_initialize schema` in `src/lib/ShopAgent.ts`.
- **Every cap is provisional** and carries a JSDoc saying so: 25 per bounded tier, 10 per Up
  next page, 10 per Done page.
- **Counts must not be `count(*)` over unbounded tables** on every read. Per-team ready counts
  are a `group by` over the same rows `listQueue` already scans, so they are free; do not add a
  separate counting query.
- **`tierOf` lives in one place.** If A moves tiering into SQL, delete the TypeScript copy or
  reduce it to a type, so the two cannot drift (the `undoBlockedBy` JSDoc makes the same
  argument for its own rule).

## 9. Decisions on the open questions

Reviewed 2026-09-18. §7 was accepted. Each question below now carries a recommendation; the
implementation follows these unless overruled.

### 9.1 Instructions behind a tap: yes

The row shows the order number, the item, the step name, the age, and the primary button. The
expanded row shows what the card shows today: attributes, instructions, note, siblings, the
flag banner. Two defaults keep the tap from costing anything where it matters:

- **Mine rows open expanded.** Those are the runs the viewer has in hand, there are a few of
  them, and the instructions are for exactly that person.
- **Every other tier opens collapsed.** A maker reads instructions when they pick the work up,
  which is the moment they tap Start, and the row can expand on Start.

### 9.2 Blocked: cap the tier, do not move the flags anywhere

What §5 meant, in plain terms: there are two kinds of flag on a run. `blocked` is raised by a
member ("crest file missing"). The other five (`order_cancelled`, `item_removed`,
`quantity_changed`, `order_deleted`, `order_fulfilled`) are raised by reconcile when Shopify
changes an order under a run in progress. Reconcile can raise dozens at once (a merchant
cancels a batch), and each one lands in the member's Blocked tier as a full banner. The
"merchant order index" is the merchant's own page in the Shopify admin (`/app/orders`), which
lists every order with its flags; members cannot see it. The question was whether a mass flag
event is the merchant's problem to clear from that page rather than the member's.

Recommendation: **it stays in the member's queue.** A maker with a cancelled item on the bench
needs to know now, and Dismiss is one tap. The tier is capped at 25 rows with the true count in
the heading ("Blocked · 40") and a "Show more" that pages. Flag rows are collapsed like any
other row, with the flag kind as a badge and the reason as the second line, so 40 of them is one
screen, not ten.

### 9.3 The team chips: what they are, and make them a server parameter

A member is on one or more teams (`Member` ↔ `Team` in D1). The queue only ever shows steps
owned by the member's own teams; nobody sees other teams' work. The chips appear **only when
the member is on more than one team** (`shop.$shop.index.tsx:293`) and let them narrow to one
of their own teams. `lead@m.com` is on all seven seeded teams, which is why the screenshot
shows seven chips and 99 runs; a typical maker is on one team and sees no chips at all.

"All" means "all of my teams," not "everyone's work." The question was whether a multi-team
member usually looks at one team at a time. Recommendation: **keep the chips, move the filter
into the subscription.** The default subscription is all of the member's teams; choosing a chip
re-subscribes with that one team. With paged tiers the difference in payload is small either
way; what matters is that the chip counts come from the object, not from a client-side filter
over a full list that no longer exists.

### 9.4 Done today: Undo only

Done today is the list of steps the member's teams finished in the last 24 hours, each with an
Undo button. A member opens it for one reason: they tapped Done on the wrong thing and want it
back. It is not a report of the day's output; the merchant's order pages are the record.

Recommendation: **heading with the count, collapsed by default, expand loads the 10 most
recent, "Show more" pages by cursor.** Not fetched on SSR and not part of the subscribed
queue read (§5 B). No date picker, no totals, no separate page.

### 9.5 Search: none for 1.0

The scenario a search box serves is "someone asked me where #1234 is." In a made-to-order
shop that question comes from a customer to the merchant, and the merchant answers it from the
order page in the admin, which shows every run and step of the order. A maker is handed work by
the queue, oldest first, and rarely goes looking for one order by number. There is no evidence
either way in the competitor material (`docs/route-to-ship-departments-research.md` describes
a queue "grouped by order" with no search).

Recommendation: **no search box.** Rows are compact enough that a member can scan a screen of
order numbers. If a real shop asks for it, add a filter on `orderName` to the subscription
input; the cursor design makes that a one-parameter change.

### 9.6 Design mock: built

A static HTML mock of the row layout at the seeded data volume is at
`docs/member-queue-ux/queue-rows-mock.html`, so the row design can be judged against the
screenshot in `logs/queue-full.jpeg` before the route is rewritten. Same 99 runs and 7 teams;
Blocked rows badged, Mine expanded, Up next paged, Done collapsed with a count.

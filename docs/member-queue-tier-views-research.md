# Member queue: one tier per screen, one tier per read

Follow-up to `docs/member-queue-scale-research.md` and `docs/member-queue-scale-plan.md`, which
shipped in commit `1ff1e3e` (2026-09-19). That work bounded the read, split rows from cards, and
moved tiering into the object. Reviewed against the seeded `sandbox-shop-01` as `lead@m.com` on
2026-09-19 it still falls short in two places the user named: the page still scrolls, and every
push still ships every tier to every member. This document measures where the shipped design
stands, weighs the "show one tier at a time, load one tier at a time" idea against alternatives,
and recommends one.

**Status: research only. Nothing implemented.** Questions for the user in §8.

**Verdict:**

1. **The shipped page is 4.3 viewports of stacked tiers, and the stack is the problem.** Blocked,
   Mine and Up next are three lists a member reads for three different reasons, laid end to end.
   The member who wants Up next scrolls past 23 rows of other people's problems and their own
   half-done work to reach it. Caps made the stack shorter; they did not remove it. §1.
2. **Every refetch still carries every tier.** A push refetches `QueueView` whole: four tiers,
   team counts, the Done count. At the seeded size that is 48 KB of dehydrated state on SSR and
   the same JSON on each of the K refetches a write fans out to. The member is looking at one
   tier. §1, §2.
3. **Recommendation: make the tier the view.** A segmented control (Blocked · Mine · Up next ·
   Done) with counts, one list under it, and one read per screen: the counts strip plus the
   selected tier's rows. The team chips become a select. Keep the invalidate-and-refetch push
   exactly as it is. Do **not** build per-tier push filtering: the counts strip is on every
   screen and changes on every write, so a tier-scoped push saves nothing until counts are pushed
   as data, which the invariant forbids. The content-hash short-circuit (C) is deferred: the
   trade-offs are in §6.1, and the user judged it more complexity than the queue needs now.
   §5, §6, §6.1.

---

## 1. Where the shipped design stands

Measured on the running dev server, headless Chromium at 1280 × 720, signed in as `lead@m.com`
(seven teams). Screenshot: `logs/queue-rows-now.png`.

| Measure                                      | Before (2026-09-18) | Now                                         |
| -------------------------------------------- | ------------------- | ------------------------------------------- |
| Rows on first paint                          | 174 cards           | 33 rows                                     |
| Page height                                  | 19,791 px           | 3,085 px                                    |
| Viewports at 720 px                          | 27                  | 4.3                                         |
| SSR HTML                                     | 330 KB              | 111 KB                                      |
| Dehydrated loader data (`QueueView`)         | 250 KB              | 48 KB                                       |
| Rendered DOM                                 | 79 KB               | 62 KB                                       |
| `ShopAgent.readQueue` ms (`logs/server.log`) | —                   | 3–8                                         |
| Tier totals                                  | —                   | Blocked 7 · Mine 16 · Up next 76 · Done 128 |

What the screenshot shows, top to bottom:

- **Two rows of team chips**, eight buttons, before anything a member can act on.
- **Blocked · 7.** Six compact rows, then `#1026`, whose blocked reason is a paragraph. Line two
  is not clamped, so one long reason is a 300 px row. A reconcile burst of 25 would be a full
  screen of badges even with clamping.
- **Mine · 16.** Sixteen rows, all `In progress · you`. This is the list this member actually
  works from and it starts 1,000 px down.
- **Up next · 76, showing 10.** Starts at 2,200 px. A maker on one team opens this page to find
  the next thing to start. On a phone it is three screens away.
- **Done today · 128, Show.** Collapsed. The count is read on every refetch.

Three observations that the previous research did not weigh:

1. **Tiers are modes, not sections.** A member reading Blocked is unblocking. A member reading
   Mine is finishing. A member reading Up next is choosing. Nobody does all three in one scroll,
   and the previous design's own §9.1 says so ("a maker reads instructions when they pick the
   work up"). Stacking modes vertically forces the scroll the user is objecting to.
2. **The cap is a tuning knob with no right value.** `QUEUE_TIER_CAP = 25` is too many rows for a
   tier the member is scrolling past and too few for the one they are in. No single number fixes
   a stack; a stack is wrong for the job.
3. **`items=33` is the interesting number in the log, not `ms=4`.** Thirty-three rows serialized
   per refetch per member, of which the member is looking at about ten. The read cost is fine
   (§2); the bytes and the render are the cost, and 70 % of them are rows off-screen.

## 2. What a push costs today, per member

The loop (`ShopAgent.publish` → `publishTo` → `{ type: "invalidated" }` → `useSubscribedQuery`
throttle → `subscribeQueue`) is unchanged from the previous research §2.3. Only the size of what
comes back changed.

| Step                            | Cost per member per push (seeded, `lead@m.com`)    |
| ------------------------------- | -------------------------------------------------- |
| `queueItems` (2 SQL statements) | all 99 open runs / 123 ready steps, 3–8 ms         |
| Tier, narrow, cap in TS         | negligible                                         |
| `listDone` count                | 1 indexed `count(*)`                               |
| JSON on the socket              | ≈ 48 KB (33 rows + counts); ≈ 60 KB with Done open |
| Client                          | decode, diff, re-render 33 Polaris rows            |

For a single-team maker the numbers are smaller (`teams=1 items=2` in the log), but the shape is
the same: the read returns tiers the screen is not showing, and a Done on the far side of the
shop refetches it all.

The previous research's fan-out arithmetic (10 members, 2,400 writes/day, ≈6 refetches per
write) now works out to ≈ 700 MB/day of JSON at 48 KB instead of 3.6 GB at 250 KB. Better, and
still five times what the visible tier would cost.

## 3. What the user proposed

Quoted intent: separate views for "all the blocked queue items, or all the mine, or all in
progress that I'm working on, or all up next and all done", each its own query with its own
loaded data, "so there's not that much data, and then we wouldn't be showing long lists with
different blocks in them." And: whether the server could skip notifying a Done view when nothing
in Done changed.

Two proposals in one:

- **P1. Tier-as-view.** One tier on screen at a time, one read per tier.
- **P2. Tier-scoped invalidation.** The push names the tiers a write touched; a client showing
  another tier ignores it.

They are separable. P1 stands on its own. P2 depends on P1 and, as §5 shows, buys less than it
looks like it should.

## 4. How the competition lays this out

From `refs/` listings (`docs/refs-competitors-research.md` for provenance):

- **Route to Ship**: "Workers see only their queue. Tap accept, tick the list, mark done. Tablet
  mode for the floor." The worker tablet screenshot is one flat list of assigned tasks; there is
  no tiering visible at all. Managers get a separate board.
- **Kanbanify**: a board with columns, search bar, per-column sort. Column = state. Merchant-facing;
  no worker view.
- **Maker's Production View**: one queue grouped by product, batch sheets, a checkbox per piece.
  No per-worker state.

Nobody stacks four state lists on one worker screen. The two worker-facing products show one list
per screen. Baton's four tiers are richer than any of them (Blocked and In progress do not exist
elsewhere), which is an argument for keeping the tiers as a way to switch lists, not as sections
of one list.

## 5. Options

### A. Tier segmented control, one read per screen (P1)

The page shows a counts strip (`Blocked 7 · Mine 16 · Up next 76 · Done 128`) as a segmented
control and one list under it. The query becomes
`{ team: TeamId | null, tier: QueueTier | "done", limit }`. `readQueue` returns
`{ counts: { attention, mine, inProgress, upNext, done, total, teamCounts }, rows }` where `rows`
is the selected tier only, capped at `limit`, with `total` for "Show 10 more".

- **Pro.** The list a member is in starts at the top of the page. Payload per read is the counts
  (≈ 300 bytes) plus ≤ 25 rows (≈ 1.2 KB each), so ≈ 10 KB at the default page instead of 48.
  SSR ships one tier. Done stops being a special case: it is a tier whose rows are `DoneItem`.
  `useSubscribedQuery` needs no change; the key already carries the query.
- **Con.** One tap to see a different tier. The "Blocked cannot wait" argument from the previous
  research is served by the count in the strip turning red, not by the rows being above the fold.
  The team chips and the tier control are two rows of controls on a phone (§8 Q3).
- **Cost.** Medium. Route rewrite (smaller than the last one), `QueueQuery`/`QueueView` reshape,
  `listQueue` returns one tier, tests. Repository SQL unchanged.

### B. Tier-scoped push (P2)

The publish carries `{ type: "invalidated", tiers: [...] }` derived at the write site
(complete → done, mine, inProgress, upNext; start → mine, inProgress, upNext; undo → done, upNext,
mine; block/dismiss → attention plus the row's source tier; reconcile → all). The connection's
subscription records its tier; `publishTo` drops the frame when the sets do not intersect.

- **Pro.** A member on the Done tab is not refetched by a Start. A member on Blocked is not
  refetched by a Done.
- **Con.** The counts strip is on every screen and changes on nearly every write: a Start moves
  one from Up next to Mine; a Done moves one from Mine to Done and may promote a row into Up next.
  Suppressing the push leaves the strip stale, which is a visible lie ("Up next 76" while a
  teammate emptied it). Fixing that means pushing the new counts as data, and counts are per
  viewer (Mine by email, teams by membership), so the object would compute K count reads per
  write instead of K full reads, which is the same fan-out with smaller payloads. The client
  cannot recompute counts locally; it does not hold the rows. And "Mine" membership depends on
  who wrote, so the write site would name tiers per recipient, not per write.
- **Cost.** Medium, plus a new invariant ("the push says what changed") that the existing
  JSDoc on `publish` and `Domain.Subscription` argues against for a reason: under-broad pushes
  produce queues that silently stop updating. The previous plan's own §10.4 already found two
  under-reach bugs in the narrower team-scoped publish.

### C. Content-hash short-circuit on the read

`subscribeQueue` accepts the hash of the view the client holds. The object runs the read, hashes
the result, and returns `{ unchanged: true }` when equal. The client keeps its data and skips
decode and render.

- **Pro.** Cheap and safe: the read still runs, so nothing can go stale; only serialization,
  transfer, and render are skipped. Catches every over-broad push (bulk sync `"all"`, webhook for
  an order the member's team owns but whose visible tier did not move, and under A, every write
  that touched a tier the member is not on while leaving the counts unchanged). No new invariant.
- **Con.** Does not reduce object CPU; §2 says that is 3–8 ms and not the cost. Needs a stable
  serialization to hash (sorted keys, or hash the `sql` row values before decoding).
- **Cost.** Low. One field on `SubscribeQueueInput`, one branch in `readQueue`, a hash in the
  Worker (`crypto.subtle.digest` on the JSON string).

### D. Push the counts, refetch rows lazily

The push carries the recipient's new counts; rows refetch only if the visible tier's count
changed or the visible tier was named.

- Rejected: per-recipient computation on publish (see B con), and a tier can change without its
  count changing (a swap). Listed so it is not proposed again.

### E. SQL-side tiering with `limit` (bound the scan)

Move `tierOf` into the `queueItems` SQL as a `case` and apply `limit` per tier there, so the read
touches only the rows it returns.

- Deferred, as the previous plan's §10.5 decided: `ms=` is 3–8 at 99 runs. Under A the read
  computes four counts and one tier's rows; counts still scan ready steps once. Revisit when
  `ms=` is watched on a real shop. A makes E easier later because `listQueue` already returns one
  tier.

### F. Clamp the second line and cap the reason

`s-text` with `-webkit-line-clamp: 2` on line two; the full reason in the expanded row. Not an
architecture change; included because `#1026` is a third of the Blocked tier's height today.

## 6. Recommendation

**A + F now. C deferred (§6.1). In progress is its own tab (§6.2). Not B, not D. E later.**

The page:

```
[ Team ▾ All · 99 ]                                              ← s-select, only when teams > 1
[ Mine 16 ] [ Up next 76 ] [ In progress 0 ] [ Blocked 7 ] [ Done 128 ]   ← s-button-group, sticky
#1001  Cut and sand · Engraved cutting board     16m   [Start]
#1003  Stamp monogram +1 · Leather journal       16m   [Actions ▾]
…
[ Show 10 more of 66 ]
```

Rules:

- **Default tab: Mine.** Decided (§8 Q2). The first tab is what the member is finishing; the
  empty state on Mine says "Nothing in hand" with a link to Up next. Simpler than a Mine-else-Up
  next rule, and the tab order reads left to right in the order a member works: finish, start,
  cover, fix, undo.
- **Sticky strip.** Team select and tier control stay pinned; the list scrolls under them. The
  member never loses the counts or the way out of the tier.
- **In progress is its own tab.** Reasoning in §6.2. The strip is an `s-button-group` that
  scrolls horizontally when five segments do not fit; a zero-count tab stays in place, dimmed.
- **Tab in the URL** as a search param (`?tier=mine`), validated with `validateSearch` and a
  `Schema.Literals` the way `app.orders.index.tsx` does, navigated with `replace: true`. Decided
  (§8 Q4). Team stays client state as before.
- **Team control: `s-select`**, decided (§8 Q3). Per-team counts are a lead's question ("how
  deep is Engraving"), not a maker's; most makers are on one team and see no control at all. The
  select's options carry the counts (`Engraving · 32`) so the number is one tap away, and the
  tier strip gets the one row of horizontal space a phone has.
- **Counts are query-independent**, as now: over every team on the connection regardless of the
  team select, so the select does not move under the finger. Tier counts do narrow with the team
  select, because they describe the list about to be shown.
- **Read shape.** `readQueue` returns `{ counts, tier: { items, total } }`. `queueItems` runs once;
  counts and the selected tier both come from it. `listDone` returns rows only when
  `tier === "done"`; its count is always read (one indexed statement, as now).
- **C is deferred**, including its instrumentation. See §6.1 and §8.
- **Push unchanged.** `{ type: "invalidated" }`, team-scoped, throttled 2 s. B is not built.
- **Expanded state** resets on tab change. A tab is a different list.

What this does to the numbers at the seeded size:

| Measure                         | Now   | A + C, Mine tab, 16 rows                |
| ------------------------------- | ----- | --------------------------------------- |
| Rows on first paint             | 33    | 16                                      |
| Page height                     | 3,085 | ≈ 1,100 (1.5 viewports)                 |
| Dehydrated loader data          | 48 KB | ≈ 20 KB                                 |
| Refetch payload, view changed   | 48 KB | ≈ 20 KB (Mine) / 13 KB (Up next page 1) |
| Refetch payload, view unchanged | 48 KB | < 100 bytes                             |
| Reads per push                  | 1     | 1                                       |

Scrolling on Up next at 76 is "Show 10 more" seven times, which is the previous plan's
`QUEUE_LIMIT_MAX = 100` dead-button problem (§10.7 there). It does not get worse under A and it
is not solved by A; search is the answer and remains out of scope.

### 6.1 C, the content-hash short-circuit: what it buys and what it costs

The mechanism. The client already holds a `QueueView` for its key. With C it also holds a hash
of that view. On a push it calls `subscribeQueue({ ..., query, ifHash })`. The object runs the
read as it does today, hashes the result, and returns `{ _tag: "Unchanged" }` when the hash
matches, otherwise `{ _tag: "View", view, hash }`. The hook keeps its data on `Unchanged`.

What it does not do: it does not skip the read. The object still scans ready steps and counts
Done. C saves the JSON serialization in the object, the bytes on the socket, the decode and the
React render on the tablet. Per §2 those are the costs that matter and the read is not.

When it pays: only when a push reaches a member whose read comes back identical. That happens
for

- every `publish("all")`: bulk sync start and end, workflow apply, on/off, delete, tag change,
  team delete;
- a webhook `syncOrder` whose reconcile changed nothing visible to this member (the common
  webhook: an order edit on a field no run reads);
- a teammate's write on a team the member shares that moved a row in a tier the member is not
  on **and** left every count the same, which is rare, because a Start or Done changes two
  counts.

When it does not pay: any write on the member's team that moves a row. Under A that is most
writes during a shift, because the counts strip changes with them. C is a win for the quiet
periods and the noisy publishers, not for the busy floor.

What it costs:

| Piece                            | Size                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable hash of the view          | Hash the JSON string. `JSON.stringify` of a value built by one code path is stable; it must stay the object's serialization, not the client's. ≈ 10 lines.                                                                                                                            |
| `SubscribeQueueInput.ifHash`     | One nullable string field.                                                                                                                                                                                                                                                            |
| Result union `Unchanged \| View` | One schema, one branch in `readQueue`, one in `subscribeQueue`.                                                                                                                                                                                                                       |
| Hook change                      | `queryFn` must return the previous data on `Unchanged`; the hook reads `queryClient.getQueryData` for the key and stores the hash beside the data. ≈ 20 lines in `useSubscribedQuery`, which every subscribed page shares, so the orders pages must keep working with `ifHash: null`. |
| Loader                           | SSR view carries its hash so the first subscribing read can already say `Unchanged`.                                                                                                                                                                                                  |
| A new failure shape              | A hash that says "unchanged" when the view did change is a stale queue until the next push. Only possible if serialization is not deterministic.                                                                                                                                      |

About 60 lines, one new response shape, one subtle invariant (deterministic serialization).
Not large, not free.

Decision: **deferred** (§8 Q5). A already cuts the payload of every refetch, changed or not, by
60 %, and the benefit of C is a guess until the ratio of no-op refetches is known. When it is
revisited, the cheap first step is to measure without changing the protocol: `readQueue` computes
the hash, compares it to the last hash it handed that subscription, and logs `changed=true|false`
with the existing `ms=` line. If more than a third of refetches are `changed=false`, build C.

### 6.2 In progress: own tab, not folded into Up next

The first draft folded In progress into Up next to keep four segments on a phone. The user's
instinct is that they are naturally separate. They are, on three counts:

1. **Different question.** Up next answers "what can I start." In progress answers "what is
   someone else holding." A member covering a bench opens In progress to find the half-done
   work; a member choosing work does not want it in the way.
2. **Different action.** Every Up next row offers Start. Every In progress row offers Done on
   behalf of someone else, which is the one action the row should make you think about before
   pressing. Mixing them means the primary button changes meaning row by row.
3. **Different size.** In progress is small by construction (a person holds a few things) and
   often zero; Up next is the unbounded tier. A zero-count tab costs nothing; a zero-count section
   inside Up next costs a sort rule and a divider.

The phone-width objection is answered by the strip scrolling horizontally, which `s-button-group`
inside an overflow container does. Five labels at the seeded counts fit at 600 px and scroll at
390 px, with Done the segment that scrolls off, which is the one a member reaches for least.

## 7. What the previous plan's decisions become

| Previous decision (`member-queue-scale-research.md` §9)                       | Under A                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 9.1 Instructions behind a tap                                                 | Unchanged.                                                                     |
| 9.2 Blocked capped at 25 in the stack                                         | Blocked is its own screen; cap becomes the page size. Reason line clamped (F). |
| 9.3 Team chips, filter in the subscription                                    | Chips become a select; still a subscription parameter.                         |
| 9.4 Done: heading + Show, 10 at a time                                        | Done is a tab; rows read only on that tab; 10 at a time.                       |
| 9.5 No search                                                                 | Unchanged.                                                                     |
| Plan §0 rule 10, keep invalidate-and-refetch                                  | Kept. C is a read optimisation, not a push change.                             |
| `QueueView` "one snapshot so Undo moves a card between halves under one push" | Moot: the two halves are never on screen together.                             |

## 8. Decisions (2026-09-19)

Reviewed with the user in Plannotator. Each question from the first draft and where it landed.

| #   | Question                     | Decision                                                                                                                                             |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | In progress: fold or own tab | **Own tab.** The user finds them naturally separate; §6.2 gives the reasoning that agrees.                                                           |
| 2   | Default tab                  | **Mine.** "Stuff I'm working on now seems natural to be first."                                                                                      |
| 3   | Team control                 | **`s-select`** with counts in the options. Recommendation given in §6; the user asked for one rather than a choice.                                  |
| 4   | Tab in the URL               | **Search param**, `validateSearch`, `replace: true`. "Especially idiomatic for TanStack Start."                                                      |
| 5   | Build C now or after A       | **Instrument now, build on evidence.** The user asked for the trade-offs; §6.1 has them and the recommendation changed from "with A" to "log first." |
| 6   | Is B off the table           | **Yes.** "The count strip is essential for the member to know what's going on."                                                                      |

Open: none. The implementation plan is `docs/member-queue-tier-views-plan.md`.

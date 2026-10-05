# Publish and subscribe from first principles

Written 2026-10-04. The publish and subscribe spec (the cycle, delivery and connection tables on
`Domain.Subscription` and `Domain.ConnectionRole`, the sites table on `ShopAgent.publish`, the
events table on `useSubscribedQuery`) was written after the implementation, to describe it. This
doc reads the five tables as if the implementation did not exist, asks what the mechanism has to
do, and names what the tables carry that the mechanism does not need. Where the spec is simpler,
the implementation it drives will be too. Questions for a decision are at the end, each with a
recommendation.

## The short version

- **The mechanism is a bell.** A screen shows rows in the object's SQLite; other actors change
  them; the screen must re-read without a reload. The least that does this: the object tells
  every connected tab "something changed" after every write, and a mounted screen re-reads.
  That is three things: a connection, a message, a refetch.
- **The spec carries five more.** A per-connection subscription with a scope, a two-part publish
  scope computed by every writer, an unsubscribe guarded by a per-mount id, a four-word `when`
  column, and a delivery matrix that branches on role. All five exist to narrow fan-out. None
  was measured; the fan-out research itself accepted the widest case and the memo has since made
  a repeated read nearly free.
- **Recommendation: cut the subscription and the scope.** Publish sends the invalidation to
  every connection; a mounted `useSubscribedQuery` refetches; the loader and socket reads become
  one method. The cycle table drops from seven rows to three, the delivery table disappears, the
  sites table loses two columns and a vocabulary, the client table loses two rows, and three
  Platform words retire (`subscription`, `subscriber`, `scope`), which also ends the collision
  with billing's "app subscription". The one fan-out defence that stays is the client's: the
  throttle and the hidden-tab deferral, which are what bound the object's load today.
- **Keep the connection table**, but as what it is: the gate and revocation, an authorization
  rule that happens to ride the same socket. Move the seat row to billing.
- **The client's remaining complexity is `useAgent`, not the spec.** The `identified`
  primitive, the ref getter, the private Suspense boundary, the seven-day token cache and the
  by-hand reconnect on 4401 are all workarounds for the SDK hook. The spec change does not depend
  on replacing it; question 6 asks whether to.

## What the mechanism must do

One per-shop Durable Object holds the rows. Four screens show them live: the orders index and
the order page for a merchant, the workflows list and the workflow page for a member. Writers
are webhooks, the open-orders sync, the merchant's workflow and team verbs, and the run and task
verbs of both populations. The requirement, in full:

1. After a write, every mounted live screen on the shop shows the new rows, soon, without a
   reload.
2. A screen never shows rows its connection is not allowed to read. (Members read by the
   teams on their connection; that is identity, not subscription.)
3. The object does not do work nobody will see, and does not do the same work twice for tabs
   that would get the same answer.
4. A tab whose socket dies comes back on its own.

Everything the spec says should trace to one of these. What follows takes each table in turn.

## The cycle table

Seven rows: identify, subscribe, re-subscribe, publish, invalidate, unsubscribe, reconnect.

**Subscribe, re-subscribe and unsubscribe exist only to narrow delivery.** A subscription today
is `{ subscriberId, orderId | null }` on the connection. Its one reader is `publishTo`, which
uses it to decide whether to send. If every connection received every publish, nothing would read
it. The "read and register in one RPC so a write between two calls cannot be missed" rule is a
rule about the registration: with no registration there is no window. The hook's message
listener is attached in the same commit that starts the first read, and a connection cannot
receive a frame before it exists, so the race the rule closes does not arise.

**Unsubscribe buys almost nothing even with subscriptions.** A connection holds one
subscription; the next live screen's subscribe replaces it. Unsubscribe matters only when a tab
leaves a live screen for a loader-only one (the workflows index, the team page) and stays there.
The cost of not unsubscribing in that case is one frame per publish to a tab whose hook is
unmounted, so no listener and no refetch. For that the spec carries `subscriberId` on every
subscription, the only `"any"` caller role, a one-task-deferred cleanup for Strict Mode, the
stale-unsubscribe guard, one cycle row and two client rows.

**Reconnect is not a step.** It is identify again: a fresh connection, and the tab's `identified`
flip re-runs the first read. The row restates two others.

What remains is three rows, and they are the mechanism:

| step       | side   | rule                                                                                      |
| ---------- | ------ | ----------------------------------------------------------------------------------------- |
| identify   | object | a connection carries the gate's identity; the tab's `identified` flip runs the first read |
| publish    | object | a write that succeeded sends the invalidation to every connection                         |
| invalidate | tab    | a mounted live screen re-reads, throttled, deferred while hidden                          |

## The delivery table

Seven rows, branching on role, on which screen the connection subscribed for, and on which half
of the scope the publish named. It is the rule the fan-out research had to draw as a flowchart to
discover, and the prior research called it the table worth having for that reason. From first
principles it is the cost of the scope, not a rule of the mechanism.

**What the scope saves.** The orders half spares merchant order pages that show a different
order; the teams half spares members on teams the write did not touch. The orders index, the one
expensive read, subscribes to everything and receives every publish regardless. Since the memo
(2026-10-04), every tab on one key shares one computation per publish, so the scope saves RPC
round trips returning memoized rows, not reads.

**What the scope costs.** Every writer must name two halves. The teams half has five vocabulary
values in the sites table (`all`, `the order's teams`, `before ∪ after`, `the order's teams,
read before the write`, `(none)`), because a write can take a team's last task away as readily as
give one, so the webhook path reads the order's teams on both sides of the write and unions
them. `publishToTeams`, `orderTeamIds`, `orderAndTeamIds`, `listOrderTeamIds`, `unionTeams`,
`PublishScope`, `PublishTeams` and `Subscription.orderId` exist for it. The failure mode is the
one the spec names itself: under-broad is "a list that silently stops updating", with no test
that can see it except one per writer per team case. "All is the honest default" is the spec
admitting the scope is a liability every writer must opt out of correctly.

**The marginal cost of no scope**, at the target shape (25 members, 2 merchants, task verbs
the volume), units × rate, with the Durable Objects price list
(`refs/cloudflare-docs/src/content/partials/durable-objects/durable-objects-pricing.mdx`):

| item                                                                | units                                   | rate                        | per day |
| ------------------------------------------------------------------- | --------------------------------------- | --------------------------- | ------- |
| extra refetch RPCs: 27 tabs × 30/min (the throttle's ceiling) × 8 h | 388,800 incoming messages = 19,440 reqs | $0.15 / million, 20:1 ratio | $0.003  |
| their wall time: 388,800 × ~2 ms memoized × 128 MB                  | ~100 GB-s                               | $12.50 / million GB-s       | $0.001  |

The ceiling is the throttle's, so it is the same ceiling the fan-out research computed with the
scope in place; the scope only lowers the average. Outgoing frames are free. The object's one
thread sees at most about 14 small RPCs a second at full saturation all day, which no shop
reaches. The number that matters is not here: the merchant's orders index already refetches on
every publish, scope or not.

**Recommendation: no scope.** `publish()` takes no arguments. Delivery is one sentence: every
connection receives every publish. If a staging reading ever shows the refetch count mattering,
the narrow form to add back is symmetric and role-blind, one rule not seven: a connection
declares the keys it is showing (`order:<gid>`, `team:<id>`, or everything), a publish names the
keys it touched or everything, and a connection receives when either side says everything or the
sets meet. That is one column on the sites table and one row of delivery. It is not needed to
start.

## The sites table

Sixteen rows, five columns: trigger, orders, teams, when, pinned by.

**The list of triggers is the valuable part.** It enumerates every writer, which is what a new
writer needs to know it must publish and what a reviewer needs to see one that does not. Keep
it.

**The `orders` and `teams` columns go with the scope.** With them goes the five-word teams
vocabulary and the "read before the write" distinction that Cancel workflow alone carries.

**`when` has four words for one question: does this site know whether its write changed
anything?**

- `changed` is the webhook path and Sync this order, where `fetchAndUpsertOrder` reports it.
  Keep: a redelivery is a real source of no-op fetches, and the signal is exact.
- `written` is a call that succeeded. Keep as the default.
- `swept` is a sweep that deleted rows. That is a write that changed something; it is `changed`.
- `always` is three sites publishing after a refusal. Each is a workaround for a screen that
  learns of a non-write by refetch: Sync open orders refused at the ceiling (the pressing tab
  refetches itself on the result; the other merchant tabs' sync state did not change), a new
  order refused at the ceiling (the JSDoc says "the publish is not the banner" and the banner is
  loader data, so the publish reaches a page whose read shows nothing new), and Delete team
  returning NotFound (which still nulls dangling pointers and reconciles, so it is a write that
  may have changed something, which is `written`). The first two publish nothing a live screen
  can show.

**Recommendation: two words.** `changed` where the write reports it, `written` everywhere else.
The three `always` rows become `written`; the ceiling webhook row, which writes `markOrdersLimited`
and nothing a live screen reads, stops publishing. If the ceiling banner should appear without a
loader run, that is a case for `usage` joining the orders index read, a separate decision
(question 4).

**The memo rule stays on `publish` but loses its caveat.** Today: "a write that publishes
nothing leaves the memo as it is, which is the same write leaving every open tab as it is; so
every write a list shows must publish." With two words, every successful write publishes except
an exact no-op, so the memo and the screens move together without the sentence.

**One pinning gap.** The on/off switch row and the Delete team row share a title; the `written`
versus `always` difference between them is pinned by nothing. With both `written`, the gap
closes.

## The connection table

Fourteen rows: eight gate answers on the Worker, two connect answers on the object, three
revocations, two close codes on the tab.

This is authorization: who is on the connection and when that stops being true. It belongs in a
table and it is well pinned. Two notes.

**It is not part of publish and subscribe.** It rides the same socket. Stating it on
`ConnectionRole` is right; counting it among "the publish and subscribe tables" makes the
mechanism look like five tables when it is two plus an auth rule.

**One row is billing.** "A member past the plan's included seats: forwards member; a seat over
the plan is billed, never refused" is a seats rule. The triggers table on `ShopUsage` is where
the seat mark lives; this row should point there rather than restate it.

**The by-hand reconnect on 4401 is SDK friction, not a rule.** The `agents` client treats every
4000 to 4999 close as terminal (`isTerminalCloseEvent` in
`refs/agents/packages/agents/src/client.ts`), so the host re-arms the socket itself a task
later. A close code the SDK does not treat as terminal would let partysocket reconnect on its
own, and the two close-code rows would collapse to one ("revoked: the tab reconnects through
the gate"). Codes 3000 to 3999 are reserved for libraries and frameworks by RFC 6455 §7.4.2 and
pass through browsers verbatim. The forbidden close (4403, malformed forward) is the one that
should stay terminal, and it is. Question 5.

## The client events table

Eight rows. Two go with unsubscribe. The other six are two mechanisms.

**The throttle is the object's rate limit, and the spec should say so.** The JSDoc explains it
as a fix for `cancelRefetch` discarding results on an unabortable RPC. That is true but it is
the smaller reason. With no scope, the throttle is the one thing between a busy shop and a tab
refetching once per publish; 30 refetches a minute per tab is the ceiling the cost table above
rests on. It belongs in the rule, not only in the constant's comment. A timerless alternative
(at most one fetch in flight and one queued) would coalesce a burst but refetch back to back
under sustained writes, which is worse for the object; the timer is right.

**The hidden-tab deferral is the second.** A merchant's orders index in a background tab would
otherwise pay the counts statement for every webhook. Right as it is.

**Identify-invalidates is the first read, and could be the key.** The hook invalidates on the
`identified` flip because `staleTime: Infinity` plus loader `initialData` means `useQuery` never
fetches on its own, and a reconnect does not refetch a fresh query on re-enable. Putting the
connection's generation in the query key would make every connection a new query that fetches
once, with `placeholderData: keepPreviousData` holding the rows meanwhile, and the identify
effect and its `cancelRefetch: false` reasoning would go. It changes what the cache holds (one
entry per connection, garbage-collected on the 30-minute rule) and is a smaller win than the
others; noted, not recommended now.

What remains:

| event                         | visible | the hook                                       |
| ----------------------------- | ------- | ---------------------------------------------- |
| identify                      | either  | runs the read; never deferred                  |
| invalidation, no window open  | yes     | refetches now and opens the window             |
| invalidation, window open     | yes     | marks pending; the window's end refetches once |
| invalidation                  | no      | marks the query stale and defers               |
| window ends, pending          | no      | defers                                         |
| tab becomes visible, deferred | yes     | refetches through the throttle                 |

## The loader and socket twins

Every live screen has two reads on the object: `listOrders` and `subscribeOrders`,
`getOrderDetail` and `subscribeOrder`, `memberListRuns` and `subscribeRuns`, `memberGetRun` and
`subscribeRun`. The socket twin is the loader twin plus `setSubscription`. The rule on
`ShopAgentClient` ("a socket `useQuery` outside this cycle is a mistake") exists to keep them
paired. With no subscription the pairs merge: one read per screen, callable over RPC from the
loader through `ShopAgentClient` and over the socket from the hook. Four `Subscribe<Feature>Input`
shapes retire with `subscriberId`. The rule becomes: a screen whose rows other actors change
reads through `useSubscribedQuery`, and its loader reads the same method.

## What the simplification removes

In the spec:

- Platform rows: `subscription`, `subscriber`, `scope`. The Shared words row for `subscription`
  and the "app subscription" qualification in billing become unnecessary (billing can keep the
  qualifier; it no longer has to).
- The cycle table: seven rows to three. The delivery table: gone. The sites table: five columns
  to three, `when` from four words to two. The client table: eight rows to six. The connection
  table: unchanged, re-homed as the auth rule; one row points to billing.
- `pnpm spec check`: one parser (`parseSubscriptionDelivery`) deleted, two simplified.

In the code, by name: `Subscription`, `SubscriptionState`, `SubscriberIdInput`,
`Subscribe{Orders,Order,Runs,Run}Input`, `setSubscription` (both the class's and the host
service's), `unsubscribe` and the `"any"` caller role, `PublishScope`, `PublishTeams`,
`unionTeams`, `publishToTeams`, `orderTeamIds`, `orderAndTeamIds`,
`RunRepository.listOrderTeamIds`, the before-and-after team reads in `syncOrderWebhook` and
`merchantAssignRunTaskTeam`, the `subscription` field on both `ConnectionState` shapes, the
four `subscribe<Feature>` methods on the class and in `ShopWorkAgent`, the unsubscribe timer
and `subscriberId` in the hook, and the role branch in `publishTo`. `publish` becomes: clear the
memo, send to every connection, log the count.

What stays: the gate, the connection identity and its tags (`member:<id>` for revocation), the
revocations, the memo and its clearing, `changed` on the two fetch paths, `publishIfOk`, the
throttle, the hidden deferral, the keepalive and watchdog, `initialData` from the loader.

## What it does not fix

- **The orders index's counts statement runs once per publish.** It did before. The index
  counts research has the plan.
- **The `useAgent` workarounds.** See question 6.
- **Liveness.** Keepalive, watchdog and `withSocketRecovery` are three mechanisms with one job
  (notice a half-open socket and reconnect). They could be stated as one heartbeat rule: send a
  ping every 240 s; if no frame arrives for 310 s, reconnect. The decision to keep liveness out
  of the tables stands; the prose could say it in one sentence.

## Decisions

All ten decided 2026-10-04 in Plannotator, each as recommended. Implemented 2026-10-04,
uncommitted (`docs/publish-subscribe-first-principles-plan.md`, "Recorded during
implementation"); decision 6 remains the follow-up.

1. The subscription and the scope are cut. `publish()` takes no arguments and sends the
   invalidation to every connection. If a staging reading ever shows the refetch count
   mattering, the key-set form (a connection's keys, a publish's keys, deliver when either side
   says everything or the sets meet) is the one to add.
2. Unsubscribe is cut with it. A connection keeps its last subscription until replaced or closed.
3. `when` has two words: `changed` where the write reports it, `written` otherwise. The three
   `always` sites become `written`; the ceiling webhook stops publishing.
4. The ceiling banner stays loader-only. Whether it should be live is a separate screen
   decision, not taken here.
5. Revoke closes with a 3xxx code so partysocket reconnects on its own; 4403 stays terminal.
   Confirm first that the `agents` client's `onClose` still fires for a 3xxx close, so the
   shells' router invalidation keeps running.
6. `useAgent` is not replaced in this change. **Follow-up, not to be lost:** after the spec
   simplification lands, revisit replacing `useAgent` with `usePartySocket` and a thin typed
   call, if the client JSDoc is still mostly SDK workarounds (the `identified` primitive, the
   ref getter, the private Suspense boundary, the seven-day `cacheTtl`).
7. The identify effect stays; the connection's generation does not go in the query key.
8. The connection table stays on `ConnectionRole` and is called the connection table, an
   authorization rule, in `pnpm spec check` and AGENTS.md; its seat row becomes a pointer at
   the `ShopUsage` triggers table.
9. No provision for publishing to one role and not the other. Role is on the connection if a
   future writer needs it.
10. Order of work: the spec rows first (the three tables as drafted above, `when` in two words),
    then the code deletion list in one change, then the client rows. Tests whose titles the
    removed rows carried go with them; the pinned-title check finds any title the plan misses.

Next: a plan (`docs/publish-subscribe-first-principles-plan.md`) in that order, with decision 6
recorded as a follow-up item at its end.

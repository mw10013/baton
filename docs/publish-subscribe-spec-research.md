# Publish and subscribe: the words and the spec

Written 2026-10-04. The question: a merchant's or member's screen subscribes over the per-shop
WebSocket, a write on the `ShopAgent` object publishes, the screen refetches. Does the vocabulary
have words for this, are they in the glossary, and is there a spec in the form the other key
behaviours have (a table on the symbol, one test title per row, `pnpm spec check` holding the
two together)? This doc inventories what exists, names the gaps, and recommends, with the
trade-offs and the questions that need a decision.

## The short version

- **The behaviour is well described and not specified.** The cycle is prose on
  `Domain.Subscription` (four numbered steps), the publish rule is a bold sentence on
  `ShopAgent.publish`, the client half is five bullets on `useSubscribedQuery`, and the delivery
  rule (who receives a publish) is a `publishTo` body that no JSDoc states as a table. Tests
  pin about half of it. Nothing parses any of it.
- **The vocabulary has no row for any of it.** Platform's nouns table has three rows: shop,
  ceiling, memo. The audit lists `connection` (16 exports), `socket` (12), `subscribe` (8),
  `publish`, `subscriber`, `invalidated`, `revoke`, `keepalive`, `stale`, `frame`, `reconnect`,
  `ping`, `pong`, `close`, `forbidden`, `hidden` as words no table names.
- **The prose uses six words for the one thing the object sends**: push, frame, invalidation,
  hint, nudge, notification (`ShopAgentNotifyError`), plus broadcast and fan-out. The request
  that started this doc said "broadcast notifications", which is the drift in one phrase.
- **One collision matters**: "subscription" is both a connection's registered interest
  (platform) and the shop's purchase of a plan (billing, "app subscription"). The close reason
  the object sends on a lapse is the string "subscription lapsed", in the platform file, meaning
  the billing one.
- **Recommendation, in order**: rows first (about ten, in Platform, plus one Shared words row),
  then three parsed tables (the cycle and delivery on `Domain.Subscription`, the publish sites on
  `ShopAgent.publish`, the client's events on `useSubscribedQuery`), each pinned by titles that
  mostly exist already. Liveness (keepalive, watchdog, recovery) gets words and stays prose.

## What exists today

### The cycle, both sides

| step        | side   | symbol                                                                    | what it does                                                                                                             |
| ----------- | ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| connect     | tab    | `ShopAgentSocketProvider`, `useAgent` (`src/lib/ShopAgentSocketHost.tsx`) | one socket per tab; `/app` sends an App Bridge token, `/shop/$shop` sends nothing (cookie)                               |
| gate        | Worker | `authorizeShopAgentRequest` (`src/worker.ts`)                             | resolves who this is; forwards `x-baton-*` headers, or answers 401, 402, 403, 404                                        |
| identify    | object | `ShopAgent.onConnect`, `getConnectionTags`                                | decodes the headers into `Domain.ConnectionState` on the connection, tags it; undecodable closes 4403                    |
| identify    | tab    | `identified` in `ShopAgentContext`                                        | flips true after the SDK's `cf_agent_identity` handshake; the hook invalidates once, which is the first subscribing read |
| subscribe   | both   | `subscribeOrders`, `subscribeOrder`, `subscribeRuns`, `subscribeRun`      | one RPC reads the screen's data and stores `Domain.Subscription` on the connection                                       |
| publish     | object | `ShopAgent.publish`, `publishTo`, `ShopAgentHost.publish`                 | clears the list memo, then sends `InvalidatedMessage` to every connection whose subscription is in scope                 |
| invalidate  | tab    | `useSubscribedQuery`                                                      | decodes the message, invalidates the one query, throttled 2 s, deferred while hidden                                     |
| refetch     | both   | the same `subscribe<Feature>` RPC                                         | re-reads and renews the subscription                                                                                     |
| unsubscribe | both   | `ShopAgent.unsubscribe`, the hook's cleanup                               | clears the connection's subscription only if the `subscriberId` still matches                                            |
| revoke      | object | `closeMemberConnections`, `revokeAllConnections`                          | closes with 4401 on a membership change, a team delete, or a plan lapse; the tab reconnects by hand through the gate     |
| keep alive  | both   | `SocketKeepalivePing`/`Pong`, `setWebSocketAutoResponse`                  | the edge answers the ping without waking the object                                                                      |
| watch       | tab    | `reconnectIfSocketStale`, `withSocketRecovery`                            | no received frame for 310 s, or an RPC timeout, reconnects                                                               |

### Where each rule is written

2026-10-04: implemented. The tables on `Subscription`, `ConnectionRole`, `ShopAgent.publish` and `useSubscribedQuery` now hold these rules; this table is the record of where they were before.

| rule                                                                                   | stated on                                        | form          | pinned by (test title)                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read and subscribe in one round trip                                                   | `Domain.Subscription`, each `subscribe<Feature>` | prose         | "reads the workflows list for the connection's teams and subscribes"                                                                                                                         |
| a publish follows a write that changed something; a no-op publishes nothing            | `ShopAgent.publish`                              | bold sentence | "a webhook that moves the order's updatedAt publishes even when no run moved", "a webhook on the same version whose reconcile creates a run publishes"                                       |
| a publish clears the list memo before the first frame                                  | `ShopAgent.publish`                              | bold sentence | "the class's publish clears the memo before its frames", and four more in `list-memo.test.ts`                                                                                                |
| a member receives a publish naming one of their teams                                  | `ShopAgent.publish`, `publishTo` body            | prose         | "pushes a completed task to the team, and not to a team with no work on that order"                                                                                                          |
| an order page receives a publish naming its order; the orders index receives every one | `ShopAgent.publish`, `publishTo` body            | prose         | "a task verb reaches the orders index and the order's page, and not another order's page"                                                                                                    |
| a connection with no subscription receives nothing                                     | `Domain.Subscription`                            | one sentence  | none                                                                                                                                                                                         |
| a stale unsubscribe cannot clear a newer mount's subscription                          | `Domain.Subscription`, `useSubscribedQuery`      | prose         | none                                                                                                                                                                                         |
| a reconnect is a fresh connection; identify re-subscribes                              | `Domain.Subscription`, `useSubscribedQuery`      | prose         | none                                                                                                                                                                                         |
| who is on the connection, from headers, never from a message                           | `Domain.ConnectionRole`                          | prose         | "stores a merchant identity and tags the connection", "stores a member identity, its teams, and the revocation tag", "accepts a member with no teams"                                        |
| the gate's answers                                                                     | `authorizeShopAgentRequest`                      | prose         | eight titles in `worker-agent-gate.test.ts` (forwards a merchant role; strips a forged role header; 404s a non-member; 403s an operator; 402s a lapsed shop; 401s neither token nor session) |
| undecodable identity closes 4403                                                       | `ShopAgent.onConnect`                            | prose         | "closes <label> with 4403" (parameterised)                                                                                                                                                   |
| a membership change, a team delete or a lapse closes with 4401                         | `closeMemberConnections`, `revokeAllConnections` | prose         | "revokes only the named member's connections", "revokes every connection on the shop for a lapse", "closes the sockets of everyone who was on the deleted team"                              |
| the tab reconnects on 4401 and not on 4403                                             | `ShopAgentSocketHost`                            | prose         | none in the browser project; e2e "removing a member closes the shop page on their live session" covers the visible half                                                                      |
| a hidden tab defers; a visible one refetches; a throttled frame defers when hidden     | `useSubscribedQuery`                             | bullets       | the three titles in `test/browser/use-subscribed-query.test.tsx`                                                                                                                             |
| 2 s throttle, leading and trailing                                                     | `INVALIDATION_THROTTLE_MS`                       | prose         | none by title                                                                                                                                                                                |
| keepalive answered at the edge, never waking the object                                | `SocketKeepalivePing`                            | prose         | none                                                                                                                                                                                         |
| which verbs publish, with what scope                                                   | the sync pipeline table on `ShopAgentHost`       | parsed table  | the order sources only; the workflow, team and run verbs are in no table                                                                                                                     |
| what a role may call                                                                   | `callableEffect`                                 | prose         | seven titles in `shop-agent-callables.test.ts`                                                                                                                                               |

Two things stand out. The publish sites were enumerated once, in `docs/publish-fan-out-research.md`
(2026-10-03), as a dated research table that is already behind the code in two cells. And the
client half, which is where the fan-out research had to correct two premises (the pages do not
revalidate the router; the push carries no scope), is the half with the least pinned.

### The end-to-end tests

`e2e/member-runs.member.spec.ts` has the two that matter: "a member starts and completes their
team's current task over the socket" and "a task one member marks done lands on another
member's workflows list without a reload". `e2e/member-area.member.spec.ts` has "removing a
member closes the shop page on their live session". No e2e drives the merchant side's
orders index through a publish.

## Vocabulary

### The words in use

From the audit (`pnpm vocab:audit`) and a grep of `src/lib`, `src/routes`, `src/components`
and `src/worker.ts`. Counts are lines mentioning the word, identifiers and prose together.

| word                                  | where                                                                                          | lines | status today                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------- |
| connection                            | `ConnectionRole`, `ConnectionState`, `CONNECTION_*`, `closeMemberConnections`, `publishTo`     | 288   | identifier word, no row                                           |
| socket                                | `ShopAgentSocket`, `ShopAgentSocketHost`, `SOCKET_*`, `withSocketRecovery`                     | 333   | identifier word, no row                                           |
| subscription                          | `Subscription`, `SubscriptionState`, `setSubscription`; billing's `SubscriptionPlan`           | 223   | two meanings, no row either side                                  |
| subscribe                             | `subscribe<Feature>`, `useSubscribedQuery`, `SubscribeOrdersInput`                             | 211   | identifier word, no row                                           |
| subscriber                            | `subscriberId`, `SubscriberIdInput`                                                            |       | identifier word, no row                                           |
| publish                               | `publish`, `publishTo`, `publishToTeams`, `PublishScope`, `PublishTeams`                       | 168   | identifier word, no row                                           |
| invalidated / invalidation            | `InvalidatedMessage`, `INVALIDATION_THROTTLE_MS`, the hook                                     | 37    | identifier word, no row                                           |
| identified / identify                 | `identified`, `onIdentifiedChange`; the SDK's `cf_agent_identity`                              | 117   | identifier word, no row                                           |
| touched                               | `publish(touched, teams)`                                                                      |       | parameter name for the order half of the scope                    |
| scope                                 | `PublishScope`, "in scope" in `publishTo`                                                      |       | type name, no row                                                 |
| revoke / revoked                      | `CONNECTION_CLOSE_REVOKED`, `revokeMemberConnections`, `revokeAllConnections`                  | 59    | identifier word, no row                                           |
| forbidden                             | `CONNECTION_CLOSE_FORBIDDEN`                                                                   |       | identifier word, no row                                           |
| keepalive, ping, pong                 | `SocketKeepalivePing`, `SOCKET_KEEPALIVE_MS`                                                   |       | identifier words, no row                                          |
| stale                                 | `STALE_SOCKET_MS`, `reconnectIfSocketStale`; TanStack's `staleTime`; "stale render"            | 130   | two meanings (a socket, a query); no row                          |
| frame                                 | `markSocketFrame`; prose "the first frame goes out"                                            | 80    | the wire word; also the prose word for the push                   |
| push                                  | prose only: "the one server push", "pushes to nobody", `test` titles "pushes a completed task" | 70    | prose synonym                                                     |
| hint                                  | prose: "a hint that the data is stale"                                                         | 4     | prose synonym                                                     |
| nudge                                 | prose: "the publish is a nudge, not the banner"                                                | 1     | prose synonym                                                     |
| notify / notification                 | `ShopAgentNotifyError`                                                                         | 9     | identifier, the only one; a synonym for publish                   |
| broadcast                             | prose, four lines                                                                              | 4     | prose synonym                                                     |
| fan-out                               | prose, `getConnectionTags` JSDoc, the fan-out research                                         | 7     | prose; means the set a publish reaches                            |
| tab                                   | prose: "one socket per tab", "a merchant's background tab"; retired from screen copy           | 44    | the ShopWork vocabulary says "tab" means a browser tab            |
| page (hidden)                         | `pageIsHidden`, "a hidden page defers"                                                         |       | the Page Visibility API's word; collides with the Screens' "page" |
| memo                                  | Platform row exists                                                                            |       | the one row                                                       |
| zombie, dead-man's switch, quarantine | prose in `ShopAgentContext.tsx`, `ShopAgentSocketHost.tsx`                                     |       | metaphors                                                         |

### What passes the vocabulary's own test

The map says a word gets a row when it names a concept the domain has, has one meaning in its
context, and is plain. Applying that:

**Rows.** connection, socket, subscription, subscriber, publish, invalidation, scope, identify,
revoke. Each names a concept more than one symbol uses, and each already has one meaning in the
code. These go in Platform's nouns table: Platform is "the technical words every context uses;
no model of the business", and the cycle carries no business meaning on its own. The scope's
two halves (orders, teams) do name business things, and the row's meaning cell can say so without
the row leaving Platform, the same way the ceiling row names `maxOrdersPerCycle`.

**JSDoc terms, no row.** keepalive, ping, pong, watchdog, stale socket, 4401, 4403. Each lives
on one symbol or one pair, which the runbook says stays a JSDoc term.

**Shared word.** "subscription". Billing's row already says "app subscription" and the billing
code mostly qualifies (`AppSubscription`, "app subscription lapsed"), but `SubscriptionPlan.ts`
and the close reason "subscription lapsed" do not. The Shared words table in the map gets a row:
`subscription` in platform is a connection's registered interest (`Subscription`), in billing
always "app subscription" (`AppSubscription`). The close reason string changes to "app
subscription lapsed".

**Retire from prose.** push, hint, nudge, notification, broadcast. One noun for what the object
sends: **invalidation**. The message type is `invalidated`, the hook's constant is
`INVALIDATION_THROTTLE_MS`, and TanStack's verb is `invalidateQueries`, so the word is already
the one the code uses where it has to be exact. "Frame" stays, as the wire's word: a keepalive
pong is a frame and not an invalidation, and the watchdog counts frames. `ShopAgentNotifyError`
becomes `ShopAgentPublishError`. The two test titles that say "pushes" become "publishes to".
`rules-lint` checks screen copy only; a JSDoc grep in the change is enough, and a lint over
comments is a separate decision (question 10).

**Retire the metaphors.** "zombie" is the stale socket (`reconnectIfSocketStale` is already
"the one definition of stale"); "dead-man's switch" is the watchdog; "quarantine" is the Suspense
boundary. The feedback on plain words applies to JSDoc as much as copy.

**"fan-out".** Keep as a JSDoc term meaning the set of connections one publish reaches; the
instrumentation line counts it. It is not a synonym for publish, so it does not retire.

**Two words for the two ends.** "connection" is the object's end (`Connection` from the SDK,
with `ConnectionState` on it); "socket" is the tab's end (`ShopAgentSocket` from `useAgent`).
The split is real: a tab holds one socket for its life, and that socket is a series of
connections, each a fresh identity with no subscription. Keeping both words, with the rows
saying which end, is clearer than one. The risk is the client JSDoc saying "connection" for the
tab's end, which it does in places ("a reconnect is a fresh connection" is correct; "Connection
closed" is the SDK's error text).

**"tab" versus "page".** The screens' spec word is "page" ("the order page", "the workflow
page"), and ShopWork's vocabulary already says "tab" means a browser tab, retired from copy
because the Polaris web components have no tab control. The hook says "a hidden page" and
exports `pageIsHidden`, following the browser's Page Visibility API. Pick one word for the
browser tab in JSDoc and identifiers: "tab" (so `tabIsHidden`, "a hidden tab defers"). "page"
stays a screen word. The retired-copy check is unaffected.

**"stale".** Two meanings: TanStack's query staleness (`staleTime: Infinity`, "stale render")
and the socket's (`STALE_SOCKET_MS`). Both are vendor-adjacent: one is TanStack's term, the
other the client JSDoc's. They travel with their noun already ("stale socket", "stale query"),
which is the Shared words rule. A row is not needed; a sentence on `reconnectIfSocketStale`
saying so is.

### The rows, drafted

For Platform's nouns table. "(none)" screen throughout: the merchant and member see a
"Connecting" state and nothing else of this.

| word         | meaning                                                                                                                                     | symbol                                             | screen             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------ |
| socket       | a tab's one WebSocket to its shop's object, for the life of the tab; a series of connections                                                | `ShopAgentSocket`, `ShopAgentSocketProvider`       | (none): Connecting |
| connection   | the object's end of one socket, from identify to close; carries who is on it and its subscription                                           | `ConnectionState`, `ConnectionRole`                | (none)             |
| identify     | the object learns who is on a connection from the gate's headers, once, at connect; the tab learns the handshake landed                     | `ShopAgent.onConnect`, `identified`                | (none): Connecting |
| subscription | a connection's registered interest in one screen's data: the orders index, one order, or the member's teams; one or none per connection     | `Subscription`, `subscribe<Feature>`               | (none)             |
| subscriber   | one mounted subscribed screen, by the id that guards its unsubscribe                                                                        | `SubscriberIdInput`, `useSubscribedQuery`          | (none)             |
| publish      | a write telling every connection whose subscription it touched to refetch; follows a write that changed something                           | `ShopAgent.publish`, `ShopAgentHost.publish`       | (none)             |
| scope        | what a publish names: the orders it changed or all, and the teams it could have changed or all                                              | `PublishScope`, `PublishTeams`                     | (none)             |
| invalidation | the one message the object sends: this screen's data is stale; never the data                                                               | `InvalidatedMessage`, `INVALIDATION_THROTTLE_MS`   | (none)             |
| revoke       | the object closing a connection whose identity no longer holds (membership, team, app subscription), so the tab reconnects through the gate | `CONNECTION_CLOSE_REVOKED`, `revokeAllConnections` | (none): Connecting |

Plus the Shared words row for subscription, and the existing memo row stays.

## Specs

### What a spec is here

The pattern the repo has settled on: a table in the JSDoc on the symbol that is the concept,
one row per rule, a `pinned by` column holding a test title, `pnpm spec check` parsing the table
and refusing a title no test carries. The triggers table on `ShopUsage` is the closest shape to
what publish and subscribe needs: triggers spread across the codebase, each row saying what the
trigger does to a few named things, each pinned.

### Three tables, and one that stays prose

**1. The cycle, on `Domain.Subscription`.** One row per step, both sides, replacing the four
numbered paragraphs. Columns: step, side, symbol, rule, pinned by. The rows are the cycle table
above with a rule and a title each. Seven rows; four titles exist, three are new (no
subscription receives nothing; a stale unsubscribe cannot clear a newer mount's subscription; a
reconnect is a fresh connection and identify re-subscribes). All three are object-side or
hand-spoken-socket tests, which `test/integration/agent-socket.ts` already supports.

**2. Delivery, beside it on `Domain.Subscription`.** The `publishTo` decision as a table, because
it is the rule the fan-out research had to draw as a flowchart to find out. Columns: role,
subscription, scope, receives, pinned by.

| role     | subscription       | scope                             | receives | pinned by                                                                                         |
| -------- | ------------------ | --------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| either   | none               | any                               | no       | new: a connection with no subscription receives nothing                                           |
| merchant | the orders index   | any                               | yes      | existing: a task verb reaches the orders index and the order's page, and not another order's page |
| merchant | an order page      | all, or names its order           | yes      | same title                                                                                        |
| merchant | an order page      | names other orders                | no       | same title                                                                                        |
| member   | the workflows list | all teams, or names one of theirs | yes      | existing: pushes a completed task to the team, and not to a team with no work on that order       |
| member   | the workflows list | names only other teams            | no       | same title                                                                                        |
| member   | the workflow page  | as the list                       | yes      | new: the member's workflow page receives what the list receives                                   |

Six rows, two new titles.

**3. The publish sites, on `ShopAgent.publish`.** One row per site: trigger, touched, teams,
when, pinned by. This is the fan-out research's "Every publish site" tables, moved onto the
symbol and pinned so they stop going stale. About eighteen rows if the thirteen run verbs
collapse to three (merchant verbs through `publishToTeams`, member verbs through it, Cancel
workflow and Attach workflow as their own rows because their scopes differ). The `when` column
is the publish rule's `changed` or "always", and it is where the two open items from the
fan-out research (Apply and Edit tag publish on an off workflow) become visible cells instead of
sentences.

Alternatives weighed:

- _A `publishes` column on the run and task action matrices._ Keeps one row per verb, but the
  matrix parser has fixed columns and a cell per state, and a publish scope is per verb not per
  state. Thirteen cells saying the same thing is worse than three rows.
- _Extending the sync pipeline table on `ShopAgentHost`._ It already has a `publish` column, but
  its rows are "one per source of orders" and it is deliberately unpinned ("the rows are
  wiring"). Putting workflow and team verbs there changes what the table is. Better: the pipeline
  table keeps its publish column and links the sites table for the rest.
- _Leaving it in the research doc._ Already stale twice in a day.

**4. The client's events, on `useSubscribedQuery`.** One row per event the hook handles:
event, tab visible, what the hook does, pinned by.

| event                              | visible | the hook                                               | pinned by                                                               |
| ---------------------------------- | ------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| identify                           | either  | invalidates, joining a fetch in flight; never deferred | new                                                                     |
| invalidation, no window open       | yes     | refetches now and opens the 2 s window                 | existing: a visible page refetches on a frame                           |
| invalidation, window open          | yes     | marks pending; the window's end refetches once         | new: a burst inside the window costs two refetches                      |
| invalidation                       | no      | marks stale, defers                                    | existing: a hidden page defers its refetch to the next visibilitychange |
| window ends with a pending refetch | no      | defers                                                 | existing: a throttled frame whose window elapses while hidden defers    |
| tab becomes visible, deferred      | yes     | refetches through the throttle                         | the same title                                                          |
| unmount                            | either  | unsubscribes a task later, if still identified         | new                                                                     |
| setup again before that task       | either  | cancels the unsubscribe (Strict Mode)                  | new                                                                     |

Eight rows, three existing titles, four new, all in the browser project with fake timers, which
the existing three already use.

**Connection and revocation.** The connect and revoke rows (identity from headers, 4403, 4401
on the three causes, the tab's reconnect on 4401 and not 4403) are already eleven titles across
`shop-agent-connections.test.ts` and `worker-agent-gate.test.ts`. A table on
`Domain.ConnectionRole` costs little and makes the gate's four answers and the object's two
close codes one list. Worth doing in the same change, after the three above; the one new title
is the tab's reconnect on 4401, in the browser project.

**Liveness stays prose.** Keepalive, watchdog and `withSocketRecovery` are timers and
thresholds against an undocumented edge timeout. The JSDoc on `ShopAgentContext.tsx` is already
the reasoning, and a table would have rows nobody can pin without faking the edge. The one rule
worth a test is that the keepalive never wakes the object, and `setWebSocketAutoResponse` is
the runtime's promise, not ours. Words, not a table.

### Where `pnpm spec check` learns the tables

`scripts/spec.ts` reads the four context files, `Host.ts`, the two schema files and
`Screen.ts`. Tables 1 and 2 are in `Platform.ts`, already a source. Table 3 is on the class in
`ShopAgent.ts` and table 4 on a hook in `useSubscribedQuery.ts`; both are new sources, like
`Host.ts` was. Each table is one parser (about thirty lines in `scripts/lib/ActionTable.ts`,
following `parseTriggerTable`) and one `checkPinned` call. `readTestSources` globs
`test/**/*.test.ts`, so the browser project's `.test.tsx` files are not read today; table 4's
titles need the glob widened.

The alternative is to keep every table on a domain symbol so no new source is needed: table 3
would sit on `Domain.Subscription` too, and table 4 on `Domain.InvalidatedMessage`. That puts the
client's throttle in the domain file, which is the wrong file for a React hook's timers, and puts
the publish sites two files away from the publish they describe. The new-source cost is small.

### Trade-offs, overall

- **Cost.** Four parsers, about nine new test titles, one rename, one vocabulary change touching
  JSDoc across a dozen files. Two to three focused changes.
- **What it buys.** The next fan-out question is answered from the symbol, not from a research
  doc or a flowchart of `publishTo`. A scope change starts at a cell. The client's throttle and
  deferral, which nobody can see from the object, get the same standing as the object's rules.
- **What it does not buy.** Performance. The fan-out research's open item (the orders index's
  counts statement on every publish) is a measurement question, not a spec question.
- **Risk.** Over-tabling. Four tables for one mechanism is more than any other behaviour has.
  The answer is that the mechanism has two sides in two runtimes and the tables are split along
  that seam. If one has to go, drop the connection table: its titles exist and the gate is
  already a list in `worker.ts`.

## Recommendations, in order

1. **Rows.** Nine rows in Platform's nouns table as drafted, one Shared words row for
   subscription, the close reason string to "app subscription lapsed".
2. **Prose.** One noun, invalidation; retire push, hint, nudge, notification, broadcast from
   JSDoc and test titles; retire zombie, dead-man's switch, quarantine; `ShopAgentNotifyError`
   to `ShopAgentPublishError`; `pageIsHidden` to `tabIsHidden` and "tab" for the browser tab in
   every JSDoc.
3. **Tables 1 and 2** on `Domain.Subscription`, three new object-side titles, parsed and pinned.
4. **Table 3** on `ShopAgent.publish`, `ShopAgent.ts` as a spec source, the fan-out research's
   sites pinned one title each; the pipeline table's publish column links it.
5. **Table 4** on `useSubscribedQuery`, four new browser titles, `test/browser/` in the test
   sources.
6. **The connection table** on `Domain.ConnectionRole`, one new browser title for the reconnect
   on 4401.
7. **Liveness**: words only.

## Decisions

All twelve decided 2026-10-04 in Plannotator, each as recommended.

1. The words go in Platform's nouns table; no new context.
2. "subscription" keeps the bare word for a connection's interest; billing says "app
   subscription" everywhere, including the close reason; a Shared words row records it.
3. One noun for what the object sends: invalidation. Push, hint, nudge, notification and
   broadcast retire from prose and test titles; frame stays the wire word.
4. "tab" for the browser tab in JSDoc and identifiers (`tabIsHidden`); "page" stays a screen word.
5. Both "connection" (the object's end) and "socket" (the tab's end), one row each.
6. The publish sites are a triggers-style table on `ShopAgent.publish`, one row per site, pinned.
7. `ShopAgent.ts` and `useSubscribedQuery.ts` become spec sources; the test glob widens to the
   browser project.
8. The client table is pinned in the browser project with fake timers.
9. Liveness gets no table: words in the rows, prose on the symbols.
10. No JSDoc lint for the retired prose words; a grep in the change.
11. `PublishScope` and `PublishTeams` stay in `Host.ts`.
12. `ShopAgentNotifyError` becomes `ShopAgentPublishError`.

Next: a plan (`docs/publish-subscribe-spec-plan.md`) in the order of the recommendations above.

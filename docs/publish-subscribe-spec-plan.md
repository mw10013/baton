# Publish and subscribe spec: implementation plan

This plan carries out the decisions in `docs/publish-subscribe-spec-research.md` (2026-10-04,
one Plannotator pass, all twelve as recommended). Read that doc first: "The cycle, both sides"
and "Where each rule is written" are the inventory, "The rows, drafted" is the vocabulary this
plan adds, "Three tables, and one that stays prose" are the tables, and Decisions holds the
twelve calls. Nothing here is open; where this plan had to choose something the research did
not, the choice is under "Decided at planning time".

Five phases. Phase 1 is the vocabulary and the prose, and goes first because every table after
it is written in those words. Phase 2 is the two tables on `Domain.Subscription`. Phase 3 is the
publish-sites table on `ShopAgent.publish`. Phase 4 is the client's events table on
`useSubscribedQuery`. Phase 5 is the connection table on `Domain.ConnectionRole`. Each phase
starts at the spec text, then the parser, then the tests, and ends with a "done when". Run the
checks between phases.

## Before you start

- Read `AGENTS.md`, `docs/vocabulary-runbook.md`, and the JSDoc on: the map and the Shared
  words table (`src/lib/Domain.ts`); the nouns table, `Subscription`, `ConnectionRole`,
  `CONNECTION_CLOSE_REVOKED`, `InvalidatedMessage`, `SocketKeepalivePing`
  (`src/lib/domain/Platform.ts`); `publish`, `publishTo`, `onConnect`, `getConnectionTags`,
  `unsubscribe`, `closeMemberConnections`, `revokeAllConnections`, `syncOrderWebhook`,
  `syncOrder`, `syncOpenOrders` (`src/lib/ShopAgent.ts`); `ShopAgentHost` and its sync
  pipeline table (`src/lib/agent/Host.ts`); `subscribeOrders`, `subscribeOrder`,
  `subscribeRuns`, `subscribeRun`, `publishToTeams`, `reconcileAllNow`, `reconcileAllIfOn`
  (`src/lib/agent/ShopWork.ts`); the module JSDoc on `useSubscribedQuery`
  (`src/lib/useSubscribedQuery.ts`); `ShopAgentContext.tsx` and `ShopAgentSocketHost.tsx`
  whole; `authorizeShopAgentRequest` (`src/worker.ts`). On the checker side: `nthTable`,
  `jsdocBefore`, `parseTriggerTable`, `parseSyncPipeline`, `checkPinned`
  (`scripts/lib/spec.ts`), the `check` and `print` commands (`scripts/spec.ts`), and the
  "triggers table parser" block in `test/integration/spec.test.ts`. On the test side:
  `test/integration/agent-socket.ts` (the hand-spoken socket, `openMerchantSocket`,
  `openMemberSocket`, `isInvalidated`), `test/integration/member-runs-socket.test.ts`,
  `test/integration/shop-agent-connections.test.ts` and
  `test/browser/use-subscribed-query.test.tsx` (the stand-in socket and `setVisibility`).
- The rules that matter most here:
  - A rule is stated once, on the symbol that is the concept or enforces it, and other sites
    link it. The tables this plan adds are the rules; the prose around them shrinks to what a
    table cannot say. A test's title is the rule in plain words, and `pnpm spec check` refuses
    a `pinned by` no test carries.
  - A JSDoc never cites a file under `docs/`. Carry the reasoning inline.
  - Identifiers, JSDoc, test titles and log messages speak the vocabulary. After phase 1 the
    words are: socket (the tab's end), connection (the object's end), identify, subscription,
    subscriber, publish, scope, invalidation, revoke, and tab for a browser tab. Never push,
    hint, nudge, notification, broadcast for the invalidation; never zombie, dead-man's switch,
    quarantine. "Frame" is the wire word only. Screens are named by the Screens table: the
    orders index, the order page, the workflows list, the member's workflow page.
  - `docs/publish-fan-out-plan.md` told its implementer "A browser tab is 'a page' or 'an open
    page'; never 'tab'". Decision 4 of this research reverses that. This plan wins; that plan
    is dated and is not rewritten.
  - Status, flag and role predicates are `Domain` functions. Nothing here adds one.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- Run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check` and `scripts/rules-lint.ts`)
  and `pnpm test` after each phase. Phase 4 also runs `pnpm test:browser`. `pnpm fmt`
  repo-wide at the end of each phase and keep every file it touches.

## The decisions, by phase

| decision                                                                                | phase |
| --------------------------------------------------------------------------------------- | ----- |
| 1. The words go in Platform's nouns table                                               | 1     |
| 2. "subscription" stays bare; billing says "app subscription"; shared row               | 1     |
| 3. One noun, invalidation; push and the rest retire from prose                          | 1     |
| 4. "tab" for the browser tab; `pageIsHidden` to `tabIsHidden`                           | 1     |
| 5. Both connection and socket, one row each                                             | 1     |
| 12. `ShopAgentNotifyError` to `ShopAgentPublishError`                                   | 1     |
| 10. No JSDoc lint; a grep in the change                                                 | 1     |
| 11. `PublishScope` and `PublishTeams` stay in `Host.ts`                                 | 1     |
| 6. The publish sites are a triggers-style table on `ShopAgent.publish`                  | 3     |
| 7. `ShopAgent.ts` and `useSubscribedQuery.ts` become spec sources; the test glob widens | 3, 4  |
| 8. The client table is pinned in the browser project                                    | 4     |
| 9. Liveness gets no table                                                               | none  |

## Decided at planning time

1. **Two tables on one symbol use `nthTable`.** `nthTable(source, name, columns, nth)` takes
   the nth table of the JSDoc before `export const <name> =`; the reconcile tables on
   `reconcileItem` already stack four that way. The cycle table is table 0 on `Subscription`
   and the delivery table is table 1. The JSDoc is rewritten so no other table precedes them.
2. **A table on a class method needs a new anchor.** `jsdocBefore` finds only
   `export const <name> =` or `export class <name> `. `ShopAgent.publish` is `private publish(`.
   Rather than move the table off the symbol that enforces the rule (decision 6), `jsdocBefore`
   gains a third form: a caller may pass the declaration text to anchor on, and
   `parsePublishSites` passes `"\n  private publish("`. The error message names the form it
   looked for. The alternative, exporting a marker constant beside the method, would put the
   spec on a symbol nothing reads.
3. **The publish-sites table has five columns**: `trigger`, `orders`, `teams`, `when`,
   `pinned by`. `orders` and `teams` are the two halves of the scope and each cell is `all`,
   `the order`, `before ∪ after`, `the order's teams`, `(none)`, or a short phrase; the parser
   holds `orders` and `teams` to a closed word list the way `parseTriggerTable` holds the order
   count, and the JSDoc above the table names the list. `when` is `changed`, `always`, or
   `swept`. The research's word "touched" stays as the parameter name on `publish` (renaming
   it is churn across every caller) and the table's column says `orders`, the vocabulary word;
   the JSDoc says the two are the same thing.
4. **The run and task verbs collapse to four rows**: the merchant's six through
   `publishToTeams`; the member's seven through it; Cancel workflow (teams read before the
   write); Attach workflow (the order, all teams). The matrices stay the spec for what each verb
   does; this table is the spec for what each verb publishes.
5. **`pinned by` on a sites row may be an existing title that proves the scope by scenario.**
   The sync rows cite the webhook and stream suites' titles. Rows with no title today get one
   each, in `member-runs-socket.test.ts` for the verbs and in `shop-agent-workflows.test.ts`
   for the configuration verbs, asserting an invalidation reached a merchant socket and a member
   socket or did not.
6. **The client table's `pinned by` is read from `.test.tsx`.** `readTestSources` in
   `scripts/spec.ts` globs `test/**/*.test.ts`; it becomes `test/**/*.test.{ts,tsx}`. Nothing
   else in the checker cares which project a title is in.
7. **The browser tests for the hook's timing use real timers and short waits**, as the three
   existing ones do (`quiet()` is a 100 ms wait; the throttle is 2 s). Fake timers under
   `vitest-browser-react` are not in use anywhere in the repo, and introducing them for four
   tests is its own risk. The tests take about ten seconds in total; acceptable.
8. **The connection table lives on `ConnectionRole`**, which is `export const` in Platform,
   not on `ConnectionState`, which is in ShopWork because it carries `teamIds`. The gate's four
   answers are rows of the same table with `Worker` in the `side` column, so the whole
   connect-to-close story is one list. `worker.ts` is not a spec source and does not need to be:
   the rows are pinned by the gate suite's titles, which `checkPinned` reads from the test
   sources already.
9. **"push" retires only in the invalidation sense.** Billing's "cycle push" (`SubscriptionPlan`
   pushes the billing cycle into the object; the triggers table's "cycle pushed" rows) is a
   different sense and stays. The grep in phase 1 is read, not applied blind.
10. **The three retired test titles are renamed, not duplicated.** "pushes a completed task to
    the team, and not to a team with no work on that order" becomes "publishes a completed task
    to the team, and not to a team with no work on that order", and the two beside it the same
    way; the new table rows cite the new titles.
11. **Research-doc inventories are not rewritten.** `docs/publish-fan-out-research.md` keeps
    its "Every publish site" tables as the dated record; the sites table on `publish` is the
    live one. `docs/publish-subscribe-spec-research.md`'s "Where each rule is written" table
    gets a one-line note at the top saying the tables now hold the rules.

## Phase 1: the words

### 1.1 The vocabulary rows

In `src/lib/domain/Platform.ts`, the nouns table gains the nine rows drafted in the research
("The rows, drafted"), in this order after `memo`: socket, connection, identify, subscription,
subscriber, publish, scope, invalidation, revoke. Each row's `symbol` cell names exports that
exist (`pnpm spec check` verifies): `ShopAgentSocket` and `ShopAgentSocketProvider` for socket;
`ConnectionState` and `ConnectionRole` for connection; `ShopAgent.onConnect` and `identified`
for identify (a method and a context field, written as the memo row writes its Cache values);
`Subscription` and `subscribe<Feature>` for subscription; `SubscriberIdInput` and
`useSubscribedQuery` for subscriber; `ShopAgent.publish` and `ShopAgentHost.publish` for
publish; `PublishScope` and `PublishTeams` for scope (in `Host.ts`, decision 11, named as
"`PublishScope`, `PublishTeams` in ShopAgentHost"); `InvalidatedMessage` and
`INVALIDATION_THROTTLE_MS` for invalidation; `CONNECTION_CLOSE_REVOKED` and
`revokeAllConnections` for revoke. Screen cell: "(none): Connecting" for socket, identify and
revoke; "(none)" for the rest.

In `src/lib/Domain.ts`, the Shared words table gains:

| word         | contexts          | noun form                                                                                                                        |
| ------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| subscription | platform, billing | bare in platform: a connection's registered interest (`Subscription`); "app subscription" in billing, always (`AppSubscription`) |

The checker holds a shared word to contexts the map names and to the noun forms' symbols
existing; both do.

### 1.2 The prose

One noun. Rewrite every JSDoc line the research's grep found (the list is in the research's
"The words in use" and the counts there; rerun the grep below to get the lines) so that:

- what the object sends is "an invalidation" or "the invalidation"; "a publish" is the act;
  "receives" replaces "is pushed to" and "hears";
- a browser tab is "a tab"; "a hidden tab", "a background tab"; `pageIsHidden` becomes
  `tabIsHidden` (`src/lib/useSubscribedQuery.ts`, its import in the browser test, and the
  JSDoc on it);
- the stale socket is "a stale socket" wherever `zombie` stood; the watchdog is "the watchdog"
  where "dead-man's switch" stood; the Suspense boundary is "its own Suspense boundary" where
  "quarantine" stood (`ShopAgentContext.tsx`, `ShopAgentSocketHost.tsx`, `app.tsx`,
  `useMemberRunActions.ts`);
- `ShopAgentNotifyError` becomes `ShopAgentPublishError` (`src/lib/ShopAgent.ts`, four
  construction sites; its JSDoc says it wraps the publish and revoke paths);
- the close reason on `revokeAllConnections` becomes `"app subscription lapsed"`, and the JSDoc
  on `CONNECTION_CLOSE_REVOKED` says "the shop's app subscription lapsed";
- the three test titles in `member-runs-socket.test.ts` that say "pushes" say "publishes to"
  (planning decision 10).

The grep, run before and after:

```bash
grep -rn -i -E '\bpush(es|ed|ing)?\b|\bhint\b|\bnudge\b|\bbroadcast|\bnotif|zombie|dead-man|quarantin|hidden page|background page|visible page' \
  src test e2e --include='*.ts' --include='*.tsx' | grep -v -E 'pushState|\.push\(|cycle push|pushes the (billing )?cycle|pushes the cycle'
```

After: no line left means the invalidation, a tab, or a stale socket. Lines that are layout
prose ("pushes the submit onto the next line"), billing's cycle push, or `Array.prototype.push`
stay.

The paragraph on `Domain.Subscription` that is the four-step cycle is rewritten in the new
words now and becomes the cycle table in phase 2; do not spend effort polishing its prose.

### 1.3 Done when

- `pnpm vocab:audit` no longer lists socket, connection, subscription, subscribe, subscriber,
  publish, invalidated, invalidation, identified, revoke, scope. (keepalive, ping, pong, stale,
  frame, reconnect, forbidden, hidden stay listed: JSDoc terms by decision 9.)
- The grep above is clean.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green. No behaviour changed.

## Phase 2: the cycle and delivery tables on `Domain.Subscription`

### 2.1 The spec text

The JSDoc on `Subscription` in `src/lib/domain/Platform.ts` opens with one paragraph (what a
subscription is: a connection's registered interest in one screen's data, one or none per
connection, stored on the connection beside the identity so a subscribe cannot erase the
identity that authorizes it), then two tables.

**The cycle**, table 0, columns `step`, `side`, `symbol`, `rule`, `pinned by`:

| step         | side   | symbol                                      | rule                                                                                                                             | pinned by                                                             |
| ------------ | ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| identify     | object | `ShopAgent.onConnect`                       | a fresh connection carries the gate's identity and no subscription                                                               | stores a merchant identity and tags the connection                    |
| subscribe    | both   | `subscribe<Feature>`                        | one RPC reads the screen's data and stores the subscription, so a write between two calls cannot be missed                       | reads the workflows list for the connection's teams and subscribes    |
| re-subscribe | both   | `subscribe<Feature>`                        | a second subscribe on the connection replaces the first                                                                          | re-subscribing with a different query changes what the read returns   |
| publish      | object | `ShopAgent.publish`                         | a write that changed something sends the invalidation to every connection whose subscription is in scope; see the delivery table | a webhook on the same version whose reconcile creates a run publishes |
| invalidate   | tab    | `useSubscribedQuery`                        | the invalidation re-runs the subscribing read, throttled; the client table is on the hook                                        | a visible tab refetches on an invalidation                            |
| unsubscribe  | both   | `ShopAgent.unsubscribe`                     | clears the connection's subscription only when the subscriber id matches; a stale unsubscribe cannot clear a newer mount's       | a stale unsubscribe cannot clear a newer mount's subscription         |
| reconnect    | both   | `ShopAgentSocketHost`, `useSubscribedQuery` | a reconnect is a fresh connection with no subscription; the tab's identify subscribes again                                      | a reconnect is a fresh connection with no subscription                |

**Delivery**, table 1, columns `role`, `subscription`, `scope`, `receives`, `pinned by`, the
six rows in the research's "Delivery" table, with "the member's workflow page receives what the
list receives" as its own row. `receives` is `yes` or `no`.

After the tables: the scope paragraph (the orders half and the teams half, `"all"` as the
honest default when a writer cannot name them), and one sentence that only order and run state
is ever published and configuration is loader data, linking the sites table on
`ShopAgent.publish`.

The JSDoc on `ShopAgent.publish` keeps the two bold rules (changed-or-nothing; the memo clears
first) and the scope paragraphs shrink to a link to the delivery table.

### 2.2 The parser

In `scripts/lib/spec.ts`: `parseSubscriptionCycle` (table 0, five columns, `step` and `rule`
non-empty, `side` one of `object`, `tab`, `both`, `Worker`) and `parseSubscriptionDelivery`
(table 1, five columns, `role` one of `either`, `merchant`, `member`, `receives` one of `yes`,
`no`). Both return rows with `line` and `pinnedBy` so `checkPinned(rows, testSources,
"Subscription")` works unchanged. `scripts/spec.ts` `check` adds both with `checkPinned`;
`print` renders both after the sync pipeline rows. Update the two command descriptions and the
header comment at the top of `scripts/spec.ts`.

### 2.3 The tests

New titles, all in `test/integration/member-runs-socket.test.ts` or
`shop-agent-connections.test.ts` over the hand-spoken socket:

- "a connection with no subscription receives nothing": open a member socket on a team with
  work, do not subscribe, have a teammate mark a task done, assert no invalidation within 200 ms
  (the `rejects.toThrow("no matching frame")` form the team-scope test uses).
- "a stale unsubscribe cannot clear a newer mount's subscription": subscribe as `sub-a`,
  subscribe as `sub-b`, unsubscribe `sub-a`, mark a task done, assert the invalidation arrives.
- "a reconnect is a fresh connection with no subscription": subscribe, close, open a new socket
  with the same headers, mark a task done on another socket, assert no invalidation; then
  subscribe and assert one.
- "the member's workflow page receives what the list receives": subscribe with `subscribeRun`
  for a run on the team, mark its task done from a teammate, assert the invalidation; from a
  member on an idle team, assert none.
- "a visible tab refetches on an invalidation" is the renamed browser title (phase 4 renames
  the three existing browser titles to the tab word; do the rename here so the cycle row pins).

In `test/integration/spec.test.ts`, a "subscription tables parser" block in the shape of the
"triggers table parser" block: the real tables parse and every `pinned by` is carried; a
doctored `side`, a doctored `receives`, and a missing separator are reported.

### 2.4 Done when

- `pnpm spec check` parses both tables and reports no unpinned title. `pnpm spec print` shows
  the rows.
- The four new titles pass. `pnpm typecheck`, `pnpm lint`, `pnpm test` green.

## Phase 3: the publish-sites table on `ShopAgent.publish`

### 3.1 The spec text

The JSDoc on `publish` in `src/lib/ShopAgent.ts` gains, after the two bold rules, the sites
table: columns `trigger`, `orders`, `teams`, `when`, `pinned by`. Rows, from the fan-out
research corrected to the current code:

| trigger                                                                  | orders    | teams                                    | when    |
| ------------------------------------------------------------------------ | --------- | ---------------------------------------- | ------- |
| order webhook (create, paid, cancelled, fulfilled, edited)               | the order | before ∪ after                           | changed |
| order webhook, the retention sweep deleted something                     | all       | all                                      | swept   |
| order webhook, new order at the cycle ceiling                            | the order | (none)                                   | always  |
| Sync open orders pressed, started or refused                             | all       | all                                      | always  |
| the open-orders stream finishes                                          | all       | all                                      | always  |
| the sync workflow completes or fails                                     | all       | all                                      | always  |
| Sync this order pressed                                                  | the order | all                                      | changed |
| Edit tag, Apply                                                          | all       | all                                      | always  |
| the on/off switch, Turn on from the editor, Delete workflow, Delete team | all       | all                                      | always  |
| Assign a task's team                                                     | all       | before ∪ after                           | always  |
| Attach workflow                                                          | the order | all                                      | always  |
| Cancel workflow                                                          | the order | the order's teams, read before the write | always  |
| a merchant run or task verb through `publishToTeams`                     | the order | the order's teams                        | always  |
| a member run or task verb through `publishToTeams`                       | the order | the order's teams                        | always  |
| seed (dev)                                                               | all       | all                                      | always  |

Verify each cell against the code before writing it; the fan-out research is a day old and two
of its cells were already behind. The `pinned by` column: existing titles where one proves the
row (the three webhook titles in `shop-agent-sync-order.test.ts`; "a task verb reaches the
orders index and the order's page, and not another order's page" for the two `publishToTeams`
rows; the stream suite's completion title for the stream rows), new titles otherwise (3.3).

The sync pipeline table on `ShopAgentHost` keeps its `publish` column; its intro sentence
"`publish` is who is told" gains "the sites table on `ShopAgent.publish` is the full list".

### 3.2 The parser and the sources

`jsdocBefore` gains the anchor form from planning decision 2. `parsePublishSites(source)`
anchors on `"\n  private publish("`, five columns, `orders` and `teams` each held to a closed
list (`all`, `the order`, `before ∪ after`, `the order's teams`, `(none)`, plus the Cancel
workflow phrase, which the list names in full), `when` held to `changed`, `always`, `swept`.
`scripts/spec.ts` reads `src/lib/ShopAgent.ts` as a new source (`readAgentClass`), adds the
parser to `check` with `checkPinned(rows, testSources, "publish")` and to `print`.

### 3.3 The tests

New titles, each asserting over a merchant socket subscribed to the orders index and a member
socket subscribed to the workflows list whether an invalidation arrives:

- "Sync open orders publishes to every screen when it starts" (`shop-agent-orders-stream.test.ts`
  or wherever the sync button is driven today);
- "Edit tag and Apply publish to every screen whether or not a run moved"
  (`shop-agent-workflows.test.ts`);
- "turning a workflow on or off, deleting it, or deleting a team publishes to every screen";
- "assigning a task's team publishes to the teams before and after";
- "Attach workflow publishes the order to every team";
- "Cancel workflow publishes the order to the teams it had";
- "a new order refused at the ceiling publishes to the merchant and no member"
  (`shop-agent-orders-ceiling.test.ts`);
- "the seed publishes once to every screen" (or cite an existing seed title if one asserts it;
  if none and the seed route is not under test, the row's `pinned by` cites the title of the
  dev-only test added beside `api.dev.seed.ts`'s existing coverage).

Test parser block: "publish sites table parser", real table parses, doctored `orders`,
doctored `when`, anchor missing reported with the message naming `private publish(`.

### 3.4 Done when

- Every row pinned; `pnpm spec check` clean; `pnpm spec print` shows the sites.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green.

## Phase 4: the client table on `useSubscribedQuery`

### 4.1 The spec text

The module JSDoc on `useSubscribedQuery` in `src/lib/useSubscribedQuery.ts` keeps its first
paragraph (what the hook is: the tab's half of the cycle on `Domain.Subscription`), then the
events table, columns `event`, `visible`, `the hook`, `pinned by`, the eight rows from the
research's client table, written as:

| event                              | visible | the hook                                               |
| ---------------------------------- | ------- | ------------------------------------------------------ |
| identify                           | either  | invalidates, joining a fetch in flight; never deferred |
| invalidation, no window open       | yes     | refetches now and opens the window                     |
| invalidation, window open          | yes     | marks pending; the window's end refetches once         |
| invalidation                       | no      | marks the query stale and defers                       |
| window ends with a refetch pending | no      | defers                                                 |
| tab becomes visible, deferred      | yes     | refetches through the throttle                         |
| unmount                            | either  | unsubscribes one task later, if still identified       |
| setup again before that task       | either  | cancels the unsubscribe                                |

Then the paragraphs that explain the cells and cannot be cells: why a throttle and not
`cancelRefetch: false`; why `refetchOnWindowFocus` is off; `initialData` and the key outrunning
the loader; `placeholderData`. The `INVALIDATION_THROTTLE_MS` JSDoc keeps the reasoning for the
number and links the table.

### 4.2 The parser and the sources

`parseClientEvents(source)` anchors on `export const useSubscribedQuery =` (the existing
`jsdocBefore` form), four columns, `visible` one of `yes`, `no`, `either`. `scripts/spec.ts`
reads `src/lib/useSubscribedQuery.ts` as a source; `readTestSources` globs
`test/**/*.test.{ts,tsx}` (planning decision 6). `check` and `print` gain the table.

### 4.3 The tests

In `test/browser/use-subscribed-query.test.tsx`. Rename the three existing titles to the tab
word ("a hidden tab defers its refetch to the next visibilitychange", "a throttled invalidation
whose window elapses while hidden defers", "a visible tab refetches on an invalidation"). Add:

- "identify invalidates once and joins a fetch in flight": render with `identified: false`,
  flip the provider value to `identified: true`, assert exactly one `subscribe` call.
- "a burst inside the window costs two refetches": three invalidations within 100 ms, assert
  two `subscribe` calls after `INVALIDATION_THROTTLE_MS + 100`.
- "unmount unsubscribes with the mount's subscriber id": unmount, await a macrotask, assert
  `unsubscribe` called once with the same `subscriberId` the `subscribe` spy received.
- "a setup before the unsubscribe task cancels it": render under `React.StrictMode`, assert
  `unsubscribe` was never called after the first read.

`renderSubscribed` gains an `identified` parameter and exposes the `unsubscribe` spy.

Test parser block in `spec.test.ts`: "client events table parser", real table parses, every
title carried from a `.test.tsx` file, doctored `visible` reported.

### 4.4 Done when

- `pnpm test:browser` green with seven titles; `pnpm spec check` finds all eight rows pinned.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green.

## Phase 5: the connection table on `Domain.ConnectionRole`

### 5.1 The spec text

The JSDoc on `ConnectionRole` in `src/lib/domain/Platform.ts` keeps its first two paragraphs
(two populations, identity read from the connection and never a message) and gains the table,
columns `event`, `side`, `answer`, `pinned by`:

| event                                          | side   | answer                                                                           |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| upgrade with a valid App Bridge token          | Worker | forwards `merchant`                                                              |
| upgrade with a member cookie for this shop     | Worker | forwards `member`, the id, the email, the team ids                               |
| upgrade carrying a forged `x-baton-*` header   | Worker | the header is dropped; the gate's own answer is forwarded                        |
| cookie of a signed-in non-member of the shop   | Worker | 404                                                                              |
| cookie of an operator                          | Worker | 403                                                                              |
| member of a shop whose app subscription lapsed | Worker | 402                                                                              |
| neither token nor cookie                       | Worker | 401                                                                              |
| connect with decodable headers                 | object | identity stored on the connection, tagged by role and member id; no subscription |
| connect with undecodable headers               | object | closed 4403; the tab does not reconnect                                          |
| a member's teams or membership change          | object | that member's connections closed 4401                                            |
| a team is deleted                              | object | its members' connections closed 4401                                             |
| the shop's app subscription lapses             | object | every connection closed 4401                                                     |
| close 4401                                     | tab    | reconnects through the gate one task later; the router is invalidated            |

`pinned by`: the eight gate titles, the five connection titles, and two new ones (5.3). The
paragraphs on the close codes (`CONNECTION_CLOSE_FORBIDDEN`, `CONNECTION_CLOSE_REVOKED`) shrink
to a link to this table and keep the sentence on the 4000 to 4999 range.

### 5.2 The parser

`parseConnectionEvents(source)` on `ConnectionRole`, four columns, `side` one of `Worker`,
`object`, `tab`. `check` and `print` gain it.

### 5.3 The tests

- "the tab reconnects on 4401 and not on 4403": browser project, a stand-in `useAgent` is too
  far from the real one to be worth faking; instead test `ShopAgentSocketHost`'s `onClose`
  decision by extracting it as `reconnectAfterClose(code): boolean` beside `SocketQuery` and
  pinning the two codes in a browser test of that function. The e2e "removing a member closes
  the shop page on their live session" stays the end-to-end proof.
- "a forged role header on a merchant upgrade is dropped" exists as "strips a forged role header
  from a member upgrade"; cite it. No second test.

### 5.4 Done when

- Every row pinned; `pnpm spec check` clean.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:browser` green.

## After the phases

- `docs/publish-subscribe-spec-research.md`: one line under "Where each rule is written" saying
  the tables on `Subscription`, `publish`, `useSubscribedQuery` and `ConnectionRole` now hold
  these rules, with the date.
- `AGENTS.md`'s second bullet lists the parsed tables; add the four with their symbols and
  files, in the same sentence shape, and the `pnpm spec check` line in Commands.
- `pnpm fmt` repo-wide; keep every file it touches.
- Do not commit. Report the test counts per project and the `pnpm spec print` tail.

## Deviations and issues

Record here, as you go, anything that did not go as the plan says. One entry per item, in this
form:

- **What the plan said.** The sentence or step, quoted or named.
- **What was found.** The fact that contradicted it, with the file and symbol.
- **The options.** The two or three ways to proceed that were considered.
- **What was done.** The one taken, and why in a sentence.
- **Follow-up.** Whether the research doc, a spec row or this plan needs a change afterwards, or
  nothing.

Known risks to watch for, which become entries if they bite:

1. **The symbol cell checker.** `pnpm spec check` verifies that a word named in a `symbol` cell
   exists in the context file or the barrel. The new rows name symbols outside `src/lib/domain/`
   (`ShopAgentSocket`, `useSubscribedQuery`, `ShopAgent.publish`, `PublishScope`). Read
   `checkVocabulary` first: if it refuses an out-of-context symbol, the memo row already names
   "the Cache values in ShopWorkAgent" in prose, so write the cell as prose naming the symbol
   the same way, and record which cells.
2. **`nthTable` and a table inside a sentence.** The JSDoc on `Subscription` must have the
   cycle table as its first `|` block. A list item or an example containing `|` before it
   breaks the count. Keep the paragraph above the tables free of pipes.
3. **The anchor form on `jsdocBefore`.** `private publish(` appears once in `ShopAgent.ts`; if a
   second method ever starts with that text the anchor is ambiguous. The parser fails on two
   matches rather than taking the first; record it if it ever fires.
4. **The sites table's closed word lists.** Cancel workflow's teams cell ("the order's teams,
   read before the write") is a phrase, not a word. If holding it in a list reads badly, split
   the column into `teams` (the list) and a `notes` column; record the change to the columns.
5. **A sites row no existing test proves cleanly.** The stream completion title may assert the
   rows, not the invalidation. Where an existing title does not prove the scope, write the new
   test rather than citing a title that proves something else; `checkPinned` cannot tell the
   difference, so this is on the implementer.
6. **The reconnect test over the hand-spoken socket.** `openAgentSocket` talks to the stub
   directly; closing and reopening gives a fresh connection on the same object, which is the
   case the row describes. If the SDK keeps the old connection's state briefly after close,
   wait for `cf_agent_identity` on the new socket before asserting.
7. **Browser timing.** The "burst" test waits past the 2 s throttle; the browser project's
   default timeout is 5 s per test. If the four new tests push a run near the limit, raise the
   timeout on those tests only.
8. **Strict Mode in `vitest-browser-react`.** `renderHook` may not accept a `React.StrictMode`
   wrapper cleanly; if not, wrap the hook component in `<React.StrictMode>` inside `wrapper`
   and record it.
9. **`AGENTS.md` sentence length.** The second bullet is already long. If adding four tables
   makes it unreadable, add a new bullet for the publish and subscribe tables in the same form
   as the billing bullet; the content is the same.
10. **The `pushes` grep's reach.** `e2e/` titles and `test/` comments use "push" in the
    invalidation sense in a few places the research did not count. Rename them too; the e2e
    titles are not read by `checkPinned` so no row cites them.

### Recorded during implementation

Implemented 2026-10-04, all five phases, uncommitted. Final counts: integration 741 tests in 34
files, browser 8 tests in 2 files.

- **The symbol cell checker (risk 1).** _Plan:_ write out-of-context symbols as prose if refused.
  _Found:_ `checkVocabulary` refused `ShopAgentSocket`, `ShopAgentSocketProvider`, `identified`,
  `PublishScope`, `PublishTeams`, `INVALIDATION_THROTTLE_MS`, `revokeAllConnections`: it wants each
  word somewhere else in Platform or the barrel. _Options:_ prose cells; name them where Platform's
  JSDoc already talks about them. _Done:_ the second; the `ConnectionRole`, `Subscription`, close
  codes and `InvalidatedMessage` JSDoc name them, and `ConnectionState` is written "`ConnectionState`
  in ShopWork". No cell is prose. _Follow-up:_ none.
- **The audit still lists two forms (1.3).** _Plan:_ `subscribe` and `invalidated` leave
  `pnpm vocab:audit`. _Found:_ the audit matches whole words, and these are the verb and participle
  of the `subscription` and `invalidation` rows. _Options:_ a row per form; the allowlist (refused
  for domain words by the runbook); leave. _Done:_ left. _Follow-up:_ none, unless the audit learns
  word forms.
- **Retired titles (planning decision 10).** _Plan:_ three titles say "pushes". _Found:_ two
  ("pushes a completed task to the team, ...", "completes a member's task over a merchant socket
  and pushes it to the team"). Also renamed: "the class's publish clears the memo before its
  frames" to "... before its invalidations", and "402s a member of a shop whose subscription
  lapsed" to "... app subscription lapsed" (decision 2). _Follow-up:_ none.
- **The test glob widened in phase 2.** _Plan:_ phase 4. _Found:_ the cycle row pins the renamed
  browser title. Also: the browser project writes a failed test's screenshots under a directory
  named `<file>.test.tsx`, which the glob matched; `readTestSources` now keeps files only.
- **A fourth `when` word, `written` (3.1).** _Plan:_ `changed`, `always`, `swept`. _Found:_ Delete
  workflow, Assign, Attach, Cancel and the seed publish only after a write that succeeded, while
  the run and task verbs, Edit tag, Apply, the switch and Delete team publish on a refused call
  too (the publish taps the result, and Delete team publishes on `NotFound`). _Options:_ `always`
  for both, which misstates one; a fourth word. _Done:_ `written`; Delete workflow and Delete team
  are separate rows. Behaviour unchanged. _Follow-up:_ whether a refused verb should publish at
  all is a question for the user; it costs one refetch per subscribed screen.
- **Cancel workflow names all orders (3.1).** _Plan:_ orders `the order`. _Found:_
  `merchantCancelRun` calls `host.publish("all", teams)`. _Done:_ the cell says `all`, and the
  title is "Cancel workflow publishes to every order and to the teams the order had". Behaviour
  unchanged. _Follow-up:_ narrowing it to `[orderId]` is a one-line change at the cell.
- **Existing titles did not prove most sites (risk 5).** The webhook titles assert a merchant
  invalidation only, and no suite asserted one for Sync open orders, the stream, the workflow's
  ending, Sync this order or the seed. A new test per row, over `openTwoScreens` in
  `agent-socket.ts` (the orders index plus a member on a team with no work); the sweep test's
  body also asserts the member screen. The webhook row cites a new title for its teams half,
  driven by a cancel so only the read before the write names the team.
- **Where the site tests went (3.3).** The configuration verbs are in `member-runs-socket.test.ts`
  with the run verbs, for its `seedShopWithWork` fixture. No suite called `onOrdersStream` on the
  object, so the stream test stands in for `globalThis.fetch` for one URL in
  `shop-agent-orders-stream.test.ts`. The workflow's completion and failure are two tests, since
  `introspectWorkflow` allows one session at a time; the row cites both.
- **Strict Mode and the join test (risk 8, 4.3).** Strict Mode inside `renderHook`'s wrapper does
  not run effects twice; only a root `<StrictMode>` does, so the helper renders a probe component
  with `render`. The join test as planned could not fail: with loader data and `staleTime:
Infinity`, enabling starts no fetch, and TanStack Query cancels a fetch in flight only on a query
  that has data. It now holds an invalidation's refetch open across a reconnect's identify. Both
  tests were checked against the mutation they guard (no `clearTimeout`; `cancelRefetch` true).
- **The 4403 title (5.1).** The parameterised `closes ${label} with 4403` cannot be matched by
  `checkPinned`; it is one test, "closes a connection with undecodable headers with 4403", over
  the four cases.
- **Connection table rows (5.1).** Added "a member past the plan's included seats" (the eighth gate
  title) and "close 4403 | tab". The router invalidation on 4401 moved to the prose under the
  table, since the reconnect test does not pin it.
- **Parsers.** The five tables share one `parsePinnedTable` in `scripts/lib/spec.ts` (non-empty
  free columns, closed-list columns, `pinned by` split on `; `) rather than five copies of
  `parseTriggerTable`.
- **Observed, not changed.** `seedWorkflows` replaces every run and definition and publishes
  nothing; `seedOrders`, which always follows it, publishes once to all.

### Open questions

Both were answered 2026-10-04 and implemented, uncommitted. Final counts: integration 742 tests
in 34 files, browser 8 tests in 2 files.

1. **Should a refused call publish?** No. Option A taken: every run and task verb, Edit tag,
   Apply, the switch and the editor's Turn on publish through `publishIfOk` in `ShopWorkAgent`,
   so only an `Ok` result publishes. Their rows' `when` is `written`, and the new title "a
   refused call publishes nothing" is on each row. The refused tab is not left stale: it
   refetches itself on every result (`settle` in `useMemberRunActions`, `invalidate` on the
   order page). Delete team stays `always`: a `NotFound` delete still nulls dangling team
   pointers and reconciles, which is a write the lists show; its JSDoc says so.
2. **Should Cancel workflow name only its order?** Yes. `merchantCancelRun` reads
   `orderAndTeamIds` before the write and publishes `[orderId]` to the teams. The `orders`
   cell is `the order`, and the test "Cancel workflow publishes the order to the teams it had"
   asserts another order's page receives nothing.

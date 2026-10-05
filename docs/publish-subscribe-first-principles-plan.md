# Publish and subscribe from first principles: implementation plan

This plan carries out the decisions in `docs/publish-subscribe-first-principles-research.md`
(2026-10-04, one Plannotator pass, all ten as recommended; decision 6 is a follow-up). Read that
doc first: "What the mechanism must do" is the requirement, each table's section says what goes
and what stays, "What the simplification removes" is the deletion list, and Decisions holds the
ten calls. Nothing here is open; where this plan had to choose something the research did not,
the choice is under "Decided at planning time".

Three phases, in decision 10's order. Phase 1 rewrites the spec: the words, the three tables
that remain, `when` in two words, the connection table's re-homing. Phase 2 is one change that
deletes the subscription, the scope, unsubscribe and the loader and socket twins, and makes
`publish()` a bell. Phase 3 is the client: the hook's two unsubscribe rows go, the revoke close
code moves to 3xxx and the by-hand reconnect goes. Each phase starts at the spec text, then the
code, then the tests, and ends with a "done when". The follow-up (decision 6) is recorded at the
end and is not part of this plan's work.

## Before you start

- Read `AGENTS.md`, `docs/vocabulary-runbook.md`, and the JSDoc on: the map, the Shared words
  table and the Shape families table (`src/lib/Domain.ts`); the nouns table, `Subscription`,
  `SubscriptionState`, `ConnectionRole`, the close codes, `SubscriberIdInput`,
  `InvalidatedMessage` (`src/lib/domain/Platform.ts`); `MerchantConnectionState`,
  `MemberConnectionState`, `SubscribeOrdersInput`, `SubscribeOrderInput`, `SubscribeRunsInput`,
  `SubscribeRunInput`, `GetRunForMemberInput` (`src/lib/domain/ShopWork.ts`); `publish`,
  `publishTo`, `onConnect`, `getConnectionTags`, `setSubscription`, `unsubscribe`,
  `closeMemberConnections`, `revokeAllConnections`, `syncOrderWebhook`, `syncOrder`,
  `syncOpenOrders`, `listOrders`, `subscribeOrders`, `getOrderDetail`, `subscribeOrder`,
  `listRuns`, `subscribeRuns`, `memberGetRun`, `subscribeRun`, `CallerRole` and
  `callableEffect` (`src/lib/ShopAgent.ts`); `ShopAgentHost`, `PublishScope`, `PublishTeams`,
  `unionTeams` and the sync pipeline table (`src/lib/agent/Host.ts`); `publishIfOk`,
  `orderTeamIds`, `orderAndTeamIds`, `publishToTeams`, `readOrders`, `subscribeOrders`,
  `subscribeOrder`, `subscribeRuns`, `subscribeRun`, `merchantAssignRunTaskTeam`,
  `merchantCancelRun`, `merchantAttachWorkflow` (`src/lib/agent/ShopWork.ts`);
  `listOrderTeamIds` (`src/lib/RunRepository.ts`); `ShopAgentClient` whole; the module JSDoc
  on `useSubscribedQuery` (`src/lib/useSubscribedQuery.ts`); `ShopAgentContext.tsx` and
  `ShopAgentSocketHost.tsx` whole; `onSocketClose` in `src/routes/app.tsx` and
  `src/routes/shop.$shop.tsx`; the four live screens' `useSubscribedQuery` calls
  (`app.orders.index.tsx`, `app.orders.$orderId.tsx`, `shop.$shop.workflows.index.tsx`,
  `shop.$shop.workflows.$runId.tsx`). On the checker side: `parsePinnedTable` and the five
  publish and subscribe parsers with their word lists (`scripts/lib/spec.ts`, from
  `CYCLE_SIDE_WORDS` to `parseConnectionEvents`), `readPinnedTables` in `scripts/spec.ts`, and
  the "subscription tables parser", "publish sites table parser", "connection table parser"
  and client events blocks in `test/integration/spec.test.ts`. On the test side:
  `test/integration/agent-socket.ts` (`openTwoScreens`, `invalidations`,
  `receivedInvalidations`, `receivesNoMore`, `isInvalidated`),
  `test/integration/member-runs-socket.test.ts`, `test/integration/list-memo.test.ts`,
  `test/integration/shop-agent-connections.test.ts`,
  `test/integration/shop-agent-callables.test.ts`, `test/browser/use-subscribed-query.test.tsx`
  and `test/browser/shop-agent-socket-host.test.ts`.
- The rules that matter most here:
  - A rule is stated once, on the symbol that is the concept or enforces it. This plan deletes
    rules; every site that linked a deleted rule must stop linking it, and every sentence of
    prose that explained a deleted mechanism goes with it. Prose that explains a kept mechanism
    by contrast with a deleted one is rewritten to stand alone.
  - A JSDoc never cites a file under `docs/`. Carry the reasoning inline.
  - Identifiers, JSDoc, test titles and log messages speak the vocabulary. After phase 1 the
    Platform words are: socket, connection, identify, publish, invalidation, revoke, live, and
    tab for a browser tab. Retired: subscription, subscriber, scope, subscribe (as a verb for the
    cycle). A screen is "live" when the object re-reads it on every publish; the four live
    screens are the orders index, the order page, the workflows list and the member's workflow
    page, named by the Screens table.
  - `scripts/rules-lint.ts` refuses a reserved stem and an `is<State>` without its noun in an
    exported identifier. Nothing here adds one.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- Run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check` and `scripts/rules-lint.ts`)
  and `pnpm test` after each phase. Phases 2 and 3 also run `pnpm test:browser` and the two
  socket e2e tests (`npm run test:e2e -- --grep "over the socket|without a reload|closes the
shop page"`). `pnpm fmt` repo-wide at the end of each phase and keep every file it touches.

## The decisions, by phase

| decision                                                    | phase   |
| ----------------------------------------------------------- | ------- |
| 1. no subscription, no scope; publish to every connection   | 1, 2    |
| 2. no unsubscribe                                           | 1, 2, 3 |
| 3. `when` is `changed` or `written`; ceiling webhook silent | 1, 2    |
| 4. the ceiling banner stays loader-only                     | 2       |
| 5. revoke closes 3xxx; partysocket reconnects on its own    | 1, 3    |
| 6. `useAgent` stays; follow-up                              | after   |
| 7. the identify effect stays                                | 3       |
| 8. the connection table is the auth rule; seat row points   | 1       |
| 9. no role-split publish                                    | 2       |
| 10. order: spec rows, one deletion change, client rows      | 1, 2, 3 |

## Decided at planning time

1. **The word for a screen the object re-reads: `live`.** The research says "live screen"
   throughout and retires `subscription`, `subscriber` and `scope`. The hook, its parameter and
   the class's reads need a word, and "subscribe" would keep a retired word alive in identifiers.
   One Platform row: `live` — a screen whose rows other actors change and the object re-reads
   on every publish; the four live screens; symbol `useLiveQuery`; screen (none). The hook is
   renamed `useLiveQuery`, its `subscribe` parameter `read`. `rules-lint`'s reserved stems do
   not include "live"; check before relying on it.
2. **The merchant twins merge into one method; the member twins keep two entry points over one
   read.** `callableEffect`'s `"merchant"` role admits a merchant connection or a connectionless
   RPC caller, so `listOrders` and `getOrderDetail` become `@callable()` with role `"merchant"`
   and serve both the loader (through `ShopAgentClient`) and the hook; `subscribeOrders` and
   `subscribeOrder` are deleted. The `"member"` role requires a connection, since `teamIds`
   comes off it, and the loader has none; so `listRuns` and `memberGetRun` (role `"rpc"`,
   `teamIds` in the input) stay, and `subscribeRuns` and `subscribeRun` are renamed `liveRuns`
   and `liveRun`, role `"member"`, `teamIds` from the connection; each pair calls the one
   `ShopWorkAgent` read. The naming rule on the run callables ("`<role><Verb>`" in
   `shop-agent-callables.test.ts`) covers run writes, not reads; confirm the test's list before
   choosing, and record the final names under Deviations if they differ.
3. **`publish()` takes no arguments.** `ShopAgentHost.publish` is `Effect<void>` with no
   parameters. The sync pipeline table's `publish` column keeps its rows but every cell becomes
   `every connection`, or the column is dropped; drop it, since a column with one value says
   nothing, and the prose above the table says every row publishes.
4. **The connection's `subscription` field goes, not the state.** `MerchantConnectionState`
   becomes `{ role: "merchant" }` and `MemberConnectionState` loses `subscription`. The
   `onExcessProperty: "error"` decode means a hibernated connection carrying the old field
   decodes as unidentified and is treated as such; on local dev run `pnpm dev:reset`, and on
   staging accept that open sockets reconnect once after the deploy (the tab's reconnect is the
   ordinary path).
5. **The ceiling webhook stops publishing (decision 3) and the member-only send goes with it.**
   `syncOrderWebhook`'s ceiling branch writes `markOrdersLimited` and returns; no publish. The
   title "a new order refused at the ceiling publishes to the merchant and no member" becomes "a
   new order refused at the ceiling publishes nothing", asserting both screens receive nothing.
6. **The revoke close code is 3401.** RFC 6455 §7.4.2 reserves 3000 to 3999 for libraries,
   frameworks and applications, and the `agents` client's `isTerminalCloseEvent` (which only
   recognises 1008 and 4000 to 4999) does not match it, so partysocket reconnects on its own and
   `useAgent`'s `onClose` still fires. `CONNECTION_CLOSE_REVOKED` is 3401;
   `CONNECTION_CLOSE_FORBIDDEN` stays 4403. `reconnectAfterClose` and the `setTimeout` reconnect
   in `ShopAgentSocketHost` are deleted. Verify in a browser test before deleting; risk 6.
7. **`publishIfOk` stays, `when` is the result tag.** `written` means an `Ok` result published.
   Delete team's publish moves under `publishIfOk` too: a `NotFound` delete is a refused call,
   and the dangling-pointer nulling it does on NotFound is a repair with nothing a live screen
   shows that was not already absent. If the repair should publish, that is a `written` write
   and the method should return `Ok`; record the choice.
8. **The memo rule's text.** On `publish`: "A publish clears the list memo before the first
   invalidation goes out" stays; the sentence beginning "A write that publishes nothing leaves
   the memo as it is" is cut, and "every write a list shows must publish" becomes the first
   rule's own sentence: every write that succeeded publishes, so the memo and the screens move
   together.
9. **Instrumentation.** The publish log line keeps `merchants=` and `members=` and drops
   `touched=` and `teams=`. `publishTo` still answers the role it sent to.
10. **The `pushes` and `subscribes` greps.** After phase 2, grep `src/`, `test/` and `e2e/` for
    `subscri`, `Subscri`, `scope`, `touched`, `publishToTeams` and `unsubscribe` and clear
    every hit that is not billing's "app subscription" or `SubscriptionPlan`. Billing may keep
    the "app subscription" qualifier; the Shared words row for `subscription` is deleted since
    the word has one context again.

## Phase 1: the spec

### 1.1 The words

In the nouns table on `src/lib/domain/Platform.ts`:

- Delete the rows `subscription`, `subscriber`, `scope`.
- Rewrite `publish`: "a write that succeeded telling every connection to re-read; the sites
  table on `ShopAgent.publish` lists the writes" — symbol `ShopAgent.publish`,
  `ShopAgentHost.publish`.
- Rewrite `connection`: "the object's end of one socket, from identify to close; carries who
  is on it" — symbol `ConnectionState` in ShopWork, `ConnectionRole`.
- Rewrite `invalidation`: "the one message the object sends: re-read; never the data" — symbol
  `InvalidatedMessage`, `INVALIDATION_THROTTLE_MS`.
- Rewrite `revoke`: "... so the tab reconnects through the gate" (unchanged), symbol
  `CONNECTION_CLOSE_REVOKED`, `revokeAllConnections`.
- Add `live` as decided (planning decision 1).

In `src/lib/Domain.ts`: delete the Shared words row for `subscription`. In the Shape families
table nothing changes; the `Subscribe<Feature>Input` shapes are deleted in phase 2 and the
`Input` row's rule is unaffected.

`docs/vocabulary-runbook.md` is the procedure for a retired word; follow it (the retired list in
`scripts/rules-lint.ts` is for screen copy, and none of these words was copy, so no entry).

### 1.2 The cycle table and the delivery table

The JSDoc on `Subscription` moves: `Subscription` and `SubscriptionState` are deleted in phase 2,
so in this phase the cycle table is rewritten on `InvalidatedMessage`, which is the concept that
survives (the message the bell sends), and the delivery table is deleted. Three rows:

| step       | side   | symbol                | rule                                                                                                | pinned by                                          |
| ---------- | ------ | --------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| identify   | object | `ShopAgent.onConnect` | a connection carries the gate's identity; the tab's `identified` flip runs the first read           | stores a merchant identity and tags the connection |
| publish    | object | `ShopAgent.publish`   | a write that succeeded sends the invalidation to every connection; the sites table lists the writes | every connection receives every publish            |
| invalidate | tab    | `useLiveQuery`        | a mounted live screen re-reads, throttled, deferred while hidden; the events table is on the hook   | a visible tab refetches on an invalidation         |

The prose under it: the loader-versus-socket rule becomes "a live screen reads one method twice:
through `ShopAgentClient` in its loader for the SSR paint, and through `useLiveQuery` over the
socket after; a socket `useQuery` outside the hook never re-reads and belongs on a loader". The
paragraphs about the two halves of the scope, `orderId: null`, and "only order and run state is
published" are cut; the last becomes one sentence on `publish`.

`CYCLE_SIDE_WORDS` keeps `object`, `tab`; `both` and `Worker` can go if no row uses them.
`parseSubscriptionCycle` is renamed `parseInvalidationCycle` with `name: "InvalidatedMessage"`;
`parseSubscriptionDelivery`, `DELIVERY_ROLE_WORDS` and `RECEIVES_WORDS` are deleted, with their
block in `test/integration/spec.test.ts` and their entry in `readPinnedTables`.

### 1.3 The sites table

On `ShopAgent.publish`, the header becomes `trigger | when | pinned by`. The rows, with their
`when`:

| trigger                                                                    | when    |
| -------------------------------------------------------------------------- | ------- |
| order webhook (create, paid, cancelled, fulfilled, edited)                 | changed |
| order webhook, the retention sweep deleted something                       | changed |
| Sync open orders pressed, started or refused (in flight publishes nothing) | written |
| the open-orders stream finishes                                            | written |
| the sync workflow completes, or fails (its error sink, then its callback)  | written |
| Sync this order pressed                                                    | changed |
| Edit tag, Apply                                                            | written |
| the on/off switch, the editor's Turn on, Delete workflow, Delete team      | written |
| Assign a task's team                                                       | written |
| Attach workflow                                                            | written |
| Cancel workflow                                                            | written |
| a merchant run or task verb                                                | written |
| a member run or task verb                                                  | written |
| seed (dev)                                                                 | written |

The ceiling row is deleted (planning decision 5). Delete team joins the switch row. The `pinned
by` cells keep the titles that still hold after phase 2 and drop the ones about scope; see 2.4
for the title changes. The prose above the table: the first bold rule stays, with "or the
reconcile created, resized or closed a run" as is; the memo rule as in planning decision 8; the
paragraph defining `orders` and `teams` is cut; `when` is defined in one sentence: "`changed`
where the write reports whether it changed anything (the two fetch paths); `written` after a call
whose result is `Ok`, through `publishIfOk`; a refused call publishes nothing, since it wrote
nothing a live screen shows and the refused tab re-reads on its own result". The paragraph
beginning "`"all"` is the honest default" is cut; its second sentence ("Workflow configuration is
loader data and does not publish, except ...") stays.

`SITE_ORDERS_WORDS` and `SITE_TEAMS_WORDS` are deleted; `SITE_WHEN_WORDS` is `["changed",
"written"]`; `parsePublishSites`'s columns are `["trigger", "when"]`.

### 1.4 The client events table

On the hook (renamed in phase 3; in this phase the table changes and the parser's `name` follows
the rename when it happens, so leave `name: "useSubscribedQuery"` until 3.1 and record it):
delete the rows `unmount` and `setup again before that task`. Rewrite `identify`'s hook cell to
"runs the read; never deferred". Add one sentence of prose: the throttle is the object's rate
limit, since every connection receives every publish, and 30 refetches a minute per tab is the
ceiling the shop pays at any load. The paragraph on the unsubscribe delay and Strict Mode is cut
(the behaviour goes in phase 3; the spec says so first, and the two titles stay carried by their
tests until 3.2 deletes them, so `checkPinned` passes either way).

### 1.5 The connection table

On `ConnectionRole`: the row "a member past the plan's included seats" becomes "forwards
`member`; the seat rule is the triggers table on `ShopUsage`" with its title unchanged. The two
close rows become one: "close 3401 (revoked) | tab | reconnects through the gate on its own;
close 4403 (forbidden) stays closed" — but the code change is phase 3, so in this phase write
the row as it will read and keep the title "the tab reconnects on 4401 and not on 4403" until 3.3
renames it; record the interim. The three revocation rows say 3401 after phase 3; write 4401 now
and change the digits with the constant.

In `AGENTS.md` and the `pnpm spec check` descriptions (`scripts/spec.ts`, the `check` and `print`
help strings and the file header): "the publish and subscribe tables" names three (the cycle
table on `InvalidatedMessage`, the sites table on `ShopAgent.publish`, the events table on
`useLiveQuery`), and the connection table on `ConnectionRole` is named separately as the
authorization rule for the socket. Update the `pnpm spec check` line in the Commands block too.

### 1.6 Done when

- `pnpm spec check` parses three publish tables and the connection table; the delivery parser
  and its test block are gone; every `pinned by` still names a title a test carries (the deleted
  rows' titles are simply no longer cited; their tests still exist until phase 2).
- The nouns table has `live` and not `subscription`, `subscriber`, `scope`; the Shared words
  table has no `subscription` row.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green. Behaviour unchanged.

## Phase 2: the object

One change. Delete in this order so each step compiles or fails for the next step's reason.

### 2.1 The publish

- `src/lib/agent/Host.ts`: delete `PublishScope`, `PublishTeams`, `unionTeams`; `publish` is
  `Effect.Effect<void>`; the pipeline table loses its `publish` column (planning decision 3).
- `src/lib/ShopAgent.ts`: `publish()` takes no arguments; `publishTo(connection)` sends to every
  identified connection and answers its role; the log line drops `touched=` and `teams=`. The
  constructor's `publish: (touched, teams) => this.publish(touched, teams)` becomes
  `publish: () => this.publish()`.
- Every call site: `syncOrderWebhook` (delete the `before` and `after` team reads and the
  ceiling publish; publish on `changed` and on a sweep that deleted rows), `syncOrder`,
  `syncOpenOrders`, `onOrdersStream`, `onWorkflowComplete`, `onWorkflowError`,
  `onOrdersSyncError`, and in `ShopWorkAgent` every `host.publish(...)`: `updateWorkflowTag`,
  `applyDraft`, `setWorkflowOn`, `applyAndTurnOn`, `removeWorkflow`, `deleteTeam` (now under
  `publishIfOk`, planning decision 7), `merchantAttachWorkflow`, `merchantCancelRun` (delete
  the read before the write), `merchantAssignRunTaskTeam` (delete the before and after reads),
  the thirteen run and task verbs (`publishToTeams` becomes `host.publish`), `seedOrders`.
- Delete `publishToTeams`, `orderTeamIds`, `orderAndTeamIds` in `ShopWork.ts` and
  `listOrderTeamIds` in `RunRepository.ts`, with their JSDoc. If `listOrderTeamIds` has a
  pinned data-model row or a query-plan test, record it and delete the test with the method.

### 2.2 The subscription

- `src/lib/domain/Platform.ts`: delete `Subscription`, `SubscriptionState`,
  `SubscriberIdInput`. The cycle table already moved to `InvalidatedMessage` in 1.2.
- `src/lib/domain/ShopWork.ts`: delete the `subscription` field from both connection states and
  the `Subscribe{Orders,Order,Runs,Run}Input` shapes with their JSDoc. `GetRunForMemberInput`'s
  "socket twin" sentence goes.
- `src/lib/ShopAgent.ts`: delete `setSubscription`, the host's `setSubscription` wiring,
  `subscription(connection)`, `unsubscribe` and the `"any"` member of `CallerRole` with its
  bullet; `connectionStateFromHeaders` stops writing `subscription: null`; `onConnect`'s "The
  subscription starts `null`" paragraph goes.
- The reads (planning decision 2): `listOrders` and `getOrderDetail` become `@callable()` with
  role `"merchant"`; delete `subscribeOrders` and `subscribeOrder` on the class and in
  `ShopWorkAgent`. `subscribeRuns` and `subscribeRun` become `liveRuns` and `liveRun` on both,
  minus `setSubscription`; `ShopWorkAgent.listOrders` and `readOrders` collapse to one.
- `src/lib/ShopAgentClient.ts`: unchanged in shape (`listOrders`, `getOrderDetail`, `listRuns`,
  `memberGetRun`); its JSDoc's loader-versus-socket rule is rewritten per 1.2.
- The four routes: `stub.subscribeOrders({..., subscriberId})` becomes `stub.listOrders({...})`;
  `subscribeOrder({ legacyId, subscriberId })` becomes `getOrderDetail({ legacyId })`;
  `subscribeRuns({ subscriberId, query })` becomes `liveRuns({ query })`; `subscribeRun({
subscriberId, runId })` becomes `liveRun({ runId })`. The hook's `read` callback takes the
  stub only (phase 3 renames the parameter; in this phase keep `subscribe: (stub) => ...` and
  ignore the second argument, or do the hook's signature change here and record it).

### 2.3 The memo

`list-memo.test.ts`'s titles hold ("a publish between two reads makes the second one
recompute", "the class's publish clears the memo before its invalidations", "members on the same
teams share one computation"). Update their bodies for `publish()` with no arguments and the
renamed reads.

### 2.4 The tests

In `test/integration/agent-socket.ts`: `openTwoScreens` calls `listOrders` and `liveRuns` with
no `subscriberId`; its JSDoc stops citing `Domain.Subscription`.

In `member-runs-socket.test.ts`:

- Delete: "re-subscribing with a different query changes what the read returns" (replace with
  "a second read with a different query returns the narrowed list" only if the body tests
  something `liveRuns` still does beyond the read; otherwise delete), "a connection with no
  subscription receives nothing", "a stale unsubscribe cannot clear a newer mount's
  subscription", "a reconnect is a fresh connection with no subscription", "the member's
  workflow page receives what the list receives", "assigning a task's team publishes to the
  teams before and after", "Cancel workflow publishes the order to the teams it had", "Attach
  workflow publishes the order to every team".
- Rename and rewrite: "reads the workflows list for the connection's teams and subscribes" to
  "reads the workflows list for the connection's teams"; "publishes a completed task to the
  team, and not to a team with no work on that order" to "every connection receives every
  publish" (the cycle row's title: a merchant, a member on the team and a member on an idle team
  all receive one invalidation from one Mark done); "a task verb reaches the orders index and
  the order's page, and not another order's page" to "a task verb reaches the orders index and
  every order page" (or fold into the previous; one title per row is enough); "completes a
  member's task over a merchant socket and publishes it to the team" keeps its first half:
  "completes a member's task over a merchant socket and publishes". "Edit tag and Apply publish
  to every screen whether or not a run moved" and "turning a workflow on or off, deleting it, or
  deleting a team publishes to every screen" hold; the second's Delete team case now asserts a
  `NotFound` delete publishes nothing. "a refused call publishes nothing" holds.
- The webhook titles in `shop-agent-sync-order.test.ts` and the ceiling, stream, workflow and
  seed titles: "a webhook publishes to the teams on the order before and after, and to no other
  team" is deleted; "a new order refused at the ceiling publishes to the merchant and no member"
  becomes "a new order refused at the ceiling publishes nothing" (planning decision 5); the rest
  hold, with bodies asserting both screens of `openTwoScreens` receive.

In `shop-agent-callables.test.ts`: "admits the shared callables on either role" has nothing to
iterate once `"any"` is gone; delete it and the `"any"` arm of `namesWithRole`, and let
"declares a role for exactly the decorated methods" cover the two merchant reads that are now
callable. "every run-write callable is named <role><Verb>" is unaffected (reads are not writes);
confirm.

In `shop-agent-connections.test.ts`: the stored-state assertions drop `subscription: null`.

### 2.5 Done when

- `grep -rn "subscri\|Subscri" src test e2e` returns only billing's "app subscription",
  `SubscriptionPlan` and `Unsubscribed`; `grep -rn "PublishScope\|PublishTeams\|touched\|publishToTeams\|unsubscribe" src test` returns nothing.
- `pnpm spec check` green: every sites row's title exists.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:browser` green; the two socket e2e
  tests pass against a reset dev store (`pnpm dev:reset`, then the grep above).
- `pnpm dev:logs` after a Mark done on the dev store shows one `ShopAgent.publish` line with
  `merchants=` and `members=` and no `touched=`.

## Phase 3: the tab

### 3.1 The hook

Rename `useSubscribedQuery.ts` to `useLiveQuery.ts` and the hook to `useLiveQuery`; its
`subscribe` parameter becomes `read: (stub) => Promise<A>`. Delete `subscriberIdRef`,
`unsubscribeTimerRef`, the unsubscribe effect, and the JSDoc paragraphs on the per-mount
`subscriberId`, the unsubscribe delay and Strict Mode. The `queryFn` calls `read(agent.stub)`.
`parseClientEvents` gets `name: "useLiveQuery"`; `scripts/spec.ts`'s `HOOK` path and
`test/integration/spec.test.ts`'s raw import follow. The oxlint disable comment on `useQuery`
loses its `subscriberId` clause.

### 3.2 The browser tests

`test/browser/use-subscribed-query.test.tsx` becomes `use-live-query.test.tsx`. Delete "unmount
unsubscribes with the mount's subscriber id" and "a setup before the unsubscribe task cancels
it"; delete `nextTask`, the `unsubscribe` spy and the `strict` option of `renderSubscribed`
(renamed `renderLive`) if nothing else uses them. The other six titles hold.

### 3.3 The revoke close code

- `src/lib/domain/Platform.ts`: `CONNECTION_CLOSE_REVOKED = 3401`; the JSDoc on the close codes
  says why 3xxx (RFC 6455 §7.4.2; the `agents` client treats 1008 and 4000 to 4999 as terminal,
  `isTerminalCloseEvent` in `refs/agents/packages/agents/src/client.ts`, so a 3xxx close
  reconnects through partysocket's own backoff). The three revocation rows and the close row on
  `ConnectionRole` say 3401 and the close row's title is "the tab reconnects on 3401 and not on
  4403".
- `src/lib/ShopAgentSocketHost.tsx`: delete `reconnectAfterClose` and the `setTimeout(() =>
agentRef.current?.reconnect(), 0)` in `onClose`; the "Revocation re-arms the socket by hand"
  paragraph becomes two sentences saying a 3xxx close is not terminal to the SDK and 4403 is.
- `test/browser/shop-agent-socket-host.test.ts`: the test now drives a real `useAgent`? No: it
  tests `reconnectAfterClose`, which is gone. Replace with a test of the predicate the SDK uses:
  import `isTerminalCloseEvent` from `agents/client` (check the export; risk 6) and assert it is
  false for `CONNECTION_CLOSE_REVOKED` and true for `CONNECTION_CLOSE_FORBIDDEN`, under the title
  above. This pins the one fact the row depends on.
- `src/routes/app.tsx` and `src/routes/shop.$shop.tsx`: `onSocketClose` compares against the
  constant; no change. The e2e "removing a member closes the shop page on their live session"
  pins the visible half; run it.
- `test/integration/shop-agent-connections.test.ts`: the three revocation tests assert the
  close code through the constant; if any has the digits inline, use the constant.

### 3.4 Done when

- `pnpm spec check` green with the renamed hook and the 3401 row.
- `pnpm test:browser`: six hook tests and one host test pass.
- Headed check on the dev store: remove a member from a team while their workflows list is
  open; the page shows Connecting, reconnects on its own, and the list empties (the e2e
  "removing a member from a team empties their open workflows list" is the same scenario; run
  it headless too).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green.

## After the phases

- Re-read the research doc's "What the simplification removes" list against `git diff --stat`
  and the greps in 2.5; every named symbol is gone or renamed as planned.
- `pnpm vocab:audit`: `live` is in the table; `subscribe`, `subscriber`, `scope`, `touched`
  no longer appear in exported identifiers under `src/lib/`.
- Update the memory note and the research doc's Decisions with "implemented <date>,
  uncommitted" and the final test counts.
- Record the follow-up below where the user tracks follow-ups, if anywhere beyond this file.

## Follow-up (decision 6, not this plan's work)

**Replace `useAgent` with `usePartySocket` and a thin typed call.** Accepted 2026-10-04 as a
follow-up after this plan lands, and must not be lost. The question to answer then: with the
subscribe reads gone, the stub carries the verbs and four reads; is the SDK hook still earning
the `identified` primitive, the ref getter, the private Suspense boundary, the seven-day
`cacheTtl`, the lifted `identified` and the `defaultCallTimeout` reasoning in
`ShopAgentContext.tsx` and `ShopAgentSocketHost.tsx`? Write a short research doc from the client
JSDoc after this plan: list each paragraph, mark it SDK workaround or Baton rule, and recommend.

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

1. **A merchant read that is both callable and RPC.** "keeps the Worker's plain RPCs out of the
   callable surface" in `shop-agent-callables.test.ts` may list `listOrders` and
   `getOrderDetail` as plain RPCs. Move them to the callable list; if the test's premise is that
   a loader read is never callable, the premise changes with this plan and the test's JSDoc
   says why: the `"merchant"` role admits a connectionless caller, so one method serves both.
2. **A member read's input over the socket.** `liveRuns` takes `{ query }` and `liveRun`
   `{ runId }`; if `callableEffect`'s `parse: { onExcessProperty: "error" }` is on and a route
   still sends `subscriberId`, the call fails loudly. Good; fix the route.
3. **The hibernated connection state.** Planning decision 4: a connection stored with
   `subscription: null` before the deploy decodes as unidentified after it and every callable
   on it is refused until the tab reconnects. If this bites on staging, the alternative is a
   lenient decode for one release (`onExcessProperty: "ignore"` on the read, strict on the
   write); record which.
4. **`publishIfOk` on Delete team.** Planning decision 7 makes a `NotFound` delete silent. If
   `deleteTeam`'s `NotFound` path reconciles and a live screen could show the result (a task
   whose team pointer was nulled), the right fix is for the repair to be a `written` publish:
   return `Ok` from the repair branch, or publish in both arms with a sentence saying why.
   Record the choice and the title.
5. **The sweep row's `when`.** The sweep publishes when it deleted rows; the plan calls that
   `changed`. If the implementer finds the sweep's publish does not go through the `changed`
   signal but through its own `sweptAny` flag, the cell is still `changed` (the word is about
   the write, not the variable); say so in the prose.
6. **`isTerminalCloseEvent`'s export and partysocket's view of 3xxx.** The plan assumes
   `agents/client` exports `isTerminalCloseEvent` and that partysocket reconnects after a 3401
   close with its normal backoff. Check `refs/agents/packages/agents/src/client.ts` and
   `refs/partykit/packages/partysocket/` before deleting `reconnectAfterClose`. If partysocket
   treats 3xxx as terminal too, fall back to `shouldReconnectOnClose` (the SDK's option can veto
   but not restore a reconnect, so this only helps if the default is to reconnect) or keep the
   by-hand reconnect and record that decision 5 could not be taken as written.
7. **The router invalidation on revoke.** `onSocketClose` in both shells compares
   `event.code === Domain.CONNECTION_CLOSE_REVOKED`; with the constant at 3401 nothing changes,
   but a hard-coded `4401` anywhere (e2e, a test, a log grep) would silently stop matching.
   `grep -rn 4401 src test e2e docs/*.md` before and after.
8. **Titles that two rows shared.** After deleting rows, a title may remain in a test with a
   body that asserted scope (for example "a task verb reaches the orders index and the order's
   page, and not another order's page" asserting the other page receives nothing). The body
   must change to assert the new rule, not just the title; `checkPinned` cannot see bodies.
9. **The `nth` table index.** Moving the cycle table onto `InvalidatedMessage` means its JSDoc's
   first `|` block is the table; keep pipes out of the prose above it.
10. **`live` as a stem.** If `reservedStemHits` or the vocabulary checker refuses `live` or
    `useLiveQuery`, the fallback word is `watched` (`useWatchedQuery`); record it and change the
    row.
11. **The pipeline table's dropped column.** `parseSyncPipeline` has fixed columns; dropping
    `publish` changes the parser and its test block. If that is more churn than it saves, keep
    the column with every cell `every connection` and record it.

### Recorded during implementation

Implemented 2026-10-04 in one pass to the end state of all three phases, checked once at the end:
`pnpm typecheck`, `pnpm lint` (with `spec check`), `pnpm test` (740 passed), `pnpm test:browser`
(6 passed: five hook titles, one host title), and after `pnpm dev:reset` the four socket e2e tests
(`over the socket`, `without a reload`, `closes the shop page`, `empties their open workflows
list`) passed. Uncommitted.

- **What the plan said.** Three phases, each checked before the next.
  **What was found.** The phases' interim states (a 4401 row with a 3401 title, the old hook name
  in the parser) only exist to be undone.
  **The options.** Phase by phase; straight to the end state.
  **What was done.** Straight to the end state, one check at the end; the end state is identical.
  **Follow-up.** Nothing.
- **What the plan said.** Planning decision 7 and risk 4: Delete team under `publishIfOk`, a
  `NotFound` silent, unless its repair is something a live screen shows.
  **What was found.** The `NotFound` branch still runs `WorkflowRepository.unassignTeam`, which
  nulls `RunTask.teamId` for a team gone from D1, and reconciles; the orders index and the
  workflows list both show a run task's team.
  **The options.** Silent on `NotFound`; publish in both arms with a sentence saying why.
  **What was done.** Both arms publish, with the reason in a comment in `deleteTeam` and in the
  prose above the sites table. The configuration test now deletes the same team twice and asserts
  the `NotFound` delete publishes too.
  **Follow-up.** Nothing.
- **What the plan said.** 2.4: delete "assigning a task's team publishes to the teams before and
  after", "Attach workflow publishes the order to every team", "Cancel workflow publishes the
  order to the teams it had", and the sites rows keep titles that still hold.
  **What was found.** Those three rows would have no title, and the parser requires one.
  **What was done.** Renamed and rewritten to "assigning a task's team publishes to every
  screen", "Attach workflow publishes to every screen", "Cancel workflow publishes to every
  screen", each asserting both screens of `openTwoScreens` receive. "Sync this order publishes the
  order to every team when it changed something, …" became "Sync this order publishes when it
  changed something, and nothing when it did not".
  **Follow-up.** Nothing.
- **What the plan said.** "a task verb reaches the orders index and every order page (or fold
  into the previous)".
  **What was done.** Folded: "every connection receives every publish" opens the orders index,
  another order's page, the acting member, a teammate and a member on an idle team, and asserts
  each receives exactly one invalidation from one Mark done. The member verb row cites it.
  **Follow-up.** Nothing.
- **What the plan said.** "re-subscribing with a different query …": replace or delete.
  **What was done.** Kept as "a second read with a different query returns that query's rows":
  it proves `liveRuns` passes the browser's `query` through, which is the socket read's own job.
  **Follow-up.** Nothing.
- **What the plan said.** 1.1: no retired-list entry, since none of the words was copy.
  **What was found.** `docs/vocabulary-runbook.md` puts a retired identifier stem on
  `RESERVED_STEMS`.
  **What was done.** Added `subscribe` (catches subscriber, unsubscribe; not `SubscriptionPlan` or
  `AppSubscription`) and `scope`, with two `rules-lint.test.ts` cases. No current export carries
  either.
  **Follow-up.** An export that needs Shopify's OAuth `scope` later goes on
  `RESERVED_STEM_ALLOWED`.
- **What the plan said.** Planning decision 2: the member socket reads' final names.
  **What was done.** `liveRuns` (input `Domain.LiveRunsInput`, `{ query }`) and `liveRun` (input
  `Domain.RunIdInput`, no new shape). `ShopWorkAgent`'s `readOrders` merged into `listOrders` and
  `readOrderDetail` into `getOrderDetail`; the instrumentation line is now
  `ShopAgent.listOrders: … ms=`.
  **Follow-up.** Nothing.
- **What the plan said.** 1.3: `when` defined as `written` after a call whose result is `Ok`.
  **What was found.** Three `written` rows publish on every call (the open-orders sync's start or
  refusal and its endings, Delete team), because the call itself is the write.
  **What was done.** One sentence in the prose above the sites table names them; the cells stay
  `written`.
  **Follow-up.** Nothing.
- **Risk 6.** `agents/client` exports `isTerminalCloseEvent` (1008 and 4000–4999), and
  partysocket's `_handleClose` reconnects unless `shouldReconnectOnClose` vetoes, so 3401
  reconnects on its own; the browser test pins the predicate and the two revocation e2e tests pass
  on 3401 without `reconnectAfterClose`.
- **Risk 11.** The pipeline table's `publish` column was dropped; `parseSyncPipeline` now reads
  four columns, and its test block needed no change.
- **What the plan said.** 3.2 "the other six titles hold" and 3.4 "six hook tests and one host test".
  **What was found.** The hook file had seven titles, two of them the unsubscribe pair; five remain.
  **What was done.** Nothing; the plan miscounted. The browser project runs five hook titles and one
  host title.
  **Follow-up.** Nothing.
- **Risk 5.** The sweep publishes through its own `sweptAny` flag, not the fetch path's `changed`
  signal. The cell stays `changed` and the `when` sentence above the sites table names the sweep
  beside the two fetch paths ("and the retention sweep, which reports the rows it deleted").
- **Reviewed 2026-10-04.** Checked against the plan in three audits (object, client and checker,
  tests); no bug and no spec-code mismatch. Fixed after review: the three webhook publish tests in
  `shop-agent-sync-order.test.ts` watched the merchant socket alone and now assert both screens of
  `openTwoScreens`; "a new order refused at the ceiling publishes nothing" gained a positive control
  (a seed after the quiet window, so a dead socket cannot pass); `CALLABLE_ROLES` in
  `shop-agent-callables.test.ts` says why two merchant reads are both callable and plain RPC; three
  test comments and the shop shell's JSDoc lost the words "scope" and "all orders and all teams".
  `maxOrdersPerCycle` 100 to 2500 in `Platform.ts` is the open-orders interim and goes in with this
  change.

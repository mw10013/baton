# Publish fan-out: implementation plan

This plan carries out the decisions in `docs/publish-fan-out-research.md` (2026-10-03, one
Plannotator pass, decision 4 revised the same day). Read that doc first: "Every publish site" is
the inventory this plan changes, "What does not suppress a push, and could" is the defect list,
and Decisions holds the five calls. Nothing here is open; where this plan had to choose something
the research did not, the choice is under "Decided at planning time".

Four phases. Phase 1 is the instrumentation and goes first so the before-and-after of the other
three is on record. Phase 2 is the no-op publish rule, the largest change. Phase 3 is the order
scope on `publishToTeams`, small and independent of phase 2. Phase 4 is the client's hidden-page
deferral and touches no object code. Each phase starts at the spec text, then the code, then the
tests, and ends with a "done when". Run the checks between phases.

## Before you start

- Read `AGENTS.md` and the JSDoc on `Domain.Subscription` and `Domain.InvalidatedMessage`
  (`src/lib/domain/Platform.ts`), `publish`, `publishTo`, `syncOrderWebhook`, `syncOrder`
  (`src/lib/ShopAgent.ts`), `ShopAgentHost` and its sync pipeline table (`src/lib/agent/Host.ts`),
  `orderTeamIds`, `publishToTeams`, `readRuns`, `reconcileAllNow`, `reconcileAllIfOn`
  (`src/lib/agent/ShopWork.ts`), `fetchAndUpsertOrder` (`src/lib/agent/Orders.ts`),
  `upsertOrder` and `listOrders` (`src/lib/OrderRepository.ts`), `listOrderTeamIds` and
  `ReconcileCounts` (`src/lib/RunRepository.ts`), `Domain.syncOrder` and its tables
  (`src/lib/domain/Orders.ts`), and the module JSDoc on `useSubscribedQuery`
  (`src/lib/useSubscribedQuery.ts`). The rules that matter most here:
  - A rule is stated once, on the symbol that enforces it, with a test whose title is the rule.
    Phase 2 adds one rule to `publish`; every publish site links it rather than restating it, and
    a site that publishes without a change (phase 2 names them) says so and why.
  - A JSDoc never cites a file under `docs/`. Carry the reasoning inline.
  - `Effect.logInfo` takes one string; structured fields go in `Effect.annotateLogs`. A value in
    the message is also in the annotations. The message form is
    `<operation>: shop=<shop> key=<value>`.
  - Identifiers, JSDoc and tests speak the vocabulary. "Publish" is the object's push, "subscribe"
    the screen's read, "invalidated" the frame. Never "broadcast", "notification", "revalidate".
    The screens are "the orders index", "the order page", "the workflows list", "the member's
    workflow page". A browser tab is "a page" or "an open page"; never "tab".
  - Status, flag and role predicates are `Domain` functions, never inline comparisons in routes
    or the object. The environment gate in phase 1 is not a domain predicate; it lives beside
    `CloudflareEnv`.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- Run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check` and `scripts/rules-lint.ts`)
  and `pnpm test` after each phase. `pnpm fmt` repo-wide at the end of each phase and keep every
  file it touches.
- An untracked `test/integration/zz-count-bench.test.ts` was in the working tree when this plan
  was written. It is not this plan's; leave it alone and record it under Deviations if it fails.

## The decisions, by phase

| decision                                                              | phase |
| --------------------------------------------------------------------- | ----- |
| 4. Instrument on local and staging, not production                    | 1     |
| 1. A write that changed nothing publishes nothing, webhook path first | 2     |
| 2. `publishToTeams` names the order                                   | 3     |
| 3. Hidden browser pages defer their refetch until visible             | 4     |
| 5. Task-verb fan-out to every teammate is accepted                    | none  |

## Decided at planning time

1. **"Changed" on the webhook path is not `written`.** The research proposed publishing when
   `written` is true. `upsertOrder`'s guard is `excluded.updatedAt >= ShopOrder.updatedAt`
   (rule 7 on `Domain.syncOrder`: the same version rewrites), so a redelivered `orders/edited`
   that fetches the same version has `written: true` and a publish on `written` suppresses
   nothing the research set out to suppress. The signal is instead **the row moved or a run
   moved**: `fresh` (no row before) or `incoming.updatedAt > stored.updatedAt`, or any non-zero
   count from the reconcile the upsert ran. `syncedAt` moves on every write and is excluded on
   purpose: no screen shows it (`grep syncedAt src/routes src/components` finds nothing). The
   upsert already knows `stored` and `incoming` and already returns the reconcile's result as
   `afterWrite: Option<A>`, so this is a return-shape change, not a new read.
2. **The rule's home is `publish`, the signal's home is the repository.** `publish`'s JSDoc
   states the rule. `OrderRepository.upsertOrder` returns `changed: boolean` beside `written`.
   `RunRepository` exports `reconcileCountsChanged(counts)` beside `ReconcileCounts` (true when
   `created`, `resized` or `closed` is above zero; `multiMatch` is a state the pass left, not a
   write, and is excluded). `OrdersAgent.fetchAndUpsertOrder` returns
   `{ written, gone, changed }` where `changed` is the upsert's `changed` or the reconcile's.
3. **Phase 2 covers the webhook path and the one-order sync only.** Decision 1 says "starting
   with the webhook path". `syncOrder` (the order page's Sync this order button) runs the same
   `fetchAndUpsertOrder` and gets the same rule for free. The workflow verbs (Edit tag, Apply on
   an off workflow) keep publishing `"all"` and their JSDoc says why: Apply changes what the
   order page's Workflow select lists whether or not a run moved, and Edit tag on an off workflow
   changes the merchant's workflows index, which is loader data and does not subscribe, so that
   publish is harmless and a narrower rule would need a second signal. Both are recorded as
   follow-ups in the research doc, not done here.
4. **`listOrderTeamIds` returns the order with the teams.** Its result becomes
   `{ orderId: string | null, teamIds: readonly string[] }`; `null` when the run-shaped target
   resolves to no order (a deleted run). `orderTeamIds` in ShopWork keeps its `PublishTeams`
   contract for the existing callers through a thin map, and `publishToTeams` reads the order id
   to pass `[orderId]` as `touched`, or `"all"` when it is `null`. The webhook path, which names
   its order already, is untouched.
5. **The hidden-page deferral lives in `useSubscribedQuery`, as one more rule in its JSDoc list.**
   On a frame while `document.visibilityState === "hidden"`, the hook calls
   `invalidateQueries({ queryKey }, { refetchType: "none" })`, which marks the query stale
   without a fetch, and sets a flag. A `visibilitychange` to visible with the flag set refetches
   once (`invalidate()` as today) and clears it. The 2-second throttle is unchanged and applies
   to the visible refetch. The decision "is the page hidden" is one exported pure function,
   `pageIsHidden()`, so the test can stub `document.visibilityState` and the rule has one home.
   `useAgent`'s own `onClose` path and the identify refetch are not deferred: a reconnect is
   rare and a fresh subscription must read once.
6. **The publish log counts recipients by role.** `publishTo` returns whether it sent;
   `publish` sums merchants and members and logs one Info line
   `ShopAgent.publish: shop=<shop> merchants=<n> members=<n> touched=<all|n> teams=<all|n>`
   with the same fields annotated. `touched` and `teams` log as `all` or the array's length,
   never the ids: the ids are unbounded.
7. **The gate is one function beside `CloudflareEnv`.** `instrumentationIsOn(environment)` in
   `src/lib/CloudflareEnv.ts`, true for `"local"` and `"staging"`, false for `"production"`.
   Both new log lines and `readRuns`'s existing `ms=` line read it; `readRuns`'s line is already
   in production and this plan gates it the same way so the three lines move together. The
   `ms=` on `listOrders` goes in `readOrders` (`src/lib/agent/ShopWork.ts`), beside the
   repository call, where `readRuns` already times itself and `CloudflareEnv` is in scope.

## Phase 1: instrumentation on local and staging

### 1.1 The spec text

- `src/lib/CloudflareEnv.ts`: JSDoc on `instrumentationIsOn`: "Whether the object writes its
  timing and fan-out lines (`ShopAgent.publish`, `ShopAgent.readOrders`, `ShopAgent.readRuns`).
  On for local and staging, off for production: the lines are one per read and one per publish,
  which on a busy shop is the object's busiest log stream, and the question they answer (how
  often the subscribed screens refetch and how long each read takes) is asked on staging."
- `src/lib/ShopAgent.ts`: a paragraph on `publish`: "Logs one line per publish with how many
  merchant and member connections received the frame, under `instrumentationIsOn`. The counts,
  with `readOrders`'s and `readRuns`'s `ms=`, are how the fan-out is measured."

### 1.2 The code

- `src/lib/CloudflareEnv.ts`: export `instrumentationIsOn`.
- `src/lib/ShopAgent.ts`: `publishTo` returns `Effect<boolean>` (sent or not; the swallowed-error
  path returns `false`). `publish` collects the results with the connection's role, and when
  `instrumentationIsOn((yield* CloudflareEnv).ENVIRONMENT)` logs the line in planning decision 6. `CloudflareEnv` is in the runtime's context already (the `envLayer` in the layer factory).
- `src/lib/agent/ShopWork.ts`: `readOrders` reads `Clock.currentTimeMillis` before and after,
  and when `instrumentationIsOn(env.ENVIRONMENT)` logs
  `ShopAgent.readOrders: shop=<shop> show=<show|null> team=<set|null> q=<set|null> cursor=<set|null> rows=<n> ms=<n>`
  with the fields annotated. `readRuns`'s existing line goes under the same gate.

### 1.3 The tests

- `test/integration/shop-agent-callables.test.ts` (or a new `instrumentation.test.ts` if that
  file has no fitting describe): "instrumentationIsOn is on for local and staging and off for
  production", three assertions on the function.
- The log lines themselves are not pinned: the project pins behaviour, and a log line is not
  behaviour. Check them by eye in `logs/local-worker.log` (step 1.4).

### 1.4 Done when

- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
- `pnpm dev:start`, open the orders index and a member's workflows list, press a task verb, and
  `grep "ShopAgent.publish\|ShopAgent.readOrders\|ShopAgent.readRuns" logs/local-worker.log`
  shows all three lines with `ms=`, `merchants=` and `members=`.

## Phase 2: a write that changed nothing publishes nothing

### 2.1 The spec text

- `src/lib/ShopAgent.ts`, JSDoc on `publish`, a new first paragraph, normative: "**A publish
  follows a write that changed a stored row or a run; a call that changed nothing publishes
  nothing.** The webhook path and the one-order sync hold it through `fetchAndUpsertOrder`'s
  `changed`: the order row moved (`fresh`, or a newer `updatedAt`; never `syncedAt`, which no
  screen shows) or the reconcile created, resized or closed a run. A redelivery, or an edit
  that fetched the version already stored, writes the same row and reconciles to the same runs,
  and no subscribed screen would read anything new. The sites that publish without that signal
  say so on themselves." Then the existing paragraphs.
- `src/lib/agent/ShopWork.ts`: one sentence each on `updateWorkflowTag` and `applyDraft`:
  "Publishes whether or not the pass ran or moved a run (the rule on `publish`): Apply changes
  what the order page's Workflow select lists, and Edit tag changes which orders match, which the
  select shows as matched; neither is a run write, so there is no count to gate on."
- `src/lib/agent/Host.ts`, the sync pipeline table: the `publish` cell for "order webhook"
  becomes "the order, to the teams before and after, when the write changed something"; for "one-order sync
  (the button)" becomes "the order, when the write changed something".
- `src/lib/domain/Orders.ts`, the rules table on `syncOrder`: rule 16's screen cell already says
  a redelivery "changes nothing a screen shows"; add "and publishes nothing" to its mechanism
  cell. `pnpm spec check` parses this table, so keep the row's shape.

### 2.2 The code

- `src/lib/OrderRepository.ts`, `upsertOrder`: compute `changed` beside `fresh`:
  `fresh || (stored !== null && order.updatedAt > stored.updatedAt)`, and return it on every
  branch (`false` on the two early returns). The result type gains `readonly changed: boolean`.
- `src/lib/RunRepository.ts`: export `reconcileCountsChanged(counts: ReconcileCounts)` beside the
  interface, with the JSDoc from planning decision 2.
- `src/lib/agent/Orders.ts`, `fetchAndUpsertOrder`: the reconciler's function returns
  `ReconcileCounts` (it does: `reconcileOrder`'s result through `Effect.tap`); tighten the
  generic so `afterWrite` is `Option<ReconcileCounts>`, and return
  `{ written, gone, changed: upsert.changed || Option.exists(afterWrite, reconcileCountsChanged) }`.
  The `gone` branch returns `changed: false`.
- `src/lib/ShopAgent.ts`: the module-level `fetchAndUpsertOrder` wrapper returns
  `{ gone, changed }`. `syncOrderWebhook` publishes only when `changed`; log the skip at Info as
  `status=unchanged` so the webhook path's four outcomes (stale, order-ceiling, fetch, unchanged)
  read as one series. `syncOrder` publishes only when `changed` and returns its result as
  today. The `orderTeamIds` "before" read stays where it is: it is needed when the publish
  happens and is one indexed query when it does not.
- `src/lib/ShopAgentOrdersStream.ts`: unchanged. The stream publishes `"all"` once after it
  ends; whether a window of orders changed nothing is not knowable cheaply and the sync's
  start-to-end state change is itself a change the orders index shows.

### 2.3 The tests

- `test/integration/shop-agent-sync-order.test.ts`: "a redelivered webhook rewrites the same
  version and changes nothing a screen shows" gains the publish assertion. Open a merchant
  socket subscribed to the orders index (`test/integration/agent-socket.ts` has the helpers
  and `isInvalidated`), deliver twice, assert one `invalidated` frame, not two. If the describe
  has no socket fixture, model it on `member-runs-socket.test.ts`.
- New, same file: "a webhook that moves the order's updatedAt publishes even when no run
  moved" (a note edit on an order with no matching workflow: `changed` from the row, counts
  all zero), and "a webhook on the same version whose reconcile creates a run publishes" (turn
  a workflow on between two same-version deliveries so the second's pass creates the run; this
  is the case that proves the reconcile half of the signal, and the one that would break if
  `written` were the gate).
- `test/integration/order-repository.test.ts`: "upsertOrder reports changed for a fresh row and
  a newer updatedAt, and not for the same version" on the repository alone.
- `test/integration/run-repository.test.ts`: "reconcileCountsChanged is true for a create, a
  resize or a close and false for a multi-match alone".

### 2.4 Done when

- The checks pass, `pnpm spec check` included (the `syncOrder` table was edited).
- With `pnpm dev:start`, two identical `orders/edited` deliveries (replay the webhook from the
  Shopify admin or `curl` the route with a valid HMAC) show one `ShopAgent.publish` line and one
  `status=unchanged` line in the local log.

## Phase 3: `publishToTeams` names the order

### 3.1 The spec text

- `src/lib/agent/ShopWork.ts`, JSDoc on `publishToTeams`: "Publishes to the teams on the
  target's order and names the order as `touched`, so the orders index and that order's page
  refetch and every other order page is left alone. The one read resolves both: the order id is
  the join key the team list needs." Drop the sentence that says the run mutations' repository
  "does not report the order yet" from `publish`'s JSDoc and from `Domain.Subscription`'s
  ("or `"all"` for the bulk sync and for the run mutations, whose repository does not report the
  order yet" becomes "or `"all"` for the bulk sync and the configuration writes").
- `src/lib/RunRepository.ts`, JSDoc on `listOrderTeamIds`: the result is the order and its teams.

### 3.2 The code

- `src/lib/RunRepository.ts`, `listOrderTeamIds`: return
  `{ orderId: string | null, teamIds: readonly string[] }`. For the `orderId` target the id is
  the input; for the run-shaped targets, select it in the same statement (`r.orderId` is already
  joined) or in the `orderOf` subquery's one row; `null` when no row.
- `src/lib/agent/ShopWork.ts`: `orderTeamIds` maps the new shape to `PublishTeams` for the
  callers that want teams only (`syncOrderWebhook` through `shopWork.orderTeamIds`,
  `merchantCancelRun`, `merchantAssignRunTaskTeam`). `publishToTeams` reads the full shape and
  calls `host.publish(orderId === null ? "all" : [orderId], teams)`. Its `touched` parameter
  goes: no caller passes it.
- `src/lib/ShopAgent.ts`: `syncOrderWebhook`'s two `orderTeamIds` calls are unchanged in
  behaviour.

### 3.3 The tests

- `test/integration/member-runs-socket.test.ts`: new "a task verb reaches the orders index and
  the order's page, and not another order's page": two merchant sockets subscribed through
  `subscribeOrder` to two orders, one member completes a task on the first; assert the first
  receives `invalidated` and the second does not, and an index socket receives it.
- `test/integration/run-repository.test.ts`: "listOrderTeamIds names the order for a task, a
  run and an order target, and null for a deleted run".
- The existing "pushes a completed task to the team, and not to a team with no work on that
  order" keeps passing unchanged.

### 3.4 Done when

- The checks pass, and the new socket test is green on `pnpm test`.

## Phase 4: hidden pages defer their refetch

### 4.1 The spec text

- `src/lib/useSubscribedQuery.ts`, module JSDoc, a fourth bullet after "Published invalidations
  refetch, throttled": "**A hidden page defers.** A frame arriving while
  `document.visibilityState` is `"hidden"` marks the query stale without a fetch
  (`refetchType: "none"`) and sets a flag; the first `visibilitychange` to visible refetches once
  and clears it. A merchant's background orders index would otherwise run the counts statement
  on every webhook the shop receives, for a screen nobody is looking at. The identify refetch is
  not deferred: a fresh subscription must read once, and a reconnect is rare. `pageIsHidden` is
  the one definition of hidden."
- `src/lib/Screen.ts` is not touched: no copy changes.

### 4.2 The code

- `src/lib/useSubscribedQuery.ts`: export `pageIsHidden = () => typeof document !== "undefined"
&& document.visibilityState === "hidden"`. In the message effect, `onMessage` checks it before
  the throttle: hidden → `invalidate({ refetchType: "none" })` (extend `invalidate`'s options
  type) and `deferred = true`. Add a `visibilitychange` listener in the same effect: visible and
  `deferred` → `deferred = false; onMessage`-equivalent through the throttle (`invalidate()` or
  `pending = true`). Clean both listeners up together. Keep one effect: the throttle state and
  the deferral flag belong to the same subscription window.
- `src/lib/ShopAgentSocketHost.tsx`: unchanged. Its `visibilitychange` listener is the
  watchdog's; the two concerns stay in their own effects, as its JSDoc requires.

### 4.3 The tests

- `test/browser/` has a vitest browser project with a smoke test only. Add
  `test/browser/use-subscribed-query.test.tsx`: render the hook with a stub `ShopAgentProvider`
  value whose `agent` is an `EventTarget` with a `stub.subscribe` spy and `identified: true`,
  stub `document.visibilityState` with `Object.defineProperty` (configurable), dispatch a
  `message` event carrying `{"type":"invalidated"}`, and assert: hidden → the spy is not called
  again; dispatch `visibilitychange` after flipping to visible → called once. Title: "a hidden
  page defers its refetch to the next visibilitychange". If `test/browser/vitest.config.ts`
  cannot render React with the project's providers in reasonable time, pin `pageIsHidden` alone
  in a node test and record the gap under Deviations.
- E2E: none. Playwright has no visibility emulation that reaches `document.visibilityState`
  without an init script, and the browser test is the stronger pin.

### 4.4 Done when

- The checks pass, the browser test is green.
- By hand with `pnpm dev:start`: open the orders index, switch to another browser page, trigger
  a webhook or a task verb, and `logs/local-worker.log` shows the publish but no `readOrders`
  line until the index is foregrounded, then exactly one.

## After the phases

- Update `docs/publish-fan-out-research.md`'s "What does not suppress a push, and could": items
  1, 3 and 5 are done; item 2's workflow-verb half is recorded as a follow-up with planning
  decision 3's reasoning.
- `pnpm fmt` repo-wide; keep every file it touches.
- Do not commit. Report the test count and the two by-hand checks (phases 2.4 and 4.4) with
  their log lines.

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

1. **`afterWrite`'s generic.** `upsertOrder` is generic in `A` for its `afterWrite` effect. If
   tightening `fetchAndUpsertOrder` to `ReconcileCounts` ripples into the stream
   (`ShopAgentOrdersStream.ts` passes the same reconciler), keep the repository generic and
   narrow only in `OrdersAgent`.
2. **`updatedAt` equality on a real edit.** Shopify bumps `updated_at` on every order save, so a
   same-version fetch means no change. If a fixture or a real shop shows a line-item change with
   an unchanged `updatedAt`, the signal is wrong and the entry must say what moved; the fallback
   is comparing the stored items to the incoming ones, which is a read the plan avoided.
3. **`CloudflareEnv` inside `publish`.** `publish` is called from `Effect`s that run under the
   object's runtime, which provides the env layer. If a call path (a `@callable()` wrapper, or
   the Agents SDK's `onWorkflowComplete`) reaches `publish` without it, the type error says so;
   pass `env.ENVIRONMENT` into the host at construction instead and record it.
4. **The redelivery test's socket.** `shop-agent-sync-order.test.ts` may have no socket fixture.
   Borrowing `member-runs-socket.test.ts`'s is the plan; if the two files' layers conflict, write
   the publish assertion in `member-runs-socket.test.ts` and leave the sync test as is.
5. **`refetchType: "none"` under `staleTime: Infinity`.** TanStack Query marks the query
   invalidated; the later `invalidate()` on visibility must fetch even though the data is
   "fresh" by staleTime. `invalidateQueries` with the default `refetchType: "active"` does. If it
   does not, call `refetchQueries` and record it.
6. **`pnpm spec check` on the `syncOrder` table.** The rule 16 edit must keep the row's cells
   parseable; if the checker refuses a word, use the vocabulary's and record which.
7. **The untracked bench test.** `test/integration/zz-count-bench.test.ts` is not this plan's.
   If `pnpm test` fails on it, record the failure and leave the file.

### Recorded during implementation

- **What the plan said.** 1.2: `publish` logs "when
  `instrumentationIsOn((yield* CloudflareEnv).ENVIRONMENT)`".
  **What was found.** `publish` is a class method whose effect the host types as
  `Effect<void>` with no requirements; yielding `CloudflareEnv` would put it in the host's
  type and every caller's. The class already holds `this.env`.
  **The options.** Yield the service and widen `ShopAgentHost.publish`; pass the environment
  into the host at construction (risk 3's fallback); read `this.env.ENVIRONMENT` in the class.
  **What was done.** `this.env.ENVIRONMENT`: same value, no type change.
  **Follow-up.** Nothing.

- **What the plan said.** 2.3: the reconcile-half test turns "a workflow on between two
  same-version deliveries".
  **What was found.** `setWorkflowOn` runs `reconcileAllIfOn`, which creates the run itself, so
  the second delivery's reconcile finds nothing to do.
  **The options.** Write the workflow on in SQL behind the object's back; change the item's
  product tags between two same-version deliveries.
  **What was done.** The tags: the workflow is on throughout, the first delivery carries
  `plain`, the second `engraved` at the same `updatedAt`, and the second's reconcile creates
  the run. Same title, same half of the signal proven.
  **Follow-up.** Nothing.

- **What the plan said.** 2.1: add "and publishes nothing" to rule 16's "mechanism cell".
  **What was found.** The rules table on `syncOrder` has two columns, `rule` and `where`; there
  is no mechanism cell.
  **What was done.** "and publishes nothing" went into the rule cell; `where` is unchanged.
  **Follow-up.** Nothing.

- **What the plan said.** Planning decision 5 and 4.2: `invalidateQueries({ queryKey }, {
refetchType: "none" })`, extending `invalidate`'s options type.
  **What was found.** `refetchType` is a field of the filters (`InvalidateQueryFilters`,
  `refs/tan-query/packages/query-core/src/types.ts`), not of the options.
  **What was done.** A local `markStale` callback calls
  `invalidateQueries({ queryKey, refetchType: "none" })`; `invalidate`'s signature, which the
  hook returns to callers, is unchanged. Risk 5 did not bite: the later `invalidate()` fetches
  (the browser test pins it).
  **Follow-up.** Nothing.

- **What the plan said.** 3.2: `listOrderTeamIds` selects the order "in the same statement or
  in the `orderOf` subquery's one row".
  **What was done.** One statement: `with o(orderId) as (<orderOf>) select distinct o.orderId,
rs.teamId from o left join Run ... left join RunTask ...`. An order with no assigned task
  answers one row with a null team; a gone run answers no row, so `orderId: null`.
  `ShopWork.ts` gained `orderAndTeamIds` beside `orderTeamIds`, which now maps it.
  **Follow-up.** Nothing.

- **What the plan said.** 2.4: two identical deliveries show one publish and one
  `status=unchanged`.
  **What was found.** The dev store's order `gid://shopify/Order/7838387568777` was already
  stored at Shopify's current version, so both replayed deliveries were unchanged.
  **What was done.** Recorded the lines as they came (`written=true changed=false`, then
  `status=unchanged`, twice, no `ShopAgent.publish`). The one-publish-then-silence case is
  pinned by "a redelivered webhook rewrites the same version and changes nothing a screen
  shows".
  **Follow-up.** Nothing.

- **What the plan said.** 4.4: check the hidden-page deferral by hand.
  **What was found.** The orders index runs in the Shopify admin's cross-origin app frame, and
  headless Playwright cannot background a page; an init script did not reach that frame.
  **What was done.** A throwaway E2E spec (deleted afterwards) opened the orders index with
  the `setup` project's admin session, set `document.visibilityState` inside the app frame,
  re-seeded the shop to cause a publish, and read the local log by byte offset. Twice over:
  while hidden, `ShopAgent.publish: … merchants=1 members=0 touched=all teams=all` and no
  `ShopAgent.readOrders`; after the flip to visible, exactly one
  `ShopAgent.readOrders: … rows=25 ms=4`. The browser test "a hidden page defers its refetch
  to the next visibilitychange" pins the same rule. Its first run needed
  `pnpm exec playwright install --only-shell chromium`: the headless shell vitest's browser
  provider launches was missing from the local Playwright cache.
  **Follow-up.** Nothing.

- **What the plan said.** "Before you start": an untracked
  `test/integration/zz-count-bench.test.ts`.
  **What was found.** Not in the working tree.
  **Follow-up.** Nothing.

- **What the plan said.** Planning decision 5 and 4.2: the hidden-page deferral is the hook's
  `visibilitychange` listener, and the later `invalidate()` fetches once.
  **What was found.** (Review, 2026-10-03.) `useQuery`'s `refetchOnWindowFocus` default is
  true. A deferred frame leaves the query invalidated, which `isStaleByTime` treats as stale,
  so TanStack Query's focus manager also refetched on the same `visibilitychange`, outside the
  throttle. One fetch resulted only because the document listener fires before the window one
  and the focus path passes `cancelRefetch: false`; with the throttle holding, two. The browser
  test and the by-hand check dispatched a non-bubbling event on `document`, which the focus
  manager's window listener never saw.
  **What was done.** `refetchOnWindowFocus: false` and `refetchOnReconnect: false` on the
  query, a sentence in the hook's JSDoc, and the test's event now bubbles.
  **Follow-up.** Nothing.

- **What the plan said.** 4.2: "The 2-second throttle is unchanged."
  **What was found.** (Review, 2026-10-03.) A frame inside the throttle window set `pending`,
  and the window's trailing `invalidate()` ran whether or not the page had since been hidden.
  **What was done.** The trailing path checks `pageIsHidden` and defers like a fresh frame.
  Pinned by "a throttled frame whose window elapses while hidden defers".
  **Follow-up.** Nothing.

- **What the plan said.** 4.4: "the browser test is green on `pnpm test`".
  **What was found.** `pnpm test` runs `test/integration/vitest.config.ts` only; the browser
  project is `pnpm test:browser`, which AGENTS.md does not list.
  **What was done.** Folded in (2026-10-04): the root `vitest.config.ts` lists both projects
  as inline `extends` entries (a file entry is rooted at its own directory, which breaks the
  Start plugin's entry resolution), the projects are named `integration` and `browser`, the
  empty smoke test and an unreferenced `cloudflare:*` stub under `test/browser/` are gone, and
  AGENTS.md lists `pnpm test:browser`. `pnpm test` is 33 files, 705 tests.
  **Follow-up.** Nothing.

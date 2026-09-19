# Rules inventory

Phase 0 output of `docs/rules-in-source-plan.md`. Built from source only.
Line numbers are as of 2026-09-19 before Phase 1 and drift after it.

## 0.1 Concepts

| concept                                  | symbol                                | values                                                                                   | cross-site rules?                                                                                                                    |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| RunStatus                                | `Domain.RunStatus`                    | pending, active, done, cancelled                                                         | yes, 40 sites                                                                                                                        |
| RunFlag                                  | `Domain.RunFlag`                      | item_removed, quantity_changed, order_cancelled, order_deleted, blocked, order_fulfilled | yes, 16 `=== "blocked"` sites plus `flag !== null` in 6 files                                                                        |
| ProductionState                          | `Domain.ProductionState`              | no_workflow, multiple_workflows, in_production, ready_to_ship, shipped, cancelled        | yes: computed by `Domain.productionState`, restated as SQL in `OrderRepository.listOrders`, read by `app.orders.index.tsx` (9 sites) |
| UserRole                                 | `Domain.UserRole`                     | user, admin                                                                              | yes, 4 sites: `worker.ts:362`, `AdminServerFnMiddleware.ts:26`, `MemberServerFnMiddleware.ts:35`, `login-callback.tsx:31`            |
| ConnectionRole                           | `Domain.ConnectionRole`               | merchant, member                                                                         | yes, 3 sites in `ShopAgent.ts` (288, 1211, 1244)                                                                                     |
| Actor role                               | `Domain.Actor` union discriminant     | merchant, member                                                                         | yes, 5 sites: `WorkflowRunRepository.ts:210`, `Domain.ts:2158`, `app.orders.$orderId.tsx:226-228`, `shop.$shop.index.tsx:252,340`    |
| BulkOperationStatus                      | `Domain.BulkOperationStatus`          | Shopify's enum                                                                           | one site, `OrdersSyncWorkflow.ts:136`. Not cross-site                                                                                |
| PlanHandle / Plan                        | `Domain.PlanHandle`, `Domain.Plan`    | baton-basic/baton-pro, basic/pro                                                         | not in census; no `=== "` reader outside Domain                                                                                      |
| StepDirection                            | `Domain.StepDirection`                | up, down                                                                                 | single reader                                                                                                                        |
| OrderSyncSource / OrderSyncField         | `Domain.*`                            | webhook/bulk/manual, created_at/updated_at                                               | not cross-site                                                                                                                       |
| RunSource                                | `Domain.RunSource`                    | tag, manual                                                                              | no reader branches on it                                                                                                             |
| QueueTier / QueueTab                     | `Domain.QueueTier`, `Domain.QueueTab` | see symbol                                                                               | rule is `Domain.tierOf`, already a function with a test                                                                              |
| OrdersCursor, OrderSearch, StepNote, ids | branded                               |                                                                                          | rules are on the schema checks; single site each                                                                                     |

## 0.2 Rules per concept

### RunStatus

Enforcing layer: `WorkflowRunRepository` (`isTerminal` at 201, inline checks at 1472, 1493, 1664), `ShopAgent.isOpen` at 1088, `Domain.ambiguousItems` / `Domain.runCounts`.

| rule                                                                                          | enforcing symbol                                                                                                                              | readers                                                                                                       | test?                                                                     | first-principles                                                                           |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Start, Done, note, Block, team assignment are allowed only on an open run (pending or active) | `requireActionable` (repo 667), `blockRun` (1840), `assignRunStepTeam`                                                                        | work page 193-195, 210, 219; orders page 308, 439, 777, 992; ShopAgent 1088, 1111, 3877, 3901; reconcile 1230 | repo tests: completeStep on cancelled is Terminal, cancelRun refuses done | Q-2 (note on done), Q-3 (block on done)                                                    |
| Cancel is allowed only on an open run                                                         | `cancelRun` 1472                                                                                                                              | orders page 1141-1200 (`open &&`)                                                                             | yes, repo 1387                                                            | ok                                                                                         |
| Undo is allowed on any run but a cancelled one                                                | `uncompleteStep` 1664                                                                                                                         | work page 205, index Done tier, orders page Reopen                                                            | repo tests for uncompleteStep; member-area e2e                            | ok                                                                                         |
| Un-cancel is allowed only on a cancelled run                                                  | `uncancelRun` 1493                                                                                                                            | orders page 1233 (`cancelled` shows Undo cancel)                                                              | yes                                                                       | ok                                                                                         |
| A line item's live run is any run but cancelled; at most one exists                           | `WorkflowRun_live_item_uidx` (ShopAgent 548), `setRun` 1374, `uncancelRun` 1500, reconcile 1117 `status <> 'cancelled'`, `countWaitingOrders` | `Domain.ambiguousItems` 1717, orders page 788, 1296                                                           | repo tests for setRun and uncancel busy                                   | ok. See 0.3 R-1                                                                            |
| Run counts: open = pending or active, done = done; flagged and blocked count only open runs   | `Domain.runCounts` 1725-1732, restated as SQL in `OrderRepository`                                                                            | orders page 790 (`made` = every live run done)                                                                | domain test "counts open, done…"                                          | ok                                                                                         |
| Reconcile adjusts only open runs; a cancelled run keeps its key                               | reconcile 1117, 1230                                                                                                                          |                                                                                                               | repo reconcile tests                                                      | ok                                                                                         |
| Shop live-run ceiling counts pending and active                                               | `liveRunCount` 925                                                                                                                            |                                                                                                               | repo tests                                                                | ok. `done` is live for the item index but not for the ceiling: two meanings of "live". Q-5 |
| A done run cannot have its workflow changed from the order page                               | orders page 1312 (`changeable`)                                                                                                               |                                                                                                               | none                                                                      | Q-6: server allows it (setRun cancels done incumbent). Page-only gate                      |
| `RunTerminalError` on the order page reads "already finished"                                 | orders page 71                                                                                                                                |                                                                                                               |                                                                           | Q-1 amended                                                                                |

### RunFlag

| rule                                                                             | enforcing symbol                                             | readers            | test?                  | first-principles                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| A flag stops Start, Done and Undo, not the note                                  | work page 219-224 only (server does not check)               | work page          | none                   | Q-7: server-side `startStep` / `completeStep` accept a flagged run. Page-only gate                      |
| `blocked` is the only flag a person sets; reconcile flags overwrite it           | `blockRun` 1846, `flagActive`                                |                    | repo tests             | ok                                                                                                      |
| A blocked run contributes nothing to `waitingOn` and shows no Now line           | `OrderRow.waitingOn` (OrderRepository), orders page 383, 795 |                    | order-repository tests | ok                                                                                                      |
| `flagged` versus `blocked` counts are disjoint, both only on open runs           | `Domain.runCounts`                                           | index              | domain test            | ok                                                                                                      |
| Unblock wording for `blocked`, Dismiss for reconcile flags                       | work page 404, index 355, 501, orders page 1165              |                    | none                   | ok, wording rule with four copies                                                                       |
| Block reason is editable only while flag is blocked                              | `setBlockReason` 1896                                        | work page 382, 406 | repo test              | ok                                                                                                      |
| Reconcile flags only active runs; pending are cancelled silently, done untouched | `flagActive`, `cancelPending`                                |                    | repo tests 1144, 1488  | Q-4                                                                                                     |
| Dismiss needs a ready step on the member's team, merchant always                 | `dismissFlag` via `requireReadyTeam`                         |                    |                        | ok; note it does not check the run is open. A member cannot reach a done run's flag (no ready step). ok |

### ProductionState

Rule is `Domain.productionState`, tested in `domain.test.ts` "Domain.productionState". The SQL in `OrderRepository.listOrders` restates it. Readers in `app.orders.index.tsx` switch on the value for labels and filters, not for rules. Phase 2 work: table on the symbol pointing at the function; confirm the SQL restatement is pinned by an order-repository test that compares it with the function.

### UserRole

Rule: `admin` lands on and may call `/app`; everyone else is a member on `/shop`. Four inline sites. Phase 2: `Domain.userIsAdmin` and a table on the symbol.

### ConnectionRole and Actor role

`ShopAgent` discriminates the connection state union; `Domain.actorLabel`, `actorColumns`, `sameActor`, the index's "you" all discriminate the actor union. These are type narrowing on a union discriminant rather than rules, except `sameActor` and the "you" test, which is one rule ("same person means same email for members, and merchant is one person") stated twice. Phase 2: `Domain.sameActor`.

## 0.3 Relationship rules

| id  | rule                                                                                                                                             | enforcing                                                                                            | readers                                                                                                                       | test?      | note                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| R-1 | One live run per line item, live meaning not cancelled                                                                                           | `WorkflowRun_live_item_uidx` (ShopAgent 548), `setRun`, `uncancelRun`, `insertRun` conflict handling | `Domain.ambiguousItems`, orders page                                                                                          | yes        | JSDoc on `WorkflowRun` states it and names the index. ok                                        |
| R-2 | Run status is derived from steps: all done is done, any started or done is active, else pending; cancelled is the one value steps cannot produce | `recomputeStatus` 893                                                                                | `RunStatus` JSDoc                                                                                                             | repo tests | ok                                                                                              |
| R-3 | A step is ready when open and nothing in an earlier stage is open                                                                                | `readyWhere.ts`                                                                                      | queue, every step guard, OrderRepository waiting-on, `ShopAgent.seedReadySteps`, orders page `readySteps` and `attentionRows` | yes        | Three TypeScript restatements exist: orders page 305-313, orders page 1002, ShopAgent 1111. Q-8 |
| R-4 | Undo is blocked by the first started step in a later stage                                                                                       | `Domain.undoBlockedBy`                                                                               | repo, queue Done tier, orders page                                                                                            | repo tests | ok                                                                                              |
| R-5 | A completed step's team is frozen                                                                                                                | `assignRunStepTeam` (`StepFinishedError`)                                                            | orders page (`open && assignTeam`)                                                                                            | repo test  | ok                                                                                              |
| R-6 | Reconcile on cancelled, fulfilled, deleted order: cancel pending, flag active, leave done                                                        | `reconcileOrder`, `markOrderDeleted`                                                                 |                                                                                                                               | yes        | Q-4                                                                                             |
| R-7 | Auto-start yields to the live-run ceiling; manual attach fails at it                                                                             | `reconcileOrder` 1184, `setRun` 1412                                                                 |                                                                                                                               | repo tests | ok                                                                                              |
| R-8 | A member may act on a step only when its team is among theirs and it is assigned; the merchant always may                                        | `requireActionable`, `requireReadyTeam`                                                              | work page `mine`                                                                                                              | repo tests | ok                                                                                              |

## 0.4 Inline predicate census (baseline)

`grep -rn -E "\.(status|flag|state|role) (===|!==) \"" src | grep -v routeTree`

| file                                                                                                                        | sites  |
| --------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/routes/app.orders.$orderId.tsx`                                                                                        | 23     |
| `src/lib/WorkflowRunRepository.ts`                                                                                          | 10     |
| `src/routes/shop.$shop.work.$runId.tsx`                                                                                     | 7      |
| `src/lib/Domain.ts`                                                                                                         | 6      |
| `src/routes/shop.$shop.index.tsx`                                                                                           | 4      |
| `src/lib/ShopAgent.ts`                                                                                                      | 4      |
| `src/worker.ts`, `login-callback.tsx`, `OrdersSyncWorkflow.ts`, `MemberServerFnMiddleware.ts`, `AdminServerFnMiddleware.ts` | 1 each |
| total                                                                                                                       | 59     |

By field: status 30, flag 17, role 12. `state` matches none (the `state.role` sites count under role).

## Questions log

```
Q-1  concept=RunStatus  rule="The order page's Terminal message names the refusal"
  evidence: app.orders.$orderId.tsx:71; Domain.RunResult Terminal carries no status
  first-principles: the plan assumed Terminal is reachable only from Reopen on a
    cancelled run. It is also reachable from Note on a done run: Manage renders
    for done runs (1265 hides it only when cancelled) and the Note button (1029)
    is unconditional, so setStepNote -> requireActionable -> Terminal. There
    "already finished" is right and "was cancelled" would be wrong. Block on a
    done run is hidden (open gate at 1142), Cancel likewise.
  options: (a) carry the status in RunResult.Terminal and phrase both;
    (b) answer Q-2 so notes on done runs are allowed, leaving Reopen-on-cancelled
    as the only path and the planned wording correct; (c) hide Note on done
    runs, which loses the merchant's after-the-fact note.
  recommendation: (b). Answer Q-2 by allowing notes on done runs; then
    Reopen on a cancelled run is the only path to Terminal and the message
    becomes "That workflow run was cancelled." No new result shape needed.
  status: answered(2026-09-19): (b). Notes allowed on done runs; Terminal on the order page now reads "That workflow run was cancelled."

Q-2  concept=RunStatus  rule="setStepNote refuses a done run"
  evidence: WorkflowRunRepository.ts:462, requireActionable 677
  first-principles: a worker or merchant who notices something after the last
    Done cannot write it down without undoing the step first. The merchant
    Manage drawer offers the button anyway (Q-1).
  options: (a) note gate is runIsLive, so done runs take notes;
    (b) keep and hide the button on the order page for done runs.
  recommendation: (a). Change setStepNote's gate to runIsLive. A note is a
    record, not work; refusing it on a done run forces a fake Undo to write
    one down. Small write change, one repository test, the RunStatus table
    row moves from runIsOpen to runIsLive, stepActions.note follows.
  status: answered(2026-09-19): (a). setStepNote gate is runIsLive; stepActions.note follows; repository test extended.

Q-3  concept=RunStatus  rule="blockRun needs a ready step of the member's team"
  evidence: blockRun 1840-1842
  first-principles: on a done run there is no ready step, so a member cannot
    block it; the merchant can reopen then block. Coherent with "a flag stops
    work" since there is no work on a done run.
  options: keep and document.
  recommendation: keep. Block means "stop the work" and a done run has none.
    Document on blockRun; no code change.
  status: answered(2026-09-19): keep; documented on the RunStatus table (Block needs runIsOpen and a ready step).

Q-4  concept=RunFlag  rule="order_fulfilled cancels pending runs and flags active ones"
  evidence: reconcileOrder 1090-1107, test 1144
  first-principles: a pending run whose order shipped is cancelled with no
    flag to show why; the order page shows Cancelled beside a shipped order,
    which is readable. Same shape for order_cancelled and order_deleted.
  options: (a) keep; (b) cancel with a flag, which needs flag on cancelled runs
    to render and the runCounts rule to ignore them.
  recommendation: keep. A cancelled run beside a shipped, cancelled or deleted
    order reads correctly on the order page, and nobody had started it. Adding
    flags to cancelled runs would touch runCounts, the queue and three pages
    for a marker no one acts on. Document on RunFlag.
  status: answered(2026-09-19): keep; documented on the RunFlag table.

Q-5  concept=RunStatus  rule="live has two meanings"
  evidence: WorkflowRun_live_item_uidx and runIsLive (not cancelled) versus
    liveRunCount / ShopLimits.maxLiveRuns / WorkflowRunLimitError (pending or
    active)
  first-principles: the item index needs done to be live so a finished item
    is not rerouted; the ceiling needs done to be free so finished work does
    not count against capacity. Two rules, one word.
  options: rename the ceiling's notion to "open" in JSDoc and errors
    (`maxOpenRuns`) or document the split on RunStatus.
  recommendation: document only, done in Phase 1 (the RunStatus table says
    "live" and "open" are two rules). Renaming maxLiveRuns and
    WorkflowRunLimitError to "open" is correct but is an API rename across
    the object, the banner and tests; do it as its own change if wanted.
  status: answered(2026-09-19): rename. maxOpenRuns, openRunCount, releaseOpenRunLimit, openRunsLimitedAt (ShopAgent migration 2 renames the column), banner and admin label say "open".
    are not behaviour-preserving in the API surface and wait.

Q-6  concept=RunStatus  rule="a done run's workflow cannot be changed"
  evidence: app.orders.$orderId.tsx:1309-1312; setRun 1374 cancels any
    non-cancelled incumbent, including done
  first-principles: the page says changing a done run would rewrite history;
    the server allows it. A page-only gate is the shape the plan says to avoid.
  options: (a) move the gate into setRun (refuse when the incumbent is done);
    (b) keep page-only and document why on the write.
  recommendation: (a). Move the gate into setRun: refuse when the live
    incumbent is done, with a new RunDoneError the page phrases. The page
    already hides the control, so nothing visible changes; the rule stops
    being page-only, which is the whole point of this work.
  status: answered(2026-09-19): (a). setRun refuses a done incumbent with RunFinishedError; AttachResult.ItemDone; page message added.

Q-7  concept=RunFlag  rule="a flag stops Start, Done and Undo"
  evidence: work page 219-224; startStep/completeStep/uncompleteStep do not
    read run.flag
  first-principles: a worker on the queue's Done tier can Undo a flagged run's
    step (index Done tier checks undoBlockedBy only). A merchant can Reopen a
    flagged run. Only the work page hides the buttons.
  options: (a) enforce on the write with a RunFlaggedError; (b) keep as a
    page rule and say so on stepActions.
  recommendation: (a) for Start and Done, keep Undo. Enforce "a flag stops
    Start and Done" on the write with a RunFlaggedError, so a stale queue
    cannot complete a held step. Leave Undo allowed on a flagged run
    everywhere and drop the flag from stepActions.undo, which makes the work
    page match the Done tier and the merchant's Reopen. Undo takes work back;
    a hold is no reason to refuse that.
  status: answered(2026-09-19): (a) for Start and Done, Undo keeps working. RunFlaggedError on startStep/completeStep; RunResult.Flagged; stepActions.undo ignores the flag; the Done tier renders from stepActions; the merchant Mark done is hidden while flagged (D-6).
    the gate is the page's.

Q-8  concept=readiness  rule="a step is ready when open and no earlier stage is open"
  evidence: readyWhere.ts; restated in app.orders.$orderId.tsx:305-313 and
    1002-1003, ShopAgent.ts:1111-1118 (seedReadySteps)
  first-principles: one SQL definition and three TypeScript copies.
  options: a `Domain.readySteps(run, steps)` predicate used by all three;
    readyWhere.ts JSDoc links it and a test pins the two agree.
  recommendation: yes, in Phase 3. Add Domain.readySteps(run, steps) and
    Domain.stepIsReady; replace the three TypeScript copies; a test pins that
    the SQL and the function agree on a seeded run.
  status: answered(2026-09-19): yes. Domain.readySteps and Domain.lowestOpenStage replace the three copies; readyWhere.ts links them; domain test pins the rule.
```

```
Q-9  concept=RunStatus  rule="assign a step's team is allowed on an open step"
  evidence: assignRunStepTeam checks step.completedAt only; the order page
    offers the picker only under runIsOpen (attentionRows, manageRows)
  first-principles: the write accepts an open step on a cancelled run. Nothing
    reaches it (the page hides the picker), so it is a latent gap, not a bug a
    merchant meets. The RunStatus table records the two gates as they are.
  options: (a) add !runIsOpen -> RunTerminalError to the write; (b) keep.
  recommendation: (a). Add !runIsOpen -> RunTerminalError to
    assignRunStepTeam. One line, one test, and the table row stops needing a
    footnote.
  status: answered(2026-09-19): (a). assignRunStepTeam refuses a run that is not open (RunTerminalError, AssignRunStepTeamResult.RunNotOpen); the step-finished check runs first so a done run still reads "keeps its team".
```

## Deviations and issues

```
D-0  phase=1.5  2026-09-19
  planned: Terminal wording changes to "was cancelled"
  found: Terminal is also reached from Note on a done run, see Q-1
  did: applied with Q-2 (a), 2026-09-19
  behaviour change: yes, wording only
  recommendation: accept Q-1 (b) and Q-2 (a) together, then apply the
    wording change in Phase 2 alongside the setStepNote gate change.

D-1  phase=1.2  2026-09-19
  planned: OrdersSyncWorkflow.ts has one RunStatus site
  found: the site is `operation.status === "COMPLETED"`, a
    BulkOperationStatus, not a RunStatus
  did: Phase 2 added Domain.bulkOperationCompleted for it
  behaviour change: no
  recommendation: accept. BulkOperationStatus is a one-site concept; Phase 2
    gives it a bulkOperationIsComplete predicate or leaves it, since the plan
    only requires predicates for cross-site rules.

D-2  phase=1.3  2026-09-19
  planned: the queue's Done tier renders Undo from stepActions
  found: stepActions carries the work page's flag rule; the Done tier has never
    hidden Undo behind the flag (Q-7), so using it would change behaviour
  did: Done tier keeps reading undoBlockedBy, with a JSDoc saying why it
    differs and pointing at stepActions. Superseded in Phase 2: with Q-7
    answered, stepActions.undo ignores the flag and the tier renders from it.
  behaviour change: no
  recommendation: accept, and resolve through Q-7: once Undo ignores the flag
    in stepActions, the Done tier can render from it with no behaviour change.

D-3  phase=1.4  2026-09-19
  planned: add "cancelRun refuses a done run" if absent
  found: the assertion exists inside the repository test that walks a run to
    done (workflow-run-repository.test.ts, "cancelRun" block near line 1387)
    under a broader title
  did: left as is
  behaviour change: no
  recommendation: accept. Optionally split the assertion into its own
    it("cancelRun refuses a done run") in Phase 3 so the title is the rule.

D-4  phase=1.5  2026-09-19
  planned: replace every status site on the order page
  found: `run.status === "done"` sites have no predicate of their own; they
    are "live and not open"
  did: nowLine's done branch became !runIsOpen (after the runIsLive return),
    orderSummary's made test became every live run !runIsOpen, changeable
    became runIsOpen(live.run). Same truth table.
  behaviour change: no
  recommendation: accept. If "done" needs naming later, add runIsDone
    (runIsLive && !runIsOpen) rather than a third status comparison.

D-5  phase=1.6  2026-09-19
  planned: manual check of Undo on a done run's work page
  found: the check is reproducible from the member e2e fixtures
  did: added it as an e2e test so the rule stays pinned
  behaviour change: no
  recommendation: accept; the test replaces the manual step for good.
```

```
D-6  phase=2  2026-09-19
  planned: Q-7 (a): refuse Start and Done on a flagged run at the write
  found: the merchant's Manage drawer offered Mark done on a flagged run and
    would now be refused with a message
  did: hid Mark done while the run is flagged (Domain.runIsFlagged), with a
    Flagged message for the race; Unblock or Dismiss on the run row is the way on
  behaviour change: yes. Merchant: Mark done is gone while a run is flagged.
    Worker: none visible (the work page already hid the buttons); the queue's
    Done tier is unchanged since Undo still ignores the flag.

D-7  phase=2  2026-09-19
  planned: rename "live" to "open" for the ceiling (Q-5)
  found: liveRunsLimitedAt is a column in the Durable Object's SQLite
  did: renamed the column in the initial schema; no second migration, the
    project is still prototyping and every database is reset from scratch
  behaviour change: no (existing local databases must be reset)

D-8  phase=2  2026-09-19
  planned: the census lint covers status, flag, state, role
  found: `role` sites left after Phase 2 are union narrowing (actorColumns,
    ShopAgent's connection state), not rules; `state` never matched
  did: scripts/rules-lint.ts matches `.status`/`.flag` against any literal
    and `.role` against "admin" only
  behaviour change: no
```

## Progress

- Phase 0: done 2026-09-19.
- Phase 1: done 2026-09-19 (unit and e2e green; D-5 e2e test pins Undo on a done run).
- Phase 2: done 2026-09-19. Q-1 to Q-9 answered and applied. Predicates:
  runIsOpen, runIsLive, runIsUnstarted, runIsFlagged, runIsBlocked,
  flagIsReconcile, userIsAdmin, actorIsMember, sameActor,
  bulkOperationCompleted, stepActions. Tables on RunStatus, RunFlag; pointer
  paragraphs on ProductionState, UserRole, BulkOperationStatus.
- Phase 3: done 2026-09-19. Domain.readySteps / lowestOpenStage replace three
  copies (order page twice, ShopAgent seeder); readyWhere.ts links them.
- Phase 4: done 2026-09-19. scripts/rules-lint.ts runs under `pnpm lint`;
  AGENTS.md bullet replaced.
- Verification after Phase 4: typecheck, lint, 348 unit tests green; e2e
  41 passed.

## Census

| file                                    | baseline | after Phase 1 | after Phase 4              |
| --------------------------------------- | -------- | ------------- | -------------------------- |
| `src/routes/app.orders.$orderId.tsx`    | 23       | 13            | 0                          |
| `src/lib/WorkflowRunRepository.ts`      | 10       | 4             | 0 (1 actor narrowing)      |
| `src/routes/shop.$shop.work.$runId.tsx` | 7        | 4             | 0                          |
| `src/lib/Domain.ts`                     | 6        | 5             | predicate bodies only      |
| `src/routes/shop.$shop.index.tsx`       | 4        | 4             | 0                          |
| `src/lib/ShopAgent.ts`                  | 4        | 3             | 0 (3 connection narrowing) |
| others                                  | 5        | 5             | 0                          |
| total outside Domain.ts (lint pattern)  | 59       | 39            | 0                          |

# Index counts: implementation plan

This plan carries out the decisions in `docs/index-counts-performance-research.md` (2026-10-03,
five Plannotator rounds). Read that doc first: "Measurements" has the numbers every bound here is
set from, "Where the rows go" names the three plan defects phase 1 fixes, "What C3 is, concretely"
is the design phase 3 installs, and "Decisions" lists every call made. Nothing is open. Where this
plan had to choose something the research did not, the choice is under "Decided at planning time".

The publish fan-out plan (`docs/publish-fan-out-research.md`) is already implemented (commit
`3d7f2e5`): a write that changed nothing publishes nothing, `publishToTeams` names the order, hidden
browser pages defer their refetch, and `readOrders`, `readRuns` and `publish` log `ms=` and
recipient counts under `instrumentationIsOn` (local and staging). Decision 6 of the research is
therefore done; this plan builds on that code and does not redo it.

Four phases. Phase 1 is the query plans: an index, a planner hint, the member rewrite, and plan
tests. It is independent and goes first because every later number assumes it. Phase 2 is the
rows-read bound as a pinned rule, using a test harness phase 3 reuses. Phase 3 is C3, the Effect
`Cache` in the object. Phase 4 is the record: vocabulary, JSDoc, the hibernation check. The research
says A and C3 ship as one change; that means one uncommitted body of work through phase 4, not that
the phases run in parallel. Run the checks between phases; do not start phase 3 with phase 2 red.

## Before you start

- Read `AGENTS.md`, `docs/vocabulary-runbook.md`, and the JSDoc on `listOrders`, `ITEM_MATCHES`,
  `OPEN` (`src/lib/OrderRepository.ts`), `runListItems`, `listRuns`, `listRecent`
  (`src/lib/RunRepository.ts`), `currentWhere` (`src/lib/currentWhere.ts`), `initializeSchema`
  (`src/lib/ShopAgentSchema.ts`), `publish` (`src/lib/ShopAgent.ts`), `readOrders`, `readRuns`,
  `publishToTeams` (`src/lib/agent/ShopWork.ts`), `ShopAgentHost` (`src/lib/agent/Host.ts`), and
  `useSubscribedQuery` (`src/lib/useSubscribedQuery.ts`). Read `node_modules/effect/dist/Cache.d.ts`
  (`make`, `get`, `invalidateAll`, the `timeToLive` option) before phase 3. The rules that matter
  most here:
  - The data-model table on `initializeSchema` says what is true of the data, never which index
    makes it true. Phase 1 adds and drops indexes and changes no row of that table. The one rule it
    adds there is about statistics, stated in the prose above the table, not as a row.
  - A rule is stated once and linked from everywhere else. The rows-read bound is stated on the read
    that holds it (`listOrders`, `runListItems`) with its test title; the memo rule is stated on
    `publish`, which is where the invalidation happens, and `readOrders` and `readRuns` link it.
  - A JSDoc never cites a file under `docs/`. Carry the reasoning inline: why the composite index,
    why the unary plus, why no `analyze`, why the cache is cleared from `publish`.
  - Identifiers, JSDoc and tests speak the vocabulary. The screens are **the orders index** and
    **the workflows list**; the entity is a **run**; the new word is **memo** (phase 4 adds it).
    Never "cache hit" in screen copy; nothing here reaches a screen.
  - `scripts/rules-lint.ts` refuses inline status comparisons in routes and the object, a reserved
    stem in an exported identifier, and an import against the context map. Phase 3 exports nothing
    new from `src/lib/domain/`; its key classes stay module-private in `agent/ShopWork.ts`.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- The project is prototyping: there are no migrations for the object. Phase 1 changes the DDL in
  line in `initializeSchema` and you run `pnpm dev:reset` yourself afterwards.
- After each phase run `pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`), `pnpm test`,
  `pnpm fmt`, and after phases 1 and 3 the e2e suite (`npm run test:e2e --`). Keep every file
  `pnpm fmt` touches.
- A test that fails for a reason this plan does not name is a deviation: record it under
  [Deviations and issues](#deviations-and-issues), do not delete it.

## The decisions, by phase

| decision                                                                                            | phase |
| --------------------------------------------------------------------------------------------------- | ----- |
| `Run (orderId, state)` composite index; `Run_state_idx` dropped (Q5)                                | 1     |
| `+s.teamId` in the orders index team filter                                                         | 1     |
| member read drives from `RunTask_teamId_idx` (Q7)                                                   | 1     |
| nothing ever runs `analyze`; plan tests run without statistics (Q4)                                 | 1     |
| three plan tests: the counts statement, the team filter, `ITEM_MATCHES` inside the counts statement | 1     |
| the benchmark becomes a test with a rows-read bound per open order and per open run (Q3)            | 2     |
| C3 is Effect's `Cache`, two caches in `ShopWorkAgent`, cleared from `publish`                       | 3     |
| `listRecent` is not memoized                                                                        | 3     |
| the D1 teams read stays and is part of the orders memo key (Q8)                                     | 3     |
| the loader/socket agreement stays; no data push                                                     | 3     |
| hibernation preconditions pinned                                                                    | 4     |
| limits provisional; nothing in this plan changes `ShopLimits`                                       | —     |
| instrumentation in local and staging (Q6)                                                           | done  |

## Decided at planning time

- **Where the caches live.** In `ShopWorkAgent`'s `make`, built with `Cache.make` so they are per
  object instance (the runtime is built per instance in `makeRunEffect`). `ShopWorkAgent` exposes
  one effect, `clearListMemo`, and the class's `publish` runs it before the frames go out. Not in
  `Host.ts`: the host is what modules need from the object, and the memo is shop work's own.
- **Failures are not cached.** `Cache.make` takes `timeToLive: (exit) => Exit.isFailure(exit) ?
Duration.zero : Duration.infinity`, so a failed lookup is dropped at once and the next read
  retries. Without it the cache would hold the failure until the next publish.
- **Capacity 32** on both caches. The keys in use are the filter combinations merchants have open
  and the team sets members have open; 32 is far above either and bounds memory if a client cycles
  through cursors.
- **The member grouping moves out of the repository.** `RunRepository.listRuns` today reads the
  items and groups them. Phase 3 exposes `runListItems` on the service, moves the grouping,
  narrowing, sorting and cut into a pure function `Domain.workflowsListFrom(items, memberEmail,
query)` in `src/lib/domain/ShopWork.ts`, and deletes `RunRepository.listRuns`. `readRuns` composes
  the two with `Cache.get` in between. The pure function gets the tests `listRuns` had for the
  states; `runListItems` keeps the ones about which runs qualify.
- **Key types.** `OrdersMemoKey` and `RunsMemoKey` are `Data.Class` values, module-private in
  `agent/ShopWork.ts`. Team ids enter the key sorted and joined with `,`, so a `Data` structural
  compare works without `Data.array`.
- **Rows-read bounds.** From the measurements with the fixes in, with headroom for fixture shape:
  the orders index default read reads at most **60 rows per open order** (measured 42); the member
  read reads at most **12 rows per open run** for a member on a third of the teams (measured about
  7). The bound is the rule on the read's JSDoc and the test's title.
- **The harness.** `test/integration/rows-read.ts` exports `runInRepositoryCountingRows`, the bench's
  `Proxy` over `state.storage.sql` that records every `exec` cursor, and `rowsReadSince(captured,
from)`. Phase 2 writes it; phase 3's "a hit executes no SQL" test reuses it.
- **No `Run_state_idx` reader.** `grep -rn Run_state_idx src test` finds only the DDL and one
  JSDoc comment on `listOrders`; both change in phase 1.

## Phase 1: the query plans

Goal: the three plan defects fixed and pinned, the member read rewritten.

1. **DDL** (`src/lib/ShopAgentSchema.ts`). Replace
   `create index if not exists Run_state_idx on Run (state);` with
   `create index if not exists Run_orderId_state_idx on Run (orderId, state);` and drop
   `Run_orderId_idx` (the composite serves every `orderId = ?` probe it served). Keep
   `Run_open_age_idx` and `Run_closed_idx`. Add a comment: the composite exists because every
   per-order run predicate in `listOrders` has two equality terms, and without `sqlite_stat1` the
   planner otherwise takes a single-column index on `state` and reads every open run per open order.
   Above the data-model table, add a short paragraph: the object never runs `analyze`; the plans the
   tests pin are the no-statistics plans, and statistics would flip `ITEM_MATCHES` to a workflow
   scan.
2. **Team filter** (`src/lib/OrderRepository.ts`, `listOrders`). In `teamFilter`, write
   `+s.teamId = ${team}` and say why inline: `RunTask_teamId_idx (teamId, doneAt)` matches two of
   the subquery's terms and the planner drives from the team's open tasks per order; the unary plus
   leaves `runId` as the only indexable term, so the plan is `Run` by `(orderId, state)` then
   `RunTask` by `runId`. Cite https://www.sqlite.org/optoverview.html ("Disabling index use").
3. **The `run_summary` comment** on the counts statement names `Run_state_idx` and `Run_orderId_idx`;
   rewrite it for the composite index. Keep the `cross join`.
4. **Member read** (`src/lib/RunRepository.ts`, `runListItems`). Replace the first statement with
   the team-first shape measured in the research:

   ```sql
   select s.* from RunTask s
   where s.runId in (
     select m.runId from json_each(${json(teamIds)}) tt
     cross join RunTask m on m.teamId = tt.value and m.doneAt is null
     cross join Run r on r.id = m.runId and r.state = 'open'
     where ${currentWhere("m")}
   ) and ${currentWhere("s")}
   order by s.runId, s.position
   ```

   The second statement (the runs by id) stays. Update the JSDoc: the read starts from the member's
   teams through `RunTask_teamId_idx` and reads only the qualifying runs' current tasks; the
   `cross join` is the planner pin, as on `listOrders`. `currentWhere` is unchanged; the three
   readers still share it.

5. **Plan tests.** In `test/integration/order-repository.test.ts`, beside the existing
   `ITEM_MATCHES` plan test, add two: one runs `explain query plan` on the counts statement as
   `listOrders` builds it and asserts every `Run` access is `SEARCH r USING INDEX
Run_orderId_state_idx` and `w` is `SEARCH ... (tag=?)`, never `SCAN w`; one does the same for
   the statement with `team` set and asserts `s` is `SEARCH s USING INDEX sqlite_autoindex_RunTask_2
(runId=?)` and never `RunTask_teamId_idx`. To get the statement text, export the two fragment
   builders the way `ITEM_MATCHES` is exported, or capture the executed SQL with the phase 2 harness
   (if you reach for the harness, write it now and phase 2 reuses it). In
   `test/integration/run-repository.test.ts` add a plan test on `runListItems`' first statement
   asserting `m` is `SEARCH m USING INDEX RunTask_teamId_idx` and no `SCAN` of `RunTask` or `Run`.
   Every plan test runs without `analyze`; say so in a comment on each.
6. `pnpm dev:reset`. Run the checks and the e2e suite.

Done when: the four tests above pass, `grep -rn "Run_state_idx\|Run_orderId_idx" src test` is
empty, every existing `listOrders` and `listRuns` test passes unchanged, and the e2e suite is green.

## Phase 2: the rows-read bound

Goal: the benchmark becomes a pinned rule.

1. **Harness** (`test/integration/rows-read.ts`). From the removed bench: a `Proxy` over
   `state.storage.sql` whose `exec` records `{ query, params, cursor }`, a `Proxy` over
   `state.storage` that returns it for `sql`, `runInRepositoryCountingRows(program)` built like
   `run-repository.test.ts`'s `runInRepository` but passing the proxied storage to
   `SqliteClient.layer` and handing `program` the captured list, and `rowsReadSince(captured, from)`
   summing `cursor.rowsRead`. Lift the order ceiling inside it with `withMaxOrdersPerCycle` from
   `order-ceiling.ts`.
2. **Seed** (`test/integration/list-reads-rows.test.ts`). 20 workflows of 3 tasks across 6 teams
   (`replaceWorkflows`), 300 orders with 2 items each through `upsertOrder` with `reconcileOrder`,
   30% fulfilled, and the state spread the bench used (every fourth order started, done, two done).
   Record the open order and open run counts from SQL after seeding; the bounds divide by them.
3. **Tests.** Titles are the rules:
   - "the orders index default read reads at most 60 rows per open order": `listOrders` with
     `show: null, team: null, q: null`, rows read ÷ open orders ≤ 60.
   - "the workflows list read reads at most 12 rows per open run": `runListItems` for a member on
     2 of the 6 teams, rows read ÷ open runs ≤ 12.
   - "the Done count reads a day, not the table": `listRecent` with `limit: 0`, rows read ≤ open run
     tasks (it is bounded by the window, not the table; the fixture's `doneAt` values are all inside
     the day, so assert against the done task count plus the closed run count plus a small constant).
4. **The rule on the reads.** On `listOrders` and `runListItems` JSDoc, one sentence each: the
   bound, why it is linear (one probe per order or per task through the indexes phase 1 pinned), and
   the test title that pins it.

Done when: the three tests pass and the measured ratios are printed in the failure message so a
regression says its number.

## Phase 3: C3, the memo

Goal: one computation per distinct key per publish.

1. **Expose `runListItems`** on `RunRepository`'s service type and move the body of `listRuns`
   (team narrowing, grouping by `Domain.listStateOf`, the state choice, the search, sort, cut,
   counts, matches) into `Domain.workflowsListFrom` in `src/lib/domain/ShopWork.ts`, pure, with the
   JSDoc `listRuns` had. Delete `RunRepository.listRuns`. Re-point its tests: state and narrowing
   tests call the pure function on fixture items; qualification tests call `runListItems`. The
   shape-family table in `Domain.ts` gains no row: the function returns `Domain.WorkflowsListData`'s
   halves, existing shapes.
2. **Caches** in `ShopWorkAgent`'s `make`:

   ```ts
   class OrdersMemoKey extends Data.Class<{
     readonly limit: number;
     readonly cursor: string | null;
     readonly q: string | null;
     readonly show: Domain.OrdersShow | null;
     readonly team: Domain.TeamId | null;
     readonly teamIds: string;
   }> {}
   class RunsMemoKey extends Data.Class<{ readonly teamIds: string }> {}
   const notFailures = (exit: Exit.Exit<unknown, unknown>) =>
     Exit.isFailure(exit) ? Duration.zero : Duration.infinity;
   const ordersMemo = yield* Cache.make({ capacity: 32, timeToLive: notFailures,
     lookup: (key: OrdersMemoKey) => /* repository.listOrders with the teams the key was built from */ });
   const runsMemo = yield* Cache.make({ capacity: 32, timeToLive: notFailures,
     lookup: (key: RunsMemoKey) => repository.runListItems(key.teamIds.split(",")) });
   ```

   The orders lookup needs the `teams` array, not only its ids; keep the array in the key (as a
   `Data.array` or by re-reading it in the lookup from a `Ref` set by `readOrders` just before
   `get`). Prefer the first: the key is `Data.struct({ ..., teams: Data.array(teams) })` and the
   lookup reads `key.teams`. Note that `Cache.make` is scoped to the layer's lifetime; `make` already
   runs inside the agent layer, so no extra scope.

3. **`readOrders`** builds the key from its input and the D1 teams it already reads, and replaces
   `repository.listOrders(...)` with `Cache.get(ordersMemo, key)`. `syncState` stays a live read.
   **`readRuns`** replaces `repository.listRuns(...)` with `Cache.get(runsMemo, new
RunsMemoKey({ teamIds: sorted.join(",") }))` then `Domain.workflowsListFrom(items, memberEmail,
query)`. `listRecent` stays as it is.
4. **`clearListMemo`** on the `ShopWorkAgent` service: `Cache.invalidateAll(ordersMemo)` then
   `Cache.invalidateAll(runsMemo)`. In `ShopAgent.publish`, before `connections()`, run it through
   the runtime (`ShopWorkAgent` is in the layer; `yield* ShopWorkAgent` then `clearListMemo`). It
   must run even when there are no connections, and before the first frame is sent.
5. **The rule** on `publish`'s JSDoc, one paragraph: the memo holds each list read's last answer per
   key; a publish clears it before the frames go out, so a refetch after a push computes fresh; the
   cache is in the object's memory and starts empty on every activation, which costs one computation
   per key after a wake; in-flight lookups are dropped by `invalidateAll` and never stored, which is
   the library's behaviour. `readOrders` and `readRuns` link it with `{@link}`; their own JSDoc says
   what the key is and that `listRecent` is outside the memo and why.
6. **Tests** (`test/integration/shop-agent-workflows.test.ts` or a new
   `test/integration/list-memo.test.ts`, whichever already builds a `ShopWorkAgent` layer):
   - "a second read of the same key executes no SQL": with the phase 2 harness, two `readRuns` for
     the same teams, rows read between them is zero; same for `readOrders`.
   - "a publish between two reads makes the second one recompute": read, `publish`, read, rows read
     after the publish equals the first read's.
   - "members on the same teams share one computation": two members, different emails, same teams,
     one `runListItems` execution (count through the harness or a counting `RunRepository` layer),
     and `started_by_you` differs between them.
   - "a failed lookup is not kept": a `RunRepository` layer whose `runListItems` fails once then
     succeeds; the second `readRuns` succeeds.
7. Run the checks and the e2e suite. The e2e member and merchant flows exercise push then refetch;
   they are the integration proof that a cleared memo returns the written state.

Done when: the four tests pass, every existing socket test (`member-runs-socket.test.ts`,
`shop-agent-callables.test.ts`) passes unchanged, and `pnpm vocab:audit` reports `memo` as the only
new word (phase 4 adds it).

## Phase 4: the record

1. **Vocabulary.** Platform dialect table in `src/lib/domain/Platform.ts`: add
   `| memo | a list read's last answer, kept in the object's memory until the next publish | the Cache values in ShopWorkAgent | (none) |`
   following `docs/vocabulary-runbook.md` for adding a word. `pnpm spec check` must pass.
2. **Hibernation preconditions.** In `scripts/rules-lint.ts`, a rule: `setTimeout`, `setInterval`
   and `new WebSocket(` do not appear in `src/lib/ShopAgent.ts` or under `src/lib/agent/`, with the
   message naming the reason (a pending timer or a standard-API socket keeps the object from
   hibernating, which charges duration and defeats the memo's one-computation-per-push). A test in
   `test/integration/rules-lint.test.ts` with the rule as its title.
3. **JSDoc sweep.** `ShopAgentClient`'s loader-versus-socket paragraph gains one sentence: the
   socket read is memoized in the object per key and cleared on publish. `useSubscribedQuery`'s
   JSDoc gains one sentence: the leading-edge refetch is what makes one push one computation.
   `instrumentationIsOn` reads are unchanged.
4. **Research doc.** Add a line at the top of `docs/index-counts-performance-research.md`:
   implemented by this plan on the date it finishes. Do not delete anything under `docs/`.
5. Final run: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`, `npm run test:e2e --`.

Done when: all green, `git status` shows only this plan's files plus whatever `pnpm fmt` touched,
and nothing is committed.

## Verification

| check                          | command                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| types                          | `pnpm typecheck`                                                                           |
| rules, spec tables, vocabulary | `pnpm lint`                                                                                |
| unit and integration           | `pnpm test`                                                                                |
| one file                       | `pnpm vitest --config test/integration/vitest.config.ts run test/integration/<file>`       |
| formatting                     | `pnpm fmt`                                                                                 |
| screens                        | `npm run test:e2e --`                                                                      |
| new words                      | `pnpm vocab:audit`                                                                         |
| the fan-out, on a dev store    | `pnpm dev:logs` and grep `ShopAgent.readOrders`, `ShopAgent.readRuns`, `ShopAgent.publish` |

## Deviations and issues

Record here, as you go, anything that did not go as written: a test that failed for a reason this
plan did not name, a plan the planner chose that the test had to accept, a bound that needed
changing and the measured number that changed it, an API that did not behave as the research read
it (Effect `Cache` in particular), a step skipped and why. One entry per item, dated, with the
phase, what was expected, what happened, and what was done. An empty section at the end means
everything went as written; say so explicitly rather than leaving it blank.

| date       | phase | expected                                                                                                            | happened                                                                                                                                                                                                                                                                     | done                                                                                                                                                                                             |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-04 | 1     | `pnpm dev:reset` and the e2e suite after phase 1                                                                    | `dev:reset` stopped at the install step: no `ShopSession` for `sandbox-shop-00` after 180 s; the dev store needs a browser login                                                                                                                                             | e2e deferred to the final run; see the last row                                                                                                                                                  |
| 2026-10-04 | 1     | three plan tests: the counts statement, the team filter, `ITEM_MATCHES` inside the counts statement                 | the `ITEM_MATCHES`-inside-counts assertion (`w` is `SEARCH ... (tag=?)`, never `SCAN w`) is in the same test as the `Run` assertion, "the counts statement probes Run by order and state and Workflow by tag"; the statement text comes from the harness, written in phase 1 | two `listOrders` plan tests plus the member-read plan test; verified the team-filter test fails with `+` removed                                                                                 |
| 2026-10-04 | 2     | the Done count bounded by the done task count plus the closed run count plus a small constant                       | 277 rows for 135 rows in the window: each counted task is read from its index and its run is probed once, two rows per counted row                                                                                                                                           | bound is `2 × rows in the window + 10`; measured ratios: orders index 44.2 rows per open order (210 open), workflows list 10.0 rows per open run (420 open)                                      |
| 2026-10-04 | 2     | the bench's state spread produces done runs                                                                         | with three tasks per workflow and at most two marked done, no run reaches done, so every run of an open order is open                                                                                                                                                        | the per-open-run ratio is over 420 open runs; still under 12                                                                                                                                     |
| 2026-10-04 | 3     | `Cache.make` with a `timeToLive` function of the exit                                                               | `Cache.make` takes a fixed `Duration.Input`; the per-exit form is `Cache.makeWith(lookup, { capacity, timeToLive })`                                                                                                                                                         | used `makeWith`; failures expire at once (`keepSuccesses`)                                                                                                                                       |
| 2026-10-04 | 3     | team ids sorted and joined with `,` in the keys                                                                     | Effect v4 compares and hashes arrays and plain objects structurally (`Equal`, `Hash`), so no join is needed                                                                                                                                                                  | `OrdersMemoKey` carries the D1 `teams` array itself (the lookup needs it, and a team change is a new key); `RunsMemoKey` carries the sorted `teamIds` array                                      |
| 2026-10-04 | 3     | `listRuns`' tests split: state tests on the pure function with fixture items, qualification tests on `runListItems` | the tests' fixtures are seeded through the repositories, so items are read, not hand-built                                                                                                                                                                                   | a test-local `listRuns` composes `runListItems` and `Domain.workflowsListFrom`, as `readRuns` does; the titles say "the workflows list" instead of "listRuns"                                    |
| 2026-10-04 | 3     | "a second read of the same key executes no SQL"                                                                     | `readRuns` still runs `listRecent` (outside the memo) and `readOrders` still reads `SyncState`, so a second read executes SQL                                                                                                                                                | title is "a second read of the same key executes no list SQL"; it asserts that neither memoized statement ran                                                                                    |
| 2026-10-04 | 3     | the publish test through `publish`                                                                                  | the four planned tests build shop work with a stub host, so they cannot see the class's `publish`                                                                                                                                                                            | added "the class's publish clears the memo before its frames", against a real `ShopAgent`: a write without a publish stays unseen, a publish makes it seen; verified it fails without the clear  |
| 2026-10-04 | 3     | `ShopAgent.publish` runs `clearListMemo` through the runtime                                                        | `publish` is the host's `publish`, whose effect carries no services, so it cannot require `ShopWorkAgent`                                                                                                                                                                    | `publish` runs it as a nested `this.runEffect(...)` before `connections()`                                                                                                                       |
| 2026-10-04 | 3     | `pnpm vocab:audit` reports `memo` as the one new word                                                               | the audit reads exported identifiers; the memo symbols are module-private and `clearListMemo` is a service member                                                                                                                                                            | the audit reports no new word; phase 4 adds the row all the same                                                                                                                                 |
| 2026-10-04 | 4     | the vocabulary row's symbol cell names `ShopWorkAgent` in backticks                                                 | `pnpm spec check` requires a backticked symbol to occur in the context file, and `ShopWorkAgent` is not in `Platform.ts`                                                                                                                                                     | the symbol cell is plain text, "the Cache values in ShopWorkAgent"                                                                                                                               |
| 2026-10-04 | 1     | `scripts/dev.ts` unchanged                                                                                          | the install step opened the app before the quick tunnel resolved, so `dev:reset` timed out                                                                                                                                                                                   | `dev.ts` waits for the tunnel to answer and reopens the app every 30 s until the `ShopSession` row appears; outside this plan, kept as its own change                                            |
| 2026-10-04 | 3     | every write a list shows publishes, so the memo never outlives a write                                              | the webhook path's retention sweep deleted orders and runs and published only when the webhook's own order changed; before the memo a loader read was live, so nothing showed it                                                                                             | the webhook publishes `"all"` when its sweep deleted anything; the rule on `publish` says so; pinned by "a webhook whose sweep deletes an order publishes and the orders index stops showing it" |
| 2026-10-04 | 4     | the e2e suite after phases 1, 3 and 4                                                                               | not run by the implementation; the first row's "see the last row" pointed at nothing                                                                                                                                                                                         | run on review 2026-10-04: 76 passed, with `pnpm test` (717), typecheck, lint and fmt                                                                                                             |

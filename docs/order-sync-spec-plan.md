# Order sync spec: implementation plan

This plan carries out the fifteen decisions in `docs/orders-sync-research.md` (section 8).
Read that doc first: sections 1 to 5 say what the code does today, section 6 says which spec
form fits which rule and where the spec lives, section 7 is the spec as reviewed (the starting
text for the JSDoc this plan writes), section 9 is the review that found where the code and the
spec disagree. Written 2026-10-01 against `main` at `3ba85eb`. This plan says what to change,
in what order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that is the concept or enforces it. Other
    sites `{@link}` it. A JSDoc never cites a file under `docs/`; it carries its reasoning
    inline. A `refs/` path is fine; a line number is not.
  - Identifiers, JSDoc, tests and logs say the vocabulary word (sync); screens say the screen
    word (Sync open orders, Sync from Shopify). "import", "resync" and "line item" are retired;
    "window" is the implementer's word and stays out of copy and spec rows (say "the last 30
    days").
  - `pnpm spec check` runs under `pnpm lint`. A table it parses has a fixed header and fixed
    words in its fixed-word columns; a `pinned by` title must exist in some test as an
    `it(...)` title, or be `(none yet)`.
  - While prototyping there are no migrations: edit `initializeSchema` in
    `src/lib/ShopAgentSchema.ts` in place and run `pnpm dev:reset` yourself.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`. Keep every file
  `pnpm fmt` touches. After phase 2, `pnpm dev:reset`. At the end, `npm run test:e2e -- orders`.
- Record anything that does not go as written under
  [Deviations and issues](#deviations-and-issues) as you go, with the two options you saw and
  the one you took.
- Each phase is one change. Do not merge phases. Where a phase deletes, delete.
- The spec is what drives the work from here. Where the code and a cell disagree, the cell is
  right unless you can say why it is not; then stop and record it, do not edit the cell to
  match the code.

## The decisions, in the order the phases take them

| decision    | what                                                                                                  | phase |
| ----------- | ----------------------------------------------------------------------------------------------------- | ----- |
| 1, 2, 3     | `Domain.syncOrder` and `SyncAction` in `Orders.ts`; `upsertOrder` calls it; the SQL guard stays       | 1     |
| 12          | `lastCompletedAt` is cut                                                                              | 2     |
| 6           | `ShopLimits.storageSoftLimitBytes` is deleted                                                         | 2     |
| 8           | a refused sync raises the quota banner only                                                           | 2     |
| 15          | the two pre-start ceiling checks read the count after resolving the cycle (finding 1)                 | 2     |
| (finding 3) | the banner is the merchant sentence; the callback's `lastError` write is write-if-null                | 2     |
| 14          | `ShopAgent.syncOrder` answers `Stored` or `Gone`; the order page shows a toast on `Gone`              | 2     |
| 7           | `InFlight` shows a toast on the orders index                                                          | 2     |
| 4, 5, 11    | the sources, endings and rules tables on `syncOrder`; enforcers keep a link; the pipeline table links | 3     |
| 9           | the stream step's re-stream on retry is prose on `onOrdersStream`                                     | 3     |
| 13, (all)   | every `(none yet)` on sync's tables gets its test                                                     | 4     |

## Phase 1: `Domain.syncOrder` and the actions table

Goal: the write decision is a pure function in the orders context with a fixture matrix the
test reads out of the source. `upsertOrder` does the same thing it does today, by calling it.

### 1.1 The symbol (`src/lib/domain/Orders.ts`)

After `SyncOrderInput`, before `BulkOperationStatus`:

```ts
export const SyncAction = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("write"), fresh: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("skip") }),
  Schema.Struct({
    _tag: Schema.Literal("refuse"),
    reason: Schema.Literals(["ceiling", "retention"]),
  }),
]);
export type SyncAction = typeof SyncAction.Type;

export const syncOrder = ({
  stored,
  incoming,
  atCeiling,
}: {
  /** The stored row's version, or null when the order is not stored. */
  readonly stored: { readonly updatedAt: number } | null;
  readonly incoming: Pick<ShopOrder, "updatedAt" | "processedAt" | "syncedAt">;
  /** `cycleAtOrderCeiling` at the cycle `incoming.syncedAt` lands in, after any roll-forward. */
  readonly atCeiling: boolean;
}): SyncAction => { ... };
```

The body is the five rows of the actions table, in row order: not stored and
`processedAt < retentionCutoff(syncedAt)` → `refuse: retention`; not stored and `atCeiling` →
`refuse: ceiling`; not stored → `write: fresh`; stored and `incoming.updatedAt <
stored.updatedAt` → `skip`; otherwise `write`, not fresh. `retentionCutoff` is in Platform,
which Orders may import.

The JSDoc on `syncOrder` opens with the prose (one paragraph each: what sync is and that
reconcile begins once the order is stored; why `>=`, the tie rule, exists; why only a new
order is gated; why nothing is cleared) and then the actions table, with the intro from section
7B of the research verbatim and the header `stored | version | age | ceiling | action`. The
other three tables come in phase 3; leave the JSDoc ending after the actions table so phase 3
appends under it.

The `sync` row's symbol cell in the Orders vocabulary gains `syncOrder` first. The `Shape
families` table in `Domain.ts` is unaffected: `SyncAction` is not a `Result` (nothing has been
written when it is returned, like `ReconcileAction`).

### 1.2 `OrderRepository.upsertOrder` calls it

In `src/lib/OrderRepository.ts`, the probe becomes
`select updatedAt from ShopOrder where id = ? limit 1`; `fresh` is `existing.length === 0`;
the cycle is resolved as today (`currentCycle(order.syncedAt)`), and then one call:

```ts
const action = Domain.syncOrder({
  stored:
    existing[0] === undefined
      ? null
      : { updatedAt: Number(existing[0].updatedAt) },
  incoming: order,
  atCeiling: Domain.cycleAtOrderCeiling(cycle.ordersThisCycle),
});
```

`refuse: retention` returns `{ written: false, fresh: false, refused: false }`; `refuse:
ceiling` calls `markOrdersLimited(order.syncedAt)` and returns `refused: true`; `skip` returns
`written: false`; `write` runs the insert. The SQL `where excluded.updatedAt >=
ShopOrder.updatedAt` stays (decision 3) and `written.length === 0` still returns `written:
false`; a comment says the function decided and the clause is the belt. Resolve the cycle only
when the order is not stored, as today (the ceiling is a fact about new orders), but call
`syncOrder` on every path so the function is the one decision; pass `atCeiling: false` when
the order is stored, with a comment that the function ignores it then (rule 8).

The `upsertOrder` JSDoc on the interface loses its restated rules and says: "What one sync does
to one order is `Domain.syncOrder`'s actions table; this is where it is executed, in one
transaction, with the items and the reconcile (rule 6)."

### 1.3 The parser and the fixture expansion (`scripts/lib/spec.ts`)

Beside `parseReconcileActions`:

- `SYNC_ACTION_WORDS = { stored: ["none", "stored"], version: ["older", "same or newer",
"any"], age: ["expired", "kept", "any"], ceiling: ["at", "under", "any"] }`.
- `parseSyncActions(source)`: `nthTable(source, "syncOrder", ["stored", "version", "age",
"ceiling", "action"], 0)`; each input cell one of its list; `action` matches
  `/^(?<tag>write|skip|refuse)(?:: (?<note>.+))?$/u`; rows carry `line`, `text`, the cells and
  `action.tag`. Error prefix `syncOrder actions`.
- `expandSyncAction(row)`: the cross product of each `any` cell over its list (`any` for
  `version` on a `none` row still expands, and the function must ignore it). Each fixture is
  `{ stored, version, age, ceiling }`.
- `overlaps("syncOrder", rows)` as the existing `overlaps` does for the action matrices, so two
  rows cannot share a fixture.

In `scripts/spec.ts` `check`: parse and check overlaps, as `NAMES` does for `runActions`. In
`print`: a `syncOrder actions` section with `[fixtures] row text` lines. Update both command
descriptions. `jsdocBefore` already finds `export const`.

### 1.4 The test

In `test/integration/run-actions.test.ts`, after `Domain.reconcileItem actions`, a describe
`Domain.syncOrder actions` of the same shape: read the table from `src/lib/domain/Orders.ts`,
one `it(row.text)` per row, every fixture through `Domain.syncOrder` with concrete numbers
(`stored.updatedAt` 100; `incoming.updatedAt` 50, 100 or 150 for older, same, newer, both
`same` and `newer` run for `same or newer`; `processedAt` one day past or inside
`retentionCutoff(syncedAt)`), asserting `_tag`, `fresh` on a write and `reason` on a refuse.

In `test/integration/spec.test.ts`: a describe `sync actions table parser`: the live table
parses with five rows; a bad word in `age` is refused; a doctored overlap is reported; the
fixture count of the `stored | older` row is the product of its `any` columns.

The repository tests in `order-repository.test.ts` stay: "stores an order with its items",
"leaves the row and its items alone for an older updatedAt", "accepts an equal updatedAt and
rewrites the row", "replaces the line-item set on every accepted write", "an order older than
retention is never stored again", "the ceiling counts orders work started on, not orders
stored: …" assert the SQL effects the pure function cannot.

### 1.5 Done when

`pnpm spec print` shows `syncOrder actions` with five rows and their fixture counts;
`pnpm test` passes with the new describe; `pnpm vocab:audit` lists no new word (`action`
already has `ReconcileAction`). Nothing behaves differently.

## Phase 2: the cuts and the behaviour changes

Goal: the code agrees with the spec. Each item is small; do them in this order, each ending
green.

### 2.1 `lastCompletedAt` is cut (decision 12)

- `initializeSchema`: drop the column from `SyncState`; the DDL comment reads "The last
  sync's error, if any; owned by OrderRepository.getSyncState."
- `domain/Orders.ts`: `SyncState` is `{ lastError }`; its JSDoc loses the `lastCompletedAt`
  sentences and says: "Whether one is running now is not stored — the Agents SDK's own
  `cf_agents_workflows` row is the only run tracker ({@link OrdersSyncStatus.inFlight}) — and
  a completed sync leaves nothing behind but its rows (rule 13 on `syncOrder`)."
- `OrderRepository.ts`: delete `setLastCompletedAt` from the interface and the
  implementation; `readSyncState`, `setSyncError` and `clearSyncError` select and return
  `lastError` only.
- `ShopAgent.onWorkflowComplete`: deletes the tracking row, logs, publishes; nothing else. Its
  JSDoc: "A completed sync leaves nothing behind but its rows (rule 13 on `Domain.syncOrder`):
  the tracking row goes, which is what re-enables the button."
- `order-repository.test.ts`: "records the last completed sync and the last error" becomes
  "records the last error and nothing else on completion" asserting `lastError` set by
  `setSyncError` and the row otherwise untouched. The `(none yet)` on rule 13 is phase 4's.
- `pnpm dev:reset`.

### 2.2 `storageSoftLimitBytes` is deleted (decision 6)

Delete the field and its JSDoc from `ShopLimits` in `src/lib/domain/Platform.ts`. Grep
`storageSoftLimit` under `src scripts test`; nothing else reads it. The sentence on
`syncOpenOrders` ("No storage guard beside it: …") stays; it is the reasoning.

### 2.3 A refused sync raises the quota banner only (decision 8)

In `ShopAgent.syncOpenOrders`, the ceiling path keeps the log, `markOrdersLimited(now)` and the
publish, and loses `repository.setSyncError({ error: ORDER_CEILING_SYNC_REFUSED })`. Delete
`ORDER_CEILING_SYNC_REFUSED` and `src/lib/quotaCopy.ts` if nothing else is in it; remove the
file from `copyFiles()` in `scripts/lib/copy-files.ts`. The `OrdersSyncResult` JSDoc: "`Refused`
is the order ceiling, which the quota banner already carries (`ordersLimitedAt`)". The
`docs/order-sync-vocabulary-plan.md` deviation that introduced the file is history; do not
edit it.

Check the quota banner on the orders index says what the merchant needs on its own ("Syncing
resumes on …" with the cycle end). If it does not name the cycle end, record it under
Deviations; do not add copy here.

### 2.4 The ceiling is read after resolving the cycle (decision 15, finding 1)

`OrderRepository` gains `usageAtCycle(now)`: `currentCycle(now)` then `readUsage()`, so a
cycle whose end has passed is rolled forward before the count is read, exactly as the write
does. `syncOpenOrders` and `syncOrderWebhook` call it instead of `getUsage()` for their
ceiling checks (`syncOrderWebhook` also reads `lastSweepAt` from it, which is fine). `getUsage`
stays for the Worker's reads. JSDoc on `usageAtCycle`: "Rule 5 on `Domain.syncOrder`: the
ceiling is read at the cycle the sync lands in, after any roll-forward, wherever it is read."

The one-order path (`ShopAgent.syncOrder`) has no pre-check and needs nothing.

### 2.5 The banner is the merchant sentence; the callback never overwrites it (finding 3)

- `OrdersSyncWorkflow.run`'s `Effect.onError` sink: the message passed to
  `agent.onOrdersSyncError` is the `OrdersSyncWorkflowError`'s own `message` when the cause's
  failure is one (`Cause.findErrorOption` or the equivalent in `refs/effect`), and
  `causeToErrorMessage(cause)` otherwise (a defect: an exhausted step). The merchant sentences
  (`GAVE_UP_MESSAGE`, "Bulk operation did not complete: FAILED", "Step failed: …") reach the
  banner bare, no tag prefix, no `[cause]:` line.
- `OrderRepository.setSyncError` gains `{ onlyIfEmpty: true }` or a sibling
  `setSyncErrorIfEmpty`: `update SyncState set lastError = ? where id = 1 and lastError is
null`. `ShopAgent.onWorkflowError` uses it; `onOrdersSyncError` keeps the plain write. JSDoc
  on `onWorkflowError`: "Rule 14 on `Domain.syncOrder`: the sink wrote the sentence; this
  callback deletes the tracking row and writes a message only when the sink never ran."
- `orders-sync-workflow.test.ts`: "gives up after five minutes, cancels the Shopify operation,
  and fails with a merchant message" asserts `strictEqual(lastError, GAVE_UP_MESSAGE)`, not
  `toContain`. Export `GAVE_UP_MESSAGE` for it, or assert the literal.

### 2.6 `ShopAgent.syncOrder` answers `Stored` or `Gone` (decision 14)

- `domain/Orders.ts`: `SyncOrderResult = Union(Struct({ _tag: "Stored" }), Struct({ _tag:
"Gone" }))`, a `Result` by the Shape families table; JSDoc: "What Sync from Shopify is told it
  did. `Gone` is Shopify answering `null` for the order: the stored row stays (a transient
  `null` must not be destructive; reconcile has already closed the runs of a cancelled order
  and retention deletes the row in time), and the order page says so."
- `OrdersAgent.fetchAndUpsertOrder` returns `{ written, ceilingReleased, gone: boolean }`
  (`gone: true` on the `null` branch). `ShopAgent.syncOrder` returns the `Result` from it;
  `syncOrderWebhook` ignores `gone` beyond its existing log.
- `app.orders.$orderId.tsx`: `syncMutation` decodes the result like the orders index decodes
  `OrdersSyncResult` (`Schema.decodeUnknownPromise(Schema.toType(Domain.SyncOrderResult))`),
  and on `Gone` shows `shopify.toast.show("Shopify no longer has this order")`; on `Stored`
  invalidates as today. Copy slot: toast. The copy table's toast row says "confirms a write";
  this toast confirms a fact instead. Decision 7 (below) has the same need; see 2.7 for the
  one copy-table edit.
- `shop-agent-sync-order.test.ts`: "the one-order sync answers Gone for an order Shopify no
  longer has and leaves the stored row" (phase 4 lists it; write it here if the stand-in is
  already at hand).

### 2.7 `InFlight` shows a toast (decision 7)

In `app.orders.index.tsx`, `startSync`'s `.then`: on `InFlight`,
`shopify.toast.show("A sync is already running")`, then invalidate as today. In
`src/lib/Screen.ts`, the toast row's `job` becomes "confirms a write, or says why a press did
nothing" and its `form` gains "; a fact in the present tense"; add "A sync is already running"
as a second example only if `pnpm spec check` wants one example per row (it wants one; keep
"Note saved" and put the new string in the `form` cell's wording, not in `example`). The
controls table's "a write whose result is off-screen or closed a modal → a toast" row gains
"or a press that did nothing" in its `job`.

### 2.8 Done when

`pnpm dev:reset` succeeds; `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; the data-model
table on `initializeSchema` still parses (no row named `lastCompletedAt`); on the dev store,
Sync from Shopify on a deleted order shows the toast and the row stays; a second press of Sync
open orders while one runs shows the toast.

## Phase 3: the sources, endings and rules tables

Goal: a person reads sync in one JSDoc, on `syncOrder`, and `pnpm spec check` holds all four
tables.

### 3.1 The tables (`src/lib/domain/Orders.ts`)

Under the actions table on `syncOrder`, in this order, with these intros, the rows from
section 7 of the research as reviewed, and `(none yet)` where the research has it (phase 4
fills them):

- Table 1 (after the actions table, so table index 1): the **sources** table. Intro: "When a
  sync happens. One row per source; `who` is the gate the start passes; `asks Shopify for` is
  the fetch; `skipped when` is what returns before any write." Header `source | who | asks
Shopify for | skipped when | pinned by`. Then the seed sentence and the callbacks sentence
  from 7A.
- Table 2: the **endings** table. Intro: "What each ending of the open-orders sync leaves.
  `tracking row` is `inserted`, `deleted`, `none` or `—`; `lastError` is `set`, `cleared` or
  `—`." Header `ending | tracking row | lastError | pinned by`. Then the row notes from 7C
  (without the `lastCompletedAt` clause).
- Table 3: the **rules** table. Intro: "The invariants, in the order a sync meets them. `where`
  names the enforcer; the rule is stated here and that symbol links it." Header `rule | where |
pinned by`; rows `1.` to `17.` as in 7D. Rule 13's text is the decision-12 wording.

Several `pinned by` cells in the sources and rules tables name more than one title, separated
by `; `. The parsers split on `; ` and `checkPinned` checks each; no sync title may itself
contain `; ` (the reconcile tables are unchanged and keep single titles).

### 3.2 The enforcers link back

Each `where` symbol keeps its mechanics and one sentence with a link; restated rules go:

- `ShopAgent.syncOpenOrders`: keep the three cases (they are reasoning), link rules 3 and 5.
- `ShopAgent.syncOrderWebhook`: keep the paragraph on why the webhook returns 2xx at the
  ceiling; link rules 1, 2, 5, 9 and 12.
- `ShopAgent.syncOrder`: link rules 12 and 15; `SyncOrderResult` for `Gone`.
- `ShopAgent.onOrdersStream`: link rules 9, 11, 12 and 15; add the decision-9 prose: "A step
  retry re-streams the whole file when the sweep or the flush throws after the writes: correct
  under rule 7, a full second pass, and rare."
- `onOrdersSyncError`, `onWorkflowError`, `onWorkflowComplete`: rules 13 and 14.
- `OrdersSyncWorkflow.run`: keep the two Workflow constraints and the per-attempt step names;
  link rule 4 (`bulkOrdersQueryText`) and the endings table.
- `runShopAgentOrdersStream`, `addLine`: link rules 10 and 11; keep "constant memory" and
  "merge, never rebuild" as reasoning.
- `OrdersAgent.fetchAndUpsertOrder`: link rule 10 for `hasNextPage`.
- `OrderRepository.upsertOrder`, `recordWebhookDelivery`, `sweepExpiredOrders`: rules 6, 7, 2, 9.
- `webhooks.orders.ts`: keep the why (payload is a signal; failures propagate; subscriptions in
  the toml are never auto-deleted); link rules 1 and 2.
- `OrdersSyncStatus`, `OrdersStreamCounts`: rule 17. `SYNC_STALE_MS`: rule 3.

No sentence is deleted whose reasoning is not on `syncOrder`. When in doubt, move it to
`syncOrder`'s prose.

### 3.3 The pipeline table and the data model

- `ShopAgentHost`'s pipeline table: the `store` cells become "`Domain.syncOrder`: fetch one;
  dedupe and version skip first" (webhook), "`Domain.syncOrder`: each streamed order" (stream),
  "`Domain.syncOrder`: fetch one; no skip" (button). `parseSyncPipeline` requires `store`
  non-empty only, so no parser change.
- `initializeSchema`'s row "an order is Shopify's record, mirrored; each sync overwrites it
  whole except `countedAt`" gets the phase 4 title (4.3) in `pinned by`.

### 3.4 The parsers (`scripts/lib/spec.ts`)

Three parsers beside `parseSyncActions`, all `nthTable(source, "syncOrder", header, n)` with
`n` 1, 2, 3:

- `parseSyncSources`: five non-empty cells; `pinned by` one or more titles split on `; `, or
  `NONE_YET`. Returns one row per title for `checkPinned`, each with the table line.
- `parseSyncEndings`: `tracking row` one of `SYNC_ENDING_WORDS.trackingRow = ["inserted",
"deleted", "none", "—"]`, `lastError` one of `["set", "cleared", "—"]`; `ending` non-empty,
  each exactly once; `pinned by` as above.
- `parseSyncRules`: `rule` starts with `<n>. ` and the numbers run 1 upward with no gap;
  `where` one or more backticked symbols; `pinned by` as above.

In `scripts/spec.ts` `check`: three more `Result.match` entries, each
`checkPinned(rows, testSources, "syncOrder")`. In `print`: three sections, `syncOrder
sources`, `syncOrder endings`, `syncOrder rules`, and one line `syncOrder: N rows pinned by
(none yet)` across the three. Update both command descriptions and the `pnpm spec check` line
in `AGENTS.md`'s commands block (one phrase: "the four sync tables on syncOrder in
domain/Orders.ts").

In `spec.test.ts`: a describe per parser as the reconcile ones have: the live table parses; a
bad fixed word is refused; a missing header is refused; a rule number out of sequence is
refused; a cell with two titles yields two rows and `checkPinned` reports the doctored one.

### 3.5 Done when

`pnpm spec print` shows all four sync tables and the `(none yet)` count; `pnpm lint` passes;
the `syncOrder` JSDoc reads top to bottom as the whole of sync, with no sentence that restates a
row.

## Phase 4: the tests

Goal: no `(none yet)` on sync's tables. Each test's title is the cell, verbatim; write the
title into the cell in the same change. Where a table lists a file, `shop-agent-sync-order.test.ts`
already has the Admin API stand-in (`setAbstractFetchFunc`, see its header) and
`orders-sync-workflow.test.ts` the Workflow introspector.

### 4.1 The endings table, four rows

| row                          | title                                                                                     | file                               | asserts                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the start failed             | a start that fails leaves no tracking row and no banner                                   | `orders-sync-workflow.test.ts`     | with `runWorkflow` made to reject inside `runInDurableObject`, `syncOpenOrders` rejects, `getWorkflows` is empty, `lastError` is null                               |
| a partial file               | a partial file is streamed and the sync completes                                         | `orders-sync-workflow.test.ts`     | `run-bulk-orders-query` mocked `COMPLETED` with `url: null` and `partialDataUrl` set; `on-orders-stream` runs and the instance completes                            |
| the stream failed partway    | a stream that fails partway keeps the orders it wrote                                     | `shop-agent-orders-stream.test.ts` | an `afterWrite` that fails on the second order: the first order and its items are stored, the stream fails, `lastError` is not this test's to assert                |
| refused at the order ceiling | a sync refused at the order ceiling flags the refusal, writes no error and tracks nothing | `orders-sync-workflow.test.ts`     | count at the ceiling (`withMaxOrdersPerCycle` from the ceiling suite); `syncOpenOrders` answers `Refused`; `ordersLimitedAt` set; `lastError` null; no tracking row |

### 4.2 The rules table, eight rows

| rule              | title                                                                                                                | file                                | asserts                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                 | a webhook's topic decides nothing: a cancelled topic on an open order stores it open                                 | `shop-agent-sync-order.test.ts`     | `syncOrderWebhook` with topic `orders/cancelled` and a stand-in answering an open order: the row is open, its run is created                                                 |
| 5                 | the order ceiling is read at the cycle the sync lands in: a sync after the cycle end is not refused at the old count | `shop-agent-orders-ceiling.test.ts` | count at the ceiling with `cycleEndAt` in the past: `syncOrderWebhook` for a new order stores it; `syncOpenOrders` answers `Started`; `ordersThisCycle` recounted            |
| 11                | every streamed order carries one syncedAt, read before the file is fetched                                           | `shop-agent-orders-stream.test.ts`  | two orders streamed under a stepped `Clock`: both rows' `syncedAt` equal the clock before the GET                                                                            |
| 13                | a completed sync deletes the tracking row and writes nothing else                                                    | `orders-sync-workflow.test.ts`      | after the happy path: `getWorkflows` empty; `getSyncState` equals its value before the start                                                                                 |
| 14                | a failed sync's banner is the merchant sentence, and the callback never overwrites it                                | `orders-sync-workflow.test.ts`      | after the gave-up path `lastError === GAVE_UP_MESSAGE`; then `onWorkflowError(name, id, "other")` leaves it                                                                  |
| 15                | the stream's callbacks are not callable from a socket, and the two sync buttons refuse a member                      | `shop-agent-callables.test.ts`      | the callable list has `syncOpenOrders` and `syncOrder` and none of `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`; a member connection calling either is refused |
| 17                | no sync count reaches a screen: the orders index carries whether one runs and the last error                         | `domain.test.ts` or `spec.test.ts`  | `Object.keys(Domain.OrdersSyncStatus.fields)` is exactly `inFlight`, `lastError`; `OrdersIndexData.fields.syncState` is `OrdersSyncStatus`                                   |
| (14, decision 14) | the one-order sync answers Gone for an order Shopify no longer has and leaves the stored row                         | `shop-agent-sync-order.test.ts`     | a stored order; the stand-in answers `null`; `syncOrder` answers `Gone`; the row is unchanged                                                                                |

Rule 15's second half may already be the callables suite's role test; if so, one title covers
both halves and the first half is the new assertion.

### 4.3 The data-model row

| row                                              | title                                      | file                       | asserts                                                                                    |
| ------------------------------------------------ | ------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| each sync overwrites it whole except `countedAt` | a sync rewrites every column but countedAt | `order-repository.test.ts` | a counted order upserted with every field changed: every column follows, `countedAt` stays |

### 4.4 Done when

`pnpm spec print` reports `syncOrder: 0 rows pinned by (none yet)` and the data-model table has
no sync row at `(none yet)`. `pnpm test` passes.

## Phase 5: the whole

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`; keep every file `fmt` touches.
- `npm run test:e2e -- orders` against the dev store; the sync test still passes on the
  "Syncing…" line.
- `pnpm vocab:audit`: no new word; `bulk`, `stream`, `poll` remain mechanism words as before.
- `grep -rn "lastCompletedAt\|storageSoftLimit\|ORDER_CEILING_SYNC_REFUSED" src scripts test`
  returns nothing.
- Read the `syncOrder` JSDoc once, top to bottom, as the user would: prose for the why, four
  tables, no sentence that restates a row.
- Add a Status line at the top of `docs/orders-sync-research.md` saying the plan is done and
  where the tables are. Do not edit the rest of the research.

## Deviations and issues

Record here, as you go, anything that did not go as written: what the plan said, what you
found, the two options you saw, and the one you took. One entry per item, dated. Empty until
the work starts.

All 2026-10-01.

1. **1.2, where the cycle is resolved.** The plan said resolve it only for a new order, "as
   today". Today's code resolves it on every path. Options: resolve only for a new order (a
   stored order's update past the cycle end would no longer roll the cycle until `countOrder`),
   or keep every path. Took every path: phase 1 changes no behaviour, and `syncOrder` ignores
   `atCeiling` for a stored order (the comment says so).
2. **1.2, a `{@link}` in the service interface.** `{@link OrderRepository.setSyncError}` inside
   `OrderRepository`'s own interface made TypeScript report the class as referencing itself.
   The JSDoc on `setSyncErrorIfEmpty` names `setSyncError` in backticks instead.
3. **2.3, the quota banner.** It names the cycle end ("Syncing resumes on …") only when
   `cycleEndAt` is known. After a roll-forward the cycle is open-ended until the next
   revalidation, and the banner then says only that new orders stopped syncing. No copy added.
4. **2.4, two ceiling tests leaned on finding 1.** "refuses a new order at the ceiling and flags
   the refusal" and "clears the refusal flag when a new billing cycle starts" set
   `cycleEndAt: 10_000`, a cycle long over, and passed only because the pre-check read the stale
   count. Options: change the cell or change the tests. Changed the tests: their cycle now ends
   a day after the test runs.
5. **2.5, `GAVE_UP_MESSAGE`.** Exporting it added "gave" to `pnpm vocab:audit`. Options: export
   it, or assert the literal. Kept it private; the workflow test holds the literal, with a
   JSDoc naming the constant it mirrors.
6. **2.7, the controls row.** Besides the `job` cell, the `control` cell now reads "a toast with
   the verb, or with the fact that made the press do nothing", since a toast for a press that
   did nothing has no verb to carry.
7. **2.8, the dev-store checks were not run by hand.** Gone needs an order deleted at Shopify;
   the InFlight toast needs a second press while the button is disabled, which only a second
   tab or a race reaches. Both results are pinned by integration tests ("the one-order sync
   answers Gone …", "refuses a second sync while one is tracked as running"), and
   `npm run test:e2e -- orders` passes (17 tests).
8. **3.4, a title with `; `.** Rule 16's existing title, "creates runs on every streamed open
   order that matches, however old; a re-stream creates none", contains the separator. Options:
   let the parser accept it, or rename the title. Renamed it to "…, however old, and a re-stream
   creates none" in the test, in the reconcile triggers table and in rule 16.
9. **4.2, where the rule 5 test lives.** It needs the Admin API stand-in, which only
   `shop-agent-sync-order.test.ts` has, so it is there rather than in the ceiling suite.
10. **4.2, the Gone test's cell.** The plan gave the title but no cell. It is the second title of
    the Sync from Shopify row of the sources table.
11. **4.2, rule 15.** One test covers both halves; it also calls each callback over a merchant
    socket and expects a refusal, which proves "not callable" rather than only "not decorated".

Review of the implementation, 2026-10-01, by a second agent. The eleven entries above stand.
Found and fixed in the same review:

12. **4.2, a stray variable.** The rule 14 test declared an `agent` it never read, so
    `pnpm typecheck` and `pnpm lint` failed. Deleted the line.
13. **2.1, the sync-state test's title.** The plan prescribed "records the last error and nothing
    else on completion"; the test no longer involves a completion. Renamed to "records the last
    error and nothing else". No table cites it.
14. **3.1, "window" in a spec row.** The endings row "no orders in the 30 days" was pinned by the
    existing title "completes: a window with no orders reaches on-orders-sync-empty". Options:
    accept the implementer's word in a cell, or rename the title. Renamed it to "completes: 30
    days with no orders reaches on-orders-sync-empty" in the test and the cell, and reworded the
    `onOrdersSyncEmpty` JSDoc the same way.
15. **4.1, the ceiling override.** `withMaxOrdersPerCycle` was file-local to the ceiling suite, so
    the plan's "from the ceiling suite" became a fourth copy of the cast-and-restore pattern.
    Moved it to `test/integration/order-ceiling.ts` and every suite imports it.
16. **4.2, two assertions that passed trivially.** Rule 13's test compared sync state before and
    after when both were `{ lastError: null }`; it now reads the whole `SyncState` row after the
    start and asserts completion left every column as it was. Rule 11's test asserted
    `syncedAt <= clock at GET`; under a stepped clock it is now strictly before.
17. **2.7 and 3.4, table alignment.** The edited rows of the controls table in `Screen.ts` and the
    triggers table in `ShopWork.ts` were wider than their columns. Realigned; `pnpm fmt` does not
    touch JSDoc tables.

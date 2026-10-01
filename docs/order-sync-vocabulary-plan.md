# Order sync vocabulary: implementation plan

The Orders vocabulary's two words for getting orders from Shopify, **import** and **resync**,
become one word, **sync**. This plan says what changes, in what order, and how to know it is
done. The research and the decisions are `docs/order-sync-vocabulary-research.md`; the
procedure is `docs/vocabulary-runbook.md`. Written 2026-09-30 against `main` at `72c8e25`.

Rules for whoever implements this:

- Follow the steps in order. Each step ends with `pnpm typecheck` and `pnpm lint` green.
- Do not change behaviour. Every change here is a word, a name, a literal that is never
  stored, or a string on a screen. If a step seems to need a behaviour change, stop and
  record it under Deviations and issues.
- Do not commit. Run `pnpm fmt` at the end and keep every file it touches.
- Do not edit `docs/` other than this file's Deviations and issues section.
- `src/routeTree.gen.ts` and `worker-configuration.d.ts` are generated; never edit them.

## Decision

- **sync**: making Baton's copy of an order agree with Shopify. Three ways: a webhook (one
  order, as it happens), the open-orders sync (the orders index button: open, unfulfilled,
  created in the last 30 days), the merchant asking for one order (the order page button).
- **import** and **resync** are retired, in copy and in exported identifiers.
- Screen words: **Sync open orders** (orders index), **Sync from Shopify** (order page).
- Identifiers: `syncOpenOrders` (the index callable), `syncOrder` (the one-order callable).
- `OrderSyncSource` is deleted. It was a log-only literal; the log span already names the
  caller.
- The ceiling message leaves `ShopAgent.ts` for a file the copy lint reads.

## Names

| where                                      | before                                                                           | after                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| vocabulary row, `domain/Orders.ts`         | `import` row and `sync` row                                                      | one `sync` row (text in step 1)                                                        |
| callable, `ShopAgent.ts`                   | `syncOrders`                                                                     | `syncOpenOrders`                                                                       |
| callable, `ShopAgent.ts`                   | `resyncOrder`                                                                    | `syncOrder`                                                                            |
| input, `domain/Orders.ts`                  | `ResyncOrderInput`                                                               | `SyncOrderInput`                                                                       |
| literal union, `domain/Orders.ts`          | `OrderSyncSource`                                                                | deleted                                                                                |
| constant, `orderSyncConstants.ts`          | `ORDER_IMPORT_WINDOW_DAYS`                                                       | `ORDER_SYNC_WINDOW_DAYS`                                                               |
| constant, `ShopAgent.ts`                   | `IMPORT_IN_FLIGHT`                                                               | `SYNC_IN_FLIGHT`                                                                       |
| constant, `ShopAgent.ts`                   | `IMPORT_STALE_MS`                                                                | `SYNC_STALE_MS`                                                                        |
| function, `ShopAgent.ts`                   | `importRowIsFresh`                                                               | `syncRowIsFresh`                                                                       |
| private field, `ShopAgent.ts`              | `importStarting`                                                                 | `syncStarting`                                                                         |
| host field, `agent/Host.ts`                | `importInFlight`                                                                 | `syncInFlight`                                                                         |
| local, `app.orders.$orderId.tsx`           | `resyncMutation`                                                                 | `syncMutation`                                                                         |
| log span names                             | `ShopAgent.syncOrders`, `ShopAgent.resyncOrder`, `ShopAgent.syncOrders.inFlight` | `ShopAgent.syncOpenOrders`, `ShopAgent.syncOrder`, `ShopAgent.syncOpenOrders.inFlight` |
| role table, `shop-agent-callables.test.ts` | `syncOrders`, `resyncOrder`                                                      | `syncOpenOrders`, `syncOrder`                                                          |

Unchanged on purpose: `OrdersSyncWorkflow`, `ORDERS_SYNC_WORKFLOW`, `OrdersSyncParams`,
`OrdersSyncResult`, `OrdersSyncStatus`, `SyncState` (table and schema), `OrderSync.ts` and
its exports, `ShopOrder.syncedAt`, `OrdersBulkRepository` and the `BULK_*` constants,
`onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`, the `wrangler.jsonc` binding.

## Copy

| file                      | today                                                                                                                                                                                              | after                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.orders.index.tsx`    | Import open orders (the button, rendered twice)                                                                                                                                                    | Sync open orders                                                                                                                                                                               |
| `app.orders.index.tsx`    | Import open orders to pull in what is on the bench, or wait for the next order. The import takes the open, unfulfilled orders from the last 30 days; after that, order webhooks keep them current. | Sync open orders to pull in what is on the bench, or wait for the next order. The sync takes the open, unfulfilled orders from the last 30 days; after that, order webhooks keep them current. |
| `app.orders.index.tsx`    | Importing… this page updates as orders arrive.                                                                                                                                                     | Syncing… this page updates as orders arrive.                                                                                                                                                   |
| `app.orders.index.tsx`    | Couldn't read import status.                                                                                                                                                                       | Couldn't read sync status.                                                                                                                                                                     |
| `app.orders.index.tsx`    | Couldn't start the import.                                                                                                                                                                         | Couldn't start the sync.                                                                                                                                                                       |
| `app.orders.$orderId.tsx` | Resync from Shopify                                                                                                                                                                                | Sync from Shopify                                                                                                                                                                              |
| `app.orders.$orderId.tsx` | This order isn't in Baton. It may be older than the import window, or deleted in Shopify.                                                                                                          | This order isn't in Baton. It may be older than 30 days, or deleted in Shopify. (30 interpolated from `ORDER_SYNC_WINDOW_DAYS`)                                                                |
| `ShopAgent.ts` → moved    | Baton is built for shops under 100 orders a billing cycle; importing resumes when the billing cycle ends.                                                                                          | Baton is built for shops under 100 orders a billing cycle; syncing resumes when the billing cycle ends. (100 interpolated as today)                                                            |

## Steps

### 1. The vocabulary row

In `src/lib/domain/Orders.ts`, the nouns table at the top. Delete the `import` row. Replace
the `sync` row with:

```
| sync | making Baton's copy of an order agree with Shopify: a webhook (one order, as it happens), the open-orders sync (the button: open, unfulfilled, created in the last 30 days), or the merchant asking for one order | `syncOpenOrders`, `OrdersSyncResult`, `OrdersSyncStatus`, `SyncState`, `SyncOrderInput` | Sync open orders (the orders index); Sync from Shopify (the order page) |
```

Run `pnpm spec check`. It parses this table; fix the column alignment if it refuses.

### 2. Delete `OrderSyncSource`

- `src/lib/domain/Orders.ts`: delete `OrderSyncSource`, its type and its JSDoc.
- `src/lib/agent/Orders.ts`: `fetchAndUpsertOrder` takes `{ orderId }` only; drop `source`
  from the log message and the annotations (the span names the caller).
- `src/lib/agent/ShopWork.ts`: `reconciler` takes no argument; drop `source=` from the
  `ShopAgent.reconcileOrder` log line and its annotations. The one call that passes
  `"manual"` passes nothing.
- `src/lib/ShopAgent.ts`: `reconcilerFor(source)` becomes `reconciler` (or inline it);
  `fetchAndUpsertOrder(orderId, source)` becomes `fetchAndUpsertOrder(orderId)`; the webhook
  path, `resyncOrder` and `onOrdersStream` drop their argument.
- Any test that asserts on a `source` annotation: drop the assertion, record it under
  Deviations and issues if the test then says nothing.

### 3. Identifiers

The Names table, top to bottom. `syncOrders` → `syncOpenOrders` touches `ShopAgent.ts` (the
method, its JSDoc, its log span and `{@link}`s from the tracking JSDoc, `onWorkflowError`,
`resyncOrder`'s JSDoc), `app.orders.index.tsx` (`agent.stub.syncOrders()`),
`OrdersSyncWorkflow.ts` and `OrderRepository.ts` and `domain/Platform.ts` and
`domain/Billing.ts` (`{@link}` and backticked mentions), `orders-sync-workflow.test.ts`,
`shop-agent-callables.test.ts`, and the `e2e/orders.spec.ts` header comment.

`resyncOrder` → `syncOrder` touches `ShopAgent.ts`, `app.orders.$orderId.tsx`,
`shop-agent-callables.test.ts`, `shop-agent-usage-flush.test.ts`.

`importInFlight` → `syncInFlight` touches the `ShopAgentHost` service in `agent/Host.ts`,
the constructor in `ShopAgent.ts`, and `agent/ShopWork.ts` where `OrdersIndexData.syncState`
is built.

### 4. Copy, triggers cells, test titles

- The Copy table above, except the last row (step 5).
- `src/lib/domain/ShopWork.ts`, the triggers table on `reconcileItem`: the trigger cells
  "Import open orders" → "Sync open orders", "Resync from Shopify" → "Sync from Shopify".
- `src/lib/domain/Billing.ts`, the triggers table on `ShopUsage`: the pinned title "a
  re-sync never queues a second count" → "a second sync never queues a second count", and the
  test with that title (grep for it under `test/`).
- Test titles:

| file                                                | after                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `e2e/orders.spec.ts`                                | orders screen syncs open orders and lists them                          |
| `e2e/orders.spec.ts`                                | locators `Sync open orders`, `/^Syncing/`, `Sync from Shopify`          |
| `test/integration/orders-sync-workflow.test.ts`     | refuses a second sync while one is tracked as running                   |
| `test/integration/orders-sync-workflow.test.ts`     | a tracking row disables Sync open orders only while it is fresh         |
| `test/integration/orders-sync-workflow.test.ts`     | a tracked sync whose instance is gone is cleared on the next click      |
| `test/integration/orders-sync-workflow.test.ts`     | the sync query is fixed: open, unfulfilled, created in the last 30 days |
| `test/integration/order-repository.test.ts`         | records the last completed sync and the last error                      |
| `test/integration/order-repository.test.ts`         | clears the error the next sync is about to supersede                    |
| `test/integration/shop-agent-orders-stream.test.ts` | caps an order's line items and flags it rather than failing the sync    |
| `test/integration/shop-agent-usage-flush.test.ts`   | syncing one order sends the usage queue, even when the sync fails       |
| `test/integration/spec.test.ts`                     | the fixture `ResyncOrderCommand` → `SyncOrderCommand` (and its message) |

Run `pnpm spec check`: it refuses a pinned title no test carries.

### 5. Move the ceiling message

The string `syncOpenOrders` writes to `SyncState.lastError` when `cycleAtOrderCeiling` is
true reaches the orders index as a banner, but `src/lib/ShopAgent.ts` is not on the copy
lint's file list (`scripts/lib/copy-files.ts`). Put the string where the lint reads it:

- Add an exported constant to `src/components/QuotaBanners.tsx` beside the banner copy it
  belongs with, for example `ORDER_CEILING_SYNC_REFUSED`, built the way the banner builds its
  own string (interpolating `Domain.ShopLimits.maxOrdersPerCycle` through `formatNumber`).
- `ShopAgent.ts` imports it and passes it to `setSyncError`. Check that importing a
  `.tsx` module into the object does not pull React into the Worker bundle; if it does,
  put the constant in `src/lib/Screen.ts` instead, or add a `src/lib/quotaCopy.ts` and add it
  to `copyFiles()` in `scripts/lib/copy-files.ts`. Record which under Deviations and issues.
- The new text: "Baton is built for shops under 100 orders a billing cycle; syncing resumes
  when the billing cycle ends."

### 6. JSDoc and comments

`grep -rn -i '\bimport\(ing\|ed\|s\)\?\b\|re-\?sync' src test e2e --include='*.ts'
--include='*.tsx'`, skipping `import` statements and the map's "may import" cells. Reword
each hit: "the import" → "the sync" or "the open-orders sync" where the scope matters, "a
resync" → "a one-order sync" or "the merchant's sync". The files and counts are in the
research doc's inventory. Also:

- `src/routes/app.orders.index.tsx`: "the window-sync button" → "the Sync open orders
  button".
- `src/lib/domain/ShopWork.ts`: "every historical order the window sync pulls in" → "every
  historical order the open-orders sync pulls in".
- `src/lib/domain/Orders.ts`, the JSDoc on `OrdersSyncStatus`: `IMPORT_STALE_MS` →
  `SYNC_STALE_MS`.
- `src/lib/ShopAgentSchema.ts`, the SQL comment on `SyncState`: "What the last import left
  behind" → "What the last sync left behind".

A JSDoc on a symbol whose name changed keeps its reasoning; only the words move.

### 7. Retire the words

In `scripts/lib/rules-lint.ts`:

- `RETIRED` gains `/\bimport(?:s|ed|ing)?\b/iu` and `/\bre-?sync(?:s|ed|ing)?\b/iu`. Add two
  rows to the first table in the file's JSDoc: `import, imports, importing` — "the word is
  sync: Baton's copy agreeing with Shopify; import is Shopify's word for `orderCreate`";
  `resync` — "the word is sync at one-order scope; the button is Sync from Shopify".
- `RESERVED_STEMS` gains `"import"` and `"resync"`, with rows in its table: "retired; the
  word is sync". Run `pnpm lint` and confirm the only hits were the two renamed exports.

In `test/integration/rules-lint.test.ts`, under "a retired word stays off every merchant and
member screen", add `it("import and resync are retired words in screen copy", …)` in the
shape of the `staff` case; under "an exported identifier carries no reserved stem", add
`it("an export named ORDER_IMPORT_WINDOW_DAYS is refused", …)` and one for
`ResyncOrderInput`, in the shape of the `ProductionAgent` case.

### 8. Verify

```bash
pnpm typecheck
pnpm lint
pnpm spec check
pnpm test
pnpm vocab:audit      # `resync` gone; `import` absent; `bulk`, `stream`, `poll` still listed and fine
pnpm fmt
npm run test:e2e -- orders   # needs the dev server and a sandbox with at least one open order
```

`grep -rn -i 'resync\|\bimport\(ing\|ed\)\b' src test e2e --include='*.ts' --include='*.tsx'`
should return only `import` statements and the map's "may import" cells.

## Done when

- One `sync` row in the Orders vocabulary; no `import` row.
- No `OrderSyncSource`.
- The orders index says Sync open orders and Syncing…; the order page says Sync from Shopify
  and "older than 30 days".
- `pnpm lint` refuses "import" and "resync" in copy and in exports, with tests.
- `pnpm typecheck`, `pnpm lint`, `pnpm spec check`, `pnpm test` green; the orders e2e passes
  against the sandbox.
- The ceiling message is in a file the copy lint reads.

## Deviations and issues

Record here anything that did not go as the plan says: a step that needed a behaviour
change, a file the inventory missed, a test that had to change in a way the titles table
does not show, a lint hit the plan did not predict, a choice between the options in step 5.
One bullet each: what the plan said, what was found, what was done.

- Step 3, `resyncOrder` → `syncOrder`: the plan missed that `ShopAgent.syncOrder` already
  existed as the webhook RPC (`/webhooks/orders`, `OrderWebhookInput`, role `rpc`). Decided
  with the user: the webhook RPC became `syncOrderWebhook` (method, log span and messages,
  `webhooks.orders.ts`, `shop-agent-orders-ceiling.test.ts`); the merchant's callable is
  `syncOrder` as planned.
- Step 1, the vocabulary row: `pnpm spec check` refused `syncOpenOrders` in the symbol cell
  because a symbol must occur in `domain/Orders.ts` outside the table, and the callable lives
  in `ShopAgent.ts`. The `OrdersSyncResult` JSDoc now names it ("the Sync open orders button
  is told it did (`ShopAgent.syncOpenOrders` answers it)"), which satisfies the check.
- Step 5: took the third option, `src/lib/quotaCopy.ts` (`ORDER_CEILING_SYNC_REFUSED`), added
  to `copyFiles()`. React is already in the Worker bundle (SSR and the object share it), so
  importing `QuotaBanners.tsx` would not have added React; it was rejected because it would
  make the object depend on a JSX component module. The number now goes through
  `formatNumber` instead of `toLocaleString("en-US")`; same output.
- Step 2: no test asserted on a `source` annotation; nothing to drop.
- Step 6: also reworded `test/integration/domain.test.ts` ("history the window sync pulls in"
  → "history the open-orders sync pulls in"), a title the plan's inventory missed, and
  renamed the usage-flush test's shop `flush-resync.myshopify.com` →
  `flush-sync-order.myshopify.com` and its local `resynced` → `synced`.
- Step 7, and an open issue in the copy lint: the copy test's first draft put
  "Importing… this page updates as orders arrive." on its own line of JSX text, and the lint
  did not flag it. `copyOf` in `scripts/lib/rules-lint.ts` reads such a line only when the
  whole line matches `^[A-Za-z][A-Za-z0-9 '’.,:;!?—–-]*$`; "…" is not in the class, so the
  line is skipped and a retired word on it goes through. The same holds for any other
  character outside the class (parentheses, double quotes, `&`, `/`, `%`). Copy inside a
  string literal or between tags on one line is still read, which is how the orders index
  writes "Syncing…", so no screen in this change is affected. The fixture now uses "Importing
  orders from Shopify."; the lint is unchanged. Fix: widen the class with the prose
  punctuation the screens use ("…", parentheses, quotes) and add a test with "…" on a JSX text
  line.
- Step 8: `pnpm typecheck`, `pnpm lint`, `pnpm spec check`, `pnpm test` (593) green;
  `npm run test:e2e -- orders` 17 passed against `sandbox-shop-00`. The final grep leaves
  only the module-import sense ("Shop work importing Billing" on `ShopAgentHost`, and the
  rules-lint sources and tests).

Review, 2026-10-01:

- Step 1, revisited: the JSDoc workaround was not needed. `pnpm spec check` skips a dotted
  symbol, and other rows already name an out-of-context symbol qualified
  (`RunRepository.reconcileOrder`, `ShopWorkAgent.reconcileAllNow`). The cell now says
  `ShopAgent.syncOpenOrders` and the `OrdersSyncResult` JSDoc is back to the plan's wording.
- Step 3, missed: the local `runningImports` inside `syncOpenOrders` kept the retired word;
  the lint reads only exports and copy. It returns the Agents SDK's tracking rows for the
  open-orders sync workflows in flight, so it is `trackedSyncs`, the JSDoc's word ("tracked
  as running").
- Step 7, the copy-lint gap: the JSX text class now takes `“ ” … ( ) & %`, with a test. The
  ASCII double quote stays out on purpose: with its braces blanked, `import { X } from "y";`
  would read as copy and every route file would fail. A dry run with the widened class
  against `main` found no hidden hit.
- The word webhook: `pnpm vocab:audit` lists it (`WebhookDelivery`, `syncOrderWebhook`) and
  the `sync` row's meaning uses it. The map in `Domain.ts` already rules on it: a mechanism
  column (`webhookId`, ...) names no concept and has no row. So it is a code word, not a
  vocabulary word, and goes on `scripts/vocab-allowlist.txt` with that reason; no row. Same for
  delivery (`WebhookDelivery`, one webhook as Shopify delivered it).

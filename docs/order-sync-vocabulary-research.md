# Order sync: the vocabulary, and the change from "import"

Written 2026-09-30 against `main` at `72c8e25`, revised the same day after review. Decided in
the review of `docs/orders-import-research.md`: the vocabulary word for the open-orders
operation is **sync**, not import. Decided in the review of this doc: **one word, sync, for
one order too**; "resync" goes with "import". This doc is the inventory of what that touches
and the questions that remain. The procedure is `docs/vocabulary-runbook.md`; this is its
worked input.

## The short version

Today the Orders vocabulary has two rows, **import** (the bulk fetch, the button) and **sync**
(writing one order), and the one-order button says Resync. The code says sync almost
everywhere and the screens say import and resync. The decision collapses all of it into one
word at two scopes:

- **sync**: making Baton's copy of an order agree with Shopify. Three ways it happens: a
  webhook (one order, as it happens), the open-orders sync (the orders index button: open,
  unfulfilled, last 30 days), and the merchant asking for one order (the order page button).
- **import** and **resync** are retired. `scripts/lib/rules-lint.ts` refuses both in screen
  copy and in exported identifiers.

The change is words: one vocabulary row rewritten, one deleted, eight copy strings, nine
identifiers, ten test titles, two triggers-table cells, about fifty JSDoc lines, and one
`Schema.Literals` cut. No schema edit, no behaviour change. One inconsistency it fixes on the
way: the quota banner already says "Syncing resumes on" while the error the same ceiling
writes says "importing resumes".

## The row

Before, in `src/lib/domain/Orders.ts`:

| word   | meaning                                                                          | symbol                          | screen              |
| ------ | -------------------------------------------------------------------------------- | ------------------------------- | ------------------- |
| import | the bulk fetch of the shop's open orders from Shopify                            | `OrdersSyncResult`, `SyncState` | Import open orders  |
| sync   | writing one Shopify order into the object, from a webhook, an import or a resync | `OrderSyncSource`               | Resync from Shopify |

After:

| word | meaning                                                                                                                                                                                            | symbol                                                                                  | screen                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| sync | making Baton's copy of an order agree with Shopify: a webhook (one order, as it happens), the open-orders sync (the button: open, unfulfilled, last 30 days), or the merchant asking for one order | `syncOpenOrders`, `OrdersSyncResult`, `OrdersSyncStatus`, `SyncState`, `SyncOrderInput` | Sync open orders (the orders index); Sync from Shopify (the order page) |

The map (`src/lib/Domain.ts`) needs no Shared words row: sync belongs to Orders alone. Shop
work's JSDoc names the sync as a reconcile trigger, which is naming a thing in another
context, not sharing the word.

## What the word carries, so the row can be checked against it

| fact                                                     | how "sync" says it                                         |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Shopify is the source of record; Baton holds a copy      | sync is one-way by Shopify's own usage for apps            |
| the button is the same on every press and safe to repeat | a sync is repeatable by definition                         |
| it is for a newly installed shop and as a repair         | "Sync open orders" reads as "make the list right now"      |
| it is not mandatory; webhooks fill Baton on their own    | the help text says webhooks keep orders current afterwards |
| the order page has the same operation at one-order scope | Sync from Shopify: the same word, the page says the scope  |
| the scope is open, unfulfilled, last 30 days             | "open orders" on the button; the 30 days in the help text  |

The one reading "sync" invites that is false is "continuous": a merchant may expect the button
to keep running. The empty-state body answers it in the same sentence. Nothing else in the
app uses "sync" to mean a background process the merchant controls.

## `OrderSyncSource`: cut it

`OrderSyncSource` is `Schema.Literals(["webhook", "bulk", "manual"])`. It is never stored and
never on screen. It is passed into `fetchAndUpsertOrder` and `ShopWorkAgent.reconciler` and
read in exactly two places, both log lines: `ShopAgent.fetchAndUpsertOrder: … source=…` and
`ShopAgent.reconcileOrder: … source=…`. Its own JSDoc says "diagnostic, not control flow".

It is redundant. Every path already runs under a log span that names the caller:
`callableEffect` wraps each callable in `Effect.withLogSpan(name)`, so the webhook path, the
`resyncOrder` callable and `onOrdersStream` each stamp their name on every log line beneath
them. `source=bulk` says less than the span `ShopAgent.onOrdersStream` beside it.

Deleting it removes: the literals (two of which, `bulk` and `manual`, are not vocabulary
words), the `source` parameter on `fetchAndUpsertOrder`, `reconcilerFor` and `reconciler`,
and the two `source=` fields. Nothing else moves. Recommendation: delete, in the same change.

## The inventory

### Screen copy

Eight strings. The lint reads the route and component files (`scripts/lib/copy-files.ts`), so
a retired word would fail `pnpm lint` on each until changed.

| file                          | slot                    | today                                                                                                                                                                                              | proposed                                                                                                                                                                                       |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.orders.index.tsx`        | button (twice)          | Import open orders                                                                                                                                                                                 | Sync open orders                                                                                                                                                                               |
| `app.orders.index.tsx`        | empty-state body        | Import open orders to pull in what is on the bench, or wait for the next order. The import takes the open, unfulfilled orders from the last 30 days; after that, order webhooks keep them current. | Sync open orders to pull in what is on the bench, or wait for the next order. The sync takes the open, unfulfilled orders from the last 30 days; after that, order webhooks keep them current. |
| `app.orders.index.tsx`        | status line             | Importing… this page updates as orders arrive.                                                                                                                                                     | Syncing… this page updates as orders arrive.                                                                                                                                                   |
| `app.orders.index.tsx`        | status error            | Couldn't read import status.                                                                                                                                                                       | Couldn't read sync status.                                                                                                                                                                     |
| `app.orders.index.tsx`        | toast                   | Couldn't start the import.                                                                                                                                                                         | Couldn't start the sync.                                                                                                                                                                       |
| `app.orders.$orderId.tsx`     | button                  | Resync from Shopify                                                                                                                                                                                | Sync from Shopify                                                                                                                                                                              |
| `app.orders.$orderId.tsx`     | body (not found)        | This order isn't in Baton. It may be older than the import window, or deleted in Shopify.                                                                                                          | This order isn't in Baton. It may be older than 30 days, or deleted in Shopify.                                                                                                                |
| `ShopAgent.ts` (`syncOrders`) | banner, via `lastError` | Baton is built for shops under 100 orders a billing cycle; importing resumes when the billing cycle ends.                                                                                          | Baton is built for shops under 100 orders a billing cycle; syncing resumes when the billing cycle ends.                                                                                        |

Notes:

- The `lastError` string lives in `src/lib/ShopAgent.ts`, which the copy lint does not read.
  Decided: move it out of the object so the lint sees it (the plan below, step 5).
- "older than the import window": "sync window" is on the implementer's-words list in
  `src/lib/Screen.ts`, so "older than the sync window" is out too. Decided: say the number,
  interpolating the window constant as the empty-state body already does.
- `Screen.ts`'s copy table has no example that says import or resync, so `pnpm spec check`
  needs no row change. The QuotaBanners strings already say sync.

### Identifiers

Nine. The Workflow, the result and status types and the `SyncState` table already carry the
word, so there is no schema edit and no `pnpm dev:reset`.

| today                                  | file                                                                       | proposed                 | note                                                           |
| -------------------------------------- | -------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------- |
| `syncOrders` (callable)                | `ShopAgent.ts`, `app.orders.index.tsx`, tests                              | `syncOpenOrders`         | see question 1: one letter from `syncOrder` otherwise          |
| `resyncOrder` (callable)               | `ShopAgent.ts`, `app.orders.$orderId.tsx`, tests                           | `syncOrder`              |                                                                |
| `ResyncOrderInput`                     | `domain/Orders.ts`, `ShopAgent.ts`                                         | `SyncOrderInput`         | `RESERVED_STEMS` would refuse it as is                         |
| `resyncMutation`                       | `app.orders.$orderId.tsx`                                                  | `syncMutation`           | local; the lint does not read it, renamed for the grep         |
| `ORDER_IMPORT_WINDOW_DAYS`             | `orderSyncConstants.ts`                                                    | `ORDER_SYNC_WINDOW_DAYS` | the one export with the stem; `RESERVED_STEMS` would refuse it |
| `IMPORT_IN_FLIGHT`                     | `ShopAgent.ts`                                                             | `SYNC_IN_FLIGHT`         |                                                                |
| `IMPORT_STALE_MS`                      | `ShopAgent.ts`                                                             | `SYNC_STALE_MS`          | named in the JSDoc on `OrdersSyncStatus`                       |
| `importRowIsFresh`                     | `ShopAgent.ts`                                                             | `syncRowIsFresh`         |                                                                |
| `importStarting`                       | `ShopAgent.ts` (private field)                                             | `syncStarting`           |                                                                |
| `importInFlight`                       | `agent/Host.ts`, `ShopAgent.ts`, `agent/ShopWork.ts`                       | `syncInFlight`           | the `ShopAgentHost` service field                              |
| `OrderSyncSource`, `source` parameters | `domain/Orders.ts`, `agent/Orders.ts`, `agent/ShopWork.ts`, `ShopAgent.ts` | deleted                  | see above                                                      |

Left as they are, on purpose:

| identifier                                                       | why                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `OrdersSyncWorkflow`, `ORDERS_SYNC_WORKFLOW`, `OrdersSyncParams` | already the word; the binding name in `wrangler.jsonc` is unchanged     |
| `OrderSync.ts`, `orderSyncQuery`, `OrderSyncResponse`            | the one-order fetch both paths share; the word fits                     |
| `ShopOrder.syncedAt`                                             | a mechanism column (the map lists it so)                                |
| `OrdersBulkRepository`, `bulkOrdersQueryText`, `BULK_*`          | Shopify's word for the operation; the audit's `bulk` stays a JSDoc term |
| `onOrdersStream`, `runShopAgentOrdersStream`                     | mechanism; no vocabulary row                                            |

### Test titles and locators

Ten titles, three locators. `pnpm spec check` refuses a `pinned by` title no test carries, so
the ShopWork triggers rows and the tests they pin move together.

| file                                                | today                                                                     | proposed                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `e2e/orders.spec.ts`                                | orders screen imports open orders and lists them                          | orders screen syncs open orders and lists them                          |
| `e2e/orders.spec.ts`                                | locators `Import open orders`, `/^Importing/`, `Resync from Shopify`      | `Sync open orders`, `/^Syncing/`, `Sync from Shopify`                   |
| `test/integration/orders-sync-workflow.test.ts`     | refuses a second import while one is tracked as running                   | refuses a second sync while one is tracked as running                   |
| `test/integration/orders-sync-workflow.test.ts`     | a tracking row disables Import open orders only while it is fresh         | a tracking row disables Sync open orders only while it is fresh         |
| `test/integration/orders-sync-workflow.test.ts`     | a tracked import whose instance is gone is cleared on the next click      | a tracked sync whose instance is gone is cleared on the next click      |
| `test/integration/orders-sync-workflow.test.ts`     | the import query is fixed: open, unfulfilled, created in the last 30 days | the sync query is fixed: open, unfulfilled, created in the last 30 days |
| `test/integration/order-repository.test.ts`         | records the last completed import and the last error                      | records the last completed sync and the last error                      |
| `test/integration/order-repository.test.ts`         | clears the error the next import is about to supersede                    | clears the error the next sync is about to supersede                    |
| `test/integration/shop-agent-orders-stream.test.ts` | caps an order's line items and flags it rather than failing the import    | caps an order's line items and flags it rather than failing the sync    |
| `test/integration/shop-agent-usage-flush.test.ts`   | resyncing an order sends the usage queue, even when the resync fails      | syncing one order sends the usage queue, even when the sync fails       |
| `test/integration/shop-agent-callables.test.ts`     | the role table row `resyncOrder: "merchant"`                              | `syncOrder: "merchant"`                                                 |
| `test/integration/spec.test.ts`                     | fixture name `ResyncOrderCommand` (a made-up shape in a parser test)      | `SyncOrderCommand`, so the grep comes back clean                        |

The ShopWork triggers table (`reconcileItem` in `src/lib/domain/ShopWork.ts`): the trigger
cells "Import open orders" and "Resync from Shopify" become "Sync open orders" and "Sync from
Shopify". The Billing triggers table pins "a re-sync never queues a second count"; that title
and its test become "a second sync never queues a second count".

### JSDoc and comments

About fifty lines, by file, all saying "the import" or "a resync" where the word is now "the
sync", "the open-orders sync" or "a one-order sync". None states a rule that moves; they are
the prose around the rules.

| file                                 | lines | what they say                                                                |
| ------------------------------------ | ----- | ---------------------------------------------------------------------------- |
| `src/lib/ShopAgent.ts`               | 20    | the tracking rules, `syncOrders`, `resyncOrder`, the stream, the sweep       |
| `src/routes/app.orders.$orderId.tsx` | 4     | the button's JSDoc, the subscription comment                                 |
| `src/lib/OrderRepository.ts`         | 10    | `SyncState` accessors, the upsert's retention clause, "resync all"           |
| `src/lib/domain/Orders.ts`           | 11    | the rows, `SyncState`, `OrdersSyncStatus`, `OrdersSyncResult`, `productTags` |
| `src/routes/app.orders.index.tsx`    | 5     | the status line, the button, "window-sync button"                            |
| `src/lib/domain/ShopWork.ts`         | 8     | reconcile's trigger list and the triggers table cells                        |
| `src/lib/agent/Billing.ts`           | 5     | the flush's callers                                                          |
| `src/lib/OrdersBulkRepository.ts`    | 3     | the query's JSDoc                                                            |
| `src/lib/orderSyncConstants.ts`      | 2     | the window and the poll interval                                             |
| `src/lib/OrdersSyncWorkflow.ts`      | 2     | `run`'s JSDoc, the cancel comment                                            |
| `src/lib/domain/Billing.ts`          | 2     | the ceiling's JSDoc                                                          |
| `src/lib/domain/Platform.ts`         | 2     | the sweep, `storageSoftLimitBytes`                                           |
| `src/lib/agent/ShopWork.ts`          | 2     | the reconciler's callers                                                     |
| `src/lib/agent/Orders.ts`            | 2     | `fetchAndUpsertOrder`                                                        |
| `src/lib/agent/Host.ts`              | 1     | `importInFlight`                                                             |
| `src/lib/OrderSync.ts`               | 1     | "every manual resync"                                                        |
| `src/lib/ShopAgentSchema.ts`         | 1     | the SQL comment on `SyncState`                                               |
| `src/lib/ShopAgentOrdersStream.ts`   | 1     | the cap comment                                                              |
| `src/routes/webhooks.orders.ts`      | 1     | "the manual import"                                                          |
| `e2e/orders.spec.ts`                 | 5     | the header comment                                                           |

Two JSDoc phrases are wrong today independent of the rename and go in the same pass:
"the window-sync button" (`app.orders.index.tsx`) and "the window sync pulls in"
(`domain/ShopWork.ts`), since `Screen.ts` lists "sync window" as an implementer's phrase.

### The lint and its test

- `RETIRED` in `scripts/lib/rules-lint.ts` gains `/\bimport(?:s|ed|ing)?\b/iu` and
  `/\bre-?sync(?:s|ed|ing)?\b/iu`. The checker reads string literals and JSX text only, never
  `import` statements or comments, so the statement keyword is not a hit. The one template
  literal with `import.meta.env` is on an admin route, which the copy list excludes, and its
  interpolation is blanked anyway.
- `RESERVED_STEMS` gains `import` and `resync`, with rows in its table: "retired; the word is
  sync". The exports carrying a stem today are `ORDER_IMPORT_WINDOW_DAYS` and
  `ResyncOrderInput`, both renamed above.
- `test/integration/rules-lint.test.ts` gains a case for each.
- `scripts/vocab-allowlist.txt` is unchanged: the words are retired, not allowlisted, so a
  future identifier that says one shows up in the audit.

### Documents

`docs/orders-import-research.md` is dated and stays as written, per the runbook. It already
records the decision. The two reconcile docs mention "Import open orders" and "Resync from
Shopify" in trigger lists; they are dated research and stay.

## Order of work

1. The row in `src/lib/domain/Orders.ts`: rewrite sync, delete import.
2. Delete `OrderSyncSource` and the `source` parameters and log fields.
3. The nine identifiers.
4. The eight copy strings, the two triggers-table cells, the ten test titles and the
   locators.
5. Move the ceiling message out of `ShopAgent.ts` into a file the copy lint reads (a
   constant beside the QuotaBanners copy, or in `Screen.ts`), and have `syncOpenOrders`
   import it.
6. The JSDoc lines, including the two "window sync" phrases.
7. `RETIRED`, `RESERVED_STEMS`, their tables, the lint test cases.
8. `pnpm typecheck`, `pnpm lint`, `pnpm spec check`, `pnpm test`, `pnpm vocab:audit` (expect
   `resync` gone from the list), `pnpm fmt`.
9. `npm run test:e2e -- orders` against the sandbox for the renamed locators.

## Decisions

Reviewed 2026-09-30:

1. The word is **sync**; "import" is retired.
2. One word for one order too; "resync" is retired. The order page button is **Sync from
   Shopify**.
3. The orders index button is **Sync open orders**.
4. The ceiling message moves out of `ShopAgent.ts` into a file the copy lint reads, as part
   of this change.
5. The order page's not-found body says the number of days, not "window".
6. The index callable is **`syncOpenOrders`**; the one-order callable is **`syncOrder`**.
7. **`OrderSyncSource` is deleted**, with its `source` parameters and log fields. The log
   span names the caller.
8. `docs/orders-import-research.md` keeps its name.

The implementation plan is `docs/order-sync-vocabulary-plan.md`.

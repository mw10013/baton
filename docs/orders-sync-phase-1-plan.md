# Orders sync — phase 1 plan

Execution plan for `docs/shop-agent-orders-sync-research.md` (all decisions and evidence live there; this doc is order + touchpoints). Written 2026-09-02 for hand-off to an implementer who has not read the conversation.

Prototyping stance: no migration sequence — edit the `ShopAgent` schema in place and reset (`pnpm d1:reset` for D1; the DO's private SQLite resets when the object is destroyed or `.wrangler` is wiped). Nothing is deployed to staging/production.

Reference implementation to port from: `/Users/mw/Documents/src/motio` (same stack: TanStack Start, Cloudflare, Effect v4, `agents` 0.20.x, `@effect/sql-sqlite-do`). Port the mechanics, not the product: motio scans products and clears/rebuilds; Baton syncs orders and merges.

## Decisions (do not relitigate)

- Two ingestion paths, one upsert: webhook → single-order GraphQL fetch → upsert; button → Cloudflare Workflow → Shopify bulk operation → NDJSON streamed inside the DO → same upsert.
- Bulk completion by **polling** `bulkOperation(id:)` from the workflow. No `bulk_operations/finish` webhook.
- Trigger is a manual "Sync last 30 days" button, `@callable()` on the DO over the authenticated socket. No install hook, no timer, no staleness check yet.
- Workflow started with `this.runWorkflow(...)` (agents SDK tracking on), fresh id per run, singleton enforced by `SyncState`. Not motio's direct-binding/fixed-id bypass.
- No customer data: no `customer`, `shippingAddress`, email, phone. Line-item `customAttributes` and order `note` stay.
- Scopes `write_orders,read_products`, declared in `shopify.app.toml`; merchant approves on next open. The Partner Dashboard protected-customer-data declaration **is** required, dev store included — it gates the order webhook subscriptions at `app deploy`, not just query redaction (research doc, "Protected Customer Data Gates Order Webhooks").
- Constants: `ORDER_SYNC_WINDOW_DAYS = 30`, `ORDER_SYNC_OVERLAP_MS = 15 min`, `BULK_POLL_ATTEMPTS = 24` (5 s ×3, 15 s ×3, then 30 s).
- Streaming is constant-memory by construction; never buffer the file.
- Deferred, do not build: paid-gate logic, routing, edit/cancel policies, fulfillment/tracking tables, `orders/edited`, `refunds/create`, `read_customers`, `read_all_orders`.

## Milestones

- **A — Bulk sync lands rows.** Button → workflow → NDJSON → `ShopOrder` + `OrderLineItem` visible on `/app/orders`. First visible win; needs no webhook plumbing.
- **B — Webhooks keep rows fresh.** Place/pay/cancel an order on the sandbox and watch the row change without clicking.
- **C — Tests green.** Integration (stream, workflow shape, webhook route, repository) + one e2e click-through.

## Steps

### 1. Config

- `shopify.app.toml`: `[access_scopes] scopes = "write_orders,read_products"`; one `[[webhooks.subscriptions]]` with `uri = "/webhooks/orders"`, `topics = ["orders/create","orders/updated","orders/paid","orders/cancelled","orders/fulfilled","orders/partially_fulfilled","orders/delete"]`, `include_fields = ["id","admin_graphql_api_id","updated_at"]`. Keep the existing compliance / scopes_update / uninstalled blocks.
- `wrangler.jsonc`: `"workflows": [{ "binding": "ORDERS_SYNC_WORKFLOW", "name": "baton-orders-sync-local", "class_name": "OrdersSyncWorkflow" }]` at top level and in `env.staging` / `env.production` with `-staging` / `-production` names (shape: `../motio/wrangler.jsonc:33-39,79-85,131-137`). Run `pnpm typecheck` so `worker-configuration.d.ts` gains the binding.
- `src/worker.ts`: `export { OrdersSyncWorkflow } from "@/lib/OrdersSyncWorkflow";` (motio `src/worker.ts:22`).
- `src/lib/shopifyConstants.ts` (or a new `orderSyncConstants.ts`): the three constants above.
- **Before any deploy:** Partner Dashboard → the app → **Distribution** (select a method if unset) → **API access requests** → **Protected customer data access** → **Request access**; select **Protected customer data**, give reasons, complete Data protection details. Do not tick "My app won't use customer data". Level 1 only — Baton selects no name/address/email/phone field anywhere. Without this, `pnpm app:deploy` refuses to create a version with six "not approved to subscribe to webhook topics containing protected customer data" errors (one per order topic; `orders/delete` is exempt).
- With `pnpm app:dev` running, saving the toml pushes scopes + subscriptions; open the app on `sandbox-shop-01` and approve the prompt. `app/scopes_update` fires into the existing handler.

### 2. Schema + domain + repository (milestone A)

- `src/lib/ShopAgent.ts` `initializeSchema` (or a `"2_orders"` entry in `SqliteMigrator.fromRecord`): tables exactly as in the research doc "Proposed Schema" — `ShopOrder` (not `Order`, reserved word), `OrderLineItem` (+ index on `orderId`), `WebhookDelivery`, `SyncState` (singleton row, `check (id = 1)`, seeded). Epoch-ms integers, `0/1` booleans, JSON in `text`. Add `workflowId text` to `SyncState` (the reservation, see step 4).
- `src/lib/Domain.ts`: `ShopOrder`, `OrderLineItem`, `SyncState`, `OrderSyncSource = Literals(["webhook","bulk","manual"])`, `OrdersPage` (list + counts) schemas. Decode rows through them like `Counter`.
- `src/lib/OrderRepository.ts`: `Context.Service` over the DO's `SqlClient`, mirroring `CounterRepository` (`layer` requiring `SqlClient.SqlClient`, tagged `OrderRepositoryError` for decode failures, `Effect.fn("OrderRepository.<op>")`). Ops:
  - `upsertOrder({ order, lineItems, source, syncedAt })` — `insert … on conflict(id) do update set … where excluded.updatedAt >= ShopOrder.updatedAt`; then delete line items for that order not in the new set and upsert the rest. Run inside one `sql.withTransaction` so a webhook fetch cannot interleave half an order.
  - `deleteOrder(id)`, `getOrder(id)`, `listOrders({ limit, cursor })` (newest `processedAt` first), `countOrders()`.
  - `recordWebhookDelivery({ webhookId, topic, orderId, triggeredAt, receivedAt })` → `insert or ignore`, return whether it was new.
  - `getSyncState()`, `reserveSync({ workflowId, startedAt, windowStart })`, `completeSync({ startedAt })`, `failSync({ error })`, `clearSync()`.
- Wire `OrderRepository.layer` into `makeRunEffect`'s `durableRepositoryLayer` next to `CounterRepository`.

### 3. GraphQL documents

All in `#graphql` template literals so `pnpm graphql-codegen` validates them (`.graphqlrc.ts`). Text is in the research doc "GraphQL" section (already validated 2026-10; `shippingAddress` removed by decision).

- `OrderSync($id)` — `order(id:)` with `lineItems(first: 50)`.
- The **named** bulk document `BulkOrdersQuery` — same selections wrapped in `orders(query: $q) { edges { node { __typename … lineItems { edges { node { __typename … } } } } } }`. Select `__typename` on both levels; the NDJSON line schemas tag on it. `first`/`pageInfo` are ignored by bulk; omit them. The `query:` string is interpolated per run (`created_at:>=` on first sync, `updated_at:>=` afterwards), so build the document text with the filter substituted before passing it as the mutation variable — the codegen-validated literal can hold a placeholder filter.
- `OrdersBulkSync($query)` — `bulkOperationRunQuery(query: $query, groupObjects: false) { bulkOperation { id status errorCode createdAt completedAt objectCount fileSize url partialDataUrl } userErrors { field message } }`.
- `BulkOperationStatus($id)` — `bulkOperation(id:)` same fields.
- Response schemas as `Schema.Struct`s decoded via `ShopifyAdmin.graphqlDecode` (motio `src/lib/ScanBulkRepository.ts` is the template, including its `failUserError` helper).

### 4. Bulk path (milestone A)

Port three motio files, renamed:

- **`src/lib/OrdersBulkRepository.ts`** ← `ScanBulkRepository.ts`: `submit(queryText)`, `findById(id)` → `Option`, `list()`. Requires `ShopifyAdmin`.
- **`src/lib/OrdersSyncWorkflow.ts`** ← `ScanWorkflow.ts`. `export class OrdersSyncWorkflow extends AgentWorkflow<ShopAgent, OrdersSyncParams>` where `OrdersSyncParams = { shop, startedAt, windowStart, field: "created_at" | "updated_at" }`. Keep verbatim: `makeRuntimeLayer` (D1 on primary, `Shopify` + `Repository` + logger; **non-fallible** — motio's JSDoc explains why), `ensure-session` step returning `session.toPropertyArray(true)` (step results must serialize), `provide*` helper building `ShopifyAdmin` from `Layer.succeed(CurrentShopifySession, session)`, `nonRetryable` via `NonRetryableError` from `cloudflare:workflows`, `POLL_ATTEMPTS`/`pollDelay`, the `step.sleep` + `poll-N` loop, `Effect.onError` → durable `on-orders-sync-error` step calling `agent.onOrdersSyncError(message)`, `runtime.dispose()` in `finally`. Change: the submit step builds the bulk document from `params.field`/`windowStart`; on `COMPLETED` call `agent.onOrdersStream({ url: url ?? partialDataUrl })` or `agent.onOrdersSyncEmpty()` when both are null; then `step.reportComplete({ shop, startedAt })`.
- **`src/lib/ShopAgentOrdersStream.ts`** ← `ShopAgentScanStream.ts`. `BulkOrderLine` (`__typename: "Order"`) and `BulkLineItemLine` (`__typename: "LineItem"`, `__parentId`) as `Schema.Union([...]).pipe(Schema.toTaggedUnion("__typename"))`. Pipeline verbatim: `HttpClient.filterStatusOk` + `retryTransient`, `HttpClientResponse.stream(client.get(url))`, `Stream.pipeThroughChannel(Ndjson.decodeSchema(BulkLine)({ ignoreEmptyLines: true }))` (`Ndjson` from `effect/unstable/encoding`), `Stream.mapAccumEffect` holding the current order and appending line items whose `__parentId` matches (fail on mismatch), emitting on the next `Order` line and in `onHalt`, then `Stream.runFoldEffect` calling `repo.upsertOrder(..., source: "bulk")` and counting. Do **not** clear tables first (motio does). Return `{ ordersUpserted, lineItemsUpserted }`.

`ShopAgent` additions (all `runEffect`-wrapped, logging per CLAUDE.md `key=value` style):

- `@callable() syncOrders(): Promise<Domain.SyncState>` — no arguments. Read `SyncState`; if `workflowId` set and `startedAt` within the last hour → return state (in flight). If older, confirm with `this.env.ORDERS_SYNC_WORKFLOW.get(workflowId).status()`; still running → return, terminal/not found → `clearSync` and continue. Compute `startedAt = now`, `field`/`windowStart` per the research pseudo-code, `id = "orders-sync:" + shop + ":" + startedAt`. **`reserveSync` first, then** `this.runWorkflow("ORDERS_SYNC_WORKFLOW", params, { id, agentBinding: "SHOP_AGENT" })`. On throw: `get(id).status()` — exists → keep reservation, swallow; not found → `clearSync`, fail. `notifyChanged()`; return state.
- `onOrdersStream({ url })`, `onOrdersSyncEmpty()`, `onOrdersSyncError(message)` — RPC targets for the workflow (not `@callable()`). Stream one writes `completeSync` is **not** here — completion is the hook below, so a partially streamed file that errors does not mark the sync complete.
- `onWorkflowComplete(name, id, result)` → `completeSync({ startedAt: result.startedAt })`, `this.deleteWorkflow(id)`, `notifyChanged()`. `onWorkflowError(name, id, error)` → `failSync({ error })`, `deleteWorkflow`, `notifyChanged()`. Guard both on `name === "ORDERS_SYNC_WORKFLOW"`.
- `@callable() getOrders(input)` — decode with `callableEffect`, `{ onExcessProperty: "error" }`; returns `Domain.OrdersPage` + `SyncState`.
- Update the JSDoc on `bump` / `getShopInfo` to the refined rule from the research doc ("Button: `@callable()` vs Server Function").

Local Miniflare note: motio's `createLocalScanWorkflow` preflight exists only because motio reuses one instance id. Fresh ids make it unnecessary — do not port it.

### 5. Page (milestone A)

- `src/routes/app.orders.tsx`, modeled on `app.index.tsx`: `useShopAgent()`, `useQuery` keyed `["orders", shop]` calling `agent.stub.getOrders(...)`, `"invalidated"` message listener → `invalidateQueries` (same pattern as `counterQueryKey`), `withSocketRecovery(agent)(() => agent.stub.syncOrders())` on the button. Button disabled while `SyncState.workflowId` is set; show `lastFullSyncAt` / `lastError`. Table: `name`, `processedAt`, `financialStatus`, `fulfillmentStatus`, line-item count, tags. Row expands to line items (`title`, `sku`, `currentQuantity`, `productTags`, `customAttributes`). Per-row "Resync" → `agent.stub.resyncOrder({ orderId })`.
- Link from `app.index.tsx` nav (however the app currently exposes `/app/members`).

### 6. Webhook path (milestone B)

- `src/lib/Shopify.ts` `validateWebhook`: also return `webhookId: validation.webhookId` and `triggeredAt` (present on `WebhookValidationValid`, `refs/shopify-app-js/packages/apps/shopify-api/lib/webhooks/types.ts:182`). Update `handleWebhook`'s handler type and the two existing webhook routes (they can ignore the new fields).
- `src/routes/webhooks.orders.ts`: `handleWebhook` → decode payload with a lax `Schema.Struct({ id: Schema.Number, admin_graphql_api_id: Schema.optional(Schema.String), updated_at: Schema.optional(Schema.String) })`; `orders/delete` → `stub.deleteOrder(id)`; else `stub.syncOrder({ orderId: admin_graphql_api_id ?? "gid://shopify/Order/" + id, topic, webhookId, triggeredAt, updatedAt })`. Return `new Response()`. Any failure propagates → non-2xx → Shopify retries (matches the uninstalled route's stance).
- `ShopAgent.syncOrder(input)` (not `@callable()`): `recordWebhookDelivery` → if not new, return; if `updatedAt` present and `<=` stored `ShopOrder.updatedAt`, return; else `ensureShopSession` → `ShopifyAdmin` (per-call `shopifyAdminLayer`, as `getShopInfo`) → `OrderSync` → `upsertOrder(source: "webhook")` → `notifyChanged()`. `@callable() resyncOrder({ orderId })` is the same with `source: "manual"` and no dedupe/stale checks. `deleteOrder(id)` deletes the row.
- `orders/delete` payload is `{ id }` only; `include_fields` is harmless there.

### 7. Tests (milestone C)

Integration (`pnpm test:integration`, `@effect/vitest`, patterns in `test/integration/`):

- `order-repository.test.ts` — upsert guard: older `updatedAt` does not overwrite; line items replaced as a set; `recordWebhookDelivery` idempotent; `SyncState` transitions.
- `shop-agent-orders-stream.test.ts` ← motio `shop-agent-scan-stream.test.ts`: serve a fixture NDJSON (two orders, three line items, one blank line) through a stubbed `HttpClient`, assert rows and counts; a line item with a mismatched `__parentId` fails the stream; a webhook upsert with a newer `updatedAt` written mid-stream survives.
- `orders-sync-workflow.test.ts` ← motio `scan-workflow.test.ts`: workflow shape with a fake `step` — submit → poll COMPLETED → `onOrdersStream`; empty (null urls) → `onOrdersSyncEmpty`; step exhausts retries → `onOrdersSyncError` sink.
- `shopify-webhook.test.ts` (extend): signed `orders/updated` delivery with `include_fields`-shaped body reaches `syncOrder` with `webhookId`; `orders/delete` reaches `deleteOrder`; duplicate `X-Shopify-Webhook-Id` is a no-op. The DO is out of reach of the in-process fetch stub (see `docs/member-access-phase-1-plan.md` §5), so assert at the route/handler seam with a stubbed `SHOP_AGENT` if needed.
- Drop motio's `agent-workflow-contract.test.ts` — not bypassing the wrapper, nothing to pin.

E2E (`npm run test:e2e --`, `e2e` project): `orders.spec.ts` — open `/app/orders`, click Sync, wait for the button to re-enable and at least one row (sandbox has ~85 orders in the window). Uses the real install; follows `e2e/app.ts` hydration helpers (`data-app-interactive`).

### 8. Verify by hand

1. `pnpm typecheck && pnpm lint && pnpm graphql-codegen && pnpm test:integration`.
2. `pnpm app:dev`; open the app; approve scopes.
3. `/app/orders` → Sync → rows appear; `logs/server.log` shows `OrdersSyncWorkflow` steps and `ShopAgent.onOrdersStream: shop=… ordersUpserted=…`.
4. Place an order on the sandbox → `Webhook received: shop=… topic=orders/create` → row appears without clicking. Mark paid → `orders/paid` → `financialStatus=PAID`, `fullyPaid=1`. Cancel → `cancelledAt` set.
5. Stop the dev server, place an order, restart, Sync → the `updated_at` window picks it up.
6. If order fields come back `null` with a protected-data error in `errors`, the *query* is being redacted — a different gate from the subscription check in step 1, and one dev stores are meant to be exempt from. Re-check the Level 1 declaration, then reinstall. (Research doc, "Protected Customer Data Gates Order Webhooks".)

## Gotchas (from the research + motio)

- Bulk query text must be a named operation in its own literal for codegen; `first`/`pageInfo` omitted.
- `product { id tags }` and `variant { id }` are objects, not connections → inline on the `LineItem` line, no third line type. Max two nested connection levels; we use one.
- Workflow runtime layer must never fail at build; only `step.do` bodies may fail. Step return values must be JSON-serializable (session as property array).
- `HttpClientResponse.stream` + `Ndjson.decodeSchema` never buffers the file; keep it that way (no `.text()`, no `toArray`).
- Webhooks are unordered and retried with the original payload; `updatedAt` guard + `WebhookDelivery` make the path idempotent. Toml subscriptions are never auto-deleted on failure.
- `include_fields` on `orders/updated` **must** include `updated_at` or Shopify debounces identical payloads.
- `runWorkflow` can create the instance and then fail to insert its tracking row; reservation-before-create in `syncOrders` makes that benign (research doc, "If `runWorkflow` Creates But Fails To Track").
- Pass `agentBinding: "SHOP_AGENT"` so origin detection does not rely on `constructor.name` surviving the bundle.
- Store Shopify numeric ids as `text` (JS 52-bit precision through `sql.exec`).
- DO input gate opens during the stream's `fetch`; webhooks interleave. Wrapping each order's upsert in a transaction plus the `updatedAt` guard is what makes that safe.

## Out of scope (phase 2+)

Paid gate and release logic; product-tag routing; edit/cancel/refund policies; fulfillments/tracking; `orders/edited`; staleness trigger on app open; customer data of any kind; `read_all_orders`; moving the stream out of the DO (only if a real shop's file proves too slow inside one RPC).

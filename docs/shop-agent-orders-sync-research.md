# ShopAgent Orders Table And Sync Research

Research date: 2026-09-01, revised 2026-09-02

Scope: get Shopify orders into the `ShopAgent` Durable Object's private SQLite so a Route to Ship-lite production flow can be prototyped against real rows. No migration story — schema resets from scratch. Routing, pipelines, and what to do on cancel are out of scope; see "Policies Deferred".

## Conclusion

- **Two ingestion paths, one upsert.** (1) Order webhook → fetch that one order with `OrderSync` → upsert. (2) Bulk operation over a time window → JSONL → the same upsert per order. No cursor-paginated loops anywhere.
- **Bulk operations are the window-sync primitive.** One `bulkOperationRunQuery` returns every order in the window with line items and product tags as a single NDJSON file, with no query-cost cap and no rate limit. The same query text serves the first sync (`created_at:>=`) and every later resync (`updated_at:>=`). Completion is found by polling `bulkOperation(id:)` — no `bulk_operations/finish` webhook.
- **Orchestrate with a Cloudflare Workflow, stream in the DO — the motio shape.** The sibling project `../motio` already does exactly this with Effect v4: `ScanWorkflow` (an `AgentWorkflow`) submits the bulk op, polls with `step.sleep`, then calls `agent.onScanStream({ url })`; the DO streams the file through `HttpClientResponse.stream` → `Ndjson.decodeSchema` → `Stream.mapAccumEffect` (group children under their `__parentId` parent) → `Stream.runFoldEffect` (upsert). Port `src/lib/ScanWorkflow.ts`, `src/lib/ScanBulkRepository.ts`, and `src/lib/ShopAgentScanStream.ts` rather than redesigning.
- **Trigger = a manual "Sync last 30 days" button, for now**, as a `@callable()` on the DO over the already-authenticated socket (no server-fn hop). The DO refuses if `SyncState` shows a run in flight, otherwise starts a workflow with `this.runWorkflow(...)` under a fresh per-run id. Nothing hangs off token exchange, DO wake, or a timer; the only Shopify polling is the workflow checking the one bulk op it started. A staleness check on app open is a later one-liner.
- **Window is a constant:** `ORDER_SYNC_WINDOW_DAYS = 30`. Anything ≤ 60 works without `read_all_orders`.
- **Paid gate exists in the data, not the trigger.** `fullyPaid: Boolean` and `displayFinancialStatus` (`PAID`, `PARTIALLY_PAID`, `PENDING`, `AUTHORIZED`, …) are stored per order; `orders/paid` is subscribed so the transition arrives promptly. What to *do* when an order becomes paid is deferred until rows exist.
- **Topics:** `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled`, `orders/delete` on one `/webhooks/orders` route with `include_fields = ["id", "admin_graphql_api_id", "updated_at"]`. Skip `orders/edited` and `refunds/create` (non-order payloads; both also fire `orders/updated`). No `bulk_operations/finish`.
- **No customer data.** The product is about making the thing, not shipping it or talking to the buyer. No `customer`, no `shippingAddress`, no email. What stays: order number, timestamps, statuses, order tags/note, line items with `product.tags` and line-item `customAttributes` (the personalization fields a maker needs). That keeps Baton at protected-data Level 1 (orders are still a protected resource) and off `read_customers`.
- **Schema:** `ShopOrder`, `OrderLineItem` (snapshotted `productTags`), `WebhookDelivery` (dedupe), `SyncState` (in-flight bulk op id, last sync). GIDs as text keys; a `raw` JSON column for prototyping (it holds exactly what the query selects, so no customer fields ever land in it).
- **Scopes:** `scopes = "write_orders,read_products"` in `shopify.app.toml`, deployed with `shopify app deploy` (or pushed by `shopify app dev`). Merchants approve required scopes at install; when the list changes, "Merchants are prompted to approve the updated access scopes when they open your app" and `app/scopes_update` fires (`refs/shopify-docs/docs/apps/build/authentication-authorization/manage-access-scopes.md`). `write_orders` implies `read_orders` ("A write scope includes read … declare the write scope on its own"). Not `read_customers`, not `read_all_orders`. On dev stores nothing else is needed; protected-customer-data approval is a launch step for non-dev stores.

## Manual Steps

For the sandbox shop, effectively none beyond clicking through the scope prompt:

1. Set `scopes = "write_orders,read_products"` in `shopify.app.toml`. With `pnpm app:dev` running, the CLI pushes config changes on save; otherwise `pnpm app:deploy`.
2. Open the app on `sandbox-shop-01`. Shopify prompts to approve the added scopes; approving fires `app/scopes_update`, which the existing handler stores. If the prompt does not appear, uninstall/reinstall the dev app.
3. Add `workflows` binding(s) to `wrangler.jsonc` (copy the shape from `../motio/wrangler.jsonc`: `binding`, per-env `name`, `class_name`).
4. Place a test order and mark it paid (Bogus gateway) to exercise `orders/create` → `orders/paid`.

Before installing on any non-dev store: request **protected customer data** access (Level 1: orders without name/address/email) in the Partner/Dev Dashboard. `manage-access-scopes.md`: "orders, draft orders, fulfillments … all carry customer data too. You can declare any of them, but outside of dev stores the API redacts protected fields until your app meets the protected customer data requirements and is approved." The older webhooks tutorial (`apps/build/webhooks/get-started.md`) claims a dashboard step is needed even in development; the newer scopes page scopes the redaction to non-dev stores. If the sandbox unexpectedly returns redacted orders, do the dashboard step then.

## What Route To Ship Persists (Inspected)

Order detail `https://app.routetoship.com/orders/<gid>` inspected 2026-09-01 (order #1558):

```text
Header:        #1558, placed timestamp, Print, "Re-sync from Shopify", More
Timeline:      PLACED, PAID, IN PRODUCTION, SHIPPED (timestamps)
Customer:      name, email (or "No email"), shipping address (multi-line)
Line items:    title, "Qty: N", pipeline selector per order
Status:        PAID DATE, FINANCIAL (PAID), FULFILLMENT (UNFULFILLED), TRACKING ("No fulfillments yet")
Notes trail:   collapsible "Order Notes Trail"
```

Orders table columns: `ORDER, CUSTOMER, PIPELINE, PLACED, PAYMENT, FULFILLMENT, DELIVERY, PIPELINE TAGS, TRACKING`. Filters: email/name search, tag (comma-separated), paid/not paid, fulfilled/unfulfilled, province, city.

Board columns: `Ready for production (Paid, not yet started)`, `In production`, `Ready to ship (All production done, not fulfilled)`, `Shipped (last 7 days)`.

That is Route to Ship's field floor: order number, placed/paid timestamps, financial + fulfillment status, customer name, shipping address (province/city are filters), line items with quantity, tags, fulfillments with tracking, note. Baton deliberately drops the customer name, address, email, and tracking-email pieces (decision 2026-09-02: production workflow only, no customer-facing surface). Everything else (pipelines, departments, tasks) is app-owned state keyed by line item.

The sync model matches `docs/route-to-ship-tag-routing-research.md`: webhook creates a skeletal record; an API fetch enriches; a failed fetch leaves an `awaitingSync` record with manual `Resync`. The recommendation below keeps the shape but drops the skeletal record — the webhook payload is trimmed to ids, so there is nothing to save until the fetch succeeds.

## Shopify Facts

### Topics

`WebhookSubscriptionTopic` (2026-10): `orders/create`, `orders/updated` ("Occurs whenever an order is updated"), `orders/edited`, `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled`, `orders/delete`, `refunds/create`, `fulfillments/create`, `fulfillments/update`. All order topics require `read_orders` (or marketplace variants); `orders/delete` requires `read_orders` only.

Source: https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic, mirrored at `refs/shopify-docs/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic.md`.

`fulfillments/create|update` and `fulfillment_events/create` gate on `read_fulfillments`, a separate scope (`WebhookSubscriptionTopic.md:462`). Not needed: `orders/fulfilled`, `orders/partially_fulfilled`, and `orders/updated` all fire on fulfillment and carry the order, and the GraphQL `Fulfillment` object is under `read_orders` (`refs/shopify-docs/docs/api/usage/access-scopes.md:83`).

The sample payloads for `orders/create|updated|cancelled|paid|fulfilled|partially_fulfilled` under `refs/shopify-docs/docs/api/webhooks/2026-10/topics/orders/` are byte-identical: one REST order shape for all six. `orders/delete` is `{ "id": … }` only. `orders/edited` is an `order_edit` delta envelope (`order_id`, `line_items.additions[]/removals[]` with `delta`), not an order; per `refs/shopify-docs/docs/apps/build/orders-fulfillment/order-management-apps/edit-orders.md:689` it fires "whenever an order edit is completed". `refunds/create` is a refund with `order_id`.

### Payload Shape

Webhook payloads are "Fixed, REST-shaped" (https://shopify.dev/docs/apps/build/events-webhooks). The order payload carries `id`, `admin_graphql_api_id`, `financial_status`, `fulfillment_status`, `cancelled_at`, `closed_at`, `tags`, `note`, `note_attributes`, `line_items[].{id, product_id, variant_id, sku, title, quantity, current_quantity, fulfillable_quantity, properties[]}`, `shipping_address`, `customer`. It does **not** carry product tags — line item keys are `id, admin_graphql_api_id, current_quantity, fulfillable_quantity, fulfillment_status, name, price, product_exists, product_id, properties, quantity, requires_shipping, sku, title, variant_id, variant_title, vendor, …` and no `tags`. Order-level `tags` is serialized as a comma string, not an array. Shopify's own enterprise-OMS guidance (`refs/shopify-docs/docs/apps/build/orders-fulfillment/order-management-apps/enterprise-oms-integration.md`):

> "Webhook payloads don't include metafields, custom attributes, or enriched line-item metadata that the OMS might need for routing. The OMS should query the full order after each webhook, and periodically make API calls to catch any missed orders."

That sentence is the whole design: fetch after webhook, poll to reconcile.

`include_fields` trims the payload; nested fields use dot paths. Shopify **debounces identical payloads** within a short window, so a trimmed payload must include a field that changes on every update:

> "a subscription to orders/updated with include_fields = ["id", "line_items.title"] would debounce consecutive price changes … include a field that always has a unique value. For example, updated_at"

Source: https://shopify.dev/docs/apps/build/webhooks/delivery-structure. Shopify CLI accepts `include_fields` on `[[webhooks.subscriptions]]` (`refs/shopify-cli/packages/app/src/cli/models/extensions/specifications/app_config_webhook_schemas/webhook_subscription_schema.ts:20`).

### Delivery Guarantees

- Retries: "8 times over 4 hours using an exponential backoff schedule", original payload replayed — check `X-Shopify-Triggered-At` for staleness (https://shopify.dev/changelog/updates-to-webhook-retry-mechanism).
- Timeout: "one-second connection timeout and a five-second timeout for the entire request"; any non-2xx including 3xx is a failure.
- Duplicates: "your app might receive the same webhook more than once … use the X-Shopify-Webhook-Id header to detect and skip duplicates". `X-Shopify-Event-Id` correlates deliveries from one merchant action across subscriptions.
- Ordering: "Shopify doesn't guarantee ordering within a topic, or across different topics for the same resource. For example, it's possible that a `products/update` webhook might be delivered before a `products/create` webhook." Use `X-Shopify-Triggered-At` or payload `updated_at` to order (`refs/shopify-docs/docs/apps/build/webhooks.md`, "Ordering event data").
- Missed data: "Your app shouldn't rely on receiving data from Shopify webhooks. Webhook delivery isn't always guaranteed … use reconciliation jobs to periodically fetch data from Shopify … Many GraphQL queries support `updated_at` filter parameters. Use these filters to build a job that fetches all objects updated since the last time the job ran." (`webhooks.md`, "Implement reconciliation jobs"). Downtime recovery: "fetch data from the outage period and feed it into your webhook processing code."
- Failing subscriptions: API-created ones are deleted after 8 consecutive failures; toml (app-specific) ones "will not be deleted by Shopify" (`refs/shopify-docs/docs/apps/build/webhooks/subscribe.md`). Baton uses toml, so a bad deploy cannot silently unsubscribe a shop.
- Propagation: toml subscriptions are "applied uniformly across every shop that installs your app"; a released app version reaches installed shops in "several minutes" with no per-shop registration. During `shopify app dev`, "webhook subscriptions are automatically updated when you save your TOML file."

Sources: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries, https://shopify.dev/docs/apps/build/webhooks/troubleshoot, `refs/shopify-docs/docs/apps/build/webhooks.md`.

The library already exposes `webhookId` and `apiVersion` on a valid validation result (`refs/shopify-app-js/packages/apps/shopify-api/lib/webhooks/types.ts:182`); `Shopify.validateWebhook` currently returns only `{ shop, topic, payload }` and would need to pass `webhookId` through for dedupe.

### Order Access Window And Scopes

> "By default, you have access to the last 60 days' worth of orders for a store. To access all the orders, you need to request access to the read_all_orders scope"

Source: https://shopify.dev/docs/api/usage/access-scopes. A 30- or 60-day backfill fits inside the default window; `read_all_orders` is a Partner Dashboard access request and out of scope for the prototype.

Protected customer data: Level 1 = customer data excluding name/address/phone/email; Level 2 = including them. "You don't need to submit a request for review for apps that are installed only on development stores." Unapproved fields come back redacted (`null` + `errors` entry) rather than failing the query. Source: https://shopify.dev/docs/apps/launch/protected-customer-data.

**Dev stores vs redaction:** `manage-access-scopes.md` — "outside of dev stores the API redacts protected fields until your app meets the protected customer data requirements and is approved." `get-started.md` (older) says a Partner Dashboard step is required even in development. Treat the newer page as authoritative and verify on the sandbox.

## Proposed Schema

Prototype shape, private SQLite in `ShopAgent`, added as a second entry in `SqliteMigrator.fromRecord` beside `1_initialize schema` (or folded into it, since every DB resets).

```sql
create table if not exists ShopOrder (
  id text primary key,                 -- gid://shopify/Order/…
  legacyId text not null,              -- REST id from webhook payloads; text to dodge JS 52-bit ints
  name text not null,                  -- "#1558"
  createdAt integer not null,          -- epoch ms
  processedAt integer not null,
  updatedAt integer not null,          -- Shopify updated_at; "latest wins" guard
  cancelledAt integer,
  closedAt integer,
  financialStatus text not null,       -- OrderDisplayFinancialStatus
  fulfillmentStatus text not null,     -- OrderDisplayFulfillmentStatus
  fullyPaid integer not null,          -- 0/1
  tags text not null,                  -- json array
  note text,
  customAttributes text not null,      -- json array of {key,value}
  raw text not null,                   -- fetched order json as selected (no customer fields); prototype aid
  syncedAt integer not null,
  syncSource text not null             -- 'webhook' | 'bulk' | 'manual'
);

create table if not exists OrderLineItem (
  id text primary key,                 -- gid://shopify/LineItem/…
  orderId text not null references ShopOrder(id) on delete cascade,
  productId text,
  variantId text,
  title text not null,
  variantTitle text,
  sku text,
  quantity integer not null,           -- original
  currentQuantity integer not null,    -- after edits/removals
  unfulfilledQuantity integer not null,
  nonFulfillableQuantity integer not null,
  productTags text not null,           -- json array, snapshot at sync time
  customAttributes text not null,      -- json array (personalization)
  requiresShipping integer not null
);
create index if not exists OrderLineItem_orderId on OrderLineItem(orderId);

create table if not exists WebhookDelivery (
  webhookId text primary key,          -- X-Shopify-Webhook-Id
  topic text not null,
  orderId text not null,
  triggeredAt integer not null,
  receivedAt integer not null
);

create table if not exists SyncState (
  id integer primary key check (id = 1),
  lastFullSyncAt integer,              -- start time of the last completed window sync; null = never
  lastFullSyncWindowStart integer,     -- the created_at/updated_at:>= bound that sync used
  bulkOperationId text,                -- in-flight gid://shopify/BulkOperation/…, null when idle
  bulkOperationStartedAt integer,
  lastError text
);
insert or ignore into SyncState (id) values (1);
```

Notes:

- No customer, shipping, or email columns by decision (2026-09-02): production workflow only. Order `note` and line-item `customAttributes` are kept — they carry personalization text a maker needs and may incidentally contain buyer-typed content.
- Timestamps as epoch ms integers match `Counter.updatedAt` and `ShopSession.*ExpiresAt`.
- `productTags` is a **snapshot** at sync time. A later resync overwrites it. When routing exists, the routing row must copy the tags it matched so a merchant retag does not silently reroute history.
- `raw` costs storage but lets the prototype add columns via `json_extract` without a resync. Drop it once the field set stabilizes.
- Fulfillments/tracking (`Fulfillment` table) can wait; `fulfillmentStatus` covers the board columns.
- Upsert rule everywhere: `insert … on conflict(id) do update … where excluded.updatedAt >= ShopOrder.updatedAt`. That one clause makes webhook, bulk, and manual paths safe to interleave in any order.

## GraphQL

All four validated against the 2026-10 schema with the Shopify Dev MCP on 2026-09-02 (validated with `shippingAddress` selected; removed afterwards by decision — removing a selection cannot invalidate a query).

### Single Order (Webhook Path)

```graphql
query OrderSync($id: ID!) {
  order(id: $id) {
    id legacyResourceId name createdAt processedAt updatedAt cancelledAt closedAt
    displayFinancialStatus displayFulfillmentStatus fullyPaid
    tags note customAttributes { key value }
    lineItems(first: 50) {
      nodes {
        id title variantTitle sku quantity currentQuantity unfulfilledQuantity nonFulfillableQuantity requiresShipping
        customAttributes { key value }
        variant { id }
        product { id tags }
      }
    }
  }
}
```

Requested cost ≈ 1 + 50 × (1 + variant + product + customAttributes) ≈ 250 points, under the 1,000-point single-query cap. Validator: `read_orders, read_products` (satisfied by `write_orders`). Selecting `customer { … }` would add `read_customers`; `shippingAddress` is under `read_orders` but is Level 2 protected data. Neither is selected.

### Window Sync (Bulk Path)

```graphql
mutation OrdersBulkSync($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
```

`$query` is the same selection as `OrderSync` wrapped in a connection with a time filter; `first`/`pageInfo` are "optional and ignored" inside a bulk query:

```graphql
{
  orders(query: "updated_at:>='2026-08-03T00:00:00Z'") {
    edges {
      node {
        id legacyResourceId name createdAt processedAt updatedAt cancelledAt closedAt
        displayFinancialStatus displayFulfillmentStatus fullyPaid
        tags note customAttributes { key value }
        lineItems {
          edges {
            node {
              id title variantTitle sku quantity currentQuantity unfulfilledQuantity nonFulfillableQuantity requiresShipping
              customAttributes { key value }
              variant { id }
              product { id tags }
            }
          }
        }
      }
    }
  }
}
```

```graphql
query BulkOperationStatus($id: ID!) {
  bulkOperation(id: $id) {
    id status errorCode createdAt completedAt objectCount fileSize url partialDataUrl
  }
}
```

First sync uses `created_at:>=` (window start = now − `ORDER_SYNC_WINDOW_DAYS`); every later sync uses `updated_at:>=` (window start = `lastFullSyncAt` − overlap, floored at the 30-day window). Orders older than the window that get updated still appear under `updated_at`, which is what you want.

### Why Bulk Beats Pagination Here

`refs/shopify-docs/docs/api/usage/bulk-operations/queries.md` and `refs/shopify-docs/docs/api/usage/limits.md`:

- Cost/rate: regular queries are capped at 1,000 requested points each and refill at 100 points/s (Standard) or 1,000/s (Plus). `orders(first: 50) { lineItems(first: 100) { variant product } }` requests ~15,000 points and is rejected before execution. Paging 250-point `OrderSync` calls at 100/s means ~0.4 orders/s on a Standard shop — the sandbox's 85 orders would take minutes and need alarm-driven ticks to survive request limits. Bulk: "they don't have the max cost limits or rate limits that single queries have"; only the `bulkOperationRunQuery` mutation (cost 10) and status checks are billed.
- Shape: "Because connections are no longer nested in the response data structure, the bulk operation result automatically includes the `__parentId` field"; "all nested connections appear after their parents in the file". So the JSONL is: order line, then its line-item lines each carrying `__parentId`, then the next order. A streaming reader buffers one order and flushes when the next order line arrives.
- Rules: at least one connection, at most 5 connections, at most 2 nested levels (`orders > lineItems` is one level; `product` is an object, not a connection, so it is fine), no top-level `node`/`nodes`. Since 2026-01 up to five concurrent bulk ops per type per shop; must finish within 10 days; result URL expires after one week; `partialDataUrl` on failure; stalled ops may be `CANCELED` by Shopify and are safe to resubmit.
- Completion: poll `bulkOperation(id:)` for `status`/`url`. Shopify offers a `bulk_operations/finish` webhook but adds "Webhook delivery isn't always guaranteed, so you might still need to poll", and its payload carries no URL anyway — so polling is the whole mechanism here, as in motio (5 s × 3, 15 s × 3, then 30 s, up to 24 attempts).
- Access window: bulk queries obey the same 60-day order rule as regular queries; nothing in the refs exempts them.

Cost of bulk for a small shop: seconds of latency while Shopify runs it, invisible behind a button that shows "syncing".

## Sync Flow

```mermaid
flowchart LR
  WH[Shopify webhook\norders/*] -->|validate HMAC| R[/webhooks/orders]
  R -->|stub.syncOrder id, webhookId, updatedAt| DO[ShopAgent DO]
  Btn[Sync last 30 days / Resync buttons] -->|server fn → ShopAgentClient| DO
  DO -->|ORDERS_SYNC_WORKFLOW.create| WF[OrdersSyncWorkflow]
  WF -->|step: bulkOperationRunQuery| API[Shopify Admin API]
  WF -->|step.sleep + poll bulkOperation id| API
  WF -->|step: agent.onOrdersStream url| DO
  DO -->|HttpClientResponse.stream → Ndjson.decodeSchema| API
  DO -->|upsert where updatedAt >= stored\nnotifyChanged| SQL[(private SQLite)]
  WF -->|step.reportComplete / onError| DO
```

### Webhook Route (Real-Time Path)

- One route `src/routes/webhooks.orders.ts`; all seven order topics point at it. Handler decodes `{ admin_graphql_api_id, updated_at }` (`{ id }` for `orders/delete`), calls `env.SHOP_AGENT.getByName(shop).syncOrder({ orderId, topic, webhookId, triggeredAt, updatedAt })`, returns 200.
- The DO call is awaited inside Shopify's 5 s budget; one `OrderSync` is well under that. A Shopify hiccup returns 5xx and Shopify retries for 4 h (toml subscriptions are never auto-deleted).
- Dedupe in the DO: `insert or ignore into WebhookDelivery`; existing row → skip. Pass `webhookId` and `triggeredAt` through `Shopify.validateWebhook` — the library returns them (`refs/shopify-app-js/packages/apps/shopify-api/lib/webhooks/validate.ts`) and does no dedupe itself.
- Skip-if-stale: payload `updated_at <= ShopOrder.updatedAt` → skip the fetch. Retries replay the original payload and deliveries are unordered; this guard plus the upsert clause make "latest wins" true.
- `orders/delete`: delete the row.

### Window Sync (Workflow + DO Stream) — Port From motio

motio (`/Users/mw/Documents/src/motio`) is the same stack (TanStack Start, Cloudflare, Effect v4, `agents` 0.20.x, `@effect/sql-sqlite-do`) and already ships this pipeline for products. File-by-file mapping:

| motio | Baton | What it does |
| --- | --- | --- |
| `src/lib/ScanBulkRepository.ts` | `OrdersBulkRepository` | `submitQuery` (`bulkOperationRunQuery(query:, groupObjects: false)`), `findById` (`bulkOperation(id:)` → `Option`), `list` (`bulkOperations(first: 50, query: "operation_type:query")`). The nested bulk document keeps its `#graphql` tag so `pnpm graphql-codegen` validates it; it must be a **named** operation. |
| `src/lib/ScanWorkflow.ts` | `OrdersSyncWorkflow extends AgentWorkflow<ShopAgent, { shop }>` | Builds a `ManagedRuntime` in `makeRuntimeLayer` (D1 on primary, `Shopify` + `ShopifyAdmin` for the offline session), then steps: `ensure-session` (session props via `Session.toPropertyArray(true)` so they survive `step.do` serialization), `run-bulk-…-query`, a `step.sleep` + `poll-…-N` loop (`POLL_ATTEMPTS = 24`; delay 5 s → 15 s → 30 s), `on-scan-stream` (RPC `agent.onScanStream({ url })`) or `on-scan-empty`, `step.reportComplete`. `Effect.onError` durably calls `agent.onScanError` before the failure propagates. Permanent failures (`userErrors`, dead session) become `NonRetryableError` from `cloudflare:workflows`. |
| `src/lib/ShopAgentScanStream.ts` | `ShopAgentOrdersStream.ts` | `HttpClientResponse.stream(client.get(url))` with `HttpClient.retryTransient` → `Stream.pipeThroughChannel(Ndjson.decodeSchema(BulkLine)({ ignoreEmptyLines: true }))` (from `effect/unstable/encoding`) → `Stream.mapAccumEffect` that holds the current parent and attaches child lines whose `__parentId` matches, emitting the finished parent when the next parent line (or `onHalt`) arrives → `Stream.runFoldEffect` inserting rows and counting. Line schemas are a `Schema.Union` tagged on `__typename`. |
| `ShopAgent.scan()` | `ShopAgent.syncOrders()` | **Not ported as-is** — see "Kickoff: `runWorkflow` vs direct binding" below. motio creates the instance directly on the binding under a fixed id and re-implements the wrapper's private `__agent*` params; Baton uses `this.runWorkflow` with a fresh id and keeps the singleton in `SyncState`. |
| `ShopAgent.onScanStream/onScanEmpty/onScanError/onWorkflowError` | `onOrdersStream/onOrdersSyncEmpty/onOrdersSyncError/…` | RPC targets the workflow calls; they write `SyncState` and `broadcast` a state-changed message so the page refetches. |

### Kickoff: `runWorkflow` vs Direct Binding

What `runWorkflow` does (`refs/agents/packages/agents/src/index.ts:11211-11280`): resolve the binding, compute `agentOrigin`, `workflow.create({ id: options.id ?? wf_<nanoid>, params: { ...params, __agentName, __agentBinding, __workflowName, __agentOrigin } })`, then insert a `cf_agents_workflows` row. Callbacks (`onWorkflowCallback`, `index.ts:12152`) `UPDATE` that row — a no-op if it is missing — and then call `onWorkflowProgress/Complete/Error` unconditionally, so the user hooks do not depend on tracking.

motio's reasons for bypassing it, and whether they hold for Baton:

- *"Partial-failure leak: `create` succeeds, tracking insert fails."* The insert only fails on a UNIQUE clash (`workflow_id` reused) or a storage fault. With a fresh id per run there is no clash; a storage fault inside the DO is the same class of failure as any `SyncState` write. Not a reason.
- *Singleton instance under a fixed id.* Cloudflare instance ids are unique for the instance's retention life, so a fixed `scan:<shop>` id forces the "already exists → inspect status → restart" dance that is most of motio's `scan()` complexity. Baton's singleton is a business rule ("one sync in flight per shop"), which belongs in `SyncState.workflowId` + a status check, not in Cloudflare's id space. Fresh id `orders-sync:<shop>:<startedAt>`, refuse when `SyncState` says in flight (confirm with `env.ORDERS_SYNC_WORKFLOW.get(id).status()` if the recorded run is old, so a lost callback cannot wedge the button).
- *Private wrapper contract.* Bypassing means re-implementing `__agentName/__agentBinding/__workflowName` — and 0.20.1 already adds a fourth, `__agentOrigin` (`index.ts:11238`; `workflows.ts:239` fails without "a valid Agent origin"). motio's three-key contract test is exactly the kind of thing that breaks on upgrade. `runWorkflow` owns that contract. Pass `options.agentBinding: "SHOP_AGENT"` explicitly so origin detection does not depend on `constructor.name` surviving the bundle.
- *Tracking table growth.* Real but trivial: `this.deleteWorkflow(instanceId)` in `onWorkflowComplete/Error` (the SDK's own "Option 1"), since `SyncState` is the record that matters.

Decision: `this.runWorkflow("ORDERS_SYNC_WORKFLOW", { shop, since, field, startedAt }, { id, agentBinding: "SHOP_AGENT" })`. What survives from motio: `AgentWorkflow` subclass with an Effect `ManagedRuntime`, session props through `step.do`, the poll schedule, `NonRetryableError` for permanent failures, `Effect.onError` → durable error callback, and the stream file.

### If `runWorkflow` Creates But Fails To Track

`runWorkflow` does `workflow.create(...)` then a SQLite insert; the two cannot be one transaction, so the instance can exist with no `cf_agents_workflows` row (reported upstream; maintainer declined without a production repro). Consequences under Baton's design:

- **The run still completes correctly.** The workflow body calls `this.agent.onOrdersStream({ url })` by RPC and `step.reportComplete` routes through `_workflow_handleCallback` → `onWorkflowCallback`, whose tracking `UPDATE` is a silent no-op on a missing row and whose call to `onWorkflowComplete` is unconditional (`index.ts:12152-12200`). Rows land, `SyncState.lastFullSyncAt` is written by the hook, `deleteWorkflow(id)` returns `false` harmlessly.
- **The only exposure is the button.** If `SyncState.workflowId` is written *after* `runWorkflow` returns, the throw leaves it null, the button re-enables, and a second click starts a concurrent run: two bulk ops (Shopify allows five per type), two streams upserting the same rows under the `updatedAt` guard. Wasted work, not corruption.
- **Mitigation, two lines:** choose the id, write `SyncState.workflowId/startedAt` *before* `runWorkflow`, and on a throw call `env.ORDERS_SYNC_WORKFLOW.get(id).status()` — instance exists → keep the reservation (the hooks will clear it), not found → clear it and surface the error. DO output gates hold the outgoing `create` until the preceding SQLite write is durable, so the reservation cannot be lost to the same fault that loses the tracking row.
- Not a proliferation risk: one untracked row per failed insert, and nothing in Baton reads `getWorkflows`.

### Button: `@callable()` vs Server Function

What the socket gate already proves (`src/worker.ts:285-345`, `authorizeShopAgentRequest`): the Shopify session token's HS256 signature, `exp`/`nbf`/`aud`, that the URL's shop equals the token's signed `dest`, and an active subscription. Every `@callable()` on `ShopAgent` is reachable only through a connection that passed that gate, so "the Worker has already authenticated the request" (the rationale on `getShopInfo` for staying off `@callable()`) is equally true of the socket.

The remaining reasons in the existing JSDoc for routing through `ShopAgentClient` are (a) inputs the Worker must resolve from D1 (plan ceilings) and (b) "nothing a tab can name reaches storage". Neither applies to `syncOrders()`: it takes no arguments, its only side effect is starting a workflow the DO already refuses to duplicate, and the Shopify cost is one 10-point mutation per run. The server-fn path would add an HTTP round trip plus a Worker → DO RPC for no additional check.

Decision: `@callable() syncOrders()` and `@callable() getOrders(...)` for the page; `@callable() resyncOrder({ orderId })` is also fine — the id is only ever fetched through this shop's offline session, so a foreign id fails at Shopify. Keep `syncOrder` (webhook path) and the workflow RPC targets off `@callable()` since nothing browser-side calls them. Update the `bump` / `getShopInfo` JSDoc to state the refined rule: `@callable()` when the socket gate is sufficient authorization and the method takes no privileged inputs; `ShopAgentClient` when a Worker-resolved input (plan, D1 row) must accompany the call.

Baton-specific differences from motio's stream file:

- Line schemas: `BulkOrderLine` (`__typename: "Order"`, the `OrderSync` fields) and `BulkLineItemLine` (`__typename: "LineItem"`, `__parentId`). Select `__typename` in the bulk query as motio does. `product { id tags }` and `variant { id }` are objects, not connections, so they arrive inline on the line-item line — no third line type.
- The fold upserts `ShopOrder` + `OrderLineItem` with the `updatedAt` guard instead of replacing a scan-results table; motio clears and rebuilds, Baton merges (webhooks may have written newer rows mid-stream).
- `SyncState.lastFullSyncAt` is set from the workflow's start time (passed in the params) so the next window overlaps the run.
- Bulk query text is built per run: `created_at:>=` when `lastFullSyncAt` is null, else `updated_at:>=max(lastFullSyncAt − overlap, now − window)`.
- Bundling: the `AgentWorkflow` wrapper routes callbacks by `constructor.name` (`refs/agents/docs/agents/workflows.md:305` says preserve class names). motio has no `keepNames` setting and works, so Baton's identical Vite/Wrangler build should too; confirm on first run rather than assume.

### Constants

```ts
export const ORDER_SYNC_WINDOW_DAYS = 30;              // ≤ 60 without read_all_orders
export const ORDER_SYNC_OVERLAP_MS = 15 * 60 * 1000;
export const BULK_POLL_ATTEMPTS = 24;                  // motio's schedule: 5s×3, 15s×3, then 30s
```

## Paid Gate

- `Order.fullyPaid: Boolean!` — "Whether the order has been paid in full." `OrderDisplayFinancialStatus`: `AUTHORIZED` ("payments should be captured before the authorization period expires"), `PENDING` ("payment provider needs time … or manual payment methods"), `PARTIALLY_PAID`, `PAID` ("Payment was automatically or manually captured, or the order was marked as paid"), `PARTIALLY_REFUNDED`, `REFUNDED`, `VOIDED`, `EXPIRED`. Source: https://shopify.dev/docs/api/admin-graphql/2026-10/enums/OrderDisplayFinancialStatus.
- `orders/paid` "Occurs whenever an order is paid" — the transition signal. With fetch-based sync the topic only affects latency; the stored row carries `fullyPaid` regardless of which topic triggered the fetch or whether it came from bulk.
- Proposed gate when routing lands: `fullyPaid = 1 and cancelledAt is null` (`PARTIALLY_REFUNDED` still counts as paid). Shopify's marketplace guidance warns against using capture as the fulfillment condition for channels that capture on fulfillment (`refs/shopify-docs/docs/apps/build/orders-fulfillment/order-management-apps/track-orders-other-platforms.md`) — a later per-shop policy could accept `AUTHORIZED`. Route to Ship markets "paid orders" and shows a `PAID DATE`; Shopify has no `paidAt` on `Order`, so that is either the `orders/paid` `X-Shopify-Triggered-At` or the first sync that observed `fullyPaid`. Add a `paidObservedAt` column when the gate is built.

## Policies Deferred

Not answerable until rows exist and routing is sketched. Listed so they are not forgotten:

- Release: paid only, or authorized/pending for some shops? Manual approval step?
- Routing input: product tags at sync time vs at release; what a retag does to already-routed items.
- Order edit after release: added line → new work; quantity up → delta; quantity down / line removed → cancel unstarted work, flag started work?
- Cancel / refund while items are in a pipeline: block, cancel, or leave visible with a flag?
- Fulfilled outside the app (merchant ships from Shopify admin): auto-complete pipeline items?
- Partial paid / partial refund.
- What `Resync` may overwrite (Shopify fields only; never app state).

The `WebhookDelivery.topic` log and the `raw` column exist partly so these can be studied on real events before deciding.

## Triggers That Do Not Work

- "On startup": there is no app startup. The Worker is stateless; the DO wakes per request. `onStart` fires on every DO wake.
- "First token exchange": the offline token is long-lived and refreshed in place, so `exchangeAndStore`'s `existing = none` branch runs once per install and never again — a failed or interrupted sync there has no retry, and a `d1:reset` or DO destroy leaves the shop installed with nothing to re-trigger. A button (now) or a staleness check (later) answers all of those.
- "Periodic polling": rejected for v1 — the merchant's data is Shopify's, webhooks are the primary path, and a bulk op per click is the only pull.
- `app/installed` webhook: does not exist.
- Scope changes: adding `write_orders` and deploying triggers Shopify-managed re-consent on next open; `app/scopes_update` fires and the handler records the scope. No sync hook needed there — the button is the trigger.

## Config Changes

```toml
[access_scopes]
scopes = "write_orders,read_products"

[[webhooks.subscriptions]]
uri = "/webhooks/orders"
topics = [
  "orders/create", "orders/updated", "orders/paid", "orders/cancelled",
  "orders/fulfilled", "orders/partially_fulfilled", "orders/delete",
]
include_fields = ["id", "admin_graphql_api_id", "updated_at"]
```

```jsonc
// wrangler.jsonc (top level and each env), shape from ../motio/wrangler.jsonc
"workflows": [
  { "binding": "ORDERS_SYNC_WORKFLOW", "name": "baton-orders-sync-local", "class_name": "OrdersSyncWorkflow" }
]
```

`orders/delete` delivers `{ "id" }` only; `include_fields` is harmless there. `refunds/create` (refund keyed by `order_id`) and `orders/edited` (`order_edit` delta, no order body) are out: both also fire `orders/updated`, and one payload shape keeps the route to one decoder. `orders/edited` is worth adding later only if per-line edit deltas or `staff_note` attribution are needed; `currentQuantity` / `nonFulfillableQuantity` already give the converged state.

## Storage Limits

Per-object SQLite: 10 GB; rows per table unlimited; max row/string/BLOB 2 MB (an order's `raw` JSON is well under); 100 columns per table; 100 bound parameters per statement (`refs/cloudflare-docs/src/content/docs/durable-objects/platform/limits.mdx`). Billing: reads 25 B/month included then $0.001/M, writes 50 M/month included then $1/M; each index adds one row written per write. Thousands of orders plus line items per shop are nowhere near any of these. `sql.exec` cursors must be consumed before the next `await`, which `@effect/sql-sqlite-do` already does.

## Open Questions

- When (if) to add an automatic staleness trigger on app open, and its threshold.
- Line items > 50 in `OrderSync` are truncated (bulk has no such limit). Cap and log.
- File size is a non-issue by construction: the DO streams the NDJSON (`HttpClientResponse.stream` → `Ndjson.decodeSchema` → per-order fold) and never holds more than one order's lines in memory, exactly as motio does. `objectCount` is logged for observability only.

## Next Steps

Execution order and file touchpoints: `docs/orders-sync-phase-1-plan.md`.

1. Scopes in `shopify.app.toml`; approve the prompt on the sandbox; `workflows` binding in `wrangler.jsonc`.
2. Webhook subscription block in `shopify.app.toml`.
3. Schema migration entry (`ShopOrder`, `OrderLineItem`, `WebhookDelivery`, `SyncState`) + `OrderRepository` over `SqlClient`, mirroring `CounterRepository`, with the `updatedAt`-guarded upsert.
4. `#graphql` literals: `OrderSync`, the named bulk document, `OrdersBulkSync` mutation, `BulkOperationStatus`; `pnpm graphql-codegen`.
5. Port from motio: `OrdersBulkRepository`, `OrdersSyncWorkflow` (runtime layer, poll loop, error step), `ShopAgentOrdersStream`. Write fresh: `@callable() syncOrders()` via `this.runWorkflow` + `SyncState` guard, `onWorkflowComplete/Error` writing `SyncState` and deleting the tracking row.
6. `ShopAgent.syncOrder` (webhook/resync path) and `getOrders`; `/webhooks/orders` route; extend `Shopify.validateWebhook` to return `webhookId` / `triggeredAt`.
7. `/app/orders` list page over the socket (`@callable() getOrders`); "Sync last 30 days" (in-flight state from `SyncState`, refreshed by the DO's broadcast) and per-order "Resync" buttons.
8. Verify: click Sync (workflow runs, rows land); place an order, watch `logs/server.log` for `Webhook received: … topic=orders/create`; mark it paid, see `orders/paid` and `fullyPaid=1`; stop the dev server, place another order, restart, click Sync, confirm the `updated_at` window picks it up.

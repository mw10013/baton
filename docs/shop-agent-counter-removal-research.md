# ShopAgent Counter Removal And Schema Initialization Research

Research date: 2026-09-02

Scope: remove the disposable per-shop `Counter` proof-of-wiring from the Durable Object database, RPC surface, domain, routes, and admin screen. The application is still reset-from-scratch prototyping, so keep one current orders schema in the existing `SqliteMigrator`, not an evolving migration sequence yet.

## Decision

- Delete `Counter`, its seed row, `CounterRepository`, `Counter` domain schema, and every RPC/UI/client/admin dependency.
- Replace `initializeSchema` and `initializeOrdersSchema` with one `initializeSchema` containing only the order tables, indexes, and `SyncState` seed.
- Keep `SqliteMigrator`, `runShopAgentMigrations`, its `effect_sql_migrations` bookkeeping table, and constructor invocation. Replace the two migration records with one current record: `"1_initialize schema": initializeSchema`.
- Use one static, semicolon-delimited SQL tagged template for the schema. Cloudflare supports this. Do not interpolate values into a multi-statement template: Cloudflare applies bindings only to the final statement.
- Reset local DO storage after implementation with `pnpm clean:wrangler` (the project-owned command that removes `.wrangler`); `pnpm d1:reset` additionally recreates D1. Existing deployed ShopAgent objects retain the old `Counter` table until they are explicitly reset or destroyed; this is acceptable under the stated prototype/reset premise.

## Current State

`src/lib/ShopAgent.ts:100-110` has exactly the two counter statements in question:

```sql
create table if not exists Counter (...);
insert or ignore into Counter (id, count, updatedAt) values (1, 0, null);
```

They are migration `1_initialize schema`; orders are separately migration `2_orders` at `src/lib/ShopAgent.ts:187-215`. `SqliteMigrator` persists completed ids in `effect_sql_migrations` (`node_modules/effect/src/unstable/sql/Migrator.ts:4-7,111`) and runs pending migrations transactionally. This is the durable migration mechanism Baton needs once schema changes must preserve data.

The existing `blockConcurrencyWhile()` remains necessary: constructor migration must finish before RPCs use the repositories.

## Removal Inventory

| Area | Remove or change |
| --- | --- |
| `src/lib/CounterRepository.ts` | Delete the complete file: error type, service layer, `get`, and `bump`. |
| `src/lib/ShopAgent.ts` | Remove the `CounterRepository` import/layer; counter DDL and seed; `initializeOrdersSchema`; `activateCounter`, `bump`, `getCounter`; counter-bearing `getAdminSnapshot`; and counter-specific JSDoc links/text. Keep `SqliteMigrator`, `runShopAgentMigrations`, and the constructor call. Change its loader from two records to one `"1_initialize schema": initializeSchema` record. |
| `src/lib/Domain.ts` | Remove `Counter`, `HomeLoaderData` (currently unused), and `counter` from `AdminShopAgentSnapshot`. Remove counter references in `EpochMillis` and `ActivateOrdersInput` comments. |
| `src/lib/ShopAgentClient.ts` | Remove `getCounter` from the service interface and implementation. `getAdminSnapshot` remains, but its schema becomes an empty struct unless the admin route stops calling it. |
| `src/routes/app.index.tsx` | Remove the server-side `client.getCounter(shop)` call; query key/decoder/query/effects; bump state and handler; counter section; and imports used only by it (`React`, Query, socket utilities, `Option`, and `formatNumber`, subject to final import cleanup). The Shop and Plan sections remain. The page no longer needs the socket connection badge solely for the counter. |
| `src/routes/admin.shop.$shop.tsx` | Remove the Durable Object counter section and the snapshot destructure. Then remove the DO snapshot RPC entirely if no replacement admin DO state is wanted. |
| `src/routes/app.orders.tsx` | Retain behavior. Remove only stale prose references to `Domain.Counter` and `ShopAgent.activateCounter`; point the activation convention at `activateOrders` or make the comments self-contained. |
| `src/lib/OrderRepository.ts` | Remove the stale `CounterRepository` comparison from the error JSDoc. |
| `docs/` | Update stale historical planning references only if those documents are intended to describe current code. They currently cite `CounterRepository` in `shop-agent-orders-sync-research.md:439` and `orders-sync-phase-1-plan.md:41-47`. |
| Tests | No Baton test currently matches `CounterRepository`, `activateCounter`, `bump`, or `getCounter`; no counter-specific test deletion is required. Add/init coverage only if the project wants a regression test for the new schema. |

`deactivate` remains. `src/routes/app.orders.tsx` still calls it, and `activateOrders` still stores the session token on the connection.

## Proposed Initializer

The initializer should contain only current order storage, in dependency order: `ShopOrder`, its page index, `OrderLineItem`, its order index, `WebhookDelivery`, `SyncState`, and the singleton `SyncState` row.

```ts
const initializeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table if not exists ShopOrder (...);
    create index if not exists ShopOrder_processedAt
      on ShopOrder (processedAt desc, id desc);
    create table if not exists OrderLineItem (...);
    create index if not exists OrderLineItem_orderId on OrderLineItem (orderId);
    create table if not exists WebhookDelivery (...);
    create table if not exists SyncState (...);
    insert or ignore into SyncState (id) values (1);
  `;
});
```

The actual column definitions remain those already in `initializeOrdersSchema`; this is a structural consolidation, not an orders-schema redesign. `create ... if not exists` and `insert or ignore` make the initial schema safe to apply to a fresh object. The migrator's ledger means later constructor runs do not repeat a completed migration.

Keep the existing constructor call:

```ts
void ctx.blockConcurrencyWhile(() => this.runEffect(initializeSchema));
```

Keep the current failure propagation. `SqliteMigrator` runs pending migrations through `sql.withTransaction(run)` (`node_modules/effect/src/unstable/sql/Migrator.ts:305-313`), and `blockConcurrencyWhile()` rejects object initialization if `runEffect` rejects rather than allowing requests against a partly initialized schema.

## One SQL String Or Multiple Effects

Yes, one SQL string works for this Durable Object backend.

Cloudflare's `SqlStorage.exec()` reference says: "Multiple SQL statements, separated with a semicolon, can be executed in the `query`." It also states that bindings apply only to the final statement and only the final statement supplies the returned cursor (`refs/cloudflare-docs/src/content/docs/durable-objects/api/sqlite-storage-api.mdx:143-154`). Its own constructor example creates a table and inserts rows in one string (`:93-103`).

The installed Effect adapter does not split a tagged template. `@effect/sql-sqlite-do` calls `sqlStorage.exec(sql, ...params)` once (`node_modules/@effect/sql-sqlite-do/src/SqliteClient.ts:193-216`). Therefore the static template above is one Effect operation and one underlying `SqlStorage.exec()` call.

Use one string only for static DDL and literal seed data. If initialization needs a dynamic value later, issue it in a separate `yield* sql` statement. In a multi-statement call, its bindings would be unsafe/misleading because only the last statement receives them.

One nuance: a single `exec` call is not a replacement for a transaction API. Cloudflare disallows `begin transaction` and `savepoint` inside `exec`; it directs callers to `storage.transaction()` or `storage.transactionSync()` instead (`sqlite-storage-api.mdx:238-240`). This initializer already receives transaction handling from `SqliteMigrator`, which runs pending migrations through `sql.withTransaction(run)`.

## Sibling Comparison: `../bang`

The requested sibling project is present as `../bang`, not `../bank`.

`../bang/src/lib/ShopAgent.ts:205-259` defines one `initializeSchema` migration containing nine separate `yield* sql` calls: five table creates, two index creates, and two seed inserts. It then registers exactly one migration record, `"1_initialize schema"`, at `:261-265`.

So Bang proves both points:

- It uses multiple Effect SQL operations despite having one schema migration.
- That is a style choice, not a Durable Object limitation. Cloudflare supports the one long static string proposed above.

Bang retains `SqliteMigrator`, as Baton should. The prototype policy means edit the sole initial migration in place and reset storage while data is disposable; it does not mean remove the migration mechanism. Once any environment contains data to retain, leave migration `1` unchanged and add numbered forward migrations.

## Verification After Implementation

1. Run `pnpm clean:wrangler`, then `pnpm typecheck` plus `pnpm lint`.
2. Start the app and open `/app`: Shop and Plan render; no counter UI, RPC, or client call remains.
3. Open `/app/orders` and run a sync. Confirm `ShopOrder`, `OrderLineItem`, `WebhookDelivery`, and `SyncState` are created and the seeded `SyncState(id = 1)` supports `getSyncState`.
4. Open the admin shop page. It must not expect a `snapshot.counter`; either omit the stored-state section or render a future orders-specific snapshot.
5. Search `src/` for `CounterRepository`, `Domain.Counter`, `activateCounter`, `getCounter`, and `bump` to confirm no live dependency remains.

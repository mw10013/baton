# Page banners research

Banners that appear at the top of `/app` and `/shop/$shop` pages on their own, without the merchant or member doing anything on that page. Error banners that follow a button click on the same page (mutation errors such as `banner` and `mutationError`) are out of scope.

The overage warning ("You've used 65 of 20 included orders…") was removed on 2026-09-23. Going past the included orders is normal billed usage, not a fault.

## Inventory

| #   | Banner                  | Tone                | Source                                                               | Pages                                                                                                                                                                                                    |
| --- | ----------------------- | ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Not connected           | warning             | `src/lib/SocketBanner.tsx`                                           | Merchant: Orders, Order detail, Workflows, Workflow detail, Workflow edit, Teams, Team detail, Members. Member: Shop home (`/shop/$shop`), Run (`/shop/$shop/workflows/$runId`). Not on the `/app` home. |
| 2   | Order limit reached     | critical            | `src/components/QuotaBanners.tsx`                                    | `/app` home, Orders                                                                                                                                                                                      |
| 3   | Open runs limit reached | critical            | `src/components/QuotaBanners.tsx`                                    | `/app` home, Orders                                                                                                                                                                                      |
| 4   | Import failed           | critical            | `SyncState.lastError`, rendered in `src/routes/app.orders.index.tsx` | Orders (inside the orders card, not above it)                                                                                                                                                            |
| 5   | Orders could not load   | critical            | `ordersQuery.isError`, `src/routes/app.orders.index.tsx`             | Orders (in place of the table)                                                                                                                                                                           |
| 6   | Open orders have issues | warning or critical | `src/routes/app.orders.index.tsx`                                    | Orders (hidden while the Issues view is pressed)                                                                                                                                                         |

### 1. Not connected

Current copy:

> Not connected to this shop. Live updates are paused and changes on this page are disabled until the connection returns.

- **What it means:** each tab keeps one WebSocket to the shop's `ShopAgent` Durable Object. Page data refreshes over it, and many writes (all member run actions, and merchant writes on subscribed pages) go through it. `identified` is false from the moment the socket closes until it reconnects and completes its handshake.
- **When it shows:** `identified` has stayed false for more than 4 s (`GRACE_MS`). Each page load and each reconnect starts out unidentified, so a shorter delay would flash the banner on every navigation.
- **What triggers it in practice:** laptop sleep and wake, a network change, a Worker deploy that drops the socket, the Durable Object restarting, an expired App Bridge token while a new one is being fetched, and the stale-socket watchdog forcing a reconnect (`SOCKET_WATCHDOG_MS`, 30 s). Reconnecting is automatic. The merchant doesn't need to do anything.
- **What the merchant sees meanwhile:** buttons that write are disabled, and the page stops updating.
- **Problems with the copy:**
  - "Not connected to this shop" can read as Baton having lost access to the Shopify store (an uninstall, or broken permissions). The actual state is that this browser tab temporarily can't reach Baton's server.
  - It doesn't say the app is reconnecting by itself, so it reads like something the merchant has to fix.
  - It doesn't say what to do if the banner doesn't go away (for example, reload).
  - The same copy is shown to merchants and members.

### 2. Order limit reached

Current copy:

> Baton is built for shops under 100 orders a billing period, so new orders have stopped syncing. Syncing resumes on <date>.

- **When it shows:** `ShopUsage.ordersLimitedAt` is set. That happens when a webhook order, an order streamed during an import, or the start of an import is refused because `ordersThisCycle` reached `ShopLimits.maxOrdersPerCycle`. The limit is currently 100, which is provisional ("enterprise fencing, not a tier").
- **What clears it:** the billing period rolling over, or deleting seed orders in dev.
- **Effect on orders:** new orders are refused. Orders Baton already has keep receiving updates.
- **Duplication:** when an import is refused, `ShopAgent.syncOrders` also writes a near-identical sentence into `SyncState.lastError` ("…importing resumes when the period ends."). The Orders page then shows banner 2 above the card and banner 4 inside it, saying nearly the same thing.
- **Remedy:** the copy names none apart from waiting. There's no Contact us or plan upgrade path, because no plan raises this limit.

### 3. Open runs limit reached

Current copy:

> Baton stopped starting new runs because 5,000 are already in progress. Finish or cancel runs to resume.

- **When it shows:** `ShopUsage.openRunsLimitedAt` is set. That happens when reconcile declined to start a run because the shop has `ShopLimits.maxOpenRuns` (5,000) open runs. The code describes this as "a safety valve, not a product limit".
- **What clears it:** the next time reconcile runs with the shop back under the limit.
- **Placement:** it shows on the home and Orders pages, but the work that clears it happens on order and run pages. It doesn't show on the Workflows pages or to members.
- **Likelihood:** very low for the target shop size (under 100 orders a period).

### 4. Import failed

Copy is whatever string was stored. Possible values:

- The order limit sentence (see Duplication under 2).
- `Shopify did not finish the export in time. Try again.` (`GAVE_UP_MESSAGE`)
- `Bulk operation did not complete: <STATUS>`, `Bulk operation disappeared`
- `Step failed: ensure-session`, `Step failed: run-bulk-orders-query`, `Step failed: poll-bulk-orders`, `Step failed: on-orders-sync-empty`, `Step failed: on-orders-stream`
- Any other failure, rendered as-is by `causeToErrorMessage` (from `onOrdersSyncError`), and whatever the Agents SDK passes to `onWorkflowError`.

- **When it shows:** the last import failed. The error stays until the next import completes (`setLastCompletedAt` clears it) or a new import starts.
- **Problem:** everything except the order limit sentence and `GAVE_UP_MESSAGE` is internal text: step names, Shopify bulk operation statuses, raw exception messages.

### 5. Orders could not load

Copy is `ordersQuery.error.message`, falling back to "Could not load orders." when the error has no message. It replaces the table when the orders read fails, which can be a decode mismatch, a Durable Object fault, or an RPC failure. Like 4, it can show raw internal text.

## Questions

1. **Not connected: show a banner at all?** Options:
   - (a) Keep a banner, with plain copy that says reconnecting is automatic, e.g. "Reconnecting to Baton… Changes are paused until it's back."
   - (b) No banner. Disable the write buttons and let each page's own loading or "Connecting" state carry it.
   - (c) Show (a) after 4 s, then escalate to a critical banner with a Reload button if the connection is still down after a longer period (30 s? 60 s?).
2. **Not connected: should merchants and members get different copy?** Members lose all of their run actions while it's down, and merchants lose only some.
3. **Order limit: keep both banner 2 and the import error it duplicates?** Options: drop the `setSyncError` write on a refused import, so banner 2 is the only one, or keep both.
4. **Order limit: what should the copy offer beyond waiting?** A Contact us link, or just the date? Is "Baton is built for shops under N orders" the right framing?
5. **Open runs limit: keep it?** It's a 5,000-run safety valve that a target shop shouldn't reach. Options: keep it as is, move it to where runs are managed, or drop the banner and rely on logs.
6. **Import failed: map internal messages to merchant copy?** For example, one generic "The import didn't finish. Try again." for every step or bulk operation failure, keeping the order limit and time-out messages as they are, with the raw text going to logs only.
7. **Orders could not load: same treatment as 6?** A fixed "Could not load orders. Reload the page." with the raw message logged instead of shown.

# Orders page redesign — research

Research date: 2026-09-03

Scope: how `/app/orders` should look and navigate. Layout, columns, and the split between an index page and a per-order detail page. Route to Ship's screens were reviewed as a reference point only; where this doc departs from them it says why. Data plumbing (sync, webhooks, runs) is out of scope and already decided in `shop-agent-orders-sync-research.md` and `workflow-runs-spec.md`.

## Conclusion

- **Split into two routes.** `/app/orders` becomes a pure index table. `/app/orders/$orderId` becomes a detail page. The current "Details" button that opens a line-items card under the table goes away; the order name in the table is the link.
- **Index columns (in order): Order, Placed, Payment, Workflows, Items, Tags.** Fulfillment drops off the index. Cancelled is a badge next to the order name, not a column. Line-item detail (SKU, personalization, per-item workflows) lives only on the detail page.
- **Workflows is the column that earns the page.** It shows per-order production state derived from `WorkflowRun` rows: a badge such as "2 active · 1 done", or "Not routed" when a paid order has no run. That is the one thing neither the Shopify admin nor a plain sync can show, and it is the reason a maker opens Baton instead of Shopify.
- **Detail page is one column, top to bottom: header, production (line items with their workflows), then order facts.** No customer card. No shipping timeline. No email trail. Baton stores none of that, and the research that led here decided it should not.
- **Sync moves out of the way.** The sync button and status become a header action plus a one-line status under the heading. The full "Sync" section with explanatory paragraph goes; the explanation moves into a tooltip or the empty state.
- **Filters come later, in one specific shape.** Payment (all / paid / unpaid) and Production (all / not routed / active / done). Not in this pass; the table needs a `where` clause and the run counts first.

## What Route to Ship shows, and what to take

Index (`#1559`, screenshot 2026-09-03):

| Column        | Take? | Why                                                                                                                                                                                                                |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Order         | Yes   | Primary key for a human.                                                                                                                                                                                           |
| Customer      | No    | Baton stores no customer identity by decision (`shop-agent-orders-sync-research.md`, "No customer data").                                                                                                          |
| Pipeline      | Yes   | Their pipeline is our workflow. This is the production-state column. Ours comes from runs, not from a tag.                                                                                                         |
| Placed        | Yes   | Sort key; makers think in "when did this come in".                                                                                                                                                                 |
| Payment       | Yes   | Eligibility gate: unpaid orders get no runs (`workflow-runs-spec.md`, Eligibility). The maker needs to see why nothing routed.                                                                                     |
| Fulfillment   | No    | Baton does not fulfil or ship. On a made-to-order shop every open order is UNFULFILLED, so the column is one word repeated. Keep it on the detail page.                                                            |
| Delivery      | No    | Same reason. Their tracking product; not ours.                                                                                                                                                                     |
| Pipeline tags | No    | They route on order tags. We route on product tags at the line-item level, and the tags belong on line items, not the order row. Order tags stay as a column because merchants use them for their own bookkeeping. |
| Tracking      | No    | Not our product.                                                                                                                                                                                                   |

Their board/table toggle: not now. A per-team board already exists as the member queue (`/shop/$shop/queue`). An admin board is a plausible later view but is a different page, not a toggle.

Their province/city/email/name search: no, all customer data.

Their paid and fulfillment segmented filters: take the shape (segmented controls above the table) but change the second axis to production state.

Detail page (`Order #1559`, screenshot 2026-09-03):

| Card              | Take?   | Why                                                                                                                                                                     |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order timeline    | No      | Placed → Paid → In production → Shipped assumes a linear pipeline and shipping. Ours is per line item and has no ship step. The header shows placed/paid facts instead. |
| Customer details  | No      | Not stored.                                                                                                                                                             |
| Tracking emails   | No      | Not our product.                                                                                                                                                        |
| Order notes trail | Partial | The order `note` is shown as text. No trail: Baton does not write notes.                                                                                                |
| Order pipeline    | Yes     | This is the heart of it. Ours is per line item: each line item lists its runs with steps and the current step.                                                          |
| Line items        | Yes     | Merged with the pipeline card, see below. Their "Pipeline" dropdown per line item maps to our "Attach workflow".                                                        |
| Status & tracking | Partial | Payment and fulfillment badges, placed/paid/cancelled/closed timestamps. No tracking.                                                                                   |
| Print             | No      | Later, if ever.                                                                                                                                                         |
| Re-sync           | Yes     | Already exists as `resyncOrder`; becomes a header action.                                                                                                               |

Route to Ship separates "Order Pipeline" (per-item pipeline progress) from "Line items" (per-item facts and the pipeline picker). That is two cards for one list of items and forces the eye to match rows between them. Baton merges them: one card, one row-group per line item, containing the item facts and its workflows.

## Proposed index page

Route: `src/routes/app.orders.tsx` (existing file, gutted).

Header:

- `s-page heading="Orders" inlineSize="large"`.
- `slot="header-actions"`: the Connected/Connecting badge stays. Add the sync button here as a secondary button, label "Sync from Shopify" with the window in a tooltip. Loading state while a workflow is in flight.
- Under the heading, one subdued line: "Last synced Sep 2, 4:12 PM · 52 orders" or "Syncing…" or "Never synced". The `lastError` banner stays, only when non-null.

Table (`s-table` inside `s-section padding="none"`, per the Polaris index-table composition `refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/index-table.md`):

| Column    | `listSlot`                    | Content                                                                                                            |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Order     | `primary`                     | `s-link` to `/app/orders/$orderId` with `order.name`. Cancelled badge (critical) inline when `cancelledAt` is set. |
| Placed    | `secondary`                   | `formatDateTime(processedAt)`.                                                                                     |
| Payment   | `inline`                      | `financialStatus` badge, success when `fullyPaid`, warning otherwise. Blank when null (unchanged from today).      |
| Workflows | `inline`                      | Production-state badge, see below.                                                                                 |
| Items     | `labeled`, `format="numeric"` | Sum of `currentQuantity` (existing `itemUnits`). Header "Items" not "Units"; merchants say items.                  |
| Tags      | `labeled`                     | Order tags joined. Consider `s-badge` per tag capped at three plus "+n".                                           |

Dropped from today's table: Fulfillment, the Details button column, the internal-to-Shopify admin link as the primary link. The admin link moves to the detail page header ("View in Shopify").

Production-state badge, derived per order from its runs:

| Runs for the order                              | Badge                                | Tone    |
| ----------------------------------------------- | ------------------------------------ | ------- |
| none, and order not eligible (unpaid/cancelled) | blank                                |         |
| none, and order eligible                        | "Not routed"                         | warning |
| all `done`                                      | "Done"                               | neutral |
| any `pending` or `active`                       | "n active" (count of pending+active) | info    |
| any run with a non-null `flag`                  | append "· flagged"                   | warning |

"Not routed" is deliberate: a paid order with no matching workflow is the thing an admin has to act on, and today nothing surfaces it.

Data change this needs: `listOrders` returns `OrdersPage` with orders and line items but no runs. Add a `runSummary` per order to the page, computed in SQL in the same repository call (`count(*) filter (where status in ('pending','active'))`, `count(*) filter (where status = 'done')`, `count(*) filter (where flag is not null)` grouped by `orderId`). Line items can then leave the index payload entirely; only the summed `currentQuantity` is needed, which is one more aggregate.

Pagination: keep keyset Newest/Older but use `s-table paginate hasNextPage hasPreviousPage` and its `nextpage`/`previouspage` events instead of two loose buttons. "Previous" needs a cursor stack in component state because the repository is forward-only.

Row click: Polaris `s-table-row` has no `href`. The link in the Order cell is the navigation. `clickDelegate` on the row is for checkboxes, not links, so do not use it. Optionally wrap the cell contents in `s-clickable href` to widen the target.

Empty state: "No orders yet" with the sync button and the explanatory paragraph that currently sits in the Sync section.

## Proposed detail page

Route: new `src/routes/app.orders.$orderId.tsx`. Same no-loader socket-RPC shape as `app.workflows.$workflowId.tsx`, with a `notFound` page when the id is unknown.

`orderId` in the URL: the GID contains `/` characters (`gid://shopify/Order/123`). Use `legacyId` in the path (`/app/orders/6291000000`) and look up by it, or URL-encode the GID. `legacyId` is already a stored column and matches what Shopify shows in its own admin URL, so prefer it. `getOrder` currently takes the GID; add `getOrderByLegacyId` or make the lookup tolerant of either.

Header:

- Breadcrumb `slot="breadcrumb-actions"` → `/app/orders`.
- Heading: `order.name`. Subtitle line: "Placed Sep 1, 7:25 PM".
- Header badges: Payment badge, Cancelled badge if applicable.
- Header actions: "View in Shopify" (`shopify://admin/orders/{legacyId}`, existing `adminOrderUrl` and `useResourceLinkTarget`), "Resync" (existing `resyncOrder`).

Body, single column (`inlineSize="large"`; skip the Polaris details template's aside since there is not enough secondary content to justify it):

1. **Banner area.** `lineItemsComplete === false` warning; run action errors (existing `runBanner`).
2. **Note.** Only when `order.note` is non-null. Shown prominently because it is production instruction, not metadata. Heading "Order note".
3. **Line items.** One `s-section` heading "Line items". For each line item a bordered `s-box` group:
   - Title row: `title — variantTitle`, `×currentQuantity` on the right, SKU subdued. Strikethrough or "removed" badge when `currentQuantity === 0`.
   - Personalization: `customAttributes` as a two-column key/value list, not a comma-joined string. This is the field a maker reads most; a joined string is what Route to Ship's blog calls out as the admin's failure.
   - Product tags as small badges.
   - Workflows: the existing `renderRuns` content, one row per run: workflow name, status badge, current step name with team, flag badge, cancel/undo. Show steps as a compact inline progress: "Cut ✓ · Engrave ● · Polish".
   - "Attach workflow" select + button, as today, but only for line items with `currentQuantity > 0`.
4. **Order details.** Two-column `s-grid` of facts: Placed, Paid (`financialStatus`), Fulfillment (`fulfillmentStatus`), Cancelled, Closed, Order tags, Order attributes (`customAttributes` on the order), Last synced (`syncedAt`, `syncSource`).

Data change: a single `getOrderDetail({ legacyId })` callable that returns `OrderDetail` plus `WorkflowRunDetail[]` in one round trip, replacing the two queries the current page issues (`activateOrders` then `listRunsForOrder`). The runs query key `["runs", shop, orderId]` and its invalidation logic move to this route.

Live updates: the detail page subscribes to the same `"invalidated"` message and refetches its one query. The `activate`/`deactivate` session-token attachment stays on the index route only; the detail page can use plain invalidation because a webhook on this order also pokes the connection.

## Decisions (2026-09-03)

1. **Sort:** placed-desc only. Each extra sort key needs its own keyset cursor; makers work newest-first.
2. **Filters:** next pass, after the run aggregate lands. Shape when they come: Payment (all / paid / unpaid) and Production (all / not routed / active / done).
3. **Order tags:** stay on the index, capped at three badges plus "+n".
4. **Cancelled orders:** shown in the index with a critical badge, matching the Shopify admin. Never hidden, so a flagged run's order stays findable.
5. **Removed line items** (`currentQuantity === 0`): shown struck-through on the detail page, so an `item_removed` flag has its item in view.
6. **URL id:** `legacyId`. Already stored, slash-free, matches the Shopify admin URL.
7. **Admin board view:** deferred indefinitely. Boards scale badly with order volume; the index reserves no view toggle.

## Decisions not to relitigate

- No customer fields anywhere, including search.
- No fulfillment or shipping actions; fulfillment status is read-only detail.
- One data source: the Durable Object over the socket; no route loaders on these pages.

## Sources

- Current page: `src/routes/app.orders.tsx`; detail-route pattern: `src/routes/app.workflows.$workflowId.tsx`.
- Data shapes: `src/lib/Domain.ts` (`ShopOrder`, `OrderLineItem`, `WorkflowRun`, `WorkflowRunDetail`); `src/lib/OrderRepository.ts` (`listOrders`, `getOrder`); `src/lib/WorkflowRunRepository.ts` (`listRunsForOrder`).
- Polaris web components: `refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/index-table.md`, `.../patterns/templates/details.md`, `.../web-components/layout-and-structure/table.md` (`paginate`, `loading`, `listSlot`, sortable headers).
- Route to Ship screenshots supplied 2026-09-03; their positioning in `refs/route-to-ship/blog/why-shopify-orders-page-fails-custom-sellers.md` (line item properties hidden behind a click is the stated pain).
- Prior decisions: `docs/shop-agent-orders-sync-research.md`, `docs/workflow-runs-spec.md`.

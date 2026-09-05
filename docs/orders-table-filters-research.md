# Orders table filters — research

Research date: 2026-09-05

Scope: a second look at Route to Ship's orders **table** view (screenshot 2026-09-05, `#1558`–`#1562`) against `/app/orders` as it stands after `orders-page-redesign-research.md` (2026-09-03) and `order-lifecycle-spec.md` (2026-09-04). The column decisions from the redesign are settled and implemented; this doc is about the filter row, plus a review of the JSON-in-a-text-column choice that a tag filter would run into. Pagination, email, customer, and address search are out of scope by standing decision (no customer data in Baton).

## Conclusion

- **Add a Payment filter: All / Paid / Not paid.** `fullyPaid` gates run creation, so "why is nothing routed" is the first question a merchant asks and this answers it. One `where` clause on a column that already exists.
- **Do not add a separate Fulfillment filter.** Widen the existing production-state control instead: All / Not routed / In production / Ready to ship / Shipped. "Shipped" is exactly Route to Ship's "Fulfilled"; everything else is "Unfulfilled". One control in Baton's vocabulary, not two in Shopify's.
- **Keep the Tags column; defer a tag filter.** Nothing in Baton routes on order tags, and the Shopify admin already filters by tag. When a merchant asks for it, it is a `json_each` clause, not a schema change.
- **Show the filter as a stage strip with counts, but count only the open stages.** A count over every stored order is a full-table read on each refresh of a subscribed page, and Durable Object SQLite bills per row read. The three open stages are counted through a partial index over unfulfilled, uncancelled orders, so the cost is one row per open order. "All" and "Shipped" carry no number. See Counts.
- **No column changes.** Two cosmetic candidates noted below, neither recommended now.
- **JSON-in-text columns are the right call for this data. Not a design flaw.** Detail in the last section.

## What Route to Ship's table shows, and what to take

| Element                                 | Take?    | Why                                                                                                                                                       |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board / Table toggle                    | No       | Unchanged from the redesign research: the member queue is the board; an admin board would be its own page.                                                |
| Province / city selects                 | No       | Customer data.                                                                                                                                            |
| Search email / name                     | No       | Customer data.                                                                                                                                            |
| Tag (comma-separated) filter            | Later    | See Tags below.                                                                                                                                           |
| Clear                                   | Yes      | Once there are two filter groups, one "Clear" that resets both to All is worth having. It is `navigate({ search: {} })`.                                  |
| Paid: All / Paid / Not paid             | Yes      | Eligibility gate. See Payment filter.                                                                                                                     |
| Fulfillment: All / Fulfilled / Unfulf.  | Reshaped | Folded into the production-state control as "Shipped". See Production filter.                                                                             |
| Column: Customer                        | No       | Customer data.                                                                                                                                            |
| Column: Pipeline (stacked named badges) | No       | Ours is a derived state badge with run counts. A named-workflow variant is discussed below and not recommended yet.                                       |
| Column: Placed as "4 h ago"             | Not now  | Relative time reads better for today's orders and worse for last week's. Cheap, cosmetic, no merchant has asked.                                          |
| Column: Fulfillment                     | No       | Dropped in the redesign; on a made-to-order shop every open order is UNFULFILLED. It lives on the detail page and, after this doc, in the Shipped filter. |
| Column: Delivery / Tracking             | No       | Not our product.                                                                                                                                          |
| Column: Pipeline tags                   | No       | They route on order tags; we route on product tags at line-item level. Order tags remain their own column for merchant bookkeeping.                       |

## Payment filter

Search param `paid`: absent, `true`, or `false`. Repository input `paid: boolean | null`. SQL: `fullyPaid = 1` / `fullyPaid = 0`. The column is already indexed by nothing; the keyset index on `(processedAt, id)` still drives the scan and the predicate filters rows as they stream, which is fine at the tens-of-thousands scale a single shop's Durable Object holds.

The badge in the Payment column stays as is (Shopify's `displayFinancialStatus` text, success tone when `fullyPaid`). The filter is on the boolean, not the status string, because that is what gates runs.

## Production filter

The existing `?state=` param already carries `Domain.ProductionState`; the control just offers more of its values. Today only `ready_to_ship` has a SQL form (`OrderRepository.listOrders`). The others need one each, all restating `Domain.productionState` and required to move with it:

| Value           | SQL fragment                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_routed`    | `cancelledAt is null and fullyPaid = 1 and fulfillmentStatus <> 'FULFILLED' and not exists (select 1 from WorkflowRun r where r.orderId = ShopOrder.id)` |
| `in_production` | `cancelledAt is null and fulfillmentStatus <> 'FULFILLED' and exists (… r.status in ('pending','active'))`                                               |
| `ready_to_ship` | as today                                                                                                                                                 |
| `shipped`       | `fulfillmentStatus = 'FULFILLED'`                                                                                                                        |
| `cancelled`     | not offered in the control; `cancelledAt is not null` if ever wanted                                                                                     |

The order of the buttons is the order of the lifecycle: Not routed, In production, Ready to ship, Shipped. "Not routed" is the actionable one and sits first after All.

The `countText` copy per state: "N orders with no matching workflow", "N orders in production", the existing ready-to-ship sentence, "N orders fulfilled in Shopify".

Both groups compose with `sql.and([keyset, stateFilter, paidFilter])`. The query key gains `paid` next to `state`, and the loader deps too. The cursor stack resets on any filter change, as it does today.

## Layout: the stage strip

Mockup (interactive): https://claude.ai/code/artifact/8965601f-72a8-47c7-83d2-85047ed0b7f3

The filter is the lifecycle. The card opens with one tile per stage in the order an order moves through them — All, Not routed, In production, Ready to ship, Shipped — each tile carrying its count where one is cheap, its label, and a one-line hint. The selected tile has a subdued background. Below it a small Payment segmented control and a "Clear filters" link that only appears when something is set. This replaces the two lonely buttons that used to sit above the table and makes "Ready to ship" a stage next to its neighbours rather than a mode off to one side.

`s-clickable` rather than `s-button` for the tiles: a tile carries three lines and a selected background, which a button cannot. `aria-pressed` on the element carries the selected state for assistive tech.

## Counts

Every `count(*)` over `ShopOrder` reads every row the shop has ever stored, on every refresh of a page that refetches on each order-state push. The previous "N stored" line did exactly that and is gone.

The three open stages are counted in one query whose `where` is, character for character, the predicate of the partial index `ShopOrder_open_idx` (`fulfillmentStatus <> 'FULFILLED' and cancelledAt is null`). SQLite uses a partial index only when the query's `where` provably implies the index's, and it proves that by matching terms, so the repository keeps that string in one constant and reuses it for the filters and the count. The count then reads one row per open order plus a correlated probe of `WorkflowRun_orderId_idx` for each, which on a made-to-order shop is the active work, not the history.

"All" and "Shipped" have no count. Both are dominated by history, and the number would tell a merchant nothing they act on.

The counts are independent of the `paid` filter so the strip reads the same in either payment view. An unpaid open order with no runs is the `null` state and falls in no bucket.

## `productionState` change

An order fulfilled in Shopify with no runs at all used to read as "Not routed". Every historical order the window sync pulls in is exactly that, so a fresh install showed a wall of warnings nobody could act on. `shipped` is now checked right after `cancelled`, before the run counts. The domain test case changed accordingly.

## Tags

Order tags are stored as a JSON array in `ShopOrder.tags text`. A filter of the Route to Ship shape (comma-separated, match any) would be:

```sql
exists (
  select 1 from json_each(ShopOrder.tags) t
  where lower(t.value) in (select value from json_each(?))
)
```

with the wanted tags passed as one JSON-array parameter, which is already the house pattern for id lists (`Repository.ts`, `WorkflowRunRepository.ts`). No schema change, no resync. It is a table scan over the page's candidate rows, which is acceptable for one shop's orders.

Deferred because nothing in Baton acts on order tags, the Shopify admin's tag filter is better than any we would build, and a text input plus a comma parser is more UI than the two segmented groups combined.

## Named workflows in the state column

Route to Ship names the pipeline in the row. Ours reads "2 active · 1 done". A merchant looking for "which of these are Embroidery" has to open each order. The alternative is distinct `workflowName` values from the order's runs, capped at two badges plus "+n", with the counts moved to a tooltip or dropped.

Not recommended yet: it needs a third aggregate per page (or a `group_concat`), it makes the column wider on multi-item orders, and the detail page answers the question one click away. Revisit when the detail page proves insufficient.

## The JSON-in-text columns

Columns that hold JSON today, all decoded through `Schema.fromJsonString`:

| Table           | Column             | Shape                        | Ever filtered on?                                 |
| --------------- | ------------------ | ---------------------------- | ------------------------------------------------- |
| `ShopOrder`     | `tags`             | `string[]`                   | Not yet; candidate above.                         |
| `ShopOrder`     | `customAttributes` | `{ key, value }[]`           | No. Display only.                                 |
| `ShopOrder`     | `raw`              | the Shopify order node       | No. Exists for `json_extract` promotion.          |
| `OrderLineItem` | `productTags`      | `string[]`                   | Yes, in TypeScript: workflow matching by tag set. |
| `OrderLineItem` | `customAttributes` | `{ key, value }[]`           | No. Personalization text a maker reads.           |
| `Workflow`      | `tags`             | `string[]` (normalized, ≤ N) | Yes, in TypeScript: the other side of matching.   |
| `WorkflowRun`   | `customAttributes` | snapshot of the line item's  | No.                                               |
| `WorkflowRun`   | `flagDetail`       | tagged union per flag        | No.                                               |

Everything that is queried, joined, sorted, or keyed is a real column: ids, statuses, timestamps, `fullyPaid`, `fulfillmentStatus`, `teamId`, `stage`, `position`. The JSON columns are exactly the fields that are variable-length lists or open-shaped blobs owned by Shopify or by the merchant.

**Why JSON rather than a join table for tags.**

- The row is a snapshot of a Shopify object. Tags arrive as an array on the order or product and are replaced wholesale on every sync or webhook. A join table turns one `insert or replace` into a delete-and-reinsert per row, inside a bulk stream that writes thousands of orders, for no reader that needs it.
- Workflow matching runs in TypeScript over one line item's tags against one workflow's tags. Both sides are small sets; SQL adds nothing to that.
- SQLite's JSON1 is built into the Durable Object runtime. `json_each` gives a virtual table over the array whenever a query needs one, and the codebase already leans on it for id lists. So "we can't filter on it" is not true; "we can't index it" is the real cost.
- Schema.fromJsonString gives a validated, typed decode at the boundary. A join table would give the same type through two decoders and an aggregation step.

**What it costs.**

- No index on tag values. A tag filter is a scan of the candidate rows. For one shop's order history in a Durable Object that is fine; for a cross-shop query it would not be, but there is no cross-shop table by design.
- No uniqueness or referential integrity on tags. Irrelevant here: tags are Shopify's strings, not Baton's entities.
- `raw` is a copy of data already in columns. That is a deliberate escape hatch, sized at one order node without line items, and nothing reads it in a request path.

**Where the same choice would be wrong.** A tag that Baton owned and edited, that had to be unique, that joined to something, or that a page sorted by. None of the eight columns above is that. `Workflow.tags` is the closest: it is merchant-authored and normalized. It still matches in TypeScript and is bounded by `WorkflowLimits.maxTags`, so a join table would be more code for the same behaviour. If tags ever need an index, the promotion path is a generated column (`tag_count` or a per-tag table populated in the same transaction), not a rewrite of the readers.

**Recommendation.** Keep the JSON columns. Build the tag filter with `json_each` when it is asked for. Revisit only if a per-tag index is measurably needed, which at a single-shop scale it will not be.

## Implemented 2026-09-05

- `src/lib/Domain.ts`: `ListOrdersInput.paid`; `OrdersPage.openCounts` (`OpenStageCounts`) replaces `orderCount`; `productionState` checks `fulfilled` before the run counts; `SeedOrdersInput.unpaid`.
- `src/lib/ShopAgent.ts`: partial index `ShopOrder_open_idx`; `readOrders` passes `paid`; the seed writes `PENDING` / `fullyPaid: false` for `unpaid`.
- `src/lib/OrderRepository.ts`: one SQL fragment per state, the `paid` clause, and the one-pass open-stage count, all built from the shared `OPEN` / `ANY_RUN` / `OPEN_RUN` / `DONE_RUN` constants.
- `src/routes/app.orders.index.tsx`: `?paid=` search param; the stage strip; the Payment control; Clear; per-stage copy and empty states.
- `e2e/fixture.ts`: `#9004` unpaid.
- `test/integration/order-repository.test.ts`: every state fragment checked row by row against `Domain.productionState`, the counts, and paid paging.

- `src/lib/orderLinks.ts`: `adminOrderUrl` and `useResourceLinkTarget`, moved out of the detail route so the index can use them. Every row ends in a Shopify column: "Fulfil in Shopify" on a ready-to-ship row, "View in Shopify" otherwise.

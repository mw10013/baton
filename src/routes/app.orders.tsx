import {
  createFileRoute,
  Outlet,
  retainSearchParams,
} from "@tanstack/react-router";
import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { lenientSearchKey, ListSearchParam } from "@/lib/searchParams";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * Set on the entry the orders index's Next pushes: the entry before this
     * one is the same list one page up, so Previous can be the browser's Back.
     * See `previousPage` in `app.orders.index.tsx`.
     */
    readonly ordersNextPage?: true;
  }
}

/**
 * **The merchant's context on the orders index, and it travels.** The same
 * rule as the member area's {@link MemberSearch} (`shop.$shop.tsx`), which
 * carries the reasoning: the keys live on the layout so every page under it,
 * the order page included, may carry them, and `retainSearchParams` puts them
 * on every link and navigation under `/app/orders` — the row link, the order
 * page's breadcrumb, and the `shopify:navigate` bridge in `app.tsx`, which
 * adds no search of its own. So the breadcrumb, the Orders nav link
 * and the browser's Back all land on the filters and the page the merchant
 * left.
 *
 * `?show=` is the main filter (`Domain.OrdersShow`; `made` is the packer's
 * queue, `issues` the merchant's, `all` the whole history), and an absent
 * `show` is Open. `?q=` is the search (`Domain.searchTerm`): it searches every
 * stored order and the filters are then ignored (`Domain.ListOrdersInput.q`),
 * though they stay in the URL so Clear search returns to them. `?team=` keeps
 * only orders waiting on that team. An old `?view=`, `?position=` or `?issues=` is not a key and is
 * dropped by the first navigation.
 * `?after=` is the page, as the keyset cursor it starts after; an absent
 * `after` is page one.
 *
 * What differs from the member area:
 *
 * - The layout is `/app/orders`, not `/app`: an orders filter has no
 *   business on a `/app/teams` URL.
 * - No `stripSearchParams`: none of the keys has a default value; absence is
 *   the default, and the index writes it by leaving the key out.
 * - `after` is a page, where the member's workflows list's `limit` is a
 *   depth. A depth only grows, so one number says everything; a keyset cursor pages forward only,
 *   and the page before it is not in the URL. Previous is the browser's Back
 *   when the entry before is that page, which is what {@link HistoryState}'s
 *   `ordersNextPage` records.
 *
 * **No value of these keys fails**, for `MemberSearch`'s reason: an
 * unreadable value reads as that filter being off ({@link lenientSearchKey}).
 * Before this layout the index validated strictly, and a stale or hand-edited
 * filter put the router's error boundary over the page. `after` that is
 * not shaped like a cursor is dropped here (`Domain.OrdersCursor`), so
 * Previous stays off; one that is shaped like a cursor but no longer names a
 * row is the repository's to absorb: its keyset seek lands on the next row
 * (`OrderRepository.listOrders`).
 */
const OrdersSearch = Schema.Struct({
  q: lenientSearchKey(ListSearchParam),
  show: lenientSearchKey(Domain.OrdersShow),
  team: lenientSearchKey(Domain.TeamId),
  after: lenientSearchKey(Domain.OrdersCursor),
});

/**
 * Layout for the orders pages: the search context ({@link OrdersSearch}) and
 * nothing else. `from-shopify` is a child too; its passthrough search reaches
 * its redirect intact because the router spreads each route's validated
 * search over the raw one rather than replacing it.
 */
export const Route = createFileRoute("/app/orders")({
  validateSearch: Schema.toStandardSchemaV1(OrdersSearch),
  search: {
    middlewares: [retainSearchParams(["q", "show", "team", "after"])],
  },
  component: () => <Outlet />,
});

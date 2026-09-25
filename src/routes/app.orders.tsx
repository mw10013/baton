import {
  createFileRoute,
  Outlet,
  retainSearchParams,
} from "@tanstack/react-router";
import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { lenientSearchKey } from "@/lib/searchParams";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * Set on the entry the orders list's Next pushes: the entry before this
     * one is the same list one page up, so Previous can be the browser's Back.
     * See `previousPage` in `app.orders.index.tsx`.
     */
    readonly ordersNextPage?: true;
  }
}

/**
 * **The merchant's context on the orders list, and it travels.** The same
 * rule as the member area's {@link MemberSearch} (`shop.$shop.tsx`), which
 * carries the reasoning: the keys live on the layout so every page under it,
 * the order page included, may carry them, and `retainSearchParams` puts them
 * on every link and navigation under `/app/orders` — the row link, the order
 * page's breadcrumb, and the `shopify:navigate` bridge in `app.tsx`, which
 * adds no search of its own. So the breadcrumb, the Orders nav link
 * and the browser's Back all land on the filters and the page the merchant
 * left.
 *
 * `?q=` is the order-number search; `?status=` picks a lifecycle position
 * (`made` is the packer's view, `all` the whole history); `?need=`
 * keeps only open orders with that problem (`Domain.OrderNeed`); `?team=`
 * keeps only orders waiting on that team, which is the link the team detail
 * page drills in with; `?after=` is the page, as the keyset cursor it starts
 * after. An absent `status` is open work (`Domain.OrdersStatus`), an absent
 * `need` is anything, an absent `after` is page one.
 *
 * What differs from the member area:
 *
 * - The layout is `/app/orders`, not `/app`. The workflows list has its own
 *   `status` key (`app.workflows.tsx`) and the two would collide, and an
 *   orders filter has no business on a `/app/teams` URL.
 * - No `stripSearchParams`: none of the keys has a default value; absence is
 *   the default, and the index writes it by leaving the key out.
 * - `after` is a page, where the run list's `limit` is a depth. A depth only
 *   grows, so one number says everything; a keyset cursor pages forward only,
 *   and the page before it is not in the URL. Previous is the browser's Back
 *   when the entry before is that page, which is what {@link HistoryState}'s
 *   `ordersNextPage` records.
 *
 * **No value of these keys fails**, for `MemberSearch`'s reason: an
 * unreadable value reads as that filter being off ({@link lenientSearchKey}).
 * Before this layout the index validated strictly, and a stale or hand-edited
 * `?status=` put the router's error boundary over the page. `after` that is
 * not shaped like a cursor is dropped here (`Domain.OrdersCursor`), so
 * Previous stays off; one that is shaped like a cursor but no longer names a
 * row is the repository's to absorb: its keyset seek lands on the next row
 * (`OrderRepository.listOrders`).
 */
const OrdersSearch = Schema.Struct({
  q: lenientSearchKey(Domain.OrderSearch),
  status: lenientSearchKey(Domain.OrdersStatus),
  need: lenientSearchKey(Domain.OrderNeed),
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
    middlewares: [retainSearchParams(["q", "status", "need", "team", "after"])],
  },
  component: () => <Outlet />,
});

import {
  createFileRoute,
  Outlet,
  retainSearchParams,
} from "@tanstack/react-router";
import { Schema, SchemaGetter } from "effect";

import * as Domain from "@/lib/Domain";
import { lenientSearchKey } from "@/lib/searchParams";

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
 * **A bare order number in the URL is the search.** The router JSON-encodes
 * every search value, so a search the app writes is `?q="1575"` and comes
 * back a string, but a merchant who types or shares `?q=1575` by hand gets
 * the number 1575 from the parser, which `Domain.OrderSearch` refuses and
 * {@link lenientSearchKey} would then drop as no search: a URL that looked
 * right would open the unfiltered list. A number is read as its digits;
 * everything else is the string it already was. Only the read widens: the
 * app keeps writing the string form, and `q` is the one key a person would
 * type, since a view is a word and a team or cursor is an id.
 */
const OrderSearchParam = Schema.Union([Schema.String, Schema.Number]).pipe(
  Schema.decodeTo(Domain.OrderSearch, {
    // oxlint-disable-next-line unicorn/prefer-native-coercion-functions -- bare `String` is typed `(value?: any) => string` and loses the union
    decode: SchemaGetter.transform((value: string | number) => String(value)),
    encode: SchemaGetter.transform((q) => q),
  }),
);

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
 * `?view=` picks a view (`Domain.OrdersIndexView`; `made` is the packer's
 * queue, `all` the whole history), and an absent `view` is Open. `?q=` is
 * the order-number search: it searches every stored order and the view and
 * team are then ignored (`Domain.ListOrdersInput.q`), though they stay in the
 * URL so clearing the field returns to them. `?team=` keeps only orders
 * waiting on that team, which is the link the team page drills in with.
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
  q: lenientSearchKey(OrderSearchParam),
  view: lenientSearchKey(Domain.OrdersIndexView),
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
    middlewares: [retainSearchParams(["q", "view", "team", "after"])],
  },
  component: () => <Outlet />,
});

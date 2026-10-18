import { createFileRoute, useLocation } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type ListOrdersInput, OrdersCursor } from "../../domain/shop-work.ts";
import { ORDERS_PAGE_SIZE } from "../client/shop-actor-client.ts";
import { useNavigateOnClick } from "../components/navigate.ts";
import OrdersPage from "../components/OrdersPage.tsx";
import { listOrders } from "../server/orders.ts";
import { appSearch } from "./-app-search.ts";

/**
 * `?after=` is the page, as the keyset cursor it starts after; an absent `after` is page one.
 * A value that is not shaped like a cursor reads as page one rather than failing the route: a
 * stale or hand-edited URL still opens the list. One that is shaped like a cursor but names no
 * row any more is the repository's to absorb: its keyset seek lands on the next row.
 */
const OrdersSearch = Schema.Struct({
  after: Schema.optionalKey(
    Schema.UndefinedOr(OrdersCursor).pipe(
      Schema.catchDecoding(() => Effect.succeedSome(undefined)),
    ),
  ),
});

/**
 * The page `after` names, as the orders index reads it. Every order, with no search or team, as
 * the screen has listed them so far; its Show, Team and search arrive with the full index.
 */
const ordersInput = (after: ListOrdersInput["cursor"]): ListOrdersInput => ({
  limit: ORDERS_PAGE_SIZE,
  cursor: after,
  q: null,
  show: "all",
  team: null,
});

/**
 * The merchant's orders screen under the App Home, whose guards have already run. The loader
 * reads the page `after` names; during SSR its session token is the document's `id_token`, in
 * the browser App Bridge's bearer. Next page is a link to the same raw search Shopify sent with
 * `after` set, because the `/app` guards read that search on every navigation (`appSearch`).
 */
export const Route = createFileRoute("/app/orders")({
  validateSearch: Schema.toStandardSchemaV1(OrdersSearch),
  loaderDeps: ({ search }) => ({ after: search.after ?? null }),
  loader: ({ location, deps }) =>
    listOrders({
      data: {
        idToken: appSearch(location.searchStr).id_token,
        ...ordersInput(deps.after),
      },
    }),
  component: function OrdersRoute() {
    const { after } = Route.useLoaderDeps();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const navigate = useNavigateOnClick();
    const pageLink = (cursor: string) => {
      const search = new URLSearchParams(searchStr);
      search.set("after", cursor);
      return navigate(`/app/orders?${search.toString()}`);
    };
    return (
      <OrdersPage input={ordersInput(after)} data={Route.useLoaderData()} pageLink={pageLink} />
    );
  },
});

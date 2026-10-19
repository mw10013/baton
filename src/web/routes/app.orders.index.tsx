import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import { liveLoad } from "../client/live-load.ts";
import {
  merchantOrdersQuery,
  merchantUsageQuery,
  ordersIndexInput,
} from "../client/shop-actor-client.ts";
import { useNavigateOnClick } from "../components/navigate.ts";
import OrdersIndexPage from "../components/OrdersIndexPage.tsx";
import { listOrders, orderUsage } from "../server/orders.ts";
import { appHref, appSearch } from "./-app-search.ts";
import { useNextPageEntry } from "./-table-pages.ts";
import { decodeOrdersSearch } from "./-orders-search.ts";

const PATH = "/app/orders";

/**
 * The orders index under the App Home: the loader reads the page the URL names in the actor
 * through the Backend (`listOrders`), and the shop's usage for its quota banner (`orderUsage`),
 * each a live read the registry answers when it keeps it ({@link liveLoad}); during SSR its
 * session token is the document's `id_token`, in the browser App Bridge's bearer. Every link and navigation keeps the raw search Shopify sent
 * ({@link appHref}). The links to an order carry the index's search, filters and page, so the
 * order page's breadcrumb lands back here as it was. A filter or a page is a patch over the
 * latest URL (`router.latestLocation`), not this render's keys: the URL commits before the page
 * re-renders with it, so a second control pressed in that window would write the first one's old
 * value back.
 */
export const Route = createFileRoute("/app/orders/")({
  loaderDeps: ({ search }) => ({
    q: search.q ?? null,
    show: search.show ?? null,
    team: search.team ?? null,
    after: search.after ?? null,
  }),
  loader: async ({ location, deps, context: { registry } }) => {
    const idToken = appSearch(location.searchStr).id_token;
    const input = ordersIndexInput(deps);
    const [data, usage] = await Promise.all([
      liveLoad({
        registry,
        query: merchantOrdersQuery(input),
        fetch: () => listOrders({ data: { idToken, ...input } }),
      }),
      liveLoad({
        registry,
        query: merchantUsageQuery,
        fetch: () => orderUsage({ data: { idToken } }),
      }),
    ]);
    return { data, usage };
  },
  component: function OrdersRoute() {
    const { q, show, team, after } = Route.useLoaderDeps();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const nextPageEntry = useNextPageEntry();
    const { data, usage } = Route.useLoaderData();
    return (
      <OrdersIndexPage
        data={data}
        usage={usage}
        q={q}
        show={show}
        team={team}
        after={after}
        orderLink={(legacyId) =>
          navigate(appHref(`${PATH}/${legacyId}`, searchStr, { q, show, team, after }))
        }
        onFilter={(patch) => {
          // The filters are a screen's state, not a trail, so the URL is replaced; a new list
          // starts at page one.
          const latest = decodeOrdersSearch(router.latestLocation.search);
          void router.navigate({
            href: appHref(PATH, router.latestLocation.searchStr, {
              q: patch.q === undefined ? latest.q : patch.q,
              show: patch.show === undefined ? latest.show : patch.show,
              team: patch.team === undefined ? latest.team : patch.team,
            }),
            replace: true,
          });
        }}
        onNextPage={(cursor) => {
          const latest = decodeOrdersSearch(router.latestLocation.search);
          void router.navigate({
            href: appHref(PATH, router.latestLocation.searchStr, { ...latest, after: cursor }),
            state: { nextPage: true },
          });
        }}
        onPreviousPage={() => {
          if (nextPageEntry) router.history.back();
          else {
            const { after: _page, ...latest } = decodeOrdersSearch(router.latestLocation.search);
            void router.navigate({
              href: appHref(PATH, router.latestLocation.searchStr, latest),
              replace: true,
            });
          }
        }}
      />
    );
  },
});

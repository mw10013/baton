import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useNavigateOnClick } from "../components/navigate.ts";
import OrderPage from "../components/OrderPage.tsx";
import { orderDetail } from "../server/orders.ts";
import { appHref, appSearch } from "./-app-search.ts";

/**
 * One order's page under the App Home, addressed by its legacy id, so the URL matches the one
 * the Shopify admin uses for the same order: the loader reads it in the actor through the
 * Backend (`orderDetail`, `null` for no such order). The breadcrumb carries the orders index's
 * search, filters and page the link here came with, so it lands on the list as it was.
 */
export const Route = createFileRoute("/app/orders/$orderId")({
  loader: ({ location, params }) =>
    orderDetail({
      data: { idToken: appSearch(location.searchStr).id_token, legacyId: params.orderId },
    }),
  component: function OrderRoute() {
    const { orderId } = Route.useParams();
    const { q, show, team, after } = Route.useSearch();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const navigate = useNavigateOnClick();
    return (
      <OrderPage
        key={orderId}
        legacyId={orderId}
        data={Route.useLoaderData()}
        ordersLink={navigate(appHref("/app/orders", searchStr, { q, show, team, after }))}
        workflowsLink={navigate(appHref("/app/workflows", searchStr))}
      />
    );
  },
});

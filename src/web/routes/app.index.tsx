import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useNavigateOnClick } from "../components/navigate.ts";
import { Lines } from "../components/screen/Lines.tsx";
import { appHref } from "./-app-search.ts";

/**
 * The App Home's landing page: the shop, and the ways to Orders, Teams and Members. The links keep
 * the raw search Shopify sent, because the `/app` guards read it on every navigation
 * ({@link appHref}).
 */
export const Route = createFileRoute("/app/")({
  component: function AppHome() {
    const { shop } = Route.useRouteContext();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Baton">
        <s-section heading={shop}>
          <Lines>
            <s-link {...navigate(appHref("/app/orders", searchStr))}>Orders</s-link>
            <s-link {...navigate(appHref("/app/teams", searchStr))}>Teams</s-link>
            <s-link {...navigate(appHref("/app/members", searchStr))}>Members</s-link>
          </Lines>
        </s-section>
      </s-page>
    );
  },
});

import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { BackLink } from "../components/screen/BackLink.tsx";
import ShopPage from "../components/ShopPage";

const shopLayout = getRouteApi("/shop/$key");

/** A member's shop page: the layout's snapshot, or why not, under the layout's socket. */
export const Route = createFileRoute("/shop/$key/")({
  component: function MemberShopRoute() {
    const { key } = shopLayout.useParams();
    return (
      <>
        <BackLink label="Your stores" href="/shop" />
        <ShopPage role="member" shop={key} data={shopLayout.useLoaderData()} />
      </>
    );
  },
});

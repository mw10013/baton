import { createFileRoute, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../domain/platform.ts";
import AdminShopPage from "../components/AdminShopPage.tsx";
import { useNavigateOnClick } from "../components/navigate.ts";
import { adminShop, refreshPlan } from "../server/admin.ts";

/**
 * `staleReloadMode: "blocking"` makes a *revisit* wait for fresh data instead of painting the
 * previous visit's.
 *
 * The router's stale time is `0`, so a cached match is stale the moment it is left, and the
 * default `"background"` mode is stale-while-revalidate: it renders the existing loader data at
 * once and refreshes behind it. For a list that is fine. Here every number on the page (the
 * actor's stored state and the cached plan) is a point-in-time reading whose purpose is to be
 * current, and an admin who looks at one shop, looks at another, and comes back is the normal
 * way the page is used. Under `"background"` that return paints the earlier reading with
 * nothing marking it as old, which is worst precisely when someone is checking whether something
 * just changed. `"blocking"` makes the revisit behave like a first load.
 *
 * It is *not* what makes Refresh plan correct: that is `invalidate({ sync: true })`, whose
 * promise resolves only once the loaders have finished, so the button holds its loading state
 * until the new plan is in hand. The two are independent.
 *
 * @see https://tanstack.com/router/latest/docs/framework/react/guide/data-loading
 */
export const Route = createFileRoute("/admin/shop/$shop")({
  params: {
    parse: ({ shop }) => ({ shop: Schema.decodeUnknownSync(ShopKey)(shop) }),
    stringify: ({ shop }) => ({ shop }),
  },
  loader: {
    handler: ({ params }) => adminShop({ data: { shop: params.shop } }),
    staleReloadMode: "blocking",
  },
  component: function ShopRoute() {
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const { shop } = Route.useParams();
    return (
      <AdminShopPage
        shop={shop}
        data={Route.useLoaderData()}
        shopsLink={navigate("/admin/shops")}
        onRefresh={async () => {
          const failure = await refreshPlan({ data: { shop } });
          if (failure !== null) return failure.message;
          await router.invalidate({ sync: true });
          return null;
        }}
      />
    );
  },
});

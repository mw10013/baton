import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../domain/platform.ts";
import AdminShopsPage from "../components/AdminShopsPage.tsx";
import { useNavigateOnClick } from "../components/navigate.ts";
import { shopSessionsPage } from "../server/admin.ts";
import { lenientSearchKey, ListSearchParam } from "./-search-params.ts";

/**
 * The Shops list's URL: a keyset cursor either way and the search by shop. Lenient, as the other
 * lists' are: a stale or hand-edited value reads as page one, or no search.
 */
const ShopsSearch = Schema.Struct({
  after: lenientSearchKey(ShopKey),
  before: lenientSearchKey(ShopKey),
  filter: lenientSearchKey(ListSearchParam),
});

/**
 * Two loader redirects keep the URL honest: a cursor both ways keeps `after` alone, and a cursor
 * past the end (a shop uninstalled since the link was made) goes back to page one of the same
 * search. `staleReloadMode: "blocking"`: see the shop page's route.
 */
export const Route = createFileRoute("/admin/shops")({
  validateSearch: Schema.toStandardSchemaV1(ShopsSearch),
  loaderDeps: ({ search }) => ({
    after: search.after,
    before: search.before,
    filter: search.filter,
  }),
  loader: {
    handler: async ({ deps }) => {
      if (deps.after !== undefined && deps.before !== undefined)
        throw redirect({ to: "/admin/shops", search: { after: deps.after, filter: deps.filter } });
      const result = await shopSessionsPage({ data: deps });
      if (
        (deps.after !== undefined || deps.before !== undefined) &&
        result.page.shopSessions.length === 0
      )
        throw redirect({ to: "/admin/shops", search: { filter: deps.filter } });
      return result;
    },
    staleReloadMode: "blocking",
  },
  component: function ShopsRoute() {
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const { filter } = Route.useLoaderDeps();
    const { page, now } = Route.useLoaderData();
    return (
      <AdminShopsPage
        page={page}
        now={now}
        filter={filter ?? null}
        adminLink={navigate("/admin")}
        shopLink={(shop) => navigate(`/admin/shop/${shop}`)}
        onSearch={(next) => {
          void router.navigate({ to: "/admin/shops", search: { filter: next ?? undefined } });
        }}
        onNextPage={(after) => {
          void router.navigate({ to: "/admin/shops", search: { after, filter } });
        }}
        onPreviousPage={(before) => {
          void router.navigate({ to: "/admin/shops", search: { before, filter } });
        }}
      />
    );
  },
});

import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { TeamName } from "../../domain/shop-work.ts";
import { useNavigateOnClick } from "../components/navigate.ts";
import TeamsIndexPage from "../components/TeamsIndexPage.tsx";
import { teamsPage } from "../server/teams.ts";
import { appHref, appSearch } from "./-app-search.ts";
import { lenientSearchKey, ListSearchParam } from "./-search-params.ts";
import { useNextPageEntry } from "./-table-pages.ts";

const PATH = "/app/teams";

/**
 * The teams index's URL: the search and the page. `q` is matched anywhere in the name, ignoring
 * case, over every team; `after` is the last name of the page before (`Members.listTeamsPage`).
 * Both are lenient for the reason on `OrdersSearch`.
 */
const TeamsSearch = Schema.Struct({
  q: lenientSearchKey(ListSearchParam),
  after: lenientSearchKey(TeamName),
});

/**
 * The teams index under the App Home, as the members index (`/app/members/`): the loader reads
 * the page from D1 through the Backend (`teamsPage`), and every link and navigation keeps the raw
 * search Shopify sent ({@link appHref}).
 */
export const Route = createFileRoute("/app/teams/")({
  validateSearch: Schema.toStandardSchemaV1(TeamsSearch),
  loaderDeps: ({ search }) => ({ q: search.q ?? null, after: search.after ?? null }),
  loader: ({ location, deps }) =>
    teamsPage({
      data: { idToken: appSearch(location.searchStr).id_token, q: deps.q, after: deps.after },
    }),
  component: function TeamsRoute() {
    const { q, after } = Route.useLoaderDeps();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const nextPageEntry = useNextPageEntry();
    return (
      <TeamsIndexPage
        page={Route.useLoaderData()}
        q={q}
        after={after}
        teamLink={(id) => navigate(appHref(`${PATH}/${id}`, searchStr))}
        onSearch={(next) => {
          void router.navigate({ href: appHref(PATH, searchStr, { q: next }), replace: true });
        }}
        onNextPage={(cursor) => {
          void router.navigate({
            href: appHref(PATH, searchStr, { q, after: cursor }),
            state: { nextPage: true },
          });
        }}
        onPreviousPage={() => {
          if (nextPageEntry) router.history.back();
          else void router.navigate({ href: appHref(PATH, searchStr, { q }), replace: true });
        }}
        onCreated={async (team) => {
          await router.invalidate({ sync: true });
          await router.navigate({ href: appHref(`${PATH}/${team.id}`, searchStr) });
        }}
      />
    );
  },
});

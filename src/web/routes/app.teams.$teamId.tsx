import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Email } from "../../domain/platform.ts";
import { TeamId } from "../../domain/shop-work.ts";
import { useNavigateOnClick } from "../components/navigate.ts";
import TeamPage from "../components/TeamPage.tsx";
import { teamDetail } from "../server/teams.ts";
import { appHref, appSearch } from "./-app-search.ts";
import { lenientSearchKey } from "./-search-params.ts";
import { useNextPageEntry } from "./-table-pages.ts";

const decodeTeamId = Schema.decodeSync(TeamId);

/**
 * The team page's URL: `membersAfter` is the last email of the Members table's page before
 * (`Members.findTeamDetail`), lenient for the reason on `OrdersSearch`.
 */
const TeamSearch = Schema.Struct({ membersAfter: lenientSearchKey(Email) });

/**
 * One team's page under the App Home: the loader reads the team from D1 through the Backend
 * (`teamDetail`, `null` for a stale id). Every link and navigation keeps the raw search Shopify
 * sent ({@link appHref}) but the breadcrumb, a bare path (`TeamPage`'s `teamsLink`).
 */
export const Route = createFileRoute("/app/teams/$teamId")({
  validateSearch: Schema.toStandardSchemaV1(TeamSearch),
  loaderDeps: ({ search }) => ({ membersAfter: search.membersAfter ?? null }),
  loader: ({ location, params, deps }) =>
    teamDetail({
      data: {
        idToken: appSearch(location.searchStr).id_token,
        teamId: decodeTeamId(params.teamId),
        membersAfter: deps.membersAfter,
      },
    }),
  component: function TeamRoute() {
    const { membersAfter } = Route.useLoaderDeps();
    const { teamId } = Route.useParams();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const nextPageEntry = useNextPageEntry();
    const path = `/app/teams/${teamId}`;
    return (
      <TeamPage
        detail={Route.useLoaderData()}
        membersAfter={membersAfter}
        teamsLink={navigate("/app/teams")}
        membersLink={navigate(appHref("/app/members", searchStr))}
        memberLink={(id) => navigate(appHref(`/app/members/${id}`, searchStr))}
        onNextPage={(cursor) => {
          void router.navigate({
            href: appHref(path, searchStr, { membersAfter: cursor }),
            state: { nextPage: true },
          });
        }}
        onPreviousPage={() => {
          if (nextPageEntry) router.history.back();
          else void router.navigate({ href: appHref(path, searchStr), replace: true });
        }}
        onChanged={() => router.invalidate({ sync: true })}
        onDeleted={async () => {
          await router.navigate({ href: appHref("/app/teams", searchStr) });
        }}
      />
    );
  },
});

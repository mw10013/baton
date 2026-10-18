import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { MemberId, TeamName } from "../../domain/shop-work.ts";
import MemberPage from "../components/MemberPage.tsx";
import { useNavigateOnClick } from "../components/navigate.ts";
import { memberDetail } from "../server/members.ts";
import { appHref, appSearch } from "./-app-search.ts";
import { lenientSearchKey } from "./-search-params.ts";
import { useNextPageEntry } from "./-table-pages.ts";

const decodeMemberId = Schema.decodeSync(MemberId);

/**
 * The member page's URL: `teamsAfter` is the last team name of the Teams table's page before
 * (`Members.findMemberDetail`), lenient for the reason on `OrdersSearch`.
 */
const MemberSearch = Schema.Struct({ teamsAfter: lenientSearchKey(TeamName) });

/**
 * One member's page under the App Home: the loader reads the member from D1 through the Backend
 * (`memberDetail`, `null` for a stale id). Every link and navigation keeps the raw search
 * Shopify sent ({@link appHref}); paging is the members index's.
 */
export const Route = createFileRoute("/app/members/$memberId")({
  validateSearch: Schema.toStandardSchemaV1(MemberSearch),
  loaderDeps: ({ search }) => ({ teamsAfter: search.teamsAfter ?? null }),
  loader: ({ location, params, deps }) =>
    memberDetail({
      data: {
        idToken: appSearch(location.searchStr).id_token,
        memberId: decodeMemberId(params.memberId),
        teamsAfter: deps.teamsAfter,
      },
    }),
  component: function MemberRoute() {
    const { teamsAfter } = Route.useLoaderDeps();
    const { memberId } = Route.useParams();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const nextPageEntry = useNextPageEntry();
    const path = `/app/members/${memberId}`;
    return (
      <MemberPage
        detail={Route.useLoaderData()}
        teamsAfter={teamsAfter}
        membersLink={navigate("/app/members")}
        teamsLink={navigate(appHref("/app/teams", searchStr))}
        teamLink={(id) => navigate(appHref(`/app/teams/${id}`, searchStr))}
        onNextPage={(cursor) => {
          void router.navigate({
            href: appHref(path, searchStr, { teamsAfter: cursor }),
            state: { nextPage: true },
          });
        }}
        onPreviousPage={() => {
          if (nextPageEntry) router.history.back();
          else void router.navigate({ href: appHref(path, searchStr), replace: true });
        }}
        onChanged={() => router.invalidate({ sync: true })}
        onDeleted={async () => {
          await router.navigate({ href: appHref("/app/members", searchStr) });
        }}
      />
    );
  },
});

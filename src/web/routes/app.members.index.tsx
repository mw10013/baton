import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Email } from "../../domain/platform.ts";
import MembersIndexPage from "../components/MembersIndexPage.tsx";
import { useNavigateOnClick } from "../components/navigate.ts";
import { membersPage } from "../server/members.ts";
import { appHref, appSearch } from "./-app-search.ts";
import { lenientSearchKey, ListSearchParam } from "./-search-params.ts";
import { useNextPageEntry } from "./-table-pages.ts";

const PATH = "/app/members";

/**
 * The members index's URL: the search and the page. `q` is matched anywhere in the email, over
 * every member, not only the rows on screen; `after` is the last email of the page before
 * (`MembershipRepository.listMembersPage`). Both are lenient for the reason on `OrdersSearch`: a stale or
 * hand-edited value reads as no search, or page one.
 */
const MembersSearch = Schema.Struct({
  q: lenientSearchKey(ListSearchParam),
  after: lenientSearchKey(Email),
});

/**
 * The members index under the App Home, whose guards have already run. The loader reads the page
 * from D1 through the Backend (`membersPage`); during SSR its session token is the document's
 * `id_token`, in the browser App Bridge's bearer. Every link and navigation keeps the raw search
 * Shopify sent ({@link appHref}). A search replaces the entry (it is the screen's state, not a
 * trail); Next pushes one marked `nextPage`, so Previous is the browser's Back after a Next and
 * page one otherwise.
 */
export const Route = createFileRoute("/app/members/")({
  validateSearch: Schema.toStandardSchemaV1(MembersSearch),
  loaderDeps: ({ search }) => ({ q: search.q ?? null, after: search.after ?? null }),
  loader: ({ location, deps }) =>
    membersPage({
      data: { idToken: appSearch(location.searchStr).id_token, q: deps.q, after: deps.after },
    }),
  component: function MembersRoute() {
    const { q, after } = Route.useLoaderDeps();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const nextPageEntry = useNextPageEntry();
    return (
      <MembersIndexPage
        page={Route.useLoaderData()}
        q={q}
        after={after}
        memberLink={(id) => navigate(appHref(`${PATH}/${id}`, searchStr))}
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
        onAdded={async (member) => {
          await router.invalidate({ sync: true });
          await router.navigate({ href: appHref(`${PATH}/${member.id}`, searchStr) });
        }}
      />
    );
  },
});

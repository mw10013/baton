import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import { useNavigateOnClick } from "../components/navigate.ts";
import WorkflowsIndexPage from "../components/WorkflowsIndexPage.tsx";
import { workflowsPage } from "../server/workflows.ts";
import { appHref, appSearch } from "./-app-search.ts";
import { useNextPageEntry } from "./-table-pages.ts";

const PATH = "/app/workflows";

/**
 * The workflows index under the App Home: the loader reads the page in the actor through the
 * Backend (`workflowsPage`), and every link and navigation keeps the raw search Shopify sent
 * ({@link appHref}). The links to a workflow carry the index's filter, search and page, so the
 * workflow page's breadcrumb lands back here as it was.
 */
export const Route = createFileRoute("/app/workflows/")({
  loaderDeps: ({ search }) => ({
    state: search.state ?? null,
    q: search.q ?? null,
    after: search.after ?? null,
  }),
  loader: ({ location, deps }) =>
    workflowsPage({
      data: { idToken: appSearch(location.searchStr).id_token, ...deps },
    }),
  component: function WorkflowsRoute() {
    const { state, q, after } = Route.useLoaderDeps();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const nextPageEntry = useNextPageEntry();
    return (
      <WorkflowsIndexPage
        data={Route.useLoaderData()}
        state={state}
        q={q}
        after={after}
        workflowLink={(id) => navigate(appHref(`${PATH}/${id}`, searchStr, { state, q, after }))}
        onFilter={(patch) => {
          // The filters are a screen's state, not a trail, so the URL is replaced.
          void router.navigate({
            href: appHref(PATH, searchStr, {
              state: patch.state === undefined ? state : patch.state,
              q: patch.q === undefined ? q : patch.q,
            }),
            replace: true,
          });
        }}
        onNextPage={(cursor) => {
          void router.navigate({
            href: appHref(PATH, searchStr, { state, q, after: cursor }),
            state: { nextPage: true },
          });
        }}
        onPreviousPage={() => {
          if (nextPageEntry) router.history.back();
          else
            void router.navigate({ href: appHref(PATH, searchStr, { state, q }), replace: true });
        }}
        onCreated={async (workflow) => {
          await router.invalidate({ sync: true });
          await router.navigate({ href: appHref(`${PATH}/${workflow.id}/edit`, searchStr) });
        }}
      />
    );
  },
});

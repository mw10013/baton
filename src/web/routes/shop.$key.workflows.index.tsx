import { createFileRoute, useRouter } from "@tanstack/react-router";
import { DEFAULT_WORKFLOWS_LIST_STATE, RUN_PAGE } from "../../domain/shop-work.ts";
import { liveLoadAnswer } from "../client/live-load.ts";
import { memberRunsQuery } from "../client/shop-actor-client.ts";
import WorkflowsListPage from "../components/WorkflowsListPage.tsx";
import { workflowsList } from "../server/workflows-list.ts";

/**
 * The member's workflows list. The loader reads the query the URL names (`MemberSearch`, with the
 * defaults applied here), a live read ({@link liveLoadAnswer}), so a return from the workflow page server-renders narrowed and deepened
 * rather than painting page one and correcting itself. Every control is a navigation that
 * replaces the entry: filters are a screen's state, not a trail, so Back leaves the list rather
 * than walking back through every state, team and search glanced at. A state, a team or a search
 * is a different list, so the depth resets with each.
 *
 * A row's link carries no search: the layout's middleware puts the member's state, team and
 * search on it and leaves the depth. The entry it pushes is marked `fromWorkflowsList`, which lets
 * the workflow page's Workflows link step back to this entry, depth and scroll included.
 */
export const Route = createFileRoute("/shop/$key/workflows/")({
  loaderDeps: ({ search }) => ({
    state: search.state ?? DEFAULT_WORKFLOWS_LIST_STATE,
    team: search.team ?? null,
    limit: search.limit ?? RUN_PAGE,
    q: search.q ?? null,
  }),
  loader: ({ params, deps, context: { registry } }) =>
    liveLoadAnswer({
      registry,
      request: `workflows-list:${params.key}:${JSON.stringify([deps.state, deps.team, deps.limit, deps.q])}`,
      fetch: () => workflowsList({ data: { key: params.key, ...deps } }),
      live: (answer) => ({ query: memberRunsQuery(answer.query), value: answer.list }),
      withValue: (answer, list) => ({ ...answer, list }),
    }),
  head: () => ({ meta: [{ title: "Workflows — Baton" }] }),
  component: function WorkflowsListRoute() {
    const { key } = Route.useParams();
    const router = useRouter();
    const location = (runId: string) =>
      ({
        to: "/shop/$key/workflows/$runId",
        params: { key, runId },
        state: { fromWorkflowsList: true },
      }) as const;
    return (
      <WorkflowsListPage
        data={Route.useLoaderData()}
        onSearch={(patch) => {
          void router.navigate({
            from: Route.fullPath,
            to: ".",
            search: (prev) => ({
              ...prev,
              ...(patch.state === undefined ? {} : { state: patch.state }),
              ...(patch.team === undefined ? {} : { team: patch.team ?? undefined }),
              ...(patch.q === undefined ? {} : { q: patch.q ?? undefined }),
              limit: patch.limit,
            }),
            replace: true,
          });
        }}
        workflowLink={(runId) => ({
          href: router.buildLocation(location(runId)).href,
          onNavigate: () => {
            void router.navigate(location(runId));
          },
        })}
      />
    );
  },
});

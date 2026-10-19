import { createFileRoute, useRouter } from "@tanstack/react-router";
import { liveLoadAnswer } from "../client/live-load.ts";
import { memberRunQuery } from "../client/shop-actor-client.ts";
import MemberWorkflowPage from "../components/MemberWorkflowPage.tsx";
import { BackLink } from "../components/screen/BackLink.tsx";
import { memberWorkflowPage } from "../server/workflows-list.ts";
import { useFromWorkflowsList } from "./-table-pages.ts";

/**
 * The member's workflow page, a live read ({@link liveLoadAnswer}). The loader's `page` is null for a run that is not there or holds no
 * task of the member's teams, one answer for both, and the page renders "Workflow not found".
 *
 * The Workflows link above it returns to the list as the member left it: when a row of the list
 * opened this page, the entry before is the list at its depth (`fromWorkflowsList`), so the link
 * is a history step back and the router restores the scroll. Anywhere else (a shared link, a new
 * tab) it opens the list at the first page, with the state, team and search the layout carries;
 * the `href` is that second target, so open-in-new-tab gets it too.
 */
export const Route = createFileRoute("/shop/$key/workflows/$runId")({
  loader: ({ params, context: { registry } }) =>
    liveLoadAnswer({
      registry,
      request: `member-run:${params.key}:${params.runId}`,
      fetch: () => memberWorkflowPage({ data: { key: params.key, runId: params.runId } }),
      live: (answer) => ({ query: memberRunQuery(params.runId), value: answer.page }),
      withValue: (answer, page) => ({ ...answer, page }),
    }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${
          loaderData?.page === null || loaderData === undefined
            ? "Workflow not found"
            : `${loaderData.page.run.orderName} · ${loaderData.page.run.lineItemTitle}`
        } — Baton`,
      },
    ],
  }),
  component: function MemberWorkflowRoute() {
    const { key, runId } = Route.useParams();
    const router = useRouter();
    const fromWorkflowsList = useFromWorkflowsList();
    const list = { to: "/shop/$key/workflows", params: { key } } as const;
    return (
      <>
        <BackLink
          label="Workflows"
          href={router.buildLocation(list).href}
          onNavigate={() => {
            if (fromWorkflowsList) router.history.back();
            else void router.navigate(list);
          }}
        />
        <MemberWorkflowPage key={runId} runId={runId} data={Route.useLoaderData()} />
      </>
    );
  },
});

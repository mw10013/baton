import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import { useNavigateOnClick } from "../components/navigate.ts";
import WorkflowPage from "../components/WorkflowPage.tsx";
import { workflowDetail } from "../server/workflows.ts";
import { appHref, appSearch } from "./-app-search.ts";

/**
 * One workflow's page under the App Home: the loader reads it in the actor through the Backend
 * (`workflowDetail`, `null` for a stale id). The breadcrumb carries the index's filter, search
 * and page the link here came with, so it lands on the list as it was.
 */
export const Route = createFileRoute("/app/workflows/$workflowId")({
  loader: ({ location, params }) =>
    workflowDetail({
      data: { idToken: appSearch(location.searchStr).id_token, workflowId: params.workflowId },
    }),
  component: function WorkflowRoute() {
    const { state, q, after } = Route.useSearch();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const index = appHref("/app/workflows", searchStr, { state, q, after });
    return (
      <WorkflowPage
        detail={Route.useLoaderData()}
        workflowsLink={navigate(index)}
        onEditorDeleted={async () => {
          await router.navigate({ href: index });
        }}
        onChanged={() => router.invalidate({ sync: true })}
        onDuplicated={async (workflow) => {
          await router.navigate({ href: appHref(`/app/workflows/${workflow.id}/edit`, searchStr) });
        }}
        onDeleted={async () => {
          await router.navigate({ href: index });
        }}
      />
    );
  },
});

import { RegistryContext } from "@effect/atom-react";
import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import { useContext } from "react";
import { liveLoad } from "../client/live-load.ts";
import {
  merchantWorkflowDetailAtom,
  merchantWorkflowDetailQuery,
  rereadLive,
} from "../client/shop-actor-client.ts";
import { useLiveRead } from "../components/live-read.ts";
import { useNavigateOnClick } from "../components/navigate.ts";
import WorkflowPage from "../components/WorkflowPage.tsx";
import { workflowDetail } from "../server/workflows.ts";
import { appHref, appSearch } from "./-app-search.ts";

/**
 * One workflow's page under the App Home: the loader reads it in the actor through the Backend
 * (`workflowDetail`, `null` for a stale id), a live read ({@link liveLoad}) shared with the
 * editor's, so the Draft badge and the steps follow another tab's edits. A write of this page
 * re-reads it at once ({@link rereadLive}). The breadcrumb carries the index's filter, search
 * and page the link here came with, so it lands on the list as it was.
 */
export const Route = createFileRoute("/app/workflows/$workflowId")({
  loader: ({ location, params, context: { registry } }) =>
    liveLoad({
      registry,
      query: merchantWorkflowDetailQuery(params.workflowId),
      fetch: () =>
        workflowDetail({
          data: { idToken: appSearch(location.searchStr).id_token, workflowId: params.workflowId },
        }),
    }),
  component: function WorkflowRoute() {
    const { workflowId } = Route.useParams();
    const registry = useContext(RegistryContext);
    const read = useLiveRead({
      atom: merchantWorkflowDetailAtom(workflowId),
      query: merchantWorkflowDetailQuery(workflowId),
      loaded: Route.useLoaderData(),
    });
    const { state, q, after } = Route.useSearch();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const index = appHref("/app/workflows", searchStr, { state, q, after });
    return (
      <WorkflowPage
        detail={read.value}
        workflowsLink={navigate(index)}
        onEditorDeleted={async () => {
          await router.navigate({ href: index });
        }}
        onChanged={() => rereadLive(registry, merchantWorkflowDetailQuery(workflowId))}
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

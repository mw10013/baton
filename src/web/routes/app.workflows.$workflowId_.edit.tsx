import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useNavigateOnClick } from "../components/navigate.ts";
import WorkflowEditorPage from "../components/WorkflowEditorPage.tsx";
import { workflowDetail } from "../server/workflows.ts";
import { appHref, appSearch } from "./-app-search.ts";
import { lenientSearchKey } from "./-search-params.ts";

/**
 * The editor's own search: `chrome=window` when the admin opened it inside an `s-app-window`. A
 * word rather than `1`, because the router's search parser JSON-decodes values and would hand a
 * number back; anything else reads as the page form.
 */
const EditorSearch = Schema.Struct({ chrome: lenientSearchKey(Schema.Literal("window")) });

/**
 * The workflow editor under the App Home: the loader is the workflow page's read
 * (`workflowDetail`). Apply lands on the workflow page and Delete on the index.
 */
export const Route = createFileRoute("/app/workflows/$workflowId_/edit")({
  validateSearch: Schema.toStandardSchemaV1(EditorSearch),
  loader: ({ location, params }) =>
    workflowDetail({
      data: { idToken: appSearch(location.searchStr).id_token, workflowId: params.workflowId },
    }),
  component: function WorkflowEditorRoute() {
    const { workflowId } = Route.useParams();
    const { chrome } = Route.useSearch();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const workflowPage = appHref(`/app/workflows/${workflowId}`, searchStr);
    return (
      <WorkflowEditorPage
        detail={Route.useLoaderData()}
        inWindow={chrome === "window"}
        closeLink={navigate(workflowPage)}
        teamsLink={navigate(appHref("/app/teams", searchStr))}
        onChanged={() => router.invalidate({ sync: true })}
        onApplied={async () => {
          await router.navigate({ href: workflowPage });
        }}
        onDeleted={async () => {
          await router.navigate({ href: appHref("/app/workflows", searchStr) });
        }}
      />
    );
  },
});

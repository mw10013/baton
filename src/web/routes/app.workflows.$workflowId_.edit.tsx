import { RegistryContext } from "@effect/atom-react";
import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useContext } from "react";
import { liveLoad } from "../client/live-load.ts";
import {
  merchantWorkflowDetailAtom,
  merchantWorkflowDetailQuery,
  rereadLive,
} from "../client/shop-actor-client.ts";
import { useLiveRead } from "../components/live-read.ts";
import { useNavigateOnClick } from "../components/navigate.ts";
import WorkflowEditorPage from "../components/WorkflowEditorPage.tsx";
import { postEditorWindowMessage } from "../components/workflow-editor-window.ts";
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
 * (`workflowDetail`), a live read ({@link liveLoad}), so another tab's draft, Discard or Apply
 * shows here without a press. A write of this tab re-reads it at once ({@link rereadLive}). As a
 * page, Apply lands on the workflow page and Delete on the index; in the window
 * (`chrome=window`, `useWorkflowEditorWindow`) both are announced to the opener.
 */
export const Route = createFileRoute("/app/workflows/$workflowId_/edit")({
  validateSearch: Schema.toStandardSchemaV1(EditorSearch),
  loader: ({ location, params, context: { registry } }) =>
    liveLoad({
      registry,
      query: merchantWorkflowDetailQuery(params.workflowId),
      fetch: () =>
        workflowDetail({
          data: { idToken: appSearch(location.searchStr).id_token, workflowId: params.workflowId },
        }),
    }),
  component: function WorkflowEditorRoute() {
    const { workflowId } = Route.useParams();
    const registry = useContext(RegistryContext);
    const read = useLiveRead({
      atom: merchantWorkflowDetailAtom(workflowId),
      query: merchantWorkflowDetailQuery(workflowId),
      loaded: Route.useLoaderData(),
    });
    const { chrome } = Route.useSearch();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const router = useRouter();
    const navigate = useNavigateOnClick();
    const workflowPage = appHref(`/app/workflows/${workflowId}`, searchStr);
    return (
      <WorkflowEditorPage
        detail={read.value}
        inWindow={chrome === "window"}
        closeLink={navigate(workflowPage)}
        teamsLink={navigate(appHref("/app/teams", searchStr))}
        onChanged={() => rereadLive(registry, merchantWorkflowDetailQuery(workflowId))}
        onApplied={async () => {
          // A window cannot navigate its opener, and a navigation here would only move the
          // window's own frame: the opener hides it and re-reads.
          if (chrome === "window") postEditorWindowMessage({ type: "applied", workflowId });
          else await router.navigate({ href: workflowPage });
        }}
        onDeleted={async () => {
          if (chrome === "window") postEditorWindowMessage({ type: "deleted", workflowId });
          else await router.navigate({ href: appHref("/app/workflows", searchStr) });
        }}
      />
    );
  },
});

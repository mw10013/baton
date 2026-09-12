import * as React from "react";

import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { AttentionBanner, StageFlow } from "@/components/WorkflowStages";
import {
  activateResultMessage,
  AppliesSince,
  WorkflowSwitch,
} from "@/components/WorkflowSwitch";
import * as Domain from "@/lib/Domain";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useWorkflowEditorWindow } from "@/lib/workflowEditorWindow";
import { ORDER_WORKFLOW_TRIGGER, turnOnBlocker } from "@/lib/workflowShared";

/** `tab=draft` is the Draft tab; anything else is the live workflow, as on the item page. */
const validateSearch = ({
  tab,
}: Record<string, unknown>): { readonly tab?: "draft" } =>
  tab === "draft" ? { tab } : {};

/** No `$workflowId` in the URL: there is nothing to choose, so the loader reads the singleton by its fixed id. */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      ShopAgentClient.pipe(
        Effect.flatMap((client) =>
          client.getWorkflowDetail(session.shop, {
            workflowId: Domain.ORDER_WORKFLOW_ID,
          }),
        ),
      ),
    ),
  );

export const Route = createFileRoute("/app/order-workflow/")({
  validateSearch,
  loader: () => getLoaderData(),
  component: RouteComponent,
});

/**
 * The order workflow's page: a copy of the item detail page with what does
 * not apply removed. No breadcrumb (it is a top-level nav entry), no More
 * actions (nothing is left in it: the singleton is never renamed, deleted,
 * or duplicated), and the trigger box is the shop-wide rule rather than the
 * workflow's tag. Steps, drafts, teams, the switch, and the "applies since"
 * line are the same as an item workflow's. Copied rather than shared as one
 * component because the two pages are about different things and the
 * branches would outweigh the duplication.
 */
function RouteComponent() {
  const { tab } = Route.useSearch();
  const detail: Domain.WorkflowLoaderData = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const { identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);

  const invalidate = () => router.invalidate({ sync: true });
  /** The editor opens in an `s-app-window` over this page, Flow's chrome; see `workflowEditorWindow.ts`. */
  const editor = useWorkflowEditorWindow({
    workflowId: Domain.ORDER_WORKFLOW_ID,
    editorPath: () => "/app/order-workflow/edit",
    onHide: () => void invalidate(),
    // The singleton cannot be deleted; a refetch is the safe no-op.
    onDeleted: () => void invalidate(),
  });

  if (detail === null)
    return (
      <s-page heading={Domain.ORDER_WORKFLOW_NAME}>
        <s-paragraph color="subdued">
          The order workflow is not available. Reload the page.
        </s-paragraph>
      </s-page>
    );

  const { workflow, draft, steps } = detail;

  const showingDraft = tab === "draft" && draft !== null;
  const shownSteps = showingDraft ? draft.steps : steps;
  const blocker = turnOnBlocker(steps);

  const tabButton = (label: string, draftTab: boolean) => (
    <s-button
      variant={showingDraft === draftTab ? "primary" : "tertiary"}
      onClick={() => {
        void navigate({ search: draftTab ? { tab: "draft" } : {} });
      }}
    >
      {label}
    </s-button>
  );

  return (
    <s-page heading={Domain.ORDER_WORKFLOW_NAME} inlineSize="base">
      {Domain.isActive(workflow) ? (
        <s-badge slot="accessory" tone="success">
          Active
        </s-badge>
      ) : (
        <s-badge slot="accessory">Off</s-badge>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        icon="edit"
        commandFor={editor.windowProps.id}
        command="--show"
      >
        Edit
      </s-button>
      <s-app-window {...editor.windowProps} />
      <WorkflowSwitch
        workflow={workflow}
        steps={steps}
        turnOnBody={ORDER_WORKFLOW_TRIGGER}
        onChanged={invalidate}
        onMessage={setBanner}
      />

      <SocketBanner />

      <s-section accessibilityLabel="Workflow">
        <s-stack gap="base">
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {!Domain.isActive(workflow) && blocker !== null && (
            <s-banner tone="info" heading="Turn on is unavailable">
              {activateResultMessage(blocker)}
            </s-banner>
          )}
          {draft !== null && (
            <s-stack direction="inline" gap="small-300" alignItems="center">
              {tabButton("Live workflow", false)}
              {tabButton("Draft", true)}
            </s-stack>
          )}

          <s-paragraph color="subdued">
            Last updated on <LocalDateTime value={workflow.updatedAt} />
          </s-paragraph>
          {workflow.activatedAt !== null && (
            <AppliesSince
              activatedAt={workflow.activatedAt}
              disabled={!identified}
            />
          )}

          {showingDraft && (
            <s-banner tone="info" heading="Not running yet">
              These changes take effect when you apply them in the editor.
            </s-banner>
          )}

          <AttentionBanner steps={shownSteps} />

          <StageFlow
            steps={shownSteps}
            trigger={
              <s-box
                padding="base"
                border="base subdued dashed"
                borderRadius="base"
              >
                <s-stack gap="small-500">
                  <s-text type="strong">When it runs</s-text>
                  <s-text color="subdued">{ORDER_WORKFLOW_TRIGGER}</s-text>
                </s-stack>
              </s-box>
            }
            {...(shownSteps.length === 0
              ? {
                  footer: (
                    <s-paragraph color="subdued">
                      No steps yet. Edit to add some.
                    </s-paragraph>
                  ),
                }
              : {})}
          />
        </s-stack>
      </s-section>
    </s-page>
  );
}

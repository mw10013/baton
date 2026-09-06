import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { AttentionBanner, StageFlow } from "@/components/WorkflowStages";
import * as Domain from "@/lib/Domain";
import { formatDateTime } from "@/lib/format";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import {
  DELETE_WORKFLOW_WARNING,
  deleteWorkflowResultMessage,
  itemTriggerLine,
  turnOnBlocker,
  workflowResultMessage,
} from "@/lib/workflowShared";

const WorkflowParams = Schema.Struct({ workflowId: Schema.String });

/**
 * `tab=draft` is the Draft tab; anything else, including a value the page
 * does not know or a draft that no longer exists, is the live workflow.
 * Hand-written so an unknown value falls back instead of failing the route.
 */
const validateSearch = ({
  tab,
}: Record<string, unknown>): { readonly tab?: "draft" } =>
  tab === "draft" ? { tab } : {};

const RENAME_MODAL = "rename-workflow";
const DELETE_MODAL = "delete-workflow";
const TURN_ON_MODAL = "turn-on-workflow";

const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);
const decodeActivateResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.ActivateResult),
);
const decodeDeleteWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DeleteWorkflowResult),
);

const activateResultMessage = Match.typeTags<
  Domain.ActivateResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoSteps: () => "This workflow has no steps. Edit to add some, then apply.",
  StepUnassigned: ({ stepNames }) =>
    `These steps have no team: ${stepNames.join(", ")}.`,
});

/** Loader read for the same reason as the index's: a definition is configuration one person edits. */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(WorkflowParams))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      ShopAgentClient.pipe(
        Effect.flatMap((client) =>
          client.getWorkflowDetail(session.shop, data),
        ),
      ),
    ),
  );

export const Route = createFileRoute("/app/workflows/$workflowId")({
  validateSearch,
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});

/**
 * Item-workflow detail: what this workflow is, read-only. Every edit happens
 * on `/app/workflows/$workflowId/edit`, so this page has no step controls and
 * no form fields — the two tabs show the live workflow and, while one exists,
 * the draft, so a merchant can see what runs today next to what is being
 * written. There is no version history and no run history here on purpose: a
 * run copies its steps when it starts and is independent from then on, so the
 * workflow has exactly two states worth showing.
 *
 * Order scope lives under `/app/order-workflow` with its own page; an order
 * workflow opened here renders a pointer rather than the wrong editor.
 */
function RouteComponent() {
  const { workflowId } = Route.useParams();
  const { tab } = Route.useSearch();
  const detail: Domain.WorkflowLoaderData = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
  const [name, setName] = React.useState(detail?.workflow.name ?? "");
  const [nameError, setNameError] = React.useState<string | null>(null);

  const invalidate = () => router.invalidate({ sync: true });

  const call = <A,>(
    op: (stub: NonNullable<typeof agent>["stub"]) => Promise<A>,
  ) =>
    agent
      ? withSocketRecovery(agent)(() => op(agent.stub))
      : Promise.reject(new Error("Still connecting. Try again in a moment."));

  const onError = (error: Error) => {
    setBanner(error.message);
  };

  const renameMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.updateWorkflow({ workflowId, name })).then(
        decodeWorkflowResult,
      ),
    onSuccess: async (result) => {
      const message = workflowResultMessage(result);
      if (message !== null) {
        setNameError(message);
        return;
      }
      await shopify.modal.hide(RENAME_MODAL);
      await invalidate();
    },
    onError,
  });

  const duplicateMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.duplicateWorkflow({ workflowId })).then(
        decodeWorkflowResult,
      ),
    onSuccess: async (result) => {
      if (result._tag !== "Ok") {
        setBanner(workflowResultMessage(result));
        return;
      }
      shopify.toast.show(`Copied to “${result.workflow.name}”.`);
      await navigate({
        to: "/app/workflows/$workflowId/edit",
        params: { workflowId: result.workflow.id },
      });
    },
    onError,
  });

  const activeMutation = useMutation({
    mutationFn: (active: boolean) =>
      call((stub) => stub.setWorkflowActive({ workflowId, active })).then(
        decodeActivateResult,
      ),
    onSuccess: async (result) => {
      setBanner(activateResultMessage(result));
      if (result._tag === "Ok") {
        await shopify.modal.hide(TURN_ON_MODAL);
        shopify.toast.show(
          result.workflow.active
            ? "Turned on."
            : "Turned off. Open runs finish.",
        );
      }
      await invalidate();
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.removeWorkflow({ workflowId })).then(
        decodeDeleteWorkflowResult,
      ),
    onSuccess: async (result) => {
      if (result._tag === "Deleted") {
        await shopify.modal.hide(DELETE_MODAL);
        await navigate({ to: "/app/workflows" });
        return;
      }
      setBanner(deleteWorkflowResultMessage(result));
    },
    onError,
  });

  const loadedName = detail?.workflow.name;
  React.useEffect(() => {
    if (loadedName !== undefined) setName(loadedName);
  }, [loadedName]);

  if (detail === null)
    return (
      <s-page heading="Workflow not found">
        <s-link slot="breadcrumb-actions" href="/app/workflows">
          Workflows
        </s-link>
        <s-paragraph color="subdued">
          That workflow no longer exists.
        </s-paragraph>
      </s-page>
    );

  const { workflow, draft, steps } = detail;

  if (workflow.scope === "order")
    return (
      <s-page heading={workflow.name}>
        <s-link slot="breadcrumb-actions" href="/app/workflows">
          Workflows
        </s-link>
        <s-paragraph color="subdued">
          This is an order workflow. It lives under Order workflow now.
        </s-paragraph>
        <s-link href={`/app/order-workflow/${workflowId}`}>
          Open in Order workflow
        </s-link>
      </s-page>
    );

  const showingDraft = tab === "draft" && draft !== null;
  const shownSteps = showingDraft ? draft.steps : steps;
  const shownTags = showingDraft ? draft.draft.tags : workflow.tags;
  const blocker = turnOnBlocker(steps);
  const switching = activeMutation.isPending;

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
    <s-page heading={workflow.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/workflows">
        Workflows
      </s-link>
      {workflow.active ? (
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
        href={`/app/workflows/${workflowId}/edit`}
      >
        Edit
      </s-button>
      {workflow.active ? (
        <s-button
          slot="secondary-actions"
          loading={switching}
          disabled={!identified || switching}
          onClick={() => {
            activeMutation.mutate(false);
          }}
        >
          Turn off
        </s-button>
      ) : (
        <s-button
          slot="secondary-actions"
          disabled={!identified || switching || blocker !== null}
          commandFor={TURN_ON_MODAL}
          command="--show"
        >
          Turn on
        </s-button>
      )}
      <s-button slot="secondary-actions" commandFor="workflow-actions">
        More actions
      </s-button>
      <s-menu id="workflow-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_MODAL} command="--show">
          Rename
        </s-button>
        <s-button
          icon="duplicate"
          loading={duplicateMutation.isPending}
          disabled={!identified || duplicateMutation.isPending}
          onClick={() => {
            duplicateMutation.mutate();
          }}
        >
          Duplicate
        </s-button>
        <s-button
          icon="delete"
          tone="critical"
          commandFor={DELETE_MODAL}
          command="--show"
        >
          Delete
        </s-button>
      </s-menu>

      <SocketBanner />

      <s-section accessibilityLabel="Workflow">
        <s-stack gap="base">
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {!workflow.active && blocker !== null && (
            <s-banner tone="info" heading="Turn on is unavailable">
              {activateResultMessage(blocker)}
            </s-banner>
          )}
          {/* One tab is not a choice: with no draft there is only the
              workflow, so the row would be a lone selected pill. */}
          {draft !== null && (
            <s-stack direction="inline" gap="small-300" alignItems="center">
              {tabButton("Live workflow", false)}
              {tabButton("Draft", true)}
            </s-stack>
          )}

          <s-paragraph color="subdued">
            {`Last updated on ${formatDateTime(workflow.updatedAt)}`}
          </s-paragraph>

          {showingDraft && (
            <s-banner tone="info" heading="Not running yet">
              These changes take effect when you apply them in the editor.
            </s-banner>
          )}

          {/* Under the tabs, because which side it is about is the tab. */}
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
                  <s-text type="strong">Product tag</s-text>
                  <s-text color="subdued">{itemTriggerLine(shownTags)}</s-text>
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

      <s-modal id={RENAME_MODAL} heading="Rename workflow">
        <s-text-field
          label="Name"
          value={name}
          maxLength={64}
          {...(nameError === null ? {} : { error: nameError })}
          onInput={(event) => {
            setName(event.currentTarget.value);
            setNameError(null);
          }}
        />
        <s-button
          slot="secondary-actions"
          commandFor={RENAME_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={renameMutation.isPending}
          disabled={!identified || name.trim().length === 0}
          onClick={() => {
            renameMutation.mutate();
          }}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal id={TURN_ON_MODAL} heading={`Turn on ${workflow.name}?`}>
        <s-paragraph>
          {workflow.tags.length === 0
            ? "This workflow has no product tags, so nothing will match it until you add some."
            : `Every order with a line item tagged ${workflow.tags
                .map((tag) => `“${tag}”`)
                .join(" or ")} will start a run of this workflow.`}
        </s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={TURN_ON_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={switching}
          disabled={!identified || switching}
          onClick={() => {
            activeMutation.mutate(true);
          }}
        >
          Turn on
        </s-button>
      </s-modal>

      <s-modal id={DELETE_MODAL} heading={`Delete ${workflow.name}?`}>
        <s-paragraph>{DELETE_WORKFLOW_WARNING}</s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={DELETE_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleteMutation.isPending}
          disabled={!identified || deleteMutation.isPending}
          onClick={() => {
            deleteMutation.mutate();
          }}
        >
          Delete
        </s-button>
      </s-modal>
    </s-page>
  );
}

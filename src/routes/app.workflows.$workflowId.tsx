import * as React from "react";

import "@/lib/shopifyAppBridgeElements";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { AttentionBanner, StageFlow } from "@/components/WorkflowStages";
import {
  activateResultMessage,
  AppliesSince,
  WorkflowSwitch,
} from "@/components/WorkflowSwitch";
import * as WorkflowTag from "@/components/WorkflowTag";
import * as Domain from "@/lib/Domain";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useWorkflowEditorWindow } from "@/lib/workflowEditorWindow";
import {
  copyName,
  DELETE_WORKFLOW_WARNING,
  deleteWorkflowResultMessage,
  DELETED_TOAST,
  itemTriggerLine,
  neverApplied,
  RENAME_FIELD_LABEL,
  RENAME_HEADING,
  RENAMED_TOAST,
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  turnOnBlocker,
  turnOnBody,
  workflowResultMessage,
} from "@/lib/workflowShared";

const WorkflowParams = Schema.Struct({ workflowId: Schema.String });

const RENAME_MODAL = "rename-workflow";
const DUPLICATE_MODAL = "duplicate-workflow";
const DELETE_MODAL = "delete-workflow";

const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);
const decodeDeleteWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DeleteWorkflowResult),
);

/** The holder a `TagTaken` named, for the link under the field; see `WorkflowTag.TagTakenLink`. */
type TagHolder = {
  readonly workflowId: string;
  readonly workflowName: string;
} | null;

const tagHolder = (result: Domain.WorkflowResult): TagHolder =>
  result._tag === "TagTaken"
    ? { workflowId: result.workflowId, workflowName: result.workflowName }
    : null;

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
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});

/**
 * Workflow detail: what this workflow does today, read-only. Every edit
 * happens on `/app/workflows/$workflowId/edit`, so this page has no step
 * controls and no form fields.
 *
 * The page shows what is in force and nothing else — the steps that start
 * runs now. A `Draft` accessory badge is the whole signal that the editor
 * holds unapplied changes; the editor, one click away, is where they are
 * read, applied, or discarded. There is no draft tab, no banner and no
 * sentence saying so: a badge and a button already say it, and a second
 * telling is what makes a page feel like a form. There is no version history
 * and no run history here either, on purpose: a run copies its steps when it
 * starts and is independent from then on.
 *
 * The header reads left to right as look · change · commit: `Edit`, `More
 * actions`, then the on/off switch as the primary. The switch is absent while
 * the workflow has never been applied (there is nothing in force to turn on —
 * the editor's Turn on applies and activates in one step) and while an
 * inactive workflow has a draft (what would be turned on is not what the
 * editor is holding).
 */
function RouteComponent() {
  const { workflowId } = Route.useParams();
  const detail: Domain.WorkflowLoaderData = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
  const [name, setName] = React.useState(detail?.workflow.name ?? "");
  const [copy, setCopy] = React.useState({ name: "", tag: "", dirty: false });
  const [copyTagError, setCopyTagError] = React.useState<string | null>(null);
  const [copyTagHolder, setCopyTagHolder] = React.useState<TagHolder>(null);

  const invalidate = () => router.invalidate({ sync: true });

  /** The editor opens in an `s-app-window` over this page, Flow's chrome; see `workflowEditorWindow.ts`. */
  const editor = useWorkflowEditorWindow({
    workflowId,
    onHide: () => void invalidate(),
    onDeleted: () => void navigate({ to: "/app/workflows" }),
  });

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
    /**
     * Nothing a rename can be refused for belongs under the field any more:
     * names are labels, so only `NotFound` is left and that is about the
     * workflow, not what was typed.
     */
    onSuccess: async (result) => {
      const message = workflowResultMessage(result);
      if (message !== null) {
        setBanner(message);
        return;
      }
      await shopify.modal.hide(RENAME_MODAL);
      shopify.toast.show(RENAMED_TOAST);
      await invalidate();
    },
    onError,
  });

  const duplicateMutation = useMutation({
    mutationFn: () =>
      call((stub) =>
        stub.duplicateWorkflow({
          workflowId,
          name: copy.name,
          tag: copy.tag,
        }),
      ).then(decodeWorkflowResult),
    onSuccess: async (result) => {
      // The tag is the copy's one unique key, so it is the one refusal that
      // goes under a field rather than into the banner above both.
      if (result._tag === "TagTaken") {
        setCopyTagError(workflowResultMessage(result));
        setCopyTagHolder(tagHolder(result));
        return;
      }
      if (result._tag !== "Ok") {
        setBanner(workflowResultMessage(result));
        return;
      }
      await shopify.modal.hide(DUPLICATE_MODAL);
      shopify.toast.show(`Copied to “${result.workflow.name}”.`);
      await navigate({
        to: "/app/workflows/$workflowId/edit",
        params: { workflowId: result.workflow.id },
      });
    },
    onError,
  });

  /**
   * The copy's tag mirrors its name until the merchant's first keystroke in
   * the tag field, the same rule the create dialog follows: the fold is
   * `trim().toLowerCase()`, what `Domain.WorkflowTag` applies at the schema
   * boundary, so what they see is what will be stored.
   */
  const seedDuplicateForm = () => {
    const suggested = copyName(detail?.workflow.name ?? "");
    setCopy({
      name: suggested,
      tag: suggested.trim().toLowerCase(),
      dirty: false,
    });
    setCopyTagError(null);
    setCopyTagHolder(null);
  };

  const deleteMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.removeWorkflow({ workflowId })).then(
        decodeDeleteWorkflowResult,
      ),
    onSuccess: async (result) => {
      if (result._tag === "Deleted") {
        await shopify.modal.hide(DELETE_MODAL);
        shopify.toast.show(DELETED_TOAST);
        await navigate({ to: "/app/workflows" });
        return;
      }
      setBanner(deleteWorkflowResultMessage(result));
    },
    onError,
  });

  /**
   * The rename field is a copy, so a name that changes underneath — a rename
   * from another tab, a reload — would leave the modal offering to save a name
   * the server no longer has. Re-seed during render rather than from an
   * effect: React re-runs this component with the new value before committing,
   * where an effect would paint the stale copy and then cascade a second
   * render to fix it. The guard is what makes it a re-seed and not a reset —
   * typing changes `name`, never `loadedName`, so it leaves typing alone.
   */
  const loadedName = detail?.workflow.name;
  const [seededName, setSeededName] = React.useState(loadedName);
  if (loadedName !== undefined && loadedName !== seededName) {
    setSeededName(loadedName);
    setName(loadedName);
  }

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

  const { draft, steps } = detail;
  const workflow = detail.workflow;

  const fresh = neverApplied(detail);
  const hasDraft = draft !== null;
  const blocker = turnOnBlocker(steps);
  const active = Domain.isActive(workflow);
  /** Flow's asymmetry: Turn off is always offered, Turn on only when what would go on is what the editor is holding. */
  const showSwitch = !fresh && (active || !hasDraft);

  return (
    <s-page heading={workflow.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/workflows">
        Workflows
      </s-link>
      {/* A workflow that has never been applied has no state to report: it is
          a draft and nothing else, so the one badge says that instead of
          calling it inactive. */}
      {fresh ? (
        <s-badge slot="accessory" tone="info">
          Draft
        </s-badge>
      ) : (
        <>
          {active ? (
            <s-badge slot="accessory" tone="success">
              {STATUS_ACTIVE}
            </s-badge>
          ) : (
            <s-badge slot="accessory">{STATUS_INACTIVE}</s-badge>
          )}
          {hasDraft && (
            <s-badge slot="accessory" tone="info">
              Draft
            </s-badge>
          )}
        </>
      )}
      <s-badge slot="accessory">{workflow.tag}</s-badge>
      <s-button
        slot="secondary-actions"
        icon="edit"
        commandFor={editor.windowProps.id}
        command="--show"
      >
        Edit
      </s-button>
      <s-app-window {...editor.windowProps} />
      <s-button slot="secondary-actions" commandFor="workflow-actions">
        More actions
      </s-button>
      <s-menu id="workflow-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_MODAL} command="--show">
          Rename
        </s-button>
        <s-button
          icon="duplicate"
          commandFor={DUPLICATE_MODAL}
          command="--show"
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
      <WorkflowSwitch
        workflow={workflow}
        steps={steps}
        turnOnBody={turnOnBody(workflow.tag)}
        slot="primary-action"
        showControl={showSwitch}
        onChanged={invalidate}
        onMessage={setBanner}
      />

      <SocketBanner />

      <s-paragraph color="subdued">
        Last updated on <LocalDateTime value={workflow.updatedAt} />
      </s-paragraph>

      <s-section accessibilityLabel="Workflow">
        <s-stack gap="base">
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {showSwitch && !active && blocker !== null && (
            <s-banner tone="info" heading="Turn on is unavailable">
              {/* Wrapped, like `AttentionBanner`'s lines: `s-banner` renders
                  its body from elements, and a bare string child never
                  reaches the page. */}
              <s-paragraph>{activateResultMessage(blocker)}</s-paragraph>
            </s-banner>
          )}

          {workflow.activatedAt !== null && (
            <AppliesSince
              activatedAt={workflow.activatedAt}
              disabled={!identified}
            />
          )}

          <AttentionBanner steps={steps} />

          <StageFlow
            steps={steps}
            trigger={
              <s-box
                padding="base"
                border="base subdued solid"
                borderRadius="base"
              >
                <s-stack gap="small-300">
                  <s-text type="strong">Tag</s-text>
                  <s-text color="subdued">
                    {itemTriggerLine(workflow.tag)}
                  </s-text>
                  {/* The tag is not drafted, so this is the workflow's own and the write lands immediately. */}
                  <WorkflowTag.WorkflowTag
                    tag={workflow.tag}
                    disabled={!identified}
                    onSave={(tag) =>
                      call((stub) =>
                        stub.updateWorkflowTag({ workflowId, tag }),
                      )
                        .then(decodeWorkflowResult)
                        .then(async (result) => {
                          if (result._tag === "Ok") await invalidate();
                          return result;
                        })
                    }
                  />
                </s-stack>
              </s-box>
            }
          />
        </s-stack>
      </s-section>

      <s-modal id={RENAME_MODAL} heading={RENAME_HEADING}>
        <s-stack gap="small-300">
          <s-text-field
            label={RENAME_FIELD_LABEL}
            value={name}
            maxLength={Domain.NAME_MAX_LENGTH}
            onInput={(event) => {
              setName(event.currentTarget.value);
            }}
          />
          {/* `s-text-field` has no counter of its own, and the limit is worth
              seeing while typing: the field silently stops accepting. */}
          <s-text color="subdued">
            {`${String(name.length)}/${String(Domain.NAME_MAX_LENGTH)}`}
          </s-text>
        </s-stack>
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

      <s-modal
        id={DUPLICATE_MODAL}
        heading="Duplicate workflow"
        onShow={seedDuplicateForm}
      >
        <s-stack gap="base">
          <s-text-field
            label="Name"
            value={copy.name}
            maxLength={Domain.NAME_MAX_LENGTH}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setCopy((current) => ({
                ...current,
                name: next,
                ...(current.dirty ? {} : { tag: next.trim().toLowerCase() }),
              }));
            }}
          />
          <s-text-field
            label="Tag"
            details="Put this tag on the products the copy should build."
            value={copy.tag}
            maxLength={255}
            {...(copyTagError === null ? {} : { error: copyTagError })}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setCopy((current) => ({ ...current, tag: next, dirty: true }));
              setCopyTagError(null);
              setCopyTagHolder(null);
            }}
          />
          <WorkflowTag.TagTakenLink holder={copyTagHolder} />
        </s-stack>
        <s-button
          slot="secondary-actions"
          commandFor={DUPLICATE_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={duplicateMutation.isPending}
          disabled={
            !identified ||
            copy.name.trim().length === 0 ||
            copy.tag.trim().length === 0
          }
          onClick={() => {
            duplicateMutation.mutate();
          }}
        >
          Duplicate
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

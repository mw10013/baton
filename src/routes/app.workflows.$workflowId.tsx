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
import { Lines } from "@/components/screen/Lines";
import { Panel } from "@/components/screen/Panel";
import { textLimitError } from "@/components/screen/TextLimit";
import { Things } from "@/components/screen/Things";
import { Token } from "@/components/screen/Token";
import { StepFlow, TeamFaultBanners } from "@/components/WorkflowSteps";
import { WorkflowSwitch } from "@/components/WorkflowSwitch";
import * as WorkflowTag from "@/components/WorkflowTag";
import * as Domain from "@/lib/Domain";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { DELETE_CONFIRM, DELETED_TOAST } from "@/lib/teams";
import { useWorkflowEditorWindow } from "@/lib/workflowEditorWindow";
import {
  copyName,
  deleteWorkflowResultMessage,
  itemTriggerLine,
  neverApplied,
  RENAME_FIELD_LABEL,
  RENAME_HEADING,
  RENAMED_TOAST,
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

/** `null` is not found. */
type WorkflowLoaderData = Domain.WorkflowPageData | null;

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
 * happens on `/app/workflows/$workflowId/edit`, so this page has no task
 * controls and no form fields.
 *
 * The page shows what is in force and nothing else — the tasks that start
 * runs now. A `Draft` accessory badge is the whole signal that the editor
 * holds unapplied changes; the editor, one click away, is where they are
 * read, applied, or discarded. There is no draft panel, no banner and no
 * sentence saying so: a badge and a button already say it, and a second
 * telling is what makes a page feel like a form. There is no version history
 * and no run history here either, on purpose: a run copies its tasks when it
 * starts and is independent from then on.
 *
 * The header reads left to right as look · change · commit: `Edit`, `More
 * actions`, then the on/off switch as the primary. The switch is absent while
 * the workflow has never been applied (there is nothing in force to turn on —
 * the editor's Turn on applies and turns on in one step) and while a
 * workflow that is off has a draft (what would be turned on is not what the
 * editor is holding).
 */
/**
 * The copy dialog's starting values: the suggested name and, mirroring it
 * until the first keystroke in the tag field, its tag ({@link copyName}).
 */
const suggestedCopy = (detail: Domain.WorkflowPageData | null) => {
  const suggested = copyName(detail?.workflow.name ?? "");
  return { name: suggested, tag: suggested.trim().toLowerCase(), dirty: false };
};

function RouteComponent() {
  const { workflowId } = Route.useParams();
  const detail: WorkflowLoaderData = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
  const [name, setName] = React.useState(detail?.workflow.name ?? "");
  const [copy, setCopy] = React.useState(() => suggestedCopy(detail));
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [copyNameError, setCopyNameError] = React.useState<string | null>(null);
  const [copyTagError, setCopyTagError] = React.useState<string | null>(null);

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
    /** `NameTaken` is about what was typed, so it goes under the field; anything else is about the workflow and goes in the banner. */
    onSuccess: async (result) => {
      const message = workflowResultMessage(result);
      if (result._tag === "NameTaken") {
        setNameError(message);
        return;
      }
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
      // The name and the tag are both unique, so each refusal goes under
      // its own field rather than into the banner above both.
      if (result._tag === "NameTaken") {
        setCopyNameError(workflowResultMessage(result));
        return;
      }
      if (result._tag === "TagTaken") {
        setCopyTagError(workflowResultMessage(result));
        return;
      }
      if (result._tag !== "Ok") {
        setBanner(workflowResultMessage(result));
        return;
      }
      await shopify.modal.hide(DUPLICATE_MODAL);
      shopify.toast.show(`Copied to “${result.workflow.name}”`);
      await navigate({
        to: "/app/workflows/$workflowId/edit",
        params: { workflowId: result.workflow.id },
      });
    },
    onError,
  });

  /**
   * The copy's tag mirrors its name until the merchant's first keystroke in
   * the tag field, the same suggestion the create dialog makes: trimmed and
   * lowercased here, in the route. `Domain.WorkflowTag` only trims; a tag is
   * compared exactly, so the fold is a default for a string the merchant will
   * type onto products, not a rule.
   */
  const seedDuplicateForm = () => {
    setCopy(suggestedCopy(detail));
    setCopyNameError(null);
    setCopyTagError(null);
  };

  const deleteMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.removeWorkflow({ workflowId })).then(
        decodeDeleteWorkflowResult,
      ),
    onSuccess: async (result) => {
      if (result._tag === "Deleted") {
        await shopify.modal.hide(DELETE_MODAL);
        shopify.toast.show(DELETED_TOAST.workflow);
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
    setCopy(suggestedCopy(detail));
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

  const { draftTasks, tasks } = detail;
  const workflow = detail.workflow;

  const fresh = neverApplied(detail);
  const hasDraft = draftTasks !== null;
  const on = Domain.workflowIsOn(workflow);
  /** Flow's asymmetry: Turn off is always offered, Turn on only when what would go on is what the editor is holding. */
  const showSwitch = !fresh && (on || !hasDraft);

  return (
    <s-page heading={workflow.name} inlineSize="base">
      {/* No search on the link: the layout's middleware carries the
          merchant's status filter back to the list (`WorkflowsSearch` in
          `app.workflows.tsx`). */}
      <s-link slot="breadcrumb-actions" href="/app/workflows">
        Workflows
      </s-link>
      {/* A workflow that has never been applied has no state to report: it is
          a draft and nothing else, so the one badge says that instead of
          calling it off. */}
      {fresh ? (
        <s-badge slot="accessory" tone="info">
          Draft
        </s-badge>
      ) : (
        <>
          {on ? (
            <s-badge slot="accessory" tone="success">
              {Domain.WORKFLOW_STATE_LABEL.on}
            </s-badge>
          ) : (
            <s-badge slot="accessory">
              {Domain.WORKFLOW_STATE_LABEL.off}
            </s-badge>
          )}
          {hasDraft && (
            <s-badge slot="accessory" tone="info">
              Draft
            </s-badge>
          )}
        </>
      )}
      <s-button
        slot="secondary-actions"
        icon="edit"
        commandFor={editor.windowProps.id}
        command="--show"
      >
        {Domain.RECORD_VERB_LABEL.edit}
      </s-button>
      <s-app-window {...editor.windowProps} />
      <s-button slot="secondary-actions" commandFor="workflow-actions">
        More actions
      </s-button>
      <s-menu id="workflow-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_MODAL} command="--show">
          {Domain.RECORD_VERB_LABEL.rename}
        </s-button>
        <s-button
          icon="duplicate"
          commandFor={DUPLICATE_MODAL}
          command="--show"
        >
          {Domain.RECORD_VERB_LABEL.duplicate}
        </s-button>
        <s-button
          icon="delete"
          tone="critical"
          commandFor={DELETE_MODAL}
          command="--show"
        >
          {Domain.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-menu>
      <WorkflowSwitch
        workflow={workflow}
        tasks={tasks}
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
        <Things>
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {/* No standing banner for what blocks Turn on: the disabled switch
              beside the "Needs a team" banner already says it (the copy
              table's banner row on `CopySlot`); the press result is
              `WorkflowSwitch`'s to report through `banner`. */}
          <TeamFaultBanners tasks={tasks} />

          <StepFlow
            tasks={tasks}
            trigger={
              <Panel kind="card">
                <Lines>
                  <s-heading>Tag</s-heading>
                  {/* The tag's home: printed whole, wrapping anywhere (a
                      token), where a badge or chip would cut it. */}
                  <Token color="subdued">{itemTriggerLine(workflow.tag)}</Token>
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
                </Lines>
              </Panel>
            }
          />
        </Things>
      </s-section>

      <s-modal
        id={RENAME_MODAL}
        heading={RENAME_HEADING}
        onAfterHide={() => {
          setNameError(null);
        }}
      >
        <Lines>
          <s-text-field
            label={RENAME_FIELD_LABEL}
            value={name}
            {...(nameError === null ? {} : { error: nameError })}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setNameError(null);
            }}
          />
        </Lines>
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
            const limit = textLimitError(name, Domain.NAME_MAX_LENGTH);
            if (limit !== null) {
              setNameError(limit);
              return;
            }
            renameMutation.mutate();
          }}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal
        id={DUPLICATE_MODAL}
        heading="Duplicate workflow"
        /* Seeded from the workflow on first render and again on rename
           (`loadedName`), so opening needs no seeding. Reseed on the way out,
           not on the way in: `show` can fire after a field has already taken
           input, and a seed there wipes what was typed (the members index's create
           dialog did exactly that). */
        onAfterHide={seedDuplicateForm}
      >
        <Things>
          <s-text-field
            label="Name"
            value={copy.name}
            {...(copyNameError === null ? {} : { error: copyNameError })}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setCopy((current) => ({
                ...current,
                name: next,
                ...(current.dirty ? {} : { tag: next.trim().toLowerCase() }),
              }));
              setCopyNameError(null);
              if (!copy.dirty) setCopyTagError(null);
            }}
          />
          <s-text-field
            label="Tag"
            details="Put this tag on the products the copy should build."
            value={copy.tag}
            {...(copyTagError === null ? {} : { error: copyTagError })}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setCopy((current) => ({ ...current, tag: next, dirty: true }));
              setCopyTagError(null);
            }}
          />
        </Things>
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
            const nameLimit = textLimitError(copy.name, Domain.NAME_MAX_LENGTH);
            const tagLimit = textLimitError(copy.tag, Domain.TAG_MAX_LENGTH);
            if (nameLimit !== null) setCopyNameError(nameLimit);
            if (tagLimit !== null) setCopyTagError(tagLimit);
            if (nameLimit !== null || tagLimit !== null) return;
            duplicateMutation.mutate();
          }}
        >
          {Domain.RECORD_VERB_LABEL.duplicate}
        </s-button>
      </s-modal>

      <s-modal id={DELETE_MODAL} heading={`Delete ${workflow.name}?`}>
        <s-paragraph>{DELETE_CONFIRM}</s-paragraph>
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
          {Domain.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-modal>
    </s-page>
  );
}

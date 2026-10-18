import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { useState } from "react";
import * as ShopWork from "../../domain/shop-work.ts";
import { hideModal, toast } from "../client/app-bridge.ts";
import {
  deleteWorkflowAtom,
  duplicateWorkflowAtom,
  updateWorkflowAtom,
  updateWorkflowTagAtom,
} from "../client/shop-actor-client.ts";
import { thrownCopy } from "./form.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { Lines } from "./screen/Lines.tsx";
import { PageNote } from "./screen/PageNote.tsx";
import { Panel } from "./screen/Panel.tsx";
import { textLimitError } from "./screen/TextLimit.tsx";
import { Things } from "./screen/Things.tsx";
import { Token } from "./screen/Token.tsx";
import { DELETED_TOAST } from "./teams.ts";
import { StepFlow, TeamFaultBanners } from "./WorkflowSteps.tsx";
import { WorkflowSwitch } from "./WorkflowSwitch.tsx";
import { WorkflowTag } from "./WorkflowTag.tsx";
import {
  copyName,
  DELETE_WORKFLOW_BODY,
  deleteWorkflowResultMessage,
  itemTriggerLine,
  neverApplied,
  RENAME_FIELD_LABEL,
  RENAME_HEADING,
  RENAMED_TOAST,
  suggestedTag,
  TAG_HELP,
  tagCommaError,
  turnOnBody,
  workflowResultMessage,
} from "./workflow-shared.ts";

export const RENAME_WORKFLOW_MODAL = "rename-workflow";
export const DUPLICATE_WORKFLOW_MODAL = "duplicate-workflow";
export const DELETE_WORKFLOW_MODAL = "delete-workflow";

const WORKFLOW_GONE = "That workflow no longer exists.";

/** {@link WorkflowPage}'s props: the loader's detail and the route's navigation. */
export interface WorkflowPageProps {
  /** `null` is no such workflow in this shop. */
  readonly detail: ShopWork.WorkflowPageData | null;
  /** The breadcrumb to the workflows index, with the index's filter, search and page. */
  readonly workflowsLink: PageLink;
  /** After a write: re-read the loader. */
  readonly onChanged: () => Promise<void>;
  /** After Duplicate: open the copy. */
  readonly onDuplicated: (workflow: ShopWork.Workflow) => Promise<void>;
  /** After Delete: back to the workflows index. */
  readonly onDeleted: () => Promise<void>;
}

/** A write's answer to the screen: the union, or the copy of what was thrown. */
type Press<A, R> = (input: A) => Promise<R | string>;

interface Presses {
  readonly renaming: boolean;
  readonly duplicating: boolean;
  readonly deleting: boolean;
  readonly rename: Press<ShopWork.WorkflowName, ShopWork.WorkflowResult>;
  readonly duplicate: Press<
    { readonly name: ShopWork.WorkflowName; readonly tag: ShopWork.WorkflowTag },
    ShopWork.WorkflowResult
  >;
  readonly deleteWorkflow: Press<void, ShopWork.DeleteWorkflowResult>;
  readonly updateTag: (tag: ShopWork.WorkflowTag) => Promise<ShopWork.WorkflowResult>;
}

/** The copy dialog's starting values: the suggested name and, mirroring it until the first keystroke in the tag field, its tag ({@link copyName}). */
const suggestedCopy = (detail: ShopWork.WorkflowPageData) => {
  const suggested = copyName(detail.workflow.name);
  return { name: suggested, tag: suggestedTag(suggested), dirty: false };
};

const decodeName = Schema.decodeUnknownOption(ShopWork.WorkflowName);
const decodeTag = Schema.decodeUnknownOption(ShopWork.WorkflowTag);

function WorkflowScreen(
  props: WorkflowPageProps & {
    readonly detail: ShopWork.WorkflowPageData;
    readonly presses: Presses;
  },
) {
  const { detail, presses } = props;
  const { draftTasks, tasks, workflow } = detail;
  const [banner, setBanner] = useState<string | null>(null);
  const [name, setName] = useState<string>(workflow.name);
  const [copy, setCopy] = useState(() => suggestedCopy(detail));
  const [nameError, setNameError] = useState<string | null>(null);
  const [copyNameError, setCopyNameError] = useState<string | null>(null);
  const [copyTagError, setCopyTagError] = useState<string | null>(null);

  /**
   * The rename field is a copy, so a name that changes underneath (a rename from another tab, a
   * reload) would leave the modal offering to save a name the server no longer has. Re-seed
   * during render rather than from an effect: React re-runs this component with the new value
   * before committing, where an effect would paint the stale copy and then cascade a second
   * render to fix it. The guard is what makes it a re-seed and not a reset: typing changes
   * `name`, never `loadedName`, so it leaves typing alone.
   */
  const loadedName = workflow.name;
  const [seededName, setSeededName] = useState<string>(loadedName);
  if (loadedName !== seededName) {
    setSeededName(loadedName);
    setName(loadedName);
    setCopy(suggestedCopy(detail));
  }

  const rename = async () => {
    const limit = textLimitError(name, ShopWork.NAME_MAX_LENGTH);
    if (limit !== null) return setNameError(limit);
    const decoded = decodeName(name);
    if (decoded._tag === "None") return;
    const result = await presses.rename(decoded.value);
    if (typeof result === "string") return setBanner(result);
    // `NameTaken` is about what was typed, so it goes under the field; anything else is about
    // the workflow and goes in the banner.
    if (result._tag === "NameTaken") return setNameError(workflowResultMessage(result));
    const message = workflowResultMessage(result);
    if (message !== null) setBanner(message);
  };

  const duplicate = async () => {
    const nameLimit = textLimitError(copy.name, ShopWork.NAME_MAX_LENGTH);
    const tagLimit = textLimitError(copy.tag, ShopWork.TAG_MAX_LENGTH) ?? tagCommaError(copy.tag);
    if (nameLimit !== null) setCopyNameError(nameLimit);
    if (tagLimit !== null) setCopyTagError(tagLimit);
    if (nameLimit !== null || tagLimit !== null) return;
    const decodedName = decodeName(copy.name);
    const decodedTag = decodeTag(copy.tag);
    if (decodedName._tag === "None" || decodedTag._tag === "None") return;
    const result = await presses.duplicate({ name: decodedName.value, tag: decodedTag.value });
    if (typeof result === "string") return setBanner(result);
    if (result._tag === "NameTaken") return setCopyNameError(workflowResultMessage(result));
    if (result._tag === "TagTaken") return setCopyTagError(workflowResultMessage(result));
    const message = workflowResultMessage(result);
    if (message !== null) setBanner(message);
  };

  const deleteWorkflow = async () => {
    const result = await presses.deleteWorkflow();
    if (typeof result === "string") return setBanner(result);
    const message = deleteWorkflowResultMessage(result);
    if (message !== null) setBanner(message);
  };

  /**
   * The new workflow's tag mirrors its name until the merchant's first keystroke in the tag
   * field, the same suggestion the create dialog makes.
   */
  const seedDuplicateForm = () => {
    setCopy(suggestedCopy(detail));
    setCopyNameError(null);
    setCopyTagError(null);
  };

  const fresh = neverApplied(detail);
  const hasDraft = draftTasks !== null;
  const active = ShopWork.workflowIsActive(workflow);
  /** Flow's asymmetry: Turn off is always offered, Turn on only when what would go on is what the editor is holding. */
  const showSwitch = !fresh && (active || !hasDraft);

  return (
    <s-page heading={workflow.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" {...props.workflowsLink}>
        Workflows
      </s-link>
      {/* A workflow that has never been applied has no state to report: it is a draft and
          nothing else, so the one badge says that instead of calling it inactive. */}
      {fresh ? (
        <s-badge slot="accessory" tone="info">
          Draft
        </s-badge>
      ) : (
        <>
          <s-badge slot="accessory">
            {active ? ShopWork.WORKFLOW_STATE_LABEL.active : ShopWork.WORKFLOW_STATE_LABEL.inactive}
          </s-badge>
          {hasDraft && (
            <s-badge slot="accessory" tone="info">
              Draft
            </s-badge>
          )}
        </>
      )}
      <s-button slot="secondary-actions" commandFor="workflow-actions">
        More actions
      </s-button>
      <s-menu id="workflow-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_WORKFLOW_MODAL} command="--show">
          {ShopWork.RECORD_VERB_LABEL.rename}
        </s-button>
        <s-button icon="duplicate" commandFor={DUPLICATE_WORKFLOW_MODAL} command="--show">
          {ShopWork.RECORD_VERB_LABEL.duplicate}
        </s-button>
        <s-button icon="delete" tone="critical" commandFor={DELETE_WORKFLOW_MODAL} command="--show">
          {ShopWork.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-menu>
      <WorkflowSwitch
        workflow={workflow}
        tasks={tasks}
        turnOnBody={turnOnBody(workflow.tag)}
        slot="primary-action"
        showControl={showSwitch}
        onChanged={props.onChanged}
        onMessage={setBanner}
      />

      <PageNote>
        Last updated on <LocalDateTime value={workflow.updatedAt} />
      </PageNote>

      <s-section accessibilityLabel="Workflow">
        <Things>
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {/* No standing banner for what blocks Turn on: the disabled switch beside the "Needs a
              team" banner already says it; the press result is `WorkflowSwitch`'s to report. */}
          <TeamFaultBanners tasks={tasks} />

          <StepFlow
            tasks={tasks}
            trigger={
              <Panel kind="card">
                <Lines>
                  <s-heading>Tag</s-heading>
                  {/* The tag's home: printed whole, wrapping anywhere (a token). */}
                  <Token color="subdued">{itemTriggerLine(workflow.tag)}</Token>
                  {/* The tag is not drafted, so this is the workflow's own and the write lands
                      immediately. */}
                  <WorkflowTag tag={workflow.tag} disabled={false} onSave={presses.updateTag} />
                </Lines>
              </Panel>
            }
          />
        </Things>
      </s-section>

      <s-modal
        id={RENAME_WORKFLOW_MODAL}
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
        <s-button slot="secondary-actions" commandFor={RENAME_WORKFLOW_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={presses.renaming}
          disabled={name.trim().length === 0}
          onClick={() => {
            void rename();
          }}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal
        id={DUPLICATE_WORKFLOW_MODAL}
        heading="Duplicate workflow"
        // Seeded from the workflow on first render and again on rename (`loadedName`), so
        // opening needs no seeding; reseeded on the way out, for the reason on Create's dialog.
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
                ...(current.dirty ? {} : { tag: suggestedTag(next) }),
              }));
              setCopyNameError(null);
              if (!copy.dirty) setCopyTagError(null);
            }}
          />
          <s-text-field
            label="Tag"
            details={TAG_HELP}
            value={copy.tag}
            {...(copyTagError === null ? {} : { error: copyTagError })}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setCopy((current) => ({ ...current, tag: next, dirty: true }));
              setCopyTagError(null);
            }}
          />
        </Things>
        <s-button slot="secondary-actions" commandFor={DUPLICATE_WORKFLOW_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={presses.duplicating}
          disabled={copy.name.trim().length === 0 || copy.tag.trim().length === 0}
          onClick={() => {
            void duplicate();
          }}
        >
          {ShopWork.RECORD_VERB_LABEL.duplicate}
        </s-button>
      </s-modal>

      <s-modal id={DELETE_WORKFLOW_MODAL} heading={`Delete ${workflow.name}?`}>
        <s-paragraph>{DELETE_WORKFLOW_BODY}</s-paragraph>
        <s-button slot="secondary-actions" commandFor={DELETE_WORKFLOW_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={presses.deleting}
          disabled={presses.deleting}
          onClick={() => {
            void deleteWorkflow();
          }}
        >
          {ShopWork.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-modal>
    </s-page>
  );
}

/** A press that threw (a lost socket, a defect), as the page says it. */
const thrown = (fallback: string) => async (cause: Cause.Cause<unknown>) =>
  thrownCopy(Cause.squash(cause), fallback);

/**
 * The page once hydrated: Rename, Duplicate, Delete and Edit tag are their `Merchant…`
 * procedures on the layout's socket, each union answered as the page words it.
 */
function LiveWorkflow(props: WorkflowPageProps & { readonly detail: ShopWork.WorkflowPageData }) {
  const workflowId = props.detail.workflow.id;
  const renaming = AsyncResult.isWaiting(useAtomValue(updateWorkflowAtom));
  const duplicating = AsyncResult.isWaiting(useAtomValue(duplicateWorkflowAtom));
  const deleting = AsyncResult.isWaiting(useAtomValue(deleteWorkflowAtom));
  const rename = useAtomSet(updateWorkflowAtom, { mode: "promiseExit" });
  const duplicate = useAtomSet(duplicateWorkflowAtom, { mode: "promiseExit" });
  const deleteWorkflow = useAtomSet(deleteWorkflowAtom, { mode: "promiseExit" });
  const updateTag = useAtomSet(updateWorkflowTagAtom, { mode: "promiseExit" });

  const presses: Presses = {
    renaming,
    duplicating,
    deleting,
    rename: async (name) =>
      Exit.match(await rename({ payload: { workflowId, name } }), {
        onSuccess: async (result) => {
          if (result._tag === "Ok") {
            await hideModal(RENAME_WORKFLOW_MODAL);
            toast(RENAMED_TOAST);
            await props.onChanged();
          }
          return result;
        },
        onFailure: thrown("Couldn't rename the workflow."),
      }),
    duplicate: async ({ name, tag }) =>
      Exit.match(await duplicate({ payload: { workflowId, name, tag } }), {
        onSuccess: async (result) => {
          if (result._tag === "Ok") {
            await hideModal(DUPLICATE_WORKFLOW_MODAL);
            toast("Workflow duplicated");
            await props.onDuplicated(result.workflow);
          }
          return result;
        },
        onFailure: thrown("Couldn't duplicate the workflow."),
      }),
    deleteWorkflow: async () =>
      Exit.match(await deleteWorkflow({ payload: { workflowId } }), {
        onSuccess: async (result) => {
          if (result._tag === "Deleted") {
            await hideModal(DELETE_WORKFLOW_MODAL);
            toast(DELETED_TOAST.workflow);
            await props.onDeleted();
          }
          return result;
        },
        onFailure: thrown("Couldn't delete the workflow."),
      }),
    updateTag: async (tag) =>
      Exit.match(await updateTag({ payload: { workflowId, tag } }), {
        onSuccess: async (result) => {
          if (result._tag === "Ok") await props.onChanged();
          return result;
        },
        onFailure: async (cause) => {
          throw Cause.squash(cause);
        },
      }),
  };
  return <WorkflowScreen {...props} detail={props.detail} presses={presses} />;
}

/**
 * Workflow detail: what this workflow does today, read-only. Every task edit happens in the
 * editor, so this page has no task controls and no form fields.
 *
 * The page shows what is in force and nothing else: the tasks that start runs now. A `Draft`
 * accessory badge is the whole signal that the editor holds unapplied changes. There is no
 * version history and no run history here either, on purpose: a run copies its tasks when it
 * starts and is independent from then on.
 *
 * The switch is absent while the workflow has never been applied (there is nothing in force to
 * turn on; the editor's Turn on applies and turns on in one step) and while an inactive workflow
 * has a draft (what would be turned on is not what the editor is holding). The title-bar state
 * badge carries no tone: the primary button beside it already carries the state's colour. Its
 * data is the loader's (no live read); until React has hydrated nothing presses.
 */
export default function WorkflowPage(props: WorkflowPageProps) {
  const hydrated = useHydrated();
  if (props.detail === null)
    return (
      <s-page heading="Workflow not found">
        <s-link slot="breadcrumb-actions" {...props.workflowsLink}>
          Workflows
        </s-link>
        <s-paragraph color="subdued">{WORKFLOW_GONE}</s-paragraph>
      </s-page>
    );
  if (hydrated) return <LiveWorkflow {...props} detail={props.detail} />;
  const idle = async () => "Not ready.";
  return (
    <WorkflowScreen
      {...props}
      detail={props.detail}
      presses={{
        renaming: false,
        duplicating: false,
        deleting: false,
        rename: idle,
        duplicate: idle,
        deleteWorkflow: idle,
        updateTag: () => Promise.reject(new Error("Not ready.")),
      }}
    />
  );
}

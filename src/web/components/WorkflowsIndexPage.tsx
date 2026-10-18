import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { useState } from "react";
import * as ShopWork from "../../domain/shop-work.ts";
import { hideModal } from "../client/app-bridge.ts";
import { createWorkflowAtom } from "../client/shop-actor-client.ts";
import { thrownCopy } from "./form.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { Fields } from "./screen/Fields.tsx";
import { FilterRow } from "./screen/FilterRow.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";
import { Inline } from "./screen/Inline.tsx";
import { ListSearchField } from "./screen/ListSearchField.tsx";
import { SearchLine } from "./screen/SearchLine.tsx";
import { textLimitError } from "./screen/TextLimit.tsx";
import { Token } from "./screen/Token.tsx";
import { useWorkflowEditorWindow } from "./workflow-editor-window.ts";
import { suggestedTag, TAG_HELP, tagCommaError, workflowResultMessage } from "./workflow-shared.ts";

/** The Create workflow dialog's id. */
export const CREATE_WORKFLOW_MODAL = "create-workflow";

/**
 * One place for every state badge. The fault badges are the {@link ShopWork.WorkflowFault}s,
 * labelled {@link ShopWork.WORKFLOW_FAULT_LABEL} and toned {@link ShopWork.ORDER_ISSUE_TONE}:
 * `unassigned` and `emptyTeam`, derived by the actor on every read.
 */
export const stateBadges = (workflow: ShopWork.WorkflowSummary) => (
  <Inline>
    {ShopWork.workflowIsActive(workflow) ? (
      <s-badge tone="success">{ShopWork.WORKFLOW_STATE_LABEL.active}</s-badge>
    ) : (
      <s-badge>{ShopWork.WORKFLOW_STATE_LABEL.inactive}</s-badge>
    )}
    {workflow.stepCount === 0 && <s-badge tone="warning">No steps</s-badge>}
    {workflow.unassigned && (
      <s-badge tone={ShopWork.ORDER_ISSUE_TONE}>{ShopWork.WORKFLOW_FAULT_LABEL.unassigned}</s-badge>
    )}
    {workflow.emptyTeam && (
      <s-badge tone={ShopWork.ORDER_ISSUE_TONE}>{ShopWork.WORKFLOW_FAULT_LABEL.empty_team}</s-badge>
    )}
  </Inline>
);

/** {@link WorkflowsIndexPage}'s props: the loader's page and the route's navigation. */
export interface WorkflowsIndexProps {
  readonly data: ShopWork.WorkflowsIndexData;
  /** The filter, the search and the page cursor in the URL, `null` when absent. */
  readonly state: ShopWork.WorkflowsIndexState | null;
  readonly q: ShopWork.ListSearch | null;
  readonly after: ShopWork.WorkflowName | null;
  readonly workflowLink: (id: ShopWork.WorkflowId) => PageLink;
  /** A filter or search change; the page goes back to one. A key left out keeps its value. */
  readonly onFilter: (patch: {
    readonly state?: ShopWork.WorkflowsIndexState | null;
    readonly q?: ShopWork.ListSearch | null;
  }) => void;
  readonly onNextPage: (cursor: ShopWork.WorkflowName) => void;
  readonly onPreviousPage: () => void;
  /** After Create: re-read the loader; the editor window then opens on the new workflow. */
  readonly onCreated: () => Promise<void>;
  /** The created workflow's editor window closed: its workflow page. */
  readonly onEditorClosed: (workflowId: ShopWork.WorkflowId) => Promise<void>;
  /** The editor window reported a Delete of the created workflow: re-read the loader. */
  readonly onEditorDeleted: () => Promise<void>;
}

/** What a press of Create answers the screen: the union, or the copy of what was thrown. */
type CreateWorkflow = (
  input: ShopWork.CreateWorkflowInput,
) => Promise<ShopWork.WorkflowResult | string>;

const decodeCreate = Schema.decodeUnknownOption(ShopWork.CreateWorkflowInput);

function WorkflowsIndexScreen(
  props: WorkflowsIndexProps & {
    readonly creating: boolean;
    readonly createWorkflow: CreateWorkflow;
  },
) {
  const { workflows, nextCursor, matches } = props.data;
  /**
   * Create opens the editor straight away, as Flow's Create workflow does, and closing it lands
   * on the new workflow's page rather than back here ({@link useWorkflowEditorWindow}).
   */
  const [created, setCreated] = useState<ShopWork.WorkflowId | null>(null);
  const editor = useWorkflowEditorWindow({
    onHide: () => {
      if (created !== null) void props.onEditorClosed(created);
    },
    onDeleted: () => {
      setCreated(null);
      void props.onEditorDeleted();
    },
  });
  const { state, q, after } = props;
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [tagDirty, setTagDirty] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const resetCreateForm = () => {
    setName("");
    setTag("");
    setTagDirty(false);
    setNameError(null);
    setTagError(null);
  };

  /**
   * The tag mirrors the name until the merchant's first keystroke in the tag field, then stops
   * for good (until the modal reopens). The mirror is {@link suggestedTag}, a suggestion and not
   * a rule: `WorkflowTag` stores the tag as the field shows it, trimmed, and matches it exactly,
   * so what the merchant sees is what will be stored. Only the create dialog mirrors: a later
   * rename never touches the tag, because products already carry the old string.
   */
  const onNameInput = (next: string) => {
    setName(next);
    setNameError(null);
    if (!tagDirty) {
      setTag(suggestedTag(next));
      setTagError(null);
    }
  };

  const create = async () => {
    const nameLimit = textLimitError(name, ShopWork.NAME_MAX_LENGTH);
    const tagLimit = textLimitError(tag, ShopWork.TAG_MAX_LENGTH) ?? tagCommaError(tag);
    if (nameLimit !== null) setNameError(nameLimit);
    if (tagLimit !== null) setTagError(tagLimit);
    if (nameLimit !== null || tagLimit !== null) return;
    const input = decodeCreate({ name, tag });
    if (input._tag === "None") return;
    const result = await props.createWorkflow(input.value);
    if (typeof result === "string") return setBanner(result);
    // The name and the tag are both unique, so each refusal goes under its own field rather
    // than into the banner above both.
    if (result._tag === "NameTaken") return setNameError(workflowResultMessage(result));
    if (result._tag === "TagTaken") return setTagError(workflowResultMessage(result));
    if (result._tag !== "Ok") return setBanner(workflowResultMessage(result));
    resetCreateForm();
    setCreated(result.workflow.id);
    editor.open(result.workflow.id);
  };

  /** No search, no filter and page one: an empty page here means the shop has no workflows. */
  const unfiltered = q === null && state === null && after === null;

  const stateButton = (label: string, value: ShopWork.WorkflowsIndexState | null) => (
    <s-press-button
      variant="tertiary"
      pressed={state === value}
      onClick={() => {
        props.onFilter({ state: value });
      }}
    >
      {label}
    </s-press-button>
  );

  const createButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={CREATE_WORKFLOW_MODAL}
      command="--show"
    >
      {`${ShopWork.RECORD_VERB_LABEL.create} workflow`}
    </s-button>
  );

  const clearSearch = () => {
    props.onFilter({ q: null });
  };

  const renderRows = () => {
    if (unfiltered && workflows.length === 0)
      return <EmptyLine heading="No workflows yet" action={createButton(false)} />;
    if (q !== null && workflows.length === 0)
      return (
        <EmptyLine
          action={
            <s-button variant="secondary" onClick={clearSearch}>
              Clear search
            </s-button>
          }
        >{`No workflow matches ${q}`}</EmptyLine>
      );
    if (workflows.length === 0)
      return (
        <EmptyLine
          action={
            <s-button
              variant="secondary"
              onClick={() => {
                props.onFilter({ state: null });
              }}
            >
              Clear filters
            </s-button>
          }
        >
          No workflows match.
        </EmptyLine>
      );
    return (
      <s-table
        paginate={after !== null || nextCursor !== null}
        hasPreviousPage={after !== null}
        hasNextPage={nextCursor !== null}
        onPreviousPage={props.onPreviousPage}
        onNextPage={() => {
          if (nextCursor !== null) props.onNextPage(nextCursor);
        }}
      >
        <s-table-header-row>
          <s-table-header listSlot="primary">Workflow</s-table-header>
          <s-table-header>Status</s-table-header>
          <s-table-header>Tag</s-table-header>
          <s-table-header>Steps</s-table-header>
          <s-table-header>Updated</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {workflows.map((workflow) => (
            <s-table-row key={workflow.id} id={workflow.id}>
              <s-table-cell>
                <s-link {...props.workflowLink(workflow.id)}>{workflow.name}</s-link>
              </s-table-cell>
              <s-table-cell>{stateBadges(workflow)}</s-table-cell>
              {/* The tag as subdued text that wraps anywhere (a token), not a badge: a tag may be
                  255 characters and a badge cuts to one line with no way to read the rest. */}
              <s-table-cell>
                <Token color="subdued">{workflow.tag}</Token>
              </s-table-cell>
              <s-table-cell>{workflow.stepCount}</s-table-cell>
              <s-table-cell>
                <LocalDateTime value={workflow.updatedAt} />
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  return (
    <s-page heading="Workflows" inlineSize="large">
      <s-app-window {...editor.windowProps} />
      {/* Unconditional, empty list included: the resource-index template keeps the title-bar
          primary action and lets the empty state carry a second copy. App Bridge hoists this one
          out of the iframe, so the in-card twin is not a duplicate in the frame's DOM. */}
      {createButton(true)}

      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {/* The head is gated on there being something to filter. A search ignores the state
          filter, so the buttons give way to how many workflows match and Clear search
          (`SearchLine`); a search that matched nothing says so in the list's place instead. */}
      <IndexSection
        label="Workflows"
        head={
          unfiltered && workflows.length === 0 ? null : (
            <>
              {q !== null && matches !== null && matches > 0 && (
                <SearchLine
                  count={matches}
                  noun={["workflow", "workflows"]}
                  term={q}
                  onClear={clearSearch}
                />
              )}
              <FilterRow
                main={
                  q === null ? (
                    <Inline>
                      {stateButton("All", null)}
                      {stateButton(ShopWork.WORKFLOW_STATE_LABEL.active, "active")}
                      {stateButton(ShopWork.WORKFLOW_STATE_LABEL.inactive, "inactive")}
                    </Inline>
                  ) : undefined
                }
                search={
                  <ListSearchField
                    value={q}
                    placeholder="Search by name"
                    onSubmit={(next) => {
                      props.onFilter({ q: next });
                    }}
                  />
                }
              />
            </>
          )
        }
      >
        {renderRows()}
      </IndexSection>

      <s-modal
        id={CREATE_WORKFLOW_MODAL}
        heading={`${ShopWork.RECORD_VERB_LABEL.create} workflow`}
        // Reset on the way out, not on the way in: `show` can fire after a field has already
        // taken input, and a reset there wipes what was typed.
        onAfterHide={resetCreateForm}
      >
        <Fields>
          <s-text-field
            label="Name"
            placeholder="e.g. Engraved ring"
            value={name}
            {...(nameError === null ? {} : { error: nameError })}
            onInput={(event) => {
              onNameInput(event.currentTarget.value);
            }}
          />
          <s-text-field
            label="Tag"
            details={TAG_HELP}
            value={tag}
            {...(tagError === null ? {} : { error: tagError })}
            onInput={(event) => {
              setTag(event.currentTarget.value);
              setTagDirty(true);
              setTagError(null);
            }}
          />
        </Fields>
        <s-button slot="secondary-actions" commandFor={CREATE_WORKFLOW_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={props.creating}
          disabled={name.trim().length === 0 || tag.trim().length === 0}
          onClick={() => {
            void create();
          }}
        >
          {ShopWork.RECORD_VERB_LABEL.create}
        </s-button>
      </s-modal>
    </s-page>
  );
}

/**
 * The screen once hydrated: Create workflow is `MerchantCreateWorkflow` on the layout's socket
 * ({@link createWorkflowAtom}); on `Ok` the modal hides and the editor window opens on the new workflow.
 */
function LiveWorkflowsIndex(props: WorkflowsIndexProps) {
  const creating = AsyncResult.isWaiting(useAtomValue(createWorkflowAtom));
  const create = useAtomSet(createWorkflowAtom, { mode: "promiseExit" });
  const createWorkflow: CreateWorkflow = async (input) =>
    Exit.match(await create({ payload: input }), {
      onSuccess: async (result) => {
        if (result._tag === "Ok") {
          await hideModal(CREATE_WORKFLOW_MODAL);
          await props.onCreated();
        }
        return result;
      },
      onFailure: async (cause) => thrownCopy(Cause.squash(cause), "Couldn't create the workflow."),
    });
  return <WorkflowsIndexScreen {...props} creating={creating} createWorkflow={createWorkflow} />;
}

/**
 * The workflows page: the workflows in name order, one page at a time, with a search by name and
 * a state filter. Delete lives on the workflow page; the index has no destructive control.
 *
 * Creating asks for a name and a tag, the tag prefilled from the name: the tag is what makes a
 * workflow reachable at all, so it is asked for at the moment the merchant forms the model of
 * the object, not behind the editor. Tasks are decisions made in the editor, in front of the
 * trigger card that says what they do, so the page carries no standing form. Its data is the
 * loader's (no live read); until React has hydrated nothing presses.
 */
export default function WorkflowsIndexPage(props: WorkflowsIndexProps) {
  const hydrated = useHydrated();
  if (hydrated) return <LiveWorkflowsIndex {...props} />;
  return (
    <WorkflowsIndexScreen {...props} creating={false} createWorkflow={async () => "Not ready."} />
  );
}

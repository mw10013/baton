import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { EmptyLine } from "@/components/screen/EmptyLine";
import { Fields } from "@/components/screen/Fields";
import { FilterRow } from "@/components/screen/FilterRow";
import { IndexSection } from "@/components/screen/IndexSection";
import { Inline } from "@/components/screen/Inline";
import { ListSearchField } from "@/components/screen/ListSearchField";
import { SearchLine } from "@/components/screen/SearchLine";
import { textLimitError } from "@/components/screen/TextLimit";
import { Token } from "@/components/screen/Token";
import * as Domain from "@/lib/Domain";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useWorkflowEditorWindow } from "@/lib/workflowEditorWindow";
import {
  suggestedTag,
  TAG_HELP,
  tagCommaError,
  workflowResultMessage,
} from "@/lib/workflowShared";

const CREATE_MODAL = "create-workflow";
const WORKFLOWS_PAGE_SIZE = 50;

const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);

/**
 * One place for every state badge. The fault badges are the
 * {@link Domain.WorkflowFault}s, labelled {@link Domain.WORKFLOW_FAULT_LABEL}
 * and toned {@link Domain.ORDER_ISSUE_TONE}: `unassigned` and `emptyTeam`,
 * derived by the object on every read.
 */
export const stateBadges = (workflow: Domain.WorkflowSummary) => (
  <Inline>
    {Domain.workflowIsActive(workflow) ? (
      <s-badge tone="success">{Domain.WORKFLOW_STATE_LABEL.active}</s-badge>
    ) : (
      <s-badge>{Domain.WORKFLOW_STATE_LABEL.inactive}</s-badge>
    )}
    {workflow.stepCount === 0 && <s-badge tone="warning">No steps</s-badge>}
    {workflow.unassigned && (
      <s-badge tone={Domain.ORDER_ISSUE_TONE}>
        {Domain.WORKFLOW_FAULT_LABEL.unassigned}
      </s-badge>
    )}
    {workflow.emptyTeam && (
      <s-badge tone={Domain.ORDER_ISSUE_TONE}>
        {Domain.WORKFLOW_FAULT_LABEL.empty_team}
      </s-badge>
    )}
  </Inline>
);

type WorkflowsIndexLoaderData = Domain.WorkflowsIndexData;

/** The page the URL names: the search, the state filter and the page ({@link Domain.ListWorkflowsInput}). */
const WorkflowsLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.ListSearch),
  state: Schema.NullOr(Domain.WorkflowsIndexState),
  after: Schema.NullOr(Domain.WorkflowName),
});

/**
 * Workflow definitions are configuration one person edits, so the read is a
 * loader (the loader-versus-socket rule on `ShopAgentClient`): SSR paint, and
 * `router.invalidate()` after each write. Only the writes use the socket.
 * One page in name order: the index pages and searches in the object rather
 * than here, so its cost does not grow with the shop's workflows.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(WorkflowsLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data: { q, state, after }, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        return (yield* (yield* ShopAgentClient).listWorkflows(session.shop, {
          limit: WORKFLOWS_PAGE_SIZE,
          cursor: after,
          q,
          state,
        })) satisfies WorkflowsIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/app/workflows/")({
  loaderDeps: ({ search }) => ({
    q: search.q ?? null,
    state: search.state ?? null,
    after: search.after ?? null,
  }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

/**
 * The workflows page: the workflows in name order, one page at a time, with
 * a search by name and a state filter. Delete lives on the detail page; the
 * index has no destructive control.
 *
 * Creating asks for a name and a tag, the tag prefilled from the name — the
 * tag is what makes a workflow reachable at all, so it is asked for at the
 * moment the merchant forms the model of the object, not behind the editor.
 * The name is the label merchants and members pick the workflow by, and the
 * tag mirrors it as the merchant types, so the name field is also how most of
 * them will produce a tag at all.
 * Tasks are decisions made in the editor, in front of the trigger card that
 * says what they do, so the page carries no standing form.
 */
function RouteComponent() {
  const { workflows, nextCursor, matches } = Route.useLoaderData();
  const { state, q, after } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const nextPageEntry = useLocation({
    select: (location) => location.state.workflowsNextPage === true,
  });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [name, setName] = React.useState("");
  const [tag, setTag] = React.useState("");
  const [tagDirty, setTagDirty] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [tagError, setTagError] = React.useState<string | null>(null);
  const [banner, setBanner] = React.useState<string | null>(null);

  /**
   * Create opens the editor straight away, as Flow's Create workflow does,
   * and closing it lands on the new workflow's page rather than back here.
   * See `workflowEditorWindow.ts`.
   */
  const [created, setCreated] = React.useState<string | null>(null);
  const editor = useWorkflowEditorWindow({
    onHide: () => {
      if (created === null) return;
      void navigate({
        to: "/app/workflows/$workflowId",
        params: { workflowId: created },
      });
    },
    onDeleted: () => {
      setCreated(null);
      void router.invalidate({ sync: true });
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.createWorkflow({ name, tag }),
          ).then(decodeWorkflowResult)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    onSuccess: async (result) => {
      // The name and the tag are both unique, so each refusal goes under
      // its own field rather than into the banner above both.
      if (result._tag === "NameTaken") {
        setNameError(workflowResultMessage(result));
        return;
      }
      if (result._tag === "TagTaken") {
        setTagError(workflowResultMessage(result));
        return;
      }
      if (result._tag !== "Ok") {
        setBanner(workflowResultMessage(result));
        return;
      }
      await shopify.modal.hide(CREATE_MODAL);
      resetCreateForm();
      await router.invalidate({ sync: true });
      setCreated(result.workflow.id);
      editor.open(result.workflow.id);
    },
    onError: (error: Error) => {
      setBanner(error.message);
    },
  });

  const resetCreateForm = () => {
    setName("");
    setTag("");
    setTagDirty(false);
    setNameError(null);
    setTagError(null);
  };

  /**
   * The tag mirrors the name until the merchant's first keystroke in the tag
   * field, then stops for good (until the modal reopens). The mirror is
   * {@link suggestedTag}, a suggestion and not a rule: `Domain.WorkflowTag`
   * stores the tag as the field shows it, trimmed, and matches it exactly, so
   * what the merchant sees is what will be stored. Only the create dialog
   * mirrors: a later rename never touches the tag, because products already
   * carry the old string.
   */
  const onNameInput = (next: string) => {
    setName(next);
    setNameError(null);
    if (!tagDirty) {
      setTag(suggestedTag(next));
      setTagError(null);
    }
  };

  /**
   * `state: undefined` is how the filter is removed; leaving the key out
   * would let the layout's middleware retain the old value
   * (`WorkflowsSearch` in `app.workflows.tsx`). `replace: true` for the
   * member's workflows list's reason (`selectState` in `shop.$shop.workflows.index.tsx`): the filters are a
   * screen's state, not a trail.
   */
  const setFilters = (patch: {
    readonly state?: Domain.WorkflowsIndexState | null;
    readonly q?: Domain.ListSearch | null;
  }) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        state:
          patch.state === undefined ? prev.state : (patch.state ?? undefined),
        q: patch.q === undefined ? prev.q : (patch.q ?? undefined),
        after: undefined,
      }),
      replace: true,
    });
  };

  /** Next and Previous, for the reason on `nextPage` in `app.orders.index.tsx`. */
  const nextPage = (cursor: Domain.WorkflowName) => {
    void navigate({
      search: (prev) => ({ ...prev, after: cursor }),
      state: { workflowsNextPage: true },
    });
  };
  const previousPage = () => {
    if (nextPageEntry) {
      router.history.back();
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, after: undefined }),
      replace: true,
    });
  };

  const clearSearch = () => {
    setFilters({ q: null });
  };
  /** No search, no filter and page one: an empty page here means the shop has no workflows. */
  const unfiltered =
    q === undefined && state === undefined && after === undefined;

  const stateButton = (label: string, value?: Domain.WorkflowsIndexState) => (
    <s-press-button
      variant="tertiary"
      pressed={state === value}
      onClick={() => {
        setFilters({ state: value ?? null });
      }}
    >
      {label}
    </s-press-button>
  );

  const createButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={CREATE_MODAL}
      command="--show"
    >
      {`${Domain.RECORD_VERB_LABEL.create} workflow`}
    </s-button>
  );

  const renderRows = () => {
    if (unfiltered && workflows.length === 0)
      return (
        <EmptyLine heading="No workflows yet" action={createButton(false)} />
      );
    if (q !== undefined && workflows.length === 0)
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
                setFilters({ state: null });
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
        paginate={after !== undefined || nextCursor !== null}
        hasPreviousPage={after !== undefined}
        hasNextPage={nextCursor !== null}
        onPreviousPage={previousPage}
        onNextPage={() => {
          if (nextCursor !== null) nextPage(nextCursor);
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
                <s-link href={`/app/workflows/${workflow.id}`}>
                  {workflow.name}
                </s-link>
              </s-table-cell>
              <s-table-cell>{stateBadges(workflow)}</s-table-cell>
              {/* The tag as subdued text that wraps anywhere (a token, the
                  parts table's token row), not a badge: a tag may be 255
                  characters and a badge cuts to one line with no way to read
                  the rest. */}
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
      <SocketBanner />
      {/* Unconditional, empty list included: the resource-index template keeps
          the title-bar primary action and lets the empty state carry a second
          copy, so "create is top right" holds on the visit where it matters
          most. App Bridge hoists this one out of the iframe, so the in-card
          twin is not a duplicate in the frame's DOM — frame- and page-scoped
          e2e locators stay disjoint.
          https://shopify.dev/docs/api/app-home/latest/patterns/templates/resource-index */}
      {createButton(true)}

      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {/* The card carries no description: the badges and the Turn on / Turn
          off buttons already say what a workflow is and what its state
          means. The head is gated on there being something to filter. A
          search ignores the state filter, so the buttons give way to how many
          workflows match and Clear search ({@link SearchLine}); a search
          that matched nothing says so in the list's place instead. */}
      <IndexSection
        label="Workflows"
        head={
          unfiltered && workflows.length === 0 ? null : (
            <>
              {q !== undefined && matches !== null && matches > 0 && (
                <SearchLine
                  count={matches}
                  noun={["workflow", "workflows"]}
                  term={q}
                  onClear={clearSearch}
                />
              )}
              <FilterRow
                main={
                  q === undefined ? (
                    <Inline>
                      {stateButton("All")}
                      {stateButton(
                        Domain.WORKFLOW_STATE_LABEL.active,
                        "active",
                      )}
                      {stateButton(
                        Domain.WORKFLOW_STATE_LABEL.inactive,
                        "inactive",
                      )}
                    </Inline>
                  ) : undefined
                }
                search={
                  <ListSearchField
                    value={q ?? null}
                    placeholder="Search by name"
                    onSubmit={(next) => {
                      setFilters({ q: next });
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
        id={CREATE_MODAL}
        heading={`${Domain.RECORD_VERB_LABEL.create} workflow`}
        /* Reset on the way out, not on the way in: `show` can fire after a
           field has already taken input, and a reset there wipes what was
           typed (the members index's create dialog did exactly that). */
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
        <s-button
          slot="secondary-actions"
          commandFor={CREATE_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={createMutation.isPending}
          disabled={
            !identified || name.trim().length === 0 || tag.trim().length === 0
          }
          onClick={() => {
            const nameLimit = textLimitError(name, Domain.NAME_MAX_LENGTH);
            const tagLimit =
              textLimitError(tag, Domain.TAG_MAX_LENGTH) ?? tagCommaError(tag);
            if (nameLimit !== null) setNameError(nameLimit);
            if (tagLimit !== null) setTagError(tagLimit);
            if (nameLimit !== null || tagLimit !== null) return;
            createMutation.mutate();
          }}
        >
          {Domain.RECORD_VERB_LABEL.create}
        </s-button>
      </s-modal>
    </s-page>
  );
}

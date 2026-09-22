import * as React from "react";

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
import * as WorkflowTag from "@/components/WorkflowTag";
import * as Domain from "@/lib/Domain";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useWorkflowEditorWindow } from "@/lib/workflowEditorWindow";
import {
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  workflowResultMessage,
} from "@/lib/workflowShared";

const CREATE_MODAL = "create-workflow";

/**
 * The status tabs are in the URL, so a filtered list is a link someone can
 * send. The search text is not: it changes on every keystroke and is
 * nobody's destination. There is no tag filter: a workflow's tag is its
 * identity, not a grouping dimension, and one filter button per tag made it
 * look like one.
 *
 * Hand-written rather than a schema so a value the page does not know —
 * a stale link, a hand-edited URL — reads as "no filter" instead of failing
 * the route: a wrong filter is not an error condition.
 */
interface WorkflowsSearch {
  readonly status?: "active" | "inactive";
}
const validateSearch = ({
  status,
}: Record<string, unknown>): WorkflowsSearch =>
  status === "active" || status === "inactive" ? { status } : {};

const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);

/**
 * One place for every status badge. Flow hides a pending draft from its
 * list; Baton shows it, because a production floor needs to know that what
 * starts runs today is not what is being edited (see `Domain.Workflow`).
 * "No steps" is a workflow whose draft has never been applied. "Needs
 * attention" is derived by the object on every read: an unassigned step or a
 * team with no members.
 */
export const statusBadges = (workflow: Domain.WorkflowSummary) => (
  <s-stack direction="inline" gap="small-300">
    {Domain.isActive(workflow) ? (
      <s-badge tone="success">{STATUS_ACTIVE}</s-badge>
    ) : (
      <s-badge>{STATUS_INACTIVE}</s-badge>
    )}
    {workflow.hasDraft && <s-badge tone="info">Draft</s-badge>}
    {workflow.stepCount === 0 && <s-badge tone="warning">No steps</s-badge>}
    {workflow.needsAttention && (
      <s-badge tone="critical">Needs attention</s-badge>
    )}
  </s-stack>
);

/**
 * Workflow definitions are configuration one person edits, so the read is a
 * loader (the loader-versus-socket rule on `ShopAgentClient`): SSR paint, and
 * `router.invalidate()` after each write. Only the writes use the socket.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const workflows = yield* (yield* ShopAgentClient).listWorkflows(
          session.shop,
        );
        return { workflows } satisfies Domain.WorkflowsIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/app/workflows/")({
  validateSearch,
  loader: () => getLoaderData(),
  component: RouteComponent,
});

/**
 * The workflows page: every workflow as a filterable list. Delete lives on
 * the detail page; the index has no destructive control.
 *
 * Creating asks for a name and a tag, the tag prefilled from the name — the
 * tag is what makes a workflow reachable at all, so it is asked for at the
 * moment the merchant forms the model of the object, not behind the editor.
 * The name is asked for even though it is only a label and nothing depends on
 * it: the tag mirrors the name as the merchant types, so the name field is how
 * most of them will produce a tag at all, and dropping it would leave the tag
 * field alone with nothing to mirror.
 * Steps are decisions made in the editor, in front of the trigger card that
 * says what they do, so the page carries no standing form.
 */
function RouteComponent() {
  const { workflows } = Route.useLoaderData();
  const { status } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [query, setQuery] = React.useState("");
  const [name, setName] = React.useState("");
  const [tag, setTag] = React.useState("");
  const [tagDirty, setTagDirty] = React.useState(false);
  const [tagError, setTagError] = React.useState<string | null>(null);
  const [tagHolder, setTagHolder] = React.useState<{
    readonly workflowId: string;
    readonly workflowName: string;
  } | null>(null);
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
      // The tag is the workflow's one unique key, so it is the one refusal
      // that goes under a field rather than into the banner above both.
      if (result._tag === "TagTaken") {
        setTagError(workflowResultMessage(result));
        setTagHolder({
          workflowId: result.workflowId,
          workflowName: result.workflowName,
        });
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
    setTagError(null);
    setTagHolder(null);
  };

  /**
   * The tag mirrors the name until the merchant's first keystroke in the tag
   * field, then stops for good (until the modal reopens). The mirror is
   * `trim().toLowerCase()`, the same folding `Domain.WorkflowTag` applies at
   * the schema boundary, so what the merchant sees is what will be stored —
   * no slug logic, and spaces stay because Shopify tags allow them. Only the
   * create dialog mirrors: a later rename never touches the tag, because
   * products already carry the old string.
   */
  const onNameInput = (next: string) => {
    setName(next);
    if (!tagDirty) setTag(next.trim().toLowerCase());
  };

  /** Whatever is not in `next` is cleared, so the URL only ever carries the filters in force. */
  const setFilters = (next: WorkflowsSearch) => {
    void navigate({ search: next });
  };

  const trimmed = query.trim().toLowerCase();
  const rows = workflows.filter((workflow) => {
    if (status === "active" && !Domain.isActive(workflow)) return false;
    if (status === "inactive" && Domain.isActive(workflow)) return false;
    if (trimmed !== "" && !workflow.name.toLowerCase().includes(trimmed))
      return false;
    return true;
  });
  const filtered = status !== undefined || trimmed !== "";

  const statusButton = (label: string, value?: "active" | "inactive") => (
    <s-button
      variant={status === value ? "primary" : "tertiary"}
      onClick={() => {
        setFilters(value === undefined ? {} : { status: value });
      }}
    >
      {label}
    </s-button>
  );

  const createButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={CREATE_MODAL}
      command="--show"
    >
      Create workflow
    </s-button>
  );

  const renderRows = () => {
    if (workflows.length === 0)
      return (
        <s-box padding="base">
          <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
            <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
              <s-heading>No item workflows yet</s-heading>
              {createButton(false)}
            </s-grid>
          </s-grid>
        </s-box>
      );
    if (rows.length === 0)
      return (
        <s-box padding="base">
          <s-stack gap="base" alignItems="start">
            <s-paragraph color="subdued">No item workflows match.</s-paragraph>
            <s-button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setFilters({});
              }}
            >
              Clear filters
            </s-button>
          </s-stack>
        </s-box>
      );
    return (
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Workflow</s-table-header>
          <s-table-header>Status</s-table-header>
          <s-table-header>Tag</s-table-header>
          <s-table-header>Steps</s-table-header>
          <s-table-header>Updated</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((workflow) => (
            <s-table-row key={workflow.id} id={workflow.id}>
              <s-table-cell>
                <s-link href={`/app/workflows/${workflow.id}`}>
                  {workflow.name}
                </s-link>
              </s-table-cell>
              <s-table-cell>{statusBadges(workflow)}</s-table-cell>
              <s-table-cell>
                <s-badge>{workflow.tag}</s-badge>
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

      {/* `padding="none"` so the table runs edge to edge; the filters go
          inside a padded box instead of a slotted heading. The card carries no
          description: the badges and the Turn on / Turn off buttons already
          say what a workflow is and what its state means. */}
      <s-section padding="none" accessibilityLabel="Item workflows">
        {workflows.length > 0 && (
          <s-box padding="base">
            <s-stack gap="small-300">
              <s-grid
                gridTemplateColumns="auto 1fr"
                gap="base"
                alignItems="center"
              >
                <s-stack direction="inline" gap="small-300">
                  {statusButton("All")}
                  {statusButton(STATUS_ACTIVE, "active")}
                  {statusButton(STATUS_INACTIVE, "inactive")}
                </s-stack>
                <s-search-field
                  label="Search workflows by name"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search by name"
                  value={query}
                  onInput={(event) => {
                    setQuery(event.currentTarget.value);
                  }}
                />
              </s-grid>
              {filtered && (
                <s-paragraph color="subdued">
                  {`Showing ${String(rows.length)} of ${String(workflows.length)} item workflows.`}
                </s-paragraph>
              )}
            </s-stack>
          </s-box>
        )}

        {renderRows()}
      </s-section>

      <s-modal
        id={CREATE_MODAL}
        heading="Create workflow"
        /* Reset on the way out, not on the way in: `show` can fire after a
           field has already taken input, and a reset there wipes what was
           typed (the Add member dialog in `app.members.tsx` did exactly that). */
        onAfterHide={resetCreateForm}
      >
        <s-stack gap="base">
          <s-text-field
            label="Name"
            placeholder="e.g. Engraved ring"
            details="You'll add the steps next."
            value={name}
            maxLength={Domain.NAME_MAX_LENGTH}
            onInput={(event) => {
              onNameInput(event.currentTarget.value);
            }}
          />
          <s-text-field
            label="Tag"
            details="Add this tag to your products in Shopify. Their items will follow this workflow."
            value={tag}
            maxLength={255}
            {...(tagError === null ? {} : { error: tagError })}
            onInput={(event) => {
              setTag(event.currentTarget.value);
              setTagDirty(true);
              setTagError(null);
              setTagHolder(null);
            }}
          />
          <WorkflowTag.TagTakenLink holder={tagHolder} />
        </s-stack>
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
            createMutation.mutate();
          }}
        >
          Create
        </s-button>
      </s-modal>
    </s-page>
  );
}

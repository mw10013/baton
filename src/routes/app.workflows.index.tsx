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
import * as Domain from "@/lib/Domain";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { workflowResultMessage } from "@/lib/workflowShared";

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
  readonly status?: "active" | "off";
}
const validateSearch = ({
  status,
}: Record<string, unknown>): WorkflowsSearch =>
  status === "active" || status === "off" ? { status } : {};

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
      <s-badge tone="success">Active</s-badge>
    ) : (
      <s-badge>Off</s-badge>
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
 * Item workflows only: the order workflow has its own page.
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
 * The workflows page: the item workflows as a filterable list. The order
 * workflow is not here — it has no tag, exactly one exists, and a shared
 * table would carry a blank column — so it lives at `/app/order-workflow`,
 * the nav entry right after this one. Delete lives on the detail page; the
 * index has no destructive control.
 *
 * Creating asks for a name and a tag, the tag prefilled from the name — the
 * tag is what makes a workflow reachable at all, so it is asked for at the
 * moment the merchant forms the model of the object, not behind the editor.
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
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [banner, setBanner] = React.useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.createWorkflow({
              name,
              tags: tag.trim() === "" ? [] : [tag],
            }),
          ).then(decodeWorkflowResult)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    onSuccess: async (result) => {
      if (result._tag !== "Ok") {
        setNameError(workflowResultMessage(result));
        return;
      }
      await shopify.modal.hide(CREATE_MODAL);
      resetCreateForm();
      await router.invalidate({ sync: true });
      await navigate({
        to: "/app/workflows/$workflowId/edit",
        params: { workflowId: result.workflow.id },
      });
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
    setNameError(null);
    if (!tagDirty) setTag(next.trim().toLowerCase());
  };

  /** Whatever is not in `next` is cleared, so the URL only ever carries the filters in force. */
  const setFilters = (next: WorkflowsSearch) => {
    void navigate({ search: next });
  };

  const trimmed = query.trim().toLowerCase();
  const rows = workflows.filter((workflow) => {
    if (status === "active" && !Domain.isActive(workflow)) return false;
    if (status === "off" && Domain.isActive(workflow)) return false;
    if (trimmed !== "" && !workflow.name.toLowerCase().includes(trimmed))
      return false;
    return true;
  });
  const filtered = status !== undefined || trimmed !== "";

  const statusButton = (label: string, value?: "active" | "off") => (
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
          <s-stack gap="base" alignItems="start">
            <s-paragraph color="subdued">
              No item workflows yet. Each one is the ordered list of steps a
              line item passes through, each owned by a team. Each workflow has
              a tag; products carrying it follow that workflow.
            </s-paragraph>
            {createButton(false)}
          </s-stack>
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
                {workflow.tags.length === 0 ? (
                  <s-text color="subdued">—</s-text>
                ) : (
                  <s-stack direction="inline" gap="small-300">
                    <s-badge>{workflow.tags[0]}</s-badge>
                    {workflow.tags.length > 1 && (
                      <s-text color="subdued">{`+${String(workflow.tags.length - 1)}`}</s-text>
                    )}
                  </s-stack>
                )}
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
      <SocketBanner />
      {workflows.length > 0 && createButton(true)}

      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {/* `padding="none"` so the table runs edge to edge; the description
          goes inside a padded intro box instead of a slotted heading. */}
      <s-section padding="none" accessibilityLabel="Item workflows">
        <s-box padding="base" paddingBlockEnd="none">
          <s-paragraph color="subdued">
            Each one is the ordered list of steps a line item passes through,
            chosen by its tag. Turn one off to stop new runs while open runs
            finish.
          </s-paragraph>
        </s-box>

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
                  {statusButton("Active", "active")}
                  {statusButton("Off", "off")}
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
        onShow={resetCreateForm}
      >
        <s-stack gap="base">
          <s-text-field
            label="Name"
            placeholder="e.g. Engraved ring"
            details="You'll add the steps next."
            value={name}
            maxLength={64}
            {...(nameError === null ? {} : { error: nameError })}
            onInput={(event) => {
              onNameInput(event.currentTarget.value);
            }}
          />
          <s-text-field
            label="Tag"
            details="Add this tag to your products in Shopify. Their items will follow this workflow."
            value={tag}
            maxLength={255}
            onInput={(event) => {
              setTag(event.currentTarget.value);
              setTagDirty(true);
            }}
          />
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
          disabled={!identified || name.trim().length === 0}
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

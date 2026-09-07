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

import * as Domain from "@/lib/Domain";
import { formatDateTime } from "@/lib/format";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import {
  ORDER_WORKFLOW_TRIGGER,
  workflowResultMessage,
} from "@/lib/workflowShared";

const CREATE_MODAL = "create-workflow";
/**
 * Two create paths, never one button that asks which kind. The header button
 * always makes an item workflow; the order workflow is created only from its
 * own section's empty state, which exists only while the shop has none.
 */
const CREATE_ORDER_MODAL = "create-order-workflow";

/**
 * The status tabs and the tag filter are in the URL, so a filtered list is a
 * link someone can send. The search text is not: it changes on every
 * keystroke and is nobody's destination.
 *
 * Hand-written rather than a schema so a value the page does not know —
 * a stale link, a hand-edited URL — reads as "no filter" instead of failing
 * the route: a wrong filter is not an error condition.
 */
interface WorkflowsSearch {
  readonly status?: "active" | "off";
  readonly tag?: string;
}
const validateSearch = ({
  status,
  tag,
}: Record<string, unknown>): WorkflowsSearch => ({
  ...(status === "active" || status === "off" ? { status } : {}),
  ...(typeof tag === "string" && tag.length > 0 ? { tag } : {}),
});

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
 *
 * The order-workflow row above the list renders the same badges.
 */
export const statusBadges = (workflow: Domain.WorkflowSummary) => (
  <s-stack direction="inline" gap="small-300">
    {workflow.active ? (
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
 *
 * Both kinds come back; the page splits them by `type`.
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
 * The workflows page: the order workflow as one compact row above, the item
 * workflows as the filterable list below. The two never share a table, a
 * filter or a create button — the order workflow has no product tags and at
 * most one exists, so a shared table would carry a blank column and a filter
 * that cannot apply to it. Above the list rather than below because a
 * merchant looking for it has to find it; compact because a shop-wide
 * singleton must not read as more important than the daily work. Delete
 * lives on the detail page for both kinds; the index has no destructive
 * control.
 *
 * Creating asks for a name and nothing else — a workflow's product tags and
 * steps are decisions made in the editor, in front of the trigger card that
 * says what they do — so the page carries no standing form.
 */
function RouteComponent() {
  const { workflows: allWorkflows } = Route.useLoaderData();
  const { status, tag } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [query, setQuery] = React.useState("");
  const [name, setName] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [orderName, setOrderName] = React.useState("");
  const [orderNameError, setOrderNameError] = React.useState<string | null>(
    null,
  );
  const [banner, setBanner] = React.useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.createWorkflow({ name, type: "item", tags: [] }),
          ).then(decodeWorkflowResult)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    onSuccess: async (result) => {
      if (result._tag !== "Ok") {
        setNameError(workflowResultMessage(result));
        return;
      }
      await shopify.modal.hide(CREATE_MODAL);
      setName("");
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

  const createOrderMutation = useMutation({
    mutationFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.createWorkflow({ name: orderName, type: "order" }),
          ).then(decodeWorkflowResult)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    onSuccess: async (result) => {
      if (result._tag !== "Ok") {
        setOrderNameError(workflowResultMessage(result));
        return;
      }
      await shopify.modal.hide(CREATE_ORDER_MODAL);
      setOrderName("");
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

  const workflows = allWorkflows.filter(Domain.isItemWorkflow);
  /** The slot is taken by any order workflow, on or off (`Workflow_order_uidx`). */
  const orderWorkflow =
    allWorkflows.find((workflow) => workflow.type === "order") ?? null;
  const tags = [
    ...new Set(workflows.flatMap((workflow) => workflow.tags)),
  ].toSorted();

  /** Whatever is not in `next` is cleared, so the URL only ever carries the filters in force. */
  const setFilters = (next: WorkflowsSearch) => {
    void navigate({ search: next });
  };

  const trimmed = query.trim().toLowerCase();
  const rows = workflows.filter((workflow) => {
    if (status === "active" && !workflow.active) return false;
    if (status === "off" && workflow.active) return false;
    if (tag !== undefined && !workflow.tags.some((one) => one === tag))
      return false;
    if (trimmed !== "" && !workflow.name.toLowerCase().includes(trimmed))
      return false;
    return true;
  });
  const filtered = status !== undefined || tag !== undefined || trimmed !== "";

  const statusButton = (label: string, value?: "active" | "off") => (
    <s-button
      variant={status === value ? "primary" : "tertiary"}
      onClick={() => {
        setFilters({
          ...(value === undefined ? {} : { status: value }),
          ...(tag === undefined ? {} : { tag }),
        });
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

  const renderOrderWorkflow = () => {
    if (orderWorkflow === null)
      return (
        <s-stack gap="base" alignItems="start">
          <s-paragraph color="subdued">
            No order workflow yet. Add one for the steps that happen once per
            order after every item is made — packing, a final check, the
            invoice.
          </s-paragraph>
          <s-button commandFor={CREATE_ORDER_MODAL} command="--show">
            Create order workflow
          </s-button>
        </s-stack>
      );
    return (
      <s-stack gap="small-300">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-link href={`/app/workflows/${orderWorkflow.id}`}>
              {orderWorkflow.name}
            </s-link>
            {statusBadges(orderWorkflow)}
            <s-text color="subdued">
              {`${String(orderWorkflow.stepCount)} ${orderWorkflow.stepCount === 1 ? "step" : "steps"}`}
            </s-text>
            <s-badge tone="info">One per shop</s-badge>
          </s-stack>
          <s-button
            variant="tertiary"
            href={`/app/workflows/${orderWorkflow.id}`}
          >
            Open
          </s-button>
        </s-grid>
        <s-paragraph color="subdued">{ORDER_WORKFLOW_TRIGGER}</s-paragraph>
      </s-stack>
    );
  };

  const renderRows = () => {
    if (workflows.length === 0)
      return (
        <s-box padding="base">
          <s-stack gap="base" alignItems="start">
            <s-paragraph color="subdued">
              No item workflows yet. Each one is the ordered list of steps a
              line item passes through, each owned by a team. Product tags
              decide which items follow it.
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
          <s-table-header>Product tags</s-table-header>
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
                    {workflow.tags.map((productTag) => (
                      <s-badge key={productTag}>{productTag}</s-badge>
                    ))}
                  </s-stack>
                )}
              </s-table-cell>
              <s-table-cell>{workflow.stepCount}</s-table-cell>
              <s-table-cell>{formatDateTime(workflow.updatedAt)}</s-table-cell>
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

      <s-section heading="Order workflow" accessibilityLabel="Order workflow">
        {renderOrderWorkflow()}
      </s-section>

      {/* No `heading` attribute: the section has `padding="none"` so the
          table runs edge to edge, which would leave a slotted heading flush
          against the card's left edge. The heading goes inside the padded
          intro box instead. */}
      <s-section padding="none" accessibilityLabel="Item workflows">
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="small-300">
            <s-heading>Item workflows</s-heading>
            <s-paragraph color="subdued">
              Each one is the ordered list of steps a line item passes through,
              chosen by product tag. Turn one off to stop new runs while open
              runs finish.
            </s-paragraph>
          </s-stack>
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
              {tags.length > 0 && (
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text color="subdued">Product tag</s-text>
                  <s-button
                    variant={tag === undefined ? "primary" : "tertiary"}
                    onClick={() => {
                      setFilters(status === undefined ? {} : { status });
                    }}
                  >
                    Any
                  </s-button>
                  {tags.map((productTag) => (
                    <s-button
                      key={productTag}
                      variant={tag === productTag ? "primary" : "tertiary"}
                      onClick={() => {
                        setFilters({
                          ...(status === undefined ? {} : { status }),
                          tag: productTag,
                        });
                      }}
                    >
                      {productTag}
                    </s-button>
                  ))}
                </s-stack>
              )}
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

      <s-modal id={CREATE_MODAL} heading="Create workflow">
        <s-text-field
          label="Name"
          placeholder="e.g. Engraved ring"
          details="You'll add the product tags and steps next."
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

      <s-modal id={CREATE_ORDER_MODAL} heading="Create order workflow">
        <s-text-field
          label="Name"
          placeholder="e.g. Pack and ship"
          details="You'll add the steps next. It has no product tags: it runs once per order."
          value={orderName}
          maxLength={64}
          {...(orderNameError === null ? {} : { error: orderNameError })}
          onInput={(event) => {
            setOrderName(event.currentTarget.value);
            setOrderNameError(null);
          }}
        />
        <s-button
          slot="secondary-actions"
          commandFor={CREATE_ORDER_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={createOrderMutation.isPending}
          disabled={!identified || orderName.trim().length === 0}
          onClick={() => {
            createOrderMutation.mutate();
          }}
        >
          Create
        </s-button>
      </s-modal>
    </s-page>
  );
}

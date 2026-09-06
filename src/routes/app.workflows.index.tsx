import * as React from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError } from "@/lib/form";
import { formatDateTime } from "@/lib/format";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";

const CreateWorkflowForm = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Name is required" })),
  scope: Domain.WorkflowScope,
  tags: Schema.String,
});
type CreateWorkflowForm = typeof CreateWorkflowForm.Type;

/**
 * `Schema.toType` on the mutation results: the Durable Object already decoded
 * them, so the wire value is the decoded shape. See the same note on
 * `decodeOrdersView` in `app.orders.index.tsx`.
 */ const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);
const decodeDeleteWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DeleteWorkflowResult),
);

/** Comma-separated text → tag list; the Durable Object normalises again. */
export const splitTags = (text: string) =>
  text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

export const workflowResultMessage = Match.typeTags<
  Domain.WorkflowResult,
  string | null
>()({
  Ok: () => null,
  NameTaken: () =>
    "A workflow with that name already exists. Choose another name.",
  NotFound: () => "That workflow no longer exists.",
  Limit: ({ limit }) =>
    `This shop has reached its limit of ${String(limit)} workflows.`,
  OrderWorkflowExists: () =>
    "This shop already has an order workflow. Delete it first to create another.",
});

export const deleteWorkflowResultMessage = Match.typeTags<
  Domain.DeleteWorkflowResult,
  string | null
>()({
  Deleted: () => null,
  NotFound: () => "That workflow no longer exists.",
});

/**
 * The delete dialog's body, both surfaces. It says nothing about runs
 * because none are lost: a delete removes the definition only, and every run
 * stays on its order (the merchant copy of `Domain.Workflow`).
 */
export const DELETE_WORKFLOW_WARNING = "This can't be undone.";

/**
 * One place for every status badge. Flow hides a pending draft from its
 * list; Baton shows it, because a production floor needs to know that what
 * starts runs today is not what is being edited (see `Domain.Workflow`).
 * "No steps" is a workflow whose draft has never been applied. "Needs
 * attention" is derived by the object on every read: an unassigned step or a
 * team with no members.
 */
const statusBadges = (workflow: Domain.WorkflowSummary) => (
  <s-stack direction="inline" gap="small-300">
    {workflow.active ? (
      <s-badge tone="success">Active</s-badge>
    ) : (
      <s-badge>Off</s-badge>
    )}
    {workflow.hasDraft && <s-badge tone="caution">Draft pending</s-badge>}
    {workflow.stepCount === 0 && <s-badge tone="warning">No steps</s-badge>}
    {workflow.needsAttention && (
      <s-badge tone="warning">Needs attention</s-badge>
    )}
  </s-stack>
);

/** The order-scope trigger line, in the merchant copy of `Domain.Workflow`; the wait for item runs stays internal. */
export const ORDER_WORKFLOW_TRIGGER = "Starts for every paid order.";

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
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  const { workflows: allWorkflows } = Route.useLoaderData();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
  /** Which workflow's delete is awaiting its inline confirmation. */
  const [confirming, setConfirming] = React.useState<Domain.WorkflowId | null>(
    null,
  );

  const invalidate = () => router.invalidate({ sync: true });

  const onResult = (result: Domain.WorkflowResult) => {
    setBanner(workflowResultMessage(result));
    return invalidate();
  };

  const createMutation = useMutation({
    mutationFn: ({ name, scope, tags }: CreateWorkflowForm) =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.createWorkflow({
              name,
              scope,
              tags: scope === "order" ? [] : splitTags(tags),
            }),
          ).then(decodeWorkflowResult)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    onSuccess: async (result) => {
      if (result._tag === "Ok") form.reset();
      await onResult(result);
    },
    onError: (error) => {
      setBanner(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (input: typeof Domain.DeleteWorkflowInput.Encoded) =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.removeWorkflow(input),
          ).then(decodeDeleteWorkflowResult)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    onSuccess: async (result) => {
      setBanner(deleteWorkflowResultMessage(result));
      setConfirming(null);
      await invalidate();
    },
    onError: (error) => {
      setBanner(error.message);
    },
  });

  const form = useForm({
    defaultValues: {
      name: "",
      scope: "item" as Domain.WorkflowScope,
      tags: "",
    } satisfies CreateWorkflowForm,
    validators: { onSubmit: Schema.toStandardSchemaV1(CreateWorkflowForm) },
    onSubmit: ({ value }) => {
      void createMutation.mutateAsync(value);
    },
  });

  const orderWorkflows = allWorkflows.filter(
    (workflow) => workflow.scope === "order",
  );
  const workflows = allWorkflows.filter(
    (workflow) => workflow.scope === "item",
  );
  /** The slot is taken by any order workflow, on or off. */
  const orderWorkflowActive = orderWorkflows.length > 0;

  /**
   * `withTags` is per section, not per row: an order workflow can never carry
   * tags (the repository refuses them), so its table has no tags column at
   * all rather than a placeholder in one.
   */
  const renderRow = (workflow: Domain.WorkflowSummary, withTags: boolean) => (
    <s-table-row key={workflow.id} id={workflow.id}>
      <s-table-cell>
        <s-link href={`/app/workflows/${workflow.id}`}>{workflow.name}</s-link>
      </s-table-cell>
      <s-table-cell>{statusBadges(workflow)}</s-table-cell>
      {withTags && (
        <s-table-cell>
          <s-stack direction="inline" gap="small-300">
            {workflow.tags.map((tag) => (
              <s-badge key={tag}>{tag}</s-badge>
            ))}
          </s-stack>
        </s-table-cell>
      )}
      <s-table-cell>{workflow.stepCount}</s-table-cell>
      <s-table-cell>{formatDateTime(workflow.updatedAt)}</s-table-cell>
      <s-table-cell>
        <s-button
          variant="tertiary"
          tone="critical"
          disabled={!identified || deleteMutation.isPending}
          onClick={() => {
            setConfirming(workflow.id);
          }}
        >
          Delete
        </s-button>
      </s-table-cell>
    </s-table-row>
  );

  /** Confirm inline, under the row. */
  const confirmRow = (workflow: Domain.WorkflowSummary, withTags: boolean) => (
    <s-table-row key={`${workflow.id}-confirm`} id={`${workflow.id}-confirm`}>
      <s-table-cell>
        <s-banner tone="critical" heading={`Delete ${workflow.name}?`}>
          <s-stack gap="small-300">
            <s-paragraph>{DELETE_WORKFLOW_WARNING}</s-paragraph>
            <s-stack direction="inline" gap="small-300">
              <s-button
                variant="primary"
                tone="critical"
                disabled={!identified}
                {...(deleteMutation.isPending ? { loading: true } : {})}
                onClick={() => {
                  deleteMutation.mutate({ workflowId: workflow.id });
                }}
              >
                Delete
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      </s-table-cell>
      <s-table-cell> </s-table-cell>
      {withTags && <s-table-cell> </s-table-cell>}
      <s-table-cell> </s-table-cell>
      <s-table-cell> </s-table-cell>
      <s-table-cell> </s-table-cell>
    </s-table-row>
  );

  const renderTable = (
    rows: readonly Domain.WorkflowSummary[],
    withTags: boolean,
  ) => (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Name</s-table-header>
        <s-table-header>Status</s-table-header>
        {withTags && <s-table-header>Product tags</s-table-header>}
        <s-table-header>Steps</s-table-header>
        <s-table-header>Updated</s-table-header>
        <s-table-header> </s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.flatMap((workflow) => [
          renderRow(workflow, withTags),
          ...(confirming === workflow.id
            ? [confirmRow(workflow, withTags)]
            : []),
        ])}
      </s-table-body>
    </s-table>
  );

  const renderWorkflows = () => {
    if (workflows.length === 0)
      return (
        <s-paragraph color="subdued">
          No workflows yet. Create one above, then add the same product tag to
          any product in Shopify and its line items will follow that workflow.
        </s-paragraph>
      );
    return renderTable(workflows, true);
  };

  /**
   * Its own short section above the table rather than a column, so the
   * one-per-shop rule is visible: there is one slot, and it is either filled
   * or empty.
   */
  const renderOrderWorkflow = () => {
    return (
      <s-section heading="Order workflow" accessibilityLabel="Order workflow">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {`${ORDER_WORKFLOW_TRIGGER} Its steps become ready once every item on the order that has a workflow is done. One order workflow per shop.`}
          </s-paragraph>
          {orderWorkflows.length === 0 ? (
            <s-paragraph color="subdued">
              No order workflow yet. Create one above to add steps such as
              packing that happen once per order after every item is made.
            </s-paragraph>
          ) : (
            renderTable(orderWorkflows, false)
          )}
        </s-stack>
      </s-section>
    );
  };

  return (
    <s-page heading="Workflows" inlineSize="large">
      <SocketBanner />

      <s-section heading="Create workflow" accessibilityLabel="Create workflow">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            A workflow is the ordered list of steps a line item passes through,
            each owned by a team. Product tags select it: a line item whose
            product carries any of these tags follows this workflow.
          </s-paragraph>
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <s-stack gap="base">
              <form.Field name="name">
                {(field) => (
                  <s-text-field
                    label="Name"
                    name={field.name}
                    value={field.state.value}
                    error={fieldError(field.state.meta.errors)}
                    onInput={(event) => {
                      field.handleChange(event.currentTarget.value);
                    }}
                    onBlur={field.handleBlur}
                    required
                  />
                )}
              </form.Field>
              <form.Field name="scope">
                {(field) => (
                  <s-choice-list
                    label="This workflow is for"
                    name={field.name}
                    values={[field.state.value]}
                    onChange={(event) => {
                      const [value] = event.currentTarget.values;
                      if (value === "item" || value === "order")
                        field.handleChange(value);
                    }}
                  >
                    <s-choice value="item">Making one item</s-choice>
                    <s-choice value="order" disabled={orderWorkflowActive}>
                      The whole order, after every item is made
                      <s-text slot="details">
                        {orderWorkflowActive
                          ? "This shop already has an order workflow. Delete it to create another."
                          : ORDER_WORKFLOW_TRIGGER}
                      </s-text>
                    </s-choice>
                  </s-choice-list>
                )}
              </form.Field>
              <form.Subscribe selector={(state) => state.values.scope}>
                {(scope) =>
                  scope === "item" && (
                    <form.Field name="tags">
                      {(field) => (
                        <s-text-field
                          label="Product tags"
                          details="Comma-separated. Starts for any item whose product has at least one of these tags. Case doesn't matter."
                          name={field.name}
                          value={field.state.value}
                          onInput={(event) => {
                            field.handleChange(event.currentTarget.value);
                          }}
                          onBlur={field.handleBlur}
                        />
                      )}
                    </form.Field>
                  )
                }
              </form.Subscribe>
              <s-stack alignItems="start">
                <s-button
                  type="submit"
                  variant="primary"
                  disabled={!identified}
                  {...(createMutation.isPending ? { loading: true } : {})}
                >
                  Create workflow
                </s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      {renderOrderWorkflow()}

      <s-section heading="Workflows" accessibilityLabel="Workflows">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Turn a workflow off to stop new runs while open runs finish. Delete
            it and its runs stay on their orders; open ones finish.
          </s-paragraph>
          {renderWorkflows()}
        </s-stack>
      </s-section>
    </s-page>
  );
}

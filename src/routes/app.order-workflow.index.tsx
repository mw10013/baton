import * as React from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError } from "@/lib/form";
import { formatDateTime } from "@/lib/format";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import {
  deleteWorkflowResultMessage,
  DELETE_WORKFLOW_WARNING,
  ORDER_WORKFLOW_TRIGGER,
  workflowResultMessage,
} from "@/lib/workflowShared";

import { statusBadges } from "./app.workflows.index";

const CreateOrderWorkflowForm = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Name is required" })),
});
type CreateOrderWorkflowForm = typeof CreateOrderWorkflowForm.Type;

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

/**
 * Workflow definitions are configuration one person edits, so the read is a
 * loader (the loader-versus-socket rule on `ShopAgentClient`): SSR paint, and
 * `router.invalidate()` after each write. Only the writes use the socket.
 *
 * Order scope only: at most one per shop, never tag-selected.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const workflows = yield* (yield* ShopAgentClient).listWorkflows(
          session.shop,
        );
        return { workflows } satisfies Domain.OrderWorkflowIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/app/order-workflow/")({
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
    mutationFn: ({ name }: CreateOrderWorkflowForm) =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.createWorkflow({
              name,
              scope: "order",
              tags: [],
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
    } satisfies CreateOrderWorkflowForm,
    validators: {
      onSubmit: Schema.toStandardSchemaV1(CreateOrderWorkflowForm),
    },
    onSubmit: ({ value }) => {
      void createMutation.mutateAsync(value);
    },
  });

  const orderWorkflows = allWorkflows.filter(
    (workflow) => workflow.scope === "order",
  );
  /** The slot is taken by any order workflow, on or off. */
  const orderWorkflowExists = orderWorkflows.length > 0;

  const renderRow = (workflow: Domain.WorkflowSummary) => (
    <s-table-row key={workflow.id} id={workflow.id}>
      <s-table-cell>
        <s-link href={`/app/order-workflow/${workflow.id}`}>
          {workflow.name}
        </s-link>
      </s-table-cell>
      <s-table-cell>{statusBadges(workflow)}</s-table-cell>
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
  const confirmRow = (workflow: Domain.WorkflowSummary) => (
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
      <s-table-cell> </s-table-cell>
      <s-table-cell> </s-table-cell>
      <s-table-cell> </s-table-cell>
    </s-table-row>
  );

  const renderTable = (rows: readonly Domain.WorkflowSummary[]) => (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Name</s-table-header>
        <s-table-header>Status</s-table-header>
        <s-table-header>Steps</s-table-header>
        <s-table-header>Updated</s-table-header>
        <s-table-header> </s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.flatMap((workflow) => [
          renderRow(workflow),
          ...(confirming === workflow.id ? [confirmRow(workflow)] : []),
        ])}
      </s-table-body>
    </s-table>
  );

  return (
    <s-page heading="Order workflow" inlineSize="large">
      <SocketBanner />

      <s-section
        heading="Create order workflow"
        accessibilityLabel="Create order workflow"
      >
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {`${ORDER_WORKFLOW_TRIGGER} Its steps become ready once every item on the order that has a workflow is done. One order workflow per shop.`}
          </s-paragraph>
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {orderWorkflowExists ? (
            <s-paragraph color="subdued">
              This shop already has an order workflow. Delete it below to create
              another.
            </s-paragraph>
          ) : (
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
                <s-stack alignItems="start">
                  <s-button
                    type="submit"
                    variant="primary"
                    disabled={!identified}
                    {...(createMutation.isPending ? { loading: true } : {})}
                  >
                    Create order workflow
                  </s-button>
                </s-stack>
              </s-stack>
            </form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Order workflow" accessibilityLabel="Order workflow">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Turn it off to stop new runs while open runs finish. Delete it and
            its runs stay on their orders; open ones finish.
          </s-paragraph>
          {orderWorkflows.length === 0 ? (
            <s-paragraph color="subdued">
              No order workflow yet. Create one above to add steps such as
              packing that happen once per order after every item is made.
            </s-paragraph>
          ) : (
            renderTable(orderWorkflows)
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

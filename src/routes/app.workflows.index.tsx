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

const workflowsSearchSchema = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
});

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
    "A workflow with that name already exists. It may be archived — show archived workflows to restore it, or choose another name.",
  NotFound: () => "That workflow no longer exists.",
  Limit: ({ limit }) =>
    `This shop has reached its limit of ${String(limit)} active workflows.`,
  OrderWorkflowExists: () =>
    "This shop already has an order workflow. Archive it first to create or restore another.",
});

export const ORDER_WORKFLOW_TRIGGER =
  "Starts when every item on an order that has a workflow is done. One order workflow per shop.";

/**
 * Workflow definitions are configuration one person edits, so the read is a
 * loader (the loader-versus-socket rule on `ShopAgentClient`): SSR paint, and
 * `router.invalidate()` after each write. Only the writes use the socket.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(workflowsSearchSchema))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const workflows = yield* (yield* ShopAgentClient).listWorkflows(
          session.shop,
          { includeArchived: data.archived === true },
        );
        return { workflows } satisfies Domain.WorkflowsIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/app/workflows/")({
  validateSearch: Schema.toStandardSchemaV1(workflowsSearchSchema),
  loaderDeps: ({ search }) => ({ archived: search.archived }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

function RouteComponent() {
  const { archived } = Route.useSearch();
  const includeArchived = archived === true;
  const router = useRouter();
  const { workflows: allWorkflows } = Route.useLoaderData();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);

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

  const archiveMutation = useMutation({
    mutationFn: (input: typeof Domain.SetWorkflowArchivedInput.Encoded) =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.setWorkflowArchived(input),
          ).then(decodeWorkflowResult)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    onSuccess: onResult,
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
  const orderWorkflowActive = orderWorkflows.some(
    (workflow) => workflow.archivedAt === null,
  );

  /**
   * `withTags` is per section, not per row: an order workflow can never carry
   * tags (the repository refuses them), so its table has no tags column at
   * all rather than a placeholder in one.
   */
  const renderRow = (workflow: Domain.WorkflowSummary, withTags: boolean) => (
    <s-table-row key={workflow.id} id={workflow.id}>
      <s-table-cell>
        <s-stack direction="inline" gap="small-300">
          <s-link href={`/app/workflows/${workflow.id}`}>
            {workflow.name}
          </s-link>
          {workflow.archivedAt !== null && (
            <s-badge tone="info">Archived</s-badge>
          )}
          {workflow.archivedAt === null && workflow.stepCount === 0 && (
            <s-badge tone="warning">No steps</s-badge>
          )}
        </s-stack>
      </s-table-cell>
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
      <s-table-cell>{workflow.activeRunCount}</s-table-cell>
      <s-table-cell>{formatDateTime(workflow.updatedAt)}</s-table-cell>
      <s-table-cell>
        <s-button
          variant="tertiary"
          disabled={archiveMutation.isPending}
          onClick={() => {
            archiveMutation.mutate({
              workflowId: workflow.id,
              archived: workflow.archivedAt === null,
            });
          }}
        >
          {workflow.archivedAt === null ? "Archive" : "Restore"}
        </s-button>
      </s-table-cell>
    </s-table-row>
  );

  const renderTable = (
    rows: readonly Domain.WorkflowSummary[],
    withTags: boolean,
  ) => (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Name</s-table-header>
        {withTags && <s-table-header>Product tags</s-table-header>}
        <s-table-header>Steps</s-table-header>
        <s-table-header>Active runs</s-table-header>
        <s-table-header>Updated</s-table-header>
        <s-table-header> </s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((workflow) => renderRow(workflow, withTags))}
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
          <s-paragraph color="subdued">{ORDER_WORKFLOW_TRIGGER}</s-paragraph>
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
                          ? "This shop already has an order workflow. Archive it to create another."
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
                          details="Comma-separated. Matching ignores case."
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
          <s-checkbox
            label="Show archived"
            checked={includeArchived}
            onChange={() => {
              void router.navigate({
                to: "/app/workflows",
                search: { archived: includeArchived ? undefined : true },
              });
            }}
          />
          {renderWorkflows()}
        </s-stack>
      </s-section>
    </s-page>
  );
}

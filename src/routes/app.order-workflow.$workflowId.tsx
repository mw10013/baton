import type * as Domain from "@/lib/Domain";

import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { WorkflowDetailPage } from "@/components/WorkflowDetail";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";

const WorkflowParams = Schema.Struct({ workflowId: Schema.String });

/** Loader read for the same reason as the index's `getLoaderData`. */
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

export const Route = createFileRoute("/app/order-workflow/$workflowId")({
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});

/**
 * Order-workflow detail. Item scope lives under `/app/workflows`; an item
 * workflow opened here renders a pointer instead of the editor so the two
 * sections never edit each other's scope.
 */
function RouteComponent() {
  const { workflowId } = Route.useParams();
  const detail: Domain.OrderWorkflowLoaderData = Route.useLoaderData();
  if (detail !== null && detail.workflow.scope !== "order")
    return (
      <s-page heading={detail.workflow.name} inlineSize="base">
        <s-link slot="breadcrumb-actions" href="/app/order-workflow">
          Order workflow
        </s-link>
        <s-paragraph color="subdued">
          This is an item workflow. It lives under Workflows now.
        </s-paragraph>
        <s-link href={`/app/workflows/${workflowId}`}>Open in Workflows</s-link>
      </s-page>
    );
  return (
    <WorkflowDetailPage
      workflowId={workflowId}
      detail={detail}
      backHref="/app/order-workflow"
      backLabel="Order workflow"
      deletedRedirectTo="/app/order-workflow"
    />
  );
}

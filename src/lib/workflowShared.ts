import type * as Domain from "@/lib/Domain";

import { Match } from "effect";

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

/** The order-scope trigger line, in the merchant copy of `Domain.Workflow`; the wait for item runs stays internal. */
export const ORDER_WORKFLOW_TRIGGER = "Starts for every paid order.";

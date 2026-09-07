import { Match } from "effect";

import * as Domain from "@/lib/Domain";

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
 * The order-scope trigger line, in the merchant copy of `Domain.Workflow`.
 * Three sentences because the trigger has three parts a merchant cannot
 * infer from "order workflow": the wait for item runs, the exclusion of
 * orders with no item workflow (a stock-only order never starts it), and
 * the age rule with its manual-attach exception. Every surface that
 * describes the trigger renders this string unmodified so no page states a
 * different rule from another.
 */
export const ORDER_WORKFLOW_TRIGGER =
  "Runs once per paid order, after every item with a workflow is made. An order where no item matches a workflow never starts it. Orders placed before this workflow was created are skipped, unless you attach a workflow to one of their items by hand.";

/**
 * The item-scope trigger line: what has to be true of an order for this
 * workflow to start. Product tags are the whole selector, so a workflow
 * without any never starts and says so.
 */
export const itemTriggerLine = (tags: readonly string[]) => {
  if (tags.length === 0)
    return "No product tags yet, so this never starts. Add one to say which items follow it.";
  const quoted = tags.map((tag) => `“${tag}”`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1) ?? ""}`;
  return `Starts when an order contains a product tagged ${list ?? ""}.`;
};

const stepList = (steps: readonly Domain.StepWithTeamName[]) =>
  steps.map((step) => step.name).join(", ");

/**
 * Why Turn on would be refused, decided from the workflow's own steps — the
 * same facts the object checks — so the button can be disabled with its
 * reason instead of failing after a round trip. An empty team is not a
 * blocker: the run starts and waits for a member.
 */
export const turnOnBlocker = (
  steps: readonly Domain.StepWithTeamName[],
): Domain.ActivateResult | null => {
  if (steps.length === 0) return { _tag: "NoSteps" };
  const orphans = steps.filter(Domain.isUnassigned);
  if (orphans.length > 0)
    return {
      _tag: "StepUnassigned",
      stepNames: orphans.map((step) => step.name),
    };
  return null;
};

/** Why Apply would be refused, from the draft's steps; the same checks on and off. */
export const applyBlocker = (
  steps: readonly Domain.StepWithTeamName[],
): Domain.ApplyResult | null => {
  if (steps.length === 0) return { _tag: "NoSteps" };
  const orphans = steps.filter(Domain.isUnassigned);
  if (orphans.length > 0)
    return {
      _tag: "StepUnassigned",
      stepNames: orphans.map((step) => step.name),
    };
  return null;
};

/**
 * What needs attention about these steps, one sentence each: a step nobody
 * owns, and a step owned by a team nobody is on. Empty when there is nothing
 * to say, so the caller renders no banner at all.
 */
export const attentionLines = (
  steps: readonly Domain.StepWithTeamName[],
): readonly string[] => {
  const orphans = steps.filter(Domain.isUnassigned);
  const empty = steps.filter(Domain.hasEmptyTeam);
  const teamNames = [
    ...new Set(empty.map((step) => step.teamName ?? "").filter(Boolean)),
  ];
  return [
    ...(orphans.length > 0
      ? [`No team on ${stepList(orphans)}. Assign one before you apply.`]
      : []),
    ...(teamNames.length > 0
      ? [
          `Nobody is on ${teamNames.join(", ")}. ${
            empty.length === 1 ? "That step" : "Those steps"
          } will sit unclaimed until someone joins.`,
        ]
      : []),
  ];
};

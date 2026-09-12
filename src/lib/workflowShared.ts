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
  Singleton: () => SINGLETON_MESSAGE,
});

/** The order workflow has a fixed name and is never deleted; the UI never offers either, so this only answers a stale client. */
const SINGLETON_MESSAGE =
  "The order workflow can't be deleted or renamed. Turn it off instead.";

export const deleteWorkflowResultMessage = Match.typeTags<
  Domain.DeleteWorkflowResult,
  string | null
>()({
  Deleted: () => null,
  NotFound: () => "That workflow no longer exists.",
  Singleton: () => SINGLETON_MESSAGE,
});

/**
 * The delete dialog's body, both surfaces. It says nothing about runs
 * because none are lost: a delete removes the definition only, and every run
 * stays on its order (the merchant copy of `Domain.Workflow`).
 */
export const DELETE_WORKFLOW_WARNING = "This can't be undone.";

/**
 * The order-workflow trigger line, in the merchant copy of `Domain.Workflow`.
 * Three sentences because the trigger has three parts a merchant cannot
 * infer from "order workflow": the wait for item runs, the exclusion of
 * orders with no item workflow (a stock-only order never starts it), and
 * the date rule with its manual-attach exception. Every surface that
 * describes the trigger renders this string unmodified so no page states a
 * different rule from another.
 */
export const ORDER_WORKFLOW_TRIGGER =
  "Runs once per paid order, after every item with a workflow is made. An order where no item matches a workflow never starts it. Orders placed before this workflow was turned on are skipped, unless you attach a workflow to one of their items by hand.";

/**
 * The item-workflow trigger line: what has to be true of an order for this
 * workflow to start. The workflow's tag is the whole selector, so a workflow
 * without one never starts and says so. The match sentence speaks from the
 * order's side ("a product tagged"), which is where "product tag" is the
 * right phrase.
 */
export const itemTriggerLine = (tags: readonly string[]) => {
  if (tags.length === 0)
    return "No tag yet, so nothing reaches this workflow. Add one, then put it on your products in Shopify.";
  const quoted = tags.map((tag) => `“${tag}”`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1) ?? ""}`;
  return `Starts when an order contains a product tagged ${list ?? ""}. Orders placed before this workflow was turned on are skipped.`;
};

export const changeActivatedAtResultMessage = Match.typeTags<
  Domain.ChangeActivatedAtResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  Off: () => "This workflow is off, so there is no date to change.",
});

/**
 * The Turn on dialog's second line, present only when there is something to
 * decide: earlier open orders that would match. The count, not the date, is
 * what the merchant decides on.
 */
export const waitingOrdersLine = ({ count }: Domain.WaitingOrders) =>
  count === 0
    ? null
    : `${String(count)} earlier ${count === 1 ? "order is" : "orders are"} unfulfilled and would match.`;

/** The toast after Turn on or Change: names the runs the reconcile-all started, when it started any. */
export const startedToast = (verb: string, started: number) =>
  started === 0
    ? `${verb}.`
    : `${verb}. Started ${String(started)} ${started === 1 ? "run" : "runs"} on waiting orders.`;

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

import { Match } from "effect";

import * as Domain from "@/lib/Domain";

/** `Workflow_name_uidx` is `collate nocase`, so names collide case-insensitively. */
const MAX_NAME_LENGTH = 64;

/**
 * The name the Duplicate dialog offers: `<name> copy`, then `<name> copy 2`,
 * and so on until one is free, with the base trimmed so the result fits
 * `Domain.WorkflowName`. The merchant can overwrite it; prefilling a free one
 * means the dialog does not open on a collision.
 *
 * `taken.length + 1` candidates against `taken.length` taken names always
 * leave one free, so the fallback is unreachable.
 */
export const copyName = (name: string, taken: readonly string[]): string => {
  const used = new Set(taken.map((existing) => existing.toLowerCase()));
  const withSuffix = (suffix: string) =>
    `${name.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const candidates = [
    withSuffix(" copy"),
    ...Array.from({ length: taken.length }, (_, index) =>
      withSuffix(` copy ${String(index + 2)}`),
    ),
  ];
  return (
    candidates.find((candidate) => !used.has(candidate.toLowerCase())) ??
    withSuffix(` copy ${String(taken.length + 2)}`)
  );
};

/**
 * `TagTaken`, reported under the tag field at Create, Duplicate, and Edit tag
 * — the three places the merchant types one. It names the holder so they can
 * decide whether to change this tag or go retag the other workflow. Curly
 * quotes around the tag, matching {@link itemTriggerLine}.
 */
export const tagTakenMessage = ({
  tag,
  workflowName,
}: {
  readonly tag: string;
  readonly workflowName: string;
}) => `\u201C${tag}\u201D is already ${workflowName}'s tag. Choose another.`;

export const workflowResultMessage = Match.typeTags<
  Domain.WorkflowResult,
  string | null
>()({
  Ok: () => null,
  NameTaken: () =>
    "A workflow with that name already exists. Choose another name.",
  TagTaken: tagTakenMessage,
  NotFound: () => "That workflow no longer exists.",
  Limit: ({ limit }) =>
    `This shop has reached its limit of ${String(limit)} workflows.`,
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
 * The trigger line: what has to be true of an order for this workflow to
 * start. Every workflow has exactly one tag, so there is no empty case. The
 * match sentence speaks from the order's side ("a product tagged"), which is
 * where "product tag" is the right phrase.
 */
export const itemTriggerLine = (tag: string) =>
  `Starts when an order contains a product tagged \u201C${tag}\u201D. Orders placed before this workflow was turned on are skipped.`;

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

/** The `startedToast` verb for Turn off, shared so the fork below stays in step with the caller. */
export const TURNED_OFF = "Turned off";

/**
 * The toast after Turn on, Turn off or Change: names the runs the reconcile-all
 * started, when it started any.
 *
 * Turn **off** can start runs too, which is why the sentence does not say
 * "waiting orders": an item matched by two active workflows carries no run, so
 * taking one of them away leaves a single match and the survivor begins. That
 * is the same number in a different story, so the copy forks on the verb.
 */
export const startedToast = (verb: string, started: number) => {
  if (started === 0) return `${verb}.`;
  const orders = `${String(started)} ${started === 1 ? "order" : "orders"}`;
  return verb === TURNED_OFF
    ? `${verb}. ${orders} moved to the workflow that still matches.`
    : `${verb}. Started ${String(started)} ${started === 1 ? "run" : "runs"} on waiting orders.`;
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

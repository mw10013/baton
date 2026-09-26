import { Match } from "effect";

import * as Domain from "@/lib/Domain";

/**
 * The Duplicate dialog's prefilled name. Names may repeat, so there is no
 * search for a free one: `<name> copy`, with the base trimmed so the result
 * still fits `Domain.WorkflowName`.
 */
export const copyName = (name: string): string => {
  const suffix = " copy";
  return `${name.slice(0, Domain.NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
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
 * A workflow that has never been applied has no tasks of its own: Apply is the
 * only writer of `WorkflowTask`, and a fresh workflow starts with none (the
 * JSDoc on `Domain.Workflow`). Zero tasks after the first Apply is impossible,
 * since Apply refuses an empty draft (`NoTasksError`). So "no tasks" and
 * "never applied" are the same fact, and the editor can offer Turn on instead
 * of Apply on the strength of it.
 */
export const neverApplied = (detail: {
  readonly tasks: readonly unknown[];
}): boolean => detail.tasks.length === 0;

/**
 * Every dialog string the detail page and the editor both show, in one place
 * so the two surfaces cannot drift apart. Sentence case throughout, and the
 * dismiss verb is `Cancel` everywhere.
 */
export const APPLY_HEADING = "Apply changes?";
export const APPLY_BODY =
  "This workflow is turned on. Once you apply changes, they'll take effect immediately. Items already on it keep the tasks they started with.";
export const DISCARD_HEADING = "Discard changes?";
export const DISCARD_BODY = "Are you sure you want to discard these changes?";
export const TURN_OFF_HEADING = "Turn off workflow?";
export const TURN_OFF_BODY =
  "New orders won't start this workflow. Items already on it keep going.";
export const RENAME_HEADING = "Rename workflow";
export const RENAME_FIELD_LABEL = "New name";
export const RENAMED_TOAST = "Workflow renamed";
export const DELETED_TOAST = "Workflow deleted";

/**
 * The delete dialog's body, both surfaces. It names what survives rather than
 * only what goes: a delete removes the definition, its tasks and its draft,
 * and every run stays on its order (the merchant copy of `Domain.Workflow`).
 */
export const DELETE_WORKFLOW_WARNING =
  "This workflow will be permanently deleted. Items already on it keep their tasks.";

/**
 * The trigger line: what has to be true of an order for this workflow to
 * start. Every workflow has exactly one tag, so there is no empty case. The
 * match sentence speaks from the order's side ("a product tagged"), which is
 * where "product tag" is the right phrase.
 */
export const itemTriggerLine = (tag: string) =>
  `Starts when an order contains a product tagged \u201C${tag}\u201D. Orders placed before this workflow was turned on are skipped.`;

/** The Turn on dialog's first line, both surfaces: the rule that will start runs once the switch is on. */
export const turnOnBody = (tag: string) =>
  `Every order placed from now with an item tagged \u201C${tag}\u201D will start this workflow on that item.`;

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
 * The toast after Turn on, Turn off or Change: counts the runs the
 * reconcile-all started, when it started any. The screen has no word for a
 * run, so the count is of items, qualified by their orders as the glossary
 * asks ("items on waiting orders").
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
    : `${verb}. Attached to ${String(started)} ${started === 1 ? "item" : "items"} on waiting orders.`;
};

const taskList = (tasks: readonly Domain.TaskWithTeamName[]) =>
  tasks.map((task) => task.name).join(", ");

/**
 * Why Turn on would be refused, decided from the workflow's own tasks — the
 * same facts the object checks — so the button can be disabled with its
 * reason instead of failing after a round trip. An empty team is not a
 * blocker: the run starts and waits for a member.
 */
export const turnOnBlocker = (
  tasks: readonly Domain.TaskWithTeamName[],
): Domain.ActivateResult | null => {
  if (tasks.length === 0) return { _tag: "NoTasks" };
  const orphans = tasks.filter(Domain.isUnassigned);
  if (orphans.length > 0)
    return {
      _tag: "TaskUnassigned",
      taskNames: orphans.map((task) => task.name),
    };
  return null;
};

/** Why Apply would be refused, from the draft's tasks; the same checks on and off. */
export const applyBlocker = (
  tasks: readonly Domain.TaskWithTeamName[],
): Domain.ApplyResult | null => {
  if (tasks.length === 0) return { _tag: "NoTasks" };
  const orphans = tasks.filter(Domain.isUnassigned);
  if (orphans.length > 0)
    return {
      _tag: "TaskUnassigned",
      taskNames: orphans.map((task) => task.name),
    };
  return null;
};

/**
 * What needs attention about these tasks, one sentence each: a task nobody
 * owns, and a task owned by a team nobody is on. Empty when there is nothing
 * to say, so the caller renders no banner at all.
 */
export const attentionLines = (
  tasks: readonly Domain.TaskWithTeamName[],
): readonly string[] => {
  const orphans = tasks.filter(Domain.isUnassigned);
  const empty = tasks.filter(Domain.hasEmptyTeam);
  const teamNames = [
    ...new Set(empty.map((task) => task.teamName ?? "").filter(Boolean)),
  ];
  return [
    ...(orphans.length > 0
      ? [`No team on ${taskList(orphans)}. Assign one before you apply.`]
      : []),
    ...(teamNames.length > 0
      ? [
          `Nobody is on ${teamNames.join(", ")}. ${
            empty.length === 1 ? "That task" : "Those tasks"
          } will wait until a member joins.`,
        ]
      : []),
  ];
};

import { Match } from "effect";

import * as Domain from "@/lib/Domain";

/**
 * The Duplicate dialog's prefilled name: `<name> copy`, with the base trimmed
 * so the result still fits `Domain.WorkflowName`. There is no search for a
 * free one; if a second copy collides, `NameTaken` lands under the name field
 * and the merchant picks another.
 */
export const copyName = (name: string): string => {
  const suffix = " copy";
  return `${name.slice(0, Domain.NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
};

/**
 * `NameTaken`, reported under the name field at Create, Duplicate, and
 * Rename. Worded like the team dialog's refusal.
 */
export const nameTakenMessage = () =>
  "A workflow with that name already exists.";

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
  NameTaken: nameTakenMessage,
  TagTaken: tagTakenMessage,
  NotFound: () => "That workflow no longer exists.",
  Limit: ({ limit }) =>
    `A shop can have ${String(limit)} workflows. Delete one to add another.`,
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
 * only editor write that lands on `Workflow.tasks` (a team delete nulls a
 * pointer in it and Duplicate copies it, neither adds a task), and a fresh
 * workflow starts with none (the JSDoc on `Domain.Workflow`). Zero tasks after the first Apply is impossible,
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
  "This workflow is on, so the changes take effect now. Items already on it keep the tasks they started with.";
export const DISCARD_HEADING = "Discard changes?";
export const DISCARD_BODY = "Your unsaved changes will be lost.";
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
 * where "product tag" is the right phrase. "Starts" is the screen's word on
 * purpose: the vocabulary says a workflow creates a run and only a member
 * starts a task, but the merchant reads the workflow as the thing that
 * begins, so the copy keeps the plain verb.
 */
export const itemTriggerLine = (tag: string) =>
  `Starts when an order contains a product tagged \u201C${tag}\u201D.`;

/** The Turn on dialog's first line, both surfaces: the rule that will create runs once the switch is on. */
export const turnOnBody = (tag: string) =>
  `Every open order with an item tagged \u201C${tag}\u201D starts this workflow on that item.`;

/** The toast verb after Turn off. */
export const TURNED_OFF = "Turned off";

const taskList = (tasks: readonly Domain.TaskWithTeamName[]) =>
  tasks.map((task) => task.name).join(", ");

/**
 * Why Turn on would be refused, decided from the workflow's own tasks — the
 * same facts the object checks — so the button can be disabled with its
 * reason instead of failing after a round trip. An empty team is not a
 * blocker: the run is created and waits for a member.
 */
export const turnOnBlocker = (
  tasks: readonly Domain.TaskWithTeamName[],
): Domain.SwitchResult | null => {
  if (tasks.length === 0) return { _tag: "NoTasks" };
  const orphans = tasks.filter(Domain.workflowTaskIsUnassigned);
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
  const orphans = tasks.filter(Domain.workflowTaskIsUnassigned);
  if (orphans.length > 0)
    return {
      _tag: "TaskUnassigned",
      taskNames: orphans.map((task) => task.name),
    };
  return null;
};

/**
 * The `team` issue's sentence for a workflow page banner: the tasks nobody
 * owns. `null` when every task has a team, so the caller renders no banner.
 */
export const unassignedLine = (
  tasks: readonly Domain.TaskWithTeamName[],
): string | null => {
  const orphans = tasks.filter(Domain.workflowTaskIsUnassigned);
  return orphans.length > 0
    ? `No team on ${taskList(orphans)}. Assign one before you apply.`
    : null;
};

/**
 * The `empty_team` fault's sentence for a workflow page banner: the teams
 * nobody is on. `null` when every assigned team has a member.
 */
export const emptyTeamLine = (
  tasks: readonly Domain.TaskWithTeamName[],
): string | null => {
  const empty = tasks.filter(Domain.hasEmptyTeam);
  const teamNames = [
    ...new Set(empty.map((task) => task.teamName ?? "").filter(Boolean)),
  ];
  return teamNames.length > 0
    ? `Nobody is on ${teamNames.join(", ")}. ${
        empty.length === 1 ? "That task" : "Those tasks"
      } will wait until a member joins.`
    : null;
};

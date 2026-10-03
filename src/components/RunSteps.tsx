import * as React from "react";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

/** What a step card needs of a task: the row itself and the `current` flag ({@link Domain.currentTasks}). */
export type RunStepTask = Domain.RunTask & { readonly current: boolean };

/** Each state's badge tone; the label is `Domain.TASK_STATE_LABEL`, and a waiting task has none. */
const BADGE_TONE = {
  ready: "info",
  started: "success",
  done: "neutral",
} as const;

/**
 * A task's badge and the subdued line under it, in the order a worker asks:
 * done, under way, ready, waiting. The state is {@link Domain.taskStateOf}.
 *
 * **The badge states the task's state and the line never repeats it.** The
 * line is the team, then who and when — "Jewelry · lead@m.com · Sep 21, 3:52
 * AM" under a `Done` badge. Saying "Done by" as well would print the badge's
 * word twice, a stride apart, in every state that has a badge. A waiting task
 * has no badge and its line is the team alone.
 */
const taskState = (
  task: RunStepTask,
): {
  readonly text: React.ReactNode;
  readonly badge: {
    readonly label: string;
    readonly tone: "neutral" | "success" | "info";
  } | null;
} => {
  const state = Domain.taskStateOf(task);
  const badge =
    state === "waiting"
      ? null
      : { label: Domain.TASK_STATE_LABEL[state], tone: BADGE_TONE[state] };
  const doneBy = Domain.taskDoneBy(task);
  const startedBy = Domain.taskStartedBy(task);
  if (state === "done")
    return {
      badge,
      text: (
        <>
          {doneBy === null
            ? `${task.teamName} · `
            : `${task.teamName} · ${Domain.actorLabel(doneBy)} · `}
          <LocalDateTime value={task.doneAt ?? 0} />
        </>
      ),
    };
  if (state === "started")
    return {
      badge,
      text: (
        <>
          {startedBy === null
            ? `${task.teamName} · since `
            : `${task.teamName} · ${Domain.actorLabel(startedBy)} · since `}
          <LocalDateTime value={task.startedAt ?? 0} format="time" />
        </>
      ),
    };
  return { badge, text: task.teamName };
};

/**
 * A run's tasks as step cards: the one shape the member's workflow page and the
 * merchant's Manage drawer both draw, so a worker and a merchant looking at
 * the same run see the same thing. The rules both pages agree on:
 *
 * - **One caption and one box per step.** A subdued `Step n` caption over a
 *   bordered box; parallel tasks share the box, separated by rules the way the
 *   workflows list separates rows, so a step reads as one stop before the caption is
 *   read. A single-task step is a caption over one row. The steps are an
 *   ordered list, which is what they are.
 * - **The badge states the task's state and the line never repeats it** (see
 *   `taskState`).
 * - **The team leads the subdued line** under the task name rather than
 *   sitting beside it: task and team names are both merchant text, and side
 *   by side with only a weight between them "Cast Jewelry" reads as one noun
 *   phrase. Each has its own line, so a long name wraps without colliding
 *   with anything.
 * - **A waiting task has no badge and its line is the team alone**: its place
 *   under a later `Step n` caption already says what it waits on.
 *
 * The buttons are each page's own and arrive through `renderActions`, which
 * returns the button row's contents or null for no row.
 *
 * `showInstructions` is a prop because the two pages differ on it: the worker
 * reads a task's instructions here, at the bench, while the merchant wrote
 * them and reads them on the merchant's workflow page, so the Manage drawer leaves them
 * out rather than repeat the definition under every run.
 */
export function RunSteps<T extends RunStepTask>({
  tasks,
  showInstructions,
  renderActions,
}: {
  readonly tasks: readonly T[];
  readonly showInstructions: boolean;
  readonly renderActions: (task: T) => React.ReactElement | null;
}) {
  const renderTask = (task: T, first: boolean) => {
    const state = taskState(task);
    const actions = renderActions(task);
    return (
      <s-box
        key={task.id}
        padding="small"
        borderWidth={first ? "none" : "base none none none"}
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">{task.name}</s-text>
            {state.badge !== null && (
              <s-badge tone={state.badge.tone}>{state.badge.label}</s-badge>
            )}
          </s-stack>
          <s-text color="subdued">{state.text}</s-text>
          {showInstructions && task.instructions !== null && (
            <s-text>{task.instructions}</s-text>
          )}
          {actions !== null && (
            <s-stack direction="inline" gap="base" alignItems="center">
              {actions}
            </s-stack>
          )}
        </s-stack>
      </s-box>
    );
  };
  return (
    <s-stack accessibilityRole="ordered-list" gap="base">
      {WorkflowLayout.stepsOf(tasks).map((group) => {
        const step = group[0]?.step ?? 0;
        return (
          <s-stack key={step} accessibilityRole="list-item" gap="small-300">
            <s-text color="subdued">{`Step ${String(step)}`}</s-text>
            <s-box borderWidth="base" borderRadius="base">
              {group.map((task, index) => renderTask(task, index === 0))}
            </s-box>
          </s-stack>
        );
      })}
    </s-stack>
  );
}

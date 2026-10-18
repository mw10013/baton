import type { ReactElement, ReactNode } from "react";
import type { ConnectionRole } from "../../domain/platform.ts";
import {
  actorLabel,
  type RunTask,
  TASK_STATE_LABEL,
  type TaskState,
  taskDoneBy,
  taskStartedBy,
  taskStateOf,
} from "../../domain/shop-work.ts";
import { stepsOf } from "../../domain/workflow-layout.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { Prose } from "./screen/Prose.tsx";
import { StepList } from "./screen/StepList.tsx";

/** What a step card needs of a task: the row itself and the `current` flag (`currentTasks`). */
export type RunStepTask = RunTask & { readonly current: boolean };

/** Each state's badge tone; the label is {@link TASK_STATE_LABEL}, and a waiting task has none. */
const BADGE_TONE = {
  ready: "info",
  started: "success",
  done: "neutral",
} as const satisfies Record<Exclude<TaskState, "waiting">, string>;

/**
 * A task's badge and the subdued line under it, in the order a worker asks: done, under way,
 * ready, waiting. The state is {@link taskStateOf}.
 *
 * **The badge states the task's state and the line never repeats it.** The line is the team,
 * then who and when: "Jewelry · lead@m.com · Sep 21, 3:52 AM" under a `Done` badge. Saying "Done
 * by" as well would print the badge's word twice, a stride apart, in every state that has a
 * badge. A waiting task has no badge and its line is the team alone.
 */
const taskState = (
  task: RunStepTask,
  viewer: ConnectionRole,
): {
  readonly text: ReactNode;
  readonly badge: {
    readonly label: string;
    readonly tone: (typeof BADGE_TONE)[keyof typeof BADGE_TONE];
  } | null;
} => {
  const state = taskStateOf(task);
  const badge =
    state === "waiting" ? null : { label: TASK_STATE_LABEL[state], tone: BADGE_TONE[state] };
  if (state === "done") {
    const doneBy = taskDoneBy(task);
    return {
      badge,
      text: (
        <>
          {doneBy === null
            ? `${task.teamName} · `
            : `${task.teamName} · ${actorLabel(doneBy, viewer)} · `}
          <LocalDateTime value={task.doneAt ?? 0} />
        </>
      ),
    };
  }
  if (state === "started") {
    const startedBy = taskStartedBy(task);
    return {
      badge,
      text: (
        <>
          {startedBy === null
            ? `${task.teamName} · since `
            : `${task.teamName} · ${actorLabel(startedBy, viewer)} · since `}
          <LocalDateTime value={task.startedAt ?? 0} format="time" />
        </>
      ),
    };
  }
  return { badge, text: task.teamName };
};

/**
 * A run's tasks as step cards: the one shape the member's workflow page and the merchant's Manage
 * drawer both draw, so a worker and a merchant looking at the same run see the same thing. The
 * rules both pages agree on:
 *
 * - **One caption and one box per step** ({@link StepList}): parallel tasks share the box,
 *   separated by rules. A single-task step is a caption over one row.
 * - **The badge states the task's state and the line never repeats it** (see `taskState`).
 * - **The team leads the subdued line** under the task name rather than sitting beside it: task
 *   and team names are both merchant text, and side by side with only a weight between them "Cast
 *   Jewelry" reads as one noun phrase. Each has its own line, so a long name wraps without
 *   colliding with anything.
 * - **A waiting task has no badge and its line is the team alone**: its place under a later
 *   `Step n` caption already says what it waits on.
 *
 * The buttons are each page's own and arrive through `renderActions`, which returns the button
 * row's contents or null for no row.
 *
 * `showInstructions` is a prop because the two pages differ on it: the worker reads a task's
 * instructions here, at the bench, as typed ({@link Prose}), while the merchant wrote them and
 * reads them on the merchant's workflow page, so the Manage drawer leaves them out rather than
 * repeat the definition under every run.
 */
export function RunSteps<T extends RunStepTask>({
  tasks,
  viewer,
  showInstructions,
  renderActions,
}: {
  readonly tasks: readonly T[];
  /** Who is looking, for who started or did each task ({@link actorLabel}). */
  readonly viewer: ConnectionRole;
  readonly showInstructions: boolean;
  readonly renderActions: (task: T) => ReactElement | null;
}) {
  const renderTask = (task: T) => {
    const state = taskState(task, viewer);
    const actions = renderActions(task);
    return (
      <Lines key={task.id}>
        <Inline>
          <s-heading>{task.name}</s-heading>
          {state.badge !== null && <s-badge tone={state.badge.tone}>{state.badge.label}</s-badge>}
        </Inline>
        <s-text color="subdued">{state.text}</s-text>
        {showInstructions && task.instructions !== null && <Prose>{task.instructions}</Prose>}
        {actions !== null && <Inline>{actions}</Inline>}
      </Lines>
    );
  };
  return (
    <StepList
      steps={stepsOf(tasks).map((group) => {
        const step = group[0]?.step ?? 0;
        return { key: step, caption: `Step ${String(step)}`, entries: group.map(renderTask) };
      })}
    />
  );
}

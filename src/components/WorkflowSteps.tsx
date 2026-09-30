import type * as React from "react";

import * as Domain from "@/lib/Domain";
import * as WorkflowLayout from "@/lib/WorkflowLayout";
import { emptyTeamLine, unassignedLine } from "@/lib/workflowShared";

/**
 * The tasks of an item workflow drawn as the merchant reads them: top to
 * bottom, one block per step, each a subdued `Step n` label with the step's
 * tasks under it ({@link Domain.WorkflowTask}). No box and no "at once"
 * caption: the label and the single arrow between steps already say where a
 * run waits.
 *
 * Shared by the read-only detail page and the editor; `onSelectTask` is what
 * separates them.
 */

/**
 * The team under a task name, or "No team" in its place: a fact, not an
 * alarm. No badge for an unassigned task or an empty team here, because
 * {@link TeamIssueBanners} above the steps already raises each issue under
 * its label and names the task or team, and a second red mark on the same
 * page for one fault reads as two.
 */
export function TeamLine({ task }: { readonly task: Domain.TaskWithTeamName }) {
  return (
    <s-text color="subdued">
      {Domain.workflowTaskIsUnassigned(task) ? "No team" : task.teamName}
    </s-text>
  );
}

function TaskBody({ task }: { readonly task: Domain.TaskWithTeamName }) {
  return (
    <s-stack gap="small-500">
      <s-text type="strong">{task.name}</s-text>
      <TeamLine task={task} />
      {task.instructions !== null && (
        <s-text color="subdued">{task.instructions}</s-text>
      )}
    </s-stack>
  );
}

/**
 * One task. Clickable in the editor, where selecting it opens the task panel;
 * a plain box on the detail page, where there is nothing to select.
 */
function TaskCard({
  task,
  selected,
  onSelect,
}: {
  readonly task: Domain.TaskWithTeamName;
  readonly selected: boolean;
  readonly onSelect?: (taskId: string) => void;
}) {
  if (onSelect === undefined)
    return (
      <s-box padding="base" border="base base solid" borderRadius="base">
        <TaskBody task={task} />
      </s-box>
    );
  return (
    <s-clickable
      padding="base"
      border={selected ? "base strong solid" : "base base solid"}
      borderRadius="base"
      background={selected ? "subdued" : "base"}
      accessibilityLabel={`Edit ${task.name}`}
      aria-pressed={selected}
      onClick={() => {
        onSelect(task.id);
      }}
    >
      <TaskBody task={task} />
    </s-clickable>
  );
}

function Connector() {
  return (
    <s-stack direction="inline" justifyContent="center">
      <s-icon type="arrow-down" color="subdued" size="small" />
    </s-stack>
  );
}

export function StepFlow({
  tasks,
  trigger,
  selectedTaskId = null,
  onSelectTask,
  renderStepFooter,
  footer,
}: {
  readonly tasks: readonly Domain.TaskWithTeamName[];
  /** The card above the first step: what creates a run. Omitted by the
      editor, which edits tasks and shows no read-only trigger. */
  readonly trigger?: React.ReactNode;
  readonly selectedTaskId?: string | null;
  readonly onSelectTask?: (taskId: string) => void;
  /** The editor's "Add task" control, keyed by the step it adds to. */
  readonly renderStepFooter?: (step: number) => React.ReactNode;
  readonly footer?: React.ReactNode;
}) {
  const groups = WorkflowLayout.stepsOf(tasks);
  return (
    <s-stack gap="small-300">
      {trigger}
      {groups.map((group, index) => {
        const step = group[0]?.step ?? index + 1;
        return (
          <s-stack key={step} gap="small-300">
            {(trigger !== undefined || index > 0) && <Connector />}
            <s-text color="subdued">{`Step ${String(index + 1)}`}</s-text>
            {group.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                selected={selectedTaskId === task.id}
                {...(onSelectTask === undefined
                  ? {}
                  : { onSelect: onSelectTask })}
              />
            ))}
            {renderStepFooter?.(step)}
          </s-stack>
        );
      })}
      {footer !== undefined && (
        <s-stack gap="small-300">
          {groups.length > 0 && <Connector />}
          {footer}
        </s-stack>
      )}
    </s-stack>
  );
}

/**
 * One banner per team issue a workflow carries, the `team` and `empty_team`
 * {@link Domain.OrderIssue}s, headed by the issue's label and toned
 * {@link Domain.ORDER_ISSUE_TONE} so a fault reads the same here as on the
 * indexes. Nothing when the workflow has neither. Two banners rather than one
 * because the faults have different remedies, and one heading over both
 * would name neither.
 */
export function TeamIssueBanners({
  tasks,
}: {
  readonly tasks: readonly Domain.TaskWithTeamName[];
}) {
  const banners = [
    { issue: "unassigned" as const, line: unassignedLine(tasks) },
    { issue: "empty_team" as const, line: emptyTeamLine(tasks) },
  ];
  return (
    <>
      {banners.map(({ issue, line }) =>
        line === null ? null : (
          <s-banner
            key={issue}
            tone={Domain.ORDER_ISSUE_TONE}
            heading={Domain.ORDER_ISSUE_LABEL[issue]}
          >
            {/* An element, not a bare string: `s-banner` renders its body
                from elements, and a bare string child never reaches the page. */}
            <s-text>{line}</s-text>
          </s-banner>
        ),
      )}
    </>
  );
}

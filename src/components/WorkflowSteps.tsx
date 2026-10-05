import type * as React from "react";

import { Connector } from "@/components/screen/Connector";
import { Lines } from "@/components/screen/Lines";
import { Panel } from "@/components/screen/Panel";
import { Prose } from "@/components/screen/Prose";
import { SelectableCard } from "@/components/screen/SelectableCard";
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
 * {@link TeamFaultBanners} above the steps already raises each issue under
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
    <Lines>
      <s-heading>{task.name}</s-heading>
      <TeamLine task={task} />
      {task.instructions !== null && (
        <Prose color="subdued">{task.instructions}</Prose>
      )}
    </Lines>
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
      <Panel kind="card">
        <TaskBody task={task} />
      </Panel>
    );
  return (
    <SelectableCard
      selected={selected}
      accessibilityLabel={`Edit ${task.name}`}
      onSelect={() => {
        onSelect(task.id);
      }}
    >
      <TaskBody task={task} />
    </SelectableCard>
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
    <Lines>
      {trigger}
      {groups.map((group, index) => {
        const step = group[0]?.step ?? index + 1;
        return (
          <Lines key={step}>
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
          </Lines>
        );
      })}
      {footer !== undefined && (
        <Lines>
          {groups.length > 0 && <Connector />}
          {footer}
        </Lines>
      )}
    </Lines>
  );
}

/**
 * One banner per {@link Domain.WorkflowFault} a workflow carries, headed by
 * the fault's label ({@link Domain.WORKFLOW_FAULT_LABEL}) and toned
 * {@link Domain.ORDER_ISSUE_TONE} so a fault reads the same here as on the
 * workflows index. Nothing when the workflow has neither. Two banners rather than one
 * because the faults have different remedies, and one heading over both
 * would name neither.
 */
export function TeamFaultBanners({
  tasks,
}: {
  readonly tasks: readonly Domain.TaskWithTeamName[];
}) {
  const banners = [
    { fault: "unassigned" as const, line: unassignedLine(tasks) },
    { fault: "empty_team" as const, line: emptyTeamLine(tasks) },
  ];
  return (
    <>
      {banners.map(({ fault, line }) =>
        line === null ? null : (
          <s-banner
            key={fault}
            tone={Domain.ORDER_ISSUE_TONE}
            heading={Domain.WORKFLOW_FAULT_LABEL[fault]}
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

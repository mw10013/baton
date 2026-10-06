import type * as React from "react";

import { Connector } from "@/components/screen/Connector";
import { Inline } from "@/components/screen/Inline";
import { Lines } from "@/components/screen/Lines";
import { Panel } from "@/components/screen/Panel";
import { Prose } from "@/components/screen/Prose";
import { SelectableCard } from "@/components/screen/SelectableCard";
import * as Domain from "@/lib/Domain";
import * as WorkflowLayout from "@/lib/WorkflowLayout";
import { unassignedLine } from "@/lib/workflowShared";

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
 * alarm. One mark per fault on the page: an unassigned task is
 * {@link TeamFaultBanners}' to raise, because it disables Apply and Turn on,
 * so there is no badge for it here; an empty team disables nothing, so it is
 * a badge beside the team's name and no banner (the controls table's "a fact
 * about the page that disables things" row on `Control`). The badge's word
 * is the teams index's, "No members"; the workflows index's badge for the
 * same fault reads {@link Domain.WORKFLOW_FAULT_LABEL} because it has no
 * team name beside it.
 */
export function TeamLine({ task }: { readonly task: Domain.TaskWithTeamName }) {
  return (
    <Inline>
      <s-text color="subdued">
        {Domain.workflowTaskIsUnassigned(task) ? "No team" : task.teamName}
      </s-text>
      {Domain.hasEmptyTeam(task) && (
        <s-badge tone="warning">No members</s-badge>
      )}
    </Inline>
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
 * The one banner a workflow page raises: the `unassigned`
 * {@link Domain.WorkflowFault}, headed by its label
 * ({@link Domain.WORKFLOW_FAULT_LABEL}) and toned
 * {@link Domain.ORDER_ISSUE_TONE} so it reads the same here as on the
 * workflows index. A banner because it disables Apply and Turn on; the
 * `empty_team` fault disables nothing and is a badge on the step
 * ({@link TeamLine}). Nothing when every task has a team.
 */
export function TeamFaultBanners({
  tasks,
}: {
  readonly tasks: readonly Domain.TaskWithTeamName[];
}) {
  const line = unassignedLine(tasks);
  if (line === null) return null;
  return (
    <s-banner
      tone={Domain.ORDER_ISSUE_TONE}
      heading={Domain.WORKFLOW_FAULT_LABEL.unassigned}
    >
      {/* An element, not a bare string: `s-banner` renders its body
          from elements, and a bare string child never reaches the page. */}
      <s-text>{line}</s-text>
    </s-banner>
  );
}

import type * as React from "react";

import * as Domain from "@/lib/Domain";
import * as WorkflowLayout from "@/lib/WorkflowLayout";
import { attentionLines } from "@/lib/workflowShared";

/**
 * The steps of an item workflow drawn as the merchant reads them: top to
 * bottom, one block per stage, with the steps that run at the same time
 * inside one dashed block. The stage number is a fact about the run — the
 * next stage waits for every step of this one — so it is drawn rather than
 * left as a column of numbers to decode.
 *
 * Shared by the read-only detail page and the editor; `onSelectStep` is what
 * separates them. The order workflow draws the same way: its steps, stages
 * and teams are the same shape, and only the `trigger` node differs.
 */

/** The team under a step name, or the attention state standing in its place. */
export function TeamLine({ step }: { readonly step: Domain.StepWithTeamName }) {
  if (Domain.isUnassigned(step))
    return <s-badge tone="critical">Unassigned</s-badge>;
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      <s-text color="subdued">{step.teamName}</s-text>
      {Domain.hasEmptyTeam(step) && (
        <s-badge tone="warning">No members</s-badge>
      )}
    </s-stack>
  );
}

function StepBody({ step }: { readonly step: Domain.StepWithTeamName }) {
  return (
    <s-stack gap="small-500">
      <s-text type="strong">{step.name}</s-text>
      <TeamLine step={step} />
      {step.instructions !== null && (
        <s-text color="subdued">{step.instructions}</s-text>
      )}
    </s-stack>
  );
}

/**
 * One step. Clickable in the editor, where selecting it opens the step panel;
 * a plain box on the detail page, where there is nothing to select.
 */
function StepCard({
  step,
  selected,
  onSelect,
}: {
  readonly step: Domain.StepWithTeamName;
  readonly selected: boolean;
  readonly onSelect?: (stepId: string) => void;
}) {
  if (onSelect === undefined)
    return (
      <s-box padding="base" border="base base solid" borderRadius="base">
        <StepBody step={step} />
      </s-box>
    );
  return (
    <s-clickable
      padding="base"
      border={selected ? "base strong solid" : "base base solid"}
      borderRadius="base"
      background={selected ? "subdued" : "base"}
      accessibilityLabel={`Edit ${step.name}`}
      aria-pressed={selected}
      onClick={() => {
        onSelect(step.id);
      }}
    >
      <StepBody step={step} />
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

export function StageFlow({
  steps,
  trigger,
  selectedStepId = null,
  onSelectStep,
  renderStageFooter,
  footer,
}: {
  readonly steps: readonly Domain.StepWithTeamName[];
  /** The card above the first stage: what starts a run. */
  readonly trigger: React.ReactNode;
  readonly selectedStepId?: string | null;
  readonly onSelectStep?: (stepId: string) => void;
  /** The editor's "at the same time" control, keyed by the stage it adds to. */
  readonly renderStageFooter?: (stage: number) => React.ReactNode;
  readonly footer?: React.ReactNode;
}) {
  const groups = WorkflowLayout.stagesOf(steps);
  return (
    <s-stack gap="small-300">
      {trigger}
      {groups.map((group, index) => {
        const parallel = group.length > 1;
        const stage = group[0]?.stage ?? index + 1;
        return (
          <s-stack key={stage} gap="small-300">
            <Connector />
            <s-box
              padding={parallel ? "small-300" : "none"}
              border={parallel ? "base subdued dashed" : "none"}
              borderRadius="base"
            >
              <s-stack gap="small-300">
                <s-text color="subdued">
                  {parallel
                    ? `Stage ${String(index + 1)} · at the same time`
                    : `Stage ${String(index + 1)}`}
                </s-text>
                {group.map((step) => (
                  <StepCard
                    key={step.id}
                    step={step}
                    selected={selectedStepId === step.id}
                    {...(onSelectStep === undefined
                      ? {}
                      : { onSelect: onSelectStep })}
                  />
                ))}
                {renderStageFooter?.(stage)}
              </s-stack>
            </s-box>
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

/** The unassigned-step and empty-team warnings, or nothing when there is nothing to say. */
export function AttentionBanner({
  steps,
}: {
  readonly steps: readonly Domain.StepWithTeamName[];
}) {
  const lines = attentionLines(steps);
  if (lines.length === 0) return null;
  return (
    <s-banner
      tone={steps.some(Domain.isUnassigned) ? "critical" : "warning"}
      heading="Needs attention"
    >
      <s-stack gap="small-500">
        {lines.map((line) => (
          <s-text key={line}>{line}</s-text>
        ))}
      </s-stack>
    </s-banner>
  );
}

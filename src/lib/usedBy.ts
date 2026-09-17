import type * as Domain from "@/lib/Domain";

export interface UsedByWorkflow {
  readonly workflowId: Domain.WorkflowId;
  readonly workflowName: Domain.WorkflowName;
  /** Shown beside the name: two workflows may share a name, so the tag is what tells them apart. */
  readonly workflowTag: Domain.WorkflowTag;
  /** Every step this team owns on the workflow is on its draft side: the live workflow does not use the team yet. */
  readonly draftOnly: boolean;
  readonly href: string;
}

/** Where a step is edited. */
export const workflowHref = (workflowId: Domain.WorkflowId) =>
  `/app/workflows/${workflowId}`;

/**
 * Collapses a team's owned steps to the workflows that use it, in the order
 * the steps already carry (name, then side). The team pages show *which
 * workflows*, not which steps: the list grows with workflows, not with steps,
 * and each link goes to where steps are actually edited. A workflow counts as
 * draft-only when none of the team's steps on it are on the live side.
 */
export const groupUsedBy = (
  steps: readonly Domain.OwnedStep[],
): readonly UsedByWorkflow[] => {
  const byWorkflow = new Map<Domain.WorkflowId, UsedByWorkflow>();
  for (const step of steps) {
    const current = byWorkflow.get(step.workflowId);
    if (current === undefined)
      byWorkflow.set(step.workflowId, {
        workflowId: step.workflowId,
        workflowName: step.workflowName,
        workflowTag: step.workflowTag,
        draftOnly: step.side === "draft",
        href: workflowHref(step.workflowId),
      });
    else if (step.side === "workflow" && current.draftOnly)
      byWorkflow.set(step.workflowId, { ...current, draftOnly: false });
  }
  return [...byWorkflow.values()].toSorted((a, b) =>
    a.workflowName.localeCompare(b.workflowName, undefined, {
      sensitivity: "base",
    }),
  );
};

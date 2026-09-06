import * as React from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError } from "@/lib/form";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

import {
  ORDER_WORKFLOW_TRIGGER,
  splitTags,
  workflowResultMessage,
} from "./app.workflows.index";

const WorkflowForm = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Name is required" })),
});
type WorkflowForm = typeof WorkflowForm.Type;

const TagsForm = Schema.Struct({ tags: Schema.String });
type TagsForm = typeof TagsForm.Type;

const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);
const decodeStepResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.StepResult),
);
const decodeApplyResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.ApplyResult),
);
const decodeDiscardResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DiscardResult),
);
const decodeActivateResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.ActivateResult),
);
const decodeDraftResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DraftResult),
);

const stepList = (stepNames: readonly string[]) => stepNames.join(", ");

const applyResultMessage = Match.typeTags<Domain.ApplyResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoDraft: () => "There are no draft changes to apply.",
  NoSteps: () => "Add at least one step before applying.",
  TeamNotActive: ({ stepNames }) =>
    `These steps point at an archived team: ${stepList(stepNames)}. Reassign them or restore the team before applying.`,
});

const discardResultMessage = Match.typeTags<
  Domain.DiscardResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoDraft: () => "There are no draft changes to discard.",
});

const draftResultMessage = Match.typeTags<Domain.DraftResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  Archived: () => "Restore this workflow before editing it.",
});

/** Also the reason shown next to a disabled Turn on, computed client-side from the same conditions the object checks. */
const activateResultMessage = Match.typeTags<
  Domain.ActivateResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  Archived: () => "Restore this workflow before turning it on.",
  NoSteps: () => "This workflow has no steps. Edit to add some, then apply.",
  TeamNotActive: ({ stepNames }) =>
    `These steps point at an archived team: ${stepList(stepNames)}.`,
  OrderWorkflowExists: () => "Another order workflow is on. Turn it off first.",
});

/** A blank instructions field means "no instructions", which the wire carries as `null`, never `""`. */
const instructionsOrNull = (value: string) =>
  value.trim().length === 0 ? null : value;

const stepResultMessage = Match.typeTags<Domain.StepResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That step or workflow no longer exists.",
  Limit: ({ limit }) => `A workflow can have at most ${String(limit)} steps.`,
  TeamNotActive: () => "Choose an active team for this step.",
  Archived: () => "Restore this workflow before editing it.",
  NoDraft: () => "Click Edit to start a draft before changing steps.",
});

const orphaned = (steps: readonly Domain.StepWithTeamName[]) =>
  steps.filter((step) => step.teamName === null);

/**
 * Why Turn on would be refused, decided from the workflow's own steps — the
 * same facts the object checks — so the button can be disabled with its
 * reason instead of failing after a round trip. `OrderWorkflowExists` is
 * only known server-side and surfaces as a banner.
 */
const turnOnBlockerOf = ({
  archived,
  steps,
}: {
  readonly archived: boolean;
  readonly steps: readonly Domain.StepWithTeamName[];
}): Domain.ActivateResult | null => {
  if (archived) return { _tag: "Archived" };
  if (steps.length === 0) return { _tag: "NoSteps" };
  const orphans = orphaned(steps);
  if (orphans.length > 0)
    return {
      _tag: "TeamNotActive",
      stepNames: orphans.map((step) => step.name),
    };
  return null;
};

/** Why Apply would be refused, from the draft's steps; the same checks on and off. */
const applyBlockerOf = (
  steps: readonly Domain.StepWithTeamName[],
): Domain.ApplyResult | null => {
  if (steps.length === 0) return { _tag: "NoSteps" };
  const orphans = orphaned(steps);
  if (orphans.length > 0)
    return {
      _tag: "TeamNotActive",
      stepNames: orphans.map((step) => step.name),
    };
  return null;
};

/** "Starts when …": the item-scope trigger line in the merchant copy of `Domain.Workflow`. */
const triggerLine = (workflow: Domain.Workflow) => {
  if (workflow.scope === "order") return ORDER_WORKFLOW_TRIGGER;
  if (workflow.tags.length === 0)
    return "Starts when an order contains a product tagged with one of this workflow's tags. No tags yet.";
  const quoted = workflow.tags.map((tag) => `“${tag}”`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1) ?? ""}`;
  return `Starts when an order contains a product tagged with ${list ?? ""}.`;
};

/** The workflow's own steps, read-only: what starts runs. */
const workflowTable = (steps: readonly Domain.StepWithTeamName[]) => (
  <s-table>
    <s-table-header-row>
      <s-table-header>#</s-table-header>
      <s-table-header listSlot="primary">Step</s-table-header>
      <s-table-header>Team</s-table-header>
    </s-table-header-row>
    <s-table-body>
      {WorkflowLayout.stagesOf(steps).flatMap((group) =>
        group.map((step) => (
          <s-table-row key={step.id} id={`workflow-${step.id}`}>
            <s-table-cell>
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text>{step.stage}</s-text>
                {group.length > 1 && <s-badge tone="info">together</s-badge>}
              </s-stack>
            </s-table-cell>
            <s-table-cell>
              <s-stack gap="small-500">
                <s-text>{step.name}</s-text>
                {step.instructions !== null && (
                  <s-text color="subdued">{step.instructions}</s-text>
                )}
              </s-stack>
            </s-table-cell>
            <s-table-cell>
              {step.teamName ?? <s-badge tone="warning">Team archived</s-badge>}
            </s-table-cell>
          </s-table-row>
        )),
      )}
    </s-table-body>
  </s-table>
);

const connecting = () =>
  Promise.reject(new Error("Still connecting. Try again in a moment."));

const WorkflowParams = Schema.Struct({ workflowId: Schema.String });

/** Loader read for the same reason as the index's `getLoaderData`. */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(WorkflowParams))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      ShopAgentClient.pipe(
        Effect.flatMap((client) =>
          client.getWorkflowDetail(session.shop, data),
        ),
      ),
    ),
  );

export const Route = createFileRoute("/app/workflows/$workflowId")({
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});

/**
 * Same shape as `/app/workflows`: the read is a loader, every write is one
 * socket RPC, and `router.invalidate()` re-reads after each. Every write
 * returns a tagged result that is copy-mapped here rather than thrown, so a
 * taken name lands on the field and a limit lands in the banner.
 *
 * Two nouns, one page (vocabulary on `Domain.Workflow`). **The workflow**
 * is read-only: what starts runs. **The draft** appears after Edit and is
 * what the editor writes; every step and tag control on the page targets it.
 * Apply and Discard are the only ways a draft ends. Both confirm inline
 * rather than in a modal: Apply on an active workflow changes what the next
 * order follows, and Discard throws work away. Turn on / Turn off never
 * touch the draft.
 */
function RouteComponent() {
  const { workflowId } = Route.useParams();
  const router = useRouter();
  const detail = Route.useLoaderData();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
  /** Which destructive footer action is awaiting its inline confirmation. */
  const [confirming, setConfirming] = React.useState<
    "apply" | "discard" | null
  >(null);
  const [newStep, setNewStep] = React.useState({
    name: "",
    teamId: "",
    instructions: "",
  });
  const [editing, setEditing] = React.useState<{
    stepId: string;
    name: string;
    teamId: string;
    instructions: string;
  } | null>(null);
  /** One inline "at the same time" form open at a time, keyed by stage. */
  const [parallel, setParallel] = React.useState<{
    stage: number;
    name: string;
    teamId: string;
    instructions: string;
  } | null>(null);

  const invalidate = () => router.invalidate({ sync: true });

  const call = <A,>(
    op: (stub: NonNullable<typeof agent>["stub"]) => Promise<A>,
  ) => (agent ? withSocketRecovery(agent)(() => op(agent.stub)) : connecting());

  const onError = (error: Error) => {
    setBanner(error.message);
  };

  const updateMutation = useMutation({
    mutationFn: ({ name }: WorkflowForm) =>
      call((stub) => stub.updateWorkflow({ workflowId, name })).then(
        decodeWorkflowResult,
      ),
    onSuccess: async (result) => {
      setBanner(workflowResultMessage(result));
      await invalidate();
    },
    onError,
  });

  const tagsMutation = useMutation({
    mutationFn: ({ tags }: TagsForm) =>
      call((stub) =>
        stub.updateWorkflowTags({ workflowId, tags: splitTags(tags) }),
      ).then(decodeStepResult),
    onSuccess: async (result) => {
      setBanner(stepResultMessage(result));
      await invalidate();
    },
    onError,
  });

  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) =>
      call((stub) => stub.setWorkflowArchived({ workflowId, archived })).then(
        decodeWorkflowResult,
      ),
    onSuccess: async (result) => {
      setBanner(workflowResultMessage(result));
      await invalidate();
    },
    onError,
  });

  const activeMutation = useMutation({
    mutationFn: (active: boolean) =>
      call((stub) => stub.setWorkflowActive({ workflowId, active })).then(
        decodeActivateResult,
      ),
    onSuccess: async (result) => {
      setBanner(activateResultMessage(result));
      await invalidate();
    },
    onError,
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.applyDraft({ workflowId })).then(decodeApplyResult),
    onSuccess: async (result) => {
      setBanner(applyResultMessage(result));
      setConfirming(null);
      await invalidate();
    },
    onError,
  });

  const editMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.createDraft({ workflowId })).then(decodeDraftResult),
    onSuccess: async (result) => {
      setBanner(draftResultMessage(result));
      await invalidate();
    },
    onError,
  });

  const discardMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.discardDraft({ workflowId })).then(
        decodeDiscardResult,
      ),
    onSuccess: async (result) => {
      setBanner(discardResultMessage(result));
      setConfirming(null);
      setEditing(null);
      setParallel(null);
      await invalidate();
    },
    onError,
  });

  const onStepResult = async (result: Domain.StepResult) => {
    setBanner(stepResultMessage(result));
    if (result._tag === "Ok") setEditing(null);
    await invalidate();
  };

  const addStepMutation = useMutation({
    mutationFn: (
      input: Omit<typeof Domain.AddStepInput.Encoded, "workflowId">,
    ) =>
      call((stub) => stub.addStep({ workflowId, ...input })).then(
        decodeStepResult,
      ),
    onSuccess: async (result) => {
      if (result._tag === "Ok")
        setNewStep({ name: "", teamId: "", instructions: "" });
      await onStepResult(result);
    },
    onError,
  });

  const addParallelStepMutation = useMutation({
    mutationFn: (
      input: Omit<typeof Domain.AddParallelStepInput.Encoded, "workflowId">,
    ) =>
      call((stub) => stub.addParallelStep({ workflowId, ...input })).then(
        decodeStepResult,
      ),
    onSuccess: async (result) => {
      if (result._tag === "Ok") setParallel(null);
      setBanner(
        result._tag === "NotFound"
          ? "That step group no longer exists. Refresh."
          : stepResultMessage(result),
      );
      await invalidate();
    },
    onError,
  });

  const separateStepMutation = useMutation({
    mutationFn: (input: typeof Domain.SeparateStepInput.Encoded) =>
      call((stub) => stub.separateStep(input)).then(decodeStepResult),
    onSuccess: onStepResult,
    onError,
  });

  const updateStepMutation = useMutation({
    mutationFn: (input: typeof Domain.UpdateStepInput.Encoded) =>
      call((stub) => stub.updateStep(input)).then(decodeStepResult),
    onSuccess: onStepResult,
    onError,
  });

  const moveStepMutation = useMutation({
    mutationFn: (input: typeof Domain.MoveStepInput.Encoded) =>
      call((stub) => stub.moveStep(input)).then(decodeStepResult),
    onSuccess: onStepResult,
    onError,
  });

  const removeStepMutation = useMutation({
    mutationFn: (input: typeof Domain.StepIdInput.Encoded) =>
      call((stub) => stub.removeStep(input)).then(decodeStepResult),
    onSuccess: onStepResult,
    onError,
  });

  const form = useForm({
    defaultValues: {
      name: detail?.workflow.name ?? "",
    } satisfies WorkflowForm,
    validators: { onSubmit: Schema.toStandardSchemaV1(WorkflowForm) },
    onSubmit: ({ value }) => {
      void updateMutation.mutateAsync(value);
    },
  });

  const tagsForm = useForm({
    defaultValues: {
      tags: detail?.draft?.draft.tags.join(", ") ?? "",
    } satisfies TagsForm,
    validators: { onSubmit: Schema.toStandardSchemaV1(TagsForm) },
    onSubmit: ({ value }) => {
      void tagsMutation.mutateAsync(value);
    },
  });

  const loadedId = detail?.workflow.id;
  React.useEffect(() => {
    if (loadedId !== undefined) {
      form.reset();
      tagsForm.reset();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reset the forms once per loaded workflow, not on every render of the form objects
  }, [loadedId, detail?.workflow.updatedAt, detail?.draft?.draft.updatedAt]);

  if (detail === null)
    return (
      <s-page heading="Workflow not found">
        <s-link slot="breadcrumb-actions" href="/app/workflows">
          Workflows
        </s-link>
        <s-paragraph color="subdued">
          That workflow no longer exists.
        </s-paragraph>
      </s-page>
    );

  const { workflow, draft, activeTeams } = detail;
  const steps = draft?.steps ?? [];
  const archived = workflow.archivedAt !== null;
  const orderScope = workflow.scope === "order";
  const hasDraft = draft !== null;
  const draftOrphans = orphaned(steps);
  const stepsLocked =
    archived ||
    addStepMutation.isPending ||
    addParallelStepMutation.isPending ||
    separateStepMutation.isPending ||
    updateStepMutation.isPending ||
    moveStepMutation.isPending ||
    removeStepMutation.isPending ||
    applyMutation.isPending ||
    discardMutation.isPending;
  const stages = WorkflowLayout.stagesOf(steps);
  const turnOnBlocker = turnOnBlockerOf({ archived, steps: detail.steps });
  const turnOnReason =
    turnOnBlocker === null ? null : activateResultMessage(turnOnBlocker);
  const applyBlocker = applyBlockerOf(steps);
  const applyReason =
    applyBlocker === null ? null : applyResultMessage(applyBlocker);
  const switching = activeMutation.isPending;
  /** The title bar's accessory slot takes exactly one badge and flattens anything else to text, so only the state goes here; the rest sit at the top of Details. */
  const stateBadge = () => {
    if (archived)
      return (
        <s-badge slot="accessory" tone="info">
          Archived
        </s-badge>
      );
    if (workflow.active)
      return (
        <s-badge slot="accessory" tone="success">
          Active
        </s-badge>
      );
    return <s-badge slot="accessory">Off</s-badge>;
  };

  const teamSelect = (
    value: string,
    onChange: (teamId: string) => void,
    label: string,
  ) => (
    <s-select
      label={label}
      labelAccessibilityVisibility="exclusive"
      value={value}
      placeholder="Choose a team"
      disabled={stepsLocked}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      {activeTeams.map((team) => (
        <s-option key={team.id} value={team.id}>
          {team.name}
        </s-option>
      ))}
    </s-select>
  );

  const instructionsField = (
    value: string,
    onChange: (instructions: string) => void,
    label: string,
  ) => (
    <s-text-area
      label={label}
      labelAccessibilityVisibility="exclusive"
      placeholder="Instructions (optional)"
      rows={2}
      value={value}
      disabled={stepsLocked}
      onInput={(event) => {
        onChange(event.currentTarget.value);
      }}
    />
  );

  const stepRow = (
    step: Domain.StepWithTeamName,
    index: number,
    shared: boolean,
  ) =>
    editing?.stepId === step.id ? (
      <s-table-row key={step.id} id={step.id}>
        <s-table-cell>{step.stage}</s-table-cell>
        <s-table-cell>
          <s-stack gap="small-300">
            <s-text-field
              label="Step name"
              labelAccessibilityVisibility="exclusive"
              value={editing.name}
              onInput={(event) => {
                setEditing({
                  ...editing,
                  name: event.currentTarget.value,
                });
              }}
            />
            {instructionsField(
              editing.instructions,
              (instructions) => {
                setEditing({ ...editing, instructions });
              },
              "Instructions",
            )}
          </s-stack>
        </s-table-cell>
        <s-table-cell>
          {teamSelect(
            editing.teamId,
            (teamId) => {
              setEditing({ ...editing, teamId });
            },
            "Team",
          )}
        </s-table-cell>
        <s-table-cell>
          <s-stack direction="inline" gap="small-300">
            <s-button
              variant="primary"
              disabled={
                stepsLocked ||
                editing.name.trim().length === 0 ||
                editing.teamId === ""
              }
              onClick={() => {
                updateStepMutation.mutate({
                  stepId: step.id,
                  name: editing.name,
                  teamId: editing.teamId,
                  instructions: instructionsOrNull(editing.instructions),
                });
              }}
            >
              Save
            </s-button>
            <s-button
              variant="tertiary"
              onClick={() => {
                setEditing(null);
              }}
            >
              Cancel
            </s-button>
          </s-stack>
        </s-table-cell>
      </s-table-row>
    ) : (
      <s-table-row key={step.id} id={step.id}>
        <s-table-cell>
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text>{step.stage}</s-text>
            {shared && <s-badge tone="info">together</s-badge>}
          </s-stack>
        </s-table-cell>
        <s-table-cell>
          <s-stack gap="small-500">
            <s-text>{step.name}</s-text>
            {step.instructions !== null && (
              <s-text color="subdued">{step.instructions}</s-text>
            )}
          </s-stack>
        </s-table-cell>
        <s-table-cell>
          {step.teamName ?? <s-badge tone="warning">Team archived</s-badge>}
        </s-table-cell>
        <s-table-cell>
          <s-stack direction="inline" gap="small-300">
            <s-button
              variant="tertiary"
              disabled={stepsLocked || index === 0}
              onClick={() => {
                moveStepMutation.mutate({
                  stepId: step.id,
                  direction: "up",
                });
              }}
            >
              Up
            </s-button>
            <s-button
              variant="tertiary"
              disabled={stepsLocked || index === steps.length - 1}
              onClick={() => {
                moveStepMutation.mutate({
                  stepId: step.id,
                  direction: "down",
                });
              }}
            >
              Down
            </s-button>
            {shared && (
              <s-button
                variant="tertiary"
                disabled={stepsLocked}
                onClick={() => {
                  separateStepMutation.mutate({ stepId: step.id });
                }}
              >
                Separate
              </s-button>
            )}
            <s-button
              variant="tertiary"
              disabled={stepsLocked}
              onClick={() => {
                setEditing({
                  stepId: step.id,
                  name: step.name,
                  teamId: step.teamName === null ? "" : step.teamId,
                  instructions: step.instructions ?? "",
                });
              }}
            >
              Edit
            </s-button>
            <s-button
              variant="tertiary"
              tone="critical"
              disabled={stepsLocked}
              onClick={() => {
                removeStepMutation.mutate({ stepId: step.id });
              }}
            >
              Remove
            </s-button>
          </s-stack>
        </s-table-cell>
      </s-table-row>
    );

  const parallelRow = (stage: number) => (
    <s-table-row
      key={`parallel-${String(stage)}`}
      id={`parallel-${String(stage)}`}
    >
      <s-table-cell> </s-table-cell>
      {parallel?.stage === stage ? (
        <>
          <s-table-cell>
            <s-stack gap="small-300">
              <s-text-field
                label="Step name"
                labelAccessibilityVisibility="exclusive"
                placeholder="e.g. Pick materials"
                value={parallel.name}
                disabled={stepsLocked}
                onInput={(event) => {
                  setParallel({ ...parallel, name: event.currentTarget.value });
                }}
              />
              {instructionsField(
                parallel.instructions,
                (instructions) => {
                  setParallel({ ...parallel, instructions });
                },
                "Instructions",
              )}
            </s-stack>
          </s-table-cell>
          <s-table-cell>
            {teamSelect(
              parallel.teamId,
              (teamId) => {
                setParallel({ ...parallel, teamId });
              },
              "Team",
            )}
          </s-table-cell>
          <s-table-cell>
            <s-stack direction="inline" gap="small-300">
              <s-button
                variant="primary"
                disabled={
                  stepsLocked ||
                  parallel.name.trim().length === 0 ||
                  parallel.teamId === ""
                }
                {...(addParallelStepMutation.isPending
                  ? { loading: true }
                  : {})}
                onClick={() => {
                  addParallelStepMutation.mutate({
                    stage,
                    name: parallel.name,
                    teamId: parallel.teamId,
                    ...(instructionsOrNull(parallel.instructions) === null
                      ? {}
                      : { instructions: parallel.instructions }),
                  });
                }}
              >
                Add
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  setParallel(null);
                }}
              >
                Cancel
              </s-button>
            </s-stack>
          </s-table-cell>
        </>
      ) : (
        <>
          <s-table-cell>
            <s-button
              variant="tertiary"
              disabled={stepsLocked || activeTeams.length === 0}
              onClick={() => {
                setParallel({ stage, name: "", teamId: "", instructions: "" });
              }}
            >
              + Add a step that happens at the same time
            </s-button>
          </s-table-cell>
          <s-table-cell> </s-table-cell>
          <s-table-cell> </s-table-cell>
        </>
      )}
    </s-table-row>
  );

  /** The Apply / Discard row, with the inline confirmation for whichever was clicked. */
  const draftFooter = () => {
    if (archived) return null;
    if (confirming === "apply")
      return (
        <s-banner tone="warning" heading="Apply changes?">
          <s-stack gap="small-300">
            <s-paragraph>
              This workflow is on. New orders will follow the applied steps
              immediately.
            </s-paragraph>
            <s-stack direction="inline" gap="small-300">
              <s-button
                variant="primary"
                {...(applyMutation.isPending ? { loading: true } : {})}
                onClick={() => {
                  applyMutation.mutate();
                }}
              >
                Apply now
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      );
    if (confirming === "discard")
      return (
        <s-banner tone="critical" heading="Discard draft changes?">
          <s-stack gap="small-300">
            <s-paragraph>
              The draft is deleted and the workflow stays as it is. This cannot
              be undone.
            </s-paragraph>
            <s-stack direction="inline" gap="small-300">
              <s-button
                variant="primary"
                tone="critical"
                {...(discardMutation.isPending ? { loading: true } : {})}
                onClick={() => {
                  discardMutation.mutate();
                }}
              >
                Discard
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      );
    return (
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-button
          variant="primary"
          disabled={
            !identified || !hasDraft || stepsLocked || applyBlocker !== null
          }
          {...(applyMutation.isPending ? { loading: true } : {})}
          onClick={() => {
            if (workflow.active) setConfirming("apply");
            else applyMutation.mutate();
          }}
        >
          Apply changes
        </s-button>
        <s-button
          variant="tertiary"
          tone="critical"
          disabled={!identified || !hasDraft || stepsLocked}
          onClick={() => {
            setConfirming("discard");
          }}
        >
          Discard changes
        </s-button>
        {applyReason !== null && <s-text color="subdued">{applyReason}</s-text>}
      </s-stack>
    );
  };

  return (
    <s-page heading={workflow.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/workflows">
        Workflows
      </s-link>
      {stateBadge()}
      {workflow.active ? (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!identified || switching}
          {...(switching ? { loading: true } : {})}
          onClick={() => {
            activeMutation.mutate(false);
          }}
        >
          Turn off
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!identified || switching || turnOnBlocker !== null}
          {...(switching ? { loading: true } : {})}
          onClick={() => {
            activeMutation.mutate(true);
          }}
        >
          Turn on
        </s-button>
      )}
      {!hasDraft && !archived && (
        <s-button
          slot="secondary-actions"
          disabled={!identified || editMutation.isPending}
          {...(editMutation.isPending ? { loading: true } : {})}
          onClick={() => {
            editMutation.mutate();
          }}
        >
          Edit
        </s-button>
      )}
      <SocketBanner />

      <s-section heading="Details" accessibilityLabel="Workflow details">
        <s-stack gap="base">
          {(orderScope || hasDraft) && (
            <s-stack direction="inline" gap="small-300">
              {orderScope && <s-badge tone="info">Order workflow</s-badge>}
              {hasDraft && <s-badge tone="caution">Draft pending</s-badge>}
            </s-stack>
          )}
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {!workflow.active && turnOnReason !== null && !archived && (
            <s-banner tone="info" heading="Turn on is unavailable">
              {turnOnReason}
            </s-banner>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <s-stack gap="base">
              <form.Field name="name">
                {(field) => (
                  <s-text-field
                    label="Name"
                    name={field.name}
                    value={field.state.value}
                    error={fieldError(field.state.meta.errors)}
                    onInput={(event) => {
                      field.handleChange(event.currentTarget.value);
                    }}
                    onBlur={field.handleBlur}
                    required
                  />
                )}
              </form.Field>
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button
                  type="submit"
                  variant="primary"
                  disabled={!identified}
                  {...(updateMutation.isPending ? { loading: true } : {})}
                >
                  Save
                </s-button>
                <s-button
                  variant="secondary"
                  disabled={
                    !identified || archiveMutation.isPending || workflow.active
                  }
                  onClick={() => {
                    archiveMutation.mutate(!archived);
                  }}
                >
                  {archived ? "Restore" : "Archive"}
                </s-button>
                {workflow.active && (
                  <s-text color="subdued">Turn off first to archive.</s-text>
                )}
              </s-stack>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section accessibilityLabel="Workflow">
        <s-stack gap="base">
          <s-paragraph color="subdued">{triggerLine(workflow)}</s-paragraph>
          {detail.steps.length === 0 ? (
            <s-paragraph color="subdued">
              {hasDraft
                ? "No steps. Add steps in the draft below, then apply. Turn on when it's ready."
                : "No steps. Edit to add some."}
            </s-paragraph>
          ) : (
            workflowTable(detail.steps)
          )}
          {hasDraft && (
            <s-paragraph color="subdued">
              Draft changes below are not in effect until you apply them.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      {hasDraft && (
        <s-section heading="Draft" accessibilityLabel="Draft">
          <s-stack gap="base">
            <s-paragraph color="subdued">
              Steps with the same number happen at the same time. The next
              number waits until all of them are done. Name the step by the
              work, not the team.
            </s-paragraph>
            {archived && (
              <s-paragraph color="subdued">
                Restore this workflow to edit it.
              </s-paragraph>
            )}
            {!archived && steps.length === 0 && (
              <s-banner tone="warning" heading="No steps">
                {orderScope
                  ? "Add at least one step, then apply. Without steps this workflow cannot be turned on."
                  : "Add at least one step, then apply. Without steps this workflow cannot start for any item."}
              </s-banner>
            )}
            {!archived && draftOrphans.length > 0 && (
              <s-banner tone="warning" heading="Needs attention">
                {`${String(draftOrphans.length)} step${draftOrphans.length === 1 ? "" : "s"} point at an archived team. Reassign or restore the team before applying.`}
              </s-banner>
            )}
            {!orderScope && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void tagsForm.handleSubmit();
                }}
              >
                <s-stack direction="inline" gap="base" alignItems="end">
                  <tagsForm.Field name="tags">
                    {(field) => (
                      <s-text-field
                        label="Product tags"
                        details="Comma-separated. Starts for any item whose product has at least one of these tags. Case doesn't matter. Written to the draft."
                        name={field.name}
                        value={field.state.value}
                        disabled={archived}
                        onInput={(event) => {
                          field.handleChange(event.currentTarget.value);
                        }}
                        onBlur={field.handleBlur}
                      />
                    )}
                  </tagsForm.Field>
                  <s-button
                    type="submit"
                    variant="secondary"
                    disabled={!identified || archived || stepsLocked}
                    {...(tagsMutation.isPending ? { loading: true } : {})}
                  >
                    Save tags
                  </s-button>
                </s-stack>
              </form>
            )}
            {steps.length > 0 && (
              <s-table>
                <s-table-header-row>
                  <s-table-header>#</s-table-header>
                  <s-table-header listSlot="primary">Step</s-table-header>
                  <s-table-header>Team</s-table-header>
                  <s-table-header> </s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {stages.flatMap((group) => [
                    ...group.map((step) =>
                      stepRow(
                        step,
                        steps.findIndex(
                          (candidate) => candidate.id === step.id,
                        ),
                        group.length > 1,
                      ),
                    ),
                    ...(archived ? [] : [parallelRow(group[0]?.stage ?? 1)]),
                  ])}
                </s-table-body>
              </s-table>
            )}
            {activeTeams.length === 0 ? (
              <s-stack gap="small-300">
                <s-paragraph color="subdued">
                  Create a team before adding steps.
                </s-paragraph>
                <s-link href="/app/teams">Teams</s-link>
              </s-stack>
            ) : (
              !archived && (
                <s-stack gap="small-300">
                  <s-stack direction="inline" gap="base" alignItems="end">
                    <s-text-field
                      label="New step"
                      placeholder="e.g. Engrave"
                      value={newStep.name}
                      disabled={stepsLocked}
                      onInput={(event) => {
                        setNewStep({
                          ...newStep,
                          name: event.currentTarget.value,
                        });
                      }}
                    />
                    {teamSelect(
                      newStep.teamId,
                      (teamId) => {
                        setNewStep({ ...newStep, teamId });
                      },
                      "Team for new step",
                    )}
                    <s-button
                      variant="secondary"
                      disabled={
                        stepsLocked ||
                        newStep.name.trim().length === 0 ||
                        newStep.teamId === ""
                      }
                      {...(addStepMutation.isPending ? { loading: true } : {})}
                      onClick={() => {
                        addStepMutation.mutate({
                          name: newStep.name,
                          teamId: newStep.teamId,
                          ...(instructionsOrNull(newStep.instructions) === null
                            ? {}
                            : { instructions: newStep.instructions }),
                        });
                      }}
                    >
                      Add step
                    </s-button>
                  </s-stack>
                  {instructionsField(
                    newStep.instructions,
                    (instructions) => {
                      setNewStep({ ...newStep, instructions });
                    },
                    "Instructions for new step",
                  )}
                </s-stack>
              )
            )}
            {draftFooter()}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

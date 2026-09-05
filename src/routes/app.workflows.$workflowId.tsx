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
  tags: Schema.String,
});
type WorkflowForm = typeof WorkflowForm.Type;

const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);
const decodeStepResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.StepResult),
);

/** A blank instructions field means "no instructions", which the wire carries as `null`, never `""`. */
const instructionsOrNull = (value: string) =>
  value.trim().length === 0 ? null : value;

const stepResultMessage = Match.typeTags<Domain.StepResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That step or workflow no longer exists.",
  Limit: ({ limit }) => `A workflow can have at most ${String(limit)} steps.`,
  TeamNotActive: () => "Choose an active team for this step.",
  Archived: () => "Restore this workflow before editing its steps.",
});

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
 */
function RouteComponent() {
  const { workflowId } = Route.useParams();
  const router = useRouter();
  const detail = Route.useLoaderData();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
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
    mutationFn: ({ name, tags }: WorkflowForm) =>
      call((stub) =>
        stub.updateWorkflow({
          workflowId,
          name,
          tags: detail?.workflow.scope === "order" ? [] : splitTags(tags),
        }),
      ).then(decodeWorkflowResult),
    onSuccess: async (result) => {
      setBanner(workflowResultMessage(result));
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
      tags: detail?.workflow.tags.join(", ") ?? "",
    } satisfies WorkflowForm,
    validators: { onSubmit: Schema.toStandardSchemaV1(WorkflowForm) },
    onSubmit: ({ value }) => {
      void updateMutation.mutateAsync(value);
    },
  });

  const loadedId = detail?.workflow.id;
  React.useEffect(() => {
    if (loadedId !== undefined) form.reset();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reset the form once per loaded workflow, not on every render of the form object
  }, [loadedId, detail?.workflow.updatedAt]);

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

  const { workflow, steps, activeTeams } = detail;
  const archived = workflow.archivedAt !== null;
  const orderScope = workflow.scope === "order";
  const orphanedSteps = steps.filter((step) => step.teamName === null);
  const stepsLocked =
    archived ||
    addStepMutation.isPending ||
    addParallelStepMutation.isPending ||
    separateStepMutation.isPending ||
    updateStepMutation.isPending ||
    moveStepMutation.isPending ||
    removeStepMutation.isPending;
  const stages = WorkflowLayout.stagesOf(steps);

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
    step: (typeof steps)[number],
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

  return (
    <s-page heading={workflow.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/workflows">
        Workflows
      </s-link>
      {(archived || orderScope) && (
        <s-stack slot="accessory" direction="inline" gap="small-300">
          {orderScope && <s-badge tone="info">Order workflow</s-badge>}
          {archived && <s-badge tone="info">Archived</s-badge>}
        </s-stack>
      )}
      <SocketBanner />

      <s-section heading="Details" accessibilityLabel="Workflow details">
        <s-stack gap="base">
          {orderScope && (
            <s-paragraph color="subdued">{ORDER_WORKFLOW_TRIGGER}</s-paragraph>
          )}
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {!archived && steps.length === 0 && (
            <s-banner tone="warning" heading="Needs attention">
              {orderScope
                ? "This workflow has no steps, so it will not start on any order."
                : "This workflow has no steps, so it will not route any line items."}
            </s-banner>
          )}
          {!archived && orphanedSteps.length > 0 && (
            <s-banner tone="warning" heading="Needs attention">
              {`${String(orphanedSteps.length)} step${orphanedSteps.length === 1 ? "" : "s"} point at an archived team. Reassign or restore the team; routing skips this workflow until then.`}
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
              {!orderScope && (
                <form.Field name="tags">
                  {(field) => (
                    <s-text-field
                      label="Product tags"
                      details="Comma-separated. Add any of these tags to a product in Shopify and its line items follow this workflow."
                      name={field.name}
                      value={field.state.value}
                      onInput={(event) => {
                        field.handleChange(event.currentTarget.value);
                      }}
                      onBlur={field.handleBlur}
                    />
                  )}
                </form.Field>
              )}
              <s-stack direction="inline" gap="base" alignItems="start">
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
                  disabled={!identified || archiveMutation.isPending}
                  onClick={() => {
                    archiveMutation.mutate(!archived);
                  }}
                >
                  {archived ? "Restore" : "Archive"}
                </s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section heading="Steps" accessibilityLabel="Workflow steps">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Steps with the same number happen at the same time. The next number
            waits until all of them are done. Name the step by the work, not the
            team.
          </s-paragraph>
          {archived && (
            <s-paragraph color="subdued">
              Restore this workflow to edit its steps.
            </s-paragraph>
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
                      steps.findIndex((candidate) => candidate.id === step.id),
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
        </s-stack>
      </s-section>
    </s-page>
  );
}

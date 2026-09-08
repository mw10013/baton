import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { AttentionBanner, StageFlow } from "@/components/WorkflowStages";
import * as Domain from "@/lib/Domain";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { applyBlocker, ORDER_WORKFLOW_TRIGGER } from "@/lib/workflowShared";

const DISCARD_MODAL = "discard-draft";
const APPLY_MODAL = "apply-draft";

const decodeStepResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.StepResult),
);
const decodeApplyResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.ApplyResult),
);
const decodeDiscardResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DiscardResult),
);
const stepResultMessage = Match.typeTags<Domain.StepResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That step no longer exists. Reload the page.",
  Limit: ({ limit }) => `A workflow can have at most ${String(limit)} steps.`,
  TeamNotFound: () => "That team no longer exists. Choose another.",
});

const applyResultMessage = Match.typeTags<Domain.ApplyResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoDraft: () => "There are no changes to apply.",
  NoSteps: () => "Add at least one step before you can apply.",
  StepUnassigned: ({ stepNames }) =>
    `Assign a team to ${stepNames.join(", ")} before you can apply.`,
});

const discardResultMessage = Match.typeTags<
  Domain.DiscardResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoDraft: () => "There are no changes to discard.",
});

/** A blank instructions field means "no instructions", which the wire carries as `null`, never `""`. */
const instructionsOrNull = (value: string) =>
  value.trim().length === 0 ? null : value;

/** The singleton by its fixed id; no `$workflowId` in the URL, as on its detail page. */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      ShopAgentClient.pipe(
        Effect.flatMap((client) =>
          client.getWorkflowDetail(session.shop, {
            workflowId: Domain.ORDER_WORKFLOW_ID,
          }),
        ),
      ),
    ),
  );

export const Route = createFileRoute("/app/order-workflow/edit")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

/**
 * The order workflow's editor: a copy of the item editor without the tag
 * editor (the trigger is the shop-wide rule and is not editable), Rename,
 * Delete, or Duplicate (the singleton has none), and so without the More
 * actions menu. Steps, stages, the draft, Apply and Discard are the same.
 *
 * Opening it writes nothing. The canvas shows the draft when one exists and
 * the workflow itself when one does not — the first change is what creates
 * the draft, and because a step keeps its id from the workflow into the draft
 * (`WorkflowRepository.ensureDraft`) the step being edited is the same step
 * either way. Until then the header says so and offers no Apply or Discard.
 *
 * Close leaves the draft alone; only Apply and Discard end it.
 */
function RouteComponent() {
  const workflowId = Domain.ORDER_WORKFLOW_ID;
  const detail: Domain.WorkflowLoaderData = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = React.useState<string | null>(
    null,
  );
  const [edit, setEdit] = React.useState({
    name: "",
    teamId: "",
    instructions: "",
  });
  /** The open add-step form: `stage` is the stage it joins, `null` a new last stage. */
  const [adding, setAdding] = React.useState<{
    readonly stage: number | null;
    readonly name: string;
    readonly teamId: string;
    readonly instructions: string;
  } | null>(null);

  const invalidate = () => router.invalidate({ sync: true });

  const call = <A,>(
    op: (stub: NonNullable<typeof agent>["stub"]) => Promise<A>,
  ) =>
    agent
      ? withSocketRecovery(agent)(() => op(agent.stub))
      : Promise.reject(new Error("Still connecting. Try again in a moment."));

  const onError = (error: Error) => {
    setBanner(error.message);
  };

  const onStepResult = async (result: Domain.StepResult) => {
    setBanner(stepResultMessage(result));
    await invalidate();
  };

  const addStepMutation = useMutation({
    mutationFn: (input: {
      readonly stage: number | null;
      readonly name: string;
      readonly teamId: string;
      readonly instructions: string | null;
    }) =>
      call((stub) =>
        input.stage === null
          ? stub.addStep({
              workflowId,
              name: input.name,
              teamId: input.teamId,
              ...(input.instructions === null
                ? {}
                : { instructions: input.instructions }),
            })
          : stub.addParallelStep({
              workflowId,
              stage: input.stage,
              name: input.name,
              teamId: input.teamId,
              ...(input.instructions === null
                ? {}
                : { instructions: input.instructions }),
            }),
      ).then(decodeStepResult),
    onSuccess: async (result) => {
      if (result._tag === "Ok") setAdding(null);
      await onStepResult(result);
    },
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

  const separateStepMutation = useMutation({
    mutationFn: (input: typeof Domain.SeparateStepInput.Encoded) =>
      call((stub) => stub.separateStep(input)).then(decodeStepResult),
    onSuccess: onStepResult,
    onError,
  });

  const joinStepMutation = useMutation({
    mutationFn: (input: typeof Domain.JoinStepInput.Encoded) =>
      call((stub) => stub.joinStep(input)).then(decodeStepResult),
    onSuccess: onStepResult,
    onError,
  });

  const removeStepMutation = useMutation({
    mutationFn: (input: typeof Domain.StepIdInput.Encoded) =>
      call((stub) => stub.removeStep(input)).then(decodeStepResult),
    onSuccess: async (result) => {
      if (result._tag === "Ok") setSelectedStepId(null);
      await onStepResult(result);
    },
    onError,
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.applyDraft({ workflowId })).then(decodeApplyResult),
    onSuccess: async (result) => {
      setBanner(applyResultMessage(result));
      if (result._tag !== "Ok") return;
      await shopify.modal.hide(APPLY_MODAL);
      shopify.toast.show("Changes applied. This is what runs now.");
      await navigate({ to: "/app/order-workflow" });
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
      if (result._tag !== "Ok") return;
      await shopify.modal.hide(DISCARD_MODAL);
      shopify.toast.show("Draft discarded.");
      setSelectedStepId(null);
      setAdding(null);
      await invalidate();
    },
    onError,
  });

  /**
   * The step panel's fields are local state copied from the step, so a reload
   * that changes the step underneath — a team deleted in another tab, an edit
   * from another session — would leave the panel showing values the server no
   * longer has. Seeding during render rather than from an effect is what lets
   * this be the panel's only seeding path: selecting a step and a step
   * changing underneath are the same event here, a new `seeded` identity, so
   * `selectStep` sets the selection and nothing else. An effect would instead
   * paint the previous step's values for a frame and cascade a second render,
   * and would still need the selection handler to seed ahead of it.
   *
   * The comparison is over the values, not the step object, so an invalidation
   * that returns an equal step leaves typing alone; the id is in it so that
   * moving between two steps that happen to match still re-seeds.
   */
  const loadedSteps = detail?.draft?.steps ?? detail?.steps;
  const loadedStep =
    loadedSteps?.find((step) => step.id === selectedStepId) ?? null;
  const loadedStepName = loadedStep?.name;
  const loadedStepTeamId =
    loadedStep === null || Domain.isUnassigned(loadedStep)
      ? ""
      : (loadedStep.teamId ?? "");
  const loadedStepInstructions = loadedStep?.instructions ?? "";
  const [seeded, setSeeded] = React.useState<{
    readonly id: string;
    readonly name: string;
    readonly teamId: string;
    readonly instructions: string;
  } | null>(null);
  if (
    loadedStep !== null &&
    loadedStepName !== undefined &&
    (seeded === null ||
      seeded.id !== loadedStep.id ||
      seeded.name !== loadedStepName ||
      seeded.teamId !== loadedStepTeamId ||
      seeded.instructions !== loadedStepInstructions)
  ) {
    setSeeded({
      id: loadedStep.id,
      name: loadedStepName,
      teamId: loadedStepTeamId,
      instructions: loadedStepInstructions,
    });
    setEdit({
      name: loadedStepName,
      teamId: loadedStepTeamId,
      instructions: loadedStepInstructions,
    });
  }

  if (detail === null)
    return (
      <s-page heading={Domain.ORDER_WORKFLOW_NAME}>
        <s-link slot="breadcrumb-actions" href="/app/order-workflow">
          {Domain.ORDER_WORKFLOW_NAME}
        </s-link>
        <s-paragraph color="subdued">
          The order workflow is not available. Reload the page.
        </s-paragraph>
      </s-page>
    );

  const { workflow, draft, teams } = detail;

  /** What the editor writes: the draft once one exists, the workflow itself until then. */
  const steps = draft?.steps ?? detail.steps;
  const hasDraft = draft !== null;
  const blocker = applyBlocker(steps);
  const selected = steps.find((step) => step.id === selectedStepId) ?? null;
  const busy =
    addStepMutation.isPending ||
    updateStepMutation.isPending ||
    moveStepMutation.isPending ||
    separateStepMutation.isPending ||
    joinStepMutation.isPending ||
    removeStepMutation.isPending ||
    applyMutation.isPending ||
    discardMutation.isPending;
  const sharesStage = (step: Domain.StepWithTeamName) =>
    steps.some((other) => other.id !== step.id && other.stage === step.stage);
  const lastStage = steps.reduce((max, step) => Math.max(max, step.stage), 0);

  /** The panel's fields follow the selection: see the `seeded` block above. */
  const selectStep = (stepId: string) => {
    if (!steps.some((candidate) => candidate.id === stepId)) return;
    setAdding(null);
    setSelectedStepId(stepId);
  };

  const teamSelect = (
    label: string,
    value: string,
    onChange: (teamId: string) => void,
  ) => (
    <s-select
      label={label}
      value={value}
      placeholder="Choose a team"
      disabled={busy}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      {teams.map((team) => (
        <s-option key={team.id} value={team.id}>
          {team.memberCount === 0 ? `${team.name} (no members)` : team.name}
        </s-option>
      ))}
    </s-select>
  );

  const addForm = (stage: number | null) => (
    <s-box padding="base" border="base subdued dashed" borderRadius="base">
      <s-stack gap="small-300">
        <s-text type="strong">
          {stage === null ? "New step" : "New step, at the same time"}
        </s-text>
        <s-text-field
          label="Name"
          placeholder="e.g. Engrave"
          value={adding?.name ?? ""}
          disabled={busy}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setAdding((current) =>
              current === null ? current : { ...current, name: value },
            );
          }}
        />
        {teamSelect("Team", adding?.teamId ?? "", (teamId) => {
          setAdding((current) =>
            current === null ? current : { ...current, teamId },
          );
        })}
        <s-text-area
          label="Instructions"
          placeholder="Optional. Shown to whoever picks the step up."
          rows={2}
          value={adding?.instructions ?? ""}
          disabled={busy}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setAdding((current) =>
              current === null ? current : { ...current, instructions: value },
            );
          }}
        />
        <s-stack direction="inline" gap="small-300">
          <s-button
            variant="primary"
            loading={addStepMutation.isPending}
            disabled={
              busy ||
              (adding?.name.trim().length ?? 0) === 0 ||
              (adding?.teamId ?? "") === ""
            }
            onClick={() => {
              if (adding === null) return;
              addStepMutation.mutate({
                stage: adding.stage,
                name: adding.name,
                teamId: adding.teamId,
                instructions: instructionsOrNull(adding.instructions),
              });
            }}
          >
            Add step
          </s-button>
          <s-button
            variant="tertiary"
            onClick={() => {
              setAdding(null);
            }}
          >
            Cancel
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );

  const openAdd = (stage: number | null) => {
    setSelectedStepId(null);
    setAdding({ stage, name: "", teamId: "", instructions: "" });
  };

  /**
   * The "at the same time" control, under one stage at a time: the stage
   * holding the selected step, or the one whose form is open. Adding a
   * parallel step is always about a particular stage, and repeating the
   * button under every stage turned the canvas into a column of buttons.
   */
  const stageFooter = (stage: number) => {
    if (adding?.stage === stage) return addForm(stage);
    if (selected === null || selected.stage !== stage || teams.length === 0)
      return null;
    return (
      <s-stack direction="inline">
        <s-button
          variant="tertiary"
          icon="plus"
          disabled={busy}
          onClick={() => {
            openAdd(stage);
          }}
        >
          Add a step that runs at the same time
        </s-button>
      </s-stack>
    );
  };

  /** The end of the canvas: the add form when it is open there, the button that opens it otherwise. */
  const canvasFooter = () => {
    if (teams.length === 0)
      return (
        <s-stack gap="small-300">
          <s-paragraph color="subdued">
            Create a team before adding steps.
          </s-paragraph>
          <s-link href="/app/teams">Teams</s-link>
        </s-stack>
      );
    if (adding !== null && adding.stage === null) return addForm(null);
    return (
      <s-stack direction="inline">
        <s-button
          icon="plus"
          disabled={busy}
          onClick={() => {
            openAdd(null);
          }}
        >
          {steps.length === 0 ? "Add the first step" : "Add a step"}
        </s-button>
      </s-stack>
    );
  };

  return (
    <s-page heading={Domain.ORDER_WORKFLOW_NAME} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/order-workflow">
        Close
      </s-link>
      {hasDraft ? (
        <s-badge slot="accessory" tone="info">
          Draft
        </s-badge>
      ) : (
        <s-badge slot="accessory">No changes yet</s-badge>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        loading={applyMutation.isPending}
        disabled={!identified || !hasDraft || busy || blocker !== null}
        {...(Domain.isActive(workflow)
          ? { commandFor: APPLY_MODAL, command: "--show" as const }
          : {
              onClick: () => {
                applyMutation.mutate();
              },
            })}
      >
        Apply changes
      </s-button>
      {hasDraft && (
        <s-button
          slot="secondary-actions"
          tone="critical"
          disabled={!identified || busy}
          commandFor={DISCARD_MODAL}
          command="--show"
        >
          Discard changes
        </s-button>
      )}
      <SocketBanner />

      <s-section accessibilityLabel="Steps">
        <s-stack gap="base">
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {!hasDraft && (
            <s-paragraph color="subdued">
              Nothing is saved yet. Your first change starts a draft; the
              workflow keeps running as it is until you apply it.
            </s-paragraph>
          )}
          {hasDraft && blocker !== null && (
            <s-banner tone="warning" heading="Not ready to apply">
              {applyResultMessage(blocker)}
            </s-banner>
          )}
          <AttentionBanner steps={steps} />

          <StageFlow
            steps={steps}
            selectedStepId={selectedStepId}
            onSelectStep={selectStep}
            trigger={
              <s-box
                padding="base"
                border="base subdued dashed"
                borderRadius="base"
              >
                <s-stack gap="small-300">
                  <s-text type="strong">When it runs</s-text>
                  <s-text color="subdued">{ORDER_WORKFLOW_TRIGGER}</s-text>
                </s-stack>
              </s-box>
            }
            renderStageFooter={stageFooter}
            footer={canvasFooter()}
          />
        </s-stack>
      </s-section>

      <s-section slot="aside" heading={selected === null ? "Editing" : "Step"}>
        {selected === null ? (
          <s-stack gap="small-300">
            <s-paragraph color="subdued">
              Pick a step to rename it, hand it to another team, or move it.
            </s-paragraph>
            <s-paragraph color="subdued">
              Steps inside one dashed block run at the same time. The next stage
              waits for all of them.
            </s-paragraph>
          </s-stack>
        ) : (
          <s-stack gap="base">
            <s-text-field
              label="Name"
              details="Name the step by the work, not the team."
              value={edit.name}
              disabled={busy}
              onInput={(event) => {
                setEdit({ ...edit, name: event.currentTarget.value });
              }}
            />
            {teamSelect("Team", edit.teamId, (teamId) => {
              setEdit({ ...edit, teamId });
            })}
            <s-text-area
              label="Instructions"
              placeholder="Optional. Shown to whoever picks the step up."
              rows={3}
              value={edit.instructions}
              disabled={busy}
              onInput={(event) => {
                setEdit({ ...edit, instructions: event.currentTarget.value });
              }}
            />
            <s-button
              variant="primary"
              loading={updateStepMutation.isPending}
              disabled={
                !identified ||
                busy ||
                edit.name.trim().length === 0 ||
                edit.teamId === ""
              }
              onClick={() => {
                updateStepMutation.mutate({
                  stepId: selected.id,
                  name: edit.name,
                  teamId: edit.teamId,
                  instructions: instructionsOrNull(edit.instructions),
                });
              }}
            >
              Save step
            </s-button>
            <s-divider />
            {/*
              Three verbs, two decisions. Move earlier / Move later change
              order and never concurrency: the moved step always ends alone.
              Run alongside / Run on its own change concurrency and never
              order. Enabled state is decided from the step's stage, not its
              index: a step that shares stage 1 can still move earlier.
            */}
            <s-stack direction="inline" gap="small-300">
              <s-button
                variant="tertiary"
                disabled={
                  busy || (!sharesStage(selected) && selected.stage === 1)
                }
                onClick={() => {
                  moveStepMutation.mutate({
                    stepId: selected.id,
                    direction: "up",
                  });
                }}
              >
                Move earlier
              </s-button>
              <s-button
                variant="tertiary"
                disabled={
                  busy ||
                  (!sharesStage(selected) && selected.stage === lastStage)
                }
                onClick={() => {
                  moveStepMutation.mutate({
                    stepId: selected.id,
                    direction: "down",
                  });
                }}
              >
                Move later
              </s-button>
            </s-stack>
            {sharesStage(selected) ? (
              <s-stack direction="inline">
                <s-button
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => {
                    separateStepMutation.mutate({ stepId: selected.id });
                  }}
                >
                  Run on its own
                </s-button>
              </s-stack>
            ) : (
              selected.stage > 1 && (
                <s-stack direction="inline">
                  <s-button
                    variant="tertiary"
                    disabled={busy}
                    onClick={() => {
                      joinStepMutation.mutate({ stepId: selected.id });
                    }}
                  >
                    Run alongside the previous step
                  </s-button>
                </s-stack>
              )
            )}
            <s-stack direction="inline">
              <s-button
                variant="tertiary"
                tone="critical"
                loading={removeStepMutation.isPending}
                disabled={busy}
                onClick={() => {
                  removeStepMutation.mutate({ stepId: selected.id });
                }}
              >
                Remove step
              </s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      <s-modal id={APPLY_MODAL} heading="Apply changes?">
        <s-paragraph>
          {`${workflow.name} is on. Orders that come in after you apply follow the new steps. Runs already open keep the steps they started with.`}
        </s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={APPLY_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={applyMutation.isPending}
          disabled={!identified || busy}
          onClick={() => {
            applyMutation.mutate();
          }}
        >
          Apply
        </s-button>
      </s-modal>

      <s-modal id={DISCARD_MODAL} heading="Discard changes?">
        <s-paragraph>
          {`The draft is deleted and ${workflow.name} stays exactly as it is. This can't be undone.`}
        </s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={DISCARD_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={discardMutation.isPending}
          disabled={!identified || busy}
          onClick={() => {
            discardMutation.mutate();
          }}
        >
          Discard
        </s-button>
      </s-modal>
    </s-page>
  );
}

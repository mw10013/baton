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

import { LocalDateTime } from "@/components/LocalDateTime";
import { AttentionBanner, StepFlow } from "@/components/WorkflowSteps";
import { WorkflowSwitch } from "@/components/WorkflowSwitch";
import * as Domain from "@/lib/Domain";
import { hideModal } from "@/lib/polarisModal";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { postEditorWindowMessage } from "@/lib/workflowEditorWindow";
import {
  APPLY_BODY,
  APPLY_HEADING,
  applyBlocker,
  DELETE_WORKFLOW_WARNING,
  deleteWorkflowResultMessage,
  DELETED_TOAST,
  DISCARD_BODY,
  DISCARD_HEADING,
  neverApplied,
  RENAME_FIELD_LABEL,
  RENAME_HEADING,
  RENAMED_TOAST,
  turnOnBody,
  workflowResultMessage,
} from "@/lib/workflowShared";

const WorkflowParams = Schema.Struct({ workflowId: Schema.String });

const RENAME_MODAL = "rename-workflow";
const DELETE_MODAL = "delete-workflow";
const DISCARD_MODAL = "discard-draft";
const APPLY_MODAL = "apply-draft";

const decodeWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WorkflowResult),
);
const decodeTaskResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.TaskResult),
);
const decodeApplyResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.ApplyResult),
);
const decodeDiscardResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DiscardResult),
);
const decodeDeleteWorkflowResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DeleteWorkflowResult),
);

const taskResultMessage = Match.typeTags<Domain.TaskResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That task no longer exists. Reload the page.",
  Limit: ({ limit }) => `A workflow can have at most ${String(limit)} tasks.`,
  TeamNotFound: () => "That team no longer exists. Choose another.",
});

/** Imperative: a blocker banner's job is to name the next action, not to restate the state the badges already carry. */
const applyResultMessage = Match.typeTags<Domain.ApplyResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoDraft: () => "There are no changes to apply.",
  NoTasks: () => "Add a step to this workflow.",
  TaskUnassigned: ({ taskNames }) =>
    `Assign a team to ${taskNames.join(", ")}.`,
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

/** Hand-written so an unknown value reads as absent instead of failing the route. */
const validateSearch = ({
  chrome,
}: Record<string, unknown>): { readonly chrome?: "window" } =>
  chrome === "window" ? { chrome } : {};

export const Route = createFileRoute("/app/workflows/$workflowId_/edit")({
  validateSearch,
  loader: ({ params }) => getLoaderData({ data: params }),
  component: RouteComponent,
});

/**
 * The item-workflow editor: its own route, so the detail page can stay a
 * read-only answer to "what does this workflow do". The detail and list
 * pages open it inside an App Bridge `s-app-window` (Flow's full-screen
 * chrome, `chrome=window` in the search) and the admin hoists the `s-page`
 * heading, accessory badge and action slots into its own bar with an X.
 * In that mode the breadcrumb is not rendered, Apply and Delete report
 * back over `postEditorWindowMessage` instead of navigating (the window
 * cannot navigate its opener, and a `navigate` here would only move the
 * iframe), and modals must be hidden with `hideModal`, never
 * `shopify.modal.hide`, which cannot see this document's modals.
 *
 * Opening it writes nothing. The canvas shows the draft when one exists and
 * the workflow itself when one does not — the first change is what creates
 * the draft, and because a task keeps its id from the workflow into the draft
 * (`WorkflowRepository.ensureDraft`) the task being edited is the same task
 * either way.
 *
 * The header is the state, in one primary button and one badge:
 *
 * - never applied — `Draft`, and **Turn on**, which applies and activates in
 *   one confirmed step (`ShopAgent.applyAndActivate`). Apply on its own would
 *   leave the merchant with tasks in force that start nothing, then ask them
 *   to turn on the thing they just applied;
 * - applied with no draft — no badge, and the plain on/off switch, because
 *   there is nothing here to commit;
 * - applied with a draft — `Draft`, **Discard changes** and **Apply changes**,
 *   and no activation control: the switch is about what is in force, and what
 *   is in force is not what is on the canvas.
 *
 * Close leaves the draft alone; only Apply and Discard end it.
 */
function RouteComponent() {
  const { workflowId } = Route.useParams();
  const { chrome } = Route.useSearch();
  /**
   * True when the admin opened this route inside an `s-app-window`; see
   * `workflowEditorWindow.ts`. The flag is a word, not `1`, because the
   * router's search parser JSON-decodes values and would hand back a number.
   */
  const inWindow = chrome === "window";
  const detail: Domain.WorkflowLoaderData = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [banner, setBanner] = React.useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(
    null,
  );
  const [edit, setEdit] = React.useState({
    name: "",
    teamId: "",
    instructions: "",
  });
  /** The open add-task form: `step` is the step it joins, `null` a new last step. */
  const [adding, setAdding] = React.useState<{
    readonly step: number | null;
    readonly name: string;
    readonly teamId: string;
    readonly instructions: string;
  } | null>(null);
  const [name, setName] = React.useState(detail?.workflow.name ?? "");

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

  const onTaskResult = async (result: Domain.TaskResult) => {
    setBanner(taskResultMessage(result));
    await invalidate();
  };

  const addStepMutation = useMutation({
    mutationFn: (input: {
      readonly step: number | null;
      readonly name: string;
      readonly teamId: string;
      readonly instructions: string | null;
    }) =>
      call((stub) =>
        input.step === null
          ? stub.addStep({
              workflowId,
              name: input.name,
              teamId: input.teamId,
              ...(input.instructions === null
                ? {}
                : { instructions: input.instructions }),
            })
          : stub.addTask({
              workflowId,
              step: input.step,
              name: input.name,
              teamId: input.teamId,
              ...(input.instructions === null
                ? {}
                : { instructions: input.instructions }),
            }),
      ).then(decodeTaskResult),
    onSuccess: async (result) => {
      if (result._tag === "Ok") setAdding(null);
      await onTaskResult(result);
    },
    onError,
  });

  const updateTaskMutation = useMutation({
    mutationFn: (input: typeof Domain.UpdateTaskInput.Encoded) =>
      call((stub) => stub.updateTask(input)).then(decodeTaskResult),
    onSuccess: onTaskResult,
    onError,
  });

  const moveTaskMutation = useMutation({
    mutationFn: (input: typeof Domain.MoveTaskInput.Encoded) =>
      call((stub) => stub.moveTask(input)).then(decodeTaskResult),
    onSuccess: onTaskResult,
    onError,
  });

  const separateTaskMutation = useMutation({
    mutationFn: (input: typeof Domain.SeparateTaskInput.Encoded) =>
      call((stub) => stub.separateTask(input)).then(decodeTaskResult),
    onSuccess: onTaskResult,
    onError,
  });

  const joinTaskMutation = useMutation({
    mutationFn: (input: typeof Domain.JoinTaskInput.Encoded) =>
      call((stub) => stub.joinTask(input)).then(decodeTaskResult),
    onSuccess: onTaskResult,
    onError,
  });

  const removeTaskMutation = useMutation({
    mutationFn: (input: typeof Domain.TaskIdInput.Encoded) =>
      call((stub) => stub.removeTask(input)).then(decodeTaskResult),
    onSuccess: async (result) => {
      if (result._tag === "Ok") setSelectedTaskId(null);
      await onTaskResult(result);
    },
    onError,
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.applyDraft({ workflowId })).then(decodeApplyResult),
    onSuccess: async (result) => {
      setBanner(applyResultMessage(result));
      if (result._tag !== "Ok") return;
      hideModal(APPLY_MODAL);
      shopify.toast.show("Changes applied. This is what runs now.");
      if (inWindow) {
        postEditorWindowMessage({ type: "applied", workflowId });
        return;
      }
      await navigate({
        to: "/app/workflows/$workflowId",
        params: { workflowId },
      });
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
      hideModal(DISCARD_MODAL);
      shopify.toast.show("Draft discarded.");
      setSelectedTaskId(null);
      setAdding(null);
      await invalidate();
    },
    onError,
  });

  const renameMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.updateWorkflow({ workflowId, name })).then(
        decodeWorkflowResult,
      ),
    /** Names are labels, so only `NotFound` is left and that is about the workflow, not what was typed. */
    onSuccess: async (result) => {
      const message = workflowResultMessage(result);
      if (message !== null) {
        setBanner(message);
        return;
      }
      hideModal(RENAME_MODAL);
      shopify.toast.show(RENAMED_TOAST);
      await invalidate();
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      call((stub) => stub.removeWorkflow({ workflowId })).then(
        decodeDeleteWorkflowResult,
      ),
    onSuccess: async (result) => {
      if (result._tag !== "Deleted") {
        setBanner(deleteWorkflowResultMessage(result));
        return;
      }
      hideModal(DELETE_MODAL);
      shopify.toast.show(DELETED_TOAST);
      if (inWindow) {
        postEditorWindowMessage({ type: "deleted", workflowId });
        return;
      }
      await navigate({ to: "/app/workflows" });
    },
    onError,
  });

  /**
   * The rename field is a copy, so a name that changes underneath — a rename
   * from another tab, a reload — would leave the modal offering to save a name
   * the server no longer has. Re-seed during render rather than from an
   * effect: React re-runs this component with the new value before committing,
   * where an effect would paint the stale copy and then cascade a second
   * render to fix it. The guard is what makes it a re-seed and not a reset —
   * typing changes `name`, never `loadedName`, so it leaves typing alone.
   */
  const loadedName = detail?.workflow.name;
  const [seededName, setSeededName] = React.useState(loadedName);
  if (loadedName !== undefined && loadedName !== seededName) {
    setSeededName(loadedName);
    setName(loadedName);
  }

  /**
   * The task panel's fields are local state copied from the task, so a reload
   * that changes the task underneath — a team deleted in another tab, an edit
   * from another session — would leave the panel showing values the server no
   * longer has. Seeding during render rather than from an effect is what lets
   * this be the panel's only seeding path: selecting a task and a task
   * changing underneath are the same event here, a new `seeded` identity, so
   * `selectTask` sets the selection and nothing else. An effect would instead
   * paint the previous task's values for a frame and cascade a second render,
   * and would still need the selection handler to seed ahead of it.
   *
   * The comparison is over the values, not the task object, so an invalidation
   * that returns an equal task leaves typing alone; the id is in it so that
   * moving between two tasks that happen to match still re-seeds.
   */
  const loadedTasks = detail?.draft?.tasks ?? detail?.tasks;
  const loadedTask =
    loadedTasks?.find((task) => task.id === selectedTaskId) ?? null;
  const loadedTaskName = loadedTask?.name;
  const loadedTaskTeamId =
    loadedTask === null || Domain.isUnassigned(loadedTask)
      ? ""
      : (loadedTask.teamId ?? "");
  const loadedTaskInstructions = loadedTask?.instructions ?? "";
  const [seeded, setSeeded] = React.useState<{
    readonly id: string;
    readonly name: string;
    readonly teamId: string;
    readonly instructions: string;
  } | null>(null);
  if (
    loadedTask !== null &&
    loadedTaskName !== undefined &&
    (seeded === null ||
      seeded.id !== loadedTask.id ||
      seeded.name !== loadedTaskName ||
      seeded.teamId !== loadedTaskTeamId ||
      seeded.instructions !== loadedTaskInstructions)
  ) {
    setSeeded({
      id: loadedTask.id,
      name: loadedTaskName,
      teamId: loadedTaskTeamId,
      instructions: loadedTaskInstructions,
    });
    setEdit({
      name: loadedTaskName,
      teamId: loadedTaskTeamId,
      instructions: loadedTaskInstructions,
    });
  }

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

  const { draft, teams } = detail;
  const workflow = detail.workflow;

  /** What the editor writes: the draft once one exists, the workflow itself until then. */
  const tasks = draft?.tasks ?? detail.tasks;
  const hasDraft = draft !== null;
  const fresh = neverApplied(detail);
  /**
   * Turn on rather than Apply. `hasDraft` is true here too — the first added
   * task creates the draft — so this check comes first, and what it means is
   * that nothing has ever been in force, which is the whole difference.
   */
  const showSwitch = fresh || !hasDraft;
  const blocker = applyBlocker(tasks);
  const selected = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const busy =
    addStepMutation.isPending ||
    updateTaskMutation.isPending ||
    moveTaskMutation.isPending ||
    separateTaskMutation.isPending ||
    joinTaskMutation.isPending ||
    removeTaskMutation.isPending ||
    applyMutation.isPending ||
    discardMutation.isPending;
  const sharesStep = (task: Domain.TaskWithTeamName) =>
    tasks.some((other) => other.id !== task.id && other.step === task.step);
  const lastStep = tasks.reduce((max, task) => Math.max(max, task.step), 0);

  /** The panel's fields follow the selection: see the `seeded` block above. */
  const selectTask = (taskId: string) => {
    if (!tasks.some((candidate) => candidate.id === taskId)) return;
    setAdding(null);
    setSelectedTaskId(taskId);
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

  const addForm = (step: number | null) => (
    <s-box padding="base" border="base subdued dashed" borderRadius="base">
      <s-stack gap="small-300">
        <s-text type="strong">
          {step === null ? "New step" : `New task in step ${String(step)}`}
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
                step: adding.step,
                name: adding.name,
                teamId: adding.teamId,
                instructions: instructionsOrNull(adding.instructions),
              });
            }}
          >
            {step === null ? "Add step" : "Add task"}
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

  const openAdd = (step: number | null) => {
    setSelectedTaskId(null);
    setAdding({ step, name: "", teamId: "", instructions: "" });
  };

  /**
   * The "Add a task to this step" control, under one step at a time: the step
   * holding the selected task, or the one whose form is open. Adding a
   * parallel task is always about a particular step, and repeating the
   * button under every step turned the canvas into a column of buttons.
   */
  const stepFooter = (step: number) => {
    if (adding?.step === step) return addForm(step);
    if (selected === null || selected.step !== step || teams.length === 0)
      return null;
    return (
      <s-stack direction="inline">
        <s-button
          variant="tertiary"
          icon="plus"
          disabled={busy}
          onClick={() => {
            openAdd(step);
          }}
        >
          Add a task to this step
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
    if (adding !== null && adding.step === null) return addForm(null);
    return (
      <s-stack direction="inline">
        <s-button
          icon="plus"
          disabled={busy}
          onClick={() => {
            openAdd(null);
          }}
        >
          {tasks.length === 0 ? "Add the first step" : "Add a step"}
        </s-button>
      </s-stack>
    );
  };

  return (
    <s-page heading={workflow.name} inlineSize="base">
      {/* In a window the admin's own X is the exit; a breadcrumb would be a second one. */}
      {!inWindow && (
        <s-link slot="breadcrumb-actions" href={`/app/workflows/${workflowId}`}>
          Close
        </s-link>
      )}
      {/* The one signal that the canvas is not what runs. Absent once there is
          nothing unapplied: an applied workflow with no draft is what it says
          it is. */}
      {(fresh || hasDraft) && (
        <s-badge slot="accessory" tone="info">
          Draft
        </s-badge>
      )}
      <s-button slot="secondary-actions" commandFor="editor-actions">
        More actions
      </s-button>
      {showSwitch ? (
        <WorkflowSwitch
          workflow={workflow}
          tasks={tasks}
          turnOnBody={turnOnBody(workflow.tag)}
          slot="primary-action"
          appliesFirst={fresh}
          onChanged={invalidate}
          onMessage={setBanner}
        />
      ) : (
        <>
          {/* Plain, not critical: the critical tone belongs on the confirm,
              where the loss actually happens. */}
          <s-button
            slot="secondary-actions"
            disabled={!identified || busy}
            commandFor={DISCARD_MODAL}
            command="--show"
          >
            Discard changes
          </s-button>
          <s-button
            slot="primary-action"
            variant="primary"
            loading={applyMutation.isPending}
            disabled={!identified || busy || blocker !== null}
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
        </>
      )}
      <s-menu id="editor-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_MODAL} command="--show">
          Rename
        </s-button>
        <s-button
          icon="delete"
          tone="critical"
          commandFor={DELETE_MODAL}
          command="--show"
        >
          Delete
        </s-button>
      </s-menu>

      <SocketBanner />

      <s-section accessibilityLabel="Steps">
        <s-stack gap="base">
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {/* Only while the header offers Turn on or Apply: an active
              workflow with no draft has neither, and its unassigned tasks are
              `AttentionBanner`'s to report. */}
          {blocker !== null && !(showSwitch && Domain.isActive(workflow)) && (
            <s-banner
              tone="warning"
              heading={
                showSwitch ? "Turn on is unavailable" : "Not ready to apply"
              }
            >
              {/* Wrapped, like {@link AttentionBanner}'s lines: `s-banner`
                  renders its body from elements, and a bare string child
                  never reaches the page. */}
              <s-paragraph>{applyResultMessage(blocker)}</s-paragraph>
            </s-banner>
          )}
          <AttentionBanner tasks={tasks} />

          <StepFlow
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={selectTask}
            renderStepFooter={stepFooter}
            footer={canvasFooter()}
          />

          {/* Every task control writes as it is used, so there is no Save for
              the canvas and nothing on screen would otherwise say the work is
              safe. The date is the draft's while one exists: that is the edit
              this line is about. */}
          <s-text color="subdued">
            {busy ? (
              "Saving…"
            ) : (
              <>
                {"\u2713 Saved \u00B7 Last changed on "}
                <LocalDateTime
                  value={draft?.draft.updatedAt ?? workflow.updatedAt}
                />
              </>
            )}
          </s-text>
        </s-stack>
      </s-section>

      {/*
        Something is always in the `aside` slot: `s-page` gives the aside a
        column of its own only while it is filled, so dropping it reflows the
        canvas from 606px to 934px and back on every card click (measured
        2026-09-17). With nothing selected that something is an empty `s-box`
        rather than an empty `s-section`, which would draw a card with nothing
        in it. No standing caption either — two sentences explaining what
        clicking a card does are a caption on a control the merchant is
        already looking at.
      */}
      {selected === null ? (
        <s-box slot="aside" />
      ) : (
        <s-section
          slot="aside"
          heading={sharesStep(selected) ? "Task" : "Step"}
        >
          <s-stack gap="base">
            <s-text-field
              label="Name"
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
              rows={3}
              value={edit.instructions}
              disabled={busy}
              onInput={(event) => {
                setEdit({ ...edit, instructions: event.currentTarget.value });
              }}
            />
            {/*
              Two arrangement decisions, never mixed. Move earlier / Move later
              change order and never concurrency: the moved task always ends
              alone. Join the previous step / Move to its own step change concurrency and
              never order. Enabled state is decided from the task's step, not
              its index: a task that shares step 1 can still move earlier.
            */}
            <s-button-group>
              <s-button
                slot="secondary-actions"
                disabled={
                  busy || (!sharesStep(selected) && selected.step === 1)
                }
                onClick={() => {
                  moveTaskMutation.mutate({
                    taskId: selected.id,
                    direction: "up",
                  });
                }}
              >
                Move earlier
              </s-button>
              <s-button
                slot="secondary-actions"
                disabled={
                  busy || (!sharesStep(selected) && selected.step === lastStep)
                }
                onClick={() => {
                  moveTaskMutation.mutate({
                    taskId: selected.id,
                    direction: "down",
                  });
                }}
              >
                Move later
              </s-button>
              {sharesStep(selected) ? (
                <s-button
                  slot="secondary-actions"
                  disabled={busy}
                  onClick={() => {
                    separateTaskMutation.mutate({ taskId: selected.id });
                  }}
                >
                  Move to its own step
                </s-button>
              ) : (
                selected.step > 1 && (
                  <s-button
                    slot="secondary-actions"
                    disabled={busy}
                    onClick={() => {
                      joinTaskMutation.mutate({ taskId: selected.id });
                    }}
                  >
                    Join the previous step
                  </s-button>
                )
              )}
            </s-button-group>
            <s-divider />
            {/*
              Slots, not source order, decide where these sit: Polaris places
              `primary-action` where the admin expects a commit and leaves the
              critical one in `secondary-actions`. Delete needs no confirm
              here — it edits the draft, and Discard changes undoes the lot.
            */}
            <s-button-group>
              <s-button
                slot="secondary-actions"
                tone="critical"
                loading={removeTaskMutation.isPending}
                disabled={busy}
                onClick={() => {
                  removeTaskMutation.mutate({ taskId: selected.id });
                }}
              >
                Delete
              </s-button>
              <s-button
                slot="primary-action"
                variant="primary"
                loading={updateTaskMutation.isPending}
                disabled={
                  !identified ||
                  busy ||
                  edit.name.trim().length === 0 ||
                  edit.teamId === ""
                }
                onClick={() => {
                  updateTaskMutation.mutate({
                    taskId: selected.id,
                    name: edit.name,
                    teamId: edit.teamId,
                    instructions: instructionsOrNull(edit.instructions),
                  });
                }}
              >
                Save
              </s-button>
            </s-button-group>
          </s-stack>
        </s-section>
      )}

      <s-modal id={APPLY_MODAL} heading={APPLY_HEADING}>
        <s-paragraph>{APPLY_BODY}</s-paragraph>
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

      <s-modal id={DISCARD_MODAL} heading={DISCARD_HEADING}>
        <s-paragraph>{DISCARD_BODY}</s-paragraph>
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

      <s-modal id={RENAME_MODAL} heading={RENAME_HEADING}>
        <s-stack gap="small-300">
          <s-text-field
            label={RENAME_FIELD_LABEL}
            value={name}
            maxLength={Domain.NAME_MAX_LENGTH}
            onInput={(event) => {
              setName(event.currentTarget.value);
            }}
          />
          {/* `s-text-field` has no counter of its own, and the limit is worth
              seeing while typing: the field silently stops accepting. */}
          <s-text color="subdued">
            {`${String(name.length)}/${String(Domain.NAME_MAX_LENGTH)}`}
          </s-text>
        </s-stack>
        <s-button
          slot="secondary-actions"
          commandFor={RENAME_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={renameMutation.isPending}
          disabled={!identified || name.trim().length === 0}
          onClick={() => {
            renameMutation.mutate();
          }}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal id={DELETE_MODAL} heading={`Delete ${workflow.name}?`}>
        <s-paragraph>{DELETE_WORKFLOW_WARNING}</s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={DELETE_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleteMutation.isPending}
          disabled={!identified || deleteMutation.isPending}
          onClick={() => {
            deleteMutation.mutate();
          }}
        >
          Delete
        </s-button>
      </s-modal>
    </s-page>
  );
}

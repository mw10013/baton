import { useAtomSet } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { useState } from "react";
import * as ShopWork from "../../domain/shop-work.ts";
import { toast } from "../client/app-bridge.ts";
import { hideModal } from "../client/polaris-modal.ts";
import {
  addStepAtom,
  addTaskAtom,
  applyDraftAtom,
  deleteWorkflowAtom,
  discardDraftAtom,
  joinTaskAtom,
  moveTaskAtom,
  removeTaskAtom,
  separateTaskAtom,
  updateTaskAtom,
  updateWorkflowAtom,
} from "../client/shop-actor-client.ts";
import { thrownCopy } from "./form.ts";
import type { PageLink } from "./MembersIndexPage.tsx";
import { EmptyAside } from "./screen/EmptyAside.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { Panel } from "./screen/Panel.tsx";
import { usePressWaiting } from "./press-waiting.ts";
import { textLimitError, textLimitProps } from "./screen/TextLimit.tsx";
import { Things } from "./screen/Things.tsx";
import { DELETED_TOAST } from "./teams.ts";
import { StepFlow, TeamFaultBanners } from "./WorkflowSteps.tsx";
import { WorkflowSwitch } from "./WorkflowSwitch.tsx";
import {
  APPLY_BODY,
  APPLY_HEADING,
  applyBlocker,
  DELETE_WORKFLOW_BODY,
  deleteWorkflowResultMessage,
  DISCARD_BODY,
  DISCARD_HEADING,
  neverApplied,
  RENAME_FIELD_LABEL,
  RENAME_HEADING,
  RENAMED_TOAST,
  turnOnBody,
  workflowResultMessage,
} from "./workflow-shared.ts";

const RENAME_MODAL = "rename-workflow";
const DELETE_MODAL = "delete-workflow";
const DISCARD_MODAL = "discard-draft";
const APPLY_MODAL = "apply-draft";

const taskResultMessage = Match.typeTags<ShopWork.TaskResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That task no longer exists. Reload the page.",
  Limit: ({ limit }) => `A workflow can have ${String(limit)} tasks.`,
  TeamNotFound: () => "That team no longer exists. Choose another.",
});

/**
 * The result of a press of Apply, for the critical banner. Imperative: it names the next action.
 * Nothing shows it before the press: a disabled Apply beside an empty canvas, or beside the
 * "Needs a team" banner, already says why (the copy table's banner row).
 */
const applyResultMessage = Match.typeTags<ShopWork.ApplyResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoDraft: () => "There are no changes to apply.",
  NoTasks: () => "Add a step to this workflow.",
  TaskUnassigned: ({ taskNames }) => `Assign a team to ${taskNames.join(", ")}.`,
});

const discardResultMessage = Match.typeTags<ShopWork.DiscardResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoDraft: () => "There are no changes to discard.",
});

/** A blank instructions field means "no instructions", which the wire carries as `null`, never `""`. */
const instructionsOrNull = (value: string) => (value.trim().length === 0 ? null : value);

const decodeTask = Schema.decodeUnknownOption(
  Schema.Struct({
    name: ShopWork.TaskName,
    teamId: ShopWork.TeamId,
    instructions: Schema.NullOr(ShopWork.TaskInstructions),
  }),
);
const decodeName = Schema.decodeUnknownOption(ShopWork.WorkflowName);

/** A task the add form or the panel sends: decoded already. */
interface TaskFields {
  readonly name: ShopWork.TaskName;
  readonly teamId: ShopWork.TeamId;
  readonly instructions: ShopWork.TaskInstructions | null;
}

/** A write's answer to the screen: the union, or the copy of what was thrown. */
type Press<A, R> = (input: A) => Promise<R | string>;

interface Presses {
  readonly busy: boolean;
  readonly adding: boolean;
  readonly updating: boolean;
  readonly removing: boolean;
  readonly applying: boolean;
  readonly discarding: boolean;
  readonly renaming: boolean;
  readonly deleting: boolean;
  /** `step` is the step the task joins, `null` a new last step. */
  readonly add: Press<TaskFields & { readonly step: number | null }, ShopWork.TaskResult>;
  readonly update: Press<TaskFields & { readonly taskId: string }, ShopWork.TaskResult>;
  readonly move: Press<
    { readonly taskId: string; readonly direction: ShopWork.TaskDirection },
    ShopWork.TaskResult
  >;
  readonly separate: Press<string, ShopWork.TaskResult>;
  readonly join: Press<string, ShopWork.TaskResult>;
  readonly remove: Press<string, ShopWork.TaskResult>;
  readonly apply: Press<void, ShopWork.ApplyResult>;
  readonly discard: Press<void, ShopWork.DiscardResult>;
  readonly rename: Press<ShopWork.WorkflowName, ShopWork.WorkflowResult>;
  readonly deleteWorkflow: Press<void, ShopWork.DeleteWorkflowResult>;
}

/** {@link WorkflowEditorPage}'s props: the loader's detail and the route's navigation. */
export interface WorkflowEditorProps {
  /** `null` is no such workflow in this shop. */
  readonly detail: ShopWork.WorkflowPageData | null;
  /**
   * True when the editor runs inside an `s-app-window` (`chrome=window`): no breadcrumb (the
   * admin's X is the exit), the window's title bar order, and Apply and Delete reported to the
   * opener instead of navigating ({@link onApplied}, {@link onDeleted}).
   */
  readonly inWindow: boolean;
  /** The breadcrumb Close, to the workflow page; the page form only. */
  readonly closeLink: PageLink;
  /** Where a shop with no team goes to make one. */
  readonly teamsLink: PageLink;
  /** After a write: re-read the loader. */
  readonly onChanged: () => Promise<void>;
  /** After Apply: the workflow page, or the opener told. */
  readonly onApplied: () => Promise<void>;
  /** After Delete: the workflows index, or the opener told. */
  readonly onDeleted: () => Promise<void>;
}

function EditorScreen(
  props: WorkflowEditorProps & {
    readonly detail: ShopWork.WorkflowPageData;
    readonly presses: Presses;
  },
) {
  const { detail, presses, inWindow } = props;
  const { draftTasks, teams, workflow } = detail;
  const busy = presses.busy;
  const [banner, setBanner] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", teamId: "", instructions: "" });
  /** The open add-task form: `step` is the step it joins, `null` a new last step. */
  const [adding, setAdding] = useState<{
    readonly step: number | null;
    readonly name: string;
    readonly teamId: string;
    readonly instructions: string;
  } | null>(null);
  const [name, setName] = useState<string>(workflow.name);
  const [nameError, setNameError] = useState<string | null>(null);
  /** The Name field's submit error, on either form; one at a time is open. */
  const [taskNameError, setTaskNameError] = useState<string | null>(null);
  /** The Instructions field's submit error, on either form; one at a time is open. */
  const [instructionsError, setInstructionsError] = useState<string | null>(null);

  /** Every task write sets the banner from its answer, then re-reads. */
  const onTaskResult = async (result: ShopWork.TaskResult | string) => {
    setBanner(typeof result === "string" ? result : taskResultMessage(result));
    await props.onChanged();
  };

  /**
   * The rename field is a copy, re-seeded during render when the name changes underneath, for the
   * reason on the workflow page's.
   */
  const loadedName = workflow.name;
  const [seededName, setSeededName] = useState<string>(loadedName);
  if (loadedName !== seededName) {
    setSeededName(loadedName);
    setName(loadedName);
  }

  /** What the editor writes: the draft once one exists, the workflow itself until then. */
  const tasks = draftTasks ?? detail.tasks;

  /**
   * The task panel's fields are local state copied from the task, so a reload that changes the
   * task underneath (a team deleted in another tab, an edit from another session) would leave the
   * panel showing values the server no longer has. Seeding during render rather than from an
   * effect is what lets this be the panel's only seeding path: selecting a task and a task
   * changing underneath are the same event here, a new `seeded` identity, so `selectTask` sets
   * the selection and nothing else. The comparison is over the values, not the task object, so
   * an invalidation that returns an equal task leaves typing alone; the id is in it so that
   * moving between two tasks that happen to match still re-seeds.
   */
  const loadedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const loadedTaskTeamId =
    loadedTask === null || ShopWork.workflowTaskIsUnassigned(loadedTask)
      ? ""
      : (loadedTask.teamId ?? "");
  const loadedTaskInstructions = loadedTask?.instructions ?? "";
  const [seeded, setSeeded] = useState<{
    readonly id: string;
    readonly name: string;
    readonly teamId: string;
    readonly instructions: string;
  } | null>(null);
  if (
    loadedTask !== null &&
    (seeded === null ||
      seeded.id !== loadedTask.id ||
      seeded.name !== loadedTask.name ||
      seeded.teamId !== loadedTaskTeamId ||
      seeded.instructions !== loadedTaskInstructions)
  ) {
    setSeeded({
      id: loadedTask.id,
      name: loadedTask.name,
      teamId: loadedTaskTeamId,
      instructions: loadedTaskInstructions,
    });
    setEdit({
      name: loadedTask.name,
      teamId: loadedTaskTeamId,
      instructions: loadedTaskInstructions,
    });
  }

  const hasDraft = draftTasks !== null;
  const fresh = neverApplied(detail);
  /**
   * Turn on rather than Apply. `hasDraft` is true here too (the first added task creates the
   * draft), so this check comes first, and what it means is that nothing has ever been in force,
   * which is the whole difference.
   */
  const showSwitch = fresh || !hasDraft;
  const blocker = applyBlocker(tasks);
  const selected = loadedTask;
  const sharesStep = (task: ShopWork.TaskWithTeamName) =>
    tasks.some((other) => other.id !== task.id && other.step === task.step);
  const lastStep = tasks.reduce((max, task) => Math.max(max, task.step), 0);

  /** The panel's fields follow the selection: see the `seeded` block above. */
  const selectTask = (taskId: string) => {
    if (!tasks.some((candidate) => candidate.id === taskId)) return;
    setAdding(null);
    setSelectedTaskId(taskId);
  };

  /** The fields' submit errors for a name and instructions past their caps; true when clear. */
  const withinLimits = (taskName: string, instructions: string) => {
    const nameLimit = textLimitError(taskName, ShopWork.NAME_MAX_LENGTH);
    const limit = textLimitError(instructions, ShopWork.TASK_INSTRUCTIONS_MAX_LENGTH);
    if (nameLimit !== null) setTaskNameError(nameLimit);
    if (limit !== null) setInstructionsError(limit);
    return nameLimit === null && limit === null;
  };

  const submitAdd = async () => {
    if (adding === null || !withinLimits(adding.name, adding.instructions)) return;
    const fields = decodeTask({
      name: adding.name,
      teamId: adding.teamId,
      instructions: instructionsOrNull(adding.instructions),
    });
    if (fields._tag === "None") return;
    const result = await presses.add({ ...fields.value, step: adding.step });
    if (typeof result !== "string" && result._tag === "Ok") setAdding(null);
    await onTaskResult(result);
  };

  const submitUpdate = async () => {
    if (selected === null || !withinLimits(edit.name, edit.instructions)) return;
    const fields = decodeTask({
      name: edit.name,
      teamId: edit.teamId,
      instructions: instructionsOrNull(edit.instructions),
    });
    if (fields._tag === "None") return;
    await onTaskResult(await presses.update({ ...fields.value, taskId: selected.id }));
  };

  const removeSelected = async () => {
    if (selected === null) return;
    const result = await presses.remove(selected.id);
    if (typeof result !== "string" && result._tag === "Ok") setSelectedTaskId(null);
    await onTaskResult(result);
  };

  const apply = async () => {
    const result = await presses.apply();
    if (typeof result === "string") return setBanner(result);
    setBanner(applyResultMessage(result));
  };

  const discard = async () => {
    const result = await presses.discard();
    if (typeof result === "string") return setBanner(result);
    setBanner(discardResultMessage(result));
    if (result._tag === "Ok") {
      setSelectedTaskId(null);
      setAdding(null);
    }
  };

  const rename = async () => {
    const limit = textLimitError(name, ShopWork.NAME_MAX_LENGTH);
    if (limit !== null) return setNameError(limit);
    const decoded = decodeName(name);
    if (decoded._tag === "None") return;
    const result = await presses.rename(decoded.value);
    if (typeof result === "string") return setBanner(result);
    // `NameTaken` is about what was typed, so it goes under the field; anything else is about
    // the workflow and goes in the banner.
    if (result._tag === "NameTaken") return setNameError(workflowResultMessage(result));
    const message = workflowResultMessage(result);
    if (message !== null) setBanner(message);
  };

  const deleteWorkflow = async () => {
    const result = await presses.deleteWorkflow();
    if (typeof result === "string") return setBanner(result);
    const message = deleteWorkflowResultMessage(result);
    if (message !== null) setBanner(message);
  };

  const teamSelect = (label: string, value: string, onChange: (teamId: string) => void) => (
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
          {team.name}
        </s-option>
      ))}
    </s-select>
  );

  const addForm = (step: number | null) => (
    <Panel kind="draft">
      <Lines>
        <s-heading>{step === null ? "New step" : `New task in step ${String(step)}`}</s-heading>
        <s-text-field
          label="Name"
          placeholder="e.g. Engrave"
          value={adding?.name ?? ""}
          disabled={busy}
          {...(taskNameError === null ? {} : { error: taskNameError })}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setTaskNameError(null);
            setAdding((current) => (current === null ? current : { ...current, name: value }));
          }}
        />
        {teamSelect("Team", adding?.teamId ?? "", (teamId) => {
          setAdding((current) => (current === null ? current : { ...current, teamId }));
        })}
        <s-text-area
          label="Instructions"
          rows={2}
          value={adding?.instructions ?? ""}
          disabled={busy}
          {...textLimitProps(adding?.instructions ?? "", ShopWork.TASK_INSTRUCTIONS_MAX_LENGTH)}
          {...(instructionsError === null ? {} : { error: instructionsError })}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setInstructionsError(null);
            setAdding((current) =>
              current === null ? current : { ...current, instructions: value },
            );
          }}
        />
        <Inline>
          <s-button
            variant="primary"
            loading={presses.adding}
            disabled={
              busy || (adding?.name.trim().length ?? 0) === 0 || (adding?.teamId ?? "") === ""
            }
            onClick={() => {
              void submitAdd();
            }}
          >
            {`${ShopWork.RECORD_VERB_LABEL.add} ${step === null ? "step" : "task"}`}
          </s-button>
          <s-button
            variant="tertiary"
            onClick={() => {
              setAdding(null);
            }}
          >
            Cancel
          </s-button>
        </Inline>
      </Lines>
    </Panel>
  );

  const openAdd = (step: number | null) => {
    setSelectedTaskId(null);
    setAdding({ step, name: "", teamId: "", instructions: "" });
  };

  /**
   * The "Add a task to this step" control, under one step at a time: the step holding the
   * selected task, or the one whose form is open. Adding a parallel task is always about a
   * particular step, and repeating the button under every step turned the canvas into a column
   * of buttons.
   */
  const stepFooter = (step: number) => {
    if (adding?.step === step) return addForm(step);
    if (selected === null || selected.step !== step || teams.length === 0) return null;
    return (
      <Inline>
        <s-button
          variant="tertiary"
          icon="plus"
          disabled={busy}
          onClick={() => {
            openAdd(step);
          }}
        >
          {`${ShopWork.RECORD_VERB_LABEL.add} task`}
        </s-button>
      </Inline>
    );
  };

  /** The end of the canvas: the add form when it is open there, the button that opens it otherwise. */
  const canvasFooter = () => {
    if (teams.length === 0)
      return (
        <Lines>
          <s-paragraph color="subdued">Create a team before adding steps.</s-paragraph>
          <s-link {...props.teamsLink}>Teams</s-link>
        </Lines>
      );
    if (adding !== null && adding.step === null) return addForm(null);
    return (
      <Inline>
        <s-button
          icon="plus"
          disabled={busy}
          onClick={() => {
            openAdd(null);
          }}
        >
          {`${ShopWork.RECORD_VERB_LABEL.add} step`}
        </s-button>
      </Inline>
    );
  };

  // More actions comes first, before Discard, as in Flow's editor. A page title bar keeps the
  // order the buttons are written in; the admin's window title bar reverses its secondary
  // buttons, so in a window it is written after Discard.
  const moreActions = (
    <s-button slot="secondary-actions" commandFor="editor-actions">
      More actions
    </s-button>
  );

  return (
    <s-page heading={workflow.name} inlineSize="base">
      {/* In a window the admin's own X is the exit; a breadcrumb would be a second one. */}
      {!inWindow && (
        <s-link slot="breadcrumb-actions" {...props.closeLink}>
          Close
        </s-link>
      )}
      {/* The one signal that the canvas is not what runs. Absent once there is nothing
          unapplied: an applied workflow with no draft is what it says it is. */}
      {(fresh || hasDraft) && (
        <s-badge slot="accessory" tone="info">
          Draft
        </s-badge>
      )}
      {!inWindow && moreActions}
      {showSwitch ? (
        <WorkflowSwitch
          workflow={workflow}
          tasks={tasks}
          turnOnBody={turnOnBody(workflow.tag)}
          slot="primary-action"
          appliesFirst={fresh}
          onChanged={props.onChanged}
          onMessage={setBanner}
        />
      ) : (
        <>
          {/* Plain, not critical: the critical tone belongs on the confirm, where the loss
              actually happens. */}
          <s-button
            slot="secondary-actions"
            disabled={busy}
            commandFor={DISCARD_MODAL}
            command="--show"
          >
            {ShopWork.VERB_LABEL.discard.merchant}
          </s-button>
          <s-button
            slot="primary-action"
            variant="primary"
            loading={presses.applying}
            disabled={busy || blocker !== null}
            {...(ShopWork.workflowIsActive(workflow)
              ? { commandFor: APPLY_MODAL, command: "--show" as const }
              : {
                  onClick: () => {
                    void apply();
                  },
                })}
          >
            {ShopWork.VERB_LABEL.apply.merchant}
          </s-button>
        </>
      )}
      {inWindow && moreActions}
      <s-menu id="editor-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_MODAL} command="--show">
          {ShopWork.RECORD_VERB_LABEL.rename}
        </s-button>
        <s-button icon="delete" tone="critical" commandFor={DELETE_MODAL} command="--show">
          {ShopWork.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-menu>

      <s-section accessibilityLabel="Steps">
        <Things>
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {/* No standing banner for what blocks Apply or Turn on: the disabled button beside an
              empty canvas, or beside the "Needs a team" banner, already says it. */}
          <TeamFaultBanners tasks={tasks} />

          <StepFlow
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={selectTask}
            renderStepFooter={stepFooter}
            footer={canvasFooter()}
          />
          {/* No "Saved" line: every task control writes as it is used, the pressed button
              carries `loading` while it does, and a failed write is the critical banner above. */}
        </Things>
      </s-section>

      {/* Something is always in the `aside` slot (`EmptyAside`). No standing caption either:
          two sentences explaining what clicking a card does are a caption on a control the
          merchant is already looking at. */}
      {selected === null ? (
        <EmptyAside />
      ) : (
        <s-section slot="aside" heading={sharesStep(selected) ? "Task" : "Step"}>
          <Things>
            <s-text-field
              label="Name"
              value={edit.name}
              disabled={busy}
              {...(taskNameError === null ? {} : { error: taskNameError })}
              onInput={(event) => {
                setTaskNameError(null);
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
              {...textLimitProps(edit.instructions, ShopWork.TASK_INSTRUCTIONS_MAX_LENGTH)}
              {...(instructionsError === null ? {} : { error: instructionsError })}
              onInput={(event) => {
                setInstructionsError(null);
                setEdit({ ...edit, instructions: event.currentTarget.value });
              }}
            />
            {/* Two arrangement decisions, never mixed. Move earlier / Move later change order and
                never concurrency: the moved task always ends alone. Join the previous step / Move
                to its own step change concurrency and never order. Enabled state is decided from
                the task's step, not its index: a task that shares step 1 can still move earlier. */}
            <s-button-group>
              <s-button
                slot="secondary-actions"
                disabled={busy || (!sharesStep(selected) && selected.step === 1)}
                onClick={() => {
                  void presses.move({ taskId: selected.id, direction: "up" }).then(onTaskResult);
                }}
              >
                Move earlier
              </s-button>
              <s-button
                slot="secondary-actions"
                disabled={busy || (!sharesStep(selected) && selected.step === lastStep)}
                onClick={() => {
                  void presses.move({ taskId: selected.id, direction: "down" }).then(onTaskResult);
                }}
              >
                Move later
              </s-button>
              {sharesStep(selected) ? (
                <s-button
                  slot="secondary-actions"
                  disabled={busy}
                  onClick={() => {
                    void presses.separate(selected.id).then(onTaskResult);
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
                      void presses.join(selected.id).then(onTaskResult);
                    }}
                  >
                    Join the previous step
                  </s-button>
                )
              )}
            </s-button-group>
            <s-divider />
            {/* Slots, not source order, decide where these sit. Delete needs no confirm here: it
                edits the draft, and Discard changes undoes the lot. */}
            <s-button-group>
              <s-button
                slot="secondary-actions"
                tone="critical"
                loading={presses.removing}
                disabled={busy}
                onClick={() => {
                  void removeSelected();
                }}
              >
                {ShopWork.RECORD_VERB_LABEL.delete}
              </s-button>
              <s-button
                slot="primary-action"
                variant="primary"
                loading={presses.updating}
                disabled={busy || edit.name.trim().length === 0 || edit.teamId === ""}
                onClick={() => {
                  void submitUpdate();
                }}
              >
                Save
              </s-button>
            </s-button-group>
          </Things>
        </s-section>
      )}

      <s-modal id={APPLY_MODAL} heading={APPLY_HEADING}>
        <s-paragraph>{APPLY_BODY}</s-paragraph>
        <s-button slot="secondary-actions" commandFor={APPLY_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={presses.applying}
          disabled={busy}
          onClick={() => {
            void apply();
          }}
        >
          Apply
        </s-button>
      </s-modal>

      <s-modal id={DISCARD_MODAL} heading={DISCARD_HEADING}>
        <s-paragraph>{DISCARD_BODY}</s-paragraph>
        <s-button slot="secondary-actions" commandFor={DISCARD_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={presses.discarding}
          disabled={busy}
          onClick={() => {
            void discard();
          }}
        >
          Discard
        </s-button>
      </s-modal>

      <s-modal
        id={RENAME_MODAL}
        heading={RENAME_HEADING}
        onAfterHide={() => {
          setNameError(null);
        }}
      >
        <Lines>
          <s-text-field
            label={RENAME_FIELD_LABEL}
            value={name}
            {...(nameError === null ? {} : { error: nameError })}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setNameError(null);
            }}
          />
        </Lines>
        <s-button slot="secondary-actions" commandFor={RENAME_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={presses.renaming}
          disabled={name.trim().length === 0}
          onClick={() => {
            void rename();
          }}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal id={DELETE_MODAL} heading={`Delete ${workflow.name}?`}>
        <s-paragraph>{DELETE_WORKFLOW_BODY}</s-paragraph>
        <s-button slot="secondary-actions" commandFor={DELETE_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={presses.deleting}
          disabled={presses.deleting}
          onClick={() => {
            void deleteWorkflow();
          }}
        >
          {ShopWork.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-modal>
    </s-page>
  );
}

/** A press that threw (a lost socket, a defect), as the page says it. */
const thrown = (fallback: string) => async (cause: Cause.Cause<unknown>) =>
  thrownCopy(Cause.squash(cause), fallback);

/**
 * The editor's presses: each control is its `Merchant…` procedure on the layout's socket once
 * hydrated, and idle before. A hook rather than a live component swapped in at hydration, so
 * {@link EditorScreen} keeps its position and the server's `s-page` element survives hydration:
 * inside the editor's window App Bridge follows only the `s-page` the window document had when it
 * loaded, and a replaced one leaves the admin's title bar frozen. Reading the procedure atoms is
 * left to {@link usePressWaiting}; only pressing one builds the socket. Modals are hidden through the element
 * ({@link hideModal}), which works in the page and inside the window alike.
 */
function useEditorPresses(
  props: WorkflowEditorProps & { readonly detail: ShopWork.WorkflowPageData },
): Presses {
  const hydrated = useHydrated();
  const workflowId = props.detail.workflow.id;
  const waiting = {
    addStep: usePressWaiting(addStepAtom),
    addTask: usePressWaiting(addTaskAtom),
    update: usePressWaiting(updateTaskAtom),
    move: usePressWaiting(moveTaskAtom),
    separate: usePressWaiting(separateTaskAtom),
    join: usePressWaiting(joinTaskAtom),
    remove: usePressWaiting(removeTaskAtom),
    apply: usePressWaiting(applyDraftAtom),
    discard: usePressWaiting(discardDraftAtom),
    rename: usePressWaiting(updateWorkflowAtom),
    delete: usePressWaiting(deleteWorkflowAtom),
  };
  const addStep = useAtomSet(addStepAtom, { mode: "promiseExit" });
  const addTask = useAtomSet(addTaskAtom, { mode: "promiseExit" });
  const update = useAtomSet(updateTaskAtom, { mode: "promiseExit" });
  const move = useAtomSet(moveTaskAtom, { mode: "promiseExit" });
  const separate = useAtomSet(separateTaskAtom, { mode: "promiseExit" });
  const join = useAtomSet(joinTaskAtom, { mode: "promiseExit" });
  const remove = useAtomSet(removeTaskAtom, { mode: "promiseExit" });
  const apply = useAtomSet(applyDraftAtom, { mode: "promiseExit" });
  const discard = useAtomSet(discardDraftAtom, { mode: "promiseExit" });
  const rename = useAtomSet(updateWorkflowAtom, { mode: "promiseExit" });
  const deleteWorkflow = useAtomSet(deleteWorkflowAtom, { mode: "promiseExit" });

  const taskAnswer = async (exit: Exit.Exit<ShopWork.TaskResult, unknown>) =>
    Exit.match(exit, {
      onSuccess: async (result) => result,
      onFailure: thrown("Couldn't save the change."),
    });

  const presses: Presses = {
    busy: Object.values(waiting).some(Boolean),
    adding: waiting.addStep || waiting.addTask,
    updating: waiting.update,
    removing: waiting.remove,
    applying: waiting.apply,
    discarding: waiting.discard,
    renaming: waiting.rename,
    deleting: waiting.delete,
    add: async ({ step, instructions, ...fields }) => {
      // The add inputs leave out instructions they do not carry; they take no `null`.
      const task = { workflowId, ...fields, ...(instructions === null ? {} : { instructions }) };
      return taskAnswer(
        step === null
          ? await addStep({ payload: task })
          : await addTask({ payload: { ...task, step } }),
      );
    },
    update: async (input) => taskAnswer(await update({ payload: input })),
    move: async (input) => taskAnswer(await move({ payload: input })),
    separate: async (taskId) => taskAnswer(await separate({ payload: { taskId } })),
    join: async (taskId) => taskAnswer(await join({ payload: { taskId } })),
    remove: async (taskId) => taskAnswer(await remove({ payload: { taskId } })),
    apply: async () =>
      Exit.match(await apply({ payload: { workflowId } }), {
        onSuccess: async (result) => {
          if (result._tag === "Ok") {
            hideModal(APPLY_MODAL);
            toast("Changes applied");
            await props.onApplied();
          }
          return result;
        },
        onFailure: thrown("Couldn't apply the changes."),
      }),
    discard: async () =>
      Exit.match(await discard({ payload: { workflowId } }), {
        onSuccess: async (result) => {
          if (result._tag === "Ok") {
            hideModal(DISCARD_MODAL);
            toast("Draft discarded");
            await props.onChanged();
          }
          return result;
        },
        onFailure: thrown("Couldn't discard the changes."),
      }),
    rename: async (name) =>
      Exit.match(await rename({ payload: { workflowId, name } }), {
        onSuccess: async (result) => {
          if (result._tag === "Ok") {
            hideModal(RENAME_MODAL);
            toast(RENAMED_TOAST);
            await props.onChanged();
          }
          return result;
        },
        onFailure: thrown("Couldn't rename the workflow."),
      }),
    deleteWorkflow: async () =>
      Exit.match(await deleteWorkflow({ payload: { workflowId } }), {
        onSuccess: async (result) => {
          if (result._tag === "Deleted") {
            hideModal(DELETE_MODAL);
            toast(DELETED_TOAST.workflow);
            await props.onDeleted();
          }
          return result;
        },
        onFailure: thrown("Couldn't delete the workflow."),
      }),
  };
  return hydrated ? presses : IDLE_PRESSES;
}

const idle = async () => "Not ready.";

/** Until React has hydrated nothing presses. */
const IDLE_PRESSES: Presses = {
  busy: false,
  adding: false,
  updating: false,
  removing: false,
  applying: false,
  discarding: false,
  renaming: false,
  deleting: false,
  add: idle,
  update: idle,
  move: idle,
  separate: idle,
  join: idle,
  remove: idle,
  apply: idle,
  discard: idle,
  rename: idle,
  deleteWorkflow: idle,
};

function Editor(props: WorkflowEditorProps & { readonly detail: ShopWork.WorkflowPageData }) {
  return <EditorScreen {...props} presses={useEditorPresses(props)} />;
}

/**
 * The workflow editor: its own route, so the workflow page can stay a read-only answer to "what
 * does this workflow do". Edit and Create open it in an App Bridge `s-app-window` (Flow's
 * full-screen chrome, `chrome=window`, `inWindow`); Duplicate lands on it as a page of the app's
 * frame. In the window the admin's title bar follows the `s-page` the window loaded with, so that
 * element must outlive hydration ({@link useEditorPresses}).
 *
 * Opening it writes nothing. The canvas shows the draft when one exists and the workflow itself
 * when one does not: the first change is what creates the draft, and because a task keeps its id
 * from the workflow into the draft (`editDraft` on the repository) the task being edited is the
 * same task either way.
 *
 * The header is the state, in one primary button and one badge:
 *
 * - never applied: `Draft`, and **Turn on**, which applies and turns on in one confirmed step
 *   (`MerchantApplyAndTurnOn`). Apply on its own would leave the merchant with tasks in force
 *   that create nothing, then ask them to turn on the thing they just applied;
 * - applied with no draft: no badge, and the plain switch, because there is nothing here to
 *   commit;
 * - applied with a draft: `Draft`, **Discard changes** and **Apply changes**, and no switch: the
 *   switch is about what is in force, and what is in force is not what is on the canvas.
 *
 * Close leaves the draft alone; only Apply and Discard end it. Its data is the loader's (no live
 * read); until React has hydrated nothing presses.
 */
export default function WorkflowEditorPage(props: WorkflowEditorProps) {
  if (props.detail === null)
    return (
      <s-page heading="Workflow not found">
        {!props.inWindow && (
          <s-link slot="breadcrumb-actions" {...props.closeLink}>
            Workflows
          </s-link>
        )}
        <s-paragraph color="subdued">That workflow no longer exists.</s-paragraph>
      </s-page>
    );
  return <Editor {...props} detail={props.detail} />;
}

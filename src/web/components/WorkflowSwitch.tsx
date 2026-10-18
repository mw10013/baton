import { useAtomSet } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as ShopWork from "../../domain/shop-work.ts";
import { hideModal } from "../client/polaris-modal.ts";
import { applyAndTurnOnAtom, setWorkflowStateAtom } from "../client/shop-actor-client.ts";
import { thrownCopy } from "./form.ts";
import { usePressWaiting } from "./press-waiting.ts";
import { Things } from "./screen/Things.tsx";
import { TURN_OFF_BODY, TURN_OFF_HEADING, turnOnBlocker } from "./workflow-shared.ts";

/** The Turn on dialog's id. */
const TURN_ON_MODAL = "turn-on-workflow";
/** The Turn off dialog's id. */
const TURN_OFF_MODAL = "turn-off-workflow";

/** The result of a press of Turn on, for the page's critical banner. Imperative: it names the next action. Nothing shows it before the press: the disabled switch already says it (the copy table's banner row). */
const switchResultMessage = Match.typeTags<ShopWork.SwitchResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoTasks: () => "Add a step to this workflow.",
  TaskUnassigned: ({ taskNames }) => `Assign a team to ${taskNames.join(", ")}.`,
});

/** {@link WorkflowSwitch}'s props. */
export interface WorkflowSwitchProps {
  readonly workflow: ShopWork.Workflow;
  /** The tasks Turn on will check: the workflow's own, or the draft's when {@link appliesFirst} will promote them. */
  readonly tasks: readonly ShopWork.TaskWithTeamName[];
  /** The rule that will create runs once the workflow is active, for the Turn on dialog's first line. */
  readonly turnOnBody: string;
  /** Where the button goes: both surfaces make it the primary, but the editor and the detail page slot their other controls differently. */
  readonly slot: "primary-action" | "secondary-actions";
  /**
   * False hides the button. The detail page hides it while an inactive workflow has a draft:
   * what the merchant would be turning on is not what the editor is holding.
   */
  readonly showControl?: boolean;
  /**
   * Turn on applies the draft in the same press, for a workflow that has never been applied:
   * promoting tasks that have never run and turning the workflow on are one decision
   * (`MerchantApplyAndTurnOn`).
   */
  readonly appliesFirst?: boolean;
  readonly onChanged: () => Promise<void>;
  /** A banner line, or `null` to clear it. */
  readonly onMessage: (message: string | null) => void;
}

/** The two presses, or none before hydration, when nothing presses. */
interface SwitchPress {
  readonly switching: boolean;
  readonly press: (state: ShopWork.WorkflowState) => void;
}

function WorkflowSwitchScreen({
  workflow,
  tasks,
  turnOnBody,
  slot,
  showControl = true,
  switching,
  press,
}: WorkflowSwitchProps & SwitchPress) {
  const blocker = turnOnBlocker(tasks);
  return (
    <>
      {showControl &&
        (ShopWork.workflowIsActive(workflow) ? (
          <s-button
            slot={slot}
            variant="primary"
            tone="critical"
            loading={switching}
            disabled={switching}
            commandFor={TURN_OFF_MODAL}
            command="--show"
          >
            {ShopWork.SWITCH_TITLE_LABEL.turnOff}
          </s-button>
        ) : (
          <s-button
            slot={slot}
            variant="primary"
            disabled={switching || blocker !== null}
            commandFor={TURN_ON_MODAL}
            command="--show"
          >
            {ShopWork.SWITCH_TITLE_LABEL.turnOn}
          </s-button>
        ))}

      <s-modal id={TURN_ON_MODAL} heading={`Turn on ${workflow.name}?`}>
        <Things>
          <s-paragraph>{turnOnBody}</s-paragraph>
        </Things>
        <s-button slot="secondary-actions" commandFor={TURN_ON_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={switching}
          disabled={switching}
          onClick={() => {
            press("active");
          }}
        >
          {ShopWork.VERB_LABEL.turnOn.merchant}
        </s-button>
      </s-modal>

      <s-modal id={TURN_OFF_MODAL} heading={TURN_OFF_HEADING}>
        <s-paragraph>{TURN_OFF_BODY}</s-paragraph>
        <s-button slot="secondary-actions" commandFor={TURN_OFF_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={switching}
          disabled={switching}
          onClick={() => {
            press("inactive");
          }}
        >
          {ShopWork.VERB_LABEL.turnOff.merchant}
        </s-button>
      </s-modal>
    </>
  );
}

/**
 * The switch's press: Turn off and Turn on are `MerchantSetWorkflowState`, Turn on for a
 * never-applied workflow `MerchantApplyAndTurnOn`, on the layout's socket, once hydrated. The
 * union answers the banner; anything thrown (a lost socket, a defect) is {@link thrownCopy}'s. A
 * hook, not a live component swapped in at hydration, so the title-bar button and its dialogs
 * keep their elements; the editor's `useEditorPresses` says why that matters in its window.
 */
function useSwitchPress(props: WorkflowSwitchProps): SwitchPress {
  const hydrated = useHydrated();
  const workflowId = props.workflow.id;
  // Both reads run on every render: a `||` between them would skip the second hook while the
  // first is waiting.
  const settingState = usePressWaiting(setWorkflowStateAtom);
  const applyingAndTurningOn = usePressWaiting(applyAndTurnOnAtom);
  const switching = settingState || applyingAndTurningOn;
  const setState = useAtomSet(setWorkflowStateAtom, { mode: "promiseExit" });
  const applyAndTurnOn = useAtomSet(applyAndTurnOnAtom, { mode: "promiseExit" });
  const press = (state: ShopWork.WorkflowState) => {
    void (async () => {
      const exit =
        ShopWork.workflowIsActive({ state }) && props.appliesFirst === true
          ? await applyAndTurnOn({ payload: { workflowId } })
          : await setState({ payload: { workflowId, state } });
      Exit.match(exit, {
        onSuccess: (result) => {
          props.onMessage(switchResultMessage(result));
          if (result._tag === "Ok") {
            // The element, not `shopify.modal.hide`: inside the editor's window the host's
            // registry cannot see this document's modals (`hideModal`).
            hideModal(TURN_ON_MODAL);
            hideModal(TURN_OFF_MODAL);
          }
        },
        onFailure: (cause) => {
          props.onMessage(thrownCopy(Cause.squash(cause), "Couldn't change the workflow."));
        },
      });
      await props.onChanged();
    })();
  };
  return hydrated ? { switching, press } : { switching: false, press: () => {} };
}

/**
 * The switch of the workflow page and of the editor: the Turn on / Turn off button and the Turn
 * on and Turn off dialogs. A component of its own so neither surface can restate the rule in its
 * own words.
 *
 * The title-bar button names its noun (Turn on workflow, Turn off workflow) and each modal's
 * primary is the verb alone, by the controls table's "a verb in the title bar" row
 * ({@link ShopWork.SWITCH_TITLE_LABEL}).
 *
 * Both directions confirm. Turn off is destructive in the merchant's terms (the floor stops
 * getting new work), so it is the critical primary and asks first, the same shape as Turn on.
 * Until React has hydrated nothing presses.
 */
export function WorkflowSwitch(props: WorkflowSwitchProps) {
  return <WorkflowSwitchScreen {...props} {...useSwitchPress(props)} />;
}

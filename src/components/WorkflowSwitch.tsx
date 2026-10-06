import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation } from "@tanstack/react-query";
import { Match, Schema } from "effect";

import { Things } from "@/components/screen/Things";
import * as Domain from "@/lib/Domain";
import { hideModal } from "@/lib/polarisModal";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import {
  TURN_OFF_BODY,
  TURN_OFF_HEADING,
  TURNED_OFF,
  turnOnBlocker,
} from "@/lib/workflowShared";

/**
 * The on/off switch of the workflow page and of the editor: the Turn on /
 * Turn off button and the Turn on and Turn off dialogs. A component of its
 * own so neither surface can restate the rule in its own words.
 *
 * Both directions confirm. Turn off is destructive in the merchant's terms —
 * the floor stops getting new work — so it is the critical primary and asks
 * first, the same shape as Turn on.
 */
const TURN_ON_MODAL = "turn-on-workflow";
const TURN_OFF_MODAL = "turn-off-workflow";

const decodeSwitchResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.SwitchResult),
);

/** The result of a press of Turn on, for the page's critical banner. Imperative: it names the next action. Nothing shows it before the press: the disabled switch already says it (the copy table's banner row on `CopySlot`). */
const switchResultMessage = Match.typeTags<
  Domain.SwitchResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoTasks: () => "Add a step to this workflow.",
  TaskUnassigned: ({ taskNames }) =>
    `Assign a team to ${taskNames.join(", ")}.`,
});

export function WorkflowSwitch({
  workflow,
  tasks,
  turnOnBody,
  slot,
  showControl = true,
  appliesFirst = false,
  onChanged,
  onMessage,
}: {
  readonly workflow: Domain.Workflow;
  /** The tasks Turn on will check: the workflow's own, or the draft's when {@link appliesFirst} will promote them. */
  readonly tasks: readonly Domain.TaskWithTeamName[];
  /** The rule that will create runs once the switch is on, for the Turn on dialog's first line. */
  readonly turnOnBody: string;
  /** Where the button goes: both surfaces make it the primary, but the editor and the detail page slot their other controls differently. */
  readonly slot: "primary-action" | "secondary-actions";
  /**
   * False hides the button. The detail page hides it while a
   * workflow that is off has a draft: what the merchant would be turning on is
   * not what the editor is holding.
   */
  readonly showControl?: boolean;
  /**
   * Turn on applies the draft in the same click, for a workflow that has
   * never been applied: promoting tasks that have never run and switching the
   * workflow on are one decision (`ShopAgent.applyAndTurnOn`).
   */
  readonly appliesFirst?: boolean;
  readonly onChanged: () => Promise<void>;
  /** A banner line, or `null` to clear it. */
  readonly onMessage: (message: string | null) => void;
}) {
  const workflowId = workflow.id;
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();

  const call = <A,>(
    op: (stub: NonNullable<typeof agent>["stub"]) => Promise<A>,
  ) =>
    agent
      ? withSocketRecovery(agent)(() => op(agent.stub))
      : Promise.reject(new Error("Still connecting. Try again in a moment."));

  const onError = (error: Error) => {
    onMessage(error.message);
  };

  const switchMutation = useMutation({
    mutationFn: (input: { readonly on: boolean }) =>
      call((stub) =>
        input.on && appliesFirst
          ? stub.applyAndTurnOn({ workflowId })
          : stub.setWorkflowOn({ workflowId, on: input.on }),
      ).then(decodeSwitchResult),
    onSuccess: async (result) => {
      onMessage(switchResultMessage(result));
      if (result._tag === "Ok") {
        /* `hideModal`, not `shopify.modal.hide`: inside the editor's
           `s-app-window` the host registry cannot see this document's modals
           (the JSDoc on `hideModal`), and the element call works on both
           surfaces. */
        hideModal(TURN_ON_MODAL);
        hideModal(TURN_OFF_MODAL);
        shopify.toast.show(
          Domain.workflowIsOn(result.workflow)
            ? "Turned on."
            : `${TURNED_OFF}.`,
        );
      }
      await onChanged();
    },
    onError,
  });

  const blocker = turnOnBlocker(tasks);
  const switching = switchMutation.isPending;

  return (
    <>
      {showControl &&
        (Domain.workflowIsOn(workflow) ? (
          <s-button
            slot={slot}
            variant="primary"
            tone="critical"
            loading={switching}
            disabled={!identified || switching}
            commandFor={TURN_OFF_MODAL}
            command="--show"
          >
            {Domain.VERB_LABEL.turnOff.merchant}
          </s-button>
        ) : (
          <s-button
            slot={slot}
            variant="primary"
            disabled={!identified || switching || blocker !== null}
            commandFor={TURN_ON_MODAL}
            command="--show"
          >
            {Domain.VERB_LABEL.turnOn.merchant}
          </s-button>
        ))}

      <s-modal id={TURN_ON_MODAL} heading={`Turn on ${workflow.name}?`}>
        <Things>
          <s-paragraph>{turnOnBody}</s-paragraph>
          {appliesFirst && (
            <s-paragraph>Your tasks are applied at the same time.</s-paragraph>
          )}
        </Things>
        <s-button
          slot="secondary-actions"
          commandFor={TURN_ON_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={switching}
          disabled={!identified || switching}
          onClick={() => {
            switchMutation.mutate({ on: true });
          }}
        >
          {Domain.VERB_LABEL.turnOn.merchant}
        </s-button>
      </s-modal>

      <s-modal id={TURN_OFF_MODAL} heading={TURN_OFF_HEADING}>
        <s-paragraph>{TURN_OFF_BODY}</s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={TURN_OFF_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={switching}
          disabled={!identified || switching}
          onClick={() => {
            switchMutation.mutate({ on: false });
          }}
        >
          {Domain.VERB_LABEL.turnOff.merchant}
        </s-button>
      </s-modal>
    </>
  );
}

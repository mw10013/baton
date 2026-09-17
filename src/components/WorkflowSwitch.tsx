import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { hideModal } from "@/lib/polarisModal";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import {
  changeActivatedAtResultMessage,
  startedToast,
  TURN_OFF_BODY,
  TURN_OFF_HEADING,
  TURNED_OFF,
  turnOnBlocker,
  waitingOrdersLine,
} from "@/lib/workflowShared";

/**
 * The on/off switch of the workflow page and of the editor: the Turn on /
 * Turn off button, the Turn on and Turn off dialogs, and the Change dialog
 * behind the "Applies to orders placed since" line. A component of its own
 * because the dialogs are the one place the merchant decides which orders a
 * workflow covers: owning them here means neither surface can restate the
 * rule in its own words.
 *
 * Both directions confirm. Turn off is destructive in the merchant's terms —
 * the floor stops getting new work — so it is the critical primary and asks
 * first, the same shape as Turn on.
 *
 * The Turn on dialog asks about a count, not a date. Opening it reads
 * `countWaitingOrders`; when earlier open orders would match, one extra
 * line names them and an unchecked **Include them** box offers to cover
 * them, which sends the earliest one's placed date as `activatedAt`. On a
 * fresh shop the count is zero and the dialog is a plain confirm.
 *
 * Change takes a date only, in the browser's timezone at midnight, because
 * that is how the merchant thinks of a cut-off; Turn on and Include them
 * keep exact instants.
 */
const TURN_ON_MODAL = "turn-on-workflow";
const TURN_OFF_MODAL = "turn-off-workflow";
export const CHANGE_ACTIVATED_AT_MODAL = "change-activated-at";

const decodeActivateResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.ActivateResult),
);
const decodeChangeActivatedAtResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.ChangeActivatedAtResult),
);
const decodeWaitingOrders = Schema.decodeUnknownPromise(
  Schema.toType(Domain.WaitingOrders),
);

/** Imperative: a blocker banner's job is to name the next action, not to restate the state the badges already carry. */
export const activateResultMessage = Match.typeTags<
  Domain.ActivateResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoSteps: () => "Add a step to this workflow.",
  StepUnassigned: ({ stepNames }) =>
    `Assign a team to ${stepNames.join(", ")}.`,
});

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of an instant in the browser's timezone, for the date field. */
const toDateInput = (instant: number) => {
  const date = new Date(instant);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Midnight of a `YYYY-MM-DD` in the browser's timezone, or null when the field is not a whole date. */
const fromDateInput = (value: string): number | null => {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(value);
  const { year, month, day } = match?.groups ?? {};
  if (year === undefined || month === undefined || day === undefined)
    return null;
  const instant = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
  ).getTime();
  return Number.isNaN(instant) ? null : instant;
};

/** The one sentence under the badges of an on workflow, with its Change control. */
export function AppliesSince({
  activatedAt,
  disabled,
}: {
  readonly activatedAt: number;
  readonly disabled: boolean;
}) {
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      {/* One sentence under the badges of an on workflow: what "on" covers, in the merchant's word for the date. */}
      <s-text color="subdued">
        Applies to orders placed since <LocalDateTime value={activatedAt} />
      </s-text>
      <s-button
        variant="tertiary"
        disabled={disabled}
        commandFor={CHANGE_ACTIVATED_AT_MODAL}
        command="--show"
      >
        Change
      </s-button>
    </s-stack>
  );
}

export function WorkflowSwitch({
  workflow,
  steps,
  turnOnBody,
  slot,
  showControl = true,
  appliesFirst = false,
  onChanged,
  onMessage,
}: {
  readonly workflow: Domain.Workflow;
  /** The steps Turn on will check: the workflow's own, or the draft's when {@link appliesFirst} will promote them. */
  readonly steps: readonly Domain.StepWithTeamName[];
  /** The rule that will start runs once the switch is on, for the Turn on dialog's first line. */
  readonly turnOnBody: string;
  /** Where the button goes: both surfaces make it the primary, but the editor and the detail page slot their other controls differently. */
  readonly slot: "primary-action" | "secondary-actions";
  /**
   * False hides the button and keeps the dialogs, which the Change control on
   * {@link AppliesSince} still needs. The detail page hides it while an
   * inactive workflow has a draft: what the merchant would be turning on is
   * not what the editor is holding.
   */
  readonly showControl?: boolean;
  /**
   * Turn on applies the draft in the same click, for a workflow that has
   * never been applied: promoting steps that have never run and switching the
   * workflow on are one decision (`ShopAgent.applyAndActivate`).
   */
  readonly appliesFirst?: boolean;
  readonly onChanged: () => Promise<void>;
  /** A banner line, or `null` to clear it. */
  readonly onMessage: (message: string | null) => void;
}) {
  const workflowId = workflow.id;
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const [includeWaiting, setIncludeWaiting] = React.useState(false);
  const [turnOnOpen, setTurnOnOpen] = React.useState(false);
  const [date, setDate] = React.useState(() =>
    toDateInput(workflow.activatedAt ?? Date.now()),
  );

  const call = <A,>(
    op: (stub: NonNullable<typeof agent>["stub"]) => Promise<A>,
  ) =>
    agent
      ? withSocketRecovery(agent)(() => op(agent.stub))
      : Promise.reject(new Error("Still connecting. Try again in a moment."));

  const onError = (error: Error) => {
    onMessage(error.message);
  };

  /**
   * Read when the dialog opens, not on page load: the count walks the open
   * orders' line items, which is fine once per decision and wasteful on
   * every visit to a page that mostly shows steps.
   */
  const waiting = useQuery({
    queryKey: ["countWaitingOrders", workflowId],
    queryFn: () =>
      call((stub) => stub.countWaitingOrders({ workflowId })).then(
        decodeWaitingOrders,
      ),
    enabled: turnOnOpen && identified,
  });

  const activeMutation = useMutation({
    mutationFn: (input: { readonly active: boolean }) => {
      const coverage =
        input.active &&
        includeWaiting &&
        waiting.data?.earliestProcessedAt !== null &&
        waiting.data?.earliestProcessedAt !== undefined
          ? { activatedAt: waiting.data.earliestProcessedAt }
          : {};
      return call((stub) =>
        input.active && appliesFirst
          ? stub.applyAndActivate({ workflowId, ...coverage })
          : stub.setWorkflowActive({
              workflowId,
              active: input.active,
              ...coverage,
            }),
      ).then(decodeActivateResult);
    },
    onSuccess: async (result) => {
      onMessage(activateResultMessage(result));
      if (result._tag === "Ok") {
        /* `hideModal`, not `shopify.modal.hide`: inside the editor's
           `s-app-window` the host registry cannot see this document's modals
           (the JSDoc on `hideModal`), and the element call works on both
           surfaces. */
        hideModal(TURN_ON_MODAL);
        hideModal(TURN_OFF_MODAL);
        setIncludeWaiting(false);
        /* Turn off starts runs when it resolves an ambiguity, and that is
           the more useful half to report; with nothing started, the
           reassurance about work in progress is. */
        const turnedOff =
          result.started === 0
            ? "Turned off. Open runs finish."
            : startedToast(TURNED_OFF, result.started);
        shopify.toast.show(
          Domain.isActive(result.workflow)
            ? startedToast("Turned on", result.started)
            : turnedOff,
        );
      }
      await onChanged();
    },
    onError,
  });

  const changeMutation = useMutation({
    mutationFn: (activatedAt: number) =>
      call((stub) =>
        stub.setWorkflowActivatedAt({ workflowId, activatedAt }),
      ).then(decodeChangeActivatedAtResult),
    onSuccess: async (result) => {
      onMessage(changeActivatedAtResultMessage(result));
      if (result._tag === "Ok") {
        hideModal(CHANGE_ACTIVATED_AT_MODAL);
        shopify.toast.show(startedToast("Updated", result.started));
      }
      await onChanged();
    },
    onError,
  });

  /**
   * The date field is a copy, so a start date changed underneath — another
   * tab, a reload — would leave the modal offering to save a date the server
   * no longer has. Re-seed during render rather than from an effect: React
   * re-runs this component with the new value before committing, where an
   * effect would paint the stale copy and cascade a second render to fix it.
   * The guard keeps it a re-seed and not a reset — picking a date changes
   * `date`, never `activatedAt`.
   */
  const loadedActivatedAt = workflow.activatedAt;
  const [seededActivatedAt, setSeededActivatedAt] =
    React.useState(loadedActivatedAt);
  if (loadedActivatedAt !== null && loadedActivatedAt !== seededActivatedAt) {
    setSeededActivatedAt(loadedActivatedAt);
    setDate(toDateInput(loadedActivatedAt));
  }

  const blocker = turnOnBlocker(steps);
  const switching = activeMutation.isPending;
  const chosen = fromDateInput(date);
  const waitingLine =
    waiting.data === undefined ? null : waitingOrdersLine(waiting.data);

  return (
    <>
      {showControl &&
        (Domain.isActive(workflow) ? (
          <s-button
            slot={slot}
            variant="primary"
            tone="critical"
            loading={switching}
            disabled={!identified || switching}
            commandFor={TURN_OFF_MODAL}
            command="--show"
          >
            Turn off
          </s-button>
        ) : (
          <s-button
            slot={slot}
            variant="primary"
            disabled={!identified || switching || blocker !== null}
            commandFor={TURN_ON_MODAL}
            command="--show"
          >
            Turn on
          </s-button>
        ))}

      <s-modal
        id={TURN_ON_MODAL}
        heading={`Turn on ${workflow.name}?`}
        onShow={() => {
          setTurnOnOpen(true);
        }}
        onHide={() => {
          setTurnOnOpen(false);
          setIncludeWaiting(false);
        }}
      >
        <s-stack gap="base">
          <s-paragraph>{turnOnBody}</s-paragraph>
          {appliesFirst && (
            <s-paragraph>Your steps are applied at the same time.</s-paragraph>
          )}
          {/* Named while it loads: Turn on is disabled until the count is in, and a silent disabled button reads as broken. */}
          {waiting.isFetching && (
            <s-text color="subdued">Checking earlier orders…</s-text>
          )}
          {waitingLine !== null && (
            <s-stack gap="small-300">
              <s-paragraph>{waitingLine}</s-paragraph>
              <s-checkbox
                label="Include them"
                checked={includeWaiting}
                disabled={switching}
                onChange={(event) => {
                  setIncludeWaiting(event.currentTarget.checked);
                }}
              />
            </s-stack>
          )}
        </s-stack>
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
          disabled={!identified || switching || waiting.isFetching}
          onClick={() => {
            activeMutation.mutate({ active: true });
          }}
        >
          Turn on
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
            activeMutation.mutate({ active: false });
          }}
        >
          Turn off
        </s-button>
      </s-modal>

      <s-modal id={CHANGE_ACTIVATED_AT_MODAL} heading="Change the start date">
        <s-stack gap="base">
          <s-paragraph>
            Runs start on orders placed on or after this date. Earlier orders
            are never touched.
          </s-paragraph>
          <s-date-field
            label="Applies to orders placed since"
            value={date}
            disabled={changeMutation.isPending}
            onChange={(event) => {
              setDate(event.currentTarget.value);
            }}
          />
          {workflow.activatedAt !== null && (
            <s-text color="subdued">
              Currently <LocalDateTime value={workflow.activatedAt} />.
            </s-text>
          )}
        </s-stack>
        <s-button
          slot="secondary-actions"
          commandFor={CHANGE_ACTIVATED_AT_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={changeMutation.isPending}
          disabled={!identified || changeMutation.isPending || chosen === null}
          onClick={() => {
            if (chosen !== null) changeMutation.mutate(chosen);
          }}
        >
          Save
        </s-button>
      </s-modal>
    </>
  );
}

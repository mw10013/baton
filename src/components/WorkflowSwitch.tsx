import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Match, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { formatDateTime } from "@/lib/format";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import {
  appliesSinceLine,
  changeActivatedAtResultMessage,
  startedToast,
  turnOnBlocker,
  waitingOrdersLine,
} from "@/lib/workflowShared";

/**
 * The on/off switch of a workflow page, item and order alike: the Turn on /
 * Turn off button in the page's secondary actions, the Turn on dialog, and
 * the Change dialog behind the "Applies to orders placed since" line.
 * Shared because the two pages are copies that must not drift here: the
 * dialogs are the one place the merchant decides which orders a workflow
 * covers, and both pages have to ask the same question the same way.
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

export const activateResultMessage = Match.typeTags<
  Domain.ActivateResult,
  string | null
>()({
  Ok: () => null,
  NotFound: () => "That workflow no longer exists.",
  NoSteps: () => "This workflow has no steps. Edit to add some, then apply.",
  StepUnassigned: ({ stepNames }) =>
    `These steps have no team: ${stepNames.join(", ")}.`,
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
      <s-text color="subdued">{appliesSinceLine(activatedAt)}</s-text>
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
  onChanged,
  onMessage,
}: {
  readonly workflow: Domain.Workflow;
  /** The workflow's own steps (never the draft's): what Turn on checks. */
  readonly steps: readonly Domain.StepWithTeamName[];
  /** The rule that will start runs once the switch is on, for the Turn on dialog's first line. */
  readonly turnOnBody: string;
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
    mutationFn: (input: { readonly active: boolean }) =>
      call((stub) =>
        stub.setWorkflowActive({
          workflowId,
          active: input.active,
          ...(input.active &&
          includeWaiting &&
          waiting.data?.earliestProcessedAt !== null &&
          waiting.data?.earliestProcessedAt !== undefined
            ? { activatedAt: waiting.data.earliestProcessedAt }
            : {}),
        }),
      ).then(decodeActivateResult),
    onSuccess: async (result) => {
      onMessage(activateResultMessage(result));
      if (result._tag === "Ok") {
        await shopify.modal.hide(TURN_ON_MODAL);
        setIncludeWaiting(false);
        shopify.toast.show(
          Domain.isActive(result.workflow)
            ? startedToast("Turned on", result.started)
            : "Turned off. Open runs finish.",
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
        await shopify.modal.hide(CHANGE_ACTIVATED_AT_MODAL);
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
      {Domain.isActive(workflow) ? (
        <s-button
          slot="secondary-actions"
          loading={switching}
          disabled={!identified || switching}
          onClick={() => {
            activeMutation.mutate({ active: false });
          }}
        >
          Turn off
        </s-button>
      ) : (
        <s-button
          slot="secondary-actions"
          disabled={!identified || switching || blocker !== null}
          commandFor={TURN_ON_MODAL}
          command="--show"
        >
          Turn on
        </s-button>
      )}

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
              {`Currently ${formatDateTime(workflow.activatedAt)}.`}
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

import * as React from "react";

import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import {
  FlagBanner,
  liftFlagLabel,
  Prose,
  RunItem,
} from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useMemberRunActions } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const ParamsInput = Schema.Struct({
  shop: Schema.String,
  runId: Schema.String,
});

/**
 * The work page's first paint, SSR like the queue's. `getRunForMember`
 * answers `null` for a run that is not there *or* not on one of the member's
 * teams — one answer, so a member cannot probe run ids — and the page renders
 * its not-found state for both.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ParamsInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, memberId, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        const view = yield* (yield* ShopAgentClient).getRunForMember(shop, {
          runId: data.runId,
          teamIds: teams.map((team) => team.id),
        });
        return {
          shop,
          memberId,
          memberEmail: user.email,
          teams,
          view,
        } satisfies Domain.RunLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/work/$runId")({
  loader: ({ params }) =>
    getLoaderData({ data: { shop: params.shop, runId: params.runId } }),
  component: RouteComponent,
});

/**
 * A step's badge and the subdued line under it, in the order a worker asks:
 * done, under way, ready, waiting.
 *
 * **The badge states the step's state and the line never repeats it.** The
 * line is the team, then who and when — "Jewelry · lead@m.com · Sep 21, 3:52
 * AM" under a `Done` badge. Saying "Done by" as well would print the badge's
 * word twice, a stride apart, in every state that has a badge. Waiting is the
 * one state with no badge, so it is the one state whose line carries the verb.
 *
 * The team leads this line rather than sitting beside the step name above it.
 * Step name and team name are both merchant-authored and unbounded, and side
 * by side with only a weight between them "Cast Jewelry" reads as one noun
 * phrase. Here the header line holds one unbounded name and the team is a
 * subdued clause that wraps.
 */
const stepState = (
  step: Domain.RunStepView,
): {
  readonly text: React.ReactNode;
  readonly badge: {
    readonly label: string;
    readonly tone: "neutral" | "success" | "info";
  } | null;
} => {
  const completedBy = Domain.stepCompletedBy(step);
  const startedBy = Domain.stepStartedBy(step);
  if (step.completedAt !== null)
    return {
      badge: { label: "Done", tone: "neutral" },
      text: (
        <>
          {completedBy === null
            ? `${step.teamName} · `
            : `${step.teamName} · ${Domain.actorLabel(completedBy)} · `}
          <LocalDateTime value={step.completedAt} />
        </>
      ),
    };
  if (step.startedAt !== null)
    return {
      badge: { label: "In progress", tone: "success" },
      text: (
        <>
          {startedBy === null
            ? `${step.teamName} · since `
            : `${step.teamName} · ${Domain.actorLabel(startedBy)} · since `}
          <LocalDateTime value={step.startedAt} format="time" />
        </>
      ),
    };
  if (step.ready)
    return { badge: { label: "Ready", tone: "info" }, text: step.teamName };
  return {
    badge: null,
    text: `${step.teamName} · waiting on step ${String(step.stage - 1)}`,
  };
};

/**
 * How much room is left, shown only past `Domain.NOTE_COUNT_FROM`. Without it
 * the cap is invisible until the write refuses a paragraph that is already
 * typed, and the refusal a member would read is the schema's own words. Every
 * field the same text goes into carries it: step notes, the block reason, and
 * the reason editor in the banner.
 */
function NoteCountdown({ draft }: { readonly draft: string }) {
  if (draft.length < Domain.NOTE_COUNT_FROM) return null;
  return (
    <s-text color="subdued">
      {`${formatNumber(Domain.STEP_NOTE_MAX_LENGTH - draft.length)} characters left`}
    </s-text>
  );
}

function RouteComponent() {
  const { shop, memberEmail, teams, view: initialView } = Route.useLoaderData();
  const { runId } = Route.useParams();
  const {
    data: view,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ["shop-run", shop, runId],
    subscribe: (stub, subscriberId) =>
      stub.subscribeRun({ subscriberId, runId }),
    initialData: initialView,
  });
  const actions = useMemberRunActions({
    agent,
    identified,
    onSuccess: () => invalidate(),
  });
  /** Which step's note editor is open and its draft; one at a time. */
  const [noteDraft, setNoteDraft] = React.useState<{
    runStepId: string;
    note: string;
  } | null>(null);
  /**
   * The reason a member is about to put a hold on with, or `null` when the
   * Block editor is closed. Opening it is the page's Block action; the editor
   * renders where the hold's banner will, so the field stands where its own
   * result will stand.
   */
  const [blockDraft, setBlockDraft] = React.useState<string | null>(null);
  /**
   * The reason editor inside the banner, or `null` when closed. It opens
   * holding the reason that is there now — never empty: one field, anyone may
   * write it, last write wins silently, so seeing what you are about to
   * replace is the only warning there is.
   *
   * Stamped with the `flagAt` of the hold it was opened on, and read back
   * through {@link editingReason}, so a draft cannot outlive its hold. Unblock
   * — this member's own, or a teammate's arriving over the socket — takes the
   * banner away mid-edit; a bare string would sit in state and reappear,
   * stale, inside the next block's banner. Every block writes a fresh
   * `flagAt`, so the stamp of the one before it can never match.
   */
  const [reasonDraft, setReasonDraft] = React.useState<{
    at: number | null;
    text: string;
  } | null>(null);
  const teamIds = teams.map((team) => team.id);

  /**
   * The one editor both paths into a hold's text use: Block writes the first
   * reason, Edit reason rewrites it. Same field, same countdown, same Cancel;
   * only the verb and the tone of the commit differ, so the two cannot drift
   * into looking like different features.
   *
   * The label is visible rather than `exclusive`. Block's editor is opened
   * from an action in the page header and appears with no heading of its own,
   * so a hidden label would leave a bare box; the banner's copy keeps it for
   * the same reason the step note does — the control that named the field is
   * not on screen while the field is.
   */
  const reasonEditor = ({
    draft,
    onInput,
    onSubmit,
    onCancel,
    submitLabel,
    critical,
  }: {
    readonly draft: string;
    readonly onInput: (value: string) => void;
    readonly onSubmit: () => void;
    readonly onCancel: () => void;
    readonly submitLabel: string;
    readonly critical?: boolean;
  }) => (
    <s-stack gap="small-300">
      <s-text-area
        label="Reason"
        placeholder="What is stopping this? Who needs to know?"
        rows={3}
        value={draft}
        disabled={actions.pending}
        onInput={(event) => {
          onInput(event.currentTarget.value);
        }}
      />
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-button
          variant="primary"
          {...(critical === true ? { tone: "critical" as const } : {})}
          disabled={actions.pending}
          onClick={onSubmit}
        >
          {submitLabel}
        </s-button>
        <s-button variant="tertiary" onClick={onCancel}>
          Cancel
        </s-button>
        <NoteCountdown draft={draft} />
      </s-stack>
    </s-stack>
  );

  const renderStep = (step: Domain.RunStepView) => {
    if (view === null) return null;
    const state = stepState(step);
    /** Shown only while the slot is filled: the next Done clears it (`Domain.WorkflowRunStep`). */
    const reopenedBy = Domain.stepReopenedBy(step);
    const editingNote = noteDraft?.runStepId === step.id;
    /**
     * The buttons follow {@link Domain.stepActions}; the banner carries the
     * only action a flag allows. Undo is offered where it is allowed and
     * nowhere else: a blocked undo draws no disabled button and no sentence
     * explaining itself, because the step standing in the way is on this same
     * page with an `In progress` badge on it.
     */
    const can = Domain.stepActions(view.run, step, teamIds);
    const anyAction = can.done || can.undo?.blockedBy === null || can.note;
    return (
      <s-box
        key={step.id}
        padding="small"
        borderWidth="base"
        borderRadius="base"
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">
              {`${String(step.stage)} · ${step.name}`}
            </s-text>
            {state.badge !== null && (
              <s-badge tone={state.badge.tone}>{state.badge.label}</s-badge>
            )}
          </s-stack>
          {state.text !== null && <s-text color="subdued">{state.text}</s-text>}
          {reopenedBy !== null && step.reopenedAt !== null && (
            <s-text color="subdued">
              {`Reopened by ${Domain.actorLabel(reopenedBy)} · `}
              <LocalDateTime value={step.reopenedAt} format="relative" />
            </s-text>
          )}
          {step.instructions !== null && <s-text>{step.instructions}</s-text>}
          {!editingNote && step.note !== null && (
            <Prose color="subdued">{Domain.stepNoteLine(step)}</Prose>
          )}
          {/* The editor takes the card's button row with it: Save note is a
              primary, so leaving Done mounted beside it puts two primaries in
              one card and asks which one commits the typing. The label is
              visible because the Add note button that named this field is one
              of the buttons the editor just replaced. */}
          {editingNote && (
            <s-stack gap="small-300">
              <s-text-area
                label="Note"
                rows={3}
                value={noteDraft.note}
                disabled={actions.pending}
                onInput={(event) => {
                  setNoteDraft({
                    runStepId: step.id,
                    note: event.currentTarget.value,
                  });
                }}
              />
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-button
                  variant="primary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.note.mutate(
                      { runStepId: step.id, note: noteDraft.note },
                      {
                        onSuccess: (result) => {
                          if (result._tag === "Ok") setNoteDraft(null);
                        },
                      },
                    );
                  }}
                >
                  Save note
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    setNoteDraft(null);
                  }}
                >
                  Cancel
                </s-button>
                <NoteCountdown draft={noteDraft.note} />
              </s-stack>
            </s-stack>
          )}
          {anyAction && !editingNote && (
            <s-stack direction="inline" gap="base" alignItems="center">
              {can.start && (
                <s-button
                  variant="secondary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.start.mutate(step.id);
                  }}
                >
                  Start
                </s-button>
              )}
              {can.done && (
                <s-button
                  variant="primary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.complete.mutate(step.id);
                  }}
                >
                  Done
                </s-button>
              )}
              {can.undo?.blockedBy === null && (
                <s-button
                  variant="secondary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.uncomplete.mutate(step.id);
                  }}
                >
                  Undo
                </s-button>
              )}
              {can.note && (
                <s-button
                  variant="secondary"
                  disabled={actions.pending}
                  onClick={() => {
                    setNoteDraft({ runStepId: step.id, note: step.note ?? "" });
                  }}
                >
                  {step.note === null ? "Add note" : "Edit note"}
                </s-button>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-box>
    );
  };

  if (view === null)
    return (
      <>
        <MemberBar shop={shop} email={memberEmail} />
        <s-page heading="Not found" inlineSize="small">
          <s-section accessibilityLabel="Not found">
            <s-paragraph color="subdued">
              This work is not on one of your teams, or it no longer exists.
            </s-paragraph>
          </s-section>
        </s-page>
      </>
    );

  const { run } = view;
  /**
   * The open draft, or `null`: a draft stamped with a `flagAt` other than the
   * one on screen belongs to a hold that has since been lifted, and is dead.
   */
  const editingReason =
    Domain.runIsBlocked(run) && reasonDraft?.at === run.flagAt
      ? reasonDraft.text
      : null;
  /** A member may put a hold on work that is running and not already flagged. */
  const canBlock = Domain.runIsOpen(run) && !Domain.runIsFlagged(run);
  /**
   * Unblock lifts the hold and nothing else: the run goes back to the tier
   * and the steps it had, and whoever lifted it presses Done next if the work
   * is in fact done. Dismiss is the other word on purpose — a reconcile flag
   * is not a hold anybody set, and acknowledging it is all there is to do.
   * Edit reason is offered only while no editor is open; the editor's own
   * Save and Cancel are the buttons for that state.
   */
  const flagActions = Domain.runIsFlagged(run) ? (
    <>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        disabled={actions.pending}
        onClick={() => {
          actions.dismiss.mutate(run.id);
        }}
      >
        {liftFlagLabel(run)}
      </s-button>
      {Domain.runIsBlocked(run) && editingReason === null && (
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={actions.pending}
          onClick={() => {
            setReasonDraft({
              at: run.flagAt,
              text: run.flagDetail?.reason ?? "",
            });
          }}
        >
          Edit reason
        </s-button>
      )}
    </>
  ) : null;

  return (
    <>
      <MemberBar shop={shop} email={memberEmail} />
      {/* No breadcrumb: `MemberBar` sits directly above this heading and its
          mark plus shop name is a link to `/shop/$shop`, which is the queue.
          A second link to the same place, a stride below the first, is one
          link too many. */}
      <s-page heading={run.orderName} inlineSize="small">
        {/* Block is a page action rather than a section at the foot of the
            page: a member holds work rarely, and a field mounted for it all
            the time takes space on every visit that does not. Pressing it
            opens the editor below, where the hold's own banner will be. */}
        {canBlock && blockDraft === null && (
          <s-button
            slot="secondary-actions"
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              setBlockDraft("");
            }}
          >
            Block
          </s-button>
        )}
        <SocketBanner />
        {/* Item first, chrome under it: what to make is the reason the page
            was opened, and the workflow name, the run's status and its age
            are the answers to questions asked after that. */}
        <s-section accessibilityLabel={run.orderName}>
          <s-stack gap="base">
            <RunItem run={run} />
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-badge>{run.workflowName}</s-badge>
              {!Domain.runIsOpen(run) &&
                (Domain.runIsLive(run) ? (
                  <s-badge tone="neutral">Done</s-badge>
                ) : (
                  <s-badge tone="critical">Cancelled</s-badge>
                ))}
              <s-text color="subdued">
                ordered{" "}
                <LocalDateTime value={run.orderProcessedAt} format="relative" />
              </s-text>
            </s-stack>
            {actions.banner !== null && (
              <s-banner tone="critical">{actions.banner}</s-banner>
            )}
            <FlagBanner run={run} actions={flagActions}>
              {editingReason === null
                ? undefined
                : reasonEditor({
                    draft: editingReason,
                    onInput: (text) => {
                      setReasonDraft({ at: run.flagAt, text });
                    },
                    onSubmit: () => {
                      actions.setBlockReason.mutate(
                        { runId: run.id, reason: editingReason },
                        {
                          onSuccess: (result) => {
                            if (result._tag === "Ok") setReasonDraft(null);
                          },
                        },
                      );
                    },
                    onCancel: () => {
                      setReasonDraft(null);
                    },
                    submitLabel: "Save reason",
                  })}
            </FlagBanner>
            {canBlock &&
              blockDraft !== null &&
              reasonEditor({
                draft: blockDraft,
                onInput: setBlockDraft,
                onSubmit: () => {
                  actions.block.mutate(
                    { runId: run.id, reason: blockDraft },
                    {
                      onSuccess: (result) => {
                        if (result._tag === "Ok") setBlockDraft(null);
                      },
                    },
                  );
                },
                onCancel: () => {
                  setBlockDraft(null);
                },
                submitLabel: "Block",
                critical: true,
              })}
          </s-stack>
        </s-section>
        <s-section heading="Steps" accessibilityLabel="Steps">
          <s-stack gap="small-300">{view.steps.map(renderStep)}</s-stack>
        </s-section>
        {view.note !== null && view.note.length > 0 && (
          <s-section heading="Order note" accessibilityLabel="Order note">
            <Prose>{view.note}</Prose>
          </s-section>
        )}
      </s-page>
    </>
  );
}

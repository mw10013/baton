import * as React from "react";

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import { FlagBanner, OrderItems, Prose, RunItem } from "@/components/MemberRun";
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

/** What a step's state line says, in the order a worker asks: done, under way, ready, waiting. */
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
            ? "Done · "
            : `Done by ${Domain.actorLabel(completedBy)} · `}
          <LocalDateTime value={step.completedAt} />
        </>
      ),
    };
  if (step.startedAt !== null)
    return {
      badge: { label: "In progress", tone: "success" },
      text: (
        <>
          In progress since{" "}
          <LocalDateTime value={step.startedAt} format="time" />
          {startedBy === null ? "" : ` by ${Domain.actorLabel(startedBy)}`}
        </>
      ),
    };
  if (step.ready)
    return { badge: { label: "Ready", tone: "info" }, text: "Ready" };
  return { badge: null, text: `Waiting on step ${String(step.stage - 1)}` };
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

/**
 * The breadcrumb back to the queue. `s-page`'s `breadcrumb-actions` slot
 * takes link components only, so this is an `s-link` with a real `href` —
 * built through the router so the path is the route's, not a string — whose
 * click is intercepted into a client navigation. The `href` is what makes it
 * a link a member can open in a new tab or middle-click; the handler is what
 * keeps the socket and the query cache alive when they do not.
 *
 * It is kept off the printed job ticket by a selector in `styles.css` rather
 * than the `.print-hide` wrapper every other chrome uses: `class` is not in
 * the Polaris elements' JSX props, and a wrapping div would take the slot in
 * the link's place. The rule matches this element and this element only, so
 * moving or renaming the breadcrumb means fixing it there too.
 */
function QueueBreadcrumb({ shop }: { readonly shop: string }) {
  const router = useRouter();
  const to = { to: "/shop/$shop", params: { shop } } as const;
  return (
    <s-link
      slot="breadcrumb-actions"
      href={router.buildLocation(to).href}
      onClick={(event) => {
        event.preventDefault();
        void router.navigate(to);
      }}
    >
      Queue
    </s-link>
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
  const [reason, setReason] = React.useState("");
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
  const mine = (step: Domain.RunStepView) =>
    step.teamId !== null && teamIds.includes(step.teamId);
  const open =
    view !== null &&
    (view.run.status === "pending" || view.run.status === "active");

  const renderStep = (step: Domain.RunStepView) => {
    if (view === null) return null;
    const state = stepState(step);
    /** Shown only while the slot is filled: the next Done clears it (`Domain.WorkflowRunStep`). */
    const reopenedBy = Domain.stepReopenedBy(step);
    const editingNote = noteDraft?.runStepId === step.id;
    const canAct = mine(step) && open;
    /**
     * A flag stops the work, so Start, Done and Undo go with it; the note
     * button stays, because a held step is exactly the one somebody needs to
     * write on. The banner carries the only action the flag itself allows.
     */
    const acting = canAct && view.run.flag === null;
    const ready = acting && step.ready && step.completedAt === null;
    const finished = acting && step.completedAt !== null;
    return (
      <s-box
        key={step.id}
        padding="small"
        borderWidth="base"
        borderRadius="base"
        background={ready ? "subdued" : "base"}
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">
              {`${String(step.stage)} · ${step.name}`}
            </s-text>
            <s-text color="subdued">{step.teamName}</s-text>
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
          {editingNote && (
            <s-stack gap="small-300">
              <s-text-area
                label="Note"
                labelAccessibilityVisibility="exclusive"
                placeholder="Note about this step"
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
              <s-stack direction="inline" gap="small-300">
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
          {canAct && (
            <s-stack direction="inline" gap="base" alignItems="center">
              {ready && step.startedAt === null && (
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
              {ready && (
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
              {finished &&
                (step.undoBlockedBy === null ? (
                  <s-button
                    variant="secondary"
                    disabled={actions.pending}
                    onClick={() => {
                      actions.uncomplete.mutate(step.id);
                    }}
                  >
                    Undo
                  </s-button>
                ) : (
                  <s-text color="subdued">
                    {`${step.undoBlockedBy.teamName} started ${step.undoBlockedBy.stepName} · ask them`}
                  </s-text>
                ))}
              {!editingNote && (
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
          <QueueBreadcrumb shop={shop} />
          <s-section accessibilityLabel="Not found">
            <s-paragraph color="subdued">
              This work is not on one of your teams, or it no longer exists.
            </s-paragraph>
          </s-section>
        </s-page>
      </>
    );

  const { run } = view;
  const others = view.items.filter(
    (item) => item.lineItemId !== run.lineItemId,
  );
  /**
   * The open draft, or `null`: a draft stamped with a `flagAt` other than the
   * one on screen belongs to a hold that has since been lifted, and is dead.
   */
  const editingReason =
    run.flag === "blocked" && reasonDraft?.at === run.flagAt
      ? reasonDraft.text
      : null;
  /**
   * Unblock lifts the hold and nothing else: the run goes back to the tier
   * and the steps it had, and whoever lifted it presses Done next if the work
   * is in fact done. Dismiss is the other word on purpose — a reconcile flag
   * is not a hold anybody set, and acknowledging it is all there is to do.
   * Edit reason is offered only while no editor is open; the editor's own
   * Save and Cancel are the buttons for that state.
   */
  const flagActions =
    run.flag === null ? null : (
      <>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={actions.pending}
          onClick={() => {
            actions.dismiss.mutate(run.id);
          }}
        >
          {run.flag === "blocked" ? "Unblock" : "Dismiss"}
        </s-button>
        {run.flag === "blocked" && editingReason === null && (
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
    );

  const reasonEditor = (draft: string) => (
    <s-stack gap="small-300">
      <s-text-area
        label="Reason"
        labelAccessibilityVisibility="exclusive"
        placeholder="What is stopping this? Who needs to know?"
        rows={3}
        value={draft}
        disabled={actions.pending}
        onInput={(event) => {
          setReasonDraft({ at: run.flagAt, text: event.currentTarget.value });
        }}
      />
      <s-stack direction="inline" gap="small-300">
        <s-button
          variant="primary"
          disabled={actions.pending}
          onClick={() => {
            actions.setBlockReason.mutate(
              { runId: run.id, reason: draft },
              {
                onSuccess: (result) => {
                  if (result._tag === "Ok") setReasonDraft(null);
                },
              },
            );
          }}
        >
          Save reason
        </s-button>
        <s-button
          variant="tertiary"
          onClick={() => {
            setReasonDraft(null);
          }}
        >
          Cancel
        </s-button>
        <NoteCountdown draft={draft} />
      </s-stack>
    </s-stack>
  );
  return (
    <>
      <MemberBar shop={shop} email={memberEmail} />
      <s-page heading={run.orderName} inlineSize="small">
        <QueueBreadcrumb shop={shop} />
        <SocketBanner />
        {/* Item first, chrome under it: what to make is the reason the page
            was opened, and the workflow name, the run's status and its age
            are the answers to questions asked after that. */}
        <s-section accessibilityLabel={run.orderName}>
          <s-stack gap="base">
            <RunItem run={run} />
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-badge>{run.workflowName}</s-badge>
              {run.status === "done" && <s-badge tone="neutral">Done</s-badge>}
              {run.status === "cancelled" && (
                <s-badge tone="critical">Cancelled</s-badge>
              )}
              <s-text color="subdued">
                ordered{" "}
                <LocalDateTime value={run.orderProcessedAt} format="relative" />
              </s-text>
            </s-stack>
            {actions.banner !== null && (
              <s-banner tone="critical">{actions.banner}</s-banner>
            )}
            <FlagBanner run={run} actions={flagActions}>
              {editingReason === null ? undefined : reasonEditor(editingReason)}
            </FlagBanner>
          </s-stack>
        </s-section>
        <s-section heading="Steps" accessibilityLabel="Steps">
          <s-stack gap="small-300">{view.steps.map(renderStep)}</s-stack>
        </s-section>
        {others.length > 0 && (
          <s-section
            heading="Also on this order"
            accessibilityLabel="Also on this order"
          >
            <OrderItems items={others} />
          </s-section>
        )}
        {view.note !== null && view.note.length > 0 && (
          <s-section heading="Order note" accessibilityLabel="Order note">
            <Prose>{view.note}</Prose>
          </s-section>
        )}
        {/* Only the *setting* of a block lives down here. Lifting it and
            rewriting it are in the banner at the top, because a state and the
            buttons that change it a screen apart read as two facts. */}
        {open && run.flag === null && (
          <s-section heading="Block this work" accessibilityLabel="Block">
            <div className="print-hide">
              <s-stack gap="small-300">
                <s-text-area
                  label="Reason"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="What is stopping this? Who needs to know?"
                  rows={3}
                  value={reason}
                  disabled={actions.pending}
                  onInput={(event) => {
                    setReason(event.currentTarget.value);
                  }}
                />
                <s-stack direction="inline" gap="small-300">
                  <s-button
                    variant="primary"
                    tone="critical"
                    disabled={actions.pending}
                    onClick={() => {
                      actions.block.mutate(
                        { runId: run.id, reason },
                        {
                          onSuccess: (result) => {
                            if (result._tag === "Ok") setReason("");
                          },
                        },
                      );
                    }}
                  >
                    Block
                  </s-button>
                  <NoteCountdown draft={reason} />
                </s-stack>
              </s-stack>
            </div>
          </s-section>
        )}
      </s-page>
    </>
  );
}

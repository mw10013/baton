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
import { BlockModal, RunNoteModal } from "@/components/RunTextModals";
import * as Domain from "@/lib/Domain";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { showModal } from "@/lib/polarisModal";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import {
  errorMessage,
  runResultMessage,
  useMemberRunActions,
} from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";
import * as WorkflowLayout from "@/lib/WorkflowLayout";

const NOTE_MODAL = "run-note";
const BLOCK_MODAL = "run-block";

const ParamsInput = Schema.Struct({
  shop: Schema.String,
  runId: Schema.String,
});

/**
 * The work page's first paint, SSR like the run list's. `getRunForMember`
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

export const Route = createFileRoute("/shop/$shop/workflows/$runId")({
  loader: ({ params }) =>
    getLoaderData({ data: { shop: params.shop, runId: params.runId } }),
  /** The browser tab says what the heading says: the order, or that there is none. */
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.view?.run.orderName ?? "Not found"} — Baton`,
      },
    ],
  }),
  component: RouteComponent,
});

/**
 * A task's badge and the subdued line under it, in the order a worker asks:
 * done, under way, ready, waiting.
 *
 * **The badge states the task's state and the line never repeats it.** The
 * line is the team, then who and when — "Jewelry · lead@m.com · Sep 21, 3:52
 * AM" under a `Done` badge. Saying "Done by" as well would print the badge's
 * word twice, a stride apart, in every state that has a badge. Waiting is the
 * one state with no badge, so it is the one state whose line carries the verb.
 *
 * The team leads this line rather than sitting beside the task name above it.
 * Task name and team name are both merchant-authored and unbounded, and side
 * by side with only a weight between them "Cast Jewelry" reads as one noun
 * phrase. Here the header line holds one unbounded name and the team is a
 * subdued clause that wraps.
 */
const taskState = (
  task: Domain.RunTaskView,
): {
  readonly text: React.ReactNode;
  readonly badge: {
    readonly label: string;
    readonly tone: "neutral" | "success" | "info";
  } | null;
} => {
  const completedBy = Domain.taskCompletedBy(task);
  const startedBy = Domain.taskStartedBy(task);
  if (task.completedAt !== null)
    return {
      badge: { label: "Done", tone: "neutral" },
      text: (
        <>
          {completedBy === null
            ? `${task.teamName} · `
            : `${task.teamName} · ${Domain.actorLabel(completedBy)} · `}
          <LocalDateTime value={task.completedAt} />
        </>
      ),
    };
  if (task.startedAt !== null)
    return {
      badge: { label: "In progress", tone: "success" },
      text: (
        <>
          {startedBy === null
            ? `${task.teamName} · since `
            : `${task.teamName} · ${Domain.actorLabel(startedBy)} · since `}
          <LocalDateTime value={task.startedAt} format="time" />
        </>
      ),
    };
  if (task.ready)
    return { badge: { label: "Ready", tone: "info" }, text: task.teamName };
  return {
    badge: null,
    text: `${task.teamName} · waiting on step ${String(task.step - 1)}`,
  };
};

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
  const teamIds = teams.map((team) => team.id);

  const renderTask = (task: Domain.RunTaskView) => {
    if (view === null) return null;
    const state = taskState(task);
    /** Shown only while the slot is filled: the next Done clears it (`Domain.WorkflowRunTask`). */
    const reopenedBy = Domain.taskReopenedBy(task);
    /**
     * The buttons follow {@link Domain.taskActions}; the banner carries the
     * only action a flag allows. Undo and Put back are offered where they are
     * allowed and nowhere else: a blocked undo draws no disabled button and no sentence
     * explaining itself, because the task standing in the way is on this same
     * page with an `In progress` badge on it.
     */
    const can = Domain.taskActions(view.run, task, teamIds);
    const anyAction = can.done || can.putBack || can.undo?.blockedBy === null;
    return (
      <s-box
        key={task.id}
        padding="small"
        borderWidth="base"
        borderRadius="base"
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">{task.name}</s-text>
            {state.badge !== null && (
              <s-badge tone={state.badge.tone}>{state.badge.label}</s-badge>
            )}
          </s-stack>
          {state.text !== null && <s-text color="subdued">{state.text}</s-text>}
          {reopenedBy !== null && task.reopenedAt !== null && (
            <s-text color="subdued">
              {`Reopened by ${Domain.actorLabel(reopenedBy)} · `}
              <LocalDateTime value={task.reopenedAt} format="relative" />
            </s-text>
          )}
          {task.instructions !== null && <s-text>{task.instructions}</s-text>}
          {anyAction && (
            <s-stack direction="inline" gap="base" alignItems="center">
              {can.start && (
                <s-button
                  variant="secondary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.start.mutate(task.id);
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
                    actions.complete.mutate(task.id);
                  }}
                >
                  Done
                </s-button>
              )}
              {can.putBack && (
                <s-button
                  variant="secondary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.unstart.mutate(task.id);
                  }}
                >
                  Put back
                </s-button>
              )}
              {can.undo?.blockedBy === null && (
                <s-button
                  variant="secondary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.uncomplete.mutate(task.id);
                  }}
                >
                  Undo
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
  /** A member may put a hold on work that is running and not already flagged. */
  const canBlock = Domain.runIsOpen(run) && !Domain.runIsFlagged(run);
  /**
   * The note is the run's, not a task's, and a member who can see the page
   * may write it while the run is live: `WorkflowRunRepository.setRunNote`.
   */
  const canNote = Domain.runIsLive(run);
  /**
   * Unblock lifts the hold and nothing else: the run goes back to the tier
   * and the tasks it had, and whoever lifted it presses Done next if the work
   * is in fact done. Dismiss is the other word on purpose — a reconcile flag
   * is not a hold anybody set, and acknowledging it is all there is to do.
   * Unblock takes one tap and no confirmation: Block undoes it.
   */
  const flagActions = Domain.runIsFlagged(run) ? (
    <>
      {Domain.runIsBlocked(run) && (
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={actions.pending}
          onClick={() => {
            showModal(BLOCK_MODAL);
          }}
        >
          Edit
        </s-button>
      )}
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
    </>
  ) : null;
  const hasNote = run.note !== null && run.note.length > 0;

  return (
    <>
      <MemberBar shop={shop} email={memberEmail} />
      {/* No breadcrumb: `MemberBar` sits directly above this heading and its
          mark is the link to `/shop/$shop`, which is the run list. A second
          link to the same place, a stride below the first, is one link too
          many — and the mark's link lands on the list the member left, tab,
          team and depth included, because this page's URL carries their
          context too (`MemberSearch` in `shop.$shop.tsx`). */}
      <s-page heading={run.orderName} inlineSize="small">
        {/* Block stays a visible page action, not an overflow item: it says
            the worker can stop the line. It opens a modal, so no field is
            mounted for it on the visits that do not use it. */}
        {canBlock && (
          <s-button
            slot="secondary-actions"
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              showModal(BLOCK_MODAL);
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
            <FlagBanner run={run} actions={flagActions} />
          </s-stack>
        </s-section>
        {/* The run note second, above the tasks: it is the one answer to
            "anything I should know about this job", and a note under a task
            that is already done is a note nobody reads. On a cancelled run it
            is a record with no button. */}
        {(hasNote || canNote) && (
          <s-section accessibilityLabel="Note">
            <s-stack gap="small-300">
              <s-stack
                direction="inline"
                justifyContent="space-between"
                alignItems="center"
                gap="base"
              >
                <s-heading>Note</s-heading>
                {canNote && (
                  <s-button
                    variant="secondary"
                    disabled={actions.pending}
                    onClick={() => {
                      showModal(NOTE_MODAL);
                    }}
                  >
                    {hasNote ? "Edit" : "Add note"}
                  </s-button>
                )}
              </s-stack>
              {hasNote && <Prose>{run.note}</Prose>}
            </s-stack>
          </s-section>
        )}
        {view.orderNote !== null && view.orderNote.length > 0 && (
          <s-section heading="Order note" accessibilityLabel="Order note">
            <Prose>{view.orderNote}</Prose>
          </s-section>
        )}
        {/* One block per step, like the editor's `StepFlow`: a subdued `Step n`
            label and the step's tasks under it, so parallel tasks read as one
            stop rather than as cards that share a number. */}
        <s-section heading="Steps" accessibilityLabel="Steps">
          <s-stack gap="base">
            {WorkflowLayout.stepsOf(view.tasks).map((group) => {
              const step = group[0]?.step ?? 0;
              return (
                <s-stack key={step} gap="small-300">
                  <s-text color="subdued">{`Step ${String(step)}`}</s-text>
                  {group.map(renderTask)}
                </s-stack>
              );
            })}
          </s-stack>
        </s-section>
        <RunNoteModal
          id={NOTE_MODAL}
          note={run.note}
          pending={actions.pending}
          onSave={(note) =>
            actions.note
              .mutateAsync({ runId: run.id, note })
              .then(runResultMessage)
              .catch(errorMessage)
          }
        />
        <BlockModal
          id={BLOCK_MODAL}
          run={run}
          pending={actions.pending}
          onBlock={(reason) =>
            actions.block
              .mutateAsync({ runId: run.id, reason })
              .then(runResultMessage)
              .catch(errorMessage)
          }
          onSaveReason={(reason) =>
            actions.setBlockReason
              .mutateAsync({ runId: run.id, reason })
              .then(runResultMessage)
              .catch(errorMessage)
          }
        />
      </s-page>
    </>
  );
}

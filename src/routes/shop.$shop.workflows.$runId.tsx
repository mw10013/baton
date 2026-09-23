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
 * word twice, a stride apart, in every state that has a badge. A waiting task
 * has no badge and its line is the team alone: its place under a later
 * `Step n` caption already says what it waits on.
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
  return { badge: null, text: task.teamName };
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

  const renderTask = (task: Domain.RunTaskView, first: boolean) => {
    if (view === null) return null;
    const state = taskState(task);
    /** Shown only while the slot is filled: the next Done clears it (`Domain.WorkflowRunTask`). */
    const reopenedBy = Domain.taskReopenedBy(task);
    /**
     * The buttons follow {@link Domain.taskActions}, which also says why none
     * is primary; the banner carries the only action a flag allows. The badge
     * carries the state and the buttons are its exits, the advancing one
     * first: `Start · Done`, `Done · Put back`, `Undo`. Undo and Put back are
     * offered where they are allowed and nowhere else: a blocked undo draws no
     * disabled button and no sentence explaining itself, because the task
     * standing in the way is on this same page with an `In progress` badge on
     * it.
     */
    const can = Domain.taskActions(view.run, task, teamIds);
    const anyAction = can.done || can.putBack || can.undo?.blockedBy === null;
    return (
      <s-box
        key={task.id}
        padding="small"
        borderWidth={first ? "none" : "base none none none"}
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
                  variant="secondary"
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
  const hasOrderNote = view.orderNote !== null && view.orderNote.length > 0;

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
        {/* No `s-section` on this page: a top-level section is a card
            whether or not it has a heading, and the item, the note and the
            steps are plain text on the page, with the step boxes the only
            borders. The stack gives them the spacing sections would, and
            `.member-work` the phone inset (`styles.css`). */}
        <div className="member-work">
          <s-stack gap="base">
            <SocketBanner />
            {/* Page-wide banners sit at page level, above the content they
              concern and outside any card, as Polaris places them. */}
            {actions.banner !== null && (
              <s-banner tone="critical">{actions.banner}</s-banner>
            )}
            <FlagBanner run={run} actions={flagActions} />
            {/* Item first: what to make is why the page was opened. No workflow
              name or age, because a member cannot act on either and the run
              list carries the age. No border, because two bordered blocks on
              one page compete. The Done / Cancelled badge stays: it is the
              only sign the page is read-only. */}
            <s-stack gap="small-300">
              {!Domain.runIsOpen(run) &&
                (Domain.runIsLive(run) ? (
                  <s-badge tone="neutral">Done</s-badge>
                ) : (
                  <s-badge tone="critical">Cancelled</s-badge>
                ))}
              <RunItem run={run} />
            </s-stack>
            {/* The note is the run's one text field, always present and
              possibly blank, so its one verb is Edit and the blank state is
              the field's name rather than a call to add. It sits above the
              tasks: it is the answer to "anything I should know about this
              job", and a note under a task already done is a note nobody
              reads. Shopify's order note is read-only and folds in under it,
              so the page has one place for prose about the run. On a
              cancelled run a blank note draws nothing. */}
            {(hasNote || canNote || hasOrderNote) && (
              <s-stack id="note" gap="small-300">
                {(hasNote || canNote) && (
                  <s-stack
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="start"
                    gap="base"
                  >
                    {hasNote ? (
                      <Prose>{run.note}</Prose>
                    ) : (
                      <s-text color="subdued">Note</s-text>
                    )}
                    {canNote && (
                      <s-button
                        variant="secondary"
                        disabled={actions.pending}
                        onClick={() => {
                          showModal(NOTE_MODAL);
                        }}
                      >
                        Edit
                      </s-button>
                    )}
                  </s-stack>
                )}
                {hasOrderNote && (
                  <s-stack gap="small-500">
                    <s-text color="subdued">From the order:</s-text>
                    <Prose>{view.orderNote}</Prose>
                  </s-stack>
                )}
              </s-stack>
            )}
            {/* One caption and one box per step: parallel tasks share the box,
              separated by rules the way the run list separates rows, so a
              step reads as one stop before the caption is read. A single-task
              step is a caption over one row. The steps are an ordered list,
              which is what they are. */}
            <s-stack accessibilityRole="ordered-list" gap="base">
              {WorkflowLayout.stepsOf(view.tasks).map((group) => {
                const step = group[0]?.step ?? 0;
                return (
                  <s-stack
                    key={step}
                    accessibilityRole="list-item"
                    gap="small-300"
                  >
                    <s-text color="subdued">{`Step ${String(step)}`}</s-text>
                    <s-box borderWidth="base" borderRadius="base">
                      {group.map((task, index) =>
                        renderTask(task, index === 0),
                      )}
                    </s-box>
                  </s-stack>
                );
              })}
            </s-stack>
          </s-stack>
        </div>
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

import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { MemberBar } from "@/components/MemberBar";
import {
  BlockBanner,
  ClosedLine,
  Prose,
  QuantityBadge,
  RunItem,
  RunNote,
} from "@/components/MemberRun";
import { RunSteps } from "@/components/RunSteps";
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

const NOTE_MODAL = "run-note";
const BLOCK_MODAL = "run-block";

const ParamsInput = Schema.Struct({
  shop: Schema.String,
  runId: Schema.String,
});

/**
 * The work page's first paint, SSR like the run list's. `memberGetRun`
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
        const view = yield* (yield* ShopAgentClient).memberGetRun(shop, {
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

function RouteComponent() {
  const {
    shop,
    memberId,
    memberEmail,
    teams,
    view: initialView,
  } = Route.useLoaderData();
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
  /** The member as the actor every action set on this page is computed for. */
  const actor: Domain.Actor = {
    role: "member",
    memberId,
    email: memberEmail,
    teamIds: teams.map((team) => team.id),
  };

  /**
   * The buttons follow {@link Domain.taskActions}, which also says why none is
   * primary; the banner carries the only action a block allows. The badge
   * carries the state and the buttons are its exits, the advancing one first:
   * `Start · Done`, `Done · Put back`, `Undo`. The label is Undo although the
   * field is `reopen`: on the bench the verb takes back the member's own
   * Done. Undo and Put back are offered where they are allowed and nowhere
   * else: a blocked undo draws no disabled button and no sentence explaining
   * itself, because the task standing in the way is on this same page with an
   * `In progress` badge on it.
   */
  const taskButtons = (task: Domain.RunTaskView) => {
    if (view === null) return null;
    const can = Domain.taskActions(actor, view.order, view.run, task);
    const anyAction = can.done || can.putBack || can.reopen?.blockedBy === null;
    if (!anyAction) return null;
    return (
      <>
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
        {can.reopen?.blockedBy === null && (
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
      </>
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
  /** Block, the note, Edit reason and Unblock: {@link Domain.runActions}. */
  const can = Domain.runActions(actor, view.order, run, view.tasks);
  /**
   * Unblock lifts the hold and nothing else: the run goes back to the tier
   * and the tasks it had, and whoever lifted it presses Done next if the work
   * is in fact done. It takes one tap and no confirmation: Block undoes it.
   *
   * A block the member cannot lift still shows its banner, when none of the
   * member's tasks is ready yet ({@link Domain.runActions}' `unblock`). The
   * banner then says who acts, so a banner with no button does not read as a
   * broken one.
   */
  const reviewNote = (
    <s-text color="subdued">Your merchant will review this.</s-text>
  );
  const blockActions =
    can.editReason || can.unblock ? (
      <>
        {can.editReason && (
          <s-button
            slot="secondary-actions"
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              showModal(BLOCK_MODAL);
            }}
          >
            Edit reason
          </s-button>
        )}
        {can.unblock && (
          <s-button
            slot="secondary-actions"
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              actions.unblock.mutate(run.id);
            }}
          >
            Unblock
          </s-button>
        )}
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
        {can.block && (
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
            <BlockBanner run={run} actions={blockActions ?? reviewNote} />
            {/* A closed run, reached by link: where the block banner would
              be, why it ended and when ({@link Domain.ClosedReason}). Only
              the note is left to do on it ({@link Domain.runActions}). */}
            {Domain.runIsClosed(run) && (
              <s-banner tone="info" heading="Closed">
                <ClosedLine run={run} viewer="member" />
              </s-banner>
            )}
            {/* Item first: what to make is why the page was opened. No workflow
              name or age, because a member cannot act on either and the run
              list carries the age. No border, because two bordered blocks on
              one page compete. The Done badge stays: it is the only sign the
              page is read-only. The quantity badge sits beside it after a
              Shopify change, until the next finished task clears it. */}
            <s-stack gap="small-300">
              {(Domain.runIsDone(run) || run.quantityChangedFrom !== null) && (
                <s-stack direction="inline" gap="small-300">
                  {Domain.runIsDone(run) && (
                    <s-badge tone="neutral">Done</s-badge>
                  )}
                  <QuantityBadge run={run} />
                </s-stack>
              )}
              <RunItem run={run} />
            </s-stack>
            {/* The note sits above the tasks: it is the answer to "anything I
              should know about this job", and a note under a task already
              done is a note nobody reads. Shopify's order note is read-only
              and folds in under it, so the page has one place for prose about
              the run. {@link RunNote} states the note's own shape. */}
            {(hasNote || can.note || hasOrderNote) && (
              <s-stack id="note" gap="small-300">
                <RunNote
                  note={run.note}
                  canEdit={can.note}
                  pending={actions.pending}
                  onEdit={() => {
                    showModal(NOTE_MODAL);
                  }}
                />
                {hasOrderNote && (
                  <s-stack gap="small-500">
                    <s-text color="subdued">From the order:</s-text>
                    <Prose>{view.orderNote}</Prose>
                  </s-stack>
                )}
              </s-stack>
            )}
            {/* The step cards, shared with the order page's Manage drawer:
              {@link RunSteps} states their shape. */}
            <RunSteps
              tasks={view.tasks}
              showInstructions
              renderActions={taskButtons}
            />
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

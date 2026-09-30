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
 * The workflow page's first paint, SSR like the workflows list's. `memberGetRun`
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
        const page = yield* (yield* ShopAgentClient).memberGetRun(shop, {
          runId: data.runId,
          teamIds: teams.map((team) => team.id),
        });
        return {
          shop,
          memberId,
          memberEmail: user.email,
          teams,
          page,
        } satisfies Domain.RunLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/workflows/$runId")({
  loader: ({ params }) =>
    getLoaderData({ data: { shop: params.shop, runId: params.runId } }),
  /** The browser tab says what the heading says: the item, or that there is none. */
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.page?.run.lineItemTitle ?? "Workflow not found"} — Baton`,
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
    page: initialPage,
  } = Route.useLoaderData();
  const { runId } = Route.useParams();
  const {
    data: page,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ["shop-run", shop, runId],
    subscribe: (stub, subscriberId) =>
      stub.subscribeRun({ subscriberId, runId }),
    initialData: initialPage,
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
   * itself, because the task standing in the way is on this same page with a
   * `Started` badge on it.
   */
  const taskButtons = (task: Domain.RunTaskRow) => {
    if (page === null) return null;
    const can = Domain.taskActions(actor, page.order, page.run, task);
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
            {Domain.VERB_LABEL.start.member}
          </s-button>
        )}
        {can.done && (
          <s-button
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              actions.markDone.mutate(task.id);
            }}
          >
            {Domain.VERB_LABEL.done.member}
          </s-button>
        )}
        {can.putBack && (
          <s-button
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              actions.putBack.mutate(task.id);
            }}
          >
            {Domain.VERB_LABEL.putBack.member}
          </s-button>
        )}
        {can.reopen?.blockedBy === null && (
          <s-button
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              actions.reopen.mutate(task.id);
            }}
          >
            {Domain.VERB_LABEL.reopen.member}
          </s-button>
        )}
      </>
    );
  };

  if (page === null)
    return (
      <>
        <MemberBar shop={shop} email={memberEmail} />
        <s-page heading="Workflow not found" inlineSize="small">
          <s-section accessibilityLabel="Workflow not found">
            <s-paragraph color="subdued">
              This workflow is not on one of your teams, or it no longer exists.
            </s-paragraph>
          </s-section>
        </s-page>
      </>
    );

  const { run } = page;
  /** Block, the note, Edit reason and Unblock: {@link Domain.runActions}. */
  const can = Domain.runActions(actor, page.order, run, page.tasks);
  /**
   * Unblock lifts the hold and nothing else: the run goes back to the view
   * and the tasks it had, and whoever lifted it presses Done next if the work
   * is in fact done. It takes one tap and no confirmation: Block undoes it.
   *
   * A block the member cannot lift still shows its banner, when none of the
   * member's tasks is current yet ({@link Domain.runActions}' `unblock`). The
   * banner then says who acts, so a banner with no button does not read as a
   * broken one.
   */
  const reviewNote = (
    <s-text color="subdued">The merchant will review this.</s-text>
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
            {Domain.VERB_LABEL.editReason.member}
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
            {Domain.VERB_LABEL.unblock.member}
          </s-button>
        )}
      </>
    ) : null;
  const hasNote = run.note !== null && run.note.length > 0;
  const hasOrderNote = page.orderNote !== null && page.orderNote.length > 0;

  return (
    <>
      <MemberBar shop={shop} email={memberEmail} />
      {/* No breadcrumb: `MemberBar` sits directly above this heading and its
          mark is the link to `/shop/$shop/workflows`, the workflows list. A second
          link to the same place, a stride below the first, is one link too
          many — and the mark's link lands on the list the member left, view,
          team and depth included, because this page's URL carries their
          context too (`MemberSearch` in `shop.$shop.tsx`). */}
      <s-page heading={run.lineItemTitle} inlineSize="small">
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
            {Domain.VERB_LABEL.block.member}
          </s-button>
        )}
        {/* No `s-section` on this page: a top-level section is a card
            whether or not it has a heading, and the item, the note and the
            steps are plain text on the page, with the step boxes the only
            borders. The stack gives them the spacing sections would, and
            `.member-work` the phone inset (`styles.css`). */}
        <div className="member-work">
          <s-stack gap="base">
            {/* Under the item heading, the run as both sides name it: the
              workflow name is the noun the merchant's order page uses for
              the same run, so a member and a merchant talking about one
              thing say the same words, and the order is the qualifier. */}
            <s-text color="subdued">{`${run.workflowName} workflow · ${run.orderName}`}</s-text>
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
              <s-banner tone="info" heading={Domain.RUN_STATE_LABEL.closed}>
                <ClosedLine run={run} viewer="member" />
              </s-banner>
            )}
            {/* Item first: what to make is why the page was opened. No age,
              because a member cannot act on it and the workflows list
              carries it. No border, because two bordered blocks on
              one page compete. The Done badge stays: it is the only sign the
              page is read-only. The quantity badge sits beside it after a
              Shopify change, until the next Done clears it. */}
            <s-stack gap="small-300">
              {(Domain.runIsDone(run) || run.quantityChangedFrom !== null) && (
                <s-stack direction="inline" gap="small-300">
                  {Domain.runIsDone(run) && (
                    <s-badge tone="neutral">
                      {Domain.RUN_STATE_LABEL.done}
                    </s-badge>
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
                    <Prose>{page.orderNote}</Prose>
                  </s-stack>
                )}
              </s-stack>
            )}
            {/* The step cards, shared with the order page's Manage drawer:
              {@link RunSteps} states their shape. */}
            <RunSteps
              tasks={page.tasks}
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

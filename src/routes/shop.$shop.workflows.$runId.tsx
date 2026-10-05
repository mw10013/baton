import {
  createFileRoute,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { MemberBar } from "@/components/MemberBar";
import {
  BlockBanner,
  ClosedLine,
  RunItem,
  RunNote,
} from "@/components/MemberRun";
import { RunSteps } from "@/components/RunSteps";
import { BlockModal, RunNoteModal } from "@/components/RunTextModals";
import { BackLink } from "@/components/screen/BackLink";
import { Inline } from "@/components/screen/Inline";
import { Lines } from "@/components/screen/Lines";
import { PageBody } from "@/components/screen/PageBody";
import { Prose } from "@/components/screen/Prose";
import * as Domain from "@/lib/Domain";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { showModal } from "@/lib/polarisModal";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useLiveQuery } from "@/lib/useLiveQuery";
import {
  errorMessage,
  runResultMessage,
  useMemberRunActions,
} from "@/lib/useMemberRunActions";

const NOTE_MODAL = "run-note";
const BLOCK_MODAL = "run-block";

const ParamsInput = Schema.Struct({
  shop: Schema.String,
  runId: Schema.String,
});

/** `page` is null when the run is not the member's to see. */
interface RunLoaderData {
  readonly shop: Domain.Shop;
  readonly memberId: Domain.MemberId;
  readonly memberEmail: Domain.Email;
  readonly teams: Domain.MemberAccess["teams"];
  readonly page: Domain.RunPageData | null;
}

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
        } satisfies RunLoaderData;
      }),
    ),
  );

/**
 * The way back to the workflows list ({@link BackLink}), above the page heading:
 * the controls table's row for going back to the list a page was opened from
 * (`Control` in `Screen.ts`). A `link` slot (`CopySlot`) named for the list,
 * with a back arrow so it reads as the way back before it is read at all.
 *
 * Not `s-page`'s `breadcrumb-actions` slot: under about 500px the page folds
 * that slot into a "…" button beside the heading, which on a phone hides the
 * one control this exists to make plain. `MemberBar`'s mark goes to the list
 * too, but it reads as the shop's name and a logo, and on a phone, where the
 * browser's Back is seldom pressed, a member looking for the way back does not
 * find it there.
 *
 * **It returns to the list as the member left it.** When a row of the list
 * opened this page, the entry before is the list at its depth
 * (`fromWorkflowsList`, `MemberSearch` in `shop.$shop.tsx`), so the link is a
 * history step back and the router restores the scroll: the member lands on
 * the row they opened. Anywhere else, such as a shared link or a new tab, it
 * opens the list at the first page, with the state, team and search the
 * layout carries. The `href` is that second target, so open-in-new-tab gets
 * it too.
 */
function WorkflowsLink({ shop }: { readonly shop: Domain.Shop }) {
  const router = useRouter();
  const fromWorkflowsList = useLocation({
    select: (location) => location.state.fromWorkflowsList === true,
  });
  const list = { to: "/shop/$shop/workflows", params: { shop } } as const;
  return (
    <BackLink
      label="Workflows"
      href={router.buildLocation(list).href}
      onNavigate={() => {
        if (fromWorkflowsList) router.history.back();
        else void router.navigate(list);
      }}
    />
  );
}

export const Route = createFileRoute("/shop/$shop/workflows/$runId")({
  loader: ({ params }) =>
    getLoaderData({ data: { shop: params.shop, runId: params.runId } }),
  /** The browser tab says what the heading says: the item, or that there is none. */
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.page === null || loaderData?.page === undefined ? "Workflow not found" : `${loaderData.page.run.orderName} · ${loaderData.page.run.lineItemTitle}`} — Baton`,
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
  } = useLiveQuery({
    queryKey: ["shop-run", shop, runId],
    read: (stub) => stub.liveRun({ runId }),
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
   * field is `reopen`: on the bench the verb takes back a Done, usually
   * one's own, and the whole team may press it. Undo and Put back are offered where they are allowed and nowhere
   * else: a blocked undo draws no disabled button and no sentence explaining
   * itself, because the task standing in the way is on this same page with a
   * `Started` badge on it.
   */
  const taskButtons = (task: Domain.RunTaskRow) => {
    if (page === null) return null;
    const can = Domain.taskActions(actor, page.order, page.run, task);
    const anyAction = can.done || can.putBack || can.reopen;
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
        {can.reopen && (
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
        <WorkflowsLink shop={shop} />
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
  /** Block, the note and Unblock: {@link Domain.runActions}. */
  const can = Domain.runActions(actor, page.order, run, page.tasks);
  /**
   * Unblock lifts the hold and nothing else: the run goes back to the state
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
  const blockActions = can.unblock ? (
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
  ) : null;
  const hasNote = run.note !== null && run.note.length > 0;
  const hasOrderNote = page.orderNote !== null && page.orderNote.length > 0;

  return (
    <>
      <MemberBar shop={shop} email={memberEmail} />
      <WorkflowsLink shop={shop} />
      {/* The order number heads the page and the item heads its body.
          `s-page` cuts its heading to one line, and an item title is Shopify
          text of up to 255 characters; this page is the title's home, where
          it prints whole (the Shopify-text row of the parts table on
          `ScreenPart` in `Screen.ts`). An order number is short in practice,
          and the order page, the modal headings and every row's line one
          lead with it too. */}
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
            {Domain.VERB_LABEL.block.member}
          </s-button>
        )}
        {/* No `s-section` on this page: the item, the note and the steps
            are plain text on the page, with the step boxes the only
            borders ({@link PageBody}). */}
        <PageBody>
          {/* The item, whole and wrapping, then the run as both sides name
              it: the workflow name is the noun the merchant's order page
              uses for the same run, so a member and a merchant talking about
              one thing say the same words. The order is the page heading. */}
          <Lines>
            <s-heading>{run.lineItemTitle}</s-heading>
            <s-text color="subdued">{`${run.workflowName} workflow`}</s-text>
          </Lines>
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
              page is read-only. */}
          <Lines>
            {Domain.runIsDone(run) && (
              <Inline>
                <s-badge tone="neutral">{Domain.RUN_STATE_LABEL.done}</s-badge>
              </Inline>
            )}
            <RunItem run={run} />
          </Lines>
          {/* The note sits above the tasks: it is the answer to "anything I
              should know about this job", and a note under a task already
              done is a note nobody reads. Shopify's order note is read-only
              and folds in under it, so the page has one place for prose about
              the run. {@link RunNote} states the note's own shape. */}
          {(hasNote || can.note || hasOrderNote) && (
            <Lines id="note">
              <RunNote
                note={run.note}
                canEdit={can.note}
                pending={actions.pending}
                onEdit={() => {
                  showModal(NOTE_MODAL);
                }}
              />
              {hasOrderNote && (
                <Lines>
                  <s-text color="subdued">From the order:</s-text>
                  <Prose>{page.orderNote}</Prose>
                </Lines>
              )}
            </Lines>
          )}
          {/* The step cards, shared with the order page's Manage drawer:
              {@link RunSteps} states their shape. */}
          <RunSteps
            tasks={page.tasks}
            showInstructions
            renderActions={taskButtons}
          />
        </PageBody>
        <RunNoteModal
          id={NOTE_MODAL}
          note={run.note}
          pending={actions.pending}
          onSave={(note) =>
            actions.note
              .mutateAsync({ runId: run.id, note })
              .then((result) => runResultMessage(result, "workflow"))
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
              .then((result) => runResultMessage(result, "workflow"))
              .catch(errorMessage)
          }
        />
      </s-page>
    </>
  );
}

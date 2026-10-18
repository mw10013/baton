import type { MemberWorkflowPageData } from "../../contract/workflows-list.ts";
import {
  type Actor,
  RUN_STATE_LABEL,
  type RunTaskRow,
  runActions,
  runIsDone,
  taskActions,
  VERB_LABEL,
} from "../../domain/shop-work.ts";
import { showModal } from "../client/polaris-modal.ts";
import { memberRunAtom, seedMemberRun } from "../client/shop-actor-client.ts";
import { useLiveRead } from "./live-read.ts";
import { useMemberRunActions } from "./member-run-actions.ts";
import { BlockBanner, ClosedLine, RunItem, RunNote } from "./MemberRun.tsx";
import { RunSteps } from "./RunSteps.tsx";
import { BlockModal, RunNoteModal } from "./RunTextModals.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { PageBody } from "./screen/PageBody.tsx";
import { Prose } from "./screen/Prose.tsx";

const NOTE_MODAL = "run-note";
const BLOCK_MODAL = "run-block";

/**
 * The member's workflow page: one item's workflow as a job ticket, headed by the order, with the
 * item, the block, the note and the order's note, then every task by step with its state, who and
 * when, and its buttons. Prints as the ticket (`.print-hide` and `s-button` go). A live screen,
 * one tree from the server's render through hydration: the loader paints, then `MemberGetRun`
 * over the member's socket keeps it current ({@link useLiveRead}). `page` null is a run that is
 * not there or not on the member's teams, one answer for both: "Workflow not found".
 *
 * Every button reads a field of {@link runActions} or {@link taskActions}, which the procedure
 * behind it checks again. No toasts in the member area: a write's answer is the page moving, or
 * the banner when it was refused.
 */
export default function MemberWorkflowPage({
  runId,
  data,
}: {
  readonly runId: string;
  readonly data: MemberWorkflowPageData;
}) {
  const { memberId, memberEmail, teams } = data;
  const read = useLiveRead({
    atom: memberRunAtom(runId),
    key: runId,
    loaded: data.page,
    seed: (registry, page) => {
      seedMemberRun(registry, { runId, page });
    },
  });
  const page = read.value;
  const actions = useMemberRunActions();
  /** The member as the actor every action set on this page is computed for. */
  const actor: Actor = {
    role: "member",
    memberId,
    email: memberEmail,
    teamIds: teams.map(({ id }) => id),
  };

  if (page === null)
    return (
      <s-page heading="Workflow not found" inlineSize="small">
        <s-paragraph color="subdued">
          This workflow is not on one of your teams, or it no longer exists.
        </s-paragraph>
      </s-page>
    );

  /**
   * The buttons follow {@link taskActions}, which also says why none is primary; the banner
   * carries the only action a block allows. The badge carries the state and the buttons are its
   * exits, the advancing one first: `Start · Done`, `Done · Put back`, `Undo`. The label is Undo
   * although the field is `reopen`: on the bench the verb takes back a Done, usually one's own,
   * and the whole team may press it. A blocked Undo draws no disabled button and no sentence: the
   * task standing in the way is on this page with a `Started` badge on it.
   */
  const taskButtons = (task: RunTaskRow) => {
    const can = taskActions(actor, page.order, page.run, task);
    if (!(can.done || can.putBack || can.reopen)) return null;
    const button = (label: string, press: () => Promise<void>) => (
      <s-button variant="secondary" disabled={actions.pending} onClick={() => void press()}>
        {label}
      </s-button>
    );
    return (
      <>
        {can.start && button(VERB_LABEL.start.member, () => actions.start(task.id))}
        {can.done && button(VERB_LABEL.done.member, () => actions.markDone(task.id))}
        {can.putBack && button(VERB_LABEL.putBack.member, () => actions.putBack(task.id))}
        {can.reopen && button(VERB_LABEL.reopen.member, () => actions.reopen(task.id))}
      </>
    );
  };

  const { run } = page;
  const can = runActions(actor, page.order, run, page.tasks);
  /**
   * Unblock lifts the hold and nothing else, in one tap and no confirmation: Block undoes it. A
   * block the member cannot lift still shows its banner, and then says who acts, so a banner with
   * no button does not read as a broken one.
   */
  const blockActions = can.unblock ? (
    <s-button
      slot="secondary-actions"
      variant="secondary"
      disabled={actions.pending}
      onClick={() => void actions.unblock(run.id)}
    >
      {VERB_LABEL.unblock.member}
    </s-button>
  ) : (
    <s-text color="subdued">The merchant will review this.</s-text>
  );
  const hasNote = run.note !== null && run.note.length > 0;
  const hasOrderNote = page.orderNote !== null && page.orderNote.length > 0;

  // The order number heads the page and the item heads its body: `s-page` cuts its heading to
  // one line, and an item title is Shopify text of up to 255 characters, which prints whole here.
  return (
    <s-page heading={run.orderName} inlineSize="small">
      {/* Block stays a visible page action: it says the worker can stop the line. */}
      {can.block && (
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={actions.pending}
          onClick={() => {
            showModal(BLOCK_MODAL);
          }}
        >
          {VERB_LABEL.block.member}
        </s-button>
      )}
      <PageBody>
        <Lines>
          <s-heading>{run.lineItemTitle}</s-heading>
          <s-text color="subdued">{`${run.workflowName} workflow`}</s-text>
        </Lines>
        {actions.banner !== null && <s-banner tone="critical">{actions.banner}</s-banner>}
        <BlockBanner run={run} viewer="member" actions={blockActions} />
        <Lines>
          <ClosedLine run={run} viewer="member" prefix />
          {runIsDone(run) && (
            <Inline>
              <s-badge tone="neutral">{RUN_STATE_LABEL.done}</s-badge>
            </Inline>
          )}
          <RunItem run={run} />
        </Lines>
        {/* The note sits above the tasks: it answers "anything I should know about this job".
            Shopify's order note folds in under it, so the page has one place for prose. */}
        {(hasNote || can.note || hasOrderNote) && (
          <div id="note">
            <Lines>
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
          </div>
        )}
        <RunSteps tasks={page.tasks} viewer="member" showInstructions renderActions={taskButtons} />
      </PageBody>
      <RunNoteModal
        id={NOTE_MODAL}
        note={run.note}
        pending={actions.pending}
        onSave={(note) => actions.note(run.id, note)}
      />
      <BlockModal
        id={BLOCK_MODAL}
        run={run}
        pending={actions.pending}
        onBlock={(reason) => actions.block(run.id, reason)}
      />
    </s-page>
  );
}

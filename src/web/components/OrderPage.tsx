import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import { Fragment, type ReactNode, useState } from "react";
import { isFixtureOrder } from "../../contract/fixture.ts";
import { ORDER_SYNC_WINDOW_DAYS } from "../../contract/orders.ts";
import { type OrderLineItem, orderIsOpen } from "../../domain/orders.ts";
import { formatNumber, formatStatus } from "../../domain/platform.ts";
import {
  type Actor,
  type AssignRunTaskTeamResult,
  type AttachResult,
  currentTasks,
  lineItemState,
  lowestOpenStep,
  type OrderPageData,
  orderPosition,
  RUN_STATE_LABEL,
  RUN_UNSTARTED_LABEL,
  type Run,
  type RunActions,
  runActions,
  runCounts,
  type RunDetail,
  type RunResult,
  type RunState,
  type RunTask,
  type RunTaskRow,
  runIsBlocked,
  runIsClosed,
  runIsOpen,
  runIsUnstarted,
  runTaskIsUnassigned,
  type TaskActions,
  taskActions,
  type TaskName,
  type TeamWithMemberCount,
  VERB_LABEL,
  type WorkflowName,
  type WorkflowNameRow,
} from "../../domain/shop-work.ts";
import { toast } from "../client/app-bridge.ts";
import { hideModal, showModal } from "../client/polaris-modal.ts";
import {
  assignRunTaskTeamAtom,
  attachWorkflowAtom,
  cancelRunAtom,
  merchantBlockRunAtom,
  merchantMarkTaskDoneAtom,
  merchantOrderDetailAtom,
  merchantPutBackTaskAtom,
  merchantReopenTaskAtom,
  merchantSetRunNoteAtom,
  merchantUnblockRunAtom,
  merchantOrderDetailQuery,
  syncOrderAtom,
} from "../client/shop-actor-client.ts";
import { CANCEL_WARNING, cancelHeading, changeWarning } from "./change-warning.ts";
import { thrownCopy } from "./form.ts";
import { useLiveRead } from "./live-read.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import { BlockBanner, ClosedLine, LineItemProperties, RunNote } from "./MemberRun.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { adminOrderUrl, useResourceLinkTarget } from "./order-links.ts";
import { failureCopy, toastSyncFailure } from "./orders-sync.ts";
import { useKeyedPresses } from "./press-waiting.ts";
import { RunSteps } from "./RunSteps.tsx";
import { BlockModal, RunNoteModal } from "./RunTextModals.tsx";
import { Clamp } from "./screen/Clamp.tsx";
import { FootLine } from "./screen/FootLine.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { type Pair, Pairs } from "./screen/Pairs.tsx";
import { Panel } from "./screen/Panel.tsx";
import { Prose } from "./screen/Prose.tsx";
import { SelectRow } from "./screen/SelectRow.tsx";
import { Things } from "./screen/Things.tsx";
import { Token } from "./screen/Token.tsx";

/** Attach's refusals, as the page banner says them; `Ok` says nothing there (a toast does). */
export const attachResultMessage = Match.typeTags<AttachResult, string | null>()({
  Ok: () => null,
  AlreadyExists: () => "That workflow is already on this item.",
  LineItemNotFound: () => "That item no longer exists.",
  WorkflowNotEligible: () =>
    "That workflow can't start: it's inactive, has no steps, or has a task with no team.",
  OrderClosed: () =>
    "This order is cancelled or fulfilled in Shopify, so you can't attach a workflow to it.",
  NothingToMake: () => "This item has nothing left to make, so no workflow can start on it.",
});

/** Assign team's refusals, under the modal's select or in the page banner. */
export const assignResultMessage = Match.typeTags<AssignRunTaskTeamResult, string | null>()({
  Assigned: () => null,
  NotFound: () => "That task no longer exists.",
  TeamNotFound: () => "That team no longer exists. Choose another.",
  TaskDone: () => "That task is already done and keeps its team.",
  // The item's workflow was done or closed between the render and the click.
  RunNotOpen: () => "That item's workflow is done or closed.",
  NotAllowed: () => "That task can no longer be assigned.",
});

/**
 * A refused run write's toast, a fact in the present tense. The page offers a write only where
 * `runActions` or `taskActions` allows it and the actor checks the same field, so `NotAllowed` is
 * the run changing between the render and the click: the sentence names the task for a task verb
 * and the workflow for a run verb. The member's screens word `NotFound` their own way.
 */
export const runResultMessage = (result: RunResult, subject: "task" | "workflow") =>
  Match.value(result).pipe(
    Match.tagsExhaustive({
      Ok: () => null,
      // Another admin changed the item's workflow, or the order was deleted.
      NotFound: () => "That workflow is no longer on this item",
      NotAllowed: () => `The ${subject} changed on another screen`,
    }),
  );

/** A press that failed with no typed answer (a lost socket, a defect), as a modal or the banner says it. */
export const errorMessage = (cause: Cause.Cause<unknown>) =>
  thrownCopy(Cause.squash(cause), "Couldn't save. Try again.");

/**
 * Merchant words, not `Run.state`. An open run nobody has touched ({@link runIsUnstarted}) reads
 * {@link RUN_UNSTARTED_LABEL}, not Making: the merchant is asking whether the bench has picked it
 * up yet, and the stored state cannot say, since a run is `open` from creation. Closed is
 * neutral, not red: the work ended and nothing waits on anyone; red stays for a hold. The reason
 * is the line under it ({@link ClosedLine}), not a badge of its own.
 */
const RUN_STATE_BADGE = {
  open: { label: RUN_STATE_LABEL.open, tone: "info" },
  done: { label: RUN_STATE_LABEL.done, tone: "success" },
  closed: { label: RUN_STATE_LABEL.closed, tone: "neutral" },
} as const satisfies Record<RunState, { readonly label: string; readonly tone: string }>;

const runStateBadge = (run: Run, tasks: readonly RunTaskRow[]) =>
  runIsOpen(run) && runIsUnstarted(tasks)
    ? ({ label: RUN_UNSTARTED_LABEL, tone: "neutral" } as const)
    : RUN_STATE_BADGE[run.state];

/** The one modal that both asks and confirms: the select and, on a touched run, the warning. */
export const CHANGE_WORKFLOW_MODAL = "change-workflow";
export const CANCEL_RUN_MODAL = "cancel-run";
export const ASSIGN_MODAL = "assign-task";
export const NOTE_MODAL = "run-note";
export const BLOCK_MODAL = "run-block";

/**
 * The multi-match item's sentence: why the merchant is being asked, and nothing that can drift
 * from the select under it. It does not count the matches, because a count that must agree with
 * a list is a second source of truth; it does not name the tags, because the merchant changes the
 * workflow here, not the product.
 */
const MULTI_MATCH_SENTENCE = "More than one workflow matches this item, so none was started.";

/** The merchant as the actor every action set on this page is computed for. */
const MERCHANT: Actor = { role: "merchant" };

/** The teams as select options: names only. */
const teamOptions = (teams: readonly TeamWithMemberCount[]) =>
  teams.map((team) => (
    <s-option key={team.id} value={team.id}>
      {team.name}
    </s-option>
  ));

const lineItemTitle = ({ title, variantTitle }: OrderLineItem) =>
  variantTitle === null ? title : `${title} — ${variantTitle}`;

/**
 * One row of the facts ({@link Pairs}). Empty facts return nothing rather than an em dash: a
 * column of placeholder dashes is noise that pushes the facts that do exist off screen.
 */
const fact = (label: string, value: ReactNode): readonly Pair[] =>
  value === null || value === undefined || value === "" ? [] : [{ key: label, label, value }];

const stepCount = (tasks: readonly RunTask[]) =>
  tasks.reduce((max, task) => Math.max(max, task.step), 0);

/**
 * Where the run is, as the card's one read-only answer: `Step 1 of 3 · Cut · since 3:10 PM`, or
 * `Step 2 of 3 · 3 tasks · since 3:10 PM` on a parallel step. Position and task names only: the
 * team is inside Manage, on its own line under the task. Deliberately a second phrasing beside
 * {@link RunSteps}, which describes each task inside Manage in the member's words; this one
 * describes the run on a collapsed card and covers a parallel step, which is not a task state.
 *
 * It renders on a blocked run too: the banner above answers why it stopped and this line where it
 * is. A blocked run is still open, so its current tasks are the ones the hold stopped.
 */
const nowLine = ({ run, tasks }: RunDetail): ReactNode => {
  // A closed run's line is its reason (`ClosedLine`), not a position.
  if (runIsClosed(run)) return null;
  // Counts steps, like the open form's `of M`: `Step 2 of 2` must not become `3 steps` when done.
  if (!runIsOpen(run)) {
    const steps = stepCount(tasks);
    return `Done · ${formatNumber(steps)} step${steps === 1 ? "" : "s"}`;
  }
  const current = currentTasks(run, tasks);
  const lowest = lowestOpenStep(tasks);
  // Every remaining task unassigned, or an inconsistent run: the team rows are the answer.
  if (current.length === 0 || lowest === null) return null;
  const names = current.length === 1 ? current[0]?.name : `${formatNumber(current.length)} tasks`;
  /** The step's start, not a task's: on a parallel step the earliest claim is when it got here. */
  const since = current.reduce<number | null>((earliest, task) => {
    if (task.startedAt === null) return earliest;
    return earliest === null ? task.startedAt : Math.min(earliest, task.startedAt);
  }, null);
  return (
    <>
      {`Step ${String(lowest)} of ${String(stepCount(tasks))} · ${names ?? ""}`}
      {since !== null && (
        <>
          {" · since "}
          <LocalDateTime value={since} format="time" />
        </>
      )}
    </>
  );
};

/** A run or task write's answer, as a press settles it. */
type RunExit = Exit.Exit<RunResult, unknown>;

/** A run's tasks with the merchant's actions. */
type ActionableTask = RunTaskRow & { readonly actions: TaskActions };

/** What the Change workflow modal holds, or null when it is closed. */
interface Changing {
  readonly lineItemId: string;
  readonly from: WorkflowName;
  readonly run: Run;
  readonly options: readonly WorkflowNameRow[];
  readonly tasks: readonly RunTask[];
  readonly workflowId: string | null;
}

/** The run the Cancel workflow modal asks about, with what its heading names. */
interface Cancelling {
  readonly runId: string;
  readonly workflowName: WorkflowName;
  readonly item: string;
}

/** The task the Assign team modal is about, and the modal's own pick and refusal. */
interface Assigning {
  readonly runTaskId: string;
  readonly taskName: TaskName;
  readonly teamId: string;
  readonly error: string | null;
}

/** {@link OrderPage}'s props: the loader's answer and the route's links. */
export interface OrderPageProps {
  readonly legacyId: string;
  /** The loader's answer: `null` is no such order. */
  readonly data: OrderPageData | null;
  /** The breadcrumb to the orders index, carrying its search, filters and page. */
  readonly ordersLink: PageLink;
  /** The workflows index, from an item no workflow matches. */
  readonly workflowsLink: PageLink;
}

/**
 * One order: its items, each with its workflow, and the order's note and facts. A live screen,
 * one tree from the server's render through hydration: the loader paints, then
 * `MerchantGetOrderDetail` over the merchant socket keeps it current ({@link useLiveRead}), so a
 * webhook, a sync or a member's task action on this order repaints the page. Every write answers
 * a tagged result, mapped to a toast or the banner rather than thrown; until React has hydrated
 * nothing presses ({@link useKeyedPresses}).
 *
 * The page decides no gate. Each item's card is a switch on {@link lineItemState}, and each button
 * reads a field of {@link runActions} or {@link taskActions}, which the procedure behind it checks
 * again. A fixture order is not in Shopify, so it offers neither View in Shopify nor Sync from
 * Shopify.
 */
export default function OrderPage(props: OrderPageProps) {
  const read = useLiveRead({
    atom: merchantOrderDetailAtom(props.legacyId),
    query: merchantOrderDetailQuery(props.legacyId),
    loaded: props.data,
  });
  const presses = useKeyedPresses();
  const resourceLinkTarget = useResourceLinkTarget();
  const [banner, setBanner] = useState<string | null>(null);
  const [attachChoice, setAttachChoice] = useState<Readonly<Record<string, string>>>({});
  const [assignChoice, setAssignChoice] = useState<Readonly<Record<string, string>>>({});
  /**
   * The pick lives here and not in `attachChoice`: that map belongs to the at-rest Workflow
   * select, and a choice left behind in the modal would preselect it after a later Cancel
   * workflow. One modal for the page, so the click that opens it says which item it meant.
   */
  const [changing, setChanging] = useState<Changing | null>(null);
  const [cancelling, setCancelling] = useState<Cancelling | null>(null);
  const [assigning, setAssigning] = useState<Assigning | null>(null);
  /**
   * Which runs have their Manage drawer open; closed is the default. It survives re-reads on
   * purpose: a webhook or a worker's task action landing while the merchant has a drawer open
   * must leave it open. Reads go through `managingRun` against the runs in hand, so an id with no
   * run on this order answers `false`.
   */
  const [managing, setManaging] = useState<ReadonlySet<string>>(new Set());
  /** The run the Note and Block modals are about; each modal is one element at page level. */
  const [modalRunId, setModalRunId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const detail = read.value;
  if (read.failed)
    return (
      <s-page heading="Order">
        <s-link slot="breadcrumb-actions" {...props.ordersLink}>
          Orders
        </s-link>
        <s-banner tone="critical">Couldn't load the order.</s-banner>
      </s-page>
    );
  if (detail === null)
    return (
      <s-page heading="Order not found">
        <s-link slot="breadcrumb-actions" {...props.ordersLink}>
          Orders
        </s-link>
        <s-paragraph color="subdued">
          {`This order isn't in Baton. It may be older than ${String(ORDER_SYNC_WINDOW_DAYS)} days, or deleted in Shopify.`}
        </s-paragraph>
      </s-page>
    );

  const { order, lineItems, runs, matchedWorkflows, otherWorkflows, teams } = detail;
  const pending = presses.busy;
  const orderOpen = orderIsOpen(order);
  const inShopify = !isFixtureOrder(order.legacyId);
  /**
   * The aggregate the index computes in SQL, rebuilt from the runs this page carries so both
   * pages read one `orderPosition`. Only the made banner reads it.
   */
  const state = orderPosition({ order, runs: runCounts(runs.map(({ run }) => run)) });
  const managingRun = (run: Run) =>
    managing.has(run.id) && runs.some((other) => other.run.id === run.id);

  /**
   * A task or run write: the toast is the acknowledgement, written at the button so the task's
   * own name reaches it ("Cut done"). A refused write raises no banner: the page should not have
   * offered it, so the answer is the toast plus the re-render the notice brings.
   */
  const runWrite = (subject: "task" | "workflow", ok: string) => (exit: RunExit) => {
    Exit.match(exit, {
      onSuccess: (result) => {
        if (result._tag === "Ok") toast(ok);
        else toast(runResultMessage(result, subject) ?? "Nothing changed", { isError: true });
      },
      onFailure: (cause) => {
        setBanner(errorMessage(cause));
      },
    });
  };
  /** A modal's write: `null` closes it, a message stays under its field. */
  const fromModal =
    (ok: string) =>
    (exit: RunExit): string | null =>
      Exit.match(exit, {
        onSuccess: (result) => {
          if (result._tag !== "Ok")
            return runResultMessage(result, "workflow") ?? "Nothing changed";
          toast(ok);
          return null;
        },
        onFailure: errorMessage,
      });

  const attach = async (lineItemId: string, workflowId: string) => {
    const exit = await presses.press(attachWorkflowAtom(lineItemId), { lineItemId, workflowId });
    Exit.match(exit, {
      onSuccess: (result) => {
        setBanner(attachResultMessage(result));
        if (result._tag !== "Ok") return;
        setAttachChoice(({ [lineItemId]: _attached, ...rest }) => rest);
        setChanging(null);
        hideModal(CHANGE_WORKFLOW_MODAL);
        // The replaced run is deleted, and the modal already named what it cost, so the toast
        // says only where the item is now. An attach over a closed run is a fresh run.
        toast(
          result.replaced === null
            ? `Attached ${result.run.workflowName}`
            : `Changed to ${result.run.workflowName}`,
        );
      },
      onFailure: (cause) => {
        setBanner(errorMessage(cause));
      },
    });
  };

  const assign = async (runTaskId: string, teamId: string) => {
    const exit = await presses.press(assignRunTaskTeamAtom(runTaskId), { runTaskId, teamId });
    const message = Exit.match(exit, { onSuccess: assignResultMessage, onFailure: errorMessage });
    // The unassigned row's select has no modal to hold a message, so its refusal goes to the
    // page banner; the modal keeps its own.
    if (assigning?.runTaskId === runTaskId) {
      if (message === null) {
        setAssigning(null);
        hideModal(ASSIGN_MODAL);
      } else setAssigning((current) => (current === null ? null : { ...current, error: message }));
    } else setBanner(message);
  };

  const syncOrder = async () => {
    setSyncing(true);
    const exit = await presses.press(syncOrderAtom(order.id), undefined);
    setSyncing(false);
    Exit.match(exit, {
      // `Gone` is Sync from Shopify doing nothing; the page would otherwise say nothing about why.
      onSuccess: (answer) =>
        Match.valueTags(answer, {
          Stored: () => {},
          Gone: () => toast("Shopify no longer has this order"),
        }),
      onFailure: (cause) =>
        toastSyncFailure(
          cause,
          (failure) => failureCopy(failure._tag, "sync the order"),
          "Couldn't sync the order.",
        ),
    });
  };

  const openModal = (modalId: string, run: Run) => {
    setModalRunId(run.id);
    showModal(modalId);
  };
  const modalRun = runs.find(({ run }) => run.id === modalRunId)?.run ?? null;
  /** Empty until a workflow is picked, and on a run with no record ({@link changeWarning}). */
  const changingWarning = (() => {
    if (changing === null || changing.workflowId === null) return "";
    const to = changing.options.find((workflow) => workflow.id === changing.workflowId)?.name ?? "";
    return changeWarning(changing.from, to, changing.run, changing.tasks);
  })();

  /**
   * The Assign team select and Assign beside an unassigned task, open at rest because a task with
   * no team is a required field left empty, the one thing on the card that must be acted on. A
   * task that has a team changes it through the Assign team modal instead. The select starts
   * empty so Assign stays disabled until a team is chosen.
   */
  const assignTeam = (runTaskId: string) => {
    const chosen = assignChoice[runTaskId] ?? "";
    return (
      <SelectRow
        select={
          <s-select
            label={VERB_LABEL.assign.merchant}
            labelAccessibilityVisibility="exclusive"
            placeholder={VERB_LABEL.assign.merchant}
            value={chosen}
            disabled={pending}
            onChange={(event) => {
              const teamId = event.currentTarget.value;
              setAssignChoice((choice) => ({ ...choice, [runTaskId]: teamId }));
            }}
          >
            {teamOptions(teams)}
          </s-select>
        }
        submit={
          <s-button
            variant="secondary"
            disabled={pending || chosen === ""}
            onClick={() => {
              if (chosen !== "") void assign(runTaskId, chosen);
            }}
          >
            Assign
          </s-button>
        }
      />
    );
  };

  /**
   * The team issue of a run: one row per open task whose team is gone, named, with an Assign team
   * select, the remedy that makes a team delete safe. On the card, outside Manage, because it is
   * the one thing that must be acted on and a drawer would hide it.
   */
  const teamIssueRows = (tasks: readonly ActionableTask[]) => {
    const rows = tasks
      .filter(({ actions }) => actions.assign)
      .filter((task) => runTaskIsUnassigned(task, teams))
      .map((task) => (
        <Lines key={task.id}>
          <s-text type="strong">{`${task.name}: assign a team.`}</s-text>
          {assignTeam(task.id)}
        </Lines>
      ));
    return rows.length === 0 ? null : <Lines>{rows}</Lines>;
  };

  /**
   * The Manage drawer: the member page's step cards with the merchant's buttons ({@link RunSteps})
   * under a header naming the workflow, because the card does not; then the run's own actions
   * (Block, Cancel workflow, Change workflow) in one row under a rule. No action here is primary
   * and nothing here is red: every write on this page is a merchant reaching past a worker, and
   * Cancel and Change each open a modal whose submit is red. Assign team is tertiary: it opens a
   * modal rather than writing.
   */
  const manageRows = (
    run: Run,
    tasks: readonly ActionableTask[],
    actions: RunActions,
    change: ReactNode,
  ) => {
    const runRow = actions.block || actions.cancel || change !== null;
    return (
      <Panel kind="drawer">
        <Lines>
          <s-heading>{`${run.workflowName} workflow`}</s-heading>
          <RunSteps
            tasks={tasks}
            viewer="merchant"
            showInstructions={false}
            renderActions={(task) => {
              const can = task.actions;
              if (!can.done && !can.putBack && !can.reopen && !can.assign) return null;
              return (
                <>
                  {can.done && (
                    <s-button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        void presses
                          .press(merchantMarkTaskDoneAtom(task.id), { runTaskId: task.id })
                          .then(runWrite("task", `${task.name} done`));
                      }}
                    >
                      {VERB_LABEL.done.merchant}
                    </s-button>
                  )}
                  {can.putBack && (
                    <s-button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        void presses
                          .press(merchantPutBackTaskAtom(task.id), { runTaskId: task.id })
                          .then(runWrite("task", `${task.name} put back`));
                      }}
                    >
                      {VERB_LABEL.putBack.merchant}
                    </s-button>
                  )}
                  {can.reopen && (
                    <s-button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        void presses
                          .press(merchantReopenTaskAtom(task.id), { runTaskId: task.id })
                          .then(runWrite("task", `${task.name} reopened`));
                      }}
                    >
                      {VERB_LABEL.reopen.merchant}
                    </s-button>
                  )}
                  {can.assign && (
                    <s-button
                      variant="tertiary"
                      disabled={pending}
                      onClick={() => {
                        setAssigning({
                          runTaskId: task.id,
                          taskName: task.name,
                          teamId:
                            task.teamId !== null && teams.some((team) => team.id === task.teamId)
                              ? task.teamId
                              : "",
                          error: null,
                        });
                        showModal(ASSIGN_MODAL);
                      }}
                    >
                      {VERB_LABEL.assign.merchant}
                    </s-button>
                  )}
                </>
              );
            }}
          />
          {/* The task list is one object and the run's own actions another: mixed into the
              tasks they read as a fourth button on the last one. */}
          {runRow && <s-divider />}
          {runRow && (
            <Inline>
              {actions.block && (
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    openModal(BLOCK_MODAL, run);
                  }}
                >
                  {VERB_LABEL.block.merchant}
                </s-button>
              )}
              {actions.cancel && (
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setCancelling({
                      runId: run.id,
                      workflowName: run.workflowName,
                      item:
                        run.variantTitle === null
                          ? run.lineItemTitle
                          : `${run.lineItemTitle} — ${run.variantTitle}`,
                    });
                    showModal(CANCEL_RUN_MODAL);
                  }}
                >
                  {VERB_LABEL.cancel.merchant}
                </s-button>
              )}
              {change}
            </Inline>
          )}
        </Lines>
      </Panel>
    );
  };

  /** A run's badges: its state, and Blocked while blocked; they end the card's facts line. */
  const runBadges = (run: Run, tasks: readonly RunTaskRow[]) => {
    const badge = runStateBadge(run, tasks);
    return (
      <>
        <s-badge tone={badge.tone}>{badge.label}</s-badge>
        {runIsBlocked(run) && <s-badge tone="critical">{RUN_STATE_LABEL.blocked}</s-badge>}
      </>
    );
  };

  /**
   * One run inside its item's card, top to bottom: the {@link ClosedLine} on a closed run, the
   * {@link BlockBanner} while blocked (with Unblock), the now line, the {@link RunNote}, the team
   * issue rows, then Manage and, when open, the drawer it toggles. A closed run keeps its tasks
   * as the record, so Manage still lists them, with no buttons.
   *
   * Manage sits directly above the drawer it opens: a disclosure belongs next to what it
   * reveals. The label stays Manage in both states with a flipping chevron: `Hide` reads as
   * hiding the card, and `Done` collides with the task's Done inside.
   */
  const renderRun = (item: OrderLineItem, run: Run, rows: readonly RunTaskRow[]) => {
    const tasks: readonly ActionableTask[] = rows.map((task) => ({
      ...task,
      actions: taskActions(MERCHANT, order, run, task),
    }));
    const actions = runActions(MERCHANT, order, run, tasks, item);
    const now = nowLine({ run, tasks });
    const options = [...matchedWorkflows.map(({ workflow }) => workflow), ...otherWorkflows].filter(
      (workflow) => !runIsOpen(run) || workflow.id !== run.workflowId,
    );
    /**
     * Absent when the field is false, when the shop's only active workflow is the one an open run
     * already has, and on a closed run, whose item takes a new workflow from the Workflow select
     * at rest under it. A done run gets it here, behind the modal that names what it loses.
     */
    const change =
      !actions.changeWorkflow || options.length === 0 || runIsClosed(run) ? null : (
        <s-button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setChanging({
              lineItemId: item.id,
              from: run.workflowName,
              run,
              options,
              tasks,
              workflowId: null,
            });
            showModal(CHANGE_WORKFLOW_MODAL);
          }}
        >
          {VERB_LABEL.changeWorkflow.merchant}
        </s-button>
      );
    return (
      <Lines key={run.id}>
        <ClosedLine run={run} viewer="merchant" />
        <BlockBanner
          run={run}
          viewer="merchant"
          actions={
            actions.unblock ? (
              <Inline>
                <s-button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    void presses
                      .press(merchantUnblockRunAtom(run.id), { runId: run.id })
                      .then(runWrite("workflow", "Unblocked"));
                  }}
                >
                  {VERB_LABEL.unblock.merchant}
                </s-button>
              </Inline>
            ) : null
          }
        />
        {now !== null && <s-text>{now}</s-text>}
        <RunNote
          note={run.note}
          canEdit={actions.note}
          pending={pending}
          onEdit={() => {
            openModal(NOTE_MODAL, run);
          }}
        />
        {teamIssueRows(tasks)}
        <Inline>
          <s-button
            variant="secondary"
            icon={managingRun(run) ? "chevron-up" : "chevron-down"}
            onClick={() => {
              setManaging((current) => {
                const next = new Set(current);
                if (!next.delete(run.id)) next.add(run.id);
                return next;
              });
            }}
          >
            Manage
          </s-button>
        </Inline>
        {managingRun(run) && manageRows(run, tasks, actions, change)}
      </Lines>
    );
  };

  /**
   * The select and its Attach, at rest under an item with no run: the item's empty state rather
   * than an edit, so it is the one workflow control not in a modal. The options are the matched
   * workflows first, then a rule, then every other workflow: on a multi-match item the select is
   * the only way to a workflow the tags did not pull in. On a closed item the closed workflow is
   * among them; picking it starts a fresh run. The leading label is an `s-text` so the visible
   * word stays "Workflow".
   */
  const workflowSelect = (
    item: OrderLineItem,
    options: readonly WorkflowNameRow[],
    matched: readonly string[],
  ) => {
    const chosen = attachChoice[item.id] ?? "";
    return (
      <SelectRow
        label={<s-text color="subdued">Workflow</s-text>}
        select={
          <s-select
            label="Workflow"
            labelAccessibilityVisibility="exclusive"
            placeholder="Choose workflow"
            value={chosen}
            disabled={pending}
            onChange={(event) => {
              const workflowId = event.currentTarget.value;
              setAttachChoice((choice) => ({ ...choice, [item.id]: workflowId }));
            }}
          >
            {options.map((workflow, index) => (
              <Fragment key={workflow.id}>
                {/* `s-select` has no option groups, so a disabled option is the rule between
                    the matches and the rest. */}
                {index > 0 && index === matched.length && (
                  <s-option value="" disabled>
                    —
                  </s-option>
                )}
                <s-option value={workflow.id}>{workflow.name}</s-option>
              </Fragment>
            ))}
          </s-select>
        }
        submit={
          <s-button
            variant="secondary"
            disabled={pending || chosen === ""}
            onClick={() => {
              if (chosen !== "") void attach(item.id, chosen);
            }}
          >
            {VERB_LABEL.attachWorkflow.merchant}
          </s-button>
        }
      />
    );
  };

  /**
   * One item's card: title, facts, properties, then the body its {@link lineItemState} kind
   * draws. On a closed order the resting controls of `attachable`, `unmatched` and `ended` draw
   * nothing: the aside's Fulfillment and Cancelled lines already say why no work can start.
   */
  const renderLineItem = (item: OrderLineItem) => {
    const toMake = item.currentQuantity;
    const itemState = lineItemState(item, runs, matchedWorkflows, otherWorkflows, teams);
    /** Quantity and SKU, as one subdued line under the title. */
    const facts = [
      // Ordered vs. to make differ after an edit or a refund; fulfilment does not move it.
      toMake === item.quantity
        ? `× ${formatNumber(item.quantity)}`
        : `× ${formatNumber(toMake)} to make (${formatNumber(item.quantity)} ordered)`,
      ...(item.sku === null ? [] : [`SKU ${item.sku}`]),
    ].join(" · ");
    /**
     * A `switch` rather than `Match`: the branches return JSX, and TypeScript still refuses a
     * missing kind through `never`.
     */
    const body = ((): ReactNode => {
      switch (itemState.kind) {
        case "removed": {
          return null;
        }
        case "unmatched": {
          return orderOpen ? (
            <s-paragraph color="subdued">
              No workflow matches this item. Create one on{" "}
              <s-link {...props.workflowsLink}>Workflows</s-link>.
            </s-paragraph>
          ) : null;
        }
        case "attachable": {
          return orderOpen ? (
            <>
              {itemState.multiMatch && <s-paragraph>{MULTI_MATCH_SENTENCE}</s-paragraph>}
              {workflowSelect(item, itemState.options, itemState.matched)}
            </>
          ) : null;
        }
        // The run as the record; under a closed run, what the Cancel workflow modal promised:
        // the Workflow select, for a fresh run.
        case "ended": {
          return (
            <>
              {renderRun(item, itemState.run, itemState.tasks)}
              {orderOpen &&
                itemState.attachable &&
                runIsClosed(itemState.run) &&
                workflowSelect(item, itemState.options, itemState.matched)}
            </>
          );
        }
        case "open": {
          return renderRun(item, itemState.run, itemState.tasks);
        }
        default: {
          return itemState satisfies never;
        }
      }
    })();
    const withRun = itemState.kind === "open" || itemState.kind === "ended" ? itemState : null;
    // No `accessibilityLabel` on the section: with no `heading`, `s-section` renders the label as
    // a second, hidden heading and screen readers hear the title twice.
    return (
      <s-section key={item.id}>
        <Lines>
          <Lines>
            <s-heading>{lineItemTitle(item)}</s-heading>
            <Inline>
              {/* A token: a SKU is one unspaced word and may be long. */}
              <Token color="subdued">{facts}</Token>
              {item.currentQuantity === 0 && <s-badge tone="critical">Removed</s-badge>}
              {withRun !== null && runBadges(withRun.run, withRun.tasks)}
            </Inline>
          </Lines>
          {item.properties.length > 0 && (
            <Lines>
              <s-text color="subdued">Properties</s-text>
              <LineItemProperties properties={item.properties} />
            </Lines>
          )}
          {body !== null && body !== undefined && <Lines>{body}</Lines>}
        </Lines>
      </s-section>
    );
  };

  return (
    <s-page heading={order.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" {...props.ordersLink}>
        Orders
      </s-link>
      {/* The primary action leaves for the Shopify order: payment, fulfilment and the customer
          live there. Sync from Shopify is secondary because webhooks keep the order current. */}
      {inShopify && (
        <s-button
          slot="primary-action"
          variant="primary"
          href={adminOrderUrl(order)}
          target={resourceLinkTarget}
        >
          View in Shopify
        </s-button>
      )}
      {inShopify && (
        <s-button
          slot="secondary-actions"
          loading={syncing}
          disabled={pending}
          onClick={() => {
            void syncOrder();
          }}
        >
          Sync from Shopify
        </s-button>
      )}

      {/* No banner for a closed order: the aside's Fulfillment and Cancelled lines say it, and
          each closed run says why on its own card. */}
      {state === "made" && (
        <s-banner tone="success">
          Every item is done.
          {inShopify && (
            <>
              {" "}
              <s-link href={adminOrderUrl(order)} target={resourceLinkTarget}>
                Fulfill in Shopify
              </s-link>
              .
            </>
          )}
        </s-banner>
      )}
      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {lineItems.length === 0 ? (
        <s-paragraph color="subdued">No items.</s-paragraph>
      ) : (
        lineItems.map(renderLineItem)
      )}

      {/* One modal for the page, driven by `changing`. The select lives in it rather than
          inline under Manage because a filled field is changed in a modal. */}
      <s-modal
        id={CHANGE_WORKFLOW_MODAL}
        heading="Change workflow?"
        onAfterHide={() => {
          setChanging(null);
        }}
      >
        <Things>
          <s-select
            label="Workflow"
            placeholder="Choose workflow"
            value={changing?.workflowId ?? ""}
            disabled={pending}
            onChange={(event) => {
              const workflowId = event.currentTarget.value;
              setChanging((current) =>
                current === null
                  ? null
                  : { ...current, workflowId: workflowId === "" ? null : workflowId },
              );
            }}
          >
            {(changing?.options ?? []).map((workflow) => (
              <s-option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </s-option>
            ))}
          </s-select>
          <s-paragraph>{changingWarning}</s-paragraph>
        </Things>
        {/* No onClick: `onAfterHide` is the one reset, for Cancel, the backdrop and Escape. */}
        <s-button slot="secondary-actions" commandFor={CHANGE_WORKFLOW_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={presses.inFlight}
          disabled={pending || changing === null || changing.workflowId === null}
          onClick={() => {
            if (changing !== null && changing.workflowId !== null)
              void attach(changing.lineItemId, changing.workflowId);
          }}
        >
          {VERB_LABEL.changeWorkflow.merchant}
        </s-button>
      </s-modal>

      {/* Cancel workflow closes the run and there is no undo, so the question is asked here,
          naming the workflow and the item. The dismiss reads Keep workflow: a Cancel beside a
          primary Cancel workflow is two Cancels. */}
      <s-modal
        id={CANCEL_RUN_MODAL}
        heading={cancelling === null ? "" : cancelHeading(cancelling.workflowName)}
        onAfterHide={() => {
          setCancelling(null);
        }}
      >
        <Lines>
          {cancelling !== null && <Clamp>{cancelling.item}</Clamp>}
          <s-paragraph>{CANCEL_WARNING}</s-paragraph>
        </Lines>
        <s-button slot="secondary-actions" commandFor={CANCEL_RUN_MODAL} command="--hide">
          Keep workflow
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={presses.inFlight}
          disabled={pending || cancelling === null}
          onClick={() => {
            if (cancelling === null) return;
            const { runId, workflowName } = cancelling;
            void presses.press(cancelRunAtom(runId), { runId }).then((exit) => {
              if (Exit.isSuccess(exit) && exit.value._tag === "Ok") {
                setCancelling(null);
                hideModal(CANCEL_RUN_MODAL);
              }
              runWrite("workflow", `${workflowName} cancelled`)(exit);
            });
          }}
        >
          {VERB_LABEL.cancel.merchant}
        </s-button>
      </s-modal>

      {/* Assign team changes a filled field, so it is a modal; the select opens on the current
          team so the merchant sees what they are replacing. */}
      <s-modal
        id={ASSIGN_MODAL}
        heading={
          assigning === null
            ? VERB_LABEL.assign.merchant
            : `${VERB_LABEL.assign.merchant}: ${assigning.taskName}`
        }
        onAfterHide={() => {
          setAssigning(null);
        }}
      >
        <s-select
          label="Team"
          value={assigning?.teamId ?? ""}
          disabled={pending}
          {...(assigning === null || assigning.error === null ? {} : { error: assigning.error })}
          onChange={(event) => {
            const teamId = event.currentTarget.value;
            setAssigning((current) =>
              current === null ? null : { ...current, teamId, error: null },
            );
          }}
        >
          {teamOptions(teams)}
        </s-select>
        <s-button slot="secondary-actions" commandFor={ASSIGN_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={presses.inFlight}
          disabled={pending || assigning === null || assigning.teamId === ""}
          onClick={() => {
            if (assigning !== null && assigning.teamId !== "")
              void assign(assigning.runTaskId, assigning.teamId);
          }}
        >
          Assign
        </s-button>
      </s-modal>

      <RunNoteModal
        id={NOTE_MODAL}
        note={modalRun?.note ?? null}
        pending={pending}
        onSave={async (note) =>
          modalRun === null
            ? "That workflow is no longer on this item."
            : fromModal("Note saved")(
                await presses.press(merchantSetRunNoteAtom(modalRun.id), {
                  runId: modalRun.id,
                  note,
                }),
              )
        }
      />
      <BlockModal
        id={BLOCK_MODAL}
        run={
          // The run left the page under an open modal (a re-read after a Change workflow): the
          // heading names the order and a stand-in for the item, and the submit answers that
          // the workflow is gone.
          modalRun ?? {
            lineItemTitle: "this item",
            variantTitle: null,
            quantity: 1,
            orderName: order.name,
          }
        }
        pending={pending}
        onBlock={async (reason) =>
          modalRun === null
            ? "That workflow is no longer on this item."
            : fromModal("Blocked")(
                await presses.press(merchantBlockRunAtom(modalRun.id), {
                  runId: modalRun.id,
                  reason,
                }),
              )
        }
      />

      {order.note !== null && (
        <s-section slot="aside" heading="Order note">
          <Prose>{order.note}</Prose>
        </s-section>
      )}
      <s-section slot="aside" heading="Order details">
        <Pairs
          pairs={[
            ...fact("Placed", <LocalDateTime value={order.processedAt} />),
            ...fact(
              "Payment",
              <Inline>
                <s-badge tone={order.fullyPaid ? "success" : "warning"}>
                  {order.fullyPaid ? "Paid" : "Unpaid"}
                </s-badge>
              </Inline>,
            ),
            ...fact("Fulfillment", formatStatus(order.fulfillmentStatus)),
            ...fact(
              "Cancelled",
              order.cancelledAt === null ? null : <LocalDateTime value={order.cancelledAt} />,
            ),
          ]}
        />
      </s-section>
      <FootLine>
        Learn more in{" "}
        <s-link href="/help/orders/order-page" target="_blank">
          Reading an order
        </s-link>
        .
      </FootLine>
    </s-page>
  );
}

import type * as Domain from "@/lib/Domain";

/**
 * The rows of the two vocabulary reference pages, States and badges
 * (`reference/states-and-badges`) and Who can do what
 * (`reference/who-can-do-what`): for each state or verb, what the page says
 * beside its label. The label itself is never here. Each body reads it from
 * the label constant (`ORDER_POSITION_LABEL`, `ORDER_ISSUE_LABEL`,
 * `RUN_STATE_LABEL` and `RUN_UNSTARTED_LABEL`, `TASK_STATE_LABEL`,
 * `WORKFLOW_STATE_LABEL`, `WORKFLOW_FAULT_LABEL`, `VERB_LABEL`,
 * `RECORD_VERB_LABEL`, and the member list's `STATE_LABEL` in
 * `src/lib/workflowsListStates.ts`), so a label change on a vocabulary row
 * reaches the page with no edit here.
 *
 * **Each row set is `satisfies Record<State, …>`**: a state or verb without a
 * row, or a row without a state, is a type error. That is how the reference
 * stays held to the vocabulary; `pnpm spec check` holds each constant to its
 * vocabulary row, and `test/integration/help-reference.test.ts` that every
 * label is rendered.
 *
 * A row set is written in the vocabulary's order, and the bodies render it
 * in that order. A state whose label is `null` ("(none)": a waiting task, a
 * merchant's Start) has no row: the task table leaves waiting out and says
 * in a sentence that a later step's task has no badge, and the verbs table
 * leaves the member's or the merchant's cell empty.
 *
 * The badges no constant labels (Removed, No steps, Draft, No members, No
 * teams) carry their label here as a copy of the route's literal, beside
 * the route that prints it; the test cannot hold those to the code.
 *
 * Every string is screen copy in the vocabulary's screen words. The
 * retired-word lint reads `src/components/`, not `src/lib/`, so the test
 * holds these strings to `RETIRED`.
 */

/**
 * An order's position ({@link Domain.OrderPosition}), read against the
 * positions table in the vocabulary and `orderPosition`: Unpaid and No
 * workflow have no open or done workflow (a closed one counts as none),
 * Making is an open workflow beside a started task or a done workflow, Made
 * is no open workflow and a done one. The strip has cells for No workflow,
 * Not started, Making and Made (`STRIP` in `app.orders.index.tsx`); every
 * position is a Show value (`ORDERS_SHOW_LABEL`).
 */
export const ORDER_POSITION_ROWS = {
  unpaid: {
    where: "Status column and the Show select",
    meaning:
      "The order is open and not fully paid, and no item has a workflow. A matching workflow starts once it is paid.",
  },
  no_workflow: {
    where: "Status column, the strip and the Show select",
    meaning:
      "The order is open and paid, and no item has a workflow on it. Its products carry no workflow's tag, the workflow was cancelled, or Shopify removed the item.",
  },
  not_started: {
    where: "Status column, the strip and the Show select",
    meaning:
      "An item has a workflow, and nobody has started a task on the order yet.",
  },
  making: {
    where: "Status column, the strip and the Show select",
    meaning:
      "A task has been started, or one item's workflow is done while another's is still open. The Orders page opens here.",
  },
  made: {
    where: "Status column, the strip and the Show select",
    meaning:
      "No item's workflow is open, and at least one is done. The order waits to be fulfilled in Shopify.",
  },
  fulfilled: {
    where: "Status column and the Show select",
    meaning:
      "Shopify says the order is fulfilled. A Made order moves here on its own.",
  },
  cancelled: {
    where: "Status column and the Show select",
    meaning: "The order was cancelled in Shopify.",
  },
} as const satisfies Record<
  Domain.OrderPosition,
  { readonly where: string; readonly meaning: string }
>;

/**
 * An order's issues ({@link Domain.OrderIssue}): what each means and its one
 * remedy, the Remedy column of the table on `OrderIssue` in the words of
 * `orders/fixing-issues.tsx`.
 */
export const ORDER_ISSUE_ROWS = {
  multi_match: {
    meaning:
      "An item carries the tags of two or more active workflows, so none started.",
    clears:
      "Choose a workflow in the item's Workflow select on the order's page, and press Attach.",
  },
  unassigned: {
    meaning:
      "A task on an item has no team, because its team was deleted. Nobody can work it.",
    clears:
      "Choose a team in the Assign team select on the order's page, and press Assign.",
  },
  blocked: {
    meaning:
      "A member on the team of the current task, or the merchant, blocked an item.",
    clears: "Press Unblock in the item's banner once the cause is dealt with.",
  },
} as const satisfies Record<
  Domain.OrderIssue,
  { readonly meaning: string; readonly clears: string }
>;

/**
 * The badges on an item's card on the order page: `runBadges` and
 * `RUN_STATE_BADGE` in `app.orders.$orderId.tsx`. `unstarted` is
 * {@link Domain.RUN_UNSTARTED_LABEL}, the rest {@link Domain.RUN_STATE_LABEL}.
 * Blocked shows only beside Not started or Making: a done workflow is
 * never blocked, and closing one clears its block. Closed's reasons are
 * appended by the body from `closedReasonText` in
 * `src/components/MemberRun.tsx`, the one place the card's line reads them.
 */
export const ITEM_WORKFLOW_ROWS = {
  unstarted: {
    meaning: "The item has a workflow, and nobody has started a task on it.",
  },
  open: {
    meaning:
      "Someone has started or done a task, and the workflow is not done.",
  },
  done: {
    meaning: "Someone pressed Done on the last task.",
  },
  closed: {
    meaning:
      "Something other than a Done ended the workflow. The line under the badges says what:",
  },
  blocked: {
    meaning:
      "Shows beside Not started or Making while the item is blocked. A red banner gives the reason, who blocked it and when.",
  },
} as const satisfies Record<
  keyof typeof Domain.RUN_STATE_LABEL | "unstarted",
  { readonly meaning: string }
>;

/** The item's badge no constant labels: `Removed`, beside `currentQuantity` at zero in `app.orders.$orderId.tsx`. */
export const ITEM_BADGE_ROWS = {
  removed: {
    label: "Removed",
    meaning:
      "The item was removed from the order in Shopify, or refunded in full.",
  },
} as const;

/**
 * A task's badge ({@link Domain.TaskState}), from `RunSteps` in
 * `src/components/RunSteps.tsx`. Waiting has no label and no row.
 */
export const TASK_STATE_ROWS = {
  ready: {
    meaning:
      "Its step is current and nobody has started it. Anyone on its team can.",
  },
  started: {
    meaning:
      "Someone has started it. The line under it says who and since when.",
  },
  done: {
    meaning: "Someone pressed Done on it. The line under it says who and when.",
  },
} as const satisfies Record<
  Exclude<Domain.TaskState, "waiting">,
  { readonly meaning: string }
>;

/**
 * A workflow's state ({@link Domain.WorkflowState}): the badge on the
 * workflows index (`stateBadges`) and by the workflow page's heading.
 */
export const WORKFLOW_STATE_ROWS = {
  active: {
    where: "Workflows page, and beside the name on the workflow's page",
    meaning: "It starts on every new item that carries its tag.",
  },
  inactive: {
    where: "Workflows page, and beside the name on the workflow's page",
    meaning: "It starts nothing. Items already on it keep going.",
  },
} as const satisfies Record<
  Domain.WorkflowState,
  { readonly where: string; readonly meaning: string }
>;

/**
 * A workflow's faults ({@link Domain.WorkflowFault}): a badge on the
 * workflows index; on the workflow page and the editor `unassigned` is the
 * banner (`TeamFaultBanners`) and `empty_team` the No members badge on the
 * step (`TeamLine`), both in `src/components/WorkflowSteps.tsx`. Only
 * `unassigned` keeps a workflow from starting (`workflowIsEligible`).
 */
export const WORKFLOW_FAULT_ROWS = {
  unassigned: {
    where:
      "Workflows page, and a banner on the workflow's page and in the editor",
    meaning:
      "A task has no team, because its team was deleted. The workflow starts on no new item until the task has a team.",
  },
  empty_team: {
    where:
      "Workflows page. On a step, the team reads No members beside its name.",
    meaning:
      "A task's team has nobody on it. The workflow still starts, and the task waits until someone joins the team.",
  },
} as const satisfies Record<
  Domain.WorkflowFault,
  { readonly where: string; readonly meaning: string }
>;

/**
 * The workflow badges no constant labels: `No steps` in `stateBadges`
 * (`app.workflows.index.tsx`), and `Draft` on the workflow page and the
 * editor, alone on a never-applied workflow and beside its state otherwise.
 */
export const WORKFLOW_BADGE_ROWS = {
  noSteps: {
    label: "No steps",
    where: "Workflows page",
    meaning: "The workflow has no steps yet. It starts nothing.",
  },
  draft: {
    label: "Draft",
    where: "The workflow's page and the editor",
    meaning:
      "The editor holds changes not yet applied. A new workflow reads Draft alone, in place of Active or Inactive, until it is first turned on.",
  },
} as const;

/**
 * The team and member badges: `No members` on the teams index and, on a
 * step, `TeamLine`; `No teams` on the members index. No constant labels
 * them.
 */
export const TEAM_MEMBER_BADGE_ROWS = {
  noMembers: {
    label: "No members",
    where: "Teams page, and beside a team's name on a workflow's step",
    meaning:
      "Nobody is on the team. Its tasks still start on new items, and nobody can work them until someone joins.",
  },
  noTeams: {
    label: "No teams",
    where: "Members page",
    meaning: "The member is on no team, so they see no work.",
  },
} as const;

/**
 * The member's workflows list's filters ({@link Domain.WorkflowsListState}),
 * labelled by `STATE_LABEL`, read against its JSDoc, `listStateOf` (a block
 * wins, then a task you started, then any started task, then Ready),
 * `RecentItem` and `DONE_WINDOW_MS`, and `members/finding-your-work.tsx`.
 * Only a member starts a task (`VERB_LABEL.start` has no merchant label, and
 * a merchant's Done leaves the task done, not started), so Started by others
 * names a teammate and never the merchant.
 */
export const LIST_FILTER_ROWS = {
  started_by_you: {
    holds: "Items with a task you started. The list opens here.",
  },
  started_by_others: {
    holds: "Items with a task a teammate started.",
  },
  ready: {
    holds:
      "Items whose current task nobody has started. Anyone on its team can.",
  },
  blocked: {
    holds:
      "Items someone stopped, with the reason. A blocked item is listed here, not under Started by you, Started by others or Ready.",
  },
  done: {
    holds:
      "Tasks your teams did in the last day, and items whose workflow ended in that time, with the reason.",
  },
} as const satisfies Record<
  Domain.WorkflowsListState,
  { readonly holds: string }
>;

/** The four workflow verbs: the merchant's alone, on the workflow page and the editor. */
type WorkflowVerb = "apply" | "discard" | "turnOn" | "turnOff";

/**
 * The work verbs ({@link Domain.Verb} less the four workflow verbs), read
 * against `taskActions` and `runActions` in `src/lib/domain/ShopWork.ts`:
 * the When cell is the matrix's rows in screen words, and agrees with
 * `members/recording-your-work.tsx` and `members/blocking.tsx` where they
 * overlap. A task verb works on the current step's task only (`taskActions`
 * reads `current`), except Reopen and Assign team. "An open order" is one
 * not fulfilled or cancelled (`orderIsOpen`); the body's paragraph says so.
 */
export const WORK_VERB_ROWS = {
  start: {
    what: "Start a task",
    when: "A ready task on your team, while the item is not blocked. Only a member starts a task.",
  },
  done: {
    what: "Say a task is done",
    when: "A ready or started task, while the item is not blocked. A member presses it on their own team's tasks. Done without Start records the start too.",
  },
  putBack: {
    what: "Put a started task back to Ready",
    when: "A started task, while the item is not blocked. Anyone on its team can, not only who started it.",
  },
  reopen: {
    what: "Take back a Done",
    when: "A done task, while no task in a later step has been started or done. Anyone on its team can. Not once the order or the item's workflow is closed.",
  },
  assign: {
    what: "Move a task to a team",
    when: "Any task that is not done, at any step, while the item's workflow is open. Blocked or not.",
  },
  note: {
    what: "Write the item's note",
    when: "Anyone on a team with a task on the item, at any step, and the merchant. Always, even once the order or the workflow is closed.",
  },
  block: {
    what: "Stop the work on an item",
    when: "An item whose workflow is open, on an open order, and not already blocked. A member must be on the team of the current task.",
  },
  unblock: {
    what: "Let the work go on",
    when: "A blocked item on an open order. Anyone on the current task's team can, not only who blocked it.",
  },
  cancel: {
    what: "Take the workflow off an item",
    when: "An item whose workflow is open, on an open order. A done or closed workflow cannot be cancelled.",
  },
  attachWorkflow: {
    what: "Put a workflow on an item",
    when: "An item with no workflow and something left to make, on an open order, paid or not.",
  },
  changeWorkflow: {
    what: "Put another workflow on an item",
    when: "An item with something left to make, on an open order, whatever state its workflow is in. Under a closed workflow, the Workflow select does it.",
  },
} as const satisfies Record<
  Exclude<Domain.Verb, WorkflowVerb>,
  { readonly what: string; readonly when: string }
>;

/**
 * The four workflow verbs, read against the Verbs table's effect column,
 * `WorkflowSwitch`, the triggers table on `reconcileItem` (Turn on starts
 * the workflow on stored open, paid orders) and `workflows/editing.tsx`
 * (an item already on the workflow keeps its own copy of the tasks).
 */
export const WORKFLOW_VERB_ROWS = {
  apply: {
    on: "A workflow's draft",
    does: "Puts the draft's steps and tasks in force for new items. Items already on the workflow keep their own copy.",
  },
  discard: {
    on: "A workflow's draft",
    does: "Deletes the draft. The workflow stays as it was.",
  },
  turnOn: {
    on: "A workflow",
    does: "Makes it Active. It starts on the items that carry its tag, on every open, paid order. An item already on a workflow keeps it.",
  },
  turnOff: {
    on: "A workflow",
    does: "Makes it Inactive. It starts nothing new, and items already on it keep going.",
  },
} as const satisfies Record<
  WorkflowVerb,
  { readonly on: string; readonly does: string }
>;

/**
 * The record verbs ({@link Domain.RecordVerb}), the Record verbs table's
 * "on a" and "for" columns in screen words, and where each button is:
 * Create on the teams and workflows indexes, Add on the members index, the
 * team page, the member page and in the editor, Remove on the team and
 * member pages, Rename on the team and workflow pages, Edit and Duplicate
 * on the workflow page, Delete on the team, member and workflow pages.
 */
export const RECORD_VERB_ROWS = {
  create: {
    on: "A team or a workflow",
    does: "Makes a new one.",
  },
  delete: {
    on: "A team, a member or a workflow",
    does: "It stops existing, and it cannot be undone. Items already on a deleted workflow keep going, and recorded work keeps its names.",
  },
  add: {
    on: "A member, a team's members, a member's teams, or a step or task in the editor",
    does: "Brings a member into the shop, puts a member on a team, or makes a step or a task.",
  },
  remove: {
    on: "A team's members or a member's teams",
    does: "Takes a member off a team. Both still exist.",
  },
  rename: {
    on: "A team or a workflow",
    does: "Changes its name.",
  },
  edit: {
    on: "A workflow",
    does: "Opens the editor, where changes go into a draft.",
  },
  duplicate: {
    on: "A workflow",
    does: "Copies its steps and tasks under a new name and tag. The copy is Inactive.",
  },
} as const satisfies Record<
  Domain.RecordVerb,
  { readonly on: string; readonly does: string }
>;

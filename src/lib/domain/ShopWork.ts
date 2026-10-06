/**
 * Vocabulary, shop work. The work of making what the shop sold: who does it,
 * in what steps, and how far along it is. The screen
 * columns are checked: each cell is the value of the label constant beside
 * the table ({@link TASK_STATE_LABEL},
 * {@link RUN_STATE_LABEL}, {@link WORKFLOW_STATE_LABEL},
 * {@link ORDER_POSITION_LABEL}, {@link ORDER_ISSUE_LABEL},
 * {@link WORKFLOW_FAULT_LABEL}, {@link VERB_LABEL},
 * {@link RECORD_VERB_LABEL}), and `pnpm spec check`
 * refuses a cell that differs, so
 * a label change starts here.
 *
 * Nouns, shop work. "(none)" means no screen says the word; the
 * cell says what a screen shows instead:
 *
 * | word          | meaning                                                                                                    | symbol                                                                                   | screen                                                      |
 * | ------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
 * | merchant      | the shop's owner, acting from the Shopify admin                                                            | `Actor` role `merchant`                                                                  | "you" to the merchant, "the merchant" to a member           |
 * | member        | a person at the bench, on one or more teams                                                                | `Actor` role `member`, `Member`                                                          | member (merchant screens); "you" or a name (member screens) |
 * | team          | the group a task is assigned to                                                                            | `Team`                                                                                   | team, or its name                                           |
 * | workflow      | the definition: steps of tasks                                                                             | `Workflow`, `WorkflowTask`                                                               | workflow, or its name                                       |
 * | step          | a position in a workflow; its tasks are done in parallel                                                   | `WorkflowTask`, `RunTask` field                                                          | Step k of n                                                 |
 * | run           | one item going through one workflow                                                                        | `Run`                                                                                    | the item's workflow, on both sides; never bare, never "run" |
 * | task          | one unit of work on a run, on one team                                                                     | `RunTask`                                                                                | task, or its name                                           |
 * | block         | a person's hold on a run                                                                                   | `runIsBlocked`                                                                           | Blocked                                                     |
 * | note          | free text on a run                                                                                         | `RunNote`                                                                                | Note                                                        |
 * | draft         | the workflow's edited copy of its tasks, from Edit until Apply or Discard; one or none                     | `Workflow` field `draftTasks`                                                            | Draft                                                       |
 * | filter        | one axis of a list with a fixed set of values; the list shows the rows matching every chosen filter        | `OrdersShow`, `WorkflowsListState`, `WorkflowsIndexState`, `ListOrdersInput`, `RunQuery` | the axis name (Show, Team) or the value (Making, Ready)     |
 * | count         | how many rows a filter value would show, given the other filters and never the search                      | `OrderCounts`, `RunListCounts`                                                           | the number beside the value                                 |
 * | search        | free text matched against a row's order number, item title, variant title and SKU, or a workflow's name; finds, does not narrow | `ListSearch`, `searchTerm`                                                               | Search by order number or item                              |
 * | default       | what a list shows with no filter and no search                                                             | `null` show (Open); `DEFAULT_WORKFLOWS_LIST_STATE`                                       | Open; Started by you                                        |
 * | reconcile     | make an order's runs agree with the order and the eligible workflows; idempotent                           | `reconcileItem`, `RunRepository.reconcileOrder`                                          | (none)                                                      |
 * | reconcile all | reconcile every stored open, paid order once, after anything that changes which workflows are eligible     | `ShopWorkAgent.reconcileAllNow`, `RunRepository.reconcileAll`                            | (none)                                                      |
 * | eligible      | a workflow that is on, has a task, and has every task on a team; only an eligible workflow creates runs    | `workflowIsEligible`, `EligibleContext`                                                  | (none): Needs a team names the fault                        |
 * | match         | an item and an eligible workflow: a product tag equals the workflow's tag and units to make are above zero | `itemMatches`                                                                            | the order page's Workflow select lists them first                    |
 * | multi-match   | an item two or more eligible workflows match, with units to make and no run in any state                   | `multiMatchItems`, `OrderIssue` `multi_match`                                            | Multiple workflows match                                    |
 * | units to make | what is left to make on an item: Shopify's current quantity                                                | `unitsToMake`                                                                            | the quantity on the card                                    |
 *
 * Each list's main filter is keyed in the URL by its axis's word:
 * `?show=` on the orders index (`OrdersShow`), `?state=` on the
 * workflows index (`WorkflowsIndexState`) and on the member's workflows list
 * (`WorkflowsListState`). The literal is the label's words (`started_by_you`
 * reads Started by you), so a URL a person reads names what the screen shows.
 * The orders index's Team is a filter of its own (`?team=`), and a search
 * (`?q=`) ignores every filter.
 *
 * "run" is an implementation noun a merchant or member would have to learn;
 * the merchant already has the item and its workflow (Change workflow replaces
 * the run without naming it), and the member has the item's workflow and
 * its tasks. `scripts/rules-lint.ts` refuses "run", "line item" and the
 * other retired words in screen strings. The run's screen word is
 * "workflow" with the item beside it: the member's row is the item ("Brass
 * hinge ×2") over its tasks and then "Finishing · Step 2 of 3", the workflow
 * page heads "Finishing workflow · #1001". On the merchant's Workflows pages a bare
 * workflow name is the definition; on the member's Workflows list, which
 * never shows a definition, every row is a run and names its item.
 *
 * Run states, shop work:
 *
 * | word    | meaning                                           | stored          | screen                                                  |
 * | ------- | ------------------------------------------------- | --------------- | ------------------------------------------------------- |
 * | open    | work can be recorded                              | `open`          | In progress (merchant: Not started until a task starts) |
 * | blocked | open, and a person holds it                       | `blockedAt` set | Blocked                                                 |
 * | done    | a person marked the last task done                | `done`          | Done                                                    |
 * | closed  | something else ended it; `closedReason` says what | `closed`        | Closed · <reason>                                       |
 *
 * Task states, shop work. `current` is the flag, not a column: the task's
 * step is the lowest with an open task ({@link currentTasks}), whether or
 * not someone has it, and a `stored` cell ending "; current" or "; not
 * current" adds it. The
 * one derivation is {@link taskStateOf}; it reads `startedAt` before
 * `current`, so a task someone had when its run closed still reads started,
 * and a started task on an open run is always current:
 *
 * | word    | meaning                            | stored                                       | screen  |
 * | ------- | ---------------------------------- | -------------------------------------------- | ------- |
 * | waiting | its step is not current            | `startedAt` null, `doneAt` null; not current | (none)  |
 * | ready   | its step is current, nobody has it | `startedAt` null, `doneAt` null; current     | Ready   |
 * | started | a person has it                    | `startedAt` set                              | Started |
 * | done    | a person marked it done            | `doneAt` set                                 | Done    |
 *
 * "In progress" is the run's screen word and only the run's: a started
 * task reads Started so the merchant never reads one word for two facts
 * on one card. "waiting" is a code word; the team filter's "waiting on"
 * ({@link ListOrdersInput} `team`) means a team holding a current task, a
 * fact about orders, and the two never render together.
 *
 * Workflow states, shop work:
 *
 * | word | meaning                               | stored | screen |
 * | ---- | ------------------------------------- | ------ | ------ |
 * | on   | new items get runs from it            | `on`   | On     |
 * | off  | it creates nothing; open runs carry on | `off`  | Off    |
 *
 * The switch's screen words are Shopify Flow's (Turn on, Turn off;
 * `refs/flow-manual/manage/manual.md`); the badge says On and Off where Flow
 * says Active and Inactive, because "active" is not a shop-work word here,
 * and one execution is never called a run on a screen, because a run in
 * Baton is a member's work.
 *
 * Order positions, shop work: one per order, derived, never stored, by
 * {@link orderPosition}:
 *
 * | word        | meaning                           | screen      |
 * | ----------- | --------------------------------- | ----------- |
 * | not started | open, no open run and no done run | Not started |
 * | making      | open, an open run                 | Making      |
 * | made        | open, done runs and no open run   | Made        |
 * | fulfilled   | Shopify says `FULFILLED`          | Fulfilled   |
 * | cancelled   | Shopify says `cancelledAt`        | Cancelled   |
 *
 * Order issues, shop work: zero or more per open order, derived, never
 * stored, by {@link orderIssues}:
 *
 * | word        | meaning                                                   | screen                   |
 * | ----------- | --------------------------------------------------------- | ------------------------ |
 * | multi-match | a multi-match item on the order ({@link multiMatchItems}) | Multiple workflows match |
 * | unassigned  | an open task on no team                                   | Needs a team             |
 * | blocked     | a run on the order is blocked, the run-state word         | Blocked                  |
 *
 * Workflow faults, shop work: zero or more per workflow, derived, never
 * stored, shown as badges on the workflows index ({@link WorkflowFault}):
 *
 * | word       | meaning                          | screen              |
 * | ---------- | -------------------------------- | ------------------- |
 * | unassigned | a task on no team                | Needs a team        |
 * | empty team | a task on a team with no members | Team has no members |
 *
 * `unassigned` is a workflow fault and an order issue with one label, so one
 * fault reads the same wherever it shows. On the workflow page `unassigned`
 * is the one banner, under the same label; `empty team` is a "No members"
 * badge beside the team's name on the step, the teams index's word for the
 * team's own state ({@link WORKFLOW_FAULT_LABEL}).
 *
 * Verbs, shop work. Who may do each, and in which state, is the matrix on
 * {@link taskActions} or {@link runActions}, not here; the four workflow
 * verbs are the merchant's alone, on the merchant's workflow page and the
 * workflow editor, and {@link ApplyResult}, {@link DiscardResult} and
 * {@link SwitchResult} say what each refuses. The two screen
 * columns are the member's and the merchant's label; "(none)" means that
 * screen never offers the verb. Undo and Reopen are two words for one
 * verb on purpose: on the bench it takes back a Done, usually one's own,
 * and the whole team may press it, as it may Put back; the merchant
 * reopens someone's record. "done" is the verb "mark done", the state it
 * leaves the task in; the identifiers say `markTaskDone`.
 *
 * | word            | on a     | effect                                   | member      | merchant        |
 * | --------------- | -------- | ---------------------------------------- | ----------- | --------------- |
 * | start           | task     | ready → started                          | Start       | (none)          |
 * | done            | task     | ready or started → done                  | Done        | Done            |
 * | put back        | task     | started → ready                          | Put back    | Put back        |
 * | reopen          | task     | done → ready                             | Undo        | Reopen          |
 * | assign          | task     | moves it to a team                       | (none)      | Assign team     |
 * | note            | run      | writes the note                          | Edit note   | Edit note       |
 * | block           | run      | open → blocked                           | Block       | Block           |
 * | unblock         | run      | blocked → open                           | Unblock     | Unblock         |
 * | cancel          | run      | open → closed, `merchant_cancelled`      | (none)      | Cancel workflow |
 * | attach workflow | item     | creates the run                          | (none)      | Attach          |
 * | change workflow | item     | replaces the run                         | (none)      | Change workflow |
 * | apply           | workflow | the draft's tasks replace the workflow's | (none)      | Apply changes   |
 * | discard         | workflow | deletes the draft                        | (none)      | Discard changes |
 * | turn on         | workflow | off → on                                 | (none)      | Turn on         |
 * | turn off        | workflow | on → off                                 | (none)      | Turn off        |
 *
 * Record verbs, shop work: what the merchant does to a team, a workflow or
 * a member, or to a set one holds, beside the work verbs above. Create is
 * for a thing the merchant makes from nothing (a team, a workflow). Add is
 * for a person brought into the shop (a member), a thing already in the
 * shop put in a set, and a step or a task made inside the workflow editor.
 * A member is added though adding writes a new row: the merchant does not
 * make the person, and the new row (a deleted email re-added mints a new
 * id) is a storage fact the screen never shows. Delete is a member's delete
 * as it is a team's, and Remove still never names a delete: it takes a
 * thing out of a set and both still exist. Edit is a workflow's tasks only;
 * "Edit <noun>s" for a set is retired. Which control each one is, is the
 * controls table on `Control` in `Screen.ts`. The screen column is
 * {@link RECORD_VERB_LABEL}, and a button reads its verb from it:
 *
 * | word      | on a                      | for                                                                                                                       | merchant  |
 * | --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------- |
 * | create    | thing                     | a team or a workflow begins to exist                                                                                      | Create    |
 * | delete    | thing                     | it stops existing, with nothing of it kept                                                                                | Delete    |
 * | add       | member, set, step or task | a member joins the shop; a member goes on a team, or a team into a member's teams; a step or a task is made in the editor | Add       |
 * | remove    | set                       | takes a member off a team; both still exist                                                                               | Remove    |
 * | rename    | thing                     | changes its name                                                                                                          | Rename    |
 * | edit      | workflow                  | changes its tasks, through the draft                                                                                      | Edit      |
 * | duplicate | workflow                  | copies it under a new name and tag                                                                                        | Duplicate |
 */

/**
 * The action tables cover buttons, and a run leaving Started by you, Started by
 * others, Ready and Blocked is its state, not a button: a table can say a run
 * offers nothing and a list can still show it, so which rows a list holds is
 * decided by {@link RunState} (open runs only) and nothing else, the same
 * rule for every list. A page
 * never decides a gate itself: what an item's card is comes from
 * {@link lineItemState}, and which writes an actor may make comes from
 * {@link runActions} and {@link taskActions}, which the page and `ShopAgent`
 * both read.
 */
import { Match, Schema, SchemaGetter, Struct } from "effect";

import {
  LineItemProperty,
  orderCanCreateRuns,
  orderIsCancelled,
  orderIsFulfilled,
  orderIsOpen,
  OrderLineItem,
  OrdersSyncStatus,
  OrderState,
  ShopOrder,
} from "./Orders.ts";
import {
  BoundedId,
  ConnectionRole,
  Email,
  formatNumber,
  Shop,
  WorkflowLimits,
} from "./Platform.ts";

/**
 * The vocabulary's task-state words. Derived, never stored: {@link taskStateOf}
 * reads them off a task's row and its `current` flag.
 */
export const TaskState = Schema.Literals([
  "waiting",
  "ready",
  "started",
  "done",
]);
export type TaskState = typeof TaskState.Type;

/**
 * One task's state ({@link TaskState}) from its row and the `current` flag
 * ({@link RunTaskRow}). The one derivation: a page that draws a task's
 * badge reads this rather than testing the columns itself.
 *
 * `startedAt` is read before `current`. On an open run the order does not
 * matter, because a started task is always current: nothing behind it can
 * reopen while it is started ({@link laterStepStarted}). On a closed run no
 * task is current ({@link currentTasks}), and a task someone had when the run
 * closed still reads started, because the closed card is the record of who
 * had what.
 */
export const taskStateOf = (
  task: Pick<RunTaskRow, "current" | "startedAt" | "doneAt">,
): TaskState => {
  if (task.doneAt !== null) return "done";
  if (task.startedAt !== null) return "started";
  return task.current ? "ready" : "waiting";
};

/** The vocabulary's task-states screen column. `null` is "(none)". */
export const TASK_STATE_LABEL = {
  waiting: null,
  ready: "Ready",
  started: "Started",
  done: "Done",
} as const satisfies Record<TaskState, string | null>;

/**
 * The vocabulary's run-states screen column. `open` is the member's word for
 * an open run and the merchant's once a task has started; the merchant's
 * word before that is {@link RUN_UNSTARTED_LABEL} ({@link runIsUnstarted}).
 * `closed` is the prefix of `Closed · <reason>` ({@link ClosedReason}).
 */
export const RUN_STATE_LABEL = {
  open: "In progress",
  blocked: "Blocked",
  done: "Done",
  closed: "Closed",
} as const;

/** The merchant's word for an open run nobody has touched ({@link runIsUnstarted}); the vocabulary's run-states `open` row names it. */
export const RUN_UNSTARTED_LABEL = "Not started";

/** The vocabulary's workflow-states screen column, for {@link workflowIsOn}. */
export const WORKFLOW_STATE_LABEL = { on: "On", off: "Off" } as const;

/**
 * The merchant's workflows index's main filter, in row order: All and the
 * two workflow states ({@link workflowIsOn}, labelled by
 * {@link WORKFLOW_STATE_LABEL}). Keyed `?state=` because each value is a
 * workflow state. All is the default and is not a value: it is the key left
 * out, as Open is `?show=` left out on the orders index
 * ({@link OrdersShow}).
 */
export const WorkflowsIndexState = Schema.Literals(["on", "off"]);
export type WorkflowsIndexState = typeof WorkflowsIndexState.Type;

/**
 * The vocabulary's order-positions screen column: the orders index's Status
 * badge and the position values of its Show filter ({@link OrdersShow}). "Not started" is also
 * {@link RUN_UNSTARTED_LABEL}, the merchant's word for an open run nobody has
 * touched: it is the same fact one level down, and the two never render on
 * one row (the orders index shows positions, the order page shows runs).
 */
export const ORDER_POSITION_LABEL = {
  not_started: "Not started",
  making: "Making",
  made: "Made",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
} as const satisfies Record<OrderPosition, string>;

/**
 * The vocabulary's workflow-faults screen column: the workflows index's
 * badges, with {@link ORDER_ISSUE_TONE}; on a workflow page `unassigned` is
 * the one banner (it disables Apply and Turn on) and `empty_team` is a
 * "No members" badge on the step, the teams index's word, because it
 * disables nothing and sits beside the team's name.
 */
export const WORKFLOW_FAULT_LABEL = {
  unassigned: "Needs a team",
  empty_team: "Team has no members",
} as const satisfies Record<WorkflowFault, string>;

/**
 * The vocabulary's order-issues screen column: the badges in the orders index's
 * Issues column. A row of filter buttons used to carry these words too; now
 * only the badges do, and the Show filter's Issues value holds all of them. `unassigned`
 * reads {@link WORKFLOW_FAULT_LABEL}, so the fault has one label on every
 * screen.
 */
export const ORDER_ISSUE_LABEL = {
  multi_match: "Multiple workflows match",
  unassigned: WORKFLOW_FAULT_LABEL.unassigned,
  blocked: "Blocked",
} as const satisfies Record<OrderIssue, string>;

/**
 * The labels of the orders index's Show filter ({@link OrdersShow}), in the
 * select's order: Open, the open positions of {@link ORDER_POSITION_LABEL},
 * Issues, the closed positions, All. Not a vocabulary table: Open, Issues and
 * All carry no rule of their own, and the two vocabulary tables cover the
 * words. `open` keys the default, which is `?show=` left out.
 */
export const ORDERS_SHOW_LABEL = {
  open: "Open",
  not_started: ORDER_POSITION_LABEL.not_started,
  making: ORDER_POSITION_LABEL.making,
  made: ORDER_POSITION_LABEL.made,
  issues: "Issues",
  fulfilled: ORDER_POSITION_LABEL.fulfilled,
  cancelled: ORDER_POSITION_LABEL.cancelled,
  all: "All",
} as const satisfies Record<OrdersShow | "open", string>;

/**
 * The vocabulary's verbs, as the action structs name them ({@link RunActions},
 * {@link TaskActions}), plus the two item verbs and the four workflow verbs.
 */
export const Verb = Schema.Literals([
  "start",
  "done",
  "putBack",
  "reopen",
  "assign",
  "note",
  "block",
  "unblock",
  "cancel",
  "attachWorkflow",
  "changeWorkflow",
  "apply",
  "discard",
  "turnOn",
  "turnOff",
]);
export type Verb = typeof Verb.Type;

/** The vocabulary's two screen columns for verbs. `null` is "(none)": that screen never offers the verb. */
export const VERB_LABEL = {
  start: { member: "Start", merchant: null },
  done: { member: "Done", merchant: "Done" },
  putBack: { member: "Put back", merchant: "Put back" },
  reopen: { member: "Undo", merchant: "Reopen" },
  assign: { member: null, merchant: "Assign team" },
  note: { member: "Edit note", merchant: "Edit note" },
  block: { member: "Block", merchant: "Block" },
  unblock: { member: "Unblock", merchant: "Unblock" },
  cancel: { member: null, merchant: "Cancel workflow" },
  attachWorkflow: { member: null, merchant: "Attach" },
  changeWorkflow: { member: null, merchant: "Change workflow" },
  apply: { member: null, merchant: "Apply changes" },
  discard: { member: null, merchant: "Discard changes" },
  turnOn: { member: null, merchant: "Turn on" },
  turnOff: { member: null, merchant: "Turn off" },
} as const satisfies Record<
  Verb,
  { readonly member: string | null; readonly merchant: string | null }
>;

/** The vocabulary's record verbs, keyed by word. */
export const RecordVerb = Schema.Literals([
  "create",
  "delete",
  "add",
  "remove",
  "rename",
  "edit",
  "duplicate",
]);
export type RecordVerb = typeof RecordVerb.Type;

/** The Record verbs table's screen column: the merchant's button word for each. */
export const RECORD_VERB_LABEL = {
  create: "Create",
  delete: "Delete",
  add: "Add",
  remove: "Remove",
  rename: "Rename",
  edit: "Edit",
  duplicate: "Duplicate",
} as const satisfies Record<RecordVerb, string>;

/**
 * Deliberately email-keyed with no userId: the owner grants access by adding an
 * email before any better-auth `User` row exists (there is no invite-accept
 * task), so a `User` FK cannot hold. Sign-in is magic-link-only, which makes the
 * email itself the identity; guards match the session user's email against this
 * table. No role column: membership is binary (a row = access) — member
 * management lives only in the embedded app behind Shopify auth, and the member
 * area does not differ per member.
 */
export const MemberId = Schema.NonEmptyString.pipe(Schema.brand("MemberId"));
export type MemberId = typeof MemberId.Type;

/**
 * Merchant copy: **delete a member and they leave their teams.**
 * Structure on {@link D1_TABLES}; how run history survives the delete is a
 * row on {@link initializeSchema}.
 */
export const Member = Schema.Struct({
  id: MemberId,
  shop: Shop,
  email: Email,
  createdAt: Schema.Number,
});
export type Member = typeof Member.Type;

export const TeamId = Schema.NonEmptyString.pipe(Schema.brand("TeamId"));
export type TeamId = typeof TeamId.Type;

/**
 * The length of a trimmed team name: half of {@link NAME_MAX_LENGTH}. The
 * schema check and the Create and Rename fields read this. A team name is a
 * label: the Orders screen's team filter and chip show one, and the member
 * screens print one beside a task.
 * 32 still admits the names a shop gives a bench or a crew ("Leather
 * finishing, bench 3"); 24 would refuse some of them. Task and workflow
 * names keep 64 because they sit on their own line of a card, where they
 * can wrap.
 */
export const TEAM_NAME_MAX_LENGTH = 32;

/**
 * Trimmed on decode for the same structural reason as {@link Email}: the
 * `Team.name` check constraint rejects untrimmed text, and uniqueness
 * compares exactly, so a leading space would otherwise be the difference
 * between a duplicate the database refuses and one it silently accepts.
 * Case is *not* folded: a name is a label compared as typed, so "Sewing" and
 * "sewing" are two teams, and merchants write "Cut & Sew", not "cut & sew".
 * At most {@link TEAM_NAME_MAX_LENGTH} characters.
 */
export const TeamName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(TEAM_NAME_MAX_LENGTH)).pipe(
      Schema.brand("TeamName"),
    ),
    {
      decode: SchemaGetter.transform((s) => s.trim()),
      encode: SchemaGetter.transform((s) => s),
    },
  ),
);
export type TeamName = typeof TeamName.Type;

/**
 * A shop-scoped grouping of members. Merchant copy: **delete a team and
 * its tasks become unassigned until you assign a team.**
 * The order of the delete is the team-delete row on {@link D1_TABLES};
 * which task pointers it nulls and why history never needs the row are the
 * cross-store rows on {@link initializeSchema}.
 * A team with nobody on it is valid and shows **No members** on the teams
 * index (on a workflow it is the `empty_team` {@link WorkflowFault}):
 * its tasks can still create runs, nobody can work them until someone joins,
 * and adding one member fixes everything with no data change.
 */
export const Team = Schema.Struct({
  id: TeamId,
  shop: Shop,
  name: TeamName,
  createdAt: Schema.Number,
});
export type Team = typeof Team.Type;

export const TeamSummary = Schema.Struct({
  ...Team.fields,
  memberCount: Schema.Number,
});
export type TeamSummary = typeof TeamSummary.Type;

/**
 * The shop's teams, read live from D1 as the Durable Object hands it to pages: what the team
 * Workflow selects list and what a workflow's faults ({@link WorkflowFault}) are
 * computed against. `memberCount` is the `empty_team` fault's input, so the
 * workflow screens need no second read.
 */
export const TeamWithMemberCount = Schema.Struct({
  id: TeamId,
  name: TeamName,
  memberCount: Schema.Number,
});
export type TeamWithMemberCount = typeof TeamWithMemberCount.Type;

/**
 * A member with how many teams they are on: the members index's row, where
 * a related set is a count ({@link TeamSummary} carries `memberCount` for the
 * same reason).
 */
export const MemberSummary = Schema.Struct({
  ...Member.fields,
  teamCount: Schema.Number,
});
export type MemberSummary = typeof MemberSummary.Type;

/**
 * What the team page reads: the team, one page of its members in email
 * order, and the shop's members who are not on it, the Add members dialog's
 * candidates. `memberCount` is every member on the team, not the page's.
 * `nextCursor` is the last email on the page, `null` on the last page.
 */
export const TeamDetail = Schema.Struct({
  team: Team,
  members: Schema.Array(Member),
  memberCount: Schema.Number,
  nextCursor: Schema.NullOr(Email),
  candidates: Schema.Array(Member),
});
export type TeamDetail = typeof TeamDetail.Type;

/**
 * What the member page reads, the mirror of {@link TeamDetail}: the member,
 * one page of their teams in name order, and the shop's teams they are not
 * on, the Add to teams dialog's candidates.
 * `teamCount` is every team the member is on; `nextCursor` is the last team
 * name on the page, `null` on the last page.
 */
export const MemberDetail = Schema.Struct({
  member: Member,
  teams: Schema.Array(Schema.Struct({ id: TeamId, name: TeamName })),
  teamCount: Schema.Number,
  nextCursor: Schema.NullOr(TeamName),
  candidates: Schema.Array(Schema.Struct({ id: TeamId, name: TeamName })),
});
export type MemberDetail = typeof MemberDetail.Type;

/**
 * What the member-area guard resolves in one query: proof of membership plus
 * the teams that membership carries. Teams are what scope work, so every
 * `/shop/*` handler wants them and none of them should pay a second round trip;
 * an empty `teams` is the ordinary "member with nothing to do yet" state, not an
 * error.
 */
export const MemberAccess = Schema.Struct({
  shop: Shop,
  memberId: MemberId,
  teams: Schema.Array(Schema.Struct({ id: TeamId, name: TeamName })),
});
export type MemberAccess = typeof MemberAccess.Type;

export const WorkflowId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowId"),
);
export type WorkflowId = typeof WorkflowId.Type;

export const WorkflowTaskId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowTaskId"),
);
export type WorkflowTaskId = typeof WorkflowTaskId.Type;

/** The length of every trimmed name: the schema check and the field's submit error (`TextLimit` in `src/components/screen/`) read this. */
export const NAME_MAX_LENGTH = 64;

const trimmedName = <B extends string>(brand: B) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.NonEmptyString.check(Schema.isMaxLength(NAME_MAX_LENGTH)).pipe(
        Schema.brand(brand),
      ),
      {
        decode: SchemaGetter.transform((s) => s.trim()),
        encode: SchemaGetter.transform((s) => s),
      },
    ),
  );

/**
 * Same shape and reasoning as {@link TeamName}: trimmed, case preserved,
 * and unique in its shop, compared exactly. See {@link Workflow} for why the
 * name is unique as well as the tag.
 */
export const WorkflowName = trimmedName("WorkflowName");
export type WorkflowName = typeof WorkflowName.Type;

export const TaskName = trimmedName("TaskName");
export type TaskName = typeof TaskName.Type;

const trimmedText = <B extends string>(brand: B, maxLength: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.NonEmptyString.check(Schema.isMaxLength(maxLength)).pipe(
        Schema.brand(brand),
      ),
      {
        decode: SchemaGetter.transform((s) => s.trim()),
        encode: SchemaGetter.transform((s) => s),
      },
    ),
  );

/** The cap {@link TaskInstructions} enforces, exported so the editor's field can count down to it and refuse past it. */
export const TASK_INSTRUCTIONS_MAX_LENGTH = 500;

/**
 * A task's instructions: a standing reminder for the step, the same for
 * every item, copied onto every run. Not the procedure: that lives in the
 * shop's own documents, and a field a member reads at the bench holds a few
 * lines, so the cap is {@link TASK_INSTRUCTIONS_MAX_LENGTH}; the editor's
 * field counts down to it and refuses past it like the run note (the
 * text-limit part, `TextLimit` in `src/components/screen/`). Trimmed like
 * {@link TaskName}; a blank field is sent as `null`, never as an empty
 * string.
 */
export const TaskInstructions = trimmedText(
  "TaskInstructions",
  TASK_INSTRUCTIONS_MAX_LENGTH,
);
export type TaskInstructions = typeof TaskInstructions.Type;

/**
 * The caps {@link RunNote} and {@link BlockReason} enforce, exported so a
 * field can count down to them. A decode failure mid-paragraph is the failure
 * mode: the writer has typed a page before anything refuses it. The run note
 * gets twice the room because it accumulates: people append to it over the
 * life of the job, where a block reason describes one hold.
 */
export const RUN_NOTE_MAX_LENGTH = 2000;
export const BLOCK_REASON_MAX_LENGTH = 1000;

/**
 * Where a note or reason field starts counting down to its cap: 200
 * characters before it. Late, because a counter on an empty field is a rule
 * nobody asked about; early enough that the cap announces itself while there
 * is still a paragraph's room to land in. One rule for every free-text field,
 * whatever its cap.
 */
export const noteCountFrom = (maxLength: number) => maxLength - 200;

/**
 * The run's free-text note: one field per run, anyone with access may write
 * it, appended to by convention. Trimmed like {@link TaskName}; `null` clears.
 * The write rule is on {@link SetRunNoteCommand}.
 */
export const RunNote = trimmedText("RunNote", RUN_NOTE_MAX_LENGTH);
export type RunNote = typeof RunNote.Type;

/** Why a run is blocked, in `Run.blockReason`. Same trimming; `null` blocks without one. */
export const BlockReason = trimmedText("BlockReason", BLOCK_REASON_MAX_LENGTH);
export type BlockReason = typeof BlockReason.Type;

/** Shopify's tag length limit: the schema check and the tag fields' submit error read this. */
export const TAG_MAX_LENGTH = 255;

/**
 * The workflow's one tag: its identity in a form a product can carry. Every
 * workflow has exactly one, from birth, and no two workflows share one. Baton
 * mints it (the create dialog prefills it from the workflow name) and the
 * merchant puts it on products in Shopify; an item whose product carries
 * it follows the workflow. It is not a *product* tag — that is
 * `OrderLineItem.productTags`, the product's own merchandising facets, which
 * this is matched against.
 *
 * Trimmed and compared exactly, like the names. Shopify stores a product tag
 * as typed and Flow compares tags exactly; only the admin's search folds
 * case, and a search box is not a match rule. Baton mints the tag and the
 * merchant copies it onto products, so a case typo on the product is the same
 * failure as any other typo: the order shows under Not started with the
 * workflow in the Workflow select. Trimmed because a value Baton stores is
 * clean when stored. {@link TAG_MAX_LENGTH} is Shopify's tag length limit; Baton adds no
 * character rules of its own beyond what Shopify allows in a tag.
 */
export const WorkflowTag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(TAG_MAX_LENGTH)).pipe(
      Schema.brand("WorkflowTag"),
    ),
    {
      decode: SchemaGetter.transform((s) => s.trim()),
      encode: SchemaGetter.transform((s) => s),
    },
  ),
);
export type WorkflowTag = typeof WorkflowTag.Type;

/** The vocabulary's workflow-state words, stored as written. */
export const WorkflowState = Schema.Literals(["on", "off"]);
export type WorkflowState = typeof WorkflowState.Type;

/**
 * A workflow definition has two nouns and the merchant never meets a
 * third:
 *
 * - **Workflow**: name, type, tag, tasks, On / Off. This is what
 *   creates runs. Runs copy it wholesale and never look back at it (the
 *   data model on `initializeSchema`, `ShopAgentSchema.ts`).
 * - **Draft**: a private copy of the workflow's **tasks**, created by
 *   Edit and living until Apply or Discard. Every edit writes to the draft
 *   immediately; there is no unsaved state anywhere.
 *
 * Verbs: **Edit** creates the draft. **Apply changes** replaces the
 * workflow's tasks with the draft's and deletes the draft.
 * **Discard changes** deletes the draft. **Turn on** / **Turn off** set
 * `state` to `on` and `off`; the switch and the draft are unrelated.
 *
 * How a workflow is chosen for work, in merchant copy. Every workflow **has
 * exactly one tag**, no two workflows share one, and the tag is edited like
 * the name: immediately, never through the draft. The product **carries
 * product tags**; a **match** is one of the product's tags equalling the
 * workflow's tag. The workflow's field is never called a "product tag": that
 * name points the arrow the wrong way, since Baton mints the string and the
 * merchant carries it out to Shopify.
 *
 * - a workflow **starts when** an order **contains** a product **tagged with**
 *   its tag;
 * - on an item that no workflow's tag **matches**, the order page says no
 *   workflow can start and offers the Workflow select; the orders index shows the
 *   order under Not started with nothing in Issues;
 * - the order page says a workflow **started for** N items.
 *
 * In identifiers: `match` is the tag test, and a workflow **creates** a run
 * (`workflowIsEligible` says whether it may); only a member **starts** a
 * task. Not used, in code or copy: version, live, saved, published,
 * retired, applied (as a state), route, routing, routable, pause, and
 * "product tag" for the workflow's own field.
 *
 * Merchant copy, the whole model in five sentences: **delete a
 * workflow and its runs stay on their orders**, open ones carry on; **turn
 * off** stops new runs and open ones carry on; **a workflow needs at least one task before it
 * can be applied or turned on**, so zero tasks is the state before the first
 * Apply and only that; **any open task on a run can be assigned to another
 * team**, a done task is history; **deleting configuration never deletes
 * work**. Delete removes the definition, its tasks, and its draft, nothing
 * else (the data model on `initializeSchema`, `ShopAgentSchema.ts`) — a run
 * is self-sufficient, so it needs no confirm counts and the dialog says only
 * what survives. The id is identity, the tag is the key a product carries,
 * and the name is the label people pick a workflow by. Both are unique:
 * members never see the tag, and selects such as the order page's Workflow
 * list show only the name, so the name alone has to tell two workflows
 * apart. A rename is immediate and cosmetic because runs snapshot
 * `workflowName`.
 *
 * `state` is the switch, stored and never derived, and it carries no date. A
 * workflow that is on creates a run on every stored open paid order whose item it
 * matches, on every path — webhook, open-orders sync, one-order sync, and every workflow
 * change — however old the order is; the merchant who wants a workflow to
 * apply from a day turns it on that day. A workflow can create runs when it
 * is on and it has tasks and every task is assigned to a team that exists;
 * on implies at least one task, every one assigned at the moment of Turn on.
 * A task whose team was deleted is **unassigned** (`teamId` null, or an id
 * no D1 row carries — read as null everywhere). A workflow with an
 * unassigned task carries the `unassigned` {@link WorkflowFault} (**Needs a
 * team**) and one with a task on a team with no members the `empty_team`
 * fault (**Team has no members**), labelled by {@link WORKFLOW_FAULT_LABEL}
 * and toned {@link ORDER_ISSUE_TONE}, as badges on the workflows index; on
 * the workflow page `unassigned` is a banner and `empty_team` a "No members"
 * badge on the step. Both are derived on every read and never stored.
 * **Apply and Turn on refuse only a fault the draft itself can fix.** An
 * unassigned task is fixed in the draft, so both refuse it. An empty team is
 * fixed on the team page, outside the draft, so neither refuses it: refusing
 * would make the merchant staff every team before defining the workflow.
 * An unassigned run task is still the `unassigned` {@link OrderIssue} on
 * every order it stops; an empty team is a workflow fault only.
 * Tasks change only through Apply, so an order arriving between two edits
 * sees a whole definition, never a half one; the tag and the name are
 * immediate, because runs snapshot both at start. Encoded side is the Durable Object row
 * (epoch-ms integers).
 */
const WorkflowFields = {
  id: WorkflowId,
  name: WorkflowName,
  state: WorkflowState,
  updatedAt: Schema.Number,
};

/** On: `state` is `on`. The one read of the switch, so no caller compares the column on its own. */
export const workflowIsOn = (workflow: { readonly state: WorkflowState }) =>
  workflow.state === "on";

/** A workflow: chosen by its tag, running once per matching item. */
export const Workflow = Schema.Struct({
  ...WorkflowFields,
  tag: WorkflowTag,
});
export type Workflow = typeof Workflow.Type;

/** A workflow as a select names it: what the Workflow select and the Change workflow modal offer. */
export const WorkflowNameRow = Schema.Struct({
  id: WorkflowId,
  name: WorkflowName,
});
export type WorkflowNameRow = typeof WorkflowNameRow.Type;

/**
 * `teamId` is a live pointer to a D1 `Team`, not a snapshot: renaming a team
 * renames every task it owns, and a task can only be *applied* against a
 * team that exists. `null` is **unassigned** — what a team delete leaves
 * behind — and an id no D1 row carries reads the same way. It carries no
 * `teamName`: the name is joined at read time, and only the eventual
 * instance rows snapshot it. The pointer's rule is the data model on
 * `initializeSchema` (`ShopAgentSchema.ts`).
 *
 * Stored as one element of its workflow's `tasks` or `draftTasks` document
 * ({@link WorkflowTasks}); `position` is the element's index from 1, filled
 * on decode and never stored, so the screens, `stepsOf` and the run copy read
 * the same field whichever list the task came from. A task has no
 * `workflowId`: it is inside its workflow's row. Only Apply writes `tasks`;
 * every editor write lands on `draftTasks`, which the first edit copies from
 * `tasks`, ids included, so the id the editor sent before the copy names the
 * same task after it.
 *
 * A workflow is a sequence of numbered steps. Each step holds one or more
 * tasks, and a task is the unit a team starts and marks done: it has a name, a
 * team, and instructions. Along `position` the `step` values are dense `1..m`
 * and non-decreasing (`1 1 2 3 3`), so every task belongs to exactly one step,
 * and a step of one task is the plain linear case. Step k is current when every
 * task of step k-1 is done. `WorkflowLayout` recomputes the whole layout on
 * every edit and {@link WorkflowTasks} refuses a list that breaks it, on read
 * and on write. The two nouns exist because
 * parallel work needs a wait that is not a task; the member and merchant UI
 * print "task" only when a step has more than one, so a linear shop reads
 * steps alone.
 */
const StoredWorkflowTaskFields = {
  id: WorkflowTaskId,
  step: Schema.Number,
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  instructions: Schema.NullOr(TaskInstructions),
};

export const WorkflowTask = Schema.Struct({
  ...StoredWorkflowTaskFields,
  position: Schema.Number,
});
export type WorkflowTask = typeof WorkflowTask.Type;

/**
 * **The step rule, in one place.** Along the list, `position` is `1..n` in
 * array order, `step` is an integer dense from 1 and non-decreasing by at
 * most one, and ids are unique. Array order is the rule, not a sort: the
 * stored document keeps the array and drops `position`, so a list whose
 * order disagrees with its positions would be stored one way and read back
 * another. `WorkflowLayout` produces lists that hold this, and
 * {@link WorkflowTasks} refuses one that does not, on read and on write.
 */
export const layoutIsValid = (
  layout: readonly {
    readonly id: string;
    readonly position: number;
    readonly step: number;
  }[],
): boolean => {
  const ids = new Set(layout.map((p) => p.id));
  if (ids.size !== layout.length) return false;
  return layout.every((p, index) => {
    const previous = layout[index - 1];
    if (p.position !== index + 1) return false;
    if (!Number.isInteger(p.step)) return false;
    if (previous === undefined) return p.step === 1;
    return p.step === previous.step || p.step === previous.step + 1;
  });
};

/**
 * A workflow's task list as stored: the JSON text of `Workflow.tasks` or
 * `Workflow.draftTasks`, decoded to {@link WorkflowTask}s with `position`
 * filled from the index, and encoded with `position` dropped. The checks run
 * both ways, so a bad list is refused on read and never written: ids unique,
 * `step` dense from 1 and non-decreasing along the list
 * ({@link layoutIsValid}, the step rule's one enforcer), at most
 * `WorkflowLimits.maxTasks` tasks, each name a {@link TaskName} and each
 * instructions a {@link TaskInstructions} or null.
 */
export const WorkflowTasks = Schema.fromJsonString(
  Schema.toEncoded(Schema.Array(Schema.Struct(StoredWorkflowTaskFields))),
).pipe(
  Schema.decodeTo(
    Schema.Array(WorkflowTask).check(
      Schema.isMaxLength(WorkflowLimits.maxTasks),
      Schema.makeFilter(
        (tasks: readonly WorkflowTask[]) =>
          layoutIsValid(tasks) ||
          "steps must be dense from 1 and non-decreasing along the list, positions the list's order, and ids unique",
      ),
    ),
    {
      decode: SchemaGetter.transform((tasks) =>
        tasks.map((task, index) => ({ ...task, position: index + 1 })),
      ),
      encode: SchemaGetter.transform((tasks) =>
        tasks.map(({ position: _position, ...task }) => task),
      ),
    },
  ),
);

/**
 * List row. `tag` and `stepCount` describe the workflow. `unassigned` and
 * `emptyTeam` are the derived badges from {@link Workflow}, computed against
 * the shop's live teams on every list read.
 */
const WorkflowSummaryRowFields = {
  stepCount: Schema.Number,
};
/** The stored half of {@link WorkflowSummary}: what one list query returns before the team join. */
export const WorkflowSummaryRow = Schema.Struct({
  ...Workflow.fields,
  ...WorkflowSummaryRowFields,
});
export type WorkflowSummaryRow = typeof WorkflowSummaryRow.Type;

/** What the workflows page lists. */
export const WorkflowSummary = Schema.Struct({
  ...Workflow.fields,
  ...WorkflowSummaryRowFields,
  unassigned: Schema.Boolean,
  emptyTeam: Schema.Boolean,
});
export type WorkflowSummary = typeof WorkflowSummary.Type;

/** The shape run creation reads: a workflow with its tasks. Drafts never appear here. */
export const WorkflowDetail = Schema.Struct({
  workflow: Workflow,
  tasks: Schema.Array(WorkflowTask),
});
export type WorkflowDetail = typeof WorkflowDetail.Type;

/**
 * A workflow task with its team's live name and headcount, as the merchant's
 * workflow page and the workflow editor ({@link WorkflowPageData}) render it.
 * Both warning states are derived here against the live
 * teams and never stored: `teamName` is `null` when the task is unassigned
 * (`teamId` null, or an id no team carries) — a warning, not a block in the
 * editor; the task renders with an empty team select and everything else stays
 * editable. `memberCount` is the team's live headcount (`null` when
 * unassigned) so the page can raise the `empty_team` fault. `teams` rides
 * along so the team select needs no second call.
 */
const TaskWithTeamName = Schema.Struct({
  ...WorkflowTask.fields,
  teamName: Schema.NullOr(TeamName),
  memberCount: Schema.NullOr(Schema.Number),
});
export type TaskWithTeamName = typeof TaskWithTeamName.Type;

/**
 * Everything the merchant's workflow page and the workflow editor render, in
 * one socket round trip: the workflow (read-only, what creates runs) with its
 * tasks, and the draft's tasks (what the editor writes), `null` when there is
 * no draft. The suffix is `Data` for the reason on {@link OrdersIndexData}.
 */
export const WorkflowPageData = Schema.Struct({
  workflow: Workflow,
  tasks: Schema.Array(TaskWithTeamName),
  draftTasks: Schema.NullOr(Schema.Array(TaskWithTeamName)),
  teams: Schema.Array(TeamWithMemberCount),
});
export type WorkflowPageData = typeof WorkflowPageData.Type;

/** A task is unassigned when its team is null or resolves to no team; the name is the tell after the team join. */
export const workflowTaskIsUnassigned = (task: TaskWithTeamName) =>
  task.teamName === null;

/** Assigned to a team nobody is on: the `empty_team` {@link WorkflowFault}; Apply and Turn on allow it ({@link Workflow} says why). */
export const hasEmptyTeam = (task: TaskWithTeamName) =>
  task.teamName !== null && task.memberCount === 0;

export const WorkflowIdInput = Schema.Struct({ workflowId: BoundedId });
export type WorkflowIdInput = typeof WorkflowIdInput.Type;

export const DeleteWorkflowInput = WorkflowIdInput;
export type DeleteWorkflowInput = typeof DeleteWorkflowInput.Type;

export const CreateWorkflowInput = Schema.Struct({
  name: WorkflowName,
  tag: WorkflowTag,
});
export type CreateWorkflowInput = typeof CreateWorkflowInput.Type;

/** Name only: a rename is immediate. The tag has its own input ({@link UpdateWorkflowTagInput}) and is also immediate. */
export const UpdateWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  name: WorkflowName,
});
export type UpdateWorkflowInput = typeof UpdateWorkflowInput.Type;

/**
 * Lands on the workflow row, never on the draft: the tag is envelope state
 * like the name. Runs snapshot the tag at start, so work in flight is
 * untouched; the next order to arrive is matched against the new tag.
 */
export const UpdateWorkflowTagInput = Schema.Struct({
  workflowId: BoundedId,
  tag: WorkflowTag,
});
export type UpdateWorkflowTagInput = typeof UpdateWorkflowTagInput.Type;

/**
 * The new workflow's name and tag are the merchant's, prefilled by the
 * Duplicate dialog; the repository copies tasks and steps and leaves the new
 * workflow off with no draft ({@link WorkflowResult} carries it).
 */
export const DuplicateWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  name: WorkflowName,
  tag: WorkflowTag,
});
export type DuplicateWorkflowInput = typeof DuplicateWorkflowInput.Type;

export const CreateDraftInput = WorkflowIdInput;
export type CreateDraftInput = typeof CreateDraftInput.Type;

export const ApplyDraftInput = WorkflowIdInput;
export type ApplyDraftInput = typeof ApplyDraftInput.Type;

export const DiscardDraftInput = WorkflowIdInput;
export type DiscardDraftInput = typeof DiscardDraftInput.Type;

export const SetWorkflowOnInput = Schema.Struct({
  workflowId: BoundedId,
  on: Schema.Boolean,
});
export type SetWorkflowOnInput = typeof SetWorkflowOnInput.Type;

/**
 * The editor's Turn on for a workflow that has never been applied: one click
 * that promotes the draft and turns the switch on, so the merchant is not
 * asked to Apply tasks that have never run and then turn on the thing they
 * just applied.
 */
export const ApplyAndTurnOnInput = Schema.Struct({
  workflowId: BoundedId,
});
export type ApplyAndTurnOnInput = typeof ApplyAndTurnOnInput.Type;

export const AddStepInput = Schema.Struct({
  workflowId: BoundedId,
  name: TaskName,
  teamId: BoundedId,
  instructions: Schema.optionalKey(TaskInstructions),
});
export type AddStepInput = typeof AddStepInput.Type;

/** Same as {@link AddStepInput} but into an existing step: the new task lands after that step's last task and is current together with it. */
export const AddTaskInput = Schema.Struct({
  workflowId: BoundedId,
  step: Schema.Number,
  name: TaskName,
  teamId: BoundedId,
  instructions: Schema.optionalKey(TaskInstructions),
});
export type AddTaskInput = typeof AddTaskInput.Type;

/** `instructions: null` clears; the UI maps a blank field to `null` before sending. */
export const UpdateTaskInput = Schema.Struct({
  taskId: BoundedId,
  name: TaskName,
  teamId: BoundedId,
  instructions: Schema.NullOr(TaskInstructions),
});
export type UpdateTaskInput = typeof UpdateTaskInput.Type;

/**
 * The whole workflow fixture for `ShopAgent.seedWorkflows`, tasks inline: one
 * declarative payload written in one transaction, rather than a
 * `createWorkflow` + `addStep`-per-task conversation whose failure midway
 * leaves a half-built definition. `position` is array order; `teamId` is a D1
 * `Team.id` the caller has already created, so the team check `AddStepInput`
 * exists to trigger has nothing left to catch — or `null`, which seeds the
 * task **unassigned** so the Needs a team badge is visible on the workflows
 * and orders indexes after `pnpm seed`. A task with no `step` gets the previous task's step + 1
 * (linear); the repository validates the step invariant before writing.
 *
 * `tasks` become the workflow's tasks; a fixture with no tasks and no
 * `draft` has no draft, the state the ordinary path produces for a fresh
 * workflow. `on` is the switch and defaults to
 * `true` when the entry has tasks and every task is assigned; every seeded
 * order qualifies.
 * `draft` seeds a pending draft (tasks) for fixtures that show the draft UI.
 */
const SeedWorkflowTask = Schema.Struct({
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  step: Schema.optionalKey(Schema.Number),
  instructions: Schema.optionalKey(TaskInstructions),
});

export const SeedWorkflowsInput = Schema.Struct({
  workflows: Schema.Array(
    Schema.Struct({
      name: WorkflowName,
      on: Schema.optionalKey(Schema.Boolean),
      tag: WorkflowTag,
      tasks: Schema.Array(SeedWorkflowTask),
      draft: Schema.optionalKey(
        Schema.Struct({ tasks: Schema.Array(SeedWorkflowTask) }),
      ),
    }),
  ),
});
export type SeedWorkflowsInput = typeof SeedWorkflowsInput.Type;

export const TaskDirection = Schema.Literals(["up", "down"]);
export type TaskDirection = typeof TaskDirection.Type;

/**
 * `moveTask`: the task takes a step of its own past the neighbouring
 * boundary (`WorkflowLayout.move`). Reordering never makes a task parallel
 * with another; that is `joinTask`.
 */
export const MoveTaskInput = Schema.Struct({
  taskId: BoundedId,
  direction: TaskDirection,
});
export type MoveTaskInput = typeof MoveTaskInput.Type;

export const TaskIdInput = Schema.Struct({ taskId: BoundedId });
export type TaskIdInput = typeof TaskIdInput.Type;

/** `separateTask`: the task leaves its step into a new step of its own immediately after it. */
export const SeparateTaskInput = TaskIdInput;
export type SeparateTaskInput = typeof SeparateTaskInput.Type;

/** `joinTask`: the task merges into the previous step, after that step's last member. */
export const JoinTaskInput = TaskIdInput;
export type JoinTaskInput = typeof JoinTaskInput.Type;

export const TeamIdInput = Schema.Struct({ teamId: BoundedId });
export type TeamIdInput = typeof TeamIdInput.Type;

/**
 * Expected failures cross the socket as values, not throws: `runEffect`
 * collapses every failure into one `Error(message)` at the RPC seam, which is
 * fine for faults but loses the tag the page needs to put "name taken" on the
 * name field and "tag taken" on the tag field rather than in a banner.
 *
 * `TagTaken` names the holder so the merchant can decide whether to change
 * this tag or retag the other workflow; the name is enough, since no two
 * workflows share one.
 */
export const WorkflowResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NameTaken"), name: WorkflowName }),
  Schema.Struct({
    _tag: Schema.Literal("TagTaken"),
    tag: WorkflowTag,
    workflowName: WorkflowName,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Limit"), limit: Schema.Number }),
]);
export type WorkflowResult = typeof WorkflowResult.Type;

/**
 * `TaskUnassigned` names the offending tasks so the page can say which to
 * assign. Apply is about tasks only; the tag never reaches it.
 *
 * Every `…Result` is a union of tagged outcomes and each non-`Ok` tag names
 * what the domain refuses; the tag, not a thrown error, is what the page
 * branches on.
 */
export const ApplyResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoDraft") }),
  Schema.Struct({ _tag: Schema.Literal("NoTasks") }),
  Schema.Struct({
    _tag: Schema.Literal("TaskUnassigned"),
    taskNames: Schema.Array(TaskName),
  }),
]);
export type ApplyResult = typeof ApplyResult.Type;

/** Discard is always allowed; on a never-applied workflow it leaves zero tasks and no draft. */
export const DiscardResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoDraft") }),
]);
export type DiscardResult = typeof DiscardResult.Type;

/** Edit. Idempotent: an existing draft is returned as `Ok`, so a merchant resuming is the same click. */
export const DraftResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    draftTasks: Schema.Array(WorkflowTask),
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DraftResult = typeof DraftResult.Type;

export const SwitchResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoTasks") }),
  Schema.Struct({
    _tag: Schema.Literal("TaskUnassigned"),
    taskNames: Schema.Array(TaskName),
  }),
]);
export type SwitchResult = typeof SwitchResult.Type;

export const TaskResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    task: Schema.NullOr(WorkflowTask),
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Limit"), limit: Schema.Number }),
  /** The picked team no longer exists in D1: it was deleted under the editor. */
  Schema.Struct({ _tag: Schema.Literal("TeamNotFound") }),
]);
export type TaskResult = typeof TaskResult.Type;

/** Delete a workflow and its runs stay on their orders. */
export const DeleteWorkflowResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Deleted") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DeleteWorkflowResult = typeof DeleteWorkflowResult.Type;

/**
 * Delete a team and its tasks become unassigned; nothing refuses. `Deleted`
 * is "the D1 row was removed in this call"; a retry after a partial failure
 * still nulls every pointer and reports `NotFound`.
 */
export const DeleteTeamResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Deleted") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DeleteTeamResult = typeof DeleteTeamResult.Type;

export const DeleteTeamInput = TeamIdInput;
export type DeleteTeamInput = typeof DeleteTeamInput.Type;

/** A workflow that uses a team: a task of the workflow or of its draft points at it. The team page's Used by table. */
export const TeamWorkflow = Schema.Struct({
  workflowId: WorkflowId,
  workflowName: WorkflowName,
});
export type TeamWorkflow = typeof TeamWorkflow.Type;

/**
 * The team page's Used by read: one page of the workflows that use the team,
 * in name order. `after` is the last name of the page before, `null` for
 * page one, a keyset on the name alone since names are unique
 * ({@link Workflow}), as on {@link ListWorkflowsInput}.
 */
export const TeamWorkflowsInput = Schema.Struct({
  teamId: BoundedId,
  after: Schema.NullOr(WorkflowName),
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 100 }),
  ),
});
export type TeamWorkflowsInput = typeof TeamWorkflowsInput.Type;

/** What {@link TeamWorkflowsInput} reads: the page and the cursor of the next, `null` on the last. */
export const TeamWorkflowsPage = Schema.Struct({
  workflows: Schema.Array(TeamWorkflow),
  nextCursor: Schema.NullOr(WorkflowName),
});
export type TeamWorkflowsPage = typeof TeamWorkflowsPage.Type;

/**
 * How many workflows use each team ({@link TeamWorkflow}): the teams index's
 * Workflows column, a count because a related set on an index row is a count.
 * A team no workflow uses has no row.
 */
export const TeamWorkflowCount = Schema.Struct({
  teamId: TeamId,
  workflowCount: Schema.Number,
});
export type TeamWorkflowCount = typeof TeamWorkflowCount.Type;

/** Assign a team to any open run task: the remedy that makes team delete safe, and the merchant's way to move work between teams. */
export const AssignRunTaskTeamInput = Schema.Struct({
  runTaskId: BoundedId,
  teamId: BoundedId,
});
export type AssignRunTaskTeamInput = typeof AssignRunTaskTeamInput.Type;

/**
 * Any open task can be assigned, started or not: only `teamId` / `teamName`
 * move, so `startedByRole` / `startedByEmail` stay and history keeps whoever
 * began it. `TaskDone` refuses a done task because the write would
 * overwrite `teamName`, the record of which team did it.
 */
export const AssignRunTaskTeamResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Assigned") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("TeamNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("TaskDone") }),
  /** The task's run is not {@link runIsOpen}; see the {@link RunState} table. */
  Schema.Struct({ _tag: Schema.Literal("RunNotOpen") }),
  /** {@link taskActions}' `assign` is false: the task is done, its run is done, or the order is closed. */
  Schema.Struct({ _tag: Schema.Literal("NotAllowed") }),
]);
export type AssignRunTaskTeamResult = typeof AssignRunTaskTeamResult.Type;

/**
 * Progress for one seeded run: `done` marks every task done; `advance`
 * marks that many rounds of current tasks done; `started` then Starts what is
 * ready; `blocked` blocks the run.
 */
const SeedProgressFields = {
  done: Schema.optionalKey(Schema.Boolean),
  /**
   * Rounds of progress before the run is left alone: each round marks done
   * every task that was *current* when the round began, and what that makes
   * current waits for the next. `advance: 1` on a three-step item is "step 1
   * done, step 2 up next". `done` is the limit of this.
   */
  advance: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  /** After `advance`, Start what is ready so the workflows list shows "Started by <seed member>" on a teammate's list. */
  started: Schema.optionalKey(Schema.Boolean),
  /**
   * Record the `done` / `advance` / `blocked` progress as the **merchant**
   * rather than the seed member, for a fixture of a merchant intervention
   * ("Done by Merchant", "Blocked by Merchant"). `started` stays the
   * member's whatever this says: there is no merchant Start — the merchant
   * records work, they do not claim it.
   */
  byMerchant: Schema.optionalKey(Schema.Boolean),
  /** After `advance`, block the run with this reason, the state a worker's Block leaves. */
  blocked: Schema.optionalKey(BlockReason),
  /** Last, Cancel workflow as the merchant: the run closes, reason `merchant_cancelled` ({@link ClosedReason}). */
  cancelled: Schema.optionalKey(Schema.Boolean),
} as const;

/**
 * `done` and `advance` are exclusive rather than merely undocumented
 * together: the seed runs `done` first, which leaves nothing current, so
 * `advance` beside it is a silent no-op and the fixture row would read as
 * something it is not.
 */
const doneAndAdvanceExclusive = Schema.makeFilter(
  (progress: {
    readonly done?: boolean | undefined;
    readonly advance?: number | undefined;
  }) =>
    progress.done !== true ||
    progress.advance === undefined ||
    "done and advance are exclusive",
);

export const SeedProgress = Schema.Struct(SeedProgressFields).check(
  doneAndAdvanceExclusive,
);
export type SeedProgress = typeof SeedProgress.Type;

/**
 * A second state for an order, applied by the seed after progress: see `after`
 * on {@link SeedOrdersInput} for why it is a phase of its own. `cancelled`
 * and `fulfillmentStatus: "FULFILLED"` close the order's open runs
 * (`order_cancelled`, `fulfilled`); a line's `currentQuantity` at zero closes
 * its run as `item_removed`, and any other change resizes it.
 */
export const SeedOrderChange = Schema.Struct({
  cancelled: Schema.optionalKey(Schema.Boolean),
  fulfillmentStatus: Schema.optionalKey(Schema.String),
  /** By 1-based position in `lineItems`; a quantity left out keeps what the first write gave it. */
  lineItems: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        position: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
        currentQuantity: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
});
export type SeedOrderChange = typeof SeedOrderChange.Type;

/**
 * Local-only order fixture, written through the ordinary upsert-and-reconcile
 * path so runs start exactly as they would for a webhook. `currentQuantity`
 * defaults to `quantity`; lowering it seeds an edit or a refund.
 *
 * Each order is written in four phases, in this order, and the order is what
 * makes the interesting states reachable: upsert + reconcile, then each item's
 * `workflowId`, then progress, then `after`. Progress is per run — an item with
 * its own `progress` uses that, every other run of the order uses the order's
 * own keys — which is what puts one order's items in different states.
 */
export const SeedOrdersInput = Schema.Struct({
  memberId: MemberId,
  memberEmail: Email,
  orders: Schema.Array(
    Schema.Struct({
      /** Numeric suffix: the id becomes `SEED_ORDER_ID_PREFIX + n` and the name `#<n>`. */
      n: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      fulfillmentStatus: Schema.optionalKey(Schema.String),
      /** `PENDING`, `fullyPaid: false`: no runs are created, and the row reads as unpaid, with nothing in Issues. */
      unpaid: Schema.optionalKey(Schema.Boolean),
      /** The progress every run of this order takes unless its own item overrides it. */
      ...SeedProgressFields,
      note: Schema.optionalKey(Schema.String),
      lineItems: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          /** Left out is `null`, as Shopify sends an item with one variant. */
          variantTitle: Schema.optionalKey(Schema.String),
          sku: Schema.optionalKey(Schema.String),
          quantity: Schema.Number,
          currentQuantity: Schema.optionalKey(Schema.Number),
          tags: Schema.Array(Schema.String),
          properties: Schema.optionalKey(Schema.Array(LineItemProperty)),
          /** This item's run alone; the order's own progress keys are ignored for it. */
          progress: Schema.optionalKey(SeedProgress),
          /**
           * A workflow to set on this item after reconcile, exactly as the
           * merchant's Choose / Change does (`setRun`):
           * resolves a multi-match item, or attaches where no tag matched.
           * Applied before progress so the run it creates is one the rounds
           * below then advance. Callers above this schema name the workflow
           * instead — ids are minted by the seed moments earlier — and
           * `api.dev.seed.ts` maps the name to the id.
           */
          workflowId: Schema.optionalKey(Schema.String),
        }),
      ),
      /**
       * A second state for the order, written after progress as another
       * `upsertOrder` with `afterWrite: reconcile`, so its runs end up as a
       * webhook would leave them: closed (`order_cancelled`, `fulfilled`,
       * `item_removed`) or resized. Second on purpose — reconcile on an
       * already-cancelled or already-fulfilled order returns before creating
       * anything, so the first write has to be the order as it stood when
       * the work started.
       */
      after: Schema.optionalKey(SeedOrderChange),
    }).check(doneAndAdvanceExclusive),
  ),
});
export type SeedOrdersInput = typeof SeedOrdersInput.Type;

/**
 * An order's lifecycle position, the ladder: **Not started ·
 * Making · Made · Fulfilled**, and **Cancelled** beside it. One per order,
 * derived from the order row and its run counts on every read and never
 * stored. Issues are not positions: an order being made can also be
 * blocked or waiting on a workflow choice, so those live on {@link OrderIssue}
 * and an order carries any number of them beside its one position.
 *
 * The first three rungs are Baton's: nothing has started, the bench has
 * it, every run is done and the order waits for the merchant to fulfil it.
 * The last two are Shopify's and use Shopify's own words, because they are
 * facts Shopify records (`FULFILLED`, `cancelledAt`) and the merchant reads
 * the same words in the admin. No "shipped": the admin never says it, and it
 * is wrong for pickup and digital orders.
 *
 * The first rung is "Not started", not "To make". It holds every open order
 * with no open and no done run, which includes an unpaid order, an order
 * whose items matched no workflow, an order whose only run the merchant
 * cancelled, and an order whose only item Shopify removed. In the last three
 * the bench will make nothing, so "to make" was a promise the app could not
 * keep; "not started" is true of all four.
 *
 * Never stored is what makes the packer's round trip automatic — fulfil in
 * Shopify, `orders/fulfilled` stores `FULFILLED`, the next read says
 * `fulfilled`, and the order leaves the Made list without anyone touching
 * Baton.
 *
 * The rule is a function, not a table: {@link orderPosition} is the one
 * definition, and the SQL filters in `OrderRepository.listOrders` restate its
 * branches and must move with it. Readers (`app.orders.index.tsx`) switch on
 * the value for labels and filters only; no site decides anything by
 * comparing it inline. The labels are {@link ORDER_POSITION_LABEL}.
 */
export const OrderPosition = Schema.Literals([
  "not_started",
  "making",
  "made",
  "fulfilled",
  "cancelled",
]);
export type OrderPosition = typeof OrderPosition.Type;

/**
 * The orders index's main filter, labelled Show: which orders the list holds.
 * `null` is Open, the default, {@link orderIsOpen}; a position
 * ({@link orderPosition}) is itself; `"issues"` is every open order with at
 * least one {@link orderIssues} element; `"all"` is every stored order,
 * cancelled included, and the only value that reads both open and closed
 * orders. Keyed `?show=` in the URL (`OrdersSearch` in `app.orders.tsx`).
 *
 * **One value at a time; the values do not combine.** The axis is not one
 * fact about an order but the list the merchant wants, so its word is the
 * act, Show, not a fact word like Status, which would not cover Issues, Open
 * or All. Issues is a value rather than a filter of its own because the
 * merchant fixing issues wants every order that has one, whatever its
 * position, and each row's Status badge already says the position; Made and
 * Issues as two filters could only add empty lists. Team does combine
 * ({@link ListOrdersInput} `team`); a search ignores both.
 *
 * Open is the default because retention keeps a year of orders
 * (`ShopLimits.orderRetentionDays` in Platform) and a merchant opening Orders
 * is looking at the bench, not at the year. `"issues"` and `"all"` are not
 * an `OrderPosition`: nothing derives them from an order's runs alone.
 * The labels are {@link ORDERS_SHOW_LABEL}.
 */
export const OrdersShow = Schema.Union([
  OrderPosition,
  Schema.Literals(["issues", "all"]),
]);
export type OrdersShow = typeof OrdersShow.Type;

/**
 * **An issue is an open order that will not move until the merchant acts**:
 * the orders index's Issues value of its Show filter and its Issues column. The one definition is
 * {@link orderIssues}; the SQL predicates in `OrderRepository.listOrders`
 * restate each element and must move with it.
 *
 * | Issue         | Rule                           | Remedy                              |
 * | ------------- | ------------------------------ | ----------------------------------- |
 * | `multi_match` | `multiMatchItems > 0`          | choose a workflow on the order page |
 * | `unassigned`  | {@link OrderRow} `unassigned`  | Assign team on the order page       |
 * | `blocked`     | `runs.blocked > 0`             | the order page                      |
 *
 * **Each issue has one remedy: the action that fixes the fault the issue
 * names.** A Remedy cell never names two actions. A label that covers two
 * fixes names neither: that is how Needs a team came to be shown for a team
 * that was assigned but had no members, and why Team has no members is a
 * label of its own ({@link WORKFLOW_FAULT_LABEL}).
 *
 * **Every issue is critical, on every screen that shows it**
 * ({@link ORDER_ISSUE_TONE}). An issue is an order that will not move until
 * the merchant acts, which is what the critical tone says, so a warning among
 * issues would say "stuck, but not very", and no issue is that: a multi-match
 * item has no run at all, and a task with no team reaches nobody. The
 * definition, not the tone,
 * keeps critical rare: it leaves out every order that is not stuck (an
 * unmatched item, an unpaid order, a cancelled run, below).
 *
 * **The tone is not whether Apply allows the fault.** Apply asks whether
 * the draft can fix it ({@link Workflow}); an issue asks whether this order
 * is stuck, and an order with a run task on no team is, whatever the draft
 * held when it was applied.
 *
 * **An issue is an undecided item.** An item whose run the merchant
 * cancelled was decided (Cancel workflow says "Baton is not making this"),
 * so it is no issue. An item that matched no workflow is not an issue
 * either: matching by tag is the merchant's statement of what Baton makes,
 * so by that statement an unmatched item is not Baton's work, and flagging
 * it on every order for a ready-made product, such as a keychain taken off
 * the shelf, would be a permanent false alarm that teaches the merchant to
 * ignore the count. The accepted risk: a made-to-order product nobody
 * tagged sits in Not started, where the merchant sees it, and its order
 * page offers the Workflow select on the item.
 *
 * Unpaid is not an issue: it is a Shopify fact the Payment column already
 * shows, not something the merchant fixes in Baton.
 *
 * An issue is only ever on an open order ({@link orderIsOpen}): a closed
 * order has no work left. Issues are independent of each other and of the
 * {@link OrderPosition}: one order can carry several, and an order being
 * made can be waiting on a choice for another item at the same time. No
 * Shopify change is an issue: a Shopify event closes or resizes a run and
 * waits on nobody ({@link RunState}). Blocked is the run-state word on
 * purpose: the issue is "a run on this order is blocked".
 *
 * The word is issue, not need or attention. Shopify's badge guidance pairs
 * the critical tone with "urgent issues needing action"; "need" is
 * verb-shaped and did not fit Blocked, which is a hold a person set rather
 * than a gap to fill; "attention" names what a badge does about a problem,
 * not the problem. The labels are {@link ORDER_ISSUE_LABEL}.
 */
export const OrderIssue = Schema.Literals([
  "multi_match",
  "unassigned",
  "blocked",
]);
export type OrderIssue = typeof OrderIssue.Type;

/**
 * A fault a workflow carries, derived on every read against the shop's live
 * teams and never stored: `unassigned`, a task on no team
 * ({@link workflowTaskIsUnassigned}), which Apply and Turn on refuse; and
 * `empty_team`, a task on a team with no members ({@link hasEmptyTeam}),
 * which they allow ({@link Workflow}). The workflows index shows each as a
 * badge and the workflow page as a banner ({@link WORKFLOW_FAULT_LABEL}).
 * Only `unassigned` is also an {@link OrderIssue}: a run task on no team
 * stops its order, while a team with no members is fixed on the team page,
 * which says so.
 */
export const WorkflowFault = Schema.Literals(["unassigned", "empty_team"]);
export type WorkflowFault = typeof WorkflowFault.Type;

/**
 * Keyset cursor over `(processedAt desc, id desc)`, encoded as
 * `<processedAt>:<id>`. Not an offset: the bulk stream and webhooks both insert
 * while a merchant pages, and `limit/offset` would drop or repeat rows under
 * those writes.
 *
 * The shape is checked, not just the length: the cursor rides the orders URL
 * as `?after=` (`OrdersSearch` in `app.orders.tsx`), where a value that does
 * not decode reads as page one. Text that is not a cursor at all would
 * otherwise pass, be read as page one by the repository, and still light
 * Previous, because the page is "not page one" whenever `after` is present.
 */
export const OrdersCursor = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^\d+:.+$/u),
);

/**
 * What a person types into a list's search field, on both sides. Trimmed and capped at
 * 64 characters because it reaches SQL as a `like` pattern. `#` alone (or `##`) is
 * refused: {@link searchTerm} would read it as the order number `#`, a prefix every
 * order shares.
 */
export const ListSearch = trimmedText("ListSearch", 64).check(
  Schema.makeFilter(
    (q) =>
      q.replace(/^#+/u, "").length > 0 ||
      "an order number or a word, not just #",
  ),
);
export type ListSearch = typeof ListSearch.Type;

/** How a search reads: an order name matched whole, or a word prefix ({@link searchTerm}). */
export type SearchTerm =
  | { readonly kind: "orderName"; readonly name: string }
  | { readonly kind: "prefix"; readonly text: string };

/**
 * The one reading of a search, used by both repositories and by the screens' "matches"
 * line, so the SQL and the copy agree: digits with an optional leading `#` are an
 * order number, matched whole against `ShopOrder.name` (`1001`, `#1001`, ` #1001 `
 * all mean `#1001`); anything else is a word prefix, matched case-insensitively
 * against the item title, the variant title and the SKU (`sig` finds "Signet ring",
 * `ring` finds it too, `9` is a number and does not). No `field:value`, no operators:
 * the admin's syntax exists because it has forty fields; a list here has four.
 *
 * Shopify writes `ShopOrder.name` with the `#`; the merchant reads the number off
 * the admin and may or may not type it. Case-insensitive holds for ASCII only,
 * because SQLite's `like` folds no other letters: "élan" does not find "Élan".
 */
export const searchTerm = (q: ListSearch): SearchTerm => {
  const text = q.trim();
  const digits = text.replace(/^#+/u, "");
  return /^\d+$/u.test(digits)
    ? { kind: "orderName", name: `#${digits}` }
    : { kind: "prefix", text };
};

/** A search as the screens print it: `#1001` for an order number, else the typed text. */
export const searchTermText = (term: SearchTerm) =>
  term.kind === "orderName" ? term.name : term.text;

/** ASCII case folding, the only folding SQLite's `like` does. */
const fold = (text: string) =>
  text.replaceAll(/[A-Z]/gu, (c) => c.toLowerCase());

/**
 * {@link searchTerm} over one item's fields, for a read that filters rows it
 * already holds (the member's open runs); the SQL reads use
 * {@link prefixPatterns}. Folds ASCII case only, as SQLite's `like` does, so
 * the two halves of one search agree.
 */
export const searchMatches = (
  term: SearchTerm,
  item: {
    readonly orderName: string;
    readonly title: string;
    readonly variantTitle: string | null;
    readonly sku: string | null;
  },
) => {
  if (term.kind === "orderName") return item.orderName === term.name;
  const wanted = fold(term.text);
  return [item.title, item.variantTitle, item.sku].some((field) => {
    const text = fold(field ?? "");
    return text.startsWith(wanted) || text.includes(` ${wanted}`);
  });
};

/**
 * The two `like` patterns that make {@link searchTerm}'s word prefix: the text at
 * the start of the field, or after a space. `%`, `_` and `\` in the text are
 * escaped, so the SQL beside them says `escape '\'`.
 */
export const prefixPatterns = (text: string): readonly [string, string] => {
  const escaped = text.replaceAll(/[\\%_]/gu, (c) => `\\${c}`);
  return [`${escaped}%`, `% ${escaped}%`];
};

export const ListOrdersInput = Schema.Struct({
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 50 }),
  ),
  cursor: Schema.NullOr(OrdersCursor),
  /**
   * The search, read by {@link searchTerm}: `null` is no search.
   *
   * **Search ignores the filters.** When `q` is not null the read is over
   * every stored order and `show` and `team` are not applied:
   * what the merchant typed is the whole question, and a search crossed with
   * a filter meant "no match under Made" sent them to All to type it again.
   * The counts ignore `q` in turn ({@link OrderCounts}).
   *
   * Always send the key, for the same reason as `team`.
   */
  q: Schema.NullOr(ListSearch),
  /**
   * {@link OrdersShow}: `null` is Open, `"all"` is every order. A position
   * and `"issues"` each have a SQL form in `OrderRepository.listOrders` that
   * restates `orderPosition` or `orderIssues`. Always send the key, for the
   * same reason as `team`.
   */
  show: Schema.NullOr(OrdersShow),
  /**
   * `null` is any team; an id keeps only orders waiting on that team: an
   * open order with an open, unblocked run whose current task is on the
   * team. "Current" is the workflows list's own predicate
   * (`currentWhere`), not "owns a task somewhere in the run". The looser
   * reading pulls in orders the team did days ago and orders it will not
   * touch for two more steps, so the label carries the predicate.
   *
   * **Only an open order waits on a team**: under Fulfilled the filter
   * matches nothing, because reconcile closed every open run on a fulfilled
   * or cancelled order and only open runs have current tasks
   * ({@link currentTasks}). A blocked run holds no team: its team cannot
   * move it, and `RunCounts.blocked` is its alarm. A team with no members
   * still matches, so the filter shows the orders that team needs a member
   * for.
   *
   * Always send the key. `ShopAgent.listOrders` parses with
   * `onExcessProperty: "error"`, and an omitted key is a different failure
   * than a null one.
   */
  team: Schema.NullOr(TeamId),
});
export type ListOrdersInput = typeof ListOrdersInput.Type;

/**
 * Per-order position for the index table, aggregated from
 * `Run` rows in the same read. `open` counts {@link runIsOpen} runs, `done`
 * the done ones. Closed runs are not counted: nothing derives from their
 * number. A closed run still holds its item ({@link RunState}), which
 * {@link multiMatchItems} reads off the run rows, and an order whose only
 * runs were closed reads as not started ({@link orderPosition}) with no
 * issue ({@link orderIssues}).
 */
export const RunCounts = Schema.Struct({
  open: Schema.Number,
  done: Schema.Number,
  /** Open runs a worker or the merchant blocked ({@link runIsBlocked}). */
  blocked: Schema.Number,
});
export type RunCounts = typeof RunCounts.Type;

/**
 * One index row. `itemUnits` is the sum of `currentQuantity`, not the number
 * of item rows: a cancelled or edited-down order keeps its items and
 * drops their current quantity to zero, and the admin shows those as
 * "0 items". Items themselves are not carried; the detail page reads them.
 */
export const OrderRow = Schema.Struct({
  order: ShopOrder,
  itemUnits: Schema.Number,
  runs: RunCounts,
  /**
   * The `team` {@link OrderIssue}, derived at read time against the live D1
   * teams and never stored: an open run has an open task, on any step, whose
   * `teamId` is null or names no team. Any step, not only the current
   * one, because an unassigned task cannot fix itself before it becomes
   * current. Remedy: Assign team on the order page.
   */
  unassigned: Schema.Boolean,
  /**
   * How many of the order's items are **multi-match** ({@link multiMatchItems}).
   * Derived per read like {@link RunCounts}, never stored, so a Change
   * workflow that leaves an item with two matches and nothing on it reads as
   * multi-match again without another reconcile.
   */
  multiMatchItems: Schema.Number,
});
export type OrderRow = typeof OrderRow.Type;

/**
 * Shop work's reading of an order, from {@link orderIsCancelled} and
 * {@link orderIsFulfilled} in Orders: its {@link OrderPosition}, one for
 * every order.
 *
 * Cancelled wins over everything because Shopify's cancel is final;
 * `fulfilled` is checked next, before the run counts, so an order fulfilled
 * with no runs at all — every historical order the open-orders sync pulls in —
 * reads as fulfilled (and one fulfilled with runs open cannot exist past the
 * next reconcile, which closes them). The open positions then follow the run
 * counts alone: no open and no done run is `not_started`, any open run is
 * `making`, only done runs is `made`. An order whose runs are all closed
 * reads not started, which is right, because nothing has started and the
 * items may take a new workflow from the Workflow select. Whether that is an issue is
 * {@link orderIssues}' question, and the answer is no: a closed run is a
 * decided item. The SQL forms
 * in `OrderRepository.listOrders` restate these branches and must move with
 * them.
 *
 * Takes the two fields it reads rather than a whole `OrderRow`, so the order
 * page — which rebuilds the aggregate from its own runs — does not have
 * to invent a value for every row field the index adds later.
 */
export const orderPosition = ({
  order,
  runs,
}: Pick<OrderRow, "order" | "runs">): OrderPosition =>
  Match.value({
    cancelled: orderIsCancelled(order),
    fulfilled: orderIsFulfilled(order),
    none: runs.open === 0 && runs.done === 0,
    open: runs.open > 0,
  }).pipe(
    Match.withReturnType<OrderPosition>(),
    Match.when({ cancelled: true }, () => "cancelled"),
    Match.when({ fulfilled: true }, () => "fulfilled"),
    Match.when({ none: true }, () => "not_started"),
    Match.when({ open: true }, () => "making"),
    Match.orElse(() => "made"),
  );

/**
 * Shop work's reading of an order, from {@link orderIsOpen} in Orders: its
 * {@link OrderIssue}s, in
 * `OrderIssue` order; `[]` for a closed order. The one definition: the orders index's
 * Issues column renders this result, and Show: Issues is this result's
 * non-emptiness, restated in SQL in `OrderRepository.listOrders`.
 */
export const orderIssues = ({
  order,
  runs,
  unassigned,
  multiMatchItems,
}: Pick<
  OrderRow,
  "order" | "runs" | "unassigned" | "multiMatchItems"
>): readonly OrderIssue[] => {
  if (!orderIsOpen(order)) return [];
  const issue: Record<OrderIssue, boolean> = {
    multi_match: multiMatchItems > 0,
    unassigned,
    blocked: runs.blocked > 0,
  };
  return OrderIssue.literals.filter((literal) => issue[literal]);
};

/**
 * The `s-badge` and `s-banner` tone of every {@link OrderIssue}, on every
 * screen that shows one: the orders index's Issues badges and banner, the
 * workflows index's {@link WorkflowFault} badges, the workflow page's
 * banners. One tone for all, for the reason on {@link OrderIssue}.
 */
export const ORDER_ISSUE_TONE = "critical";

/**
 * The order's **multi-match** items, the noun's one definition in code; the
 * meaning is the vocabulary row. Reconcile logs them and `OrderRow`'s count
 * is their number. The SQL twin `MULTI_MATCH_ITEM` in
 * `OrderRepository.listOrders` restates it and must move with it.
 *
 * Any run counts, `done` and `closed` included: a `done` run means the item
 * was routed and done, and a closed run still holds its item
 * ({@link RunState}). Payment does not gate it: the choice is the
 * merchant's to make before the balance lands.
 */
export const multiMatchItems = (
  lineItems: readonly OrderLineItem[],
  runs: readonly Pick<Run, "lineItemId">[],
  details: readonly WorkflowDetail[],
  teams: readonly { readonly id: TeamId }[],
): readonly OrderLineItem[] =>
  lineItems.filter(
    (lineItem) =>
      unitsToMake(lineItem) > 0 &&
      matchedWorkflows(lineItem, details, teams).length >= 2 &&
      !runs.some((run) => run.lineItemId === lineItem.id),
  );

/** The index's per-order aggregate, recomputed from a detail page's runs so both pages share one definition. */
export const runCounts = (runs: readonly Run[]): RunCounts =>
  runs.reduce<RunCounts>(
    (counts, run) => ({
      open: counts.open + (runIsOpen(run) ? 1 : 0),
      done: counts.done + (runIsDone(run) ? 1 : 0),
      blocked: counts.blocked + (runIsOpen(run) && runIsBlocked(run) ? 1 : 0),
    }),
    { open: 0, done: 0, blocked: 0 },
  );

/**
 * The counts on the orders index's strip, one per {@link OrdersShow} value
 * that reads open orders only: `open` is Open, `issues` is Issues, and the
 * three open positions are theirs.
 *
 * **A count is what choosing that value would show, given the team.** Counts
 * honour the team select and nothing else: not the search, because the
 * search ignores the filters ({@link ListOrdersInput} `q`); and not the Show
 * filter, because a count describes the list the merchant can switch to. So
 * the numbers move only when the team changes, which is what a merchant
 * expects a team select to do. `open` is the sum of the three positions.
 *
 * All are computed over open orders only. They are read through the partial
 * index over unfulfilled, uncancelled orders, so a count costs one row per
 * open order, not one per order ever stored. So Fulfilled, Cancelled and All carry no
 * count: on a shop with years of history that would be a full-table read on
 * every refresh of a live screen.
 *
 * Refreshes are bounded by the live screen's invalidation throttle,
 * `INVALIDATION_THROTTLE_MS` in `useLiveQuery` (2 s), not by anything
 * here.
 */
export const OrderCounts = Schema.Struct({
  open: Schema.Number,
  issues: Schema.Number,
  not_started: Schema.Number,
  making: Schema.Number,
  made: Schema.Number,
});
export type OrderCounts = typeof OrderCounts.Type;

export const OrdersPage = Schema.Struct({
  orders: Schema.Array(OrderRow),
  limit: Schema.Number,
  nextCursor: Schema.NullOr(OrdersCursor),
  counts: OrderCounts,
  /**
   * How many stored orders the search finds, over every page; `null` without
   * a search. Not a count ({@link OrderCounts}): it is the search's answer,
   * which the screen prints as "N orders match <term>".
   */
  matches: Schema.NullOr(Schema.Number),
});
export type OrdersPage = typeof OrdersPage.Type;

/**
 * The detail page is addressed by `legacyId`, not the GID: the GID contains
 * slashes, and the legacy id is what the Shopify admin puts in its own URL.
 */
export const GetOrderDetailInput = Schema.Struct({
  legacyId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type GetOrderDetailInput = typeof GetOrderDetailInput.Type;

/**
 * The workflows index's read: one page of workflows in name order.
 *
 * - `cursor` is the last name of the page before, `null` for page one. A
 *   keyset on the name alone, since names are unique ({@link Workflow}).
 * - `q` is a word prefix of the name ({@link prefixPatterns}, the text as
 *   typed, not through {@link searchTerm}, since a name has no order
 *   number); `null` is no search. A search ignores `state`,
 *   as a search on the orders index ignores its filters
 *   ({@link ListOrdersInput}).
 * - `state` is the `?state=` filter ({@link WorkflowsIndexState}); `null` is
 *   All.
 */
export const ListWorkflowsInput = Schema.Struct({
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 100 }),
  ),
  cursor: Schema.NullOr(WorkflowName),
  q: Schema.NullOr(ListSearch),
  state: Schema.NullOr(WorkflowsIndexState),
});
export type ListWorkflowsInput = typeof ListWorkflowsInput.Type;

/** Everything the workflows index renders, one page of it. The suffix is `Data` for the reason on {@link OrdersIndexData}. */
export const WorkflowsIndexData = Schema.Struct({
  workflows: Schema.Array(WorkflowSummary),
  /** The cursor of the next page ({@link ListWorkflowsInput}), `null` on the last. */
  nextCursor: Schema.NullOr(WorkflowName),
  /** How many workflows the search finds, over every page; `null` without a search. The search's answer, as {@link OrdersPage} `matches` is. */
  matches: Schema.NullOr(Schema.Number),
});
export type WorkflowsIndexData = typeof WorkflowsIndexData.Type;

/**
 * Everything the orders index renders, in one socket round trip.
 *
 * The suffix is `Data`, and the prefix is the Screens table's spec name, for
 * this and every struct that is what one screen reads ({@link OrderPageData},
 * {@link WorkflowPageData}, {@link WorkflowsListData}, {@link RunPageData}):
 * `Data` is TanStack's own word for what a screen reads (`loaderData`,
 * `useLoaderData`), and a `View` suffix would read as the retired word for a
 * filter ({@link OrdersShow}, {@link WorkflowsListState}). The structs carry no
 * rule of their own, so a generic suffix is right and the screen name carries
 * the meaning.
 */
export const OrdersIndexData = Schema.Struct({
  page: OrdersPage,
  syncState: OrdersSyncStatus,
  /**
   * The shop's teams, read live from D1 the page was read against — the same list
   * `unassigned` was derived from, carried so the route can fill the team
   * filter without a second read.
   */
  teams: Schema.Array(TeamWithMemberCount),
});
export type OrdersIndexData = typeof OrdersIndexData.Type;

/**
 * The live caller of a run or task action: the identity the gates check
 * ({@link runActions}, {@link taskActions}). The merchant has no member id
 * and no email — they act through the embedded admin, where identity is the
 * Shopify session, not a `Member` row. What a row keeps of the caller is the
 * narrower {@link ActorDisplay}, never this.
 */
export const Actor = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("member"),
    memberId: MemberId,
    email: Email,
    /**
     * The member's teams. Present when the actor is gating
     * ({@link runActions}, {@link taskActions}), absent otherwise. A stored
     * actor is an {@link ActorDisplay} and carries neither `memberId` nor
     * `teamIds`.
     */
    teamIds: Schema.optionalKey(Schema.Array(TeamId)),
  }),
  Schema.Struct({ role: Schema.Literal("merchant") }),
]);
export type Actor = typeof Actor.Type;

export type MemberActor = Extract<Actor, { readonly role: "member" }>;

/**
 * The part of an {@link Actor} a row stores and a page displays: the role,
 * and a member's email. Separate from `Actor`, which is the live caller the
 * gates check. No stored actor keeps a member id: history is displayed and
 * matched by email ({@link actorIsMember}), never joined to `Member`, so an
 * id would only go stale when the member is removed.
 *
 * Stored as a closed union rather than a set of nullable columns read
 * together: inferring "merchant" from a null email would make every reader
 * re-derive the same rule and would collide with a task row whose email
 * columns are legitimately null (a task nobody has touched). So the role
 * discriminator is stored beside the email — a `*ByRole` column on
 * {@link RunTask}, the `role` key of `Run.blockedBy` — and the accessors
 * ({@link taskStartedBy} and friends) are the only place the two columns are
 * reassembled.
 */
export const ActorDisplay = Schema.Union([
  Schema.Struct({ role: Schema.Literal("member"), email: Email }),
  Schema.Struct({ role: Schema.Literal("merchant") }),
]);
export type ActorDisplay = typeof ActorDisplay.Type;

/** How every page spells an actor: the merchant is `Merchant`, a member is their email. */
export const actorLabel = (actor: ActorDisplay) =>
  actor.role === "merchant" ? "Merchant" : actor.email;

/**
 * Whether a task's recorded actor is this member, by email: the durable identity, since
 * a removed and re-added member mints a new id but keeps the address (the
 * member row on {@link D1_TABLES}; the same reason {@link listStateOf} matches
 * a started task to its starter by email). The merchant has no email and is never "you" on a member
 * page.
 */
export const actorIsMember = (actor: ActorDisplay, email: Email) =>
  actor.role === "member" && actor.email === email;

export const MerchantConnectionState = Schema.Struct({
  role: Schema.Literal("merchant"),
});
export type MerchantConnectionState = typeof MerchantConnectionState.Type;

export const MemberConnectionState = Schema.Struct({
  role: Schema.Literal("member"),
  memberId: MemberId,
  memberEmail: Email,
  teamIds: Schema.Array(TeamId),
});
export type MemberConnectionState = typeof MemberConnectionState.Type;

export const ConnectionState = Schema.Union([
  MerchantConnectionState,
  MemberConnectionState,
]);
export type ConnectionState = typeof ConnectionState.Type;

export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const RunTaskId = Schema.NonEmptyString.pipe(Schema.brand("RunTaskId"));
export type RunTaskId = typeof RunTaskId.Type;

/**
 * The run lifecycle, stated once. What a merchant reads:
 *
 * > An item goes through its workflow. It is **in progress** while
 * > your team works on it, **done** when the last step is done, and
 * > **closed** if Shopify ends it first (the order was fulfilled or
 * > cancelled, or the item was removed). A member can **block** a run that
 * > cannot go on; unblock it to continue. Nothing else needs your action.
 *
 * The merchant's own Cancel workflow closes a run too, with its own reason
 * ({@link ClosedReason}). So a run ends one of two ways: `done`, a person
 * did the last task, or `closed`, something else ended it and
 * `closedReason` says what.
 *
 * `open` and `done` are derived from the run's tasks and stored for
 * querying; every task write on an open run recomputes them in the same
 * transaction. `closed` is written, never derived: reconcile or Cancel workflow
 * sets it with `closedAt` and `closedReason`, and nothing moves a run out of
 * it. There is no reopen: Shopify's own model is that a cancel or a
 * fulfilment is final, and the way forward is to start again. The merchant
 * may pick any workflow for a done or closed item by hand, its own included;
 * that replaces the row with a fresh run copied from the definition
 * (`RunRepository.setRun`).
 *
 * **Shopify events never create a to-do.** A Shopify change is applied to the
 * run and waits on nobody: the order fulfilled or cancelled closes every open
 * run, a line at zero units closes its open run, and a quantity change
 * resizes an open run. There is nothing to dismiss. A closed run keeps its tasks as the record of who did
 * what; only deleting the row (Change workflow, a manual attach over a
 * done or closed item, the order's retention delete) removes tasks.
 *
 * **Started by you, Started by others, Ready and Blocked hold open runs only.** Closed and done runs leave the
 * member's Started by you, Started by others, Ready and Blocked states, and stop counting on
 * the orders index, by this state and no other rule: the list reads select
 * `state = 'open'`. The fifth state, Done or closed, holds done tasks and closed
 * runs, a closed run with its reason ({@link RecentItem}).
 *
 * What each state means to reconcile and the data model. Who may do each
 * verb in each state, and which page offers it, is {@link runActions} and
 * {@link taskActions}; `RunTerminalError` is the repository's refusal under
 * them. `pnpm spec check` does not read this table: it names the predicate
 * per rule, not a result per state.
 *
 * | rule                                                                    | gate                                                                       |
 * | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
 * | reconcile resizes                                                       | {@link runIsOpen}                                                          |
 * | reconcile closes                                                        | {@link runIsOpen}                                                          |
 * | holds its item: one run per item (the data model on `initializeSchema`) | always, `done` and `closed` included                                       |
 * | replaced by a manual attach                                             | always; open and done behind the confirm that names what is lost, closed from the Workflow select with none |
 *
 * A `done` run holds its item — a done item is not rerouted — but
 * is not open: it is never resized or closed by reconcile (it is the
 * record of what was made), and what is left on it is Reopen, a note, and
 * the merchant's Change workflow, behind the confirm that names what it
 * loses.
 * A closed run holds its item too, so reconcile creates nothing on it: a
 * tag match must not undo a merchant's cancel or restart work Shopify ended
 * on the next webhook. A person replaces it from the Workflow select at rest with no
 * confirm: its tasks are over, and the card above the select is the record.
 */
export const RunState = Schema.Literals(["open", "done", "closed"]);
export type RunState = typeof RunState.Type;

/**
 * Why a run was closed ({@link RunState}). The reason is one line of copy,
 * not a different card or a different set of actions: every closed run
 * offers the note and nothing else.
 *
 * | reason               | set by                                                       | member's Done or closed line          | merchant's card line                 |
 * | -------------------- | ------------------------------------------------------------ | ------------------------------------- | ------------------------------------ |
 * | `fulfilled`          | reconcile, the order reached `FULFILLED` ({@link orderIsFulfilled}) | Closed · Fulfilled in Shopify         | Fulfilled in Shopify                 |
 * | `order_cancelled`    | reconcile, the order was cancelled ({@link orderIsCancelled})        | Closed · Order cancelled in Shopify   | Order cancelled in Shopify           |
 * | `item_removed`       | reconcile, the line's {@link unitsToMake} reached zero          | Closed · Item removed or refunded in Shopify | Item removed or refunded in Shopify |
 * | `merchant_cancelled` | the merchant's Cancel workflow                                | Closed · Cancelled by the merchant    | Cancelled by you                     |
 *
 * A fulfilled order closes its runs rather than marking them done because the
 * work may not have been done in Baton at all: the bench skipped the last
 * Done, the merchant took a rush order off the bench, or the item was made
 * elsewhere. Marking tasks done on the team's behalf would put a name on work
 * nobody recorded; closing says what happened.
 *
 * A closed run holds its item, so an item refunded to zero and edited back
 * up keeps its `item_removed` run and shows its units beside the reason; the
 * merchant reattaches by hand with Change workflow. No issue is raised for
 * it.
 */
export const ClosedReason = Schema.Literals([
  "fulfilled",
  "order_cancelled",
  "item_removed",
  "merchant_cancelled",
]);
export type ClosedReason = typeof ClosedReason.Type;

/** Ended by something other than a person's Done on its last task; `closedReason` says what ({@link ClosedReason}). */
export const runIsClosed = (run: { readonly state: RunState }) =>
  run.state === "closed";

/**
 * Nobody has touched it: no task of the run started or done. Read from the
 * tasks, not the state, because an open run is `open` from the moment it
 * is created.
 */
export const runIsUnstarted = (
  tasks: readonly {
    readonly startedAt: number | null;
    readonly doneAt: number | null;
  }[],
) => tasks.every((task) => task.startedAt === null && task.doneAt === null);

/**
 * The run carries a record a replacement would lose: a task started or
 * done, a block, or a note. Change workflow inserts the new run fresh from
 * its definition, so all four go with the old row, and its modal names
 * them as the `confirm` slot (the controls row "a verb that replaces a run
 * with a record on it", on `Control` in `Screen.ts`). A run with none of
 * them loses nothing, and the modal says nothing. A run has a record when
 * a task is started or done, the run is blocked, or it has a note.
 */
export const runHasRecord = (
  run: { readonly blockedAt: number | null; readonly note: string | null },
  tasks: readonly {
    readonly startedAt: number | null;
    readonly doneAt: number | null;
  }[],
) => !runIsUnstarted(tasks) || runIsBlocked(run) || runHasNote(run);

/** The run's note has text; an empty note is no note. */
export const runHasNote = (run: { readonly note: string | null }) =>
  run.note !== null && run.note.length > 0;

/** Work can still be recorded: Start, Done, Block, team assignment, cancel. */
export const runIsOpen = (run: { readonly state: RunState }) =>
  run.state === "open";

/** The last task's Done: no work is recorded on it again unless Reopen reopens it. */
export const runIsDone = (run: { readonly state: RunState }) =>
  run.state === "done";

/**
 * A person holds the run, with an optional reason: the one flag Baton has.
 * A member whose team holds a current task, or the merchant, sets
 * it with Block and lifts it with Unblock; nothing else sets or clears it (a
 * Shopify change never does, and closing a run clears it with the rest of
 * the run's open state).
 *
 * What a block changes. Every site reads this predicate, never the column.
 * `pnpm spec check` does not read this table: it names the enforcer
 * per rule, not a result per state, and the action matrices pin each result
 * it describes.
 *
 * | rule                                                                    | enforcer                                     |
 * | ----------------------------------------------------------------------- | -------------------------------------------- |
 * | which verbs a block refuses and which it leaves: the `blocked yes` rows | {@link taskActions}, {@link runActions}      |
 * | a blocked run holds no team ("waiting on") and shows no Now line        | `OrderRepository.listOrders`, the order page |
 * | counted as `blocked`, open runs only                                    | {@link runCounts}                            |
 * | the run's row is in the Blocked state                                   | {@link listStateOf}                          |
 *
 * Assign is left under a block on purpose: moving a held task to the team
 * that can unstick it is a fix. Why Reopen and Put back fall where they do
 * is on their bullets under {@link taskActions}.
 */
export const runIsBlocked = (run: { readonly blockedAt: number | null }) =>
  run.blockedAt !== null;

/**
 * One workflow applied to one item. Every display field
 * is a snapshot taken at creation — `workflowName`, `orderName`, the line
 * item's title and properties — so a run's row reads only this row. The
 * member's reads join `ShopOrder` for {@link OrderState} and drop a run whose
 * order is gone; the snapshots are for reading, not for outliving the order.
 *
 * What a run references, what it survives, and that an item has at most one
 * run are rules of the data model on `initializeSchema`
 * (`ShopAgentSchema.ts`), so replacing a workflow means deleting the
 * incumbent in the same transaction ({@link RunState}).
 */
export const Run = Schema.Struct({
  id: RunId,
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  orderId: Schema.String,
  orderName: Schema.String,
  /**
   * `ShopOrder.processedAt` snapshotted at creation, like `orderName`: the
   * workflows list sorts every state oldest-order-first from the run rows alone,
   * before it joins `ShopOrder` for the order's open state.
   */
  orderProcessedAt: Schema.Number,
  lineItemId: Schema.String,
  lineItemTitle: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  /**
   * The item's `properties` at creation. Prefixed like `lineItemTitle`
   * because on a run the bare word would read as the run's own.
   */
  lineItemProperties: Schema.fromJsonString(Schema.Array(LineItemProperty)),
  state: RunState,
  /** When the run was blocked; null is not blocked ({@link runIsBlocked}). */
  blockedAt: Schema.NullOr(Schema.Number),
  blockReason: Schema.NullOr(BlockReason),
  /**
   * Who blocked the run, role and email only. Snapshotted like the task
   * actors, so a deleted member still reads as who.
   */
  blockedBy: Schema.NullOr(Schema.fromJsonString(ActorDisplay)),
  note: Schema.NullOr(RunNote),
  createdAt: Schema.Number,
  /** Bumped by every run and task write; no reader today. */
  updatedAt: Schema.Number,
  /** Set on a {@link runIsClosed} run only: when it closed. */
  closedAt: Schema.NullOr(Schema.Number),
  /** Set on a {@link runIsClosed} run only: why ({@link ClosedReason}). */
  closedReason: Schema.NullOr(ClosedReason),
});
export type Run = typeof Run.Type;

/**
 * A task copied from the definition at run creation. `teamName` is
 * snapshotted alongside `teamId` so the workflows list never joins D1. `teamId` is
 * the live pointer that puts the task on a team's list; a team delete nulls
 * it on every task. An open task becomes **unassigned** (red on the order
 * page, on nobody's list, waiting for **assign a team**); a done or closed
 * task keeps showing its `teamName`, which is all history reads. `startedByEmail` / `doneByEmail` are
 * the snapshots taken at the action that keep history readable after the
 * member is deleted.
 *
 * Each of the two actors (`started*`, `done*`) is a group of
 * columns with a `*ByRole` column, and that column is the discriminator: the
 * merchant leaves the email null (they have no `Member` row), a member fills
 * both. No actor has an id column: an actor is
 * displayed and matched by email ({@link actorIsMember}), never joined to
 * `Member`. Read them through
 * {@link taskStartedBy} / {@link taskDoneBy} rather than by hand, and see {@link ActorDisplay} for why the role is stored
 * rather than inferred from a null email.
 *
 * Reopen clears the `started*` and `done*` columns and records nothing, as
 * Put back clears the `started*` columns and records nothing: a reopened or
 * put-back task is plain Ready and the next Start writes a fresh record.
 *
 * A task is *current* by {@link currentTasks}; several tasks of one run can be
 * current at once. `startedAt` is set by Start (and backfilled by a Done without
 * Start); it and `doneAt` are what {@link runIsUnstarted} reads, since the
 * run's state is `open` from creation.
 */
export const RunTask = Schema.Struct({
  id: RunTaskId,
  runId: RunId,
  position: Schema.Number,
  step: Schema.Number,
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  teamName: TeamName,
  instructions: Schema.NullOr(TaskInstructions),
  startedAt: Schema.NullOr(Schema.Number),
  startedByEmail: Schema.NullOr(Email),
  doneAt: Schema.NullOr(Schema.Number),
  doneByEmail: Schema.NullOr(Email),
  startedByRole: Schema.NullOr(ConnectionRole),
  doneByRole: Schema.NullOr(ConnectionRole),
});
export type RunTask = typeof RunTask.Type;

/**
 * A recorded actor, reassembled from its role column and its email. `null` when
 * the action has not happened; a `member` role with a missing email cannot
 * occur (the writes set the two together) and reads as nobody rather than
 * throwing, because a display path is the wrong place to fail.
 */
const actorFrom = (
  role: ConnectionRole | null,
  email: Email | null,
): ActorDisplay | null => {
  if (role === null) return null;
  if (role === "merchant") return { role: "merchant" };
  return email === null ? null : { role: "member", email };
};

/**
 * Each of these takes the columns it reads rather than a whole
 * {@link RunTask}, so a {@link RunListTask} — which carries no
 * `done*` columns at all — is as good an argument as a done one.
 */
export const taskStartedBy = (
  task: Pick<RunTask, "startedByRole" | "startedByEmail">,
) => actorFrom(task.startedByRole, task.startedByEmail);

export const taskDoneBy = (task: Pick<RunTask, "doneByRole" | "doneByEmail">) =>
  actorFrom(task.doneByRole, task.doneByEmail);

/** An open run task whose team is gone: `teamId` null, or an id no team carries any more. */
export const runTaskIsUnassigned = (
  task: RunTask,
  teams: readonly { readonly id: TeamId }[],
) =>
  task.doneAt === null &&
  (task.teamId === null || !teams.some((team) => team.id === task.teamId));

/**
 * The task is on one of the caller's teams. An unassigned task (`teamId`
 * null) is on nobody's list, so no member's teams match it. The merchant
 * never asks: their `teamIds` is undefined and every guard skips this.
 */
export const taskIsOnTeams = (
  task: { readonly teamId: string | null },
  teamIds: readonly string[],
) => task.teamId !== null && teamIds.includes(task.teamId);

/**
 * **A member's access to a run is any task of it on one of their teams**,
 * current or not, done or not. It is what shows them the run page
 * (`RunRepository.getRunPage`) and what lets them write the run's
 * note (`setRunNote`), the one write that is not about a particular task.
 * Acting on a task needs that task's team ({@link taskIsOnTeams}); Block
 * needs a current one, because a hold is placed by whoever is stuck.
 */
export const runIsVisibleTo = (
  tasks: readonly { readonly teamId: string | null }[],
  teamIds: readonly string[],
) => tasks.some((task) => taskIsOnTeams(task, teamIds));

/** A run is complete in itself: its tasks are copies, and nothing here refers back to the definition. */
export const RunDetail = Schema.Struct({
  run: Run,
  tasks: Schema.Array(RunTask),
});
export type RunDetail = typeof RunDetail.Type;

/**
 * **Units to make**: shop work's reading of an item, what is left to make on
 * it. Shopify's `currentQuantity`, not `quantity`: an edit or a refund lowers
 * it, and neither leaves work a maker should still do. Fulfillment is
 * deliberately not in it — Shopify leaves `currentQuantity` alone when a unit
 * is fulfilled, so a line fulfilled ahead of the rest of the order stays open
 * work until the order reaches `FULFILLED`, the one fulfillment state Baton
 * acts on ({@link orderIsFulfilled}).
 */
export const unitsToMake = (lineItem: Pick<OrderLineItem, "currentQuantity">) =>
  lineItem.currentQuantity;

/**
 * What run creation reads before any transaction: the shop's teams. The teams
 * live in D1, a network read that cannot happen inside the object's
 * transaction, so they are loaded once per webhook, open-orders sync or
 * reconcile all, and every order in that pass works from the same teams, a
 * snapshot that a team deleted mid-pass does not refresh: pass rule 3 on
 * {@link reconcileItem}. The workflows are not in it: they are the object's
 * own rows, read per order, by the order's tags, inside the order's
 * transaction ({@link itemMatches} says why by tag).
 */
export interface EligibleContext {
  /** The shop's teams, read live from D1: what a task's `teamId` must resolve against, and where `teamName` is snapshotted from. */
  readonly teams: readonly {
    readonly id: TeamId;
    readonly name: TeamName;
  }[];
}

/**
 * The definition-side half of whether a workflow creates a run (vocabulary on
 * {@link Workflow}): switched off, empty, or with an unassigned task
 * (`teamId` null, or an id no team carries) all mean "creates
 * nothing". A team with no members does *not* block: the run is created and
 * its task waits on nobody's list until someone joins. Shared by the match
 * ({@link itemMatches}) and by manual attach — the latter skips the item half
 * (tags, quantity) but never this half, and answers separately to
 * {@link orderIsOpen} for the state of the order as a whole. Drafts never
 * reach here: `WorkflowDetail` carries workflow tasks only.
 */
export const workflowIsEligible = (
  { workflow, tasks }: WorkflowDetail,
  teams: readonly { readonly id: TeamId }[],
) =>
  workflowIsOn(workflow) &&
  tasks.length > 0 &&
  tasks.every(
    (task) =>
      task.teamId !== null && teams.some((team) => team.id === task.teamId),
  );

/**
 * The item half of a match: units still to make, and one of the item's
 * product tags equal to the workflow's tag, exactly ({@link WorkflowTag}). It
 * carries no date: an on workflow applies to every stored open paid order.
 */
export const matchesTag = (
  { workflow }: WorkflowDetail,
  item: Pick<OrderLineItem, "productTags" | "currentQuantity">,
) =>
  unitsToMake(item) > 0 && item.productTags.some((tag) => workflow.tag === tag);

/**
 * **A match is an item and an eligible workflow whose tag it carries.** The
 * item has units to make and a product tag equal to the workflow's tag
 * ({@link matchesTag}), and the workflow is on, has a task, and has every
 * task on a team the shop has ({@link workflowIsEligible}). Derived on every
 * read and never stored, so a tag edit, a team delete or a Turn off shows on
 * the next read with no reconcile in between.
 *
 * **A workflow is found by its tag, never by scanning.** Every read that asks
 * which workflows match an item starts from the item's product tags and
 * probes `Workflow.tag`, which is unique: run creation and reconcile
 * (`WorkflowRepository.listOnWorkflowsByTags`), the order page, and the
 * orders index's counts (`ITEM_MATCHES` in `OrderRepository.ts`). The orders
 * index and run creation run per open item; testing each item against every
 * on workflow costs items times workflows per order change, millions of
 * evaluations at a thousand workflows, where the probe costs the item's few
 * tags.
 *
 * The SQL twin is `MULTI_MATCH_ITEM` in `OrderRepository.ts`, which the orders
 * index reads; it restates this rule and must move with it. SQL cannot ask D1
 * whether a team exists, so the twin reads "every task's `teamId` set", which
 * is what the object holds once `deleteTeam` has nulled the pointers; the
 * window before that null is the one stated on `deleteTeam`.
 */
export const itemMatches = (
  item: Pick<OrderLineItem, "productTags" | "currentQuantity">,
  detail: WorkflowDetail,
  teams: readonly { readonly id: TeamId }[],
) => matchesTag(detail, item) && workflowIsEligible(detail, teams);

/** The workflows in `details` that match `item` ({@link itemMatches}), in `details` order. */
export const matchedWorkflows = (
  item: Pick<OrderLineItem, "productTags" | "currentQuantity">,
  details: readonly WorkflowDetail[],
  teams: readonly { readonly id: TeamId }[],
): readonly WorkflowDetail[] =>
  details.filter((detail) => itemMatches(item, detail, teams));

/**
 * What {@link reconcileItem} decides for one item: create a run from the one
 * matching workflow, close the item's open run for a reason, resize it to
 * the item's units, or nothing.
 */
export const ReconcileAction = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("create"), workflowId: WorkflowId }),
  Schema.Struct({ _tag: Schema.Literal("close"), reason: ClosedReason }),
  Schema.Struct({ _tag: Schema.Literal("resize"), units: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("nothing") }),
]);
export type ReconcileAction = typeof ReconcileAction.Type;

const NOTHING: ReconcileAction = { _tag: "nothing" };

/**
 * **Reconcile** makes an order's runs agree with the order and the eligible
 * workflows. Storing the order is sync, the orders word; reconcile begins
 * once the order is stored. A pass reads what is stored, not the caller's
 * copy (pass rule 1), and ignores the webhook topic: the newest state wins,
 * whatever knocked, which with a pass being idempotent (pass rule 5) is what
 * makes retries and out-of-order delivery safe. `RunRepository.reconcileOrder`
 * reads, calls this per item, and executes; the rule is here.
 *
 * **What a pass guarantees.** After a pass over a stored order with the
 * pass's teams ({@link EligibleContext}), for every item of the order,
 * with the run on it if there is one:
 *
 * - **Stop.** If the order is cancelled or fulfilled, the run is not open:
 *   an open run is closed with the order's reason; a `done` or `closed` run
 *   is untouched.
 * - **Fit.** Else if the run is open, its quantity equals the item's units to
 *   make ({@link unitsToMake}); at zero units it is closed `item_removed`
 *   instead.
 * - **Record.** Else if the run is `done` or `closed`, it is untouched: the
 *   item is decided.
 * - **Create.** Else, with no run, a run exists from the one eligible
 *   workflow that matches the item, if the order can create runs
 *   ({@link orderCanCreateRuns}), the item has units to make, and exactly
 *   one workflow matches; otherwise there is no run.
 * - **Orphan.** A stored run whose item is not stored is read as an item at
 *   zero units.
 *
 * A pass writes only what these clauses require (pass rule 5) and reaches
 * them in one transaction (pass rule 2). The actions table below is this
 * condition by cases, and `pnpm spec check` holds the table total; the
 * second test pinned on pass rule 5 checks the condition on generated
 * inputs.
 *
 * Two gates, split on purpose. Cancelled and fulfilled are the **stop gate**
 * ({@link orderIsCancelled}, {@link orderIsFulfilled}): every open run
 * closes, started or not, because the work is over. Partial fulfillment
 * changes nothing: fulfilling a line leaves its `currentQuantity` alone
 * ({@link unitsToMake}). Paid and not cancelled is the **creation gate**
 * ({@link orderCanCreateRuns}): it decides only whether a run is created. So
 * an edit that pushes a paid order back to unpaid keeps its runs, still
 * resizes and closes them, and creates nothing new until the balance lands;
 * a payment wobble never cancels work. A refund is not a stop: a refund that
 * returns money and leaves the items leaves `currentQuantity` alone, and the
 * work goes on; the merchant's stop is a cancel. An archive (`closedAt` in
 * Shopify) is not a stop either; it is not mirrored, and an open order
 * archived by hand keeps its runs.
 *
 * One run per item, not the cross product. Only a single match
 * ({@link itemMatches}) with no run creates anything: two or more is
 * **multi-match**, and picking for the merchant would route work to the wrong
 * team silently, so nothing is created and the order page asks. A run in any
 * state, `done` and `closed` included, holds its item ({@link RunState}), so
 * a workflow turned on later never displaces it and a tag match never undoes
 * a merchant's cancel. A `done` run is never touched: it is the record of
 * what was made.
 *
 * The eligible context ({@link EligibleContext}) is a snapshot (pass rule
 * 3) because the shop's teams are a D1 read the object's transaction cannot
 * make. A team deleted in the middle of a sync is not seen by the rest of it;
 * the price is a run whose task reads Needs a team until the merchant assigns
 * it.
 *
 * The queue is sent even after a reconcile all that failed (pass rule 4)
 * because every order a run was created on was counted, and its event is
 * owed now.
 *
 * When it runs. `shape` is `reconcile` (one order, inside its upsert),
 * `reconcile all` (every stored open, paid order, one transaction each, by
 * `ShopWorkAgent.reconcileAllNow`) or `none`:
 *
 * | trigger                           | shape         | skipped when                                                                                       | pinned by                                                                                           |
 * | --------------------------------- | ------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
 * | order webhook, any topic          | reconcile     | older payload, order ceiling, order gone                                                           | waits for payment, then creates runs identically from any source                                    |
 * | Sync open orders                  | reconcile     | stored row fresher, past retention, order ceiling                                                  | creates runs on every streamed open order that matches, however old, and a re-stream creates none   |
 * | Sync from Shopify                 | reconcile     | order gone                                                                                         | the one-order sync stores the order and creates its run                                             |
 * | Turn on                           | reconcile all | never                                                                                              | a workflow that is on creates runs on every stored open paid order, however old it is               |
 * | Turn off                          | reconcile all | never                                                                                              | turning one of two matching workflows off creates the survivor's run                                |
 * | Delete workflow                   | reconcile all | never                                                                                              | deleting one of two matching workflows creates the survivor's run                                   |
 * | Apply changes                     | reconcile all | workflow off                                                                                       | applyAndTurnOn promotes the draft and turns the switch on in one call; an empty workflow is refused |
 * | the tag edit                      | reconcile all | workflow off                                                                                       | retagging an on workflow reconciles stored orders against the new tag                               |
 * | Delete team                       | reconcile all | never                                                                                              | deleting a team creates the survivor's run on an item two workflows had matched                     |
 * | Attach, Change workflow           | none          | always: the merchant's choice                                                                      | manual attach is refused on a cancelled or fulfilled order and allowed on an unpaid one             |
 * | a product retagged in Shopify     | none          | always: an item's tags are a snapshot taken at sync; the next sync of its order sees them          | a product retagged in Shopify changes nothing until its order syncs again                           |
 * | the retention sweep               | none          | always: it deletes the order and its runs, open ones included, and records no close                | the retention sweep deletes an order with its open runs and records no close                        |
 * | Delete workflow, for its own runs | none          | always: a run copies its definition and carries on; only an item it left multi-match is reconciled | deleting a workflow leaves its runs to carry on                                                     |
 *
 * What it does to one item. Each row is a fixture set, each cell one input;
 * `any` covers every value of its column, and `pnpm spec check` refuses a
 * table whose rows do not cover every combination exactly once. `closed`
 * under `order` is cancelled or fulfilled. `paid` reads `fullyPaid` and
 * nothing else ({@link orderCanCreateRuns} is the creation gate; authorized
 * or partially paid is `no`). Under `units`, `0` is no units to make; `some`
 * is above zero; `same` is above zero and equal to the run's quantity;
 * `changed` is above zero and not equal to the run's quantity. `changed`
 * compares to the run, never to Shopify's ordered `quantity`. Under `run on
 * item`, `open` is open, `done or closed` covers both, and `none` is no run
 * in any state. `matches` counts eligible workflows whose tag the item
 * carries ({@link itemMatches}). `action` is `create`, `close` with its
 * reason, `resize` or `nothing`, with free text after a colon. The test
 * reads this table out of the source:
 *
 * | order     | paid | units   | run on item     | matches           | action                                                          |
 * | --------- | ---- | ------- | --------------- | ----------------- | --------------------------------------------------------------- |
 * | cancelled | any  | any     | open            | any               | close `order_cancelled`                                         |
 * | fulfilled | any  | any     | open            | any               | close `fulfilled`                                               |
 * | closed    | any  | any     | done or closed  | any               | nothing                                                         |
 * | closed    | any  | any     | none            | any               | nothing: the order is over, nothing to create                   |
 * | open      | any  | 0       | open            | any               | close `item_removed`                                            |
 * | open      | any  | changed | open            | any               | resize                                                          |
 * | open      | any  | same    | open            | any               | nothing                                                         |
 * | open      | any  | any     | done or closed  | any               | nothing: the run holds its item                                 |
 * | open      | any  | 0       | none            | any               | nothing: no units to make                                       |
 * | open      | yes  | some    | none            | 1                 | create                                                          |
 * | open      | any  | some    | none            | 0                 | nothing                                                         |
 * | open      | no   | some    | none            | 1                 | nothing: created when it pays                                   |
 * | open      | any  | some    | none            | 2+                | nothing: multi-match                                            |
 *
 * What each action does beyond the item's run. `run row` is `inserted with
 * its tasks`, `closed`, `quantity rewritten` or `untouched`; `counted order`
 * is `counted if not yet` or `—`; `queue` is `+1 order event` or `—`;
 * `pinned by` is one test title, or several separated by `; `. A second
 * run on a counted order counts nothing: that is a row of the triggers
 * table on `ShopUsage`, not restated here.
 *
 * | action             | run row                 | counted order      | queue          | pinned by                                               |
 * | ------------------ | ----------------------- | ------------------ | -------------- | ------------------------------------------------------- |
 * | create             | inserted with its tasks | counted if not yet | +1 order event | an order is counted once, when its first run is created |
 * | close (any reason) | closed                  | —                  | —              | a line at zero units closes its run as item_removed     |
 * | resize             | quantity rewritten      | —                  | —              | a resize rewrites the quantity and counts nothing       |
 * | nothing            | untouched               | —                  | —              | a closed item creates nothing on reconcile              |
 *
 * Manual attach also creates a run and counts the order; it is outside
 * reconcile (the Attach row of the triggers table) and its counting is
 * stated on {@link orderIsOpen}.
 *
 * The rules of a pass, in the order a pass meets them. `where` names the
 * symbol that enforces the rule; the rule is stated here and that symbol
 * links it. `pinned by` is one test title, or several separated by `; `.
 *
 * | rule                                                                                                                                                                                                                                                                                                                                    | where                                                       | pinned by                                                                                                                                         |
 * | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | 1. a pass reads the stored order, items and runs, never the caller's copy; a stored run whose item is not stored is read as an item at zero units                                                                                                                                                                                       | `RunRepository.reconcileOrder`                              | a pass reads the stored order, and a run whose item is gone closes as item removed                                                                |
 * | 2. a pass runs inside its order's write: the store and its runs commit together or not at all; reconcile all opens one transaction per order, and a reconcile all that fails partway keeps the orders it walked; the next trigger finishes the rest (rule 5)                                                                            | `OrderRepository.upsertOrder`, `RunRepository.reconcileAll` | a pass that fails leaves neither the order nor its runs                                                                                           |
 * | 3. the teams are read once before the transaction and every order in the pass sees the same teams; the workflows are read per order, by its items' tags, inside its transaction; a stream and a reconcile all may interleave, each with its own snapshot; every order ends under the newer one because each pass is idempotent (rule 5) | `ShopWorkAgent.eligibleContext`                             | every order in a pass sees the same eligible snapshot                                                                                             |
 * | 4. the usage queue is sent after a reconcile all whether or not it finished; the stream's flush is rule 12 on `syncOrder`                                                                                                                                                                                                               | `reconcileAllNow`                                           | a reconcile all sends the usage queue even when it fails                                                                                          |
 * | 5. a pass is idempotent: a second pass over the same stored order and the same snapshot writes nothing                                                                                                                                                                                                                                  | `reconcileItem`                                             | a second pass over the same stored order writes nothing; a pass guarantees stop, fit, record, create and orphan, and a second pass writes nothing |
 * | 6. no count a pass makes reaches a screen; the counts are the log line's                                                                                                                                                                                                                                                                | `ReconcileCounts`, `ReconcileAllCounts`                     | no reconcile count reaches a screen                                                                                                               |
 */
export const reconcileItem = ({
  order,
  item,
  run,
  matched,
}: {
  readonly order: OrderState & { readonly fullyPaid: boolean };
  readonly item: Pick<OrderLineItem, "currentQuantity">;
  /** The item's run, in any state, or null. */
  readonly run: { readonly run: Pick<Run, "state" | "quantity"> } | null;
  /** The eligible workflows that match the item ({@link matchedWorkflows}). */
  readonly matched: readonly WorkflowId[];
}): ReconcileAction => {
  const open = run !== null && runIsOpen(run.run);
  if (orderIsCancelled(order))
    return open ? { _tag: "close", reason: "order_cancelled" } : NOTHING;
  if (orderIsFulfilled(order))
    return open ? { _tag: "close", reason: "fulfilled" } : NOTHING;
  const units = unitsToMake(item);
  if (run !== null) {
    if (!open) return NOTHING;
    if (units === 0) return { _tag: "close", reason: "item_removed" };
    if (units === run.run.quantity) return NOTHING;
    return { _tag: "resize", units };
  }
  const [only, ...rest] = matched;
  if (
    !orderCanCreateRuns(order) ||
    units === 0 ||
    only === undefined ||
    rest.length > 0
  )
    return NOTHING;
  return { _tag: "create", workflowId: only };
};

/**
 * One current task the member may act on, cut to what a run's row renders.
 * `startedByEmail` is read off the row — the snapshot taken at Start, never a
 * live join — and it is load-bearing beyond display: {@link listStateOf} decides
 * "Started by you" with it.
 *
 * Two groups of columns are omitted rather than carried as nulls. The three
 * `done*` ones can never say anything here: `currentWhere` requires `doneAt is
 * null` and a reopen clears all three, so on a list task
 * every one of them is null by construction. The rest — the instructions —
 * say something, but only on the workflow page: a row shows the task's name and one state clause, and everything
 * behind that is one tap away. Either way they are fields per task on every
 * SSR paint and every refetch.
 *
 * A done task is a {@link RecentItem}, which carries the whole
 * {@link RunTask} because there who did it is the point.
 */
export const RunListTask = Schema.Struct(
  Struct.omit(RunTask.fields, [
    "doneAt",
    "doneByEmail",
    "doneByRole",
    "instructions",
  ]),
);
export type RunListTask = typeof RunListTask.Type;

/**
 * The run behind a row, cut the same way. `orderProcessedAt` and
 * `lineItemId` stay although nothing prints them: they are two thirds of
 * {@link byAge}, which is the order every state is in. `quantity` stays
 * because line one prints `×n` when there is more than one to make
 * ({@link itemPiece}), and the block columns stay because a blocked row
 * prints its reason and who. `workflowName` stays because line three
 * names the recipe the item follows ({@link runRowLines}).
 *
 * `variantTitle` and `sku` stay because a search matches them and line one
 * prints the variant ("Signet ring · Gold").
 *
 * What goes is everything only the workflow page reads — the order id, the
 * timestamps, and `lineItemProperties`, which is the one that matters: a JSON blob on every row of every read, parsed on
 * arrival, to render nothing. The run `note` stays:
 * the row prints it.
 */
export const RunListRun = Schema.Struct(
  Struct.omit(Run.fields, [
    "workflowId",
    "orderId",
    "lineItemProperties",
    "createdAt",
    "updatedAt",
    "closedAt",
    "closedReason",
  ]),
);
export type RunListRun = typeof RunListRun.Type;

/**
 * One row of a member's workflows list: a run with every *current* task
 * ({@link currentTasks}) that belongs to one of the member's teams. `stepCount` is the run's last step, for "Step k of n" ({@link runRowLines}).
 *
 * The order's live note is not here. It is the workflow page's, along with the
 * task instructions and the item's attributes: the row is a list entry that
 * names the piece and its state, and the page one tap behind it is where a
 * maker reads anything.
 */
export const RunListItem = Schema.Struct({
  run: RunListRun,
  tasks: Schema.NonEmptyArray(RunListTask),
  stepCount: Schema.Number,
  /** The order's open or closed state, for {@link taskActions}. */
  order: OrderState,
});
export type RunListItem = typeof RunListItem.Type;

/**
 * Line one of a member's row, the piece: the item's title, then its variant
 * when it has one ("Signet ring · Gold"), so two variants of one product on
 * one order read as two pieces, then `×n` when there is more than one to make
 * ("Signet ring · Gold ×2"), written as the vocabulary writes a run ("Brass
 * hinge ×2"). One unit says no number: the quantity is news only above one.
 * The digits are grouped as every count on a screen is ({@link formatNumber}).
 *
 * In two parts because the row clamps `name` and never `quantity`; a long
 * title ends in an ellipsis and the count stays. The order number is the
 * row's, not the piece's: the row leads line one with it. {@link itemTitle}
 * is the two joined, for the row's accessible label, which is never
 * clamped.
 */
export const itemPiece = (run: {
  readonly lineItemTitle: string;
  readonly variantTitle: string | null;
  readonly quantity: number;
}): { readonly name: string; readonly quantity: string | null } => ({
  name:
    run.variantTitle === null
      ? run.lineItemTitle
      : `${run.lineItemTitle} · ${run.variantTitle}`,
  quantity: run.quantity > 1 ? `×${formatNumber(run.quantity)}` : null,
});

/** {@link itemPiece} as one string: `Signet ring · Gold ×2`. */
export const itemTitle = (run: Parameters<typeof itemPiece>[0]) => {
  const { name, quantity } = itemPiece(run);
  return quantity === null ? name : `${name} ${quantity}`;
};

/**
 * Whether every row of a member's workflows list names its tasks' teams. The
 * team is on the row for the one reader it tells something: a member on
 * several teams looking at all of them, for whom it is which bench to walk
 * to. Narrow to a team and every row of the list is that team, so the word is
 * printed on each of them and discriminates nothing; a member on one team
 * never had a second team for it to sort against. The same two facts decide
 * whether the Team filter exists at all, so the reader who has the filter is
 * the reader who gets the name. A search ignores the team ({@link RunQuery}),
 * so under one the rows span teams again.
 *
 * This is the list's half; a row whose tasks are on different teams names
 * them whatever this says ({@link runRowLines}).
 */
export const rowShowsTeam = (
  teamCount: number,
  team: TeamId | null,
  q: ListSearch | null,
) => teamCount > 1 && (team === null || q !== null);

/**
 * Whether a run's workflow is named after its item: the workflow name and
 * the item title are equal once surrounding spaces are trimmed and case is
 * ignored. "Signet ring" and " signet RING " are one name to a reader; a
 * variant or a word more ("Signet ring, rush") is a different one. A row
 * prints the workflow name only when this is false ({@link runRowLines}).
 */
export const workflowNamesItem = (run: {
  readonly workflowName: string;
  readonly lineItemTitle: string;
}) =>
  run.workflowName.trim().toLowerCase() ===
  run.lineItemTitle.trim().toLowerCase();

/**
 * Lines two and three of a member's open row, as data: the route renders
 * them, this decides them. Line one is the order number and the piece
 * ({@link itemPiece}); line
 * two is the work, one entry of `tasks` per current task on the member's
 * teams in `position` order, then `block`; line three, `recipe`, is the
 * recipe the item follows. One kind of fact per line, so a reader learns the
 * layout once: the names on a row are of four kinds (item, task, team,
 * workflow), all chosen by someone else, and nothing but their place says
 * which is which.
 *
 * Every current task gets its own line rather than the first and a `+n`,
 * because a count says there is more work without saying what it is, and
 * its own state, because on a parallel step one task can be the reader's and
 * the other a teammate's.
 *
 * **The team is printed after its task, `(Team)`, when `showTeam` is true or
 * when the row's tasks are on more than one team** ({@link rowShowsTeam});
 * otherwise `team` is null. Always in the same place, so it never reads as a
 * task or a workflow.
 *
 * **The filter's state is never repeated.** A task line's `state` is:
 * - started by the reader: `Started by you`, null under Started by you;
 * - started by someone else: `Started by <who>` ({@link actorLabel}),
 *   always, because who is the news even under Started by others;
 * - started with no known starter: `Started`. Not the run's `In progress`,
 *   which is the run's word ({@link RUN_STATE_LABEL});
 * - ready: `Ready`, null under Ready.
 *
 * Under a search (`state` null), which ignores the state ({@link RunQuery}),
 * rows of every state mix, so every task line prints its state.
 *
 * **A block is the run's, said once.** A blocked row's task lines print no
 * state; `block` is `Blocked · <reason>`, the reason alone under Blocked,
 * and `Blocked` when there is no reason, except under Blocked, where it is
 * null because the filter already says it. An open row's `block` is null.
 *
 * **The recipe line is `Step k of n`** on every open row whatever its
 * state: k is the step the current tasks share and n is
 * {@link RunListItem}'s `stepCount`.
 *
 * **The workflow name is on the row only when it differs from the item
 * title,** compared with surrounding spaces trimmed and case ignored
 * ({@link workflowNamesItem}); then the line is `<workflow> · Step k of n`
 * and otherwise `workflow` is null. The simple setup names a workflow after
 * its product, so on most rows the name is the item said twice, on the line
 * the eye lands on second; the name is news only when it differs, as for a
 * Rush workflow or an item in two workflows. In two parts, `workflow` and
 * `step`, because a workflow name is a capped name that wraps and the step
 * is fixed words after it; for the same reason a task's `state` is apart
 * from its name and team.
 */
export const runRowLines = (
  { run, tasks, stepCount }: RunListItem,
  context: {
    readonly memberEmail: Email;
    readonly showTeam: boolean;
    /** The chosen state, or null under a search, which ignores it. */
    readonly state: WorkflowsListState | null;
  },
): {
  readonly tasks: readonly {
    readonly id: RunTaskId;
    readonly name: string;
    readonly team: string | null;
    readonly state: string | null;
  }[];
  readonly block: string | null;
  readonly recipe: { readonly workflow: string | null; readonly step: string };
} => {
  const { memberEmail, showTeam, state } = context;
  const blocked = runIsBlocked(run);
  const teams = new Set(tasks.map((task) => task.teamName));
  const named = showTeam || teams.size > 1;
  const taskState = (task: RunListTask): string | null => {
    if (blocked) return null;
    if (task.startedAt === null)
      return state === "ready" ? null : TASK_STATE_LABEL.ready;
    const startedBy = taskStartedBy(task);
    if (startedBy === null) return TASK_STATE_LABEL.started;
    if (actorIsMember(startedBy, memberEmail))
      return state === "started_by_you"
        ? null
        : `${TASK_STATE_LABEL.started} by you`;
    return `${TASK_STATE_LABEL.started} by ${actorLabel(startedBy)}`;
  };
  const block = () => {
    if (!blocked) return null;
    if (state === "blocked") return run.blockReason;
    return run.blockReason === null
      ? RUN_STATE_LABEL.blocked
      : `${RUN_STATE_LABEL.blocked} · ${run.blockReason}`;
  };
  const [first] = tasks;
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      name: task.name,
      team: named ? task.teamName : null,
      state: taskState(task),
    })),
    block: block(),
    recipe: {
      workflow: workflowNamesItem(run) ? null : run.workflowName,
      step: `Step ${String(first.step)} of ${String(stepCount)}`,
    },
  };
};

/**
 * The four states an open run's row can be in, from the member's seat:
 * {@link WorkflowsListState} less Done or closed, which is a window over what
 * left the lists rather than a grouping of them. The labels the member reads
 * are the route's (`workflowsListStates.ts`); the object only needs the keys,
 * because it is the side that groups, sorts, and caps.
 */
export const RunListState = Schema.Literals([
  "blocked",
  "started_by_you",
  "started_by_others",
  "ready",
]);
export type RunListState = typeof RunListState.Type;

/**
 * The workflows list's main filter: the state of the work from where the member
 * stands, one value at a time, in row order: what I have started, what someone
 * else has started, what I can start, what a person has blocked, and what left
 * my lists lately. Four hold open runs only ({@link RunState}), grouped by
 * {@link listStateOf}; Blocked holds blocks and nothing else, since a Shopify
 * change is never a to-do. `done` is the Done or closed window
 * ({@link RecentItem}). The literal is the label's words (`started_by_you`
 * reads Started by you), the stored-literal rule applied to a URL key. Keyed
 * `?state=` because every value is a state word, the task's (`started`,
 * `ready`) or the run's (`blocked`, `done`, `closed`), read from the member's
 * seat; {@link RunState} is the run's own stored state and this is the list's
 * filter, two symbols for two things. One read returns every value's count
 * and one value's rows.
 *
 * Drawn as the strip, one cell per value with its count, not tabs and not a
 * segmented control: the Polaris web components have no tab component, and
 * "tab" in this codebase means a browser tab (one socket per tab), a meaning
 * the socket reasoning needs.
 */
export const WorkflowsListState = Schema.Literals([
  "started_by_you",
  "started_by_others",
  "ready",
  "blocked",
  "done",
]);
export type WorkflowsListState = typeof WorkflowsListState.Type;
export const DEFAULT_WORKFLOWS_LIST_STATE: WorkflowsListState =
  "started_by_you";

/** Whether the workflows list's state is Done or closed, the one value whose rows are the window ({@link RecentItem}) rather than open runs. */
export const workflowsListStateIsDone = (state: WorkflowsListState) =>
  state === "done";

/**
 * Which state a row is in: a block wins ({@link runIsBlocked}); else a
 * task the member started; else any started task; else ready. Every row
 * here is an open run already: closed and done runs never reach one of these
 * states.
 *
 * "Started by you" is by `startedByEmail`; the row keeps no member id. Removing a
 * member and re-adding the same address mints a **new** `Member.id` (the
 * member row on {@link D1_TABLES}), so an id taken before that would stop
 * matching the person still standing at the bench, while the email —
 * the snapshot the run task keeps, the snapshot row on
 * {@link initializeSchema} — keeps matching. A merchant's task has no email
 * at all and so is nobody's, which is right: `Merchant` is not a member of
 * this shop.
 *
 * Put back and reopen both clear `startedByEmail`, so they are the two ways a
 * run leaves Started by you without being done.
 *
 * Here rather than beside the route's labels because the object sorts the
 * rows by state: one read counts every state and returns one of them, so the
 * grouping has to happen on the side that decides what leaves.
 */
export const listStateOf = (
  { run, tasks }: RunListItem,
  memberEmail: Email,
): RunListState => {
  if (runIsBlocked(run)) return "blocked";
  if (tasks.some((task) => task.startedByEmail === memberEmail))
    return "started_by_you";
  if (tasks.some((task) => task.startedAt !== null)) return "started_by_others";
  return "ready";
};

/**
 * Within a state, oldest order first by `run.orderProcessedAt` (the snapshot
 * on the run, so no join), then by item, then by run id. Two runs of one
 * order share the first key, and `createdAt` would not split them either (one
 * reconcile inserts them in the same millisecond), so the item id is the
 * tiebreak: Shopify mints them in the order the customer added the lines, and
 * it is the order `listRunsForOrder` already uses. The run id only separates
 * two workflows on one line. The triple is a key an index can serve and a
 * cursor could later resume from — which the order name would not be.
 */
export const byAge = (a: RunListItem, b: RunListItem) =>
  a.run.orderProcessedAt - b.run.orderProcessedAt ||
  a.run.lineItemId.localeCompare(b.run.lineItemId) ||
  a.run.id.localeCompare(b.run.id);

/**
 * The member's workflows list from the rows their teams own
 * (`RunRepository.runListItems`), grouped by {@link listStateOf} against
 * `memberEmail`, sorted by state and cut here rather than on the page.
 * **Every** state is counted; **one** is returned — the one `query.state`
 * names — sorted oldest first ({@link byAge}) and cut to `query.limit`.
 * `state: "done"` returns no items at all and the caller reads
 * `RunRepository.listRecent` for that state's rows. Under a search
 * (`query.q`) the items are every open match on the member's teams whatever
 * its state or team ({@link RunQuery}), `matches` is how many there were
 * before the cut (`null` without a search), and the counts ignore it. Only
 * open runs have current tasks, so a closed or done run is never listed
 * ({@link RunState}).
 *
 * The four state counts are after `query.team` narrows, because they
 * describe the lists the member can switch to. A team the member is not on
 * narrows to nothing rather than failing: `items` only ever holds their own
 * teams' tasks, so the filter empties itself and every state counts zero.
 * The read under it ignores `query.team` and reads every team of the
 * member's: narrowing the SQL would make each selection a different read
 * whose totals disagreed with the one beside it.
 *
 * Pure, and per member: the rows are the same for every member on the same
 * teams, and only this grouping reads `memberEmail`.
 */
export const workflowsListFrom = (
  items: readonly RunListItem[],
  memberEmail: Email,
  query: RunQuery,
): {
  readonly counts: Omit<RunListCounts, "done">;
  readonly items: readonly RunListItem[];
  readonly matches: number | null;
} => {
  const narrowed =
    query.team === null
      ? items
      : items.flatMap((item): RunListItem[] => {
          const [first, ...rest] = item.tasks.filter(
            (task) => task.teamId === query.team,
          );
          return first === undefined
            ? []
            : [{ ...item, tasks: [first, ...rest] }];
        });
  // `Map.groupBy` would say this in one line, but the repo's `lib` is
  // below es2024; a reduce into a record is the same pass.
  const byState = narrowed.reduce<Record<RunListState, RunListItem[]>>(
    (grouped, item) => {
      grouped[listStateOf(item, memberEmail)].push(item);
      return grouped;
    },
    { blocked: [], started_by_you: [], started_by_others: [], ready: [] },
  );
  // A search ignores the state and the team: every open match on the
  // member's teams. Without one, "done" (Done or closed) is not a
  // RunListState: its rows come from `listRecent`, which reads done tasks and
  // closed runs rather than the current ones grouped here.
  const chosen = (): readonly RunListItem[] => {
    if (query.q !== null) {
      const term = searchTerm(query.q);
      return items.filter(({ run }) =>
        searchMatches(term, {
          orderName: run.orderName,
          title: run.lineItemTitle,
          variantTitle: run.variantTitle,
          sku: run.sku,
        }),
      );
    }
    return workflowsListStateIsDone(query.state) ? [] : byState[query.state];
  };
  const wanted = chosen();
  return {
    counts: {
      started_by_you: byState.started_by_you.length,
      started_by_others: byState.started_by_others.length,
      ready: byState.ready.length,
      blocked: byState.blocked.length,
    },
    items: wanted.toSorted(byAge).slice(0, query.limit),
    matches: query.q === null ? null : wanted.length,
  };
};

/**
 * The lowest step with an open task — where the run is — or `null` once
 * every task is done.
 */
export const lowestOpenStep = (tasks: readonly RunTask[]) =>
  tasks
    .filter((task) => task.doneAt === null)
    .reduce<number | null>(
      (lowest, task) =>
        lowest === null ? task.step : Math.min(lowest, task.step),
      null,
    );

/**
 * The `current` rule on rows already in hand: step k is current when every
 * task of step k-1 is done ({@link WorkflowTask}), so a task is current when
 * its run is {@link runIsOpen}, it is open, and its step is the lowest with an
 * open task. Several are current at once on a step of several tasks, so this
 * is a list and every caller copes with more than one. A current task is
 * ready or started (the vocabulary's narrow words); this is the flag under
 * both. `currentWhere.ts` is the step half of the rule as SQL for the
 * workflows list and the task guards, and leaves the run's state to its callers; this
 * is the one TypeScript copy, for the merchant's order page (which holds every task of
 * the order) and the dev seeder (which walks runs a step at a time), and the
 * test on it pins that the two agree.
 */
export const currentTasks = (
  run: { readonly state: RunState },
  tasks: readonly RunTask[],
): RunTask[] => {
  if (!runIsOpen(run)) return [];
  const lowest = lowestOpenStep(tasks);
  return tasks.filter((task) => task.doneAt === null && task.step === lowest);
};

/**
 * The reopen rule, on rows already in hand: a task in a later step of the
 * same run has started or is done. A `startedAt` test covers done tasks
 * too, because Done backfills `startedAt`.
 *
 * Pure and here rather than in `RunRepository` so the repository's write,
 * the rows it decorates for the member pages, and the merchant's order page,
 * which holds every task of the order, read one rule.
 */
export const laterStepStarted = (
  task: Pick<RunTask, "runId" | "step">,
  runTasks: readonly RunTask[],
) =>
  runTasks.some(
    (other) =>
      other.runId === task.runId &&
      other.step > task.step &&
      other.startedAt !== null,
  );

/**
 * One entry of the member's Done or closed state: **what left my lists lately**, inside
 * {@link DONE_WINDOW_MS}, newest first. Two kinds:
 *
 * - `task`: a task one of the member's teams did, with its run for the
 *   card line and `laterStepStarted` precomputed by the object, which is the
 *   only side that can see the later steps' tasks.
 * - `closed`: a run one of the member's teams could see ({@link runIsVisibleTo})
 *   that closed ({@link runIsClosed}), with its reason. A closed run leaves
 *   Started by you, Started by others, Ready and Blocked the moment it closes, and without this entry it would
 *   just vanish; Done or closed is where the member reads why ("Fulfilled in
 *   Shopify", "Order cancelled in Shopify"). It is a notice, not a to-do: the
 *   row offers nothing.
 */
export const RecentItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    run: Run,
    task: RunTask,
    /** {@link RunTaskRow} `laterStepStarted`, for {@link taskActions}' Reopen. */
    laterStepStarted: Schema.Boolean,
    /** The order's open or closed state, for {@link taskActions}. */
    order: OrderState,
  }),
  Schema.Struct({
    kind: Schema.Literal("closed"),
    run: Run,
    order: OrderState,
  }),
]);
export type RecentItem = typeof RecentItem.Type;

/**
 * Provisional. The rows one state returns before it offers "Show more", and the
 * size of each "more". One number for every state: a member's own (Started by you) is
 * the one they scroll least and the one that must fit, and at ~50 px a row 25
 * is under two phone screens. A proposal, not a tuned figure.
 */
export const RUN_PAGE = 25;
/** Provisional: the most rows one state may be expanded to in a single read. */
export const RUN_LIMIT_MAX = 100;

/**
 * How deep one read of a state goes, as the object accepts it: a whole number
 * of rows from 1 to {@link RUN_LIMIT_MAX}.
 *
 * **The object refuses a depth out of range; the URL clamps one into it.**
 * Depth is in the member's URL (`MemberSearch` in `src/routes/shop.$shop.tsx`),
 * so `?limit=1000` is a thing a person can type into the address bar of a page
 * they are standing on, and a typed URL is not a bug report — the router's
 * error boundary over a whole shop's work is a worse answer than a hundred
 * rows. The two halves cannot be one rule: this schema is the wire between the
 * page and the object, where a depth out of range is a caller's mistake worth
 * failing on, while the URL is text a person edits. {@link clampRunLimit} is
 * the URL's half, applied where the search schema decodes, so everything
 * downstream of it — the query key, the loader, this schema — is handed a
 * depth already in range.
 */
export const RunLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: RUN_LIMIT_MAX }),
);

/**
 * How much of a `?team=` the URL's schema keeps. The id it carries is a UUID
 * and the teams are what decide whether it means anything, so this is only
 * the bound that stops a pasted essay travelling to the object.
 */
export const TEAM_SEARCH_MAX = 128;

/**
 * The URL's half of {@link RunLimit}: whatever number the address bar carried,
 * as a whole number of rows in range. A value that is not finite falls back to
 * {@link RUN_PAGE} rather than clamping to an edge, because it names no depth
 * at all.
 */
export const clampRunLimit = (value: number) =>
  Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), RUN_LIMIT_MAX)
    : RUN_PAGE;

/**
 * What the browser may choose about its workflows list: one of its own teams to narrow
 * to (`null` is every team on the connection), which state, how many rows
 * of that state, and a search. `team` is validated against the connection's `teamIds` by the
 * object; a team the member is not on reads as an empty list, never as an
 * error. The screen resolves a URL's team against the teams before it gets
 * here (`shop.$shop.workflows.index.tsx`), so that empty list is reserved for a caller
 * that ignored the teams. The counts of every state come back regardless of
 * `state` and `q`, so the strip is always current.
 *
 * **Search ignores the filters.** When `q` is not null, `state` and `team`
 * are not applied: the rows are every match on the member's teams, open ones
 * in `items` and Done or closed ones in `recent` ({@link WorkflowsListData}).
 */
export const RunQuery = Schema.Struct({
  team: Schema.NullOr(TeamId),
  state: WorkflowsListState,
  limit: RunLimit,
  q: Schema.NullOr(ListSearch),
});
export type RunQuery = typeof RunQuery.Type;

/**
 * Structural equality, for deciding whether the loader's rows may serve as
 * the socket query's `initialData`: the route rebuilds the value on every
 * press, and the loader's own query is built from the URL.
 */
export const sameRunQuery = (a: RunQuery, b: RunQuery) =>
  a.team === b.team &&
  a.state === b.state &&
  a.limit === b.limit &&
  a.q === b.q;

/**
 * The strip's counts, keyed by {@link WorkflowsListState}: the counts of
 * the five states **after** `query.team` narrows them and never the search, because they
 * describe the lists the member can switch to.
 */
export const RunListCounts = Schema.Struct({
  started_by_you: Schema.Number,
  started_by_others: Schema.Number,
  ready: Schema.Number,
  blocked: Schema.Number,
  done: Schema.Number,
});
export type RunListCounts = typeof RunListCounts.Type;

/**
 * Everything the member's workflows list renders, in one socket round trip:
 * every state's count and one state's rows. Without a search exactly one of
 * `items` and `recent` is populated: `items` when `query.state` is a
 * {@link RunListState}, `recent` when it is "done", and the chosen state's
 * total is `counts[query.state]`. Under a search `items` holds the open
 * matches whatever their state and `recent` the Done or closed matches, so a
 * member who marked the wrong thing done can find it by number. One value rather
 * than two reads so the loader and the socket paint the same snapshot and the
 * strip never disagrees with the list under it. The suffix is `Data` for
 * the reason on {@link OrdersIndexData}.
 */
export const WorkflowsListData = Schema.Struct({
  counts: RunListCounts,
  items: Schema.Array(RunListItem),
  recent: Schema.Array(RecentItem),
  /**
   * How many rows the search finds over every team on the connection, open
   * and Done or closed together, before either half is cut to
   * `query.limit`; `null` without a search. Not a count
   * ({@link RunListCounts}): it is the search's answer, which the screen
   * prints as "N workflows match <term>" and pages with Show more, the
   * same as {@link OrdersPage} `matches` on the orders index.
   */
  matches: Schema.NullOr(Schema.Number),
});
export type WorkflowsListData = typeof WorkflowsListData.Type;

/**
 * How far back Done or closed reaches ({@link RecentItem}). A day, not a shift: a
 * mistake is noticed when the next card looks wrong, which can be after lunch
 * or the next morning, and a longer window would make Done or closed a history
 * the merchant's order page already is.
 */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One task row of the member's workflow page, decorated with what the page needs to offer
 * the right button: `current` is {@link currentTasks}' rule evaluated for this
 * task. Both flags are facts about *other* rows (earlier and later steps of
 * the run), which is why the object computes them rather than the page.
 */
export const RunTaskRow = Schema.Struct({
  ...RunTask.fields,
  current: Schema.Boolean,
  /** A task in a later step of the run has started or is done ({@link laterStepStarted}). */
  laterStepStarted: Schema.Boolean,
});
export type RunTaskRow = typeof RunTaskRow.Type;

/** What an actor may do to one run: the result of {@link runActions}, whose JSDoc holds the matrix. */
export const RunActions = Schema.Struct({
  note: Schema.Boolean,
  block: Schema.Boolean,
  unblock: Schema.Boolean,
  cancel: Schema.Boolean,
  changeWorkflow: Schema.Boolean,
});
export type RunActions = typeof RunActions.Type;

/** The "m" in {@link runActions}' table: the merchant, or a member whose team holds a current task on the run. */
const holdsCurrentTask = (
  actor: Actor,
  tasks: readonly {
    readonly teamId: string | null;
    readonly current: boolean;
  }[],
) =>
  actor.role === "merchant" ||
  tasks.some(
    (task) => task.current && taskIsOnTeams(task, actor.teamIds ?? []),
  );

/**
 * What an actor may do to one run, as the page and the server both read it.
 * The set is an upper bound. No screen offers a verb whose field is false;
 * every `ShopAgent` callable for a run or task write computes the same
 * object from the same inputs, read fresh inside the write, and refuses with
 * `NotAllowed` when the field is false, so a stale tab or a second admin
 * cannot write what no page would offer.
 *
 * A screen may offer fewer verbs than the set allows, and says why in its
 * own JSDoc. Three do: the member's workflows list offers Start and not Done
 * on a ready task (the row menu); the same list's Blocked view offers
 * Unblock alone; the merchant's order page offers Change workflow only
 * where the item has workflows to pick from, and under a closed run leaves
 * it out of Manage, since the Workflow select at rest under the run is the same verb.
 *
 * A filled cell means the set allows the write; the repository may still
 * refuse for a reason the set does not read: the attach results on Change
 * workflow (`OrderClosed`, `NothingToMake`, the `changeWorkflow` bullet
 * below), and a race between the render and the click. The repository
 * keeps its own guards underneath; they protect the write from every
 * caller, reconcile and tests included, and a refusal reaches the page as
 * `NotAllowed` ({@link RunResult}).
 *
 * The table is the rule. `test/integration/run-actions.test.ts` reads it
 * out of this comment and asserts every row, so a change starts at a cell
 * and the test names the cell until the formula follows. `pnpm lint`
 * refuses a malformed table.
 *
 * "M" is the merchant. "m" is a member whose team holds a current
 * task on the run ({@link currentTasks}, {@link taskIsOnTeams}), the team gate
 * `RunRepository` applies to Block and Unblock. "v" is a
 * member whose teams hold a task of the run ({@link runIsVisibleTo}) but no
 * current one. Blank is never. Each state column is one input; a row is one fixture, and a word
 * such as "closed" under `order` stands for every state it names; `pnpm
 * spec check` refuses a table that leaves a state without a row, or two
 * rows that share one. A done
 * run is never blocked (the data model on `initializeSchema`,
 * `ShopAgentSchema.ts`), so "any" under `blocked` beside "open or done"
 * names a block on the open run only.
 *
 * A row is checked against one task, on "m"'s team, current when the run is
 * open, with the item at `units`; `scripts/lib/spec.ts` (`expand`) builds it.
 * The `units` column exists for `changeWorkflow` alone. Cancel on an item at
 * zero units is offered, and reconcile would close that run as
 * `item_removed` anyway; both are closes.
 *
 * A member whose teams hold no task of the run gets nothing, the note
 * included, and cannot open the run page (`RunRepository.getRunPage`
 * answers `None`).
 *
 * | order  | run          | blocked | units | note  | block | unblock | cancel | changeWorkflow |
 * | ------ | ------------ | ------- | ----- | ----- | ----- | ------- | ------ | -------------- |
 * | open   | open         | no      | some  | M m v | M m   |         | M      | M              |
 * | open   | open         | yes     | some  | M m v |       | M m     | M      | M              |
 * | open   | open         | no      | none  | M m v | M m   |         | M      |                |
 * | open   | open         | yes     | none  | M m v |       | M m     | M      |                |
 * | open   | done         | no      | some  | M m v |       |         |        | M              |
 * | open   | done         | no      | none  | M m v |       |         |        |                |
 * | open   | closed       | no      | some  | M m v |       |         |        | M              |
 * | open   | closed       | no      | none  | M m v |       |         |        |                |
 * | closed | open or done | any     | any   | M m v |       |         |        |                |
 * | closed | closed       | no      | any   | M m v |       |         |        |                |
 *
 * Why a cell is blank where it might not be:
 *
 * - `note` is never blank: a note is a record, not work.
 * - `block` is blank on a blocked run: it is already held, and a second
 *   Block would overwrite who held it. On a done or closed run there is no
 *   work left to hold. Block and Unblock are the current team's as a
 *   whole, so a teammate may lift a hold they did not set, and
 *   a member whose team is later in the workflow writes a note instead: the
 *   team doing the work is the team that stops it, and widening Block would
 *   widen who the merchant has to ask.
 * - `unblock` needs {@link runIsBlocked}. A new reason is Unblock, then
 *   Block. Closing a run clears its block, so a closed run is never blocked. A blocked run on a
 *   closed order is one reconcile has not yet closed; the order's close
 *   ends the work, and the block goes with it.
 * - `cancel` is blank on a done run: it is a record, reopened rather than
 *   cancelled. A closed run is over already. On a closed order reconcile
 *   has already closed every open run; there is nothing to cancel.
 * - `changeWorkflow` needs units to make; offered on any run, done and
 *   closed included. On an open or done run it is behind the confirm on
 *   {@link runHasRecord}; on a closed run the order page's Workflow select replaces
 *   with none, since a closed run's tasks are over ({@link RunState}). A new run
 *   on an item Shopify removed or refunded to zero ({@link unitsToMake})
 *   would be a run with no work behind it, and reconcile would close it as
 *   `item_removed` on its next pass. A done run is replaced like any other:
 *   the modal names the record it loses, as it does for a started or
 *   blocked one. The field is read by the order page and never through the
 *   run gate (`requireRunAction` passes no item); `merchantAttachWorkflow`
 *   answers the same two refusals, `OrderClosed` and `NothingToMake`.
 *   Reading it needs the item, which only the merchant's callers hold, so
 *   `item` is optional and its absence answers false: a member's result is
 *   always false, and member pages never offer Change workflow.
 * - There is no member `cancel` or `changeWorkflow`: those are the
 *   merchant's decisions about what the shop makes.
 */
export const runActions = (
  actor: Actor,
  order: OrderState,
  run: { readonly state: RunState; readonly blockedAt: number | null },
  tasks: readonly {
    readonly teamId: string | null;
    readonly current: boolean;
  }[],
  /** Read for `changeWorkflow` alone, by the attach callable; absent, that field is false (the `changeWorkflow` bullet). */
  item?: Pick<OrderLineItem, "currentQuantity">,
): RunActions => {
  const merchant = actor.role === "merchant";
  const working = orderIsOpen(order) && runIsOpen(run);
  const holds = holdsCurrentTask(actor, tasks);
  return {
    note: merchant || runIsVisibleTo(tasks, actor.teamIds ?? []),
    block: working && !runIsBlocked(run) && holds,
    unblock: working && runIsBlocked(run) && holds,
    cancel: merchant && working,
    changeWorkflow:
      merchant &&
      orderIsOpen(order) &&
      item !== undefined &&
      unitsToMake(item) > 0,
  };
};

/**
 * What an actor may do to one task: the result of {@link taskActions}, whose JSDoc holds the matrix.
 */
export const TaskActions = Schema.Struct({
  start: Schema.Boolean,
  done: Schema.Boolean,
  putBack: Schema.Boolean,
  reopen: Schema.Boolean,
  assign: Schema.Boolean,
});
export type TaskActions = typeof TaskActions.Type;

/**
 * What an actor may do to one task, by the same contract as
 * {@link runActions}: the page draws a button only when its field is true,
 * the `ShopAgent` callable refuses with `NotAllowed` when it is false, and
 * the test reads this table; the upper bound, the screens that offer less
 * and the refusals the set does not read are on {@link runActions}. "M" is
 * the merchant, "m" a member whose team the task is on
 * ({@link taskIsOnTeams}). A member whose teams hold no task of the run gets
 * nothing, the note included, and cannot open the run page. `pnpm spec
 * check` refuses a table that leaves a state the object can hold without a
 * row, or two rows that share one; a `done` run with a task not done is not
 * one, and `-` under `downstream` is a state Reopen is not offered in, so
 * the column is not read.
 *
 * `downstream` is {@link RunTaskRow} `laterStepStarted`: `none` is no later
 * task started or done; `started` is a later task started or done, since
 * Done records a start (`markTaskDone` backfills `startedAt`); `-` is a
 * state Reopen is never asked in. On a done run every task but the last has a started
 * downstream, so the only reopenable task on a done run is its last one,
 * which is the point of offering Reopen there.
 *
 * The task set reads the run and the order, never the item. An item at zero
 * units under an open run is reconcile's to close (`item_removed`, the
 * actions table on `reconcileItem`), and a Done that lands before that pass
 * stands: a Done on an open run whose item is at zero units stands, and
 * reconcile then leaves the done run alone.
 *
 * | order  | run          | blocked | task     | downstream | start | done | putBack | reopen  | assign |
 * | ------ | ------------ | ------- | -------- | ---------- | ----- | ---- | ------- | ------- | ------ |
 * | open   | open         | no      | ready    | -          | m     | M m  |         |         | M      |
 * | open   | open         | no      | started  | -          |       | M m  | M m     |         | M      |
 * | open   | open         | no      | waiting  | -          |       |      |         |         | M      |
 * | open   | open         | yes     | any open | -          |       |      |         |         | M      |
 * | open   | open or done | any     | done     | none       |       |      |         | M m     |        |
 * | open   | open or done | any     | done     | started    |       |      |         |         |        |
 * | open   | closed       | no      | any      | -          |       |      |         |         |        |
 * | closed | open or done | any     | any      | -          |       |      |         |         |        |
 * | closed | closed       | no      | any      | -          |       |      |         |         |        |
 *
 * - `start` is member only. "Started" records that a worker picked the task
 *   up, and a merchant marking it started on their behalf would put a name
 *   on work nobody has begun. A Done without a Start records the actor as
 *   the starter too, so a merchant's Done names the merchant twice and no
 *   worker once.
 * - `done` and `putBack` stop under a block: a block means stop
 *   ({@link runIsBlocked}). Put back is refused under a hold because a held
 *   task is the one someone needs to write on, and clearing who has it
 *   loses the one name the merchant needs. Put back goes to the whole team,
 *   not only the starter: Start is a record, not a lock, and the inverse of
 *   a verb is as open as the verb.
 * - `reopen`: a done task reopens when no later step has a task started
 *   or done; once one has, the fix is a conversation with whoever has it,
 *   and the page names no one. It is offered under a block because it takes
 *   work back rather than doing more, and on a done run because reopening
 *   its last task is the point. Not on a closed run: closed is final ({@link RunState}),
 *   and reopening a task would put work back on a run that can never be
 *   done. "m" is the task's team, not who pressed Done, for the reason on
 *   `putBack`: a Done pressed by a teammate who has gone home is the case
 *   Undo is for. Undo is offered to the task's whole team, not only to who
 *   pressed Done.
 * - `assign` is blank on a done task: it keeps the team that did it
 *   (`TaskDoneError`). One verb for a task with no team and for moving
 *   one that has a team. Assign answers `Assigned`, not `Ok`, because it
 *   carries `TeamNotFound`, which no other run write has; the test allows
 *   for it.
 * - A task on no team, or on a team that no longer exists
 *   ({@link runTaskIsUnassigned}), is nobody's: every member cell is blank
 *   and every merchant cell holds, so the merchant can finish or move work
 *   no member can reach.
 * - Everything is blank on a closed order ({@link orderIsOpen}) and a
 *   closed run: Shopify, or the merchant, says the work is over.
 *
 * **The verbs a task offers are the same on the workflows list and the
 * workflow page, and neither screen styles one as primary.** Primary and
 * secondary are a page's hierarchy, held in `s-page`'s action slots; a task has neither.
 * Polaris allows one primary per card and per page
 * (`refs/shopify-docs/docs/apps/design/layout.md`, "Cards that offer
 * interactivity"), and a step with two current tasks would draw two.
 */
export const taskActions = (
  actor: Actor,
  order: OrderState,
  run: { readonly state: RunState; readonly blockedAt: number | null },
  task: Pick<
    RunTaskRow,
    "teamId" | "current" | "startedAt" | "doneAt" | "laterStepStarted"
  >,
): TaskActions => {
  const merchant = actor.role === "merchant";
  const orderOpen = orderIsOpen(order);
  const mine =
    orderOpen && (merchant || taskIsOnTeams(task, actor.teamIds ?? []));
  const workable =
    mine &&
    runIsOpen(run) &&
    !runIsBlocked(run) &&
    task.current &&
    task.doneAt === null;
  return {
    start: workable && !merchant && task.startedAt === null,
    done: workable,
    putBack: workable && task.startedAt !== null,
    reopen:
      mine &&
      !runIsClosed(run) &&
      task.doneAt !== null &&
      !task.laterStepStarted,
    assign: merchant && orderOpen && runIsOpen(run) && task.doneAt === null,
  };
};

/**
 * What one item's card is, as the order page switches on it: one kind
 * per layout.
 *
 * - `open`: the item's run is open. Checked first with `ended`, so an item
 *   whose units dropped to zero under a run still shows the work on it. No
 *   Workflow select: Change workflow is a verb on the run card ({@link runActions}).
 * - `ended`: the item's run is `done` or {@link runIsClosed}. The run card
 *   shows with its tasks as the record (a closed one with a line giving the
 *   reason and when). Under a closed run the Workflow select at rest offers every
 *   workflow, the run's own included, as a fresh run; under a done run
 *   Change workflow is in Manage, behind the confirm, because replacing it
 *   loses a record ({@link runActions}). One kind for both states and every
 *   reason: the reason is a line of copy ({@link ClosedReason}), not a layout.
 *   `attachable` is false when the item has nothing left to make
 *   ({@link unitsToMake}): no workflow creates a run there, the same rule as
 *   `changeWorkflow` on {@link runActions}, and the run stands alone.
 * - `removed`: no run, and `currentQuantity` is zero. Nothing to do.
 * - `attachable`: no run, and at least one workflow that is on, with tasks, can be
 *   attached. `options` lists the matched workflows first, then the rest;
 *   `multiMatch` is {@link multiMatchItems}' test for this one item, and the
 *   page says why it is asking.
 * - `unmatched`: no run and no workflow to offer.
 *
 * A block is not a kind: it adds a banner, not a different card. A closed
 * order is not a kind either: the kinds are the same under it, every field
 * of {@link runActions} and {@link taskActions} that does work is false, and
 * the sidebar's Fulfillment and Cancelled lines say why. The one control
 * outside those sets, the Workflow select at rest, is the page's to hide with
 * {@link orderIsOpen}.
 *
 * `tasks` are decorated as the workflow page's are ({@link RunTaskRow}), from
 * rows the order page already holds, so {@link taskActions} reads the same
 * shape on both pages.
 */
export const LineItemState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("removed") }),
  Schema.Struct({ kind: Schema.Literal("unmatched") }),
  Schema.Struct({
    kind: Schema.Literal("attachable"),
    options: Schema.Array(WorkflowNameRow),
    matched: Schema.Array(WorkflowId),
    multiMatch: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("ended"),
    run: Run,
    tasks: Schema.Array(RunTaskRow),
    options: Schema.Array(WorkflowNameRow),
    matched: Schema.Array(WorkflowId),
    attachable: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("open"),
    run: Run,
    tasks: Schema.Array(RunTaskRow),
  }),
]);
export type LineItemState = typeof LineItemState.Type;

/** A run's tasks as {@link RunTaskRow}s, from the rows alone: the `current` flag by {@link currentTasks}, `laterStepStarted` by {@link laterStepStarted}. */
export const runTaskRows = (
  run: { readonly state: RunState },
  tasks: readonly RunTask[],
): RunTaskRow[] => {
  const current = new Set(currentTasks(run, tasks).map((task) => task.id));
  return tasks.map((task) => ({
    ...task,
    current: current.has(task.id),
    laterStepStarted: laterStepStarted(task, tasks),
  }));
};

/**
 * Shop work's reading of an order's item, from {@link OrderLineItem} and
 * {@link unitsToMake}: its card on the order page, one of the
 * {@link LineItemState} kinds. `details` are the on workflows the order's
 * tags found, with their tasks ({@link OrderPageData} `matchedWorkflows`);
 * `other` is every other on workflow with tasks, by name. The options are
 * the item's own matches, then the rest of `details`, then `other`, each
 * workflow once.
 */
export const lineItemState = (
  item: OrderLineItem,
  runs: readonly RunDetail[],
  details: readonly WorkflowDetail[],
  other: readonly WorkflowNameRow[],
  teams: readonly { readonly id: TeamId }[],
): LineItemState => {
  const detail = runs.find(({ run }) => run.lineItemId === item.id);
  const workflows = details.map(({ workflow }) => workflow);
  const matched = matchedWorkflows(item, details, teams).map(
    ({ workflow }) => workflow,
  );
  const options = [
    ...matched,
    ...workflows.filter((workflow) => !matched.includes(workflow)),
    ...other.filter(
      (workflow) => !workflows.some(({ id }) => id === workflow.id),
    ),
  ];
  return Match.value({ detail, removed: item.currentQuantity === 0 }).pipe(
    Match.withReturnType<LineItemState>(),
    Match.when({ detail: Match.defined }, ({ detail: { run, tasks } }) =>
      runIsOpen(run)
        ? { kind: "open", run, tasks: runTaskRows(run, tasks) }
        : {
            kind: "ended",
            run,
            tasks: runTaskRows(run, tasks),
            options,
            matched: matched.map((workflow) => workflow.id),
            attachable: unitsToMake(item) > 0,
          },
    ),
    Match.when({ removed: true }, () => ({ kind: "removed" })),
    Match.when(
      () => options.length === 0,
      () => ({ kind: "unmatched" }),
    ),
    Match.orElse(() => ({
      kind: "attachable",
      options,
      matched: matched.map((workflow) => workflow.id),
      multiMatch: matched.length >= 2 && unitsToMake(item) > 0,
    })),
  );
};

/**
 * Everything the member's workflow page renders: one run, its tasks, and the
 * order's live note. "Run" rather than "Workflow" in the name because the
 * merchant's workflow page has {@link WorkflowPageData}, and the route is
 * `$runId`. The suffix is `Data` for the reason on {@link OrdersIndexData}.
 *
 * The other items on the order are deliberately **not** here. A workflow
 * is attached to a product and runs once per matching item
 * ({@link Workflow}), so a member's unit of work is the item and its
 * tasks. Nothing on this page acts on the order as a whole, and an order can
 * carry an unbounded number of lines to render.
 */
export const RunPageData = Schema.Struct({
  run: Run,
  tasks: Schema.Array(RunTaskRow),
  /** Shopify's order note, read-only here; the run's own note is `run.note`. */
  orderNote: Schema.NullOr(Schema.String),
  /** The order's open or closed state, for {@link runActions} and {@link taskActions}. */
  order: OrderState,
});
export type RunPageData = typeof RunPageData.Type;

export const ListRunsForOrderInput = Schema.Struct({ orderId: BoundedId });
export type ListRunsForOrderInput = typeof ListRunsForOrderInput.Type;

export const AttachWorkflowInput = Schema.Struct({
  lineItemId: BoundedId,
  workflowId: BoundedId,
});
export type AttachWorkflowInput = typeof AttachWorkflowInput.Type;

export const RunIdInput = Schema.Struct({ runId: BoundedId });
export type RunIdInput = typeof RunIdInput.Type;

/** Everything the order page renders, in one socket round trip. The suffix is `Data` for the reason on {@link OrdersIndexData}. */
export const OrderPageData = Schema.Struct({
  order: ShopOrder,
  lineItems: Schema.Array(OrderLineItem),
  runs: Schema.Array(RunDetail),
  /**
   * The on workflows with tasks whose tag an item of the order carries, with
   * their tasks: what {@link lineItemState} reads the matches from
   * ({@link itemMatches} needs the tasks for eligibility), found by the
   * items' tags. The first options of the Workflow select.
   */
  matchedWorkflows: Schema.Array(WorkflowDetail),
  /**
   * Every other on workflow with tasks, by name: the rest of the Workflow
   * select's options, after the divider. Names only, since nothing on the
   * page decides anything about them until one is chosen, and Attach reads
   * the chosen workflow again. Both lists ride in the page's data rather
   * than a second socket query so the page has exactly one read, one key,
   * and one invalidation.
   */
  otherWorkflows: Schema.Array(WorkflowNameRow),
  /** The shop's live teams: the Assign team select's choices, and what decides which open tasks are unassigned. */
  teams: Schema.Array(TeamWithMemberCount),
});
export type OrderPageData = typeof OrderPageData.Type;

/**
 * The member workflows list's loader read. Still Worker-resolved: `teamIds` comes
 * from `requireMember`, and the list's first paint is SSR, where there is no socket
 * to carry an identity — so this one stays plain RPC through `ShopAgentClient`
 * while the mutations below moved onto the socket.
 */
export const ListRunsInput = Schema.Struct({
  teamIds: Schema.Array(TeamId),
  memberEmail: Email,
  query: RunQuery,
});
export type ListRunsInput = typeof ListRunsInput.Type;

/**
 * The member workflows list's read over the socket: the same rows `listRuns`
 * returns. `teamIds` and `memberEmail` are absent on purpose — the list is
 * narrowed by the membership on the connection, which the member cannot name
 * for themselves. `query` is theirs to name: it chooses among their own teams,
 * which state, how far that state is expanded, and a search, and the object bounds them.
 */
export const LiveRunsInput = Schema.Struct({
  query: RunQuery,
});
export type LiveRunsInput = typeof LiveRunsInput.Type;

/**
 * The workflow page's loader read, Worker-resolved for the same reason as
 * {@link ListRunsInput}. The guard is "any task of the run on one of my
 * teams", not "a current task": a member may open work they have done.
 */
export const GetRunForMemberInput = Schema.Struct({
  runId: BoundedId,
  teamIds: Schema.Array(BoundedId),
});
export type GetRunForMemberInput = typeof GetRunForMemberInput.Type;

/**
 * Member-area mutation inputs: **what the browser sends, and nothing more.**
 * Each is the id of the thing that was clicked plus, where there is one, the
 * text that was typed.
 *
 * `memberId`, `memberEmail`, and `teamIds` are deliberately absent. They are
 * what decides whether the write is allowed and who history records, so they
 * come off the connection the Worker's gate authorized
 * ({@link ConnectionState}), never off the wire — a member who could name their
 * own `teamIds` could act on any team's work, and one who could name their own
 * `memberEmail` could sign someone else's name to it. The object pairs the two
 * halves into the `*Command` shapes below before touching the repository.
 */
export const MarkTaskDoneInput = Schema.Struct({
  runTaskId: BoundedId,
});
export type MarkTaskDoneInput = typeof MarkTaskDoneInput.Type;

export const StartTaskInput = MarkTaskDoneInput;
export type StartTaskInput = typeof StartTaskInput.Type;

/** Reopen: returns a done task to Ready. Same shape; the rule is on `RunRepository.reopenTask`. */
export const ReopenTaskInput = MarkTaskDoneInput;
export type ReopenTaskInput = typeof ReopenTaskInput.Type;

/** Put back: clears a started task's Start record. Same shape; the rule is on `RunRepository.putBackTask`. */
export const PutBackTaskInput = MarkTaskDoneInput;
export type PutBackTaskInput = typeof PutBackTaskInput.Type;

/** `note: null` clears. The rule is on {@link SetRunNoteCommand}. */
export const SetRunNoteInput = Schema.Struct({
  runId: BoundedId,
  note: Schema.NullOr(RunNote),
});
export type SetRunNoteInput = typeof SetRunNoteInput.Type;

/** `reason: null` blocks without a reason. */
export const BlockRunInput = Schema.Struct({
  runId: BoundedId,
  reason: Schema.NullOr(BlockReason),
});
export type BlockRunInput = typeof BlockRunInput.Type;

/**
 * The whole write, as the run repository takes it: the wire input above joined
 * to the acting member's identity from the connection. Types rather than
 * schemas because nothing decodes them — they are assembled inside the object
 * from two values that were each already validated, and naming them is what
 * keeps "which fields are the browser's" answerable at a glance.
 *
 * Identity is one {@link Actor}, not a loose `memberId` / `memberEmail` pair,
 * because the merchant acts through these same commands from the order page
 * and has neither. `teamIds` is *optional* and that is the whole permission
 * difference: present, it is the member's membership and the task's team must
 * be in it; absent, the caller is the merchant and the team clause is skipped
 * entirely. Every other rule — step order, terminal runs, the later-step
 * reopen guard — applies to both.
 */
export interface StartTaskCommand {
  readonly runTaskId: string;
  /** Member-only: there is no merchant Start — the merchant never claims work. */
  readonly actor: MemberActor;
  readonly teamIds?: readonly string[] | undefined;
}

export interface MarkTaskDoneCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No `actor`: the run note is one field anyone with access may write, last
 * write wins, and nothing records who wrote it. Recording the editor would be
 * an attribution the UI never shows; people who want their lines attributed
 * sign them, which is enough for a shop where everyone knows everyone. Every
 * free-text field on a run follows this rule; a block's reason is the
 * blocker's own words, written with the block ({@link BlockRunCommand}).
 */
export interface SetRunNoteCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
  readonly note: RunNote | null;
}

export interface BlockRunCommand {
  readonly runId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: BlockReason | null;
}

/** Lifts a block. No `actor`: nothing records who unblocked, and the block's own record goes with it. */
export interface UnblockRunCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No column records the actor: a reopen clears the task's record and writes
 * none ({@link RunTask}). `actor` is taken for the log line and for symmetry
 * with the other task commands.
 */
export interface ReopenTaskCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No column records the actor: the task is plain Ready again
 * ({@link RunTask}). `actor` is taken for the log line and for
 * symmetry with the other task commands.
 */
export interface PutBackTaskCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * `WorkflowNotEligible` = off, zero tasks, or an unassigned task (see
 * {@link Workflow}).
 *
 * `replaced` is the run that was deleted to make room, or null. An item
 * holds at most one run, so attaching over one is a *replace*: the server
 * decides that from the item's state rather than from a separate input, and
 * the page uses `replaced` to say which workflow it took the item off.
 */
export const AttachResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    run: Run,
    replaced: Schema.NullOr(Run),
  }),
  Schema.Struct({ _tag: Schema.Literal("AlreadyExists") }),
  Schema.Struct({ _tag: Schema.Literal("LineItemNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("WorkflowNotEligible") }),
  /** The order is cancelled or fully fulfilled, so there is nothing to attach work to ({@link orderIsOpen}). */
  Schema.Struct({ _tag: Schema.Literal("OrderClosed") }),
  /** The item has no units to make ({@link unitsToMake}): removed or refunded to zero in Shopify. */
  Schema.Struct({ _tag: Schema.Literal("NothingToMake") }),
]);
export type AttachResult = typeof AttachResult.Type;

/**
 * `NotAllowed` is the action set refusing the write ({@link runActions},
 * {@link taskActions}), or a race between the render and the click that a
 * repository guard caught (the task changed, the run closed, a block landed);
 * the page re-reads either way, so one tag serves both. `NotFound` is the run
 * or its order gone.
 */
export const RunResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NotAllowed") }),
]);
export type RunResult = typeof RunResult.Type;

/**
 * Vocabulary, production. What the shop makes and who makes it. The screen
 * columns are checked: each cell is the value of the label constant beside
 * the table ({@link TASK_STATE_LABEL},
 * {@link RUN_STATE_LABEL}, {@link WORKFLOW_STATE_LABEL},
 * {@link ORDER_POSITION_LABEL}, {@link ORDER_ISSUE_LABEL},
 * {@link VERB_LABEL}), and `pnpm spec check` refuses a cell that differs, so
 * a label change starts here.
 *
 * Nouns, production. "(none)" means no screen says the word; the
 * cell says what a screen shows instead:
 *
 * | word     | meaning                                                                                 | symbol                                 | screen                                                      |
 * | -------- | --------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
 * | merchant | the shop's owner, acting from the Shopify admin                                         | `Actor` role `merchant`                | "you" to the merchant, "the merchant" to a member           |
 * | member   | a person at the bench, on one or more teams                                             | `Actor` role `member`, `Member`        | member (merchant screens); "you" or a name (member screens) |
 * | team     | the group a task is assigned to                                                         | `Team`                                 | team, or its name                                           |
 * | workflow | the definition: steps of tasks                                                          | `Workflow`, `WorkflowTask`             | workflow, or its name                                       |
 * | step     | a position in a workflow; its tasks are done in parallel                                | `WorkflowTask`, `RunTask` field        | Step k of n                                                 |
 * | run      | one item going through one workflow                                                     | `Run`                                  | the item's workflow, on both sides; never bare, never "run" |
 * | task     | one unit of work on a run, on one team                                                  | `RunTask`                              | task, or its name                                           |
 * | block    | a person's hold on a run                                                                | `runIsBlocked`                         | Blocked                                                     |
 * | note     | free text on a run                                                                      | `RunNote`                              | Note                                                        |
 * | draft    | the workflow's edited copy of its tasks, from Edit until Apply or Discard; one or none  | `WorkflowDraft`                        | Draft                                                       |
 * | view     | a preset of a list, one at a time, chosen by its button; the row's first is the default | `WorkflowsListView`, `OrdersIndexView` | its label (Started by you, Issues, ...)                     |
 *
 * The orders index reads the view row too: its views are `OrdersIndexView`.
 *
 * "run" is an implementation noun a merchant or member would have to learn;
 * the merchant already has the item and its workflow (Change workflow replaces
 * the run without naming it), and the member has the item's workflow and
 * its tasks. `scripts/rules-lint.ts` refuses "run", "line item" and the
 * other retired words in screen strings. The run's screen word is
 * "workflow" with the item beside it ("Brass hinge ×2 · Finishing",
 * "Finishing workflow · #1001"). On the merchant's Workflows pages a bare
 * workflow name is the definition; on the member's Workflows list, which
 * never shows a definition, every row is a run and names its item.
 *
 * Run states, production:
 *
 * | word    | meaning                                           | stored          | screen                                                  |
 * | ------- | ------------------------------------------------- | --------------- | ------------------------------------------------------- |
 * | open    | work can be recorded                              | `open`          | In progress (merchant: Not started until a task starts) |
 * | blocked | open, and a person holds it                       | `blockedAt` set | Blocked                                                 |
 * | done    | a person marked the last task done                | `done`          | Done                                                    |
 * | closed  | something else ended it; `closedReason` says what | `closed`        | Closed · <reason>                                       |
 *
 * Task states, production. `current` is the flag: the task's step is the lowest with
 * an open task ({@link currentTasks}), whether or not someone has it. The
 * one derivation is {@link taskStateOf}; it reads `startedAt` before
 * `current`, so a task someone had when its run closed still reads started:
 *
 * | word    | meaning                            | derived from                          | screen  |
 * | ------- | ---------------------------------- | ------------------------------------- | ------- |
 * | waiting | its step is not current            | not current, `startedAt` null         | (none)  |
 * | ready   | its step is current, nobody has it | current, `startedAt` null             | Ready   |
 * | started | a person has it                    | `startedAt` set (current on an open run) | Started |
 * | done    | a person marked it done            | `doneAt` set                          | Done    |
 *
 * "In progress" is the run's screen word and only the run's: a started
 * task reads Started so the merchant never reads one word for two facts
 * on one card. "waiting" is a code word; the orders index's "Waiting on"
 * column means teams holding a current task, a fact about orders, and the
 * two never render together.
 *
 * Workflow states, production:
 *
 * | word | meaning                               | stored             | screen |
 * | ---- | ------------------------------------- | ------------------ | ------ |
 * | on   | new items get runs from it            | `activatedAt` set  | On     |
 * | off  | it creates nothing; open runs carry on | `activatedAt` null | Off    |
 *
 * The switch's screen words are Shopify Flow's (Turn on, Turn off;
 * `refs/flow-manual/manage/manual.md`); the badge says On and Off where Flow
 * says Active and Inactive, because "active" is not a production word here,
 * and one execution is never called a run on a screen, because a run in
 * Baton is a member's work.
 *
 * Order positions, production: one per order, derived by {@link orderPosition} and
 * never stored:
 *
 * | word        | meaning                           | screen      |
 * | ----------- | --------------------------------- | ----------- |
 * | not started | open, no open run and no done run | Not started |
 * | making      | open, an open run                 | Making      |
 * | made        | open, done runs and no open run   | Made        |
 * | fulfilled   | Shopify says `FULFILLED`          | Fulfilled   |
 * | cancelled   | Shopify says `cancelledAt`        | Cancelled   |
 *
 * Order issues, production: zero or more per open order, derived by {@link orderIssues}:
 *
 * | word            | meaning                                           | screen              |
 * | --------------- | ------------------------------------------------- | ------------------- |
 * | choose workflow | an item matched two or more workflows             | Needs a workflow    |
 * | unassigned      | an open task on no team                           | Needs a team        |
 * | empty team      | a current task on a team with no members          | Team has no members |
 * | blocked         | a run on the order is blocked, the run-state word | Blocked             |
 *
 * The workflows index and the workflow page show the `unassigned` and `empty team`
 * rows' screen words for a workflow with the same fault, so one fault has one
 * label wherever it shows.
 *
 * Verbs, production. Who may do each, and in which state, is the matrix on
 * {@link taskActions} or {@link runActions}, not here; the four workflow
 * verbs are the merchant's alone, on the merchant's workflow page and the
 * workflow editor, and {@link ApplyResult}, {@link DiscardResult} and
 * {@link SwitchResult} say what each refuses. The two screen
 * columns are the member's and the merchant's label; "(none)" means that
 * screen never offers the verb. Undo and Reopen are two words for one
 * verb on purpose: the member takes back their own Done, the merchant
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
 * | edit reason     | run      | changes the block's reason               | Edit reason | Edit reason     |
 * | unblock         | run      | blocked → open                           | Unblock     | Unblock         |
 * | cancel          | run      | open → closed, `merchant_cancelled`      | (none)      | Cancel workflow |
 * | attach workflow | item     | creates the run                          | (none)      | Attach          |
 * | change workflow | item     | replaces the run                         | (none)      | Change workflow |
 * | apply           | workflow | the draft's tasks replace the workflow's | (none)      | Apply changes   |
 * | discard         | workflow | deletes the draft                        | (none)      | Discard changes |
 * | turn on         | workflow | off → on                                 | (none)      | Turn on         |
 * | turn off        | workflow | on → off                                 | (none)      | Turn off        |
 */

/**
 * The action tables cover buttons, and a run leaving Started by you, Started by
 * others, Ready and Blocked is its status, not a button: a table can say a run
 * offers nothing and a list can still show it, so which rows a list holds is
 * decided by {@link RunStatus} (open runs only) and nothing else, the same
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
  unitsToMake,
} from "./Orders.ts";
import {
  BoundedId,
  ConnectionRole,
  Email,
  Shop,
  SqliteBoolean,
  SubscriberIdInput,
  Subscription,
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
 * reopen while it is started ({@link reopenBlockedBy}). On a closed run no
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
 * The vocabulary's order-positions screen column: the orders index's Status
 * badge and its position views. "Not started" is also
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
 * The vocabulary's order-issues screen column: the badges in the orders index's
 * Issues column. A row of filter buttons used to carry these words too; now
 * only the badges do, and the Issues view holds all of them. The workflows
 * index's badges and the workflow page's banners read `unassigned` and
 * `empty_team` from here too, with {@link ORDER_ISSUE_TONE}, so a fault has
 * one label and one tone on every screen.
 */
export const ORDER_ISSUE_LABEL = {
  choose_workflow: "Needs a workflow",
  unassigned: "Needs a team",
  empty_team: "Team has no members",
  blocked: "Blocked",
} as const satisfies Record<OrderIssue, string>;

/**
 * The orders index's view-row labels, in view-row order: the positions of
 * {@link ORDER_POSITION_LABEL} plus Open, Issues and All, the three views
 * that are scopes rather than positions ({@link OrdersIndexView}). Not a
 * vocabulary table: Open and All carry no rule of their own, and the two
 * vocabulary tables cover the words. `open` keys the default view, which is
 * `null` in the URL; `cancelled` has no button.
 */
export const ORDERS_INDEX_VIEW_LABEL = {
  open: "Open",
  not_started: ORDER_POSITION_LABEL.not_started,
  making: ORDER_POSITION_LABEL.making,
  made: ORDER_POSITION_LABEL.made,
  fulfilled: ORDER_POSITION_LABEL.fulfilled,
  all: "All",
  issues: "Issues",
} as const satisfies Record<
  Exclude<OrdersIndexView, "cancelled"> | "open",
  string
>;

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
  "editReason",
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
  editReason: { member: "Edit reason", merchant: "Edit reason" },
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
  createdAt: Schema.String,
});
export type Member = typeof Member.Type;

export const TeamId = Schema.NonEmptyString.pipe(Schema.brand("TeamId"));
export type TeamId = typeof TeamId.Type;

/**
 * The length of a trimmed team name: half of {@link NAME_MAX_LENGTH}. The
 * schema check and the Create and Rename fields read this. A team name is a
 * label printed in a badge, and the Orders screen's Waiting on column puts up
 * to two of them side by side in one table cell; `s-badge` never wraps or
 * truncates, so the cap is what bounds the column's width. 32 still admits
 * the names a shop gives a bench or a crew ("Leather finishing, bench 3");
 * 24 would refuse some of them. Task and workflow names keep 64 because they
 * sit on their own line of a card, where they can wrap.
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
 * index (on a workflow or an order it is the `empty_team` {@link OrderIssue}):
 * its tasks can still create runs, nobody can work them until someone joins,
 * and adding one member fixes everything with no data change.
 */
export const Team = Schema.Struct({
  id: TeamId,
  shop: Shop,
  name: TeamName,
  createdAt: Schema.String,
});
export type Team = typeof Team.Type;

export const TeamSummary = Schema.Struct({
  ...Team.fields,
  memberCount: Schema.Number,
});
export type TeamSummary = typeof TeamSummary.Type;

/**
 * The shop's teams, read live from D1 as the Durable Object hands it to pages: what the team
 * pickers list and what `unassigned` and `emptyTeam` are computed against.
 * `memberCount` is here so "No members on <team>" needs no second read.
 */
export const TeamWithMemberCount = Schema.Struct({
  id: TeamId,
  name: TeamName,
  memberCount: Schema.Number,
});
export type TeamWithMemberCount = typeof TeamWithMemberCount.Type;

/**
 * The team plus every member of its shop, each marked with whether they are on
 * it — the detail screen toggles membership against every member of the shop, so the
 * non-members are as much a part of the screen as the members.
 */
export const TeamDetail = Schema.Struct({
  team: Team,
  members: Schema.Array(
    Schema.Struct({
      ...Member.fields,
      inTeam: SqliteBoolean,
      /** The `TeamMember.createdAt` of the edge; `null` when `inTeam` is false. */
      inTeamSince: Schema.NullOr(Schema.String),
    }),
  ),
});
export type TeamDetail = typeof TeamDetail.Type;

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

/**
 * One row per `(member, team)` edge in a shop, with the team's total member
 * count riding along: the members page paints its Teams column from it, the
 * edit-teams modal seeds its checklist from it, and a sole membership — the
 * team a delete would empty — is simply `teamMemberCount === 1`, so no second
 * read over the same join exists to drift from this one.
 */
export const MemberTeam = Schema.Struct({
  memberId: MemberId,
  teamId: TeamId,
  teamName: TeamName,
  teamMemberCount: Schema.Number,
});
export type MemberTeam = typeof MemberTeam.Type;

export const WorkflowId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowId"),
);
export type WorkflowId = typeof WorkflowId.Type;

export const WorkflowTaskId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowTaskId"),
);
export type WorkflowTaskId = typeof WorkflowTaskId.Type;

/** The length of every trimmed name: the schema check, the field `maxLength`, and the rename dialog's counter all read this. */
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

/** Merchant-written how-to for a task, copied onto every run. Trimmed like {@link TaskName}; a blank field is sent as `null`, never as an empty string. */
export const TaskInstructions = trimmedText("TaskInstructions", 2000);
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

/**
 * The workflow's one tag: its identity in a form a product can carry. Every
 * workflow has exactly one, from birth, and no two workflows share one. Baton
 * mints it (the create dialog prefills it from the workflow name) and the
 * merchant puts it on products in Shopify; an item whose product carries
 * it follows the workflow. It is not a *product* tag — that is
 * `OrderLineItem.productTags`, the product's own merchandising facets, which
 * this is matched against.
 *
 * Trimmed *and* lowercased, unlike the names: merchants type `Engraving` and
 * `engraving` interchangeably and Shopify's own admin search is
 * case-insensitive, so folding once at the boundary keeps storage canonical
 * and makes matching plain equality. 255 is Shopify's tag length limit; Baton
 * adds no character rules of its own beyond what Shopify allows in a tag.
 */
export const WorkflowTag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(255)).pipe(
      Schema.brand("WorkflowTag"),
    ),
    {
      decode: SchemaGetter.transform((s) => s.trim().toLowerCase()),
      encode: SchemaGetter.transform((s) => s),
    },
  ),
);
export type WorkflowTag = typeof WorkflowTag.Type;

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
 * **Discard changes** deletes the draft. **Turn on** / **Turn off** set and
 * clear `activatedAt`; the switch and the draft are unrelated.
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
 *   workflow can start and offers the picker; the orders index shows the
 *   order under Not started with nothing in Issues;
 * - the order page says a workflow **started for** N items;
 * - a workflow **applies to orders placed since** it was turned on; the
 *   word for an order's date is **placed**, never a field name.
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
 * members never see the tag, and pickers such as the order page's attach
 * list show only the name, so the name alone has to tell two workflows
 * apart. A rename is immediate and cosmetic because runs snapshot
 * `workflowName`.
 *
 * `activatedAt` is the on/off switch and the coverage date in one column,
 * stored and never derived: null is off; Turn on sets it to now, or to an
 * earlier date the merchant chose to include waiting orders; the merchant
 * can move it on the workflow page; Turn off clears it; Apply never touches
 * it, because an unpaid order placed while the workflow was on is still that
 * workflow's business when it pays. A workflow creates a run on an order only
 * if the order was placed (`ShopOrder.processedAt`) on or after
 * `activatedAt`, on every path — new-order webhook, edit webhook, sync,
 * resync — so an old order Baton meets late is never touched. A workflow can
 * create runs when `activatedAt is not null and it has tasks and every task
 * is assigned to a team that exists`; `activatedAt` not null implies at
 * least one task, every one assigned at the moment of Turn on.
 * A task whose team was deleted is **unassigned** (`teamId` null, or an id
 * no D1 row carries — read as null everywhere). A workflow with an
 * unassigned task carries the `unassigned` {@link OrderIssue} (**Needs a team**)
 * and one with a task on a team with no members the `empty_team` issue
 * (**Team has no members**), with the orders index's labels and tone
 * ({@link ORDER_ISSUE_LABEL}, {@link ORDER_ISSUE_TONE}), on the workflows
 * index as badges and on the workflow page as banners. Both are derived on
 * every read and never stored.
 * **Apply and Turn on refuse only a fault the draft itself can fix.** An
 * unassigned task is fixed in the draft, so both refuse it. An empty team is
 * fixed on the team page, outside the draft, so neither refuses it: refusing
 * would make the merchant staff every team before defining the workflow.
 * Either fault is still an {@link OrderIssue} on every order it stops.
 * Tasks change only through Apply, so an order arriving between two edits
 * sees a whole definition, never a half one; the tag and the name are
 * immediate, because runs snapshot both at start. Encoded side is the Durable Object row
 * (epoch-ms integers).
 */
const WorkflowFields = {
  id: WorkflowId,
  name: WorkflowName,
  activatedAt: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
};

/** On: `activatedAt` is set. The one read of the switch, so no caller compares the column to null on its own. */
export const workflowIsOn = (workflow: {
  readonly activatedAt: number | null;
}) => workflow.activatedAt !== null;

/** A workflow: chosen by its tag, running once per matching item. */
export const Workflow = Schema.Struct({
  ...WorkflowFields,
  tag: WorkflowTag,
});
export type Workflow = typeof Workflow.Type;

/**
 * The draft side of {@link Workflow}, holding the tasks being edited as
 * `WorkflowDraftTask` rows. One per workflow at most; the data model on
 * `initializeSchema` (`ShopAgentSchema.ts`) says so and the draft holds
 * tasks only. Nothing that creates runs ever reads the draft.
 */
export const WorkflowDraft = Schema.Struct({
  workflowId: WorkflowId,
  updatedAt: Schema.Number,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

/**
 * `teamId` is a live pointer to a D1 `Team`, not a snapshot: renaming a team
 * renames every task it owns, and a task can only be *applied* against a
 * team that exists. `null` is **unassigned** — what a team delete leaves
 * behind — and an id no D1 row carries reads the same way. It carries no
 * `teamName`: the name is joined at read time, and only the eventual
 * instance rows snapshot it. The pointer's rule is the data model on
 * `initializeSchema` (`ShopAgentSchema.ts`).
 *
 * Workflow tasks and draft tasks have the same shape but live in two tables
 * (`WorkflowTask`, `WorkflowDraftTask`; why, on the DDL). Only `applyDraft` writes `WorkflowTask`;
 * every editor write targets the draft. Apply carries draft task ids over to
 * the workflow; Edit copies workflow tasks into the draft under new ids.
 *
 * A workflow is a sequence of numbered steps. Each step holds one or more
 * tasks, and a task is the unit a team starts and marks done: it has a name, a
 * team, and instructions. Along `position` the `step` values are dense `1..m`
 * and non-decreasing (`1 1 2 3 3`), so every task belongs to exactly one step,
 * and a step of one task is the plain linear case. Step k is current when every
 * task of step k-1 is done. The invariant is owned by `WorkflowLayout`, which
 * recomputes the whole layout on every edit. The two nouns exist because
 * parallel work needs a wait that is not a task; the member and merchant UI
 * print "task" only when a step has more than one, so a linear shop reads
 * steps alone.
 */
export const WorkflowTask = Schema.Struct({
  id: WorkflowTaskId,
  workflowId: WorkflowId,
  position: Schema.Number,
  step: Schema.Number,
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  instructions: Schema.NullOr(TaskInstructions),
});
export type WorkflowTask = typeof WorkflowTask.Type;

export const WorkflowDraftTask = WorkflowTask;
export type WorkflowDraftTask = typeof WorkflowDraftTask.Type;

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

export const WorkflowDraftTasks = Schema.Struct({
  draft: WorkflowDraft,
  tasks: Schema.Array(WorkflowDraftTask),
});
export type WorkflowDraftTasks = typeof WorkflowDraftTasks.Type;

/** What `WorkflowRepository.getWorkflow` returns: the workflow with its tasks, and the draft with its tasks when one exists. */
export const WorkflowWithDraft = Schema.Struct({
  ...WorkflowDetail.fields,
  draft: Schema.NullOr(WorkflowDraftTasks),
});
export type WorkflowWithDraft = typeof WorkflowWithDraft.Type;

/**
 * A workflow task with its team's live name and headcount, as the merchant's
 * workflow page ({@link WorkflowPageData}) and the workflow editor
 * ({@link WorkflowDraftDetail}) render it. Both warning states are derived here against the live
 * teams and never stored: `teamName` is `null` when the task is unassigned
 * (`teamId` null, or an id no team carries) — a warning, not a block in the
 * editor; the task renders with an empty picker and everything else stays
 * editable. `memberCount` is the team's live headcount (`null` when
 * unassigned) so the page can warn "No members on <team>". `teams` rides
 * along so the team picker needs no second call.
 */
const TaskWithTeamName = Schema.Struct({
  ...WorkflowTask.fields,
  teamName: Schema.NullOr(TeamName),
  memberCount: Schema.NullOr(Schema.Number),
});
export type TaskWithTeamName = typeof TaskWithTeamName.Type;

/**
 * A draft with its tasks: the `*Detail` shape ({@link RunDetail} is a run and
 * its tasks). Not a screen of its own: it is nested in
 * {@link WorkflowPageData} and is what the workflow editor reads.
 */
export const WorkflowDraftDetail = Schema.Struct({
  draft: WorkflowDraft,
  tasks: Schema.Array(TaskWithTeamName),
});
export type WorkflowDraftDetail = typeof WorkflowDraftDetail.Type;

/**
 * Everything the merchant's workflow page renders, in one socket round trip:
 * the workflow (read-only, what creates runs) and the draft (what the editor
 * writes), each with its tasks. The suffix is `Data` for the reason on
 * {@link OrdersIndexData}.
 */
export const WorkflowPageData = Schema.Struct({
  workflow: Workflow,
  tasks: Schema.Array(TaskWithTeamName),
  draft: Schema.NullOr(WorkflowDraftDetail),
  teams: Schema.Array(TeamWithMemberCount),
});
export type WorkflowPageData = typeof WorkflowPageData.Type;

/** A task is unassigned when its team is null or resolves to no team; the name is the tell after the team join. */
export const workflowTaskIsUnassigned = (task: TaskWithTeamName) =>
  task.teamName === null;

/** Assigned to a team nobody is on: an issue, but Apply and Turn on allow it ({@link OrderIssue} says why). */
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
 * The copy's name and tag are the merchant's, prefilled by the Duplicate
 * dialog; the repository copies tasks and steps and leaves the copy off with
 * no draft ({@link WorkflowResult} carries the copy).
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

/**
 * `activatedAt` is honoured only with `on: true`: the Turn on dialog's
 * "Include them" sends the earliest waiting order's placed date so those
 * orders qualify; omitted, Turn on means now. Off always clears the date.
 */
export const SetWorkflowOnInput = Schema.Struct({
  workflowId: BoundedId,
  on: Schema.Boolean,
  activatedAt: Schema.optionalKey(Schema.Number),
});
export type SetWorkflowOnInput = typeof SetWorkflowOnInput.Type;

/**
 * The editor's Turn on for a workflow that has never been applied: one click
 * that promotes the draft and turns the switch on, so the merchant is not
 * asked to Apply tasks that have never run and then turn on the thing they
 * just applied. `activatedAt` means what it means on
 * {@link SetWorkflowOnInput}.
 */
export const ApplyAndTurnOnInput = Schema.Struct({
  workflowId: BoundedId,
  activatedAt: Schema.optionalKey(Schema.Number),
});
export type ApplyAndTurnOnInput = typeof ApplyAndTurnOnInput.Type;

/** The workflow page's Change control: moves the coverage date of an on workflow. */
export const SetWorkflowActivatedAtInput = Schema.Struct({
  workflowId: BoundedId,
  activatedAt: Schema.Number,
});
export type SetWorkflowActivatedAtInput =
  typeof SetWorkflowActivatedAtInput.Type;

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
 * `true` when the entry has tasks and every task is assigned; the
 * repository stores it as `activatedAt = now`, so seeded orders qualify.
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
  Schema.Struct({ _tag: Schema.Literal("Ok"), draft: WorkflowDraft }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DraftResult = typeof DraftResult.Type;

/**
 * `created` is how many runs the reconcile-all after the switch created. Turn
 * on creates runs on waiting orders; Turn **off** can create them too, because
 * removing one of two matching workflows resolves an ambiguity and the
 * survivor's runs are created — so the toast must read for both directions.
 */
export const SwitchResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    workflow: Workflow,
    created: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoTasks") }),
  Schema.Struct({
    _tag: Schema.Literal("TaskUnassigned"),
    taskNames: Schema.Array(TaskName),
  }),
]);
export type SwitchResult = typeof SwitchResult.Type;

/** `Off`: the workflow is not on, so there is no coverage date to move. */
export const ChangeActivatedAtResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    workflow: Workflow,
    created: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Off") }),
]);
export type ChangeActivatedAtResult = typeof ChangeActivatedAtResult.Type;

/**
 * What the Turn on dialog asks about: orders already stored, unfulfilled and
 * not cancelled, that would match the workflow if its date allowed them —
 * paid or not, because an unpaid one qualifies the day it pays.
 * `earliestProcessedAt` is what "Include them" sends as `activatedAt`.
 */
export const WaitingOrders = Schema.Struct({
  count: Schema.Number,
  earliestProcessedAt: Schema.NullOr(Schema.Number),
});
export type WaitingOrders = typeof WaitingOrders.Type;

export const CountWaitingOrdersInput = WorkflowIdInput;
export type CountWaitingOrdersInput = typeof CountWaitingOrdersInput.Type;

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

/**
 * What the team delete dialog states: every task the delete leaves
 * unassigned that someone will notice. Workflow and draft tasks are
 * configuration; `openRunTasks` are work in progress that will wait until
 * someone assigns a team. Done and closed tasks lose the pointer too but keep
 * showing their `teamName`, so they are not counted.
 */
export const TeamDeleteCounts = Schema.Struct({
  workflowTasks: Schema.Number,
  draftTasks: Schema.Number,
  openRunTasks: Schema.Number,
});
export type TeamDeleteCounts = typeof TeamDeleteCounts.Type;

/** One row per team that owns anything; a team absent from the list owns nothing. */
export const TeamTaskCounts = Schema.Struct({
  teamId: TeamId,
  ...TeamDeleteCounts.fields,
});
export type TeamTaskCounts = typeof TeamTaskCounts.Type;

/** A workflow that uses a team: a task of the workflow or of its draft points at it. The team pages' "Used by" lists. */
export const TeamWorkflow = Schema.Struct({
  workflowId: WorkflowId,
  workflowName: WorkflowName,
});
export type TeamWorkflow = typeof TeamWorkflow.Type;

/** {@link TeamWorkflow} for every team at once, keyed by team: the teams index's "Used by" column in one object read. */
export const TeamWorkflowByTeam = Schema.Struct({
  teamId: TeamId,
  ...TeamWorkflow.fields,
});
export type TeamWorkflowByTeam = typeof TeamWorkflowByTeam.Type;

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
  /** The task's run is not {@link runIsOpen}; see the {@link RunStatus} table. */
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
  /** After `advance`, Start what is ready so the workflows list shows "Started · <seed member>" on a teammate's list. */
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
 * its run as `item_removed`, and any other change resizes it
 * ({@link Run} `quantityChangedFrom`).
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
          quantity: Schema.Number,
          currentQuantity: Schema.optionalKey(Schema.Number),
          tags: Schema.Array(Schema.String),
          properties: Schema.optionalKey(Schema.Array(LineItemProperty)),
          /** This item's run alone; the order's own progress keys are ignored for it. */
          progress: Schema.optionalKey(SeedProgress),
          /**
           * A workflow to set on this item after reconcile, exactly as the
           * merchant's Choose / Change does (`setRun`):
           * resolves an ambiguous item, or attaches where no tag matched.
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
 * An order's lifecycle position, the production ladder: **Not started ·
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
 * The orders index's view row: one whole question about the list at a time,
 * chosen by pressing its button. The views are exclusive, so nothing crosses:
 *
 * - `null` is **Open**, {@link orderIsOpen}: not started, making and made,
 *   the three rungs Baton owns. It is the default because retention keeps a
 *   year of orders (`ShopLimits.orderRetentionDays` in Platform) and a merchant
 *   opening Orders is looking at the bench, not at the year.
 * - `"issues"` is an open order with at least one {@link orderIssues}
 *   element: what needs the merchant.
 * - The five positions are {@link orderPosition}.
 * - `"all"` is the whole history, cancelled included. With `"fulfilled"` and
 *   `"cancelled"` it is a view that reads closed orders, and the only one
 *   that reads both open and closed. It is not an `OrderPosition`: nothing
 *   derives it from an order.
 * - `"cancelled"` is a legal value with no button: a Shopify cancel is rare
 *   and final, and the order sits under All with its badge.
 *
 * One row, not a Status row of positions crossed with a row of issue
 * filters. Crossed, four of the nine cells could never be anything but zero
 * (a team gap and a block are only ever making), and Fulfilled had to hide
 * the issue row because no closed order carries an issue: a control that must disappear when a sibling is pressed
 * is not a sibling. The row has no label on purpose: "Status" promised one
 * axis, and the row holds scopes (Open, Issues, All) and positions side by
 * side, as the Shopify admin's own views do (All · Unfulfilled · Unpaid ·
 * Open · Archived).
 *
 * The word is view for the reasons on {@link WorkflowsListView}, the other
 * view row. The labels are {@link ORDERS_INDEX_VIEW_LABEL}.
 */
export const OrdersIndexView = Schema.Union([
  Schema.Literal("issues"),
  OrderPosition,
  Schema.Literal("all"),
]);
export type OrdersIndexView = typeof OrdersIndexView.Type;

/**
 * **An issue is an open order that will not move until the merchant acts**:
 * the orders index's Issues view and Issues column. The one definition is
 * {@link orderIssues}; the SQL predicates in `OrderRepository.listOrders`
 * restate each element and must move with it.
 *
 * | Issue             | Rule                                                                     | Remedy                              |
 * | ----------------- | ------------------------------------------------------------------------ | ----------------------------------- |
 * | `choose_workflow` | `ambiguousItems > 0` and the order can create runs ({@link orderCanCreateRuns}) | choose a workflow on the order page |
 * | `unassigned`      | {@link OrderRow} `unassigned`                                            | Assign team on the order page       |
 * | `empty_team`      | {@link OrderRow} `emptyTeam`                                             | add a member on the team page       |
 * | `blocked`         | `runs.blocked > 0`                                                       | the order page                      |
 *
 * **Each issue has one remedy: the action that fixes the fault the issue
 * names.** A Remedy cell never names two actions. An action that only routes
 * around the fault (Assign team on an `empty_team`) may still be offered on
 * the order page, but it is not the remedy. A label that covers two fixes
 * names neither: that is how Needs a team came to be shown for a team that
 * was assigned but had no members.
 *
 * **Every issue is critical, on every screen that shows it**
 * ({@link ORDER_ISSUE_TONE}). An issue is an order that will not move until
 * the merchant acts, which is what the critical tone says, so a warning among
 * issues would say "stuck, but not very", and no issue is that: an ambiguous
 * item has no run at all, and a task on a team with no members reaches
 * nobody, exactly as a task with no team does. The definition, not the tone,
 * keeps critical rare: it leaves out every order that is not stuck (an
 * unmatched item, an unpaid order, a cancelled run, below).
 *
 * **The tone is not whether Apply allows the fault.** Apply asks whether
 * the draft can fix it, and allows an empty team ({@link Workflow}); an issue
 * asks whether this order is stuck, and an order waiting on an empty team
 * is. A team with no members that no current task is on stops no order,
 * which is why the teams index's No members badge stays a warning.
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
 * page offers the workflow picker on the item.
 *
 * An unpaid order with an ambiguous item is not choosing: reconcile would not
 * create a run on it whichever workflow was chosen, so there is no decision
 * waiting yet. Unpaid is not an issue either: it is a Shopify fact the
 * Payment column already shows, not something the merchant fixes in Baton.
 *
 * An issue is only ever on an open order ({@link orderIsOpen}): a closed
 * order has no work left. Issues are independent of each other and of the
 * {@link OrderPosition}: one order can carry several, and an order being
 * made can be waiting on a choice for another item at the same time. No
 * Shopify change is an issue: a Shopify event closes or resizes a run and
 * waits on nobody ({@link RunStatus}). Blocked is the run-state word on
 * purpose: the issue is "a run on this order is blocked".
 *
 * The word is issue, not need or attention. Shopify's badge guidance pairs
 * the critical tone with "urgent issues needing action"; "need" is
 * verb-shaped and did not fit Blocked, which is a hold a person set rather
 * than a gap to fill; "attention" names what a badge does about a problem,
 * not the problem. The labels are {@link ORDER_ISSUE_LABEL}.
 */
export const OrderIssue = Schema.Literals([
  "choose_workflow",
  "unassigned",
  "empty_team",
  "blocked",
]);
export type OrderIssue = typeof OrderIssue.Type;

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
 * What the merchant types into the order-number field. Trimmed and capped
 * because it reaches SQL as a `like` pattern: an order name is `#` plus a
 * handful of digits, so anything past 32 characters is not a search anyone
 * can satisfy, and letting it through would only widen the scan. `#` alone
 * (or `##`) is refused too: {@link normaliseOrderSearch} would reduce it to
 * `#`, a prefix every order name shares, which matches the whole list and is
 * not a search either.
 */
export const OrderSearch = trimmedText("OrderSearch", 32).check(
  Schema.makeFilter(
    (q) => q.replace(/^#+/u, "").length > 0 || "an order number, not just #",
  ),
);
export type OrderSearch = typeof OrderSearch.Type;

/**
 * `1001`, `#1001`, ` #1001 ` all mean the order named `#1001`. Shopify writes
 * `ShopOrder.name` with the `#`, the merchant reads the number off the admin
 * and may or may not type it, so the one normalisation lives here and both the
 * SQL and the route's no-match text call it — text that said `1001` while
 * the query matched `#1001` would be two facts where there is one.
 */
export const normaliseOrderSearch = (q: string): string =>
  `#${q.trim().replace(/^#+/u, "")}`;

/**
 * `subscriberId` is what subscribes the calling connection to invalidations —
 * the `subscribe<Feature>` convention documented on `ShopAgent.subscribeOrders`.
 * A page that only reads is a page that never hears about a write: the Durable
 * Object publishes to subscribed connections only, and the `/app` socket is
 * shared, so a route that read without subscribing would go silent the moment
 * another route's unmount unsubscribed the connection.
 */
export const ListOrdersInput = Schema.Struct({
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 50 }),
  ),
  cursor: Schema.NullOr(OrdersCursor),
  /**
   * Order-number search, matched against `ShopOrder.name` after
   * {@link normaliseOrderSearch}: `null` is no search.
   *
   * **Search ignores the view and the team.** When `q` is not null the read
   * is over every stored order and `view` and `team` are not applied: the
   * number the merchant typed is the whole question, and a search crossed
   * with the view meant "no match under Made" sent them to All to type it
   * again. The counts ignore `q` in turn ({@link OrderCounts}).
   *
   * Always send the key, for the same reason as `team`.
   */
  q: Schema.NullOr(OrderSearch),
  /**
   * {@link OrdersIndexView}: `null` is Open, `"all"` is every order, and each
   * other view has a SQL form in `OrderRepository.listOrders` that restates
   * `orderPosition` or the union of `orderIssues`. Always send the key, for
   * the same reason as `team`.
   */
  view: Schema.NullOr(OrdersIndexView),
  /**
   * `null` is any team; an id keeps only orders waiting on that team
   * ({@link OrderRow} `waitingOn`, open orders only) — the workflows list's own
   * predicate for which tasks are current, not "owns a task somewhere in the run". The looser reading pulls in orders the team
   * done days ago and orders it will not touch for two more steps, so
   * the label carries the predicate.
   *
   * Always send the key. `subscribeOrders` parses with
   * `onExcessProperty: "error"`, and an omitted key is a different failure
   * than a null one.
   */
  team: Schema.NullOr(TeamId),
});
export type ListOrdersInput = typeof ListOrdersInput.Type;

export const SubscribeOrdersInput = Schema.Struct({
  ...ListOrdersInput.fields,
  subscriberId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SubscribeOrdersInput = typeof SubscribeOrdersInput.Type;

/**
 * Per-order position for the index table, aggregated from
 * `Run` rows in the same read. `open` counts {@link runIsOpen} runs, `done`
 * the done ones. Closed runs are not counted: nothing derives from their
 * number. A closed run still holds its item ({@link RunStatus}), which
 * {@link ambiguousItems} reads off the run rows, and an order whose only
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
   * The `empty_team` {@link OrderIssue}, derived at read time against the
   * live D1 teams and never stored: an open run has a current task
   * ({@link currentTasks}) on a team with no members. Current tasks
   * only, because a team on a later step may have members by the time that
   * step is reached. Remedy: add a member, which clears this with no further
   * write.
   */
  emptyTeam: Schema.Boolean,
  /**
   * Teams with a current task on an open run of this order, distinct, as ids:
   * "who is holding it", answered at the altitude the list grows with — a
   * shop has a handful of teams, while its runs are a cross product of line
   * items and matching workflows.
   *
   * **Only an open order waits on a team**: a fulfilled or cancelled
   * order's list is empty by the status rule, because reconcile closed every
   * open run on it and only open runs have current tasks ({@link currentTasks}).
   * This is the same line {@link OrderIssue} draws: issues are open-only too.
   *
   * An unassigned current task contributes nothing, and neither does a team
   * that no longer exists: both are `unassigned`, and rendering one fault
   * in two cells makes it look like two alarms. A blocked run contributes
   * nothing either: its team cannot move it, and `RunCounts.blocked` is its
   * alarm. A team that exists with no members does contribute: it is
   * `emptyTeam`, and the Waiting on cell names the team the merchant has to
   * add a member to. So an order being made with an empty list is exactly an
   * order whose every current task is unassigned, which is when the Needs a
   * team badge is showing.
   *
   * Ids, not names: the Durable Object has no team names. The route resolves
   * them through `OrdersIndexData.teams`, the teams the page was read against.
   */
  waitingOn: Schema.Array(TeamId),
  /**
   * How many of the order's items are **ambiguous**: two or more
   * `matchedWorkflowIds`, units still to make, and no run of any status.
   * Derived per read like {@link RunCounts}, never stored, so a Change
   * workflow that leaves an item with two matches and nothing on it reads as
   * ambiguous again without another reconcile. See {@link ambiguousItems} for the shared definition.
   */
  ambiguousItems: Schema.Number,
});
export type OrderRow = typeof OrderRow.Type;

/**
 * Production's reading of an order, from {@link orderIsCancelled} and
 * {@link orderIsFulfilled} in Orders: its {@link OrderPosition}, one for
 * every order.
 *
 * Cancelled wins over everything because Shopify's cancel is final;
 * `fulfilled` is checked next, before the run counts, so an order fulfilled
 * with no runs at all — every historical order the window sync pulls in —
 * reads as fulfilled (and one fulfilled with runs open cannot exist past the
 * next reconcile, which closes them). The open positions then follow the run
 * counts alone: no open and no done run is `not_started`, any open run is
 * `making`, only done runs is `made`. An order whose runs are all closed
 * reads not started, which is right, because nothing has started and the
 * items may take a new workflow from the picker. Whether that is an issue is
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
 * Production's reading of an order, from {@link orderIsOpen} and
 * {@link orderCanCreateRuns} in Orders: its {@link OrderIssue}s, in
 * `OrderIssue` order; `[]` for a closed order. The one definition: the orders index's
 * Issues column renders this result, and its Issues view is this result's
 * non-emptiness, restated in SQL in `OrderRepository.listOrders`.
 */
export const orderIssues = ({
  order,
  runs,
  unassigned,
  emptyTeam,
  ambiguousItems,
}: Pick<
  OrderRow,
  "order" | "runs" | "unassigned" | "emptyTeam" | "ambiguousItems"
>): readonly OrderIssue[] => {
  if (!orderIsOpen(order)) return [];
  const issue: Record<OrderIssue, boolean> = {
    choose_workflow: orderCanCreateRuns(order) && ambiguousItems > 0,
    unassigned,
    empty_team: emptyTeam,
    blocked: runs.blocked > 0,
  };
  return OrderIssue.literals.filter((literal) => issue[literal]);
};

/**
 * The `s-badge` and `s-banner` tone of every {@link OrderIssue}, on every
 * screen that shows one: the orders index's Issues badges and banner, the
 * workflows index's badges, the workflow page's banners. One tone for all,
 * for the reason on {@link OrderIssue}.
 */
export const ORDER_ISSUE_TONE = "critical";

/**
 * The index's per-order ambiguity count, recomputed from a detail page's line
 * items and runs so both pages share one definition — the SQL in
 * `OrderRepository.listOrders` restates it and must move with it.
 *
 * Any run counts, `done` and `closed` included: a `done` run means the item
 * was routed and done, and a closed run still holds its item
 * ({@link RunStatus}).
 */
export const ambiguousItems = (
  lineItems: readonly OrderLineItem[],
  runs: readonly Run[],
): number =>
  lineItems.filter(
    (lineItem) =>
      lineItem.matchedWorkflowIds.length >= 2 &&
      unitsToMake(lineItem) > 0 &&
      !runs.some((run) => run.lineItemId === lineItem.id),
  ).length;

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
 * The counts on the orders index's counted views ({@link OrdersIndexView}):
 * `open` is Open, `issues` is Issues, and the three positions are theirs.
 *
 * **A count is what pressing that view would show, given the team.** Counts
 * honour the team select and nothing else: not the search, because the
 * search ignores the views ({@link ListOrdersInput} `q`); not the pressed
 * view, because a view never narrows its own row. With one row of exclusive
 * views there is nothing for a count to cross with, so the numbers move only
 * when the team changes, which is what a merchant expects a team select to
 * do. `open` is the sum of the three positions.
 *
 * All are computed over open orders only. They are read through the partial
 * index over unfulfilled, uncancelled orders, so a count costs one row per
 * open order, not one per order ever stored. So Fulfilled and All carry no
 * count: on a shop with years of history that would be a full-table read on
 * every refresh of a subscribed page.
 *
 * Refreshes are bounded by the subscribed page's invalidation throttle,
 * `INVALIDATION_THROTTLE_MS` in `useSubscribedQuery` (2 s), not by anything
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

export const SubscribeOrderInput = Schema.Struct({
  ...GetOrderDetailInput.fields,
  /** Subscribes the connection to pushes; see `SubscribeOrdersInput`. */
  subscriberId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SubscribeOrderInput = typeof SubscribeOrderInput.Type;

/**
 * Everything the orders index renders, in one socket round trip.
 *
 * The suffix is `Data`, and the prefix is the Screens table's spec name, for
 * this and every struct that is what one screen reads ({@link OrderPageData},
 * {@link WorkflowPageData}, {@link WorkflowsListData}, {@link RunPageData}):
 * `Data` is TanStack's own word for what a screen reads (`loaderData`,
 * `useLoaderData`), and the old `View` suffix now means a view-row button
 * ({@link OrdersIndexView}, {@link WorkflowsListView}). The structs carry no
 * rule of their own, so a generic suffix is right and the screen name carries
 * the meaning.
 */
export const OrdersIndexData = Schema.Struct({
  page: OrdersPage,
  syncState: OrdersSyncStatus,
  /**
   * The shop's teams, read live from D1 the page was read against — the same list
   * `unassigned`, `emptyTeam` and `OrderRow.waitingOn` were derived from,
   * carried so the route can name the waiting-on ids and fill the team
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
 * member row on {@link D1_TABLES}; the same reason {@link viewOf} matches
 * a started task to its starter by email). The merchant has no email and is never "you" on a member
 * page.
 */
export const actorIsMember = (actor: ActorDisplay, email: Email) =>
  actor.role === "member" && actor.email === email;

export const MerchantConnectionState = Schema.Struct({
  role: Schema.Literal("merchant"),
  subscription: Schema.NullOr(Subscription),
});
export type MerchantConnectionState = typeof MerchantConnectionState.Type;

export const MemberConnectionState = Schema.Struct({
  role: Schema.Literal("member"),
  memberId: MemberId,
  memberEmail: Email,
  teamIds: Schema.Array(TeamId),
  subscription: Schema.NullOr(Subscription),
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
 * may pick any workflow for a closed item by hand, the closed one included;
 * that replaces the row with a fresh run copied from the definition
 * (`RunRepository.setRun`).
 *
 * **Shopify events never create a to-do.** A Shopify change is applied to the
 * run and waits on nobody: the order fulfilled or cancelled closes every open
 * run, a line at zero units closes its open run, and a quantity change
 * resizes an open run ({@link Run} `quantityChangedFrom`). There is
 * nothing to dismiss. A closed run keeps its tasks as the record of who did
 * what; only deleting the row (Change workflow, a manual attach over a
 * closed item, the order's retention delete) removes tasks.
 *
 * **Started by you, Started by others, Ready and Blocked hold open runs only.** Closed and done runs leave the
 * member's Started by you, Started by others, Ready and Blocked views, and stop counting on
 * the orders index, by this status and no other rule: the list reads select
 * `status = 'open'`. The fifth view, Done or closed, holds done tasks and closed
 * runs, a closed run with its reason ({@link RecentItem}).
 *
 * What each status allows. The gate column is the rule; the enforcing write
 * refuses with `RunTerminalError` when it fails. Which buttons a page shows
 * is {@link runActions} and {@link taskActions}, which read these same
 * predicates. `pnpm spec check` does not read this table: it names
 * the predicate per action, not a result per state, and the action matrices
 * pin each result it describes.
 *
 * | action                                                                  | gate                                                                            |
 * | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
 * | Start                                                                   | {@link runIsOpen}, task ready, not {@link runIsBlocked}                         |
 * | Done                                                                    | {@link runIsOpen}, task ready or started, not {@link runIsBlocked}              |
 * | note                                                                    | always (a note is a record)                                                     |
 * | Block, Unblock, edit reason                                             | {@link runIsOpen}; Unblock and edit reason only while {@link runIsBlocked}      |
 * | Put back                                                                | {@link runIsOpen}, task started, not blocked                                    |
 * | assign a task's team                                                    | {@link runIsOpen}, task open                                                    |
 * | Cancel (close, `merchant_cancelled`)                                    | {@link runIsOpen}, order open ({@link orderIsOpen})                             |
 * | Reopen a done task                                                      | {@link runIsOpen} or {@link runIsDone}, order open; see {@link reopenBlockedBy} |
 * | reconcile resizes                                                       | {@link runIsOpen}; badge only if a task has started ({@link runIsUnstarted})    |
 * | reconcile closes                                                        | {@link runIsOpen}                                                               |
 * | holds its item: one run per item (the data model on `initializeSchema`) | always, `done` and `closed` included                                            |
 * | replaced by a manual attach                                             | {@link runIsOpen} or {@link runIsClosed}; a `done` run is a record              |
 * | counts against the shop ceiling                                         | {@link runIsOpen}                                                               |
 *
 * A `done` run holds its item — a done item is not rerouted — but
 * is not open: done work does not count against
 * `ShopLimits.maxOpenRuns`, is never resized or closed by reconcile (it is
 * the record of what was made), and what is left on it is Reopen and a note.
 * A closed run holds its item too, so reconcile creates nothing on it: a
 * tag match must not undo a merchant's cancel or restart work Shopify ended
 * on the next webhook.
 */
export const RunStatus = Schema.Literals(["open", "done", "closed"]);
export type RunStatus = typeof RunStatus.Type;

/**
 * Why a run was closed ({@link RunStatus}). The reason is one line of copy,
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
 */
export const ClosedReason = Schema.Literals([
  "fulfilled",
  "order_cancelled",
  "item_removed",
  "merchant_cancelled",
]);
export type ClosedReason = typeof ClosedReason.Type;

/** Ended by something other than a person's Done on its last task; `closedReason` says what ({@link ClosedReason}). */
export const runIsClosed = (run: { readonly status: RunStatus }) =>
  run.status === "closed";

/**
 * Nobody has touched it: no task of the run started or done. Read from the
 * tasks, not the status, because an open run is `open` from the moment it
 * is created. Reconcile resizes such a run without the quantity badge
 * ({@link Run} `quantityChangedFrom`): nobody has cut anything to the old
 * number.
 */
export const runIsUnstarted = (
  tasks: readonly {
    readonly startedAt: number | null;
    readonly doneAt: number | null;
  }[],
) => tasks.every((task) => task.startedAt === null && task.doneAt === null);

/** Work can still be recorded: Start, Done, Block, team assignment, cancel. */
export const runIsOpen = (run: { readonly status: RunStatus }) =>
  run.status === "open";

/** The last task's Done: no work is recorded on it again unless Reopen reopens it. */
export const runIsDone = (run: { readonly status: RunStatus }) =>
  run.status === "done";

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
 * | rule                                                              | enforcer                                  |
 * | ----------------------------------------------------------------- | ----------------------------------------- |
 * | Start, Done and Put back are refused; Reopen and the note are not | `RunBlockedError`, {@link taskActions}     |
 * | Unblock and edit reason are offered; Block is not                 | {@link runActions}                         |
 * | a blocked run holds no team ("waiting on") and shows no Now line  | `OrderRepository.listOrders`, the order page |
 * | counted as `blocked`, open runs only                              | {@link runCounts}                          |
 * | the run's row is on the Blocked view                              | {@link viewOf}                             |
 *
 * Reopen is not stopped because it takes work back rather than doing more,
 * and a held run is the one somebody needs to write on.
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
 * incumbent in the same transaction ({@link RunStatus}).
 */
export const Run = Schema.Struct({
  id: RunId,
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  orderId: Schema.String,
  orderName: Schema.String,
  /**
   * `ShopOrder.processedAt` snapshotted at creation, like `orderName`: the
   * workflows list sorts every view oldest-order-first from the run rows alone,
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
  status: RunStatus,
  /** When the run was blocked; null is not blocked ({@link runIsBlocked}). */
  blockedAt: Schema.NullOr(Schema.Number),
  blockReason: Schema.NullOr(BlockReason),
  /**
   * Who blocked the run, role and email only. Snapshotted like the task
   * actors, so a deleted member still reads as who; an edit to the reason
   * leaves it alone.
   */
  blockedBy: Schema.NullOr(Schema.fromJsonString(ActorDisplay)),
  /**
   * The run's `quantity` before the last Shopify change, while nobody has
   * done a task since: the badge **Quantity changed · 3 → 2**.
   *
   * Reconcile writes the new units onto an open run. When a task has
   * started or is done (not {@link runIsUnstarted}) it also sets this to the
   * old quantity when it is null, so a second change keeps the original
   * "from": the maker cut to the first number, and that is the one they need
   * to hear about. An unstarted run is resized silently, since nobody has
   * worked to the old number, and a `done` run is never resized, because it
   * is the record of what was made.
   * `markTaskDone` on the run clears it: a Done after the change is
   * proof someone worked with the new number.
   *
   * Never a gate. No action reads it, because a quantity change is a notice,
   * not a stop: the new number is already on the run, and making the maker
   * acknowledge it would be a to-do created by a Shopify event
   * ({@link RunStatus}).
   */
  quantityChangedFrom: Schema.NullOr(Schema.Number),
  note: Schema.NullOr(RunNote),
  createdAt: Schema.Number,
  /**
   * Bumped by every run and task write. No screen reads it; its one reader is
   * the retention sweep (`OrderRepository.sweepExpiredOrders`), which ages an
   * orphaned run on it because the order the run belonged to, and its
   * `processedAt`, are gone. Kept for that reader alone.
   */
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
 * task keeps showing its `teamName`, which is all history reads. `startedByEmail` / `doneByEmail` / `reopenedByEmail` are
 * the snapshots taken at the action that keep history readable after the
 * member is deleted.
 *
 * Each of the three actors (`started*`, `done*`, `reopened*`) is a group of
 * columns with a `*ByRole` column, and that column is the discriminator: the
 * merchant leaves the email null (they have no `Member` row), a member fills
 * both. No actor has an id column: an actor is
 * displayed and matched by email ({@link actorIsMember}), never joined to
 * `Member`. Read them through
 * {@link taskStartedBy} / {@link taskDoneBy} / {@link taskReopenedBy}
 * rather than by hand, and see {@link ActorDisplay} for why the role is stored
 * rather than inferred from a null email.
 *
 * `reopened*` records the *last actor*, not a history: it records the most
 * recent reopen and the next `markTaskDone` clears it, so the line only shows
 * while the task is genuinely back open. A reopen also
 * clears every `started*` column, so a reopened task reads Ready. Put back
 * clears the `started*` columns and records no actor of its own: a put-back task is plain
 * Ready and the next Start writes a fresh record.
 *
 * A task is *current* by {@link currentTasks}; several tasks of one run can be
 * current at once. `startedAt` is set by Start (and backfilled by a Done without
 * Start); it and `doneAt` are what {@link runIsUnstarted} reads, since the
 * run's status is `open` from creation.
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
  reopenedAt: Schema.NullOr(Schema.Number),
  reopenedByRole: Schema.NullOr(ConnectionRole),
  reopenedByEmail: Schema.NullOr(Email),
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

/** The reopener, the most recent one only (see {@link RunTask}). */
export const taskReopenedBy = (
  task: Pick<RunTask, "reopenedByRole" | "reopenedByEmail">,
) => actorFrom(task.reopenedByRole, task.reopenedByEmail);

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
 * One current task the member may act on, cut to what a run's row renders.
 * `startedByEmail` is read off the row — the snapshot taken at Start, never a
 * live join — and it is load-bearing beyond display: {@link viewOf} decides
 * "Started by you" with it.
 *
 * Two groups of columns are omitted rather than carried as nulls. The three
 * `done*` ones can never say anything here: `currentWhere` requires `doneAt is
 * null` and a reopen clears all three, so on a list task
 * every one of them is null by construction. The rest — instructions and the
 * `reopened*` columns — say something, but only on the workflow
 * page: a row shows the task's name and one state clause, and everything
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
    "reopenedAt",
    "reopenedByRole",
    "reopenedByEmail",
  ]),
);
export type RunListTask = typeof RunListTask.Type;

/**
 * The run behind a row, cut the same way. `orderProcessedAt` and
 * `lineItemId` stay although nothing prints them: they are two thirds of
 * {@link byAge}, which is the order every view is in. `quantity` and
 * `quantityChangedFrom` stay because the row wears the quantity badge
 * ("Quantity changed · 3 → 2"), and the block columns stay because a blocked
 * row prints its reason and who. `workflowName` stays because the row
 * names the item's workflow, the noun both sides use for a run.
 *
 * What goes is everything only the workflow page reads — the order id, the
 * variant, the SKU, the timestamps, and `lineItemProperties`, which is the
 * one that matters: a JSON blob on every row of every read, parsed on
 * arrival, to render nothing. The run `note` stays:
 * the row prints it.
 */
export const RunListRun = Schema.Struct(
  Struct.omit(Run.fields, [
    "workflowId",
    "orderId",
    "variantTitle",
    "sku",
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
 * ({@link currentTasks}) that belongs to one of the member's teams. `stepCount` is the run's last step, for "Step k of n" ({@link runRowLine}).
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
 * Line two of a member's run row, in two parts so the row can swap the second
 * for a block or "Started · <who>" and keep the first. `names` is every current task
 * in `position` order, so a parallel step shows all of its tasks rather than
 * one name and a count. `step` is `Step k of n`, where k is the step the current
 * tasks share and n is {@link RunListItem}'s `stepCount`.
 *
 * The team is printed only where it tells the reader something. When the
 * listed tasks are on different teams each name carries its team in
 * parentheses and `step` carries none. When they share one team it follows
 * `step`, and only if `showTeam`: the row decides that from the member's team
 * count and filter.
 */
export const runRowLine = (
  { tasks, stepCount }: RunListItem,
  showTeam: boolean,
): { readonly names: string; readonly step: string } => {
  const [first] = tasks;
  const teams = new Set(tasks.map((task) => task.teamName));
  const names = tasks
    .map((task) =>
      teams.size > 1 ? `${task.name} (${task.teamName})` : task.name,
    )
    .join(" · ");
  const position = `Step ${String(first.step)} of ${String(stepCount)}`;
  return {
    names,
    step:
      showTeam && teams.size === 1
        ? `${position} · ${first.teamName}`
        : position,
  };
};

/**
 * The four views an open run's row can fall in: four of the five views of
 * the member's workflows list ({@link WorkflowsListView}). `done`
 * (Done or closed) is not one of them because it is a window over what left the lists
 * rather than a grouping of them. The labels the member reads are the
 * route's (`workflowsListViews.ts`); the object only needs the keys, because
 * it is the side that groups, sorts, and caps.
 */
export const RunView = Schema.Literals([
  "blocked",
  "mine",
  "teammates",
  "upNext",
]);
export type RunView = typeof RunView.Type;

/**
 * The five views of the member's workflows list, in view-row order: what I
 * have started, what someone else has started, what I can start, what a
 * person has blocked, and what left my lists lately. Four are the views of
 * {@link viewOf}, and hold open runs only ({@link RunStatus}); the blocked
 * view (Blocked) holds blocks and nothing else, since a Shopify change is
 * never a to-do. `done` is the Done or closed window ({@link RecentItem}); the key
 * keeps its old name, the label is the route's (`workflowsListViews.ts`). The
 * view is the unit of a read: one read returns every view's count and one
 * view's rows. {@link OrdersIndexView} is the other view row, on the orders
 * index.
 *
 * The word is view, not tab. It is Shopify's word for the same control on its
 * own index pages (the Orders page's menu is labelled "Select a view": one
 * whole question about the list at a time, beside filters that narrow it);
 * the Polaris web components have no tab component, so what is drawn is a
 * row of buttons, not tabs; and "tab" in this codebase means a browser tab
 * (one socket per tab), a meaning the socket reasoning needs.
 */
export const WorkflowsListView = Schema.Literals([
  "mine",
  "teammates",
  "upNext",
  "blocked",
  "done",
]);
export type WorkflowsListView = typeof WorkflowsListView.Type;
export const DEFAULT_WORKFLOWS_LIST_VIEW: WorkflowsListView = "mine";

/**
 * Which view a row belongs in: a block wins ({@link runIsBlocked}); else a
 * task the viewer started; else any started task; else up next. Every row
 * here is an open run already: closed and done runs never reach one of these
 * views.
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
 * rows by view now: one read counts every view and returns one of them, so the
 * grouping has to happen on the side that decides what leaves.
 */
export const viewOf = (
  { run, tasks }: RunListItem,
  memberEmail: Email,
): RunView => {
  if (runIsBlocked(run)) return "blocked";
  if (tasks.some((task) => task.startedByEmail === memberEmail)) return "mine";
  if (tasks.some((task) => task.startedAt !== null)) return "teammates";
  return "upNext";
};

/**
 * Within a view, oldest order first by `run.orderProcessedAt` (the snapshot
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
 * What stands between a done task and reopening it ({@link reopenBlockedBy}). Once
 * downstream has moved the fix is a conversation, so the page names who to
 * ask rather than offering a button that would pull work out from under them.
 */
export const ReopenBlocker = Schema.Struct({
  taskName: TaskName,
  teamName: TeamName,
});
export type ReopenBlocker = typeof ReopenBlocker.Type;

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
 * workflows list and the task guards, and leaves the run's status to its callers; this
 * is the one TypeScript copy, for the merchant's order page (which holds every task of
 * the order) and the dev seeder (which walks runs a step at a time), and the
 * test on it pins that the two agree.
 */
export const currentTasks = (
  run: { readonly status: RunStatus },
  tasks: readonly RunTask[],
): RunTask[] => {
  if (!runIsOpen(run)) return [];
  const lowest = lowestOpenStep(tasks);
  return tasks.filter((task) => task.doneAt === null && task.step === lowest);
};

const firstStarted = (tasks: readonly RunTask[]) =>
  tasks
    .filter((other) => other.startedAt !== null)
    .toSorted((a, b) => a.step - b.step || a.position - b.position)[0];

/**
 * The reopen rule, on rows already in hand: the first task in a later step of
 * the same run that anyone has started. A `startedAt` test covers done
 * tasks too, because Done backfills `startedAt`.
 *
 * Pure and here rather than in `RunRepository` so the three readers
 * cannot disagree: the repository's own write, the verdicts it precomputes for
 * the member pages, and the merchant's order page, which holds every task of
 * every run on the order and decides client-side whether to offer Reopen. A
 * browser cannot import the repository module — it carries the SQL service —
 * and a second copy of this rule is exactly the drift to avoid.
 */
export const reopenBlockedBy = (
  task: RunTask,
  runTasks: readonly RunTask[],
): ReopenBlocker | null => {
  const blocker = firstStarted(
    runTasks.filter(
      (other) => other.runId === task.runId && other.step > task.step,
    ),
  );
  return blocker === undefined
    ? null
    : { taskName: blocker.name, teamName: blocker.teamName };
};

/**
 * One entry of the member's Done or closed view: **what left my lists lately**, inside
 * {@link DONE_WINDOW_MS}, newest first. Two kinds:
 *
 * - `task`: a task one of the member's teams did, with its run for the
 *   card line and the reopen verdict precomputed by the object, which is the
 *   only side that can see the downstream tasks.
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
    reopenBlockedBy: Schema.NullOr(ReopenBlocker),
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
 * Provisional. The rows one view returns before it offers "Show more", and the
 * size of each "more". One number for every view: a member's own view (Started by you) is
 * the one they scroll least and the one that must fit, and at ~50 px a row 25
 * is under two phone screens. A proposal, not a tuned figure.
 */
export const RUN_PAGE = 25;
/** Provisional: the most rows one view may be expanded to in a single read. */
export const RUN_LIMIT_MAX = 100;

/**
 * How deep one read of a view goes, as the object accepts it: a whole number
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
 * to (`null` is every team on the connection), which view, and how many rows
 * of that view. `team` is validated against the connection's `teamIds` by the
 * object; a team the member is not on reads as an empty list, never as an
 * error. The screen resolves a URL's team against the teams before it gets
 * here (`shop.$shop.workflows.index.tsx`), so that empty list is reserved for a caller
 * that ignored the teams. The counts of every view come back regardless of
 * `view`, so the view row is always current.
 */
export const RunQuery = Schema.Struct({
  team: Schema.NullOr(TeamId),
  view: WorkflowsListView,
  limit: RunLimit,
});
export type RunQuery = typeof RunQuery.Type;

/**
 * Structural equality, for deciding whether the loader's rows may serve as
 * the socket query's `initialData`: the route rebuilds the value on every
 * press, and the loader's own query is built from the URL.
 */
export const sameRunQuery = (a: RunQuery, b: RunQuery) =>
  a.team === b.team && a.view === b.view && a.limit === b.limit;

export const RunListTeamCount = Schema.Struct({
  teamId: TeamId,
  count: Schema.Number,
});
export type RunListTeamCount = typeof RunListTeamCount.Type;

/**
 * The view row's counts. `mine`, `upNext`, `teammates`, `blocked` and `done`
 * are the counts of the five views **after** `query.team` narrows them, because they
 * describe the lists the member can switch to. `total` and `teamCounts` are
 * over every team on the connection regardless of `query.team`, so the team
 * select does not move under the finger.
 */
export const RunListCounts = Schema.Struct({
  mine: Schema.Number,
  upNext: Schema.Number,
  teammates: Schema.Number,
  blocked: Schema.Number,
  done: Schema.Number,
  total: Schema.Number,
  teamCounts: Schema.Array(RunListTeamCount),
});
export type RunListCounts = typeof RunListCounts.Type;

/**
 * Everything the member's workflows list renders, in one socket round trip:
 * every view's count and one view's rows. Exactly one of `items` and `recent`
 * is populated: `items` when `query.view` is a {@link RunView}, `recent` when it is
 * "done". The selected view's total is `counts[query.view]`. One value rather
 * than two reads so the loader and the socket paint the same snapshot and the
 * view row never disagrees with the list under it. The suffix is `Data` for
 * the reason on {@link OrdersIndexData}.
 */
export const WorkflowsListData = Schema.Struct({
  counts: RunListCounts,
  items: Schema.Array(RunListItem),
  recent: Schema.Array(RecentItem),
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
 * task, and `reopenBlockedBy` is the reopen verdict for a done one. Both are
 * facts about *other* rows (earlier and later steps of the run), which is
 * why the object computes them rather than the page.
 */
export const RunTaskRow = Schema.Struct({
  ...RunTask.fields,
  current: Schema.Boolean,
  reopenBlockedBy: Schema.NullOr(ReopenBlocker),
});
export type RunTaskRow = typeof RunTaskRow.Type;

/** What an actor may do to one run: the result of {@link runActions}, whose JSDoc holds the matrix. */
export const RunActions = Schema.Struct({
  note: Schema.Boolean,
  block: Schema.Boolean,
  editReason: Schema.Boolean,
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
 * The page renders a run-level button only when its field is true, and the
 * `ShopAgent` callable for that write computes the same object from the same
 * inputs and refuses with `NotAllowed` when the field is false, so a stale
 * tab or a second admin cannot write what the page would not offer. The
 * repository keeps its own guards underneath; they protect the write from
 * every caller, reconcile and tests included.
 *
 * The table is the rule. `test/integration/run-actions.test.ts` reads it
 * out of this comment and asserts every row, so a change starts at a cell
 * and the test names the cell until the formula follows. `pnpm lint`
 * refuses a malformed table.
 *
 * "M" is the merchant. "m" is a member whose team holds a current
 * task on the run ({@link currentTasks}, {@link taskIsOnTeams}), the team gate
 * `RunRepository` applies to Block, Edit reason and Unblock; for the
 * note it is a member who can see the run ({@link runIsVisibleTo}). Blank is
 * never. Each state column is one input; a row is one fixture, and a word
 * such as "closed" under `order` stands for every state it names. A done
 * run is never blocked (the data model on `initializeSchema`,
 * `ShopAgentSchema.ts`), so "any" under `blocked` beside "open or done"
 * names a block on the open run only.
 *
 * | order  | run          | blocked | units | note | block | editReason | unblock | cancel | changeWorkflow |
 * | ------ | ------------ | ------- | ----- | ---- | ----- | ---------- | ------- | ------ | -------------- |
 * | open   | open         | no      | some  | M m  | M m   |            |         | M      | M              |
 * | open   | open         | yes     | some  | M m  |       | M m        | M m     | M      | M              |
 * | open   | open         | no      | none  | M m  | M m   |            |         | M      |                |
 * | open   | done         | no      | some  | M m  |       |            |         |        |                |
 * | open   | closed       | no      | some  | M m  |       |            |         |        |                |
 * | closed | open or done | any     | some  | M m  |       |            |         |        |                |
 * | closed | closed       | no      | some  | M m  |       |            |         |        |                |
 *
 * Why a cell is blank where it might not be:
 *
 * - `note` is never blank: a note is a record, not work.
 * - `block` is blank on a blocked run: it is already held, and a second
 *   Block would overwrite who held it. On a done or closed run there is no
 *   work left to hold.
 * - `editReason` and `unblock` need {@link runIsBlocked}. Closing a run
 *   clears its block, so a closed run is never blocked. A blocked run on a
 *   closed order is one reconcile has not yet closed; the order's close
 *   ends the work, and the block goes with it.
 * - `cancel` is blank on a done run: it is a record, reopened rather than
 *   cancelled. A closed run is over already. On a closed order reconcile
 *   has already closed every open run; there is nothing to cancel.
 * - `changeWorkflow` needs units to make ({@link unitsToMake}): a new run
 *   on an item Shopify removed or refunded to zero would be a run with no
 *   work behind it, and reconcile would close it as `item_removed` on its
 *   next pass. A done run is a record ({@link RunStatus}). A closed item
 *   takes a new workflow from its picker instead ({@link lineItemState}).
 *   Reading it needs the item, which only the merchant's callers
 *   hold, so `item` is optional and its absence answers false: member
 *   pages never offer Change workflow.
 * - There is no member `cancel` or `changeWorkflow`: those are the
 *   merchant's decisions about what the shop makes.
 */
export const runActions = (
  actor: Actor,
  order: OrderState,
  run: { readonly status: RunStatus; readonly blockedAt: number | null },
  tasks: readonly {
    readonly teamId: string | null;
    readonly current: boolean;
  }[],
  item?: Pick<OrderLineItem, "currentQuantity">,
): RunActions => {
  const merchant = actor.role === "merchant";
  const working = orderIsOpen(order) && runIsOpen(run);
  const holds = holdsCurrentTask(actor, tasks);
  const held = working && runIsBlocked(run) && holds;
  return {
    note: merchant || runIsVisibleTo(tasks, actor.teamIds ?? []),
    block: working && !runIsBlocked(run) && holds,
    editReason: held,
    unblock: held,
    cancel: merchant && working,
    changeWorkflow:
      merchant && working && item !== undefined && unitsToMake(item) > 0,
  };
};

/**
 * What an actor may do to one task: the result of {@link taskActions}, whose JSDoc holds the matrix.
 */
export const TaskActions = Schema.Struct({
  start: Schema.Boolean,
  done: Schema.Boolean,
  putBack: Schema.Boolean,
  /** `null` when Reopen is not offered; otherwise the blocker, `null` meaning the button. */
  reopen: Schema.NullOr(
    Schema.Struct({ blockedBy: Schema.NullOr(ReopenBlocker) }),
  ),
  assign: Schema.Boolean,
});
export type TaskActions = typeof TaskActions.Type;

/**
 * What an actor may do to one task, by the same contract as
 * {@link runActions}: the page draws a button only when its field is true,
 * the `ShopAgent` callable refuses with `NotAllowed` when it is false, and
 * the test reads this table. "M" is the merchant, "m" a member whose team
 * the task is on ({@link taskIsOnTeams}).
 *
 * | order  | run          | blocked | task     | downstream | start | done | putBack | reopen  | assign |
 * | ------ | ------------ | ------- | -------- | ---------- | ----- | ---- | ------- | ------- | ------ |
 * | open   | open         | no      | ready    | -          | m     | M m  |         |         | M      |
 * | open   | open         | no      | started  | -          |       | M m  | M m     |         | M      |
 * | open   | open         | no      | waiting  | -          |       |      |         |         | M      |
 * | open   | open         | yes     | any open | -          |       |      |         |         | M      |
 * | open   | open or done | any     | done     | none       |       |      |         | M m     |        |
 * | open   | open or done | any     | done     | started    |       |      |         | blocker |        |
 * | open   | closed       | no      | any      | -          |       |      |         |         |        |
 * | closed | open or done | any     | any      | -          |       |      |         |         |        |
 *
 * `blocker` under `reopen` is the button with a sentence: the started
 * downstream task ({@link reopenBlockedBy}) is carried so the merchant page
 * can say what stands in the way.
 *
 * - `start` is member only. "Started" records that a worker picked the task
 *   up, and a merchant marking it started on their behalf would put a name
 *   on work nobody has begun.
 * - `done` and `putBack` stop under a block: a block means stop
 *   ({@link runIsBlocked}). Put back goes to the whole team, not only the
 *   starter (`RunRepository.putBackTask`).
 * - `reopen` is offered under a block because it takes work back rather
 *   than doing more, and on a done run because reopening its last task is
 *   the point. Not on a closed run: closed is final ({@link RunStatus}),
 *   and reopening a task would put work back on a run that can never be done.
 * - `assign` is blank on a done task: it keeps the team that did it
 *   (`TaskDoneError`). One verb for a task with no team and for moving
 *   one that has a team.
 * - Everything is blank on a closed order ({@link orderIsOpen}) and a
 *   closed run: Shopify, or the merchant, says the work is over.
 *
 * **The verbs a task offers are the same on the workflows list and the
 * workflow page, and neither screen styles one as primary.** Primary and
 * secondary are a page's hierarchy, held in `s-page`'s action slots; a task has neither.
 * Polaris allows one primary per card and per page
 * (`refs/shopify-docs/docs/apps/design/layout.md`, "Cards that offer
 * interactivity"), and a step with two current tasks would draw two.
 *
 * When reopen is blocked, the merchant sees which task is in the way,
 * because the merchant can reopen or put back that task. A member sees
 * no Reopen button and no explanation: they cannot change the other
 * task, and it is already on their screen marked started.
 */
export const taskActions = (
  actor: Actor,
  order: OrderState,
  run: { readonly status: RunStatus; readonly blockedAt: number | null },
  task: Pick<
    RunTaskRow,
    "teamId" | "current" | "startedAt" | "doneAt" | "reopenBlockedBy"
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
      mine && !runIsClosed(run) && task.doneAt !== null
        ? { blockedBy: task.reopenBlockedBy }
        : null,
    assign: merchant && orderOpen && runIsOpen(run) && task.doneAt === null,
  };
};

/**
 * What one item's card is, as the order page switches on it: one kind
 * per layout.
 *
 * - `open` and `done`: the item has a run, open or `done`. Checked first,
 *   so an item whose units dropped to zero under a `done` run still shows
 *   the work that was done.
 * - `closed`: the item's run is {@link runIsClosed}. The run card shows with
 *   its tasks as the record, one line gives the reason and when, and the
 *   picker offers every workflow, the closed one included, as a fresh run.
 *   One kind for every reason: the reason is a line of copy
 *   ({@link ClosedReason}), not a layout. `attachable` is false when the item
 *   has nothing left to make ({@link unitsToMake}): no workflow creates a run there,
 *   the same rule as `changeWorkflow` on {@link runActions}, and the line
 *   stands alone.
 * - `removed`: no run, and `currentQuantity` is zero. Nothing to do.
 * - `attachable`: no run, and at least one workflow that is on, with tasks, can be
 *   attached. `options` lists the matched workflows first, then the rest;
 *   `ambiguous` is {@link ambiguousItems}' test for this one item, and the
 *   page says why it is asking.
 * - `unmatched`: no run and no workflow to offer.
 *
 * A block is not a kind: it adds a banner, not a different card. A closed
 * order is not a kind either: the kinds are the same under it, every field
 * of {@link runActions} and {@link taskActions} that does work is false, and
 * the sidebar's Fulfillment and Cancelled lines say why. The one control
 * outside those sets, the picker at rest, is the page's to hide with
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
    options: Schema.Array(Workflow),
    matched: Schema.Array(WorkflowId),
    ambiguous: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("closed"),
    run: Run,
    tasks: Schema.Array(RunTaskRow),
    options: Schema.Array(Workflow),
    matched: Schema.Array(WorkflowId),
    attachable: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("open"),
    run: Run,
    tasks: Schema.Array(RunTaskRow),
  }),
  Schema.Struct({
    kind: Schema.Literal("done"),
    run: Run,
    tasks: Schema.Array(RunTaskRow),
  }),
]);
export type LineItemState = typeof LineItemState.Type;

/** A run's tasks as {@link RunTaskRow}s, from the rows alone: the `current` flag by {@link currentTasks}, the reopen verdict by {@link reopenBlockedBy}. */
export const runTaskRows = (
  run: { readonly status: RunStatus },
  tasks: readonly RunTask[],
): RunTaskRow[] => {
  const current = new Set(currentTasks(run, tasks).map((task) => task.id));
  return tasks.map((task) => ({
    ...task,
    current: current.has(task.id),
    reopenBlockedBy: task.doneAt === null ? null : reopenBlockedBy(task, tasks),
  }));
};

/**
 * Production's reading of an order's item, from {@link OrderLineItem} and
 * {@link unitsToMake} in Orders: its card on the order page, one of the
 * {@link LineItemState} kinds.
 */
export const lineItemState = (
  item: OrderLineItem,
  runs: readonly RunDetail[],
  workflows: readonly Workflow[],
): LineItemState => {
  const detail = runs.find(({ run }) => run.lineItemId === item.id);
  const matched = workflows.filter((workflow) =>
    item.matchedWorkflowIds.includes(workflow.id),
  );
  const options = [
    ...matched,
    ...workflows.filter((workflow) => !matched.includes(workflow)),
  ];
  return Match.value({ detail, removed: item.currentQuantity === 0 }).pipe(
    Match.withReturnType<LineItemState>(),
    Match.when({ detail: Match.defined }, ({ detail: { run, tasks } }) =>
      runIsClosed(run)
        ? {
            kind: "closed",
            run,
            tasks: runTaskRows(run, tasks),
            options,
            matched: matched.map((workflow) => workflow.id),
            attachable: unitsToMake(item) > 0,
          }
        : {
            kind: runIsOpen(run) ? "open" : "done",
            run,
            tasks: runTaskRows(run, tasks),
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
      ambiguous: item.matchedWorkflowIds.length >= 2 && unitsToMake(item) > 0,
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
   * Workflows that are on, with at least one task — the manual-attach picker's
   * choices. Carried in the page's data rather than read by a second socket query so
   * the page has exactly one read, one key, and one push.
   */
  itemWorkflows: Schema.Array(Workflow),
  /** The shop's live teams: the "Assign team" picker's choices, and what decides which open tasks are unassigned or on an empty team. */
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
 * The socket half of the member workflows list's read: the same rows `listRuns`
 * returns, plus a subscription registered on the connection in the same round
 * trip. `teamIds` and `memberEmail` are absent on purpose — the list is
 * scoped by the membership on the connection, which the member cannot name
 * for themselves. `query` is theirs to name: it chooses among their own teams,
 * which view, and how far that view is expanded, and the object bounds all three.
 */
export const SubscribeRunsInput = Schema.Struct({
  ...SubscriberIdInput.fields,
  query: RunQuery,
});
export type SubscribeRunsInput = typeof SubscribeRunsInput.Type;

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

/** The socket twin of {@link GetRunForMemberInput}; `teamIds` comes off the connection. */
export const SubscribeRunInput = Schema.Struct({
  ...SubscriberIdInput.fields,
  runId: BoundedId,
});
export type SubscribeRunInput = typeof SubscribeRunInput.Type;

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
 * Rewrites the reason on a run that is *already* blocked; `reason: null`
 * clears the text and keeps the hold. Separate from {@link BlockRunInput}
 * because blocking and correcting what the block says are different acts: a
 * block records who and when, and an edit must not restate either — the
 * mistake this exists for ("typo", "I wrote the wrong thing") is not a new
 * hold by a new person.
 */
export const SetBlockReasonInput = Schema.Struct({
  runId: BoundedId,
  reason: Schema.NullOr(BlockReason),
});
export type SetBlockReasonInput = typeof SetBlockReasonInput.Type;

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
 * entirely. Every other rule — step order, terminal runs, the downstream
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
 * free-text field on a run follows this rule ({@link SetBlockReasonCommand}).
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
 * No `actor`, by the rule on {@link SetRunNoteCommand}. `blockedBy` stays
 * whoever set the hold.
 */
export interface SetBlockReasonCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: BlockReason | null;
}

/** The actor lands in the task's `reopened*` columns: a reopen is a fact worth showing, and the next Done clears it. */
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
  /** The shop is at `ShopLimits.maxOpenRuns`; the attach created nothing. */
  Schema.Struct({ _tag: Schema.Literal("RunLimit"), limit: Schema.Number }),
  /** The item's run is `done`; done work is not replaced. Names it. */
  Schema.Struct({
    _tag: Schema.Literal("ItemDone"),
    workflowName: WorkflowName,
  }),
  /** The order is cancelled or fully fulfilled, so there is nothing to attach work to ({@link orderIsOpen}). */
  Schema.Struct({ _tag: Schema.Literal("OrderClosed") }),
  /** The item has no units to make ({@link unitsToMake}): removed or refunded to zero in Shopify. */
  Schema.Struct({ _tag: Schema.Literal("NothingToMake") }),
]);
export type AttachResult = typeof AttachResult.Type;

/**
 * `NotAllowed` = the caller's action set refuses the write
 * ({@link runActions}, {@link taskActions}), or the task's team is not among
 * the caller's; `NotReady` = the task is not current ({@link currentTasks}) or is
 * already done (for reopen, not yet done; for put back, not yet started or
 * already done); `Terminal` = the run's status refuses this write, done
 * where it needs an open run, see the table on {@link RunStatus};
 * `ReopenBlocked` = someone downstream
 * has started, and names them ({@link ReopenBlocker}).
 *
 * `NotBlocked` = a write that only a standing block admits (rewriting its
 * reason) found no block. Separate from `NotAllowed` because the cause is a
 * race, not a permission: the hold was lifted while the editor was open, and
 * "this belongs to another team" would send the reader after the wrong thing.
 *
 * A write on a {@link runIsClosed} run other than the note answers
 * `NotAllowed`: every such field of {@link runActions} and
 * {@link taskActions} is false on it.
 */
export const RunResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NotAllowed") }),
  Schema.Struct({ _tag: Schema.Literal("NotBlocked") }),
  Schema.Struct({ _tag: Schema.Literal("NotReady") }),
  Schema.Struct({ _tag: Schema.Literal("Terminal") }),
  /** Start, Done or Put back on a blocked run ({@link runIsBlocked}). */
  Schema.Struct({ _tag: Schema.Literal("Blocked") }),
  Schema.Struct({
    _tag: Schema.Literal("ReopenBlocked"),
    ...ReopenBlocker.fields,
  }),
]);
export type RunResult = typeof RunResult.Type;

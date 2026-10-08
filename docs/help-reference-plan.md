# Plan: the Reference help pages

The next row on the roadmap in `docs/help-research.md`, written 2026-10-08 after e3edc2b. Four page
bodies under the Reference section (the hub stays as the skeleton renders it), no pictures, one
new part, and the check decision 14 asked for. Run the way `docs/help-orders-plan.md` was: two
builders split by file, then the orchestrator's pass and review.

The plan was not reviewed before implementation; its decisions are at the end, and the review
comes after, on the Deviations section.

## Before you start

- Read `docs/help-research.md`: "Page anatomy, by type" (the reference row: one `s-table` per
  table, headings the vocabulary's), "Tone and naming rules for help", "Decisions" (14: reference
  pages held to the vocabulary; Limits reads the constants), "How a content cycle runs". Read
  `docs/help-orders-plan.md` "Phase 2" and its Deviations for the bodies' shape and what a builder
  records.
- The pre-build, already in the checkout (done by the orchestrator, 2026-10-08): the part
  `HelpTable` in `src/components/screen/HelpTable.tsx` (`columns: readonly string[]`, `rows:
readonly (readonly React.ReactNode[])[]`; first column `listSlot="primary"`, the rest
  `labeled`), its row in the parts table and its `ScreenPart` literal (`src/lib/Screen.ts`), its
  kit entry ("Help table" on `/dev/kit`), four stub bodies under `src/components/help/reference/`
  registered in `HELP_BODIES` as `reference/<slug>`. Typecheck and lint pass on it.
- The vocabulary and its label constants, all in `src/lib/domain/ShopWork.ts`: `TASK_STATE_LABEL`,
  `RUN_STATE_LABEL`, `RUN_UNSTARTED_LABEL`, `WORKFLOW_STATE_LABEL`, `ORDER_POSITION_LABEL`,
  `ORDER_ISSUE_LABEL`, `WORKFLOW_FAULT_LABEL`, `ORDERS_SHOW_LABEL`, `VERB_LABEL`,
  `RECORD_VERB_LABEL`, `SWITCH_TITLE_LABEL`, the `ClosedReason` table (the merchant's card line
  and the member's Done or closed line), the `runActions` and `taskActions` matrices with their
  bullets, and the vocabulary tables' meaning columns. Also `STATE_LABEL` in
  `src/lib/workflowsListStates.ts` (the member list's five values) and the badge tones:
  `ORDER_ISSUE_TONE`, `BADGE_TONE` in `src/components/RunSteps.tsx`, `positionBadge` in
  `src/routes/app.orders.index.tsx`, `RUN_STATE_BADGE` and `NOT_STARTED_BADGE` in
  `src/routes/app.orders.$orderId.tsx`, `stateBadges` in `src/routes/app.workflows.index.tsx`, the
  Paid and Unpaid payment badges, Removed, Draft, No steps, No members, No teams.
- The limits: `NAME_MAX_LENGTH` (64), `TEAM_NAME_MAX_LENGTH` (32), `TAG_MAX_LENGTH` (255),
  `TASK_INSTRUCTIONS_MAX_LENGTH` (500), `RUN_NOTE_MAX_LENGTH` (2000), `BLOCK_REASON_MAX_LENGTH`
  (1000), `DONE_WINDOW_MS` (a day) in `ShopWork.ts`; `EMAIL_MAX_LENGTH` (254), `WorkflowLimits`
  (`maxWorkflows` 1000, `maxTasks` 20), `ShopLimits` (`maxTeams` 50, `maxMembers` 12,
  `maxOpenOrders` 2500, `maxLineItemsPerOrder` 250, `orderRetentionDays` 365) in
  `src/lib/domain/Platform.ts`; `ORDER_SYNC_WINDOW_DAYS` (30) in `src/lib/orderSyncConstants.ts`.
  What the screens say at each: `TextLimit` ("Up to N characters", "N characters left"),
  `EMAIL_TOO_LONG`, `MEMBER_CEILING` in `app.members.index.tsx`, the teams and workflows
  "A shop can have N …. Delete one to add another.", the editor's "A workflow can have N tasks.",
  `QuotaBanners` ("New orders stopped syncing at 2,500 open orders. …").
- Billing: the vocabulary on `src/lib/domain/Billing.ts`, `Entitlements` (no number is printed in
  help: the JSDoc on `src/components/help/getting-started/installing.tsx` says why), `ShopUsage`
  and its triggers table, `seatEventValue`, `AppSubscription` (a plan change is a new app
  subscription, meters at zero; trial usage is not reported), `PlanStatus` (a change applies at
  once), `openOrdersAtCeiling`, `membersAtCeiling`; the home page `src/routes/app.index.tsx` (the
  Orders this billing cycle and Members tiles and their sentences, Manage plan); the lapsed page
  `src/routes/shop.$shop_.lapsed.tsx`.
- The bodies that already link to these pages, and whose sentences the reference must agree with:
  `orders/orders-list.tsx` (States and badges), `orders/order-page.tsx` (Who can do what),
  `workflows/creating.tsx`, `workflows/editing.tsx`, `teams-and-members/creating-a-team.tsx`,
  `teams-and-members/adding-a-member.tsx`, `orders/syncing.tsx` (Limits),
  `orders/attaching-a-workflow.tsx`, `getting-started/installing.tsx` (Plans and billing),
  `members/recording-your-work.tsx` and `members/blocking.tsx` (the member's verbs and their
  conditions).
- The tests: `test/integration/help-pages.test.ts` (renders every body with
  `renderToStaticMarkup`; the retired words on titles and descriptions), `e2e/help.public.spec.ts`
  (walks `HELP_BODIES`; a body needs one `s-section` with a `heading`).
- The copy rules: the tone list on `CopySlot` in `src/lib/Screen.ts`; `scripts/lib/rules-lint.ts`
  reads `src/components/help/` and refuses "run", "in progress", "billing period", "finish",
  "tab", "view", "staff", "import", "please", a semicolon joining two ideas. "Seat" is a code word
  (its screen word is "members"); the page says "members".

## The shape of a reference page

A reference page is a lead (the tree's description, rendered by the route), then one `s-section`
per table with the table's name as its heading, a sentence or two of `s-paragraph` where a table
needs a frame, and a `HelpTable`. The first column is the word as the screen prints it, in
`<strong>` when it is a badge or a button, plain when it is a word the screen says in a sentence.
A cell is one or two sentences, in the vocabulary's screen words, never the code word (no "run",
no "unassigned", no "seat"). A number appears only on Limits. A plan's name, price, included count
or trial length appears nowhere (the home page's rule).

**Held to the code, not copied from it.** The first column of every table on States and badges and
Who can do what is read from the label constant (`Domain.ORDER_POSITION_LABEL.making`, not the
string "Making"), through a data module whose row sets are `satisfies Record<State, …>`, so a state
without a row or a row without a state is a type error, and a label change on the vocabulary row
reaches the page with no edit. Limits reads each number from its constant through `formatNumber`
(`src/lib/format.ts` or wherever the screens' formatter is; find it) so "2,500" prints as the banner
prints it. That is decision 14's rule: typecheck holds the sets and `pnpm spec check`'s existing
screen-column rule holds the labels, which is stronger than a text rule could be. See decision 3.

## Phase 1: States and badges, Who can do what (builder A)

Owns `src/lib/helpReference.ts` (new), `src/components/help/reference/states-and-badges.tsx`,
`src/components/help/reference/who-can-do-what.tsx`, `test/integration/help-reference.test.ts`
(new). Touches nothing else; a change it cannot avoid elsewhere is recorded in Deviations.

### `src/lib/helpReference.ts`

The reference pages' data: for each table, the rows keyed by the state or verb literal, each row's
help meaning, read beside the label constant. Shape, to be refined by the builder:

```ts
export const ORDER_POSITION_ROWS = {
  unpaid: { where: "…", meaning: "…" },
  …
} as const satisfies Record<Domain.OrderPosition, { readonly where: string; readonly meaning: string }>;
```

A table's rows render as `Object.entries(LABEL).map(([key, label]) => [<strong>{label}</strong>,
ROWS[key].where, ROWS[key].meaning])`, in the constant's order, which is the vocabulary's. Where a
constant's value is `null` ("(none)": waiting, the merchant's Start) the row is left out or the
cell reads what the screen shows instead; say which in the JSDoc. Meanings are screen copy (the
retired-word lint does not read `src/lib/`; the test below holds them, as `help-pages.test.ts`
holds the tree's copy).

### States and badges

Lead: the tree's. Sections, each a table, in the order a merchant meets them:

1. **An order's position** (`ORDER_POSITION_LABEL`): columns Badge | Where | Meaning. Where: the
   Orders page's Status column and its Show select, the strip for the four it has cells for.
   Meanings from the positions table, in screen words: Unpaid (open, no workflow on any item, not
   fully paid), No workflow (open, fully paid, no workflow on any item, which includes an item
   whose workflow was cancelled or removed), Not started (an item's workflow is attached and no
   task is started), Making (a task started or an item's workflow done, with work left), Made
   (every item's workflow done), Fulfilled and Cancelled (Shopify's).
2. **An order's issues** (`ORDER_ISSUE_LABEL`): Badge | Where | Meaning | What clears it. Red on
   the Orders page's Issues column, and under Issues in the strip. One row each; the clearing
   column from the remedy table on `OrderIssue` and `orders/fixing-issues.tsx`.
3. **An item's workflow** (the order page's badges): Not started (`RUN_UNSTARTED_LABEL`), Making,
   Done, Closed (`RUN_STATE_LABEL`), Blocked beside any of them, and Removed. Closed's row lists
   the four reasons as the card prints them (`ClosedReason`, merchant's column). Columns Badge |
   Meaning. The member's screens print the same facts differently: Done or closed as a list
   value, and the closed line with the member's wording; say so in a sentence under the table or
   as a fourth column, builder's choice, recorded.
4. **A task** (`TASK_STATE_LABEL`): Ready, Started, Done, with a sentence that a task on a later
   step has no badge until its step is current (waiting is "(none)"). Where: the order page's
   Manage drawer and the member's workflow page.
5. **A workflow** (`WORKFLOW_STATE_LABEL`, `WORKFLOW_FAULT_LABEL`, No steps, Draft): Active,
   Inactive, Needs a team, Team has no members, No steps, Draft. Where: the Workflows page and the
   workflow page. Team has no members also appears as No members on a step and on the Teams page;
   No teams on the Members page. One table or two, builder's choice.
6. **The member's Workflows list** (`STATE_LABEL` in `workflowsListStates.ts`): Started by you,
   Started by others, Ready, Blocked, Done or closed, with what each holds (from its JSDoc and
   `members/finding-your-work.tsx`). These are filter values, not badges: the section heading says
   "The Workflows list's filters" or similar, never "tabs".

No colour column. A cell names a colour only where another body already does ("a red badge").

### Who can do what

Lead: the tree's. Sections:

1. **Work on an item** (`VERB_LABEL`): columns What | Member | Merchant | When. Member and Merchant
   cells are the labels, empty where the constant is `null`. The When cell is the condition from
   `taskActions` and `runActions` in screen words: Start, on a ready task on your team; Done, on a
   ready or started task, not while blocked; Put back, a started task, anyone on its team, not
   while blocked; Undo / Reopen, a done task while no later step has started, anyone on the team;
   Assign team, any task not done, blocked or not; Edit note, anyone with a task on the item, and
   the merchant; Block and Unblock, the current task's team or the merchant, an open item only;
   Cancel workflow, an open item; Attach, an item with no workflow and units to make; Change
   workflow, an item with units to make, whatever state its workflow is in.
2. **Workflows, teams and members** (`VERB_LABEL`'s four workflow verbs and `RECORD_VERB_LABEL`):
   merchant only. Columns What | Merchant | Does. Apply changes, Discard changes, Turn on, Turn
   off, Create, Delete, Add, Remove, Rename, Edit, Duplicate, with the vocabulary's "for" column
   in screen words.
3. **What a member sees**: a short paragraph, no table: a member sees an item only while one of
   their teams has a task on it, and the note with it; the merchant sees everything. A member on
   no team sees an empty list.

The page agrees with `members/recording-your-work.tsx` and `members/blocking.tsx` sentence for
sentence where they overlap; where the matrix and a body disagree, the matrix wins and Deviations
records it.

### `test/integration/help-reference.test.ts`

- "every label constant is on its reference page": render `StatesAndBadges` and `WhoCanDoWhat` with
  `renderToStaticMarkup`, assert every non-null value of each constant the page claims appears in
  the markup (positions, issues, run states, the unstarted label, task states, workflow states,
  faults, verbs' member and merchant labels, record verbs, the member list's `STATE_LABEL`).
- "the reference copy is free of the retired words": every string in `helpReference.ts`'s rows
  against `RETIRED` (the unanchored patterns, as `help-pages.test.ts` does for titles).
- Both read the data module and the constants, so a new state fails the test before anyone
  writes its row.

## Phase 2: Limits, Plans and billing (builder B)

Owns `src/components/help/reference/limits.tsx`,
`src/components/help/reference/plans-and-billing.tsx`, `src/lib/helpPages.ts` (one description),
`test/integration/help-limits.test.ts` (new). Touches nothing else.

### Limits

Lead: the tree's, with its description corrected first: `helpPages.ts` promises "members on a
team", and no such limit exists (members are per shop). New description: "Names, notes,
instructions, members, teams, workflows and open orders." Sections, each a `HelpTable`, numbers
read from the constants and printed through the screens' number formatter:

1. **Text**: columns What | Limit | What the screen does. Workflow name and task name (64), team
   name (32), tag (255, and no comma), task instructions (500), item note (2,000), block reason
   (1,000), member email (254). The screen column: a one-line field refuses on submit with "Up to
   N characters"; a free-text field counts down from 200 before its limit ("N characters left").
2. **Things in the shop**: What | Limit | At the limit. Members (12: Add member refuses and says
   to contact support), teams (50: Create team refuses, delete one to add another), workflows
   (1,000: same), tasks in a workflow (20: the editor refuses an Add past it), items on an order
   (250: the rest are not stored).
3. **Orders**: What | Limit | What happens. Open orders (2,500: new orders stop syncing, the red
   banner on the home and Orders pages; fulfill or cancel in Shopify, then Sync open orders; link
   Syncing from Shopify), the sync window (30 days: Sync open orders reads open, unfulfilled orders
   from the last 30 days), how long an order is kept (365 days from when it was placed, then it
   leaves Baton with its work, open or not; Shopify keeps every order), Done or closed on the
   member's list (a day).

Nothing says "provisional", "ceiling" or "enterprise": a limit is a number and what the screen
does there. `maxWorkflows` is a guard in the code's words, but the screen prints it on refusal, so
Limits prints it too (decision 5).

### Plans and billing

Lead: the tree's. No plan name, price, count or trial length, by the home page's rule. Sections:

1. **The plans**: a paragraph: plans are chosen on Shopify's pricing page at install and from
   **Manage plan** on the home page; Shopify shows each plan's price, included orders and members
   and the rate past them; a plan is billed monthly by Shopify with the shop's other charges.
2. **What counts**: a `HelpTable`: What | Counts when | Resets. Orders (an order counts once,
   when the first workflow starts on one of its items, by a tag or by Attach; an order with no
   workflow never counts; cancelling the workflow does not uncount it) and Members (a billing
   cycle's members are the most you had at any point in it; a member you delete still counts
   until the cycle ends; the Members tile shows today's count). Both reset at the billing cycle.
3. **Past what the plan includes**: a paragraph: nothing is refused; each order or member past
   the included number is billed at the plan's rate on the next Shopify invoice; the home page's
   two tiles say where you stand and when the cycle resets. The only hard stops are on Limits
   (link).
4. **Changing plans**: **Manage plan** opens Shopify's pricing page; a change applies at once, up
   or down; it starts a new billing cycle with both counts at zero; what was counted on the old
   plan is billed on it.
5. **The trial**: if a plan has one, Shopify shows its length; nothing is billed and nothing used
   in it carries into the first billing cycle (agree with `installing.tsx` word for word where it
   overlaps).
6. **If the subscription ends**: the merchant is sent to the plans when they open Baton; members
   see **Subscription inactive** on the bench and their work waits until the merchant chooses a
   plan again; nothing is deleted.

Check sentences 2 to 6 against `ShopUsage`'s triggers table, `seatEventValue`, `AppSubscription`,
`PlanStatus` and `src/routes/app.tsx`; where a sentence cannot be verified from the code, say so
in Deviations rather than keep it.

### `test/integration/help-limits.test.ts`

- "every limit is on the Limits page": render `Limits`, assert each constant's formatted value
  appears (64, 32, 255, 500, 2,000, 1,000, 254, 12, 50, 1,000, 20, 250, 2,500, 30, 365).
- "Plans and billing prints no number": render `PlansAndBilling`, assert the markup has no digit
  (the rule the page keeps; an exception needs a Deviations note).

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `pnpm exec playwright test --project=public`
  green. Each builder runs what it can; neither runs `pnpm fmt` or commits.
- The orchestrator: `pnpm fmt`, the four checks, then every page at 1280 and 390 in a browser, and
  the kit page's Help table, and every table read against its constant and its screen.

## Decisions

Taken 2026-10-08 while writing the plan, without review; the review is on the result.

1. **The hub has no body.** As in every cycle.
2. **One new part, `HelpTable`**, on `s-table` with the first column primary and the rest labelled,
   so a phone reads a row as a list entry. No pagination. One row in the parts table, used on help
   only; the index table row stays index only.
3. **Decision 14's check is the type, not a text rule.** The vocabulary pages read the label
   constants through a data module with `satisfies Record<State, …>`; Limits reads the number
   constants. `pnpm spec check` already holds each constant to its vocabulary row, so the chain
   vocabulary → constant → page is closed by lint plus typecheck, and an integration test pins
   that every label is rendered. A spec.ts rule over the body's source text would be weaker
   (JSX wraps, entities) and would duplicate the type. Reversible: a spec rule can read
   `helpReference.ts` as text if the review wants one.
4. **The Limits description is corrected** to drop "members on a team", which names a limit that
   does not exist.
5. **Limits prints the workflow and team ceilings** (1,000 and 50) because the screens print them
   on refusal, although the code calls them guards. README's "Unlimited workflows and teams" on
   the plan listing is a known conflict for the review.
6. **Plans and billing prints no number**, the home page's rule carried into help, and the test
   holds it. Prices and counts live on Shopify's pricing page.
7. **No colour column** on States and badges. A picture elsewhere shows the colour; a colour word
   would be a second thing to keep current.
8. **The member's list filters are on States and badges**, under a heading that says they are
   filters, because the page is for both readers and the member's screens name states too.
9. **A `When` column carries the matrices' conditions in prose**, rather than reproducing the
   matrices: a merchant reads "while no later step has started", not a row of state words.
10. **Meanings live in `src/lib/helpReference.ts`**, not in the body, so the test can read them and
    the `satisfies` can hold them; the body is the layout. The lint does not read `src/lib/`, so
    the test holds the retired words there.

## Deviations and issues

(filled in by the builders, one heading each)

### States and badges, Who can do what

Builder A, 2026-10-08. Files: `src/lib/helpReference.ts` (new), `states-and-badges.tsx`,
`who-can-do-what.tsx`, `test/integration/help-reference.test.ts` (new). No other file touched.

**The data module**

- Row sets are keyed and `satisfies` as planned, with three splits the plan's shape did not
  have: `TASK_STATE_ROWS` is `Record<Exclude<TaskState, "waiting">, …>` (waiting's label is
  `null`, so it has no row and the section's paragraph says a later step's task has no badge);
  `ITEM_WORKFLOW_ROWS` is keyed by `RUN_STATE_LABEL`'s keys plus `unstarted`
  (`RUN_STATE_LABEL` has `blocked`, which is not a `RunState`, and no `satisfies` of its own);
  the verbs are `WORK_VERB_ROWS` (`Record<Exclude<Verb, apply | discard | turnOn | turnOff>, …>`)
  and `WORKFLOW_VERB_ROWS` (the four), so a new `Verb` fails typecheck in one of them.
- Badges no constant labels carry their label in the module as a copy of the route's literal:
  Removed (`ITEM_BADGE_ROWS`), No steps and Draft (`WORKFLOW_BADGE_ROWS`), No members and No teams
  (`TEAM_MEMBER_BADGE_ROWS`). The test cannot hold these five to the code. Paid is named in a
  paragraph, not a row (it is Shopify's payment fact, and Unpaid is already a position row).
- Bodies iterate in the screen's order with no cast: `Domain.OrderPosition.literals`,
  `OrderIssue.literals`, `WorkflowState.literals`, `WorkflowFault.literals`,
  `RecordVerb.literals`, `STATES` from `workflowsListStates.ts` (the strip's order), and
  `Struct.keys` (effect) over a row set where the row set fixes the order.

**States and badges**

- Issues table: columns Badge | Meaning | What clears it. The plan's Where column is the same for
  all three (the Orders page's Issues column, Issues in the strip), so it is the section's
  paragraph instead.
- Item's workflow: Closed's reasons are read from `closedReasonText(reason, "merchant")` in
  `src/components/MemberRun.tsx` over `ClosedReason.literals`, so the page prints the card's
  words, not a copy. The member's difference is a sentence under the table (builder's choice):
  the member's workflow page has no Not started or Making badge, shows Done on a done workflow,
  and prints the closed line as "Closed · Cancelled by the merchant", the last part read from
  `closedReasonText(…, "member")`.
- Blocked's row says it shows beside Not started or Making. `orders/order-page.tsx` says "beside
  any of them". A done workflow is never blocked and closing clears a block (the bullets on
  `runActions`, the data model on `initializeSchema`), so the reference is narrower; the order
  page's sentence is not wrong for the reader but is looser. Not changed (not my file).
- Made's meaning is "No item's workflow is open, and at least one is done", from
  `orderPosition` (`runs.open === 0`, `runs.done > 0`, closed workflows beside them allowed).
  `orders/orders-list.tsx` says "every workflow on the order is done", which is wrong when a
  done workflow sits beside a cancelled one. Flagged for the review, not changed.
- Workflows: one table for Active, Inactive, Needs a team, Team has no members, No steps, Draft;
  a second section, "A team or a member", for No members and No teams with where each shows.
- The member's list: heading "The Workflows list's filters", columns Filter | Holds.

**Who can do what**

- Work on an item: columns What | Member | Merchant | When as planned. The What cell is a short
  plain phrase held in the module ("Say a task is done", since "mark done" is retired). A null
  label renders an empty cell.
- Workflows, teams and members: columns Button | On | Does, not What | Merchant | Does. Every row
  is the merchant's, so a Merchant column would only repeat the first; the button is the row's
  title, which is the shape rule (first column the word as the screen prints it). Rows: the four
  workflow verbs, then the seven record verbs in `RecordVerb` order.
- Assign team's When follows `taskActions`: any task not done, at any step (waiting included),
  while the workflow is open, blocked or not. A sentence under the table adds that a waiting task
  offers only Assign team, to the merchant.
- Change workflow's When adds that under a closed workflow the Workflow select does it
  (`runActions` bullet: the select at rest replaces a closed workflow with no confirm, and
  Manage leaves Change workflow out there).
- Delete's Does says items on a deleted workflow keep going and recorded work keeps its names
  (`deleteWorkflow`, done tasks keep `teamName`, `startedByEmail`/`doneByEmail` outlive the
  member), not the Record verbs table's "with nothing of it kept", which is about the record
  itself and would mislead a merchant about the work.
- Turn on's Does: starts on items carrying its tag on every open, paid order, and an item already
  on a workflow keeps it (the Turn on row of the triggers table on `reconcileItem`). Multi-match
  is not mentioned there.
- What a member sees: a paragraph as planned, plus the no-team empty line's advice ("Ask the
  merchant to add you to a team", `shop.$shop.workflows.index.tsx`).

**Not verified in code**

- Ready's "Anyone on its team can" start it, and Started's "says who and since when": read from
  `taskActions` and `RunSteps`' JSDoc, not from rendering a page.
- "A matching workflow starts once it is paid" (Unpaid) is carried from `orders/orders-list.tsx`
  and `orderCanCreateRuns`' name; I did not trace the reconcile on `orders/paid`.

**Checks**

- `pnpm typecheck`: green. `pnpm lint`: green.
- `pnpm test`: 39 files, 785 tests passed (builder B's `help-limits.test.ts` included and
  passing at the time).
- `pnpm exec playwright test --project=public`: 6 passed.
- Not run: `pnpm fmt` (orchestrator's), no browser look at 1280 or 390.

### Limits, Plans and billing

Builder B, 2026-10-08. Files: `limits.tsx`, `plans-and-billing.tsx`, the Limits description in
`helpPages.ts`, `test/integration/help-limits.test.ts`. No other file touched.

**Limits**

- `Domain.formatNumber` is in `src/lib/domain/Platform.ts`, re-exported by the barrel;
  `src/lib/format.ts` re-exports the same function. The body uses `Domain.formatNumber`.
- Text table: workflow name and task name are two rows, not one. The workflow name has the
  field check ("Up to 64 characters"); the task name has none in the editor
  (`app.workflows.$workflowId_.edit.tsx` calls `textLimitError` on instructions only), so the
  write refuses it and the editor shows the error in its banner. The cell says that; the banner's
  exact words are the schema's and were not checked.
- The tag row quotes both field errors: "Up to 255 characters" and `tagCommaError`'s "A tag
  can't have a comma.".
- The countdown cell prints where it starts as `max - noteCountFrom(max)` (200), so the page
  prints a 200 the test does not list. No literal in the body.
- Done or closed prints "24 hours" (`DONE_WINDOW_MS / 3,600,000`). The member bodies say "a
  day". Same fact, different unit; the reference prints a number so the test can hold it.
- The open-order row's remedy (fulfill or cancel, then Sync open orders, link to Syncing from
  Shopify) is a paragraph under the table, not in the cell, to keep each cell to two sentences.
- Workflows row names **Create workflow** and **Duplicate**: both go through
  `insertWorkflow`, which refuses at `maxWorkflows`.
- Items on an order: no screen says anything at 250. Only a log records the cut
  (`ShopAgentOrdersStream`, `agent/Orders.ts`). The cell says Baton keeps 250 and leaves out the
  rest, and does not say which 250.
- Retention "after it was placed": the cutoff reads `processedAt`, the date the Orders page
  prints as Placed.

**Plans and billing**

- Members do not reset to zero. A new billing cycle sets the seat mark to the member count then
  (the "cycle pushed, new start" row on `ShopUsage`), so the Resets cell says "starts from the
  members you have then", and Changing plans says Orders this billing cycle starts at zero and
  the members count starts from the members you have. This disagrees with
  `getting-started/installing.tsx` ("starts a new billing cycle, with both counts at zero"),
  which is not mine to edit. Recommend the orchestrator change that sentence to match.
- Cut, not verifiable in the code: "what was counted on the old plan is billed on it". The code
  sends the usage queue when Manage plan is pressed and deletes an event whose cycle ended
  unsent; whether Shopify bills the old subscription's usage was not found.
- Kept but approximate: "the most members you had at any point in it". The mark is raised at
  revalidations (`seatEventValue`), so a member added and deleted between two revalidations may
  never count. Kept because `installing.tsx` says it word for word.
- "Billed monthly with the shop's other charges" became "each billing cycle, which is a month,
  on your Shopify invoice". The month is the vocabulary's billing cycle row; the invoice is from
  `refs/shopify-docs/docs/apps/launch/billing.md` ("Charges are directly added to the merchant's
  Shopify invoice"), not the code.
- "Their work waits until the merchant chooses a plan again" became "their workflows are
  unavailable until you choose a plan again", the words of the lapsed page and
  `members/signing-in.tsx`. Whether order webhooks still update orders during a lapse was not
  checked, so the page does not say. "On the bench" was dropped.
- Added: "Ending a subscription deletes nothing. Uninstalling Baton deletes everything it holds
  for your store, and installing it again starts with nothing." From the shop row on
  `D1_TABLES`. Without it, "nothing is deleted" misleads a merchant who ends the plan by
  uninstalling.
- "Shopify shows each plan's price, included orders and members and the rate past them" is
  Shopify's pricing page, not the code; it agrees with `installing.tsx` ("The plans show the
  numbers and the rates").

**Test**

- "Plans and billing prints no number" strips tags and character references before looking for
  a digit: `renderToStaticMarkup` writes an apostrophe as `&#x27;`.
- "every limit is on the Limits page" checks each formatted value with no digit or comma on
  either side, and includes the 24 hours.

**Checks** (2026-10-08, with builder A's files as they were in the checkout then)

- `pnpm typecheck`: pass.
- `pnpm lint`: pass.
- `pnpm test`: pass, 38 files, 783 tests.
- `pnpm exec playwright test --project=public`: pass, 6 tests.
- `pnpm fmt` not run, as instructed.

## Review (2026-10-08)

The orchestrator's pass: `pnpm fmt` (touched nothing beyond the cycle's files), typecheck, lint,
`pnpm test` (39 files, 785 tests) and the public e2e project (6) all green. The four pages and
the kit page's Help table were looked at in Chrome at 1280 and 390, every body read against its
constants and the screens it names, and both Deviations sections read. Findings, each with the
smallest change that closes it.

1. **Installing says a plan change starts "both counts at zero"; members do not.** The "cycle
   pushed, new start" row on `ShopUsage` sets the member mark to the member count, and Plans and
   billing now says so. Change the sentence in `getting-started/installing.tsx` (and its JSDoc) to:
   orders start at zero and members start from the members you have.
2. **Reading the orders list says Made is "every workflow on the order is done".** `orderPosition`
   is no open workflow and at least one done, so a done workflow beside a cancelled one is Made.
   Change the sentence to the reference's wording.
3. **Reading an order says Blocked shows "beside any of them".** A done workflow is never
   blocked and closing clears a block, so it shows beside Not started or Making only. Change the
   sentence.
4. **The task name has no field check in the editor.** Every other capped field refuses on
   submit with "Up to N characters"; the task name is refused by the write, and the merchant
   reads a schema error in the editor's banner. Limits says so, honestly, but the fix is the
   editor: `textLimitProps` and `textLimitError` on both Name fields in
   `app.workflows.$workflowId_.edit.tsx`, then the Limits row reads as the workflow name's does.
5. **Who can do what's sentence "A task waiting on an earlier step offers only Assign team"**
   reads backwards. Change to "A task in a later step, not yet current, offers only **Assign
   team**, to the merchant."
6. **States and badges' lead says "the four the bench moves an order through".** "The bench" is
   a figure. Change to "the strip counts the four between No workflow and Made".
7. **On a phone, an empty Member cell prints the label "Member" alone.** Polaris's list variant
   labels every cell. It reads as "Member: none", which is the vocabulary's "(none)". Accept.
8. **Labelled cells right-align short values on a phone** (Limits' "64 characters" sits at the
   end of its line). Polaris's list variant, not ours. Accept.
9. **`closedReasonText` is imported from `src/components/MemberRun.tsx`** into a help body, so
   the Closed row prints the card's words. A member screen's module in the help bundle is a
   small cost against a copied string that would drift. Accept.
10. **Decision 3 stands**: the vocabulary pages are held by `satisfies` plus the existing
    screen-column spec check, pinned by `help-reference.test.ts`, with no new rule in
    `scripts/lib/spec.ts`. A text rule would be weaker. Decision 14 in the research should be
    reworded to say so.
11. **README's plan listing says "Unlimited workflows and teams"** while Limits prints 1,000 and
    50, which the screens print on refusal. The listing is the Partner Dashboard's copy; the
    user's call. Flagged only.
12. **"24 hours" on Limits where the member pages say "a day".** Same fact; a number so the
    test can hold it. Accept.

## Follow-ups (2026-10-08)

All twelve accepted. 1 to 6 made: `installing.tsx` (orders at zero, members from the members you
have), `orders-list.tsx` (Made), `order-page.tsx` (Blocked beside Not started or Making),
`who-can-do-what.tsx` (a task in a later step), `states-and-badges.tsx` (the four between No
workflow and Made), and the editor's two Name fields take `textLimitError` on submit with a
`taskNameError` state, so the Limits row for the task name now reads as the workflow name's. 7, 8,
9, 12 accepted as is. 10: decision 14 in the research reworded. 11: the plan listing's feature
line is now "Workflows and teams at no extra charge": not unlimited, since the ceilings exist, and
no number, since every ceiling is provisional; the line says the one thing that is settled, that
neither is metered.

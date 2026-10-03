# Plan: the workflows list row, one kind of fact per line

Written 2026-10-02 from the decisions in `docs/workflows-list-row-research.md`. It is for an agent
that has not seen that research. Read its "Why it is hard to read" and "Decisions" sections first;
this plan does not repeat the reasoning, only what to change and in what order.

## Before you start

- Read `AGENTS.md`. The rules that bite here: a rule is stated once, normatively, in the JSDoc on
  the symbol that enforces it, and has a test whose title is the rule; JSDoc carries its reasoning
  and never cites `docs/`; status and role predicates are `Domain` functions, never inline
  comparisons in the route; use the vocabulary's words ("workflow", "item", "task", "team",
  "state", "filter", "search"; never "run" or "line item" on screen); run `pnpm fmt` and keep
  everything it touches; do not commit unless told to.
- Start with `git merge --ff-only main` in the worktree.
- The screen is `src/routes/shop.$shop.workflows.index.tsx`, called "the workflows list" in JSDoc
  and tests. The workflow page is `shop.$shop.workflows.$runId.tsx`.

## What changes, in one table

| piece               | today                                                                                                     | after                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| line one            | `Signet ring` strong, `Cast and engrave · #1002` subdued, quantity badge                                  | `Signet ring · Gold ×2` strong (clamped to 2 lines), quantity badge, `#1002` in its own cell at the end                        |
| line two            | every task name joined by `·`, then step, block reason, `Started · <who>` or `In progress` (2-line clamp) | one line per current task: `Task (Team) · <state>`, each clamped to one line; a blocked row adds one `Blocked · <reason>` line |
| line three          | none                                                                                                      | `<workflow> · Step k of n`, subdued, one line, the workflow name clamped                                                       |
| team                | after the step, in parentheses per task, or nowhere                                                       | always `(Team)` after its task, by one rule                                                                                    |
| state on a task     | first task's only                                                                                         | each task's own, omitted where the filter already says it                                                                      |
| quantity            | only the change badge                                                                                     | `×n` when n > 1, plus the badge on a change                                                                                    |
| Done or closed rows | Done: task name leads, `item · workflow · order` subdued; closed: item leads, `workflow · order`          | line one as open rows; line two the task and who did it, or the closed reason; line three the workflow name                    |
| seed                | every workflow named after its process                                                                    | "Cast and engrave" renamed "Signet ring"                                                                                       |

## Phase 1: the rules, in the domain

### 1.1 `src/lib/domain/ShopWork.ts`

Replace `runRowLine` with a function that returns the row's lines two and three as data. The route
renders it; the domain decides it. Suggested shape (name it in the vocabulary's words; `runRowLines`
is fine):

```ts
export const runRowLines = (
  item: RunListItem,
  context: {
    readonly memberEmail: Email;
    readonly showTeam: boolean;
    /** The chosen state, or null under a search, which ignores it. */
    readonly state: RunListState | null;
  },
): {
  readonly tasks: ReadonlyArray<{
    readonly id: RunTaskId;
    readonly name: string;
    readonly team: string | null;
    readonly state: string | null;
  }>;
  /** `Blocked · <reason>`, the reason alone under the Blocked filter, or null. */
  readonly block: string | null;
  /** `<workflow> · Step k of n`. */
  readonly recipe: string;
};
```

Rules, each stated once in this function's JSDoc (or on a helper it calls), each with a test whose
title is the rule:

1. **Team.** A task's team is printed, as `(Team)` after the name, when `showTeam` is true or when
   the row's tasks are on more than one team. Otherwise `team` is null.
2. **The filter's state is never repeated.** A task line prints its state only when it is not the
   state the filter already says:
   - started by the reader: `Started by you`, omitted under the Started by you filter;
   - started by someone else: `Started by <who>` (`actorLabel`), always: who is the news, even
     under Started by others;
   - started with no known starter (`taskStartedBy` is null): `Started`
     (`TASK_STATE_LABEL.started`). This replaces today's `In progress` (`RUN_STATE_LABEL.open`),
     a run word on a task line;
   - ready: `Ready`, omitted under the Ready filter.
     Under a search (`state` null) every task line prints its state.
3. **A block is the run's, said once.** A blocked row's task lines print no state; `block` is
   `Blocked · <reason>`, or the reason alone under the Blocked filter, or `Blocked` when there is
   no reason.
4. **The recipe line** is the workflow name and `Step k of n`, k the step the current tasks share,
   n `stepCount`, on every open row whatever its state.

Move `showTeam`'s rule out of the route into a `Domain` function beside this one (for example
`rowShowsTeam(teamCount, team, q)`), with its JSDoc carried over from the route: the member is on
more than one team and the list is not narrowed to one team, or the list is a search.

Update the JSDoc on `RunListRun` (`workflowName` "stays because the row names the item's
workflow, the noun both sides use for a run"): it stays because line three names the recipe the
item follows. Update `RunListItem`'s link from `runRowLine` to the new function.

Add a helper for line one's text, shared by open and Done or closed rows: item title, ` · variant`
when there is one, ` ×n` when the quantity is more than one (`formatNumber`). The route's
`itemTitle` becomes this, or calls it. "×2" with no space, as the vocabulary's run row writes it
("Brass hinge ×2").

### 1.2 Tests (`test/integration/domain.test.ts`)

Replace the `Domain.runRowLine` describe with one test per rule above, titled by the rule. Cover:
one task; two tasks on one team with and without `showTeam`; two tasks on two teams; each task
state under each filter and under a search; a parallel row where one task is the reader's and one
a teammate's (the case today gets wrong); blocked with and without a reason, under Blocked and
under a search; the recipe line. Add tests for the line-one helper (variant, ×1 omitted, ×2) and
for the show-team rule.

### 1.3 Done when

`pnpm typecheck`, `pnpm lint` and `pnpm test` pass, and nothing in `src/` calls `runRowLine`.

## Phase 2: the screen

### 2.1 `src/routes/shop.$shop.workflows.index.tsx`

1. **`renderItem`.** Rebuild the left stack as three parts:
   - Line one: an `s-grid gridTemplateColumns="minmax(0, 1fr) auto"` holding the title cell and
     the order number. The title cell is the line-one text in a wrapper with the two-line clamp,
     then `QuantityBadge`. The order number is plain subdued text that never shrinks or wraps.
   - The task lines: one per entry of `tasks`, each `Name (Team) · State` in a one-line clamp,
     the name regular weight, the rest subdued. Then the `block` line when there is one.
   - Line three: `recipe`, subdued, one-line clamp.
     Delete `detailLine`; the domain function replaces it. Keep the kebab and the menu exactly as
     they are; the menu rules do not change.
2. **`renderDone`** (a done task): line one as open rows; line two `<task> · Done by <who> at
<time>`, then ` · Note: …` as today, one-line clamp; line three the workflow name alone (a
   `RecentItem` carries no `stepCount`, and a done task's step is history). Keep the kebab.
3. **`renderClosed`**: line one as open rows; line two `ClosedLine` with its prefix; line three
   the workflow name.
4. **Accessible labels.** The row link's label stays `Open <item> on <order>`; use the line-one
   text so the variant and quantity are in it. Labels are never clamped, so they carry the full
   title.
5. **JSDoc.** Rewrite the JSDoc on `renderItem` and `itemTitle`: line one is the piece, line two
   the work, line three the recipe; why the workflow name left line one (the simple setup names a
   workflow after its product, and the item already names the run); why the order number has its
   own cell (a clamp never reaches it). Link the domain function for every rule rather than
   restating it. Remove the `showTeam` JSDoc from the route once the rule lives on the `Domain`
   function.

### 2.2 `src/styles.css`

Replace `.run-detail-line` (two-line clamp) with two classes: a two-line clamp for the item title
and a one-line clamp for a task line and line three (`-webkit-line-clamp: 1` with the same block,
so a long word still ellipsises). Check that nothing else uses `.run-detail-line` before removing
it.

### 2.3 The workflow page

`shop.$shop.workflows.$runId.tsx` already shows the full item title as its heading and
`<workflow> workflow · <order>` under it. No change, except: if the line-one helper's variant and
quantity are wanted in the heading, that is a separate decision; do not change it here.

### 2.4 Done when

`pnpm typecheck`, `pnpm lint` (which runs `pnpm spec check`) and `pnpm test` pass.

## Phase 3: the seed

In `e2e/fixture.ts`:

1. Rename the workflow "Cast and engrave" to "Signet ring". Its tag, tasks and the products that
   carry the tag stay as they are.
2. Rewrite the JSDoc on `workflows`: workflows are named the way merchants name them, after the
   process or after the product. "Signet ring" is the product-named one, so the screens are seen
   under the simplest setup, where a workflow's name is its product's.
3. Make sure the seed has, for Phase 5 to look at: an item with quantity above one, a variant, a
   parallel step whose tasks are on two of one member's teams, a blocked row with a long reason, the
   at-cap workflow name, and one item title well past a phone-width line. Add a long product title
   if none exists (Shopify allows 255 characters).

Grep `e2e/` and `test/` for "Cast and engrave" before renaming; at the time of writing only the
definition uses it.

## Phase 4: the e2e tests (`e2e/member-runs.member.spec.ts`)

The texts the tests read change. Update the constants and their JSDoc, not the tests' intent:

- `MINE_STATE` ("Step 1 of 1") now sits on line three after the workflow name, and the reader's own
  task line prints no state under Started by you. The assertion at `${CUT_TASK} · ${MINE_STATE}`
  becomes the task line (`Cut`) and the recipe line (`<workflow> · Step 1 of 1`) separately.
- `Started · <who>` becomes `Started by <who>` on the teammate's row.
- The team tests (`card(…).getByText(CUT_TEAM)`) now see `(Cutting)`-style text after the task;
  keep their counts, adjust the matcher.
- Add one test for a parallel row with two task lines, each with its own state.
- Add one test that a search prints every task line's state.
- Line one with a variant (`E2E Gift Box · Large`) is unchanged in form; add the `×n` case if the
  seeded orders allow it.

Run `npm run test:e2e --` for the member project. `e2e/orders.spec.ts` asserts the merchant order
page's `Step 1 of 1 · Cut`, which this plan does not touch.

## Phase 5: look at it

Run `pnpm dev:reset`, sign in as a member on several teams, and look at the workflows list at
desktop width and at 375px, under every state and under a search. Check each case Phase 3 lists.
For each: the order number is visible; the step and every state are visible; long names end in an
ellipsis; the quantity badge does not push the order number off line one. Take screenshots of the
simple-setup row (`Signet ring` over `Signet ring · Step 2 of 3`), a parallel row, a blocked row and
a long title, and include them in the report.

## Phase 6: finish

`pnpm fmt` (keep everything it touches), `pnpm typecheck`, `pnpm lint`, `pnpm test`, the member
e2e project. Do not commit unless told to. Report what changed and anything recorded below.

## Deviations and issues

Record here, as you go, every place the implementation departs from this plan or the research's
decisions, and every problem found. One entry each: what, why, and what was done or is left for
the user. Leave a section empty with "None" rather than deleting it.

### Deviations

1. **`runRowLines` takes `WorkflowsListState | null`, not `RunListState | null`.** The route's
   state is a `WorkflowsListState`; accepting the wider type avoids a cast, and `done` never
   reaches an open row except under a search, where the route passes null.
2. **Blocked with no reason, under the Blocked filter, has no block line** (`block` is null). The
   plan said `Blocked` when there is no reason; under Blocked that repeats the filter, which rule 2
   forbids. Elsewhere a reasonless block still reads `Blocked`.
3. **Fixed words sit outside the clamp, not inside a one-line clamp.** With the whole line in a
   one-line clamp, 375px cut `Step 2 of 18` and every task's `Ready` (decision 7 says they are
   never clipped). Each line is now a flex row of `Clip` parts (task, team, reason, workflow name,
   the item title) and `Keep` parts (state, step, `×n`, `Done by … at …`). So the domain returns
   `recipe` as `{ workflow, step }`, and line one's helper is `itemPiece` → `{ name, quantity }`,
   with `itemTitle` joining them for the accessible label. CSS: `.run-title-clip` (two-line
   clamp), `.run-line`, `.run-line-clip`, `.run-line-keep`, `.run-order`.
4. **The done line's note is its own `Clip` after the kept `Done by … at …`**, so a long note is
   cut and the time stays.
5. **`Done by <who>` instead of `by <who>`** on the done line, since the task now leads the line
   and the line needs the state word.
6. **The e2e parallel-row test uses a new order `#9405` ("E2E Runs Split", Cut and Pack on two
   teams).** `#9404` was already the spec's pair order (two Cut tasks on one team). The mate opens
   it under Started by others, because once the maker starts Cut the row leaves Ready.
7. **The seed gets variants and a quantity**: #1002's ring is `Sterling silver`, #1008's is
   `Gold ×2`. #1003's journal ×2 and #1026's long title and reason already existed.

### Issues

Known before starting; resolve each or record what happened:

1. **The quantity badge on line one.** The decisions put it on line one. At 375px, a two-line
   title, the badge (`Quantity changed · 2 → 1`) and the order number may not fit. If they do not,
   move the badge under line one and record it as a deviation.
2. **`Started by <who>` is a copy change.** Today's `Started · <who>` becomes `Started by <who>`,
   matching the strip's labels. If `pnpm spec check` or the copy table on `CopySlot` in
   `src/lib/Screen.ts` holds an example of the old form, update the row first.
3. **`In progress` leaves the task line.** A started task with no known starter now reads
   `Started`. Check the vocabulary's run-states row for `open` still names every screen that
   shows `In progress`.
4. **Row height.** Every open row gains a line. If the list reads too sparse at desktop width,
   record it; do not drop line three without asking, since that is approach C, which was not
   chosen.
5. **Two items with the same title and variant on one order** (Shopify keeps them as separate
   lines when their properties differ) read the same on line one. This was known and accepted;
   the workflow page shows the properties. Record if the seed shows it confusingly.

What happened:

1. **Quantity badge.** At 375px `Quantity changed · 2 → 1` does not fit beside the title and
   order number; the inline stack wraps it under the title (seen on #1021). The order number stays
   on line one. No change made beyond the wrap.
2. **Copy.** Neither the copy table nor `pnpm spec check` held `Started · <who>`; only comments
   did, now updated.
3. **`In progress`.** No member row prints it now. The run-states row still says `In progress`
   for `open`; the merchant screens and the workflow page still use it, so the row is unchanged.
4. **Row height.** Every open row is three lines at least; the desktop list reads denser, not
   sparse. Nothing dropped.
5. **Same title on one order.** The seed has none that read confusingly (#1016's three boards
   differ only in properties, and one is closed).

Found while looking:

6. **`s-text type="strong"` renders at weight 450 here, the same as plain text**, so line one's
   title and a task name read the same weight, told apart only by position. It was already 450
   before this change (the old row relied on the subdued colour of the rest). Left for the user:
   an `s-heading` or another treatment for the title is a design call.
7. **A clipped team leaves a small gap before the kept state** (`Cut and sand (Woodsh…  · Started
by you`): the ellipsis is drawn inside the clip box, which keeps its full share of the line.
   Cosmetic; left as is.
8. **`e2e/orders.spec.ts` "orders screen syncs open orders" timed out once** on the Shopify sync
   in the full run, and passed on a rerun. Not touched by this change.

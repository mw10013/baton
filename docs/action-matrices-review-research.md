# Action matrices review: gaps, conflicts and open questions from first principles

Written 2026-10-01. Status: decided 2026-10-02; plan in `docs/action-matrices-review-plan.md`, not yet implemented.

The ask: the two action matrices, `runActions` and `taskActions` in `src/lib/domain/ShopWork.ts`,
were written after the code, from the code. Read them as a spec, from first principles, and say
where they are incomplete, contradictory or unclear, so the spec can be fixed first and the code
and tests made to follow.

This doc reads the matrices and the rule tables they lean on: the verbs table in the shop-work
vocabulary, the "What each state allows" table on `RunState`, the rules table on `runIsBlocked`,
and the JSDoc on the `RunRepository` writes. It reads the code only where a question needs a fact
about what happens today; those facts are marked "today:". A finding about the code is a finding
about the spec: either the spec should say it, or the code should stop doing it.

## The short version

1. **The contract the matrices claim is not the contract the screens keep.** The preamble says
   the page draws a button only when its field is true, and the callable refuses when it is
   false. Three screens draw less than the set allows on purpose (the list offers Start and not
   Done on a ready task; the Blocked view offers Unblock alone; the member page hides a blocked
   Undo), and three callables answer something other than `NotAllowed` on a filled or blank
   cell (`blocker`, `assign`, `changeWorkflow`). The set is an upper bound, not the button list.
   Section 1.
2. **One letter, three meanings.** "m" is a member whose team holds a current task (Block, Edit
   reason, Unblock), a member who can see the run (the note), and a member whose team the task
   is on (every task verb). In `runActions` the first two share a cell letter and the test's
   fixture makes them coincide, so the table never shows the member whose team holds only a
   waiting or done task; a side test outside the table pins that. Section 2.
3. **Two states the tables are silent on.** A task on no team, or on a team that was deleted,
   and an open run whose item is at zero units. Both are reachable and both have an answer
   today; neither is written. Section 3.
4. **The same gates are stated four times and disagree twice.** The verbs table says Undo is
   "the member takes back their own Done"; the matrix gives it to the whole team. The rules
   table on `runIsBlocked` lists what a block refuses and allows and leaves out Assign, which
   the matrix allows under a block. `AGENTS.md` says a rule is stated once. Section 4.
5. **Change workflow is in the run set but not behind the run gate.** The server never reads
   `changeWorkflow` through `requireRunAction`; the attach callable reads it with its own three
   refusals, and the member pages cannot read it at all because they hold no item. Section 5.
6. **Five rules the matrices should decide and do not.** Whether a member whose team is later
   in the workflow may Block; whether Change workflow is offered on a run someone has started;
   whether Reopen is refused at the open-run ceiling; what a merchant's Done on a task nobody
   started records; and whether an archived Shopify order counts as closed. Section 6.

Every recommendation is numbered, and the questions that need the user are gathered at the end,
each with one recommendation.

## 1. What the matrices are a spec of

The preamble on `runActions` says: "The page renders a run-level button only when its field is
true, and the `ShopAgent` callable for that write computes the same object from the same inputs
and refuses with `NotAllowed` when the field is false." Read strictly that is two claims: a page
draws exactly the true fields, and the server's only answer to a false field is `NotAllowed`.

Neither holds, and the exceptions are each deliberate and each written somewhere else:

- Today: the member's workflows list offers Start and not Done on a ready task ("the row walks
  the member through the task one verb at a time"). Its JSDoc says so.
- Today: the Blocked view's row menu lists Unblock alone, although the set allows Edit reason
  too.
- Today: the member's workflow page draws no Undo when `reopen` carries a blocker, although the
  cell is `blocker` for "m" too ("a member sees no Reopen button and no explanation"). The
  matrix preamble says this.
- Today: a `blocker` cell answers `ReopenBlocked` from the repository, not `Ok`; `assign`
  answers `Assigned`; a blank `changeWorkflow` answers `ItemDone`, `OrderClosed` or
  `NothingToMake` from the attach callable. The test carries a special case for each.

So the real contract is: **the set is an upper bound.** No screen offers a verb whose field is
false, the server refuses every write whose field is false, and a screen may offer fewer verbs
than the set allows when it says why in its own JSDoc. The test proves the lower half (the
server refuses the complement) and the pure half (the formula equals the table); nothing proves
the upper half (no screen draws a verb the set refuses), which is a code-review property.

**Recommendation 1.** Rewrite the contract paragraph as the upper bound, in those words, and name
the three screens that offer less and where their reason lives. State that a filled cell means
"the write is allowed by the set; the repository may still refuse for a reason the set does not
read" and list the three: the downstream start on Reopen, the attach results on Change
workflow, and a race (`NotBlocked`, `NotReady`, `Terminal`). Today the toast copy on the order
page already enumerates these; the matrix should own the list.

**Recommendation 2.** Say what the `TaskActions.reopen` value means in the preamble, beside the
`blocker` word: `null` is not offered, `{ blockedBy: null }` is the button, `{ blockedBy }` is
the sentence. The schema says it; the table's reader should not have to open the schema.

## 2. Who "m" is

The `runActions` preamble defines "m" as a member whose team holds a current task, "for the note
it is a member who can see the run". The `taskActions` preamble defines "m" as a member whose
team the task is on. That is three predicates under one letter:

| table         | verb                         | "m" means                                                   | predicate          |
| ------------- | ---------------------------- | ----------------------------------------------------------- | ------------------ |
| `runActions`  | block, editReason, unblock   | a team of theirs holds a current task on the run            | `holdsCurrentTask` |
| `runActions`  | note                         | a team of theirs holds any task on the run, done or waiting | `runIsVisibleTo`   |
| `taskActions` | start, done, putBack, reopen | the task is on a team of theirs                             | `taskIsOnTeams`    |

In `taskActions` the letter is clean: every row is about one task and "m" is that task's team.
In `runActions` it is not. The row `open | open | yes | some → note M m, editReason M m, unblock
M m` reads as if one member gets all three, and for a member whose team holds only step 3 while
step 1 is current, the note is true and the other two are false. The table cannot show that
because the fixture the test expands each row to is one task, on the member's team, current
exactly when the run is open (`scripts/lib/spec.ts`, `expand`). A separate test, "a member
whose team holds no current task gets only the note, and only if the run is theirs to see",
pins the distinction outside the table.

The fourth actor, a member on none of the run's teams, is blank in every cell and is not named
in either preamble; the test calls them `OUTSIDER`.

**Recommendation 3.** Add a cell letter to `runActions`: "v", a member who can see the run
(`runIsVisibleTo`) but whose teams hold no current task. The note cell becomes `M m v`; the rest
stay `M m` or `M`. The parser's `Cell` literals gain `M m v`, and `expand` adds a second fixture
per row for "v": one task on the member's team that is not current, plus one current task on
another team. The side test then folds into the table. The alternative, a `member` state
column with the words `current`, `visible`, `outsider`, multiplies every row by three; a letter
is a column that costs no rows, which is why "M" and "m" are letters already.

**Recommendation 4.** Name the outsider in both preambles in one sentence: a member whose teams
hold no task of the run gets nothing, the note included, and cannot open the run page
(`getRunPage` answers `None`).

**Recommendation 5.** Say in the `runActions` preamble what the row's fixture is, as the test
builds it: one task, on "m"'s team, current when the run is open. The reader of the table should
be able to say what each cell was checked against without opening `spec.ts`.

## 3. States the tables do not name

### 3.1 A task on no team, or on a deleted team

A task's `teamId` can be `null` (the workflow task had no team when the run was created, or the
team was deleted and the sweep nulled it) or point at a team no longer in D1. The vocabulary calls
the first `unassigned` and the issues table says the remedy is Assign team on the order page.
The matrices have no word for it. Today: `taskIsOnTeams` is false for every member on such a
task, so every "m" cell is blank; the merchant's cells hold, so the merchant may Done, Put back
and Reopen a task nobody is assigned to, and `requireActionable` skips the team check for the
merchant on purpose ("that task is on nobody's list and no worker can reach it, which is exactly
the situation the merchant is there to fix").

That is the right answer, and it is a rule the spec should state, because a reader of the row
`open | open | no | ready | - → start m, done M m` will ask who "m" is when the task has no team.

**Recommendation 6.** One sentence in the `taskActions` preamble: a task on no team, or on a team
that no longer exists, is a task of nobody's; every "m" cell is blank for it and every "M" cell
holds, so the merchant can finish or move work no member can reach. Pin it with one test titled
in those words.

### 3.2 An open run whose item has nothing left to make

`runActions` has a `units` column because `changeWorkflow` reads it. `taskActions` has none, so
on an open run whose item is at zero units (Shopify refunded it and reconcile has not yet passed)
Start, Done, Put back and Reopen are all offered. Today: reconcile closes that run as
`item_removed` on its next pass, and a Done that lands first just makes the run `done`, which
reconcile then leaves alone ("a done run is a record"). A run whose item dropped out of the kept
250 on a truncated order is the other case: no pass reads it (`reconcileItem`'s pass rules), so
its tasks stay workable for as long as the order is open.

That is acceptable, since the first window is one webhook and the second is the truncation rule's
own decision, but the spec should say the task set does not read the item, and that a Done in the
window wins. Otherwise the reader of the two tables side by side will take the missing column for
an oversight.

**Recommendation 7.** One sentence on `taskActions`: the task set reads the run and the order,
never the item; an item at zero units is reconcile's to close, and a Done that lands before it
stands. No column.

### 3.3 "started" under `downstream` includes "done"

`reopenBlockedBy` returns the first downstream task anyone has started, and Done backfills
`startedAt`, so a downstream task that is done is "started" for this column. On a done run that
means every task but the last has a blocker, and the only reopenable task on a done run is its
last one, which the preamble calls "the point" without saying it follows from this. The
`reopenBlockedBy` JSDoc says "a `startedAt` test covers done tasks too"; the matrix does not.

**Recommendation 8.** Define the three `downstream` words in the preamble, as the `reconcileItem`
tables define theirs: `none` is no later task started or done; `started` is a later task
started or done, since Done records a start; `-` is a state Reopen is never asked in. Add the
consequence: on a done run only the last task has `none`.

## 4. The same gates, four times

The who-and-when of each verb is written in four places:

| place                                       | what it says                                          | read by the check |
| ------------------------------------------- | ----------------------------------------------------- | ----------------- |
| the matrices on `runActions`, `taskActions` | a result per state per actor                          | yes, every cell   |
| the verbs table in the vocabulary           | the verb, what it acts on, its effect, its two labels | labels only       |
| "What each state allows" on `RunState`      | a gate per action, as predicate names                 | no                |
| the rules table on `runIsBlocked`           | what a block refuses, allows, hides and counts        | no                |

`AGENTS.md`: "any behaviour more than one site must agree on is stated once, normatively, on the
symbol that enforces it or the symbol that is the concept. Other sites `{@link}` it rather than
restate it." The matrices are the enforcing symbol. The two unchecked tables restate the same
gates in words the check cannot read, and two of their rows already disagree with the matrix:

- **Undo.** The verbs table: "Undo and Reopen are two words for one verb on purpose: the member
  takes back their own Done, the merchant reopens someone's record." The matrix row `open | open
or done | any | done | none → reopen M m` gives "m" to the task's team, so a teammate may Undo
  a Done they did not press. Today: `reopenTask` checks `taskIsOnTeams`, never who pressed
  Done. The `putBackTask` JSDoc argues the team-wide reading for Put back ("Start is a record,
  not a lock, and the inverse of a verb is as open as the verb"); Undo has the same shape and
  the vocabulary says the opposite. Question 3.
- **Assign under a block.** The block table: "Start, Done and Put back are refused; Reopen and
  the note are not." The matrix row `open | open | yes | any open | - → assign M` allows
  Assign under a block, and Edit reason and Unblock are in the next row of the block table.
  Assign is in neither. Today: `assignRunTaskTeam` does not read the block. The matrix is right
  (moving a held task to the team that can unstick it is a fix), and the block table should say
  it or stop listing verbs.
- **The note.** `RunState`'s table: "note | always (a note is a record)". The matrix: `M m`, and
  "m" is the visible member, so not always. The row is about state and the matrix about actors,
  but a reader meets "always" first.

The `RunState` table also carries rows that are not actions (reconcile resizes, reconcile closes,
holds its item, replaced by a manual attach, counts against the shop ceiling). Those are the rows
that belong on `RunState`, since they are what each state means to reconcile and the data model,
and no matrix holds them.

**Recommendation 9.** Cut the action rows (Start, Done, note, Block, Put back, assign, Cancel,
Reopen) from `RunState`'s table and keep the five reconcile and data-model rows, with one line
above it saying the who-and-when of every verb is the matrices. The verb rows restate eight cells
and the check cannot see them drift.

**Recommendation 10.** Rewrite the first two rows of the block table as one row that links the
matrices: "which verbs a block refuses and which it leaves: the `blocked yes` rows of
`taskActions` and `runActions`", and keep the three rows that are not actions (no team on the
orders index, counted as blocked, on the Blocked view). The reasoning sentences under it
(Reopen "takes work back rather than doing more", Put back "clearing who has it under a hold
loses the one name the merchant needs") move to the matrix preamble, where the cells they
explain are.

**Recommendation 11.** Reword the Undo sentence in the verbs table once question 3 is answered.
If team-wide: "Undo and Reopen are two words for one verb: on the bench it takes back a Done,
usually one's own; the merchant reopens someone's record."

## 5. Change workflow is in the run set but not behind the run gate

`runActions.changeWorkflow` is the one field with an optional input: it needs the item, "which
only the merchant's callers hold, so `item` is optional and its absence answers false". Today:

- `requireRunAction` passes no item, so no `ShopAgent` write ever reads `changeWorkflow` through
  the gate the preamble describes.
- `merchantAttachWorkflow` reads the field itself, over an open run only, and turns false into
  `ItemDone`; it refuses a closed order and an item at zero units before that, with its own
  tags, so those two blank cells are never reached through the field.
- The member pages call `runActions` without an item and get `changeWorkflow: false`, which they
  never read.
- The test special-cases the field: it calls the attach callable, expects one of three tags on
  a blank cell, and skips closed runs ("attach is the closed item's picker, whose rule is
  `lineItemState`").

So the column is a merchant-only, item-reading, attach-gated field in a table whose contract is
"the callable checks the same field with the same inputs". The field is true in two rows and
there are three places that decide it (the row, `lineItemState.attachable`, and the attach
callable's own order of checks).

Two ways to make it honest. Keep the column and say in the preamble that Change workflow is read
by the attach callable alone, that its refusals are the attach results (`OrderClosed`,
`NothingToMake`, `ItemDone`), and that the member result is always false. Or move it out:
`lineItemState` already decides the picker for every item kind and already carries `attachable`
for the closed kind; an `open` kind with `changeable: boolean` would put the one item-reading
rule on the one item-reading symbol, and the run set would read the run and the order only, as
the task set does.

**Recommendation 12.** Keep the column; the order page reads the run's actions in one object and
the test drives it in one loop. Add the paragraph above to the preamble, and give the `item`
parameter's JSDoc the same sentence. Question 9 asks whether to move it instead.

## 6. Rules the matrices should decide

Each of these is a cell whose value the spec inherited from the code. They are listed here so the
decision is made on purpose. Each is a question at the end.

### 6.1 Block by a member whose team is later in the workflow

"m" for Block is a member whose team holds a current task: "a hold is placed by whoever is
stuck". A finisher who sees the wrong stone go into step 1 cannot Block the run; they can write a
note. The narrower gate is defensible (the team doing the work is the team that stops it) and so
is the wider one (anyone who can see the run can say stop; Unblock still needs the current team or
the merchant). Today: narrow. Question 5.

### 6.2 Change workflow on a run someone has started or holds

Row `open | open | yes | some → changeWorkflow M`: Change workflow is offered on a blocked run,
and on a started one. It deletes the run with its tasks, its Start and Done records, its note and
its block, and the attach JSDoc says "confirmation is the UI's job". The spec for the confirm
belongs in `Screen.ts`'s controls table, and today no row there says when Change workflow asks.
Question 6.

### 6.3 Reopen at the open-run ceiling

Reopen on a done run makes it open again. `RunState`'s table says an open run counts against
`ShopLimits.maxOpenRuns`, and reconcile declines a create at the ceiling. Today: `reopenTask`
reads no ceiling, so a shop at the ceiling can go one over by reopening. The reconcile review
(`docs/reconcile-spec-review-research.md`, section 3) noted it; the matrix should carry the
answer, since the matrix is where Reopen's gate is. Question 8.

### 6.4 What a merchant's Done on an unstarted task records

Row `open | open | no | ready | - → start m, done M m`: the merchant may not Start ("a merchant
marking it started on their behalf would put a name on work nobody has begun") but may mark
Done, and today Done backfills the started columns with the same actor, so the record then says
the merchant started and finished it. That is consistent (the merchant's own name, not a
worker's), and it is only written on `markTaskDone`. The matrix preamble should say it next to
the sentence about Start, or the two read as a contradiction.

**Recommendation 13.** One sentence after the Start bullet: a Done without a Start records the
actor as the starter too, so a merchant's Done names the merchant twice and no worker once.

### 6.5 An archived order

`OrderState` is two fields, `cancelledAt` and `fulfillmentStatus`, and `orderIsOpen` is their
negation. Shopify has a third end: archive (`closedAt`), which usually follows fulfilment but a
merchant can set by hand on an unfulfilled order. Today: an archived, unfulfilled order is open
to Baton and its runs stay workable. That is probably right (archiving is filing, not ending the
work) and it is a rule the `orderIsOpen` JSDoc should state so nobody adds the field by reflex.
The reconcile review decided refund and archive are not stops for reconcile (decision 13); the
same sentence covers the action sets. Question 10.

## 7. Smaller findings

- **"m" in a `blocked yes` row of `runActions` can only be the current team**, since Block
  itself needed one; Edit reason and Unblock are offered to the current team as a whole, not to
  who set the hold. The preamble says "a second Block would overwrite who held it" but never says
  a teammate may lift it. One clause.
- **`cancel` on `units none`.** Offered; reconcile would close the run as `item_removed` on its
  next pass anyway, and a Cancel that lands first records `merchant_cancelled`. Both are closes.
  Fine, and unsaid; the `units` column exists only for `changeWorkflow`, so say that at the
  column.
- **The parser's completeness check is sound but undocumented on the symbol.** `pnpm spec check`
  holds both tables total (`gaps`) and disjoint (`overlaps`). The `runActions` preamble says the
  first ("refuses a table that leaves a state without a row") and neither says the second. One
  clause each.
- **The `assign` result tag.** A filled `assign` cell answers `Assigned`, not `Ok`; the test
  special-cases it. Either the callable answers `Ok` like every other run write, or the preamble
  says it has its own result (it carries `TeamNotFound`, which no other write has). The latter;
  one clause.
- **The member list rebuilds `current` on the client.** Today the workflows list passes
  `current: true` for every task on a row (the query only returns current tasks) and
  `reopenBlockedBy: null`, and the Blocked view passes every task as current to get `unblock`.
  The matrix preamble says `current` and `reopenBlockedBy` are "facts about other rows, which is
  why the object computes them rather than the page". The list's `RunListTask` carries neither,
  so the page asserts them from what it knows about the query. That is correct today and fragile:
  a list that one day includes a waiting task would offer Start on it. Not a spec gap; a note
  for the list's JSDoc, or `RunListTask` gains `current`.

## Recommendations, gathered

1. Contract paragraph rewritten as the upper bound; the three screens that offer less named; the
   three non-`NotAllowed` refusals listed on the matrix.
2. The three values of `reopen` defined in the preamble.
3. A "v" cell letter in `runActions` for the visible member; the parser and `expand` learn it;
   the side test folds into the table.
4. The outsider named in both preambles.
5. The row fixture described on `runActions`.
6. The unassigned task: every "m" blank, every "M" holds; one sentence and one test.
7. The task set never reads the item; a Done in the zero-units window stands.
8. The three `downstream` words defined; "started" includes done.
9. `RunState`'s table keeps its five non-action rows and links the matrices for the verbs.
10. The block table keeps its three non-action rows and links the `blocked yes` rows.
11. The Undo sentence reworded after question 3.
12. Change workflow's gate described: attach callable only, attach results as refusals.
13. A Done without a Start records the actor as the starter.

## Decisions

Answered 2026-10-02 in Plannotator: every recommendation accepted. No open questions remain.

1. The set is an upper bound: no screen offers a verb whose field is false, the server refuses
   every write whose field is false, and a screen may offer fewer verbs when its JSDoc says why.
2. `runActions` gains the "v" letter for the visible member; the parser and `expand` learn it and
   the side test folds into the table.
3. Undo is the whole team's, as the matrix and the code have it; the verbs table is reworded
   (recommendation 11).
4. The eight verb rows leave `RunState`'s table and the two verb rows leave the block table; both
   link the matrices (recommendations 9 and 10).
5. Block stays with the current team.
6. Change workflow stays offered on a started or blocked run, with a confirm when any task has a
   Start or Done record or the run is blocked; the confirm rule goes on the controls table in
   `Screen.ts`.
7. The merchant's Done, Put back and Reopen stay offered on a task with no team; stated and
   pinned (recommendation 6).
8. Reopen is allowed at the open-run ceiling; written on `RunState`'s ceiling row and in the
   Reopen bullet of `taskActions`.
9. Change workflow stays a column of `runActions`, documented as attach-gated
   (recommendation 12).
10. An archived Shopify order is open to the action sets, stated on `orderIsOpen`.

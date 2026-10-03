# The workflows list row: what it shows and in what order

Written 2026-10-02. The question: what should one row of the member's workflows list
(`src/routes/shop.$shop.workflows.index.tsx`) show, and where. Today the row is hard to read. This
doc works the question from what a row is, what the member asks of it, and how merchants name
things, then proposes a layout, with trade-offs and the decisions taken.

## What the row shows today

```
Signet ring  Cast and engrave · #1002
Engrave crest · Step 2 of 3 · Engraving

Leather journal  Stamp and bind · #1002
Stamp monogram (Engraving) · Stitch spine (Leather) · Step 2 of 3

Engraved cutting board  Cut, engrave and oil · #1021  [Quantity changed · 2 → 1]
Cut and sand · Step 1 of 3 · Woodshop
```

Line one (`renderItem`): the item title and variant in bold, then `workflow name · order number`
subdued, then the quantity badge after a Shopify change. Line two (`Domain.runRowLine` plus
`detailLine`): every current task on the member's teams, then one of: the step (`Step k of n`), the
block reason, `Started · <who>`, or `In progress`. The team appears in one of three places:

- after the step, when the member is on several teams and the list is not narrowed to one
  (`showTeam`) and the row's tasks share a team: `Step 2 of 3 · Engraving`;
- in parentheses after each task, when the row's tasks are on different teams:
  `Stamp monogram (Engraving)`;
- nowhere, otherwise.

Line one has no length limit and wraps. Line two is cut to two lines by `.run-detail-line` in
`styles.css`.

## Why it is hard to read

**1. Five names of four kinds, all bare, all joined by the same `·`.** A row prints an item title
(from Shopify), a workflow name, task names and a team name (all chosen by the merchant), and an
order number. Nothing but position says which is which, and the position moves (point 3). In the
screenshot, `Engrave crest · Step 2 of 3 · Engraving`: "Engraving" is a team, but it reads as well
as a task or a workflow. The names carry no type of their own: a merchant can call a team
"Engraving", a task "Engrave" and a workflow "Engraving".

**2. Line one mixes what the thing is with how it is made.** The item and the order say which piece
this is. The workflow name says which recipe it follows. These are different questions on one line.

**3. The same fact moves.** The team sits after the step, in parentheses after each task, or
nowhere, depending on the member's team count, the Team filter and whether the step is parallel.
The slot after the task names holds the step, a block reason, a starter, or "In progress". A reader
cannot learn the row's layout because the layout changes from row to row.

**4. The simple setup collides.** The plainest way to set Baton up is to name everything after the
product: product "Leather wallet", product tag `Leather wallet`, workflow "Leather wallet", workflow
tag `Leather wallet`. Then line one reads `Leather wallet  Leather wallet · #1015`. The seed fixture
avoids this on purpose: the JSDoc on `workflows` in `e2e/fixture.ts` says workflows are "Named after
the process, not the product ... a workflow named like its product reads as the item said twice."
So the screens have only been reviewed under the naming that hides the problem. The at-cap seed
workflow, "Heirloom leather journal, hand-stitched spine, embossed monogram", is itself named like
a product.

**5. Parallel tasks share one state.** With two current tasks on one row, line two names both but
states only the first (`detailLine` reads `tasks[0]`). If a teammate started Stamp monogram and you
started Stitch spine, the row is in Started by you (`Domain.listStateOf`) and line two says
`Started · <teammate>`.

**6. The clipped part is the fixed part.** Line two puts the free-length names first and the short
fixed words (`Step 2 of 3`, the starter) last, so the two-line cut removes the step and keeps the
names.

**7. No quantity.** The row never says how many to make unless the quantity changed. "Signet ring
×2" is two rings; the row reads the same as one.

**8. Under a search the row loses its state.** The row says less because the state filter says it:
a row you started omits "Started by you". A search ignores the state (`Domain.RunQuery`), so under
a search rows from every state mix and nothing tells them apart.

## What a row is

- **One row is one run**: one item (all its units) on one order going through one workflow. Baton
  makes one run per item, so for the member a row is _a piece to make on an order_.
- **The vocabulary already names the run by its item.** The run's screen word is "the item's
  workflow" (the `run` row of the vocabulary in `src/lib/domain/ShopWork.ts`). The item is the
  noun; the workflow name is not needed to say which run.
- **The list is about tasks.** The state filter is task states from the member's seat (Started by
  you, Started by others, Ready). Start, Done and Put back are task verbs. Only Block and Unblock
  are run verbs. Done or closed is already one entry per task, led by the task name.
- **Item and order identify the piece almost always.** Item title, variant and order number
  identify a run except when one order has two items with the same title and variant, which
  Shopify keeps as separate lines when their properties differ (two signet rings, two engravings).
  The workflow name does not tell those apart either; the properties do, and they are on the
  workflow page.
- **The workflow name identifies nothing the item does not, except in one case:** when the workflow
  is not implied by the product. Example: the seed's Rush order workflow, or an item the merchant
  attached to a different workflow on a multi-match. There the workflow name is news.

## How the member and the merchant think about it

This section is reasoning from how small production shops work, not from interviews. It should be
checked with a merchant.

**Shop-floor practice.** In job-shop manufacturing the worker's list (a dispatch list, or the
traveler that goes with the piece) shows the job or order number, the part, the quantity, the
current operation and the work centre. The routing (the sequence of operations, Baton's workflow)
is behind the job, and its name is rarely on the worker's list. Routings are commonly kept per
part, so a routing's name is often the part's name. That is the merchant's simple setup above:
workflow named after the product is the norm in manufacturing, not an edge case. Shared routings
named after a process ("Engrave and finish" for several products) also exist. The row has to read
well under both.

**The member's questions, in the order they ask them:**

1. What do I do next? The task.
2. On what? The item, its variant, how many.
3. For which order? The order number: what is on the bin, the ticket and the packing slip.
4. Is someone on it, or is it stopped? Mostly answered by the state filter; the row adds who or why.
5. How far along is it? Step k of n. Rarely needed to act.
6. Which workflow? Rarely needed, except when it is not implied by the product.

**How they talk.** "I'm on the leather wallet for 1015." The item and the order number are the
shared handle. Baton stores no customer name (orders-sync decision), so the order number is the
only order handle both sides have, and it is in Shopify's admin, on the packing slip and in the
search (`Domain.searchTerm` matches order number, item title, variant and SKU, not the workflow
name). The merchant's order page shows each item card titled by the item, with "<name> workflow"
under it, so the merchant also leads with the item.

**Competitors.** Route to Ship's My Work (the only competitor with a per-department worker view)
groups by order ("Order #1055"), leads each task row with the product title in bold, and puts
`department → step` under it in grey, with a status pill. It shows no "step N of M"; it shows unit
progress ("3 of 5 done"). Its pipelines are named by process or product family ("Engraving",
"Leather"). Kanbanify leads with the order number and makes the stage the board column. Maker's
Production View and MakerBatch lead with the product and show the order number per row. None shows
a workflow name on a worker's card. Evidence: `refs/route-to-ship/_assets/CN7m4-iSrJQDEAE=.png`,
`refs/kanbanify/_assets/CLXwy4yY-5QDEAE=.png`, `refs/makers-production-view/_assets/queue.png`.

**Conclusion.** The member's identity for a row is item + order number, as the request suggested.
The task is what to do. The workflow name and the step are context about the recipe and belong
together, below the rest.

## Lengths

| name            | source   | limit                                   |
| --------------- | -------- | --------------------------------------- |
| item title      | Shopify  | 255 characters                          |
| variant title   | Shopify  | option values joined, can be long       |
| workflow name   | merchant | 64 (`NAME_MAX_LENGTH`)                  |
| task name       | merchant | 64 (`NAME_MAX_LENGTH`)                  |
| team name       | merchant | 32 (`TEAM_NAME_MAX_LENGTH`)             |
| order number    | Shopify  | short (`#1002`), prefix/suffix settable |
| tasks in a step | merchant | up to the workflow's task limit         |

None of these fit on one phone-width line at the limit. The rule this doc proposes: **free-length
names get clamped; short fixed words never do.** The order number, the step, the state and the
quantity sit in places a clamp cannot reach. Every full name is on the workflow page one tap away
(the page heading is the item title; the subtitle is `<workflow> workflow · <order>`), and in the
row's accessible label.

## Approaches

### A. Keep the layout, fix the rules

Keep both lines; give the team one place (always in parentheses after its task); move the step
before the names; show the quantity. Cheapest. Leaves points 1, 2 and 4: the workflow name still
sits beside the item, and the simple setup still prints the product twice.

### B. Three lines, one kind of fact per line (recommended)

```
Signet ring · Gold ×2                                   #1002   ⋯
Engrave crest
Cast and engrave · Step 2 of 3
```

- **Line one, the piece:** item title and variant in bold, `×n` when n > 1, the quantity badge, and
  the order number in a cell of its own at the end of the line. The title clamps to two lines; the
  order number never shrinks.
- **Line two, the work:** one line per current task on the member's teams. Each line: the task
  name, its team in parentheses when the team is shown, then that task's own state where the
  filter does not already say it (`Started by Ana`). A blocked row puts `Blocked · <reason>` here
  instead, because a block is on the whole run. Each task line clamps to one line, and the state
  goes before the names clamp (the name is the part that is cut).
- **Line three, the recipe:** workflow name, then `Step k of n`, subdued. One line, the workflow
  name clamped, the step never.

The simple setup then reads:

```
Leather wallet                                          #1015   ⋯
Cut and stitch
Leather wallet · Step 1 of 3
```

The product appears twice, but on different lines that mean different things: the piece, and the
recipe it follows. A process-named workflow reads the same way. Typography carries the kind: line
one strong, line two regular, line three subdued.

A parallel step, for a member on both teams:

```
Leather journal                                         #1002   ⋯
Stamp monogram (Engraving)
Stitch spine (Leather) · Started by Ana
Stamp and bind · Step 2 of 3
```

Trade-offs: rows are taller (three lines for the common single-task row, against two today), so
fewer rows per screen. Gained: every slot means one thing on every row; parallel tasks each say
their own state (point 5); nothing fixed is clipped (point 6).

### C. Two lines, workflow name off the row

```
Signet ring · Gold ×2                                   #1002   ⋯
Engrave crest · Step 2 of 3
```

Like B with line three dropped and the step moved to the end of the task line (one task) or onto
its own short line (several). The workflow name stays on the workflow page. Densest and simplest.
Loses the one case where the workflow name is news (Rush order, a changed workflow), and the
request says the workflow name probably belongs on the row.

### D. One row per task

The list becomes a task list: a parallel step on two of the member's teams is two rows, each with
one task, one team, one state and a menu with bare verbs. This is what the state filter and the
verbs already describe, and what Done or closed already does. Trade-offs: one piece appears on
several rows; a block (on the run) shows on each; the counts in the metrics strip become task
counts, not piece counts; the list stops being "workflows". A larger change in the read
(`RunRepository.listRuns`), the counts and the vocabulary. Not recommended now: parallel tasks on
two of one member's teams are uncommon, and B's one line per task gets most of the benefit.

### Rejected: hide the workflow name when it equals the item title

String comparison fails on the near misses merchants will produce ("Leather wallet" against
"Leather wallets", "Wallet", "Leather wallet (black)"), and a rule that shows the name on some rows
and not others is point 3 again.

## Recommendation

Approach B, with these rules:

1. Line one is the piece: item title · variant, `×n` when n > 1, the quantity badge, the order
   number pinned at the end. Title clamped to two lines.
2. Line two is one line per current task: task name, `(team)` when the team is shown, that task's
   state where the filter does not imply it. Blocked replaces the task lines' state with the
   reason, once. One line each, clamped.
3. Line three is the workflow name and `Step k of n`, subdued, one line.
4. The team is shown by one rule, always in the same place: when the member is on more than one team
   and the list is not narrowed to one, or under a search, or when the row's tasks are on different
   teams.
5. Under a search, each task line says its state, because the filter no longer does.
6. Done or closed rows take the same line one (piece and order) so the two lists look alike; line
   two is the task and who did it, line three the workflow.
7. The seed names at least one workflow after its product so the simple setup is on screen when
   reviewing.

## Decisions

All eleven recommendations were accepted on 2026-10-02. The plan is
`docs/workflows-list-row-plan.md`.

1. **Line one is the piece.** Item title · variant, `×n` when n > 1, the quantity badge, and the
   order number. Nothing else; the workflow name leaves line one.
2. **The order number is pinned at the end of line one** in a cell of its own, so it stays visible
   whatever the title's length.
3. **The workflow name gets its own subdued line with the step** (approach B):
   `<workflow> · Step k of n`.
4. **One line per current task, each with its own state.** A blocked row says
   `Blocked · <reason>` once, in place of the tasks' states.
5. **The team is `(Team)` after its task**, shown by one rule: the member is on more than one team
   and the list is not narrowed to one, or the list is a search, or the row's tasks are on
   different teams.
6. **`×n` on line one when the quantity is more than one.** The quantity badge stays for a change.
7. **Truncation:** the item title clamps to two lines; each task line and the workflow line clamp
   to one; the order number, the step, the state and the quantity are never clipped. Full names are
   in the row's accessible label and on the workflow page.
8. **Done or closed rows lead with the piece** like open rows; line two is the task and who did it
   (or why the workflow closed), line three the workflow.
9. **The page stays Workflows.** Each row is "the item's workflow".
10. **One seed workflow is renamed after its product** ("Cast and engrave" becomes "Signet ring"),
    and the fixture comment that says workflows are named after the process to avoid a doubled
    name is rewritten.
11. **No naming suggestion in the workflow editor** for now; the row reads well under any naming.

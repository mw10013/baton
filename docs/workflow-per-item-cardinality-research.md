# How many workflows can one line item run?

Research date: 2026-09-16. Scope: whether Baton should cap the number of workflows a
single line item enters by tag match, what the cap should be, and what happens when it
is exceeded. No application code changed. Revisits, and in one place reverses, the
"Duplicate tags across workflows are fine" section of
[workflow tags: concept, UX, and implementation spec](./workflow-tags-concept-and-ux-research.md)
and Decision 12 of [order detail UX research](./order-detail-ux-research.md).

## Conclusion

1. **There is no unbounded case today.** Runs per line item are already capped by the
   run key `unique (lineItemId, workflowId)` and by the 50-workflow shop ceiling. The
   product question is not "bound it or not"; it is whether fan-out beyond one is a
   feature or a hazard.
2. **Recommend a cap of one workflow per line item.** One physical unit follows one route.
   Everything a second parallel run could express is expressed better as more steps in
   one workflow, and the things it cannot express (ordering between the two runs) are
   exactly what a shop floor needs.
3. **Any cap greater than one is the worst of both worlds.** It still needs the overflow
   error state, and it still needs the multi-run UI, and no number between two and fifty
   has a principled reason behind it.
4. **Exceeding the cap is a decision, not an error.** When two active workflows match
   one item, start nothing and surface the order as _Choose a workflow_, a sibling of
   the _No workflow_ badge the orders index already has, not a variant of it. The
   existing attach picker resolves it. No new "failed" run status.
5. **Close the definition-side accident.** With a cap of one, two active workflows
   sharing a tag is a misconfiguration by construction. Refuse it at Apply or Turn on
   with a named conflict. This reverses the earlier "do not warn, do not enforce" call,
   which was correct under all-match and is wrong under one-per-item.
6. **Route to Ship is not a reason to keep fan-out.** It documents all-match in one help
   sentence, never illustrates it, and nobody else in the set does it at all.

## Baton today

### The mechanics

- A workflow carries a JSON array of tags; the only uniqueness on the table is the
  case-insensitive name (`src/lib/ShopAgent.ts:452-461`). Nothing constrains tags across
  workflows.
- `WorkflowLimits` is `{ maxWorkflows: 50, maxSteps: 20, maxTags: 20 }` and its JSDoc
  says they bound loops, not plan tiers (`src/lib/Domain.ts:390-400`).
- Matching is two halves: `canStart` (on, has steps, every step's team resolves) and
  `matchesLineItem` (placed since Turn on, tag intersection, units still to make)
  (`src/lib/WorkflowRunRepository.ts:118-160`).
- Reconcile inserts the **cross product** of line items × matching startable workflows
  (`src/lib/WorkflowRunRepository.ts:886-912`). Five items on an order, each matching two
  workflows, is ten runs. No arbitration, no priority.
- The only dedupe is the run key: `on conflict (lineItemId, workflowId) do nothing`
  (`src/lib/WorkflowRunRepository.ts:788-791`). So the count per item is idempotent per
  workflow and bounded by the number of active workflows, which is bounded by 50.
- Manual attach skips the tag and date halves but not `canStart`, and refuses only a
  duplicate of the same workflow (`src/lib/ShopAgent.ts:2463-2506`). The picker lists
  every active workflow with steps, unfiltered against runs the item already has, so the
  second attach of the same one surfaces _"That workflow is already attached to this line
  item."_ (`src/routes/app.orders.$orderId.tsx:44`, `:1219-1280`).
- `duplicateWorkflow` deliberately drops tags, and the comment says why: a copy carrying
  the original's tags "would start a second, near-identical run on the same line item
  the moment it was turned on" (`src/lib/WorkflowRepository.ts:236-245`). The code already
  treats that outcome as an accident to be avoided.

### The states that exist

- `RunStatus` is `pending | active | done | cancelled` (`src/lib/Domain.ts:2028-2033`).
  There is no failed or error status, and the user is right that one was never designed.
- `RunFlag` is the "needs attention" channel on a run: `item_removed`,
  `quantity_changed`, `order_cancelled`, `order_deleted`, `blocked`, `order_fulfilled`
  (`src/lib/Domain.ts:2051-2058`). A later flag overwrites an earlier one; a person
  clears it.
- `ProductionState`, derived per order and never stored, is `no_workflow |
in_production | ready_to_ship | shipped | cancelled` (`src/lib/Domain.ts:1298-1305`).
  `no_workflow` renders as a warning badge on the orders index and as _"No workflow on
  this item"_ on the order page (`src/routes/app.orders.$orderId.tsx:135`, `:1214`).

That last one matters: an order-level "this needs a merchant decision" state, with a
visible home and a resolving action next to it, already exists. It is one enum value
away from covering ambiguity.

### What the UI already assumes

Every surface is written in the singular and nothing enforces it:

- Create dialog: _"Add this tag to your products in Shopify. Their items will follow this
  workflow."_ (`src/routes/app.workflows.index.tsx:385`)
- Tag dialog: _"items on those products follow this workflow"_
  (`src/components/WorkflowTag.tsx:151-153`)
- Order page: one run card per item, a second stacks below "correct, but visibly the
  exception" (order detail UX research, Decision 12).

So the product already speaks one-per-item and merely tolerates many. The confusion the
user describes is the gap between what the copy promises and what the engine does.

## What a second run on the same item actually means

This is the first-principles part. A run is one workflow applied to one line item, steps
copied in, each step owned by a team, steps ordered by stage so a step is ready only when
every earlier stage is done (`src/lib/ShopAgent.ts:360-380`). Two runs on the same line
item are therefore two **independent** step ladders over the same physical unit, with
**no ordering between them**.

Take the canonical fan-out example from the earlier doc: a product tagged both
`engraved` and `giftwrap`. Under all-match it gets an Engraving run and a Giftwrap run.
Both first steps are ready at once. The engraving bench and the wrapping bench each see
the same necklace in their queue at the same moment. The wrapping team can mark
"wrapped" before the engraving team has started. Nothing in Baton can say "wrap after
engrave", because ordering lives inside a run, not between runs.

The same shop expressed as one workflow, _Engraved gift_: Engrave → Wrap → Pack, three
steps, three teams, correct ordering, one card on the order, one _done_. That is the
model Baton already has, and it is strictly more expressive for this case than two
parallel runs.

The honest argument **for** fan-out is combinatorics: with N optional add-ons, composing
in workflows means up to 2^N workflows, while fan-out means N add-on workflows that stack.
Two things weaken it for the target segment:

- Small and medium made-to-order shops have a handful of routes, not a lattice of
  add-ons. Route to Ship's own scale story is 15 departments and 13 staff, and it still
  illustrates every order landing in exactly one pipeline
  (`refs/route-to-ship/index.md:389-390`).
- In Shopify, add-ons are usually **their own line item** (an "Add engraving" product) or
  a **line-item property** (the engraving text), not an extra product tag. An add-on line
  item gets its own run under the cap-of-one model with no fan-out at all. So the case
  fan-out was kept for mostly does not arrive as a product tag in the first place.

What fan-out costs, concretely:

- Two teams pulling the same unit at the same time (above).
- Item "done" means "every run done", which the order page has to explain.
- The member queue shows what look like duplicate cards for one item.
- Every count on the orders index (in production, waiting on) is inflated by runs, not
  units.
- The attach picker cannot mean "the workflow for this item"; it means "another one".
- The turn-on dialog's "N waiting orders" count is per workflow and says nothing about
  overlap.

None of these are bugs today. They are the reason the UI keeps trying to look like one
and the user keeps finding it confusing.

## What the comparable products do

From the mirrored sites under `refs/`. These are marketing pages and App Store listings,
not in-app behaviour, and the silences are part of the finding.

| App                     | Matching                                   | Multiple pipelines per item       | Overflow / conflict copy | Pipeline cap by plan                              |
| ----------------------- | ------------------------------------------ | --------------------------------- | ------------------------ | ------------------------------------------------- |
| Route to Ship           | Product tags (order tags claimed once)     | Yes, per in-app help; never shown | None                     | Unlimited on every tier including Free            |
| Kanbanify               | Manual drag, product type "coming soon"    | Structurally no: one board        | None                     | 1 board on $7; multi-board on unreleased $12 tier |
| Maker's Production View | Has-customization filter, one group-by key | No: one group at a time           | None                     | One plan, no caps                                 |
| MakerBatch              | Line-item property key mapping, group-by   | No pipelines                      | None                     | Caps items in production, not groups              |
| BenchCue                | Underscore naming convention on properties | No pipelines                      | None                     | One plan                                          |

Route to Ship in more detail:

- The in-app help says a product with multiple tags "is routed to that pipeline … each
  line item is routed independently" (route-to-ship tag routing research, quoting
  `app.routetoship.com/help`). That is the only place all-match is stated.
- The marketing site, the demo, the case study, and every screenshot caption show one
  order in one pipeline, and it asserts "No rules to maintain, no exceptions to chase"
  (`refs/route-to-ship/index.md:385`). A grep across ~60 mirrored files for
  fallback, priority, first match, multiple pipeline, untagged, or override finds
  nothing.
- Pipelines are unlimited on the free plan; tiers gate seats and orders
  (`refs/route-to-ship/pricing.md:83`, `:91-92`). A cap on pipelines has no monetisation
  precedent to anchor to, and Baton's `WorkflowLimits` JSDoc already says it is not a
  plan tier.

Reading across: nobody in the set treats multi-pipeline membership as a feature worth a
sentence of copy. Route to Ship implements it and hides it. Kanbanify, the one app with a
real board cap, caps at one. Following Route to Ship here would be following an
undocumented edge of its implementation, not its product.

## The options

### A. Status quo: all-match, design for one

Keep the cross product. Keep the singular copy. Rely on merchants not doing the thing.

- Cheapest. Zero code.
- The copy promises something the engine does not do, which is the confusion being
  reported.
- The shop-floor hazard (two teams, one unit) stays open and silent.

### B. Cap greater than one, say five, with an overflow error

- Needs the overflow path: a new state or flag, copy, an orders-index badge, a
  resolution action.
- Still needs the multi-run item card, the multi-run queue, the "done means all done"
  explanation, because two through five are allowed.
- "Five" has no story. Any merchant who hits it is already in the incoherent zone from
  run two onward.
- Strictly more work than C for no identified use case.

### C. Cap of one per line item (recommended)

Enforce at run creation: an item may have at most one non-cancelled run. Tag match that
finds exactly one startable workflow creates it. Tag match that finds two or more creates
nothing and marks the order _Choose a workflow_. Manual attach on an item with a live run
is a replace: cancel the run, start the chosen one.

- Model matches copy. "A product's tag picks its workflow" becomes literally true.
- The order page's one-card-per-item design stops being an assumption.
- The attach picker becomes "Set the workflow for this item", which is what it looks
  like, and "Change workflow" when one is already running.
- Reuses the orders-index warning slot and the attach picker for resolution; no failed
  run status.
- Cost: the definition-side conflict check, the ambiguity branch in reconcile, one enum
  value, one badge, two lines of copy, and a change to the earlier doc.
- Loses: stacking add-on workflows on one item. See the section above for why that case
  is weaker than it looks and is served by add-on line items or by more steps.

## Design of C in more detail

Enough to evaluate, not an implementation plan.

**Run creation.** In reconcile, group matches by line item. Zero matches: nothing, as
now. One match: insert, as now. Two or more: insert nothing, record the ambiguity. The
run key stays; the new rule is "at most one live run per `lineItemId`", where live means
not cancelled, so un-cancel and re-attach keep working and a cancelled run does not block
a replacement.

**The state.** Add `multiple_workflows` to `ProductionState`, distinct from
`no_workflow`. The two must not share a name or a badge: `no_workflow` is normal, since
a line item does not need a workflow at all (plain items on a mixed order have none and
that is correct), while `multiple_workflows` is a configuration the merchant has to
resolve. Orders-index badge: _Choose a workflow_, warning tone. Order page, on the item:
_"Two workflows match this item: Engraving and Rush. Choose one."_ with the picker
already open and limited to the matching workflows. Choosing creates the run with
`source: "manual"`, the existing override path, and the badge clears because the item
now has a live run.

**Existing runs win.** When a second workflow with an overlapping tag is turned on while
an item already has a live run, nothing changes for that item. No flag, no error.
Turning on a workflow never disturbs work in flight, which is the invariant the code
already keeps for edits.

**Definition side: refuse a shared tag, thought through.** The rule is: a workflow that
is active, or is about to become active, may not carry a tag that another _active_
workflow carries. Off workflows are exempt on both sides. Walking the cases:

- _Turn on_ B while A (on) has the same tag: refused. _"“engraved” already starts
  Engraving. Turn Engraving off first, or change this tag."_ Both actions are one
  click away and the message names them.
- _Apply_ on B while B is on and A (on) shares the tag: refused with the same message.
  The draft keeps the tag; nothing is lost.
- _Apply_ on B while B is off: allowed. The conflict is checked again at Turn on, so
  nothing slips through, and a merchant can finish a replacement before swapping.
- _Turn on_ A again while B has since taken the tag: refused, symmetric. The message
  now names B. There is no ordering trap: whichever is on holds the tag.
- The swap a merchant actually performs: build Engraving v2 off with the same tag,
  turn v1 off, turn v2 on. Two clicks, no refusal on the path, and no window where both
  are on. The gap between the two clicks is safe: orders arriving in it match nothing
  and get `no_workflow`, which the next reconcile after Turn on (already run for
  waiting orders) picks up.
- Rename, the other real case: a merchant retags the catalogue from `engraved` to
  `engrave`. Edit v1's tag to the new value and Apply. No second workflow, no conflict.

A warning instead of a refusal was considered and rejected: with a cap of one, a shared
tag has no working outcome, so a warning would only postpone the same message to every
affected order.

**What the check cannot do.** Baton has `read_products` and no product write, and never
reads a product's tags outside an order. A product carrying two different workflows'
tags is invisible until an order arrives. That is why the runtime `multiple_workflows`
state is needed even with the definition-side check, and why the check is a
convenience, not the guarantee.

**Replace on attach.** An item with a live run must be movable to a different workflow,
because a run on the wrong route should not be allowed to finish. The affordance is
_Change workflow_ on the run card, in place of _Attach workflow_ on an item that has
none; nothing is disabled, so the merchant never has to work out why a control is grey.
Choosing a workflow cancels the current run and starts the new one in one transaction.
Two guards:

- Confirm when the current run has any finished or started step, naming what is lost:
  _"Engraving has 2 of 4 steps done. Change to Rush anyway? Those steps will not carry
  over."_ A pending run with nothing started needs no confirmation.
- The cancelled run stays on the item's history, as cancelled runs already do, so the
  trail is not erased. The run key `unique (lineItemId, workflowId)` means re-choosing
  a workflow this item once ran is un-cancel rather than a fresh run, which is the
  existing semantics and is fine here.

**The per-shop ceiling.** `WorkflowLimits.maxWorkflows` (`src/lib/Domain.ts:390-400`)
is already a named constant. It counts every workflow row, on or off
(`src/lib/WorkflowRepository.ts:1060`), so a shop with several under construction
spends the same budget as one with them all running. Fifty is a loop bound and will
likely rise; the only decision here is that off workflows keep counting, since the
bound exists for row and scan size and off workflows still occupy rows. Nothing in this
doc depends on the number.

## Trade-offs, side by side

| Concern                                  | A: all-match            | B: cap of five | C: cap of one                 |
| ---------------------------------------- | ----------------------- | -------------- | ----------------------------- |
| Copy matches engine                      | No                      | No             | Yes                           |
| New state needed                         | No                      | Yes            | Yes, one enum value           |
| Multi-run item card and queue needed     | Yes (exists, tolerated) | Yes            | No                            |
| Two teams pull one unit simultaneously   | Possible                | Possible       | Impossible                    |
| Add-on stacking via tags                 | Yes                     | Yes, to five   | No; use steps or add-on items |
| Principled number                        | n/a                     | No             | Yes                           |
| Matches Route to Ship's documented model | Yes                     | No             | No                            |
| Matches every competitor's shown model   | No                      | No             | Yes                           |
| Work                                     | None                    | Most           | Moderate                      |

## Recommendation

Choose C. Set the cap at one, make a double match a visible merchant decision rather
than a silent pick or a silent fan-out, refuse shared tags across active workflows at
Apply and Turn on, and let a running workflow be changed from the run card. Update the
tags concept doc's "Duplicate tags across workflows are fine" section to point here.

Is the app anemic at one? Not for the segment. The segment's routes are few, the add-on
case arrives as line items or properties, and the one competitor that does more never
says so. Baton's advantage was never "more pipelines per item"; it is that the item card,
the queue, and the order state tell one coherent story. A cap of one is what lets them.

## Decisions from review, 2026-09-16

Reviewed in Plannotator by the product owner. All five open questions closed.

1. **Cap of one per line item.** Accepted.
2. **Add-on evidence.** None known. The "more steps in one workflow" answer stands.
3. **Double match.** A decision, not a deterministic pick: start nothing, badge the
   order, merchant chooses. The first draft called the state _Needs a workflow_; that was
   rejected as misleading, because it reads as "you forgot one" and an item does not need
   a workflow at all. It is now `multiple_workflows` / _Choose a workflow_, distinct from
   `no_workflow`.
4. **Shared tag across active workflows.** Refuse, not warn, provided the message says
   what to do next. The case walk above is the check that the off-workflow exemption
   does not trap the merchant.
5. **Replace on attach.** The first draft said refuse and add replace later. Rejected: a
   run on the wrong workflow must be stoppable and replaceable, not left to finish. Now
   _Change workflow_ on the run card, cancel plus start in one transaction, with a
   confirmation only when work has begun. Disabling the control instead was raised and
   rejected as harder for the merchant to decode.
6. **Change on a done run.** Not offered. `done` is live for the index, so the
   server would cancel it to make room, but rewriting finished work to `cancelled`
   for a rework is not what "change" means and the run cards do not model rework.
   The order page hides _Change workflow_ on a done run; the server stays permissive.
7. **The 50-workflow ceiling.** Already a constant; expected to rise; off workflows keep
   counting. No change now.

## Staleness to watch

- `docs/workflow-tags-concept-and-ux-research.md` lines 85 to 119 argue for all-match and
  against any uniqueness check; superseded by this doc if C is adopted.
- `docs/order-detail-ux-research.md` Decision 12 "assume one, do not enforce" becomes
  "enforce one".
- `docs/orders-operational-surface-research.md` lines 169 to 186 cite order-workflow
  indexes and a `type` column that no longer exist after commit `83c5d46`.
- Line cites in the tags concept doc (`WorkflowRunRepository.ts:905-913`) have drifted;
  the fan-out is at `:886-912` as of this date.

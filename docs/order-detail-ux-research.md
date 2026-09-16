# The order detail page: what it is for, and what it should look like

Research date: 2026-09-15. Scope: `src/routes/app.orders.$orderId.tsx`, the page a
merchant opens for one order. The question was raised as "this is cluttered and I
can't see what's going on" and is answered here as a set of binding decisions plus
the reasoning behind them.

Companion docs: `docs/orders-operational-surface-research.md` (why Orders is the
merchant's operational surface at all, and the index that leads here),
`docs/merchant-run-intervention-research.md` (what a merchant may do to a running
step and how it is recorded), `docs/member-ux-research.md` (the worker's queue and
work page, whose vocabulary this page must not contradict).

Four rendered directions are kept at `docs/order-detail-ux/directions.html` — open it
in a browser. The decisions below are the synthesis; the file is the argument.

## Decisions (2026-09-15)

These are binding. Where the discussion further down disagrees, this list wins, and
`docs/order-detail-ux-implementation-plan.md` is written against it.

1. **The page is a status surface with intervention available. It is not a work
   surface.** The merchant does not do production work; they answer "where is this
   order, and do I need to step in". Consequence: **no step action is promoted to a
   primary button.** `Mark done`, `Reopen`, `Note`, `Assign team`, `Block`, `Cancel`
   are all interventions and all live behind one affordance. At rest the page has no
   primary action except the page-level `Resync from Shopify`.

2. **One card per line item.** The `Line items` wrapper section
   (`app.orders.$orderId.tsx:1154`) is deleted. Each item is a top-level
   `s-section` headed by its own title, as `renderLineItem` already builds
   (`:980`). Two headings for one thing, the outer one in schema vocabulary, is the
   single worst thing on the current page.

3. **A collapsed item card is at most four rows tall.** Title row, personalization
   row, step trail, current-step line. This is a hard budget, not a preference — see
   "How many line items" below. Anything else on the card is behind the disclosure.

4. **The order workflow is named by _when_, never by _what_.** Its section heading
   is the workflow's own name; its subtitle is the invariant, `Starts when every
item is made`. The words "Shipping", "Packing", "Fulfilment" never appear as a
   label we generate. The order workflow is agnostic and is only defined by "every
   item run on this order is done".

5. **The order workflow section appears only when it has something to say**: there
   is an order run, or the merchant can act on why there isn't one. The five
   explanatory sentences of `orderWorkflowLine` (`:573`) survive as a one-line
   subtitle, not a paragraph in an otherwise empty card. When the order workflow is
   off and nothing is wrong, the section is absent.

6. **Badges hold a closed vocabulary; strips hold sentences.** `active`, `pending`,
   `done`, `cancelled`, `Blocked`, `Item removed` are badges. A merchant's block
   _reason_ and a step _note_ are free text up to 1000 characters
   (`Domain.StepNote`, `Domain.ts:440`) and get a full-width strip that wraps,
   clamps, and carries its own action. `flagLabel` (`:140`) stops concatenating the
   reason into the badge.

7. **"`<Workflow>` started for N items" is deleted** (`startedLines`, `:654`). It
   restates the cards below it in the quietest type on the page. Its replacement is
   an order-level summary line that appears only when it earns its place: more than
   one item, or at least one item needing attention.

8. **The aside stays order-level.** No quantity: quantity belongs to the line item
   and already renders as `×1` on the card; two copies is two things to keep in
   agreement. One row is added — `Items · 3 items, 7 units` — and only when the
   order has more than one line item.

9. **`Attach workflow` is a disclosure, not a control.** It is rare and deliberate;
   today it renders as a permanent empty `s-select` on every item on every visit
   (`:1044`). It becomes a plain link that reveals the picker, placed once per item
   card.

10. **A step has one note, and it stays one note.** No thread, no per-message
    attribution, no history. See "Notes and block reasons" — this is the decision
    with the most tension in it and the one most worth arguing with.

11. **Block stays run-level, and the UI says which step it is about.** The write is
    `merchantBlockRun({ runId, reason })` (`ShopAgent.ts:2745`) and the flag lives on
    `WorkflowRun.flagDetail`. On a three-stage run "blocked" with no step named is
    ambiguous; the strip therefore reads `Blocked · <the ready step's name>` from the
    run's ready step, without any schema change.

12. **Assume one workflow per item; do not enforce it.** The item card renders one
    run inline. A second run on the same item stacks below it with its own trail —
    correct, but visibly the exception. Nothing in the data model changes
    (`unique (lineItemId, workflowId)` still permits several).

13. **`Manage` stays an inline expanding region.** Not an `s-menu` — a menu cannot
    hold the block-reason field or the note editor. Not an `s-modal` — that is
    direction D's drawer, and it costs a click on every action plus its own
    live-update handling when a webhook lands while it is open. The container was
    never the problem; the weight was. Three changes carry it:
    **(a)** a step with no available action renders as **one line**, not a bordered
    box — `3 Polish · Jewelry · Waiting on step 2` — so only the ready step and
    finished steps earn a full row with controls; **(b)** run-level `Block` /
    `Unblock` / `Cancel` group below a divider, under the step list; **(c)** the
    disclosure stays open across re-renders, which it already does (`managing` is
    React state and the subscription repaints without remounting), with `managing`
    pruned against the runs actually present so a run cancelled from another session
    cannot leave a stale id behind.

## The answers that drove the decisions

Four questions were put to the merchant-side owner on 2026-09-15. The answers are
recorded here because every decision above traces to one of them.

### How many line items does an order carry? — unknown, and the design must survive both

The honest answer is that it depends on the vertical, and Baton targets small and
medium made-to-order shops across several:

- **Jewellery, furniture, custom fabrication.** One to three items, high value, long
  cycle, deep personalization per item. The item card's `customAttributes` grid is
  the point of the page.
- **Apparel, embroidery, print.** Five to twenty lines is routine, because sizes and
  colours are separate variants of one design. The personalization is thin or
  identical across lines, and the merchant reads the order as a batch.

So there is no single p50 to design for. What there is, is a shape: **the page must
be correct at one item and survivable at fifteen.** That is the origin of decision 3.
Concretely, at fifteen items:

- A four-row card is roughly 120px; fifteen of them is two or three scrolls. That is
  a list. The current card, with `Manage` closed, is already five to eight rows once
  personalization and a flag are present; with `Manage` open it is one screen per
  item, which is not.
- The order-level summary line (decision 7) stops being redundant and starts being
  the only way to know the state of the order without scrolling: `15 items · 2
blocked · 9 made · waiting on Engraving, Packing`.
- Side-by-side phase columns — direction B in `directions.html` — stop working,
  because the left column holds fifteen items and the right holds four steps. **B's
  model is adopted; B's two-column rail is not.** The phases stack vertically.

> The one thing that would settle this properly is data, and we do not have it. If a
> beta shop's orders are consistently one item or consistently twelve, revisit
> decision 3 — but note that revisiting it means relaxing a budget, which is cheap,
> not restructuring the page.

### Does the merchant complete work here? — no

The merchant intervenes. Workers claim and complete steps on the work page
(`src/routes/shop.$shop.work.$runId.tsx`). This is the answer that most changes the
design, and the current page gets it wrong: `manageRows` renders `Mark done` as
`variant="primary"` on the ready step (`:790`), which is the visual grammar of
"this is what you came here to do".

It is not. It is the merchant reaching past a worker. Every merchant write on this
page is an exception:

| Write                       | When a merchant uses it                                     |
| --------------------------- | ----------------------------------------------------------- |
| `merchantCompleteStep`      | The worker finished but didn't mark it; the shop is closing |
| `merchantUncompleteStep`    | Marked done by mistake                                      |
| `merchantSetStepNote`       | Telling the bench something, or correcting a note           |
| `merchantBlockRun`          | Something outside the shop is holding the job up            |
| `merchantDismissFlag`       | The block is resolved                                       |
| `cancelRun` / `uncancelRun` | The job is off, or back on                                  |
| `attachWorkflow`            | The tag rules did not catch this item                       |
| `assignRunStepTeam`         | A team was deleted, or the wrong one was picked             |

None of those is a daily verb. All of them belong behind one affordance per run, and
the page at rest should read as though there is nothing to click — because usually
there isn't. The exception is the **attention states**, which are not interventions
but unblocking a stuck system: a step whose team no longer exists already renders its
`Assign team` picker outside `Manage` and always visible (`stepTrail`, `:257`), and
that stays exactly as it is.

### Is the order workflow "shipping"? — no, and it is optional

It is agnostic. The only stipulation the system makes is that **every item run on the
order is done** before it can start. Shops will commonly use it for packing and
shipping, especially on multi-item orders, but calling it Shipping in the UI makes a
promise the product does not keep — a shop that uses it for QA, photography,
invoicing, or a final inspection would be reading a lie.

It is also optional: the order workflow is a per-shop singleton whose switch is
`activatedAt` (`Domain.isActive`, `Domain.ts:601`), and `orderWorkflowBlocker` already
distinguishes `off` from `no_steps` from `no_team`. Decisions 4 and 5 follow: name it
by its own name, subtitle it with the invariant, and show the section only when it
carries an order run or an actionable blocker.

This also resolves the "workflow card vs order workflow card" confusion without
inventing vocabulary. They are not two kinds of card. They are two phases of one
order, and the second is labelled with the condition that starts it.

### Can an item carry more than one workflow? — in principle yes, in practice one

Small and medium shops will attach one workflow per item; more than one is
manageable but incoherent as a default. The data model keeps allowing it
(`unique (lineItemId, workflowId)` spans every status, so a cancelled run keeps its
key). The UI stops _designing for_ it: one run renders inline as part of the item
card, a second stacks below with its own trail and its own disclosure. Decision 12.

## Notes and block reasons

This is the area with a real unresolved tension, and it deserves its own section.

### What exists today

- **A step note is one nullable field.** `WorkflowRunStep.note: StepNote | null`
  plus `noteByRole: ConnectionRole | null` (`Domain.ts:2205`, `:2211`). `StepNote` is
  trimmed text capped at **1000 characters** (`Domain.ts:440`). There is no author id,
  no author email, and no timestamp on the note — deliberately. `stepNoteLine`
  (`Domain.ts:2259`) prints `Note (Merchant): …` when a merchant wrote it and plain
  `Note: …` otherwise, because on the worker's own screens the author is a teammate
  by default and naming them would say nothing.
- **Anyone with access to the step can overwrite it.** Not only the claimer. The work
  page offers `Note` / `Edit note` on every step it renders
  (`shop.$shop.work.$runId.tsx:256`), and the merchant can always overwrite through
  `merchantSetStepNote`. Last write wins, silently.
- **A block reason is one optional field on the run's flag**,
  `RunFlagDetail.reason: StepNote` (`Domain.ts:2104`), alongside `by: Actor` and
  `flagAt`. Also 1000 characters, also overwritten by the next block.

### The tension

The stated intent is **no audit trails**. A note thread is an audit trail wearing a
friendlier name: several messages, each needing an author, a timestamp, and an
ordering, which is a new table and a new read on every card that shows a step. Once
it exists, "who said that and when" becomes answerable, which is exactly the
capability being avoided.

But the realistic usage described is a medium shop where several workers touch one
step and the note becomes a back-and-forth. A single overwritable field handles that
_badly_: worker B opens the editor with worker A's text in the box (which is the
current, deliberate safeguard — you see what you are about to destroy) and either
appends by hand or wipes it.

### The decision, and what it costs

**One note per step. No thread.** (Decision 10.) With three consequences for the UI,
all of which are cheap and none of which is a schema change:

1. **Render a note as a paragraph, not a line.** Wrapping text, clamped to three
   lines with `Show more`, in a quiet block under the step — not a truncated
   single-line `s-text` competing with the step's own name.
2. **Keep showing the current text in the editor before it is overwritten.** This is
   already how `noteEditor` works (`:674`) and it is the whole of the safeguard. It
   is worth a JSDoc that says so inline rather than pointing at a doc — the current
   comment at `:670` cites `docs/…-research.md`, which `CLAUDE.md` forbids.
3. **The character budget is visible.** A 1000-character field that silently refuses
   the 1001st character while someone is typing a paragraph is a bad afternoon.
   Show a remaining count once the draft passes ~800.

What it costs: if shops do start using notes conversationally, the field will fill
with hand-rolled threads (`- ben: waiting on stones / - amy: stones in`). That is the
signal to revisit, and revisiting means accepting a table and an audit trail. It is
a product decision, not a UI one, and should not be made pre-emptively to make this
page nicer.

## What the current page does, fault by fault

Numbered to match `directions.html`.

1. **`<Workflow> started for N items`** (`:654`, rendered `:1128`). Restates the cards
   below it. Deleted — decision 7.
2. **A `Line items` card wrapping line-item cards** (`:1154`). Two headings, outer one
   in schema vocabulary. Deleted — decision 2.
3. **`Workflow` and `Order workflow` render identically** (`renderRun`, `:927`, used by
   both sections) and are told apart only by their section heading. Resolved by
   decision 4: the phase is named by when it starts.
4. **The block reason is concatenated into a badge** (`flagLabel`, `:140`, rendered
   `:936`). A `s-badge` with 200 characters of merchant prose in it will stretch the
   row and push `Manage` off screen. Decision 6.
5. **`Manage` unfolds a form per step** (`manageRows`, `:733`): a bordered box per
   step, each with a state line, an optional note, a note editor, up to three
   buttons, and an `Assign team` picker; then a block reason field, a `Block`, and a
   `Cancel`, all inside the card being read. Decision 1 and the disclosure design
   below.
6. **`Attach workflow` is always on screen** (`:1044`). Decision 9.
7. **Nothing on the page says what is happening right now.** Stage, trail, status,
   flag, actor and time are all present and all weighted the same. The trail marks
   the ready step bold (`stepTrail`, `:257`) and that is the only signal. Decision 3's
   fourth row — a current-step line — is the fix.

## The chosen design

A single vertical page. No two-column rails, no tabs, no drawer in the first pass.

```
#1008  [In production]                      View in Shopify   Resync

3 items · 1 blocked · 1 made · waiting on Engraving          ← only when it earns it

┌─ Signet ring                    ×1   signet-ring     [⋯] ─┐  ← one card per item
│  Size 10 · Metal Gold                                      │
│  ⚠ Blocked · Engrave crest                                 │
│    Crest file missing from the order — asked the customer. │  ← strip, wraps, clamps
│    lead@m.com · 1:59 PM                        [Unblock]   │
│  ✓ Cast — ● Engrave crest — ○ Polish       stage 2 of 3    │
│  Now  Engrave crest · Engraving · since 1:59 PM            │  ← status, no button
│  Attach workflow                                           │  ← link, reveals picker
└────────────────────────────────────────────────────────────┘

┌─ Order workflow                                      [⋯] ─┐
│  Starts when every item is made · waiting on 1 item        │
│  ○ Inspect — ○ Pack — ○ Print label — ○ Hand to carrier    │
└────────────────────────────────────────────────────────────┘
```

Three rules make it work.

**The disclosure holds everything, and it is one disclosure per run.** `⋯` opens the
step list that `manageRows` builds today, unchanged in content and much calmer in
form: one row per step, the step's state line, its note as a paragraph, and its
actions as equal-weight secondary buttons. `Mark done` loses `variant="primary"`. The
run-level `Block` / `Unblock` / `Cancel` sit at the bottom of the disclosure, below a
divider, and a step with no available action is one line rather than a bordered box.
It stays an inline expanding region — decision 13 says why, and what shrinks inside it.

**The attention states stay outside the disclosure.** An unassigned step's `Assign
team` picker and the empty-team warning are already rendered inline by `stepTrail`
and stay there. They are not interventions; they are the system telling the merchant
it cannot proceed. The blocked strip joins them.

**The `Now` line is read-only.** `Now · <step> · <team> · since <time>`, or
`Waiting for every item to be made` on a pending order run, or `Done · N stages` on a
finished one — the same vocabulary `manageStateLine` already produces (`:186`), lifted
to the card so the merchant reads it without opening anything.

## Rejected

- **A step table for the whole order** (direction C). One row per step of every run,
  with a stripe for attention. It is the only direction that is genuinely constant
  in density, and it is right — for the **orders index**, where "what is blocked
  across every order" is the morning view. On one order it reads as a database and
  squeezes personalization into a group row. Not now; keep it in mind for the index.
- **A drawer for all intervention** (direction D). Correct in principle — the page
  never reflows, and editing gets room — but it costs a click on every action, needs
  its own live-update handling when a webhook lands while it is open, and gives us
  two surfaces to keep in agreement. Revisit if the disclosure's step list keeps
  growing.
- **Side-by-side Making / Shipping columns** (direction B as drawn). Killed by the
  fifteen-item case. The phase _model_ is adopted; the rail is not.
- **Labelling the order workflow "Shipping".** See above.
- **A note thread.** See above.

## Open questions

Not blocking the plan. Each would change one decision.

1. **Should made items collapse?** On a twelve-item order, once eight items are done,
   should their cards fold to a single line (`Signet ring ×1 — made`) with the rest
   expanded? It is the difference between a scroll and a glance, and it is the
   cheapest thing that makes decision 3's budget hold at scale. Default assumed in
   the plan: **no collapse in the first pass**, because a wrong fold is worse than a
   long page.
2. **Does the aside earn its width?** `Order details` costs roughly 20rem inside an
   already narrow embedded admin frame. Everything in it is reference material —
   Placed, Payment, Fulfillment, tags, Last synced — read once. Folding it to a
   single row under the page heading would give the cards the full width. Default
   assumed: **keep the aside**, it matches Shopify's own order page.
3. **Does the merchant open this page to check, or to fix?** If checking dominates,
   the disclosure could start as a menu with no inline step list at all. If fixing
   dominates, the disclosure should be a region that stays open across re-renders.
   Default assumed: **checking**, from decision 1.
4. **Should personalization be behind the disclosure on thin-personalization
   verticals?** On an apparel order, `Size M · Colour Navy` on twelve cards is
   twelve rows of noise; on a ring it is the point. There is no signal in the data to
   branch on. Default assumed: **always shown**, capped at one wrapping row.

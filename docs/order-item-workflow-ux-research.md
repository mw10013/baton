# Order item workflow UX research

Date: 2026-09-16. Source: `src/routes/app.orders.$orderId.tsx` at commit `e0502ae`, the two
screenshots reviewed on 2026-09-16 (order #1562 with an unrouted item, order #1563 with one run),
and the Polaris App Home web component docs in `refs/shopify-docs/docs/api/app-home/latest/`.
Follows `order-detail-ux-research.md` (2026-09-15); this one narrows to the line item card and
the vocabulary around it. Mockups: `order-item-workflow-ux/mockups.html`.

## Decisions (2026-09-16)

Answered in conversation, in this order.

1. **Verb is "Start workflow".** Not attach, not assign. Clicking creates a run, so the verb
   names the outcome. The domain and code keep `attach` (`AttachResult`, `attachMutation`);
   only merchant-facing copy changes.
2. **The page-level production badge leaves the detail page.** It stays on the orders index,
   where an aggregate is what you scan. On the detail page every state is per item.
3. **Change workflow moves inside Manage.** It is a rare intervention, so it lives with the
   other interventions. The card at rest has no workflow-changing control.
4. **The trail becomes one "where is it now" line.** `Step 1 of 1 · Cut · E2E Bench ·
since 3:10 PM`. The full step list is only inside Manage.
5. **Manage is a secondary button in the card header**, top right, the way the Shopify order
   page puts actions on its Unfulfilled card. It toggles the disclosure below.
6. **An item with no run shows the select and Start button at rest.** No reveal step. Help
   text appears only when there are zero candidate workflows.
7. **The `supplemental-start` prose is removed.** Both the "No workflow's product tags match"
   sentence and the "An item matches more than one workflow" sentence. The item card carries
   that information.

## What is wrong today, fault by fault

Line numbers are from `app.orders.$orderId.tsx` at `e0502ae`.

1. **"No workflow" is said three times on one screen.** The page badge (`:1465`), the
   `supplemental-start` paragraph (`:1499`), and the card paragraph (`:1373`). Each one is
   an order-level statement about an item-level fact.
2. **The order badge lies on mixed orders.** `productionState` (`Domain.ts:1495`) ranks
   `no_workflow` below `in_production`, so an order with one running item and one unrouted
   item reads "In production" and the unrouted item is only found by scrolling. On a
   single-item order the badge is right but redundant with the card. There is no reading
   where the badge on this page adds something the cards do not.
3. **The `supplemental-start` slot breaks the layout.** It renders above the main column
   only, so the first card starts lower than the aside. The Polaris page layout has no slot
   for a full-width preamble at the `base` inline size.
4. **`Attach workflow`, `Change workflow`, and `Manage` are `variant="tertiary"` buttons**
   (`:1386`, `:1230`). Polaris tertiary is "low emphasis, for less important actions" and
   renders as plain text until hover. A control the merchant must find to do the one thing
   the card exists for cannot be low emphasis. Shopify's own cards put their actions in the
   header as secondary buttons or a `⋯` menu.
5. **Change workflow is always visible and weighted like Start.** Same button, same
   position, different label depending on `live` (`:1391`). Changing is rare and
   destructive (the modal warns steps do not carry over); it should not sit at rest on
   every card.
6. **The card mixes four vocabularies with no visual grouping.** Line item facts (title,
   quantity, SKU, tags), then run name plus status badge plus Manage, then the trail
   (`1 Cut (E2E Bench) Stage 1 of 1`), then the Now line (`Now · Cut · E2E Bench`). The
   trail and the Now line say the same thing twice in different notations, and the trail's
   notation (stage number, bold for ready, `✓` and `●` marks, team in parentheses) is a
   code the merchant has to learn. `stepTrail`'s own JSDoc admits `Stage N of M` is "one
   restatement too many".
7. **The status badge says `pending`.** A run status in schema vocabulary, lowercase,
   beside a workflow name. Merchants read "pending" as "waiting for approval".
8. **Product tags render as badges on the item row** (`:1349`). They are why a workflow
   matched, which matters when nothing matched or two did, and not otherwise. On a routed
   item they are noise beside the SKU.

## Vocabulary

Three candidates for the verb. The choice affects every button, the modal heading, and
the ambiguity sentence.

| Verb            | Reads as                                | For                                                                                                                                     | Against                                                                                                                                     |
| --------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Start workflow  | "Begin making this item under E2E Rush" | Names the outcome (a run exists, a team gets a queue entry). Works as a one-click button on a tag match. Pairs naturally with "Cancel". | Slightly wrong on a workflow whose first step is not ready yet, though today every attach is immediately startable (`WorkflowCannotStart`). |
| Assign workflow | "Set this item's workflow to E2E Rush"  | Shopify admin vocabulary (assign staff, assign location). Neutral.                                                                      | Implies a setting on the item, not an action. Merchants then expect "Unassign", which does not match cancelling a run with done steps.      |
| Attach workflow | Today's word                            | Matches code.                                                                                                                           | Not a word merchants use for work. "Attach" is what you do to a file.                                                                       |

**Recommendation: Start.** Adopted as decision 1. The rename is copy-only: `Attach workflow`
becomes `Start workflow`, the ambiguity sentence's "Choose one" becomes "Choose one to
start", the confirmation modal keeps "Change workflow?" because that is still what it does.

The word for the thing the workflow is on: **item**, never order. Every merchant-facing
sentence that says "on this order" is wrong under the one-run-per-item model from
`workflow-per-item-cardinality-research.md`.

## The order badge on a multi-item order

The question that exposed the problem: two items, one running, one not. Today the badge
says "In production" because of the ranking in `productionState`.

| Option                                  | On the mixed order                                 | Cost                                                                                                                |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Drop from detail, keep on index         | No badge. The unrouted card carries its own state. | The page loses a one-glance "is anything wrong" signal. The index still has it, and this page is one scroll.        |
| Count items: "1 of 2 items not started" | Honest.                                            | A second state machine for copy, and the counts need a new SQL form in `listOrders` to stay in sync with the index. |
| Keep today's aggregate                  | Misleading on mixed orders.                        | Zero work.                                                                                                          |

**Recommendation: drop it.** Adopted as decision 2. The badge's ranking is right for the
index, where a merchant filters by state and an order with a decision pending should surface.
On the detail page the merchant is already looking at the items. If a page-level attention
signal is wanted later, it should be the cross-item summary line the previous research
sketched (`3 items · 1 blocked`), rendered only when an item is not in the happy state.

`multiple_workflows` and `no_workflow` remain in `ProductionState` for the index. The detail
page stops rendering `PRODUCTION_STATE_BADGE` and the two `supplemental-start` paragraphs.
The `ready_to_ship` banner and the partial-fetch banner stay, but move to the `s-banner` slot
pattern the page already uses for critical errors, so they sit inside the main column and
do not offset the aside.

## The card

### Polaris constraints that shape it

- `s-section` has `heading`, `padding`, and a default slot. No header action slot. A button
  in the header therefore means: `s-section` without `heading`, and inside it an inline
  `s-stack` with `justifyContent="space-between"` holding `s-heading` and the button. This
  is what the Shopify admin's own order cards look like; it is legal in the component model,
  just not a built-in.
- `s-button` variants: `primary` (one per page), `secondary` (medium emphasis, outlined),
  `tertiary` (low emphasis, text-like). Card actions are secondary. Tertiary is for things
  like Cancel beside a submit.
- `s-menu` exists for a `⋯` action menu. It is the right home for several rare actions;
  Manage is one action, so a labelled button beats a menu.
- `s-badge` tones: `info`, `success`, `warning`, `critical`, `neutral`. Labels are merchant
  words in sentence case.

### Card at rest, item with a run

```
┌──────────────────────────────────────────────────────┬──────────┐
│ Flow research item                                   │ [Manage] │
│ × 1 · SKU FR-01                                      │          │
│                                                      │          │
│ E2E Rush  [In progress]                              │          │
│ Step 1 of 1 · Cut · E2E Bench · since 3:10 PM        │          │
└──────────────────────────────────────────────────────┴──────────┘
```

Four rows. Header: title and Manage. Facts: quantity and SKU on one subdued line, then the
personalization grid when it exists. Run: workflow name and a status badge in merchant
words. Now: one line that says step position, step name, team, and since when.

What left the card:

- The inline trail and its marks. It is in Manage, one row per step, where the
  `manageStateLine` vocabulary already renders each step's state in words.
- `Stage N of M` as a trailing fragment. Folded into the Now line as `Step N of M`. "Step"
  because merchants count steps; the stage concept (parallel steps) is real but is an
  authoring detail. On a parallel stage the Now line lists both step names:
  `Step 2 of 3 · Engrave, Polish · Bench`.
- `Change workflow`. Inside Manage, at the bottom with Cancel, as a secondary button.
- Product tags. Shown only on an unrouted or ambiguous item, where they explain the match.

Status badge labels, replacing raw `run.status`:

| `run.status` | Label       | Tone     |
| ------------ | ----------- | -------- |
| pending      | Not started | neutral  |
| active       | In progress | info     |
| done         | Done        | success  |
| cancelled    | Cancelled   | critical |

Flags keep their own badge next to it (`Blocked`, `Order edited`, etc.) as today. The blocked
strip stays outside Manage, as the previous research decided.

### Card at rest, item with no run

```
┌──────────────────────────────────────────────────────────────────┐
│ Coconut Coffee                                                   │
│ × 1 · SKU CC-01 · tags: workflow-02                              │
│                                                                  │
│ Workflow  [Select a workflow      ▾]  [Start]                    │
└──────────────────────────────────────────────────────────────────┘
```

No "No workflow on this item." sentence: an empty select with a Start button is the
statement. Product tags are shown here, as plain subdued text rather than badges, because
they explain why nothing matched. When the shop has zero startable workflows the select is
replaced by one subdued sentence with a link: `No workflows can start. Create one.`

Ambiguous item (two tags matched two workflows): same layout, the select is pre-populated
with the matches only, and one sentence above it: `Two workflows match this item: Engraving
("e2e-engraved") and Rush ("e2e-rush"). Choose one to start.` The names and tags stay in
the sentence (shipped 2026-09-16, reversing the earlier draft of this paragraph): the tag is
what the merchant would go and change on the product, and the select's options cannot carry
it.

Alternatives considered for the empty item:

| Option                                                  | For                                                                                   | Against                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Select + Start at rest (chosen)                         | One step, no hidden control, reads as a form field which Polaris merchants recognise. | A select on every unrouted card. Acceptable: unrouted is the state that needs action.                                               |
| Secondary "Start workflow" button, then picker          | Card is quiet.                                                                        | Two clicks, and a reveal pattern the rest of the admin does not use.                                                                |
| One-click `Start E2E Rush` when exactly one tag matches | Fastest for the common case.                                                          | Today the exact-one-match case auto-starts on order create, so this state is rare; the card would need two layouts. Keep for later. |

### Manage

Header button toggles the disclosure. The label stays `Manage` in both states and a chevron
flips (down closed, up open). **`aria-expanded` is not available**: measured in the embedded
admin on 2026-09-16, React omits the attribute when false and writes it on the `s-button`
host when true, but the host is not the element carrying the button role, so it never reaches
the accessibility tree. The only other lever, `accessibilityLabel`, _replaces_ the accessible
name, which would rename the control every merchant and every spec addresses by its visible
word. The chevron is therefore the whole state. Today's `Manage`/`Hide` swap
was reviewed on 2026-09-16 and rejected: a `Hide` button in the card header reads as hiding the
card. `Done` collides with `Mark done` below it and `Close` has the same scope problem. The open
panel gets a subdued background (an `s-box` inside the card; Polaris has no way to bleed it to
the card's edge) so it reads as a drawer the button owns, not as more card. On that grey the
step boxes invert their emphasis: the ready step is the one white box, the rest blend in.
Inside, unchanged from the previous research: one row per step with state line,
note, and equal-weight secondary actions; then a divider; then the Block reason field and
run-level actions in one inline row: `Block` (or `Unblock` while blocked), `Cancel run`,
`Change workflow`. Change workflow opens the picker inline
under that row (label + select + Change + Cancel), and the confirmation modal stays. The
button is absent, not disabled, when there is nothing to change to — a shop whose one active
workflow is the one already running. Changing mints a new run, and `managing` is keyed by run
id, so the disclosure closes behind the change; what the merchant wants next is the new
card.

The `Undo cancel` button on a cancelled run stays in the run row, since Manage is disabled
for cancelled runs.

## Layout

With the `supplemental-start` slot empty the first card and the aside start on the same
line. The two prose paragraphs are gone, and the banners (`ready_to_ship`, partial fetch, the
error banner, the order summary line) render as the first child of the main column rather than
in `supplemental-start`, so the column's top edge is the banner's top edge and lines up with
the aside (verified in the embedded admin 2026-09-16). `SocketBanner` is unchanged.

## What this touches

- `app.orders.$orderId.tsx`: `renderLineItem` (card shell, header, facts line, the resting
  picker, and the `workflowPicker` closure both pickers share), `renderRun` (drop Manage and
  Change from the row, badge labels), `stepTrail` → `attentionRows` (the trail row and
  `stepMark` deleted; the unassigned and empty-team rows survive, and it returns null when
  there is neither), `nowLine` (gains `Step N of M`), `manageRows` (gains `Cancel run` and
  `Change workflow`, taken as nodes), the page shell (drop the badge and the two paragraphs).
- Copy in `attachResultMessage` and `changeWarning`: attach → start.
- No domain or SQL change. `ProductionState` and `productionState` stay for the index.
- E2E specs that click `Attach workflow` or read `No workflow on this item.`

## Rejected

- **Keeping the inline trail with clearer marks.** Any notation for "done, in progress, not
  started, ready, parallel" on one line is a code. The Manage rows already say it in words.
- **A `⋯` menu instead of a Manage button.** Menus hide the count of actions and Manage is
  the one action. Revisit if the header grows a second action.
- **Modal for Manage.** Loses live updates while open and puts a second surface over the
  card. The previous research already rejected a drawer for the same reason.
- **Renaming the Shopify order page's badge vocabulary on the index.** Out of scope; the
  index badge is right.

## Answered in review (2026-09-16)

- **The Now line on a run with nothing started** reads `Step 1 of 3 · Cut · Bench` with no
  `since`. Same shape as an active run, so the merchant learns one line.
- **The active badge says `In progress`**, not `In production`. The order-level word stays on
  the index; the item-level word is distinct on purpose.
- **Manage keeps its label in both states and gets a flipping chevron.** See "Manage" above,
  including why the state is the chevron alone and not `aria-expanded`.

Implementation order is in `order-item-workflow-ux-implementation-plan.md`.

- **`Done · N steps` counts stages**, the same N as the open form's `Step k of N`, so the
  number does not change meaning the day the run finishes.
- **The line item section carries no `accessibilityLabel`.** With no `heading` prop,
  `s-section` renders the label as a second hidden heading and screen readers hear the title
  twice (measured 2026-09-16 against the pre-change build, which had one). The `s-heading`
  inside is the section's name; the e2e specs find a card by that heading.
- **The change picker's Cancel drops the item's pending choice.** Both pickers read one
  choice per item, so a pick abandoned in Manage would otherwise preselect the Start picker
  after a later Cancel run.

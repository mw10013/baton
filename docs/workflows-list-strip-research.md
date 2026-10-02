# A metrics strip and a filter row on the workflows list

Written 2026-10-02. The member's workflows list (`shop.$shop.workflows.index`) opens on a
grid of five press buttons, each a state with its count, with the team menu and the search
up in the member bar. The merchant's orders index, redone in the same change
(`docs/list-filter-search-research.md`, decisions of 2026-10-01), opens on a metrics strip of
counts and a filter row of search, Status and Team inside the list's card. The question is
whether the workflows list should take the orders index's shape, and why the last round
did not.

## Why the last round left the two screens different

The list-filter-search research gave the member Proposal C: keep the five states as one
row, join the buttons into one segmented outline, and put a search in the member bar. Its
reasons, and what happened to each:

| reason given on 2026-10-01                                                                | what it argued for                                       | where it stands now                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The member's axis is one axis: every open workflow is in exactly one state                | one control, not a strip plus a select                   | Still true. It argues against a strip **and** a select for the same axis; it does not argue for buttons over a strip.                                                                                                   |
| The orders row mixed three meanings (positions, scopes, Issues); the member's row has one | the orders index needed the split, the member did not    | Still true. The split fixed a conceptual mix the member's row never had.                                                                                                                                                |
| "On a bench tablet the row is the dashboard"                                              | counts stay on the control                               | Still true, and the strip keeps them on the control: a strip cell is a count and a one-click filter.                                                                                                                    |
| The joined segmented row reads as one control                                             | the visual fix                                           | Not built. `.run-state-row` in `styles.css` explains why: Polaris's segmented control is one line that cannot wrap, and joined cells in a wrapping grid leave a hole in the outline and double borders. The gap stayed. |
| A line above the fold is what a bench tablet has least of                                 | team and search in the member bar, not on their own line | Still a cost, but the bar now changes shape by route (`MemberBar`'s `filter` slot) and pushes the screen's controls into chrome that every other member screen uses for "where am I, who am I".                         |

So the decision held on the concept and lost on the drawing. What shipped is the
"five equal boxes that look like a dashboard but behave like radio buttons" that the first
research named as symptom 5, with the joining that was meant to fix it ruled out. The
screenshot is that state: five bordered boxes in a 3 + 2 grid, the chosen one a shade
darker, and the controls that narrow the list in the bar above the page.

## What the strip would change

The orders strip is the metrics-card composition
(`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/metrics-card.md`): each
cell an `s-clickable` with the value's name as a heading over its count, the chosen cell
filled (`background="subdued"`), "selected" in the accessibility label. On the workflows
list the strip would **be** the state filter, not a dashboard beside one:

```
┌ member bar ─────────────────────────────────────────────────────────┐
│ ◆ sandbox-shop-01.myshopify.com                  m@x.com  Sign out  │
└─────────────────────────────────────────────────────────────────────┘
┌ section ────────────────────────────────────────────────────────────┐
│ ▓Started by you▓  Started by others  Ready     Blocked   Done or     │  ← strip, one click
│ ▓17            ▓  0                  77        5         closed 139 │    per cell
│                                                                     │
│ [🔍 Search by order number or item              ] [Team: Any team ▾] │  ← filter row
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ Signet ring  Cast and engrave · #1002                       ··· │ │
│ │ Engrave crest · Step 2 of 3 · Engraving                         │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

Under a search the strip gives way to "N workflows match #1002" and Clear search, and the
Team select is disabled, which is what both screens already do (`Control` in
`src/lib/Screen.ts`, "a search is on").

### For

1. **One drawing for one idea across the two sides.** A count that is also a filter looks
   the same wherever it appears. The merchant who is also a member (the common case in a
   small shop) learns it once. The controls table already describes it as one row: "a
   count of items needing work: a cell on the strip, or a value of the main filter, with
   its count".
2. **It looks like what it is.** A strip cell reads as a number you can click into. A
   grid of bordered buttons with numbers reads as five separate actions. The shape now
   matches the behaviour, which the joined row was supposed to achieve and could not.
3. **The count stops reflowing the label.** A press button's text is "Ready · 77", so a
   count going from 99 to 100 widens the button; `.run-state-row` carries a page of
   measured breakpoints (154 px a cell, 36rem, 23rem) to keep that from changing the
   layout. A strip cell puts the count on its own line under a fixed label, so the grid
   only has to fit the labels. Most of those measurements go.
4. **The member bar goes back to one job.** Search and team move into the section, as on
   orders, and `MemberBar` loses its `filter` slot, which only this screen used. The bar
   becomes the same on every member screen.
5. **The team control becomes the orders index's select.** A labelled `s-select`, "Team",
   in the filter row, rather than a menu button whose JSDoc spends two paragraphs on why
   it carries no count.

### Against

1. **Height.** A cell is two lines (name, count) against one for a press button. At five
   columns the strip is about as tall as one row of buttons plus padding; at three
   columns (a phone) it is two rows of two lines, taller than today's 3 + 2 grid of one-line
   buttons. The filter row then adds a line the bar used to absorb. On a phone the first
   workflow drops by roughly one row's height.
2. **Sticky.** The state row is sticky today (`.run-state-row-sticky`) so a member deep in
   Ready can switch without scrolling up. A two-row strip that sticks takes a third of a
   phone screen. The orders strip does not stick.
3. **"Started by others" and "Done or closed" are long headings.** At three columns on a
   360 px phone each cell is about 100 px, so both wrap to two lines. That is fine in a
   cell (the row grows once, the count does not move it) but it is the tallest version of
   the strip.
4. **Less selected-state contrast.** `background="subdued"` on a cell is a lighter mark
   than the pressed fill. The orders index accepted that, with chips naming the choice
   underneath; the member list would have no chips (see question 4).
5. **Work.** The route's state row, the team menu, three CSS rules, the bar's slot, and
   the e2e specs that find the states by their button names (`member-runs.member.spec.ts`,
   `member-area.member.spec.ts`). No domain or read change, unless question 3 cuts the
   team counts.

### What it does not change

The five states, their order, their labels, the `?state=` key, the default (Started by
you), the counts and how they are read, the search and what it matches, the empty states
and their "Go to" button, the row layout. This is a change of drawing and placement, not
of meaning.

## Alternatives

**B. Keep the buttons, move search and team into the section.** Fixes the bar, keeps the
clunky grid. Half the change for most of the work.

**C. Strip plus a State select, exactly as orders.** The select would duplicate the
strip on a one-axis filter: two controls that must agree, for no value the strip does not
show. The orders index needs its select because Fulfilled, Cancelled and All are not on
the strip; every member state is. Not recommended.

**D. Four cells and Done or closed off the strip**, as a link or a select value, mirroring
orders, where history is off the strip. Done or closed is the member's undo, and its count
is bounded (the last day) and already read. Keeping it a cell costs one column; moving it
costs the undo a click and a new control. Not recommended.

## Recommendation

Do it: replace the press-button grid with the orders index's strip, five cells, the strip
being the state filter; move the search and a Team select into a filter row in the
section, under the strip; cut `MemberBar`'s `filter` slot. Five columns where the section
has room and three below, as on orders. No State select, no chips. The decisions below
settle the details.

## Decisions

No open questions remain. Accepted 2026-10-02: the recommendation above, and these.

1. The strip's extra height on a phone is accepted.
2. The strip is not sticky; `.run-state-row-sticky` goes.
3. The Team select reads "Any team" and lists team names only; `total` and `teamCounts`
   are cut from the read.
4. No chips under the filter row.
5. The strip comes first, then the filter row, as on orders.
6. The Team select is hidden for a member on one team; the search then takes the row.

The implementation plan is `docs/workflows-list-strip-plan.md`.

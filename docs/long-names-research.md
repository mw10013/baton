# One UI across screens, and long names

Written 2026-10-05. Three questions, from the widest down:

1. Screens drift apart: a fix lands on one screen and never reaches its siblings, so the app looks
   and behaves a little differently from page to page. What would hold every screen to one design,
   simply, and enforce it the way the copy table enforces words?
2. Every name Baton prints is either uncapped (Shopify's) or capped at a length that does not fit a
   phone line. How should every screen handle that?
3. What looks off on the member's workflows list row, and how should it change?

Part 1 answers the first. Parts 2 and 3 are the first rule set written under it and the first
screen moved onto it. Earlier decisions are reversed where the evidence says so; each reversal is
listed under [Reversals](#reversals).

# Part 1. One UI across screens

## What drifts, and why

Baton has a spec for the words on a screen (the copy table on `CopySlot`) and for which control
does which job (the controls table on `Control`), and `pnpm spec check` and `scripts/rules-lint.ts`
hold every screen to both. It has no spec for **shape**: how a list, a row, a strip, a filter row or
a page is built. Each route builds those itself from Polaris's layout primitives (`s-grid`,
`s-stack`, `s-box`, `s-query-container`), picks its own spacing, and explains its choice in its own
JSDoc. So a decision lives in one route's prose, and the next route re-derives it, differently.

Counted in `src/routes/` and `src/components/` today:

- **8 `gap` values** (`small-500`, `small-300`, `small-200`, `small-100`, `small`, `base`, and two
  pairs) and **8 `padding` values** for what is, on screen, about three distances: between lines
  of one thing, between things, and none.
- **11 different `gridTemplateColumns`**, and **three breakpoints** for the same "side by side or
  stacked" decision: 480px (the workflows list's filter row), 560px (the orders index's filter
  row), 600px (the orders index's strip).
- **The metrics strip twice.** The orders index and the workflows list each build one. The orders
  index goes from five columns to three; the workflows list is always three, and its JSDoc argues
  why it is "Not five where there is room, as on the orders index". The same component, two
  implementations, the difference defended in prose.
- **Two list frames.** The merchant's indexes put the list in `s-section padding="none"`, which is
  Shopify's resource-list and index-table composition. The workflows list puts a bordered `s-box`
  inside a padded `s-section`: a card in a card, and under a search two of them. At 375px the
  double frame costs 32px of every line.
- **Four overflow mechanisms** (Part 2), written for four places, none shared.
- **Row emphasis that does not render.** `s-text type="strong"` shows at regular weight (Part 3),
  in twelve places. Shopify's own resource-list composition uses `s-heading` for a row's title.

None of these is a bug on its own screen. Together they are the "a little different on every
page" effect: the spacing, the frame, the breakpoint and the weight of the same kind of thing
change as you move between screens.

## First principles

- **A screen is an instance of a template, not a design.** Shopify's App Home patterns name the
  templates a Shopify app is made of (`refs/shopify-docs/docs/api/app-home/latest/patterns/templates/`:
  Index, Details, Homepage, Settings) and the compositions they are built from (`compositions/`:
  Index table, Resource list, Metrics card, ...). Every Baton screen is already one of them: the
  orders index, the workflows index, the teams index, the members page and the workflows list are
  Index; the order page, both workflow pages and the team page are Details; the home page is
  Homepage. A merchant moving from the Shopify admin to Baton, and a member moving between Baton's
  screens, should meet the same anatomy each time.
- **Consistency is one implementation, not a shared intention.** Two routes that agree to build a
  strip the same way will drift; two routes that render the same `Strip` component cannot. The copy
  spec works because a word change starts at one row. A shape change has to start at one component.
- **Routes decide content; parts decide layout.** A route knows what the orders are and which
  filter is on. It should not know that a row's lines are 4px apart or where the filter row
  stacks. When a route can pick a gap, it will pick a different one.
- **Fewer choices, fixed.** Three distances, one breakpoint, one frame per list, one way to fit each
  kind of text. A choice nobody can make is a choice nobody can make differently.
- **Polaris first.** Where Polaris has the shape (`s-table`, `s-heading lineClamp`, `s-section
padding="none"`), use it rather than reproduce it. Baton's own parts exist only where Polaris has
  no component, and they are built from Polaris primitives in the composition docs' arrangement.
- **Simple.** No design-token layer, no Storybook, no visual-diff service. A small folder of parts,
  one table, one lint rule and one page to look at.

## Proposal: the parts table

**1. A `template` column on the Screens table** (`Domain.ts`): `index`, `details`, `homepage` or
`editor` (the workflow editor, Shopify's form-with-save-bar case). `pnpm spec check` already
verifies each row's route file; it would also verify that the route renders its template's shell.

**2. A parts table on `Screen.ts`**, beside the copy and controls tables. One row per part: its job,
the component, the templates and screens that use it, what it fixes (spacing, frame, breakpoint,
text fit), and what it never does. The rows that cover today's screens:

| part          | job                                                                             | component (new unless noted)                                            | used by                                       |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| index section | the list's frame: one card, padding none, the strip, filter row and list inside | `IndexSection`                                                          | every index                                   |
| strip         | the metrics strip: counts that are also the main filter                         | `Strip`                                                                 | orders index, workflows list                  |
| filter row    | main filter, search, secondary filter; stacks below one breakpoint              | `FilterRow` (wraps `ListSearchField`, existing)                         | orders index, workflows index, workflows list |
| search line   | "N match <q>" and Clear search, replacing the filters                           | `SearchLine`                                                            | every index with search                       |
| index table   | the merchant's rows                                                             | `s-table` (Polaris)                                                     | merchant indexes                              |
| resource row  | the member's rows: head, body lines, menu beside the head                       | `ResourceRow`                                                           | workflows list (open, done, closed rows)      |
| show more     | the deeper read                                                                 | `ShowMore`                                                              | workflows list; any list past one page        |
| empty line    | one sentence in the list's place                                                | `EmptyLine`                                                             | every list                                    |
| text fits     | name, clamp, token, prose, fixed words (Part 2)                                 | `Name`, `Clamp`, `Token`, `Prose` (existing), `ClampedProse` (existing) | every screen                                  |
| details card  | a section of a details page, heading and body                                   | `s-section` (Polaris)                                                   | details pages                                 |

The parts live in `src/components/screen/`. Each part's JSDoc holds its rule: why three columns,
why that breakpoint. That reasoning moves out of the routes' JSDoc, and the routes `{@link}` the
part, as AGENTS.md asks of every rule.

**3. Three distances and one breakpoint, inside the parts only.**

- `small-300` between the lines of one thing;
- `base` between things and around a section's content;
- `none`;
- one container breakpoint, 480px of the section, for every "side by side or stacked" switch.

These are constants in `src/components/screen/`. The parts use nothing else.

**4. A lint rule: routes compose, parts lay out.** `scripts/rules-lint.ts` refuses, in
`src/routes/`, the layout primitives (`s-grid`, `s-stack`, `s-box`, `s-query-container`) and the
props that choose a layout (`gap`, `padding*`, `gridTemplateColumns`, `className`, `style`). Content
components (`s-text`, `s-heading`, `s-paragraph`, `s-badge`, `s-button`, `s-link`, `s-table`, and the
form fields) stay allowed. A screen that needs a shape no part has gets a new part and a row,
the way a new word gets a vocabulary row. This is what stops the drift: a route cannot choose a
different gap because it cannot choose a gap.

**5. A kit page.** A dev-only route that renders every part once, filled with the seed's worst
cases: 255-character titles, 64-character names, a 1000-character reason, a long email, a
20-task step. It renders at both sides' widths. It is where a part change is reviewed, and the
screenshots of it at 375px and 1280px go in the research or plan for that change. One page shows
whether the app is consistent, so nobody has to walk every screen.

**6. The order of work for any UI change**, in AGENTS.md beside the copy rule: a shape change starts
at the part's row, then the part, then the kit page, then the screens. A route-only change is a
change that has skipped its row.

What it costs:

- **Migration.** The two largest routes (`app.orders.$orderId.tsx`, 1,545 lines; the workflow
  editor, 1,015) carry most of the layout code, and details pages vary more than indexes.
- **Less freedom per screen**, which is the point.
- **A lint rule** that needs an allowlist while screens move across.

### Alternatives considered

- **A written UI guide only** (a style doc or a JSDoc of conventions). Cheapest. It is the state
  today in effect: each route's JSDoc is a convention, and conventions are what drifted. Nothing
  refuses a route that ignores it.
- **Spacing lint only** (refuse spacing values outside the three). Catches the eight gaps, not the
  two strips or the two frames: those differ in structure, not values.
- **Visual regression tests** (screenshot assertions per screen). They catch change, not
  inconsistency: a screen that was always different passes. They are also brittle against
  Polaris's CDN script, which updates under the app. The kit page gives the looking without the
  brittleness.
- **Replace Polaris web components with a React design system.** Out of scope, and it would leave the
  embedded admin inconsistent with Shopify's.

Recommendation: the parts table, the lint rule and the kit page, phased (question 5). The member
side moves first, starting with the workflows list in Part 3, because it has the most hand layout
and the fewest screens.

# Part 2. Long names

Screenshots are in `docs/long-names-research/`. Each was taken against the seeded dev store, signed
in as `lead@m.com` (on every team). The proposed row is a DOM mock injected into the live page
(`proposed-mock.js`), rendered with the real Polaris components and the app's CSS:

- `today-blocked-375.png`, `today-blocked-1280.png`: the Blocked filter today.
- `today-search-375.png`: a search for `#1030`, the seed's names at the 64- and 32-character caps.
- `proposed-375.png`, `proposed-1280.png`: the proposed row, with worst-case names.

## Lengths

Every name a screen prints, where it comes from, and what caps it. "Uncapped" means Baton
stores and prints whatever arrives.

| name                        | source   | cap in Baton                                   | kind          |
| --------------------------- | -------- | ---------------------------------------------- | ------------- |
| team name                   | merchant | 32 (`TEAM_NAME_MAX_LENGTH`)                    | capped name   |
| task name                   | merchant | 64 (`NAME_MAX_LENGTH`)                         | capped name   |
| workflow name               | merchant | 64 (`NAME_MAX_LENGTH`)                         | capped name   |
| workflow tag                | merchant | 255 (`WorkflowTag`, Shopify's tag limit)       | capped token  |
| item title                  | Shopify  | uncapped (Shopify allows 255)                  | Shopify text  |
| variant title               | Shopify  | uncapped (option values joined with `/`)       | Shopify text  |
| SKU                         | Shopify  | uncapped, usually one unspaced token           | Shopify token |
| item property key and value | Shopify  | uncapped                                       | Shopify text  |
| order number (`orderName`)  | Shopify  | uncapped; the merchant can set a prefix/suffix | Shopify token |
| order note                  | Shopify  | uncapped                                       | free text     |
| block reason                | member   | 1000 (`BLOCK_REASON_MAX_LENGTH`)               | free text     |
| note                        | member   | 2000 (`RUN_NOTE_MAX_LENGTH`)                   | free text     |
| task instructions           | merchant | 500 (`TASK_INSTRUCTIONS_MAX_LENGTH`)           | free text     |
| who did it (`actorLabel`)   | member   | uncapped (`Email` has no length check)         | identity      |
| shop domain                 | Shopify  | uncapped                                       | identity      |
| state, step, count, time    | Baton    | fixed words                                    | fixed words   |

What one line holds, measured at 375px (an iPhone SE / mini width) with Polaris's 13px Inter:

- today's row text column is **259px**, about 38 characters;
- the proposed row's text column is **293px**, about 44 characters, because the menu button no
  longer takes a column all the way down the row (Part 3, rule 4);
- on a 1280px screen the list is 598px wide, about 90 characters.

So at 375px a 64-character name takes two lines, and a 32-character team name plus a state takes
one or two. The capped names are short enough to show whole. The uncapped ones are not.

## The rule

Sort every printed value into one of four kinds by where it comes from and whether it is capped.
Each kind gets one treatment everywhere:

| kind                                                              | on a list or in a row                             | on its own page (its home)                                        | in a control that cuts (badge, chip, select option, title bar, toast) |
| ----------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| **capped name** (team, task, workflow)                            | whole; wraps                                      | whole; wraps                                                      | allowed: the cap keeps the cut rare and the home shows it whole       |
| **Shopify text** (item title, variant, property)                  | clamped to 2 lines with an ellipsis               | whole; wraps                                                      | never: put it in text that wraps                                      |
| **free text** (block reason, note, instructions, order note)      | clamped to 2 lines                                | `Prose`; a block reason uses `ClampedProse` (3 lines + Show more) | never                                                                 |
| **tokens and identities** (SKU, tag, order number, email, domain) | whole; wraps anywhere (`overflow-wrap: anywhere`) | whole; wraps anywhere                                             | allowed only for the order number (short in practice)                 |

**Fixed words** (a state, the step, a count, a time) are never cut. They are kept whole by placing
them where wrapping cannot hide them: after a name that wraps, or ahead of a clamp, never inside or
after a clamp on the same line.

Why this split:

- **Capped names wrap, never clip.** Baton chose their caps, so their worst case is known: 64
  characters is two lines at 375px. Showing them whole costs at most one extra line, and the member
  never has to guess which task an ellipsis hides. Two tasks can share their first 30 characters
  ("Engrave the inscription, front…" / "Engrave the inscription, back…").
- **Uncapped Shopify text is clamped on lists.** 255 characters is six lines at 375px. On a list the
  title only has to identify the piece, and the first two lines do that. The member's workflow page
  heads with the whole title, and the row's accessible label carries it whole.
- **Free text is clamped to two lines, not one.** One line at 375px is about 40 characters, which is
  rarely a whole reason. Two lines (about 85 characters) hold most reasons whole and the start of any
  reason. Polaris's own guidance: "truncated content should never hide critical information"
  (`refs/shopify-docs/docs/api/app-home/latest/web-components/typography-and-content/paragraph.md`,
  best practices), and the migration guide says to keep the full value reachable
  (`refs/shopify-docs/docs/apps/build/app-home/migrate-from-polaris-react/truncate.md`). The row
  links to the member's workflow page, which shows the reason whole.
- **Tokens wrap anywhere.** An unspaced string has no word break, so the only choices are to break it
  anywhere or to let it overflow. `.member-prose` already does this for typed text, and
  `.admin-field` for ids.
- **Cutting controls are for capped values only.** A badge, chip or select option cuts to one line
  and gives no way to read the rest (`badge.md`, `chip.md`: "no built-in way to show the full text
  on hover"). A 32-character team name in a chip is acceptable. A 255-character tag is not.

Every clamped value has one **home** where it is printed whole:

- item title, variant, block reason, note and instructions: the member's workflow page and the order
  page;
- tag: the merchant's workflow page.

The row's accessible label (`Open <item> on <order>`) carries the item whole too.

**Clamps use Polaris where Polaris has one.** `s-paragraph` and `s-heading` take `lineClamp`, and
the installed types already have it. That replaces the hand-written `-webkit-box` in
`.run-title-clip`. `s-text` has no clamp ("The component doesn't include text truncation",
`text.md`), so a clamped sequence of mixed `s-text` parts sits in an `s-paragraph lineClamp={2}`.

## Elsewhere

From the inventory of every screen. Each is the same rule applied. The ones marked **bug** break the
layout or lose text today.

| where                                                       | what                                                 | today                                                              | proposed                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| member's workflow page heading (`s-page heading`)           | item title                                           | whole, wraps                                                       | unchanged: this is its home. An unspaced title can overflow; see question 11 |
| member's workflow page, `RunItem`                           | SKU, property key                                    | bare `s-text`; key column `max-content` **(bug: overflows)**       | wrap anywhere; key column `minmax(0, max-content)`                           |
| `RunSteps` and `WorkflowSteps`                              | task instructions                                    | bare `s-text` **(bug: line breaks collapse, long words overflow)** | `Prose`                                                                      |
| order page aside                                            | order note                                           | bare `s-paragraph` **(bug: line breaks collapse)**                 | `Prose`, as the member's workflow page already does                          |
| order page item heading                                     | `title — variant`                                    | `s-heading`, wraps                                                 | unchanged (the order page is a home)                                         |
| workflows index                                             | tag in an `s-badge`                                  | cut to one line, unreadable past it                                | subdued text that wraps anywhere; see question 10                            |
| merchant's workflow page                                    | tag as a title-bar badge and in `WorkflowTag`'s chip | cut, no way to read it on its own home                             | the chip and the badge go; the tag prints whole as text; see question 10     |
| merchant's workflow page                                    | `itemTriggerLine` (a sentence quoting the tag)       | wraps, unspaced tag overflows                                      | wrap anywhere                                                                |
| modal headings: Block, Cancel, Delete, Turn on, Assign team | names inside the heading                             | a 255-character title makes a seven-line heading                   | see question 9                                                               |
| members page, team page                                     | member email in table cells                          | bare; the team page clips it in an `overflow="hidden"` box         | wrap anywhere                                                                |
| `MemberBar`, shop list, lapsed page                         | shop domain, email                                   | bare                                                               | wrap anywhere                                                                |
| members page                                                | team chips, `+N` past four                           | chip cuts (team ≤ 32)                                              | unchanged: a capped name in a cutting control                                |
| selects (team, workflow)                                    | names as `s-option`                                  | native                                                             | unchanged: capped names                                                      |
| admin pages                                                 | ids in table cells                                   | bare except `.admin-field`                                         | `.admin-field` on the cells (admin only; low priority)                       |

Stale JSDoc found on the way: the JSDoc on `nowLine` in `app.orders.$orderId.tsx` speaks of "a
64-character team name". The team cap is 32.

## Where the rule lives

AGENTS.md wants a rule stated once, on the symbol that is the concept, with a test whose title is
the rule. Today the length reasoning is spread across `itemPiece`, `runRowLines`, `PieceLine`,
`RowLine`, `styles.css`, `ClampedProse` and `TEAM_NAME_MAX_LENGTH`. They agree only on the row.

Proposed: the rule above becomes the **text fits** rows of Part 1's parts table on `Screen.ts`, one
row per kind (capped name, Shopify text, free text, token, fixed words) with these columns: the
names in it, on a list, on its home, in a cutting control, never. `pnpm spec check` parses it, like
the copy table, and refuses a name kind without a row. Each row names the component that applies
it: `Name` (wraps), `Clamp` (an `s-paragraph` or `s-heading` with `lineClamp`), `Token` (wraps
anywhere), `Prose` and `ClampedProse` (existing). Routes use these and never write overflow CSS,
which Part 1's lint rule enforces.
`itemPiece`, `runRowLines` and the CSS link to it instead of restating it. Tests pin each row: a
title clamp at two lines, a 64-character task shown whole, an email that does not widen the row.
The Playwright member spec already renders `#1026` and `#1030` at the caps.

# Part 3. The workflows list row

## What looks off today

From the screenshots, in order of how much each costs the reader.

**1. The clips land on the names the member reads, and the fixed words survive.** Every line
except line one is a single line. Free-length names shrink with an ellipsis, and fixed words never
shrink (`.run-line-clip` and `.run-line-keep` in `styles.css`, on `RowLine`). At 375px:

- `Condition and burnish the edge… · Ready` keeps 30 of 64 characters of the task name.
- `Skive the turn-ins (Hand stitchi… · Ready` cuts the team in half. On the first task line the
  team is cut away completely. The team is the word that tells a member on several teams which
  bench to walk to.
- `Select and in… · Done by you at 12:51 PM` keeps 13 characters of the task name, because the
  kept phrase is 23 characters.
- Under Blocked, the block reason is what the filter is for, and it is cut hardest:
  `Crest file missing from the order — ask…`.

The rule "clip names, keep fixed words" was right about the step and the state. Applied to a single
line that also holds two names, it means the names lose.

**2. Some "fixed words" are not fixed.** `Started by <who>` and `Done by <who> at <time>` sit in
the never-shrinking part, and `<who>` is an email with no length cap. A long address pushes the
line wider than its box. The JSDoc on `RowLine` calls these "the short fixed words", which an email
is not.

**3. The same name, twice.** With a workflow named after its product, `Signet ring` is line one and
line four of every row. The earlier research (`workflows-list-row-research.md`, approach B) argued
the repeat was acceptable because the two lines mean different things. On screen it reads as
noise: two of four lines start with the same words, and the first thing the eye lands on is the
repeat.

**4. Line one has no weight.** `PieceLine` asks for `s-text type="strong"`. Polaris's CDN
`polaris.js` renders it at weight 450, the same as plain text (measured: both the `<strong>` inside
`s-text type="strong"` and a plain `s-text` compute to 450, inside and outside `s-clickable`). The
row has four lines of similar weight and nothing to scan for. Twelve `type="strong"` uses in `src/`
get the same non-result. The weight is available another way: `s-text fontWeight="semibold"`
renders at 600 at runtime (the mock uses it). The installed `@shopify/polaris-types` 1.0.7 does not
type `fontWeight` on `s-text`. 1.1.0 is published, and whether it adds the prop is to be checked.

**5. Two loose columns at the right.** `#1008` is top-aligned at the end of line one. The `⋯`
button is vertically centred in a column further right, which runs the full height of the row. The
two line up with nothing, and the menu's column takes 34px from every line of the row, not only the
line it sits beside.

**6. The rest of the UI has no rule.** The inventory in [Elsewhere](#elsewhere) found four places
that handle overflow on purpose:

- the workflows list classes;
- `.member-prose`;
- `ClampedProse` (a measured three-line clamp with Show more, for block reasons);
- `.admin-field`.

Everything else is bare Polaris. `s-text` never truncates. `s-badge` and `s-chip` cut to one line
with no way to read the rest. Nothing sets `overflow-wrap`, so an unspaced SKU, tag, email or URL
can push a box wider than the screen.

## The row, proposed

The row is the first screen built from Part 1's parts: an `IndexSection` frame, a `ResourceRow` per
item, and the text fits from Part 2. The mock was drawn before Part 1 and keeps today's double
frame; with `IndexSection` (padding none, as on the merchant's indexes) every line gains another
32px at 375px, about 325px in all.

```
#1008 · Signet ring · Gold ×2                                  ⋯
Engrave crest (Engraving)
Crest file missing from the order — asked the customer.
Step 2 of 3
```

At the extremes, 375px (`proposed-375.png`):

```
#1026 · Engraved cutting board, extra               ⋯
large end-grain walnut with a hand-cut…
Engrave (Engraving)
The crest is a scan of a wax seal and the fine
lines fill in at this depth; we have tried three…
Cut, engrave and oil · Step 2 of 3

#1030 · Heirloom leather journal                    ⋯
Condition and burnish the edges against the
customer's reference (Hand stitching and edge
painting) · Ready
Cut the cover panels to pattern (Leather) ·
Ready
Step 2 of 18

#WEB-1000234-EU · Engraved              ×12         ⋯
cutting board, extra large end-grai…
Engrave the inscription across the full width of
the front face (Engraving and laser, bench 3) ·
Started by
alexandra.featherstonehaugh@example-workshop.com
Engraved boards, rush and standard · Step 14
of 18
```

Rules, each a change from today unless marked:

1. **Line one: order number first, then the piece, clamped to two lines; `×n` after the clamp.**
   `#1008 · Signet ring · Gold`, in an `s-paragraph lineClamp={2}`. The order number is subdued and
   the piece carries the row's weight (question 12 settles how; the mock uses semibold `s-text`). A clamp cuts from the end, so the order number cannot be cut. That was the
   reason it was pinned to the end in a cell of its own, and leading it gives the same guarantee
   without the extra column. It also matches how Shopify's own order lists lead with the number.
   `×n` stays outside the clamp (unchanged), so a clamped title still shows the count. When the
   title clamps, the count sits at the end of the first line, as it does today.
2. **One line per current task, wrapping, never clipped.** `Task (Team) · <state>`, with the task in
   body colour and the rest subdued. The worst case is bounded: 64 + 32 characters plus a state is
   three lines at 375px. The `(Team)` rule (`rowShowsTeam`) and the state rules (`runRowLines`) are
   unchanged.
3. **The block reason is clamped to two lines** (`s-paragraph lineClamp={2}`), not one. Under
   Blocked it is the line the filter exists to show.
4. **The menu sits beside line one only.** The row becomes a grid with the head and the menu on top
   and the body spanning both columns below. Every line after the first gains the menu's 34px:
   293px against 259px at 375px. The menu cell is one line tall, so a one-line head leaves no gap.
5. **The last line is `Step k of n`, with the workflow name in front only when it differs from the
   item title.** Today it is always `<workflow> · Step k of n`. See question 6: this reverses a
   rejection in the earlier research, and why.
6. **A done row follows the same shape.** Line one the piece. Line two the task, wrapping, then
   `Done by <who> · <time>` after it. Today the task name is clipped to fit the kept phrase.
7. **`<who>` wraps anywhere.** The whole row body sets `overflow-wrap: anywhere`, so an email
   breaks inside itself rather than overflowing (`proposed-375.png`, the fourth row).
8. **One frame.** The list sits in `IndexSection` (padding none), like the merchant's indexes and
   Shopify's resource-list composition, not a bordered box inside a padded section. A search's two
   lists (open, then Done or closed) are two `IndexSection`s rather than two boxes in one card.

What it costs: rows grow when names are long. The common row (a short task, no block) is three
lines, the same as today. A blocked row is four, the same as today. Only rows whose names pass about
40 characters grow, and those rows are the ones that are unreadable today.

## Reversals

Of `workflows-list-row-research.md`'s decisions:

- **Decision 2** (order number pinned at the end of line one in its own cell): reversed. It leads
  line one, in the clamp's safe position.
- **Decision 3** (`<workflow> · Step k of n` on every row): changed. The workflow name shows only
  when it is not the item title (question 6).
- **Decision 7** (each task line and the workflow line clamp to one line): reversed. Capped names
  wrap. Only Shopify text and free text clamp, to two lines.
- **"Rejected: hide the workflow name when it equals the item title"**: reversed (question 6).

Of the plan's deviations: deviation 3 (`Clip` and `Keep` parts on one line) goes. Deviation 5
(`Done by <who>`) stays.

# Decisions

All twelve recommendations were accepted on 2026-10-05.

1. **A spec for shape:** the parts table on `Screen.ts`, the lint rule and the kit page, all three.
2. **The lint rule is strict:** no layout primitives and no layout props in `src/routes/`; layout
   lives only in `src/components/screen/`. A one-off layout on a details page becomes a part used
   once.
3. **Three distances and one breakpoint:** `small-300`, `base`, `none`; one container breakpoint at
   480px. The two strips become one `Strip`, whose column rule is decided on its row after looking
   at both screens' labels on the kit page.
4. **A `template` column on the Screens table:** `index`, `details`, `homepage`, `editor`.
5. **Phasing:** parts, table and kit page with the lint rule warning; then the workflows list and
   the member's workflow page; then the merchant's indexes; then the details pages, the workflow
   editor and the bugs in [Elsewhere](#elsewhere); then the lint rule refuses, admin pages last or
   allowlisted.
6. **The workflow name is on the row only when it differs from the item title**, compared trimmed
   and ignoring case.
7. **The order number leads line one.**
8. **No cap on parallel tasks in a row.** Revisit if a shop has a wide parallel step.
9. **Modal headings name the order, not the item** (`Block #1008?`); the body's first line names the
   item, clamped to two lines. The copy table's heading row changes with it.
10. **The workflow tag prints as subdued text that wraps anywhere**, on the workflows index and the
    merchant's workflow page; the badge and the chip go.
11. **`overflow-wrap: anywhere` on the member area's root.**
12. **Line one's weight comes from `s-heading lineClamp={2}`**, provided the kit page shows it at
    heading weight inside `s-clickable` in the member area; otherwise `s-text fontWeight="semibold"`
    in an `s-paragraph lineClamp={2}` after a `@shopify/polaris-types` upgrade. Every other
    `type="strong"` use says whether it wants weight or only the semantic `<strong>`.

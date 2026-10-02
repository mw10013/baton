# Filtering and searching the orders index and the workflows list

Written 2026-10-01. The two screens are the merchant's orders index (`app.orders.index`) and
the member's workflows list (`shop.$shop.workflows.index`). Both feel clunky: a row of press
buttons with counts, a second control for the team, a search field on one side only, and the
word "view" for what the buttons do. This doc asks what the two screens are for, what each
control answers, what the Shopify admin does for the same job, and what words to use. It ends
with recommendations and the questions that decide them.

Nothing here is decided. Everything in the current design is up for revision, including the
view row, the word "view", the counts on the buttons and the rule that search ignores the
filters.

## What the two screens are, conceptually

Both screens are **one list of one kind of thing**, with controls that change which rows the
list holds. That is the whole of it. The list's subject is different on each side:

| side     | screen         | one row is                                          | the person arrives to                                                        |
| -------- | -------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| merchant | orders index   | one Shopify order, with its production facts        | see the bench, find what needs them, find one order, see how a team is doing |
| member   | workflows list | one item's workflow (a run), with its current tasks | pick up work, continue work, find one order's item, undo a mistake           |

The controls are three kinds of question, and the mess comes from the three being drawn as
if they were one or two:

1. **Narrowing.** "Only the orders that are Making." "Only the items on the Casting team."
   A narrowing is one axis with values, and two narrowings combine: Making _and_ Casting.
   A narrowing has a count: the number of rows it would show.
2. **Finding.** "Where is #1034?" The person has an identifier in hand. A find is not an
   axis; it is a lookup, and the answer is one row or a few. A find does not want to be
   combined with narrowing, because the person does not know which narrowing the order is
   under; that is why they are searching.
3. **Scope.** "Show me the history too." The default list is the bench (open orders, or the
   member's own started work). Widening is a one-off: All, Done or closed.

Today each side has all three, drawn differently:

| question  | orders index                                                                                                    | workflows list                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| narrowing | Status axis as press buttons (Not started, Making, Made, Fulfilled); Issues as a press button; Team as a select | Who-has-it axis as press buttons (Started by you, Started by others, Ready, Blocked); Team as a menu in the member bar |
| finding   | Order number search field                                                                                       | none                                                                                                                   |
| scope     | Open and All as press buttons in the same row                                                                   | Done or closed as a press button in the same row                                                                       |

So the press-button row on each side mixes two kinds of question (narrowing and scope), the
team narrowing is drawn as a different control from the status narrowing, and the find is a
third control that silently ignores the other two. The merchant's row has seven buttons with
three different meanings in it. That is the clunkiness, and it is conceptual before it is
visual.

### Why the current design mixes them

The row of exclusive buttons was chosen so nothing crosses: the JSDoc on `OrdersIndexView`
in `src/lib/domain/ShopWork.ts` says that crossing positions with issues left four of nine
cells always zero, and that Fulfilled had to hide the issue controls. Those are real facts
about the data, but they argue against drawing issues as a _second row of buttons_, not
against treating issues as a narrowing. A narrowing that is a select or a chip costs nothing
when it is empty, and a zero count is a true answer.

The counts went on the buttons because counts at a glance are the one thing the merchant
and the member want on arrival (what needs me, how much is waiting). That requirement is
real and survives any redesign; the question is where the counts live.

## What each control is for, from first principles

### The orders index (merchant)

What the merchant arrives wanting, roughly in frequency order:

1. **What needs me.** Issues. The one thing Baton can tell the merchant that Shopify cannot.
2. **How much is on the bench, and where.** Counts by position: not started, making, made.
3. **One order.** They have the number from the Shopify order page, an email, a packing
   slip, or a customer on the phone. Sometimes they have the item instead ("the signet
   ring order").
4. **One team.** From the team page ("what is this team holding") or when a team is behind.
5. **History.** Fulfilled, cancelled, all. Rare; the Shopify admin already is the history.

What they do not arrive wanting: a saved combination of filters, sort options, columns,
bulk actions, export. Baton's list is a few hundred open orders at most, read in one
sitting.

### The workflows list (member)

What the member arrives wanting:

1. **My work.** What I have started, to continue it. The default.
2. **Something to do.** Ready: current tasks on my teams that nobody has started.
3. **One order's item.** The merchant asks "where is #1002", a ticket on the bench says
   #1002, a customer is on the phone with the merchant who is standing next to the bench.
   Today the member scrolls. There is no search.
4. **What is stuck.** Blocked, when a person asks.
5. **Undo.** Done or closed: the last day, to put back a wrong Done.
6. **One of my teams.** Only for a member on more than one team.

The member's axis is genuinely one axis: every open run is in exactly one of Started by
you, Started by others, Ready or Blocked (`viewOf`). The orders index's axis is not one
axis: Open and All are scopes, Issues cuts across the positions.

## What the Shopify admin does

The admin's Orders page is the one list screen every merchant has used. It is far more than
Baton needs, but its pieces map onto the three questions above. Terms in this table: the
first column is the literal on-screen text, the second is the Help Center's word, the third
the Admin API name.

| on screen (admin)                                                                                                                                                                                                                        | Help Center word                                                                           | API                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| "All" button at the left of the search bar; its menu is headed "Select a view" and lists "All", "Unfulfilled", "Unpaid", "Open", "Archived"; "View actions" offers "Rename view", "Duplicate view", "Delete view"                        | "view": "A _view_ is a filtered list of your resources based on criteria that you set up." | `savedViewId` URL param                          |
| one box labelled "Search and filter"; free text applies on Enter                                                                                                                                                                         | "search your view for list items using keywords"                                           | `query` argument, free text (`default` field)    |
| focusing the box lists 26 filter names; each has "Is" / "Is not" and a checkbox list; a chosen one is a pill, "Fulfillment status is Unfulfilled", with an "Add new filter" icon after the last                                          | "filters"; "All filters display in-line in the search bar"                                 | `query` argument, `fulfillment_status:unshipped` |
| "Clear search", "Reset view", "Save"; "Save" opens "Save view as" with a "View name" field                                                                                                                                               | saving a view                                                                              | savedViewId                                      |
| the "Metrics bar": "Today" (Today / Last 7 days / Last 30 days) and six cards, "Orders", "Items ordered", "Sales reversals", "Orders fulfilled", "Orders delivered", "Order to fulfillment time"; each card links to an analytics report | the orders page's analytics metrics                                                        | ShopifyQL / Analytics reports                    |
| "Display options": "Sort by" (Order, Date, Customer, ...), "Oldest first" / "Newest first", column eye toggles                                                                                                                           | sort and columns                                                                           | `sortKey`                                        |

Three things worth taking from it:

- **A view is a saved set of filters, with a name, and the merchant makes them.** It is not a
  fixed preset. Every default view is one filter (Unfulfilled is `fulfillment_status`
  unshipped). So the admin's word "view" means something Baton does not have. Baton has
  fixed single-value filters on one axis and calls them views. That borrows the word for a
  different thing, and the one place the Help Center sends a merchant to learn the word
  ("Searching and filtering your lists using views") will teach them the admin's meaning.
- **Search and filters are one bar, and search is within the view.** The admin does not have
  a rule that search ignores filters; it starts from All, and a merchant searching for a
  fulfilled order finds it because All is the default. Baton's default is Open, which is
  why Baton needed the rule that search ignores the filters.
- **Counts are not on the views.** The "Select a view" menu lists names without numbers,
  the filters carry none, and there is no "Showing N orders" line; the only numbers are the
  nav badge, the pager ("1-50") and the metrics bar, which is per period and links to
  analytics. The admin's answer to "what needs me" is the Unfulfilled view and the orange
  or red "!" on a row, not a count.
- **Free text matches by word prefix across several fields.** "1575" matches #1575, "Elena"
  and "Pet" match the customer, "Coconut" matches an item's title. One box, no syntax
  needed; the `field:value` syntax exists but a merchant never has to type it.

The admin's chip-and-operator filter UI ("Fulfillment status is Unfulfilled", with Is / Is
not) is what Baton should not copy: it is a query builder. Baton has two or three axes with
a handful of values each.

The Polaris web components Baton draws with have the admin's pieces in smaller form:
`s-table` has a `filters` slot "to add search or filter controls above the table";
`s-search-field` is "search input for filtering lists or tables"; `s-choice-list` inside an
`s-popover` is the documented sort and filter menu (the index-table composition in
`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/index-table.md`);
`s-clickable-chip` is for "active filters as clickable chips that can be modified or
removed"; the metrics-card composition
(`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/metrics-card.md`) is
a grid of `s-clickable` cells each with a heading and a number. `s-press-button`, which
the rows use today, is a toggle button; Polaris has no segmented control and nothing that draws one
row of exclusive choices with counts.

The screen-by-screen notes are in the section at the end.

## Where the current screens go wrong

Each of these is a symptom of the conceptual mix, not a styling problem:

1. **Seven buttons, three meanings** (orders index). Open · Not started · Making · Made ·
   Fulfilled · All · Issues. Two are scopes, four are positions, one cuts across. The row
   has no label because no label would be true of all seven.
2. **Counts on some buttons and not others.** Fulfilled and All have none (a full-table
   read). A row where some buttons carry numbers reads as if the others failed.
3. **Two narrowing controls, two shapes.** Status is buttons, Team is a select with a
   label. The merchant has to learn that one narrows the other's counts and the search
   ignores both.
4. **The search is a different world.** While a search is on, every button unpresses and the
   team select stays visible but does nothing. The JSDoc calls a pressed button under a
   search "a lie"; the fix was to unpress all of them, which reads as a broken row.
5. **The member's row is a grid of five** so the phone wraps it into 3 + 2 or 2 + 2 + 1.
   Five equal boxes with numbers look like a dashboard but behave like radio buttons, and
   the pressed one is only a shade darker.
6. **No search for members.** A member hunting one order number scrolls through Ready · 77.
7. **"View"** names a fixed preset here and a saved filter set in the admin.

## Vocabulary

The words the vocabulary has today: "view" (a preset of a list, one at a time, chosen by
its button). Retired: "tab". Off-limits for Baton fields: `status` (Shopify's word).

First-principles argument. What the person does with these controls is **filter** a list
and **search** it. Those are the plain words, they are the Help Center's words, and they
are what the merchant already says ("filter by team", "search for the order"). "View" adds
nothing a merchant needs and collides with the admin's meaning. The thing a button or a
select picks is a **filter value** on a named **filter**: Status is a filter, Making is one
of its values, Team is a filter, Casting is a value. The search is a search. The list
without any filter is the **default**, and what the default holds is a fact of the screen
(open orders; what you started).

Proposed words, one row each, with where each lives:

| word    | meaning                                                                                               | symbols (proposed)                                           | screen                                                          |
| ------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| filter  | one named axis of a list with a fixed set of values; the list shows rows matching every chosen filter | `OrdersFilter`, `RunFilter` (one struct, one field per axis) | the axis name: Status, Issues, Team; the value: Making, Casting |
| count   | how many rows a filter value would show, given the other filters                                      | `OrderCounts`, `RunListCounts`                               | the number beside the value                                     |
| search  | free text matched against a row's identifiers; finds, does not narrow                                 | `OrderSearch`, `RunSearch`                                   | Search orders / Search workflows                                |
| default | what the list shows with no filter and no search                                                      | `null` in the URL                                            | Open (orders); Started by you (workflows)                       |

"Scope" is deliberately not a word: Open and All become values of the Status filter
(see the orders index proposal below), and Done or closed stays a value of the member's
one filter. "View" is retired. The URL keys name the axis: `?status=` is not allowed
(Shopify's word), so the orders index's axis key is the question: `?show=` for the
position axis is one option; the Questions section asks.

What this costs: `WorkflowsListView`, `OrdersIndexView`, `WorkflowsIndexView`, `RunView`,
`viewOf`, `workflowsListViews.ts`, the `?view=` key on three routes, the vocabulary row,
the spec checks that read it, tests named with "view", and every JSDoc that says "view
row". A grep rename, done once, and the vocabulary runbook covers the procedure. The
member's five values keep their labels; only the word for the control changes.

## Proposals

Two proposals per screen, with a recommendation.

### Orders index

**Proposal A: counts in a strip, filters in the table's filter slot** (recommended).

```
┌──────────────────────────────────────────────────────────────────────┐
│ Open 73      Not started 7     Making 54     Made 12     Issues 10   │  ← metrics strip,
└──────────────────────────────────────────────────────────────────────┘    each cell clickable
┌──────────────────────────────────────────────────────────────────────┐
│ [🔍 Search orders            ] [Status ▾] [Team ▾]      (Clear)      │  ← s-table filters slot
│ ── Making ×  Casting ×                                              │  ← chips, only when set
│ Order  Placed  Payment  Status  Issues  Waiting on  Items  Shopify   │
│ ...                                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

- The strip is the metrics-card composition: five cells, each a count and a name. It
  answers "what needs me" and "how much is on the bench" on arrival, which is what the
  counts on the buttons were for. Clicking a cell sets the matching filter; the pressed
  cell is marked. It is the admin's strip, with Baton's numbers, without a date picker.
- The filters are two: Status (Open is the default and a value; then Not started, Making,
  Made, Fulfilled, Cancelled, All) and Team. Issues is a third, a yes/no. Each is a select
  or a popover with a choice list. A chosen value shows as a removable chip under the
  filter row, as the admin does, so the state of the list is readable in one place.
- The search is one field, "Search orders", at the left of the filter row where the admin
  has it. See the search section for what it matches and whether it combines.
- The strip's counts honour Team and nothing else, as today.
- What goes away: the press-button row, the "Team" label, the rule that a pressed button
  must unpress under a search.

**Proposal B: keep one row of buttons, make it one axis.** Status only: Open · Not started ·
Making · Made · Fulfilled · All, as today without Issues. Issues becomes a chip-filter or a
switch ("Only issues") beside Team. Counts stay on the buttons. Smaller change; keeps the
row of seven minus one, keeps the two shapes of narrowing. Not recommended: it fixes the
mixed row but not the clunkiness.

### Workflows list

**Proposal C: one filter, drawn as a segmented row, plus search** (recommended).

```
┌──────────────────────────────────────────────────────────┐
│ sandbox-shop-01     [All teams ▾]        [🔍 Order number]│  ← member bar
├──────────────────────────────────────────────────────────┤
│ Started by you 17 │ Started by others 0 │ Ready 77        │  ← one joined row,
│ Blocked 5         │ Done or closed 139  │                 │     wraps on a phone
├──────────────────────────────────────────────────────────┤
│ Signet ring  Cast and engrave · #1002                ···  │
│ Engrave crest · Step 2 of 3 · Engraving                   │
└──────────────────────────────────────────────────────────┘
```

- The member's axis is one axis, so one row of values is right. The change is how it
  looks: joined buttons (one border, shared corners, the chosen one filled) so it reads as
  one control with five values rather than five boxes. Polaris has no segmented control;
  this is `s-press-button` in a `.run-view-row` with the gaps removed, or plain buttons
  styled in `styles.css`. Counts stay: on a bench tablet the row is the dashboard.
- Add a search for the order number, in the member bar next to the team. A member with
  a ticket in hand types #1002 and sees that item's rows whatever filter is chosen.
- Team stays in the bar.

**Proposal D: fewer values.** Fold Started by others into Ready (both are "not mine"), making
four. Not recommended: Started by others answers a different question (someone has it, do
not pick it up), and its count being 0 on the sandbox is a sandbox fact.

### Search

What search matches, from what the person has in hand:

| the person has                | orders index                                                           | workflows list               | stored today                               |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| an order number (#1034)       | yes, today                                                             | proposed                     | `ShopOrder.name`, `Run.orderName`          |
| an item's title (Signet ring) | proposed                                                               | proposed                     | `OrderLineItem.title`, `Run.lineItemTitle` |
| a SKU                         | proposed                                                               | no (members do not see SKUs) | `OrderLineItem.sku`, `Run.sku`             |
| a customer's name or email    | no: Baton stores no customer fields (orders sync decision, 2026-09-02) | no                           | not stored                                 |
| a product tag                 | no: that is a Workflows question                                       | no                           | `productTags`                              |
| a workflow name               | no: Workflows index                                                    | no: the row shows it         | `Run.workflowName`                         |

Recommendation: one field, no syntax, and the same four fields on both sides: order
number, item title, variant title, SKU. The placeholder is "Search orders" on the orders
index and "Search" in the member bar. A number with or without `#` is an order number;
anything else is matched as a word prefix of a title, a variant title or a SKU, which is
how the admin's box matches. No `field:value`, no operators: the admin's syntax exists
because it has forty fields; Baton has four.

**Should members see SKUs and variants?** From first principles: what a member needs on
the bench is enough to pick the right thing from the shelf and to tell two rows of one
order apart. The item title does not do that when the order has a Signet ring in Size 9
and a Signet ring in Size 11, or a Brass and a Silver one: both rows read "Signet ring ·
Cast and engrave · #1002". The variant title is the distinction, and the SKU is what the
bin label, the packing slip and the merchant's inventory say. The member's workflow page
already shows both (`RunItem` in `src/components/MemberRun.tsx`: "Size 9 · Quantity 2" and
"SKU SR-9-BR"); only the list row leaves them out. So yes: line one of the row shows the
variant title after the item title ("Signet ring · Size 9"), and the search matches SKU
and variant title. Cost: `RunListRun` omits `variantTitle` and `sku` today; include them.
Members do not need the product tags or the line-item properties on the row; the
workflow page has them.

Whether search combines with the filters. Two consistent rules:

- **Search ignores the filters** (today's rule). The number is the whole question. The
  screen must then show that the filters are off: replace the filter row's state with
  "3 orders match #10" and a clear control, rather than unpressing buttons.
- **Search narrows within the filters**, as the admin does, with the default widened to All
  while a search is on. Simpler to state, and the chips stay true. But "no match under
  Making" is the trap the current rule was written to avoid, and widening the default
  under a search is the same rule in different clothes.

Recommendation: keep "search ignores the filters", and show it: under a search the strip's
cells and the chips are hidden and one line says what matched. Every result row shows its
Status badge, so the person sees where the order is.

### The metrics strip and analytics

The admin's strip links each cell to an analytics report. Baton has no analytics and
should not add any here: the strip's job is the counts at a glance and a one-click filter.
If a cell links anywhere it links to this list filtered to that value, which is the same
page. A "today" or "this week" period on the strip is a different feature (throughput),
not this one.

## The keys and the words, again

Two questions survived the first round: what the URL keys are when "view" goes, and what
to call the member's one filter. Both come down to naming the axis.

### What the rule on `status` is, and whether to keep it

The vocabulary (the top of `src/lib/Domain.ts`) says: Shopify's things get Shopify's
words; `status` is Shopify's and the platform's word (`fulfillmentStatus`,
`BulkOperationStatus`, an HTTP status) and `state` is Baton's (`RunState`, the state
tables); a Baton field, literal or URL key is never named `status`. It is a vocabulary
rule, not a lint: `scripts/rules-lint.ts` refuses inline status comparisons and reserved
stems, and `status` is not a reserved stem.

Why it exists: a reader of a field named `status` should be able to assume it holds what
Shopify said, unchanged, and a reader of `state` that it holds something Baton decided.
The orders index's axis is Baton's: an order's position (`orderPosition`) is derived from
Shopify's fulfillment status and Baton's runs together. Naming its key `status` would say
the opposite of what it is.

The screen is a separate matter. The orders index's column is headed "Status" and its
badge is the position (Not started, Making, Made, Fulfilled, Cancelled). That is screen
copy: the merchant's plain word, chosen because the column holds one value per row and
"Status" is what a merchant calls that. Screen words and identifiers already differ by
design ("workflow" on screen, `run` in code). So the rule can stay and the screen can keep
"Status": the key and the symbol follow the vocabulary, the heading follows the merchant.

Recommendation: keep the rule. The axis has a vocabulary word already, and it is not
"status".

### The orders index's key: `?position=`

The orders index's main filter is the order's position. Its values today: Open (the three
open positions together), Not started, Making, Made, Fulfilled, Cancelled, All (every
position). So the axis is **position**, with two aggregate values. The vocabulary's word
for it is "position" (the Order positions table in `ShopWork.ts`), and the symbol is
`OrderPosition`.

| key          | reads as                      | for                                                  | against                                                                           |
| ------------ | ----------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `?position=` | `/app/orders?position=making` | the vocabulary's word; the symbol is `OrderPosition` | Open and All are not positions; the screen says Status                            |
| `?show=`     | `/app/orders?show=making`     | reads like English                                   | names no axis; "show" would have to mean something different on each screen       |
| `?status=`   | `/app/orders?status=making`   | the screen's word                                    | breaks the rule above; says the value is Shopify's                                |
| `?state=`    | `/app/orders?state=making`    | Baton's word for what Baton decides                  | the vocabulary already uses "state" for runs and tasks; a position is not a state |

Open and All: Open is the default and absent from the URL, as today, so it needs no
value. All is "any position"; `position=all` is a small stretch and the same stretch
`view=all` makes today. Recommendation: `?position=`, values `not_started`, `making`,
`made`, `fulfilled`, `cancelled`, `all`; absent is Open. Issues is its own filter,
`?issues=1`, because it crosses positions. Team and search stay `?team=` and `?q=`.

The merchant's workflows index has the same shape with a different axis: On, Off, All are
workflow states (`workflowIsOn`). Its key becomes `?state=on|off`, absent is All.

### The member's filter: `?state=`

The member's five values are Started by you, Started by others, Ready, Blocked, Done or
closed. What axis are they on? Each is the state of the work, read from the member's seat:

| value             | what it is in the vocabulary                                        |
| ----------------- | ------------------------------------------------------------------- |
| Started by you    | a current task in the `started` task state, started by the viewer   |
| Started by others | a current task in the `started` task state, started by someone else |
| Ready             | a current task in the `ready` task state                            |
| Blocked           | the run in the `blocked` run state                                  |
| Done or closed    | the run in the `done` or `closed` run state, in the last day        |

Four of the five labels are already state words; the fifth, Started, is a state word with
"by you" or "by others" after it. So the axis is **state**, the vocabulary's word for
what Baton decides, and it is the same word the member's workflow page uses for the badge
on a task. `viewOf` is the function that says which state a row is in from the member's
seat; it stays, renamed.

| key       | reads as                 | for                                               | against                                                                                       |
| --------- | ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `?state=` | `/workflows?state=ready` | the values are state words; the vocabulary's word | "started_by_you" is a state plus a person; `RunState` already exists and has different values |
| `?list=`  | `/workflows?list=ready`  | "the Ready list" is how a member would say it     | the screen's spec name is "the workflows list"; two meanings of one word                      |
| `?who=`   | `/workflows?who=you`     | fits the two Started values                       | wrong for Ready, Blocked and Done                                                             |
| `?show=`  | `/workflows?show=ready`  | reads like English                                | names no axis, as above                                                                       |

The literals follow the stored-literal rule (the literal is the word): `started_by_you`,
`started_by_others`, `ready`, `blocked`, `done`. Today's `mine`, `teammates`, `upNext`
were keys that outlived their labels; this rename makes the URL say what the button says.
`done` is "Done or closed" and keeps the short literal, as the label's first word.

Recommendation: `?state=` on the workflows list, with those five literals, and the symbol
`WorkflowsListState` (replacing `WorkflowsListView`) with `RunListState` for the four open
ones (replacing `RunView`). The `RunState` collision is real but bounded: `RunState` is
the run's own stored state and `WorkflowsListState` is the list's filter; the vocabulary
row says so. Alternative, if that collision reads as two meanings of one word: `?list=`,
and the word "list" gets a vocabulary row meaning "a value of the workflows list's
filter". Not recommended, because "the workflows list" is already a screen name.

So every main filter's key is the vocabulary's word for its axis: `position` on the
orders index, `state` on both workflows screens. The `filter` word names the kind of
control; the key names the axis.

## Decisions

No open questions remain. Accepted 2026-10-01, in two rounds.

First round (the question numbers are the first round's):

1. "View" is retired for "filter" and "search"; `*View` symbols become `*Filter`, or the
   axis word for the main filters (decisions 12 and 13); the vocabulary gets the filter,
   count, search and default rows.
2. Orders index: Proposal A, the metrics strip plus the table's filter slot.
3. The Status filter's values: Open (default), Not started, Making, Made, Fulfilled,
   Cancelled, All, as one select.
4. Issues is both a strip cell and a yes/no filter, shown as a chip; no Issues select.
5. Workflows list: Proposal C, one joined segmented row.
6. The workflows list gets a search, in the member bar.
7. The orders search matches order number, item title and SKU, widened by decision 14.
8. Search ignores the filters, and the screen says so.
9. No counts on Fulfilled or All; the strip counts the open values only.

Second round:

12. The orders index's key is `?position=`, Open absent, `all` a value; `?issues=1` is the
    second filter. The merchant's workflows index's key is `?state=on|off`, All absent.
    The rule that `status` is Shopify's word stays; the column heading stays "Status".
13. The member's key is `?state=` with the literals `started_by_you`, `started_by_others`,
    `ready`, `blocked`, `done`; the symbols are `WorkflowsListState` and `RunListState`.
14. The member's row shows the variant title after the item title, and the search on both
    sides matches order number, item title, variant title and SKU.

## Shopify admin notes

Taken on 2026-10-01 from `admin.shopify.com/store/sandbox-shop-01/orders` with the Chrome
DevTools MCP, reading the accessibility tree for labels. Verified on screen unless marked.
The screenshots were taken into the session's scratchpad and are not kept with this doc.

1. **Metrics bar.** A region named "Metrics bar": a "Today" selector (Today / Last 7 days /
   Last 30 days) and six cards. Each card is a link to `/analytics/reports/<report>` with a
   ShopifyQL query for the period. The selector changes the bar only; the table did not
   change. Not verified: hover and click on a card.
2. **Views.** The "All" button opens a menu headed "Select a view": "All", "Unfulfilled",
   "Unpaid", "Open", "Archived". No counts. "View actions" on All has only "Duplicate
   view"; on the others "Rename view", "Duplicate view", "Delete view". Duplicate opens a
   dialog with a "Name" field (40 characters) and "Cancel" / "Create view". A view's own
   filters stay hidden until "Show view filters" (an eye icon) is pressed.
3. **Search.** One box labelled "Search and filter"; text applies on Enter. "1575" matches
   #1575; "Elena" and "Pet" match #1561 (customer, by word prefix); "Coconut" matches a
   item title. "Sofia" returned "No orders found" though rows show "Sofia Bennett";
   not explained. The empty state: "No orders found" / "Try changing the filters or search
   terms for this view" / "Clear search and filters". A URL `financial_status:paid` became a
   pill. Not verified: typing `field:value` by hand.
4. **Filters.** There is no "+" button. Focusing the box lists 26 filter names, from "Order
   status" to "Fulfill by". Each offers "Is" / "Is not" and a checkbox list that applies at
   once. Fulfillment status values: Fulfilled, Unfulfilled, Partially fulfilled, Scheduled,
   On hold, Request declined. A chosen filter is a pill, "Fulfillment status is
   [Unfulfilled]", with an "Add new filter" icon after the last. Right of the bar: "Clear
   search", "Reset view", "Save". "Save" opens "Save view as" with a "View name" field and
   "Discard" / "Save". No "Clear all". A pill's "Remove filter" button appears on hover.
5. **Display options.** "Sort by": Order, Date, Customer, Channel, Total, Fulfillment status,
   Payment status, Items, Destination, PO number, Fulfill by, Label status; "Oldest first" /
   "Newest first". Toggles "Group by batch" (on) and "Hide archived" (off). Columns reorder
   and hide by an eye toggle.
6. **Counts.** None on views or filters, no "Showing N orders". The nav badge ("88"), the
   pager ("1-50") and "Select all 50 on page" are the only numbers.
7. **Rows.** Order, flags, Date, Customer, Channel, Total, Payment status, Fulfillment
   status, Items, Delivery status, Delivery method, Tags. Payment badges are grey with a
   dot; "Unfulfilled" is a yellow chip with an open circle. An orange "!" opens a
   shipping-address popover with warnings; a red "!" one with errors and "Email customer".
   The note icon's tooltip is the order note itself. Struck-through rows are archived or
   cancelled.
8. **420 px wide.** Export and More actions collapse into "...", the period selector becomes
   a "Today | 7 days | 30 days" segmented control, the cards scroll sideways, the control
   row stays on one line, the table scrolls sideways.

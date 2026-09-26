# Making the vocabulary ubiquitous: screens, routes, and what never surfaces

## What prompted this

A JSDoc on `taskActions` in `src/lib/Domain.ts` said a task offers the same
verbs "on the run list and the work page". Neither phrase is on any screen.
The member's list is titled "Work" and each row opens a page headed by the
order name. "Run list" and "work page" are names the codebase gave two
routes, and they are the only screen names in `Domain.ts` built on "run",
the one noun the glossary itself says no screen may say.

That is a symptom. The vocabulary pass started at the bottom, in the
glossary and the action tables, and has been moving up. It reached labels,
copy and the lint that guards them. It has not reached the layer where
screens and routes get their names, so every JSDoc that mentions a screen
picks a name on the spot. There is no rule to converge on.

## What exists today

The glossary already separates three tiers for a word, and does it well for
states:

| tier   | example     | who reads it                 |
| ------ | ----------- | ---------------------------- |
| stored | `active`    | SQLite, the repository       |
| domain | open        | code, JSDoc, tests, research |
| screen | In progress | merchant or member           |

Nouns get the same treatment, and one row is already explicit that a domain
word has no screen word:

> run | one item going through one workflow | `Run` | (none): the merchant
> sees the item's workflow, the member work

`scripts/rules-lint.ts` enforces the screen tier: "run", "line item",
"finished", "in progress", "mark done", "unclaimed" are refused in string
literals and JSX text. Identifiers, comments, JSDoc and paths are exempt,
because those are the domain tier and "run" is the right word there.

So the rule "domain words in code, screen words on screen, the glossary maps
one to the other" is already stated and already enforced. What is missing is
narrower than it first looks.

### Gap 1: screens have no names

The glossary names nouns, states and verbs. It does not name screens. Every
JSDoc that needs to point at a screen improvises, and the improvisations are
inconsistent between the merchant side and the member side:

| route file                        | heading on screen | what JSDoc calls it                 | built on        |
| --------------------------------- | ----------------- | ----------------------------------- | --------------- |
| `app.orders.index`                | Orders            | the orders index, the index         | screen word     |
| `app.orders.$orderId`             | #1001             | the order page                      | screen word     |
| `app.workflows.index`             | Workflows         | the workflows index                 | screen word     |
| `app.workflows.$workflowId`       | workflow name     | the workflow page                   | screen word     |
| `app.workflows.$workflowId_.edit` | workflow name     | the editor                          | screen word     |
| `app.teams.index`, `$teamId`      | Teams, team name  | the teams page, the team page       | screen word     |
| `app.members`                     | Members           | the members screen                  | screen word     |
| `shop.$shop.index`                | Work              | the run list, the member's run list | **domain word** |
| `shop.$shop.work.$runId`          | #1001             | the work page                       | route segment   |

"Run list" appears in roughly 90 places across `src/`, `test/` and `e2e/`
(`Domain.ts` alone has 20, `shop.$shop.index.tsx` 13, `e2e/member-runs.member.spec.ts` 31).
"Work page" is on the same order. A rename is a sweep, not an edit, and it
should happen once against a decided name.

### Gap 2: the member side has no screen word for the run

The merchant's screen word for a run is settled and used: the item card says
"Finishing workflow", the buttons say "Cancel workflow" and "Change
workflow", the toast says "Attached Finishing." The merchant sees an item
and its workflow. The glossary row records that.

The member side never had to name the run, because the member's list row is
`#1001 · Brass hinge ×2` and their page is headed `#1001`. The glossary row
says "the member sees work", which is true of the page title and nothing
else. The member never sees a noun for the thing they are looking at. That
has been fine on screen. It is not fine in JSDoc, because a spec has to name
the thing, and with no screen word to reach for it reached for "run".

### Gap 3: routes were named before the vocabulary

Route paths and file names are code, and rules-lint treats them as code
(the "run" pattern exempts a word preceded by `/`, `$` or `.`). But they
were named ad hoc, and the two member routes show it:

- `/shop/$shop` is the member's list. The segment says nothing about what
  it lists; "shop" is the tenant.
- `/shop/$shop/work/$runId` mixes tiers: `work` is a screen-ish word that
  no screen uses as a noun for one run, and `$runId` is the domain word.

The merchant routes are consistent: `/app/orders`, `/app/orders/$orderId`,
`/app/workflows/$workflowId`, `/app/teams/$teamId`. Each segment is the
glossary noun and the parameter is that noun's id.

### Gap 4: the rule for which tier a site speaks is implicit

The glossary header says code uses domain words and screens use screen
words, and the lint enforces the screen half. Nowhere states, in one place,
which tier each _kind of site_ speaks: identifiers, route paths, JSDoc,
tests, e2e, log messages, research docs. Most of it is obvious once said,
and saying it is what stops the next paragraph inventing a rule.

## First principles

A name has one job in each tier:

- **Stored**: the column. Nobody reads it but the repository.
- **Domain**: the concept, compact and exact. Read by everyone who reads
  code. "Run" earns its place here because "workflow run" is what it is and
  "run" is shorter and never ambiguous in code, where the definition is
  always `Workflow`.
- **Screen**: what the person already knows. A merchant knows orders,
  items, workflows and teams. A member knows their order, its item, the
  tasks and who has them. Neither knows "run", and neither needs to: the
  merchant has the item and its workflow, the member has the item and its
  tasks.

A route sits between tiers. A URL is read by a browser and by the code that
builds links; a member may see it in the address bar, and a merchant sees
it inside the admin's URL (`admin.shopify.com/store/x/apps/baton/app/orders/123`).
It is not copy: nobody reads a URL as a sentence, and no lint reads it as
one. It is closest to an identifier that happens to be visible. The
merchant routes already treat it that way, and they read fine.

A spec (the JSDoc) is domain tier, but it has to _point at screens_, and a
screen is a thing with a name a person can find. "The order page" works
because a reader can open the app and find the page headed by an order.
"The run list" does not, because nothing on screen says run and nothing
says list.

## What the member is actually shown

Before naming anything, what is on the two member screens today, read off
the code rather than from memory.

**The list** (`shop.$shop.index`, heading "Work"). One row per run. Line
one is the order name in subdued text, then the item title in strong text.
Line two is every current task on the member's teams by name, then
"Step k of n", or the block reason, or "Started · <who>". Tabs: Mine, Up
next, Teammates, Blocked, Recent.

**The page** (`shop.$shop.work.$runId`, headed by the order name). The item
line (title, variant, ×quantity, SKU, properties), the order's note, the
block banner if any, then every step of the run with its tasks, badges and
verbs.

**The workflow name is not on either screen.** Neither the row nor the page
prints `run.workflowName`. The merchant's order page does: the item card's
Manage drawer opens with "Finishing workflow" in strong text over the same
step list. So the merchant is told what workflow an item is on, and the
member is not.

This is the murkiness. The row leads with an order number, which reads as
"this is an order", but it is one item of that order, and more exactly it
is one item's workflow, and nothing on screen says either of the last two.
The three-item order shows as three rows that all start with `#1001`, and
the only thing telling them apart is the item title.

## What the merchant is shown, and how they would talk about it

The merchant's order page is an order with a card per item. Each card's
drawer names the workflow and lists its steps. The buttons say "Attach",
"Change workflow", "Cancel workflow". The index's Status column says a
workflow is "Not started" or "In progress" for an order.

So the merchant's mental model, as the screens teach it, is: orders have
items, and an item has a workflow. If a merchant walks to the bench about a
problem they will say the order number, the item, and then "the workflow is
stuck at finishing". "Workflow" is the noun that carries the state. They
will never say "run", and the glossary is right that they should not have
to.

## What the competitors call the worker-facing unit

From `refs/` (marketing and help pages only; no source):

| app                    | unit the worker sees | notes                                              |
| ---------------------- | -------------------- | -------------------------------------------------- |
| Route to Ship          | ticket, in a queue   | order-level; "department", "stage", "step"         |
| Kanbanify              | card, on a board     | order-level cards; "stage"                         |
| BenchCue               | maker card           | per item; "taps the top card, works it, taps Done" |
| MakerBatch             | run sheet, batch     | "run" means a production run: many items at once   |
| Makers Production View | queue, batch, run    | same sense of "run": a batch across orders         |

Two things stand out. First, every competitor gives the worker a concrete
noun for the thing in front of them (ticket, card, batch). None of them
says "work" as the noun. Second, "run" in this market already means
something else: a production run, a batch of like items across orders.
That is one more reason "run" must not surface. A member who hears "run"
from another tool would take it to mean the batch, not one item's pass
through one workflow.

## Candidate framings for the member side

The question is what noun the member's list and page are _about_. Five
candidates, with what each one makes the screens say.

### A. Work (today)

The list is "Work", the row is `#1001 / Brass hinge ×2`, the page is
`#1001`. No noun for the unit.

- For: honest heading for the list, which is "what I have to do". No new
  word to learn.
- Against: no noun means no way to refer to one row, on screen or in a
  spec. The order number leads and misleads. The workflow name is absent, so
  a member cannot connect what the merchant said to what they see.

### B. Workflows

The list is "Workflows", each row is one workflow with its order and item
as attributes, the page is one workflow: its steps and tasks, with the
order and item shown as what it is for.

- For: one noun on both sides. The merchant's "the workflow on the hinge
  is stuck" is exactly what the member sees. It is the product's own word.
  The nesting is right: workflow holds steps, steps hold tasks, and the
  member's tasks are inside it. It matches the domain tier, where a run _is_
  a workflow instance, so the spec name and the screen name finally agree
  without "run".
- Against: on the merchant side bare "Workflows" is the definitions page.
  A member does not see that page, so the collision is only in the code and
  in conversation between merchant and member, where context resolves it
  the same way "the order" and "the order form" do. The other risk is a
  list titled "Workflows" reading as a list of kinds rather than of
  instances; the fix is that every row names the item and order, which it
  already does.

### C. Items

The list is items in production, the row is the item, the page is the
item and its workflow.

- For: the item is the physical thing the member makes, and it is what the
  page's top block already shows.
- Against: an item does not have steps and tasks; its workflow does. The
  page's body is the workflow, and calling it the item page mislabels most
  of what is on it. This is the objection you raised and it holds. It also
  fights the URL, where the id is a run id.

### D. Orders

The list is orders, the page is an order.

- For: the heading already says the order number.
- Against: false. A three-item order is three rows and three pages. It is
  the framing the current screens accidentally suggest and the one to get
  away from.

### E. Jobs or tickets (a new noun)

Introduce a bench word: "job", "ticket", "card".

- For: what competitors do; a concrete word for the unit; no collision with
  "workflow" the definition.
- Against: a fourth tier of vocabulary. The merchant would say "workflow"
  and the member "job" for the same thing, and the glossary would have to
  map run to two screen words. The whole point of this pass is one
  vocabulary across roles.

### Recommendation: B, workflows, with the workflow name on both member screens

The run is one item going through one workflow. The merchant already calls
it the item's workflow. The member should too. Concretely:

- The list heading is "Workflows". The heading is the noun, and the noun
  is the same one on every tier. The trade-offs are in the next section.
- The row leads with what the member makes and on which workflow, and the
  order number becomes the qualifier it is: `Brass hinge ×2 · Finishing`
  strong, `#1001` subdued and second. Today the order number is first,
  subdued, with the item title strong after it, and the workflow is
  absent. Leading with the item and naming the workflow is what fixes "it
  looks like an order".
- The page is headed by the item and names its workflow under the heading:
  `Brass hinge ×2`, `Finishing workflow · #1001`. Today it is headed `#1001`.
- The glossary run row's screen cell becomes: "the item's workflow, both
  roles; never bare, and never 'run'".
- Spec names: "the member's workflows list" and "the member's workflow page".
  "Workflow page" is honest about what is on it, and in a member-side
  JSDoc "the workflow page" cannot be confused with the merchant's
  `app.workflows.$workflowId`, which the merchant-side JSDocs already call
  "the workflow page" too. That is the one real cost of B: two screens
  with the same spec name on two sides. The Screens table carries the side
  as a column so a reader can tell which; if that proves confusing in
  practice, "the member's workflow page" is always available.
- Routes: `/shop/$shop/workflows` and `/shop/$shop/workflows/$runId`,
  with `/shop/$shop` redirecting to the list. Screen tier in the segment,
  domain tier in the parameter, the same split the merchant routes make
  (`/app/orders/$orderId` where `orderId` is Shopify's id and the segment
  is the glossary noun). `$runId` stays because it is a run id and the code
  that builds and decodes it says so. The earlier recommendation of
  `/runs/$runId` is withdrawn: with B the screen noun and the domain noun
  are one word apart, and the URL is the one place a member might read it.

What B costs: the "workflow" collision in code and conversation, and a
change to the member row and page headings, which is a design change with
its own e2e updates. What it buys: one noun across merchant, member, spec
and URL, and a member screen that finally says what the merchant is
talking about.

## The list heading: Work or Workflows

Both were on the table. The case for each, and why "Workflows" wins.

**Work.** A heading names what the page is for, and this page is for the
member's work. The tabs read naturally under it: Work / Mine, Work / Up
next. It is what the page says today, so nothing moves. Against it: "work"
is not a noun for any one thing on the page. A member cannot say "open the
work" and mean a row. It is the one screen in the app whose heading is not
its rows' noun (Orders lists orders, Workflows lists workflows, Teams lists
teams), and the exception is on the side that most needs the vocabulary
hammered in, because the member never sees the merchant's screens and
learns the words only from their own.

**Workflows.** The heading is the rows' noun, the noun is the page's
segment in the URL, the detail page is one of them, and the spec name is
the same word. A merchant who says "the workflow on the hinge" and a member
who taps a row under "Workflows" are naming one thing. The product is
"made-to-order production workflows" and the member's home says so.
Against it, three costs:

- The tabs. "Workflows / Mine" is a slight stretch, since a member holds a
  task on a workflow rather than owning the workflow. It is the same stretch
  as "Orders / Mine" would be for a merchant, and it reads fine in
  practice. You have said the tabs can be revisited later; this pass does
  not touch them.
- The word on the merchant side means the definition. The member never
  sees that page, so on screen there is no collision. In code the two lists
  live under `app.` and `shop.` and in the spec the Screens table carries
  the side. In conversation, "which workflow" is answered with the item and
  order, which the row shows.
- It is one more screen change in the sweep: the heading, the document
  title ("Workflows — Baton"), and the list route, which moves from the
  shop root to `/shop/$shop/workflows` so the URL says the noun too.
  `/shop/$shop` becomes a redirect to it. The mark in `MemberBar` links to
  the list directly. That is one route file rename, one redirect in
  `shop.$shop.index`, and the e2e paths.

Recommendation: Workflows. The generic heading was the last place the
member side stepped outside the vocabulary, and the reason to keep it
(the tabs read slightly better) is smaller than the reason to change it
(one noun everywhere, including the URL). The sweep is bounded.

## Recommendations

### R1. Add a Screens table to the glossary

One row per route that renders a page a merchant or member uses. Columns:
side, route file, the heading a person sees, the spec name. `pnpm
action-table check` verifies the route file exists. Proposed member rows:

| side   | route file                    | heading    | spec name                   |
| ------ | ----------------------------- | ---------- | --------------------------- |
| member | `shop.$shop.workflows.index`  | Workflows  | the member's workflows list |
| member | `shop.$shop.workflows.$runId` | item title | the member's workflow page  |

### R2. The run's screen word is "the item's workflow" on both sides

Recorded as the glossary rule, with the row and page changes above so the
member screens actually say it. Bare "workflow" stays the definition on the
merchant's Workflows pages; everywhere a run is meant, the item is beside it.

### R3. Routes: `/shop/$shop/workflows` and `/shop/$shop/workflows/$runId`

The segment is the screen noun, the parameter the domain id, as on the
merchant side. `/shop/$shop` redirects to the list, so the member's home
is still the shop root and the URL they read says the noun.

### R4. Write down which tier each kind of site speaks

| site                          | tier   | note                                              |
| ----------------------------- | ------ | ------------------------------------------------- |
| identifiers, types, callables | domain | `Run`, `listRuns`, `memberGetRun`, `RunListView`  |
| route parameters              | domain | `$runId`, `$orderId`, `$workflowId`               |
| route segments                | screen | `orders`, `workflows`, `teams`; a glossary noun   |
| log messages                  | domain | `ShopAgent.listRuns: shop=... runId=...`          |
| JSDoc, tests, research        | domain | screens named from the Screens table; copy quoted |
| string literals and JSX text  | screen | rules-lint enforces                               |

This goes in the glossary header. `AGENTS.md` gets one line pointing at it.

### R5. Sweep

Replace "run list" and "work page" with the Screens-table names across
`src/`, `test/`, `e2e/`. Rename both member route files, add the redirect,
regenerate the route tree. Change the list heading and document title, the
member row, and the page heading. Add the workflow name to both. Test whose title is the rule for the run's screen word. No
identifier renames.

## Decisions

Answered 2026-09-26. No open questions remain.

1. **Framing:** B, workflows. The run's screen word is "the item's
   workflow" on both sides.
2. **List heading:** "Workflows", with the list route at
   `/shop/$shop/workflows`. Reasoning in "The list heading: Work or
   Workflows". The tabs are unchanged in this pass and may be revisited.
3. **Row order:** item and workflow name first, order number subdued
   second.
4. **Page heading:** item title, with "<workflow> workflow · <order>"
   under it.
5. **Spec name collision:** "the workflow page" exists on both sides; the
   Screens table carries the side, and a JSDoc that mentions both sides
   qualifies.
6. **Routes:** `/shop/$shop/workflows` and `/shop/$shop/workflows/$runId`;
   `/shop/$shop` redirects to the list.
7. **Scope:** one pass: glossary, tier list, routes, screens, sweep.

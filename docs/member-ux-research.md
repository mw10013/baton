# Member area: UI and UX for people who do the work

Status 2026-09-12: **parked**. The prerequisite is the member-side trust boundary
(how a signed-in member reaches the shop's Durable Object and, through it, the Admin
API, over server functions and over a socket), which is researched separately in
`docs/member-auth-and-shopify-access-research.md`. Pick this doc and the plan back up
once that is settled; the screens do not depend on the answer, the transport does.

Research date: 2026-09-12. Scope: what a member (a maker or packer who signs in at
`/login`, not a merchant in the Shopify admin) should see and do, from the first sign-in
to finishing a step; the seed data that makes that explorable; and how seeded work relates
to real Shopify orders. A clickable prototype of every recommended screen is in
`docs/member-ux/prototype.html`. The implementation plan is at the end.

Companion docs: `docs/teams-members-ux-research.md` (the merchant side of members),
`docs/shopify-production-workflow-deep-dive.md` (competitor worker surfaces).

## Conclusion

1. **Sign-in lands on the work, not on a shop page.** A member with one shop goes
   straight from the magic link to that shop's queue. The shop picker exists only for
   the rare person on two shops, and the "Shop info" page goes away: nothing on it is
   something a worker acts on.
2. **The queue stays a list of cards, one card per unit of work, and the card stays
   actionable.** Start and Done live on the card, as today. A worker at a bench should
   never need a second click to say "I finished this." The board and the table were both
   considered and rejected below.
3. **Add one drill-down: the work page.** One route per run (`/shop/$shop/work/$runId`)
   for what does not fit on a card: every item on the order, the full step history with
   who did what and when, instructions in full, the order note, the block form. The card
   links to it; the card does not try to be it.
4. **Sort by attention, then by age.** Blocked and flagged first, then what I have
   started, then what my team has started, then untouched work oldest-order-first.
   Nothing on the floor is more useful than "what is oldest" once the exceptions are
   out of the way.
5. **Group by team only when the member is on more than one team, as chips, not
   sections.** Today a two-team member gets two stacked sections and a run can appear
   twice. A chip row ("All · Engraving · Finishing") filters one list instead.
6. **The packer card is the order card.** For an order-workflow step the card lists every
   line item with its made/not-made state and its personalization, because the packer's
   job is to check the box against the order. That card already exists; it needs the
   detail link and the sort, nothing more.
7. **Mistakes are undone from a Done tier, not a confirm dialog.** The queue ends with a
   collapsed "Done today" tier listing what the team finished in the last 24 hours, each
   entry with Undo and Note. Undo re-opens the step as long as nobody downstream has
   started; otherwise it says who has and refuses. No confirmation on Done: a bench needs
   one press, and a wrong press is fixed in the tier it moved to.
8. **Everyone sees the team's queue.** Small and medium shops share benches and cover for
   each other; "mine only" hides the work a colleague left half done. The Mine tier keeps
   my own work at the top without hiding the rest.
9. **A light top bar with the Baton mark.** The member area has no App Bridge chrome, so
   it needs one persistent line of orientation: the mark, the shop name, Sign out. The
   page heading is then free to say "Your work".
10. **No printing yet.** A print stylesheet on the work page gives a job ticket for free;
    a print action or a print gate waits until a merchant asks.
11. **Live updates, polling first.** The queue is shared by a team, and a teammate's
    Done should move the card without a refresh. The admin's socket is authenticated by
    the Shopify session, which members do not have, so the member queue polls every
    fifteen seconds now and gets its own member-authenticated socket later if polling
    shows.
12. **Realistic seed data.** The fixture is now a fictional gift maker with named teams,
    named steps, personalization, and orders at every stage of a day. Abstract
    `Workflow 03 / Step 2a` data proved the plumbing; it could not tell us whether a
    screen reads well.

## What exists today

Member auth is a magic link over better-auth. `/login` takes an email; an email that is
not a member of any shop gets the same "check your email" response and no link. In
`DEMO_MODE` the link is rendered on the page instead of emailed. The session cookie
identifies the person; `requireMember({ shop, email })` resolves their membership and
active teams per request.

Three routes make up the member area:

| Route               | Heading    | What it shows                                                       |
| ------------------- | ---------- | ------------------------------------------------------------------- |
| `/shop`             | Your shops | The member's email, a link per shop, Sign out                       |
| `/shop/$shop`       | Shop name  | The myshopify domain, "You have member access", the teams, one link |
| `/shop/$shop/queue` | Your work  | Cards for every run with a ready step on one of the member's teams  |

The queue card carries: order number, workflow badge, "In progress" badge, the line item
with quantity and personalization, the order note, a "Needs attention" banner when the
run is flagged, then one box per ready step with Step k of n, the step name, "together
with" siblings on other teams, instructions, "In progress since … by …", the note, and
Start / Done / Note. Below the steps: Block and, when flagged, Dismiss. With more than
one team the cards are repeated under a section per team. Empty state: "Nothing to do
right now."

The layout is `s-page` with `inlineSize="small"`, a single column of about 600px, no
navigation, no header actions. There is no detail route: the card is the detail. There
is no scanning, no kiosk mode, no per-device mode.

What is right about it: the action set is tiny (Start, Done, Note, Block), the
personalization is on the card, and a step is offered only when it is ready. What is
missing: a place for history and context, an order for the list, a way to tell my work
from my team's, and any real-time behaviour.

## The competitive frame, briefly

Route to Ship is the only competitor with a real external worker login, and its worker
screen is a queue of tasks grouped by order with Accept / Done / Escalate and a "Focus"
tablet view with large controls. Kanbanify is a board, but for the merchant. The others
(Maker's Production View, MakerBatch, BenchCue) are admin-embedded grouped lists or
printouts; a worker there either has admin access or works from paper. Nobody scans
barcodes, nobody has a PIN, nobody shows a worker a colleague. The bar for "a worker
surface" is therefore low; the differentiator the deep-dive already named is the quality
of the card: everything the worker needs, normalized, with nothing to hunt for.

## The screens

### 1. Sign-in and landing

Keep `/login` as is. Change where the link lands: `/login-callback` should send a
one-shop member to `/shop/$shop/queue` (rename the route to `/shop/$shop`, see below), and
a multi-shop member to `/shop`. The shops page keeps Sign out; it is otherwise a list of
links.

The current `/shop/$shop` page ("Shop info" plus "Your teams" plus "See your work") is
removed. Its one useful sentence, "You're not on a team yet. Ask the shop owner to add
you to a team to see work", becomes the queue's empty state for a member with no teams.
The queue page becomes `/shop/$shop`.

### 2. The queue ("Your work")

A top bar above the page, not part of it: the Baton mark (`public/favicon.svg`, the only
mark there is, and it is fine), the shop's name, and Sign out on the right. It is the
member area's one piece of chrome and it answers "where am I and who am I signed in as"
on every screen; the work page keeps it too. The page heading under it is "Your work",
with the member's email small and subdued. Members do not get an `s-app-nav`: there is
one page and one drill-down, and a nav with one item is noise.

Team chips, only when the member is on more than one team: All, then one chip per team,
with a count. A run appears once in the list; when the member could act on steps for two
teams in the same run, both step boxes are on the one card, as today.

Sort, in tiers:

1. Needs attention: flagged runs (blocked by a person, or a reconcile flag such as
   quantity changed).
2. Mine: runs where I started a step that is still open.
3. In progress: a teammate started it. The card says who.
4. Up next: nothing started, oldest order first (by `processedAt`).

5. Done today: steps a member of this team completed in the last 24 hours, newest first,
   collapsed behind its count.

Within a tier, oldest order first. A count per tier in a small heading ("Up next · 6")
gives the worker the shape of the day at a glance; it is the one number that matters at
a bench.

The Done tier is where mistakes get fixed and where a worker sees what they have done.
Each entry is one completed step: order number, item, step name, who and when, the note
if any, and two actions. **Note** edits the step note after the fact (the repository
already allows a note on a done step). **Undo** re-opens the step. It is allowed while
nothing downstream has moved: no step in a later stage of the run has been started, and
for an item run the order run has not been started either. When something has moved the
button is replaced by "Leather started Stitch spine · ask them", because the fix is now
a conversation, not a click. Anyone on the step's team may undo, not only the person who
pressed Done; small shops notice each other's mistakes. Undo clears the completion but
keeps who started it, so the step returns to "In progress" rather than "Up next".

Why not a confirmation on Done: it doubles the presses on the one action a bench does
all day, and it does not catch the mistake that matters (pressing Done on the wrong
card, which a confirm would confirm just as readily). Why not an Undo toast: five seconds
is not when a worker notices; they notice when the next card looks wrong. A tier that
stays for a day is the honest version of both.

Card contents, in order:

- Order number, workflow badge, and a status badge that encodes the tier (Blocked
  critical, Mine success, In progress info, nothing for Up next).
- The item: title, variant, quantity, then personalization as a definition list rather
  than a comma-joined string. "Engraving: The Millers · est. 2019" is the thing the
  worker will physically make; it deserves a line of its own and a stronger weight than
  the title.
- The step: "Engrave · step 2 of 3", the "together with" line when the stage is
  parallel, instructions in full (they are short; if a merchant writes long ones the
  detail page has them too).
- Actions: Start / Done as today; Note and Block move to the detail page. A card with
  four buttons per step is what makes today's queue feel busy.
- A link to the work page in the card's heading (the order number).

The "Order note" line stays on the card: a merchant writes it for exactly this reader.

Quantity: a run for two units shows "×2" and one Done. Route to Ship ticks units one at
a time. Not for now; see open questions.

### 3. The work page (`/shop/$shop/work/$runId`)

The drill-down. Heading is the order number; back link to the queue. Sections:

- **This item** (item run) or **Items on this order** (order run): title, variant,
  quantity to make, personalization as a definition list, SKU if present. For an order
  run, each item with its made / in progress / not started / no steps badge.
- **Steps**: every step of the run in stage order, each with team, state (done by whom
  at what time, in progress since, ready, waiting on stage N), instructions, note. The
  member's own ready steps get Start / Done here as well as on the card. This is the
  first place a worker can see that "Stitch spine" at Leather is happening alongside
  "Stamp monogram", and who finished "Cut leather".
- **Notes**: the order note (read-only) and the step note editor for the member's steps.
- **Block**: a text field and "Mark blocked", and when flagged, the banner with Dismiss.

For order runs the packer sees the whole order here; for item runs the other line items
on the same order appear as a small "Also on this order" list so a maker knows the ring
ships with a journal. Both read live from the order, like today's order-run card.

### 4. Empty and edge states

- No teams: "You're not on a team yet. Ask the shop owner to add you to a team to see
  work." No chips, no tiers.
- Teams but nothing ready: "Nothing to do right now." Keep it; a worker with nothing to
  do has nothing to do.
- Member removed from the shop mid-session: `requireMember` already returns not found;
  the page should say "You no longer have access to this shop" with a link to `/shop`.
- Run that moved on while the card was on screen (teammate pressed Done): the socket
  removes the card; if the member presses Done first the existing `NotReady` message
  ("Someone finished an earlier step just now …") stays.

### 5. Layout and device

Phone width is the design width. A maker at a bench holds a phone or has a tablet on a
stand; nobody there has a 1400px monitor. `s-page inlineSize="small"` already gives a
single column; the card must read at 400px: stack the badge row, keep buttons full-width
on the narrowest screens, no side-by-side text field and button (today's note and block
forms do that and wrap badly).

A `@media print` stylesheet on the work page hides the actions and prints the item,
personalization, and step list as a job ticket. That is the whole of printing for now.

Polaris web components used: `s-page`, `s-section`, `s-stack`, `s-box`, `s-badge`,
`s-banner`, `s-button`, `s-link`, `s-heading`, `s-text`, `s-paragraph`, `s-text-field`,
`s-clickable-chip` for the team filter, `s-divider`. Everything in the prototype maps to
one of these; the prototype is styled with Polaris tokens so it reads like the real thing
but it is plain HTML, not the components.

### Rejected

- **A kanban board.** Columns per step only make sense for one workflow; a member on
  Engraving sees steps from four workflows. Drag and drop is also wrong at a bench.
- **A table.** Personalization and instructions are the content; they do not fit a row.
- **Tabs per team.** Polaris web components in the app-home surface carry no tabs
  element; chips do the same job with one list.
- **Accept / claim as a separate action from Start.** Start already snapshots who and
  when and marks the run active. One verb.
- **Per-unit ticking.** Adds a counter to every card for the minority of multi-unit
  lines; a worker who finishes one of two can write a note today.

## Seed data

`e2e/fixture.ts` is now a fictional made-to-order gift shop. `pnpm seed` posts it to the
local `/api/dev/seed`; the app must be installed on the sandbox shop first.

Logins (all sign in by magic link at `/login`; `DEMO_MODE` shows the link on the page):

| Email        | Teams                | Why it exists                                |
| ------------ | -------------------- | -------------------------------------------- |
| `lead@m.com` | every team           | one login that sees every queue              |
| `m1@m.com`   | Woodshop             | makers, one per item-workflow team, in order |
| `m2@m.com`   | Engraving            | the busiest bench: four workflows land here  |
| `m3@m.com`   | Leather              |                                              |
| `m4@m.com`   | Jewelry              |                                              |
| `m5@m.com`   | Textiles             |                                              |
| `m6@m.com`   | Finishing            |                                              |
| `m7@m.com`   | Engraving, Finishing | the two-team member: chips / grouping        |
| `m8@m.com`   | none                 | "not on a team yet"                          |
| `p1@m.com`   | Quality check        | packing side, one per order-workflow team    |
| `p2@m.com`   | Packing              |                                              |
| `p3@m.com`   | Shipping             |                                              |
| `p4@m.com`   | Packing, Shipping    | two-team packer                              |

Item workflows (tag in parentheses): Engraved cutting board (`engraved-cutting-board`,
three linear steps with instructions), Leather journal (`leather-journal`, parallel
middle stage, Leather starts and finishes), Signet ring (`signet-ring`, linear, Jewelry
starts and finishes), Embroidered blanket (`embroidered-blanket`, two steps with a
pending draft that adds a third), Photo frame (`photo-frame`, three-wide first stage,
seeded off), Pet tag (unassigned step) and Wholesale sample (no steps) for the warning
rows. The order workflow is Inspect (Quality check) → Pack (Packing) ∥ Print label
(Shipping) → Hand to carrier (Shipping).

Orders, read down as a day on the floor:

| Order | State                                                  | Who sees it                              |
| ----- | ------------------------------------------------------ | ---------------------------------------- |
| #1001 | fresh cutting board, nothing started                   | Woodshop                                 |
| #1002 | ring and journal, each one step in, next steps started | Engraving (two cards), Leather           |
| #1003 | journal ×2 at the parallel stage                       | Engraving and Leather, "together with"   |
| #1004 | two blankets made; order run ready                     | Quality check, with a gift note          |
| #1005 | inspected; Pack and Print label ready together         | Packing and Shipping                     |
| #1006 | fully made and packed, still unfulfilled in Shopify    | nobody; Ready to ship on the admin index |
| #1007 | board ×2 with one unit refunded                        | Woodshop, "×1 to make"                   |
| #1008 | ring blocked by a worker with a reason                 | Engraving, "Needs attention"             |
| #1009 | unpaid journal                                         | nobody; Not paid on the admin index      |
| #1010 | gift card, no workflow matches                         | nobody; No workflow on the admin index   |

To get there the order seed grew three options beside `done`: `advance: n` completes n
rounds of ready steps (item runs first, the order run once the items are made),
`started` presses Start on whatever is then ready, and `blocked` flags every open run
with a reason. All three go through the same `completeStep` / `startStep` / `blockRun`
the floor uses, so a seeded card is indistinguishable from a real one. Readiness for a
round is decided on a snapshot before any step is completed; the first cut asked the
repository as it went and ran every order to done in one round.

## How seeded work relates to real orders

Seeded orders are rows written straight into the shop's Durable Object with ids under
`gid://shopify/Order/seed-`. They go through the same upsert-and-reconcile path a
webhook does, so runs, flags and the order run behave identically, but they are not in
Shopify: the admin order page's "View in Shopify" link goes nowhere, and a Shopify-side
change (refund, fulfilment) can never arrive for them. That is fine for the member area,
which never links to Shopify (members have no Shopify account), and it is the reason
`orders` exists in the fixture at all: a populated queue without tagging products.

For real orders the chain is: the merchant tags the product with the workflow's tag →
an order is paid → the `orders/*` webhook (or the bulk sync) upserts the order into the
object → reconcile matches line items to workflows by tag and creates runs. In the
sandbox that means tagging a product `signet-ring` by hand, placing a test order, and
marking it paid. None of that is automated today and it does not need to be for UX work;
the seed covers every state the member area can show. When it becomes worth it, the
right tool is a second dev endpoint that tags the sandbox products from the fixture's
tag list through the Admin API, so a test order on the sandbox routes like a real one.

Two things a real order has that a seeded one lacks, and that the card may want:

- **Age and deadline.** `processedAt` is on the row; "ordered 3 days ago" costs nothing
  and is the natural secondary sort key. A promised ship date is not in the order; it
  would come from a metafield or a shipping SLA the merchant sets on the workflow. Out
  of scope, noted.
- **Product image.** Not synced. A thumbnail on the card would help a packer confirm the
  item at a glance; it needs `product.featuredImage` on the line item sync. Noted for the
  work page, not the queue.

## Decisions on the questions the first draft left open

Recorded after review, with the reasoning, so the prototype and the plan follow them.

**Undo and seeing one's own work.** Workers make mistakes and notice them late, so the
fix has to live where the work went: a Done tier at the bottom of the queue and Undo on
the work page, both under the downstream rule (nothing in a later stage started; for an
item run, the order run not started). This needs one new repository action,
`uncompleteStep`, that clears `completedAt` / `completedBy` / `completedByEmail`, leaves
`startedAt` and `startedBy` in place, and recomputes the run status (the existing
recompute already turns a `done` run back to `active`). A `done` run whose last step is
undone is no longer done, and an order run that was ready becomes not ready again, all
by the existing readiness query. No audit trail of the undo for now; the step simply
reads as in progress by its original starter. Revisit when there is a merchant-side
activity view.

**Team queue or mine only.** Team queue, sorted, with Mine on top. Small and medium shops
are the target; a person covering a colleague's bench needs to see the colleague's
half-done work, and a lead needs the whole picture. The Done tier is the team's, not the
person's, for the same reason. If a shop turns out to want a Focus mode it is one chip
("Mine") on the existing row.

**Printing.** Deferred, and not planned as a feature. Shopify already prints packing
slips and the merchant does that from the admin. Route to Ship's print gate exists
because its stations are templates that print job tickets; Baton's card is the job
ticket, on a phone, and the work page prints as one. A print action or a "printed" gate
should wait for a merchant to ask; if one does, it is the packer's order card that gets
it.

**Header.** The question was whether the shop name as the page heading is enough
orientation, or whether the member area needs a persistent bar. It needs the bar: the
member area has none of the admin's chrome, and a phone page that scrolls loses its
heading at once. The bar is the mark from `public/favicon.svg`, the shop name, and Sign
out; nothing else until there is something else.

**Where the implementation plan lives.** In its own document,
`docs/member-ux-implementation-plan.md`, written to be handed to another agent: routes,
schema, repository actions, page by page, with the tests. This research doc records the
reasoning and the decisions, which do not change as the plan is executed; the plan is
consumed step by step and is what goes stale. Keeping them apart means the plan can be
deleted when it is done without losing the why.

## Implementation plan

Written up separately in `docs/member-ux-implementation-plan.md`. In one line each: land
on the queue; snapshot `processedAt` on runs; tiers, chips, top bar, and the card
redesign; the Done tier with `uncompleteStep`; the work page; socket updates; Playwright.

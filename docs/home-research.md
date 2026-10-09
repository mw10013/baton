# Home: what the merchant's landing page is for and how it should look

Written 2026-10-08, after every phase of the help research closed (`docs/help-research.md`). The
question: what should the merchant's home page (`app.index`, the Screens table's "Baton", template
`homepage`) show? The one fixed point is the plan card: the two meter tiles and **Manage plan**
stay. The help's follow-ups wait on this: Home has no pictures until it is redesigned, and
Installing describes it in prose.

Sources: `src/routes/app.index.tsx` and `src/components/QuotaBanners.tsx` (today's page);
`refs/bang/src/routes/app.index.tsx` (Bang's home); Shopify's guidance in
`refs/shopify-docs/docs/apps/design/user-experience/app-home-page.md`, the Homepage template
(`refs/shopify-docs/docs/api/app-home/latest/patterns/templates/homepage.md`), the setup-guide and
metrics-card compositions beside it, and Built for Shopify requirements 4.2.2 and 4.2.3
(`refs/shopify-docs/docs/apps/launch/built-for-shopify/requirements.md`); `Domain.OrderCounts` and
the strip on the orders index (`src/lib/domain/ShopWork.ts`, `src/routes/app.orders.index.tsx`,
`src/components/screen/Strip.tsx`); the templates and parts tables in `src/lib/Screen.ts`; the
Getting started tree in `src/lib/helpPages.ts`.

## Short answers

- **Home answers four questions, in this order:** is Baton set up, does anything need me, where do
  I stand on my plan, where do I learn more. Today's page answers only the third and fourth.
- **Set up: a three-step guide that disappears when the three facts hold.** A team with a member;
  an active workflow; an item that has started a workflow. Each step is a fact Baton already
  stores, not a checkbox, so there is nothing to dismiss and nothing to store. The first two steps
  have a button; the third has none, since orders arrive by webhook. Each links its Getting
  started page.
- **Needs me: the orders strip, as links.** The same five cells as the orders index (No workflow,
  Not started, Making, Made, Issues), same labels and counts, each a link to Orders with that
  value chosen. It is the page's daily value, and it is what Built for Shopify 4.2.3 asks for:
  "clearly indicate if the app is set up and working".
- **Plan: today's card, unchanged, below the strip.** No trial line (decision 8, reversed
  2026-10-08).
- **Learn: the foot line stays; no help cards.** Bang's help cards are static links; the setup
  guide's per-step links are the same links where the merchant needs them.
- **No primary action, no welcome paragraph, no chart.**

## What is there now

```
Baton
[red banner: New orders stopped syncing at 2,500 open orders. …]   ← only after the ceiling
Usage and capacity
  ┌ Orders this billing cycle ─────┐ ┌ Members ───────────────────────┐
  │ 120 of 200 included            │ │ 4 members, 50 included         │
  │ ███████░░░░                    │ │ █░░░░░░░░░░                    │
  │ Resets Oct 31.                 │ │                                │
  └────────────────────────────────┘ └────────────────────────────────┘
  [Manage plan]
            Learn more in Help.
```

Facts from `src/routes/app.index.tsx`:

- The loader reads the plan status, the shop's usage from the object and the member count from
  D1. It also reads `planBoundaryAt` (cycle end, or trial end during a trial) and the component
  never renders it.
- No tier name anywhere, by rule (the component's JSDoc): the meters say what the merchant has.
- The quota banner is the one alarm, shared with the orders index.
- Home is not an item in the admin's app nav: `rel="home"` on its `s-link` makes the app's name
  the way there, which is also Built for Shopify 4.1's rule. A merchant lands here every time they
  open Baton from the admin sidebar.

Against Built for Shopify, today's page passes 4.2.3 only narrowly: it has metrics (orders, members)
but they are billing metrics, and nothing says whether Baton is working, which is the requirement's
first clause.

## What Shopify asks of a home page

- **Purpose** (app-home-page.md): "Provide status updates. Enable merchants to respond to immediate
  needs. Provide clear call-to-action buttons."
- **4.2.3 Helpful homepage:** "clearly indicate if the app is set up and working, and, if possible,
  indicate how well the app is performing." Refused: no metrics where obvious ones exist; a home
  that, once its dismissible parts are gone, is "only static content", "links to other parts of
  the app or a static welcome message".
- **4.2.2 Helpful onboarding:** concise, guides to completion, not collapsed or out of view, and
  "after onboarding has been completed, there is [a] mechanism to remove UI related to onboarding".
- **4.3:** no multi-paragraph text on the home page.
- **The Homepage template** composes a banner, metrics cards, a setup guide (a dismissible,
  collapsible checklist with a progress count), a list of things needing attention, and a footer
  help line.

## What Bang did

Bang's home (`refs/bang/src/routes/app.index.tsx`) is three things: one status banner chosen from
five states (over capacity, full, daily limit reached, almost full, almost used); "Usage and
capacity", two meter tiles and Manage plan, which is where Baton's plan card came from; and a "Help"
section of a definition paragraph and four help-section cards opening `/help` in a new tab. Its
primary action was **Live**, the screen a merchant used daily.

Its comment says why the help cards are there: they replaced onboarding steps that were "the same
three steps as /help/getting-started", so home pointed at help rather than holding a second copy.

What to take: the plan card (already taken); the primary action as the one daily screen, as an
idea; the new-tab link to help (already taken by the foot line). What not to take: the help cards
and the definition paragraph. Bang's onboarding steps were prose a merchant read; Baton's steps can
be facts Baton checks, which is a different thing from a copy of the help, and Baton's copy rules
cut a paragraph that explains the product beside content. Bang's five-state banner ladder Baton
already reduced to one banner on purpose (the JSDoc on `QuotaBanners`).

## First principles

### Who arrives, and why

The merchant opens Baton from the admin sidebar. They land on Home whatever they came for. So Home
is the most-seen screen and the least worked: the work is on Orders, Workflows, Teams. A home that
holds work duplicates a screen; a home that holds nothing is a click in the way.

So Home's job is to route: say what state the shop is in, in a glance, and put the next click under
the merchant's hand. It earns its place only if a merchant who looks at it for two seconds knows
something they did not, and if the click they make next starts there.

### The four questions

| question                              | who asks it                  | answer on Home                                                  | today           |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------- | --------------- |
| Is Baton set up?                      | a new merchant, for a week   | the setup guide: three facts, each with its action              | nothing         |
| Is it working, does anything need me? | every merchant, every day    | the strip: where open orders are, Issues among them; the banner | the banner only |
| What am I paying for?                 | every merchant, now and then | the plan card                                                   | the plan card   |
| How do I learn this?                  | a new merchant               | the guide's per-step links; the foot line                       | the foot line   |

Order on the page follows frequency weighted by urgency: the alarm (banner), then setup while it
lasts (it blocks everything else being true), then the daily state, then the plan, then help.

### Setup as facts, not a checklist

Getting started (`src/lib/helpPages.ts`) already orders setup: a team and members, a workflow, an
order. Each step's completion is something Baton stores:

| step                             | done when                             | the step's button                                      | its help page                           |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Create a team and add a member   | some team has at least one member     | **Create team** (or **Add member** once a team exists) | Creating a team and adding members      |
| Create a workflow and turn it on | at least one workflow is Active       | **Create workflow**                                    | Creating your first workflow            |
| An item starts a workflow        | some item has ever started a workflow | none                                                   | Following an order through its workflow |

Why facts and not ticks: a tick is a second record of something Baton already knows, it can be
wrong (ticked, then the team deleted), and it needs storage per shop and a dismiss path. A fact
needs neither, and it satisfies 4.2.2's "mechanism to remove": the guide goes when the facts hold.
It also makes the guide a status, which is what 4.2.3 asks: if a merchant later turns off every
workflow, the guide's second step comes back undone, and that is true.

Why "an item has started a workflow" and not "an order synced": an order with no matching workflow
is No workflow, and Baton is not yet working for that shop. The third fact is the first moment
Baton does what it is for.

Why the third step has no button (decision 1): orders reach Baton by the orders webhooks as they are
placed, so the step completes on its own once a product carries an active workflow's tag and an
order for it arrives. **Sync open orders** is the one-time catch-up for open orders placed before
install (nothing syncs on install, the JSDoc in `src/components/help/getting-started/installing.tsx`)
and for a gap after the order ceiling. Putting it on Home would teach it as a routine. It stays where
it is: the Orders page, its first-run empty state, and Installing's steps. The step's line says
what happens instead: "New orders arrive as they are placed."

The facts' cost: the member count is already read from D1. "Some team has a member", "some
workflow is Active" and "some item has started a workflow" are three `exists` reads in the object,
one statement each over indexed tables. To verify in the plan: the existing indexes on the run and
team-membership tables cover them.

### The strip on Home

The orders index's strip is five counts over open orders, honouring only the team select, read in
one statement through the partial index on open orders (`Domain.OrderCounts`). On Home it is the
same statement with no team and no page. Each cell becomes a link to `/app/orders?show=<value>`
instead of a filter press.

Why the whole strip and not only Issues: the strip is the shape of the bench (how many orders wait
for a workflow, wait to start, are being made, are made and waiting to ship), which is the "how well
the app is performing" of 4.2.3; Issues alone says only what is wrong. Why the same cells and labels:
a merchant who sees "Making 34" on Home and clicks it should land on a list with 34 rows under a
cell that says "Making 34".

This repeats the top of the orders index. The case for it anyway: it is the screen's most useful
fact, and Home without it is the static page 4.2.3 refuses.

### What the strip costs

Not an extra query, if Home asks for exactly what the orders index asks for on arrival. The counts
come with `listOrders` (`OrdersPage.counts`), and `listOrders` is memoized in the object
(`ordersMemo` in `src/lib/agent/ShopWork.ts`): keyed by the input and the D1 teams, kept until the
next publish empties it. Home calls `listOrders` with the orders index's default input (no search,
no Show value, no team, no cursor, the index's page size), so Home and the orders index share one
memo entry. After a publish, the first of them to refetch pays the read and the other gets the
entry.

The read itself was measured on 2026-10-03 with the `Run (orderId, state)` index in place: about
88,000 rows read for the default page at 2,100 open orders, which is near the 2,500 open-order
ceiling. The counts statement in it costs one row per open order through the partial index. The
live refresh is throttled to one refetch per tab per 2 seconds (`INVALIDATION_THROTTLE_MS` in
`useLiveQuery`). The 2026-10-03 cost estimate for the target shop (25 members, 2 merchants, 2,000
open orders) already prices the merchant's orders index open all day; a merchant on Home instead of
Orders adds nothing, and on both at once reads the one entry.

What would make it expensive: a counts-only read with its own input, which is a second memo key
and a second read per publish. The plan should not add one. The page rows Home discards (the
default page's 25 orders) are already read for the memo entry, so taking only `counts` from the
result is free. `ORDERS_PAGE_SIZE` lives in `src/routes/app.orders.index.tsx` today; the two
routes have to share it, or the keys differ.

### What Home leaves out

- **A welcome paragraph or definition.** The copy table refuses it beside content, and 4.3 refuses
  multi-paragraph home text. How Baton works is a help page.
- **A primary action.** During setup the guide carries the next action; after it, there is no one
  action a merchant does from Home. Bang's **Live** was its one daily screen; Baton's daily screen
  is Orders, which is one click away in the strip.
- **Charts and trends.** Made per week would be a real performance metric, but no history read
  exists, and the strip and the order meter already say volume. Later, if merchants ask.
- **Recent activity** (latest started, latest blocked). A second list of orders that Orders already
  sorts; Issues covers the ones that need the merchant.
- **Help cards.** See Bang above.
- **A tier name.** Unchanged rule.

## Proposed page

During setup:

```
Baton
[quota banner, only after the ceiling]

Getting started                                     1 of 3 done
  ✓ Create a team and add a member
  ○ Create a workflow and turn it on      [Create workflow]   How to
  ○ An item starts a workflow                                   How to
    New orders arrive as they are placed.

Orders                                                   (strip, links)
  No workflow  Not started  Making  Made  Issues
       0            0          0      0      0

Usage and capacity
  [Orders this billing cycle tile] [Members tile]
  [Manage plan]

            Learn more in Help.
```

After setup the Getting started section is gone and the strip is the top of the page.

Parts: the setup guide is a new part (a row in the parts table: a heading with a count, then a
list of steps, each a state mark, a sentence, a button and a link), `homepage` only. The strip
needs a link variant (an `href` per cell instead of `onSelect`, nothing chosen). The plan card is
unchanged. The foot line is unchanged. No layout in the route.

Live: the strip on the orders index refreshes over the shop socket (`useLiveQuery`). Home's strip
would read the same events, so a member pressing Start changes Home's Making count without a reload.
That adds a row to the events table on `useLiveQuery`.

Follow-on work outside the page: Installing's paragraph on the home page, the Getting started hub's
lead, and the home pictures the help research deferred.

## Decisions

Reviewed 2026-10-08 in Plannotator. Every recommendation was accepted, two with notes.

1. **The setup guide is derived from facts.** No ticks, no dismiss button; it hides itself when
   the three facts hold. Note taken on review: the third step carries no **Sync open orders**
   button. New orders arrive by webhook; Sync is a one-time catch-up that stays on the Orders page,
   so Home never teaches it as a routine (see "Setup as facts, not a checklist").
2. **The three steps:** a team with a member, an active workflow, an item that has started a
   workflow.
3. **A completed guide comes back when a fact stops holding.** It is a status, and needs no stored
   flag.
4. **The guide's heading is "Getting started"**, its count "1 of 3 done".
5. **The strip on Home has all five cells**, the orders index's labels and counts, each a link to
   Orders with that value chosen. Asked on review whether it is an expensive query: it is not, if
   Home reads `listOrders` with the orders index's default input and so shares its memo entry (see
   "What the strip costs"). A counts-only read with its own key is what to avoid.
6. **The strip is live**, over the socket like the orders index; a row in the events table on
   `useLiveQuery`.
7. **The plan card goes below the strip.**
8. **No trial line.** Accepted on review, then dropped 2026-10-08 while the plan was written:
   `PlanStatus` cannot tell a trial from a billing cycle (`boundaryAt` is either end), so the line
   would need a new trial field carried from `AppSubscription` for one sentence. Shopify's own
   pricing page and the admin's billing settings already show the trial. The loader's unused
   `planBoundaryAt` goes with it.
9. **The plan card's heading stays "Usage and capacity".**
10. **No primary action.**
11. **No help cards.** The guide's "How to" links and the foot line.
12. **No performance metric beyond the strip** until a merchant asks.
13. **Five zeros on a shop with no open orders**, as on the orders index.

## Next

A plan, `docs/home-plan.md`: the setup-guide part and its parts-table row, the strip's link
variant, the three `exists` reads and their indexes, the shared page size, the `useLiveQuery`
events row, the route, the kit page, tests, then Installing's paragraph and the Home pictures the
help research deferred.

Implemented 2026-10-08 per `docs/home-plan.md`, all six phases, uncommitted; deviations recorded in
its last section.

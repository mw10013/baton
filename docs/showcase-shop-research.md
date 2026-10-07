# The showcase shop: seed data, products and orders for the help's screenshots

Written 2026-10-07, after commit 7bd7529. The question: what data should the help's screenshots
show, and how does the dev store come to hold it? The help needs pictures in which every name reads
like a real merchant's shop. Today's data cannot give that. `pnpm seed` posts `e2e/fixture.ts`,
which is built from worst cases: names that carry their own diagnosis ("Tag stamping (unassigned
task)"), a 32-character team, `lead@m.com`, and hundreds of generated orders. The dev store's
products are six leftovers ("Product-01", "30 Coin Contribution", chocolates and coffee, tagged
`workflow-01` to `workflow-06`), and it has one real order, #1001.

Sources: the help tree (`src/lib/helpPages.ts`, the tree table in `docs/help-research.md`); every
merchant and member route, read for the conditions that make each badge, count, empty state and
control appear; the seed path (`scripts/lib/seed.ts`, `src/routes/api.dev.seed.ts`,
`seedWorkflows` and `seedOrders` in `src/lib/agent/ShopWork.ts`, `SeedProgress` and
`SeedOrderChange` in `e2e/seed.ts`); the sync path (`src/lib/OrderSync.ts`,
`src/routes/webhooks.orders.ts`, `shopify.app.toml`); the dev store itself, read on 2026-10-07
through `shopify store execute`; and a capture test against the running dev server on 2026-10-07
(the results are in "Capture", below, and in the Screenshots section of `docs/help-research.md`).

## Short answers

- **A second fixture, `showcase`, beside the dev fixture.** `pnpm seed` keeps meaning the dev
  fixture: the kit page, the visual review and several JSDoc examples lean on its names. The
  showcase is opt-in: `pnpm seed --showcase`, with the fixture in `e2e/showcaseFixture.ts`.
  "Showcase" says what the data is for and collides with nothing: "help" reads as help on the seed,
  and "demo" already names `DEMO_MODE`, the magic-link sign-in.
- **No Baton screen reads Shopify live.** Every merchant and member screen reads stored rows: no
  product images, prices, product links or customers appear anywhere. So seeded orders are enough
  for every Baton picture, and they are the right default: they reach any state, the same every
  time.
- **Products are real anyway.** A merchant reading "put this tag on the products" goes to
  Shopify's product page; the picture there, the order's item titles and the workflow's tag should
  agree. A script writes eight products into the dev store with names, variants, SKUs and the
  workflow tags, through the Shopify CLI's own store auth, so Baton's access scopes do not grow.
- **Three real orders, created after the seed.** Open in Baton on Shopify's order page, Sync from
  Shopify, and the first-order walk need an order Shopify knows. They are created through the Admin
  API on the showcase products and reach Baton by the ordinary webhooks. Created after the seed,
  because every seed deletes every run, synced orders' runs included.
- **Four small seed changes.** A per-run actor (today every Start and Done is recorded as
  `members[0]`), a run note, a placed date in the past, and believable member emails. Each is a field
  on the existing seed shapes. The Needs a team issue stays a scripted team delete, which is how the
  app makes it.
- **No limit changes.** The showcase needs 7 members against a cap of 12 (`ShopLimits.maxMembers`),
  about 40 open orders against 2,500, and 9 teams against 50. Home is deferred, so the included
  allowances (3 and 10 members, 20 and 30 orders), which only Home compares, do not show. Those must
  also equal the Partner Dashboard's $0.00 bands, so changing them in code alone would put the two
  out of step.

## What the pictures need

Inventory of the pictures, page by page, and what each needs from the data. Home, Installing and
Plans and billing are left out (Home is deferred); hubs and the three reference tables have no
pictures. About 45 pictures in all; a page has zero to three.

| page                         | pictures                                                                                                   | what the data must hold                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| How Baton works              | an order page item card at Step 2 of 3; the member's page for the same item                                | an open item partway through a three-step workflow                                            |
| Creating your first workflow | Create workflow modal filled; the editor with one step and the Team select; Turn on modal                  | at least one team; a workflow created by the script                                           |
| Creating a team and adding…  | a new team, "Nobody on this team yet"; Add members modal                                                   | at least 6 members not on the new team, so the modal's search appears (`SEARCH_FROM`)         |
| Following an order…          | member's list, Ready row; order page with every item done and "Fulfill in Shopify"                         | a real order whose items the script starts and finishes                                       |
| Reading the orders list      | the whole index; Issues selected; a team chosen                                                            | Not started, Making, Made and Issues all non-zero; one unpaid; more than 25 open orders       |
| Reading an order             | a multi-item order with SKU, properties, an order note; the Manage drawer                                  | one order with three items in different states                                                |
| Attaching or changing…       | an item with no matching tag and the Workflow select; Change workflow? modal; Cancel workflow modal        | an item whose product has no workflow tag; an item with recorded work                         |
| Fixing an issue              | Multiple workflows match card; Needs a team row; the block banner                                          | a product carrying two workflow tags; a team deleted after the seed; a blocked item           |
| Syncing from Shopify         | the index title bar with Sync open orders                                                                  | nothing beyond the index                                                                      |
| Creating a workflow          | the Create workflow modal                                                                                  | as above                                                                                      |
| Editing steps and tasks      | the editor on an active workflow with a draft, a task selected; Apply changes? modal; Draft badge          | an active workflow with a pending draft and a parallel step                                   |
| Matching items by product…   | the workflow page's Tag card; the multi-match card                                                         | as above                                                                                      |
| Turning a workflow on or off | the index with Active and Inactive rows and fault badges; Turn off modal; Needs a team banner              | one inactive workflow; one with a task on a team with no members; one with an unassigned task |
| Renaming, duplicating…       | More actions open; Duplicate modal                                                                         | any workflow                                                                                  |
| Creating a team              | teams index with a No members row; a team page with members                                                | a team with no members                                                                        |
| Adding a member              | Add member modal; a new member's page, "Not on a team yet"; Add to teams modal                             | a member created by the script                                                                |
| Removing and deleting        | a team page's Remove buttons; Delete team? modal; the Needs a team row that follows                        | the team the script deletes                                                                   |
| Signing in                   | none: one field and an email link; the page is prose (decided 2026-10-07)                                  | nothing                                                                                       |
| Finding your work            | the list's default (Started by you); the Team select; Show more                                            | the shot member on two teams; items they started, items others started, Ready and Blocked     |
| Recording your work          | a Ready task with Start, Done, instructions and properties; a started task with Done, Put back and an Undo | items on the shot member's teams in each state                                                |
| Blocking an item…            | Block modal; the block banner; the merchant's blocked card                                                 | a blocked item on the shot member's team                                                      |

Two findings from reading the routes, for the content phase:

- Delete on an active workflow is allowed, and stays so (decided 2026-10-07). The tree's earlier
  line, "only inactive workflows can be deleted", came from Shopify Flow, where turning a workflow
  off cancels its runs in progress, so Flow funnels a delete through Turn off. A Baton run is a copy
  and outlives its workflow, so a gate would guard nothing. The Delete workflow modal now reads
  "Items already on it keep going. This can't be undone." (`DELETE_WORKFLOW_BODY`), active or not.
- The member's list shows the workflow's name on an item's recipe line only when it differs from
  the item's title (`workflowNamesItem`). A showcase where every workflow is named for its product
  would never show a workflow's name to a member. One workflow at least is named for its work, not
  its product.

## The showcase shop

The same fictional business as the dev fixture, a made-to-order gift workshop, so a developer
moving between the two recognises it. Every name is one a merchant would type.

### Products (real, in the dev store)

| product                  | variants      | SKU stem | tags                          | why                                                       |
| ------------------------ | ------------- | -------- | ----------------------------- | --------------------------------------------------------- |
| Engraved cutting board   | Maple, Walnut | `CB`     | `engraved-cutting-board`      | three steps across three teams                            |
| Leather journal          | Tan, Black    | `LJ`     | `leather-journal`             | properties (initials) on the item                         |
| Signet ring              | Silver, Gold  | `SR`     | `signet-ring`                 | a step that goes back to a team it left                   |
| Embroidered baby blanket | Cream, Sage   | `BB`     | `embroidered-blanket`         | two steps                                                 |
| Wall clock               | Oak, Walnut   | `WC`     | `wall-clock`                  | a parallel step                                           |
| Photo frame              | 5×7, 8×10     | `PF`     | `photo-frame`                 | its workflow is inactive                                  |
| Journal and pen gift set | Tan, Black    | `GS`     | `leather-journal`, `gift-set` | two workflows match: the Multiple workflows match picture |
| Gift card                | $25, $50      | none     | none                          | no tag: the item with nothing to attach                   |

Created and updated by `productSet` with the handle as the identifier, so the script is safe to
run again and puts a product back the way the table says. The six leftovers are archived, not
deleted (question 4).

### Teams, members, workflows

| team         | members                                                              |
| ------------ | -------------------------------------------------------------------- |
| Woodshop     | ben, dana                                                            |
| Engraving    | ana, ben, carmen                                                     |
| Leather      | carmen, eli                                                          |
| Jewelry      | farah                                                                |
| Textiles     | dana                                                                 |
| Finishing    | ana, eli                                                             |
| Packing      | gus (deleted by the script after the seed, which makes Needs a team) |
| Weekend crew | nobody: the No members and Team has no members pictures              |

Members are `ana@example.com`, `ben@…`, `carmen@…`, `dana@…`, `eli@…`, `farah@…`, `gus@…`:
seven, a domain reserved for examples (RFC 2606), first names because the screens show the email
and nothing else. `ana` is the member every member picture is taken as: on two teams (Engraving,
Finishing), so the Team select appears.

| workflow              | tag                      | state    | steps and teams                                                                         |
| --------------------- | ------------------------ | -------- | --------------------------------------------------------------------------------------- |
| Cut, engrave and oil  | `engraved-cutting-board` | active   | Cut and sand (Woodshop) → Engrave (Engraving) → Oil and inspect (Finishing)             |
| Stamp and bind        | `leather-journal`        | active   | Cut cover (Leather) → Stamp initials (Engraving) → Bind (Leather) → Pack (Packing)      |
| Cast, engrave, polish | `signet-ring`            | active   | Cast (Jewelry) → Engrave crest (Engraving) → Polish (Jewelry)                           |
| Embroider and fold    | `embroidered-blanket`    | active   | Embroider name (Textiles) → Fold and wrap (Finishing); a pending draft adds a step      |
| Clock assembly        | `wall-clock`             | active   | Cut face (Woodshop) and Engrave numerals (Engraving) in parallel → Assemble (Finishing) |
| Frame and glaze       | `photo-frame`            | inactive | Cut mat (Woodshop) → Glaze and fit (Finishing)                                          |
| Gift set assembly     | `gift-set`               | active   | Assemble set (Finishing)                                                                |
| Weekend engraving     | `weekend-engraving`      | active   | Engrave (Weekend crew): the Team has no members fault                                   |

Every task has instructions of one or two sentences. `Cast, engrave, polish` is the workflow named
for its work, so a member sees a workflow's name. `Stamp and bind`'s last step is on Packing, so
deleting Packing turns every journal past Bind into a Needs a team issue.

### Orders

About 40 seeded open orders, `#1201` upward, and a handful closed:

| kind                      | count | what it shows                                                       |
| ------------------------- | ----- | ------------------------------------------------------------------- |
| not started               | 8     | Ready rows for each team                                            |
| making, started by ana    | 5     | Started by you                                                      |
| making, started by others | 8     | Started by others; Step k of n across workflows                     |
| making, between steps     | 6     | an item done at one step and ready at the next                      |
| blocked                   | 2     | one by ana's team with a reason; one the merchant blocked           |
| made                      | 4     | Made, "Fulfill in Shopify", Done by … in the last day               |
| multi-match               | 1     | the gift set                                                        |
| unmatched                 | 2     | a gift card alone; a gift card beside a board                       |
| unpaid                    | 1     | the Unpaid badge                                                    |
| multi-item with note      | 1     | three items, SKU, initials as properties, an order note, a run note |
| closed                    | 4     | fulfilled, cancelled, an item removed, a resized item (`after`)     |

Over 25 open orders, so the index pages; over 25 rows for ana only when no team is chosen, so the
Show more picture uses the default list and the tidy pictures choose a team. Placed dates spread
over the last ten days, newest first, so the index reads like a working week.

Real orders, created by the script after the seed: three, on the showcase products, numbered by
Shopify from `#1002`. The seeded names start at `#1201` so the two ranges never meet (two rows
named `#1001` would both answer a search for it).

## Mechanics

### The seed changes

Each is a field on an existing shape, local-only like the rest of the seed:

| change          | where                                                          | why                                                                                    |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `by`            | `SeedProgress`: the member email that started or did it        | today `members[0]` does everything, so no list shows Started by others for that member |
| `note`          | `SeedProgress`: the run note                                   | `Run.note` has no seed key; only `setRunNote` writes it                                |
| `placedDaysAgo` | the order: `processedAt` set that far back                     | every order is placed "now", so every Placed date is today                             |
| fixture choice  | `scripts/seed.ts`: `--showcase` picks `e2e/showcaseFixture.ts` | the dev fixture stays the default                                                      |

`by` resolves through the route's existing email-to-member map, and the object builds the actor
per run instead of once. `RunTask` stores the email, not a member id, so nothing else changes.

### The store script

`scripts/showcase-store.ts` (`pnpm showcase:store`), once per dev store and safe to repeat:

1. `productSet` each product in the table above, by handle.
2. Archive the products the table does not name.
3. Ensure three open real orders on the showcase products exist (`orderCreate`, marked as test
   orders, no customer), and create any that are missing.

It runs through `shopify store execute` against `SHOPIFY_DEV_STORE`, on the CLI's own store auth
(`shopify store auth --scopes read_products,write_products,read_orders,write_orders`). That is
Shopify's CLI app, not Baton's, so Baton keeps `read_orders,read_products`. The token is an online
one and lapses; the script says to rerun `shopify store auth` when it does. One browser approval per
store, taken 2026-10-07 for `sandbox-shop-00`.

The e2e suite's one real-order test ("orders screen syncs open orders and lists them") needs at
least one open real order; the three showcase orders keep that true once #1001 is closed.

### The order of a screenshot pass

The screenshot script (`scripts/help-screenshots.ts`, in the content plan) owns the sequence,
because some pictures change the state others need:

1. `pnpm showcase:store` (no-op when the store already matches).
2. `pnpm seed --showcase`. This deletes every run, so it comes before anything is done to the real
   orders.
3. Sync the real orders (Sync open orders), so their runs exist.
4. Pictures that need no state change.
5. Pictures that make state, in order: Create workflow and its editor; Create team ("Nobody on
   this team yet"); Add member ("Not on a team yet"); the Delete team? modal on Packing, then the
   delete, then the Needs a team pictures; the first-order walk on a real order.
6. Member pictures, signed in as ana.
7. `pnpm seed`, so the store is back to the dev fixture.

An e2e run replaces the shop's data, so it and a screenshot pass never overlap; the store is one per
worktree.

### Signing in

No pictures (decided 2026-10-07). The sign-in page is one email field and a button, and what a
member needs to know (no password, the link comes by email, Your stores, the lapsed sentence) is
prose. So the screenshot pass never needs `DEMO_MODE` off, and the member pictures sign in through
the demo-mode link as `e2e/member.ts` does.

## Capture

Tested 2026-10-07 against the running dev server, headless Chrome, 1280 × 800 at 2x, the e2e admin
storage state:

- The page's heading, its primary action (**Create workflow**) and its More actions menu are drawn
  by the admin in its title bar, outside the app frame. A shot of the frame's `s-page` alone has no
  heading and none of the buttons a step names. `s-page` also has no box of its own, so it cannot
  be captured as an element at all.
- The title bar (`x 220, y 4, 1056 × 54`) sits directly above the frame (`x 220, y 58`). A window
  clip of `x 220, y 4` to the frame's bottom is one picture of Baton's page as the merchant sees
  it, with no admin sidebar and no search bar.
- The frame is as tall as the window, and the page scrolls inside it. A page taller than the
  window is shot by growing the window to the frame's top plus the frame body's `scrollHeight`.
- Three admin overlays land inside that clip: the Dev Console (closed through its button, as
  `closeDevConsole` in `e2e/app.ts` does), the dev mini console, and the Sidekick composer. The last
  two have no close the script can rely on and are hidden by a style rule on the admin document,
  matched by their class stems. Those stems are Shopify's to change, so the script checks before
  each shot that nothing fixed-position overlaps the clip, and fails rather than writes a stale
  picture.
- A modal's panel is drawn inside the app frame while the admin dims itself around it. A modal shot
  is a window clip to the panel's rectangle.
- The workflow editor is an `s-app-window`, a full-window frame of its own (`chrome=window`); it is
  shot as the whole window.

## Decisions

Reviewed 2026-10-07 in Plannotator. Every recommendation was accepted.

1. **The fixture is `showcase`**: `pnpm seed --showcase`, `e2e/showcaseFixture.ts`.
2. **Real products, written by script**: `scripts/showcase-store.ts` through the CLI's store auth.
3. **Three seed fields**: `by`, `note` and `placedDaysAgo`.
4. **Archive the six leftover products and close #1001.**
5. **Demo mode stays on.** Settled further on review: Signing in has no pictures, so nothing needs
   demo mode off.
6. **Members are shown by email**, as the app shows them.
7. **Delete on an active workflow stays allowed**; the modal says items already on it keep going.
   Done in 8c2a6d7.
8. **No limit changes.**

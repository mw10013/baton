# Plan: the showcase shop

Implements `docs/showcase-shop-research.md` (its Decisions section). Four phases: three seed
fields, the showcase fixture and its seed option, the store script, and a look at the result. The
screenshot script, the screenshot and steps parts, and the help content are the content plan, not
this one.

## Before you start

- Read `docs/showcase-shop-research.md` whole: "The showcase shop" is the data, "Mechanics" is the
  shape of the code. Read `AGENTS.md` for the repo's rules (JSDoc carries reasoning, a rule has a
  test whose title is the rule, `pnpm fmt` repo-wide, no layout outside `src/components/screen/`).
- The seed path: `scripts/seed.ts` → `scripts/lib/seed.ts` → `src/routes/api.dev.seed.ts` →
  `ShopAgent.seedWorkflows` / `seedOrders` → `seedWorkflows` / `seedOrders` in
  `src/lib/agent/ShopWork.ts`. The shapes: `Domain.SeedWorkflowsInput`, `Domain.SeedProgress`,
  `Domain.SeedOrderChange`, `Domain.SeedOrdersInput` in `src/lib/domain/ShopWork.ts`; the fixture
  types in `e2e/seed.ts`; the dev fixture `e2e/fixture.ts`.
- The dev server is running for this checkout (`pnpm dev:status`). The Shopify CLI is authorized
  against `sandbox-shop-00` for `shopify store execute` with `read_products, write_products,
read_orders, write_orders, read_draft_orders, write_draft_orders`; if a call says the auth is
  missing or expired, stop and report it, do not try to authorize.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` at the end of every phase. Do not run the e2e
  suite: it replaces the dev store's data. Do not commit.

## Phase 1: three seed fields

1. **`by`** on `SeedProgress`: the email of the member who started, did or blocked the work, in
   place of the seed member (`members[0]`). `byMerchant` still wins for Done and Block, as it does
   now. The route resolves the email through its existing email-to-member map and answers 400 for
   an email it did not seed, like the team and workflow references beside it. In the object,
   `seedOrders` builds the actor per run from it instead of the one `memberActor` constant;
   `RunTask` stores the email, so nothing downstream changes. The member does not have to be on the
   task's team (the seed's actor already passes `teamIds: [task.teamId]`); say so in the JSDoc.
2. **`note`** on `SeedProgress`: the run note, written through `RunRepository.setRunNote` after the
   progress, as the member (or the merchant under `byMerchant`).
3. **`placedDaysAgo`** on the seeded order: `processedAt` is that many days before now (plus the
   existing index offset, so order stays stable). Default 0, today's behaviour. Bound it below
   `ShopLimits`' retention age so a fixture cannot seed an order the next sweep deletes; the
   refusal is the schema's.
4. Tests, in `test/integration/` beside the existing seed tests, one per field, each titled with
   its rule ("a seeded run records its `by` member as the starter", and so on).

The dev fixture does not change in this phase.

## Phase 2: the showcase fixture and `--showcase`

1. `e2e/showcaseFixture.ts`: the tables in "The showcase shop" exactly (teams, members, workflows
   with instructions, about 40 open orders and the closed ones). Its header JSDoc says what it is
   for (the help's pictures; every name one a merchant would type), that the dev fixture stays the
   default and why (the kit page, the visual review and JSDoc examples lean on its names), and that
   its products exist in the dev store through `pnpm showcase:store`. Item titles, variants, SKUs
   and tags match the store script's product table, so share that table: one module both import.
   Seeded order numbers start at `#1201`.
2. `scripts/seed.ts` takes `--showcase`; `scripts/lib/seed.ts` takes the fixture to post. No flag
   is the dev fixture, as today. The summary line names the fixture.
3. The `pnpm seed` row in `AGENTS.md`'s commands block gains `(--showcase for the help's showcase
shop)`.

## Phase 3: the store script

`scripts/showcase-store.ts`, run as `pnpm showcase:store`, against `SHOPIFY_DEV_STORE` from `.env`,
through `shopify store execute` (pass `--allow-mutations` for writes, `--json` for output). Safe to
run again; each step reads before it writes and says what it changed.

1. `productSet` each product in the shared table, identified by handle: title, status active,
   tags, the variant option and its values, a SKU per variant (`<stem>-<VALUE>`, e.g. `CB-MAPLE`),
   a price. No images.
2. Archive every product the table does not name (`productUpdate`, status archived). Do not
   delete.
3. Close order #1001 if it is open (cancel it, no refund, no restock, no customer notice).
4. Ensure three open real orders on showcase products exist, created by `orderCreate` as test
   orders with no customer and no notification: one cutting board; one leather journal with an
   initials property; one wall clock and one blanket. Recognise the script's own orders by an
   order tag (`showcase`) and create only what is missing.
5. Print a summary: products written, archived, orders created or found.

Validate every GraphQL string with `pnpm graphql-codegen` if the script uses `#graphql` template
literals; otherwise validate each operation once through the Shopify dev MCP's `validate` tool.

## Phase 4: run it and look

1. `pnpm showcase:store`, then `pnpm seed --showcase`, then press Sync open orders on the orders
   index (or call the object's sync the way the orders e2e does) so the three real orders get runs.
2. Look at the result through the admin at 1280 × 800 and as `ana@example.com` at 390 × 844,
   headless, with `pnpm playwright-cli`: the orders index (all strip counts non-zero, more than one
   page), the workflows index (Active, Inactive, Team has no members), one multi-item order page,
   the Multiple workflows match card, ana's workflows list (Started by you, Started by others,
   Ready, Blocked, the Team select). Save the screenshots in the scratchpad, not the repo.
3. `pnpm seed` to put the dev fixture back.
4. Report: what each screen shows, anything in the research's tables that did not appear, and any
   name that reads wrong.

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass after each phase.
- `pnpm seed` with no flag posts the dev fixture, unchanged.
- `pnpm showcase:store` run twice changes nothing the second time.

## Deviations and issues

- **Run `note` on an item's `progress` only.** The order already has a `note` (the order note), and
  `SeedProgress`'s keys are spread onto the order, so a `note` there would have been written to
  every run as well. `SeedProgress` (an item's own) carries `note`; the order-level keys
  (`SeedProgressFields`) carry `by` but not `note`. `placedDaysAgo` is exported as
  `SeedPlacedDaysAgo` so the route's schema shares it.
- **`by` records one member for all of an item's Dones and its Start.** A seeded item "started by
  ben" shows its earlier steps done by ben too, on whatever team he is on. Stated in the fixture's
  header.
- **Real orders go through `draftOrderCreate` and `draftOrderComplete`, not `orderCreate`.**
  `orderCreate` answers ACCESS_DENIED: it needs an offline token and the CLI's store auth is an
  online one. The three orders are therefore real orders, not test orders (`test: false`), paid, with
  no customer and no notice, tagged `showcase` and one of `showcase-board`, `showcase-journal`,
  `showcase-clock-and-blanket`. The line properties are the draft lines' custom attributes.
- **The store's order list lags a completed draft order by more than ten seconds**, so the first
  run's immediate rerun created the three again (#1005 to #1007). The script now waits, after
  creating, until the list shows the orders. Resolved on review 2026-10-07: #1005 to #1007 were
  cancelled (no refund, no restock, no notice); the script counts only open tagged orders, and a
  rerun reports products written 0, archived 0, orders created 0, found 3.
- **The GraphQL strings are plain template literals in `scripts/`**, outside the codegen's
  `./src/**` documents, and were validated by running them against the store (the schema rejects an
  invalid operation before it executes), not through the Shopify dev MCP's `validate` tool.
- **`scripts/lib/showcase-store.test.ts`** is a `node --test` file for the pure parts (a product
  matches the table, the `productSet` input, which orders are missing). `pnpm test` does not run
  scripts' tests; run `node --test scripts/lib/showcase-store.test.ts`.
- **Phase 4: the Show more picture has no list to use.** The member's list pages at 25 rows
  (`RUN_PAGE`), and ana's longest state is Done or closed with 17, then Ready with 11, so Show more
  never appears. The research's table expects more than 25 rows on the default list.
- **Phase 4: the order page's "isn't in Baton" line says 30 days.** Checked on review: the number is
  `ORDER_SYNC_WINDOW_DAYS`, how far back Sync open orders reads, not retention, so the line is right.
- **Review fix:** the store script's `Effect.forEach` over a draft's lines tripped
  `unicorn(no-array-method-this-argument)` (a two-argument `forEach` reads as an array method with
  a `thisArg`); it is `Effect.all` over a `map` now, and lint is clean.

## Status

Implemented 2026-10-07 by a Sonnet agent and reviewed; uncommitted. All four phases done.

- `pnpm typecheck`, `pnpm lint` (no warnings) and `pnpm test` (37 files, 767 tests) pass;
  `node --test scripts/lib/showcase-store.test.ts` passes (4). The e2e suite was not run.
- The dev store `sandbox-shop-00` holds the eight showcase products, the six leftovers archived,
  #1001 and the duplicates #1005 to #1007 cancelled, and three open real orders #1002 to #1004
  tagged `showcase`. `pnpm showcase:store` is a no-op on it.
- `pnpm seed --showcase` seeds 7 members, 8 teams, 8 workflows and 42 orders from #1201; the shop
  is back on the dev fixture (`pnpm seed`). Phase 4's screenshots, for reference only, are in the
  session scratchpad, not the repo.

Open for the next session:

1. **Show more has no list.** ana's longest state is 17 rows against a page of 25. Either add about
   ten Ready orders on Engraving and Finishing to the fixture, or let Finding your work describe
   Show more in prose. Recommend prose: a picture of a button at the end of a list adds nothing,
   and 10 more orders thicken every other picture.
2. **"Making" before anyone starts.** By `orderPosition`, an order with any open run reads Making,
   so an order whose items have workflows but no started task is Making, and Not started means only
   "no workflow on any item". The showcase shows Not started 4, Making 39. The research's order
   table counted 8 "not started" by the task meaning. This is the app's rule, not the seed's; the
   help's Reading the orders list page has to say it exactly, or the rule is worth a look first.
3. **A `by` member's id.** The seed records a `by` member's email under the seed member's id
   (`memberActorOf` in `seedOrders`). Only the email is stored (`RunTask` has no member id), so
   nothing reads wrong; resolving the real id is a small change if it ever matters.
4. **Next in the help work:** the screenshot script (`scripts/help-screenshots.ts`), the screenshot
   and steps parts with their rows and kit entries, then the help hub and the For members pages.

## Review (2026-10-07, second pass)

Read the commit (1064e13) against the research and this plan. `pnpm typecheck`, `pnpm lint` and
`node --test scripts/lib/showcase-store.test.ts` pass. The seven GraphQL operations were run through
the Shopify dev MCP's `validate` (Admin, 2026-10): all valid.

What holds: the three seed fields are as the plan says, each has a test titled with its rule, the
route refuses an unseeded `by` with 400 like its team and workflow references (none of the three
refusals has a test), `placedDaysAgo` is bounded by `ShopLimits.orderRetentionDays` in the schema,
and `pnpm seed` with no flag posts the dev fixture unchanged. The fixture matches the research's
tables: 8 teams, 7 members, 8 workflows with instructions, 38 open orders in the research's kinds
and counts, 4 closed, numbered from #1201, placed over ten days. Items share the product table with
the store script. The store script reads before it writes and refuses a store with over 100
products or orders rather than paging.

### Fixes that need no decision

1. **The auth hint names the wrong scopes.** `authHint` in `scripts/lib/showcase-store.ts` says
   `read_products,write_products,read_orders,write_orders`; the script now also needs
   `read_draft_orders,write_draft_orders`. Add them.
2. **`draftOrderComplete(paymentPending: false)` is deprecated.** `false` is the default; drop the
   argument.
3. **The research's store-script section still says `orderCreate` and test orders.** Leave the
   research as written; the Deviations section above records the change.

### Findings

- **`by` shows a member doing another team's step, on screen.** `RunSteps` prints each done task as
  `<team> · <email> · <time>`, so the board "started by ana" at Engrave reads
  "Woodshop · ana@example.com" on its Cut and sand step, and ana is not on Woodshop. The made board
  `by: ELI` reads "Woodshop · eli@example.com". The How Baton works picture (an item at Step 2 of 3)
  is exactly this card. See decision 1.
- **Show more cannot appear** (open item 1 above). Checked: the default list is Started by you, six
  rows for ana; the research's line "over 25 rows for ana only when no team is chosen" was wrong
  about which list is the default. See decision 2.
- **Not started means "no workflow on any item"** (open item 2 above). Checked: `orderPosition`
  returns `not_started` only when the order has no open run and no done run, and a paid order with a
  matching workflow gets runs at once. So an order nobody has touched reads Making, and the Not
  started count is the gift cards, the multi-match and similar. See decision 3.
- **The store holds four cancelled orders**: #1001 (decision 4) and the duplicates #1005 to #1007.
  The seed deletes only seeded orders (`deleteSeedOrders`), and Baton turned out to hold all four
  as open orders (see Done, below). See decision 4.
- **Real orders, not test orders.** Forced: `orderCreate` refused the CLI's online token. On a dev
  store nothing is charged, and no Baton screen reads the test flag. See decision 5.
- **`scripts/lib/showcase-store.test.ts` runs outside `pnpm test`**: the first `node --test` file in
  the repo. See decision 6.

### Decisions

Reviewed 2026-10-07 in Plannotator.

1. **A seeded Done goes to a member of the task's team.** `by` when `by` is on the task's team, else
   the team's first seeded member, else `by`; Start and Block stay `by`. The route sends the seeded
   members with their ids and teams (`SeedOrdersInput.members`), so the real member id is stored
   too (open item 3). Without a `by`, the seed member does everything, as before, so the dev
   fixture is unchanged.
2. **Show more is prose** in Finding your work; no picture, no extra orders.
3. **Not started is its own topic**, parked in `docs/order-not-started-research.md` with the
   context and five open questions. It also found that the order page already uses "Not started"
   for an untouched run (`RUN_UNSTARTED_LABEL`), so a Making order can show every item Not started.
4. **Delete #1005 to #1007** from the dev store.
5. **Real orders accepted.**
6. **Cut `scripts/lib/showcase-store.test.ts`** and un-export what only it used.

### Done (2026-10-07)

- Fixes 1 and 2 above: the auth hint names the draft-order scopes; `paymentPending` is gone.
- Decision 1: `Domain.SeedOrdersInput.members`, the rule on `SeedProgress.by`, `memberActorOf` in
  `seedOrders`, the route's `memberTeamIds`; test "a seeded Done on a team `by` is not on is
  recorded as that team's first member". The fixture header's caveat is gone. Checked on
  `pnpm seed --showcase`: every Done and Start in the shop is by a member of that task's team.
- Decision 3: `docs/order-not-started-research.md`.
- Baton's side of decision 4: Baton held #1001 and #1005 to #1007 as **open** orders. Sync open
  orders read them while they were open, the cancellations never arrived (the worker log has no
  `/webhooks/orders` request), and Sync reads only open orders, so nothing closed them.
  `pnpm dev:reset` cleared them; the shop is back on the dev fixture. The next Sync brings only
  #1002 to #1004.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (37 files, 768 tests) pass.

### Store cleanup

Decision 4 done by the user on 2026-10-07: #1005 to #1007 are deleted. The store holds #1001
(cancelled) and the three open showcase orders, #1002 to #1004. Decision 6 is done: the test file
is removed and the five helpers only it used are no longer exported.

### Found on the way

- **A cancellation webhook that never arrives leaves the order open in Baton forever.** Sync open
  orders reads open orders only, so it cannot close an order it stored earlier. In production the
  webhook is the path and Shopify retries it; locally it did not arrive. Not this plan's; worth a
  line in the sync research if it recurs.
